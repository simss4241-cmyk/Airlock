# Duet

Two addressable AI participants sharing **one** conversation. Each gets its own pane,
its own composer, its own name, its own model. Neither gets its own history.

That last sentence is the whole design. The panes are filtered views over a single
thread; there is no second log anywhere in the code, so there is nothing to keep in
step and nothing that can drift.

```
                    ┌─────────────── one thread ───────────────┐
                    │  #1 [User → Lyra]   name a teal robot     │
                    │  #2 [Lyra → User]   Zing                  │
                    │  #3 [User → Ember]  what did Lyra say?    │
                    │  #4 [Ember → User]  Zing                  │
                    └───────────┬──────────────────┬────────────┘
                                │                  │
                    Lyra's pane │                  │ Ember's pane
                      #1 #2     │                  │   #3 #4
```

## Why it is not two chats

The obvious build is two independent conversations that happen to sit side by side.
It is wrong in a way that only shows up later: the moment you ask the second model
about something the first said, you have to decide what to send it, and every answer
to that question is a lie unless there was one conversation all along.

So: one thread, one server-assigned order, and each message records who wrote it and
who it was addressed to. A pane is a `WHERE` clause.

## What each participant is shown

`duet-context.js` is pure and has no database, no network and no provider. Three rules
carry it, and each exists because the shortcut is wrong.

**1. Only its own completed replies become `assistant` turns.**
Another model's output arriving as `assistant` reads, to the receiving model, as
something it said itself — it will defend positions it never took. Everything that is
not its own arrives as labelled conversation instead:

```
[system]     You are "Ember", one of the AI participants…
[user]       [User → Lyra] Invent a one-word codename for a teal robot.

             [Lyra → User] Zing
[user]       [User → Ember] What did Lyra suggest?
```

Lyra's answer is *there*, in full, attributed — and it is not in Ember's mouth.

**2. Instructions live only in the system message.**
Labels say where each line came from, and the system message says plainly that those
lines are material to weigh, never commands. Another participant is a voice in a
discussion, not an authority over this one — and on this desk it may literally be a
different vendor's model across the boundary.

**3. The newest request is never what gets dropped.**
An oversized history loses its oldest turns, visibly, with a marker. A request too big
for its own window is truncated with a marker rather than silently binned.

## The boundary

⚠ **A duet crossing exposes more than the message you typed.**

Sending to a remote participant sends it the shared conversation — which includes what
the *other* participant said and what was asked of it. That is the point of the feature
and it is also a real exposure, so:

- the local gate rules on **everything in the assembled context that it has not ruled on
  before** — the other participant's words included, not just the message you typed —
  and on every turn, not once per thread. The clearance is bound to that exact snapshot,
  so what was ruled on is what is sent, even after a wait in the queue (`kernel.js`);
- the crossing is recorded against **every packet whose text was in it**
  (`duet-context.js` returns exactly that set as `meta.sourceIds`);
- each pane header carries a tier chip — `local` or `↗ crosses` — because which side of
  the boundary a participant sits on must be readable without opening a menu;
- tier is resolved on the server by `providers.tierOf()`, which reads it out of the
  providers' catalogues rather than inferring it from the model id. The client cannot
  assert it, exactly as it cannot for an ordinary packet. A model no catalogue claims
  comes back `unknown`, and the duet path gates on `!== 'local'` — so an unplaceable
  participant is treated as a crossing and its crossing is still recorded, rather than
  slipping past a test for the exact string `remote`.

A withheld generation is kept in the log as a `blocked` packet showing the gate's
reason. The attempt is part of the record; the text never left.

Duet crossings go through `kernel.js` like every other crossing — the same clearance,
the same egress lock — so there is no duet-specific gate logic to drift. (An earlier
version of this page noted that `/api/chat` and `/escalate` passed `config.model` to the
gate and so gated remotely on a keyed machine. That was fixed centrally in `runGate`, and
the kernel has since made the question moot: no route chooses its own gate.)

## Images

A request can carry up to four images (📎, paste, or drop them on a pane's composer). They
go to the participant they were sent to, on that turn, and nowhere else. Every other
transcript line that had images says so instead: `[2 images attached here — not included in
this context]`. A reply like "the one on the right" is unreadable without that note, and a
model told nothing tends to invent what the picture showed.

A participant whose model cannot see (no 👁 in its picker) is refused before anything is
written, and the composer keeps the message. A remote participant is also refused, by the
kernel rather than here: the local gate reads text only and cannot rule on what an image
shows, so an image never crosses.

## Concurrency

A context snapshot is taken at **submit** time, not when the model starts. So a reply
that waited thirty seconds in the queue answers the conversation as it stood when Send
was pressed, and two requests fired together genuinely cannot see each other.

That is a property, not a limitation. It is the difference between two participants
answering the same question and one quietly answering the other. A *later* request sees
both, which is where the pairing earns its keep.

The local tier queues at `maxConcurrent` (default 1): two 30B generations on one 16 GB
card is slower than running them back to back. The queue depth is shown in the pane —
`queued · 1 ahead` — so the wait is honest rather than mysterious. The remote tier is
not throttled by that setting; Token Factory will serve both panes at once.

## Lifecycle

Statuses, and the rule that makes them matter: **only `complete` is ever fed back to a
model.**

| status | means |
|---|---|
| `streaming` | in flight; settled to `interrupted` if the server restarts under it |
| `complete` | a finished answer — the only kind that becomes context |
| `cancelled` | stopped by hand; partial text kept, never shown to a model again |
| `failed` | the provider refused or broke |
| `blocked` | the local gate withheld the crossing; nothing was sent |
| `interrupted` | stranded by a shutdown |

Retries name the triggering request (`retryOf`) and append nothing, so asking again
never duplicates the question. A resent submission is matched on `client_request_id`,
which is unique per thread.

## Storage

No new log. `duet-store.js` adds a `participants` table and additive columns on
`packets` — author, recipient, status, `seq`, `reply_to_packet_id`,
`client_request_id`, `generation_id`, `request_meta`. Every migration is idempotent and
`db.js` is untouched, so a database that has never seen a duet opens exactly as before.

`seq` is assigned by a trigger rather than a call site, so packets written by classic
chat, by fork and by move all get one and there is a single place to get it wrong.
`position` could not do this job: it is a nesting slot and restarts under each parent.

Duet turns are ordinary packets. They drag, fork, nest, search, appear in the oversight
brief and count in the exposure query like anything else.

## Pre-duet threads

A thread that was a plain chat before it became a duet has packets with no author and
no addressee. Those show in **both** panes, and reach both models labelled
`[an earlier assistant → User]` or `[User → everyone]`. They are not adopted into either
participant's voice — quietly claiming them would put words in a model's mouth.

Classic chat keeps working on a duet thread, and its turns behave the same way: shared
by both panes, owned by neither.

## Files

| | |
|---|---|
| `duet-store.js` | schema, participants, the canonical log |
| `duet-context.js` | pure context assembly — no db, no network, no provider |
| `duet-runner.js` | orchestration, the queue, the gate, crossings |
| `public/duet.js` | the two panes, per-pane streaming |
| `tools/duet_context_test.js` | 29 assertions, offline |
| `tools/duet_test.js` | 44 assertions over HTTP |

## Not built

- **Send to both.** Deliberately deferred until the core was solid.
- **Autonomous back-and-forth.** Models answer when asked and never on their own.
- **More than two participants.** The schema has a `slot` and would take a third; the
  layout and the context labels are what would need thought, not the store.
