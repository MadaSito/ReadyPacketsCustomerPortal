# 0023 — Production pipeline webhooks (P101 / P201) are manual, validated, outbox-delivered and off by default

Status: Accepted (2026-11-20)

## Context
The owner supplied two documents describing how an order is handed to the production pipeline: a Phase I
start webhook (P101) carrying canonical order metadata, and a Phase II start webhook (P201) carrying only the
identity of the same run. The corrected P101 document removes `order_scope_mode`; the older trigger reference
still shows it.

The architecture requires outbound integrations to have dedicated credentials, bounded retries, a durable
outbox, audited configuration, SSRF-safe egress, and no hardcoded live endpoints.

## Decision
- The corrected P101 document is authoritative: `order_scope_mode` is never sent. Scope is expressed only by
  `packet`, `tier` and `bundle_scope_manifest` (a JSON string).
- The portal builds the payload from the order's packet items and refuses contradictory combinations before
  anything is queued (the "invalid payloads" table of the P101 document is implemented as tests).
- `customer_id` is the customer reference; `order_id` is the order reference at the time P101 is requested.
  P201 reuses the exact `customer_id`, `order_id` and `run_mode` stored with the delivered P101, so a later
  reference change cannot split a run.
- Both triggers are manual staff actions. P201 is available only after P101 was delivered for that order and
  requires the operator to confirm that the Phase I artifacts exist — the portal has no way to see them.
- Delivery uses a transactional outbox row and the job queue, with an idempotency key, bounded retries on
  network errors / 5xx / 429 and no retry on other 4xx. Re-sending needs an administrator, step-up and a reason.
- Destinations pass the egress policy (https, allow-listed host, pinned resolution, no redirects). Webhook
  URLs and the optional auth header are stored encrypted and never returned or logged.
- The feature is disabled until an administrator supplies both URLs and the canon version.

## Not covered
The documents define no callback from the pipeline. The portal therefore records that a trigger was accepted
by the receiving endpoint; it does not know whether Phase I or Phase II finished. Automatic triggering on a
status change and an inbound signed callback are possible later additions.

## Consequences
Client name and email leave the portal when Phase I is started; the privacy notice lists the production
pipeline as a recipient. Audit records carry the phase, order, packet, tier, manifest and HTTP status, never
the URL, credentials, name or email.
