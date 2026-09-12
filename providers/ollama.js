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

async function list() {
    const r = await fetch(`${OLLAMA}/api/tags`);
    if (!r.ok) return [];
    const { models = [] } = await r.json();
    return models.map(m => ({ id: m.name, tier, size: m.size }));
}

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

module.exports = { tier, owns, capabilities, list, version, chat };
