import { char, index, int, json, mysqlEnum, mysqlTable, text, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { createdAtColumn, idColumn, publicIdColumn, updatedAtColumn, utcDateTime, versionColumn } from "../../db/columns.js";
import type { ProtectionPolicy } from "./policy.js";

export const protectionPolicies = mysqlTable("protection_policies", {
  id: int("id", { unsigned: true }).primaryKey(),
  policy: json("policy").$type<ProtectionPolicy>().notNull(),
  version: versionColumn(),
  updatedAt: updatedAtColumn(),
});

export const protectionBlocks = mysqlTable("protection_blocks", {
  id: idColumn(),
  publicId: publicIdColumn(),
  bucket: int("bucket", { unsigned: true }).notNull(),
  addressKey: char("address_key", { length: 64 }).notNull(),
  addressEnc: text("address_enc").notNull(),
  expiresAt: utcDateTime("expires_at").notNull(),
  createdAt: createdAtColumn(),
}, (t) => [
  uniqueIndex("protection_blocks_public_uidx").on(t.publicId),
  uniqueIndex("protection_blocks_bucket_uidx").on(t.bucket),
  index("protection_blocks_expiry_idx").on(t.expiresAt, t.id),
]);

export const protectionEvents = mysqlTable("protection_events", {
  id: idColumn(),
  publicId: publicIdColumn(),
  minute: int("minute", { unsigned: true }).notNull(),
  slot: int("slot", { unsigned: true }).notNull(),
  action: mysqlEnum("action", ["detect", "block"]).notNull(),
  rule: varchar("rule", { length: 80 }).notNull(),
  method: varchar("method", { length: 12 }).notNull(),
  route: varchar("route", { length: 80 }).notNull(),
  country: char("country", { length: 2 }),
  addressEnc: text("address_enc"),
  agent: varchar("agent", { length: 20 }).notNull(),
  correlationId: varchar("correlation_id", { length: 80 }).notNull(),
  createdAt: createdAtColumn(),
}, (t) => [
  uniqueIndex("protection_events_public_uidx").on(t.publicId),
  uniqueIndex("protection_events_sample_uidx").on(t.minute, t.slot),
  index("protection_events_time_idx").on(t.createdAt, t.id),
  index("protection_events_action_idx").on(t.action, t.id),
  index("protection_events_country_idx").on(t.country, t.id),
]);

/** Fixed slots cap unauthenticated cardinality. A slot's address key must match before any state is used. */
export const protectionSignInStrikes = mysqlTable("protection_signin_strikes", {
  slot: int("slot", { unsigned: true }).primaryKey(),
  addressKey: char("address_key", { length: 64 }).notNull(),
  /** Only pseudonymous account references (or null), never raw identifiers. */
  failures: json("failures").$type<{ atMs: number; accountRef: string | null }[]>().notNull(),
  banCount: int("ban_count", { unsigned: true }).notNull().default(0),
  lastBanAt: utcDateTime("last_ban_at"),
  updatedAt: updatedAtColumn(),
}, (t) => [
  index("protection_signin_strikes_updated_idx").on(t.updatedAt),
]);

/** Durable independent sign-in bans; addresses encrypted and exact entries keyed for deduplication. */
export const protectionSignInBans = mysqlTable("protection_signin_bans", {
  id: idColumn(),
  publicId: publicIdColumn(),
  addressKey: char("address_key", { length: 64 }).notNull(),
  addressEnc: text("address_enc").notNull(),
  source: mysqlEnum("source", ["automatic", "manual"]).notNull(),
  reason: varchar("reason", { length: 240 }).notNull(),
  strikes: int("strikes", { unsigned: true }).notNull().default(0),
  expiresAt: utcDateTime("expires_at"),
  createdAt: createdAtColumn(),
}, (t) => [
  uniqueIndex("protection_signin_bans_public_uidx").on(t.publicId),
  uniqueIndex("protection_signin_bans_address_uidx").on(t.addressKey),
  index("protection_signin_bans_expiry_idx").on(t.expiresAt, t.id),
]);
