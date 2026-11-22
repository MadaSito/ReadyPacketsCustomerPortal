# Increment 04, part B — console order workspace

Owner request (2026-11-21, prompt 19, with eight screenshots of the previous system's console order page):

1. See and start the Production Pipeline integrations from each order, as on the previous platform.
2. An order history, and a SharePoint sync view of the order's files.
3. A Refund button and refund capability on each order.
4. An acceptance gateway based on a policy.
5. Rename an order.
6. Order files sync to SharePoint after upload or audio recording; the destination folder of the uploads is
   configurable in the order workflow configuration.
7. Afterwards: the commands to update the installed site.

`BUILD_CONTRACT.md` and `INCREMENT_04_CONTRACT.md` still govern everything (module shape, ownership checks,
audit, safe errors, step-up, idempotency, WCAG 2.2 AA in both themes, 320 px, no new dependencies without
asking `/root`). This file adds only what part B needs. Same branch (`feat/increment-04`), same shared
working tree: commit only your own paths with `scripts/dev/commit.sh`, never build or start servers
(only `/root` and ui_foundation_engineer do), verify with the FULL `pnpm typecheck` (not `tc.sh <filter>`).

## 1. Decisions

B1. **Console order page layout.** Header: order name, then `reference · customer · placed <date>`. Action
    row: Rename order, Change reference, Reassign customer, Invoice, Refund (danger style), followed by the
    existing status actions. Badges: status, payment state, total. Tabs, in this order: Overview, Phases,
    Intake, Files, Messages, Automation, SharePoint sync (n), Invoices, Refund, Order history,
    Acceptances (n), Sharing. The tab strip scrolls horizontally with visible scroll buttons, is one
    `tablist` with roving focus, and wraps into a "More" menu or select below 480 px. Every tab keeps its
    own URL segment.
B2. **Rename.** `orders.console.rename` changes the order name (1–120 characters, NFC, trimmed, no control
    characters), with optimistic version check, audit event `order.renamed` (old and new name), a row in
    the order history, and no change to the reference. Capability `orders.rename` (staff and
    administrators). Customers keep whatever `orders.update` already allows them.
B3. **Order history tab** (replaces "Activity"). Left: status history — every lifecycle transition with
    from → to, note, time and actor. Right: order activity — order-scoped events retained for audit
    (rename, reference change, reassignment, access grants, phase submitted / reviewed / unlocked,
    acceptance, file uploaded / recorded / converted, storage copy result, production dispatch, stage
    action runs, refund prepared / sent / failed). Read through an audit port scoped to one order;
    customer-visible subset only for customers (no staff names beyond "ReadyPackets staff", no IP).
    Paginated; filter by category.
B4. **Automation tab** (the existing "Production" tab, renamed and extended):
    - Phase I (P101) and Phase II (P201) cards with the payload preview and start buttons (exists). When a
      button is disabled the card says why (pipeline off, endpoint missing, precondition) and links to
      the pipeline settings for administrators.
    - "This order's pipeline history": dispatches for this order with phase, state, attempts, HTTP status,
      times, correlation id. "Retry" for failed dispatches (`orders.production.trigger`). "Redeliver" for
      a dispatch that was already delivered creates a NEW delivery marked `redeliveryOf`; it needs
      `orders.production.redeliver` (administrators, step-up), a reason and the typed phrase `REDELIVER`,
      because the receiver may start a second production run.
    - Later phases: optional **Phase III (P301)** and **Phase IV (P401)** endpoints in the pipeline
      settings, same signing, egress pinning, outbox and reconciliation as P201, payload
      `{customer_id, order_id, run_mode}`. Buttons "Start Phase III" / "Start Phase IV" appear only when
      the endpoint is configured. Assumption to confirm with the owner (the reference documents define
      only P101 and P201).
    - "Workflow stage actions": for each step of the order's workflow version, the enabled automations
      bound to that step ("N configured actions") and a "Run actions" button that runs them for this
      order now (`orders.automations.run`, staff and administrators). Uses the automations engine (must
      be enabled; otherwise a notice with a link). Every run is recorded in the run history and shown
      below. Automations still cannot change status or permissions.
    - A "Webhook rules" note: P201 must match P101 (`customer_id`, `order_id`, `run_mode`); the bundle
      scope manifest is a JSON string; do not start P201 before the Phase I artifacts exist.
B5. **Refunds.** Capability `payments.refund` (administrators, step-up). Refund tab and header button on
    every order:
    - shows per payment of the order's invoices: provider (Stripe, Square, manual), captured, already
      refunded, refundable;
    - "Prepare refund": amount (full or partial, minor units, never above the refundable balance computed
      on the server under a row lock), reason (required), customer notice on / off, typed phrase
      `REFUND ORDER`;
    - Stripe and Square payments: the refund is sent to the provider's refund API with an idempotency key
      derived from the refund's public id. The intent is committed first (`pending`), the provider call
      happens outside the database transaction, the result is recorded (`succeeded`, `failed`,
      `unknown`). `unknown` is never resent automatically: a reconcile job asks the provider by
      idempotency key / refund id, and the provider's refund webhooks update the record too;
    - manually recorded payments: "Record refund" (existing `recordRefund`) through the same dialog, with
      the label "recorded only — no money is moved by the portal";
    - invoice and order payment state follow (`partially refunded`, `refunded`); referral rewards tied to
      a fully refunded first invoice go to manual review; audit events; customer e-mail from a system
      template when notice is on. No card data is stored or shown. This supersedes "refunds are manual"
      in ADR 0035 (new ADR 0038).
B6. **Policy acceptance gateway** (ADR 0039). An administrator attaches a policy from the policy centre
    to a workflow as a gate: gate point `order_start` (before the customer can work on the order) or a
    named step (before that phase can be submitted), signature mode (checkbox, or typed full name), and
    "ask again when the policy has a new version" (default off). While a gate is unmet, the customer can
    open the order and read it but cannot upload, record, answer intake or submit a phase on it; the
    order page shows a full-width gate with the policy text, and the server refuses those mutations
    (`PRECONDITION_FAILED`, reason `ORDER_ACCEPTANCE_REQUIRED`) — the client is never the gate. Each
    acting user accepts for themselves (owner and people with access). The evidence record is
    append-only: order, user, policy public id, version, SHA-256 of the exact text shown, typed name,
    time, source address (encrypted) and user agent. Console tab "Acceptances (n)" lists the records
    ("Signed by <name> using typed signature", accepted time, policy and version; the source address is
    shown only with `sessions.read_all`). Staff are not gated. A printable receipt is available to the
    customer and the console.
B7. **Order file sync and folder routing** (ADR 0040). Every order file that becomes available — an
    upload that passed scanning, a saved recording, a converted WebM — is copied to the storage
    connections assigned to "order files" (exists; SharePoint library and OneDrive are among the
    providers). New:
    - folder template per upload / recording slot, with a workflow-level default, edited in the workflow
      designer ("Storage folder"). Precedence: slot → workflow → assignment default. Tokens:
      `{customer_ref}`, `{order_ref}`, `{order_name}`, `{phase}`, `{slot}`, `{yyyy}`, `{mm}`. Default:
      `customers/{customer_ref}/orders/{order_ref}/{phase}`;
    - validation on save and again at copy time: relative, at most 8 segments and 400 characters, no `.`
      or `..` segment, no control or provider-reserved characters; token values are reduced to safe
      segments; the designer shows a live example path;
    - the destination path is recorded on the copy attempt and shown in the Copy log;
    - per-order tab "SharePoint sync (n)" (label "File sync (n)" when no SharePoint or OneDrive
      connection is assigned): totals (total, synced, in progress, failed) and a transfer table — file,
      phase, status, destination, target path, last update, action. "Retry" only for a failed transfer
      whose source file still exists (`files.manage`). "Open Copy log" opens `/admin/storage/copies`
      filtered to the order.
    Local storage stays the system of record; a failed copy never blocks the customer.
B8. **Schema.** `migrations/0003_increment_04.sql` is frozen. Part B changes go to
    `migrations/0004_increment_04_part_b.sql`, generated by `/root`. Additive only (new tables, nullable
    columns, enum values appended). Owners: put your tables / columns in your module's `schema.ts` and
    tell `/root` the exact list in your FIRST reply; do not hand-write SQL.
B9. **Capabilities** (already in `shared/capabilities.ts`): `orders.rename` (staff, admin),
    `orders.automations.run` (staff, admin), `orders.production.redeliver` (admin, step-up),
    `payments.refund` (admin, step-up).

## 2. Packages

| Package | Owner | Partner |
|---|---|---|
| S1. Console order page shell: header actions, tab order and overflow, rename (server and client); workflow designer fields for the acceptance gate and the folder template; gate port `orders.gates` used by other modules | orders_engineer | ui_foundation_engineer (tab strip component) |
| S2. Order history tab and the order-scoped audit port | audit_engineer | orders_engineer |
| T1. Automation tab: disabled reasons, pipeline history, retry, redeliver, Phase III / IV | integrations_engineer (server) | siem_engineer (client) |
| T2. Workflow stage actions ("Run actions") | engagement_engineer (server) | audit_engineer (client panel inside the Automation tab) |
| U. Refunds | compliance_engineer (server, Stripe) | files_engineer (Square refund adapter; Refund tab, header button, dialog); jobs_engineer (reconcile job, notice template) |
| V. Policy acceptance gateway | identity_engineer (server in `server/modules/compliance/acceptance*`, customer gate UI, console Acceptances tab, receipt) | compliance_engineer (policy port), orders_engineer (gate port) |
| W. Order file sync and folder routing | portable_ops_engineer (path template, copy attempts, per-order query, retry) | portable_contract_engineer (Graph drive nested folders, SharePoint limits); files_engineer (confirm triggers for upload, recording, conversion); recovery_ops_engineer (client tab) |
| X. Documents: CHANGELOG, application context, requirements register, administrator guide, upgrade guide; ADR 0038–0041 text from the decisions above | platform_engineer | portable_ops_engineer (installer / CI: migration 0004 in the upgrade job) |
| Y. Review | http_security_engineer (U, T1, W: money movement, redelivery, path handling, SSRF) | assurance_engineer (V, S, isolation probes for every new procedure, accessibility of every new page) |
| Z. Browser QA of the new pages at 1440, 390, 320 px, both themes | ui_foundation_engineer | — |

## 3. Definition of done (per package)

- server: procedures with input schemas, capability and ownership checks, audit events, safe errors,
  idempotency on every money or delivery mutation; MySQL-backed tests including a cross-customer probe
  and the abuse cases named above (refund above balance, double submit, replay of an acceptance for
  another order, path traversal in a template, redeliver without step-up);
- client: one `h1`, labelled controls, focus management in dialogs, no colour-only state, 320 px without
  horizontal overflow, axe scan in light and dark through `client/src/test/a11y.tsx`;
- `API.md` and `VERIFICATION.md` of the module updated; an administrator-guide paragraph sent to
  platform_engineer;
- report to `/root`: commit hashes, exact test counts, what was NOT verified.
