import { index, int, mysqlEnum, mysqlTable, uniqueIndex, char } from "drizzle-orm/mysql-core";
import {
  createdAtColumn,
  idColumn,
  publicIdColumn,
  refColumn,
  updatedAtColumn,
  utcDateTime,
  versionColumn,
} from "../../db/columns.js";
import { users } from "../identity/schema.js";
import { policyDocuments, policyVersions } from "./schema.js";

export const POLICY_NOTICE_STATES = ["scheduled", "dispatching", "completed", "cancelled"] as const;

export const policyNoticePreferences = mysqlTable("policy_notice_preferences", {
  documentId: refColumn("document_id").primaryKey().references(() => policyDocuments.id),
  delayHours: int("delay_hours", { unsigned: true }).notNull().default(24),
  version: versionColumn(),
  updatedAt: updatedAtColumn(),
});

export const policyNotices = mysqlTable("policy_notices", {
  id: idColumn(),
  publicId: publicIdColumn(),
  policyVersionId: refColumn("policy_version_id").notNull().references(() => policyVersions.id),
  scheduledAt: utcDateTime("scheduled_at").notNull(),
  state: mysqlEnum("state", POLICY_NOTICE_STATES).notNull().default("scheduled"),
  /** Revision fences superseded jobs, and identifies a reminder dispatch when present. */
  revision: versionColumn("revision"),
  reminderPublicId: char("reminder_public_id", { length: 26 }),
  lastReminderAt: utcDateTime("last_reminder_at"),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (table) => [
  uniqueIndex("cmp_notice_policy_ver_uq").on(table.policyVersionId),
  index("cmp_notice_state_schedule_idx").on(table.state, table.scheduledAt),
]);

export const policyNoticeRecipients = mysqlTable("policy_notice_recipients", {
  id: idColumn(),
  noticeId: refColumn("notice_id").notNull().references(() => policyNotices.id),
  userId: refColumn("user_id").notNull().references(() => users.id),
  /** Round zero is the original delivery across all edits to its scheduled time. */
  deliveryRound: int("delivery_round", { unsigned: true }).notNull().default(0),
  reminderPublicId: char("reminder_public_id", { length: 26 }),
  mailState: mysqlEnum("mail_state", ["queued", "sent", "failed"]).notNull().default("queued"),
  nextMailCheckAt: utcDateTime("next_mail_check_at").notNull(),
  createdAt: createdAtColumn(),
}, (table) => [
  uniqueIndex("cmp_notice_recipient_round_uq").on(table.noticeId, table.deliveryRound, table.userId),
  index("cmp_notice_recipient_progress_idx").on(table.noticeId, table.deliveryRound, table.mailState),
  index("cmp_notice_recipient_mail_check_idx").on(table.mailState, table.nextMailCheckAt),
]);
