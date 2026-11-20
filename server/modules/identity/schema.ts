/**
 * Identity module — Drizzle MySQL tables. Owner: identity engineer.
 *
 * `users` is the ONE cross-module foreign-key target. Its core columns below are a team contract
 * (seeded by the integrator): identity may ADD columns/tables freely but must not rename/remove these
 * without telling /root. Authentication material (password hashes, MFA secrets, recovery codes,
 * sessions) is never part of portable business data.
 */
import { index, mysqlEnum, mysqlTable, text, uniqueIndex, varchar, char } from "drizzle-orm/mysql-core";
import { USER_ROLES } from "../../../shared/domain.js";
import { createdAtColumn, idColumn, publicIdColumn, updatedAtColumn, utcDateTime, versionColumn } from "../../db/columns.js";

export const USER_STATUSES = ["pending_activation", "active", "suspended", "deactivated"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const users = mysqlTable(
  "users",
  {
    id: idColumn(),
    /** Stable portable identity reference. */
    publicId: publicIdColumn(),
    /** Mutable, human-facing business reference (e.g. customer number). Retired values stay reserved. */
    customerRef: varchar("customer_ref", { length: 32 }).unique(),
    role: mysqlEnum("role", USER_ROLES).notNull().default("customer"),
    status: mysqlEnum("status", USER_STATUSES).notNull().default("pending_activation"),
    /** AES-256-GCM envelope (FieldCrypto.encrypt, aad `users.email:<publicId>`). */
    emailEnc: text("email_enc").notNull(),
    /** HMAC blind index of the normalized email (FieldCrypto.blindIndex(value, "users.email")). */
    emailIndex: char("email_index", { length: 64 }).notNull(),
    emailVerifiedAt: utcDateTime("email_verified_at"),
    /** Encrypted display name (aad `users.name:<publicId>`). */
    nameEnc: text("name_enc").notNull(),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [uniqueIndex("users_email_index_uq").on(table.emailIndex), index("users_role_status_idx").on(table.role, table.status)],
);
export type UserRow = typeof users.$inferSelect;
