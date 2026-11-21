/**
 * Backup & disaster-recovery module — public service surface and factory.
 * Owner: recovery_ops_engineer.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { OperationState } from "../../../shared/domain.js";
import { readSecretEnv } from "../../config/env.js";
import type { ModuleDeps } from "../../container.js";
import { conflict, CryptoError, DomainError, notFound, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { getRequestContext } from "../../core/requestContext.js";
import type { ClaimedJob, JobResult, ModuleHealth, ModuleLifecycle, SessionPrincipal, Tx } from "../../core/types.js";
import { createObjectStorage } from "../files/storage.js";
import { users } from "../identity/schema.js";
import { isFlagEnabled, readSetting, writeSetting } from "../platform/index.js";
import { assertBackupActorInTx, assertBackupPrincipalPrecheck } from "./actorGuard.js";
import { createBackupBundleStream, readAndValidateBackupBundle, sealManifest, type BundleObjectSource } from "./bundle.js";
import { reconcileAndVerifyIsolatedRestore } from "./continuity.js";
import { decryptBackupStream, encryptBackupStream } from "./crypto.js";
import { requireBackupKeyring, resolveBackupKeyring, type BackupKeySourceOptions } from "./keys.js";
import {
  loadSqlGzIntoIsolatedDatabase,
  openMysqldumpGzStream,
  openValidatedMysqlConnection,
  parseValidatedMysqlTarget,
  prepareIsolatedTargetDatabase,
  type DatabaseSnapshotMetadata,
} from "./mysqlCli.js";
import {
  executeIsolatedCliRestore,
  reserveIsolatedStorageDirectory,
  type IsolatedRestoreExecutionResult,
} from "./offlineRestore.js";
import { buildRetentionPlan, type RetentionKeepReason } from "./retention.js";
import {
  backupArchives,
  backupLegalHolds,
  backupRestoreDrills,
  backupVerifications,
  type BackupArchiveRow,
  type BackupKeyCustodyMode,
  type BackupTrigger,
  type BackupVerificationRow,
  type BackupVerificationStatus,
  type ContinuityMode,
  type KeyReadinessState,
  type OffHostCopyStatus,
  type StoredContinuityReport,
  type StoredIntegrityReport,
} from "./schema.js";
import {
  BACKUP_OFFHOST_ENABLED,
  BACKUP_RECOVERY_SANDBOX_ROOT,
  BACKUP_RETENTION_AUTO_PRUNE,
  BACKUP_RETENTION_KEEP_COUNT,
  BACKUP_RETENTION_MAX_AGE_DAYS,
  BACKUP_SCHEDULE_ENABLED,
} from "./settings.js";
import {
  BACKUP_JOB_REMOTE_COPY,
  BACKUP_JOB_REMOTE_SWEEP,
  compute321Status,
  copyBackupOffsiteNow,
  executeRemoteCopyJob,
  executeRemoteCopySweepJob,
  getOffsiteBackupConfig,
  loadRemoteCopiesByBackupIds,
  maybeStageAutomaticOffsiteCopies,
  mayRetryBackupOffsiteCopy,
  registerBackupAutomationTriggers,
  updateOffsiteBackupConfig,
  type Backup321Status,
  type BackupRemoteCopySummary,
  type OffsiteBackupConfigView,
  type OffsiteDestinationOption,
  type RemoteCopyJobPayload,
  type UpdateOffsiteBackupConfigInput,
} from "./offsite.js";

export {
  BACKUP_JOB_REMOTE_COPY,
  BACKUP_JOB_REMOTE_SWEEP,
  type Backup321Status,
  type BackupRemoteCopySummary,
  type OffsiteBackupConfigView,
  type OffsiteDestinationOption,
  type UpdateOffsiteBackupConfigInput,
};

export const BACKUP_JOB_CREATE = "backup.create";
export const BACKUP_JOB_VERIFY = "backup.verify";
export const BACKUP_JOB_RETENTION = "backup.retention.prune";

const LOCAL_ONLY_NOTICE =
  "Local storage only: not an independent off-host copy. Download encrypted archives and store backup keys separately off-host.";
const DB_SECRET_CUSTODY_WARNING =
  "Backup encryption key is stored only in platform settings; store an independent off-host key file (RP_BACKUP_KEY_FILE) so archives remain recoverable if the database is lost.";

export interface BackupArchiveSummary {
  publicId: string;
  state: OperationState;
  reasonCode: string | null;
  trigger: BackupTrigger;
  encryptedSizeBytes: number | null;
  archiveSha256: string | null;
  backupKeyId: string | null;
  keyCustodyMode: BackupKeyCustodyMode | null;
  releaseRef: string;
  schemaMigrationCount: number | null;
  lastMigrationHash: string | null;
  objectCount: number | null;
  objectTotalBytes: number | null;
  verificationStatus: BackupVerificationStatus;
  lastVerifiedAt: Date | null;
  offHostCopyStatus: OffHostCopyStatus;
  remoteCopies: readonly BackupRemoteCopySummary[];
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
  keyReadiness: KeyReadinessState;
  missingDataKeyIds: readonly string[];
  durationMs: number | null;
  createdAt: Date;
  completedAt: Date | null;
}

export type RestoreContinuityReport = StoredContinuityReport;
export type RestoreIntegrityReport = StoredIntegrityReport;

export interface RestoreDrillSummary {
  publicId: string;
  backupPublicId: string;
  state: OperationState;
  reasonCode: string | null;
  targetDatabaseName: string;
  continuityMode: ContinuityMode;
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
  keepReason: RetentionKeepReason | null;
}

export { executeIsolatedCliRestore, reserveIsolatedStorageDirectory, type IsolatedRestoreExecutionResult };

export interface BackupModuleOptions extends BackupKeySourceOptions {
  /** Override database URL for mysqldump/mysql in isolated test harnesses where config.databaseUrl is synthetic. */
  databaseUrlOverride?: string;
  /** Optional dedicated scratch/recovery MySQL URL (`RP_RECOVERY_DATABASE_URL`) for isolated scratch verification & CLI drills. */
  recoveryDatabaseUrlOverride?: string;
}

export interface BackupModule extends ModuleLifecycle {
  listBackups(
    principal: SessionPrincipal,
    input?: { cursor?: string; limit?: number; state?: OperationState },
  ): Promise<{
    items: BackupArchiveSummary[];
    nextCursor: string | null;
    keyConfigured: boolean;
    keyCustodyWarning: string | null;
    offHostStatusNote: string;
  }>;
  getBackup(
    principal: SessionPrincipal,
    backupPublicId: string,
  ): Promise<{
    archive: BackupArchiveSummary;
    verifications: BackupVerificationSummary[];
    restores: RestoreDrillSummary[];
    holds: BackupLegalHoldView[];
    remoteCopies: readonly BackupRemoteCopySummary[];
  }>;
  enqueueBackup(
    principal: SessionPrincipal,
    input?: { trigger?: "manual" | "pre_upgrade" },
  ): Promise<{ backupPublicId: string; jobId: string }>;
  runBackupDirect(options?: {
    trigger?: BackupTrigger;
    actorUserId?: number | null;
    correlationId?: string;
    backupPublicId?: string;
    assertFence?: (tx?: Tx) => Promise<void>;
    abortSignal?: AbortSignal;
  }): Promise<BackupArchiveSummary>;
  verifyBackup(principal: SessionPrincipal, backupPublicId: string): Promise<BackupVerificationSummary>;
  verifyBackupDirect(
    backupPublicId: string,
    options?: {
      actorUserId?: number | null;
      correlationId?: string;
      assertFence?: (tx?: Tx) => Promise<void>;
    },
  ): Promise<BackupVerificationSummary>;
  /**
   * Operator CLI / test-only isolated restore entry point (NEVER exposed on web/tRPC).
   * Requires dedicated recovery credentials (`recoveryDatabaseUrl` or `RP_RECOVERY_DATABASE_URL(_FILE)`) unless
   * `allowSameUserInTestOnly` is explicitly set in unit tests.
   */
  restoreToIsolatedTargetDirect(input: {
    backupPublicId: string;
    targetDatabaseName: string;
    targetStorageDir: string;
    recoveryDatabaseUrl?: string;
    archiveFilePath?: string;
    continuityMode?: ContinuityMode;
    confirmationText: string;
    actorUserId?: number | null;
    correlationId?: string;
    allowSameUserInTestOnly?: boolean;
  }): Promise<RestoreDrillSummary>;
  getRetentionPolicy(principal: SessionPrincipal): Promise<{
    keepLastCount: number;
    maxAgeDays: number;
    scheduleEnabled: boolean;
    autoPruneEnabled: boolean;
    recoverySandboxRoot: string;
  }>;
  updateRetentionPolicy(
    principal: SessionPrincipal,
    input: {
      keepLastCount: number;
      maxAgeDays: number;
      scheduleEnabled: boolean;
      autoPruneEnabled?: boolean;
    },
  ): Promise<void>;
  previewRetention(principal: SessionPrincipal): Promise<{ items: RetentionPlanItem[] }>;
  runRetention(
    principal: SessionPrincipal,
    input: { dryRun: boolean },
  ): Promise<{ prunedCount: number; items: RetentionPlanItem[] }>;
  createLegalHold(
    principal: SessionPrincipal,
    input: { backupPublicId: string; reasonCode: string; note: string },
  ): Promise<BackupLegalHoldView>;
  releaseLegalHold(
    principal: SessionPrincipal,
    input: { holdPublicId: string; releaseReasonCode: string },
  ): Promise<void>;
  openEncryptedArchiveDownload(
    principal: SessionPrincipal,
    backupPublicId: string,
  ): Promise<{ filename: string; size: number; stream: Readable }>;
  getOffsiteConfig(principal: SessionPrincipal): Promise<OffsiteBackupConfigView>;
  updateOffsiteConfig(
    principal: SessionPrincipal,
    input: UpdateOffsiteBackupConfigInput,
  ): Promise<OffsiteBackupConfigView>;
  copyOffsiteNow(
    principal: SessionPrincipal,
    input: { backupPublicId: string; connectionPublicId?: string; expectedFailedJobId?: string },
  ): Promise<{ queued: BackupRemoteCopySummary[] }>;
  mayRetryOffsiteCopy(
    input: { backupPublicId: string; connectionPublicId: string; jobPublicId: string },
    tx: Tx,
  ): Promise<boolean>;
}

interface FilesBackupCollectorLike {
  backupFiles(
    tx: Tx,
    input: { after?: string; limit: number },
  ): Promise<{ items: { publicId: string; storageKey: string; size: number; sha256: string }[]; nextCursor: string | null }>;
}

function isJobLeaseLostError(error: unknown): boolean {
  return error instanceof DomainError && error.reasonCode === "JOB_LEASE_LOST";
}

function encodeCursor(createdAt: Date, id: number): string {
  return Buffer.from(`${String(createdAt.getTime())}:${String(id)}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: Date; id: number } {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const [tsStr, idStr] = raw.split(":");
    const ts = Number(tsStr);
    const id = Number(idStr);
    if (!Number.isSafeInteger(ts) || !Number.isSafeInteger(id) || id <= 0) {
      throw new Error("bad cursor");
    }
    return { createdAt: new Date(ts), id };
  } catch {
    throw validation("INVALID_CURSOR", "Pagination cursor is invalid.");
  }
}

export function expectedRestoreConfirmationText(backupPublicId: string, targetDatabaseName: string): string {
  return `RESTORE ${backupPublicId} TO ${targetDatabaseName}`;
}

export function createBackupModule(deps: ModuleDeps, options: BackupModuleOptions = {}): BackupModule {
  const effectiveDatabaseUrl = () => options.databaseUrlOverride ?? deps.config.databaseUrl;

  async function isMaintenanceDraining(): Promise<boolean> {
    const jobAdmin = deps.services.jobAdmin as unknown as { isDraining?: () => Promise<boolean> } | undefined;
    if (jobAdmin && typeof jobAdmin.isDraining === "function") {
      return jobAdmin.isDraining();
    }
    return false;
  }

  async function countActiveHoldsByBackupIds(backupIds: readonly number[], tx?: Tx): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    if (backupIds.length === 0) return map;
    const handle = tx ?? deps.db;
    const rows = await handle
      .select({
        backupId: backupLegalHolds.backupId,
        cnt: sql<number>`COUNT(*)`,
      })
      .from(backupLegalHolds)
      .where(and(inArray(backupLegalHolds.backupId, [...backupIds]), isNull(backupLegalHolds.releasedAt)))
      .groupBy(backupLegalHolds.backupId);
    for (const r of rows) {
      map.set(r.backupId, Number(r.cnt));
    }
    return map;
  }

  async function computeLastKnownGoodId(tx?: Tx): Promise<string | null> {
    const handle = tx ?? deps.db;
    const [row] = await handle
      .select({ publicId: backupArchives.publicId })
      .from(backupArchives)
      .where(
        and(
          isNull(backupArchives.purgedAt),
          eq(backupArchives.state, "completed"),
          eq(backupArchives.verificationStatus, "verified"),
        ),
      )
      .orderBy(desc(backupArchives.createdAt), desc(backupArchives.id))
      .limit(1);
    return row?.publicId ?? null;
  }

  function toArchiveSummary(
    row: BackupArchiveRow,
    activeHoldCount: number,
    lastKnownGoodPublicId: string | null,
    remoteCopies: readonly BackupRemoteCopySummary[] = [],
  ): BackupArchiveSummary {
    return {
      publicId: row.publicId,
      state: row.state,
      reasonCode: row.reasonCode,
      trigger: row.trigger,
      encryptedSizeBytes: row.encryptedSizeBytes,
      archiveSha256: row.archiveSha256,
      backupKeyId: row.backupKeyId,
      keyCustodyMode: row.keyCustodyMode,
      releaseRef: row.releaseRef,
      schemaMigrationCount: row.schemaMigrationCount,
      lastMigrationHash: row.lastMigrationHash,
      objectCount: row.objectCount,
      objectTotalBytes: row.objectTotalBytes,
      verificationStatus: row.verificationStatus,
      lastVerifiedAt: row.lastVerifiedAt,
      offHostCopyStatus: row.offHostCopyStatus,
      remoteCopies,
      activeHoldCount,
      isLastKnownGood: row.purgedAt === null && row.publicId === lastKnownGoodPublicId,
      purgedAt: row.purgedAt,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
    };
  }

  function toVerificationSummary(row: BackupVerificationRow, backupPublicId: string): BackupVerificationSummary {
    return {
      publicId: row.publicId,
      backupPublicId,
      state: row.state,
      reasonCode: row.reasonCode,
      authenticatedBytes: row.authenticatedBytes,
      chunksVerified: row.chunksVerified,
      sqlSha256Matched: row.sqlSha256Matched,
      objectsVerified: row.objectsVerified,
      manifestValid: row.manifestValid,
      keyReadiness: row.keyReadiness,
      missingDataKeyIds: row.missingDataKeyIdsJson ?? [],
      durationMs: row.durationMs,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
    };
  }

  /**
   * Captures private storage object inventory and active writer job count inside ONE `REPEATABLE READ`
   * `START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY` MySQL connection immediately after `mysqldump`
   * has started its own consistent snapshot, minimizing DB/object-inventory skew while pre-verifying every
   * referenced object's SHA-256 and byte size on disk before sealing the bundle.
   */
  async function captureConsistentObjectInventoryAndWriters(): Promise<{
    objects: BundleObjectSource[];
    activeWriters: number;
  }> {
    const collected = new Map<string, BundleObjectSource>();
    let activeWriters = 0;

    const target = parseValidatedMysqlTarget(effectiveDatabaseUrl());
    const conn = await openValidatedMysqlConnection(effectiveDatabaseUrl());
    try {
      await conn.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await conn.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
      try {
        const [tblRows] = await conn.query(
          "SELECT TABLE_NAME AS tableName FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE'",
          [target.database],
        );
        const existingTables = new Set(
          (tblRows as { tableName: string }[]).map((r) => String(r.tableName)),
        );

        if (existingTables.has("job_runs")) {
          const [wRows] = await conn.query(
            "SELECT COUNT(*) AS cnt FROM `job_runs` WHERE `state` = 'running' AND `type` <> ?",
            [BACKUP_JOB_CREATE],
          );
          activeWriters = Number(((wRows as { cnt: number | bigint }[])[0])?.cnt ?? 0);
        }

        if (existingTables.has("order_files")) {
          const [fRows] = await conn.query(
            "SELECT `public_id` AS publicId, `storage_key` AS storageKey, `byte_size` AS byteSize, `sha256` FROM `order_files` WHERE `purged_at` IS NULL ORDER BY `id` ASC",
          );
          for (const r of fRows as { publicId: string; storageKey: string; byteSize: number; sha256: string }[]) {
            if (!collected.has(r.storageKey)) {
              collected.set(r.storageKey, {
                storageKey: r.storageKey,
                expectedSize: Number(r.byteSize),
                expectedSha256: String(r.sha256),
                sourceTable: "order_files",
                recordPublicId: String(r.publicId),
                open: () => deps.storage.get(r.storageKey),
              });
            }
          }
        }

        if (existingTables.has("platform_presentation_images")) {
          const [imgRows] = await conn.query(
            "SELECT `public_id` AS publicId, `storage_key` AS storageKey, `byte_size` AS byteSize, `sha256` FROM `platform_presentation_images` WHERE `deleted_at` IS NULL ORDER BY `id` ASC",
          );
          for (const img of imgRows as { publicId: string; storageKey: string; byteSize: number; sha256: string }[]) {
            if (!collected.has(img.storageKey)) {
              collected.set(img.storageKey, {
                storageKey: img.storageKey,
                expectedSize: Number(img.byteSize),
                expectedSha256: String(img.sha256),
                sourceTable: "platform_presentation_images",
                recordPublicId: String(img.publicId),
                open: () => deps.storage.get(img.storageKey),
              });
            }
          }
        }
      } finally {
        await conn.query("COMMIT").catch(() => {});
      }
    } finally {
      await conn.end().catch(() => {});
    }

    // Also include any custom files collector registered in unit harnesses
    const filesMod = deps.services.files as unknown as Partial<FilesBackupCollectorLike> | undefined;
    if (filesMod && typeof filesMod.backupFiles === "function") {
      let cursor: string | undefined;
      while (true) {
        const page = await deps.db.transaction((tx) =>
          filesMod.backupFiles!(tx, { ...(cursor ? { after: cursor } : {}), limit: 250 }),
        );
        for (const item of page.items) {
          if (!collected.has(item.storageKey)) {
            collected.set(item.storageKey, {
              storageKey: item.storageKey,
              expectedSize: item.size,
              expectedSha256: item.sha256,
              sourceTable: "order_files",
              recordPublicId: item.publicId,
              open: () => deps.storage.get(item.storageKey),
            });
          }
        }
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
    }

    // Pre-verify every referenced object exists and matches its recorded digest before sealing archive stream
    for (const item of collected.values()) {
      const stat = await deps.storage.stat(item.storageKey);
      if (!stat) {
        throw new DomainError(
          "UNAVAILABLE",
          "MISSING_STORAGE_OBJECT",
          "A private storage object referenced by the database is missing on disk; backup refused to prevent silent partial evidence.",
        );
      }
      if (stat.size !== item.expectedSize || stat.sha256 !== item.expectedSha256) {
        throw new DomainError(
          "UNAVAILABLE",
          "CORRUPTED_STORAGE_OBJECT",
          "A private storage object digest did not match its database record; backup refused.",
        );
      }
    }

    return {
      objects: [...collected.values()].sort((a, b) => a.storageKey.localeCompare(b.storageKey)),
      activeWriters,
    };
  }

  async function runBackupDirect(
    runOpts: {
      trigger?: BackupTrigger;
      actorUserId?: number | null;
      correlationId?: string;
      backupPublicId?: string;
      assertFence?: (tx?: Tx) => Promise<void>;
      abortSignal?: AbortSignal;
    } = {},
  ): Promise<BackupArchiveSummary> {
    const now = deps.clock.now();
    const trigger = runOpts.trigger ?? "manual";
    const correlationId = runOpts.correlationId ?? getRequestContext()?.correlationId ?? ulid(now.getTime());
    const archivePublicId = runOpts.backupPublicId ?? ulid(now.getTime());

    // Fail closed BEFORE any plaintext dump if backup encryption key is missing or weak.
    let keyring;
    try {
      keyring = await requireBackupKeyring(deps.settings, options);
    } catch (error) {
      const reasonCode = error instanceof DomainError ? error.reasonCode : "BACKUP_KEY_INVALID";
      await deps.db.transaction(async (tx) => {
        await runOpts.assertFence?.(tx);
        const [existing] = await tx
          .select({ id: backupArchives.id })
          .from(backupArchives)
          .where(eq(backupArchives.publicId, archivePublicId))
          .limit(1)
          .for("update");
        if (existing) {
          await tx
            .update(backupArchives)
            .set({ state: "refused", reasonCode, completedAt: deps.clock.now(), updatedAt: deps.clock.now() })
            .where(eq(backupArchives.id, existing.id));
        } else {
          await tx.insert(backupArchives).values({
            publicId: archivePublicId,
            state: "refused",
            reasonCode,
            trigger,
            installationId: deps.config.installationId,
            releaseRef: deps.config.releaseRef,
            correlationId,
            requestedByUserId: runOpts.actorUserId ?? null,
            completedAt: deps.clock.now(),
            createdAt: now,
            updatedAt: now,
          });
        }
        await deps.audit.record(
          {
            category: "backup",
            eventName: "backup.archive.refused",
            action: "create",
            outcome: "refused",
            severity: "ERROR",
            reasonCode,
            actor: runOpts.actorUserId ? { userId: runOpts.actorUserId, role: "admin" } : { role: "system" },
            resource: { type: "backup_archive", publicId: archivePublicId },
            correlationId,
          },
          tx,
        );
      });
      throw error;
    }

    const activeKey = keyring.keys.get(keyring.currentKeyId)!;

    // Ensure `backup_archives` row exists in `running` state BEFORE snapshot, fenced inside tx!
    await deps.db.transaction(async (tx) => {
      await runOpts.assertFence?.(tx);
      const [existing] = await tx
        .select({ id: backupArchives.id })
        .from(backupArchives)
        .where(eq(backupArchives.publicId, archivePublicId))
        .limit(1)
        .for("update");
      if (existing) {
        await tx
          .update(backupArchives)
          .set({
            state: "running",
            backupKeyId: keyring.currentKeyId,
            keyCustodyMode: keyring.custodyMode,
            updatedAt: deps.clock.now(),
          })
          .where(eq(backupArchives.id, existing.id));
      } else {
        await tx.insert(backupArchives).values({
          publicId: archivePublicId,
          state: "running",
          trigger,
          backupKeyId: keyring.currentKeyId,
          keyCustodyMode: keyring.custodyMode,
          installationId: deps.config.installationId,
          releaseRef: deps.config.releaseRef,
          correlationId,
          requestedByUserId: runOpts.actorUserId ?? null,
          createdAt: now,
          updatedAt: now,
        });
      }
    });

    // Unique per-attempt storage key so concurrent or retried workers never overwrite one another's object!
    const storageKey = deps.storage.newKey("backups");
    let storageWritten = false;
    let publicationCommitted = false;

    try {
      await runOpts.assertFence?.();

      const dumpHandle = await openMysqldumpGzStream(
        effectiveDatabaseUrl(),
        () => deps.clock.now(),
        runOpts.abortSignal,
      );
      await dumpHandle.waitSnapshotStarted();

      const { objects, activeWriters } = await captureConsistentObjectInventoryAndWriters();

      let builtManifestSha256 = "";
      let dbDumpCompletedAt = dumpHandle.startedAt;
      let streamedSnapshot: DatabaseSnapshotMetadata = {
        tableNames: [],
        tableRowCounts: {},
        migrationCount: 0,
        lastMigrationHash: null,
        lastMigrationCreatedAt: null,
      };

      const bundleStream = createBackupBundleStream({
        now: () => deps.clock.now(),
        objects,
        openSqlGzStream: async () => ({
          gzStream: dumpHandle.gzStream,
          finalizeSqlStats: async () => {
            const finalized = await dumpHandle.finalize();
            dbDumpCompletedAt = finalized.completedAt;
            streamedSnapshot = finalized.snapshot;
            return {
              uncompressedBytes: finalized.uncompressedBytes,
              uncompressedSha256: finalized.uncompressedSha256,
              tableNames: finalized.snapshot.tableNames,
              tableRowCounts: finalized.snapshot.tableRowCounts,
            };
          },
        }),
        buildManifest: (facts) => {
          const manifest = sealManifest({
            manifestVersion: "rp.backup.manifest/1",
            backupPublicId: archivePublicId,
            installationId: deps.config.installationId,
            releaseRef: deps.config.releaseRef,
            createdAt: now.toISOString(),
            snapshotBoundary: {
              isolationMode: "mysqldump-single-transaction",
              dbDumpStartedAt: dumpHandle.startedAt.toISOString(),
              dbDumpCompletedAt: dbDumpCompletedAt.toISOString(),
              objectCaptureStartedAt: facts.objectCaptureStartedAt.toISOString(),
              objectCaptureCompletedAt: facts.objectCaptureCompletedAt.toISOString(),
              activeWriterJobsAtCapture: activeWriters,
            },
            schema: {
              migrationCount: streamedSnapshot.migrationCount,
              lastMigrationHash: streamedSnapshot.lastMigrationHash,
              lastMigrationCreatedAt: streamedSnapshot.lastMigrationCreatedAt,
            },
            requiredKeys: {
              backupKeyId: keyring.currentKeyId,
              dataKeyringCurrentId: deps.config.dataKeyring.current,
              dataKeyringAllIds: Object.keys(deps.config.dataKeyring.keys).sort(),
              purposeKeysRequired: [
                "RP_INDEX_KEY",
                "RP_PSEUDONYM_KEY",
                "RP_TOKEN_HASH_KEY",
                "RP_AUDIT_CHAIN_KEY",
              ],
            },
            databaseDump: {
              memberName: "sql/database.sql.gz",
              uncompressedBytes: facts.sql.uncompressedBytes,
              uncompressedSha256: facts.sql.uncompressedSha256,
              compressedBytes: facts.sql.compressedBytes,
              compressedSha256: facts.sql.compressedSha256,
              tableNames: facts.sql.tableNames,
              tableRowCounts: facts.sql.tableRowCounts,
            },
            objectInventory: {
              totalObjects: facts.objects.length,
              totalBytes: facts.objects.reduce((sum, item) => sum + item.size, 0),
              items: facts.objects,
            },
            offHostCopy: {
              configured: false,
              notice: "local_only_not_independent_copy",
            },
          });
          builtManifestSha256 = manifest.manifestContentSha256;
          return manifest;
        },
      });

      const encrypted = encryptBackupStream(bundleStream, {
        backupPublicId: archivePublicId,
        keyMaterial: activeKey,
      });

      const storedInfo = await deps.storage.put(storageKey, encrypted.stream);
      storageWritten = true;
      const encStats = encrypted.stats();
      if (storedInfo.size !== encStats.encryptedBytes || storedInfo.sha256 !== encStats.archiveSha256) {
        throw new DomainError("UNAVAILABLE", "STORAGE_WRITE_MISMATCH", "Encrypted backup archive digest mismatched after write.");
      }

      const completedAt = deps.clock.now();
      const objectTotalBytes = objects.reduce((acc, o) => acc + o.expectedSize, 0);

      // Atomic publication fenced by `assertFence(tx)` INSIDE the commit transaction!
      await deps.db.transaction(async (tx) => {
        await runOpts.assertFence?.(tx);
        await tx
          .update(backupArchives)
          .set({
            state: "completed",
            reasonCode: null,
            storageKey,
            encryptedSizeBytes: storedInfo.size,
            archiveSha256: storedInfo.sha256,
            manifestSha256: builtManifestSha256,
            schemaMigrationCount: streamedSnapshot.migrationCount,
            lastMigrationHash: streamedSnapshot.lastMigrationHash,
            objectCount: objects.length,
            objectTotalBytes,
            offHostCopyStatus: "local_only",
            completedAt,
            updatedAt: completedAt,
          })
          .where(eq(backupArchives.publicId, archivePublicId));

        await deps.audit.record(
          {
            category: "backup",
            eventName: "backup.archive.completed",
            action: "create",
            outcome: "completed",
            severity: "INFO",
            actor: runOpts.actorUserId ? { userId: runOpts.actorUserId, role: "admin" } : { role: "system" },
            resource: { type: "backup_archive", publicId: archivePublicId },
            correlationId,
            durationMs: Math.max(0, completedAt.getTime() - now.getTime()),
            safeCounts: {
              encrypted_bytes: storedInfo.size,
              objects: objects.length,
              tables: streamedSnapshot.tableNames.length,
            },
            attributes: {
              backup_key_id: keyring.currentKeyId,
              key_custody: keyring.custodyMode,
              trigger,
              offhost: "local_only",
            },
          },
          tx,
        );
      });
      publicationCommitted = true;

      // Post-commit summary read MUST NEVER trigger storage unlink or overwrite `state = 'completed'` if it fails!
      const [finalRow] = await deps.db
        .select()
        .from(backupArchives)
        .where(eq(backupArchives.publicId, archivePublicId))
        .limit(1)
        .catch(() => []);
      const lastKnownGoodId = await computeLastKnownGoodId().catch(() => null);
      if (finalRow) {
        return toArchiveSummary(finalRow, 0, lastKnownGoodId);
      }
      return {
        publicId: archivePublicId,
        state: "completed",
        reasonCode: null,
        trigger,
        encryptedSizeBytes: storedInfo.size,
        archiveSha256: storedInfo.sha256,
        backupKeyId: keyring.currentKeyId,
        keyCustodyMode: keyring.custodyMode,
        releaseRef: deps.config.releaseRef,
        schemaMigrationCount: streamedSnapshot.migrationCount,
        lastMigrationHash: streamedSnapshot.lastMigrationHash,
        objectCount: objects.length,
        objectTotalBytes,
        verificationStatus: "unverified",
        lastVerifiedAt: null,
        offHostCopyStatus: "local_only",
        remoteCopies: [],
        activeHoldCount: 0,
        isLastKnownGood: false,
        purgedAt: null,
        createdAt: now,
        completedAt,
      };
    } catch (error) {
      if (publicationCommitted) {
        throw error;
      }
      if (storageWritten) {
        await deps.storage.delete(storageKey).catch(() => {});
      }
      // If worker lost its job lease (`JobLeaseLostError`), NEVER overwrite another worker's `backup_archives` row!
      if (isJobLeaseLostError(error)) {
        throw error;
      }
      const reasonCode =
        error instanceof DomainError
          ? error.reasonCode
          : error instanceof CryptoError
            ? `CRYPTO_${error.reasonCode}`
            : "BACKUP_EXECUTION_FAILED";
      const failedAt = deps.clock.now();
      await deps.db
        .transaction(async (tx) => {
          await runOpts.assertFence?.(tx);
          await tx
            .update(backupArchives)
            .set({
              state: "failed",
              reasonCode,
              storageKey: null,
              completedAt: failedAt,
              updatedAt: failedAt,
            })
            .where(eq(backupArchives.publicId, archivePublicId));
          await deps.audit.record(
            {
              category: "backup",
              eventName: "backup.archive.failed",
              action: "create",
              outcome: "failed",
              severity: "ERROR",
              reasonCode,
              actor: runOpts.actorUserId ? { userId: runOpts.actorUserId, role: "admin" } : { role: "system" },
              resource: { type: "backup_archive", publicId: archivePublicId },
              correlationId,
              attributes: { trigger },
            },
            tx,
          );
        })
        .catch(() => {});
      if (error instanceof DomainError) throw error;
      throw new DomainError("UNAVAILABLE", reasonCode, "Encrypted backup could not be completed.");
    }
  }

  function configuredScratchRecoveryUrl(): string | undefined {
    if (options.recoveryDatabaseUrlOverride) return options.recoveryDatabaseUrlOverride;
    return readSecretEnv("RP_RECOVERY_DATABASE_URL", options.env ?? process.env);
  }

  async function verifyBackupDirect(
    backupPublicId: string,
    verifyOpts: {
      actorUserId?: number | null;
      correlationId?: string;
      assertFence?: (tx?: Tx) => Promise<void>;
    } = {},
  ): Promise<BackupVerificationSummary> {
    const startedAt = deps.clock.now();
    const correlationId = verifyOpts.correlationId ?? getRequestContext()?.correlationId ?? ulid(startedAt.getTime());

    const [archive] = await deps.db.select().from(backupArchives).where(eq(backupArchives.publicId, backupPublicId)).limit(1);
    if (!archive || archive.purgedAt !== null || archive.reasonCode === "RETENTION_PURGE_PENDING") {
      throw notFound("BACKUP_NOT_FOUND");
    }
    if (archive.state !== "completed" || !archive.storageKey) {
      throw conflict("BACKUP_NOT_COMPLETED", "Only completed encrypted backups can be verified.");
    }

    const keyring = await requireBackupKeyring(deps.settings, options);
    const verificationPublicId = ulid(startedAt.getTime());

    try {
      await verifyOpts.assertFence?.();
      const encryptedStream = await deps.storage.get(archive.storageKey);
      const decryptor = decryptBackupStream(encryptedStream, {
        keyring,
        expectedBackupPublicId: archive.publicId,
      });

      let localSqlVerifyState = { uncompressedBytes: 0, uncompressedSha256: "", validMarkers: false };
      const parsedBundle = await readAndValidateBackupBundle(decryptor.plaintext, {
        onSqlGz: async (gzStream) => {
          localSqlVerifyState = await consumeSqlForVerify(gzStream);
        },
      });
      const decStats = decryptor.result();

      if (
        archive.encryptedSizeBytes !== null &&
        (decStats.encryptedBytes !== archive.encryptedSizeBytes || decStats.archiveSha256 !== archive.archiveSha256)
      ) {
        throw new CryptoError("TAMPERED");
      }
      if (archive.manifestSha256 !== null && parsedBundle.manifest.manifestContentSha256 !== archive.manifestSha256) {
        throw new CryptoError("TAMPERED");
      }
      if (
        localSqlVerifyState.uncompressedBytes !== parsedBundle.manifest.databaseDump.uncompressedBytes ||
        localSqlVerifyState.uncompressedSha256 !== parsedBundle.manifest.databaseDump.uncompressedSha256 ||
        !localSqlVerifyState.validMarkers
      ) {
        throw new CryptoError("TAMPERED");
      }

      // Optional isolated scratch-target restore + continuity + semantic integrity check when dedicated scratch
      // recovery credentials (`RP_RECOVERY_DATABASE_URL(_FILE)`) are configured!
      let verificationScope: "byte_and_manifest" | "scratch_restore_verified" = "byte_and_manifest";
      const scratchRecoveryUrl = configuredScratchRecoveryUrl();
      if (scratchRecoveryUrl) {
        const scratchDbName = `rp_vfy_${verificationPublicId.slice(-16).toLowerCase()}`;
        const scratchParentBase =
          options.env?.RP_RECOVERY_SANDBOX_DIR ?? process.env.RP_RECOVERY_SANDBOX_DIR ?? tmpdir();
        await mkdir(scratchParentBase, { recursive: true, mode: 0o700 });
        const scratchStorageDir = await mkdtemp(path.join(scratchParentBase, "rp-vfy-"));
        let reservedScratchDb: Awaited<ReturnType<typeof prepareIsolatedTargetDatabase>> | null = null;
        try {
          reservedScratchDb = await prepareIsolatedTargetDatabase({
            recoveryDatabaseUrl: scratchRecoveryUrl,
            targetDatabaseName: scratchDbName,
            liveDatabaseUrl: effectiveDatabaseUrl(),
            enforceTargetScopedGrants: true,
          });
          const scratchStorage = createObjectStorage({
            config: { storageDir: scratchStorageDir },
            logger: deps.logger,
          });
          const scratchStream = await deps.storage.get(archive.storageKey);
          const scratchDec = decryptBackupStream(scratchStream, {
            keyring,
            expectedBackupPublicId: archive.publicId,
          });
          await readAndValidateBackupBundle(scratchDec.plaintext, {
            onSqlGz: async (gzStream) => {
              await loadSqlGzIntoIsolatedDatabase(reservedScratchDb!.targetDatabaseUrl, gzStream, {
                uncompressedBytes: parsedBundle.manifest.databaseDump.uncompressedBytes,
                uncompressedSha256: parsedBundle.manifest.databaseDump.uncompressedSha256,
              });
            },
            onObject: async (objKey, objStream) => {
              await scratchStorage.put(objKey, Readable.from(objStream));
            },
          });
          scratchDec.result();

          const { continuity, integrity } = await reconcileAndVerifyIsolatedRestore({
            targetDatabaseUrl: reservedScratchDb.targetDatabaseUrl,
            isolatedStorage: scratchStorage,
            manifest: parsedBundle.manifest,
            continuityMode: "quarantine_credentials",
            backupPublicId: archive.publicId,
            config: deps.config,
            clock: deps.clock,
            logger: deps.logger,
            crypto: deps.crypto,
          });
          if (!integrity.passed || continuity.auditChainVerified === "failed") {
            throw new DomainError(
              "CONFLICT",
              "SCRATCH_VERIFY_INTEGRITY_FAILED",
              "Isolated scratch-target continuity or semantic integrity check failed.",
            );
          }
          verificationScope = "scratch_restore_verified";
        } finally {
          if (reservedScratchDb) {
            const cleanupConn = await openValidatedMysqlConnection(scratchRecoveryUrl, { withoutDatabase: true }).catch(
              () => null,
            );
            if (cleanupConn) {
              await cleanupConn.query(`DROP DATABASE IF EXISTS \`${scratchDbName}\``).catch(() => {});
              await cleanupConn.end().catch(() => {});
            }
            await reservedScratchDb.release();
          }
          await rm(scratchStorageDir, { recursive: true, force: true }).catch(() => {});
        }
      }

      const presentDataKeyIds = new Set(Object.keys(deps.config.dataKeyring.keys));
      const missingDataKeyIds = parsedBundle.manifest.requiredKeys.dataKeyringAllIds.filter(
        (id) => !presentDataKeyIds.has(id),
      );
      const keyReadiness: KeyReadinessState = missingDataKeyIds.length === 0 ? "ready" : "missing_data_keys";
      const completedAt = deps.clock.now();
      const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());

      await deps.db.transaction(async (tx) => {
        await verifyOpts.assertFence?.(tx);
        await tx.insert(backupVerifications).values({
          publicId: verificationPublicId,
          backupId: archive.id,
          state: "completed",
          reasonCode: null,
          authenticatedBytes: decStats.authenticatedBytes,
          chunksVerified: decStats.chunksVerified,
          sqlSha256Matched: true,
          objectsVerified: parsedBundle.objectsRead.size,
          manifestValid: true,
          keyReadiness,
          missingDataKeyIdsJson: missingDataKeyIds,
          durationMs,
          requestedByUserId: verifyOpts.actorUserId ?? null,
          correlationId,
          completedAt,
          createdAt: startedAt,
        });
        await tx
          .update(backupArchives)
          .set({
            verificationStatus: "verified",
            lastVerifiedAt: completedAt,
            updatedAt: completedAt,
          })
          .where(eq(backupArchives.id, archive.id));
        await deps.audit.record(
          {
            category: "backup",
            eventName: "backup.verify.completed",
            action: "verify",
            outcome: "completed",
            severity: "INFO",
            actor: verifyOpts.actorUserId ? { userId: verifyOpts.actorUserId, role: "admin" } : { role: "system" },
            resource: { type: "backup_archive", publicId: archive.publicId },
            correlationId,
            durationMs,
            safeCounts: {
              authenticated_bytes: decStats.authenticatedBytes,
              chunks: decStats.chunksVerified,
              objects: parsedBundle.objectsRead.size,
            },
            attributes: {
              key_readiness: keyReadiness,
              verification_scope: verificationScope,
            },
          },
          tx,
        );
      });

      await maybeStageAutomaticOffsiteCopies(deps, archive.publicId, correlationId).catch((err) => {
        deps.logger.warn("failed to stage automatic off-site backup copies; worker sweep will retry", {
          backupPublicId: archive.publicId,
          errorName: err instanceof Error ? err.name : "unknown",
        });
      });

      const [vRow] = await deps.db
        .select()
        .from(backupVerifications)
        .where(eq(backupVerifications.publicId, verificationPublicId))
        .limit(1);
      return toVerificationSummary(vRow!, archive.publicId);
    } catch (error) {
      if (isJobLeaseLostError(error)) {
        throw error;
      }
      const reasonCode =
        error instanceof CryptoError
          ? `ARCHIVE_${error.reasonCode}`
          : error instanceof DomainError
            ? error.reasonCode
            : "VERIFY_IO_FAILED";
      const completedAt = deps.clock.now();
      const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());

      await deps.db.transaction(async (tx) => {
        await verifyOpts.assertFence?.(tx);
        await tx.insert(backupVerifications).values({
          publicId: verificationPublicId,
          backupId: archive.id,
          state: "failed",
          reasonCode,
          authenticatedBytes: null,
          chunksVerified: null,
          sqlSha256Matched: false,
          objectsVerified: null,
          manifestValid: false,
          keyReadiness: "unknown",
          missingDataKeyIdsJson: [],
          durationMs,
          requestedByUserId: verifyOpts.actorUserId ?? null,
          correlationId,
          completedAt,
          createdAt: startedAt,
        });
        await tx
          .update(backupArchives)
          .set({
            verificationStatus: "failed",
            updatedAt: completedAt,
          })
          .where(eq(backupArchives.id, archive.id));
        await deps.audit.record(
          {
            category: "backup",
            eventName: "backup.verify.failed",
            action: "verify",
            outcome: "failed",
            severity: "ERROR",
            reasonCode,
            actor: verifyOpts.actorUserId ? { userId: verifyOpts.actorUserId, role: "admin" } : { role: "system" },
            resource: { type: "backup_archive", publicId: archive.publicId },
            correlationId,
            durationMs,
          },
          tx,
        );
      });

      throw new DomainError(
        "CONFLICT",
        reasonCode,
        "Backup archive failed cryptographic or manifest verification.",
      );
    }
  }

  async function consumeSqlForVerify(
    gzStream: AsyncIterable<Buffer>,
  ): Promise<{ uncompressedBytes: number; uncompressedSha256: string; validMarkers: boolean }> {
    const { createHash } = await import("node:crypto");
    const { Transform } = await import("node:stream");
    const { pipeline } = await import("node:stream/promises");
    const { createGunzip } = await import("node:zlib");

    const hash = createHash("sha256");
    let bytes = 0;
    let head = "";
    let tail = "";
    const sink = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        hash.update(chunk);
        const s = chunk.toString("utf8");
        if (head.length < 512) head += s.slice(0, 512 - head.length);
        tail = (tail + s).slice(-512);
        cb();
      },
    });
    try {
      await pipeline(Readable.from(gzStream), createGunzip(), sink);
    } catch {
      throw new CryptoError("TAMPERED");
    }
    return {
      uncompressedBytes: bytes,
      uncompressedSha256: hash.digest("hex"),
      validMarkers: head.includes("MySQL dump") && tail.includes("Dump completed"),
    };
  }

  async function restoreToIsolatedTargetDirect(input: {
    backupPublicId: string;
    targetDatabaseName: string;
    targetStorageDir: string;
    recoveryDatabaseUrl?: string;
    archiveFilePath?: string;
    continuityMode?: ContinuityMode;
    confirmationText: string;
    actorUserId?: number | null;
    correlationId?: string;
    allowSameUserInTestOnly?: boolean;
  }): Promise<RestoreDrillSummary> {
    const keyring = await requireBackupKeyring(deps.settings, options);
    const recoveryUrl =
      input.recoveryDatabaseUrl ??
      configuredScratchRecoveryUrl() ??
      (input.allowSameUserInTestOnly ? effectiveDatabaseUrl() : undefined);

    if (!recoveryUrl) {
      throw new DomainError(
        "FORBIDDEN",
        "RECOVERY_CREDENTIALS_REQUIRED",
        "Isolated restore requires separate operator credentials via RP_RECOVERY_DATABASE_URL or RP_RECOVERY_DATABASE_URL_FILE.",
      );
    }

    const [archive] = await deps.db
      .select()
      .from(backupArchives)
      .where(eq(backupArchives.publicId, input.backupPublicId))
      .limit(1);

    if (!input.archiveFilePath) {
      if (!archive || archive.purgedAt !== null || archive.reasonCode === "RETENTION_PURGE_PENDING") {
        throw notFound("BACKUP_NOT_FOUND");
      }
      if (archive.state !== "completed" || !archive.storageKey) {
        throw conflict("BACKUP_NOT_RESTORABLE", "Only completed encrypted backups can be restored.");
      }
    }

    const result = await executeIsolatedCliRestore({
      ...(input.archiveFilePath
        ? { archiveFilePath: input.archiveFilePath }
        : { openArchiveStream: () => deps.storage.get(archive!.storageKey!) }),
      expectedBackupPublicId: input.backupPublicId,
      recoveryDatabaseUrl: recoveryUrl,
      targetDatabaseName: input.targetDatabaseName,
      targetStorageDir: input.targetStorageDir,
      confirmationText: input.confirmationText,
      continuityMode: input.continuityMode ?? "quarantine_credentials",
      keyring,
      config: deps.config,
      clock: deps.clock,
      logger: deps.logger,
      crypto: deps.crypto,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      ...(input.allowSameUserInTestOnly ? { allowSameUserInTestOnly: true } : {}),
      liveLedger: {
        db: deps.db,
        audit: deps.audit,
        liveDatabaseUrl: effectiveDatabaseUrl(),
        liveStorageDir: deps.config.storageDir,
        archiveId: archive?.id ?? null,
        expectedArchiveSha256: archive?.archiveSha256 ?? null,
        actorUserId: input.actorUserId ?? null,
      },
    });

    return {
      publicId: result.drillPublicId,
      backupPublicId: result.backupPublicId,
      state: result.state,
      reasonCode: result.reasonCode,
      targetDatabaseName: result.targetDatabaseName,
      continuityMode: result.continuityMode,
      achievedDataAgeMs: result.achievedDataAgeMs,
      durationMs: result.durationMs,
      continuity: result.continuity,
      integrity: result.integrity,
      createdAt: result.createdAt,
      completedAt: result.completedAt,
    };
  }

  async function executeRetentionInternal(
    actorPrincipal: SessionPrincipal | null,
    dryRun: boolean,
    assertFence?: (tx?: Tx) => Promise<void>,
  ): Promise<{ prunedCount: number; items: RetentionPlanItem[] }> {
    const now = deps.clock.now();

    if (dryRun) {
      const keepLastCount = await readSetting(deps.settings, BACKUP_RETENTION_KEEP_COUNT);
      const maxAgeDays = await readSetting(deps.settings, BACKUP_RETENTION_MAX_AGE_DAYS);
      const rows = await deps.db
        .select()
        .from(backupArchives)
        .where(isNull(backupArchives.purgedAt))
        .orderBy(desc(backupArchives.createdAt), desc(backupArchives.id));
      const holdCounts = await countActiveHoldsByBackupIds(rows.map((r) => r.id));
      const plan = buildRetentionPlan(
        rows.map((r) => ({
          id: r.id,
          publicId: r.publicId,
          state: r.state,
          verificationStatus: r.verificationStatus,
          storageKey: r.storageKey,
          activeHoldCount: holdCounts.get(r.id) ?? 0,
          createdAt: r.createdAt,
          purgedAt: r.purgedAt,
        })),
        { keepLastCount, maxAgeDays },
        now,
      );
      return {
        prunedCount: 0,
        items: plan.map((p) => ({
          backupPublicId: p.backupPublicId,
          createdAt: p.createdAt,
          action: p.action,
          keepReason: p.keepReason,
        })),
      };
    }

    // Two-phase crash-safe deletion ledger (MEDIUM-2):
    // Phase 1 (in tx, fenced): lock actor, candidate archives, and active holds; mark eligible archives
    //   `reasonCode = 'RETENTION_PURGE_PENDING'` while keeping `storageKey` non-null and `purgedAt = null`;
    //   write durable pre-delete intent audit event (`backup.retention.executed` / `phase: 'intent'`).
    // Phase 2 (outside tx): physically delete each `storageKey`, tracking succeeded vs failed unlinks.
    // Phase 3 (in tx, fenced): ONLY clear `storageKey = null` and set `purgedAt` for physically deleted archives,
    //   leaving failed unlinks in `RETENTION_PURGE_PENDING` with `storageKey` intact for automatic retry!
    const targetsToDelete: { id: number; publicId: string; storageKey: string }[] = [];
    let finalItems: RetentionPlanItem[] = [];
    let evaluatedCount = 0;
    let keepLastCountSnapshot = 0;
    let maxAgeDaysSnapshot = 0;

    await deps.db.transaction(async (tx) => {
      await assertFence?.(tx);
      if (actorPrincipal) {
        await assertBackupActorInTx(deps.services, deps.clock, actorPrincipal, "backup.retention.manage", tx);
      }
      keepLastCountSnapshot = await readSetting(deps.settings, BACKUP_RETENTION_KEEP_COUNT, tx);
      maxAgeDaysSnapshot = await readSetting(deps.settings, BACKUP_RETENTION_MAX_AGE_DAYS, tx);

      const rows = await tx
        .select()
        .from(backupArchives)
        .where(isNull(backupArchives.purgedAt))
        .orderBy(desc(backupArchives.createdAt), desc(backupArchives.id))
        .for("update");

      const ids = rows.map((r) => r.id);
      const holdMap = new Map<number, number>();
      if (ids.length > 0) {
        const activeHolds = await tx
          .select({ id: backupLegalHolds.id, backupId: backupLegalHolds.backupId })
          .from(backupLegalHolds)
          .where(and(inArray(backupLegalHolds.backupId, ids), isNull(backupLegalHolds.releasedAt)))
          .for("update");
        for (const h of activeHolds) {
          holdMap.set(h.backupId, (holdMap.get(h.backupId) ?? 0) + 1);
        }
      }

      const plan = buildRetentionPlan(
        rows.map((r) => ({
          id: r.id,
          publicId: r.publicId,
          state: r.state,
          verificationStatus: r.verificationStatus,
          storageKey: r.storageKey,
          activeHoldCount: holdMap.get(r.id) ?? 0,
          createdAt: r.createdAt,
          purgedAt: r.purgedAt,
        })),
        { keepLastCount: keepLastCountSnapshot, maxAgeDays: maxAgeDaysSnapshot },
        now,
      );

      evaluatedCount = plan.length;
      const rowById = new Map(rows.map((r) => [r.id, r]));

      // Re-evaluate previously interrupted `RETENTION_PURGE_PENDING` rows too: if protected by hold or last_known_good now, cancel pending!
      const cancelPendingIds: number[] = [];
      for (const p of plan) {
        const row = rowById.get(p.id)!;
        const shouldPurge =
          p.action === "prune" ||
          (row.reasonCode === "RETENTION_PURGE_PENDING" &&
            p.keepReason !== "legal_hold" &&
            p.keepReason !== "last_known_good" &&
            p.keepReason !== "non_terminal_or_unknown");
        if (shouldPurge && row.storageKey) {
          targetsToDelete.push({ id: row.id, publicId: row.publicId, storageKey: row.storageKey });
        } else if (row.reasonCode === "RETENTION_PURGE_PENDING" && !shouldPurge) {
          cancelPendingIds.push(row.id);
        }
      }

      finalItems = plan.map((p) => {
        const forced = targetsToDelete.some((t) => t.id === p.id);
        return {
          backupPublicId: p.backupPublicId,
          createdAt: p.createdAt,
          action: forced ? "prune" : p.action,
          keepReason: forced ? null : p.keepReason,
        };
      });

      if (cancelPendingIds.length > 0) {
        await tx
          .update(backupArchives)
          .set({ reasonCode: null, updatedAt: now })
          .where(inArray(backupArchives.id, cancelPendingIds));
      }

      if (targetsToDelete.length > 0) {
        // Record durable pre-delete intent BEFORE any physical object deletion!
        await deps.audit.record(
          {
            category: "backup",
            eventName: "backup.retention.intent",
            action: "delete",
            outcome: "attempted",
            severity: "WARN",
            actor: actorPrincipal ? { userId: actorPrincipal.userId, role: actorPrincipal.role } : { role: "system" },
            resource: { type: "backup_retention" },
            safeCounts: {
              evaluated: evaluatedCount,
              pending_delete: targetsToDelete.length,
            },
            attributes: {
              dry_run: false,
              keep_last_count: keepLastCountSnapshot,
              max_age_days: maxAgeDaysSnapshot,
            },
          },
          tx,
        );
        await tx
          .update(backupArchives)
          .set({
            reasonCode: "RETENTION_PURGE_PENDING",
            updatedAt: now,
          })
          .where(
            inArray(
              backupArchives.id,
              targetsToDelete.map((t) => t.id),
            ),
          );
      } else {
        await deps.audit.record(
          {
            category: "backup",
            eventName: "backup.retention.executed",
            action: "delete",
            outcome: "completed",
            severity: "INFO",
            actor: actorPrincipal ? { userId: actorPrincipal.userId, role: actorPrincipal.role } : { role: "system" },
            resource: { type: "backup_retention" },
            safeCounts: {
              evaluated: evaluatedCount,
              pruned: 0,
              kept: evaluatedCount,
            },
            attributes: {
              dry_run: false,
              keep_last_count: keepLastCountSnapshot,
              max_age_days: maxAgeDaysSnapshot,
            },
          },
          tx,
        );
      }
    });

    if (targetsToDelete.length === 0) {
      return { prunedCount: 0, items: finalItems };
    }

    // Phase 2: Physically delete storage objects outside the DB transaction; retain storageKey for any unlink error!
    const succeededIds: number[] = [];
    const failedIds: number[] = [];
    for (const target of targetsToDelete) {
      try {
        await deps.storage.delete(target.storageKey);
        succeededIds.push(target.id);
      } catch (err) {
        failedIds.push(target.id);
        deps.logger.warn("failed to unlink pruned backup object; retaining storageKey for retry", {
          backupPublicId: target.publicId,
          errorName: err instanceof Error ? err.name : "unknown",
        });
      }
    }

    // Phase 3: Clear `storageKey` and set `purgedAt` ONLY for physically unlinked objects; record durable completion/failure!
    const completedNow = deps.clock.now();
    await deps.db.transaction(async (tx) => {
      await assertFence?.(tx);
      if (succeededIds.length > 0) {
        await tx
          .update(backupArchives)
          .set({
            storageKey: null,
            purgedAt: completedNow,
            reasonCode: "RETENTION_PURGED",
            updatedAt: completedNow,
          })
          .where(inArray(backupArchives.id, succeededIds));
      }
      await deps.audit.record(
        {
          category: "backup",
          eventName: "backup.retention.executed",
          action: "delete",
          outcome: failedIds.length === 0 ? "completed" : "failed",
          severity: failedIds.length === 0 ? "WARN" : "ERROR",
          ...(failedIds.length > 0 ? { reasonCode: "RETENTION_STORAGE_DELETE_PARTIAL" } : {}),
          actor: actorPrincipal ? { userId: actorPrincipal.userId, role: actorPrincipal.role } : { role: "system" },
          resource: { type: "backup_retention" },
          safeCounts: {
            evaluated: evaluatedCount,
            pruned: succeededIds.length,
            failed_unlink: failedIds.length,
            kept: Math.max(0, evaluatedCount - targetsToDelete.length),
          },
          attributes: {
            dry_run: false,
            keep_last_count: keepLastCountSnapshot,
            max_age_days: maxAgeDaysSnapshot,
          },
        },
        tx,
      );
    });

    if (failedIds.length > 0) {
      throw new DomainError(
        "UNAVAILABLE",
        "RETENTION_STORAGE_DELETE_PARTIAL",
        `${String(failedIds.length)} backup archive object(s) could not be unlinked; storage keys retained in RETENTION_PURGE_PENDING for retry.`,
      );
    }

    return { prunedCount: succeededIds.length, items: finalItems };
  }

  // Register fenced background jobs and schedules at construction time (safe — no dereference of deps.services.*)
  deps.jobs.register<{ backupPublicId?: string; trigger?: BackupTrigger; actorUserId?: number | null }>(
    BACKUP_JOB_CREATE,
    async (job: ClaimedJob<{ backupPublicId?: string; trigger?: BackupTrigger; actorUserId?: number | null }>): Promise<JobResult> => {
      const trigger = job.payload?.trigger ?? "scheduled";
      if (trigger === "scheduled") {
        const enabled = await isFlagEnabled(deps.settings, BACKUP_SCHEDULE_ENABLED);
        if (!enabled) {
          return { outcome: "completed", safeCounts: { skipped_disabled: 1 } };
        }
      }
      if (await isMaintenanceDraining()) {
        return { outcome: "canceled", reasonCode: "MAINTENANCE_DRAINING" };
      }
      try {
        const summary = await runBackupDirect({
          trigger,
          actorUserId: job.payload?.actorUserId ?? null,
          correlationId: job.correlationId,
          ...(job.payload?.backupPublicId ? { backupPublicId: job.payload.backupPublicId } : {}),
          assertFence: (tx) => job.assertStillOwned(tx),
          abortSignal: job.signal,
        });
        return {
          outcome: "completed",
          safeCounts: {
            encrypted_bytes: summary.encryptedSizeBytes ?? 0,
            objects: summary.objectCount ?? 0,
          },
        };
      } catch (error) {
        if (isJobLeaseLostError(error)) {
          throw error;
        }
        const reasonCode = error instanceof DomainError ? error.reasonCode : "BACKUP_JOB_FAILED";
        return { outcome: "failed", reasonCode, retryable: false };
      }
    },
  );

  deps.jobs.register<{ backupPublicId?: string }>(
    BACKUP_JOB_VERIFY,
    async (job: ClaimedJob<{ backupPublicId?: string }>): Promise<JobResult> => {
      let targetPublicId = job.payload?.backupPublicId;
      if (!targetPublicId) {
        const enabled = await isFlagEnabled(deps.settings, BACKUP_SCHEDULE_ENABLED);
        if (!enabled) {
          return { outcome: "completed", safeCounts: { skipped_disabled: 1 } };
        }
        const [latest] = await deps.db
          .select({ publicId: backupArchives.publicId })
          .from(backupArchives)
          .where(and(isNull(backupArchives.purgedAt), eq(backupArchives.state, "completed")))
          .orderBy(desc(backupArchives.createdAt), desc(backupArchives.id))
          .limit(1);
        if (!latest) return { outcome: "completed", safeCounts: { verified: 0 } };
        targetPublicId = latest.publicId;
      }
      try {
        await job.assertStillOwned();
        const res = await verifyBackupDirect(targetPublicId, {
          correlationId: job.correlationId,
          assertFence: (tx) => job.assertStillOwned(tx),
        });
        return {
          outcome: "completed",
          safeCounts: { authenticated_bytes: res.authenticatedBytes ?? 0 },
        };
      } catch (error) {
        if (isJobLeaseLostError(error)) {
          throw error;
        }
        const reasonCode = error instanceof DomainError ? error.reasonCode : "VERIFY_JOB_FAILED";
        return { outcome: "failed", reasonCode, retryable: false };
      }
    },
  );

  deps.jobs.register(
    BACKUP_JOB_RETENTION,
    async (job: ClaimedJob<unknown>): Promise<JobResult> => {
      await job.assertStillOwned();
      const autoPrune = await isFlagEnabled(deps.settings, BACKUP_RETENTION_AUTO_PRUNE);
      try {
        const res = await executeRetentionInternal(null, !autoPrune, (tx) => job.assertStillOwned(tx));
        return {
          outcome: "completed",
          safeCounts: { pruned: res.prunedCount, evaluated: res.items.length },
        };
      } catch (error) {
        if (isJobLeaseLostError(error)) {
          throw error;
        }
        const reasonCode = error instanceof DomainError ? error.reasonCode : "RETENTION_JOB_FAILED";
        return { outcome: "failed", reasonCode, retryable: true };
      }
    },
  );

  deps.jobs.registerSchedule({
    name: "backup.scheduled.daily",
    type: BACKUP_JOB_CREATE,
    everyMs: 24 * 60 * 60 * 1000,
    payload: { trigger: "scheduled" },
  });
  deps.jobs.registerSchedule({
    name: "backup.scheduled.verify",
    type: BACKUP_JOB_VERIFY,
    everyMs: 24 * 60 * 60 * 1000,
    payload: {},
  });
  deps.jobs.registerSchedule({
    name: "backup.scheduled.retention",
    type: BACKUP_JOB_RETENTION,
    everyMs: 24 * 60 * 60 * 1000,
    payload: {},
  });
  deps.jobs.register<RemoteCopyJobPayload>(
    BACKUP_JOB_REMOTE_COPY,
    (job) => executeRemoteCopyJob(deps, isMaintenanceDraining, isJobLeaseLostError, job),
  );
  deps.jobs.register(
    BACKUP_JOB_REMOTE_SWEEP,
    (job) => executeRemoteCopySweepJob(deps, isMaintenanceDraining, isJobLeaseLostError, job),
  );
  deps.jobs.registerSchedule({
    name: "backup.scheduled.remote_sweep",
    type: BACKUP_JOB_REMOTE_SWEEP,
    everyMs: 15 * 60 * 1000,
    payload: {},
  });

  return {
    init() {
      registerBackupAutomationTriggers(deps);
    },

    async health(): Promise<ModuleHealth[]> {
      const checkedAt = deps.clock.now();
      const offHostFlag = await isFlagEnabled(deps.settings, BACKUP_OFFHOST_ENABLED).catch(() => false);
      const status321 = await compute321Status(deps).catch(() => null);
      const policyActive =
        offHostFlag ||
        Boolean(status321 && (status321.autoCopyAfterVerify || status321.enabledOffsiteDestinations > 0));
      const offHostHealth: ModuleHealth = !policyActive
        ? {
            component: "backup.offhost",
            state: "not_configured",
            summary: "Local storage only: off-site backup replication is not enabled.",
            checkedAt,
          }
        : status321?.overallMet
          ? {
              component: "backup.offhost",
              state: "ok",
              summary: `3-2-1 backup policy met (${String(status321.verifiedCopies)} verified copies across ${String(status321.storageSystems)} storage systems).`,
              metrics: {
                verifiedCopies: status321.verifiedCopies,
                offsiteCopies: status321.offsiteVerifiedCopies,
                storageSystems: status321.storageSystems,
              },
              checkedAt,
            }
          : status321?.oneOffsiteMet
            ? {
                component: "backup.offhost",
                state: "degraded",
                summary: "Off-site verified backup copy exists, but fewer than three total verified copies exist in the evaluation window.",
                metrics: {
                  verifiedCopies: status321.verifiedCopies,
                  offsiteCopies: status321.offsiteVerifiedCopies,
                  storageSystems: status321.storageSystems,
                },
                checkedAt,
              }
            : {
                component: "backup.offhost",
                state: "failing",
                summary: "Off-site backup policy is enabled, but no verified off-site copy exists in the evaluation window.",
                checkedAt,
              };

      let keyring;
      try {
        keyring = await resolveBackupKeyring(deps.settings, options);
      } catch {
        return [
          {
            component: "backup.status",
            state: "failing",
            summary: "Backup encryption key configuration or secret file custody is invalid.",
            checkedAt,
          },
          offHostHealth,
        ];
      }

      if (!keyring) {
        return [
          {
            component: "backup.status",
            state: "not_configured",
            summary: "Backup encryption key is not configured; backups are refused.",
            checkedAt,
          },
          offHostHealth,
        ];
      }

      try {
        const scheduleEnabled = await isFlagEnabled(deps.settings, BACKUP_SCHEDULE_ENABLED);
        const rows = await deps.db
          .select({
            id: backupArchives.id,
            publicId: backupArchives.publicId,
            state: backupArchives.state,
            verificationStatus: backupArchives.verificationStatus,
            lastVerifiedAt: backupArchives.lastVerifiedAt,
            completedAt: backupArchives.completedAt,
            createdAt: backupArchives.createdAt,
            purgedAt: backupArchives.purgedAt,
          })
          .from(backupArchives)
          .where(isNull(backupArchives.purgedAt))
          .orderBy(desc(backupArchives.createdAt), desc(backupArchives.id))
          .limit(100);

        const [holdCntRow] = await deps.db
          .select({ cnt: sql<number>`COUNT(*)` })
          .from(backupLegalHolds)
          .where(isNull(backupLegalHolds.releasedAt));
        const activeHolds = Number(holdCntRow?.cnt ?? 0);

        const latest = rows[0];
        const latestCompleted = rows.find((r) => r.state === "completed");
        const latestVerified = rows.find((r) => r.state === "completed" && r.verificationStatus === "verified");
        const unknownCount = rows.filter((r) => r.state === "unknown").length;
        const failedCount = rows.filter((r) => r.state === "failed" || r.verificationStatus === "failed").length;
        const verifiedCount = rows.filter((r) => r.state === "completed" && r.verificationStatus === "verified").length;

        const lastSuccessAgeSeconds = latestCompleted?.completedAt
          ? Math.max(0, Math.floor((checkedAt.getTime() - latestCompleted.completedAt.getTime()) / 1000))
          : -1;
        const lastVerifiedAgeSeconds = latestVerified?.lastVerifiedAt
          ? Math.max(0, Math.floor((checkedAt.getTime() - latestVerified.lastVerifiedAt.getTime()) / 1000))
          : -1;

        const metrics: Record<string, number> = {
          verifiedCount,
          failedCount,
          unknownCount,
          activeHolds,
          ...(lastSuccessAgeSeconds >= 0 ? { lastSuccessAgeSeconds } : {}),
          ...(lastVerifiedAgeSeconds >= 0 ? { lastVerifiedAgeSeconds } : {}),
        };

        if (unknownCount > 0 || latest?.state === "failed" || latest?.verificationStatus === "failed") {
          return [
            {
              component: "backup.status",
              state: "failing",
              summary: "Latest backup or verification failed or has an unresolved unknown outcome.",
              metrics,
              checkedAt,
            },
            offHostHealth,
          ];
        }

        if (
          !latestVerified ||
          keyring.custodyMode === "settings_secret" ||
          (scheduleEnabled && lastSuccessAgeSeconds > 26 * 3600)
        ) {
          return [
            {
              component: "backup.status",
              state: "degraded",
              summary: !latestVerified
                ? "Backup key is configured, but no verified encrypted backup exists yet."
                : keyring.custodyMode === "settings_secret"
                  ? "Encrypted backups exist, but the backup key is stored in database settings rather than an off-host file."
                  : "Scheduled encrypted backup is overdue.",
              metrics,
              checkedAt,
            },
            offHostHealth,
          ];
        }

        return [
          {
            component: "backup.status",
            state: "ok",
            summary: "Encrypted backup and byte-level verification are current (local storage only).",
            metrics,
            checkedAt,
          },
          offHostHealth,
        ];
      } catch {
        return [
          {
            component: "backup.status",
            state: "failing",
            summary: "Backup repository could not be queried.",
            checkedAt,
          },
          offHostHealth,
        ];
      }
    },

    async listBackups(principal, input = {}) {
      assertBackupPrincipalPrecheck(principal, "backup.read", deps.clock.now());
      const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
      const conditions = [];
      if (input.state) {
        conditions.push(eq(backupArchives.state, input.state));
      }
      if (input.cursor) {
        const decoded = decodeCursor(input.cursor);
        conditions.push(
          or(
            lt(backupArchives.createdAt, decoded.createdAt),
            and(eq(backupArchives.createdAt, decoded.createdAt), lt(backupArchives.id, decoded.id)),
          )!,
        );
      }

      const rows = await deps.db
        .select()
        .from(backupArchives)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(backupArchives.createdAt), desc(backupArchives.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const [holdCounts, remoteCopiesMap, lastKnownGoodId, status321] = await Promise.all([
        countActiveHoldsByBackupIds(pageRows.map((r) => r.id)),
        loadRemoteCopiesByBackupIds(
          deps.db,
          pageRows.map((r) => ({ id: r.id, publicId: r.publicId })),
        ),
        computeLastKnownGoodId(),
        compute321Status(deps).catch(() => null),
      ]);

      let keyConfigured: boolean;
      let keyCustodyWarning: string | null = null;
      try {
        const kr = await resolveBackupKeyring(deps.settings, options);
        keyConfigured = kr !== null;
        if (kr?.custodyMode === "settings_secret") {
          keyCustodyWarning = DB_SECRET_CUSTODY_WARNING;
        }
      } catch {
        keyConfigured = false;
        keyCustodyWarning = "Backup encryption key configuration or file permissions are invalid.";
      }

      const offHostNote = status321?.overallMet
        ? `3-2-1 backup policy met: ${String(status321.verifiedCopies)} verified copies across ${String(status321.storageSystems)} storage systems (${String(status321.offsiteVerifiedCopies)} off-site). Store rp_backup_key separately off-host.`
        : status321 && status321.offsiteVerifiedCopies > 0
          ? `${String(status321.offsiteVerifiedCopies)} verified off-site copy(ies) in the last ${String(status321.windowDays)} days; configure a second off-site destination to reach 3 total copies.`
          : LOCAL_ONLY_NOTICE;

      const lastItem = pageRows[pageRows.length - 1];
      return {
        items: pageRows.map((r) =>
          toArchiveSummary(r, holdCounts.get(r.id) ?? 0, lastKnownGoodId, remoteCopiesMap.get(r.id) ?? []),
        ),
        nextCursor: hasMore && lastItem ? encodeCursor(lastItem.createdAt, lastItem.id) : null,
        keyConfigured,
        keyCustodyWarning,
        offHostStatusNote: offHostNote,
      };
    },

    async getBackup(principal, backupPublicId) {
      assertBackupPrincipalPrecheck(principal, "backup.read", deps.clock.now());
      const [row] = await deps.db
        .select()
        .from(backupArchives)
        .where(eq(backupArchives.publicId, backupPublicId))
        .limit(1);
      if (!row) throw notFound("BACKUP_NOT_FOUND");

      const [holdCounts, remoteCopiesMap, lastKnownGoodId] = await Promise.all([
        countActiveHoldsByBackupIds([row.id]),
        loadRemoteCopiesByBackupIds(deps.db, [{ id: row.id, publicId: row.publicId }]),
        computeLastKnownGoodId(),
      ]);
      const remoteCopies = remoteCopiesMap.get(row.id) ?? [];

      const vRows = await deps.db
        .select()
        .from(backupVerifications)
        .where(eq(backupVerifications.backupId, row.id))
        .orderBy(desc(backupVerifications.createdAt), desc(backupVerifications.id))
        .limit(25);

      const rRows = await deps.db
        .select()
        .from(backupRestoreDrills)
        .where(eq(backupRestoreDrills.backupId, row.id))
        .orderBy(desc(backupRestoreDrills.createdAt), desc(backupRestoreDrills.id))
        .limit(25);

      const hRows = await deps.db
        .select({
          hold: backupLegalHolds,
          creatorPublicId: users.publicId,
        })
        .from(backupLegalHolds)
        .leftJoin(users, eq(users.id, backupLegalHolds.createdByUserId))
        .where(eq(backupLegalHolds.backupId, row.id))
        .orderBy(desc(backupLegalHolds.createdAt), desc(backupLegalHolds.id))
        .limit(50);

      return {
        archive: toArchiveSummary(row, holdCounts.get(row.id) ?? 0, lastKnownGoodId, remoteCopies),
        verifications: vRows.map((v) => toVerificationSummary(v, row.publicId)),
        restores: rRows.map((r) => ({
          publicId: r.publicId,
          backupPublicId: row.publicId,
          state: r.state,
          reasonCode: r.reasonCode,
          targetDatabaseName: r.targetDatabaseName,
          continuityMode: r.continuityMode,
          achievedDataAgeMs: r.achievedDataAgeMs,
          durationMs: r.durationMs,
          continuity: r.continuityReportJson,
          integrity: r.integrityReportJson,
          createdAt: r.createdAt,
          completedAt: r.completedAt,
        })),
        holds: hRows.map(({ hold, creatorPublicId }) => ({
          publicId: hold.publicId,
          backupPublicId: row.publicId,
          reasonCode: hold.reasonCode,
          note: deps.crypto.decrypt(hold.noteEnc, `backup_legal_holds.note:${hold.publicId}`),
          createdByUserPublicId: creatorPublicId,
          createdAt: hold.createdAt,
          releasedAt: hold.releasedAt,
        })),
        remoteCopies,
      };
    },

    async enqueueBackup(principal, input = {}) {
      const now = deps.clock.now();
      assertBackupPrincipalPrecheck(principal, "backup.run", now);
      if (await isMaintenanceDraining()) {
        throw new DomainError("MAINTENANCE", "MAINTENANCE_DRAINING", "System is draining for maintenance; try again after maintenance completes.");
      }

      // Fail closed immediately if key is missing/invalid before queueing!
      let keyring;
      try {
        keyring = await requireBackupKeyring(deps.settings, options);
      } catch (error) {
        const reasonCode = error instanceof DomainError ? error.reasonCode : "BACKUP_KEY_MISSING";
        await deps.audit.record({
          category: "backup",
          eventName: "backup.archive.refused",
          action: "create",
          outcome: "refused",
          severity: "WARN",
          reasonCode,
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "backup_archive" },
        });
        throw error;
      }

      const trigger = input.trigger ?? "manual";
      const backupPublicId = ulid(now.getTime());
      const correlationId = getRequestContext()?.correlationId ?? backupPublicId;

      const { jobId } = await deps.db.transaction(async (tx) => {
        await assertBackupActorInTx(deps.services, deps.clock, principal, "backup.run", tx);
        const enqueued = await deps.jobs.enqueue(
          BACKUP_JOB_CREATE,
          { backupPublicId, trigger, actorUserId: principal.userId },
          { idempotencyKey: `backup:${backupPublicId}`, correlationId },
          tx,
        );
        await tx.insert(backupArchives).values({
          publicId: backupPublicId,
          state: "queued",
          trigger,
          backupKeyId: keyring.currentKeyId,
          keyCustodyMode: keyring.custodyMode,
          installationId: deps.config.installationId,
          releaseRef: deps.config.releaseRef,
          jobPublicId: enqueued.jobId,
          correlationId,
          requestedByUserId: principal.userId,
          createdAt: now,
          updatedAt: now,
        });
        await deps.audit.record(
          {
            category: "backup",
            eventName: "backup.archive.requested",
            action: "create",
            outcome: "attempted",
            severity: "INFO",
            actor: { userId: principal.userId, role: principal.role },
            resource: { type: "backup_archive", publicId: backupPublicId },
            jobId: enqueued.jobId,
            correlationId,
            attributes: { trigger, backup_key_id: keyring.currentKeyId },
          },
          tx,
        );
        return enqueued;
      });

      return { backupPublicId, jobId };
    },

    runBackupDirect,

    async verifyBackup(principal, backupPublicId) {
      assertBackupPrincipalPrecheck(principal, "backup.verify", deps.clock.now());
      await deps.db.transaction(async (tx) => {
        await assertBackupActorInTx(deps.services, deps.clock, principal, "backup.verify", tx);
      });
      return verifyBackupDirect(backupPublicId, { actorUserId: principal.userId });
    },

    verifyBackupDirect,

    restoreToIsolatedTargetDirect,

    async getRetentionPolicy(principal) {
      assertBackupPrincipalPrecheck(principal, "backup.read", deps.clock.now());
      const [keepLastCount, maxAgeDays, scheduleEnabled, autoPruneEnabled, envSandbox] = await Promise.all([
        readSetting(deps.settings, BACKUP_RETENTION_KEEP_COUNT),
        readSetting(deps.settings, BACKUP_RETENTION_MAX_AGE_DAYS),
        isFlagEnabled(deps.settings, BACKUP_SCHEDULE_ENABLED),
        isFlagEnabled(deps.settings, BACKUP_RETENTION_AUTO_PRUNE),
        readSetting(deps.settings, BACKUP_RECOVERY_SANDBOX_ROOT),
      ]);
      return {
        keepLastCount,
        maxAgeDays,
        scheduleEnabled,
        autoPruneEnabled,
        recoverySandboxRoot: options.env?.RP_RECOVERY_SANDBOX_DIR ?? process.env.RP_RECOVERY_SANDBOX_DIR ?? envSandbox,
      };
    },

    async updateRetentionPolicy(principal, input) {
      assertBackupPrincipalPrecheck(principal, "backup.retention.manage", deps.clock.now());
      await deps.db.transaction(async (tx) => {
        await assertBackupActorInTx(deps.services, deps.clock, principal, "backup.retention.manage", tx);
        await writeSetting(deps.settings, BACKUP_RETENTION_KEEP_COUNT, input.keepLastCount, tx);
        await writeSetting(deps.settings, BACKUP_RETENTION_MAX_AGE_DAYS, input.maxAgeDays, tx);
        await deps.settings.set(BACKUP_SCHEDULE_ENABLED.key, input.scheduleEnabled, tx);
        if (input.autoPruneEnabled !== undefined) {
          await deps.settings.set(BACKUP_RETENTION_AUTO_PRUNE.key, input.autoPruneEnabled, tx);
        }
        await deps.audit.record(
          {
            category: "backup",
            eventName: "backup.retention.policy_changed",
            action: "update",
            outcome: "completed",
            severity: "INFO",
            actor: { userId: principal.userId, role: principal.role },
            resource: { type: "backup_retention_policy" },
            attributes: {
              keep_last_count: input.keepLastCount,
              max_age_days: input.maxAgeDays,
              schedule_enabled: input.scheduleEnabled,
              ...(input.autoPruneEnabled !== undefined ? { auto_prune_enabled: input.autoPruneEnabled } : {}),
            },
          },
          tx,
        );
      });
    },

    async previewRetention(principal) {
      assertBackupPrincipalPrecheck(principal, "backup.read", deps.clock.now());
      const res = await executeRetentionInternal(principal, true);
      return { items: res.items };
    },

    async runRetention(principal, input) {
      if (input.dryRun) {
        assertBackupPrincipalPrecheck(principal, "backup.read", deps.clock.now());
        return executeRetentionInternal(principal, true);
      }
      assertBackupPrincipalPrecheck(principal, "backup.retention.manage", deps.clock.now());
      return executeRetentionInternal(principal, false);
    },

    async createLegalHold(principal, input) {
      const now = deps.clock.now();
      assertBackupPrincipalPrecheck(principal, "backup.retention.manage", now);
      if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(input.reasonCode)) {
        throw validation("INVALID_REASON_CODE", "Hold reason code must be UPPER_SNAKE_CASE.");
      }
      const trimmedNote = input.note.normalize("NFC").trim();
      if (trimmedNote.length < 3 || trimmedNote.length > 500) {
        throw validation("INVALID_HOLD_NOTE", "Hold note must be between 3 and 500 characters.");
      }

      const holdPublicId = ulid(now.getTime());
      const noteEnc = deps.crypto.encrypt(trimmedNote, `backup_legal_holds.note:${holdPublicId}`);

      await deps.db.transaction(async (tx) => {
        await assertBackupActorInTx(deps.services, deps.clock, principal, "backup.retention.manage", tx);
        const [archive] = await tx
          .select({ id: backupArchives.id, purgedAt: backupArchives.purgedAt, reasonCode: backupArchives.reasonCode })
          .from(backupArchives)
          .where(eq(backupArchives.publicId, input.backupPublicId))
          .limit(1)
          .for("update");
        if (!archive || archive.purgedAt !== null || archive.reasonCode === "RETENTION_PURGE_PENDING") {
          throw notFound("BACKUP_NOT_FOUND");
        }
        await tx.insert(backupLegalHolds).values({
          publicId: holdPublicId,
          backupId: archive.id,
          reasonCode: input.reasonCode,
          noteEnc,
          createdByUserId: principal.userId,
          createdAt: now,
        });
        await deps.audit.record(
          {
            category: "backup",
            eventName: "backup.legal_hold.created",
            action: "create",
            outcome: "completed",
            severity: "INFO",
            reasonCode: input.reasonCode,
            actor: { userId: principal.userId, role: principal.role },
            resource: { type: "backup_legal_hold", publicId: holdPublicId },
            attributes: { backup_public_id: input.backupPublicId },
          },
          tx,
        );
      });

      return {
        publicId: holdPublicId,
        backupPublicId: input.backupPublicId,
        reasonCode: input.reasonCode,
        note: trimmedNote,
        createdByUserPublicId: principal.userPublicId,
        createdAt: now,
        releasedAt: null,
      };
    },

    async releaseLegalHold(principal, input) {
      const now = deps.clock.now();
      assertBackupPrincipalPrecheck(principal, "backup.retention.manage", now);
      if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(input.releaseReasonCode)) {
        throw validation("INVALID_REASON_CODE", "Release reason code must be UPPER_SNAKE_CASE.");
      }

      await deps.db.transaction(async (tx) => {
        await assertBackupActorInTx(deps.services, deps.clock, principal, "backup.retention.manage", tx);
        const [hold] = await tx
          .select()
          .from(backupLegalHolds)
          .where(eq(backupLegalHolds.publicId, input.holdPublicId))
          .limit(1)
          .for("update");
        if (!hold) throw notFound("HOLD_NOT_FOUND");
        if (hold.releasedAt !== null) {
          throw conflict("HOLD_ALREADY_RELEASED", "This legal hold has already been released.");
        }
        await tx
          .update(backupLegalHolds)
          .set({
            releasedByUserId: principal.userId,
            releaseReasonCode: input.releaseReasonCode,
            releasedAt: now,
          })
          .where(eq(backupLegalHolds.id, hold.id));
        await deps.audit.record(
          {
            category: "backup",
            eventName: "backup.legal_hold.released",
            action: "update",
            outcome: "completed",
            severity: "WARN",
            reasonCode: input.releaseReasonCode,
            actor: { userId: principal.userId, role: principal.role },
            resource: { type: "backup_legal_hold", publicId: hold.publicId },
          },
          tx,
        );
      });
    },

    async openEncryptedArchiveDownload(principal, backupPublicId) {
      assertBackupPrincipalPrecheck(principal, "backup.restore", deps.clock.now());
      let storageKey = "";
      let size = 0;

      await deps.db.transaction(async (tx) => {
        await assertBackupActorInTx(deps.services, deps.clock, principal, "backup.restore", tx);
        const [archive] = await tx
          .select()
          .from(backupArchives)
          .where(eq(backupArchives.publicId, backupPublicId))
          .limit(1)
          .for("update");
        if (!archive || archive.purgedAt !== null || archive.state !== "completed" || !archive.storageKey) {
          throw notFound("BACKUP_NOT_FOUND");
        }
        storageKey = archive.storageKey;
        size = archive.encryptedSizeBytes ?? 0;

        await deps.audit.record(
          {
            category: "backup",
            eventName: "backup.archive.downloaded",
            action: "download",
            outcome: "completed",
            severity: "WARN",
            actor: { userId: principal.userId, role: principal.role },
            resource: { type: "backup_archive", publicId: archive.publicId },
            safeCounts: { encrypted_bytes: size },
          },
          tx,
        );
      });

      const stream = await deps.storage.get(storageKey);
      return {
        filename: `readypackets-backup-${backupPublicId}.rpbk`,
        size,
        stream,
      };
    },

    getOffsiteConfig: (principal) => getOffsiteBackupConfig(deps, principal),

    updateOffsiteConfig: (principal, input) => updateOffsiteBackupConfig(deps, principal, input),

    copyOffsiteNow: (principal, input) => copyBackupOffsiteNow(deps, isMaintenanceDraining, principal, input),

    mayRetryOffsiteCopy: (input, tx) => mayRetryBackupOffsiteCopy(deps, input, tx),
  };
}
