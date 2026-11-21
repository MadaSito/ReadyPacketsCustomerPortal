/**
 * Workflow designer — client model shared by the wizard and the canvas (both edit ONE draft held by the page).
 * The server is the authority for validation (`issues` come back from every save); nothing here decides validity.
 */
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@server/trpc/root";

type Out = inferRouterOutputs<AppRouter>["orders"]["admin"]["workflows"];
export type WorkflowListRow = Out["list"][number];
export type DraftView = Out["drafts"]["get"];
export type DraftListRow = Out["drafts"]["list"][number];
export type VersionList = Out["versions"];
export type VersionView = Out["version"];
export type WorkflowIssue = DraftView["issues"][number];
export type DraftDefinition = DraftView["definition"];
export type DraftState = DraftDefinition["states"][number];
export type DraftTransition = DraftDefinition["transitions"][number];
export type Layout = { nodes: { key: string; x: number; y: number }[] };

export const ACTORS = [
  { value: "customer", label: "Customer" },
  { value: "staff", label: "Staff" },
  { value: "admin", label: "Administrator" },
] as const;
export type Actor = (typeof ACTORS)[number]["value"];
export const ACTOR_LABEL: Record<string, string> = Object.fromEntries(ACTORS.map((actor) => [actor.value, actor.label]));

export const KIND_OPTIONS = [
  { value: "initial", label: "Start (orders begin here)" },
  { value: "active", label: "In progress" },
  { value: "terminal", label: "Final (orders finish here)" },
];
export const KIND_LABEL: Record<string, string> = { initial: "Start", active: "In progress", terminal: "Final" };
export const TONE_OPTIONS = [
  { value: "neutral", label: "Neutral (grey)" },
  { value: "info", label: "Information (blue)" },
  { value: "success", label: "Success (green)" },
  { value: "warning", label: "Needs attention (amber)" },
  { value: "danger", label: "Problem (red)" },
];

export const WIZARD_STEPS = [
  { id: "statuses", label: "Statuses" },
  { id: "transitions", label: "Transitions" },
  { id: "who", label: "Who may move" },
  { id: "notices", label: "Notices and notes" },
  { id: "review", label: "Review and publish" },
] as const;
export type WizardStepId = (typeof WIZARD_STEPS)[number]["id"];

/** Which wizard step fixes a given issue (server codes are stable; unknown codes belong to the review step). */
const STEP_OF_CODE: Record<string, WizardStepId> = {
  STATE_KEY_REQUIRED: "statuses",
  STATE_KEY_TOO_SHORT: "statuses",
  STATE_KEY_FORMAT: "statuses",
  STATE_KEY_DUPLICATE: "statuses",
  STATE_LABEL_REQUIRED: "statuses",
  STATE_CUSTOMER_LABEL_REQUIRED: "statuses",
  TOO_FEW_STATES: "statuses",
  INITIAL_REQUIRED: "statuses",
  INITIAL_MULTIPLE: "statuses",
  TERMINAL_REQUIRED: "statuses",
  TRANSITION_FROM_REQUIRED: "transitions",
  TRANSITION_FROM_UNKNOWN: "transitions",
  TRANSITION_TO_REQUIRED: "transitions",
  TRANSITION_TO_UNKNOWN: "transitions",
  TRANSITION_SELF: "transitions",
  TRANSITION_DUPLICATE: "transitions",
  TRANSITION_FROM_TERMINAL: "transitions",
  TRANSITIONS_REQUIRED: "transitions",
  STATE_DEAD_END: "transitions",
  STATE_UNREACHABLE: "transitions",
  NO_PATH_TO_FINISH: "transitions",
  TRANSITION_NOBODY: "who",
  TRANSITION_ACTOR_DUPLICATE: "who",
  TRANSITION_ACTION_LABEL_EMPTY: "notices",
  NO_CUSTOMER_NOTICE: "notices",
};
export const stepOfIssue = (issue: WorkflowIssue): WizardStepId => STEP_OF_CODE[issue.code] ?? "review";
export const errorsOf = (issues: readonly WorkflowIssue[]) => issues.filter((issue) => issue.severity === "error");

/** First error message for an exact field path (e.g. `states.2.key`), for a Field's `error` prop. */
export function fieldError(issues: readonly WorkflowIssue[], path: string): string | undefined {
  return issues.find((issue) => issue.severity === "error" && issue.path === path)?.message;
}

/** Suggested key from a label: lowercase ASCII letters, digits and underscores, starting with a letter. */
export function keyFromLabel(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^[^a-z]+/, "")
      .replace(/_+$/, "")
      .slice(0, 40) || "status";
  let key = base.length < 2 ? `${base}_status` : base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}_${n}`;
  return key;
}

export function stateLabel(definition: DraftDefinition, key: string): string {
  return definition.states.find((state) => state.key === key)?.label.trim() || key || "(no status)";
}

/* ------------------------------------------------------------------ edits (pure) */

export function updateState(definition: DraftDefinition, layout: Layout, index: number, patch: Partial<DraftState>): { definition: DraftDefinition; layout: Layout } {
  const before = definition.states[index];
  if (!before) return { definition, layout };
  const after = { ...before, ...patch };
  const states = definition.states.map((state, i) => (i === index ? after : state));
  let transitions = definition.transitions;
  let nodes = layout.nodes;
  if (patch.key !== undefined && before.key && patch.key !== before.key && !definition.states.some((state, i) => i !== index && state.key === before.key)) {
    // Renaming a key carries its transitions and canvas position along.
    transitions = transitions.map((t) => ({ ...t, from: t.from === before.key ? after.key : t.from, to: t.to === before.key ? after.key : t.to }));
    nodes = nodes.map((node) => (node.key === before.key ? { ...node, key: after.key } : node));
  }
  return { definition: { states, transitions }, layout: { nodes } };
}

export function addState(definition: DraftDefinition, layout: Layout, label = "New status"): { definition: DraftDefinition; layout: Layout; index: number } {
  const key = keyFromLabel(label, new Set(definition.states.map((state) => state.key)));
  const state: DraftState = { key, label, customerLabel: label, kind: "active", tone: "info" };
  const position = defaultPosition(definition.states.length);
  return {
    definition: { ...definition, states: [...definition.states, state] },
    layout: { nodes: [...layout.nodes.filter((node) => node.key !== key), { key, ...position }] },
    index: definition.states.length,
  };
}

export function removeState(definition: DraftDefinition, layout: Layout, index: number): { definition: DraftDefinition; layout: Layout } {
  const removed = definition.states[index];
  if (!removed) return { definition, layout };
  const states = definition.states.filter((_, i) => i !== index);
  const stillUsed = states.some((state) => state.key === removed.key);
  return {
    definition: { states, transitions: stillUsed ? definition.transitions : definition.transitions.filter((t) => t.from !== removed.key && t.to !== removed.key) },
    layout: { nodes: stillUsed ? layout.nodes : layout.nodes.filter((node) => node.key !== removed.key) },
  };
}

export function moveState(definition: DraftDefinition, index: number, delta: -1 | 1): DraftDefinition {
  const target = index + delta;
  if (target < 0 || target >= definition.states.length) return definition;
  const states = [...definition.states];
  [states[index], states[target]] = [states[target]!, states[index]!];
  return { ...definition, states };
}

export const newTransition = (from: string, to: string): DraftTransition => ({ from, to, allowedBy: ["staff", "admin"], notifyCustomer: true, requiresNote: false });

export function updateTransition(definition: DraftDefinition, index: number, patch: Partial<DraftTransition>): DraftDefinition {
  return { ...definition, transitions: definition.transitions.map((t, i) => (i === index ? { ...t, ...patch } : t)) };
}
export function removeTransition(definition: DraftDefinition, index: number): DraftDefinition {
  return { ...definition, transitions: definition.transitions.filter((_, i) => i !== index) };
}

export function toggleActor(list: readonly string[], actor: Actor, on: boolean): Actor[] {
  const set = new Set(list as Actor[]);
  if (on) set.add(actor);
  else set.delete(actor);
  return ACTORS.map((a) => a.value).filter((value) => set.has(value));
}

/* ------------------------------------------------------------------ canvas */

// Steps are 208 px wide; the spacing leaves room for a transition label between neighbours.
const COLUMNS = 3;
export function defaultPosition(index: number): { x: number; y: number } {
  return { x: (index % COLUMNS) * 320, y: Math.floor(index / COLUMNS) * 180 };
}

export function positionOf(layout: Layout, key: string, index: number): { x: number; y: number } {
  return layout.nodes.find((node) => node.key === key) ?? defaultPosition(index);
}

export function setPosition(layout: Layout, key: string, x: number, y: number): Layout {
  const clamp = (value: number) => Math.max(-10_000, Math.min(10_000, Math.round(value)));
  return { nodes: [...layout.nodes.filter((node) => node.key !== key), { key, x: clamp(x), y: clamp(y) }] };
}

/** Node id for a state index (keys may be blank or duplicated while editing, indices are always unique). */
export const nodeId = (index: number) => `s${index}`;
export const edgeId = (index: number) => `t${index}`;
export const indexOfId = (id: string) => Number(id.slice(1));
