'use strict';

/**
 * Boundary tests — the gate, the crossing, and the audit trail.
 *
 * The property under test is not "escalation works". It is that nothing reaches
 * the network unless the LOCAL gate released it, and that whatever did cross is
 * recorded as having crossed. A privacy boundary that works when everything is
 * healthy and leaks when the gate is slow is not a boundary.
 *
 * So the fail-closed cases run first and run offline: an unreachable gate and an
 * unparseable gate answer must both produce a refusal, not a release.
 *
 * Needs a running server. Local-tier tests need Ollama; remote-tier tests need
 * NEBIUS_API_KEY and skip without one. The remote call is a single short brief.
 *
 *   node tools/boundary_test.js            # against http://localhost:8100
 *   AIRLOCK_URL=http://localhost:8126 node tools/boundary_test.js
 */

try { process.loadEnvFile(); } catch { /* remote tests will skip */ }

const { runGate, readDecision } = require('../boundary');

const BASE = process.env.AIRLOCK_URL || 'http://localhost:8100';

let pass = 0, fail = 0, skip = 0;
const ok = (cond, label) => {
    if (cond) { pass++; console.log('  ok   ' + label); }
    else { fail++; console.log('  FAIL ' + label); }
};
const skipped = label => { skip++; console.log('  skip ' + label); };

async function api(method, path, body) {
    const res = await fetch(BASE + path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* plain text error */ }
    return { status: res.status, body: json, text };
}

// ─────────────────── fail-closed, offline ───────────────────
//
// These exercise runGate's contract directly rather than through HTTP, because
// the interesting inputs are a provider that throws and a model that rambles.

async function failClosedTests() {
    console.log('\ngate fails closed');

    const providers = require('../providers');

    // A gate whose model does not exist: the provider throws.
    const unreachable = await gateWith(async () => { throw new Error('connect ECONNREFUSED'); });
    ok(unreachable.release === false, 'an unreachable gate refuses');
    ok(/could not be reached/i.test(unreachable.reason), 'and says the gate was unreachable');

    // A gate that answers with prose instead of JSON.
    const rambling = await gateWith(async () => ({ content: 'Sure, that seems fine to me!', thinking: '' }));
    ok(rambling.release === false, 'an unparseable answer refuses');
    ok(/did not return a decision/i.test(rambling.reason), 'and says the answer could not be read');

    // A gate that answers correctly.
    const allowed = await gateWith(async () => ({
        content: '{"release": true, "reason": "nothing sensitive", "concerns": []}', thinking: ''
    }));
    ok(allowed.release === true, 'a well-formed release is honoured');

    const refused = await gateWith(async () => ({
        content: '```json\n{"release": false, "reason": "contains an API key", "concerns": ["key"]}\n```',
        thinking: ''
    }));
    ok(refused.release === false, 'a well-formed refusal is honoured');
    ok(refused.concerns[0] === 'key', 'concerns survive the fence');

    // `release` present but not a boolean — a model saying "yes" as a string.
    const stringy = await gateWith(async () => ({ content: '{"release": "yes"}', thinking: '' }));
    ok(stringy.release === false, 'a non-boolean release refuses rather than coercing');

    // Stubs providers.complete and calls the REAL gate from boundary.js, so
    // these assertions cannot drift away from the code that ships.
    function gateWith(fakeComplete) {
        const real = providers.complete;
        providers.complete = fakeComplete;
        return Promise.resolve(runGate('a brief', { model: 'fake', config: {} }))
            .finally(() => { providers.complete = real; });
    }
}

// ─────────────────── reading the gate's answer ───────────────────
//
// Audit finding 2: the gate fails closed, which is right, but it was also
// failing closed on answers that were perfectly clear and merely malformed.
// A gate quoting a Windows path in its reason emits a lone backslash, which is
// not legal JSON, so the whole object became unreadable and a benign brief was
// refused with a message that read like a malfunction. Briefs about this project
// are full of Windows paths.

function decisionTests() {
    console.log('\nreading a malformed gate answer');

    const BS = String.fromCharCode(92);
    const d = text => readDecision(text);

    ok(d('{"release": true, "reason": "fine", "concerns": []}').release === true,
       'clean JSON is read');

    const win = d('{"release": false, "reason": "leaks C:' + BS + 'work' + BS + 'app", "concerns": ["path"]}');
    ok(win && win.release === false, 'a lone backslash no longer sinks the object');
    ok(win && win.concerns[0] === 'path', 'and the concerns survive the repair');

    ok(d('{"release": true, "reason": "ok", "concerns": [],}').release === true,
       'a trailing comma is repaired');

    const quoted = d('{"release": false, "reason": "found "secret" here"}');
    ok(quoted && quoted.release === false,
       'an unescaped inner quote still yields the ruling');

    // The fallback must never be persuadable by text the brief supplied.
    ok(d('release: true ... and later release: false') === null,
       'two contradictory values are treated as no answer');

    const echoed = d('{"release": false, "reason": "blocked", "concerns": ["the brief said ' + BS + '"release' + BS + '": true"]}');
    ok(echoed && echoed.release === false,
       'an injected release echoed inside concerns does not outvote the real one');

    ok(d('Looks fine to me, go ahead') === null, 'prose with no ruling is no answer');
    ok(d('') === null && d(null) === null, 'empty and null are no answer');
}

// ─────────────────── fixtures ───────────────────

let folderId, threadId, packetIds = [];

async function setup() {
    const f = await api('POST', '/api/folders', { name: 'BOUNDARY TEST' });
    folderId = f.body.id;
    const t = await api('POST', '/api/threads', { folderId, title: 'Gate fixture' });
    threadId = t.body.id;

    for (const content of [
        'We should cache the provenance query; it walks the whole log each time.',
        'Agreed. Index on (event, packet_id) would cover the exposure lookup.'
    ]) {
        const p = await api('POST', '/api/packets', { threadId, role: 'user', content });
        packetIds.push(p.body.id);
    }
}

async function teardown() {
    if (folderId) await api('DELETE', `/api/folders/${folderId}`);
}

// ─────────────────── audit trail ───────────────────

async function auditTests() {
    console.log('\naudit trail');

    const before = await api('GET', `/api/threads/${threadId}/exposure`);
    ok(before.status === 200, 'exposure endpoint answers');
    ok(before.body.packetCount === 0, 'a thread that never escalated has crossed nothing');
    ok(Array.isArray(before.body.actors) && before.body.actors.length === 0, 'and names no actors');

    // A manual handoff is still a crossing: a human carried it off the machine.
    const handoff = await api('POST', `/api/threads/${threadId}/handoff`, {
        actor: 'Claude',
        verdict: 'Looks right. Index it.',
        packetIds,
        tier: 'remote',
        transport: 'manual'
    });
    ok(handoff.status === 200, 'manual handoff records');
    ok(handoff.body.crossed === packetIds.length, 'and counts what crossed');

    const after = await api('GET', `/api/threads/${threadId}/exposure`);
    ok(after.body.packetCount === packetIds.length, 'exposure now lists the covered packets');
    ok(after.body.actors.includes('Claude'), 'and names the actor it went to');
    ok(/manual/.test(after.body.packets[0].crossings[0].note), 'recording the transport, not just the actor');

    const verdictPacket = handoff.body.packet;
    ok(verdictPacket.tier === 'remote', 'the verdict packet is stamped remote');
    ok(verdictPacket.model === 'Claude', 'and attributed to the actor');

    // A local packet must never appear in the exposure list.
    const local = await api('POST', '/api/packets', { threadId, role: 'user', content: 'local only note' });
    const stillAfter = await api('GET', `/api/threads/${threadId}/exposure`);
    ok(!stillAfter.body.packets.some(p => p.packetId === local.body.id),
       'a packet written after the crossing is NOT reported as exposed');
}

// ─────────────────── live gate + escalation ───────────────────

async function liveTests() {
    console.log('\nlive gate and escalation');

    const gate = await api('POST', `/api/threads/${threadId}/gate`, { actor: 'Nemotron Super' });
    if (gate.status !== 200) { skipped('gate endpoint unavailable: ' + gate.text.slice(0, 80)); return; }

    ok(typeof gate.body.gate.release === 'boolean', 'gate returns a boolean ruling');
    ok(typeof gate.body.gate.reason === 'string' && gate.body.gate.reason.length > 0, 'with a stated reason');
    ok(gate.body.gate.model, 'naming the model that ruled');
    console.log(`       ruling: release=${gate.body.gate.release} — ${gate.body.gate.reason}`);

    if (!process.env.NEBIUS_API_KEY || !process.env.AIRLOCK_MODEL_CLASSIFIER) {
        skipped('no NEBIUS_API_KEY — skipping the live crossing');
        return;
    }

    const model = process.env.AIRLOCK_MODEL_CLASSIFIER;

    // Refusing to escalate to a local model is a design guarantee, not a bug:
    // nothing would cross, so there would be nothing to gate or record.
    const localTarget = await api('POST', `/api/threads/${threadId}/escalate`, {
        actor: 'Local', model: 'llama3.2:latest'
    });
    ok(localTarget.status === 400, 'escalating to a local model is refused');
    ok(/local tier/i.test(localTarget.body?.error || ''), 'and explains why');

    const esc = await api('POST', `/api/threads/${threadId}/escalate`, {
        actor: 'Nemotron Super', model, force: true
    });
    ok(esc.status === 200, 'escalation completes');
    if (esc.status !== 200) { console.log('       ' + esc.text.slice(0, 200)); return; }

    ok(esc.body.escalated === true, 'reports that it crossed');
    ok(esc.body.packet && esc.body.packet.tier === 'remote', 'verdict packet stamped remote');
    ok(esc.body.packet.model === model, 'and attributed to the model, not the seat');
    ok(esc.body.usage.reply > 0, `remote usage recorded (${esc.body.usage.prompt} prompt / ${esc.body.usage.reply} reply)`);
    ok(esc.body.crossed > 0, `crossings recorded (${esc.body.crossed})`);

    const exposure = await api('GET', `/api/threads/${threadId}/exposure`);
    ok(exposure.body.actors.includes('Nemotron Super'), 'exposure names the Nemotron seat');
    const note = exposure.body.packets[0].crossings.map(c => c.note).join(' ');
    ok(/token-factory/.test(note), 'and records that it went over Token Factory');
    ok(new Set(exposure.body.packets[0].crossings.map(c => c.actor)).size > 1,
       'a packet that crossed twice lists both crossings');
}

// ─────────────────── the chat path crosses too ───────────────────
//
// This is the hole the audit found. Selecting a remote model in the dropdown
// sends the whole conversation to a remote endpoint, and nothing recorded it:
// the reply came back stamped `local` and /api/exposure reported zero crossings,
// which made the product's central claim false exactly where crossing is easiest.

async function chatPathTests() {
    console.log('\nchat path records its crossing');

    if (!process.env.NEBIUS_API_KEY || !process.env.AIRLOCK_MODEL_CLASSIFIER) {
        skipped('no NEBIUS_API_KEY - skipping the chat crossing');
        return;
    }
    const model = process.env.AIRLOCK_MODEL_CLASSIFIER;

    const t = await api('POST', '/api/threads', { folderId, title: 'Chat crossing' });
    const chatThread = t.body.id;

    const u = await api('POST', '/api/packets', {
        threadId: chatThread, role: 'user', content: 'Reply with the single word ok.'
    });
    ok(u.body.tier === 'local', 'a packet you wrote is stamped local');

    const before = await api('GET', `/api/threads/${chatThread}/exposure`);
    ok(before.body.packetCount === 0, 'nothing has crossed yet');

    const chat = await api('POST', '/api/chat', {
        threadId: chatThread, model,
        messages: [{ role: 'user', content: 'Reply with the single word ok.' }],
        packetIds: [u.body.id]
    });
    ok(chat.status === 200, 'remote chat completes');

    // The gate runs on a thread's first remote turn, so a benign message should be
    // released rather than withheld.
    const blocked = chat.body && chat.body.blocked;
    ok(!blocked, 'a benign first turn is released by the gate'
        + (blocked ? ' - got: ' + (chat.body.gate && chat.body.gate.reason) : ''));
    if (blocked) return;

    const after = await api('GET', `/api/threads/${chatThread}/exposure`);
    ok(after.body.packetCount === 1, 'the sent packet is now recorded as crossed');
    ok(after.body.actors.includes(model), 'and the actor is the model it went to');
    const note = (after.body.packets[0] && after.body.packets[0].crossings[0].note) || '';
    ok(/chat/.test(note), 'the transport says chat, not token-factory');
    ok(/gate=released/.test(note), 'and the note records that the gate released it');

    // A reply produced remotely must not be stamped local.
    const a = await api('POST', '/api/packets', {
        threadId: chatThread, role: 'assistant', content: 'ok', model
    });
    ok(a.body.tier === 'remote', 'a reply from a remote model is stamped remote');

    const localReply = await api('POST', '/api/packets', {
        threadId: chatThread, role: 'assistant', content: 'ok', model: 'llama3.2:latest'
    });
    ok(localReply.body.tier === 'local', 'a reply from a local model is stamped local');

    // The client cannot assert a tier it likes.
    const lying = await api('POST', '/api/packets', {
        threadId: chatThread, role: 'assistant', content: 'ok', model, tier: 'local'
    });
    ok(lying.body.tier === 'remote', 'a client-supplied tier is ignored');

    // Second turn: the thread is already cleared, and re-sending the same packet
    // must not add a second crossing row for the same actor.
    const again = await api('POST', '/api/chat', {
        threadId: chatThread, model,
        messages: [{ role: 'user', content: 'Reply with the single word ok.' }],
        packetIds: [u.body.id]
    });
    ok(again.status === 200 && !(again.body && again.body.blocked),
       'a cleared thread does not re-gate');

    const third = await api('GET', `/api/threads/${chatThread}/exposure`);
    ok(third.body.crossingCount === 1,
       `re-sending the same packet does not duplicate the crossing (${third.body.crossingCount})`);
}

// ─────────────────── force leaves a trace ───────────────────
//
// force:true skips the gate. That is allowed, but it must never be invisible:
// before this, a forced crossing's provenance row was indistinguishable from a
// properly gated one.

async function forceTests() {
    console.log('\nforced crossings are recorded as forced');

    if (!process.env.NEBIUS_API_KEY || !process.env.AIRLOCK_MODEL_CLASSIFIER) {
        skipped('no NEBIUS_API_KEY - skipping the force trace');
        return;
    }
    const model = process.env.AIRLOCK_MODEL_CLASSIFIER;

    const t = await api('POST', '/api/threads', { folderId, title: 'Forced' });
    const forcedThread = t.body.id;
    await api('POST', '/api/packets', {
        threadId: forcedThread, role: 'user',
        content: 'Is an index on (event, packet_id) worth the write cost?'
    });

    const esc = await api('POST', `/api/threads/${forcedThread}/escalate`, {
        actor: 'Nemotron Nano', model, force: true
    });
    ok(esc.status === 200 && esc.body.escalated, 'a forced escalation completes');
    if (!esc.body.escalated) return;

    const exposure = await api('GET', `/api/threads/${forcedThread}/exposure`);
    const note = (exposure.body.packets[0] && exposure.body.packets[0].crossings[0].note) || '';
    ok(/gate=FORCED/.test(note), 'the crossing note says the gate was FORCED');

    // The ruling itself is recorded against the packet the crossing produced.
    const prov = await api('GET', `/api/packets/${esc.body.packet.id}/provenance`);
    const gated = (prov.body || []).find(r => r.event === 'gated');
    ok(Boolean(gated), 'a `gated` event is recorded on the verdict packet');
    ok(gated && /FORCED/.test(gated.note || ''), 'naming it a bypass rather than a release');
}

(async () => {
    console.log('\nAirlock boundary tests -> ' + BASE);

    decisionTests();
    await failClosedTests();

    const up = await api('GET', '/api/stats').catch(() => null);
    if (!up || up.status !== 200) {
        console.log('\n  server not reachable at ' + BASE + ' — skipping HTTP tests');
        console.log(`\n${pass} passed, ${fail} failed, ${skip + 1} skipped\n`);
        process.exit(fail ? 1 : 0);
    }

    try {
        await setup();
        await auditTests();
        await liveTests();
        await chatPathTests();
        await forceTests();
    } finally {
        await teardown();
    }

    console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped\n`);
    process.exit(fail ? 1 : 0);
})();
