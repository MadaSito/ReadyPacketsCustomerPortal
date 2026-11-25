# Automations Feature Client Contract (`client/src/features/automations`)

Owner: `siem_engineer` (Increment 07 Package G — D5 client).
Server contract: `server/modules/automations/API.md` (`engagement_engineer`).
Shared stage schema: `shared/workflowStages.ts` (`orders_engineer`).

User-facing copy always uses **"Phase"** (code uses `stage`). Designed and tested against WCAG 2.2 AA.

---

## 1. Lazy Cross-Feature Slots & Panels

Peer features never import `client/src/features/automations/**` statically (`registry.test.ts` boundary). Use `import.meta.glob` wrapped in `OptionalSlotBoundary` + `Suspense`.

### 1.1 `OrderWorkflowStageActionsPanel` (`./OrderWorkflowStageActionsPanel.tsx`)

Default export consumed by:
- `client/src/features/integrations/production/OrderProductionTab.tsx` on `/admin/orders/:orderId/automation` (`{ orderId }`)
- `OrderPhaseConsolePanel` (`assurance_engineer`, D4 console phase workspace) (`{ orderId, stageKey }`)

```ts
export interface OrderWorkflowStageActionsPanelProps {
  /** Order `publicId` from route/workspace context. */
  orderId: string;
  /**
   * Optional pinned workflow `stage.key`.
   * - Omitted (`undefined`): renders the full order Automation tab panel (all pinned phases,
   *   `stageBundlesEnabled` banner, Preview -> Confirm "Run phase actions" dialog, per-slot
   *   stage run history, bound rule runs, and `order_completion_jobs` with Cancel).
   * - Provided (`stageKey`): renders the compact scoped panel for that single phase inside the
   *   D4 console phase view (that phase's pinned action bundle, Preview -> Confirm trigger,
   *   recent runs for that phase, and active completion jobs for that phase).
   */
  stageKey?: string;
}

export default function OrderWorkflowStageActionsPanel(
  props: OrderWorkflowStageActionsPanelProps,
): JSX.Element | null;
```

**Capabilities, preview-to-confirm token & step-up:**
- Renders `null` when the signed-in staff/admin principal lacks both `orders.stage.run` and `orders.automations.run`.
- Opening a phase preview queries `trpc.automations.orderStageActions.previewBundle({ orderPublicId, stageKey })`, which returns slot-by-slot previews, status transition metadata (`requiresAdminOverrideReason`), and a 64-character SHA-256 `confirmationToken` bound to the pinned workflow and live order state.
- Confirming a phase run wraps `trpc.automations.orderStageActions.runBundle({ orderPublicId, stageKey, idempotencyKey, confirmationToken, statusOverrideReason? })` inside `useStepUp()` (`orders.stage.run`). If the server rejects with `STALE_STAGE_CONFIRMATION`, the dialog automatically refetches `previewBundle` and prompts the operator to confirm the updated preview.
- Canceling a `scheduled` completion job calls `trpc.automations.orderStageActions.cancelCompletionJob({ completionJobPublicId, reason? })` inside `useStepUp()` after an explicit `ConfirmDialog`.
- Phase bundle run history (`listBundleRuns`) and completion updates (`listCompletionJobs`) seed from `orderStageActions.get` and paginate on demand.

### 1.2 `PhaseActionsSlot` (`./phaseSlots.tsx`)

Named export consumed by `client/src/app/slots.tsx` (`ui_foundation_engineer`, Package A shared phase editor form):

```ts
import type { StageActions } from "@shared/workflowStages";
import type { PhaseSlotProps } from "@/ui/phases/slotTypes";

export type PhaseActionsSlotValue = Omit<StageActions, "webhookTargetKey"> & Record<string, unknown>;

export function PhaseActionsSlot(props: PhaseSlotProps<PhaseActionsSlotValue>): JSX.Element;
```

**Slot behavior:**
- Renders inside the parent `"Administrator-run stage actions"` section frame without an outer card.
- Edits four optional slots on `stage.stageActions`:
  1. `emailTemplateKey`: `"No customer e-mail"` or a published phase-compatible template from `trpc.mailTemplates.listForPhaseActions`.
  2. `setStatusKey`: `"Do not change status"` or a status in `workflowStatusKeys` (labelled via status catalogue query with fallback to key).
  3. `completion`: `"Do not set completion"`, `"Fixed percentage"` (`0..100`), or `"Random range"` (`0 <= min <= max <= 100`), with timing `"Immediate"` (`delayMinutes: 0`) or `"Delayed"` (`1..43,200` minutes / up to 30 days).
  4. `dashboardAlert`: `"No dashboard alert"` or `{ severity: "warning" | "error" | "critical", text: string (1..280 plain text) }`.
- Never renders or overwrites `webhookTargetKey` (owned by `integrations_engineer` Package K slot); `onChange` spreads incoming `value` so unknown sibling keys are preserved, and strips keys set to `"none"` / off.
- Controlled only (performs no mutations); prefixes every control ID with `idPrefix` and binds `errors["emailTemplateKey"]`, `errors["setStatusKey"]`, `errors["completion"]`, and `errors["dashboardAlert"]` (plus nested subpaths if present).

---

## 2. Console Pages (`/admin/automations/**`)

- **`/admin/automations` (`AutomationsPage.tsx` + `EnginePanel.tsx`)**:
  - Separate portal switches for unattended event/schedule rules (`enabled`) and administrator-run phase bundles (`stageBundlesEnabled`), plus rate-limit settings.
  - Deterministic rule evaluation order with accessible `Move up` / `Move down` keyboard controls (`>= 24 px` target size, step-up protected `automations.reorder`).
- **`/admin/automations/new` & `/admin/automations/:automationId/edit` (`AutomationEditorPage.tsx`, `parts.tsx`, `model.ts`)**:
  - Shared draft across step-by-step Wizard and FlowCanvas.
  - Trigger scope pickers: explicit `"All occurrences"` vs `"Specific value"` mode backed by real option lists (statuses, phases, payment outcomes, questionnaires) from `automations.catalogue`, while preserving full editability of multi-group condition trees on existing rules.
  - Unattended action editors for `order.set_completion` (fixed/range, immediate or delayed up to 30 days / `43,200` minutes), `webhook.enqueue_subscription` (managed subscription picker — never a raw URL; blocked on `staffOnly` triggers), and `dashboard.create_alert` (`warning | error | critical` + plain text). Unattended rules never change order status.
