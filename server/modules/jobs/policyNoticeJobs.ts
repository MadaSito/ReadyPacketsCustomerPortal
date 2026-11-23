import { and, inArray } from "drizzle-orm";
import { z } from "zod";
import { validation } from "../../core/errors.js";
import { ULID_PATTERN } from "../../core/ids.js";
import type { ClaimedJob, CoreDeps, Mailer, Tx } from "../../core/types.js";
import { keyHash } from "./queue.js";
import { mailOutbox } from "./schema.js";

export const POLICY_NOTICE_JOB = "compliance.policy_notice.batch";
export const POLICY_UPDATE_TEMPLATE = "policy_update_notice";
export const POLICY_WARNING_TEMPLATE = "policy_enforcement_warning";
const MAX_ATTEMPTS = 8;
const MAX_DEFERRED_SLOTS = 48;
const BATCH_SIZE = 25;
const BATCH_SPACING_MS = 5_000;
const ulid = z.string().regex(ULID_PATTERN);
const cursorSchema = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_:.=-]+$/u);
const identityShape = { noticePublicId: ulid, revision: z.number().int().positive().max(0xFFFFFFFF) };
const scheduleInput = z.strictObject({ ...identityShape, scheduledAt: z.date() });
const payloadSchema = z.strictObject({
  ...identityShape,
  cursor: cursorSchema.nullable(),
  deferrals: z.number().int().min(0).max(MAX_DEFERRED_SLOTS),
});
type BatchPayload = z.output<typeof payloadSchema>;
type BatchClaim = Pick<ClaimedJob, "signal" | "correlationId" | "assertStillOwned">;
export type PolicyNoticeBatchInput = Omit<BatchPayload, "deferrals"> & { limit: number };
export type PolicyNoticeBatch = (
  input: PolicyNoticeBatchInput, claim: BatchClaim, tx: Tx,
) => Promise<{ nextCursor: string | null }>;
type NoticeJobDeps = Pick<CoreDeps, "jobs" | "db" | "clock" | "rateLimiter">;

/** Register once. The owner fences audience/configuration by re-reading the notice/revision in the supplied transaction. */
export function registerPolicyNoticeJobs(deps: NoticeJobDeps, runBatch: PolicyNoticeBatch) {
  function enqueue(payload: BatchPayload, runAt: Date, tx: Tx | undefined, correlationId?: string) {
    return deps.jobs.enqueue(POLICY_NOTICE_JOB, payload, {
      maxAttempts: MAX_ATTEMPTS,
      idempotencyKey: `policy-notice:${payload.noticePublicId}:${payload.revision}:${payload.cursor === null ? "first" : keyHash(payload.cursor)}:${payload.deferrals}`,
      runAt, correlationId,
    }, tx);
  }

  deps.jobs.register<unknown>(POLICY_NOTICE_JOB, async (job) => {
    const parsed = payloadSchema.safeParse(job.payload);
    if (!parsed.success || job.attempt > MAX_ATTEMPTS) {
      return { outcome: "failed", reasonCode: "POLICY_NOTICE_JOB_INVALID", retryable: false };
    }
    const { noticePublicId, revision, cursor, deferrals } = parsed.data;
    const verdict = await deps.rateLimiter.consume("expensive", "jobs:policy-notice-batch", 1);
    if (!verdict.allowed && deferrals >= MAX_DEFERRED_SLOTS) {
      return { outcome: "failed", reasonCode: "POLICY_NOTICE_THROTTLE_EXHAUSTED", retryable: false };
    }
    return deps.db.transaction(async (tx) => {
      await job.assertStillOwned(tx);
      const later = (ms: number) => new Date(deps.clock.now().getTime() + ms);
      if (!verdict.allowed) {
        const retrySeconds = Math.min(86_400, Math.max(1, Number.isFinite(verdict.retryAfterSeconds) ? verdict.retryAfterSeconds : 60));
        await enqueue({ ...parsed.data, deferrals: deferrals + 1 }, later(retrySeconds * 1_000), tx, job.correlationId);
        return { outcome: "completed", safeCounts: { batches_deferred: 1 } };
      }
      const { nextCursor } = await runBatch({ noticePublicId, revision, cursor, limit: BATCH_SIZE }, job, tx);
      if (nextCursor !== null) {
        if (!cursorSchema.safeParse(nextCursor).success || nextCursor === cursor) throw new Error("POLICY_NOTICE_CURSOR_INVALID");
        await enqueue({ noticePublicId, revision, cursor: nextCursor, deferrals: 0 }, later(BATCH_SPACING_MS), tx, job.correlationId);
      }
      return { outcome: "completed" };
    }, { isolationLevel: "read committed" });
  }, { retrySafe: true });

  return (input: z.input<typeof scheduleInput>, tx?: Tx) => {
    const parsed = scheduleInput.safeParse(input);
    if (!parsed.success) throw validation("POLICY_NOTICE_SCHEDULE_INVALID", "The policy notice schedule is invalid.");
    const { noticePublicId, revision, scheduledAt } = parsed.data;
    return enqueue({ noticePublicId, revision, cursor: null, deferrals: 0 }, scheduledAt, tx);
  };
}

const mailKeyInput = z.strictObject({
  kind: z.enum(["update", "warning"]),
  policyVersionPublicId: ulid,
  recipientUserId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  reminderPublicId: ulid.optional(),
});
type PolicyNoticeMailKeyInput = z.input<typeof mailKeyInput>;
const mailKeyPattern = /^policy-notice:(?:update|warning):[0-9A-HJKMNP-TV-Z]{26}:[1-9]\d{0,15}(?::reminder:[0-9A-HJKMNP-TV-Z]{26})?$/u;

export function policyNoticeMailKey(input: PolicyNoticeMailKeyInput): string {
  const parsed = mailKeyInput.safeParse(input);
  if (!parsed.success) throw validation("POLICY_NOTICE_MAIL_INVALID", "The policy notice mail input is invalid.");
  const { kind, policyVersionPublicId, recipientUserId, reminderPublicId } = parsed.data;
  return `policy-notice:${kind}:${policyVersionPublicId}:${recipientUserId}${reminderPublicId ? `:reminder:${reminderPublicId}` : ""}`;
}

const optionalLines = (max: number) => z.string().trim().max(max).refine((value) => !value.includes("\0")).optional();
function safePortalUrl(input: string) {
  if (/[\p{Cc}]/u.test(input)) return false;
  try {
    const url = new URL(input);
    return !url.username && !url.password && (url.protocol === "https:"
      || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
  } catch { return false; }
}
const mailInput = mailKeyInput.extend({
  policyTitle: z.string().trim().min(1).max(200).refine((value) => !/[\p{Cc}]/u.test(value)),
  portalUrl: z.string().trim().max(512).refine(safePortalUrl),
  summary: optionalLines(2_000),
  deadline: optionalLines(128),
  warningText: optionalLines(1_000),
});

export function enqueuePolicyNoticeMail(mailer: Mailer, input: z.input<typeof mailInput>, tx?: Tx): Promise<void> {
  const parsed = mailInput.safeParse(input);
  if (!parsed.success) throw validation("POLICY_NOTICE_MAIL_INVALID", "The policy notice mail input is invalid.");
  const { policyTitle, portalUrl, summary, deadline, warningText, ...key } = parsed.data;
  return mailer.enqueue({
    to: { userId: key.recipientUserId },
    template: key.kind === "update" ? POLICY_UPDATE_TEMPLATE : POLICY_WARNING_TEMPLATE,
    vars: key.kind === "update"
      ? { policyTitle, portalUrl, summary: summary || "An updated version is available in the portal." }
      : { policyTitle, portalUrl, deadline: deadline || "See the current deadline in the portal.",
        warningText: warningText || "Review and accept the policy to continue using your account." },
    idempotencyKey: policyNoticeMailKey(key),
  }, tx);
}

export type PolicyNoticeMailState = "queued" | "sent" | "failed";

/** Bounded internal look-up. States are outbox outcomes, not mail-box delivery proof. */
export async function readPolicyNoticeMailStates(
  db: CoreDeps["db"], keys: readonly string[], tx?: Tx,
): Promise<ReadonlyMap<string, PolicyNoticeMailState>> {
  if (keys.length > 250 || keys.some((key) => !mailKeyPattern.test(key))) {
    throw validation("POLICY_NOTICE_MAIL_KEYS_INVALID", "The policy notice mail references are invalid.");
  }
  const byHash = new Map(keys.map((key) => [keyHash(key), key]));
  const states = new Map<string, PolicyNoticeMailState>();
  if (!byHash.size) return states;
  const rows = await (tx ?? db).select({ hash: mailOutbox.idempotencyHash, state: mailOutbox.state })
    .from(mailOutbox).where(and(inArray(mailOutbox.idempotencyHash, [...byHash.keys()]),
      inArray(mailOutbox.template, [POLICY_UPDATE_TEMPLATE, POLICY_WARNING_TEMPLATE])));
  for (const row of rows) {
    const key = byHash.get(row.hash);
    if (key) states.set(key, row.state === "accepted" ? "sent" : row.state === "queued" || row.state === "sending" ? "queued" : "failed");
  }
  return states;
}
