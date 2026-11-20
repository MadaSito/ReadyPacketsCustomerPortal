import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const ANONYMOUS_CSRF_MAX_AGE_MS = 15 * 60 * 1000;
const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ANONYMOUS_TOKEN = /^v1\.(\d{1,15})\.([A-Za-z0-9_-]{32})\.([A-Za-z0-9_-]{43})$/;

function hmac(key: string | Buffer, input: string): string {
  return createHmac("sha256", key).update(input).digest("base64url");
}

export function deriveSessionCsrfToken(sessionId: string, csrfSecret: string): string {
  return hmac(csrfSecret, `rp:csrf:session:v1\0${sessionId}`);
}

export function issueAnonymousCsrfToken(now: Date, key: Buffer): string {
  const expires = now.getTime() + ANONYMOUS_CSRF_MAX_AGE_MS;
  const body = `v1.${expires}.${randomBytes(24).toString("base64url")}`;
  return `${body}.${hmac(key, `rp:csrf:anonymous\0${body}`)}`;
}

export function isAnonymousCsrfToken(token: string, now: Date, key: Buffer): boolean {
  const parts = ANONYMOUS_TOKEN.exec(token);
  if (!parts) return false;
  const expires = Number(parts[1]);
  const delta = expires - now.getTime();
  if (delta <= 0 || delta > ANONYMOUS_CSRF_MAX_AGE_MS) return false;
  const body = `v1.${parts[1]}.${parts[2]}`;
  return secureEqual(parts[3] ?? "", hmac(key, `rp:csrf:anonymous\0${body}`));
}

export function matchesSessionCsrfToken(token: string, sessionId: string, csrfSecret: string): boolean {
  return SESSION_TOKEN.test(token) && secureEqual(token, deriveSessionCsrfToken(sessionId, csrfSecret));
}

export function secureEqual(input: string, expected: string): boolean {
  if (input.length > 128 || expected.length > 128) return false;
  const left = Buffer.from(input);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
