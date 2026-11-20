/**
 * Bounded audit query language: validated AST → parameterised Drizzle SQL. Owner: audit engineer.
 *
 * - No raw SQL, regex or free-text scans. Every field is allowlisted with its operators and a value
 *   validator; every value is bound as a parameter by Drizzle.
 * - A time window is mandatory (≤ MAX_WINDOW_DAYS) so every query can use a time-leading index.
 * - Depth ≤ MAX_DEPTH, total terms ≤ MAX_TERMS, `in` lists ≤ MAX_IN.
 * - Cursor pagination on (occurred_at DESC, event_id DESC) — stable under concurrent inserts.
 */
import { z } from "zod";
import { and, desc, eq, gte, inArray, like, lt, lte, or, sql, type SQL } from "drizzle-orm";
import type { MySqlColumn } from "drizzle-orm/mysql-core";
import { AUDIT_CATEGORIES, AUDIT_OUTCOMES, SEVERITIES, type Severity } from "../../core/types.js";
import { ULID_PATTERN } from "../../core/ids.js";
import { validation } from "../../core/errors.js";
import { ACTION_RE, ATTRIBUTE_KEY_RE, ATTRIBUTE_STRING_RE, REASON_CODE_RE, REF_ID_RE, RESOURCE_TYPE_RE, SEVERITY_NUMBER } from "./envelope.js";
import { auditEvents } from "./schema.js";

export const MAX_DEPTH = 3;
export const MAX_TERMS = 30;
export const MAX_IN = 25;
export const MAX_WINDOW_DAYS = 400;
export const MAX_PAGE = 100;

type Op = "eq" | "in" | "prefix" | "gte" | "lte";

interface FieldSpec {
  column: MySqlColumn;
  ops: readonly Op[];
  /** Returns the SQL-bound value or null if invalid. */
  parse(value: string | number): string | number | null;
  label: string;
}

const pattern = (re: RegExp) => (value: string | number) => (typeof value === "string" && re.test(value) ? value : null);
const oneOf = (values: readonly string[]) => (value: string | number) => (typeof value === "string" && values.includes(value) ? value : null);
const HEX32 = /^[0-9a-f]{32}$/;
const PREFIXABLE = /^[a-z0-9_.]{1,96}$/;

export const QUERY_FIELDS = {
  category: { column: auditEvents.category, ops: ["eq", "in"], parse: oneOf(AUDIT_CATEGORIES), label: "Category" },
  event_name: { column: auditEvents.eventName, ops: ["eq", "in", "prefix"], parse: pattern(PREFIXABLE), label: "Event name" },
  action: { column: auditEvents.action, ops: ["eq", "in"], parse: pattern(ACTION_RE), label: "Action" },
  outcome: { column: auditEvents.outcome, ops: ["eq", "in"], parse: oneOf(AUDIT_OUTCOMES), label: "Outcome" },
  severity: {
    column: auditEvents.severityNumber,
    ops: ["eq", "gte", "lte"],
    parse: (value) => (typeof value === "string" && (SEVERITIES as readonly string[]).includes(value) ? SEVERITY_NUMBER[value as Severity] : null),
    label: "Severity",
  },
  actor_ref: { column: auditEvents.actorRef, ops: ["eq", "in"], parse: pattern(HEX32), label: "Actor reference" },
  actor_role: { column: auditEvents.actorRole, ops: ["eq", "in"], parse: oneOf(["admin", "staff", "customer", "system", "anonymous"]), label: "Actor role" },
  session_ref: { column: auditEvents.sessionRef, ops: ["eq"], parse: pattern(HEX32), label: "Session reference" },
  resource_type: { column: auditEvents.resourceType, ops: ["eq", "in"], parse: pattern(RESOURCE_TYPE_RE), label: "Resource type" },
  resource_public_id: { column: auditEvents.resourcePublicId, ops: ["eq", "in"], parse: pattern(REF_ID_RE), label: "Resource ID" },
  resource_ref: { column: auditEvents.resourceRef, ops: ["eq"], parse: pattern(HEX32), label: "Resource reference" },
  reason_code: { column: auditEvents.reasonCode, ops: ["eq", "in", "prefix"], parse: pattern(REASON_CODE_RE), label: "Reason code" },
  request_id: { column: auditEvents.requestId, ops: ["eq", "in"], parse: pattern(REF_ID_RE), label: "Request ID" },
  trace_id: { column: auditEvents.traceId, ops: ["eq", "in"], parse: pattern(HEX32), label: "Trace ID" },
  correlation_id: { column: auditEvents.correlationId, ops: ["eq", "in"], parse: pattern(REF_ID_RE), label: "Correlation ID" },
  parent_correlation_id: { column: auditEvents.parentCorrelationId, ops: ["eq"], parse: pattern(REF_ID_RE), label: "Parent correlation ID" },
  job_id: { column: auditEvents.jobId, ops: ["eq", "in"], parse: pattern(REF_ID_RE), label: "Job ID" },
  package_id: { column: auditEvents.packageId, ops: ["eq", "in"], parse: pattern(REF_ID_RE), label: "Package ID" },
  import_id: { column: auditEvents.importId, ops: ["eq"], parse: pattern(REF_ID_RE), label: "Import ID" },
  delivery_id: { column: auditEvents.deliveryId, ops: ["eq"], parse: pattern(REF_ID_RE), label: "Delivery ID" },
  provider: { column: auditEvents.provider, ops: ["eq", "in"], parse: pattern(/^[a-z][a-z0-9_.-]{0,31}$/), label: "Provider" },
  source_address_ref: { column: auditEvents.sourceAddressRef, ops: ["eq"], parse: pattern(HEX32), label: "Source address reference" },
  source_address_class: { column: auditEvents.sourceAddressClass, ops: ["eq", "in"], parse: oneOf(["loopback", "private", "public", "unknown", "none"]), label: "Source address class" },
  origin: { column: auditEvents.origin, ops: ["eq", "in"], parse: oneOf(["http", "worker", "cli", "scheduler", "test", "unknown"]), label: "Origin" },
  release_ref: { column: auditEvents.releaseRef, ops: ["eq"], parse: pattern(/^[A-Za-z0-9_.:+-]{1,80}$/), label: "Release" },
  durability: { column: auditEvents.durability, ops: ["eq"], parse: oneOf(["durable", "best_effort"]), label: "Durability" },
} as const satisfies Record<string, FieldSpec>;

export type QueryField = keyof typeof QUERY_FIELDS;
export const QUERY_FIELD_NAMES = Object.keys(QUERY_FIELDS) as QueryField[];

const scalar = z.union([z.string().max(128), z.number().finite()]);

export const fieldTermSchema = z.strictObject({
  field: z.enum(QUERY_FIELD_NAMES as [QueryField, ...QueryField[]]),
  op: z.enum(["eq", "in", "prefix", "gte", "lte"]),
  value: z.union([scalar, z.array(z.string().max(128)).min(1).max(MAX_IN)]),
});
export const attributeTermSchema = z.strictObject({
  field: z.literal("attribute"),
  key: z.string().regex(ATTRIBUTE_KEY_RE),
  op: z.literal("eq"),
  value: z.union([z.string().max(128).regex(ATTRIBUTE_STRING_RE), z.number().finite(), z.boolean()]),
});
export type FieldTerm = z.infer<typeof fieldTermSchema>;
export type AttributeTerm = z.infer<typeof attributeTermSchema>;
export type Term = FieldTerm | AttributeTerm;
export interface Group {
  kind: "group";
  op: "and" | "or";
  terms: (Term | Group)[];
}

/** Hard cap on total JSON nodes in `where`, checked iteratively BEFORE schema parsing (no recursion). */
export const MAX_WHERE_NODES = 400;

function boundedShape(value: unknown): boolean {
  const stack: { v: unknown; d: number }[] = [{ v: value, d: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { v, d } = stack.pop()!;
    nodes += 1;
    // Group nesting MAX_DEPTH → JSON depth ≤ MAX_DEPTH*2 (group → terms array) + term object + `in` array.
    if (nodes > MAX_WHERE_NODES || d > MAX_DEPTH * 2 + 2) return false;
    if (Array.isArray(v)) for (const item of v) stack.push({ v: item, d: d + 1 });
    else if (v !== null && typeof v === "object") for (const item of Object.values(v)) stack.push({ v: item, d: d + 1 });
  }
  return true;
}

const leafSchema = z.union([fieldTermSchema, attributeTermSchema]);
type AnySchema = z.ZodType<Term | Group>;
function groupAt(level: number): z.ZodType<Group> {
  // Depth-specific, non-recursive: the deepest level accepts only leaf terms.
  const member: AnySchema = level >= MAX_DEPTH ? leafSchema : z.union([groupAt(level + 1), fieldTermSchema, attributeTermSchema]);
  return z.strictObject({ kind: z.literal("group"), op: z.enum(["and", "or"]), terms: z.array(member).min(1).max(MAX_TERMS) });
}

export const groupSchema: z.ZodType<Group> = z
  .unknown()
  .refine(boundedShape, { message: `Filters are limited to ${MAX_DEPTH} nested levels and ${MAX_TERMS} conditions.` })
  .pipe(groupAt(1)) as unknown as z.ZodType<Group>;

export const auditQuerySchema = z.strictObject({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  where: groupSchema.optional(),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

const bad = (reason: string, message: string) => validation(reason, message);

function compileGroup(group: Group, depth: number, budget: { terms: number }): SQL {
  if (depth > MAX_DEPTH) throw bad("QUERY_TOO_DEEP", `Filters can be nested at most ${MAX_DEPTH} levels deep.`);
  const parts: SQL[] = [];
  for (const term of group.terms) {
    if ("kind" in term) {
      parts.push(compileGroup(term, depth + 1, budget));
      continue;
    }
    budget.terms += 1;
    if (budget.terms > MAX_TERMS) throw bad("QUERY_TOO_LARGE", `A query may contain at most ${MAX_TERMS} conditions.`);
    parts.push(compileTerm(term));
  }
  const combined = group.op === "and" ? and(...parts) : or(...parts);
  if (!combined) throw bad("QUERY_EMPTY_GROUP", "Each filter group needs at least one condition.");
  return sql`(${combined})`;
}

function compileTerm(term: Term): SQL {
  if (term.field === "attribute") {
    // Path is built from a regex-validated key; both path and value are bound parameters.
    return sql`JSON_EXTRACT(${auditEvents.attributes}, ${`$.${term.key}`}) = CAST(${JSON.stringify(term.value)} AS JSON)`;
  }
  const spec: FieldSpec = QUERY_FIELDS[term.field];
  if (!spec.ops.includes(term.op)) throw bad("QUERY_OPERATOR_NOT_ALLOWED", `That comparison is not available for ${spec.label}.`);
  if (term.op === "in") {
    if (!Array.isArray(term.value)) throw bad("QUERY_VALUE_INVALID", `${spec.label} needs a list of values.`);
    const values = term.value.map((v) => spec.parse(v));
    if (values.some((v) => v === null)) throw bad("QUERY_VALUE_INVALID", `A value for ${spec.label} is not valid.`);
    return inArray(spec.column, values as (string | number)[]);
  }
  if (Array.isArray(term.value)) throw bad("QUERY_VALUE_INVALID", `${spec.label} needs a single value.`);
  const value = spec.parse(term.value);
  if (value === null) throw bad("QUERY_VALUE_INVALID", `The value for ${spec.label} is not valid.`);
  switch (term.op) {
    case "eq":
      return eq(spec.column, value);
    case "gte":
      return gte(spec.column, value);
    case "lte":
      return lte(spec.column, value);
    case "prefix":
      return like(spec.column, `${String(value).replace(/[\\%_]/g, "\\$&")}%`);
    default:
      throw bad("QUERY_OPERATOR_NOT_ALLOWED", "That comparison is not available.");
  }
}

export interface CompiledQuery {
  where: SQL;
  from: Date;
  to: Date;
  termCount: number;
}

/** Validates (shape + limits + values) and compiles. Throws DomainError(VALIDATION) with a safe message. */
export function compileQuery(input: unknown): CompiledQuery {
  const parsed = auditQuerySchema.safeParse(input);
  if (!parsed.success) throw bad("QUERY_INVALID", "The search filters are not valid.");
  const query = parsed.data;
  const from = new Date(query.from);
  const to = new Date(query.to);
  if (!(from < to)) throw bad("QUERY_TIME_RANGE_INVALID", "The start of the time range must be before its end.");
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * 86_400_000) throw bad("QUERY_TIME_RANGE_TOO_LONG", `Search at most ${MAX_WINDOW_DAYS} days at a time.`);
  const budget = { terms: 0 };
  const parts: SQL[] = [gte(auditEvents.occurredAt, from), lt(auditEvents.occurredAt, to)];
  if (query.where) parts.push(compileGroup(query.where, 1, budget));
  return { where: and(...parts)!, from, to, termCount: budget.terms };
}

/* ---------------------------------------------------------------- cursors */

export function encodeCursor(occurredAt: Date, eventId: string): string {
  return Buffer.from(JSON.stringify([occurredAt.getTime(), eventId]), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { occurredAt: Date; eventId: string } {
  try {
    if (cursor.length > 120) throw new Error("long");
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(value) || value.length !== 2) throw new Error("shape");
    const [ms, id] = value as [unknown, unknown];
    if (typeof ms !== "number" || !Number.isSafeInteger(ms) || typeof id !== "string" || !ULID_PATTERN.test(id)) throw new Error("fields");
    return { occurredAt: new Date(ms), eventId: id };
  } catch {
    throw bad("CURSOR_INVALID", "The page position is no longer valid. Please run the search again.");
  }
}

/** Keyset predicate for DESC ordering. */
export function afterCursor(cursor: string | null | undefined): SQL | undefined {
  if (!cursor) return undefined;
  const { occurredAt, eventId } = decodeCursor(cursor);
  return or(lt(auditEvents.occurredAt, occurredAt), and(eq(auditEvents.occurredAt, occurredAt), lt(auditEvents.eventId, eventId)));
}

export const ORDER_NEWEST_FIRST = [desc(auditEvents.occurredAt), desc(auditEvents.eventId)] as const;

/* ------------------------------------------------------------------ pivots */

export const PIVOT_KINDS = ["request", "trace", "correlation", "actor", "session", "resource", "job", "package"] as const;
export type PivotKind = (typeof PIVOT_KINDS)[number];

/** Builds the pivot query for an event (null when the event lacks the pivot key). */
export function pivotQuery(
  event: { occurredAt: Date; requestId: string | null; traceId: string | null; correlationId: string | null; actorRef: string | null; sessionRef: string | null; resourceType: string | null; resourceRef: string | null; jobId: string | null; packageId: string | null },
  kind: PivotKind,
  windowMinutes: number,
): AuditQuery | null {
  const minutes = Math.min(Math.max(1, Math.floor(windowMinutes)), 7 * 24 * 60);
  const around = (m: number) => ({
    from: new Date(event.occurredAt.getTime() - m * 60_000).toISOString(),
    to: new Date(event.occurredAt.getTime() + m * 60_000 + 1).toISOString(),
  });
  const term = (field: QueryField, value: string | null): AuditQuery | null =>
    value ? { ...around(kind === "actor" || kind === "resource" || kind === "session" ? minutes : 24 * 60), where: { kind: "group", op: "and", terms: [{ field, op: "eq", value }] } } : null;
  switch (kind) {
    case "request":
      return term("request_id", event.requestId);
    case "trace":
      return term("trace_id", event.traceId);
    case "correlation":
      return event.correlationId ? { ...around(7 * 24 * 60), where: { kind: "group", op: "and", terms: [{ field: "correlation_id", op: "eq", value: event.correlationId }] } } : null;
    case "actor":
      return term("actor_ref", event.actorRef);
    case "session":
      return term("session_ref", event.sessionRef);
    case "job":
      return term("job_id", event.jobId);
    case "package":
      return event.packageId ? { ...around(30 * 24 * 60), where: { kind: "group", op: "and", terms: [{ field: "package_id", op: "eq", value: event.packageId }] } } : null;
    case "resource":
      return event.resourceType && event.resourceRef
        ? {
            ...around(minutes),
            where: {
              kind: "group",
              op: "and",
              terms: [
                { field: "resource_type", op: "eq", value: event.resourceType },
                { field: "resource_ref", op: "eq", value: event.resourceRef },
              ],
            },
          }
        : null;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------- stats */

export const STAT_DIMENSIONS = { category: auditEvents.category, outcome: auditEvents.outcome, severity: auditEvents.severityText } as const;
export type StatDimension = keyof typeof STAT_DIMENSIONS;
export const STAT_BUCKETS = { hour: { format: "%Y-%m-%dT%H:00:00Z", maxSpanMs: 14 * 86_400_000 }, day: { format: "%Y-%m-%d", maxSpanMs: 400 * 86_400_000 } } as const;
export type StatBucket = keyof typeof STAT_BUCKETS;
