import { char, index, int, mysqlTable, text, varchar } from "drizzle-orm/mysql-core";
import { utcDateTime } from "../../../db/columns.js";

export const storageOAuthAttempts = mysqlTable("storage_oauth_attempts", {
  connectionPublicId: char("connection_public_id", { length: 26 }).primaryKey(),
  attemptId: char("attempt_id", { length: 26 }).notNull(),
  provider: varchar("provider", { length: 24 }).notNull(),
  expectedVersion: int("expected_version", { unsigned: true }).notNull(),
  redirectUri: varchar("redirect_uri", { length: 1024 }).notNull(),
  expiresAt: utcDateTime("expires_at").notNull(),
  phase: varchar("phase", { length: 12 }).notNull(), // pending, exchanging or revoking
  stateHash: char("state_hash", { length: 64 }).unique(),
  binderHash: char("binder_hash", { length: 64 }),
  payloadEnc: text("payload_enc"),
}, (t) => [index("idx_storage_oauth_expiry").on(t.expiresAt)]);
