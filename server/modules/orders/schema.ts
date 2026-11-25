/**
 * Orders module — Drizzle MySQL tables. Owner: orders module engineer.
 *
 * Catalog products are versioned: every price/name/feature change writes a NEW immutable
 * `catalog_product_versions` row; order line items snapshot the version they were bought at.
 * Workflow definitions are versioned the same way; each order is bound to the version it started on.
 * Every order reference ever assigned lives in `order_references` (unique) so a retired value can never
 * be reused.
 */
import {
  boolean,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  tinyint,
  uniqueIndex,
  varchar,
  char,
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
import type { WorkflowDefinition } from "./workflowTypes.js";
import type { WorkflowDraftDefinition, WorkflowLayout } from "./workflowDesign.js";

export const ORDER_LOCK_STATES = ["none", "review", "finalized", "legal_hold", "imported_read_only"] as const;
export const GRANT_ROLES = ["viewer", "contributor"] as const;
export const GRANT_STATUSES = ["pending", "active", "declined", "revoked"] as const;
export const NOTE_VISIBILITIES = ["customer", "internal"] as const;
export const ORDER_ORIGINS = ["portal", "import"] as const;
/** Packet tiers (Master Offerings Matrix v3.0). A product with a tier is a packet product. */
export const PACKET_TIERS = ["Basic", "Standard", "Premium"] as const;
/** Increment 07 (D2/D9): order attention and payment state (written by orders in the status / stage / payment tx). */
export const ORDER_ATTENTION = ["none", "staff_review", "customer_response"] as const;
export type OrderAttention = (typeof ORDER_ATTENTION)[number];
export const ORDER_PAYMENT_STATES = ["not_required", "unpaid", "pending_async", "paid", "partially_refunded", "refunded"] as const;
export type OrderPaymentState = (typeof ORDER_PAYMENT_STATES)[number];
/** Increment 07 (D1): stored stage states (`future` is derived, never stored). */
export const STAGE_PROGRESS_STATES = ["open", "submitted", "in_review", "accepted", "reopened"] as const;
export const STAGE_REVIEW_OUTCOMES = ["accepted", "changes_requested"] as const;
export const STAGE_COMPLETION_KINDS = ["next", "submit", "review", "payment", "status"] as const;
export type PacketTier = (typeof PACKET_TIERS)[number];
export interface Deliverable {
  title: string;
  detail: string;
}

/* ------------------------------------------------------------------ catalog */

export const catalogGroups = mysqlTable(
  "catalog_groups",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    /** Stable import key (e.g. "packet-1"); null for groups created by hand. */
    groupKey: varchar("group_key", { length: 64 }),
    /** Set for packet groups only. */
    packetNumber: tinyint("packet_number", { unsigned: true }),
    name: varchar("name", { length: 120 }).notNull(),
    description: varchar("description", { length: 1000 }).notNull().default(""),
    sortOrder: int("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    index("catalog_groups_sort_idx").on(t.active, t.sortOrder),
    uniqueIndex("catalog_groups_group_key_uq").on(t.groupKey),
    uniqueIndex("catalog_groups_packet_number_uq").on(t.packetNumber),
  ],
);

export const catalogProducts = mysqlTable(
  "catalog_products",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    groupId: refColumn("group_id").notNull(),
    /** Stable admin-chosen key, unique (lowercase slug). */
    productKey: varchar("product_key", { length: 64 }).notNull(),
    /** Packet products: both set (and equal to the group's packet number); otherwise both null. */
    packetNumber: tinyint("packet_number", { unsigned: true }),
    tier: mysqlEnum("tier", PACKET_TIERS),
    currentVersionId: refColumn("current_version_id"),
    sortOrder: int("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex("catalog_products_key_uq").on(t.productKey),
    uniqueIndex("catalog_products_packet_tier_uq").on(t.packetNumber, t.tier),
    index("catalog_products_group_idx").on(t.groupId, t.active, t.sortOrder),
  ],
);

/** Immutable — never updated after insert. */
export const catalogProductVersions = mysqlTable(
  "catalog_product_versions",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    productId: refColumn("product_id").notNull(),
    versionNumber: int("version_number", { unsigned: true }).notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    description: varchar("description", { length: 2000 }).notNull().default(""),
    features: json("features").$type<string[]>().notNull(),
    outcome: varchar("outcome", { length: 1000 }).notNull().default(""),
    timeline: varchar("timeline", { length: 120 }).notNull().default(""),
    deliverables: json("deliverables").$type<Deliverable[]>().notNull(),
    priceMinor: amountMinorColumn("price_minor").notNull(),
    currency: currencyColumn().notNull(),
    createdByUserId: refColumn("created_by_user_id").references(() => users.id),
    createdAt: createdAtColumn(),
  },
  (t) => [uniqueIndex("catalog_product_versions_uq").on(t.productId, t.versionNumber)],
);

/* ----------------------------------------------------------------- workflow */

export const orderWorkflows = mysqlTable(
  "order_workflows",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    workflowKey: varchar("workflow_key", { length: 64 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    currentVersionId: refColumn("current_version_id"),
    isDefault: boolean("is_default").notNull().default(false),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [uniqueIndex("order_workflows_key_uq").on(t.workflowKey)],
);

/** Immutable workflow definition versions. */
export const orderWorkflowVersions = mysqlTable(
  "order_workflow_versions",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    workflowId: refColumn("workflow_id").notNull(),
    versionNumber: int("version_number", { unsigned: true }).notNull(),
    definition: json("definition").$type<WorkflowDefinition>().notNull(),
    createdByUserId: refColumn("created_by_user_id").references(() => users.id),
    createdAt: createdAtColumn(),
  },
  (t) => [uniqueIndex("order_workflow_versions_uq").on(t.workflowId, t.versionNumber)],
);

/** Increment 03: canvas positions and an optional change note per published version (nullable, additive). */
export const orderWorkflowVersionLayouts = mysqlTable(
  "order_workflow_version_layouts",
  {
    id: idColumn(),
    versionId: refColumn("version_id").notNull(),
    layout: json("layout").$type<WorkflowLayout>(),
    changeNote: varchar("change_note", { length: 500 }),
    createdAt: createdAtColumn(),
  },
  (t) => [uniqueIndex("order_workflow_version_layouts_uq").on(t.versionId)],
);

export const WORKFLOW_DRAFT_SOURCES = ["standard", "copy", "blank"] as const;
export type WorkflowDraftSource = (typeof WORKFLOW_DRAFT_SOURCES)[number];

/**
 * Increment 03: editable drafts (wizard and canvas edit the same row). A draft either edits an existing
 * workflow (`workflowId` set, at most one draft per workflow) or proposes a new one (`workflowId` null,
 * `workflowKey` reserved). Drafts may be invalid; publishing validates and writes a new immutable version.
 */
export const orderWorkflowDrafts = mysqlTable(
  "order_workflow_drafts",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    workflowId: refColumn("workflow_id"),
    workflowKey: varchar("workflow_key", { length: 64 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    source: mysqlEnum("source", WORKFLOW_DRAFT_SOURCES).notNull(),
    /** Version the draft was started from (copy / existing workflow); publish refuses if the workflow moved on. */
    baseVersionId: refColumn("base_version_id"),
    definition: json("definition").$type<WorkflowDraftDefinition>().notNull(),
    layout: json("layout").$type<WorkflowLayout>(),
    createdByUserId: refColumn("created_by_user_id").references(() => users.id),
    updatedByUserId: refColumn("updated_by_user_id").references(() => users.id),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [uniqueIndex("order_workflow_drafts_workflow_uq").on(t.workflowId), uniqueIndex("order_workflow_drafts_key_uq").on(t.workflowKey)],
);

/**
 * Increment 05 (A1): one row per applied workflow import, for idempotent replay of `transfer.apply`.
 * Holds no package content: digest, source label and the per-key outcome only.
 */
export const orderWorkflowImports = mysqlTable(
  "order_workflow_imports",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    actorUserId: refColumn("actor_user_id")
      .notNull()
      .references(() => users.id),
    idempotencyKey: varchar("idempotency_key", { length: 80 }).notNull(),
    digest: char("digest", { length: 64 }).notNull(),
    /** SHA-256 of the canonical request (package digest + decisions + reference mappings); a replay with other decisions is refused. */
    requestHash: char("request_hash", { length: 64 }).notNull(),
    sourceLabel: varchar("source_label", { length: 120 }),
    outcome: json("outcome").$type<{ key: string; action: "create" | "draft" | "skip"; draftPublicId: string | null; workflowKey: string | null }[]>().notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [uniqueIndex("order_workflow_imports_idem_uq").on(t.actorUserId, t.idempotencyKey)],
);

/* ------------------------------------------------------------------- orders */

export const orders = mysqlTable(
  "orders",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    reference: varchar("reference", { length: 32 }).notNull(),
    ownerUserId: refColumn("owner_user_id")
      .notNull()
      .references(() => users.id),
    projectName: varchar("project_name", { length: 160 }).notNull(),
    workflowVersionId: refColumn("workflow_version_id").notNull(),
    statusKey: varchar("status_key", { length: 48 }).notNull(),
    lockState: mysqlEnum("lock_state", ORDER_LOCK_STATES).notNull().default("none"),
    lockReasonCode: varchar("lock_reason_code", { length: 48 }),
    lockedAt: utcDateTime("locked_at"),
    /** totalMinor = subtotalMinor - discountMinor (server-computed; the client never sends amounts). */
    subtotalMinor: amountMinorColumn("subtotal_minor").notNull(),
    discountMinor: amountMinorColumn("discount_minor").notNull().default(0),
    discountLabel: varchar("discount_label", { length: 120 }),
    /** Increment 05 (C3): the part of discountMinor due to a promotion code, and its customer-facing label. */
    promoDiscountMinor: amountMinorColumn("promo_discount_minor").notNull().default(0),
    promoLabel: varchar("promo_label", { length: 120 }),
    totalMinor: amountMinorColumn("total_minor").notNull(),
    currency: currencyColumn().notNull(),
    origin: mysqlEnum("origin", ORDER_ORIGINS).notNull().default("portal"),
    createdByUserId: refColumn("created_by_user_id").references(() => users.id),
    /** Idempotency for create (owner-scoped). */
    createKey: varchar("create_key", { length: 80 }),
    submittedAt: utcDateTime("submitted_at"),
    /** Increment 07 (D3): cached shown percent (null = fill on first read); explicit completion and its fence. */
    progressPercent: tinyint("progress_percent", { unsigned: true }),
    completionPercent: tinyint("completion_percent", { unsigned: true }),
    completionRevision: int("completion_revision", { unsigned: true }).notNull().default(0),
    /** Increment 07 (D2): attention filter; `attentionSince` changes only when the value changes. */
    attention: mysqlEnum("attention", ORDER_ATTENTION).notNull().default("none"),
    attentionSince: utcDateTime("attention_since"),
    /** Increment 07 (D9): payment state; existing orders are backfilled at start-up (paid / not_required). */
    paymentState: mysqlEnum("payment_state", ORDER_PAYMENT_STATES).notNull().default("not_required"),
    paidAt: utcDateTime("paid_at"),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex("orders_reference_uq").on(t.reference),
    index("orders_attention_idx").on(t.attention, t.attentionSince, t.id),
    index("orders_payment_state_idx").on(t.paymentState, t.id),
    uniqueIndex("orders_create_key_uq").on(t.ownerUserId, t.createKey),
    index("orders_owner_idx").on(t.ownerUserId, t.id),
    index("orders_status_idx").on(t.statusKey, t.id),
    index("orders_created_idx").on(t.createdAt, t.id),
    /** Increment 03: order counts per workflow version (designer version list). */
    index("orders_workflow_version_idx").on(t.workflowVersionId),
  ],
);

/** Immutable price snapshots. */
export const orderLineItems = mysqlTable(
  "order_line_items",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    orderId: refColumn("order_id").notNull(),
    productId: refColumn("product_id"),
    productVersionId: refColumn("product_version_id"),
    productPublicId: char("product_public_id", { length: 26 }),
    productVersionNumber: int("product_version_number", { unsigned: true }),
    name: varchar("name", { length: 160 }).notNull(),
    description: varchar("description", { length: 2000 }).notNull().default(""),
    features: json("features").$type<string[]>().notNull(),
    packetNumber: tinyint("packet_number", { unsigned: true }),
    tier: mysqlEnum("tier", PACKET_TIERS),
    outcome: varchar("outcome", { length: 1000 }).notNull().default(""),
    timeline: varchar("timeline", { length: 120 }).notNull().default(""),
    deliverables: json("deliverables").$type<Deliverable[]>().notNull(),
    unitPriceMinor: amountMinorColumn("unit_price_minor").notNull(),
    currency: currencyColumn().notNull(),
    quantity: int("quantity", { unsigned: true }).notNull(),
    lineTotalMinor: amountMinorColumn("line_total_minor").notNull(),
    sortOrder: int("sort_order").notNull().default(0),
    createdAt: createdAtColumn(),
  },
  (t) => [index("order_line_items_order_idx").on(t.orderId, t.sortOrder)],
);

export const orderStatusHistory = mysqlTable(
  "order_status_history",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    orderId: refColumn("order_id").notNull(),
    fromStatus: varchar("from_status", { length: 48 }),
    toStatus: varchar("to_status", { length: 48 }).notNull(),
    actorUserId: refColumn("actor_user_id").references(() => users.id),
    actorRole: varchar("actor_role", { length: 16 }).notNull(),
    reasonCode: varchar("reason_code", { length: 48 }).notNull().default("TRANSITION"),
    noteId: refColumn("note_id"),
    occurredAt: utcDateTime("occurred_at").notNull(),
  },
  (t) => [index("order_status_history_order_idx").on(t.orderId, t.id)],
);

export const orderNotes = mysqlTable(
  "order_notes",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    orderId: refColumn("order_id").notNull(),
    authorUserId: refColumn("author_user_id").references(() => users.id),
    authorRole: varchar("author_role", { length: 16 }).notNull(),
    visibility: mysqlEnum("visibility", NOTE_VISIBILITIES).notNull(),
    /** FieldCrypto envelope, aad `order_notes.body:<publicId>`. */
    bodyEnc: text("body_enc").notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [index("order_notes_order_idx").on(t.orderId, t.visibility, t.id)],
);

export const orderLockHistory = mysqlTable(
  "order_lock_history",
  {
    id: idColumn(),
    orderId: refColumn("order_id").notNull(),
    fromState: mysqlEnum("from_state", ORDER_LOCK_STATES).notNull(),
    toState: mysqlEnum("to_state", ORDER_LOCK_STATES).notNull(),
    reasonCode: varchar("reason_code", { length: 48 }).notNull(),
    actorUserId: refColumn("actor_user_id").references(() => users.id),
    occurredAt: utcDateTime("occurred_at").notNull(),
  },
  (t) => [index("order_lock_history_order_idx").on(t.orderId, t.id)],
);

/** Every reference ever assigned. Unique ⇒ retired references are reserved forever. */
export const orderReferences = mysqlTable(
  "order_references",
  {
    id: idColumn(),
    reference: varchar("reference", { length: 32 }).notNull(),
    orderId: refColumn("order_id").notNull(),
    status: mysqlEnum("status", ["active", "retired"]).notNull(),
    reasonCode: varchar("reason_code", { length: 48 }).notNull(),
    actorUserId: refColumn("actor_user_id").references(() => users.id),
    assignedAt: utcDateTime("assigned_at").notNull(),
    retiredAt: utcDateTime("retired_at"),
  },
  (t) => [uniqueIndex("order_references_reference_uq").on(t.reference), index("order_references_order_idx").on(t.orderId)],
);

/** Monotonic per-year reference sequence. */
export const orderReferenceCounters = mysqlTable("order_reference_counters", {
  id: idColumn(),
  scope: varchar("scope", { length: 16 }).notNull().unique(),
  nextValue: int("next_value", { unsigned: true }).notNull(),
});

export const orderGrants = mysqlTable(
  "order_grants",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    orderId: refColumn("order_id").notNull(),
    /** HMAC blind index of the normalized invitee e-mail (purpose `order_grants.invitee_email`). */
    inviteeEmailIndex: char("invitee_email_index", { length: 64 }).notNull(),
    /** Encrypted invitee e-mail (aad `order_grants.invitee_email:<publicId>`), shown to the owner only. */
    inviteeEmailEnc: text("invitee_email_enc").notNull(),
    /** Set on acceptance (never before — a pending invite proves nothing about who controls the address). */
    granteeUserId: refColumn("grantee_user_id").references(() => users.id),
    role: mysqlEnum("role", GRANT_ROLES).notNull(),
    status: mysqlEnum("status", GRANT_STATUSES).notNull().default("pending"),
    /** `orderId:emailIndex` while pending/active, NULL once ended ⇒ one live grant per invitee per order. */
    liveKey: varchar("live_key", { length: 96 }),
    grantedByUserId: refColumn("granted_by_user_id").references(() => users.id),
    acceptedAt: utcDateTime("accepted_at"),
    endedAt: utcDateTime("ended_at"),
    endedByUserId: refColumn("ended_by_user_id").references(() => users.id),
    endReasonCode: varchar("end_reason_code", { length: 48 }),
    expiresAt: utcDateTime("expires_at"),
    /** Increment 04: set when the grant was derived from a customer-wide console grant (`order_customer_grants.id`). */
    customerGrantId: refColumn("customer_grant_id"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex("order_grants_live_uq").on(t.liveKey),
    index("order_grants_customer_grant_idx").on(t.customerGrantId),
    index("order_grants_order_idx").on(t.orderId, t.status),
    index("order_grants_grantee_idx").on(t.granteeUserId, t.status),
    index("order_grants_invitee_idx").on(t.inviteeEmailIndex, t.status),
  ],
);

export const orderReassignments = mysqlTable(
  "order_reassignments",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    operationId: varchar("operation_id", { length: 64 }).notNull(),
    orderId: refColumn("order_id").notNull(),
    fromUserId: refColumn("from_user_id").notNull(),
    toUserId: refColumn("to_user_id").notNull(),
    actorUserId: refColumn("actor_user_id").references(() => users.id),
    reasonCode: varchar("reason_code", { length: 48 }).notNull(),
    revokedGrants: int("revoked_grants", { unsigned: true }).notNull(),
    occurredAt: utcDateTime("occurred_at").notNull(),
  },
  (t) => [uniqueIndex("order_reassignments_operation_uq").on(t.operationId), index("order_reassignments_order_idx").on(t.orderId)],
);

/**
 * Part B (B2): order name history. The audit envelope never carries names (PII filter), so the rename
 * transaction writes the old and new name here; read through `services.orders.listNameHistory` only
 * (order-scoped, never exported to the SIEM). `actor_user_id` is null for system renames.
 */
export const orderNameHistory = mysqlTable(
  "order_name_history",
  {
    id: idColumn(),
    orderId: refColumn("order_id").notNull(),
    oldName: varchar("old_name", { length: 160 }).notNull(),
    newName: varchar("new_name", { length: 160 }).notNull(),
    actorUserId: refColumn("actor_user_id").references(() => users.id),
    actorRole: varchar("actor_role", { length: 16 }).notNull(),
    createdAt: utcDateTime("created_at").notNull(),
  },
  (t) => [index("order_name_history_order_idx").on(t.orderId, t.createdAt)],
);

export const orderImportProvenance = mysqlTable(
  "order_import_provenance",
  {
    id: idColumn(),
    orderId: refColumn("order_id").notNull(),
    importId: varchar("import_id", { length: 64 }).notNull(),
    sourceInstallationId: varchar("source_installation_id", { length: 64 }).notNull(),
    sourceOrderPublicId: varchar("source_order_public_id", { length: 64 }).notNull(),
    sourceReference: varchar("source_reference", { length: 64 }),
    sourceStatusKey: varchar("source_status_key", { length: 64 }),
    createdAt: createdAtColumn(),
  },
  (t) => [
    uniqueIndex("order_import_provenance_source_uq").on(t.sourceInstallationId, t.sourceOrderPublicId),
    index("order_import_provenance_order_idx").on(t.orderId),
  ],
);

/* ---------------- Increment 04: phases, requirements, console access ---------------- */

export const PHASE_LOCK_STATES = ["locked", "unlocked"] as const;
export const ACK_ACCEPTOR_SIDES = ["customer", "staff"] as const;

/**
 * One row per (order, phase) once the order has left that phase at least once. `locked` makes the phase's uploads,
 * acknowledgements and customer-editable data read-only; staff unlock (audited) sets `unlocked` until the order
 * leaves the phase again. Re-entering the phase through a permitted transition also sets `unlocked`.
 */
export const orderPhaseLocks = mysqlTable(
  "order_phase_locks",
  {
    id: idColumn(),
    orderId: refColumn("order_id").notNull(),
    workflowVersionId: refColumn("workflow_version_id").notNull(),
    phaseKey: varchar("phase_key", { length: 48 }).notNull(),
    state: mysqlEnum("state", PHASE_LOCK_STATES).notNull(),
    lockedAt: utcDateTime("locked_at").notNull(),
    lockedFromStatus: varchar("locked_from_status", { length: 48 }).notNull(),
    unlockedAt: utcDateTime("unlocked_at"),
    unlockedByUserId: refColumn("unlocked_by_user_id").references(() => users.id),
    /** Staff-only encrypted note that holds the unlock reason (`order_notes.public_id`). */
    unlockNotePublicId: varchar("unlock_note_public_id", { length: 26 }),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [uniqueIndex("order_phase_locks_order_phase_uq").on(t.orderId, t.phaseKey)],
);

/**
 * Insert-only acceptance records. `textSha256` pins the exact text shown (`title + "\n\n" + body` of the pinned
 * workflow version). IP and user agent are captured in the audit event under the audit module's rules.
 */
export const orderAcknowledgements = mysqlTable(
  "order_acknowledgements",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    orderId: refColumn("order_id").notNull(),
    workflowVersionId: refColumn("workflow_version_id").notNull(),
    statusKey: varchar("status_key", { length: 48 }).notNull(),
    ackKey: varchar("ack_key", { length: 48 }).notNull(),
    acceptorSide: mysqlEnum("acceptor_side", ACK_ACCEPTOR_SIDES).notNull(),
    textSha256: char("text_sha256", { length: 64 }).notNull(),
    userId: refColumn("user_id").notNull().references(() => users.id),
    userRole: varchar("user_role", { length: 16 }).notNull(),
    /** Public, non-secret session identifier. */
    sessionId: varchar("session_id", { length: 64 }).notNull(),
    /** Encrypted typed name (aad `order_acknowledgements.typed_name:<publicId>`), when the requirement asks for it. */
    typedNameEnc: text("typed_name_enc"),
    acceptedAt: utcDateTime("accepted_at").notNull(),
  },
  (t) => [
    uniqueIndex("order_acknowledgements_once_uq").on(t.orderId, t.workflowVersionId, t.statusKey, t.ackKey, t.acceptorSide),
    index("order_acknowledgements_order_idx").on(t.orderId),
  ],
);

/** Console grant covering every current and future order of one customer (derived rows live in `order_grants`). */
export const orderCustomerGrants = mysqlTable(
  "order_customer_grants",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    ownerUserId: refColumn("owner_user_id").notNull().references(() => users.id),
    granteeUserId: refColumn("grantee_user_id").notNull().references(() => users.id),
    role: mysqlEnum("role", GRANT_ROLES).notNull(),
    status: mysqlEnum("status", ["active", "revoked"] as const).notNull().default("active"),
    /** `owner:grantee` while active, NULL once revoked ⇒ one live customer-wide grant per pair. */
    liveKey: varchar("live_key", { length: 48 }),
    grantedByUserId: refColumn("granted_by_user_id").references(() => users.id),
    endedAt: utcDateTime("ended_at"),
    endedByUserId: refColumn("ended_by_user_id").references(() => users.id),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [uniqueIndex("order_customer_grants_live_uq").on(t.liveKey), index("order_customer_grants_owner_idx").on(t.ownerUserId, t.status)],
);

/**
 * Increment 06 (D8): the per-order staff note behind an `order_note` acknowledgement task. One row per (order,
 * pinned version, status, ack key). Editable until the customer acknowledges it; then final (the acknowledgement
 * pins `textSha256`). Body encrypted (aad `order_task_notes.body:<publicId>`).
 */
export const orderTaskNotes = mysqlTable(
  "order_task_notes",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    orderId: refColumn("order_id").notNull(),
    workflowVersionId: refColumn("workflow_version_id").notNull(),
    statusKey: varchar("status_key", { length: 48 }).notNull(),
    ackKey: varchar("ack_key", { length: 48 }).notNull(),
    bodyEnc: text("body_enc").notNull(),
    textSha256: char("text_sha256", { length: 64 }).notNull(),
    authorUserId: refColumn("author_user_id").notNull().references(() => users.id),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [uniqueIndex("order_task_notes_task_uq").on(t.orderId, t.workflowVersionId, t.statusKey, t.ackKey)],
);

export const TASK_WAIVER_KINDS = ["upload", "record", "acknowledge", "respond_document"] as const;

/**
 * Increment 06 (D8): staff waiver of one customer task on one order (insert-only). The reason is a staff-only
 * encrypted order note (`order_notes.public_id`), like a phase unlock. A waived task counts as met.
 */
export const orderTaskWaivers = mysqlTable(
  "order_task_waivers",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    orderId: refColumn("order_id").notNull(),
    workflowVersionId: refColumn("workflow_version_id").notNull(),
    statusKey: varchar("status_key", { length: 48 }).notNull(),
    taskKey: varchar("task_key", { length: 48 }).notNull(),
    taskKind: mysqlEnum("task_kind", TASK_WAIVER_KINDS).notNull(),
    reasonNotePublicId: varchar("reason_note_public_id", { length: 26 }).notNull(),
    waivedByUserId: refColumn("waived_by_user_id").notNull().references(() => users.id),
    waivedAt: utcDateTime("waived_at").notNull(),
  },
  (t) => [uniqueIndex("order_task_waivers_task_uq").on(t.orderId, t.workflowVersionId, t.statusKey, t.taskKey), index("order_task_waivers_order_idx").on(t.orderId)],
);

/**
 * Increment 07 (D1): runtime state of one stage (phase) on one order, for the pinned workflow version. Created when the
 * stage is first reached. Acknowledgement evidence = policy + text hash + time + actor. Review / reopen text lives in
 * `order_notes` (review note: customer-visible; reopen reason: internal), referenced by public id.
 */
export const orderStageProgress = mysqlTable(
  "order_stage_progress",
  {
    id: idColumn(),
    orderId: refColumn("order_id").notNull(),
    workflowVersionId: refColumn("workflow_version_id").notNull(),
    stageKey: varchar("stage_key", { length: 48 }).notNull(),
    state: mysqlEnum("state", STAGE_PROGRESS_STATES).notNull().default("open"),
    openedAt: utcDateTime("opened_at").notNull(),
    completedAt: utcDateTime("completed_at"),
    completedHow: mysqlEnum("completed_how", STAGE_COMPLETION_KINDS),
    submittedAt: utcDateTime("submitted_at"),
    submittedByUserId: refColumn("submitted_by_user_id").references(() => users.id),
    ackPolicy: mysqlEnum("ack_policy", ["required", "optional", "none"] as const),
    ackTextSha256: char("ack_text_sha256", { length: 64 }),
    ackAt: utcDateTime("ack_at"),
    ackByUserId: refColumn("ack_by_user_id").references(() => users.id),
    reviewOutcome: mysqlEnum("review_outcome", STAGE_REVIEW_OUTCOMES),
    reviewedAt: utcDateTime("reviewed_at"),
    reviewedByUserId: refColumn("reviewed_by_user_id").references(() => users.id),
    reviewNotePublicId: varchar("review_note_public_id", { length: 26 }),
    reopenedAt: utcDateTime("reopened_at"),
    reopenedByUserId: refColumn("reopened_by_user_id").references(() => users.id),
    reopenNotePublicId: varchar("reopen_note_public_id", { length: 26 }),
    reopenCount: int("reopen_count", { unsigned: true }).notNull().default(0),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex("order_stage_progress_uq").on(t.orderId, t.workflowVersionId, t.stageKey),
    index("order_stage_progress_state_idx").on(t.state, t.orderId),
  ],
);

export { orderAdminTasks, orderQuestionAnswers, orderQuestions } from "./questionsSchema.js";
export { orderStatusCatalog } from "./statusCatalogSchema.js";
