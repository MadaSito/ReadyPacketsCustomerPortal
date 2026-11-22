# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). See `docs/engineering/SDLC.md` for the release
procedure.

## Increment 05

### Added

- **Workflow export and import** (`/admin/workflows`), per [ADR 0042](docs/adr/0042-workflow-transfer.md). Enable `orders.workflow_transfer.enabled` first.
  - Export one workflow, a selection or all of them as an integrity-checked JSON package (`workflows.export`).
  - Import with a preview, then choose for each workflow to create it, add it as a draft or skip it (`workflows.import`, administrators, step-up).
  - Imports are always drafts. Automations are not transferred.
- **Cart suggestions** (`/admin/carts/suggestions`, `/cart`; [ADR 0043](docs/adr/0043-cart-upsell.md)): enable `feature.cart.upsell` (needs `feature.cart`). Up to three server-priced add-on, tier-upgrade or bundle-completion suggestions appear in the cart. Nothing is added without the customer's action. Administrators manage offers with `carts.upsells.manage`. `cart.abandoned_ttl_hours` (default 72) sets when inactive carts expire.
- **Discount codes and links** (`/admin/promotions`, `/promo`; [ADR 0044](docs/adr/0044-discount-codes.md)): enable `feature.promotions`.
  - Percent or fixed codes with scope, dates, limits, allow-lists and single-use batches of up to 5,000 codes.
  - Links (`/promo#promo=<CODE>`) carry the code in the URL fragment, and it is kept only in the browser tab.
  - Redemption is atomic at order creation. The "Largest discount per order" guard (setting `promotions.policy`, field `maxDiscountPercent`) defaults to 50%.
  - Codes work in the cart, at checkout and in the order wizard, not in API v1.
  - A redemption is released only when nothing was paid, no invoice is payable, no provider capture is pending and no online payment was ever started, and only once the order is in a cancel state; administrators can release one by hand under the same rule.
- **Policy acceptance log centre** (`/admin/policy-acceptances`; [ADR 0045](docs/adr/0045-policy-acceptance-log-centre.md)): Log, Coverage and Policy updates tabs, and a **Policies** tab on the admin customer profile. It is always on and read-only. Reading needs `policies.acceptances.read`; CSV export needs `policies.acceptances.export` and step-up, and is limited to 5,000 rows.

### Security

- **Discount code abuse controls:** each code check is rate limited per account and per address. After 5 failed checks in 15 minutes, checking is paused for 15 minutes, and `promotion.attempts_blocked` is sent to the SIEM. Every refusal uses the same message, a verified e-mail is required, staff cannot redeem for themselves, and codes are never logged.
- **Import package handling:** size, depth and count limits, strict schema, digest check (not a signature), and no rendering of imported text as HTML.

### Operations

- **Migration `0005_increment_05`**: additive only (8 new tables, 9 new columns on `orders`, `carts` and `policy_acceptances`, plus indexes and constraints). No existing column is changed or dropped. `deploy/upgrade.sh` applies it; see [UPGRADE.md](docs/operations/UPGRADE.md).
- **Reverse proxy:** the two workflow-import requests accept a body of up to 4,456,448 bytes; every other request keeps the 256 KiB limit. Refresh the nginx or Caddy configuration from `deploy/` when upgrading, otherwise larger workflow packages are refused by the proxy.
- All four features except the acceptance log are off after the upgrade. Switch them on under **Settings** (`/admin/settings`: "Workflow export and import") and **Features** (`/admin/settings/features`: "Cart suggestions (upsell)", "Discount codes and links").

## Increment 04

### Added

- **Workflow phases and requirements** (`/admin/workflows`): enable `orders.workflow_rules.enabled`, then publish a workflow version with phase locks, upload slots and acknowledgements.
- **Console order tools** (`/admin/orders`, `/admin/customers/:customerId`): create and reassign by capability with no switch; enable `orders.console_access.enabled` to grant or revoke delegated access.
- **Audio recording and conversion** (`/admin/files`): enable `files.audio_conversion.enabled` for browser recording and local WebM/Opus conversion; the original is retained.
- **Customer maintenance** (`/admin/maintenance`): enable the customer access notice and set a window separately from worker drain; staff and administrators can still sign in.
- **Knowledge Base and Help Centre** (`/admin/knowledge`, `/help`): enable `feature.knowledge` and publish customer-facing articles.
- **Community forum** (`/admin/community/settings`, `/community`): enable `feature.community` and configure categories, posting rules and moderation.
- **Referrals** (`/admin/referrals`, `/account/referrals`): enable `feature.referrals` and configure `referrals.program` for reward rules and approval.
- **Inbound API v1** (`/admin/api`, `/admin/api/log`): enable `publicApi.enabled` and issue scoped keys; eligible logged requests can be replayed with fresh verification.
- **Signed webhooks** (`/admin/integrations/webhooks`): enable `feature.integrations.webhooks`; configure inbound endpoints or outbound subscriptions and review or rerun eligible deliveries.
- **Cookies and consent** (`/admin/privacy`): enable `feature.privacy.consent` for the preference centre and ledger; `feature.integrations.posthog` and `feature.integrations.clarity` separately gate their vendors.
- **Cart and checkout** (`/admin/carts`, `/cart`): enable `feature.cart`; server-side pricing, orders and invoices work without an online payment provider.
- **Hosted online payments** (`/admin/payments`): set `payments.config.provider` to Stripe or Square after testing; `none` keeps invoice payment. [ADR 0035](docs/adr/0035-hosted-checkout-payments.md) partially supersedes ADR 0014.
- **Storage Copy log** (`/admin/storage/copies`): no separate switch; records attempts when order files, backups or SharePoint order data are copied to enabled destinations.

### Changed

- **Customer navigation** (customer portal): desktop sidebar, smaller-screen drawer and phone shortcuts with More, with no separate switch; feature-dependent links stay hidden while off.
- **Theme and responsive layout** (portal and console): System, Light and Dark are available without a feature switch; shared controls and layouts adapt to screen size.
- **Accessibility** (`/accessibility`): public accessibility information and UI designed and tested against WCAG 2.2 AA; see the [verification record](docs/verification/ACCESSIBILITY.md) for coverage and gaps.
- **Unknown mail outcomes** (`/admin/mail`): no automatic resend or failover; an administrator may queue a separate send after fresh verification and explicit acknowledgment of duplicate risk. No feature switch.

### Security

- **Application Protection** (`/admin/protection`): starts in Detect mode; review events before switching to Enforce or adding IP/country controls. Rate-limit budgets remain bounded.
- **Session centre and restrictions** (`/admin/sessions`, `/admin/sign-in-log`, `/admin/session-restrictions`): logs and session-ending tools are available by capability; restrictions apply only as configured.
- **Payment confirmation** (`/admin/payments`): enabled providers require both a valid webhook and matching payment details fetched from the provider; the browser return cannot mark an invoice paid.

### Operations

- **Native upgrade** (`deploy/upgrade.sh`): `0003_increment_04` is additive, with 48 new tables and 10 nullable columns on existing tables. Keep the encrypted backup and keys off-host before migration.
- **Media and country data**: native install, upgrade and the image include FFmpeg and `prlimit` for optional audio conversion. The operator provides any optional country MMDB locally; no network lookup.

### Added — part B, console order workspace

- **Console order page** (`/admin/orders/:orderId`): a header with Rename order, Change reference, Reassign customer, Invoice and Refund, then status, payment and total badges. The tabs, in order, are Overview, Phases, Intake, Files, Messages, Automation, Sync, Invoices, Refund, Order history, Acceptances, Notes and Sharing. Each has its own address, and on narrow screens they become a drop-down list. No feature switch.
- **Rename an order**: needs `orders.rename` (staff and administrators). The check is version-aware and the reference does not change. Each rename writes the audit event `order.renamed`, which records lengths only, and keeps the old and new names in the order's name history. Staff see "Renamed: old → new" in Order history; customers see "Order renamed".
- **Order history** (replaces Activity): the order's status transitions next to its audited activity, paginated and filterable by category. Customers see only the subset meant for them.
- **Automation tab** (formerly Production), per [ADR 0041](docs/adr/0041-order-automation-tab.md):
  - The Phase I and Phase II cards say why a button is disabled.
  - Pipeline history per order, with Retry for failed dispatches.
  - Redeliver needs `orders.production.redeliver`, step-up, a reason and the phrase `REDELIVER`.
  - Optional Phase III and Phase IV endpoints, hidden until configured.
  - "Run actions" for workflow stage automations needs `orders.automations.run`.
- **Refunds**, per [ADR 0038](docs/adr/0038-provider-refunds.md), which supersedes "refunds are manual" in ADR 0035:
  - Stripe and Square refunds go through the provider's API, idempotent per refund; an unknown outcome is reconciled and never resent.
  - Manual payments get recorded refunds.
  - Needs `payments.refund` (administrators), step-up and the phrase `REFUND ORDER`.
- **Policy acceptance gateway**, per [ADR 0039](docs/adr/0039-policy-acceptance-gateway.md): a workflow gate at order start or before a named step, with a checkbox or typed-name signature. The server refuses work on the order until each acting user accepts, and the evidence is append-only. There is an Acceptances tab and a printable receipt.
- **Order file sync and folder routing**, per [ADR 0040](docs/adr/0040-order-file-sync-folder-routing.md):
  - Folder templates per slot, with a workflow default, edited in the workflow designer and validated on save and at copy time.
  - Uploads, recordings and converted audio are copied to the connections assigned to order files.
  - Per-order SharePoint sync (or File sync) tab, with Retry for failed transfers (`files.manage`).

### Operations — part B

- **Migration `0004_increment_04_part_b`**: additive only. It adds 3 tables (`order_name_history`, `order_policy_acceptances`, `payment_refunds`), 13 nullable columns and indexes, and is applied by `deploy/upgrade.sh`. See [UPGRADE.md](docs/operations/UPGRADE.md).

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
- `deploy/upgrade.sh` no longer stops at the draining phase with "clean shutdown not proved": it read each
  service's exit record after disabling the service, when systemd had already dropped the record. It now
  stops, checks and then disables, and the refusal prints the record it read.
- E-mail confirmation: a confirmation link followed inside the portal while the "Confirm your email" page
  is already open is now used (the preview profile's demo link did nothing before), the server is called
  once per link, and a signed-in person whose address is already confirmed sees "Email confirmed" with
  "Continue" instead of a "Send a new link" button that had nothing left to do.
- Removing analytics vendor data no longer throws where the browser refuses cookie access (for example a
  sandboxed frame).
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
