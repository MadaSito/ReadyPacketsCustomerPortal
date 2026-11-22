import type { Readable } from "node:stream";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { DEFAULT_ORDER_FILE_FOLDER_TEMPLATE, isResolvedOrderFileFolder, resolveOrderFileFolder, safeOrderFileFolderValue } from "../../../shared/orderFileFolder.js";
import type { ModuleDeps } from "../../container.js";
import { DomainError } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { ClaimedJob, JobResult, Tx } from "../../core/types.js";
import { isAutomationOrigin } from "../audit/tap.js";
import type { StorageModule } from "./contracts.js";
import { copyAttemptPrivateAad, recordCopyAttempt } from "./copyLogWriter.js";
import { storageCopyAttempts, storageFileCopies } from "./schema.js";
import { copySegment, storagePublicId } from "./validation.js";

export const ORDER_FILE_COPY_JOB = "storage.copy_order_file";
export const ORDER_FILE_COPY_MAX_ATTEMPTS = 6;
const payload = z.strictObject({ copyPublicId: storagePublicId });
const encryptedTarget = z.strictObject({ path: z.array(copySegment).min(1).max(8), name: copySegment,
  ownerUserId: z.number().int().positive(), phase: z.string().max(160).nullable().optional() });
const targetAad = (id: string) => `storage_file_copies.target_enc:${id}`;
const remoteAad = (id: string) => `storage_file_copies.remote_id_enc:${id}`;
const localCopyStopped = new Set(["STORAGE_ASSIGNMENT_INACTIVE", "STORAGE_COPY_SOURCE_INACTIVE"]);
const retryable = new Set(["STORAGE_PROVIDER_RETRY", "STORAGE_LOCAL_READ_FAILED"]);
const safeFailure = new Set([...retryable, ...localCopyStopped, "STORAGE_INTEGRITY_MISMATCH",
  "STORAGE_LOCAL_INTEGRITY_MISMATCH", "STORAGE_EGRESS_DENIED", "STORAGE_PROVIDER_DENIED", "STORAGE_PROVIDER_LIMIT",
  "STORAGE_COPY_UNCERTAIN", "STORAGE_FOLDER_INVALID", "AUDIT_WRITE_FAILED"]);
export const safeManualCopyRetry = new Set([...retryable, "STORAGE_LOCAL_INTEGRITY_MISMATCH", "STORAGE_EGRESS_DENIED",
  "STORAGE_FOLDER_INVALID", "STORAGE_PROVIDER_LIMIT"]);

type CopyRow = typeof storageFileCopies.$inferSelect;
type Destination = { publicId: string; destinationVersion: number };
type Job = ClaimedJob<z.infer<typeof payload>>;

export function registerFileCopies(deps: ModuleDeps, service: StorageModule) {
  const { audit, clock, crypto, db, jobs, storage } = deps;
  const currentTx = <T>(run: (tx: Tx) => Promise<T>) => db.transaction(run, { isolationLevel: "read committed" });

  function auditCopy(job: Job, row: CopyRow, outcome: "attempted" | "completed" | "failed" | "refused" | "unknown",
    orderPublicId: string | undefined, reasonCode: string | undefined, tx: Tx) {
    return audit.record({
      category: "file", eventName: `order.file.copy.${outcome}`, action: "copy", outcome, reasonCode, orderPublicId,
      actor: { role: "system" }, jobId: job.jobId, correlationId: job.correlationId,
      resource: { type: "file", publicId: row.filePublicId },
    }, tx);
  }

  jobs.register(ORDER_FILE_COPY_JOB, async (job: Job): Promise<JobResult> => {
    const parsed = payload.safeParse(job.payload);
    if (!parsed.success) return { outcome: "failed", reasonCode: "STORAGE_COPY_INVALID_JOB", retryable: false };
    const [row] = await db.select().from(storageFileCopies)
      .where(eq(storageFileCopies.publicId, parsed.data.copyPublicId)).limit(1);
    if (!row || row.state === "copied" || row.state === "skipped") return { outcome: "completed" };
    const attempt = {
      kind: "order_file" as const, sourcePublicId: row.filePublicId, connectionPublicId: row.connectionPublicId,
      jobPublicId: job.jobId, attempt: job.attempt, correlationId: job.correlationId,
    };
    const automationOrigin = isAutomationOrigin(job.correlationId);
    const automationSourceInactive = (source: { visibility: string; currentVersion: boolean }) =>
      automationOrigin && (source.visibility !== "customer_visible" || !source.currentVersion);
    const sourceInactive = () => new DomainError("NOT_FOUND", "STORAGE_COPY_SOURCE_INACTIVE", "The local copy source is not available.");
    let orderPublicId: string | undefined;
    let body: Readable | undefined;
    try {
      const prepared = await currentTx(async (tx) => {
        await job.assertStillOwned(tx);
        const [bound] = await tx.select({ orderPublicId: storageCopyAttempts.orderPublicId }).from(storageCopyAttempts)
          .where(eq(storageCopyAttempts.jobPublicId, job.jobId)).orderBy(desc(storageCopyAttempts.attempt)).limit(1);
        orderPublicId = bound?.orderPublicId ?? undefined;
        const source = await deps.services.files.getOrderFileCopySource(row.filePublicId, tx);
        if (orderPublicId && orderPublicId !== source.orderPublicId) throw sourceInactive();
        orderPublicId = source.orderPublicId;
        if (automationSourceInactive(source)) throw sourceInactive();
        let target: z.infer<typeof encryptedTarget>;
        try {
          if (row.targetEnc) {
            target = encryptedTarget.parse(JSON.parse(crypto.decrypt(row.targetEnc, targetAad(row.publicId))));
          } else {
            const routing = source.statusKey ? await deps.services.orders.getOrderFileFolderRouting({
              orderPublicId: source.orderPublicId, statusKey: source.statusKey, slotKey: source.slotKey,
            }, tx) : null;
            const phase = routing?.phaseLabel?.slice(0, 160) ?? null;
            const path = resolveOrderFileFolder(routing?.slotTemplate ?? routing?.workflowTemplate ?? DEFAULT_ORDER_FILE_FOLDER_TEMPLATE, {
              customer_ref: source.customerReference, order_ref: source.orderReference, order_name: source.orderName,
              phase: phase ?? "unphased", slot: source.slotKey ?? "unslotted",
              yyyy: String(source.createdAt.getUTCFullYear()).padStart(4, "0"),
              mm: String(source.createdAt.getUTCMonth() + 1).padStart(2, "0"),
            });
            const extension = /^[a-z0-9]{1,12}$/u.test(source.extension) ? source.extension : "bin";
            const basename = safeOrderFileFolderValue(source.displayName.replace(/\.[^.]*$/u, ""), 108);
            target = { path, name: `${basename} - ${source.filePublicId}.${extension}`, ownerUserId: source.ownerUserId, phase };
          }
          if (!isResolvedOrderFileFolder(target.path) || !isResolvedOrderFileFolder([target.name])) throw new RangeError();
        } catch (error) {
          if (error instanceof RangeError || error instanceof z.ZodError || error instanceof SyntaxError) {
            throw new DomainError("VALIDATION", "STORAGE_FOLDER_INVALID", "The copy folder could not be resolved safely.");
          }
          throw error;
        }
        if (source.ownerUserId !== target.ownerUserId) {
          throw sourceInactive();
        }
        await tx.update(storageFileCopies).set({ state: "copying", attempts: job.attempt, reasonCode: null,
          targetEnc: row.targetEnc ?? crypto.encrypt(JSON.stringify(target), targetAad(row.publicId)),
          updatedAt: clock.now() }).where(eq(storageFileCopies.id, row.id));
        await auditCopy(job, row, "attempted", orderPublicId, undefined, tx);
        await recordCopyAttempt(deps, {
          ...attempt, phase: "started", bytes: source.size, orderPublicId,
          targetPathEnc: crypto.encrypt([...target.path, target.name].join("/"), copyAttemptPrivateAad("target_path", job.jobId, job.attempt)),
          ...(target.phase ? { phaseLabelEnc: crypto.encrypt(target.phase, copyAttemptPrivateAad("phase_label", job.jobId, job.attempt)) } : {}),
        }, tx);
        return { source, target };
      });
      const { source, target } = prepared;
      job.signal.throwIfAborted();
      const local = await storage.stat(source.storageKey).catch(() => {
        throw new DomainError("UNAVAILABLE", "STORAGE_LOCAL_READ_FAILED", "The local copy source is not available.");
      });
      if (!local || local.size !== source.size || local.sha256 !== source.sha256) {
        throw new DomainError("UNAVAILABLE", "STORAGE_LOCAL_INTEGRITY_MISMATCH", "The local file did not pass verification.");
      }
      body = await storage.get(source.storageKey).catch(() => {
        throw new DomainError("UNAVAILABLE", "STORAGE_LOCAL_READ_FAILED", "The local copy source is not available.");
      });
      const result = await service.copy({
        purpose: "order_files", connectionPublicId: row.connectionPublicId, expectedDestinationVersion: row.destinationVersion,
        path: target.path, name: target.name, size: source.size, sha256: source.sha256, contentType: source.contentType,
        body, signal: job.signal, assertStillOwned: job.assertStillOwned, correlationId: job.correlationId,
        assertSourceCurrent: async (tx) => {
          const current = await deps.services.files.getOrderFileCopySource(row.filePublicId, tx);
          if (current.orderPublicId !== source.orderPublicId || current.ownerUserId !== source.ownerUserId ||
              current.storageKey !== source.storageKey || current.sha256 !== source.sha256 ||
              automationSourceInactive(current)) {
            throw sourceInactive();
          }
        },
      });
      const digestVerified = result.sha256 !== undefined || result.verifiedTransportDigest !== undefined;
      await currentTx(async (tx) => {
        await job.assertStillOwned(tx);
        const now = clock.now();
        await tx.update(storageFileCopies).set({ state: "copied", remoteIdEnc: crypto.encrypt(result.remoteId, remoteAad(row.publicId)),
          digestVerified, updatedAt: now, finishedAt: now }).where(eq(storageFileCopies.id, row.id));
        await auditCopy(job, row, "completed", orderPublicId, undefined, tx);
        const finalPath = result.targetPath && result.targetPath.length === target.path.length + 1 &&
          result.targetPath.every((segment) => segment.length > 0 && segment.length <= 255 &&
            segment !== "." && segment !== ".." && !/[/\\\p{C}]/u.test(segment))
          ? result.targetPath.join("/") : undefined;
        await recordCopyAttempt(deps, {
          ...attempt, phase: "finished", bytes: source.size, orderPublicId, alreadyAudited: true,
          ...(finalPath ? { targetPathEnc: crypto.encrypt(finalPath, copyAttemptPrivateAad("target_path", job.jobId, job.attempt)) } : {}),
          ...(digestVerified ? { result: "verified", verification: "checksum" } as const : { result: "written" } as const),
        }, tx);
      });
      return { outcome: "completed", safeCounts: { files: 1, digestVerified: digestVerified ? 1 : 0 } };
    } catch (error) {
      // Lost leases cannot publish a result; the durable queue records interrupted/uncertain attempts.
      job.signal.throwIfAborted();
      const code = error instanceof DomainError && safeFailure.has(error.reasonCode) ? error.reasonCode : "STORAGE_COPY_UNCERTAIN";
      const skipped = localCopyStopped.has(code);
      const willRetry = retryable.has(code) && job.attempt < ORDER_FILE_COPY_MAX_ATTEMPTS;
      await currentTx(async (tx) => {
        await job.assertStillOwned(tx);
        const now = clock.now();
        await tx.update(storageFileCopies).set({ state: skipped ? "skipped" : willRetry ? "queued" : "failed",
          attempts: job.attempt, reasonCode: code, updatedAt: now, finishedAt: willRetry ? null : now })
          .where(eq(storageFileCopies.id, row.id));
        await auditCopy(job, row, skipped ? "refused" : code === "STORAGE_COPY_UNCERTAIN" ? "unknown" : "failed", orderPublicId, code, tx);
        await recordCopyAttempt(deps, {
          ...attempt, phase: "finished", result: skipped ? "not_written" : "failed", orderPublicId, errorCode: code, alreadyAudited: true,
        }, tx);
      });
      if (skipped) return { outcome: "completed", safeCounts: { skipped: 1 } };
      if (code === "STORAGE_COPY_UNCERTAIN") return { outcome: "unknown", reasonCode: code };
      return { outcome: "failed", reasonCode: code, retryable: willRetry };
    } finally {
      body?.destroy();
    }
  });

  return {
    async stage(filePublicId: string, destinations: readonly Destination[], tx: Tx, orderPublicId?: string, correlationId?: string) {
      const now = clock.now();
      let queued = 0;
      for (const destination of destinations) {
        const copyPublicId = ulid(now.getTime());
        await tx.insert(storageFileCopies).values({ publicId: copyPublicId, filePublicId,
          connectionPublicId: destination.publicId, destinationVersion: destination.destinationVersion, createdAt: now, updatedAt: now })
          .onDuplicateKeyUpdate({ set: { id: sql`${storageFileCopies.id}` } });
        const [stored] = await tx.select({ publicId: storageFileCopies.publicId }).from(storageFileCopies)
          .where(and(eq(storageFileCopies.filePublicId, filePublicId), eq(storageFileCopies.connectionPublicId, destination.publicId)))
          .limit(1).for("update");
        if (!stored) throw new Error("STORAGE_COPY_ROW_UNAVAILABLE");
        if (stored.publicId !== copyPublicId) continue; // Preserve any existing result and its bound generation.
        const { jobId } = await jobs.enqueue(ORDER_FILE_COPY_JOB, { copyPublicId }, {
          idempotencyKey: `${filePublicId}:${destination.publicId}`, maxAttempts: ORDER_FILE_COPY_MAX_ATTEMPTS, correlationId,
        }, tx);
        await recordCopyAttempt(deps, {
          phase: "queued", kind: "order_file", sourcePublicId: filePublicId, connectionPublicId: destination.publicId,
          jobPublicId: jobId, attempt: 1, correlationId, orderPublicId,
        }, tx);
        queued += 1;
      }
      return queued;
    },
  };
}
