'use strict';

const $ = id => document.getElementById(id);

const el = {
    demoNotice: $('demoNotice'), toast: $('toast'),
    messages: $('messages'), main: $('main'),
    model: $('model'), dot: $('dot'), statusText: $('statusText'),
    gateModel: $('gateModel'), gateChip: $('gateChip'), crossedPill: $('crossedPill'),
    settings: $('settings'), newChat: $('newChat'), openSettings: $('openSettings'),
    sys: $('sys'), temp: $('temp'), topp: $('topp'), topk: $('topk'), ctx: $('ctx'),
    saveSettings: $('saveSettings'), trays: $('trays'), storeStats: $('storeStats'),
    newFolder: $('newFolder'), threadPill: $('threadPill'), threadName: $('threadName'),
    committee: $('committee'),
    handoff: $('handoff'), handoffTitle: $('handoffTitle'), handoffMeta: $('handoffMeta'),
    brief: $('brief'), verdict: $('verdict'), signNote: $('signNote'), copyHint: $('copyHint'),
    copyBrief: $('copyBrief'), saveBrief: $('saveBrief'), recordBtn: $('recordHandoff'),
    handoffClose: $('handoffClose'), handoffCancel: $('handoffCancel'),
    carryTo: $('carryTo'), carryRuling: $('carryRuling'), carryReleased: $('carryReleased'),
    carryAnyway: $('carryAnyway'), carryOut: $('carryOut'),
    thinkToggle: $('thinkToggle'),
    wsRoot: $('wsRoot'), wsBrowse: $('wsBrowse'), wsClear: $('wsClear'), wsHint: $('wsHint'),
    wsThread: $('wsThread'), tokenPill: $('tokenPill')
};

// ─────────────────────────── access ───────────────────────────
//
// A hosted instance sets AIRLOCK_TOKEN and every /api call must carry it. There
// are fourteen fetch call sites in this file, so the header is attached by
// wrapping fetch once rather than by editing each of them: for an access check,
// "no call site can be missed" is worth more than avoiding a little indirection.
//
// Local instances set no token and this does nothing at all.

const TOKEN_KEY = 'airlock.token';

(function claimTokenFromUrl() {
    const fromUrl = new URLSearchParams(location.search).get('t');
    if (!fromUrl) return;
    try { localStorage.setItem(TOKEN_KEY, fromUrl); } catch { /* private window */ }
    // Out of the address bar, so it stops appearing in history and in screenshots.
    const clean = new URL(location.href);
    clean.searchParams.delete('t');
    history.replaceState(null, '', clean.pathname + clean.search + clean.hash);
})();

const accessToken = () => {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
};

const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    const token = accessToken();
    if (!token || !url.startsWith('/api')) return nativeFetch(input, init);
    return nativeFetch(input, {
        ...init,
        headers: { ...(init.headers || {}), 'X-Airlock-Token': token }
    });
};

/** Ask for a token once, when the server says one is needed. */
let askingForToken = false;
async function requireToken() {
    if (askingForToken) return;
    askingForToken = true;
    const entered = window.prompt(
        'This Airlock instance needs an access token.\n\nPaste it to continue:');
    if (entered && entered.trim()) {
        try { localStorage.setItem(TOKEN_KEY, entered.trim()); } catch { /* ignore */ }
        location.reload();
        return;
    }
    askingForToken = false;
}

const DT_THREAD = 'application/x-airlock-thread';
const DT_PACKET = 'application/x-airlock-packet';
const DT_TRAY = 'application/x-airlock-tray';
// The lane hint is static markup now; nothing in JS rewrites it.

let config = {};
let tree = [];              // trays -> threads
let activeThread = null;    // { id, title } — null means no thread is open

// ─────────────────────────── markdown (tiny, dependency-free) ───────────────────────────

const escapeHtml = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * What happened the last time this model ran here, for the picker. Shared with duet.js.
 *
 * Measured by the server from Ollama's /api/ps, never predicted from a spec sheet: a
 * browser cannot see the GPU, and guessing whether someone's hardware can hold a model
 * is how you hide a model from the one person with a second card. So nothing is hidden,
 * nothing is said about a model that has never run, and a model that fitted says nothing
 * at all — only a model that DIDN'T fit gets a note, because that is the one that costs
 * you something. `title` carries the detail, since an <option> has no room for it.
 */
function residencyNote(m) {
    const r = m.residency;
    if (!r || r.gpu >= 0.995) return { text: '', title: '' };

    const gb = n => (n / 1e9).toFixed(1);
    const text = r.gpu < 0.01 ? 'ran on CPU' : `ran ${Math.round(r.gpu * 100)}% on GPU`;
    const title = `Last time it ran here, ${gb(r.sizeVram)} of ${gb(r.size)} GB fitted in VRAM `
        + 'and the rest ran on the CPU, which is much slower. Measured, not predicted — it '
        + 'depends on the context length it ran with as well as the card, so a shorter '
        + 'context or a smaller quantisation may fit where this did not.';
    return { text, title };
}

/**
 * The banner that says what kind of instance this is. Never dismissible.
 *
 * Two different truths, and the banner must not tell the wrong one:
 *   - AIRLOCK_DEMO alone: a SHARED instance. Everything typed is visible to other
 *     visitors, so the banner says so. (The markup in index.html.)
 *   - Sandboxes on: the opposite. Each visitor's desk is private to their browser — and
 *     "shared demo, visible to others" would now be a false warning, which is still a
 *     wrong banner. What IS true, and worth saying: it lives on someone else's server,
 *     it expires, a cleared cookie loses it for good, and crossings are still crossings.
 */
/**
 * Where "local" is, in words a reader will not misread. Shared with duet.js.
 *
 * On a desk the local tier is the reader's own machine. Hosted, it is the SERVER — the
 * invariant is the same (a local model never sends anything on), but "stays on this
 * machine" read on a judge's laptop is a claim about the laptop, and it is false there.
 * Every visible statement about where a local model runs reads this.
 */
let hostedView = false;
const here = () => (hostedView ? 'this server' : 'this machine');

function paintNotice(h) {
    const hosted = Boolean(h.sandbox || h.demo);
    // The idle screen is drawn before the first health check answers, so it would keep
    // saying "on your machine" on a hosted page. Redraw once when the answer changes it —
    // not on every poll.
    if (hosted !== hostedView) { hostedView = hosted; if (!activeThread) renderLanding(); }
    const node = el.demoNotice;
    if (!node) return;
    if (node.dataset.shared === undefined) node.dataset.shared = node.innerHTML;

    if (h.sandbox) {
        const days = Math.round((h.sandbox.ttlHours || 0) / 24);
        const idle = days >= 1 ? `${days} day${days === 1 ? '' : 's'}` : `${h.sandbox.ttlHours} hours`;
        const r = h.sandbox.remote || {};
        const left = r.budget ? ` You have <b>${Math.max(0, r.budget - (r.used || 0))}</b> of `
            + `${r.budget} remote calls left.` : '';
        node.innerHTML = '<b>Your private sandbox.</b> Only this browser can see what you do '
            + `here. It lives on this server, and is deleted after ${escapeHtml(idle)} idle — `
            + 'clearing your cookies loses it for good, because there is no account to '
            + 'recover it through. Anything sent to a remote model is still ruled on by the '
            + `local gate first, and logged in your sandbox.${left} `
            + 'To keep everything, run Airlock on your own machine.';
        node.hidden = false;
        return;
    }

    node.innerHTML = node.dataset.shared;
    node.hidden = !h.demo;
}

/**
 * The picker's groups. Shared with duet.js so the two can never disagree about which
 * side of the boundary a model is on.
 *
 * ⚠ "Local" is tier === 'local' exactly — never "not remote". The server answers
 * 'unknown' for a model no catalogue claims, and a filter written as `!== 'remote'`
 * files that under "stays on this machine", which is the one label a picker must not
 * get wrong. Unclassified models are listed, not hidden, under a label that says what
 * the server will do with them.
 */
function groupModels(models) {
    return [
        [`Local — stays on ${here()}`, models.filter(m => m.tier === 'local')],
        ['Oversight — Nemotron, across the boundary',
            models.filter(m => m.tier === 'remote' && !m.via && m.family === 'nemotron')],
        ['Oversight — other remote models',
            models.filter(m => m.tier === 'remote' && !m.via && m.family !== 'nemotron')],
        ['Ollama cloud — listed by Ollama, answered on ollama.com',
            models.filter(m => m.tier === 'remote' && m.via === 'ollama-cloud')],
        ['Unclassified — treated as a crossing and gated',
            models.filter(m => m.tier !== 'local' && m.tier !== 'remote')]
    ];
}

/**
 * For a RECORDED tier, on a packet. Shared with duet.js.
 *
 * Not `!== 'local'`: packets written before tiers were recorded carry null, and those were
 * all local. What the server now writes for a model it could not place is 'unknown', and
 * it logs that turn as a crossing — so the transcript shows it as one, or the record and
 * the screen disagree.
 */
const crossedTier = t => t === 'remote' || t === 'unknown';

/** One <option>, identical in both pickers. */
function modelOption(m, selected) {
    const badges = [
        m.caps?.includes('thinking') ? '◈' : '',
        m.caps?.includes('vision') ? '👁' : '',
        m.caps?.includes('tools') ? '⛁' : ''
    ].filter(Boolean).join('');
    // Remote models report no size — there is no local file — so the GB suffix is
    // omitted rather than NaN.
    const size = m.size ? `  (${(m.size / 1e9).toFixed(1)} GB)` : '';
    const note = residencyNote(m);
    return `<option value="${escapeHtml(m.name)}"${m.name === selected ? ' selected' : ''}`
        + `${note.title ? ` title="${escapeHtml(note.title)}"` : ''}>`
        + `${escapeHtml(m.name)}${size}${badges ? '  ' + badges : ''}`
        + `${note.text ? '  · ' + escapeHtml(note.text) : ''}</option>`;
}

const modelOptgroups = (models, selected) => groupModels(models)
    .filter(([, list]) => list.length)
    .map(([label, list]) =>
        `<optgroup label="${escapeHtml(label)}">${list.map(m => modelOption(m, selected)).join('')}</optgroup>`)
    .join('');

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

// ─────────────────────────── the idle desk ───────────────────────────
//
// What the pane shows with no thread open. There used to be a whole single-pane chat here;
// every conversation now lives in a thread, with two participants and the chamber, so the
// desk with nothing open is just the emblem, what the desk is, and the way in.

/**
 * The hatch seal, large, for an empty desk. Same geometry as the brand mark — the seam is the
 * boundary — with a slow outer ring so an idle screen looks idle rather than broken.
 */
const HATCH_EMBLEM = `<div class="emblem" aria-hidden="true">
        <svg viewBox="0 0 120 120" fill="none">
            <circle class="emblem-orbit" cx="60" cy="60" r="56" stroke-width="1"/>
            <circle class="emblem-ticks" cx="60" cy="60" r="48" stroke-width="4"/>
            <path d="M56.5 20.2 A 40 40 0 0 0 56.5 99.8" stroke="#76b900" stroke-width="12"/>
            <path d="M63.5 20.2 A 40 40 0 0 1 63.5 99.8" stroke="#ffb020" stroke-width="12"/>
            <circle cx="60" cy="60" r="8" fill="#e6e9ed"/>
        </svg>
    </div>`;

function renderLanding() {
    el.messages.innerHTML = `<div class="empty">${HATCH_EMBLEM}
            <h2>Airlock is idle</h2>
            <p>${hostedView
                ? 'Answering locally, on this server, with its own model rather than a provider’s. '
                  + 'Nothing is sent to a remote model unless you send it across the boundary.'
                : 'Answering locally, on your machine. Nothing leaves the desk unless you '
                  + 'send it across the boundary.'}</p>
            <p><button class="send landing-new" id="landingNew">✎ New thread</button></p>
            <p class="stats">Or open one on the left. Every thread has two sides — one here,
               one that can cross — and the chamber between them.</p>
        </div>`;
    $('landingNew').onclick = () => newThread();
}

/** Show the landing, or hand the pane to the duet. Exactly one of them is on screen. */
function paintPaneMode() {
    el.main.hidden = Boolean(activeThread);
    if (!activeThread) renderLanding();
}

let flashTimer;

/** Transient status in the lane — cheaper than a toast system, and it reads in place. */
/**
 * Transient feedback.
 *
 * This used to write into the lane hint, which sits at the right end of the
 * committee bar — and that bar scrolls horizontally, so on a narrow window every
 * message was rendered off-screen. A drag that gated, escalated and reported
 * back looked exactly like a drag that did nothing.
 */
function flash(msg, ms = 4000) {
    if (el.toast) {
        el.toast.textContent = msg;
        el.toast.hidden = false;
    }
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
        if (el.toast) el.toast.hidden = true;
    }, ms);
}

/** Dismiss the toast now. The lane hint is static, so there is nothing to restore. */
function clearFlash() {
    clearTimeout(flashTimer);
    if (el.toast) el.toast.hidden = true;
}

// ─────────────────────────── health / models ───────────────────────────

async function refreshHealth() {
    try {
        const probe = await fetch('/api/health');

        // A hosted instance answers 401 until a token is presented. Ask for one
        // rather than rendering an app that cannot load anything.
        if (probe.status === 401) {
            el.dot.className = 'dot warn';
            el.statusText.textContent = 'token required';
            await requireToken();
            return;
        }

        const h = await probe.json();

        if (!h.ollama) {
            el.dot.className = 'dot bad';
            el.statusText.textContent = 'Ollama offline';
            el.model.innerHTML = '<option>—</option>';
            return;
        }

        // The server's config is the single source of truth for the current model.
        //
        // This used to prefer a localStorage value, which meant a browser that had
        // ever picked a model outvoted the server's config permanently — changing
        // the default did nothing, forever, with no way to tell why. The picker now
        // writes back to the config instead of keeping a private copy.
        const wanted = h.activeModel;

        // One-time cleanup of that private copy.
        try { localStorage.removeItem('airlock.model'); } catch { /* ignore */ }


        // A shared instance says so, every load. There is no dismiss control.
        paintNotice(h);
        paintGate(h.gate);

        // Grouped by tier, because which side of the boundary a model sits on is the
        // one thing you must know before picking it. Nemotron gets its own group rather
        // than being buried alphabetically among twenty other remote models, which made
        // the dropdown read like a vendor list rather than an escalation ladder. The
        // groups themselves live in groupModels(), shared with the duet panes.
        el.model.innerHTML = modelOptgroups(h.models);

        if (h.models.some(m => m.name === wanted)) {
            el.model.value = wanted;
        } else if (h.models.length) {
            el.model.value = h.models[0].name;
        }

        if (h.localModelInstalled) {
            el.dot.className = 'dot ok';
            el.statusText.textContent = `Ollama ${h.version || ''}`.trim();
            el.statusText.title = '';
        } else {
            // Ollama is up but nothing is installed on this side of the boundary. That is
            // more than a missing chat option: the gate is a local model, so without one
            // every crossing is refused. Say what to do about it, specifically.
            el.dot.className = 'dot warn';
            el.statusText.textContent = 'No local model';
            el.statusText.title = `Ollama is running but has no model installed on ${here()}, so `
                + 'there is nothing to answer locally and nothing to run the gate — every crossing '
                + 'will be refused. Try: ollama pull nemotron-3-nano:4b (2.8 GB).';
        }

        paintThinkToggle();
        paintWorkspace();
    } catch {
        el.dot.className = 'dot bad';
        el.statusText.textContent = 'server offline';
    }
}

/**
 * The boundary bar names the model that will actually rule on the next crossing — the
 * server resolves it exactly as runGate does. No gate means every crossing is refused, and
 * the bar says so in red rather than leaving it to be discovered on the first send.
 */
function paintGate(gate) {
    el.gateModel.textContent = gate || 'none reachable';
    el.gateChip.classList.toggle('bad', !gate);
    el.gateChip.title = gate
        ? `${gate} rules on every crossing, on this side of the boundary, after the secret scanner. `
          + 'Set AIRLOCK_GATE_MODEL in .env to choose it.'
        : 'No local model is reachable to rule on crossings, so every crossing will be refused.';
}

/** How much of the open thread has left this machine — from the record, not the screen. */
async function paintCrossed() {
    if (!activeThread) { el.crossedPill.hidden = true; return; }
    try {
        const exposure = await (await fetch(`/api/threads/${activeThread.id}/exposure`)).json();
        const n = exposure.packetCount || 0;
        el.crossedPill.hidden = false;
        el.crossedPill.textContent = n ? `↗ ${n} crossed` : 'nothing crossed';
        el.crossedPill.classList.toggle('some', n > 0);
    } catch { el.crossedPill.hidden = true; }
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


function paintThinkToggle() {
    el.thinkToggle.checked = config.think !== false;
}

// Saved at once, like the model picker: it is a switch, not a draft.
el.thinkToggle.onchange = async () => {
    config = await json('/api/config', { think: el.thinkToggle.checked }, 'POST');
    paintThinkToggle();
    flash(config.think === false
        ? 'Reasoning off — faster, and models answer straight away'
        : 'Reasoning on — slower, but models that can think first will', 5000);
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
    const hasThread = !!activeThread;

    el.wsThread.textContent = activeThread?.title || 'No thread selected';
    el.wsRoot.disabled = !hasThread;
    el.wsBrowse.disabled = !hasThread || wsBrowsing;
    el.wsClear.disabled = !hasThread || !workspace.root || wsBrowsing;

    // Don't fight the user's typing — only overwrite the box when it isn't focused.
    if (document.activeElement !== el.wsRoot) el.wsRoot.value = workspace.root || '';

    window.duetUI?.refreshFiles?.();       // each pane's ⛁ switch reads the same workspace

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
        if (activeThread?.id === id) { leaveThread(); }
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
        if (threads.some(t => t.id === activeThread?.id)) { leaveThread(); }
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
    renderRail();
    const s = await (await fetch('/api/stats')).json();
    el.storeStats.textContent = `${s.packets} packets · ${s.nested} nested · ${s.forks} forks · ${s.reviews} reviews`;
}

async function selectThread(id, title) {
    activeThread = { id, title };
    wsNotice = '';
    localStorage.setItem('airlock.thread', String(id));
    el.threadName.textContent = title;
    el.threadPill.hidden = false;
    el.carryOut.hidden = false;

    await loadWorkspace(id);

    // loadTree, not renderRail: packets can move underneath us (another window, an
    // agent, a curl), so re-read the counts rather than repainting stale ones.
    await loadTree();
    paintPaneMode();
    paintCrossed();

    // Every thread is a duet: two participants and the chamber. duet.js builds the panes.
    await window.duetUI?.onThread(activeThread);
}

function leaveThread() {
    activeThread = null;
    workspace = { threadId: null, threadTitle: null, root: null, exists: false };
    wsNotice = '';
    localStorage.removeItem('airlock.thread');
    el.threadPill.hidden = true;
    el.carryOut.hidden = true;
    el.crossedPill.hidden = true;
    paintWorkspace();
    renderRail();
    paintPaneMode();
    window.duetUI?.onThread(null);
}

// ── new threads, named later ──
//
// The scratch chat was a conversation outside every thread: kept in localStorage, never a
// packet, never in the audit trail — so anything it sent across the boundary crossed with
// no record to show for it. A thread you have not named yet does the same job and is on
// the record from its first word. It names itself from that first word, unless you got
// there first.

const UNTITLED = 'Untitled';

async function newThread() {
    const trayOf = id => tree.find(f => f.threads.some(t => t.id === id));
    let folder = (activeThread && trayOf(activeThread.id)) || tree[0];
    if (!folder) {
        folder = await json('/api/folders', { name: 'Threads' });
        if (folder.error) return flash(folder.error, 6000);
    }

    const thread = await json('/api/threads', { folderId: folder.id, title: UNTITLED });
    if (thread.error) return flash(thread.error, 6000);

    await selectThread(thread.id, thread.title);
    settle(thread.id);
    document.querySelector('.duet-pane .duet-input')?.focus();
}

/** Called by duet.js when a thread's first request lands. */
async function nameUntitled(threadId, text) {
    if (activeThread?.id !== threadId || activeThread.title !== UNTITLED) return;

    const words = String(text || '').replace(/\s+/g, ' ').trim();
    if (!words) return;                 // an image on its own: stays Untitled, rename by hand
    const title = words.length <= 48 ? words : `${words.slice(0, 48).replace(/\s+\S*$/, '')}…`;

    const res = await json(`/api/threads/${threadId}`, { title }, 'PATCH');
    if (res.error) return;
    activeThread.title = title;
    el.threadName.textContent = title;
    await loadTree();
}

// ─────────────────────────── physics ───────────────────────────
// Motion is decoration over operations that already work — every animation here runs
// *before* the refetch and none of them gate the result, so a janky frame or a
// prefers-reduced-motion user never changes what actually got stored.

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
// Same semantic as the rest of the palette: green stays on this machine, steel is a
// board operation, amber leaves. A .md dragged to the desktop really does leave, so it
// wears the crossing colour for the same reason the Oversight lane does.
const TRAIL = {
    move:   ['#76b900', '#4a7a00'],   // green — packet moves, still on this desk
    fork:   ['#b9c2cc', '#5b6672'],   // steel — a copy, tethered to the original
    export: ['#ffb020', '#b8760a']    // amber — leaving the app as a .md file
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
    if (fork) node.style.background = 'linear-gradient(90deg, transparent, #b9c2cc)';
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


// ─────────────────── what a packet says about itself on the way out ───────────────────

/**
 * The provenance line that travels with a thought when it leaves Airlock.
 *
 * Dropped into somebody else's chat box, an answer arrives stripped of everything that
 * makes it auditable unless we attach it here: which model produced it, whether that model
 * ran on this machine or across the boundary, and which packet it was so the claim can be
 * traced back. "Some AI said so" is precisely the failure this desk exists to prevent, and
 * it is the exported copy — the one that ends up in a doc, a review, a ticket — where that
 * failure actually happens.
 */
function provenanceOf(m, packetId) {
    const bits = [`Airlock packet #${packetId}`];
    if (activeThread) bits.push(`thread: ${activeThread.title}`);

    if (m.role === 'user') {
        bits.push('written by the operator');
    } else {
        bits.push(`model: ${m.model || 'unnamed local model'}`);
        // Stated outright, because it is the one fact a reader cannot recover downstream.
        bits.push(m.tier === 'remote' ? 'ran off-machine'
            : m.tier === 'unknown' ? 'ran on a model Airlock could not place — logged as a crossing'
            : hostedView ? "ran on this server's own model" : 'ran on local hardware');
    }

    if (m.origin && m.origin !== activeThread?.title) bits.push(`born in ${m.origin}`);
    if (m.reviewers) bits.push(`reviewed by ${m.reviewers}`);
    return bits.join(' · ');
}

const exportText = (m, packetId) => `[${provenanceOf(m, packetId)}]\n\n${m.content}`;

/**
 * The same content as HTML, for editors that ignore text/plain when HTML is also on offer.
 *
 * Deliberately NOT a <pre>: a rich editor renders that as a code block, and a quoted answer
 * is prose, not code. <br> keeps the line breaks without changing what the thing is.
 */
const asHtml = text => `<div>${escapeHtml(text).replace(/\n/g, '<br>')}</div>`;

const exportHtml = (m, packetId) =>
    `<div><i>[${escapeHtml(provenanceOf(m, packetId))}]</i><br><br>`
    + `${escapeHtml(m.content).replace(/\n/g, '<br>')}</div>`;

/**
 * Offer a drag in every flavour a drop target might actually read.
 *
 * Chat composers stopped being textareas years ago; they are rich editors (ProseMirror,
 * Lexical, Quill, Slate) whose drop handlers look for text/html first and fall back to
 * text/plain only when no HTML is on offer. Setting text/plain alone is why this drag lands
 * in some apps and silently does nothing in others.
 *
 * Note what is deliberately NOT set here: text/uri-list. A target that accepts links would
 * insert the URL in place of the text, and the URL is on localhost — meaningless to anyone
 * but this machine. Offering it would trade a working paste for a dead link.
 */
function offerAsText(dt, text, html = asHtml(text)) {
    dt.setData('text/plain', text);
    dt.setData('text/html', html);
}

/**
 * Copy, for the many drop targets that will never accept a drag.
 *
 * Whether a drag works is entirely the receiving page's call — some composers only take
 * files, some take nothing at all — and no amount of correctness on this end changes that.
 * The clipboard has no such veto, so everything draggable here is also copyable.
 */
async function copyWithProvenance(m, packetId, btn) {
    const text = exportText(m, packetId);

    const done = () => {
        if (!btn) return;
        btn.textContent = 'copied';
        setTimeout(() => { btn.textContent = '⧉ copy'; }, 1400);
    };

    try {
        // Both flavours, same reasoning as the drag: rich editors prefer the HTML.
        if (navigator.clipboard?.write && window.ClipboardItem) {
            await navigator.clipboard.write([new ClipboardItem({
                'text/plain': new Blob([text], { type: 'text/plain' }),
                'text/html': new Blob([exportHtml(m, packetId)], { type: 'text/html' })
            })]);
        } else {
            await navigator.clipboard.writeText(text);
        }
        return done();
    } catch {
        // The async clipboard is permission-gated and a browser may simply say no —
        // observed denied outright in an automation profile. Fall through rather than
        // report failure, because the old synchronous path asks no permission at all.
    }

    if (legacyCopy(text)) return done();
    flash('Could not reach the clipboard — the text is in the drag instead.', 4000);
}

/**
 * execCommand('copy'), kept alive on purpose.
 *
 * Deprecated, and still the only copy that works when clipboard-write is denied: it rides
 * the user's gesture instead of asking for a permission. Plain text only — the HTML
 * flavour is a nicety, being able to copy at all is not.
 */
function legacyCopy(text) {
    const pad = document.createElement('textarea');
    pad.value = text;
    pad.setAttribute('readonly', '');
    pad.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
    document.body.appendChild(pad);
    pad.select();

    let copied = false;
    try { copied = document.execCommand('copy'); } catch { copied = false; }
    pad.remove();
    return copied;
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

        // ⚠ A thread dragged OUT of Airlock used to paste its whole brief into whatever it
        // landed on (and Shift saved it as a file) — ungated, and never recorded, because a
        // drop into another app is invisible from here. That is a crossing by hand with no
        // ruling and no record, so it is gone. Carrying a thread out is "Carry out by hand":
        // ruled on first, recorded when it leaves. Dragging a thread now re-files it here.

        // MUST be copyMove, not copy. A tray/reorder drop sets dropEffect 'move', and the
        // drag model forces dropEffect to 'none' when it isn't permitted by effectAllowed —
        // so 'copy' alone silently makes every in-app thread drop illegal (no-entry cursor,
        // no drop event).
        dt.effectAllowed = 'copyMove';
        dt.setDragImage(makeDragChip(`<b>❖</b> ${escapeHtml(title)} <b>→</b>`), 16, 14);

        draggingThread = threadId;
        row.classList.add('dragging');
        document.body.classList.add('dragging-thread');   // opens every tray's landing strip
        flash(`"${title}" — drop on a tray or between threads to re-file it. `
            + 'To take it out of Airlock, use ⇱ Carry out.', 30000);
    });

    // Threads don't fork — only move or export — so Alt is inert here.
    row.addEventListener('drag', e => trail(e, dragMode(e, false)));

    row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        clearDragChip();
        clearTrails();
        clearInsertMarks();
        el.trays.querySelectorAll('.drop-target').forEach(n => n.classList.remove('drop-target'));
        document.body.classList.remove('dragging-thread');
        draggingThread = null;
        clearFlash();
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
        // From the single view or from a duet pane — the rail takes a packet from either.
        const source = document.querySelector(
            `#messages [data-packet="${packetId}"], .duet-list [data-message="${packetId}"]`);

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
        clearFlash();
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

// ─────────────────── Carry out by hand ───────────────────
//
// The brief is ruled on BEFORE it is shown: the secret scanner, then the local gate, over the
// whole thread — every reply in it, including any that quote files a participant read.
// Withheld, the brief is never put on screen, so it cannot be copied by accident. The
// crossing is recorded when the brief is copied or saved, because that is when it leaves;
// pasting a reply back is optional and records that reply as well.

const CARRY_TO_KEY = 'airlock.carry.to';
let carryCtx = null;        // { threadId, title, token, actor, forced }

async function openCarry(threadId = activeThread?.id, title = activeThread?.title) {
    if (!threadId) return flash('Open a thread first — carrying out means carrying a thread.', 5000);

    let saved = '';
    try { saved = localStorage.getItem(CARRY_TO_KEY) || ''; } catch { /* default below */ }
    el.carryTo.value = saved || 'a web chat';

    carryCtx = { threadId, title, token: null, actor: null, forced: false };
    el.handoffTitle.textContent = 'Carry out by hand';
    el.handoffMeta.innerHTML = `<b>${escapeHtml(title || 'this thread')}</b> — the whole thread, as a brief, `
        + 'to paste into a chat Airlock cannot see. It is ruled on first, exactly as a crossing '
        + 'over an API would be.';
    el.handoff.showModal();
    await ruleOnCarry();
}

async function ruleOnCarry({ force = false } = {}) {
    if (!carryCtx) return;
    const actor = el.carryTo.value.trim();
    if (!actor) { el.carryTo.focus(); return; }
    try { localStorage.setItem(CARRY_TO_KEY, actor); } catch { /* fine */ }

    carryCtx.token = null;
    el.carryReleased.hidden = true;
    el.recordBtn.hidden = true;
    el.carryAnyway.hidden = true;
    el.carryRuling.hidden = false;
    el.carryRuling.className = 'carry-ruling busy';
    el.carryRuling.textContent = force
        ? 'Carrying it past the gate…'
        : 'The gate is reading the brief before anything can leave…';

    const res = await json(`/api/threads/${carryCtx.threadId}/carry`, { actor, force });

    if (res.error) {
        el.carryRuling.className = 'carry-ruling bad';
        el.carryRuling.textContent = res.error;
        return;
    }

    if (!res.released) {
        // The brief is NOT on screen. Say why, and offer the deliberate override.
        const concerns = res.gate?.concerns?.length
            ? `<ul>${res.gate.concerns.map(c => `<li>${escapeHtml(String(c))}</li>`).join('')}</ul>` : '';
        el.carryRuling.className = 'carry-ruling withheld';
        el.carryRuling.innerHTML = `<b>The gate withheld this brief.</b>
            <p>${escapeHtml(res.gate?.reason || 'No reason given.')}</p>${concerns}
            <p class="stats">It is not shown, so it cannot be copied by accident. ${
                res.gate?.model || res.gate?.ruledBy ? `Ruled by ${escapeHtml(res.gate.model || res.gate.ruledBy)}.` : ''}</p>`;
        el.carryAnyway.hidden = false;
        return;
    }

    carryCtx = { ...carryCtx, token: res.token, actor, forced: Boolean(res.gate?.forced) };
    el.carryRuling.className = `carry-ruling ${res.gate?.forced ? 'forced' : 'released'}`;
    el.carryRuling.innerHTML = res.gate?.forced
        ? '<b>Carried past the gate.</b> The record will say you decided, permanently.'
        : `<b>Cleared to leave.</b> ${escapeHtml(res.gate?.reason || '')}`;
    el.brief.value = res.markdown;
    el.verdict.value = '';
    el.copyHint.textContent = '';
    el.signNote.textContent = `Copying or saving records ${res.packetIds.length} packet(s) as carried to `
        + `${actor}. A reply pasted back lands in ${carryCtx.title || 'the thread'} as its own packet.`;
    el.carryReleased.hidden = false;
    el.recordBtn.hidden = false;
}

/** The brief has left: record it now, with the ruling the server issued. */
async function markCarried() {
    if (!carryCtx?.token) return false;
    const res = await json(`/api/threads/${carryCtx.threadId}/carried`, { token: carryCtx.token });
    if (res.error) { el.copyHint.textContent = res.error; return false; }
    if (res.crossed) loadTree().catch(() => {});
    return true;
}

el.carryTo.addEventListener('change', () => ruleOnCarry());
el.carryTo.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); ruleOnCarry(); } });

el.carryAnyway.onclick = () => {
    if (!confirm('Carry this brief out even though the gate withheld it?\n\n'
        + 'The crossing will be recorded as FORCED, with you as the one who decided.')) return;
    ruleOnCarry({ force: true });
};

el.copyBrief.onclick = async () => {
    if (!carryCtx?.token) return;
    try {
        await navigator.clipboard.writeText(el.brief.value);
        el.copyHint.textContent = 'Copied — and recorded as carried out.';
    } catch {
        el.brief.select();
        el.copyHint.textContent = 'Clipboard blocked — the text is selected, press Ctrl+C. Recorded as carried out.';
    }
    await markCarried();
};

el.saveBrief.onclick = async () => {
    if (!carryCtx?.token) return;
    const slug = (carryCtx.title || 'thread').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const url = URL.createObjectURL(new Blob([el.brief.value], { type: 'text/markdown' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `airlock-brief-${slug}.md` });
    a.click();
    URL.revokeObjectURL(url);
    el.copyHint.textContent = 'Saved to your downloads — and recorded as carried out.';
    await markCarried();
};

el.recordBtn.onclick = async () => {
    if (!carryCtx?.token) return;
    const verdict = el.verdict.value.trim();
    if (!verdict) {
        el.copyHint.textContent = 'Paste their reply first — nothing to record yet.';
        el.verdict.focus();
        return;
    }

    const res = await json(`/api/threads/${carryCtx.threadId}/handoff`, { token: carryCtx.token, verdict });
    if (res.error) { el.copyHint.textContent = res.error; return; }

    const { actor, threadId, title } = carryCtx;
    el.handoff.close();
    await selectThread(threadId, title);
    flash(`${actor}'s reply is in ${title}, and ${res.signed} packet(s) are recorded as carried to them.`, 7000);
};

el.handoffClose.onclick = () => el.handoff.close();
el.handoffCancel.onclick = () => el.handoff.close();

// Text files a composer folds straight into the message. Shared with duet.js.
const TEXT_ATTACH = /\.(md|markdown|txt|text|json|jsonl|csv|tsv|log|ya?ml|toml|ini|cfg|conf|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|cs|sql|sh|ps1|bat|vbs|html?|css|scss|svg|scad|xml)$/i;

// ─────────────────────────── wiring ───────────────────────────

el.newChat.onclick = () => newThread();
el.carryOut.onclick = () => openCarry();

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

el.model.onchange = async () => {
    // Persisted server-side, so the choice survives a reload, a different browser
    // and a restart — and so there is only ever one answer to "which model".
    try {
        await json('/api/config', { model: el.model.value });
    } catch {
        flash('Could not save that model choice; it applies to this session only.', 6000);
    }
};

(async () => {
    renderLanding();
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
})();
