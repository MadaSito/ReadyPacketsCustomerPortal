import { and, asc, desc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import { conflict, DomainError, forbidden, notFound, validation } from "../../core/errors.js";
import { ULID_PATTERN } from "../../core/ids.js";
import type { ModuleHealth, SessionPrincipal, Tx } from "../../core/types.js";
import { roleHasCapability, STEP_UP_CAPABILITIES, type Capability } from "../../../shared/capabilities.js";
import { STEP_UP_MAX_AGE_MS } from "../../trpc/trpc.js";
import { mailAudit, mailEngineFor } from "./mail.js";
import { engineFor, ensureMaintenanceGate, gateDraining, jobAudit, MAINTENANCE_ID } from "./queue.js";
import { type JOB_STATES, jobAttempts, jobMaintenance, jobRuns, type MAIL_STATES, mailAttempts, mailOutbox } from "./schema.js";

type JobState = (typeof JOB_STATES)[number];
type MailState = (typeof MAIL_STATES)[number];
type Page = { limit?: number; cursor?: string };
export type JobList = Page & { type?: string; state?: JobState };
export type MailList = Page & { state?: MailState };
const activeMessage = "Maintenance is in progress. Some operations are temporarily unavailable.";

const jobView = {
  publicId: jobRuns.publicId, type: jobRuns.type, state: jobRuns.state, correlationId: jobRuns.correlationId,
  attempt: jobRuns.attempt, maxAttempts: jobRuns.maxAttempts, reasonCode: jobRuns.reasonCode,
  allowRetry: jobRuns.allowRetry, reconciledAt: jobRuns.reconciledAt, runAt: jobRuns.runAt, leaseUntil: jobRuns.leaseUntil,
  scheduleName: jobRuns.scheduleName, createdAt: jobRuns.createdAt, updatedAt: jobRuns.updatedAt,
};
const mailView = {
  publicId: mailOutbox.publicId, template: mailOutbox.template, state: mailOutbox.state, reasonCode: mailOutbox.reasonCode,
  correlationId: mailOutbox.correlationId, jobPublicId: mailOutbox.jobPublicId, generation: mailOutbox.generation,
  expiresAt: mailOutbox.expiresAt, createdAt: mailOutbox.createdAt, updatedAt: mailOutbox.updatedAt,
  hasPayload: sql<boolean>`${mailOutbox.payloadEnc} is not null`.mapWith(Boolean),
};

function pageLimit(input: Page): number {
  if (input.cursor !== undefined && !ULID_PATTERN.test(input.cursor)) throw validation("INVALID_CURSOR", "This page cursor is not valid.");
  const limit = input.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw validation("INVALID_PAGE_LIMIT", "This page size is not valid.");
  return limit;
}

function pageOf<T extends { publicId: string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? items[items.length - 1]!.publicId : null };
}

export function createJobsAdmin(deps: ModuleDeps) {
  const { db, clock } = deps;
  const mailer = () => {
    const implementation = mailEngineFor(deps.mailer);
    if (!implementation) throw new DomainError("UNAVAILABLE", "MAIL_ADMIN_UNAVAILABLE", "Mail administration is unavailable.");
    return implementation;
  };

  async function authorize(principal: SessionPrincipal | null, capability: Capability) {
    const now = clock.now().getTime();
    const liftedAt = principal?.stepUpAt?.getTime() ?? Number.NaN;
    const isFullAdmin = principal?.role === "admin" && principal.state === "full" && principal.pendingSteps.length === 0;
    const permitted = isFullAdmin && roleHasCapability(principal.role, capability);
    const fresh = !STEP_UP_CAPABILITIES.has(capability) || (liftedAt <= now && liftedAt >= now - STEP_UP_MAX_AGE_MS);
    if (permitted && fresh) return;
    await deps.audit.record({
      category: "security", eventName: "job.admin.denied", action: "authorize", outcome: "denied",
      reasonCode: permitted ? "STEP_UP_REQUIRED" : "CAPABILITY_NOT_GRANTED",
      actor: principal ? { userId: principal.userId, role: principal.role } : { role: "anonymous" },
      resource: { type: "job_admin" },
    });
    if (!permitted) throw forbidden("CAPABILITY_NOT_GRANTED");
    throw new DomainError("STEP_UP_REQUIRED", "STEP_UP_REQUIRED", "Confirm your password and authentication code to continue.", { capability });
  }

  async function isDraining(): Promise<boolean> {
    const [gate] = await db.select({ active: jobMaintenance.active }).from(jobMaintenance)
      .where(eq(jobMaintenance.id, MAINTENANCE_ID)).limit(1);
    return gate?.active ?? false;
  }

  async function drainCounts(executor: Tx | typeof db) {
    const [counts] = await executor.select({
      running: sql<number>`coalesce(sum(${jobRuns.state} = 'running'), 0)`.mapWith(Number),
      unresolved: sql<number>`coalesce(sum(${jobRuns.state} = 'unknown' and ${jobRuns.reconciledAt} is null), 0)`.mapWith(Number),
    }).from(jobRuns).where(or(eq(jobRuns.state, "running"), and(eq(jobRuns.state, "unknown"), isNull(jobRuns.reconciledAt))));
    return counts ?? { running: 0, unresolved: 0 };
  }

  return {
    isDraining,
    async maintenanceBanner() {
      const active = await isDraining();
      return { active, message: active ? activeMessage : null };
    },
    async maintenance(principal: SessionPrincipal | null) {
      await authorize(principal, "jobs.read");
      const active = await isDraining();
      const counts = await drainCounts(db);
      return { active, ...counts, state: !active ? "open" as const : counts.unresolved > 0 ? "unproved" as const
        : counts.running > 0 ? "draining" as const : "queue_drained" as const };
    },
    async setMaintenance(principal: SessionPrincipal | null, input: { active: boolean; expectedActive: boolean }) {
      await authorize(principal, "maintenance.manage");
      await ensureMaintenanceGate(deps);
      return db.transaction(async (tx) => {
        const current = await gateDraining(tx, "update");
        if (current !== input.expectedActive) throw conflict("MAINTENANCE_CHANGED", "The maintenance state changed. Refresh and try again.");
        if (current === input.active) return { active: current };
        if (!input.active) {
          const counts = await drainCounts(tx);
          if (counts.running || counts.unresolved) {
            throw conflict("JOB_DRAIN_UNPROVED", "Maintenance remains enabled while jobs are running or have unresolved outcomes.");
          }
        }
        await tx.update(jobMaintenance).set({ active: input.active, updatedAt: clock.now() })
          .where(eq(jobMaintenance.id, MAINTENANCE_ID));
        await deps.audit.record({
          category: "job", eventName: "job.maintenance.changed", action: "transition", outcome: "completed",
          reasonCode: input.active ? "MAINTENANCE_ENABLED" : "MAINTENANCE_DISABLED",
          actor: { userId: principal!.userId, role: principal!.role }, resource: { type: "job_maintenance" },
        }, tx);
        return { active: input.active };
      }, { isolationLevel: "read committed" });
    },
    async list(principal: SessionPrincipal | null, input: JobList) {
      await authorize(principal, "jobs.read");
      const limit = pageLimit(input);
      const rows = await db.select(jobView).from(jobRuns).where(and(
        input.type === undefined ? undefined : eq(jobRuns.type, input.type),
        input.state === undefined ? undefined : eq(jobRuns.state, input.state),
        input.cursor === undefined ? undefined : lt(jobRuns.publicId, input.cursor),
      )).orderBy(desc(jobRuns.publicId)).limit(limit + 1);
      return pageOf(rows, limit);
    },
    async detail(principal: SessionPrincipal | null, publicId: string) {
      await authorize(principal, "jobs.read");
      const [job] = await db.select({ id: jobRuns.id, ...jobView }).from(jobRuns).where(eq(jobRuns.publicId, publicId)).limit(1);
      if (!job) throw notFound();
      const { id, ...publicJob } = job;
      const attempts = await db.select({
        attempt: jobAttempts.attempt, state: jobAttempts.state, reasonCode: jobAttempts.reasonCode,
        startedAt: jobAttempts.startedAt, finishedAt: jobAttempts.finishedAt, safeCounts: jobAttempts.safeCounts,
      }).from(jobAttempts).where(eq(jobAttempts.jobId, id)).orderBy(desc(jobAttempts.attempt)).limit(50);
      return { ...publicJob, attempts };
    },
    async cancel(principal: SessionPrincipal | null, publicId: string) {
      await authorize(principal, "jobs.manage");
      return db.transaction(async (tx) => {
        const [row] = await tx.select().from(jobRuns).where(eq(jobRuns.publicId, publicId)).limit(1).for("update");
        if (!row) throw notFound();
        if (row.state !== "queued") throw conflict("JOB_CANCEL_UNSAFE", "Only jobs that are waiting to run can be canceled.");
        const now = clock.now();
        await tx.update(jobRuns).set({ state: "canceled", reasonCode: "JOB_CANCELED", payloadEnc: null, updatedAt: now })
          .where(eq(jobRuns.id, row.id));
        if (row.type === "jobs.mail.deliver") {
          const [mail] = await tx.select().from(mailOutbox)
            .where(and(eq(mailOutbox.jobPublicId, row.publicId), eq(mailOutbox.state, "queued"))).limit(1).for("update");
          if (mail) {
            await tx.update(mailOutbox).set({ state: "canceled", reasonCode: "MAIL_CANCELED", payloadEnc: null, updatedAt: now })
              .where(eq(mailOutbox.id, mail.id));
            await mailAudit(deps, tx, mail, "job.mail.canceled", "canceled", "MAIL_CANCELED");
          }
        }
        await jobAudit(deps, tx, row, "job.canceled", "canceled", "JOB_CANCELED");
        return { publicId: row.publicId, state: "canceled" as const };
      });
    },
    async retry(principal: SessionPrincipal | null, publicId: string) {
      await authorize(principal, "jobs.manage");
      await ensureMaintenanceGate(deps);
      return db.transaction(async (tx) => {
        if (await gateDraining(tx)) throw new DomainError("MAINTENANCE", "PORTAL_DRAINING", activeMessage);
        const [row] = await tx.select().from(jobRuns).where(eq(jobRuns.publicId, publicId)).limit(1).for("update");
        if (!row) throw notFound();
        if (row.state !== "failed" || !row.allowRetry || row.payloadEnc === null || row.attempt >= 50) {
          throw conflict("JOB_RETRY_UNSAFE", "This job cannot be safely retried.");
        }
        const now = clock.now();
        await tx.update(jobRuns).set({
          state: "queued", allowRetry: false, maxAttempts: row.attempt + 1, runAt: now, updatedAt: now,
        }).where(eq(jobRuns.id, row.id));
        await jobAudit(deps, tx, row, "job.retry.queued", "completed", "JOB_ADMIN_RETRY");
        return { publicId: row.publicId, state: "queued" as const };
      });
    },
    async acknowledgeUnknown(principal: SessionPrincipal | null, publicId: string) {
      await authorize(principal, "maintenance.manage");
      return db.transaction(async (tx) => {
        const [row] = await tx.select().from(jobRuns).where(eq(jobRuns.publicId, publicId)).limit(1).for("update");
        if (!row) throw notFound();
        if (row.state !== "unknown" || row.reconciledAt) {
          throw conflict("JOB_RECONCILIATION_UNAVAILABLE", "This job is not awaiting reconciliation.");
        }
        const reconciledAt = clock.now();
        await tx.update(jobRuns).set({ reconciledAt, payloadEnc: null, updatedAt: reconciledAt }).where(eq(jobRuns.id, row.id));
        await jobAudit(deps, tx, row, "job.unknown.acknowledged", "completed", "JOB_RECONCILIATION_ATTESTED");
        return { publicId: row.publicId, state: "unknown" as const, reconciledAt };
      });
    },
    async schedules(principal: SessionPrincipal | null) {
      await authorize(principal, "jobs.read");
      const active = await isDraining();
      const now = clock.now().getTime();
      const schedules = engineFor(deps.jobs)?.schedules() ?? [];
      return {
        paused: active,
        items: await Promise.all(schedules.map(async (entry) => {
          const [last] = await db.select({ jobId: jobRuns.publicId, slot: jobRuns.scheduleSlot, state: jobRuns.state })
            .from(jobRuns).where(eq(jobRuns.scheduleName, entry.name)).orderBy(desc(jobRuns.scheduleSlot)).limit(1);
          return { ...entry, last: last ?? null, nextSlot: new Date((Math.floor(now / entry.everyMs) + 1) * entry.everyMs) };
        })),
      };
    },
    async listMail(principal: SessionPrincipal | null, input: MailList) {
      await authorize(principal, "jobs.read");
      const limit = pageLimit(input);
      const query = db.select(mailView).from(mailOutbox).where(and(
        input.state === undefined ? undefined : eq(mailOutbox.state, input.state),
        input.cursor === undefined ? undefined : lt(mailOutbox.publicId, input.cursor),
      )).orderBy(desc(mailOutbox.publicId)).limit(limit + 1);
      const rows = await query;
      const now = clock.now();
      const safe = rows.map(({ hasPayload, ...row }) => ({
        ...row,
        canResend: hasPayload && ["held", "failed"].includes(row.state) && row.expiresAt > now && row.generation < 20,
        canViewCapture: row.state === "captured" && row.expiresAt > now && deps.config.deploymentProfile !== "production",
      }));
      return pageOf(safe, limit);
    },
    async mailDetail(principal: SessionPrincipal | null, publicId: string) {
      await authorize(principal, "jobs.read");
      const [row] = await db.select({ id: mailOutbox.id }).from(mailOutbox).where(eq(mailOutbox.publicId, publicId)).limit(1);
      if (!row) throw notFound();
      const attempts = await db.select({
        generation: mailAttempts.generation, state: mailAttempts.state, reasonCode: mailAttempts.reasonCode,
        startedAt: mailAttempts.startedAt, finishedAt: mailAttempts.finishedAt,
      }).from(mailAttempts).where(eq(mailAttempts.mailId, row.id)).orderBy(desc(mailAttempts.generation)).limit(20);
      return { publicId, attempts };
    },
    async resend(principal: SessionPrincipal | null, publicId: string) {
      await authorize(principal, "jobs.manage");
      await ensureMaintenanceGate(deps);
      return db.transaction(async (tx) => {
        if (await gateDraining(tx)) throw new DomainError("MAINTENANCE", "PORTAL_DRAINING", activeMessage);
        return mailer().resend(tx, publicId);
      });
    },
    async capture(principal: SessionPrincipal | null, publicId: string) {
      await authorize(principal, "jobs.mail.capture");
      return db.transaction((tx) => mailer().viewCapture(tx, publicId));
    },
    async health(): Promise<ModuleHealth[]> {
      const now = clock.now();
      const [queueCounts] = await db.select({
        queued: sql<number>`coalesce(sum(${jobRuns.state} = 'queued'), 0)`.mapWith(Number),
        running: sql<number>`coalesce(sum(${jobRuns.state} = 'running'), 0)`.mapWith(Number),
        stuck: sql<number>`coalesce(sum(${jobRuns.state} = 'running' and ${jobRuns.leaseUntil} <= ${now.toISOString().slice(0, 23).replace("T", " ")}), 0)`.mapWith(Number),
        unknown: sql<number>`coalesce(sum(${jobRuns.state} = 'unknown'), 0)`.mapWith(Number),
        unresolved: sql<number>`coalesce(sum(${jobRuns.state} = 'unknown' and ${jobRuns.reconciledAt} is null), 0)`.mapWith(Number),
      }).from(jobRuns).where(or(eq(jobRuns.state, "queued"), eq(jobRuns.state, "running"), eq(jobRuns.state, "unknown")));
      const [oldest] = await db.select({ readyAt: jobRuns.runAt }).from(jobRuns).where(and(eq(jobRuns.state, "queued"), lte(jobRuns.runAt, now)))
        .orderBy(asc(jobRuns.runAt)).limit(1);
      const [mail] = await db.select({
        held: sql<number>`coalesce(sum(${mailOutbox.state} = 'held'), 0)`.mapWith(Number),
        unknown: sql<number>`coalesce(sum(${mailOutbox.state} = 'unknown'), 0)`.mapWith(Number),
      }).from(mailOutbox).where(or(eq(mailOutbox.state, "held"), eq(mailOutbox.state, "unknown")));
      const degraded = Boolean(queueCounts?.stuck || queueCounts?.unresolved);
      return [
        { component: "jobs.queue", checkedAt: now, state: degraded ? "degraded" : "ok",
          summary: degraded ? "The queue has stuck jobs or unresolved outcomes." : "The queue is reachable.",
          metrics: { ...queueCounts, oldestQueuedSeconds: oldest ? Math.floor((now.getTime() - oldest.readyAt.getTime()) / 1000) : 0 } },
        { component: "jobs.mail", checkedAt: now, state: mail?.held || mail?.unknown ? "degraded" : "ok",
          summary: mail?.held || mail?.unknown ? "Some messages are held or have unknown outcomes." : "The outbox is reachable.",
          metrics: mail },
      ];
    },
  };
}
