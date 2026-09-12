'use strict';

/**
 * HTTP-level tests for the per-thread workspace contract.
 *   node tools/workspace_http_test.js
 *
 * workspace_test.js covers the store and files_test.js covers containment, but the thing
 * that actually decides what Airlock can read is the wiring in between: which thread a
 * request names, and whose root that resolves to. That was hand-checked once and then had
 * no regression net, which is how a shared-root bug gets reintroduced quietly.
 *
 * Spawns its own server on a spare port against a throwaway database, so it never reads or
 * writes the real airlock.db. Ollama is not needed — nothing here calls /api/chat.
 */

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const PORT = 8137;                       // not 8100: never collide with the real instance
const BASE = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airlock-http-test-'));
const wsA = path.join(tempDir, 'workspace-a');
const wsB = path.join(tempDir, 'workspace-b');

let pass = 0;
const failures = [];

const check = (label, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ok   ${label}`); }
    else { failures.push(label); console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
};

const get = async route => {
    const res = await fetch(`${BASE}${route}`);
    return { status: res.status, body: await res.json() };
};

const post = async (route, payload) => {
    const res = await fetch(`${BASE}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    return { status: res.status, body: await res.json() };
};

async function waitForServer(child) {
    for (let i = 0; i < 60; i++) {
        if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})`);
        try {
            const res = await fetch(`${BASE}/api/config`);
            if (res.ok) return;
        } catch { /* not listening yet */ }
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error(`server never came up on ${PORT}`);
}

(async () => {
    console.log('\nAirlock per-thread workspace HTTP tests\n');

    await fsp.mkdir(path.join(wsA, 'sub'), { recursive: true });
    await fsp.mkdir(wsB, { recursive: true });
    await fsp.writeFile(path.join(wsA, 'alpha.md'), '# alpha\n');
    await fsp.writeFile(path.join(wsA, 'sub', 'nested.md'), 'nested\n');
    await fsp.writeFile(path.join(wsB, 'beta.md'), '# beta\n');

    const child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(PORT),
            AIRLOCK_DB: path.join(tempDir, 'http-test.db')
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.resume();
    child.stderr.resume();

    try {
        await waitForServer(child);

        // The seeded tree gives us threads to work with.
        const tree = (await get('/api/tree')).body;
        const threads = (Array.isArray(tree) ? tree : tree.folders ?? [])
            .flatMap(folder => folder.threads ?? []);
        assert(threads.length >= 2, 'seed provides at least two threads');
        const [a, b] = threads;

        // ── every thread starts with no file access ──
        const fresh = await Promise.all(threads.map(t => get(`/api/workspace?threadId=${t.id}`)));
        check('a new database gives every thread files off',
            fresh.every(r => r.body.root === null),
            fresh.map(r => r.body.root).join(','));

        // ── assigning one thread does not touch another ──
        const setA = await post('/api/workspace', { threadId: a.id, root: wsA });
        check('assigning a workspace succeeds', setA.status === 200 && setA.body.root === wsA,
            JSON.stringify(setA.body));
        check('the other thread is unaffected',
            (await get(`/api/workspace?threadId=${b.id}`)).body.root === null);

        await post('/api/workspace', { threadId: b.id, root: wsB });
        const bothA = await get(`/api/workspace?threadId=${a.id}`);
        const bothB = await get(`/api/workspace?threadId=${b.id}`);
        check('two threads hold two different roots',
            bothA.body.root === wsA && bothB.body.root === wsB,
            `${bothA.body.root} vs ${bothB.body.root}`);

        // ── each thread reads only its own root ──
        const listA = await get(`/api/fs/list?threadId=${a.id}&path=.`);
        const listB = await get(`/api/fs/list?threadId=${b.id}&path=.`);
        const namesA = listA.body.entries.map(e => e.name);
        const namesB = listB.body.entries.map(e => e.name);
        check('thread A sees only its own files',
            namesA.includes('alpha.md') && !namesA.includes('beta.md'), namesA.join(','));
        check('thread B sees only its own files',
            namesB.includes('beta.md') && !namesB.includes('alpha.md'), namesB.join(','));

        const readA = await get(`/api/fs/read?threadId=${a.id}&path=alpha.md`);
        check('a thread can read inside its root', readA.status === 200);
        const crossRead = await get(`/api/fs/read?threadId=${a.id}&path=../workspace-b/beta.md`);
        check('a thread cannot read another thread\'s root',
            crossRead.status === 400, JSON.stringify(crossRead.body));

        // ── clearing is per-thread ──
        await post('/api/workspace', { threadId: a.id, root: null });
        check('clearing one thread clears it',
            (await get(`/api/workspace?threadId=${a.id}`)).body.root === null);
        check('clearing one thread leaves the other alone',
            (await get(`/api/workspace?threadId=${b.id}`)).body.root === wsB);
        const clearedList = await get(`/api/fs/list?threadId=${a.id}&path=.`);
        check('a cleared thread loses file access', clearedList.status === 400,
            JSON.stringify(clearedList.body));

        // ── bad input ──
        const relative = await post('/api/workspace', { threadId: b.id, root: 'workspace-b' });
        check('a relative path is refused rather than resolved against the server cwd',
            relative.status === 400 && /full path/i.test(relative.body.error),
            JSON.stringify(relative.body));
        check('the refused path did not overwrite the existing root',
            (await get(`/api/workspace?threadId=${b.id}`)).body.root === wsB);

        const missing = await post('/api/workspace', {
            threadId: b.id, root: path.join(tempDir, 'not-here')
        });
        check('a nonexistent folder is refused', missing.status === 400);

        const asFile = await post('/api/workspace', {
            threadId: b.id, root: path.join(wsB, 'beta.md')
        });
        check('a file is refused as a root', asFile.status === 400);

        const noThread = await post('/api/workspace', { threadId: 999999, root: wsA });
        check('an unknown thread is refused', noThread.status === 400);
        check('a scratch chat (no thread) has no workspace',
            (await get('/api/workspace')).status === 400);

        // ── the retired global root cannot come back ──
        const sneak = await post('/api/config', { workspaceRoot: wsA });
        check('POST /api/config ignores workspaceRoot',
            !('workspaceRoot' in sneak.body), JSON.stringify(Object.keys(sneak.body)));
        check('the cleared thread stayed cleared',
            (await get(`/api/workspace?threadId=${a.id}`)).body.root === null);

        // ── a vanished root reports itself instead of looking empty ──
        await post('/api/workspace', { threadId: a.id, root: wsA });
        await fsp.rename(wsA, `${wsA}-moved`);
        const goneFind = await get(`/api/fs/find?threadId=${a.id}&q=alpha`);
        check('find on a vanished root errors instead of returning 0 matches',
            goneFind.status === 400 && /no longer exists/i.test(goneFind.body.error),
            JSON.stringify(goneFind.body));
        const goneState = await get(`/api/workspace?threadId=${a.id}`);
        check('workspace state reports the root as missing',
            goneState.body.root === wsA && goneState.body.exists === false,
            JSON.stringify(goneState.body));
        await fsp.rename(`${wsA}-moved`, wsA);
        check('and works again once the folder is back',
            (await get(`/api/fs/find?threadId=${a.id}&q=alpha`)).body.count === 1);
    } finally {
        child.kill();
        await new Promise(r => child.once('exit', r));
        fs.rmSync(tempDir, { recursive: true, force: true });
    }

    console.log(`\n${pass} passed, ${failures.length} failed\n`);
    if (failures.length) {
        failures.forEach(f => console.log(`  - ${f}`));
        process.exit(1);
    }
})().catch(err => {
    console.error('\nworkspace_http_test crashed:', err.message);
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.exit(1);
});
