/**
 * Dataset whitelist (D6). The ONLY source of table, join and column names for custom reports. Read-only access
 * to other modules' tables, following the portable precedent. Encrypted, keyed-hash and secret columns
 * (`*Enc`, `*Index`, `*Key`, password, tokens, storage keys, IP addresses) are never listed. Internal numeric ids
 * are never output; public ids and customer numbers only. `personal: true` columns are shown only to roles that
 * may already see customer data (administrators); staff never receive them.
 */
import { and, eq, isNull, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { AnyMySqlColumn, MySqlTable } from "drizzle-orm/mysql-core";
import { USER_ROLES } from "../../../shared/domain.js";
import { carts, CART_STATUSES } from "../cart/schema.js";
import {
  complianceInvoicePayments, complianceInvoiceRefunds, complianceInvoices, compliancePaymentReceipts, INVOICE_STATUSES, PAYMENT_METHODS,
  PAYMENT_RECORD_STATUSES, RECEIPT_REFUND_STATES, RECEIPT_SETTLEMENT_KINDS,
} from "../compliance/schema.js";
import { engagementSupportTickets } from "../engagement/schema.js";
import { TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUSES } from "../engagement/types.js";
import { audioConversionStates, fileCategories, fileVisibilities, orderFiles } from "../files/schema.js";
import { liveUserPredicate } from "../identity/live.js";
import { signInEvents, SIGN_IN_EVENT_KINDS, USER_STATUSES, users } from "../identity/schema.js";
import { orderLineItems, orders, orderWorkflows, orderWorkflowVersions, ORDER_LOCK_STATES, ORDER_ORIGINS, PACKET_TIERS } from "../orders/schema.js";
import { liveOrderPredicate } from "../orders/trashGate.js";
import { promoBatches, promoRedemptions, PROMO_REDEMPTION_STATUSES } from "../promotions/schema.js";
import { referrals, REFERRAL_STATUSES } from "../referrals/schema.js";
import { AGGREGATES, BUCKETS, type Aggregate, type Bucket, type DatasetView, type FieldType, type FilterOp } from "./spec.js";

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  expr: AnyMySqlColumn | SQL;
  personal?: true;
  enumValues?: readonly string[];
  /** Derived values (durations) can be filtered and aggregated but not grouped. */
  noGroup?: true;
}

export interface JoinDef { table: MySqlTable; on: SQL }

export interface DatasetDef {
  key: string;
  label: string;
  description: string;
  from: MySqlTable;
  joins: readonly JoinDef[];
  /** Always applied (e.g. customers only). */
  base?: SQL;
  /** The datetime field used by built-in date ranges. */
  timeField: string;
  fields: readonly FieldDef[];
}

const DURATION_SECONDS = (from: SQLWrapper, to: SQLWrapper) => sql<number>`GREATEST(0, TIMESTAMPDIFF(SECOND, ${from}, ${to}))`;

const f = (key: string, label: string, type: FieldType, expr: AnyMySqlColumn | SQL, extra: Partial<FieldDef> = {}): FieldDef =>
  ({ key, label, type, expr, ...extra });
const e = (key: string, label: string, expr: AnyMySqlColumn | SQL, enumValues: readonly string[], extra: Partial<FieldDef> = {}) =>
  f(key, label, "enum", expr, { enumValues, ...extra });

const DATASETS: readonly DatasetDef[] = [
  {
    key: "orders",
    label: "Orders",
    description: "One row per order. Amounts are in minor units of the order currency.",
    from: orders,
    joins: [
      { table: users, on: eq(users.id, orders.ownerUserId) },
      { table: orderWorkflowVersions, on: eq(orderWorkflowVersions.id, orders.workflowVersionId) },
      { table: orderWorkflows, on: eq(orderWorkflows.id, orderWorkflowVersions.workflowId) },
    ],
    base: and(liveOrderPredicate(), liveUserPredicate()),
    timeField: "createdAt",
    fields: [
      f("orderPublicId", "Order ID", "string", orders.publicId),
      f("reference", "Order number", "string", orders.reference),
      f("customerNumber", "Customer number", "string", users.customerRef, { personal: true }),
      f("customerPublicId", "Customer ID", "string", users.publicId, { personal: true }),
      f("projectName", "Project name", "string", orders.projectName, { personal: true }),
      f("status", "Status", "string", orders.statusKey),
      f("workflow", "Workflow", "string", orderWorkflows.workflowKey),
      e("lockState", "Lock", orders.lockState, ORDER_LOCK_STATES),
      e("origin", "Origin", orders.origin, ORDER_ORIGINS),
      f("currency", "Currency", "string", orders.currency),
      f("subtotal", "Subtotal", "money", orders.subtotalMinor),
      f("discount", "Discount", "money", orders.discountMinor),
      f("promoDiscount", "Promo discount", "money", orders.promoDiscountMinor),
      f("promoLabel", "Promo label", "string", orders.promoLabel),
      f("total", "Total", "money", orders.totalMinor),
      f("createdAt", "Created", "datetime", orders.createdAt),
      f("submittedAt", "Submitted", "datetime", orders.submittedAt),
      f("updatedAt", "Last updated", "datetime", orders.updatedAt),
      f("ageSeconds", "Age", "duration", DURATION_SECONDS(orders.createdAt, sql`UTC_TIMESTAMP(3)`), { noGroup: true }),
    ],
  },
  {
    key: "order_items",
    label: "Order lines",
    description: "One row per order line with its product snapshot.",
    from: orderLineItems,
    joins: [
      { table: orders, on: eq(orders.id, orderLineItems.orderId) },
      { table: users, on: eq(users.id, orders.ownerUserId) },
    ],
    base: and(liveOrderPredicate(), liveUserPredicate()),
    timeField: "orderCreatedAt",
    fields: [
      f("reference", "Order number", "string", orders.reference),
      f("orderStatus", "Order status", "string", orders.statusKey),
      f("productPublicId", "Product ID", "string", orderLineItems.productPublicId),
      f("name", "Product", "string", orderLineItems.name),
      e("tier", "Tier", orderLineItems.tier, PACKET_TIERS),
      f("packetNumber", "Packet number", "number", orderLineItems.packetNumber),
      f("quantity", "Quantity", "number", orderLineItems.quantity),
      f("currency", "Currency", "string", orders.currency),
      f("unitPrice", "Unit price", "money", orderLineItems.unitPriceMinor),
      f("lineTotal", "Line total", "money", orderLineItems.lineTotalMinor),
      f("orderCreatedAt", "Order created", "datetime", orders.createdAt),
    ],
  },
  {
    key: "customers",
    label: "Customers",
    description: "Customer accounts. Names and e-mail addresses are encrypted and never reported.",
    from: users,
    joins: [],
    base: and(eq(users.role, "customer"), liveUserPredicate()),
    timeField: "createdAt",
    fields: [
      f("customerPublicId", "Customer ID", "string", users.publicId, { personal: true }),
      f("customerNumber", "Customer number", "string", users.customerRef, { personal: true }),
      e("status", "Lifecycle", users.status, USER_STATUSES),
      f("origin", "Origin", "string", users.origin),
      f("emailVerified", "E-mail verified", "boolean", sql<number>`(${users.emailVerifiedAt} IS NOT NULL)`),
      f("createdAt", "Joined", "datetime", users.createdAt),
      f("statusChangedAt", "Lifecycle changed", "datetime", users.statusChangedAt),
    ],
  },
  {
    key: "support_tickets",
    label: "Support tickets",
    description: "One row per ticket. Subjects and messages are encrypted and never reported.",
    from: engagementSupportTickets,
    joins: [
      { table: users, on: eq(users.id, engagementSupportTickets.requesterUserId) },
      { table: orders, on: eq(orders.id, engagementSupportTickets.relatedOrderId) },
    ],
    base: and(liveUserPredicate(), or(isNull(engagementSupportTickets.relatedOrderId), liveOrderPredicate())),
    timeField: "createdAt",
    fields: [
      f("ticketPublicId", "Ticket ID", "string", engagementSupportTickets.publicId),
      f("ticketNumber", "Ticket number", "string", engagementSupportTickets.ticketNumber),
      f("requesterPublicId", "Requester ID", "string", engagementSupportTickets.requesterUserPublicId, { personal: true }),
      f("orderReference", "Order number", "string", engagementSupportTickets.relatedOrderReference),
      f("assigneePublicId", "Assignee ID", "string", engagementSupportTickets.assigneeUserPublicId),
      e("category", "Category", engagementSupportTickets.category, TICKET_CATEGORIES),
      e("status", "Status", engagementSupportTickets.status, TICKET_STATUSES),
      e("priority", "Priority", engagementSupportTickets.priority, TICKET_PRIORITIES),
      f("origin", "Origin", "string", engagementSupportTickets.origin),
      f("createdAt", "Opened", "datetime", engagementSupportTickets.createdAt),
      f("lastMessageAt", "Last message", "datetime", engagementSupportTickets.lastMessageAt),
      f("resolvedAt", "Resolved", "datetime", engagementSupportTickets.resolvedAt),
      f("closedAt", "Closed", "datetime", engagementSupportTickets.closedAt),
      f("resolutionSeconds", "Time to resolution", "duration",
        DURATION_SECONDS(engagementSupportTickets.createdAt, sql`COALESCE(${engagementSupportTickets.resolvedAt}, ${engagementSupportTickets.closedAt})`),
        { noGroup: true }),
    ],
  },
  {
    key: "referrals",
    label: "Referrals",
    description: "One row per attributed referral. Reward amounts are in minor units.",
    from: referrals,
    joins: [],
    base: and(
      sql`EXISTS (SELECT 1 FROM ${users} u_rfr WHERE u_rfr.id = ${referrals.referrerUserId} AND u_rfr.trashed_at IS NULL AND u_rfr.purged_at IS NULL)`,
      sql`EXISTS (SELECT 1 FROM ${users} u_rfd WHERE u_rfd.id = ${referrals.referredUserId} AND u_rfd.trashed_at IS NULL AND u_rfd.purged_at IS NULL)`,
    ),
    timeField: "attributedAt",
    fields: [
      f("referralPublicId", "Referral ID", "string", referrals.publicId),
      e("status", "Status", referrals.status, REFERRAL_STATUSES),
      f("currency", "Currency", "string", referrals.currency),
      f("reward", "Reward", "money", referrals.rewardAmountMinor),
      f("qualifyingOrderPublicId", "Qualifying order ID", "string", referrals.qualifyingOrderPublicId),
      f("attributedAt", "Signed up", "datetime", referrals.attributedAt),
      f("qualifiedAt", "Converted", "datetime", referrals.qualifiedAt),
      f("creditedAt", "Rewarded", "datetime", referrals.creditedAt),
    ],
  },
  {
    key: "payments",
    label: "Payments",
    description: "Recorded invoice payments, including waivers. Amounts are in minor units.",
    from: complianceInvoicePayments,
    joins: [{ table: complianceInvoices, on: eq(complianceInvoices.id, complianceInvoicePayments.invoiceId) }],
    timeField: "receivedAt",
    fields: [
      f("paymentPublicId", "Payment ID", "string", complianceInvoicePayments.publicId),
      f("invoiceNumber", "Invoice number", "string", complianceInvoices.invoiceNumber),
      f("orderPublicId", "Order ID", "string", complianceInvoices.orderPublicId),
      e("method", "Method", complianceInvoicePayments.method, PAYMENT_METHODS),
      f("provider", "Provider", "string", sql<string>`COALESCE(${complianceInvoicePayments.provider}, ${complianceInvoicePayments.method})`),
      e("status", "Status", complianceInvoicePayments.status, PAYMENT_RECORD_STATUSES),
      e("invoiceStatus", "Invoice status", complianceInvoices.status, INVOICE_STATUSES),
      f("currency", "Currency", "string", complianceInvoicePayments.currency),
      f("amount", "Amount", "money", complianceInvoicePayments.amountMinor),
      f("receivedAt", "Received", "datetime", complianceInvoicePayments.receivedAt),
    ],
  },
  {
    key: "receipts",
    label: "Payment receipts",
    description: "Issued payment receipts (paid, waived and refunded amounts). Card brand, last four digits, provider references and receipt documents are never reported.",
    from: compliancePaymentReceipts,
    joins: [],
    timeField: "issuedAt",
    fields: [
      f("receiptNumber", "Receipt number", "string", compliancePaymentReceipts.receiptNumber),
      f("orderPublicId", "Order ID", "string", compliancePaymentReceipts.orderPublicId),
      f("orderReference", "Order reference", "string", compliancePaymentReceipts.orderReference),
      e("settlementKind", "Settlement", compliancePaymentReceipts.settlementKind, RECEIPT_SETTLEMENT_KINDS),
      e("paymentMethod", "Method", compliancePaymentReceipts.paymentMethod, PAYMENT_METHODS),
      f("provider", "Provider", "string", sql<string>`COALESCE(${compliancePaymentReceipts.provider}, ${compliancePaymentReceipts.paymentMethod})`),
      e("refundState", "Refund state", compliancePaymentReceipts.refundState, RECEIPT_REFUND_STATES),
      f("currency", "Currency", "string", compliancePaymentReceipts.currency),
      f("amountPaid", "Amount paid", "money", compliancePaymentReceipts.amountPaidMinor),
      f("amountWaived", "Amount waived", "money", compliancePaymentReceipts.amountWaivedMinor),
      f("refunded", "Refunded", "money", compliancePaymentReceipts.refundedMinor),
      f("issuedAt", "Issued", "datetime", compliancePaymentReceipts.issuedAt),
    ],
  },
  {
    key: "refunds",
    label: "Refunds",
    description: "Recorded refunds. Reasons are encrypted and never reported; the reason code is.",
    from: complianceInvoiceRefunds,
    joins: [],
    timeField: "refundedAt",
    fields: [
      f("refundPublicId", "Refund ID", "string", complianceInvoiceRefunds.publicId),
      f("reasonCode", "Reason code", "string", complianceInvoiceRefunds.reasonCode),
      f("provider", "Provider", "string", sql<string>`COALESCE(${complianceInvoiceRefunds.provider}, 'manual')`),
      f("currency", "Currency", "string", complianceInvoiceRefunds.currency),
      f("amount", "Amount", "money", complianceInvoiceRefunds.amountMinor),
      f("refundedAt", "Refunded", "datetime", complianceInvoiceRefunds.refundedAt),
    ],
  },
  {
    key: "promo_redemptions",
    label: "Promotion redemptions",
    description: "One row per code redemption. Code values are never reported; batch and label snapshot are.",
    from: promoRedemptions,
    joins: [
      { table: orders, on: eq(orders.publicId, promoRedemptions.orderPublicId) },
      { table: promoBatches, on: eq(promoBatches.id, promoRedemptions.batchId) },
    ],
    timeField: "createdAt",
    fields: [
      f("redemptionPublicId", "Redemption ID", "string", promoRedemptions.publicId),
      f("batchPublicId", "Batch ID", "string", promoBatches.publicId),
      f("label", "Promotion", "string", promoRedemptions.labelSnapshot),
      e("status", "Status", promoRedemptions.status, PROMO_REDEMPTION_STATUSES),
      f("reference", "Order number", "string", orders.reference),
      f("currency", "Currency", "string", promoRedemptions.currency),
      f("promoDiscount", "Promo discount", "money", promoRedemptions.promoDiscountMinor),
      f("discount", "Total discount", "money", promoRedemptions.discountMinor),
      f("total", "Order total", "money", promoRedemptions.totalMinor),
      f("createdAt", "Redeemed", "datetime", promoRedemptions.createdAt),
    ],
  },
  {
    key: "carts",
    label: "Carts",
    description: "One row per cart. Notes, billing details and applied codes are encrypted and never reported.",
    from: carts,
    joins: [
      { table: users, on: eq(users.id, carts.ownerUserId) },
      { table: orders, on: eq(orders.id, carts.checkoutOrderId) },
    ],
    base: and(liveUserPredicate(), or(isNull(carts.checkoutOrderId), liveOrderPredicate())),
    timeField: "createdAt",
    fields: [
      f("cartPublicId", "Cart ID", "string", carts.publicId),
      e("status", "Status", carts.status, CART_STATUSES),
      f("orderReference", "Order number", "string", carts.checkoutOrderReference),
      f("promoLabel", "Promo label", "string", carts.checkedOutPromoLabel),
      f("currency", "Currency", "string", carts.checkedOutCurrency),
      f("total", "Checked-out total", "money", carts.checkedOutTotalMinor),
      f("createdAt", "Created", "datetime", carts.createdAt),
      f("lastActivityAt", "Last activity", "datetime", carts.lastActivityAt),
      f("checkedOutAt", "Checked out", "datetime", carts.checkedOutAt),
      f("expiredAt", "Expired", "datetime", carts.expiredAt),
    ],
  },
  {
    key: "files",
    label: "Files and recordings",
    description: "One row per stored file version. File names and transcripts are encrypted and never reported.",
    from: orderFiles,
    joins: [
      { table: orders, on: eq(orders.id, orderFiles.orderId) },
      { table: users, on: eq(users.id, orders.ownerUserId) },
    ],
    base: and(liveOrderPredicate(), liveUserPredicate()),
    timeField: "createdAt",
    fields: [
      f("filePublicId", "File ID", "string", orderFiles.publicId),
      f("reference", "Order number", "string", orders.reference),
      e("category", "Category", orderFiles.category, fileCategories),
      e("visibility", "Visibility", orderFiles.visibility, fileVisibilities),
      f("contentType", "Content type", "string", orderFiles.contentType),
      f("extension", "Extension", "string", orderFiles.extension),
      f("recording", "Audio or video", "boolean", sql<number>`(${orderFiles.contentType} LIKE 'audio/%' OR ${orderFiles.contentType} LIKE 'video/%')`),
      e("conversionState", "Conversion", orderFiles.conversionState, audioConversionStates),
      f("sizeBytes", "Size (bytes)", "number", orderFiles.byteSize),
      f("durationSeconds", "Duration", "duration", sql<number>`(${orderFiles.durationMs} / 1000)`, { noGroup: true }),
      f("createdAt", "Uploaded", "datetime", orderFiles.createdAt),
      f("deletedAt", "Deleted", "datetime", orderFiles.deletedAt),
    ],
  },
  {
    key: "sign_ins",
    label: "Sign-in events",
    description: "Sign-in, failure and session events. IP addresses are encrypted and never reported.",
    from: signInEvents,
    joins: [],
    timeField: "occurredAt",
    fields: [
      e("kind", "Event", signInEvents.kind, SIGN_IN_EVENT_KINDS),
      f("reasonCode", "Reason code", "string", signInEvents.reasonCode),
      e("role", "Role", signInEvents.role, USER_ROLES),
      f("authMethod", "Method", "string", signInEvents.authMethod),
      f("country", "Country", "string", signInEvents.country, { personal: true }),
      f("occurredAt", "Time", "datetime", signInEvents.occurredAt),
    ],
  },
];

const BY_KEY = new Map(DATASETS.map((d) => [d.key, d]));

export function getDataset(key: string): DatasetDef | undefined {
  return BY_KEY.get(key);
}

export function fieldOf(dataset: DatasetDef, key: string): FieldDef | undefined {
  return dataset.fields.find((field) => field.key === key);
}

const STRING_OPS: readonly FilterOp[] = ["eq", "neq", "in", "contains", "startsWith", "isNull", "isNotNull"];
const ENUM_OPS: readonly FilterOp[] = ["eq", "neq", "in", "isNull", "isNotNull"];
const ORDERED_OPS: readonly FilterOp[] = ["eq", "neq", "gt", "gte", "lt", "lte", "between", "isNull", "isNotNull"];
const BOOLEAN_OPS: readonly FilterOp[] = ["eq", "isNull", "isNotNull"];

export function filterOpsFor(type: FieldType): readonly FilterOp[] {
  switch (type) {
    case "string": return STRING_OPS;
    case "enum": return ENUM_OPS;
    case "boolean": return BOOLEAN_OPS;
    default: return ORDERED_OPS;
  }
}

export function aggregatesFor(type: FieldType): readonly Aggregate[] {
  if (type === "number" || type === "money" || type === "duration") return AGGREGATES;
  if (type === "datetime") return ["count", "min", "max"];
  return ["count"];
}

export function bucketsFor(field: FieldDef): readonly Bucket[] {
  return field.type === "datetime" ? BUCKETS : [];
}

/** Catalogue view. Personal fields are omitted entirely for roles that may not see them. */
export function datasetViews(includePersonal: boolean): DatasetView[] {
  return DATASETS.map((d) => ({
    key: d.key,
    label: d.label,
    description: d.description,
    fields: d.fields.filter((field) => includePersonal || !field.personal).map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      personal: Boolean(field.personal),
      ...(field.enumValues ? { enumValues: field.enumValues } : {}),
      filterOps: filterOpsFor(field.type),
      groupable: !field.noGroup,
      buckets: bucketsFor(field),
      aggregates: aggregatesFor(field.type),
    })),
  }));
}

export const DATASET_KEYS: readonly string[] = DATASETS.map((d) => d.key);
