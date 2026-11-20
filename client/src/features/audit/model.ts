/** Audit center client model: field catalogue, labels and query construction. Mirrors server/modules/audit/query.ts. */
import type { AuditModule, AuditEnvelope, AuditQuery, AuditQueryGroup, AuditQueryTerm } from "@server/modules/audit/index";
import type { OperationState } from "@shared/domain";
import type { Tone } from "@/ui";

export type { AuditEnvelope, AuditQuery, AuditQueryGroup, AuditQueryTerm };
export type SearchPage = Awaited<ReturnType<AuditModule["search"]>>;
export type EventDetail = Awaited<ReturnType<AuditModule["getEvent"]>>;
export type CaseSummary = Awaited<ReturnType<AuditModule["listCases"]>>["items"][number];
export type CaseDetail = Awaited<ReturnType<AuditModule["getCase"]>>;
export type ExportView = Awaited<ReturnType<AuditModule["listExports"]>>[number];
export type IntegrityStatus = Awaited<ReturnType<AuditModule["integrityStatus"]>>;
export type Checkpoint = Awaited<ReturnType<AuditModule["listCheckpoints"]>>[number];
export type Verification = Awaited<ReturnType<AuditModule["verifyIntegrity"]>>;
export type RetentionState = Awaited<ReturnType<AuditModule["getRetention"]>>;
export type SavedQuery = Awaited<ReturnType<AuditModule["listSavedQueries"]>>[number];

export const CATEGORIES = ["security", "business", "admin", "system", "file", "integration", "job", "backup", "portable_transfer", "release"] as const;
export const OUTCOMES = ["attempted", "completed", "refused", "denied", "failed", "canceled", "unknown"] as const;
export const SEVERITIES = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  security: "Security",
  business: "Business",
  admin: "Administration",
  system: "System",
  file: "Files",
  integration: "Integrations",
  job: "Jobs",
  backup: "Backup",
  portable_transfer: "Portable transfer",
  release: "Release",
};

export const label = (value: string): string => (CATEGORY_LABELS as Record<string, string>)[value] ?? value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

type Op = "eq" | "in" | "prefix" | "gte" | "lte";
export interface FieldDef {
  name: string;
  label: string;
  ops: readonly Op[];
  options?: readonly string[];
  hint?: string;
}

export const OP_LABELS: Record<Op, string> = { eq: "is", in: "is one of", prefix: "starts with", gte: "at least", lte: "at most" };

const id = "Letters, digits, dot, colon, dash or underscore.";
const hex = "32-character reference (copy it from an event).";
export const FIELDS: readonly FieldDef[] = [
  { name: "category", label: "Category", ops: ["eq", "in"], options: CATEGORIES },
  { name: "event_name", label: "Event name", ops: ["eq", "in", "prefix"], hint: "Lowercase dotted name, for example auth.login." },
  { name: "action", label: "Action", ops: ["eq", "in"] },
  { name: "outcome", label: "Outcome", ops: ["eq", "in"], options: OUTCOMES },
  { name: "severity", label: "Severity", ops: ["eq", "gte", "lte"], options: SEVERITIES },
  { name: "actor_role", label: "Actor role", ops: ["eq", "in"], options: ["admin", "staff", "customer", "system", "anonymous"] },
  { name: "actor_ref", label: "Actor reference", ops: ["eq", "in"], hint: hex },
  { name: "session_ref", label: "Session reference", ops: ["eq"], hint: hex },
  { name: "resource_type", label: "Resource type", ops: ["eq", "in"] },
  { name: "resource_public_id", label: "Resource ID", ops: ["eq", "in"], hint: id },
  { name: "resource_ref", label: "Resource reference", ops: ["eq"], hint: hex },
  { name: "reason_code", label: "Reason code", ops: ["eq", "in", "prefix"], hint: "Uppercase, for example STEP_UP_REQUIRED." },
  { name: "request_id", label: "Request ID", ops: ["eq", "in"], hint: id },
  { name: "trace_id", label: "Trace ID", ops: ["eq", "in"], hint: hex },
  { name: "correlation_id", label: "Correlation ID", ops: ["eq", "in"], hint: id },
  { name: "parent_correlation_id", label: "Parent correlation ID", ops: ["eq"], hint: id },
  { name: "job_id", label: "Job ID", ops: ["eq", "in"], hint: id },
  { name: "package_id", label: "Package ID", ops: ["eq", "in"], hint: id },
  { name: "import_id", label: "Import ID", ops: ["eq"], hint: id },
  { name: "delivery_id", label: "Delivery ID", ops: ["eq"], hint: id },
  { name: "provider", label: "Provider", ops: ["eq", "in"] },
  { name: "source_address_ref", label: "Source address reference", ops: ["eq"], hint: hex },
  { name: "source_address_class", label: "Source address class", ops: ["eq", "in"], options: ["loopback", "private", "public", "unknown", "none"] },
  { name: "origin", label: "Origin", ops: ["eq", "in"], options: ["http", "worker", "cli", "scheduler", "test", "unknown"] },
  { name: "release_ref", label: "Release", ops: ["eq"] },
  { name: "durability", label: "Durability", ops: ["eq"], options: ["durable", "best_effort"] },
];
export const fieldDef = (name: string): FieldDef | undefined => FIELDS.find((f) => f.name === name);

export const RANGES = [
  { value: "1h", label: "Last hour", ms: 3_600_000 },
  { value: "24h", label: "Last 24 hours", ms: 86_400_000 },
  { value: "7d", label: "Last 7 days", ms: 7 * 86_400_000 },
  { value: "30d", label: "Last 30 days", ms: 30 * 86_400_000 },
  { value: "90d", label: "Last 90 days", ms: 90 * 86_400_000 },
  { value: "365d", label: "Last 365 days", ms: 365 * 86_400_000 },
] as const;
export type RangeKey = (typeof RANGES)[number]["value"];

/** One editable condition row in the builder. */
export interface Condition {
  key: string;
  field: string;
  op: Op;
  value: string;
}

export interface Filters {
  range: RangeKey;
  category: string;
  outcome: string;
  minSeverity: string;
  ids: string;
  match: "and" | "or";
  conditions: Condition[];
}

export const DEFAULT_FILTERS: Filters = { range: "24h", category: "", outcome: "", minSeverity: "", ids: "", match: "and", conditions: [] };

const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const HEX32 = /^[0-9a-f]{32}$/;

/** Builds the server AST. Quick filters are ANDed; advanced conditions are grouped by the chosen AND/OR. */
export function buildQuery(filters: Filters, now: Date = new Date()): AuditQuery {
  const ms = RANGES.find((r) => r.value === filters.range)?.ms ?? 86_400_000;
  const terms: (AuditQueryTerm | AuditQueryGroup)[] = [];
  if (filters.category) terms.push({ field: "category", op: "eq", value: filters.category });
  if (filters.outcome) terms.push({ field: "outcome", op: "eq", value: filters.outcome });
  if (filters.minSeverity) terms.push({ field: "severity", op: "gte", value: filters.minSeverity });
  const id = filters.ids.trim();
  if (id) {
    const anyId: AuditQueryTerm[] = [];
    if (ID_RE.test(id)) anyId.push({ field: "correlation_id", op: "eq", value: id }, { field: "request_id", op: "eq", value: id }, { field: "job_id", op: "eq", value: id }, { field: "resource_public_id", op: "eq", value: id });
    if (HEX32.test(id)) anyId.push({ field: "trace_id", op: "eq", value: id }, { field: "actor_ref", op: "eq", value: id });
    if (anyId.length > 0) terms.push({ kind: "group", op: "or", terms: anyId });
  }
  const advanced: AuditQueryTerm[] = filters.conditions
    .filter((c) => c.value.trim() !== "")
    .map((c) => ({
      field: c.field as AuditQueryTerm["field"],
      op: c.op,
      value: c.op === "in" ? c.value.split(",").map((v) => v.trim()).filter(Boolean).slice(0, 25) : c.value.trim(),
    })) as AuditQueryTerm[];
  if (advanced.length > 0) terms.push({ kind: "group", op: filters.match, terms: advanced });
  return {
    from: new Date(now.getTime() - ms).toISOString(),
    to: new Date(now.getTime() + 60_000).toISOString(),
    ...(terms.length > 0 ? { where: { kind: "group" as const, op: "and" as const, terms } } : {}),
  };
}

/** Returns an error sentence for the first invalid identifier field, or null. Mirrors server grammar loosely. */
export function invalidIdentifier(filters: Filters): string | null {
  const id = filters.ids.trim();
  if (id && !ID_RE.test(id) && !HEX32.test(id)) return "Use a request, trace, correlation, job or resource ID without spaces.";
  return null;
}

export function countActive(filters: Filters): number {
  return [filters.category, filters.outcome, filters.minSeverity, filters.ids.trim()].filter(Boolean).length + filters.conditions.filter((c) => c.value.trim()).length + (filters.range !== DEFAULT_FILTERS.range ? 1 : 0);
}

export function severityTone(severity: string): Tone {
  if (severity === "FATAL" || severity === "ERROR") return "danger";
  if (severity === "WARN") return "warning";
  if (severity === "INFO") return "info";
  return "neutral";
}

export function outcomeState(outcome: string): OperationState {
  switch (outcome) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    case "refused":
    case "denied":
      return "refused";
    case "attempted":
      return "running";
    default:
      return "unknown";
  }
}

export const PIVOT_LABELS: Record<string, string> = {
  request: "Same request",
  trace: "Same trace",
  correlation: "Same workflow",
  actor: "Same actor",
  session: "Same session",
  resource: "Same resource",
  job: "Same job",
  package: "Same package",
};

/** Reads `?name=` from the real query string or from a hash route (`#/admin/audit?correlationId=…`). */
export function readParam(search: string, name: string): string | null {
  const direct = new URLSearchParams(search).get(name);
  if (direct) return direct;
  if (typeof window === "undefined") return null;
  const hash = window.location.hash;
  const q = hash.indexOf("?");
  return q >= 0 ? new URLSearchParams(hash.slice(q + 1)).get(name) : null;
}
