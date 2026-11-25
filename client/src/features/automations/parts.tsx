/**
 * automations feature — editors shared by the wizard and the canvas side panel, plus small presentational parts.
 * Owner: siem_engineer (Increment 07 Package G client). Every control has a visible label; errors are tied to their fields.
 */
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import type { SelectHTMLAttributes } from "react";
import { STAGE_ALERT_SEVERITIES, STAGE_COMPLETION_DELAY_MAX_MINUTES } from "@shared/workflowStages";
import { Badge, Button, Callout, Checkbox, Field, IconButton, Input, KeyValueList, RadioGroup, Select, Textarea, useFieldControl } from "@/ui";
import {
  COMPLETION_JOB_STATE_META,
  OPERATOR_LABELS,
  RUN_STATE,
  STAGE_RUN_STATE_META,
  STAGE_SLOT_OUTCOME_META,
  STEP_STATE,
  addAction,
  addCondition,
  addGroup,
  conditionFields,
  fieldPickerOptions,
  formatDuration,
  formatMinutes,
  getSimpleFieldScope,
  moveAction,
  operatorNeedsValue,
  operatorsFor,
  primaryScopeField,
  recipientOptions,
  removeAction,
  removeCondition,
  setSimpleFieldScope,
  setTrigger,
  templateFields,
  triggerEntry,
  triggerLabel,
  updateAction,
  updateCondition,
  type AutomationRunView,
  type AutomationTestRunResult,
  type Catalogue,
  type CompletionJobState,
  type ConfigField,
  type Draft,
  type DraftAction,
  type Errors,
  type OrderStageRunState,
  type StageBundleSlotOutcome,
} from "./model";

type Change = (next: Draft) => void;

export function RunStateBadge({ state }: { state: keyof typeof RUN_STATE }) {
  const meta = RUN_STATE[state] ?? { label: state, tone: "neutral" as const };
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

export function StageRunStateBadge({ state }: { state: OrderStageRunState }) {
  const meta = STAGE_RUN_STATE_META[state] ?? { label: state, tone: "neutral" as const };
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

export function StageSlotOutcomeBadge({ outcome }: { outcome: StageBundleSlotOutcome }) {
  const meta = STAGE_SLOT_OUTCOME_META[outcome] ?? { label: outcome, tone: "neutral" as const };
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

export function CompletionJobStateBadge({ state }: { state: CompletionJobState }) {
  const meta = COMPLETION_JOB_STATE_META[state] ?? { label: state, tone: "neutral" as const };
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

export function EnabledBadge({ enabled }: { enabled: boolean }) {
  return enabled ? <Badge tone="success">On</Badge> : <Badge tone="neutral">Off</Badge>;
}

/* ------------------------------------------------------------------ trigger */

/** Native select with <optgroup>s, wired to its Field label, hint and error like the kit Select. */
function GroupedSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const wiring = useFieldControl();
  return <select className="min-h-11 w-full min-w-0 rounded-[var(--radius-control)] border border-control-border bg-surface px-3 py-2 text-ink hover:border-ink/60 focus-visible:border-action aria-invalid:border-2 aria-invalid:border-danger" {...wiring} {...props} />;
}

export function TriggerEditor({ draft, onChange, catalogue, errors }: { draft: Draft; onChange: Change; catalogue: Catalogue; errors: Errors }) {
  const kind = draft.trigger?.kind ?? "";
  const groups = [...new Set(catalogue.triggers.map((t) => t.group))];
  const entry = triggerEntry(draft.trigger, catalogue);
  const scopeField = primaryScopeField(draft.trigger, catalogue);
  const scopeOptions = fieldPickerOptions(scopeField, catalogue);
  const scope = scopeField ? getSimpleFieldScope(draft, scopeField.key) : null;

  return (
    <div className="flex flex-col gap-5">
      <Field label="Name" required error={errors.name}>
        <Input value={draft.name} maxLength={120} onChange={(e) => onChange({ ...draft, name: e.target.value })} />
      </Field>
      <Field label="Description" hint="Optional. What this automation is for." error={errors.description}>
        <Textarea rows={2} value={draft.description} maxLength={500} onChange={(e) => onChange({ ...draft, description: e.target.value })} />
      </Field>
      <RadioGroup
        legend="What starts it"
        required
        error={errors.trigger}
        value={kind}
        onValueChange={(value) => {
          const next = value === "event" ? { kind: "event" as const, triggerKey: "" } : value === "manual" ? { kind: "manual" as const } : { kind: "schedule" as const, everyMinutes: 60 };
          onChange(setTrigger(draft, next, catalogue));
        }}
        options={[
          { value: "event", label: "An event", description: "Something happens in the portal, such as an order being created." },
          { value: "schedule", label: "A schedule", description: "Runs at a fixed interval." },
          { value: "manual", label: "By hand", description: "An administrator starts it from the automation page." },
        ]}
      />
      {draft.trigger?.kind === "event" ? (
        <Field label="Event" required error={errors.triggerKey} hint={entry?.description}>
          <GroupedSelect
            value={draft.trigger.triggerKey}
            onChange={(e) => onChange(setTrigger(draft, { kind: "event", triggerKey: e.target.value }, catalogue))}
          >
            <option value="">Choose an event…</option>
            {groups.map((group) => (
              <optgroup key={group} label={group}>
                {catalogue.triggers.filter((t) => t.group === group).map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </optgroup>
            ))}
          </GroupedSelect>
        </Field>
      ) : null}

      {scopeField && scopeOptions.length > 0 && scope ? (
        scope.mode === "complex" ? (
          <Callout tone="info" title={`Filtered in Conditions (${scope.count} rules on ${scopeField.label})`}>
            This automation uses multi-condition rules for {scopeField.label.toLowerCase()}. Edit them on the Conditions step.
          </Callout>
        ) : (
          <div className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-line bg-surface-soft p-3.5 rp-forced-border">
            <RadioGroup
              legend={`Occurrences (${scopeField.label})`}
              value={scope.mode}
              onValueChange={(nextMode) => {
                if (nextMode === "all") {
                  onChange(setSimpleFieldScope(draft, scopeField.key, null));
                } else {
                  const firstVal = scopeOptions.find((o) => !o.disabled)?.value ?? scopeOptions[0]!.value;
                  onChange(setSimpleFieldScope(draft, scopeField.key, firstVal));
                }
              }}
              options={[
                { value: "all", label: "All occurrences", description: `Run for every ${entry?.label.toLowerCase() ?? "event"}.` },
                { value: "specific", label: "Specific value", description: `Run only for a chosen ${scopeField.label.toLowerCase()}.` },
              ]}
            />
            {scope.mode === "specific" ? (
              <Field label={scopeField.label} required>
                <Select
                  value={scope.value}
                  options={
                    scopeOptions.some((o) => o.value === scope.value) || !scope.value
                      ? scopeOptions
                      : [...scopeOptions, { value: scope.value, label: `${scope.value} (saved value)` }]
                  }
                  onChange={(e) => onChange(setSimpleFieldScope(draft, scopeField.key, e.currentTarget.value))}
                />
              </Field>
            ) : null}
          </div>
        )
      ) : null}

      {entry?.staffOnly ? <Callout tone="info" title="Staff-only event">Actions can address staff and administrators only.</Callout> : null}
      {draft.trigger?.kind === "schedule" ? (
        <Field label="Run every (minutes)" required error={errors.everyMinutes} hint={`From ${catalogue.limits.minScheduleMinutes} to ${catalogue.limits.maxScheduleMinutes} minutes.`}>
          <Input type="number" inputMode="numeric" min={catalogue.limits.minScheduleMinutes} max={catalogue.limits.maxScheduleMinutes}
            value={Number.isFinite(draft.trigger.everyMinutes) ? String(draft.trigger.everyMinutes) : ""}
            onChange={(e) => onChange({ ...draft, trigger: { kind: "schedule", everyMinutes: e.target.value === "" ? Number.NaN : Number(e.target.value) } })} />
        </Field>
      ) : null}
      {draft.trigger?.kind === "manual" ? (
        <Checkbox label="Ask for an order when started" description="Lets order actions (completion updates, copy files, SharePoint sync) run for the chosen order."
          checked={draft.trigger.requireOrderPublicId === true}
          onCheckedChange={(checked) => onChange({ ...draft, trigger: { kind: "manual", requireOrderPublicId: checked } })} />
      ) : null}
      <Field label="Runs per hour (limit)" hint={`Optional. Default ${catalogue.limits.defaultPerAutomationRunsPerHour}, at most ${catalogue.limits.maxPerAutomationRunsPerHour}.`} error={errors.maxRunsPerHour}>
        <Input type="number" inputMode="numeric" min={1} max={catalogue.limits.maxPerAutomationRunsPerHour} value={draft.maxRunsPerHour}
          onChange={(e) => onChange({ ...draft, maxRunsPerHour: e.target.value })} />
      </Field>
    </div>
  );
}

/* ------------------------------------------------------------------ conditions */

export function ConditionsEditor({ draft, onChange, catalogue, errors }: { draft: Draft; onChange: Change; catalogue: Catalogue; errors: Errors }) {
  const fields = conditionFields(draft.trigger, catalogue);
  if (fields.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">{draft.trigger?.kind === "event" ? "This event has no fields to test." : "Manual and scheduled automations have no event fields to test."} It always runs.</p>
        {errors.groups ? <Callout tone="danger">{errors.groups}</Callout> : null}
        {draft.groups.length > 0 ? <Button variant="secondary" onClick={() => onChange({ ...draft, groups: [] })}>Remove all conditions</Button> : null}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">Leave empty to run for all occurrences. Values come only from the event and its registered context; no expressions are evaluated.</p>
      {draft.groups.length > 1 ? (
        <RadioGroup legend="Groups" orientation="horizontal" value={draft.match} onValueChange={(v) => onChange({ ...draft, match: v as Draft["match"] })}
          options={[{ value: "all", label: "All groups must match" }, { value: "any", label: "Any group may match" }]} />
      ) : null}
      {errors.groups ? <Callout tone="danger">{errors.groups}</Callout> : null}
      {draft.groups.map((group, gi) => (
        <fieldset key={group.id} className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-line p-3 sm:p-4">
          <legend className="px-1 text-sm font-semibold text-ink">Group {gi + 1}</legend>
          {group.conditions.length > 1 ? (
            <RadioGroup legend={`Conditions in group ${gi + 1}`} orientation="horizontal" value={group.match}
              onValueChange={(v) => onChange({ ...draft, groups: draft.groups.map((g) => (g.id === group.id ? { ...g, match: v as Draft["match"] } : g)) })}
              options={[{ value: "all", label: "All must match" }, { value: "any", label: "Any may match" }]} />
          ) : null}
          {errors[group.id] ? <p className="text-sm text-danger">{errors[group.id]}</p> : null}
          {group.conditions.map((c, ci) => {
            const field = fields.find((f) => f.key === c.field);
            const ops = operatorsFor(field, catalogue);
            const pickerOpts = fieldPickerOptions(field, catalogue);
            const usePickerSelect = pickerOpts.length > 0 && c.operator !== "in" && c.operator !== "not_in" && c.operator !== "contains" && c.operator !== "starts_with";
            const selectOptions =
              usePickerSelect && c.value && !pickerOpts.some((opt) => opt.value === c.value)
                ? [...pickerOpts, { value: c.value, label: `${c.value} (saved value)` }]
                : pickerOpts;
            const n = `${gi + 1}.${ci + 1}`;
            return (
              <div key={c.id} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-start">
                <Field label={`Field ${n}`} error={errors[`${c.id}.field`]}>
                  <Select placeholder="Choose…" value={c.field} options={fields.map((f) => ({ value: f.key, label: f.label }))}
                    onChange={(e) => onChange(updateCondition(draft, c.id, { field: e.target.value, operator: "", value: "" }))} />
                </Field>
                <Field label={`Comparison ${n}`} error={errors[`${c.id}.operator`]}>
                  <Select placeholder="Choose…" value={c.operator} disabled={!field} options={ops.map((op) => ({ value: op, label: OPERATOR_LABELS[op] }))}
                    onChange={(e) => onChange(updateCondition(draft, c.id, { operator: e.target.value as typeof c.operator }))} />
                </Field>
                {operatorNeedsValue(c.operator) ? (
                  <Field label={`Value ${n}`} error={errors[`${c.id}.value`]} hint={field?.type === "money_minor" ? "Amount, e.g. 12.50" : c.operator === "in" || c.operator === "not_in" ? "Separate values with commas" : undefined}>
                    {usePickerSelect ? (
                      <Select placeholder="Choose…" value={c.value} options={selectOptions}
                        onChange={(e) => onChange(updateCondition(draft, c.id, { value: e.target.value }))} />
                    ) : (
                      <Input value={c.value} maxLength={400} inputMode={field?.type === "number" || field?.type === "money_minor" ? "decimal" : undefined}
                        onChange={(e) => onChange(updateCondition(draft, c.id, { value: e.target.value }))} />
                    )}
                  </Field>
                ) : <div className="hidden sm:block" />}
                <IconButton label={`Remove condition ${n}`} variant="ghost" className="sm:mt-7" onClick={() => onChange(removeCondition(draft, c.id))} icon={<Trash2 aria-hidden="true" />} />
              </div>
            );
          })}
          <div>
            <Button size="sm" variant="secondary" onClick={() => onChange(addCondition(draft, group.id))} disabled={group.conditions.length >= catalogue.limits.maxConditionsPerGroup}>
              <Plus aria-hidden="true" /> Add condition to group {gi + 1}
            </Button>
          </div>
        </fieldset>
      ))}
      <div>
        <Button variant="secondary" onClick={() => onChange(addGroup(draft))} disabled={draft.groups.length >= catalogue.limits.maxConditionGroups}>
          <Plus aria-hidden="true" /> {draft.groups.length === 0 ? "Add a condition" : "Add another group"}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ actions */

function parseWholeNumber(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function webhookTargetSelectOptions(catalogue: Catalogue, currentTargetKey: string | undefined) {
  const picker = catalogue.pickerOptions;
  const targets = picker?.webhookTargets ?? [];
  const subs = picker?.webhookSubscriptions ?? [];
  const seen = new Set<string>();
  const options: { value: string; label: string; disabled?: boolean }[] = [];

  for (const sub of subs) {
    seen.add(sub.targetKey);
    const flags = [
      sub.signingEnabled ? "signed" : "unsigned",
      sub.enabled ? null : "disabled",
    ].filter(Boolean);
    options.push({
      value: sub.targetKey,
      label: `${sub.label} (${flags.join(", ")})`,
      disabled: !sub.enabled,
    });
  }
  for (const target of targets) {
    if (seen.has(target.targetKey)) continue;
    seen.add(target.targetKey);
    const flags = [
      target.signingEnabled ? "signed" : "unsigned",
      target.configured && target.enabled ? null : "unavailable",
    ].filter(Boolean);
    options.push({
      value: target.targetKey,
      label: `${target.label} (${flags.join(", ")})`,
      disabled: !target.configured || !target.enabled,
    });
  }
  if (currentTargetKey && !seen.has(currentTargetKey)) {
    options.push({
      value: currentTargetKey,
      label: `Current target (${currentTargetKey})`,
    });
  }
  return options;
}

function SetCompletionActionEditor({
  step,
  draft,
  onChange,
  err,
}: {
  step: DraftAction;
  draft: Draft;
  onChange: Change;
  err: (key: string) => string | undefined;
}) {
  const kind = step.config.kind === "range" ? "range" : "fixed";
  const delayMinutes = typeof step.config.delayMinutes === "number" ? step.config.delayMinutes : 0;
  const delayMode = delayMinutes > 0 ? "delayed" : "immediate";
  const patchConfig = (patch: Record<string, unknown>) =>
    onChange(updateAction(draft, step.stepKey, { config: { ...step.config, ...patch } }));

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Completion mode"
          required
          hint="Fixed percentage or one cryptographically sampled value inside a range."
          error={err("kind")}
        >
          <Select
            value={kind}
            options={[
              { value: "fixed", label: "Fixed percentage" },
              { value: "range", label: "Random range" },
            ]}
            onChange={(event) => {
              const nextKind = event.currentTarget.value as "fixed" | "range";
              if (nextKind === "fixed") {
                const pct =
                  typeof step.config.percent === "number"
                    ? step.config.percent
                    : typeof step.config.minPercent === "number"
                      ? step.config.minPercent
                      : 50;
                onChange(
                  updateAction(draft, step.stepKey, {
                    config: { kind: "fixed", percent: pct, delayMinutes },
                  }),
                );
              } else {
                const base = typeof step.config.percent === "number" ? step.config.percent : 40;
                onChange(
                  updateAction(draft, step.stepKey, {
                    config: {
                      kind: "range",
                      minPercent: Math.min(base, 100),
                      maxPercent: Math.min(Math.max(base + 20, base), 100),
                      delayMinutes,
                    },
                  }),
                );
              }
            }}
          />
        </Field>

        <Field
          label="When to apply"
          required
          hint={`Delayed updates can be scheduled up to 30 days (${STAGE_COMPLETION_DELAY_MAX_MINUTES.toLocaleString()} minutes).`}
        >
          <Select
            value={delayMode}
            options={[
              { value: "immediate", label: "Apply immediately" },
              { value: "delayed", label: "Apply after a delay" },
            ]}
            onChange={(event) => {
              const nextDelay = event.currentTarget.value === "delayed" ? Math.max(1, delayMinutes || 60) : 0;
              patchConfig({ delayMinutes: nextDelay });
            }}
          />
        </Field>
      </div>

      {kind === "fixed" ? (
        <Field label="Completion percentage (0–100%)" required error={err("percent")}>
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            step={1}
            value={typeof step.config.percent === "number" ? String(step.config.percent) : ""}
            onChange={(event) => patchConfig({ percent: parseWholeNumber(event.currentTarget.value) })}
          />
        </Field>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Lowest percentage (0–100%)" required error={err("minPercent")}>
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              max={100}
              step={1}
              value={typeof step.config.minPercent === "number" ? String(step.config.minPercent) : ""}
              onChange={(event) => patchConfig({ minPercent: parseWholeNumber(event.currentTarget.value) })}
            />
          </Field>
          <Field label="Highest percentage (0–100%)" required error={err("maxPercent")}>
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              max={100}
              step={1}
              value={typeof step.config.maxPercent === "number" ? String(step.config.maxPercent) : ""}
              onChange={(event) => patchConfig({ maxPercent: parseWholeNumber(event.currentTarget.value) })}
            />
          </Field>
        </div>
      )}

      {delayMode === "delayed" ? (
        <Field
          label="Delay (minutes)"
          required
          hint={`1 to ${STAGE_COMPLETION_DELAY_MAX_MINUTES.toLocaleString()} minutes (${formatMinutes(delayMinutes)}).`}
          error={err("delayMinutes")}
        >
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={STAGE_COMPLETION_DELAY_MAX_MINUTES}
            step={1}
            value={delayMinutes > 0 ? String(delayMinutes) : ""}
            onChange={(event) => patchConfig({ delayMinutes: parseWholeNumber(event.currentTarget.value) })}
          />
        </Field>
      ) : null}
    </div>
  );
}

function EnqueueWebhookActionEditor({
  step,
  draft,
  onChange,
  catalogue,
  err,
}: {
  step: DraftAction;
  draft: Draft;
  onChange: Change;
  catalogue: Catalogue;
  err: (key: string) => string | undefined;
}) {
  const targetKey = typeof step.config.targetKey === "string" ? step.config.targetKey : "";
  const eventKey = typeof step.config.eventKey === "string" ? step.config.eventKey : "";
  const includeFields = step.config.includeEvaluatedFields !== false;
  const options = webhookTargetSelectOptions(catalogue, targetKey || undefined);
  const patchConfig = (patch: Record<string, unknown>) =>
    onChange(updateAction(draft, step.stepKey, { config: { ...step.config, ...patch } }));

  return (
    <div className="grid gap-4">
      <Field
        label="Webhook subscription"
        required
        hint={
          options.length > 0
            ? "Queues a signed delivery to a managed subscription or production webhook target. Raw URLs are never stored on rules."
            : "No managed webhook subscriptions are configured yet. Create one under Integrations → Webhooks first."
        }
        error={err("targetKey")}
      >
        <Select
          placeholder="Choose a webhook subscription…"
          value={targetKey}
          options={options}
          onChange={(event) => patchConfig({ targetKey: event.currentTarget.value })}
        />
      </Field>

      <Field
        label="Custom event key"
        hint="Optional identifier sent in the delivery metadata (defaults to the trigger key)."
        error={err("eventKey")}
      >
        <Input
          maxLength={80}
          value={eventKey}
          onChange={(event) => patchConfig({ eventKey: event.currentTarget.value || undefined })}
        />
      </Field>

      <Checkbox
        label="Include allowlisted event fields"
        description="Sends non-personal scalar fields from the trigger in the webhook payload."
        checked={includeFields}
        onCheckedChange={(checked) => patchConfig({ includeEvaluatedFields: checked })}
      />
    </div>
  );
}

function DashboardAlertActionEditor({
  step,
  draft,
  onChange,
  catalogue,
  err,
}: {
  step: DraftAction;
  draft: Draft;
  onChange: Change;
  catalogue: Catalogue;
  err: (key: string) => string | undefined;
}) {
  const severity = typeof step.config.severity === "string" ? step.config.severity : "warning";
  const titleTemplate = typeof step.config.titleTemplate === "string" ? step.config.titleTemplate : "";
  const bodyTemplate = typeof step.config.bodyTemplate === "string" ? step.config.bodyTemplate : "";
  const code = typeof step.config.code === "string" ? step.config.code : "";
  const vars = templateFields(draft.trigger, catalogue).filter((f) => !f.personal);
  const placeholderHint = vars.length ? `Placeholders: ${vars.map((v) => `{{${v.key}}}`).join(", ")}` : undefined;
  const patchConfig = (patch: Record<string, unknown>) =>
    onChange(updateAction(draft, step.stepKey, { config: { ...step.config, ...patch } }));

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Alert severity" required error={err("severity")}>
          <Select
            value={severity}
            options={STAGE_ALERT_SEVERITIES.map((sev) => ({
              value: sev,
              label: sev.charAt(0).toUpperCase() + sev.slice(1),
            }))}
            onChange={(event) => patchConfig({ severity: event.currentTarget.value })}
          />
        </Field>

        <Field
          label="Reason code"
          hint="Optional uppercase code (defaults to AUTOMATION_RULE_ALERT)."
          error={err("code")}
        >
          <Input
            maxLength={64}
            placeholder="AUTOMATION_RULE_ALERT"
            value={code}
            onChange={(event) =>
              patchConfig({
                code: event.currentTarget.value.toUpperCase().replace(/[^A-Z0-9_]/g, "") || undefined,
              })
            }
          />
        </Field>
      </div>

      <Field
        label="Alert title"
        required
        hint={["Shown on the operational alerts dashboard (up to 120 characters).", placeholderHint].filter(Boolean).join(" ")}
        error={err("titleTemplate")}
      >
        <Input
          maxLength={120}
          value={titleTemplate}
          onChange={(event) => patchConfig({ titleTemplate: event.currentTarget.value })}
        />
      </Field>

      <Field
        label="Alert details"
        hint={["Optional plain-text context for staff and administrators (up to 500 characters).", placeholderHint].filter(Boolean).join(" ")}
        error={err("bodyTemplate")}
      >
        <Textarea
          rows={3}
          maxLength={500}
          value={bodyTemplate}
          onChange={(event) => patchConfig({ bodyTemplate: event.currentTarget.value || undefined })}
        />
      </Field>
    </div>
  );
}

function ConfigFieldControl({ field, step, draft, onChange, catalogue, error }: { field: ConfigField; step: DraftAction; draft: Draft; onChange: Change; catalogue: Catalogue; error?: string }) {
  const value = step.config[field.key];
  const set = (v: unknown) => onChange(updateAction(draft, step.stepKey, { config: { ...step.config, [field.key]: v } }));
  const hint = field.helpText;
  if (field.type === "secret" || field.secret) {
    const status = step.secretStatus[field.key];
    return (
      <Field label={field.label} required={field.required && !status?.configured} error={error}
        hint={status?.configured ? `Configured${status.last4 ? ` (ends in ${status.last4})` : ""}. Leave empty to keep it.` : hint ?? "Stored encrypted; never shown again."}>
        <Input type="password" autoComplete="new-password" value={step.secrets[field.key] ?? ""}
          onChange={(e) => {
            const { [field.key]: _old, ...rest } = step.secrets;
            onChange(updateAction(draft, step.stepKey, { secrets: e.target.value ? { ...rest, [field.key]: e.target.value } : rest }));
          }} />
      </Field>
    );
  }
  if (field.type === "boolean") return <Checkbox label={field.label} description={hint} checked={value === true} onCheckedChange={(c) => set(c)} />;
  if (field.type === "enum") {
    return (
      <Field label={field.label} required={field.required} hint={hint} error={error}>
        <Select placeholder="Choose…" value={typeof value === "string" ? value : ""} options={field.enumOptions ?? []} onChange={(e) => set(e.target.value || undefined)} />
      </Field>
    );
  }
  if (field.type === "webhook_subscription") {
    const current = typeof value === "string" ? value : "";
    const options = webhookTargetSelectOptions(catalogue, current || undefined);
    return (
      <Field label={field.label} required={field.required} hint={hint ?? "Choose a managed webhook subscription."} error={error}>
        <Select placeholder="Choose…" value={current} options={options} onChange={(e) => set(e.target.value || undefined)} />
      </Field>
    );
  }
  if (field.type === "template_key" && (catalogue.pickerOptions?.emailTemplates?.length ?? 0) > 0) {
    const current = typeof value === "string" ? value : "";
    const templates = catalogue.pickerOptions!.emailTemplates;
    const options = templates.map((tpl) => ({
      value: tpl.templateKey,
      label: `${tpl.name} (${tpl.templateKey})`,
    }));
    if (current && !options.some((opt) => opt.value === current)) {
      options.push({ value: current, label: `Current template (${current})` });
    }
    return (
      <Field label={field.label} required={field.required} hint={hint ?? "Choose a published e-mail template."} error={error}>
        <Select placeholder="Choose a template…" value={current} options={options} onChange={(e) => set(e.target.value || undefined)} />
      </Field>
    );
  }
  if (field.type === "trigger_recipient") {
    return (
      <Field label={field.label} required={field.required} hint={hint ?? "People are resolved when the automation runs; addresses are never taken from the event."} error={error}>
        <Select placeholder="Choose…" value={typeof value === "string" ? value : ""} options={recipientOptions(draft.trigger, catalogue)} onChange={(e) => set(e.target.value || undefined)} />
      </Field>
    );
  }
  if (field.type === "trigger_fields") {
    const chosen = Array.isArray(value) ? (value as string[]) : [];
    const options = templateFields(draft.trigger, catalogue).filter((f) => !f.personal);
    return (
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-ink">{field.label}{field.required ? " (required)" : ""}</legend>
        {hint ? <p className="text-sm text-muted">{hint}</p> : null}
        {options.length === 0 ? <p className="text-sm text-muted">This trigger has no fields to send.</p> : options.map((f) => (
          <Checkbox key={f.key} label={f.label} checked={chosen.includes(f.key)}
            onCheckedChange={(c) => set(c ? [...chosen, f.key] : chosen.filter((k) => k !== f.key))} />
        ))}
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </fieldset>
    );
  }
  if (field.type === "textarea") {
    const vars = templateFields(draft.trigger, catalogue);
    return (
      <Field label={field.label} required={field.required} error={error}
        hint={[hint, vars.length ? `Placeholders: ${vars.map((v) => `{{${v.key}}}`).join(", ")}` : ""].filter(Boolean).join(" ")}>
        <Textarea rows={4} maxLength={field.maxLength} value={typeof value === "string" ? value : ""} onChange={(e) => set(e.target.value)} />
      </Field>
    );
  }
  if (field.type === "string_list") {
    return (
      <Field label={field.label} required={field.required} hint={hint ?? "Separate values with commas."} error={error}>
        <Input value={Array.isArray(value) ? (value as string[]).join(", ") : ""} onChange={(e) => set(e.target.value.split(",").map((v) => v.trim()).filter(Boolean))} />
      </Field>
    );
  }
  if (field.type === "number") {
    return (
      <Field label={field.label} required={field.required} hint={hint} error={error}>
        <Input type="number" inputMode="numeric" min={field.min} max={field.max} value={typeof value === "number" ? String(value) : ""}
          onChange={(e) => set(e.target.value === "" ? undefined : Number(e.target.value))} />
      </Field>
    );
  }
  if (field.key === "fixedAddress" && step.config.recipientMode !== "fixed") return null;
  if (field.key === "recipientKey" && step.config.recipientMode === "fixed") return null;
  const type = field.type === "email" ? "email" : field.type === "https_url" ? "url" : "text";
  const typeHint = field.type === "template_key" ? "The key of a published e-mail template, for example order.confirmation."
    : field.type === "storage_connection" ? "Optional. The id of a storage connection; empty uses the one assigned to order files." : undefined;
  return (
    <Field label={field.label} required={field.required} hint={hint ?? typeHint} error={error}>
      <Input type={type} maxLength={field.maxLength} value={typeof value === "string" ? value : ""} onChange={(e) => set(e.target.value || undefined)}
        {...(type === "url" ? { placeholder: "https://" } : {})} />
    </Field>
  );
}

export function ActionForm({ step, index, draft, onChange, catalogue, errors }: { step: DraftAction; index: number; draft: Draft; onChange: Change; catalogue: Catalogue; errors: Errors }) {
  const def = catalogue.actions.find((a) => a.key === step.actionKey);
  const err = (key: string) => errors[`${step.stepKey}.${key}`];
  return (
    <div className="flex flex-col gap-4">
      {err("action") ? <Callout tone="danger">{err("action")}</Callout> : null}
      {def ? <p className="text-sm text-muted">{def.description}{def.retrySafe ? "" : " If the outcome is unknown it is not sent again automatically."}</p> : null}
      <Field label={`Step ${index + 1} label`} hint="Optional. Shown in run history and on the canvas.">
        <Input value={step.label} maxLength={80} onChange={(e) => onChange(updateAction(draft, step.stepKey, { label: e.target.value }))} />
      </Field>
      {step.actionKey === "order.set_completion" ? (
        <SetCompletionActionEditor step={step} draft={draft} onChange={onChange} err={err} />
      ) : step.actionKey === "webhook.enqueue_subscription" ? (
        <EnqueueWebhookActionEditor step={step} draft={draft} onChange={onChange} catalogue={catalogue} err={err} />
      ) : step.actionKey === "dashboard.create_alert" ? (
        <DashboardAlertActionEditor step={step} draft={draft} onChange={onChange} catalogue={catalogue} err={err} />
      ) : (
        def?.configFields.map((field) => (
          <ConfigFieldControl key={field.key} field={field} step={step} draft={draft} onChange={onChange} catalogue={catalogue} error={err(field.key)} />
        ))
      )}
    </div>
  );
}

export function AddActionPicker({ draft, onChange, catalogue, afterIndex }: { draft: Draft; onChange: Change; catalogue: Catalogue; afterIndex?: number }) {
  const full = draft.actions.length >= catalogue.limits.maxActionsPerAutomation;
  const mode = draft.trigger?.kind;
  const options = catalogue.actions.map((a) => ({ value: a.key, label: `${a.category}: ${a.label}`, disabled: mode !== undefined && !a.supportedTriggerModes.includes(mode) }));
  return (
    <Field label="Add an action" hint={full ? `At most ${catalogue.limits.maxActionsPerAutomation} actions.` : "Only registered actions can run. Unattended rules never change an order's status or anyone's permissions."}>
      <Select placeholder="Choose an action…" value="" disabled={full} options={options}
        onChange={(e) => { if (e.target.value) onChange(addAction(draft, e.target.value, afterIndex)); }} />
    </Field>
  );
}

export function ActionsEditor({ draft, onChange, catalogue, errors }: { draft: Draft; onChange: Change; catalogue: Catalogue; errors: Errors }) {
  return (
    <div className="flex flex-col gap-4">
      {errors.actions ? <Callout tone="danger">{errors.actions}</Callout> : null}
      <ol className="flex flex-col gap-4">
        {draft.actions.map((step, i) => {
          const def = catalogue.actions.find((a) => a.key === step.actionKey);
          return (
            <li key={step.stepKey} className="rounded-[var(--radius-card)] border border-line p-3 sm:p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-base font-semibold text-ink">{`Step ${i + 1}: ${def?.label ?? step.actionKey}`}</h3>
                <div className="flex gap-1">
                  <IconButton label={`Move step ${i + 1} earlier`} variant="ghost" disabled={i === 0} onClick={() => onChange(moveAction(draft, step.stepKey, -1))} icon={<ArrowUp aria-hidden="true" />} />
                  <IconButton label={`Move step ${i + 1} later`} variant="ghost" disabled={i === draft.actions.length - 1} onClick={() => onChange(moveAction(draft, step.stepKey, 1))} icon={<ArrowDown aria-hidden="true" />} />
                  <IconButton label={`Remove step ${i + 1}`} variant="ghost" onClick={() => onChange(removeAction(draft, step.stepKey))} icon={<Trash2 aria-hidden="true" />} />
                </div>
              </div>
              <ActionForm step={step} index={i} draft={draft} onChange={onChange} catalogue={catalogue} errors={errors} />
            </li>
          );
        })}
      </ol>
      <AddActionPicker draft={draft} onChange={onChange} catalogue={catalogue} />
    </div>
  );
}

/* ------------------------------------------------------------------ review and test */

function describeDraftAction(step: DraftAction, catalogue: Catalogue): string {
  const custom = step.label.trim();
  const base = custom || catalogue.actions.find((d) => d.key === step.actionKey)?.label || step.actionKey;
  if (step.actionKey === "order.set_completion") {
    const delay = typeof step.config.delayMinutes === "number" && step.config.delayMinutes > 0
      ? `after ${formatMinutes(step.config.delayMinutes)}`
      : "immediately";
    if (step.config.kind === "range") {
      return `${base} (${String(step.config.minPercent ?? 0)}%–${String(step.config.maxPercent ?? 100)}%, ${delay})`;
    }
    return `${base} (${String(step.config.percent ?? 0)}%, ${delay})`;
  }
  if (step.actionKey === "webhook.enqueue_subscription" && typeof step.config.targetKey === "string" && step.config.targetKey) {
    return `${base} (${step.config.targetKey})`;
  }
  if (step.actionKey === "dashboard.create_alert" && typeof step.config.severity === "string") {
    return `${base} (${step.config.severity})`;
  }
  return base;
}

export function DraftSummary({ draft, catalogue }: { draft: Draft; catalogue: Catalogue }) {
  const fields = conditionFields(draft.trigger, catalogue);
  return (
    <div className="flex flex-col gap-4">
      <KeyValueList columns={1} items={[
        { label: "Name", value: draft.name || "—" },
        { label: "Starts", value: triggerLabel(draft.trigger, catalogue) },
        { label: "Runs per hour (limit)", value: draft.maxRunsPerHour || `Default (${catalogue.limits.defaultPerAutomationRunsPerHour})` },
      ]} />
      <div>
        <h3 className="mb-1 text-base font-semibold text-ink">Conditions</h3>
        {draft.groups.length === 0 ? <p className="text-sm text-muted">None — runs for all occurrences.</p> : (
          <ul className="list-disc pl-5 text-sm text-ink">
            {draft.groups.map((g, gi) => (
              <li key={g.id}>
                {`Group ${gi + 1} (${g.match === "all" ? "all" : "any"}): `}
                {g.conditions.map((c) => `${fields.find((f) => f.key === c.field)?.label ?? c.field} ${c.operator ? OPERATOR_LABELS[c.operator] : "?"}${operatorNeedsValue(c.operator) ? ` ${c.value}` : ""}`).join("; ")}
              </li>
            ))}
            {draft.groups.length > 1 ? <li>{draft.match === "all" ? "All groups must match." : "Any group may match."}</li> : null}
          </ul>
        )}
      </div>
      <div>
        <h3 className="mb-1 text-base font-semibold text-ink">Actions, in order</h3>
        {draft.actions.length === 0 ? <p className="text-sm text-muted">None yet.</p> : (
          <ol className="list-decimal pl-5 text-sm text-ink">
            {draft.actions.map((a) => <li key={a.stepKey}>{describeDraftAction(a, catalogue)}</li>)}
          </ol>
        )}
      </div>
    </div>
  );
}

export function TestRunResultView({ result }: { result: AutomationTestRunResult }) {
  return (
    <div className="flex flex-col gap-3" role="status">
      <Callout tone={result.conditionsMatched ? "success" : "info"} title={result.conditionsMatched ? "Conditions matched" : "Conditions did not match"}>
        {result.dryRun ? "Test only: nothing was sent." : result.liveRunPublicId ? "A live run was started; see run history." : "No live run was started."}
      </Callout>
      {result.groupResults.length > 0 ? (
        <ul className="text-sm text-ink">
          {result.groupResults.map((g) => (
            <li key={g.groupIndex}>
              {`Group ${g.groupIndex + 1}: ${g.matched ? "matched" : "not matched"}`}
              <ul className="pl-5 text-muted">
                {g.leafResults.map((leaf, i) => <li key={i}>{`${leaf.field} ${OPERATOR_LABELS[leaf.operator]}: ${leaf.matched ? "yes" : "no"} (value ${leaf.actualValue === undefined ? "missing" : String(leaf.actualValue)})`}</li>)}
              </ul>
            </li>
          ))}
        </ul>
      ) : null}
      <ol className="list-decimal pl-5 text-sm text-ink">
        {result.plannedSteps.map((s) => <li key={s.stepKey}>{`${s.wouldRun ? "Would run" : "Would not run"}: ${s.previewSummary}`}</li>)}
      </ol>
    </div>
  );
}

export function RunSteps({ run }: { run: AutomationRunView }) {
  return (
    <ol className="flex flex-col gap-2">
      {run.steps.map((s) => {
        const meta = STEP_STATE[s.state] ?? { label: s.state, tone: "neutral" as const };
        return (
          <li key={s.stepIndex} className="flex flex-col gap-1 rounded-[var(--radius-card)] border border-line p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
            <span className="min-w-0 font-medium text-ink">{`${s.stepIndex + 1}. ${s.safeSummary ?? s.actionKey}`}</span>
            <span className="flex flex-wrap items-center gap-2 text-muted">
              <Badge tone={meta.tone}>{meta.label}</Badge>
              <span>{`${s.attemptCount} attempt${s.attemptCount === 1 ? "" : "s"}`}</span>
              <span>{formatDuration(s.durationMs)}</span>
              {s.reasonCode ? <code className="text-xs">{s.reasonCode}</code> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
