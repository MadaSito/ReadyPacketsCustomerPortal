/**
 * Pure helpers for the schema-driven setting form (increment 03, package A). The server's Zod schema is
 * the authority; these checks only give fast, field-level feedback before a round trip.
 */
import type { SettingFieldDescription } from "@server/modules/platform/settingFields";

export type { SettingFieldDescription };
export type FieldErrors = Record<string, string>;

/** Dot path of a child ("" = root). */
export const childPath = (parent: string, key: string | number): string => (parent ? `${parent}.${key}` : String(key));

/** True when the whole value can be edited in the form (otherwise only the JSON tab is offered). */
export function formSupported(field: SettingFieldDescription | undefined): field is SettingFieldDescription {
  return field !== undefined && field.type !== "unsupported";
}

/** True when some nested part needs JSON (shown inline as a small JSON box). */
export function hasUnsupportedPart(field: SettingFieldDescription): boolean {
  if (field.type === "unsupported") return true;
  if (field.type === "object") return field.fields.some(hasUnsupportedPart);
  return false;
}

/** Text typed into a numeric input: numbers when they parse, the raw text otherwise (flagged by validate). */
export function parseNumberInput(text: string): number | string | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : text;
}

/** What an emptied optional input stores: null if accepted, else the key is omitted. */
export function emptyValue(field: SettingFieldDescription): null | undefined | "" {
  if (field.type === "string" && field.required) return "";
  if (field.nullable) return null;
  return undefined;
}

function describeNumberBounds(field: Extract<SettingFieldDescription, { type: "number" | "integer" }>): string | undefined {
  const lo = field.minimum ?? field.exclusiveMinimum;
  const hi = field.maximum ?? field.exclusiveMaximum;
  if (lo !== undefined && hi !== undefined) return `Between ${lo} and ${hi}.`;
  if (lo !== undefined) return `At least ${lo}.`;
  if (hi !== undefined) return `At most ${hi}.`;
  return undefined;
}

/** Short constraint hint shown under a field (combined with the declared help text). */
export function constraintHint(field: SettingFieldDescription): string | undefined {
  switch (field.type) {
    case "number":
    case "integer":
      return [field.type === "integer" ? "Whole number." : undefined, describeNumberBounds(field)].filter(Boolean).join(" ") || undefined;
    case "string":
      if (field.maxLength !== undefined && field.minLength !== undefined && field.minLength > 1) return `${field.minLength}–${field.maxLength} characters.`;
      if (field.maxLength !== undefined) return `Up to ${field.maxLength} characters.`;
      return field.format === "email" ? "An email address." : field.format === "uri" ? "A full URL." : undefined;
    case "array":
      if (field.maxItems !== undefined) return `Up to ${field.maxItems} entries.`;
      return undefined;
    default:
      return undefined;
  }
}

function checkScalar(field: SettingFieldDescription, value: unknown): string | undefined {
  switch (field.type) {
    case "boolean":
      return typeof value === "boolean" ? undefined : "Choose on or off.";
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "Enter a number.";
      if (field.type === "integer" && !Number.isInteger(value)) return "Enter a whole number.";
      if ((field.minimum !== undefined && value < field.minimum) || (field.exclusiveMinimum !== undefined && value <= field.exclusiveMinimum)) return describeNumberBounds(field) ?? "Too small.";
      if ((field.maximum !== undefined && value > field.maximum) || (field.exclusiveMaximum !== undefined && value >= field.exclusiveMaximum)) return describeNumberBounds(field) ?? "Too large.";
      return undefined;
    }
    case "string":
      if (typeof value !== "string") return "Enter text.";
      if (field.minLength !== undefined && value.length < field.minLength) return field.minLength <= 1 ? "This field is required." : `Enter at least ${field.minLength} characters.`;
      if (field.maxLength !== undefined && value.length > field.maxLength) return `Enter at most ${field.maxLength} characters.`;
      return undefined;
    case "enum":
      return field.options.some((o) => o.value === value) ? undefined : "Choose one of the options.";
    default:
      return undefined;
  }
}

/** Client-side pre-check. Returns dot-path → message; empty when nothing obvious is wrong. */
export function validateValue(field: SettingFieldDescription, value: unknown, path = "", out: FieldErrors = {}): FieldErrors {
  if (value === undefined) {
    if (field.required) out[path || "_"] = "This field is required.";
    return out;
  }
  if (value === null) {
    if (!field.nullable) out[path || "_"] = "This field is required.";
    return out;
  }
  if (field.type === "unsupported") return out;
  if (field.type === "object") {
    if (typeof value !== "object" || Array.isArray(value)) {
      out[path || "_"] = "Expected a group of fields.";
      return out;
    }
    const record = value as Record<string, unknown>;
    for (const child of field.fields) validateValue(child, record[child.key], childPath(path, child.key), out);
    return out;
  }
  if (field.type === "array") {
    if (!Array.isArray(value)) {
      out[path || "_"] = "Expected a list.";
      return out;
    }
    if (field.minItems !== undefined && value.length < field.minItems) out[path || "_"] = `Add at least ${field.minItems} ${field.minItems === 1 ? "entry" : "entries"}.`;
    if (field.maxItems !== undefined && value.length > field.maxItems) out[path || "_"] = `Use at most ${field.maxItems} entries.`;
    if (field.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) out[path || "_"] = "Entries must be unique.";
    value.forEach((item, index) => {
      const message = checkScalar(field.items, item);
      if (message) out[childPath(path, index)] = message;
    });
    return out;
  }
  const message = checkScalar(field, value);
  if (message) out[path || "_"] = message;
  return out;
}

/** Server `details.fields` (Zod issue paths, "_" = root) → field errors. */
export function serverFieldErrors(paths: readonly string[] | undefined): FieldErrors {
  const out: FieldErrors = {};
  for (const path of paths ?? []) out[path || "_"] = "The server did not accept this value.";
  return out;
}

/** Sets `value` at `key` of an object value, removing the key when `value` is undefined. */
export function withChild(parent: unknown, key: string, value: unknown): Record<string, unknown> {
  const base = typeof parent === "object" && parent !== null && !Array.isArray(parent) ? { ...(parent as Record<string, unknown>) } : {};
  if (value === undefined) delete base[key];
  else base[key] = value;
  return base;
}
