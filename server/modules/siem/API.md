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

---

## 9. SIEM Forwarding Catalogue & Privacy Boundary (`server/modules/siem/catalogue.ts`, `projection.ts`)

`SIEM_EVENT_CATALOGUE` (`findSiemCatalogueEntry(eventName)`) documents and enforces outbound forwarding rules across baseline, Increment 05, Increment 06, and Increment 07 audit events:

- **D7 Security Incidents (`audit` correlation -> `security` category, `resource_type: "security_incident"`, `correlation_id = incident publicId`):**
  - `security.incident.opened` (`INFO` for `low`, `WARN` for `medium`/`high`, `ERROR` for `critical`): forwards `rule_key` (closed 9-rule vocabulary), `severity`, `status`, `event_count`, `account_count`, `address_count`.
  - `security.incident.updated`: adds boolean `escalated` and `safe_counts.events_added`.
  - `security.incident.acknowledged` (`WARN`): forwards base incident attributes.
  - `security.incident.closed` (`WARN`): adds closed-vocabulary `close_reason` (`resolved | false_positive | duplicate | accepted_risk`).
  - `security.incident.action` (`WARN`): adds `action_kind` (`ban_ip | end_sessions`) and boolean `permanent`.
  - Installation-local `incident_public_id` and `ban_public_id` are withheld from `attributes` (`resource_ref` and `correlation_id` carry external correlation).
- **D7 Sign-In Bans & Rate-Limit Back-Off (`protection` -> `security` category):**
  - `security.ban.created` / `security.ban.released` (`WARN`, `resource_type: "signin_ban"`): forwards `automatic` boolean only; local-only `address_ref`, `ban_public_id`, raw IPs/CIDRs, and free-text `reason` are **never** forwarded (`SIEM_NEVER_FORWARDED_ATTRIBUTE_KEYS`).
  - `security.ban.policy_updated` (`INFO`): forwards `enabled` and `threshold`.
  - `protection.rate_limit_updated` (`INFO`): forwards `category` and `enabled`.
- **Increment 06 Business, Admin & Compliance Events:**
  - Promotions (`promotion.*`): forwards `discount_type` (`percent | fixed | set_total`), `scope_kind`, `is_batch`, `batch_size`, `can_reach_zero`, `allow_zero_total`, `max_discount_percent`, `max_discount_bps`, `export_kind`, `row_count`, `release_reason`, `failed_count`, `window_minutes`, `pause_minutes`; withholds local ULIDs, labels, and monetary amounts.
  - Reports (`report.run`, `report.exported`, `report.denied`, `report.definition.*`): forwards `report_key`, `dataset`, `panel`, `kind`, `visibility`, `compare`, `truncated`, `spec_hash` (64-hex SHA-256), and `safe_counts.rows`; withholds `definition_public_id` and filter payloads.
  - Orders & Workflows (`order.task_note.saved`, `order.task.waived`, `order.agreement_gate.updated`, `workflow.*`): forwards `status_key`, `ack_key`, `task_key`, `task_kind`, `note_version`, `text_sha256`, `digest`, `digest_matches`, `gates_removed`, `selection`, and workflow transfer `safe_counts`; withholds free-text notes/waiver reasons and source labels.
  - Compliance, Files, Cart & Sessions (`compliance.signature_name.mismatch`, `policy.notice.*`, `policy.enforcement.*`, `compliance.receipt.*`, `file.audio.conversion`, `file.access.denied`, `cart.*`, `auth.session.revoked_all`): forwards bounded modes, counts, and triggers while withholding customer text, receipt numbers, and local user IDs.
- **Increment 07 Phases, Status Catalogue, Questions, Automations, Operational Alerts, Webhooks, Deliverables, Stripe, SAML & M365 Sync:**
  - **D1/D3/D9 Order Phases & Progress (`order.stage.advanced`, `.submitted`, `.reviewed`, `.reopened`, `.status_overridden`, `order.progress.lowered`, `order.payment_state.changed`):** forwards `stage_key`, `stage_index`, `from_state`, `to_state`, `outcome`, `ack_policy`, `ack_text_hash`, `progress_percent`, `payment_state`, `from_status`, `to_status`, `reason_code`; withholds `order_public_id`, `note`, and free-text `reason`.
  - **D2 Status Catalogue (`order.status_catalog.*`):** forwards `status_key`, `category` (`start | working | waiting | done | canceled`), `attention` (`none | staff_review | customer_response`); withholds display `label`.
  - **D4 Phase Questions & Checklist (`order.question.{asked,withdrawn,answered}`, `order.admin_task.*`):** forwards `stage_key`, `required`, `answer_version`, `task_key`, `task_version`; encrypted question/answer bodies and `question_public_id` are never forwarded.
  - **D5 Phase Action Bundles & Completion Jobs (`order.stage_run.{completed,partial_failed,failed}`, `order.stage_actions.run`, `order.completion.*`, `automation.rules.reordered`):** forwards `stage_key`, `slot`, `result`, `completion_kind` (`fixed | range`), `percent`, `delay_minutes`, `completion_revision`, `reason_code`, and `safe_counts`; withholds `order_public_id` and `run_public_id`.
  - **D6 Operational Alerts (`ops.alert.{opened,escalated,acknowledged,resolved,reminders_changed}`, `ops.attention.reminder_sent`):** category `job`, resource `operational_alert`; forwards `alert_source`, closed-enum `alert_severity` (`warning | error | critical`), and producer `reason_code`; never forwards `alert_public_id`, `dedupe_key`, `alert_title`, or `alert_text`.
  - **D7 Outbound Webhooks, Egress & Graph (`integration.webhook.*`, `integration.egress.preset_changed`, `integration.graph.write_checked`):** forwards canonical `target_key` (`production:P101..P401`), `preset`, and `reason_code`; withholds `delivery_public_id`, subscription ULIDs, and `destination_url`.
  - **D8 Streaming Audio Playback & Deliverable Archives (`file.uploaded`, `file.playback.*`, `file.deliverable.open`, `file.archive.*`):** forwards `stage_key`, `file_source`, `file_visibility`, `scope` (`phase | order`), `bytes_sent`, `file_count`, `total_bytes`, `reason_code`; withholds `order_public_id`, `playback_public_id`, and `archive_public_id`.
  - **D9 Stripe Webhooks & Payment Lifecycle (`payments.webhook.rejected`, `payments.attempt.*`, `payment.refund.flagged`, `payments.setup.self_test`, `payments.secret.rotated`):** forwards `provider`, `event_type`, `payment_state`, `secret_slot`, `action_kind`, `reason_code`; withholds `order_public_id` and `invoice_public_id`.
  - **D10 SAML 2.0 & Entra MFA (`identity.saml.*`, `identity.sso.*`, `auth.login.*`):** forwards `protocol`, `auth_method` / `method` (`saml | oidc | ...`), `mfa_mode`, `mfa_source` (`entra_claim | portal | entra_managed`), `enabled`, `reason_code`; never forwards SAML assertions, `saml_response`, `cert_public_id`, or IdP URLs.
  - **D12 Managed Microsoft 365 Phase File Sync (`storage.file_sync.*`, `file.sync.*`):** forwards `target_role`, `destination_key`, `stage_key`, `dry_run_count`, `reason_code`; withholds `order_public_id`, `target_public_id`, and `remote_path`.
- **Self-event recursion guard (`forwardable: false`):** `siem.delivery.*`, `siem.spool.*`, and `siem.cursor.*` are never re-spooled into outbound SIEM destinations.
