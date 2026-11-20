/**
 * Backup & disaster-recovery module — public service surface and factory.
 * Owner: recovery_ops_engineer.
 */
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { OperationState } from "../../../shared/domain.js";
import type { ModuleDeps } from "../../container.js";
import { conflict, CryptoError, DomainError, notFound, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { getRequestContext } from "../../core/requestContext.js";
import type { ClaimedJob, JobResult, ModuleHealth, ModuleLifecycle, SessionPrincipal, Tx } from "../../core/types.js";
import { createObjectStorage } from "../files/storage.js";
import { orderFiles } from "../files/schema.js";
import { users } from "../identity/schema.js";
import { jobRuns } from "../jobs/schema.js";
import { isFlagEnabled, readSetting, writeSetting } from "../platform/index.js";
import { platformPresentationImages } from "../platform/schema.js";
import { assertBackupActorInTx, assertBackupPrincipalPrecheck } from "./actorGuard.js";
import { createBackupBundleStream, readAndValidateBackupBundle, sealManifest, type BundleObjectSource } from "./bundle.js";
import { reconcileAndVerifyIsolatedRestore } from "./continuity.js";
import { decryptBackupStream, encryptBackupStream } from "./crypto.js";
import { requireBackupKeyring, resolveBackupKeyring, type BackupKeySourceOptions } from "./keys.js";
import {
  assertValidIsolatedDatabaseName,
  loadSqlGzIntoIsolatedDatabase,
  openMysqldumpGzStream,
  prepareIsolatedTargetDatabase,
} from "./mysqlCli.js";
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

export interface BackupModuleOptions extends BackupKeySourceOptions {
  /** Override database URL for mysqldump/mysql in isolated test harnesses where config.databaseUrl is synthetic. */
  databaseUrlOverride?: string;
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
    assertFence?: () => Promise<void>;
  }): Promise<BackupArchiveSummary>;
  verifyBackup(principal: SessionPrincipal, backupPublicId: string): Promise<BackupVerificationSummary>;
  verifyBackupDirect(
    backupPublicId: string,
    options?: { actorUserId?: number | null; correlationId?: string },
  ): Promise<BackupVerificationSummary>;
  restoreToIsolatedTarget(
    principal: SessionPrincipal,
    input: {
      backupPublicId: string;
      targetDatabaseName: string;
      targetStoragePath?: string;
      continuityMode?: ContinuityMode;
      confirmationText: string;
    },
  ): Promise<RestoreDrillSummary>;
  restoreToIsolatedTargetDirect(input: {
    backupPublicId: string;
    targetDatabaseName: string;
    targetStorageDir: string;
    continuityMode?: ContinuityMode;
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
}

interface FilesBackupCollectorLike {
  backupFiles(
    tx: Tx,
    input: { after?: string; limit: number },
  ): Promise<{ items: { publicId: string; storageKey: string; size: number; sha256: string }[]; nextCursor: string | null }>;
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

  async function collectPrivateObjectsForBackup(existingTables: ReadonlySet<string>): Promise<BundleObjectSource[]> {
    const collected = new Map<string, BundleObjectSource>();
    const filesMod = deps.services.files as unknown as Partial<FilesBackupCollectorLike> | undefined;

    if (filesMod && typeof filesMod.backupFiles === "function") {
      let cursor: string | undefined;
      while (true) {
        const page = await deps.db.transaction((tx) => filesMod.backupFiles!(tx, { ...(cursor ? { after: cursor } : {}), limit: 250 }));
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
    } else if (existingTables.has("order_files")) {
      const rows = await deps.db
        .select({
          publicId: orderFiles.publicId,
          storageKey: orderFiles.storageKey,
          byteSize: orderFiles.byteSize,
          sha256: orderFiles.sha256,
        })
        .from(orderFiles)
        .where(isNull(orderFiles.purgedAt))
        .orderBy(orderFiles.id);
      for (const r of rows) {
        if (!collected.has(r.storageKey)) {
          collected.set(r.storageKey, {
            storageKey: r.storageKey,
            expectedSize: r.byteSize,
            expectedSha256: r.sha256,
            sourceTable: "order_files",
            recordPublicId: r.publicId,
            open: () => deps.storage.get(r.storageKey),
          });
        }
      }
    }

    if (existingTables.has("platform_presentation_images")) {
      const imgs = await deps.db
        .select({
          publicId: platformPresentationImages.publicId,
          storageKey: platformPresentationImages.storageKey,
          byteSize: platformPresentationImages.byteSize,
          sha256: platformPresentationImages.sha256,
        })
        .from(platformPresentationImages)
        .where(isNull(platformPresentationImages.deletedAt))
        .orderBy(platformPresentationImages.id);
      for (const img of imgs) {
        if (!collected.has(img.storageKey)) {
          collected.set(img.storageKey, {
            storageKey: img.storageKey,
            expectedSize: img.byteSize,
            expectedSha256: img.sha256,
            sourceTable: "platform_presentation_images",
            recordPublicId: img.publicId,
            open: () => deps.storage.get(img.storageKey),
          });
        }
      }
    }

    // Pre-verify every referenced object exists and matches its recorded digest before starting archive stream
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

    return [...collected.values()].sort((a, b) => a.storageKey.localeCompare(b.storageKey));
  }

  async function countActiveWriterJobs(existingTables: ReadonlySet<string>): Promise<number> {
    if (!existingTables.has("job_runs")) return 0;
    const [row] = await deps.db
      .select({ cnt: sql<number>`COUNT(*)` })
      .from(jobRuns)
      .where(and(eq(jobRuns.state, "running"), sql`${jobRuns.type} <> ${BACKUP_JOB_CREATE}`));
    return Number(row?.cnt ?? 0);
  }

  async function runBackupDirect(
    runOpts: {
      trigger?: BackupTrigger;
      actorUserId?: number | null;
      correlationId?: string;
      backupPublicId?: string;
      assertFence?: () => Promise<void>;
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

    // Ensure `backup_archives` row exists in `running` state BEFORE snapshot so row count is deterministic.
    await deps.db.transaction(async (tx) => {
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

    const storageKey = deps.storage.newKey("backups");
    let storageWritten = false;

    try {
      await runOpts.assertFence?.();

      const dumpHandle = await openMysqldumpGzStream(effectiveDatabaseUrl(), () => deps.clock.now());
      const existingTables = new Set(dumpHandle.snapshot.tableNames);
      const activeWriters = await countActiveWriterJobs(existingTables);
      const objects = await collectPrivateObjectsForBackup(existingTables);

      let builtManifestSha256 = "";
      let dbDumpCompletedAt = dumpHandle.startedAt;

      const bundleStream = createBackupBundleStream({
        now: () => deps.clock.now(),
        objects,
        openSqlGzStream: async () => ({
          gzStream: dumpHandle.gzStream,
          finalizeSqlStats: async () => {
            const finalized = await dumpHandle.finalize();
            dbDumpCompletedAt = finalized.completedAt;
            return {
              uncompressedBytes: finalized.uncompressedBytes,
              uncompressedSha256: finalized.uncompressedSha256,
              tableNames: dumpHandle.snapshot.tableNames,
              tableRowCounts: dumpHandle.snapshot.tableRowCounts,
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
              migrationCount: dumpHandle.snapshot.migrationCount,
              lastMigrationHash: dumpHandle.snapshot.lastMigrationHash,
              lastMigrationCreatedAt: dumpHandle.snapshot.lastMigrationCreatedAt,
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

      await runOpts.assertFence?.();

      const completedAt = deps.clock.now();
      const objectTotalBytes = objects.reduce((acc, o) => acc + o.expectedSize, 0);

      await deps.db.transaction(async (tx) => {
        await tx
          .update(backupArchives)
          .set({
            state: "completed",
            reasonCode: null,
            storageKey,
            encryptedSizeBytes: storedInfo.size,
            archiveSha256: storedInfo.sha256,
            manifestSha256: builtManifestSha256,
            schemaMigrationCount: dumpHandle.snapshot.migrationCount,
            lastMigrationHash: dumpHandle.snapshot.lastMigrationHash,
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
              tables: dumpHandle.snapshot.tableNames.length,
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

      const [finalRow] = await deps.db.select().from(backupArchives).where(eq(backupArchives.publicId, archivePublicId)).limit(1);
      const lastKnownGoodId = await computeLastKnownGoodId();
      return toArchiveSummary(finalRow!, 0, lastKnownGoodId);
    } catch (error) {
      if (storageWritten) {
        await deps.storage.delete(storageKey).catch(() => {});
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
            },
            tx,
          );
        })
        .catch(() => {});
      if (error instanceof DomainError) throw error;
      throw new DomainError("UNAVAILABLE", reasonCode, "Encrypted backup could not be completed.");
    }
  }

  async function verifyBackupDirect(
    backupPublicId: string,
    verifyOpts: { actorUserId?: number | null; correlationId?: string } = {},
  ): Promise<BackupVerificationSummary> {
    const startedAt = deps.clock.now();
    const correlationId = verifyOpts.correlationId ?? getRequestContext()?.correlationId ?? ulid(startedAt.getTime());

    const [archive] = await deps.db.select().from(backupArchives).where(eq(backupArchives.publicId, backupPublicId)).limit(1);
    if (!archive || archive.purgedAt !== null) {
      throw notFound("BACKUP_NOT_FOUND");
    }
    if (archive.state !== "completed" || !archive.storageKey) {
      throw conflict("BACKUP_NOT_COMPLETED", "Only completed encrypted backups can be verified.");
    }

    const keyring = await requireBackupKeyring(deps.settings, options);
    const verificationPublicId = ulid(startedAt.getTime());

    try {
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

      const presentDataKeyIds = new Set(Object.keys(deps.config.dataKeyring.keys));
      const missingDataKeyIds = parsedBundle.manifest.requiredKeys.dataKeyringAllIds.filter(
        (id) => !presentDataKeyIds.has(id),
      );
      const keyReadiness: KeyReadinessState = missingDataKeyIds.length === 0 ? "ready" : "missing_data_keys";
      const completedAt = deps.clock.now();
      const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());

      await deps.db.transaction(async (tx) => {
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
            },
          },
          tx,
        );
      });

      const [vRow] = await deps.db
        .select()
        .from(backupVerifications)
        .where(eq(backupVerifications.publicId, verificationPublicId))
        .limit(1);
      return toVerificationSummary(vRow!, archive.publicId);
    } catch (error) {
      const reasonCode =
        error instanceof CryptoError
          ? `ARCHIVE_${error.reasonCode}`
          : error instanceof DomainError
            ? error.reasonCode
            : "VERIFY_IO_FAILED";
      const completedAt = deps.clock.now();
      const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());

      await deps.db.transaction(async (tx) => {
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

  async function validateAndPrepareIsolatedStorageDir(targetStorageDir: string): Promise<string> {
    if (!path.isAbsolute(targetStorageDir)) {
      throw validation("INVALID_TARGET_STORAGE", "Isolated target storage path must be an absolute directory.");
    }
    const resolvedTarget = path.resolve(targetStorageDir);
    const resolvedLive = path.resolve(deps.config.storageDir);
    if (
      resolvedTarget === "/" ||
      resolvedTarget === resolvedLive ||
      resolvedTarget.startsWith(`${resolvedLive}${path.sep}`) ||
      resolvedLive.startsWith(`${resolvedTarget}${path.sep}`)
    ) {
      throw conflict(
        "LIVE_STORAGE_OVERLAP",
        "Isolated restore storage directory must not equal or overlap the live storage directory.",
      );
    }
    await mkdir(resolvedTarget, { recursive: true, mode: 0o700 });
    const entries = await readdir(resolvedTarget);
    if (entries.length > 0) {
      throw conflict(
        "TARGET_STORAGE_NOT_EMPTY",
        "Isolated restore storage directory must be empty before restoration.",
      );
    }
    return resolvedTarget;
  }

  async function restoreToIsolatedTargetDirect(input: {
    backupPublicId: string;
    targetDatabaseName: string;
    targetStorageDir: string;
    continuityMode?: ContinuityMode;
    confirmationText: string;
    actorUserId?: number | null;
    correlationId?: string;
  }): Promise<RestoreDrillSummary> {
    const startedAt = deps.clock.now();
    const correlationId = input.correlationId ?? getRequestContext()?.correlationId ?? ulid(startedAt.getTime());
    const continuityMode: ContinuityMode = input.continuityMode ?? "preserve_continuity";
    const drillPublicId = ulid(startedAt.getTime());

    const expectedConfirmation = expectedRestoreConfirmationText(input.backupPublicId, input.targetDatabaseName);
    if (input.confirmationText.trim() !== expectedConfirmation) {
      throw validation(
        "CONFIRMATION_MISMATCH",
        `Type the exact confirmation phrase "${expectedConfirmation}" to proceed.`,
      );
    }

    const [archive] = await deps.db
      .select()
      .from(backupArchives)
      .where(eq(backupArchives.publicId, input.backupPublicId))
      .limit(1);
    if (!archive || archive.purgedAt !== null) {
      throw notFound("BACKUP_NOT_FOUND");
    }
    if (archive.state !== "completed" || !archive.storageKey) {
      throw conflict("BACKUP_NOT_RESTORABLE", "Only completed encrypted backups can be restored.");
    }

    // Validate isolated DB and isolated storage targets BEFORE opening archive or mutating anything
    try {
      assertValidIsolatedDatabaseName(effectiveDatabaseUrl(), input.targetDatabaseName);
    } catch (error) {
      const reasonCode = error instanceof DomainError ? error.reasonCode : "INVALID_TARGET_DATABASE";
      await deps.audit.record({
        category: "backup",
        eventName: "backup.restore.refused",
        action: "restore",
        outcome: "refused",
        severity: "WARN",
        reasonCode,
        actor: input.actorUserId ? { userId: input.actorUserId, role: "admin" } : { role: "system" },
        resource: { type: "backup_archive", publicId: archive.publicId },
        correlationId,
      });
      throw error;
    }

    let resolvedTargetStorage: string;
    try {
      resolvedTargetStorage = await validateAndPrepareIsolatedStorageDir(input.targetStorageDir);
    } catch (error) {
      const reasonCode = error instanceof DomainError ? error.reasonCode : "INVALID_TARGET_STORAGE";
      await deps.audit.record({
        category: "backup",
        eventName: "backup.restore.refused",
        action: "restore",
        outcome: "refused",
        severity: "WARN",
        reasonCode,
        actor: input.actorUserId ? { userId: input.actorUserId, role: "admin" } : { role: "system" },
        resource: { type: "backup_archive", publicId: archive.publicId },
        correlationId,
      });
      throw error;
    }

    const keyring = await requireBackupKeyring(deps.settings, options);

    // Pass 1: Full pre-write cryptographic & manifest verification so a tampered archive NEVER partially populates a target!
    let verifiedManifest;
    try {
      const pass1Stream = await deps.storage.get(archive.storageKey);
      const pass1Dec = decryptBackupStream(pass1Stream, {
        keyring,
        expectedBackupPublicId: archive.publicId,
      });
      let pass1SqlVerify = { uncompressedBytes: 0, uncompressedSha256: "", validMarkers: false };
      const pass1Bundle = await readAndValidateBackupBundle(pass1Dec.plaintext, {
        onSqlGz: async (gzStream) => {
          pass1SqlVerify = await consumeSqlForVerify(gzStream);
        },
      });
      const pass1Stats = pass1Dec.result();
      if (archive.archiveSha256 && pass1Stats.archiveSha256 !== archive.archiveSha256) {
        throw new CryptoError("TAMPERED");
      }
      if (
        pass1SqlVerify.uncompressedBytes !== pass1Bundle.manifest.databaseDump.uncompressedBytes ||
        pass1SqlVerify.uncompressedSha256 !== pass1Bundle.manifest.databaseDump.uncompressedSha256 ||
        !pass1SqlVerify.validMarkers
      ) {
        throw new CryptoError("TAMPERED");
      }
      verifiedManifest = pass1Bundle.manifest;
    } catch (error) {
      const reasonCode =
        error instanceof CryptoError
          ? `ARCHIVE_${error.reasonCode}`
          : error instanceof DomainError
            ? error.reasonCode
            : "RESTORE_PREVERIFY_FAILED";
      await deps.db.transaction(async (tx) => {
        await tx.insert(backupRestoreDrills).values({
          publicId: drillPublicId,
          backupId: archive.id,
          state: "failed",
          reasonCode,
          targetDatabaseName: input.targetDatabaseName,
          continuityMode,
          completedAt: deps.clock.now(),
          createdAt: startedAt,
          requestedByUserId: input.actorUserId ?? null,
          correlationId,
        });
        await deps.audit.record(
          {
            category: "backup",
            eventName: "backup.restore.failed",
            action: "restore",
            outcome: "failed",
            severity: "ERROR",
            reasonCode,
            actor: input.actorUserId ? { userId: input.actorUserId, role: "admin" } : { role: "system" },
            resource: { type: "backup_archive", publicId: archive.publicId },
            correlationId,
          },
          tx,
        );
      });
      throw new DomainError("CONFLICT", reasonCode, "Archive verification failed; isolated target was not modified.");
    }

    // Prepare isolated MySQL target database (must not exist or must have 0 tables)
    let targetDbInfo: { targetDatabaseUrl: string; createdDatabase: boolean };
    try {
      targetDbInfo = await prepareIsolatedTargetDatabase(effectiveDatabaseUrl(), input.targetDatabaseName);
    } catch (error) {
      const reasonCode = error instanceof DomainError ? error.reasonCode : "TARGET_DB_PREPARE_FAILED";
      await deps.audit.record({
        category: "backup",
        eventName: "backup.restore.refused",
        action: "restore",
        outcome: "refused",
        severity: "WARN",
        reasonCode,
        actor: input.actorUserId ? { userId: input.actorUserId, role: "admin" } : { role: "system" },
        resource: { type: "backup_archive", publicId: archive.publicId },
        correlationId,
      });
      throw error;
    }

    const isolatedStorage = createObjectStorage({
      config: { storageDir: resolvedTargetStorage },
      logger: deps.logger,
    });

    try {
      // Pass 2: Stream authenticated SQL into isolated database and objects into isolated LocalObjectStorage
      const pass2Stream = await deps.storage.get(archive.storageKey);
      const pass2Dec = decryptBackupStream(pass2Stream, {
        keyring,
        expectedBackupPublicId: archive.publicId,
      });

      await readAndValidateBackupBundle(pass2Dec.plaintext, {
        onSqlGz: async (gzStream) => {
          await loadSqlGzIntoIsolatedDatabase(targetDbInfo.targetDatabaseUrl, gzStream, {
            uncompressedBytes: verifiedManifest.databaseDump.uncompressedBytes,
            uncompressedSha256: verifiedManifest.databaseDump.uncompressedSha256,
          });
        },
        onObject: async (storageKey, objStream) => {
          await isolatedStorage.put(storageKey, Readable.from(objStream));
        },
      });
      pass2Dec.result();

      // Reconcile §7.3 security-state continuity and verify §7.2 semantic integrity
      const { continuity, integrity } = await reconcileAndVerifyIsolatedRestore({
        liveDatabaseUrl: effectiveDatabaseUrl(),
        targetDatabaseUrl: targetDbInfo.targetDatabaseUrl,
        isolatedStorage,
        manifest: verifiedManifest,
        continuityMode,
        backupPublicId: archive.publicId,
        config: deps.config,
        clock: deps.clock,
        logger: deps.logger,
        crypto: deps.crypto,
      });

      const completedAt = deps.clock.now();
      const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());
      const achievedDataAgeMs = Math.max(0, completedAt.getTime() - archive.createdAt.getTime());
      const state: OperationState = integrity.passed ? "completed" : "failed";
      const reasonCode = integrity.passed ? null : "INTEGRITY_CHECK_FAILED";

      await deps.db.transaction(async (tx) => {
        await tx.insert(backupRestoreDrills).values({
          publicId: drillPublicId,
          backupId: archive.id,
          state,
          reasonCode,
          targetDatabaseName: input.targetDatabaseName,
          continuityMode,
          achievedDataAgeMs,
          durationMs,
          continuityReportJson: continuity,
          integrityReportJson: integrity,
          requestedByUserId: input.actorUserId ?? null,
          correlationId,
          completedAt,
          createdAt: startedAt,
        });
        await deps.audit.record(
          {
            category: "backup",
            eventName: integrity.passed ? "backup.restore.completed" : "backup.restore.failed",
            action: "restore",
            outcome: integrity.passed ? "completed" : "failed",
            severity: integrity.passed ? "INFO" : "ERROR",
            ...(reasonCode ? { reasonCode } : {}),
            actor: input.actorUserId ? { userId: input.actorUserId, role: "admin" } : { role: "system" },
            resource: { type: "backup_archive", publicId: archive.publicId },
            correlationId,
            durationMs,
            safeCounts: {
              sessions_revoked: continuity.sessionsRevoked,
              tokens_retired: continuity.singleUseTokensRetired,
              objects_checked: integrity.objectsChecked,
              tables_checked: integrity.tablesChecked,
            },
            attributes: {
              target_database: input.targetDatabaseName,
              continuity_mode: continuityMode,
              audit_chain: continuity.auditChainVerified,
            },
          },
          tx,
        );
      });

      if (!integrity.passed) {
        throw new DomainError(
          "CONFLICT",
          "INTEGRITY_CHECK_FAILED",
          "Isolated restore completed extraction, but post-restore semantic integrity reconciliation failed.",
        );
      }

      return {
        publicId: drillPublicId,
        backupPublicId: archive.publicId,
        state,
        reasonCode,
        targetDatabaseName: input.targetDatabaseName,
        continuityMode,
        achievedDataAgeMs,
        durationMs,
        continuity,
        integrity,
        createdAt: startedAt,
        completedAt,
      };
    } catch (error) {
      if (error instanceof DomainError && error.reasonCode === "INTEGRITY_CHECK_FAILED") {
        throw error;
      }
      const reasonCode =
        error instanceof DomainError
          ? error.reasonCode
          : error instanceof CryptoError
            ? `ARCHIVE_${error.reasonCode}`
            : "RESTORE_EXECUTION_FAILED";
      const failedAt = deps.clock.now();
      await deps.db
        .transaction(async (tx) => {
          await tx.insert(backupRestoreDrills).values({
            publicId: drillPublicId,
            backupId: archive.id,
            state: "failed",
            reasonCode,
            targetDatabaseName: input.targetDatabaseName,
            continuityMode,
            durationMs: Math.max(0, failedAt.getTime() - startedAt.getTime()),
            continuityReportJson: null,
            integrityReportJson: null,
            requestedByUserId: input.actorUserId ?? null,
            correlationId,
            completedAt: failedAt,
            createdAt: startedAt,
          });
          await deps.audit.record(
            {
              category: "backup",
              eventName: "backup.restore.failed",
              action: "restore",
              outcome: "failed",
              severity: "ERROR",
              reasonCode,
              actor: input.actorUserId ? { userId: input.actorUserId, role: "admin" } : { role: "system" },
              resource: { type: "backup_archive", publicId: archive.publicId },
              correlationId,
            },
            tx,
          );
        })
        .catch(() => {});
      if (error instanceof DomainError) throw error;
      throw new DomainError("UNAVAILABLE", reasonCode, "Isolated restore failed before reconciliation completed.");
    }
  }

  async function executeRetentionInternal(
    actorPrincipal: SessionPrincipal | null,
    dryRun: boolean,
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

    // Destructive retention apply: lock actor -> lock candidate archives -> lock active holds -> audit IN TX -> delete storage keys after commit.
    const keysToDeleteAfterCommit: string[] = [];
    let finalItems: RetentionPlanItem[] = [];
    let prunedCount = 0;

    await deps.db.transaction(async (tx) => {
      if (actorPrincipal) {
        await assertBackupActorInTx(deps.services, deps.clock, actorPrincipal, "backup.retention.manage", tx);
      }
      const keepLastCount = await readSetting(deps.settings, BACKUP_RETENTION_KEEP_COUNT, tx);
      const maxAgeDays = await readSetting(deps.settings, BACKUP_RETENTION_MAX_AGE_DAYS, tx);

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
        { keepLastCount, maxAgeDays },
        now,
      );

      const toPrune = plan.filter((p) => p.action === "prune");
      prunedCount = toPrune.length;
      finalItems = plan.map((p) => ({
        backupPublicId: p.backupPublicId,
        createdAt: p.createdAt,
        action: p.action,
        keepReason: p.keepReason,
      }));

      // Record durable audit BEFORE mutating/deleting so audit failure aborts any prune!
      await deps.audit.record(
        {
          category: "backup",
          eventName: "backup.retention.executed",
          action: "delete",
          outcome: "completed",
          severity: prunedCount > 0 ? "WARN" : "INFO",
          actor: actorPrincipal ? { userId: actorPrincipal.userId, role: actorPrincipal.role } : { role: "system" },
          resource: { type: "backup_retention" },
          safeCounts: {
            evaluated: plan.length,
            pruned: prunedCount,
            kept: plan.length - prunedCount,
          },
          attributes: {
            dry_run: false,
            keep_last_count: keepLastCount,
            max_age_days: maxAgeDays,
          },
        },
        tx,
      );

      if (toPrune.length > 0) {
        const pruneIds = toPrune.map((p) => p.id);
        for (const entry of toPrune) {
          if (entry.storageKey) keysToDeleteAfterCommit.push(entry.storageKey);
        }
        await tx
          .update(backupArchives)
          .set({
            storageKey: null,
            purgedAt: now,
            updatedAt: now,
          })
          .where(inArray(backupArchives.id, pruneIds));
      }
    });

    // Perform private storage object deletion outside the DB transaction so I/O never holds row locks.
    for (const key of keysToDeleteAfterCommit) {
      await deps.storage.delete(key).catch((err) => {
        deps.logger.warn("failed to unlink pruned backup object after commit", {
          errorName: err instanceof Error ? err.name : "unknown",
        });
      });
    }

    return { prunedCount, items: finalItems };
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
          assertFence: () => job.assertStillOwned(),
        });
        return {
          outcome: "completed",
          safeCounts: {
            encrypted_bytes: summary.encryptedSizeBytes ?? 0,
            objects: summary.objectCount ?? 0,
          },
        };
      } catch (error) {
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
        const res = await verifyBackupDirect(targetPublicId, { correlationId: job.correlationId });
        return {
          outcome: "completed",
          safeCounts: { authenticated_bytes: res.authenticatedBytes ?? 0 },
        };
      } catch (error) {
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
      const res = await executeRetentionInternal(null, !autoPrune);
      return {
        outcome: "completed",
        safeCounts: { pruned: res.prunedCount, evaluated: res.items.length },
      };
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

  return {
    async health(): Promise<ModuleHealth[]> {
      const checkedAt = deps.clock.now();
      const offHostFlag = await isFlagEnabled(deps.settings, BACKUP_OFFHOST_ENABLED).catch(() => false);
      const offHostHealth: ModuleHealth = {
        component: "backup.offhost",
        state: offHostFlag ? "degraded" : "not_configured",
        summary: "Local storage only: independent off-host copy target is not configured.",
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
      const holdCounts = await countActiveHoldsByBackupIds(pageRows.map((r) => r.id));
      const lastKnownGoodId = await computeLastKnownGoodId();

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

      const lastItem = pageRows[pageRows.length - 1];
      return {
        items: pageRows.map((r) => toArchiveSummary(r, holdCounts.get(r.id) ?? 0, lastKnownGoodId)),
        nextCursor: hasMore && lastItem ? encodeCursor(lastItem.createdAt, lastItem.id) : null,
        keyConfigured,
        keyCustodyWarning,
        offHostStatusNote: LOCAL_ONLY_NOTICE,
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

      const holdCounts = await countActiveHoldsByBackupIds([row.id]);
      const lastKnownGoodId = await computeLastKnownGoodId();

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
        archive: toArchiveSummary(row, holdCounts.get(row.id) ?? 0, lastKnownGoodId),
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

    async restoreToIsolatedTarget(principal, input) {
      const now = deps.clock.now();
      assertBackupPrincipalPrecheck(principal, "backup.restore", now);
      if (await isMaintenanceDraining()) {
        throw new DomainError("MAINTENANCE", "MAINTENANCE_DRAINING", "System is draining for maintenance.");
      }

      const sandboxRootEnv = options.env?.RP_RECOVERY_SANDBOX_DIR ?? process.env.RP_RECOVERY_SANDBOX_DIR;
      let sandboxRoot = sandboxRootEnv;

      await deps.db.transaction(async (tx) => {
        await assertBackupActorInTx(deps.services, deps.clock, principal, "backup.restore", tx);
        if (!sandboxRoot) {
          sandboxRoot = await readSetting(deps.settings, BACKUP_RECOVERY_SANDBOX_ROOT, tx);
        }
        await deps.audit.record(
          {
            category: "backup",
            eventName: "backup.restore.requested",
            action: "restore",
            outcome: "attempted",
            severity: "WARN",
            actor: { userId: principal.userId, role: principal.role },
            resource: { type: "backup_archive", publicId: input.backupPublicId },
            attributes: {
              target_database: input.targetDatabaseName,
              continuity_mode: input.continuityMode ?? "preserve_continuity",
            },
          },
          tx,
        );
      });

      const resolvedRoot = path.resolve(sandboxRoot!);
      let targetStorageDir: string;
      if (input.targetStoragePath) {
        if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(input.targetStoragePath)) {
          throw validation(
            "INVALID_TARGET_STORAGE",
            "Target storage subdirectory name must be 3-64 lowercase alphanumeric, dash, or underscore characters.",
          );
        }
        targetStorageDir = path.join(resolvedRoot, input.targetStoragePath);
      } else {
        targetStorageDir = path.join(resolvedRoot, `drill-${ulid(now.getTime()).toLowerCase()}`);
      }

      return restoreToIsolatedTargetDirect({
        backupPublicId: input.backupPublicId,
        targetDatabaseName: input.targetDatabaseName,
        targetStorageDir,
        ...(input.continuityMode ? { continuityMode: input.continuityMode } : {}),
        confirmationText: input.confirmationText,
        actorUserId: principal.userId,
      });
    },

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
          .select({ id: backupArchives.id, purgedAt: backupArchives.purgedAt })
          .from(backupArchives)
          .where(eq(backupArchives.publicId, input.backupPublicId))
          .limit(1)
          .for("update");
        if (!archive || archive.purgedAt !== null) {
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
  };
}
