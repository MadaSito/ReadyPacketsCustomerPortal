/**
 * Reports service (D6). Every call re-checks the live session (role, capability, step-up) inside a transaction.
 * Runs and exports share one slot per user (report_runs.active_user_id, unique) and a per-user rate limit; the
 * query itself runs in a separate read-only repeatable-read transaction with a MySQL statement time limit.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, gte, isNotNull, lt, or, type SQL } from "drizzle-orm";
import { STEP_UP_CAPABILITIES, roleHasCapability, type Capability } from "../../../shared/capabilities.js";
import type { ModuleDeps } from "../../container.js";
import { DomainError, conflict, forbidden, notFound } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { SessionPrincipal, Tx } from "../../core/types.js";
import { hasFreshStepUp } from "../../trpc/trpc.js";
import { escapeAcceptanceCsvCell } from "../compliance/acceptanceLogService.js";
import { BUILT_INS, runBuiltIn, type Range } from "./builtins.js";
import { datasetViews } from "./catalogue.js";
import { compileSpec, reportTimeout, withStatementLimit } from "./query.js";
import { reportDefinitions, reportRuns } from "./schema.js";
import {
  REPORT_LIMITS, builtInRunSchema, definitionInputSchema, reportSpecSchema, type BuiltInResult, type BuiltInRunInput, type Cell,
  type ColumnView, type CsvResult, type CustomResult, type DatasetView, type DefinitionView, type ReportSpec, type ReportSpecInput,
} from "./spec.js";

export const REPORT_RUN_PURGE_JOB = "reports.runs.purge";
const RUN_RETENTION_DAYS = 90;
const MAX_DEFINITIONS_PER_OWNER = 200;
const LIST_PAGE = 50;
const EXPORT_PAGE_ROWS = 2_000;
/** Invoices unpaid this long after issue count as overdue in the payments report (fixed; not a setting). */
const INVOICE_OVERDUE_DAYS = 14;

export interface CatalogueView {
  builtIns: Array<{ key: string; title: string; description: string }>;
  datasets: DatasetView[];
  limits: typeof REPORT_LIMITS;
  canManage: boolean;
  canExport: boolean;
}

export interface DefinitionInput { name: string; description?: string; visibility?: "private" | "shared"; spec: ReportSpecInput }

/* ------------------------------------------------------------------ pure helpers (tested) ---------------------- */

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function specHash(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

/** Filter fields and operators only (never values), bounded for the audit attribute alphabet. */
export function filterShape(spec: Pick<ReportSpec, "filters">): string {
  return spec.filters.map((filter) => `${filter.field}:${filter.op}`).join(",").slice(0, 128);
}

/** Finite numbers are written as-is (a negative amount is data, not a formula); every string goes through the guard. */
const csvCell = (cell: Cell) => {
  if (typeof cell === "number") return Number.isFinite(cell) ? String(cell) : "";
  return escapeAcceptanceCsvCell(typeof cell === "boolean" ? (cell ? "yes" : "no") : cell);
};

/**
 * Incremental CSV writer: UTF-8 BOM, RFC 4180, CRLF, formula-injection guard (the acceptance-log helper). The byte
 * count covers the BOM, header and every CRLF; a row that would pass `maxBytes` is refused and the writer is full.
 */
export function createCsvWriter(columns: ColumnView[], maxBytes: number = REPORT_LIMITS.csvMaxBytes) {
  const header = columns.map((column) => escapeAcceptanceCsvCell(column.label)).join(",");
  const parts = [`\uFEFF${header}\r\n`];
  let bytes = Buffer.byteLength(parts[0]!, "utf8");
  let rowCount = 0;
  let full = false;
  return {
    /** False once the byte cap is reached (the row is not written). */
    push(row: Cell[]): boolean {
      if (full) return false;
      const line = `${row.map(csvCell).join(",")}\r\n`;
      const size = Buffer.byteLength(line, "utf8");
      if (bytes + size > maxBytes) { full = true; return false; }
      parts.push(line);
      bytes += size;
      rowCount += 1;
      return true;
    },
    get full() { return full; },
    finish: () => ({ csv: parts.join(""), rowCount, truncated: full, bytes }),
  };
}

export function buildCsv(columns: ColumnView[], rows: Cell[][], maxBytes: number = REPORT_LIMITS.csvMaxBytes) {
  const writer = createCsvWriter(columns, maxBytes);
  for (const row of rows) if (!writer.push(row)) break;
  const { csv, rowCount, truncated } = writer.finish();
  return { csv, rowCount, truncated };
}

export function previousRange(range: Range): Range {
  const length = range.to.getTime() - range.from.getTime();
  return { from: new Date(range.from.getTime() - length), to: new Date(range.from.getTime()) };
}

function isDuplicate(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    const record = current as { errno?: unknown; code?: unknown; cause?: unknown };
    if (record.errno === 1062 || record.code === "ER_DUP_ENTRY") return true;
    current = record.cause;
  }
  return false;
}

/* ------------------------------------------------------------------ service ------------------------------------ */

export function createReportsService(deps: ModuleDeps) {
  const { db, clock, audit } = deps;

  async function assertLive(principal: SessionPrincipal, capability: Capability, tx: Tx) {
    const check = (p: Pick<SessionPrincipal, "role" | "state" | "pendingSteps" | "stepUpAt">) => {
      if (p.state !== "full" || p.pendingSteps.length) {
        throw new DomainError("REMEDIATION_REQUIRED", "ACCOUNT_STEP_PENDING", "Please finish securing your account to continue.");
      }
      if (p.role === "customer" || !roleHasCapability(p.role, capability)) throw forbidden("CAPABILITY_NOT_GRANTED");
      if (STEP_UP_CAPABILITIES.has(capability) && !hasFreshStepUp({ ...principal, ...p }, clock.now())) {
        throw new DomainError("STEP_UP_REQUIRED", "STEP_UP_REQUIRED", "Please confirm your password and authentication code to continue.", { capability });
      }
    };
    check(principal);
    const sessions = deps.services.identity?.sessions;
    if (!sessions?.assertCurrent) throw forbidden("ACTOR_UNVERIFIABLE");
    const current = await sessions.assertCurrent(principal, tx);
    const live = { ...principal, role: current.role, pendingSteps: current.pendingSteps, stepUpAt: current.stepUpAt };
    check(live);
    return live;
  }

  async function denied(principal: SessionPrincipal, error: unknown) {
    if (error instanceof DomainError && ["FORBIDDEN", "STEP_UP_REQUIRED", "REMEDIATION_REQUIRED"].includes(error.code)) {
      await audit.record({
        category: "security", eventName: "report.denied", action: "access", outcome: "denied", reasonCode: error.reasonCode,
        actor: { userId: principal.userId, role: principal.role }, resource: { type: "report" },
      }).catch(() => undefined);
    }
  }

  async function guard<T>(principal: SessionPrincipal, capability: Capability, fn: (tx: Tx, live: SessionPrincipal) => Promise<T>): Promise<T> {
    try {
      return await db.transaction(async (tx) => fn(tx, await assertLive(principal, capability, tx)));
    } catch (error) {
      await denied(principal, error);
      throw error;
    }
  }

  const includePersonal = (p: SessionPrincipal) => p.role === "admin";
  const actor = (p: SessionPrincipal) => ({ userId: p.userId, role: p.role });

  /* ---------------------------------------------------------------- slot + rate limit ------------------------- */

  async function acquire(principal: SessionPrincipal, kind: "builtin" | "custom" | "export", reportKey: string, hash: string, definitionId: number | null) {
    const now = clock.now();
    const runId = ulid(now.getTime());
    await db.transaction(async (tx) => {
      // A crashed process leaves a stale slot; it is released once its lease has passed.
      await tx.update(reportRuns).set({ activeUserId: null, state: "timed_out", finishedAt: now })
        .where(and(eq(reportRuns.activeUserId, principal.userId), lt(reportRuns.leaseUntil, now)));
      const recent = await tx.select({ id: reportRuns.id }).from(reportRuns)
        .where(and(eq(reportRuns.userId, principal.userId), gte(reportRuns.startedAt, new Date(now.getTime() - 60_000))))
        .limit(REPORT_LIMITS.runsPerMinute);
      if (recent.length >= REPORT_LIMITS.runsPerMinute) {
        throw new DomainError("RATE_LIMITED", "REPORT_RATE_LIMITED", "You have run many reports in the last minute. Wait a moment and try again.");
      }
      try {
        await tx.insert(reportRuns).values({
          publicId: runId, userId: principal.userId, activeUserId: principal.userId, kind, reportKey, definitionId, specHash: hash,
          state: "running", leaseUntil: new Date(now.getTime() + REPORT_LIMITS.timeoutMs * 4), startedAt: now,
        });
      } catch (error) {
        if (isDuplicate(error)) throw conflict("REPORT_BUSY", "Another report of yours is still running. Wait for it to finish.");
        throw error;
      }
    });
    return runId;
  }

  async function release(runId: string, state: "completed" | "failed" | "timed_out", rowCount: number | null) {
    await db.update(reportRuns).set({ activeUserId: null, state, rowCount, finishedAt: clock.now() }).where(eq(reportRuns.publicId, runId));
  }

  /** Runs `fn` in the user's slot, inside a read-only snapshot with the statement limit and an overall deadline. */
  async function inSlot<T extends { rowCount: number }>(
    principal: SessionPrincipal, kind: "builtin" | "custom" | "export", reportKey: string, hash: string, definitionId: number | null,
    fn: (tx: Tx, deadline: () => void) => Promise<T>,
  ): Promise<T> {
    const runId = await acquire(principal, kind, reportKey, hash, definitionId);
    const started = Date.now();
    const deadline = () => { if (Date.now() - started > REPORT_LIMITS.timeoutMs * 2) throw reportTimeout(); };
    try {
      const result = await db.transaction(
        (tx) => withStatementLimit(tx, REPORT_LIMITS.timeoutMs, () => fn(tx, deadline)),
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
      await release(runId, "completed", result.rowCount);
      return result;
    } catch (error) {
      await release(runId, error instanceof DomainError && error.reasonCode === "REPORT_TIMEOUT" ? "timed_out" : "failed", null).catch(() => undefined);
      throw error;
    }
  }

  async function recordRun(principal: SessionPrincipal, attributes: Record<string, string | number | boolean>, rowCount: number, eventName = "report.run", action = "read") {
    await audit.record({
      category: "business", eventName, action, outcome: "completed", actor: actor(principal), resource: { type: "report" },
      safeCounts: { rows: rowCount }, attributes,
    });
  }

  /* ---------------------------------------------------------------- built-ins --------------------------------- */

  async function builtIn(principal: SessionPrincipal, raw: BuiltInRunInput, capability: Capability) {
    const input = builtInRunSchema.parse({ key: raw.key, range: raw.range, comparePrevious: raw.comparePrevious, bucket: raw.bucket });
    const live = await guard(principal, capability, async (_tx, p) => p);
    const range = { from: input.range.from, to: input.range.to };
    const previous = input.comparePrevious ? previousRange(range) : null;
    const hash = specHash({ key: input.key, from: range.from.toISOString(), to: range.to.toISOString(), compare: input.comparePrevious, bucket: input.bucket });
    const now = clock.now();
    const overdueDays = INVOICE_OVERDUE_DAYS;
    const output = await inSlot(live, capability === "reports.export" ? "export" : "builtin", input.key, hash, null, async (tx) => {
      const result = await runBuiltIn(input.key, { tx, range, previous, bucket: input.bucket, includePersonal: includePersonal(live), overdueDays, now });
      return { ...result, rowCount: result.panels.reduce((sum, panel) => sum + panel.rowCount, 0) };
    });
    const title = BUILT_INS.find((item) => item.key === input.key)?.title ?? input.key;
    const result: BuiltInResult = {
      key: input.key, title,
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      previousRange: previous ? { from: previous.from.toISOString(), to: previous.to.toISOString() } : null,
      metrics: output.metrics, panels: output.panels, notes: output.notes, generatedAt: now.toISOString(),
    };
    return { result, hash, live, rowCount: output.rowCount };
  }

  /* ---------------------------------------------------------------- definitions -------------------------------- */

  function toView(row: typeof reportDefinitions.$inferSelect, viewer: SessionPrincipal): DefinitionView {
    const parsed = reportSpecSchema.safeParse(row.spec);
    let valid = parsed.success;
    if (parsed.success) {
      try { compileSpec(parsed.data, { includePersonal: includePersonal(viewer) }); } catch { valid = false; }
    }
    return {
      definitionId: row.publicId, name: row.name, description: row.description, visibility: row.visibility, dataset: row.dataset,
      spec: parsed.success ? parsed.data : reportSpecSchema.parse({ dataset: row.dataset, columns: [] }),
      specHash: row.specHash, valid, ownedByMe: row.ownerUserId === viewer.userId, version: row.version,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Visible = own, or shared. Re-evaluated on every access (no cached audience). */
  async function loadVisible(tx: Tx, viewer: SessionPrincipal, definitionId: string, forUpdate = false) {
    const query = tx.select().from(reportDefinitions).where(eq(reportDefinitions.publicId, definitionId));
    const [row] = forUpdate ? await query.for("update") : await query;
    if (!row || (row.ownerUserId !== viewer.userId && row.visibility !== "shared")) throw notFound("REPORT_NOT_FOUND");
    return row;
  }

  function validated(input: DefinitionInput, viewer: SessionPrincipal) {
    const parsed = definitionInputSchema.parse(input);
    compileSpec(parsed.spec, { includePersonal: includePersonal(viewer) });
    return { ...parsed, hash: specHash(parsed.spec) };
  }

  async function definitionAudit(tx: Tx, p: SessionPrincipal, eventName: string, action: string, definitionId: string, attributes: Record<string, string | number | boolean> = {}) {
    await audit.record({
      category: "admin", eventName, action, outcome: "completed", actor: actor(p),
      resource: { type: "report_definition", publicId: definitionId }, attributes,
    }, tx);
  }

  async function customRun(principal: SessionPrincipal, spec: ReportSpec, hash: string, definition: { id: number; publicId: string } | null, kind: "custom" | "export", rowCap: number) {
    const compiled = compileSpec(spec, { includePersonal: includePersonal(principal) });
    const limit = Math.min(spec.limit, rowCap);
    const out = await inSlot(principal, kind, spec.dataset, hash, definition?.id ?? null, async (tx, deadline) => {
      deadline();
      const rows = await compiled.fetch(tx, limit + 1);
      deadline();
      return { rows: rows.slice(0, limit), truncated: rows.length > limit, rowCount: Math.min(rows.length, limit) };
    });
    return { compiled, ...out };
  }

  return {
    async catalogue(principal: SessionPrincipal): Promise<CatalogueView> {
      return guard(principal, "reports.read", async (_tx, live) => {
        const canManage = roleHasCapability(live.role, "reports.manage");
        return {
          builtIns: BUILT_INS.map((item) => ({ ...item })),
          datasets: canManage ? datasetViews(includePersonal(live)) : [],
          limits: REPORT_LIMITS,
          canManage,
          canExport: roleHasCapability(live.role, "reports.export"),
        };
      });
    },

    builtIn: {
      async run(principal: SessionPrincipal, input: BuiltInRunInput): Promise<BuiltInResult> {
        const { result, hash, live, rowCount } = await builtIn(principal, input, "reports.read");
        await recordRun(live, { report_key: input.key, kind: "builtin", spec_hash: hash, compare: Boolean(input.comparePrevious) }, rowCount);
        return result;
      },
      async export(principal: SessionPrincipal, input: BuiltInRunInput & { panel: string }): Promise<CsvResult> {
        const { result, hash, live } = await builtIn(principal, input, "reports.export");
        const panel = result.panels.find((item) => item.key === input.panel);
        if (!panel) throw notFound("REPORT_PANEL_NOT_FOUND");
        const csv = buildCsv(panel.columns, panel.rows);
        await recordRun(live, { report_key: input.key, panel: input.panel.slice(0, 64), kind: "builtin", spec_hash: hash, truncated: csv.truncated || panel.truncated }, csv.rowCount, "report.exported", "export");
        return {
          filename: `report-${input.key}-${input.panel}-${result.generatedAt.slice(0, 10)}.csv`.replace(/[^A-Za-z0-9._-]/g, "_"),
          contentType: "text/csv; charset=utf-8", csv: csv.csv, rowCount: csv.rowCount, truncated: csv.truncated || panel.truncated, specHash: hash,
        };
      },
    },

    custom: {
      async list(principal: SessionPrincipal, input: { cursor?: string | null; scope?: "mine" | "shared" | "all" } = {}) {
        return guard(principal, "reports.manage", async (tx, live) => {
          const scope = input.scope ?? "all";
          const visible = scope === "mine" ? eq(reportDefinitions.ownerUserId, live.userId)
            : scope === "shared" ? eq(reportDefinitions.visibility, "shared")
              : or(eq(reportDefinitions.ownerUserId, live.userId), eq(reportDefinitions.visibility, "shared"));
          const conditions: SQL[] = [visible as SQL];
          if (input.cursor) {
            const [anchor] = await tx.select({ id: reportDefinitions.id }).from(reportDefinitions).where(eq(reportDefinitions.publicId, input.cursor));
            if (anchor) conditions.push(lt(reportDefinitions.id, anchor.id));
          }
          const rows = await tx.select().from(reportDefinitions).where(and(...conditions)).orderBy(desc(reportDefinitions.id)).limit(LIST_PAGE + 1);
          const items = rows.slice(0, LIST_PAGE).map((row) => toView(row, live));
          return { items, nextCursor: rows.length > LIST_PAGE ? items.at(-1)?.definitionId ?? null : null };
        });
      },

      async get(principal: SessionPrincipal, definitionId: string) {
        return guard(principal, "reports.manage", async (tx, live) => toView(await loadVisible(tx, live, definitionId), live));
      },

      async create(principal: SessionPrincipal, input: DefinitionInput) {
        return guard(principal, "reports.manage", async (tx, live) => {
          const value = validated(input, live);
          const owned = await tx.select({ id: reportDefinitions.id }).from(reportDefinitions)
            .where(eq(reportDefinitions.ownerUserId, live.userId)).limit(MAX_DEFINITIONS_PER_OWNER);
          if (owned.length >= MAX_DEFINITIONS_PER_OWNER) throw conflict("REPORT_DEFINITION_LIMIT", "You have reached the limit of saved reports. Delete one first.");
          const publicId = ulid(clock.now().getTime());
          await tx.insert(reportDefinitions).values({
            publicId, name: value.name, description: value.description, dataset: value.spec.dataset, spec: value.spec, specHash: value.hash,
            visibility: value.visibility, ownerUserId: live.userId,
          });
          await definitionAudit(tx, live, "report.definition.created", "create", publicId, { dataset: value.spec.dataset, spec_hash: value.hash, visibility: value.visibility });
          return toView(await loadVisible(tx, live, publicId), live);
        });
      },

      async update(principal: SessionPrincipal, definitionId: string, expectedVersion: number, input: DefinitionInput) {
        return guard(principal, "reports.manage", async (tx, live) => {
          const row = await loadVisible(tx, live, definitionId, true);
          if (row.ownerUserId !== live.userId) throw forbidden("REPORT_NOT_OWNER");
          if (row.version !== expectedVersion) throw conflict("VERSION_CONFLICT", "This report was changed elsewhere. Reload and try again.");
          const value = validated(input, live);
          await tx.update(reportDefinitions).set({
            name: value.name, description: value.description, dataset: value.spec.dataset, spec: value.spec, specHash: value.hash,
            visibility: value.visibility, version: row.version + 1,
          }).where(eq(reportDefinitions.id, row.id));
          await definitionAudit(tx, live, "report.definition.updated", "update", definitionId, { dataset: value.spec.dataset, spec_hash: value.hash, visibility: value.visibility });
          return toView(await loadVisible(tx, live, definitionId), live);
        });
      },

      async duplicate(principal: SessionPrincipal, definitionId: string, name?: string) {
        const source = await guard(principal, "reports.manage", async (tx, live) => loadVisible(tx, live, definitionId));
        return this.create(principal, {
          name: (name ?? `Copy of ${source.name}`).slice(0, 120), description: source.description, visibility: "private",
          spec: reportSpecSchema.parse(source.spec),
        });
      },

      async delete(principal: SessionPrincipal, definitionId: string, expectedVersion: number) {
        return guard(principal, "reports.manage", async (tx, live) => {
          const row = await loadVisible(tx, live, definitionId, true);
          if (row.ownerUserId !== live.userId) throw forbidden("REPORT_NOT_OWNER");
          if (row.version !== expectedVersion) throw conflict("VERSION_CONFLICT", "This report was changed elsewhere. Reload and try again.");
          await tx.delete(reportDefinitions).where(eq(reportDefinitions.id, row.id));
          await definitionAudit(tx, live, "report.definition.deleted", "delete", definitionId, { dataset: row.dataset, spec_hash: row.specHash });
          return { deleted: true as const };
        });
      },

      async preview(principal: SessionPrincipal, rawSpec: ReportSpecInput): Promise<CustomResult> {
        const live = await guard(principal, "reports.manage", async (_tx, p) => p);
        const spec = reportSpecSchema.parse(rawSpec);
        const hash = specHash(spec);
        const out = await customRun(live, spec, hash, null, "custom", REPORT_LIMITS.screenRows);
        await recordRun(live, { dataset: spec.dataset, kind: "preview", spec_hash: hash, filter_ops: filterShape(spec) }, out.rowCount);
        return { columns: out.compiled.columns, rows: out.rows, rowCount: out.rowCount, truncated: out.truncated, chart: spec.chart, specHash: hash, generatedAt: clock.now().toISOString() };
      },

      async run(principal: SessionPrincipal, definitionId: string): Promise<CustomResult> {
        const { live, row } = await guard(principal, "reports.manage", async (tx, p) => ({ live: p, row: await loadVisible(tx, p, definitionId) }));
        const spec = reportSpecSchema.parse(row.spec);
        const out = await customRun(live, spec, row.specHash, row, "custom", REPORT_LIMITS.screenRows);
        await recordRun(live, { dataset: spec.dataset, kind: "custom", definition_public_id: row.publicId, spec_hash: row.specHash, filter_ops: filterShape(spec) }, out.rowCount);
        return { columns: out.compiled.columns, rows: out.rows, rowCount: out.rowCount, truncated: out.truncated, chart: spec.chart, specHash: row.specHash, generatedAt: clock.now().toISOString() };
      },

      async export(principal: SessionPrincipal, definitionId: string): Promise<CsvResult> {
        const { live, row } = await guard(principal, "reports.export", async (tx, p) => {
          if (!roleHasCapability(p.role, "reports.manage")) throw forbidden("CAPABILITY_NOT_GRANTED");
          return { live: p, row: await loadVisible(tx, p, definitionId) };
        });
        const spec = reportSpecSchema.parse(row.spec);
        const compiled = compileSpec(spec, { includePersonal: includePersonal(live) });
        const limit = Math.min(spec.limit, REPORT_LIMITS.csvRows);
        // Streamed in pages: server memory holds one page plus the (byte-capped) CSV text, never the full result.
        const out = await inSlot(live, "export", spec.dataset, row.specHash, row.id, async (tx, deadline) => {
          const writer = createCsvWriter(compiled.columns);
          let offset = 0;
          let more = false;
          while (offset < limit && !writer.full) {
            deadline();
            const want = Math.min(EXPORT_PAGE_ROWS, limit - offset);
            const page = await compiled.fetchPage(tx, offset + want >= limit ? want + 1 : want, offset);
            const rows = page.slice(0, want);
            for (const cells of rows) if (!writer.push(cells)) break;
            offset += rows.length;
            if (page.length < want) break;
            if (page.length > want) { more = true; break; }
          }
          const result = writer.finish();
          return { ...result, truncated: result.truncated || more };
        });
        await recordRun(live, {
          dataset: spec.dataset, kind: "custom", definition_public_id: row.publicId, spec_hash: row.specHash, filter_ops: filterShape(spec), truncated: out.truncated,
        }, out.rowCount, "report.exported", "export");
        return {
          filename: `report-${row.publicId}-${clock.now().toISOString().slice(0, 10)}.csv`, contentType: "text/csv; charset=utf-8",
          csv: out.csv, rowCount: out.rowCount, truncated: out.truncated, specHash: row.specHash,
        };
      },
    },

    /** Job body: deletes finished run-log rows older than the retention period. */
    async purgeRuns(): Promise<number> {
      const before = new Date(clock.now().getTime() - RUN_RETENTION_DAYS * 86_400_000);
      const result = await db.delete(reportRuns).where(and(lt(reportRuns.startedAt, before), isNotNull(reportRuns.finishedAt)));
      return Number((result as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0);
    },
  };
}

export type ReportsService = ReturnType<typeof createReportsService>;
