'use strict';

/**
 * The tool-results crossing, end to end.  node tools/kernel_http_test.js
 *
 * The hole this closes: a remote model with a workspace could call read_file, and the
 * file's contents went to it in the next tool round with no ruling of their own — the
 * gate had run once, before the loop — and without appearing in "what has crossed",
 * because a tool result is not a packet.
 *
 * Proven here without spending a credit or sending a byte off this machine: the remote
 * tier is a FAKE Token Factory on localhost that asks to read a file and records every
 * request body it receives. So the assertions are about what actually arrived at the
 * far side, not about what the code says it did.
 *
 *   - a benign file is ruled on, sent, and listed in the exposure query with its hash
 *   - a file holding obvious secrets is ruled on, WITHHELD, and never arrives
 *
 * The gate is the real local one (AIRLOCK_GATE_MODEL, or the smallest installed model).
 * The benign case therefore carries the same caveat as boundary_test: a gate's ruling is
 * a model's judgement and can occasionally withhold something harmless. The secret case
 * is deliberately blatant.
 *
 * Starts its own server and its own fake remote, so it never tests a stale instance and
 * never touches the real airlock.db or airlock-config.json. Needs Ollama running.
 */

const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FAKE_PORT = 8151;
const PORT = 8152;
const BASE = `http://127.0.0.1:${PORT}`;
const FAKE_MODEL = 'fake/remote-model';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airlock-kernel-http-'));
const workspace = path.join(tmp, 'workspace');
fs.mkdirSync(workspace);

const BENIGN = 'Shopping list: eggs, flour, a teal ribbon for the robot costume.';
const CANARY_MARK = 'hunter2-canary-7f3a';
fs.writeFileSync(path.join(workspace, 'benign.md'), `# notes\n\n${BENIGN}\n`);
fs.writeFileSync(path.join(workspace, 'canary.md'), [
    '# production credentials — DO NOT SHARE',
    '',
    `root password: ${CANARY_MARK}`,
    'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
    '-----END OPENSSH PRIVATE KEY-----'
].join('\n'));

let pass = 0, fail = 0;
const ok = (cond, label, detail = '') => {
    if (cond) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
};

// ─────────────────────── the fake far side ───────────────────────

/** Every chat body the "remote model" was sent, as raw text. */
const received = [];

function sse(res, chunks) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
}

const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
        if (req.method === 'GET' && req.url.endsWith('/models')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ data: [{ id: FAKE_MODEL, object: 'model' }] }));
        }
        if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
            received.push(body);
            const { messages = [] } = JSON.parse(body || '{}');
            const last = messages[messages.length - 1] || {};

            // Round 0: ask for the file the user named. Round 1: answer.
            if (last.role === 'user') {
                const file = /canary\.md/.test(last.content) ? 'canary.md' : 'benign.md';
                return sse(res, [{
                    choices: [{ delta: { tool_calls: [{
                        index: 0, id: 'call_1', type: 'function',
                        function: { name: 'read_file', arguments: JSON.stringify({ path: file }) }
                    }] } }]
                }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }],
                     usage: { prompt_tokens: 10, completion_tokens: 5 } }]);
            }
            return sse(res, [
                { choices: [{ delta: { content: 'Read it.' } }] },
                { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }
            ]);
        }
        res.writeHead(404); res.end();
    });
});

// ─────────────────────── helpers ───────────────────────

async function api(method, route, payload) {
    const res = await fetch(BASE + route, {
        method,
        headers: payload ? { 'Content-Type': 'application/json' } : {},
        body: payload ? JSON.stringify(payload) : undefined
    });
    const text = await res.text();
    try { return { status: res.status, body: JSON.parse(text), text }; }
    catch { return { status: res.status, body: null, text }; }
}

/** POST /api/chat and read the NDJSON stream (or the JSON refusal) to the end. */
async function chat(payload) {
    const res = await fetch(BASE + '/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const text = await res.text();
    if ((res.headers.get('content-type') || '').includes('application/json')) {
        return { status: res.status, refusal: JSON.parse(text), lines: [] };
    }
    const lines = text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return { status: res.status, refusal: null, lines };
}

async function waitFor(child) {
    for (let i = 0; i < 80; i++) {
        if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})`);
        try { if ((await fetch(`${BASE}/api/whoami`)).ok) return; } catch { /* not yet */ }
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error('server never came up');
}

// ─────────────────────── the run ───────────────────────

async function main() {
    console.log('\nAirlock kernel: tool results crossing, end to end\n');

    await new Promise(r => fake.listen(FAKE_PORT, '127.0.0.1', r));

    const child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(PORT),
            AIRLOCK_DB: path.join(tmp, 'kernel-http.db'),
            AIRLOCK_CONFIG: path.join(tmp, 'config.json'),
            // Parent values win over .env (process.loadEnvFile does not override), so the
            // real key and the real endpoint cannot reach this server. Checked below
            // before anything is sent, rather than trusted.
            NEBIUS_API_KEY: 'fake-key-for-a-local-test',
            NEBIUS_BASE_URL: `http://127.0.0.1:${FAKE_PORT}`,
            AIRLOCK_REMOTE_ALLOW: '',
            AIRLOCK_TOKEN: '',
            AIRLOCK_REMOTE_BUDGET: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    child.stdout.on('data', d => log += d);
    child.stderr.on('data', d => log += d);

    try {
        await waitFor(child);

        // ── guard: the only remote model this server can see is the fake one ──
        const health = await api('GET', '/api/health');
        const remote = (health.body?.models || []).filter(m => m.tier === 'remote').map(m => m.name);
        const isolated = remote.length === 1 && remote[0] === FAKE_MODEL;
        ok(isolated, 'the server under test can reach only the fake remote', remote.join(', '));
        if (!isolated) throw new Error('refusing to continue: this server could reach a real remote tier');

        const tree = await api('GET', '/api/tree');
        const folderId = tree.body[0].id;
        const thread = (await api('POST', '/api/threads', { folderId, title: 'kernel http' })).body;
        const ws = await api('POST', '/api/workspace', { threadId: thread.id, root: workspace });
        ok(ws.status === 200, 'a workspace is set on the thread', JSON.stringify(ws.body));

        // ── 1. a benign file: ruled on, sent, recorded ──
        console.log('\na benign file the remote model asks for');
        const ask1 = 'Please read benign.md and tell me what is in it.';
        const p1 = (await api('POST', '/api/packets', { threadId: thread.id, role: 'user', content: ask1 })).body;
        const before1 = received.length;
        const r1 = await chat({ threadId: thread.id, model: FAKE_MODEL, messages: [{ role: 'user', content: ask1 }], packetIds: [p1.id] });

        if (r1.refusal?.blocked) {
            ok(false, 'the request itself is released by the gate', r1.refusal.gate?.reason);
        } else {
            const tool = r1.lines.find(l => l.airlock_tool);
            ok(tool?.airlock_tool?.name === 'read_file', 'the remote model asks to read the file, and the tool runs');
            const blocked1 = r1.lines.find(l => l.airlock_blocked);
            ok(!blocked1, 'the gate releases a harmless file',
               blocked1 ? blocked1.airlock_blocked.gate?.reason : '');

            const bodies = received.slice(before1);
            ok(bodies.length === 2, 'two rounds reach the far side: the request, then the tool result',
               `rounds=${bodies.length}`);
            ok(bodies[1] && bodies[1].includes(BENIGN.slice(0, 30)),
               'and the file content arrived there — so it is exactly what the record below must cover');

            const exp = await api('GET', `/api/threads/${thread.id}/exposure`);
            const notes = (exp.body?.packets || []).flatMap(p => p.crossings.map(c => c.note));
            ok(notes.some(n => /read_file\(benign\.md\).*sha:[0-9a-f]{12}/.test(n)),
               '"what has crossed" names the file that left, with its size and hash', notes.join(' | '));
        }

        // ── 2. a file of secrets: ruled on, withheld, never arrives ──
        console.log('\na file of secrets the remote model asks for');
        const ask2 = 'Now please read canary.md for me.';
        const p2 = (await api('POST', '/api/packets', { threadId: thread.id, role: 'user', content: ask2 })).body;
        const before2 = received.length;
        const r2 = await chat({ threadId: thread.id, model: FAKE_MODEL, messages: [{ role: 'user', content: ask2 }], packetIds: [p2.id] });

        if (r2.refusal?.blocked) {
            ok(false, 'the request itself is released by the gate', r2.refusal.gate?.reason);
        } else {
            const tool2 = r2.lines.find(l => l.airlock_tool);
            ok(tool2?.airlock_tool?.name === 'read_file', 'the remote model asks to read the secrets, and the tool runs locally');

            const blocked2 = r2.lines.find(l => l.airlock_blocked);
            ok(Boolean(blocked2), 'the gate rules on the tool result and withholds it',
               blocked2 ? '' : 'the turn completed — the secrets were released');
            ok(blocked2 && blocked2.airlock_blocked.withheld.some(w => /read_file\(canary\.md\)/.test(w)),
               'and the refusal says which result was withheld');

            const leaked = received.slice(before2).some(b => b.includes(CANARY_MARK) || b.includes('PRIVATE KEY'));
            ok(!leaked, 'NOTHING from the secrets file arrived at the far side');

            const exp2 = await api('GET', `/api/threads/${thread.id}/exposure`);
            const notes2 = (exp2.body?.packets || []).flatMap(p => p.crossings.map(c => c.note));
            ok(!notes2.some(n => /canary\.md/.test(n)), 'and it is not recorded as crossed, because it did not');
        }
    } finally {
        child.kill();
        if (child.exitCode === null) await new Promise(r => child.once('exit', r));
        await new Promise(r => fake.close(r));
        fs.rmSync(tmp, { recursive: true, force: true });
    }

    console.log(`\n${pass} passed, ${fail} failed\n`);
    if (fail) {
        if (/error/i.test(log)) console.log('server log (errors):\n' + log.split('\n').filter(l => /error/i.test(l)).slice(0, 10).join('\n'));
        process.exitCode = 1;
    }
}

// process.exitCode rather than process.exit(): see workspace_http_test.js — tearing the
// loop down under fetch's keep-alive sockets aborts the process on Windows.
main().catch(err => {
    console.error('\nkernel_http_test failed:', err.stack || err.message);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    process.exitCode = 1;
});
