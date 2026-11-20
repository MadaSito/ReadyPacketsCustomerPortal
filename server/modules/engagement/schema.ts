/**
 * Engagement module — Drizzle MySQL tables. Owner: engagement module engineer.
 * Uses the helpers in server/db/columns.ts. Cross-module references (other than `users.id`)
 * avoid foreign-key constraints so module tests run cleanly on schema subsets.
 */
import { boolean, char, index, int, mysqlEnum, mysqlTable, text, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { USER_ROLES } from "../../../shared/domain.js";
import { createdAtColumn, idColumn, publicIdColumn, refColumn, updatedAtColumn, utcDateTime, versionColumn } from "../../db/columns.js";
import { users } from "../identity/schema.js";
import {
  NOTIFICATION_PREFERENCE_CATEGORIES,
  ORDER_MESSAGE_VISIBILITIES,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
} from "./types.js";

export const ENGAGEMENT_RECORD_ORIGINS = ["portal", "import"] as const;
export type EngagementRecordOrigin = (typeof ENGAGEMENT_RECORD_ORIGINS)[number];

export const engagementOrderMessages = mysqlTable(
  "engagement_order_messages",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    orderId: refColumn("order_id").notNull(),
    orderPublicId: char("order_public_id", { length: 26 }).notNull(),
    orderReference: varchar("order_reference", { length: 64 }).notNull(),
    authorUserId: refColumn("author_user_id")
      .notNull()
      .references(() => users.id),
    authorUserPublicId: char("author_user_public_id", { length: 26 }).notNull(),
    authorRole: mysqlEnum("author_role", USER_ROLES).notNull(),
    visibility: mysqlEnum("visibility", ORDER_MESSAGE_VISIBILITIES).notNull().default("customer"),
    /** AES-256-GCM encrypted plain-text body (AAD `engagement_order_messages.body:<publicId>`). */
    bodyEnc: text("body_enc").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }),
    origin: mysqlEnum("origin", ENGAGEMENT_RECORD_ORIGINS).notNull().default("portal"),
    createdAt: createdAtColumn(),
  },
  (table) => [
    index("eng_order_msg_order_id_idx").on(table.orderId, table.id),
    index("eng_order_msg_order_pub_idx").on(table.orderPublicId, table.publicId),
    index("eng_order_msg_ref_idx").on(table.orderReference),
    index("eng_order_msg_order_ref_idx").on(table.orderId, table.orderReference),
    index("eng_order_msg_created_idx").on(table.createdAt, table.id),
    uniqueIndex("eng_order_msg_idem_uq").on(table.authorUserId, table.idempotencyKey),
  ],
);

export const engagementOrderMessageAttachments = mysqlTable(
  "engagement_order_message_attachments",
  {
    id: idColumn(),
    messageId: refColumn("message_id").notNull(),
    filePublicId: char("file_public_id", { length: 26 }).notNull(),
    sortOrder: int("sort_order", { unsigned: true }).notNull().default(0),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex("eng_msg_att_msg_file_uq").on(table.messageId, table.filePublicId),
    index("eng_msg_att_msg_idx").on(table.messageId, table.sortOrder),
  ],
);

export const engagementOrderMessageReads = mysqlTable(
  "engagement_order_message_reads",
  {
    id: idColumn(),
    messageId: refColumn("message_id").notNull(),
    orderId: refColumn("order_id").notNull(),
    userId: refColumn("user_id")
      .notNull()
      .references(() => users.id),
    readAt: utcDateTime("read_at").notNull(),
  },
  (table) => [
    uniqueIndex("eng_msg_reads_msg_user_uq").on(table.messageId, table.userId),
    index("eng_msg_reads_user_order_idx").on(table.userId, table.orderId),
  ],
);

export const engagementSupportTickets = mysqlTable(
  "engagement_support_tickets",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    ticketNumber: varchar("ticket_number", { length: 32 }).notNull(),
    requesterUserId: refColumn("requester_user_id")
      .notNull()
      .references(() => users.id),
    requesterUserPublicId: char("requester_user_public_id", { length: 26 }).notNull(),
    relatedOrderId: refColumn("related_order_id"),
    relatedOrderPublicId: char("related_order_public_id", { length: 26 }),
    relatedOrderReference: varchar("related_order_reference", { length: 64 }),
    assigneeUserId: refColumn("assignee_user_id").references(() => users.id),
    assigneeUserPublicId: char("assignee_user_public_id", { length: 26 }),
    category: mysqlEnum("category", TICKET_CATEGORIES).notNull().default("general"),
    status: mysqlEnum("status", TICKET_STATUSES).notNull().default("open"),
    priority: mysqlEnum("priority", TICKET_PRIORITIES).notNull().default("normal"),
    /** AES-256-GCM encrypted plain-text subject (AAD `engagement_support_tickets.subject:<publicId>`). */
    subjectEnc: text("subject_enc").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }),
    origin: mysqlEnum("origin", ENGAGEMENT_RECORD_ORIGINS).notNull().default("portal"),
    lastMessageAt: utcDateTime("last_message_at").notNull(),
    resolvedAt: utcDateTime("resolved_at"),
    closedAt: utcDateTime("closed_at"),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("eng_tickets_number_uq").on(table.ticketNumber),
    uniqueIndex("eng_tickets_idem_uq").on(table.requesterUserId, table.idempotencyKey),
    index("eng_tickets_req_status_idx").on(table.requesterUserId, table.status, table.id),
    index("eng_tickets_req_num_idx").on(table.requesterUserId, table.ticketNumber),
    index("eng_tickets_req_ref_idx").on(table.requesterUserId, table.relatedOrderReference),
    index("eng_tickets_order_ref_idx").on(table.relatedOrderReference),
    index("eng_tickets_queue_idx").on(table.status, table.priority, table.id),
    index("eng_tickets_assignee_idx").on(table.assigneeUserId, table.status, table.id),
    index("eng_tickets_order_pub_idx").on(table.relatedOrderPublicId),
  ],
);

export const engagementSupportTicketMessages = mysqlTable(
  "engagement_support_ticket_messages",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    ticketId: refColumn("ticket_id").notNull(),
    authorUserId: refColumn("author_user_id")
      .notNull()
      .references(() => users.id),
    authorUserPublicId: char("author_user_public_id", { length: 26 }).notNull(),
    authorRole: mysqlEnum("author_role", USER_ROLES).notNull(),
    internalOnly: boolean("internal_only").notNull().default(false),
    /** AES-256-GCM encrypted plain-text body (AAD `engagement_support_ticket_messages.body:<publicId>`). */
    bodyEnc: text("body_enc").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }),
    createdAt: createdAtColumn(),
  },
  (table) => [
    index("eng_ticket_msg_ticket_idx").on(table.ticketId, table.id),
    uniqueIndex("eng_ticket_msg_idem_uq").on(table.ticketId, table.authorUserId, table.idempotencyKey),
  ],
);

export const engagementSupportTicketHistory = mysqlTable(
  "engagement_support_ticket_history",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    ticketId: refColumn("ticket_id").notNull(),
    actorUserId: refColumn("actor_user_id"),
    actorRole: varchar("actor_role", { length: 16 }).notNull(),
    fromStatus: mysqlEnum("from_status", TICKET_STATUSES),
    toStatus: mysqlEnum("to_status", TICKET_STATUSES).notNull(),
    reasonCode: varchar("reason_code", { length: 64 }),
    occurredAt: utcDateTime("occurred_at").notNull(),
  },
  (table) => [index("eng_ticket_hist_ticket_idx").on(table.ticketId, table.id)],
);

export const engagementNotifications = mysqlTable(
  "engagement_notifications",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    userId: refColumn("user_id")
      .notNull()
      .references(() => users.id),
    kind: varchar("kind", { length: 64 }).notNull(),
    category: mysqlEnum("category", NOTIFICATION_PREFERENCE_CATEGORIES).notNull(),
    title: varchar("title", { length: 160 }).notNull(),
    body: varchar("body", { length: 500 }).notNull(),
    link: varchar("link", { length: 255 }),
    readAt: utcDateTime("read_at"),
    idempotencyKey: varchar("idempotency_key", { length: 128 }),
    createdAt: createdAtColumn(),
  },
  (table) => [
    index("eng_notif_user_read_idx").on(table.userId, table.readAt, table.id),
    index("eng_notif_user_id_idx").on(table.userId, table.id),
    index("eng_notif_created_idx").on(table.createdAt),
    uniqueIndex("eng_notif_idem_uq").on(table.userId, table.idempotencyKey),
  ],
);

export const engagementNotificationPreferences = mysqlTable(
  "engagement_notification_preferences",
  {
    id: idColumn(),
    userId: refColumn("user_id")
      .notNull()
      .references(() => users.id),
    category: mysqlEnum("category", NOTIFICATION_PREFERENCE_CATEGORIES).notNull(),
    inApp: boolean("in_app").notNull().default(true),
    email: boolean("email").notNull().default(false),
    updatedAt: updatedAtColumn(),
  },
  (table) => [uniqueIndex("eng_notif_pref_user_cat_uq").on(table.userId, table.category)],
);

export const SEARCH_INDEX_DOMAINS = ["order_message", "ticket"] as const;
export type SearchIndexDomain = (typeof SEARCH_INDEX_DOMAINS)[number];

export const engagementSearchTokens = mysqlTable(
  "engagement_search_tokens",
  {
    id: idColumn(),
    domain: mysqlEnum("domain", SEARCH_INDEX_DOMAINS).notNull(),
    recordId: refColumn("record_id").notNull(),
    customerVisible: boolean("customer_visible").notNull().default(true),
    /** HMAC-SHA-256 blind index of normalized token >= 3 chars (`crypto.blindIndex(token, "engagement.search.token")`). */
    tokenHash: char("token_hash", { length: 64 }).notNull(),
  },
  (table) => [
    index("eng_search_tok_lookup_idx").on(table.domain, table.tokenHash, table.customerVisible, table.recordId),
    index("eng_search_tok_rec_idx").on(table.domain, table.recordId),
  ],
);

export const IMPORT_ENTITY_TYPES = ["order_message", "ticket", "ticket_message"] as const;
export type ImportEntityType = (typeof IMPORT_ENTITY_TYPES)[number];

export const engagementImportProvenance = mysqlTable(
  "engagement_import_provenance",
  {
    id: idColumn(),
    entityType: mysqlEnum("entity_type", IMPORT_ENTITY_TYPES).notNull(),
    sourceInstallationId: varchar("source_installation_id", { length: 64 }).notNull(),
    sourcePublicId: char("source_public_id", { length: 26 }).notNull(),
    sourceReference: varchar("source_reference", { length: 64 }),
    targetId: refColumn("target_id").notNull(),
    targetPublicId: char("target_public_id", { length: 26 }).notNull(),
    importId: varchar("import_id", { length: 64 }).notNull(),
    importedAt: utcDateTime("imported_at").notNull(),
  },
  (table) => [
    uniqueIndex("eng_imp_prov_src_uq").on(table.entityType, table.sourceInstallationId, table.sourcePublicId),
    index("eng_imp_prov_import_idx").on(table.importId),
  ],
);
