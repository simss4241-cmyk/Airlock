// Where did a number come from? Served to the page (window.AirlockFigures) for the figure
// marks, required by the server (to note which numbers a tool result held), and by the tests
// — one definition of what counts as a figure and when two are the same.
//
// Why it exists: in the scripted Wayfarer runs the models invented data — "500 kPa", valve
// states — and then listed it as "known for certain". Whether a number is TRUE is not
// checkable here; where it was FIRST SAID is. A figure is either sourced (the user wrote it,
// or a tool returned it), first said by a model earlier in the thread, or new in this reply.
// Nothing judges wording: a proposal ("try 10 seconds") and an invention ("it pulses every
// 11 seconds") both read "new here", and the reader tells them apart at a glance.
(function (root) {
'use strict';

/**
 * Units a number may be written against with no space: "500kPa", "16s", "5%". Anything else
 * glued on makes it part of a name — "8b", "4B", "3D", "yolov8" — not a measurement.
 */
const UNITS = new Set(('% s ms us ns h hr hrs min mins sec secs d kg g mg km m cm mm nm '
    + 'kpa pa mpa hpa bar mbar psi atm hz khz mhz ghz v mv kv a ma w kw mw gw kwh mwh j kj '
    + 'c f k kb mb gb tb kbps mbps gbps fps rpm x l ml db k°c °c °f °').split(' '));

/** Words that make the number after them a label, not a quantity: "step 2", "option 3". */
const LABELS = /\b(?:step|steps|option|options|phase|point|part|item|stage|round|turn|case|section|chapter|level|tier|no|number|version|ver|v|q|question|answer|message|reply|slot|appendix|figure|fig|table|page)\s*$/i;

/** Blank `text` between start and end, keeping every offset where it was. */
const blank = (text, re) => text.replace(re, m => ' '.repeat(m.length));

/**
 * The figures in a piece of text: [{ v, raw, start, end }], v being the comparable value.
 * Not figures: list markers ("1. "), numbers glued into names ("Llama3-8b", "yolov8", "#12"),
 * version and address strings ("2.4.1", "10.0.0.1"), anything inside a link, a path, a
 * file name or an identifier, and labels ("step 2").
 */
function figuresIn(text) {
    let t = String(text || '');
    t = blank(t, /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi);                 // links
    t = blank(t, /\S*[A-Za-z_]\S*[\/\\]\S*|\S*[\/\\]\S*[A-Za-z_]\S*/g); // paths with letters
    t = blank(t, /\S*_\S*|\S+@\S+|`[^`\n]*`/g);                      // identifiers, addresses, code
    t = blank(t, /\b[\w-]+\.(?:[a-z]{1,5})\b(?=\W|$)/gi);            // file names: run.py, v2.csv
    t = blank(t, /^[ \t]*(?:[-*+][ \t]+)?\d+[.)](?=[ \t])/gm);       // list markers
    const out = [];
    for (const m of t.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)*/g)) {
        const raw = m[0], start = m.index, end = start + raw.length;
        const before = t[start - 1] || '', after = t.slice(end);
        if (/[\p{L}\p{N}_#.]/u.test(before)) continue;                       // glued after a name
        if (/^\.\d/.test(after)) continue;
        if ((raw.match(/\./g) || []).length > 1) continue;                  // version, address
        const glued = after.match(/^[\p{L}°%]+/u);
        if (glued && !UNITS.has(glued[0].toLowerCase())) continue;          // part of a name
        if (LABELS.test(t.slice(Math.max(0, start - 14), start))) continue;
        const n = Number(raw.replace(/,/g, ''));
        if (!Number.isFinite(n)) continue;
        out.push({ v: String(n), raw, start, end });
    }
    return out;
}

/** The distinct values in a piece of text, for a quick set. */
const valuesIn = text => new Set(figuresIn(text).map(f => f.v));

/**
 * The figures a tool result held, for the reply's record: [{ v, ctx }] — each value once,
 * with a few words around where it first appeared. Read from the result's STRING values (so
 * a JSON key's line counts and lengths do not count as figures the model was shown); a
 * result cut short mid-JSON is read for its string literals instead.
 */
function toolFigures(content, { max = 300, around = 28 } = {}) {
    const strings = [];
    try {
        (function walk(x) {
            if (typeof x === 'string') strings.push(x);
            else if (Array.isArray(x)) x.forEach(walk);
            else if (x && typeof x === 'object') Object.values(x).forEach(walk);
        })(JSON.parse(content));
    } catch {
        // A literal followed by ":" is a key; the last one may have lost its closing quote.
        const raw = String(content || '');
        for (const m of raw.matchAll(/"((?:[^"\\]|\\.)*)"?/g)) {
            if (/^\s*:/.test(raw.slice(m.index + m[0].length))) continue;
            strings.push(m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
        }
    }
    const seen = new Map();
    for (const s of strings) {
        for (const f of figuresIn(s)) {
            if (seen.has(f.v)) continue;
            const ctx = s.slice(Math.max(0, f.start - around), f.end + around).replace(/\s+/g, ' ').trim();
            seen.set(f.v, { v: f.v, ctx });
            if (seen.size >= max) return [...seen.values()];
        }
    }
    return [...seen.values()];
}

const api = Object.freeze({ figuresIn, valuesIn, toolFigures });
if (typeof module === 'object' && module.exports) module.exports = api;
else root.AirlockFigures = api;
})(typeof window !== 'undefined' ? window : globalThis);
