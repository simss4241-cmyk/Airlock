// The calculator a participant can call, and the rules for reading its result. Served to the
// page (window.AirlockCalc) and required by the server and the tests — one definition of what
// it computes and how a result is written, so the record and the page cannot disagree.
//
// Why it exists: small models are poor at arithmetic, and the figure marks could only call a
// worked-out number "new in this reply" — right or invented, you could not tell. A number the
// calculator produced carries its working on the record: what was computed, from which
// numbers, and where those numbers came from. It is a parser, never eval: numbers, operators,
// brackets and a short list of functions, and anything else is refused.
(function (root) {
'use strict';

const MAX_LENGTH = 200;
const MAX_DEPTH = 30;

const FUNCTIONS = {
    sqrt: { n: [1, 1], f: x => Math.sqrt(x) },
    abs: { n: [1, 1], f: x => Math.abs(x) },
    round: { n: [1, 2], f: (x, d = 0) => { const k = 10 ** Math.trunc(d); return Math.round(x * k) / k; } },
    floor: { n: [1, 1], f: x => Math.floor(x) },
    ceil: { n: [1, 1], f: x => Math.ceil(x) },
    min: { n: [1, 20], f: (...xs) => Math.min(...xs) },
    max: { n: [1, 20], f: (...xs) => Math.max(...xs) },
    pow: { n: [2, 2], f: (x, y) => x ** y },
    ln: { n: [1, 1], f: x => Math.log(x) },
    log10: { n: [1, 1], f: x => Math.log10(x) },
    exp: { n: [1, 1], f: x => Math.exp(x) }
};
const CONSTANTS = { pi: Math.PI, e: Math.E };

/** One way of writing a result: twelve significant digits, so 0.1 + 0.2 is 0.3. */
const format = n => String(Number(Number(n).toPrecision(12)));

function tokenize(text) {
    const src = String(text || '')
        .replace(/[×✕]/g, '*').replace(/÷/g, '/').replace(/[−–]/g, '-').replace(/\*\*/g, '^');
    if (!src.trim()) throw new Error('An expression is needed, such as 480 + 480.');
    if (src.length > MAX_LENGTH) throw new Error(`That expression is longer than ${MAX_LENGTH} characters.`);
    const tokens = [];
    const re = /\s*(?:(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+)|([a-zA-Z][a-zA-Z0-9]*)|([-+*/^(),]))/y;
    let at = 0;
    while (at < src.length) {
        re.lastIndex = at;
        const m = re.exec(src);
        if (!m) {
            if (!src.slice(at).trim()) break;
            const ch = src.slice(at).trim()[0];
            throw new Error(ch === ',' || /\d,\d/.test(src) ? 'Write numbers without thousands separators: 1000, not 1,000.'
                : `"${ch}" is not something the calculator understands.`);
        }
        if (m[1] !== undefined) tokens.push({ t: 'num', v: m[1] });
        else if (m[2] !== undefined) tokens.push({ t: 'name', v: m[2].toLowerCase() });
        else tokens.push({ t: m[3] });
        at = re.lastIndex;
    }
    return tokens;
}

/**
 * Evaluate an expression. Returns { value, result, inputs } — result written by format(),
 * inputs the numbers it was given, in order, as written. Throws a plain-English Error.
 */
function evaluate(expression) {
    const tokens = tokenize(expression);
    const inputs = [];
    let i = 0, depth = 0;
    const peek = () => tokens[i];
    const take = t => { if (peek()?.t !== t) throw new Error(`Expected "${t}"${peek() ? ` before "${peek().v ?? peek().t}"` : ' at the end'}.`); return tokens[i++]; };
    const deeper = () => { if (++depth > MAX_DEPTH) throw new Error('That expression is nested too deeply.'); };

    function expr() {
        deeper();
        let v = term();
        while (peek()?.t === '+' || peek()?.t === '-') v = tokens[i++].t === '+' ? v + term() : v - term();
        depth--;
        return v;
    }
    function term() {
        let v = unary();
        while (peek()?.t === '*' || peek()?.t === '/') {
            const op = tokens[i++].t, r = unary();
            if (op === '/' && r === 0) throw new Error('Division by zero.');
            v = op === '*' ? v * r : v / r;
        }
        return v;
    }
    function unary() {
        if (peek()?.t === '-') { i++; deeper(); const v = -unary(); depth--; return v; }
        if (peek()?.t === '+') { i++; return unary(); }
        return power();
    }
    function power() {
        const base = primary();
        if (peek()?.t === '^') { i++; return base ** unary(); }
        return base;
    }
    function primary() {
        const tok = peek();
        if (!tok) throw new Error('The expression ends too soon.');
        if (tok.t === 'num') { i++; inputs.push(tok.v); return Number(tok.v); }
        if (tok.t === '(') { i++; const v = expr(); take(')'); return v; }
        if (tok.t === 'name') {
            i++;
            if (Object.hasOwn(CONSTANTS, tok.v) && peek()?.t !== '(') return CONSTANTS[tok.v];
            if (!Object.hasOwn(FUNCTIONS, tok.v)) throw new Error(`Unknown name "${tok.v}". Known: ${Object.keys(FUNCTIONS).join(', ')}, pi, e.`);
            const fn = FUNCTIONS[tok.v];
            take('(');
            const args = [];
            if (peek()?.t !== ')') { args.push(expr()); while (peek()?.t === ',') { i++; args.push(expr()); } }
            take(')');
            if (args.length < fn.n[0] || args.length > fn.n[1]) throw new Error(`${tok.v} takes ${fn.n[0] === fn.n[1] ? fn.n[0] : `${fn.n[0]} to ${fn.n[1]}`} argument${fn.n[1] > 1 ? 's' : ''}.`);
            return fn.f(...args);
        }
        throw new Error(`Unexpected "${tok.t}".`);
    }

    const value = expr();
    if (i < tokens.length) throw new Error(`Unexpected "${tokens[i].v ?? tokens[i].t}" — is an operator missing?`);
    if (!Number.isFinite(value)) throw new Error('The result is not a finite number.');
    return { value, result: format(value), inputs };
}

// ─────────────────────────── units ───────────────────────────

/** Each unit: its kind and how many base units one of it is (temperature is special). */
const UNITS = {
    // pressure (Pa)
    pa: ['pressure', 1], hpa: ['pressure', 100], kpa: ['pressure', 1e3], mpa: ['pressure', 1e6],
    bar: ['pressure', 1e5], mbar: ['pressure', 100], psi: ['pressure', 6894.757293168], atm: ['pressure', 101325],
    // length (m)
    mm: ['length', 1e-3], cm: ['length', 1e-2], m: ['length', 1], km: ['length', 1e3],
    in: ['length', 0.0254], ft: ['length', 0.3048], yd: ['length', 0.9144], mi: ['length', 1609.344],
    // mass (kg)
    mg: ['mass', 1e-6], g: ['mass', 1e-3], kg: ['mass', 1], t: ['mass', 1e3], oz: ['mass', 0.028349523125], lb: ['mass', 0.45359237],
    // time (s)
    ms: ['time', 1e-3], s: ['time', 1], min: ['time', 60], h: ['time', 3600], day: ['time', 86400],
    // volume (L)
    ml: ['volume', 1e-3], l: ['volume', 1], gal: ['volume', 3.785411784],
    // speed (m/s)
    'm/s': ['speed', 1], 'km/h': ['speed', 1 / 3.6], mph: ['speed', 0.44704], kn: ['speed', 0.514444444],
    // data (bytes)
    b: ['data', 1], kb: ['data', 1e3], mb: ['data', 1e6], gb: ['data', 1e9], tb: ['data', 1e12],
    // temperature
    c: ['temperature'], f: ['temperature'], k: ['temperature']
};
const ALIASES = { '°c': 'c', '°f': 'f', celsius: 'c', fahrenheit: 'f', kelvin: 'k', kmh: 'km/h', kph: 'km/h',
    sec: 's', secs: 's', hr: 'h', hrs: 'h', mins: 'min', days: 'day', miles: 'mi', mile: 'mi', feet: 'ft', foot: 'ft',
    inch: 'in', inches: 'in', litre: 'l', liter: 'l', litres: 'l', liters: 'l', lbs: 'lb', pound: 'lb', pounds: 'lb',
    kilogram: 'kg', kilograms: 'kg', gram: 'g', grams: 'g', bytes: 'b' };
const unitOf = u => { const k = String(u || '').trim().toLowerCase(); return ALIASES[k] || k; };

/** Convert one value between units of the same kind. Returns { value, result, inputs, from, to }. */
function convert(value, from, to) {
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(n)) throw new Error('A number is needed to convert.');
    const a = unitOf(from), b = unitOf(to);
    if (!UNITS[a]) throw new Error(`Unknown unit "${from}".`);
    if (!UNITS[b]) throw new Error(`Unknown unit "${to}".`);
    if (UNITS[a][0] !== UNITS[b][0]) throw new Error(`Cannot convert ${UNITS[a][0]} (${from}) to ${UNITS[b][0]} (${to}).`);
    let out;
    if (UNITS[a][0] === 'temperature') {
        const kelvin = a === 'c' ? n + 273.15 : a === 'f' ? (n - 32) * 5 / 9 + 273.15 : n;
        out = b === 'c' ? kelvin - 273.15 : b === 'f' ? (kelvin - 273.15) * 9 / 5 + 32 : kelvin;
    } else {
        out = n * UNITS[a][1] / UNITS[b][1];
    }
    return { value: out, result: format(out), inputs: [String(value).trim()], from: a, to: b };
}

// ─────────────────────────── as tools ───────────────────────────

const TOOLS = [
    { type: 'function', function: {
        name: 'calculate',
        description: 'Compute arithmetic exactly instead of doing it in your head: + - * / ^, brackets, '
            + 'and sqrt, abs, round(x, digits), floor, ceil, min, max, pow, ln, log10, exp, pi. '
            + 'Use it for any sum, product, average or percentage you report. Plain numbers only, no units.',
        parameters: { type: 'object', properties: {
            expression: { type: 'string', description: 'For example: (480 + 455) / 2' }
        }, required: ['expression'] }
    } },
    { type: 'function', function: {
        name: 'convert',
        description: 'Convert a value between units of the same kind: pressure (Pa, kPa, MPa, bar, psi, atm), '
            + 'length (mm, cm, m, km, in, ft, yd, mi), mass (mg, g, kg, t, oz, lb), time (ms, s, min, h, day), '
            + 'volume (ml, l, gal), speed (m/s, km/h, mph, kn), data (b, kb, mb, gb, tb), temperature (C, F, K).',
        parameters: { type: 'object', properties: {
            value: { type: 'number' }, from: { type: 'string' }, to: { type: 'string' }
        }, required: ['value', 'from', 'to'] }
    } }
];
const NAMES = new Set(TOOLS.map(t => t.function.name));

/**
 * Run one call. Returns { ok, result, error, summary, calc } — calc is what the record keeps:
 * the working, the result as written, and the numbers it was computed from.
 */
function run(name, args = {}) {
    try {
        if (name === 'calculate') {
            const expression = String(args.expression ?? '').trim();
            const r = evaluate(expression);
            return { ok: true, result: r.result, summary: `${expression} = ${r.result}`,
                calc: { expression, result: r.result, inputs: r.inputs } };
        }
        if (name === 'convert') {
            const r = convert(args.value, args.from, args.to);
            const expression = `${r.inputs[0]} ${args.from} → ${args.to}`;
            return { ok: true, result: r.result, summary: `${r.inputs[0]} ${args.from} = ${r.result} ${args.to}`,
                calc: { expression, result: r.result, inputs: r.inputs } };
        }
        return { ok: false, error: `Unknown tool ${name}.`, summary: `${name} — unknown` };
    } catch (err) {
        return { ok: false, error: err.message, summary: `${name} failed — ${err.message}` };
    }
}

const api = Object.freeze({ evaluate, convert, format, run, TOOLS, NAMES });
if (typeof module === 'object' && module.exports) module.exports = api;
else root.AirlockCalc = api;
})(typeof window !== 'undefined' ? window : globalThis);
