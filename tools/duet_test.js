'use strict';

/**
 * Duet tests — two participants, one conversation, and the boundary between them.
 *
 *   npm start                       # in one terminal
 *   node tools/duet_test.js
 *   AIRLOCK_URL=http://localhost:8126 node tools/duet_test.js
 *
 * Self-contained: builds its own tray, thread and participants and deletes them again.
 * Like tools/smoke_test.js it never depends on the seeded trays existing.
 *
 * Division of labour with tools/duet_context_test.js: that file owns the SHAPE of a
 * context (who becomes an assistant turn, what gets labelled, what the budget drops) and
 * needs nothing running. This file owns everything observable over HTTP — ownership,
 * addressing, server-assigned order, snapshot isolation, cancellation, retries, and the
 * boundary rules. Assertions are made against `requestMeta.sourceIds`, the exact set of
 * packets a generation was built from, rather than against model prose, so they hold
 * whatever the local model happens to say.
 *
 * Generation tests need Ollama and SKIP without it. The remote-tier crossing test needs
 * no key at all: it asserts the thing that must be true when a crossing does NOT happen.
 */

const BASE = process.env.AIRLOCK_URL || 'http://localhost:8100';
const FIXTURE = 'ZZ DUET TEST';

let pass = 0, fail = 0, skip = 0;

const ok = (cond, label, detail = '') => {
    if (cond) { pass++; console.log('  ok   ' + label); }
    else { fail++; console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
};
const skipped = label => { skip++; console.log('  skip ' + label); };

async function api(method, route, body) {
    const res = await fetch(BASE + route, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, json: await res.json().catch(() => null) };
}

const get = r => api('GET', r).then(x => x.json);
const post = (r, b) => api('POST', r, b);
const patch = (r, b) => api('PATCH', r, b);
const del = r => api('DELETE', r);

/** Send to one participant and collect the NDJSON event stream. */
async function send(threadId, body, { onEvent, signal } = {}) {
    const res = await fetch(`${BASE}/api/duet/${threadId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        return { events: [], error: err.error };
    }

    const events = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (!line.trim()) continue;
                const event = JSON.parse(line);
                events.push(event);
                await onEvent?.(event);
            }
        }
    } catch (err) {
        if (err.name !== 'AbortError') throw err;
        events.push({ type: 'client-aborted' });
    }

    return { events, error: null };
}

const last = (events, type) => [...events].reverse().find(e => e.type === type);
const sourcesOf = message => message?.requestMeta?.sourceIds || [];

async function scrub() {
    for (const f of await get('/api/tree')) {
        if (f.name === FIXTURE) await del(`/api/folders/${f.id}`);
    }
}

(async () => {
    console.log(`\nAirlock duet test -> ${BASE}\n`);

    const health = await get('/api/health');
    if (!health) {
        console.error('  No server at ' + BASE + '. Start it with `npm start`.\n');
        process.exit(1);
    }

    // The smallest local model available: these tests care about plumbing, not answers,
    // and a 30B would make the suite take minutes for no extra coverage.
    const locals = (health.models || []).filter(m => m.tier !== 'remote' && m.size);
    const LOCAL = locals.sort((a, b) => a.size - b.size)[0]?.name || null;
    const canGenerate = Boolean(health.ollama && LOCAL);

    if (canGenerate) console.log(`  (generating with ${LOCAL})\n`);
    else console.log('  (Ollama unreachable — generation tests will skip)\n');

    await scrub();
    const baseStats = await get('/api/stats');

    const tray = (await post('/api/folders', { name: FIXTURE })).json;
    const thread = (await post('/api/threads', { folderId: tray.id, title: 'duet-fixture' })).json;

    // A pre-duet packet, so backward compatibility is tested against a real legacy row.
    const legacy = (await post('/api/packets', {
        threadId: thread.id, role: 'assistant',
        content: 'An answer from before this thread had participants.', model: 'qwen2.5:7b'
    })).json;
    ok(!!legacy?.id, 'a classic packet still writes to a thread that later becomes a duet');

    // ── enabling ──
    const enabled = (await post(`/api/duet/${thread.id}/enable`, {})).json;
    ok(enabled.participants?.length === 2, 'enabling a duet creates exactly two participants',
        JSON.stringify(enabled.participants));
    ok(enabled.participants[0].name !== enabled.participants[1].name,
        'the two participants get distinct identities');
    ok(enabled.participants.map(p => p.slot).join() === 'a,b', 'slots are left and right');

    const again = (await post(`/api/duet/${thread.id}/enable`, {})).json;
    ok(again.participants.length === 2, 'enabling twice does not create a third participant');

    let [LEFT, RIGHT] = enabled.participants;

    LEFT = (await patch(`/api/duet/participants/${LEFT.id}`, { name: 'Lyra' })).json;
    RIGHT = (await patch(`/api/duet/participants/${RIGHT.id}`, { name: 'Ember' })).json;

    const clash = await patch(`/api/duet/participants/${RIGHT.id}`, { name: 'Lyra' });
    ok(clash.status === 400, 'two participants cannot share one name', JSON.stringify(clash.json));

    if (canGenerate) {
        // Both panes on the SAME model, deliberately: identity must not come from it.
        LEFT = (await patch(`/api/duet/participants/${LEFT.id}`, { model: LOCAL })).json;
        RIGHT = (await patch(`/api/duet/participants/${RIGHT.id}`, { model: LOCAL })).json;
        ok(LEFT.model === RIGHT.model, 'both participants can run the same model');
        ok(LEFT.tier === 'local' && RIGHT.tier === 'local',
            'tier is resolved from the model id and reported per participant');
    }

    // ── tier is derived from the model id, never asserted by the client ──
    //
    // Note `owns()` in providers/tokenfactory.js: once a Nebius catalogue has been
    // fetched, membership is exact, and an invented namespaced id falls through to the
    // local tier rather than being treated as remote. So this has to use a real remote
    // id when there is one, and skip when there is not.
    const REMOTE = (health.models || []).find(m => m.tier === 'remote')?.name || null;

    if (!REMOTE) {
        skipped('tier is derived from the model id, not from the client');
        skipped('a remote participant is gated before anything is sent');
        skipped('nothing is recorded as having crossed when nothing crossed');
    } else {
        const spoof = await patch(`/api/duet/participants/${LEFT.id}`,
            { model: REMOTE, tier: 'local' });
        ok(spoof.json?.tier === 'remote',
            'tier is derived from the model id, not from the client',
            JSON.stringify(spoof.json));

        // ⚠ Actually sending to the remote tier SPENDS REAL CREDITS, so it is opt-in.
        //
        // The gate runs locally and is free, but if it releases, the crossing that
        // follows is billed. A test suite must not quietly spend the operator's money,
        // and the gate's ruling is a model's judgement rather than a fixed value, so
        // "send something it will surely withhold" is not a guarantee either.
        //
        // Airlock's existing suites skip the remote tier without a key; this one also
        // skips it without consent.
        if (process.env.AIRLOCK_DUET_TEST_REMOTE === '1') {
            const attempt = await send(thread.id, {
                participantId: LEFT.id,
                text: 'Say the single word: crossing.',
                clientRequestId: 'req-remote'
            });

            ok(attempt.events.some(e => e.type === 'gating'),
                'a remote participant is gated before anything is sent');

            const blocked = last(attempt.events, 'blocked');
            const done = last(attempt.events, 'done');
            const exposure = await get(`/api/threads/${thread.id}/exposure`);

            if (blocked) {
                ok(exposure.crossingCount === 0,
                    'nothing is recorded as having crossed when the gate withholds',
                    JSON.stringify(exposure));
                ok(!blocked.message.content, 'a withheld generation produces no answer text');
            } else {
                // It released and crossed. Then the whole assembled context must be on
                // the record — including the OTHER participant's words, which is the
                // exposure this feature introduces and the reason the gate reads the
                // full context rather than only the newest message.
                const crossed = new Set(exposure.packets.map(p => p.packetId));
                ok(exposure.crossingCount > 0, 'a real crossing is recorded');
                ok(sourcesOf(done.message).every(id => crossed.has(id)),
                    'every packet in the context is recorded as having crossed',
                    `context ${JSON.stringify(sourcesOf(done.message))} vs crossed ${JSON.stringify([...crossed])}`);
            }
        } else {
            skipped('a remote participant is gated before anything is sent '
                + '(set AIRLOCK_DUET_TEST_REMOTE=1 — it spends credits)');
            skipped('nothing is recorded as having crossed when nothing crossed '
                + '(same opt-in)');
        }
    }

    // Back onto a tier that can answer without spending anything.
    if (canGenerate) LEFT = (await patch(`/api/duet/participants/${LEFT.id}`, { model: LOCAL })).json;

    // Whatever happened above, an untouched local thread must show no exposure at all.
    ok((await get(`/api/threads/${thread.id}/exposure`)).crossingCount === 0
        || process.env.AIRLOCK_DUET_TEST_REMOTE === '1',
        'a local-only duet records no crossings');

    if (!canGenerate) {
        skipped('a message in the left pane triggers only the left participant');
        skipped('the right participant can reference the left\'s completed answer');
        skipped('each participant distinguishes its own messages from the other\'s');
        skipped('concurrent requests stay correctly associated');
        skipped('cancellation leaves the conversation usable');
    } else {
        // ── 1. a message in the left pane triggers only the left participant ──
        const one = await send(thread.id, {
            participantId: LEFT.id, text: 'Reply with the single word: teal.', clientRequestId: 'req-1'
        });

        const userOne = one.events.find(e => e.type === 'user');
        const doneOne = last(one.events, 'done');

        ok(userOne.message.recipientId === LEFT.id,
            'the request is addressed to the participant it was sent to');
        ok(doneOne?.message.authorId === LEFT.id, 'and only that participant replies');
        ok(doneOne.message.replyTo === userOne.message.id,
            'the reply is tied to the request that triggered it');
        ok(one.events.filter(e => e.type === 'token').every(e => e.messageId === doneOne.message.id),
            'tokens are stamped with the message they belong to');
        ok(doneOne.message.tier === 'local', 'the reply records which side of the boundary made it');

        const state1 = await get(`/api/duet/${thread.id}`);
        ok(state1.messages.filter(m => m.authorId === RIGHT.id || m.recipientId === RIGHT.id).length === 0,
            'nothing was written for the other participant');

        // The pre-duet packet is shared context for both panes.
        ok(sourcesOf(doneOne.message).includes(legacy.id),
            'a pre-duet packet is part of the shared conversation both panes read');

        // ── 2. the right participant can reference the left's completed answer ──
        const two = await send(thread.id, {
            participantId: RIGHT.id, text: 'Reply with the single word: ochre.', clientRequestId: 'req-2'
        });
        const doneTwo = last(two.events, 'done');

        ok(sourcesOf(doneTwo.message).includes(doneOne.message.id),
            'the other participant\'s context is built from the completed answer',
            JSON.stringify(sourcesOf(doneTwo.message)));
        ok(sourcesOf(doneTwo.message).includes(userOne.message.id),
            'and from the request that prompted it');

        // ── 3. each participant distinguishes its own messages ──
        const three = await send(thread.id, {
            participantId: LEFT.id, text: 'Reply with the single word: umber.', clientRequestId: 'req-3'
        });
        const doneThree = last(three.events, 'done');
        ok(sourcesOf(doneThree.message).includes(doneOne.message.id)
            && sourcesOf(doneThree.message).includes(doneTwo.message.id),
            'a later turn sees both its own earlier reply and the other participant\'s');

        // ── 4. concurrency ──
        const [l4, r4] = await Promise.all([
            send(thread.id, { participantId: LEFT.id, text: 'Say: alpha.', clientRequestId: 'req-4L' }),
            send(thread.id, { participantId: RIGHT.id, text: 'Say: beta.', clientRequestId: 'req-4R' })
        ]);
        const doneL = last(l4.events, 'done');
        const doneR = last(r4.events, 'done');

        ok(doneL?.message.authorId === LEFT.id && doneR?.message.authorId === RIGHT.id,
            'concurrent replies are owned by the right participants');
        ok(doneL.message.id !== doneR.message.id, 'and are two distinct messages');
        ok(l4.events.filter(e => e.type === 'token').every(e => e.messageId === doneL.message.id)
            && r4.events.filter(e => e.type === 'token').every(e => e.messageId === doneR.message.id),
            'neither stream carried the other\'s tokens');
        ok(!sourcesOf(doneL.message).includes(doneR.message.id)
            && !sourcesOf(doneR.message).includes(doneL.message.id),
            'neither concurrent reply is in the other\'s snapshot — snapshots are fixed at submit',
            `${JSON.stringify(sourcesOf(doneL.message))} / ${JSON.stringify(sourcesOf(doneR.message))}`);

        const five = await send(thread.id, {
            participantId: RIGHT.id, text: 'Say: gamma.', clientRequestId: 'req-5'
        });
        ok(sourcesOf(last(five.events, 'done').message).includes(doneL.message.id)
            && sourcesOf(last(five.events, 'done').message).includes(doneR.message.id),
            'a later request sees both concurrent answers');

        // ── 5. cancellation ──
        const controller = new AbortController();
        let cancelledId = null;

        await send(thread.id,
            { participantId: LEFT.id, text: 'Count slowly from one to two hundred.', clientRequestId: 'req-6' },
            {
                signal: controller.signal,
                onEvent: e => {
                    if (e.type === 'start') cancelledId = e.message.id;
                    if (e.type === 'token') controller.abort();
                }
            });

        await new Promise(r => setTimeout(r, 500));   // the server settles once the socket drops

        const afterCancel = await get(`/api/duet/${thread.id}`);
        const cancelled = afterCancel.messages.find(m => m.id === cancelledId);
        ok(cancelled?.status === 'cancelled',
            'a stopped reply is recorded as cancelled, not complete', cancelled?.status);

        const afterStop = await send(thread.id, {
            participantId: LEFT.id, text: 'Say: delta.', clientRequestId: 'req-7'
        });
        const doneStop = last(afterStop.events, 'done');
        ok(!sourcesOf(doneStop.message).includes(cancelledId),
            'a cancelled reply is excluded from every later context');
        ok(sourcesOf(doneStop.message).includes(cancelled.replyTo),
            'but the request that triggered it is still part of the conversation');
        ok(doneStop?.message.status === 'complete',
            'and the conversation keeps working afterwards');
    }

    // ── validation ──
    ok(!!(await send(thread.id, { participantId: 999999, text: 'hello' })).error,
        'a request for an unknown participant fails before anything is written');
    ok(!!(await send(thread.id, { participantId: LEFT.id, text: '   ', clientRequestId: 'req-8' })).error,
        'an empty request is refused');

    // ── duplicate submits and retries ──
    const usersBefore = (await get(`/api/duet/${thread.id}`)).messages.filter(m => m.role === 'user').length;

    const dupe = await send(thread.id, {
        participantId: RIGHT.id, text: 'Only once, please.', clientRequestId: 'req-dupe'
    });
    const dupeAgain = await send(thread.id, {
        participantId: RIGHT.id, text: 'Only once, please.', clientRequestId: 'req-dupe'
    });

    const usersAfter = (await get(`/api/duet/${thread.id}`)).messages.filter(m => m.role === 'user').length;
    ok(usersAfter === usersBefore + 1,
        'the same submission sent twice writes one request, not two', `${usersBefore} -> ${usersAfter}`);
    ok(dupe.events.find(e => e.type === 'user').message.id
        === dupeAgain.events.find(e => e.type === 'user').message.id,
        'and the second submission reuses the first request\'s id');
    ok(dupeAgain.events.find(e => e.type === 'user').created === false,
        'the resend is marked as reusing rather than creating');

    const triggerId = dupe.events.find(e => e.type === 'user').message.id;
    await send(thread.id, { participantId: RIGHT.id, retryOf: triggerId });
    const afterRetry = (await get(`/api/duet/${thread.id}`)).messages.filter(m => m.role === 'user').length;
    ok(afterRetry === usersAfter, 'a retry does not duplicate the triggering request',
        `${usersAfter} -> ${afterRetry}`);

    // ── one canonical log, filtered two ways ──
    const finalState = await get(`/api/duet/${thread.id}`);
    const seqs = finalState.messages.map(m => m.seq);
    ok(seqs.every(s => typeof s === 'number'), 'every message carries a server-assigned order');
    ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]),
        'and that order is strictly increasing', seqs.join(','));

    const leftView = finalState.messages.filter(m => m.authorId === LEFT.id || m.recipientId === LEFT.id);
    const rightView = finalState.messages.filter(m => m.authorId === RIGHT.id || m.recipientId === RIGHT.id);
    const shared = finalState.messages.filter(m => m.authorId == null && m.recipientId == null);

    ok(!leftView.some(m => rightView.includes(m)),
        'the two pane views are disjoint apart from the shared pre-duet messages');
    ok(leftView.length + rightView.length + shared.length === finalState.messages.length,
        'and together they account for the whole log');

    // ── the rest of the app still sees these as ordinary packets ──
    const packets = await get(`/api/threads/${thread.id}/packets`);
    const flatCount = (function count(nodes) {
        return nodes.reduce((n, p) => n + 1 + count(p.children || []), 0);
    })(packets);
    ok(flatCount === finalState.messages.length,
        'duet messages are ordinary packets in the classic thread view',
        `${flatCount} vs ${finalState.messages.length}`);

    const brief = await get(`/api/threads/${thread.id}/brief`);
    ok(brief.markdown?.includes('Only once, please.'),
        'the oversight brief still builds over a duet thread');

    ok((await get('/api/search?q=' + encodeURIComponent('Only once, please.'))).length >= 1,
        'duet messages are searchable like any other packet');

    // ── teardown ──
    await del(`/api/folders/${tray.id}`);

    const remaining = await get('/api/tree');
    if (remaining.length && remaining.some((f, i) => f.position !== i)) {
        await post(`/api/folders/${remaining[0].id}/reorder`, { index: 0 });
    }

    const after = await get('/api/stats');
    ok(after.packets === baseStats.packets,
        'deleting the tray cascades every duet packet away',
        `${after.packets} vs baseline ${baseStats.packets}`);
    ok((await get(`/api/duet/${thread.id}`)).error !== undefined,
        'and takes the participants with it');

    console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped\n`);
    if (fail) process.exit(1);
})().catch(async err => {
    console.error('\nduet test crashed:', err.stack || err.message);
    await scrub().catch(() => {});
    process.exit(1);
});
