# Install ReadyPackets on Ubuntu 24.04 LTS

This runbook covers a dedicated single node for `my.readypackets.com`, with `portal.readypackets.com` as a permanent redirect. Nginx is the public edge; the separate Node web and worker services use local MySQL and private object storage. Review [verification and release gates](../../deploy/VERIFICATION.md) before admitting customer data. Do not use a preview build or a Perplexity authentication service.

## Prepare the host

- **Release**: Obtain a trusted clone in a root-controlled directory and identify the reviewed full Git commit SHA. Verify provenance, the lockfile, and that `migrations/meta/_journal.json` and its SQL files are included. The kit intentionally refuses a release without this journal. Run the kit shipped with that reviewed checkout, not scripts from an untrusted working directory or an arbitrary branch.
- **Packages**: Patch Ubuntu and use trusted, signed package or release channels. Install Nginx, Certbot, Git, curl, OpenSSL, the Oracle MySQL 8.4 server and its matching `mysql`/`mysqldump` tools. Ubuntu's default database package is not a substitute if it selects another version. Install the latest maintained Node 22 patch (at least 22.12) at `/usr/local/bin/node` and the exact release-pinned pnpm at `/usr/local/bin/pnpm`; verify the vendor signatures or checksums. Do not pipe bootstrap downloads to a shell. The installer checks MySQL's server version via the local root socket. Configure authorized DBA socket access before continuing.
- **Network**: Allow SSH from the management network before enabling a default-deny inbound firewall. Allow TCP 80/443 for ACME and HTTPS, and do not open 3306 or 5000. Publish A records for both hosts; publish AAAA only if the node can serve both names over IPv6. Do not place a CDN or other proxy in front without revisiting client-IP, authority, and rate-limit policy. Permit outbound access only to required package sources on the build path and approved service destinations in production.
- **MySQL**: Bind TCP to `127.0.0.1` only; use `skip_name_resolve=ON` and verified MySQL TLS for the runtime and migrator accounts. If those DSNs use `127.0.0.1`, issue the MySQL certificate with a matching IP SAN. The CA must be readable by `readypackets` outside `/home` (it is not a private key). Use a dedicated schema and DBA account. Apply only Phase A in [accounts.sql](../../deploy/mysql/accounts.sql) at this point, substituting placeholders and protecting any generated passwords. The bootstrap migrator can change this schema, not other databases.
- **Custody**: Provide sufficient disk for retained releases, private data, encrypted backups, and a restore drill. Use encrypted disks if required. Securely escrow the installation ID and all secrets; losing the field keyring or backup key can make an otherwise healthy archive unrecoverable. Keep Ubuntu, Node, MySQL, and Nginx in the patching program.

Example firewall commands, after confirming SSH on a second connection. Substitute the management subnet before running them:

```bash
sudo ufw default deny incoming
sudo ufw allow from <MANAGEMENT_CIDR> to any port 22 proto tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

## Issue the web certificate

From the reviewed checkout, provision the temporary HTTP-01 site and certificate. This flow assumes a dedicated Nginx configuration with no other default virtual hosts. Disable the Ubuntu packaged default symlink only after checking that it is not serving another application.

```bash
sudo install -d -m 0755 /var/www/readypackets-acme
sudo install -m 0644 deploy/nginx/readypackets-acme.conf /etc/nginx/sites-available/readypackets-acme.conf
sudo ln -sfn /etc/nginx/sites-available/readypackets-acme.conf /etc/nginx/sites-enabled/readypackets-acme.conf
sudo unlink /etc/nginx/sites-enabled/default  # only if the packaged symlink still exists
sudo nginx -t
sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/readypackets-acme \
  --cert-name readypackets-portal -d my.readypackets.com -d portal.readypackets.com
```

The full TLS site retains the ACME exception on port 80. Install a root-owned Certbot deploy hook (`/etc/letsencrypt/renewal-hooks/deploy/`, mode `0755`) that runs `nginx -t && systemctl reload nginx`; check `sudo certbot renew --dry-run` and monitor expiry. The canonical app supplies HSTS on upstream HTTPS responses; Nginx supplies HSTS on the HTTPS alias redirect because it does not reach the app. Nginx-generated errors may not carry the application's headers. [Let's Encrypt ended its OCSP service](https://letsencrypt.org/2025/08/06/ocsp-service-has-reached-end-of-life.html), so stapling is disabled for the example issuer. For an issuer with an active OCSP responder, configure the [TLS snippet](../../deploy/nginx/readypackets-tls.conf) with the issuer trust chain and a trusted resolver, then verify a staple with `openssl s_client -status`.

## Install and enroll the first administrator

```bash
sudo bash deploy/install.sh <REVIEWED_FULL_COMMIT_SHA>
```

The guide prompts for three MySQL connection URLs and for the initial administrator. Enter a percent-encoded username/password, not a shell-escaped password; secret values are not placed on the command line. For the runtime and migrator enter a URL of the form `mysql://ACCOUNT:ENCODED_PASSWORD@127.0.0.1:3306/SCHEMA?tls=required&tlsCaFile=/absolute/path/to/mysql-ca.pem`. Omit `tlsCaFile` only if the driver trusts the issuer already. For the current host-local backup tool use `mysql://BACKUP_ACCOUNT:ENCODED_PASSWORD@127.0.0.1:3306/SCHEMA`. Do not enable an instance-wide `require_secure_transport=ON` with this backup implementation; require SSL on the web/worker and migrator accounts directly. A deployment policy requiring verified TLS even over loopback must block go-live until the backup client supports it.

- **Paths and services**: Code is built by `readypackets-build` without credentials, then promoted as a root-owned release under `/opt/readypackets/releases/`. The Nginx edge serves via the application, not from this tree. Runtime is unprivileged `readypackets`; only `/var/lib/readypackets/storage` is writable in the host filesystem under its systemd sandbox. `/etc/readypackets/portal.env` and source credential files are root-owned `0600`. Systemd delivers `*_FILE` values via `LoadCredential`. Never source the environment file or put URL/key values in it. `MemoryDenyWriteExecute` is not enabled because it would prevent the Node/V8 JIT from running.
- **Repeated install**: Rerunning with the same SHA preserves keys, installation ID, prior admin marker, database, and uploads. It will not switch to another release. If bootstrap was skipped, rerun this installer to create the first admin. If bootstrap was interrupted after submission, first check whether the account exists; a successful creation must not be retried blindly. If a cleanly recreated site used a different certificate setup, reconcile the root-owned TLS snippet before reloading Nginx.
- **Enable MFA**: Use `https://my.readypackets.com` to sign in with the temporary password. Change it and enroll an authenticator, then store recovery codes offline. Verify a fresh MFA step-up for sensitive operations. Provision a second named, secured admin using the portal before relying on production self-service. Leave external authentication disabled until its trust and recovery procedures have been tested.
- **SMTP**: Configure the approved SMTP host in integration egress policy and the admin console with authenticated TLS (implicit TLS or required STARTTLS as supported). Enter credentials through the console rather than in unit files or Git. Test delivery to an approved inbox and confirm sender authentication, expiry, and redacted delivery status. Never enable local mail capture in production.

## Backups and audit forwarding

- **Backup role**: Apply Phase B in [accounts.sql](../../deploy/mysql/accounts.sql) after the initial migration creates the tables. This account is read-mostly, with explicit backup, verification, and audit ledger writes; it is not a migration account. The CLI uses one DSN for the dump and those writes. The separate snapshot connection does not currently implement the app's verified TLS configuration, so the exception is limited to the local IPv4 loopback DB. Do not add global privileges to resolve an untested dump error. Inspect the missing operation and review the release flags with the DBA.
- **Verified archive**: Run `sudo systemctl start readypackets-backup@cli.service` and inspect `sudo journalctl -u readypackets-backup@cli.service`. Record the backup ID and verification result; copy the encrypted archive to access-controlled off-host storage and independently verify digest/availability. Escrow backup and application keys separately from archives, including retained versions and state needed for key and MFA continuity. Verification is not a destructive restore test.
- **Schedule**: With the in-app backup schedule disabled, run `sudo systemctl enable --now readypackets-backup.timer` after the manual backup verifies. Monitor the last successful verification and off-host copy age. The timer does not replicate or prune archives. Do not enable both schedulers. Web/worker intentionally do not receive the backup key or backup DSN; this profile uses the timer and CLI, not web/worker-managed backup creation or restore. Use the dedicated, reviewed isolated restore workflow for drills.
- **Restore drill**: Use `scripts/ops/restore/restore-isolated.ts` and the [Backup & Disaster Recovery API](../../server/modules/backup/API.md) for current prerequisites. A dedicated drill credential needs only the required recovery ledger operations on the source and scoped DDL/DML on the isolated target it will create or populate. The target storage directory must be empty and must not overlap live storage. The CLI accepts `--backup-id ID --target-db ISOLATED_DB --target-storage EMPTY_DIR --confirm "RESTORE ID TO ISOLATED_DB"`. Prove archive, row and object integrity, audit continuity, and MFA/session reconciliation before relying on a drill. Do not give the persistent backup account target creation or live restore authority. Confirm how you will preserve or quarantine credentials/jobs and disable outbound integrations before any promotion.
- **Audit and SIEM**: Use the Audit Center filters and chain verification, review legal holds and retention, and create an approved TLS syslog or OTLP HTTPS destination in the SIEM settings. Pin policy to approved hosts/ports, validate collector trust/name and configure mTLS if required. Send a test and confirm receipt at the collector; monitor backlog, circuit status, and dead letters. Store audit chain evidence off-host. The current DB profile does not enforce append-only retention separation; review that limitation before setting retention policy.
- **Operational logs**: The application logs to journald; Nginx JSON logs to `/var/log/nginx/readypackets-access.log`. Correlate `request_id` from the upstream `X-Request-Id`; `edge_request_id` remains available for Nginx-only failures. Protect and rotate these files and alert on 429/5xx, worker failures, error spikes, backup age, and audit forwarding lag. If forwarding infrastructure logs as well, use a separately configured TLS agent; app audit forwarding does not forward the entire journal.

## Upgrade and rollback

Fetch and review the candidate in a trusted checkout. Ensure new migrations were reviewed and exercised on a restored copy. The script builds before quiescing, so defer enabling Jobs maintenance until it prompts. Do not change the ingress policy, deploy unit drop-ins, or change MySQL grants during the upgrade; review any such template changes separately.

```bash
sudo bash deploy/upgrade.sh <CANDIDATE_FULL_COMMIT_SHA>
```

- **Drain**: Enable Jobs maintenance with fresh MFA; wait for `queue_drained`, investigate unknown attempts with provider evidence, and stop every out-of-band writer including automation against MySQL or the object tree. Confirm `DRAINED`. The host then fences public requests, disables the timer and web/worker autostart, stops both services and insists on success with a zero normal exit. A worker that cannot prove shutdown sets exit 70 and may remain alive until the 90-second systemd stop deadline; a signal kill is not a successful drain. A still-active or failed backup blocks progress.
- **Back up and restart**: Record the verified pre-upgrade archive ID and secure an off-host copy before confirming `BACKUP-VERIFIED`. The script runs schema migration with the migrator credential, switches the `current` link atomically, and verifies local and TLS-edge `/healthz` and `/readyz` plus an active worker. Inspect both service journals before confirming `REOPEN`; then verify fresh sign-in, the Jobs maintenance state, and clear the app gate with fresh MFA. The loopback edge checks bypass the public fence; do not put an untrusted local proxy on the node.
- **Failure before migration**: Read `/etc/readypackets/upgrade-state` as data, never source it. In `draining` or `backup`, establish whether web/worker or a backup were interrupted, reconcile unresolved work, and confirm no migrator was started. The prior release remains pointed to by `current`. With the edge fence still installed, restart and check the old services, restore their enablement and the previous timer state if applicable, then remove the fence/state and clear Jobs maintenance. If initial install left `/etc/readypackets/install-migration-pending`, inspect the journal and real schema; remove it only after a DBA has proved the condition safe for reattempt or verified and adopted the correct release. A missing state file is not proof after a host crash.
- **Failure once migration may have started**: Keep traffic fenced, stop and disable the web/worker and timer, preserve logs, and inspect the live schema and `__drizzle_migrations`. MySQL DDL can be partially applied. Do not automatically swap back to `previous`, rerun migrations blindly, edit the migration journal, or start the old release against the changed schema. Either repair and finish the forward release with DBA approval, or restore the verified pre-upgrade archive to isolated clean targets using the old release and escrowed keys. Verify schema compatibility, storage completeness and security continuity; plan promotion with human approval and document writes lost since the backup. Keep original schema/storage intact as incident evidence. Only a verified compatible database/storage pair should serve traffic.
- **Deactivation**: `sudo bash deploy/uninstall.sh` asks for typed confirmation, removes the managed site/units and stops services. It has no data or key deletion mode. Database, accounts, release directories, certificates, keys, private objects and archives are retained. Cleanup or reinstallation after incident recovery is a separate reviewed operation.

## Go-live checklist

- [ ] Confirm DNS for both names, certificate chain and renewal, HTTP→HTTPS, TLS alias 308, unknown-host rejection, and no externally reachable MySQL/Node listeners. Verify public ingress is down while the maintenance sentinel exists.
- [ ] Confirm TLS 1.2/1.3 only, app HSTS and security headers, and `index.html`/`sw.js` not served from an edge cache. Verify expected limits for JSON, presentation image, transfer and file upload independently.
- [ ] Check loopback and public `/healthz` and `/readyz`; verify worker progress and a correlated app/edge log without payloads or credentials.
- [ ] Exercise browser sign-in, MFA/recovery and mail, and verify application audit, off-host audit evidence and collector receipt. Review alerting, log rotation, deployment account grants, and the backup TLS exception.
- [ ] Prove a verified encrypted backup and isolated restore against the shipped migration set. Test both a failed and a successful fenced upgrade in staging; record approval before opening production traffic.
