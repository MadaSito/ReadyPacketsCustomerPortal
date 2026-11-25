/**
 * Integrations module — Drizzle MySQL tables. Owner: integrations module engineer.
 *
 * Tables:
 *  - `integration_egress_allowlist`       : Explicit admin-approved egress destinations (step-up + audited).
 *  - `integration_provider_checks`        : Truthful last-check state per optional provider (never fake "ok").
 *  - `integration_webhook_events`         : Durable authenticated webhook inbox for idempotent delivery handling.
 *  - `integration_production_dispatches`  : Outbound P101/P201 production webhook outbox & delivery audit state.
 */
import { bigint, boolean, char, index, int, mysqlTable, text, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { createdAtColumn, idColumn, publicIdColumn, refColumn, updatedAtColumn, utcDateTime, versionColumn } from "../../db/columns.js";

export const integrationEgressAllowlist = mysqlTable(
  "integration_egress_allowlist",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    purpose: varchar("purpose", { length: 32 }).notNull(),
    matchType: varchar("match_type", { length: 16 }).notNull(), // "host" | "ip" | "cidr"
    pattern: varchar("pattern", { length: 255 }).notNull(),
    port: int("port", { unsigned: true }).notNull(),
    protocol: varchar("protocol", { length: 16 }).notNull(), // "https:" | "tls:" | "smtp:" | "smtps:"
    allowPrivateAddress: boolean("allow_private_address").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    justification: varchar("justification", { length: 280 }).notNull(),
    createdByUserId: refColumn("created_by_user_id"),
    updatedByUserId: refColumn("updated_by_user_id"),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("uq_integration_egress_target").on(table.purpose, table.pattern, table.port, table.protocol),
    index("idx_integration_egress_purpose_enabled").on(table.purpose, table.enabled),
  ],
);

export const integrationProviderChecks = mysqlTable(
  "integration_provider_checks",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    providerKey: varchar("provider_key", { length: 32 }).notNull(),
    lastCheckedAt: utcDateTime("last_checked_at").notNull(),
    lastOutcome: varchar("last_outcome", { length: 24 }).notNull(), // "succeeded" | "failed" | "unknown"
    lastReasonCode: varchar("last_reason_code", { length: 64 }),
    verifiedAt: utcDateTime("verified_at"),
    consecutiveFailures: int("consecutive_failures", { unsigned: true }).notNull().default(0),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [uniqueIndex("uq_integration_provider_checks_key").on(table.providerKey)],
);

export const integrationWebhookEvents = mysqlTable(
  "integration_webhook_events",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    provider: varchar("provider", { length: 32 }).notNull(),
    externalEventId: varchar("external_event_id", { length: 128 }).notNull(),
    eventType: varchar("event_type", { length: 96 }).notNull(),
    payloadSha256: char("payload_sha256", { length: 64 }).notNull(),
    status: varchar("status", { length: 24 }).notNull(), // "processing" | "processed" | "ignored" | "failed"
    reasonCode: varchar("reason_code", { length: 64 }),
    providerTimestamp: utcDateTime("provider_timestamp").notNull(),
    processedAt: utcDateTime("processed_at"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("uq_integration_webhook_provider_event").on(table.provider, table.externalEventId),
    index("idx_integration_webhook_status").on(table.provider, table.status),
  ],
);

export const integrationProductionDispatches = mysqlTable(
  "integration_production_dispatches",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    orderId: refColumn("order_id").notNull(),
    orderPublicId: char("order_public_id", { length: 26 }).notNull(),
    orderReference: varchar("order_reference", { length: 64 }).notNull(),
    /** Order owner bound at queue time; worker refuses delivery if ownership changes before send (PW-03). */
    expectedOwnerUserId: refColumn("expected_owner_user_id").notNull(),
    /** Keyed HMAC-SHA-256 fingerprint of authorized destination/auth/config; worker cancels with DESTINATION_CHANGED on drift (PW-04). */
    destinationFingerprint: char("destination_fingerprint", { length: 64 }).notNull(),
    /** Linked job ledger identifier (`job_runs.public_id`) used to fence reconciliation against live worker ownership (PW-02). */
    jobPublicId: varchar("job_public_id", { length: 36 }).notNull(),
    /** Monotonic `ClaimedJob.fencingToken` recorded on `queued -> sending` claim and required on finalization (PW-02). */
    activeFencingToken: bigint("active_fencing_token", { mode: "number", unsigned: true }).notNull().default(0),
    /** Bounded outbox retention deadline (`created_at + 24h`); expired queued rows cancel their job under fence and scrub `payload_enc` (PW-02). */
    expiresAt: utcDateTime("expires_at").notNull(),
    phase: varchar("phase", { length: 8 }).notNull(), // "P101" | "P201"
    state: varchar("state", { length: 16 }).notNull(), // "queued" | "sending" | "delivered" | "failed" | "dead" | "unknown"
    attemptCount: int("attempt_count", { unsigned: true }).notNull().default(0),
    idempotencyKey: varchar("idempotency_key", { length: 96 }).notNull(),
    payloadSha256: char("payload_sha256", { length: 64 }).notNull(),
    /** FieldCrypto-encrypted JSON payload retained only during the retry window; set NULL once terminal. */
    payloadEnc: text("payload_enc"),
    /** Exact identity triple sent (P201 copies these verbatim from the delivered P101 row). */
    sentCustomerId: varchar("sent_customer_id", { length: 120 }).notNull(),
    sentOrderId: varchar("sent_order_id", { length: 120 }).notNull(),
    sentRunMode: varchar("sent_run_mode", { length: 32 }).notNull(),
    /** Non-personal P101 scope metadata preserved after payloadEnc is cleared. */
    packet: varchar("packet", { length: 8 }),
    tier: varchar("tier", { length: 16 }),
    bundleScopeManifest: varchar("bundle_scope_manifest", { length: 512 }),
    releaseStatus: varchar("release_status", { length: 120 }),
    /** Fixed server-generated delivery status summary only; NEVER stores or reflects receiver response text (PW-01). */
    httpStatus: int("http_status", { unsigned: true }),
    responseSummary: varchar("response_summary", { length: 200 }),
    lastReasonCode: varchar("last_reason_code", { length: 64 }),
    isResend: boolean("is_resend").notNull().default(false),
    /** Controlled server-classified resend reason code only; NEVER stores raw operator prose (PW-07). */
    resendReason: varchar("resend_reason", { length: 64 }),
    /** ULID of a failed/dead dispatch retried via `orders.production.trigger` (Increment 04 Part B T1). */
    retryOfPublicId: varchar("retry_of_public_id", { length: 26 }),
    /** ULID of an already-delivered dispatch redelivered via `orders.production.redeliver` step-up (Increment 04 Part B T1). */
    redeliveryOfPublicId: varchar("redelivery_of_public_id", { length: 26 }),
    phase1ArtifactsConfirmed: boolean("phase1_artifacts_confirmed").notNull().default(false),
    /** Increment 07 (D7): origin of dispatch (`manual` | `stage_bundle` | `lifecycle_payment_confirmed` | `lifecycle_phase1_locked` | `automation_rule`). */
    triggerSource: varchar("trigger_source", { length: 32 }).notNull().default("manual"),
    /** Increment 07 (D7): workflow stage key when queued from a phase action or lifecycle transition. */
    stageKey: varchar("stage_key", { length: 64 }),
    /** Increment 07 (D7): operator stop metadata when a queued/retrying dispatch is halted. */
    stoppedAt: utcDateTime("stopped_at"),
    stoppedByUserId: refColumn("stopped_by_user_id"),
    stoppedByPublicId: varchar("stopped_by_public_id", { length: 26 }),
    stopReason: varchar("stop_reason", { length: 280 }),
    requestedByUserId: refColumn("requested_by_user_id"),
    requestedByPublicId: varchar("requested_by_public_id", { length: 26 }),
    correlationId: varchar("correlation_id", { length: 64 }).notNull(),
    deliveredAt: utcDateTime("delivered_at"),
    finalizedAt: utcDateTime("finalized_at"),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("uq_prod_dispatch_idempotency").on(table.idempotencyKey),
    index("idx_prod_dispatch_order_phase").on(table.orderId, table.phase, table.createdAt),
    index("idx_prod_dispatch_order_pub").on(table.orderPublicId, table.state),
    index("idx_prod_dispatch_state_created").on(table.state, table.createdAt),
    index("idx_prod_dispatch_state_updated").on(table.state, table.updatedAt, table.id),
    index("idx_prod_dispatch_state_expiry").on(table.state, table.expiresAt, table.id),
    index("idx_prod_dispatch_job").on(table.jobPublicId),
    index("idx_prod_dispatch_order_ref").on(table.orderReference, table.createdAt),
    index("idx_prod_dispatch_redelivery_of").on(table.redeliveryOfPublicId),
  ],
);

/* ----------------------------------------------------- Increment 04 Package I: Webhooks */

export const integrationWebhookSubscriptions = mysqlTable(
  "integration_webhook_subscriptions",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    name: varchar("name", { length: 120 }).notNull(),
    description: varchar("description", { length: 280 }),
    targetUrlEnc: text("target_url_enc").notNull(),
    targetUrlHost: varchar("target_url_host", { length: 253 }).notNull(),
    targetUrlMasked: varchar("target_url_masked", { length: 320 }).notNull(),
    eventsJson: text("events_json").notNull(),
    status: varchar("status", { length: 24 }).notNull(), // "active" | "paused" | "disabled_failing"
    /** Increment 07 (D7): HMAC-SHA256 signing switch; defaults true so existing subscriptions stay signed. */
    signingEnabled: boolean("signing_enabled").notNull().default(true),
    signingSecretEnc: text("signing_secret_enc").notNull(),
    signingSecretLast4: varchar("signing_secret_last4", { length: 4 }).notNull(),
    previousSecretEnc: text("previous_secret_enc"),
    previousSecretExpiresAt: utcDateTime("previous_secret_expires_at"),
    consecutiveFailures: int("consecutive_failures", { unsigned: true }).notNull().default(0),
    lastDeliveredAt: utcDateTime("last_delivered_at"),
    lastFailedAt: utcDateTime("last_failed_at"),
    lastFailureReason: varchar("last_failure_reason", { length: 64 }),
    autoDisabledAt: utcDateTime("auto_disabled_at"),
    createdByUserId: refColumn("created_by_user_id"),
    updatedByUserId: refColumn("updated_by_user_id"),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    index("idx_webhook_sub_status_id").on(table.status, table.id),
    index("idx_webhook_sub_updated_id").on(table.updatedAt, table.id),
  ],
);

export const integrationWebhookInboundEndpoints = mysqlTable(
  "integration_webhook_inbound_endpoints",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    name: varchar("name", { length: 120 }).notNull(),
    endpointKey: varchar("endpoint_key", { length: 64 }).notNull(),
    description: varchar("description", { length: 280 }),
    enabled: boolean("enabled").notNull().default(false),
    signingSecretEnc: text("signing_secret_enc").notNull(),
    signingSecretLast4: varchar("signing_secret_last4", { length: 4 }).notNull(),
    previousSecretEnc: text("previous_secret_enc"),
    previousSecretExpiresAt: utcDateTime("previous_secret_expires_at"),
    toleranceSeconds: int("tolerance_seconds", { unsigned: true }).notNull().default(300),
    lastReceivedAt: utcDateTime("last_received_at"),
    createdByUserId: refColumn("created_by_user_id"),
    updatedByUserId: refColumn("updated_by_user_id"),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("uq_webhook_inbound_key").on(table.endpointKey),
    index("idx_webhook_inbound_enabled_id").on(table.enabled, table.id),
  ],
);

export const integrationWebhookDeliveries = mysqlTable(
  "integration_webhook_deliveries",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    direction: varchar("direction", { length: 16 }).notNull(), // "outbound" | "inbound"
    subscriptionId: refColumn("subscription_id"),
    subscriptionPublicId: varchar("subscription_public_id", { length: 26 }),
    inboundEndpointId: refColumn("inbound_endpoint_id"),
    inboundEndpointPublicId: varchar("inbound_endpoint_public_id", { length: 26 }),
    targetLabel: varchar("target_label", { length: 255 }).notNull(),
    eventKey: varchar("event_key", { length: 120 }).notNull(),
    externalEventId: varchar("external_event_id", { length: 128 }),
    deduplicationKey: varchar("deduplication_key", { length: 160 }).notNull(),
    status: varchar("status", { length: 24 }).notNull(),
    httpMethod: varchar("http_method", { length: 10 }).notNull().default("POST"),
    httpPath: varchar("http_path", { length: 255 }).notNull(),
    httpStatus: int("http_status", { unsigned: true }),
    durationMs: int("duration_ms", { unsigned: true }),
    requestBytes: int("request_bytes", { unsigned: true }).notNull().default(0),
    responseBytes: int("response_bytes", { unsigned: true }).notNull().default(0),
    attemptCount: int("attempt_count", { unsigned: true }).notNull().default(0),
    maxAttempts: int("max_attempts", { unsigned: true }).notNull().default(5),
    nextAttemptAt: utcDateTime("next_attempt_at"),
    jobPublicId: varchar("job_public_id", { length: 36 }),
    activeFencingToken: bigint("active_fencing_token", { mode: "number", unsigned: true }).notNull().default(0),
    reasonCode: varchar("reason_code", { length: 64 }),
    correlationId: varchar("correlation_id", { length: 64 }).notNull(),
    actorLabel: varchar("actor_label", { length: 96 }).notNull(),
    payloadSha256: char("payload_sha256", { length: 64 }).notNull(),
    tapEventEnc: text("tap_event_enc"),
    payloadEnc: text("payload_enc"),
    bodyTruncated: boolean("body_truncated").notNull().default(false),
    bodyPurged: boolean("body_purged").notNull().default(false),
    isReplay: boolean("is_replay").notNull().default(false),
    replayOfPublicId: varchar("replay_of_public_id", { length: 26 }),
    isTest: boolean("is_test").notNull().default(false),
    /** Increment 07 (D7): linked order public ID for order-filtered delivery log queries and stage runs. */
    orderPublicId: varchar("order_public_id", { length: 26 }),
    /** Increment 07 (D7): workflow stage key when queued from a phase action. */
    stageKey: varchar("stage_key", { length: 64 }),
    /** Increment 07 (D7): count of eligible operator retries along the same delivery record chain (distinct from replay/redeliver). */
    manualRetryCount: int("manual_retry_count", { unsigned: true }).notNull().default(0),
    /** Increment 07 (D7): operator stop metadata when a queued/retrying delivery is halted. */
    stoppedAt: utcDateTime("stopped_at"),
    stoppedByUserId: refColumn("stopped_by_user_id"),
    stoppedByPublicId: varchar("stopped_by_public_id", { length: 26 }),
    stopReason: varchar("stop_reason", { length: 280 }),
    searchText: varchar("search_text", { length: 512 }).notNull(),
    expiresAt: utcDateTime("expires_at").notNull(),
    completedAt: utcDateTime("completed_at"),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("uq_webhook_delivery_dedupe").on(table.direction, table.deduplicationKey),
    index("idx_webhook_delivery_dir_created").on(table.direction, table.createdAt, table.id),
    index("idx_webhook_delivery_sub_created").on(table.subscriptionPublicId, table.createdAt, table.id),
    index("idx_webhook_delivery_inb_created").on(table.inboundEndpointPublicId, table.createdAt, table.id),
    index("idx_webhook_delivery_event_created").on(table.eventKey, table.createdAt, table.id),
    index("idx_webhook_delivery_order_created").on(table.orderPublicId, table.createdAt, table.id),
    index("idx_webhook_delivery_status_next").on(table.status, table.nextAttemptAt, table.id),
    index("idx_webhook_delivery_corr").on(table.correlationId),
    index("idx_webhook_delivery_expiry").on(table.bodyPurged, table.expiresAt, table.id),
    index("idx_webhook_delivery_created_id").on(table.createdAt, table.id),
  ],
);

export const integrationWebhookDeliveryAttempts = mysqlTable(
  "integration_webhook_delivery_attempts",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    deliveryId: refColumn("delivery_id").notNull(),
    attemptNumber: int("attempt_number", { unsigned: true }).notNull(),
    outcome: varchar("outcome", { length: 24 }).notNull(), // "succeeded" | "failed" | "rejected" | "unknown"
    httpStatus: int("http_status", { unsigned: true }),
    durationMs: int("duration_ms", { unsigned: true }).notNull().default(0),
    reasonCode: varchar("reason_code", { length: 64 }),
    responseBytes: int("response_bytes", { unsigned: true }).notNull().default(0),
    responseEnc: text("response_enc"),
    occurredAt: utcDateTime("occurred_at").notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex("uq_webhook_attempt_num").on(table.deliveryId, table.attemptNumber),
    index("idx_webhook_attempt_delivery").on(table.deliveryId, table.attemptNumber),
  ],
);

