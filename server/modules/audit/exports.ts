/**
 * Evidence exports: request (audited, step-up) → job streams pages into private object storage →
 * download through the hardened private-download helper (audited, requester only, expiring).
 * Owner: audit engineer.
 */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { and, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { conflict, notFound } from "../../core/errors.js";
import { ulid, ULID_PATTERN } from "../../core/ids.js";
import type { ClaimedJob, Db, JobResult, SessionPrincipal } from "../../core/types.js";
import { actorOf, assertActorCurrent, assertAuditCapability, type AuditCtx } from "./access.js";
import { AUDIT_SCHEMA_VERSION } from "./envelope.js";
import { CONTENT_TYPES, csvHeader, encodeRecord, exportRecord, type ExportFormat, type ExportProfile } from "./formats.js";
import { afterCursor, compileQuery, encodeCursor, ORDER_NEWEST_FIRST, type AuditQuery } from "./query.js";
import { rowToEnvelope } from "./rows.js";
import { auditChain, auditEvents, auditExports, auditTombstones } from "./schema.js";

export const EXPORT_JOB = "audit.export.generate";
export const MAX_EXPORT_ROWS = 100_000;
export const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
export const EXPORT_TTL_MS = 7 * 86_400_000;
export const MAX_ACTIVE_EXPORTS_PER_USER = 3;
const PAGE = 500;

export interface ExportView {
  id: string;
  format: ExportFormat;
  profile: ExportProfile;
  status: "queued" | "running" | "completed" | "failed" | "canceled" | "unknown";
  reasonCode: string | null;
  rowCount: number | null;
  byteSize: number | null;
  sha256: string | null;
  truncated: boolean;
  query: AuditQuery;
  manifest: ExportManifest | null;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  downloadCount: number;
}

export interface ExportManifest {
  manifest_version: "rp.audit.export/1";
  export_id: string;
  schema_version: string;
  format: ExportFormat;
  profile: ExportProfile;
  filter: AuditQuery;
  row_count: number;
  byte_size: number;
  sha256: string;
  truncated: boolean;
  max_rows: number;
  /** Evidence snapshot: only events sealed at or below this chain seq and occurred at or before `snapshot_cutoff`. */
  chain_head_seq: number;
  snapshot_cutoff: string;
  /**
   * All pages are read inside ONE read-only REPEATABLE READ transaction with a consistent snapshot (InnoDB MVCC):
   * retention or any delete committed after the snapshot started cannot remove rows from the export, and
   * concurrent inserts are excluded by `chain_head_seq`/`snapshot_cutoff`. "complete" therefore means "every
   * matching event present in the store at snapshot time"; events removed by retention BEFORE the snapshot are
   * absent and reported (unfiltered, by time window) in `retention_removed_in_window`.
   */
  completeness: "complete" | "truncated";
  snapshot_isolation: "repeatable_read_consistent_snapshot";
  /** Tombstones (authenticated retention removals) with occurred_at in the query window and seq ≤ head. They may or may not have matched the filter. */
  retention_removed_in_window: number;
  installation_ref: string;
  generated_at: string;
  order: "occurred_at desc, event_id desc";
}

interface StoredQuery {
  query: AuditQuery;
  profile: ExportProfile;
}

function toView(ctx: AuditCtx, row: typeof auditExports.$inferSelect): ExportView {
  const stored = row.query as StoredQuery;
  const now = ctx.deps.clock.now().getTime();
  return {
    id: row.publicId,
    format: row.format as ExportFormat,
    profile: stored.profile,
    status: row.status as ExportView["status"],
    reasonCode: row.reasonCode,
    rowCount: row.rowCount,
    byteSize: row.byteSize,
    sha256: row.sha256,
    truncated: row.truncated,
    query: stored.query,
    manifest: (row.manifest as ExportManifest | null) ?? null,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    expired: row.expiresAt !== null && row.expiresAt.getTime() <= now,
    downloadCount: row.downloadCount,
  };
}

export async function requestExport(
  ctx: AuditCtx,
  principal: SessionPrincipal,
  input: { format: ExportFormat; profile: ExportProfile; query: AuditQuery },
): Promise<{ id: string }> {
  assertAuditCapability(ctx, principal, "audit.export");
  compileQuery(input.query);
  const publicId = ulid(ctx.deps.clock.now().getTime());
  await ctx.deps.db.transaction(async (tx) => {
    await assertActorCurrent(ctx, principal, tx, "audit.export");
    const active = await tx
      .select({ id: auditExports.id })
      .from(auditExports)
      .where(and(eq(auditExports.requestedBy, principal.userId), inArray(auditExports.status, ["queued", "running"])))
      .for("update");
    if (active.length >= MAX_ACTIVE_EXPORTS_PER_USER) throw conflict("EXPORT_LIMIT", "Wait for your running exports to finish before starting another.");
    const stored: StoredQuery = { query: input.query, profile: input.profile };
    await tx.insert(auditExports).values({ publicId, requestedBy: principal.userId, format: input.format, query: stored, status: "queued" });
    const { jobId } = await ctx.deps.jobs.enqueue(EXPORT_JOB, { exportId: publicId }, { idempotencyKey: `audit-export:${publicId}`, correlationId: publicId, maxAttempts: 3 }, tx);
    await tx.update(auditExports).set({ jobId }).where(eq(auditExports.publicId, publicId));
    await ctx.deps.audit.record(
      {
        category: "security",
        eventName: "audit.export.requested",
        action: "export",
        outcome: "attempted",
        severity: "WARN",
        actor: actorOf(principal),
        resource: { type: "audit_export", publicId },
        correlationId: publicId,
        jobId,
        attributes: { format: input.format, profile: input.profile },
      },
      tx,
    );
  });
  return { id: publicId };
}

export async function listExports(ctx: AuditCtx, principal: SessionPrincipal): Promise<ExportView[]> {
  assertAuditCapability(ctx, principal, "audit.export");
  const rows = await ctx.deps.db.select().from(auditExports).where(eq(auditExports.requestedBy, principal.userId)).orderBy(desc(auditExports.id)).limit(50);
  return rows.map((row) => toView(ctx, row));
}

/** Streams pages of the query as encoded lines; stops at MAX_EXPORT_ROWS. */
async function* encodedRows(
  ctx: AuditCtx,
  reader: Db,
  query: AuditQuery,
  format: ExportFormat,
  profile: ExportProfile,
  state: { rows: number; truncated: boolean },
  snapshot: { headSeq: number; cutoff: Date },
  job?: ClaimedJob<unknown>,
) {
  const compiled = compileQuery(query);
  if (format === "csv") yield csvHeader(profile);
  let cursor: string | null = null;
  for (;;) {
    if (job?.signal.aborted) throw new Error("EXPORT_CANCELED");
    const rows = await reader
      .select({ event: auditEvents, seq: auditChain.seq })
      .from(auditEvents)
      .innerJoin(auditChain, eq(auditChain.eventRowId, auditEvents.id))
      .where(and(compiled.where, afterCursor(cursor), lte(auditChain.seq, snapshot.headSeq), lte(auditEvents.occurredAt, snapshot.cutoff)))
      .orderBy(...ORDER_NEWEST_FIRST)
      .limit(PAGE);
    let chunk = "";
    for (const row of rows) {
      if (state.rows >= MAX_EXPORT_ROWS) {
        state.truncated = true;
        break;
      }
      chunk += encodeRecord(format, exportRecord(rowToEnvelope(row.event, row.seq ?? null), profile), profile, ctx.deps.config.releaseRef);
      state.rows += 1;
    }
    if (chunk) yield chunk;
    if (state.truncated || rows.length < PAGE) return;
    const last = rows[rows.length - 1]!;
    cursor = encodeCursor(last.event.occurredAt, last.event.eventId);
  }
}

export async function generateExport(ctx: AuditCtx, job: ClaimedJob<{ exportId?: unknown }>): Promise<JobResult> {
  const exportId = typeof job.payload?.exportId === "string" && ULID_PATTERN.test(job.payload.exportId) ? job.payload.exportId : null;
  if (!exportId) return { outcome: "failed", reasonCode: "EXPORT_PAYLOAD_INVALID", retryable: false };
  const [row] = await ctx.deps.db.select().from(auditExports).where(eq(auditExports.publicId, exportId));
  if (!row) return { outcome: "failed", reasonCode: "EXPORT_NOT_FOUND", retryable: false };
  if (row.status === "completed") return { outcome: "completed" };
  if (row.status === "failed" || row.status === "canceled") return { outcome: "canceled", reasonCode: "EXPORT_ALREADY_FINAL" };
  const stored = row.query as StoredQuery;
  const format = row.format as ExportFormat;
  // Zero trust: re-derive the requester's CURRENT standing; never trust the stored id + an assumed role.
  const requester = await ctx.deps.services.identity.getUser(row.requestedBy);
  if (!requester || requester.role !== "admin" || requester.status !== "active") {
    await ctx.deps.db.transaction(async (tx) => {
      await job.assertStillOwned(tx);
      await tx.update(auditExports).set({ status: "canceled", reasonCode: "EXPORT_REQUESTER_INELIGIBLE", completedAt: ctx.deps.clock.now() }).where(eq(auditExports.id, row.id));
      await ctx.deps.audit.record(
        { category: "security", eventName: "audit.export.failed", action: "export", outcome: "canceled", reasonCode: "EXPORT_REQUESTER_INELIGIBLE", actor: { role: "system" }, resource: { type: "audit_export", publicId: exportId }, correlationId: exportId, jobId: job.jobId },
        tx,
      );
    });
    return { outcome: "canceled", reasonCode: "EXPORT_REQUESTER_INELIGIBLE" };
  }
  const actor = { userId: requester.id, role: requester.role };
  // Fix the evidence set before scanning: seal what is pending, then pin head seq + time cutoff.
  await ctx.chain.sealPending();
  const startHead = await ctx.chain.head();
  const snapshot = { headSeq: startHead.headSeq, cutoff: ctx.deps.clock.now() };
  await ctx.deps.db.transaction(async (tx) => {
    await job.assertStillOwned(tx);
    await tx.update(auditExports).set({ status: "running" }).where(eq(auditExports.id, row.id));
  });
  const key = ctx.deps.storage.newKey("exports");
  const state = { rows: 0, truncated: false };
  try {
    const hash = createHash("sha256");
    // One consistent snapshot (SELECT-only) for every page and the tombstone count (no other DB access inside it).
    const { info, retentionRemoved } = await ctx.deps.db.transaction(
      async (snap) => {
        const reader = snap as unknown as Db;
        const source = Readable.from(
          (async function* () {
            for await (const chunk of encodedRows(ctx, reader, stored.query, format, stored.profile, state, snapshot, job)) {
              const buf = Buffer.from(chunk, "utf8");
              hash.update(buf);
              yield buf;
            }
          })(),
        );
        const put = await ctx.deps.storage.put(key, source, { maxBytes: MAX_EXPORT_BYTES });
        const window = compileQuery(stored.query);
        const [tombs] = await reader
          .select({ n: sql<number>`count(*)` })
          .from(auditTombstones)
          .where(and(gte(auditTombstones.occurredAt, window.from), lt(auditTombstones.occurredAt, window.to), lte(auditTombstones.seq, snapshot.headSeq)));
        return { info: put, retentionRemoved: Number(tombs?.n ?? 0) };
      },
      // accessMode "read only" is not combined: drizzle emits "with consistent snapshot read only" (missing comma,
      // ER_PARSE_ERROR on MySQL 8). The callback issues only SELECTs.
      { isolationLevel: "repeatable read", withConsistentSnapshot: true },
    );
    const manifest: ExportManifest = {
      manifest_version: "rp.audit.export/1",
      export_id: exportId,
      schema_version: AUDIT_SCHEMA_VERSION,
      format,
      profile: stored.profile,
      filter: stored.query,
      row_count: state.rows,
      byte_size: info.size,
      sha256: info.sha256 || hash.digest("hex"),
      truncated: state.truncated,
      max_rows: MAX_EXPORT_ROWS,
      chain_head_seq: snapshot.headSeq,
      snapshot_cutoff: snapshot.cutoff.toISOString(),
      completeness: state.truncated ? "truncated" : "complete",
      snapshot_isolation: "repeatable_read_consistent_snapshot",
      retention_removed_in_window: retentionRemoved,
      installation_ref: ctx.deps.config.installationId,
      generated_at: ctx.deps.clock.now().toISOString(),
      order: "occurred_at desc, event_id desc",
    };
    try {
      await ctx.deps.db.transaction(async (tx) => {
        await job.assertStillOwned(tx);
        await tx
          .update(auditExports)
          .set({
            status: "completed",
            objectKey: key,
            rowCount: state.rows,
            byteSize: info.size,
            sha256: manifest.sha256,
            manifest,
            truncated: state.truncated,
            completedAt: ctx.deps.clock.now(),
            expiresAt: new Date(ctx.deps.clock.now().getTime() + EXPORT_TTL_MS),
          })
          .where(eq(auditExports.id, row.id));
        await ctx.deps.audit.record(
          {
            category: "security",
            eventName: "audit.export.completed",
            action: "export",
            outcome: "completed",
            actor,
            resource: { type: "audit_export", publicId: exportId },
            correlationId: exportId,
            jobId: job.jobId,
            attributes: { format, profile: stored.profile, truncated: state.truncated, export_sha256: manifest.sha256 },
            safeCounts: { rows: state.rows, bytes: info.size },
          },
          tx,
        );
      });
    } catch (error) {
      await ctx.deps.storage.delete(key).catch(() => undefined);
      throw error;
    }
    return { outcome: "completed", safeCounts: { rows: state.rows } };
  } catch (error) {
    await ctx.deps.storage.delete(key).catch(() => undefined);
    const reasonCode = error instanceof Error && error.message === "OBJECT_TOO_LARGE" ? "EXPORT_TOO_LARGE" : error instanceof Error && error.message === "EXPORT_CANCELED" ? "EXPORT_CANCELED" : "EXPORT_FAILED";
    ctx.deps.logger.error("audit export failed", { export_id: exportId, reason_code: reasonCode, error });
    try {
      await ctx.deps.db.transaction(async (tx) => {
        await job.assertStillOwned(tx);
        await tx.update(auditExports).set({ status: reasonCode === "EXPORT_CANCELED" ? "canceled" : "failed", reasonCode, completedAt: ctx.deps.clock.now() }).where(eq(auditExports.id, row.id));
        await ctx.deps.audit.record(
          { category: "security", eventName: "audit.export.failed", action: "export", outcome: reasonCode === "EXPORT_CANCELED" ? "canceled" : "failed", reasonCode, actor, resource: { type: "audit_export", publicId: exportId }, correlationId: exportId, jobId: job.jobId },
          tx,
        );
      });
    } catch {
      // The row stays `running`; the job framework records the failure and an operator sees it as stuck.
      return { outcome: "unknown", reasonCode: "EXPORT_STATE_UNRECORDED" };
    }
    return reasonCode === "EXPORT_CANCELED" ? { outcome: "canceled", reasonCode } : { outcome: "failed", reasonCode, retryable: false };
  }
}

export async function openExportDownload(
  ctx: AuditCtx,
  principal: SessionPrincipal,
  exportId: string,
): Promise<{ stream: Readable; filename: string; contentType: string; size: number }> {
  assertAuditCapability(ctx, principal, "audit.export");
  if (!ULID_PATTERN.test(exportId)) throw notFound("AUDIT_EXPORT_NOT_FOUND");
  const [row] = await ctx.deps.db.select().from(auditExports).where(eq(auditExports.publicId, exportId));
  // Requester-only (zero trust): another admin's export is reported as not found.
  if (!row || row.requestedBy !== principal.userId) throw notFound("AUDIT_EXPORT_NOT_FOUND");
  if (row.status !== "completed" || !row.objectKey) throw conflict("EXPORT_NOT_READY", "This export is not ready to download.");
  if (row.expiresAt && row.expiresAt.getTime() <= ctx.deps.clock.now().getTime()) throw conflict("EXPORT_EXPIRED", "This export has expired. Please request a new one.");
  // Open the object first so a missing object never produces an "attempted" row for bytes that cannot exist.
  const stream = await ctx.deps.storage.get(row.objectKey);
  try {
    // Durable ATTEMPT before any byte is sent; the truthful result is recorded by recordDownloadResult.
    await ctx.deps.db.transaction(async (tx) => {
      await tx.update(auditExports).set({ downloadCount: sql`${auditExports.downloadCount} + 1` }).where(eq(auditExports.id, row.id));
      await ctx.deps.audit.record(
        { category: "security", eventName: "audit.export.download_attempted", action: "download", outcome: "attempted", severity: "WARN", actor: actorOf(principal), resource: { type: "audit_export", publicId: exportId }, correlationId: exportId, attributes: { export_sha256: row.sha256 } },
        tx,
      );
    });
  } catch (error) {
    stream.destroy();
    throw error;
  }
  const ext = row.format === "jsonl" ? "jsonl" : row.format === "csv" ? "csv" : "cef.txt";
  return { stream, filename: `audit-export-${exportId}.${ext}`, contentType: CONTENT_TYPES[row.format as ExportFormat], size: row.byteSize ?? 0 };
}

/** Truthful post-transfer result: completed only when the stream finished; otherwise failed/unknown. */
export async function recordDownloadResult(ctx: AuditCtx, principal: SessionPrincipal, exportId: string, outcome: "completed" | "failed" | "unknown"): Promise<void> {
  await ctx.deps.audit.record({
    category: "security",
    eventName: "audit.export.downloaded",
    action: "download",
    outcome,
    severity: outcome === "completed" ? "WARN" : "ERROR",
    reasonCode: outcome === "completed" ? undefined : outcome === "failed" ? "DOWNLOAD_FAILED" : "DOWNLOAD_INTERRUPTED",
    actor: actorOf(principal),
    resource: { type: "audit_export", publicId: exportId },
    correlationId: exportId,
  });
}
