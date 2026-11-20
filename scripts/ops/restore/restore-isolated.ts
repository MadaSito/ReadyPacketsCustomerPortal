/**
 * Operator CLI — Restore an encrypted `.rpbk` backup ONLY into an explicitly named isolated database and empty
 * storage directory using dedicated operator/recovery MySQL credentials (`RP_RECOVERY_DATABASE_URL_FILE`), then
 * execute §7.3 security-state continuity reconciliation and §7.2 post-restore semantic integrity verification.
 *
 * Canonical offline / bare-metal & drill usage:
 *   RP_RECOVERY_DATABASE_URL_FILE=/etc/readypackets/secrets/recovery_database_url \
 *   RP_BACKUP_KEY_FILE=/etc/readypackets/secrets/backup_key \
 *   RP_AUDIT_CHAIN_KEY_FILE=/etc/readypackets/secrets/audit_chain_key \
 *   pnpm tsx scripts/ops/restore/restore-isolated.ts \
 *     --archive-file <PATH_TO_DOWNLOADED_OR_STORED_.rpbk> \
 *     --target-db rp_restore_<YYYYMMDD> \
 *     --target-storage /var/lib/readypackets-recovery/restore-<YYYYMMDD> \
 *     --confirm "RESTORE <BACKUP_PUBLIC_ID> TO rp_restore_<YYYYMMDD>" \
 *     [--continuity-mode quarantine_credentials|preserve_continuity] \
 *     [--record-drill]
 *
 * Security invariants:
 *  - Web-initiated restore does NOT exist; this operator CLI is the sole restore path.
 *  - Requires dedicated operator credentials (`RP_RECOVERY_DATABASE_URL` or `RP_RECOVERY_DATABASE_URL_FILE`).
 *    Refuses reusing the live application's database user or write-capable live-schema grants.
 *  - Works 100% offline from `--archive-file` + host key files when the live database and live storage are gone.
 *  - Defaults to `quarantine_credentials` (zero live-DB connection), revokes ALL sessions, invalidates all
 *    single-use tokens/tickets/challenges, quarantines outbound jobs/mail, and verifies + checkpoints `audit_chain`.
 *  - Operators MUST review accounts changed since the backup (status, role, password, MFA) before cutover.
 *  - Exit codes: 0 completed & verified · 78 configuration/missing recovery credentials · 1 refused or failed.
 */
import path from "node:path";
import { readSecretEnv } from "../../../server/config/env.js";
import { systemClock } from "../../../server/core/clock.js";
import { DomainError, validation } from "../../../server/core/errors.js";
import { newRequestContext, runWithRequestContext } from "../../../server/core/requestContext.js";
import { executeIsolatedCliRestore } from "../../../server/modules/backup/index.js";
import { resolveBackupKeyring } from "../../../server/modules/backup/keys.js";
import type { ContinuityMode } from "../../../server/modules/backup/schema.js";
import { createLogger } from "../../../server/observability/logger.js";
import { createFieldCrypto } from "../../../server/security/fieldCrypto.js";
import {
  assertNoSecretsInArgv,
  handleCliError,
  loadOfflineRecoveryConfig,
  withBackupCliRuntime,
} from "../backup/_runtime.js";

interface RestoreCliArgs {
  archiveFilePath: string | null;
  backupPublicId: string | null;
  targetDatabaseName: string;
  targetStorageDir: string;
  confirmationText: string;
  continuityMode: ContinuityMode;
  recordDrillInLiveDb: boolean;
}

function parseRestoreArgs(argv: readonly string[]): RestoreCliArgs {
  assertNoSecretsInArgv(argv);
  let archiveFilePath: string | null = null;
  let backupPublicId: string | null = null;
  let targetDatabaseName = "";
  let targetStorageDir = "";
  let confirmationText = "";
  let continuityMode: ContinuityMode = "quarantine_credentials";
  let recordDrillInLiveDb = false;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--record-drill") {
      recordDrillInLiveDb = true;
      continue;
    }
    const next = String(argv[i + 1] ?? "");
    if (flag === "--archive-file") {
      archiveFilePath = path.resolve(next);
      i += 1;
    } else if (flag === "--backup-id") {
      backupPublicId = next;
      i += 1;
    } else if (flag === "--target-db") {
      targetDatabaseName = next;
      i += 1;
    } else if (flag === "--target-storage") {
      targetStorageDir = next;
      i += 1;
    } else if (flag === "--confirm") {
      confirmationText = next;
      i += 1;
    } else if (flag === "--continuity-mode") {
      if (next !== "preserve_continuity" && next !== "quarantine_credentials") {
        throw validation(
          "INVALID_CONTINUITY_MODE",
          "Continuity mode must be quarantine_credentials or preserve_continuity.",
        );
      }
      continuityMode = next;
      i += 1;
    } else {
      throw validation("INVALID_CLI_ARGS", "Unrecognized argument supplied to restore-isolated.ts.");
    }
  }

  if ((!archiveFilePath && !backupPublicId) || !targetDatabaseName || !targetStorageDir || !confirmationText) {
    throw validation(
      "MISSING_CLI_ARGS",
      "Required flags: (--archive-file <path.rpbk> | --backup-id <id>), --target-db, --target-storage, --confirm.",
    );
  }
  return {
    archiveFilePath,
    backupPublicId,
    targetDatabaseName,
    targetStorageDir,
    confirmationText,
    continuityMode,
    recordDrillInLiveDb,
  };
}

async function main(): Promise<number> {
  try {
    const args = parseRestoreArgs(process.argv.slice(2));
    const recoveryDatabaseUrl = readSecretEnv("RP_RECOVERY_DATABASE_URL", process.env);
    if (!recoveryDatabaseUrl) {
      throw new DomainError(
        "NOT_CONFIGURED",
        "RECOVERY_CREDENTIALS_REQUIRED",
        "Set RP_RECOVERY_DATABASE_URL_FILE (0600) or RP_RECOVERY_DATABASE_URL with dedicated operator recovery MySQL credentials.",
      );
    }

    // Path A: Pure offline / standalone restore from `--archive-file` when neither `--record-drill` nor
    // `preserve_continuity` requires live-DB access. Works even when live DB and live storage are completely gone!
    if (args.archiveFilePath && !args.recordDrillInLiveDb && args.continuityMode === "quarantine_credentials") {
      const { config, detectedLiveDatabaseUrl, detectedLiveStorageDir } = loadOfflineRecoveryConfig(
        process.env,
        recoveryDatabaseUrl,
        args.targetStorageDir,
      );
      const logger = createLogger(config, { component: "ops.restore.offline_cli" });
      const crypto = createFieldCrypto(config);
      const keyring = await resolveBackupKeyring(null, { env: process.env });
      if (!keyring) {
        throw new DomainError(
          "NOT_CONFIGURED",
          "BACKUP_KEY_MISSING",
          "Offline restore requires RP_BACKUP_KEY_FILE (0600) or RP_BACKUP_KEY.",
        );
      }

      const result = await runWithRequestContext(newRequestContext("cli"), () =>
        executeIsolatedCliRestore({
          archiveFilePath: args.archiveFilePath!,
          ...(args.backupPublicId ? { expectedBackupPublicId: args.backupPublicId } : {}),
          recoveryDatabaseUrl,
          targetDatabaseName: args.targetDatabaseName,
          targetStorageDir: args.targetStorageDir,
          confirmationText: args.confirmationText,
          continuityMode: "quarantine_credentials",
          keyring,
          config,
          clock: systemClock,
          logger,
          crypto,
          ...(detectedLiveDatabaseUrl ? { guardLiveDatabaseUrl: detectedLiveDatabaseUrl } : {}),
          ...(detectedLiveStorageDir ? { guardLiveStorageDir: detectedLiveStorageDir } : {}),
        }),
      );

      console.log(
        JSON.stringify({
          ok: result.state === "completed",
          operation: "backup.restore_isolated",
          mode: "offline_archive",
          drillPublicId: result.drillPublicId,
          backupPublicId: result.backupPublicId,
          targetDatabaseName: result.targetDatabaseName,
          targetStorageDir: result.targetStorageDir,
          continuityMode: result.continuityMode,
          manualAccountReviewRequired: true,
          achievedDataAgeMs: result.achievedDataAgeMs,
          durationMs: result.durationMs,
          continuity: result.continuity,
          integrity: result.integrity,
        }),
      );
      return result.state === "completed" ? 0 : 1;
    }

    // Path B: Live-ledger restore drill (`--backup-id` or `--record-drill` or `--continuity-mode preserve_continuity`)
    return await withBackupCliRuntime(async (backup) => {
      const drill = await backup.restoreToIsolatedTargetDirect({
        backupPublicId: args.backupPublicId ?? extractBackupIdFromConfirmation(args.confirmationText),
        ...(args.archiveFilePath ? { archiveFilePath: args.archiveFilePath } : {}),
        recoveryDatabaseUrl,
        targetDatabaseName: args.targetDatabaseName,
        targetStorageDir: args.targetStorageDir,
        continuityMode: args.continuityMode,
        confirmationText: args.confirmationText,
      });
      console.log(
        JSON.stringify({
          ok: drill.state === "completed",
          operation: "backup.restore_isolated",
          mode: "live_ledger_drill",
          drillPublicId: drill.publicId,
          backupPublicId: drill.backupPublicId,
          targetDatabaseName: drill.targetDatabaseName,
          continuityMode: drill.continuityMode,
          manualAccountReviewRequired: true,
          achievedDataAgeMs: drill.achievedDataAgeMs,
          durationMs: drill.durationMs,
          continuity: drill.continuity,
          integrity: drill.integrity,
        }),
      );
      return drill.state === "completed" ? 0 : 1;
    });
  } catch (error) {
    return handleCliError("backup.restore_isolated", error);
  }
}

function extractBackupIdFromConfirmation(confirmationText: string): string {
  const m = /^RESTORE\s+([A-Za-z0-9_-]{10,64})\s+TO\s+/.exec(confirmationText.trim());
  if (!m?.[1]) {
    throw validation(
      "CONFIRMATION_MISMATCH",
      'Confirmation text must follow "RESTORE <BACKUP_PUBLIC_ID> TO <TARGET_DB>".',
    );
  }
  return m[1];
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.exitCode = 1;
  },
);
