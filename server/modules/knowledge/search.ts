/**
 * Knowledge Base — linear-time search scoring, safe highlighted snippet segmentation,
 * and PII-scrubbed anonymous search-term normalisation (Increment 04, Package F).
 */
import type { KnowledgeSnippetSegment } from "./types.js";

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "do",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "my",
  "of",
  "on",
  "or",
  "the",
  "to",
  "what",
  "when",
  "where",
  "who",
  "why",
  "with",
]);

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/g;

/**
 * Extracts bounded lowercase search tokens (up to 8 tokens, each 2..48 chars) with zero user regexes.
 */
export function tokenizeSearchQuery(rawQuery: string): string[] {
  const cleaned = rawQuery
    .normalize("NFC")
    .replace(CONTROL_CHAR_RE, " ")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, " ")
    .trim();
  if (!cleaned) return [];
  const rawTokens = cleaned.split(/\s+/);
  const filtered = rawTokens.filter((t) => t.length >= 2 && t.length <= 48 && !STOP_WORDS.has(t));
  const chosen = filtered.length > 0 ? filtered : rawTokens.filter((t) => t.length >= 2 && t.length <= 48);
  return [...new Set(chosen)].slice(0, 8);
}

/**
 * Scrubs accidental personal identifiers (e-mail addresses, ULIDs, long digit runs like phone/SSN/order numbers)
 * before aggregating a search query in `knowledge_search_logs` WITHOUT any user/session/IP identity.
 * Returns `null` for empty, single-character, or purely redacted queries so they are not logged.
 */
export function normalizeAnonymousSearchTerm(rawQuery: string): string | null {
  const scrubbed = rawQuery
    .normalize("NFC")
    .replace(CONTROL_CHAR_RE, " ")
    .toLowerCase()
    // Redact e-mail-like tokens
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g, " ")
    // Redact ULID-like 26-char identifiers
    .replace(/\b[0-9a-hjkmnp-tv-z]{26}\b/g, " ")
    // Redact digit sequences of 5+ characters (order refs, phone numbers, account numbers)
    .replace(/\d{5,}/g, " ")
    .replace(/[^a-z0-9\s_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();

  if (scrubbed.length < 2) return null;
  return scrubbed;
}

export function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export interface RankableArticle {
  title: string;
  summary: string;
  bodyText: string;
  tags: readonly string[];
  helpfulYesCount: number;
  viewCount: number;
}

/**
 * Computes a deterministic relevance score > 0 when ALL query tokens match at least one searchable field
 * (or, for multi-word Contextual Ticket suggestions when `matchAnyToken` is true, when ANY token matches).
 */
export function scoreArticleMatch(
  article: RankableArticle,
  rawQuery: string,
  tokens: readonly string[],
  options?: { matchAnyToken?: boolean },
): number {
  if (tokens.length === 0) return 1;

  const titleLower = article.title.toLowerCase();
  const summaryLower = article.summary.toLowerCase();
  const bodyLower = article.bodyText.toLowerCase();
  const tagsLower = article.tags.map((t) => t.toLowerCase());
  const normalizedPhrase = rawQuery.normalize("NFC").trim().toLowerCase();

  let score = 0;
  let matchedTokens = 0;

  if (normalizedPhrase.length >= 3) {
    if (titleLower === normalizedPhrase) score += 120;
    else if (titleLower.startsWith(normalizedPhrase)) score += 80;
    else if (titleLower.includes(normalizedPhrase)) score += 55;
    if (summaryLower.includes(normalizedPhrase)) score += 25;
    if (bodyLower.includes(normalizedPhrase)) score += 15;
  }

  for (const token of tokens) {
    let tokenMatched = false;
    if (titleLower.includes(token)) {
      tokenMatched = true;
      score += titleLower.startsWith(token) ? 35 : 24;
    }
    if (tagsLower.some((tag) => tag === token || tag.includes(token))) {
      tokenMatched = true;
      score += tagsLower.includes(token) ? 28 : 16;
    }
    if (summaryLower.includes(token)) {
      tokenMatched = true;
      score += 12;
    }
    if (bodyLower.includes(token)) {
      tokenMatched = true;
      score += 6;
    }
    if (tokenMatched) matchedTokens += 1;
  }

  if (options?.matchAnyToken) {
    if (matchedTokens === 0) return 0;
  } else if (matchedTokens < tokens.length) {
    return 0;
  }

  // Gentle quality tie-breaker
  score += Math.min(article.helpfulYesCount, 20) * 0.25 + Math.min(article.viewCount, 200) * 0.02;
  return score;
}

/**
 * Splits `text` into safe `{ text, highlight }` segments using linear-time `indexOf` scans (no dynamic RegExp).
 */
export function buildHighlightSegments(
  text: string,
  tokens: readonly string[],
): KnowledgeSnippetSegment[] {
  if (!text) return [];
  const validTokens = tokens.filter((t) => t.length >= 2);
  if (validTokens.length === 0) {
    return [{ text, highlight: false }];
  }

  const lower = text.toLowerCase();
  const intervals: Array<[number, number]> = [];

  for (const token of validTokens) {
    let from = 0;
    while (from < lower.length) {
      const idx = lower.indexOf(token, from);
      if (idx === -1) break;
      intervals.push([idx, idx + token.length]);
      from = idx + token.length;
    }
  }

  if (intervals.length === 0) {
    return [{ text, highlight: false }];
  }

  intervals.sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : b[1] - a[1]));
  const merged: Array<[number, number]> = [];
  for (const [start, end] of intervals) {
    const last = merged[merged.length - 1];
    if (!last || start > last[1]) {
      merged.push([start, end]);
    } else if (end > last[1]) {
      last[1] = end;
    }
  }

  const segments: KnowledgeSnippetSegment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) {
      segments.push({ text: text.slice(cursor, start), highlight: false });
    }
    segments.push({ text: text.slice(start, end), highlight: true });
    cursor = end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), highlight: false });
  }
  return segments;
}

/**
 * Extracts a ~180-char window centered around the first matching token in `bodyText` (or `summary` when
 * `summary` already matches), returning highlighted safe text segments.
 */
export function buildArticleSnippetSegments(
  summary: string,
  bodyText: string,
  tokens: readonly string[],
  maxLength = 180,
): KnowledgeSnippetSegment[] {
  const cleanSummary = summary.replace(/\s+/g, " ").trim();
  if (tokens.length === 0) {
    const clipped = cleanSummary.length > maxLength ? `${cleanSummary.slice(0, maxLength).trimEnd()}…` : cleanSummary;
    return [{ text: clipped, highlight: false }];
  }

  const lowerSummary = cleanSummary.toLowerCase();
  if (tokens.some((t) => lowerSummary.includes(t))) {
    const clipped = cleanSummary.length > maxLength ? `${cleanSummary.slice(0, maxLength).trimEnd()}…` : cleanSummary;
    return buildHighlightSegments(clipped, tokens);
  }

  const cleanBody = bodyText.replace(/\s+/g, " ").trim();
  const lowerBody = cleanBody.toLowerCase();
  let firstPos = -1;
  for (const token of tokens) {
    const pos = lowerBody.indexOf(token);
    if (pos !== -1 && (firstPos === -1 || pos < firstPos)) {
      firstPos = pos;
    }
  }

  if (firstPos === -1 || !cleanBody) {
    const clipped = cleanSummary.length > maxLength ? `${cleanSummary.slice(0, maxLength).trimEnd()}…` : cleanSummary;
    return buildHighlightSegments(clipped, tokens);
  }

  const half = Math.floor(maxLength / 2);
  let start = Math.max(0, firstPos - half);
  if (start > 0) {
    const spaceAfter = cleanBody.indexOf(" ", start);
    if (spaceAfter !== -1 && spaceAfter < firstPos) start = spaceAfter + 1;
  }
  let end = Math.min(cleanBody.length, start + maxLength);
  if (end < cleanBody.length) {
    const spaceBefore = cleanBody.lastIndexOf(" ", end);
    if (spaceBefore > firstPos + 12) end = spaceBefore;
  }

  const prefix = start > 0 ? "…" : "";
  const suffix = end < cleanBody.length ? "…" : "";
  const windowText = `${prefix}${cleanBody.slice(start, end).trim()}${suffix}`;
  return buildHighlightSegments(windowText, tokens);
}
