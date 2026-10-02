// Is a reply repeating an earlier one? Served to the page (window.AirlockEcho) for the
// chatter run and the "repeat" mark, and required by the tests — one definition of what
// counts as a repeat, so the stop and its tests cannot disagree.
//
// Why it exists: two 4B participants with reasoning off fell into a loop, one side
// restating the same two sentences word for word every turn, and an Auto run burned turns
// on it until the cap — free on a local model, real credit across the boundary.
(function (root) {
'use strict';

/** Similar enough to be the same reply said again: measured on word sets (below). */
const THRESHOLD = 0.85;
/** Below this many distinct words, only an exact match counts — "I agree." can recur. */
const MIN_WORDS = 6;

const words = text => String(text || '').toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];

/**
 * Word-set overlap, |A ∩ B| / |A ∪ B| (Jaccard). One word changed in a thirty-word reply
 * scores ~0.94; two replies that agree in different words ("Yes, that is correct…" /
 * "Yes, the user is right…") score far below the threshold, because agreeing is not
 * repeating.
 */
function similarity(a, b) {
    const A = new Set(words(a)), B = new Set(words(b));
    if (!A.size || !B.size) return 0;
    let shared = 0;
    for (const w of A) if (B.has(w)) shared++;
    return shared / (A.size + B.size - shared);
}

/**
 * Is `text` a repeat of any of `earlier` (the same side's previous replies)? Returns the
 * index into `earlier` of the one it repeats, or -1.
 */
function repeats(text, earlier) {
    const mine = new Set(words(text));
    if (!mine.size) return -1;
    for (let i = earlier.length - 1; i >= 0; i--) {
        const theirs = new Set(words(earlier[i]));
        if (!theirs.size) continue;
        const short = mine.size < MIN_WORDS || theirs.size < MIN_WORDS;
        const same = short
            ? words(text).join(' ') === words(earlier[i]).join(' ')
            : similarity(text, earlier[i]) >= THRESHOLD;
        if (same) return i;
    }
    return -1;
}

const api = Object.freeze({ similarity, repeats, THRESHOLD, MIN_WORDS });
if (typeof module === 'object' && module.exports) module.exports = api;
else root.AirlockEcho = api;
})(typeof window !== 'undefined' ? window : globalThis);
