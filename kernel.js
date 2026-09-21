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

/** hash -> { by: 'gate' | 'origin' | 'operator', at, gateModel } */
const released = new Map();

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
    if (released.size >= MAX_REMEMBERED) {
        // Oldest first. Forgetting is the safe direction: a forgotten message is simply
        // gated again the next time it would leave.
        released.delete(released.keys().next().value);
    }
    released.set(hash, { by, at: Date.now(), gateModel });
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

function issue(model, hashes, ruling) {
    const token = Object.freeze({ model, hashes: new Set(hashes), ruling, at: Date.now() });
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
 * Returns { ok: true, token, ruling, fresh } or { ok: false, ruling, fresh }.
 * A local destination needs no clearance and gets { ok: true, token: null, local: true }.
 */
async function clear({ model, messages = [], config = {} }) {
    if (providers.tierOf(model) === 'local') return { ok: true, token: null, local: true, fresh: 0 };

    const units = messages.map(m => ({ m, h: unitHash(m) }));
    const seen = new Set();
    const fresh = units.filter(u => !released.has(u.h) && !seen.has(u.h) && seen.add(u.h));

    if (fresh.some(u => u.m.images?.length)) {
        return {
            ok: false,
            fresh: fresh.length,
            ruling: {
                release: false,
                reason: 'This request carries an image, and the local gate reads text only — '
                    + 'it cannot rule on what an image shows, so nothing was sent.',
                concerns: ['image'],
                model: null
            }
        };
    }

    let ruling = COVERED;
    if (fresh.length) {
        // Looked up at call time so a test can stand a stub in for the real gate.
        ruling = await require('./boundary').runGate(fresh.map(u => describe(u.m)).join('\n\n'), { config });
        if (!ruling.release) return { ok: false, ruling, fresh: fresh.length };
        for (const u of fresh) remember(u.h, 'gate', ruling.model || null);
    }

    return { ok: true, token: issue(model, units.map(u => u.h), ruling), ruling, fresh: fresh.length };
}

/**
 * An operator overrode the gate. The content goes, and the record says who decided.
 *
 * The messages are remembered as released too: after a forced crossing they are on the
 * far side whatever anyone thinks of it, and gating them again later protects nothing.
 */
function override({ model, messages = [], actor = 'the operator' }) {
    const hashes = messages.map(unitHash);
    for (const h of hashes) remember(h, 'operator');
    const ruling = {
        release: true,
        reason: `Overridden by ${actor}.`,
        concerns: [],
        model: null,           // no model ruled
        forced: true
    };
    return { ok: true, token: issue(model, hashes, ruling), ruling, fresh: hashes.length };
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
    return messages.every(m => {
        const h = unitHash(m);
        return token.hashes.has(h) || released.has(h);
    });
}

/** For egress.js: was this token issued here, for this destination? */
const isIssuedFor = (token, model) => Boolean(token) && issued.has(token) && token.model === model;

module.exports = {
    clear, override, acknowledge, covers, isIssuedFor, unitHash,
    _released: released     // tests reach in to simulate a restart
};
