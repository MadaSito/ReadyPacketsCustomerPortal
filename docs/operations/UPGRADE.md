# Upgrading a Native ReadyPackets Installation

Step-by-step operator guide for upgrading an active native installation (created with [`deploy/auto-install.sh`](AUTO_INSTALL.md) or [`deploy/install.sh`](INSTALL.md)) from `/opt/readypackets-src`.

---

## 1. Prerequisites before starting

1. **Interactive SSH session** to the server with `sudo` access (use `tmux` or `screen` on unstable links so a dropped SSH connection cannot interrupt the prompt sequence).
2. **Disk and memory headroom**: at least **3 GB** free under `/opt` for staging and promoting the new release, plus at least **2× the size of `/var/lib/readypackets/storage` + 1 GB** free under `/var` for the verified `pre_upgrade` backup. (`deploy/upgrade.sh` checks both before stopping services, and automatically re-enables `/swapfile.readypackets` if present.)
3. **Separate key custody**: ensure you already hold a separate off-host copy of `/etc/readypackets/` (specifically `/etc/readypackets/secrets/rp_backup_key` and `/etc/readypackets/secrets/rp_data_keyring`). Encrypted `.rpbk` backup archives **never** embed the backup key.
4. **Node.js**: Run `/usr/local/bin/node --version` before enabling maintenance. The release requires Node.js `>=22.13.0 <23`; update that executable using a trusted distribution channel if needed, then rerun the upgrader. The upgrader stops during preflight if the installed Node version is unsupported, before it stages the release or drains traffic. The fresh-install pin (`22.23.5`) is already compatible.

---

## 2. Prepare `/opt/readypackets-src` at the reviewed commit

Run every Git operation as `root` with `umask 022` so `/opt/readypackets-src` stays root-owned (`0:0`) with no group or world write bits (`deploy/upgrade.sh` verifies source custody and refuses to run if `HEAD` does not match the target commit):

```bash
# 1. Fetch and check out the reviewed release commit or branch head as root:
sudo sh -c '
  umask 022
  cd /opt/readypackets-src
  git fetch --prune origin
  git checkout --detach origin/main
'

# 2. Inspect the exact commit you are about to deploy:
git -C /opt/readypackets-src log -n 1
```

If `/opt/readypackets-src` had remote credentials stripped after installation (for a private repository), configure temporary read-only deploy access first and remove it again after step 2.

---

## 3. Switch on Maintenance mode in the portal (if MFA is enrolled)

Before running `upgrade.sh` (or while it builds the release, before confirming `DRAINED`):

1. Sign in to the portal as an administrator and open **Administration → Maintenance** (`/admin/maintenance`).
2. Click **Start maintenance** and confirm with fresh MFA.
3. Wait until **Drain status** reads **Queue drained** (`Running jobs: 0`, `Unresolved outcomes: 0`).
   - If **Unresolved outcomes** is greater than `0`, open **Administration → Jobs** (`/admin/jobs`) and reconcile those items before upgrading (`deploy/upgrade.sh` refuses to proceed while unresolved `unknown` jobs exist).
   - If no administrator has enrolled MFA yet on a brand-new server, confirm no external writers are active; `deploy/upgrade.sh` still verifies `running = 0` and `unresolved = 0` in MySQL directly.

---

## 4. Run `deploy/upgrade.sh`

From `/opt/readypackets-src`, pass the full 40-character commit SHA checked out at `HEAD`:

```bash
cd /opt/readypackets-src
TARGET_SHA=$(git rev-parse HEAD)
sudo bash deploy/upgrade.sh "$TARGET_SHA"
```

What `deploy/upgrade.sh` does and asks at each gate:

1. **Preflight and isolated build (portal still online)**:
   - Verifies root custody of `/opt/readypackets-src`, `HEAD == $TARGET_SHA`, clean tracked files, Nginx config (`nginx -t`), TLS files, database/key secret files, swap, and free disk space.
   - Installs Ubuntu's `ffmpeg` and `util-linux` packages if needed, before stopping services or starting database work. On minimal hosts the kit enables the `universe` package component if FFmpeg has no candidate. Allow access to your approved Ubuntu mirrors.
   - Builds and promotes `/opt/readypackets/releases/$TARGET_SHA` under the unprivileged `readypackets-build` sandbox (`InaccessiblePaths=/etc/readypackets`).
   - Prints live MySQL queue counts (`Current release`, `Target release`, `Portal maintenance`, `Running jobs`, `Unresolved unknown`) and prompts:
     - Type **`DRAINED`** to fence public traffic (`/etc/nginx/readypackets-maintenance` → HTTP `503` externally) and stop `readypackets-portal.service` and `readypackets-worker.service`.
   - Verifies clean zero-exit shutdown of both services (`ExecMainStatus=0`) and re-verifies `running_jobs = 0` and `unknown_jobs = 0` in MySQL.

2. **Verified pre-upgrade encrypted backup**:
   - Runs `readypackets-backup@pre_upgrade.service` (`run-backup.js --trigger pre_upgrade --verify`).
   - Verifies the new `backup_archives` row in MySQL (`state = 'completed'`, `verification_status = 'verified'`) and checks the on-disk `.rpbk` file size.
   - Prints the exact **`Backup ID`**, **`Encrypted file`** path (`/var/lib/readypackets/storage/backups/<32hex>`), **`SHA-256`**, and **`Backup key`** path so you can copy the archive off-host from another terminal before migrations run:
     ```bash
     # Example from your workstation:
     scp user@my.readypackets.com:/var/lib/readypackets/storage/backups/<32hex> ./
     ```
     (If the file is `0600 readypackets:readypackets`, copy it as root on the server to a root-only staging path or stream over SSH with `sudo cat /var/lib/readypackets/storage/backups/<32hex>`.)
   - Compare the off-host archive's SHA-256 to the printed digest and confirm the backup and application keys are recoverable from separate off-host custody. Only then type **`BACKUP-VERIFIED`**. `--yes` skips confirmation, not the local verified backup; automation must arrange and verify off-host custody separately.

3. **Forward database migration, atomic release switch, Nginx render, and health verification**:
   - Runs `dist/ops/migrate.js` under the scoped `rp_migrator` MySQL account.
   - Updates `/opt/readypackets/previous` to the prior release and `/opt/readypackets/current` to `$TARGET_SHA` atomically.
   - Installs updated systemd unit files and re-renders `/etc/nginx/snippets/readypackets-edge.conf`, `/etc/nginx/snippets/readypackets-tls.conf`, and `/etc/nginx/sites-available/readypackets-portal.conf` from `/opt/readypackets-src/deploy/nginx/*.template`, runs `nginx -t`, and reloads Nginx while public traffic remains fenced.
   - Starts `readypackets-worker.service` and `readypackets-portal.service` and verifies `/healthz` and `/readyz` on both `127.0.0.1:5000` and the local TLS edge (`https://<domain>/readyz`).
   - Optionally inspect journals in a second terminal (`sudo journalctl -u readypackets-portal.service -u readypackets-worker.service -n 50 --no-pager`), then type **`REOPEN`** to remove `/etc/nginx/readypackets-maintenance`, re-enable the services (and `readypackets-backup.timer` if it was enabled), and clear `/etc/readypackets/upgrade-state`.

---

## 5. Post-upgrade checks

1. If you enabled **Maintenance mode** in step 3, sign back in to **Administration → Maintenance** (`/admin/maintenance`) and click **End maintenance** (requires fresh MFA) so background workers resume claiming jobs.
2. Verify `/readyz` from the server:
   ```bash
   curl --silent --show-error --fail --resolve my.readypackets.com:443:127.0.0.1 https://my.readypackets.com/readyz
   ```
3. All new Increment 03 capabilities (external OIDC sign-in, e-mail template overrides, cloud storage connections, off-site backup copies, SharePoint order sync, and event/scheduled automations) **ship disabled by default** and change nothing until an administrator configures and enables them in the console.
4. If an administrator loses access to their password or second factors on the host, see [Offline Administrator Recovery](ADMIN-RECOVERY.md).

## Increment 04 and migration `0003`

The native CI job is configured to start from Increment 03 at `89c5cb8`, enroll an administrator in MFA, seed customer and order data, upgrade to Increment 04 including [Part B](../engineering/INCREMENT_04_PART_B.md), and check that `0003_increment_04` and `0004_increment_04_part_b` are each recorded once. This is not acceptance on a live host. Rehearse the reviewed release and migrations on an isolated restore before upgrading production. Migration `0003_increment_04` adds 48 tables and 10 nullable columns; `0004_increment_04_part_b` adds the order workspace schema. MySQL DDL can still be partially applied if the upgrade is interrupted.

1. **Prepare**: In the root-owned `/opt/readypackets-src` checkout, fetch and check out the exact reviewed full Increment 04 commit as in [section 2](#2-prepare-optreadypackets-src-at-the-reviewed-commit). Check that `HEAD` matches and the tracked tree is clean.
2. **Drain**: Sign in with local administrator MFA, start worker maintenance at `/admin/maintenance`, and wait for zero running jobs and zero unresolved outcomes. Reconcile unknown jobs and stop other writers before proceeding. The new customer maintenance setting is separate; it does not drain jobs.
3. **Run the same upgrader**: In `/opt/readypackets-src`, run `sudo bash deploy/upgrade.sh <reviewed-full-commit-sha>` without `--yes`. The script installs missing Ubuntu `ffmpeg` and `util-linux` packages before stopping services. At `DRAINED`, verify the displayed counts and confirm that public traffic can be fenced.
4. **Back up before migration**: Record the verified backup ID; copy its encrypted archive off-host and compare its SHA-256 against the printed digest. Ensure the backup key is in separate off-host custody and that the application keys needed for recovery are available separately. Only then type `BACKUP-VERIFIED`.
5. **Migrate and reopen**: Let the script apply both pending migrations, switch releases, refresh Nginx and check loopback and HTTPS edge health/readiness while traffic remains fenced. Do not run the migration files separately. Confirm `REOPEN` only after those checks pass. Sign in with MFA, use **End maintenance** to resume worker claims, and confirm edge readiness, a representative customer order, and normal queue processing.

If migration starts and anything fails, keep writers stopped and ingress fenced. Reconcile the Drizzle journal and actual schema with the reviewed migration; either complete the forward fix under DBA review or restore the verified pre-upgrade backup into clean isolated targets and validate the prior release there. Do not delete the journal entry, drop new columns to undo the upgrade, or just swap the `current` symlink back. If traffic has already reopened, account for writes made after the backup before using any restored database as production.

### What to switch on first

- **Baseline**: Verify local administrator MFA, the recovery procedure, the audit trail, and `/admin/storage/copies`. The read-only Copy log needs no switch. New optional features are off by default; Increment 03 settings already in use are not reset.
- **Protection**: Review events in Detect mode before enforcing rules. There are no country blocks by default and no MMDB is bundled. If needed, configure a local read-only MMDB and confirm address/country behavior and administrator recovery before enabling restrictions. See [Media and country database setup](MEDIA_AND_GEOIP.md).
- **Customer features**: Enable and exercise one feature at a time with synthetic data in staging. Start with Knowledge or workflow configuration. FFmpeg being installed does not enable recording or conversion; test a conversion and confirm that the original is retained before enabling this for customers.
- **Order file sync**: Review existing order-file assignments. For new copies, a slot folder overrides the workflow folder, and the default is `customers/{customer_ref}/orders/{order_ref}/{phase}`. Test a synthetic file end to end and compare the path in the order’s File sync tab and the Copy log. An optional path in a workflow does not turn on a storage destination or move a previously copied file.
- **External services**: Confirm consent behavior before enabling analytics, and use a test receiver for API/webhooks. Leave `payments.config.provider` at `none` until you have verified the hosted redirect, signed callback, provider read-back and invoice result in the provider's test environment.

## Increment 05 and migration `0005`

Migration `0005_increment_05` is additive. It adds eight tables: one workflow import ledger, three for cart upsell offers and activity, and four for promotion batches, codes, redemptions, and check attempts. It adds nine columns and their supporting indexes: six promotion fields on `carts`, two on `orders`, and nullable source context on `policy_acceptances`. The order promotion discount defaults to zero; the other new columns on existing tables are nullable. Imported workflows are drafts stored in the existing workflow tables. The upgrade does not rewrite previous acceptance evidence.

- **Native upgrade**: Use the reviewed Increment 05 commit and follow sections 2–5. Rehearse on an isolated restore first. Keep writers stopped and public traffic fenced while the verified `pre_upgrade` backup is copied and checked off-host, then let the upgrader apply all pending journal entries in order. If upgrading from Increment 04 Part B, only `0005` should be pending. Never run its SQL separately or mark it applied by hand.
- **Docker Compose**: The image ships the same SQL and journal, but its wrapper has no automatic backup or rollback. Before updating an existing stack, stop writes, take a consistent database and storage backup, and confirm that the required secret volumes can be restored from separate custody. Follow the [Compose upgrade and backup notes](../../deploy/docker/README.md) rather than running the native upgrader.
- **Refresh the proxy**: Workflow import needs the reviewed proxy config for its two exact POST endpoints, `/api/trpc/orders.admin.workflows.transfer.preview` and `/api/trpc/orders.admin.workflows.transfer.applyImport`. Their body limit is 4,456,448 bytes (4 MiB plus 256 KiB for JSON overhead). Do not raise the general 256 KiB limit. The native upgrader renders the new Nginx templates, runs `nginx -t` and reloads Nginx before reopening traffic; the native upgrade smoke job checks those routes after promotion. The Compose wrapper stops and restarts Caddy with the checked-out `Caddyfile`. If you manage a proxy separately, install the equivalent rules, validate the configuration, and reload or recreate the proxy while ingress is still fenced, before enabling workflow import.
- **After upgrade**: Confirm readiness, local administrator MFA, and a pre-existing customer and order. Check that the policy acceptance log still shows representative existing evidence. Cart upsell and promotions remain off until enabled; verify optional changes with synthetic data before exposing them to customers.
- **If migration fails**: MySQL may have applied only some statements. Keep writers stopped and ingress fenced. Follow [section 6](#6-recovery-if-an-upgrade-stops-mid-way): reconcile the journal and schema, then complete a reviewed forward fix or restore the verified backup to isolated clean targets. Do not drop new columns, delete journal entries, or switch binaries as a substitute for database recovery.

## Increment 06 and migration `0006`

`0006_increment_06` adds 17 tables for receipts, order tasks, policy notices and enforcement, protection, reporting and security incidents. It adds 13 columns and widens `promo_batches.discount_type` to allow `set_total`, with no drops. Older binaries might not understand new promotion values after the updated portal starts writing them. The native installer, upgrader and container image require the SQL and journal entry and apply pending migrations in order. If coming directly from Increment 05, only `0006` should be pending. Rehearse against an isolated restore of the reviewed release first.

- **Native upgrade**: Follow sections 2–5 without `--yes`. Keep writers stopped and ingress fenced. Before migration, copy the verified encrypted `pre_upgrade` archive off-host, verify its printed SHA-256 digest, and confirm that backup and application keys are recoverable from separate custody. Only then type `BACKUP-VERIFIED`. If migration is interrupted, follow [section 6](#6-recovery-if-an-upgrade-stops-mid-way); do not manually mark SQL applied or use a symlink rollback in place of database recovery.
- **Docker Compose**: Follow the [Compose backup and upgrade instructions](../../deploy/docker/README.md). Stop writers, back up consistent database and storage data, and verify separate secret custody before changing the image. The wrapper does not take the native verified backup. Initial install and restart CI check the new migration hash exactly once; neither substitutes for a cross-version restore rehearsal.
- **PWA edge and verification**: Reload the reviewed proxy configuration while still fenced. `/sw.js` and `/manifest.webmanifest` must keep upstream `no-cache` or `no-store`, never immutable or a long `max-age`. Check that `/sw.js` returns `Service-Worker-Allowed: /`, and that `/offline.html` loads without signing in. On a staging browser, verify install, offline navigation, sign-out cache clearing and the prompted reload. The service worker must not substitute cached data for requests to protected APIs or downloads.
- **Recordings**: The multipart POST `/api/files/upload/<order-ULID>` allows a 256 MiB request across the bundled proxies without raising the 256 KiB general limit. The browser mic targets 48 kbps; the administrator must configure an adequate file limit for long recordings. Original Apple-compatible uploads are still subject to the effective upload cap (at most 100 MiB per original); large uncompressed audio may need splitting or compression. The 256 kbps setting governs the converted output, not the uploaded original. Two hours at that rate is about 220 MiB before container overhead; the conversion uses a separate internal ceiling.
- **Document editor**: POST `/api/files/orders/<order-ULID>/<file-ULID>/document` has a 10 MiB + 16 KiB body envelope in the bundled proxies. The app still enforces the configured policy, authentication and DOCX validation. Do not turn this into a blanket allowance for other API routes.
- **PDF previews**: `pdfjs-dist` runs in the browser and requires Node.js 22.13.0 or later to install. `@napi-rs/canvas` is a development-only dependency for test rendering. `pnpm-workspace.yaml` ignores PDF.js's optional native canvas dependency, and native and Docker release packaging prune development dependencies, so the production runtime does not ship the native canvas binary.
- **Emergency access**: Keep the [break-glass runbook](BREAK_GLASS.md) available off-host and verify operator access before enabling ban or policy enforcement. These are narrow overrides for different controls, not alternatives to local administrator MFA.

## Increment 07 and migration `0007`

<!-- platform_engineer with http_security_engineer. Counts from /root at f4fa798; lead QA 2026-11-25. A reverse proxy with TLS on a VPS and the Docker image build were not verifiable in the QA environment. -->

`0007_increment_07` is additive: new tables, nullable columns or columns with defaults, new indexes and enum widening. It drops and renames nothing. Seeding and backfill run in code at start-up and are idempotent; the migration contains no data SQL. It has 16 new tables, 40 new columns on 11 existing tables and one widened enum (`payment_webhook_events.status`) in 96 statements, with no `DROP`. Reported by /root at `f4fa798`: it applied cleanly on a copy of an increment 06 database (189 → 205 tables, 8 migrations), and existing orders got `payment_state = not_required` and `attention = none`. The schema is frozen for increment 07; any further change would need `0008`.

- **New tables:** `order_stage_progress`, `order_status_catalog`, `order_questions`, `order_question_answers`, `order_admin_tasks`, `order_stage_runs`, `order_completion_jobs`, `operational_alerts`, `file_playback_grants`, `file_archives`, `file_archive_tickets`, `storage_managed_order_roots`, `storage_managed_file_copies`, `payment_webhook_rejections`, `sso_saml_certificates` and `sso_role_mappings`.
- **New columns:** `orders` (7: progress, completion, attention and payment state), `sso_configuration` (8, SAML), `integration_webhook_deliveries` (7), `integration_production_dispatches` (6), `sso_auth_requests` (3), `file_access_log` (2), `storage_connections` (2), `payment_webhook_events` (2), and one each on `order_files` (`stage_key`), `integration_webhook_subscriptions` (`signing_enabled`) and `automations` (`sort_order`).

Existing orders keep their pinned workflow version. The start-up job `orders.increment07.startup` runs once at every boot and then every 10 minutes. When no published version or draft has phases, it gives the default workflow one draft with phases derived from its statuses, for you to review and publish. It publishes nothing and re-pins no order. It also recalculates the stored progress of orders on phases (format 3) versions. In the lead's QA, the boot run finished about 200 ms after the server started listening.

- **Native upgrade.** Follow sections 2–5 without `--yes`, with the same backup, fence and `BACKUP-VERIFIED` steps as for increment 06.
  - Release validation requires the SQL file and journal entry `0007_increment_07`.
  - Install and upgrade compare its SHA-256 with exactly one migration journal row. Never run the SQL by hand or mark it applied.
  - The seeded native baseline used in CI (`f251a10`) checks that an existing order keeps its workflow pin after the upgrade.
  - If the migration is interrupted, follow [section 6](#6-recovery-if-an-upgrade-stops-mid-way).
- **Docker Compose.** The image build requires the same SQL and journal entry, and the Compose smoke test checks the hash against exactly one journal row. Follow the [Compose backup and upgrade instructions](../../deploy/docker/README.md); the wrapper does not take the native verified backup.
- **Refresh the proxy while ingress is still fenced.** The bundled Nginx and Caddy configurations contain the rules below. If you manage your own proxy, install the equivalent rules, validate them and reload before reopening.
  - **SAML** (only the canonical host over HTTPS; requests over HTTP or on alias hosts are rejected, not redirected):
    - `GET /api/identity/saml/metadata`
    - `GET /api/identity/saml/start`
    - `POST /api/identity/saml/acs`. The match is exact and POST only. The body is a flat URL-encoded form of at most 256 KiB, with no decompression and no caching.
    - Sensitive request data never goes into proxy or application request logs. This covers the assertion and form body, request headers including cookies, and callback query material such as the start ticket or completion attempt. Application logs record only a fixed route label, the method, the status and the correlation id.
  - **Audio playback** (`GET` / `HEAD /api/files/playback/:grantPublicId`):
    - `Range` and `If-Range` are forwarded to the portal unchanged;
    - the proxy must not buffer or build its own 206 answer.
    - The POST that creates playback grants keeps the existing Origin and CSRF checks.
    - **ZIP download** (`POST /api/files/archives/download`) is a native form POST. Because the portal sends `Referrer-Policy: no-referrer`, browsers send `Origin: null` on it. The portal accepts that value only for this exact form, and only with `Sec-Fetch-Site: same-origin`, `Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest` of `document` or `empty`. The session, the form CSRF token and a single-use, account-bound ticket are still required. Do not strip or rewrite the `Origin` or `Sec-Fetch-*` headers.
  - **Stripe webhook** (`POST /api/payments/webhooks/stripe`, canonical host):
    - it skips only the built-in country allow-list;
    - the IP deny list, rate limits, the 256 KiB cap and signature (HMAC) verification all stay.
- **After the upgrade:**
  - confirm readiness, local administrator MFA, and that a pre-existing order still shows its status and now shows a progress bar;
  - **Stripe:** check `/admin/payments/setup` (webhook URL, events, egress switch, self-test) before relying on Stripe completion;
  - **SAML:** keep at least one local administrator with MFA before switching it on. An upgraded existing SSO configuration starts in `portal` MFA mode; `claim` is recommended for new setups, and `entra` needs the typed words `ENTRA MANAGES MFA`. Switching protocol disables SSO until you enable it again;
  - **Off until configured:** SAML, file sync targets, receipts to Microsoft 365, the P101 / P201 auto-queue (per workflow), production pipeline payload signing (generate a secret first) and attention reminders. Phase actions are empty until you configure them. New webhook subscriptions are signed by default and start paused. Test each with synthetic data before using it with customers.
  - **Not tested against real services** in the lead's QA: a real Stripe account, an Entra tenant, a SharePoint site, the production P101 / P201 receiver, SMTP, the Docker image build, and a reverse proxy with TLS on a VPS.

---

## 6. Recovery if an upgrade stops mid-way

Never delete `/etc/readypackets/upgrade-state` or `/etc/nginx/readypackets-maintenance` blindly. Inspect `/etc/readypackets/upgrade-state` (`sudo cat /etc/readypackets/upgrade-state` — read as data, never `source` it):

- **`phase=draining` or `phase=backup` (before `migration_started`)**:
  - Database migrations have **not** started and `/opt/readypackets/current` still points to the old release.
  - Inspect `sudo journalctl -u readypackets-portal.service -u readypackets-worker.service -u readypackets-backup@pre_upgrade.service -n 80 --no-pager` and resolve the cause.
  - Restart the existing release while still fenced (`sudo systemctl start readypackets-worker.service readypackets-portal.service`), verify `/readyz`, re-enable the units (`sudo systemctl enable readypackets-worker.service readypackets-portal.service`), and remove `/etc/nginx/readypackets-maintenance` and `/etc/readypackets/upgrade-state` once healthy (or re-run `upgrade.sh` after clearing those two files once the prior release is confirmed active and clean).
- **`phase=migration_started` or `phase=verifying`**:
  - Keep public traffic fenced (`/etc/nginx/readypackets-maintenance` present) and services stopped.
  - Do **not** repoint `/opt/readypackets/current` back to `/opt/readypackets/previous` without verifying database compatibility: MySQL DDL is not transactional across statements.
  - Inspect `sudo journalctl -n 100 --no-pager` and `SELECT * FROM readypackets.__drizzle_migrations;`. Either complete the forward fix with DBA review, or restore the verified `pre_upgrade` archive recorded in step 4 onto isolated clean targets using [`BACKUP_AND_RESTORE.md`](BACKUP_AND_RESTORE.md).
