/**
 * Payments module — Drizzle MySQL tables (Increment 04, Package K).
 * Owner: compliance_engineer.
 *
 * Additive tables only:
 *  - `payment_attempts`: Hosted Stripe Checkout Session / Square Payment Link lifecycle (`created -> redirected -> paid | failed | expired | cancelled`) with compare-and-set `version` and encrypted redirect capability URL.
 *  - `payment_webhook_events`: Deduplicated, signature-verified provider webhook receipts (`provider, external_event_id`) with SHA-256 payload digest for replay vs tamper detection.
 */
import {
  char,
  foreignKey,
  index,
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

export const PAYMENT_PROVIDER_CHOICES = ["none", "stripe", "square"] as const;
export type PaymentProviderChoice = (typeof PAYMENT_PROVIDER_CHOICES)[number];

export const ACTIVE_PAYMENT_PROVIDERS = ["stripe", "square"] as const;
export type ActivePaymentProvider = (typeof ACTIVE_PAYMENT_PROVIDERS)[number];

export const PAYMENT_ENVIRONMENT_MODES = ["test", "live"] as const;
export type PaymentEnvironmentMode = (typeof PAYMENT_ENVIRONMENT_MODES)[number];

export const PAYMENT_ATTEMPT_STATUSES = [
  "created",
  "redirected",
  "paid",
  "failed",
  "expired",
  "cancelled",
] as const;
export type PaymentAttemptStatus = (typeof PAYMENT_ATTEMPT_STATUSES)[number];

export const PAYMENT_WEBHOOK_STATUSES = [
  "processed",
  "ignored",
  "retry_pending",
  "verification_mismatch",
] as const;
export type PaymentWebhookStatus = (typeof PAYMENT_WEBHOOK_STATUSES)[number];

export const paymentAttempts = mysqlTable(
  "payment_attempts",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    /** Logical reference to `compliance_invoices.id` (no cross-module FK; verified via `services.compliance`). */
    invoiceId: refColumn("invoice_id").notNull(),
    invoicePublicId: char("invoice_public_id", { length: 26 }).notNull(),
    orderPublicId: char("order_public_id", { length: 26 }).notNull(),
    cartPublicId: char("cart_public_id", { length: 26 }),
    customerUserId: refColumn("customer_user_id").notNull(),
    provider: mysqlEnum("provider", ACTIVE_PAYMENT_PROVIDERS).notNull(),
    environment: mysqlEnum("environment", PAYMENT_ENVIRONMENT_MODES).notNull(),
    status: mysqlEnum("status", PAYMENT_ATTEMPT_STATUSES).notNull().default("created"),
    amountMinor: amountMinorColumn("amount_minor").notNull(),
    currency: currencyColumn("currency").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    successPath: varchar("success_path", { length: 200 }).notNull(),
    cancelPath: varchar("cancel_path", { length: 200 }).notNull(),
    /** Stripe Checkout Session ID (`cs_...`) or Square Payment Link ID. */
    providerRef: varchar("provider_ref", { length: 128 }),
    /** Secondary provider correlation ref (Square `order_id` or Stripe `payment_intent` id). */
    providerOrderRef: varchar("provider_order_ref", { length: 128 }),
    /** Confirmed provider payment/charge id populated once `fetchPayment` verifies payment. */
    providerPaymentRef: varchar("provider_payment_ref", { length: 128 }),
    /** AES-256-GCM encrypted hosted checkout URL (`payment_attempts.redirect_url:<publicId>`). */
    redirectUrlEnc: text("redirect_url_enc"),
    /** External event ID of the verified signed webhook that authorized Decision 12 booking. */
    verifiedWebhookEventId: varchar("verified_webhook_event_id", { length: 128 }),
    /** Resulting `compliance_invoice_payments.public_id` once booked. */
    compliancePaymentPublicId: char("compliance_payment_public_id", { length: 26 }),
    /** Non-secret operator note (e.g. `awaiting_webhook` when poll sees paid before signed webhook arrives). */
    reconciliationNote: varchar("reconciliation_note", { length: 120 }),
    failureReasonCode: varchar("failure_reason_code", { length: 64 }),
    redirectedAt: utcDateTime("redirected_at"),
    expiresAt: utcDateTime("expires_at"),
    paidAt: utcDateTime("paid_at"),
    cancelledAt: utcDateTime("cancelled_at"),
    lastReconciledAt: utcDateTime("last_reconciled_at"),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    foreignKey({
      name: "pmt_att_cust_user_fk",
      columns: [t.customerUserId],
      foreignColumns: [users.id],
    }),
    uniqueIndex("pmt_att_inv_idem_uq").on(t.invoiceId, t.idempotencyKey),
    uniqueIndex("pmt_att_prov_ref_uq").on(t.provider, t.providerRef),
    index("pmt_att_inv_pub_idx").on(t.invoicePublicId, t.id),
    index("pmt_att_cust_idx").on(t.customerUserId, t.id),
    index("pmt_att_st_exp_idx").on(t.status, t.expiresAt),
    index("pmt_att_prov_ord_idx").on(t.provider, t.providerOrderRef),
  ],
);

export const paymentWebhookEvents = mysqlTable(
  "payment_webhook_events",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    provider: mysqlEnum("provider", ACTIVE_PAYMENT_PROVIDERS).notNull(),
    environment: mysqlEnum("environment", PAYMENT_ENVIRONMENT_MODES).notNull(),
    externalEventId: varchar("external_event_id", { length: 128 }).notNull(),
    eventType: varchar("event_type", { length: 96 }).notNull(),
    payloadSha256: char("payload_sha256", { length: 64 }).notNull(),
    attemptId: refColumn("attempt_id"),
    attemptPublicId: char("attempt_public_id", { length: 26 }),
    providerRef: varchar("provider_ref", { length: 128 }),
    providerOrderRef: varchar("provider_order_ref", { length: 128 }),
    providerPaymentRef: varchar("provider_payment_ref", { length: 128 }),
    status: mysqlEnum("status", PAYMENT_WEBHOOK_STATUSES).notNull(),
    reasonCode: varchar("reason_code", { length: 64 }),
    occurredAt: utcDateTime("occurred_at").notNull(),
    receivedAt: utcDateTime("received_at").notNull(),
    processedAt: utcDateTime("processed_at"),
  },
  (t) => [
    foreignKey({
      name: "pmt_wh_att_fk",
      columns: [t.attemptId],
      foreignColumns: [paymentAttempts.id],
    }),
    uniqueIndex("pmt_wh_prov_ext_uq").on(t.provider, t.externalEventId),
    index("pmt_wh_st_rec_idx").on(t.status, t.receivedAt),
    index("pmt_wh_att_idx").on(t.attemptId),
  ],
);

export type PaymentAttemptRow = typeof paymentAttempts.$inferSelect;
export type PaymentWebhookEventRow = typeof paymentWebhookEvents.$inferSelect;
