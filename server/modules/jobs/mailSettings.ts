import { z } from "zod";
import { defineSetting } from "../platform/settingsRegistry.js";

export const HEADER_CONTROL = /[\p{Cc}\u2028\u2029]/u;
export const mailAddress = z.email().max(254).refine((value) => !HEADER_CONTROL.test(value));
const optionalAddress = z.union([mailAddress, z.literal("")]);
const transportKey = z.enum(["smtp", "graph"]);
const mailSetting = {
  owner: "jobs",
  group: "mail",
  exportable: false,
  writeCapability: "mail.manage",
  managedBy: { href: "/admin/email-delivery", label: "E-mail delivery" },
} as const;

export const MAIL_SENDER = defineSetting({
  ...mailSetting, key: "jobs.mail.sender", label: "Sender identity",
  description: "The address, display name and reply-to used by all transports. Blank sender uses the existing SMTP identity.",
  schema: z.strictObject({
    fromAddress: optionalAddress,
    fromName: z.string().max(120).refine((value) => !HEADER_CONTROL.test(value)),
    replyToAddress: optionalAddress,
  }),
  default: { fromAddress: "", fromName: "", replyToAddress: "" },
});

const routing = z.strictObject({ primary: transportKey, secondary: z.enum(["none", "smtp", "graph"]) })
  .refine(({ primary, secondary }) => primary !== secondary, { path: ["secondary"], message: "Choose a different secondary transport." });
export const MAIL_ROUTING = defineSetting<z.infer<typeof routing>>({
  ...mailSetting, key: "jobs.mail.routing", label: "Transport order",
  description: "Secondary is used only when the primary definitely did not accept the message.",
  schema: routing,
  default: { primary: "smtp", secondary: "none" },
});

export const MAIL_AUDIT_COPY = defineSetting({
  ...mailSetting, key: "jobs.mail.audit_copy", label: "Redacted audit copy",
  description: "Send a separately rendered redacted copy only after confirming control of this mailbox.",
  schema: z.strictObject({ enabled: z.boolean(), address: optionalAddress })
    .refine(({ enabled, address }) => !enabled || !!address, { path: ["address"], message: "Enter an audit mailbox." }),
  default: { enabled: false, address: "" },
});

export const MAIL_RETAIN_CONTENT = defineSetting({
  ...mailSetting, key: "jobs.mail.retain_content", label: "Retain redacted mail content",
  description: "Keep encrypted, redacted message content for authorized administrators. Off by default.",
  schema: z.boolean(),
  default: false,
});

export const MAIL_RETENTION_DAYS = defineSetting({
  ...mailSetting, key: "jobs.mail.retention_days", label: "Content retention (days)",
  description: "Retention for newly rendered mail. Zero hides and purges retained content.",
  schema: z.number().int().min(0).max(90),
  default: 30,
});
