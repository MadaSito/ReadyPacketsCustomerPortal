# Increment 08 — go-live checklist, step wizard, payment confirmation, add-on orders, billing profile, names, order numbers

Owner request (2026-11-26, prompt 34, eight screenshots kept outside the repository). In short:

1. A **test checklist** that proves the system is ready to go live.
2. **Customer order page = a step-by-step wizard** (accept what the workflow requires → Next → upload documents
   and/or record audio → Next …) instead of an overview with no way forward; an explicit **Publish** button for
   the administrator's workflow designer.
3. **Stripe must tell the portal a payment succeeded.** On the owner's server the customer paid, came back to
   "Waiting for payment confirmation" and the invoice stayed "Issued".
4. Selecting a packet tier **expands that tier's outcome and deliverables**.
5. **Add to an earlier order**: buy packet 1 today, packets 2 and 4 next month, same project.
6. **Billing information** collected at registration / account setup; at checkout choose the saved billing
   information or enter new.
7. Registration asks for **First name, Last name, Preferred name**.
8. **Order number** = `RP-<last 4 of customer ID>-<first 3 of first name><first 3 of last name>-<first 6 of
   project name>-<NNN>`, e.g. `RP-JJG5-ZEUGRE-ICEQUE-001`; the number rises when more is added to the order.

`BUILD_CONTRACT.md` and the contracts of increments 04–07 still govern everything (module shape, ownership
checks on every read and write, audit events, safe errors, step-up, idempotency, strict inputs, public ids only
across the wire, no secrets or personal data in logs, WCAG 2.2 AA in both themes, no horizontal overflow from
240 px to 1440 px). This file adds only what increment 08 needs.

## 0. Working rules

- Branch `feat/increment-08` is checked out in the shared tree. Nobody switches branches, pushes, builds or
  starts servers (only `/root`).
- Commit only your own paths with `scripts/dev/commit.sh "<message>" <paths>`.
- Verify with the FULL type check (`scripts/dev/tc.sh`), `pnpm exec eslint <your paths> --max-warnings 0`, and
  your tests one file at a time (`source scripts/dev/env.sh; NO_COLOR=1 pnpm exec vitest run <file>`). Add or
  update tests for everything you change. The host has 2 vCPUs: never run the full suite.
- `/root` generates `migrations/0008_increment_08.sql` once. **Additive only**: new tables, new nullable
  columns or columns with defaults, new indexes, enum widening, `varchar` widening. Declare them in your
  module's `schema.ts` and report **"schema final"** to `/root` as early as you can (before the rest of your
  work is finished). Do not run `drizzle-kit`. Backfill runs in idempotent start-up code or lazily, never in SQL.
- New capabilities, module mounts (`server/trpc/root.ts`, `server/container.ts`, `client/src/app/registry.ts`),
  service ports on the container and raw HTTP routes are added by `/root`. Ask with exact names and signatures.
- Never put real names, e-mail addresses, customer IDs, keys or signing secrets in code, tests or documents.
  Synthetic examples only (`Zeus Greene`, `RPCUS-A1B2CJJG5`, project `Ice Queen`). A test fixture that looks
  like a key needs a reviewed line in `.gitleaksignore`; tell `/root`.
- CodeQL blocks security severity ≥ 7 (for example single-pass tag stripping by regular expression). Fix, never
  baseline.
- Existing data keeps working: existing orders keep their references, existing users keep signing in, existing
  active Stripe configurations stay active, API v1 responses stay backward compatible (new fields may be added).
- Report to `/root` in 150 words or fewer: commits, what was verified and how, what is not verified, open risks.

## 1. Decisions (settled; do not reopen without `/root`)

### D1 Names (identity_engineer)

- `users` gains nullable encrypted `first_name_enc`, `last_name_enc`, `preferred_name_enc`. The existing
  encrypted display name stays and is always `"<First> <Last>"`, so every existing consumer keeps working.
- Registration, profile, administrator customer creation/edit and invitations ask for **First name** (required,
  1–50), **Last name** (required, 1–50), **Preferred name** (optional, 0–50); lengths in UTF-16 units so the
  composed name (≤ 101) fits every downstream cap (typed signature 120, billing 160, P101 200). Autocomplete tokens `given-name`,
  `family-name`, `nickname`.
- Accounts created before 08 (and single-name SSO subjects): parts are derived lazily — first whitespace token =
  first name, last token = last name (one token → last name empty) — and stored the next time the profile is
  saved. Entra OIDC/SAML: use `given_name` / `family_name` (SAML givenname/surname) when present.
- Greeting ("Welcome back, …", mail salutations) uses preferred name, else first name. Legal/billing/invoice
  contexts keep the full name.
- Port for other modules (added to the identity service surface; `/root` wires nothing new if it already hangs
  off `services.identity`):
  `identity.users.namePartsInTx(tx, userId) → { firstName: string; lastName: string; preferredName: string | null; customerRef: string | null }`.

### D2 Order numbers (orders_engineer)

- New generated references: `RP-<C4>-<F3><L3>-<P6>-<NNN>`, upper case.
  - `<prefix>` stays the configurable order reference prefix setting (default `RP`).
  - `C4` = last 4 letters/digits of the owner's customer ID (`RPCUS-…`); no customer ID → `0000`.
  - `F3` / `L3` = first 3 letters/digits of first / last name; `P6` = first 6 letters/digits of the project name.
  - Folding: NFKD, strip combining marks, upper-case, keep `A–Z0–9` only. Too short → pad right with `X`
    (`Li` → `LIX`; nothing usable → `XXX` / `XXXXXX`).
  - `NNN` = next unused number for that stem (`RP-C4-F3L3-P6`), at least 3 digits, starting at `001`, allocated
    under a row lock in the creating transaction and checked against `order_references` (a value once used is
    never reused). Above 999 it simply grows to 4 digits. Total length ≤ 32 (`REFERENCE_PATTERN` unchanged).
  - The stem is frozen from the name / project at creation; later renames never change a reference.
- Existing orders keep their `RP-YYYY-NNNNNN` reference. Manual reference change by an administrator is
  unchanged. Portable import keeps imported references (falls back to the new generator only when it has to).
- Pure function `buildReferenceStem({ prefix, customerRef, firstName, lastName, projectName })` in
  `server/modules/orders/references.ts` with table-driven tests (diacritics, non-Latin, short, punctuation,
  emoji, very long).
- Check every place that assumes the old shape (search, sorting, P101/P201 payloads, SharePoint folder names,
  mail samples, invoice/receipt "Order" line, API v1 docs). Nothing may validate `RP-\d{4}-\d{6}`.

### D3 Add to an earlier order (orders_engineer server + order page; recovery_ops_engineer cart)

- An addition is a **new linked order** in the same **order group**: own line items, own invoice, own payment,
  own workflow instance. `orders.group_root_order_id` (nullable; `NULL` = the order is its own root).
- Its reference uses the root's stem when the root has a new-format reference, otherwise a stem computed now;
  the number is the next unused one (root `…-001`, first addition `…-002`). Project name is copied from the root.
- Server: `orders.create` (internal service + cart path) accepts optional `addToOrderPublicId`. Checks: caller
  owns the root (or staff/admin acting through the existing console handoff for that customer), root is not
  cancelled/archived, same currency. A packet (by packet number) already bought in the group in any tier is
  refused with `PACKET_ALREADY_IN_PROJECT` — the customer orders only packets the project does not have yet.
  Bundle discount rules apply to the new order on its own.
- Read models: order detail returns `group: { rootPublicId, orders: [{ publicId, reference, createdAt,
  statusLabel, packetNumbers }] }` (owner-scoped) and `canAddPackets: boolean`; order lists show the project
  grouping at least by reference.
- Customer UI: "Add packets to this project" on the order page → `/orders/new?addTo=<orderPublicId>`: project
  name fixed, packets already in the project shown as "Already in this project" and not selectable → cart →
  checkout. The cart carries `addToOrderPublicId` (`carts.add_to_order_public_id`, nullable); one target per
  cart; changing the target empties nothing but re-validates items; the checkout summary says
  "Adding to project <name> (<root reference>)".
- Admin/staff console: the order page shows the related orders of the group with links.

### D4 Billing profile (compliance_engineer module + settings page; recovery_ops_engineer checkout; identity_engineer registration)

- One saved billing profile per account, validated by `shared/billingDetails.ts` (created by `/root`; cart
  `types.ts` re-exports it instead of its private copy).
- New module `server/modules/billingProfile` (table `customer_billing_profiles`: `user_id` unique, encrypted
  JSON with AAD bound to the user's public id, `country`, `region`, `version`, timestamps). tRPC
  `billingProfile.get`, `billingProfile.save` (optimistic `version`), `billingProfile.clear`; owner only; audit
  events without field values; rate limit `form_submission`. Service port for other modules:
  `billingProfile.getForUserInTx(tx, userId)` and `billingProfile.saveForUserInTx(tx, userId, details, actor)`.
- Client `client/src/features/billingProfile/`: reusable `BillingFields` (labels, autocomplete tokens
  `billing name`, `billing street-address` …, error wiring) and a "Billing information" page in account settings.
- Registration: optional, collapsed section "Billing information (optional — you can add it later)". When
  filled it must be complete and valid; it is stored only when a NEW account is created (never for an existing
  e-mail address; the response stays indistinguishable). `/root` passes the port to identity.
- Checkout: when a profile exists, radio group "Use my saved billing information" (summary shown, default) /
  "Enter different billing information"; with new details a checkbox "Save as my billing information"
  (checked when no profile exists). No profile → today's form plus the checkbox.
- The profile is personal data. It is covered by portable export/import and backup
  (portable_contract_engineer). The customer can clear it at any time (`billingProfile.clear`). The portal has
  no self-service account data export or account erasure feature today (only deactivation); none is added in
  08 — documented as a known gap, privacy requests are handled by an administrator.

### D5 Payment confirmation (integrations_engineer)

Root cause on the owner's server is not known from here (most likely: endpoint not registered in that Stripe
mode, events not selected, or a signing secret from another endpoint — the built-in self-test signs with the
saved secret, so it cannot prove Stripe uses the same one). Stripe's own guidance is to fulfil from the webhook
**and** from the return page by retrieving the Checkout Session. Decision 12 of increment 07 ("never mark paid
without a signed webhook") is therefore replaced:

- A payment is booked from **either** a verified signed webhook **or** an authoritative provider lookup made by
  this server with its own credentials over the pinned-TLS client. Both go through ONE idempotent booking
  function; whichever arrives second is a no-op.
- The lookup books only when ALL hold: session id equals the one this server created for the attempt; `status`
  complete and `payment_status` paid (`no_payment_required` only for a zero total); amount and currency equal
  the attempt; `livemode` matches the attempt's environment; metadata / client reference binds the session to
  this attempt and invoice. Anything else → no booking, attempt stays pending, diagnostic recorded, ops alert.
  Async methods (`payment_status` unpaid on a complete session) stay pending until paid.
- Triggers: (a) the customer's return page `/checkout/return` and "Check payment status" — new customer
  mutation (owner-scoped, rate limited, per-attempt cool-down, never accepts an id from the URL other than the
  attempt's public id); (b) the scheduled reconciliation job (now books instead of writing
  `awaiting_webhook`); (c) administrator "Check with Stripe now" on an invoice / attempt (step-up) — this also
  repairs payments made before the upgrade.
- Booking source is recorded (`webhook` | `provider_lookup`) on the attempt and in the audit event; receipts,
  order `paymentState`, order workflow payment gate, mail and P101 queueing behave exactly as for a webhook.
- Missing-webhook detection: an attempt booked by lookup with no verified webhook after a grace period raises
  ONE de-duplicated ops alert "Stripe is not delivering webhooks to this server" and shows on
  `/admin/payments/setup`: last verified webhook received (time, type), count and reasons of recent rejections,
  the exact endpoint URL and the required events, and a plain explanation of the three usual causes.
- Return page copy: paid → "Payment received" with receipt and "Continue to your order" (opens the wizard);
  still processing → honest waiting text that auto-rechecks with back-off and never says the payment failed.
- Square keeps its current behaviour unless the same function serves it for free.
- No client-side trust anywhere: the browser never tells the server that something was paid.

### D6 Customer order wizard (audit_engineer; assurance_engineer reviews accessibility)

- Opening a purchased order lands on **the wizard**, not on an overview. The former tabs live behind a
  secondary "Order details" control (same page, deep links keep working).
- The wizard is a real stepper for the current phase with **Back** and **Next** always visible (Next is
  disabled only with a visible reason next to it). Steps exist only when the administrator's workflow
  requires them, in this order:
  1. **Review and accept** — phase instructions, required acknowledgements / policy acceptance.
  2. **Questions** — the phase's questions.
  3. **Upload documents** — required/optional document requests.
  4. **Record or upload audio**.
  5. **Review and submit** — summary of what was provided, "Submit" (the existing submit-and-lock call).
  Progress per step ("Step 2 of 4"), saved as the customer goes (existing calls), resumes on the first
  incomplete step, focus moves to the step heading on every step change, errors summarised at the top.
- Nothing to do / waiting: one clear screen with what happens next and the single useful action — "Pay now"
  when waiting on payment, "We are working on this phase" with expected next step when waiting on the team,
  download deliverables when delivered. Never a dead end without an explanation.
- Workflows in the older derived format (no configured phase actions — what the owner's screenshots show):
  the wizard offers the steps the server already allows for that order — intake questions when the order has an
  intake form, document upload, audio where permitted — then "Finish". If none is permitted it shows the
  waiting screen. Ask orders_engineer / files_engineer for any read-model field you need; no new permissions.
- After payment the return page continues straight into the wizard.
- WCAG 2.2 AA: stepper is an ordered list with `aria-current="step"`, no colour-only state, targets ≥ 24 px,
  works at 240 px and at 400 % zoom, reduced motion respected.

### D7 Workflow Publish and tier expansion (ui_foundation_engineer)

- Workflow designer: a persistent **Publish** button in the designer header on every step (disabled with a
  listed reason while the draft has validation errors; opens the existing publish dialog — change note, "make
  default", step-up). `/admin/workflows` drafts table gets a **Publish** row action for drafts that validate.
  Same server procedure and validation; no new permission. After publishing: clear confirmation naming the
  version and whether it is now the default for new orders.
- Packet picker: choosing a tier expands that tier's "outcome and deliverables" and collapses the others;
  manual toggling still works; "Not included" collapses all; the expanded state is announced
  (`aria-expanded`), focus stays on the radio.

### D8 Go-live checklist and documents (assurance_engineer checklist; platform_engineer the rest)

- `docs/operations/GO_LIVE_CHECKLIST.md`: numbered test cases with ID, steps, expected result, pass/fail,
  evidence, tester/date; sections: server and TLS, accounts and MFA, registration and names, catalogue and
  ordering, order numbers, add-on orders, billing, Stripe test mode and live mode (webhook delivery proof,
  return-page confirmation, refund), invoices and receipts, order workflow wizard and publishing, files and
  audio, mail, staff console, audit/logging/SIEM, backup and restore drill, upgrade and rollback, security
  headers and rate limits, accessibility (keyboard, screen reader, zoom), responsive devices, SEO, analytics,
  final sign-off with go/no-go rule. Honest wording: a checklist to run on the owner's server; no claim that it
  has been run there.
- platform_engineer: session log for prompts 33–34, `STATUS`, `CHANGELOG`, `APPLICATION_CONTEXT`, upgrade notes
  (this increment HAS a database migration), admin/customer guides for every decision above.

## 2. Owners

| Package | Owner | Paths |
|---|---|---|
| Names | identity_engineer | `server/modules/identity/**`, `client/src/features/auth/**`, `client/src/features/identity/**` |
| Order numbers, add-on orders (server, order pages) | orders_engineer | `server/modules/orders/**`, `client/src/features/orders/pages/**` except `pages/workflows/**` and the wizard hand-off in `OrderDetailView.tsx` (agree with audit_engineer) |
| Cart target, checkout billing choice | recovery_ops_engineer | `server/modules/cart/**`, `client/src/features/cart/**` |
| Billing profile | compliance_engineer | `server/modules/billingProfile/**`, `client/src/features/billingProfile/**` |
| Payment confirmation | integrations_engineer | `server/modules/payments/**`, `client/src/features/payments/**` |
| Customer wizard | audit_engineer | `client/src/features/orders/stages/**`, wizard-first layout of `OrderDetailView.tsx` |
| Publish button, tier expansion | ui_foundation_engineer | `client/src/features/orders/pages/workflows/**`, `client/src/features/orders/customer/packets/**` |
| Checklist, accessibility review | assurance_engineer | `docs/operations/GO_LIVE_CHECKLIST.md` |
| Documents, session log | platform_engineer | `docs/**` except the checklist |
| Export / import / backup / erasure coverage | portable_contract_engineer | portable modules |
| Mail samples, salutations, ops alert plumbing | jobs_engineer | `server/modules/jobs/**`, `server/modules/mailTemplates/**`, `server/modules/opsAlerts/**` |
| Security review of the increment | http_security_engineer | findings to owners and `/root` |
| QA sweep routes | portable_ops_engineer | `scripts/qa/**` |

## 3. Definition of done

Type check, eslint and the touched test files pass; every new write is owner-checked, audited and idempotent;
no new personal data in logs; both themes; no overflow 240–1440 px; axe WCAG 2.2 AA tags clean on changed
routes; documents updated; `/root` has verified the behaviour on the QA server.

The result, the verification and the accepted risks and known gaps for this increment are recorded in
[STATUS.md](../application-context/STATUS.md#verification-for-increment-08) and
[Accepted risks and known gaps (increment 08)](../application-context/STATUS.md#accepted-risks-and-known-gaps-increment-08).
