/**
 * Normalization + validation primitives for identity values. Pure functions (unit tested).
 */
import { z } from "zod";

/** Canonical e-mail form used for the blind index: trimmed, NFC, lower-cased. */
export function normalizeEmail(raw: string): string {
  return raw.normalize("NFC").trim().toLowerCase();
}

/** Pragmatic e-mail shape check (RFC 5321 length bounds, one @, dotted domain, no spaces/control chars). */
const EMAIL_SHAPE = /^[^\s@\p{Cc}]{1,64}@[^\s@\p{Cc}]+\.[^\s@\p{Cc}]{2,}$/u;

export const emailSchema = z
  .string()
  .max(320)
  .transform(normalizeEmail)
  .refine((value) => value.length >= 3 && value.length <= 254 && EMAIL_SHAPE.test(value), "Enter a valid e-mail address.");

/** Display names: NFC, trimmed, internal whitespace collapsed, 1–120 code points, no control characters. */
export function normalizeName(raw: string): string {
  return raw.normalize("NFC").replace(/\s+/gu, " ").trim();
}

export const nameSchema = z
  .string()
  .max(400)
  .transform(normalizeName)
  .refine((value) => [...value].length >= 1 && [...value].length <= 120, "Enter a name between 1 and 120 characters.")
  .refine((value) => !/\p{Cc}/u.test(value), "The name contains characters that are not allowed.");

/** Customer references: upper-case letters, digits and single hyphens, 3–32 chars. */
export const CUSTOMER_REF_PATTERN = /^[A-Z0-9](?:[A-Z0-9]|-(?=[A-Z0-9])){2,31}$/;

export function normalizeCustomerRef(raw: string): string {
  return raw.normalize("NFC").trim().toUpperCase();
}

export const customerRefSchema = z
  .string()
  .max(64)
  .transform(normalizeCustomerRef)
  .refine((value) => CUSTOMER_REF_PATTERN.test(value), "Use 3–32 letters, digits or single hyphens.");

/** Lower-cased 3-letter prefixes of the first and last name tokens (for the encrypted-name search index). */
export function namePrefixes(name: string): { first: string | null; last: string | null } {
  const tokens = normalizeName(name)
    .toLowerCase()
    .split(" ")
    .map((token) => [...token.replace(/[^\p{L}\p{N}]/gu, "")].slice(0, 3).join(""))
    .filter((token) => [...token].length === 3);
  if (tokens.length === 0) return { first: null, last: null };
  return { first: tokens[0] ?? null, last: tokens.length > 1 ? (tokens[tokens.length - 1] ?? null) : null };
}

/** Coarse device summary from a user agent. Never stores the raw string. */
export function deviceSummary(userAgent: string | undefined): string | null {
  if (!userAgent) return null;
  const ua = userAgent.slice(0, 512);
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /iPhone|iPad|iOS/.test(ua)
      ? "iOS"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "unknown OS";
  return `${browser} on ${os}`;
}
