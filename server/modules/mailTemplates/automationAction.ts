import { inArray } from "drizzle-orm";
import { z } from "zod";
import { newRequestContext, runWithRequestContext } from "../../core/requestContext.js";
import {
  registerAutomationAction,
  type AutomationActionRegistration,
  type AutomationActionRunContext,
  type AutomationActionRunResult,
} from "../automations/contracts.js";
import { users } from "../identity/schema.js";
import { HEADER_CONTROL_RE } from "./sanitizer.js";

const TEMPLATE_KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const RECIPIENT_KEY_RE = /^[a-z][a-z0-9_]{1,47}$/;
const SIMPLE_EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

export interface SendTemplateActionConfig {
  templateKey: string;
  recipientMode: "catalogue" | "fixed";
  recipientKey?: string;
  fixedAddress?: string;
}

export const sendTemplateActionConfigSchema: z.ZodType<SendTemplateActionConfig> = z
  .strictObject({
    templateKey: z
      .string()
      .min(3)
      .max(100)
      .regex(TEMPLATE_KEY_RE, "Select a valid template key.")
      .refine((key) => !key.startsWith("mail_templates.test_") && key !== "jobs.mail.verify_audit_copy", {
        message: "Internal verification and test keys cannot be used in automations.",
      }),
    recipientMode: z.enum(["catalogue", "fixed"]),
    recipientKey: z.string().regex(RECIPIENT_KEY_RE).optional(),
    fixedAddress: z
      .string()
      .max(254)
      .refine((v) => !HEADER_CONTROL_RE.test(v) && SIMPLE_EMAIL_RE.test(v.trim()), {
        message: "Enter a valid e-mail address without control characters.",
      })
      .optional(),
  })
  .superRefine((val, ctx) => {
    if (val.recipientMode === "catalogue" && !val.recipientKey) {
      ctx.addIssue({
        code: "custom",
        path: ["recipientKey"],
        message: "Select a recipient from the trigger.",
      });
    }
    if (val.recipientMode === "fixed" && !val.fixedAddress) {
      ctx.addIssue({
        code: "custom",
        path: ["fixedAddress"],
        message: "Enter a fixed destination e-mail address.",
      });
    }
  });

function resolveTemplateVarsForRecipient(
  declaredVars: readonly string[],
  fields: Readonly<Record<string, string | number | boolean | null>>,
  canonicalOrigin: string,
  recipientDisplayName: string | null,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  const strField = (k: string): string | null => {
    const raw = fields[k];
    if (raw === undefined || raw === null) return null;
    const clean = String(raw).replace(/\0/g, "").trim();
    return clean.length > 0 ? clean : null;
  };

  for (const varName of declaredVars) {
    const direct = fields[varName];
    if (direct !== undefined && direct !== null) {
      out[varName] = typeof direct === "string" ? direct.replace(/\0/g, "") : direct;
      continue;
    }

    switch (varName) {
      case "recipient_name":
      case "name":
        out[varName] = recipientDisplayName || "Valued user";
        break;
      case "reference":
      case "orderReference":
        out[varName] = strField("order_reference") ?? strField("order_public_id") ?? "Order";
        break;
      case "statusLabel":
        out[varName] = strField("order_status_label") ?? strField("to_status") ?? "Updated";
        break;
      case "invoiceNumber":
        out[varName] = strField("invoice_number") ?? strField("invoice_public_id") ?? "Invoice";
        break;
      case "ticketNumber":
        out[varName] = strField("ticket_number") ?? "Ticket";
        break;
      case "eventLabel":
        out[varName] = strField("to_status") ?? "Updated";
        break;
      case "link":
        out[varName] =
          strField("order_link") ??
          strField("invoice_link") ??
          strField("ticket_link") ??
          canonicalOrigin;
        break;
      case "portalPath":
        out[varName] =
          strField("invoice_link") ??
          strField("order_link") ??
          strField("ticket_link") ??
          canonicalOrigin;
        break;
      case "title":
      case "summary":
        out[varName] = strField("reason_code") ?? strField("order_status_label") ?? "ReadyPackets update";
        break;
      case "windowLabel":
        out[varName] = "Scheduled maintenance";
        break;
      default:
        out[varName] = "";
        break;
    }
  }
  return out;
}

async function runSendTemplateAction(
  ctx: AutomationActionRunContext<SendTemplateActionConfig>,
): Promise<AutomationActionRunResult> {
  const { config, deps } = ctx;

  // Defense-in-depth `staffOnly` enforcement (`J-A01`)
  if (ctx.staffOnlyTrigger && config.recipientMode === "fixed") {
    return {
      outcome: "failed",
      reasonCode: "STAFF_ONLY_FIXED_RECIPIENT_FORBIDDEN",
      retryable: false,
      safeSummary: "Staff-only triggers cannot send e-mail to fixed external addresses.",
    };
  }

  // Verify the template exists and is resolvable (either published custom/override or built-in system)
  const published = await deps.services.mailTemplates.store.resolve(config.templateKey);
  const builtin = deps.services.jobAdmin
    .getBuiltinMailTemplates()
    .find((t) => t.key === config.templateKey);

  // For custom templates (`custom.*`), an active published version is mandatory
  if (!published && !builtin) {
    return {
      outcome: "failed",
      reasonCode: "TEMPLATE_NOT_PUBLISHED",
      retryable: false,
      safeSummary: "Selected mail template does not exist or has no published version.",
    };
  }

  const declaredVars = published ? published.vars : (builtin?.vars ?? []);
  // Disallow automated mass-dispatch of templates carrying single-use authentication secrets
  const sensitiveVars = published?.sensitiveVars ?? builtin?.sensitiveVars ?? [];
  if (sensitiveVars.length > 0) {
    return {
      outcome: "failed",
      reasonCode: "SENSITIVE_TEMPLATE_FORBIDDEN_IN_AUTOMATION",
      retryable: false,
      safeSummary: "Templates containing single-use authentication secrets cannot be sent by automations.",
    };
  }

  if (ctx.dryRun) {
    return {
      outcome: "completed",
      safeSummary: "Dry-run verified mail template and recipient configuration.",
      safeCounts: { queued_messages: 0 },
    };
  }

  const execWithAutomationCorrelation = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithRequestContext(
      newRequestContext("worker", { correlationId: ctx.correlationId }),
      fn,
    );

  if (config.recipientMode === "fixed") {
    const addr = config.fixedAddress?.trim().toLowerCase() ?? "";
    if (!addr || HEADER_CONTROL_RE.test(addr) || !SIMPLE_EMAIL_RE.test(addr)) {
      return {
        outcome: "failed",
        reasonCode: "INVALID_FIXED_RECIPIENT",
        retryable: false,
        safeSummary: "Fixed destination e-mail address is invalid.",
      };
    }
    const vars = resolveTemplateVarsForRecipient(
      declaredVars,
      ctx.fields,
      deps.services.config.canonicalOrigin,
      null,
    );
    await execWithAutomationCorrelation(() =>
      deps.mailer.enqueue({
        template: config.templateKey,
        to: { address: addr },
        vars,
        idempotencyKey: `${ctx.idempotencyKey}:fixed`,
      }),
    );
    return {
      outcome: "completed",
      safeSummary: "E-mail queued for configured recipient.",
      safeCounts: { queued_messages: 1 },
    };
  }

  const rawUserIds = [...new Set(ctx.recipients[config.recipientKey ?? ""] ?? [])].filter(
    (id) => Number.isInteger(id) && id > 0,
  );
  if (rawUserIds.length === 0) {
    return {
      outcome: "skipped",
      reasonCode: "NO_RECIPIENTS_RESOLVED",
      safeSummary: "No active recipients matched the selected recipient group.",
    };
  }

  const userRows = await deps.db
    .select({
      id: users.id,
      publicId: users.publicId,
      role: users.role,
      status: users.status,
      nameEnc: users.nameEnc,
    })
    .from(users)
    .where(inArray(users.id, rawUserIds));

  const eligibleUsers = userRows.filter((u) => {
    if (u.status !== "active") return false;
    if (ctx.staffOnlyTrigger && u.role === "customer") return false;
    return true;
  });

  if (eligibleUsers.length === 0) {
    return {
      outcome: "skipped",
      reasonCode: ctx.staffOnlyTrigger ? "STAFF_ONLY_RECIPIENTS_FILTERED" : "NO_ACTIVE_RECIPIENTS",
      safeSummary: "No eligible active recipients remained after policy checks.",
    };
  }

  const needsName = declaredVars.includes("recipient_name") || declaredVars.includes("name");
  let queuedCount = 0;

  for (const recipient of eligibleUsers) {
    ctx.signal.throwIfAborted();
    let displayName: string | null = null;
    if (needsName) {
      try {
        displayName = deps.crypto
          .decrypt(recipient.nameEnc, `users.name:${recipient.publicId}`)
          .replace(/[\p{Cc}\u2028\u2029]+/gu, " ")
          .trim();
      } catch {
        displayName = null;
      }
    }

    const vars = resolveTemplateVarsForRecipient(
      declaredVars,
      ctx.fields,
      deps.services.config.canonicalOrigin,
      displayName,
    );

    await execWithAutomationCorrelation(() =>
      deps.mailer.enqueue({
        template: config.templateKey,
        to: { userId: recipient.id },
        vars,
        idempotencyKey: `${ctx.idempotencyKey}:u:${recipient.id}`,
      }),
    );
    queuedCount++;
  }

  return {
    outcome: "completed",
    safeSummary: "E-mail queued.",
    safeCounts: { queued_messages: queuedCount },
  };
}

export const SEND_TEMPLATE_AUTOMATION_ACTION: AutomationActionRegistration<SendTemplateActionConfig> = {
  key: "email.send_template",
  label: "Send an e-mail template",
  description: "Renders a published system or custom template with escaped variables and queues delivery.",
  category: "Messaging",
  owner: "mailTemplates",
  configSchema: sendTemplateActionConfigSchema,
  configFields: [
    {
      key: "templateKey",
      label: "Template",
      helpText: "Choose a published custom template or built-in system template.",
      type: "template_key",
      required: true,
    },
    {
      key: "recipientMode",
      label: "Send to",
      type: "enum",
      required: true,
      enumOptions: [
        { value: "catalogue", label: "A person from the event" },
        { value: "fixed", label: "A fixed address" },
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
      label: "E-mail address",
      type: "email",
      required: true,
      maxLength: 254,
    },
  ],
  retrySafe: true,
  run: runSendTemplateAction,
};

export function registerMailTemplateAutomationAction(): void {
  registerAutomationAction(SEND_TEMPLATE_AUTOMATION_ACTION, { replaceBuiltIn: true });
}
