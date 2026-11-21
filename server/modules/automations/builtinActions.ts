/**
 * Built-in automation actions + starter recipes + `J-A01` staff-only trigger policy.
 *
 * Security invariants:
 *  1. No action can change order status or user/role permissions (`assertAllowedActionKey`).
 *  2. Staff-only triggers (`staffOnly: true`, e.g. `message.internal_note`) use an explicit default-deny
 *     allowlist (`STAFF_ONLY_ALLOWED_ACTION_KEYS = new Set(["notification.send_in_app"])`): outbound e-mail,
 *     webhooks, external storage/SharePoint copies, and support tickets are forbidden at save AND run time,
 *     customer recipient keys are forbidden, and persisted in-app notifications carry `staffOnly: true` +
 *     `skipEmail: true` so even a later staff→customer demotion hides the row (`J-A01`).
 *  3. `webhook.call` is `retrySafe: false`: it uses `services.integrations.egress.fetchPinned` (`purpose: "webhook"`,
 *     `https:` only, `requireAllowlistRule: true`), signs `<timestamp>.<body>` with HMAC-SHA-256, claims step state
 *     `"dispatching"` inside `beforeSend` under `ctx.assertStillOwned(tx)` BEFORE opening the socket, and returns
 *     `outcome: "unknown"` if transport fails after `beforeSend` so a webhook is never dispatched twice.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { DomainError, validation } from "../../core/errors.js";
import type { Mailer } from "../../core/types.js";
import { users } from "../identity/schema.js";
import type { EgressFetchResponse } from "../integrations/egress.js";
import {
  getStaticAutomationRegistrations,
  registerAutomationAction,
  type AutomationActionRegistration,
  type AutomationActionRunContext,
  type AutomationActionRunResult,
  type AutomationStarterRecipe,
} from "./contracts.js";
import {
  extractAndValidateTemplateVars,
  renderPlainTemplate,
  signAutomationWebhook,
} from "./templates.js";

/** Default-deny allowlist of actions permitted when a trigger has `staffOnly: true` (`J-A01`). */
export const STAFF_ONLY_ALLOWED_ACTION_KEYS: ReadonlySet<string> = new Set([
  "notification.send_in_app",
]);

/** Trigger recipient keys that address customers and MUST NEVER be used on `staffOnly: true` triggers. */
export const CUSTOMER_RECIPIENT_KEYS: ReadonlySet<string> = new Set([
  "order_owner",
  "ticket_requester",
]);

export const GENERIC_AUTOMATION_MAIL_TEMPLATE = "automations.generic_notice";

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/u;
const TEMPLATE_KEY_RE = /^[a-z][a-z0-9_.-]{1,79}$/;
const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

const registeredMailers = new WeakSet<Mailer>();

/** Registers the logic-less fallback mail template once per `Mailer` instance. */
export function ensureAutomationMailTemplateRegistered(mailer: Mailer): void {
  if (registeredMailers.has(mailer)) return;
  try {
    mailer.registerTemplate({
      key: GENERIC_AUTOMATION_MAIL_TEMPLATE,
      vars: ["subject", "body", "recipient_name"],
      subject: (vars) => String(vars.subject ?? "Portal notification"),
      text: (vars) => {
        const greeting =
          typeof vars.recipient_name === "string" && vars.recipient_name.trim().length > 0
            ? `Hello ${vars.recipient_name.trim()},\n\n`
            : "";
        return `${greeting}${String(vars.body ?? "")}`;
      },
    });
  } catch {
    // Already registered on this mailer instance.
  }
  registeredMailers.add(mailer);
}

interface ResolvedUserRecipient {
  id: number;
  publicId: string;
  role: "admin" | "staff" | "customer";
  displayName: string;
}

async function resolveLiveUserRecipients(
  ctx: AutomationActionRunContext<unknown>,
  recipientKey: string,
): Promise<
  { ok: true; users: ResolvedUserRecipient[] } | { ok: false; result: AutomationActionRunResult }
> {
  if (ctx.staffOnlyTrigger && CUSTOMER_RECIPIENT_KEYS.has(recipientKey)) {
    return {
      ok: false,
      result: {
        outcome: "failed",
        retryable: false,
        reasonCode: "AUTOMATION_STAFF_ONLY_CUSTOMER_RECIPIENT_FORBIDDEN",
        safeSummary: "Staff-only triggers cannot address customer recipients.",
      },
    };
  }

  let candidateIds: number[];
  if (recipientKey === "administrators") {
    const rows = await ctx.deps.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.status, "active"), eq(users.role, "admin")))
      .orderBy(asc(users.id))
      .limit(50);
    candidateIds = rows.map((r) => r.id);
  } else if (recipientKey === "staff") {
    const rows = await ctx.deps.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.status, "active"), inArray(users.role, ["admin", "staff"])))
      .orderBy(asc(users.id))
      .limit(100);
    candidateIds = rows.map((r) => r.id);
  } else {
    candidateIds = [...new Set(ctx.recipients[recipientKey] ?? [])].filter(
      (id) => Number.isSafeInteger(id) && id > 0,
    );
  }

  if (candidateIds.length === 0) {
    return { ok: true, users: [] };
  }

  const rows = await ctx.deps.db
    .select({
      id: users.id,
      publicId: users.publicId,
      role: users.role,
      status: users.status,
      nameEnc: users.nameEnc,
    })
    .from(users)
    .where(and(inArray(users.id, candidateIds), eq(users.status, "active")))
    .orderBy(asc(users.id));

  const resolved: ResolvedUserRecipient[] = [];
  let blockedCustomerCount = 0;
  for (const row of rows) {
    if (ctx.staffOnlyTrigger && row.role === "customer") {
      blockedCustomerCount += 1;
      continue;
    }
    let displayName: string;
    try {
      displayName = ctx.deps.crypto.decrypt(row.nameEnc, `users.name:${row.publicId}`);
    } catch {
      displayName = "";
    }
    resolved.push({
      id: row.id,
      publicId: row.publicId,
      role: row.role,
      displayName,
    });
  }

  if (ctx.staffOnlyTrigger && blockedCustomerCount > 0 && resolved.length === 0) {
    return {
      ok: false,
      result: {
        outcome: "failed",
        retryable: false,
        reasonCode: "AUTOMATION_STAFF_ONLY_CUSTOMER_RECIPIENT_FORBIDDEN",
        safeSummary: "Staff-only triggers cannot send notifications to customer accounts.",
      },
    };
  }

  return { ok: true, users: resolved };
}

/* ----------------------------------------------------- 1. email.send_template */

export const emailSendTemplateConfigSchema = z
  .strictObject({
    recipientMode: z.enum(["trigger", "fixed"]).default("trigger"),
    recipientKey: z.string().trim().min(1).max(64).optional(),
    fixedAddress: z
      .string()
      .trim()
      .max(254)
      .refine((v) => EMAIL_RE.test(v), "Invalid e-mail address.")
      .optional(),
    templateKey: z
      .string()
      .trim()
      .regex(TEMPLATE_KEY_RE, "Invalid template key.")
      .default(GENERIC_AUTOMATION_MAIL_TEMPLATE),
    subject: z.string().trim().min(1).max(160),
    body: z.string().trim().min(1).max(4000),
  })
  .superRefine((val, zCtx) => {
    if (val.recipientMode === "fixed") {
      if (!val.fixedAddress) {
        zCtx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fixedAddress"],
          message: "Fixed e-mail address is required when recipientMode is fixed.",
        });
      }
    } else if (!val.recipientKey) {
      zCtx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recipientKey"],
        message: "Recipient key is required when recipientMode is trigger.",
      });
    }
  });

const emailSendTemplateAction: AutomationActionRegistration<
  z.infer<typeof emailSendTemplateConfigSchema>
> = {
  key: "email.send_template",
  label: "Send e-mail",
  description:
    "Queues a templated e-mail through the durable mail outbox using logic-less {{field}} placeholders.",
  category: "Messaging",
  owner: "automations",
  supportedTriggerModes: ["event", "manual", "schedule"],
  forbidOnStaffOnlyTrigger: true,
  retrySafe: true,
  configSchema: emailSendTemplateConfigSchema,
  configFields: [
    {
      key: "recipientMode",
      label: "Send to",
      type: "enum",
      required: true,
      enumOptions: [
        { value: "trigger", label: "A role or person from the trigger" },
        { value: "fixed", label: "A fixed operational e-mail address" },
      ],
    },
    {
      key: "recipientKey",
      label: "Recipient",
      type: "trigger_recipient",
      required: true,
    },
    {
      key: "fixedAddress",
      label: "Fixed e-mail address",
      type: "email",
      required: true,
      maxLength: 254,
      helpText: "Not allowed on staff-only triggers.",
    },
    {
      key: "templateKey",
      label: "Template key",
      type: "template_key",
      required: false,
      maxLength: 80,
      helpText: "Defaults to automations.generic_notice.",
    },
    {
      key: "subject",
      label: "Subject",
      type: "string",
      required: true,
      maxLength: 160,
    },
    {
      key: "body",
      label: "Message body",
      type: "textarea",
      required: true,
      maxLength: 4000,
    },
  ],
  async run(ctx) {
    ctx.signal.throwIfAborted();
    if (ctx.dryRun) {
      return { outcome: "completed", safeSummary: "Dry-run preview." };
    }
    ensureAutomationMailTemplateRegistered(ctx.deps.mailer);

    if (ctx.staffOnlyTrigger) {
      return {
        outcome: "failed",
        retryable: false,
        reasonCode: "AUTOMATION_STAFF_ONLY_TRIGGER_ACTION_FORBIDDEN",
        safeSummary: "Outbound e-mail actions are forbidden on staff-only triggers.",
      };
    }

    const config = ctx.config;
    if (config.recipientMode === "fixed") {
      const address = config.fixedAddress!.trim().toLowerCase();
      const subject = renderPlainTemplate(config.subject, ctx.fields, { singleLine: true });
      const body = renderPlainTemplate(config.body, ctx.fields);
      await ctx.deps.mailer.enqueue({
        template: GENERIC_AUTOMATION_MAIL_TEMPLATE,
        to: { address },
        vars: { subject, body, recipient_name: "" },
        idempotencyKey: `${ctx.idempotencyKey}:fixed`,
      });
      return {
        outcome: "completed",
        safeSummary: "Queued 1 e-mail.",
        safeCounts: { queued_count: 1 },
      };
    }

    const resolved = await resolveLiveUserRecipients(ctx, config.recipientKey!);
    if (!resolved.ok) return resolved.result;
    if (resolved.users.length === 0) {
      return {
        outcome: "skipped",
        reasonCode: "NO_ACTIVE_RECIPIENTS",
        safeSummary: "No active recipients matched this step.",
      };
    }

    let queued = 0;
    for (const recipient of resolved.users) {
      ctx.signal.throwIfAborted();
      const perRecipientFields = {
        ...ctx.fields,
        recipient_name: recipient.displayName,
      };
      const subject = renderPlainTemplate(config.subject, perRecipientFields, { singleLine: true });
      const body = renderPlainTemplate(config.body, perRecipientFields);
      await ctx.deps.mailer.enqueue({
        template: GENERIC_AUTOMATION_MAIL_TEMPLATE,
        to: { userId: recipient.id },
        vars: {
          subject,
          body,
          recipient_name: recipient.displayName,
        },
        idempotencyKey: `${ctx.idempotencyKey}:u:${recipient.id}`,
      });
      queued += 1;
    }

    return {
      outcome: "completed",
      safeSummary: `Queued ${queued} e-mail(s).`,
      safeCounts: { queued_count: queued },
    };
  },
};

/* --------------------------------------------- 2. notification.send_in_app */

export const notificationSendInAppConfigSchema = z.strictObject({
  recipientKey: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(500),
});

const notificationSendInAppAction: AutomationActionRegistration<
  z.infer<typeof notificationSendInAppConfigSchema>
> = {
  key: "notification.send_in_app",
  label: "Send in-app notification",
  description: "Creates an in-app portal notification for the resolved user or role.",
  category: "Messaging",
  owner: "engagement",
  supportedTriggerModes: ["event", "manual", "schedule"],
  forbidOnStaffOnlyTrigger: false,
  retrySafe: true,
  configSchema: notificationSendInAppConfigSchema,
  configFields: [
    {
      key: "recipientKey",
      label: "Recipient",
      type: "trigger_recipient",
      required: true,
    },
    {
      key: "title",
      label: "Title",
      type: "string",
      required: true,
      maxLength: 160,
    },
    {
      key: "body",
      label: "Notification text",
      type: "textarea",
      required: true,
      maxLength: 500,
    },
  ],
  async run(ctx) {
    ctx.signal.throwIfAborted();
    if (ctx.dryRun) {
      return { outcome: "completed", safeSummary: "Dry-run preview." };
    }
    const config = ctx.config;
    const resolved = await resolveLiveUserRecipients(ctx, config.recipientKey);
    if (!resolved.ok) return resolved.result;
    if (resolved.users.length === 0) {
      return {
        outcome: "skipped",
        reasonCode: "NO_ACTIVE_RECIPIENTS",
        safeSummary: "No active recipients matched this step.",
      };
    }

    const engagement = ctx.deps.services.engagement;
    if (!engagement?.notify) {
      return {
        outcome: "failed",
        retryable: true,
        reasonCode: "ENGAGEMENT_UNAVAILABLE",
        safeSummary: "In-app notification service is temporarily unavailable.",
      };
    }

    let delivered = 0;
    for (const recipient of resolved.users) {
      ctx.signal.throwIfAborted();
      const perRecipientFields = {
        ...ctx.fields,
        recipient_name: recipient.displayName,
      };
      const title = renderPlainTemplate(config.title, perRecipientFields, { singleLine: true });
      const body = renderPlainTemplate(config.body, perRecipientFields);
      const linkPath = ctx.orderPublicId
        ? recipient.role === "customer" && !ctx.staffOnlyTrigger
          ? `/orders/${ctx.orderPublicId}`
          : `/admin/orders/${ctx.orderPublicId}`
        : null;
      await engagement.notify({
        userId: recipient.id,
        kind: ctx.orderPublicId ? "order.automation" : "system.automation",
        title: title || "Notification",
        body: body || title || "Notification",
        link: linkPath,
        idempotencyKey: `${ctx.idempotencyKey}:u:${recipient.id}`.slice(0, 128),
        skipEmail: true,
        staffOnly: ctx.staffOnlyTrigger,
      });
      delivered += 1;
    }

    return {
      outcome: "completed",
      safeSummary: `Delivered ${delivered} in-app notification(s).`,
      safeCounts: { notified_count: delivered },
    };
  },
};

/* ---------------------------------------------- 3. support.create_ticket */

export const supportCreateTicketConfigSchema = z.strictObject({
  recipientKey: z.string().trim().min(1).max(64).default("administrators"),
  category: z
    .enum(["general", "order", "billing", "technical", "deliverable", "account"])
    .default("general"),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  subject: z.string().trim().min(3).max(160),
  body: z.string().trim().min(1).max(4000),
});

const supportCreateTicketAction: AutomationActionRegistration<
  z.infer<typeof supportCreateTicketConfigSchema>
> = {
  key: "support.create_ticket",
  label: "Create support ticket",
  description:
    "Opens a portal support ticket idempotently. Events emitted by this ticket carry the automation origin marker and never trigger further automations.",
  category: "Support",
  owner: "engagement",
  supportedTriggerModes: ["event", "manual", "schedule"],
  forbidOnStaffOnlyTrigger: true,
  retrySafe: true,
  configSchema: supportCreateTicketConfigSchema,
  configFields: [
    {
      key: "recipientKey",
      label: "Ticket requester",
      type: "trigger_recipient",
      required: true,
      helpText: "Account on whose behalf the ticket is opened.",
    },
    {
      key: "category",
      label: "Category",
      type: "enum",
      required: true,
      enumOptions: [
        { value: "general", label: "General" },
        { value: "order", label: "Order" },
        { value: "billing", label: "Billing" },
        { value: "technical", label: "Technical" },
        { value: "deliverable", label: "Deliverable" },
        { value: "account", label: "Account" },
      ],
    },
    {
      key: "priority",
      label: "Priority",
      type: "enum",
      required: true,
      enumOptions: [
        { value: "low", label: "Low" },
        { value: "normal", label: "Normal" },
        { value: "high", label: "High" },
        { value: "urgent", label: "Urgent" },
      ],
    },
    {
      key: "subject",
      label: "Ticket subject",
      type: "string",
      required: true,
      maxLength: 160,
    },
    {
      key: "body",
      label: "Initial message",
      type: "textarea",
      required: true,
      maxLength: 4000,
    },
  ],
  async run(ctx) {
    ctx.signal.throwIfAborted();
    if (ctx.dryRun) {
      return { outcome: "completed", safeSummary: "Dry-run preview." };
    }
    if (ctx.staffOnlyTrigger) {
      return {
        outcome: "failed",
        retryable: false,
        reasonCode: "AUTOMATION_STAFF_ONLY_TRIGGER_ACTION_FORBIDDEN",
        safeSummary: "Support tickets cannot be opened from a staff-only trigger.",
      };
    }

    const config = ctx.config;
    const resolved = await resolveLiveUserRecipients(ctx, config.recipientKey);
    if (!resolved.ok) return resolved.result;
    const requester = resolved.users[0];
    if (!requester) {
      return {
        outcome: "skipped",
        reasonCode: "NO_ACTIVE_REQUESTER",
        safeSummary: "No active requester account matched this step.",
      };
    }

    const engagement = ctx.deps.services.engagement;
    if (!engagement?.createAutomationTicket) {
      return {
        outcome: "failed",
        retryable: true,
        reasonCode: "ENGAGEMENT_UNAVAILABLE",
        safeSummary: "Support ticket service is temporarily unavailable.",
      };
    }

    const perRecipientFields = {
      ...ctx.fields,
      recipient_name: requester.displayName,
    };
    const subject = renderPlainTemplate(config.subject, perRecipientFields, { singleLine: true });
    const body = renderPlainTemplate(config.body, perRecipientFields);
    const created = await engagement.createAutomationTicket({
      requesterUserId: requester.id,
      category: config.category,
      priority: config.priority,
      subject: subject.length >= 3 ? subject : "Automated support ticket",
      body: body || subject || "Automated support ticket",
      relatedOrderPublicId: ctx.orderPublicId,
      idempotencyKey: ctx.idempotencyKey.slice(0, 128),
    });

    return {
      outcome: "completed",
      safeSummary: `Ticket ${created.ticketNumber} ready.`,
      externalRef: created.ticketNumber,
      safeCounts: { created_new: created.created ? 1 : 0 },
    };
  },
};

/* ------------------------------------------------------ 4. webhook.call */

export const webhookCallConfigSchema = z.strictObject({
  url: z
    .string()
    .trim()
    .min(10)
    .max(2048)
    .refine((u) => {
      try {
        const parsed = new URL(u);
        return parsed.protocol === "https:" && !parsed.username && !parsed.password;
      } catch {
        return false;
      }
    }, "Webhook URL must use https:// without embedded credentials."),
  payloadFields: z
    .array(z.string().regex(FIELD_KEY_RE, "Invalid field key."))
    .max(25)
    .default([]),
});

export const webhookCallSecretsSchema = z.strictObject({
  signingSecret: z.string().min(16).max(256),
});

const webhookFenceHooks = new WeakMap<AutomationActionRunContext<unknown>, () => Promise<void>>();

export function attachWebhookBeforeSendFence(
  ctx: AutomationActionRunContext<unknown>,
  beforeSend: () => Promise<void>,
): void {
  webhookFenceHooks.set(ctx, beforeSend);
}

const webhookCallAction: AutomationActionRegistration<
  z.infer<typeof webhookCallConfigSchema>
> = {
  key: "webhook.call",
  label: "Call signed HTTPS webhook",
  description:
    "Sends an allowlisted JSON payload over HTTPS via the outbound egress policy with an HMAC-SHA-256 timestamp signature. Never retried automatically if outcome is unknown.",
  category: "Integrations",
  owner: "integrations",
  supportedTriggerModes: ["event", "manual", "schedule"],
  forbidOnStaffOnlyTrigger: true,
  retrySafe: false,
  configSchema: webhookCallConfigSchema,
  secretsSchema: webhookCallSecretsSchema,
  configFields: [
    {
      key: "url",
      label: "Destination HTTPS URL",
      type: "https_url",
      required: true,
      maxLength: 2048,
      helpText: "Must match an active webhook rule in Integrations → Outbound allow-list.",
    },
    {
      key: "signingSecret",
      label: "HMAC signing secret",
      type: "secret",
      required: true,
      secret: true,
      maxLength: 256,
      helpText: "At least 16 characters. Stored encrypted; never shown again.",
    },
    {
      key: "payloadFields",
      label: "Fields to include",
      type: "trigger_fields",
      required: false,
      helpText: "Only selected non-personal fields are included in the JSON body.",
    },
  ],
  async run(ctx) {
    ctx.signal.throwIfAborted();
    if (ctx.dryRun) {
      return { outcome: "completed", safeSummary: "Dry-run preview." };
    }
    if (ctx.staffOnlyTrigger) {
      return {
        outcome: "failed",
        retryable: false,
        reasonCode: "AUTOMATION_STAFF_ONLY_TRIGGER_ACTION_FORBIDDEN",
        safeSummary: "Webhooks cannot be invoked from a staff-only trigger.",
      };
    }

    const signingSecret = ctx.secrets.signingSecret;
    if (!signingSecret || signingSecret.length < 16) {
      return {
        outcome: "failed",
        retryable: false,
        reasonCode: "WEBHOOK_SECRET_NOT_CONFIGURED",
        safeSummary: "Webhook signing secret is not configured.",
      };
    }

    const egress = ctx.deps.services.integrations?.egress;
    if (!egress?.fetchPinned) {
      return {
        outcome: "failed",
        retryable: false,
        reasonCode: "EGRESS_UNAVAILABLE",
        safeSummary: "Outbound egress policy service is unavailable.",
      };
    }

    const config = ctx.config;
    const data: Record<string, string | number | boolean | null> = {};
    for (const key of config.payloadFields) {
      if (key === "recipient_name") continue;
      if (Object.prototype.hasOwnProperty.call(ctx.fields, key)) {
        data[key] = ctx.fields[key] ?? null;
      }
    }

    const nowSec = Math.floor(ctx.deps.clock.now().getTime() / 1000);
    const deliveryId = `${ctx.runPublicId}:${ctx.stepKey}`;
    const body = JSON.stringify({
      id: deliveryId,
      runPublicId: ctx.runPublicId,
      automationPublicId: ctx.automationPublicId,
      automationVersion: ctx.automationVersion,
      triggerMode: ctx.triggerMode,
      triggerKey: ctx.triggerKey,
      correlationId: ctx.correlationId,
      automationOrigin: true,
      occurredAt: new Date(nowSec * 1000).toISOString(),
      data,
    });
    const signature = signAutomationWebhook(signingSecret, nowSec, body);

    const fenceHook = webhookFenceHooks.get(ctx as AutomationActionRunContext<unknown>);
    let socketPhaseEntered = false;

    let response: EgressFetchResponse;
    try {
      response = await egress.fetchPinned(config.url, "webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "User-Agent": "ReadyPackets-Automations/1.0",
          "X-RP-Webhook-Id": deliveryId,
          "X-RP-Webhook-Timestamp": String(nowSec),
          "X-RP-Webhook-Signature": signature,
          "X-RP-Correlation-Id": ctx.correlationId,
          "X-RP-Automation-Origin": "1",
        },
        body,
        maxRequestBytes: 32 * 1024,
        maxResponseBytes: 4 * 1024,
        timeoutMs: 8_000,
        requireAllowlistRule: true,
        signal: ctx.signal,
        beforeSend: async () => {
          if (fenceHook) {
            await fenceHook();
          }
          socketPhaseEntered = true;
        },
      });
    } catch (err) {
      if (!socketPhaseEntered) {
        const dErr = err instanceof DomainError ? err : null;
        return {
          outcome: "failed",
          retryable: false,
          reasonCode: dErr?.reasonCode ?? "WEBHOOK_PREFLIGHT_REFUSED",
          safeSummary:
            dErr?.safeMessage ?? "Webhook destination was refused before opening a connection.",
        };
      }
      return {
        outcome: "unknown",
        reasonCode: "WEBHOOK_TRANSPORT_AMBIGUOUS",
        safeSummary:
          "Webhook connection was interrupted after dispatch; delivery outcome is unknown and was not retried.",
      };
    }

    if (response.status >= 200 && response.status < 300) {
      return {
        outcome: "completed",
        safeSummary: `Webhook delivered (HTTP ${response.status}).`,
        safeCounts: { http_status: response.status },
      };
    }

    return {
      outcome: "failed",
      retryable: false,
      reasonCode: `WEBHOOK_HTTP_${response.status}`,
      safeSummary: `Webhook endpoint returned HTTP ${response.status}.`,
      safeCounts: { http_status: response.status },
    };
  },
};

/* ----------------------------------------------- Template validation helper */

export function validateBuiltInActionTemplates(
  actionKey: string,
  config: Record<string, unknown>,
  allowedTemplateFieldKeys: ReadonlySet<string>,
  staffOnly: boolean,
): void {
  if (staffOnly && !STAFF_ONLY_ALLOWED_ACTION_KEYS.has(actionKey)) {
    throw validation(
      "AUTOMATION_STAFF_ONLY_TRIGGER_ACTION_FORBIDDEN",
      `Action '${actionKey}' is not permitted on staff-only triggers.`,
    );
  }

  if (actionKey === "email.send_template") {
    if (typeof config.subject === "string") {
      extractAndValidateTemplateVars(config.subject, allowedTemplateFieldKeys, {
        singleLine: true,
        fieldLabel: "Subject",
      });
    }
    if (typeof config.body === "string") {
      extractAndValidateTemplateVars(config.body, allowedTemplateFieldKeys, {
        fieldLabel: "Message body",
      });
    }
  } else if (actionKey === "notification.send_in_app") {
    if (
      staffOnly &&
      typeof config.recipientKey === "string" &&
      CUSTOMER_RECIPIENT_KEYS.has(config.recipientKey)
    ) {
      throw validation(
        "AUTOMATION_STAFF_ONLY_CUSTOMER_RECIPIENT_FORBIDDEN",
        "Staff-only triggers cannot address customer recipients.",
      );
    }
    if (typeof config.title === "string") {
      extractAndValidateTemplateVars(config.title, allowedTemplateFieldKeys, {
        singleLine: true,
        fieldLabel: "Title",
      });
    }
    if (typeof config.body === "string") {
      extractAndValidateTemplateVars(config.body, allowedTemplateFieldKeys, {
        fieldLabel: "Notification text",
      });
    }
  } else if (actionKey === "support.create_ticket") {
    if (typeof config.subject === "string") {
      extractAndValidateTemplateVars(config.subject, allowedTemplateFieldKeys, {
        singleLine: true,
        fieldLabel: "Ticket subject",
      });
    }
    if (typeof config.body === "string") {
      extractAndValidateTemplateVars(config.body, allowedTemplateFieldKeys, {
        fieldLabel: "Initial message",
      });
    }
  } else if (actionKey === "webhook.call") {
    const fields = Array.isArray(config.payloadFields) ? config.payloadFields : [];
    for (const f of fields) {
      if (typeof f !== "string" || f === "recipient_name" || !allowedTemplateFieldKeys.has(f)) {
        throw validation(
          "AUTOMATION_WEBHOOK_FIELD_FORBIDDEN",
          `Field '${String(f)}' is not permitted in webhook payloads for this trigger.`,
        );
      }
    }
  }
}

/* -------------------------------------------------------- Starter recipes */

export const STARTER_RECIPES: readonly AutomationStarterRecipe[] = Object.freeze([
  {
    key: "order_confirmation_email",
    name: "Order confirmation e-mail",
    description: "Sends a confirmation e-mail to the customer when a new order is placed.",
    trigger: { kind: "event", triggerKey: "order.created" },
    conditions: { match: "all", groups: [] },
    actions: [
      {
        stepKey: "step_1",
        actionKey: "email.send_template",
        label: "Send order confirmation",
        config: {
          recipientMode: "trigger",
          recipientKey: "order_owner",
          templateKey: GENERIC_AUTOMATION_MAIL_TEMPLATE,
          subject: "Order {{order_reference}} received",
          body: "Your order {{order_reference}} has been received. View progress: {{order_link}}",
        },
      },
    ],
  },
  {
    key: "invoice_receipt_email",
    name: "Invoice payment receipt",
    description: "E-mails the customer when an invoice payment settles the invoice in full.",
    trigger: { kind: "event", triggerKey: "invoice.paid" },
    conditions: {
      match: "all",
      groups: [
        {
          match: "all",
          conditions: [{ field: "derived_invoice_status", operator: "eq", value: "paid" }],
        },
      ],
    },
    actions: [
      {
        stepKey: "step_1",
        actionKey: "email.send_template",
        label: "Send payment receipt",
        config: {
          recipientMode: "trigger",
          recipientKey: "order_owner",
          templateKey: GENERIC_AUTOMATION_MAIL_TEMPLATE,
          subject: "Payment received for invoice {{invoice_number}}",
          body: "Thank you — payment has been recorded for invoice {{invoice_number}}.",
        },
      },
    ],
  },
  {
    key: "new_ticket_staff_notice",
    name: "Notify staff of new support ticket",
    description: "Sends an in-app alert to all staff when a support ticket is opened.",
    trigger: { kind: "event", triggerKey: "ticket.opened" },
    conditions: { match: "all", groups: [] },
    actions: [
      {
        stepKey: "step_1",
        actionKey: "notification.send_in_app",
        label: "Notify staff",
        config: {
          recipientKey: "staff",
          title: "New support ticket {{ticket_number}}",
          body: "Ticket {{ticket_number}} ({{category}}) is open: {{ticket_link}}",
        },
      },
    ],
  },
  {
    key: "backup_failed_admin_alert",
    name: "Alert administrators when a backup fails",
    description: "Sends both an in-app alert and e-mail to administrators if a backup fails.",
    trigger: { kind: "event", triggerKey: "backup.failed" },
    conditions: { match: "all", groups: [] },
    actions: [
      {
        stepKey: "step_1",
        actionKey: "notification.send_in_app",
        label: "In-app alert to admins",
        config: {
          recipientKey: "administrators",
          title: "Backup failed ({{reason_code}})",
          body: "Encrypted backup archive failed with reason {{reason_code}}.",
        },
      },
      {
        stepKey: "step_2",
        actionKey: "email.send_template",
        label: "E-mail alert to admins",
        config: {
          recipientMode: "trigger",
          recipientKey: "administrators",
          templateKey: GENERIC_AUTOMATION_MAIL_TEMPLATE,
          subject: "Backup failed ({{reason_code}})",
          body: "A scheduled or manual backup failed with reason {{reason_code}}.",
        },
      },
    ],
  },
]);

if (!getStaticAutomationRegistrations().actions.has("email.send_template")) {
  registerAutomationAction(emailSendTemplateAction);
}
if (!getStaticAutomationRegistrations().actions.has("notification.send_in_app")) {
  registerAutomationAction(notificationSendInAppAction);
}
if (!getStaticAutomationRegistrations().actions.has("support.create_ticket")) {
  registerAutomationAction(supportCreateTicketAction);
}
if (!getStaticAutomationRegistrations().actions.has("webhook.call")) {
  registerAutomationAction(webhookCallAction);
}
