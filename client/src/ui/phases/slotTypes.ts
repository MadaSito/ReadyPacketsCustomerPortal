/**
 * Increment 07 package A: contract for the three feature-owned regions inside the shared phase form.
 * Owners implement a component with these props at the glob path listed in `client/src/app/slots.tsx`;
 * the phase editor renders it through a lazy, error-bounded slot (missing or failing module = a neutral note).
 *
 * Rules for slot authors:
 * - Controlled only: render from `value`, report every change with `onChange(next)` (whole sub-value, immutable).
 * - No network writes. Reads (option lists) are fine; the workflow is saved by the host as one draft.
 * - Use `idPrefix` for element ids, so two phase cards never collide.
 * - Show `errors[path]` (server validation, paths relative to the slot value, "" = the whole value) on the field.
 * - Respect `disabled` (draft saving, read-only published version).
 * - Headings inside a slot start at `headingLevel` (the phase card owns the level above).
 */
export interface PhaseSlotContext {
  /** Stable key of this phase (stage). Empty while the administrator is still typing a new key. */
  stageKey: string;
  /** 0-based position of the phase in the workflow. */
  stageIndex: number;
  /** Status keys this phase uses (from the status catalogue). */
  stageStatusKeys: readonly string[];
  /** Every status key used by the workflow draft, in phase order. */
  workflowStatusKeys: readonly string[];
  /** Unique, stable per phase card; prefix every id with it. */
  idPrefix: string;
  disabled: boolean;
  /** Heading level for the slot's own section headings (3 or 4). */
  headingLevel: 3 | 4;
  /** Server validation messages keyed by path relative to `value` ("" for the whole value). */
  errors: Readonly<Record<string, string>>;
}

export interface PhaseSlotProps<V> extends PhaseSlotContext {
  value: V;
  onChange: (next: V) => void;
}

/** Value types per slot (from orders' shared stage schema). */
export type { StageActions, WorkflowStage } from "@shared/workflowStages";
import type { StageActions, WorkflowStage } from "@shared/workflowStages";
/** siem (G): the stage's actions without the webhook target (preserve unknown keys). */
export type PhaseActionsSlotValue = Omit<StageActions, "webhookTargetKey">;
/** integrations (K): `stageActions.webhookTargetKey`; null = "No webhook". */
export type PhaseWebhookSlotValue = string | null;
/** portable_ops (L): folders and file-sync targets of the stage. */
export type PhaseFileSyncSlotValue = Pick<WorkflowStage, "folders" | "fileSync">;
