# The board

Trays, threads and packets: the store the whole application is a view over,
the drag gestures that operate on it, and the motion that makes those
gestures legible. The [README](../README.md) covers what the board is *for*;
this is how it behaves.

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

## Attaching files by hand

The 📎 button (and paste, and drag-drop) takes images *and* text files. A text file's
contents fold straight into the message as a fenced block — no tool round, no workspace
needed, and it works for files outside the root since you handed it over explicitly. Images
still go to the perception encoder as base64.

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

---

[← back to the README](../README.md)
