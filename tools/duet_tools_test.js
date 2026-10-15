'use strict';

/**
 * Workspace files in a duet, and every way their contents could reach a cloud model.
 *
 *   node tools/duet_tools_test.js
 *
 * The rule under test is not "tools work". It is that local file contents are ruled on
 * WHENEVER they enter a cloud-bound context, not only the first time they are read:
 *
 *   1. directly      a remote participant reads a file; the result goes back to it
 *   2. shared history the text sits in the conversation, and a remote participant is asked
 *   3. moved         the text is dragged to another thread and crosses from there
 *   4. by hand       "Carry out by hand": the brief is copied to a chat Airlock cannot see
 *
 * Proven without spending a credit or sending a byte off this machine: the remote tier is a
 * FAKE Token Factory on localhost that records every request body it receives, so the
 * assertions are about what actually arrived at the far side. A canary file of secrets is
 * the thing that must never arrive by any of the four routes.
 *
 * The local side is faked too: the gate model is a stand-in that releases everything (see
 * below), so every refusal here is the deterministic secret scanner's, on that route. The
 * gate MODEL's judgement is measured by tools/gate_bench.js, not here.
 *
 * Starts its own server, a fake remote and a fake Ollama, on its own database. Needs
 * neither Ollama nor a key, and sends nothing anywhere.
 */

const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FAKE_PORT = 8161;
const PORT = 8162;
const BASE = `http://127.0.0.1:${PORT}`;
const FAKE_MODEL = 'fake/remote-model';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airlock-duet-tools-'));
const workspace = path.join(tmp, 'workspace');
fs.mkdirSync(workspace);
// Outside the permitted roots: a folder a thread may have saved before the fence went up.
const outside = path.join(tmp, 'outside');
fs.mkdirSync(outside);
const OUTSIDE_MARK = 'outside-the-fence-4e1b';
fs.writeFileSync(path.join(outside, 'notes.md'), OUTSIDE_MARK + String.fromCharCode(10));

const BENIGN = 'Shopping list: 12 eggs, 500 g flour, a teal ribbon for the robot costume.';
const CANARY_MARK = 'hunter2-canary-duet-51c9';
const CANARY = [
    '# production credentials — DO NOT SHARE',
    `root password: ${CANARY_MARK}`,
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
    '-----END OPENSSH PRIVATE KEY-----'
].join('\n');
fs.writeFileSync(path.join(workspace, 'benign.md'), `# notes\n\n${BENIGN}\n`);
// Secrets under a dull name: the test is about what the file CONTAINS. Called canary.md, the
// gate withheld the request that merely named it, before any file was read.
fs.writeFileSync(path.join(workspace, 'todo.md'), CANARY);

let pass = 0, fail = 0, skip = 0;
// A harmless turn the gate withheld is gate friction, a model's judgement — not a broken
// path. Reported as what it is, with the gate's reason, so the two are never confused.
const skipped = (label, why) => { skip++; console.log(`  skip ${label} — the gate withheld a harmless turn: ${why}`); };
const ok = (cond, label, detail = '') => {
    if (cond) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
};

// ─────────────────────── the fake far side ───────────────────────

/** Every chat body the "remote model" was sent, as raw text. */
const received = [];
const leakedSince = n => received.slice(n).some(b => b.includes(CANARY_MARK) || b.includes('PRIVATE KEY'));

function sse(res, chunks) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
}

const answer = text => [
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }
];

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
            const { messages = [], tools } = JSON.parse(body || '{}');
            const last = messages[messages.length - 1] || {};

            // Offered tools, the "model" decides for itself which file to open — the request
            // never names one. A request that NAMES a local file is withheld by the 14B gate
            // before anything is read ("the request involves a local file"), which would
            // leave the file-result path untested; a real model choosing its own reads is
            // also the more honest picture of what the gate must catch.
            const text = last.content || '';
            const file = /check the notes/i.test(text) ? 'benign.md'
                : /check my list/i.test(text) ? 'todo.md' : null;
            if (last.role === 'user' && file && tools?.length) {
                return sse(res, [{
                    choices: [{ delta: { tool_calls: [{
                        index: 0, id: 'call_1', type: 'function',
                        function: { name: 'read_file', arguments: JSON.stringify({ path: file }) }
                    }] } }]
                }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }],
                     usage: { prompt_tokens: 10, completion_tokens: 5 } }]);
            }
            // Section 6 needs a reply no earlier section produced: "Noted." is ruled on, and
            // released, long before it runs.
            return sse(res, answer(last.role === 'tool' ? 'Read it.'
                : /Hello there\./.test(text) ? 'Hello back — words only section 6 hears.' : 'Noted.'));
        }
        res.writeHead(404); res.end();
    });
});

// ─────────────────────── the stand-in gate ───────────────────────
//
// A fake Ollama, so the LOCAL side is under test control too. Its one model is the gate,
// and it releases everything it is asked about.
//
// Why: this file proves plumbing — that every route to a cloud model passes through the
// scanner and a gate ruling — and a real gate model makes that depend on its judgement,
// which on the 14B changed from run to run ("Please read benign.md" released once;
// "Please check the notes." withheld as "vague" the next). How well a gate MODEL judges is
// what tools/gate_bench.js measures. Here the model says yes to everything, so a secret
// that stays home stayed home because the deterministic scanner caught it on that route —
// and a route that skipped the gate would leak, and fail.

const GATE_MODEL = 'stand-in-gate:1b';
const gateAsked = [];               // every text the stand-in gate was asked to rule on

const fakeOllama = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
        const json = obj => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (req.url === '/api/tags') return json({ models: [{ name: GATE_MODEL, size: 2e9 }] });
        if (req.url === '/api/show') return json({ capabilities: ['completion'] });
        if (req.url === '/api/version') return json({ version: '0.0.0-stand-in' });
        if (req.url === '/api/ps') return json({ models: [] });
        if (req.url === '/api/chat') {
            const { messages = [] } = JSON.parse(body || '{}');
            gateAsked.push(messages.map(m => m.content).join('\n'));
            res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
            res.end(JSON.stringify({
                message: { role: 'assistant', content: '{"release": true, "reason": "stand-in gate", "concerns": []}' },
                done: true
            }) + '\n');
            return;
        }
        res.writeHead(404); res.end();
    });
});
const OLLAMA_PORT = 8163;

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

/** POST a duet send and read the NDJSON stream to the end. */
async function send(threadId, payload) {
    const res = await fetch(`${BASE}/api/duet/${threadId}/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const text = await res.text();
    if (!res.ok) return { status: res.status, error: text, events: [] };
    const events = text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return { status: res.status, events, last: type => [...events].reverse().find(e => e.type === type) };
}

const exposureNotes = async threadId =>
    ((await api('GET', `/api/threads/${threadId}/exposure`)).body?.packets || [])
        .flatMap(p => p.crossings.map(c => c.note));

async function waitFor(child) {
    for (let i = 0; i < 80; i++) {
        if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})`);
        try { if ((await fetch(`${BASE}/api/whoami`)).ok) return; } catch { /* not yet */ }
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error('server never came up');
}

/** A fresh duet thread with the workspace set and the right side pointed at the fake. */
async function duetThread(folderId, title) {
    const thread = (await api('POST', '/api/threads', { folderId, title })).body;
    await api('POST', '/api/workspace', { threadId: thread.id, root: workspace });
    const duet = (await api('GET', `/api/duet/${thread.id}`)).body;
    const right = duet.participants.find(p => p.slot === 'b');
    await api('PATCH', `/api/duet/participants/${right.id}`, { model: FAKE_MODEL });
    return { thread, right };
}

// ─────────────────────── the run ───────────────────────

async function main() {
    console.log('\nAirlock duet: workspace files, and every route to a cloud model\n');

    await new Promise(r => fake.listen(FAKE_PORT, '127.0.0.1', r));
    await new Promise(r => fakeOllama.listen(OLLAMA_PORT, '127.0.0.1', r));

    const child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(PORT),
            AIRLOCK_DB: path.join(tmp, 'duet-tools.db'),
            AIRLOCK_CONFIG: path.join(tmp, 'config.json'),
            // Parent values win over .env, so the real key and endpoint cannot reach this
            // server. Checked below before anything is sent, rather than trusted.
            NEBIUS_API_KEY: 'fake-key-for-a-local-test',
            NEBIUS_BASE_URL: `http://127.0.0.1:${FAKE_PORT}`,
            AIRLOCK_MODEL_CLASSIFIER: FAKE_MODEL,
            OLLAMA_URL: `http://127.0.0.1:${OLLAMA_PORT}`,
            AIRLOCK_GATE_MODEL: GATE_MODEL,
            AIRLOCK_REMOTE_ALLOW: '',
            AIRLOCK_TOKEN: '',
            AIRLOCK_REMOTE_BUDGET: '',
            // Only the test workspace is permitted, so the fenced case is real.
            AIRLOCK_WORKSPACE_ROOTS: workspace
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    child.stdout.on('data', d => log += d);
    child.stderr.on('data', d => log += d);

    try {
        await waitFor(child);

        const health = await api('GET', '/api/health');
        const remote = (health.body?.models || []).filter(m => m.tier === 'remote').map(m => m.name);
        const isolated = remote.length === 1 && remote[0] === FAKE_MODEL;
        ok(isolated, 'the server under test can reach only the fake remote', remote.join(', '));
        if (!isolated) throw new Error('refusing to continue: this server could reach a real remote tier');

        const folderId = (await api('GET', '/api/tree')).body[0].id;

        // ── 0. files are opt-in ──
        console.log('\nfiles are opt-in, per request');
        const { thread: t0, right: r0 } = await duetThread(folderId, 'opt-in');
        const n0 = received.length;
        const s0 = await send(t0.id, { participantId: r0.id, text: 'Please check the notes.', clientRequestId: 'optin-1' });
        // Asking the user for a result is offered to every tool-capable side; the FILE tools
        // only when switched on. The fake calls read_file whenever it sees any tools at all —
        // exactly the model that names a tool it was not given.
        const offeredNames = received.slice(n0).flatMap(b => (JSON.parse(b).tools || []).map(t => t.function?.name));
        ok(!offeredNames.some(n => n !== 'request_result'),
            'a remote side not switched to files is never offered the file tools', offeredNames.join(', '));
        const notRun = s0.events.find(e => e.type === 'tool');
        ok(notRun && !notRun.ok && /not offered/.test(notRun.summary),
            'and a file tool it calls anyway is refused, not run', JSON.stringify(notRun));

        // ── 0b. a folder no longer permitted ──
        // A thread whose root was saved before AIRLOCK_WORKSPACE_ROOTS fenced it off —
        // written straight into the db here — is offered no file tools, even switched on,
        // and nothing in it is read. (This case first proved the hole in the old /api/chat,
        // 2026-10-13; the duet has always refused it, and now it is held to that.)
        console.log('\na workspace saved before it was fenced off');
        const { thread: tf, right: rf } = await duetThread(folderId, 'fenced');
        {
            const { DatabaseSync } = require('node:sqlite');
            const db = new DatabaseSync(path.join(tmp, 'duet-tools.db'));
            db.prepare('UPDATE threads SET workspace_root = ? WHERE id = ?').run(outside, tf.id);
            db.close();
        }
        const nf = received.length;
        const sf = await send(tf.id, { participantId: rf.id, text: 'Please check the notes.', tools: true, clientRequestId: 'fenced-1' });
        const fileTools = received.slice(nf).flatMap(b => (JSON.parse(b).tools || []).map(t => t.function?.name)).filter(n => n !== 'request_result');
        ok(!fileTools.length, 'a fenced folder is offered no file tools, even switched on', fileTools.join(', '));
        const fencedCall = sf.events.find(e => e.type === 'tool');
        ok(!fencedCall || (!fencedCall.ok && /not offered/.test(fencedCall.summary)),
            'and a file tool the model calls anyway is refused, not run', JSON.stringify(fencedCall));
        ok(!received.slice(nf).some(b => b.includes(OUTSIDE_MARK)), 'NOTHING from the fenced folder reached the far side');

        // ── 1. directly: a remote participant reads a file ──
        console.log('\n1. a remote participant reads a file for itself');
        const { thread: t1, right: r1 } = await duetThread(folderId, 'direct');
        const n1 = received.length;
        const s1 = await send(t1.id, { participantId: r1.id, text: 'Please check the notes.', tools: true, clientRequestId: 'direct-1' });
        const done1 = s1.last('done');
        if (s1.last('blocked') && !s1.last('blocked').withheld) {
            ok(false, 'the gate releases the request itself', s1.last('blocked').gate?.reason);
        } else {
            ok(s1.events.some(e => e.type === 'tool' && e.name === 'read_file' && e.ok),
                'the model asks for the file, and the tool runs locally');
            ok(s1.events.filter(e => e.type === 'gating').length === 2,
                'the gate rules twice: on the request, then on the file result before it goes',
                `gating events: ${s1.events.filter(e => e.type === 'gating').length}`);
            ok(received.slice(n1).some(b => b.includes(BENIGN.slice(0, 30))),
                'the harmless file arrived — so it is exactly what the record must cover');
            ok(gateAsked.some(t => t.includes(BENIGN.slice(0, 30))),
                'and the gate was shown the file\'s contents before they went, not only the request');
            ok(done1?.message.requestMeta?.tools?.some(t => t.name === 'read_file' && /benign\.md/.test(t.label)),
                'the reply records which file it read', JSON.stringify(done1?.message.requestMeta?.tools));
            const read1 = done1?.message.requestMeta?.tools?.find(t => t.name === 'read_file');
            ok(['12', '500'].every(v => read1?.figures?.some(f => f.v === v && f.ctx.includes(v))),
                'and the numbers it was shown, with the words around each — for the figure marks', JSON.stringify(read1?.figures));
            const notes1 = await exposureNotes(t1.id);
            ok(notes1.some(n => /read_file\(benign\.md\).*sha:[0-9a-f]{12}/.test(n)),
                '"what has crossed" names the file, with its size and hash', notes1.join(' | '));
            const budget1 = done1?.message?.requestMeta?.budgetChars;
            ok(budget1 > (8192 - 1024) * 3.4,
                'a cloud side is budgeted by the cloud context, not squeezed into the local window', String(budget1));
            const kinds1 = (await api('GET', `/api/threads/${t1.id}/exposure`)).body?.kinds || {};
            ok(kinds1.model?.packets >= 1 && kinds1.results?.crossings >= 1 && kinds1.model.to.includes(FAKE_MODEL),
                'the record says what kind each crossing was: messages to the model, and the tool results it read',
                JSON.stringify(Object.keys(kinds1)));
        }

        // Its reply read the file. Asked again, that reply is context crossing again — and
        // the record now says which file stood behind it.
        const s1b = await send(t1.id, { participantId: r1.id, text: 'Anything else?', clientRequestId: 'direct-2' });
        const trace = s => JSON.stringify(s.events.filter(e => e.type !== 'token')
            .map(e => [e.type, e.gate?.reason || e.error || e.name || '']));
        if (s1b.last('blocked')) {
            skipped('a follow-up crosses with the earlier reply as context', s1b.last('blocked').gate?.reason);
        } else {
            ok(s1b.last('done'), 'a follow-up crosses with the earlier reply as context', trace(s1b));
            const notes1b = await exposureNotes(t1.id);
            ok(notes1b.some(n => /had read from the workspace: read_file\(benign\.md\)/.test(n)),
                'and the crossing record names the file that reply had read', notes1b.join(' | '));
        }

        console.log('\n   …and a file of secrets');
        const n1c = received.length;
        const s1c = await send(t1.id, { participantId: r1.id, text: 'Could you check my list too?', tools: true, clientRequestId: 'direct-3' });
        const blocked1 = s1c.last('blocked');
        if (blocked1 && !blocked1.withheld) {
            skipped('the gate withholds the file result mid-turn',
                `${blocked1.gate?.reason} (the request itself was withheld, before any file was read)`);
        } else {
            ok(blocked1?.withheld?.some(w => /read_file\(todo\.md\)/.test(w)),
                'the gate withholds the file result mid-turn, and says which', trace(s1c));
        }
        ok(!leakedSince(n1c), 'NOTHING from the secrets file arrived at the far side');
        ok(!(await exposureNotes(t1.id)).some(n => /todo\.md/.test(n)),
            'and it is not recorded as crossed, because it did not');

        // ── 2. shared history ──
        console.log('\n2. the secrets are in the conversation, and a remote side is asked');
        const { thread: t2, right: r2 } = await duetThread(folderId, 'shared history');
        // What a local participant says after reading canary.md: a quotation, in the log.
        const quoted = (await api('POST', '/api/packets', {
            threadId: t2.id, role: 'assistant',
            content: `todo.md says:\n${CANARY}`, model: 'local-quoter'
        })).body;
        ok(Boolean(quoted?.id), 'a reply quoting the secrets sits in the shared conversation');
        const n2 = received.length;
        const s2 = await send(t2.id, { participantId: r2.id, text: 'Summarise the conversation so far.', clientRequestId: 'shared-1' });
        ok(Boolean(s2.last('blocked')), 'asking the remote side is withheld — the quotation is ruled on as it enters that context',
            JSON.stringify(s2.last('blocked')?.gate?.reason));
        ok(!leakedSince(n2), 'NOTHING from the quotation arrived at the far side');

        // ── 3. moved ──
        console.log('\n3. the quotation is moved to another thread and crosses from there');
        const { thread: t3, right: r3 } = await duetThread(folderId, 'moved');
        const moved = await api('POST', `/api/packets/${quoted.id}/move`, { toThreadId: t3.id });
        ok(moved.status === 200, 'the quotation moves');
        const n3 = received.length;
        const s3 = await send(t3.id, { participantId: r3.id, text: 'What do you make of this?', clientRequestId: 'moved-1' });
        ok(Boolean(s3.last('blocked')), 'asking the remote side there is withheld too');
        ok(!leakedSince(n3), 'NOTHING from it arrived at the far side');

        // ── 3b. one message, exported ──
        //
        // A single message dragged or copied out goes wherever the drop lands, so Airlock
        // cannot gate it with a model — but the scanner runs on the way out, in the page for
        // the drag's text and here for the Shift-drag .md file.
        console.log('\n3b. one message, dragged out as a file');
        const md = await api('GET', `/api/packets/${quoted.id}/packet.md`);
        ok(md.status === 403 && !md.text.includes(CANARY_MARK) && !md.text.includes('PRIVATE KEY'),
            'a message holding a private key is not exported as a file, and the refusal does not quote it',
            `${md.status} ${md.text.slice(0, 80)}`);
        const clean = (await api('POST', '/api/packets', { threadId: t3.id, role: 'user', content: 'A teal ribbon, please.' })).body;
        const cleanMd = await api('GET', `/api/packets/${clean.id}/packet.md`);
        ok(cleanMd.status === 200 && cleanMd.text.includes('A teal ribbon'), 'a clean one is');
        const served = await api('GET', '/secrets.js');
        ok(served.status === 200 && /AirlockSecrets/.test(served.text),
            'the page is served the same scanner the gate runs, for drags and copies');

        // ── 4. by hand ──
        console.log('\n4. carried out by hand');
        const c3 = await api('POST', `/api/threads/${t3.id}/carry`, { actor: 'a web chat' });
        ok(c3.body?.released === false, 'a brief holding the secrets is withheld', JSON.stringify(c3.body?.gate?.reason));
        ok(!c3.text.includes(CANARY_MARK) && !c3.text.includes('PRIVATE KEY'),
            'and the withheld response does not contain the brief');

        const { thread: t4 } = await duetThread(folderId, 'harmless');
        await api('POST', '/api/packets', { threadId: t4.id, role: 'user', content: 'Plan the robot costume: teal, with ribbons.' });
        const c4 = await api('POST', `/api/threads/${t4.id}/carry`, { actor: 'a web chat' });
        if (!c4.body?.released) {
            ok(false, 'a harmless brief is released', JSON.stringify(c4.body?.gate));
        } else {
            ok(Boolean(c4.body.token && c4.body.markdown), 'a harmless brief is released, with a token for the record');
            // What the brief says — checked here, on the route that builds it for real, since
            // the old preview routes (/brief, /brief.md) are gone.
            const md = c4.body.markdown;
            ok(md.startsWith(`# Airlock brief — harmless`), 'the brief is headed with its thread', md.split('\n')[0]);
            ok(md.includes('Plan the robot costume: teal, with ribbons.'), 'it holds what the thread said');
            ok(md.includes('Asked of a web chat'), 'and is addressed to where it is going');
            ok((await exposureNotes(t4.id)).length === 0, 'released is not carried: nothing is recorded until it leaves');
            const carried = await api('POST', `/api/threads/${t4.id}/carried`, { token: c4.body.token });
            ok(carried.body?.crossed === 1, 'copying it out records the crossing then and there', JSON.stringify(carried.body));
            const notes4 = await exposureNotes(t4.id);
            ok(notes4.some(n => /^hand · a web chat · gate=released/.test(n)),
                'by hand, to where, and that the gate released it', notes4.join(' | '));
            const kinds4 = (await api('GET', `/api/threads/${t4.id}/exposure`)).body?.kinds || {};
            ok(JSON.stringify(Object.keys(kinds4)) === '["carried"]' && kinds4.carried.to[0] === 'a web chat',
                'a carry is counted as carried by hand — not as sent to a model', JSON.stringify(kinds4));
            const again = await api('POST', `/api/threads/${t4.id}/carried`, { token: c4.body.token });
            ok(again.body?.crossed === 0, 'copying the same brief twice is one crossing, not two');
        }

        const forged = await api('POST', `/api/threads/${t4.id}/carried`, { token: 'made-up' });
        ok(forged.status === 400, 'a carry the server never ruled on cannot be recorded');

        const liar = await api('POST', `/api/threads/${t3.id}/handoff`, {
            actor: 'a web chat', verdict: 'fine', tier: 'remote',
            packetIds: [quoted.id], gate: { release: true, reason: 'trust me' }
        });
        const liarNotes = await exposureNotes(t3.id);
        ok(liar.status === 200 && !liarNotes.some(n => /gate=released/.test(n)),
            'a handoff that claims its own "released" ruling is not recorded as released', liarNotes.join(' | '));

        const forced = await api('POST', `/api/threads/${t3.id}/carry`, { actor: 'a web chat', force: true });
        ok(forced.body?.released === true && forced.body.gate?.forced, 'the operator can carry it anyway');
        await api('POST', `/api/threads/${t3.id}/carried`, { token: forced.body.token });
        ok((await exposureNotes(t3.id)).some(n => /gate=FORCED/.test(n)),
            'and the record says the gate was bypassed, permanently');

        // ── 5. deleting: the words go, the record stays ──
        // Asked for 2026-10-14: any input or output can be deleted. Deleting erases the text
        // on this machine — from the conversation, from every later context, from the file
        // on disk — and keeps the crossing: the far side still has it, and the record must
        // not pretend otherwise.
        console.log('\n5. deleting a message, and a thread');
        const DELETE_MARK = 'violet-heron-take-back-3c7e';
        const { thread: t5, right: r5 } = await duetThread(folderId, 'take back');
        const s5 = await send(t5.id, { participantId: r5.id, text: `My locker code is ${DELETE_MARK}.`, clientRequestId: 'del-1' });
        const asked5 = s5.events.find(e => e.type === 'user')?.message;
        ok(Boolean(s5.last('done')) && received.some(b => b.includes(DELETE_MARK)),
            'a message crosses to the remote side', trace(s5));
        const before5 = await api('GET', `/api/threads/${t5.id}/exposure`);
        ok(before5.body.packets.some(p => p.packetId === asked5?.id), 'and is on the record as crossed');

        const del = await api('DELETE', `/api/packets/${asked5?.id}`);
        ok(del.status === 200 && del.body?.message?.status === 'deleted' && del.body.message.content === '',
            'deleting it erases the text and marks it deleted', JSON.stringify(del.body).slice(0, 200));
        ok(del.body?.message?.requestMeta?.crossed === true && del.body.message.requestMeta.crossedTo?.includes(FAKE_MODEL),
            'and the stub still says it had crossed, and to whom', JSON.stringify(del.body?.message?.requestMeta));

        const conv5 = (await api('GET', `/api/duet/${t5.id}`)).body;
        ok(!JSON.stringify(conv5).includes(DELETE_MARK), 'the conversation no longer holds the words');
        const after5 = await api('GET', `/api/threads/${t5.id}/exposure`);
        const rec5 = after5.body.packets.find(p => p.packetId === asked5?.id);
        ok(rec5 && rec5.deletedAt && rec5.preview === '' && rec5.crossings.length >= 1,
            'the crossing stays on the record, with no preview and the time it was deleted', JSON.stringify(rec5));
        const prov5 = await api('GET', `/api/packets/${asked5?.id}/provenance`);
        ok((prov5.body || []).some(e => e.event === 'deleted' && /after crossing/.test(e.note || '')),
            'and the deletion itself is recorded, saying it came after the crossing');

        const n5 = received.length;
        const s5b = await send(t5.id, { participantId: r5.id, text: 'What did I tell you a moment ago?', clientRequestId: 'del-2' });
        ok(Boolean(s5b.last('done')) && !received.slice(n5).some(b => b.includes(DELETE_MARK)),
            'a later turn to the remote side does not carry the deleted words', trace(s5b));

        const onDisk = ['duet-tools.db', 'duet-tools.db-wal']
            .map(f => path.join(tmp, f)).filter(f => fs.existsSync(f))
            .some(f => fs.readFileSync(f).includes(DELETE_MARK));
        ok(!onDisk, 'and the words are not left in the database file, or its write-ahead log');

        const again5 = await api('DELETE', `/api/packets/${asked5?.id}`);
        ok(again5.status === 200, 'deleting it twice is harmless');

        const gone = await api('DELETE', `/api/threads/${t5.id}`);
        ok(gone.status === 200 && gone.body?.crossingsKept >= 1, 'deleting the thread keeps its crossings', JSON.stringify(gone.body));
        const kept5 = await api('GET', '/api/crossings/deleted');
        ok((kept5.body || []).some(k => k.thread === 'take back' && k.actor === FAKE_MODEL && !JSON.stringify(k).includes(DELETE_MARK)),
            'they are listed as crossed from a deleted thread — where and when, with no content');
        ok(((await api('GET', '/api/stats')).body?.deletedCrossings || 0) >= 1, 'and counted in the desk stats');

        // ── 6. a model's own earlier reply is not put to the gate ──
        // Measured 2026-10-14: on every follow-up turn the gate was shown the remote side's
        // previous reply on its own, and the 14B withheld "assistant: fine". The far side's
        // own words going back to it are not new exposure — but only when this same remote
        // model wrote them.
        console.log('\n6. a remote model\'s own earlier reply, going back to it');
        const { thread: t6, right: r6 } = await duetThread(folderId, 'own words');
        await send(t6.id, { participantId: r6.id, text: 'Hello there.', clientRequestId: 'own-1' });
        const g6 = gateAsked.length;
        const s6 = await send(t6.id, { participantId: r6.id, text: 'And one more thing.', clientRequestId: 'own-2' });
        const shown6 = gateAsked.slice(g6).join('\n');
        ok(Boolean(s6.last('done')), 'the follow-up crosses', trace(s6));
        ok(/And one more thing\./.test(shown6) && !/Hello back/.test(shown6),
            'the gate reads the new message, not the remote side\'s own reply', shown6.slice(-300));

        // A reply this side wrote under a LOCAL model is local text: switched to a remote
        // model, the side sends it as context, and it is ruled on.
        const { thread: t7, right: r7 } = await duetThread(folderId, 'switched side');
        await api('PATCH', `/api/duet/participants/${r7.id}`, { model: GATE_MODEL });
        const s7a = await send(t7.id, { participantId: r7.id, text: 'Jot down a thought.', clientRequestId: 'sw-1' });
        const localReply = s7a.last('done')?.message?.content || '';
        await api('PATCH', `/api/duet/participants/${r7.id}`, { model: FAKE_MODEL });
        const g7 = gateAsked.length;
        await send(t7.id, { participantId: r7.id, text: 'Now carry on.', clientRequestId: 'sw-2' });
        const shown7 = gateAsked.slice(g7).join('\n');
        ok(localReply && shown7.includes(localReply.slice(0, 20)),
            'a reply the side wrote under a local model is ruled on when it crosses', `${localReply.slice(0, 40)} | ${shown7.slice(-200)}`);
    } finally {
        child.kill();
        if (child.exitCode === null) await new Promise(r => child.once('exit', r));
        await new Promise(r => fake.close(r));
        await new Promise(r => fakeOllama.close(r));
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
    console.error('\nduet_tools_test failed:', err.stack || err.message);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    process.exitCode = 1;
});
