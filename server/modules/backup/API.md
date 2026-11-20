# Backup & Disaster Recovery Module — API (v1)

Owner: `recovery_ops_engineer`. Owned paths: `server/modules/backup/**`, `scripts/ops/{backup,restore}/**`, `docs/operations/BACKUP_AND_RESTORE.md` (`deploy/**` owned by `files_engineer`, `.github/**` by `portable_contract_engineer`, `client/src/features/backup/**` by `audit_engineer`).

Status markers: **[impl]** implemented + tested against MySQL 8.4.

## 1. Three Distinct Operations (Architecture §7.1 & Integrator Security Decision)

Backup, cryptographic/semantic verification, and isolated disaster-recovery restore are separate operations with distinct capabilities, privilege boundaries, and confirmation gates.

Per integrator security decision (`docs/security/REVIEW-audit-siem-backup.md`), **web-initiated restore is NOT exposed on the tRPC/HTTP surface**. Restore is strictly an **operator CLI procedure** (`scripts/ops/restore/restore-isolated.ts`) into an explicitly named isolated target database and isolated storage directory using **separate operator/recovery MySQL credentials** (`RP_RECOVERY_DATABASE_URL_FILE`).

| Operation | Surface | Capability | Step-up required | Scope & Guardrails |
| --- | --- | --- | --- | --- |
| Read inventory / status | Web tRPC | `backup.read` | No | Admin only (`adminProcedure`). Lists encrypted archives, verification ledger, CLI restore drill reports (`detail.restores`), retention policy, legal holds, and off-host copy posture. |
| Create encrypted backup | Web tRPC & CLI | `backup.run` | **Yes** | Admin + fresh step-up. **Encrypted by default** (`RPBK0001` AES-256-GCM chunked envelope). **Refuses (fails closed)** if no backup encryption key is configured — there is no plaintext mode. |
| Verify archive | Web tRPC & CLI | `backup.verify` | **Yes** | Admin + fresh step-up. Re-reads and authenticates every encrypted chunk (GCM tag, sequence, finality, no trailing bytes), decompresses and hashes the SQL dump, checks every object digest/size, validates `manifest.json` + required key IDs, and when `RP_RECOVERY_DATABASE_URL(_FILE)` is configured, executes an isolated ephemeral scratch-target restore + continuity + integrity check (`verification_scope: "scratch_restore_verified"`). |
| Download encrypted `.rpbk` | Raw HTTP GET | `backup.restore` | **Yes** | Admin + `backup.restore` + fresh step-up. Downloads the encrypted `.rpbk` archive for off-host custody or offline/CLI isolated recovery. |
| Restore to isolated target | **Operator CLI only** | Host operator (`RP_RECOVERY_DATABASE_URL_FILE`) | Typed CLI phrase | Requires `--confirm "RESTORE <backupPublicId> TO <targetDatabaseName>"`, dedicated recovery DB credentials (never the live application user or live-DB write grants), isolated empty target DB, and isolated empty `0700` storage directory. Supports 100% offline `.rpbk` restore without a live DB. Defaults to `quarantine_credentials`, revokes all sessions/tokens/tickets, verifies & checkpoints `audit_chain`, and requires manual review of accounts changed since the backup before cutover. |
| Retention & legal holds | Web tRPC & Job | `backup.retention.manage` | **Yes** | Admin + fresh step-up. Two-phase crash-safe deletion (`RETENTION_PURGE_PENDING` intent before physical unlink; `storageKey` cleared only after confirmed unlink). Never deletes a held archive or the last-known-good verified archive. |

## 2. Service Interface — `deps.services.backup: BackupModule` **[impl]**

Exported from `server/modules/backup/index.ts`:

```ts
export interface BackupArchiveSummary {
  publicId: string;
  state: OperationState; // queued | running | completed | failed | canceled | refused | unknown
  reasonCode: string | null;
  trigger: "manual" | "scheduled" | "pre_upgrade" | "cli";
  encryptedSizeBytes: number | null;
  archiveSha256: string | null;
  backupKeyId: string | null;
  keyCustodyMode: "host_file" | "env_var" | "settings_secret" | null;
  releaseRef: string;
  schemaMigrationCount: number | null;
  lastMigrationHash: string | null;
  objectCount: number | null;
  objectTotalBytes: number | null;
  verificationStatus: "unverified" | "verified" | "failed";
  lastVerifiedAt: Date | null;
  offHostCopyStatus: "local_only" | "disabled";
  activeHoldCount: number;
  isLastKnownGood: boolean;
  purgedAt: Date | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface BackupVerificationSummary {
  publicId: string;
  backupPublicId: string;
  state: OperationState;
  reasonCode: string | null;
  authenticatedBytes: number | null;
  chunksVerified: number | null;
  sqlSha256Matched: boolean | null;
  objectsVerified: number | null;
  manifestValid: boolean | null;
  keyReadiness: "ready" | "missing_data_keys" | "unknown";
  missingDataKeyIds: readonly string[];
  durationMs: number | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface RestoreContinuityReport {
  continuityMode: "preserve_continuity" | "quarantine_credentials";
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

export interface RestoreIntegrityReport {
  schemaMigrationsMatched: boolean;
  restoredMigrationCount: number;
  expectedMigrationCount: number;
  tablesChecked: number;
  tableRowMismatches: readonly { table: string; expected: number; actual: number }[];
  objectsChecked: number;
  objectHashMismatches: number;
  passed: boolean;
}

export interface RestoreDrillSummary {
  publicId: string;
  backupPublicId: string;
  state: OperationState;
  reasonCode: string | null;
  targetDatabaseName: string;
  continuityMode: "preserve_continuity" | "quarantine_credentials";
  achievedDataAgeMs: number | null;
  durationMs: number | null;
  continuity: RestoreContinuityReport | null;
  integrity: RestoreIntegrityReport | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface BackupLegalHoldView {
  publicId: string;
  backupPublicId: string;
  reasonCode: string;
  note: string;
  createdByUserPublicId: string | null;
  createdAt: Date;
  releasedAt: Date | null;
}

export interface RetentionPlanItem {
  backupPublicId: string;
  createdAt: Date;
  action: "keep" | "prune";
  keepReason: "last_known_good" | "legal_hold" | "within_retention_count" | "within_retention_age" | "non_terminal_or_unknown" | null;
}

export interface BackupModule extends ModuleLifecycle {
  listBackups(principal: SessionPrincipal, input?: { cursor?: string; limit?: number; state?: OperationState }): Promise<{
    items: BackupArchiveSummary[];
    nextCursor: string | null;
    keyConfigured: boolean;
    keyCustodyWarning: string | null;
    offHostStatusNote: string;
  }>;
  getBackup(principal: SessionPrincipal, backupPublicId: string): Promise<{
    archive: BackupArchiveSummary;
    verifications: BackupVerificationSummary[];
    restores: RestoreDrillSummary[]; // Populated by operator CLI drills (`restore-isolated.ts --record-drill` / `--backup-id`)
    holds: BackupLegalHoldView[];
  }>;
  enqueueBackup(principal: SessionPrincipal, input?: { trigger?: "manual" | "pre_upgrade" }): Promise<{ backupPublicId: string; jobId: string }>;
  runBackupDirect(options?: {
    trigger?: "manual" | "scheduled" | "pre_upgrade" | "cli";
    actorUserId?: number | null;
    correlationId?: string;
    backupPublicId?: string;
    assertFence?: (tx?: Tx) => Promise<void>;
    abortSignal?: AbortSignal;
  }): Promise<BackupArchiveSummary>;
  verifyBackup(principal: SessionPrincipal, backupPublicId: string): Promise<BackupVerificationSummary>;
  verifyBackupDirect(backupPublicId: string, options?: {
    actorUserId?: number | null;
    correlationId?: string;
    assertFence?: (tx?: Tx) => Promise<void>;
  }): Promise<BackupVerificationSummary>;
  /** Operator CLI / test-only entry point — NEVER mounted on tRPC or web routes. */
  restoreToIsolatedTargetDirect(input: {
    backupPublicId: string;
    targetDatabaseName: string;
    targetStorageDir: string;
    recoveryDatabaseUrl?: string;
    archiveFilePath?: string;
    continuityMode?: "preserve_continuity" | "quarantine_credentials";
    confirmationText: string;
    actorUserId?: number | null;
    correlationId?: string;
  }): Promise<RestoreDrillSummary>;
  getRetentionPolicy(principal: SessionPrincipal): Promise<{
    keepLastCount: number;
    maxAgeDays: number;
    scheduleEnabled: boolean;
    autoPruneEnabled: boolean;
    recoverySandboxRoot: string;
  }>;
  updateRetentionPolicy(principal: SessionPrincipal, input: {
    keepLastCount: number;
    maxAgeDays: number;
    scheduleEnabled: boolean;
    autoPruneEnabled?: boolean;
  }): Promise<void>;
  previewRetention(principal: SessionPrincipal): Promise<{ items: RetentionPlanItem[] }>;
  runRetention(principal: SessionPrincipal, input: { dryRun: boolean }): Promise<{ prunedCount: number; items: RetentionPlanItem[] }>;
  createLegalHold(principal: SessionPrincipal, input: { backupPublicId: string; reasonCode: string; note: string }): Promise<BackupLegalHoldView>;
  releaseLegalHold(principal: SessionPrincipal, input: { holdPublicId: string; releaseReasonCode: string }): Promise<void>;
  openEncryptedArchiveDownload(principal: SessionPrincipal, backupPublicId: string): Promise<{ filename: string; size: number; stream: import("node:stream").Readable }>;
}
```

## 3. Cross-Module Reads, TLS Enforcement & Snapshot Boundary

- **Mandatory TLS Enforcement (`server/db/connectionOptions.ts`)**: Every MySQL driver connection, connection pool, `mysqldump`, and `mysql` child process in `mysqlCli.ts`, `continuity.ts`, `offlineRestore.ts`, `index.ts`, and `scripts/ops/**` validates its URL exclusively via `connectionOptionsFromUrl(url)`. Child processes use `--defaults-file=<0600-temp-file> --no-login-paths` (never `--defaults-extra-file`), `protocol=TCP`, `local-infile=0`, and isolated empty `HOME`/`MYSQL_HOME`, translating `?tls=required` + `&tlsCaFile=...` into `ssl-mode=VERIFY_IDENTITY`, `tls-version=TLSv1.2,TLSv1.3`, and `ssl-ca=<path>` (or `ssl-mode=DISABLED` only when `?tls=off`).
- **Consistent Database Snapshot Boundary**: `mysqldump` runs with `--single-transaction --quick --skip-triggers --skip-events --skip-routines --hex-blob --set-gtid-purged=OFF --no-tablespaces`. Table names, exact per-table row counts, and `__drizzle_migrations` count/hash are parsed directly from `mysqldump`'s own stdout byte stream (`StreamingDumpInspector`), guaranteeing zero skew between `manifest.databaseDump` and `sql/database.sql.gz` even under heavy concurrent writes.
- **Object Inventory Boundary**: Immediately after `mysqldump` starts its snapshot, private object references (`order_files WHERE purged_at IS NULL` and `platform_presentation_images WHERE deleted_at IS NULL`) are read inside a single `REPEATABLE READ` `START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY` transaction, and each immutable content-addressed file on disk is pre-verified (`size` + `sha256`) before sealing the archive. Because MySQL 8.4 cannot export an InnoDB snapshot descriptor into a spawned `mysqldump` process without `FLUSH TABLES WITH READ LOCK` (which would stall live portal writes), an upload committed in the narrow millisecond window between `mysqldump`'s `START TRANSACTION` and the read-only inventory `START TRANSACTION` may appear as an extra content-addressed object in `objects/*`; `continuity.ts` verifies every row referenced by the restored SQL dump exists in `isolatedStorage` with matching SHA-256 and refuses if any referenced object is missing or corrupted.

## 4. tRPC Procedures (`trpc.backup.admin.*`) **[impl]**

Router mounted at `trpc.backup` (`server/modules/backup/router.ts`). **There is NO `restoreIsolated` mutation on this router.**

| Procedure | Type | Capability | Step-up | Exact Input | Exact Output |
| --- | --- | --- | --- | --- | --- |
| `backup.admin.list` | `query` | `backup.read` | No | `{ cursor?: string; limit?: number /* 1..100 */; state?: OperationState } \| undefined` | `{ items: BackupArchiveSummary[]; nextCursor: string \| null; keyConfigured: boolean; keyCustodyWarning: string \| null; offHostStatusNote: string }` |
| `backup.admin.detail` | `query` | `backup.read` | No | `{ backupPublicId: string }` | `{ archive: BackupArchiveSummary; verifications: BackupVerificationSummary[]; restores: RestoreDrillSummary[]; holds: BackupLegalHoldView[] }` |
| `backup.admin.runNow` | `mutation` | `backup.run` | **Yes** (`STEP_UP_REQUIRED` if missing/stale) | `{ trigger?: "manual" \| "pre_upgrade" } \| undefined` | `{ backupPublicId: string; jobId: string }` |
| `backup.admin.verify` | `mutation` | `backup.verify` | **Yes** | `{ backupPublicId: string }` | `BackupVerificationSummary` |
| `backup.admin.retentionPolicy` | `query` | `backup.read` | No | `void` | `{ keepLastCount: number; maxAgeDays: number; scheduleEnabled: boolean; autoPruneEnabled: boolean; recoverySandboxRoot: string }` |
| `backup.admin.updateRetentionPolicy` | `mutation` | `backup.retention.manage` | **Yes** | `{ keepLastCount: number /* 1..365 */; maxAgeDays: number /* 1..3650 */; scheduleEnabled: boolean; autoPruneEnabled?: boolean }` | `{ ok: true }` |
| `backup.admin.previewRetention` | `query` | `backup.read` | No | `void` | `{ items: RetentionPlanItem[] }` |
| `backup.admin.runRetention` | `mutation` | `backup.retention.manage` | **Yes** (`!dryRun`) | `{ dryRun: boolean }` | `{ prunedCount: number; items: RetentionPlanItem[] }` |
| `backup.admin.createHold` | `mutation` | `backup.retention.manage` | **Yes** | `{ backupPublicId: string; reasonCode: string; note: string /* 3..500 chars */ }` | `BackupLegalHoldView` |
| `backup.admin.releaseHold` | `mutation` | `backup.retention.manage` | **Yes** | `{ holdPublicId: string; releaseReasonCode: string }` | `{ ok: true }` |

## 5. Raw HTTP Routes & Operator CLI Restore

| Surface | Path / Command | Guard | Notes |
| --- | --- | --- | --- |
| Raw HTTP GET | `GET /api/backup/archives/:publicId/download` | `admin` + `backup.restore` + fresh step-up | Streams the **encrypted** `.rpbk` archive via `sendPrivateDownload` for off-host custody and CLI recovery drills. Durably audited (`backup.archive.downloaded`). |
| Operator CLI | `pnpm tsx scripts/ops/restore/restore-isolated.ts --archive-file <path.rpbk> --target-db rp_restore_<YYYYMMDD> --target-storage /var/lib/readypackets-recovery/restore-<YYYYMMDD> --confirm "RESTORE <BACKUP_PUBLIC_ID> TO rp_restore_<YYYYMMDD>"` | `RP_RECOVERY_DATABASE_URL_FILE` + `RP_BACKUP_KEY_FILE` + `RP_AUDIT_CHAIN_KEY_FILE` | Sole restore mechanism. Works 100% offline from `.rpbk` file; pass `--record-drill` when live DB is online to also append a `RestoreDrillSummary` to `backup.admin.detail.restores`. |

## 6. Jobs, Schedules & Crash-Safe Fenced State Transitions

- `backup.create`, `backup.verify`, and `backup.retention.prune` pass `(tx) => job.assertStillOwned(tx)` into **every** state-transition transaction (`running`, `completed`, `failed`, `verify`, `retention`), propagate `job.signal` to abort `mysqldump` immediately on lease loss/shutdown, allocate unique per-attempt storage keys, and separate post-commit summary reads from archive publication so a post-commit error can never unlink a committed archive.
- Startup reconciliation (`start()`) marks orphaned `running` archives older than 15 minutes as `state = "unknown"` (`INTERRUPTED_DURING_RESTART`) with durable `backup.archive.unknown` audit events.

## 7. Audit Events (`category: "backup"`)

- `backup.archive.requested`, `backup.archive.completed`, `backup.archive.failed`, `backup.archive.refused`, `backup.archive.unknown`, `backup.archive.downloaded`
- `backup.verify.completed` (`attributes.verification_scope`: `"byte_and_manifest"` | `"scratch_restore_verified"`), `backup.verify.failed`
- `backup.restore.requested`, `backup.restore.completed`, `backup.restore.failed`, `backup.restore.refused`, `backup.restore.continuity_marker`
- `backup.retention.policy_changed`, `backup.retention.intent`, `backup.retention.executed`
- `backup.legal_hold.created`, `backup.legal_hold.released`
