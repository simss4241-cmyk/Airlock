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

(async () => {
    console.log('\nAirlock sandboxes over HTTP');
    try {
        await isolation();
        await expiry();
        await admission();
    } catch (err) {
        fail++;
        console.log('  FAIL sandbox_http_test could not run — ' + (err.stack || err.message));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log(`\n${pass} passed, ${fail} failed\n`);
    if (fail) process.exitCode = 1;
})();
