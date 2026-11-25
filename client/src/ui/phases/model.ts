/**
 * Pure helpers of the phase editor (increment 07 package A). The server validates everything again
 * (`validateStages` + the definition schema); these only keep the draft well-formed while editing.
 */
import { MAX_STAGES, STAGE_ACTION_KEYS, type StageActions, type WorkflowStage } from "@shared/workflowStages";
import { DEFAULT_STAGE_FILE_SYNC, DEFAULT_STAGE_FOLDERS } from "@shared/orderStageFileSync";

export interface PhaseStatusOption {
  key: string;
  /** Staff label from the status catalogue. */
  label: string;
  category?: "start" | "working" | "waiting" | "done" | "canceled";
  retired?: boolean;
}

export const MB = 1024 * 1024;

/** Lowercase key from a label: "Phase 1 intake" → "phase_1_intake" (never empty, never starting with a digit). */
export function keyFromLabel(label: string): string {
  const base = label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  const safe = /^[a-z]/.test(base) ? base : `phase_${base}`.replace(/_+$/, "");
  return safe.length >= 2 ? safe : "phase";
}

export function uniqueKey(wanted: string, taken: ReadonlySet<string>): string {
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${wanted.slice(0, 44)}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${wanted.slice(0, 30)}_${Date.now().toString(36)}`;
}

export function newStage(existing: readonly WorkflowStage[], statusKey: string | undefined): WorkflowStage {
  const label = `Phase ${existing.length + 1}`;
  const key = uniqueKey(keyFromLabel(label), new Set(existing.map((stage) => stage.key)));
  return {
    key,
    customerLabel: label,
    staffLabel: label,
    statusKeys: statusKey ? [statusKey] : [],
    actions: { uploadDocuments: false, answerQuestions: false, recordAudio: false, uploadAudio: false, teamFileReview: false },
    acknowledgement: { policy: "none" },
    progression: "next",
    adminTasks: [],
    folders: { ...DEFAULT_STAGE_FOLDERS },
    fileSync: { ...DEFAULT_STAGE_FILE_SYNC },
    completesOn: "manual",
    weight: 1,
  };
}

export function canAddStage(stages: readonly WorkflowStage[]): boolean {
  return stages.length < MAX_STAGES;
}

export function move<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}

export function removeAt<T>(list: readonly T[], index: number): T[] {
  return list.filter((_, position) => position !== index);
}

/** Errors for one phase: "stages.2.customerLabel" → { customerLabel: "…" }. "stages.2" → { "": "…" }. */
export function stageErrors(errors: Readonly<Record<string, string>>, index: number): Record<string, string> {
  const prefix = `stages.${index}`;
  const out: Record<string, string> = {};
  for (const [path, message] of Object.entries(errors)) {
    if (path === prefix) out[""] = message;
    else if (path.startsWith(`${prefix}.`)) out[path.slice(prefix.length + 1)] = message;
  }
  return out;
}

/** Sub-tree of a phase's errors: sub(errors, "stageActions") → { "completion": … }. */
export function subErrors(errors: Readonly<Record<string, string>>, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, message] of Object.entries(errors)) {
    if (path === prefix) out[""] = message;
    else if (path.startsWith(`${prefix}.`)) out[path.slice(prefix.length + 1)] = message;
  }
  return out;
}

/** First error of a field or any of its children ("statusKeys" also matches "statusKeys.0"). */
export function fieldError(errors: Readonly<Record<string, string>>, field: string): string | undefined {
  if (errors[field]) return errors[field];
  const child = Object.keys(errors).find((path) => path.startsWith(`${field}.`));
  return child ? errors[child] : undefined;
}

export function configuredActionCount(actions: StageActions | undefined): number {
  if (!actions) return 0;
  return [actions.emailTemplateKey, actions.setStatusKey, actions.completion, actions.webhookTargetKey, actions.dashboardAlert].filter((value) => value !== undefined && value !== null).length;
}

export function enabledCustomerActions(stage: WorkflowStage): number {
  return STAGE_ACTION_KEYS.filter((key) => stage.actions[key]).length;
}

/** Drops empty optional objects so the saved definition stays minimal (empty stageActions = nothing runs). */
export function compactStage(stage: WorkflowStage): WorkflowStage {
  const next: WorkflowStage = { ...stage };
  if (next.stageActions && configuredActionCount(next.stageActions) === 0 && Object.keys(next.stageActions).length === 0) delete next.stageActions;
  if (next.governance && Object.values(next.governance).every((value) => value === null || value === undefined)) delete next.governance;
  if (next.content && !next.content.markdown) delete next.content;
  return next;
}

/** Bytes → whole MB for the inputs (null stays blank). */
export function bytesToMb(bytes: number | null | undefined): string {
  return bytes === null || bytes === undefined ? "" : String(Math.max(1, Math.round(bytes / MB)));
}

/** Input text → integer or null (blank). Invalid text returns undefined (keep the old value, show an error). */
export function parseLimit(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (!/^\d{1,9}$/.test(trimmed)) return undefined;
  return Number(trimmed);
}
