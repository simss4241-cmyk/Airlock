'use strict';

/**
 * Clearance lifetime — a store invariant, tested against a throwaway database.
 *
 *   node tools/clearance_test.js
 *
 * No server and no models. This is deliberately NOT part of boundary_test.js: that suite
 * drives a running server, which may be pointed at an entirely different database via
 * AIRLOCK_DB, so a test that reaches into the store directly would be inspecting the wrong
 * file and passing for the wrong reason.
 *
 * ⚠ What is under test is a boundary defect, not housekeeping.
 *
 * A gate clearance is consent: "this thread may talk to that remote model", remembered so
 * ordinary conversation does not pay for a local gate call every turn. It lives in `meta`
 * keyed by thread id — and SQLite reuses the highest rowid after a delete. So a deleted
 * thread used to leave its consent behind, and the next thread created could be handed the
 * same id and inherit it. That thread would then skip the gate entirely, on consent nobody
 * ever gave, and the first sign of it would be content already across the boundary.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Set BEFORE requiring the store: db.js reads this at module load.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'airlock-clearance-'));
process.env.AIRLOCK_DB = path.join(scratch, 'clearance-test.db');

const store = require('../db');

let pass = 0, fail = 0;
const ok = (cond, label, detail = '') => {
    if (cond) { pass++; console.log('  ok   ' + label); }
    else { fail++; console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')); }
};

const clearanceKeys = () => store.db
    .prepare("SELECT key FROM meta WHERE key LIKE 'cleared:%'")
    .all().map(r => r.key);

const MODEL = 'nvidia/pretend-remote-model';

function cleanup() {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.on('exit', cleanup);

console.log('\nAirlock clearance lifetime tests\n');

const tray = store.createFolder('CLEARANCE');

// ── a clearance belongs to its thread ──
const first = store.createThread(tray.id, 'first');
store.recordClearance(first.id, MODEL, { reason: 'benign brief' });

ok(store.isCleared(first.id, MODEL) === true, 'a clearance is recorded against its thread');
ok(clearanceKeys().length === 1, 'and is one row in meta', clearanceKeys().join(','));

// ── deleting the thread takes the consent with it ──
store.deleteThread(first.id);
ok(store.isCleared(first.id, MODEL) === false, 'deleting the thread revokes its clearance');
ok(clearanceKeys().length === 0, 'leaving no clearance rows behind', clearanceKeys().join(','));

// ── the defect this exists for: a recycled thread id must not inherit consent ──
const second = store.createThread(tray.id, 'second');
ok(second.id === first.id,
   'SQLite hands the deleted thread\'s id to the next one (the precondition for the bug)',
   `first=${first.id} second=${second.id}`);
ok(store.isCleared(second.id, MODEL) === false,
   'and the new thread on that recycled id is NOT cleared');

// ── the cascade path: threads also vanish when their tray does ──
store.recordClearance(second.id, MODEL, { reason: 'benign brief' });
ok(store.isCleared(second.id, MODEL) === true, 'a second clearance is recorded');

store.deleteFolder(tray.id);
ok(store.isCleared(second.id, MODEL) === false,
   'deleting the tray revokes its threads\' clearances too, by cascade');
ok(clearanceKeys().length === 0, 'and leaves nothing behind', clearanceKeys().join(','));

// ── clearances are per model, not per thread ──
const tray2 = store.createFolder('CLEARANCE 2');
const shared = store.createThread(tray2.id, 'shared');
store.recordClearance(shared.id, 'model-a', { reason: 'ok' });
ok(store.isCleared(shared.id, 'model-a') === true, 'clearing one model clears that model');
ok(store.isCleared(shared.id, 'model-b') === false, 'and not a different one');

// ── the boot sweep catches anything written before the trigger existed ──
//
// Simulated by writing a clearance for a thread id that does not exist, which is exactly
// the shape a pre-trigger database is in.
store.setMeta('cleared:999999:some-model', 'left over from a deleted thread');
ok(clearanceKeys().includes('cleared:999999:some-model'), 'an orphaned clearance can be planted');

const swept = store.db.prepare(`
    DELETE FROM meta
     WHERE key LIKE 'cleared:%'
       AND instr(substr(key, 9), ':') > 0
       AND CAST(substr(key, 9, instr(substr(key, 9), ':') - 1) AS INTEGER)
           NOT IN (SELECT id FROM threads)
`).run().changes;

ok(swept === 1, 'and the boot sweep removes exactly it', `swept ${swept}`);
ok(store.isCleared(shared.id, 'model-a') === true,
   'while leaving a live thread\'s clearance alone');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
