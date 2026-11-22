import { and, count, desc, eq, inArray, lt, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { z } from "zod";
import { roleHasCapability } from "../../../shared/capabilities.js";
import type { ModuleDeps } from "../../container.js";
import { conflict, DomainError, notFound } from "../../core/errors.js";
import type { SessionPrincipal, Tx } from "../../core/types.js";
import { isAutomationOrigin } from "../audit/tap.js";
import { jobAttempts, jobRuns } from "../jobs/schema.js";
import type { CopyState } from "./copyLogTypes.js";
import { copyAttemptPrivateAad, recordCopyAttempt } from "./copyLogWriter.js";
import { ORDER_FILE_COPY_JOB, ORDER_FILE_COPY_MAX_ATTEMPTS, safeManualCopyRetry } from "./fileCopies.js";
import { storageAssignments, storageConnections, storageCopyAttempts as attempt, storageFileCopies } from "./schema.js";
import { storagePublicId } from "./validation.js";

export const orderCopyList = z.strictObject({
  orderPublicId: storagePublicId,
  cursor: storagePublicId.optional(),
  direction: z.literal("forward").optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export const orderCopyRetry = z.strictObject({ orderPublicId: storagePublicId, publicId: storagePublicId });

type TransferState = CopyState | "copying";
const newer = alias(attempt, "newer_copy_attempt");
const latest = (tx: Tx, orderPublicId: string) => and(eq(attempt.orderPublicId, orderPublicId), eq(attempt.kind, "order_file"),
  notExists(tx.select({ id: newer.id }).from(newer).where(and(
    eq(newer.kind, "order_file"), eq(newer.orderPublicId, orderPublicId), eq(newer.sourcePublicId, attempt.sourcePublicId),
    eq(newer.connectionPublicId, attempt.connectionPublicId), sql`${newer.id} > ${attempt.id}`,
  ))));
const state = sql<TransferState>`case
  when ${jobRuns.state} = 'queued' and ${attempt.state} in ('failed', 'queued') then 'queued'
  when ${attempt.state} <> 'queued' then ${attempt.state}
  when ${jobRuns.state} = 'canceled' or ${jobAttempts.state} = 'canceled' then 'not_written'
  when ${jobRuns.state} in ('failed','unknown','completed') or ${jobAttempts.state} in ('unknown','failed','interrupted','completed') then 'failed'
  when ${jobRuns.state} = 'running' or ${attempt.startedAt} is not null then 'copying'
  else 'queued' end`;

const rows = (tx: Tx) => tx.select({
  id: attempt.id, publicId: attempt.publicId, filePublicId: attempt.sourcePublicId, connectionPublicId: attempt.connectionPublicId,
  connectionName: storageConnections.name, provider: storageConnections.kind, jobPublicId: attempt.jobPublicId, attempt: attempt.attempt,
  correlationId: sql<string | null>`coalesce(${attempt.correlationId}, ${jobRuns.correlationId})`,
  jobState: jobRuns.state, jobAllowsRetry: jobRuns.allowRetry, state, errorCode: attempt.errorCode,
  destinationVersion: storageFileCopies.destinationVersion, activeDestinationVersion: storageConnections.destinationVersion,
  phaseLabelEnc: attempt.phaseLabelEnc, targetPathEnc: attempt.targetPathEnc, createdAt: attempt.createdAt,
  updatedAt: sql<Date>`greatest(
    coalesce(${attempt.finishedAt}, ${jobAttempts.finishedAt}, ${attempt.startedAt}, ${attempt.createdAt}),
    coalesce(${jobRuns.updatedAt}, ${attempt.createdAt}))`.mapWith(attempt.createdAt),
}).from(attempt)
  .leftJoin(storageConnections, eq(storageConnections.publicId, attempt.connectionPublicId))
  .leftJoin(storageFileCopies, and(eq(storageFileCopies.filePublicId, attempt.sourcePublicId),
    eq(storageFileCopies.connectionPublicId, attempt.connectionPublicId)))
  .leftJoin(jobRuns, eq(jobRuns.publicId, attempt.jobPublicId))
  .leftJoin(jobAttempts, and(eq(jobAttempts.jobId, jobRuns.id), eq(jobAttempts.attempt, attempt.attempt)));
type Row = Awaited<ReturnType<typeof rows>>[number];
const retryCandidate = (row: Row) => row.state === "failed" && row.jobState === "failed" && row.jobAllowsRetry === false &&
  row.destinationVersion !== null && row.destinationVersion === row.activeDestinationVersion &&
  row.errorCode !== null && safeManualCopyRetry.has(row.errorCode);

export function createOrderCopies(deps: ModuleDeps, assertDestination: (publicId: string, tx: Tx, version: number) => Promise<unknown>) {
  const { db, clock, audit, services, crypto, jobs, storage } = deps;
  async function authorize(principal: SessionPrincipal, orderPublicId: string, tx: Tx, retry = false) {
    const needed = retry ? "files.manage" : "orders.read_all";
    const denied = () => new DomainError("FORBIDDEN", "ORDER_COPY_DENIED", "You cannot access these order transfers.");
    if (principal.state !== "full" || !roleHasCapability(principal.role, needed)) throw denied();
    const live = await services.identity.sessions.assertCurrent(principal, tx);
    if (live.role !== principal.role || live.pendingSteps.length || !roleHasCapability(live.role, needed)) throw denied();
    await services.orders.assertCanReadOrder(principal, orderPublicId, { tx });
  }
  function label(row: Row, column: "target_path" | "phase_label") {
    const text = column === "target_path" ? row.targetPathEnc : row.phaseLabelEnc;
    if (!text) return null;
    try { return crypto.decrypt(text, copyAttemptPrivateAad(column, row.jobPublicId, row.attempt)); }
    catch { return null; }
  }

  return {
    forOrder(principal: SessionPrincipal, input: z.infer<typeof orderCopyList>) {
      return db.transaction(async (tx) => {
        await authorize(principal, input.orderPublicId, tx);
        const scope = latest(tx, input.orderPublicId);
        const [cursor] = input.cursor ? await rows(tx).where(and(eq(attempt.orderPublicId, input.orderPublicId),
          eq(attempt.kind, "order_file"), eq(attempt.publicId, input.cursor))).limit(1) : [];
        if (input.cursor && !cursor) throw notFound("COPY_ATTEMPT_NOT_FOUND");
        const limit = input.limit ?? 40;
        const found = await rows(tx).where(and(scope, cursor ? or(lt(attempt.createdAt, cursor.createdAt),
          and(eq(attempt.createdAt, cursor.createdAt), lt(attempt.id, cursor.id))) : undefined))
          .orderBy(desc(attempt.createdAt), desc(attempt.id)).limit(limit + 1);
        const page = found.slice(0, limit);
        const counts = await tx.select({ state: state.as("transfer_state_key"), total: count() }).from(attempt)
          .leftJoin(jobRuns, eq(jobRuns.publicId, attempt.jobPublicId))
          .leftJoin(jobAttempts, and(eq(jobAttempts.jobId, jobRuns.id), eq(jobAttempts.attempt, attempt.attempt)))
          .where(scope).groupBy(sql`transfer_state_key`);
        const [assignment] = await tx.select({ ids: storageAssignments.connectionPublicIds }).from(storageAssignments)
          .where(eq(storageAssignments.purpose, "order_files")).limit(1);
        const ids = assignment?.ids ?? [];
        const assigned = ids.length ? await tx.select({ publicId: storageConnections.publicId, kind: storageConnections.kind,
          enabled: storageConnections.enabled }).from(storageConnections).where(inArray(storageConnections.publicId, ids)) : [];
        const enabled = new Set(assigned.filter((row) => row.enabled).map((row) => row.publicId));
        const files = new Map(page.length ? (await services.files.listOrderFileCopyMetadata(
          input.orderPublicId, [...new Set(page.map((row) => row.filePublicId))], tx,
        )).map((file) => [file.filePublicId, file]) : []);
        const totals = { total: 0, synced: 0, inProgress: 0, failed: 0 };
        for (const result of counts) {
          totals.total += result.total;
          if (result.state === "queued" || result.state === "copying") totals.inProgress += result.total;
          else if (result.state === "written" || result.state === "verified") totals.synced += result.total;
          else totals.failed += result.total;
        }
        return {
          totals, hasAssignedConnection: assigned.length > 0,
          hasSharePoint: assigned.some(({ kind }) => kind === "sharepoint" || kind === "onedrive"),
          nextCursor: found.length > limit ? (page.at(-1)?.publicId ?? null) : null,
          items: page.map((row) => {
            const file = files.get(row.filePublicId);
            return {
              publicId: row.publicId, filePublicId: row.filePublicId, fileName: file?.displayName ?? null,
              phase: file ? label(row, "phase_label") : null, state: row.state, connectionPublicId: row.connectionPublicId,
              connectionName: row.connectionName, provider: row.provider, targetPath: file ? label(row, "target_path") : null,
              updatedAt: row.updatedAt,
              canRetry: roleHasCapability(principal.role, "files.manage") && !!file?.sourceAvailable &&
                enabled.has(row.connectionPublicId) && retryCandidate(row),
            };
          }),
        };
      });
    },
    retryOrderFile(principal: SessionPrincipal, input: z.infer<typeof orderCopyRetry>, requestId?: string) {
      return db.transaction(async (tx) => {
        await authorize(principal, input.orderPublicId, tx, true);
        const unavailable = () => conflict("COPY_RETRY_UNAVAILABLE", "This copy attempt cannot be retried.");
        const scope = and(latest(tx, input.orderPublicId), eq(attempt.publicId, input.publicId));
        const [failed] = await rows(tx).where(scope).limit(1);
        if (!failed || !retryCandidate(failed)) throw unavailable();
        // Keep the original job lock ahead of the file and copy locks.
        if (!await services.jobAdmin.canReplaceFailedOutboxJob(failed.jobPublicId, ORDER_FILE_COPY_JOB, tx)) throw unavailable();
        let source;
        try {
          source = await services.files.getOrderFileCopySource(failed.filePublicId, tx);
          if (source.orderPublicId !== input.orderPublicId) throw unavailable();
          if (isAutomationOrigin(failed.correlationId) && (source.visibility !== "customer_visible" || !source.currentVersion)) throw unavailable();
          // Open to prove the local object exists without rehashing large content under the job/order locks.
          // The worker independently verifies size and SHA-256 before trying any remote write.
          (await storage.get(source.storageKey)).destroy();
        } catch { throw unavailable(); }
        const [copy] = await tx.select().from(storageFileCopies).where(and(eq(storageFileCopies.filePublicId, source.filePublicId),
          eq(storageFileCopies.connectionPublicId, failed.connectionPublicId))).limit(1).for("update");
        const [current] = await rows(tx).where(scope).limit(1);
        if (!copy || copy.state !== "failed" || copy.reasonCode !== failed.errorCode || !current) throw unavailable();
        await assertDestination(copy.connectionPublicId, tx, copy.destinationVersion);
        const correlationId = isAutomationOrigin(failed.correlationId) ? (failed.correlationId ?? undefined) : requestId;
        const result = await jobs.enqueue(ORDER_FILE_COPY_JOB, { copyPublicId: copy.publicId }, {
          idempotencyKey: `manual-copy:${failed.publicId}`, maxAttempts: ORDER_FILE_COPY_MAX_ATTEMPTS, correlationId,
        }, tx);
        await tx.update(storageFileCopies).set({ state: "queued", attempts: 0, reasonCode: null, finishedAt: null, updatedAt: clock.now() })
          .where(eq(storageFileCopies.id, copy.id));
        await recordCopyAttempt(deps, { phase: "queued", kind: "order_file", sourcePublicId: copy.filePublicId,
          connectionPublicId: copy.connectionPublicId, jobPublicId: result.jobId, orderPublicId: input.orderPublicId, attempt: 1, correlationId }, tx);
        await audit.record({ category: "file", eventName: "order.file.copy.retry_queued", action: "retry", outcome: "completed",
          actor: { role: principal.role, userId: principal.userId }, orderPublicId: input.orderPublicId,
          resource: { type: "file", publicId: copy.filePublicId }, jobId: result.jobId, correlationId,
          ...(requestId && correlationId !== requestId ? { parentCorrelationId: requestId } : {}),
        }, tx);
        return { queued: true };
      }, { isolationLevel: "read committed" });
    },
  };
}
export type OrderCopiesService = ReturnType<typeof createOrderCopies>;
