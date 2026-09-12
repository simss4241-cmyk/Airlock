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

---

[← back to the README](../README.md)
