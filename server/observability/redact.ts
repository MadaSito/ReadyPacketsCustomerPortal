/**
 * Redaction and log-injection neutralisation shared by the operational logger and the audit envelope
 * validator. Owner: audit engineer.
 *
 * Two layers (OWASP Logging Cheat Sheet):
 *  1. KEY-based: any key whose name suggests secret material is replaced wholesale.
 *  2. VALUE-based: string values are scanned for secret-shaped content (JWTs, bearer/basic credentials,
 *     PEM blocks, credentials embedded in URLs/connection strings, long random tokens, card numbers,
 *     e-mail addresses) and the matching span is replaced.
 * Control characters (CR/LF/U+2028/U+2029/ESC/C0/C1) are neutralised so a value cannot forge a log line.
 */

/** Key names whose values are never emitted. `sessionId`/`sessionRef` (public identifiers) are allowed. */
const PROMOTION_CODE_FIELD = String.raw`(?:promo(?:tion(?:al)?)?|discount|coupon|voucher)[ _-]*codes?(?:[ _-]*(?:raw|value|plaintext|ciphertext|enc|encrypted))?`;
// Keep public IDs and labels searchable, and leave generic `code` available for diagnostic codes.
const PROMOTION_CODE_KEY = new RegExp(`^promo$|${PROMOTION_CODE_FIELD}$`, "i");
export const SENSITIVE_KEY = new RegExp(
  String.raw`pass(word|phrase|wd)?|secret|token|cookie|authori[sz]ation|^auth$|otp|totp|mfa_?code|recovery|credential|private|signature|api_?key|apikey|session(?!_?(id|ref|count)s?$)|csrf|bearer|salt|seed|dsn|connection_?string|database_?url|iban|card_?number|ssn|${PROMOTION_CODE_KEY.source}`,
  "i",
);

const PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: "pem", re: /-----BEGIN [A-Z ]+-----[\s\S]*?(-----END [A-Z ]+-----|$)/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g },
  { name: "bearer", re: /\b(Bearer|Basic|Digest)\s+[A-Za-z0-9._~+/=-]{6,}/gi },
  { name: "url-credentials", re: /\b([a-z][a-z0-9+.-]{1,15}:\/\/)[^\s:/@]+:[^\s@/]+@/gi },
  { name: "kv-secret", re: /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[=:]\s*[^\s&;,]+/gi },
  { name: "promotion-code", re: new RegExp(String.raw`\b(?:promo|(?:raw[ _-]*)?${PROMOTION_CODE_FIELD})["']?\s*[=:]\s*["']?[A-Z0-9%_-]+`, "gi") },
  { name: "encrypted-envelope", re: /\brpenc:v\d+:[A-Za-z0-9:_+/=-]+/g },
  { name: "email", re: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/g },
  { name: "card", re: /\b(?:\d[ -]?){13,19}\b/g },
  // Long unbroken base64/base64url/hex runs look like secrets or tokens. 40+ chars.
  { name: "long-token", re: /\b[A-Za-z0-9+/_-]{40,}={0,2}/g },
];

// eslint-disable-next-line no-control-regex -- deliberately matching control characters to neutralise them
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/g;
const NEWLINES = /[\r\n\t]/g;

/** Replace CR/LF/TAB with a visible escape and drop other control characters. */
export function neutraliseControl(value: string): string {
  return value
    .replace(NEWLINES, (char) => (char === "\n" ? "\\n" : char === "\r" ? "\\r" : "\\t"))
    .replace(CONTROL, "\uFFFD");
}

export interface ScanResult {
  value: string;
  /** Pattern names that matched (for counting, never the matched text). */
  hits: string[];
}

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Scan a string for secret-shaped content and replace each match with `[redacted:<kind>]`. */
export function scanValue(input: string, options: { allowEmail?: boolean } = {}): ScanResult {
  const hits: string[] = [];
  let value = input;
  for (const { name, re } of PATTERNS) {
    if (name === "email" && options.allowEmail) continue;
    re.lastIndex = 0;
    value = value.replace(re, (match, ...groups) => {
      if (name === "card") {
        const digits = match.replace(/[ -]/g, "");
        if (digits.length < 13 || !luhn(digits)) return match;
      }
      hits.push(name);
      if (name === "url-credentials") return `${String(groups[0])}[redacted:credentials]@`;
      return `[redacted:${name}]`;
    });
  }
  return { value, hits };
}

export interface RedactOptions {
  maxDepth?: number;
  maxKeys?: number;
  maxArray?: number;
  maxString?: number;
  allowEmail?: boolean;
  /** Include error stacks (only for non-production debug logging). */
  includeStacks?: boolean;
}

const DEFAULTS: Required<RedactOptions> = {
  maxDepth: 5,
  maxKeys: 60,
  maxArray: 50,
  maxString: 1024,
  allowEmail: false,
  includeStacks: false,
};

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[truncated ${value.length - max}]`;
}

export function safeString(value: string, options: RedactOptions = {}): string {
  const o = { ...DEFAULTS, ...options };
  // Scan first (patterns may span newlines, e.g. PEM), then neutralise control chars, then bound.
  return truncate(neutraliseControl(scanValue(value, { allowEmail: o.allowEmail }).value), o.maxString);
}

/** Error serialisation: name + safe codes. Message/stack only when explicitly allowed and always scanned. */
export function serialiseError(error: Error, options: RedactOptions = {}): Record<string, unknown> {
  const o = { ...DEFAULTS, ...options };
  const out: Record<string, unknown> = { error_name: neutraliseControl(error.name).slice(0, 64) };
  const anyError = error as Error & { code?: unknown; reasonCode?: unknown; errno?: unknown };
  if (typeof anyError.code === "string" && /^[A-Z_][A-Z0-9_]{0,63}$/.test(anyError.code)) out.error_code = anyError.code;
  if (typeof anyError.reasonCode === "string" && /^[A-Z_][A-Z0-9_]{0,63}$/.test(anyError.reasonCode)) out.reason_code = anyError.reasonCode;
  if (typeof anyError.errno === "number") out.errno = anyError.errno;
  if (o.includeStacks) {
    out.error_message = safeString(error.message, { ...o, maxString: 512 });
    if (error.stack) out.error_stack = safeString(error.stack, { ...o, maxString: 4096 });
  }
  return out;
}

/** Deep, bounded redaction producing JSON-safe data. Never invokes getters on class instances other than Error/Date. */
export function redact(value: unknown, options: RedactOptions = {}, depth = 0, seen = new WeakSet<object>()): unknown {
  const o = { ...DEFAULTS, ...options };
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return safeString(value, o);
  if (typeof value === "function" || typeof value === "symbol") return "[unsupported]";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "invalid-date" : value.toISOString();
  if (value instanceof Error) return serialiseError(value, o);
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return `[binary ${(value as ArrayBufferView).byteLength} bytes]`;
  if (typeof value !== "object") return "[unsupported]";
  if (seen.has(value)) return "[circular]";
  if (depth >= o.maxDepth) return "[depth-limit]";
  seen.add(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, o.maxArray).map((item) => redact(item, o, depth + 1, seen));
    if (value.length > o.maxArray) items.push(`[+${value.length - o.maxArray} items]`);
    return items;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) return `[object ${neutraliseControl(value.constructor?.name ?? "Object").slice(0, 40)}]`;
  const out: Record<string, unknown> = {};
  const entries = Object.keys(value);
  for (const key of entries.slice(0, o.maxKeys)) {
    const safeKey = neutraliseControl(key).slice(0, 64);
    out[safeKey] = SENSITIVE_KEY.test(key) ? "[redacted]" : redact((value as Record<string, unknown>)[key], o, depth + 1, seen);
  }
  if (entries.length > o.maxKeys) out["_truncated_keys"] = entries.length - o.maxKeys;
  return out;
}
