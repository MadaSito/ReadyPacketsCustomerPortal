import type {
  AuditCategory,
  AuditOutcome,
  ClaimedJob,
  ModuleLifecycle,
  SafeAttributeValue,
  SessionPrincipal,
  Severity,
} from "../../core/types.js";

export const SIEM_FORMATS = ["syslog_rfc5425", "jsonl_tls", "cef_tls", "otlp_https"] as const;
export type SiemFormat = (typeof SIEM_FORMATS)[number];

export const SIEM_CIRCUIT_STATES = ["closed", "open", "half_open"] as const;
export type SiemCircuitState = (typeof SIEM_CIRCUIT_STATES)[number];

export const SIEM_OUTBOX_STATES = ["queued", "dead_letter"] as const;
export type SiemOutboxState = (typeof SIEM_OUTBOX_STATES)[number];

export const SIEM_RECEIPT_CONFIRMATIONS = ["none", "transport_accepted", "collector_2xx"] as const;
export type SiemReceiptConfirmation = (typeof SIEM_RECEIPT_CONFIRMATIONS)[number];

export const SIEM_REASON_CODES = [
  "TLS_CERT_UNTRUSTED",
  "TLS_CERT_EXPIRED",
  "TLS_HOSTNAME_MISMATCH",
  "TLS_MTLS_REJECTED",
  "TLS_HANDSHAKE_FAILED",
  "CONNECT_TIMEOUT",
  "WRITE_TIMEOUT",
  "CONNECTION_REFUSED",
  "CONNECTION_RESET",
  "DNS_RESOLUTION_FAILED",
  "EGRESS_BLOCKED",
  "HTTP_AUTH_FAILED",
  "HTTP_RATE_LIMITED",
  "HTTP_CLIENT_ERROR",
  "HTTP_SERVER_ERROR",
  "PROTOCOL_REJECTED",
  "SECRET_UNREADABLE",
  "DESTINATION_MISCONFIGURED",
  "TRANSPORT_ERROR",
] as const;
export type SiemReasonCode = (typeof SIEM_REASON_CODES)[number];

/**
 * Canonical privacy-safe projection emitted to external SIEM/syslog receivers.
 * Excludes local actor_user_id, resource_public_id, session_ref, source_address_ref, raw IP, and user-agent.
 */
export interface ExternalAuditEvent {
  schema_version: string;
  event_id: string;
  chain_seq: number | null;
  occurred_at: string;
  observed_at: string;
  severity_text: Severity;
  severity_number: number;
  category: AuditCategory;
  event_name: string;
  action: string;
  outcome: AuditOutcome;
  reason_code: string | null;
  service: string;
  installation_ref: string;
  release_ref: string;
  deployment_profile: string;
  origin: string;
  actor_ref: string | null;
  actor_role: string;
  resource_type: string | null;
  resource_ref: string | null;
  source_address_class: "loopback" | "private" | "public" | "unknown" | null;
  request_id: string | null;
  trace_id: string | null;
  span_id: string | null;
  correlation_id: string | null;
  parent_correlation_id: string | null;
  job_id: string | null;
  package_id: string | null;
  import_id: string | null;
  delivery_id: string | null;
  provider: string | null;
  duration_ms: number | null;
  safe_counts: Record<string, number>;
  attributes: Record<string, SafeAttributeValue>;
  dropped_attributes: number;
}

/** Structural contract matching `server/modules/audit/API.md` §2-3. */
export type AuditEnvelopeLike = ExternalAuditEvent & {
  actor_user_id?: number | null;
  resource_public_id?: string | null;
  session_ref?: string | null;
  source_address_ref?: string | null;
  durability?: "durable" | "best_effort";
};

export interface AuditReadBatch {
  events: AuditEnvelopeLike[];
  nextCursor: string | null;
  headSeq: number;
}

export interface AuditReadPort {
  readEventsAfter(cursor: string | null, limit: number): Promise<AuditReadBatch>;
  projectForExternal?(event: AuditEnvelopeLike): ExternalAuditEvent;
}

/** Structural contract matching `server/modules/integrations/API.md` egress policy. */
export interface PinnedEgressTarget {
  hostname: string;
  port: number;
  protocol?: string;
  address: string;
  family: 4 | 6;
  servername?: string;
  normalizedUrl?: string;
  allowlistRulePublicId?: string;
}

export interface IntegrationsEgressPort {
  resolveAndAssertAllowed?(input: {
    url: string;
    allowedSchemes: readonly string[];
    allowApprovedPrivate?: boolean;
    purpose: "siem";
  }): Promise<PinnedEgressTarget>;
  assertAllowed?(
    target: string | URL | { host: string; port: number; protocol?: "https:" | "tls:" },
    purpose: "siem",
  ): Promise<PinnedEgressTarget>;
}

export interface SiemSecretInput {
  /** PEM CA certificate(s). Omit/undefined = keep existing; null = clear; non-empty string = replace. */
  customCaPem?: string | null;
  /** PEM client certificate for mTLS. */
  clientCertPem?: string | null;
  /** PEM client private key for mTLS. */
  clientKeyPem?: string | null;
  /** Secret header value for OTLP/HTTPS (e.g. `Bearer ...` or collector token). */
  authSecret?: string | null;
}

export interface CreateSiemDestinationInput {
  name: string;
  enabled?: boolean;
  format: SiemFormat;
  host: string;
  port?: number;
  otlpPath?: string | null;
  allowPrivateNetwork?: boolean;
  facility?: number;
  appName?: string;
  hostnameOverride?: string | null;
  enterpriseNumber?: number | null;
  sdIdName?: string;
  includeBom?: boolean;
  maxMessageBytes?: number;
  connectTimeoutMs?: number;
  writeTimeoutMs?: number;
  minSeverity?: Severity;
  categories: readonly AuditCategory[];
  authHeaderName?: string | null;
  secrets?: SiemSecretInput;
}

export interface UpdateSiemDestinationInput {
  publicId: string;
  expectedVersion: number;
  name?: string;
  enabled?: boolean;
  format?: SiemFormat;
  host?: string;
  port?: number;
  otlpPath?: string | null;
  allowPrivateNetwork?: boolean;
  facility?: number;
  appName?: string;
  hostnameOverride?: string | null;
  enterpriseNumber?: number | null;
  sdIdName?: string;
  includeBom?: boolean;
  maxMessageBytes?: number;
  connectTimeoutMs?: number;
  writeTimeoutMs?: number;
  minSeverity?: Severity;
  categories?: readonly AuditCategory[];
  authHeaderName?: string | null;
  secrets?: SiemSecretInput;
}

export interface SiemDestinationSummary {
  publicId: string;
  name: string;
  enabled: boolean;
  format: SiemFormat;
  host: string;
  port: number;
  otlpPath: string | null;
  allowPrivateNetwork: boolean;
  facility: number;
  appName: string;
  hostnameOverride: string | null;
  enterpriseNumber: number | null;
  sdIdName: string;
  includeBom: boolean;
  maxMessageBytes: number;
  connectTimeoutMs: number;
  writeTimeoutMs: number;
  minSeverity: Severity;
  categories: readonly AuditCategory[];
  authHeaderName: string | null;
  secrets: {
    hasCustomCa: boolean;
    hasClientCert: boolean;
    hasClientKey: boolean;
    hasAuthSecret: boolean;
    caCertExpiresAt: Date | null;
    clientCertExpiresAt: Date | null;
    updatedAt: Date | null;
  };
  delivery: {
    circuitState: SiemCircuitState;
    consecutiveFailures: number;
    circuitOpenUntil: Date | null;
    lastProjectedSeq: number;
    lagSeq: number;
    queuedCount: number;
    deadLetterCount: number;
    oldestQueuedAgeSeconds: number | null;
    lastAttemptAt: Date | null;
    lastSuccessAt: Date | null;
    lastFailureAt: Date | null;
    lastFailureReason: string | null;
    deliveredCount: number;
    failedAttemptCount: number;
    deadLetteredCount: number;
    lastTestAt: Date | null;
    lastTestOutcome: "completed" | "failed" | "unknown" | null;
    lastTestReason: string | null;
    receiptConfirmation: SiemReceiptConfirmation;
  };
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SiemTestResult {
  eventId: string;
  attemptedAt: Date;
  outcome: "completed" | "failed" | "unknown";
  reasonCode: string | null;
  receiptConfirmation: SiemReceiptConfirmation;
  durationMs: number;
}

export interface SiemDeadLetterItem {
  publicId: string;
  destinationPublicId: string;
  destinationName: string;
  eventId: string;
  chainSeq: number | null;
  eventOccurredAt: Date;
  category: AuditCategory;
  severity: Severity;
  eventName: string;
  attempts: number;
  maxAttempts: number;
  lastReasonCode: string | null;
  deadLetteredAt: Date | null;
  createdAt: Date;
}

export interface SiemDeliveryCycleResult {
  projected: number;
  delivered: number;
  failed: number;
  deadLettered: number;
}

export interface SiemModule extends ModuleLifecycle {
  listDestinations(principal: SessionPrincipal): Promise<SiemDestinationSummary[]>;
  getDestination(principal: SessionPrincipal, publicId: string): Promise<SiemDestinationSummary>;
  createDestination(principal: SessionPrincipal, input: CreateSiemDestinationInput): Promise<SiemDestinationSummary>;
  updateDestination(principal: SessionPrincipal, input: UpdateSiemDestinationInput): Promise<SiemDestinationSummary>;
  setDestinationEnabled(
    principal: SessionPrincipal,
    input: { publicId: string; enabled: boolean; expectedVersion: number },
  ): Promise<SiemDestinationSummary>;
  deleteDestination(principal: SessionPrincipal, input: { publicId: string; expectedVersion: number }): Promise<void>;
  sendTestEvent(principal: SessionPrincipal, input: { publicId: string }): Promise<SiemTestResult>;
  listDeadLetters(
    principal: SessionPrincipal,
    input: { destinationPublicId?: string; cursor?: string; limit?: number },
  ): Promise<{ items: SiemDeadLetterItem[]; nextCursor: string | null }>;
  replayDeadLetters(
    principal: SessionPrincipal,
    input: { publicIds?: readonly string[]; destinationPublicId?: string; limit?: number },
  ): Promise<{ replayedCount: number }>;
  purgeDeadLetters(principal: SessionPrincipal, input: { publicIds: readonly string[] }): Promise<{ purgedCount: number }>;
  runDeliveryCycle(options?: {
    job?: ClaimedJob<unknown>;
    destinationPublicId?: string;
  }): Promise<SiemDeliveryCycleResult>;
  close(): Promise<void>;
}
