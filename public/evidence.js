// Does a reply name a file nobody has seen? Served to the page (window.AirlockEvidence) for
// the "unseen file" mark, and required by the tests — one definition of what counts.
//
// Why it exists: in a role-play run two local models were told, twice, that no files had
// been created, and one of them went on naming logs it had "written" — /log/nav_01.txt,
// /log/communication_test_01.csv — while the other agreed to compare against a baseline
// file that never existed. Airlock knows which files a tool actually read in a thread and
// which ones the user supplied, so this one kind of invented evidence is checkable without
// judging anyone's wording.
(function (root) {
'use strict';

/** Extensions that make a bare name (no slash) read as a file: `power_01.csv`. */
const EXT = 'csv|tsv|txt|log|json|jsonl|md|yaml|yml|toml|ini|cfg|conf|xml|html|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|cs|sh|ps1|bat|sql|db|sqlite|pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|svg|zip|env';
const BARE = new RegExp(`^[\\w.-]*[A-Za-z][\\w.-]*\\.(?:${EXT})$`, 'i');

/**
 * Candidate paths in a piece of text. A token with slashes counts only when it looks like
 * a path rather than prose: it starts at a root (/, ./, ~/, C:\), or a part of it has an
 * extension or an underscore. So `log/sequence_01` and `/data/x` count; "and/or", "km/s",
 * "10/12/14" and "TCP/IP" do not. URLs never count.
 */
function pathsIn(text) {
    const found = new Set();
    const tokens = String(text || '')
        .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ')          // URLs are not files here
        .match(/(?:[A-Za-z]:)?[\w.~\/\\-]+/g) || [];
    for (let raw of tokens) {
        raw = raw.replace(/[.\-]+$/, '');                       // sentence-final punctuation
        if (!raw) continue;
        const parts = raw.replace(/^(?:[A-Za-z]:)/, '').split(/[\/\\]+/).filter(Boolean);
        if (!parts.length || parts.some(p => !/^[\w.~-]+$/.test(p))) continue;
        if (parts.length === 1) {
            if (BARE.test(parts[0])) found.add(raw);
            continue;
        }
        const rooted = /^(?:[A-Za-z]:[\/\\]|[\/\\]|\.{1,2}[\/\\]|~[\/\\])/.test(raw);
        const fileish = parts.some(p => BARE.test(p) || /[A-Za-z].*_|_.*[A-Za-z]/.test(p));
        const words = parts.filter(p => /[A-Za-z]/.test(p)).length;
        if ((rooted && words >= 1) || (fileish && words >= 2) || (fileish && rooted)) found.add(raw);
    }
    return [...found];
}

/** One spelling for comparing: lower case, forward slashes, no leading ./ or /. */
const norm = p => String(p).toLowerCase().replace(/\\/g, '/').replace(/^[a-z]:/, '').replace(/^(?:\.{1,2}\/|~\/|\/)+/, '');

/**
 * The paths in `text` that match nothing in `seen` (paths a tool read, or the user wrote).
 * Matching is by trailing segments, either way round: `README.md` names `docs/README.md`
 * that was read, and `airlock-ui/docs/README.md` names a read of `docs/README.md`.
 */
function unseen(text, seen) {
    const known = [...seen].map(norm).filter(Boolean);
    const ends = (a, b) => a === b || a.endsWith('/' + b);
    return pathsIn(text).filter(p => {
        const n = norm(p);
        return n && !known.some(k => ends(k, n) || ends(n, k));
    });
}

const api = Object.freeze({ pathsIn, unseen });
if (typeof module === 'object' && module.exports) module.exports = api;
else root.AirlockEvidence = api;
})(typeof window !== 'undefined' ? window : globalThis);
