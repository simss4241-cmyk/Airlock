'use strict';

/**
 * Chatter: the two participants answering each other.  node tools/duet_chatter_test.js
 *
 * A chatter turn — a relay — is a reply to the OTHER participant's finished reply, with no
 * new request typed by anyone. That makes it the one generation the user did not write the
 * prompt for, so it is held to the same boundary as everything else and checked hard:
 *
 *   - a relay is addressed to the participant it answers, and labelled that way
 *   - toward a remote side it is gated, and recorded as a crossing, like any turn
 *   - a relay whose context holds a secret is withheld, and nothing arrives
 *   - something the user said mid-run is in the next relay's context
 *   - a relay pointed anywhere it should not be (its own reply, a request, an unfinished
 *     reply, another thread) is refused before anything runs
 *
 * Both sides are fakes, so this needs no Ollama, no key and no credit, and sends nothing
 * off this machine: a fake Token Factory plays Right and records every body it receives; a
 * fake Ollama plays Left, and also the gate — a stand-in that releases everything, so
 * every refusal here is the deterministic secret scanner's (see duet_tools_test.js).
 */

const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const REMOTE_PORT = 8171;
const OLLAMA_PORT = 8173;
const PORT = 8172;
const BASE = `http://127.0.0.1:${PORT}`;
const REMOTE_MODEL = 'fake/remote-model';
const LOCAL_MODEL = 'stand-in-local:1b';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airlock-chatter-'));
const CANARY_MARK = 'hunter2-canary-chatter-7d21';

let pass = 0, fail = 0;
const ok = (cond, label, detail = '') => {
    if (cond) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
};

// ─────────────────────── the fake far side: Right ───────────────────────

const received = [];        // every chat body Right was sent
const leakedSince = n => received.slice(n).some(b => b.includes(CANARY_MARK) || b.includes('PRIVATE KEY'));

function sse(res, text) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 6 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
}

const remote = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
        if (req.method === 'GET' && req.url.endsWith('/models')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ data: [{ id: REMOTE_MODEL, object: 'model' }] }));
        }
        if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
            received.push(body);
            return sse(res, `Right, turn ${received.length}: interesting point.`);
        }
        res.writeHead(404); res.end();
    });
});

// ─────────────────────── the local side: Left, and the gate ───────────────────────

let leftTurns = 0;
const ollama = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
        const json = obj => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (req.url === '/api/tags') return json({ models: [{ name: LOCAL_MODEL, size: 2e9 }] });
        if (req.url === '/api/show') return json({ capabilities: ['completion'] });
        if (req.url === '/api/version') return json({ version: '0.0.0-stand-in' });
        if (req.url === '/api/ps') return json({ models: [] });
        if (req.url === '/api/chat') {
            const { messages = [] } = JSON.parse(body || '{}');
            const isGate = /boundary gate for Airlock/.test(messages[0]?.content || '');
            const content = isGate
                ? '{"release": true, "reason": "stand-in gate", "concerns": []}'
                // A model that thinks and then says nothing: complete, and empty.
                : /say nothing/.test(messages[messages.length - 1]?.content || '') ? ''
                : `Left, turn ${++leftTurns}: I see it differently.`;
            res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
            res.end(JSON.stringify({ message: { role: 'assistant', content }, done: true,
                eval_count: 6, prompt_eval_count: 20, eval_duration: 1e8 }) + '\n');
            return;
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

async function send(threadId, payload) {
    const res = await fetch(`${BASE}/api/duet/${threadId}/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const text = await res.text();
    if (!res.ok) {
        let error = text; try { error = JSON.parse(text).error; } catch { /* plain */ }
        return { status: res.status, error, events: [], last: () => null };
    }
    const events = text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return { status: res.status, events, last: type => [...events].reverse().find(e => e.type === type) };
}

const exposureNotes = async threadId =>
    ((await api('GET', `/api/threads/${threadId}/exposure`)).body?.packets || [])
        .flatMap(p => p.crossings.map(c => `#${p.packetId} ${c.note}`));

async function waitFor(child) {
    for (let i = 0; i < 80; i++) {
        if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})`);
        try { if ((await fetch(`${BASE}/api/whoami`)).ok) return; } catch { /* not yet */ }
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error('server never came up');
}

/** A duet thread: Left on the stand-in local model, Right on the fake remote. */
async function chatterThread(folderId, title) {
    const thread = (await api('POST', '/api/threads', { folderId, title })).body;
    const duet = (await api('GET', `/api/duet/${thread.id}`)).body;
    let left = duet.participants.find(p => p.slot === 'a');
    let right = duet.participants.find(p => p.slot === 'b');
    left = (await api('PATCH', `/api/duet/participants/${left.id}`, { model: LOCAL_MODEL })).body;
    right = (await api('PATCH', `/api/duet/participants/${right.id}`, { model: REMOTE_MODEL })).body;
    return { thread, left, right };
}

// ─────────────────────── the run ───────────────────────

async function main() {
    console.log('\nAirlock duet: chatter — the participants answering each other\n');

    await new Promise(r => remote.listen(REMOTE_PORT, '127.0.0.1', r));
    await new Promise(r => ollama.listen(OLLAMA_PORT, '127.0.0.1', r));

    const child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(PORT),
            AIRLOCK_DB: path.join(tmp, 'chatter.db'),
            AIRLOCK_CONFIG: path.join(tmp, 'config.json'),
            NEBIUS_API_KEY: 'fake-key-for-a-local-test',
            NEBIUS_BASE_URL: `http://127.0.0.1:${REMOTE_PORT}`,
            AIRLOCK_MODEL_CLASSIFIER: REMOTE_MODEL,
            OLLAMA_URL: `http://127.0.0.1:${OLLAMA_PORT}`,
            AIRLOCK_GATE_MODEL: LOCAL_MODEL,
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

        const health = (await api('GET', '/api/health')).body;
        const remotes = (health?.models || []).filter(m => m.tier === 'remote').map(m => m.name);
        const isolated = remotes.length === 1 && remotes[0] === REMOTE_MODEL;
        ok(isolated, 'the server under test can reach only the fake remote', remotes.join(', '));
        if (!isolated) throw new Error('refusing to continue: this server could reach a real remote tier');

        const folderId = (await api('GET', '/api/tree')).body[0].id;
        const { thread, left, right } = await chatterThread(folderId, 'chatter');

        // ── the opening: the user asks Left something ──
        console.log('\nthe opening');
        const opened = await send(thread.id, { participantId: left.id, text: 'Should robots be teal?', clientRequestId: 'open-1' });
        const leftReply = opened.last('done')?.message;
        ok(leftReply?.status === 'complete' && leftReply.authorId === left.id,
            'Left answers the user', JSON.stringify(opened.events.map(e => e.type)));

        // ── 1. Right answers Left: a relay toward the far side ──
        console.log('\n1. Right answers Left — across the boundary');
        const n1 = received.length;
        const r1 = await send(thread.id, { participantId: right.id, relayOf: leftReply.id });
        const rightReply = r1.last('done')?.message;
        ok(r1.events[0]?.type === 'relay' && r1.events[0].message.id === leftReply.id,
            'the turn announces which reply it answers, and writes no request');
        ok(r1.events.some(e => e.type === 'gating'), 'the relay is gated before it goes');
        ok(rightReply?.status === 'complete' && rightReply.authorId === right.id && rightReply.recipientId === left.id,
            "Right's reply is addressed to Left, not to the user", JSON.stringify({
                author: rightReply?.authorId, recipient: rightReply?.recipientId }));
        ok(rightReply?.requestMeta?.relayOf === leftReply.id && rightReply.requestMeta.crossed === true,
            'it records what it answered, and that it crossed');

        const body1 = JSON.parse(received[n1] || '{}');
        const system1 = body1.messages?.[0]?.content || '';
        const newest1 = body1.messages?.[body1.messages.length - 1]?.content || '';
        ok(/answer LEFT directly/.test(system1), 'Right is told, in its system message, to answer Left');
        ok(newest1.includes('Left, turn 1') && /→/.test(newest1),
            "and Left's reply reaches it as labelled conversation", newest1.slice(0, 120));

        const conversation1 = (await api('GET', `/api/duet/${thread.id}`)).body.messages;
        ok(conversation1.filter(m => m.role === 'user').length === 1,
            'a relay adds a reply and nothing else — no request was written for it');
        const notes1 = await exposureNotes(thread.id);
        ok(notes1.some(n => n.startsWith(`#${leftReply.id} `) && /duet · fake\/remote-model/.test(n)),
            "Left's reply is recorded as having crossed to Right", notes1.join(' | '));

        // ── 2. Left answers Right: local, nothing crosses ──
        console.log('\n2. Left answers Right — on this machine');
        const n2 = received.length;
        const r2 = await send(thread.id, { participantId: left.id, relayOf: rightReply.id });
        const leftAgain = r2.last('done')?.message;
        ok(leftAgain?.recipientId === right.id && leftAgain.authorId === left.id,
            "Left's reply is addressed to Right");
        ok(!r2.events.some(e => e.type === 'gating') && received.length === n2,
            'a relay to the local side is not gated and sends nothing anywhere');

        // ── 3. the user joins in, and the next relay hears it ──
        console.log('\n3. the user joins in mid-run');
        const interjection = 'Both of you: what about turquoise?';
        const joined = await send(thread.id, { participantId: left.id, text: interjection, clientRequestId: 'join-1' });
        const leftHeard = joined.last('done')?.message;
        const n3 = received.length;
        const r3 = await send(thread.id, { participantId: right.id, relayOf: leftHeard.id });
        ok(r3.last('done')?.message?.status === 'complete', 'the run carries on from the answer to the interjection');
        ok((received[n3] || '').includes('what about turquoise'),
            "and the user's interjection is in the next relay's context");

        // ── the token ledger: every call, where it was made ──
        console.log('\nthe token ledger');
        const spent = (await api('GET', '/api/usage')).body;
        const row = (model, purpose) => spent.models.find(r => r.model === model && r.purpose === purpose);
        ok(row(LOCAL_MODEL, 'reply')?.calls >= 3 && row(LOCAL_MODEL, 'reply').tier === 'local',
            "Left's replies are on the ledger, as local", JSON.stringify(row(LOCAL_MODEL, 'reply')));
        ok(row(REMOTE_MODEL, 'reply')?.calls >= 2 && row(REMOTE_MODEL, 'reply').tier === 'remote',
            "Right's replies are on it, as across the boundary", JSON.stringify(row(REMOTE_MODEL, 'reply')));
        ok(row(LOCAL_MODEL, 'reply').prompt === 20 * row(LOCAL_MODEL, 'reply').calls,
            'with the token counts the model reported, call by call');
        ok(row(LOCAL_MODEL, 'gate')?.calls >= 2,
            'and the gate reading each relay before it crossed is counted too — it never was before',
            JSON.stringify(row(LOCAL_MODEL, 'gate')));
        const here = (await api('GET', `/api/usage?threadId=${thread.id}`)).body;
        ok(here.threadId === thread.id && here.total.calls > 0 && here.total.calls <= spent.total.calls,
            'and it can be read for one thread');

        // ── 4. refusals: a relay pointed where it should not be ──
        console.log('\n4. a relay pointed anywhere else is refused');
        const own = await send(thread.id, { participantId: left.id, relayOf: leftHeard.id });
        ok(own.status === 400 && /own reply/.test(own.error), 'not at its own reply', own.error);
        const request = conversation1.find(m => m.role === 'user');
        const atRequest = await send(thread.id, { participantId: right.id, relayOf: request.id });
        ok(atRequest.status === 400 && /answers a reply/.test(atRequest.error), 'not at a request', atRequest.error);

        const { thread: other, right: otherRight } = await chatterThread(folderId, 'elsewhere');
        const across = await send(other.id, { participantId: otherRight.id, relayOf: leftHeard.id });
        ok(across.status === 400 && /another conversation/.test(across.error), 'not at another thread', across.error);

        const before4 = (await api('GET', '/api/stats')).body.packets;
        const ghost = await send(thread.id, { participantId: right.id, relayOf: 999999 });
        ok(ghost.status === 400 && (await api('GET', '/api/stats')).body.packets === before4,
            'not at nothing — and a refused relay writes nothing');

        const silent = (await send(thread.id, { participantId: left.id, text: 'Please say nothing.', clientRequestId: 'silent-1' })).last('done')?.message;
        ok(silent?.status === 'complete' && !silent.content, 'a model can finish with nothing to say');
        const toSilence = await send(thread.id, { participantId: right.id, relayOf: silent.id });
        ok(toSilence.status === 400 && /empty/.test(toSilence.error),
            'and an empty reply is not answered — the other side does not talk to silence', toSilence.error);

        // ── 5. a relay whose context holds a secret ──
        console.log('\n5. the reply being answered holds a secret');
        const leaked = (await api('POST', '/api/packets', {
            threadId: thread.id, role: 'assistant', model: LOCAL_MODEL,
            content: `Here is the deploy key:\n-----BEGIN OPENSSH PRIVATE KEY-----\n${CANARY_MARK}\n-----END OPENSSH PRIVATE KEY-----`
        })).body;
        const n5 = received.length;
        const r5 = await send(thread.id, { participantId: right.id, relayOf: leaked.id });
        const withheld = r5.last('blocked')?.message;
        ok(withheld?.status === 'blocked', 'the relay is withheld', JSON.stringify(r5.events.map(e => e.type)));
        ok(!leakedSince(n5), 'NOTHING of it arrived at the far side');
        const unfinished = await send(thread.id, { participantId: left.id, relayOf: withheld.id });
        ok(unfinished.status === 400 && /blocked/.test(unfinished.error),
            'and a withheld reply cannot itself be answered — the run stops there', unfinished.error);
    } finally {
        child.kill();
        if (child.exitCode === null) await new Promise(r => child.once('exit', r));
        await new Promise(r => remote.close(r));
        await new Promise(r => ollama.close(r));
        fs.rmSync(tmp, { recursive: true, force: true });
    }

    console.log(`\n${pass} passed, ${fail} failed\n`);
    if (fail) {
        if (/error/i.test(log)) console.log('server log (errors):\n' + log.split('\n').filter(l => /error/i.test(l)).slice(0, 10).join('\n'));
        process.exitCode = 1;
    }
}

main().catch(err => {
    console.error('\nduet_chatter_test failed:', err.stack || err.message);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    process.exitCode = 1;
});
