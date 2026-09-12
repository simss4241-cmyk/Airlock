'use strict';

/**
 * Workspace file-access tests. No server needed — exercises files.js directly.
 *   node tools/files_test.js
 *
 * The containment cases are the reason this file exists. Everything Airlock can reach is
 * decided here, so a regression is a sandbox escape, not a cosmetic bug.
 */

const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const files = require('../files');

let pass = 0;
const failures = [];

function check(label, cond, detail = '') {
    if (cond) { pass++; console.log(`  ok   ${label}`); }
    else { failures.push(label); console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}

async function throws(label, fn, expect) {
    try {
        await fn();
        check(label, false, 'did not throw');
    } catch (err) {
        check(label, !expect || new RegExp(expect, 'i').test(err.message), err.message);
    }
}

(async () => {
    console.log('\nAirlock workspace file tests\n');

    // ── fixture tree ──
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'airlock-fs-'));
    const root = path.join(tmp, 'workspace');
    const outside = path.join(tmp, 'workspace-secret');   // shares a string prefix on purpose

    await fs.mkdir(path.join(root, 'docs', 'deep'), { recursive: true });
    await fs.mkdir(path.join(root, 'node_modules', 'junk'), { recursive: true });
    await fs.mkdir(outside, { recursive: true });

    await fs.writeFile(path.join(root, 'README.md'), '# Notes\nWidget v13 open, v24 closed.\n');
    await fs.writeFile(path.join(root, 'notes.txt'), 'boba pearl tuning\n');
    await fs.writeFile(path.join(root, 'docs', 'spec.md'), '# Spec\nBracket frame v7.\n');
    await fs.writeFile(path.join(root, 'docs', 'deep', 'buried.md'), 'deep file\n');
    await fs.writeFile(path.join(root, 'model.stl'), 'solid whatever\n');
    await fs.writeFile(path.join(root, 'blob.bin'), Buffer.from([1, 2, 0, 3, 4, 5]));
    await fs.writeFile(path.join(root, 'node_modules', 'junk', 'index.js'), 'noise\n');
    await fs.writeFile(path.join(outside, 'secrets.md'), 'API KEY: hunter2\n');

    // ── listing ──
    const list = await files.listDirectory(root, '.');
    const names = list.entries.map(e => e.name);
    check('lists files in the root', names.includes('README.md') && names.includes('notes.txt'));
    check('lists directories', list.entries.some(e => e.name === 'docs' && e.type === 'dir'));
    check('skips node_modules', !names.includes('node_modules'), names.join(','));
    check('folders sort before files', list.entries[0].type === 'dir');
    check('marks unreadable types', list.entries.find(e => e.name === 'model.stl')?.readable === false);
    check('marks readable types', list.entries.find(e => e.name === 'README.md')?.readable === true);
    check('reports sizes', list.entries.find(e => e.name === 'README.md').bytes > 0);

    const sub = await files.listDirectory(root, 'docs');
    check('lists a subdirectory', sub.entries.some(e => e.name === 'spec.md'));
    check('subdirectory path is relative with forward slashes', sub.path === 'docs', sub.path);

    // ── reading ──
    const readme = await files.readTextFile(root, 'README.md');
    check('reads a markdown file', readme.content.includes('Widget v13'));
    check('read reports its relative path', readme.path === 'README.md', readme.path);
    check('read reports byte count', readme.bytes > 10);
    check('short file is not truncated', readme.truncated === false);

    const nested = await files.readTextFile(root, 'docs/spec.md');
    check('reads via forward-slash path', nested.content.includes('Bracket'));
    const nestedWin = await files.readTextFile(root, 'docs\\spec.md');
    check('reads via backslash path', nestedWin.content.includes('Bracket'));

    await throws('refuses a non-text extension', () => files.readTextFile(root, 'model.stl'), 'not a readable text file');
    await throws('refuses a binary file despite extension', async () => {
        await fs.writeFile(path.join(root, 'fake.md'), Buffer.from([65, 0, 66]));
        return files.readTextFile(root, 'fake.md');
    }, 'binary');
    await throws('reports a missing file clearly', () => files.readTextFile(root, 'nope.md'), 'no such file');
    await throws('refuses to read a directory', () => files.readTextFile(root, 'docs'), 'directory');
    await throws('read with no path errors', () => files.readTextFile(root, ''), 'needs a path');

    // ── truncation ──
    const big = 'x'.repeat(files.MAX_BYTES + 5000);
    await fs.writeFile(path.join(root, 'big.md'), big);
    const bigRead = await files.readTextFile(root, 'big.md');
    check('caps oversized reads', bigRead.content.length <= files.MAX_BYTES + 200, `${bigRead.content.length}`);
    check('flags truncation', bigRead.truncated === true);
    check('says so in the content', /truncated/.test(bigRead.content));

    // ── containment: the part that matters ──
    await throws('blocks ../ escape', () => files.readTextFile(root, '../workspace-secret/secrets.md'), 'escape');
    await throws('blocks nested ../ escape', () => files.readTextFile(root, 'docs/../../workspace-secret/secrets.md'), 'escape');
    await throws('blocks an absolute path', () => files.readTextFile(root, path.join(outside, 'secrets.md')), 'escape');
    await throws('blocks a Windows drive-absolute path', () => files.readTextFile(root, 'C:\\Windows\\win.ini'), 'escape');
    await throws('blocks listing outside the root', () => files.listDirectory(root, '..'), 'escape');
    await throws('blocks bare .. traversal', () => files.readTextFile(root, '..'), 'escape');

    // sibling directory sharing a string prefix — the classic startsWith() bug
    await throws('a sibling folder with a shared prefix is still outside',
        () => files.readTextFile(root + '', '../workspace-secret/secrets.md'), 'escape');
    const prefixEscape = path.relative(root, outside);   // "..\workspace-secret"
    await throws('prefix-sibling via relative path is blocked',
        () => files.readTextFile(root, prefixEscape + '/secrets.md'), 'escape');

    await throws('no workspace set is refused', () => files.readTextFile(null, 'README.md'), 'no workspace');
    await throws('empty workspace is refused', () => files.listDirectory('', '.'), 'no workspace');

    // ── find ──
    const found = await files.findFiles(root, 'spec');
    check('find locates a nested file', found.matches.some(m => m.path === 'docs/spec.md'),
        found.matches.map(m => m.path).join(','));
    const deep = await files.findFiles(root, 'buried');
    check('find recurses into deep folders', deep.matches.some(m => m.path === 'docs/deep/buried.md'));
    const md = await files.findFiles(root, '.md');
    check('find matches by extension substring', md.count >= 3, `${md.count}`);
    check('find skips node_modules', !(await files.findFiles(root, 'index.js')).matches.length);
    check('find is case-insensitive', (await files.findFiles(root, 'README')).count === 1);
    check('find reports readability', md.matches.every(m => m.readable === true));
    await throws('find with no query errors', () => files.findFiles(root, '  '), 'needs a query');
    const none = await files.findFiles(root, 'zzzznothing');
    check('find with no hits returns empty, not an error', none.count === 0);

    // ── a workspace whose folder went away ──
    // The walk tolerates unreadable directories, which would otherwise make a deleted or
    // renamed root look like a successful search that found nothing. All three tools have
    // to say the root is gone, or the model reports the file doesn't exist.
    const vanished = path.join(tmp, 'never-existed');
    await throws('find on a missing root errors',
        () => files.findFiles(vanished, 'readme'), 'no longer exists');
    await throws('list on a missing root errors',
        () => files.listDirectory(vanished, '.'), 'no such directory');
    await throws('read on a missing root errors',
        () => files.readTextFile(vanished, 'README.md'), 'no such file');

    // A file handed in as the root is not a workspace either.
    await throws('find on a file-as-root errors',
        () => files.findFiles(path.join(root, 'README.md'), 'readme'), 'not a directory');

    // ── cleanup ──
    await fs.rm(tmp, { recursive: true, force: true });
    check('fixture cleaned up', !(await fs.access(tmp).then(() => true).catch(() => false)));

    console.log(`\n${pass} passed, ${failures.length} failed\n`);
    if (failures.length) {
        failures.forEach(f => console.log(`  - ${f}`));
        process.exit(1);
    }
})().catch(err => {
    console.error('\nfile tests crashed:', err);
    process.exit(1);
});
