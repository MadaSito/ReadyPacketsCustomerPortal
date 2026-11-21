# Administrator guide — ReadyPackets console

For users with the **Administrator** role. Administrators have every capability in `shared/capabilities.ts`, including
all [staff tasks](./STAFF_GUIDE.md). This guide is written from `client/src/features/**/routes.tsx`, the module
contracts in `server/modules/*/API.md` and the operator tooling in `scripts/ops/` and `deploy/`. Features that exist
only on the server or command line are marked as such. **Disabled in this release** means the feature is deliberately
switched off.

For new Ubuntu 26.04 LTS servers, start with the [automatic installation guide](../operations/AUTO_INSTALL.md). For
Ubuntu 24.04 LTS or self-provisioned dependencies, see the [manual installation guide](../operations/INSTALL.md).
TLS, upgrades, and go-live checks are in the [deployment profiles](../../deploy/README.md).

## Contents

- [Step-up verification](#step-up-verification)
- [First administrator and setup](#first-administrator-and-setup)
- [Customers](#customers)
- [Staff and administrators](#staff-and-administrators)
- [Credential administration](#credential-administration)
- [Catalog, matrix import and bundle rule](#catalog-matrix-import-and-bundle-rule)
- [Policies, questionnaires and invoices](#policies-questionnaires-and-invoices)
- [File administration](#file-administration)
- [Settings and features](#settings-and-features)
- [Sign-in page presentation](#sign-in-page-presentation)
- [Configuration export and import](#configuration-export-and-import)
- [Audit centre](#audit-centre)
- [SIEM forwarding](#siem-forwarding)
- [Jobs, schedules, mail and maintenance](#jobs-schedules-mail-and-maintenance)
- [Backups and restore](#backups-and-restore)
- [Storage copy log](#storage-copy-log)
- [Portable transfer](#portable-transfer)
- [Integrations](#integrations)
- [Production pipeline (Phase I and Phase II webhooks)](#production-pipeline-phase-i-and-phase-ii-webhooks)
- [Microsoft Clarity and PostHog](#microsoft-clarity-and-posthog)
- [Installing as an app (PWA)](#installing-as-an-app-pwa)
- [Search engines](#search-engines)
- [Feature status summary](#feature-status-summary)
- [Increment 04 operating guides](#increment-04-operating-guides)

## Increment 04 operating guides

Use these chapters alongside the existing console guide. Installing a dependency or configuring a host path does not enable the corresponding portal feature.

- [Media and country database setup](../operations/MEDIA_AND_GEOIP.md): FFmpeg availability, optional country database setup and rotation, and the host-level Protection recovery switch.
- [Native upgrade and migration `0003`](../operations/UPGRADE.md#increment-04-and-migration-0003): the pre-upgrade backup, traffic fence, and recovery after a partially applied migration.
- [Files and media](../../server/modules/files/ADMIN_GUIDE.md): configure uploads and review file and media behavior.
- [Jobs and schedules](../../server/modules/jobs/ADMIN_GUIDE.md): inspect job attempts and manage schedules.
- [Customer maintenance](./CUSTOMER_MAINTENANCE.md): configure and monitor customer maintenance jobs.
- [Application Protection](../../server/modules/protection/ADMIN_GUIDE.md): manage protection policy, offline country lookups and recovery.

## Storage copy log

Open **Storage → Copy log** (`/admin/storage/copies`) as an administrator. The log tracks attempts to copy order files, off-site backup archives and SharePoint order data. History begins at rollout; it does not reconstruct older attempts.

- **Filter and inspect**: Filter by source kind, destination, state, or a UTC date range. The default is seven days and each search can span up to 90 days. Search by source or destination ID, destination name, correlation ID or safe error code. Open **Details** for the destination, bytes when known, attempt number, timestamps and verification method.
- **Read the result**: **Written** means the provider accepted the write, not that a separate check confirmed it. **Verified** means a checksum matched or the provider read-back confirmed the result recorded by that integration. **Not written** can mean canceled or no change was needed. An interrupted job without a confirmed outcome is shown as **Failed**; check the provider before assuming nothing was written.
- **Investigate and retry**: A **Copies failing** signal in System health flags recent recorded failures or unconfirmed outcomes. Select **View audit trail** in **Details** to search the Audit centre by correlation ID. For an eligible failed backup copy, **Retry backup copy** requires step-up verification and queues a new job; the original remains in the history. For other failed attempts, use the source module's recovery process.
- **Export**: **Export CSV** downloads up to the 1,000 newest matching attempts and records an audit event. Narrow the date range or other filters if the export is truncated. Handle the file as an operational log; it contains customer-resource and destination identifiers.

## Step-up verification

Many administrator actions ask you to **verify it's you** with your password plus an authenticator code, passkey or
recovery code. The server enforces it (`STEP_UP_CAPABILITIES` in `shared/capabilities.ts`). The verification is
short-lived and checked again when the action is applied. If you cancel, nothing changes.

## First administrator and setup

1. The first administrator is created during installation by `deploy/install.sh`, or manually with
   `pnpm admin:create --email … --name "…"`. The password is read from `RP_BOOTSTRAP_ADMIN_PASSWORD_FILE` or a hidden
   prompt, never from the command line. The command refuses if an active administrator already exists.
2. Sign in, set a new password, set up an authenticator app and store the recovery codes offline.
3. Open **Setup** (`/admin/setup`). The checklist is built from live configuration and module health, not from
   self-reporting. Work through every item.
4. Invite a second named administrator from **Staff** so the installation never depends on one account.
5. Check **System health** (`/admin/health`).

## Customers

**Available** — `/admin/customers`, `/admin/customers/:customerId`.

- **Create a customer**: enter email, name and an optional customer reference. The customer receives an invitation
  (72-hour link).
- **Resend invitation**, **suspend**, **deactivate** or **reactivate**, each with a reason code.
- **Change customer reference** (step-up). Retired references are kept in **Reference history** and never reused.
- **Sign out sessions**: revokes every session for that customer (step-up).
- **Credentials** tab: see [Credential administration](#credential-administration).

## Staff and administrators

**Available** — `/admin/staff` ("Staff and administrators").

- **Invite staff member** (step-up): email, name and role (**Staff** or **Administrator**).
- **Change role** (step-up): Staff, Administrator, or **Customer (removes console access)**. Changing a role signs that
  user out everywhere. The last active administrator cannot be demoted.

## Credential administration

**Available** — the **Credentials** tab on a customer's detail page (`customers.credentials.administer`, step-up).
See [ADR 0004](../adr/0004-admin-credential-administration.md).

**Password administration** → **Reset method**:

| Method | What happens |
| --- | --- |
| **Email a set-password link** | Requires a verified email address and ready SMTP. Clears the old password, signs the user out and emails a 24-hour link. |
| **Generate a temporary password** | Shown to you once. The user must choose a new password after completing MFA at the next sign-in. |
| **Enter a temporary password** | Same as above, with a password you type. |

**Multi-factor authentication** → **Reset MFA** removes the user's authenticator, passkeys and recovery codes, so they
enrol again at next sign-in. Use it only after verifying the person's identity outside the portal. A reset also
releases an authenticator app blocked after 50 failed codes.

All of these are audited. You never see a user's existing password or codes.

## Catalog, matrix import and bundle rule

- **Catalog** (`/admin/catalog`, `catalog.manage`) — **Available**. Create and edit product groups and products:
  - **Group dialog**: **Packet number** (*"Only for packet groups. Leave empty for other groups."*) and **Group key**
    (*"Optional import key, e.g. packet-1."*). Packet group cards show a **Packet N** badge.
  - **Product dialog**: **Tier** (**Basic**, **Standard** or **Premium** — shown and required for packet groups),
    **Outcome**, **Timeline** and **Deliverables** (*"One per line as: Title | detail. When set, the features list is the
    deliverable titles."*). Non-packet products leave packet number and tier unset.
  - Editing a product's name, price, outcome, timeline or deliverables publishes a new, immutable product version; existing
    orders keep the snapshot they were placed under.
  - For packet products, the server enforces quantity `1` and at most one tier per packet in a single order.
- **Importing the Master Offerings Matrix** (`ops:catalog-import`, command line) — [ADR 0022](../adr/0022-offerings-matrix-as-catalog-data.md):
  - Fresh installations start with an empty catalog; no packet names or prices are hardcoded in application code.
  - Load or update `data/catalog/readypackets-offerings-v3.0.json` (validated against `data/catalog/offerings.schema.json`):
    - Preview without writing: `pnpm ops:catalog-import --dry-run` (or `--file <path> --dry-run`).
    - Apply idempotently: `pnpm ops:catalog-import` (or `node dist/ops/catalog-import.js --file <path>` on a deployed host).
  - The command runs as an audited operator session: it creates missing groups and products by `groupKey` / `productKey`,
    creates a new product version only when content or price changed, configures the bundle rule below, and prints a
    summary. It never deletes catalog items and refuses any file that fails schema validation.
  - **Packet 7 ("The All-In")** is not a catalog product — it is how multi-packet bundle orders are represented, governed
    by the bundle rule below. **Packet 8** is recorded under `reserved` in the data file as unlisted and is not imported
    (if ever authorized, an administrator can add a product manually in **Catalog**).
- **Bundle discount** (**Bundle discount** card → **Edit bundle discount** at the top of `/admin/catalog`, setting key
  `orders.bundle_rule`, audited as `catalog.bundle_rule.changed` and `platform.setting.changed`):
  - Dialog fields: **Apply the bundle discount**, **Required packets** (comma-separated, set to `1, 2, 3, 4, 5, 6` by the
    matrix import), **Discount (%)** (`15` for the Master Bundle) and **Label** (for example `The All-In (Master Bundle)`).
  - Off by default on a blank installation until imported or enabled by an administrator.
  - When enabled and an order contains every required packet (at any combination of **Basic**, **Standard** or **Premium**
    tiers), the server applies the percentage discount (rounded half up) to the order subtotal (`total = subtotal - discount`)
    and snapshots **Subtotal**, the discount **Label** and **Total** on the order. Existing orders keep their amounts, and
    the browser never sends prices or discount amounts.
- **Workflows** (`/admin/workflows`, `workflows.manage`) — **Available**. View and publish versioned order workflows.
  Orders stay bound to the version they started with.

## Policies, questionnaires and invoices

**Available** — `/admin/policies`, `/admin/intake`, `/admin/intake/submissions` and `/admin/invoices` (see
`server/modules/compliance/API.md`).

- **Policies** (`/admin/policies`, `policies.manage`, step-up to write): write drafts, publish immutable versions
  (SHA-256 content hash locked), mark a policy as required or as needing a typed signature, and view acceptance evidence.
  Published versions cannot be edited or deleted. Before enabling the **Production pipeline**, ensure your published
  customer privacy notice (and `/privacy`) reflects that order metadata, client name and email are sent to the production
  pipeline when Phase I is started.
- **Questionnaires** (`/admin/intake`, `intake.manage`): build intake questionnaires scoped by default, catalog item or
  workflow, and publish immutable versions. Staff review customer submissions under **Intake review**
  (`/admin/intake/submissions`, `intake.review`).
- **Invoices** (`/admin/invoices`, `invoices.manage`, step-up to write): create a draft for an order, issue it
  (sequential number), void an unpaid or fully refunded invoice, and record manual payment or refund evidence with an
  idempotency key. Online card payment is **disabled in this release**.

## File administration

**Available** — `/admin/files`.

- **Upload rules**: maximum size per file, maximum request size, files per upload and trash retention in days. Rules
  can only narrow the built-in format allowlist; they cannot allow arbitrary types. Changes require step-up.
- **Recorded storage usage**: counts for stored versions and files in trash (not disk capacity).
- **Antivirus scanning**: the production build has **no scanner configured** (`files.antivirus` health component).
  The page says so.

## Settings and features

- **Settings** (`/admin/settings`, `platform.settings.manage`) — **Available**. Settings are grouped by module. Every
  change requires step-up, uses optimistic concurrency (a conflict if someone changed it first) and is audited. Secrets
  are write-only: the page shows only whether a secret is set and when. **Remove secret** stops dependent features.
- **Features** (`/admin/settings/features`) — **Available**. Installation-wide switches. All default to **off**.

| Feature switch | Owner |
| --- | --- |
| Scheduled daily backups and verification | backup |
| Automated scheduled retention pruning | backup |
| Off-host backup replication | backup |
| Outbound SMTP mail | integrations |
| Microsoft Clarity analytics | integrations |
| PostHog analytics | integrations |
| Stripe webhook adapter | integrations (**Disabled in this release**; cannot activate online payment) |

Do not turn on the in-app backup schedule if the host uses the `readypackets-backup.timer` systemd timer. Use only
one scheduler ([INSTALL.md](../operations/INSTALL.md#backups-and-audit-forwarding)).

## Sign-in page presentation

**Available** — `/admin/settings/presentation` ("Sign-in page").

- **Slides**: title, text and an image with a required **Image description** (alt text). The sign-in page shows only
  the form when there are no slides.
- **Advance slides automatically** and **Seconds per slide**: visitors can always pause, and a reduced-motion
  preference turns autoplay off.
- **Support text** and **Show an announcement** (a short banner above the sign-in form, with a tone).
- **Images**: PNG, JPEG or WebP up to 2 MiB. Metadata is removed and images are served with strict headers. An image
  used on a slide cannot be deleted.

## Configuration export and import

**Available** — `/admin/settings/transfer` ("Export and import"), step-up.

- **Export configuration** downloads a settings file. **Include secrets** adds only secrets their module allows to be
  exported, encrypted with your passphrase.
- **Import configuration** shows a preview of the differences. Nothing changes until you choose **Apply changes**, and
  the apply step must match the previewed digest.

This moves configuration only. For business data use [Portable transfer](#portable-transfer); for disaster recovery
use [Backups](#backups-and-restore).

## Audit centre

**Available** — `/admin/audit` and its sub-pages. See [ADR 0006](../adr/0006-audit-trail.md) and
[Logging and audit](../operations/LOGGING_AND_AUDIT.md).

| Page | Capability | Use it to |
| --- | --- | --- |
| **Audit center** `/admin/audit` | `audit.read` | Search by ID, quick filters or the AND/OR builder; open event detail; pivot on actor, resource or request; reveal a source address (audited); add events to a case; save a search |
| **Saved audit searches** `/admin/audit/saved` | `audit.read` | Reopen saved searches; delete your own |
| **Investigation cases** `/admin/audit/cases` | `audit.read` (changes `audit.cases.manage`) | Create cases, set status, attach events, add encrypted notes |
| **Audit exports** `/admin/audit/exports` | `audit.export` (step-up) | Request exports with a manifest and SHA-256; at most 3 active per user |
| **Audit integrity** `/admin/audit/integrity` | `audit.read` (checkpoints `audit.retention.manage`) | Verify the hash chain; create signed checkpoints |
| **Audit retention** `/admin/audit/retention` | `audit.retention.manage` (step-up) | Set policies, place and release legal holds, preview and run retention (type `REMOVE` to confirm) |

Every search and view in the audit centre is itself audited. Store checkpoint evidence off the host. The current
database profile does not enforce append-only separation, so review that before setting retention.

## SIEM forwarding

**Available** — `/admin/siem` (`siem.read`; changes need `siem.manage` and step-up).

1. **New SIEM destination**: name, **Forwarding format** (syslog over TLS per RFC 5425, JSON lines over TLS, CEF over
   TLS, or OTLP over HTTPS), receiver host and port, **Minimum severity**, and for OTLP the path and an authentication
   header. Certificate verification is always required; add a CA bundle and client certificate for mTLS if needed.
2. The receiver must also be allowed by the installation's outbound egress policy. **Allow an approved private network
   receiver** is needed for private addresses.
3. A new destination **starts paused**. Send a test, confirm receipt at the collector, then enable it.
4. The destination page shows **Summary** (delivery health, backlog, circuit state, latest test), **Delivery log**
   (7 days of tests and exceptions) and **Quarantine** (dead letters you can replay or purge).

Events are pseudonymised before they leave the portal. Secrets are write-only. See `server/modules/siem/API.md` for
the delivery and ordering guarantees.

## Jobs, schedules, mail and maintenance

**Available** — `jobs.read`; actions need `jobs.manage`, maintenance and acknowledgement need step-up.

- **Jobs** (`/admin/jobs`) and **Job details**: state, attempts and outcome. Cancel queued jobs; retry only jobs
  classified as safe. A job with an **unknown** outcome is never retried automatically. Check the provider, then
  **acknowledge** it; that is an attestation and does not change the outcome.
- **Schedules** (`/admin/schedules`): recurring jobs. Missed slots are skipped, not replayed.
- **Mail** (`/admin/mail`): the outgoing queue and attempts without recipients or content. "Accepted" means the SMTP
  server accepted the message, not that it was delivered. Held or refused messages can be resent while still valid.
  **Captured mail** exists only in development and test; preview and production refuse capture.
- **Maintenance** (`/admin/maintenance`): pause new worker claims and watch the queue drain before an upgrade.
  "Drained" applies to this queue only. Follow the upgrade runbook in [INSTALL.md](../operations/INSTALL.md#upgrade-and-rollback).

## Backups and restore

**Command line and systemd today.** Console pages (**Backups** `/admin/backups`, backup detail, **Restoring a backup**
`/admin/backups/restore` and **Backup retention** `/admin/backups/retention`, all `backup.read`) are **in progress**:
they exist in the working tree but were not committed when this guide was written. In the native profile the web and
worker processes deliberately do not receive the backup key, so use the command line there.

- One-off: `sudo systemctl start readypackets-backup@cli.service`, or `tsx scripts/ops/backup/run-backup.ts --verify`.
- Scheduled: `readypackets-backup.timer` (do not also enable the in-app schedule).
- Verify: `scripts/ops/backup/verify-backup.ts`. Verification is not a restore test.
- Restore drill: `scripts/ops/restore/restore-isolated.ts`, only into an empty isolated database and storage directory.
- Copy encrypted archives off the host and escrow the backup key separately from the archives.

Details: [INSTALL.md](../operations/INSTALL.md#backups-and-audit-forwarding) and `server/modules/backup/API.md`.

## Portable transfer

**Available** — `/admin/portable` (`portable.export` / `portable.import`; every change and download needs step-up).
This is a business-data transfer between ReadyPackets installations, **not a backup**.

- **Export**: **New export** → choose all records, selected customers (with their orders) or selected orders (with
  their owners) → set a transfer passphrase. Keep the passphrase separate from the package. Downloads expire after
  24 hours.
- **Import**:
  1. **Upload a package**. It is quarantined and cannot change anything yet.
  2. **Verify and plan** with the package passphrase. This dry run shows the exact plan. There is no email-based
     linking, no overwrites and no active credentials. Imported orders are read-only.
  3. **Approve** the plan.
  4. Review **Reconciliation**.
  5. A **different administrator** gives final acceptance after independently confirming access, locks and downloads.
- Checkpoints, held content and uncertain outcomes (`held-unknown`) are shown on the import page.

Package format and the offline `verify` tool: [portable/docs/CONTRACT.md](../../portable/docs/CONTRACT.md), [portable/API.md](../../portable/API.md) and `server/modules/portable/API.md`.

## Integrations

The dedicated console pages are **in progress** (working tree, not committed when this guide was written):
**Integrations** `/admin/integrations`, **E-mail (SMTP)** `/admin/integrations/smtp`, **Analytics**
`/admin/integrations/analytics` and **Outbound connections** `/admin/integrations/egress`, all `integrations.manage`.
Until they land:

- Turn providers on or off on **Features**, and set their values on **Settings** (groups **mail** and **analytics**).
- SMTP: configure an approved host with authenticated TLS, then confirm delivery to an approved inbox. Never enable
  mail capture in production ([INSTALL.md](../operations/INSTALL.md#install-and-enroll-the-first-administrator)).
- **Disabled in this release**: Stripe online payments (staff record offline payments), SAML single sign-on (local
  sign-in with MFA is the only method) and SharePoint storage (local encrypted storage is the file backend). These
  refuse activation on the server.

## Production pipeline (Phase I and Phase II webhooks)

**Available** — **Production pipeline** (`/admin/integrations/production`, `integrations.manage`, step-up to save settings)
and the console-only **Production** tab on `/admin/orders/:orderId/production` (`orders.production.trigger`). Off by default;
no live URL, credential or canon version ships with the portal ([ADR 0023](../adr/0023-production-pipeline-webhooks.md)).

### Configuring the production pipeline

1. **Allow outbound egress**: on **Outbound connections** (`/admin/integrations/egress`), add an allow-list rule for your
   webhook receiver host with purpose `webhook`. Destinations must use `https://`, pass pinned DNS resolution, and
   redirects are refused.
2. **Pipeline settings** on `/admin/integrations/production` (step-up on **Save settings**, audited as
   `integration.production.settings.changed`):
   - **Enable production pipeline webhooks** switch.
   - **Canon version** (required before enabling, for example `ReadyPackets_Production_v2.0`; no default).
   - **Request timeout (seconds)** (default `10`, maximum `30`).
   - **Run mode** (default `production`, pattern `^[a-z][a-z0-9_]{0,31}$`).
   - **Phase I (P101) webhook URL** and **Phase II (P201) webhook URL** (`https://` only). Webhook URLs embed secret tokens
     and are stored encrypted — the page shows only the host and last 4 characters, with **Remove saved Phase I (P101)
     webhook URL** / **Remove saved Phase II (P201) webhook URL** controls.
   - **Authorization header name** and **Authorization header value** (optional; value is write-only encrypted, with
     **Remove saved authorization header value**).
3. **Destination allowlist check**: choose **Test Phase I (P101) destination** and **Test Phase II (P201) destination** to
   dry-run the configured URLs against the egress policy and DNS without sending any webhook payload.

### Starting Phase I (P101), starting Phase II (P201) and re-sending

Day-to-day operator steps are in [Staff guide — Starting Phase I and Phase II](./STAFF_GUIDE.md#starting-phase-i-and-phase-ii-production-pipeline).
Key administrator controls and guarantees:

- **Eligibility & validation**: only orders containing packet products (and zero non-packet items) can be sent. Single-packet
  orders send that packet number (`"1"`–`"6"`) and tier; multi-packet orders send `packet = "7"` and `tier = "Mixed"`.
  `bundle_scope_manifest` is sent as an escaped JSON string (`"{\"packet_1\":\"Premium\"}"`), and `order_scope_mode` is
  never sent. Contradictory combinations are refused before anything is queued (`integration.production.dispatch.refused`).
- **Start Phase I** (**Phase I intake (P101)**): writes an encrypted outbox record in the same database transaction and
  delivers it via the background job worker with `Idempotency-Key`, `X-ReadyPackets-Delivery` and correlation headers.
- **Start Phase II** (**Phase II start (P201)**): enabled only after Phase I (`P101`) for the same order reaches
  **Delivered**, and requires checking **"I confirm the Phase I final output artifacts exist for this order ID"** (the
  portal receives no inbound completion callback). `P201` copies the exact `customer_id`, `order_id` and `run_mode`
  recorded on the delivered `P101` so a later reference change cannot split a run.
- **Retries, personal-data clearing and Production dispatches**: network errors, `429` and `5xx` responses retry with
  bounded backoff; other `4xx` responses stop immediately. The encrypted personal-data payload (`client_name`,
  `client_email`) is cleared from the outbox row as soon as the dispatch reaches a final state. Under **Production
  dispatches** on `/admin/integrations/production`, filter across orders by **Order reference**, **Phase** (**All phases**,
  **Phase I intake (P101)**, **Phase II start (P201)**), **State** (**All states**, **Queued**, **Sending**, **Delivered**,
  **Failed (retrying)**, **Dead-lettered**), **From date** and **To date**, and open the correlated audit trail directly.
- **Re-sending (Administrator + step-up)**: at most one delivered `P101` and one delivered `P201` are allowed per order
  by default. Administrators can choose **Re-send Phase I** or **Re-send Phase II** on the order's **Production** tab,
  enter a **Reason for re-send** of at least 8 characters (plus **"I confirm the Phase I final output artifacts exist for
  this order ID"** for Phase II), and choose **Confirm Phase I re-send** / **Confirm Phase II re-send** with fresh step-up
  verification (`integration.production.dispatch.resent`). Audit events never contain webhook URLs, auth headers, client
  names or client emails.

## Microsoft Clarity and PostHog

Both are **off by default**, and both are opt-in per visitor. See [ADR 0011](../adr/0011-analytics-consent.md).

1. **Settings** → group **analytics**:
   - **Microsoft Clarity project ID**: the alphanumeric ID only (6–32 characters), never a script snippet.
   - **PostHog project API key**: begins with `phc_`.
   - **PostHog ingest origin**: `https://us.i.posthog.com`, `https://eu.i.posthog.com`, or an exact HTTPS origin you have
     added to **Allowlisted self-hosted PostHog origins** (up to 8).
2. **Features**: turn on **Microsoft Clarity analytics** and/or **PostHog analytics**.
3. What visitors see: a consent banner. Analytics load only after the visitor accepts, and only on `/privacy` and
   `/terms` with no query string or fragment (for unauthenticated visitors). Sign-in, account, order, file, message,
   invoice and admin paths are permanently excluded.

## E-mail template centre

Open **Console → Integrations → E-mail templates** (`/admin/email-templates`, requires `mail.manage` and fresh step-up
confirmation) to customise built-in system notifications or create reusable custom templates (`custom.<slug>`) for
automations:

- **System vs custom templates:** Every built-in mailer template (`auth.*`, `orders.*`, `compliance.*`, `engagement.*`,
  `platform.maintenance_window`) can be customised, versioned, and reset to its built-in default at any time while
  preserving version history. Required variables (such as single-use reset or verification `{{link}}` placeholders) are
  enforced before publishing in both HTML and plain-text bodies, and sensitive placeholders remain redacted in audit
  copies and retained message previews.
- **Safe HTML and mandatory plain text:** HTML templates are sanitised against an explicit server-side allow-list on
  save and on send, and always include a plain-text alternative (derived automatically from HTML or edited manually).
- **Inert preview & Send test to me:** Preview renders sample variables inside a sandboxed structure-only frame with no
  scripts, outbound links, or external image requests. **Send test to me** queues a `[TEST]`-prefixed message addressed
  solely to the signed-in administrator's own account.

## Installing as an app (PWA)

The portal ships a web app manifest (`client/public/manifest.webmanifest`, "ReadyPackets Customer Portal") and a
service worker (`sw.js`). Page navigations and `/api` are always fetched from the network, and `index.html` is not
cached, so a revoked session or a new release is never hidden by the cache. Offline visitors see `offline.html`.

Users install it from the browser (see the [Customer guide](./CUSTOMER_GUIDE.md#install-the-portal-as-an-app)). As an
administrator:

- Serve the portal only over HTTPS on the canonical host. Service workers require it.
- Do not let an edge cache store `index.html` or `sw.js` (a [go-live check](../operations/INSTALL.md#go-live-checklist)).
- The update prompt and offline page have **not yet been verified** in real browsers.

## Search engines

The portal is an authenticated application and is intentionally **not indexed**: `/robots.txt` returns
`Disallow: /` ([ADR 0010](../adr/0010-indexing-boundary.md)). Search engine work belongs to the public marketing site.

## Feature status summary

| Area | Status |
| --- | --- |
| Customers, staff, credential administration | Available |
| Orders, packet catalog (`ops:catalog-import`), bundle rule, workflows, order files, sharing | Available |
| Settings, features, sign-in page, configuration transfer, health, setup | Available |
| Audit centre, SIEM forwarding | Available |
| Jobs, schedules, mail, maintenance | Available |
| Portable transfer | Available |
| Policies, intake questionnaires & review, invoices (manual payment/refund ledger) | Available |
| Production pipeline (P101 / P201 manual webhooks, outbox & dispatch monitor) | Available (off until configured) |
| Public `/privacy` and `/terms` draft notices | Available (drafts pending legal review) |
| Backups | Command line and systemd; console pages available for status/metadata |
| Integrations console (SMTP, analytics, outbound connections) | Available |
| Messages, support tickets, notifications, global search | Available |
| Stripe online payments, SAML SSO, SharePoint | Disabled in this release |
