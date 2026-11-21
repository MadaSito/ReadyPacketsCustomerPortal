import { and, asc, desc, eq, lt, lte, or, sql } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import { conflict, DomainError, forbidden, notFound, validation } from "../../core/errors.js";
import { ULID_PATTERN } from "../../core/ids.js";
import type { ModuleHealth, SessionPrincipal, Tx } from "../../core/types.js";
import { roleHasCapability, STEP_UP_CAPABILITIES, type Capability } from "../../../shared/capabilities.js";
import { STEP_UP_MAX_AGE_MS } from "../../trpc/trpc.js";
import { createCustomerMaintenance } from "./customerMaintenance.js";
import { allowsMailCapture, mailAudit, mailEngineFor } from "./mail.js";
import { engineFor, ensureMaintenanceGate, gateDraining, jobAudit, MAINTENANCE_ID } from "./queue.js";
import { type JOB_STATES, jobAttempts, jobMaintenance, jobRuns, type MAIL_STATES, mailAttempts, mailManualResends, mailOutbox, mailTransportAttempts } from "./schema.js";

type JobState = (typeof JOB_STATES)[number];
type MailState = (typeof MAIL_STATES)[number];
type Page = { limit?: number; cursor?: string };
export type JobList = Page & { type?: string; state?: JobState };
export type MailList = Page & { state?: MailState };
export type OutboxJobDisposition =
  | { state: "running_live" }
  | { state: "queued_live" }
  | { state: "settled_unknown" }
  | { state: "canceled_queued" }
  | { state: "missing" }
  | { state: "terminal"; jobState: Exclude<JobState, "queued" | "running"> };
const activeMessage = "Maintenance is in progress. Some operations are temporarily unavailable.";

const jobView = {
  publicId: jobRuns.publicId, type: jobRuns.type, state: jobRuns.state, correlationId: jobRuns.correlationId,
  attempt: jobRuns.attempt, maxAttempts: jobRuns.maxAttempts, reasonCode: jobRuns.reasonCode,
  allowRetry: jobRuns.allowRetry, reconciledAt: jobRuns.reconciledAt, runAt: jobRuns.runAt, leaseUntil: jobRuns.leaseUntil,
  interruptionPending: jobRuns.interruptionPending,
  scheduleName: jobRuns.scheduleName, createdAt: jobRuns.createdAt, updatedAt: jobRuns.updatedAt,
};
const mailView = {
  publicId: mailOutbox.publicId, template: mailOutbox.template, state: mailOutbox.state, reasonCode: mailOutbox.reasonCode,
  correlationId: mailOutbox.correlationId, jobPublicId: mailOutbox.jobPublicId, generation: mailOutbox.generation,
  expiresAt: mailOutbox.expiresAt, createdAt: mailOutbox.createdAt, updatedAt: mailOutbox.updatedAt,
  hasPayload: sql<boolean>`${mailOutbox.payloadEnc} is not null`.mapWith(Boolean),
  contentExpiresAt: mailOutbox.contentExpiresAt,
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
  const customerMaintenance = createCustomerMaintenance(deps);
  const unresolved = sql`(
    (${jobRuns.state} = 'unknown' and ${jobRuns.reconciledAt} is null)
     or (${jobRuns.state} = 'queued' and ${jobRuns.interruptionPending} = true)
  )`;
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

  async function limitVerification(subject: "request" | "confirm") {
    const verdict = await deps.rateLimiter.consume("expensive", `mail:audit-copy:${subject}`, 1);
    if (!verdict.allowed) {
      throw new DomainError("RATE_LIMITED", "MAIL_AUDIT_RATE_LIMITED", "Wait before trying mailbox verification again.", {
        retryAfterSeconds: verdict.retryAfterSeconds,
      });
    }
  }

  async function assertCurrentAdminActor(principal: SessionPrincipal | null,
    capability: "mail.manage" | "mail.content.read" | "maintenance.manage", tx: Tx) {
    const sessions = deps.services.identity?.sessions;
    if (!principal || !sessions?.assertCurrent) throw forbidden("ACTOR_UNVERIFIABLE");
    const current = await sessions.assertCurrent(principal, tx);
    if (current.role !== "admin" || current.pendingSteps.length || !roleHasCapability(current.role, capability)) {
      throw forbidden("CAPABILITY_NOT_GRANTED");
    }
    const now = clock.now().getTime();
    const at = current.stepUpAt?.getTime() ?? Number.NaN;
    if (!(at <= now && at >= now - STEP_UP_MAX_AGE_MS)) {
      throw new DomainError("STEP_UP_REQUIRED", "STEP_UP_REQUIRED", "Confirm your password and authentication code to continue.", { capability });
    }
  }

  async function withCurrentAdminActor<T>(principal: SessionPrincipal | null, capability: "mail.manage" | "mail.content.read" | "maintenance.manage",
    run: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    let denied = false;
    try {
      return await db.transaction(async (tx) => {
        try { await assertCurrentAdminActor(principal, capability, tx); }
        catch (error) {
          denied = error instanceof DomainError;
          throw error;
        }
        return run(tx);
      });
    } catch (error) {
      if (denied) {
        await deps.audit.record({
          category: "security", eventName: "job.admin.denied", action: "authorize", outcome: "denied",
          reasonCode: capability === "maintenance.manage" ? "MAINTENANCE_ACTOR_NOT_CURRENT" : "MAIL_ACTOR_NOT_CURRENT",
          resource: { type: "job_admin" },
          actor: principal ? { userId: principal.userId, role: principal.role } : { role: "anonymous" },
        });
      }
      throw error;
    }
  }

  async function drainCounts(executor: Tx | typeof db) {
    const [counts] = await executor.select({
      running: sql<number>`coalesce(sum(${jobRuns.state} = 'running'), 0)`.mapWith(Number),
      unresolved: sql<number>`coalesce(sum(${unresolved}), 0)`.mapWith(Number),
    }).from(jobRuns).where(or(eq(jobRuns.state, "running"), unresolved));
    return counts ?? { running: 0, unresolved: 0 };
  }

  async function lockJob(tx: Tx, publicId: string) {
    const [row] = await tx.select().from(jobRuns).where(eq(jobRuns.publicId, publicId)).limit(1).for("update");
    return row;
  }

  async function cancelQueued(tx: Tx, row: typeof jobRuns.$inferSelect, system = false):
    Promise<{ publicId: string; state: "unknown" | "canceled" }> {
    const now = clock.now();
    const uncertain = row.interruptionPending;
    const state = uncertain ? "unknown" : "canceled";
    const reasonCode = uncertain ? "JOB_RETRY_CANCELED_UNCERTAIN" : "JOB_CANCELED";
    await tx.update(jobRuns).set({ state, reasonCode, interruptionPending: false, payloadEnc: null, updatedAt: now })
      .where(eq(jobRuns.id, row.id));
    if (row.type === "jobs.mail.deliver") {
      const [mail] = await tx.select().from(mailOutbox)
        .where(and(eq(mailOutbox.jobPublicId, row.publicId), eq(mailOutbox.state, "queued"))).limit(1).for("update");
      if (mail) {
        await tx.update(mailOutbox).set({ state: "canceled", reasonCode: "MAIL_CANCELED", payloadEnc: null, updatedAt: now })
          .where(eq(mailOutbox.id, mail.id));
        await mailAudit(deps, tx, mail, "job.mail.canceled", "canceled", "MAIL_CANCELED", system);
      }
    }
    await jobAudit(deps, tx, row, "job.canceled", "canceled", "JOB_CANCELED", system);
    if (uncertain) await jobAudit(deps, tx, row, "job.unknown", "unknown", reasonCode, system);
    return { publicId: row.publicId, state };
  }

  return {
    isDraining,
    async reconcileOutboxJob(jobPublicId: string, tx: Tx, options?: { cancelQueued?: boolean }): Promise<OutboxJobDisposition> {
      const row = await lockJob(tx, jobPublicId);
      if (!row) return { state: "missing" };
      if (row.state === "running") {
        const engine = engineFor(deps.jobs);
        if (!engine) throw new DomainError("UNAVAILABLE", "JOB_QUEUE_UNAVAILABLE", "The durable job queue is unavailable.");
        return engine.reconcileOutboxLease(tx, row);
      }
      if (row.state === "queued") {
        if (!options?.cancelQueued) return { state: "queued_live" };
        await cancelQueued(tx, row, true);
        return { state: "canceled_queued" };
      }
      return { state: "terminal", jobState: row.state };
    },
    async maintenanceBanner() {
      const active = await isDraining();
      return { active, message: active ? activeMessage : null };
    },
    maintenance: {
      customerAccess: customerMaintenance.customerAccess,
    },
    async customerMaintenance(principal: SessionPrincipal | null) {
      await authorize(principal, "jobs.read");
      return customerMaintenance.read();
    },
    async setCustomerMaintenance(principal: SessionPrincipal | null, input: Parameters<typeof customerMaintenance.write>[1]) {
      await authorize(principal, "maintenance.manage");
      return withCurrentAdminActor(principal, "maintenance.manage", (tx) => customerMaintenance.write(principal!, input, tx));
    },
    async workerMaintenance(principal: SessionPrincipal | null) {
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
        const row = await lockJob(tx, publicId);
        if (!row) throw notFound();
        if (row.state !== "queued") throw conflict("JOB_CANCEL_UNSAFE", "Only jobs that are waiting to run can be canceled.");
        return cancelQueued(tx, row);
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
      const canReadCaptures = allowsMailCapture(deps.config.deploymentProfile)
        && rows.some((row) => row.state === "captured" && row.expiresAt > now)
        && await (mailEngineFor(deps.mailer)?.captureEnabled() ?? false);
      const canReadContent = rows.some(({ contentExpiresAt }) => contentExpiresAt && contentExpiresAt > now)
        && !!await mailEngineFor(deps.mailer)?.retentionDays();
      const safe = rows.map(({ hasPayload, contentExpiresAt, ...row }) => ({
        ...row,
        canResend: hasPayload && ["held", "failed", "unknown"].includes(row.state) && row.expiresAt > now && row.generation < 20,
        canViewCapture: row.state === "captured" && row.expiresAt > now && canReadCaptures,
        canViewContent: canReadContent && !!contentExpiresAt && contentExpiresAt > now,
      }));
      return pageOf(safe, limit);
    },
    async mailDetail(principal: SessionPrincipal | null, publicId: string) {
      await authorize(principal, "jobs.read");
      const [row] = await db.select({ id: mailOutbox.id }).from(mailOutbox).where(eq(mailOutbox.publicId, publicId)).limit(1);
      if (!row) throw notFound();
      const prior = await db.select({
        generation: mailAttempts.generation, state: mailAttempts.state, reasonCode: mailAttempts.reasonCode,
        startedAt: mailAttempts.startedAt, finishedAt: mailAttempts.finishedAt,
      }).from(mailAttempts).where(eq(mailAttempts.mailId, row.id)).orderBy(desc(mailAttempts.generation)).limit(20);
      const deliveries = await db.select({
        generation: mailTransportAttempts.generation, state: mailTransportAttempts.state,
        reasonCode: mailTransportAttempts.reasonCode, startedAt: mailTransportAttempts.startedAt,
        finishedAt: mailTransportAttempts.finishedAt, transport: mailTransportAttempts.transport, purpose: mailTransportAttempts.purpose,
      }).from(mailTransportAttempts).where(eq(mailTransportAttempts.mailId, row.id)).orderBy(desc(mailTransportAttempts.id)).limit(60);
      const manual = await db.select({ generation: mailManualResends.generation, queuedAt: mailManualResends.queuedAt })
        .from(mailManualResends).where(eq(mailManualResends.mailId, row.id)).orderBy(desc(mailManualResends.generation)).limit(20);
      const attempts = [...deliveries, ...prior.map((item) => ({ ...item, transport: null, purpose: "legacy" as const })),
        ...manual.map(({ generation, queuedAt }) => ({
          generation, startedAt: queuedAt, finishedAt: queuedAt, transport: null,
          purpose: "manual_resend_after_unknown" as const, state: "queued" as const, reasonCode: "MAIL_DUPLICATE_RISK_ACKNOWLEDGED",
        }))]
        .sort((a, b) => b.generation - a.generation || b.startedAt.getTime() - a.startedAt.getTime());
      return { publicId, attempts };
    },
    async resend(principal: SessionPrincipal | null, publicId: string, options: {
      acknowledgeDuplicateRisk?: true; expectedGeneration?: number;
    } = {}) {
      const acknowledged = options.acknowledgeDuplicateRisk === true;
      await authorize(principal, acknowledged ? "mail.manage" : "jobs.manage");
      await ensureMaintenanceGate(deps);
      const queueResend = async (tx: Tx) => {
        if (await gateDraining(tx)) throw new DomainError("MAINTENANCE", "PORTAL_DRAINING", activeMessage);
        return mailer().resend(tx, publicId, {
          expectedGeneration: options.expectedGeneration, duplicateRiskAcceptedBy: acknowledged ? principal! : undefined,
        });
      };
      return acknowledged ? withCurrentAdminActor(principal, "mail.manage", queueResend) : db.transaction(queueResend);
    },
    async capture(principal: SessionPrincipal | null, publicId: string) {
      await authorize(principal, "jobs.mail.capture");
      return db.transaction((tx) => mailer().viewCapture(tx, publicId));
    },
    async mailContent(principal: SessionPrincipal | null, publicId: string) {
      await authorize(principal, "mail.content.read");
      return withCurrentAdminActor(principal, "mail.content.read", (tx) => mailer().viewContent(tx, publicId));
    },
    async auditCopyStatus(principal: SessionPrincipal | null) {
      await authorize(principal, "mail.manage");
      return mailer().auditCopyStatus();
    },
    async requestAuditCopyVerification(principal: SessionPrincipal | null) {
      await authorize(principal, "mail.manage");
      await limitVerification("request");
      await ensureMaintenanceGate(deps);
      return withCurrentAdminActor(principal, "mail.manage", async (tx) => {
        if (await gateDraining(tx)) throw new DomainError("MAINTENANCE", "PORTAL_DRAINING", activeMessage);
        return mailer().requestAuditCopyVerification(tx);
      });
    },
    async confirmAuditCopyVerification(principal: SessionPrincipal | null, code: string): Promise<{ verified: true }> {
      await authorize(principal, "mail.manage");
      await limitVerification("confirm");
      const result = await withCurrentAdminActor(principal, "mail.manage", (tx) => mailer().confirmAuditCopyVerification(tx, code));
      if (!result.verified) throw validation("MAIL_AUDIT_CODE_INVALID", "The code is invalid or expired. Request a new code and try again.");
      return { verified: true };
    },
    async health(): Promise<ModuleHealth[]> {
      const now = clock.now();
      const [queueCounts] = await db.select({
        queued: sql<number>`coalesce(sum(${jobRuns.state} = 'queued'), 0)`.mapWith(Number),
        running: sql<number>`coalesce(sum(${jobRuns.state} = 'running'), 0)`.mapWith(Number),
        stuck: sql<number>`coalesce(sum(${jobRuns.state} = 'running' and ${jobRuns.leaseUntil} <= ${now.toISOString().slice(0, 23).replace("T", " ")}), 0)`.mapWith(Number),
        unknown: sql<number>`coalesce(sum(${jobRuns.state} = 'unknown'), 0)`.mapWith(Number),
        unresolved: sql<number>`coalesce(sum(${unresolved}), 0)`.mapWith(Number),
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
