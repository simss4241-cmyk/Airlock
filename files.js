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

async function readTextFile(root, rel) {
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

module.exports = {
    resolveInside, listDirectory, readTextFile, findFiles, isTextFile,
    MAX_BYTES, TEXT_EXT, SKIP_DIRS
};
