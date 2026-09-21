'use strict';

/**
 * Duet orchestration — the part that knows about conversations and boundaries, and
 * deliberately nothing about any particular model vendor.
 *
 * What happens on a send, in order, and why the order is the order:
 *
 *   1. The request is written to the shared log FIRST and gets a server-assigned seq.
 *      Persisting before generating is what makes a retry cheap: the triggering message
 *      already exists, so retrying regenerates a reply instead of re-asking.
 *   2. A context SNAPSHOT is taken at that seq, completed messages only. Taken here, at
 *      submit time, not when the model actually starts — so a reply that spent thirty
 *      seconds queued answers the conversation as it stood when Send was pressed, and two
 *      requests fired together genuinely cannot see each other. That is a property worth
 *      keeping rather than a limitation to paper over: it is the difference between two
 *      participants answering the same question and one quietly answering the other.
 *   3. A placeholder reply is appended with status `streaming`, so the reply has an id and
 *      an owner before a single token exists. Nothing downstream has to guess which pane a
 *      token belongs to.
 *   4. If the answering participant is REMOTE, the local gate rules on the whole assembled
 *      context before anything is sent. See below — this is the part that is specific to
 *      this desk and is not optional.
 *   5. The job queues. Two 30B generations at once on one 16 GB card is not concurrency,
 *      it is thrashing — so the queue is real and its depth is visible to the user.
 *   6. Tokens stream. On stop, refusal, failure or a dead server the placeholder is settled
 *      to a terminal status that is not `complete`, which is precisely what keeps it out of
 *      every future snapshot.
 *
 * ⚠ A duet crossing exposes MORE than the message you typed.
 *
 * Asking a remote participant sends it the shared conversation — which includes what the
 * other participant said, and what was asked of the other participant. That is the whole
 * point of the feature and it is also a real exposure, so the gate reads the assembled
 * context rather than just the newest message, and the crossing is recorded against every
 * packet whose text was actually in it (duet-context.js returns exactly that set as
 * `meta.sourceIds`). "What has a remote model ever seen?" stays a query, not a guess.
 */

const store = require('./db');
const duet = require('./duet-store');
const providers = require('./providers');
const auth = require('./auth');
const { runGate } = require('./boundary');
const { buildContext } = require('./duet-context');

const { STATUS } = duet;

// ─────────────────────────── queue ───────────────────────────

/**
 * FIFO with a concurrency limit and a live position for everyone still waiting.
 *
 * Small enough to own outright. A library here would be a dependency for thirty lines, and
 * the one behaviour that matters — telling a waiting pane it is third — is the bit a
 * generic pool would not give us anyway.
 */
class GenerationQueue {
    constructor(limit = 1) {
        this.limit = Math.max(1, limit);
        this.active = 0;
        this.waiting = [];
    }

    get depth() { return this.waiting.length; }

    run(task, onPosition) {
        return new Promise((resolve, reject) => {
            this.waiting.push({ task, resolve, reject, onPosition });
            this.#announce();
            this.#pump();
        });
    }

    #announce() {
        this.waiting.forEach((entry, i) => {
            try { entry.onPosition?.(i + 1); } catch { /* a listener must not stall the queue */ }
        });
    }

    #pump() {
        while (this.active < this.limit && this.waiting.length) {
            const entry = this.waiting.shift();
            this.active++;
            this.#announce();

            Promise.resolve()
                .then(entry.task)
                .then(entry.resolve, entry.reject)
                .finally(() => { this.active--; this.#pump(); });
        }
    }
}

/**
 * One queue per tier, not one globally.
 *
 * The local tier is throttled because a single GPU is the bottleneck. The remote tier is
 * not — Token Factory will happily serve both panes at once, and making a hosted call wait
 * behind a local 30B would throttle it for a reason that does not apply to it.
 */
const queues = new Map();

function queueFor(tier, limit) {
    let queue = queues.get(tier);
    if (!queue) {
        queue = new GenerationQueue(tier === 'remote' ? Math.max(2, limit) : limit);
        queues.set(tier, queue);
    }
    if (tier !== 'remote') queue.limit = Math.max(1, limit);   // config can change live
    return queue;
}

// ─────────────────────────── the gate ───────────────────────────

/**
 * Rule on a duet crossing. Once per thread per model, matching /api/chat's clearance rule,
 * so ordinary back-and-forth does not pay for a local gate call on every message.
 *
 * Inherits that route's KNOWN GAP: a secret typed on turn nine is not gated, because the
 * thread was cleared at turn one. Noted in the README as not built.
 */
async function clearCrossing({ threadId, model, wire, config }) {
    if (store.isCleared(Number(threadId), model)) return { release: true, cached: true };

    // The gate reads exactly what would be sent — system prompt, both participants' words,
    // the lot — because that is exactly what would leave. No model is named: boundary.js
    // resolves a LOCAL one itself, and refuses outright if handed a remote id.
    const outgoing = wire.map(m => `${m.role}: ${m.content || ''}`).join('\n\n');
    const ruling = await runGate(outgoing, { config });

    if (ruling.release) store.recordClearance(Number(threadId), model, ruling);
    return ruling;
}

// ─────────────────────────── generation ───────────────────────────

let generationCounter = 0;
const nextGenerationId = () => `duet-${Date.now().toString(36)}-${(++generationCounter).toString(36)}`;

/**
 * Resolve or create the user message a generation answers.
 *
 * Three ways in, and the duplicate guard is why all three live together:
 *   - a fresh submission, carrying a clientRequestId
 *   - the SAME submission arriving twice (double click, a retried fetch) — matched on that
 *     id and handed back the existing packet rather than appended again
 *   - a retry of an earlier turn — names the packet outright and appends nothing
 */
function resolveTrigger({ threadId, participant, text, clientRequestId, retryOf }) {
    if (retryOf) {
        const existing = duet.getMessage(retryOf);
        if (!existing) throw new Error(`No message ${retryOf} to retry.`);
        if (existing.threadId !== Number(threadId)) throw new Error('That message is in another conversation.');
        if (existing.role !== 'user') throw new Error('Only a request can be retried.');
        return { trigger: existing, created: false };
    }

    const duplicate = duet.findByClientRequest(threadId, clientRequestId);
    if (duplicate) return { trigger: duplicate, created: false };

    if (!text || !text.trim()) throw new Error('Nothing to send.');

    const trigger = duet.appendMessage({
        threadId,
        role: 'user',
        content: text.trim(),
        recipientId: participant.id,
        clientRequestId: clientRequestId || null,
        status: STATUS.COMPLETE,
        // Written on this machine. Whether it later crosses is a separate fact, recorded
        // as a `crossed` provenance event rather than by rewriting the tier.
        tier: 'local'
    });

    return { trigger, created: true };
}

/**
 * Run one generation, emitting events as it goes.
 *
 * @param {object} args
 * @param {number} args.threadId
 * @param {number} args.participantId
 * @param {string} [args.text]            the new request (omit when retrying)
 * @param {string} [args.clientRequestId] duplicate-submit guard
 * @param {number} [args.retryOf]         regenerate the reply to this user message
 * @param {object} args.config            server config: sampling, num_ctx, systemPrompt
 * @param {AbortSignal} args.signal       the client hung up, or hit Stop
 * @param {(event: object) => void} args.emit
 */
async function generate({ threadId, participantId, text, clientRequestId, retryOf, config, signal, emit }) {
    const participant = duet.getParticipant(participantId);
    if (!participant) throw new Error(`No participant ${participantId}`);
    if (participant.thread_id !== Number(threadId)) {
        throw new Error('That participant belongs to another conversation.');
    }

    const model = participant.model || config.model;
    if (!model) throw new Error(`${participant.name} has no model selected.`);

    const tier = providers.tierOf(model);
    const others = duet.getParticipants(threadId).filter(p => p.id !== participant.id);

    // ── 1. the request lands in the shared log ──
    const { trigger, created } = resolveTrigger({ threadId, participant, text, clientRequestId, retryOf });
    emit({ type: 'user', message: trigger, created });

    // ── 2. snapshot, fixed at submit time ──
    const snapshotSeq = trigger.seq;
    const snapshot = duet.getConversation(threadId, { maxSeq: snapshotSeq, completedOnly: true });

    const { messages: wire, meta } = buildContext({
        participant,
        others,
        messages: snapshot,
        trigger,
        appSystemPrompt: config.systemPrompt,
        numCtx: config.num_ctx,
        userName: duet.USER_NAME
    });

    const generationId = nextGenerationId();
    const requestMeta = { model, tier, snapshotSeq, contextMessages: wire.length, ...meta };

    // ── 3. the reply exists, and is owned, before it says anything ──
    let reply = duet.appendMessage({
        threadId,
        role: 'assistant',
        content: '',
        model,
        tier,
        authorId: participant.id,
        recipientId: null,          // a reply is addressed back to the user
        status: STATUS.STREAMING,
        replyTo: trigger.id,
        generationId,
        requestMeta
    });

    emit({ type: 'start', message: reply, context: meta, tier });

    const settle = (status, content, extra = {}) =>
        duet.finishMessage(reply.id, { content, status, requestMeta: { ...requestMeta, ...extra } });

    // ── 4. the boundary ──
    let gateRuling = null;

    // ⚠ `!== 'local'`: anything the local catalogue did not name is treated as a
    // crossing. A duet crossing carries the OTHER participant's words too, so this is
    // the last place that should be deciding by exact string match on 'remote'.
    if (tier !== 'local') {
        emit({ type: 'gating', messageId: reply.id });

        try {
            gateRuling = await clearCrossing({ threadId, model, wire, config });
        } catch (err) {
            // A gate that throws is a gate that did not release. Fail closed.
            gateRuling = {
                release: false,
                reason: `The gate could not be reached (${err.message}), so nothing was sent.`,
                concerns: []
            };
        }

        if (!gateRuling.release) {
            // Nothing has touched the network. The refusal stays in the log as a packet so
            // the attempt is part of the record, and `blocked` keeps it out of context.
            reply = settle(STATUS.BLOCKED, '', { gate: gateRuling });
            emit({ type: 'blocked', message: reply, gate: gateRuling, tier });
            return reply;
        }

        const over = auth.spendRemote();
        if (over) {
            reply = settle(STATUS.FAILED, '', { error: over });
            emit({ type: 'error', message: reply, error: over });
            return reply;
        }
    }

    // ── 5 & 6. queue, then stream ──
    // An unclassified model queues with the local tier rather than opening a third queue
    // of its own: the conservative limit, and one fewer lane in the status line.
    const queue = queueFor(tier === 'remote' ? 'remote' : 'local', Number(config.maxConcurrent) || 1);
    let started = false;
    const queuedAt = Date.now();

    let content = '';
    let thinking = '';
    let firstTokenAt = null;
    let finalChunk = null;
    let crossingRecorded = false;

    try {
        await queue.run(async () => {
            started = true;

            // A generation cancelled while it was still waiting must not start now.
            if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });

            emit({ type: 'running', messageId: reply.id });

            const caps = await providers.capabilities(model).catch(() => []);
            const canThink = caps.includes('thinking');

            // One generator whatever the tier — the provider layer has already normalised
            // the remote stream into Ollama's chunk shape, which is Airlock's contract.
            const stream = providers.chat({
                model,
                messages: wire,
                config,
                // Omitted entirely when unsupported: sending `false` is still a request to
                // a model that has no thinking channel, and that is a hard 400.
                ...(canThink ? { think: config.think !== false } : {}),
                signal
            });

            for await (const chunk of stream) {
                // First chunk back proves the request was accepted, which is the moment the
                // content is provably across. Recording on dispatch would log crossings
                // that never happened.
                // `!== 'local'` for the same reason the gate above uses it: a crossing
                // the registry could not classify is still a crossing, and the audit
                // trail is worth less if it only records the ones we were sure about.
                if (tier !== 'local' && !crossingRecorded) {
                    crossingRecorded = true;
                    try {
                        store.recordCrossings(meta.sourceIds, {
                            actor: model, model, transport: 'duet', gate: gateRuling
                        });
                    } catch (err) {
                        console.error('crossing not recorded:', err.message);
                    }
                }

                if (chunk.message?.thinking) {
                    thinking += chunk.message.thinking;
                    emit({ type: 'thinking', messageId: reply.id, text: chunk.message.thinking });
                }
                if (chunk.message?.content) {
                    if (firstTokenAt === null) firstTokenAt = Date.now();
                    content += chunk.message.content;
                    emit({ type: 'token', messageId: reply.id, text: chunk.message.content });
                }
                if (chunk.done) finalChunk = chunk;
            }
        }, position => {
            // Position updates keep arriving as the queue drains; once this job is running
            // they are about somebody else, so drop them rather than re-queue the pane.
            if (!started) emit({ type: 'queued', messageId: reply.id, position });
        });

        const usage = finalChunk ? {
            prompt: finalChunk.prompt_eval_count ?? 0,
            reply: finalChunk.eval_count ?? 0,
            // Nanoseconds, because that is what Ollama reports and what the client divides
            // by 1e9. providers/tokenfactory.js measures its own — see README.
            evalDuration: finalChunk.eval_duration ?? 0
        } : null;

        reply = settle(STATUS.COMPLETE, content, {
            usage,
            thinkingChars: thinking.length || undefined,
            ttftMs: firstTokenAt ? firstTokenAt - queuedAt : null,
            crossed: crossingRecorded || undefined
        });

        emit({ type: 'done', message: reply, usage, thinking, done: finalChunk });
        return reply;
    } catch (err) {
        // Stop is not an error, and a stopped reply is not context. Partial text is kept
        // because it is worth reading; the status is what keeps it out of the next
        // snapshot, so nothing downstream has to remember this rule.
        const aborted = err.name === 'AbortError' || signal.aborted;
        const status = aborted ? STATUS.CANCELLED : STATUS.FAILED;

        reply = settle(status, content, {
            error: aborted ? null : err.message,
            crossed: crossingRecorded || undefined
        });

        emit(aborted
            ? { type: 'cancelled', message: reply }
            : { type: 'error', message: reply, error: err.message });

        return reply;
    }
}

/** Queue depth per tier, for the status line. */
const queueState = () => Object.fromEntries(
    [...queues.entries()].map(([tier, q]) => [tier, { active: q.active, waiting: q.depth, limit: q.limit }])
);

module.exports = { generate, queueState, GenerationQueue };
