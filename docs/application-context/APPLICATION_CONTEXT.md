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
server/http        request pipeline: context → host → headers/CSP → session → CSRF → rate limit → routes
server/security    field encryption, rate limiter
server/observability structured logger with redaction and correlation
server/trpc        procedure guards and root router
server/modules     identity, assurance, orders, files, engagement, compliance, audit, siem, platform,
                   jobs, portable, backup, integrations
portable/          vendor-neutral portable data contract, verifier CLI, reference importer, adapters
deploy/            native auto-install and manual kit, Nginx templates, systemd, MySQL; docker/ = evaluation
migrations/        versioned forward-only SQL migrations
docs/              specs, engineering contract, ADRs, runbooks, verification, context, session logs
```

Native deployment entry points are `deploy/auto-install.sh`, `deploy/install.sh`, `deploy/upgrade.sh` and
`deploy/uninstall.sh`. The installer stores site identity and TLS mode in `/etc/readypackets/site.conf`,
renders `deploy/nginx/*.conf.template`, and publishes under `/opt/readypackets/releases/<commit>` with
private data under `/var/lib/readypackets/storage`. See the [automatic installation guide](../operations/AUTO_INSTALL.md)
for first-admin credential custody and `.github/workflows/native-install.yml` for the native CI workflow.

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

## Deployment profiles

| Profile | Purpose | Session transport | Routing |
| --- | --- | --- | --- |
| `production` | my.readypackets.com | `__Host-` Secure HttpOnly SameSite=Strict cookie + CSRF token | path |
| `development` | local work | cookie (unprefixed on plain http) | path |
| `test` | automated tests | cookie | path |
| `preview` | sandboxed demo only; refused on readypackets.com origins | in-memory header token | hash |

## Status

See `docs/application-context/STATUS.md` for what is implemented, verified, and outstanding.
