/**
 * Payments module — Settings & write-only secrets (Increment 04, Package K).
 *
 * Defaults to `provider: "none"` (Pay by invoice). All secrets use `defineSecret` with
 * `exportable: false` (AES-256-GCM encrypted at rest via `FieldCrypto`, never exported).
 */
import { z } from "zod";
import { defineSecret, defineSetting } from "../platform/index.js";
import {
  type ActivePaymentProvider,
  PAYMENT_ENVIRONMENT_MODES,
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
  squareLocationId: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/u).nullable(),
  squareAccessTokenLast4: z.string().max(8).nullable(),
  squareWebhookSignatureKeyLast4: z.string().max(8).nullable(),
});

export type PaymentsConfigValue = z.infer<typeof paymentsConfigSchema>;

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
