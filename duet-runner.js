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
 *   4. If the answering participant is not positively local, the kernel rules on everything
 *      in the assembled context it has not ruled on before, and binds the clearance to that
 *      exact snapshot, before anything is sent. See below — this is the part that is
 *      specific to this desk and is not optional.
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
const kernel = require('./kernel');
const sandbox = require('./sandbox');
const { buildContext } = require('./duet-context');
const workspace = require('./workspace-tools');

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
 * Rule on a duet crossing, through the kernel like every other crossing.
 *
 * Every turn is ruled on, and only what is new in it: the triggering message, and the
 * other participant's latest reply if that is new too. The clearance that comes back is
 * bound to exactly this `wire` — the snapshot taken at submit time — so what is ruled on
 * is what is sent, even after a wait in the queue.
 *
 * This used to be once per thread per model, which meant a secret typed on turn nine
 * was never judged. That was accepted when the gate model cost seconds per call.
 *
 * Returns { ok, ruling, token }.
 */
async function clearCrossing({ model, wire, config, threadId = null }) {
    // The gate reads exactly what would be sent — system prompt, both participants' words,
    // the lot — minus what it has already ruled on. No model is named: boundary.js
    // resolves a LOCAL one itself, and refuses outright if handed a remote id.
    return kernel.clear({ model, messages: wire, config, threadId });
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
/**
 * Images on a request: data URLs, as the composer reads them and as the classic view always
 * stored them, so the packet renders its own thumbnails. The wire form (bare base64) is
 * derived in duet-context.js, never stored.
 *
 * Checked rather than trusted — this is the one field on the send route that can be large
 * and that a model reads as something other than text.
 */
const MAX_IMAGES = 4;
const IMAGE_DATA_URL = /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+=*$/;

function checkImages(images) {
    if (images == null) return [];
    if (!Array.isArray(images)) throw new Error('images must be a list.');
    if (images.length > MAX_IMAGES) throw new Error(`At most ${MAX_IMAGES} images per message.`);
    for (const image of images) {
        if (typeof image !== 'string' || !IMAGE_DATA_URL.test(image)) {
            throw new Error('Each image must be a PNG, JPEG, GIF or WebP data URL.');
        }
    }
    return images;
}

/**
 * The message a chatter turn answers: the other side's finished reply, in this thread.
 *
 * Checked hard, because a relay sends the conversation to a model WITHOUT a new request the
 * user typed: it must be a complete assistant message (a withheld or failed one is not
 * conversation), in this thread, and not this participant's own — answering yourself is a
 * monologue, and a client pointing the relay anywhere else is refused before anything runs.
 * A reply from before the thread had participants (no author) may be answered by either side.
 */
function resolveRelay({ threadId, participant, relayOf }) {
    const trigger = duet.getMessage(relayOf);
    if (!trigger) throw new Error(`No message ${relayOf} to reply to.`);
    if (trigger.threadId !== Number(threadId)) throw new Error('That message is in another conversation.');
    if (trigger.role !== 'assistant') throw new Error('A chatter turn answers a reply, not a request.');
    if (trigger.status !== STATUS.COMPLETE) {
        throw new Error(`That reply is ${trigger.status}, not finished — there is nothing to answer.`);
    }
    if (trigger.authorId === participant.id) throw new Error(`${participant.name} cannot answer its own reply.`);
    // A model can finish with reasoning and no answer at all. That is complete, and empty, and
    // there is nothing in it to answer — relaying it just makes the other side talk to silence.
    if (!String(trigger.content || '').trim()) throw new Error('That reply is empty — there is nothing to answer.');
    return trigger;
}

function resolveTrigger({ threadId, participant, text, images = [], clientRequestId, retryOf }) {
    if (retryOf) {
        const existing = duet.getMessage(retryOf);
        if (!existing) throw new Error(`No message ${retryOf} to retry.`);
        if (existing.threadId !== Number(threadId)) throw new Error('That message is in another conversation.');
        if (existing.role !== 'user') throw new Error('Only a request can be retried.');
        return { trigger: existing, created: false };
    }

    const duplicate = duet.findByClientRequest(threadId, clientRequestId);
    if (duplicate) return { trigger: duplicate, created: false };

    if ((!text || !text.trim()) && !images.length) throw new Error('Nothing to send.');

    const trigger = duet.appendMessage({
        threadId,
        role: 'user',
        content: (text || '').trim(),
        images: images.length ? images : null,
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
async function generate({
    threadId, participantId, text, images, tools: wantTools = false, clientRequestId, retryOf,
    relayOf = null, config, signal, emit
}) {
    const participant = duet.getParticipant(participantId);
    if (!participant) throw new Error(`No participant ${participantId}`);
    if (participant.thread_id !== Number(threadId)) {
        throw new Error('That participant belongs to another conversation.');
    }

    const model = participant.model || config.model;
    if (!model) throw new Error(`${participant.name} has no model selected.`);

    const tier = providers.tierOf(model);
    const others = duet.getParticipants(threadId).filter(p => p.id !== participant.id);

    // A model that cannot see is refused BEFORE the request is written, so the composer gets
    // a plain error and keeps the message — rather than a packet in the log holding an image
    // nobody could read, and a reply that answers the text as though the picture were not
    // there. Retries re-check against the model the participant has now.
    const attached = relayOf ? [] : retryOf ? (duet.getMessage(retryOf)?.images || []) : checkImages(images);
    if (attached.length) {
        const caps = await providers.capabilities(model).catch(() => []);
        if (!caps.includes('vision')) {
            throw new Error(`${model} can't see images. Point ${participant.name} at a model `
                + 'marked 👁 in its picker, or send the text on its own.');
        }
    }

    // ── 1. the request lands in the shared log — or, in a chatter turn, already did ──
    //
    // A relay answers the OTHER side's finished reply rather than a new request: nothing is
    // written until this participant's own reply exists, and the trigger is that reply.
    let trigger, created = false, dialogueWith = null;
    if (relayOf) {
        trigger = resolveRelay({ threadId, participant, relayOf });
        dialogueWith = trigger.authorId ? duet.getParticipant(trigger.authorId) : null;
        emit({ type: 'relay', message: trigger });
    } else {
        ({ trigger, created } = resolveTrigger({
            threadId, participant, text, images: attached, clientRequestId, retryOf
        }));
        emit({ type: 'user', message: trigger, created });
    }

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
        userName: duet.USER_NAME,
        // Any relay is a dialogue turn — including one answering a reply from before the
        // thread had participants, which has no author to name.
        dialogueWith: relayOf ? (dialogueWith || { name: 'the other participant' }) : null
    });

    const generationId = nextGenerationId();
    const requestMeta = {
        model, tier, snapshotSeq, contextMessages: wire.length, ...meta,
        ...(relayOf ? { relayOf: trigger.id } : {})
    };

    // ── 3. the reply exists, and is owned, before it says anything ──
    let reply = duet.appendMessage({
        threadId,
        role: 'assistant',
        content: '',
        model,
        tier,
        authorId: participant.id,
        // A reply is addressed back to the user — except in a chatter turn, where it is
        // addressed to the participant it answers. That is what labels it [Right → Left].
        recipientId: dialogueWith ? dialogueWith.id : null,
        status: STATUS.STREAMING,
        replyTo: trigger.id,
        generationId,
        requestMeta
    });

    emit({ type: 'start', message: reply, context: meta, tier });

    // Every settled generation that actually ran goes on the token ledger — complete,
    // stopped, failed or withheld mid-turn alike: the tokens were spent either way.
    const settle = (status, content, extra = {}) => {
        const settled = duet.finishMessage(reply.id, { content, status, requestMeta: { ...requestMeta, ...extra } });
        const u = extra.usage;
        if (u && (u.prompt || u.reply)) {
            try {
                store.recordUsage({ purpose: 'reply', model, tier, prompt: u.prompt, reply: u.reply,
                    threadId, packetId: reply.id });
            } catch (err) { console.error('reply usage not recorded:', err.message); }
        }
        return settled;
    };

    // ── 4. the boundary ──
    let gateRuling = null;
    let clearance = null;

    // ⚠ `!== 'local'`: anything the local catalogue did not name is treated as a
    // crossing. A duet crossing carries the OTHER participant's words too, so this is
    // the last place that should be deciding by exact string match on 'remote'.
    const crosses = tier !== 'local';

    if (crosses) {
        emit({ type: 'gating', messageId: reply.id });

        try {
            const cleared = await clearCrossing({ model, wire, config, threadId });
            gateRuling = cleared.ruling;
            clearance = cleared.token;
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
    }

    // ── the workspace ──
    //
    // Files are offered only when the client asked for them for THIS participant (the pane's
    // ⛁ switch — on by default for a local side, off for a remote one), the thread has a
    // workspace that still exists and is permitted, and the model can call tools. Checked
    // here, per request, never remembered.
    const root = wantTools ? store.getThread(Number(threadId))?.workspace_root : null;
    const capsNow = await providers.capabilities(model).catch(() => []);
    const useTools = Boolean(root) && capsNow.includes('tools') && await workspace.usableRoot(root);

    // Which of the context's own messages were written after reading the workspace. When
    // they cross now, as someone else's context, the record says which files were behind
    // them — the raw tool results never enter another context, but their words may quote.
    const reads = {};
    if (crosses) {
        for (const m of snapshot) {
            const files = (m.requestMeta?.tools || []).filter(t => t.ok && t.name === 'read_file');
            if (files.length && meta.sourceIds.includes(m.id)) reads[m.id] = files.map(t => t.label);
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
    const usage = { prompt: 0, reply: 0, evalDuration: 0, rounds: 0 };
    const toolTrace = [];           // every call this reply made — stored on it, shown on it
    let withheld = null;            // a mid-turn refusal: the tool results the gate kept back

    try {
        // ⚠ Bound to the visitor who queued it. The queue is shared, and a waiting job is
        // started from the `finally` of whichever job finished before it — so, unbound, it
        // would run in THAT visitor's async context and write its reply into their sandbox.
        // sandbox_http_test drives two visitors through this queue to hold the line.
        await queue.run(sandbox.bind(async () => {
            started = true;

            // A generation cancelled while it was still waiting must not start now.
            if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });

            emit({ type: 'running', messageId: reply.id });

            const canThink = capsNow.includes('thinking');

            // The conversation grows as tools run: the model's tool_calls, then the results.
            const convo = [...wire];
            let pendingArtifacts = [];

            for (let round = 0; round <= workspace.MAX_TOOL_ROUNDS; round++) {
                const lastRound = round === workspace.MAX_TOOL_ROUNDS;   // no tools: force an answer
                let roundRecorded = false;

                if (crosses) {
                    // ⚠ Every round after the first carries something new: the tool results
                    // the model asked for — file contents. They are ruled on before they go,
                    // exactly as /api/chat rules on them, and a refusal ends the turn here.
                    if (round > 0) {
                        emit({ type: 'gating', messageId: reply.id });
                        const next = await kernel.clear({ model, messages: convo, config, threadId });
                        if (!next.ok) {
                            gateRuling = next.ruling;
                            withheld = pendingArtifacts.map(a => a.label);
                            return;
                        }
                        clearance = next.token;
                        gateRuling = next.ruling;
                        emit({ type: 'running', messageId: reply.id });
                    }

                    // Every round is a separately billed remote call, so every round is charged.
                    const over = auth.spendRemote();
                    if (over) throw new Error(over);
                }

                // One generator whatever the tier — the provider layer has already normalised
                // the remote stream into Ollama's chunk shape, which is Airlock's contract.
                const stream = providers.chat({
                    model,
                    messages: convo,
                    config,
                    // Omitted entirely when unsupported: sending `false` is still a request to
                    // a model that has no thinking channel, and that is a hard 400.
                    ...(canThink ? { think: config.think !== false } : {}),
                    tools: useTools && !lastRound ? workspace.TOOLS : undefined,
                    signal,
                    clearance
                });

                let roundContent = '';
                const toolCalls = [];
                let roundFinal = null;

                for await (const chunk of stream) {
                    // First chunk back proves the request was accepted, which is the moment the
                    // content is provably across. Recording on dispatch would log crossings
                    // that never happened. Per round: round 0 carried the conversation, later
                    // rounds carried the tool results the model asked for.
                    if (crosses && !roundRecorded) {
                        roundRecorded = true;
                        crossingRecorded = true;
                        try {
                            const opts = { actor: model, model, transport: 'duet', gate: gateRuling };
                            if (round === 0) store.recordCrossings(meta.sourceIds, { ...opts, reads });
                            if (pendingArtifacts.length) {
                                store.recordArtifactCrossing(trigger.id, { ...opts, artifacts: pendingArtifacts });
                                pendingArtifacts = [];
                            }
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
                        roundContent += chunk.message.content;
                        emit({ type: 'token', messageId: reply.id, text: chunk.message.content });
                    }
                    if (chunk.message?.tool_calls?.length) toolCalls.push(...chunk.message.tool_calls);
                    if (chunk.done) roundFinal = chunk;
                }

                if (roundFinal) {
                    finalChunk = roundFinal;
                    usage.prompt += roundFinal.prompt_eval_count ?? 0;
                    usage.reply += roundFinal.eval_count ?? 0;
                    // Nanoseconds, because that is what Ollama reports and what the client
                    // divides by 1e9. providers/tokenfactory.js measures its own — see README.
                    usage.evalDuration += roundFinal.eval_duration ?? 0;
                    usage.rounds++;
                }

                if (!toolCalls.length) return;          // this round is the answer

                const asked = { role: 'assistant', content: roundContent, tool_calls: toolCalls };
                convo.push(asked);

                // The model's own request, going back to the model that made it, is not new
                // exposure — only the results it asked for are. Acknowledged so the next
                // ruling judges the file contents, not the far side's own words.
                if (crosses) kernel.acknowledge([asked]);

                for (const { message, card, artifact } of await workspace.runCalls(toolCalls, root)) {
                    convo.push(message);
                    toolTrace.push({ ...artifact, summary: card.summary, name: card.name });
                    emit({ type: 'tool', messageId: reply.id, ...card });
                    if (crosses) pendingArtifacts.push(artifact);
                }
            }
        }), position => {
            // Position updates keep arriving as the queue drains; once this job is running
            // they are about somebody else, so drop them rather than re-queue the pane.
            if (!started) emit({ type: 'queued', messageId: reply.id, position });
        });

        const usageOut = usage.rounds ? {
            prompt: usage.prompt, reply: usage.reply, evalDuration: usage.evalDuration,
            ...(usage.rounds > 1 ? { rounds: usage.rounds } : {})
        } : null;

        const trace = toolTrace.length ? { tools: toolTrace } : {};

        if (withheld) {
            // The gate kept the file results back mid-turn. The request itself had crossed
            // (round 0 is on the record); the results did not. Blocked, so the partial text
            // stays out of every later context, and the ruling says what was withheld.
            reply = settle(STATUS.BLOCKED, content, {
                gate: gateRuling, withheld, usage: usageOut, ...trace,
                crossed: crossingRecorded || undefined
            });
            emit({ type: 'blocked', message: reply, gate: gateRuling, tier, withheld });
            return reply;
        }

        reply = settle(STATUS.COMPLETE, content, {
            usage: usageOut,
            thinkingChars: thinking.length || undefined,
            ttftMs: firstTokenAt ? firstTokenAt - queuedAt : null,
            crossed: crossingRecorded || undefined,
            ...trace
        });

        emit({ type: 'done', message: reply, usage: usageOut, thinking, done: finalChunk });
        return reply;
    } catch (err) {
        // Stop is not an error, and a stopped reply is not context. Partial text is kept
        // because it is worth reading; the status is what keeps it out of the next
        // snapshot, so nothing downstream has to remember this rule.
        const aborted = err.name === 'AbortError' || signal.aborted;
        const status = aborted ? STATUS.CANCELLED : STATUS.FAILED;

        reply = settle(status, content, {
            usage: usage.rounds ? { prompt: usage.prompt, reply: usage.reply, evalDuration: usage.evalDuration } : null,
            error: aborted ? null : err.message,
            crossed: crossingRecorded || undefined,
            ...(toolTrace.length ? { tools: toolTrace } : {})
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
