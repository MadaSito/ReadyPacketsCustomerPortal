import { countCodePoints } from "../../../shared/domain.js";
import { validation } from "../../core/errors.js";
import type { FieldCrypto } from "../../core/types.js";
import type { NotificationPreferenceCategory } from "./types.js";

// Disallow ASCII C0/DEL control characters except \n (0x0A) and \t (0x09) in multiline plain text.
// eslint-disable-next-line no-control-regex
const MULTILINE_FORBIDDEN_CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u;
// eslint-disable-next-line no-control-regex
const SINGLELINE_FORBIDDEN_CONTROL_RE = /[\x00-\x1F\x7F]/u;

export const NOTIFICATION_KIND_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/u;

export interface PlainTextRules {
  min: number;
  max: number;
  field: string;
  label: string;
  singleLine?: boolean;
}

/**
 * Normalizes plain text to NFC, strips/rejects control characters, and enforces code-point bounds.
 * Does NOT HTML-encode characters: plain text is stored and returned verbatim so `<script>...`
 * remains literal inert text in JSON and React text nodes without double-encoding defects.
 */
export function normalizePlainText(raw: string, rules: PlainTextRules): string {
  const nfc = raw.normalize("NFC");
  const normalizedLineEndings = rules.singleLine
    ? nfc.replace(/[\r\n\t]+/gu, " ")
    : nfc.replace(/\r\n?/gu, "\n");

  const controlRegex = rules.singleLine ? SINGLELINE_FORBIDDEN_CONTROL_RE : MULTILINE_FORBIDDEN_CONTROL_RE;
  if (controlRegex.test(normalizedLineEndings)) {
    throw validation(
      "INVALID_CONTROL_CHARS",
      `The ${rules.label} contains unsupported control characters.`,
      { field: rules.field },
    );
  }

  const trimmed = normalizedLineEndings.trim();
  const len = countCodePoints(trimmed);
  if (len < rules.min) {
    throw validation(
      "TEXT_TOO_SHORT",
      `The ${rules.label} must be at least ${rules.min} character${rules.min === 1 ? "" : "s"}.`,
      { field: rules.field, min: rules.min },
    );
  }
  if (len > rules.max) {
    throw validation(
      "TEXT_TOO_LONG",
      `The ${rules.label} must be ${rules.max} characters or fewer.`,
      { field: rules.field, max: rules.max },
    );
  }
  return trimmed;
}

/**
 * Validates an optional in-app relative path (`/...`). Rejects scheme URLs, protocol-relative `//`,
 * backslashes, control characters, and overlong values.
 */
export function normalizeInternalLink(link: string | null | undefined): string | null {
  if (link === undefined || link === null || link === "") return null;
  const trimmed = link.normalize("NFC").trim();
  if (
    trimmed.length > 255 ||
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    trimmed.includes("\\") ||
    SINGLELINE_FORBIDDEN_CONTROL_RE.test(trimmed)
  ) {
    throw validation("INVALID_NOTIFICATION_LINK", "Notification links must be relative portal paths.");
  }
  return trimmed;
}

export function classifyNotificationCategory(kind: string): NotificationPreferenceCategory {
  const prefix = kind.split(".")[0] ?? "system";
  switch (prefix) {
    case "security":
    case "auth":
    case "assurance":
    case "session":
      return "security";
    case "order":
    case "orders":
      return "order";
    case "message":
    case "messages":
      return "message";
    case "ticket":
    case "tickets":
    case "support":
      return "ticket";
    case "file":
    case "files":
      return "file";
    case "invoice":
    case "invoices":
    case "billing":
      return "invoice";
    case "compliance":
    case "policy":
    case "policies":
    case "intake":
      return "compliance";
    default:
      return "system";
  }
}

export function encodeIdCursor(id: number): string {
  return Buffer.from(`v1:${id}`, "ascii").toString("base64url");
}

export function decodeIdCursor(cursor: string | undefined): number | undefined {
  if (cursor === undefined) return undefined;
  if (cursor.length === 0 || cursor.length > 64) {
    throw validation("INVALID_CURSOR", "The pagination cursor is invalid.");
  }
  const decoded = Buffer.from(cursor, "base64url").toString("ascii");
  const match = /^v1:([1-9][0-9]{0,18})$/u.exec(decoded);
  if (!match || Buffer.from(decoded, "ascii").toString("base64url") !== cursor) {
    throw validation("INVALID_CURSOR", "The pagination cursor is invalid.");
  }
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw validation("INVALID_CURSOR", "The pagination cursor is invalid.");
  }
  return id;
}

export const SEARCH_TOKEN_PURPOSE = "engagement.search.token";

/**
 * Extracts bounded unique word tokens (>= 3 code points) from plain text and computes
 * HMAC-SHA-256 blind indexes so encrypted fields can be queried by word without plaintext indexes.
 */
export function computeSearchTokenHashes(
  crypto: FieldCrypto,
  texts: readonly string[],
  maxTokens = 64,
): string[] {
  const seen = new Set<string>();
  const hashes: string[] = [];
  for (const text of texts) {
    const normalized = text.normalize("NFC").toLowerCase();
    const parts = normalized.split(/[^\p{L}\p{N}]+/u);
    for (const part of parts) {
      if (!part) continue;
      const len = countCodePoints(part);
      if (len < 3 || len > 48) continue;
      if (seen.has(part)) continue;
      seen.add(part);
      hashes.push(crypto.blindIndex(part, SEARCH_TOKEN_PURPOSE));
      if (hashes.length >= maxTokens) return hashes;
    }
  }
  return hashes;
}

export function normalizeSearchQuery(raw: string): {
  normalized: string;
  lower: string;
  escapedLikePrefix: string;
  wordTokens: string[];
} {
  const normalized = normalizePlainText(raw, {
    min: 2,
    max: 64,
    field: "query",
    label: "search query",
    singleLine: true,
  });
  const lower = normalized.toLowerCase();
  const escapedLikePrefix = `${normalized.toUpperCase().replace(/[!%_]/gu, (ch) => `!${ch}`)}%`;
  const seen = new Set<string>();
  const wordTokens: string[] = [];
  for (const part of lower.split(/[^\p{L}\p{N}]+/u)) {
    if (!part) continue;
    const len = countCodePoints(part);
    if (len < 3 || len > 48 || seen.has(part)) continue;
    seen.add(part);
    wordTokens.push(part);
    if (wordTokens.length >= 6) break;
  }
  return { normalized, lower, escapedLikePrefix, wordTokens };
}

export function truncateSnippet(text: string, maxChars = 140): string {
  const oneLine = text.replace(/\s+/gu, " ").trim();
  const chars = [...oneLine];
  if (chars.length <= maxChars) return oneLine;
  return `${chars.slice(0, maxChars - 1).join("")}…`;
}
