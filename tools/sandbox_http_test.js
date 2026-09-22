'use strict';

/**
 * Per-visitor sandboxes over HTTP.  node tools/sandbox_http_test.js
 *
 * A server in sandbox mode, driven by separate cookie jars as separate visitors. The
 * assertions are about what one visitor can reach of another's — and about the ways
 * around that: a forged sandbox id, a cookie shaped like a path, and asking for another
 * visitor's records by number, since every sandbox starts counting from 1.
 *
 * Starts its own servers on scratch directories; needs Ollama only to seat duet
 * participants, and never reaches a remote model.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airlock-sandbox-http-'));

let pass = 0, fail = 0;
const ok = (cond, label, detail = '') => {
    if (cond) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
};

let nextPort = 8170;
async function serve(env = {}) {
    const port = nextPort++;
    const dir = path.join(tmp, `sb-${port}`);
    const child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(port),
            AIRLOCK_SANDBOXES: '1',
            AIRLOCK_SANDBOX_DIR: dir,
            AIRLOCK_DB: path.join(tmp, `unused-${port}.db`),
            AIRLOCK_CONFIG: path.join(tmp, `config-${port}.json`),
            NEBIUS_API_KEY: '',                 // nothing here should reach a remote tier
            AIRLOCK_TOKEN: '', AIRLOCK_DEMO: '', AIRLOCK_WORKSPACE_ROOTS: '',
            ...env
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    child.stdout.on('data', d => log += d);
    child.stderr.on('data', d => log += d);
    for (let i = 0; i < 80; i++) {
        if (child.exitCode !== null) throw new Error(`server exited early:\n${log}`);
        try { if ((await fetch(`http://127.0.0.1:${port}/api/whoami`)).ok) break; } catch { /* not yet */ }
        await new Promise(r => setTimeout(r, 250));
    }
    const stop = async () => {
        if (child.exitCode === null) { child.kill(); await new Promise(r => child.once('exit', r)); }
    };
    return { port, dir, stop, log: () => log };
}

/** A visitor: a cookie jar and a fetch that carries it. */
function visitor(server, cookie = null) {
    const v = {
        cookie,
        minted: [],
        async api(method, route, body) {
            const res = await fetch(`http://127.0.0.1:${server.port}${route}`, {
                method,
                headers: {
                    ...(body ? { 'Content-Type': 'application/json' } : {}),
                    ...(v.cookie ? { Cookie: v.cookie } : {})
                },
                body: body ? JSON.stringify(body) : undefined
            });
            const set = res.headers.getSetCookie?.() || [];
            const ours = set.find(c => c.startsWith('airlock_sandbox='));
            if (ours) { v.cookie = ours.split(';')[0]; v.minted.push(ours); }
            const text = await res.text();
            try { return { status: res.status, body: JSON.parse(text), text, setCookie: ours }; }
            catch { return { status: res.status, body: null, text, setCookie: ours }; }
        }
    };
    return v;
}

const idOf = cookie => (cookie || '').split('=')[1]?.split(';')[0] || null;
const filesIn = dir => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
const sandboxFiles = dir => filesIn(dir).filter(f => !f.startsWith('_index'));

async function isolation() {
    console.log('\ntwo visitors, two sandboxes');
    const s = await serve();
    try {
        // Probes do not make sandboxes.
        const probe = await fetch(`http://127.0.0.1:${s.port}/api/whoami`);
        ok(!(probe.headers.getSetCookie?.() || []).some(c => c.startsWith('airlock_sandbox=')),
           '/api/whoami is served without minting a sandbox');

        const A = visitor(s);
        const first = await A.api('GET', '/api/tree');
        ok(first.status === 200 && /^airlock_sandbox=[a-f0-9]{32}; Path=\/; HttpOnly; SameSite=Lax/.test(first.setCookie || ''),
           'a first visit gets a sandbox cookie: random id, HttpOnly, SameSite=Lax', first.setCookie);
        ok(first.body?.[0]?.threads?.[0]?.title === 'First thread', 'seeded like a fresh install');

        const MARK = 'visitor-A-only-9d27';
        const tray = first.body[0].id;
        const thread = (await A.api('POST', '/api/threads', { folderId: tray, title: MARK })).body;
        await A.api('POST', '/api/packets', { threadId: thread.id, role: 'user', content: `private: ${MARK}` });
        const again = await A.api('GET', '/api/tree');
        ok(JSON.stringify(again.body).includes(MARK), 'A sees its own thread on the next request');
        ok(!again.setCookie, 'without being issued a new sandbox');

        const B = visitor(s);
        const bTree = await B.api('GET', '/api/tree');
        ok(idOf(B.cookie) && idOf(B.cookie) !== idOf(A.cookie), 'B gets a different sandbox');
        ok(!bTree.text.includes(MARK), "B's tree does not contain A's thread");
        // Every negative below has its positive twin: the same request, made by A, finds the
        // marker. Without that, a missing route or an empty result would pass as isolation.
        const aSearch = await A.api('GET', `/api/search?q=${MARK}`);
        const bSearch = await B.api('GET', `/api/search?q=${MARK}`);
        ok(aSearch.text.includes(MARK) && !bSearch.text.includes(MARK),
           "search finds A's text for A, and not for B");
        const aByNumber = await A.api('GET', `/api/threads/${thread.id}/packets`);
        const byNumber = await B.api('GET', `/api/threads/${thread.id}/packets`);
        ok(aByNumber.text.includes(MARK) && !byNumber.text.includes(MARK),
           "the same thread number returns A's packets to A and nothing of A's to B", byNumber.text.slice(0, 100));

        const duet = await B.api('GET', `/api/duet/${bTree.body[0].threads[0].id}`);
        ok((duet.body?.participants || []).length === 2,
           "B's seeded thread has its participants seated, the way a desk's is at boot");

        const stats = await B.api('GET', '/api/stats');
        ok(stats.status === 200 && !('dbPath' in (stats.body || {})), "/api/stats does not tell a visitor the server's file paths");

        const ws = await B.api('GET', `/api/workspace?threadId=${bTree.body[0].threads[0].id}`);
        ok(ws.body?.policy === 'off', 'sandbox mode counts as hosted: workspaces are off without an allowlist');

        // ── the ways around it ──
        const forgedId = 'f'.repeat(32);
        const F = visitor(s, `airlock_sandbox=${forgedId}`);
        await F.api('GET', '/api/tree');
        ok(idOf(F.cookie) !== forgedId, 'a well-formed id this server never minted is replaced, not adopted');
        ok(!filesIn(s.dir).some(f => f.startsWith(forgedId)), 'and no file is created under the offered id');

        const T = visitor(s, 'airlock_sandbox=..%2F..%2Fairlock');
        const t = await T.api('GET', '/api/tree');
        ok(t.status === 200 && /^airlock_sandbox=[a-f0-9]{32}$/.test(T.cookie), 'a cookie shaped like a path gets a fresh sandbox');
        const stray = sandboxFiles(s.dir).filter(f => !/^[a-f0-9]{32}\.db(-wal|-shm)?$/.test(f));
        ok(stray.length === 0, 'and every file in the sandbox directory is named by a minted id', stray.join(', '));

        const Aagain = visitor(s, A.cookie);
        ok(JSON.stringify((await Aagain.api('GET', '/api/tree')).body).includes(MARK),
           "A's cookie in a new jar still reaches A's sandbox — the cookie is the whole key");
        ok(/sandboxes -> one per visitor/.test(s.log()), 'the boot log says sandboxes are on');
    } finally { await s.stop(); }
}

async function expiry() {
    console.log('\nidle sandboxes are removed');
    const s = await serve({ AIRLOCK_SANDBOX_TTL_MS: '1500', AIRLOCK_SANDBOX_SWEEP_MS: '400' });
    try {
        const A = visitor(s);
        const tree = await A.api('GET', '/api/tree');
        const MARK = 'soon-to-expire-3b81';
        await A.api('POST', '/api/threads', { folderId: tree.body[0].id, title: MARK });
        const id = idOf(A.cookie);
        ok(filesIn(s.dir).includes(`${id}.db`), "A's sandbox is on disk");

        await new Promise(r => setTimeout(r, 2600));
        ok(!filesIn(s.dir).some(f => f.startsWith(id)), 'after the idle period the sweeper deletes it, WAL files included');

        const back = await A.api('GET', '/api/tree');
        ok(idOf(A.cookie) !== id && !back.text.includes(MARK), 'and the returning cookie gets a fresh, empty sandbox');
    } finally { await s.stop(); }
}

async function admission() {
    console.log('\nbounds on new sandboxes');
    const s = await serve({ AIRLOCK_SANDBOX_PER_IP_HOUR: '2' });
    try {
        const r = [];
        for (let i = 0; i < 3; i++) r.push((await visitor(s).api('GET', '/api/tree')).status);
        ok(r[0] === 200 && r[1] === 200 && r[2] === 429, 'a third new sandbox from one address in an hour is refused', r.join(','));
    } finally { await s.stop(); }

    const c = await serve({ AIRLOCK_SANDBOX_MAX: '1' });
    try {
        const one = await visitor(c).api('GET', '/api/tree');
        const two = await visitor(c).api('GET', '/api/tree');
        ok(one.status === 200 && two.status === 503 && /full/i.test(two.body?.error || ''),
           'once the live cap is reached, a new visitor is told the demo is full', `${one.status},${two.status}`);
    } finally { await c.stop(); }
}

// ─────────────────────── Stage 3: what else was shared ───────────────────────

/** Stream a POST, timestamping each NDJSON event as it arrives. */
async function streamed(server, v, route, body, { signal } = {}) {
    const res = await fetch(`http://127.0.0.1:${server.port}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(v.cookie ? { Cookie: v.cookie } : {}) },
        body: JSON.stringify(body),
        signal
    });
    if (!(res.headers.get('content-type') || '').includes('ndjson')) {
        return { status: res.status, json: await res.json().catch(() => null), events: [] };
    }
    const events = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const l of lines) if (l.trim()) { try { events.push({ at: Date.now(), ...JSON.parse(l) }); } catch { /* partial */ } }
        }
    } catch (err) { if (err.name !== 'AbortError') throw err; }
    return { status: res.status, json: null, events };
}

async function perVisitorConfig() {
    console.log('\neach visitor has settings of their own');
    const s = await serve();
    try {
        const A = visitor(s), B = visitor(s);
        const base = (await A.api('GET', '/api/config')).body;
        const MARK = 'You are a pirate. visitor-A-prompt-e61f';
        const set = await A.api('POST', '/api/config', { systemPrompt: MARK, temperature: 0.1, num_ctx: 999999, maxConcurrent: 50 });
        ok(set.body?.systemPrompt === MARK && set.body?.temperature === 0.1, "A's own settings take effect for A");
        ok(set.body?.num_ctx === base.num_ctx && set.body?.maxConcurrent === base.maxConcurrent,
           'but settings that affect the whole host (context size, the shared queue) are not a visitor\'s to change',
           `num_ctx ${set.body?.num_ctx}, maxConcurrent ${set.body?.maxConcurrent}`);

        const b = (await B.api('GET', '/api/config')).body;
        ok(b.systemPrompt !== MARK && b.temperature === base.temperature,
           "B's settings are untouched by A's");
        // Either the file was never written, or it was written without A's prompt. Both
        // mean the same thing: a visitor's change stayed in the visitor's sandbox.
        const file = path.join(tmp, `config-${s.port}.json`);
        const onDisk = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8') || '{}') : {};
        ok(onDisk.systemPrompt !== MARK, "and the operator's config file is not written by a visitor",
           fs.existsSync(file) ? 'file exists' : 'file never written');
    } finally { await s.stop(); }
}

async function sharedQueue() {
    console.log('\nthe shared queue keeps each reply with its sender');
    const s = await serve();                      // local queue limit 1: the operator default
    try {
        const A = visitor(s), B = visitor(s);
        const seat = async v => {
            const tree = await v.api('GET', '/api/tree');
            const threadId = tree.body[0].threads[0].id;
            await v.api('POST', '/api/config', { think: false });
            const state = await v.api('GET', `/api/duet/${threadId}`);
            return { threadId, left: state.body.participants.find(p => p.slot === 'a') };
        };
        const a = await seat(A), b = await seat(B);
        ok(a.left?.model && b.left?.model, 'each visitor has a local participant seated', `${a.left?.model}, ${b.left?.model}`);

        const send = (v, x, word) => streamed(s, v, `/api/duet/${x.threadId}/send`,
            { participantId: x.left.id, text: `Reply with exactly one word: ${word}`, clientRequestId: `q-${word}` });
        const [ra, rb] = await Promise.all([send(A, a, 'ALPHA'), send(B, b, 'BRAVO')]);

        // Proof the queue was exercised: one reply only started running after the other
        // was done. Without it, both could have run side by side and this test would prove
        // nothing about the queue.
        const t = r => ({ running: r.events.find(e => e.type === 'running')?.at, done: r.events.find(e => e.type === 'done')?.at });
        const ta = t(ra), tb = t(rb);
        const serialised = (ta.running >= tb.done) || (tb.running >= ta.done);
        ok(serialised, 'one visitor\'s reply waited in the queue behind the other\'s',
           JSON.stringify({ ta, tb }));

        for (const [who, v, x] of [['A', A, a], ['B', B, b]]) {
            const msgs = (await v.api('GET', `/api/duet/${x.threadId}`)).body.messages;
            const replies = msgs.filter(m => m.role === 'assistant');
            ok(replies.length === 1 && replies[0].status === 'complete' && (replies[0].content || '').trim(),
               `${who}'s reply was finished in ${who}'s own sandbox`,
               JSON.stringify(replies.map(r => ({ status: r.status, content: (r.content || '').slice(0, 30) }))));
        }
    } finally { await s.stop(); }
}

/**
 * The case the queue binding exists for.
 *
 * On the LOCAL path nothing inside a queued job touches a visitor's data — the reply is
 * saved after the queue returns, back in the sender's own context — so a local-only test
 * passes with or without the binding and proves nothing. (The first version of this test
 * did exactly that, and was caught by running it with the binding removed.) On the REMOTE
 * path two things happen inside the job: the crossing is recorded in the audit trail, and
 * the kernel checks the clearance against the visitor's scope. Unbound, a waiting job runs
 * as whoever finished before it, and its crossing lands in that visitor's audit trail.
 *
 * The remote queue runs two jobs at once, so three visitors send together to a fake remote
 * slow enough that the third has to wait.
 */
async function sharedRemoteQueue() {
    console.log('\nthe remote queue records each crossing in its sender\'s audit trail');
    const http = require('node:http');
    const FAKE_MODEL = 'fake/slow-remote';
    const fake = http.createServer((req, res) => {
        let body = ''; req.on('data', d => body += d);
        req.on('end', () => {
            if (req.url.endsWith('/models')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ data: [{ id: FAKE_MODEL, object: 'model' }] }));
            }
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'noted' } }] })}\n\n`);
            setTimeout(() => {
                res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } })}\n\n`);
                res.end('data: [DONE]\n\n');
            }, 2500);
        });
    });
    await new Promise(r => fake.listen(8198, '127.0.0.1', r));
    const s = await serve({
        NEBIUS_API_KEY: 'fake-key-for-a-local-test', NEBIUS_BASE_URL: 'http://127.0.0.1:8198',
        AIRLOCK_REMOTE_ALLOW: '', AIRLOCK_REMOTE_BUDGET: ''
    });
    try {
        const health = await visitor(s).api('GET', '/api/health');
        const remote = (health.body?.models || []).filter(m => m.tier === 'remote').map(m => m.name);
        if (!(remote.length === 1 && remote[0] === FAKE_MODEL)) throw new Error('refusing to continue: this server could reach a real remote tier');

        const people = ['ALPHA', 'BRAVO', 'CHARLIE'].map(word => ({ word, v: visitor(s) }));
        for (const p of people) {
            const tree = await p.v.api('GET', '/api/tree');
            p.threadId = tree.body[0].threads[0].id;
            const state = await p.v.api('GET', `/api/duet/${p.threadId}`);
            p.right = state.body.participants.find(x => x.slot === 'b');
            await p.v.api('PATCH', `/api/duet/participants/${p.right.id}`, { model: FAKE_MODEL });
        }

        const results = await Promise.all(people.map(p => streamed(s, p.v, `/api/duet/${p.threadId}/send`,
            { participantId: p.right.id, text: `A note about the colour ${p.word.toLowerCase()} for the record.`, clientRequestId: `rq-${p.word}` })));

        const at = r => ({ running: r.events.find(e => e.type === 'running')?.at, done: r.events.find(e => e.type === 'done')?.at });
        const times = results.map(at);
        const waited = times.some(t => times.filter(o => o !== t && o.done && t.running >= o.done).length > 0);
        ok(waited, 'one of the three waited in the remote queue for another to finish', JSON.stringify(times));
        ok(results.every(r => r.events.some(e => e.type === 'done')), 'all three crossings completed',
           results.map(r => r.events.map(e => e.type).join('>')).join(' | '));

        for (const p of people) {
            const exp = await p.v.api('GET', `/api/threads/${p.threadId}/exposure`);
            const previews = (exp.body?.packets || []).map(x => x.preview).join(' | ');
            const own = previews.includes(p.word.toLowerCase());
            const others = people.filter(o => o !== p).some(o => previews.includes(o.word.toLowerCase()));
            ok(own && !others, `${p.word}'s crossing is in ${p.word}'s audit trail, and nobody else's is`, previews || '(empty)');
        }
    } finally {
        await s.stop();
        await new Promise(r => fake.close(r));
    }
}

async function perVisitorSlots() {
    console.log('\none visitor cannot monopolise the generator');
    const s = await serve({ AIRLOCK_SANDBOX_CONCURRENT: '1' });
    try {
        const A = visitor(s);
        const tree = await A.api('GET', '/api/tree');
        const threadId = tree.body[0].threads[0].id;
        const left = (await A.api('GET', `/api/duet/${threadId}`)).body.participants.find(p => p.slot === 'a');

        const long = new AbortController();
        const first = streamed(s, A, `/api/duet/${threadId}/send`,
            { participantId: left.id, text: 'Write a four hundred word story about a lighthouse.', clientRequestId: 'slot-1' },
            { signal: long.signal });
        await new Promise(r => setTimeout(r, 300));
        const second = await A.api('POST', `/api/duet/${threadId}/send`,
            { participantId: left.id, text: 'And another.', clientRequestId: 'slot-2' });
        ok(second.status === 429, 'with a limit of one, a second generation from the same visitor waits its turn', `status ${second.status}`);

        const B = visitor(s);
        const bTree = await B.api('GET', '/api/tree');
        const bThread = bTree.body[0].threads[0].id;
        const bLeft = (await B.api('GET', `/api/duet/${bThread}`)).body.participants.find(p => p.slot === 'a');
        const other = streamed(s, B, `/api/duet/${bThread}/send`,
            { participantId: bLeft.id, text: 'Say hello.', clientRequestId: 'slot-b' }, { signal: long.signal });
        await new Promise(r => setTimeout(r, 300));
        long.abort();
        const [, ob] = await Promise.all([first.catch(() => null), other.catch(() => null)]);
        ok(!ob || ob.status !== 429, 'while another visitor is not held to the first one\'s limit');
    } finally { await s.stop(); }
}

async function budgets() {
    console.log('\nremote spend, per visitor and per day, across a restart');
    const http = require('node:http');
    const FAKE_MODEL = 'fake/remote-model';
    const fake = http.createServer((req, res) => {
        let body = ''; req.on('data', d => body += d);
        req.on('end', () => {
            if (req.url.endsWith('/models')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ data: [{ id: FAKE_MODEL, object: 'model' }] }));
            }
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'fine' } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } })}\n\n`);
            res.end('data: [DONE]\n\n');
        });
    });
    await new Promise(r => fake.listen(8199, '127.0.0.1', r));
    const env = {
        NEBIUS_API_KEY: 'fake-key-for-a-local-test', NEBIUS_BASE_URL: 'http://127.0.0.1:8199',
        AIRLOCK_REMOTE_ALLOW: '', AIRLOCK_SANDBOX_REMOTE_BUDGET: '1', AIRLOCK_REMOTE_BUDGET: '2'
    };
    const ask = v => v.api('POST', '/api/chat', { model: FAKE_MODEL, messages: [{ role: 'user', content: 'Say hello, please.' }] });

    let s = await serve(env);
    try {
        const health = await visitor(s).api('GET', '/api/health');
        const remote = (health.body?.models || []).filter(m => m.tier === 'remote').map(m => m.name);
        if (!(remote.length === 1 && remote[0] === FAKE_MODEL)) throw new Error('refusing to continue: this server could reach a real remote tier');

        const A = visitor(s), B = visitor(s), C = visitor(s);
        const a1 = await ask(A), a2 = await ask(A);
        ok(a1.status === 200 && a2.status === 429 && /This sandbox has used/.test(a2.body?.error || ''),
           "a visitor's own allowance runs out for them", `${a1.status} ${a2.status} ${a2.body?.error || ''}`);
        const b1 = await ask(B);
        ok(b1.status === 200, 'while the next visitor still has theirs');
        const c1 = await ask(C);
        ok(c1.status === 429 && /shared remote allowance for today/.test(c1.body?.error || ''),
           'until the demo\'s daily total is spent, for everyone', `${c1.status} ${c1.body?.error || ''}`);

        const dir = s.dir;
        await s.stop();
        s = await serve({ ...env, AIRLOCK_SANDBOX_DIR: dir });
        const d1 = await ask(visitor(s));
        ok(d1.status === 429 && /shared remote allowance/.test(d1.body?.error || ''),
           'and a restart does not refill it — the known gap in the per-process counter', `${d1.status}`);
    } finally {
        await s.stop();
        await new Promise(r => fake.close(r));
    }
}

(async () => {
    console.log('\nAirlock sandboxes over HTTP');
    try {
        await isolation();
        await expiry();
        await admission();
        await perVisitorConfig();
        await sharedQueue();
        await sharedRemoteQueue();
        await perVisitorSlots();
        await budgets();
    } catch (err) {
        fail++;
        console.log('  FAIL sandbox_http_test could not run — ' + (err.stack || err.message));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log(`\n${pass} passed, ${fail} failed\n`);
    if (fail) process.exitCode = 1;
})();
