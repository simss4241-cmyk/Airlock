'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airlock-workspace-test-'));
const dbPath = path.join(tempDir, 'legacy.db');

// Start with the pre-workspace schema to exercise the real migration path.
const legacy = new DatabaseSync(dbPath);
legacy.exec(`
    CREATE TABLE folders (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE threads (
        id INTEGER PRIMARY KEY,
        folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_at TEXT NOT NULL
    );
    INSERT INTO folders VALUES (1, 'TEST', 0, 'now');
    INSERT INTO threads VALUES (1, 1, 'Alpha', 0, 'now');
    INSERT INTO threads VALUES (2, 1, 'Beta', 1, 'now');
`);
legacy.close();

process.env.AIRLOCK_DB = dbPath;
const store = require('../db');

try {
    const columns = store.db.prepare('PRAGMA table_info(threads)').all().map(column => column.name);
    assert(columns.includes('workspace_root'), 'legacy database gains workspace_root');

    assert.equal(store.getThread(1).workspace_root, null);
    assert.equal(store.getThread(2).workspace_root, null);

    store.setThreadWorkspace(1, 'C:\\alpha');
    assert.equal(store.getThread(1).workspace_root, 'C:\\alpha');
    assert.equal(store.getThread(2).workspace_root, null, 'threads remain independent');

    assert.equal(Number(store.migrateWorkspaceRoot('C:\\legacy-default')), 1);
    assert.equal(store.getThread(1).workspace_root, 'C:\\alpha', 'migration preserves explicit root');
    assert.equal(store.getThread(2).workspace_root, 'C:\\legacy-default');

    store.setThreadWorkspace(1, null);
    assert.equal(store.getThread(1).workspace_root, null, 'workspace can be changed or cleared');

    // The bridge is one-time and must stay spent. A stray global root — restored config,
    // hand edit, copy from another machine — must not re-grant access to "files off" threads.
    assert.equal(Number(store.migrateWorkspaceRoot('C:\\sneaky')), 0, 'migration runs at most once');
    assert.equal(store.getThread(1).workspace_root, null, 'a cleared thread stays cleared');
    assert(store.getMeta('workspace_root_migrated'), 'migration is marked spent in the database');

    // A database created after the change (or already migrated) has the column from the
    // start, so opening it must mark the bridge spent — otherwise a legacy config found
    // later would splat one root across every thread in it. Needs a fresh process: db.js
    // does its schema work once, at require time.
    const modernPath = path.join(tempDir, 'modern.db');
    const probe = `
        process.env.AIRLOCK_DB = ${JSON.stringify(modernPath)};
        const s = require(${JSON.stringify(path.resolve(__dirname, '..', 'db.js'))});
        const marked = !!s.getMeta('workspace_root_migrated');
        const changed = Number(s.migrateWorkspaceRoot('C:\\\\should-not-apply'));
        const rooted = s.db.prepare(
            'SELECT COUNT(*) c FROM threads WHERE workspace_root IS NOT NULL').get().c;
        const threads = s.db.prepare('SELECT COUNT(*) c FROM threads').get().c;
        s.db.close();
        console.log(JSON.stringify({ marked, changed, rooted, threads }));
    `;
    const raw = execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
    const fresh = JSON.parse(raw.trim().split('\n').pop());

    assert(fresh.threads > 0, 'a fresh database seeds threads worth protecting');
    assert(fresh.marked, 'a thread-scoped database opens with the bridge already spent');
    assert.equal(fresh.changed, 0, 'the bridge refuses to run on it');
    assert.equal(fresh.rooted, 0, 'every seeded thread still starts with files off');

    console.log('workspace_test: all checks passed');
} finally {
    store.db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
}
