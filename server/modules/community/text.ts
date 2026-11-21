/**
 * Community forum — server-side normalisation and validation of user text. Owner: audit_engineer (package M).
 *
 * Bodies are constrained plain text (paragraphs, "> " quotes, "- " lists, `code`, https links), never HTML.
 * The server stores the normalised text; the client parses and renders it as React elements (no innerHTML).
 * Every function here is linear in the input length; no user-supplied regular expressions.
 */
import { createHash } from "node:crypto";
import { validation } from "../../core/errors.js";

export const MAX_BODY_LENGTH = 10_000;
export const MIN_BODY_LENGTH = 1;
export const MAX_TITLE_LENGTH = 140;
export const MIN_TITLE_LENGTH = 5;

// Control characters except \n and \t, bidi overrides/isolates, zero-width and BOM characters.
const STRIP = /(?![\n\t])[\p{Cc}\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/gu;

/** Single-line free text (report notes, reasons): controls/bidi removed, whitespace collapsed, bounded. */
export function cleanLine(input: string, max: number): string {
  return input.normalize("NFC").replace(STRIP, "").replace(/\s+/gu, " ").trim().slice(0, max);
}

/** NFC, CRLF→LF, strip controls/bidi, tabs→space, trailing whitespace per line trimmed, ≤2 blank lines. */
export function normaliseBody(input: string): string {
  const text = input
    .normalize("NFC")
    .replace(/\r\n?/gu, "\n")
    .replace(STRIP, "")
    .replace(/\t/gu, "  ")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (text.length < MIN_BODY_LENGTH) throw validation("COMMUNITY_BODY_EMPTY", "The post is empty.");
  if (text.length > MAX_BODY_LENGTH) throw validation("COMMUNITY_BODY_TOO_LONG", `The post is longer than ${MAX_BODY_LENGTH} characters.`);
  return text;
}

export function normaliseTitle(input: string): string {
  const text = input.normalize("NFC").replace(STRIP, "").replace(/\s+/gu, " ").trim();
  if (text.length < MIN_TITLE_LENGTH || text.length > MAX_TITLE_LENGTH) {
    throw validation("COMMUNITY_TITLE_LENGTH", `The title must be ${MIN_TITLE_LENGTH}–${MAX_TITLE_LENGTH} characters.`);
  }
  return text;
}

/** Counts tokens the client would render as links (https URLs) plus other scheme-looking URLs (spam signal). */
export function countLinks(body: string): number {
  let count = 0;
  for (const token of body.split(/\s+/u)) {
    if (/^(?:https?:\/\/|www\.)\S/iu.test(token)) count += 1;
  }
  return count;
}

/** sha256 of the case-folded, whitespace-collapsed body; duplicate detection only. */
export function bodyHash(body: string): string {
  return createHash("sha256").update(body.toLowerCase().replace(/\s+/gu, " "), "utf8").digest("hex");
}

/** Lower-case word tokens (letters, digits, apostrophes). */
function tokens(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}']+/u).filter((t) => t.length > 0);
}

/**
 * Whole-word / whole-phrase match against a filter list, linear in text length × max phrase words (≤ small).
 * Returns the first matching filter entry or null.
 */
export function matchWordList(text: string, list: readonly string[]): string | null {
  if (list.length === 0) return null;
  const words = tokens(text);
  const phrases = new Map<string, string>();
  let maxLen = 1;
  for (const entry of list) {
    const parts = tokens(entry);
    if (parts.length === 0) continue;
    maxLen = Math.max(maxLen, Math.min(parts.length, 6));
    phrases.set(parts.join(" "), entry);
  }
  for (let i = 0; i < words.length; i += 1) {
    let phrase = "";
    for (let n = 0; n < maxLen && i + n < words.length; n += 1) {
      phrase = n === 0 ? words[i]! : `${phrase} ${words[i + n]!}`;
      const hit = phrases.get(phrase);
      if (hit !== undefined) return hit;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ display names */

export const DISPLAY_NAME_MIN = 3;
export const DISPLAY_NAME_MAX = 32;
const DISPLAY_NAME_RE = /^[\p{L}\p{N}](?:[\p{L}\p{N} ._-]*[\p{L}\p{N}])?$/u;
const RESERVED = new Set([
  "admin", "administrator", "moderator", "mod", "staff", "support", "system", "readypackets", "official",
  "root", "security", "help", "helpdesk", "former member", "anonymous", "null", "undefined",
]);

export function displayNameKey(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/[\s._-]+/gu, " ").trim();
}

/** Returns the normalised display name or throws a validation error (never echoes the input). */
export function validateDisplayName(input: string): { displayName: string; key: string } {
  const displayName = input.normalize("NFC").replace(STRIP, "").replace(/\s+/gu, " ").trim();
  if (displayName.length < DISPLAY_NAME_MIN || displayName.length > DISPLAY_NAME_MAX) {
    throw validation("COMMUNITY_NAME_LENGTH", `Display names are ${DISPLAY_NAME_MIN}–${DISPLAY_NAME_MAX} characters.`);
  }
  if (!DISPLAY_NAME_RE.test(displayName)) {
    throw validation("COMMUNITY_NAME_CHARACTERS", "Use letters, numbers, spaces, dots, hyphens or underscores, starting and ending with a letter or number.");
  }
  if (displayName.includes("@") || /\.(?:com|net|org|io|co)\b/iu.test(displayName)) {
    throw validation("COMMUNITY_NAME_CONTACT", "A display name cannot look like an e-mail address or web address.");
  }
  const key = displayNameKey(displayName);
  if (RESERVED.has(key) || [...RESERVED].some((r) => r.length >= 5 && key.replace(/ /gu, "").includes(r.replace(/ /gu, "")))) {
    throw validation("COMMUNITY_NAME_RESERVED", "That display name is reserved.");
  }
  if (/\d{7,}/u.test(key.replace(/ /gu, ""))) throw validation("COMMUNITY_NAME_NUMBER", "A display name cannot contain a long number.");
  return { displayName, key };
}
