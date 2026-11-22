import { and, eq, sql } from "drizzle-orm";
import type { CoreDeps, Tx } from "../../core/types.js";
import type { CopyAttemptEvent } from "./copyLogTypes.js";
import { storageCopyAttempts as attempts } from "./schema.js";

const identityToken = /^[A-Za-z0-9_-]{1,26}$/u;
const traceToken = /^[A-Za-z0-9_.:-]{1,64}$/u;
const reasonToken = /^[A-Z][A-Z0-9_]{0,63}$/u;
export const copyAttemptPrivateAad = (column: "target_path" | "phase_label", jobId: string, attempt: number) =>
  `storage_copy_attempts.${column}_enc:${jobId}:${attempt}`;

/** Call inside the owner's fenced transaction. No provider or request data belongs here. */
export async function recordCopyAttempt(
  deps: Pick<CoreDeps, "clock" | "audit">,
  event: CopyAttemptEvent,
  tx: Tx,
): Promise<void> {
  const { kind, sourcePublicId, connectionPublicId, jobPublicId, attempt } = event;
  if (!identityToken.test(sourcePublicId) || !identityToken.test(connectionPublicId) ||
      !traceToken.test(jobPublicId) || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > 0xffff_ffff) {
    throw new Error("COPY_ATTEMPT_IDENTITY_INVALID");
  }
  if ((event.orderPublicId !== undefined && !identityToken.test(event.orderPublicId)) ||
      (kind !== "order_file" && (event.orderPublicId || event.targetPathEnc || event.phaseLabelEnc))) {
    throw new Error("COPY_ATTEMPT_ORDER_INVALID");
  }

  const now = deps.clock.now();
  const suppliedTrace = event.correlationId;
  const correlationId = suppliedTrace && traceToken.test(suppliedTrace) ? suppliedTrace : null;
  const bytes = typeof event.bytes === "number" && Number.isSafeInteger(event.bytes) && event.bytes >= 0 ? event.bytes : null;
  const key = and(eq(attempts.jobPublicId, jobPublicId), eq(attempts.attempt, attempt));
  await tx.insert(attempts).values({
    kind, sourcePublicId, connectionPublicId, jobPublicId, attempt, correlationId, bytes,
    orderPublicId: event.orderPublicId, targetPathEnc: event.targetPathEnc, phaseLabelEnc: event.phaseLabelEnc,
    createdAt: now,
  }).onDuplicateKeyUpdate({ set: { id: sql`${attempts.id}` } });
  if (event.phase === "queued") return;

  const [row] = await tx.select({
    kind: attempts.kind, sourcePublicId: attempts.sourcePublicId, connectionPublicId: attempts.connectionPublicId,
    state: attempts.state, startedAt: attempts.startedAt, orderPublicId: attempts.orderPublicId,
  }).from(attempts).where(key).limit(1).for("update");
  if (!row || row.kind !== kind || row.sourcePublicId !== sourcePublicId || row.connectionPublicId !== connectionPublicId ||
      (row.orderPublicId !== null && event.orderPublicId !== undefined && row.orderPublicId !== event.orderPublicId)) {
    throw new Error("COPY_ATTEMPT_IDENTITY_CHANGED");
  }
  if (row.state !== "queued") return;

  if (event.phase === "started") {
    await tx.update(attempts).set({
      startedAt: row.startedAt ?? now,
      ...(event.orderPublicId ? { orderPublicId: event.orderPublicId } : {}),
      ...(event.targetPathEnc ? { targetPathEnc: event.targetPathEnc } : {}),
      ...(event.phaseLabelEnc ? { phaseLabelEnc: event.phaseLabelEnc } : {}),
      ...(bytes !== null ? { bytes } : {}),
      ...(correlationId !== null ? { correlationId } : {}),
    }).where(key);
    return;
  }

  const errorCode = event.errorCode && reasonToken.test(event.errorCode)
    ? event.errorCode : event.result === "failed" ? "COPY_FAILED" : null;
  await tx.update(attempts).set({
    state: event.result,
    verification: event.verification ?? null,
    errorCode, finishedAt: now,
    ...(event.orderPublicId ? { orderPublicId: event.orderPublicId } : {}),
    ...(event.targetPathEnc ? { targetPathEnc: event.targetPathEnc } : {}),
    ...(bytes !== null ? { bytes } : {}),
    ...(correlationId !== null ? { correlationId } : {}),
  }).where(key);
  if (!event.alreadyAudited && event.result !== "not_written") {
    await deps.audit.record({
      category: "integration",
      eventName: "storage.copy_result",
      action: "copy",
      outcome: event.result === "failed" ? "failed" : "completed",
      ...(errorCode ? { reasonCode: errorCode } : {}),
      actor: { role: "system" },
      resource: { type: kind, publicId: sourcePublicId },
      jobId: jobPublicId,
      ...(correlationId ? { correlationId } : {}),
    }, tx);
  }
}
