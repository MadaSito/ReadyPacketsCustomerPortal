/** Orders settings declarations (platform settings registry). */
import { z } from "zod";
import { defineSetting } from "../platform/index.js";

export const ORDER_REFERENCE_PREFIX = defineSetting({
  key: "orders.reference.prefix",
  owner: "orders",
  group: "orders",
  label: "Order reference prefix",
  description: "Uppercase prefix for generated order references, e.g. RP-2026-000123.",
  schema: z.string().regex(/^[A-Z]{2,6}$/),
  default: "RP",
  sensitivity: "internal",
});

export const ORDER_NOTIFY_MAIL = defineSetting({
  key: "orders.notify.mail",
  owner: "orders",
  group: "orders",
  label: "E-mail customers on status changes",
  description: "In-app notifications are always sent; this additionally queues an e-mail when mail delivery is configured.",
  schema: z.boolean(),
  default: false,
  sensitivity: "internal",
});

export const ORDER_INVITE_TTL_DAYS = defineSetting({
  key: "orders.sharing.invite_ttl_days",
  owner: "orders",
  group: "orders",
  label: "Share invitation lifetime (days)",
  description: "Pending share invitations expire after this many days.",
  schema: z.number().int().min(1).max(90),
  default: 14,
  sensitivity: "internal",
});

/**
 * Bundle discount rule (increment 02). Disabled by default; the offerings import (or an admin) sets it.
 * The discount applies when every required packet number is present in the order; it is computed on the
 * server only (round-half-up on minor units of the order subtotal).
 */
export const bundleRuleSchema = z
  .strictObject({
    enabled: z.boolean(),
    requiredPacketNumbers: z.array(z.number().int().min(1).max(255)).max(50),
    discountPercent: z.number().int().min(0).max(100),
    label: z.string().max(120),
  })
  .refine((rule) => new Set(rule.requiredPacketNumbers).size === rule.requiredPacketNumbers.length, { message: "duplicate packet number" })
  .refine((rule) => !rule.enabled || (rule.requiredPacketNumbers.length > 0 && rule.discountPercent > 0 && rule.label.trim().length > 0), {
    message: "an enabled rule needs packets, a percent and a label",
  });

export type BundleRule = z.infer<typeof bundleRuleSchema>;

export const ORDER_BUNDLE_RULE = defineSetting<BundleRule>({
  key: "orders.bundle_rule",
  owner: "orders",
  group: "orders",
  label: "Bundle discount rule",
  description: "Percentage discount applied when an order contains every required packet. Disabled until configured.",
  schema: bundleRuleSchema,
  default: { enabled: false, requiredPacketNumbers: [], discountPercent: 0, label: "" },
  sensitivity: "internal",
});
