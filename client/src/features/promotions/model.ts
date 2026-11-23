/**
 * Discount codes (D3) — client view model, form model and pure helpers. Owner: audit engineer.
 *
 * The view shapes mirror server/modules/promotions (siem_engineer, C1). Until that module publishes
 * `contracts.ts`, these are the agreed shapes; switch to `import type` from the server when it lands.
 * Codes are never part of a view: staff see `codeMasked`; an administrator reveals one code with step-up.
 */
import { formatMoney } from "@shared/domain";
import { formatMinorToDecimalInput, parseDecimalToMinor } from "@/lib/moneyInput";

import type {
  PromoDerivedStatus, PromoDiscountType, PromoRedemptionStatus, PromoScopeKind, PromoStatus, PromoTierKey, PromotionRedemptionView, PromotionScope,
  PromotionStatsView, PromotionsSettingsView, PromotionView,
} from "@server/modules/promotions/contracts";

export type { PromoDerivedStatus, PromoDiscountType, PromoRedemptionStatus, PromoScopeKind, PromoStatus, PromoTierKey, PromotionScope, PromotionView };
export type RedemptionView = PromotionRedemptionView;
export type PromotionStats = PromotionStatsView;
export type PromotionSettings = PromotionsSettingsView;
export interface MoneyValue { amountMinor: number; currency: string }

export const PROMO_TIER_KEYS: readonly PromoTierKey[] = ["Basic", "Standard", "Premium"];

/** Rule fields shared by the create input and the view (server/modules/promotions/API.md). */
export type PromotionRules = Pick<PromotionView,
  "name" | "label" | "type" | "percentBps" | "maxDiscountMinor" | "amountMinor" | "setTotalMinor" | "currency" | "scope" | "minSubtotalMinor" | "startsAt" | "endsAt"
  | "maxRedemptions" | "maxPerCustomer" | "firstOrderOnly" | "allowCustomerPublicIds" | "allowEmailDomains" | "combineWithBundle" | "note">;

export type CreatePromotionInput = PromotionRules & { isBatch?: boolean; code?: string; codePrefix?: string | null; initialBatchCount?: number; idempotencyKey?: string };
/** Type, percentage, amount and currency are fixed once created (create a new code instead). */
export type UpdatePromotionInput = Omit<PromotionRules, "type" | "percentBps" | "amountMinor" | "setTotalMinor" | "currency"> & { publicId: string; expectedVersion: number };

/* ---------- display ---------- */

export const DERIVED_STATUS_LABEL: Record<PromoDerivedStatus, string> = {
  active: "Active",
  paused: "Paused",
  revoked: "Revoked",
  scheduled: "Scheduled",
  expired: "Ended",
  exhausted: "Used up",
};

export const SCOPE_LABEL: Record<PromoScopeKind, string> = {
  all: "Everything",
  products: "Selected products",
  tiers: "Selected tiers",
  packets: "Selected packet sizes",
};

export function formatPercentBps(bps: number): string {
  const value = bps / 100;
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2).replace(/0$/u, "")} %`;
}

export const DISCOUNT_TYPE_LABEL: Record<PromoDiscountType, string> = { percent: "Percentage", fixed: "Fixed amount", set_total: "Set order total to" };

/** D5: true when the code can bring an order total to 0.00 (server flag; a local fallback for older views). */
export function canReachZero(p: Pick<PromotionView, "type" | "percentBps" | "setTotalMinor" | "canReachZero">): boolean {
  if (typeof p.canReachZero === "boolean") return p.canReachZero;
  return (p.type === "set_total" && p.setTotalMinor === 0) || (p.type === "percent" && p.percentBps === 10_000);
}

export function discountSummary(p: Pick<PromotionView, "type" | "percentBps" | "amountMinor" | "maxDiscountMinor" | "currency" | "setTotalMinor">, money: (m: MoneyValue) => string = formatMoney): string {
  if (p.type === "set_total") return typeof p.setTotalMinor === "number" && p.currency ? `Order total set to ${money({ amountMinor: p.setTotalMinor, currency: p.currency })}` : "—";
  if (p.type === "percent" && p.percentBps !== null) {
    const cap = p.maxDiscountMinor !== null && p.currency ? `, up to ${money({ amountMinor: p.maxDiscountMinor, currency: p.currency })}` : "";
    return `${formatPercentBps(p.percentBps)} off${cap}`;
  }
  if (p.amountMinor !== null && p.currency) return `${money({ amountMinor: p.amountMinor, currency: p.currency })} off`;
  return "—";
}

/** Status changes allowed from the stored status. Revoked is final. */
export function statusActions(status: PromoStatus): Array<"pause" | "resume" | "revoke"> {
  if (status === "active") return ["pause", "revoke"];
  if (status === "paused") return ["resume", "revoke"];
  return [];
}

/** Percent input text from basis points: 9999 → "99.99", 1000 → "10". */
export function formatPercentInput(bps: number): string {
  return bps % 100 === 0 ? String(bps / 100) : (bps / 100).toFixed(2).replace(/0$/u, "");
}

/** Parses a 0.01–100 percentage with at most two decimals; null when invalid. */
export function parsePercent(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,3}(?:\.\d{1,2})?$/u.test(t)) return null;
  const bps = Math.round(Number(t) * 100);
  return bps >= 1 && bps <= 10_000 ? bps / 100 : null;
}

/* ---------- form ---------- */

export interface PromotionFormState {
  name: string;
  label: string;
  discountType: PromoDiscountType;
  percent: string;
  maxDiscount: string;
  fixedAmount: string;
  /** D5 `set_total`: the order total the code sets (0.00 allowed). */
  setTotal: string;
  currency: string;
  scopeKind: PromoScopeKind;
  scopeProducts: string[];
  scopeTiers: PromoTierKey[];
  scopePackets: string[];
  minSubtotal: string;
  startsAt: string;
  endsAt: string;
  maxRedemptions: string;
  maxPerCustomer: string;
  firstOrderOnly: boolean;
  allowCustomers: string[];
  allowDomains: string[];
  combineWithBundle: boolean;
  note: string;
  codeMode: "chosen" | "generated" | "batch";
  code: string;
  batchCount: string;
  batchPrefix: string;
}

export const emptyForm = (currency = "USD"): PromotionFormState => ({
  name: "", label: "", discountType: "percent", percent: "", maxDiscount: "", fixedAmount: "", setTotal: "", currency,
  scopeKind: "all", scopeProducts: [], scopeTiers: [], scopePackets: [], minSubtotal: "", startsAt: "", endsAt: "",
  maxRedemptions: "", maxPerCustomer: "1", firstOrderOnly: false, allowCustomers: [], allowDomains: [],
  combineWithBundle: false, note: "", codeMode: "chosen", code: "", batchCount: "", batchPrefix: "",
});

const minorToText = (minor: number | null, currency?: string | null): string => (minor === null ? "" : formatMinorToDecimalInput(minor, currency ?? undefined));
/** `datetime-local` value in the browser's zone ↔ ISO instant. */
export function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function formFromView(p: PromotionView): PromotionFormState {
  return {
    name: p.name, label: p.label, discountType: p.type,
    percent: p.percentBps === null ? "" : formatPercentInput(p.percentBps),
    maxDiscount: minorToText(p.maxDiscountMinor, p.currency), fixedAmount: minorToText(p.amountMinor, p.currency),
    setTotal: minorToText(p.setTotalMinor ?? null, p.currency), currency: p.currency ?? "USD",
    scopeKind: p.scope.kind,
    scopeProducts: p.scope.kind === "products" ? p.scope.productPublicIds : [],
    scopeTiers: p.scope.kind === "tiers" ? p.scope.tierKeys : [],
    scopePackets: p.scope.kind === "packets" ? p.scope.packetNumbers.map(String) : [],
    minSubtotal: p.minSubtotalMinor ? minorToText(p.minSubtotalMinor, p.currency) : "",
    startsAt: isoToLocalInput(p.startsAt), endsAt: isoToLocalInput(p.endsAt),
    maxRedemptions: p.maxRedemptions === null ? "" : String(p.maxRedemptions), maxPerCustomer: String(p.maxPerCustomer),
    firstOrderOnly: p.firstOrderOnly, allowCustomers: p.allowCustomerPublicIds, allowDomains: p.allowEmailDomains,
    combineWithBundle: p.combineWithBundle, note: p.note ?? "", codeMode: p.isBatch ? "batch" : "chosen", code: "", batchCount: "", batchPrefix: p.codePrefix ?? "",
  };
}

/** Decimal money text → integer minor units, or null when empty; NaN marks invalid input. */
export function parseMoney(text: string, currency?: string): number | null {
  const t = text.trim();
  if (t === "") return null;
  if (t.length > 12) return Number.NaN;
  return parseDecimalToMinor(t, true, /^[A-Z]{3}$/u.test(currency ?? "") ? currency : undefined) ?? Number.NaN;
}
function parseCount(text: string): number | null {
  const t = text.trim();
  if (t === "") return null;
  return /^\d{1,7}$/u.test(t) ? Number(t) : Number.NaN;
}

export const CHOSEN_CODE = /^[A-Z0-9][A-Z0-9-]{4,30}[A-Z0-9]$/u;
const DOMAIN = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

export type FormErrors = Partial<Record<keyof PromotionFormState, string>>;

/** Client checks give fast, specific feedback; the server re-validates everything and has the final word. */
/** Store-wide limits from the Limits card (D5); any omitted limit is not checked here (the server always checks). */
export interface PolicyLimits {
  maxDiscountPercent?: number;
  maxFixedAmountMinor?: number | null;
  allowZeroTotal?: boolean;
  minOrderTotalAfterDiscountMinor?: number;
}
export const LIMITS_ANCHOR = "limits";
export const ZERO_FIXED_MESSAGE = "A fixed amount must be more than 0.00. To make orders free or set an exact price, choose “Set order total to”.";

export function validateForm(f: PromotionFormState, opts: { creating: boolean } & PolicyLimits): { errors: FormErrors; input: CreatePromotionInput | null } {
  const e: FormErrors = {};
  if (!f.name.trim()) e.name = "Enter an internal name.";
  if (!f.label.trim()) e.label = "Enter the label customers see.";
  let percentBps: number | null = null;
  let fixedAmountMinor: number | null = null;
  let setTotalMinor: number | null = null;
  const maxDiscountMinor = f.discountType === "percent" ? parseMoney(f.maxDiscount, f.currency) : null;
  if (f.discountType === "percent") {
    const pct = f.percent.trim();
    if (!/^\d{1,3}(?:\.\d{1,2})?$/u.test(pct) || Number(pct) <= 0 || Number(pct) > 100) e.percent = "Enter a percentage from 0.01 to 100, with up to two decimals (for example 99.99).";
    else {
      percentBps = Math.round(Number(pct) * 100);
      if (opts.maxDiscountPercent !== undefined && percentBps > Math.round(opts.maxDiscountPercent * 100)) e.percent = `The largest discount per order is ${formatPercentBps(Math.round(opts.maxDiscountPercent * 100))} (Limits card). Lower the percentage or change that limit.`;
    }
    if (Number.isNaN(maxDiscountMinor) || maxDiscountMinor === 0) e.maxDiscount = "Enter an amount such as 25.00, or leave it empty.";
  } else if (f.discountType === "fixed") {
    fixedAmountMinor = parseMoney(f.fixedAmount, f.currency);
    if (fixedAmountMinor === 0) e.fixedAmount = ZERO_FIXED_MESSAGE;
    else if (fixedAmountMinor === null || Number.isNaN(fixedAmountMinor) || fixedAmountMinor < 0) e.fixedAmount = "Enter an amount such as 10.00.";
    else if (typeof opts.maxFixedAmountMinor === "number" && fixedAmountMinor > opts.maxFixedAmountMinor) e.fixedAmount = `The maximum fixed discount is ${formatMoney({ amountMinor: opts.maxFixedAmountMinor, currency: /^[A-Z]{3}$/u.test(f.currency) ? f.currency : "USD" })} (Limits card). Lower the amount or change that limit.`;
  } else {
    setTotalMinor = parseMoney(f.setTotal, f.currency);
    if (setTotalMinor === null || Number.isNaN(setTotalMinor) || setTotalMinor < 0) e.setTotal = "Enter the order total, such as 0.00, 0.01 or 49.00.";
    else if (setTotalMinor === 0 && opts.allowZeroTotal === false) e.setTotal = "Zero-total orders are turned off in the Limits card. Enter an amount above 0.00 or change that limit.";
    else if (opts.minOrderTotalAfterDiscountMinor !== undefined && setTotalMinor < opts.minOrderTotalAfterDiscountMinor) e.setTotal = `The minimum order total after discount is ${formatMoney({ amountMinor: opts.minOrderTotalAfterDiscountMinor, currency: /^[A-Z]{3}$/u.test(f.currency) ? f.currency : "USD" })} (Limits card).`;
  }
  if (!/^[A-Z]{3}$/u.test(f.currency)) e.currency = "Choose a currency.";
  const minSubtotalMinor = parseMoney(f.minSubtotal, f.currency);
  if (Number.isNaN(minSubtotalMinor)) e.minSubtotal = "Enter an amount such as 50.00, or leave it empty.";
  if (f.scopeKind === "products" && f.scopeProducts.length === 0) e.scopeProducts = "Add at least one product.";
  if (f.scopeKind === "tiers" && f.scopeTiers.length === 0) e.scopeTiers = "Add at least one tier.";
  const packets = f.scopePackets.map(Number);
  if (f.scopeKind === "packets" && (packets.length === 0 || packets.some((n) => !Number.isInteger(n) || n <= 0))) e.scopePackets = "Add at least one packet size, as whole numbers.";
  const startsAt = localInputToIso(f.startsAt);
  const endsAt = localInputToIso(f.endsAt);
  if (f.startsAt && !startsAt) e.startsAt = "Enter a valid start date and time.";
  if (f.endsAt && !endsAt) e.endsAt = "Enter a valid end date and time.";
  if (startsAt && endsAt && endsAt <= startsAt) e.endsAt = "The end must be after the start.";
  const maxRedemptions = parseCount(f.maxRedemptions);
  if (Number.isNaN(maxRedemptions) || maxRedemptions === 0) e.maxRedemptions = "Enter a whole number of at least 1, or leave it empty for no limit.";
  const maxPerCustomer = parseCount(f.maxPerCustomer);
  if (maxPerCustomer === null || Number.isNaN(maxPerCustomer) || maxPerCustomer < 1) e.maxPerCustomer = "Enter a whole number of at least 1.";
  if (f.allowDomains.some((d) => !DOMAIN.test(d))) e.allowDomains = "Use domains such as example.com.";
  if (f.note.length > 500) e.note = "Keep the note to 500 characters.";
  if (opts.creating && f.codeMode === "chosen") {
    if (!CHOSEN_CODE.test(f.code)) e.code = "Use 6 to 32 letters, digits or hyphens, starting and ending with a letter or digit.";
    else if (f.label.trim().toUpperCase() === f.code) e.label = "The label customers see must not be the code itself.";
  }
  if (opts.creating && f.codeMode === "batch") Object.assign(e, batchErrors(f.batchCount, f.batchPrefix));
  if (f.codeMode === "batch" && f.batchPrefix && f.label.trim().toUpperCase() === f.batchPrefix) e.label = "The label customers see must not be the code prefix.";
  if (Object.keys(e).length > 0) return { errors: e, input: null };
  return {
    errors: e,
    input: {
      name: f.name.trim(), label: f.label.trim(), type: f.discountType, percentBps,
      maxDiscountMinor: f.discountType === "percent" ? maxDiscountMinor : null, amountMinor: fixedAmountMinor, setTotalMinor, currency: f.currency,
      scope: f.scopeKind === "products" ? { kind: "products", productPublicIds: f.scopeProducts }
        : f.scopeKind === "tiers" ? { kind: "tiers", tierKeys: f.scopeTiers }
        : f.scopeKind === "packets" ? { kind: "packets", packetNumbers: packets }
        : { kind: "all" },
      minSubtotalMinor: minSubtotalMinor ?? 0, startsAt, endsAt, maxRedemptions, maxPerCustomer: maxPerCustomer ?? 1,
      firstOrderOnly: f.firstOrderOnly, allowCustomerPublicIds: f.allowCustomers, allowEmailDomains: f.allowDomains,
      combineWithBundle: f.combineWithBundle, note: f.note.trim() ? f.note.trim() : null,
      ...(opts.creating && f.codeMode === "chosen" ? { code: f.code } : {}),
      ...(opts.creating && f.codeMode === "batch" ? { isBatch: true, codePrefix: f.batchPrefix || null, initialBatchCount: Number(f.batchCount), idempotencyKey: newIdempotencyKey() } : {}),
    },
  };
}

/** The editable subset for `update` (type, percentage, amount and currency are fixed). */
export function toUpdateInput(input: CreatePromotionInput, view: Pick<PromotionView, "publicId" | "version">): UpdatePromotionInput {
  const { type: _t, percentBps: _p, amountMinor: _a, setTotalMinor: _s, currency: _c, isBatch: _b, code: _code, codePrefix: _cp, initialBatchCount: _n, idempotencyKey: _k, ...rest } = input;
  return { ...rest, publicId: view.publicId, expectedVersion: view.version };
}

/* ---------- batch ---------- */

export const BATCH_MAX = 5000;
/** Server rule: prefix of 1–12 letters or digits; codes look like `PREFIX-` + 12 random characters. */
export const BATCH_PREFIX = /^[A-Z0-9]{1,12}$/u;

export function batchErrors(count: string, prefix: string): { batchCount?: string; batchPrefix?: string } {
  const out: { batchCount?: string; batchPrefix?: string } = {};
  const n = Number(count.trim());
  if (!/^\d{1,4}$/u.test(count.trim()) || n < 1 || n > BATCH_MAX) out.batchCount = `Enter a number from 1 to ${BATCH_MAX.toLocaleString("en-US")}.`;
  if (prefix && !BATCH_PREFIX.test(prefix)) out.batchPrefix = "Use 1 to 12 letters or digits, or leave it empty.";
  return out;
}

/** A fresh idempotency key per batch request; a retry of the same request re-sends the same key. */
export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------- files ---------- */

export function downloadCsv(filename: string, csv: string): void {
  const safeName = /^[A-Za-z0-9._-]{1,120}\.csv$/u.test(filename) ? filename : "discount-codes.csv";
  const href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const trigger = document.createElement("a");
  trigger.href = href;
  trigger.download = safeName;
  trigger.rel = "noopener";
  document.body.append(trigger);
  trigger.click();
  trigger.remove();
  setTimeout(() => URL.revokeObjectURL(href), 0);
}
