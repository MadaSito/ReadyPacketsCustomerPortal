# ReadyPackets Production Pipeline Webhooks (`P101`, `P201`, Optional `P301` & `P401`)

Owner: `integrations_engineer` (`server/modules/integrations/production/**`, `server/modules/integrations/egress.ts`, `server/modules/integrations/settings.ts`, `server/modules/integrations/schema.ts`, `client/src/features/integrations/routes.tsx`; admin/order UI in `client/src/features/integrations/production/**` owned by `siem_engineer`).

This document specifies the outbound production pipeline integration implemented in Increment 02 (`docs/engineering/INCREMENT_02_CONTRACT.md` §D) and extended in Increment 04 Part B (`docs/engineering/INCREMENT_04_PART_B.md` Decision B4) against the authoritative source documents:
- `docs/source-specs/increment-02/P101_Order_Creation_Webhook_Reference.md`
- `docs/source-specs/increment-02/P201_Trigger_Production_Webhook_Reference.md`

---

## 1. Overview & Four-Phase Lifecycle

ReadyPackets dispatches outbound HTTPS JSON webhooks to the configured production pipeline (for example, n8n):

1. **`P101` — Phase I: Order Creation & Folder Initialization** (`phase = "P101"`, required when pipeline is enabled):
   - Initializes the SharePoint order/packet folder tree and intake metadata for an eligible packet order.
   - Single-packet orders send `packet: "1".."6"`, `tier: "Basic" | "Standard" | "Premium"`, and `bundle_scope_manifest: ""`.
   - Multi-packet orders (`>= 2` distinct packets) send `packet: "7"`, `tier: "Mixed"`, and `bundle_scope_manifest` as a canonical JSON object string sorted ascending (`"{\"packet_1\":\"Basic\",\"packet_3\":\"Premium\"}"`).
   - `order_scope_mode` is an n8n-internal derived variable and is **never** sent in outbound payloads.
   - Byte-identical across Increments 02–04.
2. **`P201` — Phase II: Trigger Production Run** (`phase = "P201"`, required when pipeline is enabled):
   - Triggers downstream document generation for a previously initialized order.
   - Hard-gated on BOTH explicit operator confirmation (`phase1ArtifactsConfirmed === true`) AND at least one `delivered` `P101` dispatch on the same order (`PRODUCTION_P101_NOT_DELIVERED` otherwise).
   - Copies `{ customer_id, order_id, run_mode }` **verbatim** from the delivered `P101` row (`sent_customer_id`, `sent_order_id`, `sent_run_mode`) — never recomputed from `users`, `orders`, or live settings — so SharePoint folder lookup keys cannot drift between phases.
   - Byte-identical across Increments 02–04.
3. **`P301` — Phase III: Downstream Quality / Review Stage** (`phase = "P301"`, optional endpoint):
   - Optional stage configured via `integrations.production.p301_url`.
   - Calling `production.order.requestP301` when `p301Url` is unconfigured fails closed with `NOT_CONFIGURED` / `PRODUCTION_PHASE_ENDPOINT_NOT_CONFIGURED`.
   - Requires both `P101` and `P201` to have `delivered` dispatches on the order (`PRODUCTION_P101_NOT_DELIVERED` / `PRODUCTION_P201_NOT_DELIVERED`).
   - Sends the exact 3-field `{ customer_id, order_id, run_mode }` payload copied verbatim from the delivered `P101` row, under the same strict egress policy, destination fingerprint pinning, outbox fencing, reconciliation, and pre-send order revalidation as `P201`.
4. **`P401` — Phase IV: Final Release / Packaging Stage** (`phase = "P401"`, optional endpoint):
   - Optional stage configured via `integrations.production.p401_url`.
   - Calling `production.order.requestP401` when `p401Url` is unconfigured fails closed with `NOT_CONFIGURED` / `PRODUCTION_PHASE_ENDPOINT_NOT_CONFIGURED`.
   - Requires `P101` and `P201` to be `delivered` (`PRODUCTION_P101_NOT_DELIVERED` / `PRODUCTION_P201_NOT_DELIVERED`), and **also** requires `P301` to be `delivered` whenever `p301Url` is configured (`PRODUCTION_P301_NOT_DELIVERED`). When `p301Url` is not configured, `P401` may follow directly after `P201`.
   - Sends the exact 3-field `{ customer_id, order_id, run_mode }` payload copied verbatim from the delivered `P101` row, under the same strict egress policy, destination fingerprint pinning, outbox fencing, reconciliation, and pre-send order revalidation as `P201`.

### Default Installation Posture
- Feature flag `feature.integrations.production` (`integrations.production`) defaults to **`false`**.
- `canonVersion` defaults to `""` (empty) — **no silent default canon version exists**. Enabling the pipeline requires an administrator with `integrations.manage` and fresh MFA step-up to explicitly configure `canonVersion`, `p101Url`, and `p201Url` (plus optional `p301Url` / `p401Url`), along with matching outbound allowlist rules.
- Non-packet orders (`otherItemCount > 0` or zero packet items) are refused (`ORDER_HAS_NON_PACKET_ITEMS` / `ORDER_HAS_NO_PACKETS`) and durably audited via `integration.production.dispatch.refused`.

---

## 2. Outbound HTTP Contract & Receiver Requirements

### 2.1 Transport, Destination Pinning & Strict Egress Policy
- **Method**: `POST`
- **Protocol**: `https:` only (TLS >= 1.2, strict certificate verification `rejectUnauthorized: true`, SNI `servername` bound to hostname). Plain `http:`, credentials-in-URL (`https://user:pass@...`), and URL `#fragment` components are rejected at configuration time, dry-run time, queue time, and worker pre-send time.
- **Mandatory Outbound Allowlist**: Every destination URL (`P101`, `P201`, `P301`, `P401`) must match an enabled `integration_egress_allowlist` rule with `purpose = "webhook"` and `protocol = "https:"`. Unlisted public hosts are refused (`EGRESS_ALLOWLIST_REQUIRED`).
- **Public-Only Single-Evaluation DNS Pinning**: `egress.fetchPinned(..., "webhook", { requireAllowlistRule: true, publicAddressesOnly: true })` resolves A/AAAA records once under a 5 s deadline, verifies that **every** returned IP is globally public (`PUBLIC` — private RFC 1918, loopback, link-local, CGNAT, ULA, metadata, documentation, and IPv4-embedded IPv6 transition ranges are refused even if `allowPrivateAddress` is set on a rule), matches the allowlist rule, and binds the exact `PinnedEgressTarget` (`address` + `family`, `autoSelectFamily: false`) to the TLS socket.
- **Destination Fingerprint Pinning (`PW-04`)**: At enqueue time, each dispatch (`P101`–`P401`) computes a keyed HMAC-SHA-256 `destination_fingerprint` over `(phase, targetUrl, normalizedAuthHeaderName, authHeaderValue, [canonVersion, runMode for P101])`. Immediately before sending, the worker recomputes the fingerprint from live settings/secrets inside its fenced transaction; if the URL, authentication header, or P101 canon/run-mode changed after authorization (whether via `integrations.production.settings.update` or generic Platform settings), the worker cancels the dispatch as terminal `failed` with `lastReasonCode = "DESTINATION_CHANGED"` and scrubs `payload_enc = NULL` without opening any network socket.
- **Zero Redirect Following & Zero Response Body Retention (`PW-01`)**: Any `3xx` response is refused immediately (`EGRESS_REDIRECT_REFUSED`, terminal `failed`, no retry). Response reads are capped at `8 KiB` and **completely discarded** — `response_summary` stores only a fixed server-generated status string mapped from `(reasonCode, httpStatus, state)`. Remote receiver body text is never persisted, logged, or returned to any caller.

### 2.2 Request Headers

| Header | Value | Notes |
| --- | --- | --- |
| `Content-Type` | `application/json` | Exact UTF-8 JSON body |
| `Idempotency-Key` | `rp-prod:<p101\|p201\|p301\|p401>:<dispatch.publicId>` | Stable across all automatic retry attempts of the same dispatch row; regenerated when a new dispatch row is queued via `retry`, `redeliver`, or `resend` |
| `X-ReadyPackets-Delivery` | `<dispatch.publicId>` (26-char ULID) | Unique delivery row identifier |
| `X-ReadyPackets-Redelivery-Of` (redeliveries only) | `<originalDeliveredDispatch.publicId>` | Sent **only** on dispatches created via `production.order.redeliver`; omitted on initial dispatches and failed/dead retries so `P101`/`P201` wire traffic remains unchanged |
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
| Interrupted `sending` / ambiguous prior attempt (`PW-02`) | `unknown` (`PRODUCTION_DELIVERY_INTERRUPTED`, `PRODUCTION_AMBIGUOUS_IN_FLIGHT`, `PRODUCTION_PRIOR_ATTEMPT_UNCERTAIN`) | `integrations.production.deliver` runs with `retrySafe: false` so crashed in-flight attempts are **never** auto-replayed. SQL-filtered reconciliation (`integrations.production.reconcile` every 60 s + synchronous order-scoped reconciliation) consults `services.jobAdmin.reconcileOutboxJob(jobPublicId, tx, { cancelQueued })` under canonical lock order (`job_runs` first -> `integration_production_dispatches` second, rolling back via `CandidateMovedRollback` on mismatch). Active `running_live` and `queued_live` jobs are left untouched; expired worker leases (`settled_unknown`) or expired/canceled dispatches with `attemptCount > 0` transition to terminal `unknown`, scrub `payload_enc = NULL`, reset `active_fencing_token = 0`, record a durable `integration.production.dispatch.failed` audit (`outcome: "unknown"`, `delivery_uncertain: true`), keep downstream phases blocked, and require admin step-up `resend` after downstream verification. |
| Orphaned / expired `queued` with zero attempts (`PW-02`) | `failed` (`PRODUCTION_QUEUE_STALLED`, `PRODUCTION_DELIVERY_EXPIRED`) | `queued` rows whose linked job is missing/terminal past `PRODUCTION_STALE_QUEUED_MS = 15 min`, or whose `expires_at` (`created_at + 24h`) has elapsed (`cancelQueued: true`) with `attemptCount === 0`, transition safely to terminal `failed` and scrub `payload_enc = NULL`. Worker Phase 3 finalization requires matching `(state = "sending", version, attemptCount, activeFencingToken, jobPublicId)` (`PRODUCTION_FENCE_SUPERSEDED` otherwise) so a late/wedged worker can never overwrite a reconciled row or set `queued` with `payload_enc = NULL`. |

**Mandatory Receiver Idempotency**: Receivers (n8n / downstream webhooks) **must** deduplicate incoming requests by `Idempotency-Key` AND by `(order_id, phase)` folder/execution state (consulting `X-ReadyPackets-Redelivery-Of` when an explicit operator replay is authorized) so network retries or operator-authorized re-deliveries remain safe.

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
- `customer_id`: Required, non-empty, at most 120 characters: the customer ID stored in `users.customer_ref`. IDs generated from increment 03 on have the form `RPCUS-` plus nine characters from 0-9 and A-Z (`^RPCUS-[0-9A-Z]{9}$`); customers created earlier keep their `RP-` plus seven characters ID unless an administrator changes it. Orders whose owner has no customer ID are refused with `CUSTOMER_REF_MISSING`.
- `order_id`: Required trimmed `orders.reference` (`1..64` printable chars, no control characters).
- `packet`: `"1".."6"` for single-packet orders; `"7"` for multi-packet bundles (`>= 2` distinct packets `1..6`). Duplicate packet numbers are refused (`DUPLICATE_PACKET_NUMBER`).
- `tier`: `"Basic" | "Standard" | "Premium"` when `packet` is `"1".."6"`; `"Mixed"` when `packet === "7"`.
- `canon_version`: Required explicit setting matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`.
- `run_mode`: Required explicit setting matching `^[a-z][a-z0-9_]{0,31}$` (default `"production"`).
- `client_name`: Required trimmed customer full name (`1..200` printable chars).
- `client_email`: Required valid customer email (`<= 254` chars).
- `release_status`: Optional operator string (`<= 120` printable chars); defaults to `""` when omitted (`PW-08`).
- `bundle_scope_manifest`: `""` when `packet` is `"1".."6"`; canonical JSON object string (`"{\"packet_2\":\"Basic\",\"packet_6\":\"Premium\"}"`) with `>= 2` ascending `packet_1..packet_6` keys when `packet === "7"`.

### 3.2 `P201`, `P301` & `P401` — Downstream Phase Payload (`P201Payload` / `P301Payload` / `P401Payload`)

```json
{
  "customer_id": "RP-9A8B7C6",
  "order_id": "ORD-2026-0777",
  "run_mode": "production"
}
```

Field validation rules (`validateP201` / `validateP301` / `validateP401` and `buildP201FromDeliveredP101` / `buildP301FromDeliveredP101` / `buildP401FromDeliveredP101`):
- `customer_id`, `order_id`, `run_mode`: Copied verbatim from the delivered `P101` row (`sentCustomerId`, `sentOrderId`, `sentRunMode`) and verified byte-for-byte before enqueueing and again in the worker before sending.

---

## 4. Per-Order Preview Disabled Reasons, Dispatch History, Retry & Step-Up Redelivery (Increment 04 Part B)

### 4.1 Per-Phase "Why Disabled" Reason List (`production.order.preview`)
`trpc.integrations.production.order.preview({ orderPublicId, releaseStatus? })` returns `settingsHref: "/admin/integrations/production"` and a structured `disabledReasons: ProductionDisabledReason[]` array on every phase (`p101`, `p201`, `p301`, `p401`). Each entry carries `{ code, category, message, settingsActionable }`:
- `pipeline_off` (`PRODUCTION_FEATURE_DISABLED`, `settingsActionable: true`): Production pipeline feature flag is off.
- `endpoint_missing` (`PRODUCTION_P101_ENDPOINT_MISSING`, `PRODUCTION_P201_ENDPOINT_MISSING`, `PRODUCTION_P301_ENDPOINT_MISSING`, `PRODUCTION_P401_ENDPOINT_MISSING`, `settingsActionable: true`): The phase's HTTPS webhook URL is not configured.
- `config_incomplete` (`CANON_VERSION_MISSING`, `CANON_VERSION_INVALID`, `RUN_MODE_INVALID`, `settingsActionable: true`): Required pipeline configuration is missing or invalid.
- `in_progress` (`PRODUCTION_DISPATCH_IN_PROGRESS`, `settingsActionable: false`): A dispatch for that phase is currently `queued` or `sending`.
- `already_delivered` (`PRODUCTION_ALREADY_DELIVERED`, `settingsActionable: false`): That phase has already been delivered; replay requires **Redeliver**.
- `retry_or_resend_required` (`PRODUCTION_OUTCOME_UNKNOWN`, `PRODUCTION_RETRY_REQUIRED`, `settingsActionable: false`): Prior dispatch ended in `unknown` (requires admin `resend` after downstream check) or `failed`/`dead` (use **Retry**).
- `precondition` (`PRODUCTION_P101_NOT_DELIVERED`, `PRODUCTION_P201_NOT_DELIVERED`, `PRODUCTION_P301_NOT_DELIVERED`, `ORDER_LOCKED`, `ORDER_CANCELED`, `CUSTOMER_REF_MISSING`, `ORDER_HAS_NON_PACKET_ITEMS`, `ORDER_HAS_NO_PACKETS`, etc., `settingsActionable: false`): Order-level or upstream-phase precondition is not satisfied.

### 4.2 Per-Order Dispatch History (`production.order.history`)
`trpc.integrations.production.order.history({ orderPublicId })` (gated by `orders.production.trigger` + `orders.assertCanReadOrder`) runs synchronous stale-outbox reconciliation for the order and returns all `ProductionDispatchItem` rows newest-first, including:
- `phase` (`P101` | `P201` | `P301` | `P401`), `state`, `attemptCount`, `maxAttempts`
- `httpStatus`, `lastReasonCode`, `responseSummary`, `resendReason`
- `retryOf` (`retry_of_public_id` ULID when created via `order.retry`, else `null`)
- `redeliveryOf` (`redelivery_of_public_id` ULID when created via `order.redeliver`, else `null`)
- `createdAt`, `updatedAt`, `deliveredAt`, `finalizedAt`, and `correlationId`

### 4.3 Operator Retry of Failed / Dead Dispatches (`production.order.retry`)
- **Capability**: `orders.production.trigger` (`staff` or `admin`; no MFA step-up required because downstream delivery never succeeded).
- **Invariants**:
  - Target `dispatchPublicId` must belong to `orderPublicId` (`NOT_FOUND` / `PRODUCTION_DISPATCH_NOT_FOUND` otherwise).
  - Target dispatch must be in `failed` or `dead` state (`CONFLICT` / `PRODUCTION_DISPATCH_NOT_RETRYABLE` for `queued`, `sending`, `unknown`, or `delivered`).
  - No dispatch for that phase on the order may already be `delivered` (`CONFLICT` / `PRODUCTION_ALREADY_DELIVERED` — prevents staff from using an older failed row to replay an already-delivered phase without `orders.production.redeliver`), `queued`/`sending` (`PRODUCTION_DISPATCH_IN_PROGRESS`), or `unknown` (`PRODUCTION_OUTCOME_UNKNOWN`).
  - Target dispatch must be the latest dispatch row for its `(orderId, phase)` (`CONFLICT` / `PRODUCTION_DISPATCH_SUPERSEDED` otherwise).
  - Re-validates live pipeline settings, phase preconditions, and order state, then inserts a new `queued` row with `retry_of_public_id = target.publicId`, controlled `resend_reason` (`OPERATOR_RETRY_AFTER_FAILURE` or `OPERATOR_RETRY_AFTER_DEAD_LETTER`), and durable `integration.production.dispatch.retried` audit event (`orderPublicId` linked).

### 4.4 Step-Up Redelivery of Delivered Dispatches (`production.order.redeliver`)
- **Capability**: `orders.production.redeliver` (`admin` + fresh MFA step-up within `STEP_UP_MAX_AGE_MS`, re-checked post-lock via `assertProductionRedeliverInTx`). `staff` callers receive `FORBIDDEN` (`CAPABILITY_NOT_GRANTED`); `customer` callers receive `FORBIDDEN` (`ROLE_NOT_PERMITTED`); `admin` callers without fresh step-up receive `FORBIDDEN` (`STEP_UP_REQUIRED`).
- **Server-Side Confirmation & Reason Validation**:
  - `confirmation` must equal the exact uppercase string `"REDELIVER"` (`BAD_REQUEST` / `REDELIVER_CONFIRMATION_REQUIRED` otherwise).
  - `reason` must trim to `3..280` printable characters with zero control characters (`BAD_REQUEST` / `REDELIVER_REASON_REQUIRED` otherwise).
- **New Delivery Lineage & Audit Hygiene (`PW-07`)**:
  - Target `dispatchPublicId` must belong to `orderPublicId` and have `state === "delivered"` (`CONFLICT` / `PRODUCTION_DISPATCH_NOT_DELIVERED` otherwise), with no `queued`/`sending` dispatch in progress for that phase.
  - Inserts a **new** `integration_production_dispatches` row (preserving the original delivered row untouched) with `redelivery_of_public_id = target.publicId`, `resend_reason = "OPERATOR_REPLAY_DELIVERED"`, a fresh `Idempotency-Key` (`rp-prod:<phase>:<newPublicId>`), and outbound `X-ReadyPackets-Redelivery-Of: <target.publicId>`.
  - Records durable `WARN` audit event `integration.production.dispatch.redelivered` with `orderPublicId`, `attributes: { phase, order_public_id, idempotency_key, redelivery_of_public_id, resend_reason: "OPERATOR_REPLAY_DELIVERED" }`, and `safeCounts: { reason_length }` — raw operator prose is never written to DB columns or audit logs.

---

## 5. Settings, Secret Export Exclusion, Lock Order & Audit Events

### 5.1 Registered Settings & Non-Exportable Secrets (`server/modules/integrations/settings.ts`)
- `feature.integrations.production` (`defineFlag`, default `false`).
- `integrations.production.config` (`defineSetting` — `{ canonVersion, runMode, timeoutMs, authHeaderName }`).
- `integrations.production.p101_url`, `integrations.production.p201_url`, `integrations.production.p301_url`, `integrations.production.p401_url`, `integrations.production.auth_value` (`defineSecret` with `exportable: false` — encrypted at rest via `FieldCrypto` AES-256-GCM, write-only, masked `{ host, last4 }` / `authHeaderValueConfigured` in settings views, and **excluded from generic Platform settings exports/imports** even when `includeSecrets: true` is passed to `configTransfer`).

### 5.2 Lock Ordering, Fail-Closed Actor Revalidation & Controlled Audit Fields
- **Canonical Lock Order (`PW-05`)**: Order-scoped mutations (`requestP101`, `requestP201`, `requestP301`, `requestP401`, `retry`, `redeliver`, `resend`) acquire the order row lock **first** (`orders.assertCanReadOrder(principal, orderPublicId, { tx, forUpdate: true })`) and lock/revalidate the actor's Identity user + session rows **second** (`assertProductionTriggerInTx` / `assertProductionRedeliverInTx` / `assertProductionResendInTx`), matching `BUILD_CONTRACT.md` (`orders -> users -> user_sessions`).
- **Fail-Closed Actor & Post-Lock Step-Up (`PW-06`)**: `integrations/authz.ts` refuses with `FORBIDDEN / ACTOR_UNVERIFIABLE` if `services.identity.sessions.assertCurrent` is unavailable, verifies `current.role === principal.role`, and computes `postLockNow = deps.clock.now()` **after** `assertCurrent` resolves its row locks when checking `STEP_UP_MAX_AGE_MS`.
- **Durable Order-Linked Audit Events**: Every order-scoped production dispatch audit event passes top-level `orderPublicId` plus `attributes.order_public_id` so Order History surfaces the full timeline:
  - `integration.production.settings.changed`
  - `integration.production.dispatch.requested`
  - `integration.production.dispatch.retried`
  - `integration.production.dispatch.redelivered`
  - `integration.production.dispatch.resent`
  - `integration.production.dispatch.delivered`
  - `integration.production.dispatch.failed`
  - `integration.production.dispatch.dead`
  - `integration.production.dispatch.refused`

---

## 6. Operator Runbook

1. **Allowlist the webhook host(s)**:
   - Open `/admin/integrations/egress` (`admin` + `integrations.manage` + MFA step-up) and create an enabled rule with `purpose = "webhook"`, `protocol = "https:"`, `port = 443`, and `matchType = "host"` for your production webhook hostname.
2. **Configure & dry-run test destinations**:
   - Open `/admin/integrations/production`, enter `canonVersion` (for example `v3.0`), `runMode` (for example `production`), required `P101` and `P201` HTTPS URLs, optional `P301` and `P401` HTTPS URLs, and optional custom auth header name + secret value.
   - Run **Test destination** for each configured phase (dry-run URL + allowlist + public-DNS check with zero HTTP calls and zero URL reflection), then enable and save.
3. **Dispatch phases from the Order Automation tab**:
   - Open an eligible packet order (`lockState` in `none` or `review`) -> **Automation** tab (`/staff/orders/:orderPublicId/automation`).
   - If any start button is disabled, inspect the inline reason list (and follow the `/admin/integrations/production` settings link when `settingsActionable` is true).
   - Start **Phase I (`P101`)** first, confirm Phase I SharePoint artifacts and start **Phase II (`P201`)**, and when configured continue through **Phase III (`P301`)** and **Phase IV (`P401`)**.
4. **Recovering from `failed`, `dead`, `unknown`, or replaying `delivered` dispatches**:
   - For `failed` or `dead` dispatches on the latest attempt of an undelivered phase, staff or administrators with `orders.production.trigger` can click **Retry** (`order.retry`) once the upstream endpoint or allowlist issue is resolved.
   - For `unknown` dispatches (`PRODUCTION_DELIVERY_INTERRUPTED`, `PRODUCTION_AMBIGUOUS_IN_FLIGHT`, `PRODUCTION_PRIOR_ATTEMPT_UNCERTAIN`), confirm downstream n8n/SharePoint state first before using admin step-up **Re-send** (`order.resend`).
   - To intentionally replay an already `delivered` dispatch, an administrator with `orders.production.redeliver` and fresh MFA step-up opens **Redeliver**, enters an audit reason, and types `REDELIVER` (`order.redeliver`), creating a new delivery row linked via `redeliveryOf`.
