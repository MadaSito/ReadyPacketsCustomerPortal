/**
 * Increment 04 Package I — Outbound Webhook Subscriptions, Inbound Endpoints, Delivery Log & Re-Run.
 * Public and internal TypeScript contracts (`server/modules/integrations/webhooks/types.ts`).
 */
import type { AuditTap } from "../../audit/tap.js";
import type { ApiCaller, ApiListQuery, ApiPage, WebhookSubscriptionDto } from "../../publicApi/ports.js";
import type { TrashEntityRef, TrashPurgeRun } from "../../trash/ports.js";
import type { DbOrTx, ModuleHealth, SessionPrincipal, Tx } from "../../../core/types.js";

export const WEBHOOK_SUBSCRIPTION_STATUSES = ["active", "paused", "disabled_failing"] as const;
export type WebhookSubscriptionStatus = (typeof WEBHOOK_SUBSCRIPTION_STATUSES)[number];

export const WEBHOOK_DIRECTIONS = ["outbound", "inbound"] as const;
export type WebhookDirection = (typeof WEBHOOK_DIRECTIONS)[number];

export const WEBHOOK_DELIVERY_STATUSES = [
  "queued",
  "delivering",
  "delivered",
  "retrying",
  "failed",
  "dead",
  "unknown",
  "stopped",
  "processed",
  "duplicate",
  "rejected",
] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

export interface WebhooksSettingsView {
  enabled: boolean;
  retentionDays: number;
  autoDisableThreshold: number;
  deliveryTimeoutMs: number;
}

export interface UpdateWebhooksSettingsInput {
  enabled?: boolean;
  retentionDays?: number;
  autoDisableThreshold?: number;
  deliveryTimeoutMs?: number;
}

export interface WebhookCatalogueEventView {
  key: string;
  label: string;
  group: string;
  description: string;
}

export interface WebhookSubscriptionView {
  publicId: string;
  name: string;
  description: string | null;
  targetUrlHost: string;
  targetUrlMasked: string;
  events: string[];
  status: WebhookSubscriptionStatus;
  signingEnabled: boolean;
  signingSecretLast4: string;
  hasOverlapSecret: boolean;
  overlapExpiresAt: Date | null;
  consecutiveFailures: number;
  lastDeliveredAt: Date | null;
  lastFailedAt: Date | null;
  lastFailureReason: string | null;
  autoDisabledAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWebhookSubscriptionInput {
  name: string;
  description?: string | null;
  targetUrl: string;
  events: readonly string[];
  paused?: boolean;
  signingEnabled?: boolean;
}

export interface UpdateWebhookSubscriptionInput {
  publicId: string;
  expectedVersion: number;
  name?: string;
  description?: string | null;
  targetUrl?: string;
  events?: readonly string[];
  signingEnabled?: boolean;
}

export interface WebhookInboundEndpointView {
  publicId: string;
  name: string;
  endpointKey: string;
  description: string | null;
  enabled: boolean;
  receivePath: string;
  signingSecretLast4: string;
  hasOverlapSecret: boolean;
  overlapExpiresAt: Date | null;
  toleranceSeconds: number;
  lastReceivedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWebhookInboundEndpointInput {
  name: string;
  endpointKey: string;
  description?: string | null;
  enabled?: boolean;
  toleranceSeconds?: number;
}

export interface UpdateWebhookInboundEndpointInput {
  publicId: string;
  expectedVersion: number;
  name?: string;
  description?: string | null;
  toleranceSeconds?: number;
}

export interface WebhookDeliveryListItemView {
  publicId: string;
  direction: WebhookDirection;
  subscriptionPublicId: string | null;
  inboundEndpointPublicId: string | null;
  targetLabel: string;
  eventKey: string;
  externalEventId: string | null;
  status: WebhookDeliveryStatus;
  httpMethod: string;
  httpPath: string;
  httpStatus: number | null;
  durationMs: number | null;
  requestBytes: number;
  responseBytes: number;
  attemptCount: number;
  maxAttempts: number;
  reasonCode: string | null;
  correlationId: string;
  actorLabel: string;
  bodyTruncated: boolean;
  bodyPurged: boolean;
  isReplay: boolean;
  replayOfPublicId: string | null;
  isTest: boolean;
  canReplay: boolean;
  canRetry: boolean;
  canStop: boolean;
  orderPublicId: string | null;
  stageKey: string | null;
  manualRetryCount: number;
  stoppedAt: Date | null;
  stoppedByPublicId: string | null;
  stopReason: string | null;
  expiresAt: Date;
  completedAt: Date | null;
  createdAt: Date;
}

export interface WebhookDeliveryAttemptView {
  publicId: string;
  attemptNumber: number;
  outcome: "succeeded" | "failed" | "rejected" | "unknown";
  httpStatus: number | null;
  durationMs: number;
  reasonCode: string | null;
  responseBytes: number;
  responseHeaders: Record<string, string> | null;
  responseBody: string | null;
  occurredAt: Date;
}

export interface WebhookDeliveryDetailView extends WebhookDeliveryListItemView {
  payloadSha256: string;
  requestHeaders: Record<string, string> | null;
  requestBody: string | null;
  responseHeaders: Record<string, string> | null;
  responseBody: string | null;
  attempts: WebhookDeliveryAttemptView[];
}

export interface ListWebhookDeliveriesInput {
  direction?: WebhookDirection;
  subscriptionPublicId?: string;
  inboundEndpointPublicId?: string;
  orderPublicId?: string;
  eventKey?: string;
  status?: WebhookDeliveryStatus;
  from?: Date;
  to?: Date;
  correlationId?: string;
  search?: string;
  cursor?: string;
  limit?: number;
}

export interface WebhookPublishOptions {
  deduplicationKey?: string;
  correlationId?: string;
  resourceType?: string;
  resourcePublicId?: string;
  orderPublicId?: string | null;
  stageKey?: string | null;
}

export interface InboundHttpReceiveInput {
  endpointPublicId: string;
  rawBody: Buffer;
  headers: Record<string, string | undefined>;
  correlationId: string;
  ipAddress?: string | null;
}

export interface InboundHttpReceiveResult {
  httpStatus: number;
  body: {
    ok: boolean;
    deliveryId?: string;
    duplicate?: boolean;
    code?: string;
    message?: string;
  };
}

export interface WebhooksService {
  readonly auditTap: AuditTap;

  init(): void;
  health(): Promise<ModuleHealth>;

  getSettings(principal: SessionPrincipal): Promise<WebhooksSettingsView>;
  updateSettings(principal: SessionPrincipal, input: UpdateWebhooksSettingsInput): Promise<WebhooksSettingsView>;

  listCatalogueEvents(principal: SessionPrincipal): Promise<WebhookCatalogueEventView[]>;

  listSubscriptions(
    principal: SessionPrincipal,
    input: { status?: WebhookSubscriptionStatus; cursor?: string; limit?: number },
  ): Promise<{ items: WebhookSubscriptionView[]; nextCursor: string | null }>;
  getSubscription(principal: SessionPrincipal, publicId: string): Promise<WebhookSubscriptionView>;
  createSubscription(
    principal: SessionPrincipal,
    input: CreateWebhookSubscriptionInput,
  ): Promise<{ subscription: WebhookSubscriptionView; signingSecretOnce: string }>;
  updateSubscription(
    principal: SessionPrincipal,
    input: UpdateWebhookSubscriptionInput,
  ): Promise<WebhookSubscriptionView>;
  setSubscriptionPaused(
    principal: SessionPrincipal,
    input: { publicId: string; expectedVersion: number; paused: boolean },
  ): Promise<WebhookSubscriptionView>;
  rotateSubscriptionSecret(
    principal: SessionPrincipal,
    input: { publicId: string; expectedVersion: number; overlapMinutes?: number },
  ): Promise<{ subscription: WebhookSubscriptionView; signingSecretOnce: string }>;
  testSubscriptionDelivery(
    principal: SessionPrincipal,
    input: { publicId: string; eventKey?: string },
  ): Promise<WebhookDeliveryDetailView>;
  deleteSubscription(
    principal: SessionPrincipal,
    input: { publicId: string; expectedVersion: number },
  ): Promise<{ deleted: true }>;

  listInboundEndpoints(
    principal: SessionPrincipal,
    input: { enabled?: boolean; cursor?: string; limit?: number },
  ): Promise<{ items: WebhookInboundEndpointView[]; nextCursor: string | null }>;
  getInboundEndpoint(principal: SessionPrincipal, publicId: string): Promise<WebhookInboundEndpointView>;
  createInboundEndpoint(
    principal: SessionPrincipal,
    input: CreateWebhookInboundEndpointInput,
  ): Promise<{ endpoint: WebhookInboundEndpointView; signingSecretOnce: string }>;
  updateInboundEndpoint(
    principal: SessionPrincipal,
    input: UpdateWebhookInboundEndpointInput,
  ): Promise<WebhookInboundEndpointView>;
  setInboundEndpointEnabled(
    principal: SessionPrincipal,
    input: { publicId: string; expectedVersion: number; enabled: boolean },
  ): Promise<WebhookInboundEndpointView>;
  rotateInboundEndpointSecret(
    principal: SessionPrincipal,
    input: { publicId: string; expectedVersion: number; overlapMinutes?: number },
  ): Promise<{ endpoint: WebhookInboundEndpointView; signingSecretOnce: string }>;
  deleteInboundEndpoint(
    principal: SessionPrincipal,
    input: { publicId: string; expectedVersion: number },
  ): Promise<{ deleted: true }>;

  listDeliveries(
    principal: SessionPrincipal,
    input: ListWebhookDeliveriesInput,
  ): Promise<{ items: WebhookDeliveryListItemView[]; nextCursor: string | null }>;
  getDelivery(principal: SessionPrincipal, publicId: string): Promise<WebhookDeliveryDetailView>;
  stopDelivery(
    principal: SessionPrincipal,
    input: { publicId: string; reason?: string | null },
  ): Promise<WebhookDeliveryDetailView>;
  retryDelivery(principal: SessionPrincipal, input: { publicId: string }): Promise<WebhookDeliveryDetailView>;
  redeliver(principal: SessionPrincipal, input: { publicId: string }): Promise<WebhookDeliveryDetailView>;
  reprocessInbound(principal: SessionPrincipal, input: { publicId: string }): Promise<WebhookDeliveryDetailView>;

  publish(
    eventKey: string,
    payload: Record<string, unknown>,
    options?: WebhookPublishOptions,
    tx?: Tx,
  ): Promise<{ queued: number; deliveryPublicIds: string[] }>;

  enqueueWorkflowSubscription(
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
  ): Promise<{
    outcome: "queued" | "already_queued_or_delivered" | "refused_precondition" | "disabled";
    deliveryPublicId: string | null;
    reasonCode: string | null;
    message: string | null;
  }>;

  listSubscriptionTargetsForPicker(tx?: DbOrTx): Promise<
    Array<{
      publicId: string;
      name: string;
      status: WebhookSubscriptionStatus;
      signingEnabled: boolean;
      webhooksEnabled: boolean;
    }>
  >;

  getSubscriptionTargetStatus(
    subscriptionPublicId: string,
    tx?: DbOrTx,
  ): Promise<{
    exists: boolean;
    name: string | null;
    status: WebhookSubscriptionStatus | null;
    signingEnabled: boolean;
    webhooksEnabled: boolean;
  }>;

  receiveInboundHttp(input: InboundHttpReceiveInput): Promise<InboundHttpReceiveResult>;

  listSubscriptionsPublicApi(query: ApiListQuery, caller: ApiCaller): Promise<ApiPage<WebhookSubscriptionDto>>;
  getSubscriptionPublicApi(publicId: string, caller: ApiCaller): Promise<WebhookSubscriptionDto | null>;
  onOrderTrashedInTx(tx: Tx, entity: TrashEntityRef): Promise<void>;
  purgeOrderDeliveriesInTx(tx: Tx, entity: TrashEntityRef): Promise<{ deleted: Record<string, number> }>;
  purgeOrderDeliveries(entity: TrashEntityRef, run: TrashPurgeRun): Promise<{ deleted: Record<string, number> }>;
}
