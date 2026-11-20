# Optional Integrations, Egress Policy & Consent-Gated Analytics API

Owner: `integrations_engineer`  
Owned paths: `server/modules/integrations/**`, `client/src/features/integrations/**`

All external providers are **optional, OFF by default, and truthfully reported**. Nothing is reported as `"ok"` in health probes unless a real check succeeded.

---

## 1. Public Service Interface (`services.integrations: IntegrationsModule`)

Defined in `server/modules/integrations/index.ts`.

### 1.1 Egress / SSRF Policy (`services.integrations.egress`)

```ts
export const EGRESS_PURPOSES = ["siem", "smtp", "webhook", "sharepoint", "stripe", "antivirus"] as const;
export type EgressPurpose = (typeof EGRESS_PURPOSES)[number];
export type EgressProtocol = "https:" | "tls:" | "smtp:" | "smtps:";

export type EgressTargetInput =
  | string
  | URL
  | {
      host: string;
      port: number;
      protocol?: EgressProtocol;
    };

export interface PinnedEgressTarget {
  /** Normalized ASCII/punycode hostname (lowercase, no brackets, no trailing dot) or normalized IP literal. */
  hostname: string;
  port: number;
  protocol: EgressProtocol;
  /** Pinned DNS-resolved IP address to connect to directly (prevents DNS rebinding). */
  address: string;
  family: 4 | 6;
  /** TLS SNI servername when connecting to `address` (undefined when `hostname` is an IP literal). */
  servername?: string;
  /** Canonical URL string when `target` was passed as a URL/string. */
  normalizedUrl?: string;
  /** Public ID of matching admin allowlist rule when permitted by explicit exception. */
  allowlistRulePublicId?: string;
}

export interface ResolveEgressInput {
  url: string;
  purpose: EgressPurpose;
  allowedSchemes?: readonly string[];
  /** Only honored for `purpose === "siem"` when destination was step-up approved; metadata/link-local/multicast remain blocked. */
  allowApprovedPrivate?: boolean;
}

export interface EgressFetchOptions {
  method?: "GET" | "HEAD" | "POST" | "PUT";
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}

export interface EgressFetchResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface EgressPolicy {
  assertAllowed(target: EgressTargetInput, purpose: EgressPurpose): Promise<PinnedEgressTarget>;
  resolveAndAssertAllowed(input: ResolveEgressInput): Promise<PinnedEgressTarget>;
  fetchPinned(url: string | URL, purpose: EgressPurpose, options?: EgressFetchOptions): Promise<EgressFetchResponse>;
  listAllowlist(): Promise<EgressAllowlistRuleView[]>;
  createAllowlistRule(principal: SessionPrincipal, input: CreateEgressRuleInput): Promise<EgressAllowlistRuleView>;
  updateAllowlistRule(principal: SessionPrincipal, input: UpdateEgressRuleInput): Promise<EgressAllowlistRuleView>;
  deleteAllowlistRule(principal: SessionPrincipal, publicId: string): Promise<void>;
}
```

**Security guarantees:**
- Rejects URL userinfo (`user:pass@host`), non-allowlisted schemes/ports per purpose, `.localhost`/`.local`/`.internal` names, decimal/octal/hex/shorthand IPv4 host tricks (`2130706433`, `0177.0.0.1`, `0x7f.0.0.1`, `127.1`).
- Resolves ALL A/AAAA DNS records and validates **every** returned address (mixed public + private DNS records are refused).
- Blocks loopback (`127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16`, `fe80::/10`), private RFC 1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), RFC 4193 ULA (`fc00::/7`), CGNAT (`100.64.0.0/10`), multicast (`224.0.0.0/4`, `ff00::/8`), broadcast, unspecified (`0.0.0.0`, `::`), documentation/benchmarking ranges, cloud metadata (`169.254.169.254`, `169.254.170.2`, `100.100.100.200`, `fd00:ec2::254`), and IPv4-mapped/compatible/NAT64/6to4/Teredo IPv6 embeddings.
- Private RFC 1918 / RFC 4193 / CGNAT addresses and non-default ports are permitted **only** when explicitly authorized by an administrator allowlist rule for that `(purpose, host/IP/CIDR, port, protocol)` (step-up protected + durably audited in-tx). Cloud metadata, link-local, multicast, broadcast, unspecified, and production loopback are **never** allowed even via allowlist.
- `fetchPinned` connects directly to the pinned IP with TLS SNI = `servername`, certificate validation enabled, bounded response size, and **no redirect following** (`3xx` throws `DomainError("FORBIDDEN", "EGRESS_REDIRECT_REFUSED", ...)`).

### 1.2 Provider Registry (`services.integrations.providers`)

```ts
export const PROVIDER_KEYS = ["smtp", "clarity", "posthog", "stripe", "saml", "sharepoint"] as const;
export type ProviderKey = (typeof PROVIDER_KEYS)[number];
export type ProviderState = "disabled" | "not_configured" | "configured" | "degraded" | "failing";

export interface ProviderStatus {
  key: ProviderKey;
  name: string;
  state: ProviderState;
  verified: boolean;
  scaffoldOnly: boolean;
  lastCheckedAt: Date | null;
  summary: string;
}
```

### 1.3 Outbound SMTP (`services.integrations.smtp`)

```ts
export interface SmtpReadiness {
  enabled: boolean;
  configured: boolean;
  verified: boolean;
  ready: boolean;
  state: ProviderState;
  summary: string;
}

export interface SmtpSendInput {
  to: string;
  subject: string;
  text: string;
  html: string;
  signal: AbortSignal;
}

export interface SmtpSendResult {
  outcome: "accepted" | "not_configured" | "rejected" | "unknown";
  retryable?: boolean;
}

services.integrations.smtp.getReadiness(): Promise<SmtpReadiness>;
services.integrations.smtp.send(input: SmtpSendInput): Promise<SmtpSendResult>;
```

- Requires TLS (`tlsMode: "starttls" | "implicit"`, TLS >= 1.2, `rejectUnauthorized: true`; plaintext auth/delivery is refused).
- Connects to pinned address from `egress.assertAllowed(..., "smtp")` with TLS `servername` set to the configured SMTP hostname.
- Sanitizes/rejects CR/LF/NUL control characters in `to`, `from`, `replyTo`, and `subject` (header-injection defense).
- Credentials stored exclusively via `deps.settings.setSecret` (`integrations.smtp.password`), write-only in UI.

### 1.4 Consent-Gated Public-Route Analytics (`services.integrations.analytics` & `analyticsCsp`)

```ts
export interface AnalyticsCspPolicy {
  readonly scriptSrc?: readonly string[];
  readonly connectSrc?: readonly string[];
}

export interface PublicAnalyticsConfig {
  clarity: { enabled: boolean; projectId: string | null };
  posthog: { enabled: boolean; key: string | null; host: string | null };
}

services.integrations.analyticsCsp(pathname: string): Promise<AnalyticsCspPolicy | null>;
services.integrations.analytics.getPublicConfig(): Promise<PublicAnalyticsConfig>;
```

- Strictly disabled by default.
- Exact route allowlist: `["/privacy", "/terms"]`. Authentication (`/sign-in`, `/register`, `/verify-email`, `/mfa`, `/reset-password`), customer data (`/orders`, `/files`, `/messages`, `/invoices`, `/account`), and console (`/admin`) routes are **permanently excluded** and cannot be enabled from UI or settings.
- Validated identifiers only: Clarity project ID `^[A-Za-z0-9]{6,32}$`; PostHog project token `^phc_[A-Za-z0-9_]{12,176}$` (personal `phx_` keys rejected); PostHog host restricted to `https://us.i.posthog.com`, `https://eu.i.posthog.com`, or an admin-allowlisted exact HTTPS origin. Never arbitrary script/HTML snippets.
- Client loader builds vendor script URLs only after (a) admin enablement, (b) visitor explicit session consent in memory (no `localStorage`/`sessionStorage`/`document.cookie`), and (c) exact allowed pathname. PostHog runs with session recording, autocapture, and persistence disabled (`memory` persistence only).

### 1.5 Stripe, SAML SSO, SharePoint (`stripe`, `saml`, `sharepoint`)

- `services.integrations.stripe.isOnlinePaymentConfigured(): Promise<boolean>` — `false` by default; `true` only when admin-enabled with secret key and webhook signing secret configured.
- `POST /api/integrations/webhooks/stripe` (via `registerSignedIntegrationWebhooks`) — raw-body HMAC-SHA256 `stripe-signature` verification (`t=...,v1=...`, 300 s tolerance, constant-time compare), inert (`404`/`503` safe JSON) when Stripe is disabled/unconfigured, durable idempotency table `integration_webhook_events` (`UNIQUE(provider, external_event_id)`), invokes `services.compliance.recordProviderPayment(...)` inside transaction. Marked honestly as implemented, not exercised against live Stripe.
- `saml`: permanently disabled scaffold (`Not available in this release — local sign-in with MFA is the only active method`), stores non-active planning metadata only, documents mandatory future security controls.
- `sharepoint`: permanently disabled scaffold + status only, documented as a target.

---

## 2. tRPC Procedures (`trpc.integrations.*`)

| Procedure | Guard | Description |
| --- | --- | --- |
| `publicAnalyticsConfig` (query) | `publicProcedure` | Returns `{ clarity: { enabled, projectId }, posthog: { enabled, key, host } }` safe values only. |
| `admin.providers` (query) | `adminProcedure` | Returns `ProviderStatus[]` for all 6 optional providers. |
| `admin.smtpReadiness` (query) | `adminProcedure` | Returns `SmtpReadiness` (used by credential reset preflight UI). |
| `admin.smtp.get` (query) | `adminProcedure` | Non-secret SMTP config + `passwordConfigured: boolean` + check state. |
| `admin.smtp.update` (mutation) | `adminProcedure` + `requireCapability("integrations.manage")` (step-up) | Validates + updates SMTP config/secret transactionally with audit. |
| `admin.smtp.sendTest` (mutation) | `adminProcedure` + `requireCapability("integrations.manage")` (step-up) | Sends synthetic test email over verified TLS and records truthful check result. |
| `admin.analytics.get` (query) | `adminProcedure` | Clarity + PostHog config, read-only allowed/excluded route policy, allowed PostHog origins. |
| `admin.analytics.update` (mutation) | `adminProcedure` + `requireCapability("integrations.manage")` (step-up) | Validates IDs/origins, rejects script-like inputs, updates settings transactionally with audit. |
| `admin.stripe.get` (query) | `adminProcedure` | Stripe adapter config (`secretKeyConfigured`, `webhookSecretConfigured`, `enabled`, honest verification status). |
| `admin.stripe.update` (mutation) | `adminProcedure` + `requireCapability("integrations.manage")` (step-up) | Updates Stripe settings/write-only secrets transactionally with audit. |
| `admin.saml.get` (query) | `adminProcedure` | Disabled SAML scaffold metadata + mandatory security requirements note. |
| `admin.saml.updateMetadata` (mutation) | `adminProcedure` + `requireCapability("integrations.manage")` (step-up) | Saves non-active planning metadata; refuses activation. |
| `admin.sharepoint.get` (query) | `adminProcedure` | Disabled SharePoint/M365 scaffold status + target design note. |
| `admin.egress.list` (query) | `adminProcedure` | Lists configured egress allowlist rules. |
| `admin.egress.create` (mutation) | `adminProcedure` + `requireCapability("integrations.manage")` (step-up) | Creates explicit egress allowlist rule (transactional audit). |
| `admin.egress.update` (mutation) | `adminProcedure` + `requireCapability("integrations.manage")` (step-up) | Updates allowlist rule with optimistic concurrency (`expectedVersion`). |
| `admin.egress.remove` (mutation) | `adminProcedure` + `requireCapability("integrations.manage")` (step-up) | Deletes allowlist rule (transactional audit). |
| `admin.egress.check` (mutation) | `adminProcedure` + `requireCapability("integrations.manage")` (step-up) | Dry-run DNS + policy evaluation for an operator target + purpose (no outbound connection). |

---

## 3. Raw HTTP Routes (`server/modules/integrations/http.ts`)

- `registerIntegrationsHttpRoutes(router, services)` — mounted at `/api/integrations` (none required; admin actions use tRPC).
- `registerSignedIntegrationWebhooks(router, services)` — mounted at `/api/integrations/webhooks` (raw 256 KiB `application/json`, no cookies/CSRF):
  - `POST /stripe`: verifies `Stripe-Signature`, reserves `integration_webhook_events` idempotently, calls `services.compliance.recordProviderPayment`.

---

## 4. Settings, Secrets & Feature Flags (`server/modules/integrations/settings.ts`)

All declared via `server/modules/platform/index.js` (owner `"integrations"`, default OFF):
- Feature flags: `integrations.smtp`, `integrations.clarity`, `integrations.posthog`, `integrations.stripe`
- Value settings:
  - `integrations.smtp.config` (`group: "mail"`, `sensitivity: "internal"`)
  - `integrations.analytics.clarity_project_id` (`group: "analytics"`, `sensitivity: "public"`)
  - `integrations.analytics.posthog_project_key` (`group: "analytics"`, `sensitivity: "public"`)
  - `integrations.analytics.posthog_host` (`group: "analytics"`, `sensitivity: "public"`)
  - `integrations.analytics.posthog_allowed_origins` (`group: "analytics"`, `sensitivity: "internal"`)
  - `integrations.stripe.config` (`group: "integrations"`, `sensitivity: "internal"`)
  - `integrations.saml.scaffold` (`group: "integrations"`, `sensitivity: "internal"`)
- Secrets (encrypted via `FieldCrypto`, never returned to clients):
  - `integrations.smtp.password` (`group: "mail"`)
  - `integrations.stripe.secret_key` (`group: "integrations"`)
  - `integrations.stripe.webhook_secret` (`group: "integrations"`)

---

## 5. Audit Events, Health Components & Tables

- **Audit events** (`category: "integration"` or `"security"` on SSRF/signature denial):
  - `integration.smtp.updated`, `integration.smtp.tested`
  - `integration.analytics.updated`
  - `integration.stripe.updated`, `integration.stripe.webhook.processed`, `integration.stripe.webhook.rejected`
  - `integration.saml.scaffold_updated`, `integration.saml.enable_refused`
  - `integration.egress.rule_created`, `integration.egress.rule_updated`, `integration.egress.rule_deleted`, `integration.egress.denied`, `integration.egress.checked`
- **Health components**:
  - `mail.smtp` (`not_configured | disabled | degraded | failing | ok`)
  - `integrations.clarity`, `integrations.posthog`, `integrations.stripe`, `integrations.saml`, `integrations.sharepoint`
- **Tables** (`server/modules/integrations/schema.ts`):
  - `integration_egress_allowlist`
  - `integration_provider_checks`
  - `integration_webhook_events`
- **Client exports** (`client/src/features/integrations/`):
  - `integrationsFeature` (`routes.tsx`): `/admin/integrations`, `/admin/integrations/analytics`, `/admin/integrations/egress`
  - `AnalyticsConsentSlot`, `useAnalyticsConsent` (`consent.tsx`)
