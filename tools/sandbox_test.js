'use strict';

/**
 * Per-visitor sandboxes.  node tools/sandbox_test.js
 *
 * Hosted, every visitor gets a private database, and every store call is routed to the
 * visitor whose request made it (sandbox.js). These assertions hold the routing to what
 * isolation depends on:
 *
 *   - two stores never see each other's data, though both start at id 1
 *   - in sandbox mode, a store call with no visitor in context THROWS instead of
 *     landing in some default database
 *   - constants other modules read at load work with no store at all
 *   - bind() keeps work on the visitor who started it — the property a shared job queue
 *     needs, because async context otherwise follows whoever happens to start the job
 *
 * In-process and offline: no server, no model.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airlock-sandbox-'));

let pass = 0, fail = 0;
const ok = (cond, label, detail = '') => {
    if (cond) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
};
const throws = fn => { try { fn(); return null; } catch (e) { return e; } };

const sandbox = require('../sandbox');
const store = require('../db');
const duet = require('../duet-store');

const opened = [];
const open = name => { const s = sandbox.openStore(path.join(tmp, `${name}.db`)); opened.push(s); return s; };

async function main() {
    console.log('\nAirlock sandboxes: routing\n');
    process.env.AIRLOCK_SANDBOXES = '1';

    // ── nothing in context: fail closed ──
    const bare = throws(() => store.getTree());
    ok(bare && /No sandbox in context/.test(bare.message),
       'in sandbox mode, a store call with no visitor in context throws', bare?.message);
    ok(throws(() => duet.getParticipants(1)) !== null, 'and so does a duet-store call');

    // ── constants and factories need no store ──
    ok(duet.STATUS && duet.STATUS.COMPLETE === 'complete' && Array.isArray(duet.SLOTS),
       'constants read at load (STATUS, SLOTS) work with no store at all');
    ok(typeof store.createCore === 'function' && typeof duet.createDuet === 'function',
       'as do the factories');

    // ── two visitors ──
    const A = open('a'), B = open('b');
    const MARK = 'visitor-A-private-marker-5c1e';

    const aThread = sandbox.run(A, () => {
        const [tray] = store.getTree();
        const t = store.createThread(tray.id, MARK);
        store.createPacket({ threadId: t.id, role: 'user', content: `the secret is ${MARK}` });
        return t;
    });

    const bSees = sandbox.run(B, () => ({
        tree: JSON.stringify(store.getTree()),
        search: JSON.stringify(store.search({ q: MARK })),
        sameId: store.getThread(aThread.id),
        packets: JSON.stringify(store.getThreadPackets(aThread.id))
    }));
    ok(!bSees.tree.includes(MARK), "B's tree does not contain A's thread");
    ok(!bSees.search.includes(MARK), "B's search cannot find A's text");
    ok(!bSees.packets.includes(MARK),
       "asking B's store for A's thread id by number returns nothing of A's",
       `B got ${bSees.packets.slice(0, 80)}`);
    ok(!bSees.sameId || bSees.sameId.title !== MARK,
       'the same numeric id means a different thing, or nothing, in B');

    const aStill = sandbox.run(A, () => JSON.stringify(store.getTree()));
    ok(aStill.includes(MARK), 'and A still has it');

    // Duet tables are per store too.
    sandbox.run(A, () => duet.ensureDuet(aThread.id, { models: { a: 'm-a', b: 'm-b' } }));
    const bParticipants = sandbox.run(B, () => duet.getParticipants(aThread.id));
    ok(bParticipants.length === 0, "A's duet participants do not exist in B");

    // Each store is seeded like a fresh install.
    const seeds = [A, B].map(s => sandbox.run(s, () => store.getTree()[0]?.threads?.[0]?.title));
    ok(seeds.every(t => t === 'First thread'), 'every sandbox is seeded like a fresh install');

    // ── context survives awaits ──
    const afterAwait = await sandbox.run(A, async () => {
        await new Promise(r => setTimeout(r, 5));
        await Promise.resolve();
        return JSON.stringify(store.getTree());
    });
    ok(afterAwait.includes(MARK), 'the store stays current across awaits and timers');

    // ── bind: work started later, by someone else, still belongs to its owner ──
    //
    // The shape of the shared duet queue: A enqueues a job, and the job is started later
    // from inside B's request, because B's job was the one that finished.
    const queued = [];
    sandbox.run(A, () => queued.push(sandbox.bind(() => JSON.stringify(store.getTree()))));
    sandbox.run(A, () => queued.push(() => JSON.stringify(store.getTree())));     // NOT bound
    const [boundRun, unboundRun] = sandbox.run(B, () => queued.map(job => job()));
    ok(boundRun.includes(MARK), 'a bound job runs as the visitor who queued it');
    ok(!unboundRun.includes(MARK),
       'an unbound one runs as whoever started it — which is why the queue must bind');

    // ── desk mode is unchanged ──
    delete process.env.AIRLOCK_SANDBOXES;
    process.env.AIRLOCK_DB = path.join(tmp, 'desk.db');
    const desk = throws(() => store.getTree());
    ok(desk === null, 'on a desk, a call with no context uses the one primary database');
    ok(sandbox.primaryStore().file === process.env.AIRLOCK_DB, 'at AIRLOCK_DB');
}

main().catch(err => {
    fail++;
    console.log('  FAIL sandbox_test could not run — ' + (err.stack || err.message));
}).finally(() => {
    for (const s of opened) try { s.db.close(); } catch { /* already closed */ }
    try { sandbox.primaryStore().db.close(); } catch { /* never opened */ }
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`\n${pass} passed, ${fail} failed\n`);
    if (fail) process.exitCode = 1;
});
