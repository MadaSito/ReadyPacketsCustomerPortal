import { z } from "zod";
import { ULID_RE } from "../ulid.js";
import { hasControlChars } from "../json.js";

/** Stable portable identifier (ULID, Crockford base32, upper case). */
export const PublicId = z.string().regex(ULID_RE, "must be a ULID");

/** RFC 3339 UTC timestamp with `Z`, optional milliseconds. Calendar-valid. */
export const UtcTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/, "must be RFC 3339 UTC (…Z)")
  .refine((v) => {
    const ms = Date.parse(v);
    if (!Number.isFinite(ms)) return false;
    // Reject calendar overflow such as 2026-02-30 (Date.parse normalizes it).
    return new Date(ms).toISOString().slice(0, 19) === v.slice(0, 19);
  }, "must be a valid calendar time");

/** Lower-case token for enumerations and reason codes; meaning is documented in CONTRACT.md. */
export const Token = z.string().regex(/^[a-z][a-z0-9_:.-]{0,63}$/, "must be a lower-case token");
export const ReasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, "must be an UPPER_SNAKE code");

export const Currency = z.string().regex(/^[A-Z]{3}$/, "must be an ISO 4217 code");
export const MINOR_MAX = 9_000_000_000_000; // safely inside Number.MAX_SAFE_INTEGER
export const Money = z.strictObject({
  amountMinor: z.int().min(-MINOR_MAX).max(MINOR_MAX),
  currency: Currency,
});
export type Money = z.infer<typeof Money>;

export const Sha256Hex = z.string().regex(/^[a-f0-9]{64}$/, "must be lower-case hex SHA-256");

/** Bounded plain text (no NUL). */
export function text(max: number, min = 0) {
  return z
    .string()
    .min(min)
    .max(max)
    .refine((v) => !v.includes("\u0000"), "must not contain NUL");
}

/** Display file name: no path separators, no control characters, not `.`/`..`. */
export const DisplayFileName = z
  .string()
  .min(1)
  .max(255)
  .refine((v) => !/[\\/]/.test(v) && !hasControlChars(v) && v !== "." && v !== "..", "must be a plain file name");

export const Actor = z.strictObject({
  kind: z.enum(["customer", "staff", "admin", "system", "unknown"]),
  publicId: PublicId.nullable(),
});
export type Actor = z.infer<typeof Actor>;

/** Inert JSON preserved verbatim for fields the producer could not map (never interpreted). */
export const HeldUnknown = z.record(z.string().min(1).max(128), z.json());
