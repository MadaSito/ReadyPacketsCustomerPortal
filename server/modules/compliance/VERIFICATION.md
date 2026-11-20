# Compliance Module — Security, Audit & Verification Report

## 1. Scope & Ownership

- **Module (`compliance_engineer`)**:
  - `server/modules/compliance/**` — 13 Drizzle MySQL tables (`cmp_*` short FK names <= 64 chars), policy publishing & cryptographic acceptance evidence, versioned structured intake questionnaires & encrypted revision-tracked submissions, pure integer minor-unit billing/invoice ledger, dependency-free PDF 1.4 invoice renderer (`GET /api/compliance/invoices/:invoicePublicId/pdf`), disabled-scaffold provider event receipt hook, and portable v3 export/import hooks.
  - `shared/capabilities.ts` — compliance capability definitions (`policies.manage`, `intake.manage`, `intake.review`, `invoices.read_all`, `invoices.record_payment`, `invoices.manage`) and step-up bindings (`policies.manage`, `invoices.manage`, `invoices.record_payment` in `STEP_UP_CAPABILITIES`).
  - `client/src/features/compliance/shared.tsx` — XSS-free `SafePolicyText` React renderer (never parses HTML or uses `dangerouslySetInnerHTML`), `InvoiceStatusBadge`, `IntakeStatusBadge`, minor-unit input parsers, idempotency-key helper, and `sessionFetch`-backed `downloadInvoicePdf`.
  - `client/src/features/compliance/routes.tsx` — exports `complianceFeature: FeatureRoutes` composing `complianceCustomerRoutes`, `complianceCustomerNav`, `complianceOrderTabs`, `complianceWidgets`, `complianceRouteWrappers` (from `customer/index.ts`, owned by `files_engineer`) and `complianceAdminRoutes`, `complianceAdminNav` (from `admin/index.ts`, owned by `orders_engineer`).

## 2. Security, Financial & Transactional Invariants Verified

1. **Immutable Published Policy Versions & Cryptographic Acceptance Evidence**:
   - Published policy versions (`status = "published"`) cannot be edited or deleted (`CONFLICT/POLICY_VERSION_IMMUTABLE`).
   - Draft deletions re-verify `status === "draft"` under `SELECT ... FOR UPDATE` and emit durable `policy.version.draft_deleted` audit inside the same transaction **before** executing `DELETE`.
   - Public `policies.listPublished` filters out `audience = "staff"` in SQL before serialization.
   - `policies.accept` acquires `FOR SHARE` locks on `policy_versions` and `policy_documents`, verifies `doc.active`, `ver.status === "published"`, `ver.origin === "portal"`, `ver.effectiveAt <= now`, `audienceAppliesToRole(doc.audience, actorRole)`, that the version is the current effective published version (`CONFLICT/POLICY_VERSION_SUPERSEDED` if superseded), and exact SHA-256 `contentHash` (`VALIDATION_ERROR/POLICY_HASH_MISMATCH`).
   - Acceptance `method` (`"portal_checkbox"` vs `"typed_signature"`) is derived strictly server-side from `doc.requiresTypedSignature` (`"registration"` is restricted to internal `recordRegistrationAcceptances`). Signer names are verified case-insensitively (NFC-normalized) against the profile name and encrypted at rest via `deps.crypto`; client IP is pseudonymized via `deps.crypto.pseudonymize(ip, "policy-acceptance-ip")` (raw IP is never stored or exported).

2. **Versioned Intake Questionnaires & Encrypted Submissions**:
   - Answers are validated strictly against the bound questionnaire version's field schema using `Object.hasOwn` and rejecting `__proto__`, `constructor`, and `prototype` keys.
   - Initial submission creation inside `writeSubmissionInTx` resolves `tx`-scoped order scope facts (`productPublicIds` + `workflowKey` via `ordersSvc.portableOrders(tx, ...)`) and verifies `questionnaireMatchesOrder` (`default`, `catalog_item`, `workflow`), returning `NOT_FOUND` on mismatch (no existence oracle).
   - `intake.listForOrder` projects only revision note columns (`submissionId`, `publicId`, `noteEnc`) without loading/decrypting historical `answersEnc` blobs; `intake.getSubmission` cursor-paginates revisions (`limit` 1..25, `nextCursor`).
   - Order write locks (`ordersSvc.assertCanWriteOrder(..., { kind: "intake", tx, forUpdate: true })`) and `origin === "portal"` checks block writes on finalized, legal-hold, viewer-grant, or imported orders.

3. **Pure Minor-Unit Billing Ledger & Disabled-Scaffold Online Provider Policy**:
   - All invoice amounts (`unitAmountMinor`, `lineTotalMinor`, `subtotalMinor`, `discountMinor`, `taxMinor`, `totalMinor`, `amountMinor`) are pure integer minor units + ISO 4217 uppercase currency.
   - Invoice status (`draft`, `issued`, `paid`, `void`) is derived deterministically from `(issuedAt, voidedAt, totalMinor, grossPaidMinor, refundedMinor)` via `deriveInvoiceStatus`.
   - Per integrator security decision, `PROVIDER_LEDGER_BOOKING_ENABLED = false as const` is a compile-time constant (`onlinePaymentConfigured` is always `false` with `"Online payment is not configured"`). `recordProviderPayment` durably deduplicates `(provider, providerEventId)` in `compliance_provider_events`, emits `invoice.provider_event.scaffold_recorded` (`outcome: "refused"`, `reasonCode: "PROVIDER_LEDGER_DISABLED_IN_RELEASE"`), and returns `applied: false` with **zero effect** on invoices, payments, or refunds.
   - Manual payments, refunds, draft creation/updates, issuance, and voiding require `invoices.manage` + fresh step-up authentication (`STEP_UP_CAPABILITIES`), re-validate the live actor inside `tx` (`SELECT ... FOR UPDATE` on `users` + `identity.sessions`), enforce `idempotencyKey`, and check `amountMinor <= remainingBalance` / `alreadyRefunded + amountMinor <= pmt.amountMinor` under `SELECT ... FOR UPDATE` row locks.
   - Single-connection pool safety (`connectionLimit: 1`): settings reads (`readSetting(..., tx)`), notifications, mail enqueue, and `deps.audit.record(..., tx)` all run on the active `tx` (verified by dedicated 1-connection pool test).

4. **Audit Coverage (`audit_engineer` C-1 & C-2)**:
   - Every state-changing completion emits an in-transaction durable audit event (`deps.audit.record(event, tx)`) with `snake_case` `attributes` and `safeCounts`; if `audit.record` throws, the transaction rolls back.
   - Every capability, remediation, or step-up denial emits `authz.compliance.denied` (`category: "security"`, `outcome: "denied"`, `severity: "WARN"`) **outside** any transaction after rollback (`runComplianceTx` / `denyComplianceAuthz`).
   - Financial refusals on manual payments and refunds (`PAYMENT_EXCEEDS_BALANCE_DUE`, `REFUND_EXCEEDS_PAYMENT`, `INVOICE_VOIDED`, `INVOICE_NOT_ISSUED`, `CURRENCY_MISMATCH`, `PAYMENT_NOT_FOUND`, `IMPORTED_INVOICE_READ_ONLY`, `ORDER_LOCKED`) emit `invoice.payment.refused` / `invoice.refund.refused` (`category: "business"`, `outcome: "refused"`, `reasonCode`) after rollback.

5. **Portable Evidence v3**:
   - `portableEvidence` runs cleanly inside `READ ONLY` `REPEATABLE READ` transactions, validating against `RECORD_SCHEMAS` with complete reference closure and zero secret/token/password or raw IP fields.
   - `importPortableEvidence` imports records with `origin = "import"` and `(importId, sourceInstallationId, sourcePublicId)` idempotency without fabricating active local policy consent.

## 3. Verification Commands & Results

- `./scripts/dev/lint.sh server/modules/compliance shared/capabilities.ts client/src/features/compliance/shared.tsx client/src/features/compliance/routes.tsx` — **0 errors, 0 warnings**.
- `./scripts/dev/tc.sh '(server/modules/compliance|shared/capabilities\.ts|client/src/(app|features/compliance/(shared|routes)))'` — **0 diagnostics**.
- `./scripts/dev/test.sh server/modules/compliance/compliance.test.ts` — **8/8 integration & security tests passed against ephemeral MySQL (`createTestDb`)**:
  1. Immutable published policy versions, SHA-256 hash-bound acceptance, pseudonymized IP, and re-acceptance when v2 is published.
  2. Typed signature verification against profile name and encrypted signer name at rest.
  3. Intake field validation, `Object.prototype` key rejection, AEAD answer encryption, revision trail, staff review (`returned_for_changes` -> customer resubmit -> `accepted`), order lock & negative cross-customer authz (`NOT_FOUND`).
  4. Pure minor-unit invoice math, sequential numbering (`RP-INV-YYYY-NNNNNN`), finalized vs legal-hold lock rules, partial payment -> full payment -> partial refund status derivation, idempotent manual payment & refund bounds, PDF 1.4 rendering & `invoice.downloaded` durable audit.
  5. Disabled-scaffold provider webhook test: signed `succeeded` + duplicate + `refunded` Stripe events record `compliance_provider_events` + `invoice.provider_event.scaffold_recorded` audit and leave invoice status, balances, payments, and refunds completely unchanged.
  6. Portable v3 `READ ONLY` repeatable-read export (`RECORD_SCHEMAS` + `referencesOf` closure + secret/IP scan) and inert import (`origin = "import"` does not satisfy live `requiredAcceptancesFor`).
  7. Live actor `FOR UPDATE` re-validation on mid-session role demotion, durable audit fail-closed rollback, and 1-connection pool (`connectionLimit: 1`) non-deadlock verification.
  8. Reviewer & audit regression suite: public `listPublished` excludes `staff` audience, server-derived acceptance method & `effectiveAt`/supersession enforcement, `tx`-scoped `catalog_item` + `workflow` intake applicability, cursor-paginated `getSubmission` revisions, and `authz.compliance.denied` / `invoice.payment.refused` post-rollback audits with `snake_case` attributes.
