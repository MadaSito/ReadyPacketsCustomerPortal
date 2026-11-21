import {
  boolean,
  char,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import {
  createdAtColumn,
  idColumn,
  publicIdColumn,
  refColumn,
  updatedAtColumn,
  utcDateTime,
  versionColumn,
} from "../../db/columns.js";
import {
  AUTOMATION_RUN_STATES,
  AUTOMATION_STEP_STATES,
  AUTOMATION_TRIGGER_MODES,
} from "./contracts.js";

/**
 * Automation definitions. Additive Increment 03 table (`automations`).
 * Action configurations live in `actions_json` while step secrets live separately in `automation_secrets`
 * so neither `automations` nor `automation_versions` snapshots ever echo secret material.
 */
export const automations = mysqlTable(
  "automations",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    name: varchar("name", { length: 160 }).notNull(),
    description: varchar("description", { length: 500 }),
    enabled: boolean("enabled").notNull().default(false),
    version: versionColumn(),
    triggerMode: mysqlEnum("trigger_mode", AUTOMATION_TRIGGER_MODES).notNull(),
    triggerKey: varchar("trigger_key", { length: 80 }),
    triggerEventName: varchar("trigger_event_name", { length: 120 }),
    scheduleEveryMinutes: int("schedule_every_minutes", { unsigned: true }),
    nextScheduledAt: utcDateTime("next_scheduled_at"),
    manualRequireOrder: boolean("manual_require_order").notNull().default(false),
    maxRunsPerHour: int("max_runs_per_hour", { unsigned: true }).notNull().default(60),
    conditionsJson: text("conditions_json").notNull(),
    actionsJson: text("actions_json").notNull(),
    canvasLayoutJson: text("canvas_layout_json"),
    createdByUserId: refColumn("created_by_user_id"),
    updatedByUserId: refColumn("updated_by_user_id"),
    lastRunId: refColumn("last_run_id"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    index("automations_enabled_event_idx").on(t.enabled, t.triggerMode, t.triggerEventName),
    index("automations_schedule_due_idx").on(t.enabled, t.triggerMode, t.nextScheduledAt),
    index("automations_updated_id_idx").on(t.updatedAt, t.id),
  ],
);

/**
 * Immutable version snapshots appended on every create/update (`automation_versions`).
 */
export const automationVersions = mysqlTable(
  "automation_versions",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    automationId: refColumn("automation_id").notNull(),
    version: int("version", { unsigned: true }).notNull(),
    triggerJson: text("trigger_json").notNull(),
    conditionsJson: text("conditions_json").notNull(),
    actionsJson: text("actions_json").notNull(),
    canvasLayoutJson: text("canvas_layout_json"),
    createdByUserId: refColumn("created_by_user_id"),
    createdAt: createdAtColumn(),
  },
  (t) => [
    uniqueIndex("automation_versions_auto_ver_uq").on(t.automationId, t.version),
    index("automation_versions_auto_created_idx").on(t.automationId, t.createdAt),
  ],
);

/**
 * Encrypted write-only action secrets (e.g. webhook signing keys).
 * Encrypted with `deps.crypto.encrypt(plaintext, "automation_secrets.secret_enc:" + publicId)`.
 */
export const automationSecrets = mysqlTable(
  "automation_secrets",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    automationId: refColumn("automation_id").notNull(),
    stepKey: varchar("step_key", { length: 40 }).notNull(),
    fieldKey: varchar("field_key", { length: 64 }).notNull(),
    secretEnc: text("secret_enc").notNull(),
    last4: varchar("last4", { length: 4 }).notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex("automation_secrets_step_field_uq").on(t.automationId, t.stepKey, t.fieldKey),
  ],
);

/**
 * Recorded automation runs (`automation_runs`).
 * `dedup_key` deduplicates `(automation_id, trigger_event_id)` for event triggers and `(automation_id, slot)`
 * for scheduled triggers at the database constraint level (Gate 4.1 J).
 */
export const automationRuns = mysqlTable(
  "automation_runs",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    automationId: refColumn("automation_id").notNull(),
    automationPublicId: char("automation_public_id", { length: 26 }).notNull(),
    automationName: varchar("automation_name", { length: 160 }).notNull(),
    automationVersion: int("automation_version", { unsigned: true }).notNull(),
    triggerMode: mysqlEnum("trigger_mode", AUTOMATION_TRIGGER_MODES).notNull(),
    triggerKey: varchar("trigger_key", { length: 80 }),
    triggerEventId: varchar("trigger_event_id", { length: 64 }),
    dedupKey: varchar("dedup_key", { length: 120 }).notNull(),
    correlationId: varchar("correlation_id", { length: 64 }).notNull(),
    isTest: boolean("is_test").notNull().default(false),
    state: mysqlEnum("state", AUTOMATION_RUN_STATES).notNull(),
    reasonCode: varchar("reason_code", { length: 64 }),
    evaluatedFieldsJson: text("evaluated_fields_json").notNull(),
    contextSnapshotEnc: text("context_snapshot_enc"),
    jobPublicId: varchar("job_public_id", { length: 40 }),
    queuedAt: utcDateTime("queued_at").notNull(),
    startedAt: utcDateTime("started_at"),
    finishedAt: utcDateTime("finished_at"),
    durationMs: int("duration_ms", { unsigned: true }),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex("automation_runs_auto_dedup_uq").on(t.automationId, t.dedupKey),
    index("automation_runs_auto_queued_idx").on(t.automationId, t.queuedAt, t.id),
    index("automation_runs_state_queued_idx").on(t.state, t.queuedAt, t.id),
    index("automation_runs_queued_idx").on(t.queuedAt, t.id),
  ],
);

/**
 * Per-action execution records within a run (`automation_run_steps`).
 * `state = "dispatching"` is fenced under `job.assertStillOwned(tx)` for `retrySafe: false` actions so a lost
 * worker lease never dispatches a non-idempotent webhook twice.
 */
export const automationRunSteps = mysqlTable(
  "automation_run_steps",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    runId: refColumn("run_id").notNull(),
    stepIndex: int("step_index", { unsigned: true }).notNull(),
    stepKey: varchar("step_key", { length: 40 }).notNull(),
    actionKey: varchar("action_key", { length: 80 }).notNull(),
    state: mysqlEnum("state", AUTOMATION_STEP_STATES).notNull().default("pending"),
    attemptCount: int("attempt_count", { unsigned: true }).notNull().default(0),
    reasonCode: varchar("reason_code", { length: 64 }),
    safeSummary: varchar("safe_summary", { length: 255 }),
    safeCountsJson: text("safe_counts_json"),
    externalRef: varchar("external_ref", { length: 120 }),
    startedAt: utcDateTime("started_at"),
    finishedAt: utcDateTime("finished_at"),
    durationMs: int("duration_ms", { unsigned: true }),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex("automation_run_steps_run_idx_uq").on(t.runId, t.stepIndex),
    index("automation_run_steps_state_idx").on(t.state, t.updatedAt),
  ],
);
