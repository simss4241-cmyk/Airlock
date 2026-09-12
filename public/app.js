'use strict';

const $ = id => document.getElementById(id);

const el = {
    messages: $('messages'), main: $('main'), input: $('input'), send: $('send'),
    model: $('model'), dot: $('dot'), statusText: $('statusText'), hint: $('hint'),
    attach: $('attach'), file: $('file'), attached: $('attached'), composer: $('composer'),
    settings: $('settings'), newChat: $('newChat'), openSettings: $('openSettings'),
    sys: $('sys'), temp: $('temp'), topp: $('topp'), topk: $('topk'), ctx: $('ctx'),
    saveSettings: $('saveSettings'), trays: $('trays'), storeStats: $('storeStats'),
    newFolder: $('newFolder'), threadPill: $('threadPill'), threadName: $('threadName'),
    committee: $('committee'), members: $('members'), laneHint: $('laneHint'),
    handoff: $('handoff'), handoffTitle: $('handoffTitle'), handoffMeta: $('handoffMeta'),
    brief: $('brief'), verdict: $('verdict'), signNote: $('signNote'), copyHint: $('copyHint'),
    copyBrief: $('copyBrief'), saveBrief: $('saveBrief'), recordBtn: $('recordHandoff'),
    handoffClose: $('handoffClose'), handoffCancel: $('handoffCancel'),
    thinkToggle: $('thinkToggle'), toolToggle: $('toolToggle'),
    wsRoot: $('wsRoot'), wsBrowse: $('wsBrowse'), wsClear: $('wsClear'), wsHint: $('wsHint'),
    wsThread: $('wsThread'), tokenPill: $('tokenPill')
};

const DT_THREAD = 'application/x-airlock-thread';
const DT_PACKET = 'application/x-airlock-packet';
const DT_TRAY = 'application/x-airlock-tray';
const IDLE_HINT = 'drag a thread up here';

let messages = [];          // {role, content, images?: [dataUrl], stats?, error?}
let pending = [];           // attachments staged for the next message
let config = {};
let controller = null;      // in-flight AbortController
let tree = [];              // trays -> threads
let activeThread = null;    // { id, title } — null means an unsaved scratch chat

// ─────────────────────────── markdown (tiny, dependency-free) ───────────────────────────

const escapeHtml = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function inline(s) {
    return escapeHtml(s)
        .replace(/`([^`]+)`/g, '<code class="inline">$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function renderProse(text) {
    const out = [];
    let list = null;   // 'ul' | 'ol' | null

    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

    for (const raw of text.split('\n')) {
        const line = raw.trimEnd();

        const heading = line.match(/^(#{1,3})\s+(.*)$/);
        const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
        const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);

        if (heading) {
            closeList();
            out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
        } else if (bullet) {
            if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
            out.push(`<li>${inline(bullet[1])}</li>`);
        } else if (numbered) {
            if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
            out.push(`<li>${inline(numbered[1])}</li>`);
        } else if (!line.trim()) {
            closeList();
        } else {
            closeList();
            out.push(`<p>${inline(line)}</p>`);
        }
    }
    closeList();
    return out.join('');
}

// Split on fenced code blocks so prose formatting never touches code.
function renderMarkdown(text) {
    const parts = text.split(/```/);
    let html = '';

    parts.forEach((part, i) => {
        if (i % 2 === 0) {
            html += renderProse(part);
        } else {
            const nl = part.indexOf('\n');
            const lang = nl === -1 ? '' : part.slice(0, nl).trim();
            const code = nl === -1 ? part : part.slice(nl + 1);
            html += `<div class="code"><div class="lang"><span>${escapeHtml(lang || 'code')}</span>`
                 +  `<button class="copy" type="button">copy</button></div>`
                 +  `<pre>${escapeHtml(code.replace(/\n$/, ''))}</pre></div>`;
        }
    });
    return html;
}

// ─────────────────────────── rendering ───────────────────────────

const committeeActors = () =>
    [...document.querySelectorAll('.member')].map(b => b.dataset.actor);

/**
 * Who actually said this. An assistant packet carries the model that produced it, and
 * after a handoff that model is a committee member — so labelling every assistant turn
 * "Airlock" would credit the local tier for a remote model's words.
 */
function speaker(m) {
    if (m.role === 'user') return 'You';
    return m.model || 'Local';
}

/** Provenance, read off the packet — where it was born, who signed it, how deep it sits. */
function badges(m) {
    const out = [];

    if (m.model && committeeActors().includes(m.model)) {
        out.push(`<span class="badge review">oversight verdict</span>`);
    }

    if (m.origin && activeThread && m.origin !== activeThread.title) {
        out.push(`<span class="badge travel">from ${escapeHtml(m.origin)}</span>`);
    }
    if (m.depth > 0) out.push(`<span class="badge">nested</span>`);
    if (m.hops > 0) out.push(`<span class="badge">${m.hops} hop${m.hops > 1 ? 's' : ''}</span>`);

    for (const actor of (m.reviewers || '').split(',').filter(Boolean)) {
        out.push(`<span class="badge review">reviewed by ${escapeHtml(actor)}</span>`);
    }
    return out.length ? `<div class="badges">${out.join('')}</div>` : '';
}

function render() {
    if (!messages.length) {
        el.messages.innerHTML = activeThread
            ? `<div class="empty">
                   <h2>${escapeHtml(activeThread.title)} is empty</h2>
                   <p>Anything you send here is stored as a packet in this thread.</p>
               </div>`
            : `<div class="empty">
                   <h2>Airlock is idle</h2>
                   <p>Answering locally, on your machine. Nothing leaves the desk unless
                   you send it across the boundary.<br>
                   Ask something, or drop an image in — the local model sees.</p>
                   <p class="stats">Pick a thread on the left to save this as packets.</p>
               </div>`;
        return;
    }

    el.messages.innerHTML = messages.map(m => {
        const thumbs = m.images?.length
            ? `<div class="thumbs">${m.images.map(src => `<img src="${src}" alt="attachment">`).join('')}</div>`
            : '';

        // The local model reasons in a separate `thinking` channel before it says anything. On a
        // partially-offloaded 30B that can run the better part of a minute, so it has to be
        // visible — otherwise the UI looks hung. Open while it reasons, folded once it talks.
        const think = m.thinking
            ? `<details class="think"${m.streaming && !m.content ? ' open' : ''}>
                   <summary>reasoning${m.thinkingMs
                       ? ` · ${(m.thinkingMs / 1000).toFixed(1)}s`
                       : (m.streaming ? '…' : '')}</summary>
                   <div class="think-body">${escapeHtml(m.thinking)}</div>
               </details>`
            : '';

        // What the model actually touched on disk, as it happens.
        const toolCards = m.tools?.length
            ? `<div class="tools">${m.tools.map(t => `
                   <div class="tool${t.ok ? '' : ' bad'}">
                       <span class="tool-name">${escapeHtml(t.name)}</span>
                       <span class="tool-sum">${escapeHtml(t.summary)}</span>
                   </div>`).join('')}</div>`
            : '';

        const body = m.role === 'user'
            ? `<div class="bubble">${thumbs}${renderProse(m.content)}</div>`
            : `<div class="bubble${m.error ? ' err' : ''}${m.streaming && m.content ? ' caret' : ''}">${
                  think
              }${toolCards}${
                  m.content ? renderMarkdown(m.content)
                            : (m.thinking ? '' : '<p class="stats">thinking…</p>')
              }</div>`;

        // Only stored packets are draggable — a scratch message has no id to move.
        // draggable lives on the label, NOT the whole message: a draggable ancestor eats
        // mousedown, which made the bubble text impossible to select.
        const drag = m.packetId ? ` data-packet="${m.packetId}"` : '';
        // Nested packets sit indented on a connector rail, so containment is visible.
        const nest = m.depth ? ` data-depth="${m.depth}" style="margin-left:${m.depth * 24}px"` : '';

        return `<div class="msg ${m.role}"${drag}${nest}>
                    <span class="who"${m.packetId ? ' draggable="true"' : ''}>${escapeHtml(speaker(m))}${
                        m.packetId
                            ? ` · #${m.packetId}<span class="grip" aria-hidden="true">⠿ drag</span>`
                            : ''}</span>
                    ${body}
                    ${badges(m)}
                    ${m.stats ? `<span class="stats">${m.stats}</span>` : ''}
                </div>`;
    }).join('');

    el.messages.querySelectorAll('.copy').forEach(btn => {
        btn.onclick = () => {
            navigator.clipboard.writeText(btn.closest('.code').querySelector('pre').textContent);
            btn.textContent = 'copied';
            setTimeout(() => { btn.textContent = 'copy'; }, 1200);
        };
    });

    el.messages.querySelectorAll('[data-packet]').forEach(node => {
        const packetId = +node.dataset.packet;

        const handle = node.querySelector('.who[draggable]');

        handle?.addEventListener('dragstart', e => {
            const dt = e.dataTransfer;
            dt.setData(DT_PACKET, String(packetId));

            // Drop into another model's input box, or any text field, and the thought
            // itself lands as text. A short header so the receiving side has context.
            const msg = messages.find(x => x.packetId === packetId);
            if (msg) {
                const head = [`Airlock packet #${packetId}`];
                if (activeThread) head.push(`thread: ${activeThread.title}`);
                if (msg.origin && msg.origin !== activeThread?.title) head.push(`born in ${msg.origin}`);
                if (msg.reviewers) head.push(`reviewed by ${msg.reviewers}`);
                dt.setData('text/plain', `[${head.join(' · ')}]\n\n${msg.content}`);
            }

            // Shift = export a file instead. DownloadURL turns the whole drag into a FILE
            // drag as far as the OS is concerned, which makes chat inputs show a drop
            // target and then insert nothing — so it must not be on by default.
            if (e.shiftKey) {
                dt.setData('DownloadURL',
                    `text/markdown:airlock-packet-${packetId}.md:`
                    + `${location.origin}/api/packets/${packetId}/packet.md`);
            }

            dt.effectAllowed = 'copyMove';
            draggingPacket = packetId;
            node.classList.add('dragging');

            const mode = dragMode(e, true);
            const tag = mode === 'export' ? ' <b>[.md]</b>' : mode === 'fork' ? ' <b>[fork]</b>' : '';
            const preview = node.querySelector('.bubble')?.textContent.trim().slice(0, 46) || '';
            dt.setDragImage(makeDragChip(
                `<b>#${packetId}</b> ${escapeHtml(preview)}…${tag}`), 16, 14);

            flash('drop on a thread to move · hold Alt to fork · Shift for .md', 30000);
        });

        // Packets can fork, so Alt is live here.
        handle?.addEventListener('drag', e => {
            const mode = dragMode(e, true);
            if (mode === 'fork') announceSplit(node);
            trail(e, mode);
        });

        handle?.addEventListener('dragend', () => {
            node.classList.remove('dragging');
            draggingPacket = null;
            clearDragChip();
            clearTrails();
            flash(IDLE_HINT, 1);
            el.messages.querySelectorAll('.nest-target')
                .forEach(n => n.classList.remove('nest-target'));
        });

        // Drop a packet onto a packet to nest it — a thread is a container, not a log.
        node.addEventListener('dragover', e => {
            if (!e.dataTransfer.types.includes(DT_PACKET)) return;
            if (draggingPacket === packetId) return;          // no self-nesting
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            node.classList.add('nest-target');
        });

        node.addEventListener('dragleave', e => {
            if (!node.contains(e.relatedTarget)) node.classList.remove('nest-target');
        });

        node.addEventListener('drop', async e => {
            if (!e.dataTransfer.types.includes(DT_PACKET)) return;
            e.preventDefault();
            e.stopPropagation();
            node.classList.remove('nest-target');

            const childId = +e.dataTransfer.getData(DT_PACKET);
            if (childId === packetId) return;

            const source = el.messages.querySelector(`[data-packet="${childId}"]`);
            comet(source, node);

            const res = await json(`/api/packets/${childId}/move`, { parentId: packetId });
            if (res.error) return flash(res.error, 6000);

            if (activeThread) await selectThread(activeThread.id, activeThread.title);
            flash(`Nested #${childId} inside #${packetId}`);
        });
    });
}

let flashTimer;

/** Transient status in the lane — cheaper than a toast system, and it reads in place. */
function flash(msg, ms = 4000) {
    el.laneHint.textContent = msg;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { el.laneHint.textContent = IDLE_HINT; }, ms);
}

function scrollDown() {
    el.main.scrollTop = el.main.scrollHeight;
    // keep the reasoning pane pinned to its newest line while it streams
    const think = [...el.messages.querySelectorAll('.think[open] .think-body')].pop();
    if (think) think.scrollTop = think.scrollHeight;
}

// ─────────────────────────── health / models ───────────────────────────

async function refreshHealth() {
    try {
        const h = await (await fetch('/api/health')).json();

        if (!h.ollama) {
            el.dot.className = 'dot bad';
            el.statusText.textContent = 'Ollama offline';
            el.model.innerHTML = '<option>—</option>';
            return;
        }

        const saved = localStorage.getItem('airlock.model');
        const wanted = saved || h.activeModel;

        modelCaps = Object.fromEntries(h.models.map(m => [m.name, m.caps || []]));

        el.model.innerHTML = h.models
            .map(m => {
                const badges = [
                    m.caps?.includes('thinking') ? '◈' : '',
                    m.caps?.includes('vision') ? '👁' : '',
                    m.caps?.includes('tools') ? '⛁' : ''
                ].filter(Boolean).join('');
                return `<option value="${m.name}">${m.name}  (${(m.size / 1e9).toFixed(1)} GB)`
                     + `${badges ? '  ' + badges : ''}</option>`;
            })
            .join('');

        if (h.models.some(m => m.name === wanted)) {
            el.model.value = wanted;
        } else if (h.models.length) {
            el.model.value = h.models[0].name;
        }

        if (h.localModelInstalled) {
            el.dot.className = 'dot ok';
            el.statusText.textContent = `Ollama ${h.version || ''}`.trim();
        } else {
            el.dot.className = 'dot warn';
            el.statusText.textContent = 'Local model not pulled';
            el.statusText.title = 'ollama pull muse-glimmer:30b-q4_K_M returns 412 on Windows/NVIDIA — '
                + 'Ollama gates Muse Glimmer to Apple Silicon / MLX for now. Any other model here works.';
        }

        // capabilities just changed shape, so the pills have to agree with the selection
        paintThinkToggle();
        paintWorkspace();
    } catch {
        el.dot.className = 'dot bad';
        el.statusText.textContent = 'server offline';
    }
}

async function loadConfig() {
    config = await (await fetch('/api/config')).json();
    el.sys.value = config.systemPrompt ?? '';
    el.temp.value = config.temperature;
    el.topp.value = config.top_p;
    el.topk.value = config.top_k;
    el.ctx.value = config.num_ctx;
    paintThinkToggle();
}

let modelCaps = {};   // name -> capability list, from /api/health

const selectedCaps = () => modelCaps[el.model.value] || [];

function paintThinkToggle() {
    // A model without a thinking channel can't reason no matter what config says —
    // pretending otherwise is how "does not support thinking" errors reach the user.
    const supported = selectedCaps().includes('thinking');
    const on = supported && config.think !== false;

    el.thinkToggle.classList.toggle('on', on);
    el.thinkToggle.disabled = !supported;
    el.thinkToggle.textContent = !supported ? '◇ no reasoning'
        : on ? '◈ reasoning' : '◇ reasoning off';
    el.thinkToggle.title = !supported
        ? `${el.model.value} has no reasoning channel — this model answers directly`
        : 'The local model\'s reasoning channel. Off is ~3.7x faster on this hardware.';
}

el.thinkToggle.onclick = async () => {
    config = await json('/api/config', { think: config.think === false }, 'POST');
    paintThinkToggle();
    flash(config.think === false
        ? 'Reasoning off — faster, but the model answers straight from the hip'
        : 'Reasoning on — slower, but it thinks first', 5000);
};

// ─────────────────────────── token counter ───────────────────────────
// Running total of everything this install has spent — prompt and generated, across every
// thread and scratch chat, surviving reloads. Ollama reports real counts per call, so the
// tool rounds behind an answer are included here even though the per-reply stats line
// under each message only ever showed the final round.

let tokens = { prompt: 0, reply: 0, turns: 0 };

// 900 · 4.2k · 128k · 1.4M — narrow enough to sit beside the Ollama version.
const compactTokens = n =>
    n < 1000 ? String(n)
        : n < 10000 ? (n / 1000).toFixed(1) + 'k'
            : n < 1e6 ? Math.round(n / 1000) + 'k'
                : (n / 1e6).toFixed(1) + 'M';

function paintTokens() {
    const total = tokens.prompt + tokens.reply;
    el.tokenPill.textContent = `Σ ${compactTokens(total)}`;
    el.tokenPill.title = total
        ? `${total.toLocaleString()} tokens over ${tokens.turns} `
            + `${tokens.turns === 1 ? 'reply' : 'replies'}\n`
            + `${tokens.prompt.toLocaleString()} prompt · `
            + `${tokens.reply.toLocaleString()} generated\n\nClick to reset.`
        : 'Total tokens spent. Nothing counted yet.';
}

function loadTokens() {
    try {
        const saved = JSON.parse(localStorage.getItem('airlock.tokens') || 'null');
        if (saved) tokens = {
            prompt: saved.prompt | 0, reply: saved.reply | 0, turns: saved.turns | 0
        };
    } catch { /* unreadable entry — start the count over rather than dying on load */ }
    paintTokens();
}

function countTokens(prompt, reply) {
    if (!prompt && !reply) return;
    tokens.prompt += prompt || 0;
    tokens.reply += reply || 0;
    tokens.turns++;
    localStorage.setItem('airlock.tokens', JSON.stringify(tokens));
    paintTokens();
}

el.tokenPill.onclick = () => {
    const total = tokens.prompt + tokens.reply;
    if (!total) return;
    if (!confirm(`Reset the token counter?\n\n${total.toLocaleString()} tokens `
        + `over ${tokens.turns} ${tokens.turns === 1 ? 'reply' : 'replies'}.`)) return;

    tokens = { prompt: 0, reply: 0, turns: 0 };
    localStorage.removeItem('airlock.tokens');
    paintTokens();
    flash('Token counter reset', 4000);
};

// ─────────────────────────── workspace ───────────────────────────

let workspace = { threadId: null, threadTitle: null, root: null, exists: false };
let wsBrowsing = false;

// Sticky notice — errors have to survive the 15s health refresh, which repaints these pills
// and would otherwise wipe "not a usable folder" and replace it with the happy text.
let wsNotice = '';

function paintWorkspace() {
    const canTool = selectedCaps().includes('tools');
    const hasThread = !!activeThread;

    // A root whose folder has gone is not file access, so don't paint it as armed. The
    // server won't offer tools for it either — otherwise every call fails and a confused
    // model burns the whole round budget at 8 tok/s discovering that.
    const broken = !!workspace.root && !workspace.exists;
    const armed = canTool && hasThread && !!workspace.root && !broken;

    el.toolToggle.classList.toggle('on', armed);
    el.toolToggle.disabled = !canTool;
    el.toolToggle.textContent = !canTool ? '⛁ no tools'
        : armed ? '⛁ files'
            : broken ? '⛁ files missing' : '⛁ files off';
    el.toolToggle.title = !canTool
        ? `${el.model.value} can't call tools — attach files by hand with 📎 instead`
        : !hasThread
            ? 'Pick a thread before assigning a workspace'
            : broken
                ? `${workspace.root} no longer exists — click to pick a new one`
                : workspace.root
                    ? `${activeThread.title} may read files under ${workspace.root} — click to change it`
                    : `No workspace for ${activeThread.title} — click to choose one`;

    el.wsThread.textContent = activeThread?.title || 'No thread selected';
    el.wsRoot.disabled = !hasThread;
    el.wsBrowse.disabled = !hasThread || wsBrowsing;
    el.wsClear.disabled = !hasThread || !workspace.root || wsBrowsing;

    // Don't fight the user's typing — only overwrite the box when it isn't focused.
    if (document.activeElement !== el.wsRoot) el.wsRoot.value = workspace.root || '';

    el.wsHint.textContent = wsNotice || (!hasThread ? 'Choose a thread from the left first.'
        : !workspace.root ? 'No file access for this thread.'
            : workspace.exists ? 'Read-only, confined to this folder.'
                : 'This folder no longer exists.');
}

async function loadWorkspace(threadId = activeThread?.id) {
    if (!threadId) {
        workspace = { threadId: null, threadTitle: null, root: null, exists: false };
        wsNotice = '';
        paintWorkspace();
        return;
    }

    const requestedId = Number(threadId);
    const next = await (await fetch(`/api/workspace?threadId=${requestedId}`)).json();
    if (activeThread?.id !== requestedId) return;
    if (next.error) return notice(next.error);
    workspace = next;
    wsNotice = '';
    paintWorkspace();
}

function openWorkspaceSettings() {
    if (!el.settings.open) el.settings.showModal();
    paintWorkspace();
    if (activeThread) setTimeout(() => el.wsRoot.focus(), 0);
}

// The pill is a doorway to the current thread's workspace, not a global on/off switch.
el.toolToggle.onclick = () => openWorkspaceSettings();

const notice = msg => { wsNotice = msg; paintWorkspace(); };

async function applyWorkspace(root) {
    if (!activeThread) { notice('Pick a thread before choosing a workspace.'); return false; }

    const res = await json('/api/workspace', { threadId: activeThread.id, root });
    if (res.error) { notice(res.error); return false; }

    // `workspace` is the only reader of the current root — mirroring it onto activeThread
    // and the tree looked tidy but nothing ever read those copies, and selectThread rebuilds
    // activeThread from scratch anyway, so they were guaranteed-stale dead weight.
    workspace = res;
    wsNotice = '';
    paintWorkspace();
    flash(`Workspace for ${activeThread.title} set to ${workspace.root}`, 6000);
    return true;
}

el.wsBrowse.onclick = async () => {
    if (!activeThread) return notice('Pick a thread before browsing.');

    wsBrowsing = true;
    notice('Folder picker open — it should be in front of this window…');
    try {
        const picked = await (await fetch(`/api/workspace/browse?threadId=${activeThread.id}`)).json();

        // Previously this branch swallowed picked.error, so a failing picker looked
        // identical to a cancelled one: nothing happened, no explanation.
        if (picked.error) return notice(picked.error);
        if (!picked.path) return notice('Cancelled — nothing changed.');

        await applyWorkspace(picked.path);
    } catch (err) {
        notice(`Picker unreachable: ${err.message}. Paste a path in the box instead.`);
    } finally {
        wsBrowsing = false;
        paintWorkspace();
    }
};

// Typed or pasted path — a fallback that doesn't depend on a dialog behaving.
el.wsRoot.addEventListener('keydown', async e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const typed = el.wsRoot.value.trim();
    if (!typed) return;
    notice('Checking…');
    await applyWorkspace(typed);
});

el.wsClear.onclick = async () => {
    if (!activeThread) return;
    const title = activeThread.title;
    const cleared = await json('/api/workspace', { threadId: activeThread.id, root: null });
    if (cleared.error) return notice(cleared.error);
    workspace = cleared;
    wsNotice = '';
    el.wsRoot.value = '';
    paintWorkspace();
    flash(`Workspace cleared — ${title} has no file access`, 5000);
};

// ─────────────────────────── trays / threads / packets ───────────────────────────

const json = (route, body, method = 'POST') => fetch(route, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
}).then(r => r.json());

const slug = s => s.replace(/[^a-z0-9]+/gi, '-').toLowerCase();

/**
 * Threads render as divs, not buttons: a button's content model forbids interactive
 * descendants, and each row carries a delete control plus an inline rename input.
 */
function renderRail() {
    el.trays.innerHTML = tree.map(f => `
        <div class="tray" data-tray="${f.id}">
            <div class="tray-name" draggable="true" title="Drag to reorder trays">
                <span class="title" data-rename-folder="${f.id}" title="Double-click to rename">${escapeHtml(f.name)}</span>
                <span>
                    <button class="icon-btn sm" data-folder="${f.id}" title="New thread in ${escapeHtml(f.name)}">＋</button>
                    <span class="row-x" data-del-folder="${f.id}" data-name="${escapeHtml(f.name)}"
                          role="button" tabindex="0" title="Delete this tray">✕</span>
                </span>
            </div>
            ${f.threads.map(t => `
                <div class="thread${activeThread?.id === t.id ? ' active' : ''}" role="button" tabindex="0"
                     data-thread="${t.id}" data-title="${escapeHtml(t.title)}">
                    <span class="title" data-rename-thread="${t.id}" title="Double-click to rename">${escapeHtml(t.title)}</span>
                    <span class="count">${t.packet_count}</span>
                    <span class="row-x" data-del-thread="${t.id}" data-name="${escapeHtml(t.title)}"
                          role="button" tabindex="0" title="Delete this thread">✕</span>
                </div>`).join('')}
            <div class="tray-tail${f.threads.length ? '' : ' vacant'}">${
                f.threads.length ? '' : 'empty — drop a thread here'}</div>
        </div>`).join('');

    el.trays.querySelectorAll('[data-thread]').forEach(node => {
        node.addEventListener('click', e => {
            if (e.target.closest('.row-x')) return;
            selectThread(+node.dataset.thread, node.dataset.title);
        });
        node.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                selectThread(+node.dataset.thread, node.dataset.title);
            }
        });
        node.addEventListener('pointerenter', () => warmBrief(+node.dataset.thread));
        wireThreadDnd(node);
    });

    el.trays.querySelectorAll('[data-folder]').forEach(b => {
        b.onclick = async () => {
            const title = prompt('New thread name:');
            if (!title?.trim()) return;
            await json('/api/threads', { folderId: +b.dataset.folder, title: title.trim() });
            await loadTree();
        };
    });

    // trays accept threads — this is how you re-file one
    el.trays.querySelectorAll('[data-tray]').forEach(tray => wireTrayDnd(tray));

    // ── delete ──
    const onActivate = (node, fn) => {
        node.addEventListener('click', e => { e.stopPropagation(); fn(); });
        node.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); fn(); }
        });
    };

    el.trays.querySelectorAll('[data-del-thread]').forEach(x => onActivate(x, async () => {
        const id = +x.dataset.delThread;
        const name = x.dataset.name;
        const count = +x.closest('.thread').querySelector('.count').textContent || 0;
        const warn = count
            ? `Delete thread "${name}" and its ${count} packet(s)? This cannot be undone.`
            : `Delete empty thread "${name}"?`;
        if (!confirm(warn)) return;

        await fetch(`/api/threads/${id}`, { method: 'DELETE' });
        if (activeThread?.id === id) { leaveThread(); messages = []; render(); }
        await loadTree();
        flash(`Deleted thread "${name}"`);
    }));

    el.trays.querySelectorAll('[data-del-folder]').forEach(x => onActivate(x, async () => {
        const id = +x.dataset.delFolder;
        const name = x.dataset.name;
        const threads = tree.find(f => f.id === id)?.threads ?? [];
        const packets = threads.reduce((n, t) => n + t.packet_count, 0);

        if (!confirm(`Delete tray "${name}"?\n\nThis also deletes ${threads.length} thread(s) `
            + `and ${packets} packet(s). This cannot be undone.`)) return;

        await fetch(`/api/folders/${id}`, { method: 'DELETE' });
        if (threads.some(t => t.id === activeThread?.id)) { leaveThread(); messages = []; render(); }
        await loadTree();
        flash(`Deleted tray "${name}"`);
    }));

    // ── rename ──
    el.trays.querySelectorAll('[data-rename-thread]').forEach(span =>
        span.addEventListener('dblclick', e => {
            e.stopPropagation();
            beginRename(span, 'thread', +span.dataset.renameThread);
        }));

    el.trays.querySelectorAll('[data-rename-folder]').forEach(span =>
        span.addEventListener('dblclick', e => {
            e.stopPropagation();
            beginRename(span, 'folder', +span.dataset.renameFolder);
        }));
}

/** Swap a label for an input in place. Enter commits, Escape reverts, blur commits. */
function beginRename(span, kind, id) {
    const current = span.textContent;

    // The input sits inside a draggable row/header, and a draggable ancestor swallows
    // mousedown — you'd drag the row instead of selecting text. Suspend it while editing.
    let host = span.parentElement;
    while (host && !host.draggable) host = host.parentElement;
    if (host) host.draggable = false;

    const input = document.createElement('input');
    input.className = 'rename-input';
    input.value = current;
    span.replaceWith(input);
    input.focus();
    input.select();

    let settled = false;
    const finish = async commit => {
        if (settled) return;
        settled = true;
        if (host) host.draggable = true;

        const value = input.value.trim();
        if (commit && value && value !== current) {
            const res = await json(
                kind === 'thread' ? `/api/threads/${id}` : `/api/folders/${id}`,
                kind === 'thread' ? { title: value } : { name: value },
                'PATCH'
            );
            if (res.error) flash(res.error, 6000);
            else if (kind === 'thread' && activeThread?.id === id) {
                activeThread.title = value;
                el.threadName.textContent = value;
            }
        }
        await loadTree();
    };

    input.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', e => e.stopPropagation());
}

async function loadTree() {
    tree = await (await fetch('/api/tree')).json();
    briefCache.clear();     // packet counts changed, so any cached brief is stale
    renderRail();
    const s = await (await fetch('/api/stats')).json();
    el.storeStats.textContent = `${s.packets} packets · ${s.nested} nested · ${s.forks} forks · ${s.reviews} reviews`;
}

/** Depth-first flatten — a nesting tree read as a transcript, depth kept for the badge. */
function flatten(nodes, depth = 0, out = []) {
    for (const p of nodes) {
        out.push({
            role: p.role, content: p.content, images: p.images || [],
            packetId: p.id, depth, model: p.model,
            origin: p.origin_thread_title, reviewers: p.reviewers, hops: p.hops
        });
        if (p.children?.length) flatten(p.children, depth + 1, out);
    }
    return out;
}

async function selectThread(id, title) {
    if (controller) controller.abort();

    activeThread = { id, title };
    wsNotice = '';
    localStorage.setItem('airlock.thread', String(id));
    el.threadName.textContent = title;
    el.threadPill.hidden = false;

    const [packets] = await Promise.all([
        fetch(`/api/threads/${id}/packets`).then(response => response.json()),
        loadWorkspace(id)
    ]);
    messages = flatten(packets);

    // loadTree, not renderRail: packets can move underneath us (another window, an
    // agent, a curl), so re-read the counts rather than repainting stale ones.
    await loadTree();
    render();
    scrollDown();
}

function leaveThread() {
    activeThread = null;
    workspace = { threadId: null, threadTitle: null, root: null, exists: false };
    wsNotice = '';
    localStorage.removeItem('airlock.thread');
    el.threadPill.hidden = true;
    paintWorkspace();
    renderRail();
}

/** Persist one turn as a packet. No-op when no thread is selected. */
async function persist(role, content, images = []) {
    if (!activeThread || !content) return null;
    try {
        const p = await json('/api/packets', {
            threadId: activeThread.id, role, content,
            model: role === 'assistant' ? el.model.value : null,
            images
        });
        return p.id ?? null;
    } catch {
        return null;   // a store hiccup must never eat the reply the user just got
    }
}

// ─────────────────────────── physics ───────────────────────────
// Motion is decoration over operations that already work — every animation here runs
// *before* the refetch and none of them gate the result, so a janky frame or a
// prefers-reduced-motion user never changes what actually got stored.

const briefCache = new Map();
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// dragover can't read dataTransfer's payload, so track what's in flight here
let draggingPacket = null;
let draggingThread = null;
let draggingTray = null;
let dragChip = null;

const clearInsertMarks = () => el.trays.querySelectorAll('.insert-above, .insert-below')
    .forEach(n => n.classList.remove('insert-above', 'insert-below'));

const centreOf = node => {
    const r = node.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, rect: r };
};

// ── cursor trails ──
// Colour is the affordance: you can see what a drop will do before you let go.
const TRAIL = {
    move:   ['#a855f7', '#6d28d9'],   // purple — packet leaves, lands there
    fork:   ['#2dd4bf', '#115e59'],   // teal   — copy, keeps a tether to the original
    export: ['#fbbf24', '#b45309']    // amber  — leaving the app as a .md file
};

const MAX_TRAIL = 36;        // hard cap; streaks overlap more than dots did

// A Set, not a counter. With a counter, clearTrails() zeroes it while already-swept
// particles still have cleanup callbacks pending — those then decrement past zero and the
// cap quietly stops working (observed: 62 live particles against a cap of 44).
// Set.delete() returning false makes every teardown idempotent instead.
const liveDots = new Set();
const TRAIL_SPACING = 13;    // px of travel between wisps — spacing by distance, not time

let trailPrev = null;        // last raw cursor point
let trailVel = null;         // smoothed velocity; raw deltas make the angle snap around
let trailAccum = 0;          // path distance banked since the last wisp

/** What a drop would do right now, read from the live modifier state. */
const dragMode = (e, canFork) =>
    e.shiftKey ? 'export' : (canFork && e.altKey ? 'fork' : 'move');

function trail(e, mode) {
    if (reducedMotion() || liveDots.size >= MAX_TRAIL) return;

    // Chromium reports 0,0 on the final drag event and occasionally mid-gesture.
    const x = e.clientX, y = e.clientY;
    if (!x && !y) return;

    // A wisp needs a direction, so it takes two points to draw one.
    const prev = trailPrev;
    trailPrev = { x, y };
    if (!prev) return;

    const dx = x - prev.x, dy = y - prev.y;
    const step = Math.hypot(dx, dy);

    if (step === 0) return;
    // A huge jump means a new gesture (or a tab switch); reset rather than streak across.
    if (step > 260) { trailVel = null; trailAccum = 0; return; }

    // Exponential moving average of velocity. Aiming a wisp with the raw last delta is
    // what made them look like shards: a 2px pointer wobble swings the angle 40 degrees.
    // Smoothing the direction is most of the fix.
    const K = 0.3;
    trailVel = trailVel
        ? { x: trailVel.x + (dx - trailVel.x) * K, y: trailVel.y + (dy - trailVel.y) * K }
        : { x: dx, y: dy };

    // Emit per distance travelled, not per event. Event timing is irregular, so
    // time-throttling scattered them unevenly; banking distance spaces them along the path.
    trailAccum += step;
    if (trailAccum < TRAIL_SPACING) return;
    trailAccum = 0;

    const speed = Math.hypot(trailVel.x, trailVel.y);
    const angle = Math.atan2(trailVel.y, trailVel.x) * 180 / Math.PI;

    // Both dimensions follow smoothed speed, so consecutive wisps are near-identical
    // instead of randomly sized. The tiny jitter is texture, not noise.
    const length = 20 + Math.min(88, speed * 3.4) + Math.random() * 4;
    const thick = 5 + Math.min(5, speed * 0.22) + Math.random();

    // Sit on the path just travelled rather than at the leading sample point.
    const px = x - dx * 0.5, py = y - dy * 0.5;

    const [a, b] = TRAIL[mode] || TRAIL.move;

    const dot = document.createElement('div');
    dot.className = 'trail';
    dot.style.cssText = `left:${px.toFixed(1)}px;top:${py.toFixed(1)}px;width:${length.toFixed(1)}px;`
        + `height:${thick.toFixed(1)}px;`
        // soft at both ends so it reads as vapour, not a painted line
        + `background:linear-gradient(90deg, transparent 0%, ${b} 22%, ${a} 55%, `
        + `${a} 68%, transparent 100%);`;
    document.body.appendChild(dot);
    liveDots.add(dot);

    // Fade in stretched, drift onward, thin out and dissolve. No random jitter — jitter
    // reads as sparks; this should read as something passing through.
    // Drift along the smoothed heading too — using the raw step made neighbouring wisps
    // fly off at slightly different angles from each other.
    const base = `translate(-50%, -50%) rotate(${angle.toFixed(1)}deg)`;
    const drift = `translate(calc(-50% + ${(trailVel.x * 1.4).toFixed(1)}px), `
                + `calc(-50% + ${(trailVel.y * 1.4).toFixed(1)}px)) rotate(${angle.toFixed(1)}deg)`;

    const anim = dot.animate([
        { transform: `${base} scaleX(.55) scaleY(1)`, opacity: 0 },
        { transform: `${base} scaleX(1) scaleY(1)`, opacity: .6, offset: .22 },
        { transform: `${drift} scaleX(1.6) scaleY(.35)`, opacity: 0 }
    ], { duration: 760 + Math.random() * 380, easing: 'cubic-bezier(.22,.61,.36,1)' });

    // Same rule as every animation here: cleaned up by a wall clock, never by a frame.
    // delete() returns false if it was already swept, so this can't double-count.
    const drop = () => { if (liveDots.delete(dot)) dot.remove(); };
    Promise.race([
        anim.finished.catch(() => {}),
        new Promise(r => setTimeout(r, 1400))
    ]).then(drop, drop);
}

/** Sweep stragglers when a gesture ends, and forget the whole motion state. */
function clearTrails() {
    liveDots.forEach(d => d.remove());
    liveDots.clear();
    trailPrev = null;
    trailVel = null;
    trailAccum = 0;
    forkAnnounced = false;
}

/**
 * Guaranteed teardown for a decorative node.
 *
 * `anim.finished` only settles while the document is actually compositing frames — a
 * hidden tab, a backgrounded PWA window, or a throttled renderer leaves it pending
 * forever. So race it against a wall-clock timeout: the element always gets removed,
 * and no caller can be left waiting on a frame that never comes.
 */
function cleanupAfter(node, anim, ms) {
    const remove = () => node.remove();
    Promise.race([
        anim.finished.catch(() => {}),
        new Promise(r => setTimeout(r, ms))
    ]).then(remove, remove);
}

/**
 * The streak a packet leaves crossing the screen — Lumi's ghost trail.
 *
 * Returns nothing on purpose. Callers must not await it: decoration never gates a
 * store write.
 */
function comet(from, to, { fork = false } = {}) {
    if (reducedMotion() || !from || !to) return;

    const a = centreOf(from), b = centreOf(to);
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 6) return;

    const node = document.createElement('div');
    node.className = 'comet';
    node.style.left = `${a.x}px`;
    node.style.top = `${a.y}px`;
    node.style.width = `${Math.min(110, Math.max(30, dist * 0.4))}px`;
    node.style.transformOrigin = 'left center';
    if (fork) node.style.background = 'linear-gradient(90deg, transparent, #2dd4bf)';
    document.body.appendChild(node);

    const deg = Math.atan2(dy, dx) * 180 / Math.PI;
    const anim = node.animate([
        { transform: `rotate(${deg}deg) translateX(0) scaleX(.4)`, opacity: 0 },
        { transform: `rotate(${deg}deg) translateX(${dist * .4}px) scaleX(1)`, opacity: 1, offset: .4 },
        { transform: `rotate(${deg}deg) translateX(${dist}px) scaleX(.3)`, opacity: 0 }
    ], { duration: 440, easing: 'cubic-bezier(.4,0,.5,1)' });

    cleanupAfter(node, anim, 900);
}

let forkAnnounced = false;   // one split per gesture, reset by clearTrails()

/**
 * The moment of separation: fires when Alt engages, so you see the copy tear away from
 * the original as you pull, rather than finding out at the drop. Once per gesture.
 */
function announceSplit(node) {
    if (forkAnnounced || reducedMotion() || !node) return;
    forkAnnounced = true;

    const bubble = node.querySelector('.bubble');
    if (!bubble) return;

    const r = bubble.getBoundingClientRect();
    const ghost = document.createElement('div');
    ghost.className = 'clone';
    Object.assign(ghost.style, {
        left: `${r.left}px`, top: `${r.top}px`,
        width: `${r.width}px`, height: `${Math.min(r.height, 150)}px`
    });
    document.body.appendChild(ghost);

    node.classList.add('splitting');

    // Swells, tears loose, drifts off the parent. The original stays put — that's the
    // whole point of a fork, and the animation should say so.
    const anim = ghost.animate([
        { transform: 'translate(0, 0) scale(1)', opacity: .8 },
        { transform: 'translate(3px, -3px) scale(1.02)', opacity: .7, offset: .3 },
        { transform: 'translate(30px, -20px) scale(.9)', opacity: 0 }
    ], { duration: 660, easing: 'cubic-bezier(.32,.72,.3,1)' });

    cleanupAfter(ghost, anim, 1100);
    setTimeout(() => node.classList.remove('splitting'), 700);
}

/**
 * Fork: the packet divides, and the copy peels off toward its new home.
 * Also fire-and-forget — see comet().
 */
function mitosis(sourceMsg, to) {
    if (reducedMotion() || !sourceMsg || !to) return;

    const bubble = sourceMsg.querySelector('.bubble');
    if (!bubble) return;

    sourceMsg.classList.add('splitting');

    const r = bubble.getBoundingClientRect();
    const clone = document.createElement('div');
    clone.className = 'clone';
    Object.assign(clone.style, {
        left: `${r.left}px`, top: `${r.top}px`,
        width: `${r.width}px`, height: `${Math.min(r.height, 160)}px`
    });
    document.body.appendChild(clone);

    const b = centreOf(to);
    const anim = clone.animate([
        { transform: 'translate(0,0) scale(1) rotate(0deg)', opacity: .95 },
        { transform: `translate(6px,-10px) scale(.96) rotate(-3deg)`, opacity: .9, offset: .28 },
        { transform: `translate(${b.x - r.left - r.width / 2}px, ${b.y - r.top - 20}px) `
                   + `scale(.06) rotate(-10deg)`, opacity: .15 }
    ], { duration: 580, easing: 'cubic-bezier(.45,0,.55,1)' });

    cleanupAfter(clone, anim, 1100);
    // the class must come off on the same guarantee, or the bubble stays lit forever
    setTimeout(() => sourceMsg.classList.remove('splitting'), 620);
}

/** The receiving element takes the weight. */
function settleNode(node) {
    if (!node || reducedMotion()) return;
    node.classList.remove('arrived');
    void node.offsetWidth;                      // force a reflow so it replays
    node.classList.add('arrived');
    setTimeout(() => node.classList.remove('arrived'), 520);
}

const settle = threadId => settleNode(el.trays.querySelector(`[data-thread="${threadId}"]`));
const settleTray = folderId => settleNode(el.trays.querySelector(`[data-tray="${folderId}"]`));

function makeDragChip(html) {
    dragChip?.remove();
    dragChip = document.createElement('div');
    dragChip.className = 'drag-chip';
    dragChip.innerHTML = html;
    document.body.appendChild(dragChip);
    return dragChip;
}

const clearDragChip = () => { dragChip?.remove(); dragChip = null; };

/** Pre-render a thread's brief so dragstart — which cannot await — has text ready. */
async function warmBrief(threadId) {
    if (briefCache.has(threadId)) return;
    briefCache.set(threadId, null);             // in-flight marker
    try {
        const b = await (await fetch(`/api/threads/${threadId}/brief`)).json();
        if (b.markdown) briefCache.set(threadId, b.markdown);
    } catch {
        briefCache.delete(threadId);
    }
}

// ─────────────────── drag & drop: threads out, packets across ───────────────────

/**
 * A thread is the draggable unit for oversight and for export; a packet is the draggable
 * unit for reorganising. Each thread row is therefore a drag *source* (committee lane,
 * the desktop, another app) and a drop *target* (packets landing in it).
 */
function wireThreadDnd(row) {
    const threadId = +row.dataset.thread;
    const title = row.dataset.title;

    row.draggable = true;

    row.addEventListener('dragstart', e => {
        const dt = e.dataTransfer;

        dt.setData(DT_THREAD, String(threadId));

        // Drop into a text field or another model's chat box → pastes the brief.
        dt.setData('text/plain', briefCache.get(threadId)
            || `Airlock thread "${title}" — open ${location.origin} to read it.`);

        // Shift = export a file instead. Setting DownloadURL makes the OS treat this as a
        // FILE drag, which outranks the text — a chat input then shows a drop target and
        // inserts nothing. So it's opt-in, not always-on. Format is strict:
        // mime:filename:absolute-url
        if (e.shiftKey) {
            dt.setData('DownloadURL',
                `text/markdown:airlock-${slug(title)}.md:`
                + `${location.origin}/api/threads/${threadId}/brief.md`);
        }

        // MUST be copyMove, not copy. A tray/reorder drop sets dropEffect 'move', and the
        // drag model forces dropEffect to 'none' when it isn't permitted by effectAllowed —
        // so 'copy' alone silently makes every in-app thread drop illegal (no-entry cursor,
        // no drop event). 'copy' is still what the desktop/DownloadURL drag uses.
        dt.effectAllowed = 'copyMove';
        dt.setDragImage(makeDragChip(
            `<b>❖</b> ${escapeHtml(title)} ${e.shiftKey ? '<b>[.md]</b>' : '<b>→</b>'}`), 16, 14);

        draggingThread = threadId;
        row.classList.add('dragging');
        document.body.classList.add('dragging-thread');   // opens every tray's landing strip
        el.committee.classList.add('armed');
        flash(e.shiftKey
            ? `"${title}" as .md — drop on your desktop or a folder`
            : `"${title}" — drop on a member, a tray, or any text box (Shift-drag for .md)`, 30000);
    });

    // Threads don't fork — only move or export — so Alt is inert here.
    row.addEventListener('drag', e => trail(e, dragMode(e, false)));

    row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        el.committee.classList.remove('armed');
        clearDragChip();
        clearTrails();
        clearInsertMarks();
        el.trays.querySelectorAll('.drop-target').forEach(n => n.classList.remove('drop-target'));
        document.body.classList.remove('dragging-thread');
        draggingThread = null;
        flash(IDLE_HINT, 1);
    });

    const wants = e => e.dataTransfer.types.includes(DT_PACKET);
    const isThread = e => e.dataTransfer.types.includes(DT_THREAD);

    row.addEventListener('dragover', e => {
        // ── another thread: show where it would slot in ──
        if (isThread(e)) {
            if (draggingThread === threadId) return;      // itself, nothing to show
            e.preventDefault();
            e.stopPropagation();                          // the tray's append is the fallback
            e.dataTransfer.dropEffect = 'move';

            const r = row.getBoundingClientRect();
            const above = e.clientY < r.top + r.height / 2;
            clearInsertMarks();
            row.classList.add(above ? 'insert-above' : 'insert-below');
            return;
        }

        if (!wants(e)) return;
        e.preventDefault();
        // Alt = fork. Recomputed each dragover so the cursor tracks the key.
        e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
        row.classList.add('drop-target');
    });

    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));

    // ── another thread dropped on this row: slot it above or below ──
    row.addEventListener('drop', async e => {
        if (!isThread(e)) return;
        e.preventDefault();
        e.stopPropagation();

        const movedId = +e.dataTransfer.getData(DT_THREAD);
        const above = row.classList.contains('insert-above');
        clearInsertMarks();
        if (movedId === threadId) return;

        const tray = row.closest('.tray');
        const folderId = +tray.dataset.tray;

        // index among the *other* threads in this tray, so it's stable whether or not
        // the dragged thread already lives here
        const others = [...tray.querySelectorAll('[data-thread]')]
            .map(n => +n.dataset.thread)
            .filter(i => i !== movedId);
        const anchor = others.indexOf(threadId);
        const index = anchor === -1 ? others.length : (above ? anchor : anchor + 1);

        const res = await json(`/api/threads/${movedId}/reorder`, { folderId, index });
        if (res.error) return flash(res.error, 6000);

        await loadTree();
        settle(movedId);
        flash(`Moved "${res.title}" ${above ? 'above' : 'below'} "${title}"`);
    });

    row.addEventListener('drop', async e => {
        if (!wants(e)) return;
        e.preventDefault();
        e.stopPropagation();
        row.classList.remove('drop-target');

        const packetId = +e.dataTransfer.getData(DT_PACKET);
        const forking = e.altKey;
        const source = el.messages.querySelector(`[data-packet="${packetId}"]`);

        // Kick the animation off against the node's current position, then move on.
        // Never awaited — the write must land even if no frame ever renders.
        if (forking) mitosis(source, row); else comet(source, row);

        const res = await json(`/api/packets/${packetId}/${forking ? 'fork' : 'move'}`,
            { toThreadId: threadId });

        if (res.error) return flash(res.error, 6000);

        if (activeThread) await selectThread(activeThread.id, activeThread.title);
        else await loadTree();

        settle(threadId);
        flash(forking
            ? `Forked #${packetId} into ${title} as #${res.id} — tether kept`
            : `Moved #${packetId} → ${title}`);
    });
}

/**
 * Trays are both a drop target (threads land here) and a drag source (reorder the trays
 * themselves). The header is the handle — the tray body is full of threads that are
 * draggable in their own right, and nesting drag sources fights over the gesture.
 */
function wireTrayDnd(tray) {
    const folderId = +tray.dataset.tray;
    const handle = tray.querySelector('.tray-name');
    const name = tray.querySelector('.title').textContent;

    const wantsThread = e => e.dataTransfer.types.includes(DT_THREAD);
    const wantsTray = e => e.dataTransfer.types.includes(DT_TRAY);

    // ── drag source ──
    handle.addEventListener('dragstart', e => {
        e.stopPropagation();
        const dt = e.dataTransfer;
        dt.setData(DT_TRAY, String(folderId));
        // 'move' is the only sensible tray operation, and it matches the dropEffect we
        // set below. Mismatching these is what silently kills a drop — see README.
        dt.effectAllowed = 'move';
        dt.setDragImage(makeDragChip(`<b>▤</b> ${escapeHtml(name)}`), 16, 14);

        draggingTray = folderId;
        tray.classList.add('dragging');
        flash(`Reordering tray "${name}"`, 30000);
    });

    // A tray only ever moves.
    handle.addEventListener('drag', e => trail(e, 'move'));

    handle.addEventListener('dragend', () => {
        tray.classList.remove('dragging');
        clearInsertMarks();
        el.trays.querySelectorAll('.drop-target').forEach(n => n.classList.remove('drop-target'));
        clearDragChip();
        clearTrails();
        draggingTray = null;
        flash(IDLE_HINT, 1);
    });

    // ── drop target ──
    tray.addEventListener('dragover', e => {
        if (wantsTray(e)) {
            if (draggingTray === folderId) return;          // itself
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';

            const r = tray.getBoundingClientRect();
            const above = e.clientY < r.top + r.height / 2;
            clearInsertMarks();
            tray.classList.add(above ? 'insert-above' : 'insert-below');
            return;
        }

        if (!wantsThread(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        tray.classList.add('drop-target');
    });

    tray.addEventListener('dragleave', e => {
        if (!tray.contains(e.relatedTarget)) tray.classList.remove('drop-target');
    });

    tray.addEventListener('drop', async e => {
        // ── a tray dropped on a tray: reorder ──
        if (wantsTray(e)) {
            e.preventDefault();
            e.stopPropagation();

            const movedId = +e.dataTransfer.getData(DT_TRAY);
            const above = tray.classList.contains('insert-above');
            clearInsertMarks();
            if (movedId === folderId) return;

            const others = tree.map(f => f.id).filter(i => i !== movedId);
            const anchor = others.indexOf(folderId);
            const index = anchor === -1 ? others.length : (above ? anchor : anchor + 1);

            const res = await json(`/api/folders/${movedId}/reorder`, { index });
            if (res.error) return flash(res.error, 6000);

            await loadTree();
            settleTray(movedId);
            flash(`Moved tray "${res.name}" ${above ? 'above' : 'below'} "${name}"`);
            return;
        }

        // ── a thread dropped on tray whitespace: re-file to the end ──
        if (!wantsThread(e)) return;
        e.preventDefault();
        tray.classList.remove('drop-target');

        const threadId = +e.dataTransfer.getData(DT_THREAD);
        const already = tree.find(f => f.id === folderId)?.threads.some(t => t.id === threadId);
        if (already) return;   // dropped on its own tray

        const res = await json(`/api/threads/${threadId}`, { folderId }, 'PATCH');
        if (res.error) return flash(res.error, 6000);

        await loadTree();
        settle(threadId);
        flash(`Re-filed "${res.title}" into ${res.folder_name}`);
    });
}

// ─────────────────── The Galactic Oversight Committee ───────────────────
// No API, no keys, no spend. Out by clipboard, back by paste. The committee gets a
// vote without every thought making a pilgrimage through a paid endpoint.

let handoffCtx = null;

async function openHandoff(threadId, actor) {
    const brief = await (await fetch(
        `/api/threads/${threadId}/brief?actor=${encodeURIComponent(actor)}`)).json();

    if (brief.error) return flash(brief.error, 6000);

    handoffCtx = { threadId, actor, packetIds: brief.packetIds, title: brief.thread.title };

    el.handoffTitle.textContent = `Handoff → ${actor}`;
    el.handoffMeta.innerHTML = `<b>${escapeHtml(brief.thread.title)}</b> · `
        + `${escapeHtml(brief.thread.folder)} · ${brief.packetIds.length} packet(s). `
        + `Nothing is transmitted — copy the brief, take it to ${escapeHtml(actor)} yourself, `
        + `then paste the reply back.`;

    el.brief.value = brief.markdown;
    el.verdict.value = '';
    el.copyHint.textContent = '';
    el.signNote.textContent = brief.packetIds.length
        ? `Recording adds ${actor}'s verdict as a packet in ${brief.thread.title}, and stamps `
          + `"reviewed by ${actor}" on ${brief.packetIds.length} packet(s).`
        : `${brief.thread.title} has no packets yet — the verdict still lands as one.`;

    el.handoff.showModal();
}

el.copyBrief.onclick = async () => {
    try {
        await navigator.clipboard.writeText(el.brief.value);
        el.copyHint.textContent = 'Copied. Paste it to them, bring the reply back.';
    } catch {
        el.brief.select();
        el.copyHint.textContent = 'Clipboard blocked — the text is selected, hit Ctrl+C.';
    }
};

el.saveBrief.onclick = () => {
    const slug = (handoffCtx?.title || 'thread').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const url = URL.createObjectURL(new Blob([el.brief.value], { type: 'text/markdown' }));
    const a = Object.assign(document.createElement('a'), {
        href: url,
        download: `airlock-brief-${slug}-${handoffCtx?.actor || 'committee'}.md`
    });
    a.click();
    URL.revokeObjectURL(url);
    el.copyHint.textContent = 'Saved to your downloads.';
};

el.recordBtn.onclick = async () => {
    if (!handoffCtx) return;

    const verdict = el.verdict.value.trim();
    if (!verdict) {
        el.copyHint.textContent = 'Paste their verdict first — nothing to record yet.';
        el.verdict.focus();
        return;
    }

    const res = await json(`/api/threads/${handoffCtx.threadId}/handoff`, {
        actor: handoffCtx.actor, verdict, packetIds: handoffCtx.packetIds
    });

    if (res.error) { el.copyHint.textContent = res.error; return; }

    const { actor, threadId, title } = handoffCtx;
    el.handoff.close();
    await selectThread(threadId, title);
    flash(`${actor} signed ${res.signed} packet(s) in ${title}`, 6000);
};

el.handoffClose.onclick = () => el.handoff.close();
el.handoffCancel.onclick = () => el.handoff.close();

el.members.querySelectorAll('.member').forEach(m => {
    const actor = m.dataset.actor;
    const wants = e => e.dataTransfer.types.includes(DT_THREAD);

    m.addEventListener('dragover', e => {
        if (!wants(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        m.classList.add('over');
    });

    m.addEventListener('dragleave', () => m.classList.remove('over'));

    m.addEventListener('drop', e => {
        if (!wants(e)) return;
        e.preventDefault();
        m.classList.remove('over');
        openHandoff(+e.dataTransfer.getData(DT_THREAD), actor);
    });

    // Clicking works too — dragging is the gesture, not the only way in.
    m.addEventListener('click', () => {
        if (!activeThread) return flash('Pick a thread first, or drag one up here.', 5000);
        openHandoff(activeThread.id, actor);
    });
});

// ─────────────────────────── sending ───────────────────────────

function setBusy(busy) {
    el.send.textContent = busy ? 'Stop' : 'Send';
    el.send.classList.toggle('stop', busy);
    el.input.disabled = false;
}

async function send() {
    if (controller) { controller.abort(); return; }   // button is acting as Stop

    const text = el.input.value.trim();
    if (!text && !pending.length) return;

    const model = el.model.value;
    const sendingThreadId = activeThread?.id || null;
    localStorage.setItem('airlock.model', model);

    const userImages = pending.map(p => p.dataUrl);
    const userMsg = { role: 'user', content: text, images: userImages };
    messages.push(userMsg);
    const outgoingImages = pending.map(p => p.base64);
    pending = [];
    renderAttachments();

    // Awaited, not fired-and-forgotten: insert order is what gives the two packets
    // their position, and a reply that lands before its prompt reads backwards.
    //
    // The returned id has to land on the message object. Without it the turn renders with
    // no data-packet, so a just-sent packet has no drag handle until the thread is reloaded.
    const userPacketId = await persist('user', text, userImages);
    if (userPacketId) userMsg.packetId = userPacketId;

    el.input.value = '';
    el.input.style.height = 'auto';

    const reply = { role: 'assistant', content: '', streaming: true, model };
    messages.push(reply);
    render();
    scrollDown();

    // Build the wire payload: system prompt first, images on the last user turn.
    const wire = [];
    if (config.systemPrompt) wire.push({ role: 'system', content: config.systemPrompt });
    messages.filter(m => !m.streaming && !m.error).forEach((m, i, arr) => {
        const msg = { role: m.role, content: m.content };
        if (m.role === 'user' && i === arr.length - 1 && outgoingImages.length) msg.images = outgoingImages;
        wire.push(msg);
    });

    controller = new AbortController();
    setBusy(true);
    const started = performance.now();

    try {
        const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, messages: wire, threadId: sendingThreadId }),
            signal: controller.signal
        });

        if (!res.ok) {
            const { error } = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
            throw new Error(error);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let firstToken = null;
        let countedUsage = false;   // fall back to the done chunk if no usage line arrives

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();   // keep the partial line

            for (const line of lines) {
                if (!line.trim()) continue;

                let chunk;
                try { chunk = JSON.parse(line); } catch { continue; }

                if (chunk.error) throw new Error(chunk.error);

                // Server-injected token totals for the whole turn, tool rounds included.
                if (chunk.airlock_usage) {
                    countTokens(chunk.airlock_usage.prompt, chunk.airlock_usage.reply);
                    countedUsage = true;
                    continue;
                }

                // Server-injected tool event (Ollama never emits this key).
                if (chunk.airlock_tool) {
                    (reply.tools ||= []).push(chunk.airlock_tool);
                    render();
                    scrollDown();
                    continue;
                }

                // Reasoning arrives first and can run for a long time on this hardware.
                if (chunk.message?.thinking) {
                    reply.thinking = (reply.thinking || '') + chunk.message.thinking;
                    reply.thinkingMs = performance.now() - started;
                }

                if (chunk.message?.content) {
                    if (firstToken === null) firstToken = performance.now();
                    reply.content += chunk.message.content;
                }

                if (chunk.done) {
                    // Only if the server didn't total it for us — never both.
                    if (!countedUsage) countTokens(chunk.prompt_eval_count, chunk.eval_count);

                    const tps = chunk.eval_count && chunk.eval_duration
                        ? (chunk.eval_count / (chunk.eval_duration / 1e9)).toFixed(1)
                        : '?';
                    const ttft = firstToken ? ((firstToken - started) / 1000).toFixed(1) : '?';
                    const thought = reply.thinkingMs
                        ? `${(reply.thinkingMs / 1000).toFixed(1)}s reasoning · ` : '';
                    reply.stats = `${thought}${chunk.eval_count ?? '?'} tokens · ${tps} tok/s · `
                                + `${ttft}s to first token · ${chunk.prompt_eval_count ?? '?'} prompt tokens`;
                }
            }

            reply.streaming = true;
            render();
            scrollDown();
        }
    } catch (err) {
        if (err.name === 'AbortError') {
            reply.content += reply.content ? '\n\n(stopped)' : '(stopped)';
        } else {
            reply.error = true;
            reply.content = `**Error:** ${err.message}`;
        }
    } finally {
        controller = null;
        reply.streaming = false;
        setBusy(false);
        render();
        scrollDown();
        save();

        if (activeThread && reply.content && !reply.error) {
            const replyPacketId = await persist('assistant', reply.content);
            if (replyPacketId) {
                reply.packetId = replyPacketId;
                render();          // repaint so the reply gets its drag handle too
            }
            await loadTree();      // refresh the packet counts in the rail
        }
    }
}

// ─────────────────────────── attachments ───────────────────────────

function renderAttachments() {
    el.attached.hidden = !pending.length;
    el.attached.innerHTML = pending.map((p, i) =>
        `<span class="chip"><img src="${p.dataUrl}" alt=""><span>${escapeHtml(p.name)}</span>
         <button type="button" data-i="${i}" title="Remove">✕</button></span>`).join('');

    el.attached.querySelectorAll('button').forEach(b => {
        b.onclick = () => { pending.splice(+b.dataset.i, 1); renderAttachments(); };
    });
}

const TEXT_ATTACH = /\.(md|markdown|txt|text|json|jsonl|csv|tsv|log|ya?ml|toml|ini|cfg|conf|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|cs|sql|sh|ps1|bat|vbs|html?|css|scss|svg|scad|xml)$/i;

function addFiles(list) {
    for (const f of list) {
        // Images go to the perception encoder as base64.
        if (f.type.startsWith('image/')) {
            const fr = new FileReader();
            fr.onload = () => {
                const dataUrl = fr.result;
                pending.push({ name: f.name || 'pasted.png', dataUrl, base64: dataUrl.split(',')[1] });
                renderAttachments();
            };
            fr.readAsDataURL(f);
            continue;
        }

        // Text files fold straight into the message — no tool round needed, and it works
        // for files outside the workspace since you handed it over explicitly.
        if (TEXT_ATTACH.test(f.name)) {
            const fr = new FileReader();
            fr.onload = () => {
                const text = String(fr.result).slice(0, 60000);
                const fence = '```';
                el.input.value += `${el.input.value ? '\n\n' : ''}${f.name}:\n${fence}\n${text}\n${fence}\n`;
                el.input.dispatchEvent(new Event('input'));
                el.input.focus();
                flash(`Pasted ${f.name} into the message (${text.length.toLocaleString()} chars)`, 5000);
            };
            fr.readAsText(f);
            continue;
        }

        flash(`Skipped ${f.name} — not an image or a text file`, 5000);
    }
}

// ─────────────────────────── persistence ───────────────────────────

// localStorage only backs the scratch chat. Once a thread is selected the packet
// store is the source of truth, and mirroring into localStorage would let the two
// disagree.
const save = () => {
    if (!activeThread) localStorage.setItem('airlock.chat', JSON.stringify(messages.slice(-40)));
};

function restore() {
    try {
        messages = JSON.parse(localStorage.getItem('airlock.chat') || '[]')
            .map(m => ({ ...m, streaming: false }));
    } catch { messages = []; }
}

// ─────────────────────────── wiring ───────────────────────────

el.send.onclick = send;

el.input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

el.input.addEventListener('input', () => {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 200) + 'px';
});

el.input.addEventListener('paste', e => {
    const imgs = [...e.clipboardData.files].filter(f => f.type.startsWith('image/'));
    if (imgs.length) { e.preventDefault(); addFiles(imgs); }
});

el.attach.onclick = () => el.file.click();
el.file.onchange = () => { addFiles(el.file.files); el.file.value = ''; };

['dragenter', 'dragover'].forEach(ev =>
    el.composer.addEventListener(ev, e => { e.preventDefault(); el.composer.classList.add('drag'); }));
['dragleave', 'drop'].forEach(ev =>
    el.composer.addEventListener(ev, e => { e.preventDefault(); el.composer.classList.remove('drag'); }));
el.composer.addEventListener('drop', e => addFiles(e.dataTransfer.files));

el.newChat.onclick = () => {
    if (controller) controller.abort();
    leaveThread();          // back to the scratch chat; packets already stored stay put
    messages = [];
    save();
    render();
};

el.newFolder.onclick = async () => {
    const name = prompt('New tray name:');
    if (!name?.trim()) return;
    await json('/api/folders', { name: name.trim() });
    await loadTree();
};

el.openSettings.onclick = () => {
    if (!el.settings.open) el.settings.showModal();
    paintWorkspace();
};

el.saveSettings.onclick = async () => {
    await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            systemPrompt: el.sys.value,
            temperature: +el.temp.value,
            top_p: +el.topp.value,
            top_k: +el.topk.value,
            num_ctx: +el.ctx.value
        })
    });
    await loadConfig();
};

el.model.onchange = () => {
    localStorage.setItem('airlock.model', el.model.value);
    paintThinkToggle();     // capabilities differ per model
    paintWorkspace();
};

el.hint.textContent = 'images + tool use supported';

(async () => {
    restore();
    render();
    loadTokens();
    await loadConfig();
    await loadWorkspace();
    refreshHealth();
    await loadTree();

    // Reopen the thread we were last in, if it still exists.
    const saved = localStorage.getItem('airlock.thread');
    if (saved) {
        const t = tree.flatMap(f => f.threads).find(x => x.id === +saved);
        if (t) await selectThread(t.id, t.title);
        else localStorage.removeItem('airlock.thread');
    }

    setInterval(refreshHealth, 15000);
    el.input.focus();
})();
