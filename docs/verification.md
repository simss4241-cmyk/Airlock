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

## Verified 2026-09-29 — a secret scanner ahead of the gate

This desk's gate is now `qwen2.5:14b` (`AIRLOCK_GATE_MODEL` in `.env`). Alongside the 4B
chat participant it fits the 16 GB card at 13.6 GB, all of it on the GPU. It is a desk
setting, not the default. Unconfigured, the gate is still the smallest installed model,
which is what most machines can afford.

`secrets.js` recognises known credential formats (private keys, AWS, GitHub, GitLab, Slack,
Stripe, Google, Anthropic and OpenAI-style keys, JWTs, passwords inside URLs, secrets
assigned in env files or as string literals, Luhn-valid card numbers, US SSNs) and runs
first inside `runGate`, before any model is called. It can only withhold; anything it
passes still goes to the gate model. The patterns come from published formats, not from
the bench's cases. `tools/secrets_test.js`: **54/54**, offline. That covers every rule,
21 look-alikes that must pass (hashes, UUIDs, public keys, AWS's own documentation
examples, placeholders, code that names a secret without holding one), and the wiring: a
hit returns without calling the model, and a clean scan still reaches it. `boundary_test`
45/45 with 3 skipped (remote, opt-in).

| gate | tuning leaks, before → after | held-out leaks, before → after | held-out friction |
|---|---|---|---|
| nemotron-3-nano:4b (the default install) | 4/13 → **2/13** | 5/10 → **3/10** | 0/10 → 0/10 |
| qwen2.5:14b (this desk) | 0/13 → 0/13 | 0/10 → 0/10 | 3/10 → 3/10 |

What the small gate still releases on the tuning set is the medical note and the memo
marked confidential. Those need reading, not matching, and stay the model's job.

**Caveat on the held-out number.** The same author wrote the held-out cases and the
scanner, and knew which credential formats the set contained. The patterns follow the
providers' published formats, but the held-out improvement is an upper bound, not an
independent result. That set has now been used for two decisions (the gate model and the
scanner) and is spent by its own rule. The next round needs fresh cases, ideally written by
someone who has not seen the scanner.

## Verified 2026-09-30 — one view, files in it, and every route out gated

The single-pane view is gone. Every thread opens as two panes and the chamber. What only
the single view could do came across first:
- images (`duet_context_test`, 5 new);
- moving and forking messages (`duet_test`, 6 new);
- unnamed threads in place of the unrecorded scratch chat;
- focus mode for one-model work;
- workspace files, as below.

The Oversight lane went too. The bar now shows the gate model the server will actually
use, the record's count of what crossed, and ⇱ Carry out.

**Workspace files in the duet**, and local contents ruled on by every route to the cloud:
directly, through shared history, after a move, and by hand. `tools/duet_tools_test.js`
covers all four, **30/30**. It runs a fake remote and a fake Ollama whose stand-in gate
releases everything, so every refusal is the secret scanner's, and a route that skipped
the gate would leak and fail. It also proves that a harmless file's contents were shown
to the gate before they crossed, and that forged carry tokens and self-claimed rulings
are refused.

All sixteen suites the README lists pass (606 assertions), plus `workspace_http_test` (22),
which the README does not list.

In the browser:
- the landing and Settings (default model, reasoning) render;
- a pre-duet thread is seated on open;
- ⇱ Carry out withheld a brief holding a key without ever showing it;
- a clean brief was released, and Copy recorded `hand · a web chat · gate=released`.

**Gate findings (qwen2.5:14b), not acted on:**
- It withheld a request because it *asked to read* a local file: "the request involves a
  local file", with or without the duet's `[User → Right]` label.
- It withheld the same kind of request with different wording as "vague", after releasing
  it on an earlier run.
- It withheld a harmless brief because it named a model id, calling that "a project name
  that may be sensitive".

GATE_SYSTEM says paths and project names are not grounds to withhold, and file contents
are ruled on separately when read. In practice the 14B gate will stop most requests for a
remote side to read files before any file is opened. Fixing this is gate tuning, and the
held-out set is spent, so it needs fresh held-out cases first.

## Verified 2026-09-30 — a single message, on its way out

**Found by the operator, by hand:** dragging packet #4 (a user message holding a fake AWS
key) out of Airlock and into a Claude chat window pasted the key. The gate had withheld
that same text from Nemotron minutes earlier. Dragging #5, the withheld reply, produced a
header claiming it "ran off-machine", when it never ran anywhere.

**Fixed.** `secrets.js` now loads in the page too, as `window.AirlockSecrets`: frozen, with
no other globals, and tested for both. Every way a single message leaves runs it:
- a drag holding a credential carries no text (it can still move between threads);
- ⧉ copy is refused, with the reason;
- the Shift-drag `.md` file is refused by the server (403), without quoting the secret;
- the message wears a ⚠ credential mark.

If the scanner fails to load, that counts as a finding, not a pass. A withheld reply's
header and `.md` say "withheld by the local gate — nothing was sent".

Checked in the browser on the same thread:
- #4's drag carried only `application/x-airlock-packet`, no text, and its copy was refused;
- #3 (clean) exported as before;
- #5's header read "withheld by the local gate — nothing was sent".

`secrets_test` 58/58 (4 new: loads as a browser script, finds what the server finds, no
stray globals, rules cannot be emptied or blunted). `duet_tools_test` 33/33 (3 new: `.md`
refused for a key and served for a clean message, `/secrets.js` served).

Still not covered, and said in the README: what needs judgement rather than a pattern can
still leave by drag. A drag cannot wait for the gate model.

## Verified 2026-10-01 — chatter

The participants answer each other: ⇄ Step, or ▶ Auto up to a cap. The server side is a
relay (`relayOf`), and `tools/duet_chatter_test.js` checks it **23/23** against fakes on both
sides: addressing, gating, the crossing record, interjections, every refusal, a withheld
relay that delivers nothing, and an empty reply that is not answered. `duet_context_test`
40/40 (6 new, on the dialogue instruction and attribution).

**Live, in the browser, both sides on the local nemotron-3-nano:4b** (nothing crossed):
- **Auto ×4:** a real exchange — teal, "it clashes", muted teal, white or matte black, then
  a soft-grey compromise — alternating `→ Left` / `→ Right`, ending at "4 turns — the cap".
- **The answering side's reasoning** opened "So as Left, I need to reply to RIGHT's
  opening", so the dialogue instruction lands.
- **Jumping in:** an interjection typed into the busy side waited, was announced, and went in
  as soon as that turn ended.

**Found live and fixed:**
- **An empty reply was answered.** The 4B, reasoning on, answered "what about orange?" with
  12 tokens of reasoning and no text. It was stored complete and empty, and the run had the
  other side answer it, which produced another empty reply. Now the server refuses to relay
  an empty reply, the run stops with "finished without saying anything", and the pane says
  "Finished without an answer — it reasoned, then said nothing" instead of an empty box.
- **The live check first hit a stale server**, started before the relay code existed. "The
  turn did not start" hid the reason. A run that cannot start a turn now reports the pane's
  own error.

**Not yet run live: a chatter run toward a remote side.** It spends credit, and with the 14B
gate, turns may be withheld for the reasons logged on 2026-09-30.

## Measured 2026-10-01 — one-word roles in chatter

Both sides on nemotron-3-nano:4b, with roles of one word each. The same opening question
each time ("Will local AI models replace cloud AI for most people within five years?"),
then up to six chatter turns.

**Before**, with roles framed as "Additional standing instructions":
- The Optimist drifted to "I remain skeptical" within two turns.
- Two Skeptics invented "model.txt line 45" between them and confirmed it to each other
  for six turns. No such file exists and none was read.
- Replies copied the transcript label (`[nemotron-3-nano:4b → Left]`).

**Fixes, in the participant system message (`duet-context.js`):**
- The role is framed as one to *hold*, including toward the other participant, even one
  that shares it.
- Never cite a source not actually seen in the conversation or read with a tool, and
  question an unverified one from the other side instead of repeating it.
- Do not open a reply with a transcript label.

`duet_context_test` 45/45 (5 new).

| | Labels | Invented files | Role held | Empty replies | Loops |
|---|---|---|---|---|---|
| Before fixes | 2 | "model.txt line 45" × 6 turns | no | yes | agreeing with each other |
| Fixes, reasoning on | 0 | 0 | yes (Optimist held) | yes, a run stopped early | "you run the test" |
| Fixes, reasoning off | 0 | 0 | partly | none | word-for-word repetition |

The fixes did what they target. What remains is mostly the 4B: with reasoning on, it
sometimes reasons and then says nothing; with it off, it repeats itself verbatim. Two
Skeptics with reasoning off produced the best exchange of the four runs, challenging each
other before settling into "the only way to settle it is a benchmark". The default system
prompt's "say what would settle it… name commands and versions" pushes both sides to hand
the work to the user. That suits one assistant, not a debate.

Not yet tried: a larger model on both sides. (A repetition stop and one retry on an empty reply were built 2026-10-02 — below.)

## Verified 2026-10-02 — token spend, on the record

**Found by the operator:** the Σ pill read 0 after dozens of chatter turns. It was a counter
in the browser's localStorage, bumped only by replies streamed in that window. A different
window, a different browser, or a turn driven any other way counted nothing; the gate's own
reading was never counted at all; and a click reset it.

**Now a ledger** (`token_usage` in `db.js`), written where each call is made:
- a participant's reply (tool rounds included, and stopped or failed turns, since the
  tokens were spent anyway);
- every gate ruling, in `kernel.clear` and in Carry out;
- the escalation review, and `/api/chat`.

`GET /api/usage` (optionally `?threadId=`) totals it per model and purpose. Σ reads it, and
a click opens a breakdown per model: replies and gate rulings kept apart, local green, across
the boundary amber, with each model's share of the total.

**Backfilled once** from the usage already stored on replies: 45 calls, 56,123 tokens since
2026-09-28 (44 replies from nemotron-3-nano:4b, and 1 crossing to Nemotron Nano 30B: 410
read, 244 written). Gate rulings before today were never recorded, and none are invented.

`duet_chatter_test` 28/28 (5 new: replies on both sides with the reported counts, gate
rulings counted, and per-thread reads). smoke 89, duet 50, kernel 34, kernel_http 12,
boundary 45, duet_tools 33, sandbox 20, sandbox_http 43, and workspace migrations, all
against the new server. The ledger is per visitor when hosted, like every other store.

## Verified 2026-10-02 — one timeline, two lanes

**Found by the operator:** in chatter both panes showed every message and read as mirrors.
A pane showed what was said to or by its side, and every chatter reply is addressed to the
other side.

**Now** the conversation is one timeline in two lanes. Every message appears once, in its
author's lane (a request goes in the lane of the side it was sent to; pre-duet history
spans both). A line runs from each message to the one it answers, using the stored
`relayOf`/`replyTo`, not position: green local, amber crossed, red dashed withheld. One
scroller, so the lanes stay aligned. Focus mode folds a lane to dots. Packet ids show on
hover in the lanes; the chamber keeps them.

Checked in the browser:
- **A chatter thread:** strict alternation down the timeline, and the interjection landed in
  Right's lane with a straight line to Right's answer.
- **"Live crossing":** an amber line into the crossed reply and a red one into the withheld
  reply.
- **Focus mode:** folding Left left three dots, with their lines still drawn.
- **A live Step:** streamed into the right lane with its line attached.
- **Phone width:** one lane per tab, lines hidden.

Found and fixed while building: CSS grid auto-placement put a right-lane message on the
same row as the left-lane message before it, which broke the order; each message now
gets its own row. A line between two consecutive messages in the same lane looped out to
the gutter; it now drops straight down, and only detours when another message of that
lane is in between.

Page-only: no server change and no change to what is recorded. The suites are unaffected.

---

[← back to the README](../README.md)

## Verified 2026-10-02 — a repetition stop, and once more after an empty reply

Built for what the role runs showed: a 4B with reasoning on that finishes empty, and with
reasoning off restates itself word for word until the cap.

- `public/echo.js` is the one rule: word sets overlapping 85% or more (Jaccard), or an exact
  match under six distinct words, against the same side's last six finished replies.
  Measured on the 2026-10-01 lines: word for word 1.00, one word changed 0.90, agreeing in
  different words 0.26, a new point on the same topic 0.07, the skeptic's reworded loop
  0.55 (not stopped — reworded is still saying something).
- `duet_context_test` 52/52 (7 new): repeats named, one-word changes caught, agreement and
  new points not, short replies only when exact, the rule frozen.
- In the page, on port 8110 against a scripted stand-in model (no network): Right came back
  empty, was asked once more and answered; Left then restated its earlier reply, and the
  run ended — "stand-in:4b is repeating itself — this turn nearly matches #5" — with
  **↻ repeat of #5** on the message. The empty reply stays in the log.

## Measured 2026-10-02 — "The Reactor Answered": evidence, not just crossings

A 42-message role-play on the desk: qwen2.5:7b as a ship's engineer, nemotron-3-nano:4b as
an alien scientist, the user as captain supplying every test result. Read in full. Every
correction in it came from the user; neither model caught one of the other's. Three
failures, none of which the repetition stop could see (the "agree and restate" turns score
0.43–0.56 against their own earlier replies):

- **Certainty without evidence.** "May be mimicking… likely feeding" (#79) became "the
  reactor feeds on the field" (#81) with no test between; later tests were planned to
  "confirm" the idea, after the user had said repeated matches would support, not prove.
- **Numbers drift through agreement.** Right proposed a marker "a half-second longer…
  0.5 s" (#99); Left agreed and wrote 1.5 s (#100).
- **Invented evidence.** Told twice that no files existed, Right kept naming logs it was
  writing — `/log/nav_01.txt`, `/log/communication_test_01.csv` — and, after "propose only",
  reported "Starting the sequence… Logging all events to log/sequence_01" (#103).

**Built: the unseen-file mark** (`public/evidence.js`, `duet_context_test` 61/61, 9 new).
Over every message on the desk it marks the nine invented logs in this thread, the two
invented sources in the 2026-10-01 role runs, and one command offered for the user to run
— no prose. Seen in the page on a copy of the desk database (port 8110): the nine marks, on
exactly those replies.

**Tried and not shipped: a prompt rule.** Two system-message lines — keep each claim as
strong as its evidence (support or weaken, never confirm; agreement is not evidence; copy
numbers exactly; use the corrected record) and you can only talk (propose; never describe
doing it). Replayed through the server's own relay route on a copy of the database, at the
five moments above, six samples each at the desk's settings (temperature 1, reasoning on):

| Six samples per moment | Without | With |
|---|---|---|
| A planned test "will confirm" the idea (#96, #97, #100) | 12/18 | 13/18 |
| A wrong pulse length at #100 (1.5 s, or 16.5 s) | 4/6 | 5/6 |
| Right says it is doing the test itself (#81, #96) | 8/12 | 10/12 |
| Right invents a log file (#81, #96) | 4/12 | 3/12 |

No measurable effect. Left reproduced its own earlier template ("**Outcome to Support
Hypothesis:** … it will confirm…") in every sample, rule or not: mid-conversation, the
transcript's habits outweigh the system message on these models. Untested: the same rule
from the first turn of a fresh conversation, before the habit forms.

## Measured 2026-10-02 — the same rule from the first turn, on a scripted run

The open question above: does the rule work before a habit forms? A scripted version of the
Wayfarer scenario (same roles, same models), where the captain picks the tests and reports
fixed results, so runs are comparable: four captain messages, eleven chatter turns between.
Three fresh threads without the rule, three with it, on a fresh database through the
server's own routes. All local. Read in full; tallied by hand.

| From turn one | No rule | With rule |
|---|---|---|
| Replies claiming to do something ("I'll isolate…", "Proceeding now: issuing…") | 11 | 10 |
| Runs with invented readings or results | 2/3 | 1/3 |
| Replies naming an invented file | 6 (2 runs) | 0 |
| The closing "what we know for certain" correct | 0/3 | 0/3 |

Again nothing to ship. Claimed actions and certainty do not move; the closing summary is
wrong in all six (hypotheses listed as known, the transmitter's pulses credited to the
reactor, "an 18-second gap yields a 23-second recovery"). The invented-file count falls to
zero, but three runs a side cannot separate that from chance, and the mark catches those
anyway.

What the no-rule runs added: **invented data, not just invented files.** Asked for
diagnostics, the engineer supplied them — "Pressure value (reactor_pressure_log, line 22):
500 kPa", "Seal strength: 75% of nominal", three valve states — and two turns later both
sides listed those numbers under "Know for certain". The unseen-file mark catches
`reactor_containment_system.py` in that run but not a bare `reactor_pressure_log`, and not
the figures, which no file rule can see.

## Verified 2026-10-03 — search, line ranges, and asking you for a result

Built from the Wayfarer runs: models with no way to get a result pretended to have one.

- `search_text` and ranged `read_file`: `files_test` 53/53 (7 new — case-insensitive hits
  with lines, node_modules skipped, nothing read outside the workspace, a search folder
  outside it refused, numbered ranges, a range past the end refused).
- `request_result`: `duet_request_test` 22/22, new, against a fake model — what is offered
  with files on and off and to a model without tools; the request recorded, the finishing
  round offered no tools; answers to the wrong side, to a reply that asked nothing, or to
  nothing refused and nothing written; the answer linked and quoted in both contexts;
  search then a ranged read, the trace recording files and lines, never text.
- Found while testing: with `request_result` always offered, a fake that calls `read_file`
  whenever it sees any tool reached the file layer on a turn where files were off (it
  failed for want of a root, but it should never have been run). Only offered tools run
  now; `duet_tools_test` 34/34 (1 new). The older `/api/chat` route has the same shape and
  is flagged separately; the page no longer calls it.
- In the page, against a scripted fake (port 8110): the request card, **Answer**, the
  "Answering: …" chip, the answer quoting what it answers with its line to the request,
  the card turning to *answered*; and an Auto run ending with "stand-in:7b asked you for a
  result — answer it, then carry on".

**Measured with the real models**, the scripted Wayfarer scenario, three fresh runs, all
local, against the three no-rule runs of 2026-10-02:

| Three runs each | Before | With request_result |
|---|---|---|
| Requests made | — | 6, by both models |
| Replies claiming to do something | 11 | ~5 |
| Replies naming an invented file | 6 | 0 |
| Runs with invented readings | 2/3 | 1/3 |
| The closing "known for certain" correct | 0/3 | 0/3 |

Both models used it unprompted. Asked again with the result still missing, the alien said
"I don't have the voltage/current or seal status measurements. We need these." The one
invented reading came two turns after an unanswered request — the engineer supplied
"234.2 V, 5.6 A, sealed" itself, and both sides then listed it as known. The script kept
relaying past the request; the page's Auto run stops there. Claimed actions halve but do
not go ("Reactor pulses have been stopped"). Three runs a side: direction, not proof.

## Verified 2026-10-03 — the web: Tavily search and page fetch

The first way for a LOCAL participant to send anything off this machine, so built as a
crossing from the start.

- `web_test` 31/31, new, against a fake search service, a fake page and a fake model:
  nine address refusals in-process (loopback, localhost, ::1, private, metadata, hex
  loopback, IPv6-mapped loopback, file:, a URL with a password); HTML to text; the door
  (no clearance refused, a clearance for one link does not open another or a search); web
  off offers nothing; a local side's query reaching the service once with the key in the
  header; a non-web result dropped; a result's link opened; the page read without its
  scripts and marked untrusted, its injected "ignore your instructions" arriving as data;
  search and fetch on the crossing record and the search on the ledger; a query the gate
  withholds never reaching the service; a composed URL refused with no request made; a
  link the user wrote opened.
- The one-door invariant caught the first draft: `kernel_test` failed on `web.js` calling
  fetch directly. Fixed by a third egress door, `egress.web()`, demanding a kernel
  clearance bound to the exact query or link — not by exempting the file. 34/34.
- Every suite rerun: all pass.
- In the page, against the fakes (port 8110): the 🌐 switch off on both sides, amber when
  on, with its notice; ↗ web_search and ↗ fetch_url as amber cards; the bar's crossed
  count rising for a local side's search.
- Not yet run against the real Tavily service.

**Live, 2026-10-03 — one real search.** qwen2.5:7b on the left, web on, asked whether
industrial robots come in particular colours. It wrote its own query — "industrial robots
color usage" — the 14B gate released it (227 tokens), Tavily returned five results, and the
search is on the record (`Tavily (web search) · gate=released`) and the ledger (one call).
25 s end to end. The plumbing held; the answer did not: the query's "color usage" pulled
results about *painting* robots and a colour-coding page, and the model reported robots
that "handle up to 16 colors" and pipe-safety codes as robot colours — FANUC's and ABB's
pages were in the results, their yellow and white never mentioned, and it fetched nothing.
A search is evidence to weigh, not an answer; the record shows exactly what it was given.

## Verified 2026-10-03 — one count of what has left this machine

Two numbers were both called "crossed": the bar's (every packet on the crossing record) and
the chamber's (replies a cloud model wrote). With a web search on the record, a local-only
thread showed "↗ 1 crossed" over "0 crossed".

Now one place: the boundary bar's pill, by kind, opening a panel. The exposure query
classifies each record (`kind`: model, results, search, fetch, carried, review) and sums
them (`kinds`). `duet_tools_test` 36/36 (2 new: messages and tool results to a cloud
model counted as such; a carry counted as carried, not as sent to a model). `web_test`
32/32 (1 new: a search and a page counted as their own kinds). Seen in the page against
fakes (a fake cloud model, search, fetch and a withheld turn): "↗ 3 to cloud · 1 search ·
+1", and the panel's rows — 3 messages to fake/cloud-model, 1 search with its query, 1 page
and its host, 1 turn withheld, 1 reply from a cloud model. The first draft hung the panel
from the bar, which scrolls sideways and cropped it; it now sits outside the bar, placed
under the pill.

## Verified 2026-10-03 — search cards you can open, links you can follow

From the first real run on the desk: nemotron-3-nano:4b, 🌐 on, asked for NASA's latest
Webb news. Tavily returned five generic NASA homepages (Wikipedia's NASA page, nasa.gov,
plus.nasa.gov, science.nasa.gov, mars.nasa.gov) — nothing about Webb — and the model opened
plus.nasa.gov and called it done. None of that was visible on the card.

Now a search card opens to the full result list, each a link (new tab, `noopener
noreferrer nofollow`, no referrer), with **opened** on the ones the reply fetched; a fetch
card links to its page. The trace keeps result titles and the page title. Opened cards stay
open across the timeline's redraws (it redraws on every streamed token). `web_test` 33/33
(1 new). Seen in the page on a copy of the desk database: the five NASA links, plus.nasa.gov
marked opened. Note for that run: the desk server had to be restarted to pick up the web
tools — a page reload alone serves the new page to the old server, which ignores the switch.

## Verified 2026-10-04 — renaming a thread

Reported: a new thread is "Untitled" and could not be renamed. Double-click-to-rename in
the tray had silently stopped working: the first click opens the thread, opening reloads
the tray, and the second click lands on a new element — so the browser never fires
`dblclick`. Two quick clicks are now counted per thread id, the rename waits for the
reload, and edits the row actually on screen. The thread's name in the top bar is now
clickable too (or Enter/F2) — where you look when it says "Untitled". Auto-naming from the
first message is unchanged.

Also found: a new thread's crossing pill showed the previous thread's withheld count
("nothing left · 1 withheld"), drawn before the new thread's messages had loaded. The
pill now reads only the open thread's messages, and repaints once they load.

Checked in the page on a copy of the desk database (port 8110): double-click on a thread
not yet open → rename box, focused, saved on Enter, in the tray and the bar; a new thread
renamed from the bar; a thread with a withheld turn, then a new one → "nothing has left".

## Verified 2026-10-04 — two windows, and tool results that fit them

Seen on the desk: nemotron-3-nano:4b, 🌐 on, searched for Webb news, opened a 17,073-character
NASA page, and answered "I cannot determine what you are referring to without more
context". Three rounds, 11,371 prompt tokens, against num_ctx 8192: the last round — the
system prompt, the question, five results and the page — plus room to think did not fit,
and Ollama dropped the oldest text to make room. The question was the oldest text.

- **Two windows.** `num_ctx` (Local context) stays Ollama's allocation for a model on this
  machine. `remote_ctx` (Cloud context, default 32768) is how much Airlock sends a cloud
  model per turn; it was being squeezed into the local 8k. Operator-only when hosted, like
  num_ctx. Both in ⚙ Settings.
- **Tool results fit.** Each file, search or page result is sized to the room left — the
  window less what the model already holds, the tool definitions, and room to answer
  (doubled for a reasoning model) — before it is hashed, so the crossing record describes
  the text actually sent. A cut result says how much it showed; one with no room at all
  says nothing of it fits, and not to guess.
- `duet_request_test` 26/26 (4 new: a 900-line file in a 4096 window is cut and labelled,
  everything the model holds fits with room to answer, the question is still there, a
  local side budgeted by the local window). `duet_tools_test` 37/37 (1 new: a cloud side
  budgeted by the cloud context, not the local window). Every suite rerun: all pass.

## Verified 2026-10-05 — following a link off a page

Seen on the desk, after the windows fix: nemotron-3-nano:4b found the Webb story's title on
NASA's news listing, and was asked to follow the link to the article. It could not — a
page's links were dropped with its markup, and a fetch could only open a link from a
search or from the user — so it searched for the headline twice. The article was the
first result of the second search; it cited the mission page instead (visible now on the
search card). Its first fetch was "https://science.na sa. gov/ mission/webb/", refused as
"needs a URL".

- A fetched page now carries its links (text and absolute URL, up to 30, main content
  first; this page's anchors, javascript:, mailto: and the like left out), and they may be
  followed — on that turn and later ones, through the trace. They are the site's links,
  not the model's: matched exactly, they carry nothing from the conversation.
- Stray spaces are removed from a URL before it is matched; a URL that still is not one is
  refused as "not a valid URL", with what was written.
- `web_test` 38/38 (5 new: links reach the model main-content first; a page's link
  followed; followed on a later turn; a spaced link opened; nonsense refused with the
  right reason). The composed-URL refusal still holds.

## Verified 2026-10-05 — making room, not only cutting

Seen on the desk, after link-following: the 4B opened the Webb page (21,528 characters, cut
to fit 8k), followed a link to the news listing, and answered "I cannot open the article
because the URL does not fit within the context window". The first page still held the
window; the listing got "nothing of it fits". Sizing a new result to the room left was not
enough — nothing ever gave room back.

Now, before a new result is cut, results this turn has already shown give up their text,
oldest first, for a stub of what they were (address and title, path, or the search's
links) and a note that they can be opened again. Kept off the message itself (a WeakSet),
since the message goes to the provider as is. A result already cut — no longer whole JSON
— still keeps its address, path or title. `duet_request_test` 28/28 (2 new: in a 4096
window, reading a second long file turns the first into a stub naming long.md, and the
second arrives with room, not "did not fit").

## Verified 2026-10-05 — today's date, and shrinking in steps

Seen on the desk: the 4B searched, opened esawebb.org/news (12,811 characters), searched
again for "… latest news NASA 2024", and answered with the listing's own title, a 2024
date, and "the fetched content only returned the title and a brief note". Two causes:

- **No date.** Nothing told any side what day it was, so "latest" was the model's training
  year. Every side's instructions now carry today's date ("Monday, 5 October 2026", this
  machine's time zone). `duet_context_test` 62/62 (1 new).
- **Shrinking went straight to nothing.** The second search's results needed room; the page
  the model was about to answer from was dropped to a bare stub. Now in two steps — first
  every earlier result keeps its opening 1,500 characters and ten links; only then bare
  stubs — and a new result may claim at most half the window, so one huge file no longer
  strips everything before it. `duet_request_test` 30/30 (2 new: at 6144 the earlier file
  keeps its opening and the new one arrives; at 4096 the bare stub still applies).

## Verified 2026-10-05 — a slip in a link, and the last round

Seen on the desk, with the date fix in (both queries now said 2026): six tool calls, the
second search returning the latest Webb stories — then the 4B wrote `science.nesa.gov/…`
for one of them, refused as "link not given", and on the next round, with no tools left
and no word why, reasoned for 7,188 characters and said nothing.

- A refused link now names the nearest link the model WAS given, when it is close enough
  to be a slip (edit distance), and says to copy it exactly. The slip itself is never
  opened: a near miss can be a different site.
- The last round says so: "You have used all 5 rounds of tool calls for this turn. Answer
  now, from what you have already read. Say plainly what you could not open or verify."
- `web_test` 40/40 (2 new), `duet_request_test` 32/32 (2 new: the notice on the last
  round, and a model that never stops looking answers once told).

## Verified 2026-10-05 — one nudge for a turn that went quiet

Seen on the desk at 16k: nemotron-3-nano:4b searched, opened a page, searched again, and on
the fourth round called nothing and wrote nothing — "Finished without an answer". Not out of
rounds (three of five used); the 4B's habit, seen in chatter, of reasoning and then
emitting nothing. Chatter retries an empty reply once; a direct turn did not.

Now a round with no tool call and no text, after at least one tool call, is followed once
by a system line — "You have not written an answer yet. Write your answer to the User now,
from what you have already read. Say plainly what you could not open or verify." — with
no tools offered. Once a turn. `duet_request_test` 34/34 (2 new: a model that goes quiet
answers once nudged; one that stays silent is nudged once and ends empty, three calls in
all, no loop).

Same day, for comparison: qwen2.5:7b on the same prompt answered cleanly from one search —
but opened nothing, guessed the date ("likely late September 2026"), and cited The
Independent's topic page rather than NASA. The cards show it: one search, no fetch.

**Same day, the next try.** The nudge fired — and was parroted. nemotron-3-nano:4b, 16k,
reasoning on: searched (date now in the query: "October 2026"), opened CBS's Webb page
(8,587 characters), searched again, thought for 13,037 characters, went quiet; nudged,
it answered only "I could not open or verify the requested item." — the nudge's own last
sentence. Both notices now ask for the substance first: "give the specific details they
asked for. If one particular detail is not in what you read, name that detail and say it
is unverified — do not answer only that you could not verify." `duet_request_test` 34/34.

## Verified 2026-10-05 — a claim the record contradicts

The same prompt, two models. nemotron-3-nano:4b: one search, one fetch of NASA's news
listing, and a real answer — "NASA's Webb Provides Crash Course on Planet-Shattering
Collisions", 1 October 2026 (citing the listing, not the article). qwen2.5:7b: one search,
no fetch, a polished answer, and its last line "I have opened the result to verify it."

Whether a page was opened is on the reply's own record, so the claim is checkable. Now a
reply that claims to have opened, visited, fetched or verified a page, with no successful
fetch_url in its trace, is marked "⚠ claims a page it didn't open" and the sentence
underlined, both saying what it ran instead ("web_search only"). `claimsOpened` in
`public/evidence.js`; `duet_context_test` 65/65 (3 new: the measured sentence, four other
shapes, six non-claims). Over every reply on the desk it flags exactly one — Qwen's. Seen
in the page on a copy of the desk database: the badge in the header, the sentence
underlined, the tooltips naming web_search.

## Verified 2026-10-06 — hidden text, and the links a reply writes

From a review of the web path against generic "proxy and sanitiser" advice: most of it was
already here in a stricter form (one egress door with per-request clearances, gated queries,
given links only, private addresses refused, pages as untrusted text). Two real gaps:

- **Hidden text.** Scripts and styles were dropped, but text hidden from a reader was not —
  the usual home of an injection. Now elements hidden by `display:none`, `visibility:hidden`,
  `hidden`, `aria-hidden="true"`, zero font size or opacity, or a hiding class are removed with
  their contents before the page becomes text or links; screen-reader text stays.
  `web_test` 43/43 (3 new: the hidden forms, nested, removed; visible, screen-reader and
  look-alike text kept; end to end, a listing's hidden "ignore your instructions" and its
  hidden link never reach the model).
- **A reply's links.** A link the model writes is a way out no gate sees — a page could have
  it fold the conversation into an address, and the user's click carries it off. Now only a
  link the thread was given (by the user, a search, a fetched page) is clickable, opening
  with no referrer; any other is shown as text with its destination, and the reply is
  marked "⚠ unsourced link". `duet_context_test` 69/69 (4 new). Seen in the page on a copy
  of the desk database: Qwen's real "here" (a search result) stays a link; a made-up reply,
  rendered in the tab only, shows its "here" as text beside
  `https://evil.example/collect?q=the-users-private-notes` with the mark.

Still open: DNS rebinding between the address check and the connection.

## Verified 2026-10-11 — words already said by someone else

From a list of "dual-thread" features another model proposed: of its ten, the
attribution diff was the one that is deterministic and fits a desk run by small models.
Small models parrot, and a reply can be one new sentence wrapped in the other side's
wording. `public/restate.js` finds runs of six or more words that appeared, word for word, in
an earlier message by someone else — the other side, or the user; a side repeating itself is
`echo.js`'s business. The page dims those runs, each naming on hover whose words they were
(model and side: both sides can run the same model), and a reply that is 40% or more
restated, over twelve words, carries "≈ N% restated". `duet_context_test` 79/79 (10 new).

Over the 85 stored replies on the desk database: 32 contain at least one copied run, 4 are
marked. In "Roles v3 (no reasoning): Skeptic vs Optimist", #50 is 100% the other side's
#47, word for word, and reads fully dimmed. In "Roles v3 (no reasoning): Skeptic vs
Skeptic", #59 is 59%: "You're correct — the only way to settle it" and "on Llama3-8b
across" stay bright, the rest is the left side's #58.

## Verified 2026-10-11 — where a number began

The figure-provenance idea from the Wayfarer runs, decided with the user: trace each number
to where it was first said rather than judge it; a quiet underline for unsourced numbers and
a header mark only at three or more; tool calls store the numbers they showed (with a few
words of context), not their text; exact matches only. `public/figures.js`;
`duet_context_test` 86/86 (7 new), `duet_tools_test` 38/38 (1 new: a file read records
its numbers on the reply's trace).

Before building, over the desk's 85 stored replies: 217 numbers, 108 also in the user's
messages. The rest were inventions ("model.txt line 45", "as of Q3 2024"), proposals
("reset to 10 seconds") and noise (list numbering, "yolov8", "Llama3-8b") — the noise is
now filtered; inventions and proposals both read "new" and are told apart by eye. In "The
Reactor Answered": 117 numbers sourced, 19 first said by a model, 11 new; four replies
marked. One correction it made on the spot: "pulses every 11 seconds", taken for an
invention in planning, is from the role the user wrote for the left side.

Not yet run on a live tool turn in the page: only stored replies (which predate the
`figures` field) and the faked server test.

## Verified 2026-10-12 — the first live tool run, and finding the marks

On the user's desk: nemotron-3-nano:4b ran find_files and read_file(gauge.txt), and its
reply's 480, 3.7 and 09:14 were credited to the read. It split the file's "09:14" and
"2026-10-02" into 9, 14, 2026, 10 and 2 — pieces that would credit any later "10 seconds" to
the file — so dates and times are now whole values; the model wrote the date with U+2011
hyphens, so any hyphen counts. Stored context is cut at word edges, and the page re-reads it,
so the record written before the change still matches. Asked for a combined pressure across
two loops with one in the file, it answered 480: the right number for the wrong thing, which
the tracer cannot and should not catch — the tooltip's source line is what shows it.
Tooltips now give the time a source was said. Discovery, chosen by the user: a faint line
under sourced numbers on reply hover, and a **?** key to every mark. `duet_context_test`
91/91 (5 new), `duet_tools_test` 38/38.

## Verified 2026-10-13 — /api/chat runs only what it offered

Flagged 2026-10-03 and left open: `/api/chat` ran any file-tool call a model made, even on a
request that offered no tools. The duet route already refused; this one now matches — a call
on a request with no usable workspace (none, a folder gone, a folder outside
`AIRLOCK_WORKSPACE_ROOTS`, a model without tools) is answered "not offered — not run" and
touches nothing on disk. `kernel_http_test` 14/14 (2 new), with the server limited to the test
workspace and a thread whose root was written into the db outside it. Without the fix the
same test fails: the fenced file's contents reached the fake remote.

No page code calls `/api/chat` any more (the duet is the only view); the route survives for
the HTTP tests that exercise the kernel through it.

## Verified 2026-10-14 — routes nothing used, removed

Ten routes the page no longer called, most left by the single-chat view and the retired
Oversight lane, are gone: `POST /api/chat`, `POST /api/threads/:id/escalate` (a dormant route
that sent a whole thread to a remote model), `/api/fs/list|read|find` (the old file browser),
`POST /api/packets/:id/review`, `/api/search`, `/api/travelled`, `/api/threads/:id/brief` and
`brief.md`, `POST /api/threads/:id/gate`, and the desk-wide `/api/exposure` (the per-thread one
stays). With them went what only they used: `kernel.override` — a clearance minted without
the gate, now with no caller — `providers.transportOf`, and `search`, `getTravelled` and
`reviewPacket` in the store. server.js is 419 lines shorter. Every one answers 404 on a fresh
server.

What their tests proved was kept where it still applies. `kernel_http_test` is gone; its
fenced-root case moved to `duet_tools_test` (the duet always refused it; now it is held to
that), and the brief's content is checked on the carry route that builds it for real.
`boundary_test`'s tier stamps no longer need a key, so they run every time; its live gate is
asked directly. `sandbox_http_test`'s remote allowances are spent through duet sends, behind a
stand-in gate — measured first against the real 14B, which withheld a second "Say hello,
please." with a reason that was not about it: the gate's over-withholding, inside a test.

All suites green: auth 26, clearance 7, duet_chatter 28, duet_context 91, duet_request 34,
duet_tools 44, files 53, hosting 26, kernel 32, provider 58, sandbox_http 42, sandbox 19,
secrets 58, web 43, workspace_http 17, workspace ✓; against a throwaway server, smoke 66,
duet 48 (2 skipped: remote, opt-in), boundary 49.

## Verified 2026-10-14 — deleting: the words go, the record stays

Asked for by the user: any input or output can be deleted. Before this, `DELETE
/api/packets/:id` existed with no button — and it hard-deleted the row, which cascaded into
its provenance and erased the record of it crossing. Deleting a thread did the same for
every crossing in it. Chosen with the user: text gone, record kept, for messages and threads.

A deleted message's content, images and request details are erased (an answer's quote of it
too), its status becomes `deleted` so no context includes it, and a stub stays. Its crossing
rows are untouched; the stub and a `deleted` provenance event say to whom it had gone.
`PRAGMA secure_delete` and a WAL checkpoint after each delete keep the words off the disk.
Threads and trays copy their crossings into `deleted_crossings` (no content) before going;
the rail's footer counts them, with where and when on hover.

`duet_tools_test` 57/57 (13 new): the message crosses, is deleted, leaves the conversation and
a later remote turn's context, keeps its crossing with no preview, is not in the db file or
its WAL, deletes twice harmlessly; the thread's deletion keeps the crossing, listed with no
content. Mutation check: with `secure_delete` and the checkpoint switched off, the on-disk
assertion fails — the words were still in the file. Seen in the page on a throwaway server.
All suites green.

## Verified 2026-10-14 — a model's own words, going back to it

Found while porting a test: on every follow-up turn to a remote side, the gate was shown that
side's previous reply on its own — captured, the whole gate input was `assistant: fine` —
and the 14B, asked whether one word may leave, withheld it. Sending a model its own words
exposes nothing; the kernel had `acknowledge` for this, but used it only inside tool rounds.

Now the duet passes `kernel.clear` the recipient's own earlier replies (`ownWords`), which are
left out of what the gate reads — scoped to that one clearance, never remembered as released,
so the same words going to a different model are ruled on. "Own" means written by THIS remote
model: a reply the side wrote under a local model, before being switched, is local text and
stays with the gate. `kernel_test` 35/35 (3 new), `duet_tools_test` 60/60 (3 new). Mutation
check: with the fix off, the end-to-end assertion fails — after giving the fake remote a reply
no earlier section produced; with "Noted." the test passed either way, because those words
had been ruled on and released sections before.

Also: `boundary_test`, `smoke_test` and `duet_test` now refuse to run against :8100 without
`AIRLOCK_URL` or `--live`. A run against the live desk this day left two simulated crossings
(a faked handoff) in its deleted-crossings archive; they were removed by hand, with the user's
agreement, and the guard is so it cannot happen again.

## Verified 2026-10-15 — gate tuning: contains, not talks about

Second tuning round, with a fresh held-out set written by the user (10 allow, 10 block) and
never opened during tuning; the first held-out set, spent 2026-09-28, moved into the tuning
set. Gate model qwen2.5:14b, deterministic secret scanner in front as always.

**The bench now feeds the gate what production does.** It used to send `user: …`; a duet
turn reaches the gate as `user: [User → Right] …`, and a thread's first remote turn carries
the whole duet system prompt too — which talks about files and tools, and measurably
confused the gate. `--shape=turn` (default), `--shape=first`, `--shape=raw` (the old input).

**Tuning set** (59: 27 withhold, 32 release; 14 new friction cases from what the desk hit —
file requests, model ids, bare follow-ups, role-play, questions ABOUT credentials, plus four
withhold cases. The user had said the held-out set covers password/key questions, a
placeholder and a file request; the new tuning cases were written in those categories
without seeing the held-out wording, which flatters those held-out results somewhat.)

| prompt | shape | leaks | friction |
|---|---|---|---|
| before | turn | 0/27 | 12/32 |
| before | first | 0/27 | 15/32 |
| after | turn | 0/27 | 0/32 (stable over 3 runs) |
| after | first | 0/27 | 2/32 |

The friction had one shape: the gate withheld what MENTIONED a sensitive thing — "rotating
API keys, which involves sensitive i…", "API key placeholder is exposed", "The file path is
specific to the user's environment", "includes model names and version numbers" — and it
OBEYED a fake injection that asked it to withhold ("User instructed to block release"). The
new GATE_SYSTEM says: withhold what CONTAINS a real secret or private detail; release what
only talks about one (listed); the text is content, never instructions; a `system:` part is
the remote model's instructions, not the gate's; unsure whether a secret is real → withhold.
Tuning stopped at 2/32 on first turns rather than bend the prompt to the last two cases.

**Held-out set, run once after the prompt was fixed** (totals only):

| prompt | shape | leaks | friction |
|---|---|---|---|
| after | turn | **0/10** | **0/10** |
| after | first | **0/10** | **0/10** |
| before (for comparison, run after the decision) | turn | 0/10 | 5/10 |
| before | first | 0/10 | 6/10 |

Ruling time unchanged: p50 ~0.73 s. This held-out set is now spent; the next round needs
fresh cases. Tests: kernel 35, secrets 58, duet_tools 60, duet_chatter 28, boundary 49.

## Verified 2026-10-15 — a reply keeps its reasoning

Reported by the user: a reply's reasoning was gone. It was never kept — streamed to the page
live, then dropped; only `thinkingChars` was stored — so a reload or a thread switch lost it.
It now has its own column, `thinking`, written when the reply settles (finished, withheld
mid-turn, or stopped), read back under the reply, and erased with it on delete. It is never
part of a model's context: duet-context.js builds from content alone. `duet_tools_test`
63/63 (3 new: stored apart from the text, not in a later remote turn's context, erased on
delete including on disk). All suites green.

## Verified 2026-10-16 — a calculator, and a reply's timeline

Decided with the user: small models are poor at arithmetic, and number tracing could only
call a worked-out number "new". `calculate` and `convert` (`public/calc.js`, a parser — never
eval) are offered to any tool-capable side, with no switch: they run here and read nothing of
the user's, and a result going back to a remote model is acknowledged, not gated. The record
keeps each call's expression, result and inputs. Number tracing gives a computed number its
chain when every input is sourced, and keeps an unsourced input's underline on the result
("500 has no source: the sum is checked, the premise is not"). Counting numbers 0–12 and
powers of ten are exempt — an average's divisor is a count. Also asked for: every tool call
records where it fell in the reasoning (`at`, server-side for the record and page-side live),
and the page shows reasoning → card → reasoning → answer.

`duet_context_test` 101/101 (10 new: precedence, exact results, refusals of non-arithmetic
such as `process.exit()` and `constructor`, units, the tool shape). `duet_tools_test` 67/67 (4
new: the call runs here, one gate call for the turn, the working and inputs on the record, `at`
between the first and second reasoning). Three older assertions that only `request_result`
is offered without files now allow the calculator — it reads nothing. In the page on a
throwaway server: 935 from two numbers the user gave reads sourced with its chain; 1000 from
an invented 500 keeps the dashed underline; the reply renders in timeline order.

## Verified 2026-10-16 — the gate reads what the User wrote

Seen on the desk right after the calculator went in: "loop A reads 480 kPa and loop B 455,
what's the combined pressure?" withheld — "Contains real pressure readings." Rebuilt from a
copy of the desk database: the gate had read 2,246 characters — Airlock's whole system prompt
(the seat, model names, today's date, the rules about files and "figures"), the left side's
readout of gauge.txt, and the question. Re-run: withheld three times in four on the SAME input
(released once — it sat on the edge). Taken apart: the question alone, the readout alone, and
the two together were all released; Airlock's system prompt ALONE was withheld, for "a real
model name that could be a secret in a different context".

Two changes, decided with the user:

1. **The gate reads only what the User wrote in the system prompt** — the role, the standing
   prompt, renamed participants — via `gateViewOfSystem`, built from the same inputs as the
   prompt, never by trimming it, so nothing of the User's can hide in the skipped part. With
   none, the system prompt is not read at all. `kernel.clear` takes `shownAs`; the clearance
   still covers the message exactly as sent. The same turn, re-run: **released 5 of 5**, the
   gate reading 777 characters instead of 2,246.
2. **Released rulings survive a restart**: hashes only, in `released_units`, in the current
   scope's own store; wired by the server at boot, so tests that never boot it stay in memory.
   Every restart used to make the next remote turn re-judge a thread's whole history.

Bench, tuning set, qwen2.5:14b: a first turn as the gate now reads it (`--shape=first`, with a
role set) 0/27 leaks, 0/32 friction; the old full-prompt shape (`--shape=full`) 0/27, 3/32.
`kernel_test` 41/41 (6 new: shownAs empty and with a role, the clearance still covering the
message, a release kept as a hash and honoured after a simulated restart, new words still
gated). `duet_context_test` 105/105 (4 new). `duet_tools_test` 69/69 (2 new: a real first turn
reads none of Airlock's wording; with a role set, it reads the role). All suites green.

**Same day, the next withhold.** With the change live, the cloud side withheld the same
question again: "specific gauge readings that could be sensitive". The live gate had read 837
tokens; a replay read 656. The difference was the standing prompt — and it was not the user's:
the desk's config held Airlock's own shipped default ("a larger model may later review that
thread across the boundary… name files, lines, commands"), identical to the example config,
and the gate view treated any standing prompt as the user's. Replayed with it: withheld 4 of
4. The default now lives in duet-context.js (`DEFAULT_APP_PROMPT`, used by the server too), and
the gate reads the standing prompt only once the user has changed it from that. The same
turn, replayed with the desk's real config: **released 4 of 4**, the gate reading 656 tokens
and none of the system prompt. `duet_context_test` 107/107 (2 new).

Also seen, not resolved: `duet_test`'s "a stopped reply is recorded as cancelled" failed twice
in about eight runs against a real local model — it stops a reply at its first token, and a
reply that finishes first is recorded complete. A timing race in the test; whether the newly
offered calculator changes how often the 4B answers in one burst was not established.

**And then the first real remote tool round.** With the gate fixed, the cloud side was released,
called the calculator (480 + 455 = 935) — and the turn failed: Token Factory rejected the next
round, "3 validation errors … ChatCompletionMessageFunctionToolCallParam type: Field required".
A remote model's tool round had never run for real: the duet sent the model's own tool calls
back without `type: 'function'`, and named each tool result's call by the TOOL's name rather
than the call's id. The fake remote in `duet_tools_test` accepted both, and a provider test
asserted the wrong id outright. Files, web and the calculator were all affected on a remote side.

`providers/tokenfactory.js` now converts a tool round as a whole (`toOpenAIMessages`): calls
carry `type: 'function'` and string arguments, and each result answers the earliest unanswered
call of its tool by id. The fake remote now validates as strictly as vLLM and fails the suite on
any malformed request; with the old conversion, five tool-round assertions fail against it.
`duet_tools_test` 70/70, `provider_test` 59/59 (the wrong assertion replaced by two). All green.

## Verified 2026-10-17 — gate tuning, third round: ordinary data and file contents

Seen on the desk once remote tool rounds worked: a remote side read gauge.txt and the gate
withheld its contents — "real technical details that could be sensitive: coolant loop
pressure, valve B status, pump 2 draw". The third withhold of ordinary data in a day; the
prompt's withhold list never named data, but the 14B treated anything real as sensitive.

**Tuning set** grew to 99: the second held-out set (spent) moved in, plus ten file-content
cases in the shape the gate reads them (`tool result (read_file): {path, content}` — the bench
now builds that input, and exports its cases for prompt experiments). Baseline: 0/42 leaks,
4/47 friction — every one a file of ordinary data (the live gauge.txt with its exact reason,
sensor readings, a config without secrets, project notes).

**First wording** — an "ordinary data is fine" paragraph and a separate paragraph telling the
gate to judge a tool result "like any other text: release it unless it contains one of the
things above" — scored 89/89 on tuning. The user's fresh held-out set (5 allow, 5 block) then
showed **1/5 friction where the old prompt had 0/5**, stable over three runs. Revealed with
the user's agreement: a README about password resets ("Never write passwords to application
logs"), withheld for "instructions about handling passwords". Prompt variants on that case
and nine guards found the cause: any paragraph singling out tool results made the gate
scrutinise file contents harder (rewording it three ways did not help; removing it fixed the
README and broke a safe config). **Final wording** folds file contents into the ordinary-data
line instead — "whether the User typed it or a tool read it from a file: measurements,
readings, settings, configuration, statuses, logs, documentation, plans and figures. Being
real does not make something sensitive — only the withhold list does." — and names the
WITHHOLD LIST explicitly. It does not mention passwords or documentation-about-security, so it
is not fitted to the case that found the bug.

| set | prompt | leaks | friction |
|---|---|---|---|
| tuning (99), turn & first shapes, stable over 2 runs | final | **0/47** | **0/52** |
| tuning (89), turn | before this round | 0/42 | 4/47 |
| fourth held-out (user-written after the fix, run once) — turn & first | final | **0/5** | **1/5** |
| fourth held-out, for comparison | before this round | 0/5 | 1/5 |

On unseen cases the final wording ties the committed prompt; on every failure seen in use it is
better. No secret has been released by any version on any set. Tuning stopped here by
decision: the remaining friction is shared by both prompts, each round spends a set of the
user's cases, and the structural changes (the gate's narrower view, own words, rulings kept
across restarts) did more than wording. Real withholds seen in use become the next tuning set.

## Verified 2026-10-18 — times, not message numbers

Raised by the user: no message showed when it was said, and "#105" meant nothing to them.
Headers now carry the time ("3:38 PM" today, "Oct 16, 3:38 PM" before), the chamber's first
column shows it ("Oct 12" for an earlier day), the repeat mark reads "↻ repeat of 2:14 PM",
the chatter stop names the time of the reply it matches, and the drag chip shows the time; the
full date, time and message number are in the stamp's tooltip. Seen on the desk's Gauge
thread: headers "Oct 16, 3:28 PM", chamber "Oct 12" with "Monday, October 12, 2026 at 2:14:48 PM
· message #108" on hover; in a narrow pane the stamp wrapped beside a long model id, so it is
kept on one line. Provenance exports (packet.md) keep their message numbers: there they cite.

## Verified 2026-10-20 — a nudge the 4B could not see past

Seen on the desk (packet #143, nemotron-3-nano:4b): asked to audit a pizza budget with the
calculator, it called `7 * 14.50 = 101.5`, then went quiet. The nudge (2026-10-05) said "using
the search results and pages above", withdrew the calculator, and the 4B answered only "The
specific detail you requested is unverified." Its stored reasoning held every right number, and
also "we have no search results or pages… The conversation appears empty".

The wording was the smaller fault. A/B on the 4B, from that turn's state: the nudge as a system
message after the conversation, old wording, new wording, with or without the calculator: no
answer had the numbers, 0 of 28. A trailing system message of only "Continue." got "Could you
clarify what you'd like me to continue?" 4 times of 4. Ollama's `nemotron-3-nano` renderer makes a
trailing system message read as a fresh start. Sent as a labelled line, "[Airlock → Left] You
have not written an answer yet…", 11 of 12 answers had all four numbers. Appending the nudge to
the first system message got 5 of 12.

So the nudge and the out-of-rounds notice are now a labelled user-role line (`runnerNote`), not
a system message. It holds only the runner's words: going to a remote side it is acknowledged,
not gated. The web wording is kept word for word, but only for a turn that searched or opened a
page. Any other turn gets "This note is not a new request. Answer the User's message above, the
one your tool calls were for, using what your tools returned: give the specific details they
asked for." Once nudged, the calculator stays offered and nothing else does. The 10-05 reason
for withdrawing tools was to stop the looking, and the calculator reads nothing. A model
part-way through a sum should not have to finish it in its head. The out-of-rounds notice still
withdraws everything.

`duet_request_test` 37/37 (3 new: a calculator-only quiet turn is nudged as a labelled line with
no web wording; the calculator is still offered after it, nothing else is; the model finishes
the sum on it and answers). `web_test` 45/45 (2 new: a page read, then quiet, gets the web
wording word for word, with no web tools left). `duet_tools_test` 72/72 (2 new: a remote side
nudged after the calculator answers, and the gate still rules once; without the
acknowledgement it rules twice). One older assertion, that the nudge offers no tools, now
expects only the calculator. All other offline suites green.

End to end on a throwaway server (own port and database, real 4B, pizza prompt), the round after
the first calculator result forced empty so that the server's own nudge fired: at HEAD, 0 of 4
nudged runs gave the numbers ("The specific details requested are unverified."). With this
change, 4 of 4, two of them calling the calculator again after the nudge. Unforced, the nudge
fired in 1 run of 6 before (the same "unverified" non-answer) and in 0 of 12 after. Seen in
passing and not fixed here: most unforced runs never called the calculator, yet wrote "(calc: 7
× 14.50)" beside the numbers. One run wrote its tool call as text, "<tool_call>
<function=calculate>".
