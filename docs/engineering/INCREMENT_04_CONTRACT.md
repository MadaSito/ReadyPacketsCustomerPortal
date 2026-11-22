# Increment 04 — Workflow rules, protection, knowledge, community, referrals, API, consent, cart (team contract)

Owner input (2026-11-21, after upgrading the live server to increment 03), thirteen items plus one addition:

1. Order workflow: phase locking, file uploads, audio uploads, convert audio to WebM, record audio,
   acknowledgements required by the administrator.
2. Security: OWASP Top 10 protections with WAF controls, rate-limit controls, IP blocking, session logs,
   geo blocking, session viewing, restrictions and forced session ends.
3. Maintenance mode set by the administrator: banner on the sign-in screen, customers cannot sign in.
4. Knowledge base centre in the console, publishable to customers, searchable by customers.
5. Community forum the administrator can enable or disable.
6. Referral management: administrator sets rewards; customer sees referral history, shares or e-mails a link.
7. Secure inbound and outbound API and webhooks, searchable / filterable logs, re-run a call.
8. Light, dark and system mode.
9. Fully responsive on any device (laptop, desktop, phone, tablet, small embedded screens).
10. Cookie management that supports GDPR and similar frameworks and works with Microsoft Clarity and PostHog.
11. Better navigation for the customer portal (reference: the previous system's left sidebar).
12. Cart with redirect to Stripe or Square for payment.
13. Administrator creates orders for customers, reassigns orders, grants other users access to a customer's orders.
14. (Addition) The site must be accessible — "ADA compliant".

`BUILD_CONTRACT.md` governs everything (module shape, ownership checks, audit, errors, transactions, client
conventions). The working rules of `INCREMENT_03_CONTRACT.md` §0 apply unchanged, with these differences:

- Branch `feat/increment-04` is checked out in the shared tree. Nobody switches branches or pushes.
- `/root` generates `migrations/0003_*.sql` once. Additive only (the live server will be upgraded). If you
  need something drizzle-kit cannot express (FULLTEXT index), give `/root` the exact statement.
- Capabilities already added by `/root` (see `shared/capabilities.ts`, block "increment 04").
- New server modules are mounted by `/root` in `server/trpc/root.ts` and `server/container.ts`; new client
  features in `client/src/app/registry.ts`. Tell `/root` the export names when the module compiles. Until
  then build and test in your own folder.
- Raw HTTP routes (API v1, webhook receivers, payment return / webhook routes) are **mounted by
  http_security_engineer** in `server/http`; the owning module exports an Express router factory and states
  what it needs (raw body, size limit, auth mode). No module adds its own body parser or CORS rule.
- Pre-approved dependencies: `mmdb-lib` (MIT, country lookup; http_security_engineer). Everything else: ask.
  No payment SDKs, no cloud SDKs: signed HTTPS through `integrations/egress.ts`.
- `ffmpeg` is a system package (installer and image add it; portable_ops_engineer). It is never a Node dependency.
- Reports to `/root`: at most 150 words. Keep messages to other owners short; publish interfaces in `API.md`.

## 1. Decisions (ADRs 0029–0037, written by /root)

1. **Phases.** A workflow definition may group statuses into ordered phases. When an order leaves a phase the
   phase is locked: its uploads, acknowledgements and customer-editable data become read-only. Staff with
   `orders.phase.unlock` can unlock with a reason (audited, customer notified optional). Existing
   order-level lock states keep their meaning and always win.
2. **Requirements are data on the status.** Per status: upload slots (key, label, kind `document` | `audio`,
   min / max count, allowed types, who uploads) and acknowledgements (key, title, body text, who must
   accept). A transition out of the status is refused while a requirement is unmet. An acknowledgement
   record stores the SHA-256 of the exact text shown, definition version, user, session id, time, IP
   (per the existing audit rules) and cannot be edited; withdrawing is not offered.
3. **Audio.** Recording happens in the browser (MediaRecorder; nothing leaves the device until the user
   presses upload). Conversion to WebM / Opus happens on the server by a worker job running `ffmpeg` with
   an argument array (no shell), no network, input from the quarantined original, time, CPU, output-size
   and duration limits; the original is kept; the converted file is a new derived file linked to it.
   If `ffmpeg` is missing the feature reports "conversion not available" and uploads still work.
4. **Protection layer is application-level.** Managed rule groups (injection patterns, path traversal,
   protocol anomalies, scanners / bad agents, oversize) each `off | detect | block`; custom rules
   (match on path, method, header, query, IP / CIDR, country → block, challenge is not offered, log);
   IP allow / deny lists with CIDR, expiry and reason; automatic temporary block after repeated blocks;
   country allow or deny list resolved from an administrator-supplied MMDB file (no call to an outside
   service; optional trusted-proxy country header). Ships in **detect**; an administrator cannot lock
   themselves out (current IP / country is tested before saving, break-glass env switch
   `PROTECTION_DISABLED=1`, health and ACME paths exempt). It is documented as a complement to, not a
   replacement for, a network firewall / CDN WAF.
5. **Sessions.** Administrators see live sessions of all users (user, role, created, last seen, IP,
   country when known, device summary, authentication method), a searchable sign-in / session log
   (success, failure, lock, sign-out, forced end, expiry), can end one session, all of a user's, or all
   customer sessions, and set restrictions: concurrent sessions per user, idle and absolute lifetime per
   role, console IP allow-list, country rule. An administrator can never end their own current session
   through the bulk action. All of it audited.
6. **Customer maintenance mode** is separate from the existing background-work drain. When on: sign-in
   page shows the administrator's message (and expected end), customer sign-in, registration and SSO for
   customers are refused with a clear message, optionally existing customer sessions are ended; staff and
   administrators sign in normally and see a console banner. Scheduled start / end optional. The public
   status endpoint exposes only `{ active, message, expectedEnd }`.
7. **Knowledge base and community content is sanitised rich text** (the mail-template sanitiser /
   allow-list), stored as data, rendered without `dangerouslySetInnerHTML` of unsanitised input. The
   community is **off by default**; customers post under a display name they choose (never e-mail or
   legal name), posts are rate-limited, reportable, moderated (hide, lock, pin, remove; audit trail), and
   community pages are `noindex`.
8. **Referrals.** One non-guessable code per customer (10 chars, 0-9 A-Z without look-alikes). Attribution
   at registration (`/register?ref=CODE`, stored first-party for 30 days, self-referral and same-account
   refused). A referral qualifies when the referred customer's first invoice is fully paid; reward is a
   fixed amount or a percentage with a cap, as account credit recorded in a reward ledger; approval is
   manual by default. Paying out / applying credit is an explicit administrator act. Sending "my link"
   by e-mail uses a template, is rate-limited per customer and per recipient, and tells the recipient who
   sent it. A discount for the referred customer is **not** in this increment.
9. **Inbound API** is `/api/v1` (REST, JSON, OpenAPI 3.1 document served at `/api/v1/openapi.json`),
   authenticated by API keys: shown once, stored as a hash (prefix kept for lookup), scopes, expiry,
   optional IP allow-list, per-key rate limit, optional request signing (HMAC-SHA256 over timestamp +
   method + path + body, 5-minute window, replay cache). Keys act as a service principal bound to scopes,
   never as a user; every call is attributed in the audit trail. `Idempotency-Key` honoured on writes.
10. **Webhooks.** Outbound subscriptions (events from the automation trigger catalogue) are delivered from
    an outbox through the egress allow-list, signed (`t=…,v1=…` HMAC-SHA256, per-subscription secret,
    rotation with overlap), retried with back-off, disabled automatically after sustained failure.
    Inbound endpoints have their own URL id and secret, verify signature + timestamp, deduplicate by
    event id, and can only start automations. The increment-03 production webhooks (P101 / P201) are
    unchanged.
11. **Logs and re-run.** Every API request, outbound delivery and inbound event is logged (who / key,
    method, path, status, duration, correlation id, sizes; headers and bodies redacted by the existing
    redaction rules, bounded to 64 KiB, encrypted, retained 30 days by default). Advanced filters and
    search. Re-run means: redeliver an outbound webhook; reprocess a stored inbound event; replay a stored
    API call. A re-run requires `api.replay` (step-up), is audited, carries `X-ReadyPackets-Replay: 1`
    and a new delivery id, and refuses when the stored body was truncated or purged.
12. **Payments reverse ADR 0014 partially.** Card data never touches the portal: checkout redirects to a
    page hosted by Stripe (Checkout Session) or Square (payment link). The administrator chooses
    `none | stripe | square`; `none` keeps today's pay-by-invoice. An invoice is marked paid only after
    (a) a provider webhook with a valid signature **and** (b) the payment object fetched back from the
    provider matches the stored attempt (id, amount, currency, invoice reference). The return page never
    marks anything paid. Refunds and disputes stay manual. Recorded in the existing invoice ledger with
    the provider reference.
13. **Cart** is server-side, one open cart per customer; prices, the bundle rule and tax are always
    recomputed on the server from the catalogue at checkout; checkout creates the order(s) and one invoice
    atomically, then a payment attempt.
14. **Consent.** No non-essential cookie, storage entry or script before an explicit choice. Categories:
    necessary (always), preferences, analytics (PostHog), session replay (Microsoft Clarity). "Reject all"
    is as prominent as "Accept all"; no pre-ticked boxes; Global Privacy Control / Do Not Track = reject
    by default; choice can be changed any time from a persistent "Manage cookie preferences" link;
    withdrawing stops the tools and removes their cookies where the browser allows. Each decision is
    recorded in a server-side ledger (anonymous consent id or user, policy version, categories, time,
    source, GPC flag; no IP stored in clear) and re-asked on policy-version change or after 12 months
    (administrator-configurable 6–13). The administrator maintains the cookie inventory shown to users.
    The theme preference is stored only after "preferences" consent or for a signed-in user server-side;
    otherwise it follows the system setting for the session.
15. **Accessibility target is WCAG 2.2 level AA** in both themes (the technical standard used to assess
    ADA conformance). It is engineered and tested for, never certified by us. See §4.2.
16. **Navigation.** The customer area gets a left sidebar at ≥ lg (collapsible to icons), a drawer below,
    and keeps the phone bottom bar (4 entries + More). Groups: main, Support, Account. The theme control
    is a visible three-way segmented control (System | Light | Dark) in the top bar (icon-only menu on
    phones), on the sign-in page and in Account settings.

## 2. Work packages

### A. Workflow rules, phase locks, admin order actions — orders_engineer
Server (`server/modules/orders`): extend the workflow definition (draft validation, publish, standard
workflow untouched by default) with `phases` and per-status `requirements` (decisions 1–2); tables for
phase-lock state, acknowledgement records and requirement fulfilment; transition guard; unlock procedure;
`orders.requirements.forOrder` for the client. Ports: ask files_engineer for "files in slot" counts.
Client: designer wizard + canvas gain Phases and Requirements steps; order page shows a phase rail, a
checklist ("what is needed before the next step"), acknowledgement dialog (full text scroll, explicit
checkbox, typed name optional), lock badges and the staff unlock dialog.
Item 13: console **New order for a customer** (customer picker → the normal order form), **Reassign**
(existing procedure) and **Access** (grant / revoke viewer or contributor on one order or all of a
customer's orders to another platform user by e-mail lookup; `orders.access.grant`, step-up, audited,
both parties notified) reachable from the console Orders list, order page and customer page.

### B. Uploads, audio recording and conversion — files_engineer
Slot-aware upload (`slotKey`, order, status) with the existing quarantine / classification pipeline;
client `AudioRecorder` (MediaRecorder with permission prompt explained beforehand, level meter with a text
alternative, pause / resume, elapsed time announced politely, max duration / size, review before upload,
full keyboard operation, graceful "recording is not supported in this browser"); server conversion job
(decision 3) registered with jobs; derived-file link; per-file state `converting | converted | failed`;
settings (enabled, max minutes, bitrate, keep original). Real `ffmpeg` exists in the sandbox at
`/usr/bin/ffmpeg`: test against it, and test the "missing binary" path.

### C. Protection: firewall rules, IP lists, geo, rate-limit controls — http_security_engineer
New module `server/modules/protection` + hook early in the pipeline (after trusted-proxy resolution,
before body parsing where possible), decision 4. Rate-limit policies become administrator-tunable within
safe bounds (floor and ceiling per policy, reset to default), with a view of current blocks and "release".
Event log table (time, IP, country, rule, action, path, method, user agent, correlation id) with filters
and export; events also go to the audit / SIEM stream as security events. Client
`client/src/features/protection`: Overview (mode, counters), Rules, IP lists, Countries, Rate limits,
Events. Also mounts the raw routes of packages H, I, K. Reviewer for this package: assurance_engineer.

### D. Session centre and restrictions — identity_engineer
Decision 5 in `server/modules/identity` + console pages **Sessions** (live, filters, end) and **Sign-in
log**; restrictions settings and their enforcement at session creation and on each request; customer
Security page (password, two-factor, active sessions with "Sign out all others", recent sign-in
activity) modelled on the previous system. Enforces decision 6 at local sign-in, registration and SSO
(port from package E). Accepts the referral code at registration (port from package G: validate + attribute).

### E. Customer maintenance mode — jobs_engineer
Decision 6: settings + schedule, `maintenance.customerAccess()` port for identity, public status
endpoint, sign-in banner component (uses `role="status"`, not a modal), console Maintenance page section
next to the existing drain controls, optional "end customer sessions now" (calls identity), mail template
"maintenance window" hook, audit.

### F. Knowledge base — engagement_engineer
New module `server/modules/knowledge` + `client/src/features/knowledge`. Categories (ordered, nested one
level), articles (slug, title, summary, sanitised rich body, tags, audience `customers | staff`, state
`draft | published | archived`, versions with restore, author, reviewed-on date, related articles),
attachments through files, search (title / summary / body / tags, ranked, highlighted snippets, filters,
"no results" suggestions; search terms logged without user identity for the administrator's "top
searches / searches with no result" report), helpful yes / no with optional comment, view counts.
Console: list with filters, editor with preview, publish / unpublish, reorder. Customer: `/help` centre
(search first, categories, article page with table of contents and print style), contextual "Related
articles" widget slot for the support-ticket form.

### G. Referrals — siem_engineer
New module `server/modules/referrals` + client feature. Decision 8. Console: programme settings form,
referrals list with filters, review (approve / reject with reason), reward ledger, mark credited / paid,
export. Customer `/account/referrals`: code, copy code, copy link, share (Web Share API when available),
e-mail my link (dialog, template from mailTemplates), stat cards (total, pending, approved, reward value),
history table. Ports: identity (attribute at registration), compliance (`onInvoicePaid` event), jobs (mail).

### H. Inbound API v1, keys, request log, replay — portable_contract_engineer
New module `server/modules/publicApi`. Decisions 9 and 11. First resource set (read unless noted):
customers, orders (+ create, + transition where the workflow allows `api` actor), order files metadata,
invoices, tickets (+ create), knowledge articles, webhook subscriptions. Cursor pagination, consistent
problem-details errors, correlation id echoed, rate-limit headers. OpenAPI document generated from the
same Zod schemas. Console: API keys (create → shown once, scopes, expiry, IP list, rotate, revoke, last
used), API log with filters, request detail, replay.

### I. Webhooks: subscriptions, inbound endpoints, delivery log, re-run — integrations_engineer
In `server/modules/integrations/webhooks/**`. Decisions 10 and 11. Console: Subscriptions (URL must match
an egress allow-list rule, events, secret shown once / rotate, test delivery, pause), Inbound endpoints,
Deliveries log (filters: direction, subscription, event, status, time, correlation id, text search),
detail with attempts, redeliver / reprocess. Publishes events to automations as triggers and subscribes
to the automation trigger catalogue (ask audit_engineer / engagement_engineer for the catalogue port).

### J. Cookie consent and privacy centre — platform_engineer
Decision 14. Server: consent ledger, policy version, cookie inventory, settings; public endpoints for
reading the inventory and recording a decision (rate-limited, no session required). Client: banner
(not a focus trap, does not cover the sign-in form on small screens, reachable first in tab order),
preference centre dialog, persistent footer link + account "Privacy and cookies" page (history of my
choices, download), wiring to the existing analytics loader (`client/src/features/integrations/consent.tsx`):
PostHog `opt_in_capturing` / `opt_out_capturing` and cookieless until consent; Clarity loaded only after
consent and told through its consent API; both removed on withdrawal. Console: inventory editor, consent
statistics, ledger search / export. Coordinate CSP changes with http_security_engineer.

### K. Payments — compliance_engineer
New module `server/modules/payments` + console page. Decision 12. Provider interface
`{ key; createCheckout(attempt) → { redirectUrl, providerRef }; verifyWebhook(rawBody, headers);
fetchPayment(ref) }` with Stripe (Checkout Sessions, form-encoded, `Stripe-Signature`) and Square
(payment links, `x-square-hmacsha256-signature`) implementations over egress; attempts table with state
machine `created → redirected → paid | failed | expired | cancelled`; webhook inbox with dedupe;
reconciliation job for attempts left `redirected`; books the payment in the invoice ledger; emits
`invoice.paid` for referrals / automations / webhooks. Settings: provider, keys (write-only), mode
(test / live shown clearly), success / cancel paths, currency. Replaces the disabled Stripe scaffold.
Test with local protocol fakes that verify our request shape and sign webhooks the way the provider does.

### L. Cart and checkout — recovery_ops_engineer
New module `server/modules/cart` + `client/src/features/cart`. Decision 13. Add packet + tier from the
catalogue / order form, cart page (edit, remove, totals, bundle rule explanation), cart badge in the
shell, checkout review (billing details, policies to accept through compliance), place order →
redirect (port from K) or "pay by invoice" when provider is `none`; return pages (success pending
confirmation with polling, cancelled → cart restored); abandoned-cart expiry job; console read-only view
of open carts (`carts.read_all`).

### M. Community forum — audit_engineer
New module `server/modules/community` + client feature. Decision 7. Enable switch (`community.manage`),
categories, topics, replies (flat with quote), display-name profile, reactions (helpful), subscriptions
with notification through engagement, edit window, reporting, moderation queue (`community.moderate`),
word filter, new-member posting limits, search, soft delete, per-user suspension. When disabled every
community route returns not-found and navigation entries disappear.

### N. Navigation, theme control, responsive and shared components — ui_foundation_engineer
Decision 16 in `client/src/app/shell` and `client/src/ui`. `NavItem.group` applies to the customer area
(`undefined` main, `"Support"`, `"Account"`); `NavItem.enabledBy` hook for entries that depend on a
feature switch (community, referrals, cart). Breadcrumbs on nested pages; command / search entry kept.
Shared components other packages need on day one (publish in `client/src/ui/README.md` first, then
build): `SegmentedControl`, `Stepper / PhaseRail`, `Checklist`, `StatCard`, `CopyField`, `EmptyState`
variants, `TagInput`, `CodeBlock` (for API examples), `Timeline`, `Pagination`, responsive `DataTable`
card mode below sm. Responsive rules: no horizontal page scroll from 240 px to 3840 px; fluid type;
container queries where a component lives in both a sidebar and a page; safe-area insets; landscape
phones; `hover: none` and coarse pointers; print styles for articles, invoices, receipts.
Owns `scripts/qa/responsive-check.mjs` (headless browser over every route × widths 240, 320, 390, 768,
1024, 1440, 1920, 2560 × both themes: fails on horizontal overflow, clipped text, tap targets < 24 px).

### O. Accessibility and review — assurance_engineer
§4.2. Owns `client/src/test/a11y.tsx` helper (axe-core is already a dev dependency) and the rule that
every new page has an axe test in light and dark; `scripts/qa/a11y-check.mjs` (axe in a real browser over
every route, both themes, zoom 200 % and 400 % reflow at 320 px); a public **Accessibility** page
(`/accessibility`: target standard, known limitations, how to report a barrier, contact); a manual
checklist in `docs/verification/ACCESSIBILITY.md` (keyboard path, focus order, screen-reader names,
contrast measurements of both themes' tokens, reduced motion, forms errors, timeouts, media) with results
per page filled in honestly ("not checked" where not checked). Security reviewer of package C.

### P. Installer, image, CI, operations documents — portable_ops_engineer
`ffmpeg` in `deploy/` installer, upgrade and Docker image (version reported in health); directory and
permissions for the MMDB file (`/var/lib/readypackets/geo`), documented download of a free country
database by the operator; `native-install` upgrade job baseline moved to `89c5cb8`; new env switches in
`.env.example` and `server/config/env.ts` docs; `docs/operations/UPGRADE.md` section for 0003; admin
guide chapters collected from owners.

### Q. Security review — http_security_engineer (packages H, I, K, L, G, M, F) and assurance_engineer (C, D, J)
Written findings in `docs/verification/INCREMENT_04_SECURITY_REVIEW.md`, severity and status; owners fix.

## 3. Ports (owners publish exact types in their `API.md` on day one)

| Port | Provider | Consumers |
|---|---|---|
| `orders.requirements` slot keys, `countFilesInSlot(orderId, slotKey)` | files | orders |
| `maintenance.customerAccess(): { active, message, expectedEnd }` | jobs | identity, shell |
| `identity.sessions.endAllCustomers(actor, reason)` | identity | jobs, protection |
| `referrals.attributeRegistration(code, newUserId)` / `validateCode` | referrals | identity |
| `payments.startCheckout(invoiceId, returnPaths)` → `{ redirectUrl } \| { mode: "invoice" }` | payments | cart |
| `invoice.paid` domain event | compliance / payments | referrals, automations, webhooks |
| `webhooks.publish(eventKey, payload)` + trigger catalogue | integrations / automations | all modules that emit events |
| `protection.clientCountry(req)` | protection | identity (session list, restrictions) |
| `consent.has(category)` (client) | platform | integrations analytics loader, theme storage |
| `features.enabled(key)` (client, from one public bootstrap query) | platform | shell navigation |
| raw route registration | http (http_security_engineer) | publicApi, webhooks, payments |

## 4. Security requirements reviewers will check

- Every new procedure: role + capability + **resource scope** check on the server; ids are public ids;
  lists are paginated and bounded; inputs validated by Zod with length limits.
- No secret (API key, webhook secret, provider key) is stored in clear, returned after creation, logged,
  placed in audit attributes or included in exports. Comparison of secrets and signatures is constant-time.
- Raw webhook bodies are verified before parsing; timestamps outside ±5 minutes are refused; event ids
  are deduplicated; handlers are idempotent.
- Outbound URLs: https only, egress allow-list, pinned resolution, no redirects, no private ranges (SSRF).
- User content (articles, posts, display names, acknowledgement text, banner message, cookie inventory)
  is sanitised on write and escaped on render; no user-controlled URL becomes a script, style or frame
  source; links get `rel="noopener noreferrer nofollow ugc"` in community content.
- Money: integers in minor units, currency explicit, totals recomputed on the server, state machines
  guarded by compare-and-set, every transition audited.
- `ffmpeg`: argument array, fixed binary path from configuration, `-nostdin`, protocol whitelist
  `file` only, working directory in the quarantine area, limits on time / memory / output size, input
  already classified as audio by our own sniffing, output re-classified before it becomes visible.
- Protection rules use linear-time matching (no user-supplied regular expressions without a safe-regex
  check and a timeout); the event log cannot be flooded into exhausting the disk (sampling + retention).
- Abuse: referral self-dealing, e-mail-my-link as a spam relay, forum spam, cart price tampering, replay
  of API calls, enumeration of referral codes / API key prefixes — each has a test.
- Everything ships disabled or in detect mode and is audited when switched on.

### 4.2 Accessibility requirements (WCAG 2.2 AA; every owner, checked by assurance_engineer)

- Semantic landmarks and one `h1` per page; headings in order; page title set; focus moved to the main
  heading on navigation (existing `RouteFocus`).
- Everything operable by keyboard alone in a logical order; visible focus indicator ≥ 3:1; no keyboard
  trap; dialogs trap and restore focus; `Escape` closes; drag operations (canvas, reorder) have a
  non-drag alternative (WCAG 2.5.7).
- Targets at least 24 × 24 CSS px (2.5.8), 44 px preferred on touch.
- Text contrast ≥ 4.5:1 (large text and UI components ≥ 3:1) in light **and** dark; colour never the only
  signal (status badges carry text or an icon with a name).
- Forms: programmatic labels, `autocomplete` tokens, errors identified in text, associated with the field
  and announced; no redundant re-entry inside one process (3.3.7); authentication does not require a
  cognitive test — paste and password managers allowed (3.3.8).
- Status messages through live regions (`role="status"` / `alert`) — toasts, upload progress, recording
  timer, cart updates, consent saved.
- Reflow at 320 CSS px and at 400 % zoom without two-dimensional scrolling (tables switch to cards or
  scroll inside a labelled region); text spacing overrides do not clip; content on hover / focus is
  dismissible and persistent.
- `prefers-reduced-motion` respected; nothing flashes; session timeout is announced with a way to extend.
- Audio: recorder controls named; recorded / uploaded audio has a play control with a name and duration;
  a transcript field is offered next to audio uploads (optional, labelled).
- Language attribute set; link purpose clear from text; consistent navigation and help location (3.2.6).
- Words for users: we say "designed and tested against WCAG 2.2 AA"; we never write "ADA compliant",
  "certified" or "100 % accessible" in product text or documents.

## 5. Definition of done (each owner)

1. Feature off by default; switching it on is audited; nothing breaks when it is off.
2. `pnpm typecheck` clean for your paths (`scripts/dev/tc.sh`), ESLint clean, your tests green one file at a time.
3. Tests cover: authorisation matrix (anonymous / customer / other customer / staff / admin), validation,
   the abuse cases of §4, state machines, and an axe check per page in both themes.
4. `API.md` (procedures, ports), `VERIFICATION.md` (what you ran, what was only tested against fakes,
   what is not verified), an administrator-guide section and a customer-help article draft (Markdown) in
   your module folder.
5. Works at 320 px and in dark mode; no text in colour only; every control has an accessible name.
6. Report to `/root`: done / commits / not done / needs — at most 150 words. Then schema final → `/root`.
