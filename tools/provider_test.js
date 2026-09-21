'use strict';

/**
 * Provider contract tests.
 *
 * The point of this file is one specific regression. app.js renders the stats
 * line under every reply as:
 *
 *     eval_count / (eval_duration / 1e9)   ->  tok/s
 *
 * Ollama supplies eval_duration natively. OpenAI-compatible APIs do not supply
 * it at all, so providers/tokenfactory.js measures it. If that measurement is
 * ever dropped, nothing throws and no test fails on shape alone — the UI simply
 * shows "? tok/s" on remote replies and a real number on local ones, which is
 * exactly the sort of thing a judge notices in a demo video and a developer
 * never notices locally.
 *
 * So these tests do not merely check that fields exist. They compute the stats
 * line the way the client does and assert the result is a finite number.
 *
 * Local tier needs Ollama running. Remote tier needs NEBIUS_API_KEY; without it
 * the remote tests SKIP rather than fail, so the suite still runs on a machine
 * with no key. The remote call is deliberately tiny — a handful of tokens.
 */

try { process.loadEnvFile(); } catch { /* no .env; remote tests will skip */ }

const providers = require('../providers');
const ollama = require('../providers/ollama');
const tokenfactory = require('../providers/tokenfactory');

let pass = 0, fail = 0, skip = 0;

const ok = (cond, label) => {
    if (cond) { pass++; console.log('  ok   ' + label); }
    else { fail++; console.log('  FAIL ' + label); }
};
const skipped = label => { skip++; console.log('  skip ' + label); };

const CONFIG = { temperature: 0.7, top_p: 0.95, top_k: 64, num_ctx: 2048, keep_alive: '1m' };

/** Exactly what public/app.js does with the done chunk. */
function statsFrom(done, firstTokenMs) {
    const tps = done.eval_count && done.eval_duration
        ? Number((done.eval_count / (done.eval_duration / 1e9)).toFixed(1))
        : null;
    return { tps, prompt: done.prompt_eval_count, reply: done.eval_count, ttft: firstTokenMs };
}

async function drain(stream) {
    let content = '', thinking = '', done = null, firstTokenMs = null;
    const started = Date.now();
    for await (const chunk of stream) {
        if (chunk.message?.thinking) {
            if (firstTokenMs === null) firstTokenMs = Date.now() - started;
            thinking += chunk.message.thinking;
        }
        if (chunk.message?.content) {
            if (firstTokenMs === null) firstTokenMs = Date.now() - started;
            content += chunk.message.content;
        }
        if (chunk.done) done = chunk;
    }
    return { content, thinking, done, firstTokenMs };
}

// ─────────────────────── pure units, no network ───────────────────────

async function unitTests() {
    console.log('\nunit: <think> fence splitting across deltas');

    const a = tokenfactory.splitThink('<think>reasoning', false);
    ok(a[0].thinking === true && a[0].text === 'reasoning', 'opens a fence and marks it thinking');
    ok(a[a.length - 1].open === true, 'carries the open state to the next delta');

    const b = tokenfactory.splitThink('more</think>answer', true);
    ok(b[0].thinking === true && b[0].text === 'more', 'resumes an open fence');
    ok(b.some(p => !p.thinking && p.text === 'answer'), 'routes post-fence text to content');
    ok(b[b.length - 1].open === false, 'closes the fence');

    const c = tokenfactory.splitThink('plain', false);
    ok(c.length === 1 && !c[0].thinking && c[0].text === 'plain', 'passes unfenced text through');

    console.log('\nunit: message translation');

    const tool = tokenfactory.toOpenAIMessage({ role: 'tool', tool_name: 'list_dir', content: '{}' });
    ok(tool.tool_call_id === 'list_dir', 'tool results carry tool_call_id, not tool_name');

    const asst = tokenfactory.toOpenAIMessage({ role: 'assistant', content: 'hi', thinking: 'hmm' });
    ok(asst.thinking === undefined, 'strips the Ollama-only thinking field');

    const img = tokenfactory.toOpenAIMessage({ role: 'user', content: 'what is this', images: ['AAAA'] });
    ok(Array.isArray(img.content) && img.content[1].type === 'image_url',
       'images become OpenAI image_url parts');
    ok(img.content[1].image_url.url.startsWith('data:image'), 'bare base64 gets a data: prefix');

    console.log('\nunit: routing');
    ok(providers.providerFor('llama3.2:latest') === ollama, 'bare tags route local');
    // Tier is resolved, not inferred: it answers from the catalogues the registry has
    // actually read, so it has to be given the chance to read them. Before that every
    // model is 'unknown' — the honest answer, and the one that gets gated.
    await providers.ensureFresh().catch(() => {});
    ok(providers.tierOf('llama3.2:latest') === 'local',
       'and reports the local tier once the catalogue is resolved');
    ok(providers.tierOf('not-a-real-model-anywhere:1b') === 'unknown',
       'while a model in no catalogue is unknown, not local');

    await cloudTests();
    await residencyTests();
}

/**
 * Serve canned Ollama responses for the duration of `fn`. Everything else passes through,
 * so Token Factory calls made by a registry refresh behave as they normally would.
 */
async function withOllama(routes, fn) {
    const real = global.fetch;
    global.fetch = async (url, opts) => {
        const hit = Object.keys(routes).find(r => String(url).endsWith(r));
        if (!hit) return real(url, opts);
        return new Response(JSON.stringify(routes[hit]), {
            status: 200, headers: { 'Content-Type': 'application/json' }
        });
    };
    try { return await fn(); } finally { global.fetch = real; }
}

// ─────────────────────── Ollama cloud models ───────────────────────
//
// Ollama serves cloud models through its local API — `gemma4:cloud`,
// `nemotron-3-nano:30b-cloud` — listed in /api/tags beside real downloads and answered on
// ollama.com. The listing marks them with remote_host / remote_model (ListModelResponse in
// Ollama's api/types.go), and ollama.list() used to discard both, so the registry filed a
// cloud model as local: eligible to be the gate, and never gated.

async function cloudTests() {
    console.log('\nunit: Ollama cloud models are not local');

    const CLOUD = 'nemotron-3-nano:30b-cloud';
    const tags = {
        models: [
            { name: 'real-local:4b', size: 2.8e9, details: {} },
            { name: CLOUD, size: 380, details: {},
              remote_model: 'nemotron-3-nano:30b', remote_host: 'https://ollama.com:443' }
        ]
    };

    await withOllama({ '/api/tags': tags }, async () => {
        const listed = await ollama.list();
        const cloud = listed.find(m => m.id === CLOUD);
        ok(cloud && cloud.remote === true,
           'ollama.list() keeps the remote marker instead of dropping it');
        ok(listed.find(m => m.id === 'real-local:4b')?.remote === false,
           'and a downloaded model is not marked remote');

        await providers.refreshRegistry();
        ok(providers.tierOf(CLOUD) === 'remote', 'a cloud model is filed on the remote side');
        ok(!providers.isLocal(CLOUD), 'so it is not local');
        ok(!providers.localModels().some(m => m.id === CLOUD),
           'and is never offered as a local model');
        ok(providers.tierOf('real-local:4b') === 'local', 'while the downloaded one stays local');
    });

    // Put the real catalogue back before anything else reads it.
    await providers.refreshRegistry().catch(() => {});

    // ── the tripwire: a "local" model that answers from somewhere else ──
    //
    // The registry prevents this by reading the listing. This is what notices if
    // something gets past it — a model that became a cloud alias after the last read.
    const ALIAS = 'tripwire-test:1b';
    providers.registry._entries.set(ALIAS, { id: ALIAS, tier: 'local', source: 'local', size: 1 });
    const realChat = ollama.chat;
    ollama.chat = async function* () {
        yield { message: { content: 'hi' }, remote_host: 'https://ollama.com:443',
                remote_model: 'something:cloud', done: false };
    };
    let thrown = null;
    try {
        for await (const _ of providers.chat({ model: ALIAS, messages: [], config: {} })) { /* drain */ }
    } catch (err) { thrown = err; } finally {
        ollama.chat = realChat;
        providers.registry._entries.delete(ALIAS);
    }
    ok(thrown && thrown.name === 'ProviderError',
       'a local model answering from a remote host is refused mid-stream');
    ok(thrown && /ollama\.com/.test(thrown.message), 'and names the host it came from');

    await providers.refreshRegistry().catch(() => {});
}

// ─────────────────────── VRAM residency ───────────────────────
//
// Measured, not predicted: what /api/ps says about a model that is loaded.

async function residencyTests() {
    console.log('\nunit: VRAM residency is measured, not guessed');

    await withOllama({
        '/api/ps': {
            models: [
                { name: 'fits:4b', size: 3.08e9, size_vram: 3.08e9 },
                { name: 'spills:30b', size: 20e9, size_vram: 12.4e9 },
                { name: 'cpu-only:7b', size: 5e9, size_vram: 0 },
                { name: 'cloud:x', size: 400, size_vram: 0, remote_host: 'https://ollama.com:443' }
            ]
        }
    }, () => ollama.observeResidency());

    ok(ollama.residencyOf('fits:4b')?.gpu === 1, 'a model that fitted reads fully resident');
    ok(Math.abs(ollama.residencyOf('spills:30b')?.gpu - 0.62) < 0.001,
       'a model that spilled reads the fraction that fitted');
    ok(ollama.residencyOf('cpu-only:7b')?.gpu === 0, 'and one with nothing in VRAM reads zero');
    ok(ollama.residencyOf('cloud:x') === null,
       'a cloud model gets no reading, because nothing of it runs here');
    ok(ollama.residencyOf('never-loaded:1b') === null,
       'and a model that has never run says nothing rather than guessing');
}

// ─────────────────────── local tier ───────────────────────

async function localTests() {
    console.log('\nlocal tier (Ollama)');

    const models = await ollama.list().catch(() => []);
    if (!models.length) { skipped('Ollama not running or no models pulled'); return; }

    // Smallest installed model: this test is about the wire contract, not quality.
    const model = models.sort((a, b) => (a.size || 0) - (b.size || 0))[0].id;
    console.log('  using ' + model);

    const caps = await providers.capabilities(model);
    ok(Array.isArray(caps), 'capabilities() returns an array');

    const { content, done, firstTokenMs } = await drain(providers.chat({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
        config: CONFIG
    }));

    ok(content.length > 0, 'streamed some content');
    ok(done !== null, 'emitted a terminal done chunk');
    if (!done) return;

    const stats = statsFrom(done, firstTokenMs);
    ok(Number.isFinite(stats.prompt) && stats.prompt > 0, `prompt_eval_count is real (${stats.prompt})`);
    ok(Number.isFinite(stats.reply) && stats.reply > 0, `eval_count is real (${stats.reply})`);
    ok(Number.isFinite(done.eval_duration) && done.eval_duration > 0,
       `eval_duration is present and non-zero (${done.eval_duration}ns)`);
    ok(Number.isFinite(stats.tps) && stats.tps > 0, `stats line computes tok/s (${stats.tps})`);
}

// ─────────────────────── remote tier ───────────────────────

async function remoteTests() {
    console.log('\nremote tier (Nebius Token Factory)');

    if (!process.env.NEBIUS_API_KEY) {
        skipped('NEBIUS_API_KEY not set — copy .env.example to .env');
        return;
    }

    const model = process.env.AIRLOCK_MODEL_CLASSIFIER;
    if (!model) { skipped('AIRLOCK_MODEL_CLASSIFIER not set'); return; }
    console.log('  using ' + model);

    const models = await tokenfactory.list();
    ok(models.length > 0, `catalogue lists ${models.length} models`);
    ok(models.some(m => m.id === model), 'the configured classifier is in the catalogue');

    // Routing must be exact once the catalogue is known, not a slash heuristic.
    ok(providers.providerFor(model) === tokenfactory, 'configured model routes to the remote tier');
    await providers.ensureFresh().catch(() => {});
    ok(providers.tierOf(model) === 'remote', 'and reports the remote tier');
    ok(providers.providerFor('hf.co/user/some-model') === ollama,
       'a slashed Ollama tag does NOT route remote once the catalogue is known');

    const { content, done, firstTokenMs } = await drain(providers.chat({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
        config: CONFIG
    }));

    ok(content.length > 0, 'streamed some content');
    ok(done !== null, 'emitted a terminal done chunk');
    if (!done) return;

    const stats = statsFrom(done, firstTokenMs);
    ok(Number.isFinite(stats.prompt) && stats.prompt > 0, `prompt_eval_count is real (${stats.prompt})`);
    ok(Number.isFinite(stats.reply) && stats.reply > 0, `eval_count is real (${stats.reply})`);

    // The regression this whole file exists for.
    ok(Number.isFinite(done.eval_duration) && done.eval_duration > 0,
       `eval_duration was MEASURED, not passed through (${done.eval_duration}ns)`);
    ok(Number.isFinite(stats.tps) && stats.tps > 0,
       `stats line computes tok/s on the remote tier too (${stats.tps})`);
}

async function errorTests() {
    console.log('\nerrors');

    const saved = process.env.NEBIUS_API_KEY;
    delete process.env.NEBIUS_API_KEY;
    try {
        await drain(tokenfactory.chat({
            model: 'nvidia/whatever',
            messages: [{ role: 'user', content: 'hi' }],
            config: CONFIG
        }));
        ok(false, 'a missing key should throw');
    } catch (err) {
        ok(err.name === 'ProviderError', 'a missing key throws ProviderError');
        ok(err.status === 503, 'with a 503, so /api/chat can answer with a status');
        ok(err.tier === 'remote', 'tagged with the tier that failed');
        ok(/NEBIUS_API_KEY/.test(err.message), 'and says which variable is missing');
    } finally {
        if (saved !== undefined) process.env.NEBIUS_API_KEY = saved;
    }
}

(async () => {
    console.log('\nAirlock provider contract tests');
    await unitTests();
    await errorTests();
    await localTests();
    await remoteTests();

    console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped\n`);
    process.exit(fail ? 1 : 0);
})();
