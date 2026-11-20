/**
 * Operator CLI — Cryptographically authenticate and semantically verify an encrypted backup archive.
 *
 * Usage:
 *   # Online (from portal storage + ledger):
 *   tsx scripts/ops/backup/verify-backup.ts --backup-id <BACKUP_PUBLIC_ID>
 *
 *   # Offline (standalone `.rpbk` file + RP_BACKUP_KEY_FILE — zero live DB required):
 *   tsx scripts/ops/backup/verify-backup.ts --archive-file <ABSOLUTE_PATH_TO_.rpbk> [--backup-id <EXPECTED_ID>]
 *
 * Re-reads every encrypted chunk, verifies AES-256-GCM tags, chunk sequence, finality flag, uncompressed SQL
 * SHA-256 + dump markers, every bundled object SHA-256/size, manifest integrity, and required key IDs.
 * Exit codes: 0 verified · 78 configuration/missing key · 1 verification failed.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { CryptoError, DomainError, validation } from "../../../server/core/errors.js";
import { openRegularFileNoFollow } from "../../../server/modules/backup/archiveFile.js";
import { readAndValidateBackupBundle } from "../../../server/modules/backup/bundle.js";
import { decryptBackupStream } from "../../../server/modules/backup/crypto.js";
import { resolveBackupKeyring } from "../../../server/modules/backup/keys.js";
import { assertNoSecretsInArgv, handleCliError, withBackupCliRuntime } from "./_runtime.js";

interface VerifyCliArgs {
  backupId: string | null;
  archiveFilePath: string | null;
}

function parseVerifyArgs(argv: readonly string[]): VerifyCliArgs {
  assertNoSecretsInArgv(argv);
  let backupId: string | null = null;
  let archiveFilePath: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = String(argv[i + 1] ?? "");
    if (flag === "--backup-id") {
      backupId = next;
      i += 1;
    } else if (flag === "--archive-file") {
      archiveFilePath = path.resolve(next);
      i += 1;
    } else {
      throw validation(
        "INVALID_CLI_ARGS",
        "Usage: verify-backup.ts (--backup-id <ID> | --archive-file <PATH.rpbk> [--backup-id <ID>])",
      );
    }
  }
  if (!backupId && !archiveFilePath) {
    throw validation("MISSING_CLI_ARGS", "Specify --backup-id <ID> or --archive-file <PATH.rpbk>.");
  }
  if (backupId && !/^[A-Za-z0-9_-]{10,64}$/.test(backupId)) {
    throw validation("INVALID_BACKUP_ID", "A valid --backup-id ULID is required.");
  }
  return { backupId, archiveFilePath };
}

async function verifyOfflineFile(filePath: string, expectedBackupId: string | null): Promise<number> {
  const startedMs = Date.now();
  const keyring = await resolveBackupKeyring(null, { env: process.env });
  if (!keyring) {
    throw new DomainError("NOT_CONFIGURED", "BACKUP_KEY_MISSING", "Set RP_BACKUP_KEY_FILE (0600) or RP_BACKUP_KEY.");
  }

  const fh = await openRegularFileNoFollow(filePath, "Archive path must exist and be a regular file.");
  const fileStream = createReadStream("", { fd: fh.fd, autoClose: true });
  const decryptor = decryptBackupStream(fileStream, {
    keyring,
    ...(expectedBackupId ? { expectedBackupPublicId: expectedBackupId } : {}),
  });

  let sqlBytes = 0;
  let sqlSha = "";
  let validMarkers = false;
  const parsed = await readAndValidateBackupBundle(decryptor.plaintext, {
    onSqlGz: async (gzStream) => {
      const h = createHash("sha256");
      let head = "";
      let tail = "";
      const sink = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          sqlBytes += chunk.length;
          h.update(chunk);
          const s = chunk.toString("utf8");
          if (head.length < 512) head += s.slice(0, 512 - head.length);
          tail = (tail + s).slice(-512);
          cb();
        },
      });
      await pipeline(Readable.from(gzStream), createGunzip(), sink);
      sqlSha = h.digest("hex");
      validMarkers = head.includes("MySQL dump") && tail.includes("Dump completed");
    },
  });
  const decStats = decryptor.result();
  if (
    !validMarkers ||
    sqlBytes !== parsed.manifest.databaseDump.uncompressedBytes ||
    sqlSha !== parsed.manifest.databaseDump.uncompressedSha256
  ) {
    throw new CryptoError("TAMPERED");
  }

  console.log(
    JSON.stringify({
      ok: true,
      operation: "backup.verify",
      mode: "offline_archive",
      backupPublicId: parsed.manifest.backupPublicId,
      archiveSha256: decStats.archiveSha256,
      authenticatedBytes: decStats.authenticatedBytes,
      chunksVerified: decStats.chunksVerified,
      sqlSha256Matched: true,
      objectsVerified: parsed.objectsRead.size,
      manifestValid: true,
      requiredBackupKeyId: parsed.manifest.requiredKeys.backupKeyId,
      requiredDataKeyIds: parsed.manifest.requiredKeys.dataKeyringAllIds,
      durationMs: Math.max(0, Date.now() - startedMs),
    }),
  );
  return 0;
}

async function main(): Promise<number> {
  try {
    const args = parseVerifyArgs(process.argv.slice(2));
    if (args.archiveFilePath) {
      return await verifyOfflineFile(args.archiveFilePath, args.backupId);
    }
    return await withBackupCliRuntime(async (backup) => {
      const result = await backup.verifyBackupDirect(args.backupId!);
      if (result.state !== "completed") {
        throw new DomainError("CONFLICT", result.reasonCode ?? "VERIFY_FAILED", "Archive verification failed.");
      }
      console.log(
        JSON.stringify({
          ok: true,
          operation: "backup.verify",
          mode: "live_ledger",
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
    if (error instanceof CryptoError) {
      return handleCliError(
        "backup.verify",
        new DomainError("CONFLICT", `ARCHIVE_${error.reasonCode}`, "Archive failed cryptographic verification."),
      );
    }
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
