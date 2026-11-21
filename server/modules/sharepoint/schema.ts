/**
 * SharePoint order-data sync (increment 03 package H). Additive tables only; no migrations in this increment.
 * No personal data is stored here: order public ids, SharePoint ids, the admin-chosen list label and codes.
 */
import { boolean, char, index, int, mysqlEnum, mysqlTable, tinyint, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { createdAtColumn, idColumn, refColumn, updatedAtColumn, utcDateTime } from "../../db/columns.js";

/** Single row (id = 1). Ships disabled. */
export const sharepointSyncConfig = mysqlTable("sharepoint_sync_config", {
  id: tinyint("id", { unsigned: true }).primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  listId: varchar("list_id", { length: 200 }),
  listLabel: varchar("list_label", { length: 255 }),
  includePortalLink: boolean("include_portal_link").notNull().default(false),
  version: int("version", { unsigned: true }).notNull().default(1),
  updatedByUserId: refColumn("updated_by_user_id"),
  lastErrorCode: varchar("last_error_code", { length: 64 }),
  lastErrorAt: utcDateTime("last_error_at"),
  updatedAt: updatedAtColumn(),
});

export const SHAREPOINT_SYNC_STATES = ["pending", "synced", "failed", "unknown"] as const;
export type SharepointSyncState = (typeof SHAREPOINT_SYNC_STATES)[number];

/** One row per order; the remote list item is found by remote id or by the RpOrderId column. */
export const sharepointOrderSync = mysqlTable(
  "sharepoint_order_sync",
  {
    id: idColumn(),
    orderPublicId: char("order_public_id", { length: 26 }).notNull(),
    listId: varchar("list_id", { length: 200 }),
    remoteItemId: varchar("remote_item_id", { length: 200 }),
    desiredVersion: int("desired_version", { unsigned: true }).notNull().default(1),
    syncedVersion: int("synced_version", { unsigned: true }).notNull().default(0),
    contentHash: char("content_hash", { length: 64 }),
    state: mysqlEnum("state", SHAREPOINT_SYNC_STATES).notNull().default("pending"),
    attempts: int("attempts", { unsigned: true }).notNull().default(0),
    reasonCode: varchar("reason_code", { length: 64 }),
    lastSyncedAt: utcDateTime("last_synced_at"),
    /** Durable per-order write claim across queued versions (one writer per order at a time). */
    claimJobId: varchar("claim_job_id", { length: 64 }),
    /** Fresh per claim (a retry of the same job gets a new token); publish/release require it. */
    claimToken: char("claim_token", { length: 26 }),
    claimedUntil: utcDateTime("claimed_until"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [uniqueIndex("sharepoint_order_sync_order_uq").on(t.orderPublicId), index("sharepoint_order_sync_state_idx").on(t.state, t.id)],
);
