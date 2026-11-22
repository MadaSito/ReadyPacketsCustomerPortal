/**
 * Promotion code normalisation, CSPRNG batch generation, keyed-hash blind indexing,
 * field-level encryption, staff-safe masking, and formula-safe CSV serialisation.
 */
import { randomInt } from "node:crypto";
import { validation } from "../../core/errors.js";
import type { FieldCrypto } from "../../core/types.js";

/** 31 unambiguous uppercase characters (excludes 0, O, 1, I, L). */
export const PROMO_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const PROMO_RANDOM_LENGTH = 12;

export const PROMO_CUSTOM_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{4,30}[A-Z0-9]$/;
export const PROMO_PREFIX_PATTERN = /^[A-Z0-9]{1,12}$/;

export const PROMO_CODE_BLIND_PURPOSE = "promo_codes.code";

interface BlindIndexRotator {
  blindIndexCandidates?: (value: string, purpose: string) => string[];
}

export function normalizePromoCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export function validateAdminPromoCode(raw: string): string {
  const normalized = normalizePromoCode(raw);
  if (!PROMO_CUSTOM_CODE_PATTERN.test(normalized)) {
    throw validation(
      "INVALID_PROMO_CODE_FORMAT",
      "Promotion codes must be 6 to 32 characters using A–Z, 0–9, and internal hyphens.",
    );
  }
  return normalized;
}

export function isPlausiblePromoCode(normalized: string): boolean {
  return PROMO_CUSTOM_CODE_PATTERN.test(normalized);
}

export function normalizePromoPrefix(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim().toUpperCase();
  if (trimmed.length === 0) return null;
  if (!PROMO_PREFIX_PATTERN.test(trimmed)) {
    throw validation(
      "INVALID_PROMO_PREFIX",
      "Batch prefixes must be 1 to 12 characters using only A–Z and 0–9.",
    );
  }
  return trimmed;
}

export function generateRandomSegment(length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += PROMO_CODE_ALPHABET[randomInt(0, PROMO_CODE_ALPHABET.length)]!;
  }
  return out;
}

/**
 * Generates a CSPRNG unambiguous promotion code with >= 12 random characters.
 * - With `prefix` (e.g. `VIP`): `VIP-<12 random chars>`
 * - Without `prefix`: `<4>-<4>-<4>` (12 random chars grouped for readability)
 */
export function generatePromoCode(prefix?: string | null): string {
  const cleanPrefix = normalizePromoPrefix(prefix);
  if (cleanPrefix) {
    return `${cleanPrefix}-${generateRandomSegment(PROMO_RANDOM_LENGTH)}`;
  }
  return `${generateRandomSegment(4)}-${generateRandomSegment(4)}-${generateRandomSegment(4)}`;
}

export function promoCodeAad(codePublicId: string): string {
  return `promo_codes.code_enc:${codePublicId}`;
}

export function computePromoCodeIndex(crypto: FieldCrypto, normalizedCode: string): string {
  return crypto.blindIndex(normalizedCode, PROMO_CODE_BLIND_PURPOSE);
}

export function computePromoCodeCandidates(crypto: FieldCrypto, normalizedCode: string): string[] {
  const rotator = crypto as FieldCrypto & BlindIndexRotator;
  if (typeof rotator.blindIndexCandidates === "function") {
    const candidates = rotator.blindIndexCandidates(normalizedCode, PROMO_CODE_BLIND_PURPOSE);
    if (candidates.length > 0) return candidates;
  }
  return [crypto.blindIndex(normalizedCode, PROMO_CODE_BLIND_PURPOSE)];
}

export function encryptPromoCode(
  crypto: FieldCrypto,
  codePublicId: string,
  normalizedCode: string,
): string {
  return crypto.encrypt(normalizedCode, promoCodeAad(codePublicId));
}

export function decryptPromoCode(
  crypto: FieldCrypto,
  codePublicId: string,
  envelope: string,
): string {
  return crypto.decrypt(envelope, promoCodeAad(codePublicId));
}

/** Masks a single normalized code for `promotions.read` views (shows first 2 and last 2 characters). */
export function maskPromoCode(normalizedCode: string): string {
  if (normalizedCode.length < 6) return "••••••";
  return `${normalizedCode.slice(0, 2)}••••${normalizedCode.slice(-2)}`;
}

export function maskBatchSummary(codePrefix: string | null, batchSize: number): string {
  const prefixPart = codePrefix ? `${codePrefix}-` : "";
  const noun = batchSize === 1 ? "code" : "codes";
  return `${prefixPart}•••••••••••• (${batchSize} ${noun})`;
}

/**
 * Asserts that the customer-facing `label` cannot leak the secret `code` (or batch prefix)
 * onto orders, invoices, or audit records (G-C3-02 / D3 hygiene).
 */
export function assertLabelDistinctFromCode(
  label: string,
  codeOrPrefix: string | null | undefined,
): void {
  if (!codeOrPrefix) return;
  const normLabel = label.trim().toUpperCase();
  const normCode = codeOrPrefix.trim().toUpperCase();
  if (normLabel.length > 0 && normLabel === normCode) {
    throw validation(
      "LABEL_MATCHES_CODE",
      "The customer-facing label must not match the promotion code.",
    );
  }
}

const FORMULA_TRIGGER_RE = /^[\s]*[=+\-@\t\r]/;

export function sanitizeCsvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  const raw = String(value);
  const neutralized = FORMULA_TRIGGER_RE.test(raw) ? `'${raw}` : raw;
  if (
    neutralized.includes(",") ||
    neutralized.includes('"') ||
    neutralized.includes("\n") ||
    neutralized.includes("\r") ||
    neutralized.startsWith("'")
  ) {
    return `"${neutralized.replace(/"/g, '""')}"`;
  }
  return neutralized;
}

export function toFormulaSafeCsv(
  headers: readonly string[],
  rows: readonly (readonly (string | number | boolean | null | undefined)[])[],
): string {
  const lines = [
    headers.map((h) => sanitizeCsvCell(h)).join(","),
    ...rows.map((r) => r.map((c) => sanitizeCsvCell(c)).join(",")),
  ];
  return `${lines.join("\r\n")}\r\n`;
}
