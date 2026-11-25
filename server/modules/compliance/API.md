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

  /* ---- Increment 04 ports (Cart, Payments, Referrals, Public API v1) ---- */

  /**
   * Server-side tax quote helper for `cart` (`recovery_ops_engineer`).
   * Reads `compliance.invoices.default_tax_rate_bps` (integer 0..5000 bps, default 0) inside `tx` and computes
   * half-up integer minor units on `Math.max(0, subtotalAfterDiscountMinor)`.
   */
  quoteTaxMinor(
    input: {
      subtotalAfterDiscountMinor: number;
      currency: string;
      billingCountry?: string | null;
      billingRegion?: string | null;
    },
    tx?: DbOrTx,
  ): Promise<{ taxRateBps: number; taxMinor: number }>;

  /**
   * Atomic customer-checkout invoice port for `cart` (`recovery_ops_engineer`).
   * Runs inside `cart`'s transaction (`tx`): verifies `principal` owns `orderPublicId`, computes integer line/tax/total
   * math, allocates the sequential invoice number, inserts an `issued` invoice + lines, records durable `invoice.created`
   * and `invoice.issued` events in `tx`, and returns the issued invoice summary ready for `payments.startCheckout`.
   */
  issueCheckoutInvoiceInTx(
    input: {
      principal: SessionPrincipal;
      orderId?: number;
      orderPublicId: string;
      currency: string;
      lines: readonly {
        description: string;
        quantity: number;
        unitAmountMinor: number;
        productKey?: string;
        tierKey?: string;
      }[];
      discountMinor: number;
      taxMinor?: number;
      dueAt?: Date;
      memo?: string;
    },
    tx: Tx,
  ): Promise<{
    invoiceId: number;
    invoicePublicId: string;
    invoiceNumber: string;
    orderId: number;
    orderPublicId: string;
    currency: string;
    subtotalMinor: number;
    discountMinor: number;
    taxMinor: number;
    totalMinor: number;
    issuedAt: Date;
  }>;

  /**
   * Checkout policy-acceptance hook for `cart` (`recovery_ops_engineer`).
   * Records `portal_checkbox` or `typed_signature` acceptances bound to `orderId`/`orderPublicId` inside `tx`.
   */
  recordCheckoutAcceptances(
    input: {
      principal: SessionPrincipal;
      orderId?: number;
      orderPublicId?: string;
      items: readonly { versionPublicId: string; contentHash: string; signerName?: string }[];
    },
    tx: Tx,
  ): Promise<{ recorded: number }>;

  /**
   * Verified online payment booking hook for `payments` (Package K, Decision 12).
   * Called ONLY after BOTH a verified signed webhook AND a matching provider `fetchPayment` check succeed.
   * Idempotent on `idempotencyKey`; records `compliance_invoice_payments` (`method: "provider_online"`), transitions
   * `compliance_invoices.status` to `"paid"` when netPaid >= totalMinor, emits `invoice.payment.recorded` (firing
   * `invoice.paid` in `TRIGGER_CATALOGUE` for automations & outbound webhooks), and invokes `onInvoicePaid` listeners in `tx`.
   */
  bookVerifiedProviderPayment(
    input: {
      invoicePublicId: string;
      provider: "stripe" | "square";
      environment: "test" | "live";
      attemptPublicId: string;
      providerPaymentRef: string;
      amountMinor: number;
      currency: string;
      paidAt: Date;
      idempotencyKey: string;
    },
    tx: Tx,
  ): Promise<{
    paymentPublicId: string;
    invoiceId: number;
    invoicePublicId: string;
    invoiceNumber: string | null;
    invoiceStatus: InvoiceStatus;
    balanceDueMinor: number;
    duplicate: boolean;
  }>;

  /**
   * In-transaction listener registration for `referrals` (`siem_engineer`, Package G).
   * Invoked inside `tx` whenever an invoice transitions from unpaid (`status !== "paid"`) to `"paid"` (both manual
   * staff payment and verified Stripe/Square online payment).
   */
  onInvoicePaid(
    listener: (
      event: {
        invoiceId: number;
        invoicePublicId: string;
        invoiceNumber: string | null;
        orderId: number;
        orderPublicId: string;
        orderReference: string;
        ownerUserId: number;
        totalMinor: number;
        netPaidMinor: number;
        currency: string;
        paymentPublicId: string;
        method: PaymentMethod;
        provider: "stripe" | "square" | null;
        paidAt: Date;
      },
      tx: Tx,
    ) => Promise<void>,
  ): void;
}
```

In `compliance.init()`, the module also registers the `invoices` resource provider on `deps.services.publicApi?.registerProvider("invoices", ...)` (`server/modules/publicApi/ports.ts`).

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
| `intake.listForOrder` | `protectedProcedure` | `{ orderPublicId, orderReference, lockState, items }` for `{ orderPublicId }` (`default`, `catalog_item`, and `workflow` scope; greatest-per-group latest review note SQL join; all submission answers are AES-256-GCM encrypted at rest and field `sensitive: boolean` marks UI display sensitivity) |
| `intake.getSubmission` | `protectedProcedure` | `{ item, revisions, nextCursor }` for `{ orderPublicId, questionnairePublicId, cursor?, limit? }` |
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
| `invoices.listForOrder` | `protectedProcedure` | `{ orderPublicId }` -> `{ orderPublicId, orderReference, lockState, onlinePaymentConfigured, items }` (hides `draft` from customers) |
| `invoices.get` | `protectedProcedure` | `{ invoicePublicId }` -> `InvoiceDetailView` (`onlinePaymentConfigured: false`, `onlinePaymentMessage: "Online payment is not configured"`) |
| `invoices.admin.list` | `staffProcedure` (`invoices.read_all`) | `{ status?, orderPublicId?, cursor?, limit? }` -> `{ items, nextCursor }` |
| `invoices.admin.createDraft` | `staffProcedure` + `invoices.manage` (step-up) | `{ orderPublicId, currency, lines, discountMinor, taxMinor, dueAt?, memo? }` -> `{ invoicePublicId, totalMinor, currency }` |
| `invoices.admin.updateDraft` | `staffProcedure` + `invoices.manage` (step-up) | `{ invoicePublicId, expectedVersion, currency, lines, discountMinor, taxMinor, dueAt?, memo? }` -> `{ invoicePublicId, version, totalMinor }` |
| `invoices.admin.issue` | `staffProcedure` + `invoices.manage` (step-up) | `{ invoicePublicId, dueAt? }` -> `{ invoicePublicId, invoiceNumber, status, issuedAt }` |
| `invoices.admin.void` | `staffProcedure` + `invoices.manage` (step-up) | `{ invoicePublicId, reason }` -> `{ invoicePublicId, status: "void", voidedAt }` |
| `invoices.admin.recordManualPayment` | `staffProcedure` + `invoices.manage` (step-up) | `{ invoicePublicId, method, amountMinor, currency, reference, notes?, receivedAt?, idempotencyKey }` -> `{ paymentPublicId, invoiceStatus, balanceDueMinor, duplicate }` |
| `invoices.admin.recordRefund` | `staffProcedure` + `payments.refund` (admin + step-up) | `{ invoicePublicId, paymentPublicId, amountMinor, currency, reasonCode, reference, notes?, refundedAt?, confirmationPhrase: "REFUND ORDER", idempotencyKey }` -> `{ refundPublicId, invoiceStatus, balanceDueMinor, duplicate }` (manual payments only; `provider_online` payments refused with `CONFLICT:PROVIDER_PAYMENT_USE_ORDER_REFUNDS`; serializes against `compliance_invoice_payments` `FOR UPDATE`) |

## 5. Raw HTTP routes (`/api/compliance/...`)

| Route | Guard | Purpose |
| --- | --- | --- |
| `GET /api/compliance/invoices/:invoicePublicId/pdf` | `requireFullSession` + order read scope | Generates clean dependency-free PDF-1.4 invoice document, audits `invoice.downloaded` inside `tx`, and streams via `sendPrivateDownload` (`Content-Disposition: attachment`, `nosniff`, `no-store`) |

## 6. Audit events (all `snake_case` attributes)

- Category `admin` / `business` (in-tx on completion):
  - `policy.document.created`, `policy.document.updated`, `policy.version.draft_saved`, `policy.version.draft_deleted`, `policy.version.published` (`admin`)
  - `policy.acceptance_log.exported` (`admin`, attributes: `row_count`, `truncated`, `max_rows`, `scan_capped`, `filters`)
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

## 8. Increment 04 Part B Ports (`policies`, `intake`, `invoices`)

- **Package V — Order Policy Acceptance Gate Port (`server/modules/compliance/policiesService.ts`)**:
  - `compliance.policies.versionForGate(policyPublicId: string, tx?: DbOrTx): Promise<PolicyForGateView | null>` — returns the policy document metadata and its current published effective version (`id`, `publicId`, `versionNumber`, `versionLabel`, `contentFormat`, `bodyText`, `contentHash`, `effectiveAt`, `publishedAt`), or `currentVersion: null` when draft-only or archived (`active === false`).
  - `compliance.policies.versionById(versionId: number, tx?: DbOrTx): Promise<PolicyForGateView | null>` — resolves any historical `policy_versions` row by numeric FK id even after the parent document is archived so signed order-acceptance evidence remains inspectable.
  - `compliance.intake.saveDraft` & `compliance.intake.submit` invoke `deps.services.orders.gates.assertCustomerMayWork({ tx, orderId, actor, action: "intake", statusKey })` fail-closed inside `tx` whenever the caller is a customer.
- **Package U — Order Payment State & Refund Ledger Ports (`server/modules/compliance/invoicesService.ts`)**:
  - `InvoiceSummaryView.paymentState`: `"draft" | "unpaid" | "partially_paid" | "paid" | "partially_refunded" | "refunded" | "void"` alongside `refundedMinor` and `grossPaidMinor`.
  - `compliance.invoices.getOrderPaymentSummaries(orderPublicIds: readonly string[], tx?: DbOrTx)` — batched read port returning `Map<string, { state: "unpaid" | "paid" | "partially_refunded" | "refunded", totalMinor: number, currency: string }>` for `orders` console headers/lists.
  - `compliance.invoices.listOrderPaymentsAndRefunds`, `lockOrderPaymentForRefundInTx`, and `bookSettledRefundInTx` — internal transactional ports consumed by `payments.refunds` to lock captured payments `FOR UPDATE`, book settled provider/manual refunds idempotently, and fire `deps.services.referrals.onInvoiceRefunded(event, { tx })` when an invoice becomes fully refunded.

## 9. Increment 05 Ports & Procedures (`acceptanceLog`, `orderPaymentExposureInTx`, C4 Invoices)

### 9.1 Policy Acceptance Log Centre (`trpc.compliance.policies.admin.acceptanceLog.*` — Package D1)

All procedures under `compliance.policies.admin.acceptanceLog` are read-only evidence views (plus `export` mutation). No acceptance evidence row is ever altered or deleted.

**Authorization rule (Contract §4 & D4)**:
- Router guard runs **before** `.input()` parsing: `staffProcedure.use(requireCapability("policies.acceptances.read"))` on all read queries and `staffProcedure.use(requireCapability("policies.acceptances.export"))` on `export`.
- Unauthenticated -> `UNAUTHENTICATED` (`UNAUTHORIZED` in tRPC, before input validation)
- `customer` session -> `FORBIDDEN` at the `staffProcedure` router guard before input validation (and `NOT_FOUND` + `authz.compliance.denied` at the service defence-in-depth layer if invoked directly or if a staff user was demoted live)
- `staff` / `admin` lacking the required capability (`policies.acceptances.read` on queries; `policies.acceptances.export` on `export`) -> `FORBIDDEN` (`CAPABILITY_NOT_GRANTED`)
- `export` additionally requires fresh step-up (`STEP_UP_REQUIRED` when stale/missing) and re-validates the live actor inside `tx`, recording durable audit event `policy.acceptance_log.exported` (`category: "admin"`, attributes `{ row_count, truncated, max_rows, scan_capped, filters }`).
- **Typed signer name confidentiality**: `list`, `forCustomer`, and `export` DTOs **never** carry `typedSignerName`. Only `detail` returns `typedSignerName: string | null` + `signerNameRedacted: boolean`, decrypting only when the live caller holds `policies.manage`.

```ts
export type AcceptanceLogSource =
  | "registration"
  | "portal_acceptance"
  | "portal_reacceptance"
  | "checkout"
  | "order_gate"
  | "imported_historical";

export type AcceptanceLogMethod = "checkbox" | "typed_signature" | "imported";
export type AcceptanceFreshness = "current" | "superseded";
export type AcceptanceEvidenceKind = "account" | "order_gate";

export interface AcceptanceLogCustomerSummary {
  userPublicId: string;
  name: string;
  email: string;
  customerRef: string | null;
}

export interface AcceptanceLogFilterInput {
  /** Free-text customer filter (matches name token prefix, exact e-mail, or customerRef prefix via identity.findCustomerIds). */
  customerQuery?: string;
  /** Exact customer filter (26-char ULID). */
  customerPublicId?: string;
  policyDocumentPublicId?: string;
  versionPublicId?: string;
  /** Inclusive lower bound on acceptedAt. */
  from?: Date;
  /** Exclusive upper bound on acceptedAt. */
  to?: Date;
  source?: AcceptanceLogSource;
  method?: AcceptanceLogMethod;
  freshness?: AcceptanceFreshness;
  /** Case-insensitive order reference or 26-char orderPublicId filter. */
  orderReference?: string;
}

export interface AcceptanceLogListInput extends AcceptanceLogFilterInput {
  cursor?: string; // opaque keyset cursor encoding (acceptedAt, publicId)
  limit?: number;  // 1..100, default 50
}

/** List & customer-history item — never contains typedSignerName. */
export interface AcceptanceLogItem {
  publicId: string; // 26-char ULID of the evidence row
  evidenceKind: AcceptanceEvidenceKind;
  acceptedAt: Date;
  customer: AcceptanceLogCustomerSummary | null;
  policyDocumentPublicId: string;
  policySlug: string;
  policyTitle: string;
  versionPublicId: string;
  versionNumber: number;
  versionLabel: string;
  contentHash: string;      // full 64-hex SHA-256
  shortContentHash: string; // first 12 hex chars
  source: AcceptanceLogSource;
  method: AcceptanceLogMethod;
  hasTypedSignature: boolean;
  freshness: AcceptanceFreshness;
  supersededByVersionPublicId: string | null;
  supersededByVersionLabel: string | null;
  orderPublicId: string | null;
  orderReference: string | null;
  gateKey: string | null;
  addressPseudonym: string | null;
  correlationId: string | null;
  origin: "portal" | "import";
}

export interface AcceptanceLogDetailView extends AcceptanceLogItem {
  contentFormat: PolicyContentFormat;
  bodyText: string;
  effectiveAt: Date;
  publishedAt: Date | null;
  /** Non-null ONLY when `hasTypedSignature === true` AND live caller holds `policies.manage`. */
  typedSignerName: string | null;
  /** True when `hasTypedSignature === true` and caller lacks `policies.manage`. */
  signerNameRedacted: boolean;
}

export interface AcceptanceFilterOptionsView {
  policies: Array<{
    documentPublicId: string;
    slug: string;
    title: string;
    audience: PolicyAudience;
    active: boolean;
    requiresAcceptance: boolean;
    versions: Array<{
      versionPublicId: string;
      versionNumber: number;
      versionLabel: string;
      publishedAt: Date | null;
      isCurrent: boolean;
    }>;
  }>;
}

export interface PolicyCoverageOutstandingCustomer {
  customer: AcceptanceLogCustomerSummary;
  lastAcceptedVersionPublicId: string | null;
  lastAcceptedVersionNumber: number | null;
  lastAcceptedVersionLabel: string | null;
  lastAcceptedAt: Date | null;
}

export interface PolicyCoverageDocumentView {
  documentPublicId: string;
  slug: string;
  title: string;
  audience: PolicyAudience;
  currentVersionPublicId: string;
  currentVersionNumber: number;
  currentVersionLabel: string;
  publishedAt: Date | null;
  effectiveAt: Date;
  activeCustomerCount: number;
  acceptedCurrentCount: number;
  outstandingCount: number;
  outstandingCustomers: PolicyCoverageOutstandingCustomer[];
  outstandingTruncated: boolean;
}

export interface PolicyCoverageView {
  activeCustomerCount: number;
  policies: PolicyCoverageDocumentView[];
}

export interface PolicyUpdateHistoryItem {
  documentPublicId: string;
  policySlug: string;
  policyTitle: string;
  audience: PolicyAudience;
  versionPublicId: string;
  versionNumber: number;
  versionLabel: string;
  contentHash: string;
  shortContentHash: string;
  changeSummary: string | null;
  publishedAt: Date | null;
  effectiveAt: Date;
  publishedBy: { userPublicId: string; name: string; email: string } | null;
  isCurrent: boolean;
  acceptedCustomerCount: number;
}

export type CustomerPolicyRequirementState =
  | "accepted_current"
  | "update_pending"
  | "not_accepted"
  | "not_required";

export interface CustomerPolicyStatusRow {
  documentPublicId: string;
  slug: string;
  title: string;
  requiresAcceptance: boolean;
  requiresTypedSignature: boolean;
  currentVersionPublicId: string;
  currentVersionNumber: number;
  currentVersionLabel: string;
  currentPublishedAt: Date | null;
  currentEffectiveAt: Date;
  state: CustomerPolicyRequirementState;
  acceptedVersionPublicId: string | null;
  acceptedVersionNumber: number | null;
  acceptedVersionLabel: string | null;
  acceptedAt: Date | null;
}

export interface CustomerPolicyAcceptanceProfileView {
  customer: AcceptanceLogCustomerSummary;
  policies: CustomerPolicyStatusRow[];
  history: AcceptanceLogItem[];
  nextCursor: string | null;
}

export interface PolicyVersionReadView {
  documentPublicId: string;
  policySlug: string;
  policyTitle: string;
  audience: PolicyAudience;
  requiresAcceptance: boolean;
  requiresTypedSignature: boolean;
  versionPublicId: string;
  versionNumber: number;
  versionLabel: string;
  contentFormat: PolicyContentFormat;
  bodyText: string;
  contentHash: string;
  shortContentHash: string;
  changeSummary: string | null;
  effectiveAt: Date;
  publishedAt: Date | null;
  isCurrent: boolean;
}

export interface AcceptanceLogExportResult {
  filename: string;
  contentType: "text/csv; charset=utf-8";
  csv: string;
  rowCount: number;
  truncated: boolean;
  maxRows: number;
}
```

| Procedure | Guard | Input -> Output |
| --- | --- | --- |
| `policies.admin.acceptanceLog.filterOptions` | `staffProcedure` + `policies.acceptances.read` | `void` -> `AcceptanceFilterOptionsView` |
| `policies.admin.acceptanceLog.list` | `staffProcedure` + `policies.acceptances.read` | `AcceptanceLogListInput` -> `{ items: AcceptanceLogItem[], nextCursor: string \| null }` |
| `policies.admin.acceptanceLog.detail` | `staffProcedure` + `policies.acceptances.read` (`policies.manage` for `typedSignerName`) | `{ publicId: string }` -> `AcceptanceLogDetailView` |
| `policies.admin.acceptanceLog.coverage` | `staffProcedure` + `policies.acceptances.read` | `{ documentPublicId?: string, outstandingLimit?: number /* 1..200, default 100 */ }?` -> `PolicyCoverageView` |
| `policies.admin.acceptanceLog.updates` | `staffProcedure` + `policies.acceptances.read` | `{ documentPublicId?: string }?` -> `{ items: PolicyUpdateHistoryItem[] }` |
| `policies.admin.acceptanceLog.forCustomer` | `staffProcedure` + `policies.acceptances.read` | `{ customerPublicId: string, cursor?: string, limit?: number }` -> `CustomerPolicyAcceptanceProfileView` |
| `policies.admin.acceptanceLog.versionText` | `staffProcedure` + `policies.acceptances.read` | `{ versionPublicId: string }` -> `PolicyVersionReadView` |
| `policies.admin.acceptanceLog.export` | `staffProcedure` + `policies.acceptances.export` (admin + step-up) | `AcceptanceLogFilterInput` -> `AcceptanceLogExportResult` |

- **Live session & signer-name confidentiality**:
  - Every `acceptanceLog.*` read verifies a populated live session bound to `(userId, userPublicId, role, authMethod)` alongside live active-user + capability re-validation (`NOT_FOUND` for customers, `FORBIDDEN` + `authz.compliance.denied` for unauthorized staff).
  - Raw `list`, `forCustomer`, and `export` payloads never carry or decrypt `typedSignerName`. On `detail`, `typedSignerName` is decrypted only inside a transaction that calls `identity.sessions.assertCurrent(tx, principal)` and verifies live `policies.manage`.
- **Bounded unified scan & lock-free CSV export**:
  - `list`, `forCustomer`, and `export` bound unified stream refinement to `MAX_UNIFIED_SCAN_ROWS = 10_000` raw evidence rows and `MAX_UNIFIED_SCAN_MS = 3_000` ms per call. When sparse post-refinement filters hit the scan/time budget before filling `limit`, `list`/`forCustomer` emit a frontier continuation `nextCursor` (including 0-item intermediate pages when more raw rows exist) and `export` marks `truncated: true` (`scan_capped: true` in `policy.acceptance_log.exported`).
  - `export` preflights live authorization (`READ`), executes the bounded unified scan outside any `FOR UPDATE` row lock, and re-acquires `FOR UPDATE` + `sessions.assertCurrent(tx, principal)` + fresh step-up inside the final transaction that records `policy.acceptance_log.exported`.

### 9.2 Order Payment Exposure Port (`compliance.orderPaymentExposureInTx` — G-C3-02)

- `compliance.orderPaymentExposureInTx(tx: Tx, orderPublicId: string): Promise<{ grossPaidMinor: number; payableInvoiceOpen: boolean; providerCapturePending: boolean; providerAttemptEver: boolean }>`
- Acquires the order row lock (`FOR UPDATE` via `orders.getOrderRefByPublicId`), then performs sequential non-blocking current reads (`FOR SHARE NOWAIT`) on `compliance_invoices`, `compliance_invoice_payments`, `compliance_invoice_refunds`, and `payment_attempts`, failing closed (redemption stays used) on any lock contention or missing `payments` evidence port without poisoning the caller's outer MariaDB transaction.
- `grossPaidMinor`: sum of `amountMinor` across `succeeded` payment rows across all invoices of the order (partial payments and later-refunded payments keep `grossPaidMinor > 0`).
- `payableInvoiceOpen`: `true` if any non-voided, issued invoice on the order has `balanceDueMinor > 0`. (Zero-total `$0.00` issued invoices derive `status = "paid"`, `balanceDueMinor = 0`, so `payableInvoiceOpen = false`.)
- `providerAttemptEver`: strictly conservative per `/root` G-C3-02 ruling — `true` if **any** `payment_attempts` row has **ever** been created for the order or its invoices, regardless of status (`created`, `redirected`, `paid`, `failed`, `cancelled`, `expired`), or if the `payments` evidence port is unavailable (even when the order has zero invoices) or any lock contention/query error occurs.
- `providerCapturePending`: `true` if any `payment_attempts` row is in `created`, `redirected`, `cancelled`, `paid` (unbooked), or `failed` (with verified webhook), or on lock contention / missing port. `invoices.admin.{create,issue}`, `issueCheckoutInvoiceInTx`, and `payments.startCheckout` also resolve workflow cancel states (`kind === "terminal" && /cancel/.test(key)`) directly from the `FOR UPDATE`-locked `(workflowVersionId, statusKey)` without non-locking re-reads.

### 9.3 Invoice Promo Discount Breakdown (Package C4)

- `InvoiceDetailView` (returned by `compliance.invoices.get`) adds:
  - `bundleDiscountMinor: number` (`discountMinor - promoDiscountMinor` when aligned with the order's discount breakdown; `0` when promo replaced bundle or no bundle applied)
  - `discountLabel: string | null` (order discount label when no promo applied, or `"Bundle discount"` when both bundle and promo applied)
  - `promoDiscountMinor: number` (`0` when no promo code applied)
  - `promoLabel: string | null` (customer-facing promo label from `order.promoLabel`; never the raw code)
- Rendered as separate labelled rows on customer `/invoices/:invoiceId`, console `/admin/invoices/:invoiceId`, and `GET /api/compliance/invoices/:invoicePublicId/pdf`.

---

## 10. Increment 06 — Package M (D5, D11, D12, D14, D15)

### 10.1 D11 Typed-Signature Name Check (`compliance.signature_name_check`)

- Setting `compliance.signature_name_check`: `{ mode: "require" | "warn" | "off" }` (default `"require"`, backward-compatible parse with defaults).
- Shared normalization (`server/modules/compliance/signatureNameCheck.ts`): NFC, collapse whitespace, trim, Unicode case-fold, strip leading/trailing punctuation (`.,'-`). Empty/whitespace-only account names fail closed when `mode === "require"` (`SIGNER_NAME_MISMATCH`).
- Enforced behind both `policies.accept` (`policiesService.ts`) and workflow/order agreement gates (`acceptance.ts`), persisting `"exact" | "first_last" | "mismatch_warn" | "unchecked" | null` on `compliance_policy_acceptances` and `order_policy_acceptances` and surfacing `signatureMatch` in `policies.admin.acceptanceLog.{list,detail,forCustomer,export}` and the Acceptance Log Centre UI (`PolicyAcceptancesPage`).
- Customer surfaces (`PolicyAcceptance.tsx`, `AcceptanceGate.tsx`, and `@/lib/agreementGate/AgreementDialog.tsx`) show only the signed-in user's own account name and link to `/account` for self-service name updates; `SIGNER_NAME_MISMATCH` errors include `details.expectedName` only for the authenticated signer's own user row.

### 10.2 D12 Document Import & D14 Order Agreement (MNDA) Admin Card + Shared Gate

- `CreatePolicyDialog` (`PoliciesAdminPage.tsx`) and `DraftDialog` (`PolicyDetailPage.tsx`) mount `DocumentImportButton` (`integrations_engineer`) to fill `safe_markdown` draft text without auto-publishing; all client and server surfaces are designed and tested against WCAG 2.2 AA.
- `PoliciesAdminPage.tsx` mounts `#order-agreement` (`OrderAgreementCard`) reading/updating `orders.admin.agreementGate.{get,update}` (`orders_engineer`) with step-up MFA challenge when disabling an active gate (`expectedEnabled`).
- Shared client agreement gate (`client/src/lib/agreementGate/{index.ts,AgreementDialog.tsx}`) exports `agreementStatus`, `useAgreementStatus`, `extractAgreementRequiredDetails`, and `AgreementDialog` for `cart`, `orders`, and `files`.

### 10.3 D15 Payment Receipts, Refund Notes & Company Billing Profile

- Tables (`server/modules/compliance/schema.ts`): `compliance_payment_receipts` (`RPR-<year>-<6 digits>` via `compliance_sequences`, immutable `snapshotJson`, `settlementKind: "provider_online" | "zero_total" | "waived_below_minimum" | "manual"`, `resendCount`, `lastResentAt`) and `compliance_refund_notes` (`RPRN-<year>-<6 digits>`, immutable `snapshotJson`).
- Settings:
  - Company billing profile (`compliance.invoices.issuer_name`, `issuer_address`, `issuer_contact`, `issuer_tax_id`, `issuer_logo`, `payment_instructions`) via `compliance.invoices.admin.companyProfile.{get,update}` (`invoices.manage`, step-up MFA on `update`).
  - `payments.receipts`: `{ enabled: boolean, emailCustomer: boolean, footerText: string }` (default `{ enabled: true, emailCustomer: true, footerText: "" }`).
- One receipt per settled payment (webhook-confirmed provider capture, `$0.00` settlement, waived sub-minimum settlement, or staff manual payment), idempotent by `(invoiceId, paymentId)` or `(invoiceId, settlementKind)`. Waived amounts (`waivedMinor`) settle invoice balance without inflating `grossPaidMinor` or refundable balances.
- Outbound mail enqueues `mail.send_template` with `templateKey: "payment_receipt"` and the rendered receipt PDF attached; staff `"Send again"` (`compliance.receipts.admin.resend`, `invoices.read_all`) enforces a DB-durable 3-per-hour rolling window in `compliance_sequences`.
- Strict receipt & refund-note ACL (`assertCustomerReceiptAccess`): only the order buyer (`order.customerId === userId`), an active explicit billing grant (`billing` / `billing_viewer` / `payer` / `finance`), or staff with `invoices.read_all` may list, view, or download receipts and refund notes (`/api/compliance/receipts/:receiptPublicId/pdf`, `/api/compliance/refund-notes/:notePublicId/pdf`). Generic order collaborators receive a detail-free `404 NOT_FOUND` on direct ID/PDF routes and `FORBIDDEN` on `listForOrder` (gracefully hidden in `CustomerOrderReceiptsSection`).
- Routes & UI: customer `/invoices` (`"Invoices"` | `"Receipts"` tabs), `/receipts/:receiptId`, Console `/admin/receipts/:receiptId`, Console order billing `"Payment receipts"` section, customer profile `"Receipts"` tab (`CustomerReceiptsTab`), and `CompanyProfileDialog` on `/admin/invoices`.

---

## 11. Increment 07 — Package M (D9 Order/Cart Payment Booking, Customer Pay Online & D12 Receipt Sync Port)

- **Atomic booking side-effects inside `tx` (`server/modules/compliance/invoicesService.ts`)**:
  - Whenever an invoice becomes settled (`bookVerifiedProviderPayment`, `recordManualPayment`, or `settleCheckoutInvoiceInTx` for `zero_total` / `waived_small_total`), `compliance` runs inside the same database transaction:
    1. `services.cart.onInvoicePaidInTx({ invoicePublicId, orderPublicId, paidAt }, tx)` — transitions any `awaiting_payment` cart to `checked_out`.
    2. `services.orders.payments.onInvoicePaidInTx({ orderPublicId, invoicePublicId, paidAt, method: provider ? "stripe" : "manual", amountMinor, currency }, tx)` — sets `orders.payment_state = "paid"` + `paid_at`, completes any stage with `completesOn: "payment"`, and advances the order with history reason `INVOICE_PAID`.
    3. Issues the immutable payment receipt (`RPR-...`) and stages optional Microsoft 365 receipt sync (`services.storageConnections?.stageReceiptPdf({ receiptPublicId, orderPublicId }, tx)`).
    4. Records durable `invoice.payment.recorded` (`outcome: "completed"`, attributes include `order_public_id`, `invoice_public_id`, `method`, `amount_minor`, `currency`, `payment_state: "paid"`), firing the `payment.succeeded` (`D5`) and `invoice.paid` automation triggers.
  - Whenever a refund settles (`bookSettledRefundInTx` or `invoices.admin.recordRefund`), `compliance` updates receipt refund state / issues `RPRN-...`, calls `services.orders.payments.onPaymentEventInTx({ orderPublicId, kind: resultingState, eventRef }, tx)` (`"partially_refunded" | "refunded"`), and ensures durable `payment.refund.succeeded` (`outcome: "completed"`) is recorded for the `payment.refunded` (`D5`) trigger.
- **Customer Invoice `"Pay online"` & Return Banner (`invoicesService.ts`, `client/src/features/compliance/customer/InvoicePages.tsx`)**:
  - `compliance.invoices.get` and `compliance.invoices.listForOrder` populate `onlinePaymentConfigured` from live `services.payments.isOnlineCheckoutEnabled(tx)`.
  - Customer `/invoices` and `/invoices/:invoiceId` render a `"Pay online"` action on issued unpaid invoices (`balanceDueMinor > 0`) when `onlinePaymentConfigured === true`, invoking `trpc.payments.startInvoiceCheckout` with return paths `/invoices/:invoiceId`, and render a read-only return status banner when `?attempt=<ulid>&result=return|cancelled` is present (polling `trpc.payments.checkoutStatus` and linking to `/receipts/:receiptPublicId` once webhook-confirmed).
- **D12 Microsoft 365 Receipt PDF Source Port (`services.compliance.receipts.getFileSyncPdf`)**:
  - `getFileSyncPdf(input: { receiptPublicId: string; orderPublicId: string }, tx: Tx): Promise<Buffer | null>`
  - Verifies the `compliance_payment_receipts` row exists, matches `orderPublicId`, and has `origin === "portal"`, decrypts `pdf_enc` with AAD `compliance_payment_receipts.pdf:<receiptPublicId>`, and returns the immutable PDF `Buffer` (or `null` when missing, mismatched, or imported).
- **D5 Trigger Context Resolvers (`server/modules/compliance/automationTriggers.ts`)**:
  - Registers context resolvers (`order_owner`, `order_assignee`, `order_reference`, `order_status`, `recipient_name`, plus safe scalar fields) for `payment.succeeded`, `payment.failed`, `payment.refunded`, `intake.submitted`, and `intake.reviewed`.



