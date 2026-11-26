# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). See `docs/engineering/SDLC.md` for the release
procedure.

## Increment 08 (in progress)

<!-- DRAFT by platform_engineer from INCREMENT_08_CONTRACT.md. Every line is checked against the owners' commits before release; lines still marked PENDING-OWNER are not confirmed. -->

Requested by the owner on 2026-11-26 (prompt 34). See the [session log](docs/session-logs/2026-11-26-session-02.md) and the [contract](docs/engineering/INCREMENT_08_CONTRACT.md).
- **Database migration** `0008_increment_08`, additive only. Details are in [UPGRADE.md](docs/operations/UPGRADE.md#increment-08-and-migration-0008).
- **PR and merge commit:** (filled at merge).

### Fixed

- **Payments paid on Stripe stayed "Issued"** (D5). <!-- PENDING-OWNER integrations_engineer: confirm against commits -->
  - A payment is now booked from either a verified signed webhook or an authoritative lookup that this server makes to Stripe with its own credentials. Both go through one idempotent booking function, and whichever arrives second does nothing.
  - The lookup is triggered by the return page, by **Check payment status**, by the scheduled reconciliation job, and by an administrator's **Check with Stripe now** (step-up). The administrator check also repairs payments made before the upgrade.
  - If Stripe does not deliver webhooks, one alert, "Stripe is not delivering webhooks to this server", is raised. `/admin/payments/setup` then shows the last verified webhook, recent rejections, the endpoint URL, the required events and the usual causes.
  - This replaces decision 12 of increment 07 ("never mark paid without a signed webhook"). The browser still never tells the server that something was paid.

### Added

- **Customer order wizard** (D6). Opening a purchased order shows a step-by-step wizard for the current phase, with **Back** and **Next**: Review and accept, Questions, Upload documents, Record or upload audio, then Review and submit. <!-- PENDING-OWNER audit_engineer: confirm against commits -->
  - The former tabs are under **Order details**.
  - A waiting screen always names the next step and the single useful action.
- **Add packets to this project** (D3). An addition is a new linked order in the same project, with its own invoice and payment. Packets the project already has are shown as "Already in this project". <!-- PENDING-OWNER orders_engineer, recovery_ops_engineer: confirm against commits -->
- **Billing information** (D4). It can be saved at registration (optional) or in account settings. At checkout, customers choose "Use my saved billing information" or "Enter different billing information". <!-- PENDING-OWNER compliance_engineer, recovery_ops_engineer, identity_engineer: confirm against commits -->
- **Name parts** (D1). Registration, the profile, and admin customer creation ask for **First name**, **Last name** and **Preferred name** (optional). Greetings use the preferred name, while invoices keep the full name. <!-- PENDING-OWNER identity_engineer: confirm against commits -->
- **Publish button** in the workflow designer header, and a **Publish** row action for drafts on `/admin/workflows` (D7). <!-- PENDING-OWNER ui_foundation_engineer: confirm against commits -->
- **Go-live checklist**: [GO_LIVE_CHECKLIST.md](docs/operations/GO_LIVE_CHECKLIST.md), to run on the owner's server (D8). <!-- PENDING-OWNER assurance_engineer: confirm against commits -->

### Changed

- **Order numbers** (D2). New orders get `RP-<C4>-<F3><L3>-<P6>-<NNN>`, for example `RP-JJG5-ZEUGRE-ICEQUE-001`. Existing orders keep their `RP-YYYY-NNNNNN` reference. <!-- PENDING-OWNER orders_engineer: confirm against commits -->
- **Packet tiers** (D7). Choosing a packet tier expands its outcome and deliverables and collapses the others. <!-- PENDING-OWNER ui_foundation_engineer: confirm against commits -->

### Accessibility

The changed screens are designed and tested against WCAG 2.2 AA. <!-- PENDING-LEAD: sweep facts and limits -->


Requested by the owner on 2026-11-26 (prompt 30). See the [session log](docs/session-logs/2026-11-26-session-01.md).
- **No database migration.** New values use existing settings and columns.
- **Upgrade commands** are unchanged.
- **PR and merge commit:** PR #21, merge commit `762ea41`.

### Fixed

- **Customers placed an order but were not sent to Stripe** (`c082b4e`, `53786b0`). The cause on the owner's server is **not confirmed**: we had no access to its logs, and a real Stripe account is not testable here. Every such failure is now explicit, recorded and recoverable.
  - **Checkout result.** After the order and invoice commit, checkout returns a typed `payment_unavailable` result instead of falling through silently. The customer sees "Your order … is placed, but we could not open the secure payment page", with the order and the invoice, plus **Pay now** when online payment is available.
  - **Pay online with no online provider** (`dd5ddfa`).
    - Before 07.2, `payments.startInvoiceCheckout` returned mode `invoice` when no online provider was active, and the **Pay online** button silently did nothing.
    - It now answers 503 `UNAVAILABLE` / `ONLINE_PAYMENT_DISABLED`, and the customer sees why.
    - The internal service `startCheckout` used by cart checkout still returns mode `invoice`.
  - **Redirect allowlist.** The browser's allowlist now matches the server's (`https://checkout.stripe.com` only).
  - **Return and cancel pages.** `/checkout/return` and `/checkout/cancel` tell "awaiting payment" apart from "pending confirmation", and offer **Pay now** when online payment is available.
  - **Diagnosis.**
    - Every Checkout Session failure gets a specific reason code.
    - The audit events `payments.attempt.failed` (sanitised upstream status and code) and `cart.checkout_payment_start_failed` are written.
    - The operational alert "Customers cannot reach Stripe Checkout" is raised.
    - **Last checkout-session failure** is shown on `/admin/payments/setup`.
- **"Signing secret is not in the correct format"** (`53786b0`). The likely cause, inferred from the owner's screenshot and not confirmed, is a longer value without the `whsec_` prefix in **Primary**, while the 38-character `whsec_` secret was in **Secondary**.
  - **Normalised pastes.** Surrounding quotes and backticks, non-breaking spaces, zero-width characters and wrapped line breaks are removed.
  - **Per-field errors.** Each field gets its own error, which never echoes the value. It recognises publishable keys, API keys in the wrong field, endpoint IDs (`we_…`), masked values, and values too short or too long.
  - **Field controls.** Each field has a Show/Hide control, settings that stop browsers and password managers from filling it, and hints that say where to copy each value in Stripe.
  - **Primary and Secondary** are explained.
- **Characters in PDFs** (`8d20507`). Full WinAnsi characters such as `·`, `•`, `–`, `—`, curly quotes, `€`, `™` and accented letters now print correctly. Other characters are replaced with readable equivalents, never "?".

### Added

- **Verify Checkout session creation** on `/admin/payments/setup` (`payments.admin.verifyCheckoutSession`, step-up, audited `payments.setup.checkout_probe`) (`53786b0`).
  - It creates an unpaid probe session and expires it at once, at no cost.
  - It catches restricted keys without Checkout Sessions Write (`STRIPE_KEY_MISSING_PERMISSION`) and custom Checkout domains (`STRIPE_UNTRUSTED_REDIRECT_URL`).
  - **New activations** need a passing probe for the current key and mode (`47872b8`). This covers switching the provider to Stripe or changing the mode. Without one, the switch is refused with `STRIPE_CHECKOUT_SESSION_NOT_VERIFIED`, and **Activate Stripe Checkout** stays blocked.
  - **Servers already active on Stripe** stay active on upgrade without a probe. There, the probe is a "Recommended check", and only a failed probe for the current key and mode blocks checkout.
- **Pay now on the placed-order page** (`c90b183`). The page offers **Pay now** only when online payment is available. Otherwise it links to the invoice, the order and the payment status.
- **Status banner** on `/admin/payments/setup` (`53786b0`): **Online card checkout: ACTIVE** or **NOT ACTIVE**, what customers experience right now, and the missing gates.
- **Branded invoice, payment receipt and refund note PDFs** (`8d20507`):
  - mark, wordmark, tagline and legal name;
  - brand colours with dark text on light fills;
  - a footer with page numbers, in Letter and A4;
  - an **Order** and **Project** block near the top of page 1.
- **Order and project everywhere** (`8d20507`, `8a9901b`, `fdd5583`):
  - an "Order & project" card on the customer and console invoice and receipt pages, with Order and Project in the lists;
  - Order and Project in the invoice issued, invoice paid and payment receipt e-mails, including under published template overrides.
- **Set as default** on `/admin/workflows` (`orders.admin.workflows.setDefault`) (`4fb93be`).
  - Administrators with `workflows.manage` can set the default, with fresh step-up.
  - It is audited as `workflow.default.changed`.
  - New orders on every create path use the new default's latest published version. Existing orders keep their version.

### Changed

- **Update prompt** (`1be1cc2`). The prompt now reads "ReadyPackets was updated on the server" and explains that this tab still runs the previous version.
  - **Later** hides it only until the next in-app navigation.
  - It never reloads by itself.
  - Below medium width it sits above the phone tab bar, with 44 px buttons.
- **Default issuer details.** The legal name now defaults to "Ready Packets Consulting LLC", and the logo to the ReadyPackets header mark.
  - Invoices that carry the old default "ReadyPackets" show the new name. A name an administrator set is kept.
  - Invoices are drawn on demand, so existing invoices pick up the branding.
  - Stored receipt and refund note PDFs are never rewritten, because of their integrity hash. Their pages and resent e-mails still show the order and project.
- **Restricted-key permissions** are documented: Checkout Sessions Write, Payment Intents Read, and Charges Read (Write for refunds).
- **Rotating secrets.** Rotating the key or the Primary signing secret, or changing the mode or the egress preset, pauses online checkout until the matching check is run again.

### Accessibility

- **Payments pages** (`0cb03fa`). Long reason codes wrap at 240 px, and the disabled **Activate Stripe Checkout** button is linked to its explanation with `aria-describedby`.
- **PDFs.** The PDFs set the document language and title. They mark the content as tagged, give the logo alternative text, and keep the text selectable. **PDF/UA is not claimed**: the standard Helvetica font is not embedded with a Unicode map, and there are no full table structure tags.
- **Screens.** The changed screens are designed and tested against WCAG 2.2 AA.
- **Not done.** No screen-reader pass and no physical-device pass were done.


Requested by the owner on 2026-11-25 (prompts 28 and 29). PR #19. Mostly client-side: the one server change is the single-page app fallback for dotted mail template keys. There is no server permission, schema or migration change, and the upgrade commands are unchanged. See the [session log](docs/session-logs/2026-11-25-session-01.md).

### Fixed

- **"You do not have permission to perform this action" for staff and administrators.** This appeared on step 3 of `/orders/new` and on `/cart` when an administrator used the customer portal. The server rule stays: staff and administrator accounts cannot own orders or carts.
  - `/orders/new`, `/cart`, `/cart/checkout`, `/checkout/return` and `/checkout/cancel` now show staff a handoff panel, "Orders are placed for a customer".
  - The panel's **New order for a customer** button goes to `/admin/orders?new=1`, which opens the console dialog. That dialog accepts a discount code.
  - No cart requests are made for staff, and the customer navigation hides **Create an order** and **Cart** for them.
- **Mail template editor links with a dot in the key.** A full page load, reload or bookmark of an editor such as `/admin/email-templates/auth.password_reset` returned 404 (`916f52a`, `d9f9c50`).
  - The single-page app now serves its page for registered built-in keys and `custom.<slug>` keys only.
  - Other dotted or extension paths, and dotfiles, still return 404.
- **Narrow-width layout.** Several pages no longer overflow or clip at narrow widths:
  - the customer `/orders` progress bar (`6856d8b`);
  - the cart suggestion "Add-on" badge at 1024 px (`6afac07`);
  - the policy acceptances log, coverage tab and the customer Policies tab (`e0aeb58`, `42f0fac`);
  - Graph & SharePoint, which overflowed by 8 px at 320 px, and the production pipeline (`7cef9cb`);
  - the custom report builder's query-mode control (`21a1e30`);
  - the shared DataTable phone cards, which cap the label column at 40% and stack below 320 px (`3178353`);
  - the mail template sensitive-variable badge below 320 px (`b6bd3cf`).

### Changed

- **Visible portal switch.** **Customer portal** is in the console top bar (medium screens and up) and drawer. **Admin portal** or **Staff portal** is in the customer shell top bar, drawer and a staff notice that cannot be dismissed.
  - Staff and administrators opening `/` land on `/admin`, unless this browser tab chose the customer portal. The choice is per tab and is cleared at sign-out.
  - Customers never see the switch.
  - The switch is first in both mobile drawers. The staff notice shows its switch button only below medium width, because the top bar has one above that (`92d3c3b`).
- **Phone tab bar labels.** They are now Home / Orders / New order / Messages / More.
- **Discount code hints.**
  - The field is in the cart summary once the cart has an item, and at checkout. Both depend on **Discount codes** being switched on at `/admin/promotions` (off when shipped) and the cart being on at `/admin/settings/features`.
  - An empty cart says "Have a discount code? Add an item first to apply it here or at checkout."
  - The order form's Review step says "Have a discount code? You can enter it in your cart and at checkout."
- **QA tools.** `scripts/qa` gained an opt-in context-reuse mode and deferred retries, plus fixtures for staff in the customer portal and for forms ([scripts/qa/README.md](scripts/qa/README.md)).

### Accessibility and responsive

- **Scrollbars.** Both navigation rails have a thin themed scrollbar, with a forced-colours fallback.
- **Landmarks.** The staff, preview and maintenance notices are named complementary landmarks (axe `region`, `cf39e10`).
- **Accessible names.** Prohibited accessible names were removed in 8 files, and a source guard test was added (`6e215e6`).
- **Canvas targets.** The flow canvas fit zoom floor went from 0.75 to 0.8, so step and transition targets stay above 24 px (`389dfa6`).
- **Sweep.** All runs used Chromium, synthetic QA data and QA builds of this branch.
  - **Responsive matrix:** 3,712 cases (232 states × 8 widths from 240 to 2560 px × light and dark). 3,656 passed on the first fix build, with 24 failures in 12 states, all fixed since.
  - **axe (WCAG 2.2 A and AA plus best practice):** 1,392 cases, with 33 cases of violations, all cleared. The final confirmation runs had no violations.
  - **Manual checks:** a keyboard and zoom pass, including 200% and 400% browser zoom.
  - **Not checked:** 16 route states that have no fixture.
  - Details are in [STATUS.md](docs/application-context/STATUS.md#verification-for-increment-071).
- **Limits.**
  - Chromium only; no Safari or Firefox run.
  - No physical phones or tablets.
  - No screen-reader pass (NVDA, JAWS, VoiceOver or TalkBack).
  - The axe incomplete items, mainly contrast, were not reviewed by hand.
  - The interfaces are designed and tested against WCAG 2.2 AA. This is not a conformance claim.

## Fixes after increment 05

### Fixed

- **Authenticator setup no longer locks** ([ADR 0046](docs/adr/0046-authenticator-setup-supersede.md)). A person who abandoned authenticator setup and signed in again was refused for up to ten minutes with "An authenticator setup is already in progress".
  - A new sign-in now gets a new QR code at once. The earlier setup is discarded, is never shown to the new session, and the replacement is audited (`auth.totp.enrollment_superseded`).
  - A setup that expired or was replaced now says so (`TOTP_SETUP_EXPIRED`, `TOTP_SETUP_REPLACED`), and the setup page shows a new QR code with instructions instead of "the code was not accepted".
  - The setup page states that the QR code and setup key work for 10 minutes.

### Changed

- The owner confirmed the redelivery and retry rules of ADR 0041 (no code change).

## Increment 07

Requested by the owner on 2026-11-24 (prompt 26) and checked in the lead's QA on 2026-11-25. What was and was not verified is recorded in [STATUS.md](docs/application-context/STATUS.md#verification-for-increment-07).

### Added

- **Phases-first workflows** ([ADR 0055](docs/adr/0055-phases-first-order-workflow.md)):
  - definition format 3, with up to 20 named phases the customer sees;
  - a customer phase wizard with Next and Submit and lock, acknowledgement evidence, staff review and an administrator reopen with a reason;
  - questions with versioned answers, and an administrator checklist.
  - Formats 1 and 2 keep working and show derived phases. Existing orders are never re-pinned.
- **Progress bar** on every order. Each phase counts by its weight (1–100, default 1), and the derived value is floor(done weight × 100 ÷ total weight), capped at 99 until the order reaches a `done` status. The bar shows the higher of that and an explicit completion update, and it goes down only on an audited administrator reopen. It has no animation under reduced motion.
- **Standard workflow.** A fresh install gets the phases "ReadyPackets standard workflow", starting with **Payment**. On upgrade, the default workflow gets a phases draft to review and publish, and nothing is published automatically.
- **Status catalogue** (`/admin/workflows/statuses`, [ADR 0056](docs/adr/0056-status-catalogue-and-attention.md)) and the "Awaiting staff review" / "Awaiting customer response" filters on `/admin/orders`.
- **Phase actions** ([ADR 0057](docs/adr/0057-phase-actions-completion-rules.md)):
  - a human-confirmed bundle of status, completion (fixed or a range drawn once), e-mail, webhook and dashboard alert, with an optional delay of up to 30 days;
  - rule ordering and new payment, intake and phase triggers;
  - unattended rules never change status.
- **Operational alerts** (`/admin/alerts` and an `/admin` widget, [ADR 0058](docs/adr/0058-outbound-webhooks-and-operational-alerts.md)):
  - P101 / P201 lifecycle auto-queue, off by default per workflow. P101 is queued when a real payment is recorded (a Stripe webhook or a recorded manual payment), not when an administrator's status change passes the payment phase, and never retroactively. P201 is queued when the intake phase is submitted, after a delivered P101;
  - production pipeline payload signing, off by default (generate a secret first). New webhook subscriptions are signed by default and start paused;
  - stop, retry and redeliver on deliveries;
  - integrations hub cards that show live state, with the old planning placeholders removed.
- **Phase-bound files** ([ADR 0059](docs/adr/0059-phase-bound-files.md)):
  - per-phase limits, with audio duration checked on the server;
  - on a phases order, every customer upload names the current phase and an enabled upload action (`STAGE_REQUIRED` otherwise). Orders on older workflow formats keep uploads without a phase;
  - WAV and other audio keep the original and add a WebM/Opus copy (a re-encode);
  - playback grants with range requests;
  - phase ZIP, and a whole-order ZIP for administrators behind step-up. ZIPs hold the current customer-visible versions, so audio is the WebM/Opus copy. Files are named `<order ref>-<phase slug>.zip` or `<order ref>-all-files.zip`.
- **Stripe completion** (`/admin/payments/setup`, [ADR 0060](docs/adr/0060-stripe-completion-and-payment-state.md)):
  - an order payment state, and a "Pay online" button on invoices;
  - bank debits wait for the asynchronous success event;
  - a setup checklist, self-tests and a rejections log;
  - activation needs the egress preset, a successful API check and a self-test for the current staged key and mode, then a confirmation. Live mode also needs the typed words `ACTIVATE LIVE PAYMENTS`;
  - a paid session with portal metadata that matches no order is flagged for staff, with a warning alert;
  - card payments below Stripe's minimum charge still follow `payments.small_totals`.
- **Microsoft 365 / SharePoint sync** ([ADR 0061](docs/adr/0061-microsoft-365-file-sync.md)):
  - one-way, per phase, with originals, conversion-staging and intake-delivery targets under `CustomerName-CustomerID/OrderNumber`;
  - a write test, and resync with a dry run.
- **SAML 2.0 with Microsoft Entra ID** (`/admin/sso`, [ADR 0062](docs/adr/0062-saml-entra-id.md)):
  - SP-initiated, with signed assertions and pinned certificates;
  - MFA modes `claim` (recommended for new setups), `entra` (behind the typed words `ENTRA MANAGES MFA`) and `portal`. An upgraded existing SSO configuration starts in `portal`, and switching protocol disables SSO until it is enabled again;
  - a local administrator with MFA always remains.

### Not built

- **Document conversion profiles** (they need LibreOffice or Ghostscript on the server).
- **Two-way SharePoint sync.**
- **Unattended status changes.**
- **Some SAML features:** IdP-initiated SAML, single logout and encrypted assertions.
- **Stripe Elements.**

### Operations

- **Migration `0007_increment_07`**: additive. 16 new tables, 40 new columns on 11 existing tables and one widened enum (`payment_webhook_events.status`) in 96 statements, with no `DROP`. Reported by /root at `f4fa798`: it applied cleanly on a copy of an increment 06 database (189 → 205 tables, 8 migrations), and existing orders got `payment_state = not_required` and `attention = none`.
- **Upgrade notes:** [UPGRADE.md — increment 07 and migration 0007](docs/operations/UPGRADE.md#increment-07-and-migration-0007). It covers the hash check against one journal row, the SAML proxy paths, playback range pass-through and the Stripe webhook's country-only exemption.

## Increment 06

<!-- platform_engineer: from INCREMENT_06_CONTRACT.md and the owners' handoffs. Verification is recorded in docs/application-context/STATUS.md; PR #13. -->

### Added

- **Recording on orders** ([ADR 0047](docs/adr/0047-recording-and-preflight.md)): a Record button wherever audio is accepted.
  - **Formats.** The browser picks its best format at runtime. Without a recorder, the device's own recorder or an upload is offered.
  - **Preflight.** The check covers the microphone, the level meter and a 5-second test that never leaves the device.
  - **Conversion.** The server converts recordings to WebM/Opus. This is a high-quality re-encode, not a bit-identical copy, and the original is kept.
  - **Defaults.** On by default: 128 kbps, 30 minutes.
- **Installable app (PWA)** ([ADR 0048](docs/adr/0048-pwa.md)):
  - an "Install app" entry, with steps for iOS, iPadOS and macOS Safari;
  - shortcuts and maskable icons;
  - a service worker that caches only public static files.
- **Reports** (`/admin/reports`, [ADR 0049](docs/adr/0049-reports.md)):
  - built-in reports for orders, customers, referrals, support, payments and discounts, carts, files and sign-ins;
  - custom reports for administrators from whitelisted datasets, with no free-form SQL;
  - CSV export with step-up.
- **Phase tasks** ([ADR 0051](docs/adr/0051-phase-tasks.md)):
  - four task kinds: upload, acknowledge (including an order note), record, and respond to a document;
  - file types restricted per task and checked on the server;
  - workflow package `formatVersion` 2.
- **Word documents in the portal** ([ADR 0052](docs/adr/0052-word-editing-in-portal.md)): documents are edited in the browser, and each save is a new version.
  - Headers, footers, tracked changes, comments, text boxes, footnotes, complex fields and exact layout are not kept in the edited version.
  - The original is never changed.
- **Policies** ([ADR 0053](docs/adr/0053-policy-notices-and-enforcement.md)):
  - import from Word, Markdown or PDF (PDF is text only);
  - an update notice with a countdown and "Send notice to everyone now";
  - optional enforcement that ends sessions after a warning and grace period (off by default);
  - a typed-name check against the account name (on by default);
  - an order agreement (MNDA) gate (off by default).
- **Receipts** ([ADR 0054](docs/adr/0054-receipts.md)):
  - one receipt per confirmed payment, as a branded PDF;
  - e-mailed and listed under Invoices → Receipts;
  - refunds add a refund note.
- **Discount limits:**
  - the percentage can be set from 0.01 % to 100 %, with two decimals;
  - a new "Set order total to" kind for $0.00 and $0.01 test orders;
  - limits are editable on the Discount codes page.
- **Cart suggestions:** a starter set built from the catalogue is seeded disabled, with a switch at the top of the page and "Enable all" / "Disable all".
- **Workflow export and import:** on by default, with Export, Export selected, Export all and Import on the Workflows page.
- **Side panel:** a stronger accent in both themes.

### Security

- **Sign-in bans** ([ADR 0050](docs/adr/0050-signin-bans-backoff-correlation.md)):
  - automatic, escalating IP bans for repeated sign-in failures;
  - loopback, trusted proxies and allow-listed entries are never banned, and nothing is banned while client addresses cannot be determined;
  - a break-glass command clears bans.
- **Back-off:** progressive rate-limit back-off, with `Retry-After`.
- **Correlated incidents** (`/admin/audit/incidents`):
  - covers brute force, spraying, stuffing, MFA fatigue, ban evasion and similar patterns;
  - incidents are forwarded to the SIEM as `security.incident.*` and `security.ban.*`.
- **Document conversion:** runs in the browser only, with size, page and ZIP-ratio guards, and the CSP keeps no `unsafe-eval`.

### Operations

- **Totals below the card minimum.** Stripe refuses card charges below its minimum (0.50 USD or the equivalent). `payments.small_totals` defaults to `waive`: the amount is recorded as waived and shown on the receipt. Set it to `block` to refuse such orders instead.
- **Migration `0006_increment_06`** (`d9b84c2`) is additive. There are no drops, renames or data rewrites.
  - **New tables (17):** `compliance_payment_receipts`, `compliance_receipt_refund_notes`, `order_task_notes`, `order_task_waivers`, `policy_enforcement_actions`, `policy_enforcement_preferences`, `policy_notice_preferences`, `policy_notice_recipients`, `policy_notices`, `protection_signin_bans`, `protection_signin_strikes`, `report_definitions`, `report_runs`, `security_correlation_state`, `security_incident_events`, `security_incident_timeline` and `security_incidents`.
  - **Other changes:** 13 added columns on 8 existing tables, and one enum widening (`promo_batches.discount_type` gains `set_total`).
  - **Indexes and keys:** only new indexes and foreign keys.
- **Runtime:** Node ≥ 22.13 and < 23. The upgrade commands are the same as for increment 05.
- **Upgrade notes:** [UPGRADE.md — increment 06 and migration 0006](docs/operations/UPGRADE.md#increment-06-and-migration-0006). They cover the service-worker and manifest headers, and the upload size for recordings and file uploads.
  - On managed Nginx or Caddy, the multipart limit stays at 256 MiB. Legacy Nginx rises from 55 MiB to 256 MiB.
  - Uploaded or captured audio sources follow the Files hard maximum, which is 100 MiB and configurable.

## Increment 05

### Added

- **Workflow export and import** (`/admin/workflows`), per [ADR 0042](docs/adr/0042-workflow-transfer.md). Enable `orders.workflow_transfer.enabled` first.
  - Export one workflow, a selection or all of them as an integrity-checked JSON package (`workflows.export`).
  - Import with a preview, then choose for each workflow to create it, add it as a draft or skip it (`workflows.import`, administrators, step-up).
  - Imports are always drafts. Automations are not transferred.
- **Cart suggestions** (`/admin/carts/suggestions`, `/cart`; [ADR 0043](docs/adr/0043-cart-upsell.md)): enable `feature.cart.upsell` (needs `feature.cart`). Up to three server-priced add-on, tier-upgrade or bundle-completion suggestions appear in the cart. Nothing is added without the customer's action. Administrators manage offers with `carts.upsells.manage`. `cart.abandoned_ttl_hours` (default 72) sets when inactive carts expire.
- **Discount codes and links** (`/admin/promotions`, `/promo`; [ADR 0044](docs/adr/0044-discount-codes.md)): enable `feature.promotions`.
  - Percent or fixed codes with scope, dates, limits, allow-lists and single-use batches of up to 5,000 codes.
  - Links (`/promo#promo=<CODE>`) carry the code in the URL fragment, and it is kept only in the browser tab.
  - Redemption is atomic at order creation. The "Largest discount per order" guard (setting `promotions.policy`, field `maxDiscountPercent`) defaults to 50%.
  - Codes work in the cart, at checkout and in the order wizard, not in API v1.
  - A redemption is released only when nothing was paid, no invoice is payable, no provider capture is pending and no online payment was ever started, and only once the order is in a cancel state; administrators can release one by hand under the same rule.
- **Policy acceptance log centre** (`/admin/policy-acceptances`; [ADR 0045](docs/adr/0045-policy-acceptance-log-centre.md)): Log, Coverage and Policy updates tabs, and a **Policies** tab on the admin customer profile. It is always on and read-only. Reading needs `policies.acceptances.read`; CSV export needs `policies.acceptances.export` and step-up, and is limited to 5,000 rows.

### Security

- **Discount code abuse controls:** each code check is rate limited per account and per address. After 5 failed checks in 15 minutes, checking is paused for 15 minutes, and `promotion.attempts_blocked` is sent to the SIEM. Every refusal uses the same message, a verified e-mail is required, staff cannot redeem for themselves, and codes are never logged.
- **Import package handling:** size, depth and count limits, strict schema, digest check (not a signature), and no rendering of imported text as HTML.

### Operations

- **Migration `0005_increment_05`**: additive only (8 new tables, 9 new columns on `orders`, `carts` and `policy_acceptances`, plus indexes and constraints). No existing column is changed or dropped. `deploy/upgrade.sh` applies it; see [UPGRADE.md](docs/operations/UPGRADE.md).
- **Reverse proxy:** the two workflow-import requests accept a body of up to 4,456,448 bytes; every other request keeps the 256 KiB limit. Refresh the nginx or Caddy configuration from `deploy/` when upgrading, otherwise larger workflow packages are refused by the proxy.
- All four features except the acceptance log are off after the upgrade. Switch them on under **Settings** (`/admin/settings`: "Workflow export and import") and **Features** (`/admin/settings/features`: "Cart suggestions (upsell)", "Discount codes and links").

## Increment 04

### Added

- **Workflow phases and requirements** (`/admin/workflows`): enable `orders.workflow_rules.enabled`, then publish a workflow version with phase locks, upload slots and acknowledgements.
- **Console order tools** (`/admin/orders`, `/admin/customers/:customerId`): create and reassign by capability with no switch; enable `orders.console_access.enabled` to grant or revoke delegated access.
- **Audio recording and conversion** (`/admin/files`): enable `files.audio_conversion.enabled` for browser recording and local WebM/Opus conversion; the original is retained.
- **Customer maintenance** (`/admin/maintenance`): enable the customer access notice and set a window separately from worker drain; staff and administrators can still sign in.
- **Knowledge Base and Help Centre** (`/admin/knowledge`, `/help`): enable `feature.knowledge` and publish customer-facing articles.
- **Community forum** (`/admin/community/settings`, `/community`): enable `feature.community` and configure categories, posting rules and moderation.
- **Referrals** (`/admin/referrals`, `/account/referrals`): enable `feature.referrals` and configure `referrals.program` for reward rules and approval.
- **Inbound API v1** (`/admin/api`, `/admin/api/log`): enable `publicApi.enabled` and issue scoped keys; eligible logged requests can be replayed with fresh verification.
- **Signed webhooks** (`/admin/integrations/webhooks`): enable `feature.integrations.webhooks`; configure inbound endpoints or outbound subscriptions and review or rerun eligible deliveries.
- **Cookies and consent** (`/admin/privacy`): enable `feature.privacy.consent` for the preference centre and ledger; `feature.integrations.posthog` and `feature.integrations.clarity` separately gate their vendors.
- **Cart and checkout** (`/admin/carts`, `/cart`): enable `feature.cart`; server-side pricing, orders and invoices work without an online payment provider.
- **Hosted online payments** (`/admin/payments`): set `payments.config.provider` to Stripe or Square after testing; `none` keeps invoice payment. [ADR 0035](docs/adr/0035-hosted-checkout-payments.md) partially supersedes ADR 0014.
- **Storage Copy log** (`/admin/storage/copies`): no separate switch; records attempts when order files, backups or SharePoint order data are copied to enabled destinations.

### Changed

- **Customer navigation** (customer portal): desktop sidebar, smaller-screen drawer and phone shortcuts with More, with no separate switch; feature-dependent links stay hidden while off.
- **Theme and responsive layout** (portal and console): System, Light and Dark are available without a feature switch; shared controls and layouts adapt to screen size.
- **Accessibility** (`/accessibility`): public accessibility information and UI designed and tested against WCAG 2.2 AA; see the [verification record](docs/verification/ACCESSIBILITY.md) for coverage and gaps.
- **Unknown mail outcomes** (`/admin/mail`): no automatic resend or failover; an administrator may queue a separate send after fresh verification and explicit acknowledgment of duplicate risk. No feature switch.

### Security

- **Application Protection** (`/admin/protection`): starts in Detect mode; review events before switching to Enforce or adding IP/country controls. Rate-limit budgets remain bounded.
- **Session centre and restrictions** (`/admin/sessions`, `/admin/sign-in-log`, `/admin/session-restrictions`): logs and session-ending tools are available by capability; restrictions apply only as configured.
- **Payment confirmation** (`/admin/payments`): enabled providers require both a valid webhook and matching payment details fetched from the provider; the browser return cannot mark an invoice paid.

### Operations

- **Native upgrade** (`deploy/upgrade.sh`): `0003_increment_04` is additive, with 48 new tables and 10 nullable columns on existing tables. Keep the encrypted backup and keys off-host before migration.
- **Media and country data**: native install, upgrade and the image include FFmpeg and `prlimit` for optional audio conversion. The operator provides any optional country MMDB locally; no network lookup.

### Added — part B, console order workspace

- **Console order page** (`/admin/orders/:orderId`): a header with Rename order, Change reference, Reassign customer, Invoice and Refund, then status, payment and total badges. The tabs, in order, are Overview, Phases, Intake, Files, Messages, Automation, Sync, Invoices, Refund, Order history, Acceptances, Notes and Sharing. Each has its own address, and on narrow screens they become a drop-down list. No feature switch.
- **Rename an order**: needs `orders.rename` (staff and administrators). The check is version-aware and the reference does not change. Each rename writes the audit event `order.renamed`, which records lengths only, and keeps the old and new names in the order's name history. Staff see "Renamed: old → new" in Order history; customers see "Order renamed".
- **Order history** (replaces Activity): the order's status transitions next to its audited activity, paginated and filterable by category. Customers see only the subset meant for them.
- **Automation tab** (formerly Production), per [ADR 0041](docs/adr/0041-order-automation-tab.md):
  - The Phase I and Phase II cards say why a button is disabled.
  - Pipeline history per order, with Retry for failed dispatches.
  - Redeliver needs `orders.production.redeliver`, step-up, a reason and the phrase `REDELIVER`.
  - Optional Phase III and Phase IV endpoints, hidden until configured.
  - "Run actions" for workflow stage automations needs `orders.automations.run`.
- **Refunds**, per [ADR 0038](docs/adr/0038-provider-refunds.md), which supersedes "refunds are manual" in ADR 0035:
  - Stripe and Square refunds go through the provider's API, idempotent per refund; an unknown outcome is reconciled and never resent.
  - Manual payments get recorded refunds.
  - Needs `payments.refund` (administrators), step-up and the phrase `REFUND ORDER`.
- **Policy acceptance gateway**, per [ADR 0039](docs/adr/0039-policy-acceptance-gateway.md): a workflow gate at order start or before a named step, with a checkbox or typed-name signature. The server refuses work on the order until each acting user accepts, and the evidence is append-only. There is an Acceptances tab and a printable receipt.
- **Order file sync and folder routing**, per [ADR 0040](docs/adr/0040-order-file-sync-folder-routing.md):
  - Folder templates per slot, with a workflow default, edited in the workflow designer and validated on save and at copy time.
  - Uploads, recordings and converted audio are copied to the connections assigned to order files.
  - Per-order SharePoint sync (or File sync) tab, with Retry for failed transfers (`files.manage`).

### Operations — part B

- **Migration `0004_increment_04_part_b`**: additive only. It adds 3 tables (`order_name_history`, `order_policy_acceptances`, `payment_refunds`), 13 nullable columns and indexes, and is applied by `deploy/upgrade.sh`. See [UPGRADE.md](docs/operations/UPGRADE.md).

## [Unreleased]

### Added

- Increment 03 (administration and integrations). See `docs/engineering/INCREMENT_03_CONTRACT.md` and ADRs
  0024–0028. Everything below ships turned off until an administrator configures it.
  - **E-mail delivery**: sender name and address, reply-to, an audit copy mailbox (a copy of every outgoing
    message, with one-time links removed), SMTP and Microsoft Graph transports with a primary and a secondary
    route (the secondary is used only when the primary definitely did not accept the message), optional
    encrypted retention of sent content, and a "View message" action on the Mail page.
  - **E-mail template centre**: system templates for registration, password reset, maintenance windows, order
    confirmation, invoices and more; custom templates; rich HTML or plain text; declared placeholders;
    versions with publish and restore; inert preview and test send.
  - **Settings forms**: every setting can be edited through a generated form, with the JSON editor kept as a
    second tab.
  - **Order workflow designer**: step-by-step wizard and a drag-or-keyboard canvas over the same draft, with
    validation, "Tidy layout", and versioned publishing (existing orders keep their version).
  - **Automations**: event, schedule and manual triggers; conditions; actions (templated e-mail, in-app
    notice, webhook); wizard and canvas builders; test without sending; run history; portal-wide switch and
    rate limits.
  - **Microsoft Entra ID single sign-on** (OpenID Connect, one tenant): configuration page, "Sign in with SSO"
    button on the sign-in page when enabled, account linking, optional first-sign-in account creation (never
    administrators), local break-glass sign-in for administrators, and a host-side `recover-admin` command.
  - **Storage connections**: Amazon S3, Wasabi, Backblaze B2, custom S3-compatible, Azure Blob, Dropbox,
    Google Drive, SharePoint library and OneDrive for Business as copy destinations for order files and
    backups, with per-provider forms, connection test, and outbound allow-list presets.
  - **SharePoint order sync**: one-way mirror of order rows to a SharePoint list, with backfill and per-order
    status.
  - **Off-site backups**: verified encrypted backups can be copied to assigned storage connections; the
    Backups page shows a 3-2-1 status computed from real verified copies.
  - **Native upgrade**: `deploy/upgrade.sh` and `docs/operations/UPGRADE.md`; the `native-install` workflow
    now also installs the previous release, adds data, upgrades and smoke-tests.

### Changed

- Customer IDs for new customers are `RPCUS-` followed by nine characters from 0-9 and A-Z drawn from the
  operating system's random source. Existing customers keep their ID.

- Native auto-installer for fresh Ubuntu 26.04 LTS servers (amd64 and arm64). Installs prerequisites and
  checksum-pinned Node.js and pnpm, can add swap, and configures public or self-signed TLS for a fixed portal
  host and optional redirect alias. It loads the bundled offerings and saves the first administrator's
  temporary password in a root-only file with one-time display. See the [operator guide](docs/operations/AUTO_INSTALL.md).
- Docker Compose stack for evaluation and testing on any host name (`deploy/docker/`): digest-pinned image
  build, generated secrets in volumes, MySQL 8.4 with required TLS and least-privilege accounts, Caddy with
  automatic certificates, a one-command server setup (`install-vps.sh`) and an operator wrapper
  (`rp-docker.sh`). The `container` workflow builds and exercises the stack end to end.

### Fixed

- Dialogs no longer make the browser report a Content-Security-Policy violation: the scroll lock used by the
  dialog library tried to add a `<style>` element, which the portal's policy forbids. It now relies on rules in the portal's own stylesheet.
- `deploy/upgrade.sh` no longer stops at the draining phase with "clean shutdown not proved": it read each
  service's exit record after disabling the service, when systemd had already dropped the record. It now
  stops, checks and then disables, and the refusal prints the record it read.
- E-mail confirmation: a confirmation link followed inside the portal while the "Confirm your email" page
  is already open is now used (the preview profile's demo link did nothing before), the server is called
  once per link, and a signed-in person whose address is already confirmed sees "Email confirmed" with
  "Continue" instead of a "Send a new link" button that had nothing left to do.
- Removing analytics vendor data no longer throws where the browser refuses cookie access (for example a
  sandboxed frame).
- Forced password change after the first sign-in: the page now asks for the "Temporary password" (with a
  hint), no longer shows the misleading advice about passwords "used here before", reports a wrong
  temporary password on that field, and gives password managers the account's sign-in name so that a
  password saved for another account on the same address is not filled in.

## [0.1.0] - Unreleased

### Added

- Initial secure rebuild of the ReadyPackets customer portal, staff workspace and administration console:
  local authentication with mandatory MFA, modular server (identity, assurance, orders, files, engagement,
  compliance, audit center, SIEM forwarding, platform settings, jobs and mail outbox, portable export/import,
  backup, integrations), hardened HTTP edge, and the React client.
- Portable package contract v3 with a standalone verifier and a deterministic synthetic golden fixture.
- Continuous integration and security scanning workflows, Dependabot configuration, code owners, issue and
  pull request templates, `SECURITY.md`, and the SDLC guide.

### Security

- Security reviews and their remediation status are recorded in `docs/security/`.
