# Administrator Guide — Phase Action Bundles, Completion Policies & Rule Ordering

## 1. Overview
Phase Action Bundles allow authorized staff and administrators to preview and execute a deterministic, confirmed set of phase actions against an order's **pinned workflow version**. Every bundle run is audited, idempotency-protected, and gated by MFA step-up.

Unattended event-driven automation rules remain strictly separated from order status and permission mutations (`PROHIBITED_ACTION_PREFIXES`), and existing orders are never retroactively re-pinned when a new workflow version is published.

All administrative and operator surfaces associated with these procedures are designed and tested against WCAG 2.2 AA.

## 2. Phase Action Bundle Slots (Execution Order)
When an operator previews (`automations.orderStageActions.previewBundle`) and confirms (`automations.orderStageActions.runBundle`) a stage bundle, configured slots execute in fixed order:
1. **`status`**: Transitions the order to the configured `targetStatusKey` via `orders.stages.applyStageStatus`. Non-adjacent transitions require an administrator and a `statusOverrideReason` (`>= 4` characters).
2. **`completion`**: Applies a `fixed` percentage (`0..100`) or draws a `range` percentage (`minPercent..maxPercent`) **once** on the server via CSPRNG (`crypto.randomInt`). Applies immediately (`delayMinutes = 0`) or schedules a fenced one-shot completion job (`1..43,200` minutes).
3. **`email`**: Renders and queues a published mail template (`templateKey`) to `customer`, `assigned_staff`, or `both`.
4. **`webhook`**: Enqueues a signed outbound delivery against a pre-configured `webhookSubscriptionPublicId` (raw URLs and inline secrets are never accepted in workflow definitions or rules).
5. **`alert`**: Emits a sanitized operational dashboard alert (`info`, `warning`, or `error`) via `opsAlerts`.

## 3. Confirmation Freshness, Order Locks & Global Kill Switch
- **Confirmation Token**: `previewBundle` returns a keyed HMAC `confirmationToken` (`stgc1_<64hex>`) bound to the operator, session, pinned workflow version, order version, status, lock state, assigned owner, completion revision, and slot availability. Any concurrent order change causes `runBundle` to decline with `STALE_STAGE_CONFIRMATION` and zero side effects, prompting the operator to re-preview.
- **Order Locks**: Orders in `legal_hold`, `imported_read_only`, or `finalized` lock states reject bundle previews, bundle runs, and delayed completion writes (`ORDER_LOCKED`).
- **Kill Switch**: Administrators can pause operator phase bundle runs globally via `automations.settings.update({ stageBundlesEnabled: false })` without disabling unattended rules (or vice versa).

## 4. Delayed Completion Jobs (`order_completion_jobs`)
- Scheduled jobs record `resolvedPercent` and `expectedRevision` at admission time.
- Jobs are automatically marked `superseded` (never overwriting newer state) if:
  - A newer completion update is applied (`SUPERSEDED_BY_NEWER_COMPLETION` / `REVISION_MISMATCH`),
  - The order leaves the originating stage (`STAGE_CHANGED`),
  - The order is canceled (`ORDER_CANCELED`), deleted (`ORDER_DELETED`), or locked (`ORDER_LOCKED`).
- Administrators can cancel a scheduled job at any time via `automations.orderStageActions.cancelCompletionJob` (`ADMIN_CANCELED`).
- If 3 worker attempts fail transiently, the job transitions to `failed` and raises a `COMPLETION_JOB_FAILED` operational alert.

## 5. Rule Ordering & New Triggers / Actions
- **Rule Ordering**: Administrators can reorder rules via `automations.reorder({ orderedPublicIds })`. Matching rules execute deterministically by `(sortOrder ASC, id ASC)`.
- **New Unattended Actions**: `order.set_completion`, `webhook.enqueue_subscription`, and `dashboard.create_alert`.
- **New Unattended Triggers**: `payment.succeeded`, `payment.failed` (staff-only), `payment.refunded`, `intake.submitted`, `intake.reviewed`, and `order.stage_submitted`. Payloads expose only safe scalar identifiers and metadata — never intake answers, payment instrument details, email addresses, or secrets.
