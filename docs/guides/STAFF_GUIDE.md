# Staff guide — ReadyPackets console

For ReadyPackets team members with the **Staff** role. Administrators have every staff permission plus those in the
[Admin guide](./ADMIN_GUIDE.md). This guide is written from `client/src/features/**/routes.tsx`,
`shared/capabilities.ts` and `server/modules/*/API.md`. Server features without a console screen are marked
**Not available yet**.

## Contents

- [Getting access](#getting-access)
- [What the staff role can do](#what-the-staff-role-can-do)
- [Console overview](#console-overview)
- [Customers](#customers)
- [Orders](#orders)
- [Starting Phase I and Phase II (production pipeline)](#starting-phase-i-and-phase-ii-production-pipeline)
- [Order files](#order-files)
- [System health](#system-health)
- [Messages, tickets, intake and invoices](#messages-tickets-intake-and-invoices)
- [Good practice](#good-practice)

## Getting access

1. An administrator invites you from **Staff** (`/admin/staff`). You receive an invitation email. The link expires
   after 72 hours.
2. Open the link (`/activate`), choose a password and set up an authenticator app. Store your recovery codes offline.
   Signing in follows the steps in the [Customer guide](./CUSTOMER_GUIDE.md#sign-in-and-two-step-verification).
3. After signing in you see the console at `/admin`. Customers who try a console address get "Page not found".

Your role is checked by the server on every request. Hiding a button is never the only control.

## What the staff role can do

Default staff permissions (`shared/capabilities.ts`). Least-privilege per-assignment staff permissions are a
recorded target, not yet implemented.

| Permission | What it allows |
| --- | --- |
| `customers.read_all` | View all customers and their details |
| `orders.read_all`, `orders.manage`, `orders.transition`, `orders.create` | View and manage all orders, change locks and status |
| `orders.production.trigger` | Preview production webhook payloads, view dispatch history, and start Phase I (`P101`) and Phase II (`P201`) on packet orders |
| `files.read_all`, `files.manage`, `files.visibility.change` | View, remove, restore and change visibility of order files |
| `messages.read_all` | Staff message inbox |
| `tickets.read_all`, `tickets.manage` | Support tickets |
| `search.global` | Search across orders, tickets, messages and customers |
| `intake.review` | Review intake submissions |
| `invoices.read_all`, `invoices.record_payment`, `invoices.manage` | Invoices and manual payment/refund evidence |
| `platform.health.read` | System health page |

Staff cannot manage staff accounts, catalog imports or bundle rules, settings, the audit centre, SIEM, jobs, backups or portable transfer.

## Console overview

**Available** — `/admin` ("Overview"). The landing page with widgets for your role.

## Customers

**Available** — `/admin/customers` and `/admin/customers/:customerId`.

- Search and filter customers by name, email, reference or status.
- The detail page shows the summary, **Reference history** (current and retired customer references) and extra
  sections.
- Creating customers, resending invitations, suspending or deactivating accounts, changing references and signing out
  a customer's sessions are **administrator** actions (`customers.manage`, `customers.reference.change`,
  `sessions.revoke_any`). Staff can see these records but cannot change them.

## Orders

**Available** — `/admin/orders` and `/admin/orders/:orderId`.

- **List**: filter by status, customer, date range and reference prefix.
- **Detail**: the same tabs as the customer view (**Overview**, **Activity**, **Notes**, **Sharing**, **Files**), plus
  internal notes, full history, sharing grants and the console-only **Production** tab.
- **Packets and bundle pricing**: packet line items show their snapshotted **Packet** (`1`–`6`), **Tier** (**Basic**,
  **Standard** or **Premium**), **Outcome**, **Timeline** and **Deliverables**. Each order holds at most one tier per
  packet (quantity `1`). Multi-packet orders (`2`–`6` packets) are bundle orders; when all six packets (`1`–`6`) are in
  one order and the administrator-managed bundle rule is enabled, the server applies the **15% bundle discount** and
  displays the subtotal, discount and total on the order. Catalog imports and bundle-rule edits are administrator tasks
  ([Admin guide — Catalog, matrix import and bundle rule](./ADMIN_GUIDE.md#catalog-matrix-import-and-bundle-rule)).
- **Notes**: choose **Visible to** → **Customer and staff** or **Staff only (internal)**. Internal notes are never shown
  to customers.
- **Status**: the order's workflow version decides which transitions you can make. Only allowed transitions are
  shown.
- **Lock**: **Change lock** sets or clears a lock. Locks block writes such as new files, notes and intake, but not
  reading. Placing a legal hold or unlocking an imported order needs an administrator.
- **Change order reference** and **Reassign order** are administrator actions and require you to verify it's you
  again (step-up).
- Creating an order on behalf of a customer exists on the server (`orders.admin.createForCustomer`) but has **no
  console screen yet**.

## Starting Phase I and Phase II (production pipeline)

**Available when enabled by an administrator** — the console-only **Production** tab on `/admin/orders/:orderId`
(`orders.production.trigger`). Customers never see this tab.

Both Phase I (`P101`) and Phase II (`P201`) are **manual** operator actions ([ADR 0023](../adr/0023-production-pipeline-webhooks.md)):

- **Which orders are eligible**: the order must contain at least one packet product (`1`–`6`) and **no non-packet items**.
  Orders with zero packets or mixed with non-packet catalog items are refused before anything is queued.
- **Step 1 — Preview and Start Phase I (`P101`)**:
  1. Open `/admin/orders/:orderId` → **Production** and inspect the **Payload preview**. Client name and email are masked
     in the staff preview; the actual `P101` payload sends `customer_id` (customer reference), `order_id` (order
     reference), `packet` and `tier` (that packet and tier for a single-packet order, or `"7"` and `"Mixed"` when more
     than one packet is in the order), `bundle_scope_manifest` (escaped JSON string of `packet_<n>` → tier),
     `canon_version`, `run_mode`, `client_name`, `client_email` and an optional `release_status` label
     (`^[A-Za-z0-9_.-]{0,120}$`, blank by default). `order_scope_mode` is never sent.
  2. Enter an optional **Release status** label only if instructed for a tracked run, then select **Start Phase I**.
  3. Watch the Phase I state move from `queued` / `sending` to `delivered`. **Delivered** means the production webhook
     endpoint accepted the request — the portal receives no automatic callback when Phase I finishes downstream.
- **Step 2 — Verify Phase I artifacts, then Start Phase II (`P201`)**:
  1. **Never trigger Phase II solely because Phase I shows `delivered`.** First confirm in the production output folder
     for the same `customer_id` and `order_id` that the expected **Phase I final artifacts** exist (for example, in
     `Final_Merge`: `Phase1A_Merged.txt`, `Phase1B_Adjudication.json`, `Phase1B_DeepResearch_Evidence.txt` and
     `PhaseI_InterviewGuidance.txt`).
  2. Return to the order's **Production** tab, tick the confirmation checkbox confirming that the Phase I artifacts exist,
     and select **Start Phase II**.
  3. The portal automatically sends the exact `customer_id`, `order_id` and `run_mode` recorded on the delivered `P101`
     dispatch — never recomputing them — so a later customer or order reference change cannot split the run. Allow
     downstream phases (Phase III / IV) to continue automatically.
- **Failures and re-sending**:
  - Network errors, `429` and `5xx` responses are retried automatically with backoff; other `4xx` responses stop
    immediately and show a safe HTTP status summary in the order's dispatch history.
  - At most one delivered `P101` and one delivered `P201` are allowed per order. If a phase genuinely needs to be
    **re-sent**, escalate to an **Administrator** (re-sending requires administrator step-up verification and a reason).

## Order files

**Available** — the **Files** tab on an order.

- Upload files, including new versions, within the order's size and type rules.
- Change a file's visibility between customer-visible and internal.
- Remove a file (it moves to trash and is purged after the retention period) and restore it from trash. Tick
  **Include trash** to see removed files.
- Every upload, download, visibility change, removal and refused attempt is recorded in the audit log.
- File rules and the storage overview (`/admin/files`) are for administrators.

## System health

**Available** — `/admin/health` ("System health"). Live status of the database, keys, schema and every module.
Report anything that is not healthy to an administrator.

## Messages, tickets, intake and invoices

**Available** — staff console screens and server procedures:

| Task | Console screen | Server procedures |
| --- | --- | --- |
| Message inbox | **Messages** (`/admin/messages`, `messages.read_all`) and the order **Messages** tab | `engagement.messages.adminInbox`, `messages.send` with customer or internal visibility |
| Support tickets | **Support queue** (`/admin/tickets`, `/admin/tickets/:ticketId`, `tickets.read_all`) | `engagement.tickets.admin.*`: reply (optionally internal), set status, assign, set priority |
| Intake review | **Intake review** (`/admin/intake/submissions`, `intake.review`) | `compliance.intake.review`: accept or return for changes, with a feedback note |
| Invoices | **Invoices** (`/admin/invoices`, `/admin/invoices/:invoiceId`, `invoices.read_all` / `invoices.manage`) | `compliance.invoices.admin.*`: create/issue/void invoices and record manual payment or refund evidence (step-up required for writes) |
| Online card payment | — | **Disabled in this release**; record offline payments manually |

## Good practice

- Never ask a customer for their password, authenticator code or recovery codes. ReadyPackets staff never need them.
- Use internal notes for anything the customer should not see. Visibility is enforced by the server, not by
  convention.
- Each error screen shows a request reference. Include it when you report a problem so it can be matched in the audit
  centre and logs.
- Sign out when you finish on a shared device. Review your own sessions at `/account/sessions`.
