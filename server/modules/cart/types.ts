/**
 * Public contracts and strict Zod input schemas for Cart & Checkout (Increment 04, Package L).
 * Owner: recovery_ops_engineer.
 *
 * Security rule (§4): Every input schema uses `.strict()` and explicit bounds. Clients never submit
 * prices, discounts, tax rates, or totals; any extra field is rejected with `BAD_INPUT` (`unrecognized_keys`).
 */
import { z } from "zod";
import type { ModuleLifecycle, SessionPrincipal } from "../../core/types.js";
import type { PublishedPolicyView } from "../compliance/index.js";

const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "Identifier format is not valid.");

const nfcTrim = (min: number, max: number) =>
  z
    .string()
    .transform((value) => value.normalize("NFC").trim())
    .pipe(z.string().min(min).max(max));

const nfcOptional = (max: number) =>
  z
    .string()
    .transform((value) => value.normalize("NFC").trim())
    .pipe(z.string().max(max));

export const billingDetailsSchema = z
  .object({
    fullName: nfcTrim(1, 160),
    company: nfcOptional(160).optional().default(""),
    email: nfcTrim(3, 254).pipe(z.email("Enter a valid billing email address.")),
    country: z
      .string()
      .transform((v) => v.trim().toUpperCase())
      .pipe(z.string().regex(/^[A-Z]{2}$/, "Select a two-letter country code.")),
    region: nfcOptional(64).optional().default(""),
    addressLine1: nfcTrim(1, 200),
    addressLine2: nfcOptional(200).optional().default(""),
    city: nfcTrim(1, 120),
    postalCode: nfcTrim(1, 32),
    taxId: nfcOptional(64).optional().default(""),
  })
  .strict();

export type BillingDetailsInput = z.infer<typeof billingDetailsSchema>;

export const cartItemSelectionSchema = z
  .object({
    productPublicId: ulidSchema,
    quantity: z.number().int().min(1).max(1000),
  })
  .strict();

export const addItemsInputSchema = z
  .object({
    items: z.array(cartItemSelectionSchema).min(1).max(50),
    projectName: nfcOptional(160).optional(),
    note: nfcOptional(4000).optional(),
    replacePacketTiers: z.boolean().optional().default(true),
  })
  .strict();

export const updateItemInputSchema = z
  .object({
    itemPublicId: ulidSchema,
    expectedVersion: z.number().int().min(1).max(1_000_000_000),
    productPublicId: ulidSchema.optional(),
    quantity: z.number().int().min(1).max(1000).optional(),
  })
  .strict()
  .refine((val) => val.productPublicId !== undefined || val.quantity !== undefined, {
    message: "Provide a tier or quantity change.",
  });

export const removeItemInputSchema = z
  .object({
    itemPublicId: ulidSchema,
    expectedVersion: z.number().int().min(1).max(1_000_000_000),
  })
  .strict();

export const clearCartInputSchema = z
  .object({
    expectedVersion: z.number().int().min(1).max(1_000_000_000),
  })
  .strict();

export const saveDraftDetailsInputSchema = z
  .object({
    expectedVersion: z.number().int().min(1).max(1_000_000_000),
    projectName: nfcOptional(160),
    note: nfcOptional(4000).optional().default(""),
    billing: billingDetailsSchema.nullable().optional(),
  })
  .strict();

export const policyAcceptanceInputSchema = z
  .object({
    versionPublicId: ulidSchema,
    contentHash: z.string().regex(/^[0-9a-f]{64}$/, "Policy hash format is not valid."),
    signerName: nfcOptional(160).optional(),
  })
  .strict();

export const checkoutInputSchema = z
  .object({
    cartPublicId: ulidSchema,
    expectedVersion: z.number().int().min(1).max(1_000_000_000),
    projectName: nfcTrim(1, 160),
    note: nfcOptional(4000).optional().default(""),
    billing: billingDetailsSchema,
    policyAcceptances: z.array(policyAcceptanceInputSchema).max(25).optional().default([]),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/, "Idempotency key is not valid."),
  })
  .strict();

export const checkoutTargetInputSchema = z
  .object({
    cartPublicId: ulidSchema.optional(),
    attemptPublicId: ulidSchema.optional(),
  })
  .strict()
  .refine((val) => Boolean(val.cartPublicId || val.attemptPublicId), {
    message: "Provide a cart or payment attempt reference.",
  });

export const adminListOpenInputSchema = z
  .object({
    search: nfcOptional(120).optional(),
    cursor: z.string().max(64).optional(),
    limit: z.number().int().min(1).max(100).optional().default(25),
  })
  .strict();

export const adminGetOpenInputSchema = z
  .object({
    cartPublicId: ulidSchema,
  })
  .strict();

export type PacketTierName = "Basic" | "Standard" | "Premium";

export interface CartTierOptionView {
  productPublicId: string;
  tier: PacketTierName;
  name: string;
  priceMinor: number;
  currency: string;
  timeline: string;
}

export interface CartLineView {
  itemPublicId: string;
  productPublicId: string;
  packetNumber: number | null;
  groupName: string;
  tier: PacketTierName | null;
  tierOptions: CartTierOptionView[];
  name: string;
  description: string;
  outcome: string;
  timeline: string;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  currency: string;
  available: boolean;
}

export interface CartBundleQuoteView {
  enabled: true;
  label: string;
  discountPercent: number;
  requiredPacketNumbers: number[];
  missingPacketNumbers: number[];
  applied: boolean;
}

export interface CartTotalsView {
  currency: string | null;
  subtotalMinor: number;
  discountMinor: number;
  discountLabel: string | null;
  subtotalAfterDiscountMinor: number;
  taxRateBps: number;
  taxMinor: number;
  totalMinor: number;
  bundle: CartBundleQuoteView | null;
}

export interface CartView {
  cartPublicId: string | null;
  version: number;
  status: "open";
  itemCount: number;
  projectName: string;
  note: string;
  billing: BillingDetailsInput | null;
  items: CartLineView[];
  hasUnavailableItems: boolean;
  mixedCurrency: boolean;
  totals: CartTotalsView;
  paymentProvider: "none" | "stripe" | "square";
  paymentEnvironment: "test" | "live";
  onlinePaymentEnabled: boolean;
  pendingPolicies: PublishedPolicyView[];
  updatedAt: Date | null;
}

export type CheckoutCartResult =
  | {
      mode: "invoice";
      cartPublicId: string;
      orderPublicId: string;
      orderReference: string;
      invoicePublicId: string;
      invoiceNumber: string;
      currency: string;
      totalMinor: number;
    }
  | {
      mode: "redirect";
      cartPublicId: string;
      orderPublicId: string;
      orderReference: string;
      invoicePublicId: string;
      invoiceNumber: string;
      attemptPublicId: string;
      provider: "stripe" | "square";
      environment: "test" | "live";
      redirectUrl: string;
      currency: string;
      totalMinor: number;
    };

export type CheckoutConfirmationState =
  | "pending_confirmation"
  | "paid"
  | "invoice_issued"
  | "cancelled"
  | "failed";

export interface CheckoutStatusResult {
  cartPublicId: string;
  confirmationState: CheckoutConfirmationState;
  paymentMode: "invoice" | "redirect";
  provider: "none" | "stripe" | "square";
  attemptPublicId: string | null;
  attemptStatus: "created" | "redirected" | "paid" | "failed" | "expired" | "cancelled" | null;
  failureReasonCode: string | null;
  orderPublicId: string;
  orderReference: string;
  invoicePublicId: string;
  invoiceNumber: string | null;
  invoiceStatus: "draft" | "issued" | "paid" | "void";
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  discountLabel: string | null;
  taxRateBps: number;
  taxMinor: number;
  totalMinor: number;
  balanceDueMinor: number;
  canRestoreToCart: boolean;
  alreadyRestored: boolean;
  checkedOutAt: Date | null;
}

export interface RestoreCheckoutResult {
  restored: boolean;
  alreadyRestored: boolean;
  cart: CartView;
}

export interface AdminOpenCartSummary {
  cartPublicId: string;
  customerPublicId: string;
  customerRef: string | null;
  projectName: string | null;
  itemCount: number;
  packetSummary: string;
  currency: string | null;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  bundleApplied: boolean;
  hasUnavailableItems: boolean;
  lastActivityAt: Date;
  expiresAt: Date;
  createdAt: Date;
}

export interface AdminOpenCartDetail extends AdminOpenCartSummary {
  items: CartLineView[];
  totals: CartTotalsView;
}

export interface CartModule extends ModuleLifecycle {
  init(): void;
  getBadgeCount(principal: SessionPrincipal): Promise<{ enabled: boolean; itemCount: number }>;
  getMyCart(principal: SessionPrincipal): Promise<CartView>;
  addItems(principal: SessionPrincipal, input: z.infer<typeof addItemsInputSchema>): Promise<CartView>;
  updateItem(principal: SessionPrincipal, input: z.infer<typeof updateItemInputSchema>): Promise<CartView>;
  removeItem(principal: SessionPrincipal, input: z.infer<typeof removeItemInputSchema>): Promise<CartView>;
  clearCart(principal: SessionPrincipal, input: z.infer<typeof clearCartInputSchema>): Promise<CartView>;
  saveDraftDetails(principal: SessionPrincipal, input: z.infer<typeof saveDraftDetailsInputSchema>): Promise<CartView>;
  checkout(principal: SessionPrincipal, input: z.infer<typeof checkoutInputSchema>): Promise<CheckoutCartResult>;
  getCheckoutStatus(principal: SessionPrincipal, input: z.infer<typeof checkoutTargetInputSchema>): Promise<CheckoutStatusResult>;
  restoreCheckout(principal: SessionPrincipal, input: z.infer<typeof checkoutTargetInputSchema>): Promise<RestoreCheckoutResult>;
  adminListOpen(
    principal: SessionPrincipal,
    input: z.infer<typeof adminListOpenInputSchema>,
  ): Promise<{
    featureEnabled: boolean;
    abandonedTtlHours: number;
    items: AdminOpenCartSummary[];
    nextCursor: string | null;
  }>;
  adminGetOpen(principal: SessionPrincipal, input: z.infer<typeof adminGetOpenInputSchema>): Promise<AdminOpenCartDetail>;
  expireAbandonedCarts(options?: { limit?: number }): Promise<{ expiredCount: number }>;
}
