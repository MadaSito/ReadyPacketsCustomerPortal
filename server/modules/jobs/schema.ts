/**
 * Jobs module — Drizzle MySQL tables. Owner: jobs module engineer.
 * Use the helpers in server/db/columns.ts. Table names are prefixed by domain where ambiguous.
 */
import { bigint, boolean, char, index, int, json, mysqlEnum, mysqlTable, mediumtext, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { createdAtColumn, idColumn, publicIdColumn, refColumn, updatedAtColumn, utcDateTime } from "../../db/columns.js";

export const JOB_STATES = ["queued", "running", "completed", "failed", "canceled", "unknown"] as const;
export const MAIL_STATES = ["queued", "sending", "accepted", "held", "captured", "failed", "expired", "unknown", "canceled"] as const;
export const ATTEMPT_STATES = ["running", "completed", "failed", "canceled", "unknown", "interrupted"] as const;
export const MAIL_ATTEMPT_STATES = ["sending", "accepted", "held", "captured", "failed", "unknown"] as const;

export const jobRuns = mysqlTable("job_runs", {
  id: idColumn(),
  publicId: publicIdColumn(),
  type: varchar("type", { length: 100 }).notNull(),
  idempotencyHash: char("idempotency_hash", { length: 64 }),
  payloadEnc: mediumtext("payload_enc"),
  state: mysqlEnum("state", JOB_STATES).notNull().default("queued"),
  correlationId: varchar("correlation_id", { length: 64 }).notNull(),
  attempt: int("attempt", { unsigned: true }).notNull().default(0),
  maxAttempts: int("max_attempts", { unsigned: true }).notNull(),
  retrySafe: boolean("retry_safe").notNull().default(false),
  allowRetry: boolean("allow_retry").notNull().default(false),
  interruptionPending: boolean("interruption_pending").notNull().default(false),
  reconciledAt: utcDateTime("reconciled_at"),
  reasonCode: varchar("reason_code", { length: 64 }),
  runAt: utcDateTime("run_at").notNull(),
  leaseUntil: utcDateTime("lease_until"),
  fencingToken: bigint("fencing_token", { mode: "number", unsigned: true }).notNull().default(0),
  scheduleName: varchar("schedule_name", { length: 100 }),
  scheduleSlot: utcDateTime("schedule_slot"),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (t) => [
  uniqueIndex("job_runs_type_key_uq").on(t.type, t.idempotencyHash),
  uniqueIndex("job_runs_schedule_slot_uq").on(t.scheduleName, t.scheduleSlot),
  index("job_runs_ready_ix").on(t.state, t.runAt, t.id),
  index("job_runs_stale_ix").on(t.state, t.leaseUntil, t.id),
  index("job_runs_type_ix").on(t.type, t.publicId),
  index("job_runs_state_public_ix").on(t.state, t.publicId),
]);

export const jobAttempts = mysqlTable("job_attempts", {
  id: idColumn(),
  jobId: refColumn("job_id").notNull().references(() => jobRuns.id),
  attempt: int("attempt", { unsigned: true }).notNull(),
  fencingToken: bigint("fencing_token", { mode: "number", unsigned: true }).notNull(),
  state: mysqlEnum("state", ATTEMPT_STATES).notNull(),
  reasonCode: varchar("reason_code", { length: 64 }),
  safeCounts: json("safe_counts").$type<Record<string, number>>(),
  startedAt: utcDateTime("started_at").notNull(),
  finishedAt: utcDateTime("finished_at"),
}, (t) => [uniqueIndex("job_attempts_fence_uq").on(t.jobId, t.fencingToken)]);

export const jobMaintenance = mysqlTable("job_maintenance", {
  id: int("id", { unsigned: true }).primaryKey(),
  active: boolean("active").notNull().default(false),
  updatedAt: updatedAtColumn(),
});

export const customerMaintenance = mysqlTable("customer_maintenance", {
  id: int("id", { unsigned: true }).primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  message: varchar("message", { length: 500 }).notNull().default(""),
  startsAt: utcDateTime("starts_at"),
  endsAt: utcDateTime("ends_at"),
  version: int("version", { unsigned: true }).notNull().default(0),
  updatedAt: updatedAtColumn(),
});

export const mailOutbox = mysqlTable("mail_outbox", {
  id: idColumn(),
  publicId: publicIdColumn(),
  template: varchar("template", { length: 100 }).notNull(),
  idempotencyHash: char("idempotency_hash", { length: 64 }).notNull(),
  correlationId: varchar("correlation_id", { length: 64 }).notNull(),
  payloadEnc: mediumtext("payload_enc"),
  captureEnc: mediumtext("capture_enc"),
  contentEnc: mediumtext("content_enc"),
  contentExpiresAt: utcDateTime("content_expires_at"),
  state: mysqlEnum("state", MAIL_STATES).notNull().default("queued"),
  reasonCode: varchar("reason_code", { length: 64 }),
  jobPublicId: char("job_public_id", { length: 26 }),
  generation: int("generation", { unsigned: true }).notNull().default(1),
  expiresAt: utcDateTime("expires_at").notNull(),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (t) => [
  uniqueIndex("mail_outbox_key_uq").on(t.idempotencyHash),
  index("mail_outbox_state_ix").on(t.state, t.publicId),
  index("mail_outbox_expiry_ix").on(t.expiresAt, t.id),
  index("mail_outbox_job_ix").on(t.jobPublicId),
  index("mail_outbox_content_expiry_ix").on(t.contentExpiresAt, t.id),
]);

export const mailAttempts = mysqlTable("mail_attempts", {
  id: idColumn(),
  mailId: refColumn("mail_id").notNull().references(() => mailOutbox.id),
  generation: int("generation", { unsigned: true }).notNull(),
  state: mysqlEnum("state", MAIL_ATTEMPT_STATES).notNull(),
  reasonCode: varchar("reason_code", { length: 64 }),
  startedAt: utcDateTime("started_at").notNull(),
  finishedAt: utcDateTime("finished_at"),
}, (t) => [uniqueIndex("mail_attempts_generation_uq").on(t.mailId, t.generation)]);

// Keep the legacy attempt table and its unique key intact for in-place upgrades.
export const mailTransportAttempts = mysqlTable("mail_transport_attempts", {
  id: idColumn(),
  mailId: refColumn("mail_id").notNull().references(() => mailOutbox.id),
  generation: int("generation", { unsigned: true }).notNull(),
  purpose: mysqlEnum("purpose", ["primary", "secondary", "audit_copy"]).notNull(),
  transport: mysqlEnum("transport", ["smtp", "graph"]).notNull(),
  state: mysqlEnum("state", MAIL_ATTEMPT_STATES).notNull(),
  reasonCode: varchar("reason_code", { length: 64 }),
  startedAt: utcDateTime("started_at").notNull(),
  finishedAt: utcDateTime("finished_at"),
}, (t) => [uniqueIndex("mail_transport_attempts_slot_uq").on(t.mailId, t.generation, t.purpose)]);

export const mailAuditVerification = mysqlTable("mail_audit_verification", {
  id: int("id", { unsigned: true }).primaryKey(),
  addressHash: char("address_hash", { length: 64 }).notNull(),
  codeHash: char("code_hash", { length: 64 }),
  expiresAt: utcDateTime("expires_at"),
  verifiedAt: utcDateTime("verified_at"),
});
