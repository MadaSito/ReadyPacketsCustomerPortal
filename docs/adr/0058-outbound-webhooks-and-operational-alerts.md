# 0058 — Outbound webhooks for phases, and operational alerts

Status: Accepted (2026-11-25, after the lead's integrated QA of increment 07 at `7c6bb71`; verification in [STATUS.md](../application-context/STATUS.md#verification-for-increment-07))

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
  - P101 is queued on `order.payment_state.changed` to `paid`, which needs a real payment record (a Stripe webhook or a recorded manual payment). An administrator status change that only passes the payment phase does not queue it. Nothing is queued retroactively, and the upgrade backfill (`PAYMENT_BACKFILL`) is excluded;
  - P201 is queued on `order.stage.submitted` of the intake phase, and it needs a delivered P101.
- **Signing.** Production pipeline payload signing (HMAC-SHA256) is off by default; an administrator generates a secret first. New webhook subscriptions default to signed (`signing_enabled`) and start paused.
- **Delivery controls:**
  - a queued or retrying delivery can be stopped;
  - **Retry** (eligible deliveries, same record chain) is separate from **Redeliver** (a new record);
  - deliveries can be filtered by order.
- **Graph readiness:**
  - the `/admin/integrations` hub cards are derived from live state, and the old planning scaffolds are removed (`c720201`);
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

## As implemented

From the owners' [webhooks administration guide](../integrations/WEBHOOKS_ADMIN_GUIDE.md), [production webhooks](../integrations/PRODUCTION_WEBHOOKS.md) and the [alerts API](../../server/modules/opsAlerts/API.md):

- **Retry and Redeliver.** **Retry** re-queues the same delivery record. It is offered only on undelivered failed, dead or stopped deliveries whose payload is still held. **Redeliver** needs step-up and creates a new record linked to the original, marked `X-ReadyPackets-Replay: 1`.
- **Stop.** Queued or retrying deliveries can be stopped, which cancels the pending job.
- **Alerts.** `/admin/alerts` filters by severity, source and state, and staff and administrators can acknowledge and resolve. The waiting-order reminder is admin-only, off by default, and needs step-up to save. It runs once a day, raises one warning per waiting episode and sends no customer e-mail.
- **Lead QA.** In a browser, the lead checked a test delivery, the delivery detail, a Retry (attempt count 2), and acknowledging and resolving alerts. The lead also saw P101 auto-queued after a recorded manual payment. The dispatch reached `https://example.com` and got 405, which proves the transport but not the receiver. Redelivery records, the stop controls and inbound endpoints are covered by peer-reported automated tests.

## Consequences
- Failures surface once, on the dashboard and in the SIEM, instead of only in delivery logs.
- Signing an existing production endpoint needs a secret on both sides before it is switched on.
