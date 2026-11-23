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
  ACK_SIDE_OPTIONS, ACTORS, addPhase, CAPTURE_OPTIONS, fieldError, issueFieldId, newDocumentTask, newRecordTask, presetOn, RESPONSE_MODES, TYPE_PRESETS, togglePreset, folderExample, gatePointFrom, gatePointValue, MAX_GATES, newAcknowledgement, newGate, newUpload, parseTypes, removeGate, removePhase,
  SIGNATURE_MODE_OPTIONS, toggleActor, updateGate, updatePhase, UPLOAD_KIND_OPTIONS, withRequirements,
  type DraftAcknowledgement, type DraftDefinition, type DraftDocumentTask, type DraftGate, type DraftState, type DraftUpload, type WorkflowIssue,
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
const MAX_DOCUMENTS = 5;

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
  const documents = state.requirements?.documents ?? [];
  const setDoc = (i: number, patch: Partial<DraftDocumentTask>) =>
    onChange(withRequirements(state, (current) => ({ ...current, documents: (current.documents ?? []).map((doc, j) => (j === i ? { ...doc, ...patch } : doc)) })));
  const count = (value: string) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(20, parsed)) : 0;
  };
  /** Field id + error for a path, so the designer's findings list can jump to the exact control. */
  const fieldAt = (path: string) => ({ id: issueFieldId(path), error: fieldError(issues, path) });
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
          const f = (field: string) => fieldAt(`${base}.requirements.uploads.${i}.${field}`);
          const slot = upload.label.trim() || `upload ${i + 1}`;
          const audio = upload.kind === "audio";
          return (
            <div key={i} className="flex min-w-0 flex-col gap-3 rounded-[var(--radius-control)] border border-line p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={audio ? "Task name" : "Upload name"} required hint="Shown to the customer, for example “Signed contract”." {...f("label")}>
                  <Input value={upload.label} maxLength={60} onChange={(event) => setUpload(i, { label: event.target.value })} />
                </Field>
                <Field label="Key" required {...f("key")}>
                  <Input value={upload.key} maxLength={48} spellCheck={false} autoCapitalize="none" className="font-mono" onChange={(event) => setUpload(i, { key: event.target.value })} />
                </Field>
                <Field label="Kind">
                  <Select
                    value={upload.kind}
                    options={UPLOAD_KIND_OPTIONS}
                    onChange={(event) => {
                      const kind = event.target.value as DraftUpload["kind"];
                      // Recording options apply to audio only; drop them when switching to documents.
                      const { capture: _capture, maxMinutes: _max, ...rest } = upload;
                      setUpload(i, kind === "audio" ? { kind } : { ...rest, kind, capture: undefined, maxMinutes: undefined });
                    }}
                  />
                </Field>
                <Field
                  label="Accepted file types"
                  hint="Use the presets below, or type extensions separated by commas, for example pdf, docx. Leave empty for any allowed type."
                  {...f("allowedTypes")}
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
                <Field label="At least" hint="0 makes it optional." {...f("minCount")}>
                  <Input type="number" inputMode="numeric" min={0} max={20} value={upload.minCount} onChange={(event) => setUpload(i, { minCount: count(event.target.value) })} />
                </Field>
                <Field label="At most" {...f("maxCount")}>
                  <Input type="number" inputMode="numeric" min={1} max={20} value={upload.maxCount} onChange={(event) => setUpload(i, { maxCount: count(event.target.value) })} />
                </Field>
              </div>
              <TypePresets name={slot} types={upload.allowedTypes} onChange={(allowedTypes) => setUpload(i, { allowedTypes })} />
              {audio ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="How the customer adds audio" {...f("capture")}>
                    <Select value={upload.capture ?? "either"} options={CAPTURE_OPTIONS} onChange={(event) => setUpload(i, { capture: event.target.value as NonNullable<DraftUpload["capture"]> })} />
                  </Field>
                  <Field label="Longest recording (minutes)" hint="1 to 120. Empty means no limit beyond the file size." {...f("maxMinutes")}>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={120}
                      value={upload.maxMinutes ?? ""}
                      onChange={(event) => {
                        const parsed = Number.parseInt(event.target.value, 10);
                        setUpload(i, { maxMinutes: Number.isFinite(parsed) ? Math.max(0, Math.min(999, parsed)) : undefined });
                      }}
                    />
                  </Field>
                </div>
              ) : null}
              <Field label="Hint (optional)" hint="Plain text, up to 200 characters." {...f("hint")}>
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
                  <p id={issueFieldId(`${base}.requirements.uploads.${i}.uploadedBy`)} tabIndex={-1} className="mt-1 text-sm text-danger" role="alert">
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
          <Button
            variant="secondary"
            size="sm"
            className="ml-2"
            disabled={uploads.length >= MAX_UPLOADS}
            aria-label={`Add recording to ${name}`}
            onClick={() => onChange(withRequirements(state, (current) => ({ ...current, uploads: [...current.uploads, newRecordTask(state)] })))}
          >
            <Plus aria-hidden="true" className="size-4" />
            Add recording
          </Button>
        </div>
      </fieldset>

      <fieldset className="flex min-w-0 flex-col gap-3">
        <legend className="mb-1 text-sm font-semibold text-ink">Acknowledgements needed before leaving {name}</legend>
        {acks.length === 0 ? <p className="text-sm text-muted">None.</p> : null}
        {acks.map((ack, i) => {
          const f = (field: string) => fieldAt(`${base}.requirements.acknowledgements.${i}.${field}`);
          const title = ack.title.trim() || `acknowledgement ${i + 1}`;
          return (
            <div key={i} className="flex min-w-0 flex-col gap-3 rounded-[var(--radius-control)] border border-line p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Title" required {...f("title")}>
                  <Input value={ack.title} maxLength={120} onChange={(event) => setAck(i, { title: event.target.value })} />
                </Field>
                <Field label="Key" required {...f("key")}>
                  <Input value={ack.key} maxLength={48} spellCheck={false} autoCapitalize="none" className="font-mono" onChange={(event) => setAck(i, { key: event.target.value })} />
                </Field>
                <Field label="Text comes from" hint="A note lets your team write extra text on each order; the customer acknowledges both." {...f("source")}>
                  <Select
                    value={ack.source ?? "definition"}
                    options={[
                      { value: "definition", label: "This workflow (same for every order)" },
                      { value: "order_note", label: "This text plus a note written per order" },
                    ]}
                    onChange={(event) => setAck(i, event.target.value === "order_note" ? { source: "order_note", acceptedBy: "customer" } : { source: undefined })}
                  />
                </Field>
                <Field label="Accepted by" {...f("acceptedBy")}>
                  <Select value={ack.acceptedBy} options={ACK_SIDE_OPTIONS} onChange={(event) => setAck(i, { acceptedBy: event.target.value as DraftAcknowledgement["acceptedBy"] })} />
                </Field>
              </div>
              <Field label="Full text" required hint="Plain text, up to 8,000 characters. Shown in full before acceptance; changing it in a new version asks people to accept again." {...f("body")}>
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

      <fieldset className="flex min-w-0 flex-col gap-3">
        <legend className="mb-1 text-sm font-semibold text-ink">Documents to respond to before leaving {name}</legend>
        <p className="text-sm text-muted">Your team uploads a document on the order; the customer edits it in the portal, uploads a reply or acknowledges it.</p>
        {documents.length === 0 ? <p className="text-sm text-muted">None.</p> : null}
        {documents.map((doc, i) => {
          const f = (field: string) => fieldAt(`${base}.requirements.documents.${i}.${field}`);
          const label = doc.label.trim() || `document ${i + 1}`;
          const modes = f("responseModes");
          return (
            <div key={i} className="flex min-w-0 flex-col gap-3 rounded-[var(--radius-control)] border border-line p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Document name" required hint="Shown to the customer, for example “Contract to sign”." {...f("label")}>
                  <Input value={doc.label} maxLength={80} onChange={(event) => setDoc(i, { label: event.target.value })} />
                </Field>
                <Field label="Key" required hint="The reply uses this key plus _reply." {...f("key")}>
                  <Input value={doc.key} maxLength={42} spellCheck={false} autoCapitalize="none" className="font-mono" onChange={(event) => setDoc(i, { key: event.target.value })} />
                </Field>
              </div>
              <Field label="Instructions (optional)" hint="Plain text, up to 200 characters." {...f("hint")}>
                <Input value={doc.hint ?? ""} maxLength={200} onChange={(event) => setDoc(i, { hint: event.target.value || undefined })} />
              </Field>
              <fieldset aria-describedby={modes.error ? `${modes.id}-error` : undefined}>
                <legend className="mb-1 text-sm font-medium text-ink">How the customer responds to {label}</legend>
                <div className="flex flex-col gap-1">
                  {RESPONSE_MODES.map((mode) => (
                    <Checkbox
                      key={mode.value}
                      label={mode.label}
                      description={mode.description}
                      checked={doc.responseModes.includes(mode.value)}
                      onCheckedChange={(on) =>
                        setDoc(i, { responseModes: RESPONSE_MODES.map((m) => m.value).filter((value) => (value === mode.value ? on : doc.responseModes.includes(value))) })
                      }
                    />
                  ))}
                </div>
                {modes.error ? (
                  <p id={`${modes.id}-error`} className="mt-1 text-sm text-danger">
                    <span id={modes.id} tabIndex={-1}>
                      {modes.error}
                    </span>
                  </p>
                ) : null}
              </fieldset>
              <Field label="Accepted file types" hint="Extensions separated by commas. Edit in the portal needs Word (docx)." {...f("allowedTypes")}>
                <Input
                  key={doc.allowedTypes.join(",")}
                  defaultValue={doc.allowedTypes.join(", ")}
                  maxLength={240}
                  spellCheck={false}
                  autoCapitalize="none"
                  onBlur={(event) => setDoc(i, { allowedTypes: parseTypes(event.target.value) })}
                />
              </Field>
              <TypePresets name={label} types={doc.allowedTypes} onChange={(allowedTypes) => setDoc(i, { allowedTypes })} />
              <Checkbox label="Required" description="When off, the order can move on without a response." checked={doc.required} onCheckedChange={(on) => setDoc(i, { required: on })} />
              <div>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove document ${label}`}
                  onClick={() => onChange(withRequirements(state, (current) => ({ ...current, documents: (current.documents ?? []).filter((_, j) => j !== i) })))}
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
            disabled={documents.length >= MAX_DOCUMENTS}
            aria-label={`Add document task to ${name}`}
            onClick={() => onChange(withRequirements(state, (current) => ({ ...current, documents: [...(current.documents ?? []), newDocumentTask(state)] })))}
          >
            <Plus aria-hidden="true" className="size-4" />
            Add document task
          </Button>
        </div>
      </fieldset>
    </div>
  );
}

/** Increment 06 (D8): Word / PDF / Images / Audio presets for a task's accepted types. */
function TypePresets({ name, types, onChange }: { name: string; types: readonly string[]; onChange: (types: string[]) => void }) {
  return (
    <fieldset>
      <legend className="mb-1 text-sm font-medium text-ink">File type presets for {name}</legend>
      <div className="flex flex-wrap gap-x-6 gap-y-1">
        {TYPE_PRESETS.map((preset) => (
          <Checkbox key={preset.id} label={`${preset.label} (${preset.types.join(", ")})`} checked={presetOn(types, preset.id)} onCheckedChange={(on) => onChange(togglePreset(types, preset.id, on))} />
        ))}
      </div>
    </fieldset>
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
