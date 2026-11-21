/**
 * Form field descriptions derived from a setting's Zod schema (increment 03, package A).
 *
 * The description is a deliberately small, closed vocabulary that a client can render as a form:
 * scalars (string / number / integer / boolean), enums (incl. literal unions), nested objects and arrays
 * of scalars or enums. Anything else (records, tuples, arrays of objects, discriminated unions …) is
 * `{ type: "unsupported" }` and the client falls back to the JSON editor. The server never trusts the
 * form: every write is still validated by the declared Zod schema.
 *
 * Derivation goes through Zod 4's `z.toJSONSchema` (input side, so `.default()` fields are optional) and
 * is cached per definition. Secrets never get a description.
 */
import { z } from "zod";
import type { AnySettingDefinition, SettingFieldText } from "./settingsRegistry.js";

export type SettingFieldScalar = string | number | boolean;

interface FieldCommon {
  /** Human label (declared `fields[path].label`, else derived from the property name / setting label). */
  label: string;
  /** Declared `fields[path].help`, else the schema's `.describe()` text. */
  help?: string;
  /** The property must be present (no default, not optional). Always true for the root. */
  required: boolean;
  /** `null` is an accepted value. */
  nullable: boolean;
  /** Schema default (JSON value), when declared. */
  default?: unknown;
}

export type SettingFieldDescription = FieldCommon &
  (
    | { type: "boolean" }
    | { type: "string"; minLength?: number; maxLength?: number; pattern?: string; format?: string }
    | { type: "number" | "integer"; minimum?: number; maximum?: number; exclusiveMinimum?: number; exclusiveMaximum?: number }
    | { type: "enum"; options: Array<{ value: SettingFieldScalar; label: string }> }
    | { type: "object"; fields: Array<SettingFieldDescription & { key: string }> }
    | { type: "array"; items: SettingFieldDescription; minItems?: number; maxItems?: number; uniqueItems?: boolean }
    | { type: "unsupported" }
  );

type Json = Record<string, unknown>;
type Texts = Readonly<Record<string, SettingFieldText>> | undefined;

const MAX_DEPTH = 6;
const MAX_FIELDS = 200;

/** "retentionDays" / "retention_days" → "Retention days". */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .trim()
    .toLowerCase();
  return words.length === 0 ? key : words[0]!.toUpperCase() + words.slice(1);
}

function isObj(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function isScalar(value: unknown): value is SettingFieldScalar {
  return typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

/** Splits `anyOf: [X, {type:"null"}]` / `type: [X, "null"]` into (X, nullable). */
function stripNull(node: Json): { node: Json; nullable: boolean } {
  const variants = Array.isArray(node.anyOf) ? node.anyOf.filter(isObj) : undefined;
  if (variants && variants.length === (node.anyOf as unknown[]).length) {
    const nonNull = variants.filter((v) => v.type !== "null");
    if (nonNull.length < variants.length) {
      const rest: Json = { ...node };
      delete rest.anyOf;
      if (nonNull.length === 1) return { node: { ...rest, ...nonNull[0] }, nullable: true };
      return { node: { ...rest, anyOf: nonNull }, nullable: true };
    }
  }
  if (Array.isArray(node.type) && node.type.includes("null")) {
    const types = node.type.filter((t) => t !== "null");
    return { node: { ...node, type: types.length === 1 ? types[0] : types }, nullable: true };
  }
  return { node, nullable: false };
}

/** Enum values from `enum`, `const`, or an `anyOf` made only of consts. */
function enumValues(node: Json): SettingFieldScalar[] | undefined {
  if (Array.isArray(node.enum) && node.enum.length > 0 && node.enum.every(isScalar)) return node.enum;
  if ("const" in node && isScalar(node.const)) return [node.const];
  if (Array.isArray(node.anyOf) && node.anyOf.length > 0) {
    const values: SettingFieldScalar[] = [];
    for (const variant of node.anyOf) {
      if (!isObj(variant)) return undefined;
      const inner = enumValues(variant);
      if (!inner) return undefined;
      values.push(...inner);
    }
    return values;
  }
  return undefined;
}

interface Ctx {
  texts: Texts;
  count: number;
}

function convert(raw: Json, path: string, propKey: string, fallbackLabel: string, required: boolean, ctx: Ctx, depth: number): SettingFieldDescription {
  ctx.count += 1;
  const { node, nullable } = stripNull(raw);
  const text = ctx.texts?.[path];
  const common: FieldCommon = {
    label: text?.label ?? (propKey ? humanizeKey(propKey) : fallbackLabel),
    required,
    nullable,
  };
  const help = text?.help ?? (typeof node.description === "string" ? node.description.slice(0, 400) : undefined);
  if (help) common.help = help;
  if ("default" in node && node.default !== undefined) common.default = node.default;
  const unsupported = (): SettingFieldDescription => ({ ...common, type: "unsupported" });
  if (depth > MAX_DEPTH || ctx.count > MAX_FIELDS) return unsupported();

  const values = enumValues(node);
  if (values) {
    // A single boolean literal is still an enum; a pure true|false union is a boolean.
    if (values.length === 2 && values.includes(true) && values.includes(false)) return { ...common, type: "boolean" };
    return { ...common, type: "enum", options: values.map((value) => ({ value, label: typeof value === "string" ? humanizeKey(value) : String(value) })) };
  }

  switch (node.type) {
    case "boolean":
      return { ...common, type: "boolean" };
    case "string": {
      const out: SettingFieldDescription = { ...common, type: "string" };
      const min = num(node.minLength);
      const max = num(node.maxLength);
      if (min !== undefined) out.minLength = min;
      if (max !== undefined) out.maxLength = max;
      if (typeof node.pattern === "string") out.pattern = node.pattern;
      if (typeof node.format === "string") out.format = node.format;
      return out;
    }
    case "number":
    case "integer": {
      const out: SettingFieldDescription = { ...common, type: node.type };
      for (const bound of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const) {
        const value = num(node[bound]);
        // Zod emits ±MAX_SAFE_INTEGER for .int(); those are not useful bounds for a form.
        if (value !== undefined && Math.abs(value) < Number.MAX_SAFE_INTEGER) out[bound] = value;
      }
      return out;
    }
    case "object": {
      const props = node.properties;
      if (!isObj(props)) return unsupported();
      // Records / catchall-only objects have open-ended keys: JSON only. Declared keys render as fields.
      if (Object.keys(props).length === 0 && node.additionalProperties !== false) return unsupported();
      const requiredKeys = new Set(Array.isArray(node.required) ? node.required.filter((k): k is string => typeof k === "string") : []);
      const fields: Array<SettingFieldDescription & { key: string }> = [];
      for (const [key, child] of Object.entries(props)) {
        if (!isObj(child)) return unsupported();
        const childPath = path ? `${path}.${key}` : key;
        fields.push({ key, ...convert(child, childPath, key, key, requiredKeys.has(key), ctx, depth + 1) });
      }
      return { ...common, type: "object", fields };
    }
    case "array": {
      if (!isObj(node.items)) return unsupported();
      const items = convert(node.items, path, "", common.label, true, ctx, depth + 1);
      if (!["string", "number", "integer", "boolean", "enum"].includes(items.type)) return unsupported();
      const out: SettingFieldDescription = { ...common, type: "array", items };
      const min = num(node.minItems);
      const max = num(node.maxItems);
      if (min !== undefined) out.minItems = min;
      if (max !== undefined) out.maxItems = max;
      if (node.uniqueItems === true) out.uniqueItems = true;
      return out;
    }
    default:
      return unsupported();
  }
}

/** Pure: Zod schema → field description. Never throws (unrepresentable schemas are "unsupported"). */
export function describeSchema(schema: z.ZodType, options: { label: string; fields?: Texts }): SettingFieldDescription {
  let json: Json;
  try {
    json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any", reused: "inline", cycles: "throw" }) as Json;
  } catch {
    return { label: options.fields?.[""]?.label ?? options.label, required: true, nullable: false, type: "unsupported" };
  }
  delete json.$schema;
  return convert(json, "", "", options.label, true, { texts: options.fields, count: 0 }, 0);
}

const cache = new WeakMap<AnySettingDefinition, SettingFieldDescription>();

/** Cached description for value settings and flags; `undefined` for secrets (they keep their own dialog). */
export function describeSettingFields(def: AnySettingDefinition): SettingFieldDescription | undefined {
  if (def.kind === "secret") return undefined;
  const hit = cache.get(def);
  if (hit) return hit;
  const described = describeSchema(def.schema, { label: def.label, fields: def.kind === "value" ? def.fields : undefined });
  cache.set(def, described);
  return described;
}
