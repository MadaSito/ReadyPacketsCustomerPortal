# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). See `docs/engineering/SDLC.md` for the release
procedure.

## [Unreleased]

### Added

- Native auto-installer for fresh Ubuntu 26.04 LTS servers (amd64 and arm64). Installs prerequisites and
  checksum-pinned Node.js and pnpm, can add swap, and configures public or self-signed TLS for a fixed portal
  host and optional redirect alias. It loads the bundled offerings and saves the first administrator's
  temporary password in a root-only file with one-time display. See the [operator guide](docs/operations/AUTO_INSTALL.md).
- Docker Compose stack for evaluation and testing on any host name (`deploy/docker/`): digest-pinned image
  build, generated secrets in volumes, MySQL 8.4 with required TLS and least-privilege accounts, Caddy with
  automatic certificates, a one-command server setup (`install-vps.sh`) and an operator wrapper
  (`rp-docker.sh`). The `container` workflow builds and exercises the stack end to end.

## [0.1.0] - Unreleased

### Added

- Initial secure rebuild of the ReadyPackets customer portal, staff workspace and administration console:
  local authentication with mandatory MFA, modular server (identity, assurance, orders, files, engagement,
  compliance, audit center, SIEM forwarding, platform settings, jobs and mail outbox, portable export/import,
  backup, integrations), hardened HTTP edge, and the React client.
- Portable package contract v3 with a standalone verifier and a deterministic synthetic golden fixture.
- Continuous integration and security scanning workflows, Dependabot configuration, code owners, issue and
  pull request templates, `SECURITY.md`, and the SDLC guide.

### Security

- Security reviews and their remediation status are recorded in `docs/security/`.
