# Duet

Two addressable AI participants sharing **one** conversation. Each gets its own lane,
its own composer, its own model and role. Neither gets its own history.

That last sentence is the whole design. On screen it is one timeline in two lanes: every
message appears **once**, in server order, in the lane it belongs to — a reply in its
author's lane, a request in the lane of the side it was sent to, anything from before the
thread had two sides across both. A line runs from each message to the one it answers,
read from what the store recorded (a chatter turn's `relayOf`, an answer's `replyTo`),
coloured by the answering side: green if it stayed here, amber if it crossed, red dashed
if the gate withheld it. There is no second log anywhere in the code, so there is nothing
to keep in step and nothing that can drift.

```
            LEFT lane                         RIGHT lane
     #1 [User → Left]  teal robots?
        │
     #2 [Left → User]  call it Verdigris ─┐
                                          └─ #3 [Right → Left]  too on the nose
     #4 [Left → Right] then Patina ───────┐
                                          └─ #5 [Right → Left]  better
```

(It used to be two panes, each a filter over the log — what was said to or by that side.
In chatter, where every reply is addressed to the other side, both panes showed every
message and became copies of each other.) Focus mode (⤢) folds one lane to a track of
dots, so the back-and-forth still reads; on a narrow screen the tabs show one lane at a
time. Packet ids show on hover in the lanes; the chamber below keeps them on every row.

## Why it is not two chats

The obvious build is two independent conversations that happen to sit side by side.
It is wrong in a way that only shows up later: the moment you ask the second model
about something the first said, you have to decide what to send it, and every answer
to that question is a lie unless there was one conversation all along.

So: one thread, one server-assigned order, and each message records who wrote it and
who it was addressed to. A lane is where its author sits.

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

## Workspace files

Each pane has a **⛁ files** switch. It is on by default for a side on this machine and
off by default for a side across the boundary: letting a cloud model read your files is
something you switch on, never something you find on. The server offers the tools only
when the request asks, the thread has a workspace that still exists and is permitted, and
the model can call tools (`workspace-tools.js`, shared with `/api/chat`).

Local file contents are ruled on whenever they enter a cloud-bound context, not only when
they are first read. There are four routes, and all four are tested end to end against a
fake remote and a stand-in gate that releases everything, so every refusal is the secret
scanner's on that route (`tools/duet_tools_test.js`):

1. **Directly.** A remote side reads a file, and the result goes back to it. Every tool
   round after the first is ruled on before it is sent. A refusal ends the turn there, and
   the reply is marked with what was kept back. The request itself had crossed; the
   results did not, and the pane says exactly that.
2. **Shared history.** Raw tool results never enter another participant's context; only
   the reply does. When that reply later crosses as someone else's context, it is ruled on
   as a message the gate has not seen, and the crossing record names the files it had read.
3. **Moved.** A quoting reply dragged to another thread is ruled on when it crosses there.
   The kernel's memory is by content, not by thread.
4. **By hand.** ⇱ Carry out rules on the whole brief before showing it. See the README.

Each reply records the calls it made in `request_meta.tools` (name, target, size, hash),
and the pane shows them as cards.

## Chatter

The participants can answer each other. **⇄ Step**, in the chamber header, hands the floor
to the side that did not write the newest reply, for one turn. **▶ Auto** runs Steps until
the cap (×6 by default, at most 20), until you press **■ Stop**, until the gate withholds a
turn, or until a turn fails or comes back empty. While it runs, the seam over the chamber
sweeps green to amber and back, and the header counts the turns.

A chatter turn is a **relay**: `POST /api/duet/:id/send` with `relayOf`, the id of the
other side's finished reply. No request is written. The reply is addressed to the
participant it answers, so it is labelled `[Right → Left]` and shows in both panes. The
answering side's system message, and only that, says this turn is its reply to the other
participant and that the user is listening. The transcript never carries an instruction.

The server refuses a relay aimed at its own reply, at a request, at an unfinished,
withheld or empty reply, or at another thread, and it writes nothing when it does
(`resolveRelay` in `duet-runner.js`). Toward a remote side, a relay is a crossing like
any other: it is gated, the doors hold, and it is recorded.

**Joining in.** Type into either composer during a run. If that side is free, your message
goes straight in and it answers you. If it is busy, your message waits in the composer and
goes in as soon as that turn ends; Enter does not act as Stop mid-run. The run then carries
on from the answer, with your message in everyone's context.

**The run lives in the page.** Close the tab, or switch threads, and it stops, so a
conversation with a cloud model cannot keep spending with nobody watching.

`tools/duet_chatter_test.js`, **23/23**, runs against fakes on both sides: addressing,
gating, the crossing record, an interjection reaching the next relay, every refusal, a
withheld relay that delivers nothing, and an empty reply that is not answered.

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

Duet turns are ordinary packets. They search, appear in the brief and count in the
exposure query like anything else.

## Leaving a conversation

Drag a finished message onto a thread in the rail to move it there; hold Alt to fork it.
When it lands, the server detaches it (`rehome` in `duet-store.js`). Its author and
addressee were participants of the thread it left, so both are cleared, and it becomes
shared history in both panes, attributed to the model that wrote it. It is re-sequenced at
the end of its new thread. Tier, status and `request_meta` travel with it, because they
record how it was produced, not where it is filed. Its crossings stay on the record too:
provenance belongs to the packet.

Only a `complete` message may leave. A fork copies text, not the duet's status column, so
forking a stopped, failed or withheld reply would turn it into conversation somewhere else.
The server refuses; the pane only offers the move when the server will take it.

Nesting one message inside another is not offered in a duet. A duet is one conversation
in server order, and a nested message has no place in that order.

## Pre-duet threads

A thread that was a plain chat before it became a duet has packets with no author and
no addressee. Those show in **both** panes, and reach both models labelled
`[an earlier assistant → User]` or `[User → everyone]`. They are not adopted into either
participant's voice — quietly claiming them would put words in a model's mouth.

There is no classic chat any more — every thread opens as two panes, and one created
before participants existed is seated when it is first opened. What classic chat wrote
before stays exactly as above: shared by both panes, owned by neither.

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
- **More than two participants.** The schema has a `slot` and would take a third; the
  layout and the context labels are what would need thought, not the store.
