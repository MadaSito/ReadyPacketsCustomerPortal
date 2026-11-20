import { z } from "zod";
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
  label: "Invoice issuer name",
  description: "Legal or display name shown on customer invoices.",
  schema: z.string().trim().min(1).max(160),
  default: "ReadyPackets",
  sensitivity: "public",
});

export const INVOICE_ISSUER_ADDRESS = defineSetting({
  key: "compliance.invoices.issuer_address",
  owner: "compliance",
  group: "compliance",
  label: "Invoice issuer address",
  description: "Postal address or billing contact lines printed on customer invoices.",
  schema: z.string().max(400),
  default: "",
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
