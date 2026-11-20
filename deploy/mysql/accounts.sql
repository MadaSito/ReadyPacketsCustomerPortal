-- ReadyPackets / MySQL 8.4. REVIEW AND SUBSTITUTE all __RP_*__ placeholders.
-- Run Phase A once, from a secured local DBA console. RANDOM PASSWORD returns
-- credentials to that console; do not pipe output into logs or store it in Git.
-- Do not use IF NOT EXISTS to adopt accounts with unknown pre-existing grants.
-- Use skip_name_resolve=ON, bind-address=127.0.0.1, and a certificate/SAN matching
-- the DSN host. __RP_SCHEMA__ must be alphanumeric/underscore for backup compatibility.

-- Phase A: before install.sh.
CREATE DATABASE `__RP_SCHEMA__` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER '__RP_APP__'@'127.0.0.1' IDENTIFIED BY RANDOM PASSWORD REQUIRE SSL;
CREATE USER '__RP_MIGRATOR__'@'127.0.0.1' IDENTIFIED BY RANDOM PASSWORD REQUIRE SSL;
-- Exception: the current backup snapshot client cannot negotiate verified TLS from the
-- app's DSN TLS options. LOCAL LOOPBACK ONLY; see INSTALL.md and VERIFICATION.md.
CREATE USER '__RP_BACKUP__'@'127.0.0.1' IDENTIFIED BY RANDOM PASSWORD;

GRANT SELECT, INSERT, UPDATE, DELETE ON `__RP_SCHEMA__`.* TO '__RP_APP__'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES
    ON `__RP_SCHEMA__`.* TO '__RP_MIGRATOR__'@'127.0.0.1';
GRANT SELECT, SHOW VIEW, TRIGGER, EVENT ON `__RP_SCHEMA__`.* TO '__RP_BACKUP__'@'127.0.0.1';
-- Current mysqldump disables table locks, tablespaces, GTID purge and flushes; no
-- LOCK TABLES, RELOAD, PROCESS or global privileges are granted by default. If
-- a reviewed dump approach needs locks, scope LOCK TABLES to this schema. Use
-- a separate temporary DBA workflow for global RELOAD, not the persistent account.

-- Phase B: after install.sh creates tables, before running any backup.
-- Backup's CLI uses this same account to persist its run, audit and verification ledger.
GRANT INSERT, UPDATE ON `__RP_SCHEMA__`.`backup_archives` TO '__RP_BACKUP__'@'127.0.0.1';
GRANT INSERT ON `__RP_SCHEMA__`.`backup_verifications` TO '__RP_BACKUP__'@'127.0.0.1';
GRANT INSERT ON `__RP_SCHEMA__`.`audit_events` TO '__RP_BACKUP__'@'127.0.0.1';

-- Future/optional audit DB split (NOT applied above, NOT wired by this release):
-- 1. REPLACE schema-wide runtime DML with reviewed per-table grants. MySQL adds
--    grants; a narrow table grant does not subtract a schema-wide privilege.
-- 2. Grant SELECT, INSERT only on audit_events, audit_chain, audit_checkpoints
--    and audit_tombstones; separately retain SELECT/INSERT/UPDATE on audit_chain_head.
-- 3. Move DELETE ON audit_events to a dedicated TLS-required retention account
--    with its own credential and transaction (including reads, tombstones, and
--    run/hold fencing). Do not grant DELETE to the runtime in that architecture.
-- Today retention shares the runtime pool; a narrower runtime policy denies
-- retention deletes. Never claim database-enforced append-only with Phase A.
