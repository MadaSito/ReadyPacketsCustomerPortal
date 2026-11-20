# ReadyPackets Production Pipeline Webhooks (`P101` & `P201`)

Owner: `integrations_engineer` (`server/modules/integrations/production/**`, `server/modules/integrations/egress.ts`, `server/modules/integrations/settings.ts`, `server/modules/integrations/schema.ts`, `client/src/features/integrations/routes.tsx`; admin/order UI in `client/src/features/integrations/production/**` owned by `siem_engineer`).

This document specifies the outbound production pipeline integration implemented for Increment 02 (`docs/engineering/INCREMENT_02_CONTRACT.md` §D) against the authoritative source documents:
- `docs/source-specs/increment-02/P101_Order_Creation_Webhook_Reference.md`
- `docs/source-specs/increment-02/P201_Trigger_Production_Webhook_Reference.md`

---

## 1. Overview & Two-Phase Lifecycle

ReadyPackets dispatches two outbound HTTPS JSON webhooks to the self-hosted or automation-hosted production pipeline (e.g., n8n):

1. **`P101` — Order Creation & Folder Initialization** (`phase = "P101"`):
   - Initializes the SharePoint order/packet folder tree and intake metadata for an eligible packet order.
   - Carries the full multi-packet CSV string (`"1"`, `"1,2,3"`, `"1,2,4,6"`) and multi-tier CSV string (`"Basic"`, `"Basic,Standard,Comprehensive"`), client identity, canon version, release status, and run mode.
2. **`P201` — Trigger Production Run** (`phase = "P201"`):
   - Triggers downstream document generation for a previously initialized order.
   - Requires at least one `delivered` `P101` dispatch on the same order (`PRODUCTION_P101_NOT_DELIVERED` otherwise).
   - Reuses `client_id`, `order_id`, `packet`, `packet_tier`, `client_name`, `client_email`, `canon_version`, and `run_mode` **verbatim** from the latest delivered `P101` snapshot so SharePoint folder paths and canon locks cannot drift between folder creation and production execution, even if the customer profile or global settings later change.

### Default Installation Posture
- Feature flag `feature.integrations.production` (`integrations.production`) defaults to **`false`**.
- `canonVersion` defaults to `""` (empty) — **no silent default canon version exists**. Enabling the pipeline requires an administrator with `integrations.manage` and fresh MFA step-up to explicitly set `canonVersion` (`^\d+\.\d+$`, e.g., `"2.2"`), `p101Url`, and `p201Url`, plus matching outbound allowlist rules.
- Non-packet orders (any item with `offeringKind !== "packet"` or zero packet items) are refused with `PRODUCTION_ORDER_HAS_NO_PACKETS` and audited via `integration.production.dispatch.refused`.

---

## 2. Outbound HTTP Contract & Receiver Requirements

### 2.1 Transport & Strict Egress Policy
- **Method**: `POST`
- **Protocol**: `https:` only (TLS >= 1.2, strict certificate verification `rejectUnauthorized: true`, SNI `servername` bound to hostname). Plain `http:`, credentials-in-URL (`https://user:pass@...`), and URL `#fragment` components are rejected at configuration time and pre-flight.
- **Mandatory Outbound Allowlist**: Every destination URL must match an enabled `integration_egress_allowlist` rule with `purpose = "webhook"` and `protocol = "https:"`. Unlisted public hosts are refused (`EGRESS_ALLOWLIST_REQUIRED`).
- **Public-Only Single-Evaluation DNS Pinning**: `egress.fetchPinned(..., { requireAllowlistRule: true, publicAddressesOnly: true })` resolves A/AAAA records once under a 5 s deadline, verifies that **every** returned IP is globally routable (`public` — private RFC 1918, loopback, link-local, CGNAT, ULA, metadata, and IPv4-embedded IPv6 transition ranges are refused even if `allowPrivateAddress` is set on a rule), matches the allowlist rule, and returns the exact `PinnedEgressTarget` (`address` + `family`) bound to the TLS socket (`autoSelectFamily: false`).
- **Zero Redirect Following**: Any `3xx` response is refused immediately (`EGRESS_REDIRECT_REFUSED`, terminal `failed`, no retry).
- **Body Cap & Timeout**: Response body read capped at `64 KiB`; total wall-clock request timeout configurable between `3000 ms` and `30000 ms` (default `10000 ms`).

### 2.2 Request Headers

| Header | Value | Notes |
| --- | --- | --- |
| `Content-Type` | `application/json; charset=utf-8` | Exact UTF-8 JSON body |
| `User-Agent` | `ReadyPackets-Portal/1.0 (+production-webhook)` | Constant identifier |
| `Idempotency-Key` | `<dispatch.publicId>` (26-char ULID) | Stable across all automatic retry attempts of the same dispatch; regenerated on admin `resend` |
| `X-Correlation-Id` | `<dispatch.correlationId>` | Request correlation ID captured when the dispatch was queued |
| `X-ReadyPackets-Phase` | `P101` or `P201` | Identifies the phase |
| `<authHeaderName>` (optional) | `<decrypted authValue>` | Sent only when both `authHeaderName` (token `^[A-Za-z0-9-]{1,64}$`, never a reserved transport header) and `authValue` are configured |

### 2.3 Expected Receiver Responses

| HTTP Status | Portal Classification | Retry Behavior |
| --- | --- | --- |
| `200` – `299` | `delivered` (`PRODUCTION_DELIVERED`) | Terminal success. Optional JSON `{ execution_id \| executionId \| id }` is extracted (up to 128 chars) and stored in `externalExecutionId`. `payload_enc` is cleared (`NULL`). |
| `429` or `500` – `599` |Retryable failure (`PRODUCTION_HTTP_429` / `PRODUCTION_HTTP_5XX`) | Retries with exponential backoff + jitter using the **same** `Idempotency-Key` up to `maxAttempts = 5`, then transitions to `dead` (`integration.production.dispatch.dead`). |
| `300` – `399` | Non-retryable failure (`EGRESS_REDIRECT_REFUSED`) | Immediate terminal `failed`; `payload_enc` cleared (`NULL`). |
| `400` – `499` (except `429`) | Non-retryable failure (`PRODUCTION_HTTP_4XX`) | Immediate terminal `failed`; `payload_enc` cleared (`NULL`). |
| Pre-connect / DNS / allowlist error | Retryable or policy failure | Egress policy blocks (`EGRESS_*` other than `EGRESS_DNS_TIMEOUT` / `EGRESS_DNS_LOOKUP_FAILED` / `EGRESS_TIMEOUT`) fail immediately; transient DNS/socket errors retry up to 5 attempts. |
| Mid-flight socket drop / post-write timeout | Ambiguous (`EGRESS_TIMEOUT` / `EGRESS_NETWORK_ERROR` after request write) | Because `integrations.production.deliver` is registered with `retrySafe: false`, a worker crash while `state = "sending"` is **never** automatically re-sent on lease recovery; the row transitions to `failed` (`PRODUCTION_AMBIGUOUS_IN_FLIGHT_DELIVERY`) so an admin can inspect the receiver and explicitly `resend` if needed. |

Receivers **must** deduplicate incoming requests by `Idempotency-Key` (or `(order_id, phase, Idempotency-Key)`).

---

## 3. Exact JSON Payload Schemas

### 3.1 `P101` — Order Creation Payload (`P101Payload`)

```json
{
  "client_id": "RP-7H9K2M4",
  "order_id": "ORD-2026-000142",
  "packet": "1,2,3",
  "packet_tier": "Basic,Standard,Comprehensive",
  "client_name": "Jane Doe",
  "client_email": "jane@example.com",
  "canon_version": "2.2",
  "release_status": "released",
  "run_mode": "production",
  "order_date": "2026-11-20",
  "notes": "Expedited intake verified"
}
```

Field validation rules (`validateP101Payload` in `server/modules/integrations/production/payload.ts`):
- `client_id`: Required. Prefers `users.customer_ref` when matching `^RP-[A-Z0-9]{4,28}$`; otherwise deterministic `"RP-" + users.public_id`.
- `order_id`: Required, non-whitespace, `1..64` chars (`orders.reference`).
- `packet`: Required CSV of unique packet numbers `1..7` sorted ascending (`"7"`, `"1,2,3"`, `"1,2,4,6"`).
- `packet_tier`: Required CSV of `"Basic" | "Standard" | "Comprehensive"` entries with exact 1-to-1 length alignment with `packet`.
- `client_name`: Required, trimmed, `1..200` chars, no control characters.
- `client_email`: Required valid email (`<= 254` chars, no whitespace/control chars).
- `canon_version`: Required `^\d+\.\d+$` (e.g. `"2.2"`).
- `release_status`: Optional `"draft" | "released"` (defaults to `"released"` when omitted by caller).
- `run_mode`: Optional `"production" | "test" | "validation"` (sourced from configured `integrations.production.config.runMode`).
- `order_date`: Optional `YYYY-MM-DD` UTC calendar date verified against calendar rollover (`orders.created_at`).
- `notes`: Optional string `<= 2000` chars; omitted when empty.

### 3.2 `P201` — Trigger Production Payload (`P201Payload`)

```json
{
  "client_id": "RP-7H9K2M4",
  "order_id": "ORD-2026-000142",
  "packet": "1,2,3",
  "packet_tier": "Basic,Standard,Comprehensive",
  "client_name": "Jane Doe",
  "client_email": "jane@example.com",
  "canon_version": "2.2",
  "run_mode": "production",
  "triggered_by": "01JSTAFF000000000000000001",
  "priority": "normal",
  "notes": " Kickoff approved "
}
```

Field validation rules (`validateP201Payload`):
- `client_id`, `order_id`, `packet`, `packet_tier`, `client_name`, `client_email`, `canon_version`, `run_mode`: Copied verbatim from the latest `delivered` `P101` dispatch's `payloadSummary` + customer PII snapshot and re-validated.
- `triggered_by`: Optional `<= 128` chars — always populated with the triggering actor's opaque `userPublicId` (never staff email or display name).
- `priority`: Optional `"normal" | "high" | "urgent"` (defaults to `"normal"` when provided by UI).
- `notes`: Optional trimmed string `<= 2000` chars; omitted when empty.

---

## 4. Settings, Encryption, PII Minimisation & Audit

### 4.1 Registered Settings & Secrets (`server/modules/integrations/settings.ts`)
- `feature.integrations.production` (boolean feature flag, default `false`).
- `integrations.production.config` (`{ canonVersion, runMode, timeoutMs, authHeaderName }`).
- `integrations.production.p101_url` (`defineSecret` — encrypted at rest via `FieldCrypto` AES-256-GCM with AAD `platform_settings:integrations.production.p101_url`; write-only; returned to UI only as `{ configured: boolean, host: string | null, last4: string | null }`).
- `integrations.production.p201_url` (`defineSecret` — AAD `platform_settings:integrations.production.p201_url`; masked `{ configured, host, last4 }`).
- `integrations.production.auth_value` (`defineSecret` — AAD `platform_settings:integrations.production.auth_value`; write-only `{ authSecretConfigured: boolean }`).

### 4.2 Outbox Storage & PII Minimisation (`integration_production_dispatches`)
- While a dispatch is `queued` or `sending` (or `failed` with retry remaining), the outbound JSON body is encrypted in `payload_enc` via `FieldCrypto` with AAD `integration_production_dispatches.payload:<publicId>`.
- As soon as a dispatch reaches a terminal state (`delivered`, `dead`, or terminal `failed`), `payload_enc` is overwritten with `NULL` so customer PII (`client_name`, `client_email`) is never retained in the dispatch log.
- `payload_summary` stores only non-PII operational fields (`order_id`, `client_id`, `packet`, `packet_tier`, `canon_version`, `release_status`, `run_mode`, `order_date`, `priority`, `triggered_by`, `has_notes`).
- In `order.preview`, `client_name` (e.g. `"J*** D***"`) and `client_email` (e.g. `"j***@example.com"`) are masked for `staff` callers and revealed unmasked only to `admin` callers. Full webhook URLs and auth header secrets never appear in previews, responses, logs, or audit metadata.

### 4.3 Durable Audit Events
All mutations re-validate the actor inside the DB transaction (`identity.sessions.assertCurrent(principal, tx)`) and write durable hash-chained audit events on the same `tx`:
- `integration.production.settings.changed`
- `integration.production.dispatch.requested`
- `integration.production.dispatch.delivered`
- `integration.production.dispatch.failed`
- `integration.production.dispatch.dead`
- `integration.production.dispatch.resent`
- `integration.production.dispatch.refused`

---

## 5. Operator Runbook

1. **Allowlist the webhook host(s)**:
   - Navigate to `/admin/integrations/egress` (requires `admin` + `integrations.manage` + MFA step-up).
   - Create an enabled rule with `purpose = "webhook"`, `protocol = "https:"`, `port = 443` (or your HTTPS port), and `matchType = "host"` matching your production webhook hostname.
2. **Configure & dry-run test destinations**:
   - Navigate to `/admin/integrations/production`.
   - Enter `canonVersion` (e.g. `2.2`), `runMode` (`production`, `test`, or `validation`), `P101` HTTPS URL, `P201` HTTPS URL, and optional custom auth header name + secret value.
   - Click **Test destination** for `P101` and `P201` — executes a dry-run URL + allowlist + public-DNS check with **zero** outbound HTTP requests and **zero** secret URL reflection.
   - Enable the pipeline toggle and save (MFA step-up required).
3. **Dispatching `P101` and `P201` on an order**:
   - Open an eligible packet order (`lockState` in `none` or `review`) -> **Production** tab.
   - Preview and request **P101 (Initialize folders)**. Wait for state `delivered`.
   - Preview and request **P201 (Trigger production)**.
4. **Handling `failed` or `dead` dispatches**:
   - Inspect `reasonCode`, `httpStatus`, and `safeError` in the order's **Production** tab or `/admin/integrations/production` dispatch log.
   - Once the downstream issue is resolved (and after confirming on the receiver whether an ambiguous in-flight request was processed), an administrator with fresh MFA step-up can trigger **Resend**, which creates a new `integration_production_dispatches` row with a fresh `publicId` / `Idempotency-Key` and `resent_from_id` pointing to the prior row.
5. **Verification boundary**:
   - Payload builders, strict egress/SSRF pinning, encrypted retry payloads, retry/dead-letter transitions, role-based PII masking, and single-connection pool safety are verified in automated MariaDB + Vitest suites (`payload.test.ts`, `production.test.ts`, `production.test.tsx`). Live n8n/SharePoint endpoints are external to this repository and must be verified in staging (`runMode = "validation"` or `"test"`) using the steps above before enabling `runMode = "production"`.
