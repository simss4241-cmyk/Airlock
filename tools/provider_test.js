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

function unitTests() {
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
    ok(providers.tierOf('llama3.2:latest') === 'local', 'and report the local tier');
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
    unitTests();
    await errorTests();
    await localTests();
    await remoteTests();

    console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped\n`);
    process.exit(fail ? 1 : 0);
})();
