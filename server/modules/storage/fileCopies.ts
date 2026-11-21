import type { Readable } from "node:stream";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { ModuleDeps } from "../../container.js";
import { DomainError } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { ClaimedJob, JobResult, Tx } from "../../core/types.js";
import { isAutomationOrigin } from "../audit/tap.js";
import type { StorageModule } from "./contracts.js";
import { recordCopyAttempt } from "./copyLogWriter.js";
import { storageFileCopies } from "./schema.js";
import { copySegment, storagePublicId } from "./validation.js";

const jobType = "storage.copy_order_file";
const maxAttempts = 6;
const payload = z.strictObject({ copyPublicId: storagePublicId });
const encryptedTarget = z.strictObject({ path: z.array(copySegment).length(3), name: copySegment, ownerUserId: z.number().int().positive() });
const targetAad = (id: string) => `storage_file_copies.target_enc:${id}`;
const remoteAad = (id: string) => `storage_file_copies.remote_id_enc:${id}`;
const localCopyStopped = new Set(["STORAGE_ASSIGNMENT_INACTIVE", "STORAGE_COPY_SOURCE_INACTIVE"]);
const retryable = new Set(["STORAGE_PROVIDER_RETRY", "STORAGE_LOCAL_READ_FAILED"]);
const safeFailure = new Set([...retryable, ...localCopyStopped, "STORAGE_INTEGRITY_MISMATCH",
  "STORAGE_LOCAL_INTEGRITY_MISMATCH", "STORAGE_EGRESS_DENIED", "STORAGE_PROVIDER_DENIED", "STORAGE_PROVIDER_LIMIT",
  "STORAGE_COPY_UNCERTAIN", "AUDIT_WRITE_FAILED"]);

function label(value: string, fallback: string, maxBytes: number): string {
  const safe = value.normalize("NFC").replace(/[\\/%:*?"<>|]|\p{C}/gu, "_").trim().replace(/^[. ]+|[. ]+$/gu, "");
  let result = "";
  for (const char of safe) {
    if (Buffer.byteLength(result + char) > maxBytes) break;
    result += char;
  }
  return result.replace(/[. ]+$/u, "") || fallback;
}

export function orderFileTarget(input: {
  customerName: string; customerReference: string; customerPublicId: string; orderReference: string;
  orderPublicId: string; filePublicId: string; displayName: string; extension: string;
}) {
  const [first, ...rest] = input.customerName.trim().split(/\s+/u);
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const firstTwo = Array.from(segmenter.segment(first ?? ""), (item) => item.segment).slice(0, 2).join("");
  const customer = label(`${firstTwo} ${rest.join(" ")} ${input.customerReference}`, "Customer", 104);
  const order = label(input.orderReference, "Order", 96);
  const extension = /^[a-z0-9]{1,12}$/u.test(input.extension) ? input.extension : "bin";
  const basename = label(input.displayName.replace(/\.[^.]*$/u, ""), "File", 108);
  return { path: ["Order files", `${customer} - ${input.customerPublicId}`, `${order} - ${input.orderPublicId}`],
    name: `${basename} - ${input.filePublicId}.${extension}` };
}

type CopyRow = typeof storageFileCopies.$inferSelect;
type Destination = { publicId: string; destinationVersion: number };
type Job = ClaimedJob<z.infer<typeof payload>>;

export function registerFileCopies(deps: ModuleDeps, service: StorageModule) {
  const { audit, clock, crypto, db, jobs, storage } = deps;
  const currentTx = <T>(run: (tx: Tx) => Promise<T>) => db.transaction(run, { isolationLevel: "read committed" });

  function auditCopy(job: Job, row: CopyRow, outcome: "attempted" | "completed" | "failed" | "refused" | "unknown", reasonCode?: string, tx?: Tx) {
    return audit.record({
      category: "file", eventName: "storage.order_file.copy", action: "copy", outcome, reasonCode,
      actor: { role: "system" }, jobId: job.jobId, correlationId: job.correlationId,
      resource: { type: "file", publicId: row.filePublicId },
    }, tx);
  }

  jobs.register(jobType, async (job: Job): Promise<JobResult> => {
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
    let body: Readable | undefined;
    try {
      const prepared = await currentTx(async (tx) => {
        await job.assertStillOwned(tx);
        const source = await deps.services.files.getOrderFileCopySource(row.filePublicId, tx);
        if (automationSourceInactive(source)) throw sourceInactive();
        const target = row.targetEnc ? encryptedTarget.parse(JSON.parse(crypto.decrypt(row.targetEnc, targetAad(row.publicId)))) :
          { ...orderFileTarget(source), ownerUserId: source.ownerUserId };
        if (source.ownerUserId !== target.ownerUserId) {
          throw sourceInactive();
        }
        await tx.update(storageFileCopies).set({ state: "copying", attempts: job.attempt, reasonCode: null,
          targetEnc: row.targetEnc ?? crypto.encrypt(JSON.stringify(target), targetAad(row.publicId)),
          updatedAt: clock.now() }).where(eq(storageFileCopies.id, row.id));
        await auditCopy(job, row, "attempted", undefined, tx);
        await recordCopyAttempt(deps, { ...attempt, phase: "started", bytes: source.size }, tx);
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
          if (current.ownerUserId !== source.ownerUserId || current.storageKey !== source.storageKey || current.sha256 !== source.sha256 ||
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
        await auditCopy(job, row, "completed", undefined, tx);
        await recordCopyAttempt(deps, {
          ...attempt, phase: "finished", bytes: source.size, alreadyAudited: true,
          ...(digestVerified ? { result: "verified", verification: "checksum" } as const : { result: "written" } as const),
        }, tx);
      });
      return { outcome: "completed", safeCounts: { files: 1, digestVerified: digestVerified ? 1 : 0 } };
    } catch (error) {
      // Lost leases cannot publish a result; the durable queue records interrupted/uncertain attempts.
      job.signal.throwIfAborted();
      const code = error instanceof DomainError && safeFailure.has(error.reasonCode) ? error.reasonCode : "STORAGE_COPY_UNCERTAIN";
      const skipped = localCopyStopped.has(code);
      const willRetry = retryable.has(code) && job.attempt < maxAttempts;
      await currentTx(async (tx) => {
        await job.assertStillOwned(tx);
        const now = clock.now();
        await tx.update(storageFileCopies).set({ state: skipped ? "skipped" : willRetry ? "queued" : "failed",
          attempts: job.attempt, reasonCode: code, updatedAt: now, finishedAt: willRetry ? null : now })
          .where(eq(storageFileCopies.id, row.id));
        await auditCopy(job, row, skipped ? "refused" : code === "STORAGE_COPY_UNCERTAIN" ? "unknown" : "failed", code, tx);
        await recordCopyAttempt(deps, {
          ...attempt, phase: "finished", result: skipped ? "not_written" : "failed", errorCode: code, alreadyAudited: true,
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
    async stage(filePublicId: string, destinations: readonly Destination[], tx: Tx, correlationId?: string) {
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
        const { jobId } = await jobs.enqueue(jobType, { copyPublicId }, {
          idempotencyKey: `${filePublicId}:${destination.publicId}`, maxAttempts, correlationId,
        }, tx);
        await recordCopyAttempt(deps, {
          phase: "queued", kind: "order_file", sourcePublicId: filePublicId, connectionPublicId: destination.publicId,
          jobPublicId: jobId, attempt: 1, correlationId,
        }, tx);
        queued += 1;
      }
      return queued;
    },
  };
}
