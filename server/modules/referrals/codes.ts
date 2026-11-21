import { randomInt } from "node:crypto";
import { validation } from "../../core/errors.js";
import type { ReferralProgramConfig } from "./settings.js";

/**
 * Decision 8: 10 characters from `0-9 A-Z` excluding look-alikes (`0`, `O`, `1`, `I`, `L`).
 * 31^10 = 819,628,286,980,801 (~49.5 bits of CSPRNG entropy, zero modulo bias via `randomInt`).
 */
export const REFERRAL_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ" as const;
export const REFERRAL_CODE_LENGTH = 10 as const;
export const REFERRAL_CODE_REGEX = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{10}$/;

export function generateReferralCode(): string {
  let out = "";
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i += 1) {
    out += REFERRAL_CODE_ALPHABET[randomInt(0, REFERRAL_CODE_ALPHABET.length)]!;
  }
  return out;
}

export function normalizeReferralCode(raw: string): string | null {
  const cleaned = raw.normalize("NFC").trim().toUpperCase();
  if (!REFERRAL_CODE_REGEX.test(cleaned)) return null;
  return cleaned;
}

/**
 * Normalizes an e-mail address (NFC + trim + lowercase) and extracts a canonical base form
 * stripping `+tag` sub-addressing on the local part (and dots on Gmail/Googlemail domains)
 * to defeat trivial `+alias` self-referral abuse (`alice@example.test` -> `alice+2@example.test`).
 */
export function normalizeReferralEmail(raw: string): string {
  return raw.normalize("NFC").trim().toLowerCase();
}

export function canonicalEmailIdentity(raw: string): string {
  const normalized = normalizeReferralEmail(raw);
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) return normalized;
  let local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  const plusIdx = local.indexOf("+");
  if (plusIdx > 0) {
    local = local.slice(0, plusIdx);
  }
  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.replace(/\./g, "");
    return `${local}@gmail.com`;
  }
  return `${local}@${domain}`;
}

export function sanitizeSenderDisplayName(name: string): string {
  const collapsed = name
    .normalize("NFC")
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) return "A ReadyPackets customer";
  return collapsed.slice(0, 80);
}

/**
 * Privacy-safe hint shown to the referring customer in `/account/referrals` history.
 * Never reveals the referred customer's e-mail address, legal name, or full customer reference.
 */
export function maskReferredCustomerHint(customerRef: string | null | undefined, publicId: string): string {
  const tailSource = (customerRef && customerRef.trim().length >= 2 ? customerRef.trim() : publicId).slice(-2);
  return `Account ending ${tailSource.toUpperCase()}`;
}

export interface ComputedReferralReward {
  rewardMode: "fixed" | "percent";
  rewardAmountMinor: number;
  currency: string;
  rewardPercentBps: number | null;
  rewardCapMinor: number | null;
  qualificationNoteCode: "CURRENCY_MISMATCH" | null;
}

/**
 * Pure integer minor-unit reward computation.
 * - `fixed`: awards `config.fixedAmountMinor` in `config.currency`. If invoice currency differs from
 *   `config.currency`, flags `CURRENCY_MISMATCH` so manual review is enforced before approval.
 * - `percent`: computes `floor(netPreTaxMinor * percentBps / 10_000)` capped at `capAmountMinor`.
 *   If invoice currency differs from `config.currency`, never fabricates an FX conversion: sets
 *   `rewardAmountMinor = 0` and `qualificationNoteCode = "CURRENCY_MISMATCH"` for administrator review.
 */
export function computeReferralReward(
  config: ReferralProgramConfig,
  invoice: {
    currency: string;
    subtotalMinor: number;
    discountMinor: number;
    totalMinor: number;
  },
): ComputedReferralReward {
  const invoiceCurrency = invoice.currency.trim().toUpperCase();
  const currencyMismatch = invoiceCurrency !== config.currency;

  if (config.rewardMode === "fixed") {
    return {
      rewardMode: "fixed",
      rewardAmountMinor: config.fixedAmountMinor,
      currency: config.currency,
      rewardPercentBps: null,
      rewardCapMinor: null,
      qualificationNoteCode: currencyMismatch ? "CURRENCY_MISMATCH" : null,
    };
  }

  if (currencyMismatch) {
    return {
      rewardMode: "percent",
      rewardAmountMinor: 0,
      currency: config.currency,
      rewardPercentBps: config.percentBps,
      rewardCapMinor: config.capAmountMinor,
      qualificationNoteCode: "CURRENCY_MISMATCH",
    };
  }

  const netPreTaxMinor = Math.max(
    0,
    Math.min(invoice.totalMinor, invoice.subtotalMinor - invoice.discountMinor),
  );
  // BigInt intermediate prevents Number.MAX_SAFE_INTEGER overflow on large minor-unit Basis * bps.
  const uncapped = Number((BigInt(netPreTaxMinor) * BigInt(config.percentBps)) / 10_000n);
  const capped = Math.min(uncapped, config.capAmountMinor);

  return {
    rewardMode: "percent",
    rewardAmountMinor: Math.max(0, capped),
    currency: config.currency,
    rewardPercentBps: config.percentBps,
    rewardCapMinor: config.capAmountMinor,
    qualificationNoteCode: null,
  };
}

export function encodeIdCursor(id: number): string {
  return Buffer.from(JSON.stringify({ id }), "utf8").toString("base64url");
}

export function decodeIdCursor(cursor: string): number {
  if (cursor.length > 128) {
    throw validation("INVALID_CURSOR", "Pagination cursor is invalid.");
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "id" in parsed &&
      typeof (parsed as { id: unknown }).id === "number" &&
      Number.isSafeInteger((parsed as { id: number }).id) &&
      (parsed as { id: number }).id > 0
    ) {
      return (parsed as { id: number }).id;
    }
  } catch {
    // fall through
  }
  throw validation("INVALID_CURSOR", "Pagination cursor is invalid.");
}

/**
 * Neutralizes spreadsheet formula injection (`=`, `+`, `-`, `@`, `\t`, `\r` after optional leading whitespace)
 * and RFC 4180 quotes values for safe CSV export.
 */
export function escapeSafeCsvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  let str = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (/^[\s]*[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function serializeSafeCsv(
  headers: readonly string[],
  rows: readonly (readonly (string | number | boolean | null | undefined)[])[],
): string {
  const lines = [
    headers.map((h) => escapeSafeCsvCell(h)).join(","),
    ...rows.map((row) => row.map((cell) => escapeSafeCsvCell(cell)).join(",")),
  ];
  return `${lines.join("\r\n")}\r\n`;
}
