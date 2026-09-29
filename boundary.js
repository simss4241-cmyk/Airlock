'use strict';

const providers = require('./providers');
const secrets = require('./secrets');

// ─────────────────────── The boundary ───────────────────────
//
// Escalation crosses a line, so something has to decide whether it may. That
// decision is made by a model on THIS side of the line, always, and this is the
// one piece of the design that is not negotiable.
//
// The obvious alternative — let Nemotron Nano judge the brief, since it is fast
// and cheap — cannot work. To let a model on the far side rule on whether content
// may leave, you must first send it the content. The gate would be standing on the
// wrong side of the door it is guarding. A remote gate cannot gate remoteness.
//
// ⚠ "This side" is the deployment's trust boundary, not a particular laptop. On a
// desk it is Ollama; on a hosted instance it is whatever serves models beside the
// server. What never changes is the rule — the gate does not send content across
// the boundary it is guarding — and that rule is what makes both deployments
// honest rather than one of them a compromise. providers/registry.js decides which
// models are inside, from catalogues rather than from the shape of an id, because
// a boundary that rests on a naming convention is not a boundary.
//
// So the gatekeeper runs inside what it is protecting, and the remote tier keeps
// the job it is actually good at: reasoning about what the gate released.

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
 * Which model rules on a crossing. It must be a LOCAL one.
 *
 * The block above is not decoration: to let a remote model judge whether content may
 * leave, you must first send it the content, so the gate would stand on the wrong side of
 * the door it is guarding.
 *
 * ⚠ This function exists because every call site used to pass `config.model` straight in,
 * and `pickDefaultModel()` returns a Nemotron id whenever NEBIUS_API_KEY is set. On a
 * configured machine the gate was therefore running *remotely* — the one thing this file
 * says must never happen — and nothing failed loudly, because a remote model answers the
 * gate prompt perfectly well. It just answers it after the content has already crossed.
 *
 * Returns null when no local model is reachable at all. runGate fails closed on null:
 * a gate that cannot run is a gate that did not release.
 */
async function resolveGateModel(config = {}) {
    // The registry, not a bare Ollama call: one resolved answer to "what is on this side
    // of the boundary", shared with tierOf so the gate and the audit trail cannot end up
    // disagreeing about the same model.
    await providers.ensureFresh().catch(() => {});
    const local = providers.localModels();
    const isLocal = id => providers.isLocal(id);

    // An explicit choice wins, because the right gate model is a judgement about this
    // machine that no heuristic here can make. Ignored if it is not actually local —
    // the whole point of this function is that the gate cannot run across the boundary.
    const named = (process.env.AIRLOCK_GATE_MODEL || '').trim();
    if (named && isLocal(named)) return named;

    // Positive membership, not "did not look remote". A model is eligible to gate
    // because a local catalogue named it, never because nothing else claimed it.
    if (config.model && isLocal(config.model)) return config.model;

    if (!local.length) return null;

    // ⚠ The SMALLEST model that clears the floor, not the largest.
    //
    // This used to take the biggest local model, copying pickDefaultModel's reasoning
    // while doing a different job. That function picks the model that has to be GOOD.
    // This one picks the model that has to be FAST and has to FIT, because the gate is a
    // short structured yes/no standing between the user and their first remote reply —
    // and because a gate that stalls or times out fails closed, which reaches the user
    // as the gate refusing a harmless message. The failure is silent and looks like a
    // malfunction, so the default has to be the conservative one.
    //
    // Measured on the desk this was written on (RTX 5060 Ti, 16 GB): the largest-first
    // rule chose an 18 GB 30B that does not fit, ran at 8.5 tok/s when it survived at
    // all, and crashed CUDA for lack of VRAM headroom otherwise. Nemotron Nano 4B —
    // 2.8 GB, fully resident — answers the same prompt at 117 tok/s. Most machines
    // running this have less headroom than that one, not more.
    //
    // The floor keeps a 0.5B toy from being handed a judgement it cannot make. Below it,
    // there is nothing better available, so the smallest model is still the best answer.
    const FLOOR_BYTES = 1.5e9;
    const sized = local.filter(m => m.size);
    const eligible = sized.filter(m => m.size >= FLOOR_BYTES);
    const pool = (eligible.length ? eligible : sized.length ? sized : local);

    // localModels() is largest-first, so the last entry is the smallest that qualifies.
    return pool[pool.length - 1].id;
}

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
 * Fails CLOSED. A model that is unreachable, slow, or that answers with something
 * unparseable produces a refusal, not a release — the failure mode of a privacy gate has
 * to be "nothing left the machine".
 *
 * `model` is optional and is checked rather than trusted. Omit it and a local model is
 * resolved here; pass a remote one and the gate REFUSES instead of quietly running the
 * judgement on the far side of the boundary. Defending this inside runGate rather than at
 * the call sites is deliberate: there were three call sites and all three had it wrong,
 * so the guarantee belongs where it cannot be forgotten.
 */
async function runGate(markdown, { model, config } = {}) {
    // Known credential formats first, and without a model. See secrets.js: the scanner can
    // only withhold, so running it ahead of everything else can never let something
    // through that the model would have stopped — it only stops, for certain and in
    // microseconds, the things a small gate model was measured letting past.
    const scanned = secrets.rule(markdown);
    if (scanned) return scanned;

    // Resolve before ruling. A cold registry answers 'unknown' to everything, which the
    // check below would read as "not local" and refuse — fail-closed, but it would
    // refuse every crossing on a freshly started process rather than only the wrong ones.
    await providers.ensureFresh().catch(() => {});

    const namedTier = model ? providers.tierOf(model) : null;

    if (model && namedTier !== 'local') {
        return {
            release: false,
            reason: namedTier === 'remote'
                ? `${model} is on the remote tier and cannot gate a crossing — `
                    + 'judging whether content may leave would require sending it first.'
                : `${model} is not a model on this side of the boundary, so it cannot `
                    + 'rule on a crossing. Nothing was sent.',
            concerns: [],
            model
        };
    }

    if (!model) model = await resolveGateModel(config);

    if (!model) {
        return {
            release: false,
            reason: 'No local model is reachable to rule on this crossing, so nothing was sent.',
            concerns: [],
            model: null
        };
    }

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

module.exports = { GATE_SYSTEM, runGate, readDecision, resolveGateModel };
