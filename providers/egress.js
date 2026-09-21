'use strict';

/**
 * ─────────────────────────── Egress ───────────────────────────
 *
 * The only file in server-side code allowed to call fetch. tools/kernel_test.js fails
 * the build on any other call site, because a kernel only guards the doors it stands
 * in front of, and a raw fetch is a door.
 *
 * Three kinds of connection, and each says what it is:
 *
 *   local(url, init, { model, clearance })
 *       To this machine's Ollama and nowhere else — the URL is checked. Usually free.
 *       ⚠ Not always: Ollama forwards cloud models (`gemma4:cloud`) to ollama.com
 *       through this same local port. So a request that NAMES a model is held to that
 *       model's tier, and a cloud model needs a clearance here exactly as Token Factory
 *       does. The port is local; the destination is not.
 *
 *   catalogue(url, init)
 *       A remote request that carries no user content — listing models. It sends the
 *       API key and nothing of yours, and the kernel has nothing to rule on. A body on
 *       one of these is refused, so the name cannot become a loophole.
 *
 *   remote(url, init, { model, clearance })
 *       Anything that carries content off the machine. Refused unless the kernel issued
 *       `clearance` for this model.
 *
 * This is the second lock. providers.chat() is the first: it will not hand a request to
 * a provider without a clearance, and it runs the gate itself if the caller did not.
 * This file exists so that a provider path which somehow skipped that step still cannot
 * reach the network.
 */

const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

class EgressRefused extends Error {
    constructor(message) {
        super(message);
        this.name = 'EgressRefused';
        this.status = 403;
    }
}

// Lazy: kernel.js requires providers/index.js, which requires the providers, which
// require this file. Resolving at call time keeps the cycle out of module load.
const kernel = () => require('../kernel');
const tierOf = model => require('./registry').tierOf(model);

function local(url, init = {}, { model = null, clearance = null } = {}) {
    if (!String(url).startsWith(OLLAMA)) {
        throw new EgressRefused(`local() is for ${OLLAMA} only, not ${url}.`);
    }
    if (model && tierOf(model) !== 'local' && !kernel().isIssuedFor(clearance, model)) {
        throw new EgressRefused(
            `${model} is not on this side of the boundary — Ollama would forward it — and `
            + 'no clearance was issued for it. Nothing was sent.');
    }
    return fetch(url, init);
}

function catalogue(url, init = {}) {
    if (init.body != null) {
        throw new EgressRefused('A catalogue request carries no body. Content goes through remote().');
    }
    return fetch(url, init);
}

function remote(url, init = {}, { model, clearance } = {}) {
    if (!kernel().isIssuedFor(clearance, model)) {
        throw new EgressRefused(
            `No clearance was issued for sending to ${model || 'this model'}, so nothing was sent.`);
    }
    return fetch(url, init);
}

module.exports = { OLLAMA, local, catalogue, remote, EgressRefused };
