# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). See `docs/engineering/SDLC.md` for the release
procedure.

## [Unreleased]

### Added

- Increment 03 (administration and integrations). See `docs/engineering/INCREMENT_03_CONTRACT.md` and ADRs
  0024–0028. Everything below ships turned off until an administrator configures it.
  - **E-mail delivery**: sender name and address, reply-to, an audit copy mailbox (a copy of every outgoing
    message, with one-time links removed), SMTP and Microsoft Graph transports with a primary and a secondary
    route (the secondary is used only when the primary definitely did not accept the message), optional
    encrypted retention of sent content, and a "View message" action on the Mail page.
  - **E-mail template centre**: system templates for registration, password reset, maintenance windows, order
    confirmation, invoices and more; custom templates; rich HTML or plain text; declared placeholders;
    versions with publish and restore; inert preview and test send.
  - **Settings forms**: every setting can be edited through a generated form, with the JSON editor kept as a
    second tab.
  - **Order workflow designer**: step-by-step wizard and a drag-or-keyboard canvas over the same draft, with
    validation, "Tidy layout", and versioned publishing (existing orders keep their version).
  - **Automations**: event, schedule and manual triggers; conditions; actions (templated e-mail, in-app
    notice, webhook); wizard and canvas builders; test without sending; run history; portal-wide switch and
    rate limits.
  - **Microsoft Entra ID single sign-on** (OpenID Connect, one tenant): configuration page, "Sign in with SSO"
    button on the sign-in page when enabled, account linking, optional first-sign-in account creation (never
    administrators), local break-glass sign-in for administrators, and a host-side `recover-admin` command.
  - **Storage connections**: Amazon S3, Wasabi, Backblaze B2, custom S3-compatible, Azure Blob, Dropbox,
    Google Drive, SharePoint library and OneDrive for Business as copy destinations for order files and
    backups, with per-provider forms, connection test, and outbound allow-list presets.
  - **SharePoint order sync**: one-way mirror of order rows to a SharePoint list, with backfill and per-order
    status.
  - **Off-site backups**: verified encrypted backups can be copied to assigned storage connections; the
    Backups page shows a 3-2-1 status computed from real verified copies.
  - **Native upgrade**: `deploy/upgrade.sh` and `docs/operations/UPGRADE.md`; the `native-install` workflow
    now also installs the previous release, adds data, upgrades and smoke-tests.

### Changed

- Customer IDs for new customers are `RPCUS-` followed by nine characters from 0-9 and A-Z drawn from the
  operating system's random source. Existing customers keep their ID.

- Native auto-installer for fresh Ubuntu 26.04 LTS servers (amd64 and arm64). Installs prerequisites and
  checksum-pinned Node.js and pnpm, can add swap, and configures public or self-signed TLS for a fixed portal
  host and optional redirect alias. It loads the bundled offerings and saves the first administrator's
  temporary password in a root-only file with one-time display. See the [operator guide](docs/operations/AUTO_INSTALL.md).
- Docker Compose stack for evaluation and testing on any host name (`deploy/docker/`): digest-pinned image
  build, generated secrets in volumes, MySQL 8.4 with required TLS and least-privilege accounts, Caddy with
  automatic certificates, a one-command server setup (`install-vps.sh`) and an operator wrapper
  (`rp-docker.sh`). The `container` workflow builds and exercises the stack end to end.

### Fixed

- Dialogs no longer make the browser report a Content-Security-Policy violation: the scroll lock used by the
  dialog library tried to add a `<style>` element, which the portal's policy forbids. It now relies on rules in the portal's own stylesheet.
- Forced password change after the first sign-in: the page now asks for the "Temporary password" (with a
  hint), no longer shows the misleading advice about passwords "used here before", reports a wrong
  temporary password on that field, and gives password managers the account's sign-in name so that a
  password saved for another account on the same address is not filled in.

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
