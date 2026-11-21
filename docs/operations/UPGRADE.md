# Upgrading a Native ReadyPackets Installation

Step-by-step operator guide for upgrading an active native installation (created with [`deploy/auto-install.sh`](AUTO_INSTALL.md) or [`deploy/install.sh`](INSTALL.md)) from `/opt/readypackets-src`.

---

## 1. Prerequisites before starting

1. **Interactive SSH session** to the server with `sudo` access (use `tmux` or `screen` on unstable links so a dropped SSH connection cannot interrupt the prompt sequence).
2. **Disk and memory headroom**: at least **3 GB** free under `/opt` for staging and promoting the new release, plus at least **2× the size of `/var/lib/readypackets/storage` + 1 GB** free under `/var` for the verified `pre_upgrade` backup. (`deploy/upgrade.sh` checks both before stopping services, and automatically re-enables `/swapfile.readypackets` if present.)
3. **Separate key custody**: ensure you already hold a separate off-host copy of `/etc/readypackets/` (specifically `/etc/readypackets/secrets/rp_backup_key` and `/etc/readypackets/secrets/rp_data_keyring`). Encrypted `.rpbk` backup archives **never** embed the backup key.

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
   - Type **`BACKUP-VERIFIED`** to proceed.

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
