# Webhooks Administration Guide (Outbound Subscriptions, Inbound Endpoints, Delivery Log & Replay)

This chapter covers configuring and operating the ReadyPackets Webhooks subsystem (`/admin/integrations/webhooks`), which provides signed outbound event subscriptions, signed inbound HTTP endpoints, a unified redacted delivery log, and MFA step-up gated redelivery and reprocessing.

## 1. Security Posture & Default State

- **Disabled by default**: Outbound subscriptions and inbound endpoints ship switched off (`integrations.webhooks = false`). While disabled, outbound events are not queued, test deliveries are refused, worker runs abort cleanly, and `POST /api/webhooks/inbound/:endpointPublicId` returns `503 Service Unavailable`.
- **Administrator & MFA step-up controls**:
  - Viewing settings, subscriptions, inbound endpoints, and redacted delivery logs requires an authenticated administrator (`webhooks.read`).
  - Enabling or changing settings, creating/updating/deleting subscriptions or inbound endpoints, and rotating signing secrets require fresh MFA step-up (`webhooks.manage`).
  - Redelivering an outbound payload or reprocessing an inbound payload requires fresh MFA step-up (`api.replay`) and records a durable security audit event.
- **Outbound SSRF & Egress Policy**:
  - Every outbound destination must use `https://` on port `443` with no embedded credentials or URL fragments.
  - Every destination hostname must match an enabled `webhook` rule in **Admin -> Integrations -> Egress Allowlist** before saving and again immediately before every socket connection.
  - DNS resolution pins a single verified public IP address per attempt (refusing loopback, RFC 1918 private networks, link-local, cloud metadata services, and HTTP `3xx` redirects).
- **Accessibility**: All webhook administration pages and dialogs are designed and tested against WCAG 2.2 AA in both light and dark themes.

## 2. Outbound Webhook Subscriptions

1. Navigate to **Admin -> Integrations -> Egress Allowlist** and create an enabled `https:443` host rule with purpose `webhook` for your receiver domain.
2. Open **Admin -> Integrations -> Webhooks**, switch **Enable webhooks** on (step-up MFA required), and configure:
   - **Payload retention (days)**: `0` to `90` days (default `30`). Setting `0` purges request/response bodies immediately after completion while keeping delivery metadata.
   - **Auto-disable threshold**: `3` to `50` consecutive terminal failures (default `10`) before a subscription transitions to `disabled_failing` and surfaces degraded module health.
   - **Delivery timeout (ms)**: `1000` to `30000` ms (default `10000`).
3. Create a subscription by entering a display name, the `https://` destination URL, and one or more business events from the curated event catalogue (internal staff-only triggers are excluded and cannot be subscribed externally).
4. Copy the `whsec_...` signing secret shown once upon creation. Subsequent views display only the last 4 hex characters (`signingSecretLast4`).

### Verifying Outbound Signatures

Every outbound `POST` includes:
- `X-ReadyPackets-Delivery-Id`: Unique ULID for the delivery
- `X-ReadyPackets-Event`: Subscribed catalogue event key (for example, `order.created` or `invoice.paid`)
- `X-ReadyPackets-Signature`: `t=<unixSeconds>,v1=<hexHmacSha256>` (plus a second `,v1=<overlapHexHmacSha256>` while a secret rotation overlap window is active)
- `Idempotency-Key`: Stable across retries for the same delivery
- `X-ReadyPackets-Replay: 1`: Present when an administrator triggers a manual redelivery

Receivers should compute `HMAC-SHA256(signingSecret, "${t}.${rawBody}")`, compare against any `v1` digest in constant time, and reject timestamps outside ±300 seconds.

### Zero-Downtime Secret Rotation

Use **Rotate secret** on a subscription or inbound endpoint with an `overlapMinutes` window (`0` to `1440` minutes). During the overlap window:
- Outbound deliveries include signatures for both the new primary secret and the expiring secret.
- Inbound endpoints accept valid signatures under either secret until `overlapExpiresAt` passes.

## 3. Signed Inbound Webhook Endpoints

1. On **Admin -> Integrations -> Webhooks -> Inbound Endpoints**, create an endpoint with a unique `endpointKey` (`a-z0-9_-`) and timestamp tolerance (`30` to `300` seconds, default `300`).
2. Copy the `whsec_...` secret shown once and configure the external sender to `POST` raw `application/json` (up to `256 KiB`) to `/api/webhooks/inbound/<endpointPublicId>` with header `X-ReadyPackets-Signature: t=<unixSeconds>,v1=<hexHmacSha256>`.
3. ReadyPackets verifies the constant-time HMAC-SHA256 signature and timestamp window over the raw bytes **before** parsing JSON:
   - Missing, invalid, or expired signatures return `401 Unauthorized`.
   - Event identity (`id`) and event type (`type`) are taken exclusively from the HMAC-authenticated JSON body; mismatched `X-ReadyPackets-Event-Id` or `X-ReadyPackets-Event` headers are rejected with `400 HEADER_BODY_MISMATCH`.
   - Duplicate signed `id` values for the same endpoint return `200 OK` with `{ "ok": true, "duplicate": true }` without firing duplicate automations.
   - Valid new events emit the durable `integration.webhook.inbound_received` audit event (`webhook.inbound_received` trigger for internal automations; inbound webhooks never fan out to outbound webhooks).

## 4. Unified Delivery Log, Stop, Eligible Retry vs Redeliver & Order Filtering

- **Redacted encrypted payloads**: Request and response headers and bodies are redacted (`Authorization`, `Cookie`, `Set-Cookie`, `X-ReadyPackets-Signature`, and sensitive JSON keys) and encrypted at rest via `FieldCrypto` (`AES-256-GCM`) up to `64 KiB`.
- **Order-scoped filtering (`orderPublicId`)**: Filter outbound deliveries on `/admin/integrations/webhooks` by order public ID (`01J...`) to inspect every phase-triggered or automation-triggered webhook associated with a specific order alongside its originating `stageKey`.
- **Stopping queued or retrying deliveries (`Stop`)**: Administrators with `webhooks.manage` or `api.replay` can stop any `queued` or `retrying` outbound delivery (`status = "stopped"`), cancelling its pending background job under the job lease fence and recording a durable `integration.webhook.delivery_stopped` audit event.
- **Eligible Retry vs Redeliver**:
  - **Retry (`deliveries.retry`)**: Available only on undelivered `failed`, `dead`, or `stopped` outbound deliveries whose encrypted payload has not been truncated or purged. Re-queues the **same** delivery record (`manualRetryCount + 1`, preserving the original `X-ReadyPackets-Delivery` and `Idempotency-Key` with **no** `X-ReadyPackets-Replay` header) and records `integration.webhook.delivery_retried`.
  - **Redeliver (`deliveries.redeliver`, MFA step-up)**: Creates a **new** replay delivery record (`replayOfPublicId` linked to the original) with `X-ReadyPackets-Replay: 1` for intentionally replaying a completed or historical event.
  - **Truncation & purge safety**: Payloads larger than `64 KiB` (`bodyTruncated = true`) or past their retention window (`bodyPurged = true`, swept hourly by `integrations.webhook.purge`) retain metadata for audit visibility but refuse `Retry`, `Redeliver`, and `Reprocess` with `409 Conflict`.
- **Operations Center alerts**: Exhausted dead-letter deliveries and subscriptions that cross `autoDisableThreshold` (`disabled_failing`) automatically emit deduplicated alerts in **Admin -> Operations -> Alerts** (`source = "webhook"`) and resolve automatically once healthy delivery resumes.

## 5. Optional Signing & Workflow Phase Webhook Triggers

- **Per-subscription signing toggle (`signingEnabled`)**: Outbound subscriptions enable `X-ReadyPackets-Signature` HMAC-SHA256 signing by default (`signingEnabled = true`). When integrating with a receiver that accepts HTTPS + allowlisted authentication headers without a custom HMAC verifier, administrators can set **Sign payloads (`X-ReadyPackets-Signature`)** to **Off** when creating or editing the subscription.
- **Workflow Phases & Automation Rule Actions**:
  - In **Admin -> Workflows** (Phase settings -> **Webhook trigger**) and **Admin -> Automations** (`webhook.enqueue_subscription`), staff and administrators select from a safe list of configured production phases (`production:P101` .. `production:P401`) and named outbound subscriptions (`subscription:<ULID>`) without exposing destination URLs or signing secrets.
  - Workflow exports record portable logical references (`production:P101` .. `production:P401` or `subscription:<Subscription Name>`) and resolve them safely on import without overwriting existing orders.

## 6. Outbound Egress Presets & Microsoft Graph `Sites.Selected` SharePoint Setup

### One-Click Provider Egress Presets (`/admin/integrations/egress`)

Open **Admin -> Integrations -> Egress Allowlist** to view and toggle built-in outbound host presets (fresh MFA step-up required when enabling a preset):
- **Payment gateways**: `stripe`, `square`, `square_sandbox`
- **Microsoft Entra & Graph / SharePoint**: `entra_oidc`, `microsoft_graph` (`login.microsoftonline.com` + `graph.microsoft.com`), `microsoft_graph_upload` (`*.sharepoint.com` + `*.files.1drv.com`)
- **Cloud object storage**: `aws_s3`, `azure_blob`, `dropbox`, `google_drive`

### Least-Privilege Microsoft Entra & SharePoint `Sites.Selected` Runbook

ReadyPackets uses single-tenant Microsoft Entra client credentials (`common`, `organizations`, and `consumers` multi-tenant endpoints are refused) and recommends **least-privilege `Sites.Selected`** application permissions rather than tenant-wide `Sites.ReadWrite.All` or `Files.ReadWrite.All`:

1. In **Microsoft Entra admin center -> App registrations**, register a single-tenant app in your organization's directory, record **Directory (tenant) ID** and **Application (client) ID**, and create a client secret.
2. Under **API permissions -> Add a permission -> Microsoft Graph -> Application permissions**, grant **`Sites.Selected`** (plus `Mail.Send` only if using Graph Mail failover) and click **Grant admin consent**.
3. Grant the app `write` access to the single target SharePoint site (using an administrative tool with `Sites.FullControl.All`, never granted to the portal app itself):
   - **PowerShell (`Microsoft.Graph.Sites`)**:
     ```powershell
     Connect-MgGraph -Scopes "Sites.FullControl.All"
     New-MgSitePermission -SiteId "<hostname>,<spsite-guid>,<spweb-guid>" `
       -Roles @("write") `
       -GrantedToIdentities @(@{ Application = @{ Id = "<PORTAL_ENTRA_CLIENT_ID>"; DisplayName = "ReadyPackets Portal" } })
     ```
   - **Microsoft Graph REST API**:
     `POST https://graph.microsoft.com/v1.0/sites/{siteId}/permissions` with body `{"roles":["write"],"grantedToIdentities":[{"application":{"id":"<PORTAL_ENTRA_CLIENT_ID>","displayName":"ReadyPackets Portal"}}]}`.
4. In **Admin -> Integrations -> Egress Allowlist**, enable both **`microsoft_graph`** and **`microsoft_graph_upload`**.
5. In **Admin -> Integrations -> Microsoft Graph** (or **Admin -> Storage**), save your single-tenant credentials and run **Verify `Sites.Selected` Write Access** (`admin.graph.verifySitesSelectedWrite`). The portal verifies both egress presets, OAuth token acquisition, site/drive read access, and non-destructive write permission by opening a temporary `createUploadSession` and immediately cancelling it with `DELETE` (leaving zero marker files in SharePoint and never forwarding bearer tokens to SharePoint upload URLs).

