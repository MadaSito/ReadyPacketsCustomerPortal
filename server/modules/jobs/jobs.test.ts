import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getRequestContext, newRequestContext, runWithRequestContext } from "../../core/requestContext.js";
import { createCallerFactory } from "../../trpc/trpc.js";
import { createTestDeps, fakePrincipal } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { createAuditEmitter } from "../audit/emitter.js";
import { auditEvents } from "../audit/schema.js";
import { createJobsAdmin } from "./admin.js";
import { MAIL_CAPTURE, mailEngineFor, type SmtpDeliveryResult } from "./mail.js";
import { createJobQueue, createMailer, engineFor } from "./queue.js";
import { jobsRouter } from "./router.js";
import { jobAttempts, jobMaintenance, jobRuns, mailAttempts, mailOutbox } from "./schema.js";
import { startWorker } from "./worker.js";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb({ schema: { jobRuns, jobAttempts, jobMaintenance, mailOutbox, mailAttempts, auditEvents } });
});
afterAll(async () => t?.cleanup());
beforeEach(async () => {
  for (const table of [jobAttempts, mailAttempts, mailOutbox, jobRuns, jobMaintenance, auditEvents]) await t.db.delete(table);
});

const done = async () => ({ outcome: "completed" as const });
async function expireLease(jobId?: string): Promise<void> {
  await t.db.update(jobRuns).set({ leaseUntil: sql`UTC_TIMESTAMP(3) - INTERVAL 1 SECOND` })
    .where(jobId === undefined ? eq(jobRuns.state, "running") : eq(jobRuns.publicId, jobId));
}
function latch(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((ready) => { resolve = ready; });
  return { promise, resolve };
}

function fixture(profile: Parameters<typeof createTestDeps>[0] = {}) {
  const h = createTestDeps({ db: t.db, ...profile });
  const jobs = createJobQueue(h.deps);
  const mailer = createMailer({ ...h.deps, jobs });
  const deps = { ...h.deps, jobs, mailer };
  const admin = createJobsAdmin(deps);
  const engine = engineFor(jobs)!;
  const mail = mailEngineFor(mailer)!;
  const operator = fakePrincipal({ role: "admin", stepUpAt: h.clock.now() });
  return { h, jobs, engine, mailer, mail, admin, operator };
}

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
    expect(await f.admin.maintenance(f.operator)).toMatchObject({ state: "draining", running: 1 });
    await expireLease(a.jobId);
    expect(await f.engine.reap()).toBe(1);
    await f.engine.heartbeat(old);
    expect(old.job.signal.aborted).toBe(true);
    expect(await f.admin.maintenance(f.operator)).toMatchObject({ state: "unproved", unresolved: 1 });
    expect(await f.admin.maintenanceBanner()).toMatchObject({ active: true });
    await expect(f.admin.setMaintenance(f.operator, { active: false, expectedActive: true })).rejects.toMatchObject({ reasonCode: "JOB_DRAIN_UNPROVED" });
    await expect(f.admin.retry(f.operator, a.jobId)).rejects.toMatchObject({ code: "MAINTENANCE" });
    await f.admin.acknowledgeUnknown(f.operator, a.jobId);
    expect(await f.admin.maintenance(f.operator)).toMatchObject({ state: "queue_drained", unresolved: 0 });
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
    expect(await f.admin.maintenance(f.operator)).toMatchObject({ state: "unproved", unresolved: 2 });
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
    f.h.services.jobAdmin = { ...f.admin, startWorker: async () => { throw new Error("unexpected worker start"); } };
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
  const input = {
    template: "test.mail", to: { userId: 22 },
    vars: { link: "https://portal.example.test/preview-only", name: "<img onerror=example>" }, idempotencyKey: "mail-key",
  };
  function setDelivery(f: ReturnType<typeof fixture>, outcome: SmtpDeliveryResult["outcome"]) {
    const send = vi.fn(async () => ({ outcome }));
    const findRecipient = vi.fn(async () => ({ email: "current@example.test", status: "active" }));
    f.mail.registerDelivery({ send, findRecipient });
    f.mailer.registerTemplate({
      key: "test.mail", vars: ["link", "name"], sensitiveVars: ["link"],
      subject: () => "Test notification", text: ({ name, link }) => `${name}\n${link}`,
    });
    return { send, findRecipient };
  }

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

  it("keeps ambiguous transport outcomes unknown with no payload or resend", async () => {
    const f = fixture();
    setDelivery(f, "unknown");
    await f.mailer.enqueue(input);
    await f.engine.execute((await f.engine.claim())!);
    const [row] = await t.db.select().from(mailOutbox);
    expect(row).toMatchObject({ state: "unknown", payloadEnc: null });
    expect((await f.admin.list(f.operator, {})).items[0]?.state).toBe("unknown");
    await expect(f.admin.resend(f.operator, row!.publicId)).rejects.toMatchObject({ reasonCode: "MAIL_RESEND_UNSAFE" });
  });

  it("fences a late SMTP success after reaping an interrupted provider call", async () => {
    const f = fixture();
    const entered = latch();
    const release = latch();
    f.mail.registerDelivery({
      findRecipient: async () => ({ email: "current@example.test", status: "active" }),
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
    expect(row).toMatchObject({ state: "unknown", payloadEnc: null });
    expect((await f.admin.mailDetail(f.operator, row!.publicId)).attempts[0]?.state).toBe("unknown");
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
