# Increment 03 — Integrations, mail, templates, workflow designer, SSO, automations (team contract)

Owner input (2026-11-21, after the first real installation): the administrator console has

1. no SharePoint order-data sync and no cloud storage connections (Amazon S3, Wasabi, Backblaze, Azure Blob,
   Dropbox, Google Drive, Microsoft OneDrive);
2. no way to configure the order workflow — wanted: a wizard and a canvas;
3. a mail list with resend / attempts but no way to read the message that was sent, no BCC address for audit,
   no visible way to set the outbound address;
4. no e-mail through Microsoft Graph, and no primary / secondary delivery choice;
5. settings that can only be edited as JSON — wanted: an easy form in addition to JSON;
6. no e-mail template centre (new registration, password reset, maintenance window, order confirmation,
   invoice receipt, …; create new ones; rich HTML or text; triggered by automation events);
7. no Microsoft Entra ID single sign-on with proper configuration fields and a clear "Sign in with SSO"
   button on the sign-in page;
8. no events / automation centre where automations are built by a wizard or on a blank canvas.

`BUILD_CONTRACT.md` still governs everything (module shape, ownership checks, audit, errors, transaction and
lock rules, client conventions, shared-machine discipline). This file adds what the eight features need.

## 0. Working rules for this increment

- Branch `feat/increment-03` is checked out in the shared tree. Nobody switches branches or pushes.
- Commit only your own paths with `scripts/dev/commit.sh`, early and often. One test file at a time
  (`scripts/dev/test.sh <file>`). Only `/root` and ui_foundation_engineer run builds or browsers.
- **Migrations:** do not create any. Change your `schema.ts`; tell `/root` when it is final. `/root`
  generates `migrations/0002_*.sql` once. Every change must be additive and safe on a database that already
  holds data (a real installation exists and will be upgraded): new tables, new nullable columns or columns
  with defaults; no renames, no drops, no tightening of existing columns.
- **Dependencies:** ask `/root` first (package, licence, why no built-in), then `scripts/dev/add-dep.sh` and a
  row in `DEPENDENCIES.md`. Cloud SDKs are not acceptable where a signed HTTPS request through our egress
  policy does the job (they bring their own HTTP stack and bypass it).
- **Capabilities** already added by `/root`: `mail.manage`, `mail.content.read`, `automations.read`,
  `automations.manage`, `storage.manage`, `identity.sso.manage` (all admin; all but `automations.read`
  require step-up). `workflows.manage` and `integrations.manage` exist.
- **Shared files** (`server/core/types.ts`, `server/container.ts`, `client/src/app/registry.ts`, navigation):
  make the smallest possible edit for your own lines and commit that file at once, alone.
- **Outbound network:** every request to another host goes through `server/modules/integrations/egress.ts`
  (allow-list rule, https only, pinned resolution, no redirects, bounded size and time). No direct `fetch`,
  no SDK transport. integrations_engineer owns new purposes and provider presets; ask them.
- **Secrets** (client secrets, access keys, refresh tokens, connection strings): encrypted with field
  crypto, write-only in the API (return "configured" plus at most the last 4 characters), never in logs,
  audit attributes, exports or error messages. Changing them requires step-up and is audited.
- **Every new feature ships disabled** and does nothing until an administrator configures and enables it.
- **Nothing here has been or can be tested against the real provider** in this sandbox (no tenant, no
  bucket, no mailbox). Test against local protocol fakes, say so in your `VERIFICATION.md`, and give the
  administrator a "Test connection" action that reports a safe, specific result.
- Report to `/root` in at most 150 words: what is done, commits, what is not done, what you need.
  Talk to other owners directly for interface details; copy `/root` only on decisions that change this file.

## 1. Decisions (ADRs 0024–0028, written by /root)

1. **SSO is OpenID Connect against one Microsoft Entra tenant** (authorization code + PKCE, confidential
   client), not SAML. The SAML scaffold stays disabled and is labelled as not offered.
2. **No silent account linking.** An Entra identity is the pair (tenant id, object id), never the e-mail
   address. A local account is linked only by an explicit, audited act. Optional just-in-time provisioning
   is off by default and can never create an administrator.
3. **A local administrator with local MFA always remains** (break-glass). SSO cannot be made the only way in.
4. **MFA:** an Entra sign-in counts as multi-factor only when the validated ID token says so (`amr`
   contains `mfa`) and the administrator has chosen to trust it; otherwise the portal's own second factor
   is required as today.
5. **Local storage stays the system of record for files.** Cloud storage connections are destinations for
   copies (order files, verified encrypted backups, order data), not the primary store, in this increment.
6. **The audit mailbox never receives single-use secrets.** Templates that carry them (reset, activation,
   invitation, verification) are copied to the audit address with those values redacted.
7. **Stored message content is viewable only by an administrator after step-up, with secrets redacted,
   for a bounded retention period**, and each view is audited.
8. **Mail failover never risks a duplicate:** the secondary transport is tried only when the primary
   definitely did not accept the message (not configured, connection refused, authentication failed,
   explicit rejection). An **unknown** outcome is never replayed and never fails over — exactly as today
   (payload purged, resend blocked) — unless the provider gave an affirmative idempotency guarantee; it is
   shown to the operator for review.
9. **Templates and automations are data, never code.** Logic-less `{{variable}}` substitution with
   escaping; HTML is sanitised on save against an allow-list; no scripts, no remote code, no expressions.
10. **Automations are triggered by a curated catalogue of events and can only run registered actions.**
    Each run is recorded; loops are impossible by construction (events caused by an automation do not
    trigger automations) and runs are rate-limited.
11. **Workflow publishing keeps its current guarantee:** a published definition is a new version; existing
    orders keep theirs. The designer edits a draft.

## 2. Work packages

### A. Settings forms — platform_engineer
Server: expose for every non-secret structured setting a field description derived from its Zod schema
(type, enum values, min/max, required, default, label, help text; nested objects; arrays of scalars), so
the client can render a form. Add optional per-field labels / help to `defineSetting`. Client
(`client/src/features/platform`): the edit dialog gets two tabs, **Form** (default) and **JSON**, editing
the same value with the same server validation; field errors map to fields. Secrets keep their own dialog.
Group the long settings page (search box, collapsible groups). Hide or relabel settings superseded by the
pages of packages B–D, G, I (link to the page instead of a raw JSON row).

### B. Mail engine — jobs_engineer
In `server/modules/jobs` (+ `client/src/features/jobs`):
- **Sender identity** as its own setting (from address, from name, reply-to), used by every transport.
- **Transports** behind one interface `MailTransport { key: "smtp" | "graph"; isConfigured(); send(...) →
  { outcome: "accepted" | "not_configured" | "rejected" | "unknown"; retryable?; safeDetail? } }`;
  **primary / secondary** selection setting; failover per decision 8; each attempt records the transport.
- **Audit copy** setting (address, on/off) per decision 6; the copy is recorded as its own attempt.
- **Message content**: after rendering, store subject + text + HTML encrypted, with values of
  `sensitiveVars` replaced by a fixed marker, for a retention period (setting, default 30 days, purge job).
  API `jobs.mail.content` behind `mail.content.read` (step-up), audited `mail.content.viewed`. Client: a
  "View message" action in the mail list (subject, recipient, both bodies; HTML shown inert — see §4).
- Rendering asks the template store of package D for a published template for the key and falls back to
  the built-in one.
- Publish the transport registration and the template-store port in `server/modules/jobs/API.md` on day one
  so C and D can build against them.

### C. Microsoft Graph core and Graph mail — integrations_engineer
In `server/modules/integrations/graph/**`: one Graph client used by mail, SharePoint / OneDrive and
nothing else — client-credentials token (tenant id, client id, client secret; cached until shortly before
expiry; never logged), requests through the egress policy with a `graph` purpose and a preset allow-list
rule the administrator switches on. Graph mail transport (`POST /users/{sender}/sendMail`, application
permission `Mail.Send`; document how to restrict the app to one mailbox). Settings + `test` endpoints for
SMTP and Graph (send a test message to the signed-in administrator only). Also owns: egress purposes and
presets for storage providers and for the OIDC endpoints of package I.

### D. E-mail template centre — compliance_engineer (rich editor component from ui_foundation_engineer)
New module `server/modules/mailTemplates` + `client/src/features/mailTemplates`. Tables for templates and
versions: key, name, description, category, format (`html` | `text`), subject, body, declared variables,
state (draft / published), `system` flag. Every built-in template (registered through
`mailer.registerTemplate`) appears as a system template that can be customised and reset to default;
required variables of a system template (for example the reset link) must be present to publish. New
templates can be created for use by automations. Shipped set at least: new registration / e-mail
verification, account activation / invitation, password reset, password changed, order confirmation, order
status change, invoice issued, invoice receipt (payment recorded), support ticket reply, maintenance
window notice. Editor: format choice (rich HTML or plain text), variable palette, preview with sample
data, "Send test to me", version history, restore. HTML is sanitised on the server on save and again on
render; a text alternative is always produced. Capability `mail.manage`.

### E. Mail and storage administration pages — siem_engineer
`client/src/features/mail` ("E-mail delivery": sender, SMTP form, Graph form, primary / secondary, audit
copy, retention, test buttons, clear state badges) and `client/src/features/storage` ("Storage
connections": list, an add / edit wizard per provider with the provider's own field names, test, enable,
assignments of package G; "SharePoint order sync" settings of package H). Forms, not JSON.

### F. Order workflow designer — orders_engineer (canvas component from ui_foundation_engineer)
Server: draft workflows (create from the standard workflow, from a copy, or blank), save draft, validate
with precise messages, publish (new version), "install the standard workflow now" (today it appears only
with the first order). Client: the Workflows page gets a **wizard** (statuses → transitions → who may move
→ customer notifications / required notes → review and publish) and a **canvas** (statuses as nodes,
transitions as arrows, side panel for properties) editing the same draft, plus a version list and a
read-only view of the published version. The wizard is the fully keyboard- and screen-reader-operable
path; the canvas must still be keyboard-reachable.

### G. Storage connections — files_engineer (+ portable_ops_engineer, portable_contract_engineer)
New module `server/modules/storage`. Table of connections (provider kind, display name, non-secret
configuration, encrypted credentials, enabled, last test result) and of assignments (purpose →
connection). Adapter interface, final names by files_engineer on day one:
`test()`, `ensureFolder(path[])`, `put({ path[], name, size, sha256, contentType, body, signal }) →
{ remoteId, size }`, `remove(remoteId)` — all through the egress policy.
- files_engineer: registry, API (`storage.connections.*`, `storage.assignments.*`), **S3-compatible**
  adapter (SigV4; presets Amazon S3, Wasabi, Backblaze B2, custom endpoint; bucket, region, prefix) and
  **Azure Blob** adapter (account, container, prefix; shared key or SAS), and the **order-file copy**
  pipeline: when an order file is accepted, a fenced job copies it to each connection assigned to "order
  files", verifies size and digest where the provider reports them, records state per file and connection,
  retries with backoff, and never deletes remote objects on its own.
- portable_ops_engineer: **Dropbox** and **Google Drive** adapters, including the administrator's
  "Connect" consent flow (authorization code with PKCE and `state`, refresh token stored encrypted, exact
  redirect URI shown for the provider's app registration).
- portable_contract_engineer: **Microsoft Graph drive** adapter (SharePoint document library and OneDrive
  for Business) on the Graph client of package C: site-address discovery, drive and folder selection,
  upload sessions for large files; and package H.

### H. SharePoint order-data sync — portable_contract_engineer
One list item per order in a SharePoint list chosen (or created) by the administrator: reference, customer
reference, status, packets / tiers, totals, dates, link to the order in the portal. Updated when the order
changes, through a fenced outbox job; idempotent by order public id. Folder labels for order files follow
the master prompt (first two characters of the first name, full last name, customer reference, safe order
label; Unicode, length and collision handling); labels are display metadata only and never logged.

### I. Microsoft Entra ID sign-in — identity_engineer (assurance: assurance_engineer)
Server (`server/modules/identity/sso/**`): settings (enabled, tenant id — a single tenant GUID, `common`
and `organizations` refused —, client id, client secret, button label, allowed e-mail domains, trust Entra
MFA yes / no, just-in-time provisioning off / customers / staff with an Entra app-role mapping); the
redirect URI to register is shown, not typed. Flow: `GET /api/identity/sso/start` (state, nonce, PKCE verifier
bound to a short-lived pre-auth cookie) → Entra → `GET /api/identity/sso/callback` (code exchange, ID-token
validation: signature against the tenant's keys, `iss`, `aud`, `tid`, `exp` / `nbf`, `nonce`; one-time
use of `state`). Then: linked identity → portal session with `authMethod` recorded; unlinked → refuse with
a clear page (or provision, if enabled and permitted). Linking: by the signed-in user from Account →
Security (fresh step-up), or by an administrator for a named user; unlinking likewise; all audited.
Deactivated portal users cannot sign in through SSO. Client: a full-width **"Sign in with SSO"** button on
the sign-in page (shown only when enabled; label from the setting), the callback / refusal pages, the
link / unlink controls, the "Single sign-on" administration page with a **Test sign-in** action, and the
sign-in method on the staff and customer lists.
assurance_engineer: decision 3 and 4 in code and tests — session assurance from `amr`, fallback to the
local factor, step-up for accounts without a local password (fresh re-authentication at Entra with
`max_age=0` and a checked `auth_time`, or a local passkey / TOTP), the break-glass invariant, and the
negative tests (replayed state, wrong tenant, wrong audience, unsigned / `none` token, stale `auth_time`,
unlinked identity, deactivated user, e-mail collision without link).

### J. Automations — engagement_engineer (server), audit_engineer (client and trigger catalogue)
New module `server/modules/automations` + `client/src/features/automations`.
- Model: automation = name, enabled, one **trigger** (event from the catalogue, or "manual" / "schedule"),
  optional **conditions** (field, operator, value — all-of / any-of groups, no expressions), ordered
  **actions**; versioned on save; runs table (trigger event id, state, per-action result, timings,
  correlation id).
- Trigger catalogue (audit_engineer, with each owning module): a curated list of event names with a
  human label, the fields available to conditions and templates, and the people that can be addressed
  (for example the order owner, the acting user, administrators). Start with: account registered /
  activated, password reset requested / changed, order created / status changed / assigned, file uploaded,
  message posted, ticket opened / replied / closed, invoice issued / paid, maintenance window announced,
  backup completed / failed, mail delivery failed.
- Hook: the audit recorder calls an in-transaction tap; if an enabled automation listens to that event
  name, a job is enqueued in the same transaction. Evaluation and actions run in the worker.
- Actions through a registry (`registerAutomationAction`) so that owning modules provide them:
  send e-mail template (D; recipients from the catalogue or a fixed address), in-app notification, create
  support ticket, call webhook (existing egress policy and signing), sync order to SharePoint (H), copy
  order files to a storage connection (G). No action may change an order's status or any permission.
- Safety: decision 10; per-automation and global rate limits; a failing action is retried with backoff
  and never blocks the business transaction; a "Test run" with sample data sends nothing unless asked.
- Client: list with state and last run; builder as a **wizard** (trigger → conditions → actions → review)
  and as a **canvas** (trigger, condition and action nodes on the shared canvas component); run history
  with per-action results; enable / disable; duplicate; starter recipes (order confirmation e-mail,
  invoice receipt, new-ticket notice to staff, backup-failed alert).

### K. Shared interface components — ui_foundation_engineer
`client/src/ui`: **FlowCanvas** (nodes, edges, pan / zoom, keyboard operation, reduced motion, works under
our CSP — no inline `<style>` injection, no `unsafe-inline`), **RichTextEditor** for HTML e-mail bodies
(headings, bold / italic, lists, links, images by https URL, buttons, variables as chips; output goes
through the server sanitiser), **Wizard / Stepper** if the existing one does not fit, the **SSO button**
style, and the console navigation for the new pages (E-mail delivery, E-mail templates, Automations,
Storage connections, Single sign-on, Workflows). Propose the two libraries to `/root` first.
Also: run the browser checks for packages D, F and J at 1440 px and 390 px when owners ask.

### L. Backups to a storage connection — recovery_ops_engineer
Server: after a backup is verified, copy the encrypted archive to the connection assigned to "backups"
(package G), record the result next to the backup, show it in the backup page. Never upload anything
unencrypted; never delete remote copies automatically. And the **upgrade path**, which the first real
installation now depends on: make `deploy/upgrade.sh` usable for this release and add a `native-install`
job that installs the previous release (`d964a3b`), creates data, upgrades to the commit under test and
runs the smoke checks. Report any step an operator cannot reasonably perform.

### M. Security review — http_security_engineer (reviews, does not author)
Read-only review, findings to the owner and `/root`: the OIDC flow and session issuance (I), every new
outbound destination and its egress rule (C, G, H, J), HTML sanitisation and the inert preview (B, D),
webhook and template injection (J), secret handling everywhere, CSP changes (K). Update the threat model.

### N. Documents — owners for their module (`API.md`, `VERIFICATION.md`, admin-guide section);
compliance_engineer for the draft privacy notice (new recipients: Microsoft Graph, the chosen storage
providers); `/root` for ADRs, status, application context, requirements register and session log.

## 3. Ports between packages (owners publish exact types in their `API.md` on day one)

| Port | Provider | Consumers |
| --- | --- | --- |
| `MailTransport` registration; `MailTemplateStore.resolve(key)` | jobs_engineer | C, D |
| `GraphClient` | integrations_engineer | B (through C), G / H |
| `StorageAdapter`, `storage.copy(...)`, assignment purposes `order_files`, `backups`, `order_data` | files_engineer | portable_ops, portable_contract, L, J |
| `registerAutomationAction`, `registerAutomationTrigger` (catalogue entry + context resolver) | engagement_engineer | D, G, H, engagement, orders, compliance, backup |
| audit tap (in-transaction, name + safe attributes) | audit_engineer | J |
| draft workflow API | orders_engineer | client of F |
| setting field descriptions | platform_engineer | E, I (optional reuse of the form renderer) |

## 4. Security requirements that reviewers will check

- HTML from templates is never inserted into the console document. Previews and "View message" render in
  a sandboxed frame without script permission, served with its own restrictive policy, or as text.
- Template variables are escaped on substitution; a variable can never introduce markup or a header
  (subject and addresses reject control characters). Links in templates must be `https:` or `mailto:`.
- Webhook and storage destinations cannot reach loopback, private, link-local or metadata addresses; the
  existing egress tests must cover each new purpose.
- OAuth / OIDC callbacks: exact redirect URI, one-time `state`, PKCE, no open redirect after sign-in
  (reuse the existing `next` guard), no tokens in URLs after the callback, no token in logs.
- Rate limits on every new unauthenticated endpoint (`/api/auth/sso/*`) and on test-send / test-connection.
- Audit events for every configuration change, link / unlink, test, publish, automation run failure and
  content view; attributes carry identifiers and counts, never bodies, addresses of third parties, tokens
  or URLs that embed tokens.
- Accessibility: every new page passes the axe checks used by the existing feature tests, works at 320 px,
  and is operable by keyboard; drag-only interactions always have a non-drag alternative.

### 4.1 Review gates added after the design review (http_security_engineer, accepted by /root)

- **I (SSO):** `state` is consumed atomically and is bound to its purpose (sign-in, link, step-up, test),
  the browser (pre-auth cookie) and, for link / step-up, the session. Enforce verifier, nonce, an explicit
  algorithm allow-list, issuer, audience, tenant and the canonical redirect URI; log the callback without
  its query string. After the callback the user gets a full session only when the same assurance gates as
  a local sign-in are met; otherwise only the remediation steps (local factor, forced change). Sessions
  rotate on sign-in and the event is audited. A step-up through Entra must come from the **same linked
  identity** and prove fresh multi-factor (`auth_time` fresh **and** `amr` with `mfa`); a fresh `auth_time`
  alone is not multi-factor. Changing tenant, client or secret invalidates pending grants. No privilege
  ever follows from an e-mail address.
- **I (linking):** linking requires proof of control of the Entra account (a completed callback), fresh
  step-up, and uniqueness of (tenant, object) and of the user's link. An administrator binding requires
  step-up and an object id verified in the configured tenant. The local-MFA-administrator invariant is
  enforced inside the transaction of every credential, role and status change, with a tested recovery path.
- **B / D (mail):** redacted audit copies and stored content are rendered from redacted input, not by
  string-replacing secrets in rendered output. The audit copy has its own delivery state and its address
  is verified (confirmation message) before use. Content views are bounded, purged and served `no-store`.
  Placeholders are typed and allowed only in safe sinks (text, attribute values of allowed https / mailto
  links); this holds for editor and preview requests too.
- **Preview pattern (one approved way):** a sandboxed `iframe` with `srcDoc`, no `allow-scripts`, no
  `allow-same-origin`, a restrictive policy in the document, and a preview-only projection that removes
  every navigation and network attribute. No `dangerouslySetInnerHTML`, no relaxation of the global policy.
- **J (automations):** a durable automation-origin marker travels with every asynchronous descendant
  (jobs, mails, webhooks, audit events) so loop protection survives the worker boundary. Deduplicate by
  trigger event, automation version and action. Schedules and run counts are bounded. Webhook secrets are
  never echoed; deliveries are signed with a timestamp; a lost lease must not dispatch twice.
- **G / H (storage):** OAuth `state` is bound to actor, session, provider, configuration and connection;
  capability and fresh step-up are re-checked in the callback. Graph upload-session URLs are guarded
  separately (bounded host lineage, no bearer token forwarded, URL never logged). Request the narrowest
  permissions and verify the identity of the object after upload.
- **K:** the normal policy is enforced in a real browser; no `unsafe-inline`, `unsafe-eval` or
  style-attribute exception for any library.

## 5. Definition of done (each owner)

Types and lint clean for your paths; tests for the service rules and the negative cases; component tests
with axe for each page; `API.md` and `VERIFICATION.md` updated, stating plainly what was tested against a
fake and what has never touched the real provider; schema final and reported; report to `/root`.
