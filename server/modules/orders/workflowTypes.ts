/**
 * Admin-configurable order workflow definitions (data only — never code, scripts or URLs).
 */
import { z } from "zod";

/** `api` (increment 04): an integration calling /api/v1 with an `orders:write` key. */
export const WORKFLOW_ACTORS = ["customer", "staff", "admin", "api"] as const;
export type WorkflowActor = (typeof WORKFLOW_ACTORS)[number];
export const STATE_KINDS = ["initial", "active", "terminal"] as const;
export const STATE_TONES = ["neutral", "info", "success", "warning", "danger"] as const;

const key = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z][a-z0-9_]*$/, "Use lowercase letters, digits and underscores.");
const label = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .transform((value) => value.normalize("NFC"));

/** Plain text only: strip control characters (except newline/tab), normalise, and refuse markup-looking input. */
export function plainText(max: number) {
  return z
    .string()
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .transform((value) => value.normalize("NFC").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim())
    .pipe(z.string().min(1).max(max).refine((value) => !/<\s*[a-z!/?]/i.test(value), "Use plain text without markup."));
}

export const UPLOAD_KINDS = ["document", "audio"] as const;
export const ACK_SIDES = ["customer", "staff"] as const;
export type AckSide = (typeof ACK_SIDES)[number];
export const MAX_PHASES = 12;
export const MAX_UPLOAD_SLOTS = 10;
export const MAX_ACKNOWLEDGEMENTS = 5;
export const MAX_SLOT_COUNT = 20;
export const ACK_BODY_MAX = 8000;

export const workflowPhaseSchema = z.strictObject({ key, label });

export const uploadRequirementSchema = z
  .strictObject({
    key,
    label,
    hint: z.string().trim().max(200).optional(),
    kind: z.enum(UPLOAD_KINDS),
    minCount: z.number().int().min(0).max(MAX_SLOT_COUNT),
    maxCount: z.number().int().min(1).max(MAX_SLOT_COUNT),
    allowedTypes: z.array(z.string().regex(/^[a-z0-9]{1,10}$/, "Use a lowercase extension without a dot.")).max(20),
    uploadedBy: z.array(z.enum(WORKFLOW_ACTORS)).min(1).max(4),
  })
  .refine((slot) => slot.minCount <= slot.maxCount, { message: "Minimum cannot exceed maximum.", path: ["minCount"] });

export const acknowledgementRequirementSchema = z.strictObject({
  key,
  title: plainText(120),
  body: plainText(ACK_BODY_MAX),
  acceptedBy: z.enum(ACK_SIDES),
  requireTypedName: z.boolean(),
});

export const stateRequirementsSchema = z.strictObject({
  uploads: z.array(uploadRequirementSchema).max(MAX_UPLOAD_SLOTS),
  acknowledgements: z.array(acknowledgementRequirementSchema).max(MAX_ACKNOWLEDGEMENTS),
});

export const workflowStateSchema = z.strictObject({
  key,
  label,
  customerLabel: label,
  kind: z.enum(STATE_KINDS),
  tone: z.enum(STATE_TONES),
  phase: key.optional(),
  requirements: stateRequirementsSchema.optional(),
});

export const workflowTransitionSchema = z.strictObject({
  from: key,
  to: key,
  allowedBy: z.array(z.enum(WORKFLOW_ACTORS)).min(1).max(4),
  notifyCustomer: z.boolean(),
  requiresNote: z.boolean().default(false),
  /** Optional verb phrase for the action button (e.g. "Start review"). Derived from the target state when absent. */
  actionLabel: label.optional(),
});

export const workflowDefinitionSchema = z
  .strictObject({
    states: z.array(workflowStateSchema).min(2).max(30),
    transitions: z.array(workflowTransitionSchema).min(1).max(200),
    phases: z.array(workflowPhaseSchema).max(MAX_PHASES).optional(),
  })
  .superRefine((definition, ctx) => {
    const keys = new Set<string>();
    for (const state of definition.states) {
      if (keys.has(state.key)) ctx.addIssue({ code: "custom", message: `Duplicate state ${state.key}.`, path: ["states"] });
      keys.add(state.key);
    }
    const initial = definition.states.filter((state) => state.kind === "initial");
    if (initial.length !== 1) ctx.addIssue({ code: "custom", message: "Exactly one initial state is required.", path: ["states"] });
    const pairs = new Set<string>();
    for (const transition of definition.transitions) {
      if (!keys.has(transition.from) || !keys.has(transition.to))
        ctx.addIssue({ code: "custom", message: "Transitions must reference defined states.", path: ["transitions"] });
      if (transition.from === transition.to)
        ctx.addIssue({ code: "custom", message: "A transition must change the state.", path: ["transitions"] });
      const pair = `${transition.from}>${transition.to}`;
      if (pairs.has(pair)) ctx.addIssue({ code: "custom", message: "Duplicate transition.", path: ["transitions"] });
      pairs.add(pair);
    }
    const phaseKeys = new Set<string>();
    for (const phase of definition.phases ?? []) {
      if (phaseKeys.has(phase.key)) ctx.addIssue({ code: "custom", message: `Duplicate phase ${phase.key}.`, path: ["phases"] });
      phaseKeys.add(phase.key);
    }
    for (const state of definition.states) {
      if (state.phase && !phaseKeys.has(state.phase))
        ctx.addIssue({ code: "custom", message: `State ${state.key} names an unknown phase.`, path: ["states"] });
      const req = state.requirements;
      if (!req) continue;
      const slotKeys = new Set(req.uploads.map((slot) => slot.key));
      if (slotKeys.size !== req.uploads.length) ctx.addIssue({ code: "custom", message: `Duplicate upload slot in ${state.key}.`, path: ["states"] });
      const ackKeys = new Set(req.acknowledgements.map((ack) => ack.key));
      if (ackKeys.size !== req.acknowledgements.length)
        ctx.addIssue({ code: "custom", message: `Duplicate acknowledgement in ${state.key}.`, path: ["states"] });
    }
  });

export type WorkflowDefinition = z.output<typeof workflowDefinitionSchema>;
export type WorkflowState = WorkflowDefinition["states"][number];
export type WorkflowTransition = WorkflowDefinition["transitions"][number];
export type WorkflowPhase = NonNullable<WorkflowDefinition["phases"]>[number];
export type UploadRequirement = z.output<typeof uploadRequirementSchema>;
export type AcknowledgementRequirement = z.output<typeof acknowledgementRequirementSchema>;

/** True when a definition uses increment-04 rules (phases or any requirement). */
export function usesWorkflowRules(definition: WorkflowDefinition): boolean {
  return (
    (definition.phases?.length ?? 0) > 0 ||
    definition.states.some((state) => state.phase !== undefined || (state.requirements && (state.requirements.uploads.length > 0 || state.requirements.acknowledgements.length > 0)))
  );
}

export function phaseOf(definition: WorkflowDefinition, stateKey: string): string | null {
  return findState(definition, stateKey)?.phase ?? null;
}

/** Exact text whose SHA-256 an acknowledgement record pins. */
export function acknowledgementText(ack: { title: string; body: string }): string {
  return `${ack.title}\n\n${ack.body}`;
}

export function initialState(definition: WorkflowDefinition): WorkflowState {
  const state = definition.states.find((candidate) => candidate.kind === "initial");
  if (!state) throw new Error("workflow definition has no initial state");
  return state;
}

export function findState(definition: WorkflowDefinition, stateKey: string): WorkflowState | undefined {
  return definition.states.find((state) => state.key === stateKey);
}

export function transitionsFrom(definition: WorkflowDefinition, from: string, actor: WorkflowActor): WorkflowTransition[] {
  return definition.transitions.filter((transition) => transition.from === from && transition.allowedBy.includes(actor));
}

/** A neutral, generic starter workflow. Administrators edit it; it encodes no legacy pricing or products. */
export const DEFAULT_WORKFLOW: WorkflowDefinition = {
  states: [
    { key: "submitted", label: "Submitted", customerLabel: "Submitted", kind: "initial", tone: "info" },
    { key: "in_review", label: "In review", customerLabel: "Being reviewed", kind: "active", tone: "info" },
    { key: "awaiting_customer", label: "Awaiting customer", customerLabel: "Action needed", kind: "active", tone: "warning" },
    { key: "in_progress", label: "In progress", customerLabel: "In progress", kind: "active", tone: "info" },
    { key: "delivered", label: "Delivered", customerLabel: "Delivered", kind: "active", tone: "success" },
    { key: "completed", label: "Completed", customerLabel: "Completed", kind: "terminal", tone: "success" },
    { key: "canceled", label: "Canceled", customerLabel: "Canceled", kind: "terminal", tone: "neutral" },
  ],
  transitions: [
    { from: "submitted", to: "in_review", allowedBy: ["staff", "admin"], notifyCustomer: true, requiresNote: false },
    { from: "submitted", to: "canceled", allowedBy: ["customer", "staff", "admin"], notifyCustomer: true, requiresNote: false },
    { from: "in_review", to: "awaiting_customer", allowedBy: ["staff", "admin"], notifyCustomer: true, requiresNote: true },
    { from: "awaiting_customer", to: "in_review", allowedBy: ["customer", "staff", "admin"], notifyCustomer: false, requiresNote: false, actionLabel: "Return to review" },
    { from: "in_review", to: "in_progress", allowedBy: ["staff", "admin"], notifyCustomer: true, requiresNote: false },
    { from: "in_progress", to: "delivered", allowedBy: ["staff", "admin"], notifyCustomer: true, requiresNote: false },
    { from: "delivered", to: "completed", allowedBy: ["customer", "staff", "admin"], notifyCustomer: true, requiresNote: false, actionLabel: "Mark as completed" },
    { from: "delivered", to: "in_progress", allowedBy: ["staff", "admin"], notifyCustomer: true, requiresNote: true, actionLabel: "Reopen work" },
    { from: "in_review", to: "canceled", allowedBy: ["staff", "admin"], notifyCustomer: true, requiresNote: true },
    { from: "in_progress", to: "canceled", allowedBy: ["admin"], notifyCustomer: true, requiresNote: true },
  ],
};

/** Terminal states whose key names a cancellation are presented as destructive actions. */
export function isCancelState(state: { key: string; kind: string }): boolean {
  return state.kind === "terminal" && /cancel/.test(state.key);
}

/** Verb label for a transition button: the definition's actionLabel, else "Cancel order" / "Move to <state>". */
export function transitionActionLabel(transition: { actionLabel?: string }, target: { key: string; kind: string } | undefined, targetLabel: string): string {
  if (transition.actionLabel) return transition.actionLabel;
  if (target && isCancelState(target)) return "Cancel order";
  return `Move to ${targetLabel}`;
}
