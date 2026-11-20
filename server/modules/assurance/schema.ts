import { char, index, int, mysqlEnum, mysqlTable, text, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { createdAtColumn, idColumn, publicIdColumn, refColumn, updatedAtColumn, utcDateTime } from "../../db/columns.js";
import { users } from "../identity/schema.js";

/** One serialization point per account for credential lifecycle and one-time proof use. */
export const assuranceAccounts = mysqlTable("assurance_accounts", {
  id: idColumn(),
  publicId: publicIdColumn(),
  userId: refColumn("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  totpSecretEnc: text("totp_secret_enc"),
  lastTotpStep: refColumn("last_totp_step"),
  pendingTotpSecretEnc: text("pending_totp_secret_enc"),
  pendingTotpSessionId: char("pending_totp_session_id", { length: 26 }),
  pendingTotpExpiresAt: utcDateTime("pending_totp_expires_at"),
  recoverySetId: char("recovery_set_id", { length: 26 }),
  recoveryAcknowledgedAt: utcDateTime("recovery_acknowledged_at"),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (t) => [uniqueIndex("uq_assurance_accounts_user").on(t.userId)]);

export const assuranceRecoveryCodes = mysqlTable("assurance_recovery_codes", {
  id: idColumn(),
  publicId: publicIdColumn(),
  userId: refColumn("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  codeHash: varchar("code_hash", { length: 128 }).notNull(),
  usedAt: utcDateTime("used_at"),
  createdAt: createdAtColumn(),
}, (t) => [uniqueIndex("uq_assurance_recovery_user_hash").on(t.userId, t.codeHash)]);

export const assurancePasskeys = mysqlTable("assurance_passkeys", {
  id: idColumn(),
  publicId: publicIdColumn(),
  userId: refColumn("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  credentialId: varchar("credential_id", { length: 1400 }).notNull(),
  credentialIndex: char("credential_index", { length: 64 }).notNull(),
  publicKey: text("public_key").notNull(),
  counter: int("counter", { unsigned: true }).notNull(),
  nameEnc: text("name_enc").notNull(),
  lastUsedAt: utcDateTime("last_used_at"),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (t) => [
  uniqueIndex("uq_assurance_passkey_credential").on(t.credentialIndex),
  index("ix_assurance_passkey_user").on(t.userId),
]);

export const assuranceChallenges = mysqlTable("assurance_challenges", {
  id: idColumn(),
  publicId: publicIdColumn(),
  userId: refColumn("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sessionId: char("session_id", { length: 26 }).notNull(),
  purpose: mysqlEnum("purpose", ["challenge", "step_up", "register", "recovery_reissue"]).notNull(),
  challengeHash: varchar("challenge_hash", { length: 128 }).notNull(),
  expiresAt: utcDateTime("expires_at").notNull(),
  createdAt: createdAtColumn(),
}, (t) => [
  uniqueIndex("uq_assurance_challenge_session_purpose").on(t.userId, t.sessionId, t.purpose),
  index("ix_assurance_challenge_expiry").on(t.expiresAt),
]);
