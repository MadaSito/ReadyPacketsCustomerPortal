/**
 * Cart, checkout, upsell offers, and applied discount-code database schema (Increments 04 & 05, Packages L & B).
 * Owner: recovery_ops_engineer.
 *
 * Invariants:
 *  - At most ONE open cart per customer (`active_owner_slot` = `owner_user_id` iff `status = 'open'`, else NULL).
 *  - At most ONE tier per packet number in a cart (`UNIQUE(cart_id, packet_number)`).
 *  - Prices, bundle discounts, promotional discounts, upsell savings, and tax are NEVER stored as authoritative cart
 *    inputs; they are always recomputed server-side from the live catalogue, promotions service, and compliance tax
 *    settings on read and inside the checkout transaction.
 *  - Applied promotional code values are stored strictly encrypted (`applied_promo_code_enc`, AAD
 *    `carts.promo_code:<publicId>`); plaintext codes are never persisted or logged.
 */
import {
  boolean,
  char,
  foreignKey,
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

export const CART_STATUSES = [
  "open",
  "awaiting_payment",
  "checked_out",
  "restored",
  "expired",
] as const;
export type CartStatus = (typeof CART_STATUSES)[number];

export const CART_PAYMENT_MODES = ["invoice", "redirect"] as const;
export type CartPaymentMode = (typeof CART_PAYMENT_MODES)[number];

export const CART_UPSELL_OFFER_KINDS = ["add_on", "tier_upgrade"] as const;
export type CartUpsellOfferKind = (typeof CART_UPSELL_OFFER_KINDS)[number];

export const CART_UPSELL_RULE_TYPES = ["standard", "next_packet", "bundle_completion"] as const;
export type CartUpsellRuleType = (typeof CART_UPSELL_RULE_TYPES)[number];

export const CART_UPSELL_TRIGGER_MODES = ["any_cart", "products"] as const;
export type CartUpsellTriggerMode = (typeof CART_UPSELL_TRIGGER_MODES)[number];

export const carts = mysqlTable(
  "carts",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    ownerUserId: refColumn("owner_user_id").notNull(),
    /** Non-null (`= ownerUserId`) strictly while `status = 'open'`; NULL otherwise to enforce 1 open cart per customer. */
    activeOwnerSlot: refColumn("active_owner_slot"),
    status: mysqlEnum("status", CART_STATUSES).notNull().default("open"),
    projectName: varchar("project_name", { length: 160 }),
    /** Optional AES-256-GCM encrypted customer order note (`carts.note:<publicId>`). */
    noteEnc: text("note_enc"),
    /** Optional AES-256-GCM encrypted JSON billing contact/address draft (`carts.billing:<publicId>`). */
    billingEnc: text("billing_enc"),
    billingCountry: char("billing_country", { length: 2 }),
    billingRegion: varchar("billing_region", { length: 64 }),
    /** Optional AES-256-GCM encrypted normalised discount code (`carts.promo_code:<publicId>`). */
    appliedPromoCodeEnc: text("applied_promo_code_enc"),
    /** Public ID of the applied promotion definition (safe non-secret identifier for audit/status). */
    appliedPromoPublicId: char("applied_promo_public_id", { length: 26 }),
    /** Customer-facing promotion label snapshot from when the code was applied. */
    appliedPromoLabel: varchar("applied_promo_label", { length: 120 }),
    /** Last idempotency key accepted by `cart.applyCode` on this cart for replay protection. */
    appliedPromoIdempotencyKey: varchar("applied_promo_idempotency_key", { length: 128 }),
    checkoutIdempotencyKey: varchar("checkout_idempotency_key", { length: 128 }),
    checkoutOrderId: refColumn("checkout_order_id"),
    checkoutOrderPublicId: char("checkout_order_public_id", { length: 26 }),
    checkoutOrderReference: varchar("checkout_order_reference", { length: 48 }),
    checkoutInvoiceId: refColumn("checkout_invoice_id"),
    checkoutInvoicePublicId: char("checkout_invoice_public_id", { length: 26 }),
    checkoutInvoiceNumber: varchar("checkout_invoice_number", { length: 48 }),
    paymentMode: mysqlEnum("payment_mode", CART_PAYMENT_MODES),
    paymentAttemptPublicId: char("payment_attempt_public_id", { length: 26 }),
    checkedOutCurrency: currencyColumn("checked_out_currency"),
    checkedOutSubtotalMinor: amountMinorColumn("checked_out_subtotal_minor"),
    checkedOutDiscountMinor: amountMinorColumn("checked_out_discount_minor"),
    checkedOutDiscountLabel: varchar("checked_out_discount_label", { length: 120 }),
    checkedOutPromoDiscountMinor: amountMinorColumn("checked_out_promo_discount_minor"),
    checkedOutPromoLabel: varchar("checked_out_promo_label", { length: 120 }),
    checkedOutTaxRateBps: int("checked_out_tax_rate_bps", { unsigned: true }),
    checkedOutTaxMinor: amountMinorColumn("checked_out_tax_minor"),
    checkedOutTotalMinor: amountMinorColumn("checked_out_total_minor"),
    /** Non-null when `payments.small_totals` waived a sub-minimum balance at checkout (Increment 06, D5). */
    checkedOutWaivedMinor: amountMinorColumn("checked_out_waived_minor"),
    restoredIntoCartPublicId: char("restored_into_cart_public_id", { length: 26 }),
    lastActivityAt: utcDateTime("last_activity_at").notNull(),
    checkedOutAt: utcDateTime("checked_out_at"),
    restoredAt: utcDateTime("restored_at"),
    expiredAt: utcDateTime("expired_at"),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    foreignKey({
      name: "cart_owner_user_fk",
      columns: [t.ownerUserId],
      foreignColumns: [users.id],
    }),
    uniqueIndex("cart_active_owner_uq").on(t.activeOwnerSlot),
    uniqueIndex("cart_owner_idem_uq").on(t.ownerUserId, t.checkoutIdempotencyKey),
    index("cart_st_activity_idx").on(t.status, t.lastActivityAt),
    index("cart_owner_st_idx").on(t.ownerUserId, t.status, t.updatedAt),
    index("cart_attempt_pub_idx").on(t.paymentAttemptPublicId),
    index("cart_inv_pub_idx").on(t.checkoutInvoicePublicId),
  ],
);

export const cartItems = mysqlTable(
  "cart_items",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    cartId: refColumn("cart_id").notNull(),
    productPublicId: char("product_public_id", { length: 26 }).notNull(),
    /** Non-null for packet products; DB unique index enforces at most one tier per packet in any cart. */
    packetNumber: int("packet_number", { unsigned: true }),
    quantity: int("quantity", { unsigned: true }).notNull().default(1),
    position: int("position", { unsigned: true }).notNull().default(0),
    /** Post-checkout immutable snapshot metadata (never used as input to pricing). */
    snapshotName: varchar("snapshot_name", { length: 160 }),
    snapshotTier: varchar("snapshot_tier", { length: 32 }),
    snapshotUnitPriceMinor: amountMinorColumn("snapshot_unit_price_minor"),
    snapshotCurrency: currencyColumn("snapshot_currency"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    foreignKey({
      name: "cart_item_cart_fk",
      columns: [t.cartId],
      foreignColumns: [carts.id],
    }).onDelete("cascade"),
    uniqueIndex("cart_item_cart_prod_uq").on(t.cartId, t.productPublicId),
    uniqueIndex("cart_item_cart_pkt_uq").on(t.cartId, t.packetNumber),
    index("cart_item_cart_pos_idx").on(t.cartId, t.position, t.id),
  ],
);

/**
 * Administrator-managed cart upsell offers (Decision D2, capability `carts.upsells.manage`).
 * Automatic bundle-completion suggestions are derived live from the catalogue bundle rule rather than stored as rows.
 */
export const cartUpsellOffers = mysqlTable(
  "cart_upsell_offers",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    /** Stable idempotency key for catalogue-seeded offers (Increment 06, D3); NULL for manual admin offers. */
    seedKey: varchar("seed_key", { length: 96 }),
    kind: mysqlEnum("kind", CART_UPSELL_OFFER_KINDS).notNull(),
    /** Distinguishes standard add-on/tier-upgrade rows from seeded `next_packet` and `bundle_completion` rows (D3). */
    ruleType: varchar("rule_type", { length: 32 }).notNull().default("standard"),
    title: varchar("title", { length: 120 }).notNull(),
    shortText: varchar("short_text", { length: 200 }).notNull(),
    triggerMode: mysqlEnum("trigger_mode", CART_UPSELL_TRIGGER_MODES).notNull().default("products"),
    /** Array of 26-char product public IDs when `trigger_mode = 'products'`; empty `[]` for `'any_cart'`. */
    triggerProductPublicIds: json("trigger_product_public_ids").$type<string[]>().notNull(),
    targetProductPublicId: char("target_product_public_id", { length: 26 }).notNull(),
    /** Lower numbers appear first (`10` before `20`), tie-broken by `id ASC`. */
    priority: int("priority").notNull().default(100),
    active: boolean("active").notNull().default(true),
    startsAt: utcDateTime("starts_at"),
    endsAt: utcDateTime("ends_at"),
    shownCount: int("shown_count", { unsigned: true }).notNull().default(0),
    acceptedCount: int("accepted_count", { unsigned: true }).notNull().default(0),
    dismissedCount: int("dismissed_count", { unsigned: true }).notNull().default(0),
    createdByUserId: refColumn("created_by_user_id"),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    foreignKey({
      name: "cart_upsell_offer_creator_fk",
      columns: [t.createdByUserId],
      foreignColumns: [users.id],
    }).onDelete("set null"),
    index("cart_upsell_offer_active_prio_idx").on(t.active, t.priority, t.id),
    index("cart_upsell_offer_target_idx").on(t.targetProductPublicId),
    uniqueIndex("cart_upsell_offer_seed_key_uq").on(t.seedKey),
  ],
);

/**
 * Per-cart impression and dismissal tracking for upsell suggestions (both `cart_upsell_offers` rows and the
 * synthetic `"bundle_completion"` suggestion). Prevents `shownCount` / `dismissedCount` inflation on repeated reads.
 */
export const cartUpsellCartStates = mysqlTable(
  "cart_upsell_cart_states",
  {
    id: idColumn(),
    cartId: refColumn("cart_id").notNull(),
    /** Non-null when backed by a `cart_upsell_offers` row; NULL for `"bundle_completion"`. */
    offerId: refColumn("offer_id"),
    offerKey: varchar("offer_key", { length: 64 }).notNull(),
    firstShownAt: utcDateTime("first_shown_at"),
    dismissedAt: utcDateTime("dismissed_at"),
    acceptedAt: utcDateTime("accepted_at"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    foreignKey({
      name: "cart_upsell_state_cart_fk",
      columns: [t.cartId],
      foreignColumns: [carts.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "cart_upsell_state_offer_fk",
      columns: [t.offerId],
      foreignColumns: [cartUpsellOffers.id],
    }).onDelete("cascade"),
    uniqueIndex("cart_upsell_state_cart_key_uq").on(t.cartId, t.offerKey),
    index("cart_upsell_state_offer_idx").on(t.offerId),
  ],
);

/**
 * Idempotency log for `cart.upsell.accept` (`UNIQUE(cart_id, idempotency_key)` ensures replays have one effect).
 */
export const cartUpsellAcceptances = mysqlTable(
  "cart_upsell_acceptances",
  {
    id: idColumn(),
    cartId: refColumn("cart_id").notNull(),
    offerId: refColumn("offer_id"),
    offerKey: varchar("offer_key", { length: 64 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    addedProductPublicIds: json("added_product_public_ids").$type<string[]>().notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    foreignKey({
      name: "cart_upsell_acc_cart_fk",
      columns: [t.cartId],
      foreignColumns: [carts.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "cart_upsell_acc_offer_fk",
      columns: [t.offerId],
      foreignColumns: [cartUpsellOffers.id],
    }).onDelete("set null"),
    uniqueIndex("cart_upsell_acc_cart_idem_uq").on(t.cartId, t.idempotencyKey),
    index("cart_upsell_acc_offer_idx").on(t.offerId),
  ],
);

export type CartRow = typeof carts.$inferSelect;
export type CartItemRow = typeof cartItems.$inferSelect;
export type CartUpsellOfferRow = typeof cartUpsellOffers.$inferSelect;
export type CartUpsellCartStateRow = typeof cartUpsellCartStates.$inferSelect;
export type CartUpsellAcceptanceRow = typeof cartUpsellAcceptances.$inferSelect;
