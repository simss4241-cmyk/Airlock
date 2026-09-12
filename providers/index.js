'use strict';

/**
 * ─────────────────────────── Airlock's stream contract ───────────────────────────
 *
 * A provider is an async generator that turns a chat request into a stream of
 * chunks. Every provider yields the SAME shape, so `/api/chat` never branches on
 * where a model runs.
 *
 * That shape is Ollama's native chunk format. Not because it is a good neutral
 * format — it is not, it carries nanosecond durations and a vendor's field names
 * — but because `public/app.js` already speaks it, is proven against it, and
 * reads the stats line straight out of it:
 *
 *     chunk.message.content          incremental answer text
 *     chunk.message.thinking         incremental reasoning, rendered in its own pane
 *     chunk.message.tool_calls[]     { function: { name, arguments } }
 *     chunk.done                     terminal marker
 *     chunk.eval_count               tokens generated
 *     chunk.prompt_eval_count        tokens in the prompt
 *     chunk.eval_duration            generation time in NANOSECONDS
 *
 * app.js computes tok/s as `eval_count / (eval_duration / 1e9)`. A remote
 * provider that omits eval_duration does not error — it silently renders "? tok/s"
 * under every remote reply while the local ones show a number. That is the
 * regression this file exists to prevent, so eval_duration is mandatory, and
 * a provider that cannot get one from its API must measure it.
 *
 * Adapting a new provider to this contract is strictly less risky than changing
 * both ends of a working stream. When the remote tier is settled, a neutral
 * internal format is a reasonable cleanup — but not while it would put the
 * proven local path at risk.
 */

const ollama = require('./ollama');
const tokenfactory = require('./tokenfactory');

// Providers in priority order. `owns(model)` decides; first match wins, and
// Ollama is last because it is the fallback for any bare model name.
const PROVIDERS = [tokenfactory, ollama];

function providerFor(model) {
    return PROVIDERS.find(p => p.owns(model)) || ollama;
}

/** Which tier a model sits on. The audit trail records this, not the provider name. */
function tierOf(model) {
    return providerFor(model).tier;
}

/**
 * Capabilities the model actually advertises: 'thinking', 'tools', 'vision'.
 * Sending `think` to a model without a thinking channel is a hard 400, so this
 * gate is load-bearing rather than cosmetic.
 */
async function capabilities(model) {
    return providerFor(model).capabilities(model);
}

/** Async generator of contract chunks. Throws ProviderError on an upstream refusal. */
function chat(opts) {
    return providerFor(opts.model).chat(opts);
}

/** Models this install can reach right now, local and remote, for the dropdown. */
async function list() {
    const lists = await Promise.all(PROVIDERS.map(p => p.list().catch(() => [])));
    return lists.flat();
}

class ProviderError extends Error {
    constructor(message, status, tier) {
        super(message);
        this.name = 'ProviderError';
        this.status = status;
        this.tier = tier;
    }
}

module.exports = { chat, capabilities, list, tierOf, providerFor, ProviderError };
