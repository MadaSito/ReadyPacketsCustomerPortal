import { randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { DeploymentProfile } from "../../config/env.js";
import { conflict, DomainError, notFound, validation } from "../../core/errors.js";
import { ULID_PATTERN, ulid } from "../../core/ids.js";
import type { AuditOutcome, ClaimedJob, JobQueue, JobResult, Mailer, MailTemplate, OutboundMail, SessionPrincipal, Tx } from "../../core/types.js";
import { inertPlainTextToDeliveryHtml } from "../mailTemplates/sanitizer.js";
import { buildSystemTemplateMetadata, renderShippedMail } from "../mailTemplates/systemCatalogue.js";
import { defineSetting, readSetting } from "../platform/settingsRegistry.js";
import { decodeMailAttachments, encodeMailAttachments, storedAttachments } from "./mailAttachments.js";
import type { MailSenderIdentity, MailTemplateStore, MailTransport, MailTransportKey, MailTransportResult, PublishedMailTemplate } from "./mailPorts.js";
import { HEADER_CONTROL, MAIL_AUDIT_COPY, MAIL_RETAIN_CONTENT, MAIL_RETENTION_DAYS, MAIL_ROUTING, MAIL_SENDER, mailAddress as address } from "./mailSettings.js";
import { hasHiddenMailBinding, latestMailRelevantPurge, type createMailTrashGuard, type MailTrashScope } from "./mailTrash.js";
import { currentCorrelation, JOB_TYPE, keyHash, validKey, type QueueDeps } from "./queue.js";
import { POLICY_UPDATE_TEMPLATE, POLICY_WARNING_TEMPLATE } from "./policyNoticeJobs.js";
import { PAYMENT_RECEIPT_TEMPLATE } from "./receiptMail.js";
import { mailAttempts, mailAuditVerification, mailManualResends, mailOutbox, mailTransportAttempts } from "./schema.js";

const DELIVER = "jobs.mail.deliver";
const EXPIRE = "jobs.mail.expire";
const MAX_TTL = 72 * 60 * 60_000;
const CAPTURE_TTL = 15 * 60_000;
const ONE_DAY = 24 * 60 * 60_000;
const VAR_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const VERIFY_AUDIT = "jobs.mail.verify_audit_copy";
const VERIFY_TTL = 30 * 60_000;
const REDACTED = "[REDACTED]";
const varsSchema = z.record(z.string().regex(VAR_NAME), z.union([z.string().max(16_384), z.number(), z.boolean()]));
const payloadSchema = z.strictObject({
  to: z.union([z.strictObject({ userId: z.number().int().positive() }), z.strictObject({ address })]),
  vars: varsSchema,
  sensitiveVars: z.array(z.string().regex(VAR_NAME)).max(40).optional(),
  attachments: storedAttachments,
  orderId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  recipientAccountId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  trashScoped: z.literal(true).optional(),
});
const jobPayload = z.strictObject({ mailId: z.string().regex(ULID_PATTERN), generation: z.number().int().min(1).max(20) });
const captureSchema = z.strictObject({ to: address, subject: z.string().max(255), text: z.string().max(65_536) });
const contentSchema = captureSchema.extend({ html: z.string().max(512 * 1024) });
const storedCaptureSchema = captureSchema.extend({ trashScoped: z.literal(true).optional() });
const storedContentSchema = contentSchema.extend({ trashScoped: z.literal(true).optional() });
type MailRow = typeof mailOutbox.$inferSelect;
type RenderedMail = z.infer<typeof captureSchema>;
type MessageContent = z.infer<typeof contentSchema>;
type DeliverableContent = MessageContent & { attachments?: OutboundMail["attachments"] };
type DeliveryJob = z.infer<typeof jobPayload>;
type MailAttemptOutcome = "accepted" | "held" | "failed" | "unknown" | "captured";
type AttemptPurpose = typeof mailTransportAttempts.$inferSelect.purpose;
type MailDeliveryResult = MailTransportResult | { outcome: "expired" | "suppressed"; retryable?: never };
export type SmtpDeliveryResult = MailTransportResult;
type MailDeps = QueueDeps & { jobs: JobQueue };
type MailRecipient = { email: string; status: string; emailVerified: boolean; firstName?: string | null; preferredName?: string | null };
type DeliveryDeps = {
  findRecipient(userId: number): Promise<MailRecipient | null>;
  getLegacySender(): Promise<MailSenderIdentity | null>;
  trashGuard?: ReturnType<typeof createMailTrashGuard>;
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
  outcome: AuditOutcome, reasonCode?: string, system = false, action: "transition" | "read" = "transition",
): Promise<void> {
  await deps.audit.record({
    category: "job", eventName: name, action, outcome, reasonCode,
    resource: { type: "mail", publicId: mail.publicId }, correlationId: mail.correlationId, jobId: mail.jobPublicId ?? undefined,
    ...(system ? { actor: { role: "system" } } : {}),
  }, tx);
}

function escapeHtml(text: string): string {
  const escapes: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return text.replace(/[&<>"']/g, (character) => escapes[character]!);
}

const ORDER_CONTEXT_FIELDS = [["orderReference", "Order"], ["projectName", "Project"]] as const;
const INVOICE_NOTICE_TEMPLATES = new Set(["compliance.invoice_issued", "compliance.invoice_paid"]);
const AUTH_GREETING_TEMPLATES = new Set(["auth.verify_email", "auth.invitation"]);

function withRecipientGreeting(template: PublishedMailTemplate, vars: OutboundMail["vars"], recipient: MailRecipient) {
  const greeting = recipient.preferredName?.trim() || recipient.firstName?.trim();
  if (!greeting) return vars;
  const name = AUTH_GREETING_TEMPLATES.has(template.key) ? "name" : "recipient_name";
  return template.vars.includes(name) ? { ...vars, [name]: greeting } : vars;
}

function orderContextLines(vars: OutboundMail["vars"]): string[] {
  return ORDER_CONTEXT_FIELDS.flatMap(([key, label]) => {
    const raw = vars[key];
    const value = typeof raw === "string" ? raw.replace(/\s+/gu, " ").trim() : "";
    return value ? [`${label}: ${value}`] : [];
  });
}

/** Comparison-only projection. Never use this text to render or sanitize HTML. */
function invoiceLabelComparisonText(html: string): string {
  let depth = 0;
  let text = "";
  for (const character of html) {
    if (character === "<") {
      depth += 1;
    } else if (character === ">") {
      if (depth > 0) depth -= 1;
    } else if (depth === 0) {
      text += character;
    }
  }
  return text.replace(/(?:&nbsp;|\s)+/gu, " ");
}

function prependOrderContext(
  rendered: ReturnType<PublishedMailTemplate["render"]>,
  lines: string[],
  deduplicate: boolean,
) {
  if (!lines.length) return rendered;
  const textBody = deduplicate ? rendered.text.replace(/\s+/gu, " ") : "";
  const missingText = deduplicate ? lines.filter((line) => !textBody.includes(line)) : lines;
  const text = missingText.length ? `${missingText.join("\n")}\n\n${rendered.text}` : rendered.text;
  if (rendered.html === undefined) return { ...rendered, text };
  const htmlBody = deduplicate ? invoiceLabelComparisonText(rendered.html) : "";
  const missingHtml = deduplicate ? lines.filter((line) => !htmlBody.includes(escapeHtml(line))) : lines;
  if (!missingHtml.length) return { ...rendered, text };
  const block = `<p>${missingHtml.map(escapeHtml).join("<br>")}</p>`;
  const html = /<body\b[^>]*>/iu.test(rendered.html)
    ? rendered.html.replace(/<body\b[^>]*>/iu, (body) => `${body}${block}`)
    : `${block}${rendered.html}`;
  return { ...rendered, text, html };
}

export const ORDER_PHASE_UPDATE_TEMPLATE: MailTemplate = {
  key: "orders.phase_update",
  vars: ["reference", "link"],
  subject: () => "An update to your ReadyPackets order",
  text: ({ reference, link }) => `There is an update to order ${reference}.\n\nSign in to review your order:\n${link}`,
};

export class MailEngine implements Mailer {
  readonly #templates = new Map<string, MailTemplate>();
  readonly #transports = new Map<MailTransportKey, MailTransport>();
  #templateStore: MailTemplateStore | undefined;

  constructor(readonly deps: MailDeps) {
    this.registerTemplate(ORDER_PHASE_UPDATE_TEMPLATE);
    this.registerTemplate({
      key: PAYMENT_RECEIPT_TEMPLATE,
      vars: ["receiptNumber", ...ORDER_CONTEXT_FIELDS.map(([key]) => key)],
      sensitiveVars: ["receiptNumber"],
      subject: () => "Your ReadyPackets payment receipt",
      text: (vars) => {
        const lines = orderContextLines(vars);
        const message = `Thank you for your payment. Your ReadyPackets payment receipt number is ${vars.receiptNumber}.`;
        return lines.length ? `${lines.join("\n")}\n\n${message}` : message;
      },
    });
    this.registerTemplate({
      key: POLICY_UPDATE_TEMPLATE,
      vars: ["policyTitle", "summary", "portalUrl"],
      subject: () => "A ReadyPackets policy has been updated",
      text: ({ policyTitle, summary, portalUrl }) => `Policy update: ${policyTitle}\n\n${summary}\n\nReview the updated policy in the ReadyPackets portal:\n${portalUrl}`,
    });
    this.registerTemplate({
      key: POLICY_WARNING_TEMPLATE,
      vars: ["policyTitle", "deadline", "warningText", "portalUrl"],
      subject: () => "Action required: Review a ReadyPackets policy",
      text: ({ policyTitle, deadline, warningText, portalUrl }) => `Policy: ${policyTitle}\nDeadline: ${deadline}\n\n${warningText}\n\nReview and accept the updated policy in the ReadyPackets portal:\n${portalUrl}`,
    });
    this.registerTemplate({
      key: VERIFY_AUDIT,
      vars: ["code"],
      sensitiveVars: ["code"],
      subject: () => "Confirm the ReadyPackets audit mailbox",
      text: ({ code }) => `Enter this one-time confirmation code in the ReadyPackets E-mail delivery settings:\n\n${code}\n\nIt expires in 30 minutes. Ignore this message if you did not expect it.`,
    });
  }

  registerMailTransport(transport: MailTransport): void {
    if ((transport.key !== "smtp" && transport.key !== "graph") || this.#transports.has(transport.key)) {
      throw new Error("INVALID_OR_DUPLICATE_MAIL_TRANSPORT");
    }
    this.#transports.set(transport.key, transport);
  }

  registerMailTemplateStore(store: MailTemplateStore): void {
    if (this.#templateStore) throw new Error("DUPLICATE_MAIL_TEMPLATE_STORE");
    this.#templateStore = store;
  }

  getBuiltinMailTemplates(): readonly MailTemplate[] {
    return [...this.#templates.values()].filter(({ key }) => key !== VERIFY_AUDIT).map((template) => ({
      ...template,
      vars: [...template.vars],
      sensitiveVars: [...(template.sensitiveVars ?? [])],
    }));
  }

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
    this.#getLegacySender = delivery.getLegacySender;
    this.#trashGuard = delivery.trashGuard;
    this.deps.jobs.register(DELIVER, (job) => this.#deliver(job, delivery));
    this.deps.jobs.register(EXPIRE, (job) => this.#expire(job), { retrySafe: true });
    this.deps.jobs.registerSchedule({ name: EXPIRE, type: EXPIRE, everyMs: 60_000 });
  }

  #getLegacySender: DeliveryDeps["getLegacySender"] = async () => null;
  #trashGuard: DeliveryDeps["trashGuard"];
  #backfillAfter = 0;
  #historicalCopiesAfter = 0;

  #readPayload(row: MailRow) {
    if (row.payloadEnc === null) throw new Error("MAIL_PAYLOAD_UNAVAILABLE");
    return payloadSchema.parse(JSON.parse(this.deps.crypto.decrypt(row.payloadEnc, `mail_outbox.payload_enc:${row.publicId}`)));
  }

  #scope(row: MailRow, payload: z.infer<typeof payloadSchema>): MailTrashScope {
    return {
      ...payload, template: row.template, orderId: row.orderId ?? payload.orderId,
      recipientAccountId: row.recipientAccountId ?? payload.recipientAccountId,
      legacyCreatedAt: payload.trashScoped === true ? undefined : row.createdAt,
    };
  }

  #legacyTooOld(scope: MailTrashScope, now: Date) {
    return scope.legacyCreatedAt !== undefined && "address" in scope.to && scope.recipientAccountId === undefined
      && now.getTime() - scope.legacyCreatedAt.getTime() >= MAX_TTL;
  }

  async #checkHistoricalCopy(tx: Tx, row: MailRow, trashScoped: true | undefined) {
    if (!this.#trashGuard || trashScoped || (row.orderId !== null && row.recipientAccountId !== null)) return;
    const latest = await latestMailRelevantPurge(tx);
    if (latest && latest >= row.createdAt) throw notFound();
  }

  async getMailSenderIdentity(): Promise<MailSenderIdentity | null> {
    const configured = await readSetting(this.deps.settings, MAIL_SENDER);
    if (!configured.fromAddress) return this.#getLegacySender();
    return {
      fromAddress: configured.fromAddress, fromName: configured.fromName,
      ...(configured.replyToAddress ? { replyToAddress: configured.replyToAddress } : {}),
    };
  }

  async getMailReadiness(smtpReady: () => Promise<boolean>): Promise<{ ready: boolean }> {
    if (!await this.getMailSenderIdentity()) return { ready: false };
    const { primary, secondary } = await readSetting(this.deps.settings, MAIL_ROUTING);
    async function isConfigured(key: MailTransportKey, transport?: MailTransport) {
      if (key === "smtp") return smtpReady();
      return !!transport && transport.isConfigured();
    }
    if (await isConfigured(primary, this.#transports.get(primary))) return { ready: true };
    return { ready: secondary !== "none" && await isConfigured(secondary, this.#transports.get(secondary)) };
  }

  async retentionDays(tx?: Tx): Promise<number> {
    if (!await readSetting(this.deps.settings, MAIL_RETAIN_CONTENT, tx)) return 0;
    return readSetting(this.deps.settings, MAIL_RETENTION_DAYS, tx);
  }

  async #template(key: string, tx?: Tx): Promise<PublishedMailTemplate | null> {
    const builtin = this.#templates.get(key);
    const published = key === VERIFY_AUDIT ? null : await this.#templateStore?.resolve(key, tx);
    if (published) {
      if (published.key !== key || builtin?.sensitiveVars?.some((name) => !published.vars.includes(name))) {
        throw validation("INVALID_MAIL_RENDER", "The message template could not be rendered safely.");
      }
      const invoice = INVOICE_NOTICE_TEMPLATES.has(key);
      const addOrderContext = invoice || key === PAYMENT_RECEIPT_TEMPLATE;
      return {
        ...published,
        ...(addOrderContext ? { vars: [...new Set([...(builtin?.vars ?? []), ...published.vars])] } : {}),
        sensitiveVars: [...new Set([...(builtin?.sensitiveVars ?? []), ...(published.sensitiveVars ?? [])])],
        render: (vars) => {
          if (!addOrderContext) return published.render(vars);
          // Published contracts accept only their declared inputs. The system supplies any missing
          // order context even when a customized body predates these variables.
          const declared = Object.fromEntries(Object.entries(vars).filter(([name]) => published.vars.includes(name)));
          return prependOrderContext(published.render(declared), orderContextLines(vars), invoice);
        },
      };
    }
    if (!builtin) return null;
    const metadata = buildSystemTemplateMetadata(builtin);
    return { ...builtin, render: (vars) => renderShippedMail(builtin, metadata, vars, this.deps.config.canonicalOrigin) };
  }

  async enqueue(mail: OutboundMail, tx?: Tx): Promise<void> {
    if (mail.template === VERIFY_AUDIT) throw validation("INVALID_MAIL_INPUT", "The mail input is not valid.");
    await this.#enqueue(mail, tx);
  }

  async #enqueue(mail: OutboundMail, tx?: Tx): Promise<void> {
    const { deps } = this;
    const template = await this.#template(mail.template, tx);
    const parsed = payloadSchema.safeParse({ to: mail.to, vars: mail.vars, orderId: mail.orderId });
    if (!template || !parsed.success || !validKey(mail.idempotencyKey)
      || Object.keys(parsed.data.vars).some((name) => !template.vars.includes(name))) {
      throw validation("INVALID_MAIL_INPUT", "The mail input is not valid.");
    }
    // Validate output before accepting the message, then validate again on delivery.
    this.#content(template, parsed.data.vars);
    const now = deps.clock.now();
    const ttl = template.key !== PAYMENT_RECEIPT_TEMPLATE && template.sensitiveVars?.length ? VERIFY_TTL : ONE_DAY;
    const requestedExpiry = mail.expiresAt?.getTime() ?? now.getTime() + ttl;
    if (!Number.isFinite(requestedExpiry) || requestedExpiry <= now.getTime()) {
      throw validation("INVALID_MAIL_EXPIRY", "The mail expiry is not valid.");
    }
    const expiresAt = new Date(Math.min(now.getTime() + MAX_TTL, requestedExpiry));
    const body = { ...parsed.data, sensitiveVars: template.sensitiveVars };
    const serializedBody = JSON.stringify(body);
    if (Buffer.byteLength(serializedBody) > 96 * 1024) throw validation("INVALID_MAIL_INPUT", "The mail input is not valid.");
    const attachments = encodeMailAttachments(mail);
    const run = async (inner: Tx) => {
      const recipientAccountId = "address" in body.to
        ? await this.#trashGuard?.bindLiteralRecipient(inner, body.to.address) : body.to.userId;
      if (await this.#trashGuard?.isSuppressed({ ...body, recipientAccountId, template: template.key }, inner)) return;
      const serialized = JSON.stringify({ ...body, recipientAccountId, attachments, trashScoped: this.#trashGuard ? true : undefined });
      const publicId = ulid(now.getTime());
      const correlationId = currentCorrelation(publicId);
      const idempotencyHash = keyHash(mail.idempotencyKey);
      await inner.insert(mailOutbox).values({
        publicId, idempotencyHash, correlationId, template: template.key,
        payloadEnc: deps.crypto.encrypt(serialized, `mail_outbox.payload_enc:${publicId}`),
        orderId: body.orderId, recipientAccountId,
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

  async resend(tx: Tx, publicId: string, options: { expectedGeneration?: number; duplicateRiskAcceptedBy?: SessionPrincipal } = {}):
    Promise<{ jobId: string }> {
    const { deps } = this;
    const [row] = await tx.select().from(mailOutbox).where(eq(mailOutbox.publicId, publicId)).limit(1).for("update");
    if (!row) throw notFound();
    const now = deps.clock.now();
    if (
      !["held", "failed", "unknown"].includes(row.state) || row.payloadEnc === null
      || row.expiresAt <= now || row.generation >= 20
    ) throw conflict("MAIL_RESEND_UNSAFE", "This message cannot be safely resent.");
    if (options.expectedGeneration !== undefined && row.generation !== options.expectedGeneration) {
      throw conflict("MAIL_RESEND_CHANGED", "This message changed. Review its latest attempt before resending.");
    }
    const actor = options.duplicateRiskAcceptedBy;
    if (row.state === "unknown" && !actor) {
      throw conflict("MAIL_DUPLICATE_RISK_NOT_ACKNOWLEDGED", "Acknowledge that the recipient may receive this message twice.");
    }
    if (actor && (row.state !== "unknown" || !row.jobPublicId)) {
      throw conflict("MAIL_RESEND_CHANGED", "This message changed. Review its latest attempt before resending.");
    }
    const generation = row.generation + 1;
    const jobPublicId = await this.#queue(tx, row, generation);
    await tx.update(mailOutbox).set({ generation, jobPublicId, state: "queued", reasonCode: null, updatedAt: now })
      .where(eq(mailOutbox.id, row.id));
    if (actor) {
      await tx.insert(mailManualResends).values({ mailId: row.id, generation, queuedAt: now });
      await deps.audit.record({
        category: "job", eventName: "job.mail.resent_after_unknown", action: "transition", outcome: "completed",
        reasonCode: "MAIL_DUPLICATE_RISK_ACKNOWLEDGED", actor: { userId: actor.userId, role: actor.role },
        resource: { type: "mail", publicId: row.publicId }, correlationId: row.correlationId, jobId: row.jobPublicId!,
        attributes: { resent_job_public_id: jobPublicId, generation },
      }, tx);
    } else {
      await mailAudit(deps, tx, { ...row, jobPublicId }, "job.mail.resend.queued", "completed");
    }
    return { jobId: jobPublicId };
  }

  async viewCapture(tx: Tx, publicId: string): Promise<RenderedMail> {
    if (!await this.captureEnabled()) throw notFound();
    const [row] = await tx.select().from(mailOutbox).where(eq(mailOutbox.publicId, publicId)).limit(1).for("share");
    if (!row || row.state !== "captured" || row.captureEnc === null || row.expiresAt <= this.deps.clock.now()) throw notFound();
    if (this.#trashGuard && await hasHiddenMailBinding(tx, row)) throw notFound();
    const { trashScoped, ...value } = storedCaptureSchema.parse(
      JSON.parse(this.deps.crypto.decrypt(row.captureEnc, `mail_outbox.capture_enc:${row.publicId}`)),
    );
    await this.#checkHistoricalCopy(tx, row, trashScoped);
    await mailAudit(this.deps, tx, row, "job.mail.capture.viewed", "completed", undefined, false, "read");
    return value;
  }

  async viewContent(tx: Tx, publicId: string): Promise<MessageContent> {
    if (!await this.retentionDays(tx)) throw notFound();
    const [row] = await tx.select().from(mailOutbox).where(eq(mailOutbox.publicId, publicId)).limit(1).for("share");
    if (!row?.contentEnc || !row.contentExpiresAt || row.contentExpiresAt <= this.deps.clock.now()) throw notFound();
    if (this.#trashGuard && await hasHiddenMailBinding(tx, row)) throw notFound();
    const { trashScoped, ...value } = storedContentSchema.parse(
      JSON.parse(this.deps.crypto.decrypt(row.contentEnc, `mail_outbox.content_enc:${row.publicId}`)),
    );
    await this.#checkHistoricalCopy(tx, row, trashScoped);
    await mailAudit(this.deps, tx, row, "mail.content.viewed", "completed", undefined, false, "read");
    return value;
  }

  #addressHash(to: string): string {
    return this.deps.crypto.blindIndex(to, "mail.audit_copy.address");
  }

  async auditCopyStatus(): Promise<{ verified: boolean }> {
    const { deps } = this;
    const { address: to } = await readSetting(deps.settings, MAIL_AUDIT_COPY);
    if (!to) return { verified: false };
    const [row] = await deps.db.select({ verifiedAt: mailAuditVerification.verifiedAt }).from(mailAuditVerification)
      .where(and(eq(mailAuditVerification.id, 1), eq(mailAuditVerification.addressHash, this.#addressHash(to)))).limit(1);
    return { verified: !!row?.verifiedAt };
  }

  async requestAuditCopyVerification(tx: Tx): Promise<{ queued: true }> {
    const { deps } = this;
    const { address: to } = await readSetting(deps.settings, MAIL_AUDIT_COPY, tx);
    if (!to) throw validation("MAIL_AUDIT_ADDRESS_REQUIRED", "Configure an audit mailbox address first.");
    const code = randomBytes(16).toString("base64url");
    const now = deps.clock.now();
    const expiresAt = new Date(now.getTime() + VERIFY_TTL);
    const proof = { addressHash: this.#addressHash(to), codeHash: deps.crypto.hashToken(code), expiresAt, verifiedAt: null };
    await tx.insert(mailAuditVerification).values({ id: 1, ...proof }).onDuplicateKeyUpdate({ set: proof });
    await this.#enqueue({
      template: VERIFY_AUDIT, to: { address: to }, vars: { code }, idempotencyKey: `audit-copy:${ulid(now.getTime())}`, expiresAt,
    }, tx);
    await deps.audit.record({
      category: "job", eventName: "mail.audit_copy.verification.requested", action: "create", outcome: "completed",
      resource: { type: "mail_audit_copy" },
    }, tx);
    return { queued: true };
  }

  async confirmAuditCopyVerification(tx: Tx, code: string): Promise<{ verified: boolean }> {
    const { deps } = this;
    const { address: to } = await readSetting(deps.settings, MAIL_AUDIT_COPY, tx);
    const [row] = await tx.select().from(mailAuditVerification).where(eq(mailAuditVerification.id, 1)).limit(1).for("update");
    const now = deps.clock.now();
    const candidate = Buffer.from(deps.crypto.hashToken(code), "hex");
    const verified = !!(to && row?.codeHash && row.expiresAt && row.expiresAt > now && row.addressHash === this.#addressHash(to)
      && timingSafeEqual(Buffer.from(row.codeHash, "hex"), candidate));
    if (verified) {
      await tx.update(mailAuditVerification).set({ codeHash: null, expiresAt: null, verifiedAt: now })
        .where(eq(mailAuditVerification.id, 1));
    }
    await deps.audit.record({
      category: "job", eventName: "mail.audit_copy.verification.confirmed", action: "verify",
      outcome: verified ? "completed" : "denied", reasonCode: verified ? undefined : "MAIL_AUDIT_CODE_INVALID",
      resource: { type: "mail_audit_copy" },
    }, tx);
    return { verified };
  }

  async #queue(tx: Tx, row: MailRow, generation: number): Promise<string> {
    const { jobId } = await this.deps.jobs.enqueue(DELIVER, { mailId: row.publicId, generation }, {
      idempotencyKey: `${row.publicId}:${generation}`, correlationId: row.correlationId, maxAttempts: 1,
    }, tx);
    return jobId;
  }

  #content(template: PublishedMailTemplate, vars: OutboundMail["vars"]): Omit<MessageContent, "to"> {
    try {
      const rendered = template.render(vars);
      const { subject } = rendered;
      const { text } = rendered;
      const html = rendered.html ?? inertPlainTextToDeliveryHtml(text);
      if (typeof subject === "string" && subject.length >= 1 && subject.length <= 255 && !HEADER_CONTROL.test(subject)
        && typeof text === "string" && text.length >= 1 && text.length <= 65_536 && !text.includes("\0")
        && typeof html === "string" && html.length <= 512 * 1024 && !html.includes("\0")) {
        return { subject, text, html };
      }
    } catch { /* never echo variables or raw renderer errors */ }
    throw validation("INVALID_MAIL_RENDER", "The message template could not be rendered safely.");
  }

  #customerReceiptLink(data: MessageContent, attached: boolean): MessageContent {
    const url = new URL("/invoices?tab=receipts", this.deps.config.canonicalOrigin).href;
    const detail = attached ? "The PDF is attached. You can also download it in the portal."
      : "The PDF is not attached. Download it securely in the portal.";
    const htmlFooter = `<p>${detail} <a href="${escapeHtml(url)}" data-rp-button="primary" rel="noopener noreferrer">Open Receipts in ReadyPackets</a>.</p>`;
    return {
      ...data,
      text: `${data.text}\n\n${detail}\nOpen Receipts in ReadyPackets:\n${url}`,
      html: /<\/body>\s*<\/html>\s*$/i.test(data.html)
        ? data.html.replace(/(<\/body>\s*<\/html>\s*)$/i, (_match, closing: string) => `${htmlFooter}${closing}`)
        : `${data.html}${htmlFooter}`,
    };
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
    let data: DeliverableContent;
    let redacted: MessageContent | undefined;
    let retainDays = 0;
    let redactionFailed = false;
    let sender: MailSenderIdentity | null = null;
    let routing: { primary: MailTransportKey; secondary: "none" | MailTransportKey } = { primary: "smtp", secondary: "none" };
    let scope: MailTrashScope;
    try {
      mode = await this.captureEnabled();
      if (mode && row.template === VERIFY_AUDIT) return this.#preSendFailure(job, ids, "MAIL_VERIFICATION_CAPTURE_BLOCKED", true);
      const template = await this.#template(row.template);
      if (!row.payloadEnc || !template) throw new Error("MAIL_PAYLOAD_UNAVAILABLE");
      const payload = this.#readPayload(row);
      scope = this.#scope(row, payload);
      if (this.#trashGuard && (this.#legacyTooOld(scope, deps.clock.now()) || await this.#trashGuard.isSuppressed(scope))) {
        return this.#preSendFailure(job, ids, "MAIL_SCOPE_UNAVAILABLE", true);
      }
      if (Object.keys(payload.vars).some((name) => !template.vars.includes(name))) throw new Error("MAIL_TEMPLATE_VARS_CHANGED");
      const recipient = "userId" in payload.to
        ? await delivery.findRecipient(payload.to.userId)
        : { email: payload.to.address, status: "active", emailVerified: false };
      const isReceipt = row.template === PAYMENT_RECEIPT_TEMPLATE;
      if (!recipient || (isReceipt
        ? recipient.status !== "active" || recipient.emailVerified !== true
        : !["active", "pending_activation"].includes(recipient.status))) {
        return this.#preSendFailure(job, ids, "MAIL_RECIPIENT_UNAVAILABLE", true);
      }
      const renderVars = withRecipientGreeting(template, payload.vars, recipient);
      data = { ...this.#content(template, renderVars), to: address.parse(recipient.email) };
      const attachments = decodeMailAttachments(row.template, payload.vars, payload.to, payload.attachments);
      if (!mode && isReceipt) data = this.#customerReceiptLink(data, Boolean(attachments));
      if (!mode && attachments) data.attachments = attachments;
      if (!mode) {
        [sender, routing, retainDays] = await Promise.all([
          this.getMailSenderIdentity(), readSetting(deps.settings, MAIL_ROUTING), this.retentionDays(),
        ]);
        if (row.template !== VERIFY_AUDIT) {
          try {
            const masked = { ...payload.vars };
            for (const key of new Set([...(template.sensitiveVars ?? []), ...(payload.sensitiveVars ?? [])])) masked[key] = REDACTED;
            if (renderVars !== payload.vars) {
              masked[AUTH_GREETING_TEMPLATES.has(template.key) ? "name" : "recipient_name"] = REDACTED;
            }
            if (isReceipt) {
              for (const [key] of ORDER_CONTEXT_FIELDS) {
                if (Object.hasOwn(masked, key)) masked[key] = REDACTED;
              }
            } else if (INVOICE_NOTICE_TEMPLATES.has(row.template) && Object.hasOwn(masked, "projectName")) {
              masked.projectName = REDACTED;
            }
            redacted = { ...this.#content(template, masked), to: data.to };
          } catch { redactionFailed = true; }
        }
      }
    } catch (error) {
      return this.#preSendFailure(job, ids,
        error instanceof DomainError && error.reasonCode === "MAIL_CAPTURE_FORBIDDEN"
          ? "MAIL_CAPTURE_FORBIDDEN" : "MAIL_PREPARATION_FAILED", false);
    }

    const started = await deps.db.transaction(async (tx) => {
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
      const trashScoped = this.#trashGuard && !scope.legacyCreatedAt ? true : undefined;
      if (mode) {
        if (await this.#trashGuard?.isSuppressed(scope, tx)) {
          await tx.update(mailOutbox).set({ state: "failed", reasonCode: "MAIL_SCOPE_UNAVAILABLE",
            payloadEnc: null, captureEnc: null, contentEnc: null, contentExpiresAt: null, updatedAt: now,
          }).where(eq(mailOutbox.id, current.id));
          await mailAudit(deps, tx, current, "job.mail.failed", "failed", "MAIL_SCOPE_UNAVAILABLE", true);
          return false;
        }
        const { to, subject, text } = row.template === PAYMENT_RECEIPT_TEMPLATE
          ? { to: data.to, subject: "Your ReadyPackets payment receipt", text: "Receipt attachment omitted from development capture." }
          : data;
        await tx.insert(mailAttempts).values({
          mailId: current.id, generation: current.generation, state: "captured", startedAt: now, finishedAt: now,
        });
        await tx.update(mailOutbox).set({
          state: "captured", payloadEnc: null,
          captureEnc: deps.crypto.encrypt(JSON.stringify({ to, subject, text, trashScoped }), `mail_outbox.capture_enc:${current.publicId}`),
          expiresAt: new Date(Math.min(current.expiresAt.getTime(), now.getTime() + CAPTURE_TTL)), updatedAt: now,
        }).where(eq(mailOutbox.id, current.id));
        await mailAudit(deps, tx, current, "job.mail.captured", "completed", "MAIL_CAPTURE_ONLY", true);
        return false;
      }
      await tx.update(mailOutbox).set({
        state: "sending", updatedAt: now,
        ...(redacted && retainDays > 0 ? {
          contentEnc: deps.crypto.encrypt(JSON.stringify({ ...redacted, trashScoped }), `mail_outbox.content_enc:${current.publicId}`),
          contentExpiresAt: new Date(now.getTime() + retainDays * ONE_DAY),
        } : {}),
      }).where(eq(mailOutbox.id, current.id));
      await this.#startAttempt(tx, current, routing.primary, "primary");
      if (redactionFailed) await mailAudit(deps, tx, current, "job.mail.redaction.failed", "failed", "MAIL_REDACTION_FAILED", true);
      await mailAudit(deps, tx, current, "job.mail.sending", "attempted", undefined, true);
      return true;
    });
    if (!started) return { outcome: "completed" };

    let key = routing.primary;
    let purpose: AttemptPurpose = "primary";
    let result = await this.#send(job, key, sender, data, row.expiresAt, scope);
    if (routing.secondary !== "none" && (result.outcome === "not_configured" || (result.outcome === "rejected" && result.retryable === true))) {
      const secondary = routing.secondary;
      const next = await deps.db.transaction(async (tx) => {
        const current = await this.#lockedMail(tx, job, ids, "sending");
        if (!current) throw new Error("MAIL_FENCE_INCONSISTENT");
        if (current.expiresAt <= deps.clock.now()) return false;
        await this.#finishAttempt(tx, current, key, purpose, result);
        await this.#startAttempt(tx, current, secondary, "secondary");
        await mailAudit(deps, tx, current, "job.mail.failover.started", "attempted", undefined, true);
        return true;
      });
      if (next) {
        key = secondary;
        purpose = "secondary";
        result = await this.#send(job, key, sender, data, row.expiresAt, scope);
      }
    }
    const { outcome, reasonCode } = await deps.db.transaction(async (tx) => {
      const current = await this.#lockedMail(tx, job, ids, "sending");
      if (!current) throw new Error("MAIL_FENCE_INCONSISTENT");
      const status = await this.#finishAttempt(tx, current, key, purpose, result);
      const now = deps.clock.now();
      const expired = (status.outcome === "held" || status.outcome === "failed") && current.expiresAt <= now;
      const outcome = expired ? "expired" : status.outcome;
      const reasonCode = expired ? "MAIL_EXPIRED" : status.reasonCode;
      await tx.update(mailOutbox).set({
        state: outcome, reasonCode, updatedAt: now,
        ...(result.outcome === "suppressed" ? { captureEnc: null, contentEnc: null, contentExpiresAt: null } : {}),
        ...(outcome === "accepted" || current.expiresAt <= now
          || (outcome === "failed" && !result.retryable) ? { payloadEnc: null } : {}),
      }).where(eq(mailOutbox.id, current.id));
      await mailAudit(deps, tx, current, `job.mail.${outcome}`,
        outcome === "accepted" ? "completed" : outcome === "held" ? "refused" : outcome === "expired" ? "canceled" : outcome, reasonCode, true);
      return { outcome, reasonCode };
    });
    if (outcome === "accepted" && redacted) await this.#auditCopy(job, ids, key, sender, redacted, scope);
    if (result.outcome === "suppressed") return { outcome: "canceled", reasonCode };
    if (outcome === "unknown") return { outcome: "unknown", reasonCode };
    if (outcome === "failed") return { outcome: "failed", reasonCode, retryable: false };
    if (outcome === "expired") return { outcome: "canceled", reasonCode };
    return { outcome: "completed" };
  }

  async #send(job: ClaimedJob, key: MailTransportKey, sender: MailSenderIdentity | null, data: DeliverableContent,
    expiresAt?: Date, scope?: MailTrashScope): Promise<MailDeliveryResult> {
    const adapter = this.#transports.get(key);
    if (!adapter || !sender) return { outcome: "not_configured" };
    try {
      if (!await adapter.isConfigured()) return { outcome: "not_configured" };
    } catch { return { outcome: "rejected", retryable: false }; }
    await job.assertStillOwned();
    job.signal.throwIfAborted();
    if (expiresAt && expiresAt <= this.deps.clock.now()) return { outcome: "expired" };
    try {
      if (scope && this.#trashGuard && (this.#legacyTooOld(scope, this.deps.clock.now())
        || await this.#trashGuard.isSuppressed(scope))) return { outcome: "suppressed" };
    } catch {
      return { outcome: "suppressed" }; // A failed gate cannot authorize an external effect.
    }
    job.signal.throwIfAborted();
    try {
      const result = await adapter.send({ ...data, sender, signal: job.signal });
      if (["accepted", "not_configured", "rejected", "unknown"].includes(result.outcome)) return result;
    } catch { /* Submission may have reached the provider. */ }
    return { outcome: "unknown" };
  }

  async #startAttempt(tx: Tx, mail: MailRow, transport: MailTransportKey, purpose: AttemptPurpose): Promise<void> {
    await tx.insert(mailTransportAttempts).values({
      mailId: mail.id, generation: mail.generation, transport, purpose, state: "sending", startedAt: this.deps.clock.now(),
    });
  }

  async #finishAttempt(tx: Tx, mail: MailRow, key: MailTransportKey, purpose: AttemptPurpose, result: MailDeliveryResult):
    Promise<{ outcome: Exclude<MailAttemptOutcome, "captured">; reasonCode: string }> {
    const outcome = result.outcome === "accepted" ? "accepted"
      : result.outcome === "not_configured" ? "held" : result.outcome === "unknown" ? "unknown" : "failed";
    const reasonCode = outcome === "accepted" ? key === "smtp" ? "MAIL_SMTP_ACCEPTED" : "MAIL_GRAPH_ACCEPTED"
      : outcome === "held" ? "MAIL_NOT_CONFIGURED"
        : outcome === "unknown" ? "MAIL_PROVIDER_OUTCOME_UNKNOWN" : result.outcome === "expired" ? "MAIL_EXPIRED"
          : result.outcome === "suppressed" ? "MAIL_SCOPE_UNAVAILABLE" : "MAIL_PROVIDER_REJECTED";
    await tx.update(mailTransportAttempts).set({ state: outcome, reasonCode, finishedAt: this.deps.clock.now() }).where(and(
      eq(mailTransportAttempts.mailId, mail.id), eq(mailTransportAttempts.generation, mail.generation),
      eq(mailTransportAttempts.purpose, purpose), eq(mailTransportAttempts.state, "sending"),
    ));
    return { outcome, reasonCode };
  }

  async #auditCopy(job: ClaimedJob, ids: DeliveryJob, key: MailTransportKey, sender: MailSenderIdentity | null,
    redacted: MessageContent, scope: MailTrashScope) {
    const { deps } = this;
    const to = await deps.db.transaction(async (tx) => {
      const current = await this.#lockedMail(tx, job, ids, "accepted");
      if (!current) throw new Error("MAIL_FENCE_INCONSISTENT");
      const setting = await readSetting(deps.settings, MAIL_AUDIT_COPY, tx);
      if (!setting.enabled || setting.address.toLowerCase() === redacted.to.toLowerCase()) return null;
      const [proof] = await tx.select({ verifiedAt: mailAuditVerification.verifiedAt }).from(mailAuditVerification)
        .where(and(eq(mailAuditVerification.id, 1), eq(mailAuditVerification.addressHash, this.#addressHash(setting.address))))
        .limit(1).for("share");
      if (!proof?.verifiedAt) return null;
      await this.#startAttempt(tx, current, key, "audit_copy");
      await mailAudit(deps, tx, current, "job.mail.audit_copy.sending", "attempted", undefined, true);
      return setting.address;
    });
    if (!to) return;
    const result = await this.#send(job, key, sender, { ...redacted, to }, undefined, scope);
    await deps.db.transaction(async (tx) => {
      const current = await this.#lockedMail(tx, job, ids, "accepted");
      if (!current) throw new Error("MAIL_FENCE_INCONSISTENT");
      const { outcome, reasonCode } = await this.#finishAttempt(tx, current, key, "audit_copy", result);
      await mailAudit(deps, tx, current, `job.mail.audit_copy.${outcome}`,
        outcome === "accepted" ? "completed" : outcome === "held" ? "refused" : outcome, reasonCode, true);
    });
  }

  async #lockedMail(tx: Tx, job: ClaimedJob, ids: DeliveryJob, expected: "queued" | "sending" | "accepted") {
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
      await tx.update(mailOutbox).set({ state: "failed", reasonCode, updatedAt: now, ...(purge ? { payloadEnc: null } : {}),
        ...(reasonCode === "MAIL_SCOPE_UNAVAILABLE" ? { captureEnc: null, contentEnc: null, contentExpiresAt: null } : {}) })
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
          inArray(mailOutbox.state, ["queued", "held", "failed", "captured", "unknown"]),
          or(isNotNull(mailOutbox.payloadEnc), isNotNull(mailOutbox.captureEnc)),
        )).orderBy(asc(mailOutbox.expiresAt), asc(mailOutbox.id)).limit(50).for("update", { skipLocked: true });
        for (const row of rows) {
          const state = row.state === "captured" || row.state === "unknown" ? row.state : "expired";
          await tx.update(mailOutbox).set({ state, payloadEnc: null, captureEnc: null, updatedAt: now,
            reasonCode: state === "expired" ? "MAIL_EXPIRED" : row.reasonCode }).where(eq(mailOutbox.id, row.id));
          await mailAudit(deps, tx, row, state === "expired" ? "job.mail.expired"
            : state === "unknown" ? "job.mail.payload.purged" : "job.mail.capture.purged",
            state === "expired" ? "canceled" : "completed", "MAIL_EXPIRED", true);
        }
        return rows.length;
      }, { isolationLevel: "read committed" });
      purged += changed;
      if (changed < 50) break;
    }
    let contentPurged = 0;
    for (let batch = 0; batch < 8; batch += 1) {
      const changed = await deps.db.transaction(async (tx) => {
        await job.assertStillOwned(tx);
        const enabled = await this.retentionDays(tx);
        const now = deps.clock.now();
        const rows = await tx.select({ id: mailOutbox.id }).from(mailOutbox).where(and(
          isNotNull(mailOutbox.contentExpiresAt), enabled ? lte(mailOutbox.contentExpiresAt, now) : undefined,
        )).orderBy(asc(mailOutbox.contentExpiresAt), asc(mailOutbox.id)).limit(50).for("update", { skipLocked: true });
        if (rows.length) await tx.update(mailOutbox).set({ contentEnc: null, contentExpiresAt: null })
          .where(inArray(mailOutbox.id, rows.map(({ id }) => id)));
        return rows.length;
      }, { isolationLevel: "read committed" });
      contentPurged += changed;
      if (changed < 50) break;
    }
    const bindingsRepaired = await this.#backfillLegacyBindings(job);
    const historicalCopiesPurged = await this.#purgeHistoricalCopies(job);
    return { outcome: "completed", safeCounts: {
      purged, content_purged: contentPurged + historicalCopiesPurged, ...(bindingsRepaired ? { bindings_repaired: bindingsRepaired } : {}),
    } };
  }

  async #purgeHistoricalCopies(job: ClaimedJob): Promise<number> {
    if (!this.#trashGuard) return 0;
    const { deps } = this;
    const { next, purged } = await deps.db.transaction(async (tx) => {
      await job.assertStillOwned(tx);
      const latest = await latestMailRelevantPurge(tx);
      if (!latest) return { next: 0, purged: 0 };
      const rows = await tx.select().from(mailOutbox).where(and(
        gt(mailOutbox.id, this.#historicalCopiesAfter), lte(mailOutbox.createdAt, latest), isNull(mailOutbox.payloadEnc),
        inArray(mailOutbox.state, ["accepted", "captured", "failed", "expired", "unknown", "canceled"]),
        or(isNull(mailOutbox.orderId), isNull(mailOutbox.recipientAccountId)),
        or(isNotNull(mailOutbox.captureEnc), isNotNull(mailOutbox.contentEnc)),
      )).orderBy(asc(mailOutbox.id)).limit(25).for("update", { skipLocked: true });
      let purged = 0;
      function currentCopy(encrypted: string | null, kind: "capture" | "content", publicId: string) {
        if (encrypted === null) return false;
        try {
          const json: unknown = JSON.parse(deps.crypto.decrypt(encrypted, `mail_outbox.${kind}_enc:${publicId}`));
          return (kind === "capture" ? storedCaptureSchema : storedContentSchema).safeParse(json).data?.trashScoped === true;
        } catch {
          return false; // No readable data can prove this is a modern, scoped copy.
        }
      }
      for (const row of rows) {
        const eraseCapture = row.captureEnc !== null && !currentCopy(row.captureEnc, "capture", row.publicId);
        const eraseContent = row.contentEnc !== null && !currentCopy(row.contentEnc, "content", row.publicId);
        if (!eraseCapture && !eraseContent) continue;
        await tx.update(mailOutbox).set({
          ...(eraseCapture ? { captureEnc: null } : {}),
          ...(eraseContent ? { contentEnc: null, contentExpiresAt: null } : {}),
        }).where(eq(mailOutbox.id, row.id));
        await mailAudit(deps, tx, row, "job.mail.payload.purged", "completed", "MAIL_SCOPE_UNAVAILABLE", true);
        purged += 1;
      }
      return { next: rows.length === 25 ? rows[24]!.id : 0, purged };
    }, { isolationLevel: "read committed" });
    this.#historicalCopiesAfter = next;
    return purged;
  }

  async #backfillLegacyBindings(job: ClaimedJob): Promise<number> {
    const guard = this.#trashGuard;
    if (!guard) return 0;
    const { deps } = this;
    const { next, repaired } = await deps.db.transaction(async (tx) => {
      await job.assertStillOwned(tx);
      const now = deps.clock.now();
      const rows = await tx.select().from(mailOutbox).where(and(
        gt(mailOutbox.id, this.#backfillAfter), gt(mailOutbox.expiresAt, now),
        inArray(mailOutbox.state, ["queued", "held", "failed", "unknown"]), isNotNull(mailOutbox.payloadEnc),
        or(isNull(mailOutbox.orderId), isNull(mailOutbox.recipientAccountId)),
      )).orderBy(asc(mailOutbox.id)).limit(25).for("update", { skipLocked: true });
      let repaired = 0;
      for (const row of rows) {
        let scope: MailTrashScope;
        try {
          scope = this.#scope(row, this.#readPayload(row));
        } catch {
          continue; // The dispatch parser refuses unreadable payloads; expiry still scrubs them.
        }
        if (!scope.legacyCreatedAt) continue;
        const binding = await guard.recoverLegacyBinding(scope, tx);
        if (binding.suppressed || this.#legacyTooOld(scope, now) || await guard.isSuppressed({ ...scope, ...binding }, tx)) {
          // Keep transport/queue evidence, and preserve an ambiguous prior provider outcome.
          await tx.update(mailOutbox).set({
            state: row.state === "unknown" ? row.state : "failed",
            reasonCode: row.state === "unknown" ? row.reasonCode : "MAIL_SCOPE_UNAVAILABLE",
            payloadEnc: null, captureEnc: null, contentEnc: null, contentExpiresAt: null, updatedAt: now,
            orderId: binding.orderId, recipientAccountId: binding.recipientAccountId,
          }).where(eq(mailOutbox.id, row.id));
          await mailAudit(deps, tx, row, "job.mail.payload.purged", "completed", "MAIL_SCOPE_UNAVAILABLE", true);
          repaired += 1;
        } else if ((row.orderId === null && binding.orderId !== undefined)
          || (row.recipientAccountId === null && binding.recipientAccountId !== undefined)) {
          await tx.update(mailOutbox).set({ orderId: binding.orderId, recipientAccountId: binding.recipientAccountId })
            .where(eq(mailOutbox.id, row.id));
          repaired += 1;
        }
      }
      return { next: rows.length === 25 ? rows[24]!.id : 0, repaired };
    }, { isolationLevel: "read committed" });
    this.#backfillAfter = next;
    return repaired;
  }
}
