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
import {
  STAGE_COMPLETION_DELAY_MAX_MINUTES,
  STAGE_WEBHOOK_TARGET,
  type StageCompletion,
} from "../../../shared/workflowStages.js";
import type { ModuleDeps } from "../../container.js";
import { DomainError, validation } from "../../core/errors.js";
import { ULID_PATTERN } from "../../core/ids.js";
import type { Mailer, Tx } from "../../core/types.js";
import { users } from "../identity/schema.js";
import type { EgressFetchResponse } from "../integrations/egress.js";
import { lockBlocks } from "../orders/policy.js";
import { orders } from "../orders/schema.js";
import { findState } from "../orders/workflowTypes.js";
import { admitOrderCompletionInTx, sanitizeOpsAlertCopy } from "./completionJobs.js";
import {
  getStaticAutomationRegistrations,
  registerAutomationAction,
  registerAutomationTrigger,
  type AutomationActionRegistration,
  type AutomationActionRunContext,
  type AutomationActionRunResult,
  type AutomationScalarValue,
  type AutomationStarterRecipe,
  type AutomationTriggerResolveInput,
} from "./contracts.js";
import {
  extractAndValidateTemplateVars,
  renderPlainTemplate,
  signAutomationWebhook,
} from "./templates.js";

/** Default-deny allowlist of actions permitted when a trigger has `staffOnly: true` (`J-A01`). */
export const STAFF_ONLY_ALLOWED_ACTION_KEYS: ReadonlySet<string> = new Set([
  "notification.send_in_app",
  "dashboard.create_alert",
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

/* ------------------------------------------- Increment 07 (D5) built-in actions */

interface OrderSetCompletionConfig {
  kind: "fixed" | "range";
  percent?: number | undefined;
  minPercent?: number | undefined;
  maxPercent?: number | undefined;
  delayMinutes?: number | undefined;
}

const orderSetCompletionConfigSchema: z.ZodType<OrderSetCompletionConfig> = z
  .strictObject({
    kind: z.enum(["fixed", "range"]),
    percent: z.number().int().min(0).max(100).optional(),
    minPercent: z.number().int().min(0).max(100).optional(),
    maxPercent: z.number().int().min(0).max(100).optional(),
    delayMinutes: z.number().int().min(0).max(STAGE_COMPLETION_DELAY_MAX_MINUTES).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.kind === "fixed") {
      if (typeof val.percent !== "number") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["percent"],
          message: "Completion percent (0–100) is required when kind is fixed.",
        });
      }
    } else {
      if (typeof val.minPercent !== "number" || typeof val.maxPercent !== "number") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["minPercent"],
          message: "Minimum and maximum percent (0–100) are required when kind is range.",
        });
      } else if (val.minPercent > val.maxPercent) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["minPercent"],
          message: "Minimum percent must not exceed maximum percent.",
        });
      }
    }
  });

const orderSetCompletionAction: AutomationActionRegistration<OrderSetCompletionConfig> = {
  key: "order.set_completion",
  label: "Update order completion percentage",
  description:
    "Updates an order's completion percentage immediately or after a delay, using a fixed value or single-roll server range. Never changes order status.",
  category: "Order progress",
  owner: "automations",
  configSchema: orderSetCompletionConfigSchema,
  requiresOrderContext: true,
  forbidOnStaffOnlyTrigger: true,
  retrySafe: true,
  configFields: [
    {
      key: "kind",
      label: "Policy mode",
      type: "enum",
      required: true,
      enumOptions: [
        { value: "fixed", label: "Fixed percentage" },
        { value: "range", label: "Bounded random range (drawn once)" },
      ],
    },
    {
      key: "percent",
      label: "Completion percentage (0–100)",
      type: "number",
      required: false,
      min: 0,
      max: 100,
    },
    {
      key: "minPercent",
      label: "Minimum percentage (0–100)",
      type: "number",
      required: false,
      min: 0,
      max: 100,
    },
    {
      key: "maxPercent",
      label: "Maximum percentage (0–100)",
      type: "number",
      required: false,
      min: 0,
      max: 100,
    },
    {
      key: "delayMinutes",
      label: "Delay before applying (minutes, 0 = immediate)",
      type: "number",
      required: false,
      min: 0,
      max: STAGE_COMPLETION_DELAY_MAX_MINUTES,
    },
  ],
  async run(ctx: AutomationActionRunContext<OrderSetCompletionConfig>) {
    if (ctx.staffOnlyTrigger) {
      return {
        outcome: "failed",
        retryable: false,
        reasonCode: "AUTOMATION_STAFF_ONLY_TRIGGER_ACTION_FORBIDDEN",
        safeSummary: "Staff-only triggers cannot modify customer-visible order completion.",
      };
    }
    if (!ctx.orderPublicId || !ULID_PATTERN.test(ctx.orderPublicId)) {
      return {
        outcome: "skipped",
        reasonCode: "NO_ORDER_CONTEXT",
        safeSummary: "Trigger did not include an order context.",
      };
    }

    const policy: StageCompletion =
      ctx.config.kind === "fixed"
        ? {
            kind: "fixed",
            percent: ctx.config.percent ?? 0,
            delayMinutes: ctx.config.delayMinutes ?? 0,
          }
        : {
            kind: "range",
            min: ctx.config.minPercent ?? 0,
            max: ctx.config.maxPercent ?? 100,
            delayMinutes: ctx.config.delayMinutes ?? 0,
          };

    if (ctx.dryRun) {
      return {
        outcome: "completed",
        safeSummary:
          policy.kind === "fixed"
            ? `[Dry run] Would set completion to ${policy.percent}% (delay ${policy.delayMinutes}m).`
            : `[Dry run] Would draw completion in ${policy.min}%–${policy.max}% (delay ${policy.delayMinutes}m).`,
      };
    }

    const ordersSvc = ctx.deps.services.orders;
    if (!ordersSvc?.stages?.contextForRun) {
      return {
        outcome: "failed",
        retryable: false,
        reasonCode: "ORDERS_STAGES_PORT_UNAVAILABLE",
        safeSummary: "Order stages port is unavailable.",
      };
    }

    const orderPublicId = ctx.orderPublicId;
    return ctx.deps.db.transaction(async (tx: Tx) => {
      await ctx.assertStillOwned(tx);
      const [lockedOrder] = await tx
        .select({
          id: orders.id,
          publicId: orders.publicId,
          lockState: orders.lockState,
          workflowVersionId: orders.workflowVersionId,
          completionRevision: orders.completionRevision,
        })
        .from(orders)
        .where(eq(orders.publicId, orderPublicId))
        .for("update");

      if (!lockedOrder) {
        return {
          outcome: "skipped",
          reasonCode: "ORDER_NOT_FOUND",
          safeSummary: "Target order no longer exists.",
        };
      }
      if (lockBlocks(lockedOrder.lockState, true, "order")) {
        return {
          outcome: "skipped",
          reasonCode: "ORDER_LOCKED",
          safeSummary: `Order is locked (${lockedOrder.lockState}); completion update skipped.`,
        };
      }

      const stageCtx = await ordersSvc.stages.contextForRun(lockedOrder.publicId, tx);
      const fullDeps: ModuleDeps = {
        ...(ctx.deps as unknown as ModuleDeps),
      };

      const res = await admitOrderCompletionInTx(fullDeps, tx, {
        orderId: lockedOrder.id,
        orderPublicId: lockedOrder.publicId,
        workflowVersionId: lockedOrder.workflowVersionId,
        stageKey: stageCtx.currentStageKey,
        expectedRevision: lockedOrder.completionRevision,
        policy,
        sourceKind: "automation_run",
        sourcePublicId: ctx.runPublicId,
        idempotencyKey: ctx.idempotencyKey,
        correlationId: ctx.correlationId,
        createdByUserId: null,
      });

      if (res.jobRow.delayMinutes > 0) {
        return {
          outcome: "completed",
          safeSummary: `Scheduled ${res.jobRow.resolvedPercent}% completion update in ${res.jobRow.delayMinutes} min.`,
          externalRef: res.jobRow.publicId,
          safeCounts: {
            resolved_percent: res.jobRow.resolvedPercent,
            delay_minutes: res.jobRow.delayMinutes,
          },
        };
      }
      if (res.immediateApplied) {
        return {
          outcome: "completed",
          safeSummary: `Updated order completion to ${res.jobRow.resolvedPercent}%.`,
          externalRef: res.jobRow.publicId,
          safeCounts: {
            resolved_percent: res.jobRow.resolvedPercent,
            delay_minutes: 0,
          },
        };
      }
      return {
        outcome: "skipped",
        reasonCode: res.supersededReasonCode ?? "REVISION_MISMATCH",
        safeSummary: "Completion update was superseded by a newer order revision.",
        externalRef: res.jobRow.publicId,
      };
    });
  },
};

interface WebhookEnqueueSubscriptionConfig {
  targetKey: string;
  eventKey?: string | undefined;
  includeEvaluatedFields?: boolean | undefined;
}

const webhookEnqueueSubscriptionConfigSchema: z.ZodType<WebhookEnqueueSubscriptionConfig> =
  z.strictObject({
    targetKey: z
      .string()
      .trim()
      .regex(
        STAGE_WEBHOOK_TARGET,
        "Select a configured webhook subscription or production webhook target (raw URLs and secrets are not permitted).",
      ),
    eventKey: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_.-]{1,79}$/)
      .optional(),
    includeEvaluatedFields: z.boolean().optional(),
  });

const webhookEnqueueSubscriptionAction: AutomationActionRegistration<WebhookEnqueueSubscriptionConfig> =
  {
    key: "webhook.enqueue_subscription",
    label: "Enqueue workflow webhook",
    description:
      "Enqueues a signed outbound webhook delivery via a configured subscription or production webhook target without exposing URLs or secrets in rules.",
    category: "Integrations",
    owner: "integrations",
    configSchema: webhookEnqueueSubscriptionConfigSchema,
    requiresOrderContext: false,
    forbidOnStaffOnlyTrigger: true,
    retrySafe: true,
    configFields: [
      {
        key: "targetKey",
        label: "Webhook target",
        type: "webhook_subscription",
        required: true,
        helpText: "Managed under Integrations -> Webhooks. Raw URLs and secrets are never stored in rules.",
      },
      {
        key: "eventKey",
        label: "Event name override (optional)",
        type: "string",
        required: false,
        maxLength: 80,
        helpText: "Defaults to the trigger key (for example order.stage_submitted).",
      },
      {
        key: "includeEvaluatedFields",
        label: "Include safe non-personal event fields",
        type: "boolean",
        required: false,
      },
    ],
    async run(ctx: AutomationActionRunContext<WebhookEnqueueSubscriptionConfig>) {
      if (ctx.staffOnlyTrigger) {
        return {
          outcome: "failed",
          retryable: false,
          reasonCode: "AUTOMATION_STAFF_ONLY_TRIGGER_ACTION_FORBIDDEN",
          safeSummary: "Staff-only triggers cannot dispatch outbound webhooks.",
        };
      }

      const whPort = ctx.deps.services.integrations?.workflowWebhooks;
      if (!whPort?.enqueueStageWebhook || !whPort.validateTargetKey) {
        return {
          outcome: "failed",
          retryable: false,
          reasonCode: "WEBHOOK_PORT_UNAVAILABLE",
          safeSummary: "Workflow webhooks port is unavailable.",
        };
      }

      if (ctx.dryRun) {
        const check = await whPort.validateTargetKey(ctx.config.targetKey);
        return {
          outcome: "completed",
          safeSummary: check.valid
            ? `[Dry run] Would enqueue webhook delivery to "${ctx.config.targetKey}".`
            : `[Dry run] Target "${ctx.config.targetKey}": ${check.message}`,
        };
      }

      const safeFields: Record<string, unknown> = {};
      if (ctx.config.includeEvaluatedFields !== false) {
        for (const [k, v] of Object.entries(ctx.fields)) {
          if (k === "recipient_name") continue;
          safeFields[k] = v;
        }
      }

      const res = await whPort.enqueueStageWebhook({
        targetKey: ctx.config.targetKey,
        orderPublicId: ctx.orderPublicId ?? null,
        stageKey: typeof ctx.fields.stage_key === "string" ? ctx.fields.stage_key : null,
        triggerSource: "automation_rule",
        idempotencyKey: ctx.idempotencyKey,
        correlationId: ctx.correlationId,
        eventKey: ctx.config.eventKey ?? ctx.triggerKey ?? "automation.rule.executed",
        payload: {
          automation_public_id: ctx.automationPublicId,
          run_public_id: ctx.runPublicId,
          trigger_key: ctx.triggerKey ?? "manual",
          ...(ctx.orderPublicId ? { order_public_id: ctx.orderPublicId } : {}),
          ...(ctx.config.includeEvaluatedFields !== false ? { fields: safeFields } : {}),
        },
      });

      if (res.outcome === "queued" || res.outcome === "already_queued_or_delivered") {
        return {
          outcome: "completed",
          safeSummary: res.message,
          externalRef: res.deliveryPublicId ?? res.dispatchPublicId ?? ctx.config.targetKey,
        };
      }
      if (res.outcome === "disabled") {
        return {
          outcome: "skipped",
          reasonCode: res.reasonCode ?? "WEBHOOK_DISABLED",
          safeSummary: res.message,
          externalRef: ctx.config.targetKey,
        };
      }
      return {
        outcome: "failed",
        retryable: false,
        reasonCode: res.reasonCode ?? "WEBHOOK_REFUSED",
        safeSummary: res.message,
        externalRef: ctx.config.targetKey,
      };
    },
  };

interface DashboardCreateAlertConfig {
  severity: "warning" | "error" | "critical";
  titleTemplate: string;
  bodyTemplate?: string | undefined;
  code?: string | undefined;
}

const dashboardCreateAlertConfigSchema: z.ZodType<DashboardCreateAlertConfig> = z.strictObject({
  severity: z.enum(["warning", "error", "critical"]),
  titleTemplate: z.string().trim().min(1).max(120),
  bodyTemplate: z.string().trim().max(500).optional(),
  code: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]{1,63}$/)
    .optional(),
});

const dashboardCreateAlertAction: AutomationActionRegistration<DashboardCreateAlertConfig> = {
  key: "dashboard.create_alert",
  label: "Create operational dashboard alert",
  description:
    "Opens or escalates an operational alert on the Background Jobs & Operational Alerts centre for staff and administrators.",
  category: "Operations",
  owner: "automations",
  configSchema: dashboardCreateAlertConfigSchema,
  requiresOrderContext: false,
  forbidOnStaffOnlyTrigger: false,
  retrySafe: true,
  configFields: [
    {
      key: "severity",
      label: "Severity",
      type: "enum",
      required: true,
      enumOptions: [
        { value: "warning", label: "Warning" },
        { value: "error", label: "Error" },
        { value: "critical", label: "Critical" },
      ],
    },
    {
      key: "titleTemplate",
      label: "Alert title",
      type: "string",
      required: true,
      maxLength: 120,
      helpText: "Supports safe non-personal trigger variables such as {{order_reference}}.",
    },
    {
      key: "bodyTemplate",
      label: "Alert details (optional)",
      type: "textarea",
      required: false,
      maxLength: 500,
      helpText: "Plain text details shown to operators.",
    },
    {
      key: "code",
      label: "Alert code (optional)",
      type: "string",
      required: false,
      maxLength: 64,
      helpText: "Defaults to AUTOMATION_RULE_ALERT.",
    },
  ],
  async run(ctx: AutomationActionRunContext<DashboardCreateAlertConfig>) {
    const nonPersonalFields: Record<string, AutomationScalarValue> = {};
    for (const [k, v] of Object.entries(ctx.fields)) {
      if (k === "recipient_name") continue;
      nonPersonalFields[k] =
        typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : null;
    }

    const renderedTitle = sanitizeOpsAlertCopy(
      renderPlainTemplate(ctx.config.titleTemplate, nonPersonalFields),
      120,
    );
    const renderedBodyRaw = ctx.config.bodyTemplate
      ? renderPlainTemplate(ctx.config.bodyTemplate, nonPersonalFields).trim()
      : "";
    const renderedBody = renderedBodyRaw ? sanitizeOpsAlertCopy(renderedBodyRaw, 500) : undefined;

    if (ctx.dryRun) {
      return {
        outcome: "completed",
        safeSummary: `[Dry run] Would open ${ctx.config.severity} alert: "${renderedTitle}".`,
      };
    }

    if (!ctx.deps.services.opsAlerts?.emit) {
      return {
        outcome: "failed",
        retryable: false,
        reasonCode: "OPS_ALERTS_UNAVAILABLE",
        safeSummary: "Operational alerts port is unavailable.",
      };
    }

    const alertRes = await ctx.deps.services.opsAlerts.emit({
      source: "automation",
      severity: ctx.config.severity,
      dedupKey: `auto_rule_alert:${ctx.runPublicId}:${ctx.stepKey}`,
      correlationId: ctx.correlationId,
      code: ctx.config.code ?? "AUTOMATION_RULE_ALERT",
      title: renderedTitle,
      ...(renderedBody ? { text: renderedBody } : {}),
      ...(ctx.orderPublicId && ULID_PATTERN.test(ctx.orderPublicId)
        ? { orderPublicId: ctx.orderPublicId }
        : {}),
      ...(ULID_PATTERN.test(ctx.runPublicId) ? { runPublicId: ctx.runPublicId } : {}),
    });

    return {
      outcome: "completed",
      safeSummary: `Opened ${ctx.config.severity} operational alert (${alertRes.state}).`,
      externalRef: alertRes.publicId,
    };
  },
};

async function resolveStageSubmittedTriggerContext({
  event,
  db,
  services,
  signal,
}: AutomationTriggerResolveInput) {
  signal.throwIfAborted();
  const rawOrderPublicId =
    event.resource?.type === "order" && typeof event.resource.publicId === "string"
      ? event.resource.publicId
      : typeof event.attributes.order_public_id === "string"
        ? event.attributes.order_public_id
        : null;
  if (!rawOrderPublicId || !ULID_PATTERN.test(rawOrderPublicId)) {
    return {};
  }
  const [orderRow] = await db
    .select({
      publicId: orders.publicId,
      reference: orders.reference,
      ownerUserId: orders.ownerUserId,
      statusKey: orders.statusKey,
      workflowVersionId: orders.workflowVersionId,
    })
    .from(orders)
    .where(eq(orders.publicId, rawOrderPublicId))
    .limit(1);
  if (!orderRow) return {};

  const bound = services.orders?.workflows?.byVersionId
    ? await services.orders.workflows.byVersionId(db, orderRow.workflowVersionId)
    : null;
  const state = bound ? findState(bound.definition, orderRow.statusKey) : null;
  const stageKeyAttr =
    typeof event.attributes.stage_key === "string" ? event.attributes.stage_key : null;
  const matchedStage =
    bound && stageKeyAttr && Array.isArray(bound.definition.stages)
      ? bound.definition.stages.find((s) => s.key === stageKeyAttr)
      : null;

  return {
    orderPublicId: orderRow.publicId,
    fields: {
      order_reference: orderRow.reference,
      order_status_label: state?.customerLabel ?? orderRow.statusKey,
      ...(matchedStage ? { stage_label: matchedStage.customerLabel } : {}),
    },
    recipients: {
      order_owner: [orderRow.ownerUserId],
      order_assignee: [],
    },
  };
}

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
  } else if (actionKey === "dashboard.create_alert") {
    const nonPersonalAllowed = new Set(
      [...allowedTemplateFieldKeys].filter((k) => k !== "recipient_name"),
    );
    if (typeof config.titleTemplate === "string") {
      extractAndValidateTemplateVars(config.titleTemplate, nonPersonalAllowed, {
        singleLine: true,
        fieldLabel: "Alert title",
      });
    }
    if (typeof config.bodyTemplate === "string" && config.bodyTemplate.length > 0) {
      extractAndValidateTemplateVars(config.bodyTemplate, nonPersonalAllowed, {
        fieldLabel: "Alert details",
      });
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
if (!getStaticAutomationRegistrations().actions.has("order.set_completion")) {
  registerAutomationAction(orderSetCompletionAction);
}
if (!getStaticAutomationRegistrations().actions.has("webhook.enqueue_subscription")) {
  registerAutomationAction(webhookEnqueueSubscriptionAction);
}
if (!getStaticAutomationRegistrations().actions.has("dashboard.create_alert")) {
  registerAutomationAction(dashboardCreateAlertAction);
}
if (!getStaticAutomationRegistrations().triggers.has("order.stage_submitted")) {
  registerAutomationTrigger({
    key: "order.stage_submitted",
    resolveContext: resolveStageSubmittedTriggerContext,
  });
}
