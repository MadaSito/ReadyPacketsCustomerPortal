/**
 * Promotions module — shared TypeScript view and port types (types only, zero runtime imports).
 * Owner: siem_engineer (Increment 05 C1, Increment 06 D5). Safe for client `import type`.
 */

export type PromoDiscountType = "percent" | "fixed" | "set_total";
export type PromoScopeKind = "all" | "products" | "tiers" | "packets";
export type PromoTierKey = "Basic" | "Standard" | "Premium";
export type PromoStatus = "active" | "paused" | "revoked";
export type PromoDerivedStatus =
  | "active"
  | "paused"
  | "revoked"
  | "scheduled"
  | "expired"
  | "exhausted";
export type PromoRedemptionStatus = "redeemed" | "released";

export type PromoLimitKey =
  | "maxDiscountPercent"
  | "maxFixedAmountMinor"
  | "allowZeroTotal"
  | "minOrderTotalAfterDiscountMinor";

export type PromoLimitReasonCode =
  | "PROMO_LIMIT_MAX_PERCENT"
  | "PROMO_LIMIT_MAX_FIXED"
  | "PROMO_LIMIT_ZERO_TOTAL"
  | "PROMO_LIMIT_MIN_TOTAL";

export type PromotionScope =
  | { kind: "all" }
  | { kind: "products"; productPublicIds: string[] }
  | { kind: "tiers"; tierKeys: PromoTierKey[] }
  | { kind: "packets"; packetNumbers: number[] };

export interface PromotionLine {
  productPublicId: string;
  packetNumber: number | null;
  tierKey: string | null;
  lineTotalMinor: number;
}

export interface PromotionContext {
  /** Raw input; normalised by promotions (`trim().toUpperCase()`). Never logged or audited. */
  code: string;
  /** The order owner, not the actor. */
  customerUserId: number;
  actorUserId: number;
  currency: string;
  lines: readonly PromotionLine[];
  subtotalMinor: number;
  bundleDiscountMinor: number;
  bundleLabel: string | null;
}

export interface PromotionLineAllocation {
  lineIndex: number;
  productPublicId: string;
  grossMinor: number;
  bundleDiscountMinor: number;
  promoDiscountMinor: number;
  discountMinor: number;
  netMinor: number;
}

export interface PromotionOutcome {
  promoPublicId: string;
  /** Customer-facing label. */
  label: string;
  /** Discount attributable to the promotion code. */
  promoDiscountMinor: number;
  /** 0 when `combineWithBundle = false` and the code replaced the bundle discount. */
  bundleDiscountMinor: number;
  /** Combined discount (`promoDiscountMinor + bundleDiscountMinor`) to store on the order. */
  discountMinor: number;
  /** Combined label for order and invoice. */
  discountLabel: string;
  /** `subtotalMinor - discountMinor` (>= 0). */
  totalMinor: number;
  /**
   * Per-line minor-unit allocation (`sum(discountMinor) === outcome.discountMinor`,
   * `sum(netMinor) === outcome.totalMinor`, every `netMinor >= 0`, remainder on last line).
   * Always populated by `promotions.preview` / `promotions.redeemInTx`.
   */
  lineAllocations?: PromotionLineAllocation[];
}

export interface PromotionView {
  publicId: string;
  name: string;
  label: string;
  type: PromoDiscountType;
  percentBps: number | null;
  maxDiscountMinor: number | null;
  amountMinor: number | null;
  /** Target order total in minor units (`>= 0`) when `type === "set_total"`, `null` otherwise. Always returned by server. */
  setTotalMinor?: number | null;
  currency: string | null;
  scope: PromotionScope;
  minSubtotalMinor: number;
  startsAt: string | null;
  endsAt: string | null;
  maxRedemptions: number | null;
  maxPerCustomer: number;
  firstOrderOnly: boolean;
  allowCustomerPublicIds: string[];
  allowEmailDomains: string[];
  combineWithBundle: boolean;
  status: PromoStatus;
  derivedStatus: PromoDerivedStatus;
  note: string | null;
  codeMasked: string;
  isBatch: boolean;
  codePrefix: string | null;
  batchSize: number;
  redemptionCount: number;
  /** True when this promotion can bring an order total to 0 minor units. Always returned by server. */
  canReachZero?: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PromotionRedemptionView {
  publicId: string;
  promoPublicId: string;
  promotionPublicId: string;
  promotionName: string;
  label: string;
  promotionLabel: string;
  codeMasked: string;
  orderPublicId: string;
  orderNumber: string | null;
  customerPublicId: string;
  customerRef: string | null;
  status: PromoRedemptionStatus;
  currency: string;
  subtotalMinor: number;
  promoDiscountMinor: number;
  bundleDiscountMinor: number;
  discountMinor: number;
  totalMinor: number;
  redeemedAt: string;
  createdAt: string;
  releasedAt: string | null;
  releaseReason: string | null;
  releaseNote: string | null;
}

export interface PromotionStatsView {
  activePromotions: number;
  redemptions: number;
  releasedRedemptions: number;
  discountMinorByCurrency: Record<string, number>;
}

export interface PromotionsSettingsView {
  enabled: boolean;
  maxDiscountPercent: number;
  maxDiscountBps: number;
  maxFixedAmountMinor: number | null;
  allowZeroTotal: boolean;
  minOrderTotalAfterDiscountMinor: number;
}

export interface PromotionCsvExportView {
  fileName: string;
  csv: string;
  rowCount: number;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}
