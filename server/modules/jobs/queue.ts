import { createHash, randomInt } from "node:crypto";
import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { AppConfig } from "../../config/env.js";
import { conflict, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { getRequestContext, newRequestContext, runWithRequestContext } from "../../core/requestContext.js";
import type {
  AuditEmitter, AuditOutcome, ClaimedJob, Clock, Db, EnqueueOptions, FieldCrypto,
  JobHandlerOptions, JobQueue, JobResult, Logger, SettingsStore, Tx,
} from "../../core/types.js";
import { jobAttempts, jobMaintenance, jobRuns, mailAttempts, mailOutbox } from "./schema.js";

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
export type ActiveClaim = { job: ClaimedJob; controller: AbortController };

export const JOB_TYPE = /^[a-z][a-z0-9_]*(?:[.-][a-z0-9_]+)*$/;
const CORRELATION = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_REASON = /^[A-Z][A-Z0-9_]{0,63}$/;
export const LEASE_MS = 30_000;
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

export async function gateDraining(tx: Tx, mode: "share" | "update" = "share"): Promise<boolean> {
  const [gate] = await tx.select({ active: jobMaintenance.active }).from(jobMaintenance)
    .where(eq(jobMaintenance.id, MAINTENANCE_ID)).limit(1).for(mode);
  if (!gate) throw new Error("JOB_MAINTENANCE_GATE_MISSING");
  return gate.active;
}

export function jobAudit(
  deps: QueueDeps, tx: Tx, job: Pick<JobRow, "publicId" | "correlationId">,
  eventName: string, outcome: AuditOutcome, reasonCode?: string, system = false,
): Promise<void> {
  return deps.audit.record({
    category: "job", eventName, outcome, reasonCode, action: "transition",
    resource: { type: "job", publicId: job.publicId }, jobId: job.publicId, correlationId: job.correlationId,
    ...(system ? { actor: { role: "system" } } : {}),
  }, tx);
}

function workerContext<T>(deps: QueueDeps, job: Pick<JobRow, "correlationId">, fn: () => T): T {
  return runWithRequestContext(newRequestContext("worker", {
    correlationId: job.correlationId,
    startedAt: deps.clock.now(),
  }), fn);
}

function safeCounts(counts: Record<string, number> | undefined): Record<string, number> | undefined {
  if (!counts) return undefined;
  return Object.fromEntries(Object.entries(counts).slice(0, 20).filter(([key, value]) =>
    /^[a-zA-Z][a-zA-Z0-9_]{0,49}$/.test(key) && Number.isSafeInteger(value) && value >= 0));
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
    if (stored.publicId === publicId) await jobAudit(deps, tx, { publicId, correlationId }, "job.enqueued", "completed");
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
      const leaseUntil = new Date(now.getTime() + LEASE_MS);
      await tx.update(jobRuns).set({ state: "running", leaseUntil, attempt, fencingToken, updatedAt: now })
        .where(eq(jobRuns.id, candidate.id));
      await tx.insert(jobAttempts).values({ jobId: candidate.id, fencingToken, attempt, state: "running", startedAt: now });
      await workerContext(deps, candidate, () => jobAudit(deps, tx, candidate, "job.claimed", "attempted", undefined, true));
      return { ...candidate, attempt, fencingToken, leaseUntil };
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
    return { job, controller };
  }

  async #owned(tx: Tx, job: ClaimedJob): Promise<JobRow | undefined> {
    const [row] = await tx.select().from(jobRuns).where(and(
      eq(jobRuns.publicId, job.jobId), eq(jobRuns.state, "running"), eq(jobRuns.fencingToken, job.fencingToken),
      gt(jobRuns.leaseUntil, this.deps.clock.now()),
    )).limit(1).for("update");
    // Recheck after the lock wait; the SQL-bound time was sampled before it.
    return row?.leaseUntil && row.leaseUntil.getTime() > this.deps.clock.now().getTime() ? row : undefined;
  }

  async heartbeat(claim: ActiveClaim): Promise<void> {
    if (claim.controller.signal.aborted) return;
    try {
      const owned = await this.deps.db.transaction(async (tx) => {
        const row = await this.#owned(tx, claim.job);
        if (!row || claim.controller.signal.aborted) return false;
        const now = this.deps.clock.now();
        await tx.update(jobRuns).set({ leaseUntil: new Date(now.getTime() + LEASE_MS), updatedAt: now })
          .where(eq(jobRuns.id, row.id));
        return true;
      }, { isolationLevel: "read committed" });
      if (!owned) claim.controller.abort();
    } catch {
      claim.controller.abort();
      this.deps.logger.warn("job heartbeat unavailable", { component: "jobs.queue" });
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
    return this.deps.db.transaction(async (tx) => {
      const row = await this.#owned(tx, claim.job);
      if (!row) {
        claim.controller.abort();
        return false;
      }
      const reason = result.outcome === "completed" ? undefined
        : SAFE_REASON.test(result.reasonCode) ? result.reasonCode : "JOB_RESULT_UNAVAILABLE";
      const retry = result.outcome === "failed" && result.retryable;
      await this.#settle(tx, row, result.outcome, reason, retry,
        result.outcome === "completed" ? safeCounts(result.safeCounts) : undefined);
      return true;
    }, { isolationLevel: "read committed" });
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
        eq(jobRuns.state, "running"), lte(jobRuns.leaseUntil, deps.clock.now()),
      )).orderBy(asc(jobRuns.leaseUntil), asc(jobRuns.id)).limit(16).for("update", { skipLocked: true });
      for (const row of stale) {
        await workerContext(deps, row, async () => {
          await jobAudit(deps, tx, row, "job.lease.expired", "attempted", "JOB_LEASE_EXPIRED", true);
          await this.#settle(tx, row, "interrupted", "JOB_LEASE_EXPIRED",
            row.retrySafe && this.#handlers.get(row.type)?.retrySafe === true);
        });
      }
      return stale.length;
    }, { isolationLevel: "read committed" });
  }

  async #settle(
    tx: Tx, row: JobRow, outcome: "completed" | "failed" | "canceled" | "unknown" | "interrupted",
    reasonCode: string | undefined, safeToRetry: boolean, counts?: Record<string, number>,
  ): Promise<void> {
    const { deps } = this;
    const now = deps.clock.now();
    const queued = safeToRetry && row.attempt < row.maxAttempts;
    const state = queued ? "queued" : outcome === "interrupted" ? "unknown" : outcome;
    const allowRetry = state === "failed" && safeToRetry;
    await tx.update(jobRuns).set({
      state, allowRetry, reasonCode: reasonCode ?? null, leaseUntil: null, updatedAt: now,
      ...(queued ? { runAt: backoff(now, row.attempt) } : {}),
      ...(state !== "queued" && !allowRetry && state !== "unknown" ? { payloadEnc: null } : {}),
    }).where(eq(jobRuns.id, row.id));
    await tx.update(jobAttempts).set({ state: outcome, reasonCode, safeCounts: counts, finishedAt: now })
      .where(and(eq(jobAttempts.jobId, row.id), eq(jobAttempts.fencingToken, row.fencingToken)));
    if (row.type === "jobs.mail.deliver" && !queued) await this.#settleInterruptedMail(tx, row, now);
    if (outcome !== "interrupted") {
      const event = ({ completed: "job.completed", failed: "job.failed", canceled: "job.canceled", unknown: "job.unknown" })[outcome];
      await jobAudit(deps, tx, row, event, outcome, reasonCode, true);
    } else {
      await jobAudit(deps, tx, row, state === "unknown" ? "job.unknown" : "job.failed",
        state === "unknown" ? "unknown" : "failed", reasonCode, true);
    }
    if (queued) await jobAudit(deps, tx, row, "job.retry.queued", "completed", reasonCode, true);
  }

  async #settleInterruptedMail(tx: Tx, row: JobRow, now: Date): Promise<void> {
    const [mail] = await tx.select().from(mailOutbox).where(eq(mailOutbox.jobPublicId, row.publicId))
      .limit(1).for("update");
    if (!mail || (mail.state !== "queued" && mail.state !== "sending")) return;
    // A provider can only be called after the sending marker commits. A queued
    // mail row therefore definitively did not reach the provider.
    const outcome = mail.state === "sending" ? "unknown" : "failed";
    const reasonCode = outcome === "unknown" ? "MAIL_PROVIDER_OUTCOME_UNKNOWN" : "MAIL_NOT_STARTED";
    await tx.update(mailOutbox).set({ state: outcome, reasonCode, updatedAt: now,
      ...(outcome === "unknown" ? { payloadEnc: null } : {}) }).where(eq(mailOutbox.id, mail.id));
    if (outcome === "unknown") {
      await tx.update(mailAttempts).set({ state: "unknown", reasonCode, finishedAt: now })
        .where(and(eq(mailAttempts.mailId, mail.id), eq(mailAttempts.generation, mail.generation)));
    }
    await this.deps.audit.record({
      category: "job", eventName: outcome === "unknown" ? "job.mail.unknown" : "job.mail.failed",
      action: "transition", outcome, reasonCode, actor: { role: "system" },
      resource: { type: "mail", publicId: mail.publicId }, correlationId: row.correlationId, jobId: row.publicId,
    }, tx);
  }
}
