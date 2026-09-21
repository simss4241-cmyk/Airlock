'use strict';

/**
 * Per-thread gate clearances are retired, and an old database loses them cleanly.
 *   node tools/clearance_test.js
 *
 * Remote chat used to be gated once per thread per model, with the answer stored in
 * `meta` as `cleared:<threadId>:<model>` and kept tidy by a trigger and a boot sweep —
 * because SQLite reuses rowids, and a new thread could otherwise inherit a deleted one's
 * consent. kernel.js replaced all of it: every turn is ruled on, and a clearance is bound
 * to message content rather than to a thread id, so there is no consent keyed to anything
 * that can be recycled. The rows now mean nothing, and db.js drops them at boot.
 *
 * What matters is that this works on a database the OLD code wrote. So the test builds
 * one as it would have been left — the trigger and consent rows planted after a normal
 * boot — and then opens it with the current db.js in a fresh process, because db.js runs
 * its migrations once, at module load.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airlock-clearance-'));
const DB = path.join(tmp, 'legacy.db');

let pass = 0, fail = 0;
const ok = (cond, label, detail = '') => {
    if (cond) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
};

/** Open the scratch database with the current db.js in its own process; return JSON. */
const withDb = code => JSON.parse(execFileSync(process.execPath, ['-e', `
    const store = require(${JSON.stringify(path.join(ROOT, 'db.js'))});
    const out = (() => { ${code} })();
    store.db.close();
    process.stdout.write(JSON.stringify(out));
`], { env: { ...process.env, AIRLOCK_DB: DB }, stdio: ['ignore', 'pipe', 'ignore'] }).toString());

const COUNTS = `
    rows: store.db.prepare("SELECT COUNT(*) c FROM meta WHERE key LIKE 'cleared:%'").get().c,
    trigger: store.db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='trigger' AND name='threads_drop_clearances'").get().c
`;

try {
    console.log('\nretired per-thread clearances\n');

    // 1. What the previous version left behind: its trigger, and consent rows — one for a
    //    live thread, one orphaned — beside a meta key that has nothing to do with them.
    const planted = withDb(`
        store.db.exec(\`
            CREATE TRIGGER IF NOT EXISTS threads_drop_clearances
            AFTER DELETE ON threads
            BEGIN
                DELETE FROM meta WHERE key LIKE 'cleared:' || OLD.id || ':%';
            END;
        \`);
        const [tray] = store.getTree();
        const t = store.createThread(tray.id, 'legacy');
        store.setMeta('cleared:' + t.id + ':nvidia/some-remote', 'released');
        store.setMeta('cleared:999999:another-model', 'released');
        store.setMeta('unrelated:key', 'keep me');
        return { ${COUNTS} };
    `);
    ok(planted.rows === 2 && planted.trigger === 1,
       'a database is set up the way the old code left it', JSON.stringify(planted));

    // 2. Open it with the current code.
    const after = withDb(`
        return {
            retired: store.retiredClearances,
            unrelated: store.getMeta('unrelated:key'),
            api: ['isCleared', 'recordClearance'].filter(f => typeof store[f] === 'function'),
            ${COUNTS}
        };
    `);
    ok(after.retired === 2, 'its clearance rows are removed on open', `removed ${after.retired}`);
    ok(after.rows === 0, 'none are left behind');
    ok(after.trigger === 0, 'the trigger that maintained them is dropped');
    ok(after.unrelated === 'keep me', 'nothing else in meta is touched');
    ok(after.api.length === 0, 'and the per-thread consent API no longer exists to call',
       after.api.join(', '));

    // 3. Idempotent: it runs every boot, so a second open must change nothing.
    const again = withDb(`return { retired: store.retiredClearances };`);
    ok(again.retired === 0, 'opening it again is a no-op');
} catch (err) {
    fail++;
    console.log('  FAIL clearance_test could not run — ' + (err.stack || err.message));
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exitCode = 1;
