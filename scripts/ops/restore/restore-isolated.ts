/**
 * Operator CLI — Restore an encrypted backup ONLY into an isolated empty database and empty storage directory,
 * then execute §7.3 security-state continuity reconciliation and post-restore semantic integrity checks.
 *
 * Usage:
 *   tsx scripts/ops/restore/restore-isolated.ts \
 *     --backup-id <BACKUP_PUBLIC_ID> \
 *     --target-db <ISOLATED_DB_NAME> \
 *     --target-storage <ABSOLUTE_EMPTY_STORAGE_DIR> \
 *     --confirm "RESTORE <BACKUP_PUBLIC_ID> TO <ISOLATED_DB_NAME>" \
 *     [--continuity-mode preserve_continuity|quarantine_credentials]
 *
 * Refuses to overwrite the live database or live storage directory. Never accepts secrets on `argv`.
 * Exit codes: 0 completed & verified · 78 configuration · 1 refused or integrity failed.
 */
import { validation } from "../../../server/core/errors.js";
import type { ContinuityMode } from "../../../server/modules/backup/schema.js";
import { assertNoSecretsInArgv, handleCliError, withBackupCliRuntime } from "../backup/_runtime.js";

interface RestoreCliArgs {
  backupPublicId: string;
  targetDatabaseName: string;
  targetStorageDir: string;
  confirmationText: string;
  continuityMode: ContinuityMode;
}

function parseRestoreArgs(argv: readonly string[]): RestoreCliArgs {
  assertNoSecretsInArgv(argv);
  let backupPublicId = "";
  let targetDatabaseName = "";
  let targetStorageDir = "";
  let confirmationText = "";
  let continuityMode: ContinuityMode = "preserve_continuity";

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = String(argv[i + 1] ?? "");
    if (flag === "--backup-id") {
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
        throw validation("INVALID_CONTINUITY_MODE", "Continuity mode must be preserve_continuity or quarantine_credentials.");
      }
      continuityMode = next;
      i += 1;
    } else {
      throw validation("INVALID_CLI_ARGS", "Unrecognized argument supplied to restore-isolated.ts.");
    }
  }

  if (!backupPublicId || !targetDatabaseName || !targetStorageDir || !confirmationText) {
    throw validation(
      "MISSING_CLI_ARGS",
      "Required flags: --backup-id, --target-db, --target-storage, --confirm.",
    );
  }
  return {
    backupPublicId,
    targetDatabaseName,
    targetStorageDir,
    confirmationText,
    continuityMode,
  };
}

async function main(): Promise<number> {
  try {
    const args = parseRestoreArgs(process.argv.slice(2));
    return await withBackupCliRuntime(async (backup) => {
      const drill = await backup.restoreToIsolatedTargetDirect(args);
      console.log(
        JSON.stringify({
          ok: drill.state === "completed",
          operation: "backup.restore_isolated",
          drillPublicId: drill.publicId,
          backupPublicId: drill.backupPublicId,
          targetDatabaseName: drill.targetDatabaseName,
          continuityMode: drill.continuityMode,
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

main().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.exitCode = 1;
  },
);
