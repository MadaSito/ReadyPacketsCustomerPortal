/**
 * Increment 03 — order workflow designer: draft shapes, canvas layout and validation with precise messages.
 *
 * A DRAFT may be incomplete (blank keys, no transitions yet) so the wizard and canvas can save work in progress.
 * Its storage shape is bounded (sizes, enums, string lengths) but not semantically validated. `validateDraft`
 * produces every issue at once, each with a path the client maps to a field and a plain-language message.
 * Publishing requires zero issues of severity "error" and then parses with the strict `workflowDefinitionSchema`.
 * Data only: no code, scripts, expressions or URLs.
 */
import { z } from "zod";
import { STATE_KINDS, STATE_TONES, WORKFLOW_ACTORS, workflowDefinitionSchema, type WorkflowDefinition } from "./workflowTypes.js";

export const MAX_STATES = 30;
export const MAX_TRANSITIONS = 200;
const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

const draftText = (max: number) => z.string().max(max).transform((value) => value.normalize("NFC"));

export const draftStateSchema = z.strictObject({
  key: draftText(48),
  label: draftText(60),
  customerLabel: draftText(60),
  kind: z.enum(STATE_KINDS),
  tone: z.enum(STATE_TONES),
});

export const draftTransitionSchema = z.strictObject({
  from: draftText(48),
  to: draftText(48),
  allowedBy: z.array(z.enum(WORKFLOW_ACTORS)).max(3),
  notifyCustomer: z.boolean(),
  requiresNote: z.boolean(),
  actionLabel: draftText(60).optional(),
});

export const draftDefinitionSchema = z.strictObject({
  states: z.array(draftStateSchema).max(MAX_STATES),
  transitions: z.array(draftTransitionSchema).max(MAX_TRANSITIONS),
});
export type WorkflowDraftDefinition = z.output<typeof draftDefinitionSchema>;

const coordinate = z.number().int().min(-10_000).max(10_000);
export const layoutSchema = z.strictObject({
  nodes: z.array(z.strictObject({ key: z.string().max(48), x: coordinate, y: coordinate })).max(MAX_STATES),
});
export type WorkflowLayout = z.output<typeof layoutSchema>;

export type IssueSeverity = "error" | "warning";
export interface WorkflowIssue {
  severity: IssueSeverity;
  /** Stable machine code (UPPER_SNAKE). */
  code: string;
  /** Field path the client maps to an input, e.g. `states.2.key`, `transitions.0.allowedBy`, or `` (whole workflow). */
  path: string;
  message: string;
}

export const BLANK_DRAFT: WorkflowDraftDefinition = {
  states: [
    { key: "submitted", label: "Submitted", customerLabel: "Submitted", kind: "initial", tone: "info" },
    { key: "completed", label: "Completed", customerLabel: "Completed", kind: "terminal", tone: "success" },
  ],
  transitions: [],
};

function stateName(state: { key: string; label: string }, index: number): string {
  const label = state.label.trim();
  return label ? `Status ${index + 1} (“${label}”)` : `Status ${index + 1}`;
}

/** Every issue, in a stable order (states, then transitions, then whole-workflow checks). Pure. */
export function validateDraft(definition: WorkflowDraftDefinition): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const error = (code: string, path: string, message: string) => issues.push({ severity: "error", code, path, message });
  const warn = (code: string, path: string, message: string) => issues.push({ severity: "warning", code, path, message });
  const { states, transitions } = definition;

  const firstIndexByKey = new Map<string, number>();
  states.forEach((state, index) => {
    const name = stateName(state, index);
    const key = state.key.trim();
    if (!key) error("STATE_KEY_REQUIRED", `states.${index}.key`, `${name} needs a key.`);
    else if (key.length < 2) error("STATE_KEY_TOO_SHORT", `states.${index}.key`, `${name}: the key must be at least 2 characters.`);
    else if (!KEY_PATTERN.test(key))
      error("STATE_KEY_FORMAT", `states.${index}.key`, `${name}: the key “${key}” must start with a lowercase letter and use only lowercase letters, digits and underscores.`);
    else if (firstIndexByKey.has(key))
      error("STATE_KEY_DUPLICATE", `states.${index}.key`, `${name}: the key “${key}” is already used by status ${firstIndexByKey.get(key)! + 1}.`);
    else firstIndexByKey.set(key, index);
    if (!state.label.trim()) error("STATE_LABEL_REQUIRED", `states.${index}.label`, `${name} needs a staff label.`);
    if (!state.customerLabel.trim()) error("STATE_CUSTOMER_LABEL_REQUIRED", `states.${index}.customerLabel`, `${name} needs a label for customers.`);
  });

  if (states.length < 2) error("TOO_FEW_STATES", "states", "Add at least two statuses: one where orders start and one where they finish.");
  const initial = states.map((state, index) => ({ state, index })).filter(({ state }) => state.kind === "initial");
  if (initial.length === 0) error("INITIAL_REQUIRED", "states", "Mark exactly one status as the starting status (kind “initial”).");
  if (initial.length > 1)
    error("INITIAL_MULTIPLE", "states", `Only one status can be the starting status; ${initial.map(({ state, index }) => stateName(state, index)).join(", ")} are all marked initial.`);
  if (states.length >= 2 && !states.some((state) => state.kind === "terminal"))
    error("TERMINAL_REQUIRED", "states", "Mark at least one status as final (kind “terminal”) so orders can finish.");

  const known = (key: string) => firstIndexByKey.has(key.trim());
  const labelOf = (key: string) => {
    const index = firstIndexByKey.get(key.trim());
    return index === undefined ? `“${key}”` : `“${states[index]!.label.trim() || key}”`;
  };
  const pairs = new Map<string, number>();
  transitions.forEach((transition, index) => {
    const name = `Transition ${index + 1}${known(transition.from) && known(transition.to) ? ` (${labelOf(transition.from)} → ${labelOf(transition.to)})` : ""}`;
    if (!transition.from.trim()) error("TRANSITION_FROM_REQUIRED", `transitions.${index}.from`, `${name}: choose the status it starts from.`);
    else if (!known(transition.from)) error("TRANSITION_FROM_UNKNOWN", `transitions.${index}.from`, `${name}: the status “${transition.from}” does not exist.`);
    if (!transition.to.trim()) error("TRANSITION_TO_REQUIRED", `transitions.${index}.to`, `${name}: choose the status it moves to.`);
    else if (!known(transition.to)) error("TRANSITION_TO_UNKNOWN", `transitions.${index}.to`, `${name}: the status “${transition.to}” does not exist.`);
    if (transition.from.trim() && transition.from.trim() === transition.to.trim())
      error("TRANSITION_SELF", `transitions.${index}.to`, `${name}: a transition must move to a different status.`);
    if (transition.allowedBy.length === 0)
      error("TRANSITION_NOBODY", `transitions.${index}.allowedBy`, `${name}: choose who may make this move (customer, staff or administrator).`);
    if (new Set(transition.allowedBy).size !== transition.allowedBy.length)
      error("TRANSITION_ACTOR_DUPLICATE", `transitions.${index}.allowedBy`, `${name}: each role can be listed only once.`);
    if (transition.actionLabel !== undefined && !transition.actionLabel.trim())
      error("TRANSITION_ACTION_LABEL_EMPTY", `transitions.${index}.actionLabel`, `${name}: the button label is empty; remove it or enter text.`);
    const pair = `${transition.from.trim()}>${transition.to.trim()}`;
    if (known(transition.from) && known(transition.to)) {
      if (pairs.has(pair)) error("TRANSITION_DUPLICATE", `transitions.${index}`, `${name} duplicates transition ${pairs.get(pair)! + 1}.`);
      else pairs.set(pair, index);
      const fromState = states[firstIndexByKey.get(transition.from.trim())!]!;
      if (fromState.kind === "terminal")
        error("TRANSITION_FROM_TERMINAL", `transitions.${index}.from`, `${name}: ${labelOf(transition.from)} is a final status, so nothing can move out of it. Change its kind or remove this transition.`);
    }
  });
  if (states.length >= 2 && transitions.length === 0) error("TRANSITIONS_REQUIRED", "transitions", "Add at least one transition so orders can move between statuses.");

  // Graph checks only when the structure is otherwise sound enough to be meaningful.
  if (initial.length === 1 && firstIndexByKey.size > 0) {
    const outgoing = new Map<string, string[]>();
    for (const transition of transitions) {
      if (!known(transition.from) || !known(transition.to)) continue;
      const from = transition.from.trim();
      outgoing.set(from, [...(outgoing.get(from) ?? []), transition.to.trim()]);
    }
    const start = initial[0]!.state.key.trim();
    const reached = new Set<string>(firstIndexByKey.has(start) ? [start] : []);
    const queue = [...reached];
    while (queue.length) {
      for (const next of outgoing.get(queue.shift()!) ?? []) {
        if (reached.has(next)) continue;
        reached.add(next);
        queue.push(next);
      }
    }
    states.forEach((state, index) => {
      const key = state.key.trim();
      if (firstIndexByKey.get(key) !== index) return;
      if (state.kind !== "terminal" && !(outgoing.get(key)?.length))
        error("STATE_DEAD_END", `states.${index}`, `${stateName(state, index)} has no way out. Add a transition from it, or mark it as final.`);
      if (transitions.length > 0 && !reached.has(key))
        warn("STATE_UNREACHABLE", `states.${index}`, `${stateName(state, index)} cannot be reached from the starting status. Orders will never enter it.`);
    });
    if (transitions.length > 0 && ![...reached].some((key) => states[firstIndexByKey.get(key)!]!.kind === "terminal"))
      error("NO_PATH_TO_FINISH", "transitions", "No final status can be reached from the starting status, so orders could never finish.");
    if (transitions.length > 0 && !transitions.some((transition) => transition.notifyCustomer))
      warn("NO_CUSTOMER_NOTICE", "transitions", "No transition notifies the customer. Customers will only see changes when they open the order.");
  }
  return issues;
}

export function hasErrors(issues: WorkflowIssue[]): boolean {
  return issues.some((issue) => issue.severity === "error");
}

/** Strict conversion for publishing; call only when `validateDraft` reported no errors. */
export function toPublishable(definition: WorkflowDraftDefinition): WorkflowDefinition {
  return workflowDefinitionSchema.parse({
    states: definition.states.map((state) => ({ ...state, key: state.key.trim(), label: state.label.trim(), customerLabel: state.customerLabel.trim() })),
    transitions: definition.transitions.map(({ actionLabel, ...transition }) => ({
      ...transition,
      from: transition.from.trim(),
      to: transition.to.trim(),
      ...(actionLabel?.trim() ? { actionLabel: actionLabel.trim() } : {}),
    })),
  });
}

/** A published definition as an editable draft (deep copy; requiresNote made explicit). */
export function toDraft(definition: WorkflowDefinition): WorkflowDraftDefinition {
  return draftDefinitionSchema.parse(JSON.parse(JSON.stringify(definition)));
}

/** Drops layout entries for keys that are not states (stale positions after renames/removals). */
export function pruneLayout(layout: WorkflowLayout | null, definition: WorkflowDraftDefinition): WorkflowLayout | null {
  if (!layout) return null;
  const keys = new Set(definition.states.map((state) => state.key.trim()));
  const seen = new Set<string>();
  return { nodes: layout.nodes.filter((node) => keys.has(node.key) && !seen.has(node.key) && seen.add(node.key)) };
}
