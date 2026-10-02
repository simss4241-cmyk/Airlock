# The local tier

Everything about running a model on your own machine: what Ollama needs, what
this particular GPU needed, and how the reasoning channel and token spend
work. None of it is required reading to understand Airlock — see the
[README](../README.md) for that — but all of it was required to make the local
half actually run.

## Requirements

- Node (installed), Python + Pillow (only to regenerate icons).
- Ollama. **0.34.1** on this desk at last check (2026-10). The notes below were written
  against 0.32.x and are kept because the GPU settings they arrived at are still in force.

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

> ⚠ **As of 2026-09-29, Muse Glimmer 30B does not load at all** on Ollama 0.34.1 here: a
> direct `ollama` call, with no Airlock involved and nothing else resident, fails with the
> same `0xc0000409` / "shared object initialization failed" as above. `llama3.2-vision:11b`
> fails too (`unknown model architecture: 'mllama'`), so this desk currently has no working
> vision model. The measurements below are from when it loaded.

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

The **Reasoning channel** switch in ⚙ Settings sets Ollama's `think` flag. Off is roughly 3.7×
faster on this hardware and perfectly fine for lookups; on is the reason to run this model
at all. It persists in `airlock-config.json`.

### ⚠ `think` and `tools` are per-model, never global

Sending `think` to a model without a thinking channel is a hard 400 —
`"llama3.2:latest" does not support thinking` — and so is sending `tools` to a model without
tool support. `codellama:13b` has *neither*. Setting either flag from config alone breaks
every other model in the pickers, which is exactly what happened once.

So the server reads `POST /api/show` → `capabilities` per model (cached in `capsCache`) and
only sets a flag the model actually advertises. `think` is **omitted** rather than sent as
`false`, since the field itself is the request.

The UI mirrors it: `/api/health` returns each model's capabilities, the pickers badge them
(`◈` thinking, `👁` vision, `⛁` tools), and a pane's ⛁ switch reads `⛁ no tools` for a
model that has none, and 📎 warns before an image goes to a model that cannot see —
rather than offering something that would error.

Current roster:

| Model | thinking | tools | vision |
|---|---|---|---|
| `muse-glimmer:30b-q4_K_M` | ✅ | ✅ | ✅ |
| `deepseek-r1:7b` | ✅ | ✅ | — |
| `qwen2.5:7b` / `:14b` | — | ✅ | — |
| `llama3.2:latest` | — | ✅ | — |
| `llama3.2-vision:11b` | — | ✅ | ✅ |
| `codellama:13b` | — | — | — |

## Token spend

The `Σ` pill beside the Ollama version is the total this desk has spent, read from a
ledger on the server (`token_usage` in `db.js`). Every model call writes a row where it is
made: a participant's reply (every tool round included, and stopped or failed turns too,
since the tokens were spent), every gate ruling, and the escalation review. Click the pill
for one row per model and purpose — replies and gate rulings apart, local green, across the
boundary amber — with each model's share. `GET /api/usage` (`?threadId=` for one thread)
returns the same.

It used to be a counter in the browser's `localStorage`, bumped by replies streamed in that
window: another window, another browser, or a turn driven any other way counted nothing,
and the gate's own reading was never counted at all. Replies from before the ledger were
backfilled from the usage already stored on them; gate rulings from before it were never
recorded anywhere, and none are invented.

Tool rounds are why the total has to be summed rather than read off the last chunk: each
round is its own call with its own prompt and cost, and only the final round's `done`
chunk would otherwise be seen. Measured on a two-round answer: **765 tokens total, 424 in
the final round** — the other 341 were invisible before.

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

---

[← back to the README](../README.md)
