/**
 * Workflow designer — client model shared by the wizard and the canvas (both edit ONE draft held by the page).
 * The server is the authority for validation (`issues` come back from every save); nothing here decides validity.
 */
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@server/trpc/root";
import { DEFAULT_ORDER_FILE_FOLDER_TEMPLATE, isOrderFileFolderTemplate, resolveOrderFileFolder, type OrderFileFolderToken } from "@shared/orderFileFolder";

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
  { value: "api", label: "API integration" },
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
  { id: "rules", label: "Status requirements" },
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
  PHASE_KEY_REQUIRED: "rules",
  PHASE_KEY_FORMAT: "rules",
  PHASE_KEY_DUPLICATE: "rules",
  PHASE_LABEL_REQUIRED: "rules",
  STATE_PHASE_UNKNOWN: "rules",
  STATE_PHASE_MISSING: "rules",
  PHASE_UNUSED: "rules",
  UPLOAD_KEY_FORMAT: "rules",
  UPLOAD_KEY_DUPLICATE: "rules",
  UPLOAD_LABEL_REQUIRED: "rules",
  UPLOAD_MAX_TOO_LOW: "rules",
  UPLOAD_MIN_ABOVE_MAX: "rules",
  UPLOAD_NOBODY: "rules",
  UPLOAD_ACTOR_DUPLICATE: "rules",
  UPLOAD_TYPE_FORMAT: "rules",
  UPLOAD_TYPE_DUPLICATE: "rules",
  UPLOAD_HINT_MARKUP: "rules",
  ACK_KEY_FORMAT: "rules",
  ACK_KEY_DUPLICATE: "rules",
  ACK_TITLE_REQUIRED: "rules",
  ACK_BODY_REQUIRED: "rules",
  ACK_MARKUP: "rules",
  TERMINAL_REQUIREMENTS: "rules",
  UPLOAD_FOLDER_INVALID: "rules",
  WORKFLOW_FOLDER_INVALID: "rules",
  GATE_KEY_FORMAT: "rules",
  GATE_KEY_DUPLICATE: "rules",
  GATE_POLICY_REQUIRED: "rules",
  GATE_STEP_REQUIRED: "rules",
  GATE_STEP_UNKNOWN: "rules",
  GATE_STEP_TERMINAL: "rules",
};
export const stepOfIssue = (issue: WorkflowIssue): WizardStepId =>
  STEP_OF_CODE[issue.code] ?? (/^(RECORD_|DOC_|ACK_NOTE_)/.test(issue.code) || /\.requirements\./.test(issue.path) || /^phases\./.test(issue.path) ? "rules" : "review");
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
  return { definition: { ...definition, states, transitions }, layout: { nodes } };
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
    definition: { ...definition, states, transitions: stillUsed ? definition.transitions : definition.transitions.filter((t) => t.from !== removed.key && t.to !== removed.key) },
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

/* ------------------------------------------------------------------ phases and requirements (increment 04) */

export type DraftPhase = NonNullable<DraftDefinition["phases"]>[number];
export type DraftRequirements = NonNullable<DraftState["requirements"]>;
export type DraftUpload = DraftRequirements["uploads"][number];
export type DraftAcknowledgement = DraftRequirements["acknowledgements"][number];
export type DraftDocumentTask = NonNullable<DraftRequirements["documents"]>[number];

/* ------------------------------------------------------------------ customer tasks (increment 06, D8) */

/** File type presets (the server's accepted extensions). The Files picker filters by the chosen types. */
export const TYPE_PRESETS = [
  { id: "word", label: "Word", types: ["docx"] },
  { id: "pdf", label: "PDF", types: ["pdf"] },
  { id: "images", label: "Images", types: ["png", "jpg"] },
  { id: "audio", label: "Audio", types: ["mp3", "m4a", "wav", "ogg", "webm", "mp4", "aac"] },
] as const;
export type TypePresetId = (typeof TYPE_PRESETS)[number]["id"];
/** A preset is on when every one of its types is allowed. */
export const presetOn = (types: readonly string[], id: TypePresetId) => TYPE_PRESETS.find((preset) => preset.id === id)!.types.every((type) => types.includes(type));
export function togglePreset(types: readonly string[], id: TypePresetId, on: boolean): string[] {
  const preset = TYPE_PRESETS.find((candidate) => candidate.id === id)!.types as readonly string[];
  const rest = types.filter((type) => !preset.includes(type));
  return on ? [...rest, ...preset] : rest;
}
export const CAPTURE_OPTIONS = [
  { value: "either", label: "Record in the portal or upload a file" },
  { value: "record", label: "Record in the portal only" },
  { value: "upload", label: "Upload a recording only" },
];
export const RESPONSE_MODES = [
  { value: "edit_in_portal", label: "Edit in the portal", description: "The customer edits the Word document in the browser. Needs Word (docx) in the accepted types." },
  { value: "upload_reply", label: "Upload a reply", description: "The customer uploads their own file in reply." },
  { value: "acknowledge", label: "Acknowledge", description: "The customer confirms they have read the document." },
] as const;
export type TaskKind = "upload" | "record" | "acknowledge" | "respond_document";
export const TASK_KIND_OPTIONS: { value: TaskKind; label: string; description: string }[] = [
  { value: "upload", label: "Upload files", description: "The customer uploads one or more files." },
  { value: "record", label: "Record audio", description: "The customer records or uploads audio, with a time limit." },
  { value: "acknowledge", label: "Acknowledge text", description: "The customer reads and accepts fixed text, or a note your team writes on each order." },
  { value: "respond_document", label: "Respond to a document", description: "Your team shares a document; the customer edits it, uploads a reply or acknowledges it." },
];
export function newDocumentTask(state: DraftState): DraftDocumentTask {
  const taken = new Set([...(requirementsOf(state).documents ?? []).map((doc) => doc.key), ...requirementsOf(state).uploads.map((upload) => upload.key)]);
  return { key: keyFromLabel("document", taken), label: "", responseModes: ["upload_reply"], required: true, allowedTypes: ["docx", "pdf"] };
}
export function newRecordTask(state: DraftState): DraftUpload {
  const taken = new Set(requirementsOf(state).uploads.map((upload) => upload.key));
  return { key: keyFromLabel("recording", taken), label: "Recording", kind: "audio", minCount: 1, maxCount: 1, allowedTypes: [...TYPE_PRESETS[3].types], uploadedBy: ["customer"], capture: "either", maxMinutes: 10 };
}
/** Adds a task of the chosen kind to a state's requirements. */
export function addTask(state: DraftState, kind: TaskKind): Partial<DraftState> {
  return withRequirements(state, (current) =>
    kind === "upload"
      ? { ...current, uploads: [...current.uploads, newUpload(state)] }
      : kind === "record"
        ? { ...current, uploads: [...current.uploads, newRecordTask(state)] }
        : kind === "acknowledge"
          ? { ...current, acknowledgements: [...current.acknowledgements, newAcknowledgement(state)] }
          : { ...current, documents: [...(current.documents ?? []), newDocumentTask(state)] },
  );
}

/** DOM id of the control for a validation path (designer findings jump here). */
export const issueFieldId = (path: string) => `wf-field-${path.replace(/[^A-Za-z0-9_-]+/g, "-")}`;
export const UPLOAD_KIND_OPTIONS = [
  { value: "document", label: "Document" },
  { value: "audio", label: "Audio" },
];
export const ACK_SIDE_OPTIONS = [
  { value: "customer", label: "The customer" },
  { value: "staff", label: "Our staff" },
];

export function addPhase(definition: DraftDefinition): DraftDefinition {
  const phases = definition.phases ?? [];
  const key = keyFromLabel(`Phase ${phases.length + 1}`, new Set(phases.map((phase) => phase.key)));
  return { ...definition, phases: [...phases, { key, label: `Phase ${phases.length + 1}` }] };
}
export function updatePhase(definition: DraftDefinition, index: number, patch: Partial<DraftPhase>): DraftDefinition {
  const phases = definition.phases ?? [];
  const before = phases[index];
  if (!before) return definition;
  const after = { ...before, ...patch };
  const renamed = patch.key !== undefined && patch.key !== before.key;
  return {
    ...definition,
    phases: phases.map((phase, i) => (i === index ? after : phase)),
    // Renaming a phase key carries the statuses that belong to it.
    states: renamed ? definition.states.map((state) => (state.phase === before.key ? { ...state, phase: after.key } : state)) : definition.states,
  };
}
export function removePhase(definition: DraftDefinition, index: number): DraftDefinition {
  const phases = definition.phases ?? [];
  const removed = phases[index];
  if (!removed) return definition;
  const rest = phases.filter((_, i) => i !== index);
  return {
    ...definition,
    phases: rest,
    states: definition.states.map((state) => {
      if (state.phase !== removed.key || rest.some((phase) => phase.key === removed.key)) return state;
      const { phase: _phase, ...without } = state;
      return without;
    }),
  };
}

const requirementsOf = (state: DraftState): DraftRequirements => state.requirements ?? { uploads: [], acknowledgements: [] };
/** Patch for a state's requirements (drops the object when both lists are empty). */
export function withRequirements(state: DraftState, next: (current: DraftRequirements) => DraftRequirements): Partial<DraftState> {
  const requirements = next(requirementsOf(state));
  const documents = requirements.documents ?? [];
  const { documents: _documents, ...rest } = requirements;
  const kept = documents.length ? { ...rest, documents } : rest;
  return { requirements: requirements.uploads.length || requirements.acknowledgements.length || documents.length ? kept : undefined };
}
export function newUpload(state: DraftState): DraftUpload {
  const taken = new Set(requirementsOf(state).uploads.map((upload) => upload.key));
  return { key: keyFromLabel("documents", taken), label: "Documents", kind: "document", minCount: 1, maxCount: 5, allowedTypes: ["pdf"], uploadedBy: ["customer"] };
}
export function newAcknowledgement(state: DraftState): DraftAcknowledgement {
  const taken = new Set(requirementsOf(state).acknowledgements.map((ack) => ack.key));
  return { key: keyFromLabel("terms", taken), title: "", body: "", acceptedBy: "customer", requireTypedName: false };
}
export const parseTypes = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map((part) => part.trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean);

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

/* ------------------------------------------------------------------ part B: acceptance gates + storage folders */

export type DraftGate = NonNullable<DraftDefinition["acceptanceGates"]>[number];
export const MAX_GATES = 10;
export const SIGNATURE_MODE_OPTIONS = [
  { value: "checkbox", label: "Tick a box" },
  { value: "typed_name", label: "Type their full name" },
] as const;

export function newGate(definition: DraftDefinition): DraftGate {
  const taken = new Set((definition.acceptanceGates ?? []).map((gate) => gate.key));
  return { key: keyFromLabel("terms", taken), policyPublicId: "", point: "order_start", signatureMode: "checkbox", askAgainOnNewVersion: true };
}
export function updateGate(definition: DraftDefinition, index: number, patch: Partial<DraftGate>): DraftDefinition {
  return { ...definition, acceptanceGates: (definition.acceptanceGates ?? []).map((gate, i) => (i === index ? { ...gate, ...patch } : gate)) };
}
export function removeGate(definition: DraftDefinition, index: number): DraftDefinition {
  const next = (definition.acceptanceGates ?? []).filter((_, i) => i !== index);
  return { ...definition, acceptanceGates: next.length ? next : undefined };
}
/** Select value for a gate point: "order_start" or "step:<key>". */
export const gatePointValue = (point: DraftGate["point"]) => (point === "order_start" ? "order_start" : `step:${point.stepKey}`);
export const gatePointFrom = (value: string): DraftGate["point"] => (value.startsWith("step:") ? { stepKey: value.slice(5) } : "order_start");

/** Synthetic values for the live example path (never real customer data). */
export const FOLDER_EXAMPLE_VALUES: Record<OrderFileFolderToken, string> = {
  customer_ref: "RPCUS-A1B2C3D4E",
  order_ref: "RP-JJG5-ZEUGRE-ICEQUE-001",
  order_name: "Example project",
  phase: "Intake",
  slot: "Signed contract",
  yyyy: "2026",
  mm: "11",
};
/**
 * Example path for a folder template with the precedence the copy worker uses (slot → workflow → default).
 * Returns null when the effective template is not valid (the server reports the error on save).
 */
export function folderExample(templates: (string | undefined)[], values: Partial<Record<OrderFileFolderToken, string>> = {}): string | null {
  const template = templates.map((value) => value?.trim()).find((value) => value) ?? DEFAULT_ORDER_FILE_FOLDER_TEMPLATE;
  if (!isOrderFileFolderTemplate(template)) return null;
  try {
    return resolveOrderFileFolder(template, { ...FOLDER_EXAMPLE_VALUES, ...values }).join("/");
  } catch {
    return null;
  }
}
