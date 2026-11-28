import { createHash, randomInt } from "node:crypto";
import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { AppConfig } from "../../config/env.js";
import { conflict, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { getRequestContext, newRequestContext, runWithRequestContext } from "../../core/requestContext.js";
import type {
  AuditEmitter, AuditOutcome, ClaimedJob, Clock, Db, DbOrTx, EnqueueOptions, FieldCrypto,
  JobHandlerOptions, JobQueue, JobResult, Logger, SettingsStore, Tx,
} from "../../core/types.js";
import { jobAttempts, jobMaintenance, jobRuns, mailAttempts, mailOutbox, mailTransportAttempts } from "./schema.js";

export { createMailer } from "./mail.js";

export interface QueueDeps {
  config: AppConfig;
  db: Db;
  clock: Clock;
  logger: Logger;
  audit: AuditEmitter;
  crypto: FieldCrypto;
  settings: SettingsStore;
}

type JobRow = typeof jobRuns.$inferSelect;
type Handler = { run: (job: ClaimedJob<unknown>) => Promise<JobResult>; retrySafe: boolean };
type Schedule = Parameters<JobQueue["registerSchedule"]>[0];
type Slot = { name: string; start: Date };
export type ActiveClaim = { job: ClaimedJob; controller: AbortController; startedAtMs: number };

export const JOB_TYPE = /^[a-z][a-z0-9_]*(?:[.-][a-z0-9_]+)*$/;
const CORRELATION = /^[A-Za-z0-9_.:-]{1,64}$/;
const SAFE_REASON = /^[A-Z][A-Z0-9_]{0,63}$/;
const LEASE_MS = 30_000;
const dbNow = sql`UTC_TIMESTAMP(3)`;
const newLease = sql`TIMESTAMPADD(MICROSECOND, ${LEASE_MS * 1000}, ${dbNow})`;
export const MAINTENANCE_ID = 1;

export const keyHash = (value: string): string => createHash("sha256").update(value).digest("hex");
export function validKey(value: string): boolean {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 512 && !/[\p{Cc}]/u.test(value);
}

export function currentCorrelation(fallback: string, explicit?: string): string {
  if (explicit !== undefined && !CORRELATION.test(explicit)) {
    throw validation("INVALID_CORRELATION", "The job correlation identifier is not valid.");
  }
  const context = getRequestContext();
  const current = explicit ?? context?.correlationId ?? context?.requestId ?? fallback;
  return CORRELATION.test(current) ? current : fallback;
}

const backoff = (now: Date, attempt: number) => {
  const base = Math.min(60 * 60_000, 1000 * (2 ** Math.min(16, Math.max(0, attempt - 1))));
  return new Date(now.getTime() + base + randomInt(0, Math.max(1, Math.floor(base / 4))));
};

export async function ensureMaintenanceGate(deps: QueueDeps): Promise<void> {
  const [gate] = await deps.db.select({ id: jobMaintenance.id }).from(jobMaintenance)
    .where(eq(jobMaintenance.id, MAINTENANCE_ID)).limit(1);
  if (!gate) {
    await deps.db.insert(jobMaintenance).values({ id: MAINTENANCE_ID, updatedAt: deps.clock.now() })
      .onDuplicateKeyUpdate({ set: { id: sql`${jobMaintenance.id}` } });
  }
}

export async function gateDraining(tx: DbOrTx, mode: "share" | "update" = "share"): Promise<boolean> {
  const [gate] = await tx.select({ active: jobMaintenance.active }).from(jobMaintenance)
    .where(eq(jobMaintenance.id, MAINTENANCE_ID)).limit(1).for(mode);
  if (!gate) throw new Error("JOB_MAINTENANCE_GATE_MISSING");
  return gate.active;
}

type ScheduleAttempt = Pick<JobRow, "scheduleName" | "scheduleSlot" | "type" | "attempt">;
const isRoutineScheduledAttempt = (row: Pick<ScheduleAttempt, "scheduleName" | "attempt">) =>
  row.scheduleName !== null && row.attempt === 1;

export function jobAudit(
  deps: QueueDeps, tx: Tx, job: Pick<JobRow, "publicId" | "correlationId"> & Partial<ScheduleAttempt>,
  eventName: string, outcome: AuditOutcome, reasonCode?: string, system = false, counts?: Record<string, number>,
): Promise<void> {
  return deps.audit.record({
    category: "job", eventName, outcome, reasonCode, action: "transition",
    resource: { type: "job", publicId: job.publicId }, jobId: job.publicId, correlationId: job.correlationId,
    safeCounts: counts,
    ...(job.scheduleName ? { attributes: {
      job_type: job.type ?? null, schedule_key: job.scheduleName,
      schedule_slot: job.scheduleSlot?.toISOString() ?? null, attempt: job.attempt ?? null,
    } } : {}),
    ...(system ? { actor: { role: "system" } } : {}),
  }, tx);
}

function workerContext<T>(deps: QueueDeps, job: Pick<JobRow, "correlationId">, fn: () => T): T {
  return runWithRequestContext(newRequestContext("worker", {
    correlationId: job.correlationId,
    startedAt: deps.clock.now(),
  }), fn);
}

async function hasLiveLease(tx: Tx, row: JobRow): Promise<boolean> {
  if (!row.leaseUntil) return false;
  // MySQL samples statement time before any lock wait. Run this after locking
  // the job in a separate statement, including in a caller's repeatable-read tx.
  const [valid] = await tx.select({ id: jobRuns.id }).from(jobRuns).where(and(
    eq(jobRuns.id, row.id), gt(jobRuns.leaseUntil, dbNow),
  )).limit(1).for("update");
  return valid !== undefined;
}

function safeCounts(counts: Record<string, number> | undefined): Record<string, number> | undefined {
  if (!counts) return undefined;
  return Object.fromEntries(Object.entries(counts).slice(0, 16).filter(([key, value]) =>
    /^[a-z][a-z0-9_]{0,39}$/.test(key) && Number.isSafeInteger(value) && value >= 0));
}

const engines = new WeakMap<JobQueue, JobEngine>();
export const engineFor = (queue: JobQueue): JobEngine | undefined => engines.get(queue);

export function createJobQueue(deps: QueueDeps): JobQueue {
  const engine = new JobEngine(deps);
  engines.set(engine, engine);
  return engine;
}

export class JobEngine implements JobQueue {
  readonly #handlers = new Map<string, Handler>();
  readonly #schedules = new Map<string, Schedule>();

  constructor(readonly deps: QueueDeps) {}

  register<P>(type: string, handler: (job: ClaimedJob<P>) => Promise<JobResult>, options?: JobHandlerOptions): void {
    if (!JOB_TYPE.test(type) || type.length > 100 || this.#handlers.has(type) || this.#handlers.size >= 250) {
      throw new Error("INVALID_OR_DUPLICATE_JOB_HANDLER");
    }
    this.#handlers.set(type, { run: (job) => handler(job as ClaimedJob<P>), retrySafe: options?.retrySafe === true });
  }

  registerSchedule(schedule: Schedule): void {
    if (!JOB_TYPE.test(schedule.name) || schedule.name.length > 100 || !JOB_TYPE.test(schedule.type)
      || schedule.type.length > 100 || this.#schedules.has(schedule.name) || this.#schedules.size >= 100
      || !Number.isSafeInteger(schedule.everyMs) || schedule.everyMs < 1_000 || schedule.everyMs > 366 * 86_400_000) {
      throw new Error("INVALID_OR_DUPLICATE_JOB_SCHEDULE");
    }
    this.#schedules.set(schedule.name, { ...schedule });
  }

  schedules() {
    return Array.from(this.#schedules.values(), ({ name, type, everyMs }) => ({ name, type, everyMs }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async enqueue<P>(type: string, payload: P, options: EnqueueOptions = {}, tx?: Tx): Promise<{ jobId: string }> {
    return tx
      ? this.#enqueue(tx, type, payload, options)
      : this.deps.db.transaction((inner) => this.#enqueue(inner, type, payload, options));
  }

  async #enqueue(tx: Tx, type: string, payload: unknown, options: EnqueueOptions, slot?: Slot) {
    const deps = this.deps;
    const handler = this.#handlers.get(type);
    const now = deps.clock.now();
    const runAt = options.runAt ?? now;
    const maxAttempts = options.maxAttempts ?? 5;
    if (!handler || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20
      || !(runAt instanceof Date) || !Number.isFinite(runAt.getTime())
      || (options.idempotencyKey !== undefined && !validKey(options.idempotencyKey))) {
      throw validation("INVALID_JOB_INPUT", "The job input is not valid.");
    }
    let serialized: string | undefined;
    try { serialized = JSON.stringify(payload); } catch { /* invalid input, do not log it */ }
    if (!serialized || Buffer.byteLength(serialized) > 128 * 1024) {
      throw validation("INVALID_JOB_PAYLOAD", "The job payload is not supported.");
    }
    const publicId = ulid(now.getTime());
    const correlationId = currentCorrelation(publicId, options.correlationId);
    const idem = options.idempotencyKey === undefined ? null : keyHash(options.idempotencyKey);
    await tx.insert(jobRuns).values({
      publicId, type, idempotencyHash: idem, payloadEnc: deps.crypto.encrypt(serialized, `job_runs.payload_enc:${publicId}`),
      maxAttempts, retrySafe: handler.retrySafe, runAt, correlationId, scheduleName: slot?.name,
      scheduleSlot: slot?.start, createdAt: now, updatedAt: now,
    }).onDuplicateKeyUpdate({ set: { id: sql`${jobRuns.id}` } });
    const [stored] = await tx.select({ publicId: jobRuns.publicId }).from(jobRuns).where(
      slot ? and(eq(jobRuns.scheduleName, slot.name), eq(jobRuns.scheduleSlot, slot.start))
        : idem ? and(eq(jobRuns.type, type), eq(jobRuns.idempotencyHash, idem))
        : eq(jobRuns.publicId, publicId),
    ).limit(1).for("update");
    if (!stored) throw new Error("JOB_ENQUEUE_INVARIANT");
    if (!slot && stored.publicId === publicId) {
      await jobAudit(deps, tx, { publicId, correlationId }, "job.enqueued", "completed");
    }
    return { jobId: stored.publicId };
  }

  async scheduleTick(): Promise<void> {
    const deps = this.deps;
    await ensureMaintenanceGate(deps);
    for (const entry of this.#schedules.values()) {
      const now = deps.clock.now();
      const start = new Date(Math.floor(now.getTime() / entry.everyMs) * entry.everyMs);
      await runWithRequestContext(newRequestContext("scheduler", { startedAt: now }), () =>
        deps.db.transaction(async (tx) => {
          if (await gateDraining(tx)) return;
          const [existing] = await tx.select({ id: jobRuns.id }).from(jobRuns).where(
            and(eq(jobRuns.scheduleName, entry.name), eq(jobRuns.scheduleSlot, start)),
          ).limit(1);
          if (!existing) await this.#enqueue(tx, entry.type, entry.payload ?? null, {}, { name: entry.name, start });
        }, { isolationLevel: "read committed" }));
    }
  }

  async claim(): Promise<ActiveClaim | null> {
    const deps = this.deps;
    const types = Array.from(this.#handlers.keys());
    if (!types.length) return null;
    await ensureMaintenanceGate(deps);
    const row = await deps.db.transaction(async (tx) => {
      if (await gateDraining(tx)) return null;
      const now = deps.clock.now();
      const [candidate] = await tx.select().from(jobRuns).where(and(
        eq(jobRuns.state, "queued"), lte(jobRuns.runAt, now), inArray(jobRuns.type, types),
        sql`${jobRuns.attempt} < ${jobRuns.maxAttempts}`,
      )).orderBy(asc(jobRuns.runAt), asc(jobRuns.id)).limit(1).for("update", { skipLocked: true });
      if (!candidate) return null;
      const attempt = candidate.attempt + 1;
      const fencingToken = candidate.fencingToken + 1;
      await tx.update(jobRuns).set({ state: "running", leaseUntil: newLease, attempt, fencingToken, updatedAt: now })
        .where(eq(jobRuns.id, candidate.id));
      await tx.insert(jobAttempts).values({ jobId: candidate.id, fencingToken, attempt, state: "running", startedAt: now });
      const claimed = { ...candidate, attempt, fencingToken };
      if (!isRoutineScheduledAttempt(claimed)) {
        await workerContext(deps, claimed, () => jobAudit(deps, tx, claimed, "job.claimed", "attempted", undefined, true));
      }
      return claimed;
    }, { isolationLevel: "read committed" });
    if (!row) return null;
    const controller = new AbortController();
    // Decryption occurs inside the handler run; an unreadable payload still has a truthful,
    // fenced disposition and cannot escape as an untracked claim.
    const job: ClaimedJob = {
      jobId: row.publicId, type: row.type, attempt: row.attempt, fencingToken: row.fencingToken,
      correlationId: row.correlationId, signal: controller.signal,
      get payload(): unknown {
        if (row.payloadEnc === null) throw new Error("JOB_PAYLOAD_UNAVAILABLE");
        return JSON.parse(deps.crypto.decrypt(row.payloadEnc, `job_runs.payload_enc:${row.publicId}`)) as unknown;
      },
      assertStillOwned: async (tx?: Tx) => {
        if (controller.signal.aborted) throw conflict("JOB_LEASE_LOST", "This job no longer owns its lease.");
        try {
          const query = async (inner: Tx) => {
            if (!await this.#owned(inner, job)) throw conflict("JOB_LEASE_LOST", "This job no longer owns its lease.");
          };
          if (tx) await query(tx);
          else await deps.db.transaction(query, { isolationLevel: "read committed" });
        } catch (error) {
          controller.abort();
          throw error;
        }
      },
    };
    return { job, controller, startedAtMs: performance.now() };
  }

  async #owned(tx: Tx, job: ClaimedJob): Promise<JobRow | undefined> {
    const [row] = await tx.select().from(jobRuns).where(and(
      eq(jobRuns.publicId, job.jobId), eq(jobRuns.state, "running"), eq(jobRuns.fencingToken, job.fencingToken),
    )).limit(1).for("update");
    return row && await hasLiveLease(tx, row) ? row : undefined;
  }

  async heartbeat(claim: ActiveClaim): Promise<void> {
    if (claim.controller.signal.aborted) return;
    try {
      const owned = await this.deps.db.transaction(async (tx) => {
        const row = await this.#owned(tx, claim.job);
        if (!row || claim.controller.signal.aborted) return false;
        const now = this.deps.clock.now();
        await tx.update(jobRuns).set({ leaseUntil: newLease, updatedAt: now })
          .where(eq(jobRuns.id, row.id));
        return true;
      }, { isolationLevel: "read committed" });
      if (!owned) claim.controller.abort();
    } catch {
      claim.controller.abort();
      workerContext(this.deps, claim.job, () =>
        this.deps.logger.warn("job heartbeat unavailable", { component: "jobs.queue", jobId: claim.job.jobId }));
    }
  }

  async execute(claim: ActiveClaim): Promise<void> {
    const { deps } = this;
    return workerContext(deps, claim.job, async () => {
      let result: JobResult;
      const handler = this.#handlers.get(claim.job.type);
      let payload: unknown;
      try {
        payload = claim.job.payload;
      } catch {
        await this.finish(claim, { outcome: "failed", reasonCode: "JOB_PAYLOAD_UNAVAILABLE", retryable: false });
        return;
      }
      try {
        await claim.job.assertStillOwned();
        if (!handler) throw new Error("JOB_HANDLER_UNAVAILABLE");
        // Bind the validated decoded payload once for the execution.
        result = await handler.run({ ...claim.job, payload });
      } catch {
        // A throw may have followed a provider send. Requeue only through the
        // explicit retry-safety policy; otherwise surface uncertainty.
        await this.interrupt(claim, "JOB_HANDLER_INTERRUPTED");
        return;
      }
      if (claim.controller.signal.aborted) {
        await this.interrupt(claim, "JOB_LEASE_INTERRUPTED");
      } else {
        await this.finish(claim, result);
      }
    });
  }

  async finish(claim: ActiveClaim, result: JobResult): Promise<boolean> {
    const settled = await this.deps.db.transaction(async (tx) => {
      const row = await this.#owned(tx, claim.job);
      if (!row) {
        claim.controller.abort();
        return null;
      }
      const reason = result.outcome === "completed" ? undefined
        : SAFE_REASON.test(result.reasonCode) ? result.reasonCode : "JOB_RESULT_UNAVAILABLE";
      const retry = result.outcome === "failed" && result.retryable;
      const counts = result.outcome === "completed" ? safeCounts(result.safeCounts) : undefined;
      await this.#settle(tx, row, result.outcome, reason, retry, counts);
      return { row, counts };
    }, { isolationLevel: "read committed" });
    if (!settled) return false;
    const { row, counts } = settled;
    if (result.outcome === "completed" && isRoutineScheduledAttempt(row)) {
      // The run and attempt are committed; operational logging must not affect disposition.
      try {
        this.deps.logger.info("scheduled job completed", {
          component: "jobs.queue", jobId: row.publicId, jobType: row.type,
          scheduleName: row.scheduleName, scheduleSlot: row.scheduleSlot?.toISOString() ?? null,
          correlationId: row.correlationId, durationMs: Math.round(performance.now() - claim.startedAtMs),
          safeCounts: counts ?? {},
        });
      } catch { /* the job ledger remains authoritative */ }
    }
    return true;
  }

  async interrupt(claim: ActiveClaim, reason = "JOB_WORKER_STOPPED"): Promise<boolean> {
    claim.controller.abort();
    return this.deps.db.transaction(async (tx) => {
      const row = await this.#owned(tx, claim.job);
      if (!row) return false;
      await this.#settle(tx, row, "interrupted", reason, row.retrySafe && this.#handlers.get(row.type)?.retrySafe === true);
      return true;
    }, { isolationLevel: "read committed" });
  }

  async reap(): Promise<number> {
    const { deps } = this;
    // Keep each transaction small and hold no gate: stale claims must settle even while draining.
    return deps.db.transaction(async (tx) => {
      const stale = await tx.select().from(jobRuns).where(and(
        eq(jobRuns.state, "running"), lte(jobRuns.leaseUntil, dbNow),
      )).orderBy(asc(jobRuns.leaseUntil), asc(jobRuns.id)).limit(16).for("update", { skipLocked: true });
      for (const row of stale) {
        await this.#settleExpired(tx, row, row.retrySafe && this.#handlers.get(row.type)?.retrySafe === true);
      }
      return stale.length;
    }, { isolationLevel: "read committed" });
  }

  /** Internal port for Jobs admin: the caller already holds the running row lock. */
  async reconcileOutboxLease(tx: Tx, row: JobRow): Promise<{ state: "running_live" } | { state: "settled_unknown" }> {
    if (row.state !== "running") throw new Error("JOB_RECONCILIATION_STATE_INVALID");
    if (await hasLiveLease(tx, row)) return { state: "running_live" };
    await this.#settleExpired(tx, row, false);
    return { state: "settled_unknown" };
  }

  async #settleExpired(tx: Tx, row: JobRow, safeToRetry: boolean): Promise<void> {
    await workerContext(this.deps, row, async () => {
      await jobAudit(this.deps, tx, row, "job.lease.expired", "attempted", "JOB_LEASE_EXPIRED", true);
      await this.#settle(tx, row, "interrupted", "JOB_LEASE_EXPIRED", safeToRetry);
    });
  }

  async #settle(
    tx: Tx, row: JobRow, outcome: "completed" | "failed" | "canceled" | "unknown" | "interrupted",
    reasonCode: string | undefined, safeToRetry: boolean, counts?: Record<string, number>,
  ): Promise<void> {
    const { deps } = this;
    const now = deps.clock.now();
    const queued = safeToRetry && row.attempt < row.maxAttempts;
    // A later failed/canceled attempt may not establish what happened during an
    // earlier interrupted one. Only a definitive completion resolves it.
    const inheritedUnknown = row.interruptionPending && (outcome === "failed" || outcome === "canceled") && !queued;
    const state = queued ? "queued" : outcome === "interrupted" || inheritedUnknown ? "unknown" : outcome;
    const allowRetry = state === "failed" && safeToRetry;
    await tx.update(jobRuns).set({
      state, allowRetry, reasonCode: inheritedUnknown ? "JOB_PRIOR_ATTEMPT_UNKNOWN" : reasonCode ?? null,
      interruptionPending: queued && (row.interruptionPending || outcome === "interrupted"),
      leaseUntil: null, updatedAt: now,
      ...(queued ? { runAt: backoff(now, row.attempt) } : {}),
      ...(state !== "queued" && !allowRetry && state !== "unknown" ? { payloadEnc: null } : {}),
    }).where(eq(jobRuns.id, row.id));
    await tx.update(jobAttempts).set({ state: outcome, reasonCode, safeCounts: counts, finishedAt: now })
      .where(and(eq(jobAttempts.jobId, row.id), eq(jobAttempts.fencingToken, row.fencingToken)));
    if (row.type === "jobs.mail.deliver" && !queued) await this.#settleInterruptedMail(tx, row, now);
    if (outcome === "interrupted") {
      await jobAudit(deps, tx, row, state === "unknown" ? "job.unknown" : "job.failed",
        state === "unknown" ? "unknown" : "failed", reasonCode, true);
    } else if (outcome !== "completed" || !isRoutineScheduledAttempt(row)) {
      const event = ({ completed: "job.completed", failed: "job.failed", canceled: "job.canceled", unknown: "job.unknown" })[outcome];
      await jobAudit(deps, tx, row, event, outcome, reasonCode, true, counts);
      if (inheritedUnknown) await jobAudit(deps, tx, row, "job.unknown", "unknown", "JOB_PRIOR_ATTEMPT_UNKNOWN", true);
    }
    if (queued) await jobAudit(deps, tx, row, "job.retry.queued", "completed", reasonCode, true);
  }

  async #settleInterruptedMail(tx: Tx, row: JobRow, now: Date): Promise<void> {
    const [mail] = await tx.select().from(mailOutbox).where(eq(mailOutbox.jobPublicId, row.publicId))
      .limit(1).for("update");
    if (!mail) return;
    if (mail.state === "accepted") {
      const condition = and(eq(mailTransportAttempts.mailId, mail.id), eq(mailTransportAttempts.generation, mail.generation),
        eq(mailTransportAttempts.purpose, "audit_copy"), eq(mailTransportAttempts.state, "sending"));
      const [copy] = await tx.select({ id: mailTransportAttempts.id }).from(mailTransportAttempts).where(condition).limit(1);
      if (!copy) return;
      await tx.update(mailTransportAttempts).set({ state: "unknown", reasonCode: "MAIL_PROVIDER_OUTCOME_UNKNOWN", finishedAt: now }).where(condition);
      await this.deps.audit.record({
        category: "job", eventName: "job.mail.audit_copy.unknown", action: "transition", outcome: "unknown",
        reasonCode: "MAIL_PROVIDER_OUTCOME_UNKNOWN", actor: { role: "system" },
        resource: { type: "mail", publicId: mail.publicId }, correlationId: row.correlationId, jobId: row.publicId,
      }, tx);
      return;
    }
    if (mail.state !== "queued" && mail.state !== "sending") return;
    // A provider can only be called after the sending marker commits. A queued
    // mail row therefore definitively did not reach the provider.
    const outcome = mail.state === "sending" ? "unknown" : "failed";
    const reasonCode = outcome === "unknown" ? "MAIL_PROVIDER_OUTCOME_UNKNOWN" : "MAIL_NOT_STARTED";
    await tx.update(mailOutbox).set({ state: outcome, reasonCode, updatedAt: now,
      ...(mail.expiresAt <= now ? { payloadEnc: null } : {}) }).where(eq(mailOutbox.id, mail.id));
    if (outcome === "unknown") {
      await tx.update(mailAttempts).set({ state: "unknown", reasonCode, finishedAt: now })
        .where(and(eq(mailAttempts.mailId, mail.id), eq(mailAttempts.generation, mail.generation), eq(mailAttempts.state, "sending")));
      await tx.update(mailTransportAttempts).set({ state: "unknown", reasonCode, finishedAt: now })
        .where(and(eq(mailTransportAttempts.mailId, mail.id), eq(mailTransportAttempts.generation, mail.generation),
          eq(mailTransportAttempts.state, "sending")));
    }
    await this.deps.audit.record({
      category: "job", eventName: outcome === "unknown" ? "job.mail.unknown" : "job.mail.failed",
      action: "transition", outcome, reasonCode, actor: { role: "system" },
      resource: { type: "mail", publicId: mail.publicId }, correlationId: row.correlationId, jobId: row.publicId,
    }, tx);
  }
}
