/**
 * Admin-configurable order workflow definitions (data only — never code, scripts or URLs).
 */
import { z } from "zod";

export const WORKFLOW_ACTORS = ["customer", "staff", "admin"] as const;
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

export const workflowStateSchema = z.strictObject({
  key,
  label,
  customerLabel: label,
  kind: z.enum(STATE_KINDS),
  tone: z.enum(STATE_TONES),
});

export const workflowTransitionSchema = z.strictObject({
  from: key,
  to: key,
  allowedBy: z.array(z.enum(WORKFLOW_ACTORS)).min(1).max(3),
  notifyCustomer: z.boolean(),
  requiresNote: z.boolean().default(false),
});

export const workflowDefinitionSchema = z
  .strictObject({
    states: z.array(workflowStateSchema).min(2).max(30),
    transitions: z.array(workflowTransitionSchema).min(1).max(200),
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
  });

export type WorkflowDefinition = z.output<typeof workflowDefinitionSchema>;
export type WorkflowState = WorkflowDefinition["states"][number];
export type WorkflowTransition = WorkflowDefinition["transitions"][number];

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
    { from: "awaiting_customer", to: "in_review", allowedBy: ["customer", "staff", "admin"], notifyCustomer: false, requiresNote: false },
    { from: "in_review", to: "in_progress", allowedBy: ["staff", "admin"], notifyCustomer: true, requiresNote: false },
    { from: "in_progress", to: "delivered", allowedBy: ["staff", "admin"], notifyCustomer: true, requiresNote: false },
    { from: "delivered", to: "completed", allowedBy: ["customer", "staff", "admin"], notifyCustomer: true, requiresNote: false },
    { from: "delivered", to: "in_progress", allowedBy: ["staff", "admin"], notifyCustomer: true, requiresNote: true },
    { from: "in_review", to: "canceled", allowedBy: ["staff", "admin"], notifyCustomer: true, requiresNote: true },
    { from: "in_progress", to: "canceled", allowedBy: ["admin"], notifyCustomer: true, requiresNote: true },
  ],
};
