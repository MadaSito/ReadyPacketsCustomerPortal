/**
 * automations feature — editor draft model and pure helpers.
 * Owner: siem_engineer (Increment 07 Package G client).
 * Server contract: server/modules/automations/contracts.ts (engagement_engineer). The server re-validates everything;
 * these checks give immediate, field-level feedback.
 *
 * One draft is edited by both the wizard and the canvas; the canvas is a projection of the same data
 * (trigger → conditions → ordered actions), so the two views can never disagree.
 */
import { STAGE_ALERT_SEVERITIES, STAGE_COMPLETION_DELAY_MAX_MINUTES } from "@shared/workflowStages";
import type {
  AutomationActionConfigField,
  AutomationCataloguePickerOptions,
  AutomationCatalogueView,
  AutomationConditionTree,
  AutomationDetailView,
  AutomationRunState,
  AutomationRunView,
  AutomationStarterRecipe,
  AutomationStepState,
  AutomationSummaryView,
  AutomationTestRunResult,
  AutomationTriggerConfig,
  AutomationVersionView,
  CatalogueFieldOptionSourceKey,
  CataloguePickerOption,
  CompletionJobState,
  ConditionOperator,
  OrderStageRunState,
  StageBundleSlotOutcome,
} from "@server/modules/automations/contracts";
import type { TriggerCatalogueEntry, TriggerField } from "@server/modules/audit/triggerCatalogue";

export type Catalogue = AutomationCatalogueView;
export type CatalogueAction = Catalogue["actions"][number];
export type ConfigField = AutomationActionConfigField;
export type TriggerEntry = TriggerCatalogueEntry;
export type {
  AutomationDetailView,
  AutomationRunView,
  AutomationStarterRecipe,
  AutomationSummaryView,
  AutomationTestRunResult,
  AutomationTriggerConfig,
  AutomationVersionView,
  CataloguePickerOption,
  CompletionJobState,
  ConditionOperator,
  OrderStageRunState,
  StageBundleSlotOutcome,
  TriggerField,
};

export const BASE = "/admin/automations";

/* ------------------------------------------------------------------ draft */

export interface DraftCondition { id: string; field: string; operator: ConditionOperator | ""; value: string }
export interface DraftGroup { id: string; match: "all" | "any"; conditions: DraftCondition[] }
export interface DraftAction {
  stepKey: string;
  actionKey: string;
  label: string;
  config: Record<string, unknown>;
  /** Write-only values typed in this session; never pre-filled from the server. */
  secrets: Record<string, string>;
  secretStatus: Record<string, { configured: boolean; last4: string | null }>;
}
export interface Draft {
  name: string;
  description: string;
  maxRunsPerHour: string;
  trigger: AutomationTriggerConfig | null;
  match: "all" | "any";
  groups: DraftGroup[];
  actions: DraftAction[];
  positions: Record<string, { x: number; y: number }>;
}

export function emptyDraft(): Draft {
  return { name: "", description: "", maxRunsPerHour: "", trigger: null, match: "all", groups: [], actions: [], positions: {} };
}

/** Next free id with a prefix (`g1`, `c3`, `step_2`) — deterministic, no randomness in render. */
export function nextId(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 1; ; n += 1) if (!used.has(`${prefix}${n}`)) return `${prefix}${n}`;
}

const allConditionIds = (d: Pick<Draft, "groups">) => d.groups.flatMap((g) => [g.id, ...g.conditions.map((c) => c.id)]);

function valueToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

function treeToGroups(tree: AutomationConditionTree, fields: readonly TriggerField[]): DraftGroup[] {
  let n = 0;
  return tree.groups.map((group, gi) => ({
    id: `g${gi + 1}`,
    match: group.match,
    conditions: group.conditions.map((leaf) => {
      n += 1;
      const type = fields.find((f) => f.key === leaf.field)?.type;
      const text = type === "money_minor" && typeof leaf.value === "number" ? (leaf.value / 100).toFixed(2) : valueToText(leaf.value);
      return { id: `c${n}`, field: leaf.field, operator: leaf.operator, value: text };
    }),
  }));
}

export function triggerEntry(trigger: AutomationTriggerConfig | null, catalogue: Catalogue | undefined): TriggerEntry | undefined {
  return trigger?.kind === "event" ? catalogue?.triggers.find((t) => t.key === trigger.triggerKey) : undefined;
}

export function draftFromDetail(detail: Pick<AutomationDetailView, "name" | "description" | "maxRunsPerHour" | "trigger" | "conditions" | "actions" | "canvasLayout">, catalogue: Catalogue | undefined): Draft {
  const fields = triggerEntry(detail.trigger, catalogue)?.fields ?? [];
  return {
    name: detail.name,
    description: detail.description ?? "",
    maxRunsPerHour: String(detail.maxRunsPerHour),
    trigger: detail.trigger,
    match: detail.conditions.match,
    groups: treeToGroups(detail.conditions, fields),
    actions: detail.actions.map((a) => ({ stepKey: a.stepKey, actionKey: a.actionKey, label: a.label ?? "", config: { ...a.config }, secrets: {}, secretStatus: { ...a.secretStatus } })),
    positions: { ...(detail.canvasLayout?.positions ?? {}) },
  };
}

export function draftFromRecipe(recipe: AutomationStarterRecipe, catalogue: Catalogue | undefined): Draft {
  const fields = triggerEntry(recipe.trigger, catalogue)?.fields ?? [];
  return {
    ...emptyDraft(),
    name: recipe.name,
    description: recipe.description,
    trigger: recipe.trigger,
    match: recipe.conditions.match,
    groups: treeToGroups(recipe.conditions, fields),
    actions: recipe.actions.map((a) => ({ stepKey: a.stepKey, actionKey: a.actionKey, label: a.label ?? "", config: { ...a.config }, secrets: {}, secretStatus: {} })),
  };
}

/* ------------------------------------------------------------------ fields, picker options and scope */

/** Fields usable in conditions: the trigger's non-personal fields. Manual and scheduled runs have none. */
export function conditionFields(trigger: AutomationTriggerConfig | null, catalogue: Catalogue | undefined): TriggerField[] {
  return (triggerEntry(trigger, catalogue)?.fields ?? []).filter((f) => !f.personal);
}

const FALLBACK_FIELD_SOURCES: Readonly<Record<string, CatalogueFieldOptionSourceKey>> = {
  to_status: "statuses",
  from_status: "statuses",
  status_key: "statuses",
  current_status: "statuses",
  stage_key: "stages",
  phase_key: "stages",
  workflow_key: "workflows",
  method: "paymentMethods",
  payment_method: "paymentMethods",
  provider: "paymentProviders",
  questionnaire_public_id: "intakeQuestionnaires",
  questionnaire_key: "intakeQuestionnaires",
  decision: "intakeDecisions",
};

function readPickerSource(
  pickerOptions: AutomationCataloguePickerOptions | undefined,
  sourceKey: CatalogueFieldOptionSourceKey | undefined,
): readonly CataloguePickerOption[] {
  if (!pickerOptions || !sourceKey) return [];
  if (sourceKey === "emailTemplates") {
    return (pickerOptions.emailTemplates ?? []).map((tpl) => ({
      value: tpl.templateKey,
      label: `${tpl.name} (${tpl.templateKey})`,
    }));
  }
  return pickerOptions[sourceKey] ?? [];
}

/**
 * Resolves real option-list choices for a trigger field (statuses, phases, workflows, payment methods/providers,
 * intake questionnaires/decisions, or static `enumValues`). Returns `[]` when free-form input is expected.
 */
export function fieldPickerOptions(field: TriggerField | undefined, catalogue: Catalogue | undefined): CataloguePickerOption[] {
  if (!field) return [];
  const picker = catalogue?.pickerOptions;
  const sourceKey = picker?.fieldOptionSources?.[field.key] ?? FALLBACK_FIELD_SOURCES[field.key];
  const fromCatalogue = readPickerSource(picker, sourceKey);
  if (fromCatalogue.length > 0) {
    return fromCatalogue.map((opt) => ({
      value: opt.value,
      label: opt.secondaryLabel ? `${opt.label} (${opt.secondaryLabel})` : opt.label,
      ...(opt.disabled !== undefined ? { disabled: opt.disabled } : {}),
    }));
  }
  if (field.type === "enum" && field.enumValues && field.enumValues.length > 0) {
    return field.enumValues.map((v) => ({
      value: v,
      label: v.replace(/_/g, " "),
    }));
  }
  return [];
}

const PRIMARY_SCOPE_FIELD_PRIORITY: readonly string[] = [
  "to_status",
  "stage_key",
  "status_key",
  "questionnaire_public_id",
  "decision",
  "provider",
  "method",
  "workflow_key",
];

/**
 * Returns the primary option-backed field for the "All occurrences / Specific value" scope selector on an event trigger,
 * or `undefined` when the event has no option-backed scope field.
 */
export function primaryScopeField(trigger: AutomationTriggerConfig | null, catalogue: Catalogue | undefined): TriggerField | undefined {
  if (trigger?.kind !== "event") return undefined;
  const fields = conditionFields(trigger, catalogue);
  for (const key of PRIMARY_SCOPE_FIELD_PRIORITY) {
    const match = fields.find((f) => f.key === key);
    if (match && fieldPickerOptions(match, catalogue).length > 0) return match;
  }
  return fields.find((f) => fieldPickerOptions(f, catalogue).length > 0);
}

export type SimpleFieldScope =
  | { mode: "all" }
  | { mode: "specific"; value: string }
  | { mode: "complex"; count: number };

/**
 * Inspects `draft.groups` for a single `eq` scope leaf on `fieldKey` without losing complex multi-group trees.
 */
export function getSimpleFieldScope(draft: Pick<Draft, "groups" | "match">, fieldKey: string): SimpleFieldScope {
  const matchingLeaves: { groupIndex: number; groupMatch: "all" | "any"; cond: DraftCondition }[] = [];
  draft.groups.forEach((group, groupIndex) => {
    for (const cond of group.conditions) {
      if (cond.field === fieldKey) {
        matchingLeaves.push({ groupIndex, groupMatch: group.match, cond });
      }
    }
  });
  if (matchingLeaves.length === 0) return { mode: "all" };
  if (
    matchingLeaves.length === 1 &&
    draft.match === "all" &&
    matchingLeaves[0]!.groupMatch === "all" &&
    matchingLeaves[0]!.cond.operator === "eq"
  ) {
    return { mode: "specific", value: matchingLeaves[0]!.cond.value };
  }
  return { mode: "complex", count: matchingLeaves.length };
}

/**
 * Sets or clears a simple `eq` filter on `fieldKey` while preserving all unrelated conditions and groups.
 */
export function setSimpleFieldScope(draft: Draft, fieldKey: string, nextValue: string | null): Draft {
  if (nextValue === null) {
    const groups = draft.groups
      .map((g) => ({
        ...g,
        conditions: g.conditions.filter((c) => !(c.field === fieldKey && c.operator === "eq")),
      }))
      .filter((g) => g.conditions.length > 0);
    return { ...draft, groups };
  }

  let updated = false;
  const groups = draft.groups.map((g) => {
    if (updated || g.match !== "all") return g;
    const idx = g.conditions.findIndex((c) => c.field === fieldKey && c.operator === "eq");
    if (idx < 0) return g;
    updated = true;
    const conditions = [...g.conditions];
    conditions[idx] = { ...conditions[idx]!, value: nextValue };
    return { ...g, conditions };
  });

  if (updated) return { ...draft, match: "all", groups };

  const ids = allConditionIds(draft);
  const condId = nextId("c", ids);
  if (groups.length > 0 && groups[0]!.match === "all") {
    const first = groups[0]!;
    const nextGroups = [...groups];
    nextGroups[0] = {
      ...first,
      conditions: [{ id: condId, field: fieldKey, operator: "eq", value: nextValue }, ...first.conditions],
    };
    return { ...draft, match: "all", groups: nextGroups };
  }

  const groupId = nextId("g", [...ids, condId]);
  return {
    ...draft,
    match: "all",
    groups: [
      { id: groupId, match: "all", conditions: [{ id: condId, field: fieldKey, operator: "eq", value: nextValue }] },
      ...groups,
    ],
  };
}

export function operatorsFor(field: TriggerField | undefined, catalogue: Catalogue | undefined): readonly ConditionOperator[] {
  if (!field || !catalogue) return [];
  return catalogue.operatorsByFieldType[field.type] ?? [];
}

export const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  eq: "is", neq: "is not", in: "is one of", not_in: "is none of", gt: "is greater than", gte: "is at least",
  lt: "is less than", lte: "is at most", contains: "contains", starts_with: "starts with", is_true: "is yes",
  is_false: "is no", exists: "has a value",
};

export const operatorNeedsValue = (op: ConditionOperator | ""): boolean => op !== "" && op !== "is_true" && op !== "is_false" && op !== "exists";
const LIST_OPS: readonly string[] = ["in", "not_in"];

type LeafValue = string | number | boolean | (string | number)[] | null;

/** Converts the typed text to the value the server expects, or returns an error message. */
export function parseConditionValue(field: TriggerField, op: ConditionOperator | "", text: string): { value?: LeafValue; error?: string } {
  if (!operatorNeedsValue(op)) return { value: null };
  const raw = text.trim();
  if (raw === "") return { error: "Enter a value." };
  const one = (part: string): { value?: string | number; error?: string } => {
    if (field.type === "number") return Number.isFinite(Number(part)) ? { value: Number(part) } : { error: "Enter a number." };
    if (field.type === "money_minor") {
      return /^\d{1,12}(\.\d{1,2})?$/.test(part) ? { value: Math.round(Number(part) * 100) } : { error: "Enter an amount such as 12.50." };
    }
    if (field.type === "enum" && field.enumValues && !field.enumValues.includes(part)) return { error: `Choose one of: ${field.enumValues.join(", ")}.` };
    if (part.length > 200) return { error: "Keep the value under 200 characters." };
    return { value: part };
  };
  if (LIST_OPS.includes(op)) {
    const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0 || parts.length > 20) return { error: "Enter 1 to 20 values separated by commas." };
    const values: (string | number)[] = [];
    for (const part of parts) {
      const r = one(part);
      if (r.error) return { error: r.error };
      values.push(r.value as string | number);
    }
    return { value: values };
  }
  return one(raw);
}

/* ------------------------------------------------------------------ validation */

export type StepId = "trigger" | "conditions" | "actions" | "review";
export type Errors = Record<string, string>;

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/u;
const MANAGED_WEBHOOK_TARGET_RE = /^(production:[A-Za-z0-9_-]{2,32}|subscription:[0-9A-HJKMNP-TV-Z]{26})$/;
const ALERT_CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

export function orderContextAvailable(trigger: AutomationTriggerConfig | null, catalogue: Catalogue | undefined): boolean {
  if (!trigger) return false;
  if (trigger.kind === "manual") return trigger.requireOrderPublicId === true;
  if (trigger.kind === "schedule") return false;
  const entry = triggerEntry(trigger, catalogue);
  return entry?.resourceType === "order" || (entry?.fields ?? []).some((f) => f.key === "order_public_id" || f.key === "order_reference");
}

export function validateTrigger(draft: Draft, catalogue: Catalogue | undefined): Errors {
  const errors: Errors = {};
  const name = draft.name.trim();
  if (!name) errors.name = "Give the automation a name.";
  else if (name.length > 120) errors.name = "Keep the name under 120 characters.";
  if (draft.description.length > 500) errors.description = "Keep the description under 500 characters.";
  if (draft.maxRunsPerHour.trim() !== "") {
    const n = Number(draft.maxRunsPerHour);
    const max = catalogue?.limits.maxPerAutomationRunsPerHour ?? 600;
    if (!Number.isInteger(n) || n < 1 || n > max) errors.maxRunsPerHour = `Enter a whole number from 1 to ${max}.`;
  }
  const t = draft.trigger;
  if (!t) errors.trigger = "Choose what starts this automation.";
  else if (t.kind === "event" && !triggerEntry(t, catalogue)) errors.triggerKey = "Choose an event.";
  else if (t.kind === "schedule") {
    const min = catalogue?.limits.minScheduleMinutes ?? 15;
    const max = catalogue?.limits.maxScheduleMinutes ?? 10_080;
    if (!Number.isInteger(t.everyMinutes) || t.everyMinutes < min || t.everyMinutes > max) errors.everyMinutes = `Enter a whole number of minutes from ${min} to ${max}.`;
  }
  return errors;
}

export function validateConditions(draft: Draft, catalogue: Catalogue | undefined): Errors {
  const errors: Errors = {};
  const fields = conditionFields(draft.trigger, catalogue);
  const maxGroups = catalogue?.limits.maxConditionGroups ?? 10;
  const maxPer = catalogue?.limits.maxConditionsPerGroup ?? 20;
  if (draft.groups.length > maxGroups) errors.groups = `Use at most ${maxGroups} groups.`;
  if (draft.groups.length > 0 && fields.length === 0) errors.groups = "This trigger has no fields to test. Remove the conditions.";
  for (const group of draft.groups) {
    if (group.conditions.length === 0) errors[group.id] = "Add a condition to this group or remove the group.";
    if (group.conditions.length > maxPer) errors[group.id] = `Use at most ${maxPer} conditions in a group.`;
    for (const c of group.conditions) {
      const field = fields.find((f) => f.key === c.field);
      if (!field) { errors[`${c.id}.field`] = "Choose a field."; continue; }
      if (!c.operator || !operatorsFor(field, catalogue).includes(c.operator)) { errors[`${c.id}.operator`] = "Choose a comparison."; continue; }
      const parsed = parseConditionValue(field, c.operator, c.value);
      if (parsed.error) errors[`${c.id}.value`] = parsed.error;
    }
  }
  return errors;
}

function validateSpecialActionConfig(step: DraftAction, at: (key: string) => string, errors: Errors): boolean {
  if (step.actionKey === "order.set_completion") {
    const kind = step.config.kind;
    if (kind !== "fixed" && kind !== "range") {
      errors[at("kind")] = "Choose fixed percentage or random range.";
      return true;
    }
    if (kind === "fixed") {
      const pct = step.config.percent;
      if (typeof pct !== "number" || !Number.isInteger(pct) || pct < 0 || pct > 100) {
        errors[at("percent")] = "Enter a whole percentage from 0 to 100.";
      }
    } else {
      const minP = step.config.minPercent;
      const maxP = step.config.maxPercent;
      if (typeof minP !== "number" || !Number.isInteger(minP) || minP < 0 || minP > 100) {
        errors[at("minPercent")] = "Enter a whole percentage from 0 to 100.";
      }
      if (typeof maxP !== "number" || !Number.isInteger(maxP) || maxP < 0 || maxP > 100) {
        errors[at("maxPercent")] = "Enter a whole percentage from 0 to 100.";
      }
      if (
        typeof minP === "number" &&
        typeof maxP === "number" &&
        Number.isInteger(minP) &&
        Number.isInteger(maxP) &&
        minP > maxP
      ) {
        errors[at("minPercent")] = "The lowest percentage must not be above the highest.";
      }
    }
    const delay = step.config.delayMinutes ?? 0;
    if (
      typeof delay !== "number" ||
      !Number.isInteger(delay) ||
      delay < 0 ||
      delay > STAGE_COMPLETION_DELAY_MAX_MINUTES
    ) {
      errors[at("delayMinutes")] = `Enter a whole number of minutes from 0 to ${STAGE_COMPLETION_DELAY_MAX_MINUTES}.`;
    }
    return true;
  }

  if (step.actionKey === "webhook.enqueue_subscription") {
    const targetKey = typeof step.config.targetKey === "string" ? step.config.targetKey.trim() : "";
    if (!targetKey) {
      errors[at("targetKey")] = "Choose a managed webhook subscription.";
    } else if (/^https?:\/\//i.test(targetKey) || !MANAGED_WEBHOOK_TARGET_RE.test(targetKey)) {
      errors[at("targetKey")] = "Choose a managed webhook subscription instead of a raw URL.";
    }
    const eventKey = step.config.eventKey;
    if (eventKey !== undefined && eventKey !== "" && (typeof eventKey !== "string" || eventKey.length > 80)) {
      errors[at("eventKey")] = "Keep the custom event key within 80 characters.";
    }
    return true;
  }

  if (step.actionKey === "dashboard.create_alert") {
    const severity = step.config.severity;
    if (typeof severity !== "string" || !(STAGE_ALERT_SEVERITIES as readonly string[]).includes(severity)) {
      errors[at("severity")] = "Choose warning, error or critical.";
    }
    const title = typeof step.config.titleTemplate === "string" ? step.config.titleTemplate.trim() : "";
    if (!title) {
      errors[at("titleTemplate")] = "Enter an alert title.";
    } else if (title.length > 120) {
      errors[at("titleTemplate")] = "Keep the alert title within 120 characters.";
    }
    const body = step.config.bodyTemplate;
    if (typeof body === "string" && body.length > 500) {
      errors[at("bodyTemplate")] = "Keep the alert details within 500 characters.";
    }
    const code = step.config.code;
    if (typeof code === "string" && code.trim() !== "" && !ALERT_CODE_RE.test(code.trim())) {
      errors[at("code")] = "Use uppercase letters, digits and underscores (for example AUTOMATION_RULE_ALERT).";
    }
    return true;
  }

  return false;
}

export function validateActions(draft: Draft, catalogue: Catalogue | undefined): Errors {
  const errors: Errors = {};
  const max = catalogue?.limits.maxActionsPerAutomation ?? 10;
  if (draft.actions.length === 0) errors.actions = "Add at least one action.";
  if (draft.actions.length > max) errors.actions = `Use at most ${max} actions.`;
  const entry = triggerEntry(draft.trigger, catalogue);
  for (const step of draft.actions) {
    const def = catalogue?.actions.find((a) => a.key === step.actionKey);
    const at = (key: string) => `${step.stepKey}.${key}`;
    if (!def) { errors[at("action")] = "This action is not available."; continue; }
    if (draft.trigger && !def.supportedTriggerModes.includes(draft.trigger.kind)) errors[at("action")] = `“${def.label}” cannot run from this kind of trigger.`;
    if (def.requiresOrderContext && !orderContextAvailable(draft.trigger, catalogue)) errors[at("action")] = `“${def.label}” needs a trigger about an order.`;
    if (entry?.staffOnly && def.forbidOnStaffOnlyTrigger) errors[at("action")] = `“${def.label}” cannot be used with a staff-only trigger.`;
    if (validateSpecialActionConfig(step, at, errors)) continue;
    for (const field of def.configFields) {
      const value = step.config[field.key];
      if (field.type === "secret" || field.secret) {
        if (field.required && !step.secrets[field.key] && !step.secretStatus[field.key]?.configured) errors[at(field.key)] = "Enter this secret.";
        continue;
      }
      const empty = value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
      if (empty) {
        if (field.required && !(field.key === "fixedAddress" && step.config.recipientMode !== "fixed") && !(field.key === "recipientKey" && step.config.recipientMode === "fixed")) errors[at(field.key)] = "This is required.";
        continue;
      }
      if (field.type === "email" && (typeof value !== "string" || !EMAIL_RE.test(value) || value.length > 254)) errors[at(field.key)] = "Enter an e-mail address such as name@example.com.";
      if (field.type === "https_url" && (typeof value !== "string" || !/^https:\/\/[^\s]+$/u.test(value) || value.length > 2048)) errors[at(field.key)] = "Enter an address that starts with https://.";
      if (field.type === "webhook_subscription" && (typeof value !== "string" || !MANAGED_WEBHOOK_TARGET_RE.test(value))) {
        errors[at(field.key)] = "Choose a managed webhook subscription.";
      }
      if (field.type === "number" && (typeof value !== "number" || (field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max))) {
        errors[at(field.key)] = `Enter a number${field.min !== undefined ? ` from ${field.min}` : ""}${field.max !== undefined ? ` to ${field.max}` : ""}.`;
      }
      if (typeof value === "string" && field.maxLength !== undefined && value.length > field.maxLength) errors[at(field.key)] = `Keep this under ${field.maxLength} characters.`;
      if (field.type === "trigger_recipient" && entry && !entry.recipients.some((r) => r.key === value)) errors[at(field.key)] = "Choose someone this trigger can address.";
    }
  }
  return errors;
}

export function validateDraft(draft: Draft, catalogue: Catalogue | undefined): Record<Exclude<StepId, "review">, Errors> {
  return { trigger: validateTrigger(draft, catalogue), conditions: validateConditions(draft, catalogue), actions: validateActions(draft, catalogue) };
}

export const hasErrors = (e: Errors): boolean => Object.keys(e).length > 0;

/* ------------------------------------------------------------------ save input */

export function toConditionTree(draft: Draft, catalogue: Catalogue | undefined): AutomationConditionTree {
  const fields = conditionFields(draft.trigger, catalogue);
  return {
    match: draft.match,
    groups: draft.groups.map((g) => ({
      match: g.match,
      conditions: g.conditions.map((c) => {
        const field = fields.find((f) => f.key === c.field);
        const value = field ? parseConditionValue(field, c.operator, c.value).value ?? null : null;
        return { field: c.field, operator: c.operator as ConditionOperator, value };
      }),
    })),
  };
}

export function toSaveInput(draft: Draft, catalogue: Catalogue | undefined) {
  return {
    name: draft.name.trim(),
    description: draft.description.trim() || undefined,
    maxRunsPerHour: draft.maxRunsPerHour.trim() === "" ? undefined : Number(draft.maxRunsPerHour),
    trigger: draft.trigger as AutomationTriggerConfig,
    conditions: toConditionTree(draft, catalogue),
    actions: draft.actions.map((a) => ({
      stepKey: a.stepKey,
      actionKey: a.actionKey,
      label: a.label.trim() || undefined,
      config: a.config,
      ...(Object.keys(a.secrets).length > 0 ? { secrets: { ...a.secrets } } : {}),
    })),
    canvasLayout: { positions: draft.positions },
  };
}

/* ------------------------------------------------------------------ draft edits (shared by wizard and canvas) */

function defaultActionConfig(actionKey: string): Record<string, unknown> {
  if (actionKey === "order.set_completion") {
    return { kind: "fixed", percent: 50, delayMinutes: 0 };
  }
  if (actionKey === "webhook.enqueue_subscription") {
    return { targetKey: "", includeEvaluatedFields: true };
  }
  if (actionKey === "dashboard.create_alert") {
    return { severity: "warning", titleTemplate: "" };
  }
  return {};
}

export function addAction(draft: Draft, actionKey: string, afterIndex = draft.actions.length - 1): Draft {
  const stepKey = nextId("step_", draft.actions.map((a) => a.stepKey));
  const step: DraftAction = { stepKey, actionKey, label: "", config: defaultActionConfig(actionKey), secrets: {}, secretStatus: {} };
  const actions = [...draft.actions];
  actions.splice(afterIndex + 1, 0, step);
  return { ...draft, actions };
}

export function moveAction(draft: Draft, stepKey: string, delta: -1 | 1): Draft {
  const i = draft.actions.findIndex((a) => a.stepKey === stepKey);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= draft.actions.length) return draft;
  const actions = [...draft.actions];
  [actions[i], actions[j]] = [actions[j]!, actions[i]!];
  return { ...draft, actions };
}

export function removeAction(draft: Draft, stepKey: string): Draft {
  const { [stepKey]: _gone, ...positions } = draft.positions;
  return { ...draft, actions: draft.actions.filter((a) => a.stepKey !== stepKey), positions };
}

export function updateAction(draft: Draft, stepKey: string, patch: Partial<DraftAction>): Draft {
  return { ...draft, actions: draft.actions.map((a) => (a.stepKey === stepKey ? { ...a, ...patch } : a)) };
}

export function addGroup(draft: Draft): Draft {
  const ids = allConditionIds(draft);
  const gid = nextId("g", ids);
  return { ...draft, groups: [...draft.groups, { id: gid, match: "all", conditions: [{ id: nextId("c", ids), field: "", operator: "", value: "" }] }] };
}

export function addCondition(draft: Draft, groupId: string): Draft {
  const id = nextId("c", allConditionIds(draft));
  return { ...draft, groups: draft.groups.map((g) => (g.id === groupId ? { ...g, conditions: [...g.conditions, { id, field: "", operator: "", value: "" }] } : g)) };
}

export function updateCondition(draft: Draft, conditionId: string, patch: Partial<DraftCondition>): Draft {
  return { ...draft, groups: draft.groups.map((g) => ({ ...g, conditions: g.conditions.map((c) => (c.id === conditionId ? { ...c, ...patch } : c)) })) };
}

export function removeCondition(draft: Draft, conditionId: string): Draft {
  return { ...draft, groups: draft.groups.map((g) => ({ ...g, conditions: g.conditions.filter((c) => c.id !== conditionId) })).filter((g) => g.conditions.length > 0) };
}

/** Changing the trigger drops conditions on fields the new trigger does not have. */
export function setTrigger(draft: Draft, trigger: AutomationTriggerConfig | null, catalogue: Catalogue | undefined): Draft {
  const keys = new Set(conditionFields(trigger, catalogue).map((f) => f.key));
  const groups = draft.groups.map((g) => ({ ...g, conditions: g.conditions.filter((c) => keys.has(c.field) || c.field === "") })).filter((g) => g.conditions.length > 0);
  return { ...draft, trigger, groups };
}

/* ------------------------------------------------------------------ canvas projection */

export const TRIGGER_NODE = "trigger";
export const CONDITIONS_NODE = "conditions";
const GRID = 20;

export interface GraphNode { id: string; label: string; sublabel?: string; kind: "Trigger" | "Condition" | "Action"; tone: "info" | "warning" | "success" | "danger" | "neutral"; x: number; y: number }
export interface GraphEdge { id: string; from: string; to: string; label?: string }

export function triggerLabel(trigger: AutomationTriggerConfig | null, catalogue: Catalogue | undefined): string {
  if (!trigger) return "No trigger yet";
  if (trigger.kind === "manual") return "Run by hand";
  if (trigger.kind === "schedule") return `Every ${formatMinutes(trigger.everyMinutes)}`;
  return triggerEntry(trigger, catalogue)?.label ?? "Unknown event";
}

export function formatMinutes(minutes: number): string {
  if (minutes <= 0) return "immediately";
  if (minutes % 1440 === 0) return minutes === 1440 ? "day" : `${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? "hour" : `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

export function conditionSummary(draft: Pick<Draft, "groups" | "match">): string {
  const count = draft.groups.reduce((n, g) => n + g.conditions.length, 0);
  if (count === 0) return "Always";
  return `${count} condition${count === 1 ? "" : "s"}, ${draft.match === "all" ? "all groups" : "any group"} must match`;
}

export function toGraph(draft: Draft, catalogue: Catalogue | undefined, errors?: Record<Exclude<StepId, "review">, Errors>): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const pos = (id: string, index: number) => draft.positions[id] ?? { x: GRID * 2 + index * 320, y: GRID * 4 };
  const nodes: GraphNode[] = [];
  const order: string[] = [TRIGGER_NODE];
  nodes.push({ id: TRIGGER_NODE, kind: "Trigger", label: triggerLabel(draft.trigger, catalogue), sublabel: draft.trigger?.kind === "event" ? "Event" : draft.trigger ? (draft.trigger.kind === "manual" ? "Manual" : "Schedule") : "Choose a trigger",
    tone: errors && hasErrors(errors.trigger) ? "danger" : "info", ...pos(TRIGGER_NODE, 0) });
  if (draft.groups.length > 0) {
    order.push(CONDITIONS_NODE);
    nodes.push({ id: CONDITIONS_NODE, kind: "Condition", label: "Only when", sublabel: conditionSummary(draft), tone: errors && hasErrors(errors.conditions) ? "danger" : "warning", ...pos(CONDITIONS_NODE, 1) });
  }
  draft.actions.forEach((step, i) => {
    const def = catalogue?.actions.find((a) => a.key === step.actionKey);
    const bad = errors && Object.keys(errors.actions).some((k) => k.startsWith(`${step.stepKey}.`));
    order.push(step.stepKey);
    nodes.push({ id: step.stepKey, kind: "Action", label: step.label.trim() || def?.label || step.actionKey, sublabel: `Step ${i + 1}`, tone: bad ? "danger" : "success", ...pos(step.stepKey, order.length - 1) });
  });
  const edges: GraphEdge[] = order.slice(1).map((to, i) => ({ id: `${order[i]}->${to}`, from: order[i]!, to, ...(order[i] === CONDITIONS_NODE ? { label: "if matched" } : {}) }));
  return { nodes, edges };
}

/**
 * Canvas "connect": linking A → B (B an action) places B directly after A. Linking anything else is refused
 * (returns null) — the trigger is always first and conditions always come before actions.
 */
export function connect(draft: Draft, from: string, to: string): Draft | null {
  const target = draft.actions.findIndex((a) => a.stepKey === to);
  if (target < 0 || from === to) return null;
  const actions = [...draft.actions];
  const [moved] = actions.splice(target, 1);
  const anchor = from === TRIGGER_NODE || from === CONDITIONS_NODE ? -1 : actions.findIndex((a) => a.stepKey === from);
  if (anchor < 0 && from !== TRIGGER_NODE && from !== CONDITIONS_NODE) return null;
  actions.splice(anchor + 1, 0, moved!);
  return { ...draft, actions };
}

export function setPosition(draft: Draft, id: string, x: number, y: number): Draft {
  return { ...draft, positions: { ...draft.positions, [id]: { x: Math.round(x), y: Math.round(y) } } };
}

/* ------------------------------------------------------------------ run and step presentation */

type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "brand";

export const RUN_STATE: Record<AutomationRunState, { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "info" },
  completed: { label: "Completed", tone: "success" },
  skipped_conditions: { label: "Conditions not met", tone: "neutral" },
  rate_limited: { label: "Rate limited", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
  partial_unknown: { label: "Outcome unknown", tone: "warning" },
  canceled: { label: "Canceled", tone: "neutral" },
};

export const STEP_STATE: Record<AutomationStepState, { label: string; tone: Tone }> = {
  pending: { label: "Waiting", tone: "neutral" },
  dispatching: { label: "Sending", tone: "info" },
  completed: { label: "Done", tone: "success" },
  skipped: { label: "Skipped", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" },
  unknown: { label: "Outcome unknown — not retried automatically", tone: "warning" },
};

export const STAGE_RUN_STATE_META: Record<OrderStageRunState, { label: string; tone: Tone }> = {
  completed: { label: "Completed", tone: "success" },
  partial_failed: { label: "Partially completed", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
};

export const STAGE_SLOT_OUTCOME_META: Record<StageBundleSlotOutcome, { label: string; tone: Tone }> = {
  completed: { label: "Completed", tone: "success" },
  scheduled: { label: "Scheduled", tone: "info" },
  skipped: { label: "Skipped", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" },
};

export const COMPLETION_JOB_STATE_META: Record<CompletionJobState, { label: string; tone: Tone }> = {
  scheduled: { label: "Scheduled", tone: "info" },
  applied: { label: "Applied", tone: "success" },
  superseded: { label: "Superseded", tone: "neutral" },
  canceled: { label: "Canceled", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" },
};

export const TRIGGER_MODE_LABEL = { event: "Event", manual: "Manual", schedule: "Schedule" } as const;

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 120_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

export function recipientOptions(trigger: AutomationTriggerConfig | null, catalogue: Catalogue | undefined): { value: string; label: string }[] {
  const entry = triggerEntry(trigger, catalogue);
  if (entry) return entry.recipients.map((r) => ({ value: r.key, label: r.label }));
  return [{ value: "administrators", label: "Administrators" }, { value: "staff", label: "All staff" }];
}

export function templateFields(trigger: AutomationTriggerConfig | null, catalogue: Catalogue | undefined): TriggerField[] {
  return [...(triggerEntry(trigger, catalogue)?.fields ?? [])];
}
