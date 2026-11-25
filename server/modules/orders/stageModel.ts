/**
 * Increment 07 (D1): pure helpers for format-3 workflows ("Phases" in the UI; `stage` in code).
 *
 * A format-3 definition stores `stages` and no `phases` / `state.phase`. At runtime (`workflows.byVersionId`) the
 * definition is COMPILED onto the format-2 machinery: `phases` = the stages and `state.phase` = the owning stage, so
 * requirement slots, `order_phase_locks` (keyed by stage key) and gates work unchanged. Formats 1 and 2 show derived
 * stages (`deriveStages`) that never lock and never run actions.
 */
import { deriveStages, type WorkflowStage } from "../../../shared/workflowStages.js";
import type { WorkflowDefinition, WorkflowState } from "./workflowTypes.js";

export type WorkflowFormat = 1 | 2 | 3;

export interface StageModel {
  format: WorkflowFormat;
  derived: boolean;
  stages: WorkflowStage[];
  /** status key → stage key (statuses outside every stage, e.g. canceled, are absent). */
  statusToStage: Map<string, string>;
}

export function workflowFormatOf(definition: Pick<WorkflowDefinition, "stages" | "phases" | "states">): WorkflowFormat {
  if (definition.stages?.length) return 3;
  if (definition.phases?.length || definition.states.some((state) => state.requirements)) return 2;
  return 1;
}

/** Runtime copy of a stored definition: format 3 gains `phases` + `state.phase` from its stages; others unchanged. */
export function compileRuntimeDefinition(definition: WorkflowDefinition): WorkflowDefinition {
  const stages = definition.stages;
  if (!stages?.length) return definition;
  const owner = new Map<string, string>();
  for (const stage of stages) for (const key of stage.statusKeys) if (!owner.has(key)) owner.set(key, stage.key);
  return {
    ...definition,
    phases: stages.map((stage) => ({ key: stage.key, label: stage.customerLabel })),
    states: definition.states.map((state): WorkflowState => {
      const phase = owner.get(state.key);
      if (phase) return { ...state, phase };
      const { phase: _ignored, ...rest } = state;
      return rest;
    }),
  };
}

const modelCache = new WeakMap<WorkflowDefinition, StageModel>();

/** Stages of a (runtime or stored) definition: explicit for format 3, derived otherwise. */
export function stageModelOf(definition: WorkflowDefinition): StageModel {
  const cached = modelCache.get(definition);
  if (cached) return cached;
  const format = workflowFormatOf(definition);
  const stages = format === 3 ? definition.stages! : deriveStages(definition);
  const statusToStage = new Map<string, string>();
  for (const stage of stages) for (const key of stage.statusKeys) if (!statusToStage.has(key)) statusToStage.set(key, stage.key);
  const model: StageModel = { format, derived: format !== 3, stages, statusToStage };
  modelCache.set(definition, model);
  return model;
}

export function stageIndexOfStatus(model: StageModel, statusKey: string): number {
  const key = model.statusToStage.get(statusKey);
  return key === undefined ? -1 : model.stages.findIndex((stage) => stage.key === key);
}

/** Any customer-facing action or a submit-and-lock step makes a stage "actionable" (D3). */
export function stageHasCustomerWork(stage: WorkflowStage): boolean {
  return stage.progression === "submit_lock" || Object.values(stage.actions).some(Boolean);
}

/** The text a customer acknowledges when a submit-and-lock phase has no custom message. */
export const STANDARD_LOCK_WARNING =
  "When you submit this phase it is locked. You will not be able to add, change or remove anything in it unless our team reopens it.";

export function stageAckText(stage: Pick<WorkflowStage, "acknowledgement">): string {
  const message = stage.acknowledgement.message?.trim();
  return message ? message : STANDARD_LOCK_WARNING;
}

/* ------------------------------------------------------------------ seeded standard workflow (format 3) */

export const STANDARD_V3_WORKFLOW_KEY = "readypackets_standard";
export const STANDARD_V3_WORKFLOW_NAME = "ReadyPackets standard workflow";

const off = { uploadDocuments: false, answerQuestions: false, recordAudio: false, uploadAudio: false, teamFileReview: false };
const folders = { documents: "{phase_key}/Docs", audio: "{phase_key}/Audio" };
const fileSync = { originals: null, conversionStaging: null, intakeDelivery: null };

/**
 * Seeded on new installs as the published default, and prepared as a DRAFT on upgrade (never published for the
 * administrator). Status keys match recovery_ops' built-in status catalogue (`BUILT_IN_STATUS_CATALOG`).
 */
export const STANDARD_V3_DEFINITION: WorkflowDefinition = {
  states: [
    { key: "awaiting_payment", label: "Awaiting payment", customerLabel: "Awaiting payment", kind: "initial", tone: "warning" },
    { key: "intake_open", label: "Intake open", customerLabel: "Upload your materials", kind: "active", tone: "warning" },
    { key: "in_review", label: "Intake review", customerLabel: "In review", kind: "active", tone: "info" },
    { key: "in_progress", label: "Synthesis", customerLabel: "In progress", kind: "active", tone: "info" },
    { key: "awaiting_customer", label: "Customer review", customerLabel: "Ready for your review", kind: "active", tone: "warning" },
    { key: "revisions", label: "Revisions", customerLabel: "Revisions in progress", kind: "active", tone: "info" },
    { key: "delivery_preparing", label: "Preparing delivery", customerLabel: "Preparing delivery", kind: "active", tone: "info" },
    { key: "delivered", label: "Delivered", customerLabel: "Delivered", kind: "active", tone: "success" },
    { key: "completed", label: "Closed", customerLabel: "Closed", kind: "terminal", tone: "success" },
    { key: "canceled", label: "Canceled", customerLabel: "Canceled", kind: "terminal", tone: "neutral" },
  ],
  transitions: [
    { from: "awaiting_payment", to: "intake_open", allowedBy: ["staff", "admin", "api"], notifyCustomer: true, requiresNote: false, actionLabel: "Confirm payment" },
    { from: "awaiting_payment", to: "canceled", allowedBy: ["customer", "staff", "admin"], notifyCustomer: true, requiresNote: false },
    { from: "intake_open", to: "in_review", allowedBy: ["customer", "staff", "admin"], notifyCustomer: false, requiresNote: false, actionLabel: "Submit intake" },
    { from: "intake_open", to: "canceled", allowedBy: ["staff", "admin"], notifyCustomer: true, requiresNote: true },
    { from: "in_review", to: "intake_open", allowedBy: ["staff", "admin"], notifyCustomer: true, requiresNote: true, actionLabel: "Ask for more information" },
    { from: "in_review", to: "in_progress", allowedBy: ["staff", "admin"], notifyCustomer: true, requiresNote: false, actionLabel: "Start synthesis" },
    { from: "in_review", to: "canceled", allowedBy: ["staff", "admin"], notifyCustomer: true, requiresNote: true },
    { from: "in_progress", to: "awaiting_customer", allowedBy: ["staff", "admin"], notifyCustomer: true, requiresNote: false, actionLabel: "Send for customer review" },
    { from: "in_progress", to: "canceled", allowedBy: ["admin"], notifyCustomer: true, requiresNote: true },
    { from: "awaiting_customer", to: "delivery_preparing", allowedBy: ["customer", "staff", "admin"], notifyCustomer: false, requiresNote: false, actionLabel: "Approve" },
    { from: "awaiting_customer", to: "revisions", allowedBy: ["customer", "staff", "admin"], notifyCustomer: false, requiresNote: true, actionLabel: "Request changes" },
    { from: "revisions", to: "awaiting_customer", allowedBy: ["staff", "admin"], notifyCustomer: true, requiresNote: false, actionLabel: "Send revised version" },
    { from: "delivery_preparing", to: "delivered", allowedBy: ["staff", "admin"], notifyCustomer: true, requiresNote: false, actionLabel: "Deliver" },
    { from: "delivered", to: "completed", allowedBy: ["customer", "staff", "admin"], notifyCustomer: true, requiresNote: false, actionLabel: "Close order" },
    { from: "delivered", to: "delivery_preparing", allowedBy: ["staff", "admin"], notifyCustomer: true, requiresNote: true, actionLabel: "Reopen delivery" },
  ],
  stages: [
    {
      key: "payment_confirmed",
      customerLabel: "Payment confirmed",
      staffLabel: "Payment confirmed",
      statusKeys: ["awaiting_payment"],
      actions: { ...off },
      folders: { ...folders },
      fileSync: { ...fileSync },
      acknowledgement: { policy: "none" },
      progression: "next",
      adminTasks: [],
      completesOn: "payment",
      weight: 1,
    },
    {
      key: "phase_1_intake",
      customerLabel: "Phase 1 intake",
      staffLabel: "Phase 1 intake",
      statusKeys: ["intake_open", "in_review"],
      actions: { uploadDocuments: true, answerQuestions: true, recordAudio: true, uploadAudio: true, teamFileReview: false },
      folders: { ...folders },
      fileSync: { ...fileSync },
      acknowledgement: { policy: "required" },
      progression: "submit_lock",
      adminTasks: ["assign_questions", "review_submission"],
      completesOn: "manual",
      weight: 1,
    },
    {
      key: "phase_2_synthesis",
      customerLabel: "Phase 2 synthesis",
      staffLabel: "Phase 2 synthesis",
      statusKeys: ["in_progress"],
      actions: { ...off },
      folders: { ...folders },
      fileSync: { ...fileSync },
      acknowledgement: { policy: "none" },
      progression: "next",
      adminTasks: ["upload_team_document", "run_automation"],
      completesOn: "manual",
      weight: 1,
    },
    {
      key: "phase_3_review",
      customerLabel: "Phase 3 review",
      staffLabel: "Phase 3 review",
      statusKeys: ["awaiting_customer", "revisions"],
      actions: { uploadDocuments: true, answerQuestions: true, recordAudio: false, uploadAudio: false, teamFileReview: true },
      folders: { ...folders },
      fileSync: { ...fileSync },
      acknowledgement: { policy: "none" },
      progression: "next",
      adminTasks: ["upload_team_document", "assign_questions"],
      completesOn: "manual",
      weight: 1,
    },
    {
      key: "phase_4_delivery",
      customerLabel: "Phase 4 delivery",
      staffLabel: "Phase 4 delivery",
      statusKeys: ["delivery_preparing"],
      actions: { ...off },
      folders: { ...folders },
      fileSync: { ...fileSync },
      acknowledgement: { policy: "none" },
      progression: "next",
      adminTasks: ["upload_team_document"],
      completesOn: "manual",
      weight: 1,
    },
    {
      key: "delivered",
      customerLabel: "Delivered",
      staffLabel: "Delivered",
      statusKeys: ["delivered"],
      actions: { ...off },
      folders: { ...folders },
      fileSync: { ...fileSync },
      acknowledgement: { policy: "none" },
      progression: "next",
      adminTasks: [],
      completesOn: "manual",
      weight: 1,
    },
    {
      key: "closed",
      customerLabel: "Closed",
      staffLabel: "Closed",
      statusKeys: ["completed"],
      actions: { ...off },
      folders: { ...folders },
      fileSync: { ...fileSync },
      acknowledgement: { policy: "none" },
      progression: "next",
      adminTasks: [],
      completesOn: "manual",
      weight: 1,
    },
  ],
};
