/**
 * PII and secret redaction.
 *
 * Two different jobs, deliberately separated, because the right answer differs:
 *
 *   Secrets  - a plaintext password in a ticket body is a liability the moment
 *              it is written. Those are scrubbed AT REST, at intake, before the
 *              row is inserted. Nobody needs to read them and the requester
 *              should be told to change it anyway.
 *
 *   PII      - names, emails and phone numbers are the helpdesk's actual job.
 *              Scrubbing them from the database would break the product. They
 *              are redacted IN TRANSIT: before a body reaches a model, and
 *              before it is embedded into the knowledge base, where it would
 *              be retrieved into other people's prompts forever.
 *
 * What is deliberately NOT redacted: IP addresses, MAC addresses, hostnames,
 * asset tags and error codes. They look like PII to a naive regex and they are
 * the entire substance of an IT ticket. Redacting them produces a model call
 * that cannot answer the question.
 */

export type RedactionKind =
  | "email"
  | "phone"
  | "card"
  | "iban"
  | "national_id"
  | "secret";

export interface RedactionHit {
  kind: RedactionKind;
  count: number;
}

export interface RedactionResult {
  text: string;
  hits: RedactionHit[];
  /** True when anything was replaced. Worth surfacing in the UI. */
  redacted: boolean;
}

interface Rule {
  kind: RedactionKind;
  pattern: RegExp;
  /** Extra check to keep false positives out (Luhn, length, context). */
  accept?: (match: string) => boolean;
  replace: string;
}

// Secrets first: a credential inside a longer string should not be partially
// masked by a narrower rule that runs before it.
const SECRET_RULES: Rule[] = [
  {
    kind: "secret",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: "[redacted:private-key]",
  },
  {
    // Provider-issued keys with distinctive prefixes.
    kind: "secret",
    pattern: /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    replace: "[redacted:api-key]",
  },
  {
    kind: "secret",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi,
    replace: "[redacted:token]",
  },
  {
    // "my password is hunter2", "pwd: hunter2", "passcode = 1234".
    // Captures the label so the sentence still reads, masks only the value.
    kind: "secret",
    pattern:
      /\b(pass(?:word|code|phrase)|pwd|otp|mfa code|one[- ]time code)\b\s*(?:is|=|:|was)\s*["']?([^\s"',.;]{3,})["']?/gi,
    replace: "$1: [redacted:secret]",
  },
];

const PII_RULES: Rule[] = [
  {
    kind: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replace: "[redacted:email]",
  },
  {
    kind: "card",
    pattern: /\b(?:\d[ -]*?){13,19}\b/g,
    accept: (m) => luhn(m.replace(/\D/g, "")),
    replace: "[redacted:card]",
  },
  {
    kind: "iban",
    pattern: /\b[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9]{4}[ ]?){3,7}[A-Z0-9]{1,4}\b/g,
    replace: "[redacted:iban]",
  },
  {
    // UK National Insurance and US Social Security.
    kind: "national_id",
    pattern: /\b(?:[A-CEGHJ-PR-TW-Z]{2}[ ]?\d{2}[ ]?\d{2}[ ]?\d{2}[ ]?[A-D]|\d{3}-\d{2}-\d{4})\b/g,
    replace: "[redacted:national-id]",
  },
  {
    /**
     * Deliberately conservative, and the guards are the whole rule:
     *
     *   - separators are space or hyphen only, never a dot, so a Windows build
     *     number (22631.3155) and a semver are left alone;
     *   - the lookbehind rejects a group already preceded by another DIGIT
     *     group (not any word, or "ring 020 7946 0958" would be exempt), and
     *     the lookahead rejects one followed by another, so a 16-digit order
     *     number is not partly eaten as a phone number.
     *
     * The cost is that dotted international formats (+1 555.123.4567) are
     * missed. Under-redacting a phone number is a smaller failure than
     * mangling the error code the ticket is actually about.
     */
    kind: "phone",
    pattern:
      /(?<!\d[ -])(?<![\w.-])(?:\+\d{1,3}[ -]?)?(?:\(\d{2,5}\)[ -]?)?\d{3,5}[ -]\d{3,6}(?:[ -]\d{3,6})?(?![ -]?\d)/g,
    accept: (m) => {
      const digits = m.replace(/\D/g, "");
      return digits.length >= 9 && digits.length <= 15;
    },
    replace: "[redacted:phone]",
  },
];

function apply(text: string, rules: Rule[]): RedactionResult {
  const counts = new Map<RedactionKind, number>();
  let out = text;

  for (const rule of rules) {
    out = out.replace(rule.pattern, (...args) => {
      const match = String(args[0]);
      if (rule.accept && !rule.accept(match)) return match;
      counts.set(rule.kind, (counts.get(rule.kind) ?? 0) + 1);
      // Support $1/$2 backreferences in the replacement.
      return rule.replace.replace(/\$(\d)/g, (_m, d: string) => {
        const group = args[Number(d)];
        return typeof group === "string" ? group : "";
      });
    });
  }

  const hits = [...counts.entries()].map(([kind, count]) => ({ kind, count }));
  return { text: out, hits, redacted: hits.length > 0 };
}

/** Scrub credentials. Applied at intake, before the row is written. */
export function scrubSecrets(text: string): RedactionResult {
  return apply(text, SECRET_RULES);
}

/**
 * Full redaction for anything leaving the system: model calls, and knowledge
 * base writeback. Secrets go first so a key inside a sentence is masked as a
 * key rather than partly eaten by the phone rule.
 */
export function redactForModel(text: string): RedactionResult {
  const secrets = apply(text, SECRET_RULES);
  const pii = apply(secrets.text, PII_RULES);
  return {
    text: pii.text,
    hits: mergeHits(secrets.hits, pii.hits),
    redacted: secrets.redacted || pii.redacted,
  };
}

/** Recursively redact a JSON payload before it goes into the event log. */
export function redactPayload<T>(value: T): T {
  if (typeof value === "string") return redactForModel(value).text as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactPayload(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactPayload(v);
    return out as T;
  }
  return value;
}

function mergeHits(a: RedactionHit[], b: RedactionHit[]): RedactionHit[] {
  const m = new Map<RedactionKind, number>();
  for (const h of [...a, ...b]) m.set(h.kind, (m.get(h.kind) ?? 0) + h.count);
  return [...m.entries()].map(([kind, count]) => ({ kind, count }));
}

function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}
