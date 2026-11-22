/**
 * Referrals module — Drizzle MySQL tables. Owner: siem_engineer (Package G).
 *
 * Conventions:
 * - Additive-only schema for Increment 04 (`migrations/0003_*.sql` generated once by `/root`).
 * - Foreign keys reference only `users.id` (cross-module boundary rule) or intra-module tables.
 * - Money values use integer minor units (`BIGINT`) + explicit 3-char ISO currency (`CHAR(3)`).
 * - Invited recipient e-mail addresses are NEVER stored in plaintext — only domain-separated
 *   HMAC blind indexes (`FieldCrypto.blindIndex`) for durable anti-spam rate limiting.
 */
import {
  boolean,
  char,
  foreignKey,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import {
  amountMinorColumn,
  createdAtColumn,
  currencyColumn,
  idColumn,
  publicIdColumn,
  refColumn,
  updatedAtColumn,
  utcDateTime,
  versionColumn,
} from "../../db/columns.js";
import { users } from "../identity/schema.js";

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

export const REFERRAL_INVITE_OUTCOMES = ["enqueued", "suppressed_existing_user"] as const;
export type ReferralInviteOutcome = (typeof REFERRAL_INVITE_OUTCOMES)[number];

/**
 * One non-guessable 10-character referral code per customer account.
 */
export const referralCodes = mysqlTable(
  "referral_codes",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    userId: refColumn("user_id").notNull(),
    /** 10 chars from unambiguous alphabet `23456789ABCDEFGHJKMNPQRSTUVWXYZ`. */
    code: char("code", { length: 10 }).notNull(),
    active: boolean("active").notNull().default(true),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    foreignKey({
      name: "ref_codes_user_fk",
      columns: [t.userId],
      foreignColumns: [users.id],
    }),
    uniqueIndex("ref_codes_user_uq").on(t.userId),
    uniqueIndex("ref_codes_code_uq").on(t.code),
  ],
);
export type ReferralCodeRow = typeof referralCodes.$inferSelect;

/**
 * Attribution and lifecycle state machine per referred customer registration.
 * A referred user can be attributed at most once (`ref_attr_referred_uq`).
 */
export const referrals = mysqlTable(
  "referrals",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    referralCodeId: refColumn("referral_code_id").notNull(),
    referrerUserId: refColumn("referrer_user_id").notNull(),
    referredUserId: refColumn("referred_user_id").notNull(),
    codeSnapshot: char("code_snapshot", { length: 10 }).notNull(),
    status: mysqlEnum("status", REFERRAL_STATUSES).notNull().default("attributed"),
    rewardMode: mysqlEnum("reward_mode", REFERRAL_REWARD_MODES),
    rewardPercentBps: int("reward_percent_bps", { unsigned: true }),
    rewardCapMinor: amountMinorColumn("reward_cap_minor"),
    rewardAmountMinor: amountMinorColumn("reward_amount_minor").notNull().default(0),
    currency: currencyColumn("currency").notNull().default("USD"),
    qualifyingInvoicePublicId: char("qualifying_invoice_public_id", { length: 26 }),
    qualifyingOrderPublicId: char("qualifying_order_public_id", { length: 26 }),
    invoiceSubtotalMinor: amountMinorColumn("invoice_subtotal_minor"),
    invoiceDiscountMinor: amountMinorColumn("invoice_discount_minor"),
    invoiceTotalMinor: amountMinorColumn("invoice_total_minor"),
    invoiceCurrency: currencyColumn("invoice_currency"),
    qualificationNoteCode: varchar("qualification_note_code", { length: 64 }),
    attributedAt: utcDateTime("attributed_at").notNull(),
    qualifiedAt: utcDateTime("qualified_at"),
    reviewedAt: utcDateTime("reviewed_at"),
    reviewedByUserId: refColumn("reviewed_by_user_id"),
    reviewReason: varchar("review_reason", { length: 500 }),
    creditedAt: utcDateTime("credited_at"),
    creditedByUserId: refColumn("credited_by_user_id"),
    payoutMethod: mysqlEnum("payout_method", REFERRAL_PAYOUT_METHODS),
    payoutReference: varchar("payout_reference", { length: 160 }),
    payoutNote: varchar("payout_note", { length: 500 }),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    foreignKey({
      name: "ref_attr_code_fk",
      columns: [t.referralCodeId],
      foreignColumns: [referralCodes.id],
    }),
    foreignKey({
      name: "ref_attr_referrer_fk",
      columns: [t.referrerUserId],
      foreignColumns: [users.id],
    }),
    foreignKey({
      name: "ref_attr_referred_fk",
      columns: [t.referredUserId],
      foreignColumns: [users.id],
    }),
    foreignKey({
      name: "ref_attr_reviewer_fk",
      columns: [t.reviewedByUserId],
      foreignColumns: [users.id],
    }),
    foreignKey({
      name: "ref_attr_creditor_fk",
      columns: [t.creditedByUserId],
      foreignColumns: [users.id],
    }),
    uniqueIndex("ref_attr_referred_uq").on(t.referredUserId),
    uniqueIndex("ref_attr_qual_inv_uq").on(t.qualifyingInvoicePublicId),
    index("ref_attr_referrer_id_idx").on(t.referrerUserId, t.id),
    index("ref_attr_status_id_idx").on(t.status, t.id),
    index("ref_attr_code_snap_idx").on(t.codeSnapshot, t.id),
    index("ref_attr_created_id_idx").on(t.createdAt, t.id),
  ],
);
export type ReferralRow = typeof referrals.$inferSelect;

/**
 * Append-only reward entitlement and credit settlement ledger.
 * Each referral can record at most one `reward_approved` row and one `credit_applied` row.
 */
export const referralRewardLedger = mysqlTable(
  "referral_reward_ledger",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    referralId: refColumn("referral_id").notNull(),
    referrerUserId: refColumn("referrer_user_id").notNull(),
    entryType: mysqlEnum("entry_type", REFERRAL_LEDGER_ENTRY_TYPES).notNull(),
    amountMinor: amountMinorColumn("amount_minor").notNull(),
    currency: currencyColumn("currency").notNull(),
    payoutMethod: mysqlEnum("payout_method", REFERRAL_PAYOUT_METHODS),
    reference: varchar("reference", { length: 160 }),
    note: varchar("note", { length: 500 }),
    actorUserId: refColumn("actor_user_id"),
    createdAt: createdAtColumn(),
  },
  (t) => [
    foreignKey({
      name: "ref_ledger_referral_fk",
      columns: [t.referralId],
      foreignColumns: [referrals.id],
    }),
    foreignKey({
      name: "ref_ledger_referrer_fk",
      columns: [t.referrerUserId],
      foreignColumns: [users.id],
    }),
    foreignKey({
      name: "ref_ledger_actor_fk",
      columns: [t.actorUserId],
      foreignColumns: [users.id],
    }),
    uniqueIndex("ref_ledger_ref_type_uq").on(t.referralId, t.entryType),
    index("ref_ledger_referrer_id_idx").on(t.referrerUserId, t.id),
  ],
);
export type ReferralRewardLedgerRow = typeof referralRewardLedger.$inferSelect;

/**
 * Durable per-sender and per-recipient rate-limiting log for "E-mail my link".
 * Stores only an HMAC blind index of the recipient address (never plaintext PII).
 */
export const referralEmailInvites = mysqlTable(
  "referral_email_invites",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    senderUserId: refColumn("sender_user_id").notNull(),
    referralCodeId: refColumn("referral_code_id").notNull(),
    recipientEmailIndex: char("recipient_email_index", { length: 64 }).notNull(),
    outcome: mysqlEnum("outcome", REFERRAL_INVITE_OUTCOMES).notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    foreignKey({
      name: "ref_invites_sender_fk",
      columns: [t.senderUserId],
      foreignColumns: [users.id],
    }),
    foreignKey({
      name: "ref_invites_code_fk",
      columns: [t.referralCodeId],
      foreignColumns: [referralCodes.id],
    }),
    index("ref_invites_sender_time_idx").on(t.senderUserId, t.createdAt),
    index("ref_invites_rcpt_time_idx").on(t.recipientEmailIndex, t.createdAt),
  ],
);
export type ReferralEmailInviteRow = typeof referralEmailInvites.$inferSelect;
