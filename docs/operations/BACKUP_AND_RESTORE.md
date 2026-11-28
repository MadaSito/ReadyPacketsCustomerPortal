# Backup, Verification & Isolated Disaster-Recovery Runbook

ReadyPackets provides encrypted, tamper-evident backups of the MySQL relational state and immutable object storage (`stored_objects`), paired with cryptographic verification, automated isolated scratch-target continuity checks, legal-hold-aware retention, and an **operator-only CLI restore workflow**.

> **Zero-Trust Boundary**: Web-initiated restore is intentionally omitted from the HTTP/tRPC surface. All restores execute exclusively via the operator CLI (`scripts/ops/restore/restore-isolated.ts`) into a newly created, empty isolated target database (`rp_restore_<YYYYMMDD>`) and empty isolated storage directory using dedicated recovery credentials that hold **zero write privileges** on the live production schema.

---

## 1. Encryption & Archive Envelope (`RPBK1`)

Every backup produces a single self-contained `.rpbk` archive encrypted with an authenticated chunked envelope (`RPBK1`):

1. **Key Hierarchy**:
   - **Master Wrapping Key (`KEK`)**: 32-byte key loaded from `RP_BACKUP_KEY_FILE` (recommended `0400`/`0600` root-owned secret file) or `RP_BACKUP_KEY` (`base64` or 64-char hex), with seamless decryption fallback to `RP_BACKUP_PREVIOUS_KEYS` / `RP_BACKUP_PREVIOUS_KEYS_FILE` during key rotation.
   - **Per-Backup Data Encryption Key (`DEK`)**: Fresh CSPRNG 32-byte key generated per backup, wrapped under the active `KEK` with AES-256-GCM and AAD bound to `backupPublicId` and `keyId`.
2. **Authenticated Framing & Truncation Resistance**:
   - Payload TAR entries (`manifest.json`, `db/dump.sql.gz`, `objects/<storageKey>`) are compressed and encrypted in sequence-numbered AES-256-GCM chunks (`chunkIndex = 0..N-1`) with 96-bit deterministic nonces and AAD binding `(magic, version, backupPublicId, keyId, chunkIndex, isFinalChunk)`.
   - Chunk reordering, splicing, bit-flips, header tampering, or premature EOF (missing authenticated `FINAL` frame) fail closed before cutover.

---

## 2. Snapshot Consistency Boundary

Understanding what is and is not point-in-time consistent in a live online backup:

### What IS Point-in-Time Consistent
- **Relational Database (`db/dump.sql.gz`)**: Captured via `mysqldump --single-transaction --quick --routines --triggers --events --hex-blob --set-gtid-purged=OFF` over InnoDB MVCC. All InnoDB tables in `dump.sql.gz` represent a **single transactional point-in-time snapshot** (`T_db`) without locking live reads or writes.
- **DB-Referenced Object Inventory (`objects/*`)**: As `dump.sql.gz` streams from `mysqldump`, `StreamingDumpInspector` extracts the exact set of `stored_objects` rows (`objectPublicId`, `storageKey`, `sha256`, `sizeBytes`) visible at `T_db` without buffering the SQL dump in memory. Because ReadyPackets object blobs are **immutable and content-addressed by SHA-256**, every blob referenced by `stored_objects` at `T_db` is read with `O_NOFOLLOW` and verified byte-for-byte against the snapshot's recorded `sha256` and `sizeBytes` before being written into the encrypted archive.

### What Is NOT Included / Edge Cases at `T_db`
- **Objects uploaded after `T_db`**: Any upload committed to MySQL after `mysqldump` establishes its repeatable-read transaction is absent from both `dump.sql.gz` and the archived object list, preserving relational-to-blob referential integrity.
- **Concurrent physical purge during backup**: Legal-hold and retention purges are coordinated via two-phase `RETENTION_PURGE_PENDING` states. If an unheld object referenced at `T_db` is physically unlinked from disk before the archiver reads its blob, the backup **fails closed** (`MISSING_REFERENCED_OBJECT`) rather than producing a partial archive.
- **Unreferenced staging/orphan files on disk**: Files in `STORAGE_LOCAL_DIR` that are not referenced by `stored_objects` at `T_db` (for example, in-flight uploads not yet committed) are excluded from the archive; post-scan orphan counts are recorded in backup telemetry.
- **In-memory process state**: Ephemeral rate-limit windows not flushed to MySQL and open SSE/socket connections are not part of backups.

---

## 3. TLS Enforcement & Least-Privilege MySQL Credentials

### Mandatory TLS Parity
Every MySQL TCP connection and every `mysql` / `mysqldump` child process spawned by backup, verification, continuity reconciliation, or isolated restore parses its DSN through `connectionOptionsFromUrl()` (`server/db/connectionOptions.ts`).
- `ssl` / `ssl-mode` (`VERIFY_IDENTITY` in production unless explicitly overridden for loopback dev), `ssl-ca`, `ssl-cert`, and `ssl-key` are written into a private `0600` temporary `--defaults-extra-file` inside a `0700` directory and deleted immediately on exit.
- `local-infile=0` is enforced under `[mysql]` so rogue SQL servers or dumps cannot trigger client-side file reads.

### Provisioning the Dedicated Recovery MySQL Account
Isolated scratch verification (`rp_vfy_*`) and isolated disaster-recovery restores (`rp_restore_*`) **refuse** to use the live application MySQL user and **inspect `SHOW GRANTS FOR CURRENT_USER()`** to reject any credential that holds write privileges (`ALL PRIVILEGES`, `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `TRIGGER`, etc.) on `*.*` or the live production schema.

Provision a dedicated recovery MySQL user on your MySQL instance:

```sql
CREATE USER 'rp_recovery'@'%' IDENTIFIED BY '<STRONG_RANDOM_SECRET>';
GRANT ALL PRIVILEGES ON `rp_restore\_%`.* TO 'rp_recovery'@'%';
GRANT ALL PRIVILEGES ON `rp_vfy\_%`.* TO 'rp_recovery'@'%';
FLUSH PRIVILEGES;
```

> Note the escaped underscore (`\_`) in `` `rp_restore\_%` `` and `` `rp_vfy\_%` ``. An unescaped `_` in MySQL `GRANT` syntax is a single-character wildcard; escaping it binds privileges strictly to schemas prefixed with `rp_restore_` and `rp_vfy_`.

Store the recovery DSN in `/etc/readypackets/secrets/recovery_database_url` (`chmod 0400`, owned by the service/operator user).

---

## 4. Routine Operations (Web Admin & CLI)

### Web Administration (`Admin -> Backups`)
System administrators with fresh step-up MFA can:
- Inspect backup catalog health, storage usage, encryption key IDs, and historical isolated restore/drill summaries.
- Trigger an immediate on-demand encrypted backup (`Run backup now`).
- Trigger cryptographic + manifest + continuity verification (`Verify`). When `RP_RECOVERY_DATABASE_URL` / `RP_RECOVERY_DATABASE_URL_FILE` is configured, verification additionally imports into a temporary `rp_vfy_<token>` scratch database, runs security-state continuity checks, and drops the scratch schema in `finally`.
- Place/release **Legal Holds** on specific backups and manage retention policies (`minKeepCount`, `retentionDays`, `autoPruneEnabled`).

### CLI: On-Demand Backup
```bash
RP_BACKUP_KEY_FILE=/etc/readypackets/secrets/backup_key \
pnpm tsx scripts/ops/backup/run-backup.ts --label "pre-upgrade-snapshot"
```

### CLI: Cryptographic & Scratch-Target Verification
```bash
RP_BACKUP_KEY_FILE=/etc/readypackets/secrets/backup_key \
RP_RECOVERY_DATABASE_URL_FILE=/etc/readypackets/secrets/recovery_database_url \
pnpm tsx scripts/ops/backup/verify-backup.ts --backup-id <BACKUP_PUBLIC_ID>
```

### CLI: Retention Prune (Respects Legal Holds & Last-Known-Good Verified Backup)
```bash
pnpm tsx scripts/ops/backup/prune-backups.ts --dry-run
pnpm tsx scripts/ops/backup/prune-backups.ts
```

---

## 5. Operator CLI Isolated Restore Procedure

> **Items deleted permanently from the Trash (increment 09).**
> - **Backups keep deleted data.** A backup is a copy taken at one moment. A permanent deletion never rewrites existing backups. Data deleted after a backup was taken stays in that backup until the backup expires under the retention above (local pruning) and the remote lifecycle you set for off-site copies. A legal hold on a backup keeps it longer.
> - **A restore brings deleted items back.** Orders and customers deleted permanently after the backup's moment return in the state they had then. The restored `trash_purge_runs` table and audit tables are just as old.
> - **Delete them again before reopening.** Use the audit copy kept outside the database, in your SIEM or syslog destination, to list the `order.purged` and `customer.purged` events recorded after the backup's timestamp. Delete those items again from **Administration → Trash** before you reopen the portal to users.

Restores **never** overwrite the live database or live object storage directory in place. Instead, `restore-isolated.ts` decrypts and verifies any local or downloaded `.rpbk` archive (even if the live MySQL instance is completely unreachable during full-loss DR) into a brand-new `--target-db` and empty `--target-storage` directory.

### Exact Operator Restore Command

```bash
RP_RECOVERY_DATABASE_URL_FILE=/etc/readypackets/secrets/recovery_database_url \
RP_BACKUP_KEY_FILE=/etc/readypackets/secrets/backup_key \
RP_AUDIT_CHAIN_KEY_FILE=/etc/readypackets/secrets/audit_chain_key \
pnpm tsx scripts/ops/restore/restore-isolated.ts \
  --archive-file <PATH_TO_DOWNLOADED_OR_STORED_.rpbk> \
  --target-db rp_restore_<YYYYMMDD> \
  --target-storage /var/lib/readypackets-recovery/restore-<YYYYMMDD> \
  --confirm "RESTORE <BACKUP_PUBLIC_ID> TO rp_restore_<YYYYMMDD>"
```

### Optional Modes & Flags
- `--mode preserve_continuity` *(default)*:
  - Revokes **100% of sessions** (`auth_sessions`) in the restored target.
  - Deletes/revokes **all outstanding single-use tokens, password-reset tokens, email verification tokens, magic links, MFA challenge tickets, and file download tickets** so historic tokens captured in the backup cannot be replayed.
  - Cancels in-flight background job leases (`job_runs`) so restored workers do not double-execute side effects.
  - Advances TOTP replay watermarks (`assurance_accounts.last_totp_step`) past wall-clock restore time.
  - If `--live-db-url` / `DATABASE_URL` is reachable during a partial recovery or DR drill:
    - Verifies audit hash-chain ancestry (`audit_events` + `audit_chain_epochs`) against the live ledger and seals a new epoch boundary (`RESTORE_CONTINUITY_SEAL`) with a durable `backup.restore_completed` audit event.
    - Reconciles every user account (`users`, `assurance_accounts`, `assurance_passkeys`, `assurance_recovery_codes`, `http_rate_limit_counters`) against live state: suspended/locked/deleted statuses and role demotions carry forward; **any user whose status, role, password, or TOTP secret changed after the backup has their historic backup credential cleared fail-closed (`password_hash = NULL`, `must_change_password = 1`, `totp_secret_enc = NULL`)**; passkeys and recovery codes revoked after the backup are pruned.
  - If the live database is unreachable (catastrophic full-host loss), pass `--offline` to skip live-DB ledger comparison while still enforcing full session revocation, token invalidation, TOTP watermark advancement, Restored-Epoch Audit Sealing, and full HMAC chain verification of the restored audit log.
- `--mode point_in_time_forensic`:
  - Preserves user/account rows for forensic inspection (only available when `--offline` or non-cutover forensic review is intended; still revokes live session/job tokens so a forensic instance cannot hijack active workflows). Never expose a `point_in_time_forensic` target to end-user traffic.

---

## 6. Mandatory Pre-Cutover Operator Checklist

Before re-pointing `DATABASE_URL` and `STORAGE_LOCAL_DIR` in `/etc/readypackets/readypackets.env` to a restored target (`rp_restore_<YYYYMMDD>` and `/var/lib/readypackets-recovery/restore-<YYYYMMDD>`):

1. **Inspect JSON Verification Summary**:
   Confirm `restore-isolated.ts` exited `0` with `"auditChainVerified": true`, `"sessionsRevoked"`, and zero integrity mismatches.
2. **Review Accounts Changed Since Backup (`T_db -> Now`)**:
   - In `preserve_continuity` mode with live DB reachable, accounts whose role, status, password, or MFA changed since `T_db` were automatically quarantined (`must_change_password = 1`, historic `password_hash` / `totp_secret_enc` cleared).
   - In catastrophic `--offline` mode (where live DB state after `T_db` was lost), **manually audit privileged accounts (`system_admin`, `staff`) and recent HR/offboarding tickets** since `T_db`:
     - Suspend or disable any staff or customer account offboarded after `T_db`.
     - Verify role assignments for all `system_admin` and `staff` users.
     - Force password reset and MFA re-enrollment for any account suspected of credential rotation or compromise after `T_db`.
3. **Verify Audit Chain Continuity**:
   Sign in as `system_admin`, navigate to **Admin -> Audit Center**, and run **Verify Chain Integrity** across the restored epoch boundary.
4. **Cut Over Application Configuration**:
   - Stop `readypackets.service` and `readypackets-worker.service`.
   - Provision/grant the live application MySQL user least-privilege DML access to `rp_restore_<YYYYMMDD>` (and revoke write access to the retired schema).
   - Update `DATABASE_URL` and `STORAGE_LOCAL_DIR`, then start `readypackets.service` and `readypackets-worker.service`.
   - Immediately trigger a fresh baseline backup (`run-backup.ts --label "post-restore-baseline"`).

---

## 7. Configuring a 3-2-1 Off-Site Backup Strategy

A complete **3-2-1 backup strategy** keeps **at least three verified copies** of data across **at least two different storage systems** (for example, local host disk plus S3 or Azure Blob) with **at least one verified copy off-site**:

1. **Create and Test Cloud Storage Connections**:
   - Sign in as an administrator, open **Admin -> Storage**, create up to eight backup-capable connections (for example, S3-compatible object storage with Object Lock and Azure Blob Storage with an immutable policy), run **Test connection**, and enable each connection.
2. **Assign Off-Site Backup Destinations**:
   - Open **Admin -> Backups** and configure the **Off-site copies** form:
     - Select the storage connections assigned to backup replication (up to 8).
     - Toggle individual destinations **Active** or **Paused**, add an optional operator retention note (for example, bucket Object Lock / lifecycle policy details), and optionally enable **Copy after verification automatically**.
     - Save with fresh MFA step-up.
   - You can also trigger **Copy now** on any verified backup or **Retry** an individual destination from the backup detail page.
   - The **3-2-1 backup strategy status** card evaluates real verified local + digest-verified off-site copies within the configured freshness window — configuration alone never marks a condition as met.
3. **Key Separation & Non-Deletion Rules (Critical)**:
   - **Only verified encrypted `.rpbk` archives leave the host.** Every upload verifies both `verificationStatus = verified` and the `RPBK0001` wire header before streaming bytes to the remote adapter.
   - **The backup encryption key (`RP_BACKUP_KEY_FILE`, `/etc/readypackets/secrets/rp_backup_key`) NEVER leaves the host.** Store an independent offline copy of `rp_backup_key` and `rp_audit_chain_key` in a separate password vault, HSM, or sealed offline recovery kit on a different failure domain from both the portal host and the cloud bucket — without `rp_backup_key`, off-site `.rpbk` archives cannot be decrypted after full host loss.
   - **ReadyPackets never deletes remote copies automatically.** Local retention pruning only removes local disk copies; enforce remote lifecycle expiration and ransomware immutability (S3 Object Lock / Azure Immutable Storage) directly in your cloud storage provider.
4. **Restoring from an Off-Site `.rpbk` Copy**:
   - Download the `<BACKUP_PUBLIC_ID>.rpbk` object from your cloud bucket (`backups/<YYYY>/<MM>/<BACKUP_PUBLIC_ID>.rpbk`) onto your recovery host and pass `--archive-file` to `restore-isolated.js` (or `restore-isolated.ts` in source checkouts) together with your separately stored `rp_backup_key` and `rp_audit_chain_key`.

