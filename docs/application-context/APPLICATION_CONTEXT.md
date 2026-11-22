# ReadyPackets Portal — Application Context

Living reference for anyone (human or tool) continuing this work. Keep it current with every substantive
change. It describes intent and state; it is not a certification or a guarantee.

## Product

| Item | Value |
| --- | --- |
| Company (legal) | Ready Packets Consulting LLC |
| Brand | ReadyPackets™ — "Your Business, Professionally Packeted™" |
| Public marketing site | https://www.readypackets.com (separate system) |
| Customer portal (this repository) | https://my.readypackets.com (canonical); `portal.readypackets.com` redirects to it |
| Audiences | customers, staff, administrators |
| Hosting | self-hosted single server (Nginx + systemd): automatic native setup on Ubuntu 26.04 LTS, manual native setup on Ubuntu 24.04/26.04 LTS; Docker Compose for evaluation and testing (Caddy + MySQL, `deploy/docker/`) |

## Owner instructions that govern every change

1. Self-hosted. No dependency on hosted AI or builder services at runtime; no authentication through such services.
2. Local authentication with mandatory MFA until other methods are deliberately configured.
3. Advanced, correlated logging; an audit log center with advanced filtering; secure forwarding to SIEM/syslog.
4. Modern SDLC and security practice; minimise OWASP Top 10 classes of defect; zero-trust authorization.
5. Professional, elegant, fully responsive UI; accessibility target WCAG 2.2 AA (web and, later, mobile apps).
6. Code, this application context and session logs are version-controlled and pushed to GitHub regularly.
7. Search discoverability (SEO/GEO/AEO) is maximised on the public site; private portal routes are `noindex`.
8. Optional PostHog and Microsoft Clarity integration with configurable identifiers (consent-gated, off by default).

## Source documents

- `docs/source-specs/MASTER_PROMPT.md` — secure rebuild master prompt
- `docs/source-specs/ARCHITECTURE.md` — technical architecture (with diagrams in `docs/source-specs/media/`)
- `docs/source-specs/increment-02/` — Master Offerings Matrix v3.0 and the P101 / P201 production webhook
  references (the "corrected" P101 logic wins where the two webhook documents differ)
- [Increment 04 contract](../engineering/INCREMENT_04_CONTRACT.md) and ADRs 0029–0037
- `docs/brand/` — brand guide and colour tokens; approved assets in `client/public/brand`, fonts in `client/public/fonts`
- This repository: GitHub `MadaSito/ReadyPacketsCustomerPortal` (private)
- Previous implementation: GitHub `readypackets/ReadyPackets-SiteSplit` (reference only; its documented defects are not carried over)

## Technology

React 19 · TypeScript · Tailwind CSS 4 · Vite 8 · wouter · TanStack Query · tRPC 11 · Zod 4 · Node.js 22 LTS ·
Express 5 · MySQL 8 · Drizzle ORM · Argon2id · TOTP (RFC 6238) · WebAuthn · Vitest · ESLint.

## Architecture summary

Modular monolith. One codebase runs as `RP_ROLE=web`, `worker` or `all`.

```
client/            React application (features/<module>, ui design system, app shells)
server/core        contracts, errors, request context, ids, clock
server/config      validated configuration (fails closed on weak or missing secrets)
server/http        request pipeline: context → host/edge admission and protection → isolated service routes
                   or browser path (headers/CSP, bounded body parsing, session and CSRF checks)
server/security    field encryption, rate limiter
server/observability structured logger with redaction and correlation
server/trpc        procedure guards and root router
server/modules     identity, assurance, orders, files, engagement, compliance, audit, siem, platform,
                   jobs, portable, backup, integrations, mailTemplates, automations, storage, sharepoint,
                   protection, publicApi, knowledge, community, referrals, cart, payments
portable/          vendor-neutral portable data contract, verifier CLI, reference importer, adapters
deploy/            native auto-install and manual kit, Nginx templates, systemd, MySQL; docker/ = evaluation
migrations/        versioned forward-only SQL migrations
docs/              specs, engineering contract, ADRs, runbooks, verification, context, session logs
```

Native deployment entry points are `deploy/auto-install.sh`, `deploy/install.sh`, `deploy/upgrade.sh` and
`deploy/uninstall.sh`, serialized by `/run/readypackets-deploy.lock`. The installer records the fixed
portal host and optional alias, plus the switchable TLS mode, in `/etc/readypackets/site.conf`. It
renders the Nginx site and edge/TLS snippets, publishes under `/opt/readypackets/releases/<commit>`,
and keeps private data under `/var/lib/readypackets/storage`. Automatic setup can add
`/swapfile.readypackets` and its `/etc/fstab` entry. It saves first-admin credentials in
`/root/readypackets-initial-admin.txt`, with one-time display. See the [automatic installation guide](../operations/AUTO_INSTALL.md)
for setup and `.github/workflows/native-install.yml` for the defined runner checks.

Key rules: see `docs/engineering/BUILD_CONTRACT.md` (ownership, data conventions, authorization, audit,
errors, client conventions).

## Offerings and production pipeline (increment 02)

- The catalog is owner-controlled data, not code: `data/catalog/readypackets-offerings-v3.0.json` is loaded by
  the audited `pnpm ops:catalog-import` command (ADR 0022). Packets 1–6 each have Basic / Standard / Premium
  tiers (18 products); a customer picks at most one tier per packet, quantity one.
- "Packet 7" is not a product. It is a bundle rule: 15% off when all six packets are in one order, computed
  on the server and stored on the order as subtotal / discount / total. The rule is an admin setting.
- Packet 8 is not loaded and is not offered (the master prompt forbids restoring it; the matrix marks it
  unlisted). Internal-only notes in the matrix are never shown to customers.
- Production pipeline (ADR 0023): staff start Phase I (P101) and Phase II (P201) by hand from the console
  order page. The portal posts the exact field set of the reference documents to owner-configured HTTPS
  endpoints through an outbox with retries. It is disabled until an administrator configures the endpoints
  and the canon version. There is no inbound callback. See `docs/integrations/PRODUCTION_WEBHOOKS.md`.

## Administration and integrations (increment 03)

Contract: `docs/engineering/INCREMENT_03_CONTRACT.md`; decisions: ADRs 0024–0028; migration
`migrations/0002_integrations_mail_sso_automations.sql`. Everything is off until configured.

- **Mail**: one mail engine with SMTP and Microsoft Graph transports and a primary / secondary route. The
  secondary is tried only when the primary definitely did not accept the message; an unknown outcome is
  never resent automatically. Sender, reply-to and an audit copy mailbox are settings (`/admin/email-delivery`). Sent
  content is stored (encrypted, time-limited) only when retention is on; then the Mail page offers "View
  message" to holders of `mail.content.read`.
- **Templates** (`/admin/email-templates`): system and custom templates, HTML or text, logic-less
  `{{placeholder}}` fields that must be declared, sanitized on save and on render.
- **Workflow designer** (`/admin/workflows`): wizard and canvas edit the same draft; publishing creates a
  new version; orders keep the version they were created with.
- **Automations** (`/admin/automations`): trigger → conditions → actions. Events caused by an automation
  never trigger automations. The portal-wide switch and limits are on the Automations page.
- **Single sign-on** (`/admin/sso`): OpenID Connect with one Entra ID tenant. Routes
  `/api/identity/sso/start` and `/api/identity/sso/callback`; the redirect URI to register is
  `{canonical origin}/api/identity/sso/callback`. Local sign-in with MFA always remains for administrators;
  `scripts/ops/recover-admin.ts` restores local administrator access from the host. Not available in the
  preview profile.
- **Storage connections** (`/admin/storage`) are copy destinations; the local store is the system of record.
  Purposes: `order_files`, `backups`, `order_data`. Outbound hosts must be allowed first (presets on the
  same page). **SharePoint order sync** is at `/admin/sharepoint-sync`.
- **Off-site backups**: verified `.rpbk` archives are copied to the connections assigned to `backups`; the
  3-2-1 card counts real verified copies only. The backup key never leaves the host.
- **Customer reference**: `RPCUS-` + nine characters (0-9, A-Z) from the OS random source
  (`generateCustomerRef()` in `server/modules/identity/users.ts`).
- **Capabilities added**: `mail.manage`, `mail.content.read`, `automations.read`, `automations.manage`,
  `storage.manage`, `identity.sso.manage`.
- **Client API facades**: features that type their own API facade must add it to
  `client/src/features/facadeContracts.typecheck.ts` so drift from the server router fails the type check.
- **Upgrading an installed server**: `docs/operations/UPGRADE.md` (`deploy/upgrade.sh`).

## Increment 04 components and operating defaults

Migration [`0003_increment_04`](../../migrations/0003_increment_04.sql) adds 48 tables and 10 nullable columns. The release adds new console features without turning on optional customer surfaces or external providers, and leaves existing configuration in place. Application Protection starts in Detect, not Enforce.

| Module | Responsibility and switches |
| --- | --- |
| `protection` | Application-level rules, IP/country lists, rate-limit tuning and correlated events at `/admin/protection`. Supplements the network firewall. |
| `publicApi` | Scoped service keys, optional signing, write idempotency, redacted request log and guarded replay. `publicApi.enabled` defaults off (`/admin/api`, `/admin/api/log`). |
| `knowledge` | Versioned articles, search and attachment access at `/help`; enable `feature.knowledge` and publish content at `/admin/knowledge`. |
| `community` | Moderated forum, search, reports and categories. `feature.community` defaults off (`/admin/community/settings`, `/community`). |
| `referrals` | Registration attribution, link sharing and an auditable reward ledger. `feature.referrals` defaults off; `referrals.program` holds the policy (`/admin/referrals`, `/account/referrals`). |
| `cart` | Server-priced cart, checkout, order and invoice creation; `feature.cart` defaults off (`/cart`, `/admin/carts`). |
| `payments` | Hosted Stripe or Square checkout plus signature and provider read-back checks. `payments.config.provider` defaults to `none` (invoice payment). Browser return is read-only. |
| `orders`, `files` | `orders.workflow_rules.enabled` governs publishing new phase/requirement rules, `orders.console_access.enabled` governs delegated grants, and `files.audio_conversion.enabled` governs recording and conversion. Existing published rules keep applying. Create-for-customer and reassignment are capability-gated without a new switch. |
| `identity`, `jobs` | Session centre, sign-in log, configurable restrictions and forced session endings; customer maintenance is off by default and separate from worker drain. Unknown mail is never retried automatically; a manual resend needs step-up and explicit duplicate-risk acknowledgement. |
| `platform`, `integrations` | Cookie consent ledger (`feature.privacy.consent`), opt-in analytics (`feature.integrations.posthog`, `feature.integrations.clarity`), and signed inbound/outbound webhooks (`feature.integrations.webhooks`). Optional features default off. |
| `storage`, `backup`, `sharepoint` | Copy log at `/admin/storage/copies` projects copy attempts without replacing the owning ledgers. No separate switch; new attempts appear as enabled destinations receive work. |

### Capabilities

- **Protection and sessions**: `security.firewall.read`, `security.firewall.manage`, `sessions.read_all`, `sessions.policy.manage`.
- **Orders and content**: `orders.phase.unlock`, `orders.access.grant`, `knowledge.manage`, `community.moderate`, `community.manage`, `referrals.read_all`, `referrals.manage`.
- **API, privacy and payments**: `api.keys.manage`, `api.logs.read`, `api.replay`, `webhooks.manage`, `privacy.consent.read`, `privacy.consent.manage`, `payments.manage`, `carts.read_all`, `storage.copies.read`. The [capability registry](../../shared/capabilities.ts) defines role grants and which mutations need fresh step-up.

### HTTP and deployment changes

- **Isolated raw routes**: `/api/v1` and `/api/v1/openapi.json`; `POST /api/webhooks/inbound/:endpointPublicId`; `POST /api/payments/webhooks/:provider` and `GET /api/payments/return/:provider/:attemptPublicId`. These do not get browser-session authority; raw JSON is bounded to 256 KiB. Use the canonical HTTPS host for provider callbacks.
- **Browser routes**: `GET`, `POST` and `DELETE /api/referrals/hold` manage first-party attribution; `POST /api/knowledge/attachments/:articlePublicId` uploads and `POST /api/knowledge/attachments/download` redeems an authorized download ticket. Customer maintenance status uses the public `jobs.maintenance.customerAccess` tRPC query; it is not a raw router.
- **Environment**: `RP_FFMPEG_PATH` defaults to `/usr/bin/ffmpeg`; optional `PROTECTION_MMDB_PATH` names an offline country file; `PROTECTION_COUNTRY_HEADER` allows only `x-readypackets-country` from an explicitly trusted direct proxy that overwrites it (bundled proxies strip it). `PROTECTION_DISABLED=1` temporarily bypasses Application Protection and restores baseline rate limits, not authentication or MFA. See [media and country setup](../operations/MEDIA_AND_GEOIP.md).
- **Customer navigation**: expanded/collapsible sidebar on large screens, drawer below that, and up to four phone shortcuts plus More. Support and Account have separate groupings; switched-off feature links disappear. System, Light and Dark use the shared theme control; the current theme choice is held in memory. The UI is designed and tested against WCAG 2.2 AA; see [coverage and gaps](../verification/ACCESSIBILITY.md).

## Increment 04 part B: console order workspace

The owner asked for this on 2026-11-21 (prompt 19). The contract is [INCREMENT_04_PART_B.md](../engineering/INCREMENT_04_PART_B.md), and its decisions are B1–B9. Migration [`0004_increment_04_part_b`](../../migrations/0004_increment_04_part_b.sql) is additive: 3 tables and 13 nullable columns. Every item below is implemented and tested by its owner; the integrator has not yet verified it.

| Area | What it does | Guard |
| --- | --- | --- |
| Order page shell (`orders`) | `/admin/orders/:orderId/:tab` has header actions (Rename, Change reference, Reassign, Invoice, Refund) and twelve tabs, each with its own address. The tab strip scrolls and collapses into a menu below 480 px. | `orders.read_all`; rename needs `orders.rename` |
| Order history (`audit`) | Status transitions alongside order-scoped audit activity, read through an audit port scoped to one order. Customers see a redacted subset ("ReadyPackets staff", no IP addresses). | Ownership on every read |
| Automation tab (`integrations`, `automations`) | P101/P201 cards with the reason a button is disabled; per-order pipeline history; Retry; Redeliver, which creates a new delivery marked `redeliveryOf`; optional P301/P401 endpoints; "Run actions" for workflow stage automations ([ADR 0041](../adr/0041-order-automation-tab.md)). | `orders.production.trigger`; `orders.production.redeliver` (administrators, step-up, phrase `REDELIVER`); `orders.automations.run` |
| Refunds (`payments`, `compliance`, `jobs`) | Stripe/Square refund API with an idempotency key from the refund public id. The intent is committed before the call. Results are `succeeded`, `failed` or `unknown`; unknown is reconciled, never resent. Manual payments get a recorded refund ([ADR 0038](../adr/0038-provider-refunds.md)). | `payments.refund` (administrators, step-up, phrase `REFUND ORDER`) |
| Policy acceptance gateway (`compliance`, `orders`) | Workflow gates at `order_start` or a named step. The server refuses customer work with `CONFLICT` (409) / `ORDER_ACCEPTANCE_REQUIRED`; cancellation is never gated. Evidence is append-only (policy version, SHA-256 of the text shown, typed name, encrypted source address) ([ADR 0039](../adr/0039-policy-acceptance-gateway.md)). | Staff are not gated; source address shown only with `sessions.read_all` |
| Order file sync (`storage`, `files`, `sharepoint`) | Slot, then workflow, then assignment folder templates, with tokens and validation on save and at copy time. The target path is recorded on each copy attempt. Per-order sync tab `storage.copies.forOrder`; retry `storage.copies.retryOrderFile` ([ADR 0040](../adr/0040-order-file-sync-folder-routing.md)). | `orders.read_all`; retry needs `files.manage` |

New capabilities (all in `shared/capabilities.ts`): `orders.rename`, `orders.automations.run`, `orders.production.redeliver` (step-up) and `payments.refund` (step-up).

## Deployment profiles

| Profile | Purpose | Session transport | Routing |
| --- | --- | --- | --- |
| `production` | my.readypackets.com | `__Host-` Secure HttpOnly SameSite=Strict cookie + CSRF token | path |
| `development` | local work | cookie (unprefixed on plain http) | path |
| `test` | automated tests | cookie | path |
| `preview` | sandboxed demo only; refused on readypackets.com origins | in-memory header token | hash |

## Status

See `docs/application-context/STATUS.md` for what is implemented, verified, and outstanding.
