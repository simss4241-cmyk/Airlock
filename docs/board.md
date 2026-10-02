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
| `GET /api/threads/:id/brief` | Renders the thread as a markdown brief — a local read; crosses nothing |
| `POST /api/threads/:id/carry` | ⇱ Carry out: scanner + gate over the brief. Withheld → the ruling only; released → the brief and a one-hour token (`force: true` overrides, recorded as such) |
| `POST /api/threads/:id/carried` | The brief was copied or saved: records the crossing, with the server's ruling |
| `POST /api/threads/:id/handoff` | Records a reply carried back — with a token, the ruling and packets come from the server |
| `GET /api/packets/:id/packet.md` | One message as a `.md` file — refused (403) if it holds a credential |
| `GET /api/threads/:id/exposure` · `/api/exposure` | What has left this machine, from the provenance log |
| `GET /api/usage` | Token spend per model and purpose, from the ledger (`?threadId=`) |
| `GET /api/stats` | Counts, and the db path |

"Everything in Indexing from April" is the query the schema exists to answer:

```
curl "http://localhost:8100/api/search?thread=Indexing&from=2026-04-01&to=2026-04-30"
```

A bare `to` date is treated as end-of-day, so `to=2026-04-30` includes the 30th.

Guards: a packet cannot nest into itself or into its own descendant (both 400). Deleting a
packet cascades to its children and its provenance rows.

## Layout & gestures

300px rail on the left: brand block, status and the Σ token pill (click it for spend per
model), scrolling tray list, stats, settings pinned at the bottom. The boundary bar runs
across the top of the pane — the gate model, how much of the open thread has crossed, and
⇱ Carry out — with the two lanes below it and the chamber under them.

| Gesture | Does |
|---|---|
| Drag a finished **message** onto a thread | Moves it, detached from the conversation it left (see [duet.md](duet.md#leaving-a-conversation)). Logs the hop |
| **Alt** + drag a message onto a thread | Forks it. Copy keeps a `forked_from` tether, and its tier |
| Drag a **message** into another app's text box | Drops it with a provenance header — unless it holds a credential (below) |
| Drag a **tray header** above/below another tray | Reorders the trays themselves |
| Drag a **thread** onto a tray's landing strip | Re-files it to the end of that tray |
| Drag a **thread** above/below another thread | Reorders it. A glowing line shows the slot |
| Drag a **thread** onto another **tray** | Re-files it at the end. Packets keep their origin |
| Double-click a thread or tray name | Inline rename. Enter commits, Escape reverts |
| ✕ on a thread or tray | Deletes it, after a confirm that names what goes with it |

Nesting a packet inside another is a store operation (`POST /api/packets/:id/move` with
`parentId`) and still tested, but it is not offered in the two-lane view: a duet is one
conversation in server order, and a nested message has no place in that order. A thread
no longer drags out of the app at all — see below.

### Dragging out of the browser

| Drag | Payloads | Where it lands |
|---|---|---|
| **plain drag** | internal type + `text/plain` | A thread in the rail — and any text box: Claude, ChatGPT, an editor |
| **Shift + drag** | the above + `DownloadURL` | The OS. Chromium fetches the `.md` endpoint and writes a real file |

**A message holding a known credential carries no text out at all.** The secret scanner
(`secrets.js`, the same rules the gate runs) checks it at `dragstart`: the drag then holds
only the internal type, so it can still move between threads but inserts nothing anywhere
else; ⧉ copy is refused with the reason; and the server answers the `.md` endpoint with 403.
The message wears a ⚠ credential mark so you can see this before you reach for it. What
needs judgement rather than a pattern can still leave this way — a drag cannot wait for the
gate model — and ⇱ Carry out is the route that rules on those.

### ⚠ `DownloadURL` must stay behind Shift

Setting `DownloadURL` makes the OS treat the drag as a **file** drag, and that outranks the
text. A chat input then shows a drop affordance and inserts *nothing* — it's trying to
attach a file, not paste. That looked like "it wants to drop but doesn't".

So the file payload is opt-in via Shift. Don't move it back to always-on to save a keypress;
it silently breaks the common case (dropping a thought into another model) to serve the rare
one. The drag chip shows `[.md]` when Shift is held so you can see which mode you're in, and
the handoff dialog still has a **Save .md** button for threads.

What the text looks like depends on what you grabbed:

- **A thread** used to drop the full oversight brief. It no longer does (2026-09-30): a
  whole thread leaving by drag was a crossing by hand with no ruling and no record, since a
  drop into another app is invisible from here. Dragging a thread now only re-files it; ⇱
  Carry out is the way a thread leaves, gated first and recorded when it goes.
- **A packet** drops just that thought, with a one-line context header:
  `[Airlock packet #12 · thread: Indexing · born in Schema · reviewed by Claude]`.
  From `/api/packets/:id/packet.md`.

A withheld reply says so in that header — *withheld by the local gate, nothing was sent* —
rather than claiming it "ran off-machine", which is where it was bound, not where it ran.

`DownloadURL` is Chromium-only (`mime:filename:absolute-url`), which is fine for an
Edge-installed PWA. The OS fetches that URL itself, so the `.md` file is checked on the
server rather than in the page.

### ⚠ `effectAllowed` must stay `copyMove`

Thread and message `dragstart` set `effectAllowed = 'copyMove'` whenever an in-app drop is
possible. **Do not narrow it to `'copy'`** — a message's drag-out is conceptually a copy,
but the move onto a thread is not.

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

A message drags by its **label** (the speaker line, with a `⠿ drag` grip on hover), not by
its bubble. The bubble was draggable at first and that made its text impossible to select, because
a draggable ancestor swallows `mousedown` — the same trap as the rename input. Anything
containing text you might want to select must not be a drag source.

Renaming temporarily sets `draggable = false` on the enclosing row or header. A draggable
ancestor swallows `mousedown`, so without this you drag the row instead of selecting text in
the input. Automated tests use `.select()` and never touch a mouse, so they can't catch it.

Every packet has an id (`#12`) that the record, briefs and drag headers refer to. In the
lanes it shows on hover, beside the drag and copy controls; the chamber keeps it on every
row. Badges read a message's provenance and state: `↗ crossed`, `⚠ credential`, and the
gate's ruling when it was withheld.

## The Galactic Oversight Committee

> **Retired 2026-09-30.** The lane is gone. A participant pointed at Super or Ultra does
> the reviewing now, inside the conversation, and a brief carried by hand goes through ⇱
> Carry out, which gates it before showing it. This section records how the lane worked;
> `POST /api/threads/:id/escalate` and the handoff routes still exist and are tested.

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
| Nano · Super · Ultra | Nemotron 3 on Token Factory — gated locally, then live |

The lane used to seat Claude, GPT and Gemini alongside them for manual handoff.
That path still exists at the API and is still tested — a brief carried by hand records
a `crossed` event exactly like an API call, because it exposes the same content and only
the carrier differs. But three tiers plus three vendor buttons made the lane read as a
vendor list rather than an escalation ladder, so the buttons went and the mechanism
stayed.

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

Ghost trails (a comet from the message to wherever it's going), mitosis on fork (the bubble
divides and a clone peels off toward the target), a tilted drag chip under the cursor
instead of the browser's default ghost, and a settle-bounce on the row that receives
something. The lines between the lanes — from each message to the one it answers — are
covered in [duet.md](duet.md); the chamber's doors and seals are in the verification log.

### Cursor trails — colour is the affordance

Blurred wisps follow the cursor while you drag, and their colour tells you what a drop will
do *before* you let go:

| Colour | Mode | Gesture |
|---|---|---|
| **green** `#76b900` | move — the message leaves and lands there, still on this desk | plain drag |
| **steel** `#b9c2cc` | fork — a copy, tethered to the original | **Alt** + drag |
| **amber** `#ffb020` | export — leaving the app as a `.md` | **Shift** + drag |

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

Hold **Alt** mid-drag and the message visibly tears: the source bubble swells and glows
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

Each side's 📎 button (and paste, and drag-drop onto its composer) takes images *and* text
files. A text file's contents fold straight into the message as a fenced block — no tool
round, no workspace needed, and it works for files outside the root since you handed it
over explicitly. Images go to that side's model only, and only if it can see (👁); see
[duet.md](duet.md#images).

## Palette

Colour is **semantic**, not decorative — the one thing you must read at a glance is which
side of the boundary something is on, so that is what colour is spent on. The tokens live
at the top of `styles.css`:

| | Hex | Means |
|---|---|---|
| graphite | `#0b0d10` | the ground — app background, theme-color |
| steel | `#121519` · `#262c34` · `#8b949e` | panels, edges, muted text — everything that is not a boundary fact |
| NVIDIA green | `#76b900` | **local** — on this machine, nothing has left; primary actions |
| amber | `#ffb020` | **across the boundary** — a crossing, or about to be one |
| red | `#ff5a5f` | refused, withheld, failed |

Your own messages are steel on purpose: colour is reserved for the boundary. Buttons on
green carry near-black text (white on `#76b900` is only 2.4:1); Stop is white on a deepened
red (`#c62b2e`, 5.6:1).

`tools/make_icons.py` draws the hatch seal — a ring split by a seam, green on the inside
half, amber on the outside — from the same values, so the icon and the CSS can't drift
apart. Recolor there and re-run.

---

[← back to the README](../README.md)
