/**
 * Compiles a validated ReportSpec to a parameterised Drizzle query over one whitelisted dataset. Every name in
 * the spec is resolved against catalogue.ts; values are bound parameters (Drizzle operators), never SQL text.
 * Runs inside a read-only transaction with a MySQL statement time limit (`max_execution_time`).
 */
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, like, lt, lte, ne, sql, type SQL } from "drizzle-orm";
import { DomainError, validation } from "../../core/errors.js";
import type { DbOrTx, Tx } from "../../core/types.js";
import { aggregatesFor, bucketsFor, fieldOf, filterOpsFor, getDataset, type DatasetDef, type FieldDef } from "./catalogue.js";
import type { Bucket, Cell, ColumnView, FieldType, ReportSpec } from "./spec.js";

export const specInvalid = (message: string, path: string) =>
  validation("REPORT_SPEC_INVALID", message, { path });

interface OutputColumn { view: ColumnView; expr: SQL; type: FieldType; bucket?: Bucket }

export interface CompiledReport {
  dataset: DatasetDef;
  columns: ColumnView[];
  /** Fetches up to `limit` rows (+1 to detect truncation is done by the caller). */
  fetch(tx: DbOrTx, limit: number): Promise<Cell[][]>;
  /**
   * One page for streamed CSV export. The ORDER BY gains every output column as a tiebreaker so consecutive pages
   * inside one repeatable-read snapshot neither repeat nor skip rows (identical rows are interchangeable).
   */
  fetchPage(tx: DbOrTx, limit: number, offset: number): Promise<Cell[][]>;
}

export interface CompileOptions {
  includePersonal: boolean;
  /** Extra conditions from built-in reports (e.g. a date range); already parameterised. */
  extraWhere?: SQL[];
}

function bucketExpr(expr: SQL | FieldDef["expr"], bucket: Bucket): SQL {
  switch (bucket) {
    case "day": return sql`DATE(${expr})`;
    case "week": return sql`DATE_SUB(DATE(${expr}), INTERVAL WEEKDAY(${expr}) DAY)`;
    case "month": return sql`DATE_FORMAT(${expr}, '%Y-%m-01')`;
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function coerce(field: FieldDef, raw: unknown, path: string): string | number | boolean | Date {
  switch (field.type) {
    case "string":
      if (typeof raw !== "string") throw specInvalid("Enter text for this filter.", path);
      return raw;
    case "enum":
      if (typeof raw !== "string" || !field.enumValues?.includes(raw)) throw specInvalid("Choose one of the listed values.", path);
      return raw;
    case "boolean":
      if (typeof raw !== "boolean") throw specInvalid("Choose yes or no.", path);
      return raw;
    case "datetime": {
      const date = typeof raw === "string" && /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/u.test(raw) ? new Date(raw) : null;
      if (!date || Number.isNaN(date.getTime())) throw specInvalid("Enter a valid date.", path);
      return date;
    }
    default:
      if (typeof raw !== "number" || !Number.isFinite(raw) || Math.abs(raw) > 9e15) throw specInvalid("Enter a number.", path);
      return raw;
  }
}

function compileFilter(field: FieldDef, op: ReportSpec["filters"][number]["op"], value: unknown, path: string): SQL {
  if (!filterOpsFor(field.type).includes(op)) throw specInvalid("This operator is not available for this field.", `${path}.op`);
  // A column stays a column at runtime (so drizzle maps Date/boolean params); the cast only picks an overload.
  const expr = field.expr as SQL;
  const one = () => {
    if (Array.isArray(value) || value === undefined) throw specInvalid("Enter one value.", `${path}.value`);
    return coerce(field, value, `${path}.value`);
  };
  switch (op) {
    case "isNull": return isNull(expr);
    case "isNotNull": return isNotNull(expr);
    case "eq": return field.type === "boolean" ? (one() ? sql`(${expr}) = 1` : sql`(${expr}) = 0`) : eq(expr, one());
    case "neq": return ne(expr, one());
    case "gt": return gt(expr, one());
    case "gte": return gte(expr, one());
    case "lt": return lt(expr, one());
    case "lte": return lte(expr, one());
    case "between": {
      if (!Array.isArray(value) || value.length !== 2) throw specInvalid("Enter a start and an end.", `${path}.value`);
      const low = coerce(field, value[0], `${path}.value.0`);
      const high = coerce(field, value[1], `${path}.value.1`);
      return and(gte(expr, low), lte(expr, high)) as SQL;
    }
    case "in": {
      if (!Array.isArray(value) || value.length === 0) throw specInvalid("Choose at least one value.", `${path}.value`);
      return inArray(expr, value.map((item, index) => coerce(field, item, `${path}.value.${index}`)));
    }
    case "contains": return like(expr, `%${escapeLike(String(one()))}%`);
    case "startsWith": return like(expr, `${escapeLike(String(one()))}%`);
  }
}

function aggregateExpr(fn: ReportSpec["aggregates"][number]["fn"], field: FieldDef | undefined): SQL {
  if (fn === "count") return field ? sql`COUNT(${field.expr})` : sql`COUNT(*)`;
  if (!field) throw specInvalid("Choose a field for this calculation.", "aggregates");
  switch (fn) {
    case "sum": return sql`SUM(${field.expr})`;
    case "avg": return sql`AVG(${field.expr})`;
    case "min": return sql`MIN(${field.expr})`;
    case "max": return sql`MAX(${field.expr})`;
  }
}

function aggregateType(fn: ReportSpec["aggregates"][number]["fn"], field: FieldDef | undefined): FieldType {
  if (fn === "count") return "number";
  return field?.type ?? "number";
}

export function compileSpec(spec: ReportSpec, options: CompileOptions): CompiledReport {
  const dataset = getDataset(spec.dataset);
  if (!dataset) throw specInvalid("Choose a dataset from the list.", "dataset");
  const field = (key: string, path: string) => {
    const found = fieldOf(dataset, key);
    if (!found || (found.personal && !options.includePersonal)) throw specInvalid("Choose a field from the list.", path);
    return found;
  };

  const where: SQL[] = [...(dataset.base ? [dataset.base] : []), ...(options.extraWhere ?? [])];
  spec.filters.forEach((filter, index) => {
    where.push(compileFilter(field(filter.field, `filters.${index}.field`), filter.op, filter.value, `filters.${index}`));
  });

  const output: OutputColumn[] = [];
  const grouped = spec.groupBy.length > 0 || spec.aggregates.length > 0;
  const groupExprs: SQL[] = [];
  if (grouped) {
    if (spec.columns.length) throw specInvalid("Remove detail columns when grouping or calculating.", "columns");
    if (!spec.aggregates.length) throw specInvalid("Add at least one calculation when grouping.", "aggregates");
    spec.groupBy.forEach((group, index) => {
      const def = field(group.field, `groupBy.${index}.field`);
      if (def.noGroup) throw specInvalid("This field cannot be grouped.", `groupBy.${index}.field`);
      if (group.bucket && !bucketsFor(def).includes(group.bucket)) throw specInvalid("Only dates can be grouped by period.", `groupBy.${index}.bucket`);
      if (def.type === "datetime" && !group.bucket) throw specInvalid("Choose day, week or month for a date group.", `groupBy.${index}.bucket`);
      const expr = group.bucket ? bucketExpr(def.expr, group.bucket) : sql`${def.expr}`;
      groupExprs.push(expr);
      output.push({ view: { key: def.key, label: def.label, type: def.type }, expr, type: def.type, ...(group.bucket ? { bucket: group.bucket } : {}) });
    });
    const seen = new Set<string>();
    const hasCurrencyGroup = spec.groupBy.some((g) => g.field === "currency");
    const currencyFilter = spec.filters.find((filter) => filter.field === "currency" && filter.op === "eq" && typeof filter.value === "string");
    spec.aggregates.forEach((agg, index) => {
      const def = agg.field ? field(agg.field, `aggregates.${index}.field`) : undefined;
      if (agg.fn !== "count" && !def) throw specInvalid("Choose a field for this calculation.", `aggregates.${index}.field`);
      if (def && !aggregatesFor(def.type).includes(agg.fn)) throw specInvalid("This calculation is not available for this field.", `aggregates.${index}.fn`);
      if (def?.type === "money" && agg.fn !== "count" && !hasCurrencyGroup && !currencyFilter) {
        throw specInvalid("Group by currency or filter one currency before adding amounts.", `aggregates.${index}`);
      }
      const key = def ? `${agg.fn}_${def.key}` : "count";
      if (seen.has(key)) throw specInvalid("Each calculation can be added once.", `aggregates.${index}`);
      seen.add(key);
      const type = aggregateType(agg.fn, def);
      const label = def ? `${agg.fn === "avg" ? "Average" : agg.fn[0]!.toUpperCase() + agg.fn.slice(1)} of ${def.label.toLowerCase()}` : "Count";
      output.push({
        view: { key, label, type, ...(type === "money" && currencyFilter ? { currency: String(currencyFilter.value) } : type === "money" ? { currency: null } : {}) },
        expr: aggregateExpr(agg.fn, def), type,
      });
    });
  } else {
    if (!spec.columns.length) throw specInvalid("Choose at least one column.", "columns");
    const seen = new Set<string>();
    spec.columns.forEach((key, index) => {
      if (seen.has(key)) throw specInvalid("Each column can be added once.", `columns.${index}`);
      seen.add(key);
      const def = field(key, `columns.${index}`);
      output.push({ view: { key: def.key, label: def.label, type: def.type, ...(def.type === "money" ? { currency: null } : {}) }, expr: sql`${def.expr}`, type: def.type });
    });
  }

  const order: SQL[] = spec.sort.map((item, index) => {
    const target = output.find((column) => column.view.key === item.key);
    if (!target) throw specInvalid("Sort by a column in the report.", `sort.${index}.key`);
    return item.dir === "asc" ? asc(target.expr) : desc(target.expr);
  });

  const source: DatasetDef = dataset;
  return {
    dataset,
    columns: output.map((column) => column.view),
    fetch: (tx, limit) => run(tx, order, limit, 0),
    fetchPage: (tx, limit, offset) => run(tx, [...order, ...output.map((column) => asc(column.expr))], limit, offset),
  };

  async function run(tx: DbOrTx, orderBy: SQL[], limit: number, offset: number): Promise<Cell[][]> {
    const selection = Object.fromEntries(output.map((column, index) => [`c${index}`, column.expr]));
    let query = tx.select(selection).from(source.from).$dynamic();
    for (const join of source.joins) query = query.leftJoin(join.table, join.on);
    if (where.length) query = query.where(and(...where));
    if (groupExprs.length) query = query.groupBy(...groupExprs);
    if (orderBy.length) query = query.orderBy(...orderBy);
    query = query.limit(limit);
    if (offset > 0) query = query.offset(offset);
    const rows = await query;
    return rows.map((row) => output.map((column, index) => normalise((row as Record<string, unknown>)[`c${index}`], column)));
  }
}

function normalise(value: unknown, column: OutputColumn): Cell {
  if (value === null || value === undefined) return null;
  if (column.bucket) {
    const text = value instanceof Date ? value.toISOString() : String(value);
    return text.slice(0, 10);
  }
  switch (column.type) {
    case "datetime": {
      const date = value instanceof Date ? value : new Date(String(value).replace(" ", "T") + (String(value).endsWith("Z") ? "" : "Z"));
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    case "boolean": return value === true || value === 1 || value === "1";
    case "number": case "money": case "duration": {
      const n = typeof value === "number" ? value : Number(value);
      return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
    }
    default: return typeof value === "string" ? value : String(value);
  }
}

/* -------------------------------------------------------------------- execution guard ------------------------ */

/** MySQL ER_QUERY_TIMEOUT (3024) and the interrupted-statement error (1317). */
export function isStatementTimeout(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    const errno = (current as { errno?: unknown }).errno;
    if (errno === 3024 || errno === 1317) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export const reportTimeout = () => new DomainError("UNAVAILABLE", "REPORT_TIMEOUT", "The report took too long. Narrow the date range or add filters.");

/** Sets the session statement limit for the read-only transaction and always resets it. */
export async function withStatementLimit<T>(tx: Tx, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  await tx.execute(sql`SET SESSION max_execution_time = ${Math.max(1, Math.floor(timeoutMs))}`);
  try {
    return await fn();
  } catch (error) {
    if (isStatementTimeout(error)) throw reportTimeout();
    throw error;
  } finally {
    await tx.execute(sql`SET SESSION max_execution_time = 0`);
  }
}
