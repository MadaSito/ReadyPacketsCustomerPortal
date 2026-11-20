import { useState, type FormEvent } from "react";
import { Button, Callout, Dialog, Field, Input, Switch, Textarea } from "@/ui";
import { editorKind, parseEditorValue, type SettingView } from "./model";

const SETTING_FORM = "platform-setting-form";
const SECRET_FORM = "platform-secret-form";

function initialText(view: SettingView): string {
  const current = view.value ?? view.defaultValue;
  if (editorKind(view) === "json") return JSON.stringify(current ?? null, null, 2);
  return current === undefined || current === null ? "" : String(current);
}

/** Form body; remounted per setting (key) so its state always starts from the current value. */
function SettingForm({ view, onSubmit }: { view: SettingView; onSubmit: (value: unknown) => void }) {
  const kind = editorKind(view);
  const [text, setText] = useState(() => initialText(view));
  const [flag, setFlag] = useState(() => Boolean(view.value ?? view.defaultValue));
  const [error, setError] = useState<string | null>(null);
  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = parseEditorValue(kind, kind === "boolean" ? flag : text);
    if (!parsed.ok) return setError(parsed.error);
    setError(null);
    onSubmit(parsed.value);
  }
  return (
    <form id={SETTING_FORM} onSubmit={submit} noValidate className="grid gap-4">
      {kind === "boolean" ? (
        <Switch label={view.label} checked={flag} onCheckedChange={setFlag} />
      ) : kind === "json" ? (
        <Field label="Value (JSON)" hint="Structured value. The server checks it against the declared format." error={error ?? undefined}>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={10} spellCheck={false} className="font-mono text-sm" maxLength={65536} />
        </Field>
      ) : (
        <Field label="Value" error={error ?? undefined}>
          <Input value={text} onChange={(e) => setText(e.target.value)} inputMode={kind === "number" ? "decimal" : undefined} maxLength={4000} autoComplete="off" />
        </Field>
      )}
      {view.invalidStored ? <Callout tone="warning" title="Stored value was invalid">The default is in effect until you save a valid value.</Callout> : null}
    </form>
  );
}

/** Edits one non-secret setting. Values are re-validated by the declared schema on the server. */
export function SettingEditDialog({ view, onClose, onSave }: { view: SettingView | null; onClose: () => void; onSave: (value: unknown) => Promise<boolean> }) {
  const [saving, setSaving] = useState(false);
  async function save(value: unknown) {
    setSaving(true);
    const ok = await onSave(value);
    setSaving(false);
    if (ok) onClose();
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
      {view ? <SettingForm key={`${view.key}:${view.version}`} view={view} onSubmit={(value) => void save(value)} /> : null}
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
