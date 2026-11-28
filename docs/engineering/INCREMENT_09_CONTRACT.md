# Increment 09 — clickable e-mail links, trash centre with restore and permanent deletion, new square logo

Owner request (2026-11-27, prompt 37; two logo PNG files and the master brand identity archive attached):

1. **"email links are not clickable please fix that"**
2. **Delete orders and customers.** Customers must be **suspended first**. Orders and suspended customers go to
   **trash** before they are deleted, and can be **restored**. **Confirmation** for permanent deletion and for
   restoring an order or a customer account. **Configurable retention clean-up** of customer accounts and
   orders in the trash.
3. **Update the logo to the new ReadyPackets square logo** (light and dark PNG attached) and put both PNG files
   and the master brand identity archive in the GitHub repository.

`BUILD_CONTRACT.md` and the contracts of increments 04–08 still govern everything (module shape, ownership
checks on every read and write, audit events, safe errors, step-up, idempotency, strict inputs, public ids only
across the wire, no secrets or personal data in logs, WCAG 2.2 AA in both themes, no horizontal overflow from
240 px to 1440 px). This file adds only what increment 09 needs.

## 0. Working rules

- Branch `feat/increment-09` is checked out in the shared tree. Nobody switches branches, pushes, builds or
  starts servers (only `/root`).
- Commit only your own paths with `scripts/dev/commit.sh "<message>" <paths>`.
- Verify with the FULL type check (`scripts/dev/tc.sh`), `pnpm exec eslint <your paths> --max-warnings 0` and
  your tests one file at a time (`source scripts/dev/env.sh; NO_COLOR=1 pnpm exec vitest run <file>`), eslint
  and vitest under `flock /tmp/rp-light.lock`. Add or update tests for everything you change. The host has
  2 vCPUs: never run the full suite.
- `/root` generates `migrations/0009_increment_09.sql` once. **Additive only**: new tables, new nullable
  columns or columns with defaults, new indexes, enum widening. Declare them in your module's `schema.ts` and
  report **"schema final"** to `/root` as early as you can. Do not run `drizzle-kit`. No backfill in SQL.
- New capabilities, module mounts (`server/trpc/root.ts`, `server/container.ts`, `client/src/app/registry.ts`),
  service ports on the container and raw HTTP routes are added by `/root`. Ask with exact names and signatures.
  Already added: capabilities `trash.read`, `trash.manage`, `trash.purge` (step-up), `trash.retention.manage`
  (step-up); administrators only.
- Never put real names, e-mail addresses, customer IDs, keys or signing secrets in code, tests or documents.
  Synthetic examples only (`Zeus Greene`, `RPCUS-A1B2CJJG5`, project `Ice Queen`).
- CodeQL blocks security severity ≥ 7. Fix, never baseline.
- Existing data keeps working. API v1 responses stay backward compatible (new fields may be added).
- Report to `/root` in 150 words or fewer: commits, what was verified and how, what is not verified, open risks.

## 1. Decisions (settled; do not reopen without `/root`)

### D1 Clickable links in e-mail (jobs_engineer; UI part ui_foundation_engineer + page owners)

Found by `/root`: `server/modules/jobs/mail.ts` `htmlAlternative(text)` and the text-derived
`defaultBodyHtml` in `mailTemplates/systemCatalogue.ts` escape the text into `<p>…</p>`, so a URL in the HTML
part is plain text. Many mail clients do not turn that into a link. Templates without an explicit HTML seed
(for example `orders.confirmed`), and any stored/published template whose HTML carries a bare `{{link}}` in a
text node, are affected. A relative `portalPath` value is never a link.

- Every message the portal sends has an HTML part in which **every destination is a real
  `<a href="https://…">`** and the plain-text part still carries the full URL on its own line.
- Render-time safety net (covers templates already stored on the owner's server): when the HTML part is
  produced, a bare `https://` URL in a text node that is not already inside `<a>` becomes an anchor whose text
  is the URL. Only URLs that pass the existing template URL check (`parseAllowedTemplateUrl`); never
  `javascript:`, `data:` or credentials in the URL; trailing punctuation stays outside the link; the scanner is
  linear (no backtracking regular expression on untrusted input); output escaped. `mailto:` only where a
  template author wrote it.
- Every shipped template with a link variable gets an HTML body with a labelled link or button
  (`data-rp-button`); relative portal paths are resolved against the canonical origin before rendering.
- A table-driven test renders **every registered template** with sample values and fails when a link variable
  does not appear as `href` in the HTML part, or the text part lacks the URL.
- Mail preview and test-send in the admin template editor use the same path.
- Portal UI: an e-mail address shown as contact information or as a person's address (customer detail, staff
  list, support/legal contact lines, invoice/receipt views) is a `mailto:` link through one shared component
  `EmailLink` in `client/src/ui` (ui_foundation_engineer builds it; each page owner uses it in their own
  paths). Long addresses wrap (`overflow-wrap: anywhere`); visible focus; no colour-only cue.

### D2 Trash, restore, permanent deletion, retention

#### D2.1 Words and states

- **Move to trash** (reversible) → **Restore** or **Delete permanently** (irreversible). "Trash" in the UI.
- `orders` and `users` gain (owners declare; all nullable): `trashed_at`, `trashed_by_user_id`,
  `trash_batch_id char(26)`, `trash_reason varchar(200)`, `purge_started_at`, `purged_at`; index on
  `(trashed_at, id)`. A row with `purged_at` set is a **tombstone**.
- No new order status and no new user status: trash is orthogonal, so restore returns the exact earlier state.

#### D2.2 Rules

- **Customers** (role `customer` only; staff and administrator accounts are out of scope and refused):
  move to trash only when `status = 'suspended'` (anything else → 409 `CUSTOMER_NOT_SUSPENDED` with the message
  "Suspend this account first."). All sessions and pending tokens are revoked. **All of the customer's orders
  move to trash in the same batch.** The e-mail address stays reserved while the account is in the trash.
  Restore → the account comes back **suspended** (an administrator reactivates it separately) and the orders of
  that batch come back. A trashed account cannot sign in, reset a password, be invited or be reactivated.
- **Orders**: any order may be moved to trash by an administrator. Moving a group root (increment 08) moves its
  additions in the same batch; an addition can be trashed and restored alone, but not restored while its root
  is in the trash. An order whose owner is in the trash cannot be restored on its own ("Restore the customer
  account first").
- Moving to trash never refunds and never changes anything at Stripe except cancelling open checkout attempts
  of that order (D2.5). The dialog says so when the order has payments.
- **Visibility**: a trashed or tombstoned order/customer is absent from every list, search, picker, count,
  report, dashboard, export to customers, public API v1 (404), notification, reminder, automation and mail.
  It is visible only in the Trash centre (and, for money already taken, see D2.6). Direct URLs return the
  ordinary not-found page/404 — the same answer as a row that never existed (no existence oracle for customers).
- **Order numbers and customer IDs are never reused** (existing reservations stay).
- Restore conflicts (for example the project now has the same packet in another live order, increment 08 rule)
  → 409 with a plain explanation; nothing is half-restored.

#### D2.3 Confirmations and permissions

- Move to trash: `trash.manage`; confirm dialog naming the item, what moves with it (counts from
  `summarize`), the date it will be deleted permanently under the current retention setting (or "kept until an
  administrator deletes it"), optional reason (≤ 200).
- Restore: `trash.manage`; confirm dialog naming the item and what returns with it.
- Delete permanently: `trash.purge` + fresh step-up; the administrator **types the order number or the
  customer ID** to enable the button; the dialog lists what is erased and what is kept (D2.6) and says it
  cannot be undone and that copies remain in backups until those backups expire.
- All dialogs: focus trapped, `Esc` cancels, focus returns to the trigger, destructive button is not the
  default, result announced through a live region, 24 px targets, both themes, 240 px.
- Every action is idempotent (idempotency key) and audited: `order.trashed`, `order.restored`,
  `order.purge_started`, `order.purged`, `customer.trashed`, `customer.restored`, `customer.purge_started`,
  `customer.purged`, `trash.retention_changed`, `trash.cleanup_completed` — actor, public ids, batch id, reason,
  counts; never names, e-mail addresses or content. SIEM catalogue entries for each.

#### D2.4 Retention clean-up

- Settings (`trash.retention.manage`, step-up, audited), in the Trash centre:
  `trash.autoPurge.enabled` (default **on**), `trash.retention.orderDays` (default 30) and
  `trash.retention.customerDays` (default 30), each 1–3650.
- Due date = `trashed_at` + the **current** setting (not frozen at trash time); shown on every trash row.
  Shortening retention shows how many items become due and needs the same confirmation as a permanent deletion.
- A scheduled job (hourly, single-flight, bounded batch, resumable) purges what is due, as the system actor,
  through exactly the same purge path. A customer's orders trashed with the account follow the account's date.
  Failures raise an operational alert and are retried; one failing item never blocks the others.
- Under maintenance mode / upgrade fencing the job does not run.

#### D2.5 Coordinator and participants (the contract in code)

`server/modules/trash/**` (recovery_ops_engineer) owns the coordinator, the registry, the settings, the tRPC
router, the job handler and the purge run table. Every other module takes part through this port
(`server/modules/trash/ports.ts`; recovery_ops_engineer publishes the file first, shape fixed here):

```ts
export type TrashEntityKind = "order" | "customer";
export interface TrashEntityRef { kind: TrashEntityKind; id: number | bigint; publicId: string; batchId: string }
export interface TrashParticipant {
  /** Module name, unique. */
  module: string;
  /** Inside the trash transaction. Stop what must not continue (open checkouts, queued deliveries, reminders,
   *  shares). Idempotent. Must not call external services (enqueue an outbox job instead). */
  onTrashedInTx?(tx: Tx, entity: TrashEntityRef, actor: TrashActor): Promise<void>;
  /** Inside the restore transaction. Throw a 409 AppError to veto with a plain message. Idempotent. */
  onRestoredInTx?(tx: Tx, entity: TrashEntityRef, actor: TrashActor): Promise<void>;
  /** Counts for the confirmation dialogs, e.g. { files: 12, messages: 3, paidInvoices: 1 }. No personal data. */
  summarize?(entity: TrashEntityRef): Promise<Record<string, number>>;
  /** Permanent deletion of THIS module's data for the entity. Runs outside one long transaction and may run
   *  again after a crash: idempotent and resumable. Return counts only. */
  purge?(entity: TrashEntityRef, run: { runId: string }): Promise<{ deleted: Record<string, number>; kept?: Record<string, number> }>;
}
// services.trash.register(participant) — call it from your module's init().
// services.trash.isTrashedOrderInTx / isTrashedCustomerInTx are NOT provided: the owners expose them (below).
```

- Order of a purge: coordinator sets `purge_started_at` (from here restore is refused) → every participant's
  `purge` (customers: each of the customer's orders first, then the account) → the owner module (orders /
  identity) turns the row into a tombstone last and sets `purged_at`. Any failure leaves `purge_started_at` set
  and the run `failed`; the job or an administrator retries. Runs are recorded
  (`trash_purge_runs`: public id, kind, entity public id, trigger `manual|retention`, status, per-module counts,
  timestamps, safe error code).
- Central gates (so most modules need no list changes):
  - orders_engineer: the order access resolver every module uses answers not-found for a trashed or tombstoned
    order for every principal and for the system actor, **except** the Trash centre read path; exposes
    `orders.isTrashedInTx(tx, orderId)` and a reusable SQL predicate for joins.
  - identity_engineer: session resolution, sign-in, password reset, invitations, SSO and every customer
    list/picker exclude trashed and tombstoned accounts; exposes `identity.users.isTrashedInTx(tx, userId)` and
    a reusable predicate.
  - Every module owner greps their own lists, counts, searches, jobs and exports that read orders or
    customers **without** going through those gates and applies the predicate.

#### D2.6 What permanent deletion erases and what it keeps

- **Erased**: the order's content and working data (project details, line working state, phase/stage progress,
  notes, messages, tickets tied to the order, files and recordings **including the stored objects and every
  storage copy the portal controls**, intake answers, questionnaires, acknowledgements tied to the order,
  grants, production payload copies, SharePoint mapping rows, cart references, automation run payloads). For a
  customer additionally: name parts, e-mail address, password hash, MFA factors, sessions, tokens, SSO links,
  billing profile, consent choices, community posts (removed or shown as "Deleted account"), referral links,
  API keys, notification preferences.
- **Kept, with no way back to a live record**: issued invoices and receipts with their own frozen snapshots,
  payment and refund records, policy acceptance log entries required as evidence, audit and security log
  entries, the order number and customer ID reservations. Unpaid, unissued or draft invoices of a purged order
  are voided (numbers are never reused or deleted). While an order is only **in the trash**: its unpaid invoices
  are hidden from the customer and cannot be paid; paid invoices and receipts stay available to the customer.
- **Tombstone**: the `orders` / `users` row stays so kept records still point at something, with `purged_at`
  set and every personal or free-text column overwritten (order: project name → `Deleted order`; user: e-mail
  → a non-routable unique placeholder and a new blind index so the address can register again, names →
  `Deleted account`, password/MFA/secret columns null, status `deactivated`). A tombstone never appears in any
  list, search or picker, cannot sign in and cannot be restored.
- Not touched, and the documents say so: objects at Stripe, folders already written to SharePoint or another
  external store the portal does not control, messages already delivered by mail, backups (they expire under
  the backup retention), SIEM copies.

#### D2.7 UI

- **Trash centre** `/admin/trash` (audit_engineer): tabs Orders and Customers; columns item, owner/customer ID,
  moved by, moved on, reason, deletes on, state (in trash / deleting / failed); filters (text, date range,
  moved by, due within N days), sort, pagination, bulk restore / bulk delete permanently (each with the same
  confirmation, typed word `DELETE <count>` for bulk), retention settings panel, last clean-up run and next due
  count, empty state, link from the admin navigation with a count badge. Mobile: cards, no horizontal scroll.
- Order detail (orders_engineer) and order list row action: **Move to trash**. Customer detail
  (identity_engineer): **Move to trash**, enabled only when suspended, otherwise disabled with the visible
  reason "Suspend this account first" (not a tooltip only).
- After moving: toast with **Undo** (restores, same permission) and return to the list.

### D3 New logo and brand files (ui_foundation_engineer; documents platform_engineer)

- Source of truth committed by `/root` under `docs/brand/master/`: the two 4096 px square lockups and
  `MASTER-ReadyPacketsBrandIdentity.zip` exactly as supplied (package 2026.10.15.2, "Document-Stack consistent
  full-lockup system"). Unpacked for reference at `/tmp/brandzip/2026-document-stack-complete-identity/` (read
  `docs/LOGO_USAGE.md`, `docs/DIGITAL_SYSTEM.md`, `docs/BRAND_ROLLOUT.md`, `platform-and-print-exports/README.md`).
- The owner asked for the **square full lockup** as the logo. Use it wherever a logo is shown and a square
  lockup is legible: sign-in / registration / all auth pages, public and legal pages, sidebar brand tile of the
  customer and console shells, error / offline / maintenance pages, launch and install surfaces, social share
  image. Where the space is a narrow bar (mobile top bar, compact header) use the **horizontal full lockup of
  the same package** (the package's own rule) — never a redrawn, recoloured or re-typeset logo, never CSS
  filters; matching light/dark file by resolved theme. Icon-only artwork only in the forced technical slots
  (favicon 16/32/48, maskable PWA icon, Apple touch icon) from `utility-icons-only/`.
- Ship web-sized derivatives (SVG where the package supplies one, plus PNG fallbacks at the sizes used; no
  4096 px file is served to browsers), explicit `width`/`height` (no layout shift), same origin, long cache with
  hashed or versioned names so the old logo is not served from cache or the service worker; update
  `shared/brand.ts` (assets, tagline now `Your Business, Professionally Packeted!™`, accessible name
  `ReadyPackets — Your Business, Professionally Packeted`), `manifest.webmanifest`, `favicon.ico`, Open Graph /
  Twitter / JSON-LD logo, offline page, PWA precache list. Remove the superseded `readypackets-approved-*` files
  from live paths once nothing references them.
- Mail header/footer and invoice / receipt PDFs (jobs_engineer, compliance_engineer): where a logo is shown
  today, switch to the horizontal full lockup of the new package (light); where none is shown, add none.
- Forced-colours mode and dark panels keep working (`.rp-brand-on-dark`); contrast of the dark lockup on the
  navy surface and the light lockup on white checked; logo link has a name; decorative duplicates `alt=""`.
- `docs/brand/BRAND_GUIDE.md` rewritten for the new package (platform_engineer), including the note that the
  package README calls itself a production candidate and that the owner supplied it for use on 2026-11-27.

### D4 Documents (platform_engineer; checklist assurance_engineer)

Session log for prompts 35–37, `STATUS`, `CHANGELOG`, `APPLICATION_CONTEXT`, upgrade notes (this increment HAS a
database migration), administrator guide for the Trash centre (what is erased / kept, backups, Stripe,
SharePoint), privacy/retention notes, go-live checklist rows (mail link per template family, trash → restore →
permanent deletion for an order and a customer, retention job, logo in both themes), security review record.

## 2. Owners

| Package | Owner | Paths |
|---|---|---|
| Mail links, mail logo, mail templates, reminders skip trash, clean-up job schedule | jobs_engineer | `server/modules/jobs/**`, `server/modules/mailTemplates/**`, `server/modules/opsAlerts/**` |
| Trash coordinator, registry, settings, router, job handler, purge runs; cart | recovery_ops_engineer | `server/modules/trash/**`, `server/modules/cart/**`, `client/src/features/cart/**` |
| Trash centre UI; audit event categories | audit_engineer | `client/src/features/trash/**`, `server/modules/audit/**` |
| Customers: columns, trash/restore/tombstone, gates, customer detail action | identity_engineer | `server/modules/identity/**`, `client/src/features/identity/**`, `client/src/features/auth/**` |
| Orders: columns, trash/restore/tombstone, access gate, group rules, order pages | orders_engineer | `server/modules/orders/**`, `client/src/features/orders/**` |
| Files, recordings, archives, storage copies | files_engineer | `server/modules/files/**`, `server/modules/storage/**`, `client/src/features/files/**` |
| Invoices, receipts, intake, policies, billing profile; PDF logo | compliance_engineer | `server/modules/compliance/**`, `server/modules/billingProfile/**`, their client features |
| Payments, production webhooks, SharePoint | integrations_engineer | `server/modules/payments/**`, `server/modules/integrations/**`, `server/modules/sharepoint/**`, their client features |
| Messages, tickets, notifications, community, knowledge | engagement_engineer | `server/modules/engagement/**`, `server/modules/community/**`, `server/modules/knowledge/**`, their client features |
| SIEM catalogue, promotions, referrals, reports, public API, automations | siem_engineer | `server/modules/siem/**`, `promotions/**`, `referrals/**`, `reports/**`, `publicApi/**`, `automations/**`, their client features |
| Export / import / backup coverage of trash state and tombstones | portable_contract_engineer | `server/modules/portable/**`, `portable/**`, `server/modules/backup/**` |
| Logo, brand assets, `EmailLink`, shells, public pages | ui_foundation_engineer | `client/public/**`, `client/src/ui/**`, `client/src/app/shell/**`, `shared/brand.ts`, `client/index.html`, public/legal page layouts |
| Checklist, accessibility review of new UI, assurance module | assurance_engineer | `docs/operations/GO_LIVE_CHECKLIST.md`, `server/modules/assurance/**` |
| Documents, session log, brand guide; platform and protection modules | platform_engineer | `docs/**` except the checklist and this contract, `server/modules/platform/**`, `server/modules/protection/**` |
| Security review of the increment | http_security_engineer | findings to owners and `/root` |
| QA sweep routes, isolation probes for the new procedures | portable_ops_engineer | `scripts/qa/**`, `tests/integration/**` |

If a module you own reads orders or customers and is not named in your row, it is still yours to check. If a
path listed here was another peer's in an earlier increment, the row above wins for this increment.

## 3. Definition of done

Type check, eslint and the touched test files pass; every new write is permission-checked, audited and
idempotent; no new personal data in logs; both themes; no overflow 240–1440 px; axe WCAG 2.2 AA tags clean on
changed routes; documents updated; `/root` has verified the behaviour on the QA server.
