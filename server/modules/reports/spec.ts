/**
 * Report wire contract (D6). A custom report is DATA: a strict spec naming one whitelisted dataset and its
 * whitelisted fields. The compiler (query.ts) resolves every name against the catalogue and emits parameterised
 * Drizzle only; there is no SQL text, expression or function name in the spec.
 */
import { z } from "zod";

export const BUILT_IN_KEYS = [
  "orders", "customers", "referrals", "support", "payments_discounts", "carts", "files_recordings", "signins_security",
] as const;
export type BuiltInKey = (typeof BUILT_IN_KEYS)[number];

export const FIELD_TYPES = ["string", "enum", "number", "money", "datetime", "boolean", "duration"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FILTER_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "between", "in", "contains", "startsWith", "isNull", "isNotNull"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];
export const AGGREGATES = ["count", "sum", "avg", "min", "max"] as const;
export type Aggregate = (typeof AGGREGATES)[number];
export const BUCKETS = ["day", "week", "month"] as const;
export type Bucket = (typeof BUCKETS)[number];
export const CHART_TYPES = ["table", "bar", "line", "pie"] as const;

export const REPORT_LIMITS = {
  screenRows: 5_000,
  csvRows: 100_000,
  maxRangeDays: 732,
  timeoutMs: 15_000,
  runsPerMinute: 10,
  csvMaxBytes: 16 * 1024 * 1024,
} as const;

const fieldKey = z.string().regex(/^[a-z][a-zA-Z0-9]{0,47}$/u);
const scalar = z.union([z.string().max(200), z.number().finite(), z.boolean()]);

export const filterSchema = z.strictObject({
  field: fieldKey,
  op: z.enum(FILTER_OPS),
  /** Omitted for isNull/isNotNull; a two-element array for between; 1–50 items for in; otherwise a scalar. */
  value: z.union([scalar, z.array(scalar).min(1).max(50)]).optional(),
});

export const reportSpecSchema = z.strictObject({
  dataset: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
  /** Detail columns when `groupBy` is empty. Ignored (must be empty) when grouping. */
  columns: z.array(fieldKey).max(30).default([]),
  filters: z.array(filterSchema).max(20).default([]),
  groupBy: z.array(z.strictObject({ field: fieldKey, bucket: z.enum(BUCKETS).optional() })).max(3).default([]),
  /** `field` is omitted only for count. */
  aggregates: z.array(z.strictObject({ fn: z.enum(AGGREGATES), field: fieldKey.optional() })).max(10).default([]),
  /** `key` is a column key, a group key, or an aggregate key `<fn>_<field>` / `count`. */
  sort: z.array(z.strictObject({ key: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/u), dir: z.enum(["asc", "desc"]) })).max(3).default([]),
  limit: z.number().int().min(1).max(REPORT_LIMITS.csvRows).default(1_000),
  chart: z.enum(CHART_TYPES).default("table"),
});
export type ReportSpec = z.output<typeof reportSpecSchema>;
export type ReportSpecInput = z.input<typeof reportSpecSchema>;

export const rangeSchema = z
  .strictObject({ from: z.coerce.date(), to: z.coerce.date() })
  .refine((r) => r.to.getTime() > r.from.getTime(), { message: "The end must be after the start.", path: ["to"] })
  .refine((r) => r.to.getTime() - r.from.getTime() <= REPORT_LIMITS.maxRangeDays * 86_400_000, {
    message: "Choose a range of two years or less.", path: ["from"],
  });

export const builtInRunSchema = z.strictObject({
  key: z.enum(BUILT_IN_KEYS),
  range: rangeSchema,
  comparePrevious: z.boolean().default(false),
  bucket: z.enum(BUCKETS).default("day"),
});
export type BuiltInRunInput = z.input<typeof builtInRunSchema>;

export const definitionInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).default(""),
  visibility: z.enum(["private", "shared"]).default("private"),
  spec: reportSpecSchema,
});

/* ------------------------------------------------------------------ results ------------------------------------- */

export type Cell = string | number | boolean | null;

export interface ColumnView {
  key: string;
  label: string;
  type: FieldType;
  /** Money columns: ISO currency when a single currency applies; null when rows carry a `currency` column. */
  currency?: string | null;
}

export interface TableResult {
  columns: ColumnView[];
  rows: Cell[][];
  rowCount: number;
  /** True when the row cap cut the result. */
  truncated: boolean;
}

export interface MetricView {
  key: string;
  label: string;
  type: FieldType;
  value: number | null;
  /** Money metrics: ISO currency; null when the period mixes currencies (value is then null too). */
  currency?: string | null;
  /** Same metric over the previous period of equal length; null when not requested or not computable. */
  previous: number | null;
}

export interface PanelView extends TableResult {
  key: string;
  title: string;
  chart: (typeof CHART_TYPES)[number];
  /** Plain-text summary for screen readers and the chart's text alternative. */
  summary: string;
}

export interface BuiltInResult {
  key: BuiltInKey;
  title: string;
  range: { from: string; to: string };
  previousRange: { from: string; to: string } | null;
  metrics: MetricView[];
  panels: PanelView[];
  /** Notes such as "Personal columns hidden for your role." */
  notes: string[];
  generatedAt: string;
}

export interface CustomResult extends TableResult {
  chart: (typeof CHART_TYPES)[number];
  specHash: string;
  generatedAt: string;
}

export interface CsvResult {
  filename: string;
  contentType: "text/csv; charset=utf-8";
  /** UTF-8 with BOM, RFC 4180, CRLF, formula-injection guarded. */
  csv: string;
  rowCount: number;
  truncated: boolean;
  specHash: string;
}

export interface FieldView {
  key: string;
  label: string;
  type: FieldType;
  personal: boolean;
  enumValues?: readonly string[];
  filterOps: readonly FilterOp[];
  groupable: boolean;
  buckets: readonly Bucket[];
  aggregates: readonly Aggregate[];
}

export interface DatasetView {
  key: string;
  label: string;
  description: string;
  fields: FieldView[];
}

export interface DefinitionView {
  definitionId: string;
  name: string;
  description: string;
  visibility: "private" | "shared";
  dataset: string;
  spec: ReportSpec;
  specHash: string;
  /** False when the stored spec no longer validates against the current catalogue. */
  valid: boolean;
  ownedByMe: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}
