// Which words of a reply were already said by someone else? Served to the page
// (window.AirlockRestate) for the "restated" shading, and required by the tests — one
// definition of what counts as restating.
//
// Why it exists: small models parrot. A four-paragraph reply in a chatter run can be one new
// sentence wrapped in the other side's wording, and reading it you cannot tell which part is
// new. This finds runs of words copied word for word from earlier messages by OTHER authors
// (the other side, or the user), so the page can dim them and leave the new words standing.
// A side repeating ITSELF is echo.js's business, not this.
(function (root) {
'use strict';

/** A copied run must be at least this many words in a row: "I agree with you" is not copying. */
const RUN = 6;
/** The header mark appears when at least this share of the reply is restated… */
const MARK_SHARE = 0.4;
/** …and at least this many words of it: a two-line reply quoting one phrase is not a parrot. */
const MARK_WORDS = 12;

/** Words with where they sit in the text, compared lower-case. Same word rule as echo.js. */
function wordsAt(text) {
    const out = [];
    for (const m of String(text || '').matchAll(/[\p{L}\p{N}']+/gu)) {
        out.push({ w: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
    }
    return out;
}

/**
 * The runs of `text` that already appear, word for word, in one of `sources`
 * ([{ id, text }], in order of priority — the first source holding a run is named as where it
 * came from). Returns { spans: [{ start, end, from }], copied, total, share }, where spans are
 * character offsets into `text` and copied/total count words.
 */
function restated(text, sources) {
    const mine = wordsAt(text);
    const none = { spans: [], copied: 0, total: mine.length, share: 0 };
    if (mine.length < RUN || !sources?.length) return none;

    // Every RUN-word window of every source, first source wins.
    const owner = new Map();
    for (const s of sources) {
        const ws = wordsAt(s.text).map(x => x.w);
        for (let i = 0; i + RUN <= ws.length; i++) {
            const key = ws.slice(i, i + RUN).join(' ');
            if (!owner.has(key)) owner.set(key, s.id);
        }
    }
    if (!owner.size) return none;

    // Each word covered by a matching window takes that window's source.
    const from = new Array(mine.length).fill(null);
    for (let i = 0; i + RUN <= mine.length; i++) {
        const id = owner.get(mine.slice(i, i + RUN).map(x => x.w).join(' '));
        if (id === undefined) continue;
        for (let j = i; j < i + RUN; j++) if (from[j] === null) from[j] = id;
    }

    // Neighbouring words from the same source become one span.
    const spans = [];
    let copied = 0;
    for (let i = 0; i < mine.length; i++) {
        if (from[i] === null) continue;
        copied++;
        const last = spans[spans.length - 1];
        if (last && last.from === from[i] && last.endWord === i - 1) {
            last.end = mine[i].end;
            last.endWord = i;
        } else {
            spans.push({ start: mine[i].start, end: mine[i].end, from: from[i], endWord: i });
        }
    }
    return {
        spans: spans.map(({ start, end, from }) => ({ start, end, from })),
        copied,
        total: mine.length,
        share: copied / mine.length
    };
}

/** Is this much restating worth a mark in the header? */
const worthMarking = r => Boolean(r) && r.copied >= MARK_WORDS && r.share >= MARK_SHARE;

const api = Object.freeze({ restated, worthMarking, RUN, MARK_SHARE, MARK_WORDS });
if (typeof module === 'object' && module.exports) module.exports = api;
else root.AirlockRestate = api;
})(typeof window !== 'undefined' ? window : globalThis);
