# 0008 — TLS termination, trusted proxy and host authority

Status: Accepted (2026-11-20)

## Decision
- TLS terminates at nginx on the same host. Node listens on the loopback interface only.
- Forwarded headers are honoured only from the proxy addresses listed in `RP_TRUSTED_PROXIES`.
- The request `Host` must equal the canonical origin (`my.readypackets.com`) or a configured alias
  (`portal.readypackets.com`, which is redirected permanently). Anything else is rejected before routing.
- HSTS, `Secure` cookies and the content security policy are derived from the canonical origin in configuration,
  never from request headers.

## Consequences
- Host-header injection cannot influence generated links, cookies or redirects.
