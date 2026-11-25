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
- [Alerts](#alerts)
- [Microsoft 365 file sync](#microsoft-365-file-sync)
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

## Alerts

<!-- platform_engineer: from jobs_engineer's D6 handoff; verification PENDING-LEAD. -->

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

<!-- platform_engineer: from portable_ops_engineer's D12 handoff; verification PENDING-LEAD. -->

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

## Storage copy log

Open **Storage → Copy log** (`/admin/storage/copies`) as an administrator. The log tracks attempts to copy order files, off-site backup archives and SharePoint order data. History begins at rollout; it does not reconstruct older attempts.

- **Filter and inspect**: Filter by source kind, destination, state, or a UTC date range. The default is seven days and each search can span up to 90 days. Search by source or destination ID, destination name, correlation ID or safe error code. Open **Details** for the destination, bytes when known, attempt number, timestamps and verification method.
- **Read the result**: **Written** means the provider accepted the write, not that a separate check confirmed it. **Verified** means a checksum matched or the provider read-back confirmed the result recorded by that integration. SharePoint checks the order identifier, not the full record, so its writes are recorded as **Written**, not **Verified**. **Not written** can mean canceled or no change was needed. An interrupted job without a confirmed outcome is shown as **Failed**; check the provider before assuming nothing was written.
- **Investigate and retry**: A **Copies failing** signal in System health flags recent recorded failures or unconfirmed outcomes. Select **View audit trail** in **Details** to search the Audit centre by correlation ID. For an eligible failed backup copy, **Retry backup copy** requires step-up verification and queues a new job; the original remains in the history. For other failed attempts, use the source module's recovery process.
- **Export**: **Export CSV** downloads up to the 1,000 newest matching attempts and records an audit event. Narrow the date range or other filters if the export is truncated. Handle the file as an operational log; it contains customer-resource and destination identifiers.

## Where to switch things on

<!-- platform_engineer: paths checked against the client route definitions on feat/increment-06. -->

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
| Stripe webhook adapter | integrations (**Disabled in this release**; cannot activate online payment) |

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
- **Disabled in this release**: Stripe online payments (staff record offline payments), SAML single sign-on (local
  sign-in with MFA is the only method) and SharePoint storage (local encrypted storage is the file backend). These
  refuse activation on the server.

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
| Stripe online payments, SAML SSO, SharePoint | Disabled in this release |
