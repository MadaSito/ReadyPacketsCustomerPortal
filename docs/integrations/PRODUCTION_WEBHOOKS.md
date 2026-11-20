# ReadyPackets Production Pipeline Webhooks (`P101` & `P201`)

Owner: `integrations_engineer` (`server/modules/integrations/production/**`, `server/modules/integrations/egress.ts`, `server/modules/integrations/settings.ts`, `server/modules/integrations/schema.ts`, `client/src/features/integrations/routes.tsx`; admin/order UI in `client/src/features/integrations/production/**` owned by `siem_engineer`).

This document specifies the outbound production pipeline integration implemented for Increment 02 (`docs/engineering/INCREMENT_02_CONTRACT.md` §D) against the authoritative source documents:
- `docs/source-specs/increment-02/P101_Order_Creation_Webhook_Reference.md`
- `docs/source-specs/increment-02/P201_Trigger_Production_Webhook_Reference.md`

---

## 1. Overview & Two-Phase Lifecycle

ReadyPackets dispatches two outbound HTTPS JSON webhooks to the configured production pipeline (e.g., n8n):

1. **`P101` — Order Creation & Folder Initialization** (`phase = "P101"`):
   - Initializes the SharePoint order/packet folder tree and intake metadata for an eligible packet order.
   - Single-packet orders send `packet: "1".."6"`, `tier: "Basic" | "Standard" | "Premium"`, and `bundle_scope_manifest: ""`.
   - Multi-packet orders (`>= 2` distinct packets) send `packet: "7"`, `tier: "Mixed"`, and `bundle_scope_manifest` as a canonical JSON object string sorted ascending (`"{\"packet_1\":\"Basic\",\"packet_3\":\"Premium\"}"`).
   - `order_scope_mode` is an n8n-internal derived variable and is **never** sent in outbound payloads.
2. **`P201` — Trigger Production Run** (`phase = "P201"`):
   - Triggers downstream document generation for a previously initialized order.
   - Hard-gated on BOTH explicit operator confirmation (`phase1ArtifactsConfirmed === true`) AND at least one `delivered` `P101` dispatch on the same order (`PRODUCTION_P101_NOT_DELIVERED` otherwise).
   - Copies `{ customer_id, order_id, run_mode }` **verbatim** from the delivered `P101` row (`sent_customer_id`, `sent_order_id`, `sent_run_mode`) — never recomputed from `users`, `orders`, or live settings — so SharePoint folder lookup keys cannot drift between Phase I and Phase II.

### Default Installation Posture
- Feature flag `feature.integrations.production` (`integrations.production`) defaults to **`false`**.
- `canonVersion` defaults to `""` (empty) — **no silent default canon version exists**. Enabling the pipeline requires an administrator with `integrations.manage` and fresh MFA step-up to explicitly configure `canonVersion`, `p101Url`, and `p201Url`, plus matching outbound allowlist rules.
- Non-packet orders (`otherItemCount > 0` or zero packet items) are refused (`ORDER_HAS_NON_PACKET_ITEMS` / `ORDER_HAS_NO_PACKETS`) and durably audited via `integration.production.dispatch.refused`.

---

## 2. Outbound HTTP Contract & Receiver Requirements

### 2.1 Transport, Destination Pinning & Strict Egress Policy
- **Method**: `POST`
- **Protocol**: `https:` only (TLS >= 1.2, strict certificate verification `rejectUnauthorized: true`, SNI `servername` bound to hostname). Plain `http:`, credentials-in-URL (`https://user:pass@...`), and URL `#fragment` components are rejected at configuration time, dry-run time, queue time, and worker pre-send time.
- **Mandatory Outbound Allowlist**: Every destination URL must match an enabled `integration_egress_allowlist` rule with `purpose = "webhook"` and `protocol = "https:"`. Unlisted public hosts are refused (`EGRESS_ALLOWLIST_REQUIRED`).
- **Public-Only Single-Evaluation DNS Pinning**: `egress.fetchPinned(..., "webhook", { requireAllowlistRule: true, publicAddressesOnly: true })` resolves A/AAAA records once under a 5 s deadline, verifies that **every** returned IP is globally public (`PUBLIC` — private RFC 1918, loopback, link-local, CGNAT, ULA, metadata, documentation, and IPv4-embedded IPv6 transition ranges are refused even if `allowPrivateAddress` is set on a rule), matches the allowlist rule, and binds the exact `PinnedEgressTarget` (`address` + `family`, `autoSelectFamily: false`) to the TLS socket.
- **Destination Fingerprint Pinning (`PW-04`)**: At enqueue time, each dispatch computes a keyed HMAC-SHA-256 `destination_fingerprint` over `(phase, targetUrl, normalizedAuthHeaderName, authHeaderValue, [canonVersion, runMode for P101])`. Immediately before sending, the worker recomputes the fingerprint from live settings/secrets inside its fenced transaction; if the URL, authentication header, or P101 canon/run-mode changed after authorization (whether via `integrations.production.settings.update` or generic Platform settings), the worker cancels the dispatch as terminal `failed` with `lastReasonCode = "DESTINATION_CHANGED"` and scrubs `payload_enc = NULL` without opening any network socket.
- **Zero Redirect Following & Zero Response Body Retention (`PW-01`)**: Any `3xx` response is refused immediately (`EGRESS_REDIRECT_REFUSED`, terminal `failed`, no retry). Response reads are capped at `8 KiB` and **completely discarded** — `response_summary` stores only a fixed server-generated status string mapped from `(reasonCode, httpStatus, state)`. Remote receiver body text is never persisted, logged, or returned to any caller.

### 2.2 Request Headers

| Header | Value | Notes |
| --- | --- | --- |
| `Content-Type` | `application/json` | Exact UTF-8 JSON body |
| `Idempotency-Key` | `rp-prod:<p101\|p201>:<dispatch.publicId>` | Stable across all automatic retry attempts of the same dispatch; regenerated on admin `resend` |
| `X-ReadyPackets-Delivery` | `<dispatch.publicId>` (26-char ULID) | Unique delivery row identifier |
| `X-Correlation-Id` | `<dispatch.correlationId>` | Request correlation ID captured when the dispatch was queued |
| `<authHeaderName>` (optional) | `<decrypted authHeaderValue>` | Sent only when both `authHeaderName` (token `^[A-Za-z0-9-]{1,64}$`, excluding reserved transport/portal headers) and `authHeaderValue` are configured |

### 2.3 Expected Receiver Responses & Retry / Reconciliation Semantics

| Condition | Portal Classification | Retry & `payload_enc` Behavior |
| --- | --- | --- |
| `200` – `299` | `delivered` (`PRODUCTION_DELIVERED`) | Terminal success; `payload_enc` scrubbed (`NULL`); fixed server `response_summary` recorded. |
| `429` or `500` – `599` | Retryable failure (`PRODUCTION_HTTP_429` / `PRODUCTION_HTTP_5XX`) | Retries with exponential backoff + jitter using the **same** `Idempotency-Key` up to `PRODUCTION_MAX_ATTEMPTS = 5`, then transitions to `dead` (`integration.production.dispatch.dead`) and scrubs `payload_enc = NULL`. |
| `300` – `399` | Non-retryable failure (`EGRESS_REDIRECT_REFUSED`) | Immediate terminal `failed`; `payload_enc` scrubbed (`NULL`). |
| `400` – `499` (except `429`) | Non-retryable failure (`PRODUCTION_HTTP_4XX`) | Immediate terminal `failed`; `payload_enc` scrubbed (`NULL`). |
| Pre-send order/destination drift | Non-retryable failure (`DESTINATION_CHANGED`, `ORDER_LOCKED`, `ORDER_CANCELED`, `ORDER_OWNER_CHANGED`, `ORDER_OWNER_INACTIVE`, `ORDER_NOT_FOUND`, `ORDER_SCOPE_CHANGED`) | Stopped in Phase 1 before any socket opens; immediate terminal `failed`; `payload_enc` scrubbed (`NULL`). |
| Interrupted `sending` / orphaned `queued` (`PW-02`) | Reconciled terminal failure (`PRODUCTION_DELIVERY_INTERRUPTED`, `PRODUCTION_DELIVERY_STALLED`) | `integrations.production.deliver` runs with `retrySafe: false` so crashed in-flight attempts are **never** auto-replayed. Bounded reconciliation (`integrations.production.reconcile` every 60 s + synchronous reconciliation on order preview/history/list/trigger/resend) transitions `sending` rows older than `timeoutMs + 30_000 ms` and `queued` rows older than `15 min` to terminal `failed`, scrubs `payload_enc = NULL`, records a durable `integration.production.dispatch.failed` audit (`reconciled: true`), and unblocks bounded admin `resend`. |

**Mandatory Receiver Idempotency**: Receivers (n8n / downstream webhooks) **must** deduplicate incoming requests by `Idempotency-Key` AND by `(order_id, phase)` folder/execution state so network retries or operator-authorized re-sends after interrupted deliveries remain safe.

---

## 3. Exact JSON Payload Schemas

### 3.1 `P101` — Order Creation Payload (`P101Payload`)

```json
{
  "customer_id": "RP-9A8B7C6",
  "order_id": "ORD-2026-0777",
  "packet": "7",
  "tier": "Mixed",
  "canon_version": "v3.0",
  "run_mode": "production",
  "client_name": "Morgan Sterling",
  "client_email": "morgan@sterling.example.test",
  "release_status": "",
  "bundle_scope_manifest": "{\"packet_2\":\"Basic\",\"packet_6\":\"Premium\"}"
}
```

Field validation rules (`validateP101` / `buildP101Payload` in `server/modules/integrations/production/payload.ts`):
- `customer_id`: Required strict `^RP-[A-Z0-9]{7}$` (`users.customer_ref`; orders whose owner lacks a valid `RP-XXXXXXX` ref are refused with `CUSTOMER_ID_MISSING_OR_INVALID`).
- `order_id`: Required trimmed `orders.reference` (`1..64` printable chars, no control characters).
- `packet`: `"1".."6"` for single-packet orders; `"7"` for multi-packet bundles (`>= 2` distinct packets `1..6`). Duplicate packet numbers are refused (`DUPLICATE_PACKET_NUMBER`).
- `tier`: `"Basic" | "Standard" | "Premium"` when `packet` is `"1".."6"`; `"Mixed"` when `packet === "7"`.
- `canon_version`: Required explicit setting matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`.
- `run_mode`: Required explicit setting matching `^[a-z][a-z0-9_]{0,31}$` (default `"production"`).
- `client_name`: Required trimmed customer full name (`1..200` printable chars).
- `client_email`: Required valid customer email (`<= 254` chars).
- `release_status`: Optional operator string (`<= 120` printable chars); defaults to `""` when omitted (`PW-08`).
- `bundle_scope_manifest`: `""` when `packet` is `"1".."6"`; canonical JSON object string (`"{\"packet_2\":\"Basic\",\"packet_6\":\"Premium\"}"`) with `>= 2` ascending `packet_1..packet_6` keys when `packet === "7"`.

### 3.2 `P201` — Trigger Production Payload (`P201Payload`)

```json
{
  "customer_id": "RP-9A8B7C6",
  "order_id": "ORD-2026-0777",
  "run_mode": "production"
}
```

Field validation rules (`validateP201` / `buildP201FromDeliveredP101`):
- `customer_id`, `order_id`, `run_mode`: Copied verbatim from the delivered `P101` row (`sentCustomerId`, `sentOrderId`, `sentRunMode`) and verified byte-for-byte before enqueueing and again in the worker before sending.

---

## 4. Settings, Secret Export Exclusion, Lock Order & Audit Hygiene

### 4.1 Registered Settings & Non-Exportable Secrets (`server/modules/integrations/settings.ts`)
- `feature.integrations.production` (`defineFlag`, default `false`).
- `integrations.production.config` (`defineSetting` — `{ canonVersion, runMode, timeoutMs, authHeaderName }`).
- `integrations.production.p101_url`, `integrations.production.p201_url`, `integrations.production.auth_value` (`defineSecret` with `exportable: false` — encrypted at rest via `FieldCrypto` AES-256-GCM, write-only, masked `{ host, last4 }` / `authHeaderValueConfigured` in settings views, and **excluded from generic Platform settings exports/imports** even when `includeSecrets: true` is passed to `configTransfer`).

### 4.2 Lock Ordering, Fail-Closed Actor Revalidation & Controlled Audit Fields
- **Canonical Lock Order (`PW-05`)**: Order-scoped mutations (`requestP101`, `requestP201`, `resend`) acquire the order row lock **first** (`orders.assertCanReadOrder(principal, orderPublicId, { tx, forUpdate: true })`) and lock/revalidate the actor's Identity user + session rows **second** (`assertProductionTriggerInTx` / `assertProductionResendInTx`), matching `BUILD_CONTRACT.md` (`orders -> users -> user_sessions`).
- **Fail-Closed Actor & Post-Lock Step-Up (`PW-06`)**: `integrations/authz.ts` refuses with `FORBIDDEN / ACTOR_UNVERIFIABLE` if `services.identity.sessions.assertCurrent` is unavailable, verifies `current.role === principal.role`, and computes `postLockNow = deps.clock.now()` **after** `assertCurrent` resolves its row locks when checking `STEP_UP_MAX_AGE_MS`.
- **Controlled Resend Codes & Safe Audits (`PW-07`)**:
  - `resend` validates the operator's input (`3..280` printable chars) at request time, then stores, projects, and audits **only** a controlled `ControlledResendReason` code (`OPERATOR_RESEND`, `RECEIVER_TIMEOUT`, `RECEIVER_ERROR`, `PHASE1_REPLAY`, or `CONFIGURATION_FIXED`) — raw operator prose is never persisted in `integration_production_dispatches.resend_reason` or audit logs.
  - `integration.production.settings.changed` records boolean `auth_header_configured` and `auth_header_value_configured` only (never `auth_header_name`, URLs, or secret values).
  - Durable hash-chained audit events: `integration.production.settings.changed`, `integration.production.dispatch.requested`, `integration.production.dispatch.delivered`, `integration.production.dispatch.failed`, `integration.production.dispatch.dead`, `integration.production.dispatch.resent`, `integration.production.dispatch.refused`.

---

## 5. Operator Runbook

1. **Allowlist the webhook host(s)**:
   - Open `/admin/integrations/egress` (`admin` + `integrations.manage` + MFA step-up) and create an enabled rule with `purpose = "webhook"`, `protocol = "https:"`, `port = 443`, and `matchType = "host"` for your production webhook hostname.
2. **Configure & dry-run test destinations**:
   - Open `/admin/integrations/production`, enter `canonVersion` (e.g. `v3.0`), `runMode` (e.g. `production`), `P101` HTTPS URL, `P201` HTTPS URL, and optional custom auth header name + secret value.
   - Run **Test destination** for `P101` and `P201` (dry-run URL + allowlist + public-DNS check with zero HTTP calls and zero URL reflection), then enable and save.
3. **Dispatch `P101` and `P201` on an order**:
   - Open an eligible packet order (`lockState` in `none` or `review`) -> **Production** tab.
   - Review the `P101` preview (`client_name` / `client_email` masked for `staff`, unmasked for `admin`) and click **Send Phase I (P101)**.
   - After `P101` reaches `delivered` and Phase I artifacts are verified in SharePoint, check the confirmation box and click **Start Phase II (P201)**.
4. **Recovering from `failed`, `dead`, or interrupted dispatches**:
   - Inspect `lastReasonCode`, `httpStatus`, and the fixed `responseSummary` in the order's **Production** tab or `/admin/integrations/production`.
   - If `lastReasonCode` is `DESTINATION_CHANGED`, review the updated webhook configuration before re-queuing.
   - If `lastReasonCode` is `PRODUCTION_DELIVERY_INTERRUPTED` or `PRODUCTION_AMBIGUOUS_IN_FLIGHT`, confirm downstream n8n/SharePoint state first; if a retry is required, an `admin` with fresh MFA step-up can trigger **Re-send**, which creates a fresh dispatch row pinned to the current authorized destination.
