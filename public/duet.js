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
 * rail. Classic chat keeps working exactly as it did; this is a second view over the same
 * thread, not a replacement for the first. The fetch wrapper in app.js attaches the access
 * token to every /api call made here, so a hosted instance needs nothing extra.
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
    toggle: $('duetToggle'),
    main: $('main'),
    footer: document.querySelector('.pane > footer')
};

const state = {
    threadId: null,
    enabled: false,
    active: false,          // is the duet view the one on screen
    participants: [],
    messages: [],
    userName: 'User',
    models: [],             // from /api/health, carrying tier
    mobileSlot: 'a'
};

/** Per-pane live wiring. Never conversation data — that lives in state.messages. */
const panes = new Map();    // participantId -> { nodes, controller, status, error, gate, frame }

const viewKey = id => `airlock.duet.view.${id}`;

// ─────────────────────────── filtering ───────────────────────────

/**
 * A packet from before this thread had participants: nobody wrote it as a participant and
 * nobody was addressed. Both the questions and the answers of a plain chat qualify.
 */
const isShared = message => message.authorId == null && message.recipientId == null;

/**
 * What a pane shows: what was said TO this participant, and what it said back.
 *
 * Pre-duet packets appear in BOTH panes. They are the shared past of a thread that was an
 * ordinary chat before it was a duet, and hiding them would make the conversation look
 * like it started midway — in one pane or, worse, in neither.
 */
const visibleTo = (message, participantId) =>
    message.authorId === participantId
    || message.recipientId === participantId
    || isShared(message);

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
        ? gateHtml(message.requestMeta.gate)
        : '';

    const empty = message.streaming ? '<p class="stats">thinking…</p>' : '';
    const body = mine
        ? renderProse(message.content)
        : (message.content ? renderMarkdown(message.content) : (gate || empty));

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
                    message.id ? ` · #${message.id}` : ''}${crossed}${note}${handoff}</span>
                <div class="bubble${message.streaming && message.content ? ' caret' : ''}">${
                    think}${body}</div>
                ${message.stats ? `<span class="stats">${escapeHtml(message.stats)}</span>` : ''}
            </div>`;
}

/** The local gate's ruling, rendered where the answer would have been. */
function gateHtml(gate) {
    const concerns = gate.concerns?.length
        ? `<ul>${gate.concerns.map(c => `<li>${escapeHtml(String(c))}</li>`).join('')}</ul>`
        : '';
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

function paintPane(participantId) {
    const pane = panes.get(participantId);
    if (!pane) return;

    const who = participant(participantId);
    const list = pane.nodes.list;
    const wasPinned = pinned(list);

    const mine = state.messages.filter(m => visibleTo(m, participantId));

    list.innerHTML = mine.length
        ? mine.map(m => messageHtml(m)).join('')
        : `<div class="empty duet-empty">
               <h2>${escapeHtml(who?.name || 'This participant')} hasn't been asked anything yet</h2>
               <p>Whatever you send here goes to ${escapeHtml(who?.name || 'them')} alone —
                  but it is part of the one shared conversation, and the other participant
                  can read it when you next ask them something.</p>
           </div>`;

    wireCopyButtons(list);
    wireHandoff(list);
    paintPaneStatus(participantId);
    if (wasPinned) list.scrollTop = list.scrollHeight;
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
    const text = escapeHtml((message.content || '').replace(/\s+/g, ' ').trim())
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
 * What this does NOT set is DT_PACKET, the in-app move/fork/nest format. movePacket() in
 * db.js reassigns thread_id and nothing else, so a duet message dropped into another thread
 * would keep author_participant_id pointing at a participant of the thread it left — a
 * message attributed to a side that does not exist where it now lives. Until that path
 * clears the duet columns, these drags go outward only.
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

        handle?.addEventListener('dragstart', e => {
            const dt = e.dataTransfer;
            offerAsText(dt, exportText(message, packetId), exportHtml(message, packetId));

            // Shift turns the whole gesture into a FILE drag as far as the OS is concerned,
            // which is why it cannot be on by default: a chat composer then shows a drop
            // target and inserts nothing at all.
            if (e.shiftKey) {
                dt.setData('DownloadURL',
                    `text/markdown:airlock-packet-${packetId}.md:`
                    + `${location.origin}/api/packets/${packetId}/packet.md`);
            }

            // 'copy', not 'copyMove': nothing in this app accepts the drag, so there is no
            // move to permit, and the cursor should say so.
            dt.effectAllowed = 'copy';
            node.classList.add('dragging');

            const preview = node.querySelector('.bubble')?.textContent.trim().slice(0, 46) || '';
            dt.setDragImage(makeDragChip(`<b>#${packetId}</b> ${escapeHtml(preview)}…${
                e.shiftKey ? ' <b>[.md]</b>' : ''}`), 16, 14);

            flash('drop into any text box — the model and the tier travel with it · '
                + 'Shift for .md · ⧉ copy if the target refuses drops', 30000);
        });

        handle?.addEventListener('drag', e => trail(e, e.shiftKey ? 'export' : 'move'));

        handle?.addEventListener('dragend', () => {
            node.classList.remove('dragging');
            clearDragChip();
            clearTrails();
            clearFlash();
        });
    });
}

/**
 * Coalesce repaints to one per animation frame.
 *
 * A model can emit tokens faster than the browser lays out a markdown tree, and a
 * synchronous repaint per token makes the *other* pane janky too — which is exactly the
 * kind of cross-talk this design is supposed to rule out.
 */
function schedulePaint(participantId) {
    const pane = panes.get(participantId);
    if (!pane || pane.frame) return;
    pane.frame = requestAnimationFrame(() => {
        pane.frame = null;
        paintPane(participantId);
        paintAirlock();                       // the chamber is always on screen
    });
}

function paintPaneStatus(participantId) {
    const pane = panes.get(participantId);
    if (!pane) return;

    const { status, error } = pane;
    const busy = status && status !== 'idle';
    const node = pane.nodes.state;

    node.className = 'duet-state' + (error ? ' bad' : busy ? ' busy' : '');
    node.textContent = error ? error
        : status === 'queued' ? `queued · ${pane.queuePosition} ahead`
            : status === 'gating' ? 'gate ruling…'
                : status === 'running' ? 'generating…'
                    : status === 'sending' ? 'sending…'
                        : '';

    pane.nodes.send.textContent = busy ? 'Stop' : 'Send';
    pane.nodes.send.classList.toggle('stop', Boolean(busy));
    pane.nodes.retry.hidden = !pane.retryOf;
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
async function submit(participantId, { retryOf = null } = {}) {
    const pane = panes.get(participantId);
    if (!pane) return;

    if (pane.controller) { pane.controller.abort(); return; }   // button is acting as Stop

    const box = pane.nodes.input;
    const text = box.value.trim();
    if (!retryOf && !text) return;

    pane.error = null;
    pane.retryOf = null;
    pane.status = 'sending';
    pane.queuePosition = 0;
    pane.controller = new AbortController();
    paintPaneStatus(participantId);

    // Cleared optimistically so the composer is usable again immediately; put back if the
    // request never reached the server, so a mis-send is not a lost message.
    if (!retryOf) { box.value = ''; box.style.height = 'auto'; }

    const requestId = pane.requestId ||= newRequestId();
    let streamed = null;   // the reply message id, once the server names it

    try {
        const res = await fetch(`/api/duet/${state.threadId}/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                participantId,
                text: retryOf ? undefined : text,
                clientRequestId: retryOf ? undefined : requestId,
                retryOf
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
            pane.retryOf = pane.triggerId;
        } else {
            pane.error = err.message;
            const message = streamed && messageById(streamed);
            if (message) { message.streaming = false; message.status = 'failed'; }
            // Nothing was sent at all — hand the text back rather than swallowing it.
            if (!streamed && !retryOf && !box.value.trim()) box.value = text;
            pane.retryOf = pane.triggerId;
        }
    } finally {
        // Stopped at the gate, or the stream died there: open up. A no-op if it already ruled.
        releaseDoors(participantId, 'stopped');
        pane.controller = null;
        pane.status = 'idle';
        pane.requestId = null;
        paintPane(participantId);
        paintAirlock();

        // Duet turns are packets like any other, so the tray counts moved.
        loadTree().catch(() => {});
    }
}

/** One NDJSON event from the server. Returns the reply id being streamed, if known. */
function handleEvent(participantId, event, streamed) {
    const pane = panes.get(participantId);

    switch (event.type) {
        case 'user':
            upsert({ ...event.message });
            pane.triggerId = event.message.id;
            schedulePaint(participantId);
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

        case 'blocked':
            upsert({ ...event.message, streaming: false });
            releaseDoors(participantId, 'withheld');
            pane.retryOf = pane.triggerId;
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
            if (usage) countTokens(usage.prompt, usage.reply);
            pane.status = 'idle';
            schedulePaint(participantId);
            return event.message.id;
        }

        case 'cancelled':
            upsert({ ...event.message, streaming: false });
            pane.retryOf = pane.triggerId;
            schedulePaint(participantId);
            return event.message.id;

        case 'error':
            if (event.message) upsert({ ...event.message, streaming: false });
            releaseDoors(participantId, 'failed');
            pane.error = event.error;
            pane.retryOf = pane.triggerId;
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
        </header>

        <div class="duet-role" hidden>
            <textarea class="duet-role-text" rows="2"
                      placeholder="Optional. e.g. &quot;Argue the sceptical case. Be brief.&quot;">${escapeHtml(who.instructions || '')}</textarea>
            <div class="row">
                <span class="hint">Trusted instructions, kept separate from the conversation. Crosses the boundary with it.</span>
                <span class="spacer"></span>
                <button class="icon-btn sm duet-role-save">Save</button>
            </div>
        </div>

        <div class="duet-list"></div>

        <div class="duet-composer">
            <textarea class="duet-input" rows="1"
                      placeholder="Ask ${who.slot === 'a' ? 'left' : 'right'}…  (Enter to send)"></textarea>
            <div class="row">
                <button class="icon-btn sm duet-retry" hidden title="Ask again — the original request is reused, not repeated">↻ retry</button>
                <span class="spacer"></span>
                <button class="send duet-send">Send</button>
            </div>
        </div>`;

    const nodes = {
        node,
        list: node.querySelector('.duet-list'),
        input: node.querySelector('.duet-input'),
        send: node.querySelector('.duet-send'),
        retry: node.querySelector('.duet-retry'),
        state: node.querySelector('.duet-state'),
        tier: node.querySelector('.duet-tier'),
        model: node.querySelector('.duet-model'),
        roleBtn: node.querySelector('.duet-role-btn'),
        role: node.querySelector('.duet-role'),
        roleText: node.querySelector('.duet-role-text'),
        roleSave: node.querySelector('.duet-role-save')
    };

    panes.set(who.id, {
        nodes, controller: null, status: 'idle', error: null,
        queuePosition: 0, retryOf: null, triggerId: null, requestId: null, frame: null
    });

    nodes.send.onclick = () => submit(who.id);
    nodes.retry.onclick = () => {
        const pane = panes.get(who.id);
        if (pane.retryOf) submit(who.id, { retryOf: pane.retryOf });
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

function paintView() {
    duetEl.root.dataset.slot = state.mobileSlot;
    paintTabSelection();
    state.participants.forEach(p => paintPane(p.id));
    paintAirlock();
}

/**
 * Reload the classic single-pane view from the store.
 *
 * app.js fills `messages` once, in selectThread, and duet turns are written after that —
 * so handing the pane back to classic chat without this shows the thread as it was when
 * it was opened, which for a thread that became a duet immediately is an empty list.
 * Reads the same endpoint selectThread does rather than translating duet state, so the
 * classic view stays the store's view and cannot drift into a second rendering of it.
 */
async function refreshClassic() {
    if (!activeThread) return;
    try {
        const packets = await (await fetch(`/api/threads/${activeThread.id}/packets`)).json();
        if (Array.isArray(packets)) {
            messages = flatten(packets);
            render();
            scrollDown();
        }
    } catch { /* the duet view is still correct; leave the classic list as it was */ }
}

/**
 * Re-read the shared conversation from the store, without rebuilding the panes.
 *
 * The mirror of refreshClassic. Classic chat writes packets to the same thread, so a turn
 * sent from the single-pane composer has to appear in the duet view too — it is the same
 * conversation, and a view that quietly omits part of it is exactly what this design is
 * meant to rule out. Panes are left standing so a half-typed message survives the switch.
 */
async function refreshConversation() {
    if (!state.threadId) return;
    try {
        const data = await (await fetch(`/api/duet/${state.threadId}`)).json();
        if (data.error) return;
        state.messages = data.messages;
        state.participants = data.participants;
    } catch { /* keep what we have; the next send will resync */ }
}

/** Show the duet view, or hand the pane back to classic chat. */
function setActive(active) {
    const leavingDuet = state.active && !active;
    const enteringDuet = !state.active && active;
    state.active = active && state.enabled;

    duetEl.root.hidden = !state.active;
    duetEl.main.hidden = state.active;
    if (duetEl.footer) duetEl.footer.hidden = state.active;

    // The sidebar model picker drives the single-pane view, not the panes — each of those
    // has its own. Leaving it on screen in duet mode made it look like "the model" while
    // it controlled neither side. It comes back with the classic view, where it applies.
    if (el.model) el.model.hidden = state.active;

    // Three states, not two: a thread that has never been a duet reads as an invitation,
    // and only one that already has participants can be switched off.
    duetEl.toggle.classList.toggle('on', state.active);
    duetEl.toggle.textContent = !state.enabled ? '⇄ duet'
        : state.active ? '⇄ duet' : '⇄ duet off';
    duetEl.toggle.title = !state.enabled
        ? 'Give this thread two named participants, each with its own pane'
        : state.active ? 'Back to the single-pane view of this same conversation'
            : 'Show both participants again';

    if (state.threadId) {
        localStorage.setItem(viewKey(state.threadId), state.active ? 'duet' : 'classic');
    }
    if (state.active) {
        paintView();
        // Repaint again once the store has answered, so turns sent from the classic
        // composer while the duet view was hidden are not missing from it.
        if (enteringDuet) refreshConversation().then(paintView);
    } else if (leavingDuet) {
        refreshClassic();
    }
}

// ─────────────────────────── lifecycle ───────────────────────────

/**
 * Models come from /api/health, the same source the main dropdown uses, so the duet cannot
 * offer a model the rest of the app does not believe in — and each carries its tier.
 */
async function loadModels() {
    if (state.models.length) return;
    try {
        const h = await (await fetch('/api/health')).json();
        if (Array.isArray(h.models)) state.models = h.models;
    } catch { /* the picker degrades to whatever is already selected */ }
}

function teardown() {
    for (const [, pane] of panes) {
        pane.controller?.abort();
        if (pane.frame) cancelAnimationFrame(pane.frame);
    }
    panes.clear();
    duetEl.grid.innerHTML = '';
    resetDoors();
}

async function loadDuet(threadId) {
    const data = await (await fetch(`/api/duet/${threadId}`)).json();
    if (data.error) throw new Error(data.error);

    state.threadId = threadId;
    state.enabled = data.enabled;
    state.participants = data.participants;
    state.messages = data.messages;
    state.userName = data.userName;

    teardown();
    if (!state.enabled) return;

    await loadModels();
    state.participants.forEach(who => duetEl.grid.appendChild(buildPane(who)));
    state.participants.forEach(who => paintPaneTier(who.id));
    paintTabs();
}

/**
 * The thread changed under us. Every in-flight generation belongs to the thread being
 * left, so they stop — the server settles each as cancelled, and the partial text is
 * already in the log where it can be read later.
 */
async function onThread(thread) {
    teardown();

    if (!thread) {
        state.threadId = null;
        state.enabled = false;
        duetEl.toggle.hidden = true;
        setActive(false);
        return;
    }

    duetEl.toggle.hidden = false;

    try {
        await loadDuet(thread.id);
    } catch (err) {
        flash(err.message, 6000);
        state.enabled = false;
    }

    // A thread that HAS two participants opens as two panes. The view preference is now
    // an opt-OUT, not an opt-in.
    //
    // ⚠ This was backwards, and it made the whole feature invisible. The old rule required
    // localStorage to say 'duet' for this thread IN THIS BROWSER, so a thread with two
    // participants still opened single-pane everywhere it had not been toggled before —
    // a different browser, a fresh profile, the packaged app window rather than a tab.
    // The app looked like it had one chat box and one model picker, and the only way in
    // was a small pill in a crowded lane that gave no hint the thread was already a duet.
    const preference = localStorage.getItem(viewKey(thread.id));
    setActive(state.enabled && preference !== 'classic');
}

duetEl.toggle.onclick = async () => {
    if (!state.threadId) return flash('Pick a thread first — a duet needs somewhere to live.', 5000);

    if (state.enabled) { setActive(!state.active); return; }

    duetEl.toggle.disabled = true;
    try {
        const res = await fetch(`/api/duet/${state.threadId}/enable`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: el.model.value })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        await loadDuet(state.threadId);
        setActive(true);
        flash('Two participants, one conversation. Ask either one.', 6000);
    } catch (err) {
        flash(err.message, 6000);
    } finally {
        duetEl.toggle.disabled = false;
    }
};

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
window.duetUI = { onThread, state };
