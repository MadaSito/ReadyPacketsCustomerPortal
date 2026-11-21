# `server/modules/integrations` — Public API & Contract

Owner: `integrations_engineer` (`server/modules/integrations/**`, `client/src/features/integrations/consent.tsx`, `client/src/features/integrations/routes.tsx`; admin pages under `client/src/features/integrations/admin/**` owned by `identity_engineer`).

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

- **Mandatory cloud-purpose policy (`graph`, `graph_upload`, `entra_oidc`, `storage_s3`, `storage_azure`, `storage_dropbox`, `storage_gdrive`)**:
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
  - Parameterized exact-host storage presets (never wildcard `*.amazonaws.com` or `*.blob.core.windows.net`):
    - `amazon_s3` (`purpose: "storage_s3"`, `{ region, bucket? }`): `s3.<region>.amazonaws.com` (+ `<bucket>.s3.<region>.amazonaws.com` when `bucket` supplied)
    - `wasabi_s3` (`purpose: "storage_s3"`, `{ region, bucket? }`): `s3.<region>.wasabisys.com` (+ `<bucket>.s3.<region>.wasabisys.com` when `bucket` supplied)
    - `backblaze_b2` (`purpose: "storage_s3"`, `{ region, bucket? }`): `s3.<region>.backblazeb2.com` (+ `<bucket>.s3.<region>.backblazeb2.com` when `bucket` supplied)
    - `azure_blob` (`purpose: "storage_azure"`, `{ accountName }`): `<accountName>.blob.core.windows.net`
  - Custom S3-compatible endpoints use `egress.createAllowlistRule` with `purpose: "storage_s3"`, `matchType: "host"`, `protocol: "https:"`, `port: 443`, `allowPrivateAddress: false`.
  - `setPresetEnabled` authorizes administrators holding `integrations.manage` or the matching domain step-up capability (`mail.manage`, `storage.manage`, or `identity.sso.manage`), re-validated in-transaction via `identity.sessions.assertCurrent(principal, tx)`.

### 1.2 Microsoft Graph Core & Graph Mail (`services.integrations.graph`, `services.integrations.graphAdmin`, `services.integrations.createScopedGraphClient`)

Single Microsoft Graph client implementation (`server/modules/integrations/graph/**`) shared exclusively by Graph Mail, SharePoint document libraries / list sync, and OneDrive for Business.

```ts
export interface GraphCredentialsInput {
  /** Single-tenant Entra directory GUID only (`common`, `organizations`, `consumers` refused). */
  tenantId: string;
  /** Entra application (client) GUID. */
  clientId: string;
  clientSecret: string;
  /** Optional caller version tag bound into the token-cache isolation key. */
  credentialVersion?: string | number;
}

export interface GraphRequestInput {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Relative v1.0 Graph path starting with `/` (e.g. `"/sites/root"`, `"/users/ops%40example.com/sendMail"`). */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}

export interface GraphResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  rawBody: Buffer;
  json<U = T>(): U;
}

export interface GraphUploadChunkInput {
  /** Pre-authenticated capability URL returned by Graph `createUploadSession` (`https:` on 443). */
  uploadUrl: string;
  bytes: Uint8Array;
  /** e.g. `"bytes 0-327679/1048576"` */
  contentRange: string;
  /** Optional additional host/suffix lineage restriction (e.g. `[siteHostname, "files.1drv.com"]`). */
  allowedHostSuffixes?: readonly string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface GraphUploadChunkResult {
  status: number;
  headers: Record<string, string>;
  rawBody: Buffer;
  json<T = unknown>(): T | null;
}

export class GraphApiError extends DomainError {
  readonly status: number | null;
  readonly graphCode: string | null;
  readonly retryable: boolean;
  /** True only when the target Graph request may already have been transmitted over the wire. */
  readonly requestSent: boolean;
}

export interface GraphClient {
  isConfigured(): Promise<boolean>;
  request<T = unknown>(input: GraphRequestInput): Promise<GraphResponse<T>>;
  uploadChunk(input: GraphUploadChunkInput): Promise<GraphUploadChunkResult>;
}
```

- **Token acquisition & isolation**:
  - `POST https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token` (`grant_type=client_credentials`, `scope=https://graph.microsoft.com/.default`) via `egress.fetchPinned(..., "graph")`.
  - Single-tenant GUID strictly enforced (`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`); `common`, `organizations`, and `consumers` are explicitly rejected.
  - Access tokens are cached in volatile memory until `expires_in - 60s` (`deps.clock.now()`), isolated per `sha256(tenantId + ":" + clientId + ":" + credentialVersion + ":" + sha256(clientSecret))`, coalesced single-flight per key, cleared on credential/config change and `stop()`, and **never** logged, audited, or included in thrown errors.
- **`createScopedGraphClient(credentials?: GraphCredentialsInput): GraphClient`**:
  - When `credentials` is provided (e.g. decrypted per-connection SharePoint/OneDrive credentials), binds a `GraphClient` to those credentials while sharing the module's egress policy and isolated token cache. When omitted, returns `services.integrations.graph` (the installation Graph configuration).
- **`uploadChunk` capability-URL safety (§4.1)**:
  - Uses `purpose: "graph_upload"`, enforces host lineage (`*.sharepoint.com` or `*.files.1drv.com`, narrowed further by `allowedHostSuffixes` when supplied), strips/forbids `Authorization` and `Cookie`, and never logs `uploadUrl` paths or query strings.
- **Graph Mail Transport (`key: "graph"`)**:
  - Registered during `IntegrationsModule.init()` via `deps.services.jobAdmin.registerMailTransport(graphMailTransport)`.
  - Calls `POST /v1.0/users/{encodeURIComponent(mailbox)}/sendMail` (`saveToSentItems: false`, application permission `Mail.Send`), using `senderMailbox` if configured on Graph settings or `MailTransportMessage.sender.fromAddress`.
  - Outcome classification per Decision 8:
    - Disabled / incomplete settings / `microsoft_graph` egress preset off -> `{ outcome: "not_configured", safeDetail: "graph_not_configured" }`.
    - Pre-send token failure, DNS/egress denial, or explicit Graph `4xx` rejection (`400`/`401`/`403`/`404` `retryable: false`, `429` `retryable: true`) -> `{ outcome: "rejected", retryable, safeDetail }` (safe for secondary failover).
    - HTTP `202` / `200` / `204` -> `{ outcome: "accepted", safeDetail: "graph_accepted" }`.
    - Mid-flight timeout, connection drop, or `5xx` gateway ambiguity on `POST /sendMail` (`requestSent === true`) -> `{ outcome: "unknown", safeDetail: "graph_delivery_uncertain" }` (**never** replayed and **never** failed over).
- **Restricting `Mail.Send` to a single mailbox in Exchange Online (operator guidance)**:
  - Microsoft Graph `Mail.Send` application permission is tenant-wide by default unless scoped in Exchange Online RBAC for Applications:
    1. Connect via `Connect-ExchangeOnline`.
    2. Register the Entra enterprise app's service principal in Exchange Online: `New-ServicePrincipal -AppId <ClientAppId> -ObjectId <EnterpriseAppServicePrincipalObjectId> -DisplayName "ReadyPackets Portal Graph Mail"`.
    3. Create a management scope targeting only the dedicated sender mailbox: `New-ManagementScope -Name "ReadyPacketsSenderMailboxOnly" -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'noreply@yourdomain.example'"`.
    4. Assign `Application Mail.Send` restricted to that scope: `New-ManagementRoleAssignment -Name "ReadyPacketsGraphMailSendScoped" -App <ClientAppId> -Role "Application Mail.Send" -CustomResourceScope "ReadyPacketsSenderMailboxOnly"`.
    5. Verify with `Test-ServicePrincipalAuthorization -Identity <ClientAppId> -Resource another-user@yourdomain.example` (`InScope: False`).

### 1.3 Outbound SMTP Transport (`services.integrations.smtp`)

- Enforces TLS (`tlsMode: "starttls" | "implicit"`, `rejectUnauthorized: true`, `minVersion: "TLSv1.2"`, plaintext port 25 unconditionally forbidden with `SMTP_PORT_25_FORBIDDEN`), pins sockets through `egress.assertAllowed(..., "smtp")`, and rejects CRLF/NUL header injection across `sender`, `to`, and `subject`.
- `SmtpSendInput` accepts optional `sender?: MailSenderIdentity` (`{ fromAddress, fromName, replyToAddress? }`) from `jobs` mail engine, falling back to legacy `integrations.smtp.config` sender fields when omitted.
- Exposes `smtp.getDefaultSender(): Promise<MailSenderIdentity | null>` (legacy fallback for existing upgrades) and treats SMTP as complete/ready when sender identity is configured either in `jobs` shared sender settings or in `integrations.smtp.config`.
- Both `smtp.sendTestMessage(principal, input?)` and `graphAdmin.sendTestMessage(principal)` send test mail **exclusively to the signed-in administrator's own email address** (`deps.services.identity.getUser(principal.userId)`). Passing any third-party `toAddress` is refused with `FORBIDDEN / TEST_RECIPIENT_MUST_BE_SELF`.

### 1.4 Provider Registry & Health (`services.integrations.providers`)

```ts
export type ProviderKey = "smtp" | "graph" | "clarity" | "posthog" | "stripe" | "saml" | "sharepoint";
export type ProviderState = "disabled" | "not_configured" | "configured" | "degraded" | "failing";
```

### 1.5 Consent-Gated Public-Route Analytics (`services.integrations.analytics` & `consent.tsx`)

- Disabled by default; exact route allowlist `["/privacy", "/terms"]` with clean query/hash and anonymous visitor session.
- Clarity project ID `^[A-Za-z0-9]{6,32}$`; PostHog token `^phc_[A-Za-z0-9_]{12,176}$`; PostHog host restricted to `https://us.i.posthog.com`, `https://eu.i.posthog.com`, or an admin-allowlisted exact HTTPS origin.

### 1.6 Disabled Scaffolds (`stripe`, `saml`, `sharepoint`) & Production Webhooks (`production`)

- **`stripe`**, **`saml`**, **`sharepoint`** remain disabled scaffolds as documented in Increment 01/02 (`STRIPE_LEDGER_MUTATION_ENABLED = false`).
- **`production`** (`P101` & `P201`) implements fenced outbox webhook delivery per `docs/integrations/PRODUCTION_WEBHOOKS.md`.

---

## 2. Exact tRPC Procedures & Return Types (`trpc.integrations.*`)

All `admin.*` queries require `adminProcedure`. Mail mutations (`admin.smtp.*`, `admin.graph.*`) accept administrators holding either `integrations.manage` or `mail.manage` (both step-up MFA capabilities, re-validated inside every DB transaction via `identity.sessions.assertCurrent`).

- **`publicAnalyticsConfig`** (`query`, public) -> `PublicAnalyticsConfig`
- **`admin.providers`** (`query`) -> `ProviderStatus[]` (`smtp`, `graph`, `clarity`, `posthog`, `stripe`, `saml`, `sharepoint`)
- **`admin.smtpReadiness`** (`query`) -> `SmtpReadiness`
- **`admin.smtp.get`** (`query`) -> `SmtpConfigView` (`{ enabled, configured, verified, state, summary, host, port, tlsMode, username, passwordConfigured, passwordLast4: string | null, fromAddress, fromName, replyToAddress, lastCheckedAt, lastOutcome }`)
- **`admin.smtp.update`** (`mutation`, step-up) -> input `{ enabled, host, port, tlsMode, username, password?: string | null, fromAddress?, fromName?, replyToAddress? }` -> `SmtpConfigView`
- **`admin.smtp.sendTest`** (`mutation`, step-up, `expensive` rate limit) -> input `{ toAddress?: string }` (optional; if omitted sends to signed-in admin; if supplied must match signed-in admin email) -> `SmtpTestResult` (`{ outcome: "accepted"|"rejected"|"unknown", reasonCode, safeMessage, recipientAddress, durationMs, checkedAt }`)
- **`admin.graph.get`** (`query`) -> `GraphConfigView` (`{ enabled, configured, verified, state, summary, tenantId, clientId, clientSecretConfigured: boolean, clientSecretLast4: string | null, senderMailbox: string, egressPresetEnabled: boolean, lastCheckedAt: Date | null, lastOutcome: "succeeded"|"failed"|"unknown"|null }`)
- **`admin.graph.update`** (`mutation`, step-up) -> input `{ enabled: boolean, tenantId: string, clientId: string, clientSecret?: string | null, senderMailbox?: string, enableEgressPreset?: boolean }` -> `GraphConfigView`
- **`admin.graph.testConnection`** (`mutation`, step-up, `expensive` rate limit) -> input `{}` -> `GraphTestResult` (`{ outcome: "succeeded"|"failed", reasonCode, safeMessage, durationMs, checkedAt }`)
- **`admin.graph.sendTest`** (`mutation`, step-up, `expensive` rate limit) -> input `{}` (sends exclusively to signed-in administrator) -> `GraphMailTestResult` (`{ outcome: "accepted"|"rejected"|"unknown", reasonCode, safeMessage, recipientAddress, durationMs, checkedAt }`)
- **`admin.egress.list`** (`query`) -> `EgressAllowlistRuleView[]`
- **`admin.egress.presets`** (`query`) -> `EgressPresetView[]`
- **`admin.egress.setPreset`** (`mutation`, step-up) -> input `{ presetKey: EgressPresetKey, enabled: boolean, params?: { region?: string; bucket?: string; accountName?: string } }` -> `EgressPresetView`
- **`admin.egress.create`**, **`admin.egress.update`**, **`admin.egress.remove`**, **`admin.egress.check`** — unchanged (`purpose` accepts all 13 `EGRESS_PURPOSES`)
- **`admin.analytics.*`**, **`admin.stripe.*`**, **`admin.saml.*`**, **`admin.sharepoint.get`**, **`production.*`** — unchanged from Increment 01/02.

---

## 3. Raw HTTP Routes (`server/modules/integrations/http.ts`)

- `POST /api/integrations/webhooks/stripe` — verifies `Stripe-Signature`, durably logs inert received event (`status = "ignored"`, `ledgerMutated = false`).

---

## 4. Audit Events, Health Components & Tables

- **Audit events**:
  - `integration.smtp.updated`, `integration.smtp.test_attempted`, `integration.smtp.tested`
  - `integration.graph.updated`, `integration.graph.connection_test_attempted`, `integration.graph.connection_tested`, `integration.graph.test_attempted`, `integration.graph.tested`
  - `integration.egress.preset_updated`, `integration.egress.rule_created`, `integration.egress.rule_updated`, `integration.egress.rule_deleted`, `integration.egress.denied`, `integration.egress.checked`
  - `integration.analytics.updated`, `integration.stripe.*`, `integration.saml.*`, `integration.production.*`
- **Health components**: `mail.smtp`, `mail.graph`, `integrations.clarity`, `integrations.posthog`, `integrations.stripe`, `integrations.saml`, `integrations.sharepoint`, `integrations.production`
- **Tables** (no schema migration required — existing tables cover all Increment 03 columns):
  - `integration_egress_allowlist`, `integration_provider_checks`, `integration_webhook_events`, `integration_production_dispatches`
