/**
 * The one shared phase form (increment 07 package A). Used by both designer views: the visual phase canvas
 * (one form per card) and the guided designer (one form per step). Controlled: renders `stage`, reports
 * every change with `onChange(next)`. Three regions are owned by other features and rendered through slots.
 */
import { ArrowRightLeft, Bell, ClipboardCheck, Download, FileAudio, FileText, Info, ListChecks, MessageSquareText, Mic, Upload, Users, type LucideIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import {
  MAX_STAGE_STATUSES,
  STAGE_ACK_MESSAGE_MAX,
  STAGE_MARKDOWN_MAX,
  STAGE_WEIGHT_MAX,
  type StageActionKey,
  type StageAdminTask,
  type StageGovernance,
  type WorkflowStage,
} from "@shared/workflowStages";
import { SafePolicyText } from "@/lib/agreementGate/SafePolicyText";
import { Badge } from "../Badge";
import { Callout } from "../Feedback";
import { Checkbox, Field, Input, Select, Textarea } from "../Field";
import { cn } from "../cn";
import { MB, bytesToMb, configuredActionCount, fieldError, parseLimit, subErrors, type PhaseStatusOption } from "./model";
import type { PhaseActionsSlotValue, PhaseSlotContext, PhaseSlotProps } from "./slotTypes";

export type PhaseSlotName = "actions" | "webhook" | "fileSync";

/** How the host renders feature-owned regions (normally `PHASE_FORM_SLOTS` from `@/app/slots`). */
export interface PhaseSlotRenderer {
  has: (name: PhaseSlotName) => boolean;
  render: (name: PhaseSlotName, props: PhaseSlotProps<unknown>) => ReactNode;
}

export interface PhaseFormProps {
  stage: WorkflowStage;
  index: number;
  onChange: (next: WorkflowStage) => void;
  statusOptions: readonly PhaseStatusOption[];
  /** status key → customer label of the other phase that already uses it. */
  takenStatuses: ReadonlyMap<string, string>;
  workflowStatusKeys: readonly string[];
  /** Errors for this phase, relative paths ("customerLabel", "statusKeys.0", "" = the phase). */
  errors: Readonly<Record<string, string>>;
  disabled?: boolean;
  /** Level of this form's section headings; slots get the next level. */
  headingLevel?: 3 | 4 | 5;
  /** Shown under the key when it renames a key that exists in the published version. */
  keyWarning?: string;
  slots?: PhaseSlotRenderer;
  /** Unique per form instance (canvas card id). */
  idPrefix: string;
}

const CUSTOMER_ACTIONS: { key: StageActionKey; label: string; description: string; icon: LucideIcon }[] = [
  { key: "uploadDocuments", label: "Upload documents", description: "Customer may upload supporting files.", icon: FileText },
  { key: "answerQuestions", label: "Answer questions", description: "Customer sees questions assigned to this phase.", icon: MessageSquareText },
  { key: "recordAudio", label: "Record audio", description: "Customer may record audio in the browser.", icon: Mic },
  { key: "uploadAudio", label: "Upload audio file", description: "Customer and staff may attach prerecorded audio.", icon: FileAudio },
  { key: "teamFileReview", label: "Customer file review", description: "Customer can review and download files the team shares in this phase.", icon: Download },
];

const ADMIN_TASKS: { key: StageAdminTask; label: string; description: string; icon: LucideIcon }[] = [
  { key: "upload_team_document", label: "Upload team document", description: "Team uploads a document to the customer's order workspace.", icon: Upload },
  { key: "assign_questions", label: "Assign order questions", description: "Team sends or applies questions for this phase.", icon: Users },
  { key: "review_submission", label: "Review customer submission", description: "Team reviews the submitted files, audio and answers.", icon: ClipboardCheck },
  { key: "run_automation", label: "Run phase actions", description: "Team runs the approved email, status, alert or webhook actions.", icon: ListChecks },
];

type Governed = keyof StageGovernance;
const LIMITS: { key: Governed; label: string; unit: "count" | "mb" | "seconds"; placeholder: string }[] = [
  { key: "documentCount", label: "Document count", unit: "count", placeholder: "Platform limit" },
  { key: "documentMaxBytes", label: "Document MB each", unit: "mb", placeholder: "Platform limit" },
  { key: "audioCount", label: "Audio count", unit: "count", placeholder: "Platform limit" },
  { key: "audioMaxBytes", label: "Audio MB each", unit: "mb", placeholder: "Platform limit" },
  { key: "recordingMaxSeconds", label: "Recording seconds each", unit: "seconds", placeholder: "Platform limit" },
  { key: "totalAudioMaxSeconds", label: "Total audio seconds", unit: "seconds", placeholder: "Platform limit" },
];

function Region({ title, description, headingLevel, tone = "plain", aside, children, id }: {
  title: string; description?: ReactNode; headingLevel: 3 | 4 | 5; tone?: "plain" | "accent"; aside?: ReactNode; children: ReactNode; id: string;
}) {
  const H = `h${headingLevel}` as const;
  return (
    <div role="group" aria-labelledby={id} className={cn(
      "grid min-w-0 gap-3 rounded-[var(--radius-card)] border p-4 rp-forced-border",
      tone === "accent" ? "border-action/40 bg-action-soft/40" : "border-line bg-surface-soft",
    )}>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <H id={id} className="text-sm font-semibold text-ink">{title}</H>
          {description ? <p className="text-sm break-words text-muted">{description}</p> : null}
        </div>
        {aside}
      </div>
      {children}
    </div>
  );
}

function ChoiceCard({ id, icon: Icon, label, description, checked, onChange, disabled }: {
  id: string; icon: LucideIcon; label: string; description: string; checked: boolean; onChange: (checked: boolean) => void; disabled: boolean;
}) {
  return (
    <div className={cn(
      "min-w-0 rounded-[var(--radius-control)] border p-3 transition-colors rp-forced-border",
      checked ? "border-action bg-action-soft" : "border-line bg-surface",
    )} data-checked={checked || undefined}>
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        label={<span className="inline-flex items-center gap-1.5"><Icon aria-hidden="true" className="size-4 shrink-0 text-action" />{label}</span>}
        description={description}
      />
    </div>
  );
}

/** Whole-number limit; blank = platform limit. Keeps the typed text while it is not a valid number. */
function LimitField({ id, label, unit, placeholder, value, onChange, disabled, error }: {
  id: string; label: string; unit: "count" | "mb" | "seconds"; placeholder: string; value: number | null | undefined;
  onChange: (next: number | null) => void; disabled: boolean; error?: string;
}) {
  const shown = unit === "mb" ? bytesToMb(value) : value === null || value === undefined ? "" : String(value);
  const [draft, setDraft] = useState<string | null>(null);
  const invalid = draft !== null && parseLimit(draft) === undefined;
  return (
    <Field id={id} label={label} error={invalid ? "Use a whole number, or leave blank for the platform limit." : error}>
      <Input
        inputMode="numeric"
        autoComplete="off"
        placeholder={placeholder}
        value={draft ?? shown}
        disabled={disabled}
        onChange={(event) => {
          const text = event.currentTarget.value;
          const parsed = parseLimit(text);
          if (parsed === undefined) { setDraft(text); return; }
          setDraft(null);
          onChange(parsed === null ? null : unit === "mb" ? parsed * MB : parsed);
        }}
        onBlur={() => { if (draft !== null && parseLimit(draft) !== undefined) setDraft(null); }}
      />
    </Field>
  );
}

export function PhaseForm({ stage, index, onChange, statusOptions, takenStatuses, workflowStatusKeys, errors, disabled = false, headingLevel = 4, keyWarning, slots, idPrefix }: PhaseFormProps) {
  const uid = useId().replace(/:/g, "");
  const id = (part: string) => `${idPrefix}-${part}-${uid}`;
  const set = <K extends keyof WorkflowStage>(field: K, value: WorkflowStage[K]) => onChange({ ...stage, [field]: value });
  const slotLevel = Math.min(5, headingLevel + 1) as 4 | 5;
  const [preview, setPreview] = useState(false);

  const context: PhaseSlotContext = {
    stageKey: stage.key,
    stageIndex: index,
    stageStatusKeys: stage.statusKeys,
    workflowStatusKeys,
    idPrefix: `${idPrefix}-slot`,
    disabled,
    headingLevel: slotLevel,
    errors: {},
  };
  const slot = (name: PhaseSlotName, value: unknown, onSlotChange: (next: unknown) => void, slotErrors: Record<string, string>, missing: string) =>
    slots?.has(name)
      ? slots.render(name, { ...context, idPrefix: `${idPrefix}-${name}`, errors: slotErrors, value, onChange: onSlotChange })
      : <p className="text-sm text-muted">{missing}</p>;

  const actions = stage.stageActions ?? {};
  const { webhookTargetKey, ...actionsWithoutWebhook } = actions;
  const actionErrors = subErrors(errors, "stageActions");
  const { webhookTargetKey: _ignored, ...actionsSlotErrors } = actionErrors;
  void _ignored;
  const setStageActions = (next: Record<string, unknown>) => {
    const cleaned = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined && v !== null && v !== ""));
    const copy: WorkflowStage = { ...stage };
    if (Object.keys(cleaned).length) copy.stageActions = cleaned as WorkflowStage["stageActions"];
    else delete copy.stageActions;
    onChange(copy);
  };

  const ackPolicy = stage.acknowledgement.policy;
  const statusError = fieldError(errors, "statusKeys");

  return (
    <div className="grid min-w-0 gap-4">
      {errors[""] ? <Callout tone="danger" title="This phase needs attention">{errors[""]}</Callout> : null}

      <div className="grid min-w-0 gap-4 @2xl:grid-cols-2">
        <Field id={id("customer-label")} label="Customer-facing phase label" required hint="Customers see this in the progress bar and phase steps." error={errors.customerLabel}>
          <Input value={stage.customerLabel} maxLength={60} disabled={disabled} onChange={(event) => set("customerLabel", event.currentTarget.value)} />
        </Field>
        <Field id={id("staff-label")} label="Staff label" required hint="Shown in the console." error={errors.staffLabel}>
          <Input value={stage.staffLabel} maxLength={60} disabled={disabled} onChange={(event) => set("staffLabel", event.currentTarget.value)} />
        </Field>
        <Field id={id("key")} label="Stable phase key" required hint="Lowercase letters, digits and underscores. Keep the key once customers have files or questions in this phase." error={errors.key ?? keyWarning}>
          <Input value={stage.key} maxLength={48} spellCheck={false} autoCapitalize="off" autoComplete="off" className="font-mono" disabled={disabled}
            onChange={(event) => set("key", event.currentTarget.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))} />
        </Field>
        <div className="grid min-w-0 gap-4 @md:grid-cols-2">
          <Field id={id("weight")} label="Progress weight" hint={`1–${STAGE_WEIGHT_MAX}. Heavier phases move the bar further.`} error={errors.weight}>
            <Input inputMode="numeric" value={String(stage.weight)} disabled={disabled}
              onChange={(event) => {
                const n = Number(event.currentTarget.value.replace(/\D/g, "").slice(0, 3));
                set("weight", Math.min(STAGE_WEIGHT_MAX, Math.max(1, Number.isFinite(n) && n > 0 ? n : 1)));
              }} />
          </Field>
          <Field id={id("completes")} label="Phase completes" error={errors.completesOn}>
            <Select value={stage.completesOn} disabled={disabled} onChange={(event) => set("completesOn", event.currentTarget.value as WorkflowStage["completesOn"])}
              options={[{ value: "manual", label: "When the team moves it on" }, { value: "payment", label: "When payment is confirmed" }]} />
          </Field>
        </div>
      </div>

      <fieldset className="grid min-w-0 gap-2" aria-describedby={statusError ? id("status-error") : id("status-hint")}>
        <legend className="text-sm font-medium text-ink">Statuses in this phase <span className="text-danger" aria-hidden="true">*</span><span className="sr-only"> (required)</span></legend>
        <p id={id("status-hint")} className="text-sm text-muted">Choose at least one, up to {MAX_STAGE_STATUSES}. A status belongs to one phase only.</p>
        <div className="grid min-w-0 gap-x-4 gap-y-1 @md:grid-cols-2 @3xl:grid-cols-3">
          {statusOptions.filter((option) => !option.retired || stage.statusKeys.includes(option.key)).map((option) => {
            const takenBy = takenStatuses.get(option.key);
            const checked = stage.statusKeys.includes(option.key);
            return (
              <Checkbox
                key={option.key}
                id={id(`status-${option.key}`)}
                checked={checked}
                disabled={disabled || (!checked && (Boolean(takenBy) || stage.statusKeys.length >= MAX_STAGE_STATUSES))}
                label={option.label}
                description={takenBy ? `In ${takenBy}` : option.retired ? "Retired" : undefined}
                onCheckedChange={(on) => set("statusKeys", on
                  ? workflowStatusKeys.length
                    ? [...stage.statusKeys, option.key].sort((a, b) => order(a) - order(b))
                    : [...stage.statusKeys, option.key]
                  : stage.statusKeys.filter((key) => key !== option.key))}
              />
            );
          })}
        </div>
        {statusOptions.length === 0 ? <p className="text-sm text-muted">No statuses in the catalogue yet. Add them under Statuses.</p> : null}
        {statusError ? <p id={id("status-error")} className="text-sm font-medium text-danger">{statusError}</p> : null}
      </fieldset>

      <fieldset className="grid min-w-0 gap-2">
        <legend className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Customer actions enabled in this phase</legend>
        <div className="grid min-w-0 gap-2 @lg:grid-cols-2 @4xl:grid-cols-3">
          {CUSTOMER_ACTIONS.map((action) => (
            <ChoiceCard key={action.key} id={id(`action-${action.key}`)} icon={action.icon} label={action.label} description={action.description}
              checked={stage.actions[action.key]} disabled={disabled}
              onChange={(on) => set("actions", { ...stage.actions, [action.key]: on })} />
          ))}
        </div>
      </fieldset>

      <Region id={id("gov")} headingLevel={headingLevel} title="Upload governance" description="Optional limits for every customer and staff upload in this phase. Leave a field blank to use the platform limit; the tightest limit applies.">
        <div className="grid min-w-0 gap-3 @lg:grid-cols-2 @3xl:grid-cols-3">
          {LIMITS.map((limit) => (
            <LimitField key={limit.key} id={id(`gov-${limit.key}`)} label={limit.label} unit={limit.unit} placeholder={limit.placeholder} disabled={disabled}
              value={stage.governance?.[limit.key]} error={errors[`governance.${limit.key}`]}
              onChange={(next) => {
                const governance = { ...(stage.governance ?? {}), [limit.key]: next };
                const copy: WorkflowStage = { ...stage, governance };
                if (Object.values(governance).every((value) => value === null || value === undefined)) delete copy.governance;
                onChange(copy);
              }} />
          ))}
        </div>
      </Region>

      <Region id={id("sync")} headingLevel={headingLevel} title="Folders and Microsoft 365 file sync" description="Where this phase's documents and audio go inside the managed customer and order folder, and which approved destinations receive copies. The portal stays authoritative.">
        {slot("fileSync", { folders: stage.folders, fileSync: stage.fileSync },
          (next) => {
            const value = next as Pick<WorkflowStage, "folders" | "fileSync">;
            onChange({ ...stage, folders: value.folders ?? stage.folders, fileSync: value.fileSync ?? stage.fileSync });
          },
          { ...prefixed(subErrors(errors, "folders"), "folders"), ...prefixed(subErrors(errors, "fileSync"), "fileSync") },
          "Folder and file sync settings are not available in this portal yet. Uploads use the phase's default folders.")}
      </Region>

      <Region id={id("ack")} headingLevel={headingLevel} title="Customer submission acknowledgement" description="Whether a customer must acknowledge before submitting this phase, may acknowledge, or submits without a prompt.">
        <div className="grid min-w-0 gap-3">
          <Field id={id("ack-policy")} label="Acknowledgement policy" error={errors["acknowledgement.policy"]}>
            <Select value={ackPolicy} disabled={disabled}
              onChange={(event) => set("acknowledgement", { ...stage.acknowledgement, policy: event.currentTarget.value as WorkflowStage["acknowledgement"]["policy"] })}
              options={[{ value: "required", label: "Required acknowledgement" }, { value: "optional", label: "Optional acknowledgement" }, { value: "none", label: "No acknowledgement" }]} />
          </Field>
          {ackPolicy !== "none" ? (
            <Field id={id("ack-message")} label="Acknowledgement message" hint={`Optional, plain text, up to ${STAGE_ACK_MESSAGE_MAX} characters. When blank, the portal uses its standard lock warning.`} error={errors["acknowledgement.message"]}>
              <Textarea rows={3} maxLength={STAGE_ACK_MESSAGE_MAX} value={stage.acknowledgement.message ?? ""} disabled={disabled}
                onChange={(event) => {
                  const message = event.currentTarget.value;
                  set("acknowledgement", message ? { ...stage.acknowledgement, message } : { policy: stage.acknowledgement.policy });
                }} />
            </Field>
          ) : null}
        </div>
      </Region>

      <Region id={id("content")} headingLevel={headingLevel} tone="accent" title="Customer instructions and progression" description="Optionally show one message in this phase, then choose whether the customer continues with Next or with Submit and lock.">
        <div className="grid min-w-0 gap-3 @2xl:grid-cols-2">
          <Field id={id("content-mode")} label="Customer content">
            <Select value={stage.content ? "message" : "none"} disabled={disabled}
              onChange={(event) => {
                const copy: WorkflowStage = { ...stage };
                if (event.currentTarget.value === "message") copy.content = { markdown: stage.content?.markdown ?? "" };
                else delete copy.content;
                onChange(copy);
              }}
              options={[{ value: "none", label: "No phase message" }, { value: "message", label: "Show a message" }]} />
          </Field>
          <Field id={id("progression")} label="Customer progression" error={errors.progression}>
            <Select value={stage.progression} disabled={disabled} onChange={(event) => set("progression", event.currentTarget.value as WorkflowStage["progression"])}
              options={[{ value: "next", label: "Next (nothing locks)" }, { value: "submit_lock", label: "Submit and lock before the next phase" }]} />
          </Field>
        </div>
        {stage.content ? (
          <div className="grid min-w-0 gap-2">
            <Field id={id("markdown")} label="Message for the customer" required hint={`Markdown: headings, lists, bold, emphasis and https links. No HTML. Up to ${STAGE_MARKDOWN_MAX} characters.`} error={fieldError(errors, "content")}>
              <Textarea rows={5} maxLength={STAGE_MARKDOWN_MAX} value={stage.content.markdown} disabled={disabled}
                onChange={(event) => set("content", { markdown: event.currentTarget.value })} />
            </Field>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted" aria-live="polite">{stage.content.markdown.length} of {STAGE_MARKDOWN_MAX} characters</p>
              <button type="button" className="min-h-11 rounded-[var(--radius-control)] px-2 text-sm font-semibold text-action underline underline-offset-2" aria-expanded={preview} aria-controls={id("preview")} onClick={() => setPreview((v) => !v)}>
                {preview ? "Hide preview" : "Preview as the customer sees it"}
              </button>
            </div>
            {preview ? (
              <div id={id("preview")} className="min-w-0 rounded-[var(--radius-control)] border border-line bg-surface p-3 text-sm break-words">
                {stage.content.markdown.trim() ? <SafePolicyText bodyText={stage.content.markdown} format="safe_markdown" /> : <p className="text-muted">Nothing to preview yet.</p>}
              </div>
            ) : null}
          </div>
        ) : null}
        {stage.progression === "submit_lock" ? (
          <p className="flex items-start gap-2 rounded-[var(--radius-control)] border border-line bg-surface p-3 text-sm text-body">
            <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-info" />
            <span>Submit and lock uses the acknowledgement policy above and locks the phase. Only an administrator can reopen it.</span>
          </p>
        ) : null}
      </Region>

      <fieldset className="grid min-w-0 gap-2">
        <legend className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Administrator tasks in this phase</legend>
        <div className="grid min-w-0 gap-2 @lg:grid-cols-2 @4xl:grid-cols-4">
          {ADMIN_TASKS.map((task) => (
            <ChoiceCard key={task.key} id={id(`task-${task.key}`)} icon={task.icon} label={task.label} description={task.description}
              checked={stage.adminTasks.includes(task.key)} disabled={disabled}
              onChange={(on) => set("adminTasks", on ? STAGE_ADMIN_TASK_ORDER.filter((key) => key === task.key || stage.adminTasks.includes(key)) : stage.adminTasks.filter((key) => key !== task.key))} />
          ))}
        </div>
        {fieldError(errors, "adminTasks") ? <p className="text-sm font-medium text-danger">{fieldError(errors, "adminTasks")}</p> : null}
      </fieldset>

      <Region id={id("run")} headingLevel={headingLevel} title="Administrator-run phase actions"
        description="These run only when an administrator runs this phase on an order, after a preview. Empty means nothing runs."
        aside={<Badge tone={configuredActionCount(stage.stageActions) ? "info" : "neutral"}><ArrowRightLeft aria-hidden="true" className="mr-1 inline size-3.5" />{configuredActionCount(stage.stageActions)} configured</Badge>}>
        <div className="grid min-w-0 gap-3">
          {slot("actions", actionsWithoutWebhook as PhaseActionsSlotValue,
            (next) => setStageActions({ ...(next as Record<string, unknown>), webhookTargetKey }),
            actionsSlotErrors,
            "Email, status, completion and alert actions are not available in this portal yet.")}
          {slot("webhook", webhookTargetKey ?? null,
            (next) => setStageActions({ ...actionsWithoutWebhook, webhookTargetKey: (next as string | null) ?? undefined }),
            actionErrors.webhookTargetKey ? { "": actionErrors.webhookTargetKey } : {},
            "Webhook targets are not available in this portal yet.")}
        </div>
        {!slots?.has("actions") && !slots?.has("webhook") ? <p className="flex items-center gap-1.5 text-xs text-muted"><Bell aria-hidden="true" className="size-3.5" />Nothing will run for this phase.</p> : null}
      </Region>
    </div>
  );

  function order(key: string): number {
    const position = workflowStatusKeys.indexOf(key);
    return position < 0 ? Number.MAX_SAFE_INTEGER : position;
  }
}

const STAGE_ADMIN_TASK_ORDER: readonly StageAdminTask[] = ADMIN_TASKS.map((task) => task.key);

function prefixed(errors: Record<string, string>, prefix: string): Record<string, string> {
  return Object.fromEntries(Object.entries(errors).map(([path, message]) => [path ? `${prefix}.${path}` : prefix, message]));
}
