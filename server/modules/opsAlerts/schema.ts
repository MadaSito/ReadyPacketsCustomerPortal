import { char, index, mysqlEnum, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { createdAtColumn, idColumn, publicIdColumn, refColumn, updatedAtColumn, utcDateTime } from "../../db/columns.js";

export const OPS_ALERT_SEVERITIES = ["warning", "error", "critical"] as const;
export const OPS_ALERT_STATES = ["open", "acknowledged", "resolved"] as const;
export const OPS_ALERT_SOURCES = [
  "stage_bundle", "completion_job", "automation", "webhook", "graph", "file_sync", "payment", "certificate", "attention", "trash",
] as const;
export type OpsAlertSeverity = typeof OPS_ALERT_SEVERITIES[number];
export type OpsAlertState = typeof OPS_ALERT_STATES[number];
export type OpsAlertSource = typeof OPS_ALERT_SOURCES[number];

export const operationalAlerts = mysqlTable("operational_alerts", {
  id: idColumn(),
  publicId: publicIdColumn(),
  source: mysqlEnum("source", OPS_ALERT_SOURCES).notNull(),
  severity: mysqlEnum("severity", OPS_ALERT_SEVERITIES).notNull(),
  state: mysqlEnum("state", OPS_ALERT_STATES).notNull().default("open"),
  dedupHash: char("dedup_hash", { length: 64 }).notNull(),
  code: varchar("code", { length: 64 }).notNull(),
  title: varchar("title", { length: 120 }).notNull(),
  text: varchar("text", { length: 500 }),
  orderPublicId: char("order_public_id", { length: 26 }),
  runPublicId: char("run_public_id", { length: 26 }),
  correlationId: varchar("correlation_id", { length: 64 }).notNull(),
  acknowledgedAt: utcDateTime("acknowledged_at"),
  acknowledgedByUserId: refColumn("acknowledged_by_user_id"),
  resolvedAt: utcDateTime("resolved_at"),
  resolvedByUserId: refColumn("resolved_by_user_id"),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (t) => [
  uniqueIndex("ops_alert_source_key_uq").on(t.source, t.dedupHash),
  index("ops_alert_state_severity_ix").on(t.state, t.severity, t.publicId),
  index("ops_alert_source_public_ix").on(t.source, t.publicId),
]);
