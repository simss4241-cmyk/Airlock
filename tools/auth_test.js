'use strict';

/**
 * Access-control tests.
 *
 * Audit finding 3: every route was reachable by anything that could reach the
 * port. Correct for a desktop app, a hard blocker for a hosted demo — a visitor
 * could read and delete other visitors' packets and spend the owner's Token
 * Factory credits through /api/escalate.
 *
 * These run entirely offline against the middleware, with fake req/res objects.
 * The properties worth pinning are the conditional ones: OPEN without a token
 * configured (so a local user is never asked to log in to their own machine),
 * CLOSED with one, and a spend cap that actually stops counting up.
 *
 *   node tools/auth_test.js
 */

const auth = require('../auth');

let pass = 0, fail = 0;
const ok = (cond, label) => {
    if (cond) { pass++; console.log('  ok   ' + label); }
    else { fail++; console.log('  FAIL ' + label); }
};

/** Minimal Express-shaped doubles — enough for the guard, nothing more. */
function fakeReq({ header = null, cookie = null } = {}) {
    return {
        headers: cookie ? { cookie } : {},
        get(name) {
            return name.toLowerCase() === 'x-airlock-token' ? header : undefined;
        }
    };
}

function fakeRes() {
    const res = { code: null, body: null };
    res.status = c => { res.code = c; return res; };
    res.json = b => { res.body = b; return res; };
    return res;
}

function run(reqOpts) {
    const req = fakeReq(reqOpts);
    const res = fakeRes();
    let nexted = false;
    auth.guard(req, res, () => { nexted = true; });
    return { allowed: nexted, code: res.code, body: res.body };
}

function withEnv(vars, fn) {
    const saved = {};
    for (const [k, v] of Object.entries(vars)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try { return fn(); } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

console.log('\nAirlock access tests');

console.log('\nno token configured (local desktop)');
withEnv({ AIRLOCK_TOKEN: undefined }, () => {
    ok(run({}).allowed, 'an unauthenticated request is allowed');
    ok(run({ header: 'anything' }).allowed, 'a stray token is harmless');
});

console.log('\ntoken configured (hosted)');
withEnv({ AIRLOCK_TOKEN: 'secret-abc-123' }, () => {
    const bare = run({});
    ok(!bare.allowed, 'a request with no token is refused');
    ok(bare.code === 401, 'with 401');
    ok(bare.body && bare.body.needsToken === true,
       'and a needsToken flag, so the page knows to prompt rather than error');

    ok(!run({ header: 'wrong' }).allowed, 'a wrong token is refused');
    ok(!run({ header: 'secret-abc-12' }).allowed, 'a prefix of the token is refused');
    ok(!run({ header: 'secret-abc-1234' }).allowed, 'a superstring of the token is refused');
    ok(!run({ header: '' }).allowed, 'an empty token is refused');

    ok(run({ header: 'secret-abc-123' }).allowed, 'the right token in a header is allowed');
    ok(run({ header: '  secret-abc-123  ' }).allowed, 'surrounding whitespace is tolerated');
    ok(run({ cookie: 'airlock_token=secret-abc-123' }).allowed,
       'the right token in a cookie is allowed');
    ok(run({ cookie: 'other=x; airlock_token=secret-abc-123; more=y' }).allowed,
       'found among other cookies');
    ok(!run({ cookie: 'airlock_token=nope' }).allowed, 'a wrong cookie is refused');

    // A header must win over a stale cookie, or a rotated token can never recover.
    ok(run({ header: 'secret-abc-123', cookie: 'airlock_token=stale' }).allowed,
       'a correct header beats a stale cookie');
});

console.log('\nwhitespace-only token counts as unset');
withEnv({ AIRLOCK_TOKEN: '   ' }, () => {
    ok(run({}).allowed, 'a blank token does not half-enable auth');
});

console.log('\ntiming-safe comparison');
ok(auth.sameSecret('abc', 'abc'), 'equal strings match');
ok(!auth.sameSecret('abc', 'abd'), 'differing strings do not');
ok(!auth.sameSecret('abc', 'abcd'), 'different lengths do not');
ok(!auth.sameSecret(null, 'abc') && !auth.sameSecret('abc', undefined),
   'non-strings do not match');

console.log('\nremote spend cap');
withEnv({ AIRLOCK_REMOTE_BUDGET: undefined }, () => {
    ok(auth.spendRemote() === null, 'no budget configured means no limit');
});

// The counter is process-wide, so this has to be the last block: it spends the
// allowance it configures, and there is no reset.
withEnv({ AIRLOCK_REMOTE_BUDGET: '2' }, () => {
    const before = auth.remoteSpend().used;
    ok(auth.remoteSpend().budget === 2, 'the budget is read from the environment');

    // Spend up to the cap from wherever the count already stands.
    let blocked = null;
    for (let i = 0; i < 5 && blocked === null; i++) blocked = auth.spendRemote();

    ok(typeof blocked === 'string', 'the cap eventually refuses');
    ok(/allowance/i.test(blocked || ''), 'with a message naming the allowance');
    ok(/local tier still works/i.test(blocked || ''),
       'and saying the local tier is unaffected — a spent budget is not an outage');
    ok(auth.remoteSpend().used >= before, 'usage is reported');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
