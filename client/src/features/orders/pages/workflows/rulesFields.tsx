/**
 * Workflow designer — increment 04 fields: phases (whole workflow) and per-status requirements
 * (upload slots and acknowledgements). Shared by the wizard "Phases and requirements" step and the canvas
 * side panel. The server validates everything; these fields only edit the draft and show its issues.
 */
import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { DEFAULT_ORDER_FILE_FOLDER_TEMPLATE, ORDER_FILE_FOLDER_TOKENS } from "@shared/orderFileFolder";
import { useTRPC } from "@/lib/trpc";
import { Button, Checkbox, Field, Input, Select, Textarea } from "@/ui";
import {
  ACK_SIDE_OPTIONS, ACTORS, addPhase, fieldError, folderExample, gatePointFrom, gatePointValue, MAX_GATES, newAcknowledgement, newGate, newUpload, parseTypes, removeGate, removePhase,
  SIGNATURE_MODE_OPTIONS, toggleActor, updateGate, updatePhase, UPLOAD_KIND_OPTIONS, withRequirements,
  type DraftAcknowledgement, type DraftDefinition, type DraftGate, type DraftState, type DraftUpload, type WorkflowIssue,
} from "./model";

const TOKEN_LIST = ORDER_FILE_FOLDER_TOKENS.map((token) => `{${token}}`).join(", ");
const FOLDER_HINT = `Folder path inside the storage location, with / between folders. You can use ${TOKEN_LIST}.`;

/** Live example of where files land (synthetic values). Announced politely as the template changes. */
function FolderExample({ templates, phase, slot }: { templates: (string | undefined)[]; phase?: string; slot?: string }) {
  const example = folderExample(templates, { ...(phase ? { phase } : {}), ...(slot ? { slot } : {}) });
  return (
    <p className="text-sm text-muted" aria-live="polite">
      {example ? (
        <>
          Example: <span className="font-mono break-all text-body">{example}</span>
        </>
      ) : (
        "No example yet: the folder path is not valid."
      )}
    </p>
  );
}

/** Part B (B7): the workflow's default storage folder (slot folders override it). */
export function StorageFolderEditor({ definition, issues, onChange }: { definition: DraftDefinition; issues: readonly WorkflowIssue[]; onChange: (definition: DraftDefinition) => void }) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-3 rounded-[var(--radius-card)] border border-line p-4">
      <legend className="px-1 text-sm font-semibold text-ink">Storage folder</legend>
      <Field label="Default storage folder (optional)" hint={`${FOLDER_HINT} Empty uses ${DEFAULT_ORDER_FILE_FOLDER_TEMPLATE}.`} error={fieldError(issues, "storageFolder")}>
        <Input
          value={definition.storageFolder ?? ""}
          maxLength={400}
          spellCheck={false}
          autoCapitalize="none"
          className="font-mono"
          placeholder={DEFAULT_ORDER_FILE_FOLDER_TEMPLATE}
          onChange={(event) => onChange({ ...definition, storageFolder: event.target.value || undefined })}
        />
      </Field>
      <FolderExample templates={[definition.storageFolder]} />
    </fieldset>
  );
}

/**
 * Part B (B6): acceptance gates. A gate asks the customer to accept a published policy before working on the
 * order (order start) or before submitting from one status. The server enforces it; this only edits the draft.
 */
export function AcceptanceGatesEditor({ definition, issues, onChange }: { definition: DraftDefinition; issues: readonly WorkflowIssue[]; onChange: (definition: DraftDefinition) => void }) {
  const trpc = useTRPC();
  // Public read of currently published customer-audience policies: no policies.manage or step-up needed to design.
  const policies = useQuery(trpc.compliance.policies.listPublished.queryOptions());
  const gates = definition.acceptanceGates ?? [];
  const published = [...new Map((policies.data ?? []).map((doc) => [doc.documentPublicId, doc.title] as const))];
  const policyOptions = (gate: DraftGate) => {
    const options = published.map(([value, label]) => ({ value, label }));
    if (gate.policyPublicId && !options.some((option) => option.value === gate.policyPublicId))
      options.unshift({ value: gate.policyPublicId, label: "Policy not available (unpublished or removed)" });
    return options;
  };
  const pointOptions = [
    { value: "order_start", label: "Before any work on the order" },
    ...definition.states
      .filter((state) => state.kind !== "terminal" && state.key)
      .map((state) => ({ value: `step:${state.key}`, label: `Before submitting from “${state.label.trim() || state.key}”` })),
  ];
  return (
    <fieldset className="flex min-w-0 flex-col gap-3 rounded-[var(--radius-card)] border border-line p-4">
      <legend className="px-1 text-sm font-semibold text-ink">Acceptance gates</legend>
      <p className="text-sm text-body">
        Optional. Ask the customer to accept a published policy before they can upload, record, answer intake questions or submit. Staff are never blocked, and cancelling is always possible.
        Publishing gates needs workflow rules to be turned on in settings.
      </p>
      {policies.isError ? (
        <p className="text-sm text-danger" role="alert">
          The policy list could not be loaded. You can still edit the other fields.
        </p>
      ) : null}
      {gates.length === 0 ? <p className="text-sm text-muted">No gates.</p> : null}
      <ol className="flex flex-col gap-4">
        {gates.map((gate, index) => {
          const path = `acceptanceGates.${index}`;
          const name = `Gate ${index + 1}`;
          return (
            <li key={index} className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-line p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={`${name} policy`} required error={fieldError(issues, `${path}.policyPublicId`)}>
                  <Select
                    value={gate.policyPublicId}
                    placeholder={policies.isPending ? "Loading policies…" : "Choose a policy"}
                    options={policyOptions(gate)}
                    onChange={(event) => onChange(updateGate(definition, index, { policyPublicId: event.target.value }))}
                  />
                </Field>
                <Field label={`${name} applies`} required error={fieldError(issues, `${path}.point`)}>
                  <Select value={gatePointValue(gate.point)} options={pointOptions} onChange={(event) => onChange(updateGate(definition, index, { point: gatePointFrom(event.target.value) }))} />
                </Field>
                <Field label={`${name} signature`}>
                  <Select
                    value={gate.signatureMode}
                    options={SIGNATURE_MODE_OPTIONS}
                    onChange={(event) => onChange(updateGate(definition, index, { signatureMode: event.target.value as DraftGate["signatureMode"] }))}
                  />
                </Field>
                <Field label={`${name} key`} required hint="Lowercase letters, digits and underscores." error={fieldError(issues, `${path}.key`)}>
                  <Input value={gate.key} maxLength={48} spellCheck={false} autoCapitalize="none" className="font-mono" onChange={(event) => onChange(updateGate(definition, index, { key: event.target.value }))} />
                </Field>
              </div>
              <Checkbox
                label="Ask again when the policy has a new version"
                checked={gate.askAgainOnNewVersion}
                onCheckedChange={(on) => onChange(updateGate(definition, index, { askAgainOnNewVersion: on === true }))}
              />
              <div>
                <Button size="sm" variant="ghost" aria-label={`Remove gate ${index + 1}`} onClick={() => onChange(removeGate(definition, index))}>
                  <Trash2 aria-hidden="true" className="size-4" />
                  Remove
                </Button>
              </div>
            </li>
          );
        })}
      </ol>
      <div>
        <Button variant="secondary" size="sm" disabled={gates.length >= MAX_GATES} onClick={() => onChange({ ...definition, acceptanceGates: [...gates, newGate(definition)] })}>
          <Plus aria-hidden="true" className="size-4" />
          Add acceptance gate
        </Button>
      </div>
    </fieldset>
  );
}

const MAX_PHASES = 12;
const MAX_UPLOADS = 10;
const MAX_ACKS = 5;

export function PhasesEditor({ definition, issues, onChange }: { definition: DraftDefinition; issues: readonly WorkflowIssue[]; onChange: (definition: DraftDefinition) => void }) {
  const phases = definition.phases ?? [];
  return (
    <fieldset className="flex min-w-0 flex-col gap-3 rounded-[var(--radius-card)] border border-line p-4">
      <legend className="px-1 text-sm font-semibold text-ink">Phases</legend>
      <p className="text-sm text-body">
        Optional. Group statuses into phases (for example Intake, Review, Delivery). Customers see the phases as a progress bar. When an order leaves a phase, that phase locks so its uploads and
        acceptances stay as reviewed; staff can unlock it with a reason.
      </p>
      {phases.length === 0 ? <p className="text-sm text-muted">No phases. Orders show statuses only.</p> : null}
      <ol className="flex flex-col gap-3">
        {phases.map((phase, index) => (
          <li key={index} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Field label={`Phase ${index + 1} name`} required error={fieldError(issues, `phases.${index}.label`)}>
              <Input value={phase.label} maxLength={60} onChange={(event) => onChange(updatePhase(definition, index, { label: event.target.value }))} />
            </Field>
            <Field label={`Phase ${index + 1} key`} required error={fieldError(issues, `phases.${index}.key`)}>
              <Input value={phase.key} maxLength={48} spellCheck={false} autoCapitalize="none" className="font-mono" onChange={(event) => onChange(updatePhase(definition, index, { key: event.target.value }))} />
            </Field>
            <Button size="sm" variant="ghost" aria-label={`Remove phase ${phase.label || index + 1}`} onClick={() => onChange(removePhase(definition, index))}>
              <Trash2 aria-hidden="true" className="size-4" />
              Remove
            </Button>
          </li>
        ))}
      </ol>
      <div>
        <Button variant="secondary" size="sm" disabled={phases.length >= MAX_PHASES} onClick={() => onChange(addPhase(definition))}>
          <Plus aria-hidden="true" className="size-4" />
          Add phase
        </Button>
      </div>
    </fieldset>
  );
}

/** Phase choice plus requirements for one status. `onChange` receives a state patch. */
export function StateRulesFields({ definition, state, index, issues, onChange }: { definition: DraftDefinition; state: DraftState; index: number; issues: readonly WorkflowIssue[]; onChange: (patch: Partial<DraftState>) => void }) {
  const phases = definition.phases ?? [];
  const uploads = state.requirements?.uploads ?? [];
  const acks = state.requirements?.acknowledgements ?? [];
  const name = state.label.trim() || `status ${index + 1}`;
  const base = `states.${index}`;
  const setUpload = (i: number, patch: Partial<DraftUpload>) =>
    onChange(withRequirements(state, (current) => ({ ...current, uploads: current.uploads.map((upload, j) => (j === i ? { ...upload, ...patch } : upload)) })));
  const setAck = (i: number, patch: Partial<DraftAcknowledgement>) =>
    onChange(withRequirements(state, (current) => ({ ...current, acknowledgements: current.acknowledgements.map((ack, j) => (j === i ? { ...ack, ...patch } : ack)) })));
  const count = (value: string) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(20, parsed)) : 0;
  };
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {phases.length > 0 ? (
        <Field label={`Phase of ${name}`} error={fieldError(issues, `${base}.phase`)}>
          <Select
            value={state.phase ?? ""}
            placeholder="No phase"
            options={[...phases.filter((phase) => phase.key.trim()).map((phase) => ({ value: phase.key, label: phase.label || phase.key })), ...(state.phase && !phases.some((phase) => phase.key === state.phase) ? [{ value: state.phase, label: `${state.phase} (not a phase)` }] : [])]}
            onChange={(event) => onChange({ phase: event.target.value || undefined })}
          />
        </Field>
      ) : null}

      <fieldset className="flex min-w-0 flex-col gap-3">
        <legend className="mb-1 text-sm font-semibold text-ink">Uploads needed before leaving {name}</legend>
        {uploads.length === 0 ? <p className="text-sm text-muted">None.</p> : null}
        {uploads.map((upload, i) => {
          const at = (field: string) => fieldError(issues, `${base}.requirements.uploads.${i}.${field}`);
          const slot = upload.label.trim() || `upload ${i + 1}`;
          return (
            <div key={i} className="flex min-w-0 flex-col gap-3 rounded-[var(--radius-control)] border border-line p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Upload name" required hint="Shown to the customer, for example “Signed contract”." error={at("label")}>
                  <Input value={upload.label} maxLength={60} onChange={(event) => setUpload(i, { label: event.target.value })} />
                </Field>
                <Field label="Key" required error={at("key")}>
                  <Input value={upload.key} maxLength={48} spellCheck={false} autoCapitalize="none" className="font-mono" onChange={(event) => setUpload(i, { key: event.target.value })} />
                </Field>
                <Field label="Kind">
                  <Select value={upload.kind} options={UPLOAD_KIND_OPTIONS} onChange={(event) => setUpload(i, { kind: event.target.value as DraftUpload["kind"] })} />
                </Field>
                <Field
                  label="Accepted file types"
                  hint="Extensions separated by commas, for example pdf, docx. Leave empty for any allowed type."
                  error={at("allowedTypes")}
                >
                  <Input
                    key={upload.allowedTypes.join(",")}
                    defaultValue={upload.allowedTypes.join(", ")}
                    maxLength={240}
                    spellCheck={false}
                    autoCapitalize="none"
                    onBlur={(event) => setUpload(i, { allowedTypes: parseTypes(event.target.value) })}
                  />
                </Field>
                <Field label="At least" hint="0 makes it optional." error={at("minCount")}>
                  <Input type="number" inputMode="numeric" min={0} max={20} value={upload.minCount} onChange={(event) => setUpload(i, { minCount: count(event.target.value) })} />
                </Field>
                <Field label="At most" error={at("maxCount")}>
                  <Input type="number" inputMode="numeric" min={1} max={20} value={upload.maxCount} onChange={(event) => setUpload(i, { maxCount: count(event.target.value) })} />
                </Field>
              </div>
              <Field label="Hint (optional)" hint="Plain text, up to 200 characters." error={at("hint")}>
                <Input value={upload.hint ?? ""} maxLength={200} onChange={(event) => setUpload(i, { hint: event.target.value || undefined })} />
              </Field>
              <Field label="Storage folder (optional)" hint={`${FOLDER_HINT} Empty uses the workflow's default folder.`} error={at("storageFolder")}>
                <Input
                  value={upload.storageFolder ?? ""}
                  maxLength={400}
                  spellCheck={false}
                  autoCapitalize="none"
                  className="font-mono"
                  onChange={(event) => setUpload(i, { storageFolder: event.target.value || undefined })}
                />
              </Field>
              <FolderExample
                templates={[upload.storageFolder, definition.storageFolder]}
                phase={definition.phases?.find((phase) => phase.key === state.phase)?.label}
                slot={upload.label}
              />
              <fieldset>
                <legend className="mb-1 text-sm font-medium text-ink">Who may upload {slot}</legend>
                <div className="flex flex-wrap gap-x-6 gap-y-1">
                  {ACTORS.map((actor) => (
                    <Checkbox
                      key={actor.value}
                      label={actor.label}
                      checked={upload.uploadedBy.includes(actor.value)}
                      onCheckedChange={(on) => setUpload(i, { uploadedBy: toggleActor(upload.uploadedBy, actor.value, on) })}
                    />
                  ))}
                </div>
                {at("uploadedBy") ? (
                  <p className="mt-1 text-sm text-danger" role="alert">
                    {at("uploadedBy")}
                  </p>
                ) : null}
              </fieldset>
              <div>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove upload ${slot}`}
                  onClick={() => onChange(withRequirements(state, (current) => ({ ...current, uploads: current.uploads.filter((_, j) => j !== i) })))}
                >
                  <Trash2 aria-hidden="true" className="size-4" />
                  Remove
                </Button>
              </div>
            </div>
          );
        })}
        <div>
          <Button
            variant="secondary"
            size="sm"
            disabled={uploads.length >= MAX_UPLOADS}
            aria-label={`Add upload to ${name}`}
            onClick={() => onChange(withRequirements(state, (current) => ({ ...current, uploads: [...current.uploads, newUpload(state)] })))}
          >
            <Plus aria-hidden="true" className="size-4" />
            Add upload
          </Button>
        </div>
      </fieldset>

      <fieldset className="flex min-w-0 flex-col gap-3">
        <legend className="mb-1 text-sm font-semibold text-ink">Acknowledgements needed before leaving {name}</legend>
        {acks.length === 0 ? <p className="text-sm text-muted">None.</p> : null}
        {acks.map((ack, i) => {
          const at = (field: string) => fieldError(issues, `${base}.requirements.acknowledgements.${i}.${field}`);
          const title = ack.title.trim() || `acknowledgement ${i + 1}`;
          return (
            <div key={i} className="flex min-w-0 flex-col gap-3 rounded-[var(--radius-control)] border border-line p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Title" required error={at("title")}>
                  <Input value={ack.title} maxLength={120} onChange={(event) => setAck(i, { title: event.target.value })} />
                </Field>
                <Field label="Key" required error={at("key")}>
                  <Input value={ack.key} maxLength={48} spellCheck={false} autoCapitalize="none" className="font-mono" onChange={(event) => setAck(i, { key: event.target.value })} />
                </Field>
                <Field label="Accepted by">
                  <Select value={ack.acceptedBy} options={ACK_SIDE_OPTIONS} onChange={(event) => setAck(i, { acceptedBy: event.target.value as DraftAcknowledgement["acceptedBy"] })} />
                </Field>
              </div>
              <Field label="Full text" required hint="Plain text, up to 8,000 characters. Shown in full before acceptance; changing it in a new version asks people to accept again." error={at("body")}>
                <Textarea value={ack.body} maxLength={8000} rows={6} onChange={(event) => setAck(i, { body: event.target.value })} />
              </Field>
              <Checkbox label="Require typing a full name" description="The name is stored encrypted with the acceptance." checked={ack.requireTypedName} onCheckedChange={(on) => setAck(i, { requireTypedName: on })} />
              <div>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove acknowledgement ${title}`}
                  onClick={() => onChange(withRequirements(state, (current) => ({ ...current, acknowledgements: current.acknowledgements.filter((_, j) => j !== i) })))}
                >
                  <Trash2 aria-hidden="true" className="size-4" />
                  Remove
                </Button>
              </div>
            </div>
          );
        })}
        <div>
          <Button
            variant="secondary"
            size="sm"
            disabled={acks.length >= MAX_ACKS}
            aria-label={`Add acknowledgement to ${name}`}
            onClick={() => onChange(withRequirements(state, (current) => ({ ...current, acknowledgements: [...current.acknowledgements, newAcknowledgement(state)] })))}
          >
            <Plus aria-hidden="true" className="size-4" />
            Add acknowledgement
          </Button>
        </div>
      </fieldset>
    </div>
  );
}

/**
 * Review step summary of the increment-04 rules: phases (with lock behaviour), requirement counts per phase,
 * acceptance gates and the order-files folder. Read-only; stacks to one column below 640 px.
 */
export function RulesReviewSummary({ definition }: { definition: DraftDefinition }) {
  const trpc = useTRPC();
  const policies = useQuery(trpc.compliance.policies.listPublished.queryOptions());
  const phases = definition.phases ?? [];
  const gates = definition.acceptanceGates ?? [];
  const countsOf = (states: readonly DraftState[]) => ({
    statuses: states.length,
    uploads: states.reduce((sum, state) => sum + (state.requirements?.uploads.length ?? 0), 0),
    acknowledgements: states.reduce((sum, state) => sum + (state.requirements?.acknowledgements.length ?? 0), 0),
  });
  const phaseRows = phases.map((phase) => ({ key: phase.key, label: phase.label.trim() || phase.key, ...countsOf(definition.states.filter((state) => state.phase === phase.key)) }));
  const unphased = countsOf(definition.states.filter((state) => !state.phase || !phases.some((phase) => phase.key === state.phase)));
  const stateLabel = (key: string) => definition.states.find((state) => state.key === key)?.label.trim() || key;
  const policyTitle = (id: string) => policies.data?.find((doc) => doc.documentPublicId === id)?.title ?? (id ? (policies.isPending ? "Loading…" : "Policy not available") : "No policy chosen");
  const workflowFolder = definition.storageFolder?.trim() || "";
  const slotOverrides = definition.states.reduce((sum, state) => sum + (state.requirements?.uploads.filter((slot) => slot.storageFolder?.trim()).length ?? 0), 0);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const reqText = (row: { uploads: number; acknowledgements: number }) =>
    row.uploads + row.acknowledgements === 0 ? "None" : `${plural(row.uploads, "upload", "uploads")}, ${plural(row.acknowledgements, "acknowledgement", "acknowledgements")}`;
  return (
    <section aria-labelledby="review-rules-heading" className="flex min-w-0 flex-col gap-4">
      <h3 id="review-rules-heading" className="text-base font-semibold text-ink">
        Phases, requirements, acceptance and storage
      </h3>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <div className="min-w-0 rounded-[var(--radius-card)] border border-line p-4">
          <h4 className="text-sm font-semibold text-ink">Phases</h4>
          {phaseRows.length === 0 ? (
            <p className="mt-1 text-sm text-muted">No phases. Orders show statuses only.</p>
          ) : (
            <>
              <p className="mt-1 text-sm text-muted">Each phase locks when the order moves on; staff can unlock it with a reason.</p>
              <ul className="mt-2 flex flex-col gap-2 text-sm text-body">
                {phaseRows.map((row) => (
                  <li key={row.key} className="min-w-0 break-words">
                    <span className="font-medium text-ink">{row.label}</span>: {plural(row.statuses, "status", "statuses")}; requirements: {reqText(row)}
                  </li>
                ))}
              </ul>
            </>
          )}
          {unphased.uploads + unphased.acknowledgements > 0 ? <p className="mt-2 text-sm text-body">Statuses without a phase: requirements: {reqText(unphased)}</p> : null}
        </div>
        <div className="min-w-0 rounded-[var(--radius-card)] border border-line p-4">
          <h4 className="text-sm font-semibold text-ink">Acceptance gates</h4>
          {gates.length === 0 ? (
            <p className="mt-1 text-sm text-muted">No gates.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2 text-sm text-body">
              {gates.map((gate, index) => (
                <li key={`${gate.key}-${index}`} className="min-w-0 break-words">
                  <span className="font-medium text-ink">{policyTitle(gate.policyPublicId)}</span>:{" "}
                  {gate.point === "order_start" ? "before any work on the order" : `before submitting from “${stateLabel(gate.point.stepKey)}”`};{" "}
                  {(SIGNATURE_MODE_OPTIONS.find((option) => option.value === gate.signatureMode)?.label ?? gate.signatureMode).toLowerCase()}
                  {gate.askAgainOnNewVersion ? "; asked again for a new policy version" : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="min-w-0 rounded-[var(--radius-card)] border border-line p-4 sm:col-span-2">
          <h4 className="text-sm font-semibold text-ink">Order files folder</h4>
          <p className="mt-1 text-sm text-body">
            <span className="font-mono break-all">{workflowFolder || DEFAULT_ORDER_FILE_FOLDER_TEMPLATE}</span>
            {workflowFolder ? null : " (default)"}
            {slotOverrides > 0 ? `; ${plural(slotOverrides, "upload slot uses", "upload slots use")} its own folder` : ""}
          </p>
          <FolderExample templates={[workflowFolder]} />
        </div>
      </div>
    </section>
  );
}
