/** Orders settings declarations (platform settings registry). */
import { z } from "zod";
import { defineSetting } from "../platform/index.js";

export const ORDER_REFERENCE_PREFIX = defineSetting({
  key: "orders.reference.prefix",
  owner: "orders",
  group: "orders",
  label: "Order reference prefix",
  description: "Uppercase prefix for generated order references, e.g. RP-JJG5-ZEUGRE-ICEQUE-001.",
  schema: z.string().regex(/^[A-Z]{2,6}$/),
  default: "RP",
  sensitivity: "internal",
});

export const ORDER_NOTIFY_MAIL = defineSetting({
  key: "orders.notify.mail",
  owner: "orders",
  group: "orders",
  label: "E-mail customers on status changes",
  description: "In-app notifications are always sent; this additionally queues an e-mail when mail delivery is configured.",
  schema: z.boolean(),
  default: false,
  sensitivity: "internal",
});

export const ORDER_INVITE_TTL_DAYS = defineSetting({
  key: "orders.sharing.invite_ttl_days",
  owner: "orders",
  group: "orders",
  label: "Share invitation lifetime (days)",
  description: "Pending share invitations expire after this many days.",
  schema: z.number().int().min(1).max(90),
  default: 14,
  sensitivity: "internal",
});

/**
 * Bundle discount rule (increment 02). Disabled by default; the offerings import (or an admin) sets it.
 * The discount applies when every required packet number is present in the order; it is computed on the
 * server only (round-half-up on minor units of the order subtotal).
 */
export const bundleRuleSchema = z
  .strictObject({
    enabled: z.boolean(),
    requiredPacketNumbers: z.array(z.number().int().min(1).max(255)).max(50),
    discountPercent: z.number().int().min(0).max(100),
    label: z.string().max(120),
  })
  .refine((rule) => new Set(rule.requiredPacketNumbers).size === rule.requiredPacketNumbers.length, { message: "duplicate packet number" })
  .refine((rule) => !rule.enabled || (rule.requiredPacketNumbers.length > 0 && rule.discountPercent > 0 && rule.label.trim().length > 0), {
    message: "an enabled rule needs packets, a percent and a label",
  });

export type BundleRule = z.infer<typeof bundleRuleSchema>;

export const ORDER_BUNDLE_RULE = defineSetting<BundleRule>({
  key: "orders.bundle_rule",
  owner: "orders",
  group: "orders",
  label: "Bundle discount rule",
  description: "Percentage discount applied when an order contains every required packet. Disabled until configured.",
  schema: bundleRuleSchema,
  default: { enabled: false, requiredPacketNumbers: [], discountPercent: 0, label: "" },
  sensitivity: "internal",
});

/** Increment 04 — workflow phases and status requirements. Off by default; the settings registry audits changes. */
export const ORDER_WORKFLOW_RULES_ENABLED = defineSetting({
  key: "orders.workflow_rules.enabled",
  owner: "orders",
  group: "orders",
  label: "Workflow phases and requirements",
  description: "Allows publishing workflows with phases (which lock when an order leaves them), required uploads and acknowledgements. Rules already published are always enforced.",
  schema: z.boolean(),
  default: false,
  sensitivity: "internal",
});

/** Increment 04 — console access grants to other platform users. Off by default. */
export const ORDER_CONSOLE_ACCESS_ENABLED = defineSetting({
  key: "orders.console_access.enabled",
  owner: "orders",
  group: "orders",
  label: "Console access grants",
  description: "Lets administrators with the access-grant capability give another customer account viewer or contributor access to one order or to all of a customer's orders.",
  schema: z.boolean(),
  default: false,
  sensitivity: "internal",
});

/**
 * Increment 05 (A1, ADR 0042) — workflow export and import. Increment 06 (D10): ON by default (the owner asked for
 * it; it cannot lock anyone out). The settings registry audits changes; the Workflows page shows a switch when off.
 */
export const ORDER_WORKFLOW_TRANSFER_ENABLED = defineSetting({
  key: "orders.workflow_transfer.enabled",
  owner: "orders",
  group: "orders",
  label: "Workflow export and import",
  description: "Lets administrators export workflows to a file and import them as drafts. Imports never publish, change the default or touch existing orders.",
  schema: z.boolean(),
  default: true,
  sensitivity: "internal",
});

/**
 * Increment 06 (D14) — order agreement (MNDA) gate: an implicit, account-level acceptance gate on the ADR 0039
 * gateway. OFF by default (lockout-capable). Every field has a default so older or partial stored values parse;
 * a value that still fails parses to the default (off) and never throws. Cannot be enabled without a policy; the
 * update procedure also requires that policy to be published.
 */
export const AGREEMENT_SIGNATURE_MODES = ["typed_name", "checkbox"] as const;
export const agreementGateSchema = z
  .object({
    enabled: z.boolean().default(false),
    policyPublicId: z
      .string()
      .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)
      .nullable()
      .default(null),
    applyTo: z
      .object({ placeOrder: z.boolean().default(true), workOnOrder: z.boolean().default(true) })
      .default({ placeOrder: true, workOnOrder: true }),
    signatureMode: z.enum(AGREEMENT_SIGNATURE_MODES).default("typed_name"),
    askAgainOnNewVersion: z.boolean().default(true),
  })
  .refine((value) => !value.enabled || value.policyPublicId !== null, { message: "choose a published policy first", path: ["policyPublicId"] });

export type AgreementGateSetting = z.output<typeof agreementGateSchema>;
export const AGREEMENT_GATE_DEFAULT: AgreementGateSetting = {
  enabled: false,
  policyPublicId: null,
  applyTo: { placeOrder: true, workOnOrder: true },
  signatureMode: "typed_name",
  askAgainOnNewVersion: true,
};

/**
 * Never throws. Missing, legacy or partial values parse with defaults. A value that still fails is the default
 * (off) — EXCEPT when it says `enabled: true`: then it parses as "enabled, no policy", which the gateway treats as
 * unavailable (fail closed), so a damaged restore cannot silently remove an active agreement.
 */
export function parseAgreementGate(raw: unknown): AgreementGateSetting {
  const parsed = agreementGateSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  const enabled = raw !== null && typeof raw === "object" && !Array.isArray(raw) && (raw as { enabled?: unknown }).enabled === true;
  return { ...AGREEMENT_GATE_DEFAULT, applyTo: { ...AGREEMENT_GATE_DEFAULT.applyTo }, enabled };
}

/** Registry schema: strict values, plus any object claiming `enabled: true` (kept so it fails closed, see above). */
const storedAgreementGateSchema = z.union([agreementGateSchema, z.object({ enabled: z.literal(true) }).passthrough()]);

export const ORDER_AGREEMENT_GATE = defineSetting<AgreementGateSetting>({
  key: "orders.agreement_gate",
  owner: "orders",
  group: "orders",
  label: "Order agreement (MNDA)",
  description: "When on, customers accept the chosen published policy once (again on a new version if set) before placing or working on orders. Staff and API keys are never gated.",
  schema: storedAgreementGateSchema as unknown as z.ZodType<AgreementGateSetting>,
  default: AGREEMENT_GATE_DEFAULT,
  sensitivity: "internal",
  writeCapability: "policies.manage",
  managedBy: { href: "/admin/policies", label: "Order agreement (MNDA) on the Policies page" },
});
