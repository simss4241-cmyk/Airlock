# Workspaces

Per-thread, read-only file access for the local model, and the containment
that keeps it inside the folder you chose.

> **The folder picker is Windows only** — it shells out to PowerShell and WinForms. The
> workspaces themselves work anywhere: paste an absolute path instead. Hosted, roots are
> limited to `AIRLOCK_WORKSPACE_ROOTS` (see the README's hosting section).

## Workspace file access

Each thread gets its own read-only **workspace root**. Open the thread, then ⚙ Settings →
Workspace: Browse… or paste a path and press Enter. Switching threads switches the root
automatically; clearing one thread's root does not affect any other thread.

New threads start with **no** workspace, and that default is the point: file access is
handed over deliberately, one thread at a time.

Then each side decides for itself. Every pane has a **⛁ files** switch: **on** by default for
a side on this machine, **off** by default for a side across the boundary — letting a cloud
model read your files is something you switch on, never something you find on. It reads
`⛁ files` when armed, `⛁ files off`, `⛁ no workspace` when the thread has none,
`⛁ files missing` when the folder has gone, and `⛁ no tools` for a model that cannot call
them. Switched on for a remote side it shows amber, because every file that side reads is a
candidate crossing — and is ruled on by the gate before it goes (see
[duet.md](duet.md#workspace-files)).

The path box takes **absolute paths only**. `path.resolve` would read a bare `CFE` as
relative to wherever the server was started and quietly root the thread at
`airlock-ui\CFE` — a real folder, just not the one that was typed.

A root whose folder has since been renamed or deleted is a third state, distinct from
having one and from having none. The switch shows `⛁ files missing` rather than a confident
`⛁ files`, and the server withholds tools for that request: offering them means every call
fails and the model spends the whole round budget discovering it. Verified against a live
thread with its folder renamed away — one round, no tool calls attempted.

### The retired global root, and why it's fenced off

Workspaces used to be one global `workspaceRoot` in the JSON config. Upgrading copies that
value onto every thread that existed at the time, which is why older threads arrived already
pointing at `C:\work\CFE`.

That bridge is one-time, and keeping it that way needs a fence. Left armed it would re-run on
every boot against whatever `workspaceRoot` it found, granting file access to exactly the
threads deliberately left without any — quietly, to all of them at once. A restored config
backup, a copy from another machine, or a hand edit was enough to trip it.

So: `workspaceRoot` is gone from `DEFAULTS`, which is also the allowlist for
`POST /api/config`, so it can no longer be written back into the config; `loadConfig` deletes
the key outright rather than blanking it, since an empty hook is still a hook; and
`db.migrateWorkspaceRoot` records `workspace_root_migrated` in the database's `meta` table
and refuses to run twice. The marker lives with the data being migrated, not in the config,
because the config is the part that can be replaced. A database that already has the
`workspace_root` column is marked spent on open — it has already been through the change, or
was created after it.

`config.tools` went the same way. Whether tools are offered is decided per request by
whether that thread has a usable workspace, so a global flag changed nothing — while sitting
in the config file looking like a switch, and disagreeing with `DEFAULTS` about its own
value. `loadConfig` strips it on sight.

### Tests

| File | Covers | Needs |
|---|---|---|
| `tools/files_test.js` | containment, the whole security boundary | nothing |
| `tools/workspace_test.js` | the store: migration, independence, the spent bridge | nothing |
| `tools/workspace_http_test.js` | the wiring: which thread resolves to which root | nothing |
| `tools/duet_tools_test.js` | files in a duet, and every route their contents could take to a cloud model | nothing — fakes both sides |

`workspace_http_test.js` spawns its own server on port 8137 against a throwaway database, so
it never reads or writes the real `airlock.db` and doesn't need Ollama. It exists because the
store and the containment layer were both tested while the part that decides *whose* root a
request gets was only ever checked by hand — which is how a shared-root bug gets
reintroduced quietly.

### ⚠ The folder picker needs an owner window

`Shell.Application.BrowseForFolder(0, …)` and `FolderBrowserDialog.ShowDialog()` with no
argument both create an **ownerless** dialog, and Windows is then free to open it *behind* the
browser. It looks exactly like nothing happened.

The picker script therefore builds a transparent 1×1 `Form` in the centre of the active
screen with `ShowInTaskbar = $false` and `TopMost = $true`, activates it, and passes it as the
dialog's owner. That keeps the chooser both visible and above Airlock. It opens at the
current thread's workspace (or your home directory) rather than This PC.

If it ever misbehaves again, the path box is editable — paste and press Enter. That path
doesn't depend on any dialog.

| Tool | Does |
|---|---|
| `list_directory(path)` | Lists a folder. Skips `node_modules`, `.git`, `dist`, `.venv`, … |
| `find_files(query)` | Filename substring search, depth 8, 150 hits max |
| `read_file(path)` | Reads a text file, 256 KB cap with a truncation note |

The loop runs **server-side**, in the duet runner (and the older `/api/chat` route), with the
tools and their runner shared from `workspace-tools.js` so a file is the same thing to the
kernel and the crossing record whichever path read it. It streams the model through, watches
for `tool_calls`, executes them, emits a `tool` event the pane renders as a card, and
re-calls with the results. Capped at 5 rounds, and the final round is sent without tools so
the model is forced to answer rather than looping on an 8 tok/s budget. Toward a remote
side, every round after the first is ruled on by the gate before it is sent.

Observed working: *"Read README.md and tell me which port the app listens on"* →
`list_directory(.)` → `read_file(README.md)` → "port 8100", in 56 s.

### Containment

`files.js` is the whole security boundary, so it's deliberately paranoid:

- Resolve, then compare via `path.relative` — **not** `startsWith`, because
  `C:\workspace-secret` string-matches `C:\workspace`.
- Re-check the **realpath**, so a junction or symlink inside the workspace can't tunnel out.
- Text extensions only, and a NUL-byte sniff rejects binaries that lie about their extension.
- Read-only. There is no write, delete, or shell tool. Deliberately — a shell loop
  if that's ever wanted, and it should stay a separate, consciously-chosen thing.

One more trap worth naming: the `find_files` walk tolerates unreadable directories so a
single locked folder can't kill a whole search. Applied to the root itself that turned a
renamed or deleted workspace into a cheerful `0 matches`, and the model would then report
that a file doesn't exist rather than that it never managed to look. `findFiles` now stats
the root first and says the folder is gone.

`tools/files_test.js` — **46/46**, covering `../` escapes, absolute and drive-absolute paths,
bare `..`, the prefix-sibling case, missing workspace, a vanished root across all three
tools, a file handed in as a root, binary sniffing, and truncation.
Verified against the live HTTP API too: `../../../Windows/win.ini`, `C:\Windows\win.ini`,
`..` and `../CFE/Assets` are all refused.

---

[← back to the README](../README.md)
