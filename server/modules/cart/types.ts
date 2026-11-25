/**
 * Public contracts and strict Zod input schemas for Cart, Checkout, Upsell & Promo Codes (Increments 04 & 05, Packages L & B).
 * Owner: recovery_ops_engineer.
 *
 * Security rule (§4): Every input schema uses `.strict()` and explicit bounds. Clients never submit
 * prices, discounts, tax rates, or totals as authoritative values; any extra field is rejected with `BAD_INPUT`.
 */
import { z } from "zod";
import type { ModuleLifecycle, SessionPrincipal, Tx } from "../../core/types.js";
import type { PublishedPolicyView } from "../compliance/index.js";

const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "Identifier format is not valid.");
const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/, "Idempotency key is not valid.");

/** Plain-text string with NFC normalisation and control-character rejection (rendered strictly as text). */
const nfcTrim = (min: number, max: number) =>
  z
    .string()
    .transform((value) => value.normalize("NFC").trim())
    .pipe(
      z
        .string()
        .min(min)
        .max(max)
        // eslint-disable-next-line no-control-regex
        .refine((v) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(v), {
          message: "Control characters are not allowed.",
        }),
    );

const nfcOptional = (max: number) =>
  z
    .string()
    .transform((value) => value.normalize("NFC").trim())
    .pipe(
      z
        .string()
        .max(max)
        // eslint-disable-next-line no-control-regex
        .refine((v) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(v), {
          message: "Control characters are not allowed.",
        }),
    );

export const BUNDLE_COMPLETION_OFFER_KEY = "bundle_completion" as const;

export const upsellOfferIdentifierSchema = z.union([
  ulidSchema,
  z.literal(BUNDLE_COMPLETION_OFFER_KEY),
]);

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

/** Raw promotional code input (bounded, printable; normalised by `promotions`; NEVER written to logs). */
export const applyCodeInputSchema = z
  .object({
    code: nfcTrim(1, 64),
    idempotencyKey: idempotencyKeySchema.optional(),
  })
  .strict();

export const removeCodeInputSchema = z
  .object({
    expectedVersion: z.number().int().min(1).max(1_000_000_000).optional(),
  })
  .strict()
  .optional()
  .default({});

export const acceptUpsellInputSchema = z
  .object({
    offerPublicId: upsellOfferIdentifierSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

export const dismissUpsellInputSchema = z
  .object({
    offerPublicId: upsellOfferIdentifierSchema,
  })
  .strict();

export const adminUpsellRuleTypeSchema = z.enum(["standard", "next_packet", "bundle_completion"]);

export const adminUpsellOfferFieldsSchema = z
  .object({
    kind: z.enum(["add_on", "tier_upgrade"]),
    ruleType: adminUpsellRuleTypeSchema.optional().default("standard"),
    title: nfcTrim(1, 120),
    shortText: nfcTrim(1, 200),
    triggerMode: z.enum(["any_cart", "products"]),
    triggerProductPublicIds: z.array(ulidSchema).max(50).optional().default([]),
    targetProductPublicId: ulidSchema,
    priority: z.number().int().min(1).max(9999).optional().default(100),
    active: z.boolean().optional().default(true),
    startsAt: z.date().nullable().optional().default(null),
    endsAt: z.date().nullable().optional().default(null),
  })
  .strict()
  .refine((val) => val.triggerMode === "any_cart" || val.triggerProductPublicIds.length > 0, {
    message: "Select at least one trigger product, or switch trigger mode to any cart.",
  })
  .refine((val) => !val.startsAt || !val.endsAt || val.endsAt.getTime() > val.startsAt.getTime(), {
    message: "End time must be after start time.",
  });

export const adminUpsellCreateInputSchema = adminUpsellOfferFieldsSchema;

export const adminUpsellUpdateInputSchema = z
  .object({
    offerPublicId: ulidSchema,
    expectedVersion: z.number().int().min(1).max(1_000_000_000),
    kind: z.enum(["add_on", "tier_upgrade"]),
    ruleType: adminUpsellRuleTypeSchema.optional(),
    title: nfcTrim(1, 120),
    shortText: nfcTrim(1, 200),
    triggerMode: z.enum(["any_cart", "products"]),
    triggerProductPublicIds: z.array(ulidSchema).max(50).optional().default([]),
    targetProductPublicId: ulidSchema,
    priority: z.number().int().min(1).max(9999),
    active: z.boolean(),
    startsAt: z.date().nullable().optional().default(null),
    endsAt: z.date().nullable().optional().default(null),
  })
  .strict()
  .refine((val) => val.triggerMode === "any_cart" || val.triggerProductPublicIds.length > 0, {
    message: "Select at least one trigger product, or switch trigger mode to any cart.",
  })
  .refine((val) => !val.startsAt || !val.endsAt || val.endsAt.getTime() > val.startsAt.getTime(), {
    message: "End time must be after start time.",
  });

export const adminUpsellSetActiveInputSchema = z
  .object({
    offerPublicId: ulidSchema,
    expectedVersion: z.number().int().min(1).max(1_000_000_000),
    active: z.boolean(),
  })
  .strict();

export const adminUpsellSetFeatureInputSchema = z
  .object({
    enabled: z.boolean(),
    alsoEnableCart: z.boolean().optional().default(false),
  })
  .strict();

export const adminUpsellSetAllActiveInputSchema = z
  .object({
    active: z.boolean(),
  })
  .strict();

export const adminUpsellDuplicateInputSchema = z
  .object({
    offerPublicId: ulidSchema,
  })
  .strict();

export const adminUpsellDeleteInputSchema = z
  .object({
    offerPublicId: ulidSchema,
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
    /** Optional client-observed grand total guard so price/promo changes require explicit customer re-confirmation. */
    expectedTotalMinor: z.number().int().min(0).max(1_000_000_000_000).optional(),
    projectName: nfcTrim(1, 160),
    note: nfcOptional(4000).optional().default(""),
    billing: billingDetailsSchema,
    policyAcceptances: z.array(policyAcceptanceInputSchema).max(25).optional().default([]),
    idempotencyKey: idempotencyKeySchema,
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

export interface CartAppliedPromoView {
  promoPublicId: string;
  label: string;
  promoDiscountMinor: number;
  bundleDiscountMinor: number;
}

export interface CartPromoNoticeView {
  reasonCode: string;
  message: string;
  previousLabel: string | null;
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
  promo: CartAppliedPromoView | null;
}

export type CartUpsellKind = "add_on" | "tier_upgrade" | "bundle_completion";

export interface CartUpsellTargetProductView {
  productPublicId: string;
  name: string;
  groupName: string;
  packetNumber: number | null;
  tier: PacketTierName | null;
  unitPriceMinor: number;
  currency: string;
}

export interface CartUpsellSuggestionView {
  offerPublicId: string;
  kind: CartUpsellKind;
  title: string;
  shortText: string;
  currency: string;
  /** Net incremental price in minor units (`unitPriceMinor` for add-on, `+delta` for tier upgrade, net after saving for bundle completion). */
  priceMinor: number;
  /** Unadjusted sum of target product price(s) in minor units. */
  fullTargetPriceMinor: number;
  /** Computed bundle discount unlocked in minor units (`bundle_completion` only; null otherwise). */
  savingMinor: number | null;
  targetProducts: CartUpsellTargetProductView[];
  currentProduct: {
    productPublicId: string;
    name: string;
    packetNumber: number | null;
    tier: PacketTierName | null;
    unitPriceMinor: number;
  } | null;
}

export interface CartSmallTotalEvaluationView {
  minimumMinor: number;
  belowMinimum: boolean;
  smallTotalAction: "none" | "zero_total" | "waive" | "block";
}

export interface CartPlaceOrderAgreementView {
  required: boolean;
  met: boolean;
  policyPublicId: string | null;
  signatureMode: "checkbox" | "typed_name";
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
  upsells: CartUpsellSuggestionView[];
  promotionsEnabled: boolean;
  promoNotice: CartPromoNoticeView | null;
  paymentProvider: "none" | "stripe" | "square";
  paymentEnvironment: "test" | "live";
  onlinePaymentEnabled: boolean;
  smallTotalEvaluation: CartSmallTotalEvaluationView | null;
  pendingPolicies: PublishedPolicyView[];
  placeOrderAgreement?: CartPlaceOrderAgreementView;
  updatedAt: Date | null;
}

export interface AdminCartUpsellCatalogProductView {
  productPublicId: string;
  name: string;
  groupName: string;
  packetNumber: number | null;
  tier: PacketTierName | null;
  priceMinor: number;
  currency: string;
  active: boolean;
  canBeTierUpgradeTarget: boolean;
}

export interface AdminCartUpsellOfferView {
  offerPublicId: string;
  version: number;
  seedKey: string | null;
  kind: "add_on" | "tier_upgrade";
  ruleType: "standard" | "next_packet" | "bundle_completion";
  title: string;
  shortText: string;
  triggerMode: "any_cart" | "products";
  triggerProductPublicIds: string[];
  triggerProductNames: string[];
  targetProductPublicId: string;
  targetProductName: string;
  targetProductAvailable: boolean;
  targetProductPriceMinor: number | null;
  targetProductCurrency: string | null;
  priority: number;
  active: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  shownCount: number;
  acceptedCount: number;
  dismissedCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminCartUpsellsListResult {
  featureCartEnabled: boolean;
  featureUpsellEnabled: boolean;
  bundleRuleEnabled: boolean;
  bundleRuleLabel: string | null;
  offers: AdminCartUpsellOfferView[];
  catalogProducts: AdminCartUpsellCatalogProductView[];
}

export type CheckoutCartResult =
  | {
      mode: "no_payment_due";
      cartPublicId: string;
      orderPublicId: string;
      orderReference: string;
      invoicePublicId: string;
      invoiceNumber: string;
      currency: string;
      totalMinor: 0;
      receiptPublicId?: string | null;
    }
  | {
      mode: "waived_small_total";
      cartPublicId: string;
      orderPublicId: string;
      orderReference: string;
      invoicePublicId: string;
      invoiceNumber: string;
      currency: string;
      totalMinor: number;
      waivedMinor: number;
      receiptPublicId?: string | null;
    }
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
  | "no_payment_due"
  | "invoice_issued"
  | "cancelled"
  | "failed";

export interface CheckoutStatusResult {
  cartPublicId: string;
  confirmationState: CheckoutConfirmationState;
  paymentMode: "invoice" | "redirect" | "no_payment_due" | "waived_small_total";
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
  promoDiscountMinor: number;
  promoLabel: string | null;
  taxRateBps: number;
  taxMinor: number;
  totalMinor: number;
  waivedMinor: number;
  balanceDueMinor: number;
  receiptPublicId?: string | null;
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

export interface CartInvoicePaidInput {
  invoicePublicId: string;
  orderPublicId?: string;
  paidAt?: Date;
}

export interface CartInvoicePaidResult {
  transitioned: boolean;
  cartPublicId: string | null;
}

export interface CartModule extends ModuleLifecycle {
  init(): void;
  /** Increment 07 (D9): trusted transactional callback invoked by `compliance` when an invoice becomes paid. */
  onInvoicePaidInTx(input: CartInvoicePaidInput, tx: Tx): Promise<CartInvoicePaidResult>;
  getBadgeCount(principal: SessionPrincipal): Promise<{ enabled: boolean; itemCount: number }>;
  getMyCart(principal: SessionPrincipal): Promise<CartView>;
  addItems(principal: SessionPrincipal, input: z.infer<typeof addItemsInputSchema>): Promise<CartView>;
  updateItem(principal: SessionPrincipal, input: z.infer<typeof updateItemInputSchema>): Promise<CartView>;
  removeItem(principal: SessionPrincipal, input: z.infer<typeof removeItemInputSchema>): Promise<CartView>;
  clearCart(principal: SessionPrincipal, input: z.infer<typeof clearCartInputSchema>): Promise<CartView>;
  saveDraftDetails(principal: SessionPrincipal, input: z.infer<typeof saveDraftDetailsInputSchema>): Promise<CartView>;
  applyCode(principal: SessionPrincipal, input: z.infer<typeof applyCodeInputSchema>): Promise<CartView>;
  removeCode(principal: SessionPrincipal, input?: z.infer<typeof removeCodeInputSchema>): Promise<CartView>;
  acceptUpsell(principal: SessionPrincipal, input: z.infer<typeof acceptUpsellInputSchema>): Promise<CartView>;
  dismissUpsell(principal: SessionPrincipal, input: z.infer<typeof dismissUpsellInputSchema>): Promise<CartView>;
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
  adminListUpsellOffers(principal: SessionPrincipal): Promise<AdminCartUpsellsListResult>;
  adminCreateUpsellOffer(
    principal: SessionPrincipal,
    input: z.infer<typeof adminUpsellCreateInputSchema>,
  ): Promise<AdminCartUpsellOfferView>;
  adminUpdateUpsellOffer(
    principal: SessionPrincipal,
    input: z.infer<typeof adminUpsellUpdateInputSchema>,
  ): Promise<AdminCartUpsellOfferView>;
  adminSetUpsellOfferActive(
    principal: SessionPrincipal,
    input: z.infer<typeof adminUpsellSetActiveInputSchema>,
  ): Promise<AdminCartUpsellOfferView>;
  adminSetUpsellFeature(
    principal: SessionPrincipal,
    input: z.infer<typeof adminUpsellSetFeatureInputSchema>,
  ): Promise<{ featureCartEnabled: boolean; featureUpsellEnabled: boolean }>;
  adminSetAllUpsellOffersActive(
    principal: SessionPrincipal,
    input: z.infer<typeof adminUpsellSetAllActiveInputSchema>,
  ): Promise<{ active: boolean; updatedCount: number; skippedUnavailableCount: number }>;
  adminSeedSuggestedUpsellOffers(
    principal: SessionPrincipal,
  ): Promise<{ addedCount: number; skippedExistingCount: number }>;
  adminDuplicateUpsellOffer(
    principal: SessionPrincipal,
    input: z.infer<typeof adminUpsellDuplicateInputSchema>,
  ): Promise<AdminCartUpsellOfferView>;
  adminDeleteUpsellOffer(
    principal: SessionPrincipal,
    input: z.infer<typeof adminUpsellDeleteInputSchema>,
  ): Promise<{ deleted: true; offerPublicId: string }>;
  ensureDefaultUpsellOffers(): Promise<{ addedCount: number; skippedExistingCount: number }>;
  expireAbandonedCarts(options?: { limit?: number }): Promise<{ expiredCount: number }>;
}
