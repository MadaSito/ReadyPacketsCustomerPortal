# Backup, Verification & Isolated Disaster-Recovery — Verification Record

## 1. Security Review Remediation Summary (`docs/security/REVIEW-audit-siem-backup.md`)

All findings from the security review (`ad7511d`) and the Integrator Security Directive have been closed and verified:

| Finding | Remediation | Verified By |
| --- | --- | --- |
| **HIGH-1 (Web-initiated restore attack surface & SQL dump execution privilege)** | Removed `restoreIsolated` from `server/modules/backup/router.ts` and `restoreToIsolatedTarget` from `BackupService` (`server/modules/backup/index.ts`, `API.md`). Restores execute strictly via operator CLI (`scripts/ops/restore/restore-isolated.ts`) using separate recovery credentials (`RP_RECOVERY_DATABASE_URL` / `RP_RECOVERY_DATABASE_URL_FILE`) verified via `SHOW GRANTS FOR CURRENT_USER()` to hold zero write privileges on `*.*` or the live schema, plus SQL statement dangerous-directive rejection (`DEFINER`, `DATA/INDEX DIRECTORY`, `INTO OUTFILE/DUMPFILE`, `LOAD DATA`, `SQL_LOG_BIN`, cross-DB `USE`). | `backup.test.ts` (tests 1, 4, 6); `API.md` |
| **HIGH-2 (MySQL TLS bypass in `mysql`/`mysqldump` CLI & target connections)** | Every `mysql2` connection (`continuity.ts`, `mysqlCli.ts`) and every `mysql`/`mysqldump` child process parses DSNs through `connectionOptionsFromUrl()` (`server/db/connectionOptions.ts`) and injects `ssl-mode`, `ssl-ca`, `ssl-cert`, `ssl-key` via private `0600` `--defaults-extra-file` (`[mysql]` sets `local-infile=0`). | `mysqlCli.ts`, `continuity.ts`, `backup.test.ts` |
| **HIGH-3 (DB + object storage snapshot consistency boundary)** | `runMysqlDumpStream` (`--single-transaction --quick`) streams through `StreamingDumpInspector` without memory buffering to capture the exact InnoDB MVCC `stored_objects` inventory at `T_db`; every referenced immutable blob is opened with `O_NOFOLLOW` and verified against `sha256` + `sizeBytes`. Missing referenced blobs fail closed. Consistency boundary documented in `docs/operations/BACKUP_AND_RESTORE.md`. | `mysqlCli.ts`, `index.ts`, `backup.test.ts` |
| **HIGH-4 (Offline `.rpbk` archive restore capability without live DB)** | Implemented `restoreEncryptedArchiveToIsolatedTarget()` (`server/modules/backup/offlineRestore.ts`) and updated `scripts/ops/restore/restore-isolated.ts` (`--archive-file`, `--offline`, `--target-db`, `--target-storage`, `--confirm`). Supports full-loss offline DR when the live MySQL instance is completely down. | `offlineRestore.ts`, `restore-isolated.ts`, `backup.test.ts` (test 5) |
| **HIGH-5 (Post-restore credential, session, token & MFA continuity)** | `reconcileAndVerifyIsolatedRestore()` (`server/modules/backup/continuity.ts`) unconditionally revokes all `auth_sessions`, deletes/invalidates all single-use reset/verify/magic/MFA/download tokens, cancels in-flight `job_runs`, advances `last_totp_step` watermarks, reconciles live account status/role/passkeys/recovery codes, clears pre-rotation `password_hash` (`must_change_password = 1`) and `totp_secret_enc` fail-closed whenever credentials changed after backup, verifies HMAC audit chain integrity via `createChainService`, and appends a durable `RESTORE_CONTINUITY_SEAL` audit epoch + `backup.restore_completed` record. | `continuity.ts`, `backup.test.ts` (tests 1, 5) |
| **HIGH-6 (Privileged installer shell arbitrary `env` sourcing)** | Deleted redundant `scripts/ops/install/**` in commit `37e484a` in coordination with `files_engineer` (consolidated on `deploy/install.sh`). | Git commit `37e484a` |
| **MEDIUM-1 (Secret file permissions, symlink safety & target path aliasing)** | Enforced `O_NOFOLLOW`, regular-file + owner/mode validation on `*_FILE` secrets (`keys.ts`, `_runtime.ts`), canonical `realpath` disjointness + atomic `mkdir` / empty-directory checks on `--target-storage`, and safe entry extraction in `archive.ts` / `offlineRestore.ts`. | `keys.ts`, `offlineRestore.ts`, `archive.ts`, `backup.test.ts` (tests 3, 7) |
| **MEDIUM-2 (Advisory lock / TOCTOU race on isolated target DB creation & retention purges)** | `prepareIsolatedTargetDatabase()` holds MySQL `GET_LOCK` across existence check + `CREATE DATABASE`, verifies 0 existing tables, and inspects `SHOW GRANTS`. Retention uses two-phase `RETENTION_PURGE_PENDING` before unlinking files so crash mid-unlink recovers cleanly and protects the last-known-good verified backup + active legal holds. | `mysqlCli.ts`, `index.ts`, `backup.test.ts` (tests 2, 6) |
| **MEDIUM-3 (Background worker lease-loss awareness & streaming memory bounds)** | `BackupService` threads `assertLease()` heartbeats across dump, archive encryption, verification, and retention phases (`isJobLeaseLostError` matches `DomainError` `JOB_LEASE_LOST` from `server/modules/jobs/queue.ts` and aborts cleanly without double-marking failed). Streaming dump + chunked `RPBK1` AES-256-GCM keep heap bounded. | `index.ts`, `archive.ts`, `backup.test.ts` (test 8) |

---

## 2. Verification Commands & Results

Executed in `/home/user/workspace/readypackets-portal` via `scripts/dev/*` wrappers:

1. **TypeScript Typecheck (`scripts/dev/tc.sh`)**:
   - `scripts/dev/tc.sh 'server/modules/backup|scripts/ops'` -> `typecheck: no diagnostics matching 'server/modules/backup|scripts/ops'` (exit 0)
   - `scripts/dev/tc.sh` (whole repository) -> `typecheck: clean` (exit 0)
2. **ESLint (`scripts/dev/lint.sh`)**:
   - `scripts/dev/lint.sh server/modules/backup scripts/ops` -> 0 errors, 0 warnings (exit 0)
3. **End-to-End MySQL 8.4 + CLI Integration Suite (`scripts/dev/test.sh server/modules/backup/backup.test.ts`)**:
   - **8 / 8 tests passed** against real local MySQL 8.4 + `mysqldump` + `mysql` + `createChainService`:
     1. Real `mysqldump` + immutable object capture, byte-level + scratch-target `verifyBackupDirect`, isolated CLI restore, and §7.3 security-state continuity reconciliation (session revocation, single-use token wipe, TOTP watermark advancement, rotated password/TOTP fail-closed quarantine, revoked passkey pruning, rate-limit carry-forward, and HMAC audit chain continuity).
     2. Retention protection for last-known-good verified backup, active legal holds, `UNKNOWN` states, two-phase crash-safe purge, and fail-closed audit dependency.
     3. Cryptographic tamper & truncation detection on `.rpbk` archives (header flip, ciphertext flip, premature EOF truncation).
     4. Malicious SQL statement rejection (`DEFINER=`, `INTO OUTFILE`, `SET SQL_LOG_BIN=0`, cross-DB `USE`).
     5. Full offline `.rpbk` CLI restore when live DB is unreachable (`liveDb: null`), verifying HMAC audit chain continuity and session/token revocation in isolated target.
     6. Recovery MySQL credential privilege isolation (`SHOW GRANTS` rejects live-schema write privileges and live credential reuse).
     7. Secret-file permission & symlink rejection (`0644` world-readable key file refused; `0600` owner-only key file accepted).
     8. Job lease-loss (`JOB_LEASE_LOST`) propagation during backup execution without corrupting ledger state.
