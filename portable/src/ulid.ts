import { createHash, randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

function encode(bytes: Uint8Array): string {
  // 128 bits -> 26 Crockford base32 characters (first char carries 3 bits).
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < 26; i++) {
    out = ALPHABET[Number(value & 31n)]! + out;
    value >>= 5n;
  }
  return out;
}

/** Standard ULID (48-bit ms timestamp + 80 random bits). */
export function newUlid(nowMs: number = Date.now(), random: (n: number) => Uint8Array = randomBytes): string {
  const bytes = new Uint8Array(16);
  let t = BigInt(Math.max(0, Math.floor(nowMs)));
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(t & 0xffn);
    t >>= 8n;
  }
  bytes.set(random(10).subarray(0, 10), 6);
  return encode(bytes);
}

/**
 * Deterministic ULID-shaped identifier derived from a namespace + key (used by legacy adapters so the same
 * legacy reference always maps to the same portable id). The timestamp part is taken from `timeMs`.
 */
export function derivedUlid(namespace: string, key: string, timeMs: number): string {
  const digest = createHash("sha256").update(`${namespace}\u0000${key}`, "utf8").digest();
  return newUlid(timeMs, () => digest.subarray(0, 10));
}
