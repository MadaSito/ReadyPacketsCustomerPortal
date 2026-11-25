/**
 * Increment 07 (D1) — format-3 workflow stages ("Phases" in the UI). Shared by the server (orders module validates
 * and compiles) and the client (phase editor). Data only: never code, scripts, URLs or secrets.
 *
 * Owner: orders_engineer. Consumers: ui_foundation (A), audit (E), engagement (F), siem (G), files (I),
 * integrations (K), portable_ops (L). Every field is additive; a definition without `stages` is format 1/2 and
 * shows derived stages (see `deriveStages`).
 */
import { z } from "zod";
import { isOrderFileFolderTemplate } from "./orderFileFolder.js";

export const MAX_STAGES = 20;
export const MAX_STAGE_STATUSES = 10;
export const STAGE_ACK_MESSAGE_MAX = 2000;
export const STAGE_MARKDOWN_MAX = 4000;
export const STAGE_ALERT_TEXT_MAX = 280;
export const STAGE_COMPLETION_DELAY_MAX_MINUTES = 43_200; // 30 days
export const STAGE_WEIGHT_MAX = 100;
export const STAGE_FOLDER_MAX = 400;

export const STAGE_ACTION_KEYS = ["uploadDocuments", "answerQuestions", "recordAudio", "uploadAudio", "teamFileReview"] as const;
export type StageActionKey = (typeof STAGE_ACTION_KEYS)[number];
export const STAGE_ACK_POLICIES = ["required", "optional", "none"] as const;
export type StageAckPolicy = (typeof STAGE_ACK_POLICIES)[number];
export const STAGE_PROGRESSIONS = ["next", "submit_lock"] as const;
export type StageProgression = (typeof STAGE_PROGRESSIONS)[number];
export const STAGE_ADMIN_TASKS = ["upload_team_document", "assign_questions", "review_submission", "run_automation"] as const;
export type StageAdminTask = (typeof STAGE_ADMIN_TASKS)[number];
export const STAGE_COMPLETES_ON = ["manual", "payment"] as const;
export type StageCompletesOn = (typeof STAGE_COMPLETES_ON)[number];
export const STAGE_ALERT_SEVERITIES = ["warning", "error", "critical"] as const;
export type StageAlertSeverity = (typeof STAGE_ALERT_SEVERITIES)[number];
/** Runtime state of a stage on one order (`order_stage_progress.state`; `locked_ahead` / `not_started` are derived, never stored). */
export const STAGE_RUN_STATES = ["open", "submitted", "in_review", "accepted", "reopened"] as const;
export type StageRunState = (typeof STAGE_RUN_STATES)[number];
/** Upload intents for phase binding (files_engineer, D8). */
export const STAGE_UPLOAD_INTENTS = ["document", "recording", "prerecorded_audio", "document_edit", "legacy"] as const;
export type StageUploadIntent = (typeof STAGE_UPLOAD_INTENTS)[number];

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const stageKeySchema = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z][a-z0-9_]*$/, "Use lowercase letters, digits and underscores.");
const stageLabel = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .transform((value) => value.normalize("NFC"));

/** Plain text (no markup), control characters stripped, NFC. `min` 0 allows an empty value. */
export function stagePlainText(max: number, min = 1) {
  return z
    .string()
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .transform((value) => value.normalize("NFC").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim())
    .pipe(z.string().min(min).max(max).refine((value) => !/<\s*[a-z!/?]/i.test(value), "Use plain text without markup."));
}

const nullableInt = (min: number, max: number) => z.number().int().min(min).max(max).nullable().optional();

/** D8 per-phase upload governance. Null or absent = the platform limit; the tightest of platform, phase and task applies. */
export const stageGovernanceSchema = z.strictObject({
  documentCount: nullableInt(0, 200),
  documentMaxBytes: nullableInt(1, 5 * 1024 * 1024 * 1024),
  audioCount: nullableInt(0, 200),
  audioMaxBytes: nullableInt(1, 5 * 1024 * 1024 * 1024),
  recordingMaxSeconds: nullableInt(1, 4 * 3600),
  totalAudioMaxSeconds: nullableInt(1, 24 * 3600),
});
export type StageGovernance = z.output<typeof stageGovernanceSchema>;

const folderTemplate = z
  .string()
  .trim()
  .max(STAGE_FOLDER_MAX)
  .refine((value) => isOrderFileFolderTemplate(value), "Use a relative folder path of at most 8 parts with the listed tokens only.");

/** D12 folders inside the managed order root. Absent = the phase's safe default (`{phase_key}/Docs`, `{phase_key}/Audio`). */
export const stageFoldersSchema = z.strictObject({ documents: folderTemplate.optional(), audio: folderTemplate.optional() });

/** D12 file sync targets: an approved storage target public id, or null = "Do not transfer". Validated by portable_ops. */
const syncTarget = z.string().regex(ULID).nullable();
export const stageFileSyncSchema = z.strictObject({ originals: syncTarget, conversionStaging: syncTarget, intakeDelivery: syncTarget });

export const stageAcknowledgementSchema = z.strictObject({
  policy: z.enum(STAGE_ACK_POLICIES),
  /** Empty or absent = the portal's standard irreversible-lock warning. */
  message: stagePlainText(STAGE_ACK_MESSAGE_MAX, 0).optional(),
});

/** Safe Markdown source; rendered only by the shared safe renderer. Raw HTML is refused. */
export const stageContentSchema = z.strictObject({ markdown: stagePlainText(STAGE_MARKDOWN_MAX) });

const delayMinutes = z.number().int().min(0).max(STAGE_COMPLETION_DELAY_MAX_MINUTES).default(0);
export const stageCompletionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("fixed"), percent: z.number().int().min(0).max(100), delayMinutes }),
  z.strictObject({ kind: z.literal("range"), min: z.number().int().min(0).max(100), max: z.number().int().min(0).max(100), delayMinutes }),
]);
export type StageCompletion = z.output<typeof stageCompletionSchema>;

/** D7 target keys: canonical production webhooks or a managed subscription. Never a URL. */
export const STAGE_WEBHOOK_TARGET = /^(production:P[1-4]01|subscription:[0-9A-HJKMNP-TV-Z]{26})$/;
export const stageActionsSchema = z.strictObject({
  emailTemplateKey: z.string().regex(/^[a-z][a-z0-9_.-]{1,79}$/).optional(),
  setStatusKey: stageKeySchema.optional(),
  completion: stageCompletionSchema.optional(),
  webhookTargetKey: z.string().regex(STAGE_WEBHOOK_TARGET).optional(),
  dashboardAlert: z.strictObject({ severity: z.enum(STAGE_ALERT_SEVERITIES), text: stagePlainText(STAGE_ALERT_TEXT_MAX) }).optional(),
});
export type StageActions = z.output<typeof stageActionsSchema>;

export const stageActionsEnabledSchema = z.strictObject({
  uploadDocuments: z.boolean().default(false),
  answerQuestions: z.boolean().default(false),
  recordAudio: z.boolean().default(false),
  uploadAudio: z.boolean().default(false),
  teamFileReview: z.boolean().default(false),
});

export const workflowStageSchema = z.strictObject({
  key: stageKeySchema,
  customerLabel: stageLabel,
  staffLabel: stageLabel,
  /** Statuses (catalogue keys, D2) that belong to this phase. Each status belongs to at most one phase. */
  statusKeys: z.array(stageKeySchema).min(1).max(MAX_STAGE_STATUSES),
  actions: stageActionsEnabledSchema,
  governance: stageGovernanceSchema.optional(),
  folders: stageFoldersSchema.optional(),
  fileSync: stageFileSyncSchema.optional(),
  acknowledgement: stageAcknowledgementSchema.default({ policy: "none" }),
  content: stageContentSchema.optional(),
  progression: z.enum(STAGE_PROGRESSIONS).default("next"),
  adminTasks: z.array(z.enum(STAGE_ADMIN_TASKS)).max(STAGE_ADMIN_TASKS.length).default([]),
  /** Empty or absent = nothing runs (D5 default). */
  stageActions: stageActionsSchema.optional(),
  completesOn: z.enum(STAGE_COMPLETES_ON).default("manual"),
  weight: z.number().int().min(1).max(STAGE_WEIGHT_MAX).default(1),
});
export type WorkflowStage = z.output<typeof workflowStageSchema>;
export type WorkflowStageInput = z.input<typeof workflowStageSchema>;

export const workflowStagesSchema = z.array(workflowStageSchema).min(1).max(MAX_STAGES);

export interface StageIssue {
  path: (string | number)[];
  code: string;
  message: string;
}

/**
 * Cross-field rules for `stages[]` against the definition's status keys. Returns issues (empty = valid); the
 * server adds them to the definition's superRefine and the designer shows them at the field.
 */
export function validateStages(stages: readonly WorkflowStage[], statusKeys: ReadonlySet<string>): StageIssue[] {
  const issues: StageIssue[] = [];
  const keys = new Set<string>();
  const owner = new Map<string, string>();
  let paymentStages = 0;
  stages.forEach((stage, index) => {
    const at = (...rest: (string | number)[]) => ["stages", index, ...rest];
    if (keys.has(stage.key)) issues.push({ path: at("key"), code: "STAGE_KEY_DUPLICATE", message: `Phase key ${stage.key} is used twice.` });
    keys.add(stage.key);
    stage.statusKeys.forEach((statusKey, position) => {
      if (!statusKeys.has(statusKey))
        issues.push({ path: at("statusKeys", position), code: "STAGE_STATUS_UNKNOWN", message: `Phase ${stage.customerLabel} names a status that is not in this workflow.` });
      const taken = owner.get(statusKey);
      if (taken !== undefined && taken !== stage.key)
        issues.push({ path: at("statusKeys", position), code: "STAGE_STATUS_SHARED", message: `A status can belong to one phase only (${statusKey} is also in ${taken}).` });
      owner.set(statusKey, stage.key);
    });
    if (new Set(stage.statusKeys).size !== stage.statusKeys.length)
      issues.push({ path: at("statusKeys"), code: "STAGE_STATUS_DUPLICATE", message: `Phase ${stage.customerLabel} lists a status twice.` });
    if (new Set(stage.adminTasks).size !== stage.adminTasks.length)
      issues.push({ path: at("adminTasks"), code: "STAGE_TASK_DUPLICATE", message: `Phase ${stage.customerLabel} lists an administrator task twice.` });
    const completion = stage.stageActions?.completion;
    if (completion?.kind === "range" && completion.min > completion.max)
      issues.push({ path: at("stageActions", "completion"), code: "STAGE_COMPLETION_RANGE", message: "The lowest percentage must not be above the highest." });
    const target = stage.stageActions?.setStatusKey;
    if (target !== undefined && !statusKeys.has(target))
      issues.push({ path: at("stageActions", "setStatusKey"), code: "STAGE_STATUS_UNKNOWN", message: "The status update names a status that is not in this workflow." });
    if (stage.completesOn === "payment") paymentStages += 1;
  });
  if (paymentStages > 1) issues.push({ path: ["stages"], code: "STAGE_PAYMENT_MULTIPLE", message: "Only one phase can complete on payment." });
  return issues;
}

/** Minimal shape of a format 1/2 definition needed to derive stages (kept here so the client can preview). */
export interface DerivableDefinition {
  states: readonly { key: string; label: string; customerLabel: string; kind: string; phase?: string; requirements?: unknown }[];
  phases?: readonly { key: string; label: string }[];
}

/**
 * Derived stages for formats 1 and 2: one per phase group (statuses in order of first appearance), else one per
 * non-terminal status. Derived stages never lock, never run actions and have weight 1.
 */
export function deriveStages(definition: DerivableDefinition): WorkflowStage[] {
  const base = (key: string, customerLabel: string, staffLabel: string, statusKeys: string[]): WorkflowStage => ({
    key,
    customerLabel,
    staffLabel,
    statusKeys,
    actions: { uploadDocuments: false, answerQuestions: false, recordAudio: false, uploadAudio: false, teamFileReview: false },
    acknowledgement: { policy: "none" },
    progression: "next",
    adminTasks: [],
    completesOn: "manual",
    weight: 1,
  });
  const phases = definition.phases ?? [];
  if (phases.length > 0) {
    const out: WorkflowStage[] = [];
    for (const phase of phases) {
      const statusKeys = definition.states.filter((state) => state.phase === phase.key).map((state) => state.key);
      if (statusKeys.length) out.push(base(phase.key, phase.label, phase.label, statusKeys));
    }
    const loose = definition.states.filter((state) => !state.phase || !phases.some((phase) => phase.key === state.phase));
    for (const state of loose) out.push(base(state.key, state.customerLabel, state.label, [state.key]));
    return out.slice(0, MAX_STAGES);
  }
  return definition.states
    .filter((state) => state.kind !== "terminal" || /complet|deliver|done|closed/.test(state.key))
    .filter((state) => !/cancel/.test(state.key))
    .map((state) => base(state.key, state.customerLabel, state.label, [state.key]))
    .slice(0, MAX_STAGES);
}

/**
 * D3 progress for one order (pure; the server stores the result in `orders.progress_percent`).
 * - `completedStageKeys`: stages whose runtime state is `accepted`, or that the order has moved past.
 * - A stage is actionable when it has any customer action or uses submit_lock; when no stage is actionable, every
 *   stage counts (so derived workflows still progress by status).
 * - `statusCategory` `done` gives 100. Shown = max(derived, explicit).
 */
export function computeProgress(input: {
  stages: readonly Pick<WorkflowStage, "key" | "actions" | "progression" | "weight">[];
  completedStageKeys: ReadonlySet<string>;
  statusCategory: "start" | "working" | "waiting" | "done" | "canceled" | null;
  explicitPercent: number | null;
}): { derived: number; shown: number } {
  const actionable = input.stages.filter((stage) => stage.progression === "submit_lock" || STAGE_ACTION_KEYS.some((key) => stage.actions[key]));
  const counted = actionable.length ? actionable : input.stages;
  const total = counted.reduce((sum, stage) => sum + stage.weight, 0);
  const done = counted.filter((stage) => input.completedStageKeys.has(stage.key)).reduce((sum, stage) => sum + stage.weight, 0);
  const derived = input.statusCategory === "done" ? 100 : total === 0 ? 0 : Math.floor((done * 100) / total);
  const explicit = input.explicitPercent === null ? 0 : Math.max(0, Math.min(100, Math.trunc(input.explicitPercent)));
  return { derived, shown: Math.max(derived, explicit) };
}
