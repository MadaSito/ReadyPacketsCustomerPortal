/**
 * Trash coordinator durable tables (Increment 09, Decision D2.3–D2.5 & D2.8).
 * Owner: recovery_ops_engineer.
 *
 * Security & durability invariants:
 *  - Zero personal data (names, e-mail addresses, notes, or raw user-entered reasons) is stored here.
 *  - `trash_purge_runs` is keyed uniquely on `(entity_kind, entity_public_id, batch_id)` so retries of a
 *    failed or interrupted purge always resume the exact same run row, immutable target cascade (`targets_json`),
 *    and per-participant checkpoint (`checkpoint_json`).
 *  - `trash_idempotency_keys` binds `idempotencyKey` (`key_hash`) to `(actor_user_id, action)` and rejects
 *    mismatched intent (`fingerprint_hash` over entity/items + `trash_batch_id` / `expectedVersion`).
 *  - `trash_retention_state` (`singleton_key = 1`) provides a row-locked composite version token (`FOR UPDATE`)
 *    for retention setting compare-and-set updates across both production and test settings stores.
 */
import { char, index, int, mysqlEnum, mysqlTable, text, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import {
  createdAtColumn,
  idColumn,
  publicIdColumn,
  refColumn,
  updatedAtColumn,
  utcDateTime,
  versionColumn,
} from "../../db/columns.js";

export const TRASH_ENTITY_KINDS = ["order", "customer"] as const;
export const TRASH_PURGE_TRIGGERS = ["manual", "retention"] as const;
export const TRASH_PURGE_RUN_STATUSES = ["running", "completed", "failed"] as const;
export const TRASH_SWEEP_STATUSES = ["running", "completed", "failed"] as const;

export type TrashPurgeTrigger = (typeof TRASH_PURGE_TRIGGERS)[number];
export type TrashPurgeRunStatus = (typeof TRASH_PURGE_RUN_STATUSES)[number];
export type TrashSweepStatus = (typeof TRASH_SWEEP_STATUSES)[number];

export const trashPurgeRuns = mysqlTable(
  "trash_purge_runs",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    entityKind: mysqlEnum("entity_kind", TRASH_ENTITY_KINDS).notNull(),
    entityId: refColumn("entity_id").notNull(),
    entityPublicId: char("entity_public_id", { length: 26 }).notNull(),
    batchId: char("batch_id", { length: 26 }).notNull(),
    sweepPublicId: char("sweep_public_id", { length: 26 }),
    trigger: mysqlEnum("trigger", TRASH_PURGE_TRIGGERS).notNull(),
    actorUserId: refColumn("actor_user_id"),
    status: mysqlEnum("status", TRASH_PURGE_RUN_STATUSES).notNull().default("running"),
    /** JSON array of immutable `TrashEntityRef` targets captured at claim time (orders first, then customer). */
    targetsJson: text("targets_json").notNull(),
    /** JSON per-target/per-module participant checkpoint map (`{ "<kind>:<publicId>:<module>": { deleted, kept } }`). */
    checkpointJson: text("checkpoint_json").notNull(),
    /** JSON aggregated counts (`{ deleted: Record<string, Record<string, number>>, kept: Record<string, Record<string, number>> }`). */
    countsJson: text("counts_json").notNull(),
    attemptCount: int("attempt_count", { unsigned: true }).notNull().default(1),
    errorCode: varchar("error_code", { length: 64 }),
    failedModule: varchar("failed_module", { length: 64 }),
    correlationId: varchar("correlation_id", { length: 64 }),
    startedAt: utcDateTime("started_at").notNull(),
    finishedAt: utcDateTime("finished_at"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex("trash_purge_run_entity_batch_uq").on(t.entityKind, t.entityPublicId, t.batchId),
    index("trash_purge_run_entity_ix").on(t.entityKind, t.entityPublicId, t.id),
    index("trash_purge_run_status_ix").on(t.status, t.startedAt),
    index("trash_purge_run_sweep_ix").on(t.sweepPublicId),
  ],
);

export const trashCleanupSweeps = mysqlTable(
  "trash_cleanup_sweeps",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    status: mysqlEnum("status", TRASH_SWEEP_STATUSES).notNull().default("running"),
    purgedCount: int("purged_count", { unsigned: true }).notNull().default(0),
    failedCount: int("failed_count", { unsigned: true }).notNull().default(0),
    errorCode: varchar("error_code", { length: 64 }),
    correlationId: varchar("correlation_id", { length: 64 }),
    startedAt: utcDateTime("started_at").notNull(),
    finishedAt: utcDateTime("finished_at"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    index("trash_cleanup_sweep_status_ix").on(t.status, t.startedAt),
    index("trash_cleanup_sweep_fin_ix").on(t.finishedAt, t.id),
  ],
);

export const trashIdempotencyKeys = mysqlTable(
  "trash_idempotency_keys",
  {
    id: idColumn(),
    actorUserId: refColumn("actor_user_id").notNull(),
    action: varchar("action", { length: 48 }).notNull(),
    keyHash: char("key_hash", { length: 64 }).notNull(),
    fingerprintHash: char("fingerprint_hash", { length: 64 }).notNull(),
    responseJson: text("response_json").notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    uniqueIndex("trash_idem_actor_act_key_uq").on(t.actorUserId, t.action, t.keyHash),
    index("trash_idem_created_ix").on(t.createdAt),
  ],
);

export const trashRetentionState = mysqlTable(
  "trash_retention_state",
  {
    id: idColumn(),
    singletonKey: int("singleton_key", { unsigned: true }).notNull().default(1),
    version: versionColumn(),
    updatedByUserId: refColumn("updated_by_user_id"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [uniqueIndex("trash_retention_singleton_uq").on(t.singletonKey)],
);

export type TrashPurgeRunRow = typeof trashPurgeRuns.$inferSelect;
export type NewTrashPurgeRunRow = typeof trashPurgeRuns.$inferInsert;
export type TrashCleanupSweepRow = typeof trashCleanupSweeps.$inferSelect;
export type TrashIdempotencyKeyRow = typeof trashIdempotencyKeys.$inferSelect;
export type TrashRetentionStateRow = typeof trashRetentionState.$inferSelect;
