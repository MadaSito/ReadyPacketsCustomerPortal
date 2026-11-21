/** Workflow designer — form fields shared by the wizard steps and the canvas side panel. */
import { AlertTriangle, CircleAlert } from "lucide-react";
import { Callout, Checkbox, Field, Input, Select } from "@/ui";
import { ACTORS, fieldError, KIND_OPTIONS, stateLabel, toggleActor, TONE_OPTIONS, type DraftDefinition, type DraftState, type DraftTransition, type WorkflowIssue } from "./model";

export function StatusFields({ state, index, issues, onChange }: { state: DraftState; index: number; issues: readonly WorkflowIssue[]; onChange: (patch: Partial<DraftState>) => void }) {
  const at = (field: string) => fieldError(issues, `states.${index}.${field}`);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Staff label" required error={at("label")}>
        <Input value={state.label} maxLength={60} onChange={(event) => onChange({ label: event.target.value })} />
      </Field>
      <Field label="Customers see" required hint="Shown to the customer on their order." error={at("customerLabel")}>
        <Input value={state.customerLabel} maxLength={60} onChange={(event) => onChange({ customerLabel: event.target.value })} />
      </Field>
      <Field label="Key" required hint="Lowercase letters, digits and underscores; used in reports and automations." error={at("key")}>
        <Input value={state.key} maxLength={48} spellCheck={false} autoCapitalize="none" className="font-mono" onChange={(event) => onChange({ key: event.target.value })} />
      </Field>
      <Field label="Stage">
        <Select value={state.kind} options={KIND_OPTIONS} onChange={(event) => onChange({ kind: event.target.value as DraftState["kind"] })} />
      </Field>
      <Field label="Colour">
        <Select value={state.tone} options={TONE_OPTIONS} onChange={(event) => onChange({ tone: event.target.value as DraftState["tone"] })} />
      </Field>
    </div>
  );
}

export function TransitionRouteFields({ definition, transition, index, issues, onChange }: { definition: DraftDefinition; transition: DraftTransition; index: number; issues: readonly WorkflowIssue[]; onChange: (patch: Partial<DraftTransition>) => void }) {
  const options = uniqueStateOptions(definition);
  const at = (field: string) => fieldError(issues, `transitions.${index}.${field}`) ?? (field === "from" ? fieldError(issues, `transitions.${index}`) : undefined);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="From status" required error={at("from")}>
        <Select value={transition.from} placeholder="Choose a status" options={withCurrent(options, transition.from)} onChange={(event) => onChange({ from: event.target.value })} />
      </Field>
      <Field label="To status" required error={at("to")}>
        <Select value={transition.to} placeholder="Choose a status" options={withCurrent(options, transition.to)} onChange={(event) => onChange({ to: event.target.value })} />
      </Field>
    </div>
  );
}

export function TransitionWhoFields({ definition, transition, index, issues, onChange }: { definition: DraftDefinition; transition: DraftTransition; index: number; issues: readonly WorkflowIssue[]; onChange: (patch: Partial<DraftTransition>) => void }) {
  const error = fieldError(issues, `transitions.${index}.allowedBy`);
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium text-ink">
        Who may move an order from {stateLabel(definition, transition.from)} to {stateLabel(definition, transition.to)}
      </legend>
      <div className="flex flex-wrap gap-x-6 gap-y-1">
        {ACTORS.map((actor) => (
          <Checkbox
            key={actor.value}
            label={actor.label}
            checked={transition.allowedBy.includes(actor.value)}
            onCheckedChange={(on) => onChange({ allowedBy: toggleActor(transition.allowedBy, actor.value, on) })}
          />
        ))}
      </div>
      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

export function TransitionNoticeFields({ definition, transition, index, issues, onChange }: { definition: DraftDefinition; transition: DraftTransition; index: number; issues: readonly WorkflowIssue[]; onChange: (patch: Partial<DraftTransition>) => void }) {
  const name = `${stateLabel(definition, transition.from)} to ${stateLabel(definition, transition.to)}`;
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 text-sm font-medium text-ink">{name}</legend>
      <Checkbox label="Notify the customer" description="Sends the order status e-mail and an in-app notice." checked={transition.notifyCustomer} onCheckedChange={(on) => onChange({ notifyCustomer: on })} />
      <Checkbox label="Require a note" description="The person moving the order must explain why." checked={transition.requiresNote} onCheckedChange={(on) => onChange({ requiresNote: on })} />
      <Field label="Button label (optional)" hint="For example “Start review”. Leave empty to use “Move to …”." error={fieldError(issues, `transitions.${index}.actionLabel`)}>
        <Input
          value={transition.actionLabel ?? ""}
          maxLength={60}
          onChange={(event) => onChange({ actionLabel: event.target.value || undefined })}
        />
      </Field>
    </fieldset>
  );
}

/** Server issues as a list; errors first. `title` names the section, e.g. "Problems to fix in this step". */
export function IssueList({ issues, title, live }: { issues: readonly WorkflowIssue[]; title: string; live?: boolean }) {
  if (issues.length === 0) return null;
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  return (
    <Callout tone={errors.length ? "danger" : "warning"} title={title} live={live ? "polite" : undefined}>
      <ul className="mt-1 flex flex-col gap-1">
        {[...errors, ...warnings].map((issue, i) => (
          <li key={`${issue.code}-${issue.path}-${i}`} className="flex items-start gap-2">
            {issue.severity === "error" ? <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />}
            <span>
              <span className="sr-only">{issue.severity === "error" ? "Error: " : "Warning: "}</span>
              {issue.message}
            </span>
          </li>
        ))}
      </ul>
    </Callout>
  );
}

function uniqueStateOptions(definition: DraftDefinition) {
  const seen = new Set<string>();
  const options: { value: string; label: string }[] = [];
  for (const state of definition.states) {
    const key = state.key.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    options.push({ value: key, label: state.label.trim() || key });
  }
  return options;
}

/** Keeps an unknown current value selectable so the select never silently changes it. */
function withCurrent(options: { value: string; label: string }[], current: string) {
  return !current || options.some((option) => option.value === current) ? options : [...options, { value: current, label: `${current} (not a status)` }];
}
