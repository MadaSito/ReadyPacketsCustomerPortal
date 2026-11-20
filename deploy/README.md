# ReadyPackets Deployment Profiles

This directory contains self-hosted deployment artifacts for `https://my.readypackets.com`. No Perplexity, Manus, or external SaaS runtime dependencies are used.

## Profiles

1. **Native Single-VPS Profile (`deploy/nginx/` + `deploy/systemd/` + `scripts/ops/install/`)**
   - `deploy/nginx/my.readypackets.com.conf`: TLS 1.2/1.3, OCSP stapling, `308` canonical redirect from HTTP and `portal.readypackets.com`, single authoritative HSTS header (`max-age=31536000` without `includeSubDomains`/`preload` until explicit domain-wide owner sign-off), single-hop `X-Forwarded-For $remote_addr` + `X-Forwarded-Proto https` + stripped `X-Forwarded-Host`, loopback-only `/readyz`, unbuffered/uncached `/api/`.
   - `deploy/systemd/readypackets-portal.service` (`RP_ROLE=web`) and `deploy/systemd/readypackets-worker.service` (`RP_ROLE=worker`): dedicated `readypackets` system account, `NoNewPrivileges=yes`, `ProtectSystem=strict`, `PrivateTmp=yes`, `UMask=0077`, and explicit `ReadWritePaths` limited to private object storage and the isolated recovery sandbox.
   - Installer & release lifecycle scripts:
     - `scripts/ops/install/install-vps.sh`
     - `scripts/ops/install/upgrade-vps.sh` (mandatory pre-upgrade encrypted backup + byte-level verification before forward-only migrations)
     - `scripts/ops/install/rollback-vps.sh` (atomic code symlink rollback; see `docs/runbooks/upgrade-rollback.md` for isolated restore data cutover)

2. **Docker Profile (`deploy/docker/`)**
   - `deploy/docker/Dockerfile`: multi-stage `node:22.14-bookworm-slim` image running as non-root `10001:10001`, compatible with `--read-only` root filesystem (`tmpfs: /tmp`), includes `default-mysql-client` so `portal-worker` can execute `mysqldump`/`mysql` for encrypted backups and isolated restore drills.
   - `deploy/docker/docker-compose.yml`: `mysql:8.4` on an `internal: true` network, one-shot `portal-migrate`, `portal-web` bound strictly to `127.0.0.1:5000:5000`, and `portal-worker`, with all secrets mounted from `0600` files via Docker `secrets:` (`*_FILE`).

## Configuration & Secrets

Copy `server/config/env.example` to `/etc/readypackets/portal.env` (`0640 root:readypackets`) and generate distinct cryptographic keys using:

```bash
pnpm tsx scripts/ops/keys/generate.ts
pnpm tsx scripts/ops/keys/doctor.ts
```

Never `source` `/etc/readypackets/portal.env` as a shell script. All ReadyPackets tooling parses it strictly as data.
