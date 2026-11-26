/**
 * Payments module — Settings & write-only secrets (Increment 04, Package K).
 *
 * Defaults to `provider: "none"` (Pay by invoice). All secrets use `defineSecret` with
 * `exportable: false` (AES-256-GCM encrypted at rest via `FieldCrypto`, never exported).
 */
import { z } from "zod";
import { defineSecret, defineSetting } from "../platform/index.js";
import {
  ACTIVE_PAYMENT_PROVIDERS,
  type ActivePaymentProvider,
  PAYMENT_ENVIRONMENT_MODES,
  type PaymentEnvironmentMode,
  PAYMENT_PROVIDER_CHOICES,
} from "./schema.js";

const SAFE_PORTAL_RETURN_PATH_REGEX = /^\/(?:checkout|invoices|orders)(?:\/[A-Za-z0-9_-]{1,64}){0,4}$/u;

export function isSafePortalReturnPath(value: string): boolean {
  if (!SAFE_PORTAL_RETURN_PATH_REGEX.test(value)) return false;
  if (value.includes("//") || value.includes("..") || value.includes("\\")) return false;
  return true;
}

export const paymentsConfigSchema = z.object({
  provider: z.enum(PAYMENT_PROVIDER_CHOICES),
  mode: z.enum(PAYMENT_ENVIRONMENT_MODES),
  currency: z.string().regex(/^[A-Z]{3}$/u),
  successPath: z.string().min(1).max(200).refine(isSafePortalReturnPath, "Invalid internal success path."),
  cancelPath: z.string().min(1).max(200).refine(isSafePortalReturnPath, "Invalid internal cancel path."),
  webhookToleranceSeconds: z.number().int().min(30).max(300),
  stripeSecretKeyLast4: z.string().max(8).nullable(),
  stripeWebhookSecretLast4: z.string().max(8).nullable(),
  stripeWebhookSecretSecondaryLast4: z.string().max(8).nullable().default(null),
  stripeLastApiVerifiedAt: z.string().max(64).nullable().default(null),
  stripeApiVerifiedFingerprint: z.string().max(64).nullable().default(null),
  stripeLastSelfTestAt: z.string().max(64).nullable().default(null),
  stripeSelfTestedFingerprint: z.string().max(64).nullable().default(null),
  squareLocationId: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/u).nullable(),
  squareAccessTokenLast4: z.string().max(8).nullable(),
  squareWebhookSignatureKeyLast4: z.string().max(8).nullable(),
});

export type PaymentsConfigValue = z.infer<typeof paymentsConfigSchema>;

export function parsePaymentsConfigSetting(raw: unknown): PaymentsConfigValue {
  const parsed = paymentsConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : PAYMENTS_CONFIG_SETTING.default;
}

export const PAYMENTS_CONFIG_SETTING = defineSetting({
  key: "payments.config",
  owner: "payments",
  group: "compliance",
  label: "Hosted online checkout configuration",
  description: "Active hosted payment provider (none, Stripe Checkout, or Square Payment Links) and non-secret parameters.",
  schema: paymentsConfigSchema,
  default: {
    provider: "none",
    mode: "test",
    currency: "USD",
    successPath: "/invoices",
    cancelPath: "/invoices",
    webhookToleranceSeconds: 300,
    stripeSecretKeyLast4: null,
    stripeWebhookSecretLast4: null,
    stripeWebhookSecretSecondaryLast4: null,
    stripeLastApiVerifiedAt: null,
    stripeApiVerifiedFingerprint: null,
    stripeLastSelfTestAt: null,
    stripeSelfTestedFingerprint: null,
    squareLocationId: null,
    squareAccessTokenLast4: null,
    squareWebhookSignatureKeyLast4: null,
  },
  sensitivity: "internal",
  exportable: false,
  writeCapability: "payments.manage",
  managedBy: { label: "Payments", href: "/admin/payments" },
});

export const PAYMENTS_STRIPE_SECRET_KEY = defineSecret({
  key: "payments.stripe.secret_key",
  owner: "payments",
  group: "compliance",
  label: "Stripe secret API key",
  description: "Restricted Stripe secret key (`sk_test_...` or `sk_live_...`) for Checkout Session creation and verification.",
  schema: z.string().regex(/^(?:sk|rk)_(?:test|live)_[A-Za-z0-9_]{10,200}$/u),
  exportable: false,
  writeCapability: "payments.manage",
  managedBy: { label: "Payments", href: "/admin/payments" },
});

export const PAYMENTS_STRIPE_WEBHOOK_SECRET = defineSecret({
  key: "payments.stripe.webhook_secret",
  owner: "payments",
  group: "compliance",
  label: "Stripe webhook signing secret",
  description: "Stripe endpoint signing secret (`whsec_...`) for `/api/payments/webhooks/stripe`.",
  schema: z.string().regex(/^whsec_[A-Za-z0-9_]{12,200}$/u),
  exportable: false,
  writeCapability: "payments.manage",
  managedBy: { label: "Payments", href: "/admin/payments" },
});

export const PAYMENTS_STRIPE_WEBHOOK_SECRET_SECONDARY = defineSecret({
  key: "payments.stripe.webhook_secret_secondary",
  owner: "payments",
  group: "compliance",
  label: "Stripe secondary webhook signing secret",
  description:
    "Optional secondary Stripe signing secret (`whsec_...`) accepted during zero-downtime key rotation or Stripe CLI local webhook testing.",
  schema: z.string().regex(/^whsec_[A-Za-z0-9_]{12,200}$/u),
  exportable: false,
  writeCapability: "payments.manage",
  managedBy: { label: "Payments", href: "/admin/payments/setup" },
});

export const PAYMENTS_SQUARE_ACCESS_TOKEN = defineSecret({
  key: "payments.square.access_token",
  owner: "payments",
  group: "compliance",
  label: "Square access token",
  description: "Square sandbox or production access token for Payment Link creation and payment verification.",
  schema: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/u),
  exportable: false,
  writeCapability: "payments.manage",
  managedBy: { label: "Payments", href: "/admin/payments" },
});

export const PAYMENTS_SQUARE_WEBHOOK_SIGNATURE_KEY = defineSecret({
  key: "payments.square.webhook_signature_key",
  owner: "payments",
  group: "compliance",
  label: "Square webhook signature key",
  description: "Square webhook signature key for `/api/payments/webhooks/square`.",
  schema: z.string().min(12).max(256).refine((s) => !/\s/u.test(s), "Webhook signature key cannot contain whitespace."),
  exportable: false,
  writeCapability: "payments.manage",
  managedBy: { label: "Payments", href: "/admin/payments" },
});

export function maskLast4(secret: string): string {
  const trimmed = secret.trim();
  return trimmed.length >= 4 ? trimmed.slice(-4) : "****";
}

/* ------------------------------------------- Increment 06 D5: small_totals */

export const SMALL_TOTAL_BEHAVIORS = ["waive", "block"] as const;
export type SmallTotalBehavior = (typeof SMALL_TOTAL_BEHAVIORS)[number];

/**
 * Default minimum card charge in integer minor units per provider and ISO 4217 currency.
 * Stripe refuses card charges below 0.50 USD (or currency equivalent); Square refuses below 1.00 USD.
 */
export const DEFAULT_PROVIDER_MINIMUMS_MINOR: Readonly<
  Record<ActivePaymentProvider, Readonly<Record<string, number>>>
> = {
  stripe: {
    USD: 50,
    EUR: 50,
    GBP: 30,
    CAD: 50,
    AUD: 50,
    NZD: 50,
    SGD: 50,
    CHF: 50,
    SEK: 300,
    NOK: 300,
    DKK: 250,
    PLN: 200,
    MXN: 1000,
    BRL: 50,
    HKD: 400,
    JPY: 50,
  },
  square: {
    USD: 100,
    CAD: 100,
    GBP: 100,
    EUR: 100,
    AUD: 100,
    JPY: 100,
  },
};

const currencyMinMapSchema = z.record(
  z.string().regex(/^[A-Z]{3}$/u),
  z.number().int().min(1).max(100_000),
);

export const paymentsSmallTotalsSchema = z.strictObject({
  belowProviderMinimum: z.enum(SMALL_TOTAL_BEHAVIORS).default("waive"),
  minimumOverrides: z
    .strictObject({
      stripe: currencyMinMapSchema.optional(),
      square: currencyMinMapSchema.optional(),
    })
    .optional(),
});

export type PaymentsSmallTotalsValue = z.infer<typeof paymentsSmallTotalsSchema>;

export const DEFAULT_PAYMENTS_SMALL_TOTALS: PaymentsSmallTotalsValue = {
  belowProviderMinimum: "waive",
};

/** Backwards-compatible parser for `payments.small_totals` — never throws on legacy/partial stored values. */
export function parsePaymentsSmallTotals(raw: unknown): PaymentsSmallTotalsValue {
  if (typeof raw === "string" && (SMALL_TOTAL_BEHAVIORS as readonly string[]).includes(raw)) {
    return { belowProviderMinimum: raw as SmallTotalBehavior };
  }
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_PAYMENTS_SMALL_TOTALS };
  }
  const rec = raw as Record<string, unknown>;
  const belowProviderMinimum: SmallTotalBehavior =
    rec.belowProviderMinimum === "block" ? "block" : "waive";

  const rawOverrides =
    rec.minimumOverrides && typeof rec.minimumOverrides === "object"
      ? (rec.minimumOverrides as Record<string, unknown>)
      : null;

  const cleanMap = (val: unknown): Record<string, number> | undefined => {
    if (!val || typeof val !== "object") return undefined;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      const code = k.trim().toUpperCase();
      if (/^[A-Z]{3}$/u.test(code) && typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= 100_000) {
        out[code] = v;
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };

  if (rawOverrides) {
    const stripeMap = cleanMap(rawOverrides.stripe);
    const squareMap = cleanMap(rawOverrides.square);
    if (stripeMap || squareMap) {
      return {
        belowProviderMinimum,
        minimumOverrides: {
          ...(stripeMap ? { stripe: stripeMap } : {}),
          ...(squareMap ? { square: squareMap } : {}),
        },
      };
    }
  }

  return { belowProviderMinimum };
}

export function resolveProviderMinimumMinor(
  provider: ActivePaymentProvider,
  currency: string,
  setting: PaymentsSmallTotalsValue,
): number {
  const code = currency.trim().toUpperCase();
  const override = setting.minimumOverrides?.[provider]?.[code];
  if (typeof override === "number" && Number.isSafeInteger(override) && override >= 1) {
    return override;
  }
  const builtIn = DEFAULT_PROVIDER_MINIMUMS_MINOR[provider][code];
  if (typeof builtIn === "number") {
    return builtIn;
  }
  return provider === "square" ? 100 : 50;
}

export const PAYMENTS_SMALL_TOTALS_SETTING = defineSetting({
  key: "payments.small_totals",
  owner: "payments",
  group: "compliance",
  label: "Totals below card provider minimum",
  description:
    "Controls whether order totals below the active card provider minimum are automatically waived as paid or blocked at checkout.",
  schema: paymentsSmallTotalsSchema,
  default: DEFAULT_PAYMENTS_SMALL_TOTALS,
  sensitivity: "internal",
  writeCapability: "payments.manage",
  managedBy: { label: "Payments", href: "/admin/payments" },
});

/* ------------------------------------------- Increment 06 D15: receipts */

export const paymentsReceiptsSchema = z.strictObject({
  enabled: z.boolean().default(true),
  emailCustomer: z.boolean().default(true),
  footerText: z.string().max(500).default(""),
});

export type PaymentsReceiptsValue = z.infer<typeof paymentsReceiptsSchema>;

export const DEFAULT_PAYMENTS_RECEIPTS: PaymentsReceiptsValue = {
  enabled: true,
  emailCustomer: true,
  footerText: "",
};

function stripControlCharsKeepNewlines(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if ((code >= 0x20 && code !== 0x7f) || code === 0x09 || code === 0x0a || code === 0x0d) {
      out += value.charAt(i);
    }
  }
  return out;
}

/** Backwards-compatible parser for `payments.receipts` — never throws on legacy/partial stored values. */
export function parsePaymentsReceiptsSetting(raw: unknown): PaymentsReceiptsValue {
  if (typeof raw === "boolean") {
    return { ...DEFAULT_PAYMENTS_RECEIPTS, enabled: raw };
  }
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_PAYMENTS_RECEIPTS };
  }
  const rec = raw as Record<string, unknown>;
  const enabled = typeof rec.enabled === "boolean" ? rec.enabled : DEFAULT_PAYMENTS_RECEIPTS.enabled;
  const emailCustomer =
    typeof rec.emailCustomer === "boolean" ? rec.emailCustomer : DEFAULT_PAYMENTS_RECEIPTS.emailCustomer;
  const footerText =
    typeof rec.footerText === "string"
      ? stripControlCharsKeepNewlines(rec.footerText).slice(0, 500)
      : DEFAULT_PAYMENTS_RECEIPTS.footerText;
  return { enabled, emailCustomer, footerText };
}

export const PAYMENTS_RECEIPTS_SETTING = defineSetting({
  key: "payments.receipts",
  owner: "payments",
  group: "compliance",
  label: "Payment receipts",
  description:
    "Controls automatic generation, customer e-mail delivery, and custom footer copy for branded payment receipts.",
  schema: paymentsReceiptsSchema,
  default: DEFAULT_PAYMENTS_RECEIPTS,
  sensitivity: "public",
  writeCapability: "payments.manage",
  managedBy: { label: "Payments", href: "/admin/payments" },
});

/** Sanitizes card brand from a payment provider; rejects PAN-like digit runs. */
export function sanitizeCardBrand(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9 _-]/gu, "").slice(0, 32);
  if (!cleaned || /\d{4,}/u.test(cleaned)) return null;
  return cleaned;
}

/** Strictly accepts ONLY an exact 4-digit card suffix — never a full or partial PAN. */
export function sanitizeCardLast4(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return /^[0-9]{4}$/u.test(trimmed) ? trimmed : null;
}

/* ------------------ Increment 07.2: credential normalization, shape validation & diagnostics */

export const CREDENTIAL_FIELD_KEYS = [
  "stripeSecretKey",
  "stripeWebhookSecret",
  "stripeWebhookSecretSecondary",
  "squareAccessToken",
  "squareWebhookSignatureKey",
] as const;

export type CredentialFieldKey = (typeof CREDENTIAL_FIELD_KEYS)[number];

export type CredentialValidationReason =
  | "publishable_key_not_used"
  | "webhook_secret_in_api_key_field"
  | "api_key_in_webhook_field"
  | "webhook_endpoint_id_not_secret"
  | "wrong_mode_test_in_live"
  | "wrong_mode_live_in_test"
  | "missing_api_key_prefix"
  | "missing_whsec_prefix"
  | "masked_value_pasted"
  | "too_short"
  | "too_long"
  | "invalid_characters"
  | "primary_webhook_secret_missing";

export type CredentialValidationResult =
  | { ok: true; normalized: string }
  | {
      ok: false;
      field: CredentialFieldKey;
      reason: CredentialValidationReason;
      reasonCode: string;
      safeMessage: string;
    };

const SURROUNDING_QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["\u201C", "\u201D"],
  ["\u2018", "\u2019"],
];

/**
 * Normalizes pasted secret inputs before validation:
 * - strips zero-width characters, BOM, and NBSP
 * - trims outer whitespace
 * - strips matching surrounding quotes/backticks from CLI/env pastes
 * - strips all remaining internal whitespace/newlines from wrapped copies
 */
export function normalizeCredentialInput(raw: string): string {
  let cleaned = raw.replace(/[\u200B-\u200D\u2060\uFEFF\u00A0]/gu, "").trim();
  for (const [open, close] of SURROUNDING_QUOTE_PAIRS) {
    if (cleaned.length >= 2 && cleaned.startsWith(open) && cleaned.endsWith(close)) {
      cleaned = cleaned.slice(open.length, cleaned.length - close.length).trim();
      break;
    }
  }
  return cleaned.replace(/[\s\u200B-\u200D\u2060\uFEFF\u00A0]+/gu, "");
}

const MASK_CHAR_PATTERN = /[•*…\u2022\u2217]/u;

/**
 * Validates a normalized Stripe API secret/restricted key (`sk_*` / `rk_*`) for `mode`.
 * Never echoes the rejected value or its exact length in error messages.
 */
export function validateStripeSecretKeyInput(
  raw: string,
  mode: PaymentEnvironmentMode,
): CredentialValidationResult {
  const normalized = normalizeCredentialInput(raw);
  const field: CredentialFieldKey = "stripeSecretKey";
  const label = "Stripe API secret key";

  if (/^pk_(?:test_|live_)?/iu.test(normalized)) {
    return {
      ok: false,
      field,
      reason: "publishable_key_not_used",
      reasonCode: "STRIPE_PUBLISHABLE_KEY_NOT_USED",
      safeMessage: `${label}: This looks like a Stripe publishable key (pk_…). The portal does not need the publishable key. Paste the secret key (sk_…) or restricted key (rk_…) from Stripe Developers > API keys here.`,
    };
  }
  if (/^whsec_/iu.test(normalized)) {
    return {
      ok: false,
      field,
      reason: "webhook_secret_in_api_key_field",
      reasonCode: "INVALID_CREDENTIAL_FORMAT",
      safeMessage: `${label}: This looks like a webhook signing secret (whsec_…) — it belongs in Primary Stripe webhook signing secret.`,
    };
  }
  if (MASK_CHAR_PATTERN.test(normalized)) {
    return {
      ok: false,
      field,
      reason: "masked_value_pasted",
      reasonCode: "INVALID_CREDENTIAL_FORMAT",
      safeMessage: `${label}: This value contains masking characters. Select Reveal in Stripe Developers > API keys and copy the full unmasked key.`,
    };
  }
  if (mode === "live" && /^(?:sk|rk)_test_/iu.test(normalized)) {
    return {
      ok: false,
      field,
      reason: "wrong_mode_test_in_live",
      reasonCode: "STRIPE_KEY_MODE_MISMATCH",
      safeMessage: `${label}: This looks like a test-mode key (sk_test_… / rk_test_…), while Live payments is selected. Paste a live key (sk_live_… or rk_live_…) or switch the environment to Test / sandbox.`,
    };
  }
  if (mode === "test" && /^(?:sk|rk)_live_/iu.test(normalized)) {
    return {
      ok: false,
      field,
      reason: "wrong_mode_live_in_test",
      reasonCode: "STRIPE_KEY_MODE_MISMATCH",
      safeMessage: `${label}: This looks like a live-mode key (sk_live_… / rk_live_…), while Test / sandbox is selected. Paste a test key (sk_test_… or rk_test_…) or switch the environment to Live payments.`,
    };
  }
  if (!/^(?:sk|rk)_(?:test|live)_/u.test(normalized)) {
    return {
      ok: false,
      field,
      reason: "missing_api_key_prefix",
      reasonCode: "INVALID_CREDENTIAL_FORMAT",
      safeMessage:
        mode === "live"
          ? `${label}: API keys for Live payments must start with sk_live_ or rk_live_.`
          : `${label}: API keys for Test / sandbox must start with sk_test_ or rk_test_.`,
    };
  }
  if (normalized.length < 18) {
    return {
      ok: false,
      field,
      reason: "too_short",
      reasonCode: "INVALID_CREDENTIAL_FORMAT",
      safeMessage: `${label}: Value is too short to be a complete Stripe API key. Copy the full key from Stripe Developers > API keys.`,
    };
  }
  if (normalized.length > 208) {
    return {
      ok: false,
      field,
      reason: "too_long",
      reasonCode: "INVALID_CREDENTIAL_FORMAT",
      safeMessage: `${label}: Value is longer than expected for a Stripe API key. Copy only a single sk_… or rk_… key.`,
    };
  }
  if (!PAYMENTS_STRIPE_SECRET_KEY.schema.safeParse(normalized).success) {
    return {
      ok: false,
      field,
      reason: "invalid_characters",
      reasonCode: "INVALID_CREDENTIAL_FORMAT",
      safeMessage: `${label}: Contains unexpected characters. Stripe keys use only letters, numbers, and underscores after sk_… or rk_….`,
    };
  }
  return { ok: true, normalized };
}

/**
 * Validates a normalized Stripe webhook signing secret (`whsec_*`) for primary or secondary slot.
 * Never echoes the rejected value or its exact length in error messages.
 */
export function validateStripeWebhookSecretInput(
  raw: string,
  field: "stripeWebhookSecret" | "stripeWebhookSecretSecondary",
): CredentialValidationResult {
  const normalized = normalizeCredentialInput(raw);
  const label =
    field === "stripeWebhookSecret"
      ? "Primary Stripe webhook signing secret"
      : "Secondary Stripe webhook signing secret";

  if (/^pk_(?:test_|live_)?/iu.test(normalized)) {
    return {
      ok: false,
      field,
      reason: "publishable_key_not_used",
      reasonCode: "STRIPE_PUBLISHABLE_KEY_NOT_USED",
      safeMessage: `${label}: This looks like a Stripe publishable key (pk_…). The portal does not need the publishable key. Paste the webhook signing secret that starts with whsec_ here.`,
    };
  }
  if (/^(?:sk|rk)_(?:test_|live_)?/iu.test(normalized)) {
    return {
      ok: false,
      field,
      reason: "api_key_in_webhook_field",
      reasonCode: "INVALID_CREDENTIAL_FORMAT",
      safeMessage: `${label}: This looks like an API secret key (sk_… / rk_…) — it belongs in the first field (Stripe API secret key). Paste the webhook signing secret that starts with whsec_ here.`,
    };
  }
  if (/^we_[A-Za-z0-9]/iu.test(normalized)) {
    return {
      ok: false,
      field,
      reason: "webhook_endpoint_id_not_secret",
      reasonCode: "INVALID_CREDENTIAL_FORMAT",
      safeMessage: `${label}: This looks like a webhook endpoint ID (we_…), not the signing secret. In Stripe Workbench > Webhooks, open the destination and select Reveal under Signing secret to copy the whsec_… value.`,
    };
  }
  if (MASK_CHAR_PATTERN.test(normalized)) {
    return {
      ok: false,
      field,
      reason: "masked_value_pasted",
      reasonCode: "INVALID_CREDENTIAL_FORMAT",
      safeMessage: `${label}: This value contains masking characters. In Stripe Workbench > Webhooks, select Reveal under Signing secret and copy the full whsec_… value.`,
    };
  }
  if (!normalized.startsWith("whsec_")) {
    return {
      ok: false,
      field,
      reason: "missing_whsec_prefix",
      reasonCode: "INVALID_CREDENTIAL_FORMAT",
      safeMessage: `${label}: Signing secrets start with whsec_. In Stripe Workbench > Webhooks, open the destination and select Reveal under Signing secret.`,
    };
  }
  if (normalized.length < 18) {
    return {
      ok: false,
      field,
      reason: "too_short",
      reasonCode: "INVALID_CREDENTIAL_FORMAT",
      safeMessage: `${label}: Signing secret is too short. Copy the full whsec_… value from Stripe Workbench > Webhooks > Signing secret.`,
    };
  }
  if (normalized.length > 206) {
    return {
      ok: false,
      field,
      reason: "too_long",
      reasonCode: "INVALID_CREDENTIAL_FORMAT",
      safeMessage: `${label}: Signing secret is longer than expected. Copy only a single whsec_… signing secret.`,
    };
  }
  if (!PAYMENTS_STRIPE_WEBHOOK_SECRET.schema.safeParse(normalized).success) {
    return {
      ok: false,
      field,
      reason: "invalid_characters",
      reasonCode: "INVALID_CREDENTIAL_FORMAT",
      safeMessage: `${label}: Signing secrets start with whsec_ followed only by letters, numbers, or underscores.`,
    };
  }
  return { ok: true, normalized };
}

export function validateSquareSecretInput(
  raw: string,
  field: "squareAccessToken" | "squareWebhookSignatureKey",
): CredentialValidationResult {
  const normalized = normalizeCredentialInput(raw);
  const label = field === "squareAccessToken" ? "Square access token" : "Square webhook signature key";
  const minLen = field === "squareAccessToken" ? 16 : 12;
  if (MASK_CHAR_PATTERN.test(normalized)) {
    return {
      ok: false,
      field,
      reason: "masked_value_pasted",
      reasonCode: "INVALID_CREDENTIAL_FORMAT",
      safeMessage: `${label}: This value contains masking characters. Copy the full unmasked credential from Square Developer Console.`,
    };
  }
  if (normalized.length < minLen) {
    return {
      ok: false,
      field,
      reason: "too_short",
      reasonCode: "INVALID_CREDENTIAL_FORMAT",
      safeMessage: `${label}: Value is too short to be a complete ${label.toLowerCase()}.`,
    };
  }
  if (normalized.length > 256) {
    return {
      ok: false,
      field,
      reason: "too_long",
      reasonCode: "INVALID_CREDENTIAL_FORMAT",
      safeMessage: `${label}: Value is longer than expected.`,
    };
  }
  const schema =
    field === "squareAccessToken"
      ? PAYMENTS_SQUARE_ACCESS_TOKEN.schema
      : PAYMENTS_SQUARE_WEBHOOK_SIGNATURE_KEY.schema;
  if (!schema.safeParse(normalized).success) {
    return {
      ok: false,
      field,
      reason: "invalid_characters",
      reasonCode: "INVALID_CREDENTIAL_FORMAT",
      safeMessage: `${label}: Value is not in the expected format.`,
    };
  }
  return { ok: true, normalized };
}

export const CHECKOUT_FAILURE_CLASSES = [
  "configuration",
  "egress",
  "provider_auth",
  "provider_permission",
  "provider_request",
  "provider_transient",
  "provider_response",
  "untrusted_redirect_url",
  "payment_declined",
  "expired",
  "cancelled",
] as const;

export type CheckoutFailureClass = (typeof CHECKOUT_FAILURE_CLASSES)[number];

export function classifyCheckoutFailureReason(
  reasonCode: string | null | undefined,
  status?: string | null,
): CheckoutFailureClass | null {
  if (status === "expired" && !reasonCode) return "expired";
  if (status === "cancelled" && !reasonCode) return "cancelled";
  if (!reasonCode) return null;
  const code = reasonCode.toUpperCase();
  if (code === "SESSION_EXPIRED" || code === "EXPIRED") return "expired";
  if (code === "CUSTOMER_CANCELLED" || code === "CANCELLED") return "cancelled";
  if (
    code === "PAYMENT_FAILED" ||
    code === "ASYNC_PAYMENT_FAILED" ||
    code === "PAYMENT_INTENT_FAILED"
  ) {
    return "payment_declined";
  }
  if (code.startsWith("EGRESS_") || code === "STRIPE_EGRESS_BLOCKED") return "egress";
  if (code === "STRIPE_AUTH_INVALID_KEY") return "provider_auth";
  if (code === "STRIPE_KEY_MISSING_PERMISSION") return "provider_permission";
  if (
    code === "STRIPE_INVALID_REQUEST" ||
    code === "STRIPE_HTTP_4XX"
  ) {
    return "provider_request";
  }
  if (
    code === "STRIPE_RATE_LIMITED" ||
    code === "STRIPE_UPSTREAM_5XX" ||
    code === "STRIPE_NETWORK_TIMEOUT" ||
    code === "STRIPE_TRANSPORT_FAILED"
  ) {
    return "provider_transient";
  }
  if (
    code === "STRIPE_INVALID_JSON" ||
    code === "STRIPE_INVALID_SESSION_ID" ||
    code === "SQUARE_RESPONSE_INVALID"
  ) {
    return "provider_response";
  }
  if (code === "STRIPE_UNTRUSTED_REDIRECT_URL" || code === "SQUARE_UNTRUSTED_REDIRECT_URL") {
    return "untrusted_redirect_url";
  }
  if (
    code === "PROVIDER_NOT_CONFIGURED" ||
    code === "PAYMENT_PROVIDER_NOT_CONFIGURED" ||
    code === "PROVIDER_VERIFICATION_STALE" ||
    code === "STRIPE_KEY_MODE_MISMATCH" ||
    code === "STRIPE_MODE_MISMATCH"
  ) {
    return "configuration";
  }
  return "provider_response";
}

const SECRET_LIKE_TOKEN = /(?:^(?:sk|rk|pk)_(?:test|live)?|^whsec_|bearer\b)/iu;

/**
 * Sanitizes bounded provider diagnostic tokens (`error.type`, `error.code`, `error.param`).
 * Never accepts free-form prose or any token resembling a secret/key prefix.
 */
export function sanitizeStripeDiagnosticToken(
  raw: unknown,
  opts?: { allowBrackets?: boolean },
): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 64) return null;
  if (SECRET_LIKE_TOKEN.test(trimmed)) return null;
  const pattern = opts?.allowBrackets
    ? /^[A-Za-z0-9_.[\]-]{1,64}$/u
    : /^[A-Za-z0-9_.-]{1,64}$/u;
  if (!pattern.test(trimmed)) return null;
  if (opts?.allowBrackets && /(?:secret|token|password|apikey|api_key|auth)/iu.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export function describeCheckoutFailureForAdmin(input: {
  provider: ActivePaymentProvider;
  mode: PaymentEnvironmentMode;
  reasonCode: string;
  upstreamStatus?: number | null;
  stripeErrorCode?: string | null;
}): {
  severity: "warning" | "error";
  title: string;
  explanation: string;
  nextStep: string;
} {
  const providerLabel = input.provider === "stripe" ? "Stripe Checkout" : "Square Payment Links";
  const title = `Customers cannot reach ${providerLabel} (${input.mode})`;
  const statusSuffix = input.upstreamStatus ? ` (HTTP ${input.upstreamStatus})` : "";
  const codeSuffix = input.stripeErrorCode ? ` [${input.stripeErrorCode}]` : "";

  switch (input.reasonCode) {
    case "PROVIDER_NOT_CONFIGURED":
    case "PAYMENT_PROVIDER_NOT_CONFIGURED":
      return {
        severity: "error",
        title,
        explanation: `${providerLabel} is selected as the active provider, but required credentials are missing.`,
        nextStep: "Open /admin/payments/setup to stage credentials and verify connectivity, or switch back to Pay by invoice.",
      };
    case "PROVIDER_VERIFICATION_STALE":
      return {
        severity: "error",
        title,
        explanation: `${providerLabel} credentials or outbound allowlist settings changed after verification, so unverified checkout sessions are blocked.`,
        nextStep: "Open /admin/payments/setup and re-run Test Stripe API and Send self-test webhook.",
      };
    case "STRIPE_KEY_MODE_MISMATCH":
    case "STRIPE_MODE_MISMATCH":
      return {
        severity: "error",
        title,
        explanation: `The saved Stripe API key environment does not match ${input.mode} mode.`,
        nextStep: `Open /admin/payments/setup, stage an ${input.mode === "live" ? "sk_live_ / rk_live_" : "sk_test_ / rk_test_"} key, and re-verify.`,
      };
    case "STRIPE_AUTH_INVALID_KEY":
      return {
        severity: "error",
        title,
        explanation: `Stripe rejected the API secret key${statusSuffix}${codeSuffix} as invalid, expired, or revoked.`,
        nextStep: "Open /admin/payments/setup, stage a current Stripe secret or restricted key, and re-run verification.",
      };
    case "STRIPE_KEY_MISSING_PERMISSION":
      return {
        severity: "error",
        title,
        explanation: `Stripe refused Checkout Session creation${statusSuffix}${codeSuffix} because the restricted key lacks Checkout Sessions Write permission.`,
        nextStep: "In Stripe Developers > API keys, grant Checkout Sessions Write, PaymentIntents Read, and Refunds Write, then stage and verify the updated key in /admin/payments/setup.",
      };
    case "STRIPE_INVALID_REQUEST":
    case "STRIPE_HTTP_4XX":
      return {
        severity: "error",
        title,
        explanation: `Stripe rejected the Checkout Session request${statusSuffix}${codeSuffix} (check account activation and currency support).`,
        nextStep: "Review the diagnostic code in /admin/payments/setup and confirm your Stripe account supports the configured invoice currency and live charges.",
      };
    case "STRIPE_UNTRUSTED_REDIRECT_URL":
      return {
        severity: "error",
        title,
        explanation: "Stripe returned a Checkout URL outside checkout.stripe.com (for example a Stripe custom checkout domain, which the portal refuses).",
        nextStep: "Disable custom domains for Stripe-hosted Checkout in Stripe Dashboard > Settings > Branding / Custom domains so sessions use checkout.stripe.com, then run Verify Checkout session creation.",
      };
    case "STRIPE_RATE_LIMITED":
    case "STRIPE_UPSTREAM_5XX":
    case "STRIPE_NETWORK_TIMEOUT":
    case "STRIPE_TRANSPORT_FAILED":
      return {
        severity: "warning",
        title,
        explanation: `Outbound Checkout Session creation hit a transient network or upstream error${statusSuffix}${codeSuffix}.`,
        nextStep: "Check outbound HTTPS connectivity to api.stripe.com:443 and Stripe status; customers can retry from their invoice or checkout status page.",
      };
    case "STRIPE_INVALID_JSON":
    case "STRIPE_INVALID_SESSION_ID":
      return {
        severity: "error",
        title,
        explanation: `Upstream returned a malformed or non-JSON Checkout Session response${statusSuffix}.`,
        nextStep: "Verify no outbound proxy or TLS middlebox is intercepting api.stripe.com:443 and run Verify Checkout session creation in /admin/payments/setup.",
      };
    default:
      if (input.reasonCode.startsWith("EGRESS_")) {
        return {
          severity: "error",
          title,
          explanation: `Outbound HTTPS egress to the payment provider was blocked by portal network policy (${input.reasonCode}).`,
          nextStep: "Open /admin/payments/setup or /admin/integrations and enable the provider outbound HTTPS allowlist preset.",
        };
      }
      return {
        severity: "error",
        title,
        explanation: `Hosted checkout session creation failed (${input.reasonCode})${statusSuffix}.`,
        nextStep: "Inspect /admin/payments/setup diagnostics and verify provider credentials and outbound HTTPS allowlisting.",
      };
  }
}

export function customerMessageForCheckoutFailure(failureClass: CheckoutFailureClass): string {
  switch (failureClass) {
    case "provider_transient":
      return "We could not reach the payment provider right now. Your order and invoice are saved — please try paying online again in a moment.";
    case "configuration":
    case "egress":
    case "provider_auth":
    case "provider_permission":
    case "provider_request":
    case "untrusted_redirect_url":
      return "Online card payment is temporarily unavailable while our team updates payment settings. Your order and invoice are saved — follow the payment instructions on your invoice or check back shortly.";
    default:
      return "Online card payment could not be started for this invoice right now. Your order and invoice are saved — please try again shortly or follow the payment instructions on your invoice.";
  }
}

export const lastCheckoutFailureSchema = z.object({
  occurredAt: z.string().max(64),
  provider: z.enum(ACTIVE_PAYMENT_PROVIDERS),
  mode: z.enum(PAYMENT_ENVIRONMENT_MODES),
  reasonCode: z.string().max(64),
  failureClass: z.enum(CHECKOUT_FAILURE_CLASSES),
  upstreamStatus: z.number().int().min(100).max(599).nullable(),
  stripeErrorType: z.string().max(64).nullable(),
  stripeErrorCode: z.string().max(64).nullable(),
  stripeErrorParam: z.string().max(64).nullable(),
  attemptPublicId: z.string().max(32).nullable(),
  invoicePublicId: z.string().max(32).nullable(),
  orderPublicId: z.string().max(32).nullable(),
});

export type LastCheckoutFailureDiagnostic = z.infer<typeof lastCheckoutFailureSchema>;

export const lastStripeCheckoutProbeSchema = z.object({
  checkedAt: z.string().max(64),
  mode: z.enum(PAYMENT_ENVIRONMENT_MODES),
  apiFingerprint: z.string().max(64).nullable(),
  ok: z.boolean(),
  reasonCode: z.string().max(64),
  upstreamStatus: z.number().int().min(100).max(599).nullable(),
  stripeErrorType: z.string().max(64).nullable(),
  stripeErrorCode: z.string().max(64).nullable(),
  message: z.string().max(300),
});

export type LastStripeCheckoutProbeDiagnostic = z.infer<typeof lastStripeCheckoutProbeSchema>;

export const paymentsDiagnosticsSchema = z.object({
  stripeEverApiVerified: z.boolean().default(false),
  stripeEverSelfTested: z.boolean().default(false),
  lastCheckoutFailure: lastCheckoutFailureSchema.nullable().default(null),
  lastStripeCheckoutProbe: lastStripeCheckoutProbeSchema.nullable().default(null),
});

export type PaymentsDiagnosticsValue = z.infer<typeof paymentsDiagnosticsSchema>;

export const DEFAULT_PAYMENTS_DIAGNOSTICS: PaymentsDiagnosticsValue = {
  stripeEverApiVerified: false,
  stripeEverSelfTested: false,
  lastCheckoutFailure: null,
  lastStripeCheckoutProbe: null,
};

export function parsePaymentsDiagnosticsSetting(raw: unknown): PaymentsDiagnosticsValue {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PAYMENTS_DIAGNOSTICS };
  const parsed = paymentsDiagnosticsSchema.safeParse(raw);
  return parsed.success ? parsed.data : { ...DEFAULT_PAYMENTS_DIAGNOSTICS };
}

export const PAYMENTS_DIAGNOSTICS_SETTING = defineSetting({
  key: "payments.diagnostics",
  owner: "payments",
  group: "compliance",
  label: "Payment checkout diagnostics",
  description:
    "Non-secret operational telemetry for the most recent checkout-session creation failure and Stripe session probe.",
  schema: paymentsDiagnosticsSchema,
  default: DEFAULT_PAYMENTS_DIAGNOSTICS,
  sensitivity: "internal",
  exportable: false,
  writeCapability: "payments.manage",
  managedBy: { label: "Stripe setup", href: "/admin/payments/setup" },
});

