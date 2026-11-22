/**
 * The narrow slices of peer modules that orders calls, resolved at call time from `deps.services`.
 * A missing method fails closed (UNAVAILABLE) instead of silently skipping a security step.
 */
import { DomainError } from "../../core/errors.js";
import type { DbOrTx, Tx } from "../../core/types.js";
import type { Services } from "../../container.js";
import type { UserRole } from "../../../shared/domain.js";

export interface OrdersUserView {
  id: number;
  publicId: string;
  role: UserRole;
  status: string;
  email: string;
  name: string;
  customerRef: string | null;
}

export interface IdentityPort {
  getUser(userId: number, opts?: { tx?: DbOrTx; forUpdate?: boolean }): Promise<OrdersUserView | null>;
  getUserByPublicId(publicId: string, opts?: { tx?: DbOrTx; forUpdate?: boolean }): Promise<OrdersUserView | null>;
}

export interface FilesPort {
  reassignOrderFiles(orderId: number, ownerUserId: number, tx: Tx): Promise<void>;
}

export interface EngagementPort {
  notify(input: { userId: number; kind: string; title: string; body: string; link?: string; idempotencyKey?: string; skipEmail?: boolean }, tx?: Tx): Promise<unknown>;
}

const unavailable = (reason: string) =>
  new DomainError("UNAVAILABLE", reason, "This action is temporarily unavailable. Please try again later.");

function method<T>(holder: unknown, name: string): T | null {
  if (holder && typeof (holder as Record<string, unknown>)[name] === "function") {
    const fn = (holder as Record<string, (...args: unknown[]) => unknown>)[name]!;
    return fn.bind(holder) as T;
  }
  return null;
}

export function identityPort(services: Services): IdentityPort {
  const holder = (services as Partial<Services>).identity;
  const getUser = method<IdentityPort["getUser"]>(holder, "getUser");
  const getUserByPublicId = method<IdentityPort["getUserByPublicId"]>(holder, "getUserByPublicId");
  if (!getUser || !getUserByPublicId) throw unavailable("IDENTITY_UNAVAILABLE");
  return { getUser, getUserByPublicId };
}

export function filesPort(services: Services): FilesPort {
  const fn = method<FilesPort["reassignOrderFiles"]>((services as Partial<Services>).files, "reassignOrderFiles");
  if (!fn) throw unavailable("FILES_UNAVAILABLE");
  return { reassignOrderFiles: fn };
}

/** Notifications are best-effort side channels; absence is tolerated (returns null). */
export function engagementPort(services: Services): EngagementPort | null {
  const fn = method<EngagementPort["notify"]>((services as Partial<Services>).engagement, "notify");
  return fn ? { notify: fn } : null;
}

export interface CompliancePort {
  assertRequiredPoliciesAccepted(userId: number, opts?: { audience?: "customer" | "staff"; tx?: DbOrTx }): Promise<void>;
}

/** Policy-acceptance gate for order creation. Absent compliance module ⇒ null (gate not installed). */
export function compliancePort(services: Services): CompliancePort | null {
  const fn = method<CompliancePort["assertRequiredPoliciesAccepted"]>((services as Partial<Services>).compliance, "assertRequiredPoliciesAccepted");
  return fn ? { assertRequiredPoliciesAccepted: fn } : null;
}

/**
 * Increment 05 (C3, /root decision G-C3-02): authoritative payment exposure of one order from compliance (billing),
 * read in the cancelling transaction with the order's invoices locked. Not the display summary. Partial payments
 * count in grossPaidMinor. Absent ⇒ null ⇒ orders never releases a redemption automatically (fail closed).
 */
export interface OrderPaymentExposure {
  grossPaidMinor: number;
  payableInvoiceOpen: boolean;
  providerCapturePending: boolean;
}
export type OrderPaymentExposurePort = (tx: Tx, orderPublicId: string) => Promise<OrderPaymentExposure>;
export function paymentExposurePort(services: Services): OrderPaymentExposurePort | null {
  return method<OrderPaymentExposurePort>((services as Partial<Services>).compliance, "orderPaymentExposureInTx");
}

/** True only for a well-formed answer proving nothing was paid and nothing can still be captured. */
export function releaseIsSafe(exposure: unknown): boolean {
  if (!exposure || typeof exposure !== "object") return false;
  const e = exposure as Partial<OrderPaymentExposure>;
  return e.grossPaidMinor === 0 && e.payableInvoiceOpen === false && e.providerCapturePending === false;
}

/* ---------------- Increment 05 (C3): promotions port, binding signatures from INCREMENT_05_CONTRACT §3 ---------------- */

export interface PromotionLine {
  productPublicId: string;
  packetNumber: number | null;
  tierKey: string | null;
  lineTotalMinor: number;
}
export interface PromotionContext {
  /** Raw input; normalised by promotions. Never logged. */
  code: string;
  /** The order owner, not the actor. */
  customerUserId: number;
  actorUserId: number;
  currency: string;
  lines: readonly PromotionLine[];
  subtotalMinor: number;
  /** 0 when the bundle rule did not apply. */
  bundleDiscountMinor: number;
  bundleLabel: string | null;
}
export interface PromotionOutcome {
  promoPublicId: string;
  /** Customer-facing label. */
  label: string;
  /** The part due to the code. */
  promoDiscountMinor: number;
  /** May be 0 when the code replaced the bundle discount. */
  bundleDiscountMinor: number;
  /** Total discount to store on the order. */
  discountMinor: number;
  /** Combined label for order and invoice. */
  discountLabel: string;
  totalMinor: number;
}
export interface PromotionsPort {
  preview(ctx: PromotionContext, opts?: { tx?: DbOrTx }): Promise<PromotionOutcome>;
  redeemInTx(tx: Tx, ctx: PromotionContext & { orderPublicId: string; correlationId: string }): Promise<PromotionOutcome>;
  releaseForOrderInTx(tx: Tx, input: { orderPublicId: string; reason: "order_cancelled" }): Promise<{ released: boolean }>;
  /** Optional: `feature.promotions`. When present and false, orders refuses codes with the uniform error. */
  isEnabled?(opts?: { tx?: DbOrTx }): Promise<boolean>;
}

/** The one message for every refusal that must not reveal whether a code exists (contract D3). */
export const promoNotApplicable = () => new DomainError("VALIDATION", "PROMO_NOT_APPLICABLE", "This code cannot be applied.");

/** Promotions module, or null when it is absent (callers refuse a code with the uniform error). */
export function promotionsPort(services: Services): PromotionsPort | null {
  const holder: unknown = (services as unknown as Partial<Record<string, unknown>>).promotions;
  const preview = method<PromotionsPort["preview"]>(holder, "preview");
  const redeemInTx = method<PromotionsPort["redeemInTx"]>(holder, "redeemInTx");
  const releaseForOrderInTx = method<PromotionsPort["releaseForOrderInTx"]>(holder, "releaseForOrderInTx");
  if (!preview || !redeemInTx || !releaseForOrderInTx) return null;
  const isEnabled = method<NonNullable<PromotionsPort["isEnabled"]>>(holder, "isEnabled");
  return { preview, redeemInTx, releaseForOrderInTx, ...(isEnabled ? { isEnabled } : {}) };
}

/** Port for a code, or the uniform refusal when the module is absent or `feature.promotions` is off. */
export async function requirePromotions(services: Services, tx?: DbOrTx): Promise<PromotionsPort> {
  const port = promotionsPort(services);
  if (!port) throw promoNotApplicable();
  if (port.isEnabled && !(await port.isEnabled(tx ? { tx } : undefined))) throw promoNotApplicable();
  return port;
}
