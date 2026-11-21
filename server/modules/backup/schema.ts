/**
 * Backup & disaster-recovery Drizzle MySQL tables. Owner: recovery_ops_engineer.
 *
 * Conventions:
 *  - `id` BIGINT UNSIGNED auto-increment (installation-local)
 *  - `public_id` CHAR(26) ULID (the only identifier exposed in APIs/URLs/audit)
 *  - No raw secrets, keys, filenames, or user free-text stored unencrypted.
 */
import { bigint, boolean, char, index, int, json, mysqlEnum, mysqlTable, text, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { OPERATION_STATES } from "../../../shared/domain.js";
import { createdAtColumn, idColumn, publicIdColumn, refColumn, updatedAtColumn, utcDateTime } from "../../db/columns.js";
import { users } from "../identity/schema.js";

export const BACKUP_TRIGGERS = ["manual", "scheduled", "pre_upgrade", "cli"] as const;
export type BackupTrigger = (typeof BACKUP_TRIGGERS)[number];

export const BACKUP_KEY_CUSTODY_MODES = ["host_file", "env_var", "settings_secret"] as const;
export type BackupKeyCustodyMode = (typeof BACKUP_KEY_CUSTODY_MODES)[number];

export const BACKUP_VERIFICATION_STATUSES = ["unverified", "verified", "failed"] as const;
export type BackupVerificationStatus = (typeof BACKUP_VERIFICATION_STATUSES)[number];

export const OFFHOST_COPY_STATUSES = ["local_only", "disabled"] as const;
export type OffHostCopyStatus = (typeof OFFHOST_COPY_STATUSES)[number];

export const CONTINUITY_MODES = ["preserve_continuity", "quarantine_credentials"] as const;
export type ContinuityMode = (typeof CONTINUITY_MODES)[number];

export const KEY_READINESS_STATES = ["ready", "missing_data_keys", "unknown"] as const;
export type KeyReadinessState = (typeof KEY_READINESS_STATES)[number];

export const VERIFIED_DIGEST_KINDS = ["sha256", "md5", "quickxor", "size_only"] as const;
export type VerifiedDigestKind = (typeof VERIFIED_DIGEST_KINDS)[number];

export interface StoredContinuityReport {
  continuityMode: ContinuityMode;
  sessionsRevoked: number;
  singleUseTokensRetired: number;
  ephemeralChallengesCleared: number;
  downloadTicketsCleared: number;
  totpWatermarksAdvanced: number;
  passkeyCountersReconciled: number;
  recoveryCodesReconciled: number;
  queuedJobsQuarantined: number;
  queuedMailQuarantined: number;
  externalFlagsDisabled: number;
  auditChainVerified: "verified" | "failed" | "not_present";
  auditContinuityMarkerAppended: boolean;
}

export interface StoredIntegrityReport {
  schemaMigrationsMatched: boolean;
  restoredMigrationCount: number;
  expectedMigrationCount: number;
  tablesChecked: number;
  tableRowMismatches: { table: string; expected: number; actual: number }[];
  objectsChecked: number;
  objectHashMismatches: number;
  passed: boolean;
}

export const backupArchives = mysqlTable(
  "backup_archives",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    state: mysqlEnum("state", OPERATION_STATES).notNull().default("queued"),
    reasonCode: varchar("reason_code", { length: 64 }),
    trigger: mysqlEnum("trigger_kind", BACKUP_TRIGGERS).notNull().default("manual"),
    /** Private ObjectStorage key (`backups/<32hex>`). Null when refused/failed before write or after retention purge. */
    storageKey: varchar("storage_key", { length: 64 }),
    encryptedSizeBytes: bigint("encrypted_size_bytes", { mode: "number", unsigned: true }),
    archiveSha256: char("archive_sha256", { length: 64 }),
    manifestSha256: char("manifest_sha256", { length: 64 }),
    backupKeyId: varchar("backup_key_id", { length: 32 }),
    keyCustodyMode: mysqlEnum("key_custody_mode", BACKUP_KEY_CUSTODY_MODES),
    installationId: varchar("installation_id", { length: 64 }).notNull(),
    releaseRef: varchar("release_ref", { length: 80 }).notNull(),
    schemaMigrationCount: int("schema_migration_count", { unsigned: true }),
    lastMigrationHash: varchar("last_migration_hash", { length: 128 }),
    objectCount: int("object_count", { unsigned: true }),
    objectTotalBytes: bigint("object_total_bytes", { mode: "number", unsigned: true }),
    verificationStatus: mysqlEnum("verification_status", BACKUP_VERIFICATION_STATUSES).notNull().default("unverified"),
    lastVerifiedAt: utcDateTime("last_verified_at"),
    offHostCopyStatus: mysqlEnum("offhost_copy_status", OFFHOST_COPY_STATUSES).notNull().default("local_only"),
    jobPublicId: varchar("job_public_id", { length: 64 }),
    correlationId: varchar("correlation_id", { length: 64 }),
    requestedByUserId: refColumn("requested_by_user_id").references(() => users.id, { onDelete: "set null" }),
    completedAt: utcDateTime("completed_at"),
    /** Non-null when pruned by retention policy; row stays as immutable audit/historical evidence. */
    purgedAt: utcDateTime("purged_at"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex("backup_archives_storage_key_uq").on(t.storageKey),
    index("backup_archives_state_created_idx").on(t.state, t.createdAt, t.id),
    index("backup_archives_verified_idx").on(t.verificationStatus, t.purgedAt, t.createdAt),
    index("backup_archives_created_idx").on(t.createdAt, t.id),
  ],
);
export type BackupArchiveRow = typeof backupArchives.$inferSelect;

export const backupVerifications = mysqlTable(
  "backup_verifications",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    backupId: refColumn("backup_id")
      .notNull()
      .references(() => backupArchives.id, { onDelete: "cascade" }),
    state: mysqlEnum("state", OPERATION_STATES).notNull(),
    reasonCode: varchar("reason_code", { length: 64 }),
    authenticatedBytes: bigint("authenticated_bytes", { mode: "number", unsigned: true }),
    chunksVerified: int("chunks_verified", { unsigned: true }),
    sqlSha256Matched: boolean("sql_sha256_matched"),
    objectsVerified: int("objects_verified", { unsigned: true }),
    manifestValid: boolean("manifest_valid"),
    keyReadiness: mysqlEnum("key_readiness", KEY_READINESS_STATES).notNull().default("unknown"),
    missingDataKeyIdsJson: json("missing_data_key_ids").$type<string[]>().notNull(),
    durationMs: int("duration_ms", { unsigned: true }),
    requestedByUserId: refColumn("requested_by_user_id").references(() => users.id, { onDelete: "set null" }),
    correlationId: varchar("correlation_id", { length: 64 }),
    completedAt: utcDateTime("completed_at"),
    createdAt: createdAtColumn(),
  },
  (t) => [index("backup_verifications_backup_idx").on(t.backupId, t.createdAt, t.id)],
);
export type BackupVerificationRow = typeof backupVerifications.$inferSelect;

export const backupRestoreDrills = mysqlTable(
  "backup_restore_drills",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    backupId: refColumn("backup_id")
      .notNull()
      .references(() => backupArchives.id, { onDelete: "cascade" }),
    state: mysqlEnum("state", OPERATION_STATES).notNull(),
    reasonCode: varchar("reason_code", { length: 64 }),
    targetDatabaseName: varchar("target_database_name", { length: 64 }).notNull(),
    continuityMode: mysqlEnum("continuity_mode", CONTINUITY_MODES).notNull().default("preserve_continuity"),
    achievedDataAgeMs: bigint("achieved_data_age_ms", { mode: "number", unsigned: true }),
    durationMs: int("duration_ms", { unsigned: true }),
    continuityReportJson: json("continuity_report").$type<StoredContinuityReport | null>(),
    integrityReportJson: json("integrity_report").$type<StoredIntegrityReport | null>(),
    requestedByUserId: refColumn("requested_by_user_id").references(() => users.id, { onDelete: "set null" }),
    correlationId: varchar("correlation_id", { length: 64 }),
    completedAt: utcDateTime("completed_at"),
    createdAt: createdAtColumn(),
  },
  (t) => [index("backup_restore_drills_backup_idx").on(t.backupId, t.createdAt, t.id)],
);
export type BackupRestoreDrillRow = typeof backupRestoreDrills.$inferSelect;

export const backupLegalHolds = mysqlTable(
  "backup_legal_holds",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    backupId: refColumn("backup_id")
      .notNull()
      .references(() => backupArchives.id, { onDelete: "cascade" }),
    reasonCode: varchar("reason_code", { length: 64 }).notNull(),
    /** Encrypted with FieldCrypto (aad `backup_legal_holds.note:<publicId>`) because notes may reference cases/persons. */
    noteEnc: text("note_enc").notNull(),
    createdByUserId: refColumn("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    releasedByUserId: refColumn("released_by_user_id").references(() => users.id, { onDelete: "set null" }),
    releaseReasonCode: varchar("release_reason_code", { length: 64 }),
    releasedAt: utcDateTime("released_at"),
    createdAt: createdAtColumn(),
  },
  (t) => [index("backup_legal_holds_active_idx").on(t.backupId, t.releasedAt)],
);
export type BackupLegalHoldRow = typeof backupLegalHolds.$inferSelect;

/**
 * Per-backup, per-destination off-site copy ledger (Increment 03, Package L).
 * Stores opaque ReadyPackets ULIDs, safe provider kinds/labels, and digest verification evidence only —
 * NEVER remote provider IDs, bucket names, URLs, or credentials. Remote copies are never deleted by the portal.
 */
export const backupRemoteCopies = mysqlTable(
  "backup_remote_copies",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    backupId: refColumn("backup_id")
      .notNull()
      .references(() => backupArchives.id, { onDelete: "restrict" }),
    connectionPublicId: varchar("connection_public_id", { length: 64 }).notNull(),
    providerKind: varchar("provider_kind", { length: 32 }).notNull(),
    connectionName: varchar("connection_name", { length: 120 }).notNull(),
    destinationVersion: int("destination_version", { unsigned: true }).notNull().default(1),
    state: mysqlEnum("state", OPERATION_STATES).notNull().default("queued"),
    objectName: varchar("object_name", { length: 160 }).notNull(),
    verifiedBytes: bigint("verified_bytes", { mode: "number", unsigned: true }),
    archiveSha256: char("archive_sha256", { length: 64 }).notNull(),
    digestVerified: boolean("digest_verified").notNull().default(false),
    verifiedDigestKind: varchar("verified_digest_kind", { length: 16 }).$type<VerifiedDigestKind | null>(),
    attemptCount: int("attempt_count", { unsigned: true }).notNull().default(0),
    jobPublicId: varchar("job_public_id", { length: 64 }),
    reasonCode: varchar("reason_code", { length: 64 }),
    startedAt: utcDateTime("started_at"),
    completedAt: utcDateTime("completed_at"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex("backup_remote_copies_archive_conn_uq").on(t.backupId, t.connectionPublicId),
    index("backup_remote_copies_state_updated_idx").on(t.state, t.updatedAt, t.id),
    index("backup_remote_copies_conn_idx").on(t.connectionPublicId, t.state),
  ],
);
export type BackupRemoteCopyRow = typeof backupRemoteCopies.$inferSelect;

