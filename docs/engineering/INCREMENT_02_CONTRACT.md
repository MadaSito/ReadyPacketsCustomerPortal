# Increment 02 — Offerings matrix and production webhooks (team contract)

Owner input received during session 01 (after the first build was integrated):

- `docs/source-specs/increment-02/PRODUCT_MATRIX_v3.0.md` — Master Offerings Matrix v3.0
- `docs/source-specs/increment-02/P101_PRODUCTION_WEBHOOK_LOGIC_CORRECTED.txt` — P101 payload rules (corrected)
- `docs/source-specs/increment-02/WEBHOOK_TRIGGER_REFERENCE_P101_P201.txt` — P101 / P201 trigger reference

`BUILD_CONTRACT.md` still governs everything (ownership, authorization, audit, errors, tx/lock rules,
client conventions). This file only adds what the two features need so engineers can work in parallel.
Only `/root` and ui_foundation run builds or browsers. Run one test file at a time. Commit with
`scripts/dev/commit.sh`. Do not create migrations: `/root` generates `migrations/0001_*.sql` once after the
schema changes land. Tell `/root` when your schema is final.

## Decisions (ADR 0022, ADR 0023 — written by /root)

1. The catalog stays owner-controlled, versioned data. The matrix is shipped as a data file and loaded by an
   explicit, audited operator command. Nothing about packets or prices is hardcoded in application logic.
2. Packets 1–6 each have the tiers Basic, Standard and Premium. They are products.
3. Packet 7 is not a product. It is what an order is called when it contains more than one packet. A bundle
   rule (data, not code) gives 15% off when all six packets are in the order.
4. Packet 8 is NOT loaded. The master prompt forbids restoring it and the matrix itself marks it unlisted.
   The data file records it under `reserved` for the record only. The internal "Architect's Legacy Note"
   appendix is never shown to customers.
5. Where the two webhook documents disagree, the CORRECTED P101 document wins: `order_scope_mode` is never
   sent.
6. P101 and P201 are manual staff actions (the documents call them manual webhooks). No automatic trigger
   and no inbound callback in this increment — the documents define neither.
7. The feature is off until an administrator configures it. No live URL, secret or canon version ships as a
   default.

## A. Catalog data (owner: portable_contract_engineer)

`data/catalog/readypackets-offerings-v3.0.json`, validated by `data/catalog/offerings.schema.json`:

```jsonc
{
  "schema": "readypackets.offerings/1",
  "matrixVersion": "3.0",
  "currency": "USD",
  "packets": [
    {
      "packetNumber": 1,
      "groupKey": "packet-1",
      "name": "Idea & IP Protection",
      "tiers": [
        {
          "tier": "Basic",                      // "Basic" | "Standard" | "Premium"
          "productKey": "packet-1-basic",
          "name": "Idea & IP Protection — Basic",
          "priceMinor": 45000,
          "outcome": "…",                       // verbatim from the matrix
          "timeline": "48-72 hours",            // verbatim
          "includesTier": null,                 // "Basic" for Standard, "Standard" for Premium
          "deliverables": [{ "title": "…", "detail": "…" }]
        }
      ]
    }
  ],
  "bundle": {
    "packetNumber": 7,
    "name": "The All-In (Master Bundle)",
    "tierLabel": "The Premium Vault",
    "requiredPacketNumbers": [1, 2, 3, 4, 5, 6],
    "discountPercent": 15,
    "outcome": "…", "timeline": "30–45 Business Days",
    "points": [{ "title": "…", "detail": "…" }]
  },
  "reserved": [{ "packetNumber": 8, "name": "Capital & Valuation Services", "listed": false, "reason": "…" }]
}
```

Text is copied verbatim from the matrix (fix only markdown artefacts). A test checks: 6 packets × 3 tiers,
the 18 prices against a table typed independently from the source, unique product keys, schema validity.

`scripts/ops/catalog-import.ts` (+ `dist/ops/catalog-import.js` in the build, `pnpm ops:catalog-import`):
`--file <path>` (default the file above), `--dry-run`, idempotent by `productKey` / `groupKey`. It goes
through the orders catalog service as an audited ops session (same pattern as `scripts/ops/seed-demo.ts`):
creates missing groups and products, writes a new product version only when content differs, stores the
bundle rule, prints a summary. Never deletes. Refuses a file that fails the schema.

## B. Orders (owner: orders_engineer)

Schema (final names; tell /root when done):

- `catalog_groups`: `group_key varchar(64) null unique`, `packet_number tinyint unsigned null unique`.
- `catalog_products`: `packet_number tinyint unsigned null`, `tier enum('Basic','Standard','Premium') null`,
  unique `(packet_number, tier)`. Both null for non-packet products; both set or both null.
- `catalog_product_versions`: `outcome varchar(1000) not null default ''`, `timeline varchar(120) not null
  default ''`, `deliverables json not null` (`{title, detail}[]`; `features` stays = the titles).
- `order_line_items`: snapshot `packet_number`, `tier`, `outcome`, `timeline`, `deliverables`.
- `orders`: `subtotal_minor`, `discount_minor` (default 0), `discount_label varchar(120) null`;
  `total_minor = subtotal_minor - discount_minor`.

Service:

- `catalog.createGroup/createProduct/updateProduct` accept the new fields (`groupKey`, `packetNumber`,
  `tier`, `outcome`, `timeline`, `deliverables`); views return them. Add `catalog.upsertFromOfferings` only
  if it makes the import simpler — otherwise the import script composes the existing calls.
- Bundle rule lives in an orders setting (`orders.bundle_rule`): `{ enabled, requiredPacketNumbers,
  discountPercent, label }`; admin-editable with audit; default disabled until imported.
- Order creation rules for packet products, enforced on the server: quantity is exactly 1; at most one tier
  per packet in an order. Discount is computed on the server from the rule; the client never sends amounts.
- New service method for other modules (called in the caller's transaction):
  `orders.getProductionScope(orderId: number, opts?: { tx?: DbOrTx }) → { orderId, orderPublicId, reference,
  ownerUserId, statusKey, lockState, origin, packets: { packetNumber: number; tier: "Basic" | "Standard" |
  "Premium" }[], otherItemCount: number } | null`.
- Portable export/import: carry the new fields; coordinate with portable_contract_engineer on the v3 schema.

Client (`client/src/features/orders/**`):

- Admin catalog: show and edit packet number, tier, outcome, timeline, deliverables.
- Order detail (customer and console): show tier, outcome, timeline and deliverables per item; show subtotal,
  discount and total when a discount exists.
- The customer packet picker in the new-order wizard is built by ui_foundation_engineer in
  `client/src/features/orders/customer/packets/**` against your catalog list output. Agree the exact output
  type with them first and export it.

## C. Customer packet picker (owner: ui_foundation_engineer)

Step 1 of the new-order wizard when the catalog has packet products: one card per packet (name, short
description), a three-way tier choice per packet (radio group: not included / Basic / Standard / Premium)
with price, outcome, timeline and an expandable deliverables list ("Everything in Basic, plus:" for the
higher tiers). Running summary: selected packets, subtotal, bundle hint ("Add all six packets for 15% off")
and the discount when it applies — displayed amounts come from a server quote call, not client arithmetic.
Works at 320 px, keyboard-only and with screen readers (fieldset/legend, radio semantics, live region for
the summary). Non-packet products keep the existing picker.

## D. Production webhooks (owner: integrations_engineer; UI partner: siem_engineer; reviewer: http_security_engineer)

Server, in `server/modules/integrations/production/**`:

Settings (admin, `integrations.manage`, step-up to change, audited, secrets encrypted with field crypto and
never returned): `enabled` (default false), `p101Url`, `p201Url` (https only; the URL is treated as a secret
because webhook URLs embed a token — return only host + last 4 characters), optional auth header name +
value, `canonVersion` (required before enabling; no default), `runMode` (default `production`,
`^[a-z][a-z0-9_]{0,31}$`), timeout (default 10 s, max 30 s). Destinations go through the existing egress
policy with purpose `webhook`: allow-list rule required, https only, pinned resolution, no redirects.

Payload (pure functions with exhaustive tests taken row by row from the two documents):

```
P101 = { customer_id, order_id, packet, tier, canon_version, run_mode, client_name, client_email,
         release_status, bundle_scope_manifest }
P201 = { customer_id, order_id, run_mode }
```

- Every value is a string. `bundle_scope_manifest` is a JSON *string* (`"{\"packet_1\":\"Premium\"}"`), keys
  `packet_<n>` in ascending order, values `Basic|Standard|Premium`.
- One packet in the order → `packet` = that number, `tier` = that tier. More than one → `packet` = `"7"`,
  `tier` = `"Mixed"`.
- `validateP101` rejects, before anything is queued: 7 without Mixed, Mixed without 7, 7/Mixed with a
  single-entry manifest, single packet whose manifest differs from packet/tier, missing/invalid manifest,
  an empty manifest, unknown tiers, packet numbers outside 1–6 in the manifest, any `order_scope_mode` key.
- `customer_id` = the customer's reference (`users.customer_ref`); `order_id` = the order reference at the
  time of P101; `client_name` / `client_email` = the order owner's name and email; `release_status` =
  optional operator label (`^[A-Za-z0-9_.-]{0,120}$`, default empty).
- An order with no packet items, or with any non-packet item, cannot be sent (clear refusal).
- P201 copies `customer_id`, `order_id` and `run_mode` from the stored, successfully delivered P101 record
  of the same order — never recomputed (a later reference change must not break the run).

Dispatch: a table `integration_production_dispatches` (order, phase `P101|P201`, state `queued|sending|
delivered|failed|dead`, attempt count, idempotency key, payload SHA-256, the identity triple sent, safe
response summary: HTTP status + up to 200 chars, requested-by, timestamps, correlation id). The payload body
with personal data is stored encrypted for the retry window only and cleared once the dispatch is final.
Written in the same transaction as the request (outbox), delivered by a job (ask jobs_engineer for the
handler registration), bounded retries with backoff on network errors / 5xx / 429, no retry on other 4xx.
Headers: `Content-Type: application/json`, `Idempotency-Key`, `X-ReadyPackets-Delivery`, correlation id.
One delivered P101 per order and one delivered P201 per order; re-sending needs admin + step-up + a reason.
P201 can be requested only when a P101 for that order is `delivered`, and the request must carry an explicit
operator confirmation that the Phase I artifacts exist (the portal cannot see them).

Authorization: new capability `orders.production.trigger` (staff and admin) for requesting P101 / P201 and
reading an order's dispatch history; re-send is admin + step-up; settings are `integrations.manage`.
(`/root` adds the capability to `shared/capabilities.ts` on request — send the exact lines.)

Audit (durable, in-tx): `integration.production.settings.changed`, `…dispatch.requested`,
`…dispatch.delivered`, `…dispatch.failed`, `…dispatch.dead`, `…dispatch.resent`, `…dispatch.refused`
(validation). Attributes carry phase, order public id, packet/tier, manifest, HTTP status — never the URL,
the auth header, the client name or email.

Router (tRPC, `integrations.production.*`): `settings.get`, `settings.update`, `settings.test` (dry run:
resolves and validates the destination through the egress policy and returns the result; sends nothing),
`order.preview` (payload that would be sent + validation result, client name/email masked for staff),
`order.requestP101`, `order.requestP201`, `order.resend`, `order.history`, `admin.listDispatches` (filters:
phase, state, order reference, date).

Client (siem_engineer, in `client/src/features/integrations/production/**`): admin page "Production
pipeline" under Integrations (settings form, destination test, dispatch list with filters) and a console-only
order tab "Production" (state of Phase I and Phase II, payload preview, "Start Phase I", "Start Phase II"
with the confirmation checkbox, history, re-send for admins). Customers never see the tab.

Docs (integrations_engineer): `docs/integrations/PRODUCTION_WEBHOOKS.md` (setup, payload rules, failure
handling, what is not verified), `server/modules/integrations/API.md`, `VERIFICATION.md`.

## E. Documents (owner: compliance_engineer)

Draft privacy notice: add the production pipeline as a recipient of order metadata, client name and email
when an order is started. Admin and staff guides: catalog import, bundle rule, starting Phase I / Phase II.
