/**
 * Architecture §7.3 Security-state continuity reconciliation and §7.2 post-restore semantic verification.
 *
 * Executed exclusively against the isolated target database and isolated target storage directory
 * immediately after SQL and object streams are loaded.
 *
 * Guarantees enforced on the isolated target:
 *  1. Sessions: every row in `user_sessions` is revoked (`revoked_at` set, `revoke_reason = 'restored_from_backup'`).
 *  2. Single-use tokens: every unconsumed row in `identity_tokens` is retired (`consumed_at` set, `retired_reason = 'restored_from_backup'`).
 *  3. Ephemeral challenges & tickets: `assurance_challenges` and `file_download_tickets` are deleted;
 *     `pending_totp_secret_enc`, `pending_totp_session_id`, `pending_totp_expires_at` on `assurance_accounts` are cleared.
 *  4. TOTP anti-replay watermark: `assurance_accounts.last_totp_step` is raised to at least `floor(restoreTime / 30)`
 *     AND (in `preserve_continuity` mode) `GREATEST(..., live.last_totp_step)` matched by `users.public_id`.
 *  5. Passkey counters & spent recovery codes: in `preserve_continuity` mode, `assurance_passkeys.counter` is raised to
 *     `GREATEST(counter, live.counter)` and any recovery code spent or superseded in the live DB is marked spent in target;
 *     in `quarantine_credentials` mode (when live continuity cannot be trusted), historical passwords, TOTP secrets,
 *     recovery codes, and passkeys are cleared and accounts placed in `pending_activation` / `must_change_password`.
 *  6. Rate-limit state: expired windows in `http_rate_limit_counters` are pruned, and active live windows are forward-merged
 *     (`GREATEST(hits, live.hits)`) so active lockouts/throttles are never rewound.
 *  7. Jobs & external providers quarantine: queued/running `job_runs` and `mail_outbox` rows are canceled
 *     (`RESTORE_QUARANTINED`), and external provider feature flags / `siem_destinations` are disabled until reviewed.
 *  8. Audit chain verification & marker: verifies the restored `audit_chain` HMAC-SHA256 links against `auditChainKey`
 *     and appends a durable `"backup.restore.continuity_marker"` event to the restored `audit_events` table.
 */
import { createHmac, hkdfSync } from "node:crypto";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import type { AppConfig } from "../../config/env.js";
import type { Clock, FieldCrypto, Logger, ObjectStorage } from "../../core/types.js";
import { decodeKey } from "../../config/env.js";
import { createAuditEmitter } from "../audit/emitter.js";
import type { BackupManifest } from "./bundle.js";
import { inspectDatabaseSnapshot } from "./mysqlCli.js";
import type { ContinuityMode, StoredContinuityReport, StoredIntegrityReport } from "./schema.js";

function computeAuditMac(hmacKey: Buffer, input: string): string {
  return createHmac("sha256", hmacKey).update(input, "utf8").digest("hex");
}

async function verifyRestoredAuditChain(
  targetConn: mysql.Connection,
  tableSet: ReadonlySet<string>,
  config: AppConfig,
): Promise<"verified" | "failed" | "not_present"> {
  if (!tableSet.has("audit_chain")) {
    return "not_present";
  }
  const [rows] = await targetConn.query(
    "SELECT seq, event_digest AS eventDigest, prev_hash AS prevHash, link_hash AS linkHash FROM `audit_chain` ORDER BY seq ASC",
  );
  const links = rows as { seq: number | string; eventDigest: string; prevHash: string; linkHash: string }[];
  if (links.length === 0) {
    return "verified";
  }
  const rawKey = decodeKey(config.auditChainKey);
  const hmacKey = Buffer.from(
    hkdfSync("sha256", rawKey, Buffer.from(config.installationId), Buffer.from("rp.audit.chain.hmac/1"), 32),
  );
  try {
    let expectedSeq = 1;
    let expectedPrev = computeAuditMac(hmacKey, `rp.audit.chain/1|genesis|${config.installationId}`);
    for (const row of links) {
      const seq = Number(row.seq);
      if (seq !== expectedSeq || row.prevHash !== expectedPrev) {
        return "failed";
      }
      const computed = computeAuditMac(
        hmacKey,
        `rp.audit.chain/1|${String(seq)}|${row.prevHash}|${row.eventDigest}`,
      );
      if (computed !== row.linkHash) {
        return "failed";
      }
      expectedSeq += 1;
      expectedPrev = row.linkHash;
    }
    if (tableSet.has("audit_chain_head")) {
      const [headRows] = await targetConn.query(
        "SELECT head_seq AS headSeq, head_hash AS headHash FROM `audit_chain_head` WHERE id = 1",
      );
      const head = (headRows as { headSeq: number | string; headHash: string }[])[0];
      if (head && (Number(head.headSeq) !== links.length || head.headHash !== expectedPrev)) {
        return "failed";
      }
    }
    return "verified";
  } finally {
    rawKey.fill(0);
    hmacKey.fill(0);
  }
}

export async function reconcileAndVerifyIsolatedRestore(options: {
  liveDatabaseUrl: string;
  targetDatabaseUrl: string;
  isolatedStorage: ObjectStorage;
  manifest: BackupManifest;
  continuityMode: ContinuityMode;
  backupPublicId: string;
  config: AppConfig;
  clock: Clock;
  logger: Logger;
  crypto: FieldCrypto;
}): Promise<{
  continuity: StoredContinuityReport;
  integrity: StoredIntegrityReport;
}> {
  const now = options.clock.now();
  const minTotpStep = Math.floor(now.getTime() / 30_000);

  const targetPool = mysql.createPool({
    uri: options.targetDatabaseUrl,
    connectionLimit: 2,
    timezone: "Z",
    supportBigNumbers: true,
    charset: "utf8mb4",
  });
  const liveConn = await mysql.createConnection({
    uri: options.liveDatabaseUrl,
    multipleStatements: false,
    timezone: "Z",
    supportBigNumbers: true,
  });

  /** Track intentional row-count deltas made by continuity reconciliation so row-count verification stays exact. */
  const expectedRowDeltas = new Map<string, number>();
  const addDelta = (table: string, delta: number) => {
    expectedRowDeltas.set(table, (expectedRowDeltas.get(table) ?? 0) + delta);
  };

  try {
    const targetConn = await targetPool.getConnection();
    let sessionsRevoked = 0;
    let singleUseTokensRetired = 0;
    let ephemeralChallengesCleared = 0;
    let downloadTicketsCleared = 0;
    let totpWatermarksAdvanced = 0;
    let passkeyCountersReconciled = 0;
    let recoveryCodesReconciled = 0;
    let queuedJobsQuarantined = 0;
    let queuedMailQuarantined = 0;
    let externalFlagsDisabled = 0;
    let auditChainVerified: "verified" | "failed" | "not_present" = "not_present";
    let auditContinuityMarkerAppended = false;

    try {
      const targetDbName = new URL(options.targetDatabaseUrl).pathname.replace(/^\//, "");
      const [tblRows] = await targetConn.query(
        "SELECT TABLE_NAME AS tableName FROM information_schema.tables WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'",
        [decodeURIComponent(targetDbName)],
      );
      const tableSet = new Set((tblRows as { tableName: string }[]).map((r) => r.tableName));

      const liveDbName = decodeURIComponent(new URL(options.liveDatabaseUrl).pathname.replace(/^\//, ""));
      const [liveTblRows] = await liveConn.query(
        "SELECT TABLE_NAME AS tableName FROM information_schema.tables WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'",
        [liveDbName],
      );
      const liveTableSet = new Set((liveTblRows as { tableName: string }[]).map((r) => r.tableName));

      // 1. Verify restored audit chain BEFORE appending continuity marker
      auditChainVerified = await verifyRestoredAuditChain(targetConn, tableSet, options.config);

      // 2. Revoke all restored sessions
      if (tableSet.has("user_sessions")) {
        const [res] = await targetConn.execute(
          "UPDATE `user_sessions` SET revoked_at = COALESCE(revoked_at, ?), revoke_reason = COALESCE(revoke_reason, 'restored_from_backup') WHERE revoked_at IS NULL",
          [now],
        );
        sessionsRevoked = (res as mysql.ResultSetHeader).affectedRows;
      }

      // 3. Retire all unconsumed single-use identity tokens
      if (tableSet.has("identity_tokens")) {
        const [res] = await targetConn.execute(
          "UPDATE `identity_tokens` SET consumed_at = ?, retired_reason = 'restored_from_backup' WHERE consumed_at IS NULL",
          [now],
        );
        singleUseTokensRetired = (res as mysql.ResultSetHeader).affectedRows;
      }

      // 4. Delete ephemeral MFA/WebAuthn challenges and single-use file download tickets
      if (tableSet.has("assurance_challenges")) {
        const [res] = await targetConn.execute("DELETE FROM `assurance_challenges`");
        ephemeralChallengesCleared = (res as mysql.ResultSetHeader).affectedRows;
        addDelta("assurance_challenges", -ephemeralChallengesCleared);
      }
      if (tableSet.has("file_download_tickets")) {
        const [res] = await targetConn.execute("DELETE FROM `file_download_tickets`");
        downloadTicketsCleared = (res as mysql.ResultSetHeader).affectedRows;
        addDelta("file_download_tickets", -downloadTicketsCleared);
      }

      // 5. Clear pending TOTP enrollments and reconcile MFA / credential continuity
      if (options.continuityMode === "quarantine_credentials") {
        // Untrusted continuity: disable historical passwords, TOTP, recovery codes, and passkeys
        if (tableSet.has("users")) {
          await targetConn.execute(
            "UPDATE `users` SET password_hash = NULL, must_change_password = 1, status = CASE WHEN status = 'active' THEN 'pending_activation' ELSE status END, status_reason_code = 'RESTORE_QUARANTINE', status_changed_at = ?",
            [now],
          );
        }
        if (tableSet.has("assurance_accounts")) {
          const [res] = await targetConn.execute(
            "UPDATE `assurance_accounts` SET totp_secret_enc = NULL, pending_totp_secret_enc = NULL, pending_totp_session_id = NULL, pending_totp_expires_at = NULL, recovery_set_id = NULL, recovery_acknowledged_at = NULL, last_totp_step = GREATEST(COALESCE(last_totp_step, 0), ?)",
            [minTotpStep],
          );
          totpWatermarksAdvanced = (res as mysql.ResultSetHeader).affectedRows;
        }
        if (tableSet.has("assurance_recovery_codes")) {
          const [res] = await targetConn.execute(
            "UPDATE `assurance_recovery_codes` SET used_at = COALESCE(used_at, ?) WHERE used_at IS NULL",
            [now],
          );
          recoveryCodesReconciled = (res as mysql.ResultSetHeader).affectedRows;
        }
        if (tableSet.has("assurance_passkeys")) {
          const [res] = await targetConn.execute("DELETE FROM `assurance_passkeys`");
          passkeyCountersReconciled = (res as mysql.ResultSetHeader).affectedRows;
          addDelta("assurance_passkeys", -passkeyCountersReconciled);
        }
      } else {
        // `preserve_continuity`: advance watermarks monotonically from clock + live ledger
        if (tableSet.has("assurance_accounts")) {
          await targetConn.execute(
            "UPDATE `assurance_accounts` SET pending_totp_secret_enc = NULL, pending_totp_session_id = NULL, pending_totp_expires_at = NULL",
          );
          const [stepRes] = await targetConn.execute(
            "UPDATE `assurance_accounts` SET last_totp_step = GREATEST(COALESCE(last_totp_step, 0), ?) WHERE COALESCE(last_totp_step, 0) < ?",
            [minTotpStep, minTotpStep],
          );
          totpWatermarksAdvanced += (stepRes as mysql.ResultSetHeader).affectedRows;

          if (tableSet.has("users") && liveTableSet.has("users") && liveTableSet.has("assurance_accounts")) {
            const [liveSteps] = await liveConn.query(
              "SELECT u.public_id AS userPublicId, a.last_totp_step AS lastTotpStep, a.recovery_set_id AS recoverySetId FROM `assurance_accounts` a INNER JOIN `users` u ON u.id = a.user_id",
            );
            for (const row of liveSteps as { userPublicId: string; lastTotpStep: number | null; recoverySetId: string | null }[]) {
              if (row.lastTotpStep !== null) {
                const [uRes] = await targetConn.execute(
                  "UPDATE `assurance_accounts` a INNER JOIN `users` u ON u.id = a.user_id SET a.last_totp_step = GREATEST(COALESCE(a.last_totp_step, 0), ?) WHERE u.public_id = ? AND COALESCE(a.last_totp_step, 0) < ?",
                  [Number(row.lastTotpStep), row.userPublicId, Number(row.lastTotpStep)],
                );
                totpWatermarksAdvanced += (uRes as mysql.ResultSetHeader).affectedRows;
              }
              // If the user rotated their recovery code set in live after the backup, retire the entire old set in target
              if (tableSet.has("assurance_recovery_codes")) {
                const [targetAcctRows] = await targetConn.query(
                  "SELECT a.user_id AS userId, a.recovery_set_id AS recoverySetId FROM `assurance_accounts` a INNER JOIN `users` u ON u.id = a.user_id WHERE u.public_id = ?",
                  [row.userPublicId],
                );
                const targetAcct = (targetAcctRows as { userId: number; recoverySetId: string | null }[])[0];
                if (targetAcct && targetAcct.recoverySetId !== row.recoverySetId) {
                  const [retireSetRes] = await targetConn.execute(
                    "UPDATE `assurance_recovery_codes` SET used_at = ? WHERE user_id = ? AND used_at IS NULL",
                    [now, targetAcct.userId],
                  );
                  recoveryCodesReconciled += (retireSetRes as mysql.ResultSetHeader).affectedRows;
                }
              }
            }
          }
        }

        // Propagate individual spent recovery codes from live -> restored target
        if (
          tableSet.has("assurance_recovery_codes") &&
          tableSet.has("users") &&
          liveTableSet.has("assurance_recovery_codes") &&
          liveTableSet.has("users")
        ) {
          const [spentRows] = await liveConn.query(
            "SELECT u.public_id AS userPublicId, rc.code_hash AS codeHash, rc.used_at AS usedAt FROM `assurance_recovery_codes` rc INNER JOIN `users` u ON u.id = rc.user_id WHERE rc.used_at IS NOT NULL",
          );
          for (const spent of spentRows as { userPublicId: string; codeHash: string; usedAt: Date }[]) {
            const [rcRes] = await targetConn.execute(
              "UPDATE `assurance_recovery_codes` rc INNER JOIN `users` u ON u.id = rc.user_id SET rc.used_at = COALESCE(rc.used_at, ?) WHERE u.public_id = ? AND rc.code_hash = ? AND rc.used_at IS NULL",
              [spent.usedAt, spent.userPublicId, spent.codeHash],
            );
            recoveryCodesReconciled += (rcRes as mysql.ResultSetHeader).affectedRows;
          }
        }

        // Propagate WebAuthn passkey signature counters forward so cloned authenticators remain detectable
        if (tableSet.has("assurance_passkeys") && liveTableSet.has("assurance_passkeys")) {
          const [livePks] = await liveConn.query(
            "SELECT credential_index AS credentialIndex, counter FROM `assurance_passkeys`",
          );
          for (const pk of livePks as { credentialIndex: string; counter: number }[]) {
            const [pkRes] = await targetConn.execute(
              "UPDATE `assurance_passkeys` SET counter = GREATEST(counter, ?) WHERE credential_index = ? AND counter < ?",
              [Number(pk.counter), pk.credentialIndex, Number(pk.counter)],
            );
            passkeyCountersReconciled += (pkRes as mysql.ResultSetHeader).affectedRows;
          }
        }
      }

      // 6. Rate-limit state: drop expired historical counters, forward-merge active live counters
      if (tableSet.has("http_rate_limit_counters")) {
        const [delRes] = await targetConn.execute(
          "DELETE FROM `http_rate_limit_counters` WHERE reset_at <= ?",
          [now],
        );
        addDelta("http_rate_limit_counters", -(delRes as mysql.ResultSetHeader).affectedRows);

        if (liveTableSet.has("http_rate_limit_counters")) {
          const [liveCounters] = await liveConn.query(
            "SELECT category, slot, hits, reset_at AS resetAt FROM `http_rate_limit_counters` WHERE reset_at > ?",
            [now],
          );
          for (const c of liveCounters as { category: string; slot: number; hits: number; resetAt: Date }[]) {
            const [existing] = await targetConn.query(
              "SELECT hits FROM `http_rate_limit_counters` WHERE category = ? AND slot = ?",
              [c.category, c.slot],
            );
            if ((existing as { hits: number }[]).length > 0) {
              await targetConn.execute(
                "UPDATE `http_rate_limit_counters` SET hits = GREATEST(hits, ?), reset_at = GREATEST(reset_at, ?) WHERE category = ? AND slot = ?",
                [c.hits, c.resetAt, c.category, c.slot],
              );
            } else {
              await targetConn.execute(
                "INSERT INTO `http_rate_limit_counters` (category, slot, hits, reset_at) VALUES (?, ?, ?, ?)",
                [c.category, c.slot, c.hits, c.resetAt],
              );
              addDelta("http_rate_limit_counters", 1);
            }
          }
        }
      }

      // 7. Quarantine stored jobs, outbound mail, and external provider feature flags
      if (tableSet.has("job_runs")) {
        const [res] = await targetConn.execute(
          "UPDATE `job_runs` SET state = 'canceled', reason_code = 'RESTORE_QUARANTINED', allow_retry = 0 WHERE state IN ('queued', 'running')",
        );
        queuedJobsQuarantined = (res as mysql.ResultSetHeader).affectedRows;
      }
      if (tableSet.has("mail_outbox")) {
        const [res] = await targetConn.execute(
          "UPDATE `mail_outbox` SET state = 'canceled', reason_code = 'RESTORE_QUARANTINED' WHERE state IN ('queued', 'sending', 'held')",
        );
        queuedMailQuarantined = (res as mysql.ResultSetHeader).affectedRows;
      }
      if (tableSet.has("platform_settings")) {
        const [res] = await targetConn.execute(
          "UPDATE `platform_settings` SET value_json = CAST('false' AS JSON), updated_at = ? WHERE kind = 'flag' AND JSON_EXTRACT(value_json, '$') = true",
          [now],
        );
        externalFlagsDisabled += (res as mysql.ResultSetHeader).affectedRows;
      }
      if (tableSet.has("siem_destinations")) {
        const [cols] = await targetConn.query(
          "SELECT COLUMN_NAME AS col FROM information_schema.columns WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'siem_destinations' AND COLUMN_NAME = 'enabled'",
        );
        if ((cols as { col: string }[]).length > 0) {
          const [res] = await targetConn.execute("UPDATE `siem_destinations` SET enabled = 0 WHERE enabled = 1");
          externalFlagsDisabled += (res as mysql.ResultSetHeader).affectedRows;
        }
      }

      // 8. Append durable "backup.restore.continuity_marker" audit event to the restored audit_events table
      if (tableSet.has("audit_events")) {
        const targetDrizzle = drizzle(targetPool, { mode: "default" });
        const targetAudit = createAuditEmitter({
          config: options.config,
          db: targetDrizzle,
          clock: options.clock,
          logger: options.logger,
          crypto: options.crypto,
        });
        await targetAudit.record({
          category: "backup",
          eventName: "backup.restore.continuity_marker",
          action: "restore",
          outcome: "completed",
          severity: "INFO",
          reasonCode: "ISOLATED_RESTORE_RECONCILED",
          actor: { role: "system" },
          resource: { type: "backup_archive", publicId: options.backupPublicId },
          safeCounts: {
            sessions_revoked: sessionsRevoked,
            tokens_retired: singleUseTokensRetired,
            jobs_quarantined: queuedJobsQuarantined,
          },
          attributes: {
            continuity_mode: options.continuityMode,
            source_backup_id: options.backupPublicId,
            chain_pre_verify: auditChainVerified,
          },
        });
        auditContinuityMarkerAppended = true;
        addDelta("audit_events", 1);
      }
    } finally {
      targetConn.release();
    }

    // 9. Post-restore semantic integrity verification (schema journal, table row counts, object hashes)
    const restoredSnapshot = await inspectDatabaseSnapshot(options.targetDatabaseUrl);
    const schemaMigrationsMatched =
      restoredSnapshot.migrationCount === options.manifest.schema.migrationCount &&
      restoredSnapshot.lastMigrationHash === options.manifest.schema.lastMigrationHash;

    const tableRowMismatches: { table: string; expected: number; actual: number }[] = [];
    const expectedCounts = options.manifest.databaseDump.tableRowCounts;
    const allTables = new Set([...Object.keys(expectedCounts), ...restoredSnapshot.tableNames]);
    for (const table of [...allTables].sort()) {
      const baseExpected = expectedCounts[table];
      const actual = restoredSnapshot.tableRowCounts[table];
      if (baseExpected === undefined || actual === undefined) {
        tableRowMismatches.push({ table, expected: baseExpected ?? -1, actual: actual ?? -1 });
        continue;
      }
      const adjustedExpected = baseExpected + (expectedRowDeltas.get(table) ?? 0);
      if (actual !== adjustedExpected) {
        tableRowMismatches.push({ table, expected: adjustedExpected, actual });
      }
    }

    let objectHashMismatches = 0;
    for (const item of options.manifest.objectInventory.items) {
      const stat = await options.isolatedStorage.stat(item.storageKey);
      if (!stat || stat.size !== item.size || stat.sha256 !== item.sha256) {
        objectHashMismatches += 1;
      }
    }

    const passed =
      auditChainVerified !== "failed" &&
      schemaMigrationsMatched &&
      tableRowMismatches.length === 0 &&
      objectHashMismatches === 0;

    return {
      continuity: {
        continuityMode: options.continuityMode,
        sessionsRevoked,
        singleUseTokensRetired,
        ephemeralChallengesCleared,
        downloadTicketsCleared,
        totpWatermarksAdvanced,
        passkeyCountersReconciled,
        recoveryCodesReconciled,
        queuedJobsQuarantined,
        queuedMailQuarantined,
        externalFlagsDisabled,
        auditChainVerified,
        auditContinuityMarkerAppended,
      },
      integrity: {
        schemaMigrationsMatched,
        restoredMigrationCount: restoredSnapshot.migrationCount,
        expectedMigrationCount: options.manifest.schema.migrationCount,
        tablesChecked: allTables.size,
        tableRowMismatches,
        objectsChecked: options.manifest.objectInventory.items.length,
        objectHashMismatches,
        passed,
      },
    };
  } finally {
    await liveConn.end();
    await targetPool.end();
  }
}
