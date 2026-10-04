'use strict';

/**
 * Asking the user for a result, and the file tools that make a citation checkable.
 *
 *   node tools/duet_request_test.js
 *
 * request_result exists because models without it pretend: in a measured role-play they
 * reported running tests and supplied readings nobody took. Under test: a request is
 * recorded on the reply, the turn finishes with the model saying what it asked (no tools on
 * that last round), the user's answer is linked to the request it answers — refused if it
 * names the wrong thing — and both sides' contexts say what was asked and what answers it.
 *
 * And the two read tools added with it: search_text (where something is said) and
 * read_file with a line range (numbered lines), with the trace recording which files and
 * lines the model was shown — what the evidence marks read.
 *
 * Both sides are a fake Ollama scripted by the last line it is sent; it records every body.
 * Starts its own server on its own database. Needs no Ollama and sends nothing anywhere.
 */

const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OLLAMA_PORT = 8183;
const PORT = 8182;
const BASE = `http://127.0.0.1:${PORT}`;
const MODEL = 'stand-in:7b';          // can call tools
const PLAIN = 'plain:1b';             // cannot
const ASK = 'Measure the silence after the next pulse, in seconds.';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airlock-duet-request-'));
const workspace = path.join(tmp, 'workspace');
fs.mkdirSync(workspace);
// A long file, so a small window cannot hold it whole.
fs.writeFileSync(path.join(workspace, 'long.md'), Array.from({ length: 900 }, (_, i) => `Line ${i + 1}: a long note about the reactor and its pulses.`).join('\n'));
fs.writeFileSync(path.join(workspace, 'benign.md'),
    '# notes\n\nShopping list: eggs, flour, a teal ribbon for the robot costume.\nNothing else.\n');

let pass = 0, fail = 0;
function ok(cond, name, detail) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ─────────────────────── the fake Ollama ───────────────────────

const bodies = [];          // every /api/chat body that was not the gate's
const toolNames = body => (body.tools || []).map(t => t.function?.name);

const ollama = http.createServer((req, res) => {
    let raw = '';
    req.on('data', d => raw += d);
    req.on('end', () => {
        const json = obj => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (req.url === '/api/tags') return json({ models: [{ name: MODEL, size: 4e9 }, { name: PLAIN, size: 1e9 }] });
        if (req.url === '/api/show') {
            const { model, name } = JSON.parse(raw || '{}');
            return json({ capabilities: (model || name) === PLAIN ? ['completion'] : ['completion', 'tools'] });
        }
        if (req.url === '/api/version') return json({ version: '0.0.0-stand-in' });
        if (req.url === '/api/ps') return json({ models: [] });
        if (req.url !== '/api/chat') { res.writeHead(404); return res.end(); }

        const body = JSON.parse(raw || '{}');
        const messages = body.messages || [];
        const reply = (message) => {
            res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
            res.end(JSON.stringify({ message: { role: 'assistant', content: '', ...message }, done: true,
                eval_count: 5, prompt_eval_count: 20, eval_duration: 1e8 }) + '\n');
        };
        if (/boundary gate for Airlock/.test(messages[0]?.content || '')) {
            return reply({ content: '{"release": true, "reason": "stand-in gate", "concerns": []}' });
        }
        bodies.push(body);

        const last = messages[messages.length - 1] || {};
        const offered = toolNames(body);
        const call = (name, args) => reply({ tool_calls: [{ function: { name, arguments: args } }] });

        if (last.role === 'tool') {
            if (last.tool_name === 'request_result') return reply({ content: 'I asked the User to measure the silence.' });
            if (last.tool_name === 'search_text') return call('read_file', { path: 'benign.md', start_line: 3, end_line: 3 });
            return reply({ content: 'Line 3 of benign.md mentions the teal ribbon.' });
        }
        const text = last.content || '';
        if (/please measure/i.test(text) && offered.includes('request_result')) return call('request_result', { request: ASK });
        if (/find the ribbon/i.test(text) && offered.includes('search_text')) return call('search_text', { query: 'TEAL ribbon' });
        if (/read the long file/i.test(text) && offered.includes('read_file')) return call('read_file', { path: 'long.md' });
        return reply({ content: 'Noted.' });
    });
});

// ─────────────────────── helpers ───────────────────────

async function api(method, route, payload) {
    const res = await fetch(BASE + route, {
        method, headers: payload ? { 'Content-Type': 'application/json' } : {},
        body: payload ? JSON.stringify(payload) : undefined
    });
    const text = await res.text();
    try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: null }; }
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
    const events = text.split('\n').filter(Boolean).map(l => JSON.parse(l));
    return { status: res.status, events, last: type => [...events].reverse().find(e => e.type === type) };
}

async function waitFor(child) {
    for (let i = 0; i < 80; i++) {
        if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})`);
        try { if ((await fetch(`${BASE}/api/whoami`)).ok) return; } catch { /* not yet */ }
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error('server never came up');
}

const lastUser = body => [...(body.messages || [])].reverse().find(m => m.role === 'user')?.content || '';
const count = async threadId => (await api('GET', `/api/duet/${threadId}`)).body.messages.length;

// ─────────────────────── the run ───────────────────────

async function main() {
    console.log('\nAirlock duet: asking the user for a result, and searching the workspace\n');
    await new Promise(r => ollama.listen(OLLAMA_PORT, '127.0.0.1', r));

    const child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env, PORT: String(PORT),
            AIRLOCK_DB: path.join(tmp, 'request.db'), AIRLOCK_CONFIG: path.join(tmp, 'config.json'),
            NEBIUS_API_KEY: '', OLLAMA_URL: `http://127.0.0.1:${OLLAMA_PORT}`,
            AIRLOCK_GATE_MODEL: MODEL, AIRLOCK_TOKEN: '', AIRLOCK_REMOTE_BUDGET: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    child.stdout.on('data', d => log += d);
    child.stderr.on('data', d => log += d);

    try {
        await waitFor(child);
        const folderId = (await api('GET', '/api/tree')).body[0].id;
        const thread = (await api('POST', '/api/threads', { folderId, title: 'requests' })).body;
        await api('POST', '/api/workspace', { threadId: thread.id, root: workspace });
        const duet = (await api('GET', `/api/duet/${thread.id}`)).body;
        let left = duet.participants.find(p => p.slot === 'a');
        let right = duet.participants.find(p => p.slot === 'b');
        left = (await api('PATCH', `/api/duet/participants/${left.id}`, { model: MODEL })).body;
        right = (await api('PATCH', `/api/duet/participants/${right.id}`, { model: MODEL })).body;

        // ── 1. what is offered ──
        console.log('\nwhat is offered');
        let n = bodies.length;
        await send(thread.id, { participantId: left.id, text: 'Hello there.', clientRequestId: 'hello' });
        ok(JSON.stringify(toolNames(bodies[n])) === '["request_result"]',
            'files off: a tool-capable side is offered request_result and nothing else', toolNames(bodies[n]).join(', '));
        n = bodies.length;
        await send(thread.id, { participantId: left.id, text: 'Hello again.', tools: true, clientRequestId: 'hello-2' });
        const withFiles = toolNames(bodies[n]);
        ok(['list_directory', 'find_files', 'read_file', 'search_text', 'request_result'].every(t => withFiles.includes(t)),
            'files on: the file tools, search_text included, and request_result', withFiles.join(', '));

        // ── 2. a request ──
        console.log('\na request');
        n = bodies.length;
        const asked = await send(thread.id, { participantId: left.id, text: 'Please measure it for me.', clientRequestId: 'ask-1' });
        const reply = asked.last('done')?.message;
        ok(reply?.status === 'complete' && reply.requestMeta?.requests?.[0]?.text === ASK,
            'the request is recorded on the reply', JSON.stringify(reply?.requestMeta?.requests));
        ok(/asked the User to measure/.test(reply?.content || ''),
            'and the turn finishes with the model saying what it asked — not an empty reply', reply?.content);
        ok(asked.events.some(e => e.type === 'tool' && e.name === 'request_result' && e.ok && e.summary === ASK),
            'the page is told as it happens');
        const finishing = bodies[bodies.length - 1];
        ok(bodies.length === n + 2 && !finishing.tools,
            'the finishing round is offered no tools: having asked, the turn is for saying so');
        ok(/result is unknown until they answer/.test(JSON.stringify(finishing.messages.slice(-1))),
            'and the model is told the result is unknown until the user answers');

        // ── 3. answers that name the wrong thing are refused, and write nothing ──
        console.log('\nanswers are checked');
        const before = await count(thread.id);
        const plainReply = (await api('GET', `/api/duet/${thread.id}`)).body.messages
            .find(m => m.role === 'assistant' && !m.requestMeta?.requests);
        const wrongSide = await send(thread.id, { participantId: right.id, text: '23 s', answers: reply.id, clientRequestId: 'bad-1' });
        ok(wrongSide.status === 400 && /not made by Right/.test(wrongSide.error),
            'an answer sent to the side that did not ask is refused', wrongSide.error);
        const noRequest = await send(thread.id, { participantId: left.id, text: '23 s', answers: plainReply.id, clientRequestId: 'bad-2' });
        ok(noRequest.status === 400 && /did not ask for a result/.test(noRequest.error),
            'an answer to a reply that asked nothing is refused', noRequest.error);
        const nowhere = await send(thread.id, { participantId: left.id, text: '23 s', answers: 999999, clientRequestId: 'bad-3' });
        ok(nowhere.status === 400, 'an answer to a message that does not exist is refused', nowhere.error);
        ok(await count(thread.id) === before, 'and none of them wrote anything');

        // ── 4. the answer ──
        console.log('\nthe answer');
        n = bodies.length;
        const answered = await send(thread.id, { participantId: left.id, text: '23 seconds.', answers: reply.id, clientRequestId: 'answer-1' });
        const answer = answered.last('user')?.message;
        ok(answer?.requestMeta?.answers?.id === reply.id && answer.requestMeta.answers.request === ASK,
            'the answer is linked to the request it answers, and carries its words', JSON.stringify(answer?.requestMeta));
        ok(answer?.replyTo === reply.id, 'and the link is the one the timeline draws (replyTo)');
        ok(lastUser(bodies[n]).includes(`(answering LEFT's request: "${ASK}") 23 seconds.`),
            "the asker's context says what the answer answers", lastUser(bodies[n]).slice(-160));
        n = bodies.length;
        await send(thread.id, { participantId: right.id, text: 'What has happened so far?', clientRequestId: 'right-1' });
        const rightSees = JSON.stringify(bodies[n].messages);
        ok(rightSees.includes(`[asked the User: \\"${ASK}\\"]`),
            "the other side's context shows what was asked");
        ok(rightSees.includes(`(answering LEFT's request: \\"${ASK}\\") 23 seconds.`),
            'and what answered it');

        // ── 5. search, then a ranged read ──
        console.log('\nsearch, then a ranged read');
        const found = await send(thread.id, { participantId: left.id, text: 'Find the ribbon.', tools: true, clientRequestId: 'find-1' });
        const tools = found.events.filter(e => e.type === 'tool');
        ok(tools[0]?.name === 'search_text' && tools[0].ok && /1 line/.test(tools[0].summary),
            'search_text finds the line, case-insensitively', JSON.stringify(tools[0]));
        ok(tools[1]?.name === 'read_file' && tools[1].ok && /lines 3–3 of/.test(tools[1].summary),
            'and read_file reads just that line', JSON.stringify(tools[1]));
        const lastBody = bodies[bodies.length - 1];
        const shown = lastBody.messages.filter(m => m.role === 'tool').map(m => m.content).join('\n');
        ok(shown.includes('"line":3') && shown.includes('3: Shopping list: eggs, flour, a teal ribbon'),
            'the model is shown the line number with the text');
        const trace = found.last('done')?.message?.requestMeta?.tools || [];
        ok(JSON.stringify(trace[0]?.seen) === '[{"path":"benign.md","hits":[3]}]'
            && JSON.stringify(trace[1]?.seen) === '[{"path":"benign.md","lines":[3,3]}]',
            'the record says which file and which lines it was shown — never their contents',
            JSON.stringify(trace.map(t => t.seen)));
        ok(!JSON.stringify(trace).includes('teal ribbon'), 'no file text is stored on the reply');

        // ── 6. a long result is cut to the window that is left, and says so ──
        console.log('\na long result in a small window');
        await api('POST', '/api/config', { num_ctx: 4096 });
        const { CHARS_PER_TOKEN, REPLY_RESERVE_TOKENS } = require('../duet-context');
        const long = await send(thread.id, { participantId: left.id, text: 'Read the long file and tell me what it says.', tools: true, clientRequestId: 'long-1' });
        const last = bodies[bodies.length - 1];
        const toolText = last.messages.filter(m => m.role === 'tool').map(m => m.content).join('');
        const held = last.messages.reduce((n, m) => n + String(m.content || '').length
            + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0) + JSON.stringify(last.tools || []).length;
        ok(/cut to fit your context window: showing the first [\d,]+ of [\d,]+ characters/.test(toolText),
            'a file too long for the window is cut, and the model is told how much it saw', toolText.slice(-140));
        ok(held <= (4096 - REPLY_RESERVE_TOKENS) * CHARS_PER_TOKEN,
            'and everything the model holds fits its window, with room left to answer', `${held} chars`);
        ok(last.messages.some(m => m.role === 'user' && /Read the long file/.test(m.content)),
            'so the question is still there — not pushed out by the file');
        ok(long.last('done')?.message?.requestMeta?.budgetChars <= (4096 - REPLY_RESERVE_TOKENS) * CHARS_PER_TOKEN,
            'a local side is budgeted by the local window');
        await api('POST', '/api/config', { num_ctx: 8192 });

        // ── 7. a model that cannot call tools is offered none ──
        console.log('\na model without tools');
        await api('PATCH', `/api/duet/participants/${right.id}`, { model: PLAIN });
        n = bodies.length;
        await send(thread.id, { participantId: right.id, text: 'Please measure it.', tools: true, clientRequestId: 'plain-1' });
        ok(!bodies[n].tools, 'nothing is offered to a model that cannot call tools — not even request_result');
    } catch (err) {
        fail++;
        console.log(`  FAIL run aborted: ${err.message}`);
        console.log(log.split('\n').slice(-20).join('\n'));
    } finally {
        child.kill();
        // Windows holds the database open until the process has actually gone.
        if (child.exitCode === null) await new Promise(r => child.once('exit', r));
        ollama.close();
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    }

    console.log(`\n${pass} passed, ${fail} failed\n`);
    if (fail) process.exit(1);
}

main();
