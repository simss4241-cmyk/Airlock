'use strict';

/**
 * Access control, and a spend guard.
 *
 * Airlock was built as a desktop app: one person, their own machine, no login.
 * Hosting it changes that completely — every route is reachable by anyone who
 * knows the URL, which means reading and deleting other people's packets and
 * spending the owner's Token Factory credits through /api/escalate.
 *
 * So the rule is conditional rather than absolute:
 *
 *   AIRLOCK_TOKEN unset  ->  open. This is a local desktop app and requiring a
 *                            login to read your own notes would be absurd.
 *   AIRLOCK_TOKEN set    ->  every /api route requires it.
 *
 * Conditional because the alternative — auth always on — would push every local
 * user into storing a credential to talk to their own machine, and the usual
 * outcome of that is a token committed to a repository.
 *
 * This is a shared secret, not identity. It answers "may you use this instance",
 * not "who are you". Anyone holding it sees the same data as anyone else holding
 * it, which is fine for a demo and is NOT a substitute for per-user isolation.
 * Said plainly here so nobody mistakes it for multi-tenancy.
 */

const TOKEN = () => (process.env.AIRLOCK_TOKEN || '').trim();

/** Guarded because a hosted instance spends real money on every crossing. */
const REMOTE_BUDGET = () => {
    const n = Number(process.env.AIRLOCK_REMOTE_BUDGET);
    return Number.isFinite(n) && n > 0 ? n : 0;      // 0 = unlimited
};

let remoteCalls = 0;

/**
 * Timing-safe compare. Overkill for a demo token and still correct: a plain
 * `===` on strings leaks length and prefix through timing, and getting this
 * habit wrong in something that later guards something real is how it happens.
 */
function sameSecret(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

function presented(req) {
    const header = req.get('x-airlock-token');
    if (header) return header.trim();

    // A bare cookie, so a browser given the link once keeps working across
    // reloads without the token living in every URL and thus in history.
    const cookie = /(?:^|;\s*)airlock_token=([^;]+)/.exec(req.headers.cookie || '');
    if (cookie) return decodeURIComponent(cookie[1]).trim();

    return '';
}

/** Express middleware. Mount on /api only: the page itself must load to ask. */
function guard(req, res, next) {
    const token = TOKEN();
    if (!token) return next();                        // local mode
    if (sameSecret(presented(req), token)) return next();

    res.status(401).json({
        error: 'This Airlock instance requires an access token.',
        needsToken: true
    });
}

/**
 * Called once per remote request. Returns an error string when the instance has
 * spent its allowance, or null to proceed.
 *
 * Deliberately a process-lifetime count rather than a rolling window: a demo
 * instance that has answered a few hundred crossings has served its purpose,
 * and a restart resets it. A rolling window would need storage and would still
 * be gameable by whoever holds the shared token.
 */
function spendRemote() {
    const budget = REMOTE_BUDGET();
    if (!budget) return null;
    if (remoteCalls >= budget) {
        return `This instance has used its remote-call allowance (${budget}). `
             + 'The local tier still works, and a restart resets the count.';
    }
    remoteCalls++;
    return null;
}

function remoteSpend() {
    return { used: remoteCalls, budget: REMOTE_BUDGET() };
}

/** One line at boot, because an unauthenticated hosted instance is a mistake. */
function describe(port) {
    const token = TOKEN();
    const budget = REMOTE_BUDGET();
    const lines = [];

    if (token) {
        lines.push(`  auth      -> token required (${token.length} chars)`);
    } else {
        lines.push('  auth      -> OPEN. Correct for localhost; set AIRLOCK_TOKEN before hosting.');
    }
    lines.push(budget
        ? `  remote    -> capped at ${budget} call(s) per process`
        : '  remote    -> uncapped. Set AIRLOCK_REMOTE_BUDGET before hosting.');

    return lines.join('\n');
}

module.exports = { guard, spendRemote, remoteSpend, describe, sameSecret };
