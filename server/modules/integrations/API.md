# `server/modules/integrations` — Public API & Contract

Owner: `integrations_engineer` (`server/modules/integrations/**`, `client/src/features/integrations/**`, `docs/integrations/**`).

---

## 1. Module Service Surface (`services.integrations: IntegrationsModule`)

Implements `ModuleLifecycle` (`init()`, `start()`, `stop()`, `health()`).

### 1.1 Outbound Egress & SSRF Policy (`services.integrations.egress`)

Every outbound network connection made by the portal **must** go through `egress` (`assertAllowed` / `resolveAndAssertAllowed` / `fetchPinned`) and connect **only** to the returned pinned IP address (`address` + `family`) while passing `servername` for TLS SNI/certificate verification (`createPinnedLookup(pinned)` + `family: pinned.family` + `autoSelectFamily: false` in Node 22).

```ts
export const EGRESS_PURPOSES = [
  "siem",
  "smtp",
  "webhook",
  "sharepoint",
  "stripe",
  "square",
  "antivirus",
  "graph",
  "graph_upload",
  "entra_oidc",
  "storage_s3",
  "storage_azure",
  "storage_dropbox",
  "storage_gdrive",
] as const;
export type EgressPurpose = (typeof EGRESS_PURPOSES)[number];

export const EGRESS_PROTOCOLS = ["https:", "tls:", "smtp:", "smtps:"] as const;
export type EgressProtocol = (typeof EGRESS_PROTOCOLS)[number];

export type EgressMatchType = "host" | "ip" | "cidr";

export interface EgressFetchOptions {
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: string | Uint8Array | NodeJS.ReadableStream;
  /** Required when `body` is a `NodeJS.ReadableStream` (`bodyLength` accepted as an alias); safe integer 0..5_368_709_120 (5 GiB). */
  contentLength?: number;
  bodyLength?: number;
  maxRequestBytes?: number;
  /** Default 10_000 ms; configurable 100..30_000 ms (or up to 600_000 ms when `body` is a stream). */
  timeoutMs?: number;
  /** Default 262_144 bytes (256 KiB); configurable 1_024..16_777_216 bytes (16 MiB). */
  maxResponseBytes?: number;
  signal?: AbortSignal;
  requireAllowlistRule?: boolean;
  publicAddressesOnly?: boolean;
  /** Optional credential-bound host/suffix lineage guard (`exact` or `.suffix`). */
  expectedHostSuffixes?: readonly string[];
  /**
   * Permits HTTP `308 Resume Incomplete` ONLY when `purpose === "storage_gdrive"` and `method === "PUT"`.
   * Strips any `Location` header from returned headers and never follows redirects.
   */
  acceptUploadIncomplete?: boolean;
  beforeSend?: () => Promise<void>;
}

export interface EgressFetchResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export const EGRESS_PRESET_KEYS = [
  "microsoft_graph",
  "microsoft_graph_upload",
  "entra_oidc",
  "dropbox",
  "google_drive",
  "amazon_s3",
  "wasabi_s3",
  "backblaze_b2",
  "azure_blob",
  "stripe",
  "square",
  "square_sandbox",
] as const;
export type EgressPresetKey = (typeof EGRESS_PRESET_KEYS)[number];

export interface EgressPresetParams {
  region?: string;
  bucket?: string;
  accountName?: string;
}

export interface EgressPresetView {
  key: EgressPresetKey;
  label: string;
  purpose: EgressPurpose;
  parameterized: boolean;
  hosts: readonly string[];
  enabled: boolean;
  matchingRulePublicIds: readonly string[];
}

export interface SetEgressPresetInput {
  presetKey: EgressPresetKey;
  enabled: boolean;
  params?: EgressPresetParams;
}
```

- **Mandatory cloud-purpose policy (`stripe`, `square`, `graph`, `graph_upload`, `entra_oidc`, `storage_s3`, `storage_azure`, `storage_dropbox`, `storage_gdrive`)**:
  - HTTPS (`https:` on port `443`) only.
  - `requireAllowlistRule = true` and `publicAddressesOnly = true` are **always** enforced inside `egress.ts` regardless of caller options (`allowPrivateAddress: true` rules are rejected for these purposes).
  - `graph_upload` additionally hard-refuses `Authorization`, `Cookie`, and `Proxy-Authorization` headers (`EGRESS_FORBIDDEN_UPLOAD_HEADER`) and supports curated suffix patterns `*.sharepoint.com` and `*.files.1drv.com` (never broad cloud-compute wildcards).
  - Streaming uploads (`body: Readable`, `contentLength: number`) pipe without whole-file buffering, enforce exact byte count against `contentLength`, and never follow redirects.
- **Provider allowlist presets (`egress.listPresets()`, `egress.setPresetEnabled(principal, input)`)**:
  - Ship **disabled** (`enabled: false`, zero pre-seeded active allowlist rows).
  - Fixed-host presets:
    - `microsoft_graph` (`purpose: "graph"`): `login.microsoftonline.com`, `graph.microsoft.com`
    - `microsoft_graph_upload` (`purpose: "graph_upload"`): `*.sharepoint.com`, `*.files.1drv.com`
    - `entra_oidc` (`purpose: "entra_oidc"`): `login.microsoftonline.com`
    - `dropbox` (`purpose: "storage_dropbox"`): `api.dropboxapi.com`, `content.dropboxapi.com`
    - `google_drive` (`purpose: "storage_gdrive"`): `oauth2.googleapis.com`, `www.googleapis.com`
    - `stripe` (`purpose: "stripe"`): `api.stripe.com`
    - `square` (`purpose: "square"`): `connect.squareup.com`
    - `square_sandbox` (`purpose: "square"`): `connect.squareupsandbox.com`
  - Parameterized exact-host storage presets (never wildcard `*.amazonaws.com` or `*.blob.core.windows.net`):
    - `amazon_s3` (`purpose: "storage_s3"`, `{ region, bucket? }`): `s3.<region>.amazonaws.com` (+ `<bucket>.s3.<region>.amazonaws.com` when `bucket` supplied)
    - `wasabi_s3` (`purpose: "storage_s3"`, `{ region, bucket? }`): `s3.<region>.wasabisys.com` (+ `<bucket>.s3.<region>.wasabisys.com` when `bucket` supplied)
    - `backblaze_b2` (`purpose: "storage_s3"`, `{ region, bucket? }`): `s3.<region>.backblazeb2.com` (+ `<bucket>.s3.<region>.backblazeb2.com` when `bucket` supplied)
    - `azure_blob` (`purpose: "storage_azure"`, `{ accountName }`): `<accountName>.blob.core.windows.net`
  - `setPresetEnabled` authorizes administrators holding `integrations.manage` or the matching domain step-up capability (`mail.manage`, `storage.manage`, `identity.sso.manage`, or `payments.manage`), re-validated in-transaction via `identity.sessions.assertCurrent(principal, tx)`.

### 1.2 Microsoft Graph Core & Graph Mail (`services.integrations.graph`, `services.integrations.graphAdmin`, `services.integrations.createScopedGraphClient`)

Single Microsoft Graph client implementation (`server/modules/integrations/graph/**`) shared exclusively by Graph Mail, SharePoint document libraries / list sync, and OneDrive for Business. Unchanged from Increment 03.

### 1.3 Outbound SMTP Transport (`services.integrations.smtp`)

Unchanged from Increment 03.

### 1.4 Provider Registry & Health (`services.integrations.providers`)

```ts
export type ProviderKey = "smtp" | "graph" | "clarity" | "posthog" | "stripe" | "saml" | "sharepoint";
export type ProviderState = "disabled" | "not_configured" | "configured" | "degraded" | "failing";
```

### 1.5 Consent-Gated Public-Route Analytics (`services.integrations.analytics` & `consent.tsx`)

- Disabled by default; exact route allowlist `["/privacy", "/terms"]` with clean query/hash and anonymous visitor session.
- Clarity project ID `^[A-Za-z0-9]{6,32}$`; PostHog token `^phc_[A-Za-z0-9_]{12,176}$`; PostHog host restricted to `https://us.i.posthog.com`, `https://eu.i.posthog.com`, or an admin-allowlisted exact HTTPS origin.
- **Increment 04 consent-store integration (`client/src/features/integrations/consent.tsx`)**:
  - Reads `consent` / `useConsent` from `@/lib/consent`.
  - When `consent.enabled()` (`privacy.consent` feature on): suppresses the legacy banner, gates PostHog on `consent.has("analytics")` (`opt_in_capturing` / `opt_out_capturing`, cookieless fetch transport), gates Clarity on `consent.has("session_replay")` (`clarity("consent")` on grant, `clarity("consent", false)` + script/realm teardown on withdrawal).
  - When `consent.enabled()` is false: preserves existing strict opt-in behaviour.

### 1.6 Live Hub Provider Derivations (`stripe`, `saml`, `sharepoint`) & Production Webhooks (`production`)

- **`stripe`**, **`saml`**, and **`sharepoint`** report live operational states (`scaffoldOnly: false`) derived from their owning modules (Increment 03 planning scaffolds `scaffolds.ts`, `admin.saml.*`, and `admin.sharepoint.get` have been removed):
  - **`saml`**: reads `services.identity.sso.statusSummary()` (`/admin/sso`), reporting `not_configured` (no tenant/certificate), `disabled` (configured, switched off), `degraded` (enabled without verified sign-in/metadata check or SAML signing certificate expiring within 30 days), `failing` (no valid certificate or incomplete enabled deployment), and `configured` + `verified: true` (`ok`) when enabled with a valid certificate (>30 days) and a succeeded sign-in or metadata check; `summary` always names protocol and MFA mode (`"Portal MFA always"` / `"MFA claim required"` / `"Entra manages MFA"`).
  - **`sharepoint`**: reads `services.storageConnections.fileSync.statusSummary()` (`/admin/storage` & `/admin/storage/file-sync`) combined with `microsoft_graph` and `microsoft_graph_upload` egress presets and `verifySitesSelectedWrite` probe (`not_configured`, `disabled`, `degraded`, `failing`, and `configured` + `verified: true` / `ok`).
  - **`stripe`**: reads `services.payments.healthCounts()`, `"payments.config"`, and `egress.isPresetEnabled("stripe")` (`/admin/payments/setup`); the legacy `stripe.ts` diagnostic webhook receiver keeps `STRIPE_LEDGER_MUTATION_ENABLED = false` and returns `STRIPE_MANAGED_IN_PAYMENTS` if `enabled: true` is requested directly.
- **`production`** (`P101`, `P201`, and optional `P301` / `P401`) implements fenced outbox webhook delivery per `docs/integrations/PRODUCTION_WEBHOOKS.md` and Increment 04 Part B (Decision B4):
  ```ts
  export type ProductionPhase = "P101" | "P201" | "P301" | "P401";
  export type ProductionDispatchState = "queued" | "sending" | "delivered" | "failed" | "dead" | "unknown";

  export type ProductionDisabledCategory =
    | "pipeline_off"
    | "endpoint_missing"
    | "config_incomplete"
    | "in_progress"
    | "already_delivered"
    | "retry_or_resend_required"
    | "precondition";

  export interface ProductionDisabledReason {
    code: string;
    category: ProductionDisabledCategory;
    message: string;
    /** True when an administrator can resolve this in `/admin/integrations/production`. */
    settingsActionable: boolean;
  }

  export interface ProductionSettingsView {
    enabled: boolean;
    configured: boolean;
    state: ProviderState;
    summary: string;
    p101UrlConfigured: boolean;
    p101UrlMask: MaskedWebhookUrlView | null;
    p201UrlConfigured: boolean;
    p201UrlMask: MaskedWebhookUrlView | null;
    p301UrlConfigured: boolean;
    p301UrlMask: MaskedWebhookUrlView | null;
    p401UrlConfigured: boolean;
    p401UrlMask: MaskedWebhookUrlView | null;
    authHeaderName: string;
    authHeaderValueConfigured: boolean;
    canonVersion: string;
    runMode: string;
    timeoutMs: number;
  }

  export interface UpdateProductionSettingsInput {
    enabled: boolean;
    p101Url?: string | null;
    p201Url?: string | null;
    p301Url?: string | null;
    p401Url?: string | null;
    authHeaderName?: string;
    authHeaderValue?: string | null;
    canonVersion: string;
    runMode?: string;
    timeoutMs?: number;
  }

  export interface ProductionLaterPhasePreview {
    configured: boolean;
    eligible: boolean;
    p101Delivered: boolean;
    prerequisiteDelivered: boolean;
    alreadyDelivered: boolean;
    activeState: ProductionDispatchState | null;
    validationErrors: ProductionValidationIssue[];
    disabledReasons: ProductionDisabledReason[];
    payload: P201Payload | null;
  }

  export interface ProductionOrderPreview {
    featureEnabled: boolean;
    featureConfigured: boolean;
    settingsHref: "/admin/integrations/production";
    p101: {
      configured: boolean;
      eligible: boolean;
      alreadyDelivered: boolean;
      activeState: ProductionDispatchState | null;
      validationErrors: ProductionValidationIssue[];
      disabledReasons: ProductionDisabledReason[];
      payload: P101Payload | null;
      maskedForViewer: boolean;
    };
    p201: {
      configured: boolean;
      eligible: boolean;
      p101Delivered: boolean;
      alreadyDelivered: boolean;
      activeState: ProductionDispatchState | null;
      validationErrors: ProductionValidationIssue[];
      disabledReasons: ProductionDisabledReason[];
      payload: P201Payload | null;
    };
    p301: ProductionLaterPhasePreview;
    p401: ProductionLaterPhasePreview;
  }

  export interface ProductionDispatchItem {
    publicId: string;
    orderPublicId: string;
    orderReference: string;
    phase: ProductionPhase;
    state: ProductionDispatchState;
    attemptCount: number;
    maxAttempts: number;
    idempotencyKey: string;
    payloadSha256: string;
    identityTriple: { customerId: string; orderId: string; runMode: string };
    packet: string | null;
    tier: string | null;
    bundleScopeManifest: string | null;
    releaseStatus: string | null;
    httpStatus: number | null;
    responseSummary: string | null;
    lastReasonCode: string | null;
    resendReason: string | null;
    retryOf: string | null;
    redeliveryOf: string | null;
    requestedByPublicId: string | null;
    correlationId: string;
    createdAt: Date;
    updatedAt: Date;
    deliveredAt: Date | null;
    finalizedAt: Date | null;
  }
  ```
  - **tRPC procedures (`trpc.integrations.production.*`)**:
    - `settings.get` (`adminProcedure`), `settings.update` (`integrations.manage` step-up), `settings.test` (`integrations.manage` step-up, `{ phase: "P101" | "P201" | "P301" | "P401" }`).
    - `order.preview` (`orders.production.trigger` + `orders.assertCanReadOrder`, `{ orderPublicId, releaseStatus? }`) -> `ProductionOrderPreview` with structured `disabledReasons` for every phase (`P101`–`P401`).
    - `order.history` (`orders.production.trigger` + `orders.assertCanReadOrder`, `{ orderPublicId }`) -> `{ items: ProductionDispatchItem[] }`.
    - `order.requestP101` (`orders.production.trigger`, `{ orderPublicId, releaseStatus? }`) -> `ProductionDispatchItem`.
    - `order.requestP201` (`orders.production.trigger`, `{ orderPublicId, phase1ArtifactsConfirmed }`) -> `ProductionDispatchItem`.
    - `order.requestP301` (`orders.production.trigger`, `{ orderPublicId }`) -> `ProductionDispatchItem` (refuses with `NOT_CONFIGURED` / `PRODUCTION_PHASE_ENDPOINT_NOT_CONFIGURED` unless `p301Url` is configured; requires `P101` and `P201` delivered; copies `{ customer_id, order_id, run_mode }` verbatim from delivered `P101`).
    - `order.requestP401` (`orders.production.trigger`, `{ orderPublicId }`) -> `ProductionDispatchItem` (refuses with `NOT_CONFIGURED` / `PRODUCTION_PHASE_ENDPOINT_NOT_CONFIGURED` unless `p401Url` is configured; requires `P101`, `P201`, and — when `p301Url` is configured — `P301` delivered; copies `{ customer_id, order_id, run_mode }` verbatim from delivered `P101`).
    - `order.retry` (`orders.production.trigger`, `{ orderPublicId, dispatchPublicId }`) -> `ProductionDispatchItem` (reconstructs exact original bytes matching `target.payloadSha256` or refuses with `ORDER_SCOPE_CHANGED` / `ORIGINAL_PAYLOAD_UNVERIFIABLE`; refuses with `CONFLICT` / `PRODUCTION_DESTINATION_CHANGED` if the live destination/auth fingerprint differs from the root dispatch; preserves the root delivery's wire `Idempotency-Key` across the `retryOf` chain — including retries of an undelivered `dead`/`failed` redelivery row — and emits `integration.production.dispatch.retried`).
    - `order.redeliver` (`orders.production.redeliver` admin step-up, `{ orderPublicId, dispatchPublicId, reason, confirmation, idempotencyKey }`) -> `ProductionDispatchItem` (server validates `confirmation === "REDELIVER"`, 3–280 char printable `reason`, and `8..64` char `idempotencyKey`; persists keyed intent dedupe so replays of the same `idempotencyKey` return the existing redelivery row without enqueuing a second run; refuses new intents when the latest redelivery for the phase is `dead` via `PRODUCTION_REDELIVERY_RETRY_REQUIRED` or `unknown` via `PRODUCTION_DISPATCH_UNCERTAIN`, when target is not `delivered`, or when exact original bytes cannot be verified against `target.payloadSha256`; creates a NEW queued delivery with `redeliveryOf: dispatchPublicId` + outbound `X-ReadyPackets-Redelivery-Of` header and emits `integration.production.dispatch.redelivered`).
    - `order.resend` (`orders.production.trigger` admin step-up, `{ orderPublicId, phase, reason, releaseStatus?, phase1ArtifactsConfirmed? }`) -> `ProductionDispatchItem` (preserved ONLY for undelivered `unknown`/`dead`/`failed` phase recovery; rejects any phase with a `delivered` row via `CONFLICT` / `PRODUCTION_ALREADY_DELIVERED`; reconstructs exact root payload bytes, reuses the root wire `Idempotency-Key`, and records `destination_changed` in `integration.production.dispatch.resent` without logging URLs).
    - `admin.listDispatches` (`adminProcedure`, `{ phase?, state?, orderReference?, fromDate?, toDate?, limit? }`) -> `{ items: ProductionDispatchItem[] }`.

### 1.7 Outbound Webhook Subscriptions, Inbound Endpoints, Delivery Log & Re-Run (`services.integrations.webhooks`)

Implements Increment 04 Package I (Decisions 10 & 11) in `server/modules/integrations/webhooks/**`. Ships **disabled** (`enabled: false`) by default.

```ts
export type WebhookSubscriptionStatus = "active" | "paused" | "disabled_failing";
export type WebhookDirection = "outbound" | "inbound";
export type WebhookDeliveryStatus =
  | "queued"
  | "delivering"
  | "delivered"
  | "retrying"
  | "failed"
  | "dead"
  | "unknown"
  | "processed"
  | "duplicate"
  | "rejected";

export interface WebhookPublishOptions {
  /** Optional caller deduplication token per subscription (defaults to generated ULID). */
  deduplicationKey?: string;
  correlationId?: string;
  resourceType?: string;
  resourcePublicId?: string;
}

export interface WebhooksService {
  /** Registered with `auditCenter.registerTap(webhooks.auditTap)` in `init()`. */
  readonly auditTap: AuditTap;

  /**
   * Explicit server-side event publication port for domain events not already covered by
   * `TRIGGER_CATALOGUE` (note: catalogue events such as `invoice.paid` from durable
   * `invoice.payment.recorded` are captured automatically via `auditTap` in the caller's `tx`).
   * Redacts payload fields, refuses `staffOnly` trigger keys, and enqueues outbox rows in `tx`
   * when `integrations.webhooks.config.enabled === true`.
   */
  publish(
    eventKey: string,
    payload: Record<string, unknown>,
    options?: WebhookPublishOptions,
    tx?: Tx,
  ): Promise<{ queued: number; deliveryPublicIds: string[] }>;

  /** Read-only provider registered on `services.publicApi.registerProvider("webhookSubscriptions", ...)` in `init()`. */
  listSubscriptionsPublicApi(
    query: ApiListQuery,
    caller: ApiCaller,
  ): Promise<ApiPage<WebhookSubscriptionDto>>;
  getSubscriptionPublicApi(
    publicId: string,
    caller: ApiCaller,
  ): Promise<WebhookSubscriptionDto | null>;

  /** Raw HTTP receiver handler invoked by `createInboundWebhooksHttpRouter(services)`. */
  receiveInboundHttp(input: {
    endpointPublicId: string;
    rawBody: Buffer;
    headers: Record<string, string | undefined>;
    correlationId: string;
    ipAddress?: string | null;
  }): Promise<{
    httpStatus: number;
    body: {
      ok: boolean;
      deliveryId?: string;
      duplicate?: boolean;
      code?: string;
      message?: string;
    };
  }>;
}
```

- **Outbound subscriptions & signing**:
  - Target URLs must use `https:` on port `443`, pass `egress.assertAllowed(url, "webhook")` (`requireAllowlistRule: true`, `publicAddressesOnly: true`, pinned IP resolution, no redirects, no private/loopback/link-local/metadata ranges).
  - Subscribes only to non-`staffOnly` trigger keys from `automations.listTriggerCatalogue()` (`staffOnly` triggers and `personal: true` fields are stripped/refused so internal staff notes and personal fields never leave via generic webhooks).
  - Signing secret (`whsec_<48-hex>`) is generated CSPRNG, returned **once** on creation and rotation, stored encrypted via `FieldCrypto` (AAD bound to row `publicId`), and never returned again (`secretLast4` only).
  - Secret rotation supports a configurable overlap window (`overlapMinutes: 0..1440`, default `60`): while `now < previousSecretExpiresAt`, outbound deliveries send `X-ReadyPackets-Signature: t=<unixSec>,v1=<primaryHmac>,v1=<previousHmac>` over `<unixSec>.<rawJsonBody>`.
  - Outbound headers: `Content-Type: application/json; charset=utf-8`, `User-Agent: ReadyPackets-Webhooks/1.0`, `X-ReadyPackets-Event`, `X-ReadyPackets-Delivery`, `X-ReadyPackets-Timestamp`, `X-ReadyPackets-Signature`, `X-Correlation-Id`, plus `X-ReadyPackets-Replay: 1` on redeliveries.
  - Sustained consecutive terminal failures reaching `autoDisableThreshold` (default `10`) transition the subscription to `disabled_failing` and emit durable `integration.webhook.subscription_auto_disabled`.
- **Inbound endpoints & automation trigger**:
  - Mounted by `http_security_engineer` at `/api/webhooks/inbound` via `createInboundWebhooksHttpRouter(services)` (`POST /:endpointPublicId`).
  - Verifies constant-time HMAC-SHA256 (`timingSafeEqual`) over `<unixSec>.<rawBody>` from `X-ReadyPackets-Signature: t=<unixSec>,v1=<hex>` (accepting primary secret or unexpired overlap secret) and enforces `|now - t| <= toleranceSeconds` (max `300` seconds = ±5 minutes) **before** `JSON.parse`.
  - Deduplicates by `(inboundEndpointId, externalEventId)` (`X-ReadyPackets-Event-Id` or top-level JSON `id`).
  - Verified inbound events **can only start automations**: registers `webhook.inbound_received` (`eventName: "integration.webhook.inbound_received"`, `owner: "integrations"`, `resourceType: "webhook_inbound_endpoint"`, fields `endpoint_public_id`, `endpoint_key`, `event_type`, `external_event_id`, `is_replay`) via `automations.registerAutomationTrigger(...)`.
- **Delivery log, redaction, retention & re-run**:
  - Logs outbound deliveries and inbound events with redacted headers and bodies (`server/observability/redact.ts`), bounded to **64 KiB** (`65_536` bytes), `FieldCrypto` AES-256-GCM encrypted, retained `retentionDays` (`0..90`, default `30`; `0` omits/purges stored bodies immediately and disables replay per ADR 0034).
  - `redeliver` (outbound) and `reprocessInbound` (inbound) require `api.replay` (step-up MFA + in-tx `identity.sessions.assertCurrent`), are durably audited, issue a **new** `deliveryPublicId` (`replayOfPublicId` linked) + `X-ReadyPackets-Replay: 1` (`is_replay: true`), and refuse with `CONFLICT` (`WEBHOOK_BODY_TRUNCATED` / `WEBHOOK_BODY_PURGED`) when the stored body was truncated (> 64 KiB) or purged.

---

## 2. Exact tRPC Procedures & Return Types (`trpc.integrations.*`)

All `admin.*` queries require `adminProcedure`. Step-up mutations re-validate sessions in-transaction via `identity.sessions.assertCurrent`.

- **`publicAnalyticsConfig`**, **`admin.providers`**, **`admin.smtpReadiness`**, **`admin.smtp.*`**, **`admin.graph.*`**, **`admin.analytics.*`**, **`admin.stripe.*`**, **`production.*`** — `admin.saml.*` and `admin.sharepoint.get` planning scaffolds removed in Increment 07; SSO is managed under `identity.sso.*` (`/admin/sso`) and SharePoint/Microsoft 365 file sync under `storageConnections.*` (`/admin/storage`, `/admin/storage/file-sync`).
- **`admin.egress.*`** — `purpose` accepts all 15 `EGRESS_PURPOSES` (including `"square"`); `presetKey` accepts all 12 `EGRESS_PRESET_KEYS` (including `"stripe"`, `"square"`, `"square_sandbox"`, gated by `integrations.manage` or `payments.manage`).
- **`admin.webhooks.settings.get`** (`query`, `adminProcedure`) -> `WebhooksSettingsView` (`{ enabled, retentionDays, autoDisableThreshold, deliveryTimeoutMs }`)
- **`admin.webhooks.settings.update`** (`mutation`, `webhooks.manage` step-up) -> `WebhooksSettingsView`
- **`admin.webhooks.catalogue`** (`query`, `adminProcedure`) -> `WebhookCatalogueEventView[]` (non-`staffOnly` trigger keys, labels, groups, descriptions)
- **`admin.webhooks.subscriptions.list`** (`query`, `adminProcedure`) -> `{ items: WebhookSubscriptionView[]; nextCursor: string | null }`
- **`admin.webhooks.subscriptions.get`** (`query`, `adminProcedure`) -> `WebhookSubscriptionView`
- **`admin.webhooks.subscriptions.create`** (`mutation`, `webhooks.manage` step-up) -> `{ subscription: WebhookSubscriptionView; signingSecretOnce: string }`
- **`admin.webhooks.subscriptions.update`** (`mutation`, `webhooks.manage` step-up) -> `WebhookSubscriptionView`
- **`admin.webhooks.subscriptions.setPaused`** (`mutation`, `webhooks.manage` step-up) -> `WebhookSubscriptionView`
- **`admin.webhooks.subscriptions.rotateSecret`** (`mutation`, `webhooks.manage` step-up) -> `{ subscription: WebhookSubscriptionView; signingSecretOnce: string }`
- **`admin.webhooks.subscriptions.testDelivery`** (`mutation`, `webhooks.manage` step-up, `expensive` rate limit) -> `WebhookDeliveryDetailView`
- **`admin.webhooks.subscriptions.remove`** (`mutation`, `webhooks.manage` step-up) -> `{ deleted: true }`
- **`admin.webhooks.inbound.list`** (`query`, `adminProcedure`) -> `{ items: WebhookInboundEndpointView[]; nextCursor: string | null }`
- **`admin.webhooks.inbound.get`** (`query`, `adminProcedure`) -> `WebhookInboundEndpointView`
- **`admin.webhooks.inbound.create`** (`mutation`, `webhooks.manage` step-up) -> `{ endpoint: WebhookInboundEndpointView; signingSecretOnce: string }`
- **`admin.webhooks.inbound.update`** (`mutation`, `webhooks.manage` step-up) -> `WebhookInboundEndpointView`
- **`admin.webhooks.inbound.setEnabled`** (`mutation`, `webhooks.manage` step-up) -> `WebhookInboundEndpointView`
- **`admin.webhooks.inbound.rotateSecret`** (`mutation`, `webhooks.manage` step-up) -> `{ endpoint: WebhookInboundEndpointView; signingSecretOnce: string }`
- **`admin.webhooks.inbound.remove`** (`mutation`, `webhooks.manage` step-up) -> `{ deleted: true }`
- **`admin.webhooks.deliveries.list`** (`query`, `adminProcedure`) -> input `{ direction?, subscriptionPublicId?, inboundEndpointPublicId?, eventKey?, status?, from?, to?, correlationId?, search?, cursor?, limit? }` -> `{ items: WebhookDeliveryListItemView[]; nextCursor: string | null }`
- **`admin.webhooks.deliveries.get`** (`query`, `adminProcedure`) -> `WebhookDeliveryDetailView` (includes redacted/decrypted headers & bodies if not purged + `attempts: WebhookDeliveryAttemptView[]`)
- **`admin.webhooks.deliveries.redeliver`** (`mutation`, `api.replay` step-up, `expensive` rate limit) -> `WebhookDeliveryDetailView`
- **`admin.webhooks.deliveries.reprocessInbound`** (`mutation`, `api.replay` step-up, `expensive` rate limit) -> `WebhookDeliveryDetailView`

---

## 3. Raw HTTP Routes

- `server/modules/integrations/http.ts` (`registerSignedIntegrationWebhooks`, unchanged):
  - `POST /api/integrations/webhooks/stripe` — legacy inert diagnostic receiver (`STRIPE_INERT_DIAGNOSTIC_RECEIVER`; active Stripe payment webhooks are handled by `server/modules/payments`).
- `server/modules/integrations/webhooks/http.ts` (mounted by `http_security_engineer` at `/api/webhooks/inbound`):
  - `export function createInboundWebhooksHttpRouter(services: Services): Router` (`Router({ caseSensitive: true, strict: true })`).
  - `POST /:endpointPublicId` — expects raw `Buffer` on `req.body` (max 256 KiB, no decompression, no session/CSRF/CORS), verifies HMAC-SHA256 signature and ±5m timestamp before JSON parse, deduplicates event ID, logs redacted encrypted envelope, and triggers automations only.

---

## 4. Audit Events, Health Components & Tables

- **New Increment 04 audit events**:
  - `integration.production.dispatch.retried`, `integration.production.dispatch.redelivered` (plus `orderPublicId` linkage across all order-scoped `integration.production.dispatch.*` events)
  - `integration.webhooks.settings_updated`
  - `integration.webhook.subscription_created`, `integration.webhook.subscription_updated`, `integration.webhook.subscription_paused`, `integration.webhook.subscription_resumed`, `integration.webhook.subscription_secret_rotated`, `integration.webhook.subscription_deleted`, `integration.webhook.subscription_auto_disabled`, `integration.webhook.subscription_tested`
  - `integration.webhook.delivered`, `integration.webhook.delivery_failed`, `integration.webhook.redelivered`
  - `integration.webhook.inbound_created`, `integration.webhook.inbound_updated`, `integration.webhook.inbound_secret_rotated`, `integration.webhook.inbound_deleted`, `integration.webhook.inbound_received`, `integration.webhook.inbound_rejected`, `integration.webhook.inbound_reprocessed`
- **Health components**: adds `integrations.webhooks` (`disabled` when off, `healthy` / `degraded` when on).
- **Additive Increment 04 tables & columns (`server/modules/integrations/schema.ts`)**:
  - `integration_webhook_subscriptions`
  - `integration_webhook_inbound_endpoints`
  - `integration_webhook_deliveries`
  - `integration_webhook_delivery_attempts`
  - `integration_production_dispatches.retry_of_public_id` (`varchar(26)` nullable) and `integration_production_dispatches.redelivery_of_public_id` (`varchar(26)` nullable, indexed via `idx_prod_dispatch_redelivery_of`)

---

## Increment 07 — Package K (Decision D7: Outbound Webhooks, Phase Triggers, Egress Presets & Microsoft Graph)

### 1. `services.integrations.workflowWebhooks` (`WorkflowWebhooksService`, `server/modules/integrations/workflowWebhooks/types.ts`)

- **`listOptions(input?: { kind?: "all" | "production" | "subscription" }, tx?: DbOrTx): Promise<WorkflowWebhookOptionView[]>`**
  - Returns safe selector options (`targetKey` matching `STAGE_WEBHOOK_TARGET = /^(production:P[1-4]01|subscription:[0-9A-HJKMNP-TV-Z]{26})$/`, `kind`, `phase`, `subscriptionPublicId`, `label`, `configured`, `enabled`, `signingEnabled`, `portableRef`). Never returns URLs, hosts, or secrets.
- **`listOptionsForActor(principal, input?)`** — capability-checked (`workflows.manage`, `automations.read`, `orders.stage.run`, `integrations.manage`, or `webhooks.manage`).
- **`validateTargetKey(targetKey: string | null | undefined, tx?: DbOrTx): Promise<WorkflowWebhookValidationResult>`**
  - Called by `orders` at workflow draft save/publish and by `automations` on rule save (`webhook.enqueue_subscription`).
  - Blank/`null` returns `{ valid: true, normalizedKey: null, kind: null, exists: true, configured: true, enabled: true, reasonCode: null, message: null, portableRef: null }`.
  - Validates format (`STAGE_WEBHOOK_TARGET`), subscription existence, and endpoint configuration status.
- **`resolvePortableTargetRef(portableRef, tx?)`** — maps portable logical keys (`"production:P101"`..`"production:P401"` or subscription name) back to local `targetKey` on workflow import.
- **`enqueueStageWebhook(input: EnqueueStageWebhookInput, tx?: Tx): Promise<EnqueueStageWebhookResult>`**
  - Supports both `production:P101..P401` and `subscription:<publicId>` for stage bundles (`triggerSource: "stage_bundle"`), lifecycle auto-queue (`"lifecycle_payment_confirmed"` | `"lifecycle_phase1_locked"`), and automation rule actions (`"automation_rule"`).
  - Enforces delivered `P101` + Phase 1 lock on `P201` across **all** trigger paths.
  - Returns `{ outcome: "queued" | "already_queued_or_delivered" | "refused_precondition" | "disabled", kind, deliveryPublicId, dispatchPublicId, reasonCode, message }`. Unmet preconditions never throw to roll back customer payment or stage submission.
- **Lifecycle auto-queue (opt-in per workflow, off by default)**:
  - `listLifecycleAutoQueuePolicies`, `getLifecycleAutoQueuePolicy(workflowKey)`, `setLifecycleAutoQueuePolicy(principal, { workflowKey, p101OnPaymentConfirmed, p201OnPhase1Locked })` (audited via `integration.production.workflow_auto_queue_updated`).
  - When enabled for an order's workflow, `AuditTap` enqueues `P101` in-tx when `order.payment_state.changed` transitions to `"paid"` and `P201` in-tx when `order.stage.submitted` locks Phase 1 intake.

### 2. tRPC Additions & Updates (`trpc.integrations.*`)

- **`workflowWebhooks.listOptions`** (`query`, `staffProcedure`: `workflows.manage` | `automations.read` | `orders.stage.run` | `integrations.manage` | `webhooks.manage`) -> input `{ kind?: "all" | "production" | "subscription" }` -> `WorkflowWebhookOptionView[]` (consumed by `PhaseWebhookSlot` and automation rule editor; never exposes URLs, hosts, or secrets).
- **`production.workflowAutoQueue.list`** (`query`, `adminProcedure`) -> `{ items: WorkflowAutoQueueItemView[] }`.
- **`production.workflowAutoQueue.set`** (`mutation`, `manageProcedure` step-up) -> input `{ workflowPublicId?: string; workflowKey?: string; p101OnPaymentConfirmed: boolean; p201OnPhase1Locked: boolean }` -> `{ items: WorkflowAutoQueueItemView[] }`.
- **`production.rotateSigningSecret`** & **`production.settings.rotateSigningSecret`** (`mutation`, `manageProcedure` step-up) -> input `{ overlapMinutes?: number }` (`0..1440`, default `60`) -> `{ settings: ProductionSettingsView; signingSecretOnce: string }`.
- **`production.setSigningEnabled`** & **`production.settings.setSigningEnabled`** (`mutation`, `manageProcedure` step-up) -> input `{ signingEnabled: boolean }` -> `ProductionSettingsView` (optional `whsec_...` HMAC-SHA256 signing via `X-ReadyPackets-Signature: t=<unix>,v1=<hex>` with overlap rotation; folded into `destinationFingerprint`).
- **`production.order.stop`** & **`production.stopDispatch`** (`mutation`, `staffProcedure`: `orders.production.trigger` or `integrations.manage`) -> input `{ orderPublicId: string; dispatchPublicId: string; reason?: string }` -> `ProductionDispatchItem` (`state = "stopped"`, cancels `job_runs` under job fence). Stopped dispatches are retryable via `production.order.retry` / `production.retryDispatch` (`OPERATOR_RETRY_AFTER_STOP`).
- **`admin.webhooks.subscriptions.create` / `update`** -> adds optional `signingEnabled?: boolean` (default `true`; when `false`, omits `X-ReadyPackets-Signature`).
- **`admin.webhooks.deliveries.list`** -> adds `orderPublicId?: string` filter and `"stopped"` status filter.
- **`admin.webhooks.deliveries.stop`** (`mutation`, `webhooks.manage` or `api.replay`) -> input `{ publicId: string; reason?: string }` -> `WebhookDeliveryDetailView` (`status = "stopped"`, cancels `job_runs`).
- **`admin.webhooks.deliveries.retry`** (`mutation`, `webhooks.manage` or `api.replay`, `expensive` rate limit) -> input `{ publicId: string }` -> `WebhookDeliveryDetailView` (retries an eligible `failed` / `dead` / `stopped` outbound delivery along the **same** delivery record with `manualRetryCount + 1` and zero `X-ReadyPackets-Replay` header, distinct from `redeliver` which creates a new replay record with `X-ReadyPackets-Replay: 1`).
- **`admin.egress.presets` / `admin.egress.setPreset`** -> preset query & mutation (`presetKey: "stripe" | "square" | "square_sandbox" | "microsoft_graph" | "microsoft_graph_upload" | ...`, `stepUpRequiredIf(enabled === true)`), surfaced as visible one-click switches on `/admin/integrations/egress` and reusable by `/admin/payments/setup` (`payments.manage`) and `/admin/storage` (`storage.manage`).
- **`admin.graph.verifySitesSelectedWrite`** (`mutation`, `integrations.manage` or `storage.manage` with step-up, `expensive` rate limit) -> input `{ siteUrlOrId?: string; driveId?: string; probeFolderPath?: string }` -> `GraphSitesSelectedCheckResult` (verifies both `microsoft_graph` and `microsoft_graph_upload` egress presets, Entra OAuth token acquisition, site/drive `GET`, and non-destructive `createUploadSession` + immediate `DELETE` cancel without leaving marker files, updating the `sharepoint` provider readiness check).
- **`admin.graph.entraRunbook`** (`query`, `adminProcedure`) -> `GraphEntraRunbookView` (structured least-privilege `Sites.Selected` setup steps, PowerShell `New-MgSitePermission` example, Graph API `POST /v1.0/sites/{siteId}/permissions` example, and discouraged broad permissions).

### 3. Client Slot & UI Ownership (`client/src/features/integrations/**`)

- `export function PhaseWebhookSlot(props: PhaseSlotProps<string | null>): JSX.Element` (`client/src/features/integrations/phaseSlots.tsx`) — renders labelled `"Webhook trigger"` selector backed by `trpc.integrations.workflowWebhooks.listOptions` without URLs or secrets (Increment 07 client Step B owned by `siem_engineer`).

### 4. Additive Increment 07 Schema & Audit Events

- **`integration_production_dispatches`**: `trigger_source` (`varchar(32) not null default 'manual'`), `stage_key` (`varchar(64)`), `stopped_at` (`datetime(3)`), `stopped_by_user_id` (`bigint unsigned`), `stopped_by_public_id` (`varchar(26)`), `stop_reason` (`varchar(280)`).
- **`integration_webhook_subscriptions`**: `signing_enabled` (`boolean not null default true`).
- **`integration_webhook_deliveries`**: `order_public_id` (`varchar(26)`), `stage_key` (`varchar(64)`), `manual_retry_count` (`int unsigned not null default 0`), `stopped_at` (`datetime(3)`), `stopped_by_user_id` (`bigint unsigned`), `stopped_by_public_id` (`varchar(26)`), `stop_reason` (`varchar(280)`), index `idx_webhook_delivery_order_created (order_public_id, created_at, id)`.
- **New audit events**: `integration.production.signing_updated`, `integration.production.signing_secret_rotated`, `integration.production.workflow_auto_queue_updated`, `integration.production.dispatch.stopped`, `integration.production.dispatch.refused`, `integration.webhook.delivery_stopped`, `integration.webhook.delivery_retried`, `integration.graph.sites_selected_checked`.

