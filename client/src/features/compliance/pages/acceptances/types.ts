/**
 * Client-side DTOs and typed tRPC proxy helper for the Policy Acceptance Log Centre (Package D2).
 * Mirrors `server/modules/compliance/API.md` §9.1 (`compliance.policies.admin.acceptanceLog.*`).
 */
import type {
  InfiniteData,
  UseInfiniteQueryOptions,
  UseMutationOptions,
  UseQueryOptions,
} from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";
import type { PolicyContentFormat } from "../../shared";

export type PolicyAudience = "all" | "customer" | "staff";
export type { PolicyContentFormat };

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
  customerQuery?: string;
  customerPublicId?: string;
  policyDocumentPublicId?: string;
  versionPublicId?: string;
  from?: Date;
  to?: Date;
  source?: AcceptanceLogSource;
  method?: AcceptanceLogMethod;
  freshness?: AcceptanceFreshness;
  orderReference?: string;
}

export interface AcceptanceLogListInput extends AcceptanceLogFilterInput {
  cursor?: string;
  limit?: number;
}

export interface AcceptanceLogItem {
  publicId: string;
  evidenceKind: AcceptanceEvidenceKind;
  acceptedAt: Date | string;
  customer: AcceptanceLogCustomerSummary | null;
  policyDocumentPublicId: string;
  policySlug: string;
  policyTitle: string;
  versionPublicId: string;
  versionNumber: number;
  versionLabel: string;
  contentHash: string;
  shortContentHash: string;
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

export interface AcceptanceLogListOutput {
  items: AcceptanceLogItem[];
  nextCursor: string | null;
}

export interface AcceptanceLogDetailView extends AcceptanceLogItem {
  contentFormat: PolicyContentFormat;
  bodyText: string;
  effectiveAt: Date | string;
  publishedAt: Date | string | null;
  typedSignerName: string | null;
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
      publishedAt: Date | string | null;
      isCurrent: boolean;
    }>;
  }>;
}

export interface PolicyCoverageOutstandingCustomer {
  customer: AcceptanceLogCustomerSummary;
  lastAcceptedVersionPublicId: string | null;
  lastAcceptedVersionNumber: number | null;
  lastAcceptedVersionLabel: string | null;
  lastAcceptedAt: Date | string | null;
}

export interface PolicyCoverageDocumentView {
  documentPublicId: string;
  slug: string;
  title: string;
  audience: PolicyAudience;
  currentVersionPublicId: string;
  currentVersionNumber: number;
  currentVersionLabel: string;
  publishedAt: Date | string | null;
  effectiveAt: Date | string;
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
  publishedAt: Date | string | null;
  effectiveAt: Date | string;
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
  currentPublishedAt: Date | string | null;
  currentEffectiveAt: Date | string;
  state: CustomerPolicyRequirementState;
  acceptedVersionPublicId: string | null;
  acceptedVersionNumber: number | null;
  acceptedVersionLabel: string | null;
  acceptedAt: Date | string | null;
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
  effectiveAt: Date | string;
  publishedAt: Date | string | null;
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

interface QueryProc<TInput, TOutput> {
  queryOptions: (
    input: TInput,
    opts?: { enabled?: boolean },
  ) => UseQueryOptions<TOutput, unknown, TOutput>;
}

interface VoidQueryProc<TOutput> {
  queryOptions: (
    input?: undefined,
    opts?: { enabled?: boolean },
  ) => UseQueryOptions<TOutput, unknown, TOutput>;
}

interface InfiniteQueryProc<TInput extends { cursor?: string }, TOutput extends { nextCursor: string | null }> {
  infiniteQueryOptions: (
    input: Omit<TInput, "cursor">,
    opts: {
      getNextPageParam: (lastPage: TOutput) => string | undefined;
      retry?: boolean;
      enabled?: boolean;
    },
  ) => UseInfiniteQueryOptions<TOutput, unknown, InfiniteData<TOutput>, readonly unknown[], string | undefined>;
}

interface MutationProc<TInput, TOutput> {
  mutationOptions: (
    opts?: UseMutationOptions<TOutput, unknown, TInput>,
  ) => UseMutationOptions<TOutput, unknown, TInput>;
}

export interface AcceptanceLogProcedures {
  filterOptions: VoidQueryProc<AcceptanceFilterOptionsView>;
  list: InfiniteQueryProc<AcceptanceLogListInput, AcceptanceLogListOutput>;
  detail: QueryProc<{ publicId: string }, AcceptanceLogDetailView>;
  coverage: QueryProc<{ documentPublicId?: string; outstandingLimit?: number }, PolicyCoverageView>;
  updates: QueryProc<{ documentPublicId?: string }, { items: PolicyUpdateHistoryItem[] }>;
  forCustomer: InfiniteQueryProc<
    { customerPublicId: string; cursor?: string; limit?: number },
    CustomerPolicyAcceptanceProfileView
  >;
  versionText: QueryProc<{ versionPublicId: string }, PolicyVersionReadView>;
  export: MutationProc<AcceptanceLogFilterInput, AcceptanceLogExportResult>;
}

export function useAcceptanceLogProcedures(): AcceptanceLogProcedures {
  const trpc = useTRPC();
  const realProcedures = trpc.compliance.policies.admin.acceptanceLog;
  return realProcedures as unknown as AcceptanceLogProcedures;
}
