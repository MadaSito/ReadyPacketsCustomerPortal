import { z } from "zod";
import { defineFeatureFlag, defineSetting } from "../platform/index.js";
import { REFERRAL_REWARD_MODES } from "./schema.js";

export const referralProgramConfigSchema = z.strictObject({
  rewardMode: z.enum(REFERRAL_REWARD_MODES),
  /** Fixed credit reward in integer minor units (e.g. 2500 = $25.00). */
  fixedAmountMinor: z.number().int().min(0).max(100_000_000),
  /** Basis points of net pre-tax invoice amount when `rewardMode === "percent"` (1000 = 10.00%). */
  percentBps: z.number().int().min(1).max(10_000),
  /** Maximum reward cap in integer minor units when `rewardMode === "percent"`. */
  capAmountMinor: z.number().int().min(0).max(100_000_000),
  /** 3-letter ISO 4217 uppercase currency code. */
  currency: z.string().regex(/^[A-Z]{3}$/, "Enter a 3-letter uppercase ISO currency code."),
  /** Decision 8: approval is manual by default. */
  manualApprovalRequired: z.boolean(),
  /** Rolling 24-hour invitation limit per customer account. */
  inviteMaxPerCustomerPerDay: z.number().int().min(1).max(100),
  /** Maximum invitations sent to the same recipient address within the cooldown window. */
  inviteMaxPerRecipientPerWindow: z.number().int().min(1).max(5),
  /** Recipient cooldown window in hours (default 168 = 7 days). */
  inviteRecipientCooldownHours: z.number().int().min(1).max(720),
});

export type ReferralProgramConfig = z.infer<typeof referralProgramConfigSchema>;

export const DEFAULT_REFERRAL_PROGRAM_CONFIG: ReferralProgramConfig = Object.freeze({
  rewardMode: "fixed",
  fixedAmountMinor: 2_500,
  percentBps: 1_000,
  capAmountMinor: 10_000,
  currency: "USD",
  manualApprovalRequired: true,
  inviteMaxPerCustomerPerDay: 10,
  inviteMaxPerRecipientPerWindow: 1,
  inviteRecipientCooldownHours: 168,
});

/**
 * Ships disabled by default (`feature.referrals = false`).
 * `clientVisible: true` exposes the on/off state via `platform.bootstrap` so `NavItem.enabledBy: "referrals"` works.
 */
export const REFERRALS_ENABLED_FLAG = defineFeatureFlag({
  flag: "referrals",
  owner: "referrals",
  group: "features",
  label: "Customer referral programme",
  description:
    "Allows customers to share a non-guessable referral code, earn account credits when a referred customer pays their first invoice, and view referral status.",
  clientVisible: true,
});

export const REFERRALS_PROGRAM_CONFIG = defineSetting({
  key: "referrals.program",
  owner: "referrals",
  group: "general",
  label: "Referral programme configuration",
  description:
    "Reward calculation rules (fixed amount or capped percentage in integer minor units), manual review policy, and invitation anti-abuse rate limits.",
  schema: referralProgramConfigSchema,
  default: DEFAULT_REFERRAL_PROGRAM_CONFIG,
  sensitivity: "internal",
  writeCapability: "referrals.manage",
  managedBy: {
    href: "/admin/referrals",
    label: "Referrals",
  },
});
