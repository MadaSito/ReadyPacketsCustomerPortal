# 0031 — Application-level protection layer: managed rules, IP lists, country rules, tunable rate limits

Status: Accepted (2026-11-21; owner confirmation requested)

## Context
The owner asked for WAF controls, rate-limit controls, IP blocking and geo blocking.

## Decision
- A protection module runs early in the request pipeline with managed rule groups (`off | detect | block`), custom rules, IP allow / deny lists (CIDR, expiry, reason), automatic temporary blocks and country allow / deny lists.
- Country is resolved from an administrator-supplied MMDB file on disk; the portal never calls an outside lookup service.
- It ships in detect mode. Saving a rule that would block the administrator's own request is refused; `PROTECTION_DISABLED=1` is the break-glass switch; health and certificate-challenge paths are exempt.
- Rate-limit policies are tunable within fixed floors and ceilings.

## Consequences
This complements, and does not replace, a network firewall or CDN WAF. Pattern rules produce false positives; detect mode and the event log exist to tune them before blocking.
