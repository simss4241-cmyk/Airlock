// Node 20.6+ reads .env natively, so the remote tier needs no dotenv dependency.
// Absent .env is not an error: Airlock runs fully local without one.
try { process.loadEnvFile(); } catch { /* no .env; local tier only */ }

const express = require('express');
const fs = require('fs').promises;
const path = require('path');

const store = require('./db');
const files = require('./files');
const providers = require('./providers');
const { runGate } = require('./boundary');
const auth = require('./auth');

const app = express();

const PORT = Number(process.env.PORT) || 8100;
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';   // keep in step with providers/ollama.js
const CONFIG_FILE = path.join(__dirname, 'airlock-config.json');

// Meta's recommended sampling for Muse Glimmer: temp 1.0 / top_p 0.95 / top_k 64.
// num_ctx is deliberately NOT 128K — on a 16GB card the KV cache for full context
// would evict the weights. 8192 is a sane desk default; raise it in Settings.
const DEFAULTS = {
    model: 'muse-glimmer:30b-q4_K_M',
    temperature: 1.0,
    top_p: 0.95,
    top_k: 64,
    num_ctx: 8192,
    keep_alive: '10m',
    // The local model reasons in a separate channel before answering. It's the model's whole
    // point, but on a partially-offloaded 30B it costs ~3.7x the wall clock for simple
    // questions (measured: 33.7s vs 9.1s for a two-word answer). Toggleable per taste.
    think: true,
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
// Read-only, confined by files.js to the workspace root of the thread the request names.
// Bounded rounds so a confused model can't spin the loop forever on an 8 tok/s budget.

const MAX_TOOL_ROUNDS = 5;

const TOOLS = [
    {
        type: 'function',
        function: {
            name: 'list_directory',
            description: 'List files and folders inside the workspace. Use "." for the workspace root.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Folder path relative to the workspace root.' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'find_files',
            description: 'Find files anywhere in the workspace whose filename contains the query. '
                + 'Use this when you know roughly what a file is called but not where it lives.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Substring to match against filenames.' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read a text file from the workspace (.md, .txt, .json, source code, etc). '
                + 'Returns the file contents, truncated if very large.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path relative to the workspace root.' }
                },
                required: ['path']
            }
        }
    }
];

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

async function runTool(name, args, root) {
    switch (name) {
        case 'list_directory': return files.listDirectory(root, args.path || '.');
        case 'find_files':     return files.findFiles(root, args.query);
        case 'read_file':      return files.readTextFile(root, args.path);
        default: throw new Error(`Unknown tool: ${name}`);
    }
}

/** One-line description for the UI's tool card. */
function summarise(name, args, result, ok) {
    if (!ok) return `${name} failed: ${result.error}`;
    switch (name) {
        case 'list_directory': return `${result.path} — ${result.entries.length} entries`;
        case 'find_files':     return `"${result.query}" — ${result.count} match(es)`;
        case 'read_file':      return `${result.path} — ${result.bytes.toLocaleString()} bytes`
                                    + (result.truncated ? ' (truncated)' : '');
        default: return name;
    }
}

let config = { ...DEFAULTS };

app.use(express.json({ limit: '32mb' }));  // images ride along as base64

// Static assets stay open deliberately: the page must be able to load in order
// to prompt for a token. It ships no data of its own — everything comes from
// /api, which is guarded.
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', auth.guard);

// Lets the page discover whether it needs a token before it asks for anything
// else, so an unauthorised visitor sees a prompt rather than a wall of 401s.
app.get('/api/access', (req, res) => res.json({
    ok: true, demo: Boolean(process.env.AIRLOCK_DEMO), ...auth.remoteSpend()
}));

async function loadConfig() {
    try {
        config = { ...DEFAULTS, ...JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8')) };
    } catch { /* first run, no config yet */ }

    // Before workspaces belonged to threads, one global root lived in the JSON config.
    // Copy it to each existing thread exactly once, then delete the key outright rather
    // than blanking it — an empty hook is still a hook. db.migrateWorkspaceRoot keeps its
    // own marker, so even a config restored from before this change won't re-run it.
    if ('workspaceRoot' in config) {
        if (config.workspaceRoot) store.migrateWorkspaceRoot(path.resolve(config.workspaceRoot));
        delete config.workspaceRoot;
        await saveConfig();
    }

    // Same treatment for the retired global tools flag: a key that reads like a switch but
    // controls nothing is worse than no key, so drop it rather than leave it lying there.
    if ('tools' in config) {
        delete config.tools;
        await saveConfig();
    }
}

async function saveConfig() {
    await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

// ── Config ──
app.get('/api/config', (req, res) => res.json(config));

app.post('/api/config', async (req, res) => {
    const allowed = Object.keys(DEFAULTS);
    for (const key of allowed) {
        if (req.body[key] !== undefined) config[key] = req.body[key];
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

// Scratch chat has no thread to hang a clearance on, so it is remembered per
// model for the life of the process. Restarting asks again, which is the right
// default for something with no durable home.
const scratchCleared = new Set();

// Remote-tier models, with their declared capabilities. Never throws: a missing
// key, a network blip or a bad key all mean the same thing to the UI — no seats.
async function remoteModels() {
    try {
        const tf = require('./providers/tokenfactory');
        const list = await tf.list();
        const caps = await tf.capabilities();
        return list
            .map(m => ({ name: m.id, tier: m.tier, caps }))
            .sort((a, b) => a.name.localeCompare(b.name));
    } catch { return []; }
}

// ── Health: is Ollama up, is the local model actually installed, what else is available ──
app.get('/api/health', async (req, res) => {
    try {
        const [tagsRes, verRes] = await Promise.all([
            fetch(`${OLLAMA}/api/tags`),
            fetch(`${OLLAMA}/api/version`).catch(() => null)
        ]);
        const { models = [] } = await tagsRes.json();
        const version = verRes && verRes.ok ? (await verRes.json()).version : null;

        const withCaps = await Promise.all(models.map(async m => ({
            name: m.name,
            size: m.size,
            tier: 'local',
            family: m.details?.family,
            caps: await modelCaps(m.name)     // cached, so only the first call costs anything
        })));
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
            localModelInstalled: models.some(m => m.name.startsWith('muse-glimmer')),
            activeModel: config.model
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
            localModelInstalled: false
        });
    }
});

// ── Chat: stream Ollama's NDJSON straight through, and abort if the client leaves ──
app.post('/api/chat', async (req, res) => {
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

    // A root pointing at a folder that no longer exists is worse than no tools at all:
    // every call fails, and the model spends the whole round budget finding that out.
    const rootUsable = workspaceRoot
        ? await fs.stat(workspaceRoot).then(s => s.isDirectory()).catch(() => false)
        : false;
    const useTools = rootUsable && caps.includes('tools');

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

    // A remote model means this conversation is about to leave the machine, so the
    // gate rules before anything is sent. Once per thread per model: the selection
    // is sticky in localStorage, so the risk being guarded against is returning to
    // a thread already pointed at the remote tier and forgetting.
    const tier = providers.tierOf(chosen);
    let gateRuling = null;

    if (tier === 'remote') {
        const cleared = threadId
            ? store.isCleared(Number(threadId), chosen)
            : scratchCleared.has(chosen);

        if (!cleared) {
            // The system prompt is in `convo` too, and it crosses with everything
            // else, so the gate reads exactly what would be sent.
            const outgoing = convo
                .map(m => `${m.role}: ${m.content || ''}`)
                .join('\n\n');

            gateRuling = await runGate(outgoing, { model: config.model, config });

            if (!gateRuling.release) {
                // Nothing has been sent. 200, because the request succeeded and the
                // answer was no — the client renders the reason rather than an error.
                return res.status(200).json({ blocked: true, gate: gateRuling, tier });
            }

            if (threadId) store.recordClearance(Number(threadId), chosen, gateRuling);
            else scratchCleared.add(chosen);
        }
    }

    let crossingRecorded = false;

    try {
        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
            const lastRound = round === MAX_TOOL_ROUNDS;   // stop offering tools; force an answer

            if (tier === 'remote' && round === 0) {
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
                signal: controller.signal
            });

            // Collect rather than blind-pipe: we need the tool calls, and the per-round
            // `done` chunk must not reach the client until the last round or it would
            // finalise the message while tools are still running.
            let content = '', thinking = '', toolCalls = [], finalChunk = null;

            for await (const chunk of stream) {
                // First chunk back proves the request was accepted, which is the
                // moment the content is provably across. Recording on dispatch
                // instead would log crossings that never happened.
                if (tier === 'remote' && !crossingRecorded) {
                    crossingRecorded = true;
                    try {
                        store.recordCrossings(packetIds, {
                            actor: chosen, model: chosen, transport: 'chat', gate: gateRuling
                        });
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

            convo.push({
                role: 'assistant',
                content,
                ...(thinking ? { thinking } : {}),
                tool_calls: toolCalls
            });

            for (const call of toolCalls) {
                const name = call.function?.name;
                let args = call.function?.arguments ?? {};
                if (typeof args === 'string') {
                    try { args = JSON.parse(args); } catch { args = {}; }
                }

                let result, ok = true;
                try {
                    result = await runTool(name, args, workspaceRoot);
                } catch (err) {
                    ok = false;
                    result = { error: err.message };
                }

                // Custom line the client renders as a tool card. Ollama never emits this key.
                send({ airlock_tool: { name, args, ok, summary: summarise(name, args, result, ok) } });

                convo.push({
                    role: 'tool',
                    tool_name: name,
                    content: JSON.stringify(result).slice(0, 120000)
                });
            }
        }

        // Reached only if the loop ran out of rounds while the model was still asking for
        // tools. Rare, but the tokens were still spent, so don't lose them.
        sendUsage();
        res.end();
    } catch (err) {
        if (err.name === 'AbortError') return;   // user hit Stop; nothing to report

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
    return {
        threadId: thread.id,
        threadTitle: thread.title,
        root,
        exists,
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

const requestWorkspace = req => {
    const thread = store.getThread(Number(req.query.threadId));
    if (!thread) throw new Error('Pick a thread first.');
    return thread.workspace_root;
};

app.get('/api/fs/list', fsRoute(req => files.listDirectory(requestWorkspace(req), req.query.path || '.')));
app.get('/api/fs/read', fsRoute(req => files.readTextFile(requestWorkspace(req), req.query.path)));
app.get('/api/fs/find', fsRoute(req => files.findFiles(requestWorkspace(req), req.query.q)));

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
app.get('/api/stats', ok(() => store.stats()));
app.get('/api/travelled', ok(req => store.getTravelled(req.query.limit)));
app.get('/api/search', ok(req => store.search(req.query)));

app.post('/api/folders', ok(req => {
    if (!req.body.name) throw new Error('A folder needs a name.');
    return store.createFolder(req.body.name);
}));
app.delete('/api/folders/:id', ok(req => (store.deleteFolder(id(req)), { ok: true })));

app.post('/api/threads', ok(req => {
    const { folderId, title } = req.body;
    if (!folderId || !title) throw new Error('A thread needs folderId and title.');
    return store.createThread(folderId, title);
}));
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
        const gate = await runGate(brief.markdown, { model: config.model, config });
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
        if (tier !== 'remote') {
            throw new Error(`${model} is on the local tier — nothing would cross, so there is nothing to gate.`);
        }

        const brief = store.buildBrief(threadId, { actor });
        if (!brief.packetIds.length) {
            throw new Error('Nothing to escalate — this thread has no packets yet.');
        }

        // 1. The gate. Local, deterministic, fail-closed.
        const gate = force
            ? { release: true, reason: 'Overridden by the operator.', concerns: [], model: config.model, forced: true }
            : await runGate(brief.markdown, { model: config.model, config });

        if (!gate.release) {
            // Refused. Nothing has touched the network, and nothing is recorded
            // as crossed, because nothing crossed.
            return res.status(200).json({ escalated: false, gate, packets: brief.packetIds.length });
        }

        // 2. The crossing.
        const over = auth.spendRemote();
        if (over) return res.status(429).json({ error: over, gate });

        const verdict = await providers.complete({
            model,
            messages: [{ role: 'user', content: brief.markdown }],
            config
        });

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
            transport: 'token-factory',
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
app.post('/api/threads/:id/handoff', ok(req => store.recordHandoff(id(req), req.body)));

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

        const thread = store.getThread(p.thread_id);
        const reviews = store.getReviews(p.id);
        const origin = p.origin_thread_id && p.origin_thread_id !== p.thread_id
            ? store.getThread(p.origin_thread_id) : null;

        const lines = [`# Airlock packet #${p.id}`, ''];
        lines.push(`Thread: **${thread?.title ?? '?'}** · tray: ${thread?.folder_name ?? '?'} · `
            + `role: ${p.role}${p.model ? ` · model: ${p.model}` : ''}`);
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
app.post('/api/packets/:id/move', ok(req => store.movePacket(id(req), req.body)));
app.post('/api/packets/:id/fork', ok(req => store.forkPacket(id(req), req.body)));
app.post('/api/packets/:id/review', ok(req => store.reviewPacket(id(req), req.body)));

loadConfig().then(() => {
    app.listen(PORT, () => {
        const s = store.stats();
        console.log('');
        console.log(`  Airlock is running -> http://localhost:${PORT}`);
        console.log(`  Model: ${config.model}   ctx: ${config.num_ctx}`);
        console.log(`  Store: ${s.packets} packets in ${s.threads} threads / ${s.folders} trays`);
        console.log(auth.describe(PORT));
        console.log('');
    });
});
