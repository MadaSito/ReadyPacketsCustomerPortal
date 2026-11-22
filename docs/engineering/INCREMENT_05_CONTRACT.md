# Increment 05 — workflow transfer, cart upsell, discount codes, policy acceptance log centre

Owner request (2026-11-22, prompt 21):

1. Workflows can be exported individually, as a selection, or all, and imported into another ReadyPackets
   Portal.
2. Upsell in the cart.
3. A discount code system for orders: the administrator gives out codes or links with expiration and other
   controls that minimise abuse.
4. A policy acceptance log centre that tracks each customer's acceptance of a policy and of policy updates.
   It also shows on the customer's profile in the admin portal.

`BUILD_CONTRACT.md` and `INCREMENT_04_CONTRACT.md` still govern everything (module shape, ownership checks,
audit, safe errors, step-up, idempotency, WCAG 2.2 AA in both themes, 320 px, strict inputs, public ids only
across the wire, no secrets or personal data in logs). This file adds only what increment 05 needs.

## 0. Working rules

- Branch `feat/increment-05` is checked out in the shared tree. Nobody switches branches or pushes.
- Commit only your own paths with `scripts/dev/commit.sh "<message>" <paths>` (it adds the required trailer).
- Never build or start servers (only `/root` and ui_foundation_engineer do). Verify with the FULL
  `pnpm typecheck` (`scripts/dev/tc.sh`), `pnpm exec eslint <your paths> --max-warnings 0`, and your tests
  one file at a time with `scripts/dev/test.sh <file>`.
- `/root` generates `migrations/0005_increment_05.sql` once. Additive only (installed sites are upgraded in
  place): new tables, new nullable columns or columns with defaults, new indexes. Declare your tables in
  your module's `schema.ts`, then report "schema final" to `/root`. Do not run `drizzle-kit`.
- Capabilities are already added by `/root` (see `shared/capabilities.ts`, block "increment 05").
- New server modules are mounted by `/root` in `server/trpc/root.ts` and `server/container.ts`; new client
  features in `client/src/app/registry.ts`. Tell `/root` the export names when the module compiles.
- No new dependencies. Ask `/root` first if you believe one is needed.
- Every feature is off by default behind a setting, switching it on is audited, and nothing breaks when it
  is off. Exception: the acceptance log centre is a read view over existing evidence and is always on.
- Reports to `/root`: done / commits / not done / needs — at most 150 words. Publish interfaces in your
  module's `API.md`; keep messages to other owners short.

## 1. Decisions

### D1. Workflow export and import (ADR 0042)

- **Package.** One JSON document, media type `application/json`, file name
  `readypackets-workflows-<yyyymmdd-hhmm>.json`:
  `{ format: "readypackets.workflows", formatVersion: 1, exportedAt, source: { release, label }, workflows:
  [...], references: { policies: [...] }, integrity: { algorithm: "sha256", digest } }`.
  The digest covers the canonical JSON (sorted keys, UTF-8) of `workflows` and `references`. It detects
  damage and accidental edits. It is not a signature and is never treated as proof of origin.
- **Per workflow:** key, name, description, the current published definition (states, transitions, phases,
  requirements, acceptance gates, storage folder template) and the designer layout. A workflow that has
  never been published exports its latest draft and is flagged `unpublished: true`. No order data, no
  customer data, no user ids, no numeric database ids, no secrets.
- **References.** Anything in a definition that points to an object of this installation (acceptance gates
  → policy public id; anything else the owner of the module finds) is exported with a portable identifier
  (policy slug, title, audience). Automations bound to workflow steps are not part of the package
  (documented limit).
- **Export.** One workflow (row action), a selection (checkboxes + "Export selected"), or all ("Export
  all"). Capability `workflows.export`. Audit `workflow.exported` (keys, count, digest).
- **Import.** Two steps, both stateless on the server (the client sends the package again with the
  decisions; the server validates everything again):
  1. `preview`: size limit 2 MB, at most 50 workflows, strict schema (`workflowDefinitionSchema` and the
     designer validator — the same rules as publishing), digest check, format version check. Returns a
     plan per workflow: valid / invalid with field-level findings, whether a workflow with the same key
     exists, and the list of references with their resolution (matched by slug / not found).
  2. `applyImport` (tRPC reserves the name `apply`): for each workflow the administrator chooses **Create as new workflow** (key made unique,
     name kept), **Add as a draft of the existing workflow**, or **Skip**; every unresolved reference must
     be mapped to a local policy or the gate removed explicitly. Idempotency key required.
- **Imported workflows are always drafts.** Nothing is published, no default is changed and no existing
  order is touched by an import. The administrator reviews and publishes in the designer as usual.
- Capability `workflows.import` (administrators, step-up). Audit `workflow.import_previewed` (digest,
  counts) and `workflow.imported` (digest, source label, outcome per key). A wrong digest is a blocking
  error with a plain message; "import anyway" is not offered.
- Transport: the two import procedures are called without batching and have their own request body limit
  (4 MiB plus a 256 KiB envelope) in the application and in the reverse proxy; every other route keeps
  the general 256 KiB limit.
- The package is untrusted input: parse with a depth and size guard, reject unknown keys, never `eval`,
  never use a value as an object key without the own-property check, never render imported text as HTML.

### D2. Cart upsell (ADR 0043)

- Setting `feature.cart.upsell` (off by default; needs `feature.cart`).
- **Offers** (cart-owned table): kind `add_on` (suggest a product when trigger products are in the cart),
  `tier_upgrade` (replace a packet's tier with a higher tier of the same packet), plus the automatic
  **bundle completion** suggestion derived from the bundle rule ("Add Packets 3 and 5 to save 15%", with
  the computed saving). Fields: title, short text (plain text, 200 characters), trigger products or "any
  cart", target product, priority, active, optional start and end time.
- The server computes at most three suggestions with the cart (`cart.get` → `upsells`), each with server
  prices: target product, price, and for an upgrade the price difference. It never suggests what is
  already in the cart, an inactive product, or a selection that breaks the packet rules.
- `cart.upsell.accept({ offerPublicId, idempotencyKey })` adds the target or swaps the tier atomically at
  the server price and returns the new cart. `cart.upsell.dismiss` hides an offer for this cart.
- Nothing is ever added without the customer's action. No countdown timers, no pre-ticked boxes, no
  "confirm-shaming" wording. The suggestion block is a labelled region after the cart lines, each card
  has a heading, the price in text, and one button with a specific accessible name ("Add Packet 3 Standard
  for $499.00"). Changes are announced through the existing live region.
- Admin page "Cart suggestions" (capability `carts.upsells.manage`, administrators): list, create, edit,
  activate / deactivate, delete, and counters shown / accepted / dismissed per offer. Audit
  `cart.upsell_offer.created|updated|activated|deactivated|deleted` and `cart.upsell.accepted`.

### D3. Discount codes (ADR 0044)

- New module `server/modules/promotions`, client `client/src/features/promotions`. Setting
  `feature.promotions` (off by default).
- **Code definition:** internal name, customer-facing label (shown on the order and invoice instead of the
  code), type `percent` (0.01–100 %, optional maximum discount amount) or `fixed` (amount + currency),
  scope (all products / chosen products / tiers / packet numbers), minimum subtotal, start and end time,
  maximum redemptions in total, maximum per customer (default 1), first order only, allow-list of
  customers or e-mail domains, "may be combined with the bundle discount" (default no: the customer gets
  the larger of the two, never both), status `active | paused | revoked` (+ derived `scheduled`,
  `expired`, `exhausted`), note.
- **Codes.** Chosen by the administrator (6–32 characters, A–Z 0–9 and hyphen, normalised to upper case)
  or generated. **Batches**: up to 5,000 single-use codes from the CSPRNG, alphabet without ambiguous
  characters, at least 12 characters after an optional prefix. Lookup by a keyed hash of the normalised
  code; the value itself is stored with the existing field encryption so it can be shown again to an
  administrator. Staff with `promotions.read` see masked codes.
- **Links.** "Copy link" produces a portal link that carries the code in the URL fragment, so it does not
  reach server access logs or referrers. Opening it stores the code for this browser session (session
  storage, not a cookie), shows "Code saved — it is applied when you place an order", survives sign-in
  and registration, and is offered in the cart and the order wizard. A link never applies anything
  silently and never bypasses a rule.
- **Global guard.** Setting "Largest discount per order" (default 50 %, changeable by an administrator
  with step-up, up to 100 %). The combined discount of an order never exceeds the guard and the total is
  never negative.
- **Pricing.** Bundle discount first (existing rule). Then the code: percent of the eligible lines'
  amount (after the bundle discount when combining is allowed), round half up, integer minor units; fixed
  amount capped at the eligible amount. When combining is not allowed the larger of bundle and code wins
  and the other is not applied. Tax is computed after discounts (existing behaviour).
- **Redemption is atomic** and happens inside the order-creation transaction through the port in §3: the
  code row is locked, the limits are counted, the redemption row is written, and the order is created
  with the final figures — or nothing is written. A unique key on (code, order) and on (code, customer,
  sequence) prevents double use under concurrency. A redemption is released (and the counters restored)
  when the order is cancelled before payment. It stays used after a refund.
- **Abuse controls.** Rate limit per account and per address on every code check; after 5 failed checks in
  15 minutes the account is paused from checking codes for 15 minutes (audit `promotion.attempts_blocked`,
  severity warning, so it reaches SIEM). One uniform message — "This code cannot be applied." — for unknown,
  paused, revoked, not started, expired, exhausted and "not for this account". Messages about the cart
  ("Add $20.00 more to use this code") appear only for a code this customer is entitled to. E-mail must be
  verified. Staff and administrators cannot redeem for themselves. The code is never written to logs;
  audit events carry the code's public id and label.
- **Where.** Cart (apply / remove, shown in totals and at checkout) and the direct order wizard (same
  component). Staff creating an order for a customer may enter a code; eligibility is judged for the
  customer. API v1 order creation does not accept codes in this increment (documented).
- If a code stops being valid between applying and placing the order, the order is not placed; the
  customer sees the new total and confirms again.
- **Admin pages** (capability `promotions.read` for staff and administrators, `promotions.manage` for
  administrators with step-up): list with filters (status, type, ending soon), create / edit, generate
  batch, copy code / link, pause / resume / revoke, redemptions per code and across codes, totals
  (redemptions, discount given), CSV export of codes and redemptions (formula-safe, step-up, audited).
- Audit: `promotion.created|updated|paused|resumed|revoked|batch_generated|exported`,
  `promotion.redeemed`, `promotion.released`, `promotion.attempts_blocked`.

### D4. Policy acceptance log centre (ADR 0045)

- Read view over the append-only evidence that already exists: account and checkout acceptances
  (`policy_acceptances`) and order gate acceptances (`order_policy_acceptances`). No evidence row is ever
  changed or deleted by this feature.
- **Admin page "Policy acceptances"** with three tabs:
  1. **Log** — every acceptance, newest first: time, customer (name, customer ID, e-mail), policy, version,
     short content hash, "current" or "superseded by version n", source (registration / re-acceptance /
     checkout / order gate), method (tick box / typed name), order reference, address pseudonym,
     correlation id. Filters: customer, policy, version, date range, source, method, current or
     superseded, order reference. Cursor pagination. A detail dialog shows the complete evidence record.
  2. **Coverage** — for each published policy that requires acceptance: current version and publication
     date, number of customers who accepted it, number outstanding, and the list of outstanding customers
     with the version they last accepted.
  3. **Policy updates** — every published version: policy, version, publication time, change summary,
     published by, and how many customers have accepted it since.
- **Customer profile → "Policies" tab** (through `customerTabs`): status per policy (accepted current
  version / update not yet accepted / not required) and the customer's full acceptance history, with a
  link to the exact text of each accepted version.
- Capabilities: `policies.acceptances.read` (staff and administrators), `policies.acceptances.export`
  (administrators, step-up). CSV export of the filtered log with a row limit, formula-safe cells, audit
  `policy.acceptance_log.exported` (filter summary, row count). Typed signer names stay encrypted and are
  shown only in the detail dialog to holders of `policies.manage`.
- All times stored in UTC and shown in the viewer's time zone with the UTC value available.

## 2. Packages and owners

| Package | Owner | Paths |
| --- | --- | --- |
| A1 workflow transfer, server | orders_engineer | `server/modules/orders/workflowTransfer*.ts`, router, tests, `API.md` |
| A2 workflow transfer, client | files_engineer | `client/src/features/orders/pages/workflows/**` (export / import UI only) |
| B cart upsell, server and client; code entry in the cart | recovery_ops_engineer | `server/modules/cart/**`, `client/src/features/cart/**` |
| C1 promotions module, server | siem_engineer | `server/modules/promotions/**` |
| C2 promotions, client (admin pages, shared `PromoCodeField`, link landing) | audit_engineer | `client/src/features/promotions/**` |
| C3 order pricing hook and order wizard code entry | orders_engineer | `server/modules/orders/{ports,orderService,pricing,schema,router}.ts`, order wizard page |
| C4 invoices show the code discount line | compliance_engineer | `server/modules/compliance/invoices*`, invoice views |
| D1 acceptance log, server | compliance_engineer (read port for order gates with identity_engineer) | `server/modules/compliance/**` |
| D2 acceptance log, client and customer tab | engagement_engineer | `client/src/features/compliance/pages/acceptances/**`, `customerTabs` entry |
| E whole-data export / import and backups cover the new tables | portable_contract_engineer | `server/modules/portable/**` |
| F upgrade job, installer and CI know migration 0005 | portable_ops_engineer | `deploy/**`, `.github/**`, `docs/operations/UPGRADE.md` |
| G security review and abuse tests | http_security_engineer | review notes in `docs/security/`, tests in owners' folders by agreement |
| H accessibility review (axe, keyboard, 320 px, both themes) | assurance_engineer | client tests, findings to owners |
| I shared components and browser verification in the QA environment | ui_foundation_engineer | shared UI, QA scripts |
| J ADRs 0042–0045, administrator guide, customer help, CHANGELOG | platform_engineer | `docs/**` |
| K migration, capabilities, mounting, integration, release | /root | `migrations/**`, `shared/capabilities.ts`, registries |

## 3. Ports (signatures are binding; owners may add optional fields)

```ts
// server/modules/promotions — exposed on services.promotions; orders reaches it through orders/ports.ts
interface PromotionLine { productPublicId: string; packetNumber: number | null; tierKey: string | null; lineTotalMinor: number }
interface PromotionContext {
  code: string;                 // raw input; normalised by promotions
  customerUserId: number;       // the order owner, not the actor
  actorUserId: number;
  currency: string;
  lines: readonly PromotionLine[];
  subtotalMinor: number;
  bundleDiscountMinor: number;  // 0 when the bundle rule did not apply
  bundleLabel: string | null;
}
interface PromotionOutcome {
  promoPublicId: string;
  label: string;                // customer-facing label
  promoDiscountMinor: number;   // the part due to the code
  bundleDiscountMinor: number;  // may be 0 when the code replaced the bundle discount
  discountMinor: number;        // total discount to store on the order
  discountLabel: string;        // combined label for order and invoice
  totalMinor: number;
}
// Read-only preview for quotes and cart totals. Rate limited by the caller's session. Throws the uniform
// validation error PROMO_NOT_APPLICABLE, or a cart-specific one (PROMO_MIN_SUBTOTAL, PROMO_NOT_ELIGIBLE_ITEMS).
preview(ctx: PromotionContext, opts?: { tx?: DbOrTx }): Promise<PromotionOutcome>;
// Inside the order-creation transaction, before the order row is inserted. Locks the code row, checks every
// limit again, writes the redemption for `orderPublicId`. Throws as above; the caller's transaction rolls back.
redeemInTx(tx: Tx, ctx: PromotionContext & { orderPublicId: string; correlationId: string }): Promise<PromotionOutcome>;
// Called by orders when an order is cancelled before payment. Idempotent.
releaseForOrderInTx(tx: Tx, input: { orderPublicId: string; reason: "order_cancelled" }): Promise<{ released: boolean }>;
```

- Orders: `create`, `createOrderFromCheckoutInTx` and `quote` accept an optional `promoCode`. A procedure
  that carries a code is always a POST (mutation), never a GET query, so the code is not part of a URL. When
  `feature.promotions` is off or the module is absent the field is rejected with the uniform error.
  New order columns `promo_discount_minor` (int, default 0) and `promo_label` (nullable). `discount_minor`
  and `discount_label` remain the totals that every existing reader uses.
- Cart: stores the applied code reference on the cart (encrypted value or promotion public id — the cart
  owner decides with the promotions owner), re-evaluates through `preview` whenever totals are computed,
  and passes the code to `createOrderFromCheckoutInTx`.
- Compliance (acceptance log) reads order gate evidence through one read function agreed with
  identity_engineer; customers are resolved through the identity port (name, customer ID, e-mail).

## 4. Abuse cases every owner tests

- Another customer's cart, order, code allow-list or acceptance record is never reachable (IDOR): not found.
- Concurrent checkouts with the last remaining redemption: exactly one succeeds.
- Replay of `apply` / `accept` / `redeem` with the same idempotency key: one effect.
- Client-supplied prices, discounts, labels, totals or product ids of inactive products: ignored / rejected.
- Code guessing: rate limit, pause and uniform message as in D3; timing does not reveal existence beyond
  what the message does.
- Import package: oversized, deeply nested, wrong digest, unknown keys, `__proto__` / `constructor` keys,
  duplicate workflow keys, 51 workflows, HTML or script in names, references to unknown policies.
- CSV exports: cells that start with `= + - @` or a tab are neutralised.
- A staff account without the capability gets FORBIDDEN from every new procedure; a customer gets NOT_FOUND
  on admin procedures as elsewhere.

## 5. Definition of done (each owner)

1. `pnpm typecheck` clean, ESLint clean, your tests green one file at a time.
2. Tests: authorisation matrix (anonymous / customer / other customer / staff / administrator), validation,
   the abuse cases of §4 that apply, and an axe check per new page or dialog in both themes.
3. `API.md` and `VERIFICATION.md` updated (what you ran, what was only tested against fakes, what is not
   verified), an administrator-guide section and, where customers see the feature, a help article draft.
4. Works at 320 px and in dark mode; no information in colour only; every control has an accessible name;
   focus is managed in dialogs; status changes are announced.
5. Report to `/root` (≤150 words). Schema owners: "schema final" as early as possible.
