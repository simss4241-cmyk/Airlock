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

// ─────────────────────────── hosted: one sandbox per visitor ───────────────────────────
//
// On only with AIRLOCK_SANDBOXES=1. A first visit gets a random, unguessable id in an
// HttpOnly cookie and a private database, seeded like a fresh install. No login and no
// personal data: a judge clicks the link and has a desk of their own.
//
// ⚠ The id is the only key. Whoever holds the cookie holds the sandbox, and a lost cookie
// is a lost sandbox — there is deliberately no account to recover it through. That is
// the trade that keeps identities out of a product whose pitch is that nothing leaves.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const COOKIE = 'airlock_sandbox';
const ID = /^[a-f0-9]{32}$/;          // it becomes a filename, so nothing else is accepted
const TOUCH_MS = 60_000;              // how often last_seen is written, at most

const num = (name, fallback) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
};
const settings = () => ({
    dir: path.resolve(process.env.AIRLOCK_SANDBOX_DIR || path.join(__dirname, 'sandboxes')),
    // Idle expiry. Seven days rather than one, because judging happens after the deadline
    // and a judge who comes back the next day should find their work where they left it.
    ttlMs: num('AIRLOCK_SANDBOX_TTL_MS', num('AIRLOCK_SANDBOX_TTL_HOURS', 168) * 3_600_000),
    max: num('AIRLOCK_SANDBOX_MAX', 500),               // live sandboxes, in total
    perIpHour: num('AIRLOCK_SANDBOX_PER_IP_HOUR', 20),   // new sandboxes per address per hour
    openMax: num('AIRLOCK_SANDBOX_OPEN_MAX', 32),        // database handles kept open
    sweepMs: num('AIRLOCK_SANDBOX_SWEEP_MS', 10 * 60_000)
});

const fileFor = id => path.join(settings().dir, `${id}.db`);

// ── the index: which sandboxes exist, and when each was last used ──
//
// Kept in its own small database beside the sandboxes, never in any visitor's, and
// holding no content — an id and two timestamps.

let indexDb = null;
function index() {
    if (!indexDb) {
        const { DatabaseSync } = require('node:sqlite');
        fs.mkdirSync(settings().dir, { recursive: true });
        indexDb = new DatabaseSync(path.join(settings().dir, '_index.db'));
        indexDb.exec(`CREATE TABLE IF NOT EXISTS sandboxes (
            id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL)`);
    }
    return indexDb;
}
const indexed = id => index().prepare('SELECT * FROM sandboxes WHERE id = ?').get(id) || null;
const liveCount = () => index().prepare('SELECT COUNT(*) AS c FROM sandboxes').get().c;

// ── open handles: an LRU, and never closing one that a request is using ──
//
// refs counts requests in flight. A sandbox is only closed — for eviction or expiry — at
// zero, because a duet reply streams for as long as its request stays open, and closing
// the database under it would lose the reply.

const open = new Map();     // id -> { store, refs, lastUsed, ready }

async function acquire(id, onOpen) {
    let entry = open.get(id);
    if (!entry) {
        const store = openStore(fileFor(id));
        entry = { store, refs: 0, lastUsed: Date.now(), ready: null };
        // Whatever a desk does once at boot, a sandbox does once when it is opened.
        entry.ready = run(store, () => onOpen(store));
        open.set(id, entry);
        evict();
    }
    entry.refs++;
    try { await entry.ready; } catch (err) { entry.refs--; throw err; }
    return entry;
}

function evict() {
    const { openMax } = settings();
    if (open.size <= openMax) return;
    const idle = [...open.entries()].filter(([, e]) => e.refs === 0)
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [id, e] of idle) {
        if (open.size <= openMax) break;
        try { e.store.db.close(); } catch { /* already closed */ }
        open.delete(id);
    }
}

/** Delete a sandbox outright: its database files and its index row. Not while in use. */
function destroy(id) {
    const entry = open.get(id);
    if (entry && entry.refs > 0) return false;
    if (entry) { try { entry.store.db.close(); } catch { /* closed */ } open.delete(id); }
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(fileFor(id) + suffix, { force: true }); } catch { /* gone */ }
    }
    index().prepare('DELETE FROM sandboxes WHERE id = ?').run(id);
    return true;
}

/** Remove every sandbox idle longer than the TTL. Returns how many went. */
function sweep() {
    const cutoff = Date.now() - settings().ttlMs;
    const stale = index().prepare('SELECT id FROM sandboxes WHERE last_seen < ?').all(cutoff);
    return stale.filter(({ id }) => destroy(id)).length;
}

let sweeper = null;
function startSweeper() {
    if (sweeper) return;
    sweeper = setInterval(() => { try { sweep(); } catch (err) { console.error('sandbox sweep:', err.message); } },
        settings().sweepMs);
    sweeper.unref();
}

// ── admission: bounds on how fast, and how many, new sandboxes are made ──
//
// Addresses are counted in memory only and never written down. Behind a reverse proxy
// every visitor shares the proxy's address, so the per-address limit would become one
// global limit; AIRLOCK_TRUST_PROXY=1 reads the first X-Forwarded-For entry instead —
// only safe when a proxy you run sets that header, since anyone can send one.

const recent = new Map();   // address -> timestamps of sandboxes made in the last hour

function addressOf(req) {
    if (process.env.AIRLOCK_TRUST_PROXY === '1') {
        const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
        if (forwarded) return forwarded;
    }
    return req.socket?.remoteAddress || 'unknown';
}

function admit(req) {
    const { max, perIpHour } = settings();
    if (liveCount() >= max) {
        return { status: 503, error: 'This demo is full right now. Try again later — idle sandboxes are cleared regularly.' };
    }
    const ip = addressOf(req);
    const hourAgo = Date.now() - 3_600_000;
    const times = (recent.get(ip) || []).filter(t => t > hourAgo);
    if (times.length >= perIpHour) {
        return { status: 429, error: 'Too many new sandboxes from this address in the last hour.' };
    }
    times.push(Date.now());
    recent.set(ip, times);
    return null;
}

// ── the cookie ──

function readCookie(req) {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || '');
    const value = m ? decodeURIComponent(m[1]).trim() : '';
    return ID.test(value) ? value : null;
}

function setCookie(req, res) {
    return id => {
        const secure = req.secure || String(req.headers['x-forwarded-proto'] || '') === 'https';
        res.append('Set-Cookie', `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; `
            + `Max-Age=${Math.floor(settings().ttlMs / 1000)}${secure ? '; Secure' : ''}`);
    };
}

/**
 * Express middleware for /api: find this visitor's sandbox, or make one, and serve the
 * rest of the request inside it.
 *
 * A cookie that is malformed, unknown or expired gets a FRESH id, never the one it
 * offered: a sandbox is only ever reached through an id this server minted, so nobody
 * can plant a cookie on someone else's browser and then read what they do in it.
 *
 * `exempt` paths are served without a sandbox — /api/whoami, which launchers and tests
 * poll before anything else happens and which would otherwise mint one per probe.
 */
function middleware({ onOpen = async () => {}, exempt = [] } = {}) {
    return async (req, res, next) => {
        if (!sandboxed() || exempt.includes(req.path)) return next();
        try {
            const now = Date.now();
            let id = readCookie(req);
            let row = id ? indexed(id) : null;

            if (row && now - row.last_seen > settings().ttlMs) {
                destroy(id);
                row = null;
            }

            if (!row) {
                const refused = admit(req);
                if (refused) return res.status(refused.status).json({ error: refused.error });
                id = crypto.randomBytes(16).toString('hex');
                index().prepare('INSERT INTO sandboxes (id, created_at, last_seen) VALUES (?, ?, ?)')
                    .run(id, now, now);
                setCookie(req, res)(id);
            } else if (now - row.last_seen > TOUCH_MS) {
                index().prepare('UPDATE sandboxes SET last_seen = ? WHERE id = ?').run(now, id);
                setCookie(req, res)(id);   // sliding expiry
            }

            const entry = await acquire(id, onOpen);
            let released = false;
            const release = () => {
                if (released) return;
                released = true;
                entry.refs--;
                entry.lastUsed = Date.now();
            };
            res.on('finish', release);
            res.on('close', release);

            run(entry.store, next);
        } catch (err) {
            next(err);
        }
    };
}

// ─────────────────────────── per-visitor state that is not in a database ───────────────────────────

/** Is a visitor's store current right now? Never throws. */
const inContext = () => Boolean(context.getStore());

/**
 * A key for per-visitor state kept in memory: the kernel's record of what it has ruled on,
 * and the count of generations in flight. The store itself in sandbox mode; on a desk, one
 * fixed object — deliberately not the primary store, so asking whose memory this is never
 * opens a database as a side effect.
 */
const DESK = Object.freeze({ desk: true });
function scopeKey() {
    const store = context.getStore();
    if (store) return store;
    if (sandboxed()) current();      // throws, with the reason
    return DESK;
}

/**
 * How many generations one visitor may have in flight at once. The duet queue and the
 * GPU behind it are shared by every visitor; without a per-visitor cap, one tab firing
 * requests in a loop starves everyone else. Unlimited on a desk, where there is one person.
 */
const inFlight = new WeakMap();      // scope -> count

function takeSlot() {
    if (!sandboxed()) return () => {};
    const scope = scopeKey();
    const limit = num('AIRLOCK_SANDBOX_CONCURRENT', 2);
    const n = inFlight.get(scope) || 0;
    if (n >= limit) return null;
    inFlight.set(scope, n + 1);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        inFlight.set(scope, Math.max(0, (inFlight.get(scope) || 1) - 1));
    };
}

/**
 * The demo's total remote spend, per UTC day, kept in the operator index — not in any
 * visitor's database, and not in memory, so a restart or a crash loop does not refill it.
 * A per-process counter had exactly that gap, which matters most on the one kind of
 * instance a stranger can reach.
 */
const today = () => new Date().toISOString().slice(0, 10);
function ledger() {
    const db = index();
    db.exec('CREATE TABLE IF NOT EXISTS ledger (day TEXT PRIMARY KEY, calls INTEGER NOT NULL)');
    return {
        calls: () => db.prepare('SELECT calls FROM ledger WHERE day = ?').get(today())?.calls || 0,
        add: () => db.prepare(`INSERT INTO ledger (day, calls) VALUES (?, 1)
                               ON CONFLICT(day) DO UPDATE SET calls = calls + 1`).run(today())
    };
}

/** For the boot log. */
function describe() {
    const { dir, ttlMs, max } = settings();
    return `  sandboxes -> one per visitor in ${dir}, ${liveCount()} live, `
        + `removed after ${Math.round(ttlMs / 3_600_000)} h idle (max ${max}).`;
}

module.exports = {
    openStore, primaryStore, current, run, bind, routed, sandboxed,
    middleware, sweep, startSweeper, destroy, describe,
    inContext, scopeKey, takeSlot, ledger,
    COOKIE,
    _open: open, _index: index                         // tests
};
