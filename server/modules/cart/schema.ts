/**
 * Cart & checkout additive database schema (Increment 04, Package L).
 * Owner: recovery_ops_engineer.
 *
 * Invariants:
 *  - At most ONE open cart per customer (`active_owner_slot` = `owner_user_id` iff `status = 'open'`, else NULL).
 *  - At most ONE tier per packet number in a cart (`UNIQUE(cart_id, packet_number)`).
 *  - Prices, bundle discounts, and tax are NEVER stored as authoritative cart inputs; they are always recomputed
 *    server-side from the live catalogue and compliance tax settings on read and inside the checkout transaction.
 */
import { char, foreignKey, index, int, mysqlEnum, mysqlTable, text, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
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
    checkedOutTaxRateBps: int("checked_out_tax_rate_bps", { unsigned: true }),
    checkedOutTaxMinor: amountMinorColumn("checked_out_tax_minor"),
    checkedOutTotalMinor: amountMinorColumn("checked_out_total_minor"),
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

export type CartRow = typeof carts.$inferSelect;
export type CartItemRow = typeof cartItems.$inferSelect;
