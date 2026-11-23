/**
 * Compliance module — public service surface and factory. Owner: compliance_engineer.
 *
 * Covers:
 *   1. Policies: immutable published versions (SHA-256 content hash), required-acceptance gating,
 *      re-acceptance detection, and durable acceptance evidence.
 *   2. Intake: versioned questionnaires per default/catalog-item/workflow scope, encrypted order
 *      submissions with full revision history, staff review, and order-lock enforcement.
 *   3. Invoices & Payment Evidence: sequential invoice numbering, pure minor-unit math, derived
 *      status (`draft` | `issued` | `paid` | `void`), manual payment & refund recording, PDF rendering,
 *      and idempotent verified provider payment webhook hook.
 *   4. Portable Evidence: normative `portable` v3 export (`portableEvidence`) and inert provenance-marked
 *      import (`importPortableEvidence`).
 */
import "./settings.js";
import "./automationTriggers.js";
import { createAcceptanceService, type AcceptanceService } from "./acceptance.js";
import type { ModuleDeps } from "../../container.js";
import type { DbOrTx, ModuleHealth, ModuleLifecycle, SessionPrincipal, Tx } from "../../core/types.js";
import type { PublicApiProviders } from "../publicApi/ports.js";
import { type InvoicePaymentState, type OrderHeaderPaymentState } from "./domain.js";
import { createIntakeService, type IntakeService } from "./intakeService.js";
import {
  type BookSettledRefundInput,
  type BookSettledRefundResult,
  type BookVerifiedProviderPaymentInput,
  type BookVerifiedProviderPaymentResult,
  type CheckoutInvoiceSnapshot,
  createInvoicesService,
  type InvoicePaidEvent,
  type InvoicePaidListener,
  type InvoicesService,
  type IssueCheckoutInvoiceInput,
  type IssuedCheckoutInvoice,
  type LockedOrderPaymentForRefund,
  type OrderInvoicePaymentLedgerEntry,
  type OrderInvoiceRefundLedgerEntry,
  type OrderPaymentExposure,
  type OrderPaymentSummary,
  type OrderRefundLedgerSnapshot,
  type RecordProviderPaymentInput,
  type RecordProviderPaymentResult,
  type SettleCheckoutInvoiceInput,
  type SettleCheckoutInvoiceResult,
} from "./invoicesService.js";
import { registerComplianceMailTemplates } from "./mail.js";
import {
  type AdminReceiptSummaryView,
  createReceiptsService,
  type ReceiptDetailView,
  type ReceiptsService,
  type ReceiptSummaryView,
  type RefundNoteSummaryView,
} from "./receiptsService.js";
import {
  createPoliciesService,
  type PoliciesService,
  type PolicyForGateView,
  type PolicyGateVersionView,
  type PublishedPolicyView,
  type RequiredPolicySummary,
} from "./policiesService.js";
import {
  createPortableComplianceService,
  type ImportPortableEvidenceInput,
  type ImportPortableEvidenceReceipt,
  type PortableEvidenceBatch,
  type PortableEvidenceOptions,
} from "./portableService.js";
import { createPolicyEnforcement, type PolicyEnforcementService } from "./policyEnforcement.js";
import { createPolicyNoticeRuntime } from "./policyNoticesRuntime.js";
import { createInvoicesPublicApiProvider } from "./publicApiProvider.js";

export type PolicyNoticesService = ReturnType<typeof createPolicyNoticeRuntime>;
export type { PolicyEnforcementService };
export type { SignatureNameMatchResult } from "./acceptanceSchema.js";
export type {
  AcceptanceEvidenceKind,
  AcceptanceFilterOptionsView,
  AcceptanceFreshness,
  AcceptanceLogCustomerSummary,
  AcceptanceLogDetailView,
  AcceptanceLogExportResult,
  AcceptanceLogFilterInput,
  AcceptanceLogItem,
  AcceptanceLogListInput,
  AcceptanceLogMethod,
  AcceptanceLogService,
  AcceptanceLogSource,
  CustomerPolicyAcceptanceProfileView,
  CustomerPolicyRequirementState,
  CustomerPolicyStatusRow,
  PolicyCoverageDocumentView,
  PolicyCoverageOutstandingCustomer,
  PolicyCoverageView,
  PolicyUpdateHistoryItem,
  PolicyVersionReadView,
} from "./acceptanceLogService.js";

export type {
  AdminReceiptSummaryView,
  BookSettledRefundInput,
  BookSettledRefundResult,
  BookVerifiedProviderPaymentInput,
  BookVerifiedProviderPaymentResult,
  CheckoutInvoiceSnapshot,
  ImportPortableEvidenceInput,
  ImportPortableEvidenceReceipt,
  IntakeService,
  InvoicePaidEvent,
  InvoicePaidListener,
  InvoicePaymentState,
  InvoicesService,
  IssueCheckoutInvoiceInput,
  IssuedCheckoutInvoice,
  LockedOrderPaymentForRefund,
  OrderHeaderPaymentState,
  OrderInvoicePaymentLedgerEntry,
  OrderInvoiceRefundLedgerEntry,
  OrderPaymentExposure,
  OrderPaymentSummary,
  OrderRefundLedgerSnapshot,
  PoliciesService,
  PolicyForGateView,
  PolicyGateVersionView,
  PortableEvidenceBatch,
  PortableEvidenceOptions,
  PublishedPolicyView,
  ReceiptDetailView,
  ReceiptsService,
  ReceiptSummaryView,
  RecordProviderPaymentInput,
  RecordProviderPaymentResult,
  RefundNoteSummaryView,
  RequiredPolicySummary,
  SettleCheckoutInvoiceInput,
  SettleCheckoutInvoiceResult,
};
export {
  parsePngForPdf,
  type ReceiptSnapshot,
  type RefundNoteSnapshot,
  renderInvoicePdf,
  renderPaymentReceiptPdf,
  renderRefundNotePdf,
} from "./invoicePdf.js";
export * from "./settings.js";

export interface ComplianceModule extends ModuleLifecycle {
  /* ---- cross-module policy gating & registration hooks ---- */
  listPublishedPolicies(): Promise<PublishedPolicyView[]>;
  requiredAcceptancesFor(
    userId: number,
    opts?: { audience?: "customer" | "staff"; tx?: DbOrTx },
  ): Promise<RequiredPolicySummary[]>;
  assertRequiredPoliciesAccepted(
    userId: number,
    opts?: { audience?: "customer" | "staff"; tx?: DbOrTx },
  ): Promise<void>;
  recordRegistrationAcceptances(
    input: {
      userId: number;
      items: readonly { versionPublicId: string; contentHash: string; signerName?: string }[];
    },
    opts?: { tx?: Tx },
  ): Promise<{ recorded: number }>;

  /* ---- verified provider payment webhook hook (integrations -> compliance) ---- */
  recordProviderPayment(input: RecordProviderPaymentInput): Promise<RecordProviderPaymentResult>;

  /* ---- portable-transfer hooks (portable -> compliance) ---- */
  portableEvidence(
    tx: DbOrTx,
    orderIds: readonly string[],
    after: string | null,
    limit: number,
    opts?: PortableEvidenceOptions,
  ): Promise<PortableEvidenceBatch>;
  importPortableEvidence(
    input: ImportPortableEvidenceInput,
    tx: Tx,
  ): Promise<ImportPortableEvidenceReceipt>;

  /* ---- Increment 04 checkout, online payment & referral hooks ---- */
  quoteTaxMinor(
    input: {
      subtotalAfterDiscountMinor: number;
      currency: string;
      billingCountry?: string | null;
      billingRegion?: string | null;
    },
    tx?: DbOrTx,
  ): Promise<{ taxRateBps: number; taxMinor: number }>;
  issueCheckoutInvoiceInTx(
    input: IssueCheckoutInvoiceInput,
    tx: Tx,
  ): Promise<IssuedCheckoutInvoice>;
  recordCheckoutAcceptances(
    input: {
      principal: SessionPrincipal;
      orderId?: number;
      orderPublicId?: string;
      items: readonly { versionPublicId: string; contentHash: string; signerName?: string }[];
    },
    tx: Tx,
  ): Promise<{ recorded: number }>;
  getInvoiceForCheckout(
    invoicePublicId: string,
    opts?: { principal?: SessionPrincipal; tx?: DbOrTx; forUpdate?: boolean },
  ): Promise<CheckoutInvoiceSnapshot>;
  bookVerifiedProviderPayment(
    input: BookVerifiedProviderPaymentInput,
    tx: Tx,
  ): Promise<BookVerifiedProviderPaymentResult>;
  settleCheckoutInvoiceInTx(
    input: SettleCheckoutInvoiceInput,
    tx: Tx,
  ): Promise<SettleCheckoutInvoiceResult>;
  onInvoicePaid(listener: InvoicePaidListener): void;
  /** Increment 05 (G-C3-02): authoritative transactional payment exposure for order cancel / promo release. */
  orderPaymentExposureInTx(tx: Tx, orderPublicId: string): Promise<OrderPaymentExposure>;

  /* ---- sub-services consumed by router & http ---- */
  policies: PoliciesService;
  policyNotices: PolicyNoticesService;
  policyEnforcement: PolicyEnforcementService;
  acceptance: AcceptanceService;
  intake: IntakeService;
  invoices: InvoicesService;
  receipts: ReceiptsService;
}

export function createComplianceModule(deps: ModuleDeps): ComplianceModule {
  registerComplianceMailTemplates(deps.mailer);
  const policyNotices = createPolicyNoticeRuntime(deps);
  const policyEnforcement = createPolicyEnforcement(deps);
  const policies = createPoliciesService(deps, {
    onVersionPublished: (tx, input) => policyNotices.onPublished(tx, input),
    assertRemediationPending: (userId, role, versionPublicId, tx) =>
      policyEnforcement.assertPending(userId, role, versionPublicId, tx),
  });
  const intake = createIntakeService(deps);
  const receipts = createReceiptsService(deps);
  const invoices = createInvoicesService(deps, receipts);
  const portable = createPortableComplianceService(deps);
  const acceptance = createAcceptanceService(deps);

  return {
    listPublishedPolicies: policies.listPublished,
    requiredAcceptancesFor: policies.requiredAcceptancesFor,
    assertRequiredPoliciesAccepted: policies.assertRequiredPoliciesAccepted,
    recordRegistrationAcceptances: policies.recordRegistrationAcceptances,
    recordProviderPayment: invoices.recordProviderPayment,
    portableEvidence: portable.portableEvidence,
    importPortableEvidence: portable.importPortableEvidence,
    quoteTaxMinor: invoices.quoteTaxMinor,
    issueCheckoutInvoiceInTx: invoices.issueCheckoutInvoiceInTx,
    recordCheckoutAcceptances: policies.recordCheckoutAcceptances,
    getInvoiceForCheckout: invoices.getInvoiceForCheckout,
    bookVerifiedProviderPayment: invoices.bookVerifiedProviderPayment,
    settleCheckoutInvoiceInTx: invoices.settleCheckoutInvoiceInTx,
    onInvoicePaid: invoices.onInvoicePaid,
    orderPaymentExposureInTx: invoices.orderPaymentExposureInTx,
    policies,
    policyNotices,
    policyEnforcement,
    intake,
    invoices,
    receipts,
    acceptance,

    async init(): Promise<void> {
      acceptance.register();
      const ordersSvc = (
        deps.services as unknown as {
          orders?: {
            registerPaymentSummaryProvider?: (
              fn: (
                orderPublicIds: string[],
                tx: DbOrTx,
              ) => Promise<Map<string, OrderPaymentSummary>>,
            ) => void;
          };
        }
      ).orders;
      if (ordersSvc && typeof ordersSvc.registerPaymentSummaryProvider === "function") {
        ordersSvc.registerPaymentSummaryProvider((orderPublicIds, tx) =>
          invoices.getOrderPaymentSummaries(orderPublicIds, tx),
        );
      }

      const publicApiSvc = (
        deps.services as unknown as {
          publicApi?: {
            registerProvider?: (
              key: "invoices",
              provider: PublicApiProviders["invoices"],
            ) => void;
          };
        }
      ).publicApi;
      if (publicApiSvc && typeof publicApiSvc.registerProvider === "function") {
        publicApiSvc.registerProvider("invoices", createInvoicesPublicApiProvider(deps));
      }
    },

    async health(): Promise<ModuleHealth[]> {
      const checkedAt = deps.clock.now();
      try {
        const [pCounts, iCounts, invCounts] = await Promise.all([
          policies.healthCounts(),
          intake.healthCounts(),
          invoices.healthCounts(),
        ]);
        return [
          {
            component: "compliance.policies",
            state: "ok",
            summary: "Policy documents and acceptance ledger healthy.",
            metrics: pCounts,
            checkedAt,
          },
          {
            component: "compliance.intake",
            state: "ok",
            summary: "Intake questionnaires and encrypted submission ledger healthy.",
            metrics: iCounts,
            checkedAt,
          },
          {
            component: "compliance.invoices",
            state: "ok",
            summary: "Invoice numbering and payment evidence ledger healthy.",
            metrics: invCounts,
            checkedAt,
          },
        ];
      } catch {
        return [
          {
            component: "compliance",
            state: "failing",
            summary: "Compliance database health query failed.",
            checkedAt,
          },
        ];
      }
    },
  };
}
