'use strict';

const providers = require('./providers');

// ─────────────────────── The boundary ───────────────────────
//
// Escalation crosses a line, so something has to decide whether it may. That
// decision is made by the LOCAL model, always, and this is the one piece of the
// design that is not negotiable.
//
// The obvious alternative — let Nemotron Nano judge the brief, since it is fast
// and cheap — cannot work. To let a remote model rule on whether content may
// leave, you must first send it the content. The gate would be standing on the
// wrong side of the door it is guarding. A remote gate cannot gate remoteness.
//
// So the gatekeeper runs on the machine it is protecting, and the remote tier
// keeps the job it is actually good at: reasoning about what the gate released.

const GATE_SYSTEM = [
    'You are the boundary gate for Airlock, a local-first reasoning desk.',
    '',
    'You run locally. The text below is about to be sent to a REMOTE model over',
    'the internet. Your only job is to decide whether that is acceptable, and to',
    'name anything in it that the author may not realise they are exposing.',
    '',
    'Withhold release when the text contains credentials, API keys, tokens,',
    'passwords, private keys, personal contact details, financial or medical',
    'information, or anything explicitly marked private or confidential.',
    '',
    'Absolute file paths, project names, and ordinary source code are NOT by',
    'themselves grounds to withhold. Say so in concerns if they seem sensitive,',
    'but still release.',
    '',
    'Answer with JSON and nothing else:',
    '{"release": true or false, "reason": "one short sentence", "concerns": ["..."]}'
].join('\n');

/**
 * Read the gate's ruling out of whatever the model actually said.
 *
 * JSON first. If the object is unparseable even after repair, fall back to
 * reading the release key on its own — a malformed wrapper should not turn a
 * clear "withhold" into an unreadable answer, and it should not turn a clear
 * "release" into a refusal the user cannot act on either.
 *
 * The fallback is deliberately narrow and REFUSES AMBIGUITY. If the text holds
 * more than one distinct release value, it returns null and the caller fails
 * closed. That matters: a brief containing an injected `"release": true` could
 * otherwise be echoed back inside `concerns` and outvote the model's real
 * decision. One value, or no answer.
 */
function readDecision(text) {
    const obj = providers.parseJson(text);
    if (obj && typeof obj.release === 'boolean') {
        return {
            release: obj.release,
            reason: String(obj.reason || '').slice(0, 500),
            concerns: Array.isArray(obj.concerns) ? obj.concerns.map(String).slice(0, 20) : []
        };
    }

    const found = [...String(text || '').matchAll(/"?release"?\s*:\s*(true|false)/gi)]
        .map(m => m[1].toLowerCase() === 'true');

    if (found.length === 0) return null;
    if (new Set(found).size > 1) return null;      // contradictory: treat as no answer

    const reason = String(text).match(/"?reason"?\s*:\s*"([^"]{0,300})/i);
    return {
        release: found[0],
        reason: reason ? reason[1] : 'Read from a malformed gate answer.',
        concerns: []
    };
}

/**
 * Ask the local model whether a brief may cross.
 *
 * Fails CLOSED. A model that is unreachable, slow, or that answers with
 * something unparseable produces a refusal, not a release — the failure mode of
 * a privacy gate has to be "nothing left the machine".
 */
async function runGate(markdown, { model, config }) {
    const caps = await providers.capabilities(model).catch(() => []);

    try {
        const result = await providers.complete({
            model,
            messages: [
                { role: 'system', content: GATE_SYSTEM },
                { role: 'user', content: markdown }
            ],
            // Deterministic: the same brief should get the same ruling twice.
            config: { ...config, temperature: 0, top_p: 1 },
            // Reasoning costs ~3.7x wall clock here and the gate is a yes/no.
            ...(caps.includes('thinking') ? { think: false } : {})
        });

        const decision = readDecision(result.content);
        if (!decision) {
            return {
                release: false,
                reason: 'The gate did not return a decision that could be read, so nothing was sent.',
                concerns: [],
                model,
                unparsed: result.content.slice(0, 400)
            };
        }

        return { ...decision, model };
    } catch (err) {
        return {
            release: false,
            reason: `The gate could not be reached (${err.message}), so nothing was sent.`,
            concerns: [],
            model
        };
    }
}

module.exports = { GATE_SYSTEM, runGate, readDecision };
