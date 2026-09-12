// Node 20.6+ reads .env natively, so the remote tier needs no dotenv dependency.
// Absent .env is not an error: Airlock runs fully local without one.
try { process.loadEnvFile(); } catch { /* no .env; local tier only */ }

const express = require('express');
const fs = require('fs').promises;
const path = require('path');

const store = require('./db');
const files = require('./files');
const providers = require('./providers');

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
    systemPrompt: 'You are Airlock, a local-first assistant running on Nova\'s machine. Be direct and concise. Use code blocks for code.'
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
app.use(express.static(path.join(__dirname, 'public')));

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

    const { messages, model, threadId } = req.body;

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

    try {
        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
            const lastRound = round === MAX_TOOL_ROUNDS;   // stop offering tools; force an answer

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

    // Open somewhere useful rather than at This PC.
    const start = thread.workspace_root || 'C:\\Projects\\NeuroForge';

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

// Oversight handoff — no frontier API involved. Out: a brief to carry by hand.
// Back in: the verdict, as a packet plus signatures on what was reviewed.
app.get('/api/threads/:id/brief', ok(req => store.buildBrief(id(req), { actor: req.query.actor })));
app.post('/api/threads/:id/handoff', ok(req => store.recordHandoff(id(req), req.body)));

app.post('/api/packets', ok(req => {
    const { threadId, role, content } = req.body;
    if (!threadId) throw new Error('A packet needs a threadId.');
    if (!role || !content) throw new Error('A packet needs a role and content.');
    return store.createPacket(req.body);
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
        console.log('');
    });
});
