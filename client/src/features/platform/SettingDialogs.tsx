import { useState, type FormEvent } from "react";
import { Button, Callout, Dialog, Field, Tabs, Textarea } from "@/ui";
import { formSupported, hasUnsupportedPart, serverFieldErrors, validateValue, type FieldErrors } from "./fieldForm";
import { parseEditorValue, viewField, type SettingView } from "./model";
import { SettingFieldsForm } from "./SettingFieldsForm";

const SETTING_FORM = "platform-setting-form";
const SECRET_FORM = "platform-secret-form";

/** Result of saving a setting: on refusal, `fields` are the server's rejected dot paths ("_" = root). */
export type SaveOutcome = { ok: true } | { ok: false; fields?: readonly string[] };

type Tab = "form" | "json";

function initialValue(view: SettingView): unknown {
  return structuredClone(view.value ?? view.defaultValue ?? null);
}

/** JSON tab body; remounted on every switch so it always starts from the shared value. */
function JsonEditor({ value, onValue, error, onParseError }: { value: unknown; onValue: (v: unknown) => void; error?: string; onParseError: (message: string | null) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2));
  return (
    <Field label="Value (JSON)" hint="The same value as the Form tab. The server checks it against the declared format." error={error}>
      <Textarea
        value={text}
        rows={12}
        spellCheck={false}
        className="font-mono text-sm"
        maxLength={65536}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = parseEditorValue("json", e.target.value);
          if (parsed.ok) {
            onParseError(null);
            onValue(parsed.value);
          } else onParseError(parsed.error);
        }}
      />
    </Field>
  );
}

/** Dialog body; remounted per setting (key) so its state always starts from the current value. */
function SettingForm({ view, onSubmit }: { view: SettingView; onSubmit: (value: unknown) => Promise<SaveOutcome> }) {
  const field = viewField(view);
  const formOk = formSupported(field);
  const [tab, setTab] = useState<Tab>(formOk ? "form" : "json");
  const [jsonMount, setJsonMount] = useState(0);
  const [draft, setDraft] = useState<unknown>(() => initialValue(view));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});

  function changeTab(next: string) {
    if (next === tab) return;
    // Never lose typed JSON: stay on the JSON tab until it parses.
    if (tab === "json" && jsonError) return;
    if (next === "json") setJsonMount((n) => n + 1);
    setTab(next as Tab);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (tab === "json" && jsonError) return;
    const local = formOk ? validateValue(field, draft) : {};
    setErrors(local);
    if (Object.keys(local).length > 0) {
      if (tab === "json") setTab("form");
      return;
    }
    const outcome = await onSubmit(draft);
    if (!outcome.ok && outcome.fields && outcome.fields.length > 0) {
      setErrors(serverFieldErrors(outcome.fields));
      if (formOk && tab === "json") setTab("form");
    }
  }

  const errorCount = Object.keys(errors).length;
  const rootError = errors._;
  const formBody = formOk ? (
    <div className="grid gap-4 pt-4">
      {hasUnsupportedPart(field) ? <Callout tone="info" title="Some parts are JSON only">Those parts show a JSON box; the JSON tab edits the whole value.</Callout> : null}
      <SettingFieldsForm field={field} value={draft} onChange={(v) => { setDraft(v); }} errors={errors} />
    </div>
  ) : null;
  const jsonBody = (
    <div className="pt-4">
      <JsonEditor key={jsonMount} value={draft} onValue={setDraft} onParseError={setJsonError} error={jsonError ?? (errorCount > 0 ? Object.values(errors)[0] : undefined)} />
    </div>
  );

  return (
    <form id={SETTING_FORM} onSubmit={(e) => void submit(e)} noValidate className="grid gap-4">
      {errorCount > 0 ? (
        <Callout tone="danger" title={errorCount === 1 ? "1 field needs attention" : `${errorCount} fields need attention`}>
          {rootError ?? "Check the highlighted fields and save again."}
        </Callout>
      ) : null}
      {formOk ? (
        <Tabs
          label="Editor"
          value={tab}
          onValueChange={changeTab}
          items={[
            { value: "form", label: "Form", content: formBody },
            { value: "json", label: "JSON", content: jsonBody },
          ]}
        />
      ) : (
        <>
          <p className="text-sm text-muted">This value has a shape the form cannot show, so it is edited as JSON.</p>
          {jsonBody}
        </>
      )}
      {tab === "json" && jsonError && formOk ? <p className="text-sm text-muted" role="status">Fix the JSON to switch back to the form.</p> : null}
      {view.invalidStored ? <Callout tone="warning" title="Stored value was invalid">The default is in effect until you save a valid value.</Callout> : null}
    </form>
  );
}

/** Edits one non-secret setting (Form | JSON tabs on one value). Values are re-validated by the declared schema on the server. */
export function SettingEditDialog({ view, onClose, onSave }: { view: SettingView | null; onClose: () => void; onSave: (value: unknown) => Promise<SaveOutcome> }) {
  const [saving, setSaving] = useState(false);
  async function save(value: unknown): Promise<SaveOutcome> {
    setSaving(true);
    const outcome = await onSave(value);
    setSaving(false);
    if (outcome.ok) onClose();
    return outcome;
  }
  return (
    <Dialog
      open={view !== null}
      onOpenChange={(open) => (!open && !saving ? onClose() : undefined)}
      title={view ? `Edit ${view.label}` : "Edit setting"}
      description={view?.description}
      dismissible={!saving}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" form={SETTING_FORM} loading={saving}>Save</Button>
        </>
      }
    >
      {view ? <SettingForm key={`${view.key}:${view.version}`} view={view} onSubmit={save} /> : null}
    </Dialog>
  );
}

function SecretForm({ onSubmit }: { onSubmit: (value: string) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!value) return setError("Enter the secret value.");
    setError(null);
    onSubmit(value);
  }
  return (
    <form id={SECRET_FORM} onSubmit={submit} noValidate>
      <Field label="Secret value" required error={error ?? undefined}>
        <Textarea value={value} onChange={(e) => setValue(e.target.value)} rows={4} spellCheck={false} autoComplete="off" className="font-mono text-sm" maxLength={16384} />
      </Field>
    </form>
  );
}

/** Sets or replaces a secret. The value is write-only: it is never displayed or returned. */
export function SecretDialog({ view, onClose, onSave }: { view: SettingView | null; onClose: () => void; onSave: (value: string) => Promise<boolean> }) {
  const [saving, setSaving] = useState(false);
  async function save(value: string) {
    setSaving(true);
    const ok = await onSave(value);
    setSaving(false);
    if (ok) onClose();
  }
  return (
    <Dialog
      open={view !== null}
      onOpenChange={(open) => (!open && !saving ? onClose() : undefined)}
      title={view ? `${view.configured ? "Replace" : "Set"} ${view.label}` : "Set secret"}
      description="Secrets are encrypted at rest and can never be viewed again after saving."
      dismissible={!saving}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" form={SECRET_FORM} loading={saving}>Save secret</Button>
        </>
      }
    >
      {view ? <SecretForm key={`${view.key}:${view.version}`} onSubmit={(value) => void save(value)} /> : null}
    </Dialog>
  );
}
