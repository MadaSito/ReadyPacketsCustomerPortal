# ReadyPackets go-live acceptance checklist

Run this checklist against the release candidate on the owner's server. Use an isolated, production-like copy for destructive, failure, and recovery drills; record which host and configuration each case represents. This is an unexecuted test plan, not a certification or a record of tests already run.

**Run record:** Release SHA/tag: ____ | Environment alias: ____ | Run ID: ____ | Window (UTC): ____ | Release owner: ____

Use synthetic accounts, orders, contact details, files, and recordings. For example: Zeus Greene, preferred name Z, customer reference `RPCUS-A1B2CJJG5`, project `Ice Queen`. Use test inboxes and approved destinations. Keep evidence in an access-controlled store, not in Git. Reference redacted screenshots, reports, or logs by evidence ID; never include keys, signing secrets, passwords, codes, card or address data, private URLs, signed links, or unredacted payloads. For each case mark exactly one result and record a tester and UTC date. If a capability is out of launch scope, leave its test unmarked and document its approved exclusion plus evidence that it is disabled or unreachable. An unrun required case is not a pass.

Use the [installation guide](INSTALL.md), [administrator guide](../guides/ADMIN_GUIDE.md), [staff guide](../guides/STAFF_GUIDE.md), and [logging and audit runbook](LOGGING_AND_AUDIT.md) for exact operator actions. Record the approved launch scope and which tests require the actual owner-server edge or provider endpoint before starting.

## Server and TLS

### 01 · LIVE-01 · Native or container deployment health

- **Steps:** Confirm the deployed SHA and deployment profile. Check web, worker, DB/storage connectivity, `/healthz` and `/readyz` at the edge and via the documented local check. Run one synthetic background job and review the completion event.
- **Expected:** Correct release, healthy edge and local responses, and a worker that completes work; DB and application listeners are not directly reachable from the internet.
- **Result:** ☐ Pass ☐ Fail | Evidence: ____ | Tester / UTC date: ____

### 02 · LIVE-02 · DNS, certificates, and edge policy

- **Steps:** Validate canonical DNS, certificate chain, expiry and renewal; test HTTP-to-HTTPS, configured alias redirects, unknown-host rejection, and TLS negotiation. Verify the maintenance fence on an isolated deployment and inspect caching of navigation HTML and `sw.js`.
- **Expected:** Trusted canonical certificate; only TLS 1.2/1.3; aliases redirect when configured; unknown hosts rejected; fenced ingress blocks public traffic; the edge does not cache navigation HTML or `sw.js`.
- **Result:** ☐ Pass ☐ Fail | Evidence: ____ | Tester / UTC date: ____

## Accounts and MFA

### 03 · LIVE-03 · Local sign-in, recovery, and step-up

- **Steps:** Enroll local MFA for synthetic customer and admin accounts. Sign out; verify valid password without a valid factor cannot sign in. Try authenticator, enabled passkey and one-time recovery code paths; retry the used recovery code. Revoke a test session, then cancel and complete fresh MFA on a protected admin action. Confirm a second administrator and approved recovery path exist.
- **Expected:** No external sign-in dependency; MFA and revocation enforced; a recovery code cannot be reused; cancellation does not mutate state. If deliberately configured for launch, separately exercise managed Entra sign-in, name-claim mapping, and the local recovery path.
- **Result:** ☐ Pass ☐ Fail | Evidence: ____ | Tester / UTC date: ____

## Registration and names

### 04 · LIVE-04 · Names from registration to invoices

- **Steps:** Register with first and last names, with and without a preferred name; verify email and sign in. Try blank required names and values above the limits. Edit the profile and exercise admin creation/edit and invitation. Sign in to a pre-upgrade synthetic account and save its derived names; include a single-token legacy name.
- **Expected:** First and last are required, preferred optional; each allows at most 80 characters. Greetings and mail use preferred name or first name, while legal/billing contexts keep the full name. Legacy users can sign in; derived parts persist when the profile is saved. In DevTools confirm `given-name`, `family-name`, and `nickname` autocomplete.
- **Result:** ☐ Pass ☐ Fail | Evidence: ____ | Tester / UTC date: ____

## Catalogue and ordering

### 05 · LIVE-05 · Published catalogue, tier selection, and totals

- **Steps:** Verify supported tiers, prices and descriptions against approved catalogue data. Select two tiers in succession, toggle details manually, then choose Not included. Add a qualifying bundle and, if enabled, an approved synthetic discount; compare picker, cart, checkout, and invoice totals. Reload the cart and finish checkout.
- **Expected:** Only the newly picked tier expands automatically, manual toggles work, Not included collapses all, and keyboard focus stays on the radio. Approved prices, discounts and cart contents carry through; order creation is not duplicated by retry.
- **Result:** ☐ Pass ☐ Fail | Evidence: ____ | Tester / UTC date: ____

## Order numbers

### 06 · LIVE-06 · Reference generation and compatibility

- **Steps:** Create the first order for an unused `Ice Queen` stem with the example names and customer reference above. Repeat with short, accented and non-Latin names/projects, and test near-simultaneous order creation in isolation. Rename a project, open a pre-upgrade order, and check search, invoice/receipt references, and enabled API, production and SharePoint outputs. If in scope, verify a portable import preserves an existing reference.
- **Expected:** With default prefix the first reference is `RP-JJG5-ZEUGRE-ICEQUE-001`; configured prefix is respected. Segments fold to uppercase ASCII alphanumerics with right `X` padding; absent customer reference uses `0000`. Same-stem sequences are unique and never reused, expand beyond three digits as needed, and fit 32 characters. Renames do not change references; existing and imported references and authorized manual reference edits remain supported.
- **Result:** ☐ Pass ☐ Fail | Evidence: ____ | Tester / UTC date: ____

## Add-on orders

### 07 · LIVE-07 · Extend an existing project

- **Steps:** Buy packet 1; then use Add packets to this project to buy packets 2 and 4. Review cart target, checkout summary, fresh invoice/receipt, and customer and console related-order links. Repeat against a legacy root; if staff handoff is enabled, use the documented console path.
- **Expected:** The project name is fixed, previously purchased packets are marked and unselectable, and checkout shows the target project and root reference. A new-format root shares its frozen stem with the addition (e.g. `…-002` when available); a legacy root retains its reference. The addition has its own items, invoice, payment and workflow. Bundle eligibility is calculated for the addition alone.
- **Result:** ☐ Pass ☐ Fail | Evidence: ____ | Tester / UTC date: ____

### 08 · LIVE-08 · Project membership and rejection paths

- **Steps:** On synthetic fixtures, try another customer's target, a cancelled or archived root, a mismatched currency, and a packet already bought in a different tier. Retarget an existing cart and review what happens to its items. Try a stale cart after the same packet was purchased in a different session.
- **Expected:** Server refuses invalid targets or duplicates without exposing another customer's project; duplicate packet rejection is `PACKET_ALREADY_IN_PROJECT`. Cart retains one target, revalidates items without silently emptying them, and never commits rejected items.
- **Result:** ☐ Pass ☐ Fail | Evidence: ____ | Tester / UTC date: ____

## Billing

### 09 · LIVE-09 · Optional registration and saved profile

- **Steps:** Register with the billing section collapsed; repeat with valid details and with incomplete details. Repeat with an existing synthetic email and compare the generic response; confirm its profile is unchanged. In account settings save, edit, try a stale edit in a second tab, and clear. Use an approved synthetic export/erasure drill.
- **Expected:** Registration is possible without billing, and provided values must be complete and valid. Only newly created accounts get registration billing details. Owner-only profile writes handle stale versions safely; audit records contain no billing field values. Export includes the profile and the approved erasure process removes or anonymizes it.
- **Result:** ☐ Pass ☐ Fail | Evidence: ____ | Tester / UTC date: ____

### 10 · LIVE-10 · Checkout saved and alternate details

- **Steps:** With a saved profile, confirm its summary is the default. Enter alternate details with Save as my billing information off, then repeat with it on. Start separately without a saved profile and check checkbox default and opt-out. Check invoice copies after changing or clearing the profile.
- **Expected:** Checkout uses the selected details for that invoice. Saving occurs only when opted in; the checkbox defaults on for accounts without a profile. Existing issued invoices retain their original billing snapshot.
- **Result:** ☐ Pass ☐ Fail | Evidence: ____ | Tester / UTC date: ____

## Stripe test mode and live mode

Use [Stripe setup](../guides/ADMIN_GUIDE.md#getting-card-checkout-active-increment-072) and the exact endpoint and required events shown by the candidate at `/admin/payments/setup`. Configure and verify each endpoint in its own Stripe mode: use the signing secret for that exact endpoint and mode, never a CLI listener secret or a different endpoint's secret. Store credentials outside evidence. A portal self-test proves only local verification; it does not prove Stripe delivery. Capture the provider dashboard's event type, mode, redacted event identifier, delivery timestamp and HTTP status, and correlate with the portal's last verified event and the attempt.

### 11 · LIVE-11 · Stripe test-mode delivery and return

- **Steps:** Configure an isolated deployment with the matching Stripe test API credential and test endpoint signing secret; run API, session creation, and webhook self-tests, then activate test checkout. Use Stripe's test payment method for an approved synthetic order. In Stripe Dashboard/Workbench **test mode → endpoint → Event deliveries**, open the actual Checkout event for that order. Follow the portal return to the order.
- **Expected:** The actual delivery to this server shows **HTTP 2xx** and the portal records a verified webhook. `/checkout/return` shows **Payment received**, a receipt and **Continue to your order** into the wizard. Invoice and order are paid once; refresh/redelivery does not duplicate ledger, receipt, or downstream work.
- **Result:** ☐ Pass ☐ Fail | Evidence: ____ | Tester / UTC date: ____

### 12 · LIVE-12 · Missing webhook, pending results, and repair

- **Steps:** On an isolated test-mode deployment with approved fixtures, defer verified delivery. Pay and use the return page and Check payment status; repeat with separate attempts for scheduled reconciliation and the admin **Check with Stripe now** action with fresh MFA. Exercise an unpaid asynchronous result and safe fixture cases for wrong session, amount, currency, mode or attempt/invoice binding. Restore normal delivery and resend the original genuine event.
- **Expected:** Only an exact matching paid session (or `no_payment_required` for zero total) books through lookup. Pending or mismatched attempts do not book; the UI explains processing and rechecks with back-off. Checking is owner-scoped and rate-limited; diagnostics are safe. Lookup source is audited and has the same effects as webhook booking; after the grace window a missing webhook raises one deduplicated alert. Late delivery does not rebook. Verify setup reports last verified webhook and rejection reasons/counts.
- **Result:** ☐ Pass ☐ Fail | Evidence: ____ | Tester / UTC date: ____

### 13 · LIVE-13 · Stripe test-mode refund

- **Steps:** Refund the test payment under the authorized policy with a reason and fresh MFA. Check the actual test-mode refund Event deliveries and retry an event. Compare provider and portal outcomes; verify partial/full amounts where enabled.
- **Expected:** Refund event delivered **2xx**, one matching refund in the portal, correct amount and status, and an audit record with no secret or payment details. A retry does not refund twice.
- **Result:** ☐ Pass ☐ Fail | Evidence: ____ | Tester / UTC date: ____

### 14 · LIVE-14 · Stripe live-mode delivery, return, and refund

- **Steps:** Only with explicit owner approval for an actual charge and refund, use an authorized operator-controlled payment method and a synthetic order at a supported low amount before opening general access. Confirm matching live API credential, live endpoint signing secret, required events, and activation. Complete payment and return; verify the actual Checkout delivery in Stripe Dashboard/Workbench **live mode → Event deliveries**. Issue the approved refund with fresh MFA and verify its live delivery and settlement. Never use test cards in live mode or capture payment details.
- **Expected:** Live-mode Checkout and refund deliveries each show **HTTP 2xx** at the configured endpoint, with app-side verification. Return shows **Payment received**, receipt, and working wizard continuation. Exactly one payment/refund, with matching provider/portal states. A test-mode pass is not live-mode evidence.
- **Result:** ☐ Pass ☐ Fail | Evidence: ____ | Tester / UTC date: ____

## Invoices and receipts

### 15 · LIVE-15 · Invoice, receipt and document access

- **Steps:** Compare an issued invoice, paid receipt and refunded invoice/payment status with the synthetic order and provider. Inspect PDF branding, order reference, full billing name, amounts, discounts and currency. Open a historical receipt and attempt access as a different customer.
- **Expected:** Invoice starts issued, moves to paid only on authoritative confirmation and reflects refunds accurately. Documents and delivery side effects are not duplicated. Issued historical receipt PDFs are unchanged, and another customer cannot access the documents.
- **Result:** ☐ Pass ☐ Fail | Evidence: ____ | Tester / UTC date: ____

## Order workflow wizard and publishing

### 16 · LIVE-16 · Publish a validated workflow

- **Steps:** Open each designer step and find Publish. Introduce a validation error, then fix it. Test cancel and publish with a change note and fresh MFA; test Make default and the eligible drafts-table row action. Compare orders placed before and after.
- **Expected:** Persistent control, visible validation reasons, and no publish on cancel or failed MFA. Success names the version and whether it is default. New orders use the correct default; existing orders retain their pinned version.
- **Result:** ☐ Pass ☐ Fail | Evidence: ____ | Tester / UTC date: ____

### 17 · LIVE-17 · Configured customer workflow

- **Steps:** Open a purchased order from its list and from payment return. Work through required acknowledgement/policy, questions, documents, and audio, then review and submit. Use Back, reload mid-phase, omit a required item, and revisit Order details and a former tab deep link.
- **Expected:** Wizard opens first. Only applicable steps appear, in order; progress and step headings stay clear, and blocked Next has a visible reason. Top errors, saved progress, first-incomplete resume, and heading focus work. Final submission locks the phase; details deep links still work.
- **Result:** ☐ Pass ☐ Fail | Evidence: ____ | Tester / UTC date: ____

### 18 · LIVE-18 · Older workflows and waiting/delivery states

- **Steps:** Open an order on the older derived workflow with and without allowed intake, file and audio actions. Check payment pending, team processing and delivered orders, and exercise staff request-changes/reopen under the existing permissions.
- **Expected:** Only server-permitted actions appear; older active workflows can Finish. Waiting states explain what happens next, offering Pay now or delivery downloads as appropriate. No new permission is inferred from the wizard.
- **Result:** ☐ Pass ☐ Fail | Evidence: ____ | Tester / UTC date: ____

## Files and audio

### 19 · LIVE-19 · Upload, audio and protected download

- **Steps:** Upload a small synthetic document and try unsupported/oversize fixtures. Record a nonidentifying clip, deny microphone permission, and use upload as an alternative; confirm playback/processing. Download an authorized file and phase ZIP, and try download as another customer. If external copy/sync is enabled, verify delivery and a failed-copy retry using a synthetic destination.
- **Expected:** Accessible progress, errors, fallback and playback work; processing fails safely. Authorized downloads succeed, cross-account access is denied, and protected files do not enter public caches. Enabled copies have an auditable, recoverable status.
- **Result:** ☐ Pass ☐ Fail | Evidence: ____ | Tester / UTC date: ____

## Mail

### 20 · LIVE-20 · Transactional mail and queue

- **Steps:** Use the configured transport to send verification, reset, invitation, receipt and required policy notices to approved synthetic inboxes. Check delivery, configured sender/domain alignment, correct canonical links, and preferred-name greeting. In isolation exercise retry after a synthetic failure.
- **Expected:** Expected messages arrive and intended tokens work under their rules. Job status explains retry/failure without exposing links, names, or secrets in log evidence; duplicate payment does not resend a receipt.
- **Result:** ☐ Pass ☐ Fail | Evidence: ____ | Tester / UTC date: ____

## Staff console

### 21 · LIVE-21 · Least privilege and staff workflows

- **Steps:** Compare customer, staff, and admin access. As authorized staff, review an order, search references, reply to a ticket, add an internal note, and use the documented handoff if enabled. Exercise approvals and sample reports/exports with least-privilege staff; test unauthorized navigation and mutation denial.
- **Expected:** Customer and staff see only authorized views; internal notes stay private; protected operations enforce server-side permissions and fresh MFA where required. Staff handoff retains attribution, and related orders have consistent links.
- **Result:** ☐ Pass ☐ Fail | Evidence: ____ | Tester / UTC date: ____

## Audit, logging, and SIEM

### 22 · LIVE-22 · Audit evidence and secure forwarding

- **Steps:** Correlate one synthetic flow across app, edge and Audit Center by request/correlation ID; filter on action, outcome and time; verify the audit chain and retain approved checkpoint evidence off-host. For an enabled TLS syslog or OTLP HTTPS destination, verify receipt at the collector and exercise outage/recovery or dead-letter replay in isolation.
- **Expected:** Time-aligned traceability, restricted exports, no secret/personal field values, and expected audit events for high-impact actions. Collector verifies trust/name and receives deduplicable event IDs; lag, missing events and dead letters are visible. Platform logs have protected retention and rotation; SIEM projection is not a substitute for infrastructure logs.
- **Result:** ☐ Pass ☐ Fail | Evidence: ____ | Tester / UTC date: ____

## Backup and restore drill

### 23 · LIVE-23 · Verified backup and isolated restore

- **Steps:** Follow the [backup and recovery runbook](BACKUP_AND_RESTORE.md). Create and verify an encrypted backup, test the approved off-host copy and separate key custody, and confirm only the selected scheduler runs. Restore to clean database/storage targets with outbound integrations fenced. Measure elapsed time and recovered data point; check orders, related orders, billing/export continuity, objects, audit chain and MFA/session reconciliation.
- **Expected:** Verified archive and isolated restore (not just a readable archive), no integrity mismatches, appropriate account quarantine/session revocation, and measured recovery within agreed RPO/RTO. No production target is overwritten or promoted by this test.
- **Result:** ☐ Pass ☐ Fail | Evidence: ____ | Tester / UTC date: ____

## Upgrade and rollback

### 24 · LIVE-24 · Fenced migration and recovery rehearsal

- **Steps:** Follow [upgrade guidance](UPGRADE.md) on a restored pre-08 copy. Prove drain, ingress fence, verified pre-upgrade backup, migration `0008`, health checks and controlled reopen. Rehearse failure before migration and separately during/after migration in isolation. Check existing sign-in, references, active Stripe setup, API v1 compatibility and older workflows.
- **Expected:** No migration starts without the verified backup. Old release is recovered only when compatible; if migration may have started, traffic remains fenced until approved forward repair or isolated restoration of a compatible database/storage pair. Do not blindly reverse MySQL DDL or repoint the release symlink. Record data-loss implications before any real promotion.
- **Result:** ☐ Pass ☐ Fail | Evidence: ____ | Tester / UTC date: ____

## Security headers and rate limits

### 25 · LIVE-25 · Edge protections and authorization

- **Steps:** On approved synthetic accounts/traffic, inspect HSTS, CSP, framing restrictions, cookie attributes and cache controls for authenticated data. Verify intended request/upload limits, bounded rate-limit behavior for sign-in and forms/payment checks, and that the support request ID is safe. Verify external egress rejects unapproved destinations via supported admin checks.
- **Expected:** Configured headers and secure cookie protections are present; private data is not cached; limits return clear, safe responses and clear as designed. No raw sensitive data or exception traces are returned. Do not exercise aggressive traffic against live services.
- **Result:** ☐ Pass ☐ Fail | Evidence: ____ | Tester / UTC date: ____

## Accessibility

### 26 · LIVE-26 · WCAG 2.2 AA manual and automated checks

- **Steps:** Run axe on default, loading, validation, modal, and completion states in both themes. Use keyboard only and a real screen reader on registration (including billing), checkout billing, tier selection, wizard, and Publish. Test 400% zoom from a 1280 CSS px window, reduced motion, and contrast/focus visibility. Record browser, assistive technology and versions.
- **Expected:** Clear labels, required states and errors; wizard step is announced with `aria-current="step"` and heading focus moves on transitions. Tier changes announce expansion without moving radio focus. Publish dialog has a named purpose, usable focus and safe return. Status is not color-only, focus is not obscured, targets meet 24 CSS px or a WCAG exception applies, and essential content reflows. Document manual and automated results separately; axe alone is not conformance.
- **Result:** ☐ Pass ☐ Fail | Evidence: ____ | Tester / UTC date: ____

## Responsive devices

### 27 · LIVE-27 · Reflow, touch and installed experience

- **Steps:** Test signed-out, customer and admin views at 240, 320, 375, 768, 1024 and 1440 CSS px in both themes; include physical touch devices, portrait/landscape, and an on-screen keyboard. Exercise primary forms, tables, dialogs, menus and navigation; if offered, try PWA install, offline and update/reload.
- **Expected:** No page-wide horizontal scrolling or inaccessible actions; intrinsically wide content scrolls only in its own accessible region. PWA offline mode does not expose cached private data or hide session revocation; navigation gets the current release after reconnecting.
- **Result:** ☐ Pass ☐ Fail | Evidence: ____ | Tester / UTC date: ____

## SEO and indexing

### 28 · LIVE-28 · Public discovery and private indexing boundary

- **Steps:** Verify portal `/robots.txt` specifies `Disallow: /`; as a logged-out visitor try private routes without a session. If the public site is in release scope, verify canonical URLs, crawlable sitemap, titles and structured data on representative public pages and review submitted indexing coverage.
- **Expected:** The portal asks crawlers not to crawl it, and authentication independently protects private routes. Public pages are discoverable as configured; no private routes, identities or documents appear in public sitemap or metadata. A crawler directive alone does not guarantee URL exclusion.
- **Result:** ☐ Pass ☐ Fail | Evidence: ____ | Tester / UTC date: ____

## Analytics

### 29 · LIVE-29 · PostHog and Clarity consent boundary

- **Steps:** Confirm vendors off by default; if enabled for launch, configure approved project identifiers/origins and inspect network requests before consent, after opt-in, on eligible anonymous `/privacy` and `/terms`, after withdrawal, and on signed-in/private or query/fragment URLs. Check isolated vendor dashboards with synthetic visits.
- **Expected:** No analytics before consent or on excluded routes. Only eligible pages load the approved vendor after opt-in; withdrawal stops subsequent collection. No private content, credentials, or identifying form values reach vendors.
- **Result:** ☐ Pass ☐ Fail | Evidence: ____ | Tester / UTC date: ____

## Final sign-off

### 30 · LIVE-30 · Go or no-go

- **Steps:** Review the exact release, evidence and scope with the release owner, operations, security/accessibility, and the payment approver when applicable. Confirm monitoring, escalation, backup, rollback ownership and handover. List exclusions, residual risks and any required retest.
- **Expected:** **GO only** when every required case has passed with evidence for this candidate; launch exclusions are approved and verified disabled; and there is no unresolved blocker in security, privacy, accessibility, payment/accounting, or recovery. **NO-GO** for missing or failed required evidence: keep traffic fenced or the excluded capability disabled, assign an owner and retest before approval. If live card checkout is in scope, missing provider-side live 2xx, return-page, or refund proof blocks that launch; test mode and the portal self-test cannot substitute.
- **Result:** ☐ Pass ☐ Fail | Evidence: ____ | Tester / UTC date: ____
- **Decision:** ☐ GO ☐ NO-GO | Approver roles / UTC date: ____ | Exclusions, risks, owners and retest IDs: ____
