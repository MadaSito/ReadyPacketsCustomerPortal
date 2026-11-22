import { z } from "zod";
import { defineFeatureFlag, defineSetting } from "../platform/index.js";

export const promotionsPolicySchema = z.strictObject({
  /** Global "Largest discount per order" cap in whole percent (1..100, default 50). */
  maxDiscountPercent: z.number().int().min(1).max(100),
});

export type PromotionsPolicyConfig = z.infer<typeof promotionsPolicySchema>;

export const DEFAULT_PROMOTIONS_POLICY: PromotionsPolicyConfig = Object.freeze({
  maxDiscountPercent: 50,
});

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
    "Allows administrators to issue single or batch promotion codes and fragment links with atomic redemption, abuse throttling, and a global per-order discount cap.",
  clientVisible: true,
});

export const PROMOTIONS_POLICY_SETTING = defineSetting({
  key: "promotions.policy",
  owner: "promotions",
  group: "general",
  label: "Promotions discount guard",
  description:
    "Caps the combined per-order discount (bundle plus promotion code) at a configurable percentage of the pre-tax subtotal (default 50%).",
  schema: promotionsPolicySchema,
  default: DEFAULT_PROMOTIONS_POLICY,
  sensitivity: "internal",
  writeCapability: "promotions.manage",
  managedBy: {
    href: "/admin/promotions",
    label: "Promotions",
  },
});
