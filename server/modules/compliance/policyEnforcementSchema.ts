import { index, int, mysqlEnum, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import {
  createdAtColumn,
  idColumn,
  refColumn,
  updatedAtColumn,
  utcDateTime,
  versionColumn,
} from "../../db/columns.js";
import { users } from "../identity/schema.js";
import { policyDocuments, policyVersions } from "./schema.js";

export const POLICY_ENFORCEMENT_MODES = ["none", "required_to_continue"] as const;
export const POLICY_ENFORCEMENT_REASONS = ["declined", "deadline", "admin"] as const;

export const policyEnforcementPreferences = mysqlTable("policy_enforcement_preferences", {
  documentId: refColumn("document_id").primaryKey().references(() => policyDocuments.id),
  mode: mysqlEnum("mode", POLICY_ENFORCEMENT_MODES).notNull().default("none"),
  graceHours: int("grace_hours", { unsigned: true }).notNull().default(24),
  warningText: varchar("warning_text", { length: 1000 }),
  enabledAt: utcDateTime("enabled_at"),
  version: versionColumn(),
  updatedAt: updatedAtColumn(),
}, (table) => [
  index("cmp_policy_enforcement_mode_idx").on(table.mode),
]);

export const policyEnforcementActions = mysqlTable("policy_enforcement_actions", {
  id: idColumn(),
  policyVersionId: refColumn("policy_version_id").notNull().references(() => policyVersions.id),
  userId: refColumn("user_id").notNull().references(() => users.id),
  enforcementVersion: int("enforcement_version", { unsigned: true }).notNull(),
  reason: mysqlEnum("reason", POLICY_ENFORCEMENT_REASONS).notNull(),
  completedAt: utcDateTime("completed_at"),
  createdAt: createdAtColumn(),
}, (table) => [
  uniqueIndex("cmp_enforce_user_version_uq").on(
    table.policyVersionId, table.enforcementVersion, table.userId,
  ),
  index("cmp_enforce_user_completed_idx").on(table.userId, table.completedAt),
]);
