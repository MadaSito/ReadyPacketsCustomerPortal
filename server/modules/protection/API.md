# Protection API

Increment 04 package C. Application-layer protection complements a network firewall or CDN WAF; it does not replace one. The authored policy starts in `detect`, with no custom, IP, or country blocks, and leaves the existing rate limit defaults in place.

## Service and HTTP ports

```ts
import type { Request } from "express";
import type { ModuleLifecycle } from "../../core/types.js";

interface ProtectionModule extends ModuleLifecycle {
  clientCountry(req?: Request): string | null;
  inspect(req: Request): Promise<{ action: "allow" | "block" }>;
}
```

`clientCountry` returns an uppercase ISO 3166-1 alpha-2 code or `null`. With no request parameter it uses the current HTTP request's evaluated country when available; outside HTTP it returns `null`. The lookup does not make network calls or read caller-supplied forwarding headers. An optional configured country header is accepted only from an explicitly trusted direct proxy, which must overwrite the incoming header. The bounded offline MMDB is the fallback. Consumers must define their own unknown-country policy; `null` is not a positive authorization decision.

`inspect` runs after authority normalization and cheap admission, before application body parsing, origin exceptions, and session resolution. It checks bounded method/path/query/headers and normalized IP metadata; cookies, credentials and body bytes are excluded. Probes and ACME challenge paths are exempt. HTTP owns raw routers for packages H, I and K, specified in [HTTP security API](../../http/API.md).

## Console and configuration

`protectionRouter` exposes `overview`, `getPolicy`, `getRateLimits`, `listEvents`, and `exportEvents`; reads require a full administrator session with `security.firewall.read`, and event export is durably audited. `setPolicy`, `setRateLimit`, `resetRateLimit` and `releaseBlock` require `security.firewall.manage`, persisted current authorization, fresh step-up and transaction-bound audit. Policy mutations are versioned. A candidate policy that would block the acting administrator's normalized address, country, or protected management route is refused.

Managed groups: `injection`, `traversal`, `protocol`, `scanner`, `oversize` (`off`, `detect`, `block`). Custom rules use bounded literal operators, no user-supplied regex. IP lists accept canonical IPv4/IPv6 CIDR with bounded reason and optional expiry. Country mode is `off`, `allow`, or `deny`. Changes to existing rate limits keep all categories enabled and within policy-specific safe bounds. Runtime break-glass: `PROTECTION_DISABLED=1` bypasses new enforcement and falls back to original rate-limit defaults.

Events record bounded route templates, normalized method/country, correlation and action; sensitive detail is limited to the administrator event view and redacted in audit/SIEM. Requests do not record raw queries, credential-bearing headers or bodies. Policy events are sampled to at most 16 per minute across replicas. Rate-limit events use `rate_limit.<bucket>` as the event rule and `rateLimitBucket` in the audit attributes, with separate slots for `edge_requests` and `edge_static` and up to two slots per minute for other categories. A pre-gate 429 does not run policy inspection, a country lookup, or automatic-strike logic. Release of an automatic block does not remove a manual list entry.

Exports for integration: `createProtectionModule`, `ProtectionModule`, `protectionRouter`, and `protectionFeature`. Schema exports: `protectionPolicies`, `protectionBlocks`, and `protectionEvents`; existing `rateLimitCounters` adds nullable indexed `blockPublicId`.

## Sign-in bans and progressive back-off

- **Identity signal port**: `recordSignInSignal({ ip, accountRef?, kind, outcome, correlationId, at }): Promise<void>` takes the current HTTP address and a blind account reference, never a raw email or credential. Captured proxy trust and the current request must agree with the signal address. Publish after the credential transaction settles. A success never clears strikes; successful and unknown-account events do not expose account existence through this port.
- **Address trust port**: `clientAddressTrust(): { determinable: boolean }` describes only the current request. It returns false outside HTTP, under emergency bypass, or for missing/ambiguous client identity. A configured reverse proxy must overwrite the untrusted forwarding header. A direct peer is authoritative only without a configured proxy; loopback and configured proxy ranges are never eligible.
- **Management**: `listSignInBans` requires `security.firewall.read`. `manualSignInBan(principal, { address, durationMinutes, reason })`, `releaseSignInBan(principal, { publicId })` and `setSignInBanPolicy` require a live full admin session with `security.firewall.manage` and fresh step-up; incident and audit actions use the same service. A null duration is permanent. Pass a verified source address resolved server-side for incident actions. Do not invoke management methods from an ambient transaction.
- **Storage and events**: `protectionSignInStrikes` has 16,384 fixed keyed slots; collisions never combine different addresses’ strikes, and an occupied live slot can defer tracking another address. Entries age out after the maximum escalation memory. `protectionSignInBans` is capped at 512; the oldest temporary ban is evicted ahead of any permanent ban. Networks are encrypted at rest (`protection_signin_bans.address_enc:<publicId>`) and indexed by domain-separated pseudonyms, independently of data-key and blind-index key rotation. Keep the installation pseudonym root stable. `security.ban.created` and `security.ban.released` carry `ban_public_id`, `automatic`, and local-only `address_ref` when available. Plaintext addresses and operator reasons are not event attributes. Changes and audit commit together.
- **HTTP**: Sign-in admission runs after hard edge admission and before credential lookup or body parsing. The refusal is the ordinary generic `RATE_LIMITED` HTTP 429 with `Retry-After`; no account lookup takes place. Ban records are queried authoritatively across replicas. An address on the active allow list is exempt, even if a ban record remains.
- **Rate settings**: `setRateLimit` accepts optional `backoff: { enabled, factor, maxSeconds, resetAfterMinutes }`. Older stored `{ maxRequests, windowSeconds }` values gain defaults. Each new exceeded window escalates across replicas until the configured cap; attempts during an extended wait do not restart it. Idle memory begins at the end of the wait. Rate counters use one fixed hashed slot per category and subject, so collisions remain possible. Restoring defaults updates policy, not an already active block.

See the [administrator guide](ADMIN_GUIDE.md), [customer help](CUSTOMER_HELP.md), and [verification notes](VERIFICATION.md).
