# SIEM / Syslog Forwarding Module — Public API (v1)

Owner: `siem_engineer` (`server/modules/siem/**`); Admin Console UI (`client/src/features/siem/**`) owned by `portable_ops_engineer`.

---

## 1. Service Interface (`deps.services.siem: SiemModule`) — `server/modules/siem/index.ts`

```ts
export const SIEM_FORMATS = ["syslog_rfc5425", "jsonl_tls", "cef_tls", "otlp_https"] as const;
export type SiemFormat = (typeof SIEM_FORMATS)[number];

export const SIEM_CIRCUIT_STATES = ["closed", "open", "half_open"] as const;
export type SiemCircuitState = (typeof SIEM_CIRCUIT_STATES)[number];

export const SIEM_RECEIPT_CONFIRMATIONS = ["none", "transport_accepted", "collector_2xx"] as const;
export type SiemReceiptConfirmation = (typeof SIEM_RECEIPT_CONFIRMATIONS)[number];

export interface SiemSecretInput {
  /** PEM CA bundle. Pass `""` or `null` to clear; omit (`undefined`) to keep existing. */
  customCaPem?: string | null;
  /** PEM client certificate for mTLS. Pass `""` or `null` to clear; omit to keep existing. */
  clientCertPem?: string | null;
  /** PEM client private key for mTLS. Pass `""` or `null` to clear; omit to keep existing. */
  clientKeyPem?: string | null;
  /** Secret header value for OTLP HTTPS (`Bearer ...` or API key). Pass `""` or `null` to clear. */
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
  /**
   * When changing endpoint identity (`host`, `port`, `format`, `otlpPath`):
   * - `true`: explicitly migrate pending `queued` outbox rows to the new endpoint (durably audited).
   * - `false` / omitted: quarantine pending `queued` outbox rows into `dead_letter` (`ENDPOINT_CHANGED`).
   * Note: if `secrets.hasClientKey` or `secrets.hasAuthSecret` is true on the destination, changing
   * endpoint identity requires rotating or clearing (`null` / `""`) those credentials in `secrets`
   * (`VALIDATION` / `CREDENTIALS_REQUIRE_ROTATION_OR_CLEAR`).
   */
  migrateBacklog?: boolean;
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
  facility: number; // 0..23, default 16 (local0)
  appName: string;
  hostnameOverride: string | null;
  enterpriseNumber: number | null; // IANA PEN for SD-ID `<sdIdName>@<PEN>`; null => nil STRUCTURED-DATA (`-`)
  sdIdName: string;
  includeBom: boolean;
  maxMessageBytes: number;
  connectTimeoutMs: number;
  writeTimeoutMs: number;
  minSeverity: Severity;
  categories: readonly AuditCategory[];
  authHeaderName: string | null;
  /** Write-only secret flags — secret material is NEVER returned to callers. */
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
    uncertainCount: number;
    prunedAuditCount: number;
    missingAuditGapCount: number;
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
  uncertainDelivery: boolean;
  lastReasonCode: string | null;
  correlationId: string | null;
  deadLetteredAt: Date | null;
  createdAt: Date;
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
  sendTestEvent(
    principal: SessionPrincipal,
    input: { publicId: string; expectedVersion?: number },
  ): Promise<SiemTestResult>;
  listDeadLetters(
    principal: SessionPrincipal,
    input: { destinationPublicId?: string; cursor?: string; limit?: number },
  ): Promise<{ items: SiemDeadLetterItem[]; nextCursor: string | null }>;
  replayDeadLetters(
    principal: SessionPrincipal,
    input: { publicIds?: readonly string[]; destinationPublicId?: string; limit?: number },
  ): Promise<{ replayedCount: number }>;
  purgeDeadLetters(
    principal: SessionPrincipal,
    input: { publicIds: readonly string[] },
  ): Promise<{ purgedCount: number }>;
  /** Executes one bounded projection + delivery cycle (invoked by job `siem.deliver` and tests). */
  runDeliveryCycle(options?: {
    job?: ClaimedJob<unknown>;
    destinationPublicId?: string;
  }): Promise<{ projected: number; delivered: number; failed: number; deadLettered: number }>;
  /** Cleanly closes pooled TLS sockets on shutdown. */
  close(): Promise<void>;
}
```

---

## 2. Cross-Module Dependencies Consumed by `siem`

| Provider | Method | Usage |
| --- | --- | --- |
| `auditCenter` | `readEventsAfter(cursor, limit)` | Reads sealed audit events in commit-safe `chain_seq` order along with authenticated `pruned` (retention tombstone) and `missing` (unexplained gap) counters |
| `auditCenter` | `projectForExternal(event)` | Produces privacy-safe pseudonymous `ExternalAuditEvent` (additionally enforced by SIEM's independent typed attribute allowlist before spooling) |
| `integrations` | `egress.resolveAndAssertAllowed({ url, allowedSchemes, allowApprovedPrivate, purpose: "siem" })` | Mandatory centralized SSRF/egress validation + single DNS resolution returning `PinnedEgressTarget` (`address`, `family`, `hostname`, `servername`); re-authorized before every outbound batch and fails closed (`EGRESS_BLOCKED`) if unavailable |
| `identity` | `sessions.assertCurrent` / `sessions.getState` | Re-validates live session/role/step-up inside every privileged `db.transaction` |
| `jobAdmin` | `isDraining()` | Cooperative drain check before starting new outbound batches |

---

## 3. Delivery, TLS & Ordering Guarantees (Stated Plainly)

- **Default off:** No outbound SIEM connections are attempted until an administrator creates and explicitly enables a destination.
- **Mandatory TLS (zero opt-out):** RFC 5425 TLS (`minVersion: "TLSv1.2"`, `rejectUnauthorized: true`, strict SAN/hostname + chain verification, DNS-pinned socket IP) for `syslog_rfc5425`, `jsonl_tls`, and `cef_tls` (default TCP 6514); HTTPS (`TLS >= 1.2`, redirects refused, DNS-pinned lookup) for `otlp_https` (default TCP 4318). Plaintext UDP/TCP and `rejectUnauthorized: false` are never supported or fallen back to.
- **Per-destination AAD-bound credentials:** Per-destination custom CA, mTLS cert/key, and OTLP auth headers are encrypted in `siem_destinations.{ca_enc,client_cert_enc,client_key_enc,auth_secret_enc}` with AAD bound to `(publicId, version, endpointKey)` (`siem_destinations.<slot>:<publicId>:v<version>:<format>|<host>|<port>|<otlpPath>`). Changing endpoint identity (`host`, `port`, `format`, `otlpPath`) requires rotating or clearing stored credentials and either migrating (`migrateBacklog: true`) or quarantining (`ENDPOINT_CHANGED`) queued backlog.
- **At-least-once delivery & receipt truth:** Events carry immutable `event_id` (ULID) for receiver deduplication. For RFC 5425 / TLS stream formats, completion indicates **local TLS socket write/flush acceptance (`transport_accepted`)**, NOT application-layer SIEM indexing; if a socket drops after bytes entered the stream (`uncertainAfterWrite`), `uncertainDelivery = true` is persisted on the outbox item and counted in `delivery.uncertainCount`. For OTLP HTTPS, `2xx` indicates **collector HTTP acceptance (`collector_2xx`)**.
- **Ordering:** Events are projected into `siem_outbox` in `chain_seq` order and transmitted in **strict per-destination FIFO head-of-line order** (newer queued events never overtake a backed-off head event). Retries, dead-letter replays, or mid-write socket resets can still re-send an earlier event, so receivers **must** deduplicate by `event_id` and order by `(occurred_at, chain_seq)`.
- **Spool backpressure & retention progress:** When pending + dead-letter spool reaches `siem.delivery.spool_max_events`, cursor projection pauses at its current audit cursor (`health()` reports `failing`; unprojected audit records remain subject to upstream audit retention until the spool drains). When upstream retention prunes an entire audit page (`events: []` with `nextCursor` advanced), SIEM persists the advanced cursor under lease, exposes cumulative `prunedAuditCount` / `metrics.prunedAuditEvents`, records `pruned` via `audit.note`, and records durable `siem.audit.loss_detected` (`WARN`, `AUDIT_EVENTS_MISSING`) if `missing > 0`.

---

## 4. tRPC Procedures (`trpc.siem.admin.*`)

All procedures require `adminProcedure`.

| Procedure | Type | Capability | Step-up | Notes |
| --- | --- | --- | --- | --- |
| `admin.destinations.list` | query | `siem.read` | no | Lists destinations + live spool/lag/circuit/gap summary; never returns secrets |
| `admin.destinations.get` | query | `siem.read` | no | Single destination detail by `publicId` (`NOT_FOUND` if missing) |
| `admin.destinations.create` | mutation | `siem.manage` | **yes** | Validates config, PEM certs/keys, egress policy; seals per-destination AAD-bound secrets |
| `admin.destinations.update` | mutation | `siem.manage` | **yes** | Optimistic concurrency (`expectedVersion`), endpoint credential rotation/clear guard + `migrateBacklog` |
| `admin.destinations.setEnabled` | mutation | `siem.manage` | **yes** | Enables/disables forwarding (`expectedVersion`) |
| `admin.destinations.delete` | mutation | `siem.manage` | **yes** | Durable audit before delete; removes destination + encrypted secrets + pending spool |
| `admin.destinations.test` | mutation | `siem.manage` | **yes** (`expensive` rate limit) | Sends synthetic `siem.connectivity.test` probe on an isolated one-shot TLS socket (`expectedVersion?`); audits `attempted` then truthful `completed`/`failed`/`unknown` |
| `admin.health` | query | `siem.read` | no | Returns `ModuleHealth[]` (`component: "siem.delivery"`) + aggregate metrics |
| `admin.deadLetters.list` | query | `siem.read` | no | Bounded cursor pagination (`limit <= 100`) |
| `admin.deadLetters.replay` | mutation | `siem.manage` | **yes** | Resets selected dead-letter items to `queued`, rebinds to current endpoint generation, and enqueues `siem.deliver` |
| `admin.deadLetters.purge` | mutation | `siem.manage` | **yes** | Durable audit before permanently deleting selected dead-letter items |

Raw HTTP routes: none (`registerSiemHttpRoutes` is a no-op).

---

## 5. Declared Settings & Secrets (`server/modules/siem/settings.ts`)

- `siem.delivery.batch_size` (value, `1..500`, default `100`)
- `siem.delivery.max_attempts` (value, `1..20`, default `8`)
- `siem.delivery.spool_max_events` (value, `100..100000`, default `10000`)
- `siem.delivery.oldest_alert_seconds` (value, `30..86400`, default `300`)
- `siem.delivery.circuit_threshold` (value, `1..50`, default `5`)
- `siem.delivery.circuit_cooldown_seconds` (value, `10..3600`, default `60`)
- `siem.tls.default_ca_bundle` (secret, optional installation-wide PEM CA bundle)
- `siem.tls.default_client_cert` (secret, optional installation-wide PEM mTLS client cert)
- `siem.tls.default_client_key` (secret, optional installation-wide PEM mTLS client private key)

Per-destination credentials are stored directly in `siem_destinations.{ca_enc,client_cert_enc,client_key_enc,auth_secret_enc}` sealed via `deps.crypto` with version + endpoint AAD.

---

## 6. Jobs & Schedules

- Job `siem.deliver`: projects newly sealed audit events per enabled destination and transmits ready batches using a unique per-claim lease token (`lease_<ulid>`) + destination-local monotonic `last_fencing_token` generation + UTC DB `lease_expires_at`.
- Schedule `siem.deliver.tick`: runs `siem.deliver` every `10_000` ms.

---

## 7. Audit Event Names Emitted

- `siem.destination.created` (`category: "admin"`, durable in-tx)
- `siem.destination.updated` (`category: "admin"`, durable in-tx, includes `migrated_queued` / `quarantined_queued` safe counts on endpoint edits)
- `siem.destination.enabled` / `siem.destination.disabled` (`category: "security"`, durable in-tx)
- `siem.destination.deleted` (`category: "security"`, durable in-tx recorded before row deletion)
- `siem.destination.test` (`category: "integration"`, durable `attempted` -> durable `completed` | `failed` | `unknown`)
- `siem.dead_letter.replayed` (`category: "admin"`, durable in-tx)
- `siem.dead_letter.purged` (`category: "security"`, durable in-tx recorded before row deletion)
- `siem.audit.loss_detected` (`category: "security"`, `severity: "WARN"`, `reasonCode: "AUDIT_EVENTS_MISSING"`, durable in-tx when `readEventsAfter` reports `missing > 0`)
- `siem.cursor.retention_pruned` (`category: "system"`, `audit.note` when `readEventsAfter` reports `pruned > 0`)
- `siem.delivery.dead_lettered` (`category: "system"`, `audit.note`)
- `siem.delivery.circuit_opened` (`category: "system"`, `audit.note`)
- `siem.spool.saturated` (`category: "system"`, rate-limited `audit.note`)

---

## 8. Health Components (`ModuleLifecycle.health()`)

- `siem.delivery`:
  - `not_configured`: zero destinations exist
  - `disabled`: destinations exist, all disabled
  - `ok`: enabled destinations healthy, circuit closed, zero dead letters, zero missing audit gaps, oldest pending & cursor lag below alert threshold
  - `degraded`: retry backlog, half-open circuit, approaching cert expiry (<= 14 days), oldest pending age >= threshold, or cursor overdue vs `headSeq`
  - `failing`: open circuit, dead letters > 0, missing audit gaps > 0 (`AUDIT_EVENTS_MISSING`), expired client/CA cert, unreadable/tampered secret AAD, or spool at capacity
  - `metrics`: `{ configuredDestinations, enabledDestinations, queueDepth, deadLetters, oldestPendingAgeSeconds, maxLagSeq, maxCursorLagAgeSeconds, missingAuditGaps }`
