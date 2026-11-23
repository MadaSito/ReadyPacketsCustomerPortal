/**
 * Promotions module — Drizzle MySQL tables. Owner: siem_engineer (Increment 05, Package C1).
 *
 * Security & data invariants (Decision D3, ADR 0044):
 * - Plaintext promotion codes are NEVER stored in cleartext or written to logs/audit attributes.
 * - Lookup uses `FieldCrypto.blindIndex(normalizedCode, "promo_codes.code")` (`code_index`, 64-char hex).
 * - Recoverable code text for administrator reveal/export uses `FieldCrypto.encrypt(normalizedCode, "promo_codes.code_enc:" + publicId)`.
 * - Every promotion (single-code or generated single-use batch) has one header row in `promo_batches` and 1..N redeemable rows in `promo_codes`.
 * - Atomic redemption inside the order-creation transaction locks `promo_batches` then `promo_codes` (`FOR UPDATE`) and enforces DB-level unique keys on `(promo_code_id, order_public_id)`, `(promo_code_id, customer_user_id, active_code_sequence)`, and `(batch_id, customer_user_id, active_batch_sequence)`.
 * - Pre-payment order cancellation transitions `promo_redemptions.status` to `"released"` and clears `active_*` slot columns (`NULL` does not collide in MySQL `UNIQUE` indexes) while preserving historical audit columns. Refunds never release redemptions.
 */
import {
  boolean,
  char,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
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

export const PROMO_DISCOUNT_TYPES = ["percent", "fixed", "set_total"] as const;
export type PromoDiscountType = (typeof PROMO_DISCOUNT_TYPES)[number];

export const PROMO_SCOPE_KINDS = ["all", "products", "tiers", "packets"] as const;
export type PromoScopeKind = (typeof PROMO_SCOPE_KINDS)[number];

export const PROMO_STATUSES = ["active", "paused", "revoked"] as const;
export type PromoStatus = (typeof PROMO_STATUSES)[number];

export const PROMO_DERIVED_STATUSES = [
  "active",
  "paused",
  "revoked",
  "scheduled",
  "expired",
  "exhausted",
] as const;
export type PromoDerivedStatus = (typeof PROMO_DERIVED_STATUSES)[number];

export const PROMO_REDEMPTION_STATUSES = ["redeemed", "released"] as const;
export type PromoRedemptionStatus = (typeof PROMO_REDEMPTION_STATUSES)[number];

/**
 * Promotion definitions (both single-code promotions and multi-code generated batches).
 * `public_id` is the canonical `promoPublicId` exposed in admin views, cart state, orders, and audit events.
 */
export const promoBatches = mysqlTable(
  "promo_batches",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    /** Internal operator-facing name. */
    name: varchar("name", { length: 120 }).notNull(),
    /** Customer-facing label displayed on cart, order, and invoice instead of the secret code. */
    label: varchar("label", { length: 120 }).notNull(),
    discountType: mysqlEnum("discount_type", PROMO_DISCOUNT_TYPES).notNull(),
    /** Basis points 1..10000 (0.01%..100.00%) when `discountType = "percent"`; null otherwise. */
    percentBps: int("percent_bps", { unsigned: true }),
    /** Optional maximum promo discount cap in minor units when `discountType = "percent"`. */
    maxDiscountMinor: amountMinorColumn("max_discount_minor"),
    /** Fixed discount amount in minor units (> 0) when `discountType = "fixed"`; null otherwise. */
    fixedAmountMinor: amountMinorColumn("fixed_amount_minor"),
    /** Target order total in minor units (>= 0) when `discountType = "set_total"`; null otherwise. */
    setTotalMinor: amountMinorColumn("set_total_minor"),
    /** ISO-4217 currency required when `discountType = "fixed" | "set_total"` or when monetary caps/minimums apply. */
    currency: currencyColumn(),
    scopeKind: mysqlEnum("scope_kind", PROMO_SCOPE_KINDS).notNull().default("all"),
    scopeProductPublicIds: json("scope_product_public_ids").$type<string[]>().notNull(),
    scopeTierKeys: json("scope_tier_keys").$type<string[]>().notNull(),
    scopePacketNumbers: json("scope_packet_numbers").$type<number[]>().notNull(),
    minSubtotalMinor: amountMinorColumn("min_subtotal_minor").notNull().default(0),
    startsAt: utcDateTime("starts_at"),
    endsAt: utcDateTime("ends_at"),
    /** Maximum active redemptions across the entire promotion; null = unlimited (single-code) or bounded by generated codes (batch). */
    maxRedemptions: int("max_redemptions", { unsigned: true }),
    /** Maximum active redemptions per customer account (default 1). */
    maxPerCustomer: int("max_per_customer", { unsigned: true }).notNull().default(1),
    firstOrderOnly: boolean("first_order_only").notNull().default(false),
    allowCustomerPublicIds: json("allow_customer_public_ids").$type<string[]>().notNull(),
    allowEmailDomains: json("allow_email_domains").$type<string[]>().notNull(),
    combineWithBundle: boolean("combine_with_bundle").notNull().default(false),
    status: mysqlEnum("status", PROMO_STATUSES).notNull().default("active"),
    /** True when this promotion holds generated single-use batch codes rather than one shared code. */
    isBatch: boolean("is_batch").notNull().default(false),
    /** Optional uppercase prefix `[A-Z0-9-]` used when generating batch codes (never the secret part). */
    codePrefix: varchar("code_prefix", { length: 16 }),
    /** Total number of `promo_codes` rows belonging to this promotion (1 for single-code, 0..N for batch). */
    batchSize: int("batch_size", { unsigned: true }).notNull().default(0),
    /** Maintained inside redemption/release transactions under `FOR UPDATE` row lock. */
    redemptionCount: int("redemption_count", { unsigned: true }).notNull().default(0),
    note: varchar("note", { length: 500 }),
    createdByUserId: refColumn("created_by_user_id")
      .notNull()
      .references(() => users.id),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    index("promo_batches_status_id_idx").on(t.status, t.id),
    index("promo_batches_ends_at_idx").on(t.endsAt, t.id),
    index("promo_batches_type_id_idx").on(t.discountType, t.id),
    index("promo_batches_created_by_idx").on(t.createdByUserId),
  ],
);

export type PromoBatchRow = typeof promoBatches.$inferSelect;
export type NewPromoBatchRow = typeof promoBatches.$inferInsert;

/**
 * Individual redeemable code values (1 row for a single-code promotion; up to 5,000 per batch generation).
 */
export const promoCodes = mysqlTable(
  "promo_codes",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    batchId: refColumn("batch_id")
      .notNull()
      .references(() => promoBatches.id),
    /** HMAC-SHA256 blind index (`FieldCrypto.blindIndex(normalizedCode, "promo_codes.code")`). */
    codeIndex: char("code_index", { length: 64 }).notNull(),
    /** AES-256-GCM envelope (`FieldCrypto.encrypt(normalizedCode, "promo_codes.code_enc:" + publicId)`). */
    codeEnc: text("code_enc").notNull(),
    /** Per-code cap (`1` for batch single-use codes; `null` defers to `promo_batches.max_redemptions`). */
    maxUses: int("max_uses", { unsigned: true }),
    /** Active non-released redemptions against this specific code row. */
    redemptionCount: int("redemption_count", { unsigned: true }).notNull().default(0),
    status: mysqlEnum("status", PROMO_STATUSES).notNull().default("active"),
    /** Idempotency correlation for `generateBatch` replays (`null` on initial single-code creation). */
    generationKey: varchar("generation_key", { length: 80 }),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex("promo_codes_code_index_uq").on(t.codeIndex),
    index("promo_codes_batch_id_idx").on(t.batchId, t.id),
    index("promo_codes_batch_gen_idx").on(t.batchId, t.generationKey),
  ],
);

export type PromoCodeRow = typeof promoCodes.$inferSelect;
export type NewPromoCodeRow = typeof promoCodes.$inferInsert;

/**
 * Atomic redemption ledger written inside the order-creation transaction.
 * Active slot columns (`active_code_sequence`, `active_batch_sequence`, `active_code_slot`) are non-null while
 * `status = "redeemed"` and set to `NULL` when `status = "released"` on pre-payment order cancellation.
 */
export const promoRedemptions = mysqlTable(
  "promo_redemptions",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    batchId: refColumn("batch_id")
      .notNull()
      .references(() => promoBatches.id),
    promoCodeId: refColumn("promo_code_id")
      .notNull()
      .references(() => promoCodes.id),
    customerUserId: refColumn("customer_user_id")
      .notNull()
      .references(() => users.id),
    actorUserId: refColumn("actor_user_id")
      .notNull()
      .references(() => users.id),
    orderPublicId: char("order_public_id", { length: 26 }).notNull(),
    status: mysqlEnum("status", PROMO_REDEMPTION_STATUSES).notNull().default("redeemed"),
    /** Immutable 1-based customer redemption ordinal at redemption time (kept for audit when released). */
    customerSequence: int("customer_sequence", { unsigned: true }).notNull(),
    /** Active 1..maxPerCustomer slot on `(promo_code_id, customer_user_id)`; `NULL` once released. */
    activeCodeSequence: int("active_code_sequence", { unsigned: true }),
    /** Active 1..maxPerCustomer slot on `(batch_id, customer_user_id)`; `NULL` once released. */
    activeBatchSequence: int("active_batch_sequence", { unsigned: true }),
    /** Active 1..maxUses global slot on `promo_code_id` when per-code or total cap applies; `NULL` once released. */
    activeCodeSlot: int("active_code_slot", { unsigned: true }),
    currency: currencyColumn().notNull(),
    subtotalMinor: amountMinorColumn("subtotal_minor").notNull(),
    promoDiscountMinor: amountMinorColumn("promo_discount_minor").notNull(),
    bundleDiscountMinor: amountMinorColumn("bundle_discount_minor").notNull(),
    discountMinor: amountMinorColumn("discount_minor").notNull(),
    totalMinor: amountMinorColumn("total_minor").notNull(),
    labelSnapshot: varchar("label_snapshot", { length: 120 }).notNull(),
    correlationId: varchar("correlation_id", { length: 64 }).notNull(),
    releasedAt: utcDateTime("released_at"),
    releaseReason: varchar("release_reason", { length: 48 }),
    releaseNote: varchar("release_note", { length: 240 }),
    releasedByUserId: refColumn("released_by_user_id").references(() => users.id),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex("promo_redemptions_order_uq").on(t.orderPublicId),
    uniqueIndex("promo_redemptions_code_order_uq").on(t.promoCodeId, t.orderPublicId),
    uniqueIndex("promo_redemptions_code_cust_seq_uq").on(
      t.promoCodeId,
      t.customerUserId,
      t.activeCodeSequence,
    ),
    uniqueIndex("promo_redemptions_batch_cust_seq_uq").on(
      t.batchId,
      t.customerUserId,
      t.activeBatchSequence,
    ),
    uniqueIndex("promo_redemptions_code_slot_uq").on(t.promoCodeId, t.activeCodeSlot),
    index("promo_redemptions_batch_id_idx").on(t.batchId, t.id),
    index("promo_redemptions_customer_idx").on(t.customerUserId, t.status, t.id),
    index("promo_redemptions_status_curr_idx").on(t.status, t.currency),
  ],
);

export type PromoRedemptionRow = typeof promoRedemptions.$inferSelect;
export type NewPromoRedemptionRow = typeof promoRedemptions.$inferInsert;

/**
 * Durable per-account failed code-check tracker (Decision D3):
 * 5 failed checks within 15 minutes pauses code checks for that account for 15 minutes and emits
 * `promotion.attempts_blocked` (`WARN`, forwarded to SIEM).
 */
export const promoCheckAttempts = mysqlTable(
  "promo_check_attempts",
  {
    id: idColumn(),
    userId: refColumn("user_id")
      .notNull()
      .references(() => users.id),
    failedCount: int("failed_count", { unsigned: true }).notNull().default(0),
    windowStartedAt: utcDateTime("window_started_at").notNull(),
    blockedUntil: utcDateTime("blocked_until"),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex("promo_check_attempts_user_uq").on(t.userId),
    index("promo_check_attempts_blocked_idx").on(t.blockedUntil),
  ],
);

export type PromoCheckAttemptRow = typeof promoCheckAttempts.$inferSelect;
export type NewPromoCheckAttemptRow = typeof promoCheckAttempts.$inferInsert;
