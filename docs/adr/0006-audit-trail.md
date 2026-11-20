# 0006 — Durable, hash-chained audit trail separate from operational logs

Status: Accepted (2026-11-20)

## Context
The project requires detailed, correlated logging, an audit centre with advanced filtering, and secure delivery
to a SIEM or syslog collector.

## Decision
- Operational logs are structured JSON following the OpenTelemetry log data model, written to standard output,
  with request, trace, session-pseudonym and job correlation identifiers and central redaction.
- Audit events are a separate, append-only stream stored in MySQL. Security-relevant events are written in the
  same transaction as the change they describe (`record`), so a change cannot commit without its audit record.
  Informational events use a best-effort path (`note`).
- Each audit record is sealed into an HMAC hash chain after commit; periodic checkpoints are signed with
  Ed25519. A verifier reports the first break.
- Delivery to external collectors uses a transactional outbox and RFC 5424 messages over TLS (RFC 5425), with
  certificate verification on by default and plain UDP/TCP unavailable in production.

## Consequences
- Tampering with stored audit rows is detectable, not preventable; database privileges and off-host forwarding
  remain necessary controls.
- Secrets and personal data are excluded from audit attributes by an allow-list, enforced by tests.
