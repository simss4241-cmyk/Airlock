// Node 20.6+ reads .env natively, so the remote tier needs no dotenv dependency.
// Absent .env is not an error: Airlock runs fully local without one.
try { process.loadEnvFile(); } catch { /* no .env; local tier only */ }

const express = require('express');
const fs = require('fs').promises;
const path = require('path');

const store = require('./db');
const files = require('./files');
const providers = require('./providers');
const { runGate, resolveGateModel } = require('./boundary');
const kernel = require('./kernel');
const sandbox = require('./sandbox');
const auth = require('./auth');
const duet = require('./duet-store');
const { generate: generateDuet, queueState } = require('./duet-runner');

const app = express();

const PORT = Number(process.env.PORT) || 8100;
const egress = require('./providers/egress');
const { OLLAMA } = egress;              // one definition, shared with providers/ollama.js
// Overridable so a hosted instance can keep config outside the code directory,
// and so the first-run path is testable without moving the developer's own file.
const CONFIG_FILE = process.env.AIRLOCK_CONFIG || path.join(__dirname, 'airlock-config.json');

// Meta's recommended sampling for Muse Glimmer: temp 1.0 / top_p 0.95 / top_k 64.
// num_ctx is deliberately NOT 128K — on a 16GB card the KV cache for full context
// would evict the weights. 8192 is a sane desk default; raise it in Settings.
const DEFAULTS = {
    // Resolved at boot by pickDefaultModel(), not hardcoded. A fixed default is
    // wrong for somebody: naming a local model means a fresh clone opens on a
    // model that has not been downloaded — and muse-glimmer in particular is an
    // 18 GB pull that Ollama currently refuses outright on Windows/NVIDIA.
    model: null,
    temperature: 1.0,
    top_p: 0.95,
    top_k: 64,
    num_ctx: 8192,
    keep_alive: '10m',
    // The local model reasons in a separate channel before answering. It's the model's whole
    // point, but on a partially-offloaded 30B it costs ~3.7x the wall clock for simple
    // questions (measured: 33.7s vs 9.1s for a two-word answer). Toggleable per taste.
    think: true,
    // How many duet generations may run at once on the LOCAL tier. One is not timidity:
    // two 30B streams on 16 GB of VRAM is slower than running them back to back, and the
    // queue is visible in the UI so the wait is honest rather than mysterious. The remote
    // tier is not throttled by this — see queueFor() in duet-runner.js.
    maxConcurrent: 1,
    // NOTE: `workspaceRoot` and `tools` are deliberately absent, and this list is also the
    // allowlist for POST /api/config. Workspaces are per-thread and live in the database, so
    // the retired global root cannot be written back here and re-migrated; and whether tools
    // are offered is decided per request by whether that thread has a usable workspace, so a
    // global tools flag had no effect except to make the config file look like it did.
    // Sent on every turn, and it crosses the boundary with the conversation when
    // an Oversight model is selected - so it names no one and no machine.
    //
    // It earns its length by telling the model the one thing it cannot infer: an
    // answer here is not a chat message, it is a packet that will be read later,
    // out of order, possibly by a reviewer who was never in the conversation.
    systemPrompt: [
        'You are Airlock, a local-first reasoning desk.',
        '',
        'What you write is saved as a packet inside a thread, and a larger model may',
        'later review that thread across the boundary. Write so that a reader arriving',
        'with no other context can follow it.',
        '',
        'Lead with the answer, then the reasoning behind it. Be specific: name files,',
        'lines, commands and versions rather than gesturing at them. Use code blocks',
        'for code.',
        '',
        'Say plainly when you are not sure, and say what would settle it. An honest',
        '"I do not know, and here is how to find out" beats a confident guess.',
        '',
        'Do not pad. No preamble, no restating the question, no offer to help further.'
    ].join('\n')
};

// ─────────────────────── Workspace tools ───────────────────────
// Defined in workspace-tools.js, shared with the duet runner so a tool result is the same
// thing to the kernel, and to the crossing record, whichever path produced it.

const { MAX_TOOL_ROUNDS, TOOLS, usableRoot, runCalls } = require('./workspace-tools');

/**
 * Per-model capabilities, cached.
 *
 * Sending `think` to a model without "thinking" is a hard 400 — `"llama3.2:latest" does not
 * support thinking` — and so is sending `tools` to one without "tools" (codellama has
 * neither). Both flags must therefore be gated per model, not set globally from config.
 */
// Capability lookup moved into the provider layer: a remote model has no
// /api/show to ask, so each provider answers for its own models.
const modelCaps = model => providers.capabilities(model);

// ── config: the operator's, and on a hosted instance each visitor's own on top ──
//
// `baseConfig` is the file: the operator's settings, and on a desk simply the settings.
// `config` is what a request should see — a READ-ONLY view. On a desk it is baseConfig.
// With sandboxes on it is baseConfig overlaid with the current visitor's own choices,
// kept in their sandbox, so one visitor changing the model or the system prompt no
// longer changes it for everyone. Reads, spreads and res.json(config) all work on the
// view; a write to it throws, because a write there would have to mean one of two
// different things and the code should say which.
let baseConfig = { ...DEFAULTS };

/**
 * What a visitor may change for themselves. Everything else in DEFAULTS affects the host
 * and so every other visitor: num_ctx (a huge context pushes the model off the GPU for
 * all of them), keep_alive (pins models in memory), maxConcurrent (the limit on the
 * SHARED generation queue). Those stay the operator's.
 */
const VISITOR_KEYS = ['model', 'temperature', 'top_p', 'top_k', 'think', 'systemPrompt'];
const OVERLAY_KEY = 'config_overlay';

function visitorOverlay() {
    if (!sandbox.sandboxed() || !sandbox.inContext()) return null;
    try { return JSON.parse(store.getMeta(OVERLAY_KEY) || 'null'); } catch { return null; }
}
const effectiveConfig = () => {
    const overlay = visitorOverlay();
    return overlay ? { ...baseConfig, ...overlay } : baseConfig;
};

const config = new Proxy({}, {
    get: (_, key) => effectiveConfig()[key],
    has: (_, key) => key in effectiveConfig(),
    ownKeys: () => Reflect.ownKeys(effectiveConfig()),
    getOwnPropertyDescriptor: (_, key) => {
        const e = effectiveConfig();
        return key in e ? { value: e[key], enumerable: true, configurable: true, writable: false } : undefined;
    },
    set: () => { throw new TypeError('config is a read-only view: write baseConfig, or the visitor overlay'); },
    deleteProperty: () => { throw new TypeError('config is a read-only view'); }
});

app.use(express.json({ limit: '32mb' }));  // images ride along as base64

// Static assets stay open deliberately: the page must be able to load in order
// to prompt for a token. It ships no data of its own — everything comes from
// /api, which is guarded.
app.use(express.static(path.join(__dirname, 'public')));

// The secret scanner, for the page: the same file boundary.js runs, so a message dragged or
// copied out is checked by exactly the rules a crossing is. Open like the other static
// assets — it is patterns, not data.
app.get('/secrets.js', (req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'secrets.js')));

/**
 * Who is answering on this port.
 *
 * Mounted BEFORE the auth guard, and deliberately so: this is what the launchers use to
 * tell "Airlock is already running" apart from "something else has the port", and a
 * launcher has no token to present. It reveals nothing — the page's <title> already says
 * Airlock to anyone who opens it.
 *
 * It exists because it was needed. Airlock is a fork of Glimmer and the two shared port
 * 8100 for a while; both launchers checked only whether *something* was listening, so
 * whichever app started first quietly owned both desktop shortcuts — clicking Airlock
 * opened Glimmer, in a window titled Glimmer, and the .bat cheerfully reported "Airlock
 * server is already running". Glimmer has since moved to :8101, but a socket check that
 * cannot name what answered is the actual bug and this is the fix for it.
 */
app.get('/api/whoami', (req, res) => res.json({ app: 'airlock', port: PORT }));

app.use('/api', auth.guard);

// Hosted with AIRLOCK_SANDBOXES=1: every visitor gets a private database, and everything
// below runs inside it — each store call is routed to the visitor whose request made it.
// On a desk this does nothing. What a desk does once at boot, a sandbox does once when it
// is opened: settle stranded duet replies, and seat participants on its threads.
app.use('/api', sandbox.middleware({
    exempt: ['/whoami'],
    onOpen: async () => {
        duet.resetStaleGenerations();
        await seatExistingThreads();
    }
}));

// Lets the page discover whether it needs a token before it asks for anything
// else, so an unauthorised visitor sees a prompt rather than a wall of 401s.
app.get('/api/access', (req, res) => res.json({
    ok: true, demo: Boolean(process.env.AIRLOCK_DEMO), ...auth.remoteSpend()
}));

/**
 * Which model the app opens on, when the user has not chosen one.
 *
 * Remote first, and that is a deliberate inversion of "local-first". The
 * reasoning: a remote model works the moment a key exists, with nothing to
 * download, whereas a local default sends a new arrival to fetch 18 GB before
 * the app does anything at all. Local-first is a claim about where your data
 * rests by default, not about which dropdown entry is preselected.
 *
 * It also makes the first message demonstrate the product. Opening on a
 * Nemotron model means the very first turn hits the local gate, so the boundary
 * is something you watch happen rather than read about.
 *
 * A saved config always wins — this only fills a blank.
 */
async function pickDefaultModel() {
    const wanted = process.env.AIRLOCK_MODEL_DEFAULT || process.env.AIRLOCK_MODEL_VERDICT;
    if (process.env.NEBIUS_API_KEY && wanted) return wanted;

    // No key: a local model that will actually run here — see defaultLocalModel for why
    // that is not "the largest one installed". Cloud entries are excluded inside it:
    // they are listed by the local Ollama but answered on ollama.com, and "no key, so
    // stay local" is the whole premise of this branch.
    const local = await require('./providers/ollama').list().catch(() => []);
    return providers.defaultLocalModel(local);   // null: nothing reachable, and the UI says so
}

async function loadConfig() {
    try {
        baseConfig = { ...DEFAULTS, ...JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8')) };
    } catch { /* first run, no config yet */ }

    if (!baseConfig.model) baseConfig.model = await pickDefaultModel();

    // Before workspaces belonged to threads, one global root lived in the JSON config.
    // Copy it to each existing thread exactly once, then delete the key outright rather
    // than blanking it — an empty hook is still a hook. db.migrateWorkspaceRoot keeps its
    // own marker, so even a config restored from before this change won't re-run it.
    if ('workspaceRoot' in baseConfig) {
        // A desk's own migration. Hosted there is no single database to migrate, and a
        // global root is exactly what a visitor must never inherit.
        if (baseConfig.workspaceRoot && !sandbox.sandboxed()) store.migrateWorkspaceRoot(path.resolve(baseConfig.workspaceRoot));
        delete baseConfig.workspaceRoot;
        await saveConfig();
    }

    // Same treatment for the retired global tools flag: a key that reads like a switch but
    // controls nothing is worse than no key, so drop it rather than leave it lying there.
    if ('tools' in baseConfig) {
        delete baseConfig.tools;
        await saveConfig();
    }
}

async function saveConfig() {
    await fs.writeFile(CONFIG_FILE, JSON.stringify(baseConfig, null, 2), 'utf8');
}

// ── Config ──
app.get('/api/config', (req, res) => res.json(config));

app.post('/api/config', async (req, res) => {
    // Hosted: a visitor's changes go into their own sandbox, limited to what is theirs to
    // change. Anything else they send is ignored, not an error — the page sends the whole
    // settings form, and the host-wide fields in it are simply not theirs.
    if (sandbox.sandboxed()) {
        const overlay = visitorOverlay() || {};
        for (const key of VISITOR_KEYS) {
            if (req.body[key] !== undefined) overlay[key] = req.body[key];
        }
        store.setMeta(OVERLAY_KEY, JSON.stringify(overlay));
        return res.json(config);
    }

    for (const key of Object.keys(DEFAULTS)) {
        if (req.body[key] !== undefined) baseConfig[key] = req.body[key];
    }
    await saveConfig();
    res.json(config);
});

// Which Oversight seats can cross on their own, and with which model. The model
// ids live in .env so there is one source of truth; the markup only names actors.
// A seat with no model configured simply is not live, and its drop falls back to
// the manual brief — which is why the committee still works with no key at all.
function liveSeats() {
    return [
        { actor: 'Nemotron Nano',  model: process.env.AIRLOCK_MODEL_CLASSIFIER },
        { actor: 'Nemotron Super', model: process.env.AIRLOCK_MODEL_VERDICT },
        { actor: 'Nemotron Ultra', model: process.env.AIRLOCK_MODEL_DEEP }
    ].filter(s => s.model && process.env.NEBIUS_API_KEY);
}

// Remote-tier models, with their declared capabilities. Never throws: a missing
// key, a network blip or a bad key all mean the same thing to the UI — no seats.
// Nemotron in capability order rather than alphabetical order, which scatters
// them (Nano lands under N, Super under n, Ultra under N again). The dropdown
// should read the way the tiers actually escalate.
const NEMOTRON_RANK = [
    [/nano/i,      1],
    [/super/i,     2],
    [/ultra/i,     3],
    [/lightning/i, 4]
];

function nemotronRank(id) {
    for (const [pattern, rank] of NEMOTRON_RANK) if (pattern.test(id)) return rank;
    return 5;
}

/**
 * Remote-tier models, grouped.
 *
 * Token Factory serves far more than Nemotron, and all of it is genuinely
 * usable, so nothing is hidden — a router that reaches one vendor is not a
 * router. But Nemotron is the tier this is built around, so it is separated and
 * ordered by escalation rather than being buried alphabetically among twenty
 * others.
 *
 * AIRLOCK_REMOTE_ALLOW narrows the list to comma-separated substrings when a
 * curated demo wants fewer choices on screen.
 */
async function remoteModels() {
    try {
        const tf = require('./providers/tokenfactory');
        const list = await tf.list();
        const caps = await tf.capabilities();

        const allow = (process.env.AIRLOCK_REMOTE_ALLOW || '')
            .split(',').map(x => x.trim().toLowerCase()).filter(Boolean);

        return list
            .filter(m => !allow.length || allow.some(a => m.id.toLowerCase().includes(a)))
            .map(m => ({
                name: m.id,
                tier: m.tier,
                caps,
                family: /nemotron/i.test(m.id) ? 'nemotron' : 'other'
            }))
            .sort((a, b) => {
                if (a.family !== b.family) return a.family === 'nemotron' ? -1 : 1;
                if (a.family === 'nemotron') {
                    const r = nemotronRank(a.name) - nemotronRank(b.name);
                    if (r) return r;
                }
                return a.name.localeCompare(b.name);
            });
    } catch { return []; }
}

// ── Health: is Ollama up, is the local model actually installed, what else is available ──
app.get('/api/health', async (req, res) => {
    try {
        // The poll that keeps the registry current: a model pulled while Airlock is
        // running becomes gateable by the next health tick rather than at the next
        // restart. Deliberately a forced refresh, not ensureFresh — this endpoint is
        // the one place where paying for a catalogue fetch is the whole point.
        await providers.refreshRegistry().catch(() => {});

        const [tagsRes, verRes] = await Promise.all([
            egress.local(`${OLLAMA}/api/tags`),
            egress.local(`${OLLAMA}/api/version`).catch(() => null)
        ]);
        const { models = [] } = await tagsRes.json();
        const version = verRes && verRes.ok ? (await verRes.json()).version : null;

        // Whatever is loaded right now gets measured, so a model that ran and was
        // evicted between polls is the only kind that goes unread.
        await require('./providers/ollama').observeResidency().catch(() => {});
        const { residencyOf } = require('./providers/ollama');

        const withCaps = await Promise.all(models.map(async m => {
            // ⚠ Tier from the registry, not asserted. This used to be the literal
            // 'local' for every entry Ollama listed — which labelled an Ollama cloud
            // model "stays on this machine" in the picker while it ran on ollama.com.
            const tier = providers.tierOf(m.name);
            const cloud = tier === 'remote';
            return {
                name: m.name,
                // A cloud entry's size is a manifest stub, not weights; showing it as
                // "0.0 GB" would read like a very small local model.
                size: cloud ? null : m.size,
                tier,
                ...(cloud ? { via: 'ollama-cloud' } : {}),
                family: m.details?.family,
                residency: cloud ? null : residencyOf(m.name),
                caps: await modelCaps(m.name)     // cached, so only the first call costs anything
            };
        }));
        withCaps.sort((a, b) => a.name.localeCompare(b.name));

        // The remote tier is optional. No key means no seats past the boundary,
        // and the dropdown simply shows the local models — not an error state.
        const remote = await remoteModels();

        res.json({
            ollama: true,
            version,
            models: [...withCaps, ...remote],
            remoteTier: remote.length > 0,
            seats: liveSeats(),
            demo: Boolean(process.env.AIRLOCK_DEMO),
            sandbox: sandbox.sandboxed() ? { ...sandbox.summary(), remote: auth.remoteSpend() } : null,
            // Any model positively on this side of the boundary — not one model by name.
            // This used to test for muse-glimmer, inherited from Glimmer, so nearly every
            // desk showed "Local model not pulled" beside a working local model. It
            // matters beyond the dot: with nothing local installed there is no gate, and
            // every crossing is refused.
            localModelInstalled: providers.localModels().length > 0,
            activeModel: config.model,
            // Which local model rules on crossings right now — the same resolution runGate
            // makes, so the boundary bar names the gate that will actually run. null means
            // none is reachable, and every crossing will be refused.
            gate: await resolveGateModel(config).catch(() => null)
        });
    } catch (err) {
        // Ollama being down must not take the remote tier with it.
        const remote = await remoteModels();
        res.json({
            ollama: false,
            error: err.message,
            models: remote,
            remoteTier: remote.length > 0,
            seats: liveSeats(),
            demo: Boolean(process.env.AIRLOCK_DEMO),
            sandbox: sandbox.sandboxed() ? { ...sandbox.summary(), remote: auth.remoteSpend() } : null,
            localModelInstalled: false
        });
    }
});

// ── Chat: stream Ollama's NDJSON straight through, and abort if the client leaves ──
app.post('/api/chat', async (req, res) => {
    // One visitor, a bounded number of generations at once. The GPU and the duet queue are
    // shared by every visitor on a hosted instance; without this, one tab sending in a loop
    // starves the rest. A no-op on a desk.
    const slot = sandbox.takeSlot();
    if (!slot) {
        return res.status(429).json({ error: 'You already have replies in progress. '
            + 'Wait for one to finish, or stop it, before sending another.' });
    }
    res.on('close', slot);
    res.on('finish', slot);

    const controller = new AbortController();

    // Abort upstream only when the *response* closes early (user hit Stop / closed the
    // window). Do NOT hang this off `req` — express.json() drains the body, Node then
    // auto-destroys the consumed stream, and req emits 'close' before we ever call Ollama.
    res.on('close', () => {
        if (!res.writableEnded) controller.abort();
    });

    const { messages, model, threadId, packetIds = [] } = req.body;

    const chosen = model || config.model;
    const caps = await modelCaps(chosen);
    const canThink = caps.includes('thinking');
    const workspaceRoot = threadId ? store.getThread(Number(threadId))?.workspace_root : null;

    // usableRoot: the folder still exists, and is still permitted — see workspace-tools.js.
    const useTools = await usableRoot(workspaceRoot) && caps.includes('tools');

    // The conversation grows as tools run: assistant tool_calls, then tool results.
    const convo = [...messages];

    // Flushed lazily, on the first byte we actually write. The upstream call does
    // not happen until the generator is first pulled, so a refusal (bad key, model
    // gone, Ollama down) still lands before any header and can be answered with a
    // real status code instead of an error chunk inside a 200 stream.
    const ensureHeaders = () => {
        if (res.headersSent) return;
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.setHeader('Cache-Control', 'no-cache');
        res.flushHeaders();
    };
    const send = obj => { ensureHeaders(); res.write(JSON.stringify(obj) + '\n'); };

    // Every tool round is a real Ollama call that really costs tokens, but only the last
    // round's `done` chunk reaches the client (see below). Total them here or a tool-using
    // answer looks as cheap as a one-shot reply.
    const usage = { prompt: 0, reply: 0, rounds: 0 };
    let usageSent = false;
    const sendUsage = () => {
        if (usageSent) return;
        usageSent = true;
        send({ airlock_usage: usage });
    };

    // ── the boundary ──
    //
    // Every request to a model that is not positively local is ruled on by kernel.js, and
    // every TURN is: a clearance covers the exact messages it was issued for, so a secret
    // typed on turn nine is judged on turn nine. It used to be once per thread, with the
    // answer remembered — affordable only because the gate model was slow. Only what has
    // not been ruled on before is sent to the gate, so a long thread does not re-read its
    // own history every turn.
    //
    // ⚠ `crosses` is `!== 'local'`, never `=== 'remote'`: a model nothing recognises is
    // treated as a crossing. The inverted test used to skip the gate for any tier that was
    // not the exact string 'remote'.
    //
    // The first ruling happens before any header is written, so a refusal is a clean 200
    // with the reason rather than an error inside a stream.
    const tier = providers.tierOf(chosen);
    const crosses = tier !== 'local';
    let gateRuling = null;
    let clearance = null;

    if (crosses) {
        const first = await kernel.clear({ model: chosen, messages: convo, config });
        if (!first.ok) {
            // Nothing has been sent. 200, because the request succeeded and the
            // answer was no — the client renders the reason rather than an error.
            return res.status(200).json({ blocked: true, gate: first.ruling, tier });
        }
        clearance = first.token;
        gateRuling = first.ruling;
    }

    // Tool results that have been produced but not yet sent. They are not packets, so the
    // packet-level crossing record cannot see them; they are recorded against the request
    // that caused them, as they cross. See store.recordArtifactCrossing.
    let pendingArtifacts = [];
    const anchorPacket = packetIds.length ? packetIds[packetIds.length - 1] : null;

    try {
        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
            const lastRound = round === MAX_TOOL_ROUNDS;   // stop offering tools; force an answer
            let roundRecorded = false;

            if (crosses) {
                // ⚠ Every round after the first carries something new: the tool results
                // the model asked for. Those are file contents, and they used to follow the
                // round-0 ruling out of the machine without one of their own. The kernel
                // rules on just what is new; a refusal stops the turn here, before any of
                // it is sent, and says which results were withheld.
                if (round > 0) {
                    const next = await kernel.clear({ model: chosen, messages: convo, config });
                    if (!next.ok) {
                        send({
                            airlock_blocked: {
                                gate: next.ruling,
                                round,
                                withheld: pendingArtifacts.map(a => a.label)
                            }
                        });
                        sendUsage();
                        return res.end();
                    }
                    clearance = next.token;
                    gateRuling = next.ruling;
                }

                // Every round is a separately billed remote call, so every round is charged.
                // This used to be round 0 only, and tested `=== 'remote'`.
                const over = auth.spendRemote();
                if (over) {
                    if (!res.headersSent) return res.status(429).json({ error: over });
                    send({ error: over });
                    break;
                }
            }

            // One generator whatever the tier: the provider layer has already
            // normalised the remote stream into this same chunk shape.
            const stream = providers.chat({
                model: chosen,
                messages: convo,
                config,
                // Omitted entirely when unsupported - sending `false` is still a request
                // to a model that has no thinking channel.
                ...(canThink ? { think: config.think !== false } : {}),
                tools: useTools && !lastRound ? TOOLS : undefined,
                signal: controller.signal,
                // Checked by providers.chat and again by egress; if it no longer covers
                // what is being sent, the gate runs there instead of the request going.
                clearance
            });

            // Collect rather than blind-pipe: we need the tool calls, and the per-round
            // `done` chunk must not reach the client until the last round or it would
            // finalise the message while tools are still running.
            let content = '', thinking = '', toolCalls = [], finalChunk = null;

            for await (const chunk of stream) {
                // First chunk back proves the request was accepted, which is the
                // moment the content is provably across. Recording on dispatch
                // instead would log crossings that never happened.
                //
                // ⚠ `crosses`, not `tier === 'remote'` — the same polarity as the gate, so
                // a turn that was gated as a crossing is also recorded as one.
                if (crosses && !roundRecorded) {
                    roundRecorded = true;
                    try {
                        const opts = { actor: chosen, model: chosen, transport: 'chat', gate: gateRuling };
                        if (round === 0) store.recordCrossings(packetIds, opts);
                        if (pendingArtifacts.length) {
                            if (anchorPacket) store.recordArtifactCrossing(anchorPacket, { ...opts, artifacts: pendingArtifacts });
                            else console.error('tool results crossed with no packet to record them against:',
                                pendingArtifacts.map(a => a.label).join(', '));
                            pendingArtifacts = [];
                        }
                    } catch (err) {
                        console.error('crossing not recorded:', err.message);
                    }
                }

                if (chunk.message?.thinking) thinking += chunk.message.thinking;
                if (chunk.message?.content) content += chunk.message.content;
                if (chunk.message?.tool_calls?.length) toolCalls.push(...chunk.message.tool_calls);

                if (chunk.done) { finalChunk = chunk; continue; }
                ensureHeaders();
                res.write(JSON.stringify(chunk) + '\n');
            }

            if (finalChunk) {
                usage.prompt += finalChunk.prompt_eval_count ?? 0;
                usage.reply += finalChunk.eval_count ?? 0;
                usage.rounds++;
            }

            // No tools requested — this round is the answer. Usage goes first so the client
            // has the totals before `done` finalises the message.
            if (!toolCalls.length) {
                sendUsage();
                if (finalChunk) send(finalChunk);
                break;
            }

            const asked = {
                role: 'assistant',
                content,
                ...(thinking ? { thinking } : {}),
                tool_calls: toolCalls
            };
            convo.push(asked);

            // The model's own request, going back to the model that made it, is not new
            // exposure — only the results it asked for are. Acknowledged so the next
            // ruling judges the file contents, not the far side's own words.
            if (crosses) kernel.acknowledge([asked]);

            for (const { message, card, artifact } of await runCalls(toolCalls, workspaceRoot)) {
                // Custom line the client renders as a tool card. Ollama never emits this key.
                send({ airlock_tool: card });
                convo.push(message);
                if (crosses) pendingArtifacts.push(artifact);
            }
        }

        // Reached only if the loop ran out of rounds while the model was still asking for
        // tools. Rare, but the tokens were still spent, so don't lose them.
        sendUsage();
        res.end();
    } catch (err) {
        if (err.name === 'AbortError') return;   // user hit Stop; nothing to report

        // The safety net in providers.chat() ran the gate itself and it said no. Nothing
        // was sent; answer it the way a refusal is answered, not as a malfunction.
        if (err.name === 'GateRefusal') {
            if (!res.headersSent) return res.status(200).json({ blocked: true, gate: err.gate, tier: err.tier });
            send({ airlock_blocked: { gate: err.gate, withheld: pendingArtifacts.map(a => a.label) } });
            return res.end();
        }

        const tier = err.tier || 'local';
        console.error(`${tier} provider error:`, err.message);

        if (!res.headersSent) {
            // Pass an upstream status straight through where there is one. A 401 from
            // the remote tier is a key problem, not a gateway problem, and answering
            // 502 would send the user hunting in the wrong place.
            if (err.status) res.status(err.status).json({ error: err.message });
            else res.status(502).json({ error: 'Ollama unreachable: ' + err.message });
        } else {
            send({ error: err.message });
            res.end();
        }
    }
});

// ─────────────────────── Workspace ───────────────────────

const workspaceState = async threadId => {
    const thread = store.getThread(Number(threadId));
    if (!thread) throw new Error('Pick a thread before choosing a workspace.');

    const root = thread.workspace_root || null;
    const exists = root ? await fs.access(root).then(() => true).catch(() => false) : false;
    const policy = files.workspacePolicy();
    const permitted = root ? await files.permitRoot(root).then(() => true, () => false) : true;
    return {
        threadId: thread.id,
        threadTitle: thread.title,
        root,
        exists,
        permitted,
        // What a visitor may open, so the UI can offer it instead of a path to guess.
        policy: policy.mode,
        allowedRoots: policy.roots,
        tools: TOOLS.map(tool => tool.function.name)
    };
};

app.get('/api/workspace', async (req, res) => {
    try {
        res.json(await workspaceState(req.query.threadId));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/workspace', async (req, res) => {
    const { root, threadId } = req.body;

    try {
        const thread = store.getThread(Number(threadId));
        if (!thread) throw new Error('Pick a thread before choosing a workspace.');

        if (!root) {
            store.setThreadWorkspace(thread.id, null);
            return res.json(await workspaceState(thread.id));
        }

        // Absolute only. path.resolve would happily read a bare "CFE" as relative to
        // wherever the server was started, quietly rooting the thread at
        // airlock-ui\CFE — a real folder, just not the one that was typed.
        const typed = String(root).trim();
        if (!path.isAbsolute(typed)) {
            throw new Error(`Needs a full path starting from a drive letter, not "${typed}".`);
        }

        const resolved = path.resolve(typed);
        const stat = await fs.stat(resolved);
        if (!stat.isDirectory()) throw new Error('Not a directory.');
        await files.permitRoot(resolved);          // the allowlist, on a hosted instance
        store.setThreadWorkspace(thread.id, resolved);
        res.json(await workspaceState(thread.id));
    } catch (err) {
        const message = err.message === 'Not a directory.'
            ? `Not a usable folder: ${root}`
            : err.message;
        res.status(400).json({ error: message });
    }
});

/**
 * Native folder picker, via a temp script to dodge quoting hell.
 *
 * The dialog gets an explicit **owner**: a transparent, TopMost form centred on the active
 * screen. Passing a null owner
 * (`Shell.Application.BrowseForFolder(0, …)`, or `ShowDialog()` with no argument) leaves the
 * dialog ownerless, so Windows is free to open it *behind* the browser — it looks like
 * nothing happened. A TopMost owner makes it come to the front.
 */
app.get('/api/workspace/browse', async (req, res) => {
    // A native folder dialog on the SERVER's desktop, starting in the server's home
    // directory, holding the request open for up to three minutes. On a desk that is the
    // user's own screen. Anywhere workspaces are restricted it is someone else's machine,
    // so it is not offered at all — the allowed roots are listed instead.
    const policy = files.workspacePolicy();
    if (policy.mode !== 'any') {
        return res.status(403).json({
            error: policy.mode === 'off'
                ? 'Workspaces are off on this instance.'
                : 'The folder picker is not available here. Allowed workspaces: ' + policy.roots.join(', '),
            allowedRoots: policy.roots
        });
    }
    const os = require('os');
    const { execFile } = require('child_process');
    const tmp = path.join(os.tmpdir(), `airlock-pick-${process.pid}-${Date.now()}.ps1`);

    const thread = store.getThread(Number(req.query.threadId));
    if (!thread) return res.status(400).json({ error: 'Pick a thread before browsing.' });

    const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type -AssemblyName System.Drawing',
        'Add-Type @"',
        'using System;',
        'using System.Runtime.InteropServices;',
        'public static class AirlockPickerForeground {',
        '    private delegate bool EnumWindowsProc(IntPtr window, IntPtr state);',
        '    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr state);',
        '    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);',
        '    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int cx, int cy, uint flags);',
        '    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);',
        '    public static bool RaiseOwned(IntPtr owner) {',
        '        bool raised = false;',
        '        EnumWindows(delegate(IntPtr window, IntPtr state) {',
        '            if (GetWindow(window, 4) != owner) return true;',
        '            SetWindowPos(window, new IntPtr(-1), 0, 0, 0, 0, 0x0043);',
        '            SetForegroundWindow(window);',
        '            raised = true;',
        '            return false;',
        '        }, IntPtr.Zero);',
        '        return raised;',
        '    }',
        '}',
        '"@',
        '[System.Windows.Forms.Application]::EnableVisualStyles()',
        '',
        '$owner = New-Object System.Windows.Forms.Form',
        "$owner.Text = 'Airlock'",
        "$owner.StartPosition = 'Manual'",
        '$screen = [System.Windows.Forms.Screen]::FromPoint([System.Windows.Forms.Cursor]::Position).WorkingArea',
        '$owner.Location = [System.Drawing.Point]::new($screen.Left + [int]($screen.Width / 2), $screen.Top + [int]($screen.Height / 2))',
        '$owner.Size = New-Object System.Drawing.Size(1, 1)',
        '$owner.Opacity = 0.01',
        '$owner.ShowInTaskbar = $false',
        '$owner.TopMost = $true',
        '$owner.Show()',
        '$owner.BringToFront()',
        '$owner.Activate()',
        'if ($env:AIRLOCK_PICKER_PROBE -eq "1") { $owner.Close(); exit 0 }',
        '',
        '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog',
        '$dlg.Description = "Pick Airlock\'s workspace root"',
        '$dlg.ShowNewFolderButton = $false',
        'if ($env:AIRLOCK_START -and (Test-Path $env:AIRLOCK_START)) { $dlg.SelectedPath = $env:AIRLOCK_START }',
        '',
        '$timer = New-Object System.Windows.Forms.Timer',
        '$timer.Interval = 200',
        '$timer.Add_Tick({ if ([AirlockPickerForeground]::RaiseOwned($owner.Handle)) { $timer.Stop() } })',
        '$timer.Start()',
        'try { $result = $dlg.ShowDialog($owner) } finally {',
        '    $timer.Stop()',
        '    $timer.Dispose()',
        '    $owner.Close()',
        '}',
        'if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.SelectedPath }'
    ].join('\r\n');

    // Open somewhere useful rather than at This PC. Falls back to the user's home
    // directory: an absolute path baked in here exists on exactly one machine and
    // the picker silently opens nowhere on every other one.
    const start = thread.workspace_root || os.homedir();

    try {
        await fs.writeFile(tmp, script, 'utf8');
        const picked = await new Promise((resolve, reject) => {
            execFile('powershell.exe',
                ['-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', tmp],
                { timeout: 180000, env: { ...process.env, AIRLOCK_START: start } },
                (err, stdout, stderr) => {
                    if (err && !stdout.trim()) {
                        return reject(new Error(stderr.trim() || err.message));
                    }
                    resolve(stdout.trim());
                });
        });
        res.json({ path: picked || null, cancelled: !picked });
    } catch (err) {
        res.status(500).json({ error: `Folder picker failed: ${err.message}` });
    } finally {
        fs.unlink(tmp).catch(() => {});
    }
});

// Direct filesystem access for the UI (the same functions the tools call).
const fsRoute = handler => async (req, res) => {
    try {
        res.json(await handler(req));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

const requestWorkspace = async req => {
    const thread = store.getThread(Number(req.query.threadId));
    if (!thread) throw new Error('Pick a thread first.');
    if (thread.workspace_root) await files.permitRoot(thread.workspace_root);
    return thread.workspace_root;
};

app.get('/api/fs/list', fsRoute(async req => files.listDirectory(await requestWorkspace(req), req.query.path || '.')));
app.get('/api/fs/read', fsRoute(async req => files.readTextFile(await requestWorkspace(req), req.query.path)));
app.get('/api/fs/find', fsRoute(async req => files.findFiles(await requestWorkspace(req), req.query.q)));

// ─────────────────────── Duet: two participants, one conversation ───────────────────────
//
// The thread is the conversation; the panes are filtered views over it. Nothing here keeps
// a second log, and nothing here talks to a model directly — duet-runner.js orchestrates,
// providers/ transports, and boundary.js rules on anything that would leave the machine.
//
// ⚠ A duet crossing exposes the OTHER participant's words too. Asking a remote participant
// sends it the shared conversation, so the gate reads the whole assembled context and the
// crossing is recorded against every packet that was actually in it. See duet-runner.js.

const duetRoute = handler => async (req, res) => {
    try {
        res.json(await handler(req));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

/** Everything a client needs to paint both panes, in one round trip. */
async function duetState(threadId) {
    const thread = store.getThread(Number(threadId));
    if (!thread) throw new Error(`No thread ${threadId}`);

    const participants = duet.getParticipants(thread.id).map(p => ({
        ...p,
        // Resolved here, never stored and never accepted from the client: which side of
        // the boundary a participant sits on is a fact about its model id.
        tier: p.model ? providers.tierOf(p.model) : null
    }));

    return {
        thread: { id: thread.id, title: thread.title, folder: thread.folder_name },
        enabled: participants.length > 0,
        userName: duet.USER_NAME,
        participants,
        messages: participants.length ? duet.getConversation(thread.id) : [],
        queue: queueState()
    };
}

app.get('/api/duet/:id', duetRoute(req => duetState(req.params.id)));

app.post('/api/duet/:id/enable', duetRoute(async req => {
    // Same seating as thread creation: one participant here, one across the boundary.
    // This route used to put config.model in BOTH slots, so a thread seated through it
    // opened as two copies of the same model — which is a chat with itself, and on a
    // keyed machine two copies of a REMOTE one.
    duet.ensureDuet(req.params.id, {
        models: req.body?.model
            ? { a: req.body.model, b: req.body.model }
            : await defaultParticipantModels()
    });
    return duetState(req.params.id);
}));

app.patch('/api/duet/participants/:id', duetRoute(req => {
    const updated = duet.updateParticipant(req.params.id, req.body);
    return { ...updated, tier: updated.model ? providers.tierOf(updated.model) : null };
}));

/**
 * Send to one participant, and stream its reply.
 *
 * NDJSON rather than SSE, matching /api/chat — one JSON object per line, each tagged with
 * the message id it belongs to, so a client running both panes at once never has to guess
 * whose token it just received. Closing the response is the stop signal, as on /api/chat.
 */
app.post('/api/duet/:id/send', async (req, res) => {
    // One visitor, a bounded number of generations at once. The GPU and the duet queue are
    // shared by every visitor on a hosted instance; without this, one tab sending in a loop
    // starves the rest. A no-op on a desk.
    const slot = sandbox.takeSlot();
    if (!slot) {
        return res.status(429).json({ error: 'You already have replies in progress. '
            + 'Wait for one to finish, or stop it, before sending another.' });
    }
    res.on('close', slot);
    res.on('finish', slot);

    const controller = new AbortController();

    // Hang the abort off the *response*, never the request: express.json() drains the body
    // and Node then destroys the consumed stream, so `req` fires 'close' long before a
    // model is reached.
    res.on('close', () => {
        if (!res.writableEnded) controller.abort();
    });

    let streaming = false;
    const emit = event => {
        if (!streaming) {
            streaming = true;
            res.setHeader('Content-Type', 'application/x-ndjson');
            res.setHeader('Cache-Control', 'no-cache');
            res.flushHeaders();
        }
        res.write(JSON.stringify(event) + '\n');
    };

    try {
        await generateDuet({
            threadId: Number(req.params.id),
            participantId: Number(req.body.participantId),
            text: req.body.text,
            images: req.body.images,
            // Files are opt-in per request, and only an explicit true opts in.
            tools: req.body.tools === true,
            clientRequestId: req.body.clientRequestId,
            retryOf: req.body.retryOf ? Number(req.body.retryOf) : null,
            config,
            signal: controller.signal,
            emit
        });
        res.end();
    } catch (err) {
        // Validation failures land here — before any token exists, so they can still be a
        // plain 400 the client shows against the composer.
        if (!streaming) return res.status(400).json({ error: err.message });
        emit({ type: 'error', error: err.message });
        res.end();
    }
});

// ─────────────────────── Packet store ───────────────────────
// Thin HTTP over db.js. Deliberately no drag-and-drop semantics here — "move",
// "fork", "nest" and "review" are store operations, so the board UI (whenever it
// gets built) is just one client of them, not the only place they exist.

const ok = handler => (req, res) => {
    try {
        res.json(handler(req));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

const id = req => Number(req.params.id);

app.get('/api/tree', ok(() => store.getTree()));
app.get('/api/stats', ok(() => {
    // The database's path is the server's business. Harmless on a desk; hosted it tells a
    // visitor where the host keeps its files.
    const s = store.stats();
    if (sandbox.sandboxed()) delete s.dbPath;
    return s;
}));
app.get('/api/travelled', ok(req => store.getTravelled(req.query.limit)));
app.get('/api/search', ok(req => store.search(req.query)));

app.post('/api/folders', ok(req => {
    if (!req.body.name) throw new Error('A folder needs a name.');
    return store.createFolder(req.body.name);
}));
app.delete('/api/folders/:id', ok(req => (store.deleteFolder(id(req)), { ok: true })));

/**
 * What a brand new duet opens with: one participant on this machine, one across the
 * boundary.
 *
 * That pairing is the product, not a nicety. Two local participants is a chat with itself;
 * two remote ones is a desk that has quietly stopped being local-first. Opening with one
 * of each means the very first thing on screen demonstrates what Airlock is for, and the
 * chamber underneath immediately has something to show.
 *
 * Degrades honestly: with no Nebius key both slots are local, and with no Ollama models
 * both are whatever the config opens on.
 */
async function defaultParticipantModels() {
    // The same choice a new arrival opens on, for the same reason: the left seat has to
    // run on this machine without crashing it. Cloud entries are excluded inside.
    const local = await require('./providers/ollama').list().catch(() => []);
    const localDefault = providers.defaultLocalModel(local);

    const configured = config.model || null;
    const configuredTier = configured ? providers.tierOf(configured) : null;
    const configuredIsRemote = configuredTier === 'remote';

    // Prefer the configured model for whichever side it belongs to, so the picker the
    // user already set is honoured rather than silently overridden. The left seat takes
    // it only if it is positively local — an unclassified model is not seated on the
    // side that promises nothing leaves.
    const a = configuredTier === 'local' ? configured : (localDefault || configured);
    const b = configuredIsRemote ? configured
        : (process.env.NEBIUS_API_KEY && process.env.AIRLOCK_MODEL_VERDICT) || a;

    return { a, b };
}

app.post('/api/threads', async (req, res) => {
    try {
        const { folderId, title } = req.body;
        if (!folderId || !title) throw new Error('A thread needs folderId and title.');

        const thread = store.createThread(folderId, title);

        // Every thread is a duet. Two participants over one conversation is the shape of
        // this app, not a mode you switch into — so they exist from the moment the thread
        // does, and the UI never has to ask whether this thread "is" one.
        try {
            duet.ensureDuet(thread.id, { models: await defaultParticipantModels() });
        } catch (err) {
            // A thread without participants still works as a single-pane chat, so this
            // must not be able to fail thread creation.
            console.error('could not seat participants:', err.message);
        }

        res.json(thread);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});
app.delete('/api/threads/:id', ok(req => (store.deleteThread(id(req)), { ok: true })));
app.get('/api/threads/:id/packets', ok(req => store.getThreadPackets(id(req))));

app.patch('/api/threads/:id', ok(req => {
    const { title, folderId } = req.body;
    let out = null;
    if (title !== undefined) out = store.renameThread(id(req), title);
    if (folderId !== undefined) out = store.moveThreadToFolder(id(req), folderId);
    if (!out) throw new Error('Nothing to change — pass title and/or folderId.');
    return out;
}));

// Explicit slot placement — drag a thread above/below a sibling, or into another tray.
app.post('/api/threads/:id/reorder', ok(req => store.reorderThread(id(req), req.body)));

app.post('/api/folders/:id/reorder', ok(req => store.reorderFolder(id(req), req.body.index)));

app.patch('/api/folders/:id', ok(req => store.renameFolder(id(req), req.body.name)));

/**
 * The drag-out target. Chromium's `DownloadURL` payload points here, so dropping a thread
 * on the desktop writes a real file — the browser fetches this URL and honours the
 * filename in Content-Disposition. Plain text/markdown, not JSON.
 */
app.get('/api/threads/:id/brief.md', (req, res) => {
    try {
        const brief = store.buildBrief(id(req), { actor: req.query.actor });
        const slug = brief.thread.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.setHeader('Content-Disposition',
            `attachment; filename="airlock-${slug}.md"`);
        res.send(brief.markdown);
    } catch (err) {
        res.status(400).type('text/plain').send(err.message);
    }
});

/** What has crossed: one thread, or the whole desk. */
app.get('/api/exposure', ok(() => store.getExposure()));
app.get('/api/threads/:id/exposure', ok(req => store.getExposure(id(req))));

/** The gate's ruling on a thread, without sending anything anywhere. */
app.post('/api/threads/:id/gate', async (req, res) => {
    try {
        const brief = store.buildBrief(id(req), { actor: req.body?.actor || 'the committee' });
        const gate = await runGate(brief.markdown, { config });
        res.json({ gate, packets: brief.packetIds.length });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

/**
 * Escalate a thread across the boundary, for real.
 *
 * Order matters and is the whole point: gate first, cross second, record third.
 * Nothing reaches the network until the local gate has released it, and nothing
 * is recorded as having crossed unless it actually did.
 */
app.post('/api/threads/:id/escalate', async (req, res) => {
    const threadId = id(req);
    const { actor, model, force = false } = req.body || {};

    try {
        if (!actor) throw new Error('Escalation needs an actor — which seat is this for?');
        if (!model) throw new Error('Escalation needs a model.');

        const tier = providers.tierOf(model);
        if (tier === 'local') {
            throw new Error(`${model} is on the local tier — nothing would cross, so there is nothing to gate.`);
        }
        if (tier !== 'remote') {
            // Escalation is a deliberate trip across the boundary to a known reviewer.
            // A model Airlock cannot place is not one, whatever the gate would say.
            throw new Error(`Airlock cannot place ${model} on either side of the boundary, so it cannot be an oversight seat.`);
        }

        const brief = store.buildBrief(threadId, { actor });
        if (!brief.packetIds.length) {
            throw new Error('Nothing to escalate — this thread has no packets yet.');
        }

        // 1. The gate. Local, deterministic, fail-closed — and bound to the exact brief:
        // the clearance covers these words, going to this model, and nothing else.
        const messages = [{ role: 'user', content: brief.markdown }];
        const cleared = force
            // An operator override still goes through the kernel, so the crossing has a
            // clearance like any other and the record says a person decided. Its ruling
            // names no model (model: null) because none ruled: naming config.model here
            // once claimed a gate model that never ran — on a keyed machine a REMOTE id,
            // implying a remote model had approved its own crossing.
            ? kernel.override({ model, messages, actor: 'the operator' })
            : await kernel.clear({ model, messages, config });
        const gate = cleared.ruling;

        if (!gate.release) {
            // Refused. Nothing has touched the network, and nothing is recorded
            // as crossed, because nothing crossed.
            return res.status(200).json({ escalated: false, gate, packets: brief.packetIds.length });
        }

        // 2. The crossing.
        const over = auth.spendRemote();
        if (over) return res.status(429).json({ error: over, gate });

        const verdict = await providers.complete({ model, messages, config, clearance: cleared.token });

        if (!verdict.content) {
            throw new Error(`${model} returned no verdict text.`);
        }

        // 3. The record. One transaction: the verdict packet, a `reviewed` stamp
        // on everything the brief covered, and a `crossed` stamp on the same —
        // because those are different facts and the audit needs both.
        const recorded = store.recordHandoff(threadId, {
            actor,
            verdict: verdict.content,
            packetIds: brief.packetIds,
            model,
            tier: 'remote',
            // What actually carried it. An Ollama cloud model is remote too, and did not
            // go anywhere near Token Factory.
            transport: providers.transportOf(model),
            gate
        });

        res.json({
            escalated: true,
            gate,
            packet: recorded.packet,
            signed: recorded.signed,
            crossed: recorded.crossed,
            model,
            usage: verdict.usage,
            reasoning: verdict.thinking ? verdict.thinking.length : 0
        });
    } catch (err) {
        const status = err.status || 400;
        res.status(status).json({ error: err.message });
    }
});

// Oversight handoff, carried by hand. Out: a brief to paste wherever you like.
// Back in: the verdict, as a packet plus signatures on what was reviewed.
// The live path is /escalate above; this one is still how a human seat works.
app.get('/api/threads/:id/brief', ok(req => store.buildBrief(id(req), { actor: req.query.actor })));

// ─────────────────────── Carry out by hand ───────────────────────
//
// A brief copied into a browser chat window crosses the boundary exactly as an API call
// does; only the carrier differs. So it is ruled on exactly as an API call is — the secret
// scanner, then the local gate, over the WHOLE brief, which is every reply in the thread
// including any that quote files a participant read. Released: the brief is handed over.
// Withheld: it is not, and the ruling is. An operator can override, and the record says so.
//
// The ruling lives HERE, under a token, never in the client. /carried and /handoff record
// the crossing with the ruling the server issued; a client cannot claim "released" for a
// brief no gate ever saw. GET /brief stays as the raw local read it always was — reading
// your own thread on your own machine crosses nothing.

const carries = new Map();          // token -> { scope, threadId, actor, packetIds, gate, at }
const CARRY_TTL_MS = 60 * 60 * 1000;

function takeCarry(token, threadId) {
    const carry = carries.get(String(token || ''));
    if (!carry || carry.threadId !== threadId || carry.scope !== sandbox.scopeKey()) {
        throw new Error('That brief was not ruled on here (or it has expired) — carry it out again.');
    }
    if (Date.now() - carry.at > CARRY_TTL_MS) {
        carries.delete(token);
        throw new Error('That ruling has expired — carry the brief out again.');
    }
    return carry;
}

app.post('/api/threads/:id/carry', async (req, res) => {
    try {
        const threadId = id(req);
        const actor = String(req.body?.actor || '').trim().slice(0, 80);
        if (!actor) throw new Error('Say where it is going — "Claude", "a colleague", anything.');

        const brief = store.buildBrief(threadId, { actor });
        if (!brief.packetIds.length) throw new Error('Nothing to carry — this thread has no packets yet.');

        const gate = req.body?.force === true
            ? { release: true, reason: 'Carried by hand over the gate: the operator decided.',
                concerns: [], model: null, forced: true }
            : await runGate(brief.markdown, { config });

        if (!gate.release) {
            return res.json({ released: false, gate, packets: brief.packetIds.length });
        }

        for (const [t, c] of carries) if (Date.now() - c.at > CARRY_TTL_MS) carries.delete(t);
        const token = require('node:crypto').randomUUID();
        carries.set(token, {
            scope: sandbox.scopeKey(), threadId, actor, packetIds: brief.packetIds, gate, at: Date.now()
        });

        res.json({ released: true, gate, token, ...brief });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// The brief was copied or saved: it has left. Record it now, with the server's ruling.
app.post('/api/threads/:id/carried', ok(req => {
    const carry = takeCarry(req.body?.token, id(req));
    return store.recordCarry(id(req), { actor: carry.actor, packetIds: carry.packetIds, gate: carry.gate });
}));

app.post('/api/threads/:id/handoff', ok(req => {
    // With a carry token, what was carried and what ruled on it come from the server.
    // Without one (the older API), the caller's own gate claim is dropped: a ruling nobody
    // here issued is recorded as "no gate ruling recorded", which is the truth.
    if (req.body?.token) {
        const carry = takeCarry(req.body.token, id(req));
        return store.recordHandoff(id(req), {
            actor: carry.actor, verdict: req.body.verdict, packetIds: carry.packetIds,
            gate: carry.gate, transport: 'hand', tier: 'remote'
        });
    }
    const { gate, ...rest } = req.body || {};
    return store.recordHandoff(id(req), rest);
}));

app.post('/api/packets', ok(req => {
    const { threadId, role, content, model } = req.body;
    if (!threadId) throw new Error('A packet needs a threadId.');
    if (!role || !content) throw new Error('A packet needs a role and content.');

    // The tier is resolved here, not accepted from the caller: the client should
    // not be able to assert which side of the boundary produced something. This is
    // still recording rather than deriving — it captures the fact at creation,
    // which is what the audit needs. (Human-carried seats like "Claude" are not
    // model ids and would resolve local, so recordHandoff sets their tier
    // explicitly instead of coming through here.)
    const tier = model ? providers.tierOf(model) : 'local';
    return store.createPacket({ ...req.body, tier });
}));

app.get('/api/packets/:id', ok(req => {
    const p = store.getPacket(id(req));
    if (!p) throw new Error(`No packet ${id(req)}`);
    return { ...p, provenance: store.getProvenance(p.id), reviews: store.getReviews(p.id) };
}));

app.delete('/api/packets/:id', ok(req => (store.deletePacket(id(req)), { ok: true })));

/** Single-packet drag-out target, mirroring /api/threads/:id/brief.md. */
app.get('/api/packets/:id/packet.md', (req, res) => {
    try {
        const p = store.getPacket(id(req));
        if (!p) throw new Error(`No packet ${id(req)}`);

        // A file dragged out of Airlock goes wherever the drop lands — it is an export the
        // app cannot follow, so a known credential format does not go at all. The gate
        // model cannot run here (the drag is already in flight); the scanner can, and does.
        const hits = require('./secrets').scan(p.content);
        if (hits.length) {
            return res.status(403).type('text/plain').send(
                `Packet #${p.id} contains ${[...new Set(hits.map(h => h.label))].join(', ')}, so it `
                + 'is not exported. Use ⇱ Carry out if it really must leave — that is gated and recorded.');
        }

        const thread = store.getThread(p.thread_id);
        const reviews = store.getReviews(p.id);
        const origin = p.origin_thread_id && p.origin_thread_id !== p.thread_id
            ? store.getThread(p.origin_thread_id) : null;

        const lines = [`# Airlock packet #${p.id}`, ''];
        lines.push(`Thread: **${thread?.title ?? '?'}** · tray: ${thread?.folder_name ?? '?'} · `
            + `role: ${p.role}${p.model ? ` · model: ${p.model}` : ''}`);
        // Which side of the boundary produced it, said in the exported file too — the drag
        // header carries this, and a file that omitted it would contradict the paste.
        if (p.role === 'assistant') {
            // A reply the gate withheld never ran anywhere; its tier only says where it was bound.
            lines.push(p.status === 'blocked'
                ? 'Ran: **nowhere** — withheld by the local gate, nothing was sent'
                : `Ran: ${p.tier === 'remote' ? '**off-machine**' : 'on local hardware'}`);
        }
        if (origin) lines.push(`Born in: **${origin.title}**`);
        if (reviews.length) lines.push(`Reviewed by: ${reviews.map(r => r.actor).join(', ')}`);
        lines.push('', '---', '', p.content, '');

        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="airlock-packet-${p.id}.md"`);
        res.send(lines.join('\n'));
    } catch (err) {
        res.status(400).type('text/plain').send(err.message);
    }
});
app.get('/api/packets/:id/provenance', ok(req => store.getProvenance(id(req))));
// Moving or forking a packet out of a duet takes it out of a conversation, so the duet
// store has a say on both sides of the store call: whether it may leave at all, and making
// it belong where it lands. See refuseToLeave and rehome in duet-store.js.
const leaving = (req, operation) => {
    const refusal = duet.refuseToLeave(id(req));
    if (refusal) throw new Error(refusal);

    const before = store.getPacket(id(req));
    const landed = operation();
    if (landed && before && landed.thread_id !== before.thread_id) duet.rehome(landed.id);
    return landed ? store.getPacket(landed.id) : landed;
};

app.post('/api/packets/:id/move', ok(req => leaving(req, () => store.movePacket(id(req), req.body))));
app.post('/api/packets/:id/fork', ok(req => leaving(req, () => store.forkPacket(id(req), req.body))));
app.post('/api/packets/:id/review', ok(req => store.reviewPacket(id(req), req.body)));

/**
 * Seat participants on threads that predate "every thread is a duet".
 *
 * Once, behind a marker, at boot — NOT lazily when a thread is opened. Creating rows as a
 * side effect of a GET is the kind of thing that works until two windows open the same
 * thread at once, and it also means a read-only glance at somebody's board quietly
 * rewrites it. A migration says what it is and can be reasoned about afterwards.
 */
async function seatExistingThreads() {
    if (store.getMeta('duet_all_threads')) return 0;

    const models = await defaultParticipantModels();
    let seated = 0;

    for (const folder of store.getTree()) {
        for (const thread of folder.threads) {
            if (duet.isDuet(thread.id)) continue;
            try { duet.ensureDuet(thread.id, { models }); seated++; } catch { /* skip */ }
        }
    }

    store.setMeta('duet_all_threads', `${seated} thread(s) seated at ${new Date().toISOString()}`);
    return seated;
}

loadConfig().then(async () => {
    // A duet reply left mid-stream by a crash or a restart is neither finished nor
    // abandoned, and until it is settled it would sit in the UI as a permanently
    // thinking pane.
    // Hosted there is no single database at boot — each sandbox does this when it opens.
    const hosted = sandbox.sandboxed();
    const stranded = hosted ? 0 : duet.resetStaleGenerations();

    // Resolve which models are on which side before serving anything. Left cold, every
    // model reads 'unknown' until the first catalogue fetch, and 'unknown' is gated — so
    // the first crossing after a restart would be refused for the wrong reason. Failing
    // to resolve is not fatal: runGate resolves again and refuses if it still cannot.
    const known = await providers.ensureFresh().then(() => providers.localModels().length)
        .catch(err => {
            console.error('could not resolve the model registry:', err.message);
            return 0;
        });

    const seated = hosted ? 0 : await seatExistingThreads().catch(err => {
        console.error('could not seat existing threads:', err.message);
        return 0;
    });

    if (hosted) sandbox.startSweeper();

    app.listen(PORT, () => {
        const s = hosted ? null : store.stats();
        console.log('');
        console.log(`  Airlock is running -> http://localhost:${PORT}`);
        if (stranded) console.log(`  Settled ${stranded} duet generation(s) stranded by the last shutdown`);
        console.log(`  Boundary: ${known} model(s) resolved on this side`);
        if (seated) console.log(`  Seated participants on ${seated} existing thread(s)`);
        console.log(config.model
            ? `  Model: ${config.model}   ctx: ${config.num_ctx}`
            : '  Model: none reachable. Pull an Ollama model, or set NEBIUS_API_KEY.');
        console.log(hosted ? sandbox.describe()
            : `  Store: ${s.packets} packets in ${s.threads} threads / ${s.folders} trays`);
        console.log(auth.describe(PORT));
        const ws = files.workspacePolicy();
        console.log(ws.mode === 'any'
            ? '  workspace -> any folder. Correct for a desk; set AIRLOCK_WORKSPACE_ROOTS before hosting.'
            : ws.mode === 'off'
            ? '  workspace -> OFF: hosted with no AIRLOCK_WORKSPACE_ROOTS, so visitors cannot open folders.'
            : `  workspace -> limited to ${ws.roots.join(', ')}`);
        console.log('');
    });
});
