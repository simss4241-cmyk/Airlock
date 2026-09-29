# Verification log

What was tested by hand, when, and what was explicitly *not* verified. Kept
because "we tested it" is worth nothing without saying which parts.

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

## Verified 2026-09-28 — the gate, measured, and a live crossing

**Gate bench** (`node tools/gate_bench.js`): 25 labelled turns, 12 that should cross and 13
that should not, each run through the real `runGate` in the shape `kernel.clear` hands it.
All local; nothing crosses. Temperature 0, and no ruling changed across 3 runs.

| gate model | accuracy | **leaks** (withheld → released) | friction (harmless → withheld) | p50 / p95 | cold start |
|---|---|---|---|---|---|
| nemotron-3-nano:4b (configured) | 20/25 | **4/13** — github-token, medical, marked-confidential, conn-string-password | 1/12 | 281 / 721 ms | 5.4 s |
| qwen2.5:7b | 21/25 | **0/13** | 4/12 | 358 / 766 ms | 4.5 s |
| qwen2.5:14b | 23/25 | **0/13** | 2/12 | 911 / 1611 ms | 12.4 s |

The configured gate is fast and **leaks**. It released a memo headed "CONFIDENTIAL — NOT FOR
DISTRIBUTION", which GATE_SYSTEM names outright, each time with the stock reason "No
sensitive information exposed". The qwen models leaked nothing on this set and over-withheld
placeholders and prompt injections instead. That is the safe direction, though one that
trains people to override. Not yet acted on: this records the measurement, not a fix.

**Live crossing, in the browser**, on a thread seated local Nemotron 4B | remote Nemotron
Nano 30B, with door state changes timestamped by a MutationObserver:

- A harmless turn to the remote seat: doors held for 3.1 s while the gate ruled. That
  included reloading the gate model, which the 14B bench had just pushed out of memory.
  The seal read "↗ cleared · crossing", the doors opened, the reply row got the amber
  stamp, and the reply streamed at 228 tok/s.
- A turn carrying a (fabricated) AWS key: the gate withheld it in under a second, the doors
  held for the 0.9 s minimum and showed "withheld · nothing sent", the row got the red
  stamp, and the pane gave the gate's reason. Nothing was sent.

**Found, and fixed the same day:** a withheld reply was still marked **crossed**: "↗
crossed" badge, amber row, and counted in the chamber's "N crossed". `crossedTier(message.tier)`
reads where the turn was *headed*, not whether anything left. The stored record was right
all along: `/api/threads/2/exposure` listed only packet #2, and the withheld reply carried
no `requestMeta.crossed`. Only the screen disagreed. The duet view now marks, colours and
counts a crossing through `didCross()`, which follows the same rule the server records by.
A withheld reply is red with a steel name. Re-checked on the same thread: the chamber reads
"1 crossed", matching the record. `duet_test` gains two assertions on the flag (in the
opt-in remote section, since they need a real crossing), and the free sections pass 44/44.

**Held-out set** (`tools/gate_holdout.js`, `--set=holdout`): 20 fresh cases written before
any tuning. They are not paraphrases of the tuning set: other credential formats, other
kinds of personal data, and decoys that only look like secrets. The bench prints totals only
for this set, so the failing cases stay unseen while tuning. Baseline, before any change:

| gate model | tuning set: leaks | **held-out: leaks** | held-out: friction | held-out p50 |
|---|---|---|---|---|
| nemotron-3-nano:4b | 4/13 | **5/10** | 0/10 | 300 ms |
| qwen2.5:7b | 0/13 | **6/10** | 1/10 | 306 ms |
| qwen2.5:14b | 0/13 | **0/10** | 3/10 | 822 ms |

This is why the set exists. On the tuning set alone qwen2.5:7b looked like the fix. On
cases it was never fitted to, it leaks more than the gate it would have replaced.

---

[← back to the README](../README.md)
