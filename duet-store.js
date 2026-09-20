'use strict';

/**
 * Duet store — two addressable participants sharing ONE conversation.
 *
 * A duet does not get its own log. It rides on the packet store: a thread is the
 * canonical conversation, a packet is a message, and the columns added here say who
 * wrote each one and who it was aimed at. Two panes in the UI are filtered *views* over
 * that single log, never two histories that have to be kept in step.
 *
 * Schema lives here rather than in db.js on purpose. db.js owns the packet board and the
 * audit trail, and that is shipped, working, tested code. These columns are additive and
 * idempotent, so a database that has never seen a duet opens exactly as before and one
 * that has still reads correctly through every db.js query.
 *
 * Identity is three separate things, and the separation is load-bearing here:
 *
 *   participant — "Lyra", a name you talk to.            (participants.id)
 *   model       — "qwen2.5:7b" or a Nemotron id.         (participants.model)
 *   tier        — which side of the boundary that is.    (derived, never stored here)
 *
 * Tier is deliberately NOT a column. `public/app.js` already carries the rule that the
 * client does not get to assert which side of the boundary produced something, and a
 * participant is no different: the tier of a duet turn is resolved from the model id by
 * providers.tierOf() at the moment it is written. Both panes may run the same model and
 * still be different participants; one pane may be local while the other is across the
 * boundary, which is the arrangement this whole feature is most interesting for.
 */

const store = require('./db');

const db = store.db;
const now = () => new Date().toISOString();

/**
 * What the human is called in transcripts handed to a model.
 *
 * Neutral on purpose. A duet context crosses the boundary the moment either participant
 * is remote, and the README's rule for the system prompt applies with equal force to the
 * transcript labels wrapped around every line: name no person and no machine.
 */
const USER_NAME = 'User';

/** Generation lifecycle. Only `complete` messages are ever fed back to a model. */
const STATUS = {
    COMPLETE: 'complete',
    STREAMING: 'streaming',
    CANCELLED: 'cancelled',
    FAILED: 'failed',
    INTERRUPTED: 'interrupted',  // server died mid-stream; same exclusion as failed
    BLOCKED: 'blocked'           // the local gate refused to let this context cross
};

const TERMINAL = new Set([
    STATUS.COMPLETE, STATUS.CANCELLED, STATUS.FAILED, STATUS.INTERRUPTED, STATUS.BLOCKED
]);

// ─────────────────────────── schema ───────────────────────────

db.exec(`
CREATE TABLE IF NOT EXISTS participants (
    id            INTEGER PRIMARY KEY,
    thread_id     INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    slot          TEXT    NOT NULL,          -- 'a' (left pane) | 'b' (right pane)
    name          TEXT    NOT NULL,
    model         TEXT,                      -- tier is resolved from this, never stored
    instructions  TEXT,                      -- optional role instructions, trusted
    created_at    TEXT    NOT NULL,
    UNIQUE (thread_id, slot)
);

CREATE INDEX IF NOT EXISTS idx_participants_thread ON participants(thread_id);
`);

// Additive columns on packets. CREATE TABLE IF NOT EXISTS never adds columns, so each one
// is checked and added explicitly — the same shape as db.js's own workspace_root and tier
// migrations, and equally safe to run against a database that already has them.
const PACKET_COLUMNS = {
    // Who wrote it. NULL = the human, or a pre-duet packet (see `kind` in readMessage).
    author_participant_id: 'INTEGER REFERENCES participants(id) ON DELETE SET NULL',
    // Who it was aimed at. NULL on a reply — those are addressed back to the user.
    recipient_participant_id: 'INTEGER REFERENCES participants(id) ON DELETE SET NULL',
    // Generation lifecycle. Defaults to 'complete' so every existing packet — all of
    // which are finished by definition — is immediately eligible for model context.
    status: "TEXT NOT NULL DEFAULT 'complete'",
    // Server-assigned ordering within the thread. `position` is a *nesting* slot and
    // restarts under each parent, so it cannot answer "what came before this".
    seq: 'INTEGER',
    // The user message a reply was generated for. Makes retries identifiable.
    reply_to_packet_id: 'INTEGER REFERENCES packets(id) ON DELETE SET NULL',
    // Client-generated submission id. Unique per thread — the duplicate-submit guard.
    client_request_id: 'TEXT',
    generation_id: 'TEXT',
    // JSON: model, tier, snapshot seq, context size, budget, the packet ids the context
    // was built from, and the gate ruling if one was needed. Enough to answer, after the
    // fact, exactly what a given reply was shown and what of it left the machine.
    request_meta: 'TEXT'
};

const existingColumns = new Set(db.prepare('PRAGMA table_info(packets)').all().map(c => c.name));
for (const [column, type] of Object.entries(PACKET_COLUMNS)) {
    if (!existingColumns.has(column)) db.exec(`ALTER TABLE packets ADD COLUMN ${column} ${type}`);
}

db.exec(`
CREATE INDEX IF NOT EXISTS idx_packets_seq    ON packets(thread_id, seq);
CREATE INDEX IF NOT EXISTS idx_packets_author ON packets(author_participant_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_packets_client_request
    ON packets(thread_id, client_request_id) WHERE client_request_id IS NOT NULL;
`);

// Every packet gets a thread-local sequence number, including ones inserted by the
// classic chat path and by fork/move in db.js. A trigger rather than a call site, so
// there is exactly one place that can get it wrong and no db.js edit to regress.
db.exec(`
CREATE TRIGGER IF NOT EXISTS packets_assign_seq
AFTER INSERT ON packets
WHEN NEW.seq IS NULL
BEGIN
    UPDATE packets
       SET seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM packets WHERE thread_id = NEW.thread_id)
     WHERE id = NEW.id;
END;
`);

// Backfill for packets written before the trigger existed. `id` is globally monotonic, so
// ordering by it reproduces the true insert order; the trigger then continues from
// whatever high-water mark each thread ends up with.
if (!store.getMeta('duet_seq_backfilled')) {
    db.exec('UPDATE packets SET seq = id WHERE seq IS NULL');
    store.setMeta('duet_seq_backfilled', now());
}

// Retire the old personas. Guarded, and only touches participants still carrying a
// default name — there is no custom-naming UI any more, but a name somebody deliberately
// set is still theirs and is left alone.
if (!store.getMeta('duet_sides_not_personas')) {
    const rename = db.prepare('UPDATE participants SET name = ? WHERE slot = ? AND name = ?');
    rename.run('Left', 'a', 'Lyra');
    rename.run('Right', 'b', 'Ember');
    store.setMeta('duet_sides_not_personas', now());
}

/**
 * A process that dies mid-generation leaves a packet stuck in `streaming`, which would
 * otherwise be neither shown as finished nor excluded from context. Settle them at boot.
 */
function resetStaleGenerations() {
    return db.prepare('UPDATE packets SET status = ? WHERE status = ?')
        .run(STATUS.INTERRUPTED, STATUS.STREAMING).changes;
}

// ─────────────────────────── participants ───────────────────────────

const SLOTS = ['a', 'b'];

/**
 * A participant is a SIDE, not a persona.
 *
 * These used to be "Lyra" and "Ember", which read nicely and told you nothing: the thing
 * you actually need to know about a participant is which model is behind it and which
 * side of the boundary that model sits on. An invented name hid both behind a character.
 *
 * So the name is the position, and identity — in the header, in every message label, and
 * in the transcript the models themselves read — is the model id.
 */
const DEFAULT_NAMES = { a: 'Left', b: 'Right' };

function getParticipants(threadId) {
    return db.prepare('SELECT * FROM participants WHERE thread_id = ? ORDER BY slot')
        .all(Number(threadId));
}

function getParticipant(id) {
    return db.prepare('SELECT * FROM participants WHERE id = ?').get(Number(id)) || null;
}

const isDuet = threadId => getParticipants(threadId).length > 0;

/**
 * Turn a thread into a duet, once. Idempotent: called on a thread that already has
 * participants it hands back the existing pair rather than a second one, so a
 * double-click on the toggle cannot fork a conversation's identity.
 */
function ensureDuet(threadId, { model = null, models = null } = {}) {
    const thread = store.getThread(Number(threadId));
    if (!thread) throw new Error(`No thread ${threadId}`);

    const already = getParticipants(thread.id);
    if (already.length === SLOTS.length) return already;

    const insert = db.prepare(`
        INSERT INTO participants (thread_id, slot, name, model, instructions, created_at)
        VALUES (?, ?, ?, ?, NULL, ?)
    `);

    // Per slot, so a thread can open with one participant on this machine and one across
    // the boundary — which is the arrangement the whole desk is about. `model` stays
    // supported for callers that want both slots the same.
    for (const slot of SLOTS) {
        if (already.some(p => p.slot === slot)) continue;
        insert.run(thread.id, slot, DEFAULT_NAMES[slot], models?.[slot] ?? model, now());
    }
    return getParticipants(thread.id);
}

const PARTICIPANT_FIELDS = ['name', 'model', 'instructions'];

function updateParticipant(id, patch = {}) {
    const participant = getParticipant(id);
    if (!participant) throw new Error(`No participant ${id}`);

    const sets = [];
    const args = [];

    for (const field of PARTICIPANT_FIELDS) {
        if (patch[field] === undefined) continue;

        let value = patch[field];
        if (typeof value === 'string') value = value.trim();
        if (field === 'name' && !value) throw new Error('A participant needs a name.');
        if (field !== 'name' && value === '') value = null;

        sets.push(`${field} = ?`);
        args.push(value ?? null);
    }

    if (!sets.length) throw new Error('Nothing to change.');

    // Two participants may share a model — that is the point — but two identical names in
    // one conversation make the transcript labels ambiguous for the models reading them.
    if (patch.name !== undefined) {
        const wanted = String(patch.name).trim().toLowerCase();
        const clash = getParticipants(participant.thread_id)
            .some(p => p.id !== participant.id && p.name.toLowerCase() === wanted);
        if (clash) throw new Error('The other participant already has that name.');
    }

    args.push(participant.id);
    db.prepare(`UPDATE participants SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    return getParticipant(participant.id);
}

// ─────────────────────────── messages ───────────────────────────

/**
 * One row of the canonical log, shaped for both the API and the context builder.
 *
 * `kind` is the honest answer to "where did this come from", and `legacy` is a real
 * answer rather than a missing one: packets written before this feature existed have no
 * author, and quietly adopting them into one of today's participants would put words in
 * a model's mouth.
 */
function readMessage(row) {
    const kind = row.author_participant_id ? 'participant'
        : row.role === 'user' ? 'user'
            : 'legacy';

    return {
        id: row.id,
        threadId: row.thread_id,
        seq: row.seq ?? row.id,
        role: row.role,
        kind,
        content: row.content,
        status: row.status || STATUS.COMPLETE,
        tier: row.tier || 'local',
        authorId: row.author_participant_id ?? null,
        authorName: row.author_name ?? (kind === 'user' ? USER_NAME : null),
        authorSlot: row.author_slot ?? null,
        recipientId: row.recipient_participant_id ?? null,
        recipientName: row.recipient_name ?? null,
        recipientSlot: row.recipient_slot ?? null,
        replyTo: row.reply_to_packet_id ?? null,
        generationId: row.generation_id ?? null,
        clientRequestId: row.client_request_id ?? null,
        model: row.model ?? null,
        images: row.images ? JSON.parse(row.images) : [],
        requestMeta: row.request_meta ? JSON.parse(row.request_meta) : null,
        createdAt: row.created_at
    };
}

const JOINS = `
      FROM packets p
      LEFT JOIN participants ap ON ap.id = p.author_participant_id
      LEFT JOIN participants rp ON rp.id = p.recipient_participant_id
`;

const COLUMNS = `
    SELECT p.*,
           ap.name AS author_name, ap.slot AS author_slot,
           rp.name AS recipient_name, rp.slot AS recipient_slot
`;

/**
 * The shared conversation, in server-assigned order.
 *
 * @param {number|string} threadId
 * @param {object} opts
 * @param {number} [opts.maxSeq]  hard ceiling — this is what makes a context snapshot a
 *                                snapshot rather than "whatever is in the table now".
 * @param {boolean} [opts.completedOnly]  drop partial, cancelled, failed and blocked
 *                                        generations. Anything that is not a finished
 *                                        answer is not conversation.
 */
function getConversation(threadId, { maxSeq = null, completedOnly = false } = {}) {
    const where = ['p.thread_id = ?'];
    const args = [Number(threadId)];

    if (maxSeq != null) { where.push('COALESCE(p.seq, p.id) <= ?'); args.push(maxSeq); }
    if (completedOnly) { where.push('p.status = ?'); args.push(STATUS.COMPLETE); }

    return db.prepare(
        `${COLUMNS} ${JOINS} WHERE ${where.join(' AND ')} ORDER BY COALESCE(p.seq, p.id), p.id`
    ).all(...args).map(readMessage);
}

function getMessage(id) {
    const row = db.prepare(`${COLUMNS} ${JOINS} WHERE p.id = ?`).get(Number(id));
    return row ? readMessage(row) : null;
}

/** The duplicate-submit guard. A resent submission finds its own earlier packet here. */
function findByClientRequest(threadId, clientRequestId) {
    if (!clientRequestId) return null;
    const row = db.prepare(`${COLUMNS} ${JOINS} WHERE p.thread_id = ? AND p.client_request_id = ?`)
        .get(Number(threadId), String(clientRequestId));
    return row ? readMessage(row) : null;
}

/**
 * Append to the canonical log.
 *
 * Goes through db.js's createPacket so a duet message is a real packet — draggable,
 * forkable, searchable, present in the oversight brief and in the exposure query like any
 * other — and then stamps the duet columns onto it. One insert path, one provenance row,
 * no second kind of message.
 */
function appendMessage({
    threadId, role, content, model = null, images = null, tier = 'local',
    authorId = null, recipientId = null, status = STATUS.COMPLETE,
    replyTo = null, clientRequestId = null, generationId = null, requestMeta = null
}) {
    const packet = store.createPacket({
        threadId: Number(threadId), role, content, model, images, tier
    });

    db.prepare(`
        UPDATE packets
           SET author_participant_id = ?, recipient_participant_id = ?, status = ?,
               reply_to_packet_id = ?, client_request_id = ?, generation_id = ?, request_meta = ?
         WHERE id = ?
    `).run(
        authorId ?? null, recipientId ?? null, status,
        replyTo ?? null, clientRequestId ?? null, generationId ?? null,
        requestMeta ? JSON.stringify(requestMeta) : null,
        packet.id
    );

    return getMessage(packet.id);
}

/**
 * Settle a generation. Partial text from a stop or a failure is kept — it is worth
 * reading — but the status is what decides whether a model ever sees it again, and only
 * `complete` qualifies.
 */
function finishMessage(id, { content = null, status, requestMeta = null }) {
    if (!TERMINAL.has(status)) throw new Error(`Not a terminal status: ${status}`);

    const sets = ['status = ?'];
    const args = [status];

    if (content != null) { sets.push('content = ?'); args.push(content); }
    if (requestMeta) { sets.push('request_meta = ?'); args.push(JSON.stringify(requestMeta)); }

    args.push(Number(id));
    db.prepare(`UPDATE packets SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    return getMessage(id);
}

module.exports = {
    USER_NAME, STATUS, SLOTS, DEFAULT_NAMES,
    resetStaleGenerations,
    getParticipants, getParticipant, ensureDuet, updateParticipant, isDuet,
    getConversation, getMessage, findByClientRequest, appendMessage, finishMessage
};
