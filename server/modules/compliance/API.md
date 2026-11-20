# Compliance module — Policies, Intake & Billing Evidence API (v1)

Owner: `compliance_engineer`.
Paths: `server/modules/compliance/**`, `client/src/features/compliance/**`.
Import types from `server/modules/compliance/index.ts`; reach the instance at call time via `deps.services.compliance`.

## 1. Cross-module service interface (`ComplianceModule`)

All public identifiers exposed across module/API boundaries are 26-char ULIDs (`publicId`). Money is integer minor units + 3-char uppercase ISO 4217 `currency`.

```ts
export type PolicyAudience = "all" | "customer" | "staff";
export type PolicyContentFormat = "plain_text" | "safe_markdown";
export type PolicyAcceptanceMethod = "portal_checkbox" | "registration" | "typed_signature" | "imported_history";

export interface RequiredPolicySummary {
  documentPublicId: string;
  slug: string;
  title: string;
  audience: PolicyAudience;
  requiresTypedSignature: boolean;
  versionPublicId: string;
  versionNumber: number;
  versionLabel: string;
  contentFormat: PolicyContentFormat;
  bodyText: string;
  contentHash: string; // SHA-256 hex of NFC + LF-normalized bodyText
  effectiveAt: Date;
  publishedAt: Date;
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
  | "other";

export interface ProviderPaymentInput {
  /** e.g. "stripe" */
  provider: string;
  /** Stable provider event ID (idempotency key, e.g. Stripe evt_...). */
  providerEventId: string;
  /** Provider payment/charge or refund reference (non-secret, e.g. pi_..., ch_..., re_...). */
  providerReference: string;
  /** Target invoice publicId. */
  invoicePublicId: string;
  /** Positive integer minor units. */
  amountMinor: number;
  /** 3-letter ISO 4217 currency code; must match invoice currency. */
  currency: string;
  /** Defaults to "payment"; pass "refund" for confirmed provider refund webhooks. */
  kind?: "payment" | "refund";
  receivedAt?: Date;
  refundedAt?: Date;
  reason?: string;
  paymentProviderReference?: string;
  tx?: Tx;
}

export interface ProviderPaymentResult {
  evidencePublicId: string;
  paymentPublicId?: string;
  refundPublicId?: string;
  invoicePublicId: string;
  invoiceStatus: InvoiceStatus;
  duplicate: boolean;
}

export interface PortableComplianceEvidenceBatch {
  policyVersions: PortablePolicyVersionRecord[];
  policyAcceptances: PortablePolicyAcceptanceRecord[];
  intakeDefinitions: PortableIntakeDefinitionRecord[];
  intakeSubmissions: PortableIntakeSubmissionRecord[];
  invoices: PortableInvoiceRecord[];
  payments: PortablePaymentRecord[];
  refunds: PortableRefundRecord[];
  nextAfter: string | null;
}

export interface ComplianceModule extends ModuleLifecycle {
  /**
   * Returns published, effective, required policy versions that `userId` has NOT yet accepted on this installation.
   * Empty array means all required policies are accepted.
   * Called by `orders` before order creation and surfaced on the customer dashboard.
   */
  requiredAcceptancesFor(userId: number, opts?: { audience?: "customer" | "staff"; tx?: DbOrTx }): Promise<RequiredPolicySummary[]>;

  /**
   * Convenience gate for order creation: throws DomainError("CONFLICT", "POLICY_ACCEPTANCE_REQUIRED", ...)
   * with `{ pendingCount, slugs }` if `requiredAcceptancesFor(userId)` is non-empty.
   */
  assertRequiredPoliciesAccepted(userId: number, opts?: { audience?: "customer" | "staff"; tx?: DbOrTx }): Promise<void>;

  /**
   * Records policy acceptances captured during account registration (inside identity's registration tx if needed).
   * Verifies each version is currently published and matches `contentHash`.
   */
  recordRegistrationAcceptances(
    input: {
      userId: number;
      items: readonly { versionPublicId: string; contentHash: string; signerName?: string }[];
    },
    opts?: { tx?: Tx },
  ): Promise<{ recorded: number }>;

  /**
   * Narrow idempotent hook for `integrations_engineer` (e.g. verified Stripe webhook) to record confirmed online payment evidence.
   * Idempotent on `(provider, providerEventId)`. Never trusts status flags; re-derives invoice status from payment/refund ledger.
   */
  recordProviderPayment(input: ProviderPaymentInput): Promise<ProviderPaymentResult>;

  /**
   * Read-only snapshot hook for `portable_ops_engineer`.
   * Enumerates safe, non-executable historical evidence for authorized `orderIds` (order publicIds), cursor-paginated by `after`.
   * Excludes all secrets, raw IPs, session IDs and tokens. Decrypts encrypted intake answers for portable archival under the package AEAD envelope.
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
   * and explicit `(importId, sourceInstallationId, sourcePublicId)` provenance.
   * Idempotent on `(sourceInstallationId, sourcePublicId)`. Never fabricates local active consent, never triggers provider webhooks or emails.
   */
  importPortableEvidence(input: ImportComplianceEvidenceInput, tx: Tx): Promise<ImportComplianceEvidenceResult>;
}
```

## 2. Dependencies on other modules (`deps.services.*`, accessed at call time only)

- `services.identity`: `getUser(userId, { tx })`, `getUserByPublicId(publicId, { tx })`
- `services.orders`:
  - `assertCanReadOrder(principal, orderPublicId, { tx })`
  - `assertCanWriteOrder(principal, orderPublicId, { kind: "intake" | "invoice", tx })`
  - `listAccessibleOrderIds(principal, { limit, tx })`
  - `getOrderSummary(principal, orderPublicId)`
  - `getOrderRefById(orderId, tx)`
- `services.engagement` (optional/guarded): `notify({ userId, kind, title, body, link })` on invoice issued or intake returned for changes.
- `services.integrations` (optional/guarded): online payment configuration check (`isOnlinePaymentConfigured` fallback to `false` -> UI shows `"Online payment is not configured"` honestly).

## 3. Capabilities (`shared/capabilities.ts`)

| Capability | Granted to | Purpose |
| --- | --- | --- |
| `policies.manage` | `admin` | Author drafts, publish immutable policy versions, configure required flags, view acceptance reports |
| `intake.manage` | `admin` | Create/edit draft questionnaires, publish immutable questionnaire versions |
| `intake.review` | `staff`, `admin` | Review customer intake submissions (`accepted` / `returned_for_changes`) subject to order write-lock |
| `invoices.read_all` | `staff`, `admin` | List/read all order invoices and payment/refund evidence |
| `invoices.record_payment` | `staff`, `admin` | Record manual payment evidence on issued invoices subject to order write-lock (`kind: "invoice"`) |
| `invoices.manage` | `staff`, `admin` | Create draft invoices, issue invoices, void unpaid/fully-refunded invoices, record refund evidence |

## 4. tRPC procedures (`trpc.compliance.*`)

| Procedure | Guard | Summary |
| --- | --- | --- |
| `policies.listPublished` | `publicProcedure` | Active published policy documents + current effective version text & SHA-256 `contentHash` (for `/register` and public reading) |
| `policies.myStatus` | `protectedProcedure` | Current published policies, pending required acceptances, and caller's own acceptance evidence history |
| `policies.accept` | `protectedProcedure` | `{ versionPublicId, contentHash, method, signerName?, orderPublicId? }` — binds acceptance to exact version + hash, records timestamp (`deps.clock`), `requestId`, pseudonymised IP |
| `policies.admin.listDocuments` | `adminProcedure` + `policies.manage` | All policy documents with draft & published version counts |
| `policies.admin.getDocument` | `adminProcedure` + `policies.manage` | Document detail + all versions (draft & published) |
| `policies.admin.createDocument` | `adminProcedure` + `policies.manage` | Create policy document metadata + initial draft version |
| `policies.admin.updateDocument` | `adminProcedure` + `policies.manage` | Update title, audience, `requiresAcceptance`, `requiresTypedSignature`, `active` (`expectedVersion`) |
| `policies.admin.createDraftVersion` | `adminProcedure` + `policies.manage` | Create new draft version (cloned or fresh) |
| `policies.admin.updateDraftVersion` | `adminProcedure` + `policies.manage` | Edit draft body/effectiveAt/versionLabel; **refuses published versions (`CONFLICT/POLICY_VERSION_IMMUTABLE`)** |
| `policies.admin.deleteDraftVersion` | `adminProcedure` + `policies.manage` | Delete draft version only; **refuses published versions (`CONFLICT/POLICY_VERSION_IMMUTABLE`)** |
| `policies.admin.publishVersion` | `adminProcedure` + `policies.manage` | Lock `contentHash`, mark `published`, advance document current version, audit `policy.version.published` in `tx` |
| `policies.admin.listAcceptances` | `adminProcedure` + `policies.manage` | Cursor-paginated acceptance evidence report filterable by `documentPublicId` / `versionPublicId` / `userPublicId` |
| `intake.listForOrder` | `protectedProcedure` | Applicable published questionnaires + current submission status & decrypted answers for `orderId` (read-scoped via `orders.assertCanReadOrder`) |
| `intake.getSubmission` | `protectedProcedure` | Submission detail + full revision history for `(orderId, questionnairePublicId)` |
| `intake.saveDraft` | `protectedProcedure` | Save encrypted partial answers (`orders.assertCanWriteOrder(..., { kind: "intake" })`); appends `draft_saved` revision |
| `intake.submit` | `protectedProcedure` | Full field validation against bound questionnaire version + lock check; transitions to `submitted` |
| `intake.review` | `staffProcedure` + `intake.review` | Staff/admin decision (`accepted` \| `returned_for_changes`) + encrypted feedback note; respects order locks |
| `intake.admin.listQuestionnaires` | `adminProcedure` + `intake.manage` | All questionnaires (by scope: `default`, `catalog_product`, `order_type`) |
| `intake.admin.getQuestionnaire` | `adminProcedure` + `intake.manage` | Questionnaire + all draft/published versions |
| `intake.admin.createQuestionnaire` | `adminProcedure` + `intake.manage` | Create questionnaire + v1 draft definition |
| `intake.admin.updateQuestionnaire` | `adminProcedure` + `intake.manage` | Update metadata/scope/active (`expectedVersion`) |
| `intake.admin.createDraftVersion` | `adminProcedure` + `intake.manage` | Create new draft version (cloned or fresh) |
| `intake.admin.updateDraftVersion` | `adminProcedure` + `intake.manage` | Edit draft field definitions; published versions are immutable |
| `intake.admin.deleteDraftVersion` | `adminProcedure` + `intake.manage` | Delete draft version (writes durable audit before delete) |
| `intake.admin.publishVersion` | `adminProcedure` + `intake.manage` | Validate field schema, lock `definitionHash`, mark `published` |
| `invoices.listMine` | `protectedProcedure` | Cursor-paginated customer-visible (`issued`/`paid`/`void`) invoices across accessible orders (`orders.listAccessibleOrderIds`) |
| `invoices.listForOrder` | `protectedProcedure` | Invoices for one order (`orders.assertCanReadOrder`; hides `draft` from customers) |
| `invoices.get` | `protectedProcedure` | Read-checked invoice detail + line snapshots + payment/refund ledger + online-payment availability (`onlinePaymentConfigured: boolean`) |
| `invoices.admin.list` | `staffProcedure` + `invoices.read_all` | Cursor-paginated console invoice list with status/order/currency filters |
| `invoices.admin.createDraft` | `adminProcedure` + `invoices.manage` | Create draft invoice for an order (`orders.assertCanWriteOrder(..., { kind: "invoice" })`) with integer minor-unit line snapshots |
| `invoices.admin.updateDraft` | `adminProcedure` + `invoices.manage` | Update draft lines, discountMinor, taxMinor, dueAt, notes (`CONFLICT` if not `draft`) |
| `invoices.admin.issue` | `adminProcedure` + `invoices.manage` | Assign sequential `invoiceNumber`, set `issuedAt`, derive status (`issued` or `paid` if `totalMinor === 0`) |
| `invoices.admin.void` | `adminProcedure` + `invoices.manage` | Void unpaid or fully-refunded invoice (`CONFLICT/INVOICE_HAS_UNREFUNDED_PAYMENTS` if `netPaidMinor > 0`) |
| `invoices.admin.recordManualPayment` | `staffProcedure` + `invoices.record_payment` | Record manual payment evidence (`method`, `reference`, `amountMinor`, `currency`, `receivedAt`, `idempotencyKey`); re-derives invoice status |
| `invoices.admin.recordRefund` | `adminProcedure` + `invoices.manage` | Record separate refund evidence against invoice/payment (`amountMinor <= refundable`); re-derives invoice status |

## 5. Raw HTTP routes (`/api/compliance/...`)

| Route | Guard | Purpose |
| --- | --- | --- |
| `GET /api/compliance/invoices/:invoiceId/pdf` | `requireFullSession` + order read scope | Generates clean dependency-free PDF-1.4 invoice document, audits `invoice.downloaded`, and streams via `sendPrivateDownload` (`Content-Disposition: attachment`, `nosniff`, `no-store`) |

## 6. Audit events (`deps.audit.record(..., tx)`)

- Category `business` (or `admin` for authoring):
  - `policy.document.created`, `policy.document.updated`, `policy.version.draft_saved`, `policy.version.draft_deleted`, `policy.version.published` (`admin`)
  - `policy.accepted` (`business`, attributes: `documentPublicId`, `versionPublicId`, `contentHash`, `method`)
  - `intake.questionnaire.created`, `intake.questionnaire.updated`, `intake.version.draft_saved`, `intake.version.published` (`admin`)
  - `intake.draft.saved`, `intake.submission.submitted`, `intake.submission.reviewed` (`business`)
  - `invoice.draft.created`, `invoice.draft.updated`, `invoice.issued`, `invoice.voided` (`business`)
  - `invoice.payment.recorded`, `invoice.payment.provider_recorded`, `invoice.refund.recorded` (`business`)
  - `invoice.downloaded` (`business`)
- Category `portable_transfer`:
  - `compliance.evidence.imported`
- Category `security`:
  - `authz.compliance.denied` (cross-tenant / unauthorized access attempts, outcome `denied`)

## 7. Settings, mail templates & health

- Settings (`server/modules/compliance/settings.ts`, owner `compliance`, group `compliance`):
  - `compliance.invoices.number_prefix`: string (`^[A-Z0-9-]{2,16}$`), default `"RP-INV"`, internal
  - `compliance.invoices.issuer_name`: string (1..160), default `"ReadyPackets"`, public
  - `compliance.invoices.issuer_address`: string (0..400), default `""`, public
  - `compliance.invoices.payment_instructions`: string (0..1000), default `"Contact ReadyPackets billing support for wire/ACH remittance details."`, internal
- Mail templates:
  - `compliance.invoice_issued` (`vars: ["invoiceNumber", "orderReference", "amountFormatted", "dueDate", "link"]`)
  - `compliance.intake_returned` (`vars: ["orderReference", "questionnaireTitle", "link"]`)
- Health components:
  - `compliance.policies`: `ok` (with `publishedDocuments` and `requiredDocuments` metrics; `not_configured` if zero published policies exist yet)
