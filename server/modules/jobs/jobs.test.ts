import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { forbidden } from "../../core/errors.js";
import { getRequestContext, newRequestContext, runWithRequestContext } from "../../core/requestContext.js";
import { createCallerFactory } from "../../trpc/trpc.js";
import { createTestDeps, fakePrincipal } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { createAuditEmitter } from "../audit/emitter.js";
import { auditEvents } from "../audit/schema.js";
import { createJobsAdmin } from "./admin.js";
import { customerMaintenanceNotice } from "./customerMaintenance.js";
import { createJobsModule } from "./index.js";
import { MAIL_CAPTURE, mailEngineFor, type SmtpDeliveryResult } from "./mail.js";
import type { MailTransportMessage } from "./mailPorts.js";
import { MAIL_AUDIT_COPY, MAIL_RETAIN_CONTENT, MAIL_RETENTION_DAYS, MAIL_ROUTING, MAIL_SENDER } from "./mailSettings.js";
import { enqueuePolicyNoticeMail, policyNoticeMailKey, registerPolicyNoticeJobs } from "./policyNoticeJobs.js";
import { createJobQueue, createMailer, engineFor, JOB_TYPE } from "./queue.js";
import { enqueuePaymentReceipt, PAYMENT_RECEIPT_TEMPLATE, RECEIPT_PDF_MAX_BYTES } from "./receiptMail.js";
import {
  REFUND_NOTICE_TEMPLATE_KEY, REFUND_RECONCILE_JOB, REFUND_RECONCILE_MAX_ATTEMPTS,
  registerRefundNotice, registerRefundReconciliation, type RefundReconcileContext,
} from "./refundSupport.js";
import { jobsRouter } from "./router.js";
import { customerMaintenance, jobAttempts, jobMaintenance, jobRuns, mailAttempts, mailAuditVerification, mailManualResends, mailOutbox, mailTransportAttempts } from "./schema.js";
import { startWorker } from "./worker.js";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb({ schema: { jobRuns, jobAttempts, jobMaintenance, customerMaintenance, mailOutbox, mailAttempts, mailTransportAttempts, mailManualResends, mailAuditVerification, auditEvents } });
});
afterAll(async () => t?.cleanup());
beforeEach(async () => {
  for (const table of [jobAttempts, mailAttempts, mailTransportAttempts, mailManualResends, mailAuditVerification, mailOutbox, jobRuns, jobMaintenance, customerMaintenance, auditEvents]) {
    await t.db.delete(table);
  }
});

const done = async () => ({ outcome: "completed" as const });
const inactiveCustomerAccess = { active: false, message: null, expectedEnd: null };
async function expireLease(jobId?: string): Promise<void> {
  await t.db.update(jobRuns).set({ leaseUntil: sql`UTC_TIMESTAMP(3) - INTERVAL 1 SECOND` })
    .where(jobId === undefined ? eq(jobRuns.state, "running") : eq(jobRuns.publicId, jobId));
}
function latch(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((ready) => { resolve = ready; });
  return { promise, resolve };
}

function fixture(profile: Parameters<typeof createTestDeps>[0] = {}, useDurableAudit = false) {
  const h = createTestDeps({ db: t.db, ...profile });
  const durableAudit = useDurableAudit ? createAuditEmitter(h.deps) : undefined;
  const core = { ...h.deps, audit: durableAudit ?? h.audit };
  const jobs = createJobQueue(core);
  const mailer = createMailer({ ...core, jobs });
  const deps = { ...core, jobs, mailer };
  const admin = createJobsAdmin(deps);
  const engine = engineFor(jobs)!;
  const mail = mailEngineFor(mailer)!;
  const operator = fakePrincipal({ role: "admin", stepUpAt: h.clock.now() });
  const assertCurrent = vi.fn(async () => ({ pendingSteps: [], role: operator.role, stepUpAt: h.clock.now(), mfaVerifiedAt: h.clock.now() }));
  h.services.identity = { sessions: { assertCurrent } } as unknown as typeof h.services.identity;
  return { h, jobs, engine, mailer, mail, admin, operator, assertCurrent, durableAudit };
}

const noticePublicId = "01JD0000000000000000000001";
const reminderPublicId = "01JD0000000000000000000002";
const policyMailInput = {
  kind: "update" as const, policyVersionPublicId: noticePublicId, recipientUserId: 22,
  policyTitle: "Access policy", portalUrl: "https://portal.example.test/policies", summary: "Updated summary.",
};
const receiptInput = {
  receiptPublicId: noticePublicId, recipientUserId: 22,
  receiptNumber: "RPR-2026-000032", pdf: Buffer.from("%PDF-1.7\nPRIVATE-RECEIPT\n%%EOF"),
};

describe("Scheduled policy notice batches", () => {
  it("rolls back staged mail and progress on failure, retries with backoff, and chains a single delayed successor", async () => {
    const f = fixture();
    f.mail.registerDelivery({ findRecipient: async () => null, getLegacySender: async () => null });
    const runBatch = vi.fn<Parameters<typeof registerPolicyNoticeJobs>[1]>();
    runBatch.mockImplementation(async ({ cursor }, _claim, tx) => {
      if (cursor === null) {
        await enqueuePolicyNoticeMail(f.mailer, policyMailInput, tx);
        if (runBatch.mock.calls.length === 1) throw new Error("synthetic batch error");
      }
      return { nextCursor: cursor === null ? "22" : null };
    });
    const schedule = registerPolicyNoticeJobs({ ...f.h.deps, jobs: f.jobs }, runBatch);
    const input = { noticePublicId, revision: 1, scheduledAt: new Date(f.h.clock.now().getTime() + 60_000) };
    await expect(t.db.transaction(async (tx) => {
      await schedule(input, tx);
      throw new Error("publish rollback");
    })).rejects.toThrow("publish rollback");
    expect(await t.db.select().from(jobRuns)).toHaveLength(0);
    const first = await schedule(input);
    expect(await schedule(input)).toEqual(first);
    expect(await f.engine.claim()).toBeNull();
    f.h.clock.advance(60_000);
    await f.engine.execute((await f.engine.claim())!);
    expect(await t.db.select().from(mailOutbox)).toHaveLength(0);
    expect(await f.admin.detail(f.operator, first.jobId)).toMatchObject({ state: "queued", attempt: 1 });
    expect(await f.engine.claim()).toBeNull();
    f.h.clock.advance(5_000);
    await f.engine.execute((await f.engine.claim())!);
    expect(runBatch.mock.calls[1]?.[0]).toEqual({ noticePublicId, revision: 1, cursor: null, limit: 25 });
    expect(await t.db.select().from(mailOutbox)).toHaveLength(1);
    await f.engine.execute((await f.engine.claim())!); // mail is independently dispatched
    expect(await f.engine.claim()).toBeNull();
    f.h.clock.advance(5_000);
    await f.engine.execute((await f.engine.claim())!);
    expect(runBatch.mock.calls[2]?.[0]).toMatchObject({ cursor: "22" });
    expect(runBatch.mock.calls[2]?.[1].correlationId).toBe(runBatch.mock.calls[1]?.[1].correlationId);
    expect(await f.engine.claim()).toBeNull();
  });

  it("defers a rate-limited batch without running the writer or consuming its backoff attempts", async () => {
    const f = fixture();
    const consume = vi.spyOn(f.h.rateLimiter, "consume").mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 10 });
    const runBatch = vi.fn(async () => ({ nextCursor: null }));
    const schedule = registerPolicyNoticeJobs({ ...f.h.deps, jobs: f.jobs }, runBatch);
    await schedule({ noticePublicId, revision: 1, scheduledAt: f.h.clock.now() });
    await f.engine.execute((await f.engine.claim())!);
    expect(consume).toHaveBeenCalledWith("expensive", "jobs:policy-notice-batch", 1);
    expect(runBatch).not.toHaveBeenCalled();
    f.h.clock.advance(9_999);
    expect(await f.engine.claim()).toBeNull();
    f.h.clock.advance(1);
    const claim = (await f.engine.claim())!;
    expect(claim.job.attempt).toBe(1);
    await f.engine.execute(claim);
    expect(runBatch).toHaveBeenCalledOnce();
  });
});

describe("Outbox generation replacement", () => {
  const type = "storage.copy_order_file";
  const safeReason = "STORAGE_PROVIDER_RETRY";

  it("permits only a matching terminal failure inaccessible to generic Jobs retry", async () => {
    const f = fixture();
    f.jobs.register(type, async () => ({ outcome: "failed", reasonCode: safeReason, retryable: false }));
    const { jobId } = await f.jobs.enqueue(type, {});
    const canReplace = (expected = type) => t.db.transaction((tx) => f.admin.canReplaceFailedOutboxJob(jobId, expected, tx));
    expect(await canReplace()).toBe(false);
    const claim = (await f.engine.claim())!;
    expect(await canReplace()).toBe(false);
    await f.engine.execute(claim);
    expect(await canReplace("storage.copy_backup")).toBe(false);
    expect(await canReplace()).toBe(true);
    await expect(f.admin.retry(f.operator, jobId)).rejects.toMatchObject({ reasonCode: "JOB_RETRY_UNSAFE" });
    expect(await f.admin.detail(f.operator, jobId)).toMatchObject({ state: "failed", allowRetry: false });
  });

  it("refuses automatic retries, generically retryable failures and an expired or unknown claim without rewriting them", async () => {
    const f = fixture();
    f.jobs.register<{ ambiguous?: boolean }>(type, async ({ payload }) => payload.ambiguous
      ? { outcome: "unknown", reasonCode: "STORAGE_COPY_UNCERTAIN" }
      : { outcome: "failed", reasonCode: safeReason, retryable: true });
    const first = await f.jobs.enqueue(type, {}, { maxAttempts: 2 });
    const canReplace = (jobId: string) => t.db.transaction((tx) => f.admin.canReplaceFailedOutboxJob(jobId, type, tx));
    await f.engine.execute((await f.engine.claim())!);
    expect(await canReplace(first.jobId)).toBe(false);
    expect(await f.admin.detail(f.operator, first.jobId)).toMatchObject({ state: "queued" });
    f.h.clock.advance(2_000);
    await f.engine.execute((await f.engine.claim())!);
    expect(await canReplace(first.jobId)).toBe(false);
    expect(await f.admin.detail(f.operator, first.jobId)).toMatchObject({ state: "failed", allowRetry: true });
    const second = await f.jobs.enqueue(type, { ambiguous: true });
    await f.engine.execute((await f.engine.claim())!);
    expect(await canReplace(second.jobId)).toBe(false);
    expect(await f.admin.detail(f.operator, second.jobId)).toMatchObject({ state: "unknown" });
    const third = await f.jobs.enqueue(type, {});
    await f.engine.claim();
    await expireLease(third.jobId);
    expect(await canReplace(third.jobId)).toBe(false);
    expect(await f.admin.detail(f.operator, third.jobId)).toMatchObject({ state: "running" });
  });
});

describe("Refund reconciliation support", () => {
  const refundPublicId = "01JD0000000000000000000001";

  it("stages one delayed lookup in the refund intent transaction without retaining a provider payload", async () => {
    const f = fixture();
    const lookup = vi.fn(async () => "settled" as const);
    const enqueue = registerRefundReconciliation(f.jobs, lookup);
    expect(REFUND_RECONCILE_JOB).toMatch(JOB_TYPE);
    await expect(t.db.transaction(async (tx) => {
      await enqueue(refundPublicId, tx);
      throw new Error("intent rollback");
    })).rejects.toThrow("intent rollback");
    expect(await f.engine.claim()).toBeNull();
    const runAt = new Date(f.h.clock.now().getTime() + 120_000);
    const first = await t.db.transaction((tx) => enqueue(refundPublicId, tx, { runAt, correlationId: "refund-lookup" }));
    expect(await t.db.transaction((tx) => enqueue(refundPublicId, tx))).toEqual(first);
    expect(await f.engine.claim()).toBeNull();
    const [stored] = await t.db.select().from(jobRuns);
    expect(stored).toMatchObject({ runAt, retrySafe: true, maxAttempts: REFUND_RECONCILE_MAX_ATTEMPTS });
    expect(stored?.payloadEnc).not.toContain(refundPublicId);
    f.h.clock.advance(120_000);
    await f.engine.execute((await f.engine.claim())!);
    expect(lookup).toHaveBeenCalledExactlyOnceWith(refundPublicId, expect.objectContaining({
      jobId: first.jobId, signal: expect.any(AbortSignal), correlationId: "refund-lookup", assertStillOwned: expect.any(Function),
    }));
    expect(await f.admin.detail(f.operator, first.jobId)).toMatchObject({ state: "completed" });
  });

  it("uses bounded backoff on inconclusive lookups and never exposes a generic retry after exhaustion", async () => {
    const f = fixture();
    const lookup = vi.fn(async () => "pending" as const);
    const enqueue = registerRefundReconciliation(f.jobs, lookup);
    const { jobId } = await t.db.transaction((tx) => enqueue(refundPublicId, tx));
    for (let attempt = 1; attempt <= REFUND_RECONCILE_MAX_ATTEMPTS; attempt += 1) {
      await f.engine.execute((await f.engine.claim())!);
      const row = await f.admin.detail(f.operator, jobId);
      expect(row).toMatchObject({ attempt, state: attempt < REFUND_RECONCILE_MAX_ATTEMPTS ? "queued" : "failed" });
      f.h.clock.advance(3_600_000);
    }
    expect(await f.engine.claim()).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(REFUND_RECONCILE_MAX_ATTEMPTS);
    expect(await f.admin.detail(f.operator, jobId)).toMatchObject({
      state: "failed", reasonCode: "REFUND_RECONCILE_EXHAUSTED", allowRetry: false,
    });
  });

  it("refuses malformed payloads and supplies a live writer fence for local settlement", async () => {
    const f = fixture();
    const publish = vi.fn();
    const lookup = vi.fn(async (_id: string, context: RefundReconcileContext) => {
      await expireLease(context.jobId);
      await t.db.transaction(async (tx) => {
        await context.assertStillOwned(tx);
        publish();
      });
      return "settled" as const;
    });
    const enqueue = registerRefundReconciliation(f.jobs, lookup);
    const malformed = await f.jobs.enqueue(REFUND_RECONCILE_JOB, { refundPublicId, unexpected: true });
    await f.engine.execute((await f.engine.claim())!);
    expect(await f.admin.detail(f.operator, malformed.jobId)).toMatchObject({ reasonCode: "REFUND_RECONCILE_INVALID_JOB" });
    expect(lookup).not.toHaveBeenCalled();
    await t.db.transaction((tx) => enqueue(refundPublicId, tx));
    const claim = (await f.engine.claim())!;
    await f.engine.execute(claim);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(claim.job.signal.aborted).toBe(true);
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("Customer maintenance policy", () => {
  const immediate = { enabled: true, message: "", startsAt: null, endsAt: null, expectedVersion: 0 } as const;

  it("keeps future messages private and enforces inclusive start, exclusive end independently of worker drain", async () => {
    const f = fixture({}, true);
    const start = new Date(f.h.clock.now().getTime() + 1_000).toISOString();
    const end = new Date(f.h.clock.now().getTime() + 2_000).toISOString();
    expect(await f.admin.maintenance.customerAccess()).toEqual(inactiveCustomerAccess);
    await f.admin.setMaintenance(f.operator, { active: true, expectedActive: false });
    expect(await f.admin.maintenance.customerAccess()).toEqual(inactiveCustomerAccess);
    expect(await f.admin.setCustomerMaintenance(f.operator, { ...immediate, startsAt: start, endsAt: end, message: "  Planned servicing  " }))
      .toMatchObject({ phase: "scheduled", version: 1, message: "Planned servicing" });
    f.h.clock.advance(999);
    expect(await t.db.transaction((tx) => f.admin.maintenance.customerAccess(tx))).toEqual(inactiveCustomerAccess);
    f.h.clock.advance(1);
    expect(await t.db.transaction((tx) => f.admin.maintenance.customerAccess(tx)))
      .toEqual({ active: true, message: "Planned servicing", expectedEnd: end });
    f.h.clock.advance(1_000);
    expect(await f.admin.maintenance.customerAccess()).toEqual(inactiveCustomerAccess);
    expect(await f.admin.customerMaintenance(f.operator)).toMatchObject({ phase: "ended", version: 1 });
    expect(await f.admin.maintenanceBanner()).toMatchObject({ active: true });
    const [event] = await t.db.select().from(auditEvents).where(eq(auditEvents.eventName, "job.customer_maintenance.changed"));
    expect(event).toMatchObject({ reasonCode: "CUSTOMER_MAINTENANCE_CONFIGURED",
      attributes: { enabled: true, starts_at: start, ends_at: end } });
    expect(Object.keys(event!.attributes).sort()).toEqual(["enabled", "ends_at", "starts_at"]);
    expect(customerMaintenanceNotice(event!.attributes, "https://portal.example.test")).toEqual({
      windowLabel: `${start.slice(0, 10)} ${start.slice(11, 19)} UTC to ${end.slice(0, 10)} ${end.slice(11, 19)} UTC`,
      summary: expect.stringContaining("Check the portal for current status."),
      link: "https://portal.example.test/sign-in",
    });
  });

  it("rejects unsafe text and invalid dates, and rechecks the persisted actor and step-up before writing", async () => {
    const f = fixture();
    await expect(f.admin.setCustomerMaintenance(fakePrincipal({ role: "staff" }), immediate)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(f.admin.setCustomerMaintenance(fakePrincipal({ role: "admin" }), immediate)).rejects.toMatchObject({ code: "STEP_UP_REQUIRED" });
    await expect(f.admin.setCustomerMaintenance(f.operator, { ...immediate, message: "<b>Not plain text</b>" }))
      .rejects.toMatchObject({ reasonCode: "CUSTOMER_MAINTENANCE_MESSAGE_INVALID" });
    await expect(f.admin.setCustomerMaintenance(f.operator, { ...immediate, startsAt: "2026-02-30T10:00:00Z" }))
      .rejects.toMatchObject({ reasonCode: "CUSTOMER_MAINTENANCE_TIME_INVALID" });
    await expect(f.admin.setCustomerMaintenance(f.operator, { ...immediate, endsAt: f.h.clock.now().toISOString() }))
      .rejects.toMatchObject({ reasonCode: "CUSTOMER_MAINTENANCE_WINDOW_INVALID" });
    f.assertCurrent.mockResolvedValueOnce({ pendingSteps: [], role: "admin", stepUpAt: new Date(0), mfaVerifiedAt: f.h.clock.now() });
    await expect(f.admin.setCustomerMaintenance(f.operator, immediate)).rejects.toMatchObject({ code: "STEP_UP_REQUIRED" });
    f.assertCurrent.mockRejectedValueOnce(forbidden("SESSION_NOT_CURRENT"));
    await expect(f.admin.setCustomerMaintenance(f.operator, immediate)).rejects.toMatchObject({ reasonCode: "SESSION_NOT_CURRENT" });
    expect(await f.admin.maintenance.customerAccess()).toEqual(inactiveCustomerAccess);
    expect(f.h.audit.named("job.customer_maintenance.changed")).toHaveLength(0);
  });

  it("serializes versioned changes, fails closed on audit loss, and reads the latest policy despite an older transaction snapshot", async () => {
    const f = fixture();
    const peer = fixture();
    f.h.audit.failRecords = true;
    await expect(f.admin.setCustomerMaintenance(f.operator, immediate)).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    expect(await t.db.select().from(customerMaintenance)).toHaveLength(0);
    f.h.audit.failRecords = false;

    await t.db.transaction(async (tx) => {
      expect(await tx.select().from(customerMaintenance)).toHaveLength(0);
      const writes = await Promise.allSettled([
        f.admin.setCustomerMaintenance(f.operator, { ...immediate, message: "First" }),
        peer.admin.setCustomerMaintenance(peer.operator, { ...immediate, message: "Second" }),
      ]);
      expect(writes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(writes.find((result) => result.status === "rejected")).toMatchObject({ reason: { reasonCode: "CUSTOMER_MAINTENANCE_CHANGED" } });
      expect(await f.admin.maintenance.customerAccess(tx)).toMatchObject({ active: true, expectedEnd: null });
    }, { isolationLevel: "repeatable read" });

    const current = await f.admin.customerMaintenance(f.operator);
    expect(await f.admin.setCustomerMaintenance(f.operator, { ...immediate, message: current.message, expectedVersion: 1 }))
      .toMatchObject({ version: 1 });
    expect([...f.h.audit.named("job.customer_maintenance.changed"), ...peer.h.audit.named("job.customer_maintenance.changed")]).toHaveLength(1);
    expect(await f.admin.setCustomerMaintenance(f.operator, { ...immediate, enabled: false, expectedVersion: 1 }))
      .toMatchObject({ phase: "off", version: 2 });
    expect(await f.admin.maintenance.customerAccess()).toEqual(inactiveCustomerAccess);
  });
});

describe("MySQL durable job leases", () => {
  it("claims once across independent concurrent workers and persists the claim audit atomically", async () => {
    const f = fixture();
    const second = fixture();
    f.jobs.register("test.one", done);
    second.jobs.register("test.one", done);
    const { jobId } = await f.jobs.enqueue("test.one", { value: "example" });
    const claimed = (await Promise.all([f.engine.claim(), second.engine.claim()])).filter(Boolean);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.job).toMatchObject({ jobId, fencingToken: 1, attempt: 1 });
    const audits = [...f.h.audit.events, ...second.h.audit.events].filter(({ eventName }) => eventName === "job.claimed");
    expect(audits).toEqual([expect.objectContaining({ jobId, correlationId: jobId, outcome: "attempted" })]);
    expect([...f.h.audit.recordedInTx, ...second.h.audit.recordedInTx].every(Boolean)).toBe(true);
    expect(await t.db.select().from(jobAttempts)).toHaveLength(1);
  });

  it("uniques enqueue keys per type, rolls back caller transactions, and propagates worker correlation", async () => {
    const f = fixture();
    const handler = vi.fn(async () => {
      expect(getRequestContext()).toMatchObject({ origin: "worker", correlationId: "workflow_abc" });
      return { outcome: "completed" as const };
    });
    f.jobs.register("test.one", handler);
    f.jobs.register("test.two", done);
    const key = { idempotencyKey: "scoped-key" };
    const [a, b] = await runWithRequestContext(newRequestContext("test", { correlationId: "workflow_abc" }),
      () => Promise.all([f.jobs.enqueue("test.one", 1, key), f.jobs.enqueue("test.one", 2, key)]));
    expect(a.jobId).toBe(b.jobId);
    expect((await f.jobs.enqueue("test.two", 1, { ...key, runAt: new Date(f.h.clock.now().getTime() + 10_000) })).jobId).not.toBe(a.jobId);
    await expect(t.db.transaction(async (tx) => {
      await f.jobs.enqueue("test.one", "rolled back", { idempotencyKey: "unique" }, tx);
      throw new Error("synthetic rollback");
    })).rejects.toThrow("synthetic rollback");
    const claim = await f.engine.claim();
    await f.engine.execute(claim!);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await t.db.select().from(jobRuns)).toHaveLength(2);
  });

  it("uses lease renewal, retries an explicit safe type, and fences stale publication", async () => {
    const f = fixture();
    const fast = fixture();
    fast.jobs.register("test.safe", done, { retrySafe: true });
    f.jobs.register("test.safe", done, { retrySafe: true });
    const { jobId } = await f.jobs.enqueue("test.safe", { payload: 1 });
    const old = (await f.engine.claim())!;
    fast.h.clock.advance(120_000);
    expect(await fast.engine.reap()).toBe(0);
    const [before] = await t.db.select({ leaseUntil: jobRuns.leaseUntil }).from(jobRuns).where(eq(jobRuns.publicId, jobId));
    await t.db.update(jobRuns).set({ leaseUntil: sql`UTC_TIMESTAMP(3) + INTERVAL 10 SECOND` }).where(eq(jobRuns.publicId, jobId));
    f.h.clock.advance(120_000);
    await f.engine.heartbeat(old);
    const [renewed] = await t.db.select({ leaseUntil: jobRuns.leaseUntil }).from(jobRuns).where(eq(jobRuns.publicId, jobId));
    expect(old.job.signal.aborted).toBe(false);
    expect(Math.abs(renewed!.leaseUntil!.getTime() - before!.leaseUntil!.getTime())).toBeLessThan(10_000);
    expect(await f.engine.reap()).toBe(0);
    await expireLease(jobId);
    expect(await f.engine.reap()).toBe(1);
    expect(await f.engine.claim()).toBeNull();
    f.h.clock.advance(2_000);
    const newer = (await f.engine.claim())!;
    expect(newer.job).toMatchObject({ jobId, fencingToken: 2, attempt: 2 });
    await expect(t.db.transaction(async (tx) => {
      await old.job.assertStillOwned(tx);
      await tx.update(jobRuns).set({ reasonCode: "STALE_WRITE" }).where(eq(jobRuns.publicId, jobId));
    })).rejects.toMatchObject({ reasonCode: "JOB_LEASE_LOST" });
    expect(old.job.signal.aborted).toBe(true);
    expect(await f.engine.finish(old, { outcome: "completed" })).toBe(false);
    expect(await f.engine.finish(newer, { outcome: "completed" })).toBe(true);
    const detail = await f.admin.detail(f.operator, jobId);
    expect(detail.state).toBe("completed");
    expect(detail.attempts.map(({ state }) => state)).toEqual(["completed", "interrupted"]);
    expect(detail.reasonCode).not.toBe("STALE_WRITE");
  });

  it("marks expired unsafe jobs unknown, holds drain, and never retries an unknown even after operator attestation", async () => {
    const f = fixture();
    f.jobs.register("test.unsafe", done);
    const a = await f.jobs.enqueue("test.unsafe", null);
    const old = (await f.engine.claim())!;
    await f.admin.setMaintenance(f.operator, { active: true, expectedActive: false });
    await f.jobs.enqueue("test.unsafe", null);
    expect(await f.engine.claim()).toBeNull();
    expect(await f.admin.workerMaintenance(f.operator)).toMatchObject({ state: "draining", running: 1 });
    await expireLease(a.jobId);
    expect(await f.engine.reap()).toBe(1);
    await f.engine.heartbeat(old);
    expect(old.job.signal.aborted).toBe(true);
    expect(await f.admin.workerMaintenance(f.operator)).toMatchObject({ state: "unproved", unresolved: 1 });
    expect(await f.admin.maintenanceBanner()).toMatchObject({ active: true });
    await expect(f.admin.setMaintenance(f.operator, { active: false, expectedActive: true })).rejects.toMatchObject({ reasonCode: "JOB_DRAIN_UNPROVED" });
    await expect(f.admin.retry(f.operator, a.jobId)).rejects.toMatchObject({ code: "MAINTENANCE" });
    await f.admin.acknowledgeUnknown(f.operator, a.jobId);
    expect(await f.admin.workerMaintenance(f.operator)).toMatchObject({ state: "queue_drained", unresolved: 0 });
    await f.admin.setMaintenance(f.operator, { active: false, expectedActive: true });
    await expect(f.admin.retry(f.operator, a.jobId)).rejects.toMatchObject({ reasonCode: "JOB_RETRY_UNSAFE" });
    expect(await f.admin.detail(f.operator, a.jobId)).toMatchObject({ state: "unknown", reconciledAt: expect.any(Date) });
  });

  it("preserves uncertainty when an interrupted retry-safe job is canceled or fails after retry", async () => {
    const f = fixture();
    f.jobs.register("test.safe", async () => ({ outcome: "failed", retryable: false, reasonCode: "NEW_ATTEMPT_REJECTED" }), { retrySafe: true });
    const { jobId: canceled } = await f.jobs.enqueue("test.safe", "cancel");
    const { jobId: failed } = await f.jobs.enqueue("test.safe", "fail");
    await f.engine.claim();
    await f.engine.claim();
    await expireLease();
    expect(await f.engine.reap()).toBe(2);
    await f.admin.setMaintenance(f.operator, { active: true, expectedActive: false });
    expect(await f.admin.workerMaintenance(f.operator)).toMatchObject({ state: "unproved", unresolved: 2 });
    expect(await f.admin.cancel(f.operator, canceled)).toMatchObject({ state: "unknown" });
    expect(await f.admin.detail(f.operator, canceled)).toMatchObject({ reasonCode: "JOB_RETRY_CANCELED_UNCERTAIN" });
    await f.admin.cancel(f.operator, failed);
    await f.admin.acknowledgeUnknown(f.operator, canceled);
    await f.admin.acknowledgeUnknown(f.operator, failed);
    await f.admin.setMaintenance(f.operator, { active: false, expectedActive: true });
    const { jobId } = await f.jobs.enqueue("test.safe", "fails after interruption");
    await f.engine.claim();
    await expireLease(jobId);
    await f.engine.reap();
    f.h.clock.advance(2_000);
    await f.engine.execute((await f.engine.claim())!);
    expect(await f.admin.detail(f.operator, jobId)).toMatchObject({
      state: "unknown", reasonCode: "JOB_PRIOR_ATTEMPT_UNKNOWN",
      attempts: [{ state: "failed", reasonCode: "NEW_ATTEMPT_REJECTED" }, { state: "interrupted" }],
    });
  });

  it("does not persist a privilege-sensitive mutation when durable audit is unavailable", async () => {
    const f = fixture();
    f.jobs.register("test.one", done);
    const { jobId } = await f.jobs.enqueue("test.one", null);
    f.h.audit.failRecords = true;
    await expect(f.admin.cancel(f.operator, jobId)).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    await expect(f.admin.setMaintenance(f.operator, { active: true, expectedActive: false })).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    await expect(f.engine.claim()).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    expect((await f.admin.detail(f.operator, jobId)).state).toBe("queued");
    expect(await f.admin.isDraining()).toBe(false);
    expect(await t.db.select().from(jobAttempts)).toHaveLength(0);
  });

  it("writes canonically correlated audit rows, and rolls the audit row back with its caller", async () => {
    const h = createTestDeps({ db: t.db });
    const jobs = createJobQueue({ ...h.deps, audit: createAuditEmitter(h.deps) });
    const engine = engineFor(jobs)!;
    jobs.register("test.audit", done);
    jobs.registerSchedule({ name: "test.tick", type: "test.audit", everyMs: 60_000 });
    await expect(t.db.transaction(async (tx) => {
      await jobs.enqueue("test.audit", null, { correlationId: "rollback_workflow" }, tx);
      throw new Error("caller refused");
    })).rejects.toThrow("caller refused");
    expect(await t.db.select().from(auditEvents)).toHaveLength(0);
    const { jobId } = await jobs.enqueue("test.audit", null, { correlationId: "workflow_persisted" });
    await engine.execute((await engine.claim())!);
    const events = await t.db.select().from(auditEvents).where(eq(auditEvents.correlationId, "workflow_persisted"));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventName: "job.enqueued", jobId, durability: "durable" }),
      expect.objectContaining({ eventName: "job.claimed", jobId, actorRole: "system", origin: "worker" }),
      expect.objectContaining({ eventName: "job.completed", jobId, actorRole: "system", origin: "worker" }),
    ]));
    expect(events).toHaveLength(3);
  });

  it("records a routine scheduled success in the ledger and operational log without any audit events", async () => {
    const h = createTestDeps({ db: t.db });
    const info = vi.fn();
    const jobs = createJobQueue({ ...h.deps, logger: { ...h.deps.logger, info }, audit: createAuditEmitter(h.deps) });
    const engine = engineFor(jobs)!;
    jobs.register("test.scheduled", async () => ({
      outcome: "completed", safeCounts: { checked: 2, negative: -1, "unsafe.label": 9 },
    }));
    jobs.registerSchedule({ name: "test.tick", type: "test.scheduled", everyMs: 60_000 });
    await engine.scheduleTick();
    const claim = (await engine.claim())!;
    expect(await t.db.select().from(auditEvents)).toHaveLength(0);
    expect(info).not.toHaveBeenCalled();
    await engine.execute(claim);
    expect(await t.db.select().from(auditEvents)).toHaveLength(0);
    const [row] = await t.db.select().from(jobRuns);
    expect(row).toMatchObject({ publicId: claim.job.jobId, state: "completed", attempt: 1, scheduleName: "test.tick" });
    expect(await t.db.select().from(jobAttempts)).toMatchObject([{ state: "completed", safeCounts: { checked: 2 } }]);
    expect(info).toHaveBeenCalledExactlyOnceWith("scheduled job completed", {
      component: "jobs.queue", jobId: claim.job.jobId, jobType: "test.scheduled",
      scheduleName: "test.tick", scheduleSlot: row!.scheduleSlot!.toISOString(),
      correlationId: claim.job.correlationId, durationMs: expect.any(Number), safeCounts: { checked: 2 },
    });
  });

  it("writes a standalone, durable failure for a scheduled tick without enqueue or claim audit", async () => {
    const h = createTestDeps({ db: t.db });
    const jobs = createJobQueue({ ...h.deps, audit: createAuditEmitter(h.deps) });
    const engine = engineFor(jobs)!;
    jobs.register("test.scheduled", async () => ({ outcome: "failed", reasonCode: "TICK_FAILED", retryable: false }));
    jobs.registerSchedule({ name: "test.tick", type: "test.scheduled", everyMs: 60_000 });
    await engine.scheduleTick();
    const claim = (await engine.claim())!;
    await engine.execute(claim);
    const [row] = await t.db.select().from(jobRuns);
    expect(row).toMatchObject({ state: "failed", allowRetry: false });
    expect(await t.db.select().from(auditEvents)).toMatchObject([{
      eventName: "job.failed", outcome: "failed", reasonCode: "TICK_FAILED", actorRole: "system",
      jobId: claim.job.jobId, correlationId: claim.job.correlationId, durability: "durable",
      attributes: { job_type: "test.scheduled", schedule_key: "test.tick", schedule_slot: row!.scheduleSlot!.toISOString(), attempt: 1 },
    }]);
  });

  it("keeps automatic retry, subsequent claim and completion audited for a scheduled job", async () => {
    const f = fixture();
    f.jobs.register("test.scheduled", async ({ attempt }) => attempt === 1
      ? { outcome: "failed", reasonCode: "TICK_RETRY", retryable: true } : { outcome: "completed" });
    f.jobs.registerSchedule({ name: "test.tick", type: "test.scheduled", everyMs: 60_000 });
    await f.engine.scheduleTick();
    await f.engine.execute((await f.engine.claim())!);
    f.h.clock.advance(2_000);
    await f.engine.execute((await f.engine.claim())!);
    expect(f.h.audit.events.map(({ eventName, attributes }) => [eventName, attributes?.attempt])).toEqual([
      ["job.failed", 1], ["job.retry.queued", 1], ["job.claimed", 2], ["job.completed", 2],
    ]);
    expect(f.h.audit.recordedInTx).toEqual([true, true, true, true]);
  });

  it("reconciles an expired outbox claim atomically without replaying it", async () => {
    const h = createTestDeps({ db: t.db });
    const audit = createAuditEmitter(h.deps);
    const jobs = createJobQueue({ ...h.deps, audit });
    const admin = createJobsAdmin({ ...h.deps, jobs, audit });
    const engine = engineFor(jobs)!;
    jobs.register("test.outbox", done, { retrySafe: true });
    const inspect = (id: string) => t.db.transaction((tx) => admin.reconcileOutboxJob(id, tx));
    expect(await inspect("01M7WGMXNDR7EDAAKVG8XQVQYT")).toEqual({ state: "missing" });
    const { jobId } = await jobs.enqueue("test.outbox", null);
    expect(await inspect(jobId)).toEqual({ state: "queued_live" });
    const claim = (await engine.claim())!;
    expect(await t.db.transaction((tx) => admin.reconcileOutboxJob(jobId, tx, { cancelQueued: true })))
      .toEqual({ state: "running_live" });
    await expireLease(jobId);
    await expect(t.db.transaction(async (tx) => {
      expect(await admin.reconcileOutboxJob(jobId, tx)).toEqual({ state: "settled_unknown" });
      throw new Error("outbox relationship changed");
    })).rejects.toThrow("outbox relationship changed");
    expect(await t.db.select().from(jobRuns)).toMatchObject([{ state: "running" }]);
    expect(await t.db.select().from(jobAttempts)).toMatchObject([{ state: "running" }]);
    expect(await t.db.select().from(auditEvents)).toHaveLength(2);
    expect(await inspect(jobId)).toEqual({ state: "settled_unknown" });
    expect(await inspect(jobId)).toEqual({ state: "terminal", jobState: "unknown" });
    expect(await engine.finish(claim, { outcome: "completed" })).toBe(false);
    expect(await t.db.select().from(jobRuns)).toMatchObject([{
      state: "unknown", reasonCode: "JOB_LEASE_EXPIRED", leaseUntil: null, allowRetry: false,
    }]);
    expect(await t.db.select().from(jobAttempts)).toMatchObject([{
      state: "interrupted", reasonCode: "JOB_LEASE_EXPIRED",
    }]);
    expect(await t.db.select().from(auditEvents)).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventName: "job.lease.expired", jobId, actorRole: "system", durability: "durable" }),
      expect.objectContaining({ eventName: "job.unknown", jobId, actorRole: "system", durability: "durable" }),
    ]));
  });

  it("cancels queued outbox jobs without erasing uncertain effects from earlier attempts", async () => {
    const f = fixture();
    f.jobs.register("test.outbox", done, { retrySafe: true });
    const cancel = (id: string) => t.db.transaction((tx) => f.admin.reconcileOutboxJob(id, tx, { cancelQueued: true }));
    const plain = await f.jobs.enqueue("test.outbox", null);
    f.h.audit.failRecords = true;
    await expect(cancel(plain.jobId)).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    f.h.audit.failRecords = false;
    expect(await cancel(plain.jobId)).toEqual({ state: "canceled_queued" });
    expect(await cancel(plain.jobId)).toEqual({ state: "terminal", jobState: "canceled" });
    const interrupted = await f.jobs.enqueue("test.outbox", null);
    await f.engine.claim();
    await expireLease(interrupted.jobId);
    expect(await f.engine.reap()).toBe(1);
    expect(await cancel(interrupted.jobId)).toEqual({ state: "canceled_queued" });
    expect(await cancel(interrupted.jobId)).toEqual({ state: "terminal", jobState: "unknown" });
    expect(await t.db.select().from(jobRuns).where(eq(jobRuns.publicId, interrupted.jobId))).toMatchObject([{
      state: "unknown", reasonCode: "JOB_RETRY_CANCELED_UNCERTAIN", payloadEnc: null, interruptionPending: false,
    }]);
    expect(f.h.audit.named("job.canceled")).toMatchObject([
      { jobId: plain.jobId, actor: { role: "system" } },
      { jobId: interrupted.jobId, actor: { role: "system" } },
    ]);
  });

  it("rejects wrong roles, remediation sessions, missing or future step-up, and bad pagination", async () => {
    const f = fixture();
    await expect(f.admin.list(fakePrincipal({ role: "staff" }), {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(f.admin.list(fakePrincipal({ role: "admin", state: "remediation" }), {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(f.admin.setMaintenance(fakePrincipal({ role: "admin" }), { active: true, expectedActive: false })).rejects.toMatchObject({ code: "STEP_UP_REQUIRED" });
    const future = fakePrincipal({ role: "admin", stepUpAt: new Date(f.h.clock.now().getTime() + 60_000) });
    await expect(f.admin.capture(future, "not-a-public-id")).rejects.toMatchObject({ code: "STEP_UP_REQUIRED" });
    await expect(f.admin.list(f.operator, { limit: 101 })).rejects.toMatchObject({ reasonCode: "INVALID_PAGE_LIMIT" });
    expect(f.h.audit.named("job.admin.denied")).toHaveLength(4);
  });

  it("enforces router validation and keeps the public maintenance response free of operational details", async () => {
    const f = fixture();
    f.h.services.jobAdmin = {
      ...f.admin, startWorker: async () => { throw new Error("unexpected worker start"); },
      registerMailTransport: () => {}, registerMailTemplateStore: () => {},
      getBuiltinMailTemplates: () => [], getMailSenderIdentity: async () => null, getMailReadiness: async () => ({ ready: false }),
    };
    const caller = createCallerFactory(jobsRouter);
    const publicContext = {
      services: f.h.services, request: newRequestContext("test"),
      transport: { issue: () => {}, clear: () => {} },
    };
    await expect(caller({ ...publicContext, session: null }).admin.list({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller({ ...publicContext, session: f.operator }).admin.detail({ publicId: "invalid" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    await f.admin.setMaintenance(f.operator, { active: true, expectedActive: false });
    expect(await caller({ ...publicContext, session: null }).maintenanceBanner()).toEqual({
      active: true, message: "Maintenance is in progress. Some operations are temporarily unavailable.",
    });
    const anonymous = caller({ ...publicContext, session: null });
    const operator = caller({ ...publicContext, session: f.operator });
    const endAll = vi.fn(async () => ({ ended: 3 }));
    f.h.services.identity.sessions.endAllCustomers = endAll;
    expect(await anonymous.maintenance.customerAccess()).toEqual(inactiveCustomerAccess);
    await expect(anonymous.admin.customerMaintenance()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(operator.admin.endCustomerSessions()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(endAll).not.toHaveBeenCalled();
    await f.admin.setCustomerMaintenance(f.operator, { enabled: true, startsAt: null, endsAt: null,
      message: "Planned work", expectedVersion: 0 });
    expect(await anonymous.maintenance.customerAccess()).toEqual({ active: true, message: "Planned work", expectedEnd: null });
    await expect(anonymous.admin.endCustomerSessions()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller({ ...publicContext, session: fakePrincipal({ role: "admin" }) }).admin.endCustomerSessions())
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(endAll).not.toHaveBeenCalled();
    expect(await operator.admin.endCustomerSessions()).toEqual({ ended: 3 });
    expect(endAll).toHaveBeenCalledExactlyOnceWith(f.operator, { reasonCode: "CUSTOMER_MAINTENANCE" });
  });

  it("permits one manual attempt after exhausted retryable failure, without resetting the fence", async () => {
    const f = fixture();
    f.jobs.register("test.rejected", async () => ({ outcome: "failed", reasonCode: "REJECTED", retryable: true }));
    const { jobId } = await f.jobs.enqueue("test.rejected", null, { maxAttempts: 1 });
    await f.engine.execute((await f.engine.claim())!);
    expect(await f.admin.detail(f.operator, jobId)).toMatchObject({ state: "failed", allowRetry: true, attempt: 1 });
    await f.admin.retry(f.operator, jobId);
    const retried = (await f.engine.claim())!;
    expect(retried.job).toMatchObject({ jobId, attempt: 2, fencingToken: 2 });
  });

  it("single-fires a slot across schedulers and skips missed slots after drain", async () => {
    const a = fixture();
    const b = fixture();
    for (const f of [a, b]) {
      f.jobs.register("test.scheduled", done);
      f.jobs.registerSchedule({ name: "test.every_minute", type: "test.scheduled", everyMs: 60_000 });
    }
    await Promise.all([a.engine.scheduleTick(), b.engine.scheduleTick()]);
    await a.admin.setMaintenance(a.operator, { active: true, expectedActive: false });
    a.h.clock.advance(300_000);
    b.h.clock.advance(300_000);
    await Promise.all([a.engine.scheduleTick(), b.engine.scheduleTick()]);
    expect(await t.db.select().from(jobRuns)).toHaveLength(1);
    await a.admin.setMaintenance(a.operator, { active: false, expectedActive: true });
    await Promise.all([a.engine.scheduleTick(), b.engine.scheduleTick()]);
    expect(await t.db.select().from(jobRuns)).toHaveLength(2);
  });

  it("waits for cooperative active work before worker stop resolves", async () => {
    const f = fixture();
    const started = latch();
    const release = latch();
    f.jobs.register("test.active", async () => {
      started.resolve();
      await release.promise;
      return { outcome: "completed" };
    });
    await f.jobs.enqueue("test.active", null);
    const worker = startWorker(f.engine);
    try {
      await started.promise;
      let settled = false;
      const stop = worker.stop().finally(() => { settled = true; });
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      release.resolve();
      await stop;
      expect((await f.admin.list(f.operator, {})).items[0]?.state).toBe("completed");
    } finally {
      release.resolve();
      await worker.stop();
    }
  });

  it("refuses to confirm shutdown and marks still-unsettled work unknown", async () => {
    const f = fixture();
    const started = latch();
    const release = latch();
    const returned = latch();
    let signal: AbortSignal | undefined;
    f.jobs.register("test.stubborn", async (job) => {
      signal = job.signal;
      started.resolve();
      await release.promise;
      returned.resolve();
      return { outcome: "completed" };
    });
    const { jobId } = await f.jobs.enqueue("test.stubborn", null);
    const worker = startWorker(f.engine, { grace: 20, abort: 100 });
    try {
      await started.promise;
      await expect(worker.stop()).rejects.toMatchObject({ reasonCode: "WORKER_STOP_UNPROVED" });
      expect(signal?.aborted).toBe(true);
      expect(await f.admin.detail(f.operator, jobId)).toMatchObject({ state: "unknown" });
    } finally {
      release.resolve();
      await returned.promise;
    }
  });
});

describe("MySQL transactional mail outbox", () => {
  const sender = { fromAddress: "legacy@example.test", fromName: "ReadyPackets" };
  const input = {
    template: "test.mail", to: { userId: 22 },
    vars: { link: "https://portal.example.test/preview-only", name: "<img onerror=example>" }, idempotencyKey: "mail-key",
  };
  function setDelivery(f: ReturnType<typeof fixture>, outcome: SmtpDeliveryResult["outcome"], retryable?: boolean) {
    const send = vi.fn(async (_message: MailTransportMessage): Promise<SmtpDeliveryResult> => ({ outcome, retryable }));
    const findRecipient = vi.fn(async () => ({ email: "current@example.test", status: "active" }));
    f.mail.registerDelivery({ findRecipient, getLegacySender: async () => sender });
    f.mail.registerMailTransport({ key: "smtp", isConfigured: async () => true, send });
    f.mailer.registerTemplate({
      key: "test.mail", vars: ["link", "name"], sensitiveVars: ["link"],
      subject: () => "Test notification", text: ({ name, link }) => `${name}\n${link}`,
    });
    return { send, findRecipient };
  }

  it("deduplicates notice mail by version, user and reminder and projects safe progress states", async () => {
    const f = fixture();
    const { send } = setDelivery(f, "accepted");
    const { kind, policyVersionPublicId, recipientUserId } = policyMailInput;
    const key = policyNoticeMailKey({ kind, policyVersionPublicId, recipientUserId });
    const reminderKey = policyNoticeMailKey({ kind, policyVersionPublicId, recipientUserId, reminderPublicId });
    const missingKey = policyNoticeMailKey({ kind: "warning", policyVersionPublicId, recipientUserId });
    await enqueuePolicyNoticeMail(f.mailer, policyMailInput);
    await enqueuePolicyNoticeMail(f.mailer, policyMailInput);
    await enqueuePolicyNoticeMail(f.mailer, { ...policyMailInput, reminderPublicId });
    expect(await f.admin.policyNoticeMailStates([key, reminderKey, missingKey])).toEqual(new Map([[key, "queued"], [reminderKey, "queued"]]));
    await f.engine.execute((await f.engine.claim())!);
    await t.db.update(mailOutbox).set({ state: "unknown" }).where(eq(mailOutbox.state, "queued"));
    expect(await f.admin.policyNoticeMailStates([key, reminderKey])).toEqual(new Map([[key, "sent"], [reminderKey, "failed"]]));
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      text: expect.stringContaining("Updated summary."), html: expect.stringContaining('lang="en"'),
    }));
    await expect(f.admin.policyNoticeMailStates(Array.from({ length: 251 }, () => key))).rejects.toMatchObject({
      reasonCode: "POLICY_NOTICE_MAIL_KEYS_INVALID",
    });
  });

  it("encrypts receipt PDF bytes and never puts the PDF or its filename in retained content, the audit copy or durable audit", async () => {
    const f = fixture({}, true);
    const { send } = setDelivery(f, "accepted");
    const auditTo = "audit@example.test";
    await f.h.settings.set(MAIL_RETAIN_CONTENT.key, true);
    await f.h.settings.set(MAIL_AUDIT_COPY.key, { enabled: true, address: auditTo });
    await t.db.insert(mailAuditVerification).values({
      id: 1, addressHash: f.h.deps.crypto.blindIndex(auditTo, "mail.audit_copy.address"), verifiedAt: f.h.clock.now(),
    });
    await expect(t.db.transaction(async (tx) => {
      await enqueuePaymentReceipt(f.mailer, receiptInput, tx);
      throw new Error("receipt rollback");
    })).rejects.toThrow("receipt rollback");
    await enqueuePaymentReceipt(f.mailer, receiptInput);
    await enqueuePaymentReceipt(f.mailer, receiptInput);
    const rows = await t.db.select().from(mailOutbox);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    const ciphertext = row.payloadEnc!;
    expect(ciphertext).not.toContain(receiptInput.pdf.toString("base64"));
    expect(ciphertext).not.toContain(receiptInput.receiptNumber);
    expect(f.h.deps.crypto.decrypt(ciphertext, `mail_outbox.payload_enc:${row.publicId}`)).toContain(receiptInput.pdf.toString("base64"));
    await f.engine.execute((await f.engine.claim())!);
    expect(send.mock.calls.map(([message]) => [message.to, message.attachments])).toEqual([
      ["current@example.test", [{ filename: "RPR-2026-000032.pdf", contentType: "application/pdf", content: receiptInput.pdf }]],
      [auditTo, undefined],
    ]);
    const [sent] = await t.db.select().from(mailOutbox);
    expect(sent).toMatchObject({ state: "accepted", payloadEnc: null, captureEnc: null });
    const retained = f.h.deps.crypto.decrypt(sent!.contentEnc!, `mail_outbox.content_enc:${row.publicId}`);
    expect(retained).not.toMatch(/attachments|PRIVATE-RECEIPT|RPR-2026-000032/);
    expect(send.mock.calls[1]?.[0].text).not.toContain(receiptInput.receiptNumber);
    expect(JSON.stringify(await t.db.select().from(auditEvents))).not.toMatch(/contentBase64|PRIVATE-RECEIPT|RPR-2026-000032/);
    await enqueuePaymentReceipt(f.mailer, { ...receiptInput, resendRequestPublicId: reminderPublicId });
    await enqueuePaymentReceipt(f.mailer, { ...receiptInput, resendRequestPublicId: reminderPublicId });
    expect(await t.db.select().from(mailOutbox)).toHaveLength(2);
  });

  it("rejects unsupported attachments and omits the PDF and receipt number from development capture", async () => {
    const f = fixture({ config: { deploymentProfile: "test" } });
    const { send } = setDelivery(f, "accepted");
    const tooLarge = Buffer.alloc(RECEIPT_PDF_MAX_BYTES + 1);
    receiptInput.pdf.copy(tooLarge);
    await expect(enqueuePaymentReceipt(f.mailer, { ...receiptInput, pdf: Buffer.from("Not a PDF") }))
      .rejects.toMatchObject({ reasonCode: "INVALID_MAIL_ATTACHMENT" });
    const attachment = { filename: "RPR-2026-000032.pdf", contentType: "application/pdf", content: receiptInput.pdf } as const;
    await expect(f.mailer.enqueue({ ...input, attachments: [attachment] })).rejects.toMatchObject({ reasonCode: "INVALID_MAIL_ATTACHMENT" });
    const base = { template: PAYMENT_RECEIPT_TEMPLATE, to: { userId: 22 }, vars: { receiptNumber: receiptInput.receiptNumber }, idempotencyKey: "manual" };
    for (const attachments of [[{ ...attachment, content: tooLarge }], [attachment, attachment],
      [{ ...attachment, filename: "../RPR-2026-000032.pdf" }]]) {
      await expect(f.mailer.enqueue({ ...base, attachments })).rejects.toMatchObject({ reasonCode: "INVALID_MAIL_ATTACHMENT" });
    }
    const bounded = Buffer.alloc(RECEIPT_PDF_MAX_BYTES);
    receiptInput.pdf.copy(bounded);
    await f.h.settings.set(MAIL_CAPTURE.key, true);
    await expect(enqueuePaymentReceipt(f.mailer, { ...receiptInput, pdf: bounded })).resolves.toEqual({ attachment: "attached" });
    await f.engine.execute((await f.engine.claim())!);
    expect(send).not.toHaveBeenCalled();
    const [row] = await t.db.select().from(mailOutbox);
    expect(row).toMatchObject({ state: "captured", payloadEnc: null });
    const capture = await f.admin.capture(f.operator, row!.publicId);
    expect(JSON.stringify(capture)).not.toMatch(/attachments|PRIVATE-RECEIPT|RPR-2026-000032/);
  });

  it("sends an oversized receipt as a portal-only email with a safe link even after template customization", async () => {
    const f = fixture();
    const { send } = setDelivery(f, "accepted");
    f.mail.registerMailTemplateStore({ resolve: async (key) => key === PAYMENT_RECEIPT_TEMPLATE
      ? { key, vars: ["receiptNumber"], render: () => ({ subject: "Custom receipt", text: "Thank you.", html: "<p>Thank you.</p>" }) }
      : null });
    const pdf = Buffer.alloc(RECEIPT_PDF_MAX_BYTES + 1);
    receiptInput.pdf.copy(pdf);
    await expect(enqueuePaymentReceipt(f.mailer, { ...receiptInput, pdf })).resolves.toEqual({ attachment: "omitted_too_large" });
    const [queued] = await t.db.select().from(mailOutbox);
    const payload = f.h.deps.crypto.decrypt(queued!.payloadEnc!, `mail_outbox.payload_enc:${queued!.publicId}`);
    expect(payload).not.toMatch(/attachments|contentBase64|PRIVATE-RECEIPT/);
    await f.engine.execute((await f.engine.claim())!);
    const url = new URL("/invoices?tab=receipts", f.h.config.canonicalOrigin).href;
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      subject: "Custom receipt",
      text: expect.stringContaining(`Open Receipts in ReadyPackets: ${url}`),
      html: expect.stringContaining(`<a href="${url}">Open Receipts in ReadyPackets</a>`),
    }));
    expect(send.mock.calls[0]?.[0].attachments).toBeUndefined();
  });

  it("queues a single refund notice and redacts private refund data from retention and audit", async () => {
    const f = fixture({}, true);
    const ports = setDelivery(f, "accepted");
    registerRefundNotice(f.mailer);
    await f.h.settings.set(MAIL_RETAIN_CONTENT.key, true);
    await f.h.settings.set(MAIL_RETENTION_DAYS.key, 30);
    const refundReference = "01JD0000000000000000000001";
    const notice = {
      template: REFUND_NOTICE_TEMPLATE_KEY, to: { userId: 22 }, idempotencyKey: `refund-notice:${refundReference}`,
      vars: { orderReference: "SYNTHETIC-ORDER-123", refundAmount: "$24.00", refundReference },
    };
    await t.db.transaction((tx) => f.mailer.enqueue(notice, tx));
    await t.db.transaction((tx) => f.mailer.enqueue(notice, tx));
    await f.engine.execute((await f.engine.claim())!);
    expect(ports.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      to: "current@example.test",
      subject: "A refund was recorded for your ReadyPackets order",
      text: expect.stringContaining("A refund of $24.00 was recorded for your ReadyPackets order SYNTHETIC-ORDER-123."),
    }));
    const rows = await t.db.select().from(mailOutbox);
    expect(rows).toHaveLength(1);
    const kept = await f.admin.mailContent(f.operator, rows[0]!.publicId);
    expect(kept.text).toContain("A refund of [REDACTED] was recorded for your ReadyPackets order [REDACTED].");
    expect(kept.text).toContain("Refund reference: [REDACTED]");
    expect(JSON.stringify(await t.db.select().from(auditEvents))).not.toContain(refundReference);
  });

  it("deduplicates across transactions, encrypts variables, and holds when SMTP is unconfigured", async () => {
    const f = fixture();
    const ports = setDelivery(f, "not_configured");
    await Promise.all([f.mailer.enqueue(input), f.mailer.enqueue(input)]);
    const before = await t.db.select().from(mailOutbox);
    expect(before).toHaveLength(1);
    expect(before[0]?.payloadEnc).not.toContain(input.vars.link);
    await f.engine.execute((await f.engine.claim())!);
    expect(ports.send).toHaveBeenCalledTimes(1);
    expect(ports.findRecipient).toHaveBeenCalledWith(22);
    expect((await f.admin.listMail(f.operator, {})).items[0]).toMatchObject({
      state: "held", reasonCode: "MAIL_NOT_CONFIGURED", canResend: true,
    });
    expect(JSON.stringify(f.h.audit.events)).not.toContain(input.vars.link);
  });

  it("rejects unexpected variables and injected headers", async () => {
    const f = fixture();
    setDelivery(f, "accepted");
    f.mailer.registerTemplate({ key: "test.bad", vars: [], subject: () => "notification\r\nBcc: a@example.test", text: () => "test" });
    await expect(f.mailer.enqueue({ ...input, vars: { unexpected: true } })).rejects.toMatchObject({ reasonCode: "INVALID_MAIL_INPUT" });
    await expect(f.mailer.enqueue({ ...input, to: { address: "a@example.test\nb@example.test" } })).rejects.toMatchObject({ reasonCode: "INVALID_MAIL_INPUT" });
    await expect(f.mailer.enqueue({ ...input, template: "test.bad", vars: {} })).rejects.toMatchObject({ reasonCode: "INVALID_MAIL_RENDER" });
    expect(await t.db.select().from(mailOutbox)).toHaveLength(0);
  });

  it("wires the configured sender and legacy upgrade fallback through the Jobs SMTP adapter", async () => {
    const f = fixture();
    const send = vi.fn(async (_message: MailTransportMessage) => ({ outcome: "accepted" as const }));
    f.h.services.integrations = {
      smtp: {
        getConfig: async () => ({ ...sender, replyToAddress: "" }),
        getReadiness: async () => ({ enabled: true, configured: true, ready: true, state: "configured" }),
        send,
      },
    } as unknown as typeof f.h.services.integrations;
    const jobs = createJobsModule({ ...f.h.deps, jobs: f.jobs, mailer: f.mailer });
    expect(jobs.getBuiltinMailTemplates()).toContainEqual(expect.objectContaining({ key: REFUND_NOTICE_TEMPLATE_KEY }));
    await expect(jobs.getMailSenderIdentity()).resolves.toEqual(sender);
    const shared = { fromAddress: "shared@example.test", fromName: "Shared Ops", replyToAddress: "reply@example.test" };
    await f.h.settings.set(MAIL_SENDER.key, shared);
    await expect(jobs.getMailReadiness()).resolves.toEqual({ ready: true });
    f.mailer.registerTemplate({ key: input.template, vars: ["name", "link"], sensitiveVars: ["link"], subject: () => "Test", text: () => "Body" });
    await f.mailer.enqueue({ ...input, to: { address: "recipient@example.test" } });
    await f.engine.execute((await f.engine.claim())!);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ sender: shared, to: "recipient@example.test" }));
  });

  it("records SMTP acceptance, not delivery, with escaped HTML and purged data", async () => {
    const f = fixture();
    const ports = setDelivery(f, "accepted");
    await f.mailer.enqueue(input);
    await f.engine.execute((await f.engine.claim())!);
    expect(ports.send).toHaveBeenCalledWith(expect.objectContaining({ to: "current@example.test", html: expect.stringContaining("&lt;img onerror=example&gt;") }));
    const [row] = await t.db.select().from(mailOutbox);
    expect(row).toMatchObject({ state: "accepted", payloadEnc: null, reasonCode: "MAIL_SMTP_ACCEPTED" });
    await expect(f.admin.resend(f.operator, row!.publicId)).rejects.toMatchObject({ reasonCode: "MAIL_RESEND_UNSAFE" });
  });

  it("requires explicit verified duplicate-risk acceptance and records a new generation with durable original-job evidence", async () => {
    const f = fixture({}, true);
    const smtp = setDelivery(f, "unknown");
    await f.mailer.enqueue(input);
    await f.engine.execute((await f.engine.claim())!);
    const [row] = await t.db.select().from(mailOutbox);
    const id = row!.publicId;
    const options = { acknowledgeDuplicateRisk: true, expectedGeneration: 1 } as const;
    expect(row).toMatchObject({ state: "unknown", payloadEnc: expect.any(String), generation: 1 });
    expect((await f.admin.list(f.operator, {})).items[0]?.state).toBe("unknown");
    expect((await f.admin.listMail(f.operator, {})).items[0]?.canResend).toBe(true);
    expect(await f.engine.claim()).toBeNull();
    await expect(f.admin.resend(f.operator, id)).rejects.toMatchObject({ reasonCode: "MAIL_DUPLICATE_RISK_NOT_ACKNOWLEDGED" });
    await expect(f.admin.resend(fakePrincipal({ role: "admin" }), id, options)).rejects.toMatchObject({ code: "STEP_UP_REQUIRED" });
    f.assertCurrent.mockRejectedValueOnce(forbidden("SESSION_NOT_CURRENT"));
    await expect(f.admin.resend(f.operator, id, options)).rejects.toMatchObject({ reasonCode: "SESSION_NOT_CURRENT" });
    expect(smtp.send).toHaveBeenCalledTimes(1);
    const { jobId } = await f.admin.resend(f.operator, id, options);
    expect(jobId).not.toEqual(row!.jobPublicId);
    expect(smtp.send).toHaveBeenCalledTimes(1);
    expect((await f.admin.mailDetail(f.operator, id)).attempts).toMatchObject([
      { purpose: "manual_resend_after_unknown", generation: 2, state: "queued" },
      { purpose: "primary", generation: 1, state: "unknown" },
    ]);
    const [event] = await t.db.select().from(auditEvents).where(eq(auditEvents.eventName, "job.mail.resent_after_unknown"));
    expect(event).toMatchObject({ actorUserId: f.operator.userId, actorRole: "admin", jobId: row!.jobPublicId,
      attributes: { resent_job_public_id: jobId, generation: 2 } });
    await f.engine.execute((await f.engine.claim())!);
    await expect(f.admin.resend(f.operator, id, options)).rejects.toMatchObject({ reasonCode: "MAIL_RESEND_CHANGED" });
    expect(smtp.send).toHaveBeenCalledTimes(2);
  });

  it("refuses expired and purged unknown payloads while preserving the original unknown outcome", async () => {
    const f = fixture();
    setDelivery(f, "unknown");
    await f.mailer.enqueue(input);
    await f.engine.execute((await f.engine.claim())!);
    const [row] = await t.db.select().from(mailOutbox);
    const options = { acknowledgeDuplicateRisk: true } as const;
    f.h.clock.advance(row!.expiresAt.getTime() - f.h.clock.now().getTime());
    await expect(f.admin.resend({ ...f.operator, stepUpAt: f.h.clock.now() }, row!.publicId, options))
      .rejects.toMatchObject({ reasonCode: "MAIL_RESEND_UNSAFE" });
    await f.jobs.enqueue("jobs.mail.expire", {});
    await f.engine.execute((await f.engine.claim())!);
    expect((await t.db.select().from(mailOutbox))[0]).toMatchObject({ state: "unknown", payloadEnc: null });
    expect((await f.admin.listMail(f.operator, {})).items[0]?.canResend).toBe(false);
    await expect(f.admin.resend({ ...f.operator, stepUpAt: f.h.clock.now() }, row!.publicId, options))
      .rejects.toMatchObject({ reasonCode: "MAIL_RESEND_UNSAFE" });
  });

  it("preserves automation origin through a failed submission and operator resend, suppressing only those tap events", async () => {
    const f = fixture({}, true);
    setDelivery(f, "rejected", true);
    const onRecorded = vi.fn(async () => undefined);
    const audit = f.durableAudit!;
    audit.setTap({ listens: (name) => name === "job.mail.failed", onRecorded });
    const marker = "automation:01JD0000000000000000000001";
    const run = async () => { await f.engine.execute((await f.engine.claim())!); };

    await runWithRequestContext(newRequestContext("worker", { correlationId: marker }), () => f.mailer.enqueue(input));
    const [mail] = await t.db.select().from(mailOutbox);
    expect(mail?.correlationId).toBe(marker);
    await run(); // Separate async execution from the originating automation context.
    const resend = await runWithRequestContext(newRequestContext("http", { correlationId: "operator-request" }),
      () => f.admin.resend(f.operator, mail!.publicId));
    const [resendJob] = await t.db.select().from(jobRuns).where(eq(jobRuns.publicId, resend.jobId));
    expect(resendJob?.correlationId).toBe(marker);
    await run();
    const failures = await t.db.select().from(auditEvents).where(eq(auditEvents.eventName, "job.mail.failed"));
    expect(failures.map((event) => event.correlationId)).toEqual([marker, marker]);
    expect(onRecorded).not.toHaveBeenCalled();
    expect(audit.tapStats().suppressedAutomationOrigin).toBe(2);

    await f.mailer.enqueue({ ...input, idempotencyKey: "non-automation-control" });
    await run();
    expect(onRecorded).toHaveBeenCalledTimes(1);
  });

  it("fences a late SMTP success after reaping an interrupted provider call", async () => {
    const f = fixture();
    const entered = latch();
    const release = latch();
    f.mail.registerDelivery({
      findRecipient: async () => ({ email: "current@example.test", status: "active" }),
      getLegacySender: async () => sender,
    });
    f.mail.registerMailTransport({
      key: "smtp", isConfigured: async () => true,
      send: async () => {
        entered.resolve();
        await release.promise;
        return { outcome: "accepted" };
      },
    });
    f.mailer.registerTemplate({ key: "test.mail", vars: ["link", "name"], subject: () => "Test", text: () => "Testing" });
    await f.mailer.enqueue(input);
    const active = (await f.engine.claim())!;
    const execution = f.engine.execute(active);
    try {
      await entered.promise;
      await expireLease(active.job.jobId);
      expect(await f.engine.reap()).toBe(1);
    } finally {
      release.resolve();
      await execution;
    }
    const [row] = await t.db.select().from(mailOutbox);
    expect(active.job.signal.aborted).toBe(true);
    expect(row).toMatchObject({ state: "unknown", payloadEnc: expect.any(String) });
    expect((await f.admin.mailDetail(f.operator, row!.publicId)).attempts[0]?.state).toBe("unknown");
  });

  it.each([
    ["rejected", true, true], ["rejected", false, false], ["not_configured", false, true],
    ["unknown", false, false], ["accepted", false, false],
  ] as const)(
    "checks %s (retryable %s) before selecting the secondary and records each route",
    async (primary, retryable, switched) => {
      const f = fixture();
      const smtp = setDelivery(f, primary, retryable);
      const graph = vi.fn(async (_message: MailTransportMessage) => ({ outcome: "accepted" as const }));
      f.mail.registerMailTransport({ key: "graph", isConfigured: async () => true, send: graph });
      await f.h.settings.set(MAIL_ROUTING.key, { primary: "smtp", secondary: "graph" });
      const configured = { fromAddress: "configured@example.test", fromName: "ReadyPackets Ops", replyToAddress: "reply@example.test" };
      await f.h.settings.set(MAIL_SENDER.key, configured);
      await f.mailer.enqueue(input);
      await f.engine.execute((await f.engine.claim())!);
      expect(smtp.send).toHaveBeenCalledWith(expect.objectContaining({ sender: configured }));
      expect(graph).toHaveBeenCalledTimes(switched ? 1 : 0);
      if (switched) expect(graph).toHaveBeenCalledWith(expect.objectContaining({ sender: configured }));
      const [row] = await t.db.select().from(mailOutbox);
      expect(row).toMatchObject({ state: primary === "unknown" ? "unknown" : primary === "rejected" && !switched ? "failed" : "accepted",
        payloadEnc: primary === "unknown" ? expect.any(String) : null });
      const { attempts } = await f.admin.mailDetail(f.operator, row!.publicId);
      expect(attempts).toHaveLength(switched ? 2 : 1);
      expect(attempts).toContainEqual(expect.objectContaining({
        purpose: "primary", transport: "smtp", state: primary === "not_configured" ? "held" : primary === "rejected" ? "failed" : primary,
      }));
      if (switched) expect(attempts).toContainEqual(expect.objectContaining({ purpose: "secondary", transport: "graph", state: "accepted" }));
    },
  );

  it("does not route around an unexpected readiness failure", async () => {
    const f = fixture();
    const { send } = setDelivery(f, "accepted");
    const readiness = vi.fn(async () => { throw new Error("synthetic policy failure"); });
    const graph = vi.fn(async () => ({ outcome: "accepted" as const }));
    f.mail.registerMailTransport({ key: "graph", isConfigured: readiness, send: graph });
    await f.h.settings.set(MAIL_ROUTING.key, { primary: "graph", secondary: "smtp" });
    await f.mailer.enqueue(input);
    await f.engine.execute((await f.engine.claim())!);
    expect(readiness).toHaveBeenCalledTimes(1);
    expect(graph).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    const [row] = await t.db.select().from(mailOutbox);
    expect(row).toMatchObject({ state: "failed", payloadEnc: null });
  });

  it("rechecks single-use expiry immediately before submission, after transport readiness", async () => {
    const f = fixture();
    const { send } = setDelivery(f, "accepted");
    const graph = vi.fn(async () => ({ outcome: "accepted" as const }));
    f.mail.registerMailTransport({
      key: "graph",
      isConfigured: async () => { f.h.clock.advance(2_000); return true; },
      send: graph,
    });
    await f.h.settings.set(MAIL_ROUTING.key, { primary: "graph", secondary: "smtp" });
    await f.mailer.enqueue({ ...input, expiresAt: new Date(f.h.clock.now().getTime() + 1_000) });
    await f.engine.execute((await f.engine.claim())!);
    expect(graph).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    const [row] = await t.db.select().from(mailOutbox);
    expect(row).toMatchObject({ state: "expired", reasonCode: "MAIL_EXPIRED", payloadEnc: null });
  });

  it("does not turn a known customer acceptance into an unknown customer send when the copy loses its lease", async () => {
    const f = fixture();
    const auditTo = "audit@example.test";
    const entered = latch();
    const release = latch();
    const send = vi.fn(async ({ to }: MailTransportMessage) => {
      if (to === auditTo) {
        entered.resolve();
        await release.promise;
      }
      return { outcome: "accepted" as const };
    });
    f.mail.registerDelivery({
      findRecipient: async () => ({ email: "current@example.test", status: "active" }),
      getLegacySender: async () => sender,
    });
    f.mail.registerMailTransport({ key: "smtp", isConfigured: async () => true, send });
    f.mailer.registerTemplate({ key: input.template, vars: ["name", "link"], sensitiveVars: ["link"],
      subject: () => "Test", text: ({ link }) => String(link) });
    await f.h.settings.set(MAIL_AUDIT_COPY.key, { enabled: true, address: auditTo });
    await t.db.insert(mailAuditVerification).values({
      id: 1, addressHash: f.h.deps.crypto.blindIndex(auditTo, "mail.audit_copy.address"), verifiedAt: f.h.clock.now(),
    });
    await f.mailer.enqueue(input);
    const claim = (await f.engine.claim())!;
    const execution = f.engine.execute(claim);
    try {
      await entered.promise;
      await expireLease(claim.job.jobId);
      expect(await f.engine.reap()).toBe(1);
    } finally {
      release.resolve();
      await execution;
    }
    const [row] = await t.db.select().from(mailOutbox);
    expect(row).toMatchObject({ state: "accepted", payloadEnc: null });
    expect((await f.admin.mailDetail(f.operator, row!.publicId)).attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ purpose: "primary", state: "accepted" }),
      expect.objectContaining({ purpose: "audit_copy", state: "unknown" }),
    ]));
    await expect(f.admin.resend(f.operator, row!.publicId)).rejects.toMatchObject({ reasonCode: "MAIL_RESEND_UNSAFE" });
  });

  it("binds audit confirmation to the saved address, consumes it once, and retains only a separately redacted render", async () => {
    const f = fixture();
    const { send } = setDelivery(f, "accepted");
    const auditTo = "audit@example.test";
    await f.h.settings.set(MAIL_AUDIT_COPY.key, { enabled: true, address: auditTo });
    await f.h.settings.set(MAIL_RETAIN_CONTENT.key, true);
    await f.h.settings.set(MAIL_RETENTION_DAYS.key, 1);
    const publishedKey = "test.published_only";
    let declared: readonly string[] = ["link"];
    const render = ({ link }: Record<string, unknown>) => ({
      subject: "Template override",
      text: `Encoded: ${encodeURIComponent(String(link))}`,
      html: `<p>${encodeURIComponent(String(link))}</p>`,
    });
    f.mail.registerMailTemplateStore({ resolve: async (key) => key === input.template || key === publishedKey
      ? { key, vars: ["name", "link"], sensitiveVars: declared, render }
      : null });
    const run = async () => { await f.engine.execute((await f.engine.claim())!); };

    await f.mailer.enqueue(input);
    await run();
    expect(send.mock.calls.map(([mail]) => mail.to)).toEqual(["current@example.test"]);
    await expect(f.admin.auditCopyStatus(f.operator)).resolves.toEqual({ verified: false });
    f.assertCurrent.mockRejectedValueOnce(forbidden("SESSION_NOT_CURRENT"));
    await expect(f.admin.requestAuditCopyVerification(f.operator)).rejects.toMatchObject({ reasonCode: "SESSION_NOT_CURRENT" });
    expect(await t.db.select().from(mailAuditVerification)).toHaveLength(0);
    await expect(f.admin.requestAuditCopyVerification(f.operator)).resolves.toEqual({ queued: true });
    await run();
    const challenge = send.mock.calls[1]![0];
    const code = challenge.text.match(/^[\w-]{22}$/m)![0];
    expect(challenge.to).toBe(auditTo);
    const [proof] = await t.db.select().from(mailAuditVerification);
    expect(JSON.stringify(proof)).not.toContain(code);
    expect(JSON.stringify(proof)).not.toContain(auditTo);
    await f.h.settings.set(MAIL_AUDIT_COPY.key, { enabled: true, address: "changed@example.test" });
    await expect(f.admin.confirmAuditCopyVerification(f.operator, code)).rejects.toMatchObject({ reasonCode: "MAIL_AUDIT_CODE_INVALID" });
    await f.h.settings.set(MAIL_AUDIT_COPY.key, { enabled: true, address: auditTo });
    await expect(f.admin.confirmAuditCopyVerification(f.operator, code)).resolves.toEqual({ verified: true });
    await expect(f.admin.confirmAuditCopyVerification(f.operator, code)).rejects.toMatchObject({ reasonCode: "MAIL_AUDIT_CODE_INVALID" });

    f.mailer.registerTemplate({ key: "test.control", vars: [], subject: () => "Control", text: () => "Only built in" });
    await f.mailer.enqueue({ ...input, template: "test.control", vars: {}, idempotencyKey: "control-key" });
    await run();
    await expect(f.mailer.enqueue({ ...input, template: "test.missing", idempotencyKey: "missing-key" }))
      .rejects.toMatchObject({ reasonCode: "INVALID_MAIL_INPUT" });
    await f.mailer.enqueue({ ...input, template: publishedKey, idempotencyKey: "mail-with-verified-copy" });
    declared = []; // A subsequent publish must not remove the queued secret classification.
    await run();
    const actual = send.mock.calls.at(-2)![0];
    const copy = send.mock.calls.at(-1)![0];
    expect(actual.text).toContain(encodeURIComponent(input.vars.link));
    expect(copy).toMatchObject({ to: auditTo, text: "Encoded: %5BREDACTED%5D", html: "<p>%5BREDACTED%5D</p>" });
    const [outbox] = await t.db.select().from(mailOutbox).where(eq(mailOutbox.template, publishedKey));
    expect(outbox?.contentEnc).toBeTruthy();
    expect(outbox?.contentEnc).not.toContain("%5BREDACTED%5D");
    expect((await f.admin.mailDetail(f.operator, outbox!.publicId)).attempts).toContainEqual(expect.objectContaining({
      purpose: "audit_copy", transport: "smtp", state: "accepted",
    }));
    await expect(f.admin.mailContent(fakePrincipal({ role: "staff" }), outbox!.publicId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(f.admin.mailContent(fakePrincipal({ role: "admin" }), outbox!.publicId)).rejects.toMatchObject({ code: "STEP_UP_REQUIRED" });
    f.assertCurrent.mockRejectedValueOnce(forbidden("SESSION_NOT_CURRENT"));
    await expect(f.admin.mailContent(f.operator, outbox!.publicId)).rejects.toMatchObject({ reasonCode: "SESSION_NOT_CURRENT" });
    await expect(f.admin.mailContent(f.operator, outbox!.publicId)).resolves.toMatchObject({
      to: "current@example.test", subject: "Template override", html: copy.html,
    });
    expect(f.h.audit.named("mail.content.viewed")).toHaveLength(1);
    const audit = JSON.stringify(f.h.audit.events);
    expect(audit).not.toContain(code);
    expect(audit).not.toContain(input.vars.link);
    expect(audit).not.toContain(auditTo);

    f.h.clock.advance(24 * 60 * 60_000);
    const renewed = fakePrincipal({ role: "admin", stepUpAt: f.h.clock.now() });
    await expect(f.admin.mailContent(renewed, outbox!.publicId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await f.engine.scheduleTick();
    await run();
    const [purged] = await t.db.select().from(mailOutbox).where(eq(mailOutbox.id, outbox!.id));
    expect(purged).toMatchObject({ contentEnc: null, contentExpiresAt: null });
  });

  it("allows an explicit capture in test, encrypts it, and denies expired data", async () => {
    const f = fixture();
    const ports = setDelivery(f, "accepted");
    await f.h.settings.set(MAIL_CAPTURE.key, true);
    await f.mailer.enqueue(input);
    await f.engine.execute((await f.engine.claim())!);
    const [row] = await t.db.select().from(mailOutbox);
    expect(row).toMatchObject({ state: "captured", payloadEnc: null });
    expect(row?.captureEnc).not.toContain(input.vars.link);
    expect(await f.admin.capture(f.operator, row!.publicId)).toMatchObject({ text: expect.stringContaining(input.vars.link) });
    expect(f.h.audit.named("job.mail.capture.viewed")).toMatchObject([{
      action: "read", outcome: "completed", resource: { type: "mail", publicId: row!.publicId },
    }]);
    expect(ports.send).not.toHaveBeenCalled();
    f.h.clock.advance(16 * 60_000);
    const renewed = fakePrincipal({ role: "admin", stepUpAt: f.h.clock.now() });
    await expect(f.admin.capture(renewed, row!.publicId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await f.engine.scheduleTick();
    await f.engine.execute((await f.engine.claim())!);
    const [current] = await t.db.select().from(mailOutbox);
    expect(current).toMatchObject({ state: "captured", captureEnc: null });
  });

  it.each(["production", "preview"] as const)("refuses capture and sends nothing when accidentally enabled in %s", async (deploymentProfile) => {
    const dev = fixture();
    setDelivery(dev, "accepted");
    await dev.h.settings.set(MAIL_CAPTURE.key, true);
    await dev.mailer.enqueue(input);
    await dev.engine.execute((await dev.engine.claim())!);
    const [existing] = await t.db.select().from(mailOutbox);
    expect(existing?.state).toBe("captured");

    const f = fixture({ config: { deploymentProfile } });
    const ports = setDelivery(f, "accepted");
    await f.h.settings.set(MAIL_CAPTURE.key, true);
    await f.mailer.enqueue({ ...input, idempotencyKey: "mail-key-second" });
    await f.engine.execute((await f.engine.claim())!);
    const [row] = await t.db.select().from(mailOutbox).where(eq(mailOutbox.state, "failed"));
    expect(row).toMatchObject({ state: "failed", reasonCode: "MAIL_CAPTURE_FORBIDDEN", captureEnc: null });
    expect((await f.admin.listMail(f.operator, { state: "captured" })).items).toMatchObject([
      { publicId: existing!.publicId, canViewCapture: false },
    ]);
    await expect(f.admin.capture(f.operator, existing!.publicId)).rejects.toMatchObject({ reasonCode: "MAIL_CAPTURE_FORBIDDEN" });
    expect(ports.send).not.toHaveBeenCalled();
  });
});
