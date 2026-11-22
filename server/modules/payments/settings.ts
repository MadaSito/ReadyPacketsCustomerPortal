/**
 * Payments module — Settings & write-only secrets (Increment 04, Package K).
 *
 * Defaults to `provider: "none"` (Pay by invoice). All secrets use `defineSecret` with
 * `exportable: false` (AES-256-GCM encrypted at rest via `FieldCrypto`, never exported).
 */
import { z } from "zod";
import { defineSecret, defineSetting } from "../platform/index.js";
import { PAYMENT_ENVIRONMENT_MODES, PAYMENT_PROVIDER_CHOICES } from "./schema.js";

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
