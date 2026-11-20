# Backup & Disaster Recovery Module — API (v1)

Owner: `recovery_ops_engineer`. Paths: `server/modules/backup/**`, `client/src/features/backup/**`, `deploy/**`, `.github/**`, `scripts/ops/{backup,restore,install}/**`, `docs/runbooks/**`.

Status markers: **[sig]** signature published, implementation in progress; **[impl]** implemented + tested.

## 1. Three Distinct Operations (Architecture §7.1)

Backup, cryptographic/semantic verification, and isolated disaster-recovery restore are separate operations with distinct capabilities and confirmation gates:

| Operation | Capability | Step-up required | Scope & Guardrails |
| --- | --- | --- | --- |
| Read inventory / status | `backup.read` | No | Admin only (`adminProcedure`). Lists encrypted archives, verification ledger, restore drill reports, retention policy, legal holds, and off-host copy posture. |
| Create encrypted backup | `backup.run` | **Yes** | Admin + fresh step-up. **Encrypted by default** (`RPBK0001` AES-256-GCM chunked envelope). **Refuses (fails closed)** if no backup encryption key is configured — there is no plaintext mode. |
| Verify archive | `backup.verify` | No | Admin. Re-reads and authenticates every encrypted chunk (GCM tag, sequence, finality, no trailing bytes), decompresses and hashes the SQL dump, checks every object digest/size, and validates `manifest.json` + required key IDs. |
| Restore to isolated target | `backup.restore` | **Yes** | Admin + fresh step-up + exact typed confirmation (`RESTORE <backupPublicId> TO <targetDatabaseName>`). Restores **only** to an isolated empty `targetDatabaseName` and isolated empty `targetStorageDir` — **refuses** live database/storage, overlapping paths, or populated targets. Runs §7.3 security-state continuity reconciliation and post-restore integrity checks. |
| Retention & legal holds | `backup.retention.manage` | **Yes** | Admin + fresh step-up. Manages retention policy, dry-run/apply pruning, and legal holds. Never deletes a held archive or the last-known-good verified archive. |

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
    restores: RestoreDrillSummary[];
    holds: BackupLegalHoldView[];
  }>;
  enqueueBackup(principal: SessionPrincipal, input?: { trigger?: "manual" | "pre_upgrade" }): Promise<{ backupPublicId: string; jobId: string }>;
  runBackupDirect(options?: { trigger?: "manual" | "scheduled" | "pre_upgrade" | "cli"; actorUserId?: number | null; correlationId?: string }): Promise<BackupArchiveSummary>;
  verifyBackup(principal: SessionPrincipal, backupPublicId: string): Promise<BackupVerificationSummary>;
  verifyBackupDirect(backupPublicId: string, options?: { actorUserId?: number | null; correlationId?: string }): Promise<BackupVerificationSummary>;
  restoreToIsolatedTarget(principal: SessionPrincipal, input: {
    backupPublicId: string;
    targetDatabaseName: string;
    targetStoragePath?: string; // relative leaf under configured isolated recovery root, or validated isolated dir in CLI/tests
    continuityMode?: "preserve_continuity" | "quarantine_credentials";
    confirmationText: string;
  }): Promise<RestoreDrillSummary>;
  getRetentionPolicy(principal: SessionPrincipal): Promise<{
    keepLastCount: number;
    maxAgeDays: number;
    scheduleEnabled: boolean;
  }>;
  updateRetentionPolicy(principal: SessionPrincipal, input: {
    keepLastCount: number;
    maxAgeDays: number;
    scheduleEnabled: boolean;
  }): Promise<void>;
  previewRetention(principal: SessionPrincipal): Promise<{ items: RetentionPlanItem[] }>;
  runRetention(principal: SessionPrincipal, input: { dryRun: boolean }): Promise<{ prunedCount: number; items: RetentionPlanItem[] }>;
  createLegalHold(principal: SessionPrincipal, input: { backupPublicId: string; reasonCode: string; note: string }): Promise<BackupLegalHoldView>;
  releaseLegalHold(principal: SessionPrincipal, input: { holdPublicId: string; releaseReasonCode: string }): Promise<void>;
  openEncryptedArchiveDownload(principal: SessionPrincipal, backupPublicId: string): Promise<{ filename: string; size: number; stream: import("node:stream").Readable }>;
}
```

## 3. Cross-Module Reads & Dependencies

Per `BUILD_CONTRACT.md` §5.1, backup collectors read:
- Database logical snapshot via `mysqldump --defaults-extra-file=<0600-temp-file> --single-transaction --quick --routines --triggers --events --hex-blob --set-gtid-purged=OFF --no-tablespaces` (`execFile`/`spawn` with argument array; never shell, never password in `argv`).
- Schema journal `__drizzle_migrations` and `information_schema.tables` for row-count verification.
- Private object inventory from `order_files` (`purged_at IS NULL`, including soft-deleted and superseded versions; coordinated with `files_engineer`'s `backupFiles` / `order_files`) and `platform_presentation_images` (`deleted_at IS NULL`), streamed via `deps.storage.get(storageKey)`.
- During isolated restore: connects only to the newly created isolated `targetDatabaseName` and isolated `targetStorageDir` to run §7.3 security-state continuity updates (`user_sessions`, `identity_tokens`, `assurance_accounts`, `assurance_recovery_codes`, `assurance_passkeys`, `assurance_challenges`, `file_download_tickets`, `http_rate_limit_counters`, `job_runs`, `mail_outbox`, `platform_settings`, `audit_events`/`audit_chain`). Never writes to live tables except its own `backup_*` and `deps.audit.record`.

## 4. tRPC Procedures (`trpc.backup.*`)

All procedures live under `backupRouter.admin.*` and require `adminProcedure` + capability:

| Procedure | Capability | Step-up | Notes |
| --- | --- | --- | --- |
| `admin.list` (query) | `backup.read` | No | Paginated archives + key/off-host posture |
| `admin.detail` (query) | `backup.read` | No | Archive detail + verifications + drills + holds |
| `admin.runNow` (mutation) | `backup.run` | **Yes** | Enqueues fenced job `backup.create` (refuses immediately if key missing or draining) |
| `admin.verify` (mutation) | `backup.verify` | No | Runs full byte-level AEAD + manifest verification |
| `admin.restoreIsolated` (mutation) | `backup.restore` | **Yes** | Isolated-target restore + continuity + integrity report |
| `admin.retentionPolicy` (query) | `backup.read` | No | Current retention & schedule config |
| `admin.updateRetentionPolicy` (mutation) | `backup.retention.manage` | **Yes** | Updates `keepLastCount`, `maxAgeDays`, `scheduleEnabled` |
| `admin.previewRetention` (query) | `backup.read` | No | Dry-run retention plan |
| `admin.runRetention` (mutation) | `backup.retention.manage` | **Yes** | Executes retention (`dryRun: boolean`) |
| `admin.createHold` (mutation) | `backup.retention.manage` | **Yes** | Places legal hold on archive |
| `admin.releaseHold` (mutation) | `backup.retention.manage` | **Yes** | Releases legal hold |

## 5. Raw HTTP Routes (`/api/backup/*`)

| Route | Guard | Notes |
| --- | --- | --- |
| `GET /api/backup/archives/:publicId/download` | `admin` + `backup.restore` + fresh step-up | Streams the **encrypted** `.rpbk` archive via `sendPrivateDownload` for off-host/offline custody. Durably audited (`backup.archive.downloaded`). Refuses unverified or failed archives unless `allowUnverified=false` (verified or completed encrypted archives only). |

## 6. Jobs & Schedules

- `backup.create` (fenced job; schedule `backup.scheduled.daily` every 24 h — skips cleanly when `backup.schedule.enabled` flag is false, default OFF so no timer runs unexpectedly before configuration).
- `backup.verify` (fenced job; schedule `backup.scheduled.verify` every 24 h — re-verifies latest completed archive when scheduled backups are enabled).
- `backup.retention.prune` (fenced job; schedule `backup.scheduled.retention` every 24 h — dry-run only unless `backup.retention.auto_prune` is explicitly enabled).

## 7. Settings, Secrets & Feature Flags (`group: "backup"`)

- `backup.retention.keep_count` (int, 1..365, default `14`, internal)
- `backup.retention.max_age_days` (int, 1..3650, default `90`, internal)
- `backup.recovery.sandbox_root` (string, 1..255, default `"/var/lib/readypackets-recovery"`, internal)
- `backup.encryption.key` (secret, optional fallback if host `RP_BACKUP_KEY_FILE` / `RP_BACKUP_KEY` is not set; emits key-custody warning if used without off-host copy)
- Feature flags (all default OFF): `backup.schedule.enabled`, `backup.retention.auto_prune`, `backup.offhost.enabled` (stubbed off-host target — visibly reported as not configured in this release).

Host environment variables (documented for `server/config/env.example`):
- `RP_BACKUP_KEY_FILE` (preferred: 0600 file containing keyring JSON or key spec) / `RP_BACKUP_KEY` / `RP_BACKUP_KEY_ID`
- `RP_RECOVERY_SANDBOX_DIR` (optional host path for isolated restore drills)

## 8. Audit Events (`category: "backup"`)

- `backup.archive.requested`, `backup.archive.completed`, `backup.archive.failed`, `backup.archive.refused`, `backup.archive.unknown`, `backup.archive.downloaded`
- `backup.verify.completed`, `backup.verify.failed`
- `backup.restore.requested`, `backup.restore.completed`, `backup.restore.failed`, `backup.restore.refused`, `backup.restore.continuity_marker`
- `backup.retention.policy_changed`, `backup.retention.executed`
- `backup.legal_hold.created`, `backup.legal_hold.released`

## 9. Health Components (`ModuleLifecycle.health()`)

- `backup.status`:
  - `not_configured` when no backup encryption key is configured (satisfies `platform` setup checklist).
  - `degraded` when key is configured in database-only custody without off-host copy, or when no verified backup exists yet, or latest backup > 26 h old when schedule is enabled.
  - `failing` when the latest backup or latest verification failed or has an unresolved `unknown` outcome.
  - `ok` when backup encryption key is configured and a recent verified backup exists with no unresolved failures.
  - Safe metrics: `lastSuccessAgeSeconds`, `lastVerifiedAgeSeconds`, `verifiedCount`, `failedCount`, `unknownCount`, `activeHolds`.
- `backup.offhost`:
  - `not_configured` with summary `"Local storage only: off-host independent copy is not configured."`
