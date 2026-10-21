'use strict';

/**
 * ─────────────────────────── The kernel ───────────────────────────
 *
 * The one place that decides whether content may leave this machine.
 *
 * boundary.js is the gate: a local model that reads text and rules on it. This file is
 * what makes the gate unavoidable. Before it existed, each route decided for itself
 * whether a request needed gating and called runGate if it thought so — and the routes
 * disagreed. Three tested `tier === 'remote'`, so an unclassified model skipped the gate.
 * The chat route gated once, before its tool loop, so file contents a remote model read
 * with read_file in round two crossed without any ruling. A thread cleared on turn one
 * was never gated again, so a secret typed on turn nine was not caught. Every one of
 * those was a caller deciding, and every one was wrong in a different way.
 *
 * So the decision moved down to the only door content can leave through:
 *
 *   - providers.chat() will not dispatch to anything that is not positively local
 *     unless it holds a clearance from here that covers every message it is about to
 *     send. A caller that forgets to ask does not get a silent crossing — it gets the
 *     gate run on its behalf.
 *   - providers/egress.js will not open a content-bearing connection to a remote host
 *     without a clearance this module issued. That is the second lock: a provider path
 *     that somehow bypassed providers.chat() still cannot reach the network.
 *
 * ── what a clearance covers ──
 *
 * Content, not threads. Every outgoing message is hashed, and a clearance names the
 * exact set of hashes it was issued for, bound to the model it may go to. A ruling is
 * therefore about THESE WORDS, and cannot be stretched to cover different words sent
 * later — which is what once-per-thread consent did.
 *
 * Messages already ruled on are remembered, so each turn gates only what is new: the
 * next user message, a tool result, the other duet participant's latest reply. That is
 * what made per-turn gating affordable. With a 4B local gate model it costs about a
 * second, where re-reading the whole history every turn would grow without bound.
 *
 * ⚠ Gating only the new part loses some context. A secret split across two turns can
 * pass as two innocent halves. That is a real limit and is stated here rather than
 * hidden: the alternative, re-gating the whole conversation every turn, costs time in
 * proportion to its length and makes the gate slower exactly when threads get long.
 *
 * ⚠ The gate reads text. A message carrying images cannot be judged by it, so it is
 * refused rather than waved through — fail closed, and say why.
 *
 * ⚠ What this cannot mediate: a brief or packet exported and carried out by hand, and
 * any code that opens its own socket. The first is recorded, not prevented; the second
 * is why providers/egress.js is the only file allowed to call fetch, and why a tool that
 * runs third-party code would need to live in a separate process.
 */

const crypto = require('crypto');
const providers = require('./providers');
const sandbox = require('./sandbox');

/**
 * What has been ruled on: hash -> { by: 'gate' | 'origin' | 'operator', at, gateModel }.
 *
 * One record per visitor, not one per process. Hosted, a shared record would let a
 * visitor learn something about another: a message that crosses with no gate delay is one
 * somebody has already sent. That is a small leak, and this is the one product that
 * should not have it. On a desk there is one scope and nothing changes.
 */
const memories = new WeakMap();      // scope -> Map
function released() {
    const scope = sandbox.scopeKey();
    let memory = memories.get(scope);
    if (!memory) {
        memories.set(scope, memory = new Map());
        // A restart used to forget every ruling, so the next remote turn re-judged a whole
        // thread's history — more for the gate to trip over, and slower. The record is hashes
        // only, never text, kept in the current scope's own store (a visitor's sandbox, or
        // the desk). Loading it can only make the gate read less, never let more through:
        // a hash is released only if those exact words were released before.
        if (persist) {
            try {
                for (const r of persist.loadReleased(MAX_REMEMBERED)) memory.set(r.hash, { by: r.by, at: r.at, gateModel: r.gateModel });
            } catch (err) { console.error('released rulings not loaded:', err.message); }
        }
    }
    return memory;
}

/** Where rulings are kept between restarts. Set by the server at boot; tests stay in memory. */
let persist = null;
function persistTo(store) { persist = store; }

/** Bound the memory a long-running process spends remembering rulings. */
const MAX_REMEMBERED = 50_000;

/** Tokens this module issued. A WeakSet, so a clearance cannot be forged by shape. */
const issued = new WeakSet();

const sha = s => crypto.createHash('sha256').update(s).digest('hex');

/**
 * One message, reduced to everything about it that would leave.
 *
 * Every field a provider could transmit is in here, because a field left out of the
 * hash is a field that could change after the ruling without anyone noticing.
 */
function unitHash(m) {
    return sha(JSON.stringify({
        role: m.role || null,
        content: m.content || '',
        thinking: m.thinking || null,
        tool_name: m.tool_name || null,
        tool_calls: m.tool_calls || null,
        images: (m.images || []).map(img => sha(String(img)))
    }));
}

function remember(hash, by, gateModel = null) {
    if (released().size >= MAX_REMEMBERED) {
        // Oldest first. Forgetting is the safe direction: a forgotten message is simply
        // gated again the next time it would leave.
        released().delete(released().keys().next().value);
    }
    const at = Date.now();
    released().set(hash, { by, at, gateModel });
    if (persist) {
        try { persist.rememberReleased(hash, by, gateModel, at); }
        catch (err) { console.error('ruling not kept:', err.message); }
    }
}

/** What the gate is shown for one message. Tool calls and results say what they are. */
function describe(m) {
    const who = m.role === 'tool' ? `tool result (${m.tool_name || 'unnamed tool'})` : m.role;
    const parts = [`${who}: ${m.content || ''}`];
    if (m.thinking) parts.push(`[reasoning] ${m.thinking}`);
    for (const call of m.tool_calls || []) {
        const args = call.function?.arguments;
        parts.push(`[tool call] ${call.function?.name || '?'} ${typeof args === 'string' ? args : JSON.stringify(args ?? {})}`);
    }
    return parts.join('\n');
}

/**
 * The gate's reading, on the token ledger. Looked up at call time, like runGate, so the
 * offline kernel tests (which stub the gate and point AIRLOCK_DB at a scratch file) never
 * touch a real store. A ledger hiccup never blocks a ruling.
 */
function recordGateUsage(ruling, threadId = null) {
    if (!ruling?.usage || !ruling.model) return;
    try {
        require('./db').recordUsage({
            purpose: 'gate', model: ruling.model, tier: 'local',
            prompt: ruling.usage.prompt, reply: ruling.usage.reply, threadId
        });
    } catch (err) { console.error('gate usage not recorded:', err.message); }
}

function issue(model, hashes, ruling) {
    // Bound to the scope it was issued in, as well as to the model and the words: a
    // clearance ruled in one visitor's sandbox opens nothing in another's.
    const token = Object.freeze({ model, hashes: new Set(hashes), ruling, at: Date.now(),
                                  scope: sandbox.scopeKey() });
    issued.add(token);
    return token;
}

const COVERED = Object.freeze({
    release: true,
    reason: 'Every message in this request was already ruled on.',
    concerns: [],
    covered: true
});

/**
 * Rule on everything in `messages` that has not been ruled on before, for `model`.
 *
 * `ownWords`: messages that `model` itself wrote — its own earlier replies, going back to
 * it as context. Sending a model its own words exposes nothing new, so they are not put to
 * the gate. Measured 2026-10-14: on every follow-up turn the gate was shown the remote
 * side's previous reply alone — "assistant: fine" — and the 14B, asked whether one word may
 * leave, withheld it. Scoped to THIS clearance only, never remembered as released: the same
 * words going to a different model are new exposure there, and are ruled on.
 *
 * `shownAs`: [{ message, text }] — what the gate reads for a message INSTEAD of its raw
 * content: for the duet system prompt, only the parts the User wrote (duet-context.js
 * gateViewOfSystem). Empty text means none of it is the User's, and it is not read at all.
 * The clearance still covers the message exactly as sent; only what the gate reads changes.
 *
 * Returns { ok: true, token, ruling, fresh } or { ok: false, ruling, fresh, freshAt }, where
 * `freshAt` is the index in `messages` of each one the gate was asked about — what a refusal
 * was about, so the caller can say which messages it withheld.
 * A local destination needs no clearance and gets { ok: true, token: null, local: true }.
 */
async function clear({ model, messages = [], config = {}, threadId = null, ownWords = [], shownAs = [] }) {
    if (providers.tierOf(model) === 'local') return { ok: true, token: null, local: true, fresh: 0 };

    const units = messages.map(m => ({ m, h: unitHash(m) }));
    const own = new Set(ownWords.map(unitHash));
    const views = new Map(shownAs.map(v => [unitHash(v.message), String(v.text || '')]));
    const seen = new Set();
    const fresh = units.filter(u => !released().has(u.h) && !own.has(u.h) && !(views.has(u.h) && !views.get(u.h))
        && !seen.has(u.h) && seen.add(u.h));
    const freshAt = units.flatMap((u, i) => (seen.has(u.h) ? [i] : []));

    if (fresh.some(u => u.m.images?.length)) {
        return {
            ok: false,
            fresh: fresh.length,
            freshAt,
            ruling: {
                release: false,
                reason: 'This request carries an image, and the local gate reads text only — '
                    + 'it cannot rule on what an image shows, so nothing was sent.',
                concerns: ['image'],
                model: null,
                // Not a ruling on the words: the gate never read them.
                undecided: true
            }
        };
    }

    let ruling = COVERED;
    if (fresh.length) {
        // Looked up at call time so a test can stand a stub in for the real gate.
        ruling = await require('./boundary').runGate(fresh.map(u => views.has(u.h)
            ? `${u.m.role} (only what the User wrote in it):\n${views.get(u.h)}` : describe(u.m)).join('\n\n'), { config });
        recordGateUsage(ruling, threadId);
        if (!ruling.release) return { ok: false, ruling, fresh: fresh.length, freshAt };
        for (const u of fresh) remember(u.h, 'gate', ruling.model || null);
    }

    return { ok: true, token: issue(model, units.map(u => u.h), ruling), ruling, fresh: fresh.length };
}

/**
 * Ask the gate about some messages WITHOUT sending them anywhere: no clearance is issued and
 * nothing is remembered as released, so a ruling here can never let anything cross. Used after
 * a refusal, to tell which of the messages it was about the gate objects to on its own
 * (duet-runner.js withheldBy). On the token ledger like any other reading.
 */
async function judge({ messages = [], config = {}, threadId = null }) {
    const ruling = await require('./boundary').runGate(messages.map(describe).join('\n\n'), { config });
    recordGateUsage(ruling, threadId);
    return ruling;
}

/** The unit a web clearance is bound to: the destination and the exact text sent. */
const outboundUnit = (destination, text) => ({ role: 'outbound', content: `to ${destination}: ${text}` });

/**
 * Rule on a web search query before it leaves. Unlike clear(), no destination skips it: a
 * query a LOCAL model wrote leaves this machine just as surely as one a cloud model wrote,
 * and may carry whatever was in that model's context. Same gate, same scanner in front of
 * it, same memory — a query already released is not ruled on twice.
 *
 * Returns { ok, ruling, token }: the token is what egress.web() demands, bound to this
 * exact query, so the second lock holds for the web as it does for models.
 */
async function clearOutbound({ destination = 'web:search', label = 'a web search', text, config = {}, threadId = null }) {
    const unit = outboundUnit(destination, text);
    const h = unitHash(unit);
    let ruling = COVERED;
    if (!released().has(h)) {
        ruling = await require('./boundary').runGate(
            `outbound request (it leaves this machine for ${label}):\n${text}`, { config });
        recordGateUsage(ruling, threadId);
        if (!ruling.release) return { ok: false, ruling };
        remember(h, 'gate', ruling.model || null);
    }
    return { ok: true, ruling, token: issue(destination, [h], ruling) };
}

/**
 * Clear a link to be fetched. The model did not write it — the caller has already checked
 * it came from the user or a search result — so there is none of its context to rule on;
 * the scanner still reads it, because a link pasted with a token in it is a credential
 * leaving. Returns { ok, ruling, token } like clearOutbound.
 */
function clearLink({ url }) {
    if (require('./secrets').scan(url).length) {
        return { ok: false, ruling: { release: false, reason: 'That link appears to carry a credential.', concerns: ['credential'] } };
    }
    const ruling = { release: true, reason: 'A link the model did not write; scanned for credentials.', concerns: [] };
    return { ok: true, ruling, token: issue('web:fetch', [unitHash(outboundUnit('web:fetch', url))], ruling) };
}


/**
 * These messages came FROM the far side — a remote model's own reply, fed back to it in
 * the next tool round. Sending a model its own words is not new exposure, and gating
 * them would spend a gate call judging text that originated where it is going.
 *
 * Forgetting to acknowledge is safe: the text is simply gated.
 */
function acknowledge(messages = []) {
    for (const m of messages) remember(unitHash(m), 'origin');
}

/** Does this clearance cover exactly these messages, going to this model? */
function covers(token, model, messages = []) {
    if (!token || !issued.has(token) || token.model !== model) return false;
    if (token.scope !== sandbox.scopeKey()) return false;
    return messages.every(m => {
        const h = unitHash(m);
        return token.hashes.has(h) || released().has(h);
    });
}

/** For egress.js: was this token issued here, for this destination? */
const isIssuedFor = (token, model) => Boolean(token) && issued.has(token) && token.model === model
    && token.scope === sandbox.scopeKey();

module.exports = {
    clearOutbound, clearLink, outboundUnit,
    clear, judge, acknowledge, covers, isIssuedFor, unitHash, persistTo,
    // Tests reach in to simulate a restart: the CURRENT scope's record, and dropping it.
    get _released() { return released(); },
    _forget() { memories.delete(sandbox.scopeKey()); }
};
