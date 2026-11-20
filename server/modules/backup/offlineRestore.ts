/**
 * Operator / Offline Isolated Disaster-Recovery Restore Engine.
 * Owner: recovery_ops_engineer.
 *
 * Per integrator security decision (`REVIEW-audit-siem-backup.md`), restore is NEVER exposed on the web/tRPC surface.
 * It is executed exclusively via the operator CLI (`scripts/ops/restore/restore-isolated.ts`) into an explicitly named
 * isolated database and isolated storage directory using dedicated operator/recovery MySQL credentials.
 *
 * Supports two operational contexts:
 *  1. True Bare-Metal / Offline Recovery: Live database and live object storage are completely unavailable.
 *     Restores directly from an exported encrypted `.rpbk` archive file + independent host keys (`RP_BACKUP_KEY_FILE`,
 *     `RP_AUDIT_CHAIN_KEY_FILE`, etc.) into a clean isolated target, defaulting to `quarantine_credentials` with zero
 *     live-DB connections, revoking all sessions/tokens/tickets, verifying & checkpointing the restored audit chain,
 *     and writing durable `backup.restore.completed` audit evidence inside the restored database.
 *  2. Scheduled Restore Drill (Live Ledger Optional): Restores from `.rpbk` file into the isolated recovery endpoint
 *     using dedicated target-scoped credentials (refusing live credential reuse or live-schema write privileges), while
 *     recording durable pre-execution intent and final `RestoreDrillSummary` in the live `backup_restore_drills` ledger.
 */
import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import type { AppConfig } from "../../config/env.js";
import { conflict, CryptoError, DomainError, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { AuditEmitter, Clock, Db, FieldCrypto, Logger } from "../../core/types.js";
import type { OperationState } from "../../../shared/domain.js";
import { createChainService } from "../audit/chain.js";
import { openRegularFileNoFollow } from "./archiveFile.js";
import { createAuditEmitter } from "../audit/emitter.js";
import { createObjectStorage } from "../files/storage.js";
import { readAndValidateBackupBundle } from "./bundle.js";
import { reconcileAndVerifyIsolatedRestore } from "./continuity.js";
import { decryptBackupStream } from "./crypto.js";
import type { ResolvedBackupKeyring } from "./keys.js";
import {
  assertValidIsolatedDatabaseName,
  loadSqlGzIntoIsolatedDatabase,
  openValidatedMysqlPool,
  prepareIsolatedTargetDatabase,
  verifySqlGzStream,
  type ReservedIsolatedDatabase,
} from "./mysqlCli.js";
import {
  backupRestoreDrills,
  type ContinuityMode,
  type StoredContinuityReport,
  type StoredIntegrityReport,
} from "./schema.js";

export function expectedRestoreConfirmationText(backupPublicId: string, targetDatabaseName: string): string {
  return `RESTORE ${backupPublicId} TO ${targetDatabaseName}`;
}

export interface IsolatedRestoreExecutionResult {
  drillPublicId: string;
  backupPublicId: string;
  state: OperationState;
  reasonCode: string | null;
  targetDatabaseName: string;
  targetStorageDir: string;
  continuityMode: ContinuityMode;
  achievedDataAgeMs: number | null;
  durationMs: number;
  manualAccountReviewRequired: true;
  continuity: StoredContinuityReport;
  integrity: StoredIntegrityReport;
  createdAt: Date;
  completedAt: Date;
}

export interface OptionalLiveDrillLedger {
  db: Db;
  audit: AuditEmitter;
  liveDatabaseUrl: string;
  liveStorageDir: string;
  archiveId?: number | null;
  expectedArchiveSha256?: string | null;
  actorUserId?: number | null;
}

async function openRegularArchiveFileNoFollow(filePath: string): Promise<Readable> {
  if (!path.isAbsolute(filePath)) {
    throw validation("INVALID_ARCHIVE_PATH", "Encrypted archive path (--archive-file) must be an absolute path.");
  }
  const fh = await openRegularFileNoFollow(
    filePath,
    "Archive path must exist and be a regular file (symlinks refused).",
  );
  return fh.createReadStream({ autoClose: true });
}

/**
 * Canonicalizes paths via `realpath` to prevent symlink aliasing against `liveStorageDir`, and atomically
 * reserves a `0700` isolated target directory.
 */
export async function reserveIsolatedStorageDirectory(
  targetStorageDir: string,
  liveStorageDir?: string,
): Promise<{ canonicalDir: string; markQuarantinedOnFailure: (reasonCode: string) => Promise<void> }> {
  if (!path.isAbsolute(targetStorageDir)) {
    throw validation("INVALID_TARGET_STORAGE", "Isolated target storage path must be an absolute directory.");
  }
  const normalizedTarget = path.resolve(targetStorageDir);
  if (normalizedTarget === "/") {
    throw conflict("LIVE_STORAGE_OVERLAP", "Cannot use filesystem root as isolated storage target.");
  }

  const parentDir = path.dirname(normalizedTarget);
  await mkdir(parentDir, { recursive: true, mode: 0o700 });
  const canonicalParent = await realpath(parentDir);
  const leafName = path.basename(normalizedTarget);
  const canonicalCandidate = path.join(canonicalParent, leafName);

  if (liveStorageDir) {
    const lexicalLive = path.resolve(liveStorageDir);
    const canonicalLive = await realpath(lexicalLive).catch(() => lexicalLive);
    for (const liveBase of new Set([lexicalLive, canonicalLive])) {
      if (
        canonicalCandidate === liveBase ||
        canonicalCandidate.startsWith(`${liveBase}${path.sep}`) ||
        liveBase.startsWith(`${canonicalCandidate}${path.sep}`) ||
        normalizedTarget === liveBase ||
        normalizedTarget.startsWith(`${liveBase}${path.sep}`) ||
        liveBase.startsWith(`${normalizedTarget}${path.sep}`)
      ) {
        throw conflict(
          "LIVE_STORAGE_OVERLAP",
          "Isolated restore storage directory must not equal or overlap the live storage directory.",
        );
      }
    }
  }

  // Atomic reservation: prefer fresh mkdir(..., { recursive: false, mode: 0o700 }); if pre-created empty dir, verify identity & perms.
  let createdFresh = false;
  try {
    await mkdir(canonicalCandidate, { recursive: false, mode: 0o700 });
    createdFresh = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") {
      throw new DomainError("UNAVAILABLE", "TARGET_STORAGE_PREPARE_FAILED", "Could not create isolated storage directory.");
    }
  }

  const dirStat = await lstat(canonicalCandidate);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw conflict("INVALID_TARGET_STORAGE", "Isolated target storage path must be a real directory, not a symlink.");
  }
  if (typeof process.getuid === "function" && dirStat.uid !== process.getuid() && process.getuid() !== 0) {
    throw conflict("INVALID_TARGET_STORAGE", "Isolated target storage directory is owned by an unexpected UID.");
  }
  if (!createdFresh && (dirStat.mode & 0o077) !== 0) {
    throw conflict("INVALID_TARGET_STORAGE", "Existing isolated target storage directory must have 0700 permissions.");
  }

  const entries = await readdir(canonicalCandidate);
  if (entries.length > 0) {
    throw conflict(
      "TARGET_STORAGE_NOT_EMPTY",
      "Isolated restore storage directory must be empty before restoration.",
    );
  }

  const canonicalDir = await realpath(canonicalCandidate);
  return {
    canonicalDir,
    async markQuarantinedOnFailure(reasonCode: string) {
      const markerPath = path.join(canonicalDir, ".QUARANTINED_FAILED_RESTORE.json");
      await writeFile(
        markerPath,
        JSON.stringify({ quarantined: true, reasonCode, timestamp: new Date().toISOString() }) + "\n",
        { mode: 0o600 },
      ).catch(() => {});
    },
  };
}

export async function executeIsolatedCliRestore(options: {
  /** Absolute path to `.rpbk` file (preferred for offline & CLI recovery). */
  archiveFilePath?: string;
  /** Alternative stream factory when reading from an explicit backup archive store. */
  openArchiveStream?: () => Promise<Readable>;
  expectedBackupPublicId?: string;
  recoveryDatabaseUrl: string;
  targetDatabaseName: string;
  targetStorageDir: string;
  confirmationText: string;
  continuityMode?: ContinuityMode;
  keyring: ResolvedBackupKeyring;
  config: AppConfig;
  clock: Clock;
  logger: Logger;
  crypto: FieldCrypto;
  correlationId?: string;
  liveLedger?: OptionalLiveDrillLedger;
  /** Optional read-only live URL/storage guardrails when running standalone CLI without opening a live DB pool. */
  guardLiveDatabaseUrl?: string;
  guardLiveStorageDir?: string;
  /** Only for unit tests when testing on a single local MySQL user if separate credentials are not provisioned; CLI NEVER sets this. */
  allowSameUserInTestOnly?: boolean;
}): Promise<IsolatedRestoreExecutionResult> {
  const startedAt = options.clock.now();
  const drillPublicId = ulid(startedAt.getTime());
  const correlationId = options.correlationId ?? ulid(startedAt.getTime());
  const continuityMode: ContinuityMode = options.continuityMode ?? "quarantine_credentials";

  if (!options.archiveFilePath && !options.openArchiveStream) {
    throw validation("MISSING_ARCHIVE_SOURCE", "Either --archive-file or an archive stream source is required.");
  }
  const openStream = options.archiveFilePath
    ? () => openRegularArchiveFileNoFollow(options.archiveFilePath!)
    : options.openArchiveStream!;

  const rawLiveUrl = options.liveLedger?.liveDatabaseUrl ?? options.guardLiveDatabaseUrl;
  const rawLiveStorage = options.liveLedger?.liveStorageDir ?? options.guardLiveStorageDir;
  const liveDbUrlForGuard = options.allowSameUserInTestOnly ? undefined : rawLiveUrl;

  // Validate target DB name & credential separation BEFORE opening archive or mutating anything.
  try {
    assertValidIsolatedDatabaseName(
      options.recoveryDatabaseUrl,
      options.targetDatabaseName,
      liveDbUrlForGuard,
    );
    if (options.allowSameUserInTestOnly && rawLiveUrl) {
      // Still strictly refuse restoring over the live database name even in single-user test harnesses!
      const liveDbName = new URL(rawLiveUrl).pathname.replace(/^\//, "");
      if (options.targetDatabaseName.toLowerCase() === decodeURIComponent(liveDbName).toLowerCase()) {
        throw conflict("LIVE_TARGET_REFUSED", "Restore into the live database is refused.");
      }
    }
  } catch (error) {
    if (options.liveLedger) {
      const reasonCode = error instanceof DomainError ? error.reasonCode : "INVALID_TARGET_DATABASE";
      await options.liveLedger.audit.record({
        category: "backup",
        eventName: "backup.restore.refused",
        action: "restore",
        outcome: "refused",
        severity: "WARN",
        reasonCode,
        actor: options.liveLedger.actorUserId ? { userId: options.liveLedger.actorUserId, role: "admin" } : { role: "system" },
        resource: { type: "backup_archive", ...(options.expectedBackupPublicId ? { publicId: options.expectedBackupPublicId } : {}) },
        correlationId,
      });
    }
    throw error;
  }

  // Pass 1: Authenticate EVERY encrypted chunk, SQL SHA-256, object digest, and manifest BEFORE touching filesystem or DB!
  let verifiedManifest;
  try {
    const pass1Stream = await openStream();
    const pass1Dec = decryptBackupStream(pass1Stream, {
      keyring: options.keyring,
      ...(options.expectedBackupPublicId ? { expectedBackupPublicId: options.expectedBackupPublicId } : {}),
    });
    const pass1Bundle = await readAndValidateBackupBundle(pass1Dec.plaintext, {
      onSqlGz: async (gzStream) => {
        // Temporary capture; verified against manifest immediately after manifest is parsed unless manifest comes last.
        // Because manifest is the final bundle member, compute uncompressed bytes + sha256 + markers here!
        const { createHash } = await import("node:crypto");
        const { Transform } = await import("node:stream");
        const { pipeline } = await import("node:stream/promises");
        const { createGunzip } = await import("node:zlib");
        const h = createHash("sha256");
        let uBytes = 0;
        let head = "";
        let tail = "";
        const sink = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            uBytes += chunk.length;
            h.update(chunk);
            const s = chunk.toString("utf8");
            if (head.length < 512) head += s.slice(0, 512 - head.length);
            tail = (tail + s).slice(-512);
            cb();
          },
        });
        await pipeline(Readable.from(gzStream), createGunzip(), sink);
        (pass1Dec as unknown as { _sqlCheck?: { uBytes: number; sha: string; ok: boolean } })._sqlCheck = {
          uBytes,
          sha: h.digest("hex"),
          ok: head.includes("MySQL dump") && tail.includes("Dump completed"),
        };
      },
    });
    const pass1Stats = pass1Dec.result();
    const sqlCheck = (pass1Dec as unknown as { _sqlCheck?: { uBytes: number; sha: string; ok: boolean } })._sqlCheck;
    if (
      options.liveLedger?.expectedArchiveSha256 &&
      pass1Stats.archiveSha256 !== options.liveLedger.expectedArchiveSha256
    ) {
      throw new CryptoError("TAMPERED");
    }
    if (
      !sqlCheck ||
      !sqlCheck.ok ||
      sqlCheck.uBytes !== pass1Bundle.manifest.databaseDump.uncompressedBytes ||
      sqlCheck.sha !== pass1Bundle.manifest.databaseDump.uncompressedSha256
    ) {
      throw new CryptoError("TAMPERED");
    }
    // Re-verify SQL helper contract explicitly for zero- byte edge cases
    void verifySqlGzStream;
    verifiedManifest = pass1Bundle.manifest;
  } catch (error) {
    const reasonCode =
      error instanceof CryptoError
        ? `ARCHIVE_${error.reasonCode}`
        : error instanceof DomainError
          ? error.reasonCode
          : "RESTORE_PREVERIFY_FAILED";
    if (options.liveLedger) {
      await options.liveLedger.audit.record({
        category: "backup",
        eventName: "backup.restore.failed",
        action: "restore",
        outcome: "failed",
        severity: "ERROR",
        reasonCode,
        actor: options.liveLedger.actorUserId ? { userId: options.liveLedger.actorUserId, role: "admin" } : { role: "system" },
        resource: { type: "backup_archive", ...(options.expectedBackupPublicId ? { publicId: options.expectedBackupPublicId } : {}) },
        correlationId,
      });
    }
    throw new DomainError("CONFLICT", reasonCode, "Archive verification failed; isolated target was not modified.");
  }

  const backupPublicId = verifiedManifest.backupPublicId;
  const expectedConfirmation = expectedRestoreConfirmationText(backupPublicId, options.targetDatabaseName);
  if (options.confirmationText.trim() !== expectedConfirmation) {
    if (options.liveLedger) {
      await options.liveLedger.audit.record({
        category: "backup",
        eventName: "backup.restore.refused",
        action: "restore",
        outcome: "refused",
        severity: "WARN",
        reasonCode: "CONFIRMATION_MISMATCH",
        actor: options.liveLedger.actorUserId ? { userId: options.liveLedger.actorUserId, role: "admin" } : { role: "system" },
        resource: { type: "backup_archive", publicId: backupPublicId },
        correlationId,
      });
    }
    throw validation(
      "CONFIRMATION_MISMATCH",
      `Type the exact confirmation phrase "${expectedConfirmation}" to proceed.`,
    );
  }

  // Record durable restore INTENT before any external target DB / filesystem side effects when live ledger is present!
  let ledgerRowInserted = false;
  if (options.liveLedger && options.liveLedger.archiveId) {
    const ledger = options.liveLedger;
    const archiveId = ledger.archiveId!;
    await ledger.db.transaction(async (tx) => {
      const activeDrills = await tx
        .select({ id: backupRestoreDrills.id, targetDb: backupRestoreDrills.targetDatabaseName })
        .from(backupRestoreDrills)
        .where(inArray(backupRestoreDrills.state, ["queued", "running"]))
        .for("update");
      if (activeDrills.some((d) => d.targetDb.toLowerCase() === options.targetDatabaseName.toLowerCase())) {
        throw conflict("TARGET_DATABASE_LOCKED", "Another restore drill is already running against this target database.");
      }
      await tx.insert(backupRestoreDrills).values({
        publicId: drillPublicId,
        backupId: archiveId,
        state: "running",
        reasonCode: null,
        targetDatabaseName: options.targetDatabaseName,
        continuityMode,
        requestedByUserId: ledger.actorUserId ?? null,
        correlationId,
        createdAt: startedAt,
      });
      await ledger.audit.record(
        {
          category: "backup",
          eventName: "backup.restore.requested",
          action: "restore",
          outcome: "attempted",
          severity: "WARN",
          actor: ledger.actorUserId ? { userId: ledger.actorUserId, role: "admin" } : { role: "system" },
          resource: { type: "backup_archive", publicId: backupPublicId },
          correlationId,
          attributes: {
            target_database: options.targetDatabaseName,
            continuity_mode: continuityMode,
          },
        },
        tx,
      );
      ledgerRowInserted = true;
    });
  }

  let reservedStorage: { canonicalDir: string; markQuarantinedOnFailure: (reasonCode: string) => Promise<void> } | null = null;
  let reservedDb: ReservedIsolatedDatabase | null = null;

  try {
    reservedStorage = await reserveIsolatedStorageDirectory(
      options.targetStorageDir,
      rawLiveStorage,
    );
    reservedDb = await prepareIsolatedTargetDatabase({
      recoveryDatabaseUrl: options.recoveryDatabaseUrl,
      targetDatabaseName: options.targetDatabaseName,
      ...(liveDbUrlForGuard ? { liveDatabaseUrl: liveDbUrlForGuard } : {}),
      enforceTargetScopedGrants: !options.allowSameUserInTestOnly,
    });

    const isolatedStorage = createObjectStorage({
      config: { storageDir: reservedStorage.canonicalDir },
      logger: options.logger,
    });

    // Pass 2: Stream authenticated SQL into isolated database and objects into isolated LocalObjectStorage.
    const pass2Stream = await openStream();
    const pass2Dec = decryptBackupStream(pass2Stream, {
      keyring: options.keyring,
      expectedBackupPublicId: backupPublicId,
    });

    await readAndValidateBackupBundle(pass2Dec.plaintext, {
      onSqlGz: async (gzStream) => {
        await loadSqlGzIntoIsolatedDatabase(reservedDb!.targetDatabaseUrl, gzStream, {
          uncompressedBytes: verifiedManifest.databaseDump.uncompressedBytes,
          uncompressedSha256: verifiedManifest.databaseDump.uncompressedSha256,
        });
      },
      onObject: async (storageKey, objStream) => {
        await isolatedStorage.put(storageKey, Readable.from(objStream));
      },
    });
    pass2Dec.result();

    // Reconcile §7.3 security-state continuity and verify §7.2 semantic integrity.
    const { continuity, integrity } = await reconcileAndVerifyIsolatedRestore({
      ...(continuityMode === "preserve_continuity" && options.liveLedger?.liveDatabaseUrl
        ? { liveDatabaseUrl: options.liveLedger.liveDatabaseUrl }
        : {}),
      targetDatabaseUrl: reservedDb.targetDatabaseUrl,
      isolatedStorage,
      manifest: verifiedManifest,
      continuityMode,
      backupPublicId,
      config: options.config,
      clock: options.clock,
      logger: options.logger,
      crypto: options.crypto,
    });

    if (!integrity.passed) {
      await reservedStorage.markQuarantinedOnFailure("INTEGRITY_CHECK_FAILED");
    }

    // Also record durable `backup.restore.completed` / `backup.restore.failed` inside the restored database itself
    // when operating offline (without liveLedger), so offline bare-metal recovery always has a complete audit trail!
    if (!options.liveLedger && integrity.passed) {
      const targetPool = openValidatedMysqlPool(reservedDb.targetDatabaseUrl, 1);
      try {
        const targetDrizzle = drizzle(targetPool, { mode: "default" }) as unknown as Db;
        const targetAudit = createAuditEmitter({
          config: options.config,
          db: targetDrizzle,
          clock: options.clock,
          logger: options.logger,
          crypto: options.crypto,
        });
        await targetAudit.record({
          category: "backup",
          eventName: "backup.restore.completed",
          action: "restore",
          outcome: "completed",
          severity: "WARN",
          reasonCode: "OFFLINE_ISOLATED_RESTORE_COMPLETED",
          actor: { role: "system" },
          resource: { type: "backup_archive", publicId: backupPublicId },
          correlationId,
          safeCounts: {
            sessions_revoked: continuity.sessionsRevoked,
            tokens_retired: continuity.singleUseTokensRetired,
            objects_checked: integrity.objectsChecked,
          },
          attributes: {
            target_database: options.targetDatabaseName,
            continuity_mode: continuityMode,
            manual_review_required: true,
          },
        });
        if (continuity.auditChainVerified === "verified") {
          const chainService = createChainService({
            db: targetDrizzle,
            clock: options.clock,
            logger: options.logger,
            auditChainKey: options.config.auditChainKey,
            installationId: options.config.installationId,
          });
          await chainService.sealPending({ fullScan: true });
          await chainService.createCheckpoint("offline_restore_completed");
        }
      } finally {
        await targetPool.end().catch(() => {});
      }
    }

    const completedAt = options.clock.now();
    const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());
    const archiveCreatedMs = Date.parse(verifiedManifest.createdAt);
    const achievedDataAgeMs = Number.isFinite(archiveCreatedMs)
      ? Math.max(0, completedAt.getTime() - archiveCreatedMs)
      : null;
    const state: OperationState = integrity.passed ? "completed" : "failed";
    const reasonCode = integrity.passed ? null : "INTEGRITY_CHECK_FAILED";

    if (options.liveLedger) {
      const ledger = options.liveLedger;
      await ledger.db.transaction(async (tx) => {
        if (ledgerRowInserted) {
          await tx
            .update(backupRestoreDrills)
            .set({
              state,
              reasonCode,
              achievedDataAgeMs,
              durationMs,
              continuityReportJson: continuity,
              integrityReportJson: integrity,
              completedAt,
            })
            .where(eq(backupRestoreDrills.publicId, drillPublicId));
        }
        await ledger.audit.record(
          {
            category: "backup",
            eventName: integrity.passed ? "backup.restore.completed" : "backup.restore.failed",
            action: "restore",
            outcome: integrity.passed ? "completed" : "failed",
            severity: integrity.passed ? "INFO" : "ERROR",
            ...(reasonCode ? { reasonCode } : {}),
            actor: ledger.actorUserId ? { userId: ledger.actorUserId, role: "admin" } : { role: "system" },
            resource: { type: "backup_archive", publicId: backupPublicId },
            correlationId,
            durationMs,
            safeCounts: {
              sessions_revoked: continuity.sessionsRevoked,
              tokens_retired: continuity.singleUseTokensRetired,
              objects_checked: integrity.objectsChecked,
              tables_checked: integrity.tablesChecked,
            },
            attributes: {
              target_database: options.targetDatabaseName,
              continuity_mode: continuityMode,
              audit_chain: continuity.auditChainVerified,
            },
          },
          tx,
        );
      });
    }

    if (!integrity.passed) {
      throw new DomainError(
        "CONFLICT",
        "INTEGRITY_CHECK_FAILED",
        "Isolated restore completed extraction, but post-restore semantic integrity reconciliation failed.",
      );
    }

    return {
      drillPublicId,
      backupPublicId,
      state,
      reasonCode,
      targetDatabaseName: options.targetDatabaseName,
      targetStorageDir: reservedStorage.canonicalDir,
      continuityMode,
      achievedDataAgeMs,
      durationMs,
      manualAccountReviewRequired: true,
      continuity,
      integrity,
      createdAt: startedAt,
      completedAt,
    };
  } catch (error) {
    const reasonCode = error instanceof DomainError ? error.reasonCode : "RESTORE_EXECUTION_FAILED";
    await reservedStorage?.markQuarantinedOnFailure(reasonCode);

    if (options.liveLedger) {
      const ledger = options.liveLedger;
      const failedAt = options.clock.now();
      await ledger.db
        .transaction(async (tx) => {
          if (ledgerRowInserted) {
            await tx
              .update(backupRestoreDrills)
              .set({
                state: "failed",
                reasonCode,
                durationMs: Math.max(0, failedAt.getTime() - startedAt.getTime()),
                completedAt: failedAt,
              })
              .where(eq(backupRestoreDrills.publicId, drillPublicId));
          }
          await ledger.audit.record(
            {
              category: "backup",
              eventName:
                reasonCode.includes("REFUSED") || reasonCode.includes("OVERLAP") || reasonCode.includes("PRIVILEGE")
                  ? "backup.restore.refused"
                  : "backup.restore.failed",
              action: "restore",
              outcome:
                reasonCode.includes("REFUSED") || reasonCode.includes("OVERLAP") || reasonCode.includes("PRIVILEGE")
                  ? "refused"
                  : "failed",
              severity: "ERROR",
              reasonCode,
              actor: ledger.actorUserId ? { userId: ledger.actorUserId, role: "admin" } : { role: "system" },
              resource: { type: "backup_archive", publicId: backupPublicId },
              correlationId,
            },
            tx,
          );
        })
        .catch(() => {});
    }
    throw error;
  } finally {
    await reservedDb?.release();
  }
}
