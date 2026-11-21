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

## Scoped Checks Executed
- `scripts/dev/tc.sh 'server/modules/automations|server/modules/engagement|server/container|server/trpc/root|client/src/features/automations'` — 0 errors
- `scripts/dev/lint.sh server/modules/automations server/modules/engagement` — 0 errors, 0 warnings
- `scripts/dev/test.sh server/modules/automations/automations.test.ts server/modules/engagement/engagement.test.ts` — 21/21 real-MySQL tests passed
