# Manually install ReadyPackets on Ubuntu 24.04 or 26.04 LTS

For a fresh Ubuntu 26.04 LTS server, see the [automatic installation guide](AUTO_INSTALL.md). Use this runbook for Ubuntu 24.04 LTS or when you want to provision the prerequisites yourself on Ubuntu 26.04 LTS.

This runbook covers a dedicated single node and uses `my.readypackets.com` as the example canonical host, with `portal.readypackets.com` as an optional permanent redirect. Nginx is the public edge; the separate Node web and worker services use local MySQL and private object storage. Review [verification and release gates](../../deploy/VERIFICATION.md) before admitting customer data. Use a production build and local authentication.

For a quick evaluation or test installation under another host name, use the Docker Compose stack instead: [`deploy/docker/README.md`](../../deploy/docker/README.md). It is not a replacement for this runbook (no backups, drain or rollback).

## Prepare the host

- **Release**: Clone as root with `umask 022` into a root-controlled location such as `/opt/readypackets-src`, using the [automatic guide's clone command](AUTO_INSTALL.md#quick-start). Keep the clone, its contents and its parent directories root-owned and not group- or other-writable. Identify the reviewed full Git commit SHA, and verify provenance, the lockfile and `migrations/meta/_journal.json` with its SQL files. Run the kit shipped with that reviewed checkout, not scripts from an untrusted working directory or an arbitrary branch.
- **Packages**: Patch Ubuntu and use trusted, signed package or release channels. Install Nginx, Certbot, Git, curl, OpenSSL, the Oracle MySQL 8.4 server and its matching `mysql`/`mysqldump` tools. Ubuntu's default database package is not a substitute if it selects another version. Install the latest maintained Node 22 patch (at least 22.12) at `/usr/local/bin/node` and the exact release-pinned pnpm at `/usr/local/bin/pnpm`; verify the vendor signatures or checksums. Do not pipe bootstrap downloads to a shell. The installer checks MySQL's server version via the local root socket. Configure authorized DBA socket access before continuing.
- **Network**: Allow SSH from the management network before enabling a default-deny inbound firewall. Allow TCP 80/443 for ACME and HTTPS, and do not open 3306, 33060 or 5000. Publish DNS for the portal and optional alias; publish AAAA only if the node can serve those names over IPv6. Do not place a CDN or other proxy in front without revisiting client-IP, authority, and rate-limit policy. Permit outbound access only to required package sources on the build path and approved service destinations in production.
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

From the reviewed checkout, provision the temporary HTTP-01 site and certificate. The Nginx source files are templates, not usable configurations. This example uses the `write_site` and `render_site` helpers from the reviewed `deploy/lib.sh` to create root-owned `0600` `/etc/readypackets/site.conf`, prepare the portal edge snippet and render the challenge site. It uses the same `/run/readypackets-deploy.lock` as the deployment scripts. Replace the two host names; for no alias, pass `''` instead of `portal.readypackets.com`.

This flow assumes a dedicated Nginx configuration with no other enabled sites. Before running it, inspect `/etc/nginx/sites-enabled/default` and confirm it is the Ubuntu packaged default symlink and is not serving another application, or that it is already absent. Do not run these first-install commands on a site that already serves the portal.

```bash
sudo bash -s -- "$PWD/deploy" my.readypackets.com portal.readypackets.com <<'BASH'
deploy_src=$1
source "$deploy_src/lib.sh"
lock_deploy
write_site "$2" "$3" letsencrypt
install -d -o root -g root -m 0755 /var/www/readypackets-acme \
  /var/www/readypackets-acme/.well-known /var/www/readypackets-acme/.well-known/acme-challenge
render_site "$deploy_src/nginx/readypackets-edge.conf.template" /etc/nginx/snippets/readypackets-edge.conf
render_site "$deploy_src/nginx/readypackets-acme.conf.template" /etc/nginx/sites-available/readypackets-acme.conf
ln -sfn /etc/nginx/sites-available/readypackets-acme.conf /etc/nginx/sites-enabled/readypackets-acme.conf
if [[ -L /etc/nginx/sites-enabled/default ]]; then
  unlink /etc/nginx/sites-enabled/default
fi
nginx -t
systemctl start nginx
systemctl reload nginx
BASH
```

Run Certbot interactively, using the same host names as `site.conf`. If you did not configure an alias, omit the second `-d` argument.

```bash
sudo sh -c 'umask 022; exec certbot "$@"' sh certonly --webroot -w /var/www/readypackets-acme \
  --cert-name readypackets-portal -d my.readypackets.com -d portal.readypackets.com
```

`install.sh` uses the site record to render all three final Nginx files: `readypackets-edge.conf`, `readypackets-tls.conf` and `readypackets-portal.conf`. Every server block in the final site includes the edge snippet so server tokens, gzip, access and error logging and TLS policy are set at server level without repeating directives in Ubuntu's `nginx.conf`. The temporary challenge site does not include this snippet. The TLS snippet enables HTTP/2 for the named HTTPS servers on Nginx 1.25.1 or newer (Ubuntu 26.04's 1.28); Ubuntu 24.04's Nginx 1.24 remains HTTP/1.1.

The full TLS site retains the ACME exception on port 80. Install a root-owned Certbot deploy hook (`/etc/letsencrypt/renewal-hooks/deploy/`, mode `0755`) that runs `nginx -t && systemctl reload nginx`; enable `certbot.timer`, check `sudo certbot renew --dry-run` and monitor expiry. The canonical app supplies HSTS on upstream HTTPS responses; Nginx supplies HSTS on the HTTPS alias redirect because it does not reach the app. Nginx-generated errors may not carry the application's headers. [Let's Encrypt ended its OCSP service](https://letsencrypt.org/2025/08/06/ocsp-service-has-reached-end-of-life.html), so stapling is disabled for the example issuer. For an issuer with an active OCSP responder, configure the [TLS snippet template](../../deploy/nginx/readypackets-tls.conf.template) with the issuer trust chain and a trusted resolver, then verify a staple with `openssl s_client -status`.

## Install and enroll the first administrator

```bash
sudo bash deploy/install.sh <REVIEWED_FULL_COMMIT_SHA>
```

If FFmpeg and `prlimit` are absent, the installer installs the Ubuntu packages before building the portal. For the optional read-only GeoIP database and media settings, see [Media and country database setup](MEDIA_AND_GEOIP.md).

The installer prompts for three MySQL connection URLs and for the initial administrator. Enter a percent-encoded username/password, not a shell-escaped password; database secrets are not placed on the command line. Use `mysql://ACCOUNT:ENCODED_PASSWORD@127.0.0.1:3306/SCHEMA?tls=required&tlsCaFile=/absolute/path/to/mysql-ca.pem` for all three credentials by default. Omit `tlsCaFile` only if both the Node driver and native MySQL clients trust the issuer. Install and upgrade validate all saved credential files as well as newly entered URLs. A documented, approved backup exception may omit TLS only with a parsed host of `127.0.0.1`, `[::1]`, or `localhost` (keep `localhost` mapped exclusively to loopback); the shipped SQL template still requires SSL. Unix socket DSNs are not accepted because the shared database URL format does not support them. Do not weaken runtime or migrator TLS. Verify the transport policy works against the exact release before customer data is admitted.

- **Paths and services**: Before building, root generates any initial encryption and signing keys with the host OpenSSL, directly under the root-owned `0700` secrets directory. `readypackets-build` builds without credentials in transient systemd units, with the secrets directory inaccessible. Promotion copies validated regular files and directories (not links) into a separate root-owned staging tree, takes the final package manifest and migration files directly from the reviewed Git commit, and publishes by atomic rename under `/opt/readypackets/releases/`. The Nginx edge serves via the application, not this tree. Each base unit requires the unprivileged `readypackets` identity; the installed drop-in supplies additional sandboxing. `/etc/readypackets/portal.env` and source credential files are root-owned `0600`; systemd supplies `*_FILE` values via `LoadCredential`. Never source the environment file or put URL/key values in it. `MemoryDenyWriteExecute` is not enabled because it would prevent the Node/V8 JIT from running.
- **Production commands**: The release prunes dev dependencies. Migration, administrator bootstrap, offerings catalog import, backup, restore and key tools use plain Node with the compiled `dist/ops/*.js` entry points; do not depend on `tsx` or the repository source tree in production. The demo seed is not included in the installed release.
- **Repeated install**: Rerunning with the same SHA preserves keys, installation ID, prior admin marker, database, and uploads. It will not switch to another release. If bootstrap was skipped, rerun this installer to create the first admin. If bootstrap was interrupted after submission, first check whether the account exists; a successful creation must not be retried blindly. `install.sh` renders the Nginx site and TLS snippet from `/etc/readypackets/site.conf`; keep the canonical host and alias unchanged after installation.
- **Existing installations**: If an earlier installer generated production keys under the build account, review the historical custody before reuse and plan any rotation using the key runbook and retained decrypt keys. The new installer does not overwrite existing key material.
- **Enable MFA**: Use your canonical HTTPS address to sign in with the temporary password. Change it and enroll an authenticator, then store recovery codes offline. Verify a fresh MFA step-up for sensitive operations. Provision a second named, secured admin using the portal before relying on production self-service. Leave external authentication disabled until its trust and recovery procedures have been tested.
- **SMTP**: Configure the approved SMTP host in integration egress policy and the admin console with authenticated TLS (implicit TLS or required STARTTLS as supported). Enter credentials through the console rather than in unit files or Git. Test delivery to an approved inbox and confirm sender authentication, expiry, and redacted delivery status. Never enable local mail capture in production.

### Load the offerings catalog (optional)

`install.sh` does not populate product catalog rows automatically. After schema migrations and first-administrator creation have completed, an operator may load the shipped ReadyPackets offerings matrix (`/opt/readypackets/current/data/catalog/readypackets-offerings-v3.0.json`, validated against `data/catalog/offerings.schema.json`) using `dist/ops/catalog-import.js` as the audited system actor `ops.catalog_import`.

Run `--dry-run` first to validate the offerings file and execute the import inside a rolled-back transaction before applying it:

```bash
run_catalog_import() {
  sudo systemd-run --wait --collect --pipe --service-type=exec --expand-environment=no \
    --property=User=readypackets --property=Group=readypackets --property=UMask=0077 \
    --property=NoNewPrivileges=yes --property=ProtectSystem=strict --property=ProtectHome=yes \
    --property=PrivateTmp=yes --property=PrivateDevices=yes --property=CapabilityBoundingSet= \
    --property=ReadWritePaths=/var/lib/readypackets/storage \
    --property=EnvironmentFile=/etc/readypackets/portal.env \
    --property=EnvironmentFile=/opt/readypackets/current/release.env \
    --property=LoadCredential=database_url:/etc/readypackets/secrets/database_url \
    --property=LoadCredential=rp_data_keyring:/etc/readypackets/secrets/rp_data_keyring \
    --property=LoadCredential=rp_index_key:/etc/readypackets/secrets/rp_index_key \
    --property=LoadCredential=rp_pseudonym_key:/etc/readypackets/secrets/rp_pseudonym_key \
    --property=LoadCredential=rp_token_hash_key:/etc/readypackets/secrets/rp_token_hash_key \
    --property=LoadCredential=rp_audit_chain_key:/etc/readypackets/secrets/rp_audit_chain_key \
    --working-directory=/opt/readypackets/current --setenv=RP_ROLE=web \
    /bin/bash -c '
      export DATABASE_URL_FILE="$CREDENTIALS_DIRECTORY/database_url"
      export RP_DATA_KEYRING_FILE="$CREDENTIALS_DIRECTORY/rp_data_keyring"
      export RP_INDEX_KEY_FILE="$CREDENTIALS_DIRECTORY/rp_index_key"
      export RP_PSEUDONYM_KEY_FILE="$CREDENTIALS_DIRECTORY/rp_pseudonym_key"
      export RP_TOKEN_HASH_KEY_FILE="$CREDENTIALS_DIRECTORY/rp_token_hash_key"
      export RP_AUDIT_CHAIN_KEY_FILE="$CREDENTIALS_DIRECTORY/rp_audit_chain_key"
      exec /usr/local/bin/node dist/ops/catalog-import.js "$@"
    ' bash "$@"
}

run_catalog_import --dry-run
run_catalog_import
```

- **Default vs custom file**: With no `--file` flag, `dist/ops/catalog-import.js` resolves `<release>/data/catalog/readypackets-offerings-v3.0.json` from the promoted release tree. When `--file <path>` is passed, relative paths resolve against the working directory (`/opt/readypackets/current`); place custom offerings JSON files outside `/home` and `/root` (for example, a root-owned `0644` file under `/opt/readypackets/`) because `ProtectHome=yes` makes home directories inaccessible to `readypackets`.
- **Idempotency and exit codes**: The command matches groups and products by `groupKey` / `productKey`, writes a new product version only when content changes, updates `orders.bundle_rule`, and never deletes or deactivates existing catalog items. Exit codes: `0` imported or dry-run ok, `1` failed, `64` usage, `65` invalid offerings file, `66` file not readable, `78` configuration.

## Backups and audit forwarding

- **Backup role**: Apply Phase B in [accounts.sql](../../deploy/mysql/accounts.sql) after the initial migration creates the tables. The CLI uses one DSN for the dump and explicitly scoped backup, verification, and audit ledger writes. The dump reads data and view definitions and excludes triggers, events, and routines; do not grant `TRIGGER`, `EVENT`, `LOCK TABLES`, `PROCESS`, or `RELOAD` to the persistent backup account. Revoke old grants that are no longer needed once the running dump path uses those exclusions. Confirm the actual flags and account grants with the DBA on staging; do not add global privileges as a workaround.
- **Verified archive**: Run `sudo systemctl start readypackets-backup@cli.service` and inspect `sudo journalctl -u readypackets-backup@cli.service`. Record the backup ID and verification result; copy the encrypted archive to access-controlled off-host storage and independently verify digest/availability. Escrow backup and application keys separately from archives, including retained versions and state needed for key and MFA continuity. Verification is not a destructive restore test.
- **Schedule**: With the in-app backup schedule disabled, run `sudo systemctl enable --now readypackets-backup.timer` after the manual backup verifies. Monitor the last successful verification and off-host copy age. The timer does not replicate or prune archives. Do not enable both schedulers. Web/worker intentionally do not receive the backup key or backup DSN; this profile uses the timer and CLI, not web/worker-managed backup creation or restore. Use the dedicated, reviewed isolated restore workflow for drills.
- **Restore drill**: Use `node dist/ops/restore-isolated.js` on a trusted recovery host and consult the [Backup & Disaster Recovery API](../../server/modules/backup/API.md) for current arguments and prerequisites. Use an isolated recovery database and storage root, separately scoped credentials, and the required keys; do not give the persistent backup account target creation or live restore authority. Prove archive, row and object integrity, audit continuity, and MFA/session reconciliation before relying on a drill. Confirm how you will quarantine or reconcile credentials and jobs, and disable outbound integrations before any promotion.
- **Audit and SIEM**: Use the Audit Center filters and chain verification, review legal holds and retention, and create an approved TLS syslog or OTLP HTTPS destination in the SIEM settings. Pin policy to approved hosts/ports, validate collector trust/name and configure mTLS if required. Send a test and confirm receipt at the collector; monitor backlog, circuit status, and dead letters. Store audit chain evidence off-host. The current DB profile does not enforce append-only retention separation; review that limitation before setting retention policy.
- **Operational logs**: The application logs to journald; Nginx JSON logs to `/var/log/nginx/readypackets-access.log`. Correlate `request_id` from the upstream `X-Request-Id`; `edge_request_id` remains available for Nginx-only failures. Protect and rotate these files and alert on 429/5xx, worker failures, error spikes, backup age, and audit forwarding lag. If forwarding infrastructure logs as well, use a separately configured TLS agent; app audit forwarding does not forward the entire journal.

## Upgrade and rollback

For exact copy-pasteable operator commands from `/opt/readypackets-src`, see [UPGRADE.md](UPGRADE.md); for locked-out administrator host recovery, see [ADMIN-RECOVERY.md](ADMIN-RECOVERY.md).

Fetch and review the candidate in a trusted checkout (root-owned, `umask 022`, checked out at the exact target commit). Ensure new migrations were reviewed and exercised on a restored copy. After switching releases, with traffic still fenced, `deploy/upgrade.sh` installs the candidate's managed units and drop-ins, renders the edge and TLS snippets and portal site from the kit, then runs `nginx -t` and reloads Nginx. The `native-install` CI workflow is configured to exercise this path from Increment 03 (`89c5cb8`) through live data creation, `deploy/upgrade.sh`, and the full smoke suite. Apply unrelated ingress or grant changes separately, and ensure the old pre-upgrade backup unit still works before migration.

```bash
sudo bash deploy/upgrade.sh <CANDIDATE_FULL_COMMIT_SHA>
```

- **Drain**: Enable Jobs maintenance with fresh MFA; wait for `queue_drained`, investigate unknown attempts with provider evidence, and stop every out-of-band writer including automation against MySQL or the object tree. Confirm `DRAINED`. The host then fences public requests, disables the timer and web/worker autostart, stops both services and insists on success with a zero normal exit. A worker that cannot prove shutdown sets exit 70 and may remain alive until the 90-second systemd stop deadline; a signal kill is not a successful drain. A still-active or failed backup blocks progress.
- **Back up and restart**: Record the verified pre-upgrade archive ID and secure an off-host copy before confirming `BACKUP-VERIFIED`. The script runs schema migration with the migrator credential, switches the `current` link atomically, and verifies local and TLS-edge `/healthz` and `/readyz` plus an active worker. Inspect both service journals before confirming `REOPEN`; then verify fresh sign-in, the Jobs maintenance state, and clear the app gate with fresh MFA. The loopback edge checks bypass the public fence; do not put an untrusted local proxy on the node.
- **Failure before migration**: Read `/etc/readypackets/upgrade-state` as data, never source it. In `draining` or `backup`, establish whether web/worker or a backup were interrupted, reconcile unresolved work, and confirm no migrator was started. The prior release remains pointed to by `current`. With the edge fence still installed, restart and check the old services, restore their enablement and the previous timer state if applicable, then remove the fence/state and clear Jobs maintenance. If initial install left `/etc/readypackets/install-migration-pending`, inspect the journal and real schema; remove it only after a DBA has proved the condition safe for reattempt or verified and adopted the correct release. A missing state file is not proof after a host crash.
- **Failure once migration may have started**: Keep traffic fenced, stop and disable the web/worker and timer, preserve logs, and inspect the live schema and `__drizzle_migrations`. MySQL DDL can be partially applied. Do not automatically swap back to `previous`, rerun migrations blindly, edit the migration journal, or start the old release against the changed schema. Either repair and finish the forward release with DBA approval, or restore the verified pre-upgrade archive to isolated clean targets using the old release and escrowed keys. Verify schema compatibility, storage completeness and security continuity; plan promotion with human approval and document writes lost since the backup. Keep original schema/storage intact as incident evidence. Only a verified compatible database/storage pair should serve traffic.
- **Deactivation**: `sudo bash deploy/uninstall.sh` asks for typed confirmation, stops the ReadyPackets services and removes their units, the enabled Nginx site, the portal site's rendered files (including the edge snippet) and `/etc/letsencrypt/renewal-hooks/deploy/readypackets-nginx`. It does not delete the database, accounts, releases, certificates, keys, private objects, archives or the [optional swap file and its registration](AUTO_INSTALL.md#retry-switch-certificates-or-update). Public certificates stay on disk; Certbot will report failed renewals for this site until reinstallation or until you deliberately run `sudo certbot delete --cert-name readypackets-portal`. Only delete that certificate if you will not reuse it and no other service needs it.

## Go-live checklist

- [ ] Confirm DNS for the canonical name and any alias, certificate chain and renewal, HTTP→HTTPS, TLS alias 308 if configured, unknown-host rejection, and no externally reachable MySQL/Node listeners. Verify public ingress is down while the maintenance sentinel exists.
- [ ] Confirm TLS 1.2/1.3 only, app HSTS and security headers, and `index.html`/`sw.js` not served from an edge cache. Verify expected limits for JSON, presentation image, transfer and file upload independently.
- [ ] Check loopback and public `/healthz` and `/readyz`; verify worker progress and a correlated app/edge log without payloads or credentials.
- [ ] Exercise browser sign-in, MFA/recovery and mail, and verify application audit, off-host audit evidence and collector receipt. Review alerting, log rotation, deployment account grants, and the backup TLS exception.
- [ ] Prove a verified encrypted backup and isolated restore against the shipped migration set. Test both a failed and a successful fenced upgrade in staging; record approval before opening production traffic.
