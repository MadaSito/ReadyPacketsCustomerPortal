/**
 * Narrow runtime-verified peer ports and pure server-side pricing helpers for Cart & Checkout.
 * Owner: recovery_ops_engineer.
 *
 * Every external capability is resolved dynamically from `deps.services` at call time and fails closed
 * (`UNAVAILABLE` / `FORBIDDEN` / uniform `PROMO_NOT_APPLICABLE`) if missing.
 */
import { STEP_UP_CAPABILITIES, roleHasCapability, type Capability } from "../../../shared/capabilities.js";
import type { UserRole } from "../../../shared/domain.js";
import type { Services } from "../../container.js";
import { DomainError, forbidden, validation } from "../../core/errors.js";
import type { Clock, DbOrTx, SessionPrincipal, Tx } from "../../core/types.js";
import { STEP_UP_MAX_AGE_MS } from "../../trpc/trpc.js";
import type { PublishedPolicyView } from "../compliance/index.js";
import type { CatalogGroupView } from "../orders/catalog.js";
import type { BundleRule } from "../orders/settings.js";
import type { CartBundleQuoteView } from "./types.js";

export interface PersistedAuthority {
  pendingSteps: readonly unknown[];
  role: SessionPrincipal["role"];
  stepUpAt: Date | null;
}

export type CartActorCheck = (principal: SessionPrincipal, tx: Tx, capability?: Capability) => Promise<PersistedAuthority>;

const unavailable = (reason: string, safeMessage = "This checkout service is temporarily unavailable. Please try again shortly.") =>
  new DomainError("UNAVAILABLE", reason, safeMessage);

function method<T>(holder: unknown, name: string): T | null {
  if (holder && typeof (holder as Record<string, unknown>)[name] === "function") {
    const fn = (holder as Record<string, (...args: unknown[]) => unknown>)[name]!;
    return fn.bind(holder) as T;
  }
  return null;
}

/**
 * In-transaction actor re-validation (`users` -> `user_sessions`).
 * Must be called BEFORE locking `carts` so lock order matches `orders` and `compliance`.
 */
export function createCartActorCheck(services: Services, clock: Clock): CartActorCheck {
  return async (principal, tx, capability) => {
    const identityHolder = (services as Partial<Services>).identity as unknown as {
      sessions?: { assertCurrent?: (p: SessionPrincipal, t: Tx) => Promise<PersistedAuthority> };
    } | undefined;
    const assertCurrent = identityHolder?.sessions?.assertCurrent;
    if (typeof assertCurrent !== "function") throw forbidden("ACTOR_UNVERIFIABLE");
    const current = await assertCurrent.call(identityHolder!.sessions, principal, tx);
    if (current.pendingSteps.length > 0) {
      throw new DomainError("REMEDIATION_REQUIRED", "ACCOUNT_STEP_PENDING", "Please finish securing your account to continue.");
    }
    if (current.role !== principal.role) throw forbidden("ACTOR_NOT_AUTHORIZED");
    if (capability) {
      if (!roleHasCapability(current.role, capability)) throw forbidden("ACTOR_NOT_AUTHORIZED");
      if (STEP_UP_CAPABILITIES.has(capability)) {
        const at = current.stepUpAt?.getTime();
        if (at === undefined || clock.now().getTime() - at > STEP_UP_MAX_AGE_MS) {
          throw new DomainError("STEP_UP_REQUIRED", "STEP_UP_REQUIRED", "Please confirm your password and authentication code to continue.");
        }
      }
    }
    return current;
  };
}

export interface CartIdentityUser {
  id: number;
  publicId: string;
  role: UserRole;
  status: string;
  email: string;
  name: string;
  customerRef: string | null;
}

export interface CartIdentityPort {
  getUser(userId: number, opts?: { tx?: DbOrTx; forUpdate?: boolean }): Promise<CartIdentityUser | null>;
}

export function cartIdentityPort(services: Services): CartIdentityPort {
  const getUser = method<CartIdentityPort["getUser"]>((services as Partial<Services>).identity, "getUser");
  if (!getUser) throw unavailable("IDENTITY_UNAVAILABLE");
  return { getUser };
}

export interface CreatedCheckoutOrder {
  id: number;
  publicId: string;
  reference: string;
  created: boolean;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  discountLabel: string | null;
  promoDiscountMinor?: number;
  promoLabel?: string | null;
  totalMinor: number;
  lineItems: {
    productPublicId: string;
    name: string;
    quantity: number;
    unitPriceMinor: number;
    lineTotalMinor: number;
    currency: string;
  }[];
  afterCommit: () => Promise<void>;
}

export interface CartOrdersPort {
  listActiveCatalog(tx?: Tx, opts?: { forShare?: boolean }): Promise<CatalogGroupView[]>;
  getBundleRule(tx?: Tx): Promise<BundleRule>;
  createOrderFromCheckoutInTx(
    principal: SessionPrincipal,
    input: {
      projectName: string;
      items: { productPublicId: string; quantity: number }[];
      note?: string;
      idempotencyKey: string;
      promoCode?: string;
    },
    tx: Tx,
  ): Promise<CreatedCheckoutOrder>;
}

export function cartOrdersPort(services: Services): CartOrdersPort {
  const ordersMod = (services as Partial<Services>).orders as Record<string, unknown> | undefined;
  const catalogHolder = ordersMod?.catalog;
  const innerOrdersHolder = ordersMod?.orders;

  const listActiveCatalog = method<CartOrdersPort["listActiveCatalog"]>(catalogHolder, "listActive");
  const getBundleRule = method<CartOrdersPort["getBundleRule"]>(catalogHolder, "getBundleRule");
  const createOrderFromCheckoutInTx =
    method<CartOrdersPort["createOrderFromCheckoutInTx"]>(ordersMod, "createOrderFromCheckoutInTx") ??
    method<CartOrdersPort["createOrderFromCheckoutInTx"]>(innerOrdersHolder, "createOrderFromCheckoutInTx");

  if (!listActiveCatalog || !getBundleRule) {
    throw unavailable("ORDERS_CATALOG_UNAVAILABLE");
  }
  return {
    listActiveCatalog,
    getBundleRule,
    async createOrderFromCheckoutInTx(principal, input, tx) {
      if (!createOrderFromCheckoutInTx) throw unavailable("ORDERS_CHECKOUT_PORT_UNAVAILABLE");
      return createOrderFromCheckoutInTx(principal, input, tx);
    },
  };
}

/* ---------------- Increment 05 (D3 / §3): promotions port ---------------- */

export interface CartPromotionLine {
  productPublicId: string;
  packetNumber: number | null;
  tierKey: string | null;
  lineTotalMinor: number;
}

export interface CartPromotionContext {
  /** Raw input; normalised by `promotions`. Never logged. */
  code: string;
  customerUserId: number;
  actorUserId: number;
  currency: string;
  lines: readonly CartPromotionLine[];
  subtotalMinor: number;
  bundleDiscountMinor: number;
  bundleLabel: string | null;
}

export interface CartPromotionOutcome {
  promoPublicId: string;
  label: string;
  promoDiscountMinor: number;
  bundleDiscountMinor: number;
  discountMinor: number;
  discountLabel: string;
  totalMinor: number;
}

export interface CartPromotionsPort {
  preview(ctx: CartPromotionContext, opts?: { tx?: DbOrTx; recheck?: boolean }): Promise<CartPromotionOutcome>;
  redeemInTx(tx: Tx, ctx: CartPromotionContext & { orderPublicId: string; correlationId: string }): Promise<CartPromotionOutcome>;
  releaseForOrderInTx(tx: Tx, input: { orderPublicId: string; reason: "order_cancelled" }): Promise<{ released: boolean }>;
  isEnabled?(opts?: { tx?: DbOrTx }): Promise<boolean>;
}

/** Uniform customer-facing refusal that never reveals whether a promotional code exists (D3). */
export const promoNotApplicable = () =>
  new DomainError("VALIDATION", "PROMO_NOT_APPLICABLE", "This code cannot be applied.");

export function cartPromotionsPort(services: Services): CartPromotionsPort | null {
  const holder: unknown = (services as unknown as Partial<Record<string, unknown>>).promotions;
  const preview = method<CartPromotionsPort["preview"]>(holder, "preview");
  const redeemInTx = method<CartPromotionsPort["redeemInTx"]>(holder, "redeemInTx");
  const releaseForOrderInTx = method<CartPromotionsPort["releaseForOrderInTx"]>(holder, "releaseForOrderInTx");
  if (!preview || !redeemInTx || !releaseForOrderInTx) return null;
  const isEnabled = method<NonNullable<CartPromotionsPort["isEnabled"]>>(holder, "isEnabled");
  return { preview, redeemInTx, releaseForOrderInTx, ...(isEnabled ? { isEnabled } : {}) };
}

export async function isPromotionsEnabledForCart(services: Services, tx?: DbOrTx): Promise<boolean> {
  const port = cartPromotionsPort(services);
  if (!port) return false;
  if (port.isEnabled) {
    return port.isEnabled(tx ? { tx } : undefined);
  }
  return true;
}

export async function requireCartPromotionsPort(services: Services, tx?: DbOrTx): Promise<CartPromotionsPort> {
  const port = cartPromotionsPort(services);
  if (!port) throw promoNotApplicable();
  if (port.isEnabled && !(await port.isEnabled(tx ? { tx } : undefined))) {
    throw promoNotApplicable();
  }
  return port;
}

/** Fail-closed arithmetic verification of `PromotionOutcome` before any cart display or write. */
export function assertValidPromotionOutcome(outcome: CartPromotionOutcome, subtotalMinor: number): void {
  const ints = [
    outcome.promoDiscountMinor,
    outcome.bundleDiscountMinor,
    outcome.discountMinor,
    outcome.totalMinor,
  ];
  if (
    !outcome.promoPublicId ||
    typeof outcome.label !== "string" ||
    outcome.label.trim().length === 0 ||
    typeof outcome.discountLabel !== "string" ||
    outcome.discountLabel.trim().length === 0 ||
    ints.some((n) => !Number.isSafeInteger(n) || n < 0) ||
    outcome.discountMinor > subtotalMinor ||
    outcome.promoDiscountMinor + outcome.bundleDiscountMinor !== outcome.discountMinor ||
    subtotalMinor - outcome.discountMinor !== outcome.totalMinor
  ) {
    throw promoNotApplicable();
  }
}

export interface CartCompliancePort {
  requiredAcceptancesFor(
    userId: number,
    opts?: { audience?: "customer" | "staff" | "admin"; tx?: DbOrTx },
  ): Promise<PublishedPolicyView[]>;
  assertRequiredPoliciesAccepted(
    userId: number,
    opts?: { audience?: "customer" | "staff" | "admin"; tx?: DbOrTx },
  ): Promise<void>;
  quoteTaxMinor(
    input: {
      subtotalAfterDiscountMinor: number;
      currency: string;
      billingCountry?: string | null;
      billingRegion?: string | null;
    },
    tx?: DbOrTx,
  ): Promise<{ taxRateBps: number; taxMinor: number }>;
  recordCheckoutAcceptances(
    input: {
      principal: SessionPrincipal;
      orderId?: number;
      orderPublicId?: string;
      items: readonly { versionPublicId: string; contentHash: string; signerName?: string }[];
    },
    tx: Tx,
  ): Promise<{ recorded: number }>;
  issueCheckoutInvoiceInTx(
    input: {
      principal: SessionPrincipal;
      orderId?: number;
      orderPublicId: string;
      currency: string;
      lines: readonly {
        description: string;
        quantity: number;
        unitAmountMinor: number;
        productKey?: string;
        tierKey?: string;
      }[];
      discountMinor: number;
      taxMinor?: number;
      dueAt?: Date;
      memo?: string;
    },
    tx: Tx,
  ): Promise<{
    invoiceId: number;
    invoicePublicId: string;
    invoiceNumber: string;
    orderId: number;
    orderPublicId: string;
    currency: string;
    subtotalMinor: number;
    discountMinor: number;
    taxMinor: number;
    totalMinor: number;
    issuedAt: Date;
  }>;
}

export function cartCompliancePort(services: Services): CartCompliancePort {
  const complianceMod = (services as Partial<Services>).compliance as Record<string, unknown> | undefined;
  const requiredAcceptancesFor = method<CartCompliancePort["requiredAcceptancesFor"]>(complianceMod, "requiredAcceptancesFor");
  const assertRequiredPoliciesAccepted = method<CartCompliancePort["assertRequiredPoliciesAccepted"]>(
    complianceMod,
    "assertRequiredPoliciesAccepted",
  );
  const quoteTaxMinor = method<CartCompliancePort["quoteTaxMinor"]>(complianceMod, "quoteTaxMinor");
  const recordCheckoutAcceptances = method<CartCompliancePort["recordCheckoutAcceptances"]>(
    complianceMod,
    "recordCheckoutAcceptances",
  );
  const issueCheckoutInvoiceInTx = method<CartCompliancePort["issueCheckoutInvoiceInTx"]>(
    complianceMod,
    "issueCheckoutInvoiceInTx",
  );

  if (!requiredAcceptancesFor || !assertRequiredPoliciesAccepted) {
    throw unavailable("COMPLIANCE_POLICIES_UNAVAILABLE");
  }

  return {
    requiredAcceptancesFor,
    assertRequiredPoliciesAccepted,
    async quoteTaxMinor(input, tx) {
      if (!quoteTaxMinor) return { taxRateBps: 0, taxMinor: 0 };
      return quoteTaxMinor(input, tx);
    },
    async recordCheckoutAcceptances(input, tx) {
      if (!recordCheckoutAcceptances) throw unavailable("COMPLIANCE_CHECKOUT_ACCEPTANCE_UNAVAILABLE");
      return recordCheckoutAcceptances(input, tx);
    },
    async issueCheckoutInvoiceInTx(input, tx) {
      if (!issueCheckoutInvoiceInTx) throw unavailable("COMPLIANCE_CHECKOUT_INVOICE_UNAVAILABLE");
      return issueCheckoutInvoiceInTx(input, tx);
    },
  };
}

export interface CartPaymentsPort {
  isOnlineCheckoutEnabled(tx?: DbOrTx): Promise<boolean>;
  getPublicCheckoutConfig(tx?: DbOrTx): Promise<{
    provider: "none" | "stripe" | "square";
    mode: "test" | "live";
    currency: string;
  }>;
  startCheckout(
    invoicePublicId: string,
    returnPaths?: { successPath?: string; cancelPath?: string },
    options?: {
      principal?: SessionPrincipal;
      cartPublicId?: string;
      idempotencyKey?: string;
    },
  ): Promise<
    | { mode: "invoice"; invoicePublicId: string }
    | {
        mode: "redirect";
        attemptPublicId: string;
        invoicePublicId: string;
        provider: "stripe" | "square";
        environment: "test" | "live";
        redirectUrl: string;
        expiresAt: Date | null;
      }
  >;
  getCheckoutStatus(
    principal: SessionPrincipal,
    query: { invoicePublicId?: string; attemptPublicId?: string },
  ): Promise<{
    invoicePublicId: string;
    invoiceNumber: string | null;
    invoiceStatus: "draft" | "issued" | "paid" | "void";
    amountMinor: number;
    balanceDueMinor: number;
    currency: string;
    providerConfigured: "none" | "stripe" | "square";
    environment: "test" | "live";
    attempt: {
      attemptPublicId: string;
      provider: "stripe" | "square";
      environment: "test" | "live";
      status: "created" | "redirected" | "paid" | "failed" | "expired" | "cancelled";
      cartPublicId: string | null;
      amountMinor: number;
      currency: string;
      createdAt: Date;
      redirectedAt: Date | null;
      paidAt: Date | null;
      expiresAt: Date | null;
      failureReasonCode: string | null;
    } | null;
  }>;
  cancelAttemptIfUnpaid(
    principal: SessionPrincipal,
    target: { invoicePublicId?: string; attemptPublicId?: string },
    tx?: Tx,
  ): Promise<{
    cancelled: boolean;
    attemptPublicId: string | null;
    status: "created" | "redirected" | "paid" | "failed" | "expired" | "cancelled" | null;
  }>;
}

export function cartPaymentsPort(services: Services): CartPaymentsPort {
  const paymentsMod = (services as unknown as Record<string, unknown>).payments as Record<string, unknown> | undefined;
  const isOnlineCheckoutEnabled = method<CartPaymentsPort["isOnlineCheckoutEnabled"]>(paymentsMod, "isOnlineCheckoutEnabled");
  const getPublicCheckoutConfig = method<CartPaymentsPort["getPublicCheckoutConfig"]>(paymentsMod, "getPublicCheckoutConfig");
  const startCheckout = method<CartPaymentsPort["startCheckout"]>(paymentsMod, "startCheckout");
  const getCheckoutStatus = method<CartPaymentsPort["getCheckoutStatus"]>(paymentsMod, "getCheckoutStatus");
  const cancelAttemptIfUnpaid = method<CartPaymentsPort["cancelAttemptIfUnpaid"]>(paymentsMod, "cancelAttemptIfUnpaid");

  return {
    async isOnlineCheckoutEnabled(tx) {
      if (!isOnlineCheckoutEnabled) return false;
      return isOnlineCheckoutEnabled(tx);
    },
    async getPublicCheckoutConfig(tx) {
      if (!getPublicCheckoutConfig) return { provider: "none", mode: "test", currency: "USD" };
      return getPublicCheckoutConfig(tx);
    },
    async startCheckout(invoicePublicId, returnPaths, options) {
      if (!startCheckout) {
        return { mode: "invoice", invoicePublicId };
      }
      return startCheckout(invoicePublicId, returnPaths, options);
    },
    async getCheckoutStatus(principal, query) {
      if (!getCheckoutStatus) throw unavailable("PAYMENTS_STATUS_UNAVAILABLE");
      return getCheckoutStatus(principal, query);
    },
    async cancelAttemptIfUnpaid(principal, target, tx) {
      if (!cancelAttemptIfUnpaid) {
        return { cancelled: false, attemptPublicId: target.attemptPublicId ?? null, status: null };
      }
      return cancelAttemptIfUnpaid(principal, target, tx);
    },
  };
}

/** Round-half-up percentage of a non-negative integer minor amount (matches `orders/pricing.ts`). */
export function roundHalfUpPercent(amountMinor: number, percent: number): number {
  return Math.floor((amountMinor * percent + 50) / 100);
}

/**
 * Pure server-side cart subtotal + bundle discount calculator.
 * Packet rules (`quantity === 1` and at most one tier per packet) are enforced identically to `orders/pricing.ts`.
 */
export function computeCartBundlePricing(
  lines: readonly { packetNumber: number | null; quantity: number; lineTotalMinor: number }[],
  rule: BundleRule,
): {
  subtotalMinor: number;
  discountMinor: number;
  discountLabel: string | null;
  subtotalAfterDiscountMinor: number;
  bundle: CartBundleQuoteView | null;
} {
  const seenPackets = new Set<number>();
  for (const line of lines) {
    if (line.packetNumber === null) continue;
    if (line.quantity !== 1) throw validation("PACKET_QUANTITY_ONE", "Each packet can be ordered once.");
    if (seenPackets.has(line.packetNumber)) throw validation("PACKET_TIER_CONFLICT", "Choose one tier per packet.");
    seenPackets.add(line.packetNumber);
  }

  const subtotalMinor = lines.reduce((sum, l) => sum + l.lineTotalMinor, 0);
  if (!Number.isSafeInteger(subtotalMinor) || !Number.isSafeInteger(subtotalMinor * 100)) {
    throw validation("AMOUNT_TOO_LARGE", "The cart total is too large.");
  }

  let bundle: CartBundleQuoteView | null = null;
  let discountMinor = 0;
  let discountLabel: string | null = null;

  if (rule.enabled && rule.requiredPacketNumbers.length > 0 && rule.discountPercent > 0) {
    const present = new Set(lines.map((l) => l.packetNumber).filter((n): n is number => n !== null));
    const required = [...rule.requiredPacketNumbers].sort((a, b) => a - b);
    const missingPacketNumbers = required.filter((n) => !present.has(n));
    const applied = missingPacketNumbers.length === 0 && lines.length > 0;
    bundle = {
      enabled: true,
      label: rule.label,
      discountPercent: rule.discountPercent,
      requiredPacketNumbers: required,
      missingPacketNumbers,
      applied,
    };
    if (applied) {
      discountMinor = Math.min(subtotalMinor, roundHalfUpPercent(subtotalMinor, rule.discountPercent));
      discountLabel = rule.label;
    }
  }

  return {
    subtotalMinor,
    discountMinor,
    discountLabel,
    subtotalAfterDiscountMinor: subtotalMinor - discountMinor,
    bundle,
  };
}
