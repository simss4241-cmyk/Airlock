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
                + 'Returns the file contents, truncated if very large.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path relative to the workspace root.' }
                },
                required: ['path']
            }
        }
    }
];

async function runTool(name, args, root) {
    switch (name) {
        case 'list_directory': return files.listDirectory(root, args.path || '.');
        case 'find_files':     return files.findFiles(root, args.query);
        case 'read_file':      return files.readTextFile(root, args.path);
        default: throw new Error(`Unknown tool: ${name}`);
    }
}

/** One-line description for the UI's tool card. */
function summarise(name, args, result, ok) {
    if (!ok) return `${name} failed: ${result.error}`;
    switch (name) {
        case 'list_directory': return `${result.path} — ${result.entries.length} entries`;
        case 'find_files':     return `"${result.query}" — ${result.count} match(es)`;
        case 'read_file':      return `${result.path} — ${result.bytes.toLocaleString()} bytes`
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
async function runCalls(toolCalls, root) {
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

        const message = { role: 'tool', tool_name: name, content: JSON.stringify(result).slice(0, 120000) };
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
                chars: message.content.length,
                sha
            }
        });
    }
    return out;
}

module.exports = { MAX_TOOL_ROUNDS, TOOLS, runTool, summarise, usableRoot, runCalls };
