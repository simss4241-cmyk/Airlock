'use strict';

/**
 * Store smoke test. Server must be running on :8100.
 *   node tools/smoke_test.js
 *
 * Self-contained: creates its own trays and threads, exercises every store operation
 * against those, then deletes them. It never depends on the seeded trays existing —
 * you are free to rename or delete those, and this must still pass.
 *
 * Covers move (drag), fork (alt-drag, keeps a tether), nest (drop onto a packet),
 * reorder, re-tray, rename, review signatures, the oversight brief + handoff, and the
 * .md download endpoint that Chromium's DownloadURL drag points at.
 */

const BASE = process.env.AIRLOCK_URL || 'http://localhost:8100';

const FIXTURE = 'ZZ SMOKE TEST';
const FIXTURE_ALT = 'ZZ SMOKE TEST ALT';

let pass = 0;
const failures = [];

function check(label, cond, detail = '') {
    if (cond) { pass++; console.log(`  ok   ${label}`); }
    else { failures.push(label); console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}

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
const del = r => api('DELETE', r);

const flat = (nodes, out = []) => {
    for (const n of nodes) { out.push(n); if (n.children?.length) flat(n.children, out); }
    return out;
};

/** Remove any fixture left behind by an interrupted run. */
async function scrub() {
    for (const f of await get('/api/tree')) {
        if (f.name === FIXTURE || f.name === FIXTURE_ALT) await del(`/api/folders/${f.id}`);
    }
}

(async () => {
    console.log(`\nAirlock store smoke test -> ${BASE}\n`);

    await scrub();
    const base = await get('/api/stats');
    // Tray reorder renumbers the whole folder list, so remember the user's arrangement
    // and prove at the end that we handed it back exactly as we found it.
    const userTrays = (await get('/api/tree')).map(f => f.id);
    console.log(`  (baseline: ${base.packets} packets, ${base.provenance} provenance rows)\n`);

    // ── fixtures ──
    const tray = (await post('/api/folders', { name: FIXTURE })).json;
    const trayAlt = (await post('/api/folders', { name: FIXTURE_ALT })).json;
    check('creates a tray', !!tray?.id && tray.name === FIXTURE);

    const mk = async title => (await post('/api/threads', { folderId: tray.id, title })).json;
    const HW = await mk('smoke-hardware');
    const CODE = await mk('smoke-code');
    const RUN = await mk('smoke-run');
    check('creates threads inside it', [HW, CODE, RUN].every(t => t?.id));

    const tree0 = await get('/api/tree');
    check('tree nests threads under their tray',
        tree0.find(f => f.id === tray.id).threads.length === 3);

    // ── create ──
    const p = (await post('/api/packets', {
        threadId: HW.id, role: 'user', content: 'Thermal spine: air-capture rate is the gap.'
    })).json;
    check('packet created in its thread', p.thread_id === HW.id);
    check('origin thread recorded', p.origin_thread_id === HW.id);
    check('created event logged',
        (await get(`/api/packets/${p.id}/provenance`)).some(e => e.event === 'created'));

    const missingThread = await post('/api/packets', { role: 'user', content: 'x' });
    check('rejects a packet with no thread', missingThread.status === 400);

    // ── move: the ghost trail ──
    const moved = (await post(`/api/packets/${p.id}/move`, { toThreadId: CODE.id })).json;
    check('packet moves between threads', moved.thread_id === CODE.id);
    check('origin survives the move', moved.origin_thread_id === HW.id);

    const hop = (await get(`/api/packets/${p.id}/provenance`)).find(e => e.event === 'moved');
    check('move logs both endpoints by name',
        hop && hop.from_thread === 'smoke-hardware' && hop.to_thread === 'smoke-code',
        hop ? `${hop.from_thread} -> ${hop.to_thread}` : 'no move event');

    check('appears in the travelled feed',
        (await get('/api/travelled')).some(t => t.id === p.id
            && t.origin_thread === 'smoke-hardware' && t.current_thread === 'smoke-code'));

    // ── fork: mitosis with a tether ──
    const fork = (await post(`/api/packets/${p.id}/fork`, { toThreadId: RUN.id })).json;
    check('fork is a distinct packet', fork.id !== p.id);
    check('fork lands in the target thread', fork.thread_id === RUN.id);
    check('fork keeps a tether to its parent', fork.forked_from === p.id, `forked_from=${fork.forked_from}`);
    check('fork inherits the original origin', fork.origin_thread_id === HW.id);
    check('original survives the fork', (await get(`/api/packets/${p.id}`)).id === p.id);

    // ── nest: a thread is a container ──
    const master = (await post('/api/packets', {
        threadId: RUN.id, role: 'user', content: 'MASTER: Build Plant run'
    })).json;
    const a = (await post('/api/packets', { threadId: HW.id, role: 'user', content: 'sub: bench rig' })).json;
    const b = (await post('/api/packets', { threadId: CODE.id, role: 'user', content: 'sub: telemetry' })).json;

    await post(`/api/packets/${a.id}/move`, { parentId: master.id });
    await post(`/api/packets/${b.id}/move`, { parentId: master.id });

    const runTree = await get(`/api/threads/${RUN.id}/packets`);
    const masterNode = runTree.find(x => x.id === master.id);
    check('master packet is a root', !!masterNode);
    check('master holds two children', masterNode?.children.length === 2, `got ${masterNode?.children.length}`);
    check('nested children are not also roots', !runTree.some(x => x.id === a.id || x.id === b.id));
    check('nesting pulls a packet into the parent thread',
        (await get(`/api/packets/${a.id}`)).thread_id === RUN.id);
    check('nest is logged as its own event',
        (await get(`/api/packets/${a.id}/provenance`)).some(e => e.event === 'nested'));

    // ── moving a parent carries its subtree ──
    const carried = (await post(`/api/packets/${master.id}/move`, { toThreadId: CODE.id })).json;
    check('parent moves', carried.thread_id === CODE.id);
    check('children come along', (await get(`/api/packets/${a.id}`)).thread_id === CODE.id);
    const carryEvent = (await get(`/api/packets/${master.id}/provenance`))
        .filter(e => e.event === 'moved').pop();
    check('move note records the carried count',
        /carried 2 nested/.test(carryEvent?.note || ''), carryEvent?.note || 'no note');

    // ── cycle guards ──
    check('rejects nesting a packet into itself',
        (await post(`/api/packets/${master.id}/move`, { parentId: master.id })).status === 400);
    check('rejects nesting a packet into its own descendant',
        (await post(`/api/packets/${master.id}/move`, { parentId: a.id })).status === 400);

    // ── review signatures ──
    await post(`/api/packets/${p.id}/review`, { actor: 'Spark', note: 'capacity math checks out' });
    await post(`/api/packets/${p.id}/review`, { actor: 'Claude', note: 'flagged air-capture rate' });
    const full = await get(`/api/packets/${p.id}`);
    check('two signatures on the packet', full.reviews.length === 2,
        full.reviews.map(r => r.actor).join(', '));
    check('signatures name their actors',
        full.reviews.some(r => r.actor === 'Claude') && full.reviews.some(r => r.actor === 'Spark'));
    check('rejects a review with no actor',
        (await post(`/api/packets/${p.id}/review`, { note: 'anonymous' })).status === 400);

    // ── search ──
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    const nextYear = `${new Date().getUTCFullYear() + 1}-01-01`;

    check('search by thread finds the fork',
        (await get(`/api/search?thread=${encodeURIComponent('smoke-run')}`)).some(x => x.id === fork.id));
    check('search by tray works',
        (await get(`/api/search?folder=${encodeURIComponent(FIXTURE)}`)).some(x => x.id === p.id));
    check('bare "to" date includes today (end-of-day bound)',
        (await get(`/api/search?thread=smoke-code&from=${today}&to=${today}`)).some(x => x.id === p.id));
    check('date range excludes out-of-window packets',
        !(await get(`/api/search?thread=smoke-code&to=${yesterday}`)).some(x => x.id === p.id));
    check('future window returns nothing',
        (await get(`/api/search?from=${nextYear}`)).length === 0);

    const byText = await get('/api/search?q=air-capture');
    check('content search works', byText.some(x => x.id === p.id));
    check('role filter narrows correctly',
        (await get('/api/search?role=assistant&q=air-capture')).length === 0);
    check('search rows carry tray + thread + origin names', byText[0]?.folder_name
        && byText[0]?.thread_title && byText[0]?.origin_thread_title === 'smoke-hardware');

    // ── oversight handoff ──
    const brief = await get(`/api/threads/${RUN.id}/brief?actor=Claude`);
    check('brief names its thread and tray',
        brief.thread.title === 'smoke-run' && brief.thread.folder === FIXTURE);
    check('brief is markdown with a heading', brief.markdown.startsWith('# Oversight brief'));
    check('brief addresses the named actor', brief.markdown.includes('Asked of Claude'));

    const runNow = flat(await get(`/api/threads/${RUN.id}/packets`));
    check('brief includes the content of every packet it covers',
        runNow.every(x => brief.markdown.includes(x.content.slice(0, 40))),
        `${runNow.length} packet(s)`);
    check('brief packetIds match the thread contents',
        runNow.length === brief.packetIds.length && runNow.every(x => brief.packetIds.includes(x.id)));

    const codeBrief = await get(`/api/threads/${CODE.id}/brief?actor=Spark`);
    check('brief surfaces provenance for travelled packets',
        codeBrief.markdown.includes('was born in **smoke-hardware**'));

    const beforeHandoff = (await get('/api/stats')).packets;
    const handoff = (await post(`/api/threads/${CODE.id}/handoff`, {
        actor: 'Claude', verdict: 'Reasoning holds. Watch the air-capture rate.',
        packetIds: codeBrief.packetIds
    })).json;
    check('handoff lands the verdict as a real packet',
        handoff.packet.role === 'assistant' && handoff.packet.thread_id === CODE.id);
    check('verdict is attributed to the reviewer', handoff.packet.model === 'Claude');
    check('handoff adds exactly one packet', (await get('/api/stats')).packets === beforeHandoff + 1);

    const signed = await get(`/api/threads/${CODE.id}/packets`);
    const stamped = flat(signed).find(x => codeBrief.packetIds.includes(x.id));
    check('reviewed packets carry the signature for the badge',
        (stamped?.reviewers || '').includes('Claude'), stamped?.reviewers || 'none');
    check('verdict packet does not sign itself',
        !(flat(signed).find(x => x.id === handoff.packet.id)?.reviewers || '').includes('Claude'));
    check('rejects a handoff with no verdict',
        (await post(`/api/threads/${CODE.id}/handoff`, { actor: 'Claude' })).status === 400);
    check('rejects a handoff with no actor',
        (await post(`/api/threads/${CODE.id}/handoff`, { verdict: 'looks fine' })).status === 400);
    check('brief on a missing thread errors cleanly', !!(await get('/api/threads/999999/brief')).error);

    // ── the drag-out file ──
    const dl = await fetch(`${BASE}/api/threads/${CODE.id}/brief.md`);
    const body = await dl.text();
    check('brief.md serves markdown',
        (dl.headers.get('content-type') || '').includes('text/markdown'));
    check('brief.md sets a download filename',
        /attachment; filename="airlock-smoke-code\.md"/.test(dl.headers.get('content-disposition') || ''),
        dl.headers.get('content-disposition'));
    check('brief.md body is the brief, not JSON', body.startsWith('# Oversight brief'));
    check('brief.md 400s on a missing thread',
        (await fetch(`${BASE}/api/threads/999999/brief.md`)).status === 400);

    // ── rename / re-tray ──
    const renamed = (await api('PATCH', `/api/threads/${HW.id}`, { title: 'smoke-hardware ✓' })).json;
    check('thread rename sticks', renamed.title === 'smoke-hardware ✓');
    check('rejects a blank thread title',
        (await api('PATCH', `/api/threads/${HW.id}`, { title: '   ' })).status === 400);
    check('rejects an empty patch', (await api('PATCH', `/api/threads/${HW.id}`, {})).status === 400);

    const refiled = (await api('PATCH', `/api/threads/${HW.id}`, { folderId: trayAlt.id })).json;
    check('thread re-trays into another tray', refiled.folder_id === trayAlt.id);
    check('re-tray reports the new tray name', refiled.folder_name === FIXTURE_ALT);
    check('rejects re-tray into a missing tray',
        (await api('PATCH', `/api/threads/${HW.id}`, { folderId: 999999 })).status === 400);

    const trayRenamed = (await api('PATCH', `/api/folders/${trayAlt.id}`, { name: FIXTURE_ALT })).json;
    check('tray rename works', trayRenamed.name === FIXTURE_ALT);
    check('rejects a blank tray name',
        (await api('PATCH', `/api/folders/${trayAlt.id}`, { name: ' ' })).status === 400);

    // ── reorder ──
    const order = async fid => (await get('/api/tree')).find(f => f.id === fid).threads.map(t => t.id);
    const startOrder = await order(tray.id);
    check('tray order starts as created', startOrder.join() === [CODE.id, RUN.id].join(),
        startOrder.join());

    await post(`/api/threads/${RUN.id}/reorder`, { folderId: tray.id, index: 0 });
    check('reorder to index 0 puts it first', (await order(tray.id))[0] === RUN.id);
    check('reorder keeps every sibling', (await order(tray.id)).length === startOrder.length);

    const positions = (await get('/api/tree')).find(f => f.id === tray.id).threads.map(t => t.position);
    check('positions renumber to a clean 0..n', positions.every((v, i) => v === i), positions.join(','));

    await post(`/api/threads/${RUN.id}/reorder`, { folderId: tray.id, index: 9999 });
    check('out-of-range index clamps to last', (await order(tray.id)).at(-1) === RUN.id);

    await post(`/api/threads/${RUN.id}/reorder`, { folderId: tray.id, index: -5 });
    check('negative index clamps to first', (await order(tray.id))[0] === RUN.id);

    await post(`/api/threads/${RUN.id}/reorder`, { folderId: trayAlt.id, index: 0 });
    check('reorder can re-tray and place in one call', (await order(trayAlt.id))[0] === RUN.id);
    check('it left the old tray', !(await order(tray.id)).includes(RUN.id));
    check('reorder 400s on a missing thread',
        (await post('/api/threads/999999/reorder', { index: 0 })).status === 400);
    check('reorder 400s on a missing tray',
        (await post(`/api/threads/${RUN.id}/reorder`, { folderId: 999999, index: 0 })).status === 400);

    // ── tray reorder ──
    const trayOrder = async () => (await get('/api/tree')).map(f => f.id);
    const trayNames = async () => (await get('/api/tree')).map(f => f.name);

    const beforeTrays = await trayOrder();
    check('both fixture trays are in the tree',
        beforeTrays.includes(tray.id) && beforeTrays.includes(trayAlt.id));

    await post(`/api/folders/${trayAlt.id}/reorder`, { index: 0 });
    check('tray reorder to index 0 puts it first', (await trayOrder())[0] === trayAlt.id,
        (await trayNames()).join(' | '));
    check('tray reorder keeps every tray', (await trayOrder()).length === beforeTrays.length);

    const trayPositions = (await get('/api/tree')).map(f => f.position);
    check('tray positions renumber to a clean 0..n',
        trayPositions.every((v, i) => v === i), trayPositions.join(','));

    await post(`/api/folders/${trayAlt.id}/reorder`, { index: 9999 });
    check('tray out-of-range index clamps to last', (await trayOrder()).at(-1) === trayAlt.id);

    await post(`/api/folders/${trayAlt.id}/reorder`, { index: -3 });
    check('tray negative index clamps to first', (await trayOrder())[0] === trayAlt.id);

    check('tray reorder keeps its threads',
        (await get('/api/tree')).find(f => f.id === trayAlt.id).threads.length > 0);
    check('tray reorder 400s on a missing tray',
        (await post('/api/folders/999999/reorder', { index: 0 })).status === 400);

    // ── stats ──
    const s = await get('/api/stats');
    check('stats count forks', s.forks >= 1, `forks=${s.forks}`);
    check('stats count nesting', s.nested >= 2, `nested=${s.nested}`);
    check('stats count reviews', s.reviews >= 2, `reviews=${s.reviews}`);

    // ── teardown ──
    await del(`/api/folders/${tray.id}`);
    await del(`/api/folders/${trayAlt.id}`);

    // Removing the fixtures leaves gaps in the folder positions. Renumber in place by
    // pinning the first remaining tray to slot 0 — order is already correct, this just
    // closes the holes so the user's trays end up 0..n like they started.
    const remaining = await get('/api/tree');
    if (remaining.length && remaining.some((f, i) => f.position !== i)) {
        await post(`/api/folders/${remaining[0].id}/reorder`, { index: 0 });
    }

    const finalTrays = await get('/api/tree');
    check('the user\'s tray order is handed back untouched',
        finalTrays.map(f => f.id).join() === userTrays.join(),
        `${finalTrays.map(f => f.id).join()} vs ${userTrays.join()}`);
    check('tray positions left clean, no gaps',
        finalTrays.every((f, i) => f.position === i),
        finalTrays.map(f => f.position).join(','));

    const after = await get('/api/stats');
    check('deleting a tray cascades its threads and packets',
        after.packets === base.packets, `${after.packets} vs baseline ${base.packets}`);
    check('provenance cascades too',
        after.provenance === base.provenance, `${after.provenance} vs baseline ${base.provenance}`);
    check('fixtures left no trays behind',
        !(await get('/api/tree')).some(f => f.name === FIXTURE || f.name === FIXTURE_ALT));

    console.log(`\n${pass} passed, ${failures.length} failed\n`);
    if (failures.length) {
        failures.forEach(f => console.log(`  - ${f}`));
        process.exit(1);
    }
})().catch(async err => {
    console.error('\nsmoke test crashed:', err.message);
    await scrub().catch(() => {});
    process.exit(1);
});
