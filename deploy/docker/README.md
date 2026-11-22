# ReadyPackets portal on Docker

A self-contained Docker Compose stack for standing the portal up on one server under any host name.
It is meant for evaluation and testing. The hardened native kit ([`../install.sh`](../install.sh), see the
[installation runbook](../../docs/operations/INSTALL.md)) remains the reference layout for
`my.readypackets.com`; the [differences](#differences-from-the-native-kit) are listed below.

## What you need

- A server with Ubuntu 22.04, Ubuntu 24.04 or Debian 12 (amd64 or arm64), about 2 GB of memory (or swap) and
  6 GB of free disk. Any other Linux works if you install Docker Engine 23+ with the Compose and Buildx
  plugins yourself.
- A host name whose DNS record points at the server, for example `portal-test.example.com`. A bare IP address
  is not accepted: certificates and passkeys need a name.
- Inbound TCP 80 and 443 open, and nothing else on the server listening on those ports.
- Read access to this private repository from the server (a GitHub deploy key or a fine-grained token).

## Quick start on a fresh server

```bash
# 1. Get the code (as root, or with sudo)
apt-get update && apt-get install -y git
git clone https://github.com/MadaSito/ReadyPacketsCustomerPortal.git /opt/readypackets-src
cd /opt/readypackets-src

# 2. Install Docker if needed, build the image and start everything
sudo bash deploy/docker/install-vps.sh --domain portal-test.example.com --acme-email you@example.com

# 3. Create the first administrator (asks for a password twice, hidden)
sudo bash deploy/docker/rp-docker.sh admin --email you@example.com --name "Your Name"

# 4. Load the ReadyPackets offerings (packets, tiers, prices)
sudo bash deploy/docker/rp-docker.sh catalog --dry-run
sudo bash deploy/docker/rp-docker.sh catalog
```

Then open `https://portal-test.example.com`, sign in, choose a new password and enrol an authenticator app.

No DNS name yet? Add `--tls-internal` instead of `--acme-email …`: the proxy then uses a self-signed
certificate. The portal works, but browsers show a certificate warning and passkeys may be refused.

If Docker is already installed, step 2 can be `bash deploy/docker/rp-docker.sh up --domain … --acme-email …`.

## Everyday commands

| Command | What it does |
| --- | --- |
| `rp-docker.sh status` | Lists the containers and says whether the portal reports ready |
| `rp-docker.sh logs [service]` | Recent log lines (`web`, `worker`, `db`, `caddy`, `migrate`, `init`); add `-f` to follow |
| `rp-docker.sh up` | Rebuilds and restarts with the saved settings; use it after `git pull` to update (the portal is offline while it updates) |
| `rp-docker.sh down` | Stops the stack; the database, files, keys and certificates are kept |
| `rp-docker.sh destroy` | Stops the stack and deletes everything it stored, after you type the host name |

## What runs

| Service | Role | Reachable from |
| --- | --- | --- |
| `caddy` | TLS and HTTP entry point; obtains and renews the certificate | the internet, ports 80 and 443 |
| `web` | the portal's HTTP server | `caddy` only |
| `worker` | background jobs: mail outbox, SIEM forwarding, schedules | nothing (outbound only, on its own network) |
| `db` | MySQL 8.4 | `web`, `worker` and the one-shot helpers, on an internal network |
| `init`, `db-perms`, `migrate` | run once at each start, then exit | nothing |

Start order: `init` → `db-perms` → `db` → `migrate` → `web` and `worker` → `caddy`.

## Security properties

- **No secrets in files you edit.** `init` creates three database passwords, a private certificate
  authority with one database certificate (the authority's key is then discarded) and the application key
  set. They live as owner-only files in Docker volumes. Nothing secret is in `.env`, in container
  environment variables or on a command line.
- **Database.** No published port; reachable only on an internal Docker network. TLS is required and the
  application verifies the certificate and host name. The runtime account can read and write rows; only the
  separate migrator account can change the schema; the administrative account works on the local socket
  only.
- **Containers.** The application runs as an unprivileged user (uid 10001) with a read-only root file
  system, all Linux capabilities dropped and privilege escalation disabled. The image contains no package
  manager, no development dependencies and no demo-data tool.
- **Edge.** Plain HTTP is redirected to HTTPS, unknown host names are refused, forwarding headers from
  clients are overwritten, and request bodies are capped per route (the same limits as the native kit). The
  proxy keeps no access log, and its error log omits the request target and headers.
- **Network.** `web` listens only on its address on the proxy network, which it shares with `caddy` alone.
  The worker and the database cannot connect to it. As with any Docker setup, processes on the server
  itself can reach container addresses.
- **Images.** Base images are pinned by digest and updated through Dependabot pull requests.

## Where the data lives

Docker volumes, all prefixed `readypackets_`:

| Volume | Contents | If lost |
| --- | --- | --- |
| `db-data` | the database | all records are gone |
| `storage` | uploaded and generated files | all files are gone |
| `app-secrets` | field-encryption keyring, HMAC keys, runtime database URL | **encrypted data becomes unreadable** |
| `migrator-secrets`, `db-secrets` | migrator URL, database passwords and certificate | the database cannot be reached |
| `caddy-data`, `caddy-config` | the web certificate and its account | a new certificate is requested |

`deploy/docker/.env` holds only the host name, the certificate setting, the installation identifier and the
release reference. It is not committed.

To keep a copy of the keys outside the server, export the `app-secrets` volume to an encrypted location you
control, for example:

```bash
( umask 077 && sudo docker run --rm --network none --user 0:0 --entrypoint tar \
    -v readypackets_app-secrets:/s:ro readypackets-portal:local -C /s -cf - . \
  | gpg --symmetric --cipher-algo AES256 -o readypackets-app-secrets.tar.gpg )
```

Treat that file like the keys themselves. A copy of the database volume is only usable together with the
`migrator-secrets` and `db-secrets` volumes, so export those the same way if you copy `db-data`. If one of
the three secret volumes goes missing, the stack refuses to start and names the incomplete volume rather
than creating new keys. If all administrators lose their password or second factors, run `./rp-docker.sh recover-admin --email <admin-email>` on an interactive host terminal (see [`docs/operations/ADMIN-RECOVERY.md`](../../docs/operations/ADMIN-RECOVERY.md)).

## Optional country database

FFmpeg and `prlimit` are packaged in the image; audio conversion remains off until enabled in the portal. For database sourcing, refresh and emergency bypass, follow [Media and country database setup](../../docs/operations/MEDIA_AND_GEOIP.md). The image does not include or download an MMDB.

After initial setup, put the MMDB in a host directory controlled by root and use a Compose override to bind that directory read-only into the web service. Make the directory traversable and database readable by container GID `10001` (for remapped Docker, use the corresponding host group). Do not expose it to the database, Caddy, or the storage volume. Store this override outside the checkout:

```yaml
services:
  web:
    environment:
      PROTECTION_MMDB_PATH: /var/lib/readypackets/geo/country.mmdb
    volumes:
      - type: bind
        source: /srv/readypackets/geo
        target: /var/lib/readypackets/geo
        read_only: true
        bind:
          create_host_path: false
```

To apply it from `deploy/docker` after running the standard wrapper, run `docker compose --env-file .env -f compose.yaml -f /absolute/path/geo.override.yaml up -d --no-deps web`. Keep the same override in subsequent Compose commands that recreate `web`; `rp-docker.sh` uses the base Compose file only. On rotation, replace the host file atomically within the mounted directory and restart the web service with the same Compose files.

## Differences from the native kit

| Topic | Native kit (`deploy/install.sh`) | This stack |
| --- | --- | --- |
| Host name | fixed: `my.readypackets.com` (+ `portal.readypackets.com` redirect) | any name you pass |
| Edge | Nginx with request-rate and connection limits, per-read idle timers, maintenance fence | Caddy; no edge rate or connection limits (the application's own limits still apply), whole-request time budgets instead of idle timers, no maintenance fence |
| Backups | encrypted, verified, scheduled; restore drill | **none** — the image has no database client and no backup key |
| Upgrades | drained, backed up first, forward-only, promoted release trees | build, stop the portal, migrate, start; no backup and no rollback. If a migration fails the portal stays stopped |
| Secrets | root-owned files handed to services by systemd credentials | owner-only files in Docker volumes |
| Process isolation | systemd sandboxing (system-call filter, namespaces, private devices) | container isolation, read-only root, no capabilities |
| Release pinning | a reviewed full commit SHA is required | builds whatever is checked out |

Use this stack to try the portal, demonstrate it and test integrations. Before real customer data, either
use the native kit or accept and close the gaps above (backups first).

## Notes and limits

- **Mail.** SMTP is not configured on a new installation, so invitations, verification and password-reset
  messages are held in the outbox until an administrator configures SMTP in the console. The first
  administrator is created on the command line and needs no e-mail.
- **Demo data.** The demo-data tool is deliberately not in the image and refuses the production profile.
- **Certificates.** With `--acme-email` (or neither option) Caddy requests a public certificate on first
  start. That needs working DNS and open ports 80 and 443. Watch it with `rp-docker.sh logs caddy`. Repeated
  failed attempts count against Let's Encrypt's rate limits, so fix DNS first.
- **Firewall.** The scripts never change firewall rules. Docker publishes container ports ahead of `ufw`
  rules; this stack publishes only 80 and 443.
- **Network ranges.** The stack uses `172.30.250.0/24` (proxy and web), `172.30.251.0/24` (database) and
  `172.30.252.0/24` (worker, outbound). If they collide with an existing network, add `RP_EDGE_SUBNET`,
  `RP_PROXY_IP`, `RP_WEB_IP`, `RP_DATA_SUBNET` and `RP_EGRESS_SUBNET` to `deploy/docker/.env` before the first
  start (the database accounts are bound to the data range when the database is first created).
- **Changing the host name.** `rp-docker.sh up --domain new.example.com` works; passkeys registered under
  the old name stop working, authenticator apps keep working.
- **Existing Docker.** `install-vps.sh` installs Docker only when none is present. An older Docker, or one
  without the Compose and Buildx plugins, is left untouched and the script stops with an explanation.
- **Slow uploads.** The application closes a request it has not fully received within 120 seconds, so very
  large uploads need a correspondingly fast connection. This is the same in the native kit.
- **One server.** Web and worker are single instances on one host.

## How it is verified

The `container` workflow builds the image on a GitHub-hosted runner and starts this stack for `localhost`
with a self-signed certificate, exactly through `install-vps.sh`. It then checks, over verified TLS:
readiness, the application shell and its security headers, the HTTP redirect, refusal of unknown host names
and of other ports in the Host header, the body limits, that only the proxy can connect to the web process,
container hardening, the database accounts and their grants, creation of the first administrator, the
catalogue import, a sign-in, that the proxy's error log holds no request data, an update in place, and that a
stop and start keeps everything. A second job runs the Docker installation step on clean Ubuntu 24.04,
Ubuntu 22.04 and Debian 12 images.

Not verified anywhere: a run on a real VPS, issuance of a public certificate, behaviour under load, arm64.
