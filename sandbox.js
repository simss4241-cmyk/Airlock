'use strict';

/**
 * ─────────────────────────── Which store is this? ───────────────────────────
 *
 * On a desk there is one person and one database, and every store call means that one.
 * Hosted, every visitor is someone else, and each gets a sandbox of their own: a private
 * SQLite file, seeded like a fresh install. The question every store call has to answer
 * is then "whose?" — and it cannot be answered at the call site, because there are
 * dozens of them, and one that forgot to ask would read or write the wrong person's data
 * without any sign of it.
 *
 * So it is answered here, once, the same way the kernel answers "may this leave?": at
 * the one place every call passes through. db.js and duet-store.js export the same
 * functions they always did, but each is routed to `current()` — the store belonging to
 * the request being served. Callers do not change, and cannot get it wrong by forgetting.
 *
 *   current()   the store in this async context, set by run() for each request.
 *               With none: on a desk, the one primary store. In sandbox mode
 *               (AIRLOCK_SANDBOXES=1) it THROWS. A store call outside any visitor's
 *               context is a bug, and it must fail rather than land in someone's file.
 *
 *   bind(fn)    fix `fn` to the context it was bound in. Needed wherever work is started
 *               by something other than the request that asked for it — a job queue whose
 *               next task is kicked off by the previous task finishing. Async context
 *               follows the caller, so without this, a queued job would run as whoever
 *               finished before it.
 *
 * A store is { file, db, core, duet }: one database, with db.js's functions (core) and
 * duet-store.js's (duet) bound to it.
 */

const { AsyncLocalStorage, AsyncResource } = require('node:async_hooks');

const context = new AsyncLocalStorage();

const sandboxed = () => process.env.AIRLOCK_SANDBOXES === '1';

/** Open one database file as a complete store. Migrations run here, per file. */
function openStore(file) {
    // Required here, not at the top: db.js and duet-store.js route through this module,
    // so loading them first would be a cycle. These are their factories, not the routed
    // API, and touching them never asks for a current store.
    const { openDatabase, createCore } = require('./db');
    const { createDuet } = require('./duet-store');

    const db = openDatabase(file);
    const core = createCore(db, file);
    const duet = createDuet(db, core);
    return { file, db, core, duet };
}

let primary = null;

/** The desk's own database, opened on first use at AIRLOCK_DB (or ./airlock.db). */
function primaryStore() {
    if (!primary) primary = openStore(require('./db').defaultPath());
    return primary;
}

function current() {
    const store = context.getStore();
    if (store) return store;
    if (sandboxed()) {
        throw new Error('No sandbox in context. In sandbox mode every store call must come '
            + 'from a visitor\'s request (sandbox.run) or work bound to one (sandbox.bind).');
    }
    return primaryStore();
}

/** Run `fn` with `store` as the current store, for everything it awaits and starts. */
const run = (store, fn) => context.run(store, fn);

/** Fix `fn` to the store current right now, wherever and whenever it is later called. */
const bind = fn => AsyncResource.bind(fn);

/**
 * A module API whose functions resolve the store at CALL time.
 *
 * `statics` are returned as they are and never touch a store — factories, and constants
 * a module reads when it loads (duet-runner takes `STATUS` at load, before any visitor
 * exists). Everything else is looked up on current()[part].
 */
function routed(part, statics) {
    return new Proxy(statics, {
        get(target, key) {
            if (key in target) return target[key];
            // Not an API name: probes like `then` (is this a promise?) and symbols.
            if (typeof key === 'symbol' || key === 'then') return undefined;

            const value = current()[part][key];
            if (typeof value !== 'function') return value;
            // Resolved again when called, not when read, so a function taken off the module
            // and called later still lands in the store current at that moment.
            return (...args) => current()[part][key](...args);
        }
    });
}

module.exports = { openStore, primaryStore, current, run, bind, routed, sandboxed };
