/**
 * API key tokens, request signatures and IP allow-lists. Pure functions; no I/O.
 *
 * Token: `rpk_<prefix:12>_<secret:40>` over a 32-symbol alphabet without look-alikes (≈ 200 bits of secret).
 * Only `hashToken(token)` is stored; the prefix is the lookup key and is not secret.
 * Signature: `v1=<hex HMAC-SHA256(signingSecret, ts "\n" METHOD "\n" target "\n" body)>`, ±300 s.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"; // 31 symbols; no 0/1/i/l/o
const PREFIX_LEN = 12;
const SECRET_LEN = 40;
export const TOKEN_RE = /^rpk_([2-9a-hjkmnp-z]{12})_([2-9a-hjkmnp-z]{40})$/u;
export const SIGNATURE_WINDOW_SECONDS = 300;

function randomString(length: number): string {
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      // Rejection sampling keeps the distribution uniform.
      if (byte < 248) out += ALPHABET[byte % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export function generateKeyToken(): { token: string; prefix: string } {
  const prefix = randomString(PREFIX_LEN);
  return { token: `rpk_${prefix}_${randomString(SECRET_LEN)}`, prefix };
}

export function generateSigningSecret(): string {
  return `rps_${randomBytes(32).toString("base64url")}`;
}

/** Parses `Authorization: Bearer rpk_…`; returns null for anything else (never throws). */
export function parseBearer(header: string | undefined): { token: string; prefix: string } | null {
  if (!header || header.length > 200) return null;
  const match = /^Bearer ([^\s]+)$/u.exec(header);
  if (!match) return null;
  const parsed = TOKEN_RE.exec(match[1]!);
  return parsed ? { token: match[1]!, prefix: parsed[1]! } : null;
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function signatureBase(timestamp: string, method: string, target: string, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${timestamp}\n${method.toUpperCase()}\n${target}\n`, "utf8"), body]);
}

export function computeSignature(secret: string, timestamp: string, method: string, target: string, body: Buffer): string {
  return `v1=${createHmac("sha256", secret).update(signatureBase(timestamp, method, target, body)).digest("hex")}`;
}

export type SignatureCheck = { ok: true; signatureHash: string } | { ok: false; reason: "SIGNATURE_MISSING" | "SIGNATURE_STALE" | "SIGNATURE_INVALID" };

export function verifySignature(input: {
  secret: string;
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
  method: string;
  target: string;
  body: Buffer;
  nowSeconds: number;
}): SignatureCheck {
  const { timestampHeader: ts, signatureHeader: sig } = input;
  if (!ts || !sig) return { ok: false, reason: "SIGNATURE_MISSING" };
  if (!/^\d{1,12}$/u.test(ts)) return { ok: false, reason: "SIGNATURE_STALE" };
  if (Math.abs(input.nowSeconds - Number(ts)) > SIGNATURE_WINDOW_SECONDS) return { ok: false, reason: "SIGNATURE_STALE" };
  if (!/^v1=[0-9a-f]{64}$/u.test(sig)) return { ok: false, reason: "SIGNATURE_INVALID" };
  const expected = Buffer.from(computeSignature(input.secret, ts, input.method, input.target, input.body), "utf8");
  const given = Buffer.from(sig, "utf8");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "SIGNATURE_INVALID" };
  return { ok: true, signatureHash: sha256Hex(sig) };
}

/* ------------------------------------------------------------------------------- IP allow-lists */

function ipv4ToBigInt(ip: string): bigint {
  return ip.split(".").reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);
}

function ipv6ToBigInt(ip: string): bigint {
  let address = ip.toLowerCase();
  // Embedded IPv4 tail.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/u.exec(address);
  if (v4) {
    const n = ipv4ToBigInt(v4[1]!);
    address = address.slice(0, -v4[1]!.length) + `${((n >> 16n) & 0xffffn).toString(16)}:${(n & 0xffffn).toString(16)}`;
  }
  const [head, tail] = address.split("::") as [string, string | undefined];
  const headParts = head ? head.split(":") : [];
  const tailParts = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const missing = 8 - headParts.length - tailParts.length;
  const parts = [...headParts, ...(tail !== undefined ? Array<string>(missing).fill("0") : []), ...tailParts];
  return parts.reduce((acc, part) => (acc << 16n) | BigInt(Number.parseInt(part || "0", 16)), 0n);
}

interface ParsedAddress {
  family: 4 | 6;
  value: bigint;
}

function parseAddress(ip: string): ParsedAddress | null {
  const family = isIP(ip);
  if (family === 4) return { family: 4, value: ipv4ToBigInt(ip) };
  if (family === 6) {
    const value = ipv6ToBigInt(ip);
    // IPv4-mapped IPv6 → IPv4.
    if (value >> 32n === 0xffffn) return { family: 4, value: value & 0xffffffffn };
    return { family: 6, value };
  }
  return null;
}

/** Normalises and validates one allow-list entry (`IP` or `IP/prefix`); null when invalid. */
export function normaliseCidr(entry: string): string | null {
  const trimmed = entry.trim();
  if (trimmed.length > 64) return null;
  const [ip, bits, extra] = trimmed.split("/");
  if (!ip || extra !== undefined) return null;
  const address = parseAddress(ip);
  if (!address) return null;
  const max = address.family === 4 ? 32 : 128;
  const prefix = bits === undefined ? max : /^\d{1,3}$/u.test(bits) ? Number(bits) : Number.NaN;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  return `${ip.toLowerCase()}/${prefix}`;
}

export function ipAllowed(ip: string | undefined, allowList: readonly string[]): boolean {
  if (allowList.length === 0) return true;
  if (!ip) return false;
  const address = parseAddress(ip);
  if (!address) return false;
  return allowList.some((entry) => {
    const [base, bits] = entry.split("/");
    const network = base ? parseAddress(base) : null;
    if (!network || network.family !== address.family) return false;
    const width = address.family === 4 ? 32n : 128n;
    const prefix = BigInt(Number(bits));
    const shift = width - prefix;
    return address.value >> shift === network.value >> shift;
  });
}
