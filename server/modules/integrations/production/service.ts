/**
 * Production Webhooks Service (`services.integrations.production`) — Phase I (P101) & Phase II (P201).
 *
 * Enforces:
 *  - Default-disabled posture (`integrations.production` flag off; no default `canonVersion`)
 *  - Write-only FieldCrypto secrets (`exportable: false`) for P101 URL, P201 URL, and optional custom auth header value
 *  - Single-evaluation strict egress (`purpose: "webhook"`, `https:` only, `requireAllowlistRule: true`,
 *    `publicAddressesOnly: true`, pinned DNS lookup, redirect refusal) with zero URL leakage in dry-run results
 *  - Canonical lock order (`orders` -> `identity`) and fail-closed in-transaction actor re-validation
 *    (`orders.production.trigger` for preview/send/history; `admin` + fresh post-lock step-up for `resend`;
 *    `integrations.manage` + fresh post-lock step-up for settings)
 *  - Order-locked outbox enqueue (`integration_production_dispatches` + `jobs.enqueue` in one transaction)
 *    pinned to `expectedOwnerUserId` and a keyed `destinationFingerprint` (`DESTINATION_CHANGED` cancels on drift)
 *  - Worker pre-send revalidation of order existence, lock/legal-hold state, cancellation, owner identity/status,
 *    packet scope, and destination fingerprint before opening any network socket
 *  - P201 hard gate: requires operator confirmation (`phase1ArtifactsConfirmed === true`) AND a delivered
 *    P101 row on the same order, copying `{ customer_id, order_id, run_mode }` verbatim from that row
 *  - Encrypted payload body (`payload_enc`) retained only during the bounded retry window and scrubbed (`NULL`)
 *    immediately upon `delivered`, `failed`, `dead`, or bounded stale reconciliation (`PRODUCTION_DELIVERY_INTERRUPTED` / `PRODUCTION_QUEUE_STALLED`)
 *  - Zero remote response body persistence or exposure: `response_summary` holds only fixed server-generated status text
 *  - Controlled server-classified `resendReason` codes and never-secret, never-PII durable audit attributes
 */
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, gte, like, lte, or, type SQL } from "drizzle-orm";
import type { ModuleDeps } from "../../../container.js";
import { DomainError, conflict, forbidden, notFound, validation } from "../../../core/errors.js";
import { ulid } from "../../../core/ids.js";
import { getRequestContext } from "../../../core/requestContext.js";
import type { ClaimedJob, JobResult, SafeAttributeValue, SessionPrincipal, Tx } from "../../../core/types.js";
import type { OrderLockState } from "../../orders/types.js";
import { isSecretConfigured, readSecret, readSetting, writeSetting } from "../../platform/index.js";
import { flagKey } from "../../platform/settingsRegistry.js";
import {
  assertIntegrationsManageInTx,
  assertIntegrationsManagePreflight,
  assertProductionRedeliverInTx,
  assertProductionRedeliverPreflight,
  assertProductionResendInTx,
  assertProductionResendPreflight,
  assertProductionTriggerInTx,
  assertProductionTriggerPreflight,
} from "../authz.js";
import type { EgressPolicy } from "../egress.js";
import type { ProviderChecksStore } from "../providerChecks.js";
import { integrationProductionDispatches } from "../schema.js";
import {
  hasNoHeaderInjection,
  INTEGRATIONS_PRODUCTION_AUTH_VALUE,
  INTEGRATIONS_PRODUCTION_CONFIG,
  INTEGRATIONS_PRODUCTION_FLAG,
  INTEGRATIONS_PRODUCTION_P101_URL,
  INTEGRATIONS_PRODUCTION_P201_URL,
  INTEGRATIONS_PRODUCTION_P301_URL,
  INTEGRATIONS_PRODUCTION_P401_URL,
  INTEGRATIONS_PRODUCTION_SIGNING_PREV_SECRET,
  INTEGRATIONS_PRODUCTION_SIGNING_SECRET,
  INTEGRATIONS_PRODUCTION_WORKFLOW_AUTO_QUEUE,
  isValidProductionAuthHeaderName,
  isValidProductionWebhookUrl,
  readIntegrationFlag,
} from "../settings.js";
import type { ProviderState } from "../smtp.js";
import { generateWebhookSigningSecret, signWebhookPayload } from "../webhooks/crypto.js";
import type { StageWebhookTriggerSource } from "../workflowWebhooks/types.js";
import {
  buildLaterPhaseFromDeliveredP101,
  buildP101Payload,
  buildP201FromDeliveredP101,
  CANON_VERSION_PATTERN,
  maskP101PayloadForRole,
  maskSecretWebhookUrl,
  RUN_MODE_PATTERN,
  validateLaterPhasePayload,
  validateP101,
  type P101Payload,
  type P201Payload,
  type PayloadValidationIssue,
} from "./payload.js";

export const PRODUCTION_DELIVERY_JOB = "integrations.production.deliver" as const;
export const PRODUCTION_RECONCILE_JOB = "integrations.production.reconcile" as const;
export const PRODUCTION_MAX_ATTEMPTS = 5 as const;
/** Extra grace beyond `timeoutMs` before an interrupted `sending` row is eligible for job-fenced reconciliation. */
export const PRODUCTION_SENDING_GRACE_MS = 30_000 as const;
/** Minimum age (15 minutes) before a non-expired `queued` row is checked for orphaned job-ledger state. */
export const PRODUCTION_STALE_QUEUED_MS = 900_000 as const;
/** Bounded maximum outbox TTL (24 hours) after which a queued dispatch cancels its job under fence and scrubs `payload_enc`. */
export const PRODUCTION_DISPATCH_MAX_TTL_MS = 86_400_000 as const;

const RECONCILE_BATCH_SIZE = 100;
const MAX_RECONCILE_BATCHES = 10;

export const PRODUCTION_SETTINGS_HREF = "/admin/integrations/production" as const;
export const PRODUCTION_PHASES = ["P101", "P201", "P301", "P401"] as const;
export type ProductionPhase = (typeof PRODUCTION_PHASES)[number];
export type ProductionDispatchState =
  | "queued"
  | "sending"
  | "delivered"
  | "failed"
  | "dead"
  | "unknown"
  | "stopped";
export type ProductionValidationIssue = PayloadValidationIssue;
export type ControlledResendReason =
  | "OPERATOR_RETRY_AFTER_INTERRUPTION"
  | "OPERATOR_RETRY_AFTER_DEAD_LETTER"
  | "OPERATOR_RETRY_AFTER_FAILURE"
  | "OPERATOR_RETRY_AFTER_STOP"
  | "OPERATOR_REPLAY_DELIVERED";

export type ProductionDisabledReasonCategory =
  | "pipeline_off"
  | "endpoint_missing"
  | "config_incomplete"
  | "in_progress"
  | "already_delivered"
  | "retry_or_resend_required"
  | "precondition";

export interface ProductionDisabledReason {
  code: string;
  category: ProductionDisabledReasonCategory;
  message: string;
  /** True when an administrator can resolve this reason in `/admin/integrations/production`. */
  settingsActionable: boolean;
}

export interface ProductionLaterPhasePreview {
  configured: boolean;
  eligible: boolean;
  p101Delivered: boolean;
  prerequisiteDelivered: boolean;
  alreadyDelivered: boolean;
  activeState: ProductionDispatchState | null;
  validationErrors: ProductionValidationIssue[];
  disabledReasons: ProductionDisabledReason[];
  payload: P201Payload | null;
}

export interface MaskedWebhookUrlView {
  host: string;
  last4: string;
}

export interface ProductionSettingsView {
  enabled: boolean;
  configured: boolean;
  state: ProviderState;
  summary: string;
  p101UrlConfigured: boolean;
  p101UrlMask: MaskedWebhookUrlView | null;
  p201UrlConfigured: boolean;
  p201UrlMask: MaskedWebhookUrlView | null;
  p301UrlConfigured: boolean;
  p301UrlMask: MaskedWebhookUrlView | null;
  p401UrlConfigured: boolean;
  p401UrlMask: MaskedWebhookUrlView | null;
  authHeaderName: string;
  authHeaderValueConfigured: boolean;
  signingEnabled: boolean;
  signingSecretConfigured: boolean;
  signingSecretLast4: string | null;
  previousSigningSecretActive: boolean;
  canonVersion: string;
  runMode: string;
  timeoutMs: number;
}

export interface WorkflowAutoQueueItemView {
  workflowPublicId: string;
  workflowKey: string;
  workflowName: string;
  isDefault: boolean;
  p101OnPaymentConfirmed: boolean;
  p201OnPhase1Locked: boolean;
  updatedAt: Date | null;
}

export interface UpdateProductionSettingsInput {
  enabled: boolean;
  /** Omit/`undefined` to keep existing secret, `null` to clear, HTTPS URL string to replace. */
  p101Url?: string | null;
  /** Omit/`undefined` to keep existing secret, `null` to clear, HTTPS URL string to replace. */
  p201Url?: string | null;
  /** Optional Phase III (`P301`) HTTPS URL: omit/`undefined` to keep existing secret, `null` to clear, HTTPS URL string to replace. */
  p301Url?: string | null;
  /** Optional Phase IV (`P401`) HTTPS URL: omit/`undefined` to keep existing secret, `null` to clear, HTTPS URL string to replace. */
  p401Url?: string | null;
  authHeaderName?: string;
  /** Omit/`undefined` to keep existing secret, `null` to clear, string to replace. */
  authHeaderValue?: string | null;
  canonVersion: string;
  runMode?: string;
  timeoutMs?: number;
}

export interface ProductionDryRunResult {
  phase: ProductionPhase;
  allowed: boolean;
  reasonCode: string;
  safeMessage: string;
  host: string | null;
  resolvedAddresses: string[];
  matchedAllowlistRulePublicId: string | null;
  checkedAt: Date;
}

export interface ProductionOrderPreview {
  featureEnabled: boolean;
  featureConfigured: boolean;
  settingsHref: string;
  p101: {
    configured: boolean;
    eligible: boolean;
    alreadyDelivered: boolean;
    activeState: ProductionDispatchState | null;
    validationErrors: ProductionValidationIssue[];
    disabledReasons: ProductionDisabledReason[];
    payload: P101Payload | null;
    maskedForViewer: boolean;
  };
  p201: {
    configured: boolean;
    eligible: boolean;
    p101Delivered: boolean;
    alreadyDelivered: boolean;
    activeState: ProductionDispatchState | null;
    validationErrors: ProductionValidationIssue[];
    disabledReasons: ProductionDisabledReason[];
    payload: P201Payload | null;
  };
  p301: ProductionLaterPhasePreview;
  p401: ProductionLaterPhasePreview;
}

export interface ProductionDispatchItem {
  publicId: string;
  orderPublicId: string;
  orderReference: string;
  phase: ProductionPhase;
  state: ProductionDispatchState;
  attemptCount: number;
  maxAttempts: number;
  idempotencyKey: string;
  payloadSha256: string;
  identityTriple: {
    customerId: string;
    orderId: string;
    runMode: string;
  };
  packet: string | null;
  tier: string | null;
  bundleScopeManifest: string | null;
  releaseStatus: string | null;
  httpStatus: number | null;
  /** Fixed server-generated summary ONLY — never reflects remote receiver body text. */
  responseSummary: string | null;
  lastReasonCode: string | null;
  /** Controlled server-classified code ONLY — never reflects raw operator prose. */
  resendReason: string | null;
  /** Public ULID of the failed/dead/stopped dispatch this attempt retried, or `null`. */
  retryOf: string | null;
  /** Public ULID of the already-delivered dispatch this attempt re-delivered, or `null`. */
  redeliveryOf: string | null;
  triggerSource: string;
  stageKey: string | null;
  stoppedAt: Date | null;
  stoppedByPublicId: string | null;
  stopReason: string | null;
  requestedByPublicId: string | null;
  correlationId: string;
  createdAt: Date;
  updatedAt: Date;
  deliveredAt: Date | null;
  finalizedAt: Date | null;
}

export interface RequestP101Input {
  orderPublicId: string;
  releaseStatus?: string;
}

export interface RequestP201Input {
  orderPublicId: string;
  phase1ArtifactsConfirmed: boolean;
}

export interface RequestLaterPhaseInput {
  orderPublicId: string;
}

export interface RetryProductionDispatchInput {
  orderPublicId: string;
  dispatchPublicId: string;
}

export interface StopProductionDispatchInput {
  orderPublicId: string;
  dispatchPublicId: string;
  reason?: string | null;
}

export interface EnqueueWorkflowProductionDispatchInput {
  phase: ProductionPhase;
  orderPublicId: string;
  stageKey: string | null;
  triggerSource: StageWebhookTriggerSource;
  idempotencyKey: string;
  correlationId?: string;
  actor: SessionPrincipal | null;
  releaseStatus?: string | null;
  bypassPaymentStageCheck?: boolean;
}

export interface EnqueueWorkflowProductionDispatchResult {
  outcome: "queued" | "already_queued_or_delivered" | "refused_precondition" | "disabled";
  dispatchPublicId: string | null;
  reasonCode: string | null;
  message: string | null;
}

export interface RedeliverProductionDispatchInput {
  orderPublicId: string;
  dispatchPublicId: string;
  reason: string;
  confirmation: string;
  idempotencyKey: string;
}

export interface ResendProductionInput {
  orderPublicId: string;
  phase: ProductionPhase;
  reason: string;
  releaseStatus?: string;
  phase1ArtifactsConfirmed?: boolean;
}

export interface ListProductionDispatchesInput {
  phase?: ProductionPhase;
  state?: ProductionDispatchState;
  orderReference?: string;
  fromDate?: Date;
  toDate?: Date;
  limit?: number;
}

export interface ProductionWebhookService {
  getSettings(): Promise<ProductionSettingsView>;
  updateSettings(principal: SessionPrincipal, input: UpdateProductionSettingsInput): Promise<ProductionSettingsView>;
  rotateSigningSecret(
    principal: SessionPrincipal,
    input?: { overlapMinutes?: number },
  ): Promise<{ settings: ProductionSettingsView; signingSecretOnce: string }>;
  setSigningEnabled(principal: SessionPrincipal, input: { enabled: boolean }): Promise<ProductionSettingsView>;
  listWorkflowAutoQueue(principal: SessionPrincipal): Promise<{ items: WorkflowAutoQueueItemView[] }>;
  setWorkflowAutoQueue(
    principal: SessionPrincipal,
    input: {
      workflowPublicId?: string;
      workflowKey?: string;
      p101OnPaymentConfirmed: boolean;
      p201OnPhase1Locked: boolean;
    },
  ): Promise<{ items: WorkflowAutoQueueItemView[] }>;
  getWorkflowAutoQueueForOrderInTx(
    orderPublicId: string,
    tx: Tx,
  ): Promise<{
    workflowPublicId: string | null;
    p101OnPaymentConfirmed: boolean;
    p201OnPhase1Locked: boolean;
    intakeStageKey: string | null;
  }>;
  enqueueWorkflowDispatch(
    input: EnqueueWorkflowProductionDispatchInput,
    tx: Tx,
  ): Promise<EnqueueWorkflowProductionDispatchResult>;
  getTargetStatus(
    phase: ProductionPhase,
    tx?: Tx,
  ): Promise<{ enabled: boolean; configured: boolean; endpointConfigured: boolean }>;
  testDestination(principal: SessionPrincipal, input: { phase: ProductionPhase }): Promise<ProductionDryRunResult>;
  previewOrder(
    principal: SessionPrincipal,
    input: { orderPublicId: string; releaseStatus?: string },
  ): Promise<ProductionOrderPreview>;
  requestP101(principal: SessionPrincipal, input: RequestP101Input): Promise<ProductionDispatchItem>;
  requestP201(principal: SessionPrincipal, input: RequestP201Input): Promise<ProductionDispatchItem>;
  requestP301(principal: SessionPrincipal, input: RequestLaterPhaseInput): Promise<ProductionDispatchItem>;
  requestP401(principal: SessionPrincipal, input: RequestLaterPhaseInput): Promise<ProductionDispatchItem>;
  stop(principal: SessionPrincipal, input: StopProductionDispatchInput): Promise<ProductionDispatchItem>;
  retry(principal: SessionPrincipal, input: RetryProductionDispatchInput): Promise<ProductionDispatchItem>;
  redeliver(principal: SessionPrincipal, input: RedeliverProductionDispatchInput): Promise<ProductionDispatchItem>;
  resend(principal: SessionPrincipal, input: ResendProductionInput): Promise<ProductionDispatchItem>;
  orderHistory(principal: SessionPrincipal, input: { orderPublicId: string }): Promise<{ items: ProductionDispatchItem[] }>;
  listDispatches(
    principal: SessionPrincipal,
    input?: ListProductionDispatchesInput,
  ): Promise<{ items: ProductionDispatchItem[] }>;
}

function dispatchPayloadAad(dispatchPublicId: string): string {
  return `integration_production_dispatches.payload:${dispatchPublicId}`;
}

function destinationFingerprintPurpose(phase: ProductionPhase): string {
  return `integration_production_dispatches.destination_v1:${phase.toLowerCase()}`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Orders in `none` or staff `review` may trigger production runs; `finalized`, `imported_read_only`,
 * and `legal_hold` lock the order against production dispatches.
 */
function isOrderLockedForProduction(lockState: OrderLockState): boolean {
  return lockState !== "none" && lockState !== "review";
}

function isOrderCanceledStatus(statusKey: string): boolean {
  const normalized = statusKey.trim().toLowerCase();
  return normalized === "canceled" || normalized === "cancelled";
}

/**
 * Fixed server-generated status summary mapped strictly from controlled reason codes and HTTP status.
 * NEVER reads, truncates, or echoes remote receiver response bodies or untrusted exception text (PW-01).
 */
export function fixedDispatchSummary(
  reasonCode: string,
  httpStatus: number | null,
  state: ProductionDispatchState,
): string {
  switch (reasonCode) {
    case "PRODUCTION_DELIVERED":
      return `HTTP ${httpStatus ?? 200} — Accepted by production pipeline.`;
    case "PRODUCTION_HTTP_429":
      return state === "dead"
        ? "HTTP 429 — Rate limited by production pipeline; retry budget exhausted."
        : "HTTP 429 — Rate limited by production pipeline; retry scheduled.";
    case "PRODUCTION_HTTP_5XX":
      return state === "dead"
        ? `HTTP ${httpStatus ?? 500} — Downstream server error; retry budget exhausted.`
        : `HTTP ${httpStatus ?? 500} — Downstream server error; retry scheduled.`;
    case "PRODUCTION_HTTP_4XX":
      return `HTTP ${httpStatus ?? 400} — Rejected by production pipeline (client error; not retried).`;
    case "EGRESS_REDIRECT_REFUSED":
      return `HTTP ${httpStatus ?? 302} — Outbound redirect refused by egress policy.`;
    case "DESTINATION_CHANGED":
      return "Canceled before delivery because destination or authentication settings changed.";
    case "PRODUCTION_DELIVERY_INTERRUPTED":
    case "PRODUCTION_AMBIGUOUS_IN_FLIGHT":
    case "PRODUCTION_PRIOR_ATTEMPT_UNCERTAIN":
      return "Delivery outcome is unknown after an interrupted or expired attempt; verify downstream state before re-sending.";
    case "PRODUCTION_QUEUE_STALLED":
      return "Queued dispatch was orphaned before worker pickup; payload cleared.";
    case "PRODUCTION_DELIVERY_EXPIRED":
      return "Queued dispatch expired before delivery; payload cleared.";
    case "ORDER_LOCKED":
      return "Canceled before delivery because the order is locked or under legal hold.";
    case "ORDER_CANCELED":
      return "Canceled before delivery because the order was canceled.";
    case "ORDER_OWNER_CHANGED":
      return "Canceled before delivery because order ownership changed.";
    case "ORDER_OWNER_INACTIVE":
      return "Canceled before delivery because the order owner account is no longer active.";
    case "ORDER_NOT_FOUND":
      return "Canceled before delivery because the order no longer exists.";
    case "ORDER_SCOPE_CHANGED":
      return "Canceled before delivery because the order packet scope changed.";
    case "PAYMENT_NOT_CONFIRMED":
      return "Canceled before delivery because order payment is not confirmed.";
    case "PHASE1_INTAKE_NOT_LOCKED":
      return "Canceled before delivery because the intake phase is not submitted and locked.";
    case "STOPPED_BY_OPERATOR":
      return "Stopped before delivery by an operator; payload cleared.";
    case "PRODUCTION_NOT_CONFIGURED":
      return "Canceled before delivery because production webhooks are disabled or incomplete.";
    case "PRODUCTION_PAYLOAD_MISSING":
    case "PRODUCTION_PAYLOAD_DECRYPT_FAILED":
    case "PRODUCTION_PAYLOAD_HASH_MISMATCH":
    case "PRODUCTION_PAYLOAD_INVALID":
      return "Canceled before delivery because stored payload integrity verification failed.";
    default: {
      const safeCode = /^[A-Z0-9_]{2,64}$/.test(reasonCode) ? reasonCode : "PRODUCTION_DELIVERY_FAILED";
      if (state === "unknown") {
        return `Delivery outcome is unknown (${safeCode}); verify downstream state before re-sending.`;
      }
      if (state === "dead") {
        return `Outbound transport or policy check failed (${safeCode}); retry budget exhausted.`;
      }
      if (state === "queued") {
        return `Outbound transport error (${safeCode}); retry scheduled.`;
      }
      return `Outbound delivery refused by policy or transport (${safeCode}).`;
    }
  }
}

function classifyResendReasonCode(
  latestPhaseRow: Pick<DispatchRow, "state" | "lastReasonCode">,
): ControlledResendReason {
  if (
    latestPhaseRow.state === "unknown" ||
    latestPhaseRow.lastReasonCode === "PRODUCTION_DELIVERY_INTERRUPTED" ||
    latestPhaseRow.lastReasonCode === "PRODUCTION_AMBIGUOUS_IN_FLIGHT" ||
    latestPhaseRow.lastReasonCode === "PRODUCTION_PRIOR_ATTEMPT_UNCERTAIN" ||
    latestPhaseRow.lastReasonCode === "PRODUCTION_QUEUE_STALLED" ||
    latestPhaseRow.lastReasonCode === "PRODUCTION_DELIVERY_EXPIRED"
  ) {
    return "OPERATOR_RETRY_AFTER_INTERRUPTION";
  }
  if (latestPhaseRow.state === "dead") {
    return "OPERATOR_RETRY_AFTER_DEAD_LETTER";
  }
  if (latestPhaseRow.state === "stopped") {
    return "OPERATOR_RETRY_AFTER_STOP";
  }
  if (latestPhaseRow.state === "delivered") {
    return "OPERATOR_REPLAY_DELIVERED";
  }
  return "OPERATOR_RETRY_AFTER_FAILURE";
}

function escapeLikePrefix(raw: string): string {
  return raw.replace(/[\\%_]/g, (m) => `\\${m}`);
}

type DispatchRow = typeof integrationProductionDispatches.$inferSelect;

class CandidateMovedRollback extends Error {
  constructor() {
    super("CANDIDATE_MOVED_ROLLBACK");
  }
}

const RETRY_STORAGE_SUFFIX_RE = /:r:[0-9A-HJKMNP-TV-Z]{26}$/;

function toWireIdempotencyKey(storedKey: string): string {
  return storedKey.replace(RETRY_STORAGE_SUFFIX_RE, "");
}

function resolveRetryRootRow(targetRow: DispatchRow, existingRows: readonly DispatchRow[]): DispatchRow {
  const byPublicId = new Map(existingRows.map((r) => [r.publicId, r]));
  const visited = new Set<string>();
  let current: DispatchRow = targetRow;
  while (current.retryOfPublicId && !visited.has(current.publicId)) {
    visited.add(current.publicId);
    const parent = byPublicId.get(current.retryOfPublicId);
    if (!parent) {
      break;
    }
    current = parent;
  }
  return current;
}

function resolveRetryRootWireKey(targetRow: DispatchRow, existingRows: readonly DispatchRow[]): string {
  return toWireIdempotencyKey(resolveRetryRootRow(targetRow, existingRows).idempotencyKey);
}

function toDispatchItem(row: DispatchRow): ProductionDispatchItem {
  return {
    publicId: row.publicId,
    orderPublicId: row.orderPublicId,
    orderReference: row.orderReference,
    phase: row.phase as ProductionPhase,
    state: row.state as ProductionDispatchState,
    attemptCount: row.attemptCount,
    maxAttempts: PRODUCTION_MAX_ATTEMPTS,
    idempotencyKey: toWireIdempotencyKey(row.idempotencyKey),
    payloadSha256: row.payloadSha256,
    identityTriple: {
      customerId: row.sentCustomerId,
      orderId: row.sentOrderId,
      runMode: row.sentRunMode,
    },
    packet: row.packet ?? null,
    tier: row.tier ?? null,
    bundleScopeManifest: row.bundleScopeManifest ?? null,
    releaseStatus: row.releaseStatus ?? null,
    httpStatus: row.httpStatus ?? null,
    responseSummary: row.responseSummary ?? null,
    lastReasonCode: row.lastReasonCode ?? null,
    resendReason: row.resendReason ?? null,
    retryOf: row.retryOfPublicId ?? null,
    redeliveryOf: row.redeliveryOfPublicId ?? null,
    triggerSource: row.triggerSource ?? "operator",
    stageKey: row.stageKey ?? null,
    stoppedAt: row.stoppedAt ?? null,
    stoppedByPublicId: row.stoppedByPublicId ?? null,
    stopReason: row.stopReason ?? null,
    requestedByPublicId: row.requestedByPublicId ?? null,
    correlationId: row.correlationId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deliveredAt: row.deliveredAt ?? null,
    finalizedAt: row.finalizedAt ?? null,
  };
}

function buildSafeDispatchAuditAttributes(
  row: Pick<
    DispatchRow,
    | "phase"
    | "orderPublicId"
    | "packet"
    | "tier"
    | "bundleScopeManifest"
    | "httpStatus"
    | "attemptCount"
    | "idempotencyKey"
    | "retryOfPublicId"
    | "redeliveryOfPublicId"
  >,
  extra?: Record<string, string | number | boolean | null>,
): Record<string, SafeAttributeValue> {
  return {
    phase: row.phase,
    order_public_id: row.orderPublicId,
    packet: row.packet ?? null,
    tier: row.tier ?? null,
    bundle_scope_manifest: row.bundleScopeManifest ?? null,
    http_status: row.httpStatus ?? null,
    attempt_count: row.attemptCount,
    idempotency_key: toWireIdempotencyKey(row.idempotencyKey),
    retry_of_public_id: row.retryOfPublicId ?? null,
    redelivery_of_public_id: row.redeliveryOfPublicId ?? null,
    ...extra,
  };
}

function phaseDisplayLabel(phase: ProductionPhase): string {
  switch (phase) {
    case "P101":
      return "Phase I";
    case "P201":
      return "Phase II";
    case "P301":
      return "Phase III";
    case "P401":
      return "Phase IV";
  }
}

const JOB_AUDIT_ACTOR = { userId: null, role: "system" as const };

export function createProductionWebhookService(
  deps: ModuleDeps,
  egress: EgressPolicy,
  checks: ProviderChecksStore,
): ProductionWebhookService {
  function requireOrders() {
    const orders = deps.services.orders;
    if (!orders) {
      throw new DomainError("UNAVAILABLE", "ORDERS_SERVICE_UNAVAILABLE", "Orders service is not initialized.");
    }
    return orders;
  }

  function requireIdentity() {
    const identity = deps.services.identity;
    if (!identity) {
      throw new DomainError("UNAVAILABLE", "IDENTITY_SERVICE_UNAVAILABLE", "Identity service is not initialized.");
    }
    return identity;
  }

  function requireJobAdmin() {
    const jobAdmin = deps.services.jobAdmin;
    if (!jobAdmin) {
      throw new DomainError(
        "UNAVAILABLE",
        "JOB_ADMIN_SERVICE_UNAVAILABLE",
        "Background job administration service is not initialized.",
      );
    }
    return jobAdmin;
  }

  function computeDestinationFingerprint(
    phase: ProductionPhase,
    params: {
      targetUrl: string;
      authHeaderName: string;
      authHeaderValue: string | null;
      canonVersion: string;
      runMode: string;
      signingEnabled?: boolean;
      signingSecret?: string | null;
    },
  ): string {
    const normalizedHeaderName = params.authHeaderName.trim().toLowerCase();
    const effectiveHeaderValue = normalizedHeaderName !== "" ? (params.authHeaderValue ?? "") : "";
    const baseTuple =
      phase === "P101"
        ? [
            phase,
            params.targetUrl.trim(),
            normalizedHeaderName,
            effectiveHeaderValue,
            params.canonVersion.trim(),
            params.runMode.trim(),
          ]
        : [phase, params.targetUrl.trim(), normalizedHeaderName, effectiveHeaderValue];
    const tuple =
      params.signingEnabled === true
        ? [...baseTuple, "sig:v1", params.signingSecret ?? ""]
        : baseTuple;
    return deps.crypto.blindIndex(JSON.stringify(tuple), destinationFingerprintPurpose(phase));
  }

  async function emitProdOpsAlert(input: {
    orderPublicId: string;
    phase: ProductionPhase;
    severity: "warning" | "error" | "critical";
    code: string;
    title: string;
    text?: string;
    correlationId?: string;
  }) {
    try {
      await deps.services.opsAlerts?.emit({
        source: "webhook",
        severity: input.severity,
        dedupKey: `prod:${input.orderPublicId}:${input.phase}`,
        code: input.code,
        title: input.title,
        text: input.text,
        orderPublicId: input.orderPublicId,
        correlationId: input.correlationId,
      });
    } catch {
      // Never fail production dispatch handling on best-effort ops alert persistence.
    }
  }

  async function resolveProdOpsAlert(orderPublicId: string, phase: ProductionPhase, correlationId?: string) {
    try {
      await deps.services.opsAlerts?.resolve({
        source: "webhook",
        dedupKey: `prod:${orderPublicId}:${phase}`,
        correlationId,
      });
    } catch {
      // Never fail production dispatch handling on best-effort ops alert resolution.
    }
  }

  async function evaluateFormat3StagePreconditionsInTx(
    tx: Tx,
    orderPublicId: string,
    options?: { bypassPaymentStageCheck?: boolean },
  ): Promise<{
    isFormat3: boolean;
    paymentConfirmed: boolean;
    intakeLocked: boolean;
    intakeStageKey: string | null;
    workflowVersionId: number | null;
  }> {
    const orders = requireOrders();
    if (!orders.stages?.contextForRun) {
      return {
        isFormat3: false,
        paymentConfirmed: true,
        intakeLocked: true,
        intakeStageKey: null,
        workflowVersionId: null,
      };
    }
    const ctx = await orders.stages.contextForRun(orderPublicId, tx);
    if (!ctx.stages || ctx.stages.length === 0) {
      return {
        isFormat3: false,
        paymentConfirmed: true,
        intakeLocked: true,
        intakeStageKey: null,
        workflowVersionId: ctx.workflowVersionId,
      };
    }

    const payIdx = ctx.stages.findIndex((s) => s.completesOn === "payment");
    const currentIdx = ctx.currentStageKey
      ? ctx.stages.findIndex((s) => s.key === ctx.currentStageKey)
      : -1;
    const paymentConfirmed =
      options?.bypassPaymentStageCheck === true ||
      payIdx < 0 ||
      (currentIdx >= 0 && currentIdx > payIdx);

    const intakeStage =
      ctx.stages.find((s) => s.key === "phase_1_intake") ??
      ctx.stages.find((s) => s.progression === "submit_lock") ??
      null;
    let intakeLocked = true;
    if (intakeStage && intakeStage.statusKeys[0] && orders.isStatusPhaseLocked) {
      intakeLocked = await orders.isStatusPhaseLocked(
        ctx.orderId,
        ctx.workflowVersionId,
        intakeStage.statusKeys[0],
        tx,
      );
    }

    return {
      isFormat3: true,
      paymentConfirmed,
      intakeLocked,
      intakeStageKey: intakeStage?.key ?? null,
      workflowVersionId: ctx.workflowVersionId,
    };
  }

  async function readProductionState(tx?: Tx) {
    const [
      enabled,
      cfg,
      p101Secret,
      p201Secret,
      p301Secret,
      p401Secret,
      authValueConfigured,
      signingSecret,
      signingPrevSecret,
    ] = await Promise.all([
      readIntegrationFlag(deps.settings, INTEGRATIONS_PRODUCTION_FLAG, tx),
      readSetting(deps.settings, INTEGRATIONS_PRODUCTION_CONFIG, tx),
      readSecret(deps.settings, INTEGRATIONS_PRODUCTION_P101_URL, tx),
      readSecret(deps.settings, INTEGRATIONS_PRODUCTION_P201_URL, tx),
      readSecret(deps.settings, INTEGRATIONS_PRODUCTION_P301_URL, tx),
      readSecret(deps.settings, INTEGRATIONS_PRODUCTION_P401_URL, tx),
      isSecretConfigured(deps.settings, INTEGRATIONS_PRODUCTION_AUTH_VALUE, tx),
      readSecret(deps.settings, INTEGRATIONS_PRODUCTION_SIGNING_SECRET, tx),
      readSecret(deps.settings, INTEGRATIONS_PRODUCTION_SIGNING_PREV_SECRET, tx),
    ]);

    const p101UrlConfigured = Boolean(p101Secret && isValidProductionWebhookUrl(p101Secret));
    const p201UrlConfigured = Boolean(p201Secret && isValidProductionWebhookUrl(p201Secret));
    const p301UrlConfigured = Boolean(p301Secret && isValidProductionWebhookUrl(p301Secret));
    const p401UrlConfigured = Boolean(p401Secret && isValidProductionWebhookUrl(p401Secret));
    const authHeaderValid = isValidProductionAuthHeaderName(cfg.authHeaderName);
    const authConsistent = authHeaderValid && (cfg.authHeaderName === "" || authValueConfigured);
    const signingSecretConfigured = Boolean(signingSecret && signingSecret.length >= 16);
    const signingConsistent = !cfg.signingEnabled || signingSecretConfigured;
    const nowMs = deps.clock.now().getTime();
    const prevExpiryMs = cfg.previousSigningSecretExpiresAt
      ? Date.parse(cfg.previousSigningSecretExpiresAt)
      : Number.NaN;
    const previousSigningSecretActive =
      Boolean(signingPrevSecret) && Number.isFinite(prevExpiryMs) && nowMs < prevExpiryMs;
    const canonTrimmed = cfg.canonVersion.trim();
    const canonValid =
      canonTrimmed.length > 0 && CANON_VERSION_PATTERN.test(canonTrimmed) && hasNoHeaderInjection(canonTrimmed);
    const runModeValid = RUN_MODE_PATTERN.test(cfg.runMode.trim());
    const configured =
      p101UrlConfigured &&
      p201UrlConfigured &&
      canonValid &&
      runModeValid &&
      authConsistent &&
      signingConsistent;

    return {
      enabled,
      cfg,
      p101Secret,
      p201Secret,
      p301Secret,
      p401Secret,
      signingSecret,
      overlapSigningSecret: previousSigningSecretActive ? signingPrevSecret : null,
      signingSecretConfigured,
      previousSigningSecretActive,
      p101UrlConfigured,
      p201UrlConfigured,
      p301UrlConfigured,
      p401UrlConfigured,
      authHeaderValid,
      authConsistent,
      signingConsistent,
      canonValid,
      runModeValid,
      authValueConfigured,
      configured,
    };
  }

  function targetSecretForPhase(
    prodState: Awaited<ReturnType<typeof readProductionState>>,
    phase: ProductionPhase,
  ): string | null {
    switch (phase) {
      case "P101":
        return prodState.p101Secret;
      case "P201":
        return prodState.p201Secret;
      case "P301":
        return prodState.p301Secret;
      case "P401":
        return prodState.p401Secret;
    }
  }

  function phaseUrlConfigured(
    prodState: Awaited<ReturnType<typeof readProductionState>>,
    phase: ProductionPhase,
  ): boolean {
    switch (phase) {
      case "P101":
        return prodState.p101UrlConfigured;
      case "P201":
        return prodState.p201UrlConfigured;
      case "P301":
        return prodState.p301UrlConfigured;
      case "P401":
        return prodState.p401UrlConfigured;
    }
  }

  function secretDefForPhase(phase: ProductionPhase) {
    switch (phase) {
      case "P101":
        return INTEGRATIONS_PRODUCTION_P101_URL;
      case "P201":
        return INTEGRATIONS_PRODUCTION_P201_URL;
      case "P301":
        return INTEGRATIONS_PRODUCTION_P301_URL;
      case "P401":
        return INTEGRATIONS_PRODUCTION_P401_URL;
    }
  }

  type ReconcileCandidate = Pick<
    DispatchRow,
    "id" | "publicId" | "state" | "version" | "jobPublicId" | "updatedAt" | "expiresAt" | "correlationId"
  >;

  async function reconcileSingleCandidate(
    candidate: ReconcileCandidate,
    correlationIdOverride?: string,
    allowRetryOnMove = true,
  ): Promise<boolean> {
    const jobAdmin = requireJobAdmin();
    try {
      const reconciledAlert = await deps.db.transaction(async (tx) => {
        const txNow = deps.clock.now();
        const shouldCancelQueued =
          candidate.state === "queued" && candidate.expiresAt.getTime() <= txNow.getTime();

        // PW-02: Lock `job_runs` FIRST via published JobsModule port before locking dispatch row.
        const disposition = await jobAdmin.reconcileOutboxJob(candidate.jobPublicId, tx, {
          cancelQueued: shouldCancelQueued,
        });
        if (disposition.state === "running_live" || disposition.state === "queued_live") {
          return null;
        }

        const [locked] = await tx
          .select()
          .from(integrationProductionDispatches)
          .where(eq(integrationProductionDispatches.id, candidate.id))
          .for("update")
          .limit(1);

        if (
          !locked ||
          locked.state !== candidate.state ||
          locked.version !== candidate.version ||
          locked.jobPublicId !== candidate.jobPublicId ||
          (shouldCancelQueued && locked.expiresAt.getTime() > txNow.getTime())
        ) {
          throw new CandidateMovedRollback();
        }

        const uncertain =
          locked.state === "sending" ||
          locked.attemptCount > 0 ||
          disposition.state === "settled_unknown" ||
          (disposition.state === "terminal" && disposition.jobState === "unknown");
        const nextState: ProductionDispatchState = uncertain ? "unknown" : "failed";
        const reasonCode =
          locked.state === "sending"
            ? "PRODUCTION_DELIVERY_INTERRUPTED"
            : uncertain
              ? "PRODUCTION_PRIOR_ATTEMPT_UNCERTAIN"
              : shouldCancelQueued
                ? "PRODUCTION_DELIVERY_EXPIRED"
                : "PRODUCTION_QUEUE_STALLED";
        const summary = fixedDispatchSummary(reasonCode, locked.httpStatus, nextState);

        await tx
          .update(integrationProductionDispatches)
          .set({
            state: nextState,
            payloadEnc: null,
            activeFencingToken: 0,
            lastReasonCode: reasonCode,
            responseSummary: summary,
            finalizedAt: txNow,
            updatedAt: txNow,
            version: locked.version + 1,
          })
          .where(
            and(
              eq(integrationProductionDispatches.id, locked.id),
              eq(integrationProductionDispatches.version, locked.version),
            ),
          );

        await deps.audit.record(
          {
            category: "integration",
            eventName: "integration.production.dispatch.failed",
            action: "reconcile",
            outcome: uncertain ? "unknown" : "failed",
            severity: "WARN",
            provider: "production_webhook",
            reasonCode,
            correlationId: correlationIdOverride ?? locked.correlationId,
            actor: JOB_AUDIT_ACTOR,
            orderPublicId: locked.orderPublicId,
            resource: { type: "integration_production_dispatch", publicId: locked.publicId },
            attributes: buildSafeDispatchAuditAttributes(locked, {
              retryable: false,
              reconciled: true,
              delivery_uncertain: uncertain,
            }),
          },
          tx,
        );

        return {
          orderPublicId: locked.orderPublicId,
          orderReference: locked.orderReference,
          phase: locked.phase as ProductionPhase,
          uncertain,
          reasonCode,
          summary,
          correlationId: correlationIdOverride ?? locked.correlationId,
        };
      });
      if (!reconciledAlert) {
        return false;
      }
      await emitProdOpsAlert({
        orderPublicId: reconciledAlert.orderPublicId,
        phase: reconciledAlert.phase,
        severity: reconciledAlert.uncertain
          ? reconciledAlert.phase === "P101" || reconciledAlert.phase === "P201"
            ? "critical"
            : "error"
          : "warning",
        code: reconciledAlert.reasonCode,
        title: reconciledAlert.uncertain
          ? `${reconciledAlert.phase} production webhook outcome uncertain for order ${reconciledAlert.orderReference}`
          : `${reconciledAlert.phase} production webhook stalled for order ${reconciledAlert.orderReference}`,
        text: reconciledAlert.summary,
        correlationId: reconciledAlert.correlationId,
      });
      return true;
    } catch (err) {
      if (err instanceof CandidateMovedRollback) {
        if (!allowRetryOnMove) {
          return false;
        }
        const [fresh] = await deps.db
          .select({
            id: integrationProductionDispatches.id,
            publicId: integrationProductionDispatches.publicId,
            state: integrationProductionDispatches.state,
            version: integrationProductionDispatches.version,
            jobPublicId: integrationProductionDispatches.jobPublicId,
            updatedAt: integrationProductionDispatches.updatedAt,
            expiresAt: integrationProductionDispatches.expiresAt,
            correlationId: integrationProductionDispatches.correlationId,
          })
          .from(integrationProductionDispatches)
          .where(eq(integrationProductionDispatches.id, candidate.id))
          .limit(1);
        if (fresh && (fresh.state === "sending" || fresh.state === "queued")) {
          return reconcileSingleCandidate(fresh, correlationIdOverride, false);
        }
        return false;
      }
      throw err;
    }
  }

  /**
   * Job-fenced outbox reconciliation (PW-02):
   *  - Applies staleness/expiry predicates in SQL BEFORE `LIMIT` with keyset pagination so fresh or healthy
   *    live rows never starve stale or expired rows.
   *  - Verifies job-ledger ownership via `jobAdmin.reconcileOutboxJob` (`job_runs` -> `integration_production_dispatches`).
   *  - Never marks live `queued_live` or `running_live` dispatches failed by age alone.
   */
  async function reconcileStaleDispatches(options: {
    orderPublicId?: string;
    correlationId?: string;
    beforeBatch?: () => Promise<void>;
    verifyCallerBeforeMutate?: () => Promise<void>;
  } = {}): Promise<number> {
    const cfg = await readSetting(deps.settings, INTEGRATIONS_PRODUCTION_CONFIG);
    const now = deps.clock.now();
    const sendingCutoff = new Date(now.getTime() - (cfg.timeoutMs + PRODUCTION_SENDING_GRACE_MS));
    const queuedOrphanCutoff = new Date(now.getTime() - PRODUCTION_STALE_QUEUED_MS);

    let callerVerified = false;
    const ensureCallerVerified = async () => {
      if (callerVerified || !options.verifyCallerBeforeMutate) return;
      await options.verifyCallerBeforeMutate();
      callerVerified = true;
    };

    let reconciledCount = 0;

    // Pass 1: Stale `sending` candidates (`updated_at <= sendingCutoff` evaluated in SQL BEFORE `LIMIT`).
    {
      let cursorTime: Date | null = null;
      let cursorId = 0;
      for (let batch = 0; batch < MAX_RECONCILE_BATCHES; batch += 1) {
        if (options.beforeBatch) await options.beforeBatch();
        const predicates: SQL[] = [
          eq(integrationProductionDispatches.state, "sending"),
          lte(integrationProductionDispatches.updatedAt, sendingCutoff),
        ];
        if (options.orderPublicId !== undefined) {
          predicates.push(eq(integrationProductionDispatches.orderPublicId, options.orderPublicId));
        }
        if (cursorTime !== null) {
          predicates.push(
            or(
              gt(integrationProductionDispatches.updatedAt, cursorTime),
              and(
                eq(integrationProductionDispatches.updatedAt, cursorTime),
                gt(integrationProductionDispatches.id, cursorId),
              ),
            )!,
          );
        }

        const batchRows = await deps.db
          .select({
            id: integrationProductionDispatches.id,
            publicId: integrationProductionDispatches.publicId,
            state: integrationProductionDispatches.state,
            version: integrationProductionDispatches.version,
            jobPublicId: integrationProductionDispatches.jobPublicId,
            updatedAt: integrationProductionDispatches.updatedAt,
            expiresAt: integrationProductionDispatches.expiresAt,
            correlationId: integrationProductionDispatches.correlationId,
          })
          .from(integrationProductionDispatches)
          .where(and(...predicates))
          .orderBy(asc(integrationProductionDispatches.updatedAt), asc(integrationProductionDispatches.id))
          .limit(RECONCILE_BATCH_SIZE);

        if (batchRows.length === 0) break;
        await ensureCallerVerified();
        for (const candidate of batchRows) {
          cursorTime = candidate.updatedAt;
          cursorId = candidate.id;
          if (await reconcileSingleCandidate(candidate, options.correlationId)) {
            reconciledCount += 1;
          }
        }
        if (batchRows.length < RECONCILE_BATCH_SIZE) break;
      }
    }

    // Pass 2: Expired `queued` candidates (`expires_at <= now` evaluated in SQL BEFORE `LIMIT`, fenced cancellation).
    {
      let cursorExpiry: Date | null = null;
      let cursorId = 0;
      for (let batch = 0; batch < MAX_RECONCILE_BATCHES; batch += 1) {
        if (options.beforeBatch) await options.beforeBatch();
        const predicates: SQL[] = [
          eq(integrationProductionDispatches.state, "queued"),
          lte(integrationProductionDispatches.expiresAt, now),
        ];
        if (options.orderPublicId !== undefined) {
          predicates.push(eq(integrationProductionDispatches.orderPublicId, options.orderPublicId));
        }
        if (cursorExpiry !== null) {
          predicates.push(
            or(
              gt(integrationProductionDispatches.expiresAt, cursorExpiry),
              and(
                eq(integrationProductionDispatches.expiresAt, cursorExpiry),
                gt(integrationProductionDispatches.id, cursorId),
              ),
            )!,
          );
        }

        const batchRows = await deps.db
          .select({
            id: integrationProductionDispatches.id,
            publicId: integrationProductionDispatches.publicId,
            state: integrationProductionDispatches.state,
            version: integrationProductionDispatches.version,
            jobPublicId: integrationProductionDispatches.jobPublicId,
            updatedAt: integrationProductionDispatches.updatedAt,
            expiresAt: integrationProductionDispatches.expiresAt,
            correlationId: integrationProductionDispatches.correlationId,
          })
          .from(integrationProductionDispatches)
          .where(and(...predicates))
          .orderBy(asc(integrationProductionDispatches.expiresAt), asc(integrationProductionDispatches.id))
          .limit(RECONCILE_BATCH_SIZE);

        if (batchRows.length === 0) break;
        await ensureCallerVerified();
        for (const candidate of batchRows) {
          cursorExpiry = candidate.expiresAt;
          cursorId = candidate.id;
          if (await reconcileSingleCandidate(candidate, options.correlationId)) {
            reconciledCount += 1;
          }
        }
        if (batchRows.length < RECONCILE_BATCH_SIZE) break;
      }
    }

    // Pass 3: Non-expired aged `queued` candidates (`updated_at <= queuedOrphanCutoff` evaluated in SQL BEFORE `LIMIT`;
    // healthy `queued_live` jobs are left untouched, while orphaned rows whose jobs terminated/vanished are cleaned up).
    {
      let cursorTime: Date | null = null;
      let cursorId = 0;
      for (let batch = 0; batch < MAX_RECONCILE_BATCHES; batch += 1) {
        if (options.beforeBatch) await options.beforeBatch();
        const predicates: SQL[] = [
          eq(integrationProductionDispatches.state, "queued"),
          gt(integrationProductionDispatches.expiresAt, now),
          lte(integrationProductionDispatches.updatedAt, queuedOrphanCutoff),
        ];
        if (options.orderPublicId !== undefined) {
          predicates.push(eq(integrationProductionDispatches.orderPublicId, options.orderPublicId));
        }
        if (cursorTime !== null) {
          predicates.push(
            or(
              gt(integrationProductionDispatches.updatedAt, cursorTime),
              and(
                eq(integrationProductionDispatches.updatedAt, cursorTime),
                gt(integrationProductionDispatches.id, cursorId),
              ),
            )!,
          );
        }

        const batchRows = await deps.db
          .select({
            id: integrationProductionDispatches.id,
            publicId: integrationProductionDispatches.publicId,
            state: integrationProductionDispatches.state,
            version: integrationProductionDispatches.version,
            jobPublicId: integrationProductionDispatches.jobPublicId,
            updatedAt: integrationProductionDispatches.updatedAt,
            expiresAt: integrationProductionDispatches.expiresAt,
            correlationId: integrationProductionDispatches.correlationId,
          })
          .from(integrationProductionDispatches)
          .where(and(...predicates))
          .orderBy(asc(integrationProductionDispatches.updatedAt), asc(integrationProductionDispatches.id))
          .limit(RECONCILE_BATCH_SIZE);

        if (batchRows.length === 0) break;
        await ensureCallerVerified();
        for (const candidate of batchRows) {
          cursorTime = candidate.updatedAt;
          cursorId = candidate.id;
          if (await reconcileSingleCandidate(candidate, options.correlationId)) {
            reconciledCount += 1;
          }
        }
        if (batchRows.length < RECONCILE_BATCH_SIZE) break;
      }
    }

    return reconciledCount;
  }

  async function loadSettingsView(): Promise<ProductionSettingsView> {
    const [stateSnapshot, checkRow] = await Promise.all([readProductionState(), checks.get("production")]);
    const {
      enabled,
      cfg,
      p101Secret,
      p201Secret,
      p301Secret,
      p401Secret,
      p101UrlConfigured,
      p201UrlConfigured,
      p301UrlConfigured,
      p401UrlConfigured,
      authValueConfigured,
      configured,
    } = stateSnapshot;

    let state: ProviderState;
    let summary: string;
    if (!enabled) {
      state = "disabled";
      summary = configured
        ? "Disabled; P101 and P201 production webhook settings are saved."
        : "Disabled; destination URLs and canon version are not configured.";
    } else if (!configured) {
      state = "not_configured";
      summary = "Enabled, but P101 URL, P201 URL, authentication header, or canon version is incomplete.";
    } else if (checkRow?.lastOutcome === "failed") {
      state = "failing";
      summary = `Last destination check or delivery failed (${checkRow.lastReasonCode ?? "PRODUCTION_CHECK_FAILED"}).`;
    } else if (checkRow?.lastOutcome === "succeeded") {
      state = "configured";
      summary = "Configured; destination allowlist and public DNS verified.";
    } else {
      state = "configured";
      summary = "Configured; run a destination dry-run test to verify egress allowlist and public DNS.";
    }

    return {
      enabled,
      configured,
      state,
      summary,
      p101UrlConfigured,
      p101UrlMask: maskSecretWebhookUrl(p101Secret),
      p201UrlConfigured,
      p201UrlMask: maskSecretWebhookUrl(p201Secret),
      p301UrlConfigured,
      p301UrlMask: maskSecretWebhookUrl(p301Secret),
      p401UrlConfigured,
      p401UrlMask: maskSecretWebhookUrl(p401Secret),
      authHeaderName: cfg.authHeaderName,
      authHeaderValueConfigured: authValueConfigured,
      signingEnabled: cfg.signingEnabled,
      signingSecretConfigured: stateSnapshot.signingSecretConfigured,
      signingSecretLast4: cfg.signingSecretLast4,
      previousSigningSecretActive: stateSnapshot.previousSigningSecretActive,
      canonVersion: cfg.canonVersion,
      runMode: cfg.runMode,
      timeoutMs: cfg.timeoutMs,
    };
  }

  async function evaluateP101CandidateInTx(
    tx: Tx,
    orderId: number,
    releaseStatusOverride?: string,
    options?: { bypassPaymentStageCheck?: boolean },
  ): Promise<{
    scope: NonNullable<Awaited<ReturnType<ReturnType<typeof requireOrders>["getProductionScope"]>>>;
    prodState: Awaited<ReturnType<typeof readProductionState>>;
    payload: P101Payload | null;
    validationErrors: ProductionValidationIssue[];
    featureEnabled: boolean;
    featureConfigured: boolean;
  }> {
    const orders = requireOrders();
    const identity = requireIdentity();

    const scope = await orders.getProductionScope(orderId, { tx });
    if (!scope) {
      throw notFound("ORDER_NOT_FOUND");
    }
    const [owner, prodState] = await Promise.all([
      identity.getUser(scope.ownerUserId, { tx }),
      readProductionState(tx),
    ]);

    const errors: ProductionValidationIssue[] = [];
    if (isOrderLockedForProduction(scope.lockState)) {
      errors.push({
        code: "ORDER_LOCKED",
        message: "This order is locked and cannot dispatch production webhooks.",
      });
    }
    if (isOrderCanceledStatus(scope.statusKey)) {
      errors.push({
        code: "ORDER_CANCELED",
        message: "Canceled orders cannot dispatch production webhooks.",
      });
    }
    if (!owner || owner.status !== "active") {
      errors.push({
        code: "ORDER_OWNER_INACTIVE",
        message: "The order owner account must be active to dispatch production webhooks.",
      });
    }

    const stagePreconditions = await evaluateFormat3StagePreconditionsInTx(tx, scope.orderPublicId, options);
    if (stagePreconditions.isFormat3 && !stagePreconditions.paymentConfirmed) {
      errors.push({
        code: "PAYMENT_NOT_CONFIRMED",
        message: "Order payment must be confirmed before Phase I (P101) can run.",
      });
    }

    // PW-08: Default `release_status` is `""` when omitted by the operator — never `scope.statusKey`.
    const effectiveReleaseStatus = releaseStatusOverride !== undefined ? releaseStatusOverride.trim() : "";

    const built = buildP101Payload({
      customerRef: owner?.customerRef ?? null,
      orderReference: scope.reference,
      canonVersion: prodState.cfg.canonVersion,
      runMode: prodState.cfg.runMode,
      clientName: owner?.name ?? "",
      clientEmail: owner?.email ?? "",
      releaseStatus: effectiveReleaseStatus,
      packets: scope.packets,
      otherItemCount: scope.otherItemCount,
    });

    if (!built.ok) {
      errors.push(...built.errors);
    }

    return {
      scope,
      prodState,
      payload: built.payload,
      validationErrors: errors,
      featureEnabled: prodState.enabled,
      featureConfigured: prodState.configured,
    };
  }

  type DispatchActionKind = "request" | "retry" | "redeliver" | "resend";

  async function recordRefusedAuditInTx(
    tx: Tx,
    input: {
      phase: ProductionPhase;
      orderPublicId: string;
      reasonCode: string;
      packet?: string | null;
      tier?: string | null;
      bundleScopeManifest?: string | null;
      isResend?: boolean;
      action?: DispatchActionKind;
      extraAttrs?: Record<string, SafeAttributeValue>;
    },
  ): Promise<void> {
    const action = input.action ?? (input.isResend ? "resend" : "request");
    await deps.audit.record(
      {
        category: "integration",
        eventName: "integration.production.dispatch.refused",
        action,
        outcome: "denied",
        severity: "WARN",
        provider: "production_webhook",
        reasonCode: input.reasonCode,
        orderPublicId: input.orderPublicId,
        resource: { type: "order", publicId: input.orderPublicId },
        attributes: {
          phase: input.phase,
          order_public_id: input.orderPublicId,
          packet: input.packet ?? null,
          tier: input.tier ?? null,
          bundle_scope_manifest: input.bundleScopeManifest ?? null,
          http_status: null,
          ...input.extraAttrs,
        },
      },
      tx,
    );
  }

  async function enqueueDispatchInTx(
    tx: Tx,
    params: {
      principal: SessionPrincipal | null;
      orderId: number;
      orderPublicId: string;
      orderReference: string;
      expectedOwnerUserId: number;
      destinationFingerprint: string;
      phase: ProductionPhase;
      payloadObject: P101Payload | P201Payload;
      sentCustomerId: string;
      sentOrderId: string;
      sentRunMode: string;
      packet: string | null;
      tier: string | null;
      bundleScopeManifest: string | null;
      releaseStatus: string | null;
      isResend: boolean;
      resendReasonCode: ControlledResendReason | null;
      retryOfPublicId?: string | null;
      redeliveryOfPublicId?: string | null;
      idempotencyKeyOverride?: string;
      retryRootWireKey?: string;
      destinationChanged?: boolean;
      dispatchKind?: DispatchActionKind;
      reasonLength?: number;
      phase1ArtifactsConfirmed: boolean;
      triggerSource?: StageWebhookTriggerSource | "manual";
      stageKey?: string | null;
      correlationIdOverride?: string;
    },
  ): Promise<ProductionDispatchItem> {
    const now = deps.clock.now();
    const publicId = ulid();
    // Retry rows carry the root delivery's wire `Idempotency-Key` upstream (so receiver dedupe protects
    // operator retries after 5xx exhaustion to `dead`) while appending `:r:<publicId>` (`<= 87 <= 96`)
    // in `integration_production_dispatches.idempotency_key` to satisfy `uq_prod_dispatch_idempotency`.
    const storedIdempotencyKey = params.retryRootWireKey
      ? `${params.retryRootWireKey}:r:${publicId}`
      : (params.idempotencyKeyOverride ?? `rp-prod:${params.phase.toLowerCase()}:${publicId}`);
    const wireIdempotencyKey = toWireIdempotencyKey(storedIdempotencyKey);
    const payloadJson = JSON.stringify(params.payloadObject);
    const payloadSha256 = sha256Hex(payloadJson);
    const payloadEnc = deps.crypto.encrypt(payloadJson, dispatchPayloadAad(publicId));
    const correlationId = params.correlationIdOverride ?? getRequestContext()?.correlationId ?? ulid();
    const expiresAt = new Date(now.getTime() + PRODUCTION_DISPATCH_MAX_TTL_MS);
    const retryOfPublicId = params.retryOfPublicId ?? null;
    const redeliveryOfPublicId = params.redeliveryOfPublicId ?? null;
    const dispatchKind: DispatchActionKind = params.dispatchKind ?? (params.isResend ? "resend" : "request");
    const triggerSource: StageWebhookTriggerSource | "manual" = params.triggerSource ?? "manual";
    const stageKey = params.stageKey ? params.stageKey.slice(0, 64) : null;

    const { jobId } = await deps.jobs.enqueue(
      PRODUCTION_DELIVERY_JOB,
      { dispatchId: publicId },
      {
        idempotencyKey: publicId,
        maxAttempts: PRODUCTION_MAX_ATTEMPTS,
        correlationId,
      },
      tx,
    );

    await tx.insert(integrationProductionDispatches).values({
      publicId,
      orderId: params.orderId,
      orderPublicId: params.orderPublicId,
      orderReference: params.orderReference,
      expectedOwnerUserId: params.expectedOwnerUserId,
      destinationFingerprint: params.destinationFingerprint,
      jobPublicId: jobId,
      activeFencingToken: 0,
      expiresAt,
      phase: params.phase,
      state: "queued",
      attemptCount: 0,
      idempotencyKey: storedIdempotencyKey,
      payloadSha256,
      payloadEnc,
      sentCustomerId: params.sentCustomerId,
      sentOrderId: params.sentOrderId,
      sentRunMode: params.sentRunMode,
      packet: params.packet,
      tier: params.tier,
      bundleScopeManifest: params.bundleScopeManifest,
      releaseStatus: params.releaseStatus,
      httpStatus: null,
      responseSummary: null,
      lastReasonCode: null,
      isResend: params.isResend,
      resendReason: params.resendReasonCode,
      retryOfPublicId,
      redeliveryOfPublicId,
      phase1ArtifactsConfirmed: params.phase1ArtifactsConfirmed,
      triggerSource,
      stageKey,
      requestedByUserId: params.principal?.userId ?? null,
      requestedByPublicId: params.principal?.userPublicId ?? null,
      correlationId,
      deliveredAt: null,
      finalizedAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });

    const reqAttrs: Record<string, SafeAttributeValue> = {
      phase: params.phase,
      order_public_id: params.orderPublicId,
      packet: params.packet,
      tier: params.tier,
      bundle_scope_manifest: params.bundleScopeManifest,
      http_status: null,
      idempotency_key: wireIdempotencyKey,
      retry_of_public_id: retryOfPublicId,
      redelivery_of_public_id: redeliveryOfPublicId,
      trigger_source: triggerSource,
      stage_key: stageKey,
    };
    if (params.isResend && params.resendReasonCode) {
      reqAttrs.resend_reason_code = params.resendReasonCode;
    }
    if (typeof params.destinationChanged === "boolean") {
      reqAttrs.destination_changed = params.destinationChanged;
    }

    const auditEventName =
      dispatchKind === "redeliver"
        ? "integration.production.dispatch.redelivered"
        : dispatchKind === "retry"
          ? "integration.production.dispatch.retried"
          : dispatchKind === "resend"
            ? "integration.production.dispatch.resent"
            : "integration.production.dispatch.requested";

    await deps.audit.record(
      {
        category: "integration",
        eventName: auditEventName,
        action: dispatchKind,
        outcome: "completed",
        severity: dispatchKind === "redeliver" || dispatchKind === "resend" ? "WARN" : "INFO",
        provider: "production_webhook",
        orderPublicId: params.orderPublicId,
        resource: { type: "integration_production_dispatch", publicId },
        attributes: reqAttrs,
        ...(typeof params.reasonLength === "number" ? { safeCounts: { reason_length: params.reasonLength } } : {}),
      },
      tx,
    );

    const [inserted] = await tx
      .select()
      .from(integrationProductionDispatches)
      .where(eq(integrationProductionDispatches.publicId, publicId))
      .limit(1);

    if (!inserted) {
      throw new DomainError("UNAVAILABLE", "DISPATCH_INSERT_FAILED", "Failed to load queued production dispatch.");
    }
    return toDispatchItem(inserted);
  }

  async function failTerminalBeforeSendInTx(
    tx: Tx,
    row: DispatchRow,
    now: Date,
    reasonCode: string,
    correlationId: string,
    severity: "WARN" | "ERROR" = "WARN",
    extraAttrs?: Record<string, string | number | boolean | null>,
  ): Promise<"failed" | "unknown"> {
    const uncertain = row.attemptCount > 0 || extraAttrs?.delivery_uncertain === true;
    const nextState: "failed" | "unknown" = uncertain ? "unknown" : "failed";
    const summary = fixedDispatchSummary(reasonCode, row.httpStatus, nextState);
    await tx
      .update(integrationProductionDispatches)
      .set({
        state: nextState,
        payloadEnc: null,
        activeFencingToken: 0,
        lastReasonCode: reasonCode,
        responseSummary: summary,
        finalizedAt: now,
        updatedAt: now,
        version: row.version + 1,
      })
      .where(
        and(
          eq(integrationProductionDispatches.id, row.id),
          eq(integrationProductionDispatches.version, row.version),
        ),
      );

    await deps.audit.record(
      {
        category: "integration",
        eventName: "integration.production.dispatch.failed",
        action: "deliver",
        outcome: nextState,
        severity,
        provider: "production_webhook",
        reasonCode,
        correlationId,
        actor: JOB_AUDIT_ACTOR,
        orderPublicId: row.orderPublicId,
        resource: { type: "integration_production_dispatch", publicId: row.publicId },
        attributes: buildSafeDispatchAuditAttributes(row, {
          retryable: false,
          delivery_uncertain: uncertain,
          ...extraAttrs,
        }),
      },
      tx,
    );
    return nextState;
  }

  function terminalDecision(
    nextState: "failed" | "unknown",
    reasonCode: string,
    row: Pick<DispatchRow, "orderPublicId" | "orderReference" | "phase">,
  ):
    | {
        kind: "terminal_failed";
        reasonCode: string;
        orderPublicId: string;
        orderReference: string;
        phase: ProductionPhase;
      }
    | {
        kind: "terminal_unknown";
        reasonCode: string;
        orderPublicId: string;
        orderReference: string;
        phase: ProductionPhase;
      } {
    return nextState === "unknown"
      ? {
          kind: "terminal_unknown",
          reasonCode,
          orderPublicId: row.orderPublicId,
          orderReference: row.orderReference,
          phase: row.phase as ProductionPhase,
        }
      : {
          kind: "terminal_failed",
          reasonCode,
          orderPublicId: row.orderPublicId,
          orderReference: row.orderReference,
          phase: row.phase as ProductionPhase,
        };
  }

  /* ------------------------------------------------- Background Delivery Job Handler */

  type ClaimDecision =
    | { kind: "canceled"; reasonCode: string }
    | { kind: "already_completed" }
    | { kind: "already_unknown"; reasonCode: string }
    | { kind: "already_failed"; reasonCode: string }
    | { kind: "ambiguous_sending"; orderPublicId: string; orderReference: string; phase: ProductionPhase }
    | {
        kind: "terminal_unknown";
        reasonCode: string;
        orderPublicId: string;
        orderReference: string;
        phase: ProductionPhase;
      }
    | {
        kind: "terminal_failed";
        reasonCode: string;
        orderPublicId: string;
        orderReference: string;
        phase: ProductionPhase;
      }
    | {
        kind: "ready";
        row: DispatchRow;
        claimedVersion: number;
        claimedAttempt: number;
        claimedFencingToken: number;
        targetUrl: string;
        authHeaderName: string;
        authHeaderValue: string | null;
        signingEnabled: boolean;
        signingSecret: string | null;
        overlapSigningSecret: string | null;
        timeoutMs: number;
        payloadJson: string;
      };

  async function handleDeliveryJob(job: ClaimedJob<{ dispatchId: string }>): Promise<JobResult> {
    const dispatchId = job.payload.dispatchId;
    if (typeof dispatchId !== "string" || dispatchId.length !== 26) {
      return { outcome: "canceled", reasonCode: "INVALID_DISPATCH_ID" };
    }

    // Phase 1: Fenced DB transaction to validate job binding, destination fingerprint, order eligibility, and claim `queued -> sending`.
    const decision = await deps.db.transaction(async (tx): Promise<ClaimDecision> => {
      await job.assertStillOwned(tx);

      const [row] = await tx
        .select()
        .from(integrationProductionDispatches)
        .where(eq(integrationProductionDispatches.publicId, dispatchId))
        .for("update")
        .limit(1);

      if (!row) {
        return { kind: "canceled", reasonCode: "PRODUCTION_DISPATCH_NOT_FOUND" };
      }
      if (row.jobPublicId !== job.jobId) {
        return { kind: "canceled", reasonCode: "PRODUCTION_JOB_SUPERSEDED" };
      }
      if (row.state === "stopped") {
        return { kind: "canceled", reasonCode: "STOPPED_BY_OPERATOR" };
      }
      if (row.state === "delivered") {
        return { kind: "already_completed" };
      }
      if (row.state === "unknown") {
        return { kind: "already_unknown", reasonCode: row.lastReasonCode ?? "PRODUCTION_DELIVERY_INTERRUPTED" };
      }
      if (row.state === "failed" || row.state === "dead") {
        return { kind: "already_failed", reasonCode: row.lastReasonCode ?? "PRODUCTION_ALREADY_FINAL" };
      }

      const now = deps.clock.now();
      if (row.state === "sending") {
        // PW-02: Never auto-replay a preexisting ambiguous `sending` marker; immediately scrub `payloadEnc`
        // and finalize the dispatch to `unknown` so operator re-send requires explicit verification + step-up.
        await failTerminalBeforeSendInTx(
          tx,
          row,
          now,
          "PRODUCTION_AMBIGUOUS_IN_FLIGHT",
          job.correlationId,
          "WARN",
          { delivery_uncertain: true },
        );
        return {
          kind: "ambiguous_sending",
          orderPublicId: row.orderPublicId,
          orderReference: row.orderReference,
          phase: row.phase as ProductionPhase,
        };
      }
      if (row.state !== "queued") {
        return { kind: "canceled", reasonCode: "PRODUCTION_UNEXPECTED_STATE" };
      }
      if (row.expiresAt.getTime() <= now.getTime()) {
        const expiryReason =
          row.attemptCount > 0 ? "PRODUCTION_PRIOR_ATTEMPT_UNCERTAIN" : "PRODUCTION_DELIVERY_EXPIRED";
        const st = await failTerminalBeforeSendInTx(tx, row, now, expiryReason, job.correlationId);
        return terminalDecision(st, expiryReason, row);
      }

      if (!row.payloadEnc) {
        const st = await failTerminalBeforeSendInTx(
          tx,
          row,
          now,
          "PRODUCTION_PAYLOAD_MISSING",
          job.correlationId,
          "ERROR",
        );
        return terminalDecision(st, "PRODUCTION_PAYLOAD_MISSING", row);
      }

      const prodState = await readProductionState(tx);
      const phase = row.phase as ProductionPhase;
      const targetUrl = targetSecretForPhase(prodState, phase);
      const authHeaderValue =
        prodState.cfg.authHeaderName !== ""
          ? await readSecret(deps.settings, INTEGRATIONS_PRODUCTION_AUTH_VALUE, tx)
          : null;

      if (!prodState.enabled) {
        const st = await failTerminalBeforeSendInTx(tx, row, now, "PRODUCTION_NOT_CONFIGURED", job.correlationId);
        return terminalDecision(st, "PRODUCTION_NOT_CONFIGURED", row);
      }

      // PW-04: Pin dispatch to the exact destination, auth header, signing mode/secret, and canon/runMode authorized at queue time.
      // Any change (including via generic Platform settings) cancels the queued/retried dispatch with DESTINATION_CHANGED.
      if (!targetUrl || !prodState.configured || !isValidProductionWebhookUrl(targetUrl)) {
        const currentFpWhenIncomplete = computeDestinationFingerprint(phase, {
          targetUrl: targetUrl ?? "",
          authHeaderName: prodState.cfg.authHeaderName,
          authHeaderValue,
          canonVersion: prodState.cfg.canonVersion,
          runMode: prodState.cfg.runMode,
          signingEnabled: prodState.cfg.signingEnabled,
          signingSecret: prodState.signingSecret,
        });
        const reasonCode =
          currentFpWhenIncomplete !== row.destinationFingerprint
            ? "DESTINATION_CHANGED"
            : "PRODUCTION_NOT_CONFIGURED";
        const st = await failTerminalBeforeSendInTx(tx, row, now, reasonCode, job.correlationId);
        return terminalDecision(st, reasonCode, row);
      }

      const currentFingerprint = computeDestinationFingerprint(phase, {
        targetUrl,
        authHeaderName: prodState.cfg.authHeaderName,
        authHeaderValue,
        canonVersion: prodState.cfg.canonVersion,
        runMode: prodState.cfg.runMode,
        signingEnabled: prodState.cfg.signingEnabled,
        signingSecret: prodState.signingSecret,
      });
      const overlapFingerprint =
        prodState.cfg.signingEnabled && prodState.overlapSigningSecret
          ? computeDestinationFingerprint(phase, {
              targetUrl,
              authHeaderName: prodState.cfg.authHeaderName,
              authHeaderValue,
              canonVersion: prodState.cfg.canonVersion,
              runMode: prodState.cfg.runMode,
              signingEnabled: true,
              signingSecret: prodState.overlapSigningSecret,
            })
          : null;
      if (
        currentFingerprint !== row.destinationFingerprint &&
        (overlapFingerprint === null || overlapFingerprint !== row.destinationFingerprint)
      ) {
        const st = await failTerminalBeforeSendInTx(tx, row, now, "DESTINATION_CHANGED", job.correlationId);
        return terminalDecision(st, "DESTINATION_CHANGED", row);
      }

      // PW-03: Re-validate current order existence, legal-hold/lock state, cancellation, owner binding, and scope BEFORE send.
      const orders = requireOrders();
      const identity = requireIdentity();
      const scope = await orders.getProductionScope(row.orderId, { tx });
      if (!scope) {
        const st = await failTerminalBeforeSendInTx(tx, row, now, "ORDER_NOT_FOUND", job.correlationId);
        return terminalDecision(st, "ORDER_NOT_FOUND", row);
      }
      if (isOrderLockedForProduction(scope.lockState)) {
        const st = await failTerminalBeforeSendInTx(tx, row, now, "ORDER_LOCKED", job.correlationId);
        return terminalDecision(st, "ORDER_LOCKED", row);
      }
      if (isOrderCanceledStatus(scope.statusKey)) {
        const st = await failTerminalBeforeSendInTx(tx, row, now, "ORDER_CANCELED", job.correlationId);
        return terminalDecision(st, "ORDER_CANCELED", row);
      }
      if (scope.ownerUserId !== row.expectedOwnerUserId) {
        const st = await failTerminalBeforeSendInTx(tx, row, now, "ORDER_OWNER_CHANGED", job.correlationId);
        return terminalDecision(st, "ORDER_OWNER_CHANGED", row);
      }
      const owner = await identity.getUser(scope.ownerUserId, { tx });
      if (!owner || owner.status !== "active") {
        const st = await failTerminalBeforeSendInTx(tx, row, now, "ORDER_OWNER_INACTIVE", job.correlationId);
        return terminalDecision(st, "ORDER_OWNER_INACTIVE", row);
      }
      if (phase === "P101") {
        const liveP101 = buildP101Payload({
          customerRef: owner.customerRef ?? null,
          orderReference: scope.reference,
          canonVersion: prodState.cfg.canonVersion,
          runMode: prodState.cfg.runMode,
          clientName: owner.name,
          clientEmail: owner.email,
          releaseStatus: row.releaseStatus ?? "",
          packets: scope.packets,
          otherItemCount: scope.otherItemCount,
        });
        const scopeUnchanged =
          liveP101.ok &&
          liveP101.payload !== null &&
          liveP101.payload.order_id === row.sentOrderId &&
          liveP101.payload.packet === row.packet &&
          liveP101.payload.tier === row.tier &&
          liveP101.payload.bundle_scope_manifest === row.bundleScopeManifest;
        if (!scopeUnchanged) {
          const st = await failTerminalBeforeSendInTx(tx, row, now, "ORDER_SCOPE_CHANGED", job.correlationId);
          return terminalDecision(st, "ORDER_SCOPE_CHANGED", row);
        }
      }

      let payloadJson: string;
      try {
        payloadJson = deps.crypto.decrypt(row.payloadEnc, dispatchPayloadAad(row.publicId));
      } catch {
        const st = await failTerminalBeforeSendInTx(
          tx,
          row,
          now,
          "PRODUCTION_PAYLOAD_DECRYPT_FAILED",
          job.correlationId,
          "ERROR",
        );
        return terminalDecision(st, "PRODUCTION_PAYLOAD_DECRYPT_FAILED", row);
      }

      // Defense-in-depth: verify SHA-256 and canonical payload schema before any network socket opens.
      const integrityOk = sha256Hex(payloadJson) === row.payloadSha256;
      let schemaOk = false;
      if (integrityOk) {
        try {
          const parsed: unknown = JSON.parse(payloadJson);
          schemaOk =
            phase === "P101"
              ? validateP101(parsed).ok
              : validateLaterPhasePayload(phase, parsed, {
                  customerId: row.sentCustomerId,
                  orderId: row.sentOrderId,
                  runMode: row.sentRunMode,
                }).ok;
        } catch {
          schemaOk = false;
        }
      }
      if (!integrityOk || !schemaOk) {
        const reasonCode = !integrityOk ? "PRODUCTION_PAYLOAD_HASH_MISMATCH" : "PRODUCTION_PAYLOAD_INVALID";
        const st = await failTerminalBeforeSendInTx(tx, row, now, reasonCode, job.correlationId, "ERROR");
        return terminalDecision(st, reasonCode, row);
      }

      const claimedVersion = row.version + 1;
      const claimedAttempt = job.attempt;
      const claimedFencingToken = job.fencingToken;

      await tx
        .update(integrationProductionDispatches)
        .set({
          state: "sending",
          attemptCount: claimedAttempt,
          activeFencingToken: claimedFencingToken,
          updatedAt: now,
          version: claimedVersion,
        })
        .where(
          and(
            eq(integrationProductionDispatches.id, row.id),
            eq(integrationProductionDispatches.state, "queued"),
            eq(integrationProductionDispatches.version, row.version),
            eq(integrationProductionDispatches.jobPublicId, job.jobId),
          ),
        );

      return {
        kind: "ready",
        row: {
          ...row,
          state: "sending",
          attemptCount: claimedAttempt,
          activeFencingToken: claimedFencingToken,
          version: claimedVersion,
        },
        claimedVersion,
        claimedAttempt,
        claimedFencingToken,
        targetUrl,
        authHeaderName: prodState.cfg.authHeaderName,
        authHeaderValue,
        signingEnabled: prodState.cfg.signingEnabled,
        signingSecret: prodState.signingSecret,
        overlapSigningSecret: prodState.overlapSigningSecret,
        timeoutMs: prodState.cfg.timeoutMs,
        payloadJson,
      };
    });

    if (decision.kind === "canceled") {
      return { outcome: "canceled", reasonCode: decision.reasonCode };
    }
    if (decision.kind === "already_completed") {
      return { outcome: "completed" };
    }
    if (decision.kind === "already_unknown") {
      return { outcome: "unknown", reasonCode: decision.reasonCode };
    }
    if (decision.kind === "terminal_unknown") {
      await checks.recordOutcome("production", "failed", decision.reasonCode);
      await emitProdOpsAlert({
        orderPublicId: decision.orderPublicId,
        phase: decision.phase,
        severity: decision.phase === "P101" || decision.phase === "P201" ? "critical" : "error",
        code: decision.reasonCode,
        title: `${decision.phase} production webhook outcome uncertain for order ${decision.orderReference}`,
        text: fixedDispatchSummary(decision.reasonCode, null, "unknown"),
        correlationId: job.correlationId,
      });
      return { outcome: "unknown", reasonCode: decision.reasonCode };
    }
    if (decision.kind === "already_failed" || decision.kind === "terminal_failed") {
      if (decision.kind === "terminal_failed") {
        await checks.recordOutcome("production", "failed", decision.reasonCode);
        await emitProdOpsAlert({
          orderPublicId: decision.orderPublicId,
          phase: decision.phase,
          severity: "error",
          code: decision.reasonCode,
          title: `${decision.phase} production webhook failed for order ${decision.orderReference}`,
          text: fixedDispatchSummary(decision.reasonCode, null, "failed"),
          correlationId: job.correlationId,
        });
      }
      return { outcome: "failed", reasonCode: decision.reasonCode, retryable: false };
    }
    if (decision.kind === "ambiguous_sending") {
      await checks.recordOutcome("production", "failed", "PRODUCTION_AMBIGUOUS_IN_FLIGHT");
      await emitProdOpsAlert({
        orderPublicId: decision.orderPublicId,
        phase: decision.phase,
        severity: decision.phase === "P101" || decision.phase === "P201" ? "critical" : "error",
        code: "PRODUCTION_AMBIGUOUS_IN_FLIGHT",
        title: `${decision.phase} production webhook interrupted in flight for order ${decision.orderReference}`,
        text: fixedDispatchSummary("PRODUCTION_AMBIGUOUS_IN_FLIGHT", null, "unknown"),
        correlationId: job.correlationId,
      });
      return { outcome: "unknown", reasonCode: "PRODUCTION_AMBIGUOUS_IN_FLIGHT" };
    }

    // Phase 2: Single outbound HTTPS POST with single-evaluation allowlist + public-only IP pinning.
    await job.assertStillOwned();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Idempotency-Key": toWireIdempotencyKey(decision.row.idempotencyKey),
      "X-ReadyPackets-Delivery": decision.row.publicId,
      "X-Correlation-Id": job.correlationId,
    };
    if (decision.row.redeliveryOfPublicId) {
      headers["X-ReadyPackets-Redelivery-Of"] = decision.row.redeliveryOfPublicId;
    }
    if (decision.authHeaderName && decision.authHeaderValue) {
      headers[decision.authHeaderName] = decision.authHeaderValue;
    }
    if (decision.signingEnabled && decision.signingSecret) {
      const timestampSec = Math.floor(deps.clock.now().getTime() / 1000);
      headers["X-ReadyPackets-Timestamp"] = String(timestampSec);
      headers["X-ReadyPackets-Signature"] = signWebhookPayload(
        Buffer.from(decision.payloadJson, "utf8"),
        timestampSec,
        decision.signingSecret,
        decision.overlapSigningSecret,
      );
    }

    type AttemptOutcome =
      | { kind: "delivered"; httpStatus: number }
      | {
          kind: "failed";
          retryable: boolean;
          reasonCode: string;
          httpStatus: number | null;
        };

    let attemptOutcome: AttemptOutcome;
    try {
      const resp = await egress.fetchPinned(decision.targetUrl, "webhook", {
        method: "POST",
        headers,
        body: decision.payloadJson,
        timeoutMs: decision.timeoutMs,
        maxResponseBytes: 8_192,
        signal: job.signal,
        requireAllowlistRule: true,
        publicAddressesOnly: true,
      });

      // PW-01: Discard `resp.body` completely — record only `resp.status` and fixed server reason code.
      if (resp.status >= 200 && resp.status < 300) {
        attemptOutcome = { kind: "delivered", httpStatus: resp.status };
      } else if (resp.status === 429) {
        attemptOutcome = {
          kind: "failed",
          retryable: true,
          reasonCode: "PRODUCTION_HTTP_429",
          httpStatus: resp.status,
        };
      } else if (resp.status >= 500 && resp.status < 600) {
        attemptOutcome = {
          kind: "failed",
          retryable: true,
          reasonCode: "PRODUCTION_HTTP_5XX",
          httpStatus: resp.status,
        };
      } else if (resp.status >= 300 && resp.status < 400) {
        attemptOutcome = {
          kind: "failed",
          retryable: false,
          reasonCode: "EGRESS_REDIRECT_REFUSED",
          httpStatus: resp.status,
        };
      } else {
        attemptOutcome = {
          kind: "failed",
          retryable: false,
          reasonCode: "PRODUCTION_HTTP_4XX",
          httpStatus: resp.status,
        };
      }
    } catch (err) {
      if (err instanceof DomainError) {
        const retryable = err.code === "UNAVAILABLE";
        attemptOutcome = {
          kind: "failed",
          retryable,
          reasonCode: err.reasonCode,
          httpStatus: null,
        };
      } else {
        attemptOutcome = {
          kind: "failed",
          retryable: true,
          reasonCode: "PRODUCTION_NETWORK_ERROR",
          httpStatus: null,
        };
      }
    }

    // Phase 3: Claim-fenced finalization transaction (`job_runs` FIRST via `assertStillOwned(tx)`, dispatch SECOND).
    const result = await deps.db.transaction(async (tx): Promise<JobResult> => {
      await job.assertStillOwned(tx);

      const [locked] = await tx
        .select()
        .from(integrationProductionDispatches)
        .where(eq(integrationProductionDispatches.id, decision.row.id))
        .for("update")
        .limit(1);

      if (!locked) {
        return { outcome: "canceled", reasonCode: "PRODUCTION_DISPATCH_NOT_FOUND" };
      }
      if (
        locked.state !== "sending" ||
        locked.version !== decision.claimedVersion ||
        locked.attemptCount !== decision.claimedAttempt ||
        locked.activeFencingToken !== decision.claimedFencingToken ||
        locked.jobPublicId !== job.jobId
      ) {
        // PW-02: Refuse to overwrite a dispatch whose state, version, attempt, fencing token, or job binding
        // moved since claim (e.g. reconciled terminal row).
        return { outcome: "unknown", reasonCode: "PRODUCTION_FENCE_SUPERSEDED" };
      }

      const claimFenceWhere = and(
        eq(integrationProductionDispatches.id, locked.id),
        eq(integrationProductionDispatches.state, "sending"),
        eq(integrationProductionDispatches.version, decision.claimedVersion),
        eq(integrationProductionDispatches.attemptCount, decision.claimedAttempt),
        eq(integrationProductionDispatches.activeFencingToken, decision.claimedFencingToken),
        eq(integrationProductionDispatches.jobPublicId, job.jobId),
      );

      const now = deps.clock.now();
      if (attemptOutcome.kind === "delivered") {
        const summary = fixedDispatchSummary("PRODUCTION_DELIVERED", attemptOutcome.httpStatus, "delivered");
        await tx
          .update(integrationProductionDispatches)
          .set({
            state: "delivered",
            payloadEnc: null,
            activeFencingToken: 0,
            httpStatus: attemptOutcome.httpStatus,
            responseSummary: summary,
            lastReasonCode: "PRODUCTION_DELIVERED",
            deliveredAt: now,
            finalizedAt: now,
            updatedAt: now,
            version: locked.version + 1,
          })
          .where(claimFenceWhere);

        await deps.audit.record(
          {
            category: "integration",
            eventName: "integration.production.dispatch.delivered",
            action: "deliver",
            outcome: "completed",
            severity: "INFO",
            provider: "production_webhook",
            correlationId: job.correlationId,
            actor: JOB_AUDIT_ACTOR,
            orderPublicId: locked.orderPublicId,
            resource: { type: "integration_production_dispatch", publicId: locked.publicId },
            attributes: buildSafeDispatchAuditAttributes({
              ...locked,
              httpStatus: attemptOutcome.httpStatus,
              attemptCount: job.attempt,
            }),
          },
          tx,
        );
        return { outcome: "completed" };
      }

      const exhausted = attemptOutcome.retryable && job.attempt >= PRODUCTION_MAX_ATTEMPTS;
      if (exhausted) {
        const summary = fixedDispatchSummary(attemptOutcome.reasonCode, attemptOutcome.httpStatus, "dead");
        await tx
          .update(integrationProductionDispatches)
          .set({
            state: "dead",
            payloadEnc: null,
            activeFencingToken: 0,
            httpStatus: attemptOutcome.httpStatus,
            responseSummary: summary,
            lastReasonCode: attemptOutcome.reasonCode,
            finalizedAt: now,
            updatedAt: now,
            version: locked.version + 1,
          })
          .where(claimFenceWhere);

        await deps.audit.record(
          {
            category: "integration",
            eventName: "integration.production.dispatch.dead",
            action: "deliver",
            outcome: "failed",
            severity: "ERROR",
            provider: "production_webhook",
            reasonCode: attemptOutcome.reasonCode,
            correlationId: job.correlationId,
            actor: JOB_AUDIT_ACTOR,
            orderPublicId: locked.orderPublicId,
            resource: { type: "integration_production_dispatch", publicId: locked.publicId },
            attributes: buildSafeDispatchAuditAttributes(
              {
                ...locked,
                httpStatus: attemptOutcome.httpStatus,
                attemptCount: job.attempt,
              },
              { retryable: false },
            ),
          },
          tx,
        );
        return { outcome: "failed", reasonCode: attemptOutcome.reasonCode, retryable: false };
      }

      if (attemptOutcome.retryable) {
        // PW-02: Never transition back to `queued` if `payloadEnc` was cleared or the bounded TTL expired.
        if (!locked.payloadEnc || locked.expiresAt.getTime() <= now.getTime()) {
          const reasonCode = !locked.payloadEnc
            ? "PRODUCTION_PAYLOAD_MISSING"
            : "PRODUCTION_PRIOR_ATTEMPT_UNCERTAIN";
          const summary = fixedDispatchSummary(reasonCode, attemptOutcome.httpStatus, "unknown");
          await tx
            .update(integrationProductionDispatches)
            .set({
              state: "unknown",
              payloadEnc: null,
              activeFencingToken: 0,
              httpStatus: attemptOutcome.httpStatus,
              responseSummary: summary,
              lastReasonCode: reasonCode,
              finalizedAt: now,
              updatedAt: now,
              version: locked.version + 1,
            })
            .where(claimFenceWhere);

          await deps.audit.record(
            {
              category: "integration",
              eventName: "integration.production.dispatch.failed",
              action: "deliver",
              outcome: "unknown",
              severity: "WARN",
              provider: "production_webhook",
              reasonCode,
              correlationId: job.correlationId,
              actor: JOB_AUDIT_ACTOR,
              orderPublicId: locked.orderPublicId,
              resource: { type: "integration_production_dispatch", publicId: locked.publicId },
              attributes: buildSafeDispatchAuditAttributes(
                {
                  ...locked,
                  httpStatus: attemptOutcome.httpStatus,
                  attemptCount: job.attempt,
                },
                { retryable: false, delivery_uncertain: true },
              ),
            },
            tx,
          );
          return { outcome: "unknown", reasonCode };
        }

        // Put row back to `queued` with `payloadEnc` intact for the bounded retry window.
        const summary = fixedDispatchSummary(attemptOutcome.reasonCode, attemptOutcome.httpStatus, "queued");
        await tx
          .update(integrationProductionDispatches)
          .set({
            state: "queued",
            activeFencingToken: 0,
            httpStatus: attemptOutcome.httpStatus,
            responseSummary: summary,
            lastReasonCode: attemptOutcome.reasonCode,
            updatedAt: now,
            version: locked.version + 1,
          })
          .where(claimFenceWhere);

        await deps.audit.record(
          {
            category: "integration",
            eventName: "integration.production.dispatch.failed",
            action: "deliver",
            outcome: "failed",
            severity: "WARN",
            provider: "production_webhook",
            reasonCode: attemptOutcome.reasonCode,
            correlationId: job.correlationId,
            actor: JOB_AUDIT_ACTOR,
            orderPublicId: locked.orderPublicId,
            resource: { type: "integration_production_dispatch", publicId: locked.publicId },
            attributes: buildSafeDispatchAuditAttributes(
              {
                ...locked,
                httpStatus: attemptOutcome.httpStatus,
                attemptCount: job.attempt,
              },
              { retryable: true },
            ),
          },
          tx,
        );
        return { outcome: "failed", reasonCode: attemptOutcome.reasonCode, retryable: true };
      }

      // Deterministic non-retryable failure (4xx other than 429, redirect, or egress policy refusal)
      const summary = fixedDispatchSummary(attemptOutcome.reasonCode, attemptOutcome.httpStatus, "failed");
      await tx
        .update(integrationProductionDispatches)
        .set({
          state: "failed",
          payloadEnc: null,
          activeFencingToken: 0,
          httpStatus: attemptOutcome.httpStatus,
          responseSummary: summary,
          lastReasonCode: attemptOutcome.reasonCode,
          finalizedAt: now,
          updatedAt: now,
          version: locked.version + 1,
        })
        .where(claimFenceWhere);

      await deps.audit.record(
        {
          category: "integration",
          eventName: "integration.production.dispatch.failed",
          action: "deliver",
          outcome: "failed",
          severity: "WARN",
          provider: "production_webhook",
          reasonCode: attemptOutcome.reasonCode,
          correlationId: job.correlationId,
          actor: JOB_AUDIT_ACTOR,
          orderPublicId: locked.orderPublicId,
          resource: { type: "integration_production_dispatch", publicId: locked.publicId },
          attributes: buildSafeDispatchAuditAttributes(
            {
              ...locked,
              httpStatus: attemptOutcome.httpStatus,
              attemptCount: job.attempt,
            },
            { retryable: false },
          ),
        },
        tx,
      );
      return { outcome: "failed", reasonCode: attemptOutcome.reasonCode, retryable: false };
    });

    const phase = decision.row.phase as ProductionPhase;
    if (result.outcome === "completed") {
      await checks.recordOutcome("production", "succeeded", "PRODUCTION_DELIVERED");
      await resolveProdOpsAlert(decision.row.orderPublicId, phase, job.correlationId);
    } else if (result.outcome === "unknown") {
      await checks.recordOutcome("production", "failed", result.reasonCode);
      await emitProdOpsAlert({
        orderPublicId: decision.row.orderPublicId,
        phase,
        severity: phase === "P101" || phase === "P201" ? "critical" : "error",
        code: result.reasonCode,
        title: `${phase} production webhook outcome uncertain for order ${decision.row.orderReference}`,
        text: fixedDispatchSummary(result.reasonCode, null, "unknown"),
        correlationId: job.correlationId,
      });
    } else if (result.outcome === "failed") {
      await checks.recordOutcome("production", "failed", result.reasonCode);
      const isExhausted = attemptOutcome.kind === "failed" && attemptOutcome.retryable && job.attempt >= PRODUCTION_MAX_ATTEMPTS;
      if (isExhausted) {
        await emitProdOpsAlert({
          orderPublicId: decision.row.orderPublicId,
          phase,
          severity: phase === "P101" || phase === "P201" ? "critical" : "error",
          code: result.reasonCode,
          title: `${phase} production webhook dead-lettered for order ${decision.row.orderReference}`,
          text: fixedDispatchSummary(
            result.reasonCode,
            attemptOutcome.kind === "failed" ? attemptOutcome.httpStatus : null,
            "dead",
          ),
          correlationId: job.correlationId,
        });
      } else if (!result.retryable) {
        await emitProdOpsAlert({
          orderPublicId: decision.row.orderPublicId,
          phase,
          severity: "error",
          code: result.reasonCode,
          title: `${phase} production webhook failed for order ${decision.row.orderReference}`,
          text: fixedDispatchSummary(
            result.reasonCode,
            attemptOutcome.kind === "failed" ? attemptOutcome.httpStatus : null,
            "failed",
          ),
          correlationId: job.correlationId,
        });
      } else if (job.attempt >= 2) {
        await emitProdOpsAlert({
          orderPublicId: decision.row.orderPublicId,
          phase,
          severity: "warning",
          code: result.reasonCode,
          title: `${phase} production webhook retrying for order ${decision.row.orderReference}`,
          text: fixedDispatchSummary(
            result.reasonCode,
            attemptOutcome.kind === "failed" ? attemptOutcome.httpStatus : null,
            "queued",
          ),
          correlationId: job.correlationId,
        });
      }
    }

    return result;
  }

  async function handleReconcileJob(job: ClaimedJob<Record<string, never>>): Promise<JobResult> {
    await job.assertStillOwned();
    await reconcileStaleDispatches({
      correlationId: job.correlationId,
      beforeBatch: () => job.assertStillOwned(),
    });
    return { outcome: "completed" };
  }

  // Register background worker job (`retrySafe: false` so stalled `sending` attempts are never blindly re-sent).
  deps.jobs.register<{ dispatchId: string }>(PRODUCTION_DELIVERY_JOB, handleDeliveryJob, {
    retrySafe: false,
  });

  // Register bounded stale-dispatch reaper (`retrySafe: true`) so interrupted `sending` / orphaned `queued`
  // dispatches always scrub `payload_enc` and transition to terminal `failed` even with zero UI traffic.
  deps.jobs.register<Record<string, never>>(PRODUCTION_RECONCILE_JOB, handleReconcileJob, {
    retrySafe: true,
  });
  deps.jobs.registerSchedule({
    name: "integrations.production.reconcile_stale",
    type: PRODUCTION_RECONCILE_JOB,
    everyMs: 60_000,
    payload: {},
  });

  async function verifyOrderTriggerCaller(principal: SessionPrincipal, orderPublicId: string): Promise<void> {
    const orders = requireOrders();
    await deps.db.transaction(async (tx) => {
      await orders.assertCanReadOrder(principal, orderPublicId, { tx });
      await assertProductionTriggerInTx(deps, principal, tx);
    });
  }

  async function verifyOrderResendCaller(principal: SessionPrincipal, orderPublicId: string): Promise<void> {
    const orders = requireOrders();
    await deps.db.transaction(async (tx) => {
      await orders.assertCanReadOrder(principal, orderPublicId, { tx });
      await assertProductionResendInTx(deps, principal, tx);
    });
  }

  async function verifyOrderRedeliverCaller(principal: SessionPrincipal, orderPublicId: string): Promise<void> {
    const orders = requireOrders();
    await deps.db.transaction(async (tx) => {
      await orders.assertCanReadOrder(principal, orderPublicId, { tx });
      await assertProductionRedeliverInTx(deps, principal, tx);
    });
  }

  function buildPhaseDisabledReasons(params: {
    phase: ProductionPhase;
    prodState: Awaited<ReturnType<typeof readProductionState>>;
    phaseRows: DispatchRow[];
    validationErrors: ProductionValidationIssue[];
  }): ProductionDisabledReason[] {
    const reasons: ProductionDisabledReason[] = [];
    const { phase, prodState, phaseRows, validationErrors } = params;
    const thisEndpointConfigured = phaseUrlConfigured(prodState, phase);
    const label = phaseDisplayLabel(phase);

    if (!prodState.enabled) {
      reasons.push({
        code: "PIPELINE_DISABLED",
        category: "pipeline_off",
        message: "Production webhook pipeline is disabled in Integrations -> Production.",
        settingsActionable: true,
      });
    }
    if (!thisEndpointConfigured) {
      reasons.push({
        code: `${phase}_ENDPOINT_NOT_CONFIGURED`,
        category: "endpoint_missing",
        message: `No ${label} (${phase}) HTTPS destination URL is configured.`,
        settingsActionable: true,
      });
    }
    if (
      (phase !== "P101" && !prodState.p101UrlConfigured) ||
      (phase !== "P201" && !prodState.p201UrlConfigured)
    ) {
      reasons.push({
        code: "CORE_PIPELINE_URLS_INCOMPLETE",
        category: "config_incomplete",
        message: "Both Phase I (P101) and Phase II (P201) HTTPS URLs must be saved to run the production pipeline.",
        settingsActionable: true,
      });
    }
    if (!prodState.canonValid) {
      reasons.push({
        code: "CANON_VERSION_NOT_CONFIGURED",
        category: "config_incomplete",
        message: "Production canon_version is not configured in Integrations -> Production.",
        settingsActionable: true,
      });
    }
    if (!prodState.runModeValid) {
      reasons.push({
        code: "RUN_MODE_INVALID",
        category: "config_incomplete",
        message: "Production run_mode is invalid in Integrations -> Production.",
        settingsActionable: true,
      });
    }
    if (!prodState.authConsistent) {
      reasons.push({
        code: "AUTH_HEADER_VALUE_MISSING",
        category: "config_incomplete",
        message: "Custom authentication header name is set without a saved header secret.",
        settingsActionable: true,
      });
    }
    if (!prodState.signingConsistent) {
      reasons.push({
        code: "SIGNING_SECRET_MISSING",
        category: "config_incomplete",
        message: "HMAC payload signing is enabled without a rotated signing secret.",
        settingsActionable: true,
      });
    }

    const inProgress = phaseRows.some((r) => r.state === "queued" || r.state === "sending");
    const delivered = phaseRows.some((r) => r.state === "delivered");
    const latest = phaseRows[0] ?? null;

    if (inProgress) {
      reasons.push({
        code: "DISPATCH_IN_PROGRESS",
        category: "in_progress",
        message: `A ${label} (${phase}) dispatch is currently queued or sending for this order.`,
        settingsActionable: false,
      });
    } else if (delivered) {
      reasons.push({
        code: `${phase}_ALREADY_DELIVERED`,
        category: "already_delivered",
        message: `${label} (${phase}) has already been delivered; use Re-deliver in pipeline history if another run is required.`,
        settingsActionable: false,
      });
    } else if (latest !== null) {
      if (latest.state === "unknown") {
        reasons.push({
          code: "PRIOR_ATTEMPT_UNCERTAIN",
          category: "retry_or_resend_required",
          message: `A prior ${label} (${phase}) attempt ended with an uncertain outcome; verify downstream state before re-sending.`,
          settingsActionable: false,
        });
      } else {
        reasons.push({
          code: "PRIOR_ATTEMPT_FAILED_RETRY_AVAILABLE",
          category: "retry_or_resend_required",
          message: `A prior ${label} (${phase}) attempt ended in ${latest.state}; use Retry in pipeline history to try again.`,
          settingsActionable: false,
        });
      }
    }

    for (const issue of validationErrors) {
      if (issue.code === "CANON_VERSION_REQUIRED" && !prodState.canonValid) {
        continue;
      }
      reasons.push({
        code: issue.code,
        category: issue.code === "CANON_VERSION_REQUIRED" ? "config_incomplete" : "precondition",
        message: issue.message,
        settingsActionable: issue.code === "CANON_VERSION_REQUIRED",
      });
    }

    return reasons;
  }

  async function verifyAdminCaller(principal: SessionPrincipal): Promise<void> {
    await deps.db.transaction(async (tx) => {
      await assertProductionTriggerInTx(deps, principal, tx);
    });
  }

  interface PreparedPhaseDispatch {
    orderReference: string;
    expectedOwnerUserId: number;
    destinationFingerprint: string;
    payloadObject: P101Payload | P201Payload;
    sentCustomerId: string;
    sentOrderId: string;
    sentRunMode: string;
    packet: string | null;
    tier: string | null;
    bundleScopeManifest: string | null;
    releaseStatus: string | null;
    phase1ArtifactsConfirmed: boolean;
  }

  async function preparePhasePayloadInTx(
    tx: Tx,
    params: {
      orderId: number;
      orderPublicId: string;
      phase: ProductionPhase;
      existingRows: DispatchRow[];
      releaseStatusOverride?: string;
      requireExplicitP201Confirm: boolean;
      phase1ArtifactsConfirmed: boolean;
      bypassPaymentStageCheck?: boolean;
      action: DispatchActionKind;
    },
  ): Promise<{ ok: true; prepared: PreparedPhaseDispatch } | { ok: false; error: DomainError }> {
    const orders = requireOrders();
    const identity = requireIdentity();
    const { orderId, orderPublicId, phase, existingRows, action } = params;

    if (phase === "P101") {
      const candidate = await evaluateP101CandidateInTx(tx, orderId, params.releaseStatusOverride, {
        bypassPaymentStageCheck: params.bypassPaymentStageCheck,
      });
      if (!candidate.featureEnabled || !candidate.featureConfigured || !candidate.prodState.p101Secret) {
        await recordRefusedAuditInTx(tx, {
          phase: "P101",
          orderPublicId,
          reasonCode: "PRODUCTION_WEBHOOKS_NOT_ENABLED",
          packet: candidate.payload?.packet ?? null,
          tier: candidate.payload?.tier ?? null,
          bundleScopeManifest: candidate.payload?.bundle_scope_manifest ?? null,
          action,
        });
        return {
          ok: false,
          error: new DomainError(
            "NOT_CONFIGURED",
            "PRODUCTION_WEBHOOKS_NOT_ENABLED",
            "Production webhooks are disabled or incomplete.",
          ),
        };
      }
      if (candidate.validationErrors.length > 0 || !candidate.payload) {
        const first = candidate.validationErrors[0] ?? {
          code: "INVALID_P101_PAYLOAD",
          message: "Order failed Phase I (P101) validation.",
        };
        await recordRefusedAuditInTx(tx, {
          phase: "P101",
          orderPublicId,
          reasonCode: first.code,
          packet: candidate.payload?.packet ?? null,
          tier: candidate.payload?.tier ?? null,
          bundleScopeManifest: candidate.payload?.bundle_scope_manifest ?? null,
          action,
        });
        return {
          ok: false,
          error:
            first.code === "ORDER_LOCKED" ||
            first.code === "ORDER_CANCELED" ||
            first.code === "PAYMENT_NOT_CONFIRMED"
              ? conflict(first.code, first.message)
              : validation(first.code, first.message, {
                  error_codes: candidate.validationErrors.map((e) => e.code),
                }),
        };
      }

      const authHeaderValue =
        candidate.prodState.cfg.authHeaderName !== ""
          ? await readSecret(deps.settings, INTEGRATIONS_PRODUCTION_AUTH_VALUE, tx)
          : null;
      const destinationFingerprint = computeDestinationFingerprint("P101", {
        targetUrl: candidate.prodState.p101Secret,
        authHeaderName: candidate.prodState.cfg.authHeaderName,
        authHeaderValue,
        canonVersion: candidate.prodState.cfg.canonVersion,
        runMode: candidate.prodState.cfg.runMode,
        signingEnabled: candidate.prodState.cfg.signingEnabled,
        signingSecret: candidate.prodState.signingSecret,
      });

      const p = candidate.payload;
      return {
        ok: true,
        prepared: {
          orderReference: candidate.scope.reference,
          expectedOwnerUserId: candidate.scope.ownerUserId,
          destinationFingerprint,
          payloadObject: p,
          sentCustomerId: p.customer_id,
          sentOrderId: p.order_id,
          sentRunMode: p.run_mode,
          packet: p.packet,
          tier: p.tier,
          bundleScopeManifest: p.bundle_scope_manifest,
          releaseStatus: p.release_status,
          phase1ArtifactsConfirmed: false,
        },
      };
    }

    const [scope, prodState] = await Promise.all([
      orders.getProductionScope(orderId, { tx }),
      readProductionState(tx),
    ]);
    if (!scope) {
      throw notFound("ORDER_NOT_FOUND");
    }

    const targetSecret = targetSecretForPhase(prodState, phase);
    const label = phaseDisplayLabel(phase);

    if ((phase === "P301" || phase === "P401") && (!targetSecret || !isValidProductionWebhookUrl(targetSecret))) {
      await recordRefusedAuditInTx(tx, {
        phase,
        orderPublicId,
        reasonCode: "PRODUCTION_PHASE_ENDPOINT_NOT_CONFIGURED",
        action,
      });
      return {
        ok: false,
        error: new DomainError(
          "NOT_CONFIGURED",
          "PRODUCTION_PHASE_ENDPOINT_NOT_CONFIGURED",
          `${label} (${phase}) HTTPS destination URL is not configured.`,
        ),
      };
    }

    if (isOrderLockedForProduction(scope.lockState)) {
      await recordRefusedAuditInTx(tx, {
        phase,
        orderPublicId,
        reasonCode: "ORDER_LOCKED",
        action,
      });
      return {
        ok: false,
        error: conflict("ORDER_LOCKED", "This order is locked and cannot dispatch production webhooks."),
      };
    }

    if (isOrderCanceledStatus(scope.statusKey)) {
      await recordRefusedAuditInTx(tx, {
        phase,
        orderPublicId,
        reasonCode: "ORDER_CANCELED",
        action,
      });
      return {
        ok: false,
        error: conflict("ORDER_CANCELED", "Canceled orders cannot dispatch production webhooks."),
      };
    }

    const owner = await identity.getUser(scope.ownerUserId, { tx });
    if (!owner || owner.status !== "active") {
      await recordRefusedAuditInTx(tx, {
        phase,
        orderPublicId,
        reasonCode: "ORDER_OWNER_INACTIVE",
        action,
      });
      return {
        ok: false,
        error: validation(
          "ORDER_OWNER_INACTIVE",
          "The order owner account must be active to dispatch production webhooks.",
        ),
      };
    }

    if (phase === "P201") {
      const stagePre = await evaluateFormat3StagePreconditionsInTx(tx, orderPublicId);
      if (stagePre.isFormat3 && !stagePre.intakeLocked) {
        await recordRefusedAuditInTx(tx, {
          phase: "P201",
          orderPublicId,
          reasonCode: "PHASE1_INTAKE_NOT_LOCKED",
          action,
        });
        return {
          ok: false,
          error: conflict(
            "PHASE1_INTAKE_NOT_LOCKED",
            "Phase 1 (Intake) must be submitted and locked before Phase II (P201) can start.",
          ),
        };
      }
    }

    if (params.requireExplicitP201Confirm && phase === "P201" && params.phase1ArtifactsConfirmed !== true) {
      await recordRefusedAuditInTx(tx, {
        phase: "P201",
        orderPublicId,
        reasonCode: "PHASE1_ARTIFACTS_CONFIRMATION_REQUIRED",
        action,
      });
      return {
        ok: false,
        error: validation(
          "PHASE1_ARTIFACTS_CONFIRMATION_REQUIRED",
          "Confirm that the Phase I final artifacts exist before sending Phase II (P201).",
        ),
      };
    }

    if (!prodState.enabled || !prodState.configured || !targetSecret) {
      await recordRefusedAuditInTx(tx, {
        phase,
        orderPublicId,
        reasonCode: "PRODUCTION_WEBHOOKS_NOT_ENABLED",
        action,
      });
      return {
        ok: false,
        error: new DomainError(
          "NOT_CONFIGURED",
          "PRODUCTION_WEBHOOKS_NOT_ENABLED",
          "Production webhooks are disabled or incomplete.",
        ),
      };
    }

    const deliveredP101 = existingRows.find((r) => r.phase === "P101" && r.state === "delivered");
    if (!deliveredP101) {
      await recordRefusedAuditInTx(tx, {
        phase,
        orderPublicId,
        reasonCode: "PRODUCTION_P101_NOT_DELIVERED",
        action,
      });
      return {
        ok: false,
        error: conflict(
          "PRODUCTION_P101_NOT_DELIVERED",
          `${label} (${phase}) cannot run until Phase I (P101) has been delivered for this order.`,
        ),
      };
    }

    if (phase === "P301" || phase === "P401") {
      const deliveredP201 = existingRows.find((r) => r.phase === "P201" && r.state === "delivered");
      if (!deliveredP201) {
        await recordRefusedAuditInTx(tx, {
          phase,
          orderPublicId,
          reasonCode: "PRODUCTION_P201_NOT_DELIVERED",
          action,
        });
        return {
          ok: false,
          error: conflict(
            "PRODUCTION_P201_NOT_DELIVERED",
            `${label} (${phase}) cannot run until Phase II (P201) has been delivered for this order.`,
          ),
        };
      }
      if (phase === "P401" && prodState.p301UrlConfigured) {
        const deliveredP301 = existingRows.find((r) => r.phase === "P301" && r.state === "delivered");
        if (!deliveredP301) {
          await recordRefusedAuditInTx(tx, {
            phase: "P401",
            orderPublicId,
            reasonCode: "PRODUCTION_P301_NOT_DELIVERED",
            action,
          });
          return {
            ok: false,
            error: conflict(
              "PRODUCTION_P301_NOT_DELIVERED",
              "Phase IV (P401) cannot run until configured Phase III (P301) has been delivered for this order.",
            ),
          };
        }
      }
    }

    const payloadCheck = buildLaterPhaseFromDeliveredP101(phase, {
      customerId: deliveredP101.sentCustomerId,
      orderId: deliveredP101.sentOrderId,
      runMode: deliveredP101.sentRunMode,
    });
    if (!payloadCheck.ok) {
      const first = payloadCheck.errors[0]!;
      await recordRefusedAuditInTx(tx, {
        phase,
        orderPublicId,
        reasonCode: first.code,
        action,
      });
      return {
        ok: false,
        error: validation(first.code, first.message, {
          error_codes: payloadCheck.errors.map((e) => e.code),
        }),
      };
    }

    const authHeaderValue =
      prodState.cfg.authHeaderName !== ""
        ? await readSecret(deps.settings, INTEGRATIONS_PRODUCTION_AUTH_VALUE, tx)
        : null;
    const destinationFingerprint = computeDestinationFingerprint(phase, {
      targetUrl: targetSecret,
      authHeaderName: prodState.cfg.authHeaderName,
      authHeaderValue,
      canonVersion: prodState.cfg.canonVersion,
      runMode: prodState.cfg.runMode,
      signingEnabled: prodState.cfg.signingEnabled,
      signingSecret: prodState.signingSecret,
    });

    return {
      ok: true,
      prepared: {
        orderReference: deliveredP101.orderReference,
        expectedOwnerUserId: scope.ownerUserId,
        destinationFingerprint,
        payloadObject: payloadCheck.payload,
        sentCustomerId: payloadCheck.payload.customer_id,
        sentOrderId: payloadCheck.payload.order_id,
        sentRunMode: payloadCheck.payload.run_mode,
        packet: deliveredP101.packet ?? null,
        tier: deliveredP101.tier ?? null,
        bundleScopeManifest: deliveredP101.bundleScopeManifest ?? null,
        releaseStatus: null,
        phase1ArtifactsConfirmed: phase === "P201" ? params.phase1ArtifactsConfirmed : false,
      },
    };
  }

  /**
   * Reconstructs the exact original payload for `retry` / `redeliver` of a selected `targetRow`,
   * enforcing cryptographic byte-identity (`sha256Hex(JSON.stringify(payload)) === targetRow.payloadSha256`)
   * and refusing fail-closed if live order scope or verifiable payload inputs drifted.
   */
  async function reconstructExactDispatchPayloadInTx(
    tx: Tx,
    params: {
      orderId: number;
      orderPublicId: string;
      targetRow: DispatchRow;
      existingRows: DispatchRow[];
      action: "retry" | "redeliver" | "resend";
    },
  ): Promise<{ ok: true; prepared: PreparedPhaseDispatch } | { ok: false; error: DomainError }> {
    const orders = requireOrders();
    const identity = requireIdentity();
    const { orderId, orderPublicId, targetRow, existingRows, action } = params;
    const phase = targetRow.phase as ProductionPhase;
    const label = phaseDisplayLabel(phase);

    const [scope, prodState] = await Promise.all([
      orders.getProductionScope(orderId, { tx }),
      readProductionState(tx),
    ]);
    if (!scope) {
      throw notFound("ORDER_NOT_FOUND");
    }

    const targetSecret = targetSecretForPhase(prodState, phase);
    if ((phase === "P301" || phase === "P401") && (!targetSecret || !isValidProductionWebhookUrl(targetSecret))) {
      await recordRefusedAuditInTx(tx, {
        phase,
        orderPublicId,
        reasonCode: "PRODUCTION_PHASE_ENDPOINT_NOT_CONFIGURED",
        packet: targetRow.packet ?? null,
        tier: targetRow.tier ?? null,
        bundleScopeManifest: targetRow.bundleScopeManifest ?? null,
        action,
      });
      return {
        ok: false,
        error: new DomainError(
          "NOT_CONFIGURED",
          "PRODUCTION_PHASE_ENDPOINT_NOT_CONFIGURED",
          `${label} (${phase}) HTTPS destination URL is not configured.`,
        ),
      };
    }

    if (!prodState.enabled || !prodState.configured || !targetSecret || !isValidProductionWebhookUrl(targetSecret)) {
      await recordRefusedAuditInTx(tx, {
        phase,
        orderPublicId,
        reasonCode: "PRODUCTION_WEBHOOKS_NOT_ENABLED",
        packet: targetRow.packet ?? null,
        tier: targetRow.tier ?? null,
        bundleScopeManifest: targetRow.bundleScopeManifest ?? null,
        action,
      });
      return {
        ok: false,
        error: new DomainError(
          "NOT_CONFIGURED",
          "PRODUCTION_WEBHOOKS_NOT_ENABLED",
          "Production webhooks are disabled or incomplete.",
        ),
      };
    }

    if (isOrderLockedForProduction(scope.lockState)) {
      await recordRefusedAuditInTx(tx, {
        phase,
        orderPublicId,
        reasonCode: "ORDER_LOCKED",
        packet: targetRow.packet ?? null,
        tier: targetRow.tier ?? null,
        bundleScopeManifest: targetRow.bundleScopeManifest ?? null,
        action,
      });
      return {
        ok: false,
        error: conflict("ORDER_LOCKED", "This order is locked and cannot dispatch production webhooks."),
      };
    }

    if (isOrderCanceledStatus(scope.statusKey)) {
      await recordRefusedAuditInTx(tx, {
        phase,
        orderPublicId,
        reasonCode: "ORDER_CANCELED",
        packet: targetRow.packet ?? null,
        tier: targetRow.tier ?? null,
        bundleScopeManifest: targetRow.bundleScopeManifest ?? null,
        action,
      });
      return {
        ok: false,
        error: conflict("ORDER_CANCELED", "Canceled orders cannot dispatch production webhooks."),
      };
    }

    if (scope.ownerUserId !== targetRow.expectedOwnerUserId) {
      await recordRefusedAuditInTx(tx, {
        phase,
        orderPublicId,
        reasonCode: "ORDER_OWNER_CHANGED",
        packet: targetRow.packet ?? null,
        tier: targetRow.tier ?? null,
        bundleScopeManifest: targetRow.bundleScopeManifest ?? null,
        action,
      });
      return {
        ok: false,
        error: conflict(
          "ORDER_OWNER_CHANGED",
          "The order owner changed since the selected dispatch was created; replay is refused.",
        ),
      };
    }

    const owner = await identity.getUser(scope.ownerUserId, { tx });
    if (!owner || owner.status !== "active") {
      await recordRefusedAuditInTx(tx, {
        phase,
        orderPublicId,
        reasonCode: "ORDER_OWNER_INACTIVE",
        packet: targetRow.packet ?? null,
        tier: targetRow.tier ?? null,
        bundleScopeManifest: targetRow.bundleScopeManifest ?? null,
        action,
      });
      return {
        ok: false,
        error: validation(
          "ORDER_OWNER_INACTIVE",
          "The order owner account must be active to dispatch production webhooks.",
        ),
      };
    }

    // Verify order reference & packet scope parity against `targetRow` before reconstructing payload bytes.
    const scopeProbe = buildP101Payload({
      customerRef: "CUST-SCOPE-PROBE",
      orderReference: scope.reference,
      canonVersion: "canon-scope-probe",
      runMode: "production",
      clientName: "Scope Probe",
      clientEmail: "scope-probe@example.test",
      releaseStatus: "",
      packets: scope.packets,
      otherItemCount: scope.otherItemCount,
    });
    const orderReferenceMatches =
      scope.reference === targetRow.orderReference &&
      (phase !== "P101" || scope.reference === targetRow.sentOrderId);
    const packetScopeMatches =
      targetRow.bundleScopeManifest === null
        ? true
        : scopeProbe.ok &&
          scopeProbe.payload !== null &&
          scopeProbe.payload.packet === targetRow.packet &&
          scopeProbe.payload.tier === targetRow.tier &&
          scopeProbe.payload.bundle_scope_manifest === targetRow.bundleScopeManifest;

    if (!orderReferenceMatches || !packetScopeMatches) {
      await recordRefusedAuditInTx(tx, {
        phase,
        orderPublicId,
        reasonCode: "ORDER_SCOPE_CHANGED",
        packet: targetRow.packet ?? null,
        tier: targetRow.tier ?? null,
        bundleScopeManifest: targetRow.bundleScopeManifest ?? null,
        action,
      });
      return {
        ok: false,
        error: conflict(
          "ORDER_SCOPE_CHANGED",
          "The order reference or packet scope changed since the selected dispatch was created; replay is refused.",
        ),
      };
    }

    const authHeaderValue =
      prodState.cfg.authHeaderName !== ""
        ? await readSecret(deps.settings, INTEGRATIONS_PRODUCTION_AUTH_VALUE, tx)
        : null;
    const destinationFingerprint = computeDestinationFingerprint(phase, {
      targetUrl: targetSecret,
      authHeaderName: prodState.cfg.authHeaderName,
      authHeaderValue,
      canonVersion: prodState.cfg.canonVersion,
      runMode: prodState.cfg.runMode,
      signingEnabled: prodState.cfg.signingEnabled,
      signingSecret: prodState.signingSecret,
    });

    if (phase === "P101") {
      const liveP101 = buildP101Payload({
        customerRef: owner.customerRef ?? null,
        orderReference: scope.reference,
        canonVersion: prodState.cfg.canonVersion,
        runMode: prodState.cfg.runMode,
        clientName: owner.name,
        clientEmail: owner.email,
        releaseStatus: targetRow.releaseStatus ?? "",
        packets: scope.packets,
        otherItemCount: scope.otherItemCount,
      });
      if (
        !liveP101.ok ||
        !liveP101.payload ||
        liveP101.payload.customer_id !== targetRow.sentCustomerId ||
        liveP101.payload.order_id !== targetRow.sentOrderId ||
        liveP101.payload.run_mode !== targetRow.sentRunMode ||
        sha256Hex(JSON.stringify(liveP101.payload)) !== targetRow.payloadSha256
      ) {
        await recordRefusedAuditInTx(tx, {
          phase: "P101",
          orderPublicId,
          reasonCode: "ORIGINAL_PAYLOAD_UNVERIFIABLE",
          packet: targetRow.packet ?? null,
          tier: targetRow.tier ?? null,
          bundleScopeManifest: targetRow.bundleScopeManifest ?? null,
          action,
        });
        return {
          ok: false,
          error: conflict(
            "ORIGINAL_PAYLOAD_UNVERIFIABLE",
            "Original Phase I (P101) payload bytes no longer match current customer or pipeline metadata; start a new order workflow or restore the original values.",
          ),
        };
      }

      const p = liveP101.payload;
      return {
        ok: true,
        prepared: {
          orderReference: targetRow.orderReference,
          expectedOwnerUserId: targetRow.expectedOwnerUserId,
          destinationFingerprint,
          payloadObject: p,
          sentCustomerId: p.customer_id,
          sentOrderId: p.order_id,
          sentRunMode: p.run_mode,
          packet: p.packet,
          tier: p.tier,
          bundleScopeManifest: p.bundle_scope_manifest,
          releaseStatus: p.release_status,
          phase1ArtifactsConfirmed: false,
        },
      };
    }

    const deliveredP101 = existingRows.find((r) => r.phase === "P101" && r.state === "delivered");
    if (!deliveredP101) {
      await recordRefusedAuditInTx(tx, {
        phase,
        orderPublicId,
        reasonCode: "PRODUCTION_P101_NOT_DELIVERED",
        packet: targetRow.packet ?? null,
        tier: targetRow.tier ?? null,
        bundleScopeManifest: targetRow.bundleScopeManifest ?? null,
        action,
      });
      return {
        ok: false,
        error: conflict(
          "PRODUCTION_P101_NOT_DELIVERED",
          `${label} (${phase}) cannot run until Phase I (P101) has been delivered for this order.`,
        ),
      };
    }

    if (phase === "P301" || phase === "P401") {
      const deliveredP201 = existingRows.find((r) => r.phase === "P201" && r.state === "delivered");
      if (!deliveredP201) {
        await recordRefusedAuditInTx(tx, {
          phase,
          orderPublicId,
          reasonCode: "PRODUCTION_P201_NOT_DELIVERED",
          packet: targetRow.packet ?? null,
          tier: targetRow.tier ?? null,
          bundleScopeManifest: targetRow.bundleScopeManifest ?? null,
          action,
        });
        return {
          ok: false,
          error: conflict(
            "PRODUCTION_P201_NOT_DELIVERED",
            `${label} (${phase}) cannot run until Phase II (P201) has been delivered for this order.`,
          ),
        };
      }
      if (phase === "P401" && prodState.p301UrlConfigured) {
        const deliveredP301 = existingRows.find((r) => r.phase === "P301" && r.state === "delivered");
        if (!deliveredP301) {
          await recordRefusedAuditInTx(tx, {
            phase: "P401",
            orderPublicId,
            reasonCode: "PRODUCTION_P301_NOT_DELIVERED",
            packet: targetRow.packet ?? null,
            tier: targetRow.tier ?? null,
            bundleScopeManifest: targetRow.bundleScopeManifest ?? null,
            action,
          });
          return {
            ok: false,
            error: conflict(
              "PRODUCTION_P301_NOT_DELIVERED",
              "Phase IV (P401) cannot run until configured Phase III (P301) has been delivered for this order.",
            ),
          };
        }
      }
    }

    // Reconstruct directly from the selected `targetRow` (never from `newestDeliveredP101` or mutated settings/customer fields)
    // and enforce exact SHA-256 byte-identity against `targetRow.payloadSha256`.
    const payloadCheck = buildLaterPhaseFromDeliveredP101(phase, {
      customerId: targetRow.sentCustomerId,
      orderId: targetRow.sentOrderId,
      runMode: targetRow.sentRunMode,
    });
    if (
      !payloadCheck.ok ||
      sha256Hex(JSON.stringify(payloadCheck.payload)) !== targetRow.payloadSha256
    ) {
      await recordRefusedAuditInTx(tx, {
        phase,
        orderPublicId,
        reasonCode: "ORIGINAL_PAYLOAD_UNVERIFIABLE",
        packet: targetRow.packet ?? null,
        tier: targetRow.tier ?? null,
        bundleScopeManifest: targetRow.bundleScopeManifest ?? null,
        action,
      });
      return {
        ok: false,
        error: conflict(
          "ORIGINAL_PAYLOAD_UNVERIFIABLE",
          `Original ${label} (${phase}) payload bytes could not be verified against the stored SHA-256 digest; replay is refused.`,
        ),
      };
    }

    return {
      ok: true,
      prepared: {
        orderReference: targetRow.orderReference,
        expectedOwnerUserId: targetRow.expectedOwnerUserId,
        destinationFingerprint,
        payloadObject: payloadCheck.payload,
        sentCustomerId: payloadCheck.payload.customer_id,
        sentOrderId: payloadCheck.payload.order_id,
        sentRunMode: payloadCheck.payload.run_mode,
        packet: targetRow.packet ?? null,
        tier: targetRow.tier ?? null,
        bundleScopeManifest: targetRow.bundleScopeManifest ?? null,
        releaseStatus: targetRow.releaseStatus ?? null,
        phase1ArtifactsConfirmed:
          phase === "P201" ? true : Boolean(targetRow.phase1ArtifactsConfirmed),
      },
    };
  }

  async function requestOptionalLaterPhase(
    principal: SessionPrincipal,
    orderPublicId: string,
    phase: "P301" | "P401",
  ): Promise<ProductionDispatchItem> {
    assertProductionTriggerPreflight(principal);
    const orders = requireOrders();
    await reconcileStaleDispatches({
      orderPublicId,
      verifyCallerBeforeMutate: () => verifyOrderTriggerCaller(principal, orderPublicId),
    });

    const label = phaseDisplayLabel(phase);
    const outcome = await deps.db.transaction(
      async (tx): Promise<{ ok: true; item: ProductionDispatchItem } | { ok: false; error: DomainError }> => {
        // PW-05: Lock order row FOR UPDATE FIRST, then lock/revalidate Identity actor SECOND.
        const access = await orders.assertCanReadOrder(principal, orderPublicId, {
          tx,
          forUpdate: true,
        });
        await assertProductionTriggerInTx(deps, principal, tx);

        const existingRows = await tx
          .select()
          .from(integrationProductionDispatches)
          .where(eq(integrationProductionDispatches.orderId, access.id))
          .for("update")
          .orderBy(desc(integrationProductionDispatches.id));

        const prep = await preparePhasePayloadInTx(tx, {
          orderId: access.id,
          orderPublicId: access.publicId,
          phase,
          existingRows,
          requireExplicitP201Confirm: false,
          phase1ArtifactsConfirmed: false,
          action: "request",
        });
        if (!prep.ok) {
          return prep;
        }

        const existingPhase = existingRows.filter((r) => r.phase === phase);
        if (existingPhase.some((r) => r.state === "queued" || r.state === "sending")) {
          throw conflict(
            "PRODUCTION_DISPATCH_IN_PROGRESS",
            `A ${label} (${phase}) dispatch is already queued or sending for this order.`,
          );
        }
        if (existingPhase.some((r) => r.state === "delivered")) {
          throw conflict(
            `PRODUCTION_${phase}_ALREADY_DELIVERED`,
            `${label} (${phase}) has already been delivered for this order. Re-delivering requires an administrator with step-up authentication, a reason, and REDELIVER confirmation.`,
          );
        }
        if (existingPhase.length > 0) {
          throw conflict(
            "PRODUCTION_RESEND_REQUIRED",
            `A prior ${label} (${phase}) attempt already ran for this order; use Retry in pipeline history.`,
          );
        }

        const item = await enqueueDispatchInTx(tx, {
          principal,
          orderId: access.id,
          orderPublicId: access.publicId,
          orderReference: prep.prepared.orderReference,
          expectedOwnerUserId: prep.prepared.expectedOwnerUserId,
          destinationFingerprint: prep.prepared.destinationFingerprint,
          phase,
          payloadObject: prep.prepared.payloadObject,
          sentCustomerId: prep.prepared.sentCustomerId,
          sentOrderId: prep.prepared.sentOrderId,
          sentRunMode: prep.prepared.sentRunMode,
          packet: prep.prepared.packet,
          tier: prep.prepared.tier,
          bundleScopeManifest: prep.prepared.bundleScopeManifest,
          releaseStatus: prep.prepared.releaseStatus,
          isResend: false,
          resendReasonCode: null,
          dispatchKind: "request",
          phase1ArtifactsConfirmed: false,
        });
        return { ok: true, item };
      },
    );

    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.item;
  }

  return {
    getSettings: loadSettingsView,

    async updateSettings(principal, input): Promise<ProductionSettingsView> {
      const now = deps.clock.now();
      assertIntegrationsManagePreflight(principal, now);

      const currentCfg = await readSetting(deps.settings, INTEGRATIONS_PRODUCTION_CONFIG);
      const canonVersion = input.canonVersion.trim();
      if (canonVersion !== "" && (!CANON_VERSION_PATTERN.test(canonVersion) || !hasNoHeaderInjection(canonVersion))) {
        throw validation(
          "INVALID_CANON_VERSION",
          "Canon version must start with an alphanumeric character and contain only letters, numbers, '.', '_', ':' or '-'.",
        );
      }
      if (input.enabled && canonVersion === "") {
        throw validation(
          "CANON_VERSION_REQUIRED",
          "Configure an explicit canon version before enabling production webhooks.",
        );
      }

      const runMode = (input.runMode ?? currentCfg.runMode).trim();
      if (!RUN_MODE_PATTERN.test(runMode)) {
        throw validation("INVALID_RUN_MODE", "Run mode must match ^[a-z][a-z0-9_]{0,31}$.");
      }

      const timeoutMs = input.timeoutMs ?? currentCfg.timeoutMs;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
        throw validation("INVALID_TIMEOUT_MS", "Request timeout must be between 1000 and 30000 milliseconds.");
      }

      const authHeaderName = (input.authHeaderName ?? currentCfg.authHeaderName).trim();
      if (!isValidProductionAuthHeaderName(authHeaderName)) {
        throw validation(
          "INVALID_AUTH_HEADER_NAME",
          "Enter a valid custom HTTP header name (standard hop-by-hop and portal delivery headers are reserved).",
        );
      }

      if (typeof input.p101Url === "string" && !isValidProductionWebhookUrl(input.p101Url.trim())) {
        throw validation(
          "INVALID_P101_URL",
          "Phase I (P101) URL must be a valid HTTPS URL without embedded credentials.",
        );
      }
      if (typeof input.p201Url === "string" && !isValidProductionWebhookUrl(input.p201Url.trim())) {
        throw validation(
          "INVALID_P201_URL",
          "Phase II (P201) URL must be a valid HTTPS URL without embedded credentials.",
        );
      }
      if (typeof input.p301Url === "string" && !isValidProductionWebhookUrl(input.p301Url.trim())) {
        throw validation(
          "INVALID_P301_URL",
          "Phase III (P301) URL must be a valid HTTPS URL without embedded credentials.",
        );
      }
      if (typeof input.p401Url === "string" && !isValidProductionWebhookUrl(input.p401Url.trim())) {
        throw validation(
          "INVALID_P401_URL",
          "Phase IV (P401) URL must be a valid HTTPS URL without embedded credentials.",
        );
      }
      if (typeof input.authHeaderValue === "string") {
        if (
          input.authHeaderValue.length === 0 ||
          input.authHeaderValue.length > 1024 ||
          !hasNoHeaderInjection(input.authHeaderValue)
        ) {
          throw validation(
            "INVALID_AUTH_HEADER_VALUE",
            "Authentication header value must be 1 to 1024 printable characters without control characters.",
          );
        }
      }

      await deps.db.transaction(async (tx) => {
        await assertIntegrationsManageInTx(deps, principal, tx);

        const [currentCfg, existingP101, existingP201, existingP301, existingP401, existingAuthVal] =
          await Promise.all([
            readSetting(deps.settings, INTEGRATIONS_PRODUCTION_CONFIG, tx),
            isSecretConfigured(deps.settings, INTEGRATIONS_PRODUCTION_P101_URL, tx),
            isSecretConfigured(deps.settings, INTEGRATIONS_PRODUCTION_P201_URL, tx),
            isSecretConfigured(deps.settings, INTEGRATIONS_PRODUCTION_P301_URL, tx),
            isSecretConfigured(deps.settings, INTEGRATIONS_PRODUCTION_P401_URL, tx),
            isSecretConfigured(deps.settings, INTEGRATIONS_PRODUCTION_AUTH_VALUE, tx),
          ]);

        const nextP101Configured = input.p101Url === undefined ? existingP101 : input.p101Url !== null;
        const nextP201Configured = input.p201Url === undefined ? existingP201 : input.p201Url !== null;
        const nextP301Configured = input.p301Url === undefined ? existingP301 : input.p301Url !== null;
        const nextP401Configured = input.p401Url === undefined ? existingP401 : input.p401Url !== null;
        const nextAuthValConfigured =
          input.authHeaderValue === undefined ? existingAuthVal : input.authHeaderValue !== null;

        if (input.enabled) {
          if (!nextP101Configured || !nextP201Configured) {
            throw validation(
              "PRODUCTION_URLS_REQUIRED",
              "Configure both Phase I (P101) and Phase II (P201) HTTPS URLs before enabling production webhooks.",
            );
          }
          if (authHeaderName !== "" && !nextAuthValConfigured) {
            throw validation(
              "PRODUCTION_AUTH_VALUE_REQUIRED",
              "Configure the authentication header value or clear the authentication header name before enabling.",
            );
          }
        }

        if (input.p101Url !== undefined) {
          await deps.settings.setSecret(
            INTEGRATIONS_PRODUCTION_P101_URL.key,
            input.p101Url === null ? null : input.p101Url.trim(),
            tx,
          );
        }
        if (input.p201Url !== undefined) {
          await deps.settings.setSecret(
            INTEGRATIONS_PRODUCTION_P201_URL.key,
            input.p201Url === null ? null : input.p201Url.trim(),
            tx,
          );
        }
        if (input.p301Url !== undefined) {
          await deps.settings.setSecret(
            INTEGRATIONS_PRODUCTION_P301_URL.key,
            input.p301Url === null ? null : input.p301Url.trim(),
            tx,
          );
        }
        if (input.p401Url !== undefined) {
          await deps.settings.setSecret(
            INTEGRATIONS_PRODUCTION_P401_URL.key,
            input.p401Url === null ? null : input.p401Url.trim(),
            tx,
          );
        }
        if (input.authHeaderValue !== undefined) {
          await deps.settings.setSecret(
            INTEGRATIONS_PRODUCTION_AUTH_VALUE.key,
            input.authHeaderValue === null ? null : input.authHeaderValue,
            tx,
          );
        }

        await writeSetting(
          deps.settings,
          INTEGRATIONS_PRODUCTION_CONFIG,
          {
            canonVersion,
            runMode,
            timeoutMs,
            authHeaderName,
            signingEnabled: currentCfg.signingEnabled,
            signingSecretLast4: currentCfg.signingSecretLast4,
            previousSigningSecretExpiresAt: currentCfg.previousSigningSecretExpiresAt,
          },
          tx,
        );
        await deps.settings.set(flagKey(INTEGRATIONS_PRODUCTION_FLAG.flag), input.enabled, tx);

        if (
          input.p101Url !== undefined ||
          input.p201Url !== undefined ||
          input.p301Url !== undefined ||
          input.p401Url !== undefined
        ) {
          await checks.clearVerification("production", tx);
        }

        // PW-07: Never emit `auth_header_name` in audit attributes — record booleans only.
        await deps.audit.record(
          {
            category: "integration",
            eventName: "integration.production.settings.changed",
            action: "update",
            outcome: "completed",
            severity: "INFO",
            provider: "production_webhook",
            resource: { type: "integration_provider", publicId: "production" },
            attributes: {
              enabled: input.enabled,
              canon_version: canonVersion,
              run_mode: runMode,
              timeout_ms: timeoutMs,
              p101_url_configured: nextP101Configured,
              p201_url_configured: nextP201Configured,
              p301_url_configured: nextP301Configured,
              p401_url_configured: nextP401Configured,
              auth_header_configured: authHeaderName !== "",
              auth_header_value_configured: nextAuthValConfigured,
            },
          },
          tx,
        );
      });

      return loadSettingsView();
    },

    async rotateSigningSecret(
      principal,
      input = {},
    ): Promise<{ settings: ProductionSettingsView; signingSecretOnce: string }> {
      const checkedAt = deps.clock.now();
      assertIntegrationsManagePreflight(principal, checkedAt);
      const overlapMinutes = Math.min(Math.max(Math.trunc(input.overlapMinutes ?? 1440), 0), 10_080);
      const { secret: nextSecret, last4: nextLast4 } = generateWebhookSigningSecret();

      await deps.db.transaction(async (tx) => {
        await assertIntegrationsManageInTx(deps, principal, tx);
        const [currentCfg, existingSecret] = await Promise.all([
          readSetting(deps.settings, INTEGRATIONS_PRODUCTION_CONFIG, tx),
          readSecret(deps.settings, INTEGRATIONS_PRODUCTION_SIGNING_SECRET, tx),
        ]);
        const txNow = deps.clock.now();
        let previousSigningSecretExpiresAt: string | null = null;
        if (existingSecret && overlapMinutes > 0) {
          await deps.settings.setSecret(INTEGRATIONS_PRODUCTION_SIGNING_PREV_SECRET.key, existingSecret, tx);
          previousSigningSecretExpiresAt = new Date(
            txNow.getTime() + overlapMinutes * 60_000,
          ).toISOString();
        } else {
          await deps.settings.setSecret(INTEGRATIONS_PRODUCTION_SIGNING_PREV_SECRET.key, null, tx);
        }

        await deps.settings.setSecret(INTEGRATIONS_PRODUCTION_SIGNING_SECRET.key, nextSecret, tx);
        await writeSetting(
          deps.settings,
          INTEGRATIONS_PRODUCTION_CONFIG,
          {
            ...currentCfg,
            signingSecretLast4: nextLast4,
            previousSigningSecretExpiresAt,
          },
          tx,
        );

        await deps.audit.record(
          {
            category: "integration",
            eventName: "integration.production.signing_secret_rotated",
            action: "rotate_secret",
            outcome: "completed",
            severity: "WARN",
            provider: "production_webhook",
            resource: { type: "integration_provider", publicId: "production" },
            attributes: {
              signing_enabled: currentCfg.signingEnabled,
              overlap_minutes: overlapMinutes,
              previous_retained: Boolean(existingSecret && overlapMinutes > 0),
            },
          },
          tx,
        );
      });

      const settings = await loadSettingsView();
      return { settings, signingSecretOnce: nextSecret };
    },

    async setSigningEnabled(principal, input): Promise<ProductionSettingsView> {
      const checkedAt = deps.clock.now();
      assertIntegrationsManagePreflight(principal, checkedAt);

      await deps.db.transaction(async (tx) => {
        await assertIntegrationsManageInTx(deps, principal, tx);
        const [currentCfg, secretConfigured] = await Promise.all([
          readSetting(deps.settings, INTEGRATIONS_PRODUCTION_CONFIG, tx),
          isSecretConfigured(deps.settings, INTEGRATIONS_PRODUCTION_SIGNING_SECRET, tx),
        ]);
        if (input.enabled && !secretConfigured) {
          throw validation(
            "PRODUCTION_SIGNING_SECRET_REQUIRED",
            "Generate a production webhook signing secret before enabling HMAC payload signing.",
          );
        }

        await writeSetting(
          deps.settings,
          INTEGRATIONS_PRODUCTION_CONFIG,
          {
            ...currentCfg,
            signingEnabled: input.enabled,
          },
          tx,
        );

        await deps.audit.record(
          {
            category: "integration",
            eventName: "integration.production.signing_updated",
            action: "update",
            outcome: "completed",
            severity: "INFO",
            provider: "production_webhook",
            resource: { type: "integration_provider", publicId: "production" },
            attributes: {
              signing_enabled: input.enabled,
              signing_secret_configured: secretConfigured,
            },
          },
          tx,
        );
      });

      return loadSettingsView();
    },

    async listWorkflowAutoQueue(principal): Promise<{ items: WorkflowAutoQueueItemView[] }> {
      if (principal.state !== "full" || principal.pendingSteps.length > 0) {
        throw new DomainError(
          "REMEDIATION_REQUIRED",
          "ACCOUNT_STEP_PENDING",
          "Please finish securing your account to continue.",
        );
      }
      if (principal.role !== "admin") {
        throw forbidden("ADMIN_REQUIRED");
      }
      const orders = requireOrders();
      const [workflows, map] = await Promise.all([
        orders.workflows?.list ? orders.workflows.list() : Promise.resolve([]),
        readSetting(deps.settings, INTEGRATIONS_PRODUCTION_WORKFLOW_AUTO_QUEUE),
      ]);
      const items: WorkflowAutoQueueItemView[] = workflows.map((wf) => {
        const entry =
          map[wf.publicId] ??
          map[wf.workflowKey] ??
          Object.values(map).find((v) => v.workflowKey === wf.workflowKey);
        return {
          workflowPublicId: wf.publicId,
          workflowKey: wf.workflowKey,
          workflowName: wf.name,
          isDefault: wf.isDefault,
          p101OnPaymentConfirmed: entry?.p101OnPaymentConfirmed ?? false,
          p201OnPhase1Locked: entry?.p201OnPhase1Locked ?? false,
          updatedAt: entry?.updatedAt ? new Date(entry.updatedAt) : null,
        };
      });
      return { items };
    },

    async setWorkflowAutoQueue(principal, input): Promise<{ items: WorkflowAutoQueueItemView[] }> {
      const checkedAt = deps.clock.now();
      assertIntegrationsManagePreflight(principal, checkedAt);
      const orders = requireOrders();
      const workflows = orders.workflows?.list ? await orders.workflows.list() : [];
      const targetWf = workflows.find(
        (wf) =>
          (input.workflowPublicId && wf.publicId === input.workflowPublicId) ||
          (input.workflowKey && wf.workflowKey === input.workflowKey),
      );
      if (!targetWf) {
        throw notFound("WORKFLOW_NOT_FOUND");
      }

      await deps.db.transaction(async (tx) => {
        await assertIntegrationsManageInTx(deps, principal, tx);
        const currentMap = await readSetting(deps.settings, INTEGRATIONS_PRODUCTION_WORKFLOW_AUTO_QUEUE, tx);
        const txNowIso = deps.clock.now().toISOString();
        const nextMap = {
          ...currentMap,
          [targetWf.publicId]: {
            workflowKey: targetWf.workflowKey,
            p101OnPaymentConfirmed: input.p101OnPaymentConfirmed,
            p201OnPhase1Locked: input.p201OnPhase1Locked,
            updatedAt: txNowIso,
          },
        };
        await writeSetting(deps.settings, INTEGRATIONS_PRODUCTION_WORKFLOW_AUTO_QUEUE, nextMap, tx);

        await deps.audit.record(
          {
            category: "integration",
            eventName: "integration.production.workflow_auto_queue_updated",
            action: "update",
            outcome: "completed",
            severity: "INFO",
            provider: "production_webhook",
            resource: { type: "order_workflow", publicId: targetWf.publicId },
            attributes: {
              workflow_public_id: targetWf.publicId,
              workflow_key: targetWf.workflowKey,
              p101_on_payment_confirmed: input.p101OnPaymentConfirmed,
              p201_on_phase1_locked: input.p201OnPhase1Locked,
            },
          },
          tx,
        );
      });

      const updatedMap = await readSetting(deps.settings, INTEGRATIONS_PRODUCTION_WORKFLOW_AUTO_QUEUE);
      return {
        items: workflows.map((wf) => {
          const entry = updatedMap[wf.publicId];
          return {
            workflowPublicId: wf.publicId,
            workflowKey: wf.workflowKey,
            workflowName: wf.name,
            isDefault: wf.isDefault,
            p101OnPaymentConfirmed: entry?.p101OnPaymentConfirmed ?? false,
            p201OnPhase1Locked: entry?.p201OnPhase1Locked ?? false,
            updatedAt: entry?.updatedAt ? new Date(entry.updatedAt) : null,
          };
        }),
      };
    },

    async getWorkflowAutoQueueForOrderInTx(orderPublicId, tx) {
      const orders = requireOrders();
      if (!orders.stages?.contextForRun || !orders.workflows?.byVersionId) {
        return {
          workflowPublicId: null,
          p101OnPaymentConfirmed: false,
          p201OnPhase1Locked: false,
          intakeStageKey: null,
        };
      }
      const ctx = await orders.stages.contextForRun(orderPublicId, tx);
      const [bound, map] = await Promise.all([
        orders.workflows.byVersionId(tx, ctx.workflowVersionId),
        readSetting(deps.settings, INTEGRATIONS_PRODUCTION_WORKFLOW_AUTO_QUEUE, tx),
      ]);
      const intakeStage =
        ctx.stages.find((s) => s.key === "phase_1_intake") ??
        ctx.stages.find((s) => s.progression === "submit_lock") ??
        null;

      let matchedPublicId: string | null = null;
      let matchedEntry = Object.entries(map).find(([, v]) => v.workflowKey === bound.workflowKey);
      if (matchedEntry) {
        matchedPublicId = matchedEntry[0];
      } else if (orders.workflows.list) {
        const workflows = await orders.workflows.list();
        const wf = workflows.find((w) => w.workflowKey === bound.workflowKey);
        if (wf) {
          matchedPublicId = wf.publicId;
          const byId = map[wf.publicId];
          if (byId) {
            matchedEntry = [wf.publicId, byId];
          }
        }
      }

      return {
        workflowPublicId: matchedPublicId,
        p101OnPaymentConfirmed: matchedEntry?.[1].p101OnPaymentConfirmed ?? false,
        p201OnPhase1Locked: matchedEntry?.[1].p201OnPhase1Locked ?? false,
        intakeStageKey: intakeStage?.key ?? null,
      };
    },

    async enqueueWorkflowDispatch(input, tx): Promise<EnqueueWorkflowProductionDispatchResult> {
      const orders = requireOrders();
      const orderRef = await orders.getOrderRefByPublicId(input.orderPublicId, tx, { forUpdate: true });
      if (!orderRef) {
        return {
          outcome: "refused_precondition",
          dispatchPublicId: null,
          reasonCode: "ORDER_NOT_FOUND",
          message: "Order was not found.",
        };
      }

      const prodState = await readProductionState(tx);
      const endpointConfigured = phaseUrlConfigured(prodState, input.phase);
      if (!prodState.enabled || !prodState.configured || !endpointConfigured) {
        await recordRefusedAuditInTx(tx, {
          phase: input.phase,
          orderPublicId: orderRef.publicId,
          reasonCode: "PRODUCTION_WEBHOOKS_NOT_ENABLED",
          extraAttrs: {
            trigger_source: input.triggerSource,
            stage_key: input.stageKey,
          },
        });
        return {
          outcome: "disabled",
          dispatchPublicId: null,
          reasonCode: "PRODUCTION_WEBHOOKS_NOT_ENABLED",
          message: `Production webhook ${input.phase} is disabled or not configured.`,
        };
      }

      const existingRows = await tx
        .select()
        .from(integrationProductionDispatches)
        .where(eq(integrationProductionDispatches.orderId, orderRef.id))
        .for("update")
        .orderBy(desc(integrationProductionDispatches.id));

      const phaseRows = existingRows.filter((r) => r.phase === input.phase);
      const existingActiveOrDelivered = phaseRows.find(
        (r) => r.state === "queued" || r.state === "sending" || r.state === "delivered",
      );
      if (existingActiveOrDelivered) {
        return {
          outcome: "already_queued_or_delivered",
          dispatchPublicId: existingActiveOrDelivered.publicId,
          reasonCode:
            existingActiveOrDelivered.state === "delivered"
              ? `PRODUCTION_${input.phase}_ALREADY_DELIVERED`
              : "PRODUCTION_DISPATCH_IN_PROGRESS",
          message: `${input.phase} is already ${existingActiveOrDelivered.state} for this order.`,
        };
      }
      if (phaseRows.length > 0) {
        return {
          outcome: "refused_precondition",
          dispatchPublicId: phaseRows[0]!.publicId,
          reasonCode: "PRODUCTION_PRIOR_ATTEMPT_EXISTS",
          message: `A prior ${input.phase} attempt ended in ${phaseRows[0]!.state}; operator retry or re-send is required.`,
        };
      }

      const prep = await preparePhasePayloadInTx(tx, {
        orderId: orderRef.id,
        orderPublicId: orderRef.publicId,
        phase: input.phase,
        existingRows,
        releaseStatusOverride: input.releaseStatus ?? undefined,
        requireExplicitP201Confirm: false,
        phase1ArtifactsConfirmed: true,
        bypassPaymentStageCheck: input.bypassPaymentStageCheck,
        action: "request",
      });
      if (!prep.ok) {
        return {
          outcome: "refused_precondition",
          dispatchPublicId: null,
          reasonCode: prep.error.reasonCode,
          message: prep.error.message,
        };
      }

      const item = await enqueueDispatchInTx(tx, {
        principal: input.actor,
        orderId: orderRef.id,
        orderPublicId: orderRef.publicId,
        orderReference: prep.prepared.orderReference,
        expectedOwnerUserId: prep.prepared.expectedOwnerUserId,
        destinationFingerprint: prep.prepared.destinationFingerprint,
        phase: input.phase,
        payloadObject: prep.prepared.payloadObject,
        sentCustomerId: prep.prepared.sentCustomerId,
        sentOrderId: prep.prepared.sentOrderId,
        sentRunMode: prep.prepared.sentRunMode,
        packet: prep.prepared.packet,
        tier: prep.prepared.tier,
        bundleScopeManifest: prep.prepared.bundleScopeManifest,
        releaseStatus: prep.prepared.releaseStatus,
        isResend: false,
        resendReasonCode: null,
        phase1ArtifactsConfirmed: prep.prepared.phase1ArtifactsConfirmed,
        triggerSource: input.triggerSource,
        stageKey: input.stageKey,
        correlationIdOverride: input.correlationId,
      });

      return {
        outcome: "queued",
        dispatchPublicId: item.publicId,
        reasonCode: null,
        message: null,
      };
    },

    async getTargetStatus(phase, tx) {
      const prodState = await readProductionState(tx);
      return {
        enabled: prodState.enabled,
        configured: prodState.configured,
        endpointConfigured: phaseUrlConfigured(prodState, phase),
      };
    },

    async testDestination(principal, input): Promise<ProductionDryRunResult> {
      const checkedAt = deps.clock.now();
      assertIntegrationsManagePreflight(principal, checkedAt);

      // Re-validate actor in-transaction before resolving any destination DNS.
      await deps.db.transaction(async (tx) => {
        await assertIntegrationsManageInTx(deps, principal, tx);
      });

      const secretDef = secretDefForPhase(input.phase);
      const targetUrl = await readSecret(deps.settings, secretDef);

      if (!targetUrl) {
        return {
          phase: input.phase,
          allowed: false,
          reasonCode: "URL_NOT_CONFIGURED",
          safeMessage: `No ${input.phase} destination URL is saved.`,
          host: null,
          resolvedAddresses: [],
          matchedAllowlistRulePublicId: null,
          checkedAt,
        };
      }

      let safeHost: string | null;
      try {
        safeHost = new URL(targetUrl).hostname;
      } catch {
        safeHost = null;
      }

      try {
        // Dry-run ONLY: resolves DNS + checks allowlist + checks public-only IPs in one evaluation; sends NO HTTP request
        // and NEVER projects `normalizedUrl` back to the caller.
        const pinned = await egress.resolveAndAssertAllowed({
          url: targetUrl,
          purpose: "webhook",
          allowedSchemes: ["https:"],
          requireAllowlistRule: true,
          publicAddressesOnly: true,
        });

        await checks.recordOutcome("production", "succeeded", "DRY_RUN_ALLOWED");

        return {
          phase: input.phase,
          allowed: true,
          reasonCode: "DRY_RUN_ALLOWED",
          safeMessage: `${input.phase} destination matched an enabled webhook allowlist rule and resolved exclusively to public addresses.`,
          host: pinned.hostname,
          resolvedAddresses: [...(pinned.resolvedAddresses ?? [pinned.address])],
          matchedAllowlistRulePublicId: pinned.allowlistRulePublicId ?? null,
          checkedAt,
        };
      } catch (err) {
        const reasonCode = err instanceof DomainError ? err.reasonCode : "EGRESS_DRY_RUN_FAILED";
        const safeMessage =
          err instanceof DomainError
            ? err.message
            : "Evaluating the destination against egress policy failed.";

        await checks.recordOutcome("production", "failed", reasonCode);

        return {
          phase: input.phase,
          allowed: false,
          reasonCode,
          safeMessage,
          host: safeHost,
          resolvedAddresses: [],
          matchedAllowlistRulePublicId: null,
          checkedAt,
        };
      }
    },

    async previewOrder(principal, input): Promise<ProductionOrderPreview> {
      assertProductionTriggerPreflight(principal);
      const orders = requireOrders();
      await reconcileStaleDispatches({
        orderPublicId: input.orderPublicId,
        verifyCallerBeforeMutate: () => verifyOrderTriggerCaller(principal, input.orderPublicId),
      });

      return deps.db.transaction(async (tx) => {
        // PW-05: Order check before Identity actor check.
        const access = await orders.assertCanReadOrder(principal, input.orderPublicId, { tx });
        await assertProductionTriggerInTx(deps, principal, tx);

        const candidate = await evaluateP101CandidateInTx(tx, access.id, input.releaseStatus);

        const existingRows = await tx
          .select()
          .from(integrationProductionDispatches)
          .where(eq(integrationProductionDispatches.orderId, access.id))
          .orderBy(desc(integrationProductionDispatches.id));

        const p101Rows = existingRows.filter((r) => r.phase === "P101");
        const p201Rows = existingRows.filter((r) => r.phase === "P201");
        const p301Rows = existingRows.filter((r) => r.phase === "P301");
        const p401Rows = existingRows.filter((r) => r.phase === "P401");

        const deliveredP101 = p101Rows.find((r) => r.state === "delivered") ?? null;
        const latestP101 = p101Rows[0] ?? null;
        const deliveredP201 = p201Rows.find((r) => r.state === "delivered") ?? null;
        const latestP201 = p201Rows[0] ?? null;
        const deliveredP301 = p301Rows.find((r) => r.state === "delivered") ?? null;
        const latestP301 = p301Rows[0] ?? null;
        const deliveredP401 = p401Rows.find((r) => r.state === "delivered") ?? null;
        const latestP401 = p401Rows[0] ?? null;

        let previewP101Payload: P101Payload | null = null;
        let maskedForViewer = principal.role !== "admin";
        if (candidate.payload !== null) {
          const masked = maskP101PayloadForRole(candidate.payload, principal.role);
          previewP101Payload = masked.payload;
          maskedForViewer = masked.maskedForViewer;
        }

        const p101Eligible =
          candidate.featureEnabled &&
          candidate.featureConfigured &&
          candidate.validationErrors.length === 0 &&
          latestP101 === null;
        const p101DisabledReasons = p101Eligible
          ? []
          : buildPhaseDisabledReasons({
              phase: "P101",
              prodState: candidate.prodState,
              phaseRows: p101Rows,
              validationErrors: candidate.validationErrors,
            });

        const baseOrderErrors: ProductionValidationIssue[] = [];
        if (isOrderLockedForProduction(candidate.scope.lockState)) {
          baseOrderErrors.push({
            code: "ORDER_LOCKED",
            message: "This order is locked and cannot dispatch production webhooks.",
          });
        }
        if (isOrderCanceledStatus(candidate.scope.statusKey)) {
          baseOrderErrors.push({
            code: "ORDER_CANCELED",
            message: "Canceled orders cannot dispatch production webhooks.",
          });
        }
        const ownerInactiveIssue = candidate.validationErrors.find((e) => e.code === "ORDER_OWNER_INACTIVE");
        if (ownerInactiveIssue) {
          baseOrderErrors.push(ownerInactiveIssue);
        }

        const p201Errors: ProductionValidationIssue[] = [...baseOrderErrors];
        const stagePre = await evaluateFormat3StagePreconditionsInTx(tx, access.publicId);
        if (stagePre.isFormat3 && !stagePre.intakeLocked) {
          p201Errors.push({
            code: "PHASE1_INTAKE_NOT_LOCKED",
            message: "Phase 1 (Intake) must be submitted and locked before Phase II (P201) can start.",
          });
        }
        let previewP201Payload: P201Payload | null = null;
        if (!deliveredP101) {
          p201Errors.push({
            code: "P101_NOT_DELIVERED",
            message: "Phase I (P101) must be delivered for this order before Phase II (P201) can start.",
          });
        } else {
          const p201Check = buildP201FromDeliveredP101({
            customerId: deliveredP101.sentCustomerId,
            orderId: deliveredP101.sentOrderId,
            runMode: deliveredP101.sentRunMode,
          });
          if (p201Check.ok) {
            previewP201Payload = p201Check.payload;
          } else {
            p201Errors.push(...p201Check.errors);
          }
        }

        const p201Eligible =
          candidate.featureEnabled &&
          candidate.featureConfigured &&
          Boolean(deliveredP101) &&
          p201Errors.length === 0 &&
          latestP201 === null;
        const p201DisabledReasons = p201Eligible
          ? []
          : buildPhaseDisabledReasons({
              phase: "P201",
              prodState: candidate.prodState,
              phaseRows: p201Rows,
              validationErrors: p201Errors,
            });

        const p301Errors: ProductionValidationIssue[] = [...baseOrderErrors];
        let previewP301Payload: P201Payload | null = null;
        if (!deliveredP101) {
          p301Errors.push({
            code: "P101_NOT_DELIVERED",
            message: "Phase I (P101) must be delivered for this order before Phase III (P301) can start.",
          });
        } else {
          const p301Check = buildLaterPhaseFromDeliveredP101("P301", {
            customerId: deliveredP101.sentCustomerId,
            orderId: deliveredP101.sentOrderId,
            runMode: deliveredP101.sentRunMode,
          });
          if (p301Check.ok) {
            previewP301Payload = p301Check.payload;
          } else {
            p301Errors.push(...p301Check.errors);
          }
          if (!deliveredP201) {
            p301Errors.push({
              code: "P201_NOT_DELIVERED",
              message: "Phase II (P201) must be delivered for this order before Phase III (P301) can start.",
            });
          }
        }

        const p301Eligible =
          candidate.featureEnabled &&
          candidate.featureConfigured &&
          candidate.prodState.p301UrlConfigured &&
          Boolean(deliveredP101 && deliveredP201) &&
          p301Errors.length === 0 &&
          latestP301 === null;
        const p301DisabledReasons = p301Eligible
          ? []
          : buildPhaseDisabledReasons({
              phase: "P301",
              prodState: candidate.prodState,
              phaseRows: p301Rows,
              validationErrors: p301Errors,
            });

        const p401Errors: ProductionValidationIssue[] = [...baseOrderErrors];
        let previewP401Payload: P201Payload | null = null;
        if (!deliveredP101) {
          p401Errors.push({
            code: "P101_NOT_DELIVERED",
            message: "Phase I (P101) must be delivered for this order before Phase IV (P401) can start.",
          });
        } else {
          const p401Check = buildLaterPhaseFromDeliveredP101("P401", {
            customerId: deliveredP101.sentCustomerId,
            orderId: deliveredP101.sentOrderId,
            runMode: deliveredP101.sentRunMode,
          });
          if (p401Check.ok) {
            previewP401Payload = p401Check.payload;
          } else {
            p401Errors.push(...p401Check.errors);
          }
          if (!deliveredP201) {
            p401Errors.push({
              code: "P201_NOT_DELIVERED",
              message: "Phase II (P201) must be delivered for this order before Phase IV (P401) can start.",
            });
          } else if (candidate.prodState.p301UrlConfigured && !deliveredP301) {
            p401Errors.push({
              code: "P301_NOT_DELIVERED",
              message:
                "Phase III (P301) is configured and must be delivered for this order before Phase IV (P401) can start.",
            });
          }
        }

        const p401PrereqDelivered = Boolean(
          deliveredP101 && deliveredP201 && (!candidate.prodState.p301UrlConfigured || deliveredP301),
        );
        const p401Eligible =
          candidate.featureEnabled &&
          candidate.featureConfigured &&
          candidate.prodState.p401UrlConfigured &&
          p401PrereqDelivered &&
          p401Errors.length === 0 &&
          latestP401 === null;
        const p401DisabledReasons = p401Eligible
          ? []
          : buildPhaseDisabledReasons({
              phase: "P401",
              prodState: candidate.prodState,
              phaseRows: p401Rows,
              validationErrors: p401Errors,
            });

        return {
          featureEnabled: candidate.featureEnabled,
          featureConfigured: candidate.featureConfigured,
          settingsHref: PRODUCTION_SETTINGS_HREF,
          p101: {
            configured: candidate.prodState.p101UrlConfigured,
            eligible: p101Eligible,
            alreadyDelivered: Boolean(deliveredP101),
            activeState: latestP101 ? (latestP101.state as ProductionDispatchState) : null,
            validationErrors: candidate.validationErrors,
            disabledReasons: p101DisabledReasons,
            payload: previewP101Payload,
            maskedForViewer,
          },
          p201: {
            configured: candidate.prodState.p201UrlConfigured,
            eligible: p201Eligible,
            p101Delivered: Boolean(deliveredP101),
            alreadyDelivered: Boolean(deliveredP201),
            activeState: latestP201 ? (latestP201.state as ProductionDispatchState) : null,
            validationErrors: p201Errors,
            disabledReasons: p201DisabledReasons,
            payload: previewP201Payload,
          },
          p301: {
            configured: candidate.prodState.p301UrlConfigured,
            eligible: p301Eligible,
            p101Delivered: Boolean(deliveredP101),
            prerequisiteDelivered: Boolean(deliveredP101 && deliveredP201),
            alreadyDelivered: Boolean(deliveredP301),
            activeState: latestP301 ? (latestP301.state as ProductionDispatchState) : null,
            validationErrors: p301Errors,
            disabledReasons: p301DisabledReasons,
            payload: previewP301Payload,
          },
          p401: {
            configured: candidate.prodState.p401UrlConfigured,
            eligible: p401Eligible,
            p101Delivered: Boolean(deliveredP101),
            prerequisiteDelivered: p401PrereqDelivered,
            alreadyDelivered: Boolean(deliveredP401),
            activeState: latestP401 ? (latestP401.state as ProductionDispatchState) : null,
            validationErrors: p401Errors,
            disabledReasons: p401DisabledReasons,
            payload: previewP401Payload,
          },
        };
      });
    },

    async requestP101(principal, input): Promise<ProductionDispatchItem> {
      assertProductionTriggerPreflight(principal);
      const orders = requireOrders();
      await reconcileStaleDispatches({
        orderPublicId: input.orderPublicId,
        verifyCallerBeforeMutate: () => verifyOrderTriggerCaller(principal, input.orderPublicId),
      });

      const outcome = await deps.db.transaction(
        async (tx): Promise<{ ok: true; item: ProductionDispatchItem } | { ok: false; error: DomainError }> => {
          // PW-05: Lock order row FOR UPDATE FIRST, then lock/revalidate Identity actor SECOND.
          const access = await orders.assertCanReadOrder(principal, input.orderPublicId, {
            tx,
            forUpdate: true,
          });
          await assertProductionTriggerInTx(deps, principal, tx);

          const candidate = await evaluateP101CandidateInTx(tx, access.id, input.releaseStatus);

          if (!candidate.featureEnabled || !candidate.featureConfigured || !candidate.prodState.p101Secret) {
            await recordRefusedAuditInTx(tx, {
              phase: "P101",
              orderPublicId: access.publicId,
              reasonCode: "PRODUCTION_WEBHOOKS_NOT_ENABLED",
              packet: candidate.payload?.packet ?? null,
              tier: candidate.payload?.tier ?? null,
              bundleScopeManifest: candidate.payload?.bundle_scope_manifest ?? null,
            });
            return {
              ok: false,
              error: new DomainError(
                "NOT_CONFIGURED",
                "PRODUCTION_WEBHOOKS_NOT_ENABLED",
                "Production webhooks are disabled or incomplete.",
              ),
            };
          }

          if (candidate.validationErrors.length > 0 || !candidate.payload) {
            const first = candidate.validationErrors[0] ?? {
              code: "INVALID_P101_PAYLOAD",
              message: "Order failed Phase I (P101) validation.",
            };
            await recordRefusedAuditInTx(tx, {
              phase: "P101",
              orderPublicId: access.publicId,
              reasonCode: first.code,
              packet: candidate.payload?.packet ?? null,
              tier: candidate.payload?.tier ?? null,
              bundleScopeManifest: candidate.payload?.bundle_scope_manifest ?? null,
            });
            return {
              ok: false,
              error:
                first.code === "ORDER_LOCKED" ||
                first.code === "ORDER_CANCELED" ||
                first.code === "PAYMENT_NOT_CONFIRMED"
                  ? conflict(first.code, first.message)
                  : validation(first.code, first.message, {
                      error_codes: candidate.validationErrors.map((e) => e.code),
                    }),
            };
          }

          const existingP101 = await tx
            .select()
            .from(integrationProductionDispatches)
            .where(
              and(
                eq(integrationProductionDispatches.orderId, access.id),
                eq(integrationProductionDispatches.phase, "P101"),
              ),
            )
            .for("update")
            .orderBy(desc(integrationProductionDispatches.id));

          if (existingP101.some((r) => r.state === "queued" || r.state === "sending")) {
            throw conflict(
              "PRODUCTION_DISPATCH_IN_PROGRESS",
              "A Phase I (P101) dispatch is already queued or sending for this order.",
            );
          }
          if (existingP101.some((r) => r.state === "delivered")) {
            throw conflict(
              "PRODUCTION_P101_ALREADY_DELIVERED",
              "Phase I (P101) has already been delivered for this order. Re-sending requires an administrator with step-up authentication and a reason.",
            );
          }
          if (existingP101.length > 0) {
            throw conflict(
              "PRODUCTION_RESEND_REQUIRED",
              "A prior Phase I (P101) attempt already ran for this order. Re-sending requires an administrator with step-up authentication and a reason.",
            );
          }

          const authHeaderValue =
            candidate.prodState.cfg.authHeaderName !== ""
              ? await readSecret(deps.settings, INTEGRATIONS_PRODUCTION_AUTH_VALUE, tx)
              : null;
          const destinationFingerprint = computeDestinationFingerprint("P101", {
            targetUrl: candidate.prodState.p101Secret,
            authHeaderName: candidate.prodState.cfg.authHeaderName,
            authHeaderValue,
            canonVersion: candidate.prodState.cfg.canonVersion,
            runMode: candidate.prodState.cfg.runMode,
            signingEnabled: candidate.prodState.cfg.signingEnabled,
            signingSecret: candidate.prodState.signingSecret,
          });

          const p = candidate.payload;
          const item = await enqueueDispatchInTx(tx, {
            principal,
            orderId: access.id,
            orderPublicId: access.publicId,
            orderReference: candidate.scope.reference,
            expectedOwnerUserId: candidate.scope.ownerUserId,
            destinationFingerprint,
            phase: "P101",
            payloadObject: p,
            sentCustomerId: p.customer_id,
            sentOrderId: p.order_id,
            sentRunMode: p.run_mode,
            packet: p.packet,
            tier: p.tier,
            bundleScopeManifest: p.bundle_scope_manifest,
            releaseStatus: p.release_status,
            isResend: false,
            resendReasonCode: null,
            phase1ArtifactsConfirmed: false,
          });
          return { ok: true, item };
        },
      );

      if (!outcome.ok) {
        throw outcome.error;
      }
      return outcome.item;
    },

    async requestP201(principal, input): Promise<ProductionDispatchItem> {
      assertProductionTriggerPreflight(principal);
      const orders = requireOrders();
      const identity = requireIdentity();
      await reconcileStaleDispatches({
        orderPublicId: input.orderPublicId,
        verifyCallerBeforeMutate: () => verifyOrderTriggerCaller(principal, input.orderPublicId),
      });

      const outcome = await deps.db.transaction(
        async (tx): Promise<{ ok: true; item: ProductionDispatchItem } | { ok: false; error: DomainError }> => {
          // PW-05: Lock order row FOR UPDATE FIRST, then lock/revalidate Identity actor SECOND.
          const access = await orders.assertCanReadOrder(principal, input.orderPublicId, {
            tx,
            forUpdate: true,
          });
          await assertProductionTriggerInTx(deps, principal, tx);

          const [scope, prodState] = await Promise.all([
            orders.getProductionScope(access.id, { tx }),
            readProductionState(tx),
          ]);
          if (!scope) {
            throw notFound("ORDER_NOT_FOUND");
          }

          if (isOrderLockedForProduction(scope.lockState)) {
            await recordRefusedAuditInTx(tx, {
              phase: "P201",
              orderPublicId: access.publicId,
              reasonCode: "ORDER_LOCKED",
            });
            return {
              ok: false,
              error: conflict("ORDER_LOCKED", "This order is locked and cannot dispatch production webhooks."),
            };
          }

          if (isOrderCanceledStatus(scope.statusKey)) {
            await recordRefusedAuditInTx(tx, {
              phase: "P201",
              orderPublicId: access.publicId,
              reasonCode: "ORDER_CANCELED",
            });
            return {
              ok: false,
              error: conflict("ORDER_CANCELED", "Canceled orders cannot dispatch production webhooks."),
            };
          }

          const owner = await identity.getUser(scope.ownerUserId, { tx });
          if (!owner || owner.status !== "active") {
            await recordRefusedAuditInTx(tx, {
              phase: "P201",
              orderPublicId: access.publicId,
              reasonCode: "ORDER_OWNER_INACTIVE",
            });
            return {
              ok: false,
              error: validation(
                "ORDER_OWNER_INACTIVE",
                "The order owner account must be active to dispatch production webhooks.",
              ),
            };
          }

          const stagePre = await evaluateFormat3StagePreconditionsInTx(tx, access.publicId);
          if (stagePre.isFormat3 && !stagePre.intakeLocked) {
            await recordRefusedAuditInTx(tx, {
              phase: "P201",
              orderPublicId: access.publicId,
              reasonCode: "PHASE1_INTAKE_NOT_LOCKED",
            });
            return {
              ok: false,
              error: conflict(
                "PHASE1_INTAKE_NOT_LOCKED",
                "Phase 1 (Intake) must be submitted and locked before Phase II (P201) can start.",
              ),
            };
          }

          if (input.phase1ArtifactsConfirmed !== true) {
            await recordRefusedAuditInTx(tx, {
              phase: "P201",
              orderPublicId: access.publicId,
              reasonCode: "PHASE1_ARTIFACTS_CONFIRMATION_REQUIRED",
            });
            return {
              ok: false,
              error: validation(
                "PHASE1_ARTIFACTS_CONFIRMATION_REQUIRED",
                "Confirm that the Phase I final artifacts exist for this order before starting Phase II (P201).",
              ),
            };
          }

          if (!prodState.enabled || !prodState.configured || !prodState.p201Secret) {
            await recordRefusedAuditInTx(tx, {
              phase: "P201",
              orderPublicId: access.publicId,
              reasonCode: "PRODUCTION_WEBHOOKS_NOT_ENABLED",
            });
            return {
              ok: false,
              error: new DomainError(
                "NOT_CONFIGURED",
                "PRODUCTION_WEBHOOKS_NOT_ENABLED",
                "Production webhooks are disabled or incomplete.",
              ),
            };
          }

          const existingRows = await tx
            .select()
            .from(integrationProductionDispatches)
            .where(eq(integrationProductionDispatches.orderId, access.id))
            .for("update")
            .orderBy(desc(integrationProductionDispatches.id));

          const deliveredP101 = existingRows.find((r) => r.phase === "P101" && r.state === "delivered");
          if (!deliveredP101) {
            await recordRefusedAuditInTx(tx, {
              phase: "P201",
              orderPublicId: access.publicId,
              reasonCode: "PRODUCTION_P101_NOT_DELIVERED",
            });
            return {
              ok: false,
              error: conflict(
                "PRODUCTION_P101_NOT_DELIVERED",
                "Phase II (P201) cannot start until Phase I (P101) has been delivered for this order.",
              ),
            };
          }

          const existingP201 = existingRows.filter((r) => r.phase === "P201");
          if (existingP201.some((r) => r.state === "queued" || r.state === "sending")) {
            throw conflict(
              "PRODUCTION_DISPATCH_IN_PROGRESS",
              "A Phase II (P201) dispatch is already queued or sending for this order.",
            );
          }
          if (existingP201.some((r) => r.state === "delivered")) {
            throw conflict(
              "PRODUCTION_P201_ALREADY_DELIVERED",
              "Phase II (P201) has already been delivered for this order. Re-sending requires an administrator with step-up authentication and a reason.",
            );
          }
          if (existingP201.length > 0) {
            throw conflict(
              "PRODUCTION_RESEND_REQUIRED",
              "A prior Phase II (P201) attempt already ran for this order. Re-sending requires an administrator with step-up authentication and a reason.",
            );
          }

          // Copy identity triple verbatim from the delivered P101 row — NEVER recomputed from users/orders.
          const p201Check = buildP201FromDeliveredP101({
            customerId: deliveredP101.sentCustomerId,
            orderId: deliveredP101.sentOrderId,
            runMode: deliveredP101.sentRunMode,
          });
          if (!p201Check.ok) {
            const first = p201Check.errors[0]!;
            await recordRefusedAuditInTx(tx, {
              phase: "P201",
              orderPublicId: access.publicId,
              reasonCode: first.code,
            });
            return {
              ok: false,
              error: validation(first.code, first.message, {
                error_codes: p201Check.errors.map((e) => e.code),
              }),
            };
          }

          const authHeaderValue =
            prodState.cfg.authHeaderName !== ""
              ? await readSecret(deps.settings, INTEGRATIONS_PRODUCTION_AUTH_VALUE, tx)
              : null;
          const destinationFingerprint = computeDestinationFingerprint("P201", {
            targetUrl: prodState.p201Secret,
            authHeaderName: prodState.cfg.authHeaderName,
            authHeaderValue,
            canonVersion: prodState.cfg.canonVersion,
            runMode: prodState.cfg.runMode,
            signingEnabled: prodState.cfg.signingEnabled,
            signingSecret: prodState.signingSecret,
          });

          const item = await enqueueDispatchInTx(tx, {
            principal,
            orderId: access.id,
            orderPublicId: access.publicId,
            orderReference: deliveredP101.orderReference,
            expectedOwnerUserId: scope.ownerUserId,
            destinationFingerprint,
            phase: "P201",
            payloadObject: p201Check.payload,
            sentCustomerId: p201Check.payload.customer_id,
            sentOrderId: p201Check.payload.order_id,
            sentRunMode: p201Check.payload.run_mode,
            packet: deliveredP101.packet ?? null,
            tier: deliveredP101.tier ?? null,
            bundleScopeManifest: deliveredP101.bundleScopeManifest ?? null,
            releaseStatus: null,
            isResend: false,
            resendReasonCode: null,
            phase1ArtifactsConfirmed: true,
          });
          return { ok: true, item };
        },
      );

      if (!outcome.ok) {
        throw outcome.error;
      }
      return outcome.item;
    },

    async requestP301(principal, input): Promise<ProductionDispatchItem> {
      return requestOptionalLaterPhase(principal, input.orderPublicId, "P301");
    },

    async requestP401(principal, input): Promise<ProductionDispatchItem> {
      return requestOptionalLaterPhase(principal, input.orderPublicId, "P401");
    },

    async stop(principal, input): Promise<ProductionDispatchItem> {
      assertProductionTriggerPreflight(principal);
      const cleanReason = input.reason ? input.reason.trim() : null;
      if (cleanReason !== null && (cleanReason.length > 280 || !hasNoHeaderInjection(cleanReason))) {
        throw validation("INVALID_STOP_REASON", "Stop reason must be at most 280 printable characters.");
      }

      const orders = requireOrders();
      const jobAdmin = requireJobAdmin();

      const item = await deps.db.transaction(async (tx) => {
        // PW-05 + PW-02 strict total lock order: `orders` -> `identity` -> `job_runs` -> `integration_production_dispatches`.
        const access = await orders.assertCanReadOrder(principal, input.orderPublicId, {
          tx,
          forUpdate: true,
        });
        await assertProductionTriggerInTx(deps, principal, tx);

        const [snapshot] = await tx
          .select({
            id: integrationProductionDispatches.id,
            jobPublicId: integrationProductionDispatches.jobPublicId,
            state: integrationProductionDispatches.state,
            phase: integrationProductionDispatches.phase,
          })
          .from(integrationProductionDispatches)
          .where(
            and(
              eq(integrationProductionDispatches.orderId, access.id),
              eq(integrationProductionDispatches.publicId, input.dispatchPublicId),
            ),
          )
          .limit(1);
        if (!snapshot) {
          throw notFound("PRODUCTION_DISPATCH_NOT_FOUND");
        }
        if (snapshot.state !== "queued") {
          throw conflict(
            "PRODUCTION_DISPATCH_NOT_STOPPABLE",
            `Cannot stop a production dispatch in state ${snapshot.state}; only queued dispatches can be stopped.`,
          );
        }

        const disposition = await jobAdmin.reconcileOutboxJob(snapshot.jobPublicId, tx, {
          cancelQueued: true,
        });
        if (disposition.state === "running_live") {
          throw conflict(
            "PRODUCTION_DISPATCH_NOT_STOPPABLE",
            "This production dispatch has already been claimed by a worker and cannot be stopped in flight.",
          );
        }

        const [locked] = await tx
          .select()
          .from(integrationProductionDispatches)
          .where(eq(integrationProductionDispatches.id, snapshot.id))
          .for("update")
          .limit(1);
        if (!locked) {
          throw notFound("PRODUCTION_DISPATCH_NOT_FOUND");
        }
        if (locked.state !== "queued") {
          throw conflict(
            "PRODUCTION_DISPATCH_NOT_STOPPABLE",
            `Cannot stop a production dispatch in state ${locked.state}; only queued dispatches can be stopped.`,
          );
        }

        const now = deps.clock.now();
        const summary = fixedDispatchSummary("OPERATOR_STOPPED", null, "stopped");
        await tx
          .update(integrationProductionDispatches)
          .set({
            state: "stopped",
            payloadEnc: null,
            activeFencingToken: 0,
            lastReasonCode: "OPERATOR_STOPPED",
            responseSummary: summary,
            stoppedAt: now,
            stoppedByPublicId: principal.userPublicId,
            stopReason: cleanReason && cleanReason.length > 0 ? cleanReason : null,
            finalizedAt: now,
            updatedAt: now,
            version: locked.version + 1,
          })
          .where(
            and(
              eq(integrationProductionDispatches.id, locked.id),
              eq(integrationProductionDispatches.version, locked.version),
            ),
          );

        await deps.audit.record(
          {
            category: "integration",
            eventName: "integration.production.dispatch.stopped",
            action: "stop",
            outcome: "completed",
            severity: "WARN",
            provider: "production_webhook",
            reasonCode: "OPERATOR_STOPPED",
            orderPublicId: access.publicId,
            resource: { type: "integration_production_dispatch", publicId: locked.publicId },
            attributes: buildSafeDispatchAuditAttributes(locked, {
              stopped_by_public_id: principal.userPublicId,
              has_stop_reason: Boolean(cleanReason && cleanReason.length > 0),
            }),
            ...(cleanReason ? { safeCounts: { reason_length: cleanReason.length } } : {}),
          },
          tx,
        );

        const [updated] = await tx
          .select()
          .from(integrationProductionDispatches)
          .where(eq(integrationProductionDispatches.id, locked.id))
          .limit(1);
        if (!updated) {
          throw notFound("PRODUCTION_DISPATCH_NOT_FOUND");
        }
        return toDispatchItem(updated);
      });

      await resolveProdOpsAlert(item.orderPublicId, item.phase);
      return item;
    },

    async retry(principal, input): Promise<ProductionDispatchItem> {
      assertProductionTriggerPreflight(principal);
      const orders = requireOrders();
      await reconcileStaleDispatches({
        orderPublicId: input.orderPublicId,
        verifyCallerBeforeMutate: () => verifyOrderTriggerCaller(principal, input.orderPublicId),
      });

      const outcome = await deps.db.transaction(
        async (tx): Promise<{ ok: true; item: ProductionDispatchItem } | { ok: false; error: DomainError }> => {
          // PW-05: Lock order row FOR UPDATE FIRST, then lock/revalidate Identity actor SECOND.
          const access = await orders.assertCanReadOrder(principal, input.orderPublicId, {
            tx,
            forUpdate: true,
          });
          await assertProductionTriggerInTx(deps, principal, tx);

          const existingRows = await tx
            .select()
            .from(integrationProductionDispatches)
            .where(eq(integrationProductionDispatches.orderId, access.id))
            .for("update")
            .orderBy(desc(integrationProductionDispatches.id));

          const targetRow = existingRows.find((r) => r.publicId === input.dispatchPublicId) ?? null;
          if (!targetRow) {
            throw notFound("PRODUCTION_DISPATCH_NOT_FOUND");
          }

          const phase = targetRow.phase as ProductionPhase;
          const phaseRows = existingRows.filter((r) => r.phase === phase);

          if (phaseRows.some((r) => r.state === "queued" || r.state === "sending")) {
            throw conflict(
              "PRODUCTION_DISPATCH_IN_PROGRESS",
              `Cannot retry ${phase} while a dispatch is queued or sending.`,
            );
          }

          const rootRow = resolveRetryRootRow(targetRow, phaseRows);
          // Abuse guard: once an intent chain has been delivered (or an initial undelivered chain is superseded by a
          // delivered phase row), `retry` is refused; retrying an undelivered `dead`/`failed` redelivery row (`rootRow`
          // has `redeliveryOfPublicId !== null` and zero delivered rows in its `retryOf` chain) is permitted and
          // preserves that redelivery's wire `Idempotency-Key`.
          const intentChainDelivered = phaseRows.some(
            (r) =>
              r.state === "delivered" &&
              resolveRetryRootRow(r, phaseRows).publicId === rootRow.publicId,
          );
          const initialPhaseAlreadyDelivered =
            rootRow.redeliveryOfPublicId === null &&
            phaseRows.some((r) => r.state === "delivered");
          if (intentChainDelivered || initialPhaseAlreadyDelivered) {
            throw conflict(
              "PRODUCTION_ALREADY_DELIVERED",
              `${phaseDisplayLabel(phase)} (${phase}) has already been delivered; re-sending requires an administrator with step-up authentication and REDELIVER confirmation.`,
            );
          }
          if (
            targetRow.state === "unknown" ||
            phaseRows.some(
              (r) =>
                r.state === "unknown" &&
                (rootRow.redeliveryOfPublicId === null ||
                  resolveRetryRootRow(r, phaseRows).publicId === rootRow.publicId),
            )
          ) {
            throw conflict(
              "PRODUCTION_DISPATCH_UNCERTAIN",
              `A ${phase} attempt ended with an uncertain outcome; verify downstream state before re-sending.`,
            );
          }
          if (
            targetRow.state !== "failed" &&
            targetRow.state !== "dead" &&
            targetRow.state !== "stopped"
          ) {
            throw conflict(
              "PRODUCTION_DISPATCH_NOT_FAILED",
              "Only failed, dead-lettered, or stopped dispatches can be retried.",
            );
          }
          if (phaseRows[0]?.publicId !== targetRow.publicId) {
            throw conflict(
              "PRODUCTION_DISPATCH_SUPERSEDED",
              "A newer dispatch already exists for this phase; retry the latest failed attempt.",
            );
          }

          const prep = await reconstructExactDispatchPayloadInTx(tx, {
            orderId: access.id,
            orderPublicId: access.publicId,
            targetRow,
            existingRows,
            action: "retry",
          });
          if (!prep.ok) {
            return prep;
          }

          let overlapRetryMatch = false;
          if (
            prep.prepared.destinationFingerprint !== rootRow.destinationFingerprint ||
            prep.prepared.destinationFingerprint !== targetRow.destinationFingerprint
          ) {
            const prodState = await readProductionState(tx);
            const targetSecret = targetSecretForPhase(prodState, phase);
            if (prodState.cfg.signingEnabled && prodState.overlapSigningSecret && targetSecret) {
              const authHeaderValue =
                prodState.cfg.authHeaderName !== ""
                  ? await readSecret(deps.settings, INTEGRATIONS_PRODUCTION_AUTH_VALUE, tx)
                  : null;
              const overlapFp = computeDestinationFingerprint(phase, {
                targetUrl: targetSecret,
                authHeaderName: prodState.cfg.authHeaderName,
                authHeaderValue,
                canonVersion: prodState.cfg.canonVersion,
                runMode: prodState.cfg.runMode,
                signingEnabled: true,
                signingSecret: prodState.overlapSigningSecret,
              });
              overlapRetryMatch =
                (prep.prepared.destinationFingerprint === rootRow.destinationFingerprint ||
                  overlapFp === rootRow.destinationFingerprint) &&
                (prep.prepared.destinationFingerprint === targetRow.destinationFingerprint ||
                  overlapFp === targetRow.destinationFingerprint);
            }
          }

          if (
            !overlapRetryMatch &&
            (prep.prepared.destinationFingerprint !== rootRow.destinationFingerprint ||
              prep.prepared.destinationFingerprint !== targetRow.destinationFingerprint)
          ) {
            await recordRefusedAuditInTx(tx, {
              phase,
              orderPublicId: access.publicId,
              reasonCode: "PRODUCTION_DESTINATION_CHANGED",
              packet: targetRow.packet ?? null,
              tier: targetRow.tier ?? null,
              bundleScopeManifest: targetRow.bundleScopeManifest ?? null,
              action: "retry",
              extraAttrs: {
                target_dispatch_public_id: targetRow.publicId,
                destination_changed: true,
              },
            });
            return {
              ok: false,
              error: conflict(
                "PRODUCTION_DESTINATION_CHANGED",
                "Webhook destination or authentication changed since the original dispatch; an administrator with step-up verification must use Re-send.",
              ),
            };
          }

          const resendReasonCode: ControlledResendReason =
            targetRow.state === "dead"
              ? "OPERATOR_RETRY_AFTER_DEAD_LETTER"
              : targetRow.state === "stopped"
                ? "OPERATOR_RETRY_AFTER_STOP"
                : "OPERATOR_RETRY_AFTER_FAILURE";
          const retryRootWireKey = resolveRetryRootWireKey(targetRow, phaseRows);

          const item = await enqueueDispatchInTx(tx, {
            principal,
            orderId: access.id,
            orderPublicId: access.publicId,
            orderReference: prep.prepared.orderReference,
            expectedOwnerUserId: prep.prepared.expectedOwnerUserId,
            destinationFingerprint: prep.prepared.destinationFingerprint,
            phase,
            payloadObject: prep.prepared.payloadObject,
            sentCustomerId: prep.prepared.sentCustomerId,
            sentOrderId: prep.prepared.sentOrderId,
            sentRunMode: prep.prepared.sentRunMode,
            packet: prep.prepared.packet,
            tier: prep.prepared.tier,
            bundleScopeManifest: prep.prepared.bundleScopeManifest,
            releaseStatus: prep.prepared.releaseStatus,
            isResend: true,
            resendReasonCode,
            retryOfPublicId: targetRow.publicId,
            redeliveryOfPublicId: rootRow.redeliveryOfPublicId ?? null,
            retryRootWireKey,
            dispatchKind: "retry",
            phase1ArtifactsConfirmed: prep.prepared.phase1ArtifactsConfirmed,
          });
          return { ok: true, item };
        },
      );

      if (!outcome.ok) {
        throw outcome.error;
      }
      return outcome.item;
    },

    async redeliver(principal, input): Promise<ProductionDispatchItem> {
      const now = deps.clock.now();
      assertProductionRedeliverPreflight(principal, now);

      if (input.confirmation !== "REDELIVER") {
        throw validation(
          "REDELIVER_CONFIRMATION_REQUIRED",
          "Type REDELIVER in uppercase to confirm re-delivery of an already-delivered production webhook.",
        );
      }
      const reason = input.reason.trim();
      if (reason.length < 3 || reason.length > 280 || !hasNoHeaderInjection(reason)) {
        throw validation(
          "REDELIVER_REASON_REQUIRED",
          "Enter an audit reason between 3 and 280 printable characters.",
        );
      }
      const operatorIdempotencyKey = input.idempotencyKey.trim();
      if (
        operatorIdempotencyKey.length < 8 ||
        operatorIdempotencyKey.length > 64 ||
        !/^[A-Za-z0-9:_-]+$/.test(operatorIdempotencyKey)
      ) {
        throw validation(
          "REDELIVER_IDEMPOTENCY_KEY_REQUIRED",
          "Provide a valid idempotencyKey between 8 and 64 URL-safe characters.",
        );
      }

      const orders = requireOrders();
      await reconcileStaleDispatches({
        orderPublicId: input.orderPublicId,
        verifyCallerBeforeMutate: () => verifyOrderRedeliverCaller(principal, input.orderPublicId),
      });

      const outcome = await deps.db.transaction(
        async (tx): Promise<{ ok: true; item: ProductionDispatchItem } | { ok: false; error: DomainError }> => {
          // PW-05: Lock order row FOR UPDATE FIRST, then lock/revalidate Identity actor + post-lock step-up SECOND.
          const access = await orders.assertCanReadOrder(principal, input.orderPublicId, {
            tx,
            forUpdate: true,
          });
          await assertProductionRedeliverInTx(deps, principal, tx);

          const existingRows = await tx
            .select()
            .from(integrationProductionDispatches)
            .where(eq(integrationProductionDispatches.orderId, access.id))
            .for("update")
            .orderBy(desc(integrationProductionDispatches.id));

          const targetRow = existingRows.find((r) => r.publicId === input.dispatchPublicId) ?? null;
          if (!targetRow) {
            throw notFound("PRODUCTION_DISPATCH_NOT_FOUND");
          }

          // Durable operator-intent idempotency: a replay of the same confirmed mutation (even after
          // delivery completes) returns the existing redelivery row without enqueuing another run.
          const phase = targetRow.phase as ProductionPhase;
          const intentDigest = deps.crypto
            .blindIndex(
              `${access.id}:${operatorIdempotencyKey}`,
              "integration_production_dispatches.redeliver_intent_v1",
            )
            .slice(0, 40);
          const intentSuffix = `:rdlv:${intentDigest}`;
          const expectedRedeliverKey = `rp-prod:${phase.toLowerCase()}${intentSuffix}`;
          const existingForIntent =
            existingRows.find(
              (r) => r.redeliveryOfPublicId !== null && r.idempotencyKey.endsWith(intentSuffix),
            ) ?? null;
          if (existingForIntent) {
            if (existingForIntent.redeliveryOfPublicId !== targetRow.publicId) {
              throw conflict(
                "IDEMPOTENCY_KEY_CONFLICT",
                "This idempotencyKey was already used for a different dispatch on this order.",
              );
            }
            const latestInIntentChain =
              existingRows.find(
                (r) => toWireIdempotencyKey(r.idempotencyKey) === expectedRedeliverKey,
              ) ?? existingForIntent;
            return { ok: true, item: toDispatchItem(latestInIntentChain) };
          }

          if (targetRow.state !== "delivered") {
            throw conflict(
              "PRODUCTION_DISPATCH_NOT_DELIVERED",
              "Only already-delivered dispatches can be re-delivered; use Retry for failed dispatches.",
            );
          }

          const phaseRows = existingRows.filter((r) => r.phase === phase);
          if (phaseRows.some((r) => r.state === "queued" || r.state === "sending")) {
            throw conflict(
              "PRODUCTION_DISPATCH_IN_PROGRESS",
              `Cannot re-deliver ${phase} while a dispatch is queued or sending.`,
            );
          }

          const latestRedeliveryRow =
            phaseRows.find((r) => resolveRetryRootRow(r, phaseRows).redeliveryOfPublicId !== null) ?? null;
          const latestRedeliveryRoot = latestRedeliveryRow
            ? resolveRetryRootRow(latestRedeliveryRow, phaseRows)
            : null;
          const latestRedeliveryChain = latestRedeliveryRoot
            ? phaseRows.filter(
                (r) => resolveRetryRootRow(r, phaseRows).publicId === latestRedeliveryRoot.publicId,
              )
            : [];
          const latestRedeliveryDelivered = latestRedeliveryChain.some((r) => r.state === "delivered");

          if (
            phaseRows[0]?.state === "unknown" ||
            latestRedeliveryRow?.state === "unknown" ||
            (!latestRedeliveryDelivered && latestRedeliveryChain.some((r) => r.state === "unknown"))
          ) {
            throw conflict(
              "PRODUCTION_DISPATCH_UNCERTAIN",
              `Cannot start a new ${phase} redelivery while the latest redelivery outcome is unknown; verify downstream state and retry or resolve the prior attempt first.`,
            );
          }
          if (
            !latestRedeliveryDelivered &&
            (latestRedeliveryRow?.state === "dead" ||
              latestRedeliveryChain.some((r) => r.state === "dead"))
          ) {
            throw conflict(
              "PRODUCTION_REDELIVERY_RETRY_REQUIRED",
              `The latest ${phase} redelivery ended in dead-letter state; retry that redelivery row (${latestRedeliveryRow!.publicId}) so its original Idempotency-Key is preserved.`,
            );
          }

          const prep = await reconstructExactDispatchPayloadInTx(tx, {
            orderId: access.id,
            orderPublicId: access.publicId,
            targetRow,
            existingRows,
            action: "redeliver",
          });
          if (!prep.ok) {
            return prep;
          }

          const item = await enqueueDispatchInTx(tx, {
            principal,
            orderId: access.id,
            orderPublicId: access.publicId,
            orderReference: prep.prepared.orderReference,
            expectedOwnerUserId: prep.prepared.expectedOwnerUserId,
            destinationFingerprint: prep.prepared.destinationFingerprint,
            phase,
            payloadObject: prep.prepared.payloadObject,
            sentCustomerId: prep.prepared.sentCustomerId,
            sentOrderId: prep.prepared.sentOrderId,
            sentRunMode: prep.prepared.sentRunMode,
            packet: prep.prepared.packet,
            tier: prep.prepared.tier,
            bundleScopeManifest: prep.prepared.bundleScopeManifest,
            releaseStatus: prep.prepared.releaseStatus,
            isResend: true,
            resendReasonCode: "OPERATOR_REPLAY_DELIVERED",
            retryOfPublicId: null,
            redeliveryOfPublicId: targetRow.publicId,
            idempotencyKeyOverride: `rp-prod:${phase.toLowerCase()}${intentSuffix}`,
            dispatchKind: "redeliver",
            reasonLength: reason.length,
            phase1ArtifactsConfirmed: prep.prepared.phase1ArtifactsConfirmed,
          });
          return { ok: true, item };
        },
      );

      if (!outcome.ok) {
        throw outcome.error;
      }
      return outcome.item;
    },

    async resend(principal, input): Promise<ProductionDispatchItem> {
      const now = deps.clock.now();
      assertProductionResendPreflight(principal, now);

      const reason = input.reason.trim();
      if (reason.length < 3 || reason.length > 280 || !hasNoHeaderInjection(reason)) {
        throw validation("RESEND_REASON_REQUIRED", "Enter a re-send reason between 3 and 280 characters.");
      }

      const orders = requireOrders();
      // PW-02: Reconcile any stale/expired `sending`/`queued` rows via job-fenced reconciliation before opening
      // the order transaction so interrupted attempts never permanently block administrative re-send.
      await reconcileStaleDispatches({
        orderPublicId: input.orderPublicId,
        verifyCallerBeforeMutate: () => verifyOrderResendCaller(principal, input.orderPublicId),
      });

      const outcome = await deps.db.transaction(
        async (tx): Promise<{ ok: true; item: ProductionDispatchItem } | { ok: false; error: DomainError }> => {
          // PW-05: Lock order row FOR UPDATE FIRST, then lock/revalidate Identity actor + post-lock step-up SECOND.
          const access = await orders.assertCanReadOrder(principal, input.orderPublicId, {
            tx,
            forUpdate: true,
          });
          await assertProductionResendInTx(deps, principal, tx);

          const existingRows = await tx
            .select()
            .from(integrationProductionDispatches)
            .where(eq(integrationProductionDispatches.orderId, access.id))
            .for("update")
            .orderBy(desc(integrationProductionDispatches.id));

          const phaseRows = existingRows.filter((r) => r.phase === input.phase);
          if (phaseRows.length === 0) {
            throw conflict(
              "PRODUCTION_NOTHING_TO_RESEND",
              `No prior ${input.phase} dispatch exists for this order; start the phase first.`,
            );
          }
          if (phaseRows.some((r) => r.state === "queued" || r.state === "sending")) {
            throw conflict(
              "PRODUCTION_DISPATCH_IN_PROGRESS",
              `Cannot re-send ${input.phase} while a dispatch is queued or sending.`,
            );
          }
          if (phaseRows.some((r) => r.state === "delivered")) {
            throw conflict(
              "PRODUCTION_ALREADY_DELIVERED",
              `${input.phase} has already been delivered for this order; use production.order.redeliver with step-up confirmation instead.`,
            );
          }

          // PW-07: Classify into controlled server code; NEVER store or audit raw `input.reason` prose.
          const latestRow = phaseRows[0]!;
          const rootRow = phaseRows[phaseRows.length - 1]!;
          const resendReasonCode = classifyResendReasonCode(latestRow);

          if (input.phase === "P201" && input.phase1ArtifactsConfirmed !== true) {
            await recordRefusedAuditInTx(tx, {
              phase: "P201",
              orderPublicId: access.publicId,
              reasonCode: "PHASE1_ARTIFACTS_UNCONFIRMED",
              packet: rootRow.packet ?? null,
              tier: rootRow.tier ?? null,
              bundleScopeManifest: rootRow.bundleScopeManifest ?? null,
              isResend: true,
              action: "resend",
            });
            return {
              ok: false,
              error: validation(
                "PHASE1_ARTIFACTS_UNCONFIRMED",
                "Confirm Phase I SharePoint output artifacts before re-sending Phase II (P201).",
              ),
            };
          }

          if (
            input.phase === "P101" &&
            input.releaseStatus !== undefined &&
            input.releaseStatus.trim() !== (rootRow.releaseStatus ?? "")
          ) {
            await recordRefusedAuditInTx(tx, {
              phase: "P101",
              orderPublicId: access.publicId,
              reasonCode: "ORDER_SCOPE_CHANGED",
              packet: rootRow.packet ?? null,
              tier: rootRow.tier ?? null,
              bundleScopeManifest: rootRow.bundleScopeManifest ?? null,
              isResend: true,
              action: "resend",
            });
            return {
              ok: false,
              error: conflict(
                "ORDER_SCOPE_CHANGED",
                "Cannot change releaseStatus when re-sending an undelivered dispatch; payload bytes must match the original attempt.",
              ),
            };
          }

          const prep = await reconstructExactDispatchPayloadInTx(tx, {
            orderId: access.id,
            orderPublicId: access.publicId,
            targetRow: rootRow,
            existingRows,
            action: "resend",
          });
          if (!prep.ok) {
            return prep;
          }

          const retryRootWireKey = toWireIdempotencyKey(rootRow.idempotencyKey);
          const destinationChanged =
            prep.prepared.destinationFingerprint !== rootRow.destinationFingerprint;

          const item = await enqueueDispatchInTx(tx, {
            principal,
            orderId: access.id,
            orderPublicId: access.publicId,
            orderReference: prep.prepared.orderReference,
            expectedOwnerUserId: prep.prepared.expectedOwnerUserId,
            destinationFingerprint: prep.prepared.destinationFingerprint,
            phase: input.phase,
            payloadObject: prep.prepared.payloadObject,
            sentCustomerId: prep.prepared.sentCustomerId,
            sentOrderId: prep.prepared.sentOrderId,
            sentRunMode: prep.prepared.sentRunMode,
            packet: prep.prepared.packet,
            tier: prep.prepared.tier,
            bundleScopeManifest: prep.prepared.bundleScopeManifest,
            releaseStatus: prep.prepared.releaseStatus,
            isResend: true,
            resendReasonCode,
            retryRootWireKey,
            destinationChanged,
            dispatchKind: "resend",
            reasonLength: reason.length,
            phase1ArtifactsConfirmed: prep.prepared.phase1ArtifactsConfirmed,
          });
          return { ok: true, item };
        },
      );

      if (!outcome.ok) {
        throw outcome.error;
      }
      return outcome.item;
    },

    async orderHistory(principal, input): Promise<{ items: ProductionDispatchItem[] }> {
      assertProductionTriggerPreflight(principal);
      const orders = requireOrders();
      await reconcileStaleDispatches({
        orderPublicId: input.orderPublicId,
        verifyCallerBeforeMutate: () => verifyOrderTriggerCaller(principal, input.orderPublicId),
      });

      return deps.db.transaction(async (tx) => {
        // PW-05: Order check before Identity actor check.
        const access = await orders.assertCanReadOrder(principal, input.orderPublicId, { tx });
        await assertProductionTriggerInTx(deps, principal, tx);

        const rows = await tx
          .select()
          .from(integrationProductionDispatches)
          .where(eq(integrationProductionDispatches.orderId, access.id))
          .orderBy(desc(integrationProductionDispatches.id))
          .limit(200);
        return { items: rows.map(toDispatchItem) };
      });
    },

    async listDispatches(principal, input = {}): Promise<{ items: ProductionDispatchItem[] }> {
      if (principal.state !== "full" || principal.pendingSteps.length > 0) {
        throw new DomainError(
          "REMEDIATION_REQUIRED",
          "ACCOUNT_STEP_PENDING",
          "Please finish securing your account to continue.",
        );
      }
      if (principal.role !== "admin") {
        throw forbidden("ADMIN_REQUIRED");
      }
      await reconcileStaleDispatches({
        verifyCallerBeforeMutate: () => verifyAdminCaller(principal),
      });

      return deps.db.transaction(async (tx) => {
        await assertProductionTriggerInTx(deps, principal, tx);

        const conditions: SQL[] = [];
        if (input.phase) {
          conditions.push(eq(integrationProductionDispatches.phase, input.phase));
        }
        if (input.state) {
          conditions.push(eq(integrationProductionDispatches.state, input.state));
        }
        if (input.orderReference && input.orderReference.trim() !== "") {
          const prefix = escapeLikePrefix(input.orderReference.trim());
          conditions.push(like(integrationProductionDispatches.orderReference, `${prefix}%`));
        }
        if (input.fromDate) {
          conditions.push(gte(integrationProductionDispatches.createdAt, input.fromDate));
        }
        if (input.toDate) {
          conditions.push(lte(integrationProductionDispatches.createdAt, input.toDate));
        }

        const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
        const rows = await tx
          .select()
          .from(integrationProductionDispatches)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(integrationProductionDispatches.id))
          .limit(limit);

        return { items: rows.map(toDispatchItem) };
      });
    },
  };
}
