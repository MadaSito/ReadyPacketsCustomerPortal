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

Events record bounded route templates, normalized method/country, correlation and action; sensitive detail is limited to the administrator event view and redacted in audit/SIEM. Requests do not record raw queries, credential-bearing headers or bodies. Bounded sampling and retention apply to request events. Release of an automatic block does not remove a manual list entry.

Exports for integration: `createProtectionModule`, `protectionRouter`, `protectionFeature`, and protection schema tables (will notify the integrator when final).
