# Native Ubuntu deployment verification

Scope: the native single-node install, upgrade, and deactivation for `my.readypackets.com`. Docker, the alternate legacy Nginx file, and archive-based install scripts are not covered.

## Completed static checks

- **Bash syntax**: `bash -n` on `install.sh`, `upgrade.sh`, `uninstall.sh`, and `lib.sh`.
- **Systemd offline parse**: Assembled the exact `10-runtime.conf` drop-in layout in a temporary directory. `systemd-analyze verify` accepted the two app services, the `cli` and `pre_upgrade` backup instances, and the timer using an isolated unit search path with generators disabled. The sandbox analyzer is systemd 259, not the Ubuntu 24.04 target's running manager.
- **Diff hygiene**: Checked the package and runbook for whitespace errors with Git.
- **App contract cross-check**: Compared Nginx matches and limits to the mounted file, portable and presentation upload routes, Express JSON and signed-webhook limits, forwarding to the exact trusted loopback peer, app-generated IDs/HSTS, and application-controlled asset cache headers. Compared stop handling to the HTTP close and worker drain implementation, and traced backup CLI credentials and child-process privileges.

## Preconditions and unresolved gaps

- **Migration artifact**: At review time the checkout contained no tracked `migrations/meta/_journal.json` or migration SQL. The package explicitly stops before activation if the reviewed release lacks that material. Generate, review, commit, and test the actual migration set before production use.
- **MySQL account separation**: Runtime is schema-scoped DML, not database-enforced append-only. The app uses the same pool for runtime audit operations and retention deletes, so table grants cannot isolate them without app changes. The backup uses a separate read-mostly account with explicitly scoped writes because the CLI records its own backup, verification and audit ledger. The snapshot reader does not use the TLS configuration used by the web and migration paths, so the kit makes an explicit loopback-only exception. Block go-live if this exception is prohibited. Neither `RELOAD` nor `LOCK TABLES` is needed by the inspected dump flags; review future dump option changes and privilege requirements.
- **Issuer**: [Let's Encrypt has ended its OCSP service](https://letsencrypt.org/2025/08/06/ocsp-service-has-reached-end-of-life.html). The production example ships with stapling disabled for that issuer. Settings for a compatible alternate CA are provided but were not verified.

## Not verified here

- **Host lifecycle**: No installer, upgrader, uninstaller, production dependency installation/build, migration, or restore was executed. ShellCheck is unavailable. First run, retry after each interruption point, service credentials and permission application, process fencing, upgrade confirmation flow, power loss, rollback, and data retention across deactivation need an Ubuntu 24.04 staging VM.
- **Nginx/TLS and services**: Nginx was unavailable, and no systemd service was launched. Run `nginx -t` and test real TLS versions, rejects, ACME renewal, alias redirect, rate limiting, forwarding, upload streaming, headers/logging, credential ownership, private temp, system call compatibility, timeouts, and both probes. Validate port 5000 is loopback-only and the app process honors the exact single-proxy trust rule. Test the 90-second stop path and rejection of unproved worker suspension.
- **Data plane**: Grants and backup options were inspected, not applied to MySQL 8.4. Test account privilege denial and allowed operations, the exact `mysqldump` flags and required privileges, successful archive verification, off-host recovery, an isolated restore, and cutover to a compatible old release. Health checks are not a worker liveness, backup, or restoration test.
- **End-user and integrations**: DNS, firewall, customer browser behavior, first sign-in/MFA, SMTP, SIEM listener authentication/receipts, and real load/backpressure were not tested.
