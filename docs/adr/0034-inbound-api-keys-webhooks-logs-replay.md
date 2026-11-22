# 0034 — Inbound API v1 with scoped keys, signed webhooks, searchable logs and audited re-run

Status: Accepted (2026-11-21; owner confirmation requested)

## Context
The owner asked for secure inbound and outbound API and webhooks with searchable logs and the ability to re-run a call.

## Decision
- `/api/v1` is authenticated by API keys stored as hashes with scopes, expiry, optional IP list, per-key limits and optional request signing. A key is a service principal, never a user.
- Outbound webhook subscriptions are signed, delivered from an outbox through the egress allow-list, retried and auto-disabled. Inbound endpoints verify signature and timestamp, deduplicate and may only start automations.
- Requests and deliveries are logged with redacted, bounded, encrypted bodies for a retention period. Re-run (redeliver, reprocess, replay) needs `api.replay` with step-up, is audited and marked as a replay.

## Consequences
Stored bodies are sensitive; retention defaults to 30 days and is configurable downward to zero (which disables replay).
