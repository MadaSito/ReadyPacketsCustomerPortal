import { z } from "zod";
import { validation } from "../../core/errors.js";
import { ULID_PATTERN } from "../../core/ids.js";
import type { ClaimedJob, EnqueueOptions, JobQueue, Mailer, Tx } from "../../core/types.js";

export const REFUND_RECONCILE_JOB = "compliance.refund.reconcile";
export const REFUND_RECONCILE_MAX_ATTEMPTS = 8;
export const REFUND_NOTICE_TEMPLATE_KEY = "compliance.refund_notice";

const refundPublicIdSchema = z.string().regex(ULID_PATTERN);
const refundJobPayload = z.strictObject({ refundPublicId: refundPublicIdSchema });

export type RefundReconcileContext = Pick<ClaimedJob, "jobId" | "signal" | "correlationId" | "assertStillOwned">;
export type RefundReconciler = (refundPublicId: string, context: RefundReconcileContext) => Promise<"settled" | "pending">;

/**
 * `reconcile` may read provider state, never submit a refund. Its finalization must lock the job
 * with `context.assertStillOwned(tx)` before the refund row lock, then recheck intent and outcome, and
 * idempotently apply local settlement (including any notice) in that same transaction.
 */
export function registerRefundReconciliation(jobs: JobQueue, reconcile: RefundReconciler) {
  jobs.register<unknown>(REFUND_RECONCILE_JOB, async (job) => {
    const payload = refundJobPayload.safeParse(job.payload);
    if (!payload.success || job.attempt > REFUND_RECONCILE_MAX_ATTEMPTS) {
      return { outcome: "failed", reasonCode: "REFUND_RECONCILE_INVALID_JOB", retryable: false };
    }
    await job.assertStillOwned();
    const outcome = await reconcile(payload.data.refundPublicId, {
      jobId: job.jobId, signal: job.signal, correlationId: job.correlationId, assertStillOwned: job.assertStillOwned,
    });
    if (outcome === "settled") return { outcome: "completed" };
    const retryable = job.attempt < REFUND_RECONCILE_MAX_ATTEMPTS;
    return { outcome: "failed", reasonCode: retryable ? "REFUND_RECONCILE_PENDING" : "REFUND_RECONCILE_EXHAUSTED", retryable };
  }, { retrySafe: true });

  // The caller commits this lookup with the initial durable intent, before attempting provider writes.
  return (refundPublicId: string, tx: Tx, options: Pick<EnqueueOptions, "runAt" | "correlationId"> = {}) => {
    if (!refundPublicIdSchema.safeParse(refundPublicId).success) {
      throw validation("REFUND_RECONCILE_INVALID_ID", "The refund reference is invalid.");
    }
    return jobs.enqueue(REFUND_RECONCILE_JOB, { refundPublicId }, {
      runAt: options.runAt, correlationId: options.correlationId,
      idempotencyKey: `refund-reconcile:${refundPublicId}`, maxAttempts: REFUND_RECONCILE_MAX_ATTEMPTS,
    }, tx);
  };
}

export function registerRefundNotice(mailer: Mailer): void {
  const vars = ["orderReference", "refundAmount", "refundReference"] as const;
  mailer.registerTemplate({
    key: REFUND_NOTICE_TEMPLATE_KEY,
    vars,
    sensitiveVars: vars,
    subject: () => "A refund was recorded for your ReadyPackets order",
    text: (values) => [
      `A refund of ${String(values.refundAmount)} was recorded for your ReadyPackets order ${String(values.orderReference)}.`,
      `Refund reference: ${String(values.refundReference)}`,
      "",
      "Sign in to ReadyPackets to review the refund details. If the refund was handled outside the portal, contact the merchant with any questions about its timing.",
    ].join("\n"),
  });
}
