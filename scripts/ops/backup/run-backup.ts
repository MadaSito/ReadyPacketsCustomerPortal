/**
 * Operator CLI — Run an encrypted logical database + private-object backup immediately.
 *
 * Usage:
 *   tsx scripts/ops/backup/run-backup.ts [--trigger cli|pre_upgrade] [--verify]
 *
 * Reads configuration & secrets strictly from environment / 0600 `*_FILE` files (`RP_BACKUP_KEY_FILE`).
 * Refuses (exit 78) if no backup encryption key is configured — there is no plaintext mode.
 * Exit codes: 0 completed · 78 configuration/missing key · 1 backup or verification failed.
 */
import type { BackupTrigger } from "../../../server/modules/backup/schema.js";
import { assertNoSecretsInArgv, handleCliError, withBackupCliRuntime } from "./_runtime.js";

interface ParsedArgs {
  trigger: Extract<BackupTrigger, "cli" | "pre_upgrade">;
  verify: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  assertNoSecretsInArgv(argv);
  let trigger: ParsedArgs["trigger"] = "cli";
  let verify = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--verify") {
      verify = true;
    } else if (arg === "--trigger") {
      const val = argv[i + 1];
      i += 1;
      if (val !== "cli" && val !== "pre_upgrade") {
        throw new Error("Invalid --trigger value; expected 'cli' or 'pre_upgrade'.");
      }
      trigger = val;
    } else {
      throw new Error("Unknown CLI argument.");
    }
  }
  return { trigger, verify };
}

async function main(): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    return handleCliError("backup.run", error);
  }

  try {
    return await withBackupCliRuntime(async (backup) => {
      const archive = await backup.runBackupDirect({ trigger: args.trigger });
      let verification = null;
      if (args.verify) {
        verification = await backup.verifyBackupDirect(archive.publicId);
      }
      console.log(
        JSON.stringify({
          ok: true,
          operation: "backup.run",
          backupPublicId: archive.publicId,
          state: archive.state,
          trigger: archive.trigger,
          encryptedSizeBytes: archive.encryptedSizeBytes,
          archiveSha256: archive.archiveSha256,
          backupKeyId: archive.backupKeyId,
          keyCustodyMode: archive.keyCustodyMode,
          objectCount: archive.objectCount,
          offHostCopyStatus: archive.offHostCopyStatus,
          offHostNotice: "local_only_not_independent_copy",
          verification: verification
            ? {
                verificationPublicId: verification.publicId,
                state: verification.state,
                authenticatedBytes: verification.authenticatedBytes,
                objectsVerified: verification.objectsVerified,
                keyReadiness: verification.keyReadiness,
              }
            : null,
        }),
      );
      return 0;
    });
  } catch (error) {
    return handleCliError("backup.run", error);
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
