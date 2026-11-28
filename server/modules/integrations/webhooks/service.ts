/**
 * Increment 04 Package I — Webhooks Service (`services.integrations.webhooks`).
 *
 * Implements Decisions 10 & 11:
 *  - Ships disabled by default (`integrations.webhooks` feature flag off); toggling is step-up gated & audited
 *  - Outbound subscriptions over `egress` (`purpose: "webhook"`, `https:443`, mandatory allowlist, public IPs only,
 *    pinned DNS lookup, redirect refusal), HMAC-SHA256 signing (`t=...,v1=...`) with secret overlap rotation,
 *    exponential backoff, and automatic `disabled_failing` transition after sustained terminal failures
 *  - Subscribes to non-`staffOnly` triggers in the automation trigger catalogue (`AuditTap` + `publish()`)
 *  - Inbound endpoints (`POST /api/webhooks/inbound/:endpointPublicId`) verifying constant-time HMAC-SHA256
 *    and ±5m timestamp window over raw `Buffer` BEFORE `JSON.parse`, deduplicating external event IDs, and
 *    emitting `integration.webhook.inbound_received` (`webhook.inbound_received` trigger — automations ONLY)
 *  - Unified outbound/inbound log with redacted headers & bodies (`<= 64 KiB`, `FieldCrypto` AES-256-GCM at rest,
 *    configurable `retentionDays` `0..90`, default `30`) and `api.replay`-gated `redeliver` / `reprocessInbound`
 */
import { and, asc, desc, eq, gte, inArray, like, lt, lte, or, sql, type SQL } from "drizzle-orm";
import type { ModuleDeps } from "../../../container.js";
import { DomainError, conflict, validation } from "../../../core/errors.js";
import { ulid } from "../../../core/ids.js";
import { getRequestContext } from "../../../core/requestContext.js";

const notFound = (reason: string, safeMessage = "The requested item was not found.") =>
  new DomainError("NOT_FOUND", reason, safeMessage);
const forbidden = (reason: string, safeMessage = "You do not have permission to perform this action.") =>
  new DomainError("FORBIDDEN", reason, safeMessage);
const unavailable = (reason: string, safeMessage: string) =>
  new DomainError("UNAVAILABLE", reason, safeMessage);

function currentCorrelationId(): string {
  const ctx = getRequestContext();
  return ctx?.correlationId ?? ctx?.requestId ?? ulid();
}
import type { ClaimedJob, DbOrTx, JobResult, ModuleHealth, SessionPrincipal, Tx } from "../../../core/types.js";
import type { AuditTap, AuditTapEvent } from "../../audit/tap.js";
import { TRIGGER_CATALOGUE, entriesForEvent, type TriggerCatalogueEntry } from "../../audit/triggerCatalogue.js";
import { registerAutomationTrigger } from "../../automations/contracts.js";
import { readSetting, writeSetting } from "../../platform/index.js";
import type { ApiCaller, ApiListQuery, ApiPage, WebhookSubscriptionDto } from "../../publicApi/ports.js";
import {
  assertAdminStepUpAnyInTx,
  assertAdminStepUpAnyPreflight,
  assertApiReplayInTx,
  assertApiReplayPreflight,
  assertWebhooksManageInTx,
  assertWebhooksManagePreflight,
  assertWebhooksRead,
} from "../authz.js";
import type { EgressPolicy } from "../egress.js";
import {
  integrationWebhookDeliveries,
  integrationWebhookDeliveryAttempts,
  integrationWebhookInboundEndpoints,
  integrationWebhookSubscriptions,
} from "../schema.js";
import {
  DEFAULT_WEBHOOKS_CONFIG,
  INTEGRATIONS_WEBHOOKS_CONFIG,
  INTEGRATIONS_WEBHOOKS_FLAG,
  hasNoHeaderInjection,
  readIntegrationFlag,
  type WebhooksConfigSetting,
} from "../settings.js";
import {
  MAX_INBOUND_RAW_BODY_BYTES,
  MAX_LOGGED_BODY_BYTES,
  MAX_TIMESTAMP_SKEW_SECONDS,
  decryptAttemptResponse,
  decryptDeliveryPayload,
  deliveryTapEventAad,
  encryptAttemptResponse,
  encryptDeliveryPayload,
  generateWebhookSigningSecret,
  inboundSecretAad,
  maskWebhookTargetUrl,
  redactAndBoundBody,
  redactHeaderMap,
  sha256Hex,
  signWebhookPayload,
  subscriptionSecretAad,
  subscriptionUrlAad,
  verifyInboundWebhookSignature,
} from "./crypto.js";
import type {
  CreateWebhookInboundEndpointInput,
  CreateWebhookSubscriptionInput,
  InboundHttpReceiveInput,
  InboundHttpReceiveResult,
  ListWebhookDeliveriesInput,
  UpdateWebhookInboundEndpointInput,
  UpdateWebhookSubscriptionInput,
  UpdateWebhooksSettingsInput,
  WebhookCatalogueEventView,
  WebhookDeliveryAttemptView,
  WebhookDeliveryDetailView,
  WebhookDeliveryListItemView,
  WebhookDeliveryStatus,
  WebhookDirection,
  WebhookInboundEndpointView,
  WebhookPublishOptions,
  WebhookSubscriptionStatus,
  WebhookSubscriptionView,
  WebhooksService,
  WebhooksSettingsView,
} from "./types.js";

export const WEBHOOK_DELIVER_JOB = "integrations.webhooks.deliver" as const;
export const WEBHOOK_PURGE_JOB = "integrations.webhooks.purge_logs" as const;
export const WEBHOOK_MAX_ATTEMPTS = 5 as const;

const DAY_MS = 86_400_000;
const DEFAULT_OVERLAP_MINUTES = 60;
const ENDPOINT_KEY_RE = /^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/;
const EVENT_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,118}$/;
const PUBLIC_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/* ----------------------------------------------------- static automation trigger registration */

registerAutomationTrigger({
  key: "webhook.inbound_received",
  entry: {
    key: "webhook.inbound_received",
    label: "Inbound webhook received",
    group: "Operations",
    description: "Fires when a verified signed inbound webhook event arrives on an enabled endpoint.",
    owner: "integrations",
    eventName: "integration.webhook.inbound_received",
    outcomes: ["completed"],
    resourceType: "webhook_inbound_endpoint",
    fields: [
      { key: "endpoint_public_id", label: "Endpoint public ID", type: "string", from: "event" },
      { key: "endpoint_key", label: "Endpoint key", type: "string", from: "event" },
      { key: "event_type", label: "Event type", type: "string", from: "event" },
      { key: "is_replay", label: "Is reprocessed", type: "boolean", from: "event" },
      { key: "external_event_id", label: "External event ID", type: "string", from: "context" },
    ],
    recipients: [],
  },
  resolveContext: async ({ event, db }) => {
    const deliveryPubId =
      typeof event.attributes.delivery_public_id === "string" ? event.attributes.delivery_public_id : null;
    if (!deliveryPubId) return { fields: { external_event_id: null } };
    const rows = await db
      .select({ externalEventId: integrationWebhookDeliveries.externalEventId })
      .from(integrationWebhookDeliveries)
      .where(eq(integrationWebhookDeliveries.publicId, deliveryPubId))
      .limit(1);
    return {
      fields: {
        external_event_id: rows[0]?.externalEventId ?? null,
      },
    };
  },
});

/* ----------------------------------------------------- cursor helpers */

interface IdCursor {
  t: number;
  id: number;
}

function encodeCursor(createdAt: Date, id: number): string {
  return Buffer.from(JSON.stringify({ t: createdAt.getTime(), id }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | null | undefined): IdCursor | null {
  if (!cursor) return null;
  if (cursor.length > 200) throw validation("INVALID_CURSOR", "Pagination cursor is not valid.");
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as IdCursor).t === "number" &&
      Number.isFinite((parsed as IdCursor).t) &&
      typeof (parsed as IdCursor).id === "number" &&
      Number.isSafeInteger((parsed as IdCursor).id) &&
      (parsed as IdCursor).id > 0
    ) {
      return parsed as IdCursor;
    }
  } catch {
    // fall through
  }
  throw validation("INVALID_CURSOR", "Pagination cursor is not valid.");
}

function validateHttpsWebhookUrlSyntax(rawUrl: string): URL {
  const trimmed = rawUrl.trim();
  if (trimmed.length < 10 || trimmed.length > 2048 || !hasNoHeaderInjection(trimmed)) {
    throw validation("INVALID_WEBHOOK_URL", "Enter a valid HTTPS destination URL (up to 2,048 characters).");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw validation("INVALID_WEBHOOK_URL", "Enter a valid HTTPS destination URL.");
  }
  if (parsed.protocol !== "https:") {
    throw validation("WEBHOOK_HTTPS_REQUIRED", "Outbound webhook destinations must use HTTPS.");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw forbidden("EGRESS_USERINFO_FORBIDDEN", "Outbound URLs must not contain embedded credentials.");
  }
  if (parsed.hash !== "") {
    throw validation("INVALID_WEBHOOK_URL", "Outbound webhook URLs must not include a URL fragment (#).");
  }
  if (parsed.port !== "" && parsed.port !== "443") {
    throw validation("WEBHOOK_PORT_FORBIDDEN", "Outbound webhook destinations must use HTTPS port 443.");
  }
  return parsed;
}

function safeAuditToken(raw: string, fallback: string, maxLen = 64): string {
  const cleaned = raw.trim().replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, maxLen);
  return cleaned.length > 0 && /^[A-Za-z0-9]/.test(cleaned) ? cleaned : fallback;
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

type SubscriptionRow = typeof integrationWebhookSubscriptions.$inferSelect;
type InboundRow = typeof integrationWebhookInboundEndpoints.$inferSelect;
type DeliveryRow = typeof integrationWebhookDeliveries.$inferSelect;
type AttemptRow = typeof integrationWebhookDeliveryAttempts.$inferSelect;

class OrderTrashedWebhookAbortError extends Error {
  constructor() {
    super("ORDER_TRASHED");
    this.name = "OrderTrashedWebhookAbortError";
  }
}

export function createWebhooksService(deps: ModuleDeps, egress: EgressPolicy): WebhooksService {
  async function isOrderPublicIdTrashed(orderPublicId: string, tx?: Tx): Promise<boolean> {
    const orders = deps.services.orders;
    if (
      !orders ||
      typeof orders.isTrashedInTx !== "function" ||
      typeof orders.getOrderRefByPublicId !== "function"
    ) {
      return false;
    }
    const ref = await orders.getOrderRefByPublicId(orderPublicId, tx);
    return ref === null;
  }
  function getFullCatalogue(): readonly TriggerCatalogueEntry[] {
    return deps.services.automations?.listTriggerCatalogue() ?? TRIGGER_CATALOGUE;
  }

  function getSubscribableCatalogue(): TriggerCatalogueEntry[] {
    return getFullCatalogue().filter((entry) => entry.staffOnly !== true);
  }

  function assertValidSubscribableEvents(events: readonly string[]): string[] {
    const unique = Array.from(new Set(events.map((e) => e.trim()).filter(Boolean)));
    if (unique.length === 0 || unique.length > 200) {
      throw validation("INVALID_WEBHOOK_EVENTS", "Select between 1 and 200 events for this subscription.");
    }
    const fullCatalogue = getFullCatalogue();
    const byKey = new Map(fullCatalogue.map((e) => [e.key, e]));
    for (const key of unique) {
      const entry = byKey.get(key);
      if (!entry) {
        throw validation("UNKNOWN_WEBHOOK_EVENT", "One or more selected events are not in the event catalogue.");
      }
      if (entry.staffOnly === true) {
        throw forbidden("STAFF_ONLY_TRIGGER_FORBIDDEN", "Internal staff-only events cannot be sent to external webhooks.");
      }
    }
    return unique;
  }

  async function readConfig(tx?: Tx): Promise<{ enabled: boolean } & WebhooksConfigSetting> {
    const [enabled, cfg] = await Promise.all([
      readIntegrationFlag(deps.settings, INTEGRATIONS_WEBHOOKS_FLAG, tx),
      readSetting(deps.settings, INTEGRATIONS_WEBHOOKS_CONFIG, tx),
    ]);
    return {
      enabled,
      retentionDays: cfg.retentionDays ?? DEFAULT_WEBHOOKS_CONFIG.retentionDays,
      autoDisableThreshold: cfg.autoDisableThreshold ?? DEFAULT_WEBHOOKS_CONFIG.autoDisableThreshold,
      deliveryTimeoutMs: cfg.deliveryTimeoutMs ?? DEFAULT_WEBHOOKS_CONFIG.deliveryTimeoutMs,
    };
  }

  function computeExpiry(now: Date, retentionDays: number): Date {
    if (retentionDays <= 0) return now;
    return new Date(now.getTime() + retentionDays * DAY_MS);
  }

  function isDeliveryPurged(row: DeliveryRow, now: Date): boolean {
    return row.bodyPurged || !row.payloadEnc || row.expiresAt.getTime() <= now.getTime();
  }

  function canReplayDelivery(row: DeliveryRow, now: Date): boolean {
    if (row.bodyTruncated) return false;
    if (isDeliveryPurged(row, now)) return false;
    if (row.direction === "outbound") {
      return (
        row.status === "delivered" ||
        row.status === "failed" ||
        row.status === "dead" ||
        row.status === "unknown" ||
        row.status === "stopped"
      );
    }
    return row.status === "processed" || row.status === "duplicate";
  }

  function canStopDelivery(row: DeliveryRow): boolean {
    if (row.direction !== "outbound") return false;
    return row.status === "queued" || row.status === "retrying";
  }

  function canRetryDelivery(row: DeliveryRow, now: Date): boolean {
    if (row.direction !== "outbound") return false;
    if (row.bodyTruncated || row.bodyPurged || row.expiresAt.getTime() <= now.getTime()) return false;
    if (!row.payloadEnc && !row.tapEventEnc) return false;
    return row.status === "failed" || row.status === "dead" || row.status === "stopped";
  }

  async function emitWebhookOpsAlert(params: {
    dedupKey: string;
    severity: "warning" | "error" | "critical";
    code: string;
    title: string;
    text?: string;
    orderPublicId?: string | null;
    correlationId?: string;
  }): Promise<void> {
    const opsAlerts = deps.services.opsAlerts;
    if (!opsAlerts) return;
    try {
      await opsAlerts.emit({
        source: "webhook",
        severity: params.severity,
        dedupKey: params.dedupKey,
        code: params.code,
        title: params.title,
        ...(params.text ? { text: params.text } : {}),
        ...(params.orderPublicId ? { orderPublicId: params.orderPublicId } : {}),
        ...(params.correlationId ? { correlationId: params.correlationId } : {}),
      });
    } catch {
      // Operational alerts are advisory diagnostics; never roll back webhook state updates.
    }
  }

  async function resolveWebhookOpsAlert(dedupKey: string, correlationId?: string): Promise<void> {
    const opsAlerts = deps.services.opsAlerts;
    if (!opsAlerts) return;
    try {
      await opsAlerts.resolve({
        source: "webhook",
        dedupKey,
        ...(correlationId ? { correlationId } : {}),
      });
    } catch {
      // Non-fatal diagnostic resolution.
    }
  }

  function toSubscriptionView(row: SubscriptionRow, now: Date): WebhookSubscriptionView {
    let events: string[] = [];
    try {
      const parsed = JSON.parse(row.eventsJson) as unknown;
      if (Array.isArray(parsed)) events = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      events = [];
    }
    const overlapActive =
      Boolean(row.previousSecretEnc) &&
      row.previousSecretExpiresAt instanceof Date &&
      now.getTime() < row.previousSecretExpiresAt.getTime();
    return {
      publicId: row.publicId,
      name: row.name,
      description: row.description,
      targetUrlHost: row.targetUrlHost,
      targetUrlMasked: row.targetUrlMasked,
      events,
      status: row.status as WebhookSubscriptionStatus,
      signingEnabled: row.signingEnabled !== false,
      signingSecretLast4: row.signingSecretLast4,
      hasOverlapSecret: overlapActive,
      overlapExpiresAt: overlapActive ? row.previousSecretExpiresAt : null,
      consecutiveFailures: row.consecutiveFailures,
      lastDeliveredAt: row.lastDeliveredAt,
      lastFailedAt: row.lastFailedAt,
      lastFailureReason: row.lastFailureReason,
      autoDisabledAt: row.autoDisabledAt,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  function toInboundView(row: InboundRow, now: Date): WebhookInboundEndpointView {
    const overlapActive =
      Boolean(row.previousSecretEnc) &&
      row.previousSecretExpiresAt instanceof Date &&
      now.getTime() < row.previousSecretExpiresAt.getTime();
    return {
      publicId: row.publicId,
      name: row.name,
      endpointKey: row.endpointKey,
      description: row.description,
      enabled: row.enabled,
      receivePath: `/api/webhooks/inbound/${row.publicId}`,
      signingSecretLast4: row.signingSecretLast4,
      hasOverlapSecret: overlapActive,
      overlapExpiresAt: overlapActive ? row.previousSecretExpiresAt : null,
      toleranceSeconds: row.toleranceSeconds,
      lastReceivedAt: row.lastReceivedAt,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  function toDeliveryListItemView(row: DeliveryRow, now: Date): WebhookDeliveryListItemView {
    const purged = isDeliveryPurged(row, now);
    return {
      publicId: row.publicId,
      direction: row.direction as WebhookDirection,
      subscriptionPublicId: row.subscriptionPublicId,
      inboundEndpointPublicId: row.inboundEndpointPublicId,
      targetLabel: row.targetLabel,
      eventKey: row.eventKey,
      externalEventId: row.externalEventId,
      status: row.status as WebhookDeliveryStatus,
      httpMethod: row.httpMethod,
      httpPath: row.httpPath,
      httpStatus: row.httpStatus,
      durationMs: row.durationMs,
      requestBytes: row.requestBytes,
      responseBytes: row.responseBytes,
      attemptCount: row.attemptCount,
      maxAttempts: row.maxAttempts,
      reasonCode: row.reasonCode,
      correlationId: row.correlationId,
      actorLabel: row.actorLabel,
      bodyTruncated: row.bodyTruncated,
      bodyPurged: purged,
      isReplay: row.isReplay,
      replayOfPublicId: row.replayOfPublicId,
      isTest: row.isTest,
      canReplay: canReplayDelivery(row, now),
      canRetry: canRetryDelivery(row, now),
      canStop: canStopDelivery(row),
      orderPublicId: row.orderPublicId ?? null,
      stageKey: row.stageKey ?? null,
      manualRetryCount: row.manualRetryCount ?? 0,
      stoppedAt: row.stoppedAt ?? null,
      stoppedByPublicId: row.stoppedByPublicId ?? null,
      stopReason: row.stopReason ?? null,
      expiresAt: row.expiresAt,
      completedAt: row.completedAt,
      createdAt: row.createdAt,
    };
  }

  async function loadDeliveryDetail(row: DeliveryRow, now: Date): Promise<WebhookDeliveryDetailView> {
    const base = toDeliveryListItemView(row, now);
    const attemptRows = await deps.db
      .select()
      .from(integrationWebhookDeliveryAttempts)
      .where(eq(integrationWebhookDeliveryAttempts.deliveryId, row.id))
      .orderBy(asc(integrationWebhookDeliveryAttempts.attemptNumber));

    const purged = base.bodyPurged;
    const decoded = purged ? null : decryptDeliveryPayload(deps.crypto, row.publicId, row.payloadEnc);
    const attempts: WebhookDeliveryAttemptView[] = attemptRows.map((a: AttemptRow) => {
      const decAttempt = purged ? null : decryptAttemptResponse(deps.crypto, a.publicId, a.responseEnc);
      return {
        publicId: a.publicId,
        attemptNumber: a.attemptNumber,
        outcome: a.outcome as WebhookDeliveryAttemptView["outcome"],
        httpStatus: a.httpStatus,
        durationMs: a.durationMs,
        reasonCode: a.reasonCode,
        responseBytes: a.responseBytes,
        responseHeaders: decAttempt?.responseHeaders ?? null,
        responseBody: decAttempt?.responseBody ?? null,
        occurredAt: a.occurredAt,
      };
    });

    return {
      ...base,
      payloadSha256: row.payloadSha256,
      requestHeaders: decoded?.requestHeaders ?? null,
      requestBody: decoded?.requestBody ?? null,
      responseHeaders: decoded?.responseHeaders ?? null,
      responseBody: decoded?.responseBody ?? null,
      attempts,
    };
  }

  function buildSearchText(parts: Array<string | null | undefined>): string {
    return parts
      .filter((p): p is string => Boolean(p && p.trim()))
      .join(" ")
      .replace(/\s+/g, " ")
      .slice(0, 512);
  }

  /* --------------------------------------------------- outbound execution core */

  async function resolveInitialOutboundBody(row: DeliveryRow, signal?: AbortSignal): Promise<{
    rawJson: string;
    bodyTruncated: boolean;
  }> {
    const existing = decryptDeliveryPayload(deps.crypto, row.publicId, row.payloadEnc);
    if (existing?.requestBody) {
      return { rawJson: existing.requestBody, bodyTruncated: row.bodyTruncated };
    }
    if (!row.tapEventEnc) {
      const fallback = JSON.stringify({
        id: row.publicId,
        event: row.eventKey,
        createdAt: row.createdAt.toISOString(),
        correlationId: row.correlationId,
        data: {},
      });
      return { rawJson: fallback, bodyTruncated: false };
    }

    const tapEvent = JSON.parse(
      deps.crypto.decrypt(row.tapEventEnc, deliveryTapEventAad(row.publicId)),
    ) as AuditTapEvent;
    const resolved = await deps.services.automations?.resolveTriggerEventFields({
      triggerKey: row.eventKey,
      event: tapEvent,
      signal,
    });
    if (resolved?.staffOnly) {
      throw forbidden("STAFF_ONLY_TRIGGER_FORBIDDEN", "Staff-only events cannot be dispatched to external webhooks.");
    }
    const envelopeObj = {
      id: row.publicId,
      event: row.eventKey,
      sourceEventId: tapEvent.eventId,
      occurredAt: tapEvent.occurredAt,
      correlationId: row.correlationId,
      resource: tapEvent.resource?.publicId
        ? { type: tapEvent.resource.type, id: tapEvent.resource.publicId }
        : null,
      data: resolved?.fields ?? {},
    };
    const redacted = redactAndBoundBody(JSON.stringify(envelopeObj));
    return { rawJson: redacted.body, bodyTruncated: redacted.truncated };
  }

  async function executeOutboundAttempt(input: {
    deliveryPublicId: string;
    fencingToken: number;
    assertStillOwned?: (tx?: Tx) => Promise<void>;
    signal?: AbortSignal;
    inlineImmediate?: boolean;
  }): Promise<JobResult> {
    const cfg = await readConfig();
    const now = deps.clock.now();

    const rows = await deps.db
      .select()
      .from(integrationWebhookDeliveries)
      .where(eq(integrationWebhookDeliveries.publicId, input.deliveryPublicId))
      .limit(1);
    const row = rows[0];
    if (!row || row.direction !== "outbound" || !row.subscriptionId) {
      return { outcome: "canceled", reasonCode: "DELIVERY_NOT_FOUND" };
    }
    if (row.status === "stopped") {
      return {
        outcome: "canceled",
        reasonCode: row.reasonCode === "ORDER_TRASHED" ? "ORDER_TRASHED" : "DELIVERY_STOPPED",
      };
    }
    if (row.orderPublicId && (await isOrderPublicIdTrashed(row.orderPublicId))) {
      await deps.db
        .update(integrationWebhookDeliveries)
        .set({
          status: "stopped",
          reasonCode: "ORDER_TRASHED",
          stopReason: "ORDER_TRASHED",
          stoppedAt: now,
          nextAttemptAt: null,
          tapEventEnc: null,
          payloadEnc: null,
          bodyPurged: true,
          completedAt: now,
          updatedAt: now,
          version: sql`${integrationWebhookDeliveries.version} + 1`,
        })
        .where(eq(integrationWebhookDeliveries.id, row.id));
      return { outcome: "canceled", reasonCode: "ORDER_TRASHED" };
    }
    if (
      row.status === "delivered" ||
      row.status === "failed" ||
      row.status === "dead" ||
      row.status === "unknown"
    ) {
      return { outcome: "completed" };
    }
    if (!cfg.enabled) {
      await deps.db
        .update(integrationWebhookDeliveries)
        .set({
          status: "failed",
          reasonCode: "WEBHOOKS_DISABLED",
          tapEventEnc: null,
          payloadEnc: cfg.retentionDays <= 0 ? null : row.payloadEnc,
          bodyPurged: cfg.retentionDays <= 0 ? true : row.bodyPurged,
          completedAt: now,
          updatedAt: now,
          version: sql`${integrationWebhookDeliveries.version} + 1`,
        })
        .where(eq(integrationWebhookDeliveries.id, row.id));
      return { outcome: "canceled", reasonCode: "WEBHOOKS_DISABLED" };
    }

    const subRows = await deps.db
      .select()
      .from(integrationWebhookSubscriptions)
      .where(eq(integrationWebhookSubscriptions.id, row.subscriptionId))
      .limit(1);
    const sub = subRows[0];
    if (!sub || (sub.status !== "active" && !row.isTest && !row.isReplay)) {
      const cancelNow = deps.clock.now();
      await deps.db
        .update(integrationWebhookDeliveries)
        .set({
          status: "failed",
          reasonCode: sub ? "SUBSCRIPTION_INACTIVE" : "SUBSCRIPTION_DELETED",
          tapEventEnc: null,
          payloadEnc: cfg.retentionDays <= 0 ? null : row.payloadEnc,
          bodyPurged: cfg.retentionDays <= 0 ? true : row.bodyPurged,
          completedAt: cancelNow,
          updatedAt: cancelNow,
          version: sql`${integrationWebhookDeliveries.version} + 1`,
        })
        .where(eq(integrationWebhookDeliveries.id, row.id));
      return { outcome: "canceled", reasonCode: sub ? "SUBSCRIPTION_INACTIVE" : "SUBSCRIPTION_DELETED" };
    }

    const attemptNumber = row.attemptCount + 1;
    await deps.db.transaction(async (tx) => {
      if (input.assertStillOwned) await input.assertStillOwned(tx);
      await tx
        .update(integrationWebhookDeliveries)
        .set({
          status: "delivering",
          attemptCount: attemptNumber,
          activeFencingToken: input.fencingToken,
          updatedAt: deps.clock.now(),
          version: sql`${integrationWebhookDeliveries.version} + 1`,
        })
        .where(eq(integrationWebhookDeliveries.id, row.id));
    });

    let bodyResult: { rawJson: string; bodyTruncated: boolean };
    try {
      bodyResult = await resolveInitialOutboundBody(row, input.signal);
    } catch (err) {
      const reasonCode = err instanceof DomainError ? err.reasonCode : "PAYLOAD_RESOLUTION_FAILED";
      const doneAt = deps.clock.now();
      await deps.db
        .update(integrationWebhookDeliveries)
        .set({
          status: "failed",
          reasonCode,
          tapEventEnc: null,
          completedAt: doneAt,
          updatedAt: doneAt,
          version: sql`${integrationWebhookDeliveries.version} + 1`,
        })
        .where(eq(integrationWebhookDeliveries.id, row.id));
      return { outcome: "failed", reasonCode, retryable: false };
    }

    const rawBodyBuf = Buffer.from(bodyResult.rawJson, "utf8");
    const targetUrl = deps.crypto.decrypt(sub.targetUrlEnc, subscriptionUrlAad(sub.publicId));
    const sendNow = deps.clock.now();
    const timestampSec = Math.floor(sendNow.getTime() / 1000);
    const signingEnabled = sub.signingEnabled !== false;
    let signatureHeader: string | null = null;
    if (signingEnabled) {
      const primarySecret = deps.crypto.decrypt(sub.signingSecretEnc, subscriptionSecretAad(sub.publicId));
      const overlapSecret =
        sub.previousSecretEnc &&
        sub.previousSecretExpiresAt instanceof Date &&
        sendNow.getTime() < sub.previousSecretExpiresAt.getTime()
          ? deps.crypto.decrypt(sub.previousSecretEnc, subscriptionSecretAad(sub.publicId))
          : null;
      signatureHeader = signWebhookPayload(rawBodyBuf, timestampSec, primarySecret, overlapSecret);
    }

    const requestHeaders: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
      "User-Agent": "ReadyPackets-Webhooks/1.0",
      "X-ReadyPackets-Event": row.eventKey,
      "X-ReadyPackets-Delivery": row.publicId,
      "X-ReadyPackets-Timestamp": String(timestampSec),
      ...(signatureHeader ? { "X-ReadyPackets-Signature": signatureHeader } : {}),
      "X-Correlation-Id": row.correlationId,
    };
    if (row.isReplay) {
      requestHeaders["X-ReadyPackets-Replay"] = "1";
    }

    const redactedReqHeaders = redactHeaderMap(requestHeaders);
    const payloadSha = sha256Hex(rawBodyBuf);
    const startedMs = deps.clock.now().getTime();
    let requestSent = false;

    try {
      const res = await egress.fetchPinned(targetUrl, "webhook", {
        method: "POST",
        headers: requestHeaders,
        body: rawBodyBuf,
        maxRequestBytes: MAX_LOGGED_BODY_BYTES + 4096,
        maxResponseBytes: MAX_LOGGED_BODY_BYTES,
        timeoutMs: cfg.deliveryTimeoutMs,
        signal: input.signal,
        requireAllowlistRule: true,
        publicAddressesOnly: true,
        beforeSend: async () => {
          if (input.assertStillOwned) await input.assertStillOwned();
          if (row.orderPublicId && (await isOrderPublicIdTrashed(row.orderPublicId))) {
            throw new OrderTrashedWebhookAbortError();
          }
          const [fresh] = await deps.db
            .select({ status: integrationWebhookDeliveries.status })
            .from(integrationWebhookDeliveries)
            .where(eq(integrationWebhookDeliveries.id, row.id))
            .limit(1);
          if (!fresh || fresh.status === "stopped") {
            throw new OrderTrashedWebhookAbortError();
          }
          requestSent = true;
        },
      });

      const finishedAt = deps.clock.now();
      const durationMs = Math.max(0, finishedAt.getTime() - startedMs);
      const redactedRespHeaders = redactHeaderMap(res.headers);
      const redactedRespBody = redactAndBoundBody(res.body);
      const attemptPubId = ulid();
      const succeeded = res.status >= 200 && res.status < 300;
      const retryableHttp = res.status === 429 || (res.status >= 500 && res.status <= 599);
      const hasMoreAttempts = !input.inlineImmediate && retryableHttp && attemptNumber < row.maxAttempts;
      const reasonCode = succeeded ? null : `HTTP_${res.status}`;
      const nextStatus: WebhookDeliveryStatus = succeeded
        ? "delivered"
        : hasMoreAttempts
          ? "retrying"
          : retryableHttp
            ? "dead"
            : "failed";
      const isTerminal = nextStatus === "delivered" || nextStatus === "failed" || nextStatus === "dead";
      const purgeNow = isTerminal && cfg.retentionDays <= 0;

      const payloadEnc = purgeNow
        ? null
        : encryptDeliveryPayload(deps.crypto, row.publicId, {
            requestHeaders: redactedReqHeaders,
            requestBody: bodyResult.rawJson,
            responseHeaders: redactedRespHeaders,
            responseBody: redactedRespBody.body,
          });
      const responseEnc = purgeNow
        ? null
        : encryptAttemptResponse(deps.crypto, attemptPubId, {
            responseHeaders: redactedRespHeaders,
            responseBody: redactedRespBody.body,
          });

      await deps.db.transaction(async (tx) => {
        if (input.assertStillOwned) await input.assertStillOwned(tx);
        await tx.insert(integrationWebhookDeliveryAttempts).values({
          publicId: attemptPubId,
          deliveryId: row.id,
          attemptNumber,
          outcome: succeeded ? "succeeded" : retryableHttp ? "failed" : "rejected",
          httpStatus: res.status,
          durationMs,
          reasonCode,
          responseBytes: res.body.byteLength,
          responseEnc,
          occurredAt: finishedAt,
        });

        await tx
          .update(integrationWebhookDeliveries)
          .set({
            status: nextStatus,
            httpStatus: res.status,
            durationMs,
            requestBytes: rawBodyBuf.byteLength,
            responseBytes: res.body.byteLength,
            reasonCode,
            payloadSha256: payloadSha,
            tapEventEnc: hasMoreAttempts ? row.tapEventEnc : null,
            payloadEnc,
            bodyTruncated: row.bodyTruncated || bodyResult.bodyTruncated,
            bodyPurged: purgeNow,
            completedAt: isTerminal ? finishedAt : null,
            updatedAt: finishedAt,
            version: sql`${integrationWebhookDeliveries.version} + 1`,
          })
          .where(eq(integrationWebhookDeliveries.id, row.id));

        if (succeeded) {
          await tx
            .update(integrationWebhookSubscriptions)
            .set({
              consecutiveFailures: 0,
              lastDeliveredAt: finishedAt,
              updatedAt: finishedAt,
              version: sql`${integrationWebhookSubscriptions.version} + 1`,
            })
            .where(eq(integrationWebhookSubscriptions.id, sub.id));

          await deps.audit.record(
            {
              category: "integration",
              eventName: "integration.webhook.delivered",
              action: "deliver",
              outcome: "completed",
              actor: { role: "system" },
              resource: { type: "webhook_subscription", publicId: sub.publicId },
              deliveryId: row.publicId,
              correlationId: row.correlationId,
              attributes: {
                delivery_public_id: row.publicId,
                event_key: safeAuditToken(row.eventKey, "event"),
                http_status: res.status,
                attempt_number: attemptNumber,
                is_replay: row.isReplay,
                is_test: row.isTest,
              },
            },
            tx,
          );
        } else if (isTerminal) {
          const newFailures = row.isTest ? sub.consecutiveFailures : sub.consecutiveFailures + 1;
          const shouldAutoDisable =
            !row.isTest && sub.status === "active" && newFailures >= cfg.autoDisableThreshold;
          await tx
            .update(integrationWebhookSubscriptions)
            .set({
              consecutiveFailures: newFailures,
              lastFailedAt: finishedAt,
              lastFailureReason: reasonCode,
              ...(shouldAutoDisable
                ? {
                    status: "disabled_failing",
                    autoDisabledAt: finishedAt,
                  }
                : {}),
              updatedAt: finishedAt,
              version: sql`${integrationWebhookSubscriptions.version} + 1`,
            })
            .where(eq(integrationWebhookSubscriptions.id, sub.id));

          await deps.audit.record(
            {
              category: "integration",
              eventName: "integration.webhook.delivery_failed",
              action: "deliver",
              outcome: "failed",
              severity: "WARN",
              reasonCode: reasonCode ?? "DELIVERY_FAILED",
              actor: { role: "system" },
              resource: { type: "webhook_subscription", publicId: sub.publicId },
              deliveryId: row.publicId,
              correlationId: row.correlationId,
              attributes: {
                delivery_public_id: row.publicId,
                event_key: safeAuditToken(row.eventKey, "event"),
                http_status: res.status,
                attempt_number: attemptNumber,
                is_replay: row.isReplay,
              },
            },
            tx,
          );

          if (shouldAutoDisable) {
            await deps.audit.record(
              {
                category: "integration",
                eventName: "integration.webhook.subscription_auto_disabled",
                action: "disable",
                outcome: "completed",
                severity: "WARN",
                reasonCode: "CONSECUTIVE_FAILURES_EXCEEDED",
                actor: { role: "system" },
                resource: { type: "webhook_subscription", publicId: sub.publicId },
                correlationId: row.correlationId,
                attributes: {
                  subscription_public_id: sub.publicId,
                  consecutive_failures: newFailures,
                  threshold: cfg.autoDisableThreshold,
                },
              },
              tx,
            );
          }
        }
      });

      if (succeeded) {
        if (!row.isTest) {
          await resolveWebhookOpsAlert(`webhook:sub:${sub.publicId}`, row.correlationId);
        }
        return { outcome: "completed" };
      }
      if (!row.isTest) {
        const subDisabled =
          isTerminal && sub.status === "active" && sub.consecutiveFailures + 1 >= cfg.autoDisableThreshold;
        if (subDisabled) {
          await emitWebhookOpsAlert({
            dedupKey: `webhook:sub:${sub.publicId}`,
            severity: "critical",
            code: "CONSECUTIVE_FAILURES_EXCEEDED",
            title: `Webhook subscription '${sub.name}' auto-disabled after repeated failures`,
            text: `Outbound webhook subscription '${sub.name}' reached ${sub.consecutiveFailures + 1} consecutive terminal failures (${reasonCode ?? "DELIVERY_FAILED"}).`,
            orderPublicId: row.orderPublicId ?? null,
            correlationId: row.correlationId,
          });
        } else if (isTerminal) {
          await emitWebhookOpsAlert({
            dedupKey: `webhook:sub:${sub.publicId}`,
            severity: "error",
            code: reasonCode ?? "DELIVERY_FAILED",
            title: `Webhook delivery failed for '${sub.name}'`,
            text: `Outbound webhook '${row.eventKey}' ended with ${nextStatus} (${reasonCode ?? "DELIVERY_FAILED"}).`,
            orderPublicId: row.orderPublicId ?? null,
            correlationId: row.correlationId,
          });
        } else if (attemptNumber >= 2) {
          await emitWebhookOpsAlert({
            dedupKey: `webhook:sub:${sub.publicId}`,
            severity: "warning",
            code: reasonCode ?? "DELIVERY_RETRYING",
            title: `Webhook delivery retrying for '${sub.name}'`,
            text: `Attempt ${attemptNumber} of ${row.maxAttempts} failed with ${reasonCode ?? "DELIVERY_RETRYING"} and is scheduled to retry.`,
            orderPublicId: row.orderPublicId ?? null,
            correlationId: row.correlationId,
          });
        }
      }
      return {
        outcome: "failed",
        reasonCode: reasonCode ?? "DELIVERY_FAILED",
        retryable: hasMoreAttempts,
      };
    } catch (err) {
      const finishedAt = deps.clock.now();
      if (err instanceof OrderTrashedWebhookAbortError) {
        await deps.db.transaction(async (tx) => {
          if (input.assertStillOwned) await input.assertStillOwned(tx);
          await tx
            .update(integrationWebhookDeliveries)
            .set({
              status: "stopped",
              attemptCount: Math.max(0, attemptNumber - 1),
              activeFencingToken: 0,
              reasonCode: "ORDER_TRASHED",
              stopReason: "ORDER_TRASHED",
              stoppedAt: finishedAt,
              nextAttemptAt: null,
              tapEventEnc: null,
              payloadEnc: null,
              bodyPurged: true,
              completedAt: finishedAt,
              updatedAt: finishedAt,
              version: sql`${integrationWebhookDeliveries.version} + 1`,
            })
            .where(eq(integrationWebhookDeliveries.id, row.id));
        });
        return { outcome: "canceled", reasonCode: "ORDER_TRASHED" };
      }
      const durationMs = Math.max(0, finishedAt.getTime() - startedMs);
      const reasonCode =
        err instanceof DomainError
          ? safeAuditToken(err.reasonCode, "NETWORK_ERROR")
          : "NETWORK_ERROR";
      const egressForbidden = err instanceof DomainError && err.code === "FORBIDDEN";
      const ambiguousPostWire = requestSent && !egressForbidden;
      const retryableNet = !requestSent && !egressForbidden && !input.inlineImmediate && attemptNumber < row.maxAttempts;
      const nextStatus: WebhookDeliveryStatus = ambiguousPostWire
        ? "unknown"
        : retryableNet
          ? "retrying"
          : "failed";
      const isTerminal = nextStatus === "unknown" || nextStatus === "failed";
      const purgeNow = isTerminal && cfg.retentionDays <= 0;
      const attemptPubId = ulid();

      const payloadEnc = purgeNow
        ? null
        : encryptDeliveryPayload(deps.crypto, row.publicId, {
            requestHeaders: redactedReqHeaders,
            requestBody: bodyResult.rawJson,
            responseHeaders: null,
            responseBody: null,
          });

      await deps.db.transaction(async (tx) => {
        if (input.assertStillOwned) {
          try {
            await input.assertStillOwned(tx);
          } catch {
            return;
          }
        }
        await tx.insert(integrationWebhookDeliveryAttempts).values({
          publicId: attemptPubId,
          deliveryId: row.id,
          attemptNumber,
          outcome: ambiguousPostWire ? "unknown" : egressForbidden ? "rejected" : "failed",
          httpStatus: null,
          durationMs,
          reasonCode,
          responseBytes: 0,
          responseEnc: null,
          occurredAt: finishedAt,
        });

        await tx
          .update(integrationWebhookDeliveries)
          .set({
            status: nextStatus,
            durationMs,
            requestBytes: rawBodyBuf.byteLength,
            reasonCode,
            payloadSha256: payloadSha,
            tapEventEnc: retryableNet ? row.tapEventEnc : null,
            payloadEnc,
            bodyTruncated: row.bodyTruncated || bodyResult.bodyTruncated,
            bodyPurged: purgeNow,
            completedAt: isTerminal ? finishedAt : null,
            updatedAt: finishedAt,
            version: sql`${integrationWebhookDeliveries.version} + 1`,
          })
          .where(eq(integrationWebhookDeliveries.id, row.id));

        if (isTerminal && !ambiguousPostWire) {
          const newFailures = row.isTest ? sub.consecutiveFailures : sub.consecutiveFailures + 1;
          const shouldAutoDisable =
            !row.isTest && sub.status === "active" && newFailures >= cfg.autoDisableThreshold;
          await tx
            .update(integrationWebhookSubscriptions)
            .set({
              consecutiveFailures: newFailures,
              lastFailedAt: finishedAt,
              lastFailureReason: reasonCode,
              ...(shouldAutoDisable
                ? {
                    status: "disabled_failing",
                    autoDisabledAt: finishedAt,
                  }
                : {}),
              updatedAt: finishedAt,
              version: sql`${integrationWebhookSubscriptions.version} + 1`,
            })
            .where(eq(integrationWebhookSubscriptions.id, sub.id));

          if (shouldAutoDisable) {
            await deps.audit.record(
              {
                category: "integration",
                eventName: "integration.webhook.subscription_auto_disabled",
                action: "disable",
                outcome: "completed",
                severity: "WARN",
                reasonCode: "CONSECUTIVE_FAILURES_EXCEEDED",
                actor: { role: "system" },
                resource: { type: "webhook_subscription", publicId: sub.publicId },
                correlationId: row.correlationId,
                attributes: {
                  subscription_public_id: sub.publicId,
                  consecutive_failures: newFailures,
                  threshold: cfg.autoDisableThreshold,
                },
              },
              tx,
            );
          }
        }
      });

      if (!row.isTest) {
        const subDisabled =
          isTerminal &&
          !ambiguousPostWire &&
          sub.status === "active" &&
          sub.consecutiveFailures + 1 >= cfg.autoDisableThreshold;
        if (subDisabled) {
          await emitWebhookOpsAlert({
            dedupKey: `webhook:sub:${sub.publicId}`,
            severity: "critical",
            code: "CONSECUTIVE_FAILURES_EXCEEDED",
            title: `Webhook subscription '${sub.name}' auto-disabled after repeated failures`,
            text: `Outbound webhook subscription '${sub.name}' reached ${sub.consecutiveFailures + 1} consecutive terminal failures (${reasonCode}).`,
            orderPublicId: row.orderPublicId ?? null,
            correlationId: row.correlationId,
          });
        } else if (isTerminal) {
          await emitWebhookOpsAlert({
            dedupKey: `webhook:sub:${sub.publicId}`,
            severity: "error",
            code: reasonCode,
            title: `Webhook delivery failed for '${sub.name}'`,
            text: `Outbound webhook '${row.eventKey}' ended with ${nextStatus} (${reasonCode}).`,
            orderPublicId: row.orderPublicId ?? null,
            correlationId: row.correlationId,
          });
        } else if (attemptNumber >= 2) {
          await emitWebhookOpsAlert({
            dedupKey: `webhook:sub:${sub.publicId}`,
            severity: "warning",
            code: reasonCode,
            title: `Webhook delivery retrying for '${sub.name}'`,
            text: `Attempt ${attemptNumber} of ${row.maxAttempts} failed with ${reasonCode} and is scheduled to retry.`,
            orderPublicId: row.orderPublicId ?? null,
            correlationId: row.correlationId,
          });
        }
      }

      if (ambiguousPostWire) {
        return { outcome: "unknown", reasonCode };
      }
      return { outcome: "failed", reasonCode, retryable: retryableNet };
    }
  }

  /* --------------------------------------------------- retention purge job */

  async function purgeExpiredLogs(): Promise<JobResult> {
    const now = deps.clock.now();
    const expired = await deps.db
      .select({ id: integrationWebhookDeliveries.id })
      .from(integrationWebhookDeliveries)
      .where(
        and(
          eq(integrationWebhookDeliveries.bodyPurged, false),
          lte(integrationWebhookDeliveries.expiresAt, now),
        ),
      )
      .limit(200);

    if (expired.length === 0) {
      return { outcome: "completed", safeCounts: { purged: 0 } };
    }
    const ids = expired.map((r) => r.id);
    await deps.db.transaction(async (tx) => {
      await tx
        .update(integrationWebhookDeliveries)
        .set({
          payloadEnc: null,
          tapEventEnc: null,
          bodyPurged: true,
          updatedAt: now,
          version: sql`${integrationWebhookDeliveries.version} + 1`,
        })
        .where(inArray(integrationWebhookDeliveries.id, ids));

      await tx
        .update(integrationWebhookDeliveryAttempts)
        .set({ responseEnc: null })
        .where(inArray(integrationWebhookDeliveryAttempts.deliveryId, ids));
    });
    return { outcome: "completed", safeCounts: { purged: ids.length } };
  }

  /* --------------------------------------------------- job & schedule registration */

  deps.jobs.register<{ deliveryPublicId: string }>(
    WEBHOOK_DELIVER_JOB,
    async (job: ClaimedJob<{ deliveryPublicId: string }>) =>
      executeOutboundAttempt({
        deliveryPublicId: job.payload.deliveryPublicId,
        fencingToken: job.fencingToken,
        assertStillOwned: (tx) => job.assertStillOwned(tx),
        signal: job.signal,
      }),
    { retrySafe: false },
  );

  deps.jobs.register(WEBHOOK_PURGE_JOB, async () => purgeExpiredLogs(), { retrySafe: true });
  deps.jobs.registerSchedule({
    name: "integrations.webhooks.purge_logs.hourly",
    type: WEBHOOK_PURGE_JOB,
    everyMs: 3_600_000,
  });

  /* --------------------------------------------------- AuditTap for catalogue events */

  const auditTap: AuditTap = {
    listens(eventName: string): boolean {
      const cat = getFullCatalogue();
      return cat.some((entry) => !entry.staffOnly && entry.eventName === eventName);
    },

    async onRecorded(event: AuditTapEvent, tx: Tx | undefined): Promise<void> {
      if (event.correlationId?.startsWith("automation:")) return;
      const dbOrTx = tx ?? deps.db;
      const cfg = await readConfig(tx);
      if (!cfg.enabled) return;

      const matchedEntries = (
        deps.services.automations?.matchingTriggersForEvent(event) ?? entriesForEvent(event)
      ).filter((entry) => entry.staffOnly !== true);
      if (matchedEntries.length === 0) return;

      const activeSubs = await dbOrTx
        .select()
        .from(integrationWebhookSubscriptions)
        .where(eq(integrationWebhookSubscriptions.status, "active"));
      if (activeSubs.length === 0) return;

      const now = deps.clock.now();
      const expiresAt = computeExpiry(now, cfg.retentionDays);
      const tapOrderPublicId =
        event.resource?.type === "order" && typeof event.resource.publicId === "string"
          ? event.resource.publicId
          : typeof event.attributes?.order_public_id === "string"
            ? event.attributes.order_public_id
            : null;
      if (tapOrderPublicId && (await isOrderPublicIdTrashed(tapOrderPublicId, tx))) {
        return;
      }
      const tapStageKey =
        typeof event.attributes?.stage_key === "string" ? event.attributes.stage_key.slice(0, 64) : null;

      for (const entry of matchedEntries) {
        for (const sub of activeSubs) {
          let subEvents: string[] = [];
          try {
            const parsed = JSON.parse(sub.eventsJson) as unknown;
            if (Array.isArray(parsed)) subEvents = parsed.filter((x): x is string => typeof x === "string");
          } catch {
            subEvents = [];
          }
          if (!subEvents.includes(entry.key)) continue;

          const deliveryPublicId = ulid();
          const dedupeKey = `tap:${sub.publicId}:${entry.key}:${event.eventId}`.slice(0, 160);
          const tapJson = JSON.stringify(event);
          const tapEventEnc = deps.crypto.encrypt(tapJson, deliveryTapEventAad(deliveryPublicId));
          const targetLabel = `${sub.name} (${sub.targetUrlHost})`.slice(0, 255);
          const searchText = buildSearchText([
            deliveryPublicId,
            entry.key,
            targetLabel,
            "queued",
            event.correlationId,
            tapOrderPublicId,
            tapStageKey,
          ]);

          const existing = await dbOrTx
            .select({ id: integrationWebhookDeliveries.id })
            .from(integrationWebhookDeliveries)
            .where(
              and(
                eq(integrationWebhookDeliveries.direction, "outbound"),
                eq(integrationWebhookDeliveries.deduplicationKey, dedupeKey),
              ),
            )
            .limit(1);
          if (existing.length > 0) continue;

          const corrId = event.correlationId ?? ulid();
          const { jobId } = await deps.jobs.enqueue(
            WEBHOOK_DELIVER_JOB,
            { deliveryPublicId },
            {
              idempotencyKey: `webhook_deliver:${deliveryPublicId}`,
              maxAttempts: WEBHOOK_MAX_ATTEMPTS,
              correlationId: corrId,
            },
            tx,
          );

          await dbOrTx.insert(integrationWebhookDeliveries).values({
            publicId: deliveryPublicId,
            direction: "outbound",
            subscriptionId: sub.id,
            subscriptionPublicId: sub.publicId,
            orderPublicId: tapOrderPublicId,
            stageKey: tapStageKey,
            targetLabel,
            eventKey: entry.key,
            externalEventId: event.eventId,
            deduplicationKey: dedupeKey,
            status: "queued",
            httpMethod: "POST",
            httpPath: sub.targetUrlMasked.slice(0, 255),
            attemptCount: 0,
            maxAttempts: WEBHOOK_MAX_ATTEMPTS,
            jobPublicId: jobId,
            correlationId: corrId,
            actorLabel: "system",
            payloadSha256: sha256Hex(tapJson),
            tapEventEnc,
            payloadEnc: null,
            bodyTruncated: false,
            bodyPurged: false,
            isReplay: false,
            isTest: false,
            searchText,
            expiresAt,
          });
        }
      }
    },
  };

  /* --------------------------------------------------- service methods */

  return {
    auditTap,

    init(): void {
      deps.services.auditCenter?.registerTap(auditTap);
      deps.services.publicApi?.registerProvider("webhookSubscriptions", {
        list: (query, caller) => this.listSubscriptionsPublicApi(query, caller),
        get: (publicId, caller) => this.getSubscriptionPublicApi(publicId, caller),
      });
    },

    async health(): Promise<ModuleHealth> {
      const checkedAt = deps.clock.now();
      const cfg = await readConfig();
      if (!cfg.enabled) {
        return {
          component: "integrations.webhooks",
          state: "disabled",
          summary: "Outbound and inbound webhooks are disabled by default.",
          checkedAt,
        };
      }
      const failing = await deps.db
        .select({ id: integrationWebhookSubscriptions.id })
        .from(integrationWebhookSubscriptions)
        .where(eq(integrationWebhookSubscriptions.status, "disabled_failing"))
        .limit(1);
      if (failing.length > 0) {
        return {
          component: "integrations.webhooks",
          state: "degraded",
          summary: "One or more webhook subscriptions were auto-disabled after repeated delivery failures.",
          checkedAt,
        };
      }
      return {
        component: "integrations.webhooks",
        state: "ok",
        summary: "Outbound and inbound webhooks are enabled.",
        checkedAt,
      };
    },

    async getSettings(principal: SessionPrincipal): Promise<WebhooksSettingsView> {
      assertWebhooksRead(principal);
      return readConfig();
    },

    async updateSettings(
      principal: SessionPrincipal,
      input: UpdateWebhooksSettingsInput,
    ): Promise<WebhooksSettingsView> {
      assertWebhooksManagePreflight(principal, deps.clock.now());
      return deps.db.transaction(async (tx) => {
        await assertWebhooksManageInTx(deps, principal, tx);
        const current = await readConfig(tx);
        const nextEnabled = input.enabled ?? current.enabled;
        const nextCfg: WebhooksConfigSetting = {
          retentionDays: input.retentionDays ?? current.retentionDays,
          autoDisableThreshold: input.autoDisableThreshold ?? current.autoDisableThreshold,
          deliveryTimeoutMs: input.deliveryTimeoutMs ?? current.deliveryTimeoutMs,
        };

        await deps.settings.set(INTEGRATIONS_WEBHOOKS_FLAG.key, nextEnabled, tx);
        await writeSetting(deps.settings, INTEGRATIONS_WEBHOOKS_CONFIG, nextCfg, tx);

        // If retentionDays is set to 0, immediately purge stored bodies.
        if (nextCfg.retentionDays === 0) {
          const now = deps.clock.now();
          await tx
            .update(integrationWebhookDeliveries)
            .set({
              payloadEnc: null,
              bodyPurged: true,
              expiresAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(integrationWebhookDeliveries.bodyPurged, false),
                inArray(integrationWebhookDeliveries.status, [
                  "delivered",
                  "failed",
                  "dead",
                  "unknown",
                  "processed",
                  "duplicate",
                  "rejected",
                ]),
              ),
            );
          await tx.update(integrationWebhookDeliveryAttempts).set({ responseEnc: null });
        }

        await deps.audit.record(
          {
            category: "admin",
            eventName: "integration.webhooks.settings_updated",
            action: "update",
            outcome: "completed",
            resource: { type: "integration_settings", publicId: "webhooks" },
            attributes: {
              enabled: nextEnabled,
              retention_days: nextCfg.retentionDays,
              auto_disable_threshold: nextCfg.autoDisableThreshold,
              delivery_timeout_ms: nextCfg.deliveryTimeoutMs,
            },
          },
          tx,
        );

        return { enabled: nextEnabled, ...nextCfg };
      });
    },

    async listCatalogueEvents(principal: SessionPrincipal): Promise<WebhookCatalogueEventView[]> {
      assertWebhooksRead(principal);
      return getSubscribableCatalogue().map((entry) => ({
        key: entry.key,
        label: entry.label,
        group: entry.group,
        description: entry.description,
      }));
    },

    async listSubscriptions(
      principal: SessionPrincipal,
      input: { status?: WebhookSubscriptionStatus; cursor?: string; limit?: number },
    ): Promise<{ items: WebhookSubscriptionView[]; nextCursor: string | null }> {
      assertWebhooksRead(principal);
      const limit = Math.min(100, Math.max(1, input.limit ?? 50));
      const decoded = decodeCursor(input.cursor);
      const predicates: SQL[] = [];
      if (input.status) {
        predicates.push(eq(integrationWebhookSubscriptions.status, input.status));
      }
      if (decoded) {
        const cursorDate = new Date(decoded.t);
        predicates.push(
          or(
            lt(integrationWebhookSubscriptions.createdAt, cursorDate),
            and(
              eq(integrationWebhookSubscriptions.createdAt, cursorDate),
              lt(integrationWebhookSubscriptions.id, decoded.id),
            ),
          )!,
        );
      }
      const rows = await deps.db
        .select()
        .from(integrationWebhookSubscriptions)
        .where(predicates.length > 0 ? and(...predicates) : undefined)
        .orderBy(desc(integrationWebhookSubscriptions.createdAt), desc(integrationWebhookSubscriptions.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      const now = deps.clock.now();
      return {
        items: page.map((r) => toSubscriptionView(r, now)),
        nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
      };
    },

    async getSubscription(principal: SessionPrincipal, publicId: string): Promise<WebhookSubscriptionView> {
      assertWebhooksRead(principal);
      const rows = await deps.db
        .select()
        .from(integrationWebhookSubscriptions)
        .where(eq(integrationWebhookSubscriptions.publicId, publicId))
        .limit(1);
      const row = rows[0];
      if (!row) throw notFound("WEBHOOK_SUBSCRIPTION_NOT_FOUND", "Webhook subscription not found.");
      return toSubscriptionView(row, deps.clock.now());
    },

    async createSubscription(
      principal: SessionPrincipal,
      input: CreateWebhookSubscriptionInput,
    ): Promise<{ subscription: WebhookSubscriptionView; signingSecretOnce: string }> {
      assertWebhooksManagePreflight(principal, deps.clock.now());
      const cleanName = input.name.trim();
      if (cleanName.length < 1 || cleanName.length > 120) {
        throw validation("INVALID_SUBSCRIPTION_NAME", "Enter a subscription name between 1 and 120 characters.");
      }
      const cleanDesc = input.description?.trim() ? input.description.trim().slice(0, 280) : null;
      validateHttpsWebhookUrlSyntax(input.targetUrl);
      const events = assertValidSubscribableEvents(input.events);

      // Must match an active `webhook` egress allowlist rule and resolve only to public IPs.
      await egress.resolveAndAssertAllowed({
        url: input.targetUrl.trim(),
        purpose: "webhook",
        allowedSchemes: ["https:"],
        requireAllowlistRule: true,
        publicAddressesOnly: true,
      });

      const masked = maskWebhookTargetUrl(input.targetUrl.trim());
      const publicId = ulid();
      const { secret, last4 } = generateWebhookSigningSecret();
      const targetUrlEnc = deps.crypto.encrypt(input.targetUrl.trim(), subscriptionUrlAad(publicId));
      const signingSecretEnc = deps.crypto.encrypt(secret, subscriptionSecretAad(publicId));
      const status: WebhookSubscriptionStatus = input.paused ? "paused" : "active";
      const signingEnabled = input.signingEnabled !== false;

      const row = await deps.db.transaction(async (tx) => {
        await assertWebhooksManageInTx(deps, principal, tx);
        await tx.insert(integrationWebhookSubscriptions).values({
          publicId,
          name: cleanName,
          description: cleanDesc,
          targetUrlEnc,
          targetUrlHost: masked.host,
          targetUrlMasked: masked.maskedUrl,
          eventsJson: JSON.stringify(events),
          status,
          signingEnabled,
          signingSecretEnc,
          signingSecretLast4: last4,
          createdByUserId: principal.userId,
          updatedByUserId: principal.userId,
        });

        await deps.audit.record(
          {
            category: "admin",
            eventName: "integration.webhook.subscription_created",
            action: "create",
            outcome: "completed",
            resource: { type: "webhook_subscription", publicId },
            attributes: {
              subscription_public_id: publicId,
              target_host: safeAuditToken(masked.host, "host", 120),
              event_count: events.length,
              status,
            },
          },
          tx,
        );

        const created = await tx
          .select()
          .from(integrationWebhookSubscriptions)
          .where(eq(integrationWebhookSubscriptions.publicId, publicId))
          .limit(1);
        return created[0]!;
      });

      return {
        subscription: toSubscriptionView(row, deps.clock.now()),
        signingSecretOnce: secret,
      };
    },

    async updateSubscription(
      principal: SessionPrincipal,
      input: UpdateWebhookSubscriptionInput,
    ): Promise<WebhookSubscriptionView> {
      assertWebhooksManagePreflight(principal, deps.clock.now());
      let newUrlMasked: { host: string; maskedUrl: string } | null = null;
      let newUrlPlain: string | null = null;
      if (input.targetUrl !== undefined) {
        validateHttpsWebhookUrlSyntax(input.targetUrl);
        newUrlPlain = input.targetUrl.trim();
        await egress.resolveAndAssertAllowed({
          url: newUrlPlain,
          purpose: "webhook",
          allowedSchemes: ["https:"],
          requireAllowlistRule: true,
          publicAddressesOnly: true,
        });
        newUrlMasked = maskWebhookTargetUrl(newUrlPlain);
      }
      const nextEvents = input.events !== undefined ? assertValidSubscribableEvents(input.events) : undefined;

      const updatedRow = await deps.db.transaction(async (tx) => {
        await assertWebhooksManageInTx(deps, principal, tx);
        const rows = await tx
          .select()
          .from(integrationWebhookSubscriptions)
          .where(eq(integrationWebhookSubscriptions.publicId, input.publicId))
          .limit(1);
        const existing = rows[0];
        if (!existing) throw notFound("WEBHOOK_SUBSCRIPTION_NOT_FOUND", "Webhook subscription not found.");
        if (existing.version !== input.expectedVersion) {
          throw conflict("VERSION_CONFLICT", "This subscription was updated elsewhere. Refresh and try again.");
        }

        const nextName = input.name !== undefined ? input.name.trim() : existing.name;
        if (nextName.length < 1 || nextName.length > 120) {
          throw validation("INVALID_SUBSCRIPTION_NAME", "Enter a subscription name between 1 and 120 characters.");
        }
        const nextDesc =
          input.description === undefined
            ? existing.description
            : input.description?.trim()
              ? input.description.trim().slice(0, 280)
              : null;

        const now = deps.clock.now();
        await tx
          .update(integrationWebhookSubscriptions)
          .set({
            name: nextName,
            description: nextDesc,
            ...(newUrlPlain && newUrlMasked
              ? {
                  targetUrlEnc: deps.crypto.encrypt(newUrlPlain, subscriptionUrlAad(existing.publicId)),
                  targetUrlHost: newUrlMasked.host,
                  targetUrlMasked: newUrlMasked.maskedUrl,
                }
              : {}),
            ...(nextEvents ? { eventsJson: JSON.stringify(nextEvents) } : {}),
            ...(input.signingEnabled !== undefined ? { signingEnabled: input.signingEnabled } : {}),
            updatedByUserId: principal.userId,
            updatedAt: now,
            version: existing.version + 1,
          })
          .where(
            and(
              eq(integrationWebhookSubscriptions.id, existing.id),
              eq(integrationWebhookSubscriptions.version, existing.version),
            ),
          );

        await deps.audit.record(
          {
            category: "admin",
            eventName: "integration.webhook.subscription_updated",
            action: "update",
            outcome: "completed",
            resource: { type: "webhook_subscription", publicId: existing.publicId },
            attributes: {
              subscription_public_id: existing.publicId,
              url_changed: Boolean(newUrlPlain),
              events_changed: Boolean(nextEvents),
            },
          },
          tx,
        );

        const reloaded = await tx
          .select()
          .from(integrationWebhookSubscriptions)
          .where(eq(integrationWebhookSubscriptions.id, existing.id))
          .limit(1);
        return reloaded[0]!;
      });

      return toSubscriptionView(updatedRow, deps.clock.now());
    },

    async setSubscriptionPaused(
      principal: SessionPrincipal,
      input: { publicId: string; expectedVersion: number; paused: boolean },
    ): Promise<WebhookSubscriptionView> {
      assertWebhooksManagePreflight(principal, deps.clock.now());
      const updated = await deps.db.transaction(async (tx) => {
        await assertWebhooksManageInTx(deps, principal, tx);
        const rows = await tx
          .select()
          .from(integrationWebhookSubscriptions)
          .where(eq(integrationWebhookSubscriptions.publicId, input.publicId))
          .limit(1);
        const existing = rows[0];
        if (!existing) throw notFound("WEBHOOK_SUBSCRIPTION_NOT_FOUND", "Webhook subscription not found.");
        if (existing.version !== input.expectedVersion) {
          throw conflict("VERSION_CONFLICT", "This subscription was updated elsewhere. Refresh and try again.");
        }

        const nextStatus: WebhookSubscriptionStatus = input.paused ? "paused" : "active";
        const now = deps.clock.now();
        await tx
          .update(integrationWebhookSubscriptions)
          .set({
            status: nextStatus,
            ...(input.paused ? {} : { consecutiveFailures: 0, autoDisabledAt: null }),
            updatedByUserId: principal.userId,
            updatedAt: now,
            version: existing.version + 1,
          })
          .where(
            and(
              eq(integrationWebhookSubscriptions.id, existing.id),
              eq(integrationWebhookSubscriptions.version, existing.version),
            ),
          );

        await deps.audit.record(
          {
            category: "admin",
            eventName: input.paused
              ? "integration.webhook.subscription_paused"
              : "integration.webhook.subscription_resumed",
            action: "update",
            outcome: "completed",
            resource: { type: "webhook_subscription", publicId: existing.publicId },
            attributes: {
              subscription_public_id: existing.publicId,
              status: nextStatus,
            },
          },
          tx,
        );

        const reloaded = await tx
          .select()
          .from(integrationWebhookSubscriptions)
          .where(eq(integrationWebhookSubscriptions.id, existing.id))
          .limit(1);
        return reloaded[0]!;
      });

      if (!input.paused) {
        await resolveWebhookOpsAlert(`webhook:sub:${updated.publicId}`);
      }

      return toSubscriptionView(updated, deps.clock.now());
    },

    async rotateSubscriptionSecret(
      principal: SessionPrincipal,
      input: { publicId: string; expectedVersion: number; overlapMinutes?: number },
    ): Promise<{ subscription: WebhookSubscriptionView; signingSecretOnce: string }> {
      assertWebhooksManagePreflight(principal, deps.clock.now());
      const overlapMinutes = Math.min(1440, Math.max(0, Math.trunc(input.overlapMinutes ?? DEFAULT_OVERLAP_MINUTES)));
      const { secret, last4 } = generateWebhookSigningSecret();

      const updated = await deps.db.transaction(async (tx) => {
        await assertWebhooksManageInTx(deps, principal, tx);
        const rows = await tx
          .select()
          .from(integrationWebhookSubscriptions)
          .where(eq(integrationWebhookSubscriptions.publicId, input.publicId))
          .limit(1);
        const existing = rows[0];
        if (!existing) throw notFound("WEBHOOK_SUBSCRIPTION_NOT_FOUND", "Webhook subscription not found.");
        if (existing.version !== input.expectedVersion) {
          throw conflict("VERSION_CONFLICT", "This subscription was updated elsewhere. Refresh and try again.");
        }

        const now = deps.clock.now();
        const newEnc = deps.crypto.encrypt(secret, subscriptionSecretAad(existing.publicId));
        const previousSecretEnc = overlapMinutes > 0 ? existing.signingSecretEnc : null;
        const previousSecretExpiresAt =
          overlapMinutes > 0 ? new Date(now.getTime() + overlapMinutes * 60_000) : null;

        await tx
          .update(integrationWebhookSubscriptions)
          .set({
            signingSecretEnc: newEnc,
            signingSecretLast4: last4,
            previousSecretEnc,
            previousSecretExpiresAt,
            updatedByUserId: principal.userId,
            updatedAt: now,
            version: existing.version + 1,
          })
          .where(
            and(
              eq(integrationWebhookSubscriptions.id, existing.id),
              eq(integrationWebhookSubscriptions.version, existing.version),
            ),
          );

        await deps.audit.record(
          {
            category: "security",
            eventName: "integration.webhook.subscription_secret_rotated",
            action: "rotate",
            outcome: "completed",
            resource: { type: "webhook_subscription", publicId: existing.publicId },
            attributes: {
              subscription_public_id: existing.publicId,
              overlap_minutes: overlapMinutes,
            },
          },
          tx,
        );

        const reloaded = await tx
          .select()
          .from(integrationWebhookSubscriptions)
          .where(eq(integrationWebhookSubscriptions.id, existing.id))
          .limit(1);
        return reloaded[0]!;
      });

      return {
        subscription: toSubscriptionView(updated, deps.clock.now()),
        signingSecretOnce: secret,
      };
    },

    async testSubscriptionDelivery(
      principal: SessionPrincipal,
      input: { publicId: string; eventKey?: string },
    ): Promise<WebhookDeliveryDetailView> {
      assertWebhooksManagePreflight(principal, deps.clock.now());
      const reqCtx = getRequestContext();
      const correlationId = reqCtx?.correlationId ?? ulid();

      const deliveryPubId = await deps.db.transaction(async (tx) => {
        await assertWebhooksManageInTx(deps, principal, tx);
        const cfg = await readConfig(tx);
        if (!cfg.enabled) {
          throw unavailable("WEBHOOKS_DISABLED", "Enable webhooks before sending a test delivery.");
        }
        const rows = await tx
          .select()
          .from(integrationWebhookSubscriptions)
          .where(eq(integrationWebhookSubscriptions.publicId, input.publicId))
          .limit(1);
        const sub = rows[0];
        if (!sub) throw notFound("WEBHOOK_SUBSCRIPTION_NOT_FOUND", "Webhook subscription not found.");

        let subEvents: string[] = [];
        try {
          const parsed = JSON.parse(sub.eventsJson) as unknown;
          if (Array.isArray(parsed)) subEvents = parsed.filter((x): x is string => typeof x === "string");
        } catch {
          subEvents = [];
        }
        const chosenEvent = input.eventKey?.trim() || subEvents[0] || "webhook.test";
        const newPubId = ulid();
        const now = deps.clock.now();
        const samplePayload = JSON.stringify({
          id: newPubId,
          event: chosenEvent,
          test: true,
          createdAt: now.toISOString(),
          correlationId,
          data: {
            message: "ReadyPackets webhook verification test delivery",
            subscriptionId: sub.publicId,
          },
        });
        const redacted = redactAndBoundBody(samplePayload);
        const payloadEnc = encryptDeliveryPayload(deps.crypto, newPubId, {
          requestHeaders: {},
          requestBody: redacted.body,
          responseHeaders: null,
          responseBody: null,
        });
        const targetLabel = `${sub.name} (${sub.targetUrlHost})`.slice(0, 255);

        await tx.insert(integrationWebhookDeliveries).values({
          publicId: newPubId,
          direction: "outbound",
          subscriptionId: sub.id,
          subscriptionPublicId: sub.publicId,
          targetLabel,
          eventKey: chosenEvent,
          externalEventId: newPubId,
          deduplicationKey: `test:${newPubId}`,
          status: "queued",
          httpMethod: "POST",
          httpPath: sub.targetUrlMasked.slice(0, 255),
          requestBytes: Buffer.byteLength(redacted.body, "utf8"),
          attemptCount: 0,
          maxAttempts: 1,
          correlationId,
          actorLabel: `admin:${principal.userPublicId}`,
          payloadSha256: sha256Hex(redacted.body),
          payloadEnc,
          bodyTruncated: redacted.truncated,
          bodyPurged: false,
          isReplay: false,
          isTest: true,
          searchText: buildSearchText([newPubId, chosenEvent, targetLabel, "test", correlationId]),
          expiresAt: computeExpiry(now, cfg.retentionDays),
        });

        await deps.audit.record(
          {
            category: "admin",
            eventName: "integration.webhook.subscription_tested",
            action: "test",
            outcome: "attempted",
            resource: { type: "webhook_subscription", publicId: sub.publicId },
            deliveryId: newPubId,
            correlationId,
            attributes: {
              subscription_public_id: sub.publicId,
              delivery_public_id: newPubId,
              event_key: safeAuditToken(chosenEvent, "test"),
            },
          },
          tx,
        );

        return newPubId;
      });

      await executeOutboundAttempt({
        deliveryPublicId: deliveryPubId,
        fencingToken: 1,
        inlineImmediate: true,
      });

      return this.getDelivery(principal, deliveryPubId);
    },

    async deleteSubscription(
      principal: SessionPrincipal,
      input: { publicId: string; expectedVersion: number },
    ): Promise<{ deleted: true }> {
      assertWebhooksManagePreflight(principal, deps.clock.now());
      await deps.db.transaction(async (tx) => {
        await assertWebhooksManageInTx(deps, principal, tx);
        const rows = await tx
          .select()
          .from(integrationWebhookSubscriptions)
          .where(eq(integrationWebhookSubscriptions.publicId, input.publicId))
          .limit(1);
        const existing = rows[0];
        if (!existing) throw notFound("WEBHOOK_SUBSCRIPTION_NOT_FOUND", "Webhook subscription not found.");
        if (existing.version !== input.expectedVersion) {
          throw conflict("VERSION_CONFLICT", "This subscription was updated elsewhere. Refresh and try again.");
        }

        await tx
          .delete(integrationWebhookSubscriptions)
          .where(eq(integrationWebhookSubscriptions.id, existing.id));

        await deps.audit.record(
          {
            category: "admin",
            eventName: "integration.webhook.subscription_deleted",
            action: "delete",
            outcome: "completed",
            resource: { type: "webhook_subscription", publicId: existing.publicId },
            attributes: {
              subscription_public_id: existing.publicId,
            },
          },
          tx,
        );
      });
      return { deleted: true };
    },

    /* ------------------------------------------------- inbound endpoints CRUD */

    async listInboundEndpoints(
      principal: SessionPrincipal,
      input: { enabled?: boolean; cursor?: string; limit?: number },
    ): Promise<{ items: WebhookInboundEndpointView[]; nextCursor: string | null }> {
      assertWebhooksRead(principal);
      const limit = Math.min(100, Math.max(1, input.limit ?? 50));
      const decoded = decodeCursor(input.cursor);
      const predicates: SQL[] = [];
      if (typeof input.enabled === "boolean") {
        predicates.push(eq(integrationWebhookInboundEndpoints.enabled, input.enabled));
      }
      if (decoded) {
        const cursorDate = new Date(decoded.t);
        predicates.push(
          or(
            lt(integrationWebhookInboundEndpoints.createdAt, cursorDate),
            and(
              eq(integrationWebhookInboundEndpoints.createdAt, cursorDate),
              lt(integrationWebhookInboundEndpoints.id, decoded.id),
            ),
          )!,
        );
      }
      const rows = await deps.db
        .select()
        .from(integrationWebhookInboundEndpoints)
        .where(predicates.length > 0 ? and(...predicates) : undefined)
        .orderBy(desc(integrationWebhookInboundEndpoints.createdAt), desc(integrationWebhookInboundEndpoints.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      const now = deps.clock.now();
      return {
        items: page.map((r) => toInboundView(r, now)),
        nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
      };
    },

    async getInboundEndpoint(
      principal: SessionPrincipal,
      publicId: string,
    ): Promise<WebhookInboundEndpointView> {
      assertWebhooksRead(principal);
      const rows = await deps.db
        .select()
        .from(integrationWebhookInboundEndpoints)
        .where(eq(integrationWebhookInboundEndpoints.publicId, publicId))
        .limit(1);
      const row = rows[0];
      if (!row) throw notFound("WEBHOOK_INBOUND_NOT_FOUND", "Inbound webhook endpoint not found.");
      return toInboundView(row, deps.clock.now());
    },

    async createInboundEndpoint(
      principal: SessionPrincipal,
      input: CreateWebhookInboundEndpointInput,
    ): Promise<{ endpoint: WebhookInboundEndpointView; signingSecretOnce: string }> {
      assertWebhooksManagePreflight(principal, deps.clock.now());
      const cleanName = input.name.trim();
      if (cleanName.length < 1 || cleanName.length > 120) {
        throw validation("INVALID_ENDPOINT_NAME", "Enter an endpoint name between 1 and 120 characters.");
      }
      const cleanKey = input.endpointKey.trim().toLowerCase();
      if (!ENDPOINT_KEY_RE.test(cleanKey)) {
        throw validation(
          "INVALID_ENDPOINT_KEY",
          "Endpoint key must be 3–64 lowercase letters, digits, hyphens, or underscores.",
        );
      }
      const tolerance = Math.min(
        MAX_TIMESTAMP_SKEW_SECONDS,
        Math.max(30, Math.trunc(input.toleranceSeconds ?? MAX_TIMESTAMP_SKEW_SECONDS)),
      );
      const cleanDesc = input.description?.trim() ? input.description.trim().slice(0, 280) : null;
      const publicId = ulid();
      const { secret, last4 } = generateWebhookSigningSecret();
      const signingSecretEnc = deps.crypto.encrypt(secret, inboundSecretAad(publicId));
      const enabled = Boolean(input.enabled);

      const row = await deps.db.transaction(async (tx) => {
        await assertWebhooksManageInTx(deps, principal, tx);
        const dup = await tx
          .select({ id: integrationWebhookInboundEndpoints.id })
          .from(integrationWebhookInboundEndpoints)
          .where(eq(integrationWebhookInboundEndpoints.endpointKey, cleanKey))
          .limit(1);
        if (dup.length > 0) {
          throw conflict("ENDPOINT_KEY_TAKEN", "An inbound endpoint with this key already exists.");
        }

        await tx.insert(integrationWebhookInboundEndpoints).values({
          publicId,
          name: cleanName,
          endpointKey: cleanKey,
          description: cleanDesc,
          enabled,
          signingSecretEnc,
          signingSecretLast4: last4,
          toleranceSeconds: tolerance,
          createdByUserId: principal.userId,
          updatedByUserId: principal.userId,
        });

        await deps.audit.record(
          {
            category: "admin",
            eventName: "integration.webhook.inbound_created",
            action: "create",
            outcome: "completed",
            resource: { type: "webhook_inbound_endpoint", publicId },
            attributes: {
              endpoint_public_id: publicId,
              endpoint_key: cleanKey,
              enabled,
              tolerance_seconds: tolerance,
            },
          },
          tx,
        );

        const created = await tx
          .select()
          .from(integrationWebhookInboundEndpoints)
          .where(eq(integrationWebhookInboundEndpoints.publicId, publicId))
          .limit(1);
        return created[0]!;
      });

      return {
        endpoint: toInboundView(row, deps.clock.now()),
        signingSecretOnce: secret,
      };
    },

    async updateInboundEndpoint(
      principal: SessionPrincipal,
      input: UpdateWebhookInboundEndpointInput,
    ): Promise<WebhookInboundEndpointView> {
      assertWebhooksManagePreflight(principal, deps.clock.now());
      const updated = await deps.db.transaction(async (tx) => {
        await assertWebhooksManageInTx(deps, principal, tx);
        const rows = await tx
          .select()
          .from(integrationWebhookInboundEndpoints)
          .where(eq(integrationWebhookInboundEndpoints.publicId, input.publicId))
          .limit(1);
        const existing = rows[0];
        if (!existing) throw notFound("WEBHOOK_INBOUND_NOT_FOUND", "Inbound webhook endpoint not found.");
        if (existing.version !== input.expectedVersion) {
          throw conflict("VERSION_CONFLICT", "This endpoint was updated elsewhere. Refresh and try again.");
        }

        const nextName = input.name !== undefined ? input.name.trim() : existing.name;
        if (nextName.length < 1 || nextName.length > 120) {
          throw validation("INVALID_ENDPOINT_NAME", "Enter an endpoint name between 1 and 120 characters.");
        }
        const nextDesc =
          input.description === undefined
            ? existing.description
            : input.description?.trim()
              ? input.description.trim().slice(0, 280)
              : null;
        const nextTolerance =
          input.toleranceSeconds !== undefined
            ? Math.min(MAX_TIMESTAMP_SKEW_SECONDS, Math.max(30, Math.trunc(input.toleranceSeconds)))
            : existing.toleranceSeconds;

        const now = deps.clock.now();
        await tx
          .update(integrationWebhookInboundEndpoints)
          .set({
            name: nextName,
            description: nextDesc,
            toleranceSeconds: nextTolerance,
            updatedByUserId: principal.userId,
            updatedAt: now,
            version: existing.version + 1,
          })
          .where(
            and(
              eq(integrationWebhookInboundEndpoints.id, existing.id),
              eq(integrationWebhookInboundEndpoints.version, existing.version),
            ),
          );

        await deps.audit.record(
          {
            category: "admin",
            eventName: "integration.webhook.inbound_updated",
            action: "update",
            outcome: "completed",
            resource: { type: "webhook_inbound_endpoint", publicId: existing.publicId },
            attributes: {
              endpoint_public_id: existing.publicId,
              tolerance_seconds: nextTolerance,
            },
          },
          tx,
        );

        const reloaded = await tx
          .select()
          .from(integrationWebhookInboundEndpoints)
          .where(eq(integrationWebhookInboundEndpoints.id, existing.id))
          .limit(1);
        return reloaded[0]!;
      });

      return toInboundView(updated, deps.clock.now());
    },

    async setInboundEndpointEnabled(
      principal: SessionPrincipal,
      input: { publicId: string; expectedVersion: number; enabled: boolean },
    ): Promise<WebhookInboundEndpointView> {
      assertWebhooksManagePreflight(principal, deps.clock.now());
      const updated = await deps.db.transaction(async (tx) => {
        await assertWebhooksManageInTx(deps, principal, tx);
        const rows = await tx
          .select()
          .from(integrationWebhookInboundEndpoints)
          .where(eq(integrationWebhookInboundEndpoints.publicId, input.publicId))
          .limit(1);
        const existing = rows[0];
        if (!existing) throw notFound("WEBHOOK_INBOUND_NOT_FOUND", "Inbound webhook endpoint not found.");
        if (existing.version !== input.expectedVersion) {
          throw conflict("VERSION_CONFLICT", "This endpoint was updated elsewhere. Refresh and try again.");
        }

        const now = deps.clock.now();
        await tx
          .update(integrationWebhookInboundEndpoints)
          .set({
            enabled: input.enabled,
            updatedByUserId: principal.userId,
            updatedAt: now,
            version: existing.version + 1,
          })
          .where(
            and(
              eq(integrationWebhookInboundEndpoints.id, existing.id),
              eq(integrationWebhookInboundEndpoints.version, existing.version),
            ),
          );

        await deps.audit.record(
          {
            category: "admin",
            eventName: "integration.webhook.inbound_updated",
            action: "update",
            outcome: "completed",
            resource: { type: "webhook_inbound_endpoint", publicId: existing.publicId },
            attributes: {
              endpoint_public_id: existing.publicId,
              enabled: input.enabled,
            },
          },
          tx,
        );

        const reloaded = await tx
          .select()
          .from(integrationWebhookInboundEndpoints)
          .where(eq(integrationWebhookInboundEndpoints.id, existing.id))
          .limit(1);
        return reloaded[0]!;
      });

      return toInboundView(updated, deps.clock.now());
    },

    async rotateInboundEndpointSecret(
      principal: SessionPrincipal,
      input: { publicId: string; expectedVersion: number; overlapMinutes?: number },
    ): Promise<{ endpoint: WebhookInboundEndpointView; signingSecretOnce: string }> {
      assertWebhooksManagePreflight(principal, deps.clock.now());
      const overlapMinutes = Math.min(1440, Math.max(0, Math.trunc(input.overlapMinutes ?? DEFAULT_OVERLAP_MINUTES)));
      const { secret, last4 } = generateWebhookSigningSecret();

      const updated = await deps.db.transaction(async (tx) => {
        await assertWebhooksManageInTx(deps, principal, tx);
        const rows = await tx
          .select()
          .from(integrationWebhookInboundEndpoints)
          .where(eq(integrationWebhookInboundEndpoints.publicId, input.publicId))
          .limit(1);
        const existing = rows[0];
        if (!existing) throw notFound("WEBHOOK_INBOUND_NOT_FOUND", "Inbound webhook endpoint not found.");
        if (existing.version !== input.expectedVersion) {
          throw conflict("VERSION_CONFLICT", "This endpoint was updated elsewhere. Refresh and try again.");
        }

        const now = deps.clock.now();
        const newEnc = deps.crypto.encrypt(secret, inboundSecretAad(existing.publicId));
        const previousSecretEnc = overlapMinutes > 0 ? existing.signingSecretEnc : null;
        const previousSecretExpiresAt =
          overlapMinutes > 0 ? new Date(now.getTime() + overlapMinutes * 60_000) : null;

        await tx
          .update(integrationWebhookInboundEndpoints)
          .set({
            signingSecretEnc: newEnc,
            signingSecretLast4: last4,
            previousSecretEnc,
            previousSecretExpiresAt,
            updatedByUserId: principal.userId,
            updatedAt: now,
            version: existing.version + 1,
          })
          .where(
            and(
              eq(integrationWebhookInboundEndpoints.id, existing.id),
              eq(integrationWebhookInboundEndpoints.version, existing.version),
            ),
          );

        await deps.audit.record(
          {
            category: "security",
            eventName: "integration.webhook.inbound_secret_rotated",
            action: "rotate",
            outcome: "completed",
            resource: { type: "webhook_inbound_endpoint", publicId: existing.publicId },
            attributes: {
              endpoint_public_id: existing.publicId,
              overlap_minutes: overlapMinutes,
            },
          },
          tx,
        );

        const reloaded = await tx
          .select()
          .from(integrationWebhookInboundEndpoints)
          .where(eq(integrationWebhookInboundEndpoints.id, existing.id))
          .limit(1);
        return reloaded[0]!;
      });

      return {
        endpoint: toInboundView(updated, deps.clock.now()),
        signingSecretOnce: secret,
      };
    },

    async deleteInboundEndpoint(
      principal: SessionPrincipal,
      input: { publicId: string; expectedVersion: number },
    ): Promise<{ deleted: true }> {
      assertWebhooksManagePreflight(principal, deps.clock.now());
      await deps.db.transaction(async (tx) => {
        await assertWebhooksManageInTx(deps, principal, tx);
        const rows = await tx
          .select()
          .from(integrationWebhookInboundEndpoints)
          .where(eq(integrationWebhookInboundEndpoints.publicId, input.publicId))
          .limit(1);
        const existing = rows[0];
        if (!existing) throw notFound("WEBHOOK_INBOUND_NOT_FOUND", "Inbound webhook endpoint not found.");
        if (existing.version !== input.expectedVersion) {
          throw conflict("VERSION_CONFLICT", "This endpoint was updated elsewhere. Refresh and try again.");
        }

        await tx
          .delete(integrationWebhookInboundEndpoints)
          .where(eq(integrationWebhookInboundEndpoints.id, existing.id));

        await deps.audit.record(
          {
            category: "admin",
            eventName: "integration.webhook.inbound_deleted",
            action: "delete",
            outcome: "completed",
            resource: { type: "webhook_inbound_endpoint", publicId: existing.publicId },
            attributes: {
              endpoint_public_id: existing.publicId,
            },
          },
          tx,
        );
      });
      return { deleted: true };
    },

    /* ------------------------------------------------- unified deliveries log & replay */

    async listDeliveries(
      principal: SessionPrincipal,
      input: ListWebhookDeliveriesInput,
    ): Promise<{ items: WebhookDeliveryListItemView[]; nextCursor: string | null }> {
      assertWebhooksRead(principal);
      const limit = Math.min(100, Math.max(1, input.limit ?? 50));
      const decoded = decodeCursor(input.cursor);
      const predicates: SQL[] = [];

      if (input.direction) {
        predicates.push(eq(integrationWebhookDeliveries.direction, input.direction));
      }
      if (input.subscriptionPublicId) {
        predicates.push(eq(integrationWebhookDeliveries.subscriptionPublicId, input.subscriptionPublicId));
      }
      if (input.inboundEndpointPublicId) {
        predicates.push(eq(integrationWebhookDeliveries.inboundEndpointPublicId, input.inboundEndpointPublicId));
      }
      if (input.orderPublicId?.trim()) {
        predicates.push(eq(integrationWebhookDeliveries.orderPublicId, input.orderPublicId.trim()));
      }
      if (input.eventKey?.trim()) {
        predicates.push(eq(integrationWebhookDeliveries.eventKey, input.eventKey.trim()));
      }
      if (input.status) {
        predicates.push(eq(integrationWebhookDeliveries.status, input.status));
      }
      if (input.from) {
        predicates.push(gte(integrationWebhookDeliveries.createdAt, input.from));
      }
      if (input.to) {
        predicates.push(lte(integrationWebhookDeliveries.createdAt, input.to));
      }
      if (input.correlationId?.trim()) {
        predicates.push(eq(integrationWebhookDeliveries.correlationId, input.correlationId.trim()));
      }
      if (input.search?.trim()) {
        const term = escapeLike(input.search.trim().slice(0, 120));
        predicates.push(like(integrationWebhookDeliveries.searchText, `%${term}%`));
      }
      if (decoded) {
        const cursorDate = new Date(decoded.t);
        predicates.push(
          or(
            lt(integrationWebhookDeliveries.createdAt, cursorDate),
            and(
              eq(integrationWebhookDeliveries.createdAt, cursorDate),
              lt(integrationWebhookDeliveries.id, decoded.id),
            ),
          )!,
        );
      }

      const rows = await deps.db
        .select()
        .from(integrationWebhookDeliveries)
        .where(predicates.length > 0 ? and(...predicates) : undefined)
        .orderBy(desc(integrationWebhookDeliveries.createdAt), desc(integrationWebhookDeliveries.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      const now = deps.clock.now();
      return {
        items: page.map((r) => toDeliveryListItemView(r, now)),
        nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
      };
    },

    async getDelivery(principal: SessionPrincipal, publicId: string): Promise<WebhookDeliveryDetailView> {
      assertWebhooksRead(principal);
      const rows = await deps.db
        .select()
        .from(integrationWebhookDeliveries)
        .where(eq(integrationWebhookDeliveries.publicId, publicId))
        .limit(1);
      const row = rows[0];
      if (!row) throw notFound("WEBHOOK_DELIVERY_NOT_FOUND", "Webhook delivery record not found.");
      return loadDeliveryDetail(row, deps.clock.now());
    },

    async stopDelivery(
      principal: SessionPrincipal,
      input: { publicId: string; reason?: string | null },
    ): Promise<WebhookDeliveryDetailView> {
      const stopCaps = ["webhooks.manage", "api.replay"] as const;
      assertAdminStepUpAnyPreflight(principal, deps.clock.now(), stopCaps);
      const cleanReason = input.reason?.trim() ? input.reason.trim().slice(0, 280) : null;
      if (cleanReason !== null && !hasNoHeaderInjection(cleanReason)) {
        throw validation("INVALID_STOP_REASON", "Enter a valid stop reason without control characters.");
      }
      const correlationId = currentCorrelationId();

      await deps.db.transaction(async (tx) => {
        await assertAdminStepUpAnyInTx(deps, principal, tx, stopCaps);
        const rows = await tx
          .select()
          .from(integrationWebhookDeliveries)
          .where(eq(integrationWebhookDeliveries.publicId, input.publicId))
          .limit(1);
        const target = rows[0];
        if (!target || target.direction !== "outbound") {
          throw notFound("WEBHOOK_DELIVERY_NOT_FOUND", "Outbound webhook delivery not found.");
        }

        if (target.jobPublicId && deps.services.jobAdmin?.reconcileOutboxJob) {
          const disp = await deps.services.jobAdmin.reconcileOutboxJob(target.jobPublicId, tx, {
            cancelQueued: true,
          });
          if (disp.state === "running_live") {
            throw conflict(
              "WEBHOOK_DELIVERY_IN_FLIGHT",
              "This webhook delivery is actively transmitting right now and cannot be stopped mid-flight.",
            );
          }
        }

        const [locked] = await tx
          .select()
          .from(integrationWebhookDeliveries)
          .where(eq(integrationWebhookDeliveries.id, target.id))
          .for("update")
          .limit(1);
        if (!locked || (locked.status !== "queued" && locked.status !== "retrying")) {
          throw conflict(
            "WEBHOOK_DELIVERY_NOT_STOPPABLE",
            "Only queued or retrying outbound webhook deliveries can be stopped.",
          );
        }

        const now = deps.clock.now();
        await tx
          .update(integrationWebhookDeliveries)
          .set({
            status: "stopped",
            reasonCode: "STOPPED_BY_OPERATOR",
            activeFencingToken: 0,
            stoppedAt: now,
            stoppedByUserId: principal.userId,
            stoppedByPublicId: principal.userPublicId,
            stopReason: cleanReason,
            completedAt: now,
            updatedAt: now,
            version: locked.version + 1,
          })
          .where(
            and(
              eq(integrationWebhookDeliveries.id, locked.id),
              eq(integrationWebhookDeliveries.version, locked.version),
            ),
          );

        await deps.audit.record(
          {
            category: "integration",
            eventName: "integration.webhook.delivery_stopped",
            action: "cancel",
            outcome: "completed",
            severity: "WARN",
            reasonCode: "STOPPED_BY_OPERATOR",
            resource: {
              type: "webhook_subscription",
              publicId: locked.subscriptionPublicId ?? locked.publicId,
            },
            deliveryId: locked.publicId,
            correlationId,
            ...(locked.orderPublicId ? { orderPublicId: locked.orderPublicId } : {}),
            attributes: {
              delivery_public_id: locked.publicId,
              event_key: safeAuditToken(locked.eventKey, "event"),
              previous_status: locked.status,
              attempt_count: locked.attemptCount,
            },
            ...(cleanReason ? { safeCounts: { reason_length: cleanReason.length } } : {}),
          },
          tx,
        );
      });

      return this.getDelivery(principal, input.publicId);
    },

    async retryDelivery(
      principal: SessionPrincipal,
      input: { publicId: string },
    ): Promise<WebhookDeliveryDetailView> {
      const retryCaps = ["webhooks.manage", "api.replay"] as const;
      assertAdminStepUpAnyPreflight(principal, deps.clock.now(), retryCaps);
      const correlationId = currentCorrelationId();

      await deps.db.transaction(async (tx) => {
        await assertAdminStepUpAnyInTx(deps, principal, tx, retryCaps);
        const cfg = await readConfig(tx);
        if (!cfg.enabled) {
          throw unavailable("WEBHOOKS_DISABLED", "Enable webhooks before retrying an outbound delivery.");
        }

        const [locked] = await tx
          .select()
          .from(integrationWebhookDeliveries)
          .where(eq(integrationWebhookDeliveries.publicId, input.publicId))
          .for("update")
          .limit(1);
        if (!locked || locked.direction !== "outbound" || !locked.subscriptionId) {
          throw notFound("WEBHOOK_DELIVERY_NOT_FOUND", "Outbound webhook delivery not found.");
        }

        if (locked.status === "delivered") {
          throw conflict(
            "WEBHOOK_ALREADY_DELIVERED",
            "Delivered webhooks cannot be retried in place; use Redeliver to create a separate replay delivery.",
          );
        }
        if (locked.status === "unknown") {
          throw conflict(
            "WEBHOOK_OUTCOME_UNCERTAIN",
            "This webhook attempt ended with an uncertain network outcome; verify the receiver first and use Redeliver if needed.",
          );
        }
        if (locked.status !== "failed" && locked.status !== "dead" && locked.status !== "stopped") {
          throw conflict(
            "WEBHOOK_DELIVERY_NOT_RETRYABLE",
            "Only failed, dead-lettered, or stopped outbound webhook deliveries can be retried.",
          );
        }

        const now = deps.clock.now();
        if (locked.bodyTruncated) {
          throw conflict(
            "WEBHOOK_BODY_TRUNCATED",
            "This webhook cannot be retried because its stored body exceeded 64 KiB and was truncated.",
          );
        }
        if (locked.bodyPurged || locked.expiresAt.getTime() <= now.getTime() || (!locked.payloadEnc && !locked.tapEventEnc)) {
          throw conflict(
            "WEBHOOK_BODY_PURGED",
            "This webhook cannot be retried because its stored payload body has been purged under the retention policy.",
          );
        }

        const subRows = await tx
          .select()
          .from(integrationWebhookSubscriptions)
          .where(eq(integrationWebhookSubscriptions.id, locked.subscriptionId))
          .limit(1);
        const sub = subRows[0];
        if (!sub) {
          throw conflict("SUBSCRIPTION_DELETED", "The destination subscription no longer exists.");
        }
        if (sub.status !== "active") {
          throw conflict(
            "SUBSCRIPTION_INACTIVE",
            "Resume or enable the webhook subscription before retrying this delivery.",
          );
        }

        const nextManualRetryCount = (locked.manualRetryCount ?? 0) + 1;
        const { jobId } = await deps.jobs.enqueue(
          WEBHOOK_DELIVER_JOB,
          { deliveryPublicId: locked.publicId },
          {
            idempotencyKey: `webhook_deliver:${locked.publicId}:retry:${nextManualRetryCount}`,
            maxAttempts: WEBHOOK_MAX_ATTEMPTS,
            correlationId,
          },
          tx,
        );

        await tx
          .update(integrationWebhookDeliveries)
          .set({
            status: "queued",
            maxAttempts: locked.attemptCount + WEBHOOK_MAX_ATTEMPTS,
            manualRetryCount: nextManualRetryCount,
            jobPublicId: jobId,
            reasonCode: null,
            activeFencingToken: 0,
            stoppedAt: null,
            stoppedByUserId: null,
            stoppedByPublicId: null,
            stopReason: null,
            completedAt: null,
            updatedAt: now,
            version: locked.version + 1,
          })
          .where(
            and(
              eq(integrationWebhookDeliveries.id, locked.id),
              eq(integrationWebhookDeliveries.version, locked.version),
            ),
          );

        await deps.audit.record(
          {
            category: "integration",
            eventName: "integration.webhook.delivery_retried",
            action: "retry",
            outcome: "completed",
            severity: "INFO",
            resource: { type: "webhook_subscription", publicId: sub.publicId },
            deliveryId: locked.publicId,
            correlationId,
            ...(locked.orderPublicId ? { orderPublicId: locked.orderPublicId } : {}),
            attributes: {
              delivery_public_id: locked.publicId,
              subscription_public_id: sub.publicId,
              event_key: safeAuditToken(locked.eventKey, "event"),
              manual_retry_count: nextManualRetryCount,
              prior_attempt_count: locked.attemptCount,
            },
          },
          tx,
        );
      });

      return this.getDelivery(principal, input.publicId);
    },

    async redeliver(
      principal: SessionPrincipal,
      input: { publicId: string },
    ): Promise<WebhookDeliveryDetailView> {
      assertApiReplayPreflight(principal, deps.clock.now());
      const reqCtx = getRequestContext();
      const correlationId = reqCtx?.correlationId ?? ulid();

      const newPublicId = await deps.db.transaction(async (tx) => {
        await assertApiReplayInTx(deps, principal, tx);
        const cfg = await readConfig(tx);
        if (!cfg.enabled) {
          throw unavailable("WEBHOOKS_DISABLED", "Enable webhooks before re-running an outbound delivery.");
        }

        const rows = await tx
          .select()
          .from(integrationWebhookDeliveries)
          .where(eq(integrationWebhookDeliveries.publicId, input.publicId))
          .limit(1);
        const original = rows[0];
        if (!original || original.direction !== "outbound" || !original.subscriptionId) {
          throw notFound("WEBHOOK_DELIVERY_NOT_FOUND", "Outbound webhook delivery not found.");
        }
        const now = deps.clock.now();
        if (original.bodyTruncated) {
          throw conflict(
            "WEBHOOK_BODY_TRUNCATED",
            "This webhook cannot be redelivered because its stored body exceeded 64 KiB and was truncated.",
          );
        }
        if (isDeliveryPurged(original, now)) {
          throw conflict(
            "WEBHOOK_BODY_PURGED",
            "This webhook cannot be redelivered because its stored body has been purged under the retention policy.",
          );
        }

        const subRows = await tx
          .select()
          .from(integrationWebhookSubscriptions)
          .where(eq(integrationWebhookSubscriptions.id, original.subscriptionId))
          .limit(1);
        const sub = subRows[0];
        if (!sub) {
          throw conflict("SUBSCRIPTION_DELETED", "The destination subscription no longer exists.");
        }

        const decoded = decryptDeliveryPayload(deps.crypto, original.publicId, original.payloadEnc);
        if (!decoded?.requestBody) {
          throw conflict(
            "WEBHOOK_BODY_PURGED",
            "This webhook cannot be redelivered because no stored payload body is available.",
          );
        }

        const replayPubId = ulid();
        const replayPayloadEnc = encryptDeliveryPayload(deps.crypto, replayPubId, {
          requestHeaders: {},
          requestBody: decoded.requestBody,
          responseHeaders: null,
          responseBody: null,
        });
        const targetLabel = `${sub.name} (${sub.targetUrlHost})`.slice(0, 255);

        await tx.insert(integrationWebhookDeliveries).values({
          publicId: replayPubId,
          direction: "outbound",
          subscriptionId: sub.id,
          subscriptionPublicId: sub.publicId,
          orderPublicId: original.orderPublicId ?? null,
          stageKey: original.stageKey ?? null,
          targetLabel,
          eventKey: original.eventKey,
          externalEventId: original.externalEventId,
          deduplicationKey: `replay:out:${replayPubId}`,
          status: "queued",
          httpMethod: "POST",
          httpPath: sub.targetUrlMasked.slice(0, 255),
          requestBytes: Buffer.byteLength(decoded.requestBody, "utf8"),
          attemptCount: 0,
          maxAttempts: 1,
          correlationId,
          actorLabel: `admin:${principal.userPublicId}`,
          payloadSha256: sha256Hex(decoded.requestBody),
          payloadEnc: replayPayloadEnc,
          bodyTruncated: false,
          bodyPurged: false,
          isReplay: true,
          replayOfPublicId: original.publicId,
          isTest: false,
          searchText: buildSearchText([
            replayPubId,
            original.publicId,
            original.eventKey,
            targetLabel,
            "replay",
            correlationId,
          ]),
          expiresAt: computeExpiry(now, cfg.retentionDays),
        });

        await deps.audit.record(
          {
            category: "security",
            eventName: "integration.webhook.redelivered",
            action: "replay",
            outcome: "completed",
            resource: { type: "webhook_subscription", publicId: sub.publicId },
            deliveryId: replayPubId,
            correlationId,
            attributes: {
              delivery_public_id: replayPubId,
              original_delivery_public_id: original.publicId,
              event_key: safeAuditToken(original.eventKey, "event"),
            },
          },
          tx,
        );

        return replayPubId;
      });

      await executeOutboundAttempt({
        deliveryPublicId: newPublicId,
        fencingToken: 1,
        inlineImmediate: true,
      });

      return this.getDelivery(principal, newPublicId);
    },

    async reprocessInbound(
      principal: SessionPrincipal,
      input: { publicId: string },
    ): Promise<WebhookDeliveryDetailView> {
      assertApiReplayPreflight(principal, deps.clock.now());
      const reqCtx = getRequestContext();
      const correlationId = reqCtx?.correlationId ?? ulid();

      const newPublicId = await deps.db.transaction(async (tx) => {
        await assertApiReplayInTx(deps, principal, tx);
        const cfg = await readConfig(tx);
        if (!cfg.enabled) {
          throw unavailable("WEBHOOKS_DISABLED", "Enable webhooks before reprocessing an inbound event.");
        }

        const rows = await tx
          .select()
          .from(integrationWebhookDeliveries)
          .where(eq(integrationWebhookDeliveries.publicId, input.publicId))
          .limit(1);
        const original = rows[0];
        if (!original || original.direction !== "inbound" || !original.inboundEndpointId) {
          throw notFound("WEBHOOK_DELIVERY_NOT_FOUND", "Inbound webhook event not found.");
        }
        const now = deps.clock.now();
        if (original.bodyTruncated) {
          throw conflict(
            "WEBHOOK_BODY_TRUNCATED",
            "This inbound event cannot be reprocessed because its stored body exceeded 64 KiB and was truncated.",
          );
        }
        if (isDeliveryPurged(original, now)) {
          throw conflict(
            "WEBHOOK_BODY_PURGED",
            "This inbound event cannot be reprocessed because its stored body has been purged under the retention policy.",
          );
        }
        if (original.status === "rejected") {
          throw conflict(
            "WEBHOOK_REJECTED_CANNOT_REPLAY",
            "Unverified or rejected inbound requests cannot be reprocessed.",
          );
        }

        const epRows = await tx
          .select()
          .from(integrationWebhookInboundEndpoints)
          .where(eq(integrationWebhookInboundEndpoints.id, original.inboundEndpointId))
          .limit(1);
        const ep = epRows[0];
        if (!ep || !ep.enabled) {
          throw conflict("ENDPOINT_INACTIVE", "The inbound endpoint is disabled or no longer exists.");
        }

        const decoded = decryptDeliveryPayload(deps.crypto, original.publicId, original.payloadEnc);
        if (!decoded?.requestBody) {
          throw conflict(
            "WEBHOOK_BODY_PURGED",
            "This inbound event cannot be reprocessed because no stored payload body is available.",
          );
        }

        const replayPubId = ulid();
        const attemptPubId = ulid();
        const purgeNow = cfg.retentionDays <= 0;
        const replayHeaders = { ...decoded.requestHeaders, "x-readypackets-replay": "1" };
        const replayPayloadEnc = purgeNow
          ? null
          : encryptDeliveryPayload(deps.crypto, replayPubId, {
              requestHeaders: replayHeaders,
              requestBody: decoded.requestBody,
              responseHeaders: { "content-type": "application/json" },
              responseBody: JSON.stringify({ ok: true, deliveryId: replayPubId, reprocessed: true }),
            });
        const targetLabel = `${ep.name} (${ep.endpointKey})`.slice(0, 255);

        const [ins] = await tx.insert(integrationWebhookDeliveries).values({
          publicId: replayPubId,
          direction: "inbound",
          inboundEndpointId: ep.id,
          inboundEndpointPublicId: ep.publicId,
          targetLabel,
          eventKey: original.eventKey,
          externalEventId: original.externalEventId,
          deduplicationKey: `replay:in:${replayPubId}`,
          status: "processed",
          httpMethod: "POST",
          httpPath: `/api/webhooks/inbound/${ep.publicId}`,
          httpStatus: 200,
          durationMs: 0,
          requestBytes: Buffer.byteLength(decoded.requestBody, "utf8"),
          responseBytes: 64,
          attemptCount: 1,
          maxAttempts: 1,
          correlationId,
          actorLabel: `admin:${principal.userPublicId}`,
          payloadSha256: sha256Hex(decoded.requestBody),
          payloadEnc: replayPayloadEnc,
          bodyTruncated: false,
          bodyPurged: purgeNow,
          isReplay: true,
          replayOfPublicId: original.publicId,
          isTest: false,
          searchText: buildSearchText([
            replayPubId,
            original.publicId,
            original.eventKey,
            targetLabel,
            "replay",
            correlationId,
          ]),
          expiresAt: computeExpiry(now, cfg.retentionDays),
          completedAt: now,
        });

        await tx.insert(integrationWebhookDeliveryAttempts).values({
          publicId: attemptPubId,
          deliveryId: Number(ins.insertId),
          attemptNumber: 1,
          outcome: "succeeded",
          httpStatus: 200,
          durationMs: 0,
          reasonCode: null,
          responseBytes: 64,
          responseEnc: null,
          occurredAt: now,
        });

        await deps.audit.record(
          {
            category: "security",
            eventName: "integration.webhook.inbound_reprocessed",
            action: "replay",
            outcome: "completed",
            resource: { type: "webhook_inbound_endpoint", publicId: ep.publicId },
            deliveryId: replayPubId,
            correlationId,
            attributes: {
              delivery_public_id: replayPubId,
              original_delivery_public_id: original.publicId,
              endpoint_public_id: ep.publicId,
              endpoint_key: ep.endpointKey,
            },
          },
          tx,
        );

        // Emit the automation trigger event (`is_replay: true`) — starts matching automations only.
        await deps.audit.record(
          {
            category: "integration",
            eventName: "integration.webhook.inbound_received",
            action: "receive",
            outcome: "completed",
            actor: { role: "system" },
            resource: { type: "webhook_inbound_endpoint", publicId: ep.publicId },
            deliveryId: replayPubId,
            correlationId,
            attributes: {
              delivery_public_id: replayPubId,
              endpoint_public_id: ep.publicId,
              endpoint_key: ep.endpointKey,
              event_type: safeAuditToken(original.eventKey, "inbound.event", 96),
              is_replay: true,
            },
          },
          tx,
        );

        return replayPubId;
      });

      return this.getDelivery(principal, newPublicId);
    },

    /* ------------------------------------------------- server-internal publish() port */

    async publish(
      eventKey: string,
      payload: Record<string, unknown>,
      options?: WebhookPublishOptions,
      outerTx?: Tx,
    ): Promise<{ queued: number; deliveryPublicIds: string[] }> {
      const cleanEventKey = eventKey.trim();
      if (!EVENT_KEY_RE.test(cleanEventKey)) {
        throw validation("INVALID_WEBHOOK_EVENT_KEY", "Webhook event key is not valid.");
      }
      const catEntry = getFullCatalogue().find((e) => e.key === cleanEventKey);
      if (catEntry?.staffOnly) {
        throw forbidden("STAFF_ONLY_TRIGGER_FORBIDDEN", "Staff-only events cannot be published to external webhooks.");
      }

      const runInTx = async (tx: Tx) => {
        const cfg = await readConfig(tx);
        if (!cfg.enabled) return { queued: 0, deliveryPublicIds: [] };

        const activeSubs = await tx
          .select()
          .from(integrationWebhookSubscriptions)
          .where(eq(integrationWebhookSubscriptions.status, "active"));
        if (activeSubs.length === 0) return { queued: 0, deliveryPublicIds: [] };

        const now = deps.clock.now();
        const correlationId = options?.correlationId ?? currentCorrelationId();
        const expiresAt = computeExpiry(now, cfg.retentionDays);
        const deliveryPublicIds: string[] = [];

        for (const sub of activeSubs) {
          let subEvents: string[] = [];
          try {
            const parsed = JSON.parse(sub.eventsJson) as unknown;
            if (Array.isArray(parsed)) subEvents = parsed.filter((x): x is string => typeof x === "string");
          } catch {
            subEvents = [];
          }
          if (!subEvents.includes(cleanEventKey)) continue;

          const deliveryPublicId = ulid();
          const dedupeKey = options?.deduplicationKey
            ? `pub:${sub.publicId}:${options.deduplicationKey}`.slice(0, 160)
            : `pub:${sub.publicId}:${deliveryPublicId}`;

          const existing = await tx
            .select({ id: integrationWebhookDeliveries.id })
            .from(integrationWebhookDeliveries)
            .where(
              and(
                eq(integrationWebhookDeliveries.direction, "outbound"),
                eq(integrationWebhookDeliveries.deduplicationKey, dedupeKey),
              ),
            )
            .limit(1);
          if (existing.length > 0) continue;

          const envelopeObj = {
            id: deliveryPublicId,
            event: cleanEventKey,
            createdAt: now.toISOString(),
            correlationId,
            resource:
              options?.resourceType && options?.resourcePublicId
                ? { type: options.resourceType, id: options.resourcePublicId }
                : null,
            data: payload,
          };
          const redacted = redactAndBoundBody(JSON.stringify(envelopeObj));
          const payloadEnc = encryptDeliveryPayload(deps.crypto, deliveryPublicId, {
            requestHeaders: {},
            requestBody: redacted.body,
            responseHeaders: null,
            responseBody: null,
          });
          const targetLabel = `${sub.name} (${sub.targetUrlHost})`.slice(0, 255);

          const { jobId } = await deps.jobs.enqueue(
            WEBHOOK_DELIVER_JOB,
            { deliveryPublicId },
            {
              idempotencyKey: `webhook_deliver:${deliveryPublicId}`,
              maxAttempts: WEBHOOK_MAX_ATTEMPTS,
              correlationId,
            },
            tx,
          );

          const pubOrderPublicId =
            options?.orderPublicId ??
            (options?.resourceType === "order" && options.resourcePublicId ? options.resourcePublicId : null);
          const pubStageKey = options?.stageKey ? options.stageKey.slice(0, 64) : null;

          await tx.insert(integrationWebhookDeliveries).values({
            publicId: deliveryPublicId,
            direction: "outbound",
            subscriptionId: sub.id,
            subscriptionPublicId: sub.publicId,
            orderPublicId: pubOrderPublicId,
            stageKey: pubStageKey,
            targetLabel,
            eventKey: cleanEventKey,
            externalEventId: options?.deduplicationKey?.slice(0, 128) ?? deliveryPublicId,
            deduplicationKey: dedupeKey,
            status: "queued",
            httpMethod: "POST",
            httpPath: sub.targetUrlMasked.slice(0, 255),
            requestBytes: Buffer.byteLength(redacted.body, "utf8"),
            attemptCount: 0,
            maxAttempts: WEBHOOK_MAX_ATTEMPTS,
            jobPublicId: jobId,
            correlationId,
            actorLabel: "system",
            payloadSha256: sha256Hex(redacted.body),
            payloadEnc,
            bodyTruncated: redacted.truncated,
            bodyPurged: false,
            isReplay: false,
            isTest: false,
            searchText: buildSearchText([
              deliveryPublicId,
              cleanEventKey,
              targetLabel,
              "queued",
              correlationId,
              pubOrderPublicId,
              pubStageKey,
            ]),
            expiresAt,
          });
          deliveryPublicIds.push(deliveryPublicId);
        }

        return { queued: deliveryPublicIds.length, deliveryPublicIds };
      };

      if (outerTx) return runInTx(outerTx);
      return deps.db.transaction(runInTx);
    },

    async enqueueWorkflowSubscription(
      input: {
        subscriptionPublicId: string;
        orderPublicId: string | null;
        stageKey: string | null;
        triggerSource: string;
        idempotencyKey: string;
        correlationId?: string;
        actor?: SessionPrincipal | null;
        actorPublicId?: string | null;
        eventKey?: string | null;
        payload: Record<string, unknown>;
      },
      tx: Tx,
    ) {
      const cfg = await readConfig(tx);
      if (!cfg.enabled) {
        return {
          outcome: "disabled" as const,
          deliveryPublicId: null,
          reasonCode: "WEBHOOKS_DISABLED",
          message: "Outbound webhook subscriptions are currently disabled.",
        };
      }
      if (input.orderPublicId && (await isOrderPublicIdTrashed(input.orderPublicId, tx))) {
        return {
          outcome: "refused_precondition" as const,
          deliveryPublicId: null,
          reasonCode: "ORDER_NOT_FOUND",
          message: "Order was not found.",
        };
      }

      const subRows = await tx
        .select()
        .from(integrationWebhookSubscriptions)
        .where(eq(integrationWebhookSubscriptions.publicId, input.subscriptionPublicId))
        .limit(1);
      const sub = subRows[0];
      if (!sub) {
        return {
          outcome: "refused_precondition" as const,
          deliveryPublicId: null,
          reasonCode: "SUBSCRIPTION_NOT_FOUND",
          message: "The selected webhook subscription no longer exists.",
        };
      }
      if (sub.status !== "active") {
        return {
          outcome: "disabled" as const,
          deliveryPublicId: null,
          reasonCode: sub.status === "disabled_failing" ? "SUBSCRIPTION_DISABLED_FAILING" : "SUBSCRIPTION_PAUSED",
          message:
            sub.status === "disabled_failing"
              ? "The selected webhook subscription is disabled due to repeated failures."
              : "The selected webhook subscription is currently paused.",
        };
      }

      const dedupeKey = `wf:${sub.publicId}:${input.idempotencyKey}`.slice(0, 160);
      const existingRows = await tx
        .select({
          publicId: integrationWebhookDeliveries.publicId,
          status: integrationWebhookDeliveries.status,
        })
        .from(integrationWebhookDeliveries)
        .where(
          and(
            eq(integrationWebhookDeliveries.direction, "outbound"),
            eq(integrationWebhookDeliveries.deduplicationKey, dedupeKey),
          ),
        )
        .limit(1);
      const existing = existingRows[0];
      if (existing) {
        return {
          outcome: "already_queued_or_delivered" as const,
          deliveryPublicId: existing.publicId,
          reasonCode: "WEBHOOK_ALREADY_QUEUED",
          message: "A delivery for this stage webhook run has already been queued.",
        };
      }

      const now = deps.clock.now();
      const correlationId = input.correlationId ?? currentCorrelationId();
      const deliveryPublicId = ulid();
      const rawEventKey = input.eventKey?.trim() ?? "";
      const eventKey =
        rawEventKey && EVENT_KEY_RE.test(rawEventKey)
          ? rawEventKey
          : input.stageKey
            ? "order.stage_webhook_triggered"
            : "automation.webhook_triggered";
      const envelopeObj = {
        id: deliveryPublicId,
        event: eventKey,
        createdAt: now.toISOString(),
        correlationId,
        resource: input.orderPublicId
          ? { type: "order", id: input.orderPublicId }
          : { type: "automation", id: input.idempotencyKey.slice(0, 64) },
        data: {
          ...(input.orderPublicId ? { orderPublicId: input.orderPublicId } : {}),
          ...(input.stageKey ? { stageKey: input.stageKey } : {}),
          triggerSource: input.triggerSource,
          ...input.payload,
        },
      };
      const redacted = redactAndBoundBody(JSON.stringify(envelopeObj));
      const payloadEnc = encryptDeliveryPayload(deps.crypto, deliveryPublicId, {
        requestHeaders: {},
        requestBody: redacted.body,
        responseHeaders: null,
        responseBody: null,
      });
      const targetLabel = `${sub.name} (${sub.targetUrlHost})`.slice(0, 255);
      const actorLabel = input.actor
        ? `${input.actor.role}:${input.actor.userPublicId}`
        : input.actorPublicId
          ? `staff:${input.actorPublicId}`
          : "system";

      const { jobId } = await deps.jobs.enqueue(
        WEBHOOK_DELIVER_JOB,
        { deliveryPublicId },
        {
          idempotencyKey: `webhook_deliver:${deliveryPublicId}`,
          maxAttempts: WEBHOOK_MAX_ATTEMPTS,
          correlationId,
        },
        tx,
      );

      await tx.insert(integrationWebhookDeliveries).values({
        publicId: deliveryPublicId,
        direction: "outbound",
        subscriptionId: sub.id,
        subscriptionPublicId: sub.publicId,
        orderPublicId: input.orderPublicId,
        stageKey: input.stageKey ? input.stageKey.slice(0, 64) : null,
        targetLabel,
        eventKey,
        externalEventId: input.idempotencyKey.slice(0, 128),
        deduplicationKey: dedupeKey,
        status: "queued",
        httpMethod: "POST",
        httpPath: sub.targetUrlMasked.slice(0, 255),
        requestBytes: Buffer.byteLength(redacted.body, "utf8"),
        attemptCount: 0,
        maxAttempts: WEBHOOK_MAX_ATTEMPTS,
        jobPublicId: jobId,
        correlationId,
        actorLabel,
        payloadSha256: sha256Hex(redacted.body),
        payloadEnc,
        bodyTruncated: redacted.truncated,
        bodyPurged: false,
        isReplay: false,
        isTest: false,
        searchText: buildSearchText([
          deliveryPublicId,
          eventKey,
          targetLabel,
          "queued",
          correlationId,
          input.orderPublicId,
          input.stageKey,
        ]),
        expiresAt: computeExpiry(now, cfg.retentionDays),
      });

      return {
        outcome: "queued" as const,
        deliveryPublicId,
        reasonCode: null,
        message: null,
      };
    },

    async listSubscriptionTargetsForPicker(tx?: DbOrTx) {
      const dbOrTx = tx ?? deps.db;
      const cfg = await readConfig(tx as Tx | undefined);
      const rows = await dbOrTx
        .select({
          publicId: integrationWebhookSubscriptions.publicId,
          name: integrationWebhookSubscriptions.name,
          status: integrationWebhookSubscriptions.status,
          signingEnabled: integrationWebhookSubscriptions.signingEnabled,
        })
        .from(integrationWebhookSubscriptions)
        .orderBy(asc(integrationWebhookSubscriptions.name), asc(integrationWebhookSubscriptions.id))
        .limit(200);
      return rows.map((r) => ({
        publicId: r.publicId,
        name: r.name,
        status: r.status as WebhookSubscriptionStatus,
        signingEnabled: r.signingEnabled !== false,
        webhooksEnabled: cfg.enabled,
      }));
    },

    async getSubscriptionTargetStatus(subscriptionPublicId: string, tx?: DbOrTx) {
      const dbOrTx = tx ?? deps.db;
      const cfg = await readConfig(tx as Tx | undefined);
      const rows = await dbOrTx
        .select({
          name: integrationWebhookSubscriptions.name,
          status: integrationWebhookSubscriptions.status,
          signingEnabled: integrationWebhookSubscriptions.signingEnabled,
        })
        .from(integrationWebhookSubscriptions)
        .where(eq(integrationWebhookSubscriptions.publicId, subscriptionPublicId))
        .limit(1);
      const row = rows[0];
      if (!row) {
        return {
          exists: false,
          name: null,
          status: null,
          signingEnabled: true,
          webhooksEnabled: cfg.enabled,
        };
      }
      return {
        exists: true,
        name: row.name,
        status: row.status as WebhookSubscriptionStatus,
        signingEnabled: row.signingEnabled !== false,
        webhooksEnabled: cfg.enabled,
      };
    },

    /* ------------------------------------------------- raw HTTP inbound receiver */

    async receiveInboundHttp(input: InboundHttpReceiveInput): Promise<InboundHttpReceiveResult> {
      const startedMs = deps.clock.now().getTime();
      if (!PUBLIC_ID_RE.test(input.endpointPublicId)) {
        return {
          httpStatus: 404,
          body: { ok: false, code: "ENDPOINT_NOT_FOUND", message: "Inbound endpoint not found." },
        };
      }
      if (input.rawBody.byteLength > MAX_INBOUND_RAW_BODY_BYTES) {
        return {
          httpStatus: 413,
          body: { ok: false, code: "PAYLOAD_TOO_LARGE", message: "Webhook payload exceeds 256 KiB." },
        };
      }

      const cfg = await readConfig();
      if (!cfg.enabled) {
        return {
          httpStatus: 503,
          body: { ok: false, code: "WEBHOOKS_DISABLED", message: "Webhooks are currently disabled." },
        };
      }

      const epRows = await deps.db
        .select()
        .from(integrationWebhookInboundEndpoints)
        .where(eq(integrationWebhookInboundEndpoints.publicId, input.endpointPublicId))
        .limit(1);
      const ep = epRows[0];
      if (!ep || !ep.enabled) {
        return {
          httpStatus: 404,
          body: { ok: false, code: "ENDPOINT_NOT_FOUND", message: "Inbound endpoint not found." },
        };
      }

      const now = deps.clock.now();
      const primarySecret = deps.crypto.decrypt(ep.signingSecretEnc, inboundSecretAad(ep.publicId));
      const overlapSecret =
        ep.previousSecretEnc &&
        ep.previousSecretExpiresAt instanceof Date &&
        now.getTime() < ep.previousSecretExpiresAt.getTime()
          ? deps.crypto.decrypt(ep.previousSecretEnc, inboundSecretAad(ep.publicId))
          : null;

      const sigHeader =
        input.headers["x-readypackets-signature"] ?? input.headers["x-webhook-signature"];

      // SECURITY (§4): Verify constant-time HMAC-SHA256 & ±5m timestamp BEFORE parsing JSON!
      const verdict = verifyInboundWebhookSignature({
        rawBody: input.rawBody,
        signatureHeader: sigHeader,
        now,
        primarySecret,
        overlapSecret,
        overlapExpiresAt: ep.previousSecretExpiresAt,
        toleranceSeconds: ep.toleranceSeconds,
      });

      if (!verdict.ok) {
        deps.audit.note({
          category: "security",
          eventName: "integration.webhook.inbound_rejected",
          action: "receive",
          outcome: "denied",
          severity: "WARN",
          reasonCode: verdict.reasonCode,
          actor: { role: "anonymous" },
          resource: { type: "webhook_inbound_endpoint", publicId: ep.publicId },
          correlationId: input.correlationId,
          attributes: {
            endpoint_public_id: ep.publicId,
            endpoint_key: ep.endpointKey,
          },
        });
        return {
          httpStatus: 401,
          body: {
            ok: false,
            code: verdict.reasonCode,
            message: "Webhook signature or timestamp verification failed.",
          },
        };
      }

      // Signature and timestamp verified — ONLY NOW parse JSON!
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(input.rawBody.toString("utf8"));
      } catch {
        return {
          httpStatus: 400,
          body: { ok: false, code: "MALFORMED_JSON", message: "Webhook body must be valid JSON." },
        };
      }

      if (typeof parsedJson !== "object" || parsedJson === null || Array.isArray(parsedJson)) {
        return {
          httpStatus: 400,
          body: { ok: false, code: "INVALID_JSON_ENVELOPE", message: "Webhook body must be a JSON object." },
        };
      }
      const obj = parsedJson as Record<string, unknown>;
      // SECURITY: Derive event identity and event type ONLY from the HMAC-verified JSON payload.
      // Unsigned HTTP headers cannot override or supply event identity or automation routing type.
      const rawEventId =
        (typeof obj.id === "string" ? obj.id.trim() : "") ||
        (typeof obj.event_id === "string" ? obj.event_id.trim() : "");
      const rawEventType =
        (typeof obj.type === "string" ? obj.type.trim() : "") ||
        (typeof obj.event === "string" ? obj.event.trim() : "");

      const headerEventId =
        typeof input.headers["x-readypackets-event-id"] === "string"
          ? input.headers["x-readypackets-event-id"].trim()
          : "";
      const headerEventType =
        typeof input.headers["x-readypackets-event"] === "string"
          ? input.headers["x-readypackets-event"].trim()
          : "";

      if (!rawEventId || rawEventId.length > 128 || !hasNoHeaderInjection(rawEventId)) {
        return {
          httpStatus: 400,
          body: {
            ok: false,
            code: "MISSING_EVENT_ID",
            message: "Signed JSON payload must supply a unique event `id` (1–128 characters).",
          },
        };
      }
      if (!rawEventType || !EVENT_KEY_RE.test(rawEventType)) {
        return {
          httpStatus: 400,
          body: {
            ok: false,
            code: "INVALID_EVENT_TYPE",
            message: "Signed JSON payload must supply a valid event `type`.",
          },
        };
      }
      if ((headerEventId && headerEventId !== rawEventId) || (headerEventType && headerEventType !== rawEventType)) {
        return {
          httpStatus: 400,
          body: {
            ok: false,
            code: "HEADER_BODY_MISMATCH",
            message: "Event metadata headers do not match the signed JSON payload.",
          },
        };
      }

      const dedupeKey = `in:${ep.id}:${rawEventId}`.slice(0, 160);
      const redactedHeaders = redactHeaderMap(input.headers);
      const redactedBody = redactAndBoundBody(input.rawBody);
      const payloadSha = sha256Hex(input.rawBody);
      const targetLabel = `${ep.name} (${ep.endpointKey})`.slice(0, 255);
      const purgeNow = cfg.retentionDays <= 0;

      return deps.db.transaction(async (tx) => {
        const existing = await tx
          .select({ publicId: integrationWebhookDeliveries.publicId })
          .from(integrationWebhookDeliveries)
          .where(
            and(
              eq(integrationWebhookDeliveries.direction, "inbound"),
              eq(integrationWebhookDeliveries.deduplicationKey, dedupeKey),
            ),
          )
          .limit(1);
        if (existing[0]) {
          return {
            httpStatus: 200,
            body: { ok: true, deliveryId: existing[0].publicId, duplicate: true },
          };
        }

        const deliveryPubId = ulid();
        const attemptPubId = ulid();
        const finishedAt = deps.clock.now();
        const durationMs = Math.max(0, finishedAt.getTime() - startedMs);
        const respBodyStr = JSON.stringify({ ok: true, deliveryId: deliveryPubId, duplicate: false });

        const payloadEnc = purgeNow
          ? null
          : encryptDeliveryPayload(deps.crypto, deliveryPubId, {
              requestHeaders: redactedHeaders,
              requestBody: redactedBody.body,
              responseHeaders: { "content-type": "application/json" },
              responseBody: respBodyStr,
            });

        try {
          const [ins] = await tx.insert(integrationWebhookDeliveries).values({
            publicId: deliveryPubId,
            direction: "inbound",
            inboundEndpointId: ep.id,
            inboundEndpointPublicId: ep.publicId,
            targetLabel,
            eventKey: rawEventType,
            externalEventId: rawEventId,
            deduplicationKey: dedupeKey,
            status: "processed",
            httpMethod: "POST",
            httpPath: `/api/webhooks/inbound/${ep.publicId}`,
            httpStatus: 200,
            durationMs,
            requestBytes: input.rawBody.byteLength,
            responseBytes: Buffer.byteLength(respBodyStr, "utf8"),
            attemptCount: 1,
            maxAttempts: 1,
            correlationId: input.correlationId,
            actorLabel: `endpoint:${ep.endpointKey}`,
            payloadSha256: payloadSha,
            payloadEnc,
            bodyTruncated: redactedBody.truncated,
            bodyPurged: purgeNow,
            isReplay: false,
            isTest: false,
            searchText: buildSearchText([
              deliveryPubId,
              rawEventType,
              rawEventId,
              targetLabel,
              "processed",
              input.correlationId,
            ]),
            expiresAt: computeExpiry(finishedAt, cfg.retentionDays),
            completedAt: finishedAt,
          });

          await tx.insert(integrationWebhookDeliveryAttempts).values({
            publicId: attemptPubId,
            deliveryId: Number(ins.insertId),
            attemptNumber: 1,
            outcome: "succeeded",
            httpStatus: 200,
            durationMs,
            reasonCode: null,
            responseBytes: Buffer.byteLength(respBodyStr, "utf8"),
            responseEnc: null,
            occurredAt: finishedAt,
          });
        } catch (err) {
          const errno = (err as { errno?: number; cause?: { errno?: number } })?.errno ??
            (err as { cause?: { errno?: number } })?.cause?.errno;
          if (errno === 1062) {
            const raceExisting = await tx
              .select({ publicId: integrationWebhookDeliveries.publicId })
              .from(integrationWebhookDeliveries)
              .where(
                and(
                  eq(integrationWebhookDeliveries.direction, "inbound"),
                  eq(integrationWebhookDeliveries.deduplicationKey, dedupeKey),
                ),
              )
              .limit(1);
            return {
              httpStatus: 200,
              body: { ok: true, deliveryId: raceExisting[0]?.publicId, duplicate: true },
            };
          }
          throw err;
        }

        await tx
          .update(integrationWebhookInboundEndpoints)
          .set({ lastReceivedAt: finishedAt, updatedAt: finishedAt })
          .where(eq(integrationWebhookInboundEndpoints.id, ep.id));

        // Durable audit event driving `webhook.inbound_received` trigger — starts automations ONLY.
        await deps.audit.record(
          {
            category: "integration",
            eventName: "integration.webhook.inbound_received",
            action: "receive",
            outcome: "completed",
            actor: { role: "system" },
            resource: { type: "webhook_inbound_endpoint", publicId: ep.publicId },
            deliveryId: deliveryPubId,
            correlationId: input.correlationId,
            attributes: {
              delivery_public_id: deliveryPubId,
              endpoint_public_id: ep.publicId,
              endpoint_key: ep.endpointKey,
              event_type: safeAuditToken(rawEventType, "inbound.event", 96),
              is_replay: false,
            },
          },
          tx,
        );

        return {
          httpStatus: 200,
          body: { ok: true, deliveryId: deliveryPubId, duplicate: false },
        };
      });
    },

    /* ------------------------------------------------- Public API v1 provider (`webhookSubscriptions`) */

    async listSubscriptionsPublicApi(
      query: ApiListQuery,
      _caller: ApiCaller,
    ): Promise<ApiPage<WebhookSubscriptionDto>> {
      const limit = Math.min(100, Math.max(1, query.limit));
      const decoded = decodeCursor(query.cursor);
      const predicates: SQL[] = [];
      if (query.filter.status) {
        predicates.push(eq(integrationWebhookSubscriptions.status, query.filter.status));
      }
      if (query.updatedSince) {
        predicates.push(gte(integrationWebhookSubscriptions.updatedAt, query.updatedSince));
      }
      if (decoded) {
        const cursorDate = new Date(decoded.t);
        predicates.push(
          or(
            lt(integrationWebhookSubscriptions.createdAt, cursorDate),
            and(
              eq(integrationWebhookSubscriptions.createdAt, cursorDate),
              lt(integrationWebhookSubscriptions.id, decoded.id),
            ),
          )!,
        );
      }

      const rows = await deps.db
        .select()
        .from(integrationWebhookSubscriptions)
        .where(predicates.length > 0 ? and(...predicates) : undefined)
        .orderBy(desc(integrationWebhookSubscriptions.createdAt), desc(integrationWebhookSubscriptions.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      const now = deps.clock.now();

      return {
        items: page.map((r) => {
          const view = toSubscriptionView(r, now);
          return {
            id: view.publicId,
            name: view.name,
            targetUrlHost: view.targetUrlHost,
            events: view.events,
            status: view.status,
            consecutiveFailures: view.consecutiveFailures,
            createdAt: view.createdAt.toISOString(),
            updatedAt: view.updatedAt.toISOString(),
          };
        }),
        nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
      };
    },

    async getSubscriptionPublicApi(
      publicId: string,
      _caller: ApiCaller,
    ): Promise<WebhookSubscriptionDto | null> {
      const rows = await deps.db
        .select()
        .from(integrationWebhookSubscriptions)
        .where(eq(integrationWebhookSubscriptions.publicId, publicId))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      const view = toSubscriptionView(row, deps.clock.now());
      return {
        id: view.publicId,
        name: view.name,
        targetUrlHost: view.targetUrlHost,
        events: view.events,
        status: view.status,
        consecutiveFailures: view.consecutiveFailures,
        createdAt: view.createdAt.toISOString(),
        updatedAt: view.updatedAt.toISOString(),
      };
    },

    async onOrderTrashedInTx(tx, entity) {
      if (entity.kind !== "order") return;
      const now = deps.clock.now();
      await tx
        .update(integrationWebhookDeliveries)
        .set({
          status: "stopped",
          reasonCode: "ORDER_TRASHED",
          stopReason: "ORDER_TRASHED",
          stoppedAt: now,
          nextAttemptAt: null,
          tapEventEnc: null,
          payloadEnc: null,
          bodyPurged: true,
          completedAt: now,
          updatedAt: now,
          version: sql`${integrationWebhookDeliveries.version} + 1`,
        })
        .where(
          and(
            eq(integrationWebhookDeliveries.orderPublicId, entity.publicId),
            inArray(integrationWebhookDeliveries.status, ["queued", "retrying"]),
          ),
        );
    },

    async purgeOrderDeliveriesInTx(tx, entity) {
      if (entity.kind !== "order") return { deleted: {} };
      const deliveries = await tx
        .select({ id: integrationWebhookDeliveries.id })
        .from(integrationWebhookDeliveries)
        .where(eq(integrationWebhookDeliveries.orderPublicId, entity.publicId));
      if (deliveries.length === 0) return { deleted: {} };
      const ids = deliveries.map((d) => d.id);
      await tx
        .delete(integrationWebhookDeliveryAttempts)
        .where(inArray(integrationWebhookDeliveryAttempts.deliveryId, ids));
      const [res] = await tx
        .delete(integrationWebhookDeliveries)
        .where(inArray(integrationWebhookDeliveries.id, ids));
      const deleted: Record<string, number> = {};
      if (res.affectedRows > 0) deleted.webhookPayloadCopies = res.affectedRows;
      return { deleted };
    },

    async purgeOrderDeliveries(entity, run) {
      if (entity.kind !== "order") return { deleted: {} };
      return deps.db.transaction(async (tx) => {
        await run.assertCurrentInTx(tx);
        const deliveries = await tx
          .select({ id: integrationWebhookDeliveries.id })
          .from(integrationWebhookDeliveries)
          .where(eq(integrationWebhookDeliveries.orderPublicId, entity.publicId));
        if (deliveries.length === 0) return { deleted: {} };
        const ids = deliveries.map((d) => d.id);
        await tx
          .delete(integrationWebhookDeliveryAttempts)
          .where(inArray(integrationWebhookDeliveryAttempts.deliveryId, ids));
        const [res] = await tx
          .delete(integrationWebhookDeliveries)
          .where(inArray(integrationWebhookDeliveries.id, ids));
        const deleted: Record<string, number> = {};
        if (res.affectedRows > 0) deleted.webhookPayloadCopies = res.affectedRows;
        return { deleted };
      });
    },
  };
}
