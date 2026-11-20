import { bigint, char, index, mysqlEnum, mysqlTable, text, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { createdAtColumn, idColumn, publicIdColumn, refColumn, utcDateTime, versionColumn } from "../../db/columns.js";

export const fileCategories = ["supporting", "intake_attachment", "deliverable"] as const;
export const fileVisibilities = ["customer_visible", "staff_only"] as const;
export type FileCategory = (typeof fileCategories)[number];
export type FileVisibility = (typeof fileVisibilities)[number];

export const orderFiles = mysqlTable("order_files", {
  id: idColumn(),
  publicId: publicIdColumn(),
  logicalPublicId: char("logical_public_id", { length: 26 }).notNull(),
  previousVersionId: refColumn("previous_version_id"),
  orderId: refColumn("order_id").notNull(),
  orderPublicId: char("order_public_id", { length: 26 }).notNull(),
  ownerUserId: refColumn("owner_user_id").notNull(),
  phasePublicId: char("phase_public_id", { length: 26 }),
  statusKey: varchar("status_key", { length: 64 }),
  uploadedByUserId: refColumn("uploaded_by_user_id").notNull(),
  storageKey: varchar("storage_key", { length: 48 }).notNull(),
  displayNameEnc: text("display_name_enc").notNull(),
  category: mysqlEnum("category", fileCategories).notNull(),
  visibility: mysqlEnum("visibility", fileVisibilities).notNull(),
  byteSize: bigint("byte_size", { mode: "number", unsigned: true }).notNull(),
  sha256: char("sha256", { length: 64 }).notNull(),
  contentType: varchar("content_type", { length: 80 }).notNull(),
  extension: varchar("extension", { length: 16 }).notNull(),
  version: versionColumn(),
  createdAt: createdAtColumn(),
  supersededAt: utcDateTime("superseded_at"),
  deletedAt: utcDateTime("deleted_at"),
  purgeAfter: utcDateTime("purge_after"),
  purgedAt: utcDateTime("purged_at"),
}, (t) => [
  uniqueIndex("order_files_storage_key_uq").on(t.storageKey),
  uniqueIndex("order_files_logical_version_uq").on(t.logicalPublicId, t.version),
  index("order_files_order_public_idx").on(t.orderId, t.publicId),
  index("order_files_owner_idx").on(t.ownerUserId),
  index("order_files_retention_idx").on(t.purgeAfter, t.purgedAt),
]);

export const fileDownloadTickets = mysqlTable("file_download_tickets", {
  id: idColumn(),
  tokenHash: char("token_hash", { length: 64 }).notNull(),
  orderId: refColumn("order_id").notNull(),
  fileId: refColumn("file_id").notNull(),
  userId: refColumn("user_id").notNull(),
  sessionId: varchar("session_id", { length: 80 }).notNull(),
  issuedAt: utcDateTime("issued_at").notNull(),
  expiresAt: utcDateTime("expires_at").notNull(),
}, (t) => [
  uniqueIndex("file_download_tickets_hash_uq").on(t.tokenHash),
  index("file_download_tickets_order_idx").on(t.orderId),
  index("file_download_tickets_file_idx").on(t.fileId),
  index("file_download_tickets_exp_idx").on(t.expiresAt),
]);

export const fileAccessLog = mysqlTable("file_access_log", {
  id: idColumn(),
  publicId: publicIdColumn(),
  filePublicId: char("file_public_id", { length: 26 }),
  userId: refColumn("user_id"),
  requestId: char("request_id", { length: 26 }),
  correlationId: varchar("correlation_id", { length: 64 }),
  outcome: mysqlEnum("outcome", ["attempted", "completed", "failed", "denied", "unknown"]).notNull(),
  reasonCode: varchar("reason_code", { length: 64 }),
  createdAt: createdAtColumn(),
}, (t) => [
  index("file_access_log_file_idx").on(t.filePublicId, t.createdAt),
  index("file_access_log_actor_idx").on(t.userId, t.createdAt),
]);
