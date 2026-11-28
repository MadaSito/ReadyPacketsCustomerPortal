# Administrator guide — ReadyPackets console

For users with the **Administrator** role. Administrators have every capability in `shared/capabilities.ts`, including
all [staff tasks](./STAFF_GUIDE.md). This guide is written from `client/src/features/**/routes.tsx`, the module
contracts in `server/modules/*/API.md` and the operator tooling in `scripts/ops/` and `deploy/`. Features that exist
only on the server or command line are marked as such. **Disabled in this release** means the feature is deliberately
switched off.

For new Ubuntu 26.04 LTS servers, start with the [automatic installation guide](../operations/AUTO_INSTALL.md). For
Ubuntu 24.04 LTS or self-provisioned dependencies, see the [manual installation guide](../operations/INSTALL.md).
TLS, upgrades, and go-live checks are in the [deployment profiles](../../deploy/README.md).

## Contents

- [Where to switch things on](#where-to-switch-things-on)
- [Step-up verification](#step-up-verification)
- [First administrator and setup](#first-administrator-and-setup)
- [Customers](#customers)
- [Staff and administrators](#staff-and-administrators)
- [Credential administration](#credential-administration)
- [Catalog, matrix import and bundle rule](#catalog-matrix-import-and-bundle-rule)
- [Policies, questionnaires and invoices](#policies-questionnaires-and-invoices)
- [File administration](#file-administration)
- [Settings and features](#settings-and-features)
- [Sign-in page presentation](#sign-in-page-presentation)
- [Configuration export and import](#configuration-export-and-import)
- [Audit centre](#audit-centre)
- [SIEM forwarding](#siem-forwarding)
- [Jobs, schedules, mail and maintenance](#jobs-schedules-mail-and-maintenance)
- [Backups and restore](#backups-and-restore)
- [Storage copy log](#storage-copy-log)
- [Portable transfer](#portable-transfer)
- [Integrations](#integrations)
- [Production pipeline (Phase I and Phase II webhooks)](#production-pipeline-phase-i-and-phase-ii-webhooks)
- [Microsoft Clarity and PostHog](#microsoft-clarity-and-posthog)
- [Installing as an app (PWA)](#installing-as-an-app-pwa)
- [Search engines](#search-engines)
- [Feature status summary](#feature-status-summary)
- [Increment 04 operating guides](#increment-04-operating-guides)
- [Working on an order](#working-on-an-order)
- [Cart suggestions](#cart-suggestions)
- [Discount codes](#discount-codes)
- [Policy acceptances](#policy-acceptances)
- [Reports](#reports)
- [Security incidents](#security-incidents)
- [Increment 07: phases, payments and sign-in](#increment-07-phases-payments-and-sign-in)
- [Alerts](#alerts)
- [Microsoft 365 file sync](#microsoft-365-file-sync)
- [Increment 07.1: ordering for customers and the portal switch](#increment-071-ordering-for-customers-and-the-portal-switch)
  - [Placing an order for a customer](#placing-an-order-for-a-customer)
  - [Switching between the admin and customer portals](#switching-between-the-admin-and-customer-portals)
  - [Why admins cannot use the cart](#why-admins-cannot-use-the-cart)
  - [Turning on discount codes](#turning-on-discount-codes)
  - [Troubleshooting: "You do not have permission to perform this action"](#troubleshooting-you-do-not-have-permission-to-perform-this-action)
  - [Troubleshooting: a mail template editor link returns 404](#troubleshooting-a-mail-template-editor-link-returns-404)
- [Increment 07.2: payments, branding and the default workflow](#increment-072-payments-branding-and-the-default-workflow)
  - [Getting card checkout active](#getting-card-checkout-active-increment-072)
  - [Stripe secret fields: Primary and Secondary](#stripe-secret-fields-primary-and-secondary)
  - [Troubleshooting: customers are not sent to Stripe](#troubleshooting-customers-are-not-sent-to-stripe)
  - [Company branding on invoices and receipts](#company-branding-on-invoices-and-receipts)
  - [Setting the default workflow](#setting-the-default-workflow)
  - [The "ReadyPackets was updated on the server" prompt](#the-readypackets-was-updated-on-the-server-prompt)
- [Increment 09: Trash centre (draft)](#increment-09-trash-centre-draft)
  - [Moving to trash and restoring](#moving-to-trash-and-restoring)
  - [Deleting permanently](#deleting-permanently)
  - [What is erased and what is kept](#what-is-erased-and-what-is-kept)
  - [Retention clean-up](#retention-clean-up)
  - [Backups, Stripe, SharePoint and other copies](#backups-stripe-sharepoint-and-other-copies)
- [Increment 08](#increment-08)
  - [Names](#names-increment-08)
  - [Order numbers](#order-numbers-increment-08)
  - [Adding packets to a project](#adding-packets-to-a-project-increment-08)
  - [Saved billing information](#saved-billing-information-increment-08)
  - [Payment confirmation and repair](#payment-confirmation-and-repair-increment-08)
  - [Customer order wizard](#customer-order-wizard-increment-08)
  - [Publishing workflows and packet tiers](#publishing-workflows-and-packet-tiers-increment-08)
- [Customer tasks and the order agreement](./WORKFLOW_CUSTOMER_TASKS.md)

## Increment 04 operating guides

Use these chapters alongside the existing console guide. Installing a dependency or configuring a host path does not enable the corresponding portal feature.

- [Media and country database setup](../operations/MEDIA_AND_GEOIP.md): FFmpeg availability, optional country database setup and rotation, and the host-level Protection recovery switch.
- [Native upgrade and migration `0003`](../operations/UPGRADE.md#increment-04-and-migration-0003): the pre-upgrade backup, traffic fence, and recovery after a partially applied migration.
- [Files and media](../../server/modules/files/ADMIN_GUIDE.md): configure uploads and review file and media behavior.
- [Upgrade to increment 06 and migration `0006`](../operations/UPGRADE.md#increment-06-and-migration-0006): new headers for the installable app, and larger upload limits for recordings.
- [Work with customer phases](../../server/modules/orders/questions/ADMIN_GUIDE.md) (increment 07): console phase selection, required questions, answer history, review and reopen, and the administrator checklist.
- [Customer tasks and the order agreement (MNDA)](./WORKFLOW_CUSTOMER_TASKS.md) (increment 06): tasks per status, designer findings, the export/import switch and the agreement gate.
- [Security incidents help](./SECURITY_INCIDENTS_HELP.md) (increment 06).
- [Cart suggestions](#cart-suggestions), [Discount codes](#discount-codes) and [Policy acceptances](#policy-acceptances) (increment 05): see the sections below.
- [Workflow export and import](./WORKFLOW_TRANSFER.md) (increment 05): move workflows between portals as drafts; enable `orders.workflow_transfer.enabled` first.
- [Workflow phases, requirements and console order actions](../../server/modules/orders/ADMIN_GUIDE_WORKFLOW_RULES.md): configure order phases, requirements and staff actions.
- [Cart and checkout](./CART_AND_CHECKOUT.md): configure checkout, fulfillment requirements and cart operations.
- [Hosted online payments](../../server/modules/payments/ADMIN_GUIDE.md): configure hosted checkout providers and reconcile payment outcomes.
- [Community forum](../../server/modules/community/ADMIN_GUIDE.md): configure categories, posting rules and moderation.
- [Knowledge Base and Help Centre](../../server/modules/knowledge/ADMIN_GUIDE.md): draft, publish and organize searchable help articles.
- [Customer Referral Programme](../../server/modules/referrals/ADMIN_GUIDE.md): configure rewards, review referrals and export records.
- [Jobs and schedules](../../server/modules/jobs/ADMIN_GUIDE.md): inspect job attempts and manage schedules.
- [Customer maintenance](./CUSTOMER_MAINTENANCE.md): configure and monitor customer maintenance jobs.
- [Webhooks console](./WEBHOOKS_CONSOLE.md): configure subscriptions and inbound endpoints, inspect deliveries, and rerun eligible failures.
- [Webhooks administration](../integrations/WEBHOOKS_ADMIN_GUIDE.md): security defaults, signing, the redacted delivery log and step-up redelivery and reprocessing, in operator detail.
- [Public API (inbound): keys, request log and replay](../../server/modules/publicApi/ADMIN_GUIDE.md): manage API access and scoped keys, inspect requests, and replay eligible operations.
- [Application Protection](../../server/modules/protection/ADMIN_GUIDE.md): manage protection policy, offline country lookups and recovery.
- [Sessions, sign-in log and access restrictions](../../server/modules/identity/ADMIN_GUIDE_SESSIONS.md): review sign-ins, manage sessions and configure access restrictions.
- [Cookies and consent](../../server/modules/platform/ADMIN_GUIDE_CONSENT.md): configure the cookie banner, manage consent categories, and review the consent ledger.

## Working on an order

Open **Orders** and select an order (`/admin/orders/:orderId`). The header shows the order name, then the reference, the customer and the date it was placed, with badges for status, payment and lock.

The actions are **Rename order**, **Change reference** (administrators), **Reassign customer** (administrators), **Invoice** and **Refund**, followed by **Change lock**, **Access for other users** and **New order for a customer**.

The tabs are Overview, Phases, Intake, Files, Messages, Automation, Sync, Invoices, Refund, Order history, Acceptances, Notes and Sharing. Each tab has its own address, so you can bookmark or share a link to it. On narrow screens they become a drop-down list.

### Rename an order

**Rename order** changes only the order's display name (1–120 characters); the reference stays the same. Staff and administrators with `orders.rename` can use it. If someone else changed the order first, the rename is refused; reload the order and try again. Every rename is audited as `order.renamed`, and the old and new names are kept in the order's name history. Staff see "Renamed: old → new" in **Order history**, and customers see a plain "Order renamed".

### Order history

**Order history** replaces Activity; customers see it as **History**.

- **Left column:** every status change, with who made it, any note, and every rename.
- **Right column:** the activity recorded on the order, with event names, outcomes and correlation IDs. Use a correlation ID to trace an event in the Audit centre. You can filter by category: details, status, sharing, phases, acceptance, files, storage, production, automations and payments.

Customers see a reduced view:

- Staff appear only as "ReadyPackets staff".
- Internal notes and former order names are hidden.
- Only successful, customer-relevant events are shown, and file events appear only for files visible to the customer.

### Automation

On the **Automation** tab (`/admin/orders/:orderId/automation`), staff and administrators with `orders.production.trigger` can:

- Preview the payload and start Phase I (`P101`) or Phase II (`P201`).
- Start Phase III (`P301`) or Phase IV (`P401`), but only when their HTTPS URLs are configured under **Integrations → Production pipeline** (`/admin/integrations/production`). These later phases use the same `{customer_id, order_id, run_mode}` sent in `P101`.

When a Start button is disabled, the card explains why: the pipeline is switched off, an endpoint URL is missing, `canon_version` is incomplete, or an earlier phase has not been delivered. Administrators also get a link to the pipeline settings.

**This order's pipeline history** lists every dispatch with its phase, state, attempt count, last HTTP status, times and correlation ID.

- **Retry** queues a fresh attempt for a failed or dead-lettered dispatch.
- **Redeliver** re-sends a dispatch that was already delivered. It needs an administrator with `orders.production.redeliver`, fresh step-up, a reason (3–280 characters) and the typed word `REDELIVER`. It creates a new delivery marked as a redelivery, because the receiver may start a second production run.

**Workflow stage actions** lists every step of the order's workflow version with the enabled automations bound to it. These are **Order created** rules on the first step, and **Order status changed** rules that target that step.

- Staff and administrators with `orders.automations.run` see this panel at the top of the Automation tab, with the current step marked.
- **Run actions** queues a step's automations for this order after you confirm. No step-up is needed, and repeating the request never queues them twice.
- Administrators also get a link to **Automations** (`/admin/automations`).
- If the automations engine is off, **Run actions** is disabled with an explanation.
- Each run uses an idempotency key and obeys rate limits. It appears in the run history and in **Order history**.
- Stage actions can never change an order's status or permissions.

The **Webhook rules** note reminds you of three rules:

- `P201` must carry the same `customer_id`, `order_id` and `run_mode` as `P101`.
- The bundle scope manifest is a JSON string.
- `P201` should not start before the Phase I artifacts exist.

### SharePoint sync

Open the **SharePoint sync** tab to inspect outbound copies of the order's uploads, saved recordings and converted audio. It is called **File sync** when no SharePoint or OneDrive connection is assigned to order files.

- **Who can see it:** staff and administrators with `orders.read_all`. Customers never see this tab.
- **What it shows:** totals for total, synced, in-progress and failed transfers. For each file, it shows the workflow phase, status, destination connection, target folder path and last update.
- **Retry:** staff and administrators with `files.manage` can retry a failed transfer while its local source file still exists. No extra step-up is needed. Uncertain outcomes are never resent blindly.
- **Copy log:** administrators with `storage.copies.read` can select **Open Copy log** to view `/admin/storage/copies?orderPublicId=<orderId>`. If no order-file destination is assigned yet, they can open **Storage connections** (`/admin/storage`) instead.

You choose the destination folder in the workflow designer (**Storage folder**), either per upload or recording slot or as a workflow default. Otherwise the connection's assignment default applies. The available placeholders are `{customer_ref}`, `{order_ref}`, `{order_name}`, `{phase}`, `{slot}`, `{yyyy}` and `{mm}`. The designer shows an example path and refuses unsafe paths. Local storage remains the system of record, so a failed remote copy never blocks the customer.

SharePoint and OneDrive have their own naming rules, so ReadyPackets adjusts file and folder names automatically:

- **Characters:** `" * : < > ? |` become underscores. Leading and trailing spaces and trailing dots are removed.
- **Reserved names:** names such as `CON` or `desktop.ini` get an underscore.
- **Long names:** these are shortened with a short code, and the extension is kept.
- **Path length:** the full path, including the library address, the root folder and the file name, must stay within 400 characters. Otherwise the copy fails with "invalid input" before anything is written.
- **Existing files:** these are never overwritten. An identical file is reused, and a different file with the same name is saved as "name (1).ext", "name (2).ext" and so on.

The Copy log shows the final path.

### Refunds

The **Refund** tab shows each captured payment, its provider (Stripe, Square or manual), the amount already refunded or reserved, and the amount still available to refund. Staff without `payments.refund` can review this but cannot submit refunds.

To issue a refund, you need an administrator account with `payments.refund` and fresh step-up verification. You also enter a written reason and an amount within the refundable balance, choose whether to notify the customer, and type `REFUND ORDER`.

- **Stripe and Square:** ReadyPackets saves the refund before it contacts the provider. If the result cannot be confirmed, the refund shows as **unknown**. ReadyPackets then checks the provider again in the background and never sends the refund a second time. An unknown result does not mean the refund failed. Do not issue another refund for that payment, in the portal or in the provider's dashboard, while it is unresolved.
- **Manual payments:** use **Record refund** only after you have refunded the customer outside ReadyPackets. Recording a refund does not move money.
- **Customer notice:** if you chose to notify the customer, the notice is queued only after the provider confirms the refund or a manual refund is recorded. Mail delivery status is tracked separately from refund status.
- **Referral rewards:** when an order's first paid invoice is refunded in full, any pending or approved referral reward tied to it goes back to manual review with the note `QUALIFYING_INVOICE_REFUNDED`.

### Acceptances

When a workflow has a policy gate, the customer, and everyone with access to the order, must accept the policy. The gate applies either before they can work on the order or before a named phase can be submitted. Until then they can read the order but cannot upload, record, answer questionnaires or submit a phase. The server refuses these, not just the page, and an acceptance cannot be reused on another order. Cancelling an order is never blocked by a gate. Staff and administrators are never gated.

The **Acceptances (n)** tab lists each record, for example "Signed by <name> using typed signature", with the time, policy and version. The source address is shown only to users with `sessions.read_all`, and viewing it is audited. Each record keeps a fingerprint (SHA-256) of the exact policy text that was shown, so you can prove which version was accepted. Open a record to print its receipt.

You add gates in the workflow designer: choose the policy, the gate point, the signature mode (checkbox or typed full name) and whether to ask again when the policy gets a new version. If it asks again, customers must accept the new text. No acceptance e-mail is sent.

## Cart suggestions

Open **Operations → Cart suggestions** (`/admin/carts/suggestions`). You need `carts.upsells.manage` (administrators). The design is set out in [ADR 0043](../adr/0043-cart-upsell.md). Full module notes are in the [cart administrator notes](../../server/modules/cart/ADMIN_GUIDE.md), and customer help is in [Suggestions in your cart](./CART_SUGGESTIONS_HELP.md).

### Switching it on

- **`feature.cart.upsell`** is off by default and needs **`feature.cart`**. Switch both in **Platform → Feature flags**; this needs step-up and is audited.
- While suggestions are off, customers never see them, but you can prepare offers in advance.
- **`cart.abandoned_ttl_hours`** (1–2160, default 72) sets when an inactive open cart expires. The hourly job `cart.abandoned.expire` marks those carts expired and records `cart.expired`.

### Offers

You can create, edit, activate, deactivate and delete two kinds of offer:

- **Add-on product**: an active catalogue product not yet in the cart.
- **Packet tier upgrade**: a higher-priced tier of a packet already in the cart. The customer sees the exact price difference.

For each offer, set:

- the trigger: **Any non-empty cart**, or **When specific products are in the cart**;
- an optional start and end;
- a priority from 1 to 1000, where lower numbers are shown first.

Up to 3 suggestions show per cart. When a cart is 1 or 2 packets short of the bundle rule (`orders.bundle_rule`), ReadyPackets also adds a bundle-completion suggestion at priority 50.

### Copy rules

The copy is plain text of at most 200 characters. HTML, countdown timers, pre-ticked boxes and confirm-shaming labels are not offered. Prices and eligibility are worked out on the server from the live catalogue, so withdrawn or repriced products drop out without breaking carts.

### Reporting

The page shows **Shown**, **Accepted** and **Dismissed** counts for each offer. An offer counts as shown at most once per cart.

### Open carts

**Operations → Open carts** (`/admin/carts`, `carts.read_all`) is read-only. Cart notes, billing details and applied codes are encrypted and never shown there.

## Discount codes

Open **Operations → Discount codes** (`/admin/promotions`). The pages are `/admin/promotions`, `/new`, `/redemptions`, `/:promotionId` and `/:promotionId/edit`, plus the public link landing page `/promo`. The design is set out in [ADR 0044](../adr/0044-discount-codes.md), and customer help is in [Using a discount code](./DISCOUNT_CODES_HELP.md).

### Who can do what

- Staff with `promotions.read` see the list, masked codes and redemptions.
- Administrators with `promotions.manage` can:
  - create, edit, pause, resume and revoke codes;
  - show codes and generate batches;
  - export CSV and release redemptions;
  - change the settings.
- Every change asks for your password and second factor again (step-up) and is recorded in the audit log.

### Switching it on

The **Discount codes** switch on the page (`feature.promotions`) is off by default. While it is off, no code can be applied anywhere, and existing orders keep their discounts.

Customers also need the cart on to enter a code in the cart and at checkout. See [Turning on discount codes](#turning-on-discount-codes) for both prerequisites and where the field appears.

### Creating a code

1. Choose **New discount code**.
2. Enter an internal name (seen by staff only) and the label customers see. The label must not be the code itself.
3. Choose a percentage, with an optional largest amount, or a fixed amount with its currency. The type cannot be changed later.
4. Choose what the code applies to (everything, products, tiers or packet sizes) and its conditions:
   - a minimum subtotal;
   - a start and end;
   - the total number of uses, and uses per customer (default 1);
   - first order only;
   - only certain customers or e-mail domains;
   - whether it combines with the bundle discount (otherwise the larger discount applies).
5. Choose how the code is made: your own code (6–32 letters, digits or hyphens), a generated code, or a batch of up to 5,000 single-use codes with an optional prefix of 1–12 letters or digits.

After creating it, copy the code or its link (`/promo#promo=<CODE>`). The code is in the part of the link after `#`, so it never reaches the server's access logs. Later, **Show code and link** reveals it again, and each reveal is audited.

### Largest discount per order

The **Largest discount per order** setting (`promotions.policy`, field `maxDiscountPercent`, default 50%) caps the bundle and code discounts together as a share of the subtotal, and a total is never negative. Changing it needs step-up.

### Pause, resume and revoke

Pause and resume can be undone. Revoke is permanent. Orders already placed always keep their discount.

### Abuse controls

- Every code check is rate limited. After 5 failed checks in 15 minutes, the account cannot check codes for 15 minutes, and a warning (`promotion.attempts_blocked`) goes to the audit log and the SIEM.
- Customers see the same message for every refusal: "This code cannot be applied."
- A verified e-mail is required.
- Staff and administrators cannot redeem codes for themselves.
- When staff create an order for a customer, eligibility is judged for that customer.
- Codes cannot be used through API v1.

### When a redemption is released

A code counts as used as soon as an order is placed with it. It is given back only when the order has been cancelled (it is in a cancel state of its workflow) and **all** of these are true:

- nothing has been paid for the order, not even part of an invoice;
- none of the order's invoices can still be paid (issued, open or partially paid);
- no online payment is waiting to be captured;
- no online payment was ever started for the order, including failed, cancelled or expired ones.

When an order is cancelled and all three hold, ReadyPackets releases the redemption automatically. After you have voided or settled the invoice by hand, an administrator can choose **Release** on the redemptions list. Release needs a reason of at least 5 characters, and the server checks the same rule and refuses otherwise. In every other case the redemption stays used, even after a refund, and the cancellation still goes ahead. To make it up to the customer, give them a new code.

### On invoices

Invoices (`/invoices/:invoiceId`, `/admin/invoices/:invoiceId` and the PDF) show **Bundle discount** and **Discount (<label>)** as separate lines, never the code. An invoice whose total is 0 is marked paid when it is issued, so no payment can be recorded against it. Server notes are in the [compliance section](../../server/modules/compliance/ADMIN_GUIDE_SECTION.md).

### Exports

The CSV exports of codes and redemptions are built by the server with formula-safe cells. They need step-up and are audited. Store them as secrets.

## Policy acceptances

Open **Billing & compliance → Policy acceptances** (`/admin/policy-acceptances`). Staff and administrators with `policies.acceptances.read` can view it, and it is always on. It is a read-only view of the recorded evidence; nothing here changes or deletes a record ([ADR 0045](../adr/0045-policy-acceptance-log-centre.md)). Times are shown in your time zone, with the exact UTC time alongside.

### Log

The log can be filtered by:

- customer name, e-mail or reference;
- policy and exact version;
- accepted date range;
- source (Registration, Order gate, Checkout, Re-acceptance, Imported historical) and method (Tick box, Typed name);
- version status (Current or Superseded);
- order reference.

**View evidence** opens the full record. It includes the linked order (for order-gate acceptances), an address pseudonym, the correlation ID, the full SHA-256 content hash and the exact policy text accepted. Typed signer names are shown only to administrators with `policies.manage`; other viewers see **Encrypted**.

**Export CSV** needs `policies.acceptances.export` (administrators) and step-up. It downloads up to 5,000 matching records with formula characters neutralised, and is audited.

### Coverage

**Coverage** (`/admin/policy-acceptances/coverage`) shows, for each active policy that requires acceptance:

- the current version and when it was published;
- how many active customers have accepted it and how many are outstanding;
- the outstanding customers, with the last version each one accepted (or **Never accepted**).

### Policy updates

**Policy updates** (`/admin/policy-acceptances/updates`) lists every published version with:

- the publication time, the hash prefix and the change summary;
- the administrator who published it;
- how many customers have accepted it.

**Open exact text** shows the version on its own page (`/admin/policy-acceptances/versions/:versionId`), with **Print**.

### Customer profile: Policies tab

On a customer's page (`/admin/customers/:customerId`), the **Policies** tab shows:

- the status of each active policy: **Accepted — Current version**, **Update pending**, **Pending — Not yet accepted** or **Not required**;
- the customer's full acceptance history, with **View evidence** and links to the exact text of each version.

## Reports

Open **Overview → Reports** (`/admin/reports`). Reports are on by default ([ADR 0049](../adr/0049-reports.md)). Full notes are in the [reports console notes](../../client/src/features/reports/ADMIN_GUIDE_SECTION.md).

### Built-in reports

Staff and administrators with `reports.read` can run eight built-in reports: Orders, Customers, Referrals, Support tickets, Payments and discounts, Carts, Files and recordings, and Sign-ins and security.

- **Range.** Choose a preset (last 7, 30, 90 or 365 days) or UTC dates up to 732 days apart, and a time bucket (hour, day, week or month).
- **Comparison.** You can compare with the previous period.
- **Display.** Each panel has a plain-language summary, a chart and a **Chart / Table** switch, so every figure can be read as a table.
- **Personal fields.** Staff never see personal fields such as customer names, e-mails or countries; a note says when columns are hidden.

### Custom reports

Custom reports are for administrators with `reports.manage`. Choose **New custom report**.

1. **Dataset.** Pick one dataset from a fixed list; there is no free-form query.
2. **Mode.** Choose **Detail rows** (up to 20 columns) or **Group & aggregate** (up to 4 groupings and 6 totals: count, count distinct, sum, average, minimum, maximum).
3. **Filters.** Add up to 16 typed filters. Money is entered in minor units: `1250` is $12.50.
4. **Sort and display.** Add up to 4 sort rules and a screen row limit of up to 5,000. Then choose a table, bar, line or donut chart.
5. **Preview and save.** **Run preview**, then save as **Private** or **Shared**.
   - Every administrator can run and duplicate a shared report, but only its owner can edit or delete it.
   - A report that uses a field removed in a later release is marked **Needs update**.

### Export and limits

- **CSV export** needs `reports.export` (administrators) and step-up. It holds at most 100,000 rows or 16 MiB and is marked truncated when a cap is hit. Values that look like spreadsheet formulas are neutralised.
- **Run limits.** Each person can run one report at a time and up to 10 a minute. A run stops after 15 seconds; if that happens, narrow the range or add filters.
- **Audit.** Runs and exports are recorded as `report.run` and `report.exported`, with the report and filter fields but never the values. Changes to saved reports are recorded as `report.definition.*`. Run history is kept for 90 days.

## Security incidents

Open **Audit centre → Incidents** (`/admin/audit/incidents`). You need `security.incidents.read`. The design is in [ADR 0050](../adr/0050-signin-bans-backoff-correlation.md), and step-by-step help is in [Security incidents help](./SECURITY_INCIDENTS_HELP.md).

The portal correlates security events every minute and opens an incident when a rule's threshold is crossed. The rules cover:

- many failed sign-ins for one account;
- password spraying across accounts;
- credential stuffing;
- a successful sign-in after failures;
- repeated MFA denials;
- repeated rate limiting;
- ban evasion;
- a role change followed by an export.

### Working an incident

- **Open** an incident to see its severity, status, the number of accounts and addresses, the correlated events and a timeline.
- **Acknowledge** it. New evidence still joins it.
- **Close** it with a reason: resolved, false positive, duplicate or accepted risk. Later activity opens a new incident.
- **Ban IP address** (15 minutes, 1 hour, 1 day, 7 days or permanent, with a reason) or **End sessions** for the affected person.
  - Both need step-up and are audited.
  - The address is never shown; the server takes it from the events.
  - Release bans on **Protection → Bans** (`/admin/protection/bans`).
- **Ban this IP** is also offered in an audit event's details when the event recorded an address. This needs the firewall-manage permission.

### Correlation rules and bans

- **Correlation rules.** The **Correlation rules** card switches rules on or off and sets each rule's severity, threshold and window. This needs the firewall-manage permission and step-up. Severity rises one level at three times the threshold.
- **Automatic sign-in bans.** These are set on **Protection → Bans** (`/admin/protection/bans`). Back-off is set on **Protection → Rate limits** (`/admin/protection/rate-limits`).
- **Proxy warning.** If client addresses cannot be determined behind your proxy, a warning appears, and banning pauses until the trusted-proxy settings are fixed.
- **Break-glass.** A server command lists and clears bans without the web UI ([ADR 0050](../adr/0050-signin-bans-backoff-correlation.md)).
- **SIEM.** Incidents and bans are audit events (`security.incident.*`, `security.ban.*`), so SIEM and syslog receivers get them.

## Increment 07: phases, payments and sign-in

These features have detailed guides from the teams that built them. The summaries below give the rules you most need to know.

### Phases, review and progress

- **Phase editor.** On upgrade, the default workflow gets a phases draft derived from its statuses. Review it in **Workflows** (`/admin/workflows`) and publish it when ready. Running orders keep their version. See [Workflow phases, requirements and console order actions](../../server/modules/orders/ADMIN_GUIDE_WORKFLOW_RULES.md).
- **Statuses.** Add, rename, reorder, retire and restore statuses on `/admin/workflows/statuses`. A status that an open draft uses cannot be retired. Orders already in a retired status keep it.
- **Review and reopen.** See [Work with customer phases](../../server/modules/orders/questions/ADMIN_GUIDE.md). **Request changes** needs a note and keeps the phase locked. **Reopen phase** needs an administrator, a reason of 10–500 characters, a confirmation and step-up.
- **Progress.**
  - Each phase counts by its weight (1–100, default 1).
  - The bar stays at 99 or below until the order reaches a status in the `done` category.
  - It shows the higher of that value and any explicit completion update.
  - It goes down only when an administrator reopens a phase, and that is audited.
- **Phase actions.** See [Phase actions](../../server/modules/automations/ADMIN_GUIDE_PHASE_ACTIONS.md). A bundle runs only when a person previews and confirms it with step-up. Unattended rules never change an order's status.

### Downloading files as a ZIP

- **Who can download.** Customers and staff can download every current file of a phase they can see as one ZIP. Administrators can also download all files of an order. This needs a fresh identity check and is offered on the order's Files tab.
- **Limits.** Each archive holds at most 250 files and 500 MiB. It is built in the background, and the same person can download it for 30 minutes in the same session.
- **What it contains.** Placeholders, removed files and older versions are never included. Audio is the WebM/Opus copy, not the original.
- **If files change.** If files change after an archive is prepared, the download is refused and the archive must be prepared again.
- **Audit.** Every request, build, download and refusal is recorded in the audit log under the File category.

### Stripe setup

Use **Stripe setup** (`/admin/payments/setup`), described in [Hosted online payments](../../server/modules/payments/ADMIN_GUIDE.md).

- **Activation requirements.** All of these must be met for the current staged key and mode:
  - the Stripe egress preset is switched on;
  - **Test Stripe API** succeeded;
  - **Send self-test webhook** succeeded;
  - from 07.2, **Verify Checkout session creation** passed for the current key and mode. This is needed when switching to Stripe or changing the mode. A server already active on Stripe stays active after the upgrade, and the probe shows as a "Recommended check". Only a failed probe for the current key blocks it.
- **Activating.** You then confirm in a dialog. Live mode also needs the typed words `ACTIVATE LIVE PAYMENTS`.
- **Events.** Subscribe the nine events listed on the page.
- **Unmatched payments.** A paid session that carries portal metadata but matches no order raises a warning alert for staff.
- **Small amounts.** Card payments below Stripe's minimum charge still follow the small-totals setting.
- **From 07.2.** See [Getting card checkout active](#getting-card-checkout-active-increment-072).

### SAML single sign-on with Entra ID

Use **Single sign-on** (`/admin/sso`), described in [SAML 2.0 single sign-on with Microsoft Entra ID](./SSO_SAML_ENTRA.md).

- **Choosing an MFA mode:**
  - an upgraded existing configuration starts in `portal` mode;
  - `claim` is recommended for new setups;
  - `entra` hands MFA to Entra entirely. It needs the typed words `ENTRA MANAGES MFA`, and a Conditional Access policy requiring MFA is recommended.
- **Switching protocol.** Switching between OIDC and SAML disables SSO until you enable it again.
- **Not supported:** IdP-initiated sign-on, single logout and encrypted assertions.
- **Keep a way in.** Always keep at least one local administrator with MFA.

### Webhooks and the production pipeline

See [Webhooks administration](../integrations/WEBHOOKS_ADMIN_GUIDE.md) and [Production webhooks](../integrations/PRODUCTION_WEBHOOKS.md).

- **Auto-queue.** The P101 / P201 auto-queue is off by default, per workflow. P101 is queued when a real payment is recorded, either a Stripe webhook or a recorded manual payment. It is not queued when an administrator's status change only passes the payment phase. P201 is queued when the intake phase is submitted, after P101 was delivered.
- **Signing.** Production pipeline payload signing is off until you generate a secret. New webhook subscriptions are signed by default and start paused.
- **Retry and Redeliver.** **Retry** re-sends the same delivery record. **Redeliver** creates a new, linked record and needs step-up.

## Alerts

<!-- platform_engineer: from jobs_engineer's D6 handoff; acknowledge and resolve checked in the lead's QA of 2026-11-25. -->

Operational alerts collect failures that need a person ([ADR 0058](../adr/0058-outbound-webhooks-and-operational-alerts.md)). They come from:

- phase action bundles and completion jobs;
- webhooks;
- Microsoft Graph and file sync;
- payments;
- certificate expiry.

Each failure raises one alert, not one per retry.

- **Dashboard.** The `/admin` dashboard counts open alerts by severity (warning, error, critical) and links to them.
- **Alerts page.** Open **Alerts** (`/admin/alerts`). Staff and administrators can read alerts with `ops.alerts.read` and filter them by severity, source and state. Staff and administrators with `ops.alerts.manage` can **Acknowledge** or **Resolve** an alert.
- **Audit and SIEM.** Alerts go to the audit trail and SIEM with safe codes only.
- **Waiting order reminders.** This card on `/admin/alerts` is for administrators only. It is **off** by default.
  - **Threshold.** The default is 48 hours (`orders.attention_alert_hours`), and you can set 1–8,760. Saving needs step-up.
  - **How it runs.** A daily sweep raises one staff warning per waiting episode, for orders awaiting staff review or a customer response. No e-mail goes to the customer.
  - **Switching it off** does not clear existing alerts; resolve those after review.

## Microsoft 365 file sync

<!-- platform_engineer: from portable_ops_engineer's D12 handoff. Lead QA 2026-11-25: covered by peer-reported tests against mocked Graph only; no real SharePoint site. -->

File sync copies order files from the portal to SharePoint, one way, phase by phase ([ADR 0061](../adr/0061-microsoft-365-file-sync.md)). The portal stays authoritative: nothing done in SharePoint changes the portal. Remote deletes and moves are never made, and files from before you switch sync on are not copied (no historical backfill).

### Setting it up

1. On **Storage connections**, add a dedicated **private SharePoint** connection. Prefer SharePoint with the `Sites.Selected` permission on a private, dedicated site. OneDrive needs tenant-wide application file permissions, so it is not recommended.
2. On **Integrations → Egress** (`/admin/integrations/egress`), switch on the **Graph** and **Graph upload** presets.
3. Run the ordinary read test and enable the connection. Then run the session-based **write check**. It proves the portal may write, without creating a file.
4. Open **File sync** (`/admin/storage/file-sync`, linked from Storage connections) and approve the destination explicitly. Approve it either for phase files, or as the only, restricted **Receipts** target.
5. In the workflow's phase editor, choose for each phase:
   - the document folder and audio folder (defaults `{phase_key}/Docs` and `{phase_key}/Audio`);
   - the originals, conversion staging and intake delivery targets.

   These selectors default to **off** ("Do not transfer").

### What goes to each target

- **Intake delivery** receives only customer-visible phase files that the portal has admitted, plus verified audio derivatives, and only when they are published. Nothing is sent when a phase is submitted.
  Admitted means the file passed the portal's byte and file-type checks, and the configured scanner if one is set up. The default production setup does not configure an external antivirus scanner.
- **Originals** receives staff-only files and originals that are still pending or not yet converted. These never go to intake delivery.

Files land under `CustomerName-CustomerID/OrderNumber/<phase folder>`. The first two segments are fixed when an order is first exported.

### Running and repairing

- **Uploads never fail because Graph is offline.** Copies wait and retry.
- **Resync.** **Dry run** first shows the count. Then queue a bounded resync of at most 100 existing failed or blocked items.
- **Uncertain uploads.** An upload whose outcome is unknown is inspected and reconciled, never replayed blindly.
- **Health and alerts.** Health shows the last success, the backlog and blocked items, and problems raise alerts on `/admin/alerts`. The order's **File sync** tab shows each file's role, destination and state.

## Increment 07.1: ordering for customers and the portal switch

These changes are mostly in the web app. Server permissions are unchanged. Background is in the [session log of 2026-11-25](../session-logs/2026-11-25-session-01.md).

### Placing an order for a customer

1. Open the dialog in one of two ways:
   - in the console, open **Orders** (`/admin/orders`) and choose **New order for a customer**;
   - or go straight to `/admin/orders?new=1`.
   The dialog opens and the keyboard focus moves into it.
2. Pick the customer, enter a project name, and set a quantity for each product.
3. Optional:
   - enter a discount code (shown when discount codes are on). The code is checked for that customer, and is removed again if you change the customer or the items;
   - add a note for the customer.
4. Create the order. It appears in that customer's portal.

Closing the dialog removes `?new=1` from the address and returns focus to where you were.

You need the `orders.manage` capability. Staff and administrators who open **Create an order** or the cart in the customer portal see the panel "Orders are placed for a customer". Its **New order for a customer** button brings them here.

### Switching between the admin and customer portals

- **In the console**, choose **Customer portal**. It is in the top bar on medium and larger screens. On small screens it is the first item in the menu drawer.
- **In the customer portal**, choose **Admin portal** (administrators) or **Staff portal** (staff). It is in:
  - the top bar on medium and larger screens;
  - the menu drawer, as the first item;
  - the notice at the top of every page, which shows the button below medium width: "You are viewing the customer portal as {role}. Orders, carts and checkout belong to customer accounts." The notice cannot be dismissed, so you always know which portal you are in.
- **Landing page.** Staff and administrators who open `/` go to `/admin`, unless they chose the customer portal in this browser tab.
  - The choice is per tab and is not shared with other tabs.
  - It ends when you switch back or sign out.
- **Customers** never see the switch.

The switch changes only which screens you see. It grants nothing, and the server checks every request as before.

### Why admins cannot use the cart

Orders, carts and checkout belong to customer accounts. The server refuses them for staff and administrator accounts, on purpose: it keeps the people who run the portal separate from the people who buy through it (zero trust).

- In the customer portal, staff and administrators see a handoff panel instead of the order form, cart or checkout. This applies on `/orders/new`, `/cart`, `/cart/checkout`, `/checkout/return` and `/checkout/cancel`.
- No cart requests are made for them.
- The customer menu hides **Create an order** and **Cart** for them.
- To order on a customer's behalf, use [Placing an order for a customer](#placing-an-order-for-a-customer).
- To try the customer journey yourself, sign in with a separate customer account. A test customer is suitable.

### Turning on discount codes

Customers can enter a code in the cart and at checkout only when both of these are on:

1. **Discount codes** at **Operations → Discount codes** (`/admin/promotions`), in the **Settings** card (`feature.promotions`). It is off when shipped.
2. **Cart** at **Settings → Features** (`/admin/settings/features`, `feature.cart`).

Then:
- **In the cart.** The field is in the cart summary once the cart has at least one item. An empty cart shows "Have a discount code? Add an item first to apply it here or at checkout."
- **At checkout.** The field is also on the checkout page.
- **On the order form.** The Review step shows "Have a discount code? You can enter it in your cart and at checkout."
- **With the cart off.** The direct order form keeps its own code field on the Review step.
- **In the console.** The **New order for a customer** dialog shows the field whenever discount codes are on.

Create at least one active code ([Creating a code](#creating-a-code)). Otherwise every code entered is refused.

### Troubleshooting: a mail template editor link returns 404

On builds before 07.1, reloading or bookmarking a template editor whose key has a dot returned "Not found". An example is `/admin/email-templates/auth.password_reset`.
- **On older builds**, open the template from **E-mail templates** instead.
- **From 07.1**, such links work for built-in keys and `custom.<slug>` keys. Other paths with a file extension still return 404 by design.

### Troubleshooting: "You do not have permission to perform this action"

- **On older builds.** Before 07.1, an administrator or staff member in the customer portal saw this message on step 3 of **Create an order** or on the cart. This was the server refusing an order or cart for a staff account, as described in [Why admins cannot use the cart](#why-admins-cannot-use-the-cart).
- **Fix.** Use the console instead: `/admin/orders?new=1`. Or upgrade with the normal steps in [UPGRADE.md](../operations/UPGRADE.md); the commands are unchanged for 07.1. After the upgrade, the handoff panel replaces the message.
- **If a customer sees it**, check the following:
  - the account's role is **Customer**;
  - the account is not suspended;
  - the feature in use is on at `/admin/settings/features`.
  Then look up the request's correlation ID in the audit centre.

## Increment 09: Trash centre (draft)

<!-- DRAFT by platform_engineer from INCREMENT_09_CONTRACT.md D2. Settings, states and job name confirmed by recovery_ops_engineer; storage copies by files_engineer. PENDING-OWNER audit_engineer, orders_engineer, identity_engineer: screen labels. -->

The Trash centre is at **Administration → Trash** (`/admin/trash`). It has an **Orders** tab and a **Customers** tab. Only administrators can use it:

| Permission | Allows |
| --- | --- |
| `trash.read` | Seeing the Trash centre |
| `trash.manage` | **Move to trash**, **Restore** and **Undo** |
| `trash.purge` | **Delete permanently**, with a fresh two-step check |
| `trash.retention.manage` | Changing the retention settings, with a fresh two-step check |

Every row shows:
- the item, and the owner's customer ID;
- who moved it and when;
- the reason;
- the date it will be deleted permanently;
- its state: **In trash**, **Deleting**, or **Failed — retry available**.

You can filter by text, date range, who moved it, and items due within a number of days. You can sort the rows, page through them, and restore or delete several at once. On a phone, rows become cards.

### Moving to trash and restoring

- **Orders.** Use **Move to trash** on the order page or the order list row.
  - Moving the first order of a project also moves the packets added to it later (increment 08), in the same batch.
  - An addition can be moved and restored on its own, but it cannot be restored while the first order is in the trash.
- **Customers.** Use **Move to trash** on the customer's page. Only customer accounts can be moved; staff and administrator accounts cannot. The button is disabled, with the visible reason "Suspend this account first", until the account is **suspended**.
  - Moving a customer revokes all of their sessions and pending links, and moves **all of their orders** in the same batch.
  - Their e-mail address stays reserved while the account is in the trash.
- **The dialog** names the item and says what moves with it. It shows the date the item will be deleted permanently under the current retention setting, or "kept until an administrator deletes it". You can add an optional reason of up to 200 characters.
- **Payments.** Moving to trash never refunds anything and never changes anything at Stripe, apart from cancelling the order's open checkout attempts. The dialog says so when the order has payments.
- **Undo.** After moving an item, a message with **Undo** appears and you return to the list.
- **While an item is in the trash,** it disappears from every list, search, picker, count, report, dashboard, customer export, notification, reminder, automation and e-mail, and from the public API (404).
  - A direct link shows the ordinary "not found" page, exactly as if the item never existed.
  - The order's unpaid invoices are hidden from the customer and cannot be paid. Paid invoices and receipts stay available.
- **Restore** brings back the item and everything moved with it in the same batch.
  - A customer comes back **suspended**. Reactivate the account separately.
  - An order whose customer is in the trash cannot be restored alone: "Restore the customer account first".
  - If something has changed in the meantime, the restore is refused with a plain explanation and nothing is half-restored. For example, the project may now have the same packet in another live order.
- **Numbers are never reused.** Order numbers and customer IDs are never reused, even after a permanent deletion.

### Deleting permanently

**Delete permanently** needs `trash.purge` and a fresh two-step check.
- **Typed confirmation.** To enable the button, type the order number or the customer ID. For several items at once, type `DELETE <count>`.
- **What the dialog lists.** What is erased and what is kept. It also says that this cannot be undone, and that copies remain in backups until those backups expire.
- **Restore stops working** as soon as the deletion starts.
- **A customer's orders first.** For a customer, each of their orders is deleted first, then the account.
- **If a step fails,** the item shows **failed** and the clean-up job or an administrator retries it. Each run is recorded with its counts and a safe error code.

### What is erased and what is kept

**Erased for an order:**
- project details, line working state, and phase and stage progress;
- notes, messages, and tickets tied to the order;
- files and recordings, including the stored objects and every storage copy the portal controls;
- intake answers, questionnaires and acknowledgements tied to the order;
- grants, production payload copies and SharePoint mapping rows;
- cart references and automation run payloads.

**Erased for a customer, in addition:**
- name, e-mail address and password;
- two-step factors, sessions, tokens and SSO links;
- saved billing information and consent choices;
- referral links, API keys and notification preferences.

Community posts are removed or shown as "Deleted account".

**Kept, with no way back to a live record:**
- issued invoices and receipts, with their own frozen copies;
- payment and refund records;
- policy acceptance entries required as evidence;
- audit and security log entries;
- the reservations of the order number and customer ID.

Unpaid, unissued or draft invoices of a deleted order are voided. Their numbers are never reused or deleted.

**What stays behind (a tombstone).** The order or account row stays so that the kept records still point at something:
- an order shows "Deleted order";
- an account shows "Deleted account", with a placeholder in place of the e-mail address, so that the real address can register again;
- a deleted account cannot sign in.

A tombstone never appears in lists, search or pickers, and it cannot be restored.

### Retention clean-up

The settings are in the Trash centre:
- **Automatic trash clean-up** (`trash.autoPurge.enabled`): on by default.
- **Order retention in trash (days)** (`trash.retention.orderDays`): 30 by default.
- **Customer account retention in trash (days)** (`trash.retention.customerDays`): 30 by default.

The day settings allow 1 to 3,650 days. Changing them needs `trash.retention.manage` and a fresh two-step check, and is audited.

- **Due date.** An item is due on the day it was moved plus the setting **as it is now**. Changing the setting moves the due date of everything already in the trash. Orders moved together with a customer follow the customer's date.
- **Shortening retention.** The panel shows how many items become due. It asks for the same confirmation as a permanent deletion.
- **The hourly job** `trash.retention_cleanup` deletes what is due, as the system, through the same path as a manual deletion. Only one run happens at a time, it works in bounded batches, and it continues after an interruption. Each run is audited as `trash.cleanup_completed`. Failures raise an operational alert with source `trash`.
  - It does not run during maintenance or an upgrade.
  - One failing item does not block the others. Failures raise an operational alert and are retried.
  - The Trash centre shows the last clean-up run and how many items are due next.

### Backups, Stripe, SharePoint and other copies

Permanent deletion only reaches data that the portal itself controls.
- **Backups** keep their copy until they expire under the backup retention, see [BACKUP_AND_RESTORE.md](../operations/BACKUP_AND_RESTORE.md). **Restoring an older backup brings deleted items back.** After a restore, delete them again from the Trash centre, using the `order.purged` and `customer.purged` audit events as the list.
- **Stripe.** Customers, payments and checkout sessions at Stripe are not changed.
- **Storage copies the portal controls** are deleted and checked. If a write to the current destination is still uncertain, the deletion stops and is retried; it never reports success early.
- **Copies the portal cannot prove it owns,** for example in an older or changed storage destination, are not touched. They are counted as `unverifiedExternalCopies`, with only the connection's public ID. The portal's pointer is removed. Remove them by hand after checking.
- **Provider recycle bins.** Residual copies left in a provider's retention or recycle bin are counted as `providerRecycleBin`. The portal never empties a whole bin.
  - **Microsoft Graph (OneDrive and SharePoint)** deletes the exact item permanently.
  - **Dropbox** user apps only soft-delete, so a copy stays in Dropbox's own bin until Dropbox removes it.
  - **Azure Blob** with soft delete enabled may keep a retained version, under the storage administrator's control.
- **SharePoint folders and reused external items.** Folders already written to SharePoint, and external items that were reused, are not deleted. Only the portal's mapping rows are erased. Delete the folders in SharePoint if needed.
- **E-mail.** Messages already delivered stay in the recipients' mailboxes.
- **SIEM.** Copies already sent to the SIEM or syslog server stay there.

**Audit.** Every action is audited with the actor, public IDs, batch ID, reason and counts, never with names, e-mail addresses or content. The events are:
- `order.trashed`, `order.restored`, `order.purge_started`, `order.purged`;
- `customer.trashed`, `customer.restored`, `customer.purge_started`, `customer.purged`;
- `trash.retention_changed`, `trash.cleanup_completed`.

## Increment 08

### Names (increment 08)

- **Name fields.** Registration, **Account**, and the administrator forms for creating customers and staff ask for **First name**, **Last name** and **Preferred name (optional)**. Each name can be at most 50 characters (UTF-16 code units). Longer names are refused with "please shorten it" and are never cut short silently.
- **Display name.** The full name stays "First Last", which comes to at most 101 characters. Invoices, billing names and typed signatures keep using it.
- **Greetings.** The customer home page and e-mails sent to a user use the preferred name, or the first name if there is no preferred name. Billing names in e-mails are not changed.
- **Older accounts.** The name parts are worked out from the existing full name when needed. If a part comes out longer than 50 characters, the profile form shows it and asks for a shorter version on the next save.

### Order numbers (increment 08)

New orders get a reference built from the customer and the project: `RP-<C4>-<F3><L3>-<P6>-<NNN>`, for example `RP-JJG5-ZEUGRE-ICEQUE-001` for the synthetic customer Zeus Greene (`RPCUS-A1B2CJJG5`) and the project "Ice Queen".

- **The parts:**
  - `RP` is the order reference prefix setting;
  - `C4` is the last 4 letters or digits of the customer ID (`0000` if there is none);
  - `F3` and `L3` are the first 3 of the first and last name;
  - `P6` is the first 6 of the project name;
  - `NNN` is the next unused number for that customer and project, starting at `001`. Additions to the project get `002`, `003`, and so on.
- **Characters.** Accents are removed and only `A–Z` and `0–9` are kept. Short name and project parts are padded with `X`. A customer ID shorter than 4 characters is padded on the left with `0`.
- **Length.** With a 2–6 letter prefix, a reference is at most 32 characters. A number that is already taken, for example by a manual or imported reference, is skipped.
- **Imports.** An imported order keeps its reference, and the counter for that reference's stem moves past the imported number.
- **Frozen at creation.** Renaming the customer or the project later never changes a reference.
- **Existing orders** keep their `RP-YYYY-NNNNNN` reference. Changing a reference by hand works as before.

**Privacy: references contain name fragments.** This is by the owner's requirement.
- **What a reference reveals.** Part of the customer ID, three letters each of the first and last name, and six of the project name. Anyone who sees a reference sees these fragments.
- **Where references appear.** Wherever they already appear:
  - audit events (as the order's label) and their SIEM export;
  - e-mails, invoices and receipts;
  - P101 / P201 webhook payloads;
  - SharePoint folder names.
- **What the portal never does:**
  - put references in new log fields; operational and request logs use public IDs;
  - log the name parts or other inputs of the reference;
  - use a reference in a URL.
- **Before go-live,** tell customers about this in your privacy notice, and consider it before sharing references outside your team.


### Adding packets to a project (increment 08)

- **For customers.** On an order page, the customer who owns the order sees **Add packets to this project**. It is not shown to staff, people the order is shared with, or for a cancelled project. The link opens `/orders/new?addTo=<order public ID>`.
  - The page is titled "Add packets to <project>", and the project name cannot be changed there.
  - Packets the project already has are marked "Already in this project" and cannot be chosen. The server also refuses them with `PACKET_ALREADY_IN_PROJECT`.
- **What gets created.** Each addition is a separate order in the same project, with its own invoice and payment. Its reference continues the project's numbering, for example `…-002`.
- **Where it shows.** When a project has more than one order, the order page shows **Orders in this project**, with a link to each one. Order lists show "Added to <reference>". URLs use public IDs, never references.

### Saved billing information (increment 08)

- **Where it is kept.** Customers manage it under **Account → Billing information** (`/account/billing`). They can also add it during registration in the optional "Billing information (optional — you can add it later)" section.
- **At checkout,** a customer with saved details chooses **Use my saved billing information** or **Enter different billing information**. With different details, ticking **Save as my billing information** replaces the saved copy.
- **Changing or clearing it.** **Clear billing information** removes the saved copy. Changes only apply to future checkouts. Invoices and payment receipts that were already issued never change.
- **Privacy.** The details are stored encrypted, one copy per customer, and only that customer can see them. The audit log records changes without the field values. There is no self-service account export or erasure yet; an administrator handles privacy requests.

### Payment confirmation and repair (increment 08)

- **What changed (D5).** This replaces increment 07 decision 12 ("never mark paid without a signed webhook"). A Stripe payment is now recorded by one idempotent booking step, triggered either by a verified signed webhook or by the server's own lookup at Stripe. Each payment records how it was booked: `webhook` or `provider_lookup`. If both arrive, the payment is booked only once. The browser never tells the server that something was paid.
- **When the server checks Stripe:**
  - when the customer reaches the return page; it checks again automatically for a short while, and the customer can press **Check payment status** (at most once every 3 seconds);
  - during the scheduled reconciliation, every 5 minutes;
  - when an administrator presses **Check with Stripe now**.
- **Delayed payment methods** such as bank debits show as processing. They are not marked paid or failed until Stripe settles them.
- **Missing webhooks.** If a paid Stripe payment is still without a webhook 10 minutes later, one alert, "Stripe is not delivering webhooks to this server", is raised per environment. `/admin/payments/setup` then shows:
  - the last verified webhook;
  - the reasons for webhook rejections in the last 24 hours;
  - the endpoint URL and the nine required events;
  - the usual causes.
- **Repairing an older paid-but-unbooked invoice.** This covers an invoice that was paid on Stripe before the upgrade but still shows "Issued":
  1. Open the invoice at `/admin/invoices/<invoice>`, or the payment attempt in `/admin/payments`.
  2. Press **Check with Stripe now**. It needs the `payments.manage` permission and a fresh two-step check.
  3. If Stripe confirms the payment, it is booked. Attempts marked redirected, expired, cancelled or failed are covered, as long as the portal invoice is unpaid. The check is audited as `payments.admin.stripe_checked`.
- **Square** is unchanged in this increment. It still books only from a verified webhook (plus Square's own checks), and **Check with Stripe now** does not apply to it.

### Customer order wizard (increment 08)

- **What customers see.** A purchased order opens on a wizard for the current phase, headed "Phase n of m". Each step is headed, for example, "Step 2 of 4: Questions". Only the steps the workflow needs are shown, from:
  - Review and accept;
  - Questions;
  - Upload documents;
  - Record or upload audio;
  - Review and submit.
- **Moving through it.** **Back** and **Next** are always visible. When **Next** is unavailable, the reason is shown next to it. **Submit** asks for confirmation first. If the submission is refused, focus moves to the error summary.
- **The former tabs** are under **Order details** on the same page. Old links to a tab, such as `/orders/<id>/files`, open the details directly.
- **Waiting screens** say what happens next and offer the single useful action.

### Publishing workflows and packet tiers (increment 08)

- **Publish button.** The workflow designer has a **Publish** button that stays in its header. Drafts on `/admin/workflows` also have a **Publish** row action.
  - Both open the same dialog, where you add a change note and choose whether the workflow becomes the default for new orders.
  - Publishing needs a fresh two-step check and uses the same permission and validation as before. Orders already in progress keep the version they started on.
  - After publishing, the dialog confirms the version number and whether that version is now the default for new orders.
- **Packet tiers.** When a customer chooses a tier, its outcome and deliverables are shown and the other tiers are collapsed. Choosing "Not included" collapses them all.


## Increment 07.2: payments, branding and the default workflow

These changes answer the owner's prompt 30 of 2026-11-26 ([session log](../session-logs/2026-11-26-session-01.md)). There is no database migration, and the upgrade commands are unchanged.

### Getting card checkout active (increment 07.2)

Card checkout is active only when the banner at the top of **Stripe setup** (`/admin/payments/setup`) reads **Online card checkout: ACTIVE**. Until then, customers can place orders and get an invoice, but they are not sent to Stripe. The banner says what customers experience right now and which step is missing.

1. **Create the key and endpoint in Stripe.**
   - **Key:** an API secret key (`sk_…`) or a restricted key (`rk_…`) for the right mode. A restricted key needs at least:
     - **Checkout Sessions: Write**;
     - **Payment Intents: Read**;
     - **Charges: Read** (and **Write** if staff issue refunds from ReadyPackets).

     A Read-only Checkout Sessions permission passes **Test Stripe API**, but customers then cannot be sent to Stripe.
   - **Endpoint:** register `https://<your host>/api/payments/webhooks/stripe` with the nine events listed on the page.
   - Publishable keys (`pk_…`) are not used.
2. **Stage the credentials.** In **Stripe setup** or **Payments → Configuration**, paste the **Stripe API secret key** and the **Primary Stripe webhook signing secret** (`whsec_…`) and save. You can keep Pay by invoice while you do this.
3. **Allow the outbound connection.** Turn on **Allow api.stripe.com:443** (the `stripe` egress preset).
4. **Check the connection.** Select **Test Stripe API**.
5. **Check that sessions can be created.** Select **Verify Checkout session creation**. This creates an unpaid probe session and expires it at once, at no cost. It catches:
   - a restricted key without Checkout Sessions Write;
   - a custom Checkout domain, which ReadyPackets refuses because it sends customers only to `https://checkout.stripe.com`.

   A passing probe for the current key and mode is required to activate. Until then, **Missing readiness gates** lists it and **Activate Stripe Checkout** stays blocked. If the server was already active on Stripe before 07.2, checkout stays active and the probe shows as **Recommended check (online card checkout remains active)**. Only a failed probe for the current key pauses checkout.
6. **Check the signing secret.** Select **Send self-test webhook**. This proves the portal's own signature check with the stored Primary secret. To prove that Stripe has the same endpoint and secret, also use **Send test event** in Stripe Workbench, or make a test payment.
7. **Activate.** Select **Activate Stripe Checkout** and confirm. In live mode, type `ACTIVATE LIVE PAYMENTS`.

Steps 4–6 ask you to verify it's you again (step-up). Online checkout pauses until you run the matching step again if you:
- change the key;
- change the Primary signing secret;
- change the mode;
- change the egress preset.

The full reference is [Hosted online payments](../../server/modules/payments/ADMIN_GUIDE.md).

### Stripe secret fields: Primary and Secondary

- **Stripe API secret key.** Paste the `sk_…` or `rk_…` key for the selected mode.
- **Primary Stripe webhook signing secret.** This is the endpoint's signing secret, `whsec_…`. In Stripe, open the webhook endpoint and select **Reveal** under **Signing secret**. Do not copy the endpoint ID (`we_…`). To replace your saved secret, paste the new one here.
- **Secondary Stripe webhook signing secret (optional rollover).** Leave it empty in normal setup. Use it only while Stripe signs with both an old and a new secret during a rollover. Then paste the new secret into Primary, run **Send self-test webhook** again, and remove Secondary.

From 07.2, the fields help with pasting:
- They remove surrounding quotes or backticks, non-breaking spaces, invisible characters and line breaks from a wrapped paste.
- Each field gets its own error. The error says what the pasted value looks like (a publishable key, an API key in the signing-secret field, an endpoint ID, a masked value, too short or too long) without repeating it.
- Each field has a **Show** / **Hide** button and is set to stop browsers and password managers from filling it in.
- The hints say where in Stripe to copy each value.
- Saved secrets are shown only as their last four characters.

If a secret ever appears in a screenshot, e-mail or ticket, roll it in Stripe and paste the new value into the portal.

### Troubleshooting: customers are not sent to Stripe

1. **Read the banner.** Open **Stripe setup**. If it says **NOT ACTIVE**, finish the missing step it names; see [Getting card checkout active](#getting-card-checkout-active-increment-072).
2. **Check the last failure.** Look at **Last checkout-session failure** on the same page, and in **Alerts** (`/admin/alerts`) look for "Customers cannot reach Stripe Checkout". The audit centre has `payments.attempt.failed`, with a reason code and Stripe's status, and `cart.checkout_payment_start_failed`. Neither contains keys or Stripe's own wording.
3. **Fix the cause, then run Verify Checkout session creation again.** Common causes are:
   - a revoked key;
   - a restricted key without Checkout Sessions Write;
   - the egress preset switched off;
   - a custom Checkout domain.

The customer's order and invoice are kept, and the customer sees "Your order … is placed, but we could not open the secure payment page".
- **Pay now** is offered only while online payment is available.
- Otherwise the page links to the invoice, the order and the payment status, and the customer can pay later or by invoice without placing a second order.

### Company branding on invoices and receipts

- **What the PDFs show.** Invoice, payment receipt and refund note PDFs have:
  - the ReadyPackets mark, wordmark and tagline;
  - your legal company name;
  - brand colours, with dark text on light fills;
  - a footer with `my.readypackets.com` and "Page X of Y", in Letter and A4.
- **Order and project.**
  - Each PDF has an **Order** and **Project** block near the top of page 1.
  - The invoice and receipt pages for customers and staff show an "Order & project" card, and the lists show both.
  - The invoice issued, invoice paid and payment receipt e-mails include Order and Project.
  - Published overrides of those e-mail templates still work, and the order and project are added to them.
- **Where to change it.**
  - **Company profile** on **Invoices** (`/admin/invoices`) holds:
    - **Legal company name**;
    - **Tax or registration ID**;
    - **Billing address**;
    - **Billing contact**;
    - **PDF header logo** and **Brand logo asset**;
    - **Offline payment instructions**.
  - **Receipt footer note** is under **Payments → Configuration** (`/admin/payments`).
  - Saving asks you to verify it's you again.
- **Defaults.** The legal name defaults to "Ready Packets Consulting LLC", and the logo to the ReadyPackets header mark.
  - **Legal name on an upgraded server:** a name you set yourself is kept. Invoices that carry the old default "ReadyPackets" show "Ready Packets Consulting LLC".
  - **Logo:** the default changed from the 192 px app icon to the header mark, so an upgraded server that never chose a logo shows the header mark.
- **Existing documents.**
  - Invoices are drawn when opened, so existing invoices show the new layout and the order's current project name.
  - Receipt and refund note PDFs are stored with an integrity hash and are never rewritten. A receipt issued before the upgrade keeps its original PDF, but its page and any resent e-mail show the order and project.
- **Characters.** Characters such as `·`, `•`, `–`, `—`, `€`, `™`, curly quotes and accented letters now print correctly. Other characters are replaced with readable equivalents, not "?".
- **PDF accessibility.** The PDFs set the document language and title. They mark the content as tagged and give the logo alternative text ("ReadyPackets company logo"), and the text can be selected. They are **not** PDF/UA conformant: the standard Helvetica font is not embedded with a Unicode map, and tables have no full structure tags.

### Setting the default workflow

The top of **Workflows** (`/admin/workflows`) shows **Default workflow for new orders: name (version N)**.

1. Choose **Set as default** on another published workflow.
2. Confirm. You are asked for your password and authentication code.

- **New orders.** Orders created from then on use that workflow's latest published version. This applies to orders customers place, cart checkout, orders staff create for a customer, and the API. If you publish a newer version later, new orders use it.
- **Existing orders** keep the version they started with.
- **Drafts.** A draft cannot be the default until it is published. When publishing a draft you can tick **Use for new orders (default workflow)**.
- **Audit.** Every change is recorded as `workflow.default.changed`, with the previous and the new default.
- **Products.** Workflows are not chosen per product or package.

More detail is in [Workflow phases, requirements and console order actions](../../server/modules/orders/ADMIN_GUIDE_WORKFLOW_RULES.md#the-default-workflow-for-new-orders-increment-072).

### The "ReadyPackets was updated on the server" prompt

This prompt appears after you upgrade the server, in browser tabs that still run the previous version of the web app.
- **Reload** switches to the new version and keeps the session. Unsaved input on that page is lost.
- **Later** hides it until the next page change, then it is shown again.
- It never reloads by itself.

Ask users to reload after an upgrade.

## Storage copy log

Open **Storage → Copy log** (`/admin/storage/copies`) as an administrator. The log tracks attempts to copy order files, off-site backup archives and SharePoint order data. History begins at rollout; it does not reconstruct older attempts.

- **Filter and inspect**: Filter by source kind, destination, state, or a UTC date range. The default is seven days and each search can span up to 90 days. Search by source or destination ID, destination name, correlation ID or safe error code. Open **Details** for the destination, bytes when known, attempt number, timestamps and verification method.
- **Read the result**: **Written** means the provider accepted the write, not that a separate check confirmed it. **Verified** means a checksum matched or the provider read-back confirmed the result recorded by that integration. SharePoint checks the order identifier, not the full record, so its writes are recorded as **Written**, not **Verified**. **Not written** can mean canceled or no change was needed. An interrupted job without a confirmed outcome is shown as **Failed**; check the provider before assuming nothing was written.
- **Investigate and retry**: A **Copies failing** signal in System health flags recent recorded failures or unconfirmed outcomes. Select **View audit trail** in **Details** to search the Audit centre by correlation ID. For an eligible failed backup copy, **Retry backup copy** requires step-up verification and queues a new job; the original remains in the history. For other failed attempts, use the source module's recovery process.
- **Export**: **Export CSV** downloads up to the 1,000 newest matching attempts and records an audit event. Narrow the date range or other filters if the export is truncated. Handle the file as an operational log; it contains customer-resource and destination identifiers.

## Where to switch things on

<!-- platform_engineer: paths checked against the client route definitions on feat/increment-07. -->

Each feature's switch is on the page where you use it and in **Platform → Settings** (`/admin/settings`). Every switch needs step-up and is audited. Turning a feature off breaks nothing; existing records stay.

### On after upgrade

These features are on after the increment 06 upgrade, because they need no configuration.

| Feature | Setting | Where to switch it |
| --- | --- | --- |
| Audio recording and conversion to WebM | `files.audio_conversion` (`enabled`) | Files (`/admin/files`) |
| Editing Word documents in the portal | `files.document_editing` (`enabled`) | Files (`/admin/files`) |
| Workflow export and import | `orders.workflow_transfer.enabled` | Workflows (`/admin/workflows`); see [Customer tasks and the order agreement](./WORKFLOW_CUSTOMER_TASKS.md) |
| Receipts and receipt e-mail | `payments.receipts` | Payments (`/admin/payments`) |
| Totals below the card minimum (waive or block) | `payments.small_totals` (`waive`) | Payments (`/admin/payments`) |
| Reports | none needed; access through `reports.read` | Reports (`/admin/reports`) |
| Install app prompt | none needed | Account menu |
| Typed-name check on signatures | `compliance.signature_name_check` (`require`) | Policies (`/admin/policies`) |
| Relaxed discount limits | `promotions.policy` (`maxDiscountPercent` 100, `allowZeroTotal` true) | Discount codes (`/admin/promotions`) → Limits |
| Automatic sign-in bans | `protection.signin_bans` (`enabled`) | Protection → Bans (`/admin/protection/bans`) |
| Rate-limit back-off | rate-limit back-off settings | Protection → Rate limits (`/admin/protection/rate-limits`) |
| Phase list and progress bar (increment 07) | none needed; older workflows show derived phases | Every order page, list and the console |
| Status catalogue and attention filters (increment 07) | none needed; `orders.statuses.manage` to edit | Workflows → Statuses (`/admin/workflows/statuses`); filters on `/admin/orders` |
| Phase editor (increment 07) | none needed; publish the prepared phases draft when ready | Workflows (`/admin/workflows`) |
| Running phase actions (increment 07) | `automations.stageBundlesEnabled` (on); a phase has no actions until you add them | Order console → Phases → **Run phase actions** |
| Audio playback with seeking, phase ZIP (increment 07) | none needed; the whole-order ZIP needs `files.archive.order` and step-up | Order page and console Files tab |
| Payment state on orders (increment 07) | none needed | Order page and console header |

### Off until you configure them

These features are off until you configure them, because they can lock people out or need your choice.

| Feature | Setting | Where to switch it |
| --- | --- | --- |
| Cart | `feature.cart` | Platform → Feature flags (`/admin/settings/features`), or offered on Cart suggestions |
| Cart suggestions | `feature.cart.upsell` | Cart suggestions (`/admin/carts/suggestions`) → "Show suggestions in the cart"; seeded offers start disabled |
| Discount codes | `feature.promotions` | Discount codes (`/admin/promotions`) |
| Policy enforcement (end sessions) | per policy `enforcement.mode` | Policies (`/admin/policies`), on each policy |
| Order agreement (MNDA) | `orders.agreement_gate` | Policies (`/admin/policies`) → "Order agreement (MNDA)", or workflow settings; see [Customer tasks and the order agreement](./WORKFLOW_CUSTOMER_TASKS.md) |
| Workflow phases and requirements | `orders.workflow_rules.enabled` | Platform → Settings (`/admin/settings`) |
| Delegated console access | `orders.console_access.enabled` | Platform → Settings (`/admin/settings`) |
| Knowledge Base and Help Centre | `feature.knowledge` | Platform → Feature flags (`/admin/settings/features`); content in `/admin/knowledge` |
| Community forum | `feature.community` | Platform → Feature flags (`/admin/settings/features`); rules in `/admin/community/settings` |
| Referrals | `feature.referrals` | Platform → Feature flags (`/admin/settings/features`); programme in `/admin/referrals` |
| Inbound API v1 | `publicApi.enabled` | Platform → Settings, or API (`/admin/api`) |
| Signed webhooks | `feature.integrations.webhooks` | Platform → Feature flags (`/admin/settings/features`); endpoints in `/admin/integrations/webhooks` |
| Cookies and consent | `feature.privacy.consent` | Privacy (`/admin/privacy`) |
| PostHog / Microsoft Clarity | `feature.integrations.posthog` / `feature.integrations.clarity` | Integrations → Analytics (`/admin/integrations/analytics`), after consent is configured |
| Online payments | `payments.config.provider` (`none`) | Payments (`/admin/payments`) |
| Stripe completion (increment 07) | activation needs the egress preset, an API check and a self-test; live mode needs `ACTIVATE LIVE PAYMENTS` | Stripe setup (`/admin/payments/setup`) |
| P101 / P201 lifecycle auto-queue (increment 07) | `integrations.production.workflow_auto_queue`, per workflow | Production pipeline (`/admin/integrations/production`) |
| Production pipeline payload signing (increment 07) | generate a signing secret first | Production pipeline (`/admin/integrations/production`) |
| Egress presets for Stripe and Microsoft Graph (increment 07) | one-click presets | Integrations → Egress (`/admin/integrations/egress`) |
| Microsoft 365 file sync and receipts to Microsoft 365 (increment 07) | approve a destination; the phase selectors default to "Do not transfer" | File sync (`/admin/storage/file-sync`) and the phase editor |
| SAML single sign-on (increment 07) | protocol `saml`; an upgraded configuration starts in `portal` MFA mode | Single sign-on (`/admin/sso`) |
| Waiting-order reminders (increment 07) | `orders.attention_alerts_enabled` (`orders.attention_alert_hours` 48) | Alerts (`/admin/alerts`) |

## Step-up verification

Many administrator actions ask you to **verify it's you** with your password plus an authenticator code, passkey or
recovery code. The server enforces it (`STEP_UP_CAPABILITIES` in `shared/capabilities.ts`). The verification is
short-lived and checked again when the action is applied. If you cancel, nothing changes.

## First administrator and setup

1. The first administrator is created during installation by `deploy/install.sh`, or manually with
   `pnpm admin:create --email … --name "…"`. The password is read from `RP_BOOTSTRAP_ADMIN_PASSWORD_FILE` or a hidden
   prompt, never from the command line. The command refuses if an active administrator already exists.
2. Sign in, set a new password, set up an authenticator app and store the recovery codes offline.
3. Open **Setup** (`/admin/setup`). The checklist is built from live configuration and module health, not from
   self-reporting. Work through every item.
4. Invite a second named administrator from **Staff** so the installation never depends on one account.
5. Check **System health** (`/admin/health`).

## Customers

**Available** — `/admin/customers`, `/admin/customers/:customerId`.

- **Create a customer**: enter email, name and an optional customer reference. The customer receives an invitation
  (72-hour link).
- **Resend invitation**, **suspend**, **deactivate** or **reactivate**, each with a reason code.
- **Change customer reference** (step-up). Retired references are kept in **Reference history** and never reused.
- **Sign out sessions**: revokes every session for that customer (step-up).
- **Credentials** tab: see [Credential administration](#credential-administration).

## Staff and administrators

**Available** — `/admin/staff` ("Staff and administrators").

- **Invite staff member** (step-up): email, name and role (**Staff** or **Administrator**).
- **Change role** (step-up): Staff, Administrator, or **Customer (removes console access)**. Changing a role signs that
  user out everywhere. The last active administrator cannot be demoted.

## Credential administration

**Available** — the **Credentials** tab on a customer's detail page (`customers.credentials.administer`, step-up).
See [ADR 0004](../adr/0004-admin-credential-administration.md).

**Password administration** → **Reset method**:

| Method | What happens |
| --- | --- |
| **Email a set-password link** | Requires a verified email address and ready SMTP. Clears the old password, signs the user out and emails a 24-hour link. |
| **Generate a temporary password** | Shown to you once. The user must choose a new password after completing MFA at the next sign-in. |
| **Enter a temporary password** | Same as above, with a password you type. |

**Multi-factor authentication** → **Reset MFA** removes the user's authenticator, passkeys and recovery codes, so they
enrol again at next sign-in. Use it only after verifying the person's identity outside the portal. A reset also
releases an authenticator app blocked after 50 failed codes.

All of these are audited. You never see a user's existing password or codes.

## Catalog, matrix import and bundle rule

- **Catalog** (`/admin/catalog`, `catalog.manage`) — **Available**. Create and edit product groups and products:
  - **Group dialog**: **Packet number** (*"Only for packet groups. Leave empty for other groups."*) and **Group key**
    (*"Optional import key, e.g. packet-1."*). Packet group cards show a **Packet N** badge.
  - **Product dialog**: **Tier** (**Basic**, **Standard** or **Premium** — shown and required for packet groups),
    **Outcome**, **Timeline** and **Deliverables** (*"One per line as: Title | detail. When set, the features list is the
    deliverable titles."*). Non-packet products leave packet number and tier unset.
  - Editing a product's name, price, outcome, timeline or deliverables publishes a new, immutable product version; existing
    orders keep the snapshot they were placed under.
  - For packet products, the server enforces quantity `1` and at most one tier per packet in a single order.
- **Importing the Master Offerings Matrix** (`ops:catalog-import`, command line) — [ADR 0022](../adr/0022-offerings-matrix-as-catalog-data.md):
  - Fresh installations start with an empty catalog; no packet names or prices are hardcoded in application code.
  - Load or update `data/catalog/readypackets-offerings-v3.0.json` (validated against `data/catalog/offerings.schema.json`):
    - Preview without writing: `pnpm ops:catalog-import --dry-run` (or `--file <path> --dry-run`).
    - Apply idempotently: `pnpm ops:catalog-import` (or `node dist/ops/catalog-import.js --file <path>` on a deployed host).
  - The command runs as an audited operator session: it creates missing groups and products by `groupKey` / `productKey`,
    creates a new product version only when content or price changed, configures the bundle rule below, and prints a
    summary. It never deletes catalog items and refuses any file that fails schema validation.
  - **Packet 7 ("The All-In")** is not a catalog product — it is how multi-packet bundle orders are represented, governed
    by the bundle rule below. **Packet 8** is recorded under `reserved` in the data file as unlisted and is not imported
    (if ever authorized, an administrator can add a product manually in **Catalog**).
- **Bundle discount** (**Bundle discount** card → **Edit bundle discount** at the top of `/admin/catalog`, setting key
  `orders.bundle_rule`, audited as `catalog.bundle_rule.changed` and `platform.setting.changed`):
  - Dialog fields: **Apply the bundle discount**, **Required packets** (comma-separated, set to `1, 2, 3, 4, 5, 6` by the
    matrix import), **Discount (%)** (`15` for the Master Bundle) and **Label** (for example `The All-In (Master Bundle)`).
  - Off by default on a blank installation until imported or enabled by an administrator.
  - When enabled and an order contains every required packet (at any combination of **Basic**, **Standard** or **Premium**
    tiers), the server applies the percentage discount (rounded half up) to the order subtotal (`total = subtotal - discount`)
    and snapshots **Subtotal**, the discount **Label** and **Total** on the order. Existing orders keep their amounts, and
    the browser never sends prices or discount amounts.
- **Workflows** (`/admin/workflows`, `workflows.manage`) — **Available**. View and publish versioned order workflows.
  Orders stay bound to the version they started with.

## Policies, questionnaires and invoices

**Available** — `/admin/policies`, `/admin/intake`, `/admin/intake/submissions` and `/admin/invoices` (see
`server/modules/compliance/API.md`).

- **Policies** (`/admin/policies`, `policies.manage`, step-up to write): write drafts, publish immutable versions
  (SHA-256 content hash locked), mark a policy as required or as needing a typed signature, and view acceptance evidence.
  Published versions cannot be edited or deleted. Before enabling the **Production pipeline**, ensure your published
  customer privacy notice (and `/privacy`) reflects that order metadata, client name and email are sent to the production
  pipeline when Phase I is started.
- **Questionnaires** (`/admin/intake`, `intake.manage`): build intake questionnaires scoped by default, catalog item or
  workflow, and publish immutable versions. Staff review customer submissions under **Intake review**
  (`/admin/intake/submissions`, `intake.review`).
- **Invoices** (`/admin/invoices`, `invoices.manage`, step-up to write): create a draft for an order, issue it
  (sequential number), void an unpaid or fully refunded invoice, and record manual payment or refund evidence with an
  idempotency key. Online card payment is **disabled in this release**.

## File administration

**Available** — `/admin/files`.

- **Upload rules**: maximum size per file, maximum request size, files per upload and trash retention in days. Rules
  can only narrow the built-in format allowlist; they cannot allow arbitrary types. Changes require step-up.
- **Recorded storage usage**: counts for stored versions and files in trash (not disk capacity).
- **Antivirus scanning**: the production build has **no scanner configured** (`files.antivirus` health component).
  The page says so.

## Settings and features

- **Settings** (`/admin/settings`, `platform.settings.manage`) — **Available**. Settings are grouped by module. Every
  change requires step-up, uses optimistic concurrency (a conflict if someone changed it first) and is audited. Secrets
  are write-only: the page shows only whether a secret is set and when. **Remove secret** stops dependent features.
- **Features** (`/admin/settings/features`) — **Available**. Installation-wide switches. All default to **off**.

| Feature switch | Owner |
| --- | --- |
| Scheduled daily backups and verification | backup |
| Automated scheduled retention pruning | backup |
| Off-host backup replication | backup |
| Outbound SMTP mail | integrations |
| Microsoft Clarity analytics | integrations |
| PostHog analytics | integrations |
| Stripe webhook adapter | Stripe setup (`/admin/payments/setup`); available from increment 07, off until activated |

Do not turn on the in-app backup schedule if the host uses the `readypackets-backup.timer` systemd timer. Use only
one scheduler ([INSTALL.md](../operations/INSTALL.md#backups-and-audit-forwarding)).

## Sign-in page presentation

**Available** — `/admin/settings/presentation` ("Sign-in page").

- **Slides**: title, text and an image with a required **Image description** (alt text). The sign-in page shows only
  the form when there are no slides.
- **Advance slides automatically** and **Seconds per slide**: visitors can always pause, and a reduced-motion
  preference turns autoplay off.
- **Support text** and **Show an announcement** (a short banner above the sign-in form, with a tone).
- **Images**: PNG, JPEG or WebP up to 2 MiB. Metadata is removed and images are served with strict headers. An image
  used on a slide cannot be deleted.

## Configuration export and import

**Available** — `/admin/settings/transfer` ("Export and import"), step-up.

- **Export configuration** downloads a settings file. **Include secrets** adds only secrets their module allows to be
  exported, encrypted with your passphrase.
- **Import configuration** shows a preview of the differences. Nothing changes until you choose **Apply changes**, and
  the apply step must match the previewed digest.

This moves configuration only. For business data use [Portable transfer](#portable-transfer); for disaster recovery
use [Backups](#backups-and-restore).

## Audit centre

**Available** — `/admin/audit` and its sub-pages. See [ADR 0006](../adr/0006-audit-trail.md) and
[Logging and audit](../operations/LOGGING_AND_AUDIT.md).

| Page | Capability | Use it to |
| --- | --- | --- |
| **Audit center** `/admin/audit` | `audit.read` | Search by ID, quick filters or the AND/OR builder; open event detail; pivot on actor, resource or request; reveal a source address (audited); add events to a case; save a search |
| **Saved audit searches** `/admin/audit/saved` | `audit.read` | Reopen saved searches; delete your own |
| **Investigation cases** `/admin/audit/cases` | `audit.read` (changes `audit.cases.manage`) | Create cases, set status, attach events, add encrypted notes |
| **Audit exports** `/admin/audit/exports` | `audit.export` (step-up) | Request exports with a manifest and SHA-256; at most 3 active per user |
| **Audit integrity** `/admin/audit/integrity` | `audit.read` (checkpoints `audit.retention.manage`) | Verify the hash chain; create signed checkpoints |
| **Audit retention** `/admin/audit/retention` | `audit.retention.manage` (step-up) | Set policies, place and release legal holds, preview and run retention (type `REMOVE` to confirm) |

Every search and view in the audit centre is itself audited. Store checkpoint evidence off the host. The current
database profile does not enforce append-only separation, so review that before setting retention.

## SIEM forwarding

**Available** — `/admin/siem` (`siem.read`; changes need `siem.manage` and step-up).

1. **New SIEM destination**: name, **Forwarding format** (syslog over TLS per RFC 5425, JSON lines over TLS, CEF over
   TLS, or OTLP over HTTPS), receiver host and port, **Minimum severity**, and for OTLP the path and an authentication
   header. Certificate verification is always required; add a CA bundle and client certificate for mTLS if needed.
2. The receiver must also be allowed by the installation's outbound egress policy. **Allow an approved private network
   receiver** is needed for private addresses.
3. A new destination **starts paused**. Send a test, confirm receipt at the collector, then enable it.
4. The destination page shows **Summary** (delivery health, backlog, circuit state, latest test), **Delivery log**
   (7 days of tests and exceptions) and **Quarantine** (dead letters you can replay or purge).

Events are pseudonymised before they leave the portal. Secrets are write-only. See `server/modules/siem/API.md` for
the delivery and ordering guarantees.

## Jobs, schedules, mail and maintenance

**Available** — `jobs.read`; actions need `jobs.manage`, maintenance and acknowledgement need step-up.

- **Jobs** (`/admin/jobs`) and **Job details**: state, attempts and outcome. Cancel queued jobs; retry only jobs
  classified as safe. A job with an **unknown** outcome is never retried automatically. Check the provider, then
  **acknowledge** it; that is an attestation and does not change the outcome.
- **Schedules** (`/admin/schedules`): recurring jobs. Missed slots are skipped, not replayed.
- **Mail** (`/admin/mail`): the outgoing queue and attempts without recipients or content. "Accepted" means the SMTP
  server accepted the message, not that it was delivered. Held or refused messages can be resent while still valid.
  **Captured mail** exists only in development and test; preview and production refuse capture.
- **Maintenance** (`/admin/maintenance`): pause new worker claims and watch the queue drain before an upgrade.
  "Drained" applies to this queue only. Follow the upgrade runbook in [INSTALL.md](../operations/INSTALL.md#upgrade-and-rollback).

## Backups and restore

**Command line and systemd today.** Console pages (**Backups** `/admin/backups`, backup detail, **Restoring a backup**
`/admin/backups/restore` and **Backup retention** `/admin/backups/retention`, all `backup.read`) are **in progress**:
they exist in the working tree but were not committed when this guide was written. In the native profile the web and
worker processes deliberately do not receive the backup key, so use the command line there.

- One-off: `sudo systemctl start readypackets-backup@cli.service`, or `tsx scripts/ops/backup/run-backup.ts --verify`.
- Scheduled: `readypackets-backup.timer` (do not also enable the in-app schedule).
- Verify: `scripts/ops/backup/verify-backup.ts`. Verification is not a restore test.
- Restore drill: `scripts/ops/restore/restore-isolated.ts`, only into an empty isolated database and storage directory.
- Copy encrypted archives off the host and escrow the backup key separately from the archives.

Details: [INSTALL.md](../operations/INSTALL.md#backups-and-audit-forwarding) and `server/modules/backup/API.md`.

## Portable transfer

**Available** — `/admin/portable` (`portable.export` / `portable.import`; every change and download needs step-up).
This is a business-data transfer between ReadyPackets installations, **not a backup**.

- **Export**: **New export** → choose all records, selected customers (with their orders) or selected orders (with
  their owners) → set a transfer passphrase. Keep the passphrase separate from the package. Downloads expire after
  24 hours.
- **Import**:
  1. **Upload a package**. It is quarantined and cannot change anything yet.
  2. **Verify and plan** with the package passphrase. This dry run shows the exact plan. There is no email-based
     linking, no overwrites and no active credentials. Imported orders are read-only.
  3. **Approve** the plan.
  4. Review **Reconciliation**.
  5. A **different administrator** gives final acceptance after independently confirming access, locks and downloads.
- Checkpoints, held content and uncertain outcomes (`held-unknown`) are shown on the import page.
- **Not transferred**: promotions (codes, batches, redemptions), cart upsell offers and carts. Recreate promotions
  on the target. Imported orders keep their promo discount amount and label as history.
- **Not transferred (increment 06)**: the business export leaves out payment receipts and receipt refund notes, policy notices and enforcement records, security incidents, order task notes and waivers, and saved reports. The package manifest lists each exclusion. Backups include all of them.
- **Workflows** are moved separately with workflow export/import (drafts only). Portable transfer carries the
  workflow key only as inert history.
- **Backups** cover every table, but encrypted promo codes and keyed hashes restore correctly only with the same
  encryption and blind-index keys.

Package format and the offline `verify` tool: [portable/docs/CONTRACT.md](../../portable/docs/CONTRACT.md), [portable/API.md](../../portable/API.md) and `server/modules/portable/API.md`.

## Integrations

The dedicated console pages are **in progress** (working tree, not committed when this guide was written):
**Integrations** `/admin/integrations`, **E-mail (SMTP)** `/admin/integrations/smtp`, **Analytics**
`/admin/integrations/analytics` and **Outbound connections** `/admin/integrations/egress`, all `integrations.manage`.
Until they land:

- Turn providers on or off on **Features**, and set their values on **Settings** (groups **mail** and **analytics**).
- SMTP: configure an approved host with authenticated TLS, then confirm delivery to an approved inbox. Never enable
  mail capture in production ([INSTALL.md](../operations/INSTALL.md#install-and-enroll-the-first-administrator)).
- **Off until configured** (available from increment 07): Stripe online payments (`/admin/payments/setup`), SAML single
  sign-on (`/admin/sso`) and Microsoft 365 / SharePoint file sync. Until then, staff record offline payments, local
  sign-in with MFA is the only method, and local encrypted storage is the file backend.

## Production pipeline (Phase I and Phase II webhooks)

**Available** — **Production pipeline** (`/admin/integrations/production`, `integrations.manage`, step-up to save settings)
and the console-only **Production** tab on `/admin/orders/:orderId/production` (`orders.production.trigger`). Off by default;
no live URL, credential or canon version ships with the portal ([ADR 0023](../adr/0023-production-pipeline-webhooks.md)).

### Configuring the production pipeline

1. **Allow outbound egress**: on **Outbound connections** (`/admin/integrations/egress`), add an allow-list rule for your
   webhook receiver host with purpose `webhook`. Destinations must use `https://`, pass pinned DNS resolution, and
   redirects are refused.
2. **Pipeline settings** on `/admin/integrations/production` (step-up on **Save settings**, audited as
   `integration.production.settings.changed`):
   - **Enable production pipeline webhooks** switch.
   - **Canon version** (required before enabling, for example `ReadyPackets_Production_v2.0`; no default).
   - **Request timeout (seconds)** (default `10`, maximum `30`).
   - **Run mode** (default `production`, pattern `^[a-z][a-z0-9_]{0,31}$`).
   - **Phase I (P101) webhook URL** and **Phase II (P201) webhook URL** (`https://` only). Webhook URLs embed secret tokens
     and are stored encrypted — the page shows only the host and last 4 characters, with **Remove saved Phase I (P101)
     webhook URL** / **Remove saved Phase II (P201) webhook URL** controls.
   - **Authorization header name** and **Authorization header value** (optional; value is write-only encrypted, with
     **Remove saved authorization header value**).
3. **Destination allowlist check**: choose **Test Phase I (P101) destination** and **Test Phase II (P201) destination** to
   dry-run the configured URLs against the egress policy and DNS without sending any webhook payload.

### Starting Phase I (P101), starting Phase II (P201) and re-sending

Day-to-day operator steps are in [Staff guide — Starting Phase I and Phase II](./STAFF_GUIDE.md#starting-phase-i-and-phase-ii-production-pipeline).
Key administrator controls and guarantees:

- **Eligibility & validation**: only orders containing packet products (and zero non-packet items) can be sent. Single-packet
  orders send that packet number (`"1"`–`"6"`) and tier; multi-packet orders send `packet = "7"` and `tier = "Mixed"`.
  `bundle_scope_manifest` is sent as an escaped JSON string (`"{\"packet_1\":\"Premium\"}"`), and `order_scope_mode` is
  never sent. Contradictory combinations are refused before anything is queued (`integration.production.dispatch.refused`).
- **Start Phase I** (**Phase I intake (P101)**): writes an encrypted outbox record in the same database transaction and
  delivers it via the background job worker with `Idempotency-Key`, `X-ReadyPackets-Delivery` and correlation headers.
- **Start Phase II** (**Phase II start (P201)**): enabled only after Phase I (`P101`) for the same order reaches
  **Delivered**, and requires checking **"I confirm the Phase I final output artifacts exist for this order ID"** (the
  portal receives no inbound completion callback). `P201` copies the exact `customer_id`, `order_id` and `run_mode`
  recorded on the delivered `P101` so a later reference change cannot split a run.
- **Retries, personal-data clearing and Production dispatches**: network errors, `429` and `5xx` responses retry with
  bounded backoff; other `4xx` responses stop immediately. The encrypted personal-data payload (`client_name`,
  `client_email`) is cleared from the outbox row as soon as the dispatch reaches a final state. Under **Production
  dispatches** on `/admin/integrations/production`, filter across orders by **Order reference**, **Phase** (**All phases**,
  **Phase I intake (P101)**, **Phase II start (P201)**), **State** (**All states**, **Queued**, **Sending**, **Delivered**,
  **Failed (retrying)**, **Dead-lettered**), **From date** and **To date**, and open the correlated audit trail directly.
- **Re-sending (Administrator + step-up)**: at most one delivered `P101` and one delivered `P201` are allowed per order
  by default. Administrators can choose **Re-send Phase I** or **Re-send Phase II** on the order's **Production** tab,
  enter a **Reason for re-send** of at least 8 characters (plus **"I confirm the Phase I final output artifacts exist for
  this order ID"** for Phase II), and choose **Confirm Phase I re-send** / **Confirm Phase II re-send** with fresh step-up
  verification (`integration.production.dispatch.resent`). Audit events never contain webhook URLs, auth headers, client
  names or client emails.

## Microsoft Clarity and PostHog

Both are **off by default**, and both are opt-in per visitor. See [ADR 0011](../adr/0011-analytics-consent.md).

1. **Settings** → group **analytics**:
   - **Microsoft Clarity project ID**: the alphanumeric ID only (6–32 characters), never a script snippet.
   - **PostHog project API key**: begins with `phc_`.
   - **PostHog ingest origin**: `https://us.i.posthog.com`, `https://eu.i.posthog.com`, or an exact HTTPS origin you have
     added to **Allowlisted self-hosted PostHog origins** (up to 8).
2. **Features**: turn on **Microsoft Clarity analytics** and/or **PostHog analytics**.
3. What visitors see: a consent banner. Analytics load only after the visitor accepts, and only on `/privacy` and
   `/terms` with no query string or fragment (for unauthenticated visitors). Sign-in, account, order, file, message,
   invoice and admin paths are permanently excluded.

## E-mail template centre

Open **Console → Integrations → E-mail templates** (`/admin/email-templates`, requires `mail.manage` and fresh step-up
confirmation) to customise built-in system notifications or create reusable custom templates (`custom.<slug>`) for
automations:

- **System vs custom templates:** Every built-in mailer template (`auth.*`, `orders.*`, `compliance.*`, `engagement.*`,
  `platform.maintenance_window`) can be customised, versioned, and reset to its built-in default at any time while
  preserving version history. Required variables (such as single-use reset or verification `{{link}}` placeholders) are
  enforced before publishing in both HTML and plain-text bodies, and sensitive placeholders remain redacted in audit
  copies and retained message previews.
- **Safe HTML and mandatory plain text:** HTML templates are sanitised against an explicit server-side allow-list on
  save and on send, and always include a plain-text alternative (derived automatically from HTML or edited manually).
- **Inert preview & Send test to me:** Preview renders sample variables inside a sandboxed structure-only frame with no
  scripts, outbound links, or external image requests. **Send test to me** queues a `[TEST]`-prefixed message addressed
  solely to the signed-in administrator's own account.

### Receipts and policy notices (increment 06)

Payment receipts, policy update notices and policy enforcement warnings are editable system templates, each with HTML and plain text.

**Receipt PDF:**

- A receipt PDF of up to 690 KiB is attached to the customer's copy only.
- A larger PDF is not attached. The customer still gets the e-mail, with a secure link to Invoices where they can download it.
- Attachment bytes are never put in the audit copy, retained mail, development capture or logs.
- A retry of the receipt reuses the same send intent, so the customer gets one receipt.
- An authorised **Send again** creates its own audited resend.

**Policy notice counts:**

- **Sent** means the mail provider accepted the message. It does not mean the message was delivered or that the policy was accepted.
- **Failed** includes messages whose outcome was not confirmed or is unknown. A failure never triggers an automatic resend.

## Installing as an app (PWA)

The portal ships a web app manifest (`client/public/manifest.webmanifest`, "ReadyPackets Customer Portal") and a
service worker (`sw.js`). Page navigations and `/api` are always fetched from the network, and `index.html` is not
cached, so a revoked session or a new release is never hidden by the cache. Offline visitors see `offline.html`.

Users install it from the browser (see the [Customer guide](./CUSTOMER_GUIDE.md#install-the-portal-as-an-app)). As an
administrator:

- Serve the portal only over HTTPS on the canonical host. Service workers require it.
- Do not let an edge cache store `index.html` or `sw.js` (a [go-live check](../operations/INSTALL.md#go-live-checklist)).
- The update prompt and offline page have **not yet been verified** in real browsers.

## Search engines

The portal is an authenticated application and is intentionally **not indexed**: `/robots.txt` returns
`Disallow: /` ([ADR 0010](../adr/0010-indexing-boundary.md)). Search engine work belongs to the public marketing site.

## Feature status summary

| Area | Status |
| --- | --- |
| Customers, staff, credential administration | Available |
| Orders, packet catalog (`ops:catalog-import`), bundle rule, workflows, order files, sharing | Available |
| Settings, features, sign-in page, configuration transfer, health, setup | Available |
| Audit centre, SIEM forwarding | Available |
| Jobs, schedules, mail, maintenance | Available |
| Portable transfer | Available |
| Policies, intake questionnaires & review, invoices (manual payment/refund ledger) | Available |
| Production pipeline (P101 / P201 manual webhooks, outbox & dispatch monitor) | Available (off until configured) |
| Public `/privacy` and `/terms` draft notices | Available (drafts pending legal review) |
| Backups | Command line and systemd; console pages available for status/metadata |
| Integrations console (SMTP, analytics, outbound connections) | Available |
| Messages, support tickets, notifications, global search | Available |
| Stripe online payments, SAML SSO, SharePoint | Available from increment 07, off until configured |
