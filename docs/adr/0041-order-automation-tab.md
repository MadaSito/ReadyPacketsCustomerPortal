# 0041 — Order Automation tab: pipeline history, guarded redelivery, optional Phase III / IV and workflow stage actions (extends 0023 and 0026)

Status: Accepted (2026-11-21; owner confirmation requested for Phase III / IV)

## Context
The owner asks to see and start the Production Pipeline integrations from each order, as on the previous platform (increment 04 part B, decision B4). ADR 0023 defined P101 and P201 as manual, validated, outbox-delivered webhooks that are off by default.

## Decision
- The order's "Production" tab becomes **Automation**.
- Phase I (P101) and Phase II (P201) cards keep the payload preview and start buttons. A disabled button says why (pipeline off, endpoint missing, a precondition), and administrators get a link to the pipeline settings.
- "This order's pipeline history" lists every dispatch for the order with its phase, state, attempts, HTTP status, times and correlation id.
  - **Retry** (`orders.production.trigger`) resends a failed dispatch.
  - **Redeliver** applies to a dispatch that was already delivered. It creates a new delivery marked `redeliveryOf`, because the receiver may start a second production run. It needs `orders.production.redeliver` (administrators, step-up), a reason and the typed phrase `REDELIVER`.
- Optional **Phase III (P301)** and **Phase IV (P401)** endpoints can be added in the pipeline settings.
  - They use the same signing, egress pinning, outbox and reconciliation as P201, with the payload `{customer_id, order_id, run_mode}`.
  - Their start buttons appear only when the endpoint is configured.
  - Sequencing (assumed): P301 needs P101 and P201 delivered. P401 needs the same, plus P301 when a P301 endpoint is configured.
  - This is an assumption to confirm with the owner: the reference documents define only P101 and P201.
- Procedures:
  - `integrations.production.order.{preview,history,requestP101,requestP201,requestP301,requestP401,retry}` need `orders.production.trigger`. A retry is linked to its original through `retryOf`.
  - `integrations.production.order.redeliver` needs `orders.production.redeliver` plus step-up, and the server checks the reason and the phrase. It writes the audit event `integration.production.dispatch.redelivered`.
  - The settings procedures gain optional `p301Url` and `p401Url`.
- "Workflow stage actions" lists, for each step of the order's workflow version, the enabled automations bound to it ("N configured actions").
  - "Run actions" (`orders.automations.run`, staff and administrators) runs them for this order now through the automations engine.
  - The engine must be enabled; otherwise the panel shows a notice with a link.
  - Every run is recorded in the run history. Automations still cannot change status or permissions (0026).
- A "Webhook rules" note states that:
  - P201 must match P101 (`customer_id`, `order_id`, `run_mode`);
  - the bundle scope manifest is a JSON string;
  - P201 should not start before the Phase I artifacts exist.

## Consequences
- Redelivery can cause duplicate production work at the receiver. That is why it is restricted, needs step-up and a typed phrase, and is recorded with a link to the original delivery.
- Phase III and IV stay hidden until configured. They have not been verified against a real receiver.
