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
| `files.read_all`, `files.manage`, `files.visibility.change` | View, remove, restore and change visibility of order files |
| `messages.read_all` | Staff message inbox (screens in progress) |
| `tickets.read_all`, `tickets.manage` | Support tickets (screens in progress) |
| `search.global` | Search across orders, tickets, messages and customers |
| `intake.review` | Review intake submissions (screens in progress) |
| `invoices.read_all`, `invoices.record_payment`, `invoices.manage` | Invoices and payment evidence (screens in progress) |
| `platform.health.read` | System health page |

Staff cannot manage staff accounts, settings, the audit centre, SIEM, jobs, backups or portable transfer.

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
  internal notes, full history and sharing grants.
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

The server supports these staff tasks today. The console screens are **in progress**: the routes below exist in the
working tree but were **not yet committed** when this guide was written. If an item is missing from the console
menu, it has not landed yet.

| Task | Planned screen (uncommitted) | Server procedures |
| --- | --- | --- |
| Message inbox | **Messages** (`/admin/messages`, `messages.read_all`) and the order **Messages** tab | `engagement.messages.adminInbox`, `messages.send` with customer or internal visibility |
| Support tickets | **Support queue** (`/admin/tickets`, `/admin/tickets/:ticketId`, `tickets.read_all`) | `engagement.tickets.admin.*`: reply (optionally internal), set status, assign, set priority |
| Intake review | **Intake review** (`/admin/intake/submissions`, `intake.review`) | `compliance.intake.review`: accept or return for changes, with a feedback note |
| Invoices | **Invoices** (`/admin/invoices`, `/admin/invoices/:invoiceId`, `invoices.read_all`) | `compliance.invoices.admin.*`: staff list invoices and record manual payment evidence; drafting, issuing and voiding are administrator procedures |
| Online card payment | — | **Disabled in this release**; record offline payments manually |

## Good practice

- Never ask a customer for their password, authenticator code or recovery codes. ReadyPackets staff never need them.
- Use internal notes for anything the customer should not see. Visibility is enforced by the server, not by
  convention.
- Each error screen shows a request reference. Include it when you report a problem so it can be matched in the audit
  centre and logs.
- Sign out when you finish on a shared device. Review your own sessions at `/account/sessions`.
