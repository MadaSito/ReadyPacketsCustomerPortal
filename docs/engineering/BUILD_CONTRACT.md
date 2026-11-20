# ReadyPackets Portal — Build Contract

The team's working agreement for the secure rebuild. The integrator (`/root`) owns this file. If something
here conflicts with the source specifications, the specifications win — tell `/root`.

## 1. What we are building

A self-hosted **customer portal, staff workspace and administration console** for ReadyPackets at
`https://my.readypackets.com` (alias `portal.readypackets.com` redirects to it). The public marketing site
(`https://www.readypackets.com`) is a separate system and out of scope except for outbound links.

Authoritative inputs (read them before writing code):

| Document | Path |
| --- | --- |
| Secure rebuild master prompt | `docs/source-specs/MASTER_PROMPT.md` |
| Technical architecture | `docs/source-specs/ARCHITECTURE.md` |
| Brand guide + tokens | `docs/brand/BRAND_GUIDE.md`, `docs/brand/*.css` |
| Existing implementation (REFERENCE ONLY, not a dependency) | `/home/user/workspace/ref/existing/ReadyPackets-SiteSplit-main` |

The existing repository is evidence of intended behaviour and of defects to avoid. Read its code for ideas,
re-implement cleanly, and fix every "SOURCE finding" the architecture document lists for your area. Never
copy code that carries a documented defect.

## 2. Non-negotiable rules

1. **No runtime dependency on Perplexity, Manus or any AI/hosted builder.** No such OAuth, SDK, endpoint,
   telemetry or attribution in product code or UI.
2. **Local authentication with mandatory MFA** is the only active sign-in method. SAML, SharePoint, Stripe,
   SMTP, PostHog, Clarity, external antivirus and every other provider are optional, **off by default**, and
   visibly reported as disabled/not configured until completely configured by an administrator.
3. **Zero trust.** Every request re-derives identity from server-side session state. Every list, detail,
   search, export, upload, download and job re-checks capability **and** resource scope on the server. Client
   checks are cosmetic. Correlation identifiers are never authority.
4. **Fail closed.** If durable audit, key material, schema contract or authorization data is unavailable, the
   privileged action does not happen.
5. **Honesty.** Never fabricate evidence, test results, compliance or certifications. No "100% secure",
   "ADA certified", "WCAG certified", "SOC 2" claims. State what is implemented, what is tested, and what is a
   documented target. `unknown` outcomes stay `unknown`.
6. **No secrets in code, logs, audit, URLs, exports, error messages or tests.** Tests use synthetic data
   (`*.example.test` addresses) only.
7. **No dynamic code or shell strings.** No `eval`, `new Function`, `child_process.exec`, `sql.raw`, sourced
   config files or arbitrary admin-supplied snippets/HTML/scripts. Use `execFile`/`spawn` with argument arrays.
8. **Brand.** Use only the approved assets in `client/public/brand` and the tokens in the brand guide. Do not
   redraw, recolor or typeset the logo. Do not restore retired logos, "Packet 8", or hardcoded legacy
   catalog/pricing.
9. **Accessibility target: WCAG 2.2 AA**, widths 320–1920 px, keyboard-complete, visible focus, reduced-motion
   aware, 44 px touch targets, no information by colour alone.
10. **Portal pages are `noindex`.** SEO/GEO/AEO work belongs to the public site; the portal contributes only
    correct canonical/robots behaviour and a clean public sign-in page.

## 3. Environment and shared-machine discipline

All engineers share ONE sandbox: 2 CPU cores, 7 GB RAM. Be frugal.

```bash
cd /home/user/workspace/readypackets-portal
source scripts/dev/env.sh                 # Node 22 LTS + pnpm + local MySQL URL — every shell
scripts/dev/tc.sh 'server/modules/orders|client/src/features/orders'   # typecheck, show only your paths
scripts/dev/test.sh server/modules/orders                              # run only your tests
scripts/dev/lint.sh server/modules/orders client/src/features/orders   # eslint only your paths
scripts/dev/commit.sh "feat(orders): order locks" server/modules/orders client/src/features/orders
scripts/dev/add-dep.sh <pkg>              # only if truly needed; record why in docs/engineering/DEPENDENCIES.md
```

- **Never** run `pnpm install`, bare `tsc`, bare `vitest`, `vite`, `pnpm dev`, a browser, Playwright or any
  long-lived server. Only `/root` and the UI foundation engineer run builds/browsers. Verify UI with jsdom
  component tests (`@testing-library/react`, `axe-core`).
- Never run `git add -A`, `git commit -a`, `git stash`, `git reset`, `git checkout -- .`, `git rebase` or push.
  Commit **only your own paths** through `scripts/dev/commit.sh`, early and often (small, conventional
  commit messages; the wrapper adds the required trailer).
- MySQL 8.4 is local. Tests create and drop their own `rp_test_*` databases via `tests/helpers/testDb.ts`.
  Do not touch other databases. Keep test files fast (seconds, not minutes).
- TypeScript: `scripts/dev/tc.sh` uses the native TypeScript 7 compiler (sub-second). Strict mode with
  `noUncheckedIndexedAccess` and `verbatimModuleSyntax` (use `import type`). Relative server imports end in `.js`.

## 4. Repository layout and ownership

You may create any files **inside the paths you own**. In files you do not own, make only the minimal
insertion described below, using a targeted edit (never rewrite the file), and never reformat.

| Path | Owner |
| --- | --- |
| `server/core/**`, `server/container.ts`, `server/main.ts`, `server/trpc/**`, `server/db/**`, `server/http/requestState.ts`, `server/http/moduleRoutes.ts`, `tests/helpers/**`, `tests/foundation.test.ts`, `client/src/lib/{runtime,routes}.ts`, `client/src/app/registry.ts`, `scripts/dev/**`, `scripts/ops/{migrate,seed-demo,create-admin}.ts`, `migrations/**`, root config files, `docs/engineering/**`, `docs/application-context/**`, `docs/session-logs/**` | `/root` (integrator) |
| `server/modules/identity/**`, `client/src/features/identity/**` | identity_engineer |
| `server/modules/assurance/**`, `client/src/features/assurance/**` | assurance_engineer |
| `server/http/**` (except the two integrator files), `server/security/**` (except `fieldCrypto.ts`), `client/src/lib/sessionTransport.ts`, `tests/http/**` | http_security_engineer |
| `server/config/**`, `server/security/fieldCrypto.ts`, `server/modules/platform/**`, `client/src/features/platform/**`, `scripts/ops/keys/**` | platform_engineer |
| `server/observability/**`, `server/modules/audit/**`, `client/src/features/audit/**` | audit_engineer |
| `server/modules/siem/**`, `client/src/features/siem/**` | siem_engineer |
| `server/modules/jobs/**`, `client/src/features/jobs/**` | jobs_engineer |
| `server/modules/orders/**`, `client/src/features/orders/**` | orders_engineer |
| `server/modules/files/**`, `client/src/features/files/**` | files_engineer |
| `server/modules/engagement/**`, `client/src/features/engagement/**` | engagement_engineer |
| `server/modules/compliance/**`, `client/src/features/compliance/**` | compliance_engineer |
| `portable/**` (contract, writer/reader, verifier CLI, reference importer, adapters) | portable_contract_engineer |
| `server/modules/portable/**`, `client/src/features/portable/**` | portable_ops_engineer |
| `server/modules/backup/**`, `client/src/features/backup/**`, `deploy/**`, `.github/**`, `scripts/ops/{backup,restore,install}/**`, `docs/runbooks/**` | recovery_ops_engineer |
| `server/modules/integrations/**`, `client/src/features/integrations/**` | integrations_engineer |
| `client/src/{app,ui,styles}/**` (except `app/registry.ts`), `client/src/lib/**` (except integrator + http files), `client/src/features/{auth,dashboard}/**`, `client/index.html`, `client/public/**`, `tests/helpers/clientSetup.ts` | ui_foundation_engineer |

Shared append-only files (minimal insertion in your own block, never touch others' lines):

- `shared/capabilities.ts` — add capabilities + role grants + step-up membership for your module.
- `shared/domain.ts` — add shared enums/types both client and server need.
- `docs/engineering/DEPENDENCIES.md` — one row per added dependency (why, licence, alternatives rejected).

Every owner also writes, inside their module folder:

- `API.md` — the public service interface (methods other modules call), tRPC procedures with guard level,
  raw HTTP routes, audit event names, job types, mail templates, settings keys, feature flags, health
  components. **Publish a first version early** (signatures first, implementation second) so dependants can
  code against it; keep it current.
- `VERIFICATION.md` — requirement → test file/case → evidence class (`automated-test`, `manual-check`,
  `not-verified`, `target`), plus known limitations stated plainly.

## 5. Architecture in one page

Modular monolith: React 19 + TypeScript + Tailwind 4 + Vite 8 client; Node 22 LTS + Express 5 + tRPC 11 + Zod 4
server; MySQL 8 + Drizzle ORM; Nginx + systemd on a VPS (Docker profile optional). Web and worker are the same
codebase started with `RP_ROLE=web|worker|all`.

```
server/core/types.ts        every infrastructure contract (READ THIS FIRST)
server/core/errors.ts       DomainError taxonomy → safe client errors
server/trpc/trpc.ts         the only procedure guards; requireCapability; error formatting
server/container.ts         composition root; ModuleDeps = CoreDeps + services registry
server/http/requestState.ts identity for raw HTTP routes
server/db/columns.ts        id/publicId/timestamp/money column helpers
tests/helpers/testDb.ts     isolated MySQL per test file
tests/helpers/fakes.ts      FakeAudit, FakeMailer, FakeJobs, MemoryStorage, MemorySettings, FakeClock…
tests/foundation.test.ts    worked examples of all of the above
```

### 5.1 Module shape

```
server/modules/<m>/index.ts    export interface <M>Module extends ModuleLifecycle { … }
                               export function create<M>Module(deps: ModuleDeps): <M>Module
server/modules/<m>/router.ts   export const <m>Router = router({ … , admin: router({ … }) })   → trpc.<m>.*
server/modules/<m>/schema.ts   Drizzle tables (re-exported by server/db/schema/index.ts)
server/modules/<m>/http.ts     register<M>HttpRoutes(router, services)                      → /api/<m>/…
server/modules/<m>/*.test.ts   tests next to code
```

- Keep those four file names and export names exactly; split internals into as many files as you like.
- `deps.services` is the typed registry of all modules **and** infrastructure. It is filled as factories
  return: **do not dereference `deps.services.<module>` while your factory runs** — only inside methods, or in
  `init()`. Registry keys: `identity, assurance, orders, files, engagement, compliance, auditCenter, siem,
  platform, jobAdmin, portable, backup, integrations` (note `services.audit` is the AuditEmitter and
  `services.jobs` the JobQueue; the audit-center and jobs *modules* are `auditCenter` and `jobAdmin`).
- In routers, reach your module as `ctx.services.<key>`. Routers contain validation + guard + a call into the
  service; business rules and authorization scope live in the service where tests can reach them.
- Register job handlers, schedules and mail templates in your factory via `deps.jobs.register`,
  `deps.jobs.registerSchedule`, `deps.mailer.registerTemplate`.
- Cross-module calls go through the other module's published interface. Never import another module's
  internals or write to its tables. Reading another module's tables is allowed only for the portable
  export/backup collectors and must be listed in that module's `API.md`.

### 5.2 Data conventions

- Tables: `idColumn()` (BIGINT auto-increment, installation-local), `publicIdColumn()` (ULID — the stable
  portable identifier, the only id that appears in URLs, API payloads and audit refs), `createdAtColumn()`,
  `updatedAtColumn()`, optional `versionColumn()` for optimistic concurrency. **API inputs/outputs use
  `publicId` strings, never numeric ids.**
- Mutable human-facing references (customer number, order number) are separate columns; retired values stay
  reserved forever (see architecture §3.1).
- Money: integer minor units + ISO currency (`amountMinorColumn`, `currencyColumn`). Never floats.
- Time: `DATETIME(3)` UTC via `utcDateTime()`. Always use `deps.clock.now()`, never `new Date()` /
  `Date.now()` in services (tests use `FakeClock`).
- Foreign keys: reference `users.id` (identity) freely; other cross-module references store the other
  module's numeric id with an index and are validated through that module's service (no cross-module FK
  constraints, so modules can be tested with schema subsets).
- Prefix table names with your domain when ambiguous (`audit_events`, `siem_destinations`, `job_runs`).
  Explicit index names. Unique constraints for idempotency keys and operation ids.
- Sensitive columns are encrypted with `deps.crypto.encrypt(value, "<table>.<column>:<publicId>")`; lookups
  on encrypted values use `deps.crypto.blindIndex`. Single-use tokens are stored only as
  `deps.crypto.hashToken(token)`.
- Multi-step writes run in `deps.db.transaction(async (tx) => …)`. High-impact writes call
  `deps.audit.record(event, tx)` **inside** the transaction; if it throws, let it abort.
- Lists use bounded cursor pagination (`limit` ≤ 100, opaque cursor = last sort key + id). No unbounded
  queries, no client-supplied sort/filter column names without an allowlist.
- Input validation: Zod schemas with explicit bounds on every string/array/number; `z.strictObject` for
  mutations. Normalize Unicode (NFC) where identity or uniqueness matters.

### 5.3 Authorization

- Guards: `publicProcedure` < `sessionProcedure` (remediation allowed — transition endpoints ONLY) <
  `protectedProcedure` (full session) < `staffProcedure` < `adminProcedure`; add
  `.use(requireCapability("x.y"))` for capability + fresh step-up (10 minutes) where listed in
  `STEP_UP_CAPABILITIES`.
- Then, in the service, check **resource scope** with the verified `SessionPrincipal`: customers reach only
  records they own or hold a current, unrevoked grant for; staff/admin per capability; locks and
  maintenance windows are honoured. A record the caller may not see is reported as `NOT_FOUND`, not
  `FORBIDDEN` (no existence oracle).
- Denials of privileged or cross-tenant attempts are audited (`category: "security"`, outcome `denied`).
- Every module's tests include **negative authorization tests**: other customer, revoked grant, wrong role,
  remediation session, missing step-up, locked resource, tampered identifier.

### 5.4 Audit and logging

- `deps.audit.record(event, tx?)` — durable, may throw `AuditUnavailableError` (fail closed). Use for
  security events and every create/update/delete/transition/export/download of business or admin data.
- `deps.audit.note(event)` — best-effort, low-impact only.
- `eventName`: fixed dotted lowercase (`order.created`, `auth.login.failed`); `reasonCode`: fixed
  `UPPER_SNAKE`. Never interpolate user data into names. `attributes` hold only allowlisted-safe primitives:
  no secrets, tokens, passwords, MFA material, e-mail addresses, names, filenames, free text, SQL, bodies
  or exception dumps. Refer to resources by `publicId`.
- `deps.logger` is for operational diagnostics, with the same redaction rules. Never `console.*`.
- Request correlation (`requestId`, `traceId`, `spanId`, `correlationId`) is attached automatically from the
  AsyncLocalStorage request context; pass `correlationId` explicitly into jobs/outbox rows.

### 5.5 Errors

Throw `DomainError(code, REASON_CODE, "Safe sentence for the user.", details?)` (helpers in
`server/core/errors.ts`). Anything else becomes a generic internal error for the client; raw messages are
never forwarded. Authentication failures use uniform messages and timing (no account enumeration).

### 5.6 Cross-module interface expectations (owners refine in `API.md`; talk to each other directly)

| Provider | Must expose (minimum) | Used by |
| --- | --- | --- |
| identity | `sessionResolver`; `getUser(userId)` / `getUserByPublicId` (decrypted server-side view: role, status, email, name, customerRef); `verifyPassword(userId, password)`; `setPassword(userId, password, { mustChange, tx })`; `sessions.markMfaVerified / markStepUp / revokeAllForUser(userId, { exceptSessionId, reason, tx }) / rotate`; `createPendingCustomer(...)` (for portable import — never active, never with auth material); the single **account-transition service** deriving `pendingSteps` | assurance, http, orders, engagement, compliance, portable |
| assurance | `getAssuranceState(userId)` → `{ mfaEnrolled, recoveryCodesAcknowledged, passkeyCount }`; `verifySecondFactor(userId, input)`; `resetSecondFactors(userId, tx)`; step-up procedure; admin credential administration (3 modes) | identity (transition derivation), UI |
| orders | access policy: `assertCanReadOrder(principal, orderPublicId)`, `assertCanWriteOrder(...)` (ownership, grants, locks), `listAccessibleOrderIds(principal)`, `getOrderSummary`; import hooks | files, engagement, compliance, portable |
| files | `ObjectStorage` adapter; file records by order; import adoption hook | orders UI, engagement (attachments), portable, backup |
| engagement | `notify({ userId, kind, title, body, link })` in-app notifications | all business modules |
| jobs | `JobQueue`, `Mailer` (contracts in core types), maintenance-mode state `isDraining()` | everyone |
| platform | `FieldCrypto`, `SettingsStore`, feature flags, `assertSchemaContract()`, health aggregation over `services.allModules` | everyone |
| audit | `AuditEmitter`; a read API for SIEM projection (`readEventsAfter(cursor, limit)`) | everyone, siem |
| integrations | `egress.assertAllowed(url)` SSRF/egress policy + provider status registry | siem, files, jobs (SMTP), platform |
| http_security | pipeline, `SessionTransport`, `RateLimiter`, download-safe response helpers (`sendPrivateDownload`) | identity, files, audit exports, portable, backup |

If you need something from another owner, message them directly with the exact signature you need; do not
block — code against the agreed signature and use a fake in tests.

### 5.7 Client conventions

- Feature code lives in `client/src/features/<feature>/` and exports `<feature>Feature: FeatureRoutes` from
  `routes.tsx` (already registered). Lazy-load every page (`lazy(() => import("./pages/…"))`).
- Customer area paths are `/…` (`/orders`, `/orders/:orderId`, `/messages`, `/account/security`); console
  paths are `/admin/…`. Auth/transition paths are `/sign-in`, `/register`, `/verify-email`, `/mfa`, … (UI
  foundation owns them). Navigation with wouter `<Link>` / `useLocation`; **never** build URLs with
  `window.location`, never use in-page `href="#…"` anchors (the preview build uses hash routing).
- Features never import each other. To appear inside another feature's page, contribute through the
  registry in `routes.tsx`: `orderTabs` (rendered by the orders feature on the order detail page, receives
  `{ orderId, area }`), `customerTabs` (rendered by the identity feature on the console customer detail
  page, receives `{ customerId }`) and `widgets` (dashboard cards). Hosts import `ORDER_TABS`,
  `CUSTOMER_TABS`, `WIDGETS` from `@/app/registry`.
- Data: `const trpc = useTRPC(); useQuery(trpc.orders.list.queryOptions(input))`,
  `useMutation(trpc.orders.create.mutationOptions())`; show `errorMessage(error)` from `@/lib/trpc`.
  Raw uploads/downloads use `sessionFetch` + `apiUrl` from `@/lib`. Never read or store tokens.
- **Never** use `localStorage`, `sessionStorage`, `indexedDB`, cookies, `alert/confirm/prompt`,
  `dangerouslySetInnerHTML`, inline styles for colours, or raw hex colours. Use the design-system components
  and semantic tokens from `@/ui` only (documented in `client/src/ui/README.md`, published by the UI
  foundation engineer — **do not start pages until that README exists**; build your server side first).
- Expected kit (names fixed, props per README): `Button, IconButton, Field, Input, Textarea, Select,
  Checkbox, Switch, RadioGroup, Card, PageHeader, Section, DataTable (responsive table → stacked cards),
  FilterBar, Badge, StatusBadge, Tabs, Dialog, ConfirmDialog, Drawer, DropdownMenu, Tooltip, useToast,
  Callout, Skeleton, EmptyState, ErrorState, Spinner, LoadMore, Breadcrumbs, CopyButton, DateTime, Money,
  KeyValueList, CodeBlock, FileDropzone, useStepUp`.
- Every page: one `<h1>` (via `PageHeader`), loading/empty/error states, keyboard operable, labelled
  controls, works from 320 px to 1920 px with no horizontal page scroll, dark and light themes.
- Every list/detail/job UI shows truthful operation states (`queued, running, completed, failed, canceled,
  refused, unknown`) and never presents an optional integration as working when it is not configured.
- Component tests: `client/src/features/<feature>/*.test.tsx` (jsdom). Include at least one `axe-core` check
  per page family.

### 5.8 Preview build (sandbox demo only)

The demo is shown inside a sandboxed iframe with no cookies/storage. A `preview` deployment profile enables
hash routing, a proxied API base and an in-memory header session transport. It is accepted **only** when the
server's `config.deploymentProfile === "preview"`; production uses `__Host-` Secure HttpOnly cookies and
path routing, and there is a negative test proving production rejects header sessions. Feature code is
transport-agnostic — just use `@/lib` helpers.

## 6. Definition of done (per owner)

1. Requirements for your area in both source documents are implemented, or explicitly listed as a recorded
   target/limitation in your `VERIFICATION.md`.
2. `scripts/dev/tc.sh '<your paths>'` and `scripts/dev/lint.sh <your paths>` are clean; your tests pass.
3. Positive, negative-authorization, validation and failure-path tests exist; high-impact writes are proven
   to be audited transactionally (audit failure ⇒ no write).
4. `API.md` and `VERIFICATION.md` are current. Work is committed through `scripts/dev/commit.sh`.
5. You sent `/root` a short final report: what is done, what is verified, what is not, and any decisions that
   deserve an ADR.

## 7. Communication

- Ask the owning engineer directly about their interface. Ask `/root` only for changes to integrator-owned
  files or cross-cutting decisions. Keep messages short and concrete (file path + signature).
- If you finish early, tell `/root`; there is review and documentation work to pick up.
