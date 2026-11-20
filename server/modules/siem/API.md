# SIEM / Syslog Forwarding Module — Public API (v1)

Owner: `siem_engineer`  
Paths: `server/modules/siem/**`, `client/src/features/siem/**`

---

## 1. Service Interface (`deps.services.siem: SiemModule`) — `server/modules/siem/index.ts`

```ts
export const SIEM_FORMATS = ["syslog_rfc5425", "jsonl_tls", "cef_tls", "otlp_https"] as const;
export type SiemFormat = (typeof SIEM_FORMATS)[number];

export const SIEM_CIRCUIT_STATES = ["closed", "open", "half_open"] as const;
export type SiemCircuitState = (typeof SIEM_CIRCUIT_STATES)[number];

export const SIEM_RECEIPT_CONFIRMATIONS = ["none", "transport_accepted", "collector_2xx"] as const;
export type SiemReceiptConfirmation = (typeof SIEM_RECEIPT_CONFIRMATIONS)[number];

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
| `auditCenter` | `readEventsAfter(cursor, limit)` | Reads sealed audit events in commit-safe `chain_seq` order |
| `auditCenter` | `projectForExternal(event)` | Produces privacy-safe pseudonymous `ExternalAuditEvent` (additionally enforced by SIEM's defense-in-depth projection sanitizer before spooling) |
| `integrations` | `egress.resolveAndAssertAllowed({ url, allowedSchemes, allowApprovedPrivate, purpose: "siem" })` | SSRF/egress validation + single DNS resolution returning `PinnedEgressTarget` (`address`, `family`, `hostname`, `servername`) pinned per TLS/HTTPS connection |
| `jobAdmin` | `isDraining()` | Cooperative drain check before starting new outbound batches |

---

## 3. Delivery & Ordering Guarantees (Stated Plainly)

- **Default off:** No outbound SIEM connections are attempted until an administrator creates and explicitly enables a destination.
- **Transport security:** RFC 5425 TLS (`minVersion: "TLSv1.2"`, `rejectUnauthorized: true`, strict hostname/SAN + chain verification, DNS-pinned socket IP) for `syslog_rfc5425`, `jsonl_tls`, and `cef_tls` (default TCP 6514); HTTPS (`TLS >= 1.2`, redirects refused, DNS-pinned lookup) for `otlp_https`. Plaintext UDP/TCP and `rejectUnauthorized: false` are never supported or fallen back to.
- **At-least-once delivery:** Events carry immutable `event_id` (ULID) for receiver deduplication. A TCP/TLS socket write completion indicates **transport write acceptance (`transport_accepted`)**, not remote SIEM application indexing. OTLP `2xx` indicates **collector HTTP acceptance (`collector_2xx`)**.
- **Ordering:** Events are projected into `siem_outbox` in `chain_seq` order and attempted in FIFO spool order per destination, but retries, replays, or connection resets mean receivers **must** deduplicate by `event_id` and order by `(occurred_at, chain_seq)`.
- **Spool backpressure (no silent drops):** When a destination's pending + dead-letter spool reaches `siem.delivery.spool_max_events`, cursor projection pauses for that destination while events remain safely in `audit_events`; health reports `failing`/`degraded`.

---

## 4. tRPC Procedures (`trpc.siem.admin.*`)

All procedures require `adminProcedure`.

| Procedure | Type | Capability | Step-up | Notes |
| --- | --- | --- | --- | --- |
| `admin.destinations.list` | query | `siem.read` | no | Lists destinations + live spool/lag/circuit summary; never returns secrets |
| `admin.destinations.get` | query | `siem.read` | no | Single destination detail by `publicId` (`NOT_FOUND` if missing) |
| `admin.destinations.create` | mutation | `siem.manage` | **yes** | Validates config, PEM certs/keys, egress policy; stores secrets write-only via `deps.settings` |
| `admin.destinations.update` | mutation | `siem.manage` | **yes** | Optimistic concurrency (`expectedVersion`), rotates/clears secrets write-only |
| `admin.destinations.setEnabled` | mutation | `siem.manage` | **yes** | Enables/disables forwarding (`expectedVersion`) |
| `admin.destinations.delete` | mutation | `siem.manage` | **yes** | Deletes destination, clears stored secrets, removes pending spool |
| `admin.destinations.test` | mutation | `siem.read` | no (`expensive` rate limit) | Sends synthetic `siem.connectivity.test` probe; audits `attempted` then truthful `completed`/`failed`/`unknown` |
| `admin.health` | query | `siem.read` | no | Returns `ModuleHealth[]` + aggregate metrics |
| `admin.deadLetters.list` | query | `siem.read` | no | Bounded cursor pagination (`limit <= 100`) |
| `admin.deadLetters.replay` | mutation | `siem.manage` | **yes** | Resets selected dead-letter items to `queued` and enqueues `siem.deliver` |
| `admin.deadLetters.purge` | mutation | `siem.manage` | **yes** | Explicitly deletes selected dead-letter items (audited) |

Raw HTTP routes: none (`registerSiemHttpRoutes` is a no-op).

---

## 5. Declared Settings, Secrets & Feature Flags (`server/modules/siem/settings.ts`)

- `siem.delivery.batch_size` (value, `1..500`, default `100`)
- `siem.delivery.max_attempts` (value, `1..20`, default `8`)
- `siem.delivery.spool_max_events` (value, `100..100000`, default `10000`)
- `siem.delivery.oldest_alert_seconds` (value, `30..86400`, default `300`)
- `siem.delivery.circuit_threshold` (value, `1..50`, default `5`)
- `siem.delivery.circuit_cooldown_seconds` (value, `10..3600`, default `60`)
- `siem.tls.default_ca_bundle` (secret, optional installation-wide PEM CA bundle)
- `siem.tls.default_client_cert` (secret, optional installation-wide PEM mTLS client cert)
- `siem.tls.default_client_key` (secret, optional installation-wide PEM mTLS client private key)
- `siem.destinations.credentials` (secret, write-only encrypted credential store for per-destination CA/mTLS/OTLP secrets, `exportable: false`)

---

## 6. Jobs & Schedules

- Job `siem.deliver`: projects newly sealed audit events per enabled destination and transmits ready batches with per-destination lease + `ClaimedJob` fencing.
- Schedule `siem.deliver.tick`: runs `siem.deliver` every `10_000` ms.

---

## 7. Audit Event Names Emitted

- `siem.destination.created` (`category: "admin"`, transactional)
- `siem.destination.updated` (`category: "admin"`, transactional)
- `siem.destination.enabled` / `siem.destination.disabled` (`category: "security"`, transactional)
- `siem.destination.deleted` (`category: "security"`, transactional)
- `siem.destination.test` (`category: "integration"`, `attempted` -> `completed` | `failed` | `unknown`)
- `siem.dead_letter.replayed` (`category: "admin"`, transactional)
- `siem.dead_letter.purged` (`category: "security"`, transactional)
- `siem.delivery.dead_lettered` (`category: "system"`, rate-limited/per-batch)
- `siem.delivery.circuit_opened` (`category: "system"`)
- `siem.spool.saturated` (`category: "system"`)

---

## 8. Health Components (`ModuleLifecycle.health()`)

- `siem.delivery`:
  - `not_configured`: zero destinations exist
  - `disabled`: destinations exist, all disabled
  - `ok`: enabled destinations healthy, circuit closed, zero dead letters, oldest pending age below alert threshold
  - `degraded`: retry backlog, half-open circuit, approaching cert expiry (<= 14 days), or oldest pending age >= threshold
  - `failing`: open circuit, dead letters > 0, expired client/CA cert, unreadable secret, or spool at capacity
  - `metrics`: `{ configuredDestinations, enabledDestinations, queueDepth, deadLetters, oldestPendingAgeSeconds, maxLagSeq }`
