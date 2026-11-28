import { z } from "zod";
import { BRAND_ASSETS } from "../../../shared/brand.js";
import { defineSetting } from "../platform/index.js";

export const INVOICE_NUMBER_PREFIX = defineSetting({
  key: "compliance.invoices.number_prefix",
  owner: "compliance",
  group: "compliance",
  label: "Invoice number prefix",
  description: "Uppercase prefix prepended to issued invoice numbers (for example RP-INV-2026-000001).",
  schema: z.string().regex(/^[A-Z0-9-]{2,16}$/),
  default: "RP-INV",
  sensitivity: "internal",
});

export const INVOICE_ISSUER_NAME = defineSetting({
  key: "compliance.invoices.issuer_name",
  owner: "compliance",
  group: "compliance",
  label: "Company legal name",
  description: "Legal business name shown on customer invoices and payment receipts.",
  schema: z.string().trim().min(1).max(160),
  default: "Ready Packets Consulting LLC",
  sensitivity: "public",
});

export const INVOICE_ISSUER_ADDRESS = defineSetting({
  key: "compliance.invoices.issuer_address",
  owner: "compliance",
  group: "compliance",
  label: "Company postal address",
  description: "Postal address printed on customer invoices and payment receipts.",
  schema: z.string().max(400),
  default: "",
  sensitivity: "public",
});

export const INVOICE_ISSUER_CONTACT = defineSetting({
  key: "compliance.invoices.issuer_contact",
  owner: "compliance",
  group: "compliance",
  label: "Company billing contact",
  description: "Billing e-mail, phone, or support URL printed on customer invoices and payment receipts.",
  schema: z.string().max(240),
  default: "",
  sensitivity: "public",
});

export const INVOICE_ISSUER_TAX_ID = defineSetting({
  key: "compliance.invoices.issuer_tax_id",
  owner: "compliance",
  group: "compliance",
  label: "Company tax or registration ID",
  description: "Tax identification, EIN, VAT, or business registration number printed on invoices and receipts.",
  schema: z.string().max(80),
  default: "",
  sensitivity: "public",
});

export const DEFAULT_DOCUMENT_LOGO_PATH = `/${BRAND_ASSETS.documentLogo.path}` as const;

export const DOCUMENT_LOGO_ALLOWLIST = [
  DEFAULT_DOCUMENT_LOGO_PATH,
  `/${BRAND_ASSETS.light.horizontalPng500.path}`,
  `/${BRAND_ASSETS.light.horizontalPng300.path}`,
] as const;
export type DocumentLogoBrandPath = (typeof DOCUMENT_LOGO_ALLOWLIST)[number];

export const ISSUER_LOGO_MODES = ["brand", "none"] as const;
export type IssuerLogoMode = (typeof ISSUER_LOGO_MODES)[number];

export const issuerLogoSettingSchema = z.strictObject({
  mode: z.enum(ISSUER_LOGO_MODES).default("brand"),
  brandPath: z.enum(DOCUMENT_LOGO_ALLOWLIST).default(DEFAULT_DOCUMENT_LOGO_PATH),
});
export type IssuerLogoSetting = z.infer<typeof issuerLogoSettingSchema>;

export const DEFAULT_ISSUER_LOGO_SETTING: IssuerLogoSetting = {
  mode: "brand",
  brandPath: DEFAULT_DOCUMENT_LOGO_PATH,
};

/** Backwards-compatible parser: never throws on legacy/partial stored values. */
export function parseIssuerLogoSetting(raw: unknown): IssuerLogoSetting {
  if (typeof raw === "string") {
    if (raw === "none" || raw === "") {
      return { mode: "none", brandPath: DEFAULT_ISSUER_LOGO_SETTING.brandPath };
    }
    const brandMatch = (DOCUMENT_LOGO_ALLOWLIST as readonly string[]).includes(raw)
      ? (raw as DocumentLogoBrandPath)
      : DEFAULT_ISSUER_LOGO_SETTING.brandPath;
    return { mode: "brand", brandPath: brandMatch };
  }
  if (raw && typeof raw === "object") {
    const rec = raw as Record<string, unknown>;
    const mode: IssuerLogoMode = rec.mode === "none" ? "none" : "brand";
    const brandPath =
      typeof rec.brandPath === "string" && (DOCUMENT_LOGO_ALLOWLIST as readonly string[]).includes(rec.brandPath)
        ? (rec.brandPath as DocumentLogoBrandPath)
        : DEFAULT_ISSUER_LOGO_SETTING.brandPath;
    return { mode, brandPath };
  }
  return { ...DEFAULT_ISSUER_LOGO_SETTING };
}

export const INVOICE_ISSUER_LOGO = defineSetting({
  key: "compliance.invoices.issuer_logo",
  owner: "compliance",
  group: "compliance",
  label: "Company document logo",
  description: "Approved brand mark embedded into generated invoice and payment receipt PDFs.",
  schema: issuerLogoSettingSchema,
  default: DEFAULT_ISSUER_LOGO_SETTING,
  sensitivity: "public",
});

export const INVOICE_PAYMENT_INSTRUCTIONS = defineSetting({
  key: "compliance.invoices.payment_instructions",
  owner: "compliance",
  group: "compliance",
  label: "Manual remittance instructions",
  description: "Plain-text instructions shown on unpaid issued invoices when online payment is not configured.",
  schema: z.string().max(1000),
  default: "Contact ReadyPackets billing support through your order workspace for wire or ACH remittance instructions.",
  sensitivity: "internal",
});

export const INVOICE_DEFAULT_TAX_RATE_BPS = defineSetting({
  key: "compliance.invoices.default_tax_rate_bps",
  owner: "compliance",
  group: "compliance",
  label: "Default checkout tax rate (basis points)",
  description: "Default integer tax rate in basis points (100 bps = 1.00%, 0 = tax-exempt) applied at checkout.",
  schema: z.number().int().min(0).max(5000),
  default: 0,
  sensitivity: "internal",
});

export const SIGNATURE_NAME_CHECK_MODES = ["require", "warn", "off"] as const;
export type SignatureNameCheckMode = (typeof SIGNATURE_NAME_CHECK_MODES)[number];

export const signatureNameCheckSettingSchema = z.strictObject({
  mode: z.enum(SIGNATURE_NAME_CHECK_MODES).default("require"),
});
export type SignatureNameCheckSetting = z.infer<typeof signatureNameCheckSettingSchema>;

export const DEFAULT_SIGNATURE_NAME_CHECK_SETTING: SignatureNameCheckSetting = {
  mode: "require",
};

/** Backwards-compatible parser: never throws on legacy/scalar/unknown stored values. */
export function parseSignatureNameCheckSetting(raw: unknown): SignatureNameCheckSetting {
  if (typeof raw === "string" && (SIGNATURE_NAME_CHECK_MODES as readonly string[]).includes(raw)) {
    return { mode: raw as SignatureNameCheckMode };
  }
  if (raw && typeof raw === "object") {
    const mode = (raw as { mode?: unknown }).mode;
    if (typeof mode === "string" && (SIGNATURE_NAME_CHECK_MODES as readonly string[]).includes(mode)) {
      return { mode: mode as SignatureNameCheckMode };
    }
  }
  return { ...DEFAULT_SIGNATURE_NAME_CHECK_SETTING };
}

export const SIGNATURE_NAME_CHECK = defineSetting({
  key: "compliance.signature_name_check",
  owner: "compliance",
  group: "compliance",
  label: "Typed signature name check",
  description:
    "Controls whether typed signatures on policies and order gates must match the signer's account name (require, warn, or off).",
  schema: signatureNameCheckSettingSchema,
  default: DEFAULT_SIGNATURE_NAME_CHECK_SETTING,
  sensitivity: "internal",
});
