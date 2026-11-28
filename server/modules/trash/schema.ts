/**
 * Trash coordinator durable tables (Increment 09, Decision D2.3–D2.5 & D2.8).
 * Owner: recovery_ops_engineer.
 *
 * Security & durability invariants:
 *  - Zero personal data (names, e-mail addresses, notes, or raw user-entered reasons) is stored here.
 *    `target_reference` holds only non-personal public numbers (`RP-...` order numbers / `RPCUS-...` customer numbers).
 *  - `trash_purge_runs` is keyed uniquely on `(entity_kind, entity_public_id, batch_id)` and carries a pure row-locked
 *    ownership fence (`status`, `fencing_token`, `lease_owner`, `lease_expires_at`) plus `next_retry_at` exponential
 *    backoff (capped >= 24 h) for fair retention progression.
 *  - `trash_purge_run_targets` holds durable, irreversible per-target run ownership via a PERMANENT unique key on
 *    `(entity_kind, entity_id)` and binds per-order unreachable external-copy acknowledgments to the exact observed
 *    proof set (`leave_external_copies_proof_json`).
 *  - `trash_cleanup_sweeps` enforces single-active retention execution via `UNIQUE(active_slot)` (`1` while running,
 *    `NULL` once finished) and a row-locked `lease_expires_at` + `fencing_token` (zero held pool connections).
 *  - `trash_retention_deferrals` persists per-target `(entity_kind, entity_id, batch_id)` exponential backoff
 *    (`next_attempt_at`, cap >= 24 h) and single-shot `alerted_at` for held/refused items (`ORDER_ON_LEGAL_HOLD`,
 *    `CASCADE_TOO_LARGE`, etc.) without blocking later `restore` once a hold is released.
 *  - `trash_idempotency_keys` atomically links `claimed_run_public_id` + `status` in the claim transaction and never
 *    purges reservations with unfinished runs during 24 h TTL clean-up.
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
export const TRASH_IDEMPOTENCY_STATUSES = ["in_progress", "claimed", "completed", "failed"] as const;

export type TrashPurgeTrigger = (typeof TRASH_PURGE_TRIGGERS)[number];
export type TrashPurgeRunStatus = (typeof TRASH_PURGE_RUN_STATUSES)[number];
export type TrashPurgeTargetStatus = (typeof TRASH_PURGE_TARGET_STATUSES)[number];
export type TrashSweepStatus = (typeof TRASH_SWEEP_STATUSES)[number];
export type TrashIdempotencyStatus = (typeof TRASH_IDEMPOTENCY_STATUSES)[number];

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
    /** Monotonic execution fencing token incremented under `FOR UPDATE` whenever a worker claims or takes over the run. */
    fencingToken: int("fencing_token", { unsigned: true }).notNull().default(1),
    /** Current worker ownership token verified alongside `fencing_token` inside `assertCurrentInTx(tx)`. */
    leaseOwner: varchar("lease_owner", { length: 64 }),
    /** Row-fenced lease expiry renewed by token-CAS between steps and on a background heartbeat during long steps. */
    leaseExpiresAt: utcDateTime("lease_expires_at"),
    /** Summary target list (`MEDIUMTEXT` so large cascades never hit 64 KiB `TEXT` bounds). */
    targetsJson: mediumtext("targets_json").notNull(),
    /** Run-level metadata JSON (`MEDIUMTEXT`; per-target checkpoints live in `trash_purge_run_targets`). */
    checkpointJson: mediumtext("checkpoint_json").notNull(),
    /** Aggregated safe counts (`{ deleted: Record<key, number>, kept: Record<key, number> }`). */
    countsJson: mediumtext("counts_json").notNull(),
    attemptCount: int("attempt_count", { unsigned: true }).notNull().default(1),
    errorCode: varchar("error_code", { length: 64 }),
    failedModule: varchar("failed_module", { length: 64 }),
    /** Specific failing target public ULID when a multi-target cascade halts (e.g. `EXTERNAL_COPIES_UNREACHABLE`). */
    failedTargetPublicId: char("failed_target_public_id", { length: 26 }),
    /** Earliest UTC instant at which the retention sweep may retry a failed run (exponential backoff capped >= 24 h). */
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
    index("trash_purge_run_status_ix").on(t.status, t.leaseExpiresAt, t.startedAt),
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
    /** Observed `{ unreachableCopies, unreachableCopyCounts }` proof set bound when the admin acknowledged this order. */
    leaveExternalCopiesProofJson: mediumtext("leave_external_copies_proof_json"),
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
    /** `1` strictly while `status = 'running'`, `NULL` once finished — enforces single-active sweep without pool locks. */
    activeSlot: int("active_slot", { unsigned: true }),
    fencingToken: int("fencing_token", { unsigned: true }).notNull().default(1),
    leaseOwner: varchar("lease_owner", { length: 64 }),
    leaseExpiresAt: utcDateTime("lease_expires_at"),
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
    uniqueIndex("trash_cleanup_sweep_active_uq").on(t.activeSlot),
    index("trash_cleanup_sweep_status_ix").on(t.status, t.startedAt),
    index("trash_cleanup_sweep_fin_ix").on(t.finishedAt, t.id),
  ],
);

export const trashRetentionDeferrals = mysqlTable(
  "trash_retention_deferrals",
  {
    id: idColumn(),
    entityKind: mysqlEnum("entity_kind", TRASH_ENTITY_KINDS).notNull(),
    entityId: refColumn("entity_id").notNull(),
    entityPublicId: char("entity_public_id", { length: 26 }).notNull(),
    batchId: char("batch_id", { length: 26 }).notNull(),
    reasonCode: varchar("reason_code", { length: 64 }).notNull(),
    attemptCount: int("attempt_count", { unsigned: true }).notNull().default(1),
    nextAttemptAt: utcDateTime("next_attempt_at").notNull(),
    /** Set the first time an operational alert (e.g. `ORDER_ON_LEGAL_HOLD`) is emitted for this `(entity, batchId)`. */
    alertedAt: utcDateTime("alerted_at"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex("trash_ret_deferral_entity_batch_uq").on(t.entityKind, t.entityId, t.batchId),
    index("trash_ret_deferral_next_ix").on(t.entityKind, t.nextAttemptAt, t.entityId),
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
    status: mysqlEnum("status", TRASH_IDEMPOTENCY_STATUSES).notNull().default("in_progress"),
    /** Atomically populated inside the claim transaction so a crashed request is durably bound to its owning run. */
    claimedRunPublicId: char("claimed_run_public_id", { length: 26 }),
    responseJson: mediumtext("response_json").notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex("trash_idem_actor_act_key_uq").on(t.actorUserId, t.action, t.keyHash),
    index("trash_idem_status_created_ix").on(t.status, t.createdAt),
    index("trash_idem_run_ix").on(t.claimedRunPublicId),
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
export type TrashRetentionDeferralRow = typeof trashRetentionDeferrals.$inferSelect;
export type TrashIdempotencyKeyRow = typeof trashIdempotencyKeys.$inferSelect;
export type TrashRetentionStateRow = typeof trashRetentionState.$inferSelect;
