/**
 * Hard exclusion scanner. Applied by the WRITER (refuse to write) and re-applied by the VERIFIER (package
 * fails). Matches secret-bearing key names at any depth and secret-shaped values.
 */
const KEY_SUBSTRINGS = [
  "password",
  "passwd",
  "passphrase",
  "secret",
  "token",
  "totp",
  "hotp",
  "otpauth",
  "mfaseed",
  "mfakey",
  "recoverycode",
  "backupcode",
  "sessionid",
  "sessionkey",
  "saml",
  "apikey",
  "privatekey",
  "encryptionkey",
  "storagekey",
  "objectkey",
  "chainkey",
  "hmackey",
  "signingkey",
  "credential",
  "keymaterial",
  "webauthn",
  "passkey",
];
const KEY_EXACT = new Set(["session", "sessions", "cookie", "cookies", "dek", "kek", "jwt", "salt", "pin"]);

const VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, "private-key"],
  [/^\$argon2(id|i|d)\$/, "password-hash"],
  [/^\$2[abxy]\$\d\d\$/, "password-hash"],
  [/^\$(scrypt|pbkdf2[a-z0-9-]*)\$/, "password-hash"],
  [/^otpauth:\/\//i, "mfa-secret"],
  [/^eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+$/, "token"],
];

export interface ExclusionHit {
  path: string;
  kind: "key" | "value";
  category: string;
}

export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isExcludedKey(key: string): boolean {
  const k = normalizeKey(key);
  return KEY_EXACT.has(k) || KEY_SUBSTRINGS.some((s) => k.includes(s));
}

/** Returns the first hits (bounded) — paths are JSON-pointer-like and contain only key names, never values. */
export function scanExclusions(value: unknown, max = 5): ExclusionHit[] {
  const hits: ExclusionHit[] = [];
  const walk = (v: unknown, path: string, depth: number): void => {
    if (hits.length >= max || depth > 64) return;
    if (typeof v === "string") {
      for (const [re, category] of VALUE_PATTERNS) {
        if (re.test(v)) {
          hits.push({ path, kind: "value", category });
          return;
        }
      }
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${path}/${i}`, depth + 1));
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, child] of Object.entries(v)) {
        const safeKey = k.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
        if (isExcludedKey(k)) hits.push({ path: `${path}/${safeKey}`, kind: "key", category: "secret-field" });
        else walk(child, `${path}/${safeKey}`, depth + 1);
        if (hits.length >= max) return;
      }
    }
  };
  walk(value, "", 0);
  return hits;
}
