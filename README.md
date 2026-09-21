# Airlock

**A local-first reasoning desk with an audited model boundary.**

Airlock will run entirely on your own machine, answering from a local model, with
nothing leaving the desk at all. When a thread needs more than that model can give,
reaching past it is an explicit, gated, logged, signed event — not an invisible API
call buried in a settings page.

A **local** model decides whether anything may cross, because a remote gate cannot
gate remoteness. Every packet records which model touched it and which side of the
boundary it was on, so *"what has a remote model ever seen?"* is a query rather than
a guess — and a crossing by hand counts exactly the same as one over an API.

The boundary is the product. Routing is only how it is enforced.

> **What "local" means here.** It means *inside this deployment's trust boundary* —
> the machine Airlock is running on — not one particular laptop. On a desk that is
> Ollama; on a hosted instance it is whatever serves models beside the server. The
> rule is identical in both cases and is the only one that matters: **the gate never
> sends content across the boundary it is guarding.** Which models are inside is read
> from the providers' own catalogues by `providers/registry.js` and never inferred
> from the shape of a model id — anything no catalogue claims is `unknown`, and
> `unknown` is gated rather than waved through.

Node/Express on **:8100**, local inference through Ollama on **:11434**. Glimmer, the
project this was forked from, used to default to :8100 as well and now uses :8101 — the
launchers here ask `/api/whoami` who is actually answering rather than trusting an open
socket, because for a while whichever app started first silently owned both shortcuts. No build
step, no CDN, no frontend dependencies, and one npm package.

## Status

Airlock began as a fork of Glimmer, a local-first chat UI and packet store. Both
halves now exist: the desk and its record-keeping, and the boundary that governs
what leaves it. This table is the honest version — clone it and check.

| | |
|---|---|
| Local inference — streaming, reasoning channel, tools, vision | working |
| Packet store — threads, nesting, provenance, move/fork/review | working, 89 assertions |
| Per-thread read-only workspaces, with containment tests | working, 46 assertions |
| Remote tier on Nebius Token Factory (Nemotron 3) | working, 48 assertions |
| One streaming contract across both tiers | working |
| Model dropdown grouped by tier, capability-badged | working |
| Local gate rules before anything crosses, and fails closed | working, 73 assertions |
| Tier recorded per packet; "what crossed?" as a query | working |
| Escalation by router **and** by hand, both recorded as crossings | working |
| Access token + remote spend cap for hosting | working, 26 assertions |
| Duet — two addressable participants over one conversation | working, 73 assertions |
| Gate consent revoked with its thread; recycled ids inherit nothing | working, 14 assertions |
| Every turn gated, bound to the exact words sent — only what is new is re-read | working |
| One door: nothing reaches the network without a clearance the kernel issued | working, 34 assertions |
| Tool results a remote model reads are gated, and recorded as crossed | working, 12 assertions end to end |
| Redaction — crossing a brief with the sensitive parts stripped | not built |
| Per-visitor isolation (a shared token is not multi-tenancy) | not built |
| Hosted demo build | not built |

**415 assertions across eleven suites.** Run them:

```
npm start                          # in one terminal
node tools/smoke_test.js           # store
node tools/boundary_test.js        # gate, crossings, audit trail
node tools/provider_test.js        # both tiers
node tools/auth_test.js            # access guard, spend cap
node tools/files_test.js           # workspace containment
node tools/workspace_test.js       # migrations
node tools/duet_context_test.js    # what each participant is shown
node tools/duet_test.js            # two panes, one conversation
node tools/clearance_test.js       # gate consent does not outlive its thread
node tools/kernel_test.js          # the kernel, both locks, one door
node tools/kernel_http_test.js     # tool results crossing, end to end (fake remote)
```

⚠ `smoke_test`, `boundary_test` and `duet_test` test **whatever server is answering on
:8100**, not the code in front of you. An instance left running from before a change
will pass or fail on its own old code, and nothing in the output says so. Restart it
after pulling, or point them at a fresh one on a scratch database:

```
PORT=8126 AIRLOCK_DB=/tmp/airlock-verify.db npm start
AIRLOCK_URL=http://localhost:8126 node tools/boundary_test.js
```

`workspace_http_test.js` and `kernel_http_test.js` start their own servers and are
not affected.

The remote suites **skip** rather than fail without a Nebius key, so the tests
run on a clean clone with no credentials. `duet_test.js` additionally skips the
remote crossing unless `AIRLOCK_DUET_TEST_REMOTE=1`, because that one spends real
credits and a test suite should not do that without being asked.

⚠ The gate's ruling is a model's judgement, so `boundary_test.js` can occasionally
withhold a message it should release. That is reported as a failure and the dependent
assertions are marked `skip` — it no longer silently truncates the run.

Naming a small, quick local model in `AIRLOCK_GATE_MODEL` makes it both faster and
steadier; **`nemotron-3-nano:4b` is the recommended one** — 2.8 GB, fully resident on a
modest card, ~117 tok/s on the gate prompt, and NVIDIA's own Nano, so the model deciding
what may cross is the same lineage as the one receiving it. Without a name the gate
takes the *smallest* installed model over a floor, because a gate that stalls fails
closed and reaches you as a refusal of a harmless message — fitting is the thing the
default can get right, and quality is the thing only you can.

Built for the Nebius × NVIDIA Global AI Hackathon — Personal AI track.

## Setup

Needs **Node 24+** — the packet store uses the built-in `node:sqlite`, so there is
no native module to compile and no build step. Express is the only dependency.

```
npm install
cp .env.example .env        # optional: add a Nebius key for the remote tier
start_airlock.bat           # or: npm start
```

That is enough to run. **Airlock does not require you to download a model.**

- **With a Nebius key and nothing else**, it opens on Nemotron 3 Super and works
  immediately. Nothing to install, and the first message you send demonstrates
  the gate.
- **With Ollama and models already pulled**, it opens on the largest one you have
  and never contacts anything.
- **With both**, the saved config wins, and the dropdown offers either tier.
- **With neither**, it starts, says so plainly, and waits.

The default is resolved at boot rather than hardcoded, because a fixed default is
wrong for somebody — see `pickDefaultModel` in [server.js](server.js).

Whichever model is selected lives in the server's config, and the picker writes
back to it. There is deliberately no per-browser copy: one used to exist in
`localStorage`, and because it was preferred over the config it outvoted it
permanently — changing the default did nothing in any browser that had ever
picked a model, with nothing on screen to explain why.

> Remote-first as a default is a deliberate inversion, and not a retreat from
> local-first. *Local-first* is a claim about where your data rests by default,
> not about which dropdown entry is preselected. Hardcoding a local model sent a
> new arrival to fetch 18 GB before the app did anything at all — and the model
> in question is one Ollama currently refuses to serve on Windows/NVIDIA, so a
> fresh clone opened on a model it could not obtain.

For Ollama setup and the GPU archaeology that came with it, see
[docs/local-tier.md](docs/local-tier.md).

## Features

- Streaming replies, Stop mid-generation
- Markdown rendering with per-block copy buttons
- Image attach — drag, paste, or the 🖼 button (Muse Glimmer has a perception encoder)
- Model dropdown grouped by tier — local, Nemotron, other remote — with capability badges
- Sampling controls, and a panel that says which of them actually cross the boundary
- tok/s, time-to-first-token, prompt-token count per reply
- Conversation survives reload (localStorage, last 40 messages)

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

**This is now enforced rather than merely intended.** It was not, for a while: all
three call sites passed `config.model` to `runGate`, and `pickDefaultModel()` returns a
Nemotron id whenever a Nebius key is present — so on a configured machine the gate was
running *remotely*, and nothing failed, because a remote model answers the gate prompt
perfectly well. It just answers it after the content has already crossed.

`runGate` now resolves a local model itself, and **refuses** if it is handed a remote one.
`AIRLOCK_GATE_MODEL` names which local model does the job; unset, it uses the current
model when that is local, otherwise the largest installed one. Prefer something small and
quick — the gate is a short yes/no standing between you and your first remote reply.

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

**Every turn is gated, and the ruling is bound to the words.** `kernel.js` hashes
each outgoing message and issues a clearance for exactly that set, going to exactly
that model. Messages it has ruled on before are remembered, so a turn costs one gate
call over what is *new* — the next message, a tool result — not over the whole
history. A secret typed on turn nine is judged on turn nine.

This used to be once per thread: the first remote turn was gated and the answer
remembered, and that gap was accepted because the gate model cost seconds per call.
With `nemotron-3-nano:4b` as the gate it costs about one.

A refusal comes back as `200` with `blocked: true` and renders as the gate's reason
in the transcript — nothing was sent, so it is not an error.

> ⚠ **What per-turn gating gives up.** Only the new part of a turn is shown to the
> gate, so a secret split across two turns can pass as two innocent halves. The
> alternative — re-reading the whole conversation every turn — makes the gate slower
> exactly as threads get long.

**Tool results are gated and recorded.** A remote model with a workspace can call
`read_file`, and what the file contains goes to it in the next tool round. That
round is a new crossing: it gets its own ruling, a refusal stops the turn before
anything is sent and says which results were withheld, and a released result is
recorded in the exposure query by name, size and content hash. Before the kernel,
file contents followed the first ruling out of the machine without one of their
own, and never appeared in *"what has crossed"* — `tools/kernel_http_test.js`
demonstrates both, against a fake remote on localhost, so the proof costs nothing
and sends nothing.

**There is one door.** `providers.chat()` will not dispatch to anything that is not
positively local without a clearance covering every message it sends; a caller that
forgot to ask gets the gate run on its behalf, so forgetting costs a gate call and
never a crossing. Beneath it, `providers/egress.js` is the only file allowed to call
`fetch` (a test fails on any other), and it will not open a content-bearing
connection without a clearance the kernel issued.

> ⚠ **What the kernel cannot mediate.** A brief or packet you export and carry out
> by hand — that crossing is recorded, not prevented. And code that opens its own
> socket: a tool that runs third-party code would have to live in a separate
> process for any of this to hold, and none does today.

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

## Seats

Three seats, one per Nemotron tier. Drop a thread on one — or click it with a
thread open — and it gates locally, crosses to Token Factory, and records the
crossing.

| Seat | Model | For |
|---|---|---|
| ↗ Nano | Nemotron 3 Nano 30B | fast verdicts, cheap enough to use freely |
| ↗ Super | Nemotron 3 Super 120B | the standard review |
| ↗ Ultra | Nemotron 3 Ultra 550B | deep review, a million-token window |

Which seats exist comes from `.env` by way of `/api/health`, so the model ids
have one home and the markup only names actors. **A seat with no model
configured is not live**, so with no key at all the lane is empty rather than
misleading.

The manual path — `GET /api/threads/:id/brief` out, `POST
/api/threads/:id/handoff` back — still exists and is still tested. It records a
`crossed` event exactly like an API call does, because a brief pasted into
someone else's chat window exposes the same content and only the carrier
differs. It simply has no seat in the lane any more: this is a Nemotron desk, and
three tiers plus three vendor buttons made the lane read like a vendor list
rather than an escalation ladder.

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

It also means **the model choice is shared**. The current model lives in the
server's config rather than in each browser, so one visitor switching tiers
switches it for everyone. That is the right behaviour for a desktop app with two
windows open and the wrong behaviour for a shared demo; it is the same missing
per-visitor dimension, not a separate bug.

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
| `tools/provider_test.js` | 48 assertions over the provider contract. Run it after touching `providers/` |
| `tools/boundary_test.js` | 73 assertions over the gate, both crossing paths and the audit trail |
| `tools/auth_test.js` | 26 assertions over the access guard and the spend cap |
| `airlock-launch.vbs` | Ensures the server is up, then opens app mode. What the icon runs |
| `tools/install_shortcut.ps1` | Creates the pinnable Start Menu / Desktop shortcut |
| `tools/install_autostart.ps1` | Startup-folder shortcut (`-Remove` to undo) |
| `airlock-config.json` | Written on first Settings save; sampling + system prompt |
| `airlock.db` | SQLite store (WAL). Not source — delete it to reseed from scratch |

Launcher paths use `%~dp0` / self-resolving paths, so the folder can be moved.

## Not built

- **Trays as physical bays.** They highlight and accept drops, but they don't render as
  depth-having containers, and packets don't have inertia or snap-to-grid.
- **Redaction.** The gate rules on a whole brief, release or withhold. Crossing a
  brief with the sensitive parts stripped out is not built.
- **Write access or a shell.** File tools are read-only on purpose. Adding either should
  stay a deliberate decision rather than a convenience.
- **Tool results as packets.** Tool calls render as cards in the transcript but aren't stored
  in the packet store, so briefs stay readable.

## Further reading

The detail lives beside the code it describes, so this page can stay about the
idea.

| | |
|---|---|
| [docs/local-tier.md](docs/local-tier.md) | Ollama setup, the Blackwell flash-attention fight, VRAM budgeting, the reasoning channel, the token counter, the taskbar launcher |
| [docs/board.md](docs/board.md) | The packet store's schema and rules, every drag gesture, cross-app drag payloads, the motion design, the palette |
| [docs/workspaces.md](docs/workspaces.md) | Per-thread read-only file access and its containment tests (Windows only) |
| [docs/duet.md](docs/duet.md) | Two participants over one conversation: what each is shown, why a crossing exposes the other's words, the queue, the lifecycle |
| [docs/verification.md](docs/verification.md) | What was verified by hand, when, and what was not |

## Licence

Apache 2.0 — see [LICENSE](LICENSE). The same licence as Muse Glimmer, and it
carries a patent grant.
