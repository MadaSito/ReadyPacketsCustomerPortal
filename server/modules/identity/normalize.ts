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

/* ---- increment 08 (D1): name parts ---- */

export interface NameParts {
  firstName: string;
  /** "" only for a derived single-token legacy / SSO name; always non-empty when entered by a person. */
  lastName: string;
  preferredName: string | null;
}

/** Each name part: at most 50 UTF-16 code units. */
export const NAME_PART_MAX = 50;

/** Refused in name parts: control characters, markup brackets and bidi overrides/isolates/marks (ZWJ/ZWNJ stay allowed). */
const NAME_PART_REFUSED = /[\p{Cc}<>\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const NAME_PART_STRIP = /[\p{Cc}<>\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

const namePart = (label: string, min: number) =>
  z
    .string()
    .max(400)
    .transform(normalizeName)
    // /root ruling (final): 50 UTF-16 code units each, so "<First> <Last>" ≤ 101 units fits every downstream cap.
    .refine((value) => value.length >= min && value.length <= NAME_PART_MAX, min === 0 ? `${label} can be at most ${NAME_PART_MAX} characters.` : `Enter a ${label.toLowerCase()} between 1 and ${NAME_PART_MAX} characters.`)
    .refine((value) => !NAME_PART_REFUSED.test(value), `The ${label.toLowerCase()} contains characters that are not allowed.`);

export const firstNameSchema = namePart("First name", 1);
export const lastNameSchema = namePart("Last name", 1);
/** Optional; blank → null. */
export const preferredNameSchema = namePart("Preferred name", 0).transform((value) => (value === "" ? null : value));

/** Fields shared by every form that asks for a person's name (registration, profile, admin create/edit, invitations). */
export const namePartsShape = {
  firstName: firstNameSchema,
  lastName: lastNameSchema,
  preferredName: preferredNameSchema.nullish().transform((value) => value ?? null),
};

/**
 * Router input that also accepts the pre-08 single `name` (older automation and API clients keep working). Exactly one
 * form: `firstName` + `lastName` (+ optional `preferredName`), or the legacy `name` (parts are then derived lazily).
 */
export const nameInputShape = {
  firstName: firstNameSchema.optional(),
  lastName: lastNameSchema.optional(),
  preferredName: preferredNameSchema.nullish(),
  name: nameSchema.optional(),
};
type NameInputRaw = { firstName?: string | undefined; lastName?: string | undefined; preferredName?: string | null | undefined; name?: string | undefined };
export function refineNameInput(value: NameInputRaw, ctx: z.RefinementCtx): void {
  const parts = value.firstName !== undefined || value.lastName !== undefined || (value.preferredName ?? null) !== null;
  if (value.name !== undefined && parts) ctx.addIssue({ code: "custom", path: ["name"], message: "Send either first and last name, or name — not both." });
  else if (value.name === undefined) {
    if (value.firstName === undefined) ctx.addIssue({ code: "custom", path: ["firstName"], message: "Enter a first name between 1 and 50 characters." });
    if (value.lastName === undefined) ctx.addIssue({ code: "custom", path: ["lastName"], message: "Enter a last name between 1 and 50 characters." });
  }
}
/** Service-level name input: stored parts (08+) or a legacy display name. */
export type NameInput = { nameParts: NameParts; name?: undefined } | { name: string; nameParts?: undefined };
export function nameInputOf(value: NameInputRaw): NameInput {
  if (value.name !== undefined) return { name: value.name };
  return { nameParts: { firstName: value.firstName!, lastName: value.lastName!, preferredName: value.preferredName ?? null } };
}

/** The display name stored in name_enc: always "<First> <Last>" (single space; no trailing space when last is ""). */
export function fullNameOf(parts: Pick<NameParts, "firstName" | "lastName">): string {
  return normalizeName(`${parts.firstName} ${parts.lastName}`);
}

/**
 * Lazy derivation for accounts created before increment 08 and single-name SSO subjects: first whitespace token =
 * first name, last token = last name (one token → last name ""). Middle tokens are not kept as separate parts.
 */
export function deriveNameParts(name: string): NameParts {
  const tokens = normalizeName(name).split(" ").filter(Boolean);
  if (tokens.length === 0) return { firstName: "", lastName: "", preferredName: null };
  return { firstName: tokens[0]!, lastName: tokens.length > 1 ? tokens[tokens.length - 1]! : "", preferredName: null };
}

/** Greeting ("Welcome back, …", mail salutations): preferred name, else first name, else the full name. */
export function greetingNameOf(parts: NameParts, fullName: string): string {
  return parts.preferredName || parts.firstName || fullName;
}

/**
 * SSO claims → parts: given / family name when present (OIDC given_name/family_name, SAML givenname/surname), else
 * derived from the display name. Values are bounded and cleaned like typed input; unusable values fall back.
 */
export function namePartsFromClaims(claims: { givenName?: string | null; familyName?: string | null; displayName?: string | null }): NameParts | null {
  const clean = (value: string | null | undefined) => {
    if (typeof value !== "string") return "";
    // Strip first, then normalise, so a claim that was only refused characters becomes "" (and falls back).
    const v = normalizeName(value.replace(NAME_PART_STRIP, " "));
    if (v.length <= NAME_PART_MAX) return v;
    // Cut at ≤50 UTF-16 units without splitting a surrogate pair.
    let out = "";
    for (const ch of v) { if (out.length + ch.length > NAME_PART_MAX) break; out += ch; }
    return normalizeName(out);
  };
  const given = clean(claims.givenName);
  const family = clean(claims.familyName);
  if (given) return { firstName: given, lastName: family, preferredName: null };
  const display = clean(claims.displayName);
  if (!display) return null;
  return deriveNameParts(display);
}

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
