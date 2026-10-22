'use strict';

/**
 * What a gate ruling may repeat, and what is left of it after a delete.
 *   node tools/ruling_test.js
 *
 * Found on the desk 2026-10-22: a Sep 28 ruling, made by a gate model before the scanner
 * existed, listed an AWS key id and its secret IN FULL as its concerns. The ruling is kept on
 * the blocked reply, so the refusal held exactly what it refused to send — shown in the red
 * card, and left in airlock.db after the message itself was deleted.
 *
 *   1. masking     known formats, and secret-shaped text copied verbatim from what the gate
 *                  read, become the scanner's preview; ordinary concerns are untouched
 *   2. the gate    runGate masks whatever a gate model echoes, before anyone stores it
 *   3. the page    the red card masks a ruling stored before any of this existed
 *   4. migration   an old database has its stored rulings scrubbed on open
 *   5. delete      deleting a message takes the ruling's words about it, on disk too
 *
 * Offline: no server, no Ollama. The gate model is a fake that echoes; the databases are
 * scratch files opened by the current db.js in child processes, as clearance_test.js does.
 * Every value is fabricated for this file.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const secrets = require('../secrets');

let pass = 0, fail = 0;
const ok = (cond, label, detail = '') => {
    if (cond) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
};

// The desk's case, and two secrets no scanner rule has a pattern for on their own.
const KEY = 'AKIAQX7RZ3M4TB2WKLPE';
const SECRET = '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';
const ASKED = `Why does this fail? aws configure set aws_access_key_id ${KEY} && aws configure set aws_secret_access_key ${SECRET}`;
const PASSWORD = 'Zq7!vR2pLm9x';
const TOKEN = 'k3Rt9Wq2Lz8Px5Nv';
const SAID = `The wifi password is ${PASSWORD}. And the build token: ${TOKEN}.`;
const ORDINARY = ["a person's phone number", 'AWS credentials', 'qwen2.5:14b', 'report2024.pdf',
    'Win32Exception in Base64Encoder', 'the meeting on 2026-10-22', 'version v2.4.1'];

const holds = (value, ...secretsIn) => secretsIn.filter(s => JSON.stringify(value).includes(s));

(async () => {
    // ─────────────────────── 1. masking ───────────────────────
    console.log('\n1. what a ruling may repeat');
    {
        const old = { release: false, reason: 'contains AWS credentials', concerns: [KEY, SECRET], model: 'nemotron-3-nano:4b' };
        const masked = secrets.maskRuling(old, ASKED);
        ok(!holds(masked, KEY, SECRET).length, 'the desk\'s ruling: neither the key id nor the secret survives', JSON.stringify(masked));
        ok(masked.concerns.join() === 'AKIA…PE,q8Vd…Qv', 'each becomes the scanner\'s own preview', masked.concerns.join());
        ok(masked.reason === 'contains AWS credentials' && masked.model === old.model && masked.release === false,
            'the reason, the model and the decision are left as they were');

        const echoed = secrets.maskRuling({ release: false,
            reason: `It gives the password ${PASSWORD} and a token (${TOKEN}).`,
            concerns: [`password: ${PASSWORD}`, `"${TOKEN}"`, ...ORDINARY] }, SAID);
        ok(!holds(echoed, PASSWORD, TOKEN).length, 'a password and a token no rule knows are masked when copied from the input',
            JSON.stringify(echoed));
        ok(JSON.stringify(echoed.concerns.slice(2)) === JSON.stringify(ORDINARY),
            'ordinary concerns are untouched, names with digits included', JSON.stringify(echoed.concerns.slice(2)));
        ok(JSON.stringify(secrets.maskRuling(echoed, SAID)) === JSON.stringify(echoed), 'masking twice changes nothing');

        // Shaped like a secret, but the gate never read it: the model's own words are not guessed at.
        const own = secrets.maskRuling({ reason: 'x', concerns: [TOKEN] }, 'nothing like it here');
        ok(own.concerns[0] === TOKEN, 'only what was copied from the input is masked, not anything key-shaped');
        // A known format is masked wherever it appears, read or not.
        ok(secrets.redact(`key ${KEY}`) === 'key AKIA…PE', 'a known format is masked even without the input');
        ok(secrets.maskRuling(secrets.rule(ASKED), ASKED).concerns.join() === secrets.rule(ASKED).concerns.join(),
            'the scanner\'s own ruling passes through unchanged');
    }

    // ─────────────────────── 2. the gate ───────────────────────
    console.log('\n2. runGate, with a gate model that echoes');
    {
        const providers = require('../providers');
        const { runGate } = require('../boundary');
        await providers.ensureFresh().catch(() => {});
        const real = providers.complete;
        providers.registry._entries.set('fake-echo', { id: 'fake-echo', tier: 'local', size: 0 });
        try {
            providers.complete = async () => ({ thinking: '', content: JSON.stringify({ release: false,
                reason: `The password ${PASSWORD} is in it.`,
                concerns: [`password ${PASSWORD}`, `build token ${TOKEN}`, "a person's phone number", 'AWS credentials'] }) });
            const ruled = await runGate(`user: ${SAID}`, { model: 'fake-echo' });
            ok(ruled.release === false && ruled.model === 'fake-echo', 'the model\'s refusal stands', JSON.stringify(ruled));
            ok(!holds(ruled, PASSWORD, TOKEN).length, 'and what it repeated of the password and token is masked',
                JSON.stringify(ruled));
            ok(ruled.concerns.slice(2).join('|') === "a person's phone number|AWS credentials", 'its ordinary concerns are not');

            // An answer that could not be read is kept, raw, for diagnosis: masked too.
            providers.complete = async () => ({ thinking: '', content: `I refuse, the token ${TOKEN} must stay` });
            const unread = await runGate(`user: ${SAID}`, { model: 'fake-echo' });
            ok(unread.undecided && unread.unparsed && !holds(unread, TOKEN).length,
                'the raw text of an unreadable answer is masked as well', JSON.stringify(unread));
        } finally {
            providers.complete = real;
            providers.registry._entries.delete('fake-echo');
        }
    }

    // ─────────────────────── 3. the page ───────────────────────
    console.log('\n3. the red card');
    {
        const page = fs.readFileSync(path.join(ROOT, 'public', 'duet.js'), 'utf8');
        const from = page.indexOf('function gateHtml(');
        const body = from === -1 ? '' : page.slice(from, page.indexOf('\n}\n', from) + 2);
        const render = withScanner => {
            const ctx = { window: {}, maskedRulings: new WeakMap(), escapeHtml: s => String(s).replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`) };
            vm.createContext(ctx);
            if (withScanner) vm.runInContext(fs.readFileSync(path.join(ROOT, 'secrets.js'), 'utf8'), ctx);
            vm.runInContext(body, ctx);
            return ctx.gateHtml;
        };
        const stored = { release: false, reason: 'contains AWS credentials', concerns: [KEY, SECRET, "a person's phone number"],
            model: 'nemotron-3-nano:4b' };
        const html = body ? render(true)(stored, null, '', ASKED) : '';
        ok(html && !holds(html, KEY, SECRET).length && html.includes('AKIA…PE') && html.includes('q8Vd…Qv'),
            'a ruling stored in full renders masked', html.replace(/\s+/g, ' ').slice(0, 300));
        ok(html.includes('contains AWS credentials') && html.includes("a person's phone number"),
            'and its ordinary words render as they were');
        const bare = body ? render(false)(stored, null, '', ASKED) : '';
        ok(bare && !holds(bare, KEY, SECRET).length, 'with the scanner missing, the model\'s words are not shown unchecked');
        const erased = body ? render(true)({ release: false, concerns: [], erased: true, model: 'm' }, null, '', '') : '';
        ok(/went with the message/.test(erased), 'a ruling whose words were erased says so');
    }

    // ─────────────────────── 4 and 5: the database ───────────────────────
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airlock-ruling-'));
    const DB = path.join(tmp, 'ruling.db');
    const onDisk = (...values) => [DB, `${DB}-wal`].filter(f => fs.existsSync(f))
        .flatMap(f => values.filter(v => fs.readFileSync(f).includes(v)));
    const withDb = code => JSON.parse(execFileSync(process.execPath, ['-e', `
        const store = require(${JSON.stringify(path.join(ROOT, 'db.js'))});
        const duet = require(${JSON.stringify(path.join(ROOT, 'duet-store.js'))});
        const gateOf = id => (duet.getMessage(id).requestMeta || {}).gate;
        const out = (() => { ${code} })();
        store.db.close();
        process.stdout.write(JSON.stringify(out ?? null));
    `], { env: { ...process.env, AIRLOCK_DB: DB }, stdio: ['ignore', 'pipe', 'pipe'] }).toString());

    try {
        console.log('\n4. rulings stored before masking, scrubbed on open');
        // What the old code left: the desk's ruling in full on a reply to a live message, and
        // one quoting a password on a reply to a message already deleted — the second defect.
        const planted = withDb(`
            const [tray] = store.getTree();
            const t = store.createThread(tray.id, 'old rulings');
            const blocked = (replyTo, gate) => duet.appendMessage({ threadId: t.id, role: 'assistant', content: '',
                status: 'blocked', replyTo, requestMeta: { gate } }).id;
            const asked = duet.appendMessage({ threadId: t.id, role: 'user', content: ${JSON.stringify(ASKED)} }).id;
            const a = blocked(asked, { release: false, reason: 'contains AWS credentials',
                concerns: [${JSON.stringify(KEY)}, ${JSON.stringify(SECRET)}], model: 'nemotron-3-nano:4b' });
            const gone = duet.appendMessage({ threadId: t.id, role: 'user', content: 'wifi pass ${PASSWORD}, at Wren Cottage' }).id;
            const b = blocked(gone, { release: false, reason: 'a password, at Wren Cottage',
                concerns: ['password ${PASSWORD}'], model: 'nemotron-3-nano:4b' });
            const plain = duet.appendMessage({ threadId: t.id, role: 'user', content: 'call Ada on her mobile' }).id;
            const c = blocked(plain, { release: false, reason: 'a phone number', concerns: ${JSON.stringify(ORDINARY)}, model: 'm' });
            // The old delete: the message's words went, its ruling's did not.
            store.db.prepare("UPDATE packets SET content = '', status = 'deleted', deleted_at = ? WHERE id = ?").run(new Date().toISOString(), gone);
            store.db.prepare("DELETE FROM meta WHERE key = 'gate_rulings_masked'").run();
            store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
            return { t: t.id, asked, a, b, c, plain };
        `);
        ok(onDisk(SECRET, PASSWORD).length === 2, 'a database holding both, as the old code left it', onDisk(SECRET, PASSWORD).join());

        const after = withDb(`return { a: gateOf(${planted.a}), b: gateOf(${planted.b}), c: gateOf(${planted.c}),
            flag: Boolean(store.getMeta('gate_rulings_masked')) };`);
        ok(!holds(after.a, KEY, SECRET).length && after.a?.concerns?.join() === 'AKIA…PE,q8Vd…Qv',
            'the desk\'s ruling is masked on open', JSON.stringify(after.a));
        ok(after.b?.erased && !holds(after.b, PASSWORD, 'Wren Cottage').length && after.b.model === 'nemotron-3-nano:4b' && after.b.release === false,
            'a ruling on a message already deleted loses its words, keeping the decision and who made it', JSON.stringify(after.b));
        ok(JSON.stringify(after.c?.concerns) === JSON.stringify(ORDINARY) && after.c.reason === 'a phone number',
            'an ordinary ruling is untouched', JSON.stringify(after.c));
        ok(after.flag, 'and the migration is marked done');
        ok(!onDisk(PASSWORD).length, 'the deleted message\'s password is no longer in the file or its write-ahead log');

        console.log('\n5. deleting a message takes its ruling\'s words');
        // Rulings made now are masked already, so what is left to erase is what a ruling says
        // about a message in words that are not secret-shaped — and a ruling elsewhere that
        // copied something secret-shaped the mask had no input to recognise it by.
        const made = withDb(`
            const t = ${planted.t};
            const said = duet.appendMessage({ threadId: t, role: 'user', content: ${JSON.stringify(SAID + ' Leave it under the blue heron mat.')} }).id;
            const on = duet.appendMessage({ threadId: t, role: 'assistant', content: '', status: 'blocked', replyTo: said,
                requestMeta: { gate: { release: false, reason: 'a password, under the blue heron mat', concerns: ['the blue heron mat'], model: 'm' } } }).id;
            const elsewhere = duet.appendMessage({ threadId: t, role: 'assistant', content: '', status: 'blocked', replyTo: ${planted.plain},
                requestMeta: { gate: { release: false, reason: 'quoted ${TOKEN}', concerns: [], model: 'm' } } }).id;
            store.deletePacket(said);
            store.deletePacket(${planted.asked});
            return { on: gateOf(on), elsewhere: gateOf(elsewhere), a: gateOf(${planted.a}), c: gateOf(${planted.c}) };
        `);
        ok(made.on?.erased && !holds(made.on, 'heron').length && made.on.release === false && made.on.model === 'm',
            'the ruling on it loses its words, and keeps its decision', JSON.stringify(made.on));
        ok(made.elsewhere?.reason === 'quoted k3Rt…Nv', 'a ruling on another message loses what it copied from it',
            JSON.stringify(made.elsewhere));
        ok(made.a?.erased && !holds(made.a, 'AKIA…PE').length, 'the desk\'s case: deleting the request erases even the previews',
            JSON.stringify(made.a));
        ok(JSON.stringify(made.c?.concerns) === JSON.stringify(ORDINARY), 'a ruling on an unrelated message is untouched');
        const left = onDisk(KEY, SECRET, PASSWORD, TOKEN, 'heron');
        ok(!left.length, 'and none of it is left in the database file, or its write-ahead log', left.join());
    } catch (err) {
        fail++;
        console.log('  FAIL ruling_test could not run — ' + (err.stack || err.message));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }

    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
})();
