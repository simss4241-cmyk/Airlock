'use strict';

/**
 * The kernel: what decides whether content may leave, and the two locks that make it
 * unavoidable.  node tools/kernel_test.js
 *
 * Offline. The gate is stubbed so these assertions are about the kernel's bookkeeping
 * and the locks' refusals, not about a model's judgement — tools/duet_tools_test.js
 * covers the same ground end to end, over HTTP, against a fake remote.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (cond, label, detail = '') => {
    if (cond) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
};

const providers = require('../providers');
const kernel = require('../kernel');
const boundary = require('../boundary');
const egress = require('../providers/egress');
const tokenfactory = require('../providers/tokenfactory');

const REMOTE = 'test/remote-model';          // slash: routes to the Token Factory provider
const OTHER = 'test/another-remote';

/** Stand a stub in for the gate, and record what it was shown. */
function stubGate(decide) {
    const shown = [];
    boundary.runGate = async markdown => {
        shown.push(markdown);
        return decide(markdown);
    };
    return shown;
}
const RELEASE = () => ({ release: true, reason: 'fine', concerns: [], model: 'stub-gate' });
const REFUSE = () => ({ release: false, reason: 'contains a key', concerns: ['key'], model: 'stub-gate' });

async function main() {
    console.log('\nAirlock kernel tests');

    // Place the test models by hand. The registry answers from what it holds, so this is
    // exactly the state a resolved catalogue would be in.
    providers.registry._entries.set(REMOTE, { id: REMOTE, tier: 'remote', source: 'remote' });
    providers.registry._entries.set(OTHER, { id: OTHER, tier: 'remote', source: 'remote' });
    providers.registry._entries.set('test-local:1b', { id: 'test-local:1b', tier: 'local', source: 'local', size: 1 });

    // ── one door ──
    console.log('\nthere is one door');
    const offenders = [];
    const walk = dir => {
        for (const name of fs.readdirSync(dir)) {
            if (['node_modules', 'tools', 'public', '.git'].includes(name)) continue;
            const full = path.join(dir, name);
            if (fs.statSync(full).isDirectory()) { walk(full); continue; }
            if (!name.endsWith('.js')) continue;
            if (path.relative(ROOT, full) === path.join('providers', 'egress.js')) continue;
            fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
                if (/(^|[^.\w])fetch\(/.test(line) && !/^\s*(\/\/|\*)/.test(line)) {
                    offenders.push(`${path.relative(ROOT, full)}:${i + 1}`);
                }
            });
        }
    };
    walk(ROOT);
    ok(offenders.length === 0,
       'no server-side code calls fetch except providers/egress.js', offenders.join(', '));

    // ── local needs nothing ──
    console.log('\na local destination needs no clearance');
    let shown = stubGate(RELEASE);
    const local = await kernel.clear({ model: 'test-local:1b', messages: [{ role: 'user', content: 'x' }] });
    ok(local.ok && local.token === null && local.local, 'a local model is cleared without a ruling');
    ok(shown.length === 0, 'and the gate is not asked');

    // ── per-turn, new content only ──
    console.log('\neach turn is ruled on, and only what is new');
    kernel._released.clear();
    shown = stubGate(RELEASE);
    const sys = { role: 'system', content: 'You are a desk.' };
    const t1 = { role: 'user', content: 'first question' };
    const first = await kernel.clear({ model: REMOTE, messages: [sys, t1] });
    ok(first.ok && first.fresh === 2, 'the first turn rules on everything in it', `fresh=${first.fresh}`);
    ok(shown.length === 1 && /first question/.test(shown[0]), 'and the gate reads it');

    const a1 = { role: 'assistant', content: 'an answer' };
    const t2 = { role: 'user', content: 'SECOND question, typed later' };
    const second = await kernel.clear({ model: REMOTE, messages: [sys, t1, a1, t2] });
    ok(second.ok && second.fresh === 2, 'the next turn rules on just what is new', `fresh=${second.fresh}`);
    ok(!/first question/.test(shown[1]) && /SECOND question/.test(shown[1]),
       'the gate is not re-shown the history, only the new turn');

    const again = await kernel.clear({ model: REMOTE, messages: [sys, t1, a1, t2] });
    ok(again.ok && again.fresh === 0 && again.ruling.covered && shown.length === 2,
       'sending exactly what was already ruled on costs no gate call');

    // ── refusal ──
    console.log('\na refusal sends nothing and remembers nothing');
    shown = stubGate(REFUSE);
    const secret = { role: 'user', content: 'here is my key sk-live-000' };
    const refused = await kernel.clear({ model: REMOTE, messages: [sys, t1, secret] });
    ok(!refused.ok && refused.ruling.release === false, 'a refused turn is not cleared');
    ok(refused.token === undefined, 'and no clearance is issued for it');
    shown = stubGate(REFUSE);
    await kernel.clear({ model: REMOTE, messages: [sys, t1, secret] });
    ok(shown.length === 1, 'a refused message is ruled on again next time, not remembered as released');

    // ── images ──
    console.log('\nwhat the gate cannot read is refused');
    shown = stubGate(RELEASE);
    const pic = await kernel.clear({ model: REMOTE, messages: [{ role: 'user', content: 'look', images: ['AAAA'] }] });
    ok(!pic.ok && /image/i.test(pic.ruling.reason), 'a message carrying an image is refused, with the reason');
    ok(shown.length === 0, 'without asking a text-only gate to guess');

    // ── what a clearance covers ──
    console.log('\na clearance covers these words, to this model');
    shown = stubGate(RELEASE);
    kernel._released.clear();
    const msgs = [{ role: 'user', content: 'the words that were ruled on' }];
    const c = await kernel.clear({ model: REMOTE, messages: msgs });
    ok(kernel.covers(c.token, REMOTE, msgs), 'it covers what it was issued for');
    ok(!kernel.covers(c.token, OTHER, msgs), 'but not the same words to a different model');
    ok(!kernel.covers(c.token, REMOTE, [{ role: 'user', content: 'different words' }]),
       'and not different words to the same model');
    const forged = Object.freeze({ model: REMOTE, hashes: new Set(msgs.map(kernel.unitHash)), ruling: RELEASE() });
    ok(!kernel.covers(forged, REMOTE, msgs) && !kernel.isIssuedFor(forged, REMOTE),
       'a clearance-shaped object the kernel did not issue is worth nothing');

    // ── a model's own earlier reply, going back to it ──
    // Measured 2026-10-14: every follow-up turn put the remote side's previous reply to the
    // gate on its own ("assistant: fine"), and the 14B withheld it. Its own words, going back
    // to it, expose nothing — but only to IT.
    console.log('\na model\'s own earlier reply is not put to the gate — for that model only');
    shown = stubGate(RELEASE);
    const said = { role: 'assistant', content: 'fine' };
    const turn2 = [{ role: 'user', content: 'Say hello, please.' }, said, { role: 'user', content: 'And again?' }];
    await kernel.clear({ model: REMOTE, messages: [turn2[0]] });
    shown.length = 0;
    const back = await kernel.clear({ model: REMOTE, messages: turn2, ownWords: [said] });
    ok(back.ok && back.fresh === 1 && shown.length === 1 && !/assistant: fine/.test(shown[0]) && /And again\?/.test(shown[0]),
       'the gate reads only the new message, not the model\'s own reply', `fresh=${back.fresh} shown=${JSON.stringify(shown)}`);
    ok(kernel.covers(back.token, REMOTE, turn2), 'and the clearance still covers everything sent, its own reply included');
    shown.length = 0;
    const elsewhere = await kernel.clear({ model: OTHER, messages: [said] });
    ok(elsewhere.fresh === 1 && shown.some(t => /assistant: fine/.test(t)),
       'the same words going to a different model ARE ruled on: not remembered as released');

    // ── what the gate reads instead of a message ──
    console.log('\nshownAs: the gate reads the User\'s parts of a message, and the clearance covers all of it');
    shown = stubGate(RELEASE);
    const prompt0 = { role: 'system', content: 'You are the RIGHT participant. Never cite a file you have not seen.' };
    const question = { role: 'user', content: 'What is the combined pressure?' };
    shown.length = 0;
    const skip = await kernel.clear({ model: REMOTE, messages: [prompt0, question], shownAs: [{ message: prompt0, text: '' }] });
    ok(skip.ok && shown.length === 1 && !/Never cite a file/.test(shown[0]) && /combined pressure/.test(shown[0]),
       'nothing of the User\'s in it: the system prompt is not read at all', JSON.stringify(shown));
    ok(kernel.covers(skip.token, REMOTE, [prompt0, question]), 'and the clearance still covers it exactly as sent');
    const promptRole = { ...prompt0, content: prompt0.content + ' Your role: Skeptic.' };
    shown.length = 0;
    await kernel.clear({ model: REMOTE, messages: [promptRole], shownAs: [{ message: promptRole, text: 'The role the User set: Skeptic.' }] });
    ok(shown.length === 1 && /only what the User wrote/.test(shown[0]) && /Skeptic/.test(shown[0]) && !/Never cite a file/.test(shown[0]),
       'with a role, the gate reads the role — and not Airlock\'s wording around it', JSON.stringify(shown));

    // ── rulings that survive a restart ──
    console.log('\nreleased rulings outlive a restart, as hashes only');
    const memoryBefore = new Map(kernel._released);   // put back after: later sections rely on it
    const kept = new Map();
    const fakeStore = {
        loadReleased: () => [...kept.values()],
        rememberReleased: (hash, by, gateModel, at) => kept.set(hash, { hash, by, gateModel, at })
    };
    kernel.persistTo(fakeStore);
    shown = stubGate(RELEASE);
    const once = { role: 'user', content: 'a sentence ruled on before the restart' };
    await kernel.clear({ model: REMOTE, messages: [once] });
    ok([...kept.values()].some(r => r.hash === kernel.unitHash(once)) && ![...kept.values()].some(r => JSON.stringify(r).includes('ruled on before')),
       'a release is kept — its hash, never its words');
    kernel._forget();                                  // what a restart does to memory
    shown.length = 0;
    const after = await kernel.clear({ model: REMOTE, messages: [once] });
    ok(after.ok && after.fresh === 0 && shown.length === 0, 'after a restart, words already released are not put to the gate again');
    shown.length = 0;
    const novel = await kernel.clear({ model: REMOTE, messages: [{ role: 'user', content: 'words never ruled on' }] });
    ok(novel.fresh === 1 && shown.length === 1, 'and new words still are');
    kernel.persistTo(null);
    kernel._forget();
    for (const [k, v] of memoryBefore) kernel._released.set(k, v);

    // ── acknowledgement ──
    console.log('\nthe far side\'s own words are not re-judged');
    shown = stubGate(RELEASE);
    const own = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.md' } } }] };
    kernel.acknowledge([own]);
    const result = { role: 'tool', tool_name: 'read_file', content: '"file body"' };
    const round2 = await kernel.clear({ model: REMOTE, messages: [...msgs, own, result] });
    ok(round2.ok && round2.fresh === 1, 'an acknowledged reply is not gated again', `fresh=${round2.fresh}`);
    ok(/tool result \(read_file\)/.test(shown[0]) && /file body/.test(shown[0]),
       'the tool result is, and the gate is told what it is');


    // ── the first lock: providers.chat ──
    console.log('\nthe first lock: providers.chat() will not dispatch without a clearance');
    const realChat = tokenfactory.chat;
    const dispatched = [];
    tokenfactory.chat = async function* (opts) {
        dispatched.push(opts);
        yield { message: { content: 'ok' }, done: true };
    };
    try {
        kernel._released.clear();

        shown = stubGate(REFUSE);
        let err = null;
        try {
            for await (const _ of providers.chat({ model: REMOTE, messages: [{ role: 'user', content: 'no clearance brought' }], config: {} })) { /* drain */ }
        } catch (e) { err = e; }
        ok(err && err.name === 'GateRefusal' && err.gate?.release === false,
           'a caller that brings no clearance gets the gate run for it — and a refusal');
        ok(dispatched.length === 0, 'and nothing reaches the provider');

        shown = stubGate(RELEASE);
        for await (const _ of providers.chat({ model: REMOTE, messages: [{ role: 'user', content: 'still none brought' }], config: {} })) { /* drain */ }
        ok(shown.length === 1 && dispatched.length === 1, 'released, it dispatches — after exactly one ruling');
        ok(kernel.isIssuedFor(dispatched[0].clearance, REMOTE),
           'carrying a clearance the kernel issued, for the egress lock to check');

        shown = stubGate(RELEASE);
        const good = await kernel.clear({ model: REMOTE, messages: [{ role: 'user', content: 'cleared in advance' }] });
        const n = shown.length;
        const grown = [{ role: 'user', content: 'cleared in advance' }, { role: 'tool', tool_name: 'read_file', content: 'appended after the ruling' }];
        for await (const _ of providers.chat({ model: REMOTE, messages: grown, config: {}, clearance: good.token })) { /* drain */ }
        ok(shown.length === n + 1 && /appended after the ruling/.test(shown.at(-1)),
           'a clearance that no longer covers what is sent does not carry it — the new part is ruled on');
    } finally {
        tokenfactory.chat = realChat;
    }

    // ── the second lock: egress ──
    console.log('\nthe second lock: egress will not open a content-bearing connection');
    const refusedWith = async fn => { try { await fn(); return null; } catch (e) { return e; } };

    let e = await refusedWith(() => egress.remote('http://127.0.0.1:9/x', { method: 'POST', body: '{}' }, { model: REMOTE }));
    ok(e?.name === 'EgressRefused', 'a remote request with no clearance is refused before any socket opens');

    e = await refusedWith(() => egress.remote('http://127.0.0.1:9/x', { method: 'POST', body: '{}' }, { model: REMOTE, clearance: forged }));
    ok(e?.name === 'EgressRefused', 'and so is one with a forged clearance');

    e = await refusedWith(() => egress.remote('http://127.0.0.1:9/x', { method: 'POST', body: '{}' }, { model: OTHER, clearance: c.token }));
    ok(e?.name === 'EgressRefused', 'and one cleared for a different model');

    e = await refusedWith(() => egress.catalogue('http://127.0.0.1:9/models', { method: 'POST', body: 'data' }));
    ok(e?.name === 'EgressRefused', 'a "catalogue" request with a body is refused — the name is not a loophole');

    e = await refusedWith(() => egress.local('https://example.com/api/chat'));
    ok(e?.name === 'EgressRefused', 'local() reaches only this machine\'s Ollama');

    providers.registry._entries.set('cloudish:30b-cloud', { id: 'cloudish:30b-cloud', tier: 'remote', source: 'local', via: 'ollama-cloud' });
    e = await refusedWith(() => egress.local(`${egress.OLLAMA}/api/chat`, { method: 'POST', body: '{}' }, { model: 'cloudish:30b-cloud' }));
    ok(e?.name === 'EgressRefused',
       'a request naming an Ollama cloud model is held to the remote rules, though the port is local');

    // ── the audit record for tool results ──
    console.log('\ntool results that cross are recorded');
    const os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airlock-kernel-'));
    process.env.AIRLOCK_DB = path.join(tmp, 'k.db');
    const store = require('../db');
    try {
        const [tray] = store.getTree();
        const thread = store.createThread(tray.id, 'kernel test');
        const pkt = store.createPacket({ threadId: thread.id, role: 'user', content: 'read my notes' });
        store.recordCrossings([pkt.id], { actor: REMOTE, model: REMOTE, transport: 'chat', gate: RELEASE() });
        store.recordArtifactCrossing(pkt.id, {
            actor: REMOTE, model: REMOTE, transport: 'chat', gate: RELEASE(),
            artifacts: [{ label: 'read_file(notes.md) 1,234 chars sha:abcdef012345' }]
        });
        const exposure = store.getExposure(thread.id);
        const notes = exposure.packets[0]?.crossings.map(x => x.note) || [];
        ok(notes.length === 2, 'the request and the tool results it caused are separate crossings', notes.join(' | '));
        ok(notes.some(n => /read_file\(notes\.md\).*sha:abcdef012345/.test(n)),
           'and the tool result is named, sized and hashed in "what has crossed"');
    } finally {
        store.db.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }

    console.log(`\n${pass} passed, ${fail} failed\n`);
    if (fail) process.exitCode = 1;
}

main().catch(err => {
    console.error('\nkernel_test failed:', err.stack || err.message);
    process.exitCode = 1;
});
