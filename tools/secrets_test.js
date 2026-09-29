'use strict';

/**
 * The secret scanner.  node tools/secrets_test.js
 *
 * Offline: no server, no Ollama, no network. Two halves, and the second matters as much
 * as the first:
 *
 *   - every rule fires on a value in its documented format
 *   - things that only LOOK like secrets pass: hashes, UUIDs, public keys, the providers'
 *     own documentation examples, template placeholders, code that names a secret without
 *     containing one. A scanner that withholds those teaches people to override the gate.
 *
 * Then the wiring: runGate must return the scanner's refusal WITHOUT calling a model, and
 * must still call the model for anything the scanner passes — the scanner only withholds.
 *
 * Every value below is fabricated for this file. None is a real credential, and none is
 * copied from the gate bench's cases (tools/gate_bench.js, tools/gate_holdout.js): rules
 * fitted to the bench would pass the bench and prove nothing.
 */

const { scan, rule } = require('../secrets');

let pass = 0, fail = 0;
const ok = (cond, label, detail = '') => {
    if (cond) { pass++; console.log('  ok   ' + label); }
    else { fail++; console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')); }
};

const rulesIn = text => scan(text).map(h => h.rule);
const fires = (text, id, label) => {
    const got = rulesIn(text);
    ok(got.includes(id), label, `found ${JSON.stringify(got)}`);
};
const clean = (text, label) => {
    const got = scan(text);
    ok(got.length === 0, label, `found ${JSON.stringify(got.map(h => `${h.rule}:${h.preview}`))}`);
};

// ─────────────────────────── each rule fires ───────────────────────────

console.log('\nknown formats are caught');

fires('-----BEGIN RSA PRIVATE KEY-----\nMIIEow...', 'private-key', 'an RSA private key header');
fires('-----BEGIN EC PRIVATE KEY-----', 'private-key', 'an EC private key header');
fires('key: ASIAZ4RT7WQ2MNB6XK3P', 'aws-access-key', 'an AWS temporary access key id');
fires('aws_secret_access_key = Jh3kP9vQ2wLx7ZrT5mNb8YcF1dGs4HaE6uKo0RiW', 'aws-secret-key',
    'an AWS secret access key after its name');
fires('token ghs_a8Kd3Lq9Zx2Vn7Mw4Pr6Ty1Bc5Hf0Jg3Ks8U', 'github-token', 'a GitHub app token');
clean('token ghs_a8Kd3Lq9Zx2Vn7Mw4Pr6Ty1Bc5Hf0Jg3Ks8Ue', 'a ghs_ string one character too long is not the format');
fires('glpat-Rk4mZ8qT2xW7vN3pL9sY', 'gitlab-token', 'a GitLab personal access token');
fires('SLACK_BOT=xoxb-2210987654-4455667788-aBcDeFgHiJkLmNoP', 'slack-token', 'a Slack bot token');
fires('https://hooks.slack.com/services/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',
    'slack-webhook', 'a Slack incoming webhook');
fires('rk_test_7Hq2Xm9Kv4Lp1Zt8Wn3Rb6Yc', 'stripe-key', 'a Stripe restricted test key — test keys are still keys');
fires('AIzaQ7mK2xL9pV4tR8wN3zB6yC1hF5jG0sU2eD4', 'google-api-key', 'a Google API key');
fires('ANTHROPIC_KEY sk-ant-api03-Zq8Lm3Kx7Vp2Rt9Wn4Yb6Hc1Jd5Fg0', 'anthropic-key', 'an Anthropic key');
fires('sk-svcacct-Mn4Bv8Cx2Zl6Kj9Hg3Fd7Sa1Qw5Er0Ty', 'openai-key', 'an OpenAI service-account key');
fires('Authorization: Bearer eyJ0eXAiOiJKV1QifQ.eyJ1aWQiOiI0MiJ9.Qx7Lm2Kp9Vt4Rw8Nz3Yb',
    'jwt', 'a JWT in a header');
fires('amqp://queue_user:Vw8!kQ2z@broker.lan:5672/', 'url-credentials', 'a password inside an AMQP URL');
fires('ftp://:s3cr3tPass@files.lan/', 'url-credentials', 'a password with no user name');
fires('export DB_PASSWORD=Kq7vZ2mX9pL4', 'env-secret', 'an exported env password');
fires('WEBHOOK_SECRET="f3a9c1e7b2d8"', 'env-secret', 'a quoted env secret');
fires('config = { "client_secret": "Zx9Kq2Lm7Vp4" }', 'quoted-secret', 'a client secret in JSON');
fires("db.connect(user, password='Hunter2Hunter2')", 'quoted-secret', 'a password literal in code');
fires('card 5425 2334 3010 9903 declined', 'payment-card', 'a Mastercard-format number that passes Luhn');
fires('3782-822463-10005', 'payment-card', 'an Amex-format number with dashes');
fires('SSN 219-09-9999 on file', 'us-ssn', 'a US SSN');

// ─────────────────────────── look-alikes pass ───────────────────────────

console.log('\nlook-alikes are not withheld');

clean('sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'a SHA-256 digest');
clean('trace id 7c9e6679-7425-40de-944b-e07fc1f90ae7', 'a UUID');
clean('commit 1f3c9a7e2b4d6f8a0c2e4f6a8b0d2f4a6c8e0a2b', 'a git commit hash');
clean('-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYI...\n-----END PUBLIC KEY-----', 'a PUBLIC key block');
clean('-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIU...', 'a certificate');
clean('AWS documents AKIAIOSFODNN7EXAMPLE as its sample key id', "AWS's own documentation example");
clean('aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', "AWS's documented example secret");
clean('OPENAI_API_KEY=your-api-key-here', 'an env template placeholder');
clean('API_TOKEN=<paste your token>', 'an angle-bracket placeholder');
clean('DB_PASSWORD=${DB_PASSWORD}', 'an env reference, not a value');
clean('SECRET_KEY=xxxxxxxxxxxxxxxx', 'an x-ed out value');
clean('password = hashPassword(password)', 'code that names a password without holding one');
clean('const apiKey = process.env.API_KEY;', 'reading a key from the environment');
clean('postgres://app_user@db.lan:5432/app', 'a URL with a user and no password');
clean('postgres://app_user:${PGPASSWORD}@db.lan/app', 'a URL whose password is a variable');
clean('Match keys like /AKIA[A-Z2-7]{16}/ in the scanner', 'a regex describing a key format');
clean('call me on 503-555-0199', 'a US phone number');
clean('order 4111 1111 1111 1112 shipped', 'a card-shaped number that fails Luhn');
clean('invoice 1234567890123456', 'a 16-digit number with no card prefix');
clean('https://127.0.0.1:8100/api/threads/2', 'a localhost URL with a port');
clean('How do I rotate a Stripe secret key without downtime?', 'talking about keys');

// ─────────────────────────── what the ruling says ───────────────────────────

console.log('\nthe ruling');

const ruling = rule('try this: glpat-Rk4mZ8qT2xW7vN3pL9sY');
ok(ruling && ruling.release === false, 'a hit is a refusal');
ok(ruling && ruling.ruledBy === 'secret scanner' && ruling.model === null,
    'it says the scanner ruled, and names no model — none did');
ok(ruling && !JSON.stringify(ruling).includes('Rk4mZ8qT2xW7vN3pL9sY'),
    'the ruling never repeats the secret in full', JSON.stringify(ruling?.concerns));
ok(rule('nothing to see here') === null, 'no hit leaves the decision to the model');

const two = scan('ANTHROPIC_KEY sk-ant-api03-Zq8Lm3Kx7Vp2Rt9Wn4Yb6Hc1Jd5Fg0');
ok(two.length === 1 && two[0].rule === 'anthropic-key',
    'one secret is one finding, named by its most specific rule', JSON.stringify(two.map(h => h.rule)));

// ─────────────────────────── wired into the gate ───────────────────────────

(async () => {
    console.log('\nthe gate');

    const providers = require('../providers');
    const { runGate } = require('../boundary');

    await providers.ensureFresh().catch(() => {});
    const real = providers.complete;
    providers.registry._entries.set('fake', { id: 'fake', tier: 'local', size: 0 });

    let calls = 0;
    providers.complete = async () => {
        calls++;
        return { content: '{"release": true, "reason": "fine", "concerns": []}', thinking: '' };
    };

    try {
        const held = await runGate('user: deploy with glpat-Rk4mZ8qT2xW7vN3pL9sY please', { model: 'fake' });
        ok(held.release === false && held.ruledBy === 'secret scanner',
            'runGate withholds a known format', JSON.stringify(held));
        ok(calls === 0, 'without calling the gate model at all', `${calls} call(s)`);

        const passed = await runGate('user: what is a mutex?', { model: 'fake' });
        ok(calls === 1, 'a clean scan still goes to the gate model — the scanner cannot release');
        ok(passed.release === true && passed.model === 'fake', 'and the model rules', JSON.stringify(passed));

        providers.complete = async () => ({ content: '{"release": false, "reason": "no", "concerns": []}', thinking: '' });
        const refused = await runGate('user: a perfectly ordinary sentence', { model: 'fake' });
        ok(refused.release === false && refused.model === 'fake',
            'the model can still withhold what the scanner passed');
    } finally {
        providers.complete = real;
        providers.registry._entries.delete('fake');
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
