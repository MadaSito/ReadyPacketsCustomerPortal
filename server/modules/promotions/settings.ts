import { z } from "zod";
import { defineFeatureFlag, defineSetting } from "../platform/index.js";

export const twoDecimalPercentField = z
  .number()
  .min(0.01)
  .max(100)
  .refine((v) => Number.isFinite(v) && Math.abs(Math.round(v * 100) - v * 100) < 1e-6, {
    message: "Enter a percentage between 0.01 and 100 with at most two decimal places.",
  });

export const promotionsPolicySchema = z.object({
  /** Largest combined discount allowed per order as a percentage (0.01..100, up to 2 decimals; default 100). */
  maxDiscountPercent: twoDecimalPercentField.default(100),
  /** Optional ceiling on fixed-amount discount codes in minor units (`null` = no limit; default `null`). */
  maxFixedAmountMinor: z.number().int().min(1).max(1_000_000_000).nullable().default(null),
  /** Whether a discount or set-total code may reduce an order total to 0 minor units (default `true`). */
  allowZeroTotal: z.boolean().default(true),
  /** Minimum order total after discount in minor units (default `0`). */
  minOrderTotalAfterDiscountMinor: z.number().int().min(0).max(1_000_000_000).default(0),
});

export type PromotionsPolicyConfig = z.output<typeof promotionsPolicySchema>;

export const DEFAULT_PROMOTIONS_POLICY: PromotionsPolicyConfig = Object.freeze({
  maxDiscountPercent: 100,
  maxFixedAmountMinor: null,
  allowZeroTotal: true,
  minOrderTotalAfterDiscountMinor: 0,
});

/** Converts a validated 0.01..100 percentage (up to 2 decimals) to exact basis points (1..10000). */
export function percentToBps(percent: number): number {
  return Math.min(10_000, Math.max(1, Math.round(percent * 100)));
}

/**
 * Parses stored `promotions.policy` values (including Increment 05 `{ maxDiscountPercent: 50 }` or partial/legacy shapes)
 * without throwing: preserves any valid stored field and fills missing/invalid fields from `DEFAULT_PROMOTIONS_POLICY`.
 */
export function parsePromotionsPolicy(raw: unknown): PromotionsPolicyConfig {
  const direct = promotionsPolicySchema.safeParse(raw);
  if (direct.success) {
    return {
      maxDiscountPercent: Math.round(direct.data.maxDiscountPercent * 100) / 100,
      maxFixedAmountMinor: direct.data.maxFixedAmountMinor,
      allowZeroTotal: direct.data.allowZeroTotal,
      minOrderTotalAfterDiscountMinor: direct.data.minOrderTotalAfterDiscountMinor,
    };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_PROMOTIONS_POLICY };
  }
  const obj = raw as Record<string, unknown>;
  const pct = twoDecimalPercentField.safeParse(obj.maxDiscountPercent);
  const maxFixed = z
    .number()
    .int()
    .min(1)
    .max(1_000_000_000)
    .nullable()
    .safeParse(obj.maxFixedAmountMinor);
  const allowZero = z.boolean().safeParse(obj.allowZeroTotal);
  const minAfter = z
    .number()
    .int()
    .min(0)
    .max(1_000_000_000)
    .safeParse(obj.minOrderTotalAfterDiscountMinor);

  return {
    maxDiscountPercent: pct.success
      ? Math.round(pct.data * 100) / 100
      : DEFAULT_PROMOTIONS_POLICY.maxDiscountPercent,
    maxFixedAmountMinor:
      obj.maxFixedAmountMinor !== undefined && maxFixed.success
        ? maxFixed.data
        : DEFAULT_PROMOTIONS_POLICY.maxFixedAmountMinor,
    allowZeroTotal: allowZero.success
      ? allowZero.data
      : DEFAULT_PROMOTIONS_POLICY.allowZeroTotal,
    minOrderTotalAfterDiscountMinor: minAfter.success
      ? minAfter.data
      : DEFAULT_PROMOTIONS_POLICY.minOrderTotalAfterDiscountMinor,
  };
}

/**
 * Ships disabled by default (`feature.promotions = false`).
 * `clientVisible: true` exposes the on/off state via `platform.bootstrap` so cart, order wizard, and admin nav respect it.
 */
export const PROMOTIONS_ENABLED_FLAG = defineFeatureFlag({
  flag: "promotions",
  owner: "promotions",
  group: "features",
  label: "Discount codes and links",
  description:
    "Allows administrators to issue single or batch promotion codes and fragment links with atomic redemption, abuse throttling, and configurable discount limits.",
  clientVisible: true,
});

export const PROMOTIONS_POLICY_SETTING = defineSetting<PromotionsPolicyConfig>({
  key: "promotions.policy",
  owner: "promotions",
  group: "general",
  label: "Promotions discount limits",
  description:
    "Configures per-order discount limits: largest percentage discount (0.01–100%, default 100%), optional fixed-amount cap, zero-total permission, and minimum order total after discount.",
  schema: promotionsPolicySchema,
  default: DEFAULT_PROMOTIONS_POLICY,
  sensitivity: "internal",
  writeCapability: "promotions.manage",
  fields: {
    maxDiscountPercent: {
      label: "Largest discount per order (%)",
      help: "Maximum percentage of the pre-tax subtotal a discount may remove (0.01 to 100, up to two decimals).",
    },
    maxFixedAmountMinor: {
      label: "Maximum fixed discount (minor units)",
      help: "Optional ceiling for fixed-amount codes in minor currency units (leave empty for no limit).",
    },
    allowZeroTotal: {
      label: "Allow zero-total orders",
      help: "Allow 100%, fixed, or set-total codes to bring an order total to 0.00.",
    },
    minOrderTotalAfterDiscountMinor: {
      label: "Minimum order total after discount (minor units)",
      help: "Lowest order total permitted after applying discounts (0 allows 0.00 orders when zero-total orders are enabled).",
    },
  },
  managedBy: {
    href: "/admin/promotions",
    label: "Discount codes — Limits",
  },
});
