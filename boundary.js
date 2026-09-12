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

        const decision = providers.parseJson(result.content);
        if (!decision || typeof decision.release !== 'boolean') {
            return {
                release: false,
                reason: 'The gate did not return a decision that could be read, so nothing was sent.',
                concerns: [],
                model,
                unparsed: result.content.slice(0, 400)
            };
        }

        return {
            release: decision.release,
            reason: String(decision.reason || '').slice(0, 500),
            concerns: Array.isArray(decision.concerns) ? decision.concerns.map(String).slice(0, 20) : [],
            model
        };
    } catch (err) {
        return {
            release: false,
            reason: `The gate could not be reached (${err.message}), so nothing was sent.`,
            concerns: [],
            model
        };
    }
}

module.exports = { GATE_SYSTEM, runGate };
