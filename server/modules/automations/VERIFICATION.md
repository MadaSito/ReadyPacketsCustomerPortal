# Automations Module (`server/modules/automations`) — Verification Report

## Scope Implemented (Package J Server)
- **Data Model (`schema.ts`)**: Additive MySQL tables `automations`, `automation_versions`, `automation_secrets` (AES-256-GCM encrypted with per-row AAD `automation_secrets.secret_enc:<publicId>`, write-only `configured` + `last4`), `automation_runs` (`UNIQUE (automation_id, dedup_key)`), and `automation_run_steps` (`UNIQUE (run_id, step_index)`). Also added additive `staff_only` boolean default `false` on `engagement_notifications` (`server/modules/engagement/schema.ts`).
- **Registries & Peer Contracts (`contracts.ts`, `index.ts`)**: `registerAutomationTrigger` + `registerAutomationAction` with hard `assertAllowedActionKey` guardrails blocking order-status and role/permission mutations, and forwarding canonical `orderPublicId`, `filePublicId`, `staffOnlyTrigger`, `correlationId`, and `idempotencyKey` in `AutomationActionRunContext`.
- **Condition & Template Engine (`conditions.ts`, `templates.ts`)**: Typed AND/OR condition groups (`evaluateConditionTree` without expressions/code) and logic-less `{{field}}` placeholder validation/rendering with CRLF/control-character rejection and HMAC-SHA-256 `<timestamp>.<body>` webhook signing (`signAutomationWebhook`).
- **Worker Engine, Loop Protection & Rate Limits (`service.ts`, `builtinActions.ts`)**:
  - Ships disabled by default (`automations.config.enabled === false`); synchronous `AuditTap` listens only when globally enabled and at least one enabled automation matches `eventName`.
  - Durable origin marker `automation:<runPublicId>` propagated across `RequestContext`, `jobs.enqueue`, `mailer.enqueue`, `engagement`, `webhook.call`, and `audit.record` so events caused by automations never re-trigger automations.
  - `J-A01` staff-only trigger isolation: explicit default-deny allowlist (`STAFF_ONLY_ALLOWED_ACTION_KEYS = {"notification.send_in_app"}`) enforced at save AND worker run time; `notification.send_in_app` sets `staffOnly: true` + `skipEmail: true` and `engagement/notificationsService.ts` filters persisted `staff_only` rows with a single-statement correlated `EXISTS` check against live active `admin`/`staff` roles.
  - Per-automation hourly and global per-minute rate limits (`rate_limited`), retry with backoff on `retrySafe: true` transient failures, and `beforeSend` lease-fenced `webhook.call` via `integrations.egress.fetchPinned` (`unknown` / `partial_unknown` on post-`beforeSend` transport failure or lost lease — never dispatched twice).
- **API (`router.ts`, `authz.ts`)**: Mounted at `appRouter.automations` behind `automations.read` and `automations.manage` (step-up + in-transaction `users` `FOR UPDATE` + `identity.sessions.assertCurrent` re-validation).

## Increment 04 Part B — Package T2 (Workflow Stage Actions Server, B4)
- **Additive Schema (`schema.ts` + `migrations/0004_increment_04_part_b.sql`)**: Added nullable `order_public_id` (`char(26)`), `stage_step_key` (`varchar(48)`), `triggered_by_user_id` (`bigint unsigned`), and `automation_runs_order_queued_idx` `(order_public_id, queued_at, id)` on `automation_runs`.
- **Stage Action Binding & Execution (`contracts.ts`, `authz.ts`, `service.ts`, `router.ts`)**:
  - `automations.orderStageActions.{get, listRuns, runForOrder}` guarded by `staffProcedure.use(requireCapability("orders.automations.run"))` plus service-level `assertAutomationsCapabilityPreflight` and in-transaction `assertAutomationsActorInTx`.
  - Lists every step of the order's pinned workflow version with enabled event automations bound to that step (`order.created` on `initial`; `order.status_changed` whose `to_status` condition targets that step).
  - Enforces engine-enabled readiness (`NOT_CONFIGURED` / `AUTOMATIONS_DISABLED` with clear reason), per-run SHA-256 idempotency (`stage:<sha256>`), existing global and per-automation rate limits, order + actor tagging on `automation_runs`, and durable `order.stage_actions.run` audit event (`resource: { type: "order", publicId }`, `orderPublicId`, `attributes: { order_public_id, step_key }`).
  - Defense-in-depth `ACTION_PROHIBITED` check in `handleExecuteRunJob` guarantees stage-action runs cannot change order status or permissions even if persisted step rows are tampered at rest.

## Scoped Checks Executed
- `scripts/dev/tc.sh` (unfiltered workspace typecheck) — 0 errors in `server/modules/automations/**` and `client/src/features/engagement/**`
- `scripts/dev/lint.sh server/modules/automations client/src/features/engagement/routes.tsx` — 0 errors, 0 warnings
- `scripts/dev/test.sh server/modules/automations/automations.test.ts` — 12/12 real-MySQL tests passed
- `scripts/dev/test.sh client/src/features/engagement/engagement.test.tsx` — 7/7 jsdom + axe tests passed
