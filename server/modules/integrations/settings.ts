/**
 * Integrations module — Settings, secrets, feature flags and strict identifier/origin validators.
 *
 * Every provider defaults to OFF. Secrets are stored exclusively via `defineSecret` (`FieldCrypto`
 * AES-256-GCM at rest) and are write-only in administrative APIs.
 */
import { z } from "zod";
import type { SettingsStore, Tx } from "../../core/types.js";
import { defineFeatureFlag, defineSecret, defineSetting, type FeatureFlagDefinition } from "../platform/index.js";
import { precheckHost } from "./ipPolicy.js";

/* ----------------------------------------------------- analytics constants & validators */

export const POSTHOG_CLOUD_ORIGINS = ["https://us.i.posthog.com", "https://eu.i.posthog.com"] as const;

/**
 * Exact non-sensitive public routes eligible for consent-gated analytics.
 * Authentication, remediation/recovery, customer data, file, message, invoice and all `/admin` routes
 * are permanently excluded and cannot be enabled from UI or configuration.
 */
export const ALLOWED_ANALYTICS_PATHS = ["/privacy", "/terms"] as const;
export type AllowedAnalyticsPath = (typeof ALLOWED_ANALYTICS_PATHS)[number];

export const PERMANENTLY_EXCLUDED_ANALYTICS_PREFIXES = [
  "/sign-in",
  "/register",
  "/verify-email",
  "/mfa",
  "/reset-password",
  "/recover",
  "/orders",
  "/files",
  "/messages",
  "/tickets",
  "/invoices",
  "/account",
  "/admin",
] as const;

/** Exact vendor HTTPS origins required by Microsoft Clarity when enabled on an eligible public route. */
export const CLARITY_SCRIPT_ORIGINS = ["https://www.clarity.ms"] as const;
export const CLARITY_CONNECT_ORIGINS = [
  "https://www.clarity.ms",
  ...Array.from("abcdefghijklmnopqrstuvwxyz", (letter) => `https://${letter}.clarity.ms`),
  "https://c.bing.com",
] as const;

/** Strict Clarity project ID validator: alphanumeric identifier only, never script/HTML/URLs. */
export const CLARITY_PROJECT_ID_REGEX = /^[A-Za-z0-9]{6,32}$/;

/** Strict PostHog public project API token (`phc_...`), never personal API keys (`phx_...`) or snippets. */
export const POSTHOG_PROJECT_KEY_REGEX = /^phc_[A-Za-z0-9_]{12,176}$/;

export function isValidClarityProjectId(value: unknown): value is string {
  return typeof value === "string" && CLARITY_PROJECT_ID_REGEX.test(value);
}

export function isValidPostHogProjectKey(value: unknown): value is string {
  return typeof value === "string" && POSTHOG_PROJECT_KEY_REGEX.test(value);
}

/**
 * Validates an exact HTTPS origin (`https://host`, default port 443, no path/query/fragment/userinfo,
 * no IPv4/IPv6 literal, no localhost/internal/special-use suffix).
 */
export function isSafeAnalyticsOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 10 || value.length > 253) return false;
  if (/[\s"'<>\\;()]/.test(value)) return false;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname;
    if (parsed.origin !== value) return false;
    if (parsed.protocol !== "https:") return false;
    if (parsed.username !== "" || parsed.password !== "" || parsed.port !== "") return false;
    if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") return false;
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)) {
      return false;
    }
    // Reject all-numeric / IPv4 literals and special-use local domains.
    if (/^\d+(?:\.\d+)*$/.test(host)) return false;
    if (/(?:^|\.)(?:localhost|local|internal|lan|home|corp|test|invalid|onion|example)$/i.test(host)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function isAllowedAnalyticsPathname(pathname: string): pathname is AllowedAnalyticsPath {
  return pathname === "/privacy" || pathname === "/terms";
}

/* ----------------------------------------------------- SMTP header-safe field validators */

const HEADER_CONTROL_CHARS = /[\p{Cc}\u2028\u2029]/u;

export function hasNoHeaderInjection(value: string): boolean {
  return value.length > 0 && !HEADER_CONTROL_CHARS.test(value);
}

export const safeEmailAddressSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .refine(hasNoHeaderInjection, "Control characters are not permitted in email addresses.")
  .refine((val) => /^[^\s@<>,"';:\\]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,63}$/.test(val), "Enter a valid email address.");

export const smtpConfigSettingSchema = z.strictObject({
  host: z.string().trim().max(253),
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .refine((p) => p !== 25, "Plaintext SMTP port 25 is forbidden."),
  tlsMode: z.enum(["starttls", "implicit"]),
  username: z.string().trim().max(254),
  fromAddress: z.string().trim().max(254),
  fromName: z
    .string()
    .trim()
    .max(120)
    .refine((v) => v === "" || hasNoHeaderInjection(v), "Control characters are not permitted."),
  replyToAddress: z.string().trim().max(254),
  passwordLast4: z.string().max(4).nullable().optional(),
});
export type SmtpConfigSetting = z.infer<typeof smtpConfigSettingSchema>;

export const DEFAULT_SMTP_CONFIG: SmtpConfigSetting = {
  host: "",
  port: 587,
  tlsMode: "starttls",
  username: "",
  fromAddress: "",
  fromName: "ReadyPackets Portal",
  replyToAddress: "",
  passwordLast4: null,
};

/* ----------------------------------------------------- Microsoft Graph constants & validators */

export const ENTRA_GUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const FORBIDDEN_MULTI_TENANT_ALIASES = new Set(["common", "organizations", "consumers"]);

export function isValidSingleTenantGuid(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  if (FORBIDDEN_MULTI_TENANT_ALIASES.has(trimmed)) return false;
  return ENTRA_GUID_REGEX.test(trimmed);
}

export function isValidEntraClientGuid(value: string): boolean {
  return ENTRA_GUID_REGEX.test(value.trim());
}

export function extractSecretLast4(secret: string): string {
  const trimmed = secret.trim();
  return trimmed.length <= 4 ? trimmed : trimmed.slice(-4);
}

export const graphConfigSettingSchema = z.strictObject({
  tenantId: z
    .string()
    .trim()
    .max(64)
    .refine(
      (v) => v === "" || isValidSingleTenantGuid(v),
      "Enter a single-tenant Entra directory GUID (multi-tenant aliases common/organizations/consumers are forbidden).",
    ),
  clientId: z
    .string()
    .trim()
    .max(64)
    .refine((v) => v === "" || isValidEntraClientGuid(v), "Enter a valid Entra application (client) GUID."),
  senderMailbox: z
    .string()
    .trim()
    .max(254)
    .refine((v) => v === "" || safeEmailAddressSchema.safeParse(v).success, "Enter a valid mailbox email address."),
  clientSecretLast4: z.string().max(4).nullable().optional(),
  credentialVersion: z.number().int().min(1).optional(),
});
export type GraphConfigSetting = z.infer<typeof graphConfigSettingSchema>;

export const DEFAULT_GRAPH_CONFIG: GraphConfigSetting = {
  tenantId: "",
  clientId: "",
  senderMailbox: "",
  clientSecretLast4: null,
  credentialVersion: 1,
};

/* ----------------------------------------------------- Stripe & SAML setting schemas */

export const stripeConfigSettingSchema = z.strictObject({
  publishableKey: z
    .string()
    .trim()
    .max(200)
    .refine((v) => v === "" || /^pk_(?:test|live)_[A-Za-z0-9]{12,180}$/.test(v), "Invalid Stripe publishable key."),
  webhookToleranceSeconds: z.number().int().min(30).max(900),
});
export type StripeConfigSetting = z.infer<typeof stripeConfigSettingSchema>;

export const DEFAULT_STRIPE_CONFIG: StripeConfigSetting = {
  publishableKey: "",
  webhookToleranceSeconds: 300,
};

export const samlScaffoldSettingSchema = z.strictObject({
  idpEntityId: z.string().trim().max(255),
  idpSsoUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => {
      if (v === "") return true;
      try {
        const u = new URL(v);
        return u.protocol === "https:" && !u.username && !u.password;
      } catch {
        return false;
      }
    }, "IdP SSO URL must be an HTTPS URL without credentials."),
  spEntityId: z.string().trim().max(255),
  nameIdFormat: z.enum([
    "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
    "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  ]),
});
export type SamlScaffoldSetting = z.infer<typeof samlScaffoldSettingSchema>;

export const DEFAULT_SAML_SCAFFOLD: SamlScaffoldSetting = {
  idpEntityId: "",
  idpSsoUrl: "",
  spEntityId: "",
  nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
};

const FORBIDDEN_CUSTOM_WEBHOOK_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "cookie",
  "idempotency-key",
  "x-readypackets-delivery",
  "x-readypackets-redelivery-of",
  "x-readypackets-signature",
  "x-readypackets-timestamp",
  "x-correlation-id",
]);

export function isValidProductionAuthHeaderName(value: string): boolean {
  if (value === "") return true;
  if (!/^[A-Za-z][A-Za-z0-9-]{1,63}$/.test(value)) return false;
  return !FORBIDDEN_CUSTOM_WEBHOOK_HEADERS.has(value.toLowerCase());
}

export function isValidProductionWebhookUrl(value: string): boolean {
  if (!hasNoHeaderInjection(value) || value.length < 10 || value.length > 2048) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return false;
    if (parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") return false;
    const hostCheck = precheckHost(parsed.hostname);
    return hostCheck.ok;
  } catch {
    return false;
  }
}

export const productionConfigSettingSchema = z.strictObject({
  canonVersion: z
    .string()
    .trim()
    .max(64)
    .refine(
      (v) => v === "" || (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(v) && hasNoHeaderInjection(v)),
      "Enter a valid canon version string.",
    )
    .default(""),
  runMode: z
    .string()
    .trim()
    .refine((v) => /^[a-z][a-z0-9_]{0,31}$/.test(v), "Run mode must match ^[a-z][a-z0-9_]{0,31}$.")
    .default("production"),
  timeoutMs: z.number().int().min(1_000).max(30_000).default(10_000),
  authHeaderName: z
    .string()
    .trim()
    .max(64)
    .refine(isValidProductionAuthHeaderName, "Enter a permitted custom HTTP header name.")
    .default(""),
  signingEnabled: z.boolean().default(false),
  signingSecretLast4: z.string().max(4).nullable().default(null),
  previousSigningSecretExpiresAt: z.string().nullable().default(null),
});
export type ProductionConfigSetting = z.infer<typeof productionConfigSettingSchema>;

export const DEFAULT_PRODUCTION_CONFIG: ProductionConfigSetting = {
  canonVersion: "",
  runMode: "production",
  timeoutMs: 10_000,
  authHeaderName: "",
  signingEnabled: false,
  signingSecretLast4: null,
  previousSigningSecretExpiresAt: null,
};

export const productionWorkflowAutoQueueItemSchema = z.strictObject({
  workflowKey: z.string().min(1).max(64).optional(),
  p101OnPaymentConfirmed: z.boolean().default(false),
  p201OnPhase1Locked: z.boolean().default(false),
  updatedAt: z.string().nullable().default(null),
});
export type ProductionWorkflowAutoQueueItem = z.infer<typeof productionWorkflowAutoQueueItemSchema>;

export const productionWorkflowAutoQueueSchema = z.record(
  z.string().min(1).max(64),
  productionWorkflowAutoQueueItemSchema,
);
export type ProductionWorkflowAutoQueueMap = z.infer<typeof productionWorkflowAutoQueueSchema>;

/* ----------------------------------------------------- Platform setting registrations */

const MAIL_MANAGED_BY = { href: "/admin/email-delivery", label: "E-mail delivery" } as const;

export const INTEGRATIONS_SMTP_FLAG = defineFeatureFlag({
  flag: "integrations.smtp",
  owner: "integrations",
  group: "mail",
  label: "Outbound SMTP mail",
  description: "Enable TLS-verified SMTP delivery for queued outbound portal messages.",
});

export const INTEGRATIONS_CLARITY_FLAG = defineFeatureFlag({
  flag: "integrations.clarity",
  owner: "integrations",
  group: "analytics",
  label: "Microsoft Clarity analytics",
  description: "Enable consent-gated Microsoft Clarity tag on allowlisted non-sensitive public routes only.",
});

export const INTEGRATIONS_POSTHOG_FLAG = defineFeatureFlag({
  flag: "integrations.posthog",
  owner: "integrations",
  group: "analytics",
  label: "PostHog analytics",
  description: "Enable consent-gated PostHog events on allowlisted non-sensitive public routes only.",
});

export const INTEGRATIONS_STRIPE_FLAG = defineFeatureFlag({
  flag: "integrations.stripe",
  owner: "integrations",
  group: "integrations",
  label: "Stripe webhook adapter",
  description: "Enable signature-verified Stripe payment webhook ingestion.",
});

export const INTEGRATIONS_SMTP_CONFIG = defineSetting({
  key: "integrations.smtp.config",
  owner: "integrations",
  group: "mail",
  label: "SMTP transport configuration",
  description: "Outbound SMTP host, TLS mode, sender address and username.",
  schema: smtpConfigSettingSchema,
  default: DEFAULT_SMTP_CONFIG,
  sensitivity: "internal",
  managedBy: MAIL_MANAGED_BY,
});

export const INTEGRATIONS_SMTP_PASSWORD = defineSecret({
  key: "integrations.smtp.password",
  owner: "integrations",
  group: "mail",
  label: "SMTP password",
  description: "Encrypted SMTP authentication secret.",
  schema: z.string().min(1).max(1024).refine(hasNoHeaderInjection, "Invalid secret characters."),
  managedBy: MAIL_MANAGED_BY,
});

export const INTEGRATIONS_GRAPH_FLAG = defineFeatureFlag({
  flag: "integrations.graph",
  owner: "integrations",
  group: "mail",
  label: "Microsoft Graph mail & cloud integration",
  description: "Enable single-tenant Microsoft Graph client-credentials integration and outbound Graph mail.",
});

export const INTEGRATIONS_GRAPH_CONFIG = defineSetting({
  key: "integrations.graph.config",
  owner: "integrations",
  group: "mail",
  label: "Microsoft Graph configuration",
  description: "Single-tenant Entra directory ID, application client ID, and optional dedicated sender mailbox.",
  schema: graphConfigSettingSchema,
  default: DEFAULT_GRAPH_CONFIG,
  sensitivity: "internal",
  managedBy: MAIL_MANAGED_BY,
});

export const INTEGRATIONS_GRAPH_CLIENT_SECRET = defineSecret({
  key: "integrations.graph.client_secret",
  owner: "integrations",
  group: "mail",
  label: "Microsoft Graph client secret",
  description: "Encrypted Entra application client secret (write-only).",
  exportable: false,
  schema: z.string().min(1).max(1024).refine(hasNoHeaderInjection, "Invalid client secret characters."),
  managedBy: MAIL_MANAGED_BY,
});

export const INTEGRATIONS_CLARITY_PROJECT_ID = defineSetting({
  key: "integrations.analytics.clarity_project_id",
  owner: "integrations",
  group: "analytics",
  label: "Microsoft Clarity project ID",
  description: "Validated alphanumeric Clarity project identifier (never a raw script snippet).",
  schema: z
    .string()
    .max(32)
    .refine((v) => v === "" || isValidClarityProjectId(v), "Invalid Clarity project ID."),
  default: "",
  sensitivity: "public",
});

export const INTEGRATIONS_POSTHOG_PROJECT_KEY = defineSetting({
  key: "integrations.analytics.posthog_project_key",
  owner: "integrations",
  group: "analytics",
  label: "PostHog project API key",
  description: "Public PostHog project token beginning phc_ (never a personal API key).",
  schema: z
    .string()
    .max(180)
    .refine((v) => v === "" || isValidPostHogProjectKey(v), "Invalid PostHog project key."),
  default: "",
  sensitivity: "public",
});

export const INTEGRATIONS_POSTHOG_HOST = defineSetting({
  key: "integrations.analytics.posthog_host",
  owner: "integrations",
  group: "analytics",
  label: "PostHog ingest origin",
  description: "Exact HTTPS origin for PostHog event delivery.",
  schema: z
    .string()
    .max(253)
    .refine(isSafeAnalyticsOrigin, "PostHog host must be a valid exact HTTPS origin."),
  default: "https://us.i.posthog.com",
  sensitivity: "public",
});

export const INTEGRATIONS_POSTHOG_ALLOWED_ORIGINS = defineSetting({
  key: "integrations.analytics.posthog_allowed_origins",
  owner: "integrations",
  group: "analytics",
  label: "Allowlisted self-hosted PostHog origins",
  description: "Additional administrator-approved HTTPS origins permitted as a PostHog host.",
  schema: z.array(z.string().max(253).refine(isSafeAnalyticsOrigin, "Invalid HTTPS origin.")).max(8),
  default: [] as string[],
  sensitivity: "internal",
});

export const INTEGRATIONS_STRIPE_CONFIG = defineSetting({
  key: "integrations.stripe.config",
  owner: "integrations",
  group: "integrations",
  label: "Stripe adapter settings",
  description: "Non-secret Stripe publishable key and webhook timestamp tolerance.",
  schema: stripeConfigSettingSchema,
  default: DEFAULT_STRIPE_CONFIG,
  sensitivity: "internal",
});

export const INTEGRATIONS_STRIPE_SECRET_KEY = defineSecret({
  key: "integrations.stripe.secret_key",
  owner: "integrations",
  group: "integrations",
  label: "Stripe secret key",
  description: "Encrypted Stripe API secret key (rk_ or sk_).",
  schema: z
    .string()
    .min(12)
    .max(256)
    .refine((v) => /^(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{10,220}$/.test(v), "Invalid Stripe secret key format."),
});

export const INTEGRATIONS_STRIPE_WEBHOOK_SECRET = defineSecret({
  key: "integrations.stripe.webhook_secret",
  owner: "integrations",
  group: "integrations",
  label: "Stripe webhook signing secret",
  description: "Encrypted Stripe webhook endpoint signing secret (whsec_).",
  schema: z
    .string()
    .min(12)
    .max(256)
    .refine((v) => /^whsec_[A-Za-z0-9_]{10,220}$/.test(v), "Invalid Stripe webhook signing secret format."),
});

export const INTEGRATIONS_SAML_SCAFFOLD = defineSetting({
  key: "integrations.saml.scaffold",
  owner: "integrations",
  group: "integrations",
  label: "SAML SSO planning metadata (disabled)",
  description: "Non-active metadata stored for future SAML 2.0 support; SAML sign-in is disabled in this release.",
  schema: samlScaffoldSettingSchema,
  default: DEFAULT_SAML_SCAFFOLD,
  sensitivity: "internal",
});

export const INTEGRATIONS_PRODUCTION_FLAG = defineFeatureFlag({
  flag: "integrations.production",
  owner: "integrations",
  group: "integrations",
  label: "Production webhooks (P101 & P201)",
  description: "Enable operator-triggered outbound P101/P201 production webhook dispatches to allowlisted HTTPS endpoints.",
});

export const INTEGRATIONS_PRODUCTION_CONFIG = defineSetting({
  key: "integrations.production.config",
  owner: "integrations",
  group: "integrations",
  label: "Production webhook parameters",
  description: "Non-secret canon version, run mode, request timeout, and optional custom auth header name.",
  schema: productionConfigSettingSchema,
  default: DEFAULT_PRODUCTION_CONFIG,
  sensitivity: "internal",
});

export const INTEGRATIONS_PRODUCTION_P101_URL = defineSecret({
  key: "integrations.production.p101_url",
  owner: "integrations",
  group: "integrations",
  label: "Phase I (P101) webhook destination URL",
  description: "Encrypted HTTPS webhook destination URL for Phase I (P101) production dispatches.",
  exportable: false,
  schema: z
    .string()
    .trim()
    .min(10)
    .max(2048)
    .refine(isValidProductionWebhookUrl, "P101 URL must be a valid HTTPS URL without embedded credentials."),
});

export const INTEGRATIONS_PRODUCTION_P201_URL = defineSecret({
  key: "integrations.production.p201_url",
  owner: "integrations",
  group: "integrations",
  label: "Phase II (P201) webhook destination URL",
  description: "Encrypted HTTPS webhook destination URL for Phase II (P201) production dispatches.",
  exportable: false,
  schema: z
    .string()
    .trim()
    .min(10)
    .max(2048)
    .refine(isValidProductionWebhookUrl, "P201 URL must be a valid HTTPS URL without embedded credentials."),
});

export const INTEGRATIONS_PRODUCTION_P301_URL = defineSecret({
  key: "integrations.production.p301_url",
  owner: "integrations",
  group: "integrations",
  label: "Phase III (P301) webhook destination URL",
  description: "Optional encrypted HTTPS webhook destination URL for Phase III (P301) production dispatches.",
  exportable: false,
  schema: z
    .string()
    .trim()
    .min(10)
    .max(2048)
    .refine(isValidProductionWebhookUrl, "P301 URL must be a valid HTTPS URL without embedded credentials."),
});

export const INTEGRATIONS_PRODUCTION_P401_URL = defineSecret({
  key: "integrations.production.p401_url",
  owner: "integrations",
  group: "integrations",
  label: "Phase IV (P401) webhook destination URL",
  description: "Optional encrypted HTTPS webhook destination URL for Phase IV (P401) production dispatches.",
  exportable: false,
  schema: z
    .string()
    .trim()
    .min(10)
    .max(2048)
    .refine(isValidProductionWebhookUrl, "P401 URL must be a valid HTTPS URL without embedded credentials."),
});

export const INTEGRATIONS_PRODUCTION_AUTH_VALUE = defineSecret({
  key: "integrations.production.auth_value",
  owner: "integrations",
  group: "integrations",
  label: "Production webhook authentication header value",
  description: "Encrypted shared secret or bearer value sent on P101/P201 requests when an auth header name is configured.",
  exportable: false,
  schema: z.string().min(1).max(1024).refine(hasNoHeaderInjection, "Invalid authentication header characters."),
});

export const INTEGRATIONS_PRODUCTION_SIGNING_SECRET = defineSecret({
  key: "integrations.production.signing_secret",
  owner: "integrations",
  group: "integrations",
  label: "Production webhook HMAC signing secret",
  description: "Optional encrypted HMAC-SHA256 signing secret for outbound P101–P401 production webhook dispatches.",
  exportable: false,
  schema: z.string().min(16).max(256).refine(hasNoHeaderInjection, "Invalid signing secret characters."),
});

export const INTEGRATIONS_PRODUCTION_SIGNING_PREV_SECRET = defineSecret({
  key: "integrations.production.signing_prev_secret",
  owner: "integrations",
  group: "integrations",
  label: "Previous production webhook HMAC signing secret (overlap)",
  description: "Encrypted previous HMAC-SHA256 signing secret retained during overlap rotation.",
  exportable: false,
  schema: z.string().min(16).max(256).refine(hasNoHeaderInjection, "Invalid signing secret characters."),
});

export const INTEGRATIONS_PRODUCTION_WORKFLOW_AUTO_QUEUE = defineSetting({
  key: "integrations.production.workflow_auto_queue",
  owner: "integrations",
  group: "integrations",
  label: "Production webhook lifecycle auto-queue per workflow",
  description: "Per-workflow opt-in flags for automatic P101 on payment confirmation and P201 on intake phase submission lock.",
  schema: productionWorkflowAutoQueueSchema,
  default: {},
  sensitivity: "internal",
});

/* ----------------------------------------------------- Increment 04 Package I: Webhooks settings */

export const webhooksConfigSettingSchema = z.strictObject({
  /** Retention days for encrypted request/response payloads (0..90; 0 omits/purges bodies and disables replay). */
  retentionDays: z.number().int().min(0).max(90),
  /** Consecutive terminal failures before an outbound subscription transitions to `disabled_failing`. */
  autoDisableThreshold: z.number().int().min(3).max(50),
  /** Outbound HTTPS request timeout in milliseconds (1_000..30_000). */
  deliveryTimeoutMs: z.number().int().min(1_000).max(30_000),
});
export type WebhooksConfigSetting = z.infer<typeof webhooksConfigSettingSchema>;

export const DEFAULT_WEBHOOKS_CONFIG: WebhooksConfigSetting = {
  retentionDays: 30,
  autoDisableThreshold: 10,
  deliveryTimeoutMs: 10_000,
};

export const INTEGRATIONS_WEBHOOKS_FLAG = defineFeatureFlag({
  flag: "integrations.webhooks",
  owner: "integrations",
  group: "integrations",
  label: "Outbound webhook subscriptions and inbound endpoints",
  description: "Enable signed outbound webhook subscriptions and inbound automation webhook endpoints.",
});

export const INTEGRATIONS_WEBHOOKS_CONFIG = defineSetting({
  key: "integrations.webhooks.config",
  owner: "integrations",
  group: "integrations",
  label: "Webhooks delivery and retention policy",
  description: "Retention period for redacted encrypted webhook bodies, auto-disable threshold, and request timeout.",
  schema: webhooksConfigSettingSchema,
  default: DEFAULT_WEBHOOKS_CONFIG,
  sensitivity: "internal",
});

/**
 * Reads a declared feature flag consistently across both `PlatformSettingsStore` (which stores
 * `feature.<flag>` in `platform_settings`) and `MemorySettings` test doubles (which may populate
 * either `values.set("feature.<flag>", bool)` or `flags.add("<flag>")`).
 */
export async function readIntegrationFlag(
  settings: SettingsStore,
  def: FeatureFlagDefinition,
  tx?: Tx,
): Promise<boolean> {
  const storedViaKey = await settings.get<boolean | undefined>(
    def.key,
    (raw) => (typeof raw === "boolean" ? raw : undefined),
    undefined,
    tx,
  );
  if (typeof storedViaKey === "boolean") {
    return storedViaKey;
  }
  return settings.isFeatureEnabled(def.flag, tx);
}

