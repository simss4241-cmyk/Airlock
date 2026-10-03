'use strict';

/**
 * Duet — two labelled panes over ONE conversation.
 *
 * The thing to hold on to while reading this: there is no such thing as "the left pane's
 * history". There is `state.messages`, which is the whole shared conversation as the
 * server ordered it, and each pane is a filter over it. Nothing here merges two logs,
 * because nothing here ever splits one.
 *
 * Rendering is per-pane on purpose. A single repaint of both columns on every token would
 * blow away a half-typed message in the other composer and fight its scroll position — so
 * a token only ever redraws the list it belongs to, addressed by the message id the server
 * stamps on every event.
 *
 * ⚠ The pane header says which side of the boundary each participant is on, and it is not
 * decoration. Sending to a remote participant sends it the shared conversation — the other
 * participant's words included — so the pane warns before the first crossing and the local
 * gate rules before anything leaves. A refusal is rendered in place, not swallowed.
 *
 * Loaded after app.js and leans on it for the markdown renderer, the toast and the tray
 * rail. This is THE view of a thread: the single-pane chat it grew up beside is gone, and
 * talking to one model is focus mode (⤢), inside the same conversation and chamber. The
 * fetch wrapper in app.js attaches the access token to every /api call made here, so a
 * hosted instance needs nothing extra.
 */

const duetEl = {
    root: $('duet'),
    grid: $('duetGrid'),
    tabs: $('duetTabs'),
    rail: $('airlockRail'),
    railHead: $('airlockHead'),
    railLog: $('airlockLog'),
    railSub: $('airlockSub'),
    railToggle: $('airlockToggle'),
};

const state = {
    threadId: null,
    enabled: false,
    active: false,          // is the duet view the one on screen
    participants: [],
    messages: [],
    userName: 'User',
    models: [],             // from /api/health, carrying tier
    mobileSlot: 'a',
    focus: null             // 'a' | 'b' — that side wide, the other folded; null = both
};

/** Per-pane live wiring. Never conversation data — that lives in state.messages. */
const panes = new Map();    // participantId -> { nodes, controller, status, error, gate, frame }


// ─────────────────────────── who is who ───────────────────────────
//
// (The panes used to filter the conversation — what was said to or by each side — and in
// chatter, where every reply is addressed to the other side, both became copies. The
// conversation is now one timeline in two lanes; see laneOf() below.)

const participant = id => state.participants.find(p => p.id === id) || null;

/**
 * Who produced a message, for display.
 *
 * For anything a model wrote, that is THE MODEL — not the side it sat on and not a
 * persona. `packets.model` records the model that actually generated the text, so it is
 * true provenance and it stays true after a participant is repointed at something else.
 *
 * ⚠ This used to fall back to 'earlier assistant' for any packet with no participant,
 * which threw away information we already had: a pre-duet packet still records its model.
 * The classic view has always shown it (see speaker() in app.js); only this path hid it.
 */
const nameOf = message => {
    if (message.kind === 'user') return state.userName;
    return message.model || message.authorName || 'assistant';
};

/** Where a message was addressed. Sides are stable; a participant's model can change. */
const addresseeOf = message =>
    message.recipientName || (message.kind === 'user' ? 'both sides' : state.userName);

// A model the list does not mention is 'unknown', not 'local': the chip is the claim.
const tierOfModel = name => state.models.find(m => m.name === name)?.tier || 'unknown';

// crossedTier() lives in app.js, shared with the classic view.

/**
 * Did this message actually come from across the boundary — not "was it headed there"?
 *
 * ⚠ The duet view used to answer this with crossedTier(message.tier) alone, and tier is
 * where a reply was BOUND, fixed when it is created and before the gate has ruled. So a
 * turn the local gate withheld — nothing sent, nothing recorded as crossed in the audit
 * log — wore the "↗ crossed" badge, an amber row, and a place in the chamber's crossed
 * count. The screen claimed a crossing the record correctly said never happened.
 *
 * The server knows the answer and says so: duet-runner.js sets requestMeta.crossed on a
 * reply only once the first chunk comes back from the far side, which is the moment the
 * content is provably across — the same moment it writes the `crossed` provenance event
 * that /api/exposure reads. This mirrors that rule, and nothing weaker:
 *
 *   requestMeta.crossed           the server recorded it
 *   streaming, with any output    a chunk came back from a remote model; not settled yet,
 *                                 so the flag is not written yet, but it is across
 *   complete                      a finished remote reply was produced over there; covers
 *                                 packets written before the flag existed
 *
 * Withheld, refused at the spend cap, or stopped while still queued: never crossed.
 */
const didCross = message =>
    crossedTier(message.tier) && message.role !== 'user' && (
        message.requestMeta?.crossed === true
        || (message.streaming && Boolean(message.content || message.thinking))
        || message.status === 'complete'
    );

/** Bound for the far side but has not crossed: at the gate, withheld, or refused. */
const heldBack = message => crossedTier(message.tier) && message.role !== 'user' && !didCross(message);

// ─────────────────────────── message state ───────────────────────────

/** Merge a server message into the shared log, keeping server order. */
function upsert(message) {
    const at = state.messages.findIndex(m => m.id === message.id);
    if (at === -1) {
        state.messages.push(message);
        state.messages.sort((x, y) => (x.seq - y.seq) || (x.id - y.id));
    } else {
        state.messages[at] = { ...state.messages[at], ...message };
    }
    return state.messages.find(m => m.id === message.id);
}

const messageById = id => state.messages.find(m => m.id === id);

/**
 * Scanner findings per message, remembered by content. A pane repaints every frame while a
 * reply streams, and re-running every pattern over every message each frame is waste —
 * but a message's content only changes while it streams, so id + length is a sound key.
 */
/**
 * The earlier reply of the SAME side that this one repeats, or null — by the rule in
 * public/echo.js. Only a side repeating itself counts: echoing the other side is agreement.
 * Looks back over that side's last six finished replies. Cached like the credential scan:
 * earlier replies do not change once finished, and this one only while it streams.
 */
const echoCache = new Map();
function repeatOf(message) {
    if (message.role === 'user' || !message.authorId || message.streaming || !message.content || !window.AirlockEcho) return null;
    const key = `${message.id}:${message.content.length}`;
    if (echoCache.has(key)) return echoCache.get(key);
    const at = state.messages.findIndex(m => m.id === message.id);
    const earlier = state.messages.slice(0, at === -1 ? state.messages.length : at)
        .filter(m => m.authorId === message.authorId && m.status === 'complete' && (m.content || '').trim())
        .slice(-6);
    const i = window.AirlockEcho.repeats(message.content, earlier.map(m => m.content));
    const hit = i === -1 ? null : earlier[i];
    echoCache.set(key, hit);
    return hit;
}

/**
 * The files a reply names that nobody in this thread has seen — by the rule in
 * public/evidence.js. Seen means: a tool read it (either side; its words may be quoted
 * across), or the user wrote or attached it, at or before this message. A name another
 * reply made up does not count as seen, so an invented file stays marked when the other
 * side repeats it. A listing is not a read: a file only listed was not seen.
 */
const unseenCache = new Map();
function unseenFiles(message) {
    if (message.role === 'user' || message.streaming || !message.content || !window.AirlockEvidence) return [];
    const at = state.messages.findIndex(m => m.id === message.id);
    const upTo = state.messages.slice(0, at === -1 ? state.messages.length : at + 1);
    const key = `${message.id}:${message.content.length}:${upTo.length}`;
    if (unseenCache.has(key)) return unseenCache.get(key);
    const seen = [];
    for (const m of upTo) {
        if (m.role === 'user') seen.push(...window.AirlockEvidence.pathsIn(m.content));
        for (const t of m.requestMeta?.tools || []) {
            if ((t.tool || t.name) === 'read_file' && t.ok && t.target) seen.push(t.target);
            for (const s of t.seen || []) seen.push(s.path);
        }
    }
    const names = window.AirlockEvidence.unseen(message.content, seen);
    unseenCache.set(key, names);
    return names;
}

const credentialCache = new Map();
function credentialsCached(message) {
    const key = `${message.id}:${(message.content || '').length}`;
    if (!credentialCache.has(key)) credentialCache.set(key, credentialsIn(message.content));
    return credentialCache.get(key);
}

// ─────────────────────────── rendering ───────────────────────────

const STATUS_NOTE = {
    cancelled: 'stopped',
    failed: 'failed',
    interrupted: 'interrupted by a restart',
    blocked: 'blocked by the gate'
};

function messageHtml(message, { showAddressing = false } = {}) {
    const mine = message.role === 'user';
    const who = escapeHtml(nameOf(message));

    // In the shared log the addressing is the whole point, so it is spelled out. In a pane
    // it would be noise — everything there is already to or from that participant.
    const addressed = showAddressing && message.recipientName
        ? ` <span class="duet-arrow">→</span> ${escapeHtml(message.recipientName)}`
        : '';

    // A reply that came from across the boundary says so on every render, not just once.
    // Only one that DID — see didCross().
    const crossed = didCross(message)
        ? ' <span class="badge travel">↗ crossed</span>' : '';

    // Nearly the same as an earlier reply from this side: where a loop started is visible.
    const echoed = mine ? null : repeatOf(message);
    const echoMark = echoed
        ? ` <span class="badge repeat" title="Nearly word for word an earlier reply from this side (#${echoed.id})">↻ repeat of #${echoed.id}</span>`
        : '';

    // Names a file nobody here has read or given: evidence that may not exist.
    const unseenNames = mine ? [] : unseenFiles(message);
    const unseenMark = unseenNames.length
        ? ` <span class="badge unseen" title="${escapeHtml(`Named here, but no tool read ${unseenNames.length === 1 ? 'it' : 'them'} and you did not give ${unseenNames.length === 1 ? 'it' : 'them'} in this thread: ${unseenNames.join(', ')}`)}">⚠ unseen file${unseenNames.length === 1 ? '' : ` ×${unseenNames.length}`}</span>`
        : '';

    // Holding a known credential: said on the message, before anyone reaches for the drag.
    const secret = message.streaming ? [] : credentialsCached(message);
    const kept = secret.length
        ? ` <span class="badge secret" title="${escapeHtml(`Contains ${[...new Set(secret.map(h => h.label))].join(', ')}. `
            + 'It will not leave by drag or copy; the gate withholds it from any crossing.')}">⚠ credential</span>`
        : '';

    const think = message.thinking
        ? `<details class="think"${message.streaming && !message.content ? ' open' : ''}>
               <summary>reasoning</summary>
               <div class="think-body">${escapeHtml(message.thinking)}</div>
           </details>`
        : '';

    const note = STATUS_NOTE[message.status]
        ? `<span class="duet-status-note">${escapeHtml(STATUS_NOTE[message.status])}</span>`
        : '';

    // A blocked generation has no text, so the gate's reason IS the message.
    const gate = message.status === 'blocked' && message.requestMeta?.gate
        ? gateHtml(message.requestMeta.gate, message.requestMeta.withheld)
        : '';

    // A failure with nothing written says why, from the record — an empty red box reads as
    // a rendering bug, and the reason (a provider refusal, a model that would not load) is
    // usually the thing to act on.
    const why = message.status === 'failed' && message.requestMeta?.error
        ? `<p class="stats">Failed: ${escapeHtml(String(message.requestMeta.error).slice(0, 240))}</p>`
        : '';
    // Finished with nothing to say — a model can stop after its reasoning. Said, so an empty
    // box is not mistaken for a rendering fault, and so it is clear why chatter stopped.
    const silent = !mine && message.status === 'complete' && !message.streaming && !message.content
        ? `<p class="stats">Finished without an answer${message.thinking || message.requestMeta?.thinkingChars
            ? ' — it reasoned, then said nothing' : ''}.</p>` : '';
    const empty = message.streaming ? '<p class="stats">thinking…</p>' : (why || silent);
    const thumbs = message.images?.length
        ? `<div class="thumbs">${message.images.map(src =>
              `<img src="${escapeHtml(src)}" alt="attached image">`).join('')}</div>`
        : '';
    // What the model touched on disk, one card per call — live from 'tool' events, and
    // from the stored trace once the reply has settled.
    const calls = (message.tools || message.requestMeta?.tools || [])
        .filter(t => (t.name || t.tool) !== 'request_result');
    const toolCards = calls.length
        ? `<div class="tools">${calls.map(t => `
               <div class="tool${t.ok ? '' : ' bad'}${t.crossed ? ' web-out' : ''}">
                   <span class="tool-name">${escapeHtml(t.name || t.tool || 'tool')}</span>
                   <span class="tool-sum">${escapeHtml(t.summary || t.label || '')}</span>
               </div>`).join('')}</div>`
        : '';

    // What this reply asked the user for (request_result): a card, answered or waiting. Live
    // from 'tool' events while it streams, from the stored record once it has settled.
    const requests = message.requestMeta?.requests
        || (message.tools || []).filter(t => t.name === 'request_result' && t.ok).map(t => ({ text: t.summary }));
    const answeredBy = requests.length ? state.messages.find(m => m.requestMeta?.answers?.id === message.id) : null;
    const askCard = requests.length && !mine
        ? `<div class="ask">${requests.map(r => `<div class="ask-text"><span class="ask-label">asked you</span>${escapeHtml(r.text)}</div>`).join('')}
               ${answeredBy ? '<div class="ask-done">answered</div>'
                 : message.status === 'complete' && !message.streaming
                   ? `<button type="button" class="ask-answer" data-answer="${message.id}">Answer</button>` : ''}</div>`
        : '';
    // An answer says what it answers, so the thread reads without following the line.
    const answering = mine && message.requestMeta?.answers;
    const answerQuote = answering
        ? `<div class="ask-quote">re ${escapeHtml(answering.by)}: ${escapeHtml(answering.request)}</div>` : '';

    // A blocked reply can have text now (a turn stopped mid-way at a file result), so the
    // gate's ruling is shown under whatever was said, not only in place of it.
    const body = mine
        ? answerQuote + thumbs + (message.content ? renderProse(message.content) : '')
        : toolCards + (message.content ? renderMarkdown(message.content) : '') + askCard
          + (message.status === 'blocked' ? gate : (message.content || askCard ? '' : empty));

    const classes = ['msg', mine ? 'user' : 'assistant'];
    // Same tier marking the classic view uses, so a reply produced across the boundary
    // reads amber in a pane as well as in the chamber.
    if (!mine && didCross(message)) classes.push('remote');
    else if (!mine && heldBack(message)) classes.push('held');
    if (message.status === 'failed') classes.push('duet-failed');
    if (message.status === 'blocked') classes.push('duet-blocked');
    if (message.status === 'cancelled' || message.status === 'interrupted') classes.push('duet-stopped');

    // A duet message IS a packet (see appendMessage in duet-store.js), so it can leave the
    // machine on its own the way a classic packet always could. Only a finished one: a
    // half-streamed answer exported with a provenance header would be a quotation of
    // something the model had not yet finished saying.
    const portable = message.id && !message.streaming;
    const handoff = portable
        ? `<span class="grip" aria-hidden="true">⠿ drag</span>`
          + `<button class="prov-copy" type="button"`
          + ` title="Copy this with its provenance — works where a drag doesn't">⧉ copy</button>`
        : '';

    return `<div class="${classes.join(' ')}" data-message="${message.id}">
                <span class="who"${portable ? ' draggable="true"' : ''}>${who}${addressed}${
                    message.id ? `<span class="msg-id"> · #${message.id}</span>` : ''}${crossed}${echoMark}${unseenMark}${kept}${note}${handoff}</span>
                <div class="bubble${message.streaming && message.content ? ' caret' : ''}">${
                    think}${body}</div>
                ${message.stats ? `<span class="stats">${escapeHtml(message.stats)}</span>` : ''}
            </div>`;
}

/** The local gate's ruling, rendered where the answer would have been. */
function gateHtml(gate, withheld = null) {
    const concerns = gate.concerns?.length
        ? `<ul>${gate.concerns.map(c => `<li>${escapeHtml(String(c))}</li>`).join('')}</ul>`
        : '';

    // Mid-turn: the request had already crossed (it is on the record); the file results the
    // model then asked for did not. Saying "nothing was sent" here would be false.
    if (withheld?.length) {
        return `<div class="duet-gate">
                    <b>The local gate withheld the files this model asked for.</b>
                    <p>${escapeHtml(gate.reason || 'No reason given.')}</p>
                    ${concerns}
                    <p class="stats">Kept on this machine: ${escapeHtml(withheld.join('; '))}. The request
                    itself had already crossed; these results did not.${
                        gate.model || gate.ruledBy ? ` Ruled by ${escapeHtml(gate.model || gate.ruledBy)}.` : ''}</p>
                </div>`;
    }

    return `<div class="duet-gate">
                <b>The local gate withheld this.</b>
                <p>${escapeHtml(gate.reason || 'No reason given.')}</p>
                ${concerns}
                <p class="stats">Nothing was sent.${
                    gate.model || gate.ruledBy
                        ? ` Ruled by ${escapeHtml(gate.model || gate.ruledBy)}.` : ''}</p>
            </div>`;
}

/** Was the reader already at the bottom? If so keep them there; if not, leave them be. */
const pinned = node => node.scrollHeight - node.scrollTop - node.clientHeight < 80;

// ─────────────────────────── the timeline: one conversation, two lanes ───────────────────────────
//
// Each message appears ONCE, in the lane it belongs to, in server order: a reply in its
// author's lane, a request in the lane of the side it was sent to, and anything from before
// the thread had two sides across both. Lines run from each message to the one it answers —
// read from what the store recorded (a chatter turn's relayOf, an answer's replyTo), never
// guessed from position — so a chatter run zig-zags between the lanes, and an interjection
// shows exactly where it came in.
//
// This replaced two panes that each showed everything said to or by their side. In chatter
// every reply is addressed to the other side, so the two panes became copies of each other.

/** Which lane a message lives in: 'a', 'b', or 'both' for shared, pre-duet history. */
function laneOf(message) {
    const slotOf = id => participant(id)?.slot || null;
    if (message.role === 'user') return slotOf(message.recipientId) || 'both';
    return slotOf(message.authorId) || 'both';
}

/** The message this one answers, as recorded — or null. */
const parentOf = message => message.requestMeta?.relayOf || message.replyTo || null;

let timelineFrame = null;

/** Coalesced to one paint per frame: tokens arrive faster than a markdown tree lays out. */
function schedulePaint(participantId) {
    if (participantId != null) paintPaneStatus(participantId);
    if (timelineFrame) return;
    timelineFrame = requestAnimationFrame(() => {
        timelineFrame = null;
        paintTimeline();
        paintAirlock();                       // the chamber is always on screen
    });
}

/** Kept for the callers that paint after a turn settles: the timeline, and that side's status. */
function paintPane(participantId) {
    paintTimeline();
    paintPaneStatus(participantId);
}

function paintTimeline() {
    const scroller = duetEl.timeline;
    if (!scroller) return;
    const grid = scroller.querySelector('.tl-grid');
    const wasPinned = pinned(scroller);

    const folded = state.focus ? (state.focus === 'a' ? 'b' : 'a') : null;
    // Each message gets a row of its own. Left to auto-placement, a right-lane message
    // that follows a left-lane one lands BESIDE it, on the same row, and the order breaks.
    const items = state.messages.map((m, i) => {
        const lane = laneOf(m);
        const row = `grid-row: ${i + 1}`;
        // The folded side's lane is a narrow track: each of its messages is a dot, so the
        // back-and-forth still reads while the other side is being read in full.
        if (folded && lane === folded) {
            const gist = (m.content || '').replace(/\s+/g, ' ').trim().slice(0, 120);
            return `<div class="tl-item tl-dot ${didCross(m) ? 'crossed' : ''}" data-lane="${lane}" data-id="${m.id}" style="${row}"
                         title="${escapeHtml(`${nameOf(m)}${gist ? `: ${gist}` : ''}`)}"></div>`;
        }
        return `<div class="tl-item" data-lane="${lane}" data-id="${m.id}" style="${row}">${messageHtml(m, { showAddressing: true })}</div>`;
    });

    grid.innerHTML = (items.length ? items.join('') : `<div class="tl-item tl-empty" data-lane="both">
            <div class="empty duet-empty">
                <h2>Nothing said yet</h2>
                <p>Ask either side something below. Both read the whole conversation; each answers
                   in its own lane — and with ⇄ Step or ▶ Auto, they answer each other.</p>
            </div></div>`) + '<svg class="tl-wires" aria-hidden="true"></svg>';

    grid.querySelectorAll('.tl-dot').forEach(dot => { dot.onclick = () => setFocus(null); });
    wireCopyButtons(grid);
    wireHandoff(grid);
    grid.querySelectorAll('.ask-answer').forEach(b => { b.onclick = () => startAnswer(Number(b.dataset.answer)); });
    if (wasPinned) scroller.scrollTop = scroller.scrollHeight;
    drawWires();
}

/**
 * The lines. Drawn after layout, from each message's box to the box of the message it
 * answers: across the gutter when the lanes differ, and out to the gutter and back when the
 * same side answers twice in a row, so a line never runs through a message between them.
 * Coloured by the answering message: amber if it crossed, red if it was withheld, green if
 * it stayed here.
 */
function drawWires() {
    const grid = duetEl.timeline?.querySelector('.tl-grid');
    const svg = grid?.querySelector('.tl-wires');
    if (!svg) return;

    const box = grid.getBoundingClientRect();
    const byId = new Map([...grid.querySelectorAll('.tl-item[data-id]')].map(n => [Number(n.dataset.id), n]));
    // The gutter's centre, from the columns the grid actually resolved to (lane, gutter, lane).
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').map(parseFloat);
    const gx = cols.length === 3 ? cols[0] + cols[1] / 2 : box.width / 2;

    svg.setAttribute('width', grid.scrollWidth);
    svg.setAttribute('height', grid.scrollHeight);
    let paths = '';

    for (const m of state.messages) {
        const parentId = parentOf(m);
        const to = byId.get(m.id), from = parentId && byId.get(parentId);
        if (!to || !from) continue;

        const a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
        const px = a.left - box.left + a.width / 2, py = a.bottom - box.top;
        const cx = b.left - box.left + b.width / 2, cy = b.top - box.top;
        const kind = m.status === 'blocked' ? 'withheld' : didCross(m) ? 'crossed' : 'local';

        // Same lane: straight down, unless another message of that lane sits between the
        // two — then out to the gutter and back, so the line never runs through it.
        const sameLane = from.dataset.lane === to.dataset.lane && from.dataset.lane !== 'both';
        const blocked = sameLane && [...byId.values()].some(n => n !== from && n !== to
            && n.dataset.lane === from.dataset.lane
            && n.getBoundingClientRect().top > a.bottom && n.getBoundingClientRect().bottom < b.top);
        const d = sameLane && blocked
            ? `M${px},${py} C${px},${py + 14} ${gx},${py + 6} ${gx},${py + 22} L${gx},${cy - 22} C${gx},${cy - 6} ${cx},${cy - 14} ${cx},${cy}`
            : sameLane
                ? `M${px},${py} L${cx},${cy}`
                : `M${px},${py} C${px},${(py + cy) / 2} ${cx},${(py + cy) / 2} ${cx},${cy}`;
        paths += `<path class="wire ${kind}" d="${d}"/><circle class="wire-end ${kind}" cx="${cx}" cy="${cy}" r="2.6"/>`;
    }
    svg.innerHTML = paths;
}

/** Built once per thread: the scroller, its lane grid, and a probe that marks the gutter. */
function buildTimeline() {
    const node = document.createElement('div');
    node.className = 'duet-timeline';
    node.innerHTML = '<div class="tl-grid"></div>';
    duetEl.timeline = node;
    new ResizeObserver(() => drawWires()).observe(node);
    // An image that loads after the paint moves everything under it.
    node.addEventListener('load', () => drawWires(), true);
    return node;
}

/**
 * The airlock: the shared conversation, always on screen.
 *
 * One row per message, columns aligned down the chamber so it reads as a log rather than
 * as a third column of chat bubbles — the panes above are where you read; this is where
 * you see the shape of the whole thing at once, and which parts of it left the machine.
 *
 * Rows are compact and single-line on purpose. The chamber is for "who said what to whom,
 * and did it cross"; the full text lives in the pane it belongs to.
 */
function paintAirlock() {
    if (!duetEl.rail) return;

    const messages = state.messages;
    const crossed = messages.filter(didCross).length;
    const fresh = noteArrivals(messages);

    duetEl.railSub.textContent = messages.length
        ? `one conversation · ${messages.length} message${messages.length === 1 ? '' : 's'}`
          + ` · ${crossed} crossed`
        : 'one conversation · nothing said yet';

    if (duetEl.rail.classList.contains('collapsed')) return;

    const atBottom = pinned(duetEl.railLog);

    duetEl.railLog.innerHTML = messages.length
        ? messages.map(airRow).join('')
        : `<div class="air-empty">Both participants read this chamber. Anything either one
               is told, or says, lands here — the separate composers are not private.</div>`;

    if (atBottom) duetEl.railLog.scrollTop = duetEl.railLog.scrollHeight;
    if (fresh.length) cycleDoors(fresh[fresh.length - 1]);
}

// ─────────────────────────── the doors ───────────────────────────

/**
 * Which rows are new since the chamber last looked.
 *
 * The log is rebuilt from innerHTML on every token, so "this row is entering" cannot live on
 * the DOM node — the node is gone a frame later. It lives here instead, as the time each id
 * was first seen, and airRow() replays the entrance from the right point in it with a
 * negative animation-delay. A thread that is merely OPENED is seeded silently: its history
 * was already in the chamber, and a wall of rows cycling in at once would say otherwise.
 */
const arrivals = {
    thread: null,
    seen: new Set(),
    born: new Map(),        // id -> when the row entered (or re-entered, see releaseDoors)
    stamped: new Map()      // id -> when its seal was pressed; seeded rows are pressed at 0
};
const ENTRY_MS = 2400;      // matches the longest .air-row.entering animation
const CYCLE_MS = 1250;      // matches the door keyframes
const STAMP_MS = 900;       // matches the .stamp keyframes
const STAMP_AFTER_MS = 1000; // an entering row is stamped once it has slid into place

function noteArrivals(messages) {
    const now = performance.now();

    if (arrivals.thread !== state.threadId) {
        arrivals.thread = state.threadId;
        arrivals.seen = new Set(messages.map(m => m.id).filter(Boolean));
        arrivals.born.clear();
        // History arrives already sealed. Only a verdict reached while you watch is pressed.
        arrivals.stamped = new Map(messages.filter(m => m.id).map(m => [m.id, 0]));
        return [];
    }

    for (const [id, at] of arrivals.born) if (now - at > ENTRY_MS) arrivals.born.delete(id);

    const fresh = [];
    for (const m of messages) {
        if (!m.id || arrivals.seen.has(m.id)) continue;
        arrivals.seen.add(m.id);
        arrivals.born.set(m.id, now);
        fresh.push(m);
    }
    return fresh;
}

// reducedMotion() lives in app.js, shared with the packet animations.

/**
 * The doors have three motions:
 *
 *   cycling    a message entered — shut, turn the seal, open           (CYCLE_MS)
 *   holding    a turn is at the gate — shut and STAY shut, seal turning, until it rules
 *   releasing  the gate ruled — show the verdict on the seal, then open (RELEASE_MS)
 *
 * The hold is the honest one. The local gate can take several seconds on a reasoning model,
 * and during that time nothing has crossed and nothing may — which is exactly a sealed
 * airlock. So the chamber shows it sealed, rather than a spinner somewhere saying "wait".
 */
const doors = {
    holds: new Map(),       // participantId -> the reply id waiting at the gate
    heldAt: 0,
    cycleAt: 0,
    timer: null
};
const HOLD_MIN_MS = 900;    // a gate that answers instantly still reads as a ruling
const RELEASE_MS = 900;     // matches the release keyframes
const OPEN_AT_MS = 360;     // when, in the release, the doors start to part
const ROW_SHOWS_MS = 700;   // when, in .air-row.entering, the row becomes visible (56%)

const setSeal = (kind, verdict, route) => {
    duetEl.rail.dataset.cycle = kind;
    $('doorState').textContent = verdict;
    if (route != null) $('doorRoute').textContent = route;
};

const doorsBusy = () => duetEl.rail.matches('.cycling, .holding, .releasing');

/** Close the doors, cycle, open them on the row that just arrived. */
function cycleDoors(message) {
    const rail = duetEl.rail;
    if (reducedMotion() || doorsBusy()) return;

    // Normally a turn bound outward is shown by the hold, not a cycle; this covers one that
    // arrives when the doors are free, without claiming a crossing that has not happened.
    const remote = didCross(message);
    setSeal(remote ? 'crossed' : 'local',
        remote ? '↗ crossing' : heldBack(message) ? 'sealed · at the gate' : 'sealed · local',
        `${nameOf(message)} → ${addresseeOf(message)}`);

    doors.cycleAt = performance.now();
    rail.classList.add('cycling');
    clearTimeout(doors.timer);
    doors.timer = setTimeout(() => rail.classList.remove('cycling'), CYCLE_MS);
}

/** A turn has reached the gate. Shut the doors and keep them shut until it rules. */
function holdDoors(participantId, reply) {
    const rail = duetEl.rail;
    doors.holds.set(participantId, reply?.id ?? null);
    if (reducedMotion()) return;

    setSeal('gating', 'gate ruling…',
        reply ? `${nameOf(reply)} is waiting at the boundary` : 'waiting at the boundary');

    if (rail.classList.contains('holding')) return;

    // If a cycle is already closing the doors, pick the shut up from where it has got to
    // instead of snapping them open to start again. Both close in about the same time.
    const into = rail.classList.contains('cycling')
        ? Math.min(performance.now() - doors.cycleAt, 280) : 0;
    rail.style.setProperty('--hold-into', `-${Math.round(into)}ms`);

    clearTimeout(doors.timer);
    rail.classList.remove('cycling', 'releasing');
    rail.classList.add('holding');
    doors.heldAt = performance.now();
}

const VERDICT = {
    cleared:  ['crossed',  '↗ cleared · crossing', 'the local gate released it'],
    withheld: ['withheld', 'withheld · nothing sent', 'nothing left this machine'],
    failed:   ['withheld', 'refused · nothing sent', 'nothing left this machine'],
    stopped:  ['stopped',  'stopped', 'you stopped it at the gate']
};

/** The gate ruled (or the turn ended). Show the verdict on the seal, then open. */
function releaseDoors(participantId, outcome) {
    if (!doors.holds.has(participantId)) return;
    const replyId = doors.holds.get(participantId);
    doors.holds.delete(participantId);

    // The other participant is still at the gate: the chamber stays sealed for them.
    if (doors.holds.size || reducedMotion()) return;

    const rail = duetEl.rail;
    const wait = Math.max(0, HOLD_MIN_MS - (performance.now() - doors.heldAt));

    clearTimeout(doors.timer);
    doors.timer = setTimeout(() => {
        const [kind, verdict, route] = VERDICT[outcome] || VERDICT.stopped;
        setSeal(kind, verdict, route);
        rail.classList.remove('holding');
        rail.classList.add('releasing');

        // The reply's row has been in the log behind shut doors since the gate began. Enter
        // it again so it slides in as they part — and is stamped once it has.
        if (replyId) {
            arrivals.born.set(replyId, performance.now() - (ROW_SHOWS_MS - OPEN_AT_MS));
            arrivals.stamped.delete(replyId);
            paintAirlock();
        }

        doors.timer = setTimeout(() => rail.classList.remove('releasing'), RELEASE_MS);
    }, wait);
}

/** Thread switched: nothing is waiting at this chamber's gate any more. */
function resetDoors() {
    doors.holds.clear();
    clearTimeout(doors.timer);
    duetEl.rail?.classList.remove('cycling', 'holding', 'releasing');
}

/**
 * The seal a row is stamped with once its fate is settled: amber for a reply that crossed,
 * red for one the gate withheld. Pressed on the row, with a thud, the first time it is
 * rendered settled — after the row has slid in, if it is still entering.
 */
const SEAL_SVG = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none"
        stroke-width="3.4" stroke-linecap="butt" aria-hidden="true">
        <path d="M11.3 4.03 A 8 8 0 0 0 11.3 19.97" stroke="currentColor" opacity=".55"/>
        <path d="M12.7 4.03 A 8 8 0 0 1 12.7 19.97" stroke="currentColor"/>
        <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/></svg>`;

function stampHtml(message, kind) {
    const now = performance.now();
    if (!arrivals.stamped.has(message.id)) {
        const born = arrivals.born.get(message.id);
        arrivals.stamped.set(message.id, born == null ? now : Math.max(now, born + STAMP_AFTER_MS));
    }
    const age = now - arrivals.stamped.get(message.id);
    const live = age < STAMP_MS && !reducedMotion();
    return `<span class="stamp ${kind}${live ? ' pressing' : ''}"${
        live ? ` style="--stamp-delay:${Math.round(-age)}ms"` : ''}>${SEAL_SVG}</span>`;
}

const AIR_TAG = {
    cancelled: 'stopped',
    failed: 'failed',
    blocked: 'withheld',
    interrupted: 'interrupted',
    streaming: '…'
};

function airRow(message) {
    const remote = didCross(message);
    const classes = ['air-row', remote ? 'crossed' : heldBack(message) ? 'held' : 'local'];
    if (message.status !== 'complete') classes.push(message.status);
    if (message.streaming) classes.push('streaming');

    const from = escapeHtml(nameOf(message));
    const to = escapeHtml(addresseeOf(message));

    // One line. Newlines in a log row turn the chamber into a wall.
    const pictures = message.images?.length
        ? `🖼 ${message.images.length > 1 ? `${message.images.length} images ` : ''}` : '';
    const text = (pictures + escapeHtml((message.content || '').replace(/\s+/g, ' ').trim())).trim()
        || (message.streaming ? 'generating…' : '—');

    let tag = AIR_TAG[message.streaming ? 'streaming' : message.status]
        || (remote ? '↗ crossed' : '');

    // Settled on one side of the boundary or the other: pressed with the seal.
    if (!message.streaming && message.status === 'blocked') {
        tag = stampHtml(message, 'withheld') + tag;
    } else if (!message.streaming && remote && message.status === 'complete') {
        tag = stampHtml(message, 'crossed') + tag;
    }

    // Still mid-entrance: resume the animation where it had got to rather than restarting it,
    // because this node replaced the one that was animating.
    const born = arrivals.born.get(message.id);
    const age = born == null ? Infinity : performance.now() - born;
    let entering = '';
    if (age < ENTRY_MS && !reducedMotion()) {
        classes.push('entering');
        entering = ` style="--age:${Math.round(-age)}ms"`;
    }

    return `<div class="${classes.join(' ')}" data-message="${message.id}"${entering}>
                <span class="air-seq">#${message.id}</span>
                <span class="air-who"><span class="from">${from}</span>
                    <span class="arrow">→</span><span class="to">${to}</span></span>
                <span class="air-text">${text}</span>
                <span class="air-tag">${tag}</span>
            </div>`;
}

function wireCopyButtons(scope) {
    scope.querySelectorAll('.copy').forEach(btn => {
        btn.onclick = () => {
            navigator.clipboard.writeText(btn.closest('.code').querySelector('pre').textContent);
            btn.textContent = 'copied';
            setTimeout(() => { btn.textContent = 'copy'; }, 1200);
        };
    });
}

/**
 * Let a single answer leave the pane with its provenance attached.
 *
 * The classic view has had this since packets existed; the duet panes never wired it, which
 * is why an individual output could not be dragged anywhere while a whole thread could. The
 * export helpers live in app.js and are shared deliberately — one definition of what a
 * packet says about itself, so the two views cannot drift into telling different stories
 * about the same message.
 *
 * A FINISHED message also carries DT_PACKET, the in-app format, so dropping it on a thread
 * in the rail moves it there (Alt forks). This used to be withheld: movePacket() reassigned
 * thread_id and nothing else, leaving the message attributed to a participant of the thread
 * it left. The server now detaches it on landing (rehome in duet-store.js) and refuses an
 * unfinished one outright, so the drag offers the move only when the server will take it.
 *
 * Nesting a message inside another is not offered here. A duet is one conversation in
 * server order; a message tucked under another has no place in that order, and the panes
 * would show it exactly where they showed it before.
 */
function wireHandoff(scope) {
    scope.querySelectorAll('[data-message]').forEach(node => {
        const packetId = +node.dataset.message;
        const message = messageById(packetId);
        if (!packetId || !message) return;

        node.querySelector('.prov-copy')?.addEventListener('click', ev => {
            ev.stopPropagation();
            copyWithProvenance(message, packetId, ev.currentTarget);
        });

        const handle = node.querySelector('.who[draggable]');

        const movable = message.status === 'complete';

        handle?.addEventListener('dragstart', e => {
            const dt = e.dataTransfer;

            // ⚠ The one check a drag can afford. It must hand over its text now, so the gate
            // model cannot rule — but the secret scanner can, in microseconds. A message
            // holding a known credential carries NO text out: dropped into another app it
            // inserts nothing. It can still move between threads here, which is not leaving.
            const hits = credentialsIn(message.content);
            if (hits.length && !movable) { e.preventDefault(); flash(exportRefusal(hits, packetId), 9000); return; }

            if (!hits.length) offerAsText(dt, exportText(message, packetId), exportHtml(message, packetId));
            if (movable) {
                dt.setData(DT_PACKET, String(packetId));
                draggingPacket = packetId;
            }

            // Shift turns the whole gesture into a FILE drag as far as the OS is concerned,
            // which is why it cannot be on by default: a chat composer then shows a drop
            // target and inserts nothing at all. (The server refuses the file for a message
            // holding a credential, too — see /api/packets/:id/packet.md.)
            if (e.shiftKey && !hits.length) {
                dt.setData('DownloadURL',
                    `text/markdown:airlock-packet-${packetId}.md:`
                    + `${location.origin}/api/packets/${packetId}/packet.md`);
            }

            // copyMove only when a thread in the rail may take it: a drop there sets
            // dropEffect 'move', which 'copy' alone forbids — silently, with a no-entry cursor.
            dt.effectAllowed = movable ? 'copyMove' : 'copy';
            node.classList.add('dragging');

            const mode = dragMode(e, movable);
            const tag = mode === 'export' ? ' <b>[.md]</b>' : mode === 'fork' ? ' <b>[fork]</b>' : '';
            const preview = node.querySelector('.bubble')?.textContent.trim().slice(0, 46) || '';
            dt.setDragImage(makeDragChip(`<b>#${packetId}</b> ${escapeHtml(preview)}…${tag}`), 16, 14);

            if (hits.length) {
                dt.setDragImage(makeDragChip(`<b>#${packetId}</b> ⚠ kept in Airlock — move or fork only`), 16, 14);
                flash(`${exportRefusal(hits, packetId)} Dropping it on a thread here still moves it.`, 30000);
                return;
            }

            flash(movable
                ? 'drop on a thread to move · Alt to fork · any text box takes it with its provenance · Shift for .md'
                : 'drop into any text box — the model and the tier travel with it · '
                  + 'Shift for .md · ⧉ copy if the target refuses drops', 30000);
        });

        handle?.addEventListener('drag', e => {
            const mode = dragMode(e, movable);
            if (mode === 'fork') announceSplit(node);
            trail(e, mode);
        });

        handle?.addEventListener('dragend', () => {
            node.classList.remove('dragging');
            draggingPacket = null;
            clearDragChip();
            clearTrails();
            clearFlash();
        });
    });
}

function paintPaneStatus(participantId) {
    const pane = panes.get(participantId);
    if (!pane) return;

    const { status, error } = pane;
    const busy = status && status !== 'idle';
    const node = pane.nodes.state;

    node.className = 'duet-state' + (error ? ' bad' : busy ? ' busy' : '');
    pane.nodes.node.classList.toggle('busy', Boolean(busy));   // the folded strip reads this
    node.textContent = error ? error
        : status === 'queued' ? `queued · ${pane.queuePosition} ahead`
            : status === 'gating' ? 'gate ruling…'
                : status === 'running' ? 'generating…'
                    : status === 'sending' ? 'sending…'
                        : '';

    pane.nodes.send.textContent = busy ? 'Stop' : 'Send';
    pane.nodes.send.classList.toggle('stop', Boolean(busy));
    pane.nodes.retry.hidden = !pane.retryOf && !pane.retryRelay;
}

/** The header chip: which side of the boundary this participant sits on. */
function paintPaneTier(participantId) {
    const pane = panes.get(participantId);
    const who = participant(participantId);
    if (!pane || !who) return;

    const tier = who.model ? tierOfModel(who.model) : 'local';

    // ⚠ "crosses" unless positively local — the server gates on exactly the same test,
    // so the chip and the gate cannot disagree. Tested as `=== 'remote'`, an unclassified
    // or Ollama-cloud participant was chipped "local" while its messages were gated.
    const remote = tier !== 'local';

    pane.nodes.tier.className = 'duet-tier' + (remote ? ' remote' : '');
    pane.nodes.tier.textContent = remote ? '↗ crosses' : 'local';
    pane.nodes.tier.title = tier === 'remote'
        ? 'This participant runs across the boundary. Sending to it sends the shared '
          + 'conversation — the other participant\'s words included — and the local gate '
          + 'rules on it first.'
        : remote
        ? 'Airlock cannot place this model on either side of the boundary, so it is '
          + 'treated as a crossing: the local gate rules first, and the crossing is logged.'
        : `This participant runs on ${here()}. Nothing sent here goes to a remote model.`;

    pane.nodes.node.classList.toggle('is-remote', remote);
    paintFiles(participantId);      // tools, and the remote default, follow the model
}

// ─────────────────────────── sending ───────────────────────────

const newRequestId = () => (crypto.randomUUID
    ? crypto.randomUUID()
    : `req-${Date.now()}-${Math.random().toString(36).slice(2)}`);

/**
 * Send to one participant, or regenerate an earlier turn.
 *
 * The guard at the top is the duplicate-submit guard's near half: a pane already
 * generating will not start a second request. The far half is `clientRequestId`, which the
 * server matches so a resent submission reuses the request it already wrote rather than
 * asking the same question twice.
 */
async function submit(participantId, { retryOf = null, relayOf = null } = {}) {
    const pane = panes.get(participantId);
    if (!pane) return null;

    const box = pane.nodes.input;
    const text = box.value.trim();
    const automatic = Boolean(retryOf || relayOf);     // nothing typed: a retry or a chatter turn

    if (pane.controller) {
        // Mid-run, a message typed into a side that is busy answering is the user joining
        // in — not a request to stop it. It waits in the composer and goes in the moment
        // this turn ends (see sendInterjections). Outside a run, the button is Stop.
        if (chatter.running && !automatic && (text || pane.pending.length)) {
            pane.interject = true;
            flash(`You'll come in as soon as ${participant(participantId)?.name || 'this side'} finishes this turn.`, 5000);
            return null;
        }
        pane.controller.abort();
        return null;
    }

    const staged = automatic ? [] : pane.pending;
    const answering = automatic ? null : pane.answering;
    if (!automatic && !text && !staged.length) return null;

    pane.interject = false;
    pane.error = null;
    pane.retryOf = null;
    pane.retryRelay = null;
    pane.status = 'sending';
    pane.queuePosition = 0;
    pane.controller = new AbortController();
    paintPaneStatus(participantId);

    // Cleared optimistically so the composer is usable again immediately; put back if the
    // request never reached the server, so a mis-send is not a lost message.
    if (!automatic) {
        box.value = '';
        box.style.height = 'auto';
        pane.pending = [];
        pane.answering = null;
        paintAttachments(participantId);
    }

    const requestId = pane.requestId ||= newRequestId();
    let streamed = null;   // the reply message id, once the server names it

    try {
        const res = await fetch(`/api/duet/${state.threadId}/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                participantId,
                text: automatic ? undefined : text,
                images: staged.length ? staged.map(p => p.dataUrl) : undefined,
                tools: filesWanted(participantId),
                web: webWanted(participantId),
                clientRequestId: automatic ? undefined : requestId,
                retryOf,
                relayOf,
                answers: answering ? answering.id : undefined
            }),
            signal: pane.controller.signal
        });

        if (!res.ok) {
            const { error } = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
            throw new Error(error);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (!line.trim()) continue;

                let event;
                try { event = JSON.parse(line); } catch { continue; }

                streamed = handleEvent(participantId, event, streamed);
            }
        }
    } catch (err) {
        if (err.name === 'AbortError') {
            // Stopping is a decision, not a failure. The server has already settled the
            // packet as cancelled; mirror that locally so the pane agrees without a reload.
            const message = streamed && messageById(streamed);
            if (message) { message.streaming = false; message.status = 'cancelled'; }
            markRetry(pane);
        } else {
            pane.error = err.message;
            const message = streamed && messageById(streamed);
            if (message) { message.streaming = false; message.status = 'failed'; }
            // Nothing was sent at all — hand the text and images back rather than swallowing them.
            if (!streamed && !automatic && !box.value.trim()) box.value = text;
            if (!streamed && !automatic && !pane.pending.length && staged.length) {
                pane.pending = staged;
                paintAttachments(participantId);
            }
            if (!streamed && answering && !pane.answering) {
                pane.answering = answering;
                paintAttachments(participantId);
            }
            markRetry(pane);
        }
    } finally {
        // Stopped at the gate, or the stream died there: open up. A no-op if it already ruled.
        releaseDoors(participantId, 'stopped');
        pane.controller = null;
        pane.status = 'idle';
        pane.requestId = null;
        paintPane(participantId);
        paintAirlock();

        // Duet turns are packets like any other, so the tray counts moved — and the bar's
        // crossed count, which reads the record.
        loadTree().catch(() => {});
        paintCrossed();
    }

    // The settled reply, so a chatter run can see how the turn ended.
    return streamed ? messageById(streamed) : null;
}

/** A turn that did not finish can be asked again — a request, or a chatter turn. */
function markRetry(pane) {
    pane.retryOf = pane.triggerId;
    pane.retryRelay = pane.relayTrigger;
}

/** One NDJSON event from the server. Returns the reply id being streamed, if known. */
function handleEvent(participantId, event, streamed) {
    const pane = panes.get(participantId);

    switch (event.type) {
        case 'relay':
            // A chatter turn: no request was written; this is the reply being answered.
            pane.triggerId = null;
            pane.relayTrigger = event.message.id;
            return streamed;

        case 'user':
            upsert({ ...event.message });
            pane.triggerId = event.message.id;
            pane.relayTrigger = null;
            schedulePaint(participantId);
            // The first thing said in an Untitled thread names it (app.js decides whether
            // it is still Untitled — a name given by hand is never overwritten).
            if (event.created && state.messages.filter(m => m.role === 'user').length === 1) {
                nameUntitled(state.threadId, event.message.content).catch(() => {});
            }
            return streamed;

        case 'start':
            upsert({ ...event.message, streaming: true });
            pane.status = 'running';
            schedulePaint(participantId);
            return event.message.id;

        case 'gating':
            pane.status = 'gating';
            paintPaneStatus(participantId);
            holdDoors(participantId, messageById(event.messageId));
            return streamed;

        // Queued or running after a gate means the gate released it.
        case 'queued':
            releaseDoors(participantId, 'cleared');
            pane.status = 'queued';
            pane.queuePosition = event.position;
            paintPaneStatus(participantId);
            return streamed;

        case 'running':
            releaseDoors(participantId, 'cleared');
            pane.status = 'running';
            paintPaneStatus(participantId);
            return streamed;

        case 'thinking': {
            const message = messageById(event.messageId);
            if (message) message.thinking = (message.thinking || '') + event.text;
            schedulePaint(participantId);
            return streamed;
        }

        case 'token': {
            const message = messageById(event.messageId);
            if (message) message.content += event.text;
            schedulePaint(participantId);
            return streamed;
        }

        case 'tool': {
            const message = messageById(event.messageId);
            if (message) (message.tools ||= []).push({ name: event.name, ok: event.ok, summary: event.summary, crossed: event.crossed });
            schedulePaint(participantId);
            return streamed;
        }

        case 'blocked':
            upsert({ ...event.message, streaming: false });
            releaseDoors(participantId, 'withheld');
            markRetry(pane);
            schedulePaint(participantId);
            flash('The local gate withheld that — nothing was sent.', 7000);
            return event.message.id;

        case 'done': {
            const usage = event.usage;
            const done = event.done;
            const tps = done?.eval_count && done?.eval_duration
                ? (done.eval_count / (done.eval_duration / 1e9)).toFixed(1)
                : '?';
            const stats = usage
                ? `${usage.reply ?? '?'} tokens · ${tps} tok/s · ${usage.prompt ?? '?'} prompt tokens`
                : '';

            upsert({ ...event.message, streaming: false, stats, thinking: event.thinking || null });
            refreshUsage();          // the ledger has the new row; the pill reads it
            pane.status = 'idle';
            schedulePaint(participantId);
            return event.message.id;
        }

        case 'cancelled':
            upsert({ ...event.message, streaming: false });
            markRetry(pane);
            schedulePaint(participantId);
            return event.message.id;

        case 'error':
            if (event.message) upsert({ ...event.message, streaming: false });
            releaseDoors(participantId, 'failed');
            pane.error = event.error;
            markRetry(pane);
            schedulePaint(participantId);
            return event.message?.id ?? streamed;

        default:
            return streamed;
    }
}

// ─────────────────────────── pane construction ───────────────────────────

/**
 * Model options, grouped by tier — the SAME groups app.js uses, built by the same
 * function, because which side of the boundary a model sits on is the one thing you must
 * know before picking it and two pickers that could disagree about it would be worse
 * than one. This used to be a copy, and the copy had the same `!== 'remote'` filter as
 * the original: anything unclassified was listed as "stays on this machine".
 */
const modelOptions = selected => modelOptgroups(state.models, selected);

function buildPane(who) {
    const node = document.createElement('section');
    node.className = 'duet-pane';
    node.dataset.slot = who.slot;
    node.dataset.participant = String(who.id);

    node.innerHTML = `
        <header class="duet-head">
            <span class="duet-slot">${who.slot === 'a' ? 'Left' : 'Right'}</span>
            <span class="duet-tier"></span>
            <select class="duet-model" title="Which model answers as this participant">
                ${modelOptions(who.model)}
            </select>
            <button class="icon-btn sm duet-role-btn" title="Standing instructions for this participant">✎ role</button>
            <span class="duet-state"></span>
            <button class="icon-btn sm duet-focus" title="Focus this side — fold the other one away">⤢</button>
        </header>

        <!-- Shown only while the OTHER side is focused: this pane, folded to a strip that
             still says which side it is, which side of the boundary it runs on, and whether
             it is busy. Click to unfold. -->
        <button class="duet-fold" hidden title="Unfold ${who.slot === 'a' ? 'the left' : 'the right'} side">
            <span class="duet-fold-dot"></span>
            <span class="duet-fold-label">${who.slot === 'a' ? 'Left' : 'Right'}</span>
        </button>

        <div class="duet-role" hidden>
            <textarea class="duet-role-text" rows="2"
                      placeholder="Optional. e.g. &quot;Argue the sceptical case. Be brief.&quot;">${escapeHtml(who.instructions || '')}</textarea>
            <div class="row">
                <span class="hint">Trusted instructions, kept separate from the conversation. Crosses the boundary with it.</span>
                <span class="spacer"></span>
                <button class="icon-btn sm duet-role-save">Save</button>
            </div>
        </div>

        <div class="duet-composer">
            <div class="attached duet-attached" hidden></div>
            <textarea class="duet-input" rows="1"
                      placeholder="Ask ${who.slot === 'a' ? 'left' : 'right'}…  (Enter to send)"></textarea>
            <div class="row">
                <button class="icon-btn sm duet-attach" title="Attach an image (needs a 👁 model) or a text file">📎</button>
                <button class="icon-btn sm toggle duet-files" type="button">⛁ files</button>
                <button class="icon-btn sm toggle duet-web" type="button">🌐 web off</button>
                <input type="file" class="duet-file" multiple hidden
                       accept="image/*,.md,.markdown,.txt,.text,.json,.csv,.log,.yml,.yaml,.js,.ts,.py,.ps1,.scad,.html,.css">
                <button class="icon-btn sm duet-retry" hidden title="Ask again — the original request is reused, not repeated">↻ retry</button>
                <span class="spacer"></span>
                <button class="send duet-send">Send</button>
            </div>
        </div>`;

    const nodes = {
        node,
        input: node.querySelector('.duet-input'),
        send: node.querySelector('.duet-send'),
        retry: node.querySelector('.duet-retry'),
        state: node.querySelector('.duet-state'),
        tier: node.querySelector('.duet-tier'),
        model: node.querySelector('.duet-model'),
        roleBtn: node.querySelector('.duet-role-btn'),
        role: node.querySelector('.duet-role'),
        roleText: node.querySelector('.duet-role-text'),
        roleSave: node.querySelector('.duet-role-save'),
        composer: node.querySelector('.duet-composer'),
        attached: node.querySelector('.duet-attached'),
        attach: node.querySelector('.duet-attach'),
        file: node.querySelector('.duet-file'),
        focus: node.querySelector('.duet-focus'),
        fold: node.querySelector('.duet-fold'),
        files: node.querySelector('.duet-files'),
        web: node.querySelector('.duet-web')
    };

    nodes.web.onclick = () => {
        const on = !webWanted(who.id);
        try { localStorage.setItem(webKey(who.id), on ? '1' : '0'); } catch { /* session only */ }
        paintWeb(who.id);
        if (on) {
            flash(`${participant(who.id)?.name || 'This side'} may now use the web. Every search query leaves this machine, `
                + 'so the local gate rules on each one first — from either side. A fetch opens only a link from a '
                + 'search result or from you, never one the model made up. Each one is on the record.', 10000);
        }
    };

    nodes.files.onclick = () => {
        const on = !filesWanted(who.id);
        try { localStorage.setItem(filesKey(who.id), on ? '1' : '0'); } catch { /* session only */ }
        paintFiles(who.id);
        if (on && isRemote(who.id)) {
            flash(`${participant(who.id)?.model || 'This model'} runs across the boundary. It may now ask `
                + 'to read files in this thread\'s workspace; the local gate rules on every file '
                + 'before it is sent.', 9000);
        }
    };

    nodes.focus.onclick = () => setFocus(state.focus === who.slot ? null : who.slot);
    nodes.fold.onclick = () => setFocus(null);

    panes.set(who.id, {
        nodes, controller: null, status: 'idle', error: null,
        queuePosition: 0, retryOf: null, triggerId: null, requestId: null, frame: null,
        pending: [],            // images staged for this pane's next message
        answering: null         // { id, request }: the next message answers that request
    });

    nodes.attach.onclick = () => nodes.file.click();
    nodes.file.onchange = () => { addAttachments(who.id, nodes.file.files); nodes.file.value = ''; };
    nodes.input.addEventListener('paste', e => {
        const pics = [...e.clipboardData.files].filter(f => f.type.startsWith('image/'));
        if (pics.length) { e.preventDefault(); addAttachments(who.id, pics); }
    });
    // Files only — a packet or a thread dragged over the composer is not an attachment.
    const carriesFiles = e => e.dataTransfer?.types.includes('Files');
    ['dragenter', 'dragover'].forEach(ev => nodes.composer.addEventListener(ev, e => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        nodes.composer.classList.add('drag');
    }));
    nodes.composer.addEventListener('dragleave', () => nodes.composer.classList.remove('drag'));
    nodes.composer.addEventListener('drop', e => {
        nodes.composer.classList.remove('drag');
        if (!carriesFiles(e)) return;
        e.preventDefault();
        addAttachments(who.id, e.dataTransfer.files);
    });

    nodes.send.onclick = () => submit(who.id);
    nodes.retry.onclick = () => {
        const pane = panes.get(who.id);
        if (pane.retryOf) submit(who.id, { retryOf: pane.retryOf });
        else if (pane.retryRelay) submit(who.id, { relayOf: pane.retryRelay });
    };

    nodes.input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(who.id); }
    });
    nodes.input.addEventListener('input', () => {
        nodes.input.style.height = 'auto';
        nodes.input.style.height = Math.min(nodes.input.scrollHeight, 160) + 'px';
    });

    nodes.model.onchange = async () => {
        const updated = await patchParticipant(who.id, { model: nodes.model.value });
        if (!updated) return;
        paintPaneTier(who.id);
        // The header is the only place the CURRENT model is shown; past replies keep the
        // model that actually produced them, so nothing already on screen changes.
        if (updated.tier && updated.tier !== 'local') {
            flash(`${updated.name} now runs across the boundary. The local gate will rule `
                + 'on the shared conversation before anything is sent.', 8000);
        }
    };

    nodes.roleBtn.onclick = () => {
        nodes.role.hidden = !nodes.role.hidden;
        nodes.roleBtn.classList.toggle('on', !nodes.role.hidden);
        if (!nodes.role.hidden) nodes.roleText.focus();
    };
    nodes.roleSave.onclick = async () => {
        const updated = await patchParticipant(who.id, { instructions: nodes.roleText.value });
        if (updated) {
            nodes.role.hidden = true;
            nodes.roleBtn.classList.remove('on');
            nodes.roleBtn.classList.toggle('has-role', Boolean(updated.instructions));
            flash(`${updated.name}'s role instructions saved`);
        }
    };
    nodes.roleBtn.classList.toggle('has-role', Boolean(who.instructions));

    return node;
}

// ─────────────────────────── workspace files ───────────────────────────
//
// Per participant, remembered in this browser. On by default for a side on this machine,
// OFF by default for a side across the boundary: letting a cloud model read your files is
// something you switch on, never something you find on. The server offers tools only when
// the request says so, the thread has a usable workspace, and the model can call them —
// and every file result bound for a remote model is ruled on before it goes.

const filesKey = id => `airlock.duet.files.${id}`;
const isRemote = id => {
    const model = participant(id)?.model;
    return model ? tierOfModel(model) !== 'local' : false;
};

function filesWanted(id) {
    let stored = null;
    try { stored = localStorage.getItem(filesKey(id)); } catch { /* default below */ }
    return stored === null ? !isRemote(id) : stored === '1';
}

/**
 * The web is off until switched on, on BOTH sides — unlike files, which a local side reads
 * without anything leaving. A search sends words a model wrote off this machine, whichever
 * side wrote them.
 */
const webKey = id => `airlock.duet.web.${id}`;
function webWanted(id) {
    try { return localStorage.getItem(webKey(id)) === '1'; } catch { return false; }
}

function paintWeb(id) {
    const pane = panes.get(id);
    if (!pane?.nodes.web) return;
    const model = participant(id)?.model;
    const canTool = Boolean(state.models.find(m => m.name === model)?.caps?.includes('tools'));
    const on = webWanted(id) && canTool;
    const btn = pane.nodes.web;
    btn.classList.toggle('on', on);
    btn.classList.toggle('remote', on);
    btn.disabled = !canTool;
    btn.textContent = !canTool ? '🌐 no tools' : on ? '🌐 web' : '🌐 web off';
    const search = state.web?.search;
    btn.title = !canTool ? `${model} can't call tools`
        : on ? `May ${search ? 'search the web and ' : ''}open links. Queries are ruled on by the local gate before they leave. Click to turn off.`
            : `Click to let ${participant(id)?.name || 'this side'} ${search ? 'search the web and ' : ''}open links${search ? '' : ' (search needs TAVILY_API_KEY)'}`;
}

function paintFiles(id) {
    paintWeb(id);
    const pane = panes.get(id);
    if (!pane) return;
    const model = participant(id)?.model;
    const canTool = Boolean(state.models.find(m => m.name === model)?.caps?.includes('tools'));
    const root = workspace.threadId === state.threadId ? workspace.root : null;
    const on = filesWanted(id);
    const armed = on && canTool && Boolean(root) && workspace.exists;

    const btn = pane.nodes.files;
    btn.classList.toggle('on', armed);
    btn.classList.toggle('remote', armed && isRemote(id));
    btn.disabled = !canTool;
    // A root whose folder has gone is its own state — not "off", and not "no workspace" —
    // because the fix is different: point it at the folder again.
    const missing = Boolean(root) && !workspace.exists;
    btn.textContent = !canTool ? '⛁ no tools' : armed ? '⛁ files'
        : missing ? '⛁ files missing' : on && !root ? '⛁ no workspace' : '⛁ files off';
    btn.title = !canTool ? `${model} can't call tools — attach files with 📎 instead`
        : missing ? `${root} no longer exists — set the workspace again in ⚙ Settings`
        : !root ? 'This thread has no workspace — set one in ⚙ Settings'
            : on ? `May read files under ${root}${isRemote(id) ? ' — each one ruled on by the local gate before it crosses' : ''}. Click to turn off.`
                : `Click to let ${participant(id)?.name || 'this side'} read files under ${root}`;
}

// ─────────────────────────── attachments ───────────────────────────

const MAX_IMAGES = 4;       // matches duet-runner.js checkImages

const canSee = participantId => {
    const model = participant(participantId)?.model;
    return Boolean(state.models.find(m => m.name === model)?.caps?.includes('vision'));
};

/**
 * Images are staged on the pane and sent with its next message; text files fold into the
 * message itself, as they always did in the single view — no tool round, and it works for
 * files outside any workspace because you handed them over explicitly.
 */
function addAttachments(participantId, files) {
    const pane = panes.get(participantId);
    if (!pane) return;

    for (const f of files) {
        if (f.type.startsWith('image/')) {
            if (pane.pending.length >= MAX_IMAGES) {
                flash(`At most ${MAX_IMAGES} images per message.`, 5000);
                continue;
            }
            const fr = new FileReader();
            fr.onload = () => {
                pane.pending.push({ name: f.name || 'pasted.png', dataUrl: fr.result });
                paintAttachments(participantId);
            };
            fr.readAsDataURL(f);

            // Said now, not after Send: the server refuses an image a model cannot see, and
            // finding that out with the message already typed is the worse moment.
            if (!canSee(participantId)) {
                flash(`${participant(participantId)?.model || 'This model'} can't see images — `
                    + 'pick a 👁 model for this side before sending.', 7000);
            }
            continue;
        }

        if (TEXT_ATTACH.test(f.name)) {
            const fr = new FileReader();
            fr.onload = () => {
                const text = String(fr.result).slice(0, 60000);
                const fence = '```';
                const box = pane.nodes.input;
                box.value += `${box.value ? '\n\n' : ''}${f.name}:\n${fence}\n${text}\n${fence}\n`;
                box.dispatchEvent(new Event('input'));
                box.focus();
                flash(`Pasted ${f.name} into the message (${text.length.toLocaleString()} chars)`, 5000);
            };
            fr.readAsText(f);
            continue;
        }

        flash(`Skipped ${f.name} — not an image or a text file`, 5000);
    }
}

function paintAttachments(participantId) {
    const pane = panes.get(participantId);
    if (!pane) return;
    const box = pane.nodes.attached;

    box.hidden = !pane.pending.length && !pane.answering;
    box.innerHTML = (pane.answering
        ? `<span class="chip answer-chip"><span>Answering: ${escapeHtml(pane.answering.request.slice(0, 90))}</span>
           <button type="button" data-unanswer title="Send as an ordinary message instead">✕</button></span>` : '')
        + pane.pending.map((p, i) =>
        `<span class="chip"><img src="${p.dataUrl}" alt=""><span>${escapeHtml(p.name)}</span>
         <button type="button" data-i="${i}" title="Remove">✕</button></span>`).join('');

    box.querySelectorAll('button[data-i]').forEach(b => {
        b.onclick = () => { pane.pending.splice(+b.dataset.i, 1); paintAttachments(participantId); };
    });
    const unanswer = box.querySelector('button[data-unanswer]');
    if (unanswer) unanswer.onclick = () => { pane.answering = null; paintAttachments(participantId); };
}

/**
 * Answer a participant's request: the next message typed into ITS composer goes in linked
 * to the reply that asked, so the result is on the record as the user's, answering that.
 */
function startAnswer(replyId) {
    const asked = messageById(replyId);
    const pane = asked && panes.get(asked.authorId);
    if (!pane) return;
    const requests = asked.requestMeta?.requests || [];
    pane.answering = { id: asked.id, request: requests.map(r => r.text).join(' / ') };
    if (state.focus) setFocus(null);
    paintAttachments(asked.authorId);
    pane.nodes.input.focus();
}

async function patchParticipant(id, patch) {
    try {
        const res = await fetch(`/api/duet/participants/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch)
        });
        const body = await res.json();
        if (body.error) { flash(body.error, 6000); return null; }

        const at = state.participants.findIndex(p => p.id === id);
        if (at !== -1) state.participants[at] = body;
        return body;
    } catch (err) {
        flash(err.message, 6000);
        return null;
    }
}

// ─────────────────────────── view switching ───────────────────────────

function paintTabs() {
    const [a, b] = state.participants;
    duetEl.tabs.innerHTML = `
        <button class="duet-tab" data-tab="panes">Both panes</button>
        <button class="duet-tab" data-slot="a">Left</button>
        <button class="duet-tab" data-slot="b">Right</button>
        <span class="spacer"></span>
        <span class="duet-note">Both participants read the chamber below.</span>`;

    duetEl.tabs.querySelectorAll('.duet-tab').forEach(btn => {
        btn.onclick = () => {
            if (btn.dataset.slot) state.mobileSlot = btn.dataset.slot;
            paintView();
        };
    });

    paintTabSelection();
}

function paintTabSelection() {
    duetEl.tabs.querySelectorAll('.duet-tab').forEach(btn => {
        const on = btn.dataset.tab === 'panes' || btn.dataset.slot === state.mobileSlot;
        btn.classList.toggle('on', on);
    });
}

// ── focus: one side wide, the other folded to a strip ──
//
// What the single view was for — talking to one model — without leaving the conversation
// or the chamber. The folded side is still a participant: it can be generating, and it
// still reads the whole conversation next time it is asked. Remembered per thread.

const focusKey = id => `airlock.duet.focus.${id}`;

function setFocus(slot) {
    state.focus = slot || null;
    if (state.threadId) {
        try {
            if (state.focus) localStorage.setItem(focusKey(state.threadId), state.focus);
            else localStorage.removeItem(focusKey(state.threadId));
        } catch { /* private window: the choice lasts this session */ }
    }
    paintFocus();
    if (state.focus) {
        const focused = state.participants.find(p => p.slot === state.focus);
        panes.get(focused?.id)?.nodes.input.focus();
    }
}

function paintFocus() {
    if (state.focus) duetEl.root.dataset.focus = state.focus;
    else delete duetEl.root.dataset.focus;
    if (duetEl.timeline) schedulePaint();

    for (const who of state.participants) {
        const pane = panes.get(who.id);
        if (!pane) continue;
        const folded = Boolean(state.focus) && state.focus !== who.slot;
        pane.nodes.fold.hidden = !folded;
        pane.nodes.focus.textContent = state.focus === who.slot ? '⤡' : '⤢';
        pane.nodes.focus.title = state.focus === who.slot
            ? 'Show both sides again' : 'Focus this side — fold the other one away';
        pane.nodes.focus.classList.toggle('on', state.focus === who.slot);
    }
}

function paintView() {
    duetEl.root.dataset.slot = state.mobileSlot;
    paintFocus();
    paintTabSelection();
    paintTimeline();
    state.participants.forEach(p => paintPaneStatus(p.id));
    paintAirlock();
}

/** Show the two panes and the chamber, or nothing (app.js shows the idle desk then). */
function setActive(active) {
    state.active = Boolean(active) && state.enabled;
    duetEl.root.hidden = !state.active;
    if (state.active) paintView();
}

// ─────────────────────────── lifecycle ───────────────────────────

/**
 * Models come from /api/health, the same source the Settings picker uses, so the duet cannot
 * offer a model the rest of the app does not believe in — and each carries its tier.
 */
async function loadModels() {
    if (state.models.length) return;
    try {
        const h = await (await fetch('/api/health')).json();
        if (Array.isArray(h.models)) state.models = h.models;
        state.web = h.web || null;
    } catch { /* the picker degrades to whatever is already selected */ }
}

function teardown() {
    for (const [, pane] of panes) {
        pane.controller?.abort();
        if (pane.frame) cancelAnimationFrame(pane.frame);
    }
    panes.clear();
    if (timelineFrame) { cancelAnimationFrame(timelineFrame); timelineFrame = null; }
    duetEl.grid.innerHTML = '';
    duetEl.timeline = null;
    resetDoors();
}

async function loadDuet(threadId) {
    let data = await (await fetch(`/api/duet/${threadId}`)).json();
    if (data.error) throw new Error(data.error);

    // Every thread is a duet. One created before participants existed — or before this
    // view was the only view — is seated now, with the same defaults a new thread gets,
    // rather than opening onto nothing. Its earlier packets stay shared history.
    if (!data.enabled) {
        data = await (await fetch(`/api/duet/${threadId}/enable`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        })).json();
        if (data.error) throw new Error(data.error);
    }

    state.threadId = threadId;
    state.enabled = data.enabled;
    try { state.focus = localStorage.getItem(focusKey(threadId)) || null; } catch { state.focus = null; }
    state.participants = data.participants;
    state.messages = data.messages;
    state.userName = data.userName;

    teardown();
    if (!state.enabled) return;

    await loadModels();
    state.participants.forEach(who => duetEl.grid.appendChild(buildPane(who)));
    duetEl.grid.appendChild(buildTimeline());
    state.participants.forEach(who => paintPaneTier(who.id));
    paintTabs();
}

/**
 * The thread changed under us. Every in-flight generation belongs to the thread being
 * left, so they stop — the server settles each as cancelled, and the partial text is
 * already in the log where it can be read later.
 */
async function onThread(thread) {
    stopChatter();          // a run belongs to the thread it started in
    teardown();

    if (!thread) {
        state.threadId = null;
        state.enabled = false;
        setActive(false);
        return;
    }

    try {
        await loadDuet(thread.id);
    } catch (err) {
        flash(err.message, 6000);
        state.enabled = false;
    }
    setActive(state.enabled);
}

// ─────────────────────────── chatter ───────────────────────────
//
// The participants answering each other. A chatter turn is a relay: one side replies to the
// other side's finished reply, and nobody typed a request for it (see resolveRelay in
// duet-runner.js). Every relay toward a remote side is a crossing like any other — gated,
// the doors holding while it rules, recorded when it goes.
//
// The run lives HERE, in the page, on purpose. Close the tab and it stops: a conversation
// with a cloud model must not be able to keep spending while nobody is watching it.

const chatter = { running: false, stopping: false, round: 0, cap: 6, threadId: null };
const chatterEl = {
    root: $('chatter'), step: $('chatterStep'), auto: $('chatterAuto'),
    cap: $('chatterCap'), state: $('chatterState')
};

const anyBusy = () => [...panes.values()].some(p => p.controller);
const pause = ms => new Promise(r => setTimeout(r, ms));

/** Wait until no side is generating — a turn in flight, or the user's own message. */
async function idle() {
    while (anyBusy() && !chatter.stopping && chatter.threadId === state.threadId) await pause(150);
}

/**
 * Who speaks next, and to what: the side that did NOT write the newest finished reply,
 * answering it. Returns { speaker, trigger } or { why } when there is nothing to answer.
 */
function nextTurn() {
    const last = state.messages[state.messages.length - 1];
    if (!last) return { why: 'Ask one side something first — chatter carries on from the last reply.' };
    if (last.streaming) return { wait: true };
    if (last.role === 'user') {
        return { why: 'The newest message is yours and has no answer yet — send it, or ask again.' };
    }
    if (last.status !== 'complete') {
        return { why: `The last reply was ${STATUS_NOTE[last.status] || last.status} — chatter stops there.` };
    }
    if (!String(last.content || '').trim()) {
        return { why: `${nameOf(last)} finished without saying anything — there is nothing to answer, so chatter stops there.` };
    }

    const [a, b] = [...state.participants].sort((x, y) => x.slot.localeCompare(y.slot));
    if (!a || !b) return { why: 'Chatter needs two participants.' };
    // A reply from before the thread had participants has no author: the left side opens.
    const speaker = last.authorId === a.id ? b : a;
    return { speaker, trigger: last };
}

/** Messages typed into a side while it was busy: in they go, now that it is free. */
async function sendInterjections() {
    for (const [id, pane] of panes) {
        if (!pane.interject || chatter.stopping) continue;
        pane.interject = false;
        await submit(id);
        await idle();
    }
}

/** How a turn ended, said plainly — the reason a run stopped. */
function endedBecause(reply, speakerId) {
    if (!reply) {
        const error = panes.get(speakerId)?.error;
        return error ? `the turn did not start: ${error}` : 'the turn did not start';
    }
    if (reply.status === 'blocked') return `the gate withheld ${nameOf(reply)}'s turn — nothing was sent`;
    if (reply.status === 'cancelled') return 'stopped';
    return `${nameOf(reply)}'s turn ${STATUS_NOTE[reply.status] || reply.status}`;
}

async function chatterStep() {
    if (chatter.running || anyBusy()) return;
    const turn = nextTurn();
    if (!turn.speaker) return flash(turn.why || 'Nothing to answer yet.', 6000);
    chatter.threadId = state.threadId;
    await submit(turn.speaker.id, { relayOf: turn.trigger.id });
}

async function chatterAuto() {
    if (chatter.running) { stopChatter(); return; }
    if (anyBusy()) return flash('Wait for the current reply to finish, then start the run.', 5000);

    const first = nextTurn();
    if (!first.speaker) return flash(first.why || 'Nothing to answer yet.', 6000);

    Object.assign(chatter, {
        running: true, stopping: false, round: 0, threadId: state.threadId,
        cap: Math.min(20, Math.max(1, Math.round(Number(chatterEl.cap.value) || 6)))
    });
    chatterEl.cap.value = chatter.cap;
    paintChatter();

    let why = null;
    try {
        while (chatter.round < chatter.cap && !chatter.stopping) {
            await idle();
            if (chatter.stopping || chatter.threadId !== state.threadId) break;
            await sendInterjections();
            if (chatter.stopping || chatter.threadId !== state.threadId) break;

            const turn = nextTurn();
            if (turn.wait) { await pause(150); continue; }
            if (!turn.speaker) { why = turn.why; break; }

            chatter.round++;
            paintChatter();
            let reply = await submit(turn.speaker.id, { relayOf: turn.trigger.id });

            // Only the user can answer a request. Going on without the answer is how a run
            // ends up building on a result nobody took — so the run waits for the user.
            if (reply?.status === 'complete' && reply.requestMeta?.requests?.length) {
                why = `${nameOf(reply)} asked you for a result — answer it, then carry on`; break;
            }

            // A model that reasons and then says nothing often does it once, not twice: ask
            // the same turn again before ending the run. The empty reply stays in the log —
            // it happened — and the retry answers the same message it did.
            if (reply?.status === 'complete' && !String(reply.content || '').trim() && !chatter.stopping) {
                flash(`${nameOf(reply)} came back empty — asking once more.`, 4000);
                await idle();
                reply = await submit(turn.speaker.id, { relayOf: turn.trigger.id });
            }

            if (!reply || reply.status !== 'complete') { why = endedBecause(reply, turn.speaker.id); break; }
            if (!String(reply.content || '').trim()) {
                why = `${nameOf(reply)} finished without saying anything, twice`; break;
            }
            // A side saying, near enough word for word, what it already said: a loop, not a
            // conversation. Every further turn would spend tokens — and across the boundary,
            // credit — on the same two sentences.
            const echoed = repeatOf(reply);
            if (echoed) { why = `${nameOf(reply)} is repeating itself — this turn nearly matches #${echoed.id}`; break; }
        }
        if (!why) why = chatter.stopping ? 'stopped' : `${chatter.round} turns — the cap`;
    } finally {
        // An interjection typed during the last turn still goes in, after the run.
        if (!chatter.stopping) await sendInterjections().catch(() => {});
        chatter.running = false;
        chatter.stopping = false;
        paintChatter(why);
    }
}

/** Stop the run, and the turn in flight with it. */
function stopChatter() {
    if (!chatter.running) return;
    chatter.stopping = true;
    for (const [, pane] of panes) pane.controller?.abort();
    paintChatter();
}

function paintChatter(ended = null) {
    const { running, stopping, round, cap } = chatter;
    duetEl.rail.classList.toggle('chattering', running);
    chatterEl.step.disabled = running;
    chatterEl.cap.disabled = running;
    chatterEl.auto.textContent = running ? '■ Stop' : '▶ Auto';
    chatterEl.auto.classList.toggle('stop', running);
    chatterEl.auto.title = running ? 'Stop the run, and the reply in progress'
        : 'Let them talk: one side answers the other, back and forth, up to the cap';
    chatterEl.state.textContent = stopping ? 'stopping…'
        : running ? `turn ${round} / ${cap}`
            : ended ? `run ended: ${ended}` : '';
    if (ended && !running) flash(`Chatter ended: ${ended}.`, 6000);
}

// The header collapses the chamber on click; its controls must not.
chatterEl.root.addEventListener('click', e => e.stopPropagation());
chatterEl.step.onclick = () => chatterStep();
chatterEl.auto.onclick = () => chatterAuto();

// ─────────────────────────── the chamber's own controls ───────────────────────────

const RAIL_KEY = 'airlock.chamber.collapsed';

function setChamberCollapsed(collapsed) {
    duetEl.rail.classList.toggle('collapsed', collapsed);
    duetEl.railToggle.title = collapsed ? 'Open the chamber' : 'Collapse the chamber';
    try { localStorage.setItem(RAIL_KEY, collapsed ? '1' : '0'); } catch { /* private window */ }
    if (!collapsed) paintAirlock();
}

if (duetEl.railHead) {
    duetEl.railHead.onclick = () =>
        setChamberCollapsed(!duetEl.rail.classList.contains('collapsed'));

    // Opens by default. Collapsing is a choice you make, not a state you find it in —
    // the chamber being visible is the feature.
    let collapsed = false;
    try { collapsed = localStorage.getItem(RAIL_KEY) === '1'; } catch { /* ignore */ }
    setChamberCollapsed(collapsed);
}

// app.js drives thread selection; this is the only hook it needs.
// app.js calls refreshFiles when the thread's workspace changes under the panes.
window.duetUI = { onThread, state, refreshFiles: () => state.participants.forEach(p => paintFiles(p.id)) };
