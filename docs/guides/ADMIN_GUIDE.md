# Administrator guide — ReadyPackets console

For users with the **Administrator** role. Administrators have every capability in `shared/capabilities.ts`, including
all [staff tasks](./STAFF_GUIDE.md). This guide is written from `client/src/features/**/routes.tsx`, the module
contracts in `server/modules/*/API.md` and the operator tooling in `scripts/ops/` and `deploy/`. Features that exist
only on the server or command line are marked as such. **Disabled in this release** means the feature is deliberately
switched off.

Server installation, TLS, upgrades and go-live checks are in [Install on Ubuntu 24.04](../operations/INSTALL.md) and
[Deployment profiles](../../deploy/README.md). This guide covers using the console.

## Contents

- [Step-up verification](#step-up-verification)
- [First administrator and setup](#first-administrator-and-setup)
- [Customers](#customers)
- [Staff and administrators](#staff-and-administrators)
- [Credential administration](#credential-administration)
- [Catalog and workflows](#catalog-and-workflows)
- [Policies, questionnaires and invoices](#policies-questionnaires-and-invoices)
- [File administration](#file-administration)
- [Settings and features](#settings-and-features)
- [Sign-in page presentation](#sign-in-page-presentation)
- [Configuration export and import](#configuration-export-and-import)
- [Audit centre](#audit-centre)
- [SIEM forwarding](#siem-forwarding)
- [Jobs, schedules, mail and maintenance](#jobs-schedules-mail-and-maintenance)
- [Backups and restore](#backups-and-restore)
- [Portable transfer](#portable-transfer)
- [Integrations](#integrations)
- [Microsoft Clarity and PostHog](#microsoft-clarity-and-posthog)
- [Installing as an app (PWA)](#installing-as-an-app-pwa)
- [Search engines](#search-engines)
- [Feature status summary](#feature-status-summary)

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

## Catalog and workflows

- **Catalog** (`/admin/catalog`, `catalog.manage`) — **Available**. Create and edit product groups and products. A price
  or name change creates a new, immutable product version; existing orders keep theirs.
- **Workflows** (`/admin/workflows`, `workflows.manage`) — **Available**. View and publish versioned order workflows.
  Orders stay bound to the version they started with.

## Policies, questionnaires and invoices

**In progress** (working tree, not committed when this guide was written). The server procedures are in
`server/modules/compliance/API.md`.

- **Policies** (`/admin/policies`, `policies.manage`): write drafts, publish immutable versions (content hash locked),
  mark a policy as required or as needing a typed signature, and view acceptance evidence. Published versions cannot
  be edited or deleted.
- **Questionnaires** (`/admin/intake`, `intake.manage`): build intake questionnaires by default, product or order type,
  and publish immutable versions. Staff review submissions under **Intake review**.
- **Invoices** (`/admin/invoices`): create a draft for an order, issue it (sequential number), void an unpaid or
  fully refunded invoice, and record manual payment or refund evidence. Online card payment is **disabled in this
  release**.

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

## Microsoft Clarity and PostHog

Both are **off by default**, and both are opt-in per visitor. See [ADR 0011](../adr/0011-analytics-consent.md).

1. **Settings** → group **analytics**:
   - **Microsoft Clarity project ID**: the alphanumeric ID only (6–32 characters), never a script snippet.
   - **PostHog project API key**: begins with `phc_`.
   - **PostHog ingest origin**: `https://us.i.posthog.com`, `https://eu.i.posthog.com`, or an exact HTTPS origin you have
     added to **Allowlisted self-hosted PostHog origins** (up to 8).
2. **Features**: turn on **Microsoft Clarity analytics** and/or **PostHog analytics**.
3. What visitors see: a consent banner. Analytics load only after the visitor accepts, and only on `/privacy` and
   `/terms` with no query string or fragment. Sign-in, account, order, file, message, invoice and admin paths are
   permanently excluded.

Current limitation: no client routes exist for `/privacy` and `/terms` yet (the footer links show
"Page not found"), so no analytics run even when they are switched on. The consent banner has not been checked in a
real browser.

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
| Orders, catalog, workflows, order files, sharing | Available |
| Settings, features, sign-in page, configuration transfer, health, setup | Available |
| Audit centre, SIEM forwarding | Available |
| Jobs, schedules, mail, maintenance | Available |
| Portable transfer | Available |
| Backups | Command line and systemd; console pages in progress (uncommitted) |
| Integrations console (SMTP, analytics, outbound connections) | In progress (uncommitted); use Settings and Features meanwhile |
| Messages, support tickets, notifications page, search page | Server available; screens in progress (uncommitted) |
| Policies, intake, invoices (customer, staff and admin screens) | Server available; screens in progress (uncommitted) |
| `/privacy` and `/terms` pages | No routes yet (footer links show "Page not found") |
| Stripe payments, SAML SSO, SharePoint | Disabled in this release |
