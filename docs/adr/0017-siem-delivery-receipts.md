# 0017 — SIEM delivery states what was actually confirmed

Status: Accepted (2026-11-20)

## Context
Syslog over TLS (RFC 5425), CEF over TLS and JSON lines over TLS are one-way streams with no application
acknowledgement. Only OTLP over HTTPS returns a collector response.

## Decision
- Each delivery records its confirmation level: `transport_accepted` for TLS stream writes, `collector_2xx`
  for OTLP. The console uses those words and never shows "delivered to SIEM" for a stream write.
- If a socket fails after bytes entered the stream, the batch is marked `uncertainDelivery` and retried; the
  collector may therefore see duplicates and should de-duplicate on the event identifier.
- Destination credentials are stored per destination, sealed with authenticated data that binds slot,
  destination, version and endpoint. Changing an endpoint invalidates queued work for the old endpoint.
- Delivery is strict first-in-first-out per destination, bounded by attempt limits and a circuit breaker that
  moves poison batches to a dead-letter state.
- Forwarding never blocks the audit write. The audit trail in MySQL remains the record of truth.

## Consequences
Residual findings from the independent re-review (lease expiry against the database clock, TLS pool lifetime,
OTLP 5xx after write) are listed in `docs/security/REVIEW-audit-siem-backup.md`. No real collector was used.
