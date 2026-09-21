'use strict';

/**
 * The local tier.
 *
 * Speaks Ollama's native /api/chat NDJSON and yields those chunks through
 * unchanged — Airlock's contract IS this shape, so the proven path needs no
 * translation and cannot drift.
 */

const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

const tier = 'local';

// Ollama owns anything no remote provider claimed. It is the fallback, so this
// is deliberately permissive; the registry only reaches it last.
const owns = () => true;

const capsCache = new Map();

async function capabilities(model) {
    if (capsCache.has(model)) return capsCache.get(model);

    let caps = [];
    try {
        const r = await fetch(`${OLLAMA}/api/show`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model })
        });
        if (r.ok) caps = (await r.json()).capabilities || [];
    } catch { /* Ollama down; treat as no capabilities and send neither flag */ }

    capsCache.set(model, caps);
    return caps;
}

/**
 * Everything this Ollama will answer for — which is NOT the same as everything it runs.
 *
 * ⚠ Ollama serves cloud models through the same local API (`gemma4:cloud`,
 * `nemotron-3-nano:30b-cloud`). They sit in /api/tags beside real downloads, but the
 * prompt is forwarded to ollama.com and answered there. The only difference in the
 * listing is `remote_host` / `remote_model` (ListModelResponse in Ollama's
 * api/types.go), and this function used to drop both on the floor — so the registry
 * filed a cloud model under 'local' and the gate could have been one.
 *
 * `remote` is carried out rather than decided here: which side of the boundary a model
 * is on is registry.js's call, and it needs the evidence to make it.
 */
async function list() {
    const r = await fetch(`${OLLAMA}/api/tags`);
    if (!r.ok) return [];
    const { models = [] } = await r.json();
    return models.map(m => ({
        id: m.name,
        tier,
        size: m.size,
        remote: Boolean(m.remote_host || m.remote_model),
        remoteHost: m.remote_host || null
    }));
}

/**
 * How much of each model actually sat in VRAM the last time it was loaded here.
 *
 * Measured, not predicted. There is no portable way to learn free VRAM before a load —
 * nvidia-smi is one vendor's tool, and Apple, AMD and CPU-only machines each have
 * their own — but Ollama reports what happened: /api/ps gives `size` and `size_vram`
 * for every loaded model, and when a model does not fit, size_vram comes up short and
 * the remainder runs on CPU. That is a fact about THIS machine, it corrects itself
 * after a hardware upgrade, and it needs no dependency.
 *
 * ⚠ It depends on the settings it ran with as well as the hardware: /api/ps counts the
 * KV cache, so a model resident at num_ctx 4096 can spill at 32768. The reading means
 * "last time, as configured then", and the picker says so.
 */
const residency = new Map();          // id -> { gpu: 0..1, size, sizeVram, at }

async function observeResidency() {
    const r = await fetch(`${OLLAMA}/api/ps`);
    if (!r.ok) return;
    const { models = [] } = await r.json();
    for (const m of models) {
        // A cloud model has no local weights to measure, and a reading for it would
        // imply that it runs here.
        if (m.remote_host || m.remote_model || !m.size) continue;
        residency.set(m.name, {
            gpu: Math.min(1, (m.size_vram || 0) / m.size),
            size: m.size,
            sizeVram: m.size_vram || 0,
            at: Date.now()
        });
    }
}

const residencyOf = id => residency.get(id) || null;

async function version() {
    try {
        const r = await fetch(`${OLLAMA}/api/version`);
        return r.ok ? (await r.json()).version : null;
    } catch { return null; }
}

async function* chat({ model, messages, config, think, tools, signal }) {
    const { ProviderError } = require('./index');

    const payload = {
        model,
        messages,
        stream: true,
        // Omitted entirely when unsupported — sending `false` is still a request
        // to a model that has no thinking channel.
        ...(think !== undefined ? { think } : {}),
        keep_alive: config.keep_alive,
        options: {
            temperature: config.temperature,
            top_p: config.top_p,
            top_k: config.top_k,
            num_ctx: config.num_ctx
        }
    };
    if (tools) payload.tools = tools;

    const res = await fetch(`${OLLAMA}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal
    });

    if (!res.ok) {
        const text = await res.text();
        throw new ProviderError(text || `Ollama returned ${res.status}`, res.status, tier);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
            if (!line.trim()) continue;
            try { yield JSON.parse(line); } catch { /* partial or noise */ }
        }
    }
}

module.exports = { tier, owns, capabilities, list, version, chat, observeResidency, residencyOf };
