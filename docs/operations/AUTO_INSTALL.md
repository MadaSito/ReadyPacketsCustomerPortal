# Automatically install ReadyPackets on Ubuntu 26.04 LTS

Use the native installer on a fresh, dedicated Ubuntu 26.04 LTS server. It sets up Nginx, MySQL, the portal and its background worker, then creates the first administrator and saves the temporary sign-in details in a root-only file. You choose the portal address before installation.

## Before you start

- **Server:** Ubuntu 26.04 LTS on amd64 (`x86_64`) or arm64 (`aarch64`), with systemd running and root or `sudo` access. Use at least 1 GB RAM with a swap file; 2 GB RAM is recommended. Plan for at least 4 GB free on the filesystems holding `/opt`, `/var` and `/`, with about 6 GB on `/` if the installer adds swap. Allocate additional space for uploads, releases and backups.
- **DNS:** Choose a DNS name such as `my.readypackets.com`, not an IP address. Publish an A record pointing to the server's public IPv4 address. Publish an AAAA record only if the server is reachable on that IPv6 address. Do the same for an optional redirecting alias.
- **Network:** Start with no other service listening on port 80 or 443. On a fresh host the installer checks for those listeners before installing packages. Allow inbound TCP 80 for Let's Encrypt HTTP validation and 443 for HTTPS, and keep SSH reachable from your management network. The installer does not configure firewall or cloud security-group rules. Do not expose MySQL or the portal's internal port. The server needs outbound access to Ubuntu's package sources, `nodejs.org`, the public npm registry and, for a public certificate, Let's Encrypt.
- **Repository:** Clone as root with `umask 022` into `/opt`. Before reading the kit, the installer checks that the clone, its contents and its parent directories are root-owned and not group- or other-writable, and that it holds only plain files and directories (symbolic links are refused; the repository has none, so do not install dependencies inside the clone). A root-owned sticky directory above the clone is allowed but is not the recommended layout. Use a reviewed commit with no changes to tracked files. If you make the repository public, it only needs to be reachable for the clone. Once cloned, the build uses local Git objects and the public npm registry; the running services do not require GitHub access. A repository-scoped, read-only SSH deploy key avoids making the repository public. Configure the key and verify GitHub's host key for the root account that will clone, then use `git@github.com:MadaSito/ReadyPacketsCustomerPortal.git` in place of the HTTPS URL.

## Quick start

Run these commands on the server. Git is installed first only to fetch the installer; everything else the installer needs is set up by the kit. Replace the example domain and email, and check that the clone is at the reviewed revision before running it.

```bash
sudo apt-get update && sudo apt-get install -y git
sudo sh -c "umask 022 && git clone https://github.com/MadaSito/ReadyPacketsCustomerPortal.git /opt/readypackets-src"
cd /opt/readypackets-src
sudo bash deploy/auto-install.sh --domain my.readypackets.com --acme-email you@example.com
```

For a redirect from `portal.readypackets.com`, add `--alias portal.readypackets.com` and set up its DNS first. For unattended execution, supply all required choices explicitly and add `--yes`. Use a private terminal or retrieve the password as root from the saved file; avoid terminal recordings and shared output.

| Option | What it does |
| --- | --- |
| `--domain <host>` | Sets the canonical HTTPS host. If omitted in a terminal, the installer prompts and offers `my.readypackets.com`; without a terminal, this option is required. |
| `--alias <host>` | Sets a different DNS name that redirects to the canonical address. It does not serve a second portal. Omit for no alias. |
| `--acme-email <email>` | Uses Let's Encrypt and sets its contact address. Supplying it accepts the Let's Encrypt Subscriber Agreement. Cannot be combined with `--tls-self-signed`. |
| `--tls-self-signed` | Issues a self-signed certificate for testing. Browsers warn and may refuse passkeys. If neither certificate option is given in a terminal, the installer asks for an ACME email; a blank answer selects self-signed TLS. Without a terminal, one certificate option is required. |
| `--admin-email <email>` | Sets the first administrator's `Sign-in name`. Defaults to the ACME email or `admin@<domain>`; in a terminal it prompts on first setup when omitted. Provide `--admin-email` explicitly to suppress that prompt even with `--yes`. |
| `--admin-name "<name>"` | Sets the first administrator's display name. Defaults to `Portal Administrator`. |
| `--skip-catalog` | Does not load the bundled offerings (packets, tiers and prices). To load them later, rerun without this option or use the [manual catalog procedure](INSTALL.md#load-the-offerings-catalog-optional). |
| `--skip-dns-check` | Skips the installer's DNS and HTTP probe through the public address. It does not skip the local Nginx challenge check or the certificate authority's validation. |
| `--swap auto\|yes\|no` | `auto` (default) tries to add a 2 GB swap file if RAM plus existing swap is below 3 GB. `yes` requests the file even if memory is plentiful. `no` does not create it; the build still needs about 2 GB total memory including swap. A swap file left by an earlier run is reused if it is still a private, root-owned regular file (anything else at that path stops the run); with `no` it is left exactly as it is. |
| `--print-credentials` | When there is no controlling terminal, allows the initial credentials to be printed once to standard output. Leave it off in shared or recorded automation and read the root-only file instead. It cannot display the password a second time. |
| `--yes` or `-y` | Skips the final `Install now?` confirmation. It does not supply missing options. |
| `--help` or `-h` | Shows help without installing anything. |

`RP_ACME_SERVER=<directory URL>` is a test-only environment override for the ACME directory, such as a staging service. Before installing, add that authority's root certificate to the server's trust store using `/usr/local/share/ca-certificates/` and `sudo update-ca-certificates`; otherwise the final TLS health check fails. Keep test certificate lineages separate from production: the installer reuses the `readypackets-portal` lineage when present and covering the names rather than requesting a replacement from a different authority.

## What the installer changes

1. Checks the OS, processor, memory, disk and operation state, then asks for confirmation unless `--yes` was given. Native deployment operations are serialized using `/run/readypackets-deploy.lock`.
2. Adds swap if requested or needed, then installs Nginx, MySQL server and client tools (it requires MySQL 8.4), Git, curl, OpenSSL, CA certificates and xz tools from Ubuntu. It installs Certbot only for a public certificate. If Certbot is unavailable because Ubuntu's `universe` component is disabled, it installs `software-properties-common` and enables `universe` with `add-apt-repository`. It installs checksum-verified Node.js `22.23.5` and pnpm `12.21.0` on a fresh host. A compatible pre-existing Node 22 runtime at `/usr/local/bin/node` is kept; an incompatible unmanaged runtime is refused.
3. Configures MySQL on loopback with verified TLS and creates the `readypackets` database and three separate accounts: `rp_app`, `rp_migrator` and `rp_backup`. Each account is bound to `127.0.0.1` and requires TLS. Once migrations create the ledger tables, the installer grants the backup account its scoped ledger writes.
4. Saves the host, optional alias and certificate mode in `site.conf`. It refuses other enabled Nginx sites, removes the enabled link for the untouched Ubuntu default page if present and keeps the default template itself. It obtains a Let's Encrypt certificate using a temporary HTTP site where needed, or generates a self-signed certificate. The final portal site retains the HTTP-01 path for renewal and redirects other known HTTP traffic to HTTPS. Every server block in the final site includes the edge snippet, which keeps server tokens, gzip, logging and TLS policy at server level rather than duplicating settings in Ubuntu's `nginx.conf`. Named TLS servers use HTTP/2 on Nginx 1.25.1 or newer (Ubuntu 26.04 ships 1.28).
5. Builds the pinned Git commit under a separate `readypackets-build` user with a frozen lockfile, publishes a root-owned release, migrates MySQL and installs systemd units. It creates the first administrator if none exists, then starts web and worker under the unprivileged `readypackets` account. It checks local and Nginx TLS health and readiness plus worker state before opening the site.
6. Runs a dry run of the catalog import, then loads the offerings unless skipped. Prints the portal address and next steps when the installation finishes, with one-time credential display as described below.

| Path | What is stored or changed |
| --- | --- |
| `/opt/readypackets-src` | The root-owned source clone from the quick start, not created by the installer itself. |
| `/swapfile.readypackets`, `/etc/fstab` | When the installer creates the 2 GB swap file, it makes it root-only and records it in `/etc/fstab` so it remains active after reboot. |
| `/usr/local/lib/readypackets-node/v22.23.5/node`, `/usr/local/lib/readypackets-pnpm/12.21.0/pnpm` | Verified executable files; `/usr/local/bin/node` and `/usr/local/bin/pnpm` link to them on a fresh installation. The Node install does not add npm, npx or Corepack. |
| `/etc/mysql/mysql.conf.d/zz-readypackets.cnf`, `/etc/mysql/readypackets-tls/` | Loopback, name-resolution, local-file and TLS settings. Database TLS files are `ca.pem`, `server-cert.pem` and `server-key.pem`; the temporary database CA signing key is discarded. MySQL uses its package data directory under `/var/lib/mysql`. |
| `/etc/readypackets/site.conf`, `/etc/readypackets/portal.env` | Root-only site record and non-secret app settings: origin, alias if set, installation ID, loopback binding and storage/static paths. Read these files as data, not shell scripts. |
| `/etc/readypackets/secrets/` | Root-only `database_url`, `migrator_database_url`, `backup_database_url`, `rp_data_keyring`, `rp_index_key`, `rp_pseudonym_key`, `rp_token_hash_key`, `rp_audit_chain_key` and `rp_backup_key`. |
| `/etc/readypackets/initial-admin-password`, `/etc/readypackets/initial-admin-email` | Temporary root-only bootstrap inputs, kept across interrupted setup and removed after bootstrap is finalized. |
| Markers under `/etc/readypackets/` | `admin-bootstrap-attempted` records the attempt until finalized; `admin-bootstrap-done` records `created`, `existing` on a retry, or `preexisting` when the database already had an active administrator (checked before a password is generated, so none is generated or shown then). If the attempt marker exists but the saved password is gone, the run stops and says how to continue instead of generating a new one. `initial-admin-outcome` notes how it finished and `initial-admin-shown` records that the password was displayed. `database-accounts-created` exists only while the three database accounts are being created and is removed once their credentials are saved; accounts with those names are otherwise never replaced. `catalog-import-done` prevents reimporting the bundled offerings. |
| `/etc/readypackets/install-migration-pending`, `/etc/nginx/readypackets-maintenance` | Temporary migration and traffic-fence markers. A failed run can leave them in place; see the recovery instructions below. |
| `/opt/readypackets/releases/<commit>`, `/opt/readypackets/current` | Built release (including `release.env`, compiled tools and migrations) and its active symlink. Build and promotion use temporary directories under `/opt/readypackets/`. |
| `/var/cache/readypackets-build`, `/var/lib/readypackets/storage` | Build user's dependency cache and private application storage, including the storage used by backup tooling. |
| `/var/www/readypackets-acme/` | Certificate challenge webroot (`.well-known/acme-challenge/`). The installer's reachability test uses a temporary token removed after the probe. |
| `/etc/nginx/sites-available/readypackets-acme.conf`, `/etc/nginx/sites-available/readypackets-portal.conf`, `/etc/nginx/snippets/readypackets-edge.conf`, `/etc/nginx/snippets/readypackets-tls.conf` | Rendered Nginx files. `/etc/nginx/sites-enabled/readypackets-acme.conf` is only enabled while needed; the finished install enables `/etc/nginx/sites-enabled/readypackets-portal.conf` and removes the ACME link. |
| `/etc/letsencrypt/`, `/etc/readypackets/tls/` | Public mode stores Certbot account, archive and renewal data in `/etc/letsencrypt/` and serves `live/readypackets-portal/{fullchain.pem,privkey.pem}` from that tree. It enables `certbot.timer` and installs `/etc/letsencrypt/renewal-hooks/deploy/readypackets-nginx`. Self-signed mode uses `/etc/readypackets/tls/{fullchain.pem,privkey.pem}`. |
| `/etc/systemd/system/` | `readypackets-portal.service`, `readypackets-worker.service`, `readypackets-backup@.service` and `readypackets-backup.timer`. The three service units get a `.d/10-runtime.conf` drop-in. The installer starts and enables web and worker, but does not enable the backup timer on a fresh install. |
| `/var/log/readypackets-install.log`, `/var/log/nginx/readypackets-access.log`, `/var/log/nginx/readypackets-error.log` | Root-only install step log and separate Nginx access and critical-error logs. Application services log to the systemd journal. |
| `/root/readypackets-initial-admin.txt` | Root-owned `0600` copy of initial sign-in information when a password was generated for the first administrator. |

## First sign-in and follow-up

On success the installer prints `ReadyPackets is installed and running at https://<host>`. For a new administrator it saves `Portal address`, `Sign-in name` and `Password` marked `(temporary)` in `/root/readypackets-initial-admin.txt` (root-only `0600`). It displays these details once on the controlling terminal, not in the install log. If no terminal is attached, use `sudo cat /root/readypackets-initial-admin.txt` privately; standard output carries the details only if `--print-credentials` was given and the installer has not displayed them before.

- **Administrator:** Sign in at the canonical portal address. The first sign-in requires authenticator app enrollment and then a new password. On the "Set a new password" page, the first field takes the temporary password from the installer (the one you just signed in with) and the second field takes the new one. A browser that has a saved password for this address, for example from an earlier system on the same host name, may fill the first field with it; replace it, or the portal answers that the password is incorrect. Keep recovery codes offline. Once sign-in and recovery are set up, delete the temporary credential file with `sudo rm /root/readypackets-initial-admin.txt`. Add a second named administrator for recovery.
- **SMTP:** In the administration console, configure the approved mail destination under **Outbound connections**, then set up authenticated TLS under **E-mail (SMTP)**. Invitations and password resets are held until outgoing mail is configured. Test delivery to an approved inbox.
- **Firewall:** Configure and verify host and provider rules yourself. Keep SSH restricted to approved management sources and allow HTTPS and HTTP as needed; confirm ports 3306, 33060 and 5000 are not externally reachable. Verify the site and certificate from another machine before opening access.
- **Backups:** Run and verify a manual backup before enabling the daily timer. Keep the in-app backup schedule off for this deployment profile. As the final summary reminds you, keep off-server copies of archives from `/var/lib/readypackets/storage/backups` and of `/etc/readypackets/secrets`. Protect the secrets separately from the archives; the archives cannot be restored without the keys. Plan an isolated restore drill using the [backup and restore guide](BACKUP_AND_RESTORE.md).

```bash
sudo systemctl start readypackets-backup@cli.service
sudo journalctl -u readypackets-backup@cli.service
# After confirming successful verification:
sudo systemctl enable --now readypackets-backup.timer
```

## Retry, switch certificates or update

After an ordinary failure, fix the reported cause and rerun the same command from the same commit. Completed steps preserve the active release, keys, database, uploads and the existing administrator; the catalog is not imported twice. Once the temporary password has been displayed, a repeat run only names the account and points to the saved file if it still exists. If the file was deleted or the database already had an administrator before setup, the installer does not create or disclose a new password. If the script reports `install-migration-pending` or `upgrade-state`, stop and follow [manual recovery](INSTALL.md#upgrade-and-rollback); do not delete the marker or rerun migrations without reconciling the database.

To replace a self-signed certificate with a trusted one, point public DNS at the server, confirm port 80 is reachable for all configured names, and rerun from the installed commit with the same `--domain` and `--alias` (omit `--alias` if none was set). Replace `--tls-self-signed` with `--acme-email you@example.com` and do not set the test ACME override. The existing Nginx site can answer the challenge; after issuance, the installer renders and reloads the site with the public certificate. Verify the presented chain and check `certbot.timer`. To switch back for testing, use `--tls-self-signed` instead of `--acme-email`, keeping the names unchanged. Existing Certbot files and its timer are not removed by that switch. If a staging certificate already uses the reserved Certbot lineage, reconcile that lineage with Certbot before rerunning rather than expecting the script to replace it.

For application upgrades, restore authorized GitHub access to the source clone, then fetch the reviewed release. For example, `sudo git -C /opt/readypackets-src pull --ff-only` works if the clone tracks the intended branch; a pinned or detached clone needs a fetch and explicit checkout instead. Verify the full 40-character commit SHA and check out the reviewed kit before using `sudo bash deploy/upgrade.sh <REVIEWED_FULL_COMMIT_SHA>` from the clone. Follow the [upgrade and rollback procedure](INSTALL.md#upgrade-and-rollback) for dependency pins, migration review, draining and verified backups. The upgrade re-renders and reloads Nginx while traffic is fenced; the native-install workflow does not run `upgrade.sh`. `auto-install.sh` is not an updater and refuses to switch the active commit.

Deactivation with `deploy/uninstall.sh` keeps `/swapfile.readypackets` and its `/etc/fstab` entry. If you no longer need the swap and have enough available RAM, run `sudo swapoff /swapfile.readypackets`. After it succeeds, remove the `/swapfile.readypackets none swap sw,nofail 0 0` line from `/etc/fstab` with `sudoedit /etc/fstab`, then run `sudo rm /swapfile.readypackets`. The [manual runbook](INSTALL.md#upgrade-and-rollback) also explains what deactivation does to Nginx and Certbot.

## Troubleshooting

- **Install log:** Read `sudo less /var/log/readypackets-install.log` for the last completed step. Early preflight errors appear on the terminal before the log is opened.
- **DNS or HTTP probe fails:** Check A and AAAA records for both configured names and check TCP 80 from outside the server. Remove a stale AAAA record if the server cannot serve it. If the host cannot loop back to its own public IP but external access is proven, use `--skip-dns-check`; the CA still needs to reach the server.
- **Low memory or disk:** Check `free -h`, `swapon --show` and `df -h /opt /var /`. If your host disallows swap, add RAM or move to a larger server. Check space for data and backups as well as the build.
- **Port already in use:** Run `sudo ss -ltnp` and `sudo nginx -t` to identify conflicts. Do not remove another application's site or stop its service just to reuse the host; use a dedicated server.
- **Certificate issuance fails:** Check `/var/log/letsencrypt/letsencrypt.log`, DNS, firewall rules and public HTTP access before retrying. If the CA reports a rate limit, follow the retry time it gives you rather than repeatedly requesting a new certificate. Use a separate test environment for staging.
- **Service fails or is not ready:** Run `sudo systemctl status readypackets-portal.service readypackets-worker.service nginx.service mysql.service` and `sudo journalctl -b -u readypackets-portal.service -u readypackets-worker.service -u nginx.service -u mysql.service`. For backups, use `sudo journalctl -u readypackets-backup@cli.service`.

## Maintaining tool pins

Update a version and both architecture checksums in [`deploy/auto-install.sh`](../../deploy/auto-install.sh) together. Take the Node SHA-256 values for the Linux `x64` and `arm64` `.tar.xz` files from that Node release's `SHASUMS256.txt` on `nodejs.org`. For pnpm, verify the npm registry tarball from `@pnpm/exe.linux-x64` and `@pnpm/exe.linux-arm64` for the exact release and calculate the SHA-512 hex digest of each tarball, not of the extracted executable. Keep the pnpm pin in step with `package.json`'s `packageManager` and the lockfile; update the expected CI versions when the pins change.

## Limits

This is a single-server installation, not a high-availability setup or a firewall manager. Once installed, the canonical host and redirecting alias are fixed by the kit; you can change certificate mode without changing those names. Use the [manual runbook](INSTALL.md) for Ubuntu 24.04 LTS or to provision the services yourself on Ubuntu 26.04 LTS.

## Verification status

The `native-install` workflow defines three jobs on GitHub-hosted Ubuntu 26.04 runners: x64 self-signed without an alias; arm64 self-signed with an alias and `--swap yes`; and x64 ACME against a local Pebble test authority, on a runner prepared without `universe`. The ACME job includes renewal and certificate-mode changes. This workflow does not use a real VPS or the live Let's Encrypt service and does not run the native upgrade or uninstall scripts.

**What the workflow has shown.** The workflow runs on every change; the run described here is its first complete pass. All three jobs passed on 21 November 2026 for commit `1d60b9b` ([run 44909497870](https://github.com/MadaSito/ReadyPacketsCustomerPortal/actions/runs/44909497870)), on GitHub-hosted runners reporting Ubuntu 26.04.1 LTS with the archive's Nginx 1.28.3, MySQL 8.4.13 and Certbot 4.0.0. Each job removes the runner's own database, web servers and Node.js first, clones the commit as root into `/opt/readypackets-src` and runs `deploy/auto-install.sh` once, with no prerequisite installed by hand. The checks that follow are in `scripts/ci/native-install-smoke.sh`:

- services active and enabled, backup timer left disabled, pinned Node.js and pnpm in place;
- the portal answers over verified TLS and HTTP/2 with its security headers; plain HTTP redirects; unknown names, IP addresses and other ports are refused; the alias only redirects;
- request-body limits; only Nginx listens beyond loopback; service sandboxing and file modes of the secrets;
- the three database accounts require TLS and hold only their grants;
- the generated administrator password is saved root-only, is absent from the install log and the system journal, and signs in up to the authenticator-enrolment step;
- Nginx logs hold no request path, query string or header value, and the stock access log stays empty;
- the maintenance fence, one encrypted and verified backup, and a restart of every service.

A second run then leaves the release and the running portal untouched, creates no second administrator and does not print the password again; another host name is refused. The arm64 job also adds the swap file. The ACME job starts without the `universe` component, obtains its certificate from the Pebble test authority, forces a renewal and checks that Nginx serves the new certificate, then switches to self-signed and back.

**Outside the workflow.** The owner reported one successful installation on their own server on 21 November 2026, followed by sign-in and authenticator enrolment. That is a report, not a recorded test: the provider, memory size and certificate details were not captured.

**What it has not shown.** No workflow run has taken place on a rented server or against the live Let's Encrypt service, so real DNS, a provider firewall, Let's Encrypt rate limits and a server with 1–2 GB of memory are untested (the runners have about 16 GB; the swap file was created there on request, not out of need). Interrupted runs and their recovery, `upgrade.sh`, `uninstall.sh`, a reboot of the machine and the manual Ubuntu 24.04 path are not exercised either. The runner images are not minimal server images, although the job removes the overlapping software first.
