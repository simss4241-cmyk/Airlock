# Airlock

**A private AI desk where nothing leaves your machine without a local model deciding it may —
and where every reply shows you which of its facts it made up.**

You work with two AI participants side by side: one running on your own machine, one that
can reach a bigger model in the cloud. Everything you write stays local by default. When a
message does cross to the cloud, a **local** gate model rules on it first, a credential
scanner runs before that, and the crossing goes on a permanent record. *"What has a cloud
model ever seen?"* becomes a query, not a guess.

And because small models invent things with total confidence, Airlock checks every reply
against the thread's own record: each number is traced to where it was first said, words
copied from the other side are dimmed, and a reply that names a file nobody opened is marked.
No model judges any of this — it is code, reading the record.

![Airlock: two participants, one timeline, and the airlock chamber below](docs/img/desk.png)

*Left: `nemotron-3-nano:4b` on this machine. Right: Nemotron 3 Nano 30B on Nebius Token
Factory. Each reply has a line to the message it answers — green stayed here, amber crossed —
and the top bar counts what has gone to the cloud. Dimmed words were copied from the other side.*

Built for the **Nebius × NVIDIA Global AI Hackathon — Personal AI track.**
[Demo video](#) · [How it uses Nemotron, Token Factory and Tavily](#nvidia-nemotron-nebius-token-factory-and-tavily) · [Design notes](docs/design.md)

---

## Why

A personal AI is only private until the first time it calls a bigger model. Most apps make
that call invisibly — a setting, an API key, and from then on your notes travel with every
question. You cannot tell what left, or when, or to whom.

Airlock makes the boundary the product:

- **Local by default.** A thread can run entirely on your machine through Ollama and never
  touch the network.
- **Crossing is an event.** Pointing a side at a cloud model is explicit, the side's header
  says *↗ crosses*, and every turn it sends is ruled on before it goes.
- **The gate is local, always.** To ask a remote model whether something may leave, you must
  first send it — so the gatekeeper runs on the machine it protects. This is enforced in
  code: the gate refuses to run on a remote model.
- **It fails closed.** If the gate is down, slow, or answers nonsense, nothing is sent.
- **The record outlives the words.** Delete a message and its text is erased from disk — but
  the fact that it once crossed, and to which model, stays.

## What you'll see

### Two participants, one conversation

Each thread has a left and a right side, each with its own model, role ("Skeptic",
"Optimist" — one word is enough) and composer. They read **one** shared conversation: every
message appears once, in its author's lane, with a line to the message it answers. Ask one,
then the other; or press **⇄ Step** to hand the floor across, or **▶ Auto** to let them talk to
each other up to a cap, with every turn toward the cloud gated. Type into either side at any
time to join in.

Below the lanes is the **airlock chamber**: every message enters there, its doors hold shut
while the gate rules, and every row that crossed (amber) or was withheld (red) carries a seal.

![A withheld message: the gate's reason, and nothing sent](docs/img/withheld.png)

*A card number on its way to the cloud side. The scanner recognised it before any model
read it, so nothing was sent. The reason names what it found and shows only its ends.*

### Marks: where each fact came from

Press **?** in the chamber bar for the key. Hover any mark or underline for the detail.

| Mark | Means |
|---|---|
| a plain number | Sourced: you wrote it, it is in a role you wrote, or a tool read it from a file or page. Hover the reply and a faint line shows it. |
| <ins>dashed underline</ins> | First said by a model earlier in the thread, with no source before that. |
| <ins>dotted underline</ins> | New in this reply. Fine for a proposal; a warning sign for a "known" fact. |
| 🧮 a computed number | Worked out with the calculator. Hover for the working and where each input came from — and if an input had no source, the result keeps its underline: *the sum is checked, the premise is not.* |
| `# 3 unsourced figures` | Three or more numbers in one reply with no outside source. |
| dimmed words · `≈ 62% restated` | Copied word for word (six or more words) from the other side or from you. The bright words are the reply's own. |
| `↻ repeat of 2:14 PM` | Nearly word for word this side's own earlier reply. Ends an Auto run. |
| `⚠ unseen file` | Names a file no tool read and you did not give. |
| `⚠ claims a page it didn't open` | Says it opened or verified a page; its own tool record says it didn't. The sentence is underlined. |
| `⚠ unsourced link` | A link no search returned, no page held and you did not give. Shown as text with its destination, not clickable. |

These came from watching real runs. Two local models in a role-play invented sensor readings
("500 kPa"), then listed them as "known for certain"; one named log files it had "written"
when no files existed. A system-prompt rule against it, replayed at the moments it happened,
changed nothing measurable — so Airlock marks it instead of asking the model to stop.

![Number marks on a 4B's pizza budget](docs/img/marks.png)

*A 4B audits a pizza budget. $101.50 came from the calculator, using numbers the user gave,
so it is plain. $20.30 came from the calculator too, but one of its inputs (0.2) was the model's
own reading of "20%", so it keeps an underline. $10.65 was worked out in its head, and the "0" in
"0 tax" appears nowhere the user wrote it. Hover any number to see where it came from.*

### Tools, on the record

- **Files (⛁).** Give a thread a workspace folder in ⚙ Settings and a side can list, search
  and read it (read-only, contained to that folder). On by default for a local side, off by
  default for a cloud side — and any file content a cloud model would receive is gated first.
- **The web (🌐).** Search through Tavily and open pages, off by default on both sides. Every
  search query is gated before it leaves; a side can only open links that a search, a page or
  you gave it; text hidden on a page is stripped before a model reads it.
- **A calculator (🧮).** `calculate` and `convert`, a parser rather than `eval`. Small models
  are poor at arithmetic; this one keeps its working on the record.
- **Ask you.** A side can ask you for a result instead of inventing one. Your answer is linked
  to the request.
- **A reply's timeline.** Reasoning, tool calls and the answer render in the order they
  happened, and the reasoning is kept with the reply.

### What has left this machine

The top bar counts everything that has crossed, by kind — to cloud models, web searches,
pages opened, carried out by hand — with what was withheld and what came back. **⇱ Carry
out** turns a thread into a brief to paste into a chat Airlock cannot see; it is gated before
it is shown and recorded when it leaves, because a crossing by hand exposes exactly what an
API call does. **Σ** opens the token ledger: every reply and gate ruling, per model.

### Delete: the words go, the record stays

Any message or thread can be deleted. Its text, images and reasoning are erased — with
SQLite's `secure_delete` and a WAL checkpoint, so the words are off the disk, not just hidden.
What it was sent to stays: a stub says when and to which model it had crossed, because an
audit trail you can edit away is not one.

## Quickstart

**You need:** [Node.js 24+](https://nodejs.org) (the store uses the built-in `node:sqlite`; no
native modules, no build step) and [Ollama](https://ollama.com). For the cloud side, a
[Nebius Token Factory](https://tokenfactory.nebius.com) API key; for web search, optionally a
[Tavily](https://tavily.com) key. Tested on Windows 11 with an RTX 5060 Ti (16 GB).

```bash
git clone https://github.com/simss4241-cmyk/Airlock.git
cd Airlock
npm install
ollama pull qwen2.5:14b          # the gate (9 GB)
ollama pull nemotron-3-nano:4b   # the local participant (2.8 GB)
cp .env.example .env
```

Then add your keys to `.env` (the gate is already set to `qwen2.5:14b`):

```ini
NEBIUS_API_KEY=your-token-factory-key
TAVILY_API_KEY=your-tavily-key      # optional: web search
```

Start it and open **http://localhost:8100**:

```bash
npm start
```

On Windows, `start_airlock.bat` does the same and opens Airlock in its own app window;
`tools/install_shortcut.ps1` adds a Start Menu shortcut.

**Smaller GPU?** `AIRLOCK_GATE_MODEL=nemotron-3-nano:4b` runs the gate in 2.8 GB at ~0.3 s a
ruling, but it is measurably weaker: it released about a third of what it should have
withheld on the test set, where `qwen2.5:14b` released none. The credential scanner runs in
front of either. **No key?** Airlock runs fully local and says so. **No Ollama?** It opens on
Nemotron 3 Super and the gate refuses to release anything — fail closed — until a local
model is there to rule.

### Try this first

1. **A crossing.** New thread (✎). Leave the left side on `nemotron-3-nano:4b`; point the
   right side at **Nemotron 3 Super**. Ask the right side anything. Watch the chamber doors
   hold while the gate rules, then the amber seal.
2. **A withhold.** Send the right side something with a credential in it —
   `the staging db is postgres://admin:hunter2@db.internal/prod, why is it slow?` — and see
   the red row and the reason. Nothing was sent. Send the same to the left side: it stays
   here, so there is nothing to gate.
3. **A traced number.** In ⚙ Settings, set the thread's workspace to this repo's
   [`examples/`](examples) folder. Ask the left side to read `gauge.txt`, then ask the right
   side to calculate the coolant pressure plus 455 kPa. Hover the numbers in its answer: 480
   traces to the file, 455 to you, and the sum to the calculator with its working. Then ask
   for something the file does not hold — last week's trend, say — and see how an invented
   number is underlined.
4. **Chatter.** Give the sides roles (✎ role — "Skeptic", "Optimist"), ask a question, and
   press ▶ Auto. Watch for dimmed words and `↻ repeat`.

## NVIDIA Nemotron, Nebius Token Factory, and Tavily

**Nemotron on Token Factory is the cloud side.** A side pointed across the boundary talks to
Nemotron 3 through Token Factory's OpenAI-compatible streaming API — the right size for the
job:

| Model | Used for |
|---|---|
| Nemotron 3 Nano 30B (`nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`) | fast answers, cheap enough to use freely |
| Nemotron 3 Super 120B (`nvidia/nemotron-3-super-120b-a12b`) | the default cloud participant |
| Nemotron 3 Ultra 550B (`nvidia/Nemotron-3-Ultra-550b-a55b`) | deep review, a million-token window |

Cloud sides run the full tool loop on Token Factory — reading workspace files, searching the
web, calling the calculator — with every tool round gated and recorded as its own crossing.
The model list comes from Token Factory's own catalogue, and that catalogue is also how
Airlock decides which side of the boundary a model is on: anything no provider claims as
local is treated as remote and gated.

**Nemotron runs locally too.** `nemotron-3-nano:4b` is the default local participant — the
same family on both sides of the boundary, sized to each. We also measured it as the gate
model; it is fast, but it released too much (above), so the recommended gate is
`qwen2.5:14b` and the choice is yours in `.env`.

**Why Token Factory fits a personal desk:** serverless and per-token, so a person gets a
120B–550B reasoning partner for the few questions that need one without renting a GPU, and
the reasoning channel (`reasoning_content`) arrives separately, so Airlock can keep a reply's
reasoning with it. What we learned integrating it — usage must be requested, there is no
`eval_duration`, and the exact shape tool rounds need — is in
[docs/design.md](docs/design.md#two-tiers-one-stream).

**Tavily is the web.** `web_search` calls Tavily; `fetch_url` opens only links a search
returned, a page held or you gave. Every query is ruled on by the local gate before it leaves
and counted under *searches* in the crossing record, because a search query is your words
leaving the machine.

## The gate, in short

    secret scanner  ->  local gate model  ->  cross  ->  record

- **A scanner first.** Known credential formats — private keys, cloud and platform tokens,
  passwords in URLs, secrets in env files, card numbers, SSNs — are withheld by `secrets.js`
  before any model reads anything. The same rules run in the page, so a message dragged or
  copied out is checked too.
- **Then a local model**, at temperature 0, with a prompt that says *withhold what contains
  a secret, not what talks about one*: a question about rotating API keys is fine; the key is
  not. Ordinary data — readings, configs, logs, plans — is fine however real it is.
- **Every turn, bound to the exact words.** The kernel hashes each outgoing message and issues
  a clearance for exactly that set, to exactly that model. A secret typed on turn nine is
  judged on turn nine. Only what is new is read, so a turn costs one ruling (~0.7 s).
- **A refusal is about that message, not the thread.** A message withheld from a cloud model
  is left out of what that model is sent later — it never saw it — so the next turn is judged
  on its own words. The local side still sees it, and a different cloud model is gated on it
  afresh.
- **It reads only what is yours.** Not Airlock's own system prompt, not a model's own earlier
  words going back to it. Each of these was found from a real false withhold on the desk,
  replayed until the cause was clear.
- **One door.** One file in the codebase may call `fetch`, and it will not open a connection
  carrying content without a clearance the kernel issued; a test fails if any other file
  reaches the network.

**Measured, not asserted.** `tools/gate_bench.js` runs labelled cases through the real gate
and reports leaks and friction separately, with held-out sets written by a human and run
once. On every set, every prompt version: **no secret released**. The current prompt: 0/52
friction on the 99-case tuning set; 1 of 5 harmless cases withheld on the latest held-out set.
Full numbers in [docs/verification.md](docs/verification.md).

The full design — the exposure query, forced crossings, per-turn trade-offs, hosting — is in
[docs/design.md](docs/design.md).

## Built during the hackathon

Airlock was forked on **2026-09-11** from Glimmer, the author's earlier local-first chat UI
and packet store. Glimmer provided the local chat, the SQLite packet store and the launcher.
Everything that makes Airlock what it is was built during the submission period: the
boundary and its local gate, the credential scanner, the kernel and single network door, the
Token Factory tier, the two-sided duet and chatter, the crossing record and delete, the tools
(files, Tavily web, calculator, asking you), every mark described above, per-visitor
sandboxes for hosting, and the gate's measurement bench — about 80 commits since the fork.

## Tests

Nineteen suites, about 830 assertions. Fifteen run offline on a clean clone with no key and
no model — they fake both a remote and Ollama where needed, so they prove the plumbing, not a
model's judgement:

```bash
node tools/duet_tools_test.js      # files in a duet, every route to the cloud, delete
node tools/kernel_test.js          # clearances bound to exact words; one door
node tools/secrets_test.js         # the credential scanner
node tools/duet_context_test.js    # what each side is shown; every mark
```

The full list, and the three suites that need a running server (pointed at a scratch
database, never your desk), are in [docs/design.md](docs/design.md#tests). What was verified
by hand, when, and what failed is in [docs/verification.md](docs/verification.md).

## Known limits

- **The gate sometimes withholds harmless things.** About one in five novel messages on the
  latest held-out set. Fail-closed makes this the safe direction, but it is friction.
- **Per-turn gating reads only what is new**, so a secret split across two turns could pass
  as two innocent halves.
- **Small local models are odd.** A 4B with reasoning on sometimes reasons and then says
  nothing; with it off it can repeat itself. Chatter asks once more after an empty reply and
  stops on a repeat.
- **Marks show where a fact began, not whether it is true.** A sourced number used for the
  wrong thing still shows its source — hover it to compare. Inflated certainty ("may be"
  becoming "is") is not caught.
- **Pasted instructions can steer a model.** Text you paste in — a vendor note, an email — can
  carry instructions, and a small model may follow them. Airlock strips hidden text from web
  pages and its gate ignores such instructions, but it does not stop a participant obeying
  them. Nothing crosses because of it: a cloud turn is still gated.
- **Hosting is built but not deployed.** Per-visitor sandboxes, spend caps and a workspace
  allowlist exist and are tested ([docs/design.md](docs/design.md#hosting-it)); there is no
  public instance yet.
- **Not built:** redaction (crossing a brief with the sensitive parts stripped), and write
  access or a shell — tools are read-only on purpose.

## Further reading

| | |
|---|---|
| [docs/design.md](docs/design.md) | The gate in full, the exposure record, the two tiers, settings that cross, hosting, the code layout |
| [docs/duet.md](docs/duet.md) | Two participants over one conversation: the timeline, what each is shown, roles, chatter |
| [docs/workspaces.md](docs/workspaces.md) | Read-only file access per thread, and the containment tests |
| [docs/local-tier.md](docs/local-tier.md) | Ollama setup, VRAM budgeting, the reasoning channel |
| [docs/board.md](docs/board.md) | The packet store's schema, drag gestures, the palette |
| [docs/verification.md](docs/verification.md) | What was verified by hand, when, and what was not |

## Licence

Apache 2.0 — see [LICENSE](LICENSE).
