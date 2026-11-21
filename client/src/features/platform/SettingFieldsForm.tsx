/**
 * Schema-driven form for one setting value (increment 03, package A). Controlled: `value` is the same JSON
 * value the JSON tab edits, so both tabs always agree. Errors are keyed by dot path ("_" = root).
 */
import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Button, Field, IconButton, Input, Select, Switch, Textarea } from "@/ui";
import { childPath, constraintHint, emptyValue, parseNumberInput, withChild, type FieldErrors, type SettingFieldDescription } from "./fieldForm";

export interface SettingFieldsFormProps {
  field: SettingFieldDescription;
  value: unknown;
  onChange: (value: unknown) => void;
  errors?: FieldErrors;
  disabled?: boolean;
}

type Props = SettingFieldsFormProps & { path: string; nested: boolean };

function hint(field: SettingFieldDescription): string | undefined {
  return [field.help, constraintHint(field)].filter(Boolean).join(" ") || undefined;
}

function errorAt(errors: FieldErrors | undefined, path: string): string | undefined {
  return errors?.[path || "_"];
}

/** Small JSON box for a nested part the form cannot express; remounted by the parent when the value changes outside. */
function JsonPart({ field, value, onChange, error, disabled }: { field: SettingFieldDescription; value: unknown; onChange: (v: unknown) => void; error?: string; disabled?: boolean }) {
  const [text, setText] = useState(() => (value === undefined ? "" : JSON.stringify(value, null, 2)));
  const [parseError, setParseError] = useState<string | null>(null);
  return (
    <Field label={field.label} required={field.required} hint={[field.help, "Edit this part as JSON."].filter(Boolean).join(" ")} error={parseError ?? error}>
      <Textarea
        value={text}
        rows={4}
        spellCheck={false}
        className="font-mono text-sm"
        maxLength={65536}
        disabled={disabled}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          if (next.trim() === "") {
            setParseError(null);
            onChange(emptyValue(field));
            return;
          }
          try {
            onChange(JSON.parse(next) as unknown);
            setParseError(null);
          } catch {
            setParseError("Enter valid JSON.");
          }
        }}
      />
    </Field>
  );
}

function ScalarInput({ field, value, onChange, error, disabled, label }: { field: SettingFieldDescription; value: unknown; onChange: (v: unknown) => void; error?: string; disabled?: boolean; label?: string }) {
  const shownLabel = label ?? field.label;
  if (field.type === "boolean") {
    return (
      <div className="grid gap-1">
        <Switch label={shownLabel} description={hint(field)} checked={value === undefined || value === null ? Boolean(field.default) : Boolean(value)} onCheckedChange={onChange} disabled={disabled} />
        {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
      </div>
    );
  }
  if (field.type === "enum") {
    const index = field.options.findIndex((o) => o.value === value);
    return (
      <Field label={shownLabel} required={field.required} hint={hint(field)} error={error}>
        <Select
          value={index < 0 ? "" : String(index)}
          disabled={disabled}
          placeholder={field.required && index >= 0 ? undefined : "Not set"}
          options={field.options.map((o, i) => ({ value: String(i), label: o.label }))}
          onChange={(e) => onChange(e.target.value === "" ? emptyValue(field) : field.options[Number(e.target.value)]?.value)}
        />
      </Field>
    );
  }
  const numeric = field.type === "number" || field.type === "integer";
  const text = value === undefined || value === null ? "" : String(value);
  return (
    <Field label={shownLabel} required={field.required} hint={hint(field)} error={error}>
      <Input
        value={text}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        inputMode={numeric ? (field.type === "integer" ? "numeric" : "decimal") : field.type === "string" && field.format === "email" ? "email" : undefined}
        type={field.type === "string" && field.format === "email" ? "email" : field.type === "string" && field.format === "uri" ? "url" : "text"}
        maxLength={field.type === "string" ? Math.min(field.maxLength ?? 4000, 65536) : 64}
        onChange={(e) => {
          const next = e.target.value;
          if (numeric) {
            const parsed = parseNumberInput(next);
            onChange(parsed === undefined ? emptyValue(field) : parsed);
          } else onChange(next === "" ? emptyValue(field) : next);
        }}
      />
    </Field>
  );
}

function ArrayInput({ field, value, onChange, errors, disabled, path }: Props & { field: Extract<SettingFieldDescription, { type: "array" }> }) {
  const items = Array.isArray(value) ? value : [];
  const full = field.maxItems !== undefined && items.length >= field.maxItems;
  const blank = field.items.type === "boolean" ? false : field.items.type === "enum" ? field.items.options[0]?.value : field.items.type === "string" ? "" : undefined;
  const listError = errorAt(errors, path);
  const hintText = hint(field);
  return (
    <fieldset className="grid gap-3 rounded-lg border border-line p-3 sm:p-4">
      <legend className="px-1 text-sm font-medium text-ink">
        {field.label}
        {field.required ? <span aria-hidden="true" className="text-danger"> *</span> : null}
      </legend>
      {hintText ? <p className="text-sm text-muted">{hintText}</p> : null}
      {items.length === 0 ? <p className="text-sm text-muted">No entries.</p> : null}
      <ul className="grid gap-2">
        {items.map((item, index) => (
          // Index keys are intentional: items are scalars without identity, and removal re-renders the tail.
          <li key={index} className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <ScalarInput
                field={field.items}
                label={`${field.label} ${index + 1}`}
                value={item}
                disabled={disabled}
                error={errorAt(errors, childPath(path, index))}
                onChange={(next) => onChange(items.map((old, i) => (i === index ? (next ?? blank) : old)))}
              />
            </div>
            <IconButton
              label={`Remove ${field.label} ${index + 1}`}
              icon={<X aria-hidden="true" className="size-4" />}
              variant="ghost"
              className="mt-7"
              disabled={disabled}
              onClick={() => onChange(items.filter((_, i) => i !== index))}
            />
          </li>
        ))}
      </ul>
      <div>
        <Button size="sm" variant="secondary" disabled={disabled || full} onClick={() => onChange([...items, blank])}>
          <Plus aria-hidden="true" className="size-4" /> Add {field.label.toLowerCase()}
        </Button>
      </div>
      {listError ? <p className="text-sm text-danger" role="alert">{listError}</p> : null}
    </fieldset>
  );
}

function FieldNode(props: Props) {
  const { field, value, onChange, errors, disabled, path, nested } = props;
  if (field.type === "object") {
    const record = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    const body = (
      <div className="grid gap-4">
        {field.fields.map((child) => (
          <FieldNode
            key={child.key}
            field={child}
            path={childPath(path, child.key)}
            nested
            value={record[child.key]}
            errors={errors}
            disabled={disabled}
            onChange={(next) => onChange(withChild(value, child.key, next))}
          />
        ))}
        {errorAt(errors, path) ? <p className="text-sm text-danger" role="alert">{errorAt(errors, path)}</p> : null}
      </div>
    );
    if (!nested) return body;
    return (
      <fieldset className="grid gap-3 rounded-lg border border-line p-3 sm:p-4">
        <legend className="px-1 text-sm font-medium text-ink">{field.label}</legend>
        {field.help ? <p className="text-sm text-muted">{field.help}</p> : null}
        {body}
      </fieldset>
    );
  }
  if (field.type === "array") return <ArrayInput {...props} field={field} />;
  if (field.type === "unsupported") return <JsonPart field={field} value={value} onChange={onChange} error={errorAt(errors, path)} disabled={disabled} />;
  return <ScalarInput field={field} value={value} onChange={onChange} error={errorAt(errors, path)} disabled={disabled} />;
}

/** Renders the whole value. Root objects render their fields directly (no extra group box). */
export function SettingFieldsForm(props: SettingFieldsFormProps) {
  return <FieldNode {...props} path="" nested={false} />;
}
