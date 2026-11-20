/** Intake questionnaire field builder. Owner: orders_engineer (compliance admin UI). */
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button, Checkbox, Field, IconButton, Input, Select, Textarea } from "@/ui";
import { FIELD_TYPE_LABELS, blankField, type FieldDraft, type IntakeFieldType } from "./model";

const TYPE_OPTIONS = (Object.keys(FIELD_TYPE_LABELS) as IntakeFieldType[]).map((value) => ({ value, label: FIELD_TYPE_LABELS[value] }));

export function FieldBuilder({ fields, onChange }: { fields: FieldDraft[]; onChange: (fields: FieldDraft[]) => void }) {
  const update = (id: string, patch: Partial<FieldDraft>) => onChange(fields.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const move = (index: number, delta: number) => {
    const next = [...fields];
    const [item] = next.splice(index, 1);
    if (item) next.splice(index + delta, 0, item);
    onChange(next);
  };
  return (
    <fieldset className="flex flex-col gap-4">
      <legend className="mb-2 text-base font-semibold text-ink">Questions ({fields.length} of 40)</legend>
      <ol className="flex flex-col gap-4">
        {fields.map((f, index) => {
          const name = f.label.trim() || `question ${index + 1}`;
          return (
            <li key={f.id} className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-ink">Question {index + 1}</h3>
                <div className="flex gap-1">
                  <IconButton label={`Move ${name} up`} icon={<ArrowUp aria-hidden />} size="sm" variant="ghost" disabled={index === 0} onClick={() => move(index, -1)} />
                  <IconButton label={`Move ${name} down`} icon={<ArrowDown aria-hidden />} size="sm" variant="ghost" disabled={index === fields.length - 1} onClick={() => move(index, 1)} />
                  <IconButton label={`Remove ${name}`} icon={<Trash2 aria-hidden />} size="sm" variant="ghost" disabled={fields.length === 1} onClick={() => onChange(fields.filter((x) => x.id !== f.id))} />
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Question" required>
                  <Input value={f.label} onChange={(e) => update(f.id, { label: e.target.value })} maxLength={240} />
                </Field>
                <Field label="Key" required hint="Permanent answer key, e.g. company_name.">
                  <Input value={f.key} onChange={(e) => update(f.id, { key: e.target.value.toLowerCase() })} maxLength={64} autoComplete="off" spellCheck={false} />
                </Field>
                <Field label="Answer type">
                  <Select options={TYPE_OPTIONS} value={f.type} onChange={(e) => update(f.id, { type: e.target.value as IntakeFieldType })} />
                </Field>
                <Field label="Section" hint="Optional heading that groups questions.">
                  <Input value={f.section} onChange={(e) => update(f.id, { section: e.target.value })} maxLength={120} />
                </Field>
              </div>
              <div className="mt-4 flex flex-col gap-4">
                <Field label="Help text" hint="Optional guidance shown under the question.">
                  <Input value={f.helpText} onChange={(e) => update(f.id, { helpText: e.target.value })} maxLength={500} />
                </Field>
                {f.type === "short_text" || f.type === "long_text" ? (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Minimum length">
                      <Input type="number" inputMode="numeric" min={0} value={f.minLength} onChange={(e) => update(f.id, { minLength: e.target.value })} />
                    </Field>
                    <Field label="Maximum length" hint={f.type === "short_text" ? "Up to 500." : "Up to 8000."}>
                      <Input type="number" inputMode="numeric" min={1} value={f.maxLength} onChange={(e) => update(f.id, { maxLength: e.target.value })} />
                    </Field>
                  </div>
                ) : null}
                {f.type === "number" ? (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Minimum value">
                      <Input type="number" inputMode="decimal" value={f.minNumber} onChange={(e) => update(f.id, { minNumber: e.target.value })} />
                    </Field>
                    <Field label="Maximum value">
                      <Input type="number" inputMode="decimal" value={f.maxNumber} onChange={(e) => update(f.id, { maxNumber: e.target.value })} />
                    </Field>
                  </div>
                ) : null}
                {f.type === "single_choice" || f.type === "multi_choice" ? (
                  <Field label="Options" required hint='One per line. Use "value | Label" to store a different value than the label shown.'>
                    <Textarea value={f.options} onChange={(e) => update(f.id, { options: e.target.value })} rows={4} />
                  </Field>
                ) : null}
                {f.type === "multi_choice" ? (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Minimum selections">
                      <Input type="number" inputMode="numeric" min={0} value={f.minSelections} onChange={(e) => update(f.id, { minSelections: e.target.value })} />
                    </Field>
                    <Field label="Maximum selections">
                      <Input type="number" inputMode="numeric" min={1} value={f.maxSelections} onChange={(e) => update(f.id, { maxSelections: e.target.value })} />
                    </Field>
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-6">
                  <Checkbox label="Required" checked={f.required} onCheckedChange={(checked) => update(f.id, { required: checked })} />
                  <Checkbox label="Sensitive" description="Flags the answer as sensitive in the questionnaire definition." checked={f.sensitive} onCheckedChange={(checked) => update(f.id, { sensitive: checked })} />
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      <div>
        <Button variant="secondary" leadingIcon={<Plus aria-hidden />} disabled={fields.length >= 40} onClick={() => onChange([...fields, blankField()])}>
          Add question
        </Button>
      </div>
    </fieldset>
  );
}
