/**
 * Package D (`mailTemplates`) implementation of the `"email.send_template"` automation action,
 * registered via `registerAutomationAction(..., { replaceBuiltIn: true })`.
 *
 * Security & integration invariants:
 *  - `J-A01`: `forbidOnStaffOnlyTrigger: true` AND runtime `ctx.staffOnlyTrigger` default-deny refusal
 *    (`AUTOMATION_STAFF_ONLY_TRIGGER_ACTION_FORBIDDEN`), matching `automations/builtinActions.ts`,
 *    because queued mail outbox delivery re-resolves `userId` status without a `staff_only` role fence
 *    if an account is later demoted to `customer`.
 *  - Supports both Template Centre templates (`custom.*` and non-sensitive system templates) AND
 *    starter-recipe `automations.generic_notice` (`subject` + `body`) with `recipientMode: "trigger" | "catalogue" | "fixed"`.
 *  - Refuses unpublished custom templates (`TEMPLATE_NOT_PUBLISHED`) and any template carrying
 *    single-use authentication secrets (`SENSITIVE_TEMPLATE_FORBIDDEN_IN_AUTOMATION`).
 *  - Propagates `ctx.correlationId` (`automation:<runPublicId>`) into `deps.mailer.enqueue`.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { newRequestContext, runWithRequestContext } from "../../core/requestContext.js";
import type { Mailer } from "../../core/types.js";
import { users } from "../identity/schema.js";
import {
  registerAutomationAction,
  type AutomationActionRegistration,
  type AutomationActionRunContext,
  type AutomationActionRunResult,
  type AutomationScalarValue,
} from "../automations/contracts.js";
import { substitutePlainText } from "./sanitizer.js";
import {
  mailTemplates,
  mailTemplateVersions,
  type MailTemplateVariableSpec,
} from "./schema.js";

const GENERIC_AUTOMATION_MAIL_TEMPLATE = "automations.generic_notice";
const registeredGenericMailers = new WeakSet<Mailer>();

function ensureGenericAutomationTemplateRegistered(mailer: Mailer): void {
  if (registeredGenericMailers.has(mailer)) return;
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
  registeredGenericMailers.add(mailer);
}

function renderGenericNoticeField(
  template: string,
  fields: Readonly<Record<string, AutomationScalarValue>>,
  singleLine = false,
): string {
  const stringVars: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    stringVars[k] = v === null || v === undefined ? "" : String(v);
  }
  const rendered = substitutePlainText(template, stringVars);
  return singleLine ? rendered.replace(/[\r\n]+/g, " ").trim() : rendered;
}

const RESERVED_INTERNAL_TEMPLATE_KEYS = new Set(["jobs.mail.verify_audit_copy"]);
const TEMPLATE_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

const SIMPLE_EMAIL_RE = /^[^\s@<>"',;\\]+@[^\s@<>"',;\\]+\.[^\s@<>"',;\\]{2,}$/;

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export const sendTemplateActionConfigSchema = z
  .strictObject({
    templateKey: z
      .string()
      .trim()
      .min(3)
      .max(120)
      .regex(TEMPLATE_KEY_PATTERN, "Invalid template key.")
      .default(GENERIC_AUTOMATION_MAIL_TEMPLATE),
    recipientMode: z.enum(["trigger", "catalogue", "fixed"]).default("trigger"),
    recipientKey: z.string().trim().min(1).max(64).optional(),
    fixedAddress: z
      .string()
      .trim()
      .max(254)
      .refine((v) => !hasControlChar(v) && SIMPLE_EMAIL_RE.test(v), "Invalid e-mail address.")
      .optional(),
    subject: z.string().trim().min(1).max(160).optional(),
    body: z.string().trim().min(1).max(4000).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.recipientMode === "fixed") {
      if (!val.fixedAddress) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fixedAddress"],
          message: "Fixed e-mail address is required when recipientMode is fixed.",
        });
      }
    } else if (!val.recipientKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recipientKey"],
        message: "Recipient key is required when recipientMode addresses a trigger or role recipient.",
      });
    }

    if (val.templateKey === GENERIC_AUTOMATION_MAIL_TEMPLATE) {
      if (!val.subject) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["subject"],
          message: "Subject is required when using automations.generic_notice.",
        });
      }
      if (!val.body) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["body"],
          message: "Message body is required when using automations.generic_notice.",
        });
      }
    }
  });

export type SendTemplateActionConfig = z.infer<typeof sendTemplateActionConfigSchema>;

function scalarToString(val: AutomationScalarValue | undefined): string {
  if (val === null || val === undefined) return "";
  return String(val);
}

function resolveTemplateVarsForRecipient(
  declaredVars: readonly MailTemplateVariableSpec[],
  contextFields: Readonly<Record<string, AutomationScalarValue>>,
  canonicalOrigin: string,
  recipientDisplayName: string | null,
): Record<string, string> {
  const vars: Record<string, string> = {};
  const portalUrl = new URL("/", canonicalOrigin).href;

  for (const v of declaredVars) {
    if (v.name === "recipient_name") {
      vars[v.name] = recipientDisplayName ?? scalarToString(contextFields.recipient_name) ?? "Customer";
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(contextFields, v.name)) {
      vars[v.name] = scalarToString(contextFields[v.name]);
      continue;
    }
    if (v.name === "portal_link" || v.name === "link") {
      const candidateLink =
        scalarToString(contextFields.order_link) ||
        scalarToString(contextFields.invoice_link) ||
        scalarToString(contextFields.ticket_link) ||
        portalUrl;
      vars[v.name] = candidateLink;
      continue;
    }
    if (v.name === "reference" && contextFields.order_reference !== undefined) {
      vars[v.name] = scalarToString(contextFields.order_reference);
      continue;
    }
    if (v.name === "status" && contextFields.order_status_label !== undefined) {
      vars[v.name] = scalarToString(contextFields.order_status_label);
      continue;
    }
    if (v.name === "invoiceNumber" && contextFields.invoice_number !== undefined) {
      vars[v.name] = scalarToString(contextFields.invoice_number);
      continue;
    }
    if (v.name === "subject" && contextFields.ticket_subject !== undefined) {
      vars[v.name] = scalarToString(contextFields.ticket_subject);
      continue;
    }
    vars[v.name] = "";
  }
  return vars;
}

async function resolveCatalogueUserIds(
  ctx: AutomationActionRunContext<SendTemplateActionConfig>,
  recipientKey: string,
): Promise<number[]> {
  if (Object.prototype.hasOwnProperty.call(ctx.recipients, recipientKey)) {
    return [...(ctx.recipients[recipientKey] ?? [])];
  }
  if (recipientKey === "administrators") {
    const rows = await ctx.deps.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.status, "active"), eq(users.role, "admin")))
      .orderBy(asc(users.id))
      .limit(50);
    return rows.map((r) => r.id);
  }
  if (recipientKey === "staff") {
    const rows = await ctx.deps.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.status, "active"), inArray(users.role, ["admin", "staff"])))
      .orderBy(asc(users.id))
      .limit(50);
    return rows.map((r) => r.id);
  }
  return [];
}

async function runSendTemplateAction(
  ctx: AutomationActionRunContext<SendTemplateActionConfig>,
): Promise<AutomationActionRunResult> {
  ctx.signal.throwIfAborted();

  // J-A01: Outbound e-mail is default-denied on staff-only triggers (`staffOnly: true`), even on direct invocation,
  // because queued user-ID mail delivery does not re-enforce staff/admin role if the recipient is demoted before send.
  if (ctx.staffOnlyTrigger) {
    return {
      outcome: "failed",
      reasonCode: "AUTOMATION_STAFF_ONLY_TRIGGER_ACTION_FORBIDDEN",
      retryable: false,
      safeSummary: "Outbound e-mail actions are forbidden on staff-only triggers.",
    };
  }

  const { config, deps } = ctx;

  if (RESERVED_INTERNAL_TEMPLATE_KEYS.has(config.templateKey)) {
    return {
      outcome: "failed",
      reasonCode: "TEMPLATE_FORBIDDEN",
      retryable: false,
      safeSummary: "Internal verification templates cannot be used by automations.",
    };
  }

  const execWithAutomationCorrelation = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithRequestContext(
      newRequestContext("worker", { correlationId: ctx.correlationId }),
      fn,
    );

  // Support starter-recipe `automations.generic_notice` seamlessly alongside Template Centre templates.
  if (config.templateKey === GENERIC_AUTOMATION_MAIL_TEMPLATE) {
    ensureGenericAutomationTemplateRegistered(deps.mailer);
    if (ctx.dryRun) {
      return {
        outcome: "completed",
        safeSummary: "Dry-run verified generic automation notice configuration.",
        safeCounts: { queued_messages: 0 },
      };
    }

    if (config.recipientMode === "fixed") {
      const addr = config.fixedAddress?.trim().toLowerCase() ?? "";
      if (!addr || hasControlChar(addr) || !SIMPLE_EMAIL_RE.test(addr)) {
        return {
          outcome: "failed",
          reasonCode: "INVALID_FIXED_RECIPIENT",
          retryable: false,
          safeSummary: "Fixed destination e-mail address is invalid.",
        };
      }
      const subject = renderGenericNoticeField(config.subject ?? "Portal notification", ctx.fields, true);
      const body = renderGenericNoticeField(config.body ?? "", ctx.fields, false);
      await execWithAutomationCorrelation(() =>
        deps.mailer.enqueue({
          template: GENERIC_AUTOMATION_MAIL_TEMPLATE,
          to: { address: addr },
          vars: { subject, body, recipient_name: "" },
          idempotencyKey: `${ctx.idempotencyKey}:mail:fixed`,
        }),
      );
      return {
        outcome: "completed",
        safeSummary: "Queued 1 templated e-mail.",
        safeCounts: { queued_messages: 1 },
      };
    }

    const rawIds = await resolveCatalogueUserIds(ctx, config.recipientKey ?? "");
    const uniqueUserIds = [...new Set(rawIds.filter((id) => Number.isInteger(id) && id > 0))].slice(0, 50);
    if (uniqueUserIds.length === 0) {
      return {
        outcome: "skipped",
        reasonCode: "NO_RECIPIENTS_RESOLVED",
        safeSummary: "No eligible active recipients resolved for the configured recipient key.",
      };
    }
    const recipientRows = await deps.db
      .select({
        id: users.id,
        publicId: users.publicId,
        status: users.status,
        nameEnc: users.nameEnc,
      })
      .from(users)
      .where(inArray(users.id, uniqueUserIds));

    let queuedCount = 0;
    for (const u of recipientRows) {
      ctx.signal.throwIfAborted();
      if (u.status !== "active" && u.status !== "pending_activation") continue;
      let displayName = "Customer";
      if (u.nameEnc) {
        try {
          displayName = deps.crypto.decrypt(u.nameEnc, `users.name:${u.publicId}`);
        } catch {
          displayName = "Customer";
        }
      }
      const perRecipientFields = { ...ctx.fields, recipient_name: displayName };
      const subject = renderGenericNoticeField(config.subject ?? "Portal notification", perRecipientFields, true);
      const body = renderGenericNoticeField(config.body ?? "", perRecipientFields, false);
      await execWithAutomationCorrelation(() =>
        deps.mailer.enqueue({
          template: GENERIC_AUTOMATION_MAIL_TEMPLATE,
          to: { userId: u.id },
          vars: { subject, body, recipient_name: displayName },
          idempotencyKey: `${ctx.idempotencyKey}:mail:u:${u.id}`,
        }),
      );
      queuedCount += 1;
    }

    if (queuedCount === 0) {
      return {
        outcome: "skipped",
        reasonCode: "NO_ELIGIBLE_RECIPIENTS",
        safeSummary: "No active recipients matched the step policy.",
      };
    }
    return {
      outcome: "completed",
      safeSummary: `Queued ${queuedCount} templated e-mail(s).`,
      safeCounts: { queued_messages: queuedCount },
    };
  }

  // Template Centre template resolution (`custom.*` or built-in system templates)
  const published = await deps.services.mailTemplates.store.resolve(config.templateKey);
  const builtins = deps.services.jobAdmin.getBuiltinMailTemplates();
  const builtin = builtins.find((b) => b.key === config.templateKey);

  if (!published && !builtin) {
    const [existingRow] = await deps.db
      .select({ id: mailTemplates.id, activePublishedVersionId: mailTemplates.activePublishedVersionId })
      .from(mailTemplates)
      .where(eq(mailTemplates.templateKey, config.templateKey))
      .limit(1);

    return {
      outcome: "failed",
      reasonCode: existingRow ? "TEMPLATE_NOT_PUBLISHED" : "TEMPLATE_NOT_FOUND",
      retryable: false,
      safeSummary: existingRow
        ? "Selected mail template has no published version."
        : "Selected mail template does not exist.",
    };
  }

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

  const [tplMetaRow] = await deps.db
    .select({
      declaredVarsJson: mailTemplates.declaredVarsJson,
      activePublishedVersionId: mailTemplates.activePublishedVersionId,
    })
    .from(mailTemplates)
    .where(eq(mailTemplates.templateKey, config.templateKey))
    .limit(1);

  let declaredVars: readonly MailTemplateVariableSpec[] = tplMetaRow?.declaredVarsJson ?? [];
  if (declaredVars.length === 0) {
    const varNames = published?.vars ?? builtin?.vars ?? [];
    declaredVars = varNames.map((name) => ({ name, label: name, required: true, sampleValue: name }));
  }

  if (tplMetaRow?.activePublishedVersionId) {
    const [ver] = await deps.db
      .select({ state: mailTemplateVersions.state })
      .from(mailTemplateVersions)
      .where(eq(mailTemplateVersions.id, tplMetaRow.activePublishedVersionId))
      .limit(1);
    if (!ver || ver.state !== "published") {
      return {
        outcome: "failed",
        reasonCode: "TEMPLATE_NOT_PUBLISHED",
        retryable: false,
        safeSummary: "Selected mail template is not currently published.",
      };
    }
  }

  if (config.recipientMode === "fixed") {
    const addr = config.fixedAddress?.trim().toLowerCase() ?? "";
    if (!addr || hasControlChar(addr) || !SIMPLE_EMAIL_RE.test(addr)) {
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
        idempotencyKey: `${ctx.idempotencyKey}:mail:fixed`,
      }),
    );
    return {
      outcome: "completed",
      safeSummary: "Queued 1 templated e-mail.",
      safeCounts: { queued_messages: 1 },
    };
  }

  const recipientKey = config.recipientKey ?? "";
  const rawUserIds = await resolveCatalogueUserIds(ctx, recipientKey);
  const uniqueUserIds = [...new Set(rawUserIds.filter((id) => Number.isInteger(id) && id > 0))].slice(0, 50);

  if (uniqueUserIds.length === 0) {
    return {
      outcome: "skipped",
      reasonCode: "NO_RECIPIENTS_RESOLVED",
      safeSummary: "No eligible active recipients resolved for the configured recipient key.",
    };
  }

  const recipientRows = await deps.db
    .select({
      id: users.id,
      publicId: users.publicId,
      status: users.status,
      nameEnc: users.nameEnc,
    })
    .from(users)
    .where(inArray(users.id, uniqueUserIds));

  let queuedCount = 0;
  for (const u of recipientRows) {
    ctx.signal.throwIfAborted();
    if (u.status !== "active" && u.status !== "pending_activation") continue;

    let displayName: string | null = null;
    if (u.nameEnc) {
      try {
        displayName = deps.crypto.decrypt(u.nameEnc, `users.name:${u.publicId}`);
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
        to: { userId: u.id },
        vars,
        idempotencyKey: `${ctx.idempotencyKey}:mail:u:${u.id}`,
      }),
    );
    queuedCount += 1;
  }

  if (queuedCount === 0) {
    return {
      outcome: "skipped",
      reasonCode: "NO_ELIGIBLE_RECIPIENTS",
      safeSummary: "No active recipients matched the step policy.",
    };
  }

  return {
    outcome: "completed",
    safeSummary: `Queued ${queuedCount} templated e-mail(s).`,
    safeCounts: { queued_messages: queuedCount },
  };
}

export const SEND_TEMPLATE_AUTOMATION_ACTION: AutomationActionRegistration<SendTemplateActionConfig> = {
  key: "email.send_template",
  label: "Send e-mail template",
  description: "Queues a published e-mail template through the durable mail outbox using logic-less {{field}} variables.",
  category: "Messaging",
  owner: "mailTemplates",
  forbidOnStaffOnlyTrigger: true,
  configSchema: sendTemplateActionConfigSchema,
  configFields: [
    {
      key: "templateKey",
      label: "E-mail template",
      type: "template_key",
      required: true,
      helpText: "Published custom or system template from the E-mail template centre.",
    },
    {
      key: "recipientMode",
      label: "Recipient source",
      type: "enum",
      required: true,
      enumOptions: [
        { value: "trigger", label: "A role or person from the trigger" },
        { value: "fixed", label: "Fixed operational e-mail address" },
      ],
    },
    {
      key: "recipientKey",
      label: "Trigger or role recipient",
      type: "trigger_recipient",
      required: true,
      helpText: "Used when Recipient source is set to a role or person from the trigger.",
    },
    {
      key: "fixedAddress",
      label: "Fixed operational e-mail",
      type: "email",
      required: true,
      maxLength: 254,
      helpText: "Used when Recipient source is set to Fixed operational e-mail address.",
    },
    {
      key: "subject",
      label: "Fallback subject (generic notice only)",
      type: "string",
      required: false,
      maxLength: 160,
    },
    {
      key: "body",
      label: "Fallback body (generic notice only)",
      type: "textarea",
      required: false,
      maxLength: 4000,
    },
  ],
  retrySafe: true,
  run: runSendTemplateAction,
};

export function registerMailTemplateAutomationAction(): void {
  registerAutomationAction(SEND_TEMPLATE_AUTOMATION_ACTION, { replaceBuiltIn: true });
}

