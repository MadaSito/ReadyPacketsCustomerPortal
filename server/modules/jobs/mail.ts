import { and, asc, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { DeploymentProfile } from "../../config/env.js";
import { conflict, DomainError, notFound, validation } from "../../core/errors.js";
import { ULID_PATTERN, ulid } from "../../core/ids.js";
import type { AuditOutcome, ClaimedJob, JobQueue, JobResult, Mailer, MailTemplate, OutboundMail, Tx } from "../../core/types.js";
import { defineSetting, readSetting } from "../platform/settingsRegistry.js";
import { currentCorrelation, JOB_TYPE, keyHash, validKey, type QueueDeps } from "./queue.js";
import { mailAttempts, mailOutbox } from "./schema.js";

const DELIVER = "jobs.mail.deliver";
const EXPIRE = "jobs.mail.expire";
const MAX_TTL = 72 * 60 * 60_000;
const CAPTURE_TTL = 15 * 60_000;
const ONE_DAY = 24 * 60 * 60_000;
const VAR_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const HEADER_CONTROL = /[\p{Cc}\u2028\u2029]/u;
const address = z.email().max(254).refine((value) => !HEADER_CONTROL.test(value));
const varsSchema = z.record(z.string().regex(VAR_NAME), z.union([z.string().max(16_384), z.number(), z.boolean()]));
const payloadSchema = z.strictObject({
  to: z.union([z.strictObject({ userId: z.number().int().positive() }), z.strictObject({ address })]),
  vars: varsSchema,
});
const jobPayload = z.strictObject({ mailId: z.string().regex(ULID_PATTERN), generation: z.number().int().min(1).max(20) });
const captureSchema = z.strictObject({ to: address, subject: z.string().max(255), text: z.string().max(65_536) });
type MailRow = typeof mailOutbox.$inferSelect;
type RenderedMail = z.infer<typeof captureSchema>;
type DeliveryJob = z.infer<typeof jobPayload>;
type MailAttemptOutcome = "accepted" | "held" | "failed" | "unknown" | "captured";
export type SmtpDeliveryResult = { outcome: "accepted" | "not_configured" | "rejected" | "unknown"; retryable?: boolean };
type MailDeps = QueueDeps & { jobs: JobQueue };
type DeliveryDeps = {
  findRecipient(userId: number): Promise<{ email: string; status: string } | null>;
  send(input: RenderedMail & { html: string; signal: AbortSignal }): Promise<SmtpDeliveryResult>;
};

export function allowsMailCapture(profile: DeploymentProfile): boolean {
  return profile === "development" || profile === "test";
}

export const MAIL_CAPTURE = defineSetting({
  key: "jobs.mail.capture",
  owner: "jobs",
  group: "mail",
  label: "Development mail capture",
  description: "Capture outgoing mail locally for testing. This mode is refused in production.",
  schema: z.boolean(),
  default: false,
  sensitivity: "internal",
  exportable: false,
});

const mailers = new WeakMap<Mailer, MailEngine>();
export const mailEngineFor = (mailer: Mailer): MailEngine | undefined => mailers.get(mailer);

export function createMailer(deps: MailDeps): Mailer {
  const mailer = new MailEngine(deps);
  mailers.set(mailer, mailer);
  return mailer;
}

export async function mailAudit(
  deps: QueueDeps, tx: Tx, mail: Pick<MailRow, "publicId" | "correlationId" | "jobPublicId">, name: string,
  outcome: AuditOutcome, reasonCode?: string, system = false,
): Promise<void> {
  await deps.audit.record({
    category: "job", eventName: name, action: "transition", outcome, reasonCode,
    resource: { type: "mail", publicId: mail.publicId }, correlationId: mail.correlationId, jobId: mail.jobPublicId ?? undefined,
    ...(system ? { actor: { role: "system" } } : {}),
  }, tx);
}

function htmlAlternative(text: string): string {
  const escapes: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return `<!doctype html><html lang="en"><body><p>${text.replace(/[&<>"']/g, (character) => escapes[character]!).replace(/\r\n?|\n/g, "<br>")}</p></body></html>`;
}

export class MailEngine implements Mailer {
  readonly #templates = new Map<string, MailTemplate>();

  constructor(readonly deps: MailDeps) {}

  registerTemplate(template: MailTemplate): void {
    if (!JOB_TYPE.test(template.key) || template.key.length > 100 || this.#templates.size >= 250
      || this.#templates.has(template.key) || template.vars.length > 40 || new Set(template.vars).size !== template.vars.length
      || template.vars.some((name) => !VAR_NAME.test(name))
      || template.sensitiveVars?.some((name) => !template.vars.includes(name))) {
      throw new Error("INVALID_OR_DUPLICATE_MAIL_TEMPLATE");
    }
    this.#templates.set(template.key, { ...template, vars: [...template.vars], sensitiveVars: [...(template.sensitiveVars ?? [])] });
  }

  registerDelivery(delivery: DeliveryDeps): void {
    this.deps.jobs.register(DELIVER, (job) => this.#deliver(job, delivery));
    this.deps.jobs.register(EXPIRE, (job) => this.#expire(job), { retrySafe: true });
    this.deps.jobs.registerSchedule({ name: EXPIRE, type: EXPIRE, everyMs: 60_000 });
  }

  async enqueue(mail: OutboundMail, tx?: Tx): Promise<void> {
    const { deps } = this;
    const template = this.#templates.get(mail.template);
    const parsed = payloadSchema.safeParse({ to: mail.to, vars: mail.vars });
    if (!template || !parsed.success || !validKey(mail.idempotencyKey)
      || Object.keys(parsed.data.vars).some((name) => !template.vars.includes(name))) {
      throw validation("INVALID_MAIL_INPUT", "The mail input is not valid.");
    }
    // Validate output before accepting the message, then validate again on delivery.
    this.#content(template, parsed.data.vars);
    const now = deps.clock.now();
    const ttl = template.sensitiveVars?.length ? 30 * 60_000 : ONE_DAY;
    const requestedExpiry = mail.expiresAt?.getTime() ?? now.getTime() + ttl;
    if (!Number.isFinite(requestedExpiry) || requestedExpiry <= now.getTime()) {
      throw validation("INVALID_MAIL_EXPIRY", "The mail expiry is not valid.");
    }
    const expiresAt = new Date(Math.min(now.getTime() + MAX_TTL, requestedExpiry));
    const serialized = JSON.stringify(parsed.data);
    if (Buffer.byteLength(serialized) > 96 * 1024) throw validation("INVALID_MAIL_INPUT", "The mail input is not valid.");
    const run = async (inner: Tx) => {
      const publicId = ulid(now.getTime());
      const correlationId = currentCorrelation(publicId);
      const idempotencyHash = keyHash(mail.idempotencyKey);
      await inner.insert(mailOutbox).values({
        publicId, idempotencyHash, correlationId, template: template.key,
        payloadEnc: deps.crypto.encrypt(serialized, `mail_outbox.payload_enc:${publicId}`),
        expiresAt, createdAt: now, updatedAt: now,
      }).onDuplicateKeyUpdate({ set: { id: sql`${mailOutbox.id}` } });
      const [row] = await inner.select().from(mailOutbox)
        .where(eq(mailOutbox.idempotencyHash, idempotencyHash)).limit(1).for("update");
      if (!row) throw new Error("MAIL_ENQUEUE_INVARIANT");
      if (row.publicId !== publicId) return;
      const jobPublicId = await this.#queue(inner, row, 1);
      await inner.update(mailOutbox).set({ jobPublicId, updatedAt: now }).where(eq(mailOutbox.id, row.id));
      await mailAudit(deps, inner, { ...row, jobPublicId }, "job.mail.enqueued", "completed");
    };
    if (tx) await run(tx);
    else await deps.db.transaction(run);
  }

  async captureEnabled(): Promise<boolean> {
    const enabled = await readSetting(this.deps.settings, MAIL_CAPTURE);
    if (enabled && !allowsMailCapture(this.deps.config.deploymentProfile)) {
      throw new DomainError("FORBIDDEN", "MAIL_CAPTURE_FORBIDDEN", "Mail capture is available only in development and test.");
    }
    return enabled;
  }

  async resend(tx: Tx, publicId: string): Promise<{ jobId: string }> {
    const { deps } = this;
    const [row] = await tx.select().from(mailOutbox).where(eq(mailOutbox.publicId, publicId)).limit(1).for("update");
    if (!row) throw notFound();
    const now = deps.clock.now();
    if (
      (row.state !== "held" && row.state !== "failed") || row.payloadEnc === null
      || row.expiresAt <= now || row.generation >= 20
    ) throw conflict("MAIL_RESEND_UNSAFE", "This message cannot be safely resent.");
    const generation = row.generation + 1;
    const jobPublicId = await this.#queue(tx, row, generation);
    await tx.update(mailOutbox).set({ generation, jobPublicId, state: "queued", reasonCode: null, updatedAt: now })
      .where(eq(mailOutbox.id, row.id));
    await mailAudit(deps, tx, { ...row, jobPublicId }, "job.mail.resend.queued", "completed");
    return { jobId: jobPublicId };
  }

  async viewCapture(tx: Tx, publicId: string): Promise<RenderedMail> {
    if (!await this.captureEnabled()) throw notFound();
    const [row] = await tx.select().from(mailOutbox).where(eq(mailOutbox.publicId, publicId)).limit(1).for("share");
    if (!row || row.state !== "captured" || row.captureEnc === null || row.expiresAt <= this.deps.clock.now()) throw notFound();
    const value = captureSchema.parse(JSON.parse(this.deps.crypto.decrypt(row.captureEnc, `mail_outbox.capture_enc:${row.publicId}`)));
    await mailAudit(this.deps, tx, row, "job.mail.capture.viewed", "completed");
    return value;
  }

  async #queue(tx: Tx, row: MailRow, generation: number): Promise<string> {
    const { jobId } = await this.deps.jobs.enqueue(DELIVER, { mailId: row.publicId, generation }, {
      idempotencyKey: `${row.publicId}:${generation}`, correlationId: row.correlationId, maxAttempts: 1,
    }, tx);
    return jobId;
  }

  #content(template: MailTemplate, vars: OutboundMail["vars"]): Omit<RenderedMail, "to"> {
    try {
      const subject = template.subject(vars);
      const text = template.text(vars);
      if (typeof subject === "string" && subject.length >= 1 && subject.length <= 255 && !HEADER_CONTROL.test(subject)
        && typeof text === "string" && text.length >= 1 && text.length <= 65_536 && !text.includes("\0")) {
        return { subject, text };
      }
    } catch { /* never echo variables or raw renderer errors */ }
    throw validation("INVALID_MAIL_RENDER", "The message template could not be rendered safely.");
  }

  async #deliver(job: ClaimedJob, delivery: DeliveryDeps): Promise<JobResult> {
    const identifier = jobPayload.safeParse(job.payload);
    if (!identifier.success) return { outcome: "failed", reasonCode: "INVALID_MAIL_JOB", retryable: false };
    const ids = identifier.data;
    const { deps } = this;
    const [row] = await deps.db.select().from(mailOutbox).where(and(
      eq(mailOutbox.publicId, ids.mailId), eq(mailOutbox.generation, ids.generation),
      eq(mailOutbox.jobPublicId, job.jobId), eq(mailOutbox.state, "queued"),
    )).limit(1);
    if (!row) return { outcome: "completed" };

    let mode: boolean;
    let data: RenderedMail;
    try {
      mode = await this.captureEnabled();
      const template = this.#templates.get(row.template);
      if (!row.payloadEnc || !template) throw new Error("MAIL_PAYLOAD_UNAVAILABLE");
      const payload = payloadSchema.parse(JSON.parse(deps.crypto.decrypt(row.payloadEnc, `mail_outbox.payload_enc:${row.publicId}`)));
      const recipient = "userId" in payload.to ? await delivery.findRecipient(payload.to.userId) : { email: payload.to.address, status: "active" };
      if (!recipient || !["active", "pending_activation"].includes(recipient.status)) {
        return this.#preSendFailure(job, ids, "MAIL_RECIPIENT_UNAVAILABLE", true);
      }
      data = { ...this.#content(template, payload.vars), to: address.parse(recipient.email) };
    } catch (error) {
      return this.#preSendFailure(job, ids,
        error instanceof DomainError && error.reasonCode === "MAIL_CAPTURE_FORBIDDEN"
          ? "MAIL_CAPTURE_FORBIDDEN" : "MAIL_PREPARATION_FAILED", false);
    }

    const begin = await deps.db.transaction(async (tx) => {
      const current = await this.#lockedMail(tx, job, ids, "queued");
      if (!current) return false;
      const now = deps.clock.now();
      if (current.expiresAt <= now) {
        await tx.update(mailOutbox).set({
          state: "expired", reasonCode: "MAIL_EXPIRED", payloadEnc: null, captureEnc: null, updatedAt: now,
        }).where(eq(mailOutbox.id, current.id));
        await mailAudit(deps, tx, current, "job.mail.expired", "canceled", "MAIL_EXPIRED", true);
        return false;
      }
      if (mode) {
        await tx.insert(mailAttempts).values({
          mailId: current.id, generation: current.generation, state: "captured", startedAt: now, finishedAt: now,
        });
        await tx.update(mailOutbox).set({
          state: "captured", payloadEnc: null,
          captureEnc: deps.crypto.encrypt(JSON.stringify(data), `mail_outbox.capture_enc:${current.publicId}`),
          expiresAt: new Date(Math.min(current.expiresAt.getTime(), now.getTime() + CAPTURE_TTL)), updatedAt: now,
        }).where(eq(mailOutbox.id, current.id));
        await mailAudit(deps, tx, current, "job.mail.captured", "completed", "MAIL_CAPTURE_ONLY", true);
        return false;
      }
      await tx.update(mailOutbox).set({ state: "sending", updatedAt: now }).where(eq(mailOutbox.id, current.id));
      await tx.insert(mailAttempts).values({ mailId: current.id, generation: current.generation, state: "sending", startedAt: now });
      await mailAudit(deps, tx, current, "job.mail.sending", "attempted", undefined, true);
      return true;
    });
    if (!begin) return { outcome: "completed" };

    await job.assertStillOwned();
    let deliveryResult: SmtpDeliveryResult;
    try {
      deliveryResult = await delivery.send({ ...data, html: htmlAlternative(data.text), signal: job.signal });
    } catch {
      deliveryResult = { outcome: "unknown" };
    }
    const outcome: MailAttemptOutcome = deliveryResult.outcome === "accepted" ? "accepted"
      : deliveryResult.outcome === "not_configured" ? "held" : deliveryResult.outcome === "rejected" ? "failed" : "unknown";
    const reasonCode = outcome === "accepted" ? "MAIL_SMTP_ACCEPTED"
      : outcome === "held" ? "MAIL_NOT_CONFIGURED"
        : outcome === "unknown" ? "MAIL_PROVIDER_OUTCOME_UNKNOWN" : "MAIL_PROVIDER_REJECTED";
    await deps.db.transaction(async (tx) => {
      const current = await this.#lockedMail(tx, job, ids, "sending");
      if (!current) throw new Error("MAIL_FENCE_INCONSISTENT");
      const now = deps.clock.now();
      await tx.update(mailAttempts).set({ state: outcome, reasonCode, finishedAt: now })
        .where(and(eq(mailAttempts.mailId, current.id), eq(mailAttempts.generation, current.generation)));
      await tx.update(mailOutbox).set({
        state: outcome, reasonCode, updatedAt: now,
        ...(outcome === "accepted" || outcome === "unknown" || (outcome === "failed" && !deliveryResult.retryable) ? { payloadEnc: null } : {}),
      }).where(eq(mailOutbox.id, current.id));
      const name = outcome === "accepted" ? "job.mail.accepted" : outcome === "held" ? "job.mail.held"
        : outcome === "failed" ? "job.mail.failed" : "job.mail.unknown";
      await mailAudit(deps, tx, current, name, outcome === "accepted" ? "completed" : outcome === "held" ? "refused" : outcome, reasonCode, true);
    });
    if (outcome === "unknown") return { outcome: "unknown", reasonCode };
    if (outcome === "failed") return { outcome: "failed", reasonCode, retryable: false };
    return { outcome: "completed" };
  }

  async #lockedMail(tx: Tx, job: ClaimedJob, ids: DeliveryJob, expected: "queued" | "sending") {
    await job.assertStillOwned(tx);
    const [current] = await tx.select().from(mailOutbox).where(and(
      eq(mailOutbox.publicId, ids.mailId), eq(mailOutbox.generation, ids.generation),
      eq(mailOutbox.jobPublicId, job.jobId), eq(mailOutbox.state, expected),
    )).limit(1).for("update");
    return current;
  }

  async #preSendFailure(job: ClaimedJob, ids: DeliveryJob, reasonCode: string, purge: boolean): Promise<JobResult> {
    const { deps } = this;
    await deps.db.transaction(async (tx) => {
      const current = await this.#lockedMail(tx, job, ids, "queued");
      if (!current) return;
      const now = deps.clock.now();
      await tx.insert(mailAttempts).values({
        mailId: current.id, generation: current.generation, state: "failed", reasonCode, startedAt: now, finishedAt: now,
      });
      await tx.update(mailOutbox).set({ state: "failed", reasonCode, updatedAt: now, ...(purge ? { payloadEnc: null } : {}) })
        .where(eq(mailOutbox.id, current.id));
      await mailAudit(deps, tx, current, "job.mail.failed", "failed", reasonCode, true);
    });
    return { outcome: "failed", reasonCode, retryable: false };
  }

  async #expire(job: ClaimedJob): Promise<JobResult> {
    const { deps } = this;
    let purged = 0;
    for (let batch = 0; batch < 8; batch += 1) {
      const changed = await deps.db.transaction(async (tx) => {
        await job.assertStillOwned(tx);
        const now = deps.clock.now();
        const rows = await tx.select().from(mailOutbox).where(and(
          lte(mailOutbox.expiresAt, now),
          inArray(mailOutbox.state, ["queued", "held", "failed", "captured"]),
          or(isNotNull(mailOutbox.payloadEnc), isNotNull(mailOutbox.captureEnc)),
        )).orderBy(asc(mailOutbox.expiresAt), asc(mailOutbox.id)).limit(50).for("update", { skipLocked: true });
        for (const row of rows) {
          const state = row.state === "captured" ? "captured" : "expired";
          await tx.update(mailOutbox).set({ state, payloadEnc: null, captureEnc: null, updatedAt: now,
            reasonCode: state === "expired" ? "MAIL_EXPIRED" : row.reasonCode }).where(eq(mailOutbox.id, row.id));
          await mailAudit(deps, tx, row, state === "expired" ? "job.mail.expired" : "job.mail.capture.purged",
            state === "expired" ? "canceled" : "completed", "MAIL_EXPIRED", true);
        }
        return rows.length;
      }, { isolationLevel: "read committed" });
      purged += changed;
      if (changed < 50) break;
    }
    return { outcome: "completed", safeCounts: { purged } };
  }
}
