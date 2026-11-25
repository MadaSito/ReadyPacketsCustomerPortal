# Automations Client Verification (`client/src/features/automations`)

Owner: `siem_engineer` (Increment 07 Package G — D5 client)

## Scope Verified

1. **Order Console Automation Panel (`OrderWorkflowStageActionsPanel.tsx`)**:
   - Full order Automation tab mode (`{ orderId }`) and scoped single-phase console mode (`{ orderId, stageKey }`).
   - Fail-closed readiness callouts when unattended rules (`engineEnabled`) or administrator-run phase bundles (`stageBundlesEnabled`) are turned off, plus safe empty state for Format 1/2 derived workflows (never re-pinning existing orders).
   - Pinned phase bundle cards showing `staffLabel`, customer phase label, `Current phase` badge, configured slot summaries/warnings, active scheduled completion badge, and last phase run summary.
   - Authoritative **Preview -> Confirm** flow (`previewBundle` -> SHA-256 `confirmationToken` -> `runBundle` inside `useStepUp()` with per-run idempotency key, mandatory administrator status override reason when `requiresAdminOverrideReason` is true, and automatic preview refresh on `STALE_STAGE_CONFIRMATION`).
   - Phase bundle run history (`recentStageRuns` + cursor pagination via `listBundleRuns`) and completion percentage updates (`recentCompletionJobs` + cursor pagination via `listCompletionJobs` + administrator **Cancel** confirmation dialog via `cancelCompletionJob`).
   - Fixed pre-existing bound-step row rendering bug so configured automation names and action labels render directly in the step list before opening `RunConfirm`.

2. **Portal Engine Controls & Deterministic Rule Ordering (`EnginePanel.tsx`, `AutomationsPage.tsx`)**:
   - Independent portal toggles for unattended rules (`enabled`) and administrator-run phase bundles (`stageBundlesEnabled`).
   - Deterministic `#Order` badges and accessible keyboard `Move up` / `Move down` controls (`>= 24 px` target size) backed by step-up `automations.reorder`.

3. **Rule Editor Pickers & D5 Action Editors (`model.ts`, `parts.tsx`)**:
   - Explicit `"All occurrences"` vs `"Specific value"` scope controls on triggers and conditions backed by real catalogue option lists (statuses, phases, workflows, questionnaires, payment methods/providers), while preserving multi-group condition trees without data loss.
   - Dedicated editors and client validation for `order.set_completion` (fixed/range `0..100%`, immediate or delayed up to `43,200` minutes / 30 days), `webhook.enqueue_subscription` (managed subscription picker, rejecting raw URLs and `staffOnly` triggers), and `dashboard.create_alert` (`warning | error | critical`, `{{field}}` templates, optional uppercase alert code).

4. **Workflow Phase Editor Slot (`phaseSlots.tsx`)**:
   - Named export `PhaseActionsSlot` implementing `PhaseSlotProps<PhaseActionsSlotValue>` for `client/src/app/slots.tsx`.
   - Edits `emailTemplateKey`, `setStatusKey`, `completion` (fixed/range + immediate/delayed up to 30 days), and `dashboardAlert` (with plain-text 280-character counter), preserving sibling keys such as `webhookTargetKey` and surfacing relative `errors[path]` entries.

## Automated Checks Executed

- `scripts/dev/test.sh client/src/features/automations/automations.test.tsx`: **21 passed** (includes light and dark theme axe checks via `pageA11y` and `expectNoAxeViolations`, designed and tested against WCAG 2.2 AA).
- `scripts/dev/test.sh client/src/features/automations/orderStageActions.test.tsx`: **19 passed** (includes light and dark theme axe checks on both the phase bundle panel and the preview-and-confirm dialog, designed and tested against WCAG 2.2 AA).
- `pnpm exec eslint client/src/features/automations server/modules/siem --max-warnings 0`: **0 errors, 0 warnings**.
- `scripts/dev/tc.sh`: **0 TypeScript errors** in `client/src/features/automations/**` and `server/modules/siem/**`.
