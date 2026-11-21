/**
 * Architecture §7.3 Security-state continuity reconciliation and §7.2 post-restore semantic verification.
 * Owner: recovery_ops_engineer.
 *
 * Executed exclusively against the isolated target database and isolated target storage directory
 * immediately after SQL and object streams are loaded.
 *
 * Security invariants:
 *  - Every MySQL connection uses `openValidatedMysqlPool` / `openValidatedMysqlConnection` (`connectionOptionsFromUrl`).
 *  - Offline / default `quarantine_credentials` mode NEVER opens a connection to the live database.
 *  - `preserve_continuity` mode requires a reachable live database whose canonical `audit_chain` verifies AND
 *    cryptographically proves monotonic ancestry of the restored snapshot; it reconciles revoked/deleted users,
 *    role changes, changed passwords, changed/cleared TOTP secrets, deleted passkeys, passkey counters, and
 *    spent/rotated recovery codes.
 *  - Canonical `createChainService` (`server/modules/audit/chain.ts`) verifies links, event digests, authenticated
 *    tombstone receipts, head state, and Ed25519 checkpoints, then seals and checkpoints the continuity marker.
 */
import { drizzle } from "drizzle-orm/mysql2";
import type mysql from "mysql2/promise";
import type { AppConfig } from "../../config/env.js";
import { conflict } from "../../core/errors.js";
import type { Clock, Db, FieldCrypto, Logger, ObjectStorage } from "../../core/types.js";
import { createChainService } from "../audit/chain.js";
import { createAuditEmitter } from "../audit/emitter.js";
import type { BackupManifest } from "./bundle.js";
import {
  inspectDatabaseSnapshot,
  openValidatedMysqlPool,
  parseValidatedMysqlTarget,
} from "./mysqlCli.js";
import type { ContinuityMode, StoredContinuityReport, StoredIntegrityReport } from "./schema.js";

async function countTableRows(conn: mysql.PoolConnection | mysql.Connection, tableName: string): Promise<number> {
  const [rows] = await conn.query(`SELECT COUNT(*) AS cnt FROM \`${tableName}\``);
  return Number((rows as { cnt: number | string }[])[0]?.cnt ?? 0);
}

async function verifyCanonicalAuditChain(
  targetDb: Db,
  targetConn: mysql.PoolConnection,
  tableSet: ReadonlySet<string>,
  options: { config: AppConfig; clock: Clock; logger: Logger },
): Promise<{ status: "verified" | "failed" | "not_present"; headSeq: number; headHash: string | null }> {
  if (!tableSet.has("audit_events")) {
    return { status: "not_present", headSeq: 0, headHash: null };
  }
  // If `audit_events` exists, full chain metadata tables must also exist — never treat missing chain tables as verified.
  if (
    !tableSet.has("audit_chain") ||
    !tableSet.has("audit_chain_head") ||
    !tableSet.has("audit_checkpoints") ||
    !tableSet.has("audit_tombstones")
  ) {
    return { status: "failed", headSeq: 0, headHash: null };
  }

  const eventCount = await countTableRows(targetConn, "audit_events");
  const chainCount = await countTableRows(targetConn, "audit_chain");
  const headCount = await countTableRows(targetConn, "audit_chain_head");

  if (headCount === 0 && (eventCount > 0 || chainCount > 0)) {
    // Allow sealing fresh unsealed rows ONLY if zero chain rows existed before first sealer pass and all rows are recent,
    // otherwise missing head on a populated chain is tampering.
    if (chainCount > 0) {
      return { status: "failed", headSeq: 0, headHash: null };
    }
  }

  try {
    const chainService = createChainService({
      db: targetDb,
      clock: options.clock,
      logger: options.logger,
      auditChainKey: options.config.auditChainKey,
      installationId: options.config.installationId,
    });
    const verification = await chainService.verify({ fromSeq: 1, maxEvents: 1_000_000 });
    if (!verification.ok || !verification.complete || verification.unsealedOlderThanHorizon > 0) {
      return { status: "failed", headSeq: verification.headSeq, headHash: null };
    }
    const head = await chainService.head();
    return { status: "verified", headSeq: head.headSeq, headHash: head.headHash };
  } catch {
    return { status: "failed", headSeq: 0, headHash: null };
  }
}

export async function reconcileAndVerifyIsolatedRestore(options: {
  liveDatabaseUrl?: string;
  targetDatabaseUrl: string;
  isolatedStorage: ObjectStorage;
  manifest: BackupManifest;
  continuityMode?: ContinuityMode;
  backupPublicId: string;
  config: AppConfig;
  clock: Clock;
  logger: Logger;
  crypto: FieldCrypto;
}): Promise<{
  continuity: StoredContinuityReport;
  integrity: StoredIntegrityReport;
}> {
  const continuityMode: ContinuityMode = options.continuityMode ?? "quarantine_credentials";
  if (continuityMode === "preserve_continuity" && !options.liveDatabaseUrl) {
    throw conflict(
      "CONTINUITY_SOURCE_UNTRUSTED",
      "Cannot preserve credential continuity without a verified live database; use quarantine_credentials.",
    );
  }

  const now = options.clock.now();
  const minTotpStep = Math.floor(now.getTime() / 30_000);

  const targetPool = openValidatedMysqlPool(options.targetDatabaseUrl, 2);
  const livePool =
    continuityMode === "preserve_continuity" && options.liveDatabaseUrl
      ? openValidatedMysqlPool(options.liveDatabaseUrl, 2)
      : null;

  /** Track intentional row-count deltas made by continuity reconciliation so row-count verification stays exact. */
  const expectedRowDeltas = new Map<string, number>();
  const addDelta = (table: string, delta: number) => {
    if (delta !== 0) {
      expectedRowDeltas.set(table, (expectedRowDeltas.get(table) ?? 0) + delta);
    }
  };

  try {
    const targetConn = await targetPool.getConnection();
    const targetDrizzle = drizzle(targetPool, { mode: "default" }) as unknown as Db;

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
      const targetMeta = parseValidatedMysqlTarget(options.targetDatabaseUrl);
      const [tblRows] = await targetConn.query(
        "SELECT TABLE_NAME AS tableName FROM information_schema.tables WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'",
        [targetMeta.database],
      );
      const tableSet = new Set((tblRows as { tableName: string }[]).map((r) => r.tableName));

      // 1. Canonical verification of restored audit chain BEFORE appending continuity marker.
      const preChain = await verifyCanonicalAuditChain(targetDrizzle, targetConn, tableSet, {
        config: options.config,
        clock: options.clock,
        logger: options.logger,
      });
      auditChainVerified = preChain.status;

      // If `preserve_continuity` was requested, prove live DB is a cryptographically valid forward continuation!
      let liveConn: mysql.PoolConnection | null = null;
      let liveTableSet = new Set<string>();
      if (continuityMode === "preserve_continuity") {
        if (!livePool || !options.liveDatabaseUrl || auditChainVerified === "failed") {
          throw conflict(
            "CONTINUITY_SOURCE_UNTRUSTED",
            "Restored or live audit chain could not prove continuity; quarantine_credentials is required.",
          );
        }
        liveConn = await livePool.getConnection();
        const liveMeta = parseValidatedMysqlTarget(options.liveDatabaseUrl);
        const [liveTblRows] = await liveConn.query(
          "SELECT TABLE_NAME AS tableName FROM information_schema.tables WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'",
          [liveMeta.database],
        );
        liveTableSet = new Set((liveTblRows as { tableName: string }[]).map((r) => r.tableName));

        const liveDrizzle = drizzle(livePool, { mode: "default" }) as unknown as Db;
        const liveChainCheck = await verifyCanonicalAuditChain(liveDrizzle, liveConn, liveTableSet, {
          config: options.config,
          clock: options.clock,
          logger: options.logger,
        });
        if (liveChainCheck.status !== "verified" || liveChainCheck.headSeq < preChain.headSeq) {
          liveConn.release();
          throw conflict(
            "CONTINUITY_SOURCE_UNTRUSTED",
            "Live audit chain is not a verified forward continuation of the backup; use quarantine_credentials.",
          );
        }
        if (preChain.headSeq > 0 && preChain.headHash) {
          const [ancestryRows] = await liveConn.query(
            "SELECT link_hash AS linkHash FROM `audit_chain` WHERE seq = ?",
            [preChain.headSeq],
          );
          const liveLinkAtSeq = (ancestryRows as { linkHash: string }[])[0]?.linkHash;
          if (!liveLinkAtSeq || liveLinkAtSeq !== preChain.headHash) {
            liveConn.release();
            throw conflict(
              "CONTINUITY_SOURCE_UNTRUSTED",
              "Live audit chain diverged from the backup's chain history; use quarantine_credentials.",
            );
          }
        }
      }

      try {
        // 2. Revoke ALL restored sessions unconditionally.
        if (tableSet.has("user_sessions")) {
          const [res] = await targetConn.execute(
            "UPDATE `user_sessions` SET revoked_at = COALESCE(revoked_at, ?), revoke_reason = COALESCE(revoke_reason, 'restored_from_backup') WHERE revoked_at IS NULL",
            [now],
          );
          sessionsRevoked = (res as mysql.ResultSetHeader).affectedRows;
        }

        // 3. Retire ALL unconsumed single-use identity tokens unconditionally.
        if (tableSet.has("identity_tokens")) {
          const [res] = await targetConn.execute(
            "UPDATE `identity_tokens` SET consumed_at = ?, retired_reason = 'restored_from_backup' WHERE consumed_at IS NULL",
            [now],
          );
          singleUseTokensRetired = (res as mysql.ResultSetHeader).affectedRows;
        }

        // 4. Delete ALL ephemeral MFA/WebAuthn challenges and single-use file download tickets.
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

        // 5. Reconcile user entitlements, passwords, MFA, recovery codes, and passkeys.
        if (continuityMode === "quarantine_credentials") {
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
        } else if (liveConn) {
          // `preserve_continuity` (with verified cryptographic live-chain ancestry):
          // Reconcile user status/role/password changes so suspended, deactivated, demoted, or password-rotated
          // accounts NEVER regain historic credentials or privileges!
          if (tableSet.has("users") && liveTableSet.has("users")) {
            const [liveUsers] = await liveConn.query(
              "SELECT public_id AS publicId, role, status, password_hash AS passwordHash FROM `users`",
            );
            const liveUserMap = new Map(
              (liveUsers as { publicId: string; role: string; status: string; passwordHash: string | null }[]).map(
                (u) => [u.publicId, u],
              ),
            );
            const [restoredUsers] = await targetConn.query(
              "SELECT id, public_id AS publicId, role, status, password_hash AS passwordHash FROM `users`",
            );
            for (const ru of restoredUsers as {
              id: number;
              publicId: string;
              role: string;
              status: string;
              passwordHash: string | null;
            }[]) {
              const lu = liveUserMap.get(ru.publicId);
              if (!lu) {
                // User removed in live DB -> deactivate and strip historic credentials/authenticators.
                await targetConn.execute(
                  "UPDATE `users` SET status = 'deactivated', password_hash = NULL, must_change_password = 1, status_reason_code = 'RESTORE_MISSING_IN_LIVE', status_changed_at = ? WHERE id = ?",
                  [now, ru.id],
                );
                if (tableSet.has("assurance_accounts")) {
                  await targetConn.execute(
                    "UPDATE `assurance_accounts` SET totp_secret_enc = NULL, recovery_set_id = NULL WHERE user_id = ?",
                    [ru.id],
                  );
                }
                if (tableSet.has("assurance_passkeys")) {
                  const [delPk] = await targetConn.execute("DELETE FROM `assurance_passkeys` WHERE user_id = ?", [
                    ru.id,
                  ]);
                  const removed = (delPk as mysql.ResultSetHeader).affectedRows;
                  passkeyCountersReconciled += removed;
                  addDelta("assurance_passkeys", -removed);
                }
                continue;
              }

              const statusChanged = lu.status !== ru.status;
              const roleChanged = lu.role !== ru.role;
              const passwordChanged = lu.passwordHash !== ru.passwordHash;
              const shouldQuarantinePassword =
                lu.status !== "active" || roleChanged || passwordChanged;

              if (statusChanged || roleChanged || shouldQuarantinePassword) {
                await targetConn.execute(
                  "UPDATE `users` SET role = ?, status = ?, password_hash = CASE WHEN ? THEN NULL ELSE password_hash END, must_change_password = CASE WHEN ? THEN 1 ELSE must_change_password END, status_changed_at = CASE WHEN ? THEN ? ELSE status_changed_at END WHERE id = ?",
                  [
                    lu.role,
                    lu.status,
                    shouldQuarantinePassword ? 1 : 0,
                    shouldQuarantinePassword ? 1 : 0,
                    statusChanged ? 1 : 0,
                    now,
                    ru.id,
                  ],
                );
              }
            }
          }

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
                "SELECT u.public_id AS userPublicId, a.totp_secret_enc AS totpSecretEnc, a.last_totp_step AS lastTotpStep, a.recovery_set_id AS recoverySetId FROM `assurance_accounts` a INNER JOIN `users` u ON u.id = a.user_id",
              );
              const liveAssuranceMap = new Map(
                (
                  liveSteps as {
                    userPublicId: string;
                    totpSecretEnc: string | null;
                    lastTotpStep: number | null;
                    recoverySetId: string | null;
                  }[]
                ).map((r) => [r.userPublicId, r]),
              );

              const [targetAccts] = await targetConn.query(
                "SELECT a.user_id AS userId, u.public_id AS userPublicId, a.totp_secret_enc AS totpSecretEnc, a.recovery_set_id AS recoverySetId FROM `assurance_accounts` a INNER JOIN `users` u ON u.id = a.user_id",
              );
              for (const ta of targetAccts as {
                userId: number;
                userPublicId: string;
                totpSecretEnc: string | null;
                recoverySetId: string | null;
              }[]) {
                const la = liveAssuranceMap.get(ta.userPublicId);
                if (!la || la.totpSecretEnc !== ta.totpSecretEnc) {
                  // TOTP secret was rotated or removed in live DB after the backup -> clear stale historic TOTP!
                  await targetConn.execute(
                    "UPDATE `assurance_accounts` SET totp_secret_enc = NULL WHERE user_id = ?",
                    [ta.userId],
                  );
                }
                if (la?.lastTotpStep !== null && la?.lastTotpStep !== undefined) {
                  const [uRes] = await targetConn.execute(
                    "UPDATE `assurance_accounts` SET last_totp_step = GREATEST(COALESCE(last_totp_step, 0), ?) WHERE user_id = ? AND COALESCE(last_totp_step, 0) < ?",
                    [Number(la.lastTotpStep), ta.userId, Number(la.lastTotpStep)],
                  );
                  totpWatermarksAdvanced += (uRes as mysql.ResultSetHeader).affectedRows;
                }
                if (tableSet.has("assurance_recovery_codes") && (!la || ta.recoverySetId !== la.recoverySetId)) {
                  const [retireSetRes] = await targetConn.execute(
                    "UPDATE `assurance_recovery_codes` SET used_at = ? WHERE user_id = ? AND used_at IS NULL",
                    [now, ta.userId],
                  );
                  recoveryCodesReconciled += (retireSetRes as mysql.ResultSetHeader).affectedRows;
                }
              }
            }
          }

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

          // Reconcile WebAuthn passkeys: DELETE any passkey revoked/removed in live DB AND advance counters on kept ones!
          if (tableSet.has("assurance_passkeys") && liveTableSet.has("assurance_passkeys")) {
            const [livePks] = await liveConn.query(
              "SELECT credential_index AS credentialIndex, counter FROM `assurance_passkeys`",
            );
            const livePkMap = new Map(
              (livePks as { credentialIndex: string; counter: number }[]).map((pk) => [
                pk.credentialIndex,
                Number(pk.counter),
              ]),
            );
            const [targetPks] = await targetConn.query(
              "SELECT id, credential_index AS credentialIndex, counter FROM `assurance_passkeys`",
            );
            for (const tpk of targetPks as { id: number; credentialIndex: string; counter: number }[]) {
              const liveCounter = livePkMap.get(tpk.credentialIndex);
              if (liveCounter === undefined) {
                await targetConn.execute("DELETE FROM `assurance_passkeys` WHERE id = ?", [tpk.id]);
                passkeyCountersReconciled += 1;
                addDelta("assurance_passkeys", -1);
              } else if (Number(tpk.counter) < liveCounter) {
                await targetConn.execute("UPDATE `assurance_passkeys` SET counter = ? WHERE id = ?", [
                  liveCounter,
                  tpk.id,
                ]);
                passkeyCountersReconciled += 1;
              }
            }
          }
        }

        // 6. Rate-limit state: drop expired historical counters, forward-merge active live counters when present.
        if (tableSet.has("http_rate_limit_counters")) {
          const [delRes] = await targetConn.execute(
            "DELETE FROM `http_rate_limit_counters` WHERE reset_at <= ?",
            [now],
          );
          addDelta("http_rate_limit_counters", -(delRes as mysql.ResultSetHeader).affectedRows);

          if (liveConn && liveTableSet.has("http_rate_limit_counters")) {
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
      } finally {
        liveConn?.release();
      }

      // 7. Quarantine stored jobs, outbound mail, and external provider feature flags.
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
        const [colRows] = await targetConn.query(
          "SELECT COLUMN_NAME AS colName FROM information_schema.columns WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'mail_outbox' AND COLUMN_NAME = 'payload_enc'",
          [targetMeta.database],
        );
        if ((colRows as { colName: string }[]).length > 0) {
          await targetConn.execute(
            "UPDATE `mail_outbox` SET payload_enc = NULL WHERE state IN ('canceled', 'unknown') AND payload_enc IS NOT NULL",
          );
        }
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

      // 8. Append durable "backup.restore.continuity_marker" audit event, seal chain, and sign checkpoint when intact.
      if (tableSet.has("audit_events")) {
        const chainBefore = tableSet.has("audit_chain") ? await countTableRows(targetConn, "audit_chain") : 0;
        const headBefore = tableSet.has("audit_chain_head") ? await countTableRows(targetConn, "audit_chain_head") : 0;
        const cpBefore = tableSet.has("audit_checkpoints") ? await countTableRows(targetConn, "audit_checkpoints") : 0;

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
            continuity_mode: continuityMode,
            source_backup_id: options.backupPublicId,
            chain_pre_verify: auditChainVerified,
          },
        });
        auditContinuityMarkerAppended = true;
        addDelta("audit_events", 1);

        if (
          auditChainVerified === "verified" &&
          tableSet.has("audit_chain") &&
          tableSet.has("audit_chain_head") &&
          tableSet.has("audit_checkpoints")
        ) {
          const chainService = createChainService({
            db: targetDrizzle,
            clock: options.clock,
            logger: options.logger,
            auditChainKey: options.config.auditChainKey,
            installationId: options.config.installationId,
          });
          await chainService.sealPending({ fullScan: true });
          await chainService.createCheckpoint("restored_from_backup");

          const chainAfter = await countTableRows(targetConn, "audit_chain");
          const headAfter = await countTableRows(targetConn, "audit_chain_head");
          const cpAfter = await countTableRows(targetConn, "audit_checkpoints");
          addDelta("audit_chain", chainAfter - chainBefore);
          addDelta("audit_chain_head", headAfter - headBefore);
          addDelta("audit_checkpoints", cpAfter - cpBefore);
        }
      }

      // 9. Also verify every non-purged object row inside the restored DB has its verified blob in isolatedStorage!
      let dbReferencedMissingObjects = 0;
      if (tableSet.has("order_files")) {
        const [fRows] = await targetConn.query(
          "SELECT storage_key AS storageKey, byte_size AS byteSize, sha256 FROM `order_files` WHERE purged_at IS NULL",
        );
        for (const r of fRows as { storageKey: string; byteSize: number; sha256: string }[]) {
          const st = await options.isolatedStorage.stat(r.storageKey);
          if (!st || st.size !== Number(r.byteSize) || st.sha256 !== r.sha256) {
            dbReferencedMissingObjects += 1;
          }
        }
      }
      if (tableSet.has("platform_presentation_images")) {
        const [iRows] = await targetConn.query(
          "SELECT storage_key AS storageKey, byte_size AS byteSize, sha256 FROM `platform_presentation_images` WHERE deleted_at IS NULL",
        );
        for (const r of iRows as { storageKey: string; byteSize: number; sha256: string }[]) {
          const st = await options.isolatedStorage.stat(r.storageKey);
          if (!st || st.size !== Number(r.byteSize) || st.sha256 !== r.sha256) {
            dbReferencedMissingObjects += 1;
          }
        }
      }

      // Release targetConn before `inspectDatabaseSnapshot` opens its own verified read-only snapshot connection.
      targetConn.release();

      // 10. Post-restore semantic integrity verification (schema journal, table row counts, object hashes).
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

      let objectHashMismatches = dbReferencedMissingObjects;
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
          continuityMode,
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
    } catch (err) {
      targetConn.release();
      throw err;
    }
  } finally {
    await livePool?.end().catch(() => {});
    await targetPool.end().catch(() => {});
  }
}
