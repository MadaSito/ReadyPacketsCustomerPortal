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
import { and, asc, desc, eq, gte, inArray, like, lte, type SQL } from "drizzle-orm";
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
  isValidProductionAuthHeaderName,
  isValidProductionWebhookUrl,
  readIntegrationFlag,
} from "../settings.js";
import type { ProviderState } from "../smtp.js";
import {
  buildP101Payload,
  buildP201FromDeliveredP101,
  CANON_VERSION_PATTERN,
  maskP101PayloadForRole,
  maskSecretWebhookUrl,
  RUN_MODE_PATTERN,
  validateP101,
  validateP201,
  type P101Payload,
  type P201Payload,
  type PayloadValidationIssue,
} from "./payload.js";

export const PRODUCTION_DELIVERY_JOB = "integrations.production.deliver" as const;
export const PRODUCTION_RECONCILE_JOB = "integrations.production.reconcile" as const;
export const PRODUCTION_MAX_ATTEMPTS = 5 as const;
/** Extra grace beyond `timeoutMs` before an interrupted `sending` row is reconciled to `failed` and `payload_enc` cleared. */
export const PRODUCTION_SENDING_GRACE_MS = 30_000 as const;
/** Maximum age (15 minutes) before an unclaimed/orphaned `queued` row is reconciled to `failed` and `payload_enc` cleared. */
export const PRODUCTION_STALE_QUEUED_MS = 900_000 as const;

export type ProductionPhase = "P101" | "P201";
export type ProductionDispatchState = "queued" | "sending" | "delivered" | "failed" | "dead";
export type ProductionValidationIssue = PayloadValidationIssue;
export type ControlledResendReason =
  | "OPERATOR_RETRY_AFTER_INTERRUPTION"
  | "OPERATOR_RETRY_AFTER_DEAD_LETTER"
  | "OPERATOR_RETRY_AFTER_FAILURE"
  | "OPERATOR_REPLAY_DELIVERED";

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
  authHeaderName: string;
  authHeaderValueConfigured: boolean;
  canonVersion: string;
  runMode: string;
  timeoutMs: number;
}

export interface UpdateProductionSettingsInput {
  enabled: boolean;
  /** Omit/`undefined` to keep existing secret, `null` to clear, HTTPS URL string to replace. */
  p101Url?: string | null;
  /** Omit/`undefined` to keep existing secret, `null` to clear, HTTPS URL string to replace. */
  p201Url?: string | null;
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
  p101: {
    eligible: boolean;
    alreadyDelivered: boolean;
    activeState: ProductionDispatchState | null;
    validationErrors: ProductionValidationIssue[];
    payload: P101Payload | null;
    maskedForViewer: boolean;
  };
  p201: {
    eligible: boolean;
    p101Delivered: boolean;
    alreadyDelivered: boolean;
    activeState: ProductionDispatchState | null;
    validationErrors: ProductionValidationIssue[];
    payload: P201Payload | null;
  };
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
  testDestination(principal: SessionPrincipal, input: { phase: ProductionPhase }): Promise<ProductionDryRunResult>;
  previewOrder(
    principal: SessionPrincipal,
    input: { orderPublicId: string; releaseStatus?: string },
  ): Promise<ProductionOrderPreview>;
  requestP101(principal: SessionPrincipal, input: RequestP101Input): Promise<ProductionDispatchItem>;
  requestP201(principal: SessionPrincipal, input: RequestP201Input): Promise<ProductionDispatchItem>;
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
      return "Delivery attempt was interrupted before completion; verify downstream state before re-sending.";
    case "PRODUCTION_QUEUE_STALLED":
      return "Queued dispatch timed out before worker pickup; payload cleared.";
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
    case "PRODUCTION_NOT_CONFIGURED":
      return "Canceled before delivery because production webhooks are disabled or incomplete.";
    case "PRODUCTION_PAYLOAD_MISSING":
    case "PRODUCTION_PAYLOAD_DECRYPT_FAILED":
    case "PRODUCTION_PAYLOAD_HASH_MISMATCH":
    case "PRODUCTION_PAYLOAD_INVALID":
      return "Canceled before delivery because stored payload integrity verification failed.";
    default: {
      const safeCode = /^[A-Z0-9_]{2,64}$/.test(reasonCode) ? reasonCode : "PRODUCTION_DELIVERY_FAILED";
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
    latestPhaseRow.lastReasonCode === "PRODUCTION_DELIVERY_INTERRUPTED" ||
    latestPhaseRow.lastReasonCode === "PRODUCTION_AMBIGUOUS_IN_FLIGHT" ||
    latestPhaseRow.lastReasonCode === "PRODUCTION_QUEUE_STALLED"
  ) {
    return "OPERATOR_RETRY_AFTER_INTERRUPTION";
  }
  if (latestPhaseRow.state === "dead") {
    return "OPERATOR_RETRY_AFTER_DEAD_LETTER";
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

function isRowStale(row: Pick<DispatchRow, "state" | "updatedAt">, now: Date, timeoutMs: number): boolean {
  const ageMs = now.getTime() - row.updatedAt.getTime();
  if (row.state === "sending") {
    return ageMs >= timeoutMs + PRODUCTION_SENDING_GRACE_MS;
  }
  if (row.state === "queued") {
    return ageMs >= PRODUCTION_STALE_QUEUED_MS;
  }
  return false;
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
    idempotencyKey: row.idempotencyKey,
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
    idempotency_key: row.idempotencyKey,
    ...extra,
  };
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

  function computeDestinationFingerprint(
    phase: ProductionPhase,
    params: {
      targetUrl: string;
      authHeaderName: string;
      authHeaderValue: string | null;
      canonVersion: string;
      runMode: string;
    },
  ): string {
    const normalizedHeaderName = params.authHeaderName.trim().toLowerCase();
    const effectiveHeaderValue = normalizedHeaderName !== "" ? (params.authHeaderValue ?? "") : "";
    const tuple =
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
    return deps.crypto.blindIndex(JSON.stringify(tuple), destinationFingerprintPurpose(phase));
  }

  async function readProductionState(tx?: Tx) {
    const [enabled, cfg, p101Secret, p201Secret, authValueConfigured] = await Promise.all([
      readIntegrationFlag(deps.settings, INTEGRATIONS_PRODUCTION_FLAG, tx),
      readSetting(deps.settings, INTEGRATIONS_PRODUCTION_CONFIG, tx),
      readSecret(deps.settings, INTEGRATIONS_PRODUCTION_P101_URL, tx),
      readSecret(deps.settings, INTEGRATIONS_PRODUCTION_P201_URL, tx),
      isSecretConfigured(deps.settings, INTEGRATIONS_PRODUCTION_AUTH_VALUE, tx),
    ]);

    const p101UrlConfigured = Boolean(p101Secret && isValidProductionWebhookUrl(p101Secret));
    const p201UrlConfigured = Boolean(p201Secret && isValidProductionWebhookUrl(p201Secret));
    const authHeaderValid = isValidProductionAuthHeaderName(cfg.authHeaderName);
    const authConsistent = authHeaderValid && (cfg.authHeaderName === "" || authValueConfigured);
    const canonTrimmed = cfg.canonVersion.trim();
    const canonValid =
      canonTrimmed.length > 0 && CANON_VERSION_PATTERN.test(canonTrimmed) && hasNoHeaderInjection(canonTrimmed);
    const runModeValid = RUN_MODE_PATTERN.test(cfg.runMode.trim());
    const configured = p101UrlConfigured && p201UrlConfigured && canonValid && runModeValid && authConsistent;

    return {
      enabled,
      cfg,
      p101Secret,
      p201Secret,
      p101UrlConfigured,
      p201UrlConfigured,
      authValueConfigured,
      configured,
    };
  }

  async function reconcileStaleDispatchesInTx(
    tx: Tx,
    options: { orderId?: number; now: Date; timeoutMs: number; correlationId?: string },
  ): Promise<number> {
    const predicates: SQL[] = [inArray(integrationProductionDispatches.state, ["sending", "queued"])];
    if (options.orderId !== undefined) {
      predicates.push(eq(integrationProductionDispatches.orderId, options.orderId));
    }

    const candidates = await tx
      .select()
      .from(integrationProductionDispatches)
      .where(and(...predicates))
      .orderBy(asc(integrationProductionDispatches.id))
      .for("update")
      .limit(200);

    let reconciledCount = 0;
    for (const row of candidates) {
      if (!isRowStale(row, options.now, options.timeoutMs)) {
        continue;
      }

      const wasSending = row.state === "sending";
      const reasonCode = wasSending ? "PRODUCTION_DELIVERY_INTERRUPTED" : "PRODUCTION_QUEUE_STALLED";
      const summary = fixedDispatchSummary(reasonCode, row.httpStatus, "failed");

      await tx
        .update(integrationProductionDispatches)
        .set({
          state: "failed",
          payloadEnc: null,
          lastReasonCode: reasonCode,
          responseSummary: summary,
          finalizedAt: options.now,
          updatedAt: options.now,
          version: row.version + 1,
        })
        .where(eq(integrationProductionDispatches.id, row.id));

      await deps.audit.record(
        {
          category: "integration",
          eventName: "integration.production.dispatch.failed",
          action: "reconcile",
          outcome: "failed",
          severity: "WARN",
          provider: "production_webhook",
          reasonCode,
          correlationId: options.correlationId ?? row.correlationId,
          actor: JOB_AUDIT_ACTOR,
          resource: { type: "integration_production_dispatch", publicId: row.publicId },
          attributes: buildSafeDispatchAuditAttributes(row, {
            retryable: false,
            reconciled: true,
            delivery_uncertain: wasSending,
          }),
        },
        tx,
      );

      reconciledCount += 1;
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
      p101UrlConfigured,
      p201UrlConfigured,
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
      authHeaderName: cfg.authHeaderName,
      authHeaderValueConfigured: authValueConfigured,
      canonVersion: cfg.canonVersion,
      runMode: cfg.runMode,
      timeoutMs: cfg.timeoutMs,
    };
  }

  async function evaluateP101CandidateInTx(
    tx: Tx,
    orderId: number,
    releaseStatusOverride?: string,
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
    },
  ): Promise<void> {
    await deps.audit.record(
      {
        category: "integration",
        eventName: "integration.production.dispatch.refused",
        action: input.isResend ? "resend" : "request",
        outcome: "denied",
        severity: "WARN",
        provider: "production_webhook",
        reasonCode: input.reasonCode,
        resource: { type: "order", publicId: input.orderPublicId },
        attributes: {
          phase: input.phase,
          order_public_id: input.orderPublicId,
          packet: input.packet ?? null,
          tier: input.tier ?? null,
          bundle_scope_manifest: input.bundleScopeManifest ?? null,
          http_status: null,
        },
      },
      tx,
    );
  }

  async function enqueueDispatchInTx(
    tx: Tx,
    params: {
      principal: SessionPrincipal;
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
      phase1ArtifactsConfirmed: boolean;
    },
  ): Promise<ProductionDispatchItem> {
    const now = deps.clock.now();
    const publicId = ulid();
    const idempotencyKey = `rp-prod:${params.phase.toLowerCase()}:${publicId}`;
    const payloadJson = JSON.stringify(params.payloadObject);
    const payloadSha256 = sha256Hex(payloadJson);
    const payloadEnc = deps.crypto.encrypt(payloadJson, dispatchPayloadAad(publicId));
    const correlationId = getRequestContext()?.correlationId ?? ulid();

    await tx.insert(integrationProductionDispatches).values({
      publicId,
      orderId: params.orderId,
      orderPublicId: params.orderPublicId,
      orderReference: params.orderReference,
      expectedOwnerUserId: params.expectedOwnerUserId,
      destinationFingerprint: params.destinationFingerprint,
      phase: params.phase,
      state: "queued",
      attemptCount: 0,
      idempotencyKey,
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
      phase1ArtifactsConfirmed: params.phase1ArtifactsConfirmed,
      requestedByUserId: params.principal.userId,
      requestedByPublicId: params.principal.userPublicId,
      correlationId,
      deliveredAt: null,
      finalizedAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });

    await deps.jobs.enqueue(
      PRODUCTION_DELIVERY_JOB,
      { dispatchId: publicId },
      {
        idempotencyKey: publicId,
        maxAttempts: PRODUCTION_MAX_ATTEMPTS,
        correlationId,
      },
      tx,
    );

    const reqAttrs: Record<string, SafeAttributeValue> = {
      phase: params.phase,
      order_public_id: params.orderPublicId,
      packet: params.packet,
      tier: params.tier,
      bundle_scope_manifest: params.bundleScopeManifest,
      http_status: null,
      idempotency_key: idempotencyKey,
    };
    if (params.isResend && params.resendReasonCode) {
      reqAttrs.resend_reason_code = params.resendReasonCode;
    }

    await deps.audit.record(
      {
        category: "integration",
        eventName: params.isResend
          ? "integration.production.dispatch.resent"
          : "integration.production.dispatch.requested",
        action: params.isResend ? "resend" : "request",
        outcome: "completed",
        severity: params.isResend ? "WARN" : "INFO",
        provider: "production_webhook",
        resource: { type: "integration_production_dispatch", publicId },
        attributes: reqAttrs,
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
  ): Promise<void> {
    const summary = fixedDispatchSummary(reasonCode, row.httpStatus, "failed");
    await tx
      .update(integrationProductionDispatches)
      .set({
        state: "failed",
        payloadEnc: null,
        lastReasonCode: reasonCode,
        responseSummary: summary,
        finalizedAt: now,
        updatedAt: now,
        version: row.version + 1,
      })
      .where(eq(integrationProductionDispatches.id, row.id));

    await deps.audit.record(
      {
        category: "integration",
        eventName: "integration.production.dispatch.failed",
        action: "deliver",
        outcome: "failed",
        severity,
        provider: "production_webhook",
        reasonCode,
        correlationId,
        actor: JOB_AUDIT_ACTOR,
        resource: { type: "integration_production_dispatch", publicId: row.publicId },
        attributes: buildSafeDispatchAuditAttributes(row, { retryable: false, ...extraAttrs }),
      },
      tx,
    );
  }

  /* ------------------------------------------------- Background Delivery Job Handler */

  type ClaimDecision =
    | { kind: "canceled"; reasonCode: string }
    | { kind: "already_completed" }
    | { kind: "already_failed"; reasonCode: string }
    | { kind: "ambiguous_sending" }
    | { kind: "terminal_failed"; reasonCode: string }
    | {
        kind: "ready";
        row: DispatchRow;
        targetUrl: string;
        authHeaderName: string;
        authHeaderValue: string | null;
        timeoutMs: number;
        payloadJson: string;
      };

  async function handleDeliveryJob(job: ClaimedJob<{ dispatchId: string }>): Promise<JobResult> {
    const dispatchId = job.payload.dispatchId;
    if (typeof dispatchId !== "string" || dispatchId.length !== 26) {
      return { outcome: "canceled", reasonCode: "INVALID_DISPATCH_ID" };
    }

    // Phase 1: Fenced DB transaction to validate destination fingerprint, order eligibility, and claim `queued -> sending`.
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
      if (row.state === "delivered") {
        return { kind: "already_completed" };
      }
      if (row.state === "failed" || row.state === "dead") {
        return { kind: "already_failed", reasonCode: row.lastReasonCode ?? "PRODUCTION_ALREADY_FINAL" };
      }

      const now = deps.clock.now();
      if (row.state === "sending") {
        // PW-02: Never auto-replay a preexisting ambiguous `sending` marker; immediately scrub `payloadEnc`
        // and finalize the dispatch to `failed` so operator re-send is never permanently blocked.
        await failTerminalBeforeSendInTx(
          tx,
          row,
          now,
          "PRODUCTION_AMBIGUOUS_IN_FLIGHT",
          job.correlationId,
          "WARN",
          { delivery_uncertain: true },
        );
        return { kind: "ambiguous_sending" };
      }

      if (!row.payloadEnc) {
        await failTerminalBeforeSendInTx(tx, row, now, "PRODUCTION_PAYLOAD_MISSING", job.correlationId, "ERROR");
        return { kind: "terminal_failed", reasonCode: "PRODUCTION_PAYLOAD_MISSING" };
      }

      const prodState = await readProductionState(tx);
      const phase = row.phase as ProductionPhase;
      const targetUrl = phase === "P101" ? prodState.p101Secret : prodState.p201Secret;
      const authHeaderValue =
        prodState.cfg.authHeaderName !== ""
          ? await readSecret(deps.settings, INTEGRATIONS_PRODUCTION_AUTH_VALUE, tx)
          : null;

      if (!prodState.enabled) {
        await failTerminalBeforeSendInTx(tx, row, now, "PRODUCTION_NOT_CONFIGURED", job.correlationId);
        return { kind: "terminal_failed", reasonCode: "PRODUCTION_NOT_CONFIGURED" };
      }

      // PW-04: Pin dispatch to the exact destination, auth header, and canon/runMode authorized at queue time.
      // Any change (including via generic Platform settings) cancels the queued/retried dispatch with DESTINATION_CHANGED.
      if (!targetUrl || !prodState.configured || !isValidProductionWebhookUrl(targetUrl)) {
        const currentFpWhenIncomplete = computeDestinationFingerprint(phase, {
          targetUrl: targetUrl ?? "",
          authHeaderName: prodState.cfg.authHeaderName,
          authHeaderValue,
          canonVersion: prodState.cfg.canonVersion,
          runMode: prodState.cfg.runMode,
        });
        const reasonCode =
          currentFpWhenIncomplete !== row.destinationFingerprint
            ? "DESTINATION_CHANGED"
            : "PRODUCTION_NOT_CONFIGURED";
        await failTerminalBeforeSendInTx(tx, row, now, reasonCode, job.correlationId);
        return { kind: "terminal_failed", reasonCode };
      }

      const currentFingerprint = computeDestinationFingerprint(phase, {
        targetUrl,
        authHeaderName: prodState.cfg.authHeaderName,
        authHeaderValue,
        canonVersion: prodState.cfg.canonVersion,
        runMode: prodState.cfg.runMode,
      });
      if (currentFingerprint !== row.destinationFingerprint) {
        await failTerminalBeforeSendInTx(tx, row, now, "DESTINATION_CHANGED", job.correlationId);
        return { kind: "terminal_failed", reasonCode: "DESTINATION_CHANGED" };
      }

      // PW-03: Re-validate current order existence, legal-hold/lock state, cancellation, owner binding, and scope BEFORE send.
      const orders = requireOrders();
      const identity = requireIdentity();
      const scope = await orders.getProductionScope(row.orderId, { tx });
      if (!scope) {
        await failTerminalBeforeSendInTx(tx, row, now, "ORDER_NOT_FOUND", job.correlationId);
        return { kind: "terminal_failed", reasonCode: "ORDER_NOT_FOUND" };
      }
      if (isOrderLockedForProduction(scope.lockState)) {
        await failTerminalBeforeSendInTx(tx, row, now, "ORDER_LOCKED", job.correlationId);
        return { kind: "terminal_failed", reasonCode: "ORDER_LOCKED" };
      }
      if (isOrderCanceledStatus(scope.statusKey)) {
        await failTerminalBeforeSendInTx(tx, row, now, "ORDER_CANCELED", job.correlationId);
        return { kind: "terminal_failed", reasonCode: "ORDER_CANCELED" };
      }
      if (scope.ownerUserId !== row.expectedOwnerUserId) {
        await failTerminalBeforeSendInTx(tx, row, now, "ORDER_OWNER_CHANGED", job.correlationId);
        return { kind: "terminal_failed", reasonCode: "ORDER_OWNER_CHANGED" };
      }
      const owner = await identity.getUser(scope.ownerUserId, { tx });
      if (!owner || owner.status !== "active") {
        await failTerminalBeforeSendInTx(tx, row, now, "ORDER_OWNER_INACTIVE", job.correlationId);
        return { kind: "terminal_failed", reasonCode: "ORDER_OWNER_INACTIVE" };
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
          await failTerminalBeforeSendInTx(tx, row, now, "ORDER_SCOPE_CHANGED", job.correlationId);
          return { kind: "terminal_failed", reasonCode: "ORDER_SCOPE_CHANGED" };
        }
      }

      let payloadJson: string;
      try {
        payloadJson = deps.crypto.decrypt(row.payloadEnc, dispatchPayloadAad(row.publicId));
      } catch {
        await failTerminalBeforeSendInTx(
          tx,
          row,
          now,
          "PRODUCTION_PAYLOAD_DECRYPT_FAILED",
          job.correlationId,
          "ERROR",
        );
        return { kind: "terminal_failed", reasonCode: "PRODUCTION_PAYLOAD_DECRYPT_FAILED" };
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
              : validateP201(parsed, {
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
        await failTerminalBeforeSendInTx(tx, row, now, reasonCode, job.correlationId, "ERROR");
        return { kind: "terminal_failed", reasonCode };
      }

      await tx
        .update(integrationProductionDispatches)
        .set({
          state: "sending",
          attemptCount: job.attempt,
          updatedAt: now,
          version: row.version + 1,
        })
        .where(eq(integrationProductionDispatches.id, row.id));

      return {
        kind: "ready",
        row: { ...row, state: "sending", attemptCount: job.attempt, version: row.version + 1 },
        targetUrl,
        authHeaderName: prodState.cfg.authHeaderName,
        authHeaderValue,
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
    if (decision.kind === "already_failed" || decision.kind === "terminal_failed") {
      if (decision.kind === "terminal_failed") {
        await checks.recordOutcome("production", "failed", decision.reasonCode);
      }
      return { outcome: "failed", reasonCode: decision.reasonCode, retryable: false };
    }
    if (decision.kind === "ambiguous_sending") {
      await checks.recordOutcome("production", "failed", "PRODUCTION_AMBIGUOUS_IN_FLIGHT");
      return { outcome: "unknown", reasonCode: "PRODUCTION_AMBIGUOUS_IN_FLIGHT" };
    }

    // Phase 2: Single outbound HTTPS POST with single-evaluation allowlist + public-only IP pinning.
    await job.assertStillOwned();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Idempotency-Key": decision.row.idempotencyKey,
      "X-ReadyPackets-Delivery": decision.row.publicId,
      "X-Correlation-Id": job.correlationId,
    };
    if (decision.authHeaderName && decision.authHeaderValue) {
      headers[decision.authHeaderName] = decision.authHeaderValue;
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

    // Phase 3: Fenced finalization transaction.
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
      if (locked.state === "delivered") {
        return { outcome: "completed" };
      }

      const now = deps.clock.now();
      if (attemptOutcome.kind === "delivered") {
        const summary = fixedDispatchSummary("PRODUCTION_DELIVERED", attemptOutcome.httpStatus, "delivered");
        await tx
          .update(integrationProductionDispatches)
          .set({
            state: "delivered",
            payloadEnc: null,
            httpStatus: attemptOutcome.httpStatus,
            responseSummary: summary,
            lastReasonCode: "PRODUCTION_DELIVERED",
            deliveredAt: now,
            finalizedAt: now,
            updatedAt: now,
            version: locked.version + 1,
          })
          .where(eq(integrationProductionDispatches.id, locked.id));

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
            httpStatus: attemptOutcome.httpStatus,
            responseSummary: summary,
            lastReasonCode: attemptOutcome.reasonCode,
            finalizedAt: now,
            updatedAt: now,
            version: locked.version + 1,
          })
          .where(eq(integrationProductionDispatches.id, locked.id));

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
        // Put row back to `queued` with `payloadEnc` intact for the bounded retry window.
        const summary = fixedDispatchSummary(attemptOutcome.reasonCode, attemptOutcome.httpStatus, "queued");
        await tx
          .update(integrationProductionDispatches)
          .set({
            state: "queued",
            httpStatus: attemptOutcome.httpStatus,
            responseSummary: summary,
            lastReasonCode: attemptOutcome.reasonCode,
            updatedAt: now,
            version: locked.version + 1,
          })
          .where(eq(integrationProductionDispatches.id, locked.id));

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
          httpStatus: attemptOutcome.httpStatus,
          responseSummary: summary,
          lastReasonCode: attemptOutcome.reasonCode,
          finalizedAt: now,
          updatedAt: now,
          version: locked.version + 1,
        })
        .where(eq(integrationProductionDispatches.id, locked.id));

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

    if (result.outcome === "completed") {
      await checks.recordOutcome("production", "succeeded", "PRODUCTION_DELIVERED");
    } else if (result.outcome === "failed") {
      await checks.recordOutcome("production", "failed", result.reasonCode);
    }

    return result;
  }

  async function handleReconcileJob(job: ClaimedJob<Record<string, never>>): Promise<JobResult> {
    await deps.db.transaction(async (tx) => {
      await job.assertStillOwned(tx);
      const cfg = await readSetting(deps.settings, INTEGRATIONS_PRODUCTION_CONFIG, tx);
      await reconcileStaleDispatchesInTx(tx, {
        now: deps.clock.now(),
        timeoutMs: cfg.timeoutMs,
        correlationId: job.correlationId,
      });
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

        const [existingP101, existingP201, existingAuthVal] = await Promise.all([
          isSecretConfigured(deps.settings, INTEGRATIONS_PRODUCTION_P101_URL, tx),
          isSecretConfigured(deps.settings, INTEGRATIONS_PRODUCTION_P201_URL, tx),
          isSecretConfigured(deps.settings, INTEGRATIONS_PRODUCTION_AUTH_VALUE, tx),
        ]);

        const nextP101Configured = input.p101Url === undefined ? existingP101 : input.p101Url !== null;
        const nextP201Configured = input.p201Url === undefined ? existingP201 : input.p201Url !== null;
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
          { canonVersion, runMode, timeoutMs, authHeaderName },
          tx,
        );
        await deps.settings.set(flagKey(INTEGRATIONS_PRODUCTION_FLAG.flag), input.enabled, tx);

        if (input.p101Url !== undefined || input.p201Url !== undefined) {
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
              auth_header_configured: authHeaderName !== "",
              auth_header_value_configured: nextAuthValConfigured,
            },
          },
          tx,
        );
      });

      return loadSettingsView();
    },

    async testDestination(principal, input): Promise<ProductionDryRunResult> {
      const checkedAt = deps.clock.now();
      assertIntegrationsManagePreflight(principal, checkedAt);

      // Re-validate actor in-transaction before resolving any destination DNS.
      await deps.db.transaction(async (tx) => {
        await assertIntegrationsManageInTx(deps, principal, tx);
      });

      const secretDef =
        input.phase === "P101" ? INTEGRATIONS_PRODUCTION_P101_URL : INTEGRATIONS_PRODUCTION_P201_URL;
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

      return deps.db.transaction(async (tx) => {
        // PW-05: Order check before Identity actor check.
        const access = await orders.assertCanReadOrder(principal, input.orderPublicId, { tx });
        await assertProductionTriggerInTx(deps, principal, tx);

        const candidate = await evaluateP101CandidateInTx(tx, access.id, input.releaseStatus);
        await reconcileStaleDispatchesInTx(tx, {
          orderId: access.id,
          now: deps.clock.now(),
          timeoutMs: candidate.prodState.cfg.timeoutMs,
        });

        const existingRows = await tx
          .select()
          .from(integrationProductionDispatches)
          .where(eq(integrationProductionDispatches.orderId, access.id))
          .orderBy(desc(integrationProductionDispatches.id));

        const p101Rows = existingRows.filter((r) => r.phase === "P101");
        const p201Rows = existingRows.filter((r) => r.phase === "P201");

        const deliveredP101 = p101Rows.find((r) => r.state === "delivered") ?? null;
        const latestP101 = p101Rows[0] ?? null;
        const deliveredP201 = p201Rows.find((r) => r.state === "delivered") ?? null;
        const latestP201 = p201Rows[0] ?? null;

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

        const p201Errors: ProductionValidationIssue[] = [];
        let previewP201Payload: P201Payload | null = null;
        if (isOrderLockedForProduction(candidate.scope.lockState)) {
          p201Errors.push({
            code: "ORDER_LOCKED",
            message: "This order is locked and cannot dispatch production webhooks.",
          });
        }
        if (isOrderCanceledStatus(candidate.scope.statusKey)) {
          p201Errors.push({
            code: "ORDER_CANCELED",
            message: "Canceled orders cannot dispatch production webhooks.",
          });
        }
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

        return {
          featureEnabled: candidate.featureEnabled,
          featureConfigured: candidate.featureConfigured,
          p101: {
            eligible: p101Eligible,
            alreadyDelivered: Boolean(deliveredP101),
            activeState: latestP101 ? (latestP101.state as ProductionDispatchState) : null,
            validationErrors: candidate.validationErrors,
            payload: previewP101Payload,
            maskedForViewer,
          },
          p201: {
            eligible: p201Eligible,
            p101Delivered: Boolean(deliveredP101),
            alreadyDelivered: Boolean(deliveredP201),
            activeState: latestP201 ? (latestP201.state as ProductionDispatchState) : null,
            validationErrors: p201Errors,
            payload: previewP201Payload,
          },
        };
      });
    },

    async requestP101(principal, input): Promise<ProductionDispatchItem> {
      assertProductionTriggerPreflight(principal);
      const orders = requireOrders();

      const outcome = await deps.db.transaction(
        async (tx): Promise<{ ok: true; item: ProductionDispatchItem } | { ok: false; error: DomainError }> => {
          // PW-05: Lock order row FOR UPDATE FIRST, then lock/revalidate Identity actor SECOND.
          const access = await orders.assertCanReadOrder(principal, input.orderPublicId, {
            tx,
            forUpdate: true,
          });
          await assertProductionTriggerInTx(deps, principal, tx);

          const candidate = await evaluateP101CandidateInTx(tx, access.id, input.releaseStatus);
          await reconcileStaleDispatchesInTx(tx, {
            orderId: access.id,
            now: deps.clock.now(),
            timeoutMs: candidate.prodState.cfg.timeoutMs,
          });

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
                first.code === "ORDER_LOCKED" || first.code === "ORDER_CANCELED"
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

          await reconcileStaleDispatchesInTx(tx, {
            orderId: access.id,
            now: deps.clock.now(),
            timeoutMs: prodState.cfg.timeoutMs,
          });

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

    async resend(principal, input): Promise<ProductionDispatchItem> {
      const now = deps.clock.now();
      assertProductionResendPreflight(principal, now);

      const reason = input.reason.trim();
      if (reason.length < 3 || reason.length > 280 || !hasNoHeaderInjection(reason)) {
        throw validation("RESEND_REASON_REQUIRED", "Enter a re-send reason between 3 and 280 characters.");
      }

      const orders = requireOrders();
      const identity = requireIdentity();
      const outcome = await deps.db.transaction(
        async (tx): Promise<{ ok: true; item: ProductionDispatchItem } | { ok: false; error: DomainError }> => {
          // PW-05: Lock order row FOR UPDATE FIRST, then lock/revalidate Identity actor + post-lock step-up SECOND.
          const access = await orders.assertCanReadOrder(principal, input.orderPublicId, {
            tx,
            forUpdate: true,
          });
          await assertProductionResendInTx(deps, principal, tx);

          const cfgForReconcile = await readSetting(deps.settings, INTEGRATIONS_PRODUCTION_CONFIG, tx);
          // PW-02: Reconcile any stale `sending`/`queued` rows before checking in-progress state so expired
          // interrupted attempts never permanently block administrative re-send.
          await reconcileStaleDispatchesInTx(tx, {
            orderId: access.id,
            now: deps.clock.now(),
            timeoutMs: cfgForReconcile.timeoutMs,
          });

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

          // PW-07: Classify into controlled server code; NEVER store or audit raw `input.reason` prose.
          const resendReasonCode = classifyResendReasonCode(phaseRows[0]!);

          if (input.phase === "P101") {
            const candidate = await evaluateP101CandidateInTx(tx, access.id, input.releaseStatus);
            if (!candidate.featureEnabled || !candidate.featureConfigured || !candidate.prodState.p101Secret) {
              await recordRefusedAuditInTx(tx, {
                phase: "P101",
                orderPublicId: access.publicId,
                reasonCode: "PRODUCTION_WEBHOOKS_NOT_ENABLED",
                isResend: true,
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
                isResend: true,
              });
              return {
                ok: false,
                error:
                  first.code === "ORDER_LOCKED" || first.code === "ORDER_CANCELED"
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
              isResend: true,
              resendReasonCode,
              phase1ArtifactsConfirmed: false,
            });
            return { ok: true, item };
          }

          // P201 re-send
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
              isResend: true,
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
              isResend: true,
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
              isResend: true,
            });
            return {
              ok: false,
              error: validation(
                "ORDER_OWNER_INACTIVE",
                "The order owner account must be active to dispatch production webhooks.",
              ),
            };
          }

          if (input.phase1ArtifactsConfirmed !== true) {
            await recordRefusedAuditInTx(tx, {
              phase: "P201",
              orderPublicId: access.publicId,
              reasonCode: "PHASE1_ARTIFACTS_CONFIRMATION_REQUIRED",
              isResend: true,
            });
            return {
              ok: false,
              error: validation(
                "PHASE1_ARTIFACTS_CONFIRMATION_REQUIRED",
                "Confirm that the Phase I final artifacts exist before re-sending Phase II (P201).",
              ),
            };
          }

          if (!prodState.enabled || !prodState.configured || !prodState.p201Secret) {
            await recordRefusedAuditInTx(tx, {
              phase: "P201",
              orderPublicId: access.publicId,
              reasonCode: "PRODUCTION_WEBHOOKS_NOT_ENABLED",
              isResend: true,
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
              phase: "P201",
              orderPublicId: access.publicId,
              reasonCode: "PRODUCTION_P101_NOT_DELIVERED",
              isResend: true,
            });
            return {
              ok: false,
              error: conflict(
                "PRODUCTION_P101_NOT_DELIVERED",
                "Phase II (P201) cannot be re-sent until Phase I (P101) has been delivered for this order.",
              ),
            };
          }

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
              isResend: true,
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
            isResend: true,
            resendReasonCode,
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

    async orderHistory(principal, input): Promise<{ items: ProductionDispatchItem[] }> {
      assertProductionTriggerPreflight(principal);
      const orders = requireOrders();

      return deps.db.transaction(async (tx) => {
        // PW-05: Order check before Identity actor check.
        const access = await orders.assertCanReadOrder(principal, input.orderPublicId, { tx });
        await assertProductionTriggerInTx(deps, principal, tx);

        const cfg = await readSetting(deps.settings, INTEGRATIONS_PRODUCTION_CONFIG, tx);
        await reconcileStaleDispatchesInTx(tx, {
          orderId: access.id,
          now: deps.clock.now(),
          timeoutMs: cfg.timeoutMs,
        });

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

      return deps.db.transaction(async (tx) => {
        await assertProductionTriggerInTx(deps, principal, tx);

        const cfg = await readSetting(deps.settings, INTEGRATIONS_PRODUCTION_CONFIG, tx);
        await reconcileStaleDispatchesInTx(tx, {
          now: deps.clock.now(),
          timeoutMs: cfg.timeoutMs,
        });

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
