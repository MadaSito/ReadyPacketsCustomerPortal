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
import type { ModuleDeps } from "../../container.js";
import type { DbOrTx, ModuleHealth, ModuleLifecycle, Tx } from "../../core/types.js";
import { createIntakeService, type IntakeService } from "./intakeService.js";
import {
  createInvoicesService,
  type InvoicesService,
  type RecordProviderPaymentInput,
  type RecordProviderPaymentResult,
} from "./invoicesService.js";
import { registerComplianceMailTemplates } from "./mail.js";
import {
  createPoliciesService,
  type PoliciesService,
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

export type {
  ImportPortableEvidenceInput,
  ImportPortableEvidenceReceipt,
  IntakeService,
  InvoicesService,
  PoliciesService,
  PortableEvidenceBatch,
  PortableEvidenceOptions,
  PublishedPolicyView,
  RecordProviderPaymentInput,
  RecordProviderPaymentResult,
  RequiredPolicySummary,
};
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

  /* ---- sub-services consumed by router & http ---- */
  policies: PoliciesService;
  intake: IntakeService;
  invoices: InvoicesService;
}

export function createComplianceModule(deps: ModuleDeps): ComplianceModule {
  registerComplianceMailTemplates(deps.mailer);
  const policies = createPoliciesService(deps);
  const intake = createIntakeService(deps);
  const invoices = createInvoicesService(deps);
  const portable = createPortableComplianceService(deps);

  return {
    listPublishedPolicies: policies.listPublished,
    requiredAcceptancesFor: policies.requiredAcceptancesFor,
    assertRequiredPoliciesAccepted: policies.assertRequiredPoliciesAccepted,
    recordRegistrationAcceptances: policies.recordRegistrationAcceptances,
    recordProviderPayment: invoices.recordProviderPayment,
    portableEvidence: portable.portableEvidence,
    importPortableEvidence: portable.importPortableEvidence,
    policies,
    intake,
    invoices,

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
