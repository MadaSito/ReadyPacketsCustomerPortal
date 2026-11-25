# 0058 — Outbound webhooks for phases, and operational alerts

Status: Proposed (drafted from INCREMENT_07_CONTRACT.md; to be corrected against the owners' API.md as packages land)

## Context
The owner listed potential features, including:
- P101 / P201 phase-start dispatch and lifecycle queuing;
- endpoint management with optional HMAC-SHA256 signing;
- delivery history with bounded retry, stop controls and separate redelivery records;
- warning, error and critical dashboard alerts.

The production pipeline and signed webhooks exist ([ADR 0023](0023-production-pipeline-webhooks.md), [ADR 0034](0034-inbound-api-keys-webhooks-logs-replay.md)).

## Decision
- **Workflow webhook ports** (integrations):
  - `workflowWebhooks.listOptions` lists P101–P401 and named subscriptions, with no URLs or secrets;
  - `validateTargetKey` checks a target key;
  - `enqueueStageWebhook(input, tx)` queues a phase webhook. P201 still requires a delivered P101 and the intake lock. A refused precondition is recorded as an outcome; it never rolls back the customer's payment or submission.
- **Lifecycle auto-queue** (opt-in per workflow, off by default):
  - payment confirmed queues P101;
  - phase 1 submitted and locked queues P201.
- **Signing.** Production endpoints gain optional HMAC-SHA256 signing, which stays off for existing endpoints until a secret is set. Subscriptions keep `signing_enabled`, on by default as today.
- **Delivery controls:**
  - a queued or retrying delivery can be stopped;
  - **Retry** (eligible deliveries, same record chain) is separate from **Redeliver** (a new record);
  - deliveries can be filtered by order.
- **Graph readiness:**
  - `/admin/integrations` gets a live SharePoint card; the "scaffold" text goes;
  - a write-capability check for `Sites.Selected`;
  - `Retry-After` is honoured, and the token is evicted on 401;
  - Entra instructions can be copied.
- **Egress switches.** The Stripe, Graph and Graph upload egress presets get visible one-click switches on `/admin/integrations/egress`.
- **Operational alerts** (new module `opsAlerts`):
  - **Table.** `operational_alerts` records the severity (`warning | error | critical`), the source, the order or run references, a dedup key, a safe title and text, and the state (`open | acknowledged | resolved`).
  - **Port.** `opsAlerts.emit` / `resolve`, used by phase bundles, completion jobs, webhooks, Graph, file sync, payments and certificates.
  - **Where they show.** A widget on `/admin` shows counts by severity. The page `/admin/alerts` filters, acknowledges and resolves (`ops.alerts.read`, `ops.alerts.manage`).
  - **Forwarding.** Alerts go to the audit trail and the SIEM with safe codes only. There is one alert per failure, not per retry.
- **Mail:**
  - `mailTemplates.listForPhaseActions` lists published, variable-compatible templates;
  - a neutral built-in `orders.phase_update` template;
  - an optional attention reminder (`orders.attention_alert_hours`, default 48, off).

## Assumptions to confirm with the owner
- Lifecycle auto-queue of P101 / P201 and attention reminders stay off until switched on per workflow or setting.

## Consequences
- Failures surface once, on the dashboard and in the SIEM, instead of only in delivery logs.
- Signing an existing production endpoint needs a secret on both sides before it is switched on.
