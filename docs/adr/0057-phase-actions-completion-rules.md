# 0057 — Phase actions, completion jobs and rule extensions

Status: Accepted (2026-11-25, after the lead's integrated QA of increment 07 at `7c6bb71`; verification in [STATUS.md](../application-context/STATUS.md#verification-for-increment-07))

## Context
The owner listed potential features, including:
- fixed or random-range completion percentages;
- immediate or delayed updates of up to 30 days;
- explicitly run phase bundles (status, completion, e-mail, dashboard alert, webhook);
- persisted run and job history;
- named, ordered rules with payment and intake triggers and value matching.

Automations exist ([ADR 0026](0026-automations.md), [ADR 0041](0041-order-automation-tab.md)). Changing an order's status without a person is a risk.

## Decision
- **Bundle shape.** `stageActions { emailTemplateKey?, setStatusKey?, completion?, webhookTargetKey?, dashboardAlert? }`, where:
  - `completion` is `{ kind: fixed, percent }` or `{ kind: range, min, max }`;
  - `delayMinutes` is 0–43,200 (30 days).

  An empty bundle runs nothing.
- **Run phase actions.**
  - Running a bundle needs `orders.stage.run` and step-up. The person previews it, then confirms with a server-bound confirmation token.
  - It runs the bundle of the pinned version and writes `order_stage_runs` (a snapshot, the result of each action, and the correlation id).
  - A status change is allowed **only** here: it is human-confirmed and also needs `orders.transition`.
- **Completion jobs** (`order_completion_jobs`).
  - The percentage of a range is drawn **once** on the server (`crypto.randomInt`) and stored.
  - Delayed updates are one-shot jobs on the existing queue, fenced by `orders.completion_revision`.
  - An administrator can cancel a job. A job is superseded by a newer write, a reopen, leaving the phase, or cancellation.
  - A job is retried at most 3 times; after that it raises a failure alert ([ADR 0058](0058-outbound-webhooks-and-operational-alerts.md)).
- **Rules** (existing automations):
  - `sort_order`, set with `automations.reorder`;
  - new actions `order.set_completion`, `webhook.enqueue_subscription` (managed subscription outbox, never a raw URL) and `dashboard.create_alert`;
  - new triggers `payment.succeeded`, `payment.failed`, `payment.refunded`, `intake.submitted`, `intake.reviewed` and `order.stage_submitted`;
  - the editor offers "All occurrences" or "Specific value", with real option lists (statuses from the catalogue, phases and payment outcomes).
- **Unattended rules never change status.**
- **Bundles switch.** `automations.stageBundlesEnabled` (default on) lets administrators run bundles while unattended rules stay off. A phase has no actions until an administrator configures them, so nothing runs after upgrade.
- **Hidden from customers.** Customers never see ranges, pending jobs, deliveries or alerts.
- **Not built.** Unattended rules that change order status, and raw URLs or secrets inside a workflow.

## Assumptions to confirm with the owner
- A random-range completion is drawn once per run and never re-drawn.
- Status changes stay human-confirmed even when a rule could make them.

## As implemented

Package F, from the owner's [automations API](../../server/modules/automations/API.md):

- **Guardrail.** No rule action may change order status, permissions, roles, credentials or platform settings. The status slot of a bundle is the only exception, and it needs a person.
- **Completion.** `order.set_completion` draws a range once with `crypto.randomInt(min, max + 1)`. The delayed job `automations.apply_completion` is fenced by the expected revision, the phase, the order lock and cancellation. After 3 failed attempts it raises an operational alert.
- **Cancelling.** An administrator with `automations.manage` and step-up cancels a scheduled completion job.
- **Retention.** A daily job purges finished runs, phase runs and completion jobs older than the run retention period.
- **Lead QA.** In a browser, the lead checked a bundle's preview and confirm, a fixed completion and a delayed range completion that survived a restart, the e-mail being queued, the alert, the P201 skip reason, the run summary and the counts. Delays of up to 30 days and the rule ordering, enabling and deleting are covered by peer-reported automated tests.

## Consequences
- Phase automation is repeatable and auditable. Nothing changes an order's status without a person.
- Workflows reference templates and webhook targets by key, so moving a workflow never moves a secret.
