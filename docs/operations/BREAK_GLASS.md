# Break-glass access recovery

Use these controls only from the trusted deployment host when portal access is blocked by an application IP ban or session policy enforcement. They are different controls. Neither resets passwords, removes MFA, bypasses customer action-specific legal acceptance, bypasses proxy/firewall bans or restores revoked sessions.

Record the incident, approval, operator, UTC time, affected deployment, action and result in your incident system. Keep command output in restricted operator records. Confirm the target release and that deployment or database maintenance is not in progress before issuing a mutation.

## Clear application IP bans

List active bans, identify the affected ban by its public ID and clear that entry first. List returns at most 512 entries with ID, source, strikes and expiry; it does not show the plaintext address or reason. If evidence cannot identify a single entry, use `clear --all` only with explicit incident approval. It clears automatic and manual bans, including expired entries in the bounded batch; it does not edit the underlying rules or forwarding configuration.

### Native Ubuntu install

Use the reviewed root-owned checkout for the installed release. The wrapper takes the deploy lock and invokes the active release under its unprivileged service account with scoped runtime credentials. Do not extract credentials or run MySQL DELETE statements by hand.

```bash
cd /opt/readypackets-src
sudo bash deploy/protection-bans.sh list
sudo bash deploy/protection-bans.sh clear '<ban-public-ULID>'
# Only with approval to remove all bans:
sudo bash deploy/protection-bans.sh clear --all
```

### Docker Compose

From `deploy/docker`, use the same project configuration and any deployment overrides as the running stack. The database must be running, but the web process need not be reachable.

```bash
docker compose --env-file .env -f compose.yaml run --rm --no-deps -T ops \
  node dist/ops/protection-bans.js list
docker compose --env-file .env -f compose.yaml run --rm --no-deps -T ops \
  node dist/ops/protection-bans.js clear '<ban-public-ULID>'
# Only with approval to remove all bans:
docker compose --env-file .env -f compose.yaml run --rm --no-deps -T ops \
  node dist/ops/protection-bans.js clear --all
```

### Verify recovery

Exit `0` means success, `64` means incorrect usage, and `1` means the requested entry no longer exists or the operation failed. Ban removal and `security.ban.released` audit evidence (system actor) are transactional: if evidence cannot be recorded, the ban is not removed. The next credential request sees the committed state across replicas without a restart. Verify the remaining active list and audit trail, confirm normal MFA sign-in from the affected network, then investigate the original trigger before it creates another ban.

## Temporarily pause session policy enforcement

`POLICY_ENFORCEMENT_DISABLED=1` disables session enforcement lookups, automatic enforcement-based session termination, and new administrative enforcement actions. It does not change the stored policy configuration, bypass action-specific policy acceptance gates, or reset a user's credentials. It must be set on every web and worker instance for consistent behavior.

- **Native**: Use `sudoedit /etc/readypackets/portal.env` to add or replace `POLICY_ENFORCEMENT_DISABLED=1`, retaining root ownership and mode `0600`. Restart using `sudo systemctl restart readypackets-worker.service readypackets-portal.service`. Systemd reads `EnvironmentFile` on process start; changing the file alone has no effect.
- **Compose**: In `deploy/docker/.env`, add or replace `POLICY_ENFORCEMENT_DISABLED=1`. Run `docker compose --env-file .env -f compose.yaml up -d --no-deps --force-recreate web worker`, including your existing overrides if applicable. Restarting containers without recreating them does not apply the environment change.
- **Recovery and closeout**: Confirm web readiness, worker startup, the warning in startup logs and the administrator banner. Sign in again with local MFA if the previous session was revoked. Diagnose the enforcement configuration, then remove the override or restore `0` and restart or recreate both services again. Confirm the warning and banner are gone and that normal enforcement and action gates work before closing the incident.
