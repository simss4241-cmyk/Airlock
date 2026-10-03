'use strict';

/**
 * Workspace file access for Airlock's tool loop.
 *
 * Everything here is read-only and confined to a workspace root the user picks. The
 * containment check is the whole point of this file, so it is deliberately paranoid:
 * resolve, verify by path segment (not string prefix), then re-verify against the real
 * path so a junction or symlink can't tunnel out.
 */

const fs = require('fs').promises;
const path = require('path');

const MAX_BYTES = 256 * 1024;      // per file; larger reads get truncated with a note
const MAX_ENTRIES = 400;           // per directory listing
const MAX_FIND = 150;              // per find
const MAX_DEPTH = 8;               // find recursion depth
const MAX_RANGE = 400;             // lines per ranged read
const MAX_HITS = 60;               // per search
const MAX_HITS_PER_FILE = 8;       // so one noisy file cannot fill a search
const MAX_SEARCH_FILES = 2000;     // files opened per search
const MAX_LINE_CHARS = 240;        // a matching line is shown, not a minified bundle

// Text-ish only. Reading a 3D model or a PNG into a prompt wastes the context window.
const TEXT_EXT = new Set([
    '.md', '.markdown', '.txt', '.text', '.rst', '.log',
    '.json', '.jsonl', '.csv', '.tsv', '.xml', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf',
    '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.c', '.h',
    '.cpp', '.cs', '.sql', '.sh', '.ps1', '.bat', '.cmd', '.vbs',
    '.html', '.htm', '.css', '.scss', '.svg', '.scad', '.gitignore', '.env.example'
]);

// Noise that would blow the context window and tell the model nothing.
const SKIP_DIRS = new Set([
    'node_modules', '.git', '.svn', '__pycache__', '.venv', 'venv', 'env',
    'dist', 'build', 'out', '.next', '.nuxt', '.cache', '.idea', '.vs',
    'coverage', '.pytest_cache', 'target'
]);

const isTextFile = name => {
    const ext = path.extname(name).toLowerCase();
    return TEXT_EXT.has(ext) || TEXT_EXT.has(name.toLowerCase());
};

/**
 * Resolve `rel` inside `root`, or throw.
 *
 * `startsWith` is NOT sufficient — "C:\Projects-secret" starts with "C:\Projects". Compare
 * by relative path instead, then confirm the real (symlink-resolved) path is still inside.
 */
async function resolveInside(root, rel = '.') {
    if (!root) throw new Error('No workspace is set. Pick one in Settings first.');

    const base = path.resolve(root);
    const target = path.resolve(base, rel || '.');

    const relative = path.relative(base, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Path escapes the workspace: ${rel}`);
    }

    // A junction inside the workspace could still point outside it.
    try {
        const real = await fs.realpath(target);
        const realBase = await fs.realpath(base);
        const realRel = path.relative(realBase, real);
        if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
            throw new Error(`Path resolves outside the workspace: ${rel}`);
        }
        return real;
    } catch (err) {
        if (err.code === 'ENOENT') return target;   // may not exist yet; caller reports that
        throw err;
    }
}

/**
 * Which folders may become a workspace root at all.
 *
 * Containment above keeps a tool inside its root. This decides what a root may BE — and
 * on a desk that is anything: it is your machine and your folders. On a hosted instance
 * it cannot be. There, every visitor is someone else, and "any absolute folder that
 * exists" means pointing a workspace at / and reading every .json, .yml, .conf and .log
 * on the server — where service-account keys, Docker auth and application logs live.
 * The extension allowlist happens to stop .env and SSH keys; it was never meant to be
 * the thing standing between a stranger and the host's filesystem.
 *
 *   'any'        AIRLOCK_WORKSPACE_ROOTS unset, and nothing says this is hosted.
 *   'allowlist'  AIRLOCK_WORKSPACE_ROOTS names folders (path.delimiter separated: ';' on
 *                Windows, ':' elsewhere). A root must be one of them or inside one.
 *   'off'        Hosted — AIRLOCK_TOKEN, AIRLOCK_DEMO or AIRLOCK_SANDBOXES is set — with
 *                no allowlist.
 *                Workspaces are refused outright rather than falling back to 'any'.
 *
 * ⚠ 'off' is the point. The failure this prevents is someone setting up a hosted
 * instance, forgetting one variable, and shipping a filesystem browser. Forgetting it
 * now costs the workspace feature, not the host.
 *
 * Read at call time, not load time, so the policy is whatever the environment says now.
 */
function workspacePolicy() {
    const roots = (process.env.AIRLOCK_WORKSPACE_ROOTS || '')
        .split(path.delimiter).map(r => r.trim()).filter(Boolean).map(r => path.resolve(r));
    if (roots.length) return { mode: 'allowlist', roots };
    const hosted = Boolean((process.env.AIRLOCK_TOKEN || '').trim() || process.env.AIRLOCK_DEMO
        || process.env.AIRLOCK_SANDBOXES === '1');
    return { mode: hosted ? 'off' : 'any', roots: [] };
}

/**
 * May `root` be a workspace? Throws with a reason the UI can show if not.
 *
 * Compared by real path, like resolveInside, so a junction or symlink cannot make a
 * folder outside the allowlist look like one inside it.
 */
async function permitRoot(root) {
    const policy = workspacePolicy();
    if (policy.mode === 'any') return;
    if (policy.mode === 'off') {
        throw new Error('Workspaces are off on this instance: it is hosted, and no '
            + 'AIRLOCK_WORKSPACE_ROOTS says which folders visitors may open.');
    }

    const real = await fs.realpath(root);
    for (const allowed of policy.roots) {
        const base = await fs.realpath(allowed).catch(() => null);
        if (!base) continue;
        const rel = path.relative(base, real);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) return;
    }
    throw new Error(`Workspaces on this instance are limited to: ${policy.roots.join(', ')}`);
}

/** Path as the model should see it — relative to the root, forward slashes. */
const display = (root, abs) => {
    const rel = path.relative(path.resolve(root), abs).replace(/\\/g, '/');
    return rel === '' ? '.' : rel;
};

async function listDirectory(root, rel = '.') {
    const dir = await resolveInside(root, rel);
    const stat = await fs.stat(dir).catch(() => null);

    if (!stat) throw new Error(`No such directory: ${rel}`);
    if (!stat.isDirectory()) throw new Error(`Not a directory: ${rel}`);

    const raw = await fs.readdir(dir, { withFileTypes: true });
    const entries = [];

    for (const e of raw) {
        if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
        if (e.isDirectory()) {
            entries.push({ name: e.name, type: 'dir' });
        } else if (e.isFile()) {
            const s = await fs.stat(path.join(dir, e.name)).catch(() => null);
            entries.push({
                name: e.name,
                type: 'file',
                bytes: s?.size ?? 0,
                readable: isTextFile(e.name)
            });
        }
    }

    entries.sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1));

    return {
        path: display(root, dir),
        truncated: entries.length > MAX_ENTRIES,
        entries: entries.slice(0, MAX_ENTRIES)
    };
}

/**
 * Read a text file. Given a line range, returns only those lines, each prefixed with its
 * number ("45: …") — so a model that cites a line can be checked against what it was shown.
 */
async function readTextFile(root, rel, { startLine = null, endLine = null } = {}) {
    if (!rel) throw new Error('read_file needs a path.');

    const file = await resolveInside(root, rel);
    const stat = await fs.stat(file).catch(() => null);

    if (!stat) throw new Error(`No such file: ${rel}`);
    if (stat.isDirectory()) throw new Error(`That's a directory, not a file: ${rel}`);
    if (!isTextFile(path.basename(file))) {
        throw new Error(`Not a readable text file: ${rel} `
            + `(allowed: ${[...TEXT_EXT].slice(0, 12).join(' ')}…)`);
    }

    const buf = await fs.readFile(file);

    // NUL bytes in the first chunk means binary regardless of the extension.
    if (buf.subarray(0, 4096).includes(0)) {
        throw new Error(`Looks binary, refusing to read: ${rel}`);
    }

    if (startLine != null || endLine != null) {
        const lines = buf.toString('utf8').split(/\r?\n/);
        const from = Math.max(1, Math.floor(Number(startLine) || 1));
        if (from > lines.length) throw new Error(`${rel} has only ${lines.length} lines.`);
        const asked = Math.floor(Number(endLine) || from + MAX_RANGE - 1);
        const to = Math.min(lines.length, Math.max(from, asked), from + MAX_RANGE - 1);
        const content = lines.slice(from - 1, to).map((l, i) => `${from + i}: ${l}`).join('\n')
            + (to < Math.min(lines.length, asked) ? `\n[range capped at ${MAX_RANGE} lines — ask for more from line ${to + 1}]` : '');
        return { path: display(root, file), bytes: buf.length, lines: lines.length, startLine: from, endLine: to, truncated: false, content };
    }

    const truncated = buf.length > MAX_BYTES;
    let content = buf.subarray(0, MAX_BYTES).toString('utf8');
    if (truncated) {
        content += `\n\n[truncated — file is ${buf.length} bytes, showing first ${MAX_BYTES}]`;
    }

    return { path: display(root, file), bytes: buf.length, truncated, content };
}

/** Substring match on the filename, depth- and count-capped. */
async function findFiles(root, query) {
    if (!query || !query.trim()) throw new Error('find_files needs a query.');

    const base = await resolveInside(root, '.');

    // The walk below swallows unreadable directories so one locked folder can't kill a
    // whole search. That would also turn a workspace whose folder was renamed or deleted
    // into a cheerful "0 matches" — and the model would report the file doesn't exist
    // rather than that it never looked. Check the root itself before believing an empty walk.
    const rootStat = await fs.stat(base).catch(() => null);
    if (!rootStat) throw new Error(`Workspace folder no longer exists: ${root}`);
    if (!rootStat.isDirectory()) throw new Error(`Workspace root is not a directory: ${root}`);

    const needle = query.trim().toLowerCase();
    const hits = [];

    const walk = async (dir, depth) => {
        if (depth > MAX_DEPTH || hits.length >= MAX_FIND) return;

        const raw = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const e of raw) {
            if (hits.length >= MAX_FIND) return;
            const full = path.join(dir, e.name);

            if (e.isDirectory()) {
                if (SKIP_DIRS.has(e.name)) continue;
                await walk(full, depth + 1);
            } else if (e.isFile() && e.name.toLowerCase().includes(needle)) {
                const s = await fs.stat(full).catch(() => null);
                hits.push({
                    path: display(root, full),
                    bytes: s?.size ?? 0,
                    readable: isTextFile(e.name)
                });
            }
        }
    };

    await walk(base, 0);
    return { query, count: hits.length, truncated: hits.length >= MAX_FIND, matches: hits };
}

/**
 * Search the contents of the workspace's text files for a phrase (case-insensitive, plain
 * text — not a regular expression, so a model cannot write a pathological one). Returns
 * where it occurs, line by line. Capped in files opened, hits, hits per file and line
 * length; a capped search says so, so "not found" is never claimed from a partial look.
 */
async function searchText(root, query, rel = '.') {
    if (!query || !query.trim()) throw new Error('search_text needs a query.');

    const base = await resolveInside(root, rel || '.');
    const baseStat = await fs.stat(base).catch(() => null);
    if (!baseStat) throw new Error(`No such folder: ${rel}`);
    if (!baseStat.isDirectory()) throw new Error(`Not a folder: ${rel}`);

    const needle = query.trim().toLowerCase();
    const matches = [];
    let opened = 0, capped = false;

    const scan = async full => {
        const s = await fs.stat(full).catch(() => null);
        if (!s || s.size > MAX_BYTES * 4) return;
        const buf = await fs.readFile(full).catch(() => null);
        if (!buf || buf.subarray(0, 4096).includes(0)) return;
        opened++;
        const lines = buf.toString('utf8').split(/\r?\n/);
        let inFile = 0;
        for (let i = 0; i < lines.length; i++) {
            if (!lines[i].toLowerCase().includes(needle)) continue;
            if (matches.length >= MAX_HITS || inFile >= MAX_HITS_PER_FILE) { capped = true; break; }
            const text = lines[i].trim();
            matches.push({ path: display(root, full), line: i + 1,
                text: text.length > MAX_LINE_CHARS ? text.slice(0, MAX_LINE_CHARS) + '…' : text });
            inFile++;
        }
    };

    const walk = async (dir, depth) => {
        if (depth > MAX_DEPTH) return;
        const raw = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        raw.sort((a, b) => a.name.localeCompare(b.name));
        for (const e of raw) {
            if (matches.length >= MAX_HITS || opened >= MAX_SEARCH_FILES) { capped = true; return; }
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (!SKIP_DIRS.has(e.name)) await walk(full, depth + 1);
            } else if (e.isFile() && isTextFile(e.name)) {
                await scan(full);
            }
        }
    };

    await walk(base, 0);
    return { query, in: display(root, base), count: matches.length, truncated: capped, matches };
}

module.exports = {
    resolveInside, listDirectory, readTextFile, findFiles, searchText, isTextFile,
    workspacePolicy, permitRoot,
    MAX_BYTES, TEXT_EXT, SKIP_DIRS
};
