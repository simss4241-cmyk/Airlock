'use strict';

/**
 * Packet store.
 *
 * The shape everything else is a view over:
 *
 *   folder  ── a tray (PROJECTS, RESEARCH, whatever you name it)
 *     thread ── a project stream inside a tray (one per line of work)
 *       packet ── one unit of thought. Nests via parent_id, so a thread is a
 *                 container, not a flat log.
 *
 * Provenance is an append-only log, never a mutable field. "This thought started in
 * hardware and moved to code" is a query over `provenance`, not a column on the packet.
 * That's the whole reason this exists before any drag-and-drop animation.
 */

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.AIRLOCK_DB || path.join(__dirname, 'airlock.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const now = () => new Date().toISOString();

// Marker for the one-time copy of the old global workspace root onto existing threads.
// Lives in the database rather than the JSON config so a restored or hand-edited config
// can never re-run it — see migrateWorkspaceRoot.
const WORKSPACE_MIGRATED = 'workspace_root_migrated';
const TIER_BACKFILLED   = 'packet_tier_backfilled';

// ─────────────────────────── schema ───────────────────────────

db.exec(`
CREATE TABLE IF NOT EXISTS folders (
    id          INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL,
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
    id          INTEGER PRIMARY KEY,
    folder_id   INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    title       TEXT    NOT NULL,
    workspace_root TEXT,
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS packets (
    id                INTEGER PRIMARY KEY,
    thread_id         INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    parent_id         INTEGER REFERENCES packets(id) ON DELETE CASCADE,
    forked_from       INTEGER REFERENCES packets(id) ON DELETE SET NULL,
    origin_thread_id  INTEGER REFERENCES threads(id) ON DELETE SET NULL,
    role              TEXT    NOT NULL,
    content           TEXT    NOT NULL,
    model             TEXT,
    images            TEXT,
    position          INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS provenance (
    id              INTEGER PRIMARY KEY,
    packet_id       INTEGER NOT NULL REFERENCES packets(id) ON DELETE CASCADE,
    event           TEXT    NOT NULL,
    from_thread_id  INTEGER,
    to_thread_id    INTEGER,
    actor           TEXT,
    note            TEXT,
    created_at      TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_threads_folder    ON threads(folder_id);
CREATE INDEX IF NOT EXISTS idx_packets_thread    ON packets(thread_id);
CREATE INDEX IF NOT EXISTS idx_packets_parent    ON packets(parent_id);
CREATE INDEX IF NOT EXISTS idx_packets_created   ON packets(created_at);
CREATE INDEX IF NOT EXISTS idx_prov_packet       ON provenance(packet_id);
CREATE INDEX IF NOT EXISTS idx_prov_event        ON provenance(event);
`);

function getMeta(key) {
    return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}

function setMeta(key, value) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) '
        + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// Existing databases predate thread-scoped workspaces. SQLite's CREATE TABLE IF NOT
// EXISTS does not add new columns, so migrate that one column explicitly and idempotently.
//
// A database that already HAS the column either predates nothing (created after the change)
// or has already been through it, so the legacy global-root bridge is marked spent here.
// Only a database that needs the column added is still owed that one-time copy.
const threadColumns = db.prepare('PRAGMA table_info(threads)').all();
if (!threadColumns.some(column => column.name === 'workspace_root')) {
    db.exec('ALTER TABLE threads ADD COLUMN workspace_root TEXT');
} else if (!getMeta(WORKSPACE_MIGRATED)) {
    setMeta(WORKSPACE_MIGRATED, 'schema already thread-scoped');
}

// Which side of the boundary produced a packet. RECORDED, not derived: an audit
// trail has to say what was true at the time. Deriving the tier from the model id
// later would silently reclassify history the moment a model leaves the
// catalogue or a local tag starts colliding with a remote one.
const packetColumns = db.prepare('PRAGMA table_info(packets)').all();
if (!packetColumns.some(column => column.name === 'tier')) {
    db.exec("ALTER TABLE packets ADD COLUMN tier TEXT");
}

// Every packet written before this column existed predates the remote tier
// entirely, so 'local' is a fact about them rather than a guess. Runs once.
if (!getMeta(TIER_BACKFILLED)) {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM packets WHERE tier IS NULL").get();
    db.prepare("UPDATE packets SET tier = 'local' WHERE tier IS NULL").run();
    setMeta(TIER_BACKFILLED, `${n} packet(s) predating the remote tier`);
}

// ─────────────────────────── seed ───────────────────────────

// A fresh database gets one tray holding one thread, and nothing else.
//
// Trays and threads are the user's own vocabulary. Seeding a stranger's project
// names gives a new arrival nothing but a list to delete before they can start,
// and this seed ships in a public repository — so it has to make sense to
// someone who has never met the person who wrote it.
//
// One of each is deliberate: it shows the tray -> thread shape that the whole
// board depends on, without pretending to be content.
const SEED = [
    ['PROJECTS', ['First thread']]
];

function seed() {
    const { c } = db.prepare('SELECT COUNT(*) AS c FROM folders').get();
    if (c > 0) return;

    const insFolder = db.prepare('INSERT INTO folders (name, position, created_at) VALUES (?, ?, ?)');
    const insThread = db.prepare('INSERT INTO threads (folder_id, title, position, created_at) VALUES (?, ?, ?, ?)');

    SEED.forEach(([name, titles], fi) => {
        const folderId = insFolder.run(name, fi, now()).lastInsertRowid;
        titles.forEach((t, ti) => insThread.run(folderId, t, ti, now()));
    });
}

seed();

// ─────────────────────────── helpers ───────────────────────────

const log = db.prepare(`
    INSERT INTO provenance (packet_id, event, from_thread_id, to_thread_id, actor, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
`);

function record(packetId, event, { from = null, to = null, actor = null, note = null } = {}) {
    log.run(packetId, event, from, to, actor, note, now());
}

function nextPosition(threadId, parentId) {
    const row = parentId == null
        ? db.prepare('SELECT MAX(position) AS m FROM packets WHERE thread_id = ? AND parent_id IS NULL').get(threadId)
        : db.prepare('SELECT MAX(position) AS m FROM packets WHERE parent_id = ?').get(parentId);
    return (row?.m ?? -1) + 1;
}

const hydrate = p => p && ({
    ...p,
    images: p.images ? JSON.parse(p.images) : [],
    children: []
});

// ─────────────────────────── folders & threads ───────────────────────────

function getTree() {
    const folders = db.prepare('SELECT * FROM folders ORDER BY position, id').all();
    const threads = db.prepare(`
        SELECT t.*, (SELECT COUNT(*) FROM packets p WHERE p.thread_id = t.id) AS packet_count
        FROM threads t ORDER BY t.position, t.id
    `).all();

    return folders.map(f => ({
        ...f,
        threads: threads.filter(t => t.folder_id === f.id)
    }));
}

function createFolder(name) {
    const { m } = db.prepare('SELECT MAX(position) AS m FROM folders').get();
    const id = db.prepare('INSERT INTO folders (name, position, created_at) VALUES (?, ?, ?)')
        .run(name, (m ?? -1) + 1, now()).lastInsertRowid;
    return db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
}

function createThread(folderId, title) {
    const { m } = db.prepare('SELECT MAX(position) AS m FROM threads WHERE folder_id = ?').get(folderId);
    const id = db.prepare('INSERT INTO threads (folder_id, title, position, created_at) VALUES (?, ?, ?, ?)')
        .run(folderId, title, (m ?? -1) + 1, now()).lastInsertRowid;
    return db.prepare('SELECT * FROM threads WHERE id = ?').get(id);
}

function deleteThread(id) {
    db.prepare('DELETE FROM threads WHERE id = ?').run(id);
}

function deleteFolder(id) {
    db.prepare('DELETE FROM folders WHERE id = ?').run(id);
}

function renameThread(id, title) {
    if (!title || !title.trim()) throw new Error('A thread needs a title.');
    if (!getThread(id)) throw new Error(`No thread ${id}`);
    db.prepare('UPDATE threads SET title = ? WHERE id = ?').run(title.trim(), id);
    return getThread(id);
}

function setThreadWorkspace(id, root) {
    if (!getThread(id)) throw new Error(`No thread ${id}`);
    db.prepare('UPDATE threads SET workspace_root = ? WHERE id = ?').run(root || null, id);
    return getThread(id);
}

/**
 * One-time bridge from the old global workspace setting, leaving every thread that existed
 * at the time independently editable.
 *
 * Guarded by a marker in this database, and the guard is the point. Without it the bridge
 * stays armed forever: any stray global root — a restored config backup, a hand edit, a
 * copy from another machine — would silently grant file access to every thread that has
 * none, which is exactly the set the per-thread design deliberately leaves off. File
 * access is meant to be handed over on purpose, one thread at a time.
 */
function migrateWorkspaceRoot(root) {
    if (!root) return 0;
    if (getMeta(WORKSPACE_MIGRATED)) return 0;

    const changed = db.prepare('UPDATE threads SET workspace_root = ? WHERE workspace_root IS NULL')
        .run(root).changes;
    setMeta(WORKSPACE_MIGRATED, now());
    return changed;
}

/**
 * Place a tray at an explicit slot. Same renumber-everything approach as
 * reorderThread: positions come out a clean 0..n rather than drifting into ties.
 */
function reorderFolder(id, index) {
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
    if (!folder) throw new Error(`No tray ${id}`);

    const others = db.prepare('SELECT id FROM folders WHERE id <> ? ORDER BY position, id')
        .all(id).map(r => r.id);

    const at = index == null
        ? others.length
        : Math.max(0, Math.min(Math.trunc(Number(index) || 0), others.length));

    others.splice(at, 0, id);

    db.exec('BEGIN');
    try {
        const upd = db.prepare('UPDATE folders SET position = ? WHERE id = ?');
        others.forEach((fid, i) => upd.run(i, fid));
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }

    return db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
}

function renameFolder(id, name) {
    if (!name || !name.trim()) throw new Error('A tray needs a name.');
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
    if (!folder) throw new Error(`No tray ${id}`);
    db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(name.trim(), id);
    return db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
}

/**
 * Place a thread at an explicit slot, optionally in another tray.
 *
 * Renumbers the destination's siblings 0..n in one transaction rather than nudging a
 * single row, so positions can't drift into ties after a few hundred drags. `index` is
 * the slot among the *other* threads, so dropping something back where it already was
 * is a no-op rather than an off-by-one.
 */
function reorderThread(id, { folderId = null, index = null } = {}) {
    const thread = getThread(id);
    if (!thread) throw new Error(`No thread ${id}`);

    const target = folderId ?? thread.folder_id;
    if (!db.prepare('SELECT 1 FROM folders WHERE id = ?').get(target)) {
        throw new Error(`No tray ${target}`);
    }

    const siblings = db.prepare(
        'SELECT id FROM threads WHERE folder_id = ? AND id <> ? ORDER BY position, id'
    ).all(target, id).map(r => r.id);

    const at = index == null
        ? siblings.length
        : Math.max(0, Math.min(Math.trunc(Number(index) || 0), siblings.length));

    siblings.splice(at, 0, id);

    db.exec('BEGIN');
    try {
        const upd = db.prepare('UPDATE threads SET folder_id = ?, position = ? WHERE id = ?');
        siblings.forEach((tid, i) => upd.run(target, i, tid));
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }

    return getThread(id);
}

/**
 * Re-tray a thread. Packets keep their `origin_thread_id`, so a thought that started in
 * hardware still says so even after the whole thread is filed under code.
 */
function moveThreadToFolder(id, folderId) {
    if (!getThread(id)) throw new Error(`No thread ${id}`);
    if (!db.prepare('SELECT 1 FROM folders WHERE id = ?').get(folderId)) {
        throw new Error(`No tray ${folderId}`);
    }
    const { m } = db.prepare('SELECT MAX(position) AS m FROM threads WHERE folder_id = ?').get(folderId);
    db.prepare('UPDATE threads SET folder_id = ?, position = ? WHERE id = ?')
        .run(folderId, (m ?? -1) + 1, id);
    return getThread(id);
}

// ─────────────────────────── packets ───────────────────────────

function createPacket({ threadId, role, content, model = null, images = null, parentId = null, tier = 'local' }) {
    const id = db.prepare(`
        INSERT INTO packets (thread_id, parent_id, origin_thread_id, role, content, model, images, tier, position, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        threadId, parentId, threadId, role, content, model,
        images && images.length ? JSON.stringify(images) : null,
        tier,
        nextPosition(threadId, parentId), now()
    ).lastInsertRowid;

    record(id, 'created', { to: threadId, actor: role === 'assistant' ? model : 'you' });
    return getPacket(id);
}

function getPacket(id) {
    return hydrate(db.prepare('SELECT * FROM packets WHERE id = ?').get(id));
}

/**
 * Flat rows for a thread, assembled into a nesting tree. Carries the provenance
 * bits the UI needs to render a badge without a round-trip per packet: where the
 * packet was born, and who has signed off on it.
 */
function getThreadPackets(threadId) {
    const rows = db.prepare(`
        SELECT p.*,
               ot.title AS origin_thread_title,
               (SELECT GROUP_CONCAT(DISTINCT pr.actor) FROM provenance pr
                 WHERE pr.packet_id = p.id AND pr.event = 'reviewed') AS reviewers,
               (SELECT COUNT(*) FROM provenance pr
                 WHERE pr.packet_id = p.id AND pr.event IN ('moved','nested')) AS hops
        FROM packets p
        LEFT JOIN threads ot ON ot.id = p.origin_thread_id
        WHERE p.thread_id = ? ORDER BY p.position, p.id
    `).all(threadId).map(hydrate);

    const byId = new Map(rows.map(p => [p.id, p]));
    const roots = [];

    for (const p of rows) {
        if (p.parent_id != null && byId.has(p.parent_id)) {
            byId.get(p.parent_id).children.push(p);
        } else {
            roots.push(p);
        }
    }
    return roots;
}

/** Every descendant id, self included — used by move and fork. */
function subtreeIds(id) {
    const out = [];
    const walk = pid => {
        out.push(pid);
        for (const { id: kid } of db.prepare('SELECT id FROM packets WHERE parent_id = ?').all(pid)) {
            walk(kid);
        }
    };
    walk(id);
    return out;
}

/**
 * Drag = move. The packet physically leaves, and its whole subtree goes with it.
 * origin_thread_id is left untouched — that's where the thought was born.
 */
function movePacket(id, { toThreadId, parentId = null, actor = 'you' }) {
    const packet = getPacket(id);
    if (!packet) throw new Error(`No packet ${id}`);

    if (parentId != null) {
        if (parentId === id) throw new Error('A packet cannot nest inside itself.');
        if (subtreeIds(id).includes(parentId)) {
            throw new Error('A packet cannot nest inside its own descendant.');
        }
        const parent = getPacket(parentId);
        if (!parent) throw new Error(`No parent packet ${parentId}`);
        toThreadId = parent.thread_id;   // nesting always follows the parent's thread
    }

    const from = packet.thread_id;
    const ids = subtreeIds(id);

    const upd = db.prepare('UPDATE packets SET thread_id = ? WHERE id = ?');
    for (const pid of ids) upd.run(toThreadId, pid);

    db.prepare('UPDATE packets SET parent_id = ?, position = ? WHERE id = ?')
        .run(parentId, nextPosition(toThreadId, parentId), id);

    const event = parentId != null ? 'nested' : 'moved';
    record(id, event, { from, to: toThreadId, actor,
        note: ids.length > 1 ? `carried ${ids.length - 1} nested packet(s)` : null });

    return getPacket(id);
}

/**
 * Alt+drag = fork. Duplicates the packet and its subtree, and the copy keeps a
 * tether back to the original via forked_from.
 */
function forkPacket(id, { toThreadId = null, parentId = null, actor = 'you' } = {}) {
    const src = getPacket(id);
    if (!src) throw new Error(`No packet ${id}`);

    const target = toThreadId ?? src.thread_id;

    const copy = (srcId, newParentId, isRoot) => {
        const p = db.prepare('SELECT * FROM packets WHERE id = ?').get(srcId);
        const newId = db.prepare(`
            INSERT INTO packets
                (thread_id, parent_id, forked_from, origin_thread_id, role, content, model, images, position, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            target, newParentId, srcId, p.origin_thread_id, p.role, p.content, p.model, p.images,
            nextPosition(target, newParentId), now()
        ).lastInsertRowid;

        if (isRoot) {
            record(newId, 'forked', { from: p.thread_id, to: target, actor,
                note: `forked from packet ${srcId}` });
        }

        for (const { id: kid } of db.prepare('SELECT id FROM packets WHERE parent_id = ? ORDER BY position, id').all(srcId)) {
            copy(kid, newId, false);
        }
        return newId;
    };

    return getPacket(copy(id, parentId, true));
}

/** Escalation result — a signature on the packet, not a mutated field. */
function reviewPacket(id, { actor, note = null }) {
    if (!getPacket(id)) throw new Error(`No packet ${id}`);
    if (!actor) throw new Error('A review needs an actor.');
    record(id, 'reviewed', { actor, note });
    return getProvenance(id);
}

function getProvenance(id) {
    return db.prepare(`
        SELECT pr.*, ft.title AS from_thread, tt.title AS to_thread
        FROM provenance pr
        LEFT JOIN threads ft ON ft.id = pr.from_thread_id
        LEFT JOIN threads tt ON tt.id = pr.to_thread_id
        WHERE pr.packet_id = ?
        ORDER BY pr.id
    `).all(id);
}

/** Who has signed off on this packet, newest first. */
function getReviews(id) {
    return db.prepare(`
        SELECT actor, note, created_at FROM provenance
        WHERE packet_id = ? AND event = 'reviewed' ORDER BY id DESC
    `).all(id);
}

function deletePacket(id) {
    db.prepare('DELETE FROM packets WHERE id = ?').run(id);
}

/**
 * The query that justifies the whole schema:
 *   "everything in PBIS from April"  ->  { thread: 'PBIS', from: '2026-04-01', to: '2026-04-30' }
 */
function search({ folder = null, thread = null, from = null, to = null, q = null, role = null, limit = 200 } = {}) {
    const where = [];
    const args = [];

    if (folder) { where.push('f.name LIKE ?'); args.push(`%${folder}%`); }
    if (thread) { where.push('t.title LIKE ?'); args.push(`%${thread}%`); }
    if (from)   { where.push('p.created_at >= ?'); args.push(from); }
    // A bare date as the upper bound should mean "through the end of that day",
    // otherwise `to=2026-04-30` silently excludes everything logged on the 30th.
    if (to)     { where.push('p.created_at <= ?'); args.push(to.length === 10 ? `${to}T23:59:59.999Z` : to); }
    if (q)      { where.push('p.content LIKE ?'); args.push(`%${q}%`); }
    if (role)   { where.push('p.role = ?'); args.push(role); }

    args.push(Math.min(Number(limit) || 200, 1000));

    return db.prepare(`
        SELECT p.*, t.title AS thread_title, f.name AS folder_name,
               ot.title AS origin_thread_title
        FROM packets p
        JOIN threads t  ON t.id = p.thread_id
        JOIN folders f  ON f.id = t.folder_id
        LEFT JOIN threads ot ON ot.id = p.origin_thread_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT ?
    `).all(...args).map(hydrate);
}

/** Packets whose origin thread isn't their current one — the ghost-trail candidates. */
function getTravelled(limit = 100) {
    return db.prepare(`
        SELECT p.id, p.content, p.created_at,
               ot.title AS origin_thread, t.title AS current_thread,
               (SELECT COUNT(*) FROM provenance pr WHERE pr.packet_id = p.id AND pr.event IN ('moved','nested')) AS hops
        FROM packets p
        JOIN threads t ON t.id = p.thread_id
        LEFT JOIN threads ot ON ot.id = p.origin_thread_id
        WHERE p.origin_thread_id IS NOT NULL AND p.origin_thread_id <> p.thread_id
        ORDER BY p.id DESC LIMIT ?
    `).all(Math.min(Number(limit) || 100, 500));
}

function getThread(id) {
    return db.prepare(`
        SELECT t.*, f.name AS folder_name
        FROM threads t JOIN folders f ON f.id = t.folder_id
        WHERE t.id = ?
    `).get(id);
}

/**
 * Oversight handoff, part one: render a thread as a portable brief.
 *
 * Deliberately plain markdown. For a manual seat, a person carries this to
 * whichever frontier model they like, by hand, at zero cost — the committee gets a vote
 * without every thought making a pilgrimage through a paid endpoint.
 */
function buildBrief(threadId, { actor = 'the committee' } = {}) {
    const thread = getThread(threadId);
    if (!thread) throw new Error(`No thread ${threadId}`);

    const flat = [];
    const walk = (nodes, depth) => {
        for (const p of nodes) {
            flat.push({ ...p, depth });
            if (p.children?.length) walk(p.children, depth + 1);
        }
    };
    walk(getThreadPackets(threadId), 0);

    const lines = [];
    lines.push(`# Oversight brief — ${thread.title}`);
    lines.push('');
    lines.push(`Tray: **${thread.folder_name}** · ${flat.length} packet(s) · `
        + `generated ${new Date().toISOString()}`);
    lines.push('');

    const travelled = flat.filter(p => p.origin_thread_title && p.origin_thread_title !== thread.title);
    if (travelled.length) {
        lines.push('## Provenance');
        lines.push('');
        for (const p of travelled) {
            lines.push(`- Packet #${p.id} was born in **${p.origin_thread_title}**`
                + `${p.hops ? `, ${p.hops} hop(s) since` : ''}.`);
        }
        lines.push('');
    }

    const reviewed = flat.filter(p => p.reviewers);
    if (reviewed.length) {
        lines.push('## Already signed off');
        lines.push('');
        for (const p of reviewed) lines.push(`- Packet #${p.id} — reviewed by ${p.reviewers}.`);
        lines.push('');
    }

    lines.push('## Thread');
    lines.push('');
    if (!flat.length) {
        lines.push('_Empty thread — nothing to review yet._');
        lines.push('');
    }
    flat.forEach((p, i) => {
        const who = p.role === 'assistant' ? `assistant${p.model ? ` · ${p.model}` : ''}` : p.role;
        lines.push(`### [${i + 1}] ${who} — packet #${p.id}${p.depth ? ` (nested, depth ${p.depth})` : ''}`);
        lines.push('');
        lines.push(p.content);
        lines.push('');
        if (p.images?.length) lines.push(`_(${p.images.length} image(s) attached — not included in this brief.)_`, '');
    });

    lines.push('---');
    lines.push('');
    lines.push(`**Asked of ${actor}:** review the reasoning above. Flag anything wrong, `
        + `missing, or over-confident. Be specific about which packet number you mean. `
        + `Your reply gets recorded against these packets as a signature, so say plainly `
        + `what you would and would not stand behind.`);
    lines.push('');

    return {
        thread: { id: thread.id, title: thread.title, folder: thread.folder_name },
        packetIds: flat.map(p => p.id),
        markdown: lines.join('\n')
    };
}

/**
 * Oversight handoff, part two: bring the verdict home.
 *
 * The verdict lands as a real packet in the thread (so it reads in context) and stamps a
 * `reviewed` signature on everything that was sent (so you can see what's been vetted vs
 * local-only). One transaction — a half-recorded review is worse than none.
 */
/**
 * Land a verdict and stamp what it covered.
 *
 * Two different facts get written per covered packet, and conflating them would
 * lose the one that matters:
 *
 *   reviewed  a judgement was made about this packet
 *   crossed   this packet's content left the machine
 *
 * A packet can be reviewed without crossing (a local model read it) and can
 * cross without being reviewed (it was context in a brief, not the subject). The
 * boundary question — "what has a remote model ever seen?" — is answered by
 * `crossed` alone, which is why it is its own event rather than a flag on the
 * other one.
 *
 * `transport` records HOW it crossed. A brief copied into Claude by hand is
 * still an exposure; the only difference from an API call is who carried it.
 */
function recordHandoff(threadId, { actor, verdict, packetIds = [], model = null, tier = 'remote', transport = 'manual' }) {
    if (!getThread(threadId)) throw new Error(`No thread ${threadId}`);
    if (!actor) throw new Error('A handoff needs an actor — who reviewed it?');
    if (!verdict || !verdict.trim()) throw new Error('A handoff needs the verdict text.');

    db.exec('BEGIN');
    try {
        const packet = createPacket({
            threadId, role: 'assistant', content: verdict.trim(),
            model: model || actor, tier
        });

        const covered = [];
        for (const pid of packetIds) {
            if (pid === packet.id) continue;
            if (!getPacket(pid)) continue;
            record(pid, 'reviewed', { actor, note: `via handoff packet #${packet.id}` });
            if (tier === 'remote') {
                record(pid, 'crossed', {
                    actor,
                    note: `${transport} · ${model || actor} · handoff packet #${packet.id}`
                });
            }
            covered.push(pid);
        }

        db.exec('COMMIT');
        return { packet, signed: covered.length, crossed: tier === 'remote' ? covered.length : 0 };
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}

/**
 * What has ever left the machine, for one thread or for everything.
 *
 * This is the query the boundary exists to make answerable. It reads the
 * append-only log rather than any mutable field, so a packet that was moved,
 * forked or renamed since still reports the crossing it actually made.
 */
function getExposure(threadId = null) {
    const rows = db.prepare(`
        SELECT pr.packet_id, pr.actor, pr.note, pr.created_at,
               p.thread_id, p.role, p.tier, p.content, t.title AS thread
        FROM provenance pr
        JOIN packets p ON p.id = pr.packet_id
        LEFT JOIN threads t ON t.id = p.thread_id
        WHERE pr.event = 'crossed'
          ${threadId ? 'AND p.thread_id = ?' : ''}
        ORDER BY pr.id
    `).all(...(threadId ? [Number(threadId)] : []));

    const packets = new Map();
    for (const r of rows) {
        const entry = packets.get(r.packet_id) || {
            packetId: r.packet_id,
            threadId: r.thread_id,
            thread: r.thread,
            role: r.role,
            preview: (r.content || '').slice(0, 120),
            crossings: []
        };
        entry.crossings.push({ actor: r.actor, note: r.note, at: r.created_at });
        packets.set(r.packet_id, entry);
    }

    const exposed = [...packets.values()];
    return {
        threadId: threadId ? Number(threadId) : null,
        packets: exposed,
        packetCount: exposed.length,
        crossingCount: rows.length,
        actors: [...new Set(rows.map(r => r.actor))].sort()
    };
}

function stats() {
    const one = sql => db.prepare(sql).get();
    return {
        folders: one('SELECT COUNT(*) AS c FROM folders').c,
        threads: one('SELECT COUNT(*) AS c FROM threads').c,
        packets: one('SELECT COUNT(*) AS c FROM packets').c,
        nested: one('SELECT COUNT(*) AS c FROM packets WHERE parent_id IS NOT NULL').c,
        forks: one('SELECT COUNT(*) AS c FROM packets WHERE forked_from IS NOT NULL').c,
        provenance: one('SELECT COUNT(*) AS c FROM provenance').c,
        reviews: one("SELECT COUNT(*) AS c FROM provenance WHERE event = 'reviewed'").c,
        dbPath: DB_PATH
    };
}

module.exports = {
    db, getTree, createFolder, deleteFolder, renameFolder, reorderFolder,
    createThread, deleteThread, getThread, renameThread, moveThreadToFolder, reorderThread,
    setThreadWorkspace, migrateWorkspaceRoot, getMeta, setMeta,
    createPacket, getPacket, getThreadPackets, movePacket, forkPacket, deletePacket,
    reviewPacket, getProvenance, getReviews, search, getTravelled, stats, subtreeIds,
    buildBrief, recordHandoff, getExposure
};
