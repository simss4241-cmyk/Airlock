'use strict';

/**
 * What a hosted instance lets a stranger reach on the host.  node tools/hosting_test.js
 *
 * On a desk, a workspace may be any folder — it is your machine. Hosted, every visitor is
 * someone else, and "any absolute folder that exists" meant pointing a workspace at / and
 * reading every .json, .yml, .conf and .log on the server. files.permitRoot decides what a
 * root may be (see workspacePolicy); these assertions hold it to that in each mode, and
 * try the ways around it: a sibling folder whose name merely starts the same, a junction
 * planted inside an allowed folder, and a database carried over from a desk that already
 * holds a root outside the allowlist.
 *
 * Starts its own servers on scratch databases; needs no model and no network.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const files = require('../files');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'airlock-hosting-')));
const allowed = path.join(tmp, 'allowed');
const inside = path.join(allowed, 'project');
const outside = path.join(tmp, 'outside');
const sibling = path.join(tmp, 'allowed-evil');        // shares a string prefix, not a parent
const tunnel = path.join(allowed, 'tunnel');            // junction to `outside`
for (const d of [inside, outside, sibling]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(outside, 'service-account.json'), '{"private_key": "not-for-visitors"}');
fs.writeFileSync(path.join(inside, 'notes.md'), '# fine to read');
let junctionMade = true;
try { fs.symlinkSync(outside, tunnel, 'junction'); } catch { junctionMade = false; }

let pass = 0, fail = 0, skip = 0;
const ok = (cond, label, detail = '') => {
    if (cond) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
};
const skipped = label => { skip++; console.log(`  skip ${label}`); };

/** Run `fn` with exactly these hosting variables set, then put the environment back. */
async function withEnv(vars, fn) {
    const keys = ['AIRLOCK_WORKSPACE_ROOTS', 'AIRLOCK_TOKEN', 'AIRLOCK_DEMO'];
    const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    Object.assign(process.env, vars);
    try { return await fn(); } finally {
        for (const k of keys) {
            if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
        }
    }
}
const permitted = root => files.permitRoot(root).then(() => true, () => false);

// ─────────────────────── the policy, in-process ───────────────────────

async function policyTests() {
    console.log('\nwhat a workspace root may be');

    await withEnv({}, async () => {
        ok(files.workspacePolicy().mode === 'any', 'on a desk, with nothing set, any folder');
        ok(await permitted(outside), 'so a folder anywhere is allowed — it is your machine');
    });

    await withEnv({ AIRLOCK_DEMO: '1' }, async () => {
        ok(files.workspacePolicy().mode === 'off',
           'hosted with no allowlist: workspaces are OFF, not quietly "any"');
        ok(!(await permitted(inside)), 'so even an ordinary folder is refused');
    });
    await withEnv({ AIRLOCK_TOKEN: 'shared-secret' }, async () => {
        ok(files.workspacePolicy().mode === 'off', 'a token alone also means hosted');
    });

    await withEnv({ AIRLOCK_WORKSPACE_ROOTS: allowed, AIRLOCK_DEMO: '1' }, async () => {
        ok(files.workspacePolicy().mode === 'allowlist', 'with an allowlist, hosted or not, the allowlist rules');
        ok(await permitted(allowed), 'an allowed root itself is permitted');
        ok(await permitted(inside), 'and a folder inside it');
        ok(!(await permitted(outside)), 'a folder outside it is refused');
        ok(!(await permitted(path.parse(tmp).root)), 'the filesystem root is refused');
        ok(!(await permitted(sibling)),
           'a sibling whose name merely starts the same is refused — compared by segment, not prefix');
        if (junctionMade) {
            ok(!(await permitted(tunnel)),
               'a junction inside the allowed folder that points outside it is refused');
        } else {
            skipped('junction escape (could not create a junction here)');
        }
    });

    const both = [allowed, outside].join(path.delimiter);
    await withEnv({ AIRLOCK_WORKSPACE_ROOTS: both }, async () => {
        ok(await permitted(outside) && await permitted(inside), 'several roots can be allowed at once');
        ok(!(await permitted(sibling)), 'and still nothing beside them');
    });
}

// ─────────────────────── the same, at the HTTP door ───────────────────────

let port = 8160;
async function serve(env, dbFile) {
    const p = port++;
    const child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(p),
            AIRLOCK_DB: dbFile,
            AIRLOCK_CONFIG: path.join(tmp, `config-${p}.json`),
            // No remote tier: nothing here needs it, and nothing here should reach it.
            NEBIUS_API_KEY: '',
            AIRLOCK_WORKSPACE_ROOTS: '', AIRLOCK_TOKEN: '', AIRLOCK_DEMO: '',
            ...env
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    child.stdout.on('data', d => log += d);
    child.stderr.on('data', d => log += d);

    const token = env.AIRLOCK_TOKEN || '';
    const api = async (method, route, body) => {
        const res = await fetch(`http://127.0.0.1:${p}${route}`, {
            method,
            headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { 'X-Airlock-Token': token } : {}) },
            body: body ? JSON.stringify(body) : undefined
        });
        const text = await res.text();
        try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
    };

    for (let i = 0; i < 60; i++) {
        if (child.exitCode !== null) throw new Error(`server exited early:\n${log}`);
        try { if ((await fetch(`http://127.0.0.1:${p}/api/whoami`)).ok) break; } catch { /* not yet */ }
        await new Promise(r => setTimeout(r, 250));
    }
    const stop = async () => {
        if (child.exitCode === null) { child.kill(); await new Promise(r => child.once('exit', r)); }
    };
    return { api, stop, log: () => log };
}

async function httpTests() {
    console.log('\nat the HTTP door');
    const db = path.join(tmp, 'carried.db');

    // A desk sets a workspace outside what the hosted box will allow...
    const desk = await serve({}, db);
    let threadId;
    try {
        const tree = await desk.api('GET', '/api/tree');
        threadId = (await desk.api('POST', '/api/threads', { folderId: tree.body[0].id, title: 'carried' })).body.id;
        const set = await desk.api('POST', '/api/workspace', { threadId, root: outside });
        ok(set.status === 200, 'on a desk, any folder can be set as a workspace', JSON.stringify(set.body));
        const h = await desk.api('GET', '/api/health');
        ok(h.body && h.body.sandbox === null, 'and a desk is not told it is a sandbox, so it shows no banner');
    } finally { await desk.stop(); }

    // ...and the same database is then served hosted, with an allowlist.
    const hosted = await serve({ AIRLOCK_WORKSPACE_ROOTS: allowed, AIRLOCK_TOKEN: 'judges-only' }, db);
    try {
        ok(/workspace -> limited to/.test(hosted.log()), 'the boot log says workspaces are limited, and to what');

        const state = await hosted.api('GET', `/api/workspace?threadId=${threadId}`);
        ok(state.body.permitted === false && state.body.policy === 'allowlist',
           'a root carried over from the desk is reported as not permitted', JSON.stringify(state.body));
        ok(Array.isArray(state.body.allowedRoots) && state.body.allowedRoots.length === 1,
           'and the allowed roots are listed, so the UI can offer them');

        const list = await hosted.api('GET', `/api/fs/list?threadId=${threadId}&path=.`);
        ok(list.status === 400, 'the carried-over root cannot be listed', JSON.stringify(list.body));
        const read = await hosted.api('GET', `/api/fs/read?threadId=${threadId}&path=service-account.json`);
        ok(read.status === 400 && !JSON.stringify(read.body).includes('not-for-visitors'),
           'nor its files read — the check is made when a root is USED, not only when it is set');

        const escape = await hosted.api('POST', '/api/workspace', { threadId, root: path.parse(tmp).root });
        ok(escape.status === 400 && /limited to/.test(escape.body.error),
           'setting the filesystem root is refused, with the reason', JSON.stringify(escape.body));

        const good = await hosted.api('POST', '/api/workspace', { threadId, root: inside });
        ok(good.status === 200, 'a folder inside the allowlist can be set', JSON.stringify(good.body));
        const fine = await hosted.api('GET', `/api/fs/read?threadId=${threadId}&path=notes.md`);
        ok(fine.status === 200 && /fine to read/.test(fine.body.content || ''), 'and read');

        const browse = await hosted.api('GET', `/api/workspace/browse?threadId=${threadId}`);
        ok(browse.status === 403, 'the server-side folder picker is not offered to a visitor');
    } finally { await hosted.stop(); }

    // Hosted, and nobody set an allowlist: off, not open.
    const forgot = await serve({ AIRLOCK_DEMO: '1' }, path.join(tmp, 'forgot.db'));
    try {
        ok(/workspace -> OFF/.test(forgot.log()), 'hosted without an allowlist, the boot log says workspaces are OFF');
        const tree = await forgot.api('GET', '/api/tree');
        const t = (await forgot.api('POST', '/api/threads', { folderId: tree.body[0].id, title: 'x' })).body.id;
        const set = await forgot.api('POST', '/api/workspace', { threadId: t, root: inside });
        ok(set.status === 400 && /off on this instance/i.test(set.body.error),
           'and any workspace is refused — forgetting the variable costs the feature, not the host',
           JSON.stringify(set.body));
    } finally { await forgot.stop(); }
}

(async () => {
    console.log('\nAirlock hosting: what a visitor can reach');
    try {
        await policyTests();
        await httpTests();
    } catch (err) {
        fail++;
        console.log('  FAIL hosting_test could not run — ' + (err.stack || err.message));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped\n`);
    if (fail) process.exitCode = 1;
})();
