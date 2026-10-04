'use strict';

// ─────────────────────── Workspace tools ───────────────────────
//
// Read-only, confined by files.js to the workspace root of the thread a request names.
// Bounded rounds so a confused model can't spin the loop forever on an 8 tok/s budget.
//
// One module for both callers — /api/chat and the duet runner — because the thing a tool
// result is, for the boundary, has to be identical in both: the same message shape the
// kernel describes to the gate, the same label in "what has crossed", the same hash. Two
// copies would be two chances for one path to record a file differently from the other.

const fs = require('fs').promises;
const files = require('./files');
const kernel = require('./kernel');

const MAX_TOOL_ROUNDS = 5;

const TOOLS = [
    {
        type: 'function',
        function: {
            name: 'list_directory',
            description: 'List files and folders inside the workspace. Use "." for the workspace root.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Folder path relative to the workspace root.' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'find_files',
            description: 'Find files anywhere in the workspace whose filename contains the query. '
                + 'Use this when you know roughly what a file is called but not where it lives.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Substring to match against filenames.' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read a text file from the workspace (.md, .txt, .json, source code, etc). '
                + 'Returns the file contents, truncated if very large. Give start_line (and '
                + 'optionally end_line) to read only those lines, numbered — use that before '
                + 'quoting or citing a specific line.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path relative to the workspace root.' },
                    start_line: { type: 'integer', description: 'First line to read (1-based). Optional.' },
                    end_line: { type: 'integer', description: 'Last line to read. Optional; at most 400 lines per read.' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'search_text',
            description: 'Search inside the text files in the workspace for a word or phrase (case-insensitive, '
                + 'plain text). Returns each matching line with its file and line number. Use this to '
                + 'find where something is said; then read_file with start_line to see it in context.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'The word or phrase to look for.' },
                    path: { type: 'string', description: 'Folder to search in, relative to the workspace root. Optional; defaults to all of it.' }
                },
                required: ['query']
            }
        }
    }
];

/**
 * Not a workspace tool: a participant asking the user for a result it cannot get itself —
 * a measurement, a test, a fact only the user has. Offered in a duet to any model that can
 * call tools, workspace or not. The runner handles it (duet-runner.js): the request is
 * recorded on the reply, the turn ends with the model saying what it asked, and the user's
 * answer comes back as a message linked to it. It exists because models without it PRETEND:
 * measured, they reported running tests and supplied readings ("500 kPa") nobody took.
 */
const REQUEST_TOOL = {
    type: 'function',
    function: {
        name: 'request_result',
        description: 'Ask the User for a result you cannot get yourself: a measurement, the outcome '
            + 'of a test or action, or a fact only they have. Use this instead of guessing a result '
            + 'or describing yourself doing something. The User answers in a later message.',
        parameters: {
            type: 'object',
            properties: {
                request: { type: 'string', description: 'Exactly what you need: what to do or measure, and what to report back.' }
            },
            required: ['request']
        }
    }
};

/** What the model is told after asking — then it finishes its turn without tools. */
const REQUEST_SENT = 'Request sent to the User. The result is unknown until they answer in a later message: '
    + 'do not guess it or continue as though you have it. Finish your turn now, briefly: say what you asked for and why.';

async function runTool(name, args, root) {
    switch (name) {
        case 'list_directory': return files.listDirectory(root, args.path || '.');
        case 'find_files':     return files.findFiles(root, args.query);
        case 'search_text':    return files.searchText(root, args.query, args.path || '.');
        case 'read_file':      return files.readTextFile(root, args.path,
                                   { startLine: args.start_line ?? null, endLine: args.end_line ?? null });
        default: throw new Error(`Unknown tool: ${name}`);
    }
}

/** One-line description for the UI's tool card. */
function summarise(name, args, result, ok) {
    if (!ok) return `${name} failed: ${result.error}`;
    switch (name) {
        case 'list_directory': return `${result.path} — ${result.entries.length} entries`;
        case 'find_files':     return `"${result.query}" — ${result.count} match(es)`;
        case 'search_text':    return `"${result.query}" — ${result.count} line(s)${result.truncated ? ', capped' : ''}`;
        case 'read_file':      return result.startLine
                                    ? `${result.path} — lines ${result.startLine}–${result.endLine} of ${result.lines}`
                                    : `${result.path} — ${result.bytes.toLocaleString()} bytes`
                                      + (result.truncated ? ' (truncated)' : '');
        default: return name;
    }
}

/**
 * A root is usable if the folder still exists AND is still permitted.
 *
 * A root pointing at a folder that no longer exists is worse than no tools at all: every
 * call fails, and the model spends the whole round budget finding that out. And a root
 * must be permitted when it is USED, not just when it was chosen: a database carried onto
 * a hosted box holds whatever roots were set on the desk.
 */
async function usableRoot(root) {
    if (!root) return false;
    return await fs.stat(root).then(s => s.isDirectory()).catch(() => false)
        && await files.permitRoot(root).then(() => true, () => false);
}

/**
 * Run one round of tool calls against a root.
 *
 * Returns, per call: the `tool` message to append to the conversation, a card for the UI,
 * and the artifact that describes it for the crossing record — label, size and hash,
 * computed from exactly the message that would be sent, so what is recorded is what went.
 */
/**
 * `fit`, optional: sizes each result's text to the room left in the model's window
 * (duet-runner.js). Applied before the hash, so what the crossing record describes is
 * exactly what was sent — the fitted text, not the file.
 */
async function runCalls(toolCalls, root, { fit = s => s } = {}) {
    const out = [];
    for (const call of toolCalls) {
        const name = call.function?.name;
        let args = call.function?.arguments ?? {};
        if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch { args = {}; }
        }

        let result, ok = true;
        try {
            result = await runTool(name, args, root);
        } catch (err) {
            ok = false;
            result = { error: err.message };
        }

        const message = { role: 'tool', tool_name: name, content: fit(JSON.stringify(result).slice(0, 120000)) };
        const target = args.path || args.query || '.';
        const sha = kernel.unitHash(message).slice(0, 12);

        out.push({
            message,
            card: { name, args, ok, summary: summarise(name, args, result, ok) },
            artifact: {
                label: `${name}(${target}) ${message.content.length.toLocaleString()} chars sha:${sha}`,
                tool: name,
                target,
                ok,
                // What the model was shown, for the evidence marks: files, and for a ranged
                // read or a search, which lines. Paths only — never contents.
                ...(ok ? { seen: seenBy(name, result) } : {}),
                chars: message.content.length,
                sha
            }
        });
    }
    return out;
}

/** Files (and lines) a successful call showed the model. */
function seenBy(name, result) {
    if (name === 'read_file') {
        return [{ path: result.path, ...(result.startLine ? { lines: [result.startLine, result.endLine] } : {}) }];
    }
    if (name === 'search_text') {
        const byPath = new Map();
        for (const m of result.matches) (byPath.get(m.path) || byPath.set(m.path, []).get(m.path)).push(m.line);
        return [...byPath].map(([p, lines]) => ({ path: p, hits: lines }));
    }
    return undefined;
}

module.exports = { MAX_TOOL_ROUNDS, TOOLS, REQUEST_TOOL, REQUEST_SENT, runTool, summarise, usableRoot, runCalls };
