# Airlock

**A local-first reasoning desk with an audited model boundary.**

Everything runs on your machine by default. A local model answers, and the conversation
never leaves the desk. When a thread needs more than the local model can give, escalating it
to a larger model is an explicit, logged, signed event — not an invisible API call buried in
a settings page. Every packet records which model touched it and which side of the boundary
it was on, so *"what did a remote model ever see?"* is a query rather than a guess.

The boundary is the product. Routing is just how it is enforced.

Node/Express on **:8100**, local inference through Ollama on **:11434**. No build step, no
CDN, no frontend dependencies.

## Status

Airlock is a fork of Glimmer, a working local-first chat UI and packet store. The local half
and the record-keeping exist today; the remote tier is being built. This table is the honest
version — clone it and check.

| | |
|---|---|
| Local inference — streaming, reasoning channel, tools, vision | working |
| Packet store — threads, nesting, provenance, move/fork/review | working, 89 assertions |
| Per-thread read-only workspaces, with containment tests | working, 46 assertions |
| Escalation briefs and recorded verdicts | working — transport is manual copy-paste |
| Remote tier on Nebius Token Factory (Nemotron 3) | working, 34 assertions |
| Model dropdown grouped by tier, capability-badged | working |
| Local gate rules before anything crosses | working, 50 assertions |
| Tier recorded per packet; "what crossed?" as a query | working |
| Escalation driven by the router rather than the clipboard | working |
| Redaction — crossing a brief with the sensitive parts removed | in progress |
| Access token + remote spend cap for hosting | working, 26 assertions |
| Hosted demo build | in progress |

The local model in use is **Meta Muse Glimmer 30B** (Apache 2.0, released 2026-08-10), but
nothing here is specific to it — any Ollama model works, and the dropdown badges each one's
capabilities.

Built for the Nebius × NVIDIA Global AI Hackathon — Personal AI track.


## Requirements

- Node (installed), Python + Pillow (only to regenerate icons).
- Ollama. **0.32.7 is installed and is the newest release — but that is not enough yet.**

### ⚠ Required on this GPU: `OLLAMA_FLASH_ATTENTION=0`

Muse Glimmer needs **Ollama 0.32.8+** (NVIDIA/AMD support landed there; 0.32.7 and earlier
return 412 on Windows). That part is solved.

But on an RTX 5060 Ti — Blackwell, sm_120 — `llama-server` hard-crashes on load with
`exit status 0xc0000409` unless flash attention is disabled. The server log shows the real
cause, and it is *not* running out of VRAM (14.4 GB was free):

```
CUDA error: shared object initialization failed
  in function ggml_cuda_flash_attn_ext_mma_f16_case
  cudaFuncSetAttribute(..., cudaFuncAttributeMaxDynamicSharedMemorySize, ...)
```

The flash-attention MMA kernel asks for more dynamic shared memory per block than the
driver allows on this architecture. It fails at every context size — 4096 crashes exactly
like 8192, so don't go hunting for a `num_ctx` ceiling.

Set as a user environment variable:

```
OLLAMA_FLASH_ATTENTION=0
```

**Gotcha:** Ollama only reads that at process start, and a process launched from an
already-running shell inherits that shell's stale environment. After setting it, restart
Ollama from a *fresh* shell (or just log out and back in). Setting the variable and
restarting from the same session looks like it did nothing.

Revisit this whenever Ollama or llama.cpp ships a Blackwell fix — flash attention is worth
having back.

### ⚠ Also required: `OLLAMA_GPU_OVERHEAD=3221225472` (3 GiB)

Disabling flash attention is necessary but **not sufficient**. With FA off, loads still fail
intermittently — the crash simply moves to another kernel:

```
ggml_cuda_compute_forward: MUL_MAT failed
CUDA error: shared object initialization failed
```

That's CUDA failing to initialise a kernel module for lack of VRAM headroom, not a bug. An
18 GB model on a 16 GB card, with 3–4 GB routinely held by Chrome/Edge/ChatGPT/Claude/Bambu/
Epic, leaves too little room once the weights are placed. It is load-time and probabilistic:
the same prompt works, then fails a minute later as other apps grow.

Reserving 3 GiB fixes it. Measured across three cold loads each:

| Reserve | Cold loads | Throughput |
|---|---|---|
| none | crashes intermittently | 8.5 tok/s when it survives |
| 1.5 GiB | 1 of 3 failed | 5.5 tok/s |
| **3 GiB** | **3 of 3 clean** | **8.7–8.9 tok/s** |

1.5 GiB is both less stable *and* no faster, so there's no reason to prefer it. (The 5.5
tok/s figures were measured while a second test Ollama was contending for the GPU — with a
single server, 3 GiB costs no measurable throughput.)

## Setup

```
npm install
cp .env.example .env                     # add your Nebius key for the remote tier
ollama pull muse-glimmer:30b-q4_K_M      # 18 GB — blocked, see above
start_airlock.bat
```

The local tier needs no key and no account. `.env` is only for the remote tier — Airlock
runs fully local without it, which is the point.

## Measured on this machine (RTX 5060 Ti 16 GB, q4_K_M, flash attention off)

| | |
|---|---|
| Offload split | **24% CPU / 76% GPU** — partial, as expected against Meta's 24 GB target |
| Cold load | 15–21 s |
| Throughput | **8.5–9.7 tok/s** |
| Vision | works — 320px image ≈ 219 prompt tokens, answered in 13.8 s |
| "Name one metal", reasoning **on** | 33.7 s |
| "Name one metal", reasoning **off** | **9.1 s** |

## The local model is a reasoning model

It streams a **separate `thinking` channel** before it says anything. In one measured run
the first *content* token arrived 48.5 s after the request, having spent the whole time
reasoning. A UI that renders only `message.content` looks frozen for a minute.

So reasoning streams live into a collapsible pane that folds itself once the answer starts,
and the stats line reports it separately (`29.0s reasoning · 252 tokens · 8.6 tok/s`).

The **◈ reasoning** toggle in the composer sets Ollama's `think` flag. Off is roughly 3.7×
faster on this hardware and perfectly fine for lookups; on is the reason to run this model
at all. It persists in `airlock-config.json`.

### ⚠ `think` and `tools` are per-model, never global

Sending `think` to a model without a thinking channel is a hard 400 —
`"llama3.2:latest" does not support thinking` — and so is sending `tools` to a model without
tool support. `codellama:13b` has *neither*. Setting either flag from config alone breaks
every other model in the dropdown, which is exactly what happened once.

So the server reads `POST /api/show` → `capabilities` per model (cached in `capsCache`) and
only sets a flag the model actually advertises. `think` is **omitted** rather than sent as
`false`, since the field itself is the request.

The UI mirrors it: `/api/health` returns each model's capabilities, the dropdown badges them
(`◈` thinking, `👁` vision, `⛁` tools), and the pills disable themselves with an explanation
— `◇ no reasoning`, `⛁ no tools` — rather than offering a toggle that would error.

Current roster:

| Model | thinking | tools | vision |
|---|---|---|---|
| `muse-glimmer:30b-q4_K_M` | ✅ | ✅ | ✅ |
| `deepseek-r1:7b` | ✅ | ✅ | — |
| `qwen2.5:7b` / `:14b` | — | ✅ | — |
| `llama3.2:latest` | — | ✅ | — |
| `llama3.2-vision:11b` | — | ✅ | ✅ |
| `codellama:13b` | — | — | — |

## Token counter

The `Σ` pill beside the Ollama version is a running total of every token this install has
spent — prompt and generated, across every thread and scratch chat, kept in
`localStorage` under `airlock.tokens` so it survives reloads. Hover for the split and the
reply count; click to reset (it asks first).

The per-reply stats line under each message reports only the **final** Ollama call, which
undercounts any answer that used tools: each tool round is its own call with its own prompt
and its own cost, and the server swallows the intermediate `done` chunks so they never
finalise the message early. `/api/chat` therefore totals every round and emits one
`{"airlock_usage":{prompt,reply,rounds}}` line — same trick as `airlock_tool`, a key Ollama
never sends. Measured on a two-round answer: **765 tokens total, 424 in the final round** —
the other 341 were previously invisible.

The client prefers that line and falls back to the `done` chunk only if it never arrives, so
a turn is never counted twice.

## Hardware note (RTX 5060 Ti, 16 GB)

Meta targeted a 24–32 GB envelope. The q4_K_M weights are ~18 GB, so on 16 GB of VRAM a
few GB of weights plus the KV cache spill to system RAM and generation is slower than the
launch benchmarks. That is why `num_ctx` defaults to **8192**, not the model's 128K — a
large KV cache is what actually pushes weights off the card. Raise it in Settings if a
task needs it and you can accept the slowdown.

The tok/s and time-to-first-token readout under each reply is there to make that tradeoff
visible: change `num_ctx`, re-ask, compare.

Alternatives if it's too slow:
- `muse-glimmer:30b-q4_K_M-dflash` (20 GB) — bundles the speculative-decoding drafter.
- Unsloth `UD-Q3_K_XL` (~14–15 GB) — fits almost entirely in VRAM, real quality cost on a 30B.

## Taskbar icon

Two routes. The shortcut is the reliable one.

### Shortcut (recommended)

```
powershell -ExecutionPolicy Bypass -File tools\install_shortcut.ps1 -Desktop
```

Creates `Airlock.lnk` in the Start Menu (and Desktop with `-Desktop`), carrying
`airlock.ico` and pointing at `airlock-launch.vbs`. Then: **Start → type "Airlock" →
right-click → Pin to taskbar.**

That last click has to be yours — Windows deliberately blocks apps from pinning themselves,
so no script can do it. `-Remove` deletes the shortcuts (unpin by hand).

`airlock-launch.vbs` is what makes one icon sufficient: it checks whether the server is
answering, starts it hidden if not, waits for it, then brings an existing Airlock app window
forward. Only when no Airlock window exists does it open Edge (or Chrome) in `--app` mode —
own window, no tabs, no address bar, no console flash. The same single-window check is used
by `start_airlock.bat`, so either launcher works cold or warm without multiplying windows.

### Finding the window without finding the folder

`tools/focus_airlock.ps1` enumerates windows, but filters by **owning process** (`msedge`,
`chrome`) *before* comparing titles, and then demands an exact `Airlock` match. Both halves
matter: the process gate is what keeps a File Explorer window sitting on the `Airlock`
folder from being mistaken for the app, and the exact match keeps a normal browser window
(`Airlock - Microsoft Edge`) from being grabbed instead of the `--app` window.

Exit codes, because the launchers branch on them:

| Code | Means | Launcher does |
|---|---|---|
| 0 | found and raised | nothing more |
| 1 | no Airlock window | open one |
| 2 | helper itself broke | open one |
| 4 | found, but Windows refused the raise | **nothing more** |

Code 4 exists because `SetForegroundWindow` is not guaranteed: Windows' foreground lock lets
it refuse a process that isn't already in front, which is exactly this script's position. The
return value used to be discarded and the script exited 0 regardless, so a refused raise
looked identical to a successful one — a taskbar click that did nothing. It now retries with
the same Z-order nudge the folder picker uses (`HWND_TOPMOST`, then back to `NOTOPMOST`) and
reports honestly. A 4 still stops the launcher: the window *is* there, and a duplicate app
window is worse than one that didn't come forward.

`-DetectOnly` finds without raising, which is how the process gate gets tested without
stealing focus. `start_airlock.bat` also checks whether port 8100 is already listening before
starting node — it used to start one unconditionally, leaving a second process that lost the
race for the port and then sat there doing nothing.

### PWA install (alternative)

Edge → `…` → **Apps** → **Install this site as an app** → tick **Pin to taskbar**. Gives the
app its own taskbar identity and window, with icons from `manifest.webmanifest`. But it
assumes the server is already running, so pair it with:

```
powershell -ExecutionPolicy Bypass -File tools\install_autostart.ps1
```

which drops a Startup-folder shortcut to `airlock-server-hidden.vbs` (node, no console).
`-Remove` undoes it.

## Layout

| File | Role |
|---|---|
| `server.js` | Express static host + streaming Ollama proxy, `/api/health`, `/api/config`, packet routes |
| `db.js` | The packet store — schema, provenance log, move/fork/nest/review, search |
| `public/index.html` · `app.js` · `styles.css` | Frontend — no dependencies, no CDN, works offline |
| `public/manifest.webmanifest` | PWA manifest; what makes the taskbar install possible |
| `tools/focus_airlock.ps1` | Finds and raises an existing Airlock window; exit code says which |
| `public/icons/` | Generated PNGs + `airlock.ico` |
| `tools/make_icons.py` | Redraws the whole icon set — edit colors here, re-run |
| `providers/` | One streaming contract, two tiers. `index.js` documents the chunk shape |
| `tools/smoke_test.js` | 89 assertions over the store API. Run it after touching `db.js` |
| `boundary.js` | The gate. Local-only, deterministic, fails closed |
| `auth.js` | Access token and remote spend cap. Off unless configured |
| `tools/provider_test.js` | 34 assertions over the provider contract. Run it after touching `providers/` |
| `tools/boundary_test.js` | 59 assertions over the gate, both crossing paths and the audit trail |
| `tools/auth_test.js` | 26 assertions over the access guard and the spend cap |
| `airlock-launch.vbs` | Ensures the server is up, then opens app mode. What the icon runs |
| `tools/install_shortcut.ps1` | Creates the pinnable Start Menu / Desktop shortcut |
| `tools/install_autostart.ps1` | Startup-folder shortcut (`-Remove` to undo) |
| `airlock-config.json` | Written on first Settings save; sampling + system prompt |
| `airlock.db` | SQLite store (WAL). Not source — delete it to reseed from scratch |

Launcher paths use `%~dp0` / self-resolving paths, so the folder can be moved.

## Features

- Streaming replies, Stop mid-generation
- Markdown rendering with per-block copy buttons
- Image attach — drag, paste, or the 🖼 button (Muse Glimmer has a perception encoder)
- Model dropdown listing every installed Ollama model, so you can A/B against qwen2.5 etc.
- Sampling controls, defaulting to Meta's recommended **temp 1.0 / top_p 0.95 / top_k 64**
- tok/s, time-to-first-token, prompt-token count per reply
- Conversation survives reload (localStorage, last 40 messages)

## The packet store

Uses `node:sqlite`, built into Node 24 — no native module, no build tools. It prints one
ExperimentalWarning on boot; that's the runtime, not a problem here.

```
folder   ── a tray            (PROJECTS, RESEARCH — whatever you name it)
  thread ── a project stream  (one per line of work)
    packet ── one unit of thought, nests via parent_id
```

Two rules the whole design hangs on:

1. **A thread is a container, not a flat log.** Packets nest arbitrarily deep via
   `parent_id`, so a master "Build Plant" packet can hold twelve sub-packets that arrived
   from different trays.
2. **Provenance is an append-only log, never a mutable field.** "This thought started in
   hardware and moved to code" is a query over `provenance`, not a column. `origin_thread_id`
   records where a packet was born and never changes; moving it adds a row.

That's why this exists before any drag-and-drop: trays, ghost trails, fork tethers and
review signatures are all *views over these tables*. Move/fork/nest are store operations,
so the board UI will be one client of them rather than the only place they live.

| Route | Does |
|---|---|
| `GET /api/tree` | Trays → threads, with packet counts |
| `GET /api/threads/:id/packets` | Nesting tree, plus origin/reviewers/hops for badges |
| `POST /api/packets` | Create. Logs a `created` event |
| `POST /api/packets/:id/move` | Drag. Carries the whole subtree; `parentId` instead = nest |
| `POST /api/packets/:id/fork` | Alt-drag. Deep-copies, sets `forked_from` as the tether |
| `POST /api/packets/:id/review` | Escalation signature — `{ actor, note }` |
| `GET /api/packets/:id/provenance` | The full trail, with thread names resolved |
| `GET /api/search` | `folder` · `thread` · `from` · `to` · `q` · `role` |
| `GET /api/travelled` | Packets whose origin ≠ current thread — ghost-trail candidates |
| `GET /api/threads/:id/brief` | Renders the thread as a portable markdown brief (`?actor=`) |
| `POST /api/threads/:id/handoff` | Records a verdict — one transaction, packet + signatures |
| `GET /api/stats` | Counts, and the db path |

"Everything in Indexing from April" is the query the schema exists to answer:

```
curl "http://localhost:8100/api/search?thread=Indexing&from=2026-04-01&to=2026-04-30"
```

A bare `to` date is treated as end-of-day, so `to=2026-04-30` includes the 30th.

Guards: a packet cannot nest into itself or into its own descendant (both 400). Deleting a
packet cascades to its children and its provenance rows.

## Layout & gestures

300px rail on the left: brand block, status + model picker, scrolling tray
list, stats, settings pinned at the bottom. Committee lane across the top of the pane.

| Gesture | Does |
|---|---|
| Drag a **packet** onto a thread | Moves it. Carries its nested children. Logs the hop |
| **Alt** + drag a packet onto a thread | Forks it. Copy keeps a `forked_from` tether |
| Drag a **packet** onto another **packet** | Nests it inside — indented on a connector rail |
| Drag a **tray header** above/below another tray | Reorders the trays themselves |
| Drag a **thread** onto a tray's landing strip | Re-files it to the end of that tray |
| Drag a **thread** above/below another thread | Reorders it. A glowing line shows the slot |
| Drag a **thread** onto another **tray** | Re-files it at the end. Packets keep their origin |
| Drag a **thread** onto a committee member | Opens the handoff brief for that member |
| Drag a **thread** onto your desktop / a folder | Writes a real `.md` file there |
| Drag a **thread** into another app's text box | Pastes the brief as text |
| Double-click a thread or tray name | Inline rename. Enter commits, Escape reverts |
| ✕ on a thread or tray | Deletes it, after a confirm that names what goes with it |

### Dragging out of the browser

| Drag | Payloads | Where it lands |
|---|---|---|
| **plain drag** | internal type + `text/plain` | Trays, committee members, nesting — and any text box: Claude, ChatGPT, an editor |
| **Shift + drag** | the above + `DownloadURL` | The OS. Chromium fetches the `.md` endpoint and writes a real file |

### ⚠ `DownloadURL` must stay behind Shift

Setting `DownloadURL` makes the OS treat the drag as a **file** drag, and that outranks the
text. A chat input then shows a drop affordance and inserts *nothing* — it's trying to
attach a file, not paste. That looked like "it wants to drop but doesn't".

So the file payload is opt-in via Shift. Don't move it back to always-on to save a keypress;
it silently breaks the common case (dropping a thought into another model) to serve the rare
one. The drag chip shows `[.md]` when Shift is held so you can see which mode you're in, and
the handoff dialog still has a **Save .md** button for threads.

What the text looks like depends on what you grabbed:

- **A thread** drops the full oversight brief — provenance, every packet numbered, the review
  ask. From `/api/threads/:id/brief.md`.
- **A packet** drops just that thought, with a one-line context header:
  `[Airlock packet #12 · thread: Indexing · born in Schema · reviewed by Claude]`.
  From `/api/packets/:id/packet.md`.

So dragging a thread into another model hands over the whole case file; dragging one packet
hands over a single thought.

`DownloadURL` is Chromium-only (`mime:filename:absolute-url`), which is fine for an
Edge-installed PWA. Because `dragstart` cannot `await`, the brief is prefetched on hover
into a small cache and invalidated whenever the tree reloads; if you drag faster than the
prefetch, `text/plain` falls back to a one-line pointer while the `.md` file is unaffected
(the OS fetches that URL itself).

### ⚠ `effectAllowed` must stay `copyMove`

Thread `dragstart` sets `effectAllowed = 'copyMove'`. **Do not narrow it to `'copy'`**, even
though the desktop drag-out is conceptually a copy.

The drag model resets `dropEffect` to `none` whenever it isn't permitted by `effectAllowed`,
and a `none` operation fires no `drop` event at all. Tray and reorder drops set
`dropEffect = 'move'`, so `effectAllowed = 'copy'` silently makes *every in-app thread drop
illegal* — you get the no-entry cursor and nothing happens, with no error anywhere.

This bug shipped once and automated tests did not catch it: synthetic `DragEvent`s don't
enforce the `effectAllowed`/`dropEffect` compatibility matrix, so the drop "worked" under
test and failed for a human. Any change here needs a real mouse.

Trays set `effectAllowed = 'move'`, which is fine because tray drops only ever use
`dropEffect = 'move'` — there is no copy semantic for a tray.

### Tray landing strips

A tray's box is exactly its header plus its rows — it has no padding of its own, so there is
no leftover area inside it to aim at. An **empty** tray was therefore a 28px header strip
that also doubles as the drag handle: effectively impossible to drop a thread into.

So every tray ends in a `.tray-tail` landing strip. 10px at rest, expanding to 26px while a
thread is in flight (`body.dragging-thread`), and for an empty tray it becomes a labelled
dashed box — *empty — drop a thread here*. Dropping on it re-files the thread to the end of
that tray; dropping on a specific row still places it precisely.

The expansion is a CSS transition, so it's decoration: if it never runs, the 10px strip and
the rows are still there and the drop still works.

### Drag handles

The **tray header** is the tray's drag handle, not the whole tray. A tray's body is full of
threads that are draggable in their own right, and nesting drag sources makes the browser
pick the innermost one — so the gesture would be ambiguous.

A packet drags by its **label** (`You · #12`, with a `⠿ drag` grip on hover), not by its
bubble. The bubble was draggable at first and that made its text impossible to select, because
a draggable ancestor swallows `mousedown` — the same trap as the rename input. Anything
containing text you might want to select must not be a drag source.

Renaming temporarily sets `draggable = false` on the enclosing row or header. A draggable
ancestor swallows `mousedown`, so without this you drag the row instead of selecting text in
the input. Automated tests use `.select()` and never touch a mouse, so they can't catch it.

Every packet shows its id in the label (`You · #12`) so a brief can refer to it by number.
Badges under a packet read its provenance: `from Schema` when it was born elsewhere, `1 hop`,
`nested`, `reviewed by Claude`, `oversight verdict`.

## Settings, and which of them cross

Four sampling controls sit in Settings, and only two of them mean anything
remotely. The panel says so, because a control that silently does nothing is
worse than one that isn't there.

| Setting | Local | Remote |
|---|---|---|
| Temperature | yes | yes |
| Top P | yes | yes |
| Top K | yes | **not sent** — not in the OpenAI schema, and a strict endpoint may reject the request over it |
| Context (`num_ctx`) | yes | **not sent** — it is Ollama's KV-cache budget and has no remote meaning |

### ⚠ The system prompt crosses

It is prepended to every turn, so when an Oversight model is selected it travels
with the conversation. That makes it the one setting which is not configuration
at all but *content* — and the panel warns accordingly.

The shipped default therefore names no person and no machine. It also earns its
length, which a two-line prompt did not: it tells the model the single thing it
cannot infer from the conversation, which is that an answer here is not a chat
message but a packet, stored in a thread, read later out of order, possibly by a
reviewer who was never present for the exchange. Writing for that reader is a
different job from writing a reply.

It costs about 157 tokens a turn. That is the right trade against answers that
still make sense a month later.

## Hosting it

Airlock was built as a desktop app: one person, one machine, no login. Hosting
inverts every one of those assumptions, so two environment variables exist and
both are **unset by default**.

| Variable | Unset (local) | Set (hosted) |
|---|---|---|
| `AIRLOCK_TOKEN` | every route open | `/api/*` requires the token, as an `X-Airlock-Token` header or an `airlock_token` cookie |
| `AIRLOCK_REMOTE_BUDGET` | remote calls uncapped | that many remote calls per process, then the local tier only |

Conditional rather than always-on, deliberately. Auth that cannot be turned off
would make every local user store a credential to talk to their own machine, and
the reliable outcome of that is a token committed to a repository.

The server says which posture it is in at boot, because an unauthenticated
hosted instance is a mistake worth shouting about:

```
  auth      -> OPEN. Correct for localhost; set AIRLOCK_TOKEN before hosting.
  remote    -> uncapped. Set AIRLOCK_REMOTE_BUDGET before hosting.
```

Static files stay open even when the token is set: the page has to load in order
to ask for one. It ships no data of its own — everything comes from `/api`. A
`?t=<token>` query parameter is claimed into `localStorage` and then stripped
from the address bar, so a link can be handed out once without the token living
in browser history.

### ⚠ A shared token is not multi-tenancy

`AIRLOCK_TOKEN` answers "may you use this instance", not "who are you".
**Everyone holding it sees the same packets.** That is honest for a demo and it
is not per-user isolation — the store is a single SQLite file with no user
dimension, and giving it one is a real piece of work rather than a flag.

Which is why `AIRLOCK_DEMO=1` exists. It shows a permanent banner saying the
instance is shared and anything typed into it is visible to other visitors.
There is no dismiss control, deliberately: an application about knowing where
your data goes does not get to let people hide the notice explaining that this
particular copy is shared. Set it on any instance more than one person can
reach.

Two more things a hosted build does not inherit from the desktop one:

- **Per-thread workspaces are Windows-only.** The folder picker shells out to
  PowerShell and WinForms, so file tools do not exist on a Linux host.
- **The local tier needs a local model.** A hosted instance has no Ollama unless
  one is deployed beside it, so "local" there means a small model on the same
  host rather than on the viewer's machine.

## The gate

Escalation crosses a line, so something has to decide whether it may. That
decision is made by the **local** model, always, and it is the one part of this
design that is not negotiable.

### ⚠ The gate cannot be a remote model

The obvious implementation is to let Nemotron Nano judge the brief — it is fast,
it is cheap, and deciding what to escalate is exactly the kind of cheap
classification a small model is for.

It cannot work. To let a remote model rule on whether content may leave, you
must first send it the content. The gate would be standing on the wrong side of
the door it is guarding, and by the time it says "no" the answer no longer
means anything. **A remote gate cannot gate remoteness.**

So the gatekeeper runs on the machine it protects, and the remote tier keeps the
job it is actually good at: reasoning about what the gate released.

### It fails closed

A privacy boundary that holds when everything is healthy and leaks when the gate
is slow is not a boundary. `runGate` returns a refusal — not a release — when
the local model is unreachable, when it times out, when it answers with prose
instead of JSON, and when it answers with `"release": "yes"` instead of a real
boolean. The failure mode is always *nothing left the machine*.

`tools/boundary_test.js` drives those four cases offline by stubbing the
provider, and it imports the real `runGate` rather than a copy, so the
assertions cannot drift away from the code that ships.

The gate runs at temperature 0 with reasoning off: the same brief should get the
same ruling twice, and a yes/no does not need a reasoning channel that costs
~3.7× the wall clock here.

### Order of operations

    gate  ->  cross  ->  record

Nothing reaches the network before the gate releases it, and nothing is recorded
as having crossed unless it actually did. A refusal returns `200` with
`escalated: false` and the reason, because the request succeeded — the answer
was simply no.

## What has ever left this machine

    GET /api/threads/:id/exposure
    GET /api/exposure

This is the query the boundary exists to make answerable, and it reads the
append-only provenance log rather than any mutable field — so a packet that has
since been moved, forked or renamed still reports the crossing it actually made.

Two separate facts are recorded per covered packet, and conflating them would
lose the one that matters:

| Event | Means |
|---|---|
| `reviewed` | a judgement was made about this packet |
| `crossed` | this packet's content left the machine |

A packet can be reviewed without crossing — a local model read it. It can cross
without being reviewed — it was context in a brief, not the subject. Only
`crossed` answers the boundary question, which is why it is its own event rather
than a flag on the other.

**A manual handoff is a crossing too.** Copying a brief into Claude by hand
exposes exactly the same content as an API call; the only difference is who
carried it. Both record `crossed`, and the `transport` field says which — so the
audit answers "what left this desk", not "what used an API".

Tier is **recorded, not derived**. `packets.tier` is written at creation rather
than inferred later from the model id, because an audit trail has to say what
was true at the time: deriving it would silently reclassify history the moment a
model leaves the catalogue. Packets written before the column existed predate the
remote tier entirely, so the one-time backfill marks them `local` as a fact
rather than a guess.

### Chat crosses too, and it is recorded

Selecting an Oversight model in the composer dropdown is the other way across the
boundary, and it is the easier one to do by accident: the choice is sticky in
`localStorage`, so you can come back to a thread tomorrow already pointed at a
remote endpoint.

So the same three rules apply to chat as to escalation.

**The gate runs on a thread's first remote turn**, then the clearance is
remembered per thread per model. Gating every message was considered and
rejected: a local reasoning model costs seconds per call, and paying that twice
per turn makes remote chat unusable. A refusal comes back as `200` with
`blocked: true` and renders as the gate's reason in the transcript — nothing was
sent, so it is not an error.

> ⚠ **Known gap.** A secret typed on turn nine is not gated, because the thread
> was cleared at turn one. The fix is a cheap new-message-only gate rather than
> re-reading the whole conversation; it is not built yet.

**Every packet in the request is recorded as crossed**, deduplicated per
(packet, model). A turn resends the whole conversation, so without dedup the log
would grow quadratically with thread length. The question being answered is "has
this model ever seen this packet", and one row answers it — while a packet that
crosses to a *second* model still records a second row, because that is a
different exposure.

**The tier is resolved server-side** from the model id, in `POST /api/packets`.
The client does not get to assert which side of the boundary produced something.

### ⚠ A forced crossing says so, permanently

`force: true` skips the gate. That is allowed — an operator may know better than
a local model — but it is never invisible. The crossing note carries
`gate=FORCED` instead of `gate=released`, and a `gated` event is recorded against
the verdict packet naming it a bypass. An override that leaves no trace is the
one thing an audit trail must not permit.

## Seats that cross by themselves

The Oversight lane now has two kinds of seat, and the difference is visible
before you drop rather than after:

| Seat | Border | What a drop does |
|---|---|---|
| Nano · Super · Ultra | solid, with `↗` | gates locally, calls Token Factory, records the crossing |
| Claude · GPT · Gemini | dashed | opens the brief for you to carry by hand |

Which seats are live comes from `.env` by way of `/api/health`, so the model ids
have one home and the markup only names actors. **A seat with no model
configured is simply not live** — with no key at all, every seat falls back to
the manual brief and the committee behaves exactly as it did before any of this
existed.

## Two tiers, one stream

`providers/` is the seam. `/api/chat` pulls one async generator and never branches
on where a model runs; each provider adapts its API to a single chunk shape.

That shape is Ollama's native NDJSON, which is a deliberate choice and not an
accident of history. `public/app.js` already speaks it and is proven against it,
so adapting a new provider to the client is strictly less risky than rewriting
both ends of a working stream.

| | Local | Remote |
|---|---|---|
| Runs on | Ollama, this machine | Nebius Token Factory |
| Wire format | NDJSON | Server-Sent Events, OpenAI-shaped |
| Model ids | bare tags (`llama3.2:latest`) | namespaced (`nvidia/...`) |
| Cost | free | per token |

### ⚠ The remote tier has no `eval_duration`, so we measure it

Every reply carries a stats line, and the client computes throughput from the
final chunk as `eval_count / (eval_duration / 1e9)` — nanoseconds, because that
is what Ollama reports. **OpenAI-compatible APIs do not send a duration at all.**

Nothing throws when it is missing. `undefined` fails the truthiness check, the
client falls back to `'?'`, and every remote reply quietly renders `? tok/s`
while local replies show a real number. It is invisible in development and
obvious in a demo video, which is the worst combination a defect can have.

So `providers/tokenfactory.js` measures generation itself, timing from the
**first streamed token** rather than from the request. Ollama's `eval_duration`
covers generation only; timing from the request would fold in queueing and
network latency and understate the remote tier against the local one. Time to
first token is measured separately by the client, for both tiers, so nothing is
lost by excluding it.

`tools/provider_test.js` guards this specifically. It does not check that the
field exists — it computes the stats line the way the client does and asserts
the result is a finite number, on both tiers.

Two more translations worth knowing about:

- **Usage must be asked for.** Without `stream_options: { include_usage: true }`
  the final chunk carries no usage at all and the token counter silently reads
  zero for the entire remote turn.
- **Reasoning arrives on a different channel.** Nemotron 3 reasons heavily —
  "name one metal" produced 855 characters of reasoning for a two-character
  answer — and it is billed. The provider maps a `reasoning_content` delta
  straight across, and also splits inline `<think>` fences out of the content
  channel, carrying the open/closed state across delta boundaries because a
  fence can land anywhere.

### ⚠ `top_k` and `num_ctx` are local-tier concepts

They are not sent remotely. `num_ctx` is the local server's KV-cache budget and
has no remote meaning; `top_k` is not in the OpenAI schema and a strict endpoint
may reject the whole request over it. Temperature and `top_p` cross; the rest
stay home.

## The Galactic Oversight Committee

Escalation as a deliberate act. Drag a thread onto a committee member and you get a
portable markdown brief: the tray and thread, every packet numbered,
a provenance section calling out anything born in another thread, a list of what's already
been signed off, and a closing ask addressed to that member by name.

Copy it or save it as `.md`, carry it to whoever you like by hand, then paste their reply
into the same dialog. Recording it:

1. lands the verdict as a **real packet** in the thread, attributed to that actor — so it
   reads in context, and the transcript says `Claude · #4`, not `Local`;
2. stamps `reviewed by <actor>` on every packet the brief covered.

So you can see at a glance which thoughts are team-reviewed and which are local-only,
without anything making a pilgrimage through a paid endpoint. The verdict packet never
signs itself.

The lane reads left to right: **Local → ↗ → Oversight**. That arrow is the boundary, and
the seats past it are the only way anything crosses.

| Seat | Transport |
|---|---|
| Nano · Super · Ultra | Nemotron 3 on Token Factory — live crossing (in progress) |
| Claude · GPT · Gemini | carried by hand: brief out, verdict pasted back |

Both kinds produce the same thing — a signed packet attributed to that actor — which is
why the manual seats are worth keeping rather than replacing. A verdict is a verdict
whoever carried it, and a router that only ever reaches one vendor isn't a router.

Swap or add members by editing the `.member` buttons in `index.html` — `data-actor` is the
only thing the code reads, and it's what gets recorded as the signature.

### Where this is going

The clipboard is the transport today, and that was a deliberate choice: it kept the
escalation protocol honest while costing nothing to run. But the protocol was always the
point, and a human ferrying markdown is just a slow implementation of it.

The remote tier replaces the courier, not the protocol. A member becomes a Nemotron 3
model on Nebius Token Factory — Nano deciding whether a thread warrants escalation at all
and what gets redacted before it crosses, Super returning the standard verdict, Ultra for
threads that need a million-token window. What lands is still a signed packet attributed
to that actor, and every crossing still writes a provenance row.

That is the whole design: the boundary was already audited when nothing crossed it
automatically. Making the crossing automatic is what makes the audit worth having.

## Physics

Ghost trails (a comet from the packet to wherever it's going), mitosis on fork (the bubble
divides and a clone peels off toward the target), a tilted drag chip under the cursor
instead of the browser's default ghost, a settle-bounce on the row that receives something,
and connector rails down the left of nested packets.

### Cursor trails — colour is the affordance

Blurred wisps follow the cursor while you drag, and their colour tells you what a drop will
do *before* you let go:

| Colour | Mode | Gesture |
|---|---|---|
| **purple** `#a855f7` | move — the packet leaves and lands there | plain drag |
| **teal** `#2dd4bf` | fork — a copy, tethered to the original | **Alt** + drag |
| **amber** `#fbbf24` | export — leaving the app as a `.md` | **Shift** + drag |

The mode is read from the live modifier state on every `drag` event, so the colour changes
mid-gesture the moment you press or release Alt. The drag chip agrees with it, tagging
`[fork]` or `[.md]`. Threads and trays use the same system minus fork, which they can't do.

**Why they look ethereal rather than sparkly.** Each wisp takes *two* cursor points to draw,
so it can be aimed:

- **direction is an exponential moving average of velocity** (`K = 0.3`), not the raw last
  delta. This is the single biggest thing: with raw deltas a 2px pointer wobble across a 6px
  step swings the angle ±34°, and the trail reads as shards flying off at odd angles.
  Smoothed, the same wobbly drag holds within ~5°.
- **spacing is by distance travelled** (`TRAIL_SPACING = 13px`), not by a time throttle.
  Event timing is irregular, so throttling on time scattered them unevenly along the path.
- length *and* thickness both scale off the smoothed speed, so neighbours are near-identical
  (measured spread: 3px) rather than randomly sized
- each wisp sits on the midpoint of the step just travelled, not at the leading sample point
- drift at the end follows the smoothed heading too — using the raw step made adjacent wisps
  fly apart from each other
- `filter: blur(4px)` with a `999px` radius, so the edges are vapour rather than a drawn line
- a `linear-gradient` running dark tail → bright head, so each one has a leading edge
- `mix-blend-mode: screen`, so overlaps add light instead of stacking into mud
- fades in stretched, drifts onward, thins to 35% height and dissolves over ~760–1140ms
- **no random jitter** — jitter reads as sparks; a wisp should read as something passing through
- standing still emits nothing, which is what keeps it a ribbon rather than a puddle. A jump
  over 260px resets the motion state, so it never streaks across the screen.

### Mitosis at the moment of separation

Hold **Alt** mid-drag and the packet visibly tears: the source bubble swells and glows teal
while a ghost duplicate peels away from it. Fires **once per gesture** the instant Alt engages
— not on the drop, which was the old behaviour and meant you found out only after the fact.
The original stays put, which is the point of a fork, and the animation says so.

There's a second mitosis on the drop itself (`mitosis()`), where the clone flies to the
destination row. `announceSplit()` is the separation; `mitosis()` is the arrival.

Throttled to ~60fps and hard-capped at 36 live wisps (down from 44 — streaks overlap far more
than dots did). **The cap is tracked with a `Set`, never a counter** — `clearTrails()` zeroes a
counter while already-swept particles still have cleanup callbacks pending, and those decrement
past zero until the cap quietly stops working (measured: 62 live against a cap of 44 on the
second gesture). `Set.delete()` returning false makes every teardown idempotent.

Knobs, all in `trail()`: `TRAIL_SPACING` (tighter = denser ribbon), `K` (lower = smoother but
laggier heading), `MAX_TRAIL`, the `3.4` length multiplier and its `88` cap, `thick`, the blur
in `.trail`, and the duration.

**One rule, learned the hard way:** motion is never awaited. An earlier version did
`await comet(...)` before the store write, which meant a hidden tab, a backgrounded PWA
window, or a throttled renderer would silently fail to move the packet — `anim.finished`
only settles while frames are actually compositing. Animations are now fire-and-forget, and
every decorative node is torn down by `cleanupAfter()`, which races `anim.finished` against
a wall-clock timeout so nothing leaks when no frame ever comes.

`@media (prefers-reduced-motion: reduce)` drops all of it, and the gestures still work.

## Workspace file access

Muse Glimmer is tuned for tool calling, so each saved thread gets its own read-only **workspace
root**. Select a thread, click the composer's **⛁ files** pill, then use Browse… or paste a
path and press Enter. Switching threads switches the root automatically; clearing one
thread's root does not affect any other thread. Scratch chats have no workspace.

New threads start with **no** workspace, and that default is the point: file access is
handed over deliberately, one thread at a time.

The path box takes **absolute paths only**. `path.resolve` would read a bare `CFE` as
relative to wherever the server was started and quietly root the thread at
`airlock-ui\CFE` — a real folder, just not the one that was typed.

A root whose folder has since been renamed or deleted is a third state, distinct from
having one and from having none. The pill shows `⛁ files missing` rather than a confident
`⛁ files`, and the server withholds tools for that request: offering them means every call
fails and the model spends the whole round budget discovering it. Verified against a live
thread with its folder renamed away — one round, no tool calls attempted.

### The retired global root, and why it's fenced off

Workspaces used to be one global `workspaceRoot` in the JSON config. Upgrading copies that
value onto every thread that existed at the time, which is why older threads arrived already
pointing at `C:\work\CFE`.

That bridge is one-time, and keeping it that way needs a fence. Left armed it would re-run on
every boot against whatever `workspaceRoot` it found, granting file access to exactly the
threads deliberately left without any — quietly, to all of them at once. A restored config
backup, a copy from another machine, or a hand edit was enough to trip it.

So: `workspaceRoot` is gone from `DEFAULTS`, which is also the allowlist for
`POST /api/config`, so it can no longer be written back into the config; `loadConfig` deletes
the key outright rather than blanking it, since an empty hook is still a hook; and
`db.migrateWorkspaceRoot` records `workspace_root_migrated` in the database's `meta` table
and refuses to run twice. The marker lives with the data being migrated, not in the config,
because the config is the part that can be replaced. A database that already has the
`workspace_root` column is marked spent on open — it has already been through the change, or
was created after it.

`config.tools` went the same way. Whether tools are offered is decided per request by
whether that thread has a usable workspace, so a global flag changed nothing — while sitting
in the config file looking like a switch, and disagreeing with `DEFAULTS` about its own
value. `loadConfig` strips it on sight.

### Tests

| File | Covers | Needs |
|---|---|---|
| `tools/files_test.js` | containment, the whole security boundary | nothing |
| `tools/workspace_test.js` | the store: migration, independence, the spent bridge | nothing |
| `tools/workspace_http_test.js` | the wiring: which thread resolves to which root | nothing |

`workspace_http_test.js` spawns its own server on port 8137 against a throwaway database, so
it never reads or writes the real `airlock.db` and doesn't need Ollama. It exists because the
store and the containment layer were both tested while the part that decides *whose* root a
request gets was only ever checked by hand — which is how a shared-root bug gets
reintroduced quietly.

### ⚠ The folder picker needs an owner window

`Shell.Application.BrowseForFolder(0, …)` and `FolderBrowserDialog.ShowDialog()` with no
argument both create an **ownerless** dialog, and Windows is then free to open it *behind* the
browser. It looks exactly like nothing happened.

The picker script therefore builds a transparent 1×1 `Form` in the centre of the active
screen with `ShowInTaskbar = $false` and `TopMost = $true`, activates it, and passes it as the
dialog's owner. That keeps the chooser both visible and above Airlock. It opens at the
current thread's workspace (or your home directory) rather than This PC.

If it ever misbehaves again, the path box is editable — paste and press Enter. That path
doesn't depend on any dialog.

| Tool | Does |
|---|---|
| `list_directory(path)` | Lists a folder. Skips `node_modules`, `.git`, `dist`, `.venv`, … |
| `find_files(query)` | Filename substring search, depth 8, 150 hits max |
| `read_file(path)` | Reads a text file, 256 KB cap with a truncation note |

The loop runs **server-side** in `/api/chat`: it streams Ollama through, watches for
`tool_calls`, executes them, injects a `{"airlock_tool":…}` line the UI renders as a card,
and re-calls with the results. Capped at 5 rounds, and the final round is sent without tools
so the model is forced to answer rather than looping on an 8 tok/s budget.

Observed working: *"Read README.md and tell me which port the app listens on"* →
`list_directory(.)` → `read_file(README.md)` → "port 8100", in 56 s.

### Containment

`files.js` is the whole security boundary, so it's deliberately paranoid:

- Resolve, then compare via `path.relative` — **not** `startsWith`, because
  `C:\workspace-secret` string-matches `C:\workspace`.
- Re-check the **realpath**, so a junction or symlink inside the workspace can't tunnel out.
- Text extensions only, and a NUL-byte sniff rejects binaries that lie about their extension.
- Read-only. There is no write, delete, or shell tool. Deliberately — a shell loop
  if that's ever wanted, and it should stay a separate, consciously-chosen thing.

One more trap worth naming: the `find_files` walk tolerates unreadable directories so a
single locked folder can't kill a whole search. Applied to the root itself that turned a
renamed or deleted workspace into a cheerful `0 matches`, and the model would then report
that a file doesn't exist rather than that it never managed to look. `findFiles` now stats
the root first and says the folder is gone.

`tools/files_test.js` — **46/46**, covering `../` escapes, absolute and drive-absolute paths,
bare `..`, the prefix-sibling case, missing workspace, a vanished root across all three
tools, a file handed in as a root, binary sniffing, and truncation.
Verified against the live HTTP API too: `../../../Windows/win.ini`, `C:\Windows\win.ini`,
`..` and `../CFE/Assets` are all refused.

## Attaching files by hand

The 📎 button (and paste, and drag-drop) takes images *and* text files. A text file's
contents fold straight into the message as a fenced block — no tool round, no workspace
needed, and it works for files outside the root since you handed it over explicitly. Images
still go to the perception encoder as base64.

## Not built

- **Trays as physical bays.** They highlight and accept drops, but they don't render as
  depth-having containers, and packets don't have inertia or snap-to-grid.
- **Live remote-tier calls.** In progress — see *Where this is going* above. Until they
  land, escalation works, but a human is the transport.
- **Write access or a shell.** File tools are read-only on purpose. Adding either should
  stay a deliberate decision rather than a convenience.
- **Tool results as packets.** Tool calls render as cards in the transcript but aren't stored
  in the packet store, so briefs stay readable.

## Palette

Five hexes, and they are the tokens in `styles.css`:

| | Hex | Used for |
|---|---|---|
| ink | `#0b1120` | app background, theme-color |
| deep teal | `#022c43` | user message bubbles |
| teal | `#115e59` / `#2dd4bf` | user label, healthy status dot, icon lower arm |
| violet | `#6d28d9` | focus rings, gradients, icon upper arm |
| purple | `#a855f7` | assistant label, caret, glow, "needs attention" dot |

Buttons deliberately fill with `#5b21b6 → #7c3aed`, not `#a855f7` — white on the bright
purple is only ~3:1 contrast, which fails AA for text. All pairs now check out: body text
15.9:1, muted 6.7:1, button label 5.7–9.0:1, teal label 7.8:1, purple label 4.8:1.

`tools/make_icons.py` pours the same teal→purple ramp through a star mask, so the icon and
the CSS can't drift apart. Recolor there and re-run.

## Verified 2026-08-10

Streaming, markdown, code copy, Stop, error surfacing, stats, and the image wire format
(base64, `data:` prefix stripped, attached to the last user turn) all tested against
`qwen2.5:7b` at 84 tok/s. Palette contrast verified in-browser after the recolor.

Store: `tools/smoke_test.js` — **89/89**. Covers move-with-subtree, fork tethering, nesting,
cycle guards, review signatures, date-window search, cascade-on-delete, brief rendering,
handoff recording, rename, re-tray, thread reorder and tray reorder (both with clamping and
clean 0..n renumbering), and the `brief.md` download headers — every refusal path included.

The test is **self-contained**: it creates its own `ZZ SMOKE TEST` trays, works only inside
them, and deletes them at the end, scrubbing leftovers from an interrupted run on startup.
An earlier version asserted against the seeded trays and started failing the moment a tray
was deleted from the UI — a test that breaks when you use the app is a broken test.

Gestures verified in-browser with dispatched `DragEvent`s: nest, Alt-fork with subtree,
re-tray, reorder with the insertion indicator tracking pointer position, inline rename both
ways, and the three drag-out payloads. A self-drop onto a thread's own tray issues **zero**
writes.

**Cross-app text drop: verified 2026-08-11 by hand.** Dragging packet #3 out of Airlock and
into Claude's input box dropped exactly:

```
[Airlock packet #3 · thread: Airlock Bday]
I need to build the thing that let's you read text and .md files …
```

That also confirms the diagnosis above — with `DownloadURL` always-on the same drag inserted
nothing; behind Shift, the text lands.

**Still not verifiable here, needs a real mouse:** the `effectAllowed` matrix (where that bug
hid), the animations, and the Shift-drag file drop to Explorer. This environment's browser
pane doesn't composite frames, so no animation can be observed and no `anim.finished` ever
settles; a real drag to the desktop can't be automated at all.

Gestures verified in-browser by dispatching real drag events: packet → thread lit the drop
target and logged `moved: Indexing -> Schema`; Alt+drop forked and left the original in place
with the tether intact; thread → Claude armed the lane, highlighted the member, and opened a
brief carrying the provenance line; an empty verdict was refused; recording closed the dialog
and produced `Claude · #4` with an `oversight verdict` badge plus `reviewed by Claude` on the
covered packet.

Not verified: the drag *cursor* glyph for move-vs-fork. Synthetic `DragEvent`s don't round-trip
`dropEffect`, so only the resulting semantics are proven, not the pointer feedback.

**Vision: verified 2026-08-11.** A generated 320px red circle came back as "The image
contains a single red circle." The perception encoder works end to end through the same
base64 path the composer uses.

(The local `llama3.2-vision:11b` still fails to load with `unknown model architecture:
'mllama'` — unrelated, pre-existing, and nothing to do with this app.)
