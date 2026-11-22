import type { Tone } from "@/ui";

export const REFERRAL_STATUSES = [
  "attributed",
  "qualified_pending_approval",
  "approved",
  "rejected",
  "credited",
] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

export const REFERRAL_REWARD_MODES = ["fixed", "percent"] as const;
export type ReferralRewardMode = (typeof REFERRAL_REWARD_MODES)[number];

export const REFERRAL_PAYOUT_METHODS = ["account_credit", "manual_payout"] as const;
export type ReferralPayoutMethod = (typeof REFERRAL_PAYOUT_METHODS)[number];

export const REFERRAL_LEDGER_ENTRY_TYPES = ["reward_approved", "credit_applied"] as const;
export type ReferralLedgerEntryType = (typeof REFERRAL_LEDGER_ENTRY_TYPES)[number];

export interface ReferralProgramConfig {
  rewardMode: ReferralRewardMode;
  fixedAmountMinor: number;
  percentBps: number;
  capAmountMinor: number;
  currency: string;
  manualApprovalRequired: boolean;
  inviteMaxPerCustomerPerDay: number;
  inviteMaxPerRecipientPerWindow: number;
  inviteRecipientCooldownHours: number;
}

export interface CustomerReferralOverviewView {
  code: string;
  shareUrl: string;
  sharePath: string;
  program: {
    rewardMode: ReferralRewardMode;
    fixedAmountMinor: number;
    percentBps: number;
    capAmountMinor: number;
    currency: string;
    manualApprovalRequired: boolean;
  };
  stats: {
    total: number;
    pending: number;
    approved: number;
    credited: number;
    rejected: number;
    approvedRewardMinor: number;
    creditedRewardMinor: number;
    currency: string;
  };
}

export interface CustomerReferralHistoryItemView {
  referralPublicId: string;
  referredAccountHint: string;
  status: ReferralStatus;
  rewardAmountMinor: number;
  currency: string;
  attributedAt: Date | string;
  qualifiedAt: Date | string | null;
  reviewedAt: Date | string | null;
  creditedAt: Date | string | null;
}

export interface AdminReferralItemView {
  referralPublicId: string;
  codeSnapshot: string;
  status: ReferralStatus;
  referrerPublicId: string;
  referrerCustomerRef: string | null;
  referrerName: string;
  referredPublicId: string;
  referredCustomerRef: string | null;
  referredName: string;
  rewardMode: ReferralRewardMode | null;
  rewardPercentBps: number | null;
  rewardCapMinor: number | null;
  rewardAmountMinor: number;
  currency: string;
  qualifyingInvoicePublicId: string | null;
  qualifyingOrderPublicId: string | null;
  invoiceTotalMinor: number | null;
  invoiceCurrency: string | null;
  qualificationNoteCode: string | null;
  attributedAt: Date | string;
  qualifiedAt: Date | string | null;
  reviewedAt: Date | string | null;
  reviewReason: string | null;
  creditedAt: Date | string | null;
  payoutMethod: ReferralPayoutMethod | null;
  payoutReference: string | null;
  payoutNote: string | null;
  version: number;
}

export interface AdminRewardLedgerItemView {
  ledgerPublicId: string;
  referralPublicId: string;
  referrerPublicId: string;
  referrerCustomerRef: string | null;
  referrerName: string;
  entryType: ReferralLedgerEntryType;
  amountMinor: number;
  currency: string;
  payoutMethod: ReferralPayoutMethod | null;
  reference: string | null;
  note: string | null;
  createdAt: Date | string;
}

export interface AdminReferralsSettingsView {
  enabled: boolean;
  config: ReferralProgramConfig;
  summary: {
    totalReferrals: number;
    pendingApproval: number;
    approvedAwaitingCredit: number;
    creditedCount: number;
    approvedAmountMinor: number;
    creditedAmountMinor: number;
    currency: string;
  };
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ReferralExportPayload {
  filename: string;
  contentType: string;
  rowCount: number;
  body: string;
}

export const REFERRAL_STATUS_META: Record<
  ReferralStatus,
  { label: string; customerLabel: string; tone: Tone }
> = {
  attributed: {
    label: "Attributed",
    customerLabel: "Signed up — awaiting first paid invoice",
    tone: "info",
  },
  qualified_pending_approval: {
    label: "Pending approval",
    customerLabel: "Qualified — pending review",
    tone: "warning",
  },
  approved: {
    label: "Approved",
    customerLabel: "Approved for account credit",
    tone: "success",
  },
  credited: {
    label: "Credited",
    customerLabel: "Credit applied",
    tone: "brand",
  },
  rejected: {
    label: "Rejected",
    customerLabel: "Not eligible",
    tone: "danger",
  },
};

export const REFERRAL_CODE_REGEX = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{10}$/;

/**
 * Formats integer minor units (e.g. `2500`) into a plain decimal input string (`"25.00"`).
 */
export function formatMinorToMajorInput(amountMinor: number): string {
  const safe = Math.max(0, Math.trunc(amountMinor));
  const whole = Math.floor(safe / 100);
  const cents = String(safe % 100).padStart(2, "0");
  return `${whole}.${cents}`;
}

/**
 * Parses a decimal major-unit string (e.g. `"25"` or `"25.50"`) into integer minor units (`2500`, `2550`).
 * Returns `null` for malformed or out-of-bounds values — never uses binary float math.
 */
export function parseMajorToMinor(raw: string): number | null {
  const trimmed = raw.trim();
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) return null;
  const whole = Number(match[1]);
  const fracRaw = match[2] ?? "00";
  const cents = Number(fracRaw.padEnd(2, "0"));
  const minor = whole * 100 + cents;
  if (!Number.isSafeInteger(minor) || minor < 0 || minor > 100_000_000) return null;
  return minor;
}

/**
 * Formats basis points (e.g. `1000`) to percentage string (`"10"` or `"12.5"`).
 */
export function formatBpsToPercentInput(bps: number): string {
  const whole = Math.floor(bps / 100);
  const rem = bps % 100;
  if (rem === 0) return String(whole);
  return `${whole}.${String(rem).padStart(2, "0").replace(/0+$/, "")}`;
}

export function parsePercentToBps(raw: string): number | null {
  const trimmed = raw.trim();
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) return null;
  const whole = Number(match[1]);
  const frac = Number((match[2] ?? "00").padEnd(2, "0"));
  const bps = whole * 100 + frac;
  if (!Number.isSafeInteger(bps) || bps < 1 || bps > 10_000) return null;
  return bps;
}
