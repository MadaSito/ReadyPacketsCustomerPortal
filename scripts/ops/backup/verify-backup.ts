/**
 * Operator CLI — Cryptographically authenticate and semantically verify an encrypted backup archive.
 *
 * Usage:
 *   tsx scripts/ops/backup/verify-backup.ts --backup-id <BACKUP_PUBLIC_ID>
 *
 * Re-reads every encrypted chunk, verifies AES-256-GCM tags, chunk sequence, finality flag, uncompressed SQL
 * SHA-256, every bundled object SHA-256/size, manifest integrity, and required key IDs.
 * Exit codes: 0 verified · 78 configuration/missing key · 1 verification failed.
 */
import { DomainError, validation } from "../../../server/core/errors.js";
import { assertNoSecretsInArgv, handleCliError, withBackupCliRuntime } from "./_runtime.js";

function parseBackupId(argv: readonly string[]): string {
  assertNoSecretsInArgv(argv);
  let backupId = "";
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--backup-id") {
      backupId = String(argv[i + 1] ?? "");
      i += 1;
    } else {
      throw validation("INVALID_CLI_ARGS", "Usage: verify-backup.ts --backup-id <BACKUP_PUBLIC_ID>");
    }
  }
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(backupId)) {
    throw validation("INVALID_BACKUP_ID", "A valid --backup-id ULID is required.");
  }
  return backupId;
}

async function main(): Promise<number> {
  try {
    const backupId = parseBackupId(process.argv.slice(2));
    return await withBackupCliRuntime(async (backup) => {
      const result = await backup.verifyBackupDirect(backupId);
      if (result.state !== "completed") {
        throw new DomainError("CONFLICT", result.reasonCode ?? "VERIFY_FAILED", "Archive verification failed.");
      }
      console.log(
        JSON.stringify({
          ok: true,
          operation: "backup.verify",
          backupPublicId: result.backupPublicId,
          verificationPublicId: result.publicId,
          state: result.state,
          authenticatedBytes: result.authenticatedBytes,
          chunksVerified: result.chunksVerified,
          sqlSha256Matched: result.sqlSha256Matched,
          objectsVerified: result.objectsVerified,
          manifestValid: result.manifestValid,
          keyReadiness: result.keyReadiness,
          missingDataKeyIds: result.missingDataKeyIds,
          durationMs: result.durationMs,
        }),
      );
      return 0;
    });
  } catch (error) {
    return handleCliError("backup.verify", error);
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
