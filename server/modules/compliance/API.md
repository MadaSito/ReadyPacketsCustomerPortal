# Compliance module — Policies, Intake & Billing Evidence API (v1)

Owner: `compliance_engineer` (`server/modules/compliance/**`, `client/src/features/compliance/routes.tsx`, `client/src/features/compliance/shared.tsx`).
UI split: `files_engineer` owns `client/src/features/compliance/customer/**`; `orders_engineer` owns `client/src/features/compliance/admin/**`.
Import types from `server/modules/compliance/index.ts`; reach the instance at call time via `deps.services.compliance`.

## 1. Cross-module service interface (`ComplianceModule`)

All public identifiers exposed across module/API boundaries are 26-char ULIDs (`publicId`). Money is integer minor units + 3-char uppercase ISO 4217 `currency`.

```ts
export type PolicyAudience = "all" | "customer" | "staff";
export type PolicyContentFormat = "plain_text" | "safe_markdown";
export type PolicyAcceptanceMethod = "portal_checkbox" | "registration" | "typed_signature" | "imported_historical";

export interface PublishedPolicyView {
  documentPublicId: string;
  slug: string;
  title: string;
  audience: PolicyAudience;
  requiresAcceptance: boolean;
  requiresTypedSignature: boolean;
  versionPublicId: string;
  versionNumber: number;
  versionLabel: string;
  contentFormat: PolicyContentFormat;
  bodyText: string;
  contentHash: string; // SHA-256 hex of NFC + LF-normalized bodyText
  changeSummary: string | null;
  effectiveAt: Date;
  publishedAt: Date | null;
}

export type InvoiceStatus = "draft" | "issued" | "paid" | "void";
export type PaymentMethod =
  | "bank_transfer"
  | "wire"
  | "ach"
  | "check"
  | "card_manual"
  | "waiver"
  | "provider_online"
  | "imported_historical"
  | "other";

export interface RecordProviderPaymentInput {
  provider: string;
  providerEventId: string;
  providerPaymentId?: string;
  providerReference?: string;
  invoicePublicId?: string;
  orderPublicId?: string;
  kind?: "succeeded" | "failed" | "refunded" | "payment" | "refund";
  amountMinor: number;
  currency: string;
  reasonCode?: string;
  reason?: string;
  occurredAt?: Date;
  receivedAt?: Date;
  refundedAt?: Date;
  tx?: Tx;
}

export interface RecordProviderPaymentResult {
  applied: boolean;
  duplicate: boolean;
  reasonCode?: string;
  recordPublicId?: string;
  invoicePublicId?: string;
  invoiceStatus?: InvoiceStatus;
}

export interface ComplianceModule extends ModuleLifecycle {
  /**
   * Returns published, effective, required policy versions that `userId` has NOT yet accepted on this installation.
   * Empty array means all required policies are accepted.
   */
  requiredAcceptancesFor(userId: number, opts?: { audience?: "customer" | "staff" | "admin"; tx?: DbOrTx }): Promise<PublishedPolicyView[]>;

  /**
   * Convenience gate for order creation: throws DomainError("CONFLICT", "POLICY_ACCEPTANCE_REQUIRED", ...)
   * with `{ pendingCount, slugs }` if `requiredAcceptancesFor(userId)` is non-empty.
   */
  assertRequiredPoliciesAccepted(userId: number, opts?: { audience?: "customer" | "staff" | "admin"; tx?: DbOrTx }): Promise<void>;

  /**
   * Records policy acceptances captured during account registration (inside identity's registration tx if needed).
   * Verifies each version is currently published, effective, audience-eligible, and matches `contentHash`.
   */
  recordRegistrationAcceptances(
    input: {
      userId: number;
      actorRole?: "customer" | "staff" | "admin";
      items: readonly { versionPublicId: string; contentHash: string; signerName?: string }[];
    },
    opts?: { tx?: Tx },
  ): Promise<{ recorded: number }>;

  /**
   * Disabled-scaffold hook for `integrations_engineer` (verified Stripe webhook receipt).
   * Per integrator security decision, `PROVIDER_LEDGER_BOOKING_ENABLED === false` (compile-time constant):
   * signed provider events are durably deduplicated in `compliance_provider_events` and audited
   * (`invoice.provider_event.scaffold_recorded`, outcome `refused`, reason `PROVIDER_LEDGER_DISABLED_IN_RELEASE`),
   * then acknowledged with `applied: false` and ZERO effect on invoices, payments, or refunds.
   */
  recordProviderPayment(input: RecordProviderPaymentInput): Promise<RecordProviderPaymentResult>;

  /**
   * Read-only snapshot hook for `portable_ops_engineer`.
   * Enumerates safe, non-executable historical evidence for authorized `orderIds` (order publicIds), cursor-paginated by `after`.
   */
  portableEvidence(
    tx: DbOrTx,
    orderIds: readonly string[],
    after: string | null,
    limit: number,
    opts?: { customerPublicIds?: readonly string[] },
  ): Promise<PortableComplianceEvidenceBatch>;

  /**
   * Import hook for `portable_ops_engineer`.
   * Stores historical policy versions/acceptances, intake definitions/submissions, and invoices/payments/refunds with `origin = "import"`
   * and explicit `(importId, sourceInstallationId, sourcePublicId)` provenance. Never fabricates local active consent.
   */
  importPortableEvidence(input: ImportComplianceEvidenceInput, tx: Tx): Promise<ImportComplianceEvidenceResult>;
}
```

## 2. Dependencies on other modules (`deps.services.*`, accessed at call time only)

- `services.identity`: `getUser(userId)`, `sessions.assertCurrent(principal, tx)`, `sessions.getState(sessionId, { tx })`
- `services.orders`:
  - `assertCanReadOrder(principal, orderPublicId, { tx })`
  - `assertCanWriteOrder(principal, orderPublicId, { kind: "intake" | "invoice", tx, forUpdate: true })`
  - `listAccessibleOrderIds(principal, { limit, tx })`
  - `getOrderRefById(orderId, tx)`
  - `portableOrders(dbOrTx, { limit: 1, orderIds: [orderId] })` (for `tx`-safe `catalog_item` + `workflow` intake scope matching)
- `services.engagement` (optional/guarded): `notify(..., tx)` on invoice issued/paid or intake returned for changes.

## 3. Capabilities (`shared/capabilities.ts`)

| Capability | Granted to | Step-up required | Purpose |
| --- | --- | --- | --- |
| `policies.manage` | `admin` | Yes | Author drafts, publish immutable policy versions, configure required flags, view acceptance reports |
| `intake.manage` | `admin` | No | Create/edit draft questionnaires, publish immutable questionnaire versions |
| `intake.review` | `staff`, `admin` | No | Review customer intake submissions (`accepted` / `returned_for_changes`) subject to order write-lock |
| `invoices.read_all` | `staff`, `admin` | No | List/read all order invoices and payment/refund evidence |
| `invoices.record_payment` | `staff`, `admin` | Yes | Capability token retained for RBAC compatibility; manual payment & refund routes enforce `invoices.manage` + step-up |
| `invoices.manage` | `staff`, `admin` | Yes | Create/edit draft invoices, issue invoices, void unpaid/fully-refunded invoices, record manual payments & refunds |

## 4. tRPC procedures (`trpc.compliance.*`)

| Procedure | Guard | Summary |
| --- | --- | --- |
| `policies.listPublished` | `publicProcedure` | Active effective published policy documents excluding `staff`-only audience (`{ slug? }` filter; used by `/register` and `/legal`) |
| `policies.myStatus` | `protectedProcedure` | `{ published, pendingRequired, acceptances }` filtered to caller's role audience |
| `policies.accept` | `protectedProcedure` | `{ versionPublicId, contentHash, method?, signerName?, orderPublicId? }` — serialized `FOR SHARE` check of audience, `effectiveAt <= now`, current effective version, and `contentHash`; server derives `method` from `requiresTypedSignature` |
| `policies.admin.listDocuments` | `policies.manage` | All policy documents (`PolicyDocumentAdminSummary[]`) |
| `policies.admin.getDocument` | `policies.manage` | `{ document, versions }` for `{ documentPublicId }` |
| `policies.admin.createDocument` | `policies.manage` (step-up) | `{ slug, title, audience, requiresAcceptance, requiresTypedSignature, versionLabel, contentFormat, bodyText, changeSummary?, effectiveAt? }` -> `{ documentPublicId, draftVersionPublicId, contentHash }` |
| `policies.admin.updateDocument` | `policies.manage` (step-up) | `{ documentPublicId, expectedVersion, title, audience, requiresAcceptance, requiresTypedSignature, active }` -> `{ documentPublicId, version }` |
| `policies.admin.createDraftVersion` | `policies.manage` (step-up) | `{ documentPublicId, versionLabel, contentFormat, bodyText, changeSummary?, effectiveAt? }` -> `{ versionPublicId, versionNumber, contentHash }` |
| `policies.admin.updateDraftVersion` | `policies.manage` (step-up) | `{ versionPublicId, versionLabel, contentFormat, bodyText, changeSummary?, effectiveAt }` -> `{ versionPublicId, contentHash }`; refuses published versions (`POLICY_VERSION_IMMUTABLE`) |
| `policies.admin.deleteDraftVersion` | `policies.manage` (step-up) | `{ versionPublicId }` -> `{ deleted: true }`; durable audit recorded before delete; refuses published versions |
| `policies.admin.publishVersion` | `policies.manage` (step-up) | `{ versionPublicId, effectiveAt? }` -> `{ versionPublicId, contentHash, publishedAt, effectiveAt }` |
| `policies.admin.listAcceptances` | `policies.manage` | `{ documentPublicId?, versionPublicId?, userPublicId?, cursor?, limit? }` -> `{ items, nextCursor }` |
| `intake.listForOrder` | `protectedProcedure` | `{ items, lockState }` for `{ orderPublicId }` (`default`, `catalog_item`, and `workflow` scope; note-only projection) |
| `intake.getSubmission` | `protectedProcedure` | `{ questionnaire, version, submission, revisions, nextCursor, canWrite }` for `{ orderPublicId, questionnairePublicId, cursor?, limit? }` |
| `intake.saveDraft` | `protectedProcedure` | `{ orderPublicId, questionnairePublicId, answers }` -> `{ submissionPublicId, status, revisionNumber }` |
| `intake.submit` | `protectedProcedure` | `{ orderPublicId, questionnairePublicId, answers }` -> `{ submissionPublicId, status, revisionNumber }` |
| `intake.review` | `staffProcedure` + `intake.review` | `{ submissionPublicId, decision: "accepted" \| "returned_for_changes", reviewNote? }` -> `{ submissionPublicId, status, revisionNumber }` |
| `intake.admin.listQuestionnaires` | `intake.manage` | `QuestionnaireAdminSummary[]` (`scopeKind: "default" \| "catalog_item" \| "workflow"`, `scopeRef`) |
| `intake.admin.getQuestionnaire` | `intake.manage` | `{ questionnaire, versions }` for `{ questionnairePublicId }` |
| `intake.admin.createQuestionnaire` | `intake.manage` | `{ slug, title, description?, scopeKind, scopeRef?, fields }` -> `{ questionnairePublicId, draftVersionPublicId, schemaHash }` |
| `intake.admin.updateQuestionnaire` | `intake.manage` | `{ questionnairePublicId, expectedVersion, title, description?, scopeKind, scopeRef?, active }` -> `{ questionnairePublicId, version }` |
| `intake.admin.saveDraftVersion` | `intake.manage` | `{ questionnairePublicId, versionPublicId?, fields }` -> `{ versionPublicId, versionNumber, schemaHash }`; published versions are immutable |
| `intake.admin.publishVersion` | `intake.manage` | `{ versionPublicId }` -> `{ versionPublicId, schemaHash, publishedAt }` |
| `invoices.listMine` | `protectedProcedure` | `{ status?, cursor?, limit? }` -> `{ items, nextCursor }` (customer-visible `issued`/`paid`/`void` only) |
| `invoices.listForOrder` | `protectedProcedure` | `{ orderPublicId }` -> `InvoiceSummaryView[]` (hides `draft` from customers) |
| `invoices.get` | `protectedProcedure` | `{ invoicePublicId }` -> `InvoiceDetailView` (`onlinePaymentConfigured: false`, `onlinePaymentMessage: "Online payment is not configured"`) |
| `invoices.admin.list` | `staffProcedure` (`invoices.read_all`) | `{ status?, orderPublicId?, cursor?, limit? }` -> `{ items, nextCursor }` |
| `invoices.admin.createDraft` | `staffProcedure` + `invoices.manage` (step-up) | `{ orderPublicId, currency, lines, discountMinor, taxMinor, dueAt?, memo? }` -> `{ invoicePublicId, totalMinor, currency }` |
| `invoices.admin.updateDraft` | `staffProcedure` + `invoices.manage` (step-up) | `{ invoicePublicId, expectedVersion, currency, lines, discountMinor, taxMinor, dueAt?, memo? }` -> `{ invoicePublicId, version, totalMinor }` |
| `invoices.admin.issue` | `staffProcedure` + `invoices.manage` (step-up) | `{ invoicePublicId, dueAt? }` -> `{ invoicePublicId, invoiceNumber, status, issuedAt }` |
| `invoices.admin.void` | `staffProcedure` + `invoices.manage` (step-up) | `{ invoicePublicId, reason }` -> `{ invoicePublicId, status: "void", voidedAt }` |
| `invoices.admin.recordManualPayment` | `staffProcedure` + `invoices.manage` (step-up) | `{ invoicePublicId, method, amountMinor, currency, reference, notes?, receivedAt?, idempotencyKey }` -> `{ paymentPublicId, invoiceStatus, balanceDueMinor, duplicate }` |
| `invoices.admin.recordRefund` | `staffProcedure` + `invoices.manage` (step-up) | `{ invoicePublicId, paymentPublicId, amountMinor, currency, reasonCode, reference, notes?, refundedAt?, idempotencyKey }` -> `{ refundPublicId, invoiceStatus, balanceDueMinor, duplicate }` |

## 5. Raw HTTP routes (`/api/compliance/...`)

| Route | Guard | Purpose |
| --- | --- | --- |
| `GET /api/compliance/invoices/:invoicePublicId/pdf` | `requireFullSession` + order read scope | Generates clean dependency-free PDF-1.4 invoice document, audits `invoice.downloaded` inside `tx`, and streams via `sendPrivateDownload` (`Content-Disposition: attachment`, `nosniff`, `no-store`) |

## 6. Audit events (all `snake_case` attributes)

- Category `admin` / `business` (in-tx on completion):
  - `policy.document.created`, `policy.document.updated`, `policy.version.draft_saved`, `policy.version.draft_deleted`, `policy.version.published` (`admin`)
  - `policy.accepted` (`business`, attributes: `document_public_id`, `version_public_id`, `content_hash`, `method`, `has_order_binding`)
  - `intake.questionnaire.created`, `intake.questionnaire.updated`, `intake.version.draft_saved`, `intake.version.published` (`admin`)
  - `intake.submission.draft_saved`, `intake.submission.submitted`, `intake.submission.reviewed` (`business`)
  - `invoice.created`, `invoice.draft_updated`, `invoice.issued`, `invoice.voided` (`business`)
  - `invoice.payment.recorded`, `invoice.refund.recorded`, `invoice.downloaded` (`business`)
- Category `business` (recorded outside `tx` after rollback on financial refusal):
  - `invoice.payment.refused`, `invoice.refund.refused` (outcome `refused`, `reasonCode`)
- Category `integration`:
  - `invoice.provider_event.scaffold_recorded` (outcome `refused`, `reasonCode: "PROVIDER_LEDGER_DISABLED_IN_RELEASE"`)
- Category `portable_transfer`:
  - `compliance.evidence.imported`
- Category `security` (recorded outside `tx` on capability/step-up/remediation denial):
  - `authz.compliance.denied` (outcome `denied`, severity `WARN`)

## 7. Settings, mail templates & health

- Settings (`server/modules/compliance/settings.ts`, owner `compliance`, group `compliance`):
  - `compliance.invoices.number_prefix`: string (`^[A-Z0-9-]{2,16}$`), default `"RP-INV"`, internal
  - `compliance.invoices.issuer_name`: string (1..160), default `"ReadyPackets"`, public
  - `compliance.invoices.issuer_address`: string (0..400), default `""`, public
  - `compliance.invoices.payment_instructions`: string (0..1000), default `"Contact ReadyPackets billing support for wire/ACH remittance details."`, internal
- Mail templates:
  - `compliance.invoice_issued` (`vars: ["invoiceNumber", "orderReference", "portalPath"]`)
  - `compliance.invoice_paid` (`vars: ["invoiceNumber", "orderReference", "portalPath"]`)
  - `compliance.intake_returned` (`vars: ["orderReference", "questionnaireTitle", "portalPath"]`)
- Health components:
  - `compliance.policies`: `ok` / `not_configured`
  - `compliance.intake`: `ok` / `not_configured`
  - `compliance.invoices`: `ok` (`issuedUnpaidInvoices` count)
