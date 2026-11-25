import type { Mailer, MailTemplate } from "../../core/types.js";
import { escapeHtmlText } from "./sanitizer.js";
import type { MailTemplateCategory, MailTemplateVariableSpec } from "./schema.js";

export interface SystemMailTemplateMetadata {
  templateKey: string;
  name: string;
  description: string;
  category: MailTemplateCategory;
  declaredVars: MailTemplateVariableSpec[];
  defaultSubject: string;
  defaultBodyText: string;
  defaultBodyHtml: string;
}

interface CatalogueSeed {
  name: string;
  description: string;
  category: MailTemplateCategory;
  requiredVars?: readonly string[];
  varLabels?: Readonly<Record<string, string>>;
  sampleValues?: Readonly<Record<string, string>>;
  subjectTemplate?: string;
  textTemplate?: string;
  htmlTemplate?: string;
}

const DEFAULT_VAR_LABELS: Readonly<Record<string, { label: string; sample: string }>> = {
  name: { label: "Recipient display name", sample: "Alex Rivera" },
  recipient_name: { label: "Recipient display name", sample: "Alex Rivera" },
  link: { label: "Action or portal URL", sample: "https://portal.readypackets.example/orders/01J9EXAMPLE00000000000000" },
  signInLink: { label: "Sign-in URL", sample: "https://portal.readypackets.example/sign-in" },
  resetLink: { label: "Password reset URL", sample: "https://portal.readypackets.example/forgot-password" },
  reference: { label: "Order reference", sample: "RP-2026-0142" },
  orderReference: { label: "Order reference", sample: "RP-2026-0142" },
  statusLabel: { label: "Order status", sample: "In review" },
  questionnaireTitle: { label: "Questionnaire title", sample: "Entity Onboarding Questionnaire" },
  portalPath: { label: "Portal path", sample: "/orders/01J9EXAMPLE00000000000000" },
  invoiceNumber: { label: "Invoice number", sample: "INV-2026-0088" },
  ticketNumber: { label: "Support ticket number", sample: "TKT-2026-0031" },
  eventLabel: { label: "Ticket update summary", sample: "Staff reply posted" },
  title: { label: "Notification title", sample: "Deliverable ready for review" },
  windowLabel: { label: "Maintenance window", sample: "Sunday 02:00–03:00 UTC" },
  summary: { label: "Maintenance summary", sample: "Scheduled database and security maintenance" },
};

const KNOWN_SYSTEM_SEEDS: Readonly<Record<string, CatalogueSeed>> = {
  "auth.verify_email": {
    name: "Registration & e-mail verification",
    description: "Sent when a new account registers and must confirm control of its e-mail address.",
    category: "auth",
    requiredVars: ["link"],
    subjectTemplate: "Confirm your ReadyPackets e-mail address",
    textTemplate:
      "Hello {{name}},\n\nConfirm your e-mail address to finish setting up your ReadyPackets account:\n\n{{link}}\n\nThis link works once and expires in 24 hours.\n\nIf you did not expect this message, you can ignore it. ReadyPackets will never ask for your password by e-mail.",
    htmlTemplate:
      '<p>Hello {{name}},</p><p>Confirm your e-mail address to finish setting up your ReadyPackets account:</p><p><a href="{{link}}" data-rp-button="primary" rel="noopener noreferrer">Confirm e-mail address</a></p><p>This link works once and expires in 24 hours.</p><p>If you did not expect this message, you can ignore it. ReadyPackets will never ask for your password by e-mail.</p>',
  },
  "auth.account_exists": {
    name: "Existing account registration notice",
    description: "Sent privately when someone attempts registration with an already-registered e-mail address.",
    category: "auth",
    requiredVars: ["signInLink", "resetLink"],
    subjectTemplate: "Someone tried to create a ReadyPackets account with your e-mail",
    textTemplate:
      "An account already exists for this e-mail address. Sign in here:\n\n{{signInLink}}\n\nForgot your password? Reset it here:\n\n{{resetLink}}\n\nIf you did not expect this message, you can ignore it. ReadyPackets will never ask for your password by e-mail.",
    htmlTemplate:
      '<p>An account already exists for this e-mail address.</p><p><a href="{{signInLink}}" data-rp-button="primary" rel="noopener noreferrer">Sign in to ReadyPackets</a></p><p>Forgot your password? <a href="{{resetLink}}" rel="noopener noreferrer">Reset your password</a>.</p><p>If you did not expect this message, you can ignore it. ReadyPackets will never ask for your password by e-mail.</p>',
  },
  "auth.password_reset": {
    name: "Password reset",
    description: "Delivers a single-use 30-minute password reset link.",
    category: "auth",
    requiredVars: ["link"],
    subjectTemplate: "Reset your ReadyPackets password",
    textTemplate:
      "Use this link to choose a new password:\n\n{{link}}\n\nThis link works once and expires in 30 minutes. All signed-in sessions will be signed out.\n\nIf you did not expect this message, you can ignore it. ReadyPackets will never ask for your password by e-mail.",
    htmlTemplate:
      '<p>Use this link to choose a new password:</p><p><a href="{{link}}" data-rp-button="primary" rel="noopener noreferrer">Reset password</a></p><p>This link works once and expires in 30 minutes. All signed-in sessions will be signed out.</p><p>If you did not expect this message, you can ignore it. ReadyPackets will never ask for your password by e-mail.</p>',
  },
  "auth.invitation": {
    name: "Account invitation & activation",
    description: "Invites a user to activate their ReadyPackets portal account and enrol two-step verification.",
    category: "auth",
    requiredVars: ["link"],
    subjectTemplate: "You have been invited to ReadyPackets",
    textTemplate:
      "Hello {{name}},\n\nAn account has been created for you on the ReadyPackets portal. Activate it and choose your password here:\n\n{{link}}\n\nThis link works once and expires in 72 hours. You will set up two-step verification after activation.\n\nIf you did not expect this message, you can ignore it. ReadyPackets will never ask for your password by e-mail.",
    htmlTemplate:
      '<p>Hello {{name}},</p><p>An account has been created for you on the ReadyPackets portal. Activate it and choose your password below:</p><p><a href="{{link}}" data-rp-button="primary" rel="noopener noreferrer">Activate account</a></p><p>This link works once and expires in 72 hours. You will set up two-step verification after activation.</p><p>If you did not expect this message, you can ignore it. ReadyPackets will never ask for your password by e-mail.</p>',
  },
  "auth.admin_set_password": {
    name: "Administrator-initiated password reset",
    description: "Sent when an administrator resets a user's password and issues a one-time setup link.",
    category: "auth",
    requiredVars: ["link"],
    subjectTemplate: "Set a new ReadyPackets password",
    textTemplate:
      "An administrator has reset your password. Choose a new password here:\n\n{{link}}\n\nThis link works once and expires in 24 hours. Your previous password no longer works.\n\nIf you did not expect this message, you can ignore it. ReadyPackets will never ask for your password by e-mail.",
    htmlTemplate:
      '<p>An administrator has reset your password. Choose a new password below:</p><p><a href="{{link}}" data-rp-button="primary" rel="noopener noreferrer">Choose new password</a></p><p>This link works once and expires in 24 hours. Your previous password no longer works.</p>',
  },
  "auth.password_changed": {
    name: "Password changed confirmation",
    description: "Security confirmation sent immediately after an account password is changed.",
    category: "auth",
    requiredVars: [],
    subjectTemplate: "Your ReadyPackets password was changed",
    textTemplate:
      "The password for your ReadyPackets account was just changed and other sessions were signed out. If this was not you, reset your password immediately and contact support.\n\nIf you did not expect this message, you can ignore it. ReadyPackets will never ask for your password by e-mail.",
    htmlTemplate:
      "<p>The password for your ReadyPackets account was just changed and other sessions were signed out.</p><p><strong>If this was not you, reset your password immediately and contact support.</strong></p>",
  },
  "orders.confirmed": {
    name: "Order confirmation",
    description: "Confirms that a new order has been placed and provides a portal link.",
    category: "orders",
    requiredVars: ["reference", "link"],
    subjectTemplate: "Order {{reference}} received",
    textTemplate:
      "Thank you. Your ReadyPackets order {{reference}} has been received.\n\nSign in to track progress and complete any intake items: {{link}}",
    htmlTemplate:
      '<p>Thank you. Your ReadyPackets order <strong>{{reference}}</strong> has been received.</p><p><a href="{{link}}" data-rp-button="primary" rel="noopener noreferrer">View order</a></p>',
  },
  "orders.phase_update": {
    name: "Order phase update",
    description: "A neutral notification for the customer to sign in and review their order.",
    category: "orders",
    requiredVars: ["reference", "link"],
    subjectTemplate: "An update to your ReadyPackets order",
    textTemplate: "There is an update to order {{reference}}.\n\nSign in to review your order:\n{{link}}",
    htmlTemplate: '<p>There is an update to order <strong>{{reference}}</strong>.</p><p><a href="{{link}}" data-rp-button="primary" rel="noopener noreferrer">Review your order</a></p>',
  },
  "orders.status_changed": {
    name: "Order status change",
    description: "Notifies an order owner when their order moves to a new customer-visible workflow status.",
    category: "orders",
    requiredVars: ["reference", "statusLabel", "link"],
    subjectTemplate: "Order {{reference}}: {{statusLabel}}",
    textTemplate:
      'The status of your ReadyPackets order {{reference}} is now "{{statusLabel}}".\n\nSign in to view the details: {{link}}\n\nYou are receiving this message because you own or have access to this order.',
    htmlTemplate:
      '<p>The status of your ReadyPackets order <strong>{{reference}}</strong> is now <strong>{{statusLabel}}</strong>.</p><p><a href="{{link}}" data-rp-button="primary" rel="noopener noreferrer">View order details</a></p><p>You are receiving this message because you own or have access to this order.</p>',
  },
  "orders.share_invited": {
    name: "Order share invitation",
    description: "Sent when an order owner shares access to an order with another user.",
    category: "orders",
    requiredVars: ["reference", "link"],
    subjectTemplate: "You have been invited to order {{reference}}",
    textTemplate:
      "A ReadyPackets customer has shared order {{reference}} with you.\n\nSign in with this e-mail address to accept or decline: {{link}}\n\nIf you were not expecting this invitation you can ignore this message.",
    htmlTemplate:
      '<p>A ReadyPackets customer has shared order <strong>{{reference}}</strong> with you.</p><p><a href="{{link}}" data-rp-button="primary" rel="noopener noreferrer">Review shared order</a></p><p>If you were not expecting this invitation you can ignore this message.</p>',
  },
  "compliance.intake_returned": {
    name: "Intake questionnaire returned for updates",
    description: "Alerts an order owner when staff request updates on an intake questionnaire.",
    category: "compliance",
    requiredVars: ["orderReference", "questionnaireTitle", "portalPath"],
    subjectTemplate: "Action needed: {{questionnaireTitle}} for order {{orderReference}}",
    textTemplate:
      'Your intake submission "{{questionnaireTitle}}" for order {{orderReference}} was returned for updates.\n\nSign in to review staff feedback and submit an updated response: {{portalPath}}\n\nYou are receiving this message because you own or manage this order.',
    htmlTemplate:
      '<p>Your intake submission <strong>{{questionnaireTitle}}</strong> for order <strong>{{orderReference}}</strong> was returned for updates.</p><p><a href="{{portalPath}}" data-rp-button="primary" rel="noopener noreferrer">Review intake feedback</a></p>',
  },
  "compliance.invoice_issued": {
    name: "Invoice issued",
    description: "Notifies an order owner when an invoice is issued and ready in the portal.",
    category: "compliance",
    requiredVars: ["invoiceNumber", "orderReference", "portalPath"],
    subjectTemplate: "Invoice {{invoiceNumber}} issued for order {{orderReference}}",
    textTemplate:
      "Invoice {{invoiceNumber}} has been issued for your ReadyPackets order {{orderReference}}.\n\nSign in to view or download your invoice PDF: {{portalPath}}\n\nYou are receiving this message because you own this order.",
    htmlTemplate:
      '<p>Invoice <strong>{{invoiceNumber}}</strong> has been issued for your ReadyPackets order <strong>{{orderReference}}</strong>.</p><p><a href="{{portalPath}}" data-rp-button="primary" rel="noopener noreferrer">View invoice</a></p>',
  },
  "compliance.invoice_paid": {
    name: "Invoice receipt (payment recorded)",
    description: "Confirms that payment has been recorded against an invoice.",
    category: "compliance",
    requiredVars: ["invoiceNumber", "orderReference", "portalPath"],
    subjectTemplate: "Payment recorded for invoice {{invoiceNumber}}",
    textTemplate:
      "Payment has been recorded in full for invoice {{invoiceNumber}} (order {{orderReference}}).\n\nSign in to download your updated receipt/invoice PDF: {{portalPath}}",
    htmlTemplate:
      '<p>Payment has been recorded in full for invoice <strong>{{invoiceNumber}}</strong> (order <strong>{{orderReference}}</strong>).</p><p><a href="{{portalPath}}" data-rp-button="primary" rel="noopener noreferrer">Download receipt</a></p>',
  },
  "engagement.order_message_received": {
    name: "Order message notification",
    description: "Alerts a participant that a new message was posted on an order without exposing message text.",
    category: "engagement",
    requiredVars: ["orderReference", "link"],
    subjectTemplate: "You have a new message on order {{orderReference}}",
    textTemplate:
      "You have a new message regarding ReadyPackets order {{orderReference}}.\n\nFor your privacy and security, message content is never included in e-mail notifications.\nSign in to your portal to read and reply: {{link}}",
    htmlTemplate:
      '<p>You have a new message regarding ReadyPackets order <strong>{{orderReference}}</strong>.</p><p>For your privacy and security, message content is never included in e-mail notifications.</p><p><a href="{{link}}" data-rp-button="primary" rel="noopener noreferrer">Read and reply in portal</a></p>',
  },
  "engagement.ticket_updated": {
    name: "Support ticket reply / update",
    description: "Notifies a user of a reply or status change on a support ticket without leaking ticket content.",
    category: "engagement",
    requiredVars: ["ticketNumber", "eventLabel", "link"],
    subjectTemplate: "Support ticket {{ticketNumber}}: {{eventLabel}}",
    textTemplate:
      "There is a new update ({{eventLabel}}) on ReadyPackets support ticket {{ticketNumber}}.\n\nFor your privacy and security, ticket content is never included in e-mail notifications.\nSign in to your portal to view the update: {{link}}",
    htmlTemplate:
      '<p>There is a new update (<strong>{{eventLabel}}</strong>) on ReadyPackets support ticket <strong>{{ticketNumber}}</strong>.</p><p>For your privacy and security, ticket content is never included in e-mail notifications.</p><p><a href="{{link}}" data-rp-button="primary" rel="noopener noreferrer">View support ticket</a></p>',
  },
  "engagement.notification": {
    name: "General portal notification",
    description: "Generic notification e-mail paired with in-app portal alerts.",
    category: "engagement",
    requiredVars: ["title", "link"],
    subjectTemplate: "ReadyPackets notification: {{title}}",
    textTemplate: "{{title}}\n\nSign in to your ReadyPackets portal for details: {{link}}",
    htmlTemplate:
      '<p><strong>{{title}}</strong></p><p><a href="{{link}}" data-rp-button="primary" rel="noopener noreferrer">Open portal</a></p>',
  },
  "platform.maintenance_window": {
    name: "Maintenance window notice",
    description: "Operational notice informing recipients of an upcoming or active maintenance window.",
    category: "operations",
    requiredVars: ["windowLabel", "summary"],
    subjectTemplate: "Scheduled maintenance: {{windowLabel}}",
    textTemplate:
      "ReadyPackets scheduled maintenance window: {{windowLabel}}.\n\nSummary: {{summary}}\n\nPortal link: {{link}}",
    htmlTemplate:
      "<p>ReadyPackets scheduled maintenance window: <strong>{{windowLabel}}</strong>.</p><p>{{summary}}</p><p>Visit <a href=\"{{link}}\" rel=\"noopener noreferrer\">your portal</a> for status updates.</p>",
  },
};

/**
 * Registers shipped system templates (`orders.confirmed`, `platform.maintenance_window`) that do
 * not belong to an earlier module's direct call site so every shipped template in Contract §2.D
 * is backed by a real `mailer.registerTemplate(...)` definition.
 */
export function registerAdditionalShippedMailTemplates(mailer: Mailer, existingKeys: ReadonlySet<string>): void {
  if (!existingKeys.has("orders.confirmed")) {
    mailer.registerTemplate({
      key: "orders.confirmed",
      vars: ["reference", "link"],
      subject: (v) => `Order ${String(v.reference ?? "")} received`,
      text: (v) =>
        [
          `Thank you. Your ReadyPackets order ${String(v.reference ?? "")} has been received.`,
          "",
          `Sign in to track progress and complete any intake items: ${String(v.link ?? "")}`,
        ].join("\n"),
    });
  }
  if (!existingKeys.has("platform.maintenance_window")) {
    mailer.registerTemplate({
      key: "platform.maintenance_window",
      vars: ["windowLabel", "summary", "link"],
      subject: (v) => `Scheduled maintenance: ${String(v.windowLabel ?? "")}`,
      text: (v) =>
        [
          `ReadyPackets scheduled maintenance window: ${String(v.windowLabel ?? "")}.`,
          "",
          `Summary: ${String(v.summary ?? "")}`,
          "",
          `Portal link: ${String(v.link ?? "")}`,
        ].join("\n"),
    });
  }
}

function inferCategory(key: string): MailTemplateCategory {
  if (key.startsWith("auth.")) return "auth";
  if (key.startsWith("orders.")) return "orders";
  if (key.startsWith("compliance.")) return "compliance";
  if (key.startsWith("engagement.")) return "engagement";
  return "operations";
}

function humanizeKey(key: string): string {
  const tail = key.includes(".") ? key.split(".").slice(1).join(" ") : key;
  return tail
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function buildSystemTemplateMetadata(builtin: MailTemplate): SystemMailTemplateMetadata {
  const seed = KNOWN_SYSTEM_SEEDS[builtin.key];
  const sensitiveSet = new Set(builtin.sensitiveVars ?? []);
  const requiredSet = new Set<string>([
    ...sensitiveSet,
    ...(seed?.requiredVars ?? builtin.vars),
  ]);

  const declaredVars: MailTemplateVariableSpec[] = builtin.vars.map((varName) => {
    const known = DEFAULT_VAR_LABELS[varName];
    return {
      name: varName,
      label: seed?.varLabels?.[varName] ?? known?.label ?? humanizeKey(varName),
      required: requiredSet.has(varName) && builtin.vars.includes(varName),
      ...(sensitiveSet.has(varName) ? { sensitive: true } : {}),
      sampleValue:
        seed?.sampleValues?.[varName] ??
        known?.sample ??
        (varName.toLowerCase().includes("link")
          ? "https://portal.readypackets.example"
          : `Sample ${varName}`),
    };
  });

  // Synthesize placeholder map (`{{var}}`) for any dynamically-registered built-in template not in KNOWN_SYSTEM_SEEDS
  const placeholderVars: Record<string, string> = {};
  for (const v of builtin.vars) {
    placeholderVars[v] = `{{${v}}}`;
  }

  const defaultSubject = seed?.subjectTemplate ?? builtin.subject(placeholderVars);
  const defaultBodyText = seed?.textTemplate ?? builtin.text(placeholderVars);
  const defaultBodyHtml =
    seed?.htmlTemplate ??
    defaultBodyText
      .split(/\n{2,}/)
      .map((para) => `<p>${escapeHtmlText(para).replace(/\n/g, "<br>")}</p>`)
      .join("");

  return {
    templateKey: builtin.key,
    name: seed?.name ?? humanizeKey(builtin.key),
    description: seed?.description ?? `Built-in system template (${builtin.key}).`,
    category: seed?.category ?? inferCategory(builtin.key),
    declaredVars,
    defaultSubject,
    defaultBodyText,
    defaultBodyHtml,
  };
}
