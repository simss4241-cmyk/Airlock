'use strict';

/**
 * ─────────────────────────── Where each model actually is ───────────────────────────
 *
 * Which side of the boundary a model sits on is the one fact this whole application
 * rests on. It decides whether the gate runs, what the audit trail records, and which
 * chip a duet pane shows. It should therefore be a fact — something read off a
 * catalogue that a provider actually answered with — and not an inference from the
 * shape of a string.
 *
 * It used to be an inference. `tierOf()` asked `providerFor()`, which asked each
 * provider's `owns()` in turn; Token Factory's was exact only after its catalogue had
 * been fetched (a side effect of /api/health) and guessed on `id.includes('/')` before
 * that, and Ollama's returns true for everything because it is the fallback. So an id
 * nobody recognised came back 'local':
 *
 *     > providers.tierOf('not-a-real-model-anywhere:1b')
 *     'local'
 *
 * Fail-open, in the decision that gates every crossing.
 *
 * ⚠ 'local' does NOT mean "on your laptop". It means inside this deployment's trust
 * boundary — the machine Airlock is running on. On a desk that is Ollama; on a hosted
 * instance it is whatever serves models beside the server. The invariant is the same in
 * both cases and is the only one that matters: the gate never sends content across the
 * boundary it is guarding. Deployment changes what is inside; it does not change the
 * rule.
 *
 * ⚠ Membership is deliberately positive-only. A model is local because a local
 * catalogue named it, never because no remote catalogue did. Absence is 'unknown', and
 * every caller that can gate, refuse or record must treat 'unknown' as "not local" —
 * see the call sites listed in tierOf() below.
 *
 * Routing is a separate question and still belongs to `owns()`: which provider to CALL
 * is a guess we can afford to get wrong (the call simply fails), while which side of
 * the boundary a model is on is a guess we cannot.
 */

const ollama = require('./ollama');
const tokenfactory = require('./tokenfactory');

/**
 * How long a resolved catalogue is trusted before it is refetched.
 *
 * Short enough that `ollama pull` shows up without a restart, long enough that a gate
 * ruling does not pay for a catalogue round trip on every message.
 */
const TTL_MS = 60_000;

/** id -> { id, tier, size }. The tier comes from whichever catalogue produced the id. */
const entries = new Map();

const sources = {
    local: { ok: false, at: 0 },
    remote: { ok: false, at: 0 }
};

let resolvedAt = 0;
let inFlight = null;

/**
 * Refetch both catalogues.
 *
 * A source that fails keeps its previous entries rather than dropping them. The
 * alternative — clearing on every blip — would make a one-second Ollama hiccup turn
 * every model 'unknown' and every crossing refused, which is fail-closed but useless.
 * The stale window is bounded and safe: the worst case is that the gate picks a model
 * that was uninstalled moments ago, the call fails, and runGate refuses on the error.
 */
async function refresh() {
    const [local, remote] = await Promise.all([
        ollama.list().then(r => ({ ok: true, list: r })).catch(() => ({ ok: false, list: [] })),
        tokenfactory.list().then(r => ({ ok: true, list: r })).catch(() => ({ ok: false, list: [] }))
    ]);

    const now = Date.now();

    // Each entry remembers which catalogue produced it, so a refresh of one source never
    // clears the other's — tier alone is no longer enough to tell, because Ollama's
    // catalogue now contributes to both sides.
    for (const [source, res] of [['local', local], ['remote', remote]]) {
        sources[source].ok = res.ok;
        if (!res.ok) continue;

        sources[source].at = now;
        for (const [id, e] of entries) if (e.source === source) entries.delete(id);

        for (const m of res.list) {
            // ⚠ An Ollama cloud model is listed by the local Ollama but answered on
            // ollama.com. It is on the far side of the boundary however it got into
            // the list, so it is filed there — never eligible to gate, and always gated.
            const tier = source === 'remote' || m.remote ? 'remote' : 'local';
            entries.set(m.id, {
                id: m.id, tier, source,
                size: m.size ?? null,
                ...(m.remote ? { via: 'ollama-cloud', remoteHost: m.remoteHost } : {})
            });
        }
    }

    // An empty remote catalogue is the normal state with no Nebius key, not a failure,
    // and `list()` already returns [] for that. Either way the loop above recorded it.
    resolvedAt = now;
    return entries.size;
}

/**
 * Resolve if the catalogue has never been read or has gone stale.
 *
 * Concurrent callers share one fetch: a burst of duet sends on a cold process would
 * otherwise each open their own pair of catalogue requests.
 */
async function ensureFresh() {
    if (resolvedAt && Date.now() - resolvedAt < TTL_MS) return;
    if (inFlight) return inFlight;
    inFlight = refresh().finally(() => { inFlight = null; });
    return inFlight;
}

/** True once a catalogue has been read at all. Before that everything is 'unknown'. */
const isResolved = () => resolvedAt > 0;

/**
 * Which side of the boundary a model is on: 'local', 'remote', or 'unknown'.
 *
 * ⚠ 'unknown' is a real answer, not an error, and it is never a synonym for 'local'.
 * Callers that decide whether to gate must ask `!== 'local'`, never `=== 'remote'`,
 * or an unrecognised model skips the gate entirely.
 */
function tierOf(model) {
    if (typeof model !== 'string' || !model) return 'unknown';
    return entries.get(model)?.tier ?? 'unknown';
}

/** Strict: true only if a local catalogue actually named this model. */
const isLocal = model => tierOf(model) === 'local';

/** Every model on this side of the boundary, largest first. */
function localModels() {
    return [...entries.values()]
        .filter(e => e.tier === 'local')
        .sort((a, b) => (b.size || 0) - (a.size || 0));
}

module.exports = {
    refresh, ensureFresh, isResolved, tierOf, isLocal, localModels,
    TTL_MS,
    _entries: entries          // tests reach in to simulate a cold or partial catalogue
};
