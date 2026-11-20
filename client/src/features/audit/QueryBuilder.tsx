import { Plus, Trash2 } from "lucide-react";
import { Button, Field, IconButton, Input, RadioGroup, Select } from "@/ui";
import { FIELDS, fieldDef, label, OP_LABELS, type Condition, type Filters } from "./model";

let counter = 0;
const newKey = () => `c${(counter += 1)}`;

export function newCondition(): Condition {
  return { key: newKey(), field: "event_name", op: "prefix", value: "" };
}

/** Advanced AND/OR condition builder (one group; quick filters are always ANDed on top). */
export function QueryBuilder({ filters, onChange }: { filters: Filters; onChange: (next: Filters) => void }) {
  const update = (key: string, patch: Partial<Condition>) =>
    onChange({ ...filters, conditions: filters.conditions.map((c) => (c.key === key ? { ...c, ...patch } : c)) });
  return (
    <fieldset className="min-w-0 space-y-4">
      <legend className="text-base font-semibold text-ink">Advanced conditions</legend>
      {filters.conditions.length > 1 ? (
        <RadioGroup
          legend="Match"
          value={filters.match}
          onValueChange={(value) => onChange({ ...filters, match: value === "or" ? "or" : "and" })}
          options={[
            { value: "and", label: "All conditions (AND)" },
            { value: "or", label: "Any condition (OR)" },
          ]}
        />
      ) : null}
      {filters.conditions.length === 0 ? <p className="text-sm text-muted">No advanced conditions. Add one to narrow by any indexed field.</p> : null}
      <ol className="space-y-3">
        {filters.conditions.map((c, index) => {
          const def = fieldDef(c.field) ?? FIELDS[0]!;
          return (
            <li key={c.key} className="grid min-w-0 gap-3 rounded-[var(--radius-card)] border border-line p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,10rem)_minmax(0,1.4fr)_auto] sm:items-end">
              <Field label={`Condition ${index + 1} field`}>
                <Select
                  value={c.field}
                  options={FIELDS.map((f) => ({ value: f.name, label: f.label }))}
                  onChange={(e) => {
                    const next = fieldDef(e.target.value) ?? def;
                    update(c.key, { field: next.name, op: next.ops.includes(c.op) ? c.op : next.ops[0]!, value: "" });
                  }}
                />
              </Field>
              <Field label={`Condition ${index + 1} operator`}>
                <Select value={c.op} options={def.ops.map((op) => ({ value: op, label: OP_LABELS[op] }))} onChange={(e) => update(c.key, { op: e.target.value as Condition["op"] })} />
              </Field>
              {def.options && c.op !== "in" ? (
                <Field label={`Condition ${index + 1} value`}>
                  <Select value={c.value} placeholder="Choose a value" options={def.options.map((o) => ({ value: o, label: label(o) }))} onChange={(e) => update(c.key, { value: e.target.value })} />
                </Field>
              ) : (
                <Field label={`Condition ${index + 1} value`} hint={c.op === "in" ? "Separate up to 25 values with commas." : def.hint}>
                  <Input value={c.value} maxLength={c.op === "in" ? 2000 : 128} autoComplete="off" spellCheck={false} onChange={(e) => update(c.key, { value: e.target.value })} />
                </Field>
              )}
              <IconButton label={`Remove condition ${index + 1}`} icon={<Trash2 aria-hidden className="size-4" />} variant="ghost" onClick={() => onChange({ ...filters, conditions: filters.conditions.filter((x) => x.key !== c.key) })} />
            </li>
          );
        })}
      </ol>
      <Button variant="secondary" size="sm" leadingIcon={<Plus aria-hidden className="size-4" />} disabled={filters.conditions.length >= 20} onClick={() => onChange({ ...filters, conditions: [...filters.conditions, newCondition()] })}>
        Add condition
      </Button>
    </fieldset>
  );
}
