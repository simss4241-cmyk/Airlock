'use strict';

/**
 * The remote tier — Nebius Token Factory, OpenAI-compatible.
 *
 * Everything here is translation. Token Factory streams Server-Sent Events with
 * OpenAI's delta shape; app.js reads Ollama's NDJSON shape. This file is the
 * seam, and the fiddly part is usage:
 *
 *   Ollama     final chunk carries eval_count, prompt_eval_count, eval_duration(ns)
 *   OpenAI     a `usage` object with prompt_tokens/completion_tokens, and NO duration
 *
 * app.js computes tok/s as eval_count / (eval_duration / 1e9). With no duration
 * the stats line renders "? tok/s" on every remote reply while local ones show a
 * number — a regression visible in any demo video. So we measure it here.
 *
 * We time from the FIRST streamed token, not from the request, deliberately.
 * Ollama's eval_duration covers generation only; wall clock from the request
 * would fold in queueing and network latency and quietly understate the remote
 * tier against the local one. Time-to-first-token is measured separately by the
 * client for both tiers, so nothing is lost by excluding it here.
 */

const tier = 'remote';

const BASE = () => (process.env.NEBIUS_BASE_URL || 'https://api.tokenfactory.nebius.com/v1')
    .replace(/\/+$/, '');
const KEY = () => process.env.NEBIUS_API_KEY || '';

/**
 * Which ids belong to this tier.
 *
 * Populated by list() and then authoritative. The namespace heuristic below is
 * only a cold-start fallback, and it is not sufficient on its own: Ollama tags
 * can contain a slash too (`hf.co/user/model`), and such a model would route
 * here and fail. Once the catalogue has been fetched once — which /api/health
 * does on load — membership is an exact lookup.
 */
const knownIds = new Set();

const owns = model => {
    if (typeof model !== 'string') return false;
    if (knownIds.size) return knownIds.has(model);
    return model.includes('/');            // cold start, before the catalogue is known
};

/**
 * Declared, not discovered: GET /v1/models returns only {id, created, object,
 * owned_by} — no capability metadata — so there is nothing to read.
 *
 * Both entries are verified against a real call, not assumed. Nemotron 3 Nano
 * answering "name one metal" produced 855 characters of reasoning and a
 * two-character answer, so 'thinking' is real and the pane renders it.
 *
 * Caveat worth knowing: the ◈ toggle sets Ollama's `think` flag, which has no
 * OpenAI equivalent. The remote tier reasons whether or not the toggle is on,
 * so turning it off does not save remote tokens — and reasoning tokens are
 * billed (that same call cost 218 completion tokens for a one-word answer).
 * Binding the toggle to a remote equivalent is Phase 2 work.
 */
const REMOTE_CAPS = ['tools', 'thinking'];

async function capabilities() {
    return KEY() ? REMOTE_CAPS : [];
}

async function list() {
    if (!KEY()) return [];                       // no key: the remote tier simply isn't there
    const r = await fetch(`${BASE()}/models`, {
        headers: { Authorization: `Bearer ${KEY()}` }
    });
    if (!r.ok) return [];
    const { data = [] } = await r.json();
    for (const m of data) knownIds.add(m.id);      // owns() becomes exact from here on
    return data.map(m => ({ id: m.id, tier }));
}

/** OpenAI streams arguments as string fragments across deltas; Ollama sends them whole. */
function collectToolCalls(acc, deltas) {
    for (const d of deltas) {
        const i = d.index ?? 0;
        const slot = acc[i] || (acc[i] = { id: d.id, function: { name: '', arguments: '' } });
        if (d.id) slot.id = d.id;
        if (d.function?.name) slot.function.name += d.function.name;
        if (d.function?.arguments) slot.function.arguments += d.function.arguments;
    }
}

/**
 * Splits a content fragment around <think> fences. Returns pieces tagged as
 * thinking or not, carrying the open/closed state forward — a fence can land
 * anywhere, including split across two deltas.
 */
function splitThink(text, open) {
    const out = [];
    let rest = text;

    while (rest) {
        if (open) {
            const end = rest.indexOf('</think>');
            if (end === -1) { out.push({ text: rest, thinking: true, open: true }); break; }
            out.push({ text: rest.slice(0, end), thinking: true, open: false });
            rest = rest.slice(end + '</think>'.length);
            open = false;
        } else {
            const start = rest.indexOf('<think>');
            if (start === -1) { out.push({ text: rest, thinking: false, open: false }); break; }
            if (start > 0) out.push({ text: rest.slice(0, start), thinking: false, open: false });
            rest = rest.slice(start + '<think>'.length);
            open = true;
        }
    }
    return out;
}

/** Ollama's tool results use {role:'tool', tool_name}; OpenAI wants tool_call_id. */
function toOpenAIMessage(m) {
    if (m.role === 'tool') {
        return { role: 'tool', tool_call_id: m.tool_call_id || m.tool_name, content: m.content };
    }
    if (m.images?.length) {
        return {
            role: m.role,
            content: [
                { type: 'text', text: m.content || '' },
                ...m.images.map(b64 => ({
                    type: 'image_url',
                    image_url: { url: b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}` }
                }))
            ]
        };
    }
    const { thinking, images, ...rest } = m;   // `thinking` is an Ollama-only field
    return rest;
}

async function* chat({ model, messages, config, tools, signal }) {
    const { ProviderError } = require('./index');

    if (!KEY()) {
        throw new ProviderError(
            'No NEBIUS_API_KEY. Copy .env.example to .env and add your Token Factory key.',
            503, tier);
    }

    const payload = {
        model,
        messages: messages.map(toOpenAIMessage),
        stream: true,
        // Without this the final chunk carries no usage at all and the token
        // counter silently reads zero for the whole remote turn.
        stream_options: { include_usage: true },
        temperature: config.temperature,
        top_p: config.top_p
        // top_k and num_ctx are deliberately not sent. They are local-tier
        // concepts: num_ctx is the server's KV budget, and top_k is not in the
        // OpenAI schema, so a strict endpoint may reject the whole request.
    };
    if (tools) payload.tools = tools;

    const res = await fetch(`${BASE()}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${KEY()}`
        },
        body: JSON.stringify(payload),
        signal
    });

    if (!res.ok) {
        const text = await res.text();
        let msg = text;
        try { msg = JSON.parse(text).error?.message || text; } catch { /* not JSON */ }
        throw new ProviderError(msg || `Token Factory returned ${res.status}`, res.status, tier);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    let usage = null;
    const toolAcc = [];
    let genStart = null;        // set on the first token, not on the request
    let finishedAt = null;
    let thinkOpen = false;      // inside a <think> fence in the content channel

    const startClock = () => { if (genStart === null) genStart = process.hrtime.bigint(); };

    outer:
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const raw of lines) {
            const line = raw.trim();
            if (!line || line.startsWith(':')) continue;      // heartbeat / comment
            if (!line.startsWith('data:')) continue;

            const data = line.slice(5).trim();
            if (data === '[DONE]') { finishedAt = process.hrtime.bigint(); break outer; }

            let chunk;
            try { chunk = JSON.parse(data); } catch { continue; }

            // Usage arrives on its own final chunk, with choices empty.
            if (chunk.usage) usage = chunk.usage;

            const delta = chunk.choices?.[0]?.delta;
            if (!delta) continue;

            // Some reasoning models expose a dedicated channel; map it straight across.
            const reasoning = delta.reasoning_content ?? delta.reasoning;
            if (reasoning) {
                startClock();
                yield { message: { thinking: reasoning } };
            }

            if (delta.tool_calls?.length) collectToolCalls(toolAcc, delta.tool_calls);

            if (delta.content) {
                startClock();
                // Others fence reasoning inline as <think>…</think>. Route it to the
                // same pane rather than letting it land in the answer body.
                for (const piece of splitThink(delta.content, thinkOpen)) {
                    thinkOpen = piece.open;
                    if (!piece.text) continue;
                    yield piece.thinking
                        ? { message: { thinking: piece.text } }
                        : { message: { content: piece.text } };
                }
            }
        }
    }

    if (finishedAt === null) finishedAt = process.hrtime.bigint();

    if (toolAcc.length) {
        yield { message: { tool_calls: toolAcc.filter(Boolean) } };
    }

    // eval_duration is nanoseconds because that is what app.js divides by 1e9.
    const evalDuration = genStart === null ? 0 : Number(finishedAt - genStart);

    yield {
        done: true,
        model,
        eval_count: usage?.completion_tokens ?? 0,
        prompt_eval_count: usage?.prompt_tokens ?? 0,
        eval_duration: evalDuration
    };
}

module.exports = { tier, owns, capabilities, list, chat, splitThink, toOpenAIMessage, knownIds };
