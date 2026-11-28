/**
 * Trash coordinator durable tables (Increment 09, Decision D2.3–D2.5 & D2.8).
 * Owner: recovery_ops_engineer.
 *
 * Security & durability invariants:
 *  - Zero personal data (names, e-mail addresses, notes, or raw user-entered reasons) is stored here.
 *    `target_reference` holds only non-personal public numbers (`RP-...` order numbers / `RPCUS-...` customer numbers).
 *  - `trash_purge_runs` is keyed uniquely on `(entity_kind, entity_public_id, batch_id)` and carries a monotonic
 *    `fencing_token` plus `next_retry_at` backoff for fair retention progression.
 *  - `trash_purge_run_targets` holds durable, irreversible per-target run ownership via a PERMANENT unique key on
 *    `(entity_kind, entity_id)`: every claimed target (root, additions, customer-cascaded orders, reassigned group
 *    members, and the customer row itself) belongs to at most one purge run forever, carries its own bounded
 *    per-target participant checkpoint (`checkpoint_json`), and records per-order typed external-copy acknowledgment.
 *  - `trash_idempotency_keys` binds `idempotencyKey` (`key_hash`) to `(actor_user_id, action)` and retains committed
 *    purge claims and mutations permanently across retries so cross-generation reuse always fails closed.
 *  - `trash_retention_state` (`singleton_key = 1`) provides a row-locked composite version token (`FOR UPDATE`)
 *    for retention setting compare-and-set updates across both production and test settings stores.
 */
import {
  char,
  foreignKey,
  index,
  int,
  mediumtext,
  mysqlEnum,
  mysqlTable,
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

export const TRASH_ENTITY_KINDS = ["order", "customer"] as const;
export const TRASH_PURGE_TRIGGERS = ["manual", "retention"] as const;
export const TRASH_PURGE_RUN_STATUSES = ["running", "completed", "failed"] as const;
export const TRASH_PURGE_TARGET_STATUSES = ["pending", "running", "completed"] as const;
export const TRASH_SWEEP_STATUSES = ["running", "completed", "failed"] as const;

export type TrashPurgeTrigger = (typeof TRASH_PURGE_TRIGGERS)[number];
export type TrashPurgeRunStatus = (typeof TRASH_PURGE_RUN_STATUSES)[number];
export type TrashPurgeTargetStatus = (typeof TRASH_PURGE_TARGET_STATUSES)[number];
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
    /** Monotonic execution fencing token incremented each time an advisory-locked worker claims/resumes the run. */
    fencingToken: int("fencing_token", { unsigned: true }).notNull().default(1),
    /** Legacy/summary target list (`MEDIUMTEXT` so large cascades never hit 64 KiB `TEXT` bounds). */
    targetsJson: mediumtext("targets_json").notNull(),
    /** Run-level metadata JSON (`MEDIUMTEXT`; per-target checkpoints live in `trash_purge_run_targets`). */
    checkpointJson: mediumtext("checkpoint_json").notNull(),
    /** Aggregated safe counts (`{ deleted: Record<module, Record<key, number>>, kept: ... }`). */
    countsJson: mediumtext("counts_json").notNull(),
    attemptCount: int("attempt_count", { unsigned: true }).notNull().default(1),
    errorCode: varchar("error_code", { length: 64 }),
    failedModule: varchar("failed_module", { length: 64 }),
    /** Specific failing target public ULID when a multi-target cascade halts (e.g. `EXTERNAL_COPIES_UNREACHABLE`). */
    failedTargetPublicId: char("failed_target_public_id", { length: 26 }),
    /** Earliest UTC instant at which the retention sweep may retry a failed run (prevents head-of-line starvation). */
    nextRetryAt: utcDateTime("next_retry_at"),
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
    index("trash_purge_run_retry_ix").on(t.status, t.nextRetryAt, t.id),
    index("trash_purge_run_sweep_ix").on(t.sweepPublicId),
  ],
);

export const trashPurgeRunTargets = mysqlTable(
  "trash_purge_run_targets",
  {
    id: idColumn(),
    runId: refColumn("run_id").notNull(),
    entityKind: mysqlEnum("entity_kind", TRASH_ENTITY_KINDS).notNull(),
    entityId: refColumn("entity_id").notNull(),
    entityPublicId: char("entity_public_id", { length: 26 }).notNull(),
    /** Non-personal public reference (`RP-...` order number or `RPCUS-...` customer number) for typed confirmations. */
    targetReference: varchar("target_reference", { length: 64 }),
    batchId: char("batch_id", { length: 26 }).notNull(),
    position: int("position", { unsigned: true }).notNull(),
    status: mysqlEnum("status", TRASH_PURGE_TARGET_STATUSES).notNull().default("pending"),
    /** Per-target participant checkpoint map (`{ [moduleName]: { deleted, kept } }`). */
    checkpointJson: mediumtext("checkpoint_json").notNull(),
    /** Scoped per-order admin decision to leave unreachable external storage copies in place. */
    leaveExternalCopiesApprovedAt: utcDateTime("leave_external_copies_approved_at"),
    leaveExternalCopiesActorUserId: refColumn("leave_external_copies_actor_user_id"),
    tombstonedAt: utcDateTime("tombstoned_at"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    foreignKey({
      name: "trash_purge_target_run_fk",
      columns: [t.runId],
      foreignColumns: [trashPurgeRuns.id],
    }).onDelete("cascade"),
    uniqueIndex("trash_purge_target_entity_uq").on(t.entityKind, t.entityId),
    index("trash_purge_target_run_pos_ix").on(t.runId, t.position),
    index("trash_purge_target_pub_ix").on(t.entityKind, t.entityPublicId),
  ],
);

export const trashCleanupSweeps = mysqlTable(
  "trash_cleanup_sweeps",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    status: mysqlEnum("status", TRASH_SWEEP_STATUSES).notNull().default("running"),
    fencingToken: int("fencing_token", { unsigned: true }).notNull().default(1),
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
    responseJson: mediumtext("response_json").notNull(),
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
export type TrashPurgeRunTargetRow = typeof trashPurgeRunTargets.$inferSelect;
export type TrashCleanupSweepRow = typeof trashCleanupSweeps.$inferSelect;
export type TrashIdempotencyKeyRow = typeof trashIdempotencyKeys.$inferSelect;
export type TrashRetentionStateRow = typeof trashRetentionState.$inferSelect;
