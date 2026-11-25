# Automations Module (`server/modules/automations`) — Verification Report

## Scope Implemented (Package J Server)
- **Data Model (`schema.ts`)**: Additive MySQL tables `automations`, `automation_versions`, `automation_secrets` (AES-256-GCM encrypted with per-row AAD `automation_secrets.secret_enc:<publicId>`, write-only `configured` + `last4`), `automation_runs` (`UNIQUE (automation_id, dedup_key)`), and `automation_run_steps` (`UNIQUE (run_id, step_index)`). Also added additive `staff_only` boolean default `false` on `engagement_notifications` (`server/modules/engagement/schema.ts`).
- **Registries & Peer Contracts (`contracts.ts`, `index.ts`)**: `registerAutomationTrigger` + `registerAutomationAction` with hard `assertAllowedActionKey` guardrails blocking order-status and role/permission mutations, and forwarding canonical `orderPublicId`, `filePublicId`, `staffOnlyTrigger`, `correlationId`, and `idempotencyKey` in `AutomationActionRunContext`.
- **Condition & Template Engine (`conditions.ts`, `templates.ts`)**: Typed AND/OR condition groups (`evaluateConditionTree` without expressions/code) and logic-less `{{field}}` placeholder validation/rendering with CRLF/control-character rejection and HMAC-SHA-256 `<timestamp>.<body>` webhook signing (`signAutomationWebhook`).
- **Worker Engine, Loop Protection & Rate Limits (`service.ts`, `templates.ts`, `builtinActions.ts`)**:
  - Ships disabled by default (`automations.config.enabled === false`); synchronous `AuditTap` listens only when globally enabled and at least one enabled automation matches `eventName`.
  - Durable origin marker `automation:<runPublicId>` propagated across `RequestContext`, `jobs.enqueue`, `mailer.enqueue`, `engagement`, `webhook.call`, and `audit.record` so events caused by automations never re-trigger automations.
  - `J-A01` staff-only trigger isolation: explicit default-deny allowlist (`STAFF_ONLY_ALLOWED_ACTION_KEYS = {"notification.send_in_app", "dashboard.create_alert"}`) enforced at save AND worker run time; `notification.send_in_app` sets `staffOnly: true` + `skipEmail: true`.
  - Per-automation hourly and global per-minute rate limits (`rate_limited`), retry with backoff on `retrySafe: true` transient failures, and `beforeSend` lease-fenced `webhook.call` via `integrations.egress.fetchPinned`.

## Increment 04 Part B — Package T2 (Workflow Stage Actions Server, B4)
- **Additive Schema (`schema.ts` + `migrations/0004_increment_04_part_b.sql`)**: Added nullable `order_public_id`, `stage_step_key`, `triggered_by_user_id`, and `automation_runs_order_queued_idx` on `automation_runs`.
- **Stage Action Binding & Execution (`contracts.ts`, `authz.ts`, `service.ts`, `router.ts`)**: `automations.orderStageActions.{get, listRuns, runForOrder}` guarded by `staffProcedure.use(requireCapability("orders.automations.run"))` plus service-level and in-transaction actor checks.

## Increment 07 — Package F (Phase Actions, Completion Policies, Rule Reordering & Picker Options, D5 Server)
- **Additive Schema (`schema.ts` + `migrations/0007_increment_07.sql`)**:
  - Added `sort_order INT UNSIGNED NOT NULL DEFAULT 0` + `(sort_order, id)` index on `automations`, with idempotent start-up backfill (`backfillAutomationSortOrder`).
  - Added `order_stage_runs` (`UNIQUE (order_id, idempotency_key)`, per-slot outcomes JSON, pinned `workflow_version_id`, actor/correlation metadata).
  - Added `order_completion_jobs` (`scheduled` / `applied` / `superseded` / `canceled` / `failed`, `resolved_percent` drawn once on the server via `crypto.randomInt(min, max + 1)`, `expected_revision` fencing).
- **Phase Action Bundle Runner (`stageBundles.ts`, `router.ts`, `settings.ts`)**:
  - Resolves `stageActions` strictly from the order's pinned `workflowVersionId` (existing orders are never re-pinned; later workflow publishes do not mutate pinned orders).
  - `previewBundle` / `listBundleRuns` / `listCompletionJobs` require `staffProcedure` + `orders.automations.run` (so operators can inspect and preview before MFA step-up); `previewBundle` computes a keyed HMAC confirmation token (`stgc1_<64hex>`) bound to `actorUserId`, `sessionId`, pinned `workflowVersionId`, live `orderVersion`, `statusKey`, `lockState`, `ownerUserId`, `completionRevision`, and slot availability.
  - `runBundle` requires `orders.stage.run`, active MFA step-up, `stageBundlesEnabled: true` (parsed with `.default(true)` for backward compatibility with older stored settings), `{ isolationLevel: "read committed" }`, and locking current reads (`orders` `FOR UPDATE`, `order_stage_runs` `FOR UPDATE`, `order_completion_jobs` `FOR SHARE`).
  - Declines stale confirmations with `STALE_STAGE_CONFIRMATION` and locked orders (`legal_hold`, `imported_read_only`, `finalized`) with `ORDER_LOCKED` with zero side effects, while replaying completed `(orderId, idempotencyKey)` calls idempotently (`deduplicated: true`) even under concurrent multi-session races.
  - Executes all 5 slots in deterministic order (`status` -> `completion` -> `email` -> `webhook` -> `alert`), requiring `admin` + `statusOverrideReason` for non-direct status overrides, and emits `opsAlerts` (`STAGE_BUNDLE_FAILED` / `STAGE_BUNDLE_PARTIAL`) on slot failures.
- **One-Shot Fenced Completion Jobs (`completionJobs.ts`)**:
  - Draws range completion once via `crypto.randomInt(min, max + 1)` and persists `resolved_percent`.
  - Immediate (`delayMinutes === 0`) updates apply synchronously via `orders.stages.applyCompletionPercent`; delayed updates enqueue `automations.apply_completion` (`1..43_200` minutes).
  - Supersedes older scheduled jobs on newer completion writes (`SUPERSEDED_BY_NEWER_COMPLETION`), stage departure (`STAGE_CHANGED`), order cancellation (`ORDER_CANCELED`), order deletion (`ORDER_DELETED`), order lock (`ORDER_LOCKED`), or revision mismatch (`REVISION_MISMATCH`), and supports admin-only `cancelCompletionJob` (`ADMIN_CANCELED`).
  - Emits `opsAlerts` (`COMPLETION_JOB_FAILED`) after 3 exhausted worker attempts.
- **Rule Ordering, Built-in Actions, Triggers & Picker Options (`service.ts`, `builtinActions.ts`, `catalogueOptions.ts`)**:
  - `automations.reorder` updates `sort_order` atomically behind `automations.manage` + step-up; `AuditTap` evaluates enabled rules in `(sortOrder ASC, id ASC)` order while preserving `PROHIBITED_ACTION_PREFIXES` on unattended rules.
  - Added built-in actions `order.set_completion`, `webhook.enqueue_subscription` (subscription-backed via `integrations.workflowWebhooks`, no raw URLs/secrets), and `dashboard.create_alert` (`opsAlerts.emit`, staff-only allowed).
  - Registered triggers `payment.succeeded`, `payment.failed` (`staffOnly: true`), `payment.refunded`, `intake.submitted`, `intake.reviewed`, and `order.stage_submitted` with safe allowlisted scalar fields (no intake answers, card details, email addresses, or secrets).
  - Added `automations.catalogue.pickerOptions` surfacing live status catalogue entries, active mail templates, enabled webhook subscriptions, workflow stage keys, and alert severities.

## Scoped Checks Executed (Increment 07)
- `scripts/dev/tc.sh` — 0 TypeScript errors across workspace
- `source scripts/dev/env.sh && pnpm exec eslint server/modules/automations --max-warnings 0` — 0 errors, 0 warnings
- `scripts/dev/test.sh server/modules/automations/phaseActions.test.ts` — 6/6 real-MySQL integration & security tests passed
- `scripts/dev/test.sh server/modules/automations/automations.test.ts` — 12/12 real-MySQL regression tests passed
