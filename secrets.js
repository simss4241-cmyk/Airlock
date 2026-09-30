// One file, two places: required by boundary.js on the server, and served to the page as
// /secrets.js so a message dragged or copied OUT of Airlock is checked in the same instant,
// by the same rules. A drag has to hand over its text synchronously — it cannot wait for
// the gate model — but it can run these patterns. Wrapped so neither place leaks globals.
(function (root) {
'use strict';

// ─────────────────────── The secret scanner ───────────────────────
//
// Deterministic patterns in front of the gate model. It exists because the bench
// (tools/gate_bench.js) measured the default gate — the smallest local model, chosen so
// that every machine can run it — releasing about half of what it should withhold, and
// most of those were CREDENTIALS: tokens, keys, passwords in connection strings. Those have
// published, fixed formats. A regex recognises them every time, in microseconds, on any
// machine; a 4B model recognises them when it happens to.
//
// So this is not a replacement for the gate. It is the part of the gate's job that should
// never have been a judgement:
//
//   - It can only WITHHOLD. A clean scan means "no known format found", never "safe" — the
//     model still rules on everything the scanner passes. Nothing here can release.
//   - Its patterns come from the formats providers document (and from the rules secret
//     scanners like gitleaks ship), NOT from the bench's test cases. Patterns fitted to the
//     test set would score well on it and prove nothing.
//   - Medical details, a memo marked confidential, someone's home address — anything that
//     needs reading rather than matching — stays with the model. Only formats go here.
//
// Every rule errs toward specificity. A scanner that withholds a SHA-256 hash or a UUID
// trains people to override the gate, and an overridden gate protects nothing.

/**
 * A value that is standing in for a secret rather than being one: the documentation's
 * own examples, template syntax, redaction marks. Checked on the matched value only.
 */
const PLACEHOLDER = /example|your[-_ ]?(?:key|token|secret|password|api)|x{5,}|\*{3,}|<[^>]*>|\$\{|^\$[A-Za-z_]|redacted|changeme|placeholder|dummy|\.\.\./i;

/** For the generic assignment rules: a value that looks like code, not a literal. */
const CODE_LIKE = /[()[\]{};]|^(?:null|none|true|false|undefined|process\.env|os\.environ|getenv)/i;

/** The Luhn checksum every payment card number satisfies. */
function luhn(digits) {
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
        let d = +digits[digits.length - 1 - i];
        if (i % 2) { d *= 2; if (d > 9) d -= 9; }
        sum += d;
    }
    return sum % 10 === 0;
}

/**
 * Each rule: what it is called to a person, the pattern, and optionally which capture
 * group is the secret (default: the whole match) and a final check on that value.
 */
const RULES = [
    // ── key material ──
    { id: 'private-key', label: 'a private key',
      re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g },

    // ── cloud and platform credentials, by documented prefix ──
    { id: 'aws-access-key', label: 'an AWS access key id',
      re: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/g },
    { id: 'aws-secret-key', label: 'an AWS secret access key',
      re: /aws_?secret_?access_?key["']?\s*[:=]?\s*["']?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/gi, group: 1 },
    { id: 'github-token', label: 'a GitHub token',
      re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{82}\b/g },
    { id: 'gitlab-token', label: 'a GitLab token',
      re: /\bglpat-[A-Za-z0-9_-]{20}\b/g },
    { id: 'slack-token', label: 'a Slack token',
      re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
    { id: 'slack-webhook', label: 'a Slack webhook URL',
      re: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,}/g },
    { id: 'stripe-key', label: 'a Stripe secret key',
      re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
    { id: 'google-api-key', label: 'a Google API key',
      re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
    { id: 'anthropic-key', label: 'an Anthropic API key',
      re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
    { id: 'openai-key', label: 'an OpenAI-style secret key',
      re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
    { id: 'jwt', label: 'a signed token (JWT)',
      re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },

    // ── a password written into a URL: scheme://user:PASSWORD@host ──
    { id: 'url-credentials', label: 'a password inside a connection URL',
      re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:([^\s@/]+)@[^\s/]+/gi, group: 1,
      check: v => !CODE_LIKE.test(v) },

    // ── assignments: an env file line, or a quoted literal given to a secret-named key ──
    { id: 'env-secret', label: 'a secret assigned in an environment file',
      re: /^[ \t]*(?:export[ \t]+)?[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY)[A-Z0-9_]*[ \t]*=[ \t]*["']?([^\s"'#]{8,})/gm,
      group: 1, check: v => !CODE_LIKE.test(v) },
    { id: 'quoted-secret', label: 'a secret assigned as a string',
      re: /["']?\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["']([^"'\s]{8,})["']/gi,
      group: 1, check: v => !CODE_LIKE.test(v) },

    // ── personal identifiers with a checkable format ──
    { id: 'payment-card', label: 'a payment card number',
      re: /\b(?:\d[ -]?){12,18}\d\b/g,
      check: v => {
          const d = v.replace(/[ -]/g, '');
          return /^(?:4|5[1-5]|2[2-7]|3[47]|6(?:011|5))/.test(d) && d.length >= 13 && d.length <= 19 && luhn(d);
      } },
    { id: 'us-ssn', label: 'a US Social Security number',
      re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g }
];

/** Enough of a secret to recognise it in the UI, never enough to use it. */
function preview(value) {
    const v = String(value);
    if (v.length <= 8) return '•'.repeat(v.length);
    return `${v.slice(0, 4)}…${v.slice(-2)}`;
}

/**
 * Every known secret format found in `text`.
 *
 * Returns [{ rule, label, preview, index }], leftmost first, one entry per span — where two
 * rules claim overlapping text (an Anthropic key is also shaped like an OpenAI one), the
 * earlier rule in RULES wins, which is why the specific ones come first.
 */
function scan(text) {
    const source = String(text || '');
    const found = [];

    for (const rule of RULES) {
        rule.re.lastIndex = 0;
        for (const m of source.matchAll(rule.re)) {
            const value = rule.group ? m[rule.group] : m[0];
            if (!value || PLACEHOLDER.test(value)) continue;
            if (rule.check && !rule.check(value)) continue;

            const start = rule.group ? m.index + m[0].indexOf(value) : m.index;
            const end = start + value.length;
            if (found.some(f => start < f.end && end > f.start)) continue;

            found.push({ rule: rule.id, label: rule.label, preview: preview(value), index: start, start, end });
        }
    }

    return found
        .sort((a, b) => a.start - b.start)
        .map(({ start, end, ...hit }) => hit);
}

/**
 * The scanner's ruling, in the gate's own shape — or null when it found nothing and the
 * decision belongs to the model.
 */
function rule(text) {
    const hits = scan(text);
    if (!hits.length) return null;

    const kinds = [...new Set(hits.map(h => h.label))];
    return {
        release: false,
        reason: `This contains ${kinds.join(', ')}, so nothing was sent. The secret scanner `
            + 'recognises known credential formats before the gate model reads anything, and '
            + 'it does not weigh them — a key is a key.',
        concerns: hits.map(h => `${h.label} (${h.preview})`),
        model: null,              // no model ruled
        ruledBy: 'secret scanner',
        scanner: hits.map(h => h.rule)
    };
}

// Frozen, rules included: the page must not be able to empty the list it checks against.
for (const r of RULES) Object.freeze(r);
Object.freeze(RULES);

const api = { scan, rule, RULES, PLACEHOLDER };
if (typeof module === 'object' && module.exports) module.exports = api;
else root.AirlockSecrets = Object.freeze(api);
})(typeof window !== 'undefined' ? window : globalThis);
