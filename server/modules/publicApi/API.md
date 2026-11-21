# Public API v1 (`server/modules/publicApi`) — increment 04 package H

Owner: portable_contract_engineer. Ships **disabled** (`publicApi.enabled = false`); while disabled every
`/api/v1` route except `GET /openapi.json` answers 404 problem details. Enabling is step-up and audited.

## Ports for other modules (publish day one)

Exact types: `server/modules/publicApi/ports.ts` (Zod DTO schemas + `PublicApiProviders`).

```ts
services.publicApi.registerProvider<K extends ProviderKey>(key: K, provider: PublicApiProviders[K]): void   // call in your init()
```

| Provider key | Owner | Methods |
|---|---|---|
| `customers` | identity_engineer | `list(query, caller)`, `get(publicId, caller)` |
| `orders` | orders_engineer | `list`, `get`, `create(input, caller)`, `transition(publicId, input, caller)` |
| `orderFiles` | files_engineer | `list(orderPublicId, query, caller)` → page or `null` (order not found) |
| `invoices` | compliance_engineer | `list`, `get` |
| `tickets` | engagement_engineer | `list`, `get`, `create` |
| `knowledge` | engagement_engineer | `list`, `get` (published, customer audience only) |
| `webhookSubscriptions` | integrations_engineer | `list`, `get` (never secrets; host only, no full URL) |

- `ApiCaller = { kind: "api_key", keyPublicId, scopes, requestId, replay, idempotencyKey? }` — a service
  principal bound to scopes, never a user. Scope enforcement happens before the provider is called.
- `ApiListQuery = { cursor: string | null, limit: 1..100, updatedSince?: Date, filter }` — filter keys are
  only the documented ones per resource (validated here). Providers issue their own opaque cursors (≤ 200 chars).
- Return DTOs in the documented shapes; they are re-validated and unknown fields are stripped. Dates may be
  returned as ISO strings (`toISOString()`).
- Throw `DomainError`: `NOT_FOUND` → 404, `VALIDATION` → 422, `CONFLICT` → 409, `LOCKED` → 423,
  `FORBIDDEN` → 403, `UNAVAILABLE`/`MAINTENANCE` → 503. Any other error → 500 with no detail.
- Writes: record your own durable audit with `actor: { role: "system" }`, `correlationId: caller.requestId`.
- Unregistered provider → 503 `RESOURCE_UNAVAILABLE`.

## Raw HTTP routes (mounted by http_security_engineer)

`createPublicApiHttpRouter(services: Services): Router` from `server/modules/publicApi/http.ts`, relative to
`/api/v1`. Needs: raw JSON body as `Buffer` ≤ 256 KiB, no session, no CSRF, no CORS.

| Method | Path | Scope |
|---|---|---|
| GET | `/openapi.json` | none (public, OpenAPI 3.1, generated from the Zod schemas) |
| GET | `/customers`, `/customers/{id}` | `customers:read` |
| GET | `/orders`, `/orders/{id}` | `orders:read` |
| POST | `/orders` | `orders:write` (Idempotency-Key required) |
| POST | `/orders/{id}/transitions` | `orders:write` (Idempotency-Key required) |
| GET | `/orders/{id}/files` | `files:read` |
| GET | `/invoices`, `/invoices/{id}` | `invoices:read` |
| GET | `/tickets`, `/tickets/{id}` | `tickets:read` |
| POST | `/tickets` | `tickets:write` (Idempotency-Key required) |
| GET | `/knowledge/articles`, `/knowledge/articles/{id}` | `knowledge:read` |
| GET | `/webhook-subscriptions`, `/webhook-subscriptions/{id}` | `webhooks:read` |

Conventions: `Authorization: Bearer rpk_<prefix>_<secret>`; optional request signing
`X-RP-Timestamp` (unix seconds, ±300 s) + `X-RP-Signature: v1=<hex HMAC-SHA256(signingSecret, ts + "\n" +
METHOD + "\n" + path?query + "\n" + body)>` (mandatory when the key requires it; each signature accepted once);
`Idempotency-Key` (1–128 `[A-Za-z0-9._:-]`) on writes — same key + same body returns the stored response,
same key + different body → 422 `IDEMPOTENCY_KEY_REUSED`; lists take `cursor`, `limit` (≤ 100),
`updated_since` and resource filters; responses `{ data, next_cursor }`. Errors are
`application/problem+json` (`type`, `title`, `status`, `code`, `request_id`). Every response carries
`X-Request-Id`, `X-Correlation-Id`, `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`
(429 adds `Retry-After`).

## tRPC `publicApi.admin.*` (admin; capability as noted; step-up where the capability requires it)

| Procedure | Capability |
|---|---|
| `settings.get` / `settings.update({ expectedVersion, enabled, retentionDays 1..90 })` | `api.keys.manage` |
| `keys.list({ cursor?, state? })` / `keys.get({ keyId })` | `api.keys.manage` |
| `keys.create({ name, scopes, expiresAt?, ipAllowList?, rateLimitPerMinute, requireSigning })` → `{ key, token, signingSecret? }` shown once | `api.keys.manage` |
| `keys.update({ keyId, expectedVersion, name, scopes, expiresAt, ipAllowList, rateLimitPerMinute, requireSigning })` | `api.keys.manage` |
| `keys.rotate({ keyId, expectedVersion })` → new token (+ signing secret) shown once; old token stops at once | `api.keys.manage` |
| `keys.revoke({ keyId, expectedVersion })` | `api.keys.manage` |
| `log.list({ cursor?, limit?, keyId?, method?, statusClass?, status?, pathPrefix?, correlationId?, from?, to?, replay?, search? })` | `api.logs.read` |
| `log.get({ requestId })` — redacted headers and bodies | `api.logs.read` |
| `log.replay({ requestId, confirmWrite? })` | `api.replay` (step-up) |

Replay executes the stored call again through the same pipeline under the **original key's current**
scopes (revoked/expired key → refused), with a new request id, `replay = true`, `X-ReadyPackets-Replay: 1`
and, for writes, the fresh idempotency key `replay:<originalRequestId>` (a double click never writes twice).
Writes need `confirmWrite: true`. Refused when the stored body was truncated (> 64 KiB) or purged.

## Audit events

`api.settings.updated|enabled|disabled`, `api.key.created|updated|rotated|revoked`, `api.auth.denied`
(security; sampled note per key/reason), `api.request.write` (durable, per write call),
`api.request.replayed`, `api.admin.denied`.

## Jobs

`publicApi.log.purge` — hourly, deletes log rows past the retention (default 30 days) and expired
idempotency / signature-replay rows in bounded batches.

## Schema (additive)

`api_settings`, `api_keys`, `api_request_log`, `api_idempotency`, `api_signature_nonces`.
