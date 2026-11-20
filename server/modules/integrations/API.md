# `server/modules/integrations` — Public API & Contract

Owner: `integrations_engineer` (`server/modules/integrations/**`, `client/src/features/integrations/consent.tsx`, `client/src/features/integrations/routes.tsx`; admin pages under `client/src/features/integrations/admin/**` owned by `identity_engineer`).

---

## 1. Module Service Surface (`services.integrations: IntegrationsModule`)

Implements `ModuleLifecycle` (`name: "integrations"`, `start()`, `stop()`, `health()`).

### 1.1 Outbound Egress & SSRF Policy (`services.integrations.egress`)

Every outbound network connection made by the portal (`siem`, `smtp`, `webhook`, `sharepoint`, `stripe`, `antivirus`) **must** call `assertAllowed` first and connect **only** to the returned pinned IP address (`address` + `family`) while passing `servername` for TLS SNI/certificate verification (`createPinnedLookup(pinned)` + `family: pinned.family` + `autoSelectFamily: false` in Node 22).

```ts
export const EGRESS_PURPOSES = ["siem", "smtp", "webhook", "sharepoint", "stripe", "antivirus"] as const;
export type EgressPurpose = (typeof EGRESS_PURPOSES)[number];

export const EGRESS_PROTOCOLS = ["https:", "tls:", "smtp:", "smtps:"] as const;
export type EgressProtocol = (typeof EGRESS_PROTOCOLS)[number];

export type EgressMatchType = "host" | "ip" | "cidr";

export interface PinnedEgressTarget {
  hostname: string;
  port: number;
  protocol: EgressProtocol;
  address: string;
  family: 4 | 6;
  servername?: string;
  normalizedUrl?: string;
  allowlistRulePublicId?: string;
}
```

- Refuses loopback (`127.0.0.0/8`, `::1`), unspecified (`0.0.0.0/8`, `::`), link-local (`169.254.0.0/16`, `fe80::/10`), cloud metadata (`169.254.169.254`, `169.254.170.2`, `100.100.100.200`, `fd00:ec2::254`, `metadata.google.internal`), multicast (`224.0.0.0/4`, `ff00::/8`), broadcast/reserved (`240.0.0.0/4`), IPv4-mapped/compatible/SIIT/NAT64/6to4/Teredo transition IPv6 forms (`::ffff:0:0/96`, `::ffff:0:0:0/96`, `64:ff9b::/96`, `2002::/16`, `2001::/32`), RFC 9637 documentation (`3fff::/20`, `2001:db8::/32`), octal/hex/decimal/shorthand IPv4 encodings (`0177.0.0.1`, `0x7f000001`, `2130706433`, `127.1`), and `.localhost` / `.local` / `.internal` hostnames.
- Refuses private RFC 1918 (`10/8`, `172.16/12`, `192.168/16`), RFC 4193 ULA (`fc00::/7`), CGNAT (`100.64/10`), and non-default ports **unless** an explicit administrator allowlist rule (`integration_egress_allowlist`) matches `(purpose, protocol, port, host/ip/cidr)` and has `allowPrivateAddress = true` when the resolved IP is private. Cloud metadata, link-local, multicast, production loopback, and IPv4-transition IPv6 addresses can **never** be allowlisted.
- `createPinnedLookup(pinned)` supports both scalar `(address, family)` callbacks and Node >=20 `autoSelectFamily` `{ all: true }` `LookupAddress[]` callbacks without touching OS DNS.
- Enforces a 5 s DNS lookup deadline (`EGRESS_DNS_TIMEOUT`), a total wall-clock HTTP request deadline (`EGRESS_TIMEOUT`), and refuses all HTTP `3xx` redirects (`EGRESS_REDIRECT_REFUSED`).
- Supports `requireAllowlistRule?: boolean` (`EGRESS_ALLOWLIST_REQUIRED`) and `publicAddressesOnly?: boolean` (`EGRESS_NON_PUBLIC_ADDRESS_BLOCKED`) inside the single `evaluateTarget` / `fetchPinned` evaluation that returns the actual `PinnedEgressTarget` dial pin (`resolvedAddresses?: readonly string[]`), eliminating any split DNS check-vs-connect TOCTOU window.

### 1.2 Provider Registry & Health (`services.integrations.providers`)

```ts
export type ProviderKey = "smtp" | "clarity" | "posthog" | "stripe" | "saml" | "sharepoint";
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

### 1.3 Outbound SMTP Transport (`services.integrations.smtp`)

- Enforces TLS (`tlsMode: "starttls" | "implicit"`, `rejectUnauthorized: true`, `minVersion: "TLSv1.2"`, plaintext port 25 unconditionally forbidden with `SMTP_PORT_25_FORBIDDEN`), pins sockets through `egress.assertAllowed(..., "smtp")`, sanitizes CRLF/control header injection, and executes `sendTestMessage` in a 3-phase flow:
  1. Short DB transaction: `assertIntegrationsManageInTx` (`identity.sessions.assertCurrent`) + read settings/secret + durable `integration.smtp.test_attempted` audit BEFORE revealing credentials or opening network sockets.
  2. External SMTP send with zero DB connections/locks held.
  3. Persist check result (`integration_provider_checks`) + `integration.smtp.tested` audit.

### 1.4 Consent-Gated Public-Route Analytics (`services.integrations.analytics` & `consent.tsx`)

- Disabled by default; exact route allowlist `["/privacy", "/terms"]` with clean query/hash (`location.search === "" && location.hash === ""`) and anonymous visitor session (`session.view.status === "anonymous"`).
- Clarity project ID `^[A-Za-z0-9]{6,32}$`; PostHog token `^phc_[A-Za-z0-9_]{12,176}$`; PostHog host restricted to `https://us.i.posthog.com`, `https://eu.i.posthog.com`, or an admin-allowlisted exact HTTPS origin.
- `consent.tsx` enforces `data-clarity-mask="true"` on `document.documentElement` before mounting Clarity, stores consent exclusively in volatile JS memory (never `localStorage`/`sessionStorage`/cookies), and installs synchronous JS-realm taint guards (`history.pushState`/`replaceState`, capture-phase `popstate`/`hashchange`, and `ME_QUERY_KEY` cache subscription) so non-public navigations abort SPA routing before any private DOM node can commit and trigger a full-document navigation instead.

### 1.5 Disabled Scaffolds (`stripe`, `saml`, `sharepoint`)

- **`stripe` (DISABLED SCAFFOLD in this release)**:
  - Hard-disabled behind compile-time `STRIPE_LEDGER_MUTATION_ENABLED = false as const`.
  - `STRIPE_RELEASE_BANNER`: `"Not available in this release — online checkout and automatic ledger booking are disabled; staff record payments manually."`
  - `services.integrations.stripe.isOnlinePaymentConfigured()` always returns `false`.
  - `updateConfig({ enabled: true, ... })` throws `NOT_CONFIGURED / STRIPE_NOT_AVAILABLE_IN_RELEASE`.
  - `POST /api/integrations/webhooks/stripe` verifies `Stripe-Signature` HMAC-SHA256 (`t=...,v1=...`, constant-time compare), durably records the received event in `integration_webhook_events` (`status = "ignored"`) + audit note (`ledgerMutated: false`), and acknowledges (`reasonCode: "STRIPE_DISABLED_IN_RELEASE"`) — **zero compliance ledger calls or payment mutations exist**.
- **`saml` (DISABLED SCAFFOLD)**:
  - `SAML_RELEASE_BANNER`: `"Not available in this release — local sign-in with MFA is the only active method"`.
  - Saves non-active planning metadata only; refuses `enabled: true` (`SAML_NOT_AVAILABLE_IN_RELEASE`) and XML/PEM payloads; exposes `securityRequirements: readonly string[]`.
- **`sharepoint` (DISABLED SCAFFOLD)**:
  - Read-only status (`availableInRelease: false`, `state: "disabled"`, `summary`, `targetRequirements: readonly string[]`).

### 1.6 Outbound Production Pipeline Webhooks (`services.integrations.production`)

- Implements `P101` (Order Creation / SharePoint folder tree initialization) and `P201` (Trigger Production Run) per `docs/integrations/PRODUCTION_WEBHOOKS.md`.
- Ships disabled (`feature.integrations.production = false`) with empty `canonVersion` (`""`); stores `p101_url`, `p201_url`, and `auth_value` via `defineSecret` (`exportable: false`, `FieldCrypto` AES-256-GCM — excluded from generic Platform settings exports) and returns only masked `{ host, last4 }` / `authHeaderValueConfigured` views.
- Enforces `egress.fetchPinned(..., "webhook", { requireAllowlistRule: true, publicAddressesOnly: true })` (HTTPS-only, mandatory enabled `"webhook"` allowlist rule, public-only DNS answers in the same evaluation as socket pinning, zero redirects, discarded 8 KiB response read with fixed server-generated `responseSummary` only).
- Pins each dispatch to `expected_owner_user_id` and a keyed HMAC-SHA-256 `destination_fingerprint` at queue time (`DESTINATION_CHANGED` cancels on URL/auth/config drift), revalidates order lock/hold/cancellation/owner/scope immediately before send, encrypts retry payload bodies (`payload_enc`) only during the active retry window, scrubs `payload_enc = NULL` on `delivered` / `failed` / `dead` and via bounded stale reconciliation (`integrations.production.reconcile`), and records only controlled `resendReason` codes.

---

## 2. Exact tRPC Procedures & Return Types (`trpc.integrations.*`)

All `admin.*` queries require `adminProcedure`. All `admin.*` mutations require `adminProcedure.use(requireCapability("integrations.manage"))` (step-up MFA enforced in router + re-validated inside every DB transaction via `identity.sessions.assertCurrent`).

- **`publicAnalyticsConfig`** (`query`, public) -> `{ clarity: { enabled: boolean; projectId: string | null }; posthog: { enabled: boolean; key: string | null; host: string | null } }`
- **`admin.providers`** (`query`) -> `ProviderStatus[]` (`smtp`, `clarity`, `posthog`, `stripe`, `saml`, `sharepoint`)
- **`admin.smtpReadiness`** (`query`) -> `{ enabled: boolean; configured: boolean; verified: boolean; ready: boolean; state: ProviderState; summary: string }`
- **`admin.smtp.get`** (`query`) -> `SmtpConfigView` (`{ enabled, configured, verified, state, summary, host, port, tlsMode: "starttls"|"implicit", username, passwordConfigured: boolean, fromAddress, fromName, replyToAddress, lastCheckedAt, lastOutcome }`)
- **`admin.smtp.update`** (`mutation`, step-up) -> input `{ enabled, host, port, tlsMode, username, password?: string | null, fromAddress, fromName, replyToAddress? }` -> `SmtpConfigView`
- **`admin.smtp.sendTest`** (`mutation`, step-up, `expensive` rate limit) -> input `{ toAddress: string }` -> `SmtpTestResult` (`{ outcome: "accepted"|"rejected"|"unknown", reasonCode: string, safeMessage: string, durationMs: number, checkedAt: Date }`)
- **`admin.analytics.get`** (`query`) -> `AdminAnalyticsConfig` (`{ clarity: { enabled, configured, projectId }, posthog: { enabled, configured, projectKey, host, cloudHosts, allowedSelfHostedOrigins }, allowedPaths, permanentlyExcludedPrefixes, verificationNote }`)
- **`admin.analytics.update`** (`mutation`, step-up) -> input `{ clarityEnabled, clarityProjectId, posthogEnabled, posthogProjectKey, posthogHost, allowedSelfHostedOrigins? }` -> `AdminAnalyticsConfig`
- **`admin.stripe.get`** (`query`) -> `StripeConfigView` (`{ enabled: false, availableInRelease: false, releaseBanner, configured, verified: false, state: "disabled", summary, publishableKey, secretKeyConfigured, webhookSecretConfigured, webhookToleranceSeconds, webhookPath: "/api/integrations/webhooks/stripe", lastCheckedAt, verificationNote }`)
- **`admin.stripe.update`** (`mutation`, step-up) -> input `{ enabled, publishableKey, webhookToleranceSeconds?, secretKey?, webhookSecret? }` -> `StripeConfigView`
- **`admin.saml.get`** (`query`) -> `SamlScaffoldView` (`{ state: "disabled", availableInRelease: false, releaseBanner, metadata: { idpEntityId, idpSsoUrl, spEntityId, nameIdFormat }, securityRequirements }`)
- **`admin.saml.updateMetadata`** (`mutation`, step-up) -> input `{ idpEntityId, idpSsoUrl, spEntityId, nameIdFormat, enabled? }` -> `SamlScaffoldView`
- **`admin.sharepoint.get`** (`query`) -> `SharePointScaffoldView` (`{ state: "disabled", availableInRelease: false, summary, targetRequirements }`)
- **`admin.egress.list`** (`query`) -> `EgressAllowlistRuleView[]`
- **`admin.egress.create`** (`mutation`, step-up) -> input `{ purpose, matchType: "host"|"ip"|"cidr", pattern, port, protocol, allowPrivateAddress, enabled?, justification }` -> `EgressAllowlistRuleView`
- **`admin.egress.update`** (`mutation`, step-up) -> input `{ publicId, expectedVersion, port?, allowPrivateAddress?, enabled?, justification? }` -> `EgressAllowlistRuleView`
- **`admin.egress.remove`** (`mutation`, step-up) -> input `{ publicId }` -> `void`
- **`admin.egress.check`** (`mutation`, step-up, `expensive` rate limit) -> input `{ target, purpose }` -> `{ allowed: boolean; pinned?: PinnedEgressTarget; reasonCode?: string; safeMessage: string }`
- **`production.settings.get`** (`query`, `admin` + `integrations.manage`) -> `ProductionSettingsView`
- **`production.settings.update`** (`mutation`, `admin` + `integrations.manage` + step-up) -> input `{ enabled, canonVersion, runMode?, timeoutMs?, p101Url?, p201Url?, authHeaderName?, authHeaderValue? }` -> `ProductionSettingsView`
- **`production.settings.test`** (`mutation`, `admin` + `integrations.manage` + step-up, `expensive` rate limit) -> input `{ phase: "P101" | "P201" }` -> `ProductionDryRunResult` (dry-run URL + allowlist + public-DNS check; never sends HTTP or projects `normalizedUrl`)
- **`production.order.preview`** (`query`, `staff` + `orders.production.trigger`) -> input `{ orderPublicId, releaseStatus? }` -> `ProductionOrderPreview` (`client_name` / `client_email` masked for `staff`, unmasked for `admin`; `release_status` defaults to `""`)
- **`production.order.requestP101`** (`mutation`, `staff` + `orders.production.trigger`) -> input `{ orderPublicId, releaseStatus? }` -> `ProductionDispatchItem`
- **`production.order.requestP201`** (`mutation`, `staff` + `orders.production.trigger`) -> input `{ orderPublicId, phase1ArtifactsConfirmed }` -> `ProductionDispatchItem`
- **`production.order.resend`** (`mutation`, `admin` + `orders.production.trigger` + step-up) -> input `{ orderPublicId, phase: "P101" | "P201", reason, releaseStatus?, phase1ArtifactsConfirmed? }` -> `ProductionDispatchItem` (`resendReason` holds controlled code only)
- **`production.order.history`** (`query`, `staff` + `orders.production.trigger`) -> input `{ orderPublicId }` -> `{ items: ProductionDispatchItem[] }`
- **`production.admin.listDispatches`** (`query`, `admin` + `orders.production.trigger`) -> input `{ phase?, state?, orderReference?, fromDate?, toDate?, limit? }` -> `{ items: ProductionDispatchItem[] }`

---

## 3. Raw HTTP Routes (`server/modules/integrations/http.ts`)

- `registerIntegrationsHttpRoutes(router, services)` — mounted at `/api/integrations`.
- `registerSignedIntegrationWebhooks(router, services)` — mounted at `/api/integrations/webhooks` (raw 256 KiB `application/json`, rate-limited via `rateLimitAddress(req.ip)`):
  - `POST /stripe`: verifies `Stripe-Signature`, durably logs inert received event in `integration_webhook_events` (`status = "ignored"`, `ledgerMutated = false`), never mutates compliance ledger.

---

## 4. Audit Events, Health Components & Tables

- **Audit events**:
  - `integration.smtp.updated`, `integration.smtp.test_attempted`, `integration.smtp.tested`
  - `integration.analytics.updated`
  - `integration.stripe.updated`, `integration.stripe.enable_refused`, `integration.stripe.webhook.received_disabled`, `integration.stripe.webhook.rejected`
  - `integration.saml.scaffold_updated`, `integration.saml.enable_refused`
  - `integration.egress.rule_created`, `integration.egress.rule_updated`, `integration.egress.rule_deleted`, `integration.egress.denied`, `integration.egress.checked`
  - `integration.production.settings.changed`, `integration.production.dispatch.requested`, `integration.production.dispatch.delivered`, `integration.production.dispatch.failed`, `integration.production.dispatch.dead`, `integration.production.dispatch.resent`, `integration.production.dispatch.refused`
- **Health components**: `mail.smtp`, `integrations.clarity`, `integrations.posthog`, `integrations.stripe`, `integrations.saml`, `integrations.sharepoint`, `integrations.production`
- **Tables**: `integration_egress_allowlist`, `integration_provider_checks`, `integration_webhook_events`, `integration_production_dispatches`
- **Client exports**:
  - `integrationsFeature` (`client/src/features/integrations/routes.tsx` — spreads `integrationsAdminRoutes`, `productionAdminRoutes`, `integrationsAdminNav`, `productionAdminNav`, and `productionOrderTabs`)
  - `AnalyticsConsentSlot`, `useAnalyticsConsent`, `ANALYTICS_CONSENT_COPY` (`client/src/features/integrations/consent.tsx`)
