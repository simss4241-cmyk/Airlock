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
| Per-thread read-only workspaces, with containment tests | working, 53 assertions |
| Remote tier on Nebius Token Factory (Nemotron 3) | working, 61 assertions |
| One streaming contract across both tiers | working |
| Model pickers grouped by tier, capability-badged — per pane, and the default in Settings | working |
| Local gate rules before anything crosses, and fails closed | working, 73 assertions (28 spend credits, opt-in) |
| Known credential formats withheld by a scanner before the gate model reads anything | working, 58 assertions |
| Tier recorded per packet; "what crossed?" as a query | working |
| Crossing by a remote participant **and** by hand, both gated and recorded | working |
| Access token + remote spend cap for hosting | working, 26 assertions |
| Duet — two addressable participants over one conversation | working, 112 assertions |
| One timeline in two lanes: each message once, with a line to the one it answers | working |
| Roles — one word per side ("Skeptic"), held for the whole conversation | working |
| Images in a duet, for models that can see; never sent across the boundary | working |
| Chatter — the participants answering each other, step or auto, every turn gated | working, 28 assertions end to end |
| Chatter stops when a side repeats itself, and asks once more after an empty reply | working |
| A reply naming a file nobody in the thread has read or given is marked "unseen file" | working |
| Token spend on the record — every reply, gate ruling and review, per model, in a server ledger | working |
| Per-thread consent retired; an old database is cleaned on open | working, 7 assertions |
| Every turn gated, bound to the exact words sent — only what is new is re-read | working |
| One door: nothing reaches the network without a clearance the kernel issued — the web included | working, 34 assertions |
| Tool results a remote model reads are gated, and recorded as crossed | working, 12 assertions end to end |
| Workspace files in a duet, ruled on by every route to a cloud model: directly, through shared history, after a move, by hand | working, 37 assertions end to end |
| Search inside workspace files; read a numbered line range | working |
| A participant can ask you for a result instead of inventing one; your answer is linked to the request | working, 34 assertions end to end |
| Separate context windows for local and cloud models; tool results sized to fit, so the question is never pushed out | working |
| The web: search (Tavily) and fetch, off by default; every query gated from either side, only given links opened, all on the record | working, 40 assertions |
| One count of what has left this machine, by kind — to cloud models, searches, pages, carried by hand — with what was withheld and what came back | working |
| A single message dragged or copied out is scanned on the way; a credential does not leave | working |
| Carry out by hand: the brief is gated before it is shown, and recorded when it leaves | working |
| Redaction — crossing a brief with the sensitive parts stripped | not built |
| Hosted: workspaces limited to an allowlist, and OFF if the allowlist is forgotten | working, 27 assertions |
| Per-visitor sandboxes: each visitor's threads, packets and duets are private | working, 63 assertions |
| Per-visitor settings, remote budgets, gate memory and generation slots; a daily cap that survives restarts | working |
| Hosted deployment on Nebius AI Cloud, with the gate beside the app | not built |

**754 assertions across nineteen suites.** Run them:

```
npm start                          # in one terminal
node tools/smoke_test.js           # store
node tools/boundary_test.js        # gate, crossings, audit trail
node tools/provider_test.js        # both tiers
node tools/auth_test.js            # access guard, spend cap
node tools/files_test.js           # workspace containment
node tools/workspace_test.js       # migrations
node tools/duet_context_test.js    # what each participant is shown
node tools/duet_test.js            # two participants, one conversation
node tools/duet_tools_test.js      # workspace files in a duet, every route to the cloud (fakes both sides)
node tools/duet_chatter_test.js    # the participants answering each other (fakes both sides)
node tools/duet_request_test.js    # asking you for a result; search and line ranges (fake model)
node tools/web_test.js             # web search and fetch: the gate, given links only, the door (fakes)
node tools/clearance_test.js       # retired per-thread consent is removed from old databases
node tools/secrets_test.js         # the credential scanner in front of the gate (offline)
node tools/kernel_test.js          # the kernel, both locks, one door
node tools/kernel_http_test.js     # tool results crossing, end to end (fake remote)
node tools/hosting_test.js         # what a hosted instance lets a visitor reach
node tools/sandbox_test.js         # every store call routed to its visitor's database
node tools/sandbox_http_test.js    # two visitors, two sandboxes, and the ways around it
```

⚠ `smoke_test`, `boundary_test` and `duet_test` test **whatever server is answering on
:8100**, not the code in front of you. An instance left running from before a change
will pass or fail on its own old code, and nothing in the output says so. Restart it
after pulling, or point them at a fresh one on a scratch database:

```
PORT=8126 AIRLOCK_DB=/tmp/airlock-verify.db npm start
AIRLOCK_URL=http://localhost:8126 node tools/boundary_test.js
```

`workspace_http_test.js`, `kernel_http_test.js`, `hosting_test.js`,
`sandbox_http_test.js`, `duet_tools_test.js` and `duet_chatter_test.js` start their own
servers and are not affected. The last two also fake both sides — a remote on localhost
and a stand-in Ollama — so they need neither a key nor a model, and prove the plumbing
rather than a model's judgement.

How well a gate *model* judges is a separate question, measured rather than asserted:
`node tools/gate_bench.js` runs labelled turns through the real gate and reports leaks and
friction separately; `--set=holdout` runs cases kept apart for checking a change, totals
only. See [docs/verification.md](docs/verification.md) for the numbers.

The remote suites **skip** rather than fail without a Nebius key, so the tests
run on a clean clone with no credentials. With a key they *still* skip every call
that would spend it, unless asked — `AIRLOCK_BOUNDARY_TEST_REMOTE=1` for
`boundary_test.js`, `AIRLOCK_DUET_TEST_REMOTE=1` for `duet_test.js` — because
having a key is not the same as agreeing to spend it on a test. The crossing
machinery itself is covered for free by `kernel_http_test.js`, against a fake remote.

⚠ The gate's ruling is a model's judgement, so `boundary_test.js` can occasionally
withhold a message it should release. That is reported as a failure and the dependent
assertions are marked `skip` — it no longer silently truncates the run.

Which local model gates is set by `AIRLOCK_GATE_MODEL`, and it is a real trade, measured
with `tools/gate_bench.js`: `nemotron-3-nano:4b` is fast (~0.3 s a ruling, 2.8 GB) but
**released about a third of what it should have withheld**; `qwen2.5:14b` released
nothing on either test set but is slower (~0.8 s) and withholds more harmless turns. A
deterministic secret scanner runs in front of whichever you choose, so known credential
formats never depend on the model. Without a name the gate takes the *smallest* installed
model over a floor, because a gate that stalls fails closed and reaches you as a refusal
of a harmless message — fitting is the thing the default can get right, and quality is
the thing only you can.

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
- **With Ollama and models already pulled**, it opens on one that will *run* on your
  machine and never contacts anything: `nemotron-3-nano:4b` if you have it, otherwise
  the largest model at or under 8 GB. Not simply the largest you have — on an ordinary
  card that is the one that crashes on the first question.
- **With both**, the saved config wins, and every model picker offers either tier.
- **With neither**, it starts, says so plainly, and waits.

The default is resolved at boot rather than hardcoded, because a fixed default is
wrong for somebody — see `pickDefaultModel` in [server.js](server.js).

That default lives in the server's config, and the picker in ⚙ Settings writes back to it.
A new thread seats it on the side it belongs to; each side's own picker can then point
it anywhere. There is deliberately no per-browser copy: one used to exist in
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

Every thread is one conversation with two participants: a lane for each side, and the
airlock chamber below them, where every message enters and every crossing is marked.

- Two participants per thread, each with its own model, role and composer — a side on
  this machine and a side that can cross, or any mix — reading one shared conversation
- One timeline in two lanes: each message appears once, in its side's lane, with a line
  to the message it answers — green if it stayed here, amber if it crossed, red if the
  gate withheld it
- Roles: one word per side (✎ role — "Skeptic", "Optimist") is enough, and is held for
  the whole conversation, including toward the other side
- The chamber: pressure doors that hold shut while the local gate rules, and a seal on
  every row that crossed (amber) or was withheld (red)
- Focus mode (⤢) — one lane wide, the other folded to a track of dots — for talking to
  one model
- Σ token spend, from a server ledger: click it for every model, with gate rulings
  counted separately
- Workspace files (⛁) per side: on by default here, off by default across the boundary,
  and every file result ruled on before it crosses
- Images — 📎, paste or drop — for models that can see (👁)
- Move or fork a finished message to another thread by dragging it onto the rail
- ⇱ Carry out: a thread as a brief for a chat Airlock cannot see, gated first and
  recorded when it leaves
- Chatter: ⇄ Step hands the floor to the other side; ▶ Auto lets them talk to a cap, every
  turn toward the cloud gated. Type into either side to join in.
- ✎ New thread, named from the first thing you say in it
- Streaming, Stop, retry, markdown with per-block copy, tok/s and prompt-token counts
- Sampling controls, and a panel that says which of them actually cross the boundary

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
`AIRLOCK_GATE_MODEL` names which local model does the job; unset, it uses the default
model when that is local, otherwise the smallest installed one over a floor. The
boundary bar at the top of the app names the gate that will actually run. Which model
to choose is a measured trade — see the gate notes under [Status](#status).

### A scanner before the model

`secrets.js` runs first inside `runGate`, before any model is called: private keys, cloud
and platform tokens by their published formats, passwords inside URLs, secrets assigned
in env files, Luhn-valid card numbers, US SSNs. It can only **withhold** — a clean scan
still goes to the model — and it never repeats a secret beyond a four-character preview.
The same file runs in the page, so a single message dragged or copied out is checked by
the same rules (see below). Medical details, a memo marked confidential, anything that
needs reading rather than matching, stays with the model.

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
carried it. So **⇱ Carry out** rules on it the same way: the secret scanner, then
the local gate, over the whole brief, before it is shown. A withheld brief is never
put on screen. A released one is recorded as `crossed` the moment it is copied or
saved, whether or not a reply ever comes back. The ruling is held by the server
under a one-hour token, so the record cannot claim a release no gate gave, and an
override is recorded as `gate=FORCED`. The `transport` field says `hand`, so the
audit answers "what left this desk", not "what used an API".

Tier is **recorded, not derived**. `packets.tier` is written at creation rather
than inferred later from the model id, because an audit trail has to say what
was true at the time: deriving it would silently reclassify history the moment a
model leaves the catalogue. Packets written before the column existed predate the
remote tier entirely, so the one-time backfill marks them `local` as a fact
rather than a guess.

### A conversation crosses too, and it is recorded

A pane pointed at a remote model is the everyday way across the boundary, and it
carries more than the message you typed: the shared conversation, the other
participant's words included. The pane says "↗ crosses" in its header, and the same
three rules apply to every turn it sends.

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
`read_file` or `search_text`, and what the file contains goes to it in the next tool round. That
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

> ⚠ **What the kernel cannot mediate.** A brief carried out by hand is gated and
> recorded, but once copied it is out of Airlock's hands. A single message dragged or
> copied out (⧉) cannot wait for the gate model — the drag hands its text over at once,
> and Airlock cannot see where it lands. What it can do in that instant, it does: the
> secret scanner runs on the way out, in the page, by the same rules a crossing is scanned
> with. A message holding a known credential format carries no text out at all (it still
> moves between threads), its ⧉ copy is refused, its `.md` export is refused by the
> server, and it wears a ⚠ mark. What needs judgement rather than a pattern — a medical
> note, a memo marked confidential — can still leave this way; ⇱ Carry out is the route
> that rules on those.
>
> Nor can it mediate code that opens its own socket: a tool that ran third-party code
> would have to live in a separate process for any of this to hold, and none does today.

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

## Asking a bigger model

There used to be an Oversight lane: three Nemotron seats to drop a thread on for a
review. A participant does that job now, inside the conversation. Point the right
pane at Nemotron 3 Super or Ultra and ask it — it reads the shared conversation,
the gate rules first, and the crossing is recorded like any other.

| Model | For |
|---|---|
| Nemotron 3 Nano 30B | fast answers, cheap enough to use freely |
| Nemotron 3 Super 120B | the standard review |
| Nemotron 3 Ultra 550B | deep review, a million-token window |

Which of them exist comes from `.env` by way of `/api/health`. The whole-thread
review behind the old seats is still an API — `POST /api/threads/:id/escalate`,
gate first, cross second, record third — and still tested, with no button.

## Two tiers, one stream

`providers/` is the seam. The duet runner (and the older `/api/chat` route) pull one
async generator and never branch on where a model runs; each provider adapts its API to
a single chunk shape.

That shape is Ollama's native NDJSON, which is a deliberate choice and not an
accident of history: the server was built and proven against it first, so adapting a
new provider to it is strictly less risky than rewriting both ends of a working stream.

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
  the final chunk carries no usage at all and the token ledger silently records
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

⚙ Settings holds each thread's workspace, the default model for new threads, the
reasoning switch, the system prompt, and four sampling controls — only two of which
mean anything remotely. The panel says so, because a control that silently does nothing is
worse than one that isn't there.

| Setting | Local | Remote |
|---|---|---|
| Temperature | yes | yes |
| Top P | yes | yes |
| Top K | yes | **not sent** — not in the OpenAI schema, and a strict endpoint may reject the request over it |
| Context (`num_ctx`) | yes | **not sent** — it is Ollama's KV-cache budget and has no remote meaning |

### ⚠ The system prompt crosses

It is prepended to every turn, so when a participant runs across the boundary it travels
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
inverts every one of those assumptions, so everything below is **unset by
default** and a desk never sees any of it.

For a public demo, this is the configuration that is actually safe to hand to
strangers:

```
AIRLOCK_SANDBOXES=1                     # one private sandbox per visitor
AIRLOCK_REMOTE_BUDGET=500               # remote calls per UTC day, for the whole demo
AIRLOCK_SANDBOX_REMOTE_BUDGET=40        # and per visitor
AIRLOCK_WORKSPACE_ROOTS=/srv/airlock/samples   # the only folders a visitor may open
```

### One sandbox per visitor

With `AIRLOCK_SANDBOXES=1`, a first visit gets a random, unguessable id in an
HttpOnly cookie and a private SQLite file of its own, seeded like a fresh install.
There is no login and no personal data: a judge clicks the link and has a desk
nobody else can see. Every store call is routed to the visitor whose request made
it (`sandbox.js`), so isolation is enforced where data is touched rather than at
each of the ~70 call sites — and in sandbox mode a store call with no visitor in
context **throws** rather than landing in someone's database.

Per visitor: threads, packets, duets and the audit trail; settings (model,
sampling, thinking, system prompt — not context size, keep-alive or the queue
limit, which affect the host and so everyone on it); the remote allowance; the
kernel's record of what it has ruled on; and a cap on generations in flight, since
the GPU and the queue behind it are shared.

The page says what this is, on every load, with no dismiss control:

> **Your private sandbox.** Only this browser can see what you do here. It lives on
> this server, and is deleted after 7 days idle — clearing your cookies loses it for
> good, because there is no account to recover it through. …

and says *this server* rather than *your machine* everywhere the desk would say
where a local model runs, because read on a judge's laptop that would be false.

⚠ **A sandbox is a try-it, not the product.** The product is a desk you install,
which keeps everything, indefinitely, on your own machine. A hosted sandbox expires
after a week idle and belongs to whichever browser holds the cookie. That is the
right trade for a public link and the wrong one for your actual notes.

Bounds, all configurable: a cap on live sandboxes (answered *"this demo is full"*),
new sandboxes per address per hour, and idle expiry. Addresses are counted in
memory and never written down. `tools/sandbox_test.js` and
`tools/sandbox_http_test.js` hold all of this, including a planted id, a cookie
shaped like a path, and three visitors racing through the shared queue.

### Remote spend

Each crossing spends real credits, so it has to fit two limits when sandboxed:
the visitor's own allowance, and the demo's daily total. The daily total is kept on
disk, so a restart or a crash loop does not refill it. Without sandboxes,
`AIRLOCK_REMOTE_BUDGET` is a per-process count, as it was — which is fine on a desk
and the reason it is not the setting to rely on in front of strangers.

### Workspaces

On a desk a workspace can be any folder: it is your machine. Hosted, "any absolute
folder that exists" means a visitor pointing a workspace at `/` and reading every
`.json`, `.yml` and `.log` on the server. So `AIRLOCK_WORKSPACE_ROOTS` limits roots
to an allowlist — compared by real path, so neither a junction planted inside an
allowed folder nor a sibling whose name merely starts the same gets out — and if
the instance is hosted and nobody set it, workspaces are **off** rather than open.
The native folder picker is a Windows dialog on the server's own desktop, so it is
not offered to visitors at all; they get the allowed folders instead.

### Token and banner, for a shared instance

Without sandboxes, `AIRLOCK_TOKEN` answers "may you use this instance" — as an
`X-Airlock-Token` header or an `airlock_token` cookie — and **everyone holding it
sees the same packets**. That is a shared desk, not multi-tenancy, and
`AIRLOCK_DEMO=1` puts up a permanent banner saying anything typed there is visible
to other visitors. With sandboxes on, that banner is replaced by the one above,
because the shared warning would then be false.

Conditional rather than always-on, deliberately. Auth that cannot be turned off
would make every local user store a credential to talk to their own machine, and
the reliable outcome of that is a token committed to a repository. Static files
stay open either way — the page has to load in order to ask for a token — and a
`?t=<token>` link is claimed into `localStorage` and stripped from the address bar,
so the token does not live in browser history.

The server states its posture at boot, because a hosted instance set up wrong is a
mistake worth shouting about:

```
  sandboxes -> one per visitor in /srv/airlock/sandboxes, 0 live, removed after 168 h idle (max 500).
  auth      -> OPEN. Correct for localhost; set AIRLOCK_TOKEN before hosting.
  remote    -> 40 call(s) per visitor; 500 per day in total, surviving restarts
  workspace -> limited to /srv/airlock/samples
```

### The local tier on a host

A hosted instance has no Ollama unless one is deployed beside it, and "local" there
means a model on the same host — inside the deployment's trust boundary — rather
than on the viewer's machine. The gate is the same local model, so it has to run
there too: on this desk that is `nemotron-3-nano:4b`, which measured 1.7 s per ruling
on CPU alone, so the host does not need a GPU for the gate.

## Layout

| File | Role |
|---|---|
| `server.js` | Express host: `/api/health`, `/api/config`, duet send, packet routes, Carry out, `/api/usage`, `/api/exposure` |
| `db.js` | The packet store — schema, provenance log, token ledger, move/fork/nest/review, search. One database per `createCore` |
| `sandbox.js` | Which store a call belongs to: the desk's one database, or the visitor's sandbox; the sandbox lifecycle |
| `kernel.js` | Whether content may leave: per-turn clearances bound to the exact words and destination |
| `boundary.js` | The gate — a local model that rules on a crossing, deterministic, fails closed |
| `secrets.js` | The credential scanner: in front of the gate on the server, and on drags and copies in the page |
| `providers/` | One streaming contract, two tiers. `index.js` documents the chunk shape |
| `providers/registry.js` | Which side of the boundary each model is on, read from the providers' own catalogues |
| `providers/egress.js` | The only file allowed to reach the network; refuses content without a clearance |
| `files.js` | Read-only workspace access, containment, and which folders a root may be |
| `workspace-tools.js` | The file tools and their runner, shared by the duet and `/api/chat` |
| `duet-store.js` · `duet-runner.js` · `duet-context.js` | Two participants over one conversation, chatter included — see [docs/duet.md](docs/duet.md) |
| `auth.js` | Access token and remote spend cap. Off unless configured |
| `public/index.html` · `app.js` · `duet.js` · `styles.css` | Frontend — no dependencies, no CDN, works offline. `duet.js` is the timeline, the panes and chatter |
| `public/manifest.webmanifest` | PWA manifest; what makes the taskbar install possible |
| `public/icons/` | Generated PNGs + `airlock.ico` |
| `tools/make_icons.py` | Redraws the whole icon set — edit colors here, re-run |
| `tools/focus_airlock.ps1` | Finds and raises an existing Airlock window; exit code says which |
| `tools/*_test.js` | The suites listed under [Status](#status) |
| `tools/gate_bench.js` · `gate_holdout.js` | Measures a gate model: leaks and friction, with a held-out set kept apart |
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
- **Tool results as packets.** Tool calls render as cards on the reply, and each reply
  keeps its calls (name, target, size, hash) in `request_meta.tools`, but the results
  themselves aren't stored as packets, so briefs stay readable. When one crosses to a
  remote model it is recorded as a crossing, by name, size and content hash.

## Known issues

- **The 14B gate over-withholds.** `qwen2.5:14b` has refused requests that merely *ask*
  to read a file, and a brief because it named a model id — both against its own
  instructions. Retuning it needs fresh held-out cases first; the current held-out set
  has been used for two decisions and is spent.
- **Small models in chatter.** A 4B with reasoning on sometimes reasons and then says
  nothing (the run stops, and says why); with reasoning off it can repeat itself word
  for word. A run now asks once more after an empty reply, and stops when a side repeats
  itself — so these end a run early instead of spending it.
- **Agreement inflates certainty, and a prompt rule does not stop it.** Two local models
  (qwen2.5:7b, nemotron-3-nano:4b) turned "may be" into "is" and planned every test as one
  that would "confirm" their idea; one reported running tests and writing logs. A system
  rule against both, replayed at the moments it happened, changed nothing measurable —
  the transcript's own habits outweighed it. Invented files are marked; inflated
  certainty is not caught yet.
- **Muse Glimmer 30B does not load** on Ollama 0.34.1 on this desk (CUDA "shared object
  initialization failed"), with or without Airlock — so image input to a real model is
  unverified here since August.

## Further reading

The detail lives beside the code it describes, so this page can stay about the
idea.

| | |
|---|---|
| [docs/local-tier.md](docs/local-tier.md) | Ollama setup, the Blackwell flash-attention fight, VRAM budgeting, the reasoning channel, token spend, the taskbar launcher |
| [docs/board.md](docs/board.md) | The packet store's schema and rules, every drag gesture, cross-app drag payloads, the motion design, the palette |
| [docs/workspaces.md](docs/workspaces.md) | Per-thread read-only file access, the per-side ⛁ switch, and the containment tests |
| [docs/duet.md](docs/duet.md) | Two participants over one conversation: the timeline, what each is shown, roles, chatter, why a crossing exposes the other's words, the lifecycle |
| [docs/verification.md](docs/verification.md) | What was verified by hand, when, and what was not |

## Licence

Apache 2.0 — see [LICENSE](LICENSE). The same licence as Muse Glimmer, and it
carries a patent grant.
