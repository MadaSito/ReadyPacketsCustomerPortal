import { and, asc, count, desc, eq, gte, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { roleHasCapability } from "../../../shared/capabilities.js";
import type { ModuleDeps } from "../../container.js";
import { conflict, DomainError, notFound, validation } from "../../core/errors.js";
import type { ModuleHealth, SessionPrincipal, Tx } from "../../core/types.js";
import { jobAttempts, jobRuns } from "../jobs/schema.js";
import { COPY_KINDS, COPY_STATES, type CopyState } from "./copyLogTypes.js";
import { storageConnections, storageCopyAttempts as attempts } from "./schema.js";
import { storagePublicId } from "./validation.js";

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
const CSV_LIMIT = 1_000;
const filterFields = {
  kind: z.enum(COPY_KINDS).optional(),
  state: z.enum(COPY_STATES).optional(),
  connectionPublicId: storagePublicId.optional(),
  from: z.iso.datetime().optional(),
  through: z.iso.datetime().optional(),
  text: z.string().trim().min(1).max(96).optional(),
};
export const copyLogFilters = z.strictObject(filterFields);
// tRPC's infinite-query integration adds a direction field even to the first page.
const forwardPage = { cursor: storagePublicId.optional(), direction: z.literal("forward").optional() };
export const copyLogList = z.strictObject({
  ...filterFields, ...forwardPage, limit: z.number().int().min(1).max(100).optional(),
});
export const copyLogDetail = z.strictObject({ publicId: storagePublicId });
export const copyLogConnections = z.strictObject(forwardPage);
type Filters = z.infer<typeof copyLogFilters>;

// Interrupted workers may not be able to commit an owner outcome. Use the durable queue's
// state only to report an unconfirmed write; queue completion is never proof of a copy.
const firstAttemptWithoutJobHistory = sql`${jobAttempts.jobId} is null and ${attempts.attempt} = 1 and ${jobRuns.attempt} <= 1`;
const state = sql<CopyState>`case
  when ${attempts.state} <> 'queued' then ${attempts.state}
  when ${jobAttempts.state} = 'canceled' or (${firstAttemptWithoutJobHistory} and ${jobRuns.state} = 'canceled')
    then 'not_written'
  when ${jobAttempts.state} in ('failed', 'unknown', 'interrupted', 'completed')
    or (${firstAttemptWithoutJobHistory} and ${jobRuns.state} in ('failed', 'unknown', 'completed')) then 'failed'
  else 'queued' end`;
const errorCode = sql<string | null>`case
  when ${attempts.state} <> 'queued' then ${attempts.errorCode}
  when ${jobAttempts.state} = 'canceled' or (${firstAttemptWithoutJobHistory} and ${jobRuns.state} = 'canceled') then 'COPY_CANCELED'
  when ${jobAttempts.state} = 'interrupted' then 'COPY_ATTEMPT_INTERRUPTED'
  when ${jobAttempts.state} in ('failed', 'unknown', 'completed')
    or (${firstAttemptWithoutJobHistory} and ${jobRuns.state} in ('failed', 'unknown', 'completed')) then 'COPY_OUTCOME_UNRECORDED'
  else null end`;
const correlation = sql<string | null>`coalesce(${attempts.correlationId}, ${jobRuns.correlationId})`;
const startedAt = sql<Date | null>`coalesce(${attempts.startedAt}, ${jobAttempts.startedAt})`.mapWith(attempts.startedAt);
const finishedAt = sql<Date | null>`coalesce(${attempts.finishedAt}, ${jobAttempts.finishedAt}, case
  when ${firstAttemptWithoutJobHistory} and ${jobRuns.state} in ('canceled', 'failed', 'unknown', 'completed')
    then ${jobRuns.updatedAt} else null end)`.mapWith(attempts.finishedAt);

const fields = {
  id: attempts.id,
  publicId: attempts.publicId,
  kind: attempts.kind,
  sourcePublicId: attempts.sourcePublicId,
  connectionPublicId: attempts.connectionPublicId,
  connectionName: storageConnections.name,
  provider: storageConnections.kind,
  jobPublicId: attempts.jobPublicId,
  attempt: attempts.attempt,
  correlationId: correlation,
  bytes: attempts.bytes,
  state,
  verification: attempts.verification,
  errorCode,
  startedAt,
  finishedAt,
  createdAt: attempts.createdAt,
};

function loggedRows(tx: Tx, where: SQL | undefined, limit: number) {
  return tx.select(fields).from(attempts)
    .leftJoin(storageConnections, eq(storageConnections.publicId, attempts.connectionPublicId))
    .leftJoin(jobRuns, eq(jobRuns.publicId, attempts.jobPublicId))
    .leftJoin(jobAttempts, and(eq(jobAttempts.jobId, jobRuns.id), eq(jobAttempts.attempt, attempts.attempt)))
    .where(where).orderBy(desc(attempts.createdAt), desc(attempts.id)).limit(limit);
}
type Row = Awaited<ReturnType<typeof loggedRows>>[number];

function view({ id: _id, ...row }: Row) {
  return { ...row, verified: row.state === "verified" };
}

function conditions(filters: Filters, now: Date) {
  const through = filters.through ? new Date(filters.through) : now;
  const from = filters.from ? new Date(filters.from) : new Date(through.getTime() - DEFAULT_DAYS * DAY_MS);
  const span = through.getTime() - from.getTime();
  if (!Number.isFinite(span) || span < 0 || span > MAX_DAYS * DAY_MS) {
    throw validation("COPY_LOG_DATE_RANGE", "Choose a valid date range of no more than 90 days.");
  }
  const text = filters.text;
  return and(
    gte(attempts.createdAt, from), lte(attempts.createdAt, through),
    filters.kind ? eq(attempts.kind, filters.kind) : undefined,
    filters.state ? eq(state, filters.state) : undefined,
    filters.connectionPublicId ? eq(attempts.connectionPublicId, filters.connectionPublicId) : undefined,
    text ? or(...[attempts.sourcePublicId, attempts.connectionPublicId, correlation, storageConnections.name, errorCode]
      .map((column) => sql`locate(${text}, ${column}) > 0`)) : undefined,
  );
}

/** Quoted RFC 4180 fields, with spreadsheet formulas neutralized including after whitespace. */
export function safeCopyCsvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  const neutral = /^\s*[=+@＝＋－＠-]/u.test(text) || /^[\t\r\n]/u.test(text) ? `'${text}` : text;
  return `"${neutral.replace(/"/g, '""')}"`;
}

function csv(rows: Row[]): string {
  const columns = ["queued_at_utc", "started_at_utc", "finished_at_utc", "source_kind", "source_id", "connection_id",
    "connection_name", "provider", "bytes", "state", "verified", "verification", "attempt", "error_code", "correlation_id", "job_id"];
  return [columns.join(","), ...rows.map((row) => [
    row.createdAt.toISOString(), row.startedAt?.toISOString() ?? null, row.finishedAt?.toISOString() ?? null,
    row.kind, row.sourcePublicId, row.connectionPublicId, row.connectionName, row.provider, row.bytes,
    row.state, row.state === "verified" ? "yes" : "no", row.verification, row.attempt, row.errorCode,
    row.correlationId, row.jobPublicId,
  ].map(safeCopyCsvCell).join(","))].join("\r\n") + "\r\n";
}

export function createCopyLogService(deps: ModuleDeps) {
  const { db, clock, audit, services } = deps;

  async function read<T>(principal: SessionPrincipal, fn: (tx: Tx) => Promise<T>) {
    if (principal.state !== "full" || principal.role !== "admin" || !roleHasCapability(principal.role, "storage.copies.read")) {
      throw new DomainError("FORBIDDEN", "COPY_LOG_DENIED", "You cannot read the storage copy log.");
    }
    return db.transaction(async (tx) => {
      const live = await services.identity.sessions.assertCurrent(principal, tx);
      if (live.role !== "admin" || live.pendingSteps.length !== 0 || !roleHasCapability(live.role, "storage.copies.read")) {
        throw new DomainError("FORBIDDEN", "COPY_LOG_DENIED", "You cannot read the storage copy log.");
      }
      return fn(tx);
    });
  }

  async function lookup(tx: Tx, publicId: string) {
    const [row] = await loggedRows(tx, eq(attempts.publicId, publicId), 1);
    if (!row) throw notFound("COPY_ATTEMPT_NOT_FOUND");
    return row;
  }

  async function canRetry(tx: Tx, row: Row): Promise<boolean> {
    if (row.kind !== "backup_archive" || row.state !== "failed") return false;
    return services.backup.mayRetryOffsiteCopy({
      backupPublicId: row.sourcePublicId,
      connectionPublicId: row.connectionPublicId,
      jobPublicId: row.jobPublicId,
    }, tx);
  }

  return {
    async list(principal: SessionPrincipal, input: z.infer<typeof copyLogList>) {
      const filters = conditions(input, clock.now());
      return read(principal, async (tx) => {
        const cursor = input.cursor ? await lookup(tx, input.cursor) : null;
        const limit = input.limit ?? 40;
        const rows = await loggedRows(tx, and(filters, cursor ? or(lt(attempts.createdAt, cursor.createdAt),
          and(eq(attempts.createdAt, cursor.createdAt), lt(attempts.id, cursor.id))) : undefined), limit + 1);
        const counts = await tx.select({ state: state.as("state_key"), total: count() }).from(attempts)
          .leftJoin(storageConnections, eq(storageConnections.publicId, attempts.connectionPublicId))
          .leftJoin(jobRuns, eq(jobRuns.publicId, attempts.jobPublicId))
          .leftJoin(jobAttempts, and(eq(jobAttempts.jobId, jobRuns.id), eq(jobAttempts.attempt, attempts.attempt)))
          .where(filters).groupBy(sql`state_key`);
        const totals: Record<CopyState, number> = { queued: 0, written: 0, verified: 0, failed: 0, not_written: 0 };
        for (const row of counts) totals[row.state] = row.total;
        const page = rows.slice(0, limit);
        return { items: page.map(view), nextCursor: rows.length > limit ? (page.at(-1)?.publicId ?? null) : null, totals };
      });
    },
    detail(principal: SessionPrincipal, input: z.infer<typeof copyLogDetail>) {
      return read(principal, async (tx) => {
        const row = await lookup(tx, input.publicId);
        return { ...view(row), canRetry: await canRetry(tx, row) };
      });
    },
    connections(principal: SessionPrincipal, input: z.infer<typeof copyLogConnections>) {
      return read(principal, async (tx) => {
        const rows = await tx.select({ publicId: storageConnections.publicId, name: storageConnections.name })
          .from(storageConnections).where(input.cursor ? sql`${storageConnections.publicId} > ${input.cursor}` : undefined)
          .orderBy(asc(storageConnections.publicId)).limit(101);
        return { items: rows.slice(0, 100), nextCursor: rows.length > 100 ? (rows[99]?.publicId ?? null) : null };
      });
    },
    exportCsv(principal: SessionPrincipal, filters: Filters) {
      return read(principal, async (tx) => {
        const rows = await loggedRows(tx, conditions(filters, clock.now()), CSV_LIMIT + 1);
        const page = rows.slice(0, CSV_LIMIT);
        await audit.record({
          category: "admin", eventName: "storage.copy_log.exported", action: "export", outcome: "completed",
          actor: { role: principal.role, userId: principal.userId }, safeCounts: { rows: page.length },
        }, tx);
        return { csv: csv(page), count: page.length, truncated: rows.length > CSV_LIMIT };
      });
    },
    async retry(principal: SessionPrincipal, input: z.infer<typeof copyLogDetail>) {
      const row = await read(principal, async (tx) => {
        const item = await lookup(tx, input.publicId);
        if (!(await canRetry(tx, item))) throw conflict("COPY_RETRY_UNAVAILABLE", "This copy attempt cannot be retried here.");
        return item;
      });
      const result = await services.backup.copyOffsiteNow(principal, {
        backupPublicId: row.sourcePublicId, connectionPublicId: row.connectionPublicId, expectedFailedJobId: row.jobPublicId,
      });
      return { queued: result.queued.length };
    },
  };
}

/** A non-gating, indexed signal for recent failed copy attempts; no remote probe. */
export async function copyLogHealth(deps: ModuleDeps): Promise<ModuleHealth> {
  const checkedAt = deps.clock.now();
  const recent = new Date(checkedAt.getTime() - DAY_MS);
  const [failure] = await deps.db.select({ id: attempts.id }).from(attempts)
    .leftJoin(jobRuns, eq(jobRuns.publicId, attempts.jobPublicId))
    .leftJoin(jobAttempts, and(eq(jobAttempts.jobId, jobRuns.id), eq(jobAttempts.attempt, attempts.attempt)))
    .where(and(or(eq(attempts.state, "failed"), eq(attempts.state, "queued")),
      gte(attempts.createdAt, recent), eq(state, "failed"))).limit(1);
  return { component: "storage.copies", state: failure ? "degraded" : "ok", checkedAt,
    summary: failure ? "Copies failing: at least one attempt logged in the last 24 hours failed or could not be confirmed." :
      "No failures or unconfirmed outcomes among copy attempts logged in the last 24 hours." };
}

export type CopyLogService = ReturnType<typeof createCopyLogService>;
