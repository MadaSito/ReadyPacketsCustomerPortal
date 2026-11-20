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

export const ORDER_LOCK_STATES = ["none", "review", "finalized", "legal_hold", "imported_read_only"] as const;
export const GRANT_ROLES = ["viewer", "contributor"] as const;
export const GRANT_STATUSES = ["pending", "active", "declined", "revoked"] as const;
export const NOTE_VISIBILITIES = ["customer", "internal"] as const;
export const ORDER_ORIGINS = ["portal", "import"] as const;

/* ------------------------------------------------------------------ catalog */

export const catalogGroups = mysqlTable(
  "catalog_groups",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    name: varchar("name", { length: 120 }).notNull(),
    description: varchar("description", { length: 1000 }).notNull().default(""),
    sortOrder: int("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [index("catalog_groups_sort_idx").on(t.active, t.sortOrder)],
);

export const catalogProducts = mysqlTable(
  "catalog_products",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    groupId: refColumn("group_id").notNull(),
    /** Stable admin-chosen key, unique (lowercase slug). */
    productKey: varchar("product_key", { length: 64 }).notNull(),
    currentVersionId: refColumn("current_version_id"),
    sortOrder: int("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex("catalog_products_key_uq").on(t.productKey),
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
    totalMinor: amountMinorColumn("total_minor").notNull(),
    currency: currencyColumn().notNull(),
    origin: mysqlEnum("origin", ORDER_ORIGINS).notNull().default("portal"),
    createdByUserId: refColumn("created_by_user_id").references(() => users.id),
    /** Idempotency for create (owner-scoped). */
    createKey: varchar("create_key", { length: 80 }),
    submittedAt: utcDateTime("submitted_at"),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex("orders_reference_uq").on(t.reference),
    uniqueIndex("orders_create_key_uq").on(t.ownerUserId, t.createKey),
    index("orders_owner_idx").on(t.ownerUserId, t.id),
    index("orders_status_idx").on(t.statusKey, t.id),
    index("orders_created_idx").on(t.createdAt, t.id),
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
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex("order_grants_live_uq").on(t.liveKey),
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
