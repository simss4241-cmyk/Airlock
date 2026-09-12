# Airlock UI

Local chat UI for **Meta Muse Glimmer 30B** (Apache 2.0, released 2026-08-10), served by Ollama.
Node/Express on **:8100**, Ollama on **:11434** — same shape as Qubit (:8000) and Synth (:8080).

## Requirements

- Node (installed), Python + Pillow (only to regenerate icons).
- Ollama. **0.32.7 is installed and is the newest release — but that is not enough yet.**

### ⚠ Required on this GPU: `OLLAMA_FLASH_ATTENTION=0`

Airlock needs **Ollama 0.32.8+** (NVIDIA/AMD support landed there; 0.32.7 and earlier
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
ollama pull muse-glimmer:30b-q4_K_M      # 18 GB — blocked, see above
start_airlock.bat
```

## Measured on this machine (RTX 5060 Ti 16 GB, q4_K_M, flash attention off)

| | |
|---|---|
| Offload split | **24% CPU / 76% GPU** — partial, as expected against Meta's 24 GB target |
| Cold load | 15–21 s |
| Throughput | **8.5–9.7 tok/s** |
| Vision | works — 320px image ≈ 219 prompt tokens, answered in 13.8 s |
| "Name one metal", reasoning **on** | 33.7 s |
| "Name one metal", reasoning **off** | **9.1 s** |

## Airlock is a reasoning model

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
| `tools/smoke_test.js` | 41 assertions over the store API. Run it after touching `db.js` |
| `airlock-launch.vbs` | Ensures the server is up, then opens app mode. What the icon runs |
| `tools/install_shortcut.ps1` | Creates the pinnable Start Menu / Desktop shortcut |
| `tools/install_autostart.ps1` | Startup-folder shortcut (`-Remove` to undo) |
| `airlock-config.json` | Written on first Settings save; sampling + system prompt |
| `airlock.db` | SQLite store (WAL). Not source — delete it to reseed from scratch |

Launcher paths use `%~dp0` / self-resolving paths, so the folder can be moved.

## Features

- Streaming replies, Stop mid-generation
- Markdown rendering with per-block copy buttons
- Image attach — drag, paste, or the 🖼 button (Airlock has a perception encoder)
- Model dropdown listing every installed Ollama model, so you can A/B against qwen2.5 etc.
- Sampling controls, defaulting to Meta's recommended **temp 1.0 / top_p 0.95 / top_k 64**
- tok/s, time-to-first-token, prompt-token count per reply
- Conversation survives reload (localStorage, last 40 messages)

## The packet store

Uses `node:sqlite`, built into Node 24 — no native module, no build tools. It prints one
ExperimentalWarning on boot; that's the runtime, not a problem here.

```
folder   ── a tray            (CODE PROJECTS, HARDWARE PROJECTS, DARTH PACKET)
  thread ── a project stream  (PBIS, Alchemi, Tonight's Run)
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

"Everything in PBIS from April" is the query the schema exists to answer:

```
curl "http://localhost:8100/api/search?thread=PBIS&from=2026-04-01&to=2026-04-30"
```

A bare `to` date is treated as end-of-day, so `to=2026-04-30` includes the 30th.

Guards: a packet cannot nest into itself or into its own descendant (both 400). Deleting a
packet cascades to its children and its provenance rows.

## Layout & gestures

300px rail on the left, Qubit's idiom: brand block, status + model picker, scrolling tray
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
  `[Airlock packet #12 · thread: PBIS · born in Alchemi · reviewed by Claude]`.
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
Badges under a packet read its provenance: `from PBIS` when it was born elsewhere, `1 hop`,
`nested`, `reviewed by Claude`, `oversight verdict`.

## The Galactic Oversight Committee

Escalation with **no API, no keys, no spend.** Drag a thread onto Claude / GPT /
Gemini and you get a portable markdown brief: the tray and thread, every packet numbered,
a provenance section calling out anything born in another thread, a list of what's already
been signed off, and a closing ask addressed to that member by name.

Copy it or save it as `.md`, carry it to whoever you like by hand, then paste their reply
into the same dialog. Recording it:

1. lands the verdict as a **real packet** in the thread, attributed to that actor — so it
   reads in context, and the transcript says `Claude · #4`, not `Airlock`;
2. stamps `reviewed by <actor>` on every packet the brief covered.

So you can see at a glance which thoughts are team-reviewed and which are local-only,
without anything making a pilgrimage through a paid endpoint. The verdict packet never
signs itself.

Swap or add members by editing the `.member` buttons in `index.html` — `data-actor` is the
only thing the code reads, and it's what gets recorded as the signature.

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

Airlock is tuned for tool calling, so each saved thread gets its own read-only **workspace
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
pointing at `C:\Projects\NeuroForge\CFE`.

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
current thread's workspace (or `C:\Projects\NeuroForge`) rather than This PC.

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
- Read-only. There is no write, delete, or shell tool. Deliberately — Qubit has a shell loop
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
- **Live frontier API calls.** Deliberate, per the handoff design above. If that changes,
  liAIseCo already has the keyed-call pattern to copy.
- **Write access or a shell.** File tools are read-only on purpose. Qubit has a shell loop
  (`qubit-chat/server.js`) if that's ever wanted — it should stay a deliberate decision.
- **Tool results as packets.** Tool calls render as cards in the transcript but aren't stored
  in the packet store, so briefs stay readable.

## Palette

From Nova's teal/purple moodboard — the five hexes are the tokens in `styles.css`:

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

Store: `tools/smoke_test.js` — **87/87**. Covers move-with-subtree, fork tethering, nesting,
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
target and logged `moved: PBIS -> Alchemi`; Alt+drop forked and left the original in place
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
