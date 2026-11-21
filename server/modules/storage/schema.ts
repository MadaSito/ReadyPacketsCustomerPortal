import { boolean, char, index, int, json, mysqlEnum, mysqlTable, text, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { createdAtColumn, idColumn, publicIdColumn, updatedAtColumn, utcDateTime, versionColumn } from "../../db/columns.js";
import { STORAGE_PROVIDER_KINDS, STORAGE_PURPOSES, type StorageConfig, type StorageTestCode } from "./contracts.js";

export const storageConnections = mysqlTable("storage_connections", {
  id: idColumn(),
  publicId: publicIdColumn(),
  kind: mysqlEnum("kind", STORAGE_PROVIDER_KINDS).notNull(),
  name: varchar("name", { length: 120 }).notNull(),
  config: json("config").$type<StorageConfig>().notNull(),
  credentialsEnc: text("credentials_enc"),
  oauthConnected: boolean("oauth_connected").notNull().default(false),
  enabled: boolean("enabled").notNull().default(false),
  version: versionColumn(),
  destinationVersion: versionColumn("destination_version"),
  lastTestCode: varchar("last_test_code", { length: 32 }).$type<StorageTestCode>(),
  lastTestAt: utcDateTime("last_test_at"),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (t) => [index("storage_connections_enabled_idx").on(t.enabled, t.id)]);

/** A single lockable row per purpose, including when its assignment set is empty. */
export const storageAssignments = mysqlTable("storage_assignments", {
  purpose: mysqlEnum("purpose", STORAGE_PURPOSES).primaryKey(),
  connectionPublicIds: json("connection_public_ids").$type<string[]>().notNull(),
  updatedAt: updatedAtColumn(),
});

export const storageFileCopies = mysqlTable("storage_file_copies", {
  id: idColumn(),
  publicId: publicIdColumn(),
  filePublicId: char("file_public_id", { length: 26 }).notNull(),
  connectionPublicId: char("connection_public_id", { length: 26 }).notNull(),
  destinationVersion: int("destination_version", { unsigned: true }).notNull(),
  state: mysqlEnum("state", ["queued", "copying", "copied", "failed", "skipped"]).notNull().default("queued"),
  attempts: int("attempts", { unsigned: true }).notNull().default(0),
  reasonCode: varchar("reason_code", { length: 64 }),
  targetEnc: text("target_enc"),
  remoteIdEnc: text("remote_id_enc"),
  digestVerified: boolean("digest_verified").notNull().default(false),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
  finishedAt: utcDateTime("finished_at"),
}, (t) => [
  uniqueIndex("storage_file_copies_file_connection_uq").on(t.filePublicId, t.connectionPublicId),
  index("storage_file_copies_state_idx").on(t.state, t.updatedAt),
]);
