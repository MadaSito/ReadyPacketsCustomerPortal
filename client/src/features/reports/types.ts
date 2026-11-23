/**
 * Package I — Client wire contract for `trpc.reports.*` (mirrors `server/modules/reports/spec.ts`).
 */
import { useTRPC } from "@/lib/trpc";

export const BUILT_IN_KEYS = [
  "orders",
  "customers",
  "referrals",
  "support",
  "payments_discounts",
  "carts",
  "files_recordings",
  "signins_security",
] as const;
export type BuiltInKey = (typeof BUILT_IN_KEYS)[number];

export const FIELD_TYPES = [
  "string",
  "enum",
  "number",
  "money",
  "datetime",
  "boolean",
  "duration",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FILTER_OPS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "in",
  "contains",
  "startsWith",
  "isNull",
  "isNotNull",
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export const AGGREGATES = ["count", "sum", "avg", "min", "max"] as const;
export type Aggregate = (typeof AGGREGATES)[number];

export const BUCKETS = ["day", "week", "month"] as const;
export type Bucket = (typeof BUCKETS)[number];

export const CHART_TYPES = ["table", "bar", "line", "pie"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export const REPORT_LIMITS = {
  screenRows: 5_000,
  csvRows: 100_000,
  maxRangeDays: 732,
  timeoutMs: 15_000,
  runsPerMinute: 10,
  csvMaxBytes: 32 * 1024 * 1024,
} as const;

export type ReportScalar = string | number | boolean;

export interface ReportFilter {
  field: string;
  op: FilterOp;
  value?: ReportScalar | ReportScalar[];
}

export interface ReportGroupBy {
  field: string;
  bucket?: Bucket;
}

export interface ReportAggregate {
  fn: Aggregate;
  field?: string;
}

export interface ReportSort {
  key: string;
  dir: "asc" | "desc";
}

export interface ReportSpec {
  dataset: string;
  columns: string[];
  filters: ReportFilter[];
  groupBy: ReportGroupBy[];
  aggregates: ReportAggregate[];
  sort: ReportSort[];
  limit: number;
  chart: ChartType;
}

export interface BuiltInRunInput {
  key: BuiltInKey;
  range: { from: Date; to: Date };
  comparePrevious?: boolean;
  bucket?: Bucket;
}

export interface BuiltInExportInput extends BuiltInRunInput {
  panel: string;
}

export type Cell = string | number | boolean | null;

export interface ColumnView {
  key: string;
  label: string;
  type: FieldType;
  currency?: string | null;
}

export interface TableResult {
  columns: ColumnView[];
  rows: Cell[][];
  rowCount: number;
  truncated: boolean;
}

export interface MetricView {
  key: string;
  label: string;
  type: FieldType;
  value: number | null;
  previous: number | null;
  currency?: string | null;
}

export interface PanelView extends TableResult {
  key: string;
  title: string;
  chart: ChartType;
  summary: string;
}

export interface BuiltInResult {
  key: BuiltInKey;
  title: string;
  range: { from: string; to: string };
  previousRange: { from: string; to: string } | null;
  metrics: MetricView[];
  panels: PanelView[];
  notes: string[];
  generatedAt: string;
}

export interface CustomResult extends TableResult {
  chart: ChartType;
  specHash: string;
  generatedAt: string;
}

export interface CsvResult {
  filename: string;
  contentType: "text/csv; charset=utf-8";
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

export interface CatalogueBuiltInItem {
  key: BuiltInKey;
  title: string;
  description: string;
}

export interface CatalogueView {
  builtIns: CatalogueBuiltInItem[];
  datasets: DatasetView[];
  limits: {
    screenRows: number;
    csvRows: number;
    maxRangeDays: number;
    timeoutMs: number;
    runsPerMinute: number;
    csvMaxBytes?: number;
  };
  canManage: boolean;
  canExport: boolean;
}

export type ReportVisibility = "private" | "shared";

export interface DefinitionView {
  definitionId: string;
  name: string;
  description: string;
  visibility: ReportVisibility;
  dataset: string;
  spec: ReportSpec;
  specHash: string;
  valid: boolean;
  ownedByMe: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type CustomListScope = "mine" | "shared" | "all";

export interface CustomListInput {
  cursor?: string;
  scope?: CustomListScope;
}

export interface CustomListOutput {
  items: DefinitionView[];
  nextCursor: string | null;
}

export interface DefinitionCreateInput {
  name: string;
  description?: string;
  visibility: ReportVisibility;
  spec: ReportSpec;
}

export interface DefinitionUpdateInput {
  definitionId: string;
  expectedVersion: number;
  definition: DefinitionCreateInput;
}

export function useReportsProcedures() {
  return useTRPC().reports;
}
