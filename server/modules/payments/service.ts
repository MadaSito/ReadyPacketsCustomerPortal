/**
 * Payments module — Core domain service (Increment 04, Package K).
 * Owner: compliance_engineer.
 *
 * Enforces ADR 0035 & Contract Decision 12:
 *  - Off by default (`provider = "none"` -> `{ mode: "invoice" }`, zero network activity).
 *  - Hosted Stripe Checkout & Square Payment Links over `integrations.egress.fetchPinned`.
 *  - Attempt state machine (`created -> redirected -> paid | failed | expired | cancelled`) guarded by CAS `version`.
 *  - Double-verification invariant: an invoice is booked as paid ONLY when BOTH:
 *      (a) a valid signed, fresh (`<= 300s`), deduplicated webhook is recorded (`verifiedWebhookEventId`), AND
 *      (b) `adapter.fetchPayment` matches `provider`, `mode`/`livemode`, `providerRef`, `amountMinor`, `currency`,
 *          and `invoicePublicId` / `attemptPublicId`.
 *  - Inert return route (`GET /api/payments/return/...`) performs zero DB reads/writes and redirects only to
 *    hardcoded reviewed same-origin paths.
 */
import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, inArray, lt, or } from "drizzle-orm";
import { roleHasCapability } from "../../../shared/capabilities.js";
import type { ModuleDeps } from "../../container.js";
import { conflict, DomainError, forbidden, notFound, validation } from "../../core/errors.js";
import { getRequestContext } from "../../core/requestContext.js";
import { ULID_PATTERN, ulid } from "../../core/ids.js";
import type { DbOrTx, EnqueueOptions, SessionPrincipal, Tx } from "../../core/types.js";
import { assertLiveActorInTx, runComplianceTx } from "../compliance/actorAuth.js";
import { decodeIdCursor, encodeIdCursor, type InvoicePaymentState } from "../compliance/domain.js";
import { complianceInvoicePayments } from "../compliance/schema.js";
import {
  REFUND_NOTICE_TEMPLATE_KEY,
  REFUND_RECONCILE_JOB,
  type RefundReconcileContext,
} from "../jobs/refundSupport.js";
import { isSecretConfigured, readSecret, readSetting, writeSetting } from "../platform/index.js";
import { createSquareProviderAdapter } from "./providers/square.js";
import { createSquareRefundAdapter } from "./providers/square-refund.js";
import { createStripeProviderAdapter, createStripeRefundAdapter } from "./providers/stripe.js";
import type {
  PaymentProviderAdapter,
  PaymentRefundAdapter,
  ProviderCredentials,
  ProviderFetchedPayment,
  ProviderVerifyWebhookOutput,
} from "./providers/types.js";
import {
  type ActivePaymentProvider,
  paymentAttempts,
  type PaymentAttemptRow,
  type PaymentAttemptStatus,
  type PaymentEnvironmentMode,
  type PaymentProviderChoice,
  paymentRefunds,
  type PaymentRefundRow,
  type PaymentRefundStatus,
  paymentWebhookEvents,
  type PaymentWebhookEventRow,
  type PaymentWebhookStatus,
} from "./schema.js";
import {
  DEFAULT_PAYMENTS_RECEIPTS,
  DEFAULT_PAYMENTS_SMALL_TOTALS,
  DEFAULT_PROVIDER_MINIMUMS_MINOR,
  isSafePortalReturnPath,
  maskLast4,
  parsePaymentsReceiptsSetting,
  parsePaymentsSmallTotals,
  PAYMENTS_CONFIG_SETTING,
  type PaymentsConfigValue,
  PAYMENTS_RECEIPTS_SETTING,
  type PaymentsReceiptsValue,
  PAYMENTS_SMALL_TOTALS_SETTING,
  type PaymentsSmallTotalsValue,
  PAYMENTS_SQUARE_ACCESS_TOKEN,
  PAYMENTS_SQUARE_WEBHOOK_SIGNATURE_KEY,
  PAYMENTS_STRIPE_SECRET_KEY,
  PAYMENTS_STRIPE_WEBHOOK_SECRET,
  resolveProviderMinimumMinor,
  sanitizeCardBrand,
  sanitizeCardLast4,
} from "./settings.js";

export interface CheckoutReturnPaths {
  successPath?: string | undefined;
  cancelPath?: string | undefined;
}

export interface StartCheckoutOptions {
  principal?: SessionPrincipal | undefined;
  cartPublicId?: string | undefined;
  idempotencyKey?: string | undefined;
}

export interface CheckoutAmountEvaluation {
  onlineEnabled: boolean;
  provider: PaymentProviderChoice;
  minimumMinor: number;
  belowMinimum: boolean;
  smallTotalAction: "none" | "zero_total" | "waive" | "block";
}

export type StartCheckoutResult =
  | {
      mode: "invoice";
      invoicePublicId: string;
    }
  | {
      mode: "settled";
      settlementKind: "zero_total" | "waived_small_total";
      invoicePublicId: string;
      waivedMinor?: number | undefined;
      receiptPublicId?: string | undefined;
    }
  | {
      mode: "redirect";
      attemptPublicId: string;
      invoicePublicId: string;
      provider: ActivePaymentProvider;
      environment: PaymentEnvironmentMode;
      redirectUrl: string;
      expiresAt: Date | null;
    };

export interface PaymentsPublicConfigView {
  provider: PaymentProviderChoice;
  mode: PaymentEnvironmentMode;
  currency: string;
  onlineEnabled: boolean;
}

export interface CheckoutStatusView {
  invoicePublicId: string;
  invoiceNumber: string | null;
  invoiceStatus: "draft" | "issued" | "paid" | "void";
  amountMinor: number;
  balanceDueMinor: number;
  waivedMinor: number;
  receiptPublicId: string | null;
  currency: string;
  providerConfigured: PaymentProviderChoice;
  environment: PaymentEnvironmentMode;
  attempt: {
    attemptPublicId: string;
    provider: ActivePaymentProvider;
    environment: PaymentEnvironmentMode;
    status: PaymentAttemptStatus;
    cartPublicId: string | null;
    amountMinor: number;
    currency: string;
    createdAt: Date;
    redirectedAt: Date | null;
    paidAt: Date | null;
    expiresAt: Date | null;
    failureReasonCode: string | null;
  } | null;
}

export interface CancelAttemptResult {
  cancelled: boolean;
  attemptPublicId: string | null;
  status: PaymentAttemptStatus | null;
}

export interface PaymentWebhookResult {
  httpStatus: 200 | 400 | 409 | 503;
  accepted: boolean;
  duplicate: boolean;
  booked: boolean;
  reasonCode: string;
}

export interface ReconcilePaymentsResult {
  scanned: number;
  booked: number;
  expired: number;
  failed: number;
  stillPending: number;
}

export interface PaymentsAdminSettingsView
  extends Pick<
    PaymentsConfigValue,
    "provider" | "mode" | "currency" | "successPath" | "cancelPath" | "webhookToleranceSeconds"
  > {
  onlineEnabled: boolean;
  stripe: {
    secretKeyConfigured: boolean;
    secretKeyLast4: string | null;
    webhookSecretConfigured: boolean;
    webhookSecretLast4: string | null;
    webhookUrl: string;
    returnUrlPattern: string;
    egressHost: "api.stripe.com";
    egressAllowlisted: boolean;
  };
  square: {
    locationId: string | null;
    accessTokenConfigured: boolean;
    accessTokenLast4: string | null;
    webhookSignatureKeyConfigured: boolean;
    webhookSignatureKeyLast4: string | null;
    webhookUrl: string;
    returnUrlPattern: string;
    egressHost: "connect.squareup.com" | "connect.squareupsandbox.com";
    egressAllowlisted: boolean;
  };
  smallTotals: PaymentsSmallTotalsValue;
  defaultProviderMinimumsMinor: Readonly<Record<ActivePaymentProvider, Readonly<Record<string, number>>>>;
  receipts: PaymentsReceiptsValue;
}

export interface UpdatePaymentsSettingsInput {
  provider: PaymentProviderChoice;
  mode: PaymentEnvironmentMode;
  currency: string;
  successPath?: string | undefined;
  cancelPath?: string | undefined;
  webhookToleranceSeconds?: number | undefined;
  stripeSecretKey?: string | undefined;
  clearStripeSecretKey?: boolean | undefined;
  stripeWebhookSecret?: string | undefined;
  clearStripeWebhookSecret?: boolean | undefined;
  squareLocationId?: string | null | undefined;
  squareAccessToken?: string | undefined;
  clearSquareAccessToken?: boolean | undefined;
  squareWebhookSignatureKey?: string | undefined;
  clearSquareWebhookSignatureKey?: boolean | undefined;
  smallTotals?: PaymentsSmallTotalsValue | undefined;
  receipts?: PaymentsReceiptsValue | undefined;
}

export interface AdminPaymentAttemptSummary {
  publicId: string;
  attemptPublicId: string;
  invoicePublicId: string;
  orderPublicId: string;
  cartPublicId: string | null;
  provider: ActivePaymentProvider;
  environment: PaymentEnvironmentMode;
  status: PaymentAttemptStatus;
  amountMinor: number;
  currency: string;
  providerRef: string | null;
  providerOrderRef: string | null;
  providerPaymentRef: string | null;
  verifiedWebhookEventId: string | null;
  compliancePaymentPublicId: string | null;
  reconciliationNote: string | null;
  failureReasonCode: string | null;
  redirectedAt: Date | null;
  expiresAt: Date | null;
  paidAt: Date | null;
  cancelledAt: Date | null;
  lastReconciledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminPaymentWebhookSummary {
  publicId: string;
  webhookPublicId: string;
  provider: ActivePaymentProvider;
  environment: PaymentEnvironmentMode;
  externalEventId: string;
  eventType: string;
  attemptPublicId: string | null;
  providerRef: string | null;
  providerOrderRef: string | null;
  providerPaymentRef: string | null;
  status: PaymentWebhookStatus;
  reasonCode: string | null;
  occurredAt: Date;
  receivedAt: Date;
  processedAt: Date | null;
}

export interface AdminPaymentAttemptDetail {
  attempt: AdminPaymentAttemptSummary;
  webhooks: AdminPaymentWebhookSummary[];
}

export type OrderPaymentProviderKind = "stripe" | "square" | "manual";
export type RefundExecutionKind = "provider_refund" | "recorded_only";
export type RefundExecutionLabel =
  | "Stripe refund"
  | "Square refund"
  | "recorded only — no money is moved by the portal";
export const REFUND_CONFIRMATION_PHRASE = "REFUND ORDER" as const;

export interface OrderPaymentRefundItemView {
  refundPublicId: string;
  paymentPublicId: string;
  provider: OrderPaymentProviderKind;
  executionKind: RefundExecutionKind;
  executionLabel: RefundExecutionLabel;
  status: PaymentRefundStatus;
  amountMinor: number;
  currency: string;
  reasonCode: string;
  reason: string | null;
  providerRefundRef: string | null;
  sendCustomerNotice: boolean;
  customerNoticeSentAt: string | null;
  failureReasonCode: string | null;
  createdAt: string;
  settledAt: string | null;
}

export interface OrderRefundablePaymentView {
  paymentPublicId: string;
  invoicePublicId: string;
  invoiceNumber: string;
  invoiceStatus: "draft" | "issued" | "paid" | "void";
  invoicePaymentState: InvoicePaymentState;
  provider: OrderPaymentProviderKind;
  executionKind: RefundExecutionKind;
  executionLabel: RefundExecutionLabel;
  providerPaymentRef: string | null;
  capturedMinor: number;
  refundedMinor: number;
  reservedPendingOrUnknownMinor: number;
  refundableMinor: number;
  currency: string;
  paidAt: string;
  refunds: OrderPaymentRefundItemView[];
}

export interface OrderRefundWorkspaceView {
  orderPublicId: string;
  orderPaymentState: InvoicePaymentState | "none";
  confirmationPhrase: "REFUND ORDER";
  canIssueRefund: boolean;
  payments: OrderRefundablePaymentView[];
}

export interface CreateOrderRefundInput {
  orderPublicId: string;
  paymentPublicId: string;
  amountMinor: number;
  currency: string;
  reason: string;
  reasonCode?: string | undefined;
  sendCustomerNotice: boolean;
  confirmationPhrase: string;
  idempotencyKey: string;
}

export interface CreateOrderRefundResultView {
  refundPublicId: string;
  executionKind: RefundExecutionKind;
  executionLabel: RefundExecutionLabel;
  status: PaymentRefundStatus;
  amountMinor: number;
  currency: string;
  provider: OrderPaymentProviderKind;
  providerRefundRef: string | null;
  failureReasonCode: string | null;
  invoicePaymentState: InvoicePaymentState;
  orderPaymentState: InvoicePaymentState | "none";
  replayed: boolean;
}

export type EnqueueRefundReconciliationFn = (
  refundPublicId: string,
  tx: Tx,
  options?: Pick<EnqueueOptions, "runAt" | "correlationId">,
) => Promise<{ jobId: string }>;

export interface PaymentsServiceOptions {
  stripeAdapter?: PaymentProviderAdapter;
  squareAdapter?: PaymentProviderAdapter;
  stripeRefundAdapter?: PaymentRefundAdapter<"stripe">;
  squareRefundAdapter?: PaymentRefundAdapter<"square">;
  enqueueRefundReconciliation?: EnqueueRefundReconciliationFn;
}

const DEFAULT_ATTEMPT_TTL_MS = 24 * 60 * 60 * 1000;
const REFUND_RECONCILE_INITIAL_DELAY_MS = 2 * 60 * 1000;
const CARD_PAN_LIKE_PATTERN = /\b(?:\d[ -]*?){13,19}\b/u;

function formatRefundNoticeAmount(amountMinor: number, currency: string): string {
  const code = currency.toUpperCase();
  try {
    const decimals = new Intl.NumberFormat("en-US", { style: "currency", currency: code }).resolvedOptions()
      .maximumFractionDigits ?? 2;
    const major = amountMinor / 10 ** decimals;
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      currencyDisplay: "code",
    }).format(major);
  } catch {
    return `${code} ${(amountMinor / 100).toFixed(2)}`;
  }
}

function executionMetaForProvider(provider: OrderPaymentProviderKind): {
  executionKind: RefundExecutionKind;
  executionLabel: RefundExecutionLabel;
} {
  if (provider === "stripe") {
    return { executionKind: "provider_refund", executionLabel: "Stripe refund" };
  }
  if (provider === "square") {
    return { executionKind: "provider_refund", executionLabel: "Square refund" };
  }
  return {
    executionKind: "recorded_only",
    executionLabel: "recorded only — no money is moved by the portal",
  };
}

function toAdminAttemptSummary(row: PaymentAttemptRow): AdminPaymentAttemptSummary {
  return {
    publicId: row.publicId,
    attemptPublicId: row.publicId,
    invoicePublicId: row.invoicePublicId,
    orderPublicId: row.orderPublicId,
    cartPublicId: row.cartPublicId,
    provider: row.provider,
    environment: row.environment,
    status: row.status,
    amountMinor: row.amountMinor,
    currency: row.currency,
    providerRef: row.providerRef,
    providerOrderRef: row.providerOrderRef,
    providerPaymentRef: row.providerPaymentRef,
    verifiedWebhookEventId: row.verifiedWebhookEventId,
    compliancePaymentPublicId: row.compliancePaymentPublicId,
    reconciliationNote: row.reconciliationNote,
    failureReasonCode: row.failureReasonCode,
    redirectedAt: row.redirectedAt,
    expiresAt: row.expiresAt,
    paidAt: row.paidAt,
    cancelledAt: row.cancelledAt,
    lastReconciledAt: row.lastReconciledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toAdminWebhookSummary(row: PaymentWebhookEventRow): AdminPaymentWebhookSummary {
  return {
    publicId: row.publicId,
    webhookPublicId: row.publicId,
    provider: row.provider,
    environment: row.environment,
    externalEventId: row.externalEventId,
    eventType: row.eventType,
    attemptPublicId: row.attemptPublicId,
    providerRef: row.providerRef,
    providerOrderRef: row.providerOrderRef,
    providerPaymentRef: row.providerPaymentRef,
    status: row.status,
    reasonCode: row.reasonCode,
    occurredAt: row.occurredAt,
    receivedAt: row.receivedAt,
    processedAt: row.processedAt,
  };
}

export function createPaymentsService(deps: ModuleDeps, options?: PaymentsServiceOptions) {
  const adapters: Record<ActivePaymentProvider, PaymentProviderAdapter> = {
    stripe: options?.stripeAdapter ?? createStripeProviderAdapter(deps),
    square: options?.squareAdapter ?? createSquareProviderAdapter(deps),
  };

  const refundAdapters: Record<ActivePaymentProvider, PaymentRefundAdapter> = {
    stripe: options?.stripeRefundAdapter ?? createStripeRefundAdapter(deps),
    square:
      options?.squareRefundAdapter ??
      createSquareRefundAdapter({
        egress: {
          fetchPinned: (url, purpose, fetchOpts) =>
            deps.services.integrations.egress.fetchPinned(url, purpose, fetchOpts),
        },
        clock: deps.clock,
      }),
  };

  const enqueueRefundReconciliation: EnqueueRefundReconciliationFn =
    options?.enqueueRefundReconciliation ??
    ((refundPublicId, tx, enqueueOpts = {}) =>
      deps.jobs.enqueue(
        REFUND_RECONCILE_JOB,
        { refundPublicId },
        {
          runAt: enqueueOpts.runAt,
          correlationId: enqueueOpts.correlationId,
          idempotencyKey: `refund-reconcile:${refundPublicId}`,
          maxAttempts: 8,
        },
        tx,
      ));

  function requireComplianceService() {
    const complianceSvc = (deps.services as Partial<typeof deps.services>).compliance;
    if (!complianceSvc) {
      throw new DomainError("UNAVAILABLE", "COMPLIANCE_UNAVAILABLE", "Invoice service is temporarily unavailable.");
    }
    return complianceSvc;
  }

  function requireOrdersService() {
    const ordersSvc = (deps.services as Partial<typeof deps.services>).orders;
    if (!ordersSvc) {
      throw new DomainError("UNAVAILABLE", "ORDERS_UNAVAILABLE", "Order service is temporarily unavailable.");
    }
    return ordersSvc;
  }

  async function assertAdminPaymentsRead(principal: SessionPrincipal): Promise<void> {
    if (principal.state !== "full" || principal.pendingSteps.length > 0) {
      await deps.audit.record({
        category: "security",
        eventName: "authz.payments.denied",
        action: "authorize",
        outcome: "denied",
        severity: "WARN",
        reasonCode: "REMEDIATION_SESSION",
        actor: { userId: principal.userId, role: principal.role },
        resource: { type: "payments_settings" },
      });
      throw forbidden("REMEDIATION_SESSION");
    }
    if (!roleHasCapability(principal.role, "payments.manage")) {
      await deps.audit.record({
        category: "security",
        eventName: "authz.payments.denied",
        action: "authorize",
        outcome: "denied",
        severity: "WARN",
        reasonCode: "CAPABILITY_NOT_GRANTED",
        actor: { userId: principal.userId, role: principal.role },
        resource: { type: "payments_settings" },
      });
      throw forbidden("CAPABILITY_NOT_GRANTED");
    }
  }

  async function loadConfig(tx?: Tx): Promise<PaymentsConfigValue> {
    return readSetting(deps.settings, PAYMENTS_CONFIG_SETTING, tx);
  }

  async function loadSmallTotals(tx?: Tx): Promise<PaymentsSmallTotalsValue> {
    try {
      const raw = await deps.settings.get(
        PAYMENTS_SMALL_TOTALS_SETTING.key,
        parsePaymentsSmallTotals,
        DEFAULT_PAYMENTS_SMALL_TOTALS,
        tx,
      );
      return parsePaymentsSmallTotals(raw);
    } catch {
      return { ...DEFAULT_PAYMENTS_SMALL_TOTALS };
    }
  }

  async function loadReceiptsSetting(tx?: Tx): Promise<PaymentsReceiptsValue> {
    try {
      const raw = await deps.settings.get(
        PAYMENTS_RECEIPTS_SETTING.key,
        parsePaymentsReceiptsSetting,
        DEFAULT_PAYMENTS_RECEIPTS,
        tx,
      );
      return parsePaymentsReceiptsSetting(raw);
    } catch {
      return { ...DEFAULT_PAYMENTS_RECEIPTS };
    }
  }

  async function evaluateCheckoutAmount(
    amountMinor: number,
    currency: string,
    tx?: DbOrTx,
  ): Promise<CheckoutAmountEvaluation> {
    const config = await loadConfig(tx as Tx | undefined);
    const onlineEnabled = await isProviderCredentialsReady(config, tx as Tx | undefined);
    if (amountMinor <= 0) {
      return {
        onlineEnabled,
        provider: onlineEnabled ? config.provider : "none",
        minimumMinor: 0,
        belowMinimum: false,
        smallTotalAction: "zero_total",
      };
    }
    if (!onlineEnabled || config.provider === "none") {
      return {
        onlineEnabled: false,
        provider: "none",
        minimumMinor: 0,
        belowMinimum: false,
        smallTotalAction: "none",
      };
    }
    const smallTotals = await loadSmallTotals(tx as Tx | undefined);
    const minimumMinor = resolveProviderMinimumMinor(config.provider, currency, smallTotals);
    const belowMinimum = amountMinor > 0 && amountMinor < minimumMinor;
    return {
      onlineEnabled: true,
      provider: config.provider,
      minimumMinor,
      belowMinimum,
      smallTotalAction: belowMinimum ? smallTotals.belowProviderMinimum : "none",
    };
  }

  async function isProviderCredentialsReady(
    config: PaymentsConfigValue,
    tx?: Tx,
  ): Promise<boolean> {
    if (config.provider === "none") return false;
    if (config.provider === "stripe") {
      const [hasKey, hasWh] = await Promise.all([
        isSecretConfigured(deps.settings, PAYMENTS_STRIPE_SECRET_KEY, tx),
        isSecretConfigured(deps.settings, PAYMENTS_STRIPE_WEBHOOK_SECRET, tx),
      ]);
      return hasKey && hasWh;
    }
    const [hasToken, hasSig] = await Promise.all([
      isSecretConfigured(deps.settings, PAYMENTS_SQUARE_ACCESS_TOKEN, tx),
      isSecretConfigured(deps.settings, PAYMENTS_SQUARE_WEBHOOK_SIGNATURE_KEY, tx),
    ]);
    return Boolean(config.squareLocationId && hasToken && hasSig);
  }

  async function isOnlineCheckoutEnabled(tx?: DbOrTx): Promise<boolean> {
    const config = await loadConfig(tx as Tx | undefined);
    return isProviderCredentialsReady(config, tx as Tx | undefined);
  }

  async function getPublicCheckoutConfig(tx?: DbOrTx): Promise<PaymentsPublicConfigView> {
    const config = await loadConfig(tx as Tx | undefined);
    const onlineEnabled = await isProviderCredentialsReady(config, tx as Tx | undefined);
    return {
      provider: onlineEnabled ? config.provider : "none",
      mode: config.mode,
      currency: config.currency,
      onlineEnabled,
    };
  }

  async function loadProviderCredentials(
    provider: ActivePaymentProvider,
    config: PaymentsConfigValue,
    tx?: Tx,
  ): Promise<{ credentials: ProviderCredentials; webhookSecret: string }> {
    if (provider === "stripe") {
      const [secretKey, webhookSecret] = await Promise.all([
        readSecret(deps.settings, PAYMENTS_STRIPE_SECRET_KEY, tx),
        readSecret(deps.settings, PAYMENTS_STRIPE_WEBHOOK_SECRET, tx),
      ]);
      if (!secretKey || !webhookSecret) {
        throw new DomainError(
          "UNAVAILABLE",
          "PAYMENT_PROVIDER_NOT_CONFIGURED",
          "Stripe credentials are not configured.",
        );
      }
      return {
        credentials: { mode: config.mode, secretKey },
        webhookSecret,
      };
    }

    const [accessToken, webhookSignatureKey] = await Promise.all([
      readSecret(deps.settings, PAYMENTS_SQUARE_ACCESS_TOKEN, tx),
      readSecret(deps.settings, PAYMENTS_SQUARE_WEBHOOK_SIGNATURE_KEY, tx),
    ]);
    if (!accessToken || !webhookSignatureKey || !config.squareLocationId) {
      throw new DomainError(
        "UNAVAILABLE",
        "PAYMENT_PROVIDER_NOT_CONFIGURED",
        "Square credentials or location ID are not configured.",
      );
    }
    return {
      credentials: {
        mode: config.mode,
        secretKey: accessToken,
        squareLocationId: config.squareLocationId,
      },
      webhookSecret: webhookSignatureKey,
    };
  }

  function buildCanonicalReturnUrls(
    provider: ActivePaymentProvider,
    attemptPublicId: string,
    successPath: string,
  ): { returnUrl: string; cancelUrl: string } {
    const flow = successPath.startsWith("/checkout") ? "checkout" : "invoices";
    const base = new URL(
      `/api/payments/return/${provider}/${attemptPublicId}`,
      deps.config.canonicalOrigin,
    );
    const returnUrl = new URL(base.href);
    returnUrl.searchParams.set("flow", flow);

    const cancelUrl = new URL(base.href);
    cancelUrl.searchParams.set("flow", flow);
    cancelUrl.searchParams.set("outcome", "cancelled");

    return {
      returnUrl: returnUrl.href,
      cancelUrl: cancelUrl.href,
    };
  }

  async function startCheckout(
    invoicePublicId: string,
    returnPaths?: CheckoutReturnPaths,
    opts?: StartCheckoutOptions,
  ): Promise<StartCheckoutResult> {
    const complianceSvc = requireComplianceService();
    const config = await loadConfig();

    const invoice = await complianceSvc.getInvoiceForCheckout(invoicePublicId, {
      ...(opts?.principal ? { principal: opts.principal } : {}),
    });

    if (opts?.principal && opts.principal.role === "customer" && invoice.ownerUserId !== opts.principal.userId) {
      throw notFound("INVOICE_NOT_FOUND");
    }
    if (invoice.origin !== "portal") {
      throw conflict("IMPORTED_INVOICE_READ_ONLY", "Imported historical invoices cannot be paid online.");
    }
    if (invoice.voidedAt !== null || invoice.status === "void") {
      throw conflict("INVOICE_VOIDED", "Voided invoices cannot be paid.");
    }
    if (invoice.issuedAt === null || invoice.status === "draft") {
      throw conflict("INVOICE_NOT_ISSUED", "Draft invoices must be issued before starting checkout.");
    }

    // Increment 06 D5 + D15: Zero-total invoices settle directly and issue a `zero_total` receipt
    // without touching any external payment processor.
    if (invoice.totalMinor === 0) {
      const settledZero = await deps.db.transaction(async (tx) => {
        if (opts?.principal) {
          const liveActor = await assertLiveActorInTx(deps, opts.principal, tx);
          if (liveActor.role === "customer" && invoice.ownerUserId !== liveActor.userId) {
            throw notFound("INVOICE_NOT_FOUND");
          }
        }
        const ordersSvc = (deps.services as Partial<typeof deps.services>).orders;
        if (ordersSvc && typeof ordersSvc.getOrderRefById === "function") {
          const lockedOrder = await ordersSvc.getOrderRefById(invoice.orderId, tx, { forUpdate: true });
          if (!lockedOrder) throw notFound("INVOICE_NOT_FOUND");
          if (lockedOrder.lockState === "legal_hold" || lockedOrder.lockState === "imported_read_only") {
            throw new DomainError("LOCKED", "ORDER_LOCKED", "Order is locked against checkout.", {
              lockState: lockedOrder.lockState,
            });
          }
        }
        if (typeof complianceSvc.settleCheckoutInvoiceInTx === "function") {
          return complianceSvc.settleCheckoutInvoiceInTx(
            { settlementKind: "zero_total", invoicePublicId: invoice.invoicePublicId },
            tx,
          );
        }
        return { receiptPublicId: null };
      });
      return {
        mode: "settled",
        settlementKind: "zero_total",
        invoicePublicId: invoice.invoicePublicId,
        ...(settledZero.receiptPublicId ? { receiptPublicId: settledZero.receiptPublicId } : {}),
      };
    }

    if (invoice.status === "paid" || invoice.balanceDueMinor <= 0) {
      // Idempotent replay check: if this invoice was settled via `waived_small_total`, validate live principal
      // and order lock inside `tx` before replaying/ensuring the settled receipt.
      const [existingWaived] = await deps.db
        .select({
          id: complianceInvoicePayments.id,
          amountMinor: complianceInvoicePayments.amountMinor,
          waivedMinor: complianceInvoicePayments.waivedMinor,
        })
        .from(complianceInvoicePayments)
        .where(
          and(
            eq(complianceInvoicePayments.invoiceId, invoice.invoiceId),
            eq(complianceInvoicePayments.idempotencyKey, `waive:${invoice.invoicePublicId}`),
          ),
        )
        .limit(1);
      if (existingWaived) {
        const replaySettled = await deps.db.transaction(async (tx) => {
          if (opts?.principal) {
            const liveActor = await assertLiveActorInTx(deps, opts.principal, tx);
            if (liveActor.role === "customer" && invoice.ownerUserId !== liveActor.userId) {
              throw notFound("INVOICE_NOT_FOUND");
            }
          }
          const ordersSvc = (deps.services as Partial<typeof deps.services>).orders;
          if (ordersSvc && typeof ordersSvc.getOrderRefById === "function") {
            const lockedOrder = await ordersSvc.getOrderRefById(invoice.orderId, tx, { forUpdate: true });
            if (!lockedOrder) throw notFound("INVOICE_NOT_FOUND");
            if (lockedOrder.lockState === "legal_hold" || lockedOrder.lockState === "imported_read_only") {
              throw new DomainError("LOCKED", "ORDER_LOCKED", "Order is locked against checkout.", {
                lockState: lockedOrder.lockState,
              });
            }
          }
          if (typeof complianceSvc.settleCheckoutInvoiceInTx === "function") {
            return complianceSvc.settleCheckoutInvoiceInTx(
              {
                settlementKind: "waived_small_total",
                invoicePublicId: invoice.invoicePublicId,
                providerMinimumMinor: 0,
              },
              tx,
            );
          }
          return null;
        });
        return {
          mode: "settled",
          settlementKind: "waived_small_total",
          invoicePublicId: invoice.invoicePublicId,
          waivedMinor: replaySettled?.waivedMinor ?? (existingWaived.waivedMinor || existingWaived.amountMinor),
          ...(replaySettled?.receiptPublicId ? { receiptPublicId: replaySettled.receiptPublicId } : {}),
        };
      }
      throw conflict("INVOICE_ALREADY_PAID", "This invoice is already paid in full.");
    }

    if (config.provider === "none") {
      return {
        mode: "invoice",
        invoicePublicId: invoice.invoicePublicId,
      };
    }

    const activeProvider: ActivePaymentProvider = config.provider;
    const { credentials } = await loadProviderCredentials(activeProvider, config);

    if (invoice.currency.toUpperCase() !== config.currency.toUpperCase()) {
      throw validation(
        "CURRENCY_MISMATCH",
        `Invoice currency (${invoice.currency}) does not match configured payment currency (${config.currency}).`,
      );
    }

    const successPath = returnPaths?.successPath ?? config.successPath;
    const cancelPath = returnPaths?.cancelPath ?? config.cancelPath;
    if (!isSafePortalReturnPath(successPath) || !isSafePortalReturnPath(cancelPath)) {
      throw validation("INVALID_RETURN_PATH", "Checkout return path must be an allowlisted internal portal path.");
    }

    const now = deps.clock.now();
    const rawIdem = opts?.idempotencyKey?.trim();
    const idempotencyKey =
      rawIdem && rawIdem.length >= 4 && rawIdem.length <= 128
        ? rawIdem
        : `att:${invoice.invoicePublicId}:${activeProvider}:${config.mode}:${invoice.balanceDueMinor}`;

    const preAttempt = await deps.db.transaction(async (tx) => {
      if (opts?.principal) {
        await assertLiveActorInTx(deps, opts.principal, tx);
      }

      // Canonical lock order (order -> compliance_invoices -> payment_attempts) + fence against
      // starting a provider checkout after order cancellation or concurrent invoice void/payment.
      const ordersSvc = (deps.services as Partial<typeof deps.services>).orders;
      if (ordersSvc && typeof ordersSvc.getOrderRefById === "function") {
        const lockedOrder = await ordersSvc.getOrderRefById(invoice.orderId, tx, { forUpdate: true });
        if (!lockedOrder) {
          throw notFound("INVOICE_NOT_FOUND");
        }
        let orderCancelled = /cancel/.test(lockedOrder.statusKey);
        if (ordersSvc.workflows && typeof ordersSvc.workflows.byVersionId === "function") {
          const bound = await ordersSvc.workflows.byVersionId(tx, lockedOrder.workflowVersionId);
          const state = bound.definition.states.find((s) => s.key === lockedOrder.statusKey);
          orderCancelled = Boolean(state && state.kind === "terminal" && /cancel/.test(state.key));
        }
        if (orderCancelled) {
          throw conflict("ORDER_CANCELLED", "Cannot start payment for a cancelled order.");
        }
        if (lockedOrder.lockState === "legal_hold" || lockedOrder.lockState === "imported_read_only") {
          throw new DomainError("LOCKED", "ORDER_LOCKED", "Order is locked against online checkout.", {
            lockState: lockedOrder.lockState,
          });
        }
      }

      const lockedInvoice = await complianceSvc.getInvoiceForCheckout(invoicePublicId, {
        ...(opts?.principal ? { principal: opts.principal } : {}),
        tx,
        forUpdate: true,
      });
      if (lockedInvoice.origin !== "portal") {
        throw conflict("IMPORTED_INVOICE_READ_ONLY", "Imported historical invoices cannot be paid online.");
      }
      if (lockedInvoice.voidedAt !== null || lockedInvoice.status === "void") {
        throw conflict("INVOICE_VOIDED", "Voided invoices cannot be paid.");
      }
      if (lockedInvoice.issuedAt === null || lockedInvoice.status === "draft") {
        throw conflict("INVOICE_NOT_ISSUED", "Draft invoices must be issued before starting checkout.");
      }
      if (lockedInvoice.status === "paid" || lockedInvoice.balanceDueMinor <= 0) {
        throw conflict("INVOICE_ALREADY_PAID", "This invoice is already paid in full.");
      }

      // Increment 06 D5: Re-verify provider minimum under canonical row locks (order -> invoice -> attempts).
      const smallTotals = await loadSmallTotals(tx);
      const minimumMinor = resolveProviderMinimumMinor(activeProvider, lockedInvoice.currency, smallTotals);
      if (lockedInvoice.balanceDueMinor > 0 && lockedInvoice.balanceDueMinor < minimumMinor) {
        if (smallTotals.belowProviderMinimum === "block") {
          const minFormatted = (minimumMinor / 100).toFixed(2);
          throw new DomainError(
            "CONFLICT",
            "AMOUNT_BELOW_PROVIDER_MINIMUM",
            `Online card payments require a minimum charge of ${lockedInvoice.currency.toUpperCase()} ${minFormatted}. Adjust your order or contact support.`,
            {
              minimumMinor,
              balanceDueMinor: lockedInvoice.balanceDueMinor,
              currency: lockedInvoice.currency.toUpperCase(),
            },
          );
        }

        // Fail closed: ANY previously committed `payment_attempts` row on this invoice (including
        // ref-less `failed` rows from ambiguous provider dispatches or locally expired rows) blocks
        // automatic small-balance waiver so we never issue a waiver receipt while external exposure may exist.
        const priorAttempts = await tx
          .select({
            publicId: paymentAttempts.publicId,
            status: paymentAttempts.status,
          })
          .from(paymentAttempts)
          .where(eq(paymentAttempts.invoiceId, lockedInvoice.invoiceId))
          .for("update");
        if (priorAttempts.length > 0) {
          const blockingAttempt = priorAttempts[0]!;
          throw new DomainError(
            "CONFLICT",
            "PAYMENT_ATTEMPT_OUTSTANDING",
            "Cannot waive small balance when a prior payment attempt has been recorded for this invoice.",
            {
              attemptPublicId: blockingAttempt.publicId,
              attemptStatus: blockingAttempt.status,
            },
          );
        }

        if (typeof complianceSvc.settleCheckoutInvoiceInTx === "function") {
          const settledWaive = await complianceSvc.settleCheckoutInvoiceInTx(
            {
              settlementKind: "waived_small_total",
              invoicePublicId: lockedInvoice.invoicePublicId,
              providerMinimumMinor: minimumMinor,
            },
            tx,
          );
          return {
            kind: "settled_waived" as const,
            waivedMinor: settledWaive.waivedMinor,
            receiptPublicId: settledWaive.receiptPublicId,
          };
        }
      }

      const [existing] = await tx
        .select()
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.invoiceId, lockedInvoice.invoiceId),
            eq(paymentAttempts.idempotencyKey, idempotencyKey),
          ),
        )
        .for("update")
        .limit(1);

      if (existing) {
        const stillUnexpired = !existing.expiresAt || existing.expiresAt.getTime() > now.getTime();
        if (
          existing.status === "redirected" &&
          stillUnexpired &&
          existing.provider === activeProvider &&
          existing.environment === config.mode &&
          existing.amountMinor === lockedInvoice.balanceDueMinor &&
          existing.redirectUrlEnc
        ) {
          const redirectUrl = deps.crypto.decrypt(
            existing.redirectUrlEnc,
            `payment_attempts.redirect_url:${existing.publicId}`,
          );
          return {
            kind: "reused" as const,
            attemptPublicId: existing.publicId,
            redirectUrl,
            expiresAt: existing.expiresAt,
          };
        }
        if (existing.status === "paid") {
          throw conflict("INVOICE_ALREADY_PAID", "This payment attempt has already been completed.");
        }
      }

      const effectiveIdem = existing ? `${idempotencyKey}:${ulid(now.getTime()).slice(-10)}`.slice(0, 128) : idempotencyKey;
      const attemptPublicId = ulid(now.getTime());
      const [ins] = await tx.insert(paymentAttempts).values({
        publicId: attemptPublicId,
        invoiceId: lockedInvoice.invoiceId,
        invoicePublicId: lockedInvoice.invoicePublicId,
        orderPublicId: lockedInvoice.orderPublicId,
        cartPublicId: opts?.cartPublicId ?? null,
        customerUserId: lockedInvoice.ownerUserId,
        provider: activeProvider,
        environment: config.mode,
        status: "created",
        amountMinor: lockedInvoice.balanceDueMinor,
        currency: lockedInvoice.currency.toUpperCase(),
        idempotencyKey: effectiveIdem,
        successPath,
        cancelPath,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });

      await deps.audit.record(
        {
          category: "business",
          eventName: "payments.attempt.created",
          action: "create",
          outcome: "attempted",
          actor: opts?.principal
            ? { userId: opts.principal.userId, role: opts.principal.role }
            : { role: "system" },
          resource: { type: "payment_attempt", publicId: attemptPublicId },
          attributes: {
            invoice_public_id: lockedInvoice.invoicePublicId,
            order_public_id: lockedInvoice.orderPublicId,
            provider: activeProvider,
            environment: config.mode,
            amount_minor: lockedInvoice.balanceDueMinor,
            currency: lockedInvoice.currency.toUpperCase(),
          },
        },
        tx,
      );

      return {
        kind: "created" as const,
        attemptId: ins.insertId,
        attemptPublicId,
        amountMinor: lockedInvoice.balanceDueMinor,
      };
    });

    if (preAttempt.kind === "settled_waived") {
      return {
        mode: "settled",
        settlementKind: "waived_small_total",
        invoicePublicId: invoice.invoicePublicId,
        waivedMinor: preAttempt.waivedMinor,
        ...(preAttempt.receiptPublicId ? { receiptPublicId: preAttempt.receiptPublicId } : {}),
      };
    }

    if (preAttempt.kind === "reused") {
      return {
        mode: "redirect",
        attemptPublicId: preAttempt.attemptPublicId,
        invoicePublicId: invoice.invoicePublicId,
        provider: activeProvider,
        environment: config.mode,
        redirectUrl: preAttempt.redirectUrl,
        expiresAt: preAttempt.expiresAt,
      };
    }

    const { returnUrl, cancelUrl } = buildCanonicalReturnUrls(
      activeProvider,
      preAttempt.attemptPublicId,
      successPath,
    );
    const adapter = adapters[activeProvider];

    try {
      const createdSession = await adapter.createCheckout({
        attemptPublicId: preAttempt.attemptPublicId,
        invoicePublicId: invoice.invoicePublicId,
        invoiceNumber: invoice.invoiceNumber ?? invoice.invoicePublicId,
        orderPublicId: invoice.orderPublicId,
        orderReference: invoice.orderReference,
        amountMinor: preAttempt.amountMinor,
        currency: invoice.currency.toUpperCase(),
        idempotencyKey,
        returnUrl,
        cancelUrl,
        credentials,
      });

      const completedAt = deps.clock.now();
      const expiresAt = createdSession.expiresAt ?? new Date(completedAt.getTime() + DEFAULT_ATTEMPT_TTL_MS);
      const redirectUrlEnc = deps.crypto.encrypt(
        createdSession.redirectUrl,
        `payment_attempts.redirect_url:${preAttempt.attemptPublicId}`,
      );

      await deps.db.transaction(async (tx) => {
        await tx
          .update(paymentAttempts)
          .set({
            status: "redirected",
            providerRef: createdSession.providerRef,
            providerOrderRef: createdSession.providerOrderRef ?? null,
            providerPaymentRef: createdSession.providerPaymentRef ?? null,
            redirectUrlEnc,
            redirectedAt: completedAt,
            expiresAt,
            version: 2,
            updatedAt: completedAt,
          })
          .where(and(eq(paymentAttempts.id, preAttempt.attemptId), eq(paymentAttempts.version, 1)));

        await deps.audit.record(
          {
            category: "business",
            eventName: "payments.attempt.redirected",
            action: "transition",
            outcome: "completed",
            actor: opts?.principal
              ? { userId: opts.principal.userId, role: opts.principal.role }
              : { role: "system" },
            resource: { type: "payment_attempt", publicId: preAttempt.attemptPublicId },
            attributes: {
              invoice_public_id: invoice.invoicePublicId,
              order_public_id: invoice.orderPublicId,
              provider: activeProvider,
              environment: config.mode,
              provider_ref: createdSession.providerRef,
              amount_minor: preAttempt.amountMinor,
              currency: invoice.currency.toUpperCase(),
            },
          },
          tx,
        );
      });

      return {
        mode: "redirect",
        attemptPublicId: preAttempt.attemptPublicId,
        invoicePublicId: invoice.invoicePublicId,
        provider: activeProvider,
        environment: config.mode,
        redirectUrl: createdSession.redirectUrl,
        expiresAt,
      };
    } catch (err) {
      const failedAt = deps.clock.now();
      const reasonCode = err instanceof DomainError ? err.reasonCode : "PROVIDER_CREATE_ERROR";
      await deps.db.transaction(async (tx) => {
        await tx
          .update(paymentAttempts)
          .set({
            status: "failed",
            failureReasonCode: reasonCode.slice(0, 64),
            version: 2,
            updatedAt: failedAt,
          })
          .where(and(eq(paymentAttempts.id, preAttempt.attemptId), eq(paymentAttempts.status, "created")));

        await deps.audit.record(
          {
            category: "integration",
            eventName: "payments.attempt.failed",
            action: "create",
            outcome: "failed",
            severity: "WARN",
            reasonCode,
            actor: { role: "system" },
            resource: { type: "payment_attempt", publicId: preAttempt.attemptPublicId },
            attributes: {
              invoice_public_id: invoice.invoicePublicId,
              provider: activeProvider,
              environment: config.mode,
            },
          },
          tx,
        );
      });
      throw err;
    }
  }

  async function getCheckoutStatus(
    principal: SessionPrincipal,
    query: { invoicePublicId?: string | undefined; attemptPublicId?: string | undefined },
  ): Promise<CheckoutStatusView> {
    if (!query.invoicePublicId && !query.attemptPublicId) {
      throw validation("MISSING_CHECKOUT_QUERY", "Provide either invoicePublicId or attemptPublicId.");
    }

    const complianceSvc = requireComplianceService();
    const config = await loadConfig();

    let targetInvoicePublicId = query.invoicePublicId;
    if (!targetInvoicePublicId) {
      const [attRef] = await deps.db
        .select({ invoicePublicId: paymentAttempts.invoicePublicId })
        .from(paymentAttempts)
        .where(eq(paymentAttempts.publicId, query.attemptPublicId!))
        .limit(1);
      if (!attRef) throw notFound("PAYMENT_ATTEMPT_NOT_FOUND");
      targetInvoicePublicId = attRef.invoicePublicId;
    }

    // Enforces resource-level read authorization (throws NOT_FOUND for other customers; no existence oracle).
    let invoice: Awaited<ReturnType<typeof complianceSvc.getInvoiceForCheckout>>;
    try {
      invoice = await complianceSvc.getInvoiceForCheckout(targetInvoicePublicId, { principal });
    } catch (err) {
      if (query.attemptPublicId && !query.invoicePublicId && err instanceof DomainError && err.code === "NOT_FOUND") {
        throw notFound("PAYMENT_ATTEMPT_NOT_FOUND");
      }
      throw err;
    }

    let attemptRow: PaymentAttemptRow | null;
    if (query.attemptPublicId) {
      const [found] = await deps.db
        .select()
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.publicId, query.attemptPublicId),
            eq(paymentAttempts.invoiceId, invoice.invoiceId),
            eq(paymentAttempts.invoicePublicId, invoice.invoicePublicId),
            eq(paymentAttempts.customerUserId, invoice.ownerUserId),
          ),
        )
        .limit(1);
      if (!found) {
        throw notFound("PAYMENT_ATTEMPT_NOT_FOUND");
      }
      attemptRow = found;
    } else {
      const [latest] = await deps.db
        .select()
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.invoiceId, invoice.invoiceId),
            eq(paymentAttempts.invoicePublicId, invoice.invoicePublicId),
            eq(paymentAttempts.customerUserId, invoice.ownerUserId),
          ),
        )
        .orderBy(desc(paymentAttempts.id))
        .limit(1);
      attemptRow = latest ?? null;
    }

    const onlineReady = await isProviderCredentialsReady(config);

    return {
      invoicePublicId: invoice.invoicePublicId,
      invoiceNumber: invoice.invoiceNumber,
      invoiceStatus: invoice.status,
      amountMinor: invoice.totalMinor,
      balanceDueMinor: invoice.balanceDueMinor,
      waivedMinor: invoice.waivedMinor ?? 0,
      receiptPublicId: invoice.receiptPublicId ?? null,
      currency: invoice.currency,
      providerConfigured: onlineReady ? config.provider : "none",
      environment: config.mode,
      attempt: attemptRow
        ? {
            attemptPublicId: attemptRow.publicId,
            provider: attemptRow.provider,
            environment: attemptRow.environment,
            status: attemptRow.status,
            cartPublicId: attemptRow.cartPublicId,
            amountMinor: attemptRow.amountMinor,
            currency: attemptRow.currency,
            createdAt: attemptRow.createdAt,
            redirectedAt: attemptRow.redirectedAt,
            paidAt: attemptRow.paidAt,
            expiresAt: attemptRow.expiresAt,
            failureReasonCode: attemptRow.failureReasonCode,
          }
        : null,
    };
  }

  async function cancelAttemptIfUnpaid(
    principal: SessionPrincipal,
    target: { invoicePublicId?: string | undefined; attemptPublicId?: string | undefined },
    callerTx?: Tx,
  ): Promise<CancelAttemptResult> {
    if (!target.invoicePublicId && !target.attemptPublicId) {
      throw validation("MISSING_CANCEL_TARGET", "Provide either invoicePublicId or attemptPublicId.");
    }

    const run = async (tx: Tx): Promise<CancelAttemptResult> => {
      const liveActor = await assertLiveActorInTx(deps, principal, tx);
      const livePrincipal: SessionPrincipal = { ...principal, role: liveActor.role };
      const complianceSvc = requireComplianceService();

      let targetInvoicePublicId = target.invoicePublicId;
      if (!targetInvoicePublicId) {
        const [attRef] = await tx
          .select({ invoicePublicId: paymentAttempts.invoicePublicId })
          .from(paymentAttempts)
          .where(eq(paymentAttempts.publicId, target.attemptPublicId!))
          .limit(1);
        if (!attRef) throw notFound("PAYMENT_ATTEMPT_NOT_FOUND");
        targetInvoicePublicId = attRef.invoicePublicId;
      }

      let invoice: Awaited<ReturnType<typeof complianceSvc.getInvoiceForCheckout>>;
      try {
        invoice = await complianceSvc.getInvoiceForCheckout(targetInvoicePublicId, {
          principal: livePrincipal,
          tx,
        });
      } catch (err) {
        if (target.attemptPublicId && !target.invoicePublicId && err instanceof DomainError && err.code === "NOT_FOUND") {
          throw notFound("PAYMENT_ATTEMPT_NOT_FOUND");
        }
        throw err;
      }
      if (livePrincipal.role === "customer" && invoice.ownerUserId !== liveActor.userId) {
        throw notFound("PAYMENT_ATTEMPT_NOT_FOUND");
      }

      let attemptRow: PaymentAttemptRow | undefined;
      if (target.attemptPublicId) {
        const [found] = await tx
          .select()
          .from(paymentAttempts)
          .where(
            and(
              eq(paymentAttempts.publicId, target.attemptPublicId),
              eq(paymentAttempts.invoiceId, invoice.invoiceId),
              eq(paymentAttempts.invoicePublicId, invoice.invoicePublicId),
              eq(paymentAttempts.customerUserId, invoice.ownerUserId),
            ),
          )
          .for("update")
          .limit(1);
        if (!found) throw notFound("PAYMENT_ATTEMPT_NOT_FOUND");
        attemptRow = found;
      } else {
        const [found] = await tx
          .select()
          .from(paymentAttempts)
          .where(
            and(
              eq(paymentAttempts.invoiceId, invoice.invoiceId),
              eq(paymentAttempts.invoicePublicId, invoice.invoicePublicId),
              eq(paymentAttempts.customerUserId, invoice.ownerUserId),
            ),
          )
          .orderBy(desc(paymentAttempts.id))
          .for("update")
          .limit(1);
        attemptRow = found;
      }

      if (!attemptRow) {
        return { cancelled: false, attemptPublicId: null, status: null };
      }
      if (attemptRow.status === "paid" || invoice.status === "paid") {
        return { cancelled: false, attemptPublicId: attemptRow.publicId, status: "paid" };
      }
      if (attemptRow.status === "cancelled") {
        return { cancelled: true, attemptPublicId: attemptRow.publicId, status: "cancelled" };
      }
      if (attemptRow.status !== "created" && attemptRow.status !== "redirected") {
        return { cancelled: false, attemptPublicId: attemptRow.publicId, status: attemptRow.status };
      }

      const now = deps.clock.now();
      const [cas] = await tx
        .update(paymentAttempts)
        .set({
          status: "cancelled",
          cancelledAt: now,
          version: attemptRow.version + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(paymentAttempts.id, attemptRow.id),
            eq(paymentAttempts.invoiceId, invoice.invoiceId),
            eq(paymentAttempts.customerUserId, invoice.ownerUserId),
            eq(paymentAttempts.version, attemptRow.version),
          ),
        );
      if (cas.affectedRows !== 1) {
        throw conflict("PAYMENT_ATTEMPT_STALE", "Payment attempt state changed concurrently; retry.");
      }

      await deps.audit.record(
        {
          category: "business",
          eventName: "payments.attempt.cancelled",
          action: "transition",
          outcome: "completed",
          actor: { userId: liveActor.userId, role: liveActor.role },
          resource: { type: "payment_attempt", publicId: attemptRow.publicId },
          attributes: {
            invoice_public_id: attemptRow.invoicePublicId,
            provider: attemptRow.provider,
            environment: attemptRow.environment,
          },
        },
        tx,
      );

      return {
        cancelled: true,
        attemptPublicId: attemptRow.publicId,
        status: "cancelled",
      };
    };

    if (callerTx) return run(callerTx);
    return runComplianceTx(deps, principal, { type: "payment_attempt" }, run);
  }

  function checkFetchedMatchesAttempt(
    attempt: PaymentAttemptRow,
    fetched: ProviderFetchedPayment,
  ): { matches: true } | { matches: false; reasonCode: string } {
    const expectedLive = attempt.environment === "live";
    if (fetched.livemode !== expectedLive) {
      return { matches: false, reasonCode: "MODE_MISMATCH" };
    }
    if (attempt.providerRef && fetched.providerRef && fetched.providerRef !== attempt.providerRef) {
      return { matches: false, reasonCode: "PROVIDER_REF_MISMATCH" };
    }
    if (fetched.amountMinor !== attempt.amountMinor) {
      return { matches: false, reasonCode: "AMOUNT_MISMATCH" };
    }
    if (fetched.currency.toUpperCase() !== attempt.currency.toUpperCase()) {
      return { matches: false, reasonCode: "CURRENCY_MISMATCH" };
    }
    if (fetched.invoicePublicId !== attempt.invoicePublicId) {
      return { matches: false, reasonCode: "INVOICE_METADATA_MISMATCH" };
    }
    if (fetched.attemptPublicId !== attempt.publicId) {
      return { matches: false, reasonCode: "ATTEMPT_METADATA_MISMATCH" };
    }
    return { matches: true };
  }

  /**
   * Decision 12 booking critical section:
   * Marks attempt `paid` and books `compliance.bookVerifiedProviderPayment` ONLY when the locked attempt
   * row carries a non-null `verifiedWebhookEventId`, a matching locked `payment_webhook_events` receipt row
   * exists, AND `fetched` passed `checkFetchedMatchesAttempt`.
   */
  async function finalizeVerifiedPaidAttemptInTx(
    tx: Tx,
    input: {
      attemptId: number;
      webhookRowId: number;
      fetched: ProviderFetchedPayment;
    },
  ): Promise<{ booked: boolean; reasonCode: string }> {
    const complianceSvc = requireComplianceService();
    const now = deps.clock.now();

    const [locked] = await tx
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, input.attemptId))
      .for("update")
      .limit(1);

    if (!locked) {
      return { booked: false, reasonCode: "ATTEMPT_NOT_FOUND" };
    }
    // Enforce Decision 12 invariant at the storage boundary: NEVER book without a verified webhook receipt!
    if (!locked.verifiedWebhookEventId) {
      return { booked: false, reasonCode: "WEBHOOK_VERIFICATION_REQUIRED" };
    }

    const [whRow] = await tx
      .select()
      .from(paymentWebhookEvents)
      .where(eq(paymentWebhookEvents.id, input.webhookRowId))
      .for("update")
      .limit(1);

    if (
      !whRow ||
      whRow.attemptId !== locked.id ||
      whRow.provider !== locked.provider ||
      whRow.environment !== locked.environment ||
      whRow.externalEventId !== locked.verifiedWebhookEventId ||
      (whRow.providerPaymentRef &&
        input.fetched.providerPaymentRef &&
        whRow.providerPaymentRef !== input.fetched.providerPaymentRef)
    ) {
      return { booked: false, reasonCode: "WEBHOOK_RECEIPT_MISMATCH" };
    }

    if (locked.status === "paid") {
      await tx
        .update(paymentWebhookEvents)
        .set({ status: "processed", reasonCode: "ALREADY_PAID", processedAt: now })
        .where(eq(paymentWebhookEvents.id, whRow.id));
      return { booked: true, reasonCode: "ALREADY_PAID" };
    }

    const matchCheck = checkFetchedMatchesAttempt(locked, input.fetched);
    if (!matchCheck.matches) {
      await tx
        .update(paymentAttempts)
        .set({
          status: "failed",
          failureReasonCode: matchCheck.reasonCode,
          lastReconciledAt: now,
          version: locked.version + 1,
          updatedAt: now,
        })
        .where(and(eq(paymentAttempts.id, locked.id), eq(paymentAttempts.version, locked.version)));

      await tx
        .update(paymentWebhookEvents)
        .set({
          status: "verification_mismatch",
          reasonCode: matchCheck.reasonCode,
          processedAt: now,
        })
        .where(eq(paymentWebhookEvents.id, whRow.id));

      await deps.audit.record(
        {
          category: "security",
          eventName: "payments.verification.mismatch",
          action: "verify",
          outcome: "refused",
          severity: "ERROR",
          reasonCode: matchCheck.reasonCode,
          actor: { role: "system" },
          resource: { type: "payment_attempt", publicId: locked.publicId },
          attributes: {
            invoice_public_id: locked.invoicePublicId,
            provider: locked.provider,
            expected_amount_minor: locked.amountMinor,
            fetched_amount_minor: input.fetched.amountMinor,
            expected_currency: locked.currency,
            fetched_currency: input.fetched.currency,
          },
        },
        tx,
      );
      return { booked: false, reasonCode: matchCheck.reasonCode };
    }

    const paidAt = input.fetched.paidAt ?? now;
    const providerPaymentRef =
      input.fetched.providerPaymentRef ?? input.fetched.providerRef ?? locked.providerRef ?? locked.publicId;
    const cleanBrand = sanitizeCardBrand(input.fetched.paymentMethodBrand);
    const cleanLast4 = sanitizeCardLast4(input.fetched.paymentMethodLast4);

    const booking = await complianceSvc.bookVerifiedProviderPayment(
      {
        invoicePublicId: locked.invoicePublicId,
        provider: locked.provider,
        environment: locked.environment,
        attemptPublicId: locked.publicId,
        providerPaymentRef,
        amountMinor: locked.amountMinor,
        currency: locked.currency,
        paidAt,
        idempotencyKey: `pmt-attempt:${locked.publicId}`,
        paymentMethodBrand: cleanBrand,
        paymentMethodLast4: cleanLast4,
      },
      tx,
    );

    await tx
      .update(paymentAttempts)
      .set({
        status: "paid",
        providerPaymentRef,
        compliancePaymentPublicId: booking.paymentPublicId,
        paymentMethodBrand: cleanBrand,
        paymentMethodLast4: cleanLast4,
        reconciliationNote: null,
        failureReasonCode: null,
        paidAt,
        lastReconciledAt: now,
        version: locked.version + 1,
        updatedAt: now,
      })
      .where(and(eq(paymentAttempts.id, locked.id), eq(paymentAttempts.version, locked.version)));

    await tx
      .update(paymentWebhookEvents)
      .set({
        status: "processed",
        providerPaymentRef,
        reasonCode: "BOOKED",
        processedAt: now,
      })
      .where(eq(paymentWebhookEvents.id, whRow.id));

    await deps.audit.record(
      {
        category: "business",
        eventName: "payments.attempt.paid",
        action: "transition",
        outcome: "completed",
        actor: { role: "system" },
        resource: { type: "payment_attempt", publicId: locked.publicId },
        attributes: {
          invoice_public_id: locked.invoicePublicId,
          order_public_id: locked.orderPublicId,
          compliance_payment_public_id: booking.paymentPublicId,
          provider: locked.provider,
          environment: locked.environment,
          amount_minor: locked.amountMinor,
          currency: locked.currency,
          verified_webhook_event_id: locked.verifiedWebhookEventId,
        },
      },
      tx,
    );

    return { booked: true, reasonCode: "BOOKED" };
  }

  async function findAttemptForWebhookInTx(
    tx: Tx,
    provider: ActivePaymentProvider,
    environment: PaymentEnvironmentMode,
    refs: {
      attemptPublicId: string | null;
      providerRef: string | null;
      providerOrderRef: string | null;
    },
  ): Promise<PaymentAttemptRow | null> {
    if (refs.attemptPublicId) {
      const [byAttempt] = await tx
        .select()
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.publicId, refs.attemptPublicId),
            eq(paymentAttempts.provider, provider),
            eq(paymentAttempts.environment, environment),
          ),
        )
        .for("update")
        .limit(1);
      if (byAttempt) return byAttempt;
    }
    if (refs.providerRef) {
      const [byRef] = await tx
        .select()
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.provider, provider),
            eq(paymentAttempts.environment, environment),
            eq(paymentAttempts.providerRef, refs.providerRef),
          ),
        )
        .for("update")
        .limit(1);
      if (byRef) return byRef;
    }
    if (refs.providerOrderRef) {
      const [byOrder] = await tx
        .select()
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.provider, provider),
            eq(paymentAttempts.environment, environment),
            eq(paymentAttempts.providerOrderRef, refs.providerOrderRef),
          ),
        )
        .for("update")
        .limit(1);
      if (byOrder) return byOrder;
    }
    return null;
  }

  async function handleSignedWebhook(input: {
    provider: ActivePaymentProvider;
    rawBody: Buffer;
    headers: Readonly<Record<string, string | undefined>>;
    notificationUrl: string;
  }): Promise<PaymentWebhookResult> {
    const now = deps.clock.now();
    const config = await loadConfig();

    let credentials: ProviderCredentials;
    let webhookSecret: string;
    try {
      const loaded = await loadProviderCredentials(input.provider, config);
      credentials = loaded.credentials;
      webhookSecret = loaded.webhookSecret;
    } catch {
      await deps.audit.record({
        category: "integration",
        eventName: "payments.webhook.rejected",
        action: "receive",
        outcome: "refused",
        severity: "WARN",
        reasonCode: "WEBHOOK_NOT_CONFIGURED",
        actor: { role: "system" },
        attributes: { provider: input.provider },
      });
      return {
        httpStatus: 503,
        accepted: false,
        duplicate: false,
        booked: false,
        reasonCode: "WEBHOOK_NOT_CONFIGURED",
      };
    }

    const adapter = adapters[input.provider];
    const verified = adapter.verifyWebhook({
      rawBody: input.rawBody,
      headers: input.headers,
      webhookSecret,
      notificationUrl: input.notificationUrl,
      now,
      toleranceSeconds: config.webhookToleranceSeconds,
    });

    if (!verified.ok) {
      await deps.audit.record({
        category: "security",
        eventName: "payments.webhook.rejected",
        action: "verify",
        outcome: "denied",
        severity: "WARN",
        reasonCode: verified.reasonCode,
        actor: { role: "system" },
        attributes: { provider: input.provider },
      });
      return {
        httpStatus: 400,
        accepted: false,
        duplicate: false,
        booked: false,
        reasonCode: verified.reasonCode,
      };
    }

    const eventEnv: PaymentEnvironmentMode = verified.livemode ? "live" : "test";
    if (eventEnv !== config.mode) {
      await deps.audit.record({
        category: "security",
        eventName: "payments.webhook.rejected",
        action: "verify",
        outcome: "denied",
        severity: "WARN",
        reasonCode: "WEBHOOK_MODE_MISMATCH",
        actor: { role: "system" },
        attributes: {
          provider: input.provider,
          webhook_mode: eventEnv,
          configured_mode: config.mode,
        },
      });
      return {
        httpStatus: 400,
        accepted: false,
        duplicate: false,
        booked: false,
        reasonCode: "WEBHOOK_MODE_MISMATCH",
      };
    }

    const payloadSha256 = createHash("sha256").update(input.rawBody).digest("hex");

    const staged = await deps.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(paymentWebhookEvents)
        .where(
          and(
            eq(paymentWebhookEvents.provider, input.provider),
            eq(paymentWebhookEvents.externalEventId, verified.externalEventId),
          ),
        )
        .for("update")
        .limit(1);

      if (existing) {
        if (existing.payloadSha256 !== payloadSha256) {
          return { kind: "tamper_conflict" as const };
        }
        if (existing.status !== "retry_pending") {
          return {
            kind: "duplicate_done" as const,
            booked:
              existing.status === "processed" &&
              (existing.reasonCode === "BOOKED" || existing.reasonCode === "REFUND_SUCCEEDED"),
          };
        }
      }

      const webhookPublicId = existing?.publicId ?? ulid(now.getTime());

      if (verified.outcomeHint === "refund_updated") {
        const refundRow = await findRefundForWebhookInTx(tx, input.provider, eventEnv, verified);
        if (!refundRow) {
          if (existing) {
            await tx
              .update(paymentWebhookEvents)
              .set({
                status: "ignored",
                reasonCode: "REFUND_NOT_FOUND",
                providerRefundRef: verified.providerRefundRef ?? existing.providerRefundRef,
                processedAt: now,
              })
              .where(eq(paymentWebhookEvents.id, existing.id));
          } else {
            await tx.insert(paymentWebhookEvents).values({
              publicId: webhookPublicId,
              provider: input.provider,
              environment: eventEnv,
              externalEventId: verified.externalEventId,
              eventType: verified.eventType,
              payloadSha256,
              attemptId: null,
              attemptPublicId: verified.attemptPublicId,
              refundId: null,
              refundPublicId: verified.refundPublicIdHint ?? null,
              providerRef: verified.providerRef,
              providerOrderRef: verified.providerOrderRef,
              providerPaymentRef: verified.providerPaymentRef,
              providerRefundRef: verified.providerRefundRef ?? null,
              status: "ignored",
              reasonCode: "REFUND_NOT_FOUND",
              occurredAt: verified.occurredAt,
              receivedAt: now,
              processedAt: now,
            });
          }
          return { kind: "ignored" as const };
        }

        let webhookRowId: number;
        if (existing) {
          webhookRowId = existing.id;
        } else {
          const [ins] = await tx.insert(paymentWebhookEvents).values({
            publicId: webhookPublicId,
            provider: input.provider,
            environment: eventEnv,
            externalEventId: verified.externalEventId,
            eventType: verified.eventType,
            payloadSha256,
            attemptId: refundRow.attemptId,
            attemptPublicId: null,
            refundId: refundRow.id,
            refundPublicId: refundRow.publicId,
            providerRef: verified.providerRef,
            providerOrderRef: verified.providerOrderRef,
            providerPaymentRef: refundRow.providerPaymentRef,
            providerRefundRef: verified.providerRefundRef ?? refundRow.providerRefundRef,
            status: "retry_pending",
            reasonCode: "AWAITING_REFUND_VERIFICATION",
            occurredAt: verified.occurredAt,
            receivedAt: now,
          });
          webhookRowId = ins.insertId;
        }

        return {
          kind: "verify_refund" as const,
          webhookRowId,
          refundRow,
          duplicate: Boolean(existing),
        };
      }

      const attempt = await findAttemptForWebhookInTx(tx, input.provider, config.mode, {
        attemptPublicId: verified.attemptPublicId,
        providerRef: verified.providerRef,
        providerOrderRef: verified.providerOrderRef,
      });

      if (!attempt || verified.outcomeHint === "ignored") {
        if (existing) {
          await tx
            .update(paymentWebhookEvents)
            .set({
              status: "ignored",
              reasonCode: attempt ? "UNHANDLED_EVENT_TYPE" : "ATTEMPT_NOT_FOUND",
              processedAt: now,
            })
            .where(eq(paymentWebhookEvents.id, existing.id));
        } else {
          await tx.insert(paymentWebhookEvents).values({
            publicId: webhookPublicId,
            provider: input.provider,
            environment: eventEnv,
            externalEventId: verified.externalEventId,
            eventType: verified.eventType,
            payloadSha256,
            attemptId: attempt?.id ?? null,
            attemptPublicId: attempt?.publicId ?? verified.attemptPublicId,
            providerRef: verified.providerRef,
            providerOrderRef: verified.providerOrderRef,
            providerPaymentRef: verified.providerPaymentRef,
            status: "ignored",
            reasonCode: attempt ? "UNHANDLED_EVENT_TYPE" : "ATTEMPT_NOT_FOUND",
            occurredAt: verified.occurredAt,
            receivedAt: now,
            processedAt: now,
          });
        }
        return { kind: "ignored" as const };
      }

      if (verified.outcomeHint === "expired" || verified.outcomeHint === "failed") {
        const nextStatus: PaymentAttemptStatus = verified.outcomeHint === "expired" ? "expired" : "failed";
        if (attempt.status === "created" || attempt.status === "redirected") {
          await tx
            .update(paymentAttempts)
            .set({
              status: nextStatus,
              failureReasonCode: verified.eventType.slice(0, 64),
              version: attempt.version + 1,
              updatedAt: now,
            })
            .where(and(eq(paymentAttempts.id, attempt.id), eq(paymentAttempts.version, attempt.version)));
        }

        if (existing) {
          await tx
            .update(paymentWebhookEvents)
            .set({ status: "processed", reasonCode: nextStatus.toUpperCase(), processedAt: now })
            .where(eq(paymentWebhookEvents.id, existing.id));
        } else {
          await tx.insert(paymentWebhookEvents).values({
            publicId: webhookPublicId,
            provider: input.provider,
            environment: eventEnv,
            externalEventId: verified.externalEventId,
            eventType: verified.eventType,
            payloadSha256,
            attemptId: attempt.id,
            attemptPublicId: attempt.publicId,
            providerRef: attempt.providerRef ?? verified.providerRef,
            providerOrderRef: attempt.providerOrderRef ?? verified.providerOrderRef,
            providerPaymentRef: verified.providerPaymentRef,
            status: "processed",
            reasonCode: nextStatus.toUpperCase(),
            occurredAt: verified.occurredAt,
            receivedAt: now,
            processedAt: now,
          });
        }

        await deps.audit.record(
          {
            category: "business",
            eventName: `payments.attempt.${nextStatus}`,
            action: "transition",
            outcome: "completed",
            actor: { role: "system" },
            resource: { type: "payment_attempt", publicId: attempt.publicId },
            attributes: {
              invoice_public_id: attempt.invoicePublicId,
              provider: input.provider,
              external_event_id: verified.externalEventId,
            },
          },
          tx,
        );
        return { kind: "terminal_non_paid" as const, status: nextStatus };
      }

      // outcomeHint === "paid": record verified webhook receipt BEFORE calling provider fetchPayment outside tx!
      await tx
        .update(paymentAttempts)
        .set({
          verifiedWebhookEventId: verified.externalEventId,
          providerPaymentRef: verified.providerPaymentRef ?? attempt.providerPaymentRef,
          updatedAt: now,
        })
        .where(eq(paymentAttempts.id, attempt.id));

      let webhookRowId: number;
      if (existing) {
        webhookRowId = existing.id;
      } else {
        const [ins] = await tx.insert(paymentWebhookEvents).values({
          publicId: webhookPublicId,
          provider: input.provider,
          environment: eventEnv,
          externalEventId: verified.externalEventId,
          eventType: verified.eventType,
          payloadSha256,
          attemptId: attempt.id,
          attemptPublicId: attempt.publicId,
          providerRef: attempt.providerRef ?? verified.providerRef,
          providerOrderRef: attempt.providerOrderRef ?? verified.providerOrderRef,
          providerPaymentRef: verified.providerPaymentRef,
          status: "retry_pending",
          reasonCode: "AWAITING_FETCH_VERIFICATION",
          occurredAt: verified.occurredAt,
          receivedAt: now,
        });
        webhookRowId = ins.insertId;
      }

      return {
        kind: "verify_paid" as const,
        webhookRowId,
        attempt,
        duplicate: Boolean(existing),
      };
    });

    if (staged.kind === "tamper_conflict") {
      await deps.audit.record({
        category: "security",
        eventName: "payments.webhook.rejected",
        action: "verify",
        outcome: "denied",
        severity: "ERROR",
        reasonCode: "PAYLOAD_TAMPER_CONFLICT",
        actor: { role: "system" },
        attributes: {
          provider: input.provider,
          external_event_id: verified.externalEventId,
        },
      });
      return {
        httpStatus: 409,
        accepted: false,
        duplicate: true,
        booked: false,
        reasonCode: "PAYLOAD_TAMPER_CONFLICT",
      };
    }

    if (staged.kind === "duplicate_done") {
      return {
        httpStatus: 200,
        accepted: true,
        duplicate: true,
        booked: staged.booked,
        reasonCode: "DUPLICATE_EVENT",
      };
    }

    if (staged.kind === "ignored") {
      return {
        httpStatus: 200,
        accepted: true,
        duplicate: false,
        booked: false,
        reasonCode: "IGNORED",
      };
    }

    if (staged.kind === "terminal_non_paid") {
      return {
        httpStatus: 200,
        accepted: true,
        duplicate: false,
        booked: false,
        reasonCode: staged.status.toUpperCase(),
      };
    }

    if (staged.kind === "verify_refund") {
      return verifyAndApplyRefundWebhook({
        provider: input.provider,
        credentials,
        refundRow: staged.refundRow,
        webhookRowId: staged.webhookRowId,
        externalEventId: verified.externalEventId,
        providerRefundRefHint: verified.providerRefundRef ?? null,
        duplicate: staged.duplicate,
        now,
      });
    }

    const { attempt, webhookRowId } = staged;
    if (!attempt.providerRef) {
      return {
        httpStatus: 200,
        accepted: true,
        duplicate: staged.duplicate,
        booked: false,
        reasonCode: "MISSING_PROVIDER_REF",
      };
    }

    let fetched: ProviderFetchedPayment;
    try {
      fetched = await adapter.fetchPayment({
        providerRef: attempt.providerRef,
        providerOrderRef: attempt.providerOrderRef ?? verified.providerOrderRef,
        providerPaymentRef: verified.providerPaymentRef ?? attempt.providerPaymentRef,
        credentials,
      });
    } catch (err) {
      const reasonCode = err instanceof DomainError ? err.reasonCode : "PROVIDER_FETCH_FAILED";
      await deps.audit.record({
        category: "integration",
        eventName: "payments.verification.retry_scheduled",
        action: "verify",
        outcome: "failed",
        severity: "WARN",
        reasonCode,
        actor: { role: "system" },
        resource: { type: "payment_attempt", publicId: attempt.publicId },
        attributes: {
          provider: input.provider,
          external_event_id: verified.externalEventId,
        },
      });
      return {
        httpStatus: 503,
        accepted: true,
        duplicate: staged.duplicate,
        booked: false,
        reasonCode: "UPSTREAM_FETCH_RETRYABLE",
      };
    }

    if (fetched.status === "open") {
      return {
        httpStatus: 503,
        accepted: true,
        duplicate: staged.duplicate,
        booked: false,
        reasonCode: "PAYMENT_NOT_SETTLED_YET",
      };
    }

    if (fetched.status === "failed" || fetched.status === "expired") {
      const termStatus: PaymentAttemptStatus = fetched.status === "expired" ? "expired" : "failed";
      const termAt = deps.clock.now();
      await deps.db.transaction(async (tx) => {
        await tx
          .update(paymentAttempts)
          .set({
            status: termStatus,
            failureReasonCode: `FETCH_${termStatus.toUpperCase()}`,
            lastReconciledAt: termAt,
            version: attempt.version + 1,
            updatedAt: termAt,
          })
          .where(and(eq(paymentAttempts.id, attempt.id), eq(paymentAttempts.version, attempt.version)));

        await tx
          .update(paymentWebhookEvents)
          .set({
            status: "processed",
            reasonCode: `FETCH_${termStatus.toUpperCase()}`,
            processedAt: termAt,
          })
          .where(eq(paymentWebhookEvents.id, webhookRowId));
      });
      return {
        httpStatus: 200,
        accepted: true,
        duplicate: staged.duplicate,
        booked: false,
        reasonCode: `FETCH_${termStatus.toUpperCase()}`,
      };
    }

    const bookedResult = await deps.db.transaction((tx) =>
      finalizeVerifiedPaidAttemptInTx(tx, {
        attemptId: attempt.id,
        webhookRowId,
        fetched,
      }),
    );

    return {
      httpStatus: 200,
      accepted: true,
      duplicate: staged.duplicate,
      booked: bookedResult.booked,
      reasonCode: bookedResult.reasonCode,
    };
  }

  async function reconcilePendingAttempts(opts?: {
    limit?: number | undefined;
    signal?: AbortSignal | undefined;
    beforeSend?: (() => Promise<void>) | undefined;
  }): Promise<ReconcilePaymentsResult> {
    const limit = Math.min(Math.max(opts?.limit ?? 25, 1), 100);
    const config = await loadConfig();
    // Enforce zero outbound network activity when payments are off (`provider === "none"`).
    if (config.provider === "none") {
      return { scanned: 0, booked: 0, expired: 0, failed: 0, stillPending: 0 };
    }
    const activeProvider: ActivePaymentProvider = config.provider;
    const candidates = await deps.db
      .select()
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.provider, activeProvider),
          eq(paymentAttempts.environment, config.mode),
          or(
            eq(paymentAttempts.status, "redirected"),
            eq(paymentAttempts.status, "cancelled"),
          ),
        ),
      )
      .orderBy(desc(paymentAttempts.id))
      .limit(limit);

    let scanned = 0;
    let booked = 0;
    let expired = 0;
    let failed = 0;
    let stillPending = 0;

    for (const attempt of candidates) {
      if (opts?.signal?.aborted) break;
      if (attempt.status === "cancelled" && !attempt.verifiedWebhookEventId) {
        continue;
      }
      if (!attempt.providerRef) {
        continue;
      }
      scanned += 1;
      const now = deps.clock.now();

      let credentials: ProviderCredentials;
      try {
        const loaded = await loadProviderCredentials(attempt.provider, {
          ...config,
          mode: attempt.environment,
        });
        credentials = loaded.credentials;
      } catch {
        stillPending += 1;
        continue;
      }

      let fetched: ProviderFetchedPayment;
      try {
        fetched = await adapters[attempt.provider].fetchPayment({
          providerRef: attempt.providerRef,
          providerOrderRef: attempt.providerOrderRef,
          providerPaymentRef: attempt.providerPaymentRef,
          credentials,
          ...(opts?.signal ? { signal: opts.signal } : {}),
          ...(opts?.beforeSend ? { beforeSend: opts.beforeSend } : {}),
        });
      } catch {
        stillPending += 1;
        continue;
      }

      if (fetched.status === "paid") {
        if (attempt.verifiedWebhookEventId) {
          const [pendingWh] = await deps.db
            .select()
            .from(paymentWebhookEvents)
            .where(
              and(
                eq(paymentWebhookEvents.provider, attempt.provider),
                eq(paymentWebhookEvents.externalEventId, attempt.verifiedWebhookEventId),
              ),
            )
            .limit(1);

          if (!pendingWh) {
            stillPending += 1;
            continue;
          }

          const res = await deps.db.transaction((tx) =>
            finalizeVerifiedPaidAttemptInTx(tx, {
              attemptId: attempt.id,
              webhookRowId: pendingWh.id,
              fetched,
            }),
          );
          if (res.booked) {
            booked += 1;
          } else {
            failed += 1;
          }
        } else {
          // Decision 12: NEVER mark invoice paid without a verified signed webhook receipt.
          await deps.db
            .update(paymentAttempts)
            .set({
              reconciliationNote: "awaiting_webhook",
              lastReconciledAt: now,
              updatedAt: now,
            })
            .where(eq(paymentAttempts.id, attempt.id));
          stillPending += 1;
        }
        continue;
      }

      const isPastExpiry = Boolean(attempt.expiresAt && attempt.expiresAt.getTime() <= now.getTime());
      if (fetched.status === "expired" || (fetched.status === "open" && isPastExpiry && !attempt.verifiedWebhookEventId)) {
        await deps.db
          .update(paymentAttempts)
          .set({
            status: "expired",
            lastReconciledAt: now,
            version: attempt.version + 1,
            updatedAt: now,
          })
          .where(and(eq(paymentAttempts.id, attempt.id), eq(paymentAttempts.version, attempt.version)));
        expired += 1;
        continue;
      }

      if (fetched.status === "failed") {
        await deps.db
          .update(paymentAttempts)
          .set({
            status: "failed",
            failureReasonCode: "RECONCILE_PROVIDER_FAILED",
            lastReconciledAt: now,
            version: attempt.version + 1,
            updatedAt: now,
          })
          .where(and(eq(paymentAttempts.id, attempt.id), eq(paymentAttempts.version, attempt.version)));
        failed += 1;
        continue;
      }

      await deps.db
        .update(paymentAttempts)
        .set({ lastReconciledAt: now, updatedAt: now })
        .where(eq(paymentAttempts.id, attempt.id));
      stillPending += 1;
    }

    return { scanned, booked, expired, failed, stillPending };
  }

  /* ------------------------------------------------------------- admin console */

  async function buildAdminSettingsView(tx?: Tx): Promise<PaymentsAdminSettingsView> {
    const [config, smallTotals, receipts] = await Promise.all([
      loadConfig(tx),
      loadSmallTotals(tx),
      loadReceiptsSetting(tx),
    ]);
    const [stripeKeySet, stripeWhSet, squareTokenSet, squareSigSet] = await Promise.all([
      isSecretConfigured(deps.settings, PAYMENTS_STRIPE_SECRET_KEY, tx),
      isSecretConfigured(deps.settings, PAYMENTS_STRIPE_WEBHOOK_SECRET, tx),
      isSecretConfigured(deps.settings, PAYMENTS_SQUARE_ACCESS_TOKEN, tx),
      isSecretConfigured(deps.settings, PAYMENTS_SQUARE_WEBHOOK_SIGNATURE_KEY, tx),
    ]);

    const squareHost =
      config.mode === "live" ? ("connect.squareup.com" as const) : ("connect.squareupsandbox.com" as const);

    let stripeAllowlisted = false;
    let squareAllowlisted = false;
    const egressSvc = (deps.services as Partial<typeof deps.services>).integrations?.egress;
    if (!tx && egressSvc && typeof egressSvc.listPresets === "function") {
      try {
        const presets = await egressSvc.listPresets();
        stripeAllowlisted = presets.some((p) => p.key === "stripe" && p.enabled);
        const sqPresetKey = config.mode === "live" ? "square" : "square_sandbox";
        squareAllowlisted = presets.some((p) => p.key === sqPresetKey && p.enabled);
      } catch {
        stripeAllowlisted = false;
        squareAllowlisted = false;
      }
    }

    const onlineEnabled =
      config.provider === "stripe"
        ? stripeKeySet && stripeWhSet
        : config.provider === "square"
          ? Boolean(config.squareLocationId && squareTokenSet && squareSigSet)
          : false;

    const stripeWebhookUrl = new URL("/api/payments/webhooks/stripe", deps.config.canonicalOrigin).href;
    const squareWebhookUrl = new URL("/api/payments/webhooks/square", deps.config.canonicalOrigin).href;
    const stripeReturnPattern = new URL("/api/payments/return/stripe/<attemptId>", deps.config.canonicalOrigin).href;
    const squareReturnPattern = new URL("/api/payments/return/square/<attemptId>", deps.config.canonicalOrigin).href;

    return {
      provider: config.provider,
      mode: config.mode,
      currency: config.currency,
      successPath: config.successPath,
      cancelPath: config.cancelPath,
      webhookToleranceSeconds: config.webhookToleranceSeconds,
      onlineEnabled,
      stripe: {
        secretKeyConfigured: stripeKeySet,
        secretKeyLast4: stripeKeySet ? config.stripeSecretKeyLast4 : null,
        webhookSecretConfigured: stripeWhSet,
        webhookSecretLast4: stripeWhSet ? config.stripeWebhookSecretLast4 : null,
        webhookUrl: stripeWebhookUrl,
        returnUrlPattern: stripeReturnPattern,
        egressHost: "api.stripe.com",
        egressAllowlisted: stripeAllowlisted,
      },
      square: {
        locationId: config.squareLocationId,
        accessTokenConfigured: squareTokenSet,
        accessTokenLast4: squareTokenSet ? config.squareAccessTokenLast4 : null,
        webhookSignatureKeyConfigured: squareSigSet,
        webhookSignatureKeyLast4: squareSigSet ? config.squareWebhookSignatureKeyLast4 : null,
        webhookUrl: squareWebhookUrl,
        returnUrlPattern: squareReturnPattern,
        egressHost: squareHost,
        egressAllowlisted: squareAllowlisted,
      },
      smallTotals,
      defaultProviderMinimumsMinor: DEFAULT_PROVIDER_MINIMUMS_MINOR,
      receipts,
    };
  }

  async function adminGetSettings(principal: SessionPrincipal): Promise<PaymentsAdminSettingsView> {
    await assertAdminPaymentsRead(principal);
    return buildAdminSettingsView();
  }

  async function adminUpdateSettings(
    principal: SessionPrincipal,
    input: UpdatePaymentsSettingsInput,
  ): Promise<PaymentsAdminSettingsView> {
    const currency = input.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/u.test(currency)) {
      throw validation("INVALID_CURRENCY", "Currency must be a 3-letter uppercase ISO 4217 code.");
    }

    await runComplianceTx(deps, principal, { type: "payments_settings" }, async (tx) => {
      const liveActor = await assertLiveActorInTx(deps, principal, tx, "payments.manage");
      const prev = await loadConfig(tx);

      const nextConfig: PaymentsConfigValue = {
        provider: input.provider,
        mode: input.mode,
        currency,
        successPath: input.successPath ?? prev.successPath,
        cancelPath: input.cancelPath ?? prev.cancelPath,
        webhookToleranceSeconds: input.webhookToleranceSeconds ?? prev.webhookToleranceSeconds,
        stripeSecretKeyLast4: prev.stripeSecretKeyLast4,
        stripeWebhookSecretLast4: prev.stripeWebhookSecretLast4,
        squareLocationId:
          input.squareLocationId !== undefined
            ? input.squareLocationId && input.squareLocationId.trim() !== ""
              ? input.squareLocationId.trim()
              : null
            : prev.squareLocationId,
        squareAccessTokenLast4: prev.squareAccessTokenLast4,
        squareWebhookSignatureKeyLast4: prev.squareWebhookSignatureKeyLast4,
      };

      const rotatedSecrets: string[] = [];

      function parseCredential(schema: { safeParse: (v: unknown) => { success: true; data: string } | { success: false } }, raw: string, label: string): string {
        const res = schema.safeParse(raw);
        if (!res.success) {
          throw validation("INVALID_CREDENTIAL_FORMAT", `${label} is not in the expected format.`);
        }
        return res.data;
      }

      if (input.clearStripeSecretKey) {
        await deps.settings.setSecret(PAYMENTS_STRIPE_SECRET_KEY.key, null, tx);
        nextConfig.stripeSecretKeyLast4 = null;
        rotatedSecrets.push("stripe_secret_key_cleared");
      } else if (input.stripeSecretKey !== undefined && input.stripeSecretKey.trim() !== "") {
        const parsed = parseCredential(PAYMENTS_STRIPE_SECRET_KEY.schema, input.stripeSecretKey.trim(), "Stripe secret key");
        await deps.settings.setSecret(PAYMENTS_STRIPE_SECRET_KEY.key, parsed, tx);
        nextConfig.stripeSecretKeyLast4 = maskLast4(parsed);
        rotatedSecrets.push("stripe_secret_key");
      }

      if (input.clearStripeWebhookSecret) {
        await deps.settings.setSecret(PAYMENTS_STRIPE_WEBHOOK_SECRET.key, null, tx);
        nextConfig.stripeWebhookSecretLast4 = null;
        rotatedSecrets.push("stripe_webhook_secret_cleared");
      } else if (input.stripeWebhookSecret !== undefined && input.stripeWebhookSecret.trim() !== "") {
        const parsed = parseCredential(PAYMENTS_STRIPE_WEBHOOK_SECRET.schema, input.stripeWebhookSecret.trim(), "Stripe webhook signing secret");
        await deps.settings.setSecret(PAYMENTS_STRIPE_WEBHOOK_SECRET.key, parsed, tx);
        nextConfig.stripeWebhookSecretLast4 = maskLast4(parsed);
        rotatedSecrets.push("stripe_webhook_secret");
      }

      if (input.clearSquareAccessToken) {
        await deps.settings.setSecret(PAYMENTS_SQUARE_ACCESS_TOKEN.key, null, tx);
        nextConfig.squareAccessTokenLast4 = null;
        rotatedSecrets.push("square_access_token_cleared");
      } else if (input.squareAccessToken !== undefined && input.squareAccessToken.trim() !== "") {
        const parsed = parseCredential(PAYMENTS_SQUARE_ACCESS_TOKEN.schema, input.squareAccessToken.trim(), "Square access token");
        await deps.settings.setSecret(PAYMENTS_SQUARE_ACCESS_TOKEN.key, parsed, tx);
        nextConfig.squareAccessTokenLast4 = maskLast4(parsed);
        rotatedSecrets.push("square_access_token");
      }

      if (input.clearSquareWebhookSignatureKey) {
        await deps.settings.setSecret(PAYMENTS_SQUARE_WEBHOOK_SIGNATURE_KEY.key, null, tx);
        nextConfig.squareWebhookSignatureKeyLast4 = null;
        rotatedSecrets.push("square_webhook_signature_key_cleared");
      } else if (
        input.squareWebhookSignatureKey !== undefined &&
        input.squareWebhookSignatureKey.trim() !== ""
      ) {
        const parsed = parseCredential(
          PAYMENTS_SQUARE_WEBHOOK_SIGNATURE_KEY.schema,
          input.squareWebhookSignatureKey.trim(),
          "Square webhook signature key",
        );
        await deps.settings.setSecret(PAYMENTS_SQUARE_WEBHOOK_SIGNATURE_KEY.key, parsed, tx);
        nextConfig.squareWebhookSignatureKeyLast4 = maskLast4(parsed);
        rotatedSecrets.push("square_webhook_signature_key");
      }

      const requiresFreshPair =
        nextConfig.provider !== "none" &&
        (prev.provider !== nextConfig.provider || prev.mode !== nextConfig.mode);

      if (nextConfig.provider === "stripe") {
        if (
          requiresFreshPair &&
          (!input.stripeSecretKey?.trim() || !input.stripeWebhookSecret?.trim())
        ) {
          throw validation(
            "FRESH_CREDENTIALS_REQUIRED",
            "Enter both a fresh Stripe secret key and webhook signing secret when switching provider or environment.",
          );
        }
        const [stripeKey, stripeWh] = await Promise.all([
          readSecret(deps.settings, PAYMENTS_STRIPE_SECRET_KEY, tx),
          readSecret(deps.settings, PAYMENTS_STRIPE_WEBHOOK_SECRET, tx),
        ]);
        if (!stripeKey || !stripeWh) {
          throw validation(
            "STRIPE_CREDENTIALS_REQUIRED",
            "Configure both the Stripe secret key and webhook signing secret before enabling Stripe.",
          );
        }
        const expectedPrefix = nextConfig.mode === "live" ? /^(?:sk|rk)_live_/u : /^(?:sk|rk)_test_/u;
        if (!expectedPrefix.test(stripeKey)) {
          throw validation(
            "STRIPE_KEY_MODE_MISMATCH",
            `Stripe secret key must match ${nextConfig.mode} mode.`,
          );
        }
      } else if (nextConfig.provider === "square") {
        if (
          requiresFreshPair &&
          (!input.squareAccessToken?.trim() || !input.squareWebhookSignatureKey?.trim())
        ) {
          throw validation(
            "FRESH_CREDENTIALS_REQUIRED",
            "Enter both a fresh Square access token and webhook signature key when switching provider or environment.",
          );
        }
        const [sqToken, sqSig] = await Promise.all([
          readSecret(deps.settings, PAYMENTS_SQUARE_ACCESS_TOKEN, tx),
          readSecret(deps.settings, PAYMENTS_SQUARE_WEBHOOK_SIGNATURE_KEY, tx),
        ]);
        if (!nextConfig.squareLocationId || !sqToken || !sqSig) {
          throw validation(
            "SQUARE_CREDENTIALS_REQUIRED",
            "Configure the Square location ID, access token, and webhook signature key before enabling Square.",
          );
        }
      }

      await writeSetting(deps.settings, PAYMENTS_CONFIG_SETTING, nextConfig, tx);
      if (input.smallTotals !== undefined) {
        const cleanedSmallTotals = parsePaymentsSmallTotals(input.smallTotals);
        await writeSetting(deps.settings, PAYMENTS_SMALL_TOTALS_SETTING, cleanedSmallTotals, tx);
      }
      if (input.receipts !== undefined) {
        const cleanedReceipts = parsePaymentsReceiptsSetting(input.receipts);
        await writeSetting(deps.settings, PAYMENTS_RECEIPTS_SETTING, cleanedReceipts, tx);
      }

      await deps.audit.record(
        {
          category: "admin",
          eventName: "payments.settings.updated",
          action: "update",
          outcome: "completed",
          actor: { userId: liveActor.userId, role: liveActor.role },
          resource: { type: "payments_settings" },
          attributes: {
            previous_provider: prev.provider,
            provider: nextConfig.provider,
            previous_mode: prev.mode,
            mode: nextConfig.mode,
            currency: nextConfig.currency,
            webhook_tolerance_seconds: nextConfig.webhookToleranceSeconds,
            rotated_secret_count: rotatedSecrets.length,
          },
        },
        tx,
      );
    });

    return buildAdminSettingsView();
  }

  async function adminListAttempts(
    principal: SessionPrincipal,
    input: {
      status?: PaymentAttemptStatus | undefined;
      provider?: ActivePaymentProvider | undefined;
      invoicePublicId?: string | undefined;
      cursor?: string | undefined;
      limit?: number | undefined;
    },
  ): Promise<{ items: AdminPaymentAttemptSummary[]; nextCursor: string | null }> {
    await assertAdminPaymentsRead(principal);
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const afterId = decodeIdCursor(input.cursor);

    const conds = [];
    if (afterId !== null) conds.push(lt(paymentAttempts.id, afterId));
    if (input.status) conds.push(eq(paymentAttempts.status, input.status));
    if (input.provider) conds.push(eq(paymentAttempts.provider, input.provider));
    if (input.invoicePublicId) conds.push(eq(paymentAttempts.invoicePublicId, input.invoicePublicId));

    const rows = await deps.db
      .select()
      .from(paymentAttempts)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(paymentAttempts.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: slice.map(toAdminAttemptSummary),
      nextCursor: hasMore && slice.length > 0 ? encodeIdCursor(slice[slice.length - 1]!.id) : null,
    };
  }

  async function adminGetAttempt(
    principal: SessionPrincipal,
    attemptPublicId: string,
  ): Promise<AdminPaymentAttemptDetail> {
    await assertAdminPaymentsRead(principal);
    const [attempt] = await deps.db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.publicId, attemptPublicId))
      .limit(1);
    if (!attempt) throw notFound("PAYMENT_ATTEMPT_NOT_FOUND");

    const webhooks = await deps.db
      .select()
      .from(paymentWebhookEvents)
      .where(eq(paymentWebhookEvents.attemptId, attempt.id))
      .orderBy(desc(paymentWebhookEvents.id))
      .limit(50);

    return {
      attempt: toAdminAttemptSummary(attempt),
      webhooks: webhooks.map(toAdminWebhookSummary),
    };
  }

  async function adminListWebhooks(
    principal: SessionPrincipal,
    input: {
      provider?: ActivePaymentProvider | undefined;
      status?: PaymentWebhookStatus | undefined;
      cursor?: string | undefined;
      limit?: number | undefined;
    },
  ): Promise<{ items: AdminPaymentWebhookSummary[]; nextCursor: string | null }> {
    await assertAdminPaymentsRead(principal);
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const afterId = decodeIdCursor(input.cursor);

    const conds = [];
    if (afterId !== null) conds.push(lt(paymentWebhookEvents.id, afterId));
    if (input.provider) conds.push(eq(paymentWebhookEvents.provider, input.provider));
    if (input.status) conds.push(eq(paymentWebhookEvents.status, input.status));

    const rows = await deps.db
      .select()
      .from(paymentWebhookEvents)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(paymentWebhookEvents.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: slice.map(toAdminWebhookSummary),
      nextCursor: hasMore && slice.length > 0 ? encodeIdCursor(slice[slice.length - 1]!.id) : null,
    };
  }

  async function adminReconcileNow(
    principal: SessionPrincipal,
    input?: { limit?: number | undefined },
  ): Promise<ReconcilePaymentsResult> {
    await runComplianceTx(deps, principal, { type: "payment_attempt" }, async (tx) => {
      const liveActor = await assertLiveActorInTx(deps, principal, tx, "payments.manage");
      await deps.audit.record(
        {
          category: "admin",
          eventName: "payments.reconcile.triggered",
          action: "execute",
          outcome: "attempted",
          actor: { userId: liveActor.userId, role: liveActor.role },
          resource: { type: "payment_attempt" },
        },
        tx,
      );
    });

    const result = await reconcilePendingAttempts({ limit: input?.limit ?? 25 });

    await deps.audit.record({
      category: "admin",
      eventName: "payments.reconcile.completed",
      action: "execute",
      outcome: "completed",
      actor: { userId: principal.userId, role: principal.role },
      resource: { type: "payment_attempt" },
      safeCounts: {
        scanned: result.scanned,
        booked: result.booked,
        expired: result.expired,
        failed: result.failed,
        still_pending: result.stillPending,
      },
    });

    return result;
  }

  async function loadProviderRefundCredentials(
    provider: ActivePaymentProvider,
    environment: PaymentEnvironmentMode,
    tx?: Tx,
  ): Promise<ProviderCredentials> {
    const config = await loadConfig(tx);
    if (config.mode !== environment) {
      throw conflict(
        "REFUND_ENVIRONMENT_MISMATCH",
        `Payment was captured in ${environment} mode while payments are currently configured in ${config.mode} mode.`,
      );
    }
    if (provider === "stripe") {
      const secretKey = await readSecret(deps.settings, PAYMENTS_STRIPE_SECRET_KEY, tx);
      if (!secretKey) {
        throw new DomainError(
          "UNAVAILABLE",
          "PAYMENT_PROVIDER_NOT_CONFIGURED",
          "Stripe credentials are not configured.",
        );
      }
      return { mode: environment, secretKey };
    }
    const accessToken = await readSecret(deps.settings, PAYMENTS_SQUARE_ACCESS_TOKEN, tx);
    if (!accessToken) {
      throw new DomainError(
        "UNAVAILABLE",
        "PAYMENT_PROVIDER_NOT_CONFIGURED",
        "Square credentials are not configured.",
      );
    }
    return {
      mode: environment,
      secretKey: accessToken,
      ...(config.squareLocationId ? { squareLocationId: config.squareLocationId } : {}),
    };
  }

  async function findRefundForWebhookInTx(
    tx: Tx,
    provider: ActivePaymentProvider,
    environment: PaymentEnvironmentMode,
    verified: Extract<ProviderVerifyWebhookOutput, { ok: true }>,
  ): Promise<PaymentRefundRow | null> {
    if (verified.refundPublicIdHint) {
      const [byHint] = await tx
        .select()
        .from(paymentRefunds)
        .where(
          and(
            eq(paymentRefunds.provider, provider),
            eq(paymentRefunds.environment, environment),
            eq(paymentRefunds.publicId, verified.refundPublicIdHint),
          ),
        )
        .limit(1);
      if (byHint) return byHint;
    }

    if (verified.providerRefundRef) {
      const [byRef] = await tx
        .select()
        .from(paymentRefunds)
        .where(
          and(
            eq(paymentRefunds.provider, provider),
            eq(paymentRefunds.environment, environment),
            eq(paymentRefunds.providerRefundRef, verified.providerRefundRef),
          ),
        )
        .limit(1);
      if (byRef) return byRef;
    }

    return null;
  }

  async function settleProviderRefundSucceededInTx(
    tx: Tx,
    row: PaymentRefundRow,
    providerRefundRef: string,
    settledAt: Date,
    verifiedWebhookEventId: string | null,
  ): Promise<{
    complianceRefundPublicId: string;
    invoicePaymentState: InvoicePaymentState;
    orderPaymentState: InvoicePaymentState | "none";
  }> {
    const now = deps.clock.now();
    const complianceSvc = requireComplianceService();
    const ordersSvc = requireOrdersService();
    const decryptedReason = deps.crypto.decrypt(row.reasonEnc, `payment_refunds.reason:${row.publicId}`);

    const booked = await complianceSvc.invoices.bookSettledRefundInTx(tx, {
      invoiceId: row.invoiceId,
      paymentId: row.compliancePaymentId,
      amountMinor: row.amountMinor,
      currency: row.currency,
      reasonCode: row.reasonCode,
      reference: providerRefundRef,
      notes: decryptedReason,
      refundedAt: settledAt,
      recordedByUserId: row.requestedByUserId,
      idempotencyKey: row.providerIdempotencyKey,
      provider: row.provider,
      providerEventId: row.publicId,
    });

    let noticeSentAt = row.customerNoticeSentAt;
    if (row.sendCustomerNotice && !noticeSentAt) {
      const orderRef =
        typeof ordersSvc.getOrderRefById === "function"
          ? await ordersSvc.getOrderRefById(row.orderId, tx)
          : null;
      if (orderRef) {
        await deps.mailer.enqueue(
          {
            template: REFUND_NOTICE_TEMPLATE_KEY,
            to: { userId: orderRef.ownerUserId },
            vars: {
              orderReference: orderRef.reference,
              refundAmount: formatRefundNoticeAmount(row.amountMinor, row.currency),
              refundReference: row.publicId,
            },
            idempotencyKey: `refund-notice:${row.publicId}`,
          },
          tx,
        );
        noticeSentAt = now;
      }
    }

    await tx
      .update(paymentRefunds)
      .set({
        status: "succeeded",
        providerRefundRef,
        complianceRefundPublicId: booked.complianceRefundPublicId,
        verifiedWebhookEventId: verifiedWebhookEventId ?? row.verifiedWebhookEventId,
        failureReasonCode: null,
        customerNoticeSentAt: noticeSentAt,
        settledAt: row.settledAt ?? settledAt,
        lastReconciledAt: now,
        version: row.version + 1,
        updatedAt: now,
      })
      .where(eq(paymentRefunds.id, row.id));

    if (!booked.duplicate) {
      await deps.audit.record(
        {
          category: "business",
          eventName: "payment.refund.succeeded",
          action: "create",
          outcome: "completed",
          actor: { role: "system" },
          resource: { type: "payment_refund", publicId: row.publicId },
          orderPublicId: row.orderPublicId,
          attributes: {
            order_public_id: row.orderPublicId,
            invoice_public_id: row.invoicePublicId,
            provider: row.provider,
            execution_kind: "provider_refund",
          },
        },
        tx,
      );
    }

    return {
      complianceRefundPublicId: booked.complianceRefundPublicId,
      invoicePaymentState: booked.invoicePaymentState,
      orderPaymentState: booked.orderPaymentState,
    };
  }

  const DETERMINISTIC_REFUND_MISMATCH_CODES = new Set([
    "STRIPE_REFUND_METADATA_MISMATCH",
    "STRIPE_REFUND_PAYMENT_MISMATCH",
    "STRIPE_REFUND_CHARGE_MISMATCH",
    "STRIPE_REFUND_AMOUNT_OR_CURRENCY_MISMATCH",
    "STRIPE_REFUND_ID_MISMATCH",
    "STRIPE_INVALID_PAYMENT_REF",
    "SQUARE_REFUND_LOOKUP_MISMATCH",
    "SQUARE_REFUND_LOOKUP_INVALID",
  ]);

  async function verifyAndApplyRefundWebhook(args: {
    provider: ActivePaymentProvider;
    credentials: ProviderCredentials;
    refundRow: PaymentRefundRow;
    webhookRowId: number;
    externalEventId: string;
    providerRefundRefHint: string | null;
    duplicate: boolean;
    now: Date;
  }): Promise<PaymentWebhookResult> {
    if (
      args.refundRow.providerRefundRef &&
      args.providerRefundRefHint &&
      args.refundRow.providerRefundRef !== args.providerRefundRefHint
    ) {
      await deps.db
        .update(paymentWebhookEvents)
        .set({
          status: "verification_mismatch",
          reasonCode: "REFUND_PROVIDER_REF_CONFLICT",
          processedAt: args.now,
        })
        .where(eq(paymentWebhookEvents.id, args.webhookRowId));
      return {
        httpStatus: 200,
        accepted: false,
        duplicate: args.duplicate,
        booked: false,
        reasonCode: "REFUND_PROVIDER_REF_CONFLICT",
      };
    }

    const expectedDirectRef = args.refundRow.providerRefundRef ?? args.providerRefundRefHint;
    const refundAdapter = refundAdapters[args.provider];
    const lookup = await refundAdapter.lookupRefund({
      credentials: args.credentials,
      refundPublicId: args.refundRow.publicId,
      providerIdempotencyKey: args.refundRow.providerIdempotencyKey,
      refundMarker: `ReadyPackets refund ${args.refundRow.publicId}`,
      providerPaymentRef: args.refundRow.providerPaymentRef,
      providerRefundRef: expectedDirectRef,
      amountMinor: args.refundRow.amountMinor,
      currency: args.refundRow.currency,
    });

    if (
      lookup.status === "unknown" &&
      lookup.failureReasonCode &&
      DETERMINISTIC_REFUND_MISMATCH_CODES.has(lookup.failureReasonCode)
    ) {
      const code = lookup.failureReasonCode.slice(0, 64);
      await deps.db
        .update(paymentWebhookEvents)
        .set({
          status: "verification_mismatch",
          reasonCode: code,
          processedAt: args.now,
        })
        .where(eq(paymentWebhookEvents.id, args.webhookRowId));
      return {
        httpStatus: 200,
        accepted: false,
        duplicate: args.duplicate,
        booked: false,
        reasonCode: code,
      };
    }

    if (lookup.status === "unknown" || lookup.status === "absent") {
      await deps.db
        .update(paymentWebhookEvents)
        .set({
          status: "retry_pending",
          reasonCode: (lookup.failureReasonCode ?? "REFUND_VERIFICATION_UNCONFIRMED").slice(0, 64),
        })
        .where(eq(paymentWebhookEvents.id, args.webhookRowId));
      return {
        httpStatus: 503,
        accepted: false,
        duplicate: args.duplicate,
        booked: false,
        reasonCode: lookup.failureReasonCode ?? "REFUND_VERIFICATION_UNCONFIRMED",
      };
    }

    if (!lookup.providerRefundRef || (expectedDirectRef && lookup.providerRefundRef !== expectedDirectRef)) {
      await deps.db
        .update(paymentWebhookEvents)
        .set({
          status: "verification_mismatch",
          reasonCode: "REFUND_ID_VERIFICATION_MISMATCH",
          processedAt: args.now,
        })
        .where(eq(paymentWebhookEvents.id, args.webhookRowId));
      return {
        httpStatus: 200,
        accepted: false,
        duplicate: args.duplicate,
        booked: false,
        reasonCode: "REFUND_ID_VERIFICATION_MISMATCH",
      };
    }

    return deps.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(paymentRefunds)
        .where(eq(paymentRefunds.id, args.refundRow.id))
        .for("update")
        .limit(1);
      if (!locked) {
        await tx
          .update(paymentWebhookEvents)
          .set({ status: "ignored", reasonCode: "REFUND_NOT_FOUND", processedAt: args.now })
          .where(eq(paymentWebhookEvents.id, args.webhookRowId));
        return {
          httpStatus: 200 as const,
          accepted: true,
          duplicate: args.duplicate,
          booked: false,
          reasonCode: "REFUND_NOT_FOUND",
        };
      }

      if (locked.providerRefundRef && locked.providerRefundRef !== lookup.providerRefundRef) {
        await tx
          .update(paymentWebhookEvents)
          .set({
            status: "verification_mismatch",
            reasonCode: "REFUND_PROVIDER_REF_CONFLICT",
            processedAt: args.now,
          })
          .where(eq(paymentWebhookEvents.id, args.webhookRowId));
        return {
          httpStatus: 200 as const,
          accepted: false,
          duplicate: args.duplicate,
          booked: false,
          reasonCode: "REFUND_PROVIDER_REF_CONFLICT",
        };
      }

      const resolvedProviderRef = lookup.providerRefundRef;

      if (lookup.status === "succeeded" && resolvedProviderRef) {
        if (locked.status !== "succeeded") {
          await settleProviderRefundSucceededInTx(
            tx,
            locked,
            resolvedProviderRef,
            lookup.settledAt ?? args.now,
            args.externalEventId,
          );
        }
        await tx
          .update(paymentWebhookEvents)
          .set({
            status: "processed",
            reasonCode: "REFUND_SUCCEEDED",
            providerRefundRef: resolvedProviderRef,
            processedAt: args.now,
          })
          .where(eq(paymentWebhookEvents.id, args.webhookRowId));
        return {
          httpStatus: 200 as const,
          accepted: true,
          duplicate: args.duplicate,
          booked: true,
          reasonCode: "REFUND_SUCCEEDED",
        };
      }

      if (lookup.status === "failed") {
        const failureCode = (lookup.failureReasonCode ?? "PROVIDER_REFUND_FAILED").slice(0, 64);
        if (locked.status !== "succeeded" && locked.status !== "failed") {
          await tx
            .update(paymentRefunds)
            .set({
              status: "failed",
              providerRefundRef: resolvedProviderRef,
              verifiedWebhookEventId: args.externalEventId,
              failureReasonCode: failureCode,
              settledAt: args.now,
              lastReconciledAt: args.now,
              version: locked.version + 1,
              updatedAt: args.now,
            })
            .where(eq(paymentRefunds.id, locked.id));

          await deps.audit.record(
            {
              category: "business",
              eventName: "payment.refund.failed",
              action: "create",
              outcome: "failed",
              severity: "WARN",
              reasonCode: failureCode,
              actor: { role: "system" },
              resource: { type: "payment_refund", publicId: locked.publicId },
              orderPublicId: locked.orderPublicId,
              attributes: {
                order_public_id: locked.orderPublicId,
                invoice_public_id: locked.invoicePublicId,
                provider: locked.provider,
              },
            },
            tx,
          );
        }
        await tx
          .update(paymentWebhookEvents)
          .set({
            status: "processed",
            reasonCode: "REFUND_FAILED",
            providerRefundRef: resolvedProviderRef,
            processedAt: args.now,
          })
          .where(eq(paymentWebhookEvents.id, args.webhookRowId));
        return {
          httpStatus: 200 as const,
          accepted: true,
          duplicate: args.duplicate,
          booked: false,
          reasonCode: "REFUND_FAILED",
        };
      }

      // lookup.status === "pending"
      if (locked.status === "pending" || locked.status === "unknown") {
        await tx
          .update(paymentRefunds)
          .set({
            status: "pending",
            providerRefundRef: resolvedProviderRef,
            verifiedWebhookEventId: args.externalEventId,
            lastReconciledAt: args.now,
            version: locked.version + 1,
            updatedAt: args.now,
          })
          .where(eq(paymentRefunds.id, locked.id));
      }
      await tx
        .update(paymentWebhookEvents)
        .set({
          status: "processed",
          reasonCode: "REFUND_PENDING",
          providerRefundRef: resolvedProviderRef,
          processedAt: args.now,
        })
        .where(eq(paymentWebhookEvents.id, args.webhookRowId));
      return {
        httpStatus: 200 as const,
        accepted: true,
        duplicate: args.duplicate,
        booked: false,
        reasonCode: "REFUND_PENDING",
      };
    });
  }

  async function forOrderRefunds(
    principal: SessionPrincipal,
    input: { orderPublicId: string },
  ): Promise<OrderRefundWorkspaceView> {
    if (principal.state !== "full" || principal.pendingSteps.length > 0) {
      await deps.audit.record({
        category: "security",
        eventName: "authz.payments.denied",
        action: "authorize",
        outcome: "denied",
        severity: "WARN",
        reasonCode: "REMEDIATION_SESSION",
        actor: { userId: principal.userId, role: principal.role },
        resource: { type: "order_refunds", publicId: input.orderPublicId },
      });
      throw forbidden("REMEDIATION_SESSION");
    }
    if (principal.role !== "staff" && principal.role !== "admin") {
      await deps.audit.record({
        category: "security",
        eventName: "authz.payments.denied",
        action: "authorize",
        outcome: "denied",
        severity: "WARN",
        reasonCode: "STAFF_REQUIRED",
        actor: { userId: principal.userId, role: principal.role },
        resource: { type: "order_refunds", publicId: input.orderPublicId },
      });
      throw forbidden("STAFF_REQUIRED");
    }
    if (!ULID_PATTERN.test(input.orderPublicId)) {
      throw notFound("ORDER_NOT_FOUND");
    }

    const ordersSvc = requireOrdersService();
    // Enforces resource-level order scope; returns NOT_FOUND with zero existence oracle on unauthorized/missing orders.
    await ordersSvc.assertCanReadOrder(principal, input.orderPublicId);

    const canIssueRefund = roleHasCapability(principal.role, "payments.refund");
    const complianceSvc = requireComplianceService();

    const [ledgerSnapshot, providerRefundRows] = await Promise.all([
      complianceSvc.invoices.listOrderPaymentsAndRefunds(input.orderPublicId, undefined, {
        includeNotes: canIssueRefund,
      }),
      deps.db
        .select()
        .from(paymentRefunds)
        .where(eq(paymentRefunds.orderPublicId, input.orderPublicId))
        .orderBy(desc(paymentRefunds.createdAt), desc(paymentRefunds.id)),
    ]);

    const providerRefundsByPaymentId = new Map<number, PaymentRefundRow[]>();
    for (const r of providerRefundRows) {
      const list = providerRefundsByPaymentId.get(r.compliancePaymentId) ?? [];
      list.push(r);
      providerRefundsByPaymentId.set(r.compliancePaymentId, list);
    }

    const payments: OrderRefundablePaymentView[] = ledgerSnapshot.payments.map((pmt) => {
      const providerKind: OrderPaymentProviderKind =
        pmt.method === "provider_online" && (pmt.provider === "stripe" || pmt.provider === "square")
          ? pmt.provider
          : "manual";
      const execMeta = executionMetaForProvider(providerKind);
      const pRefundRows = providerRefundsByPaymentId.get(pmt.paymentId) ?? [];

      const linkedComplianceRefundPublicIds = new Set<string>();
      const providerRefundPublicIds = new Set<string>();
      for (const r of pRefundRows) {
        providerRefundPublicIds.add(r.publicId);
        if (r.complianceRefundPublicId) {
          linkedComplianceRefundPublicIds.add(r.complianceRefundPublicId);
        }
      }

      const unlinkedLedgerRefunds = pmt.ledgerRefunds.filter(
        (lr) =>
          !linkedComplianceRefundPublicIds.has(lr.refundPublicId) &&
          (!lr.providerEventId || !providerRefundPublicIds.has(lr.providerEventId)),
      );

      const unlinkedLedgerMinor = unlinkedLedgerRefunds.reduce((sum, lr) => sum + lr.amountMinor, 0);
      const succeededProviderMinor = pRefundRows
        .filter((r) => r.status === "succeeded")
        .reduce((sum, r) => sum + r.amountMinor, 0);
      const reservedPendingOrUnknownMinor = pRefundRows
        .filter((r) => r.status === "pending" || r.status === "unknown")
        .reduce((sum, r) => sum + r.amountMinor, 0);

      const refundedMinor = unlinkedLedgerMinor + succeededProviderMinor;
      const refundableMinor = Math.max(
        0,
        pmt.capturedMinor - refundedMinor - reservedPendingOrUnknownMinor,
      );

      const refundItems: OrderPaymentRefundItemView[] = [
        ...pRefundRows.map((r): OrderPaymentRefundItemView => {
          const itemMeta = executionMetaForProvider(r.provider);
          return {
            refundPublicId: r.publicId,
            paymentPublicId: pmt.paymentPublicId,
            provider: r.provider,
            executionKind: itemMeta.executionKind,
            executionLabel: itemMeta.executionLabel,
            status: r.status,
            amountMinor: r.amountMinor,
            currency: r.currency,
            reasonCode: r.reasonCode,
            reason: canIssueRefund
              ? deps.crypto.decrypt(r.reasonEnc, `payment_refunds.reason:${r.publicId}`)
              : null,
            providerRefundRef: r.providerRefundRef,
            sendCustomerNotice: r.sendCustomerNotice,
            customerNoticeSentAt: r.customerNoticeSentAt ? r.customerNoticeSentAt.toISOString() : null,
            failureReasonCode: r.failureReasonCode,
            createdAt: r.createdAt.toISOString(),
            settledAt: r.settledAt ? r.settledAt.toISOString() : null,
          };
        }),
        ...unlinkedLedgerRefunds.map((lr): OrderPaymentRefundItemView => {
          const lrProvider: OrderPaymentProviderKind =
            lr.provider === "stripe" || lr.provider === "square" ? lr.provider : "manual";
          const lrMeta = executionMetaForProvider(lrProvider);
          return {
            refundPublicId: lr.refundPublicId,
            paymentPublicId: pmt.paymentPublicId,
            provider: lrProvider,
            executionKind: lrMeta.executionKind,
            executionLabel: lrMeta.executionLabel,
            status: "succeeded",
            amountMinor: lr.amountMinor,
            currency: lr.currency,
            reasonCode: lr.reasonCode,
            reason: canIssueRefund ? lr.notes : null,
            providerRefundRef: lrProvider === "manual" ? null : lr.reference,
            sendCustomerNotice: false,
            customerNoticeSentAt: null,
            failureReasonCode: null,
            createdAt: lr.refundedAt.toISOString(),
            settledAt: lr.refundedAt.toISOString(),
          };
        }),
      ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      return {
        paymentPublicId: pmt.paymentPublicId,
        invoicePublicId: pmt.invoicePublicId,
        invoiceNumber: pmt.invoiceNumber,
        invoiceStatus: pmt.invoiceStatus,
        invoicePaymentState: pmt.invoicePaymentState,
        provider: providerKind,
        executionKind: execMeta.executionKind,
        executionLabel: execMeta.executionLabel,
        providerPaymentRef: providerKind === "manual" ? null : pmt.reference,
        capturedMinor: pmt.capturedMinor,
        refundedMinor,
        reservedPendingOrUnknownMinor,
        refundableMinor,
        currency: pmt.currency,
        paidAt: pmt.receivedAt.toISOString(),
        refunds: refundItems,
      };
    });

    return {
      orderPublicId: input.orderPublicId,
      orderPaymentState: ledgerSnapshot.orderPaymentState,
      confirmationPhrase: REFUND_CONFIRMATION_PHRASE,
      canIssueRefund,
      payments,
    };
  }

  async function createOrderRefund(
    principal: SessionPrincipal,
    input: CreateOrderRefundInput,
  ): Promise<CreateOrderRefundResultView> {
    if (input.confirmationPhrase !== REFUND_CONFIRMATION_PHRASE) {
      throw validation(
        "CONFIRMATION_PHRASE_MISMATCH",
        `Type "${REFUND_CONFIRMATION_PHRASE}" exactly to confirm this refund.`,
      );
    }
    const trimmedReason = input.reason.trim();
    if (trimmedReason.length < 1 || trimmedReason.length > 1000) {
      throw validation("REFUND_REASON_REQUIRED", "Enter a refund reason between 1 and 1,000 characters.");
    }
    for (let i = 0; i < trimmedReason.length; i += 1) {
      const code = trimmedReason.charCodeAt(i);
      if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
        throw validation("INVALID_REFUND_REASON", "Refund reason contains unsupported control characters.");
      }
    }
    if (CARD_PAN_LIKE_PATTERN.test(trimmedReason)) {
      throw validation("CARD_DATA_FORBIDDEN", "Do not include payment card numbers in the refund reason.");
    }
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw validation("INVALID_REFUND_AMOUNT", "Refund amount must be a positive integer in minor units.");
    }
    const currency = input.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/u.test(currency)) {
      throw validation("INVALID_CURRENCY", "Currency must be a 3-letter ISO code.");
    }
    const idempotencyKey = input.idempotencyKey.trim();
    if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw validation("INVALID_IDEMPOTENCY_KEY", "Idempotency key must be between 8 and 128 characters.");
    }
    const reasonCode =
      input.reasonCode && /^[A-Z][A-Z0-9_]{1,63}$/u.test(input.reasonCode)
        ? input.reasonCode
        : "ORDER_REFUND";

    const complianceSvc = requireComplianceService();
    const ordersSvc = requireOrdersService();
    const correlationId = getRequestContext()?.correlationId;

    const prepared = await runComplianceTx(
      deps,
      principal,
      { type: "order_refund", publicId: input.orderPublicId },
      async (tx) => {
        const liveActor = await assertLiveActorInTx(deps, principal, tx, "payments.refund");
        const livePrincipal: SessionPrincipal = { ...principal, role: liveActor.role };
        const now = deps.clock.now();

        await ordersSvc.assertCanWriteOrder(livePrincipal, input.orderPublicId, {
          kind: "invoice",
          tx,
          forUpdate: true,
        });

        const locked = await complianceSvc.invoices.lockOrderPaymentForRefundInTx(tx, {
          orderPublicId: input.orderPublicId,
          paymentPublicId: input.paymentPublicId,
        });

        if (currency !== locked.currency) {
          throw validation(
            "CURRENCY_MISMATCH",
            `Refund currency (${currency}) must match payment currency (${locked.currency}).`,
          );
        }

        const providerKind: OrderPaymentProviderKind =
          locked.method === "provider_online" &&
          (locked.provider === "stripe" || locked.provider === "square")
            ? locked.provider
            : "manual";

        if (providerKind === "manual") {
          const manualIdemKey = `manual-refund:${locked.paymentId}:${idempotencyKey}`.slice(0, 128);
          const alreadyManualRefunded = locked.ledgerRefunds.reduce((sum, r) => sum + r.amountMinor, 0);
          const existingManual = locked.ledgerRefunds.find((r) => r.idempotencyKey === manualIdemKey);

          if (!existingManual && alreadyManualRefunded + input.amountMinor > locked.capturedMinor) {
            throw conflict(
              "REFUND_EXCEEDS_REFUNDABLE",
              "Refund amount exceeds the remaining refundable balance on this payment.",
            );
          }

          const booked = await complianceSvc.invoices.bookSettledRefundInTx(tx, {
            invoiceId: locked.invoiceId,
            paymentId: locked.paymentId,
            amountMinor: input.amountMinor,
            currency,
            reasonCode,
            reference: "RECORDED-ONLY",
            notes: trimmedReason,
            refundedAt: now,
            recordedByUserId: liveActor.userId,
            idempotencyKey: manualIdemKey,
            provider: null,
            providerEventId: null,
          });

          if (!booked.duplicate) {
            await deps.audit.record(
              {
                category: "business",
                eventName: "payment.refund.prepared",
                action: "create",
                outcome: "completed",
                actor: { userId: liveActor.userId, role: liveActor.role },
                resource: { type: "payment_refund", publicId: booked.complianceRefundPublicId },
                orderPublicId: locked.orderPublicId,
                attributes: {
                  order_public_id: locked.orderPublicId,
                  invoice_public_id: locked.invoicePublicId,
                  provider: "manual",
                  execution_kind: "recorded_only",
                },
              },
              tx,
            );

            await deps.audit.record(
              {
                category: "business",
                eventName: "payment.refund.succeeded",
                action: "create",
                outcome: "completed",
                actor: { userId: liveActor.userId, role: liveActor.role },
                resource: { type: "payment_refund", publicId: booked.complianceRefundPublicId },
                orderPublicId: locked.orderPublicId,
                attributes: {
                  order_public_id: locked.orderPublicId,
                  invoice_public_id: locked.invoicePublicId,
                  provider: "manual",
                  execution_kind: "recorded_only",
                },
              },
              tx,
            );

            if (input.sendCustomerNotice) {
              await deps.mailer.enqueue(
                {
                  template: REFUND_NOTICE_TEMPLATE_KEY,
                  to: { userId: locked.ownerUserId },
                  vars: {
                    orderReference: locked.orderReference,
                    refundAmount: formatRefundNoticeAmount(input.amountMinor, currency),
                    refundReference: booked.complianceRefundPublicId,
                  },
                  idempotencyKey: `refund-notice:${booked.complianceRefundPublicId}`,
                },
                tx,
              );
            }
          }

          const manualMeta = executionMetaForProvider("manual");
          return {
            kind: "immediate" as const,
            result: {
              refundPublicId: booked.complianceRefundPublicId,
              executionKind: manualMeta.executionKind,
              executionLabel: manualMeta.executionLabel,
              status: "succeeded" as const,
              amountMinor: input.amountMinor,
              currency,
              provider: "manual" as const,
              providerRefundRef: null,
              failureReasonCode: null,
              invoicePaymentState: booked.invoicePaymentState,
              orderPaymentState: booked.orderPaymentState,
              replayed: booked.duplicate,
            },
          };
        }

        // Provider refund branch ("stripe" | "square"): lock existing payment_refunds rows FOR UPDATE.
        const existingProviderRefunds = await tx
          .select()
          .from(paymentRefunds)
          .where(eq(paymentRefunds.compliancePaymentId, locked.paymentId))
          .orderBy(asc(paymentRefunds.id))
          .for("update");

        const duplicateRow = existingProviderRefunds.find((r) => r.idempotencyKey === idempotencyKey);
        if (duplicateRow) {
          const dupMeta = executionMetaForProvider(duplicateRow.provider);
          const ledgerSnap = await complianceSvc.invoices.listOrderPaymentsAndRefunds(
            locked.orderPublicId,
            tx,
            { includeNotes: false },
          );
          const pmtSnap = ledgerSnap.payments.find((p) => p.paymentId === locked.paymentId);
          return {
            kind: "immediate" as const,
            result: {
              refundPublicId: duplicateRow.publicId,
              executionKind: dupMeta.executionKind,
              executionLabel: dupMeta.executionLabel,
              status: duplicateRow.status,
              amountMinor: duplicateRow.amountMinor,
              currency: duplicateRow.currency,
              provider: duplicateRow.provider,
              providerRefundRef: duplicateRow.providerRefundRef,
              failureReasonCode: duplicateRow.failureReasonCode,
              invoicePaymentState: pmtSnap?.invoicePaymentState ?? locked.invoicePaymentState,
              orderPaymentState: ledgerSnap.orderPaymentState,
              replayed: true,
            },
          };
        }

        if (existingProviderRefunds.some((r) => r.status === "unknown")) {
          throw conflict(
            "REFUND_OUTCOME_UNKNOWN_PENDING",
            "A previous refund on this payment has an unconfirmed provider outcome. Confirm or reconcile it before submitting another refund.",
          );
        }

        const linkedIds = new Set(
          existingProviderRefunds
            .filter((r) => r.status === "succeeded" && r.complianceRefundPublicId !== null)
            .map((r) => r.complianceRefundPublicId!),
        );
        const providerRowPubIds = new Set(existingProviderRefunds.map((r) => r.publicId));
        const unlinkedLedgerMinor = locked.ledgerRefunds
          .filter(
            (lr) =>
              !linkedIds.has(lr.refundPublicId) &&
              (!lr.providerEventId || !providerRowPubIds.has(lr.providerEventId)),
          )
          .reduce((sum, lr) => sum + lr.amountMinor, 0);

        const activeProviderMinor = existingProviderRefunds
          .filter((r) => r.status === "pending" || r.status === "succeeded" || r.status === "unknown")
          .reduce((sum, r) => sum + r.amountMinor, 0);

        const refundableMinor = Math.max(
          0,
          locked.capturedMinor - unlinkedLedgerMinor - activeProviderMinor,
        );
        if (input.amountMinor > refundableMinor) {
          throw conflict(
            "REFUND_EXCEEDS_REFUNDABLE",
            "Refund amount exceeds the remaining refundable balance on this payment.",
          );
        }

        let matchedAttempt: PaymentAttemptRow | undefined;
        if (locked.providerEventId && ULID_PATTERN.test(locked.providerEventId)) {
          const [att] = await tx
            .select()
            .from(paymentAttempts)
            .where(
              or(
                eq(paymentAttempts.compliancePaymentPublicId, locked.paymentPublicId),
                eq(paymentAttempts.publicId, locked.providerEventId),
              ),
            )
            .limit(1);
          matchedAttempt = att;
        } else {
          const [att] = await tx
            .select()
            .from(paymentAttempts)
            .where(eq(paymentAttempts.compliancePaymentPublicId, locked.paymentPublicId))
            .limit(1);
          matchedAttempt = att;
        }

        const config = await loadConfig(tx);
        const environment: PaymentEnvironmentMode = matchedAttempt?.environment ?? config.mode;
        const credentials = await loadProviderRefundCredentials(providerKind, environment, tx);
        const providerPaymentRef = matchedAttempt?.providerPaymentRef ?? locked.providerReference;

        const refundPublicId = ulid(now.getTime());
        const providerIdempotencyKey = `rp-refund-${refundPublicId}`;
        const refundMarker = `ReadyPackets refund ${refundPublicId}`;
        const reasonEnc = deps.crypto.encrypt(trimmedReason, `payment_refunds.reason:${refundPublicId}`);

        const enqueued = await enqueueRefundReconciliation(refundPublicId, tx, {
          runAt: new Date(now.getTime() + REFUND_RECONCILE_INITIAL_DELAY_MS),
          ...(correlationId ? { correlationId } : {}),
        });

        const [ins] = await tx.insert(paymentRefunds).values({
          publicId: refundPublicId,
          orderId: locked.orderId,
          orderPublicId: locked.orderPublicId,
          invoiceId: locked.invoiceId,
          invoicePublicId: locked.invoicePublicId,
          compliancePaymentId: locked.paymentId,
          compliancePaymentPublicId: locked.paymentPublicId,
          attemptId: matchedAttempt?.id ?? null,
          provider: providerKind,
          environment,
          status: "pending",
          amountMinor: input.amountMinor,
          currency,
          reasonCode,
          reasonEnc,
          requestedByUserId: liveActor.userId,
          idempotencyKey,
          providerIdempotencyKey,
          providerPaymentRef,
          providerRefundRef: null,
          complianceRefundPublicId: null,
          sendCustomerNotice: input.sendCustomerNotice,
          customerNoticeSentAt: null,
          reconcileJobId: enqueued.jobId,
          verifiedWebhookEventId: null,
          failureReasonCode: null,
          version: 1,
          settledAt: null,
          lastReconciledAt: null,
          createdAt: now,
          updatedAt: now,
        });

        await deps.audit.record(
          {
            category: "business",
            eventName: "payment.refund.prepared",
            action: "create",
            outcome: "completed",
            actor: { userId: liveActor.userId, role: liveActor.role },
            resource: { type: "payment_refund", publicId: refundPublicId },
            orderPublicId: locked.orderPublicId,
            attributes: {
              order_public_id: locked.orderPublicId,
              invoice_public_id: locked.invoicePublicId,
              provider: providerKind,
              execution_kind: "provider_refund",
            },
          },
          tx,
        );

        return {
          kind: "execute_provider" as const,
          refundRowId: ins.insertId,
          refundPublicId,
          provider: providerKind,
          credentials,
          providerIdempotencyKey,
          refundMarker,
          providerPaymentRef,
          orderPublicId: locked.orderPublicId,
          invoicePublicId: locked.invoicePublicId,
          invoiceNumber: locked.invoiceNumber,
          amountMinor: input.amountMinor,
          currency,
          actorUserId: liveActor.userId,
          actorRole: liveActor.role,
        };
      },
    );

    if (prepared.kind === "immediate") {
      return prepared.result;
    }

    // Phase 2: Execute provider refund OUTSIDE any database transaction.
    // On ambiguous / network error ("unknown"), NEVER resend POST automatically!
    const refundAdapter = refundAdapters[prepared.provider];
    const execOutcome = await refundAdapter.createRefund({
      credentials: prepared.credentials,
      refundPublicId: prepared.refundPublicId,
      providerIdempotencyKey: prepared.providerIdempotencyKey,
      refundMarker: prepared.refundMarker,
      orderPublicId: prepared.orderPublicId,
      invoicePublicId: prepared.invoicePublicId,
      invoiceNumber: prepared.invoiceNumber,
      providerPaymentRef: prepared.providerPaymentRef,
      amountMinor: prepared.amountMinor,
      currency: prepared.currency,
    });

    // Phase 3: Persist provider execution outcome in a short transaction.
    return deps.db.transaction(async (tx) => {
      const now = deps.clock.now();
      const [lockedRow] = await tx
        .select()
        .from(paymentRefunds)
        .where(eq(paymentRefunds.id, prepared.refundRowId))
        .for("update")
        .limit(1);
      if (!lockedRow) {
        throw notFound("REFUND_NOT_FOUND");
      }

      const execMeta = executionMetaForProvider(lockedRow.provider);

      // If a concurrent verified webhook already settled this refund while the HTTP call was returning, preserve it!
      if (lockedRow.status === "succeeded" || lockedRow.status === "failed") {
        const ledgerSnap = await complianceSvc.invoices.listOrderPaymentsAndRefunds(
          lockedRow.orderPublicId,
          tx,
          { includeNotes: false },
        );
        const pmtSnap = ledgerSnap.payments.find((p) => p.paymentId === lockedRow.compliancePaymentId);
        return {
          refundPublicId: lockedRow.publicId,
          executionKind: execMeta.executionKind,
          executionLabel: execMeta.executionLabel,
          status: lockedRow.status,
          amountMinor: lockedRow.amountMinor,
          currency: lockedRow.currency,
          provider: lockedRow.provider,
          providerRefundRef: lockedRow.providerRefundRef,
          failureReasonCode: lockedRow.failureReasonCode,
          invoicePaymentState: pmtSnap?.invoicePaymentState ?? "paid",
          orderPaymentState: ledgerSnap.orderPaymentState,
          replayed: false,
        };
      }

      if (execOutcome.outcome === "succeeded") {
        await deps.audit.record(
          {
            category: "business",
            eventName: "payment.refund.sent",
            action: "create",
            outcome: "completed",
            actor: { userId: prepared.actorUserId, role: prepared.actorRole },
            resource: { type: "payment_refund", publicId: lockedRow.publicId },
            orderPublicId: lockedRow.orderPublicId,
            attributes: {
              order_public_id: lockedRow.orderPublicId,
              invoice_public_id: lockedRow.invoicePublicId,
              provider: lockedRow.provider,
            },
          },
          tx,
        );

        const settled = await settleProviderRefundSucceededInTx(
          tx,
          lockedRow,
          execOutcome.providerRefundRef,
          execOutcome.settledAt ?? now,
          null,
        );

        return {
          refundPublicId: lockedRow.publicId,
          executionKind: execMeta.executionKind,
          executionLabel: execMeta.executionLabel,
          status: "succeeded" as const,
          amountMinor: lockedRow.amountMinor,
          currency: lockedRow.currency,
          provider: lockedRow.provider,
          providerRefundRef: execOutcome.providerRefundRef,
          failureReasonCode: null,
          invoicePaymentState: settled.invoicePaymentState,
          orderPaymentState: settled.orderPaymentState,
          replayed: false,
        };
      }

      if (execOutcome.outcome === "pending") {
        await tx
          .update(paymentRefunds)
          .set({
            status: "pending",
            providerRefundRef: execOutcome.providerRefundRef,
            version: lockedRow.version + 1,
            updatedAt: now,
          })
          .where(eq(paymentRefunds.id, lockedRow.id));

        await deps.audit.record(
          {
            category: "business",
            eventName: "payment.refund.sent",
            action: "create",
            outcome: "completed",
            actor: { userId: prepared.actorUserId, role: prepared.actorRole },
            resource: { type: "payment_refund", publicId: lockedRow.publicId },
            orderPublicId: lockedRow.orderPublicId,
            attributes: {
              order_public_id: lockedRow.orderPublicId,
              invoice_public_id: lockedRow.invoicePublicId,
              provider: lockedRow.provider,
            },
          },
          tx,
        );

        const ledgerSnap = await complianceSvc.invoices.listOrderPaymentsAndRefunds(
          lockedRow.orderPublicId,
          tx,
          { includeNotes: false },
        );
        const pmtSnap = ledgerSnap.payments.find((p) => p.paymentId === lockedRow.compliancePaymentId);
        return {
          refundPublicId: lockedRow.publicId,
          executionKind: execMeta.executionKind,
          executionLabel: execMeta.executionLabel,
          status: "pending" as const,
          amountMinor: lockedRow.amountMinor,
          currency: lockedRow.currency,
          provider: lockedRow.provider,
          providerRefundRef: execOutcome.providerRefundRef,
          failureReasonCode: null,
          invoicePaymentState: pmtSnap?.invoicePaymentState ?? "paid",
          orderPaymentState: ledgerSnap.orderPaymentState,
          replayed: false,
        };
      }

      if (execOutcome.outcome === "failed") {
        const failCode = execOutcome.failureReasonCode.slice(0, 64);
        await tx
          .update(paymentRefunds)
          .set({
            status: "failed",
            failureReasonCode: failCode,
            settledAt: now,
            version: lockedRow.version + 1,
            updatedAt: now,
          })
          .where(eq(paymentRefunds.id, lockedRow.id));

        await deps.audit.record(
          {
            category: "business",
            eventName: "payment.refund.failed",
            action: "create",
            outcome: "failed",
            severity: "WARN",
            reasonCode: failCode,
            actor: { userId: prepared.actorUserId, role: prepared.actorRole },
            resource: { type: "payment_refund", publicId: lockedRow.publicId },
            orderPublicId: lockedRow.orderPublicId,
            attributes: {
              order_public_id: lockedRow.orderPublicId,
              invoice_public_id: lockedRow.invoicePublicId,
              provider: lockedRow.provider,
            },
          },
          tx,
        );

        const ledgerSnap = await complianceSvc.invoices.listOrderPaymentsAndRefunds(
          lockedRow.orderPublicId,
          tx,
          { includeNotes: false },
        );
        const pmtSnap = ledgerSnap.payments.find((p) => p.paymentId === lockedRow.compliancePaymentId);
        return {
          refundPublicId: lockedRow.publicId,
          executionKind: execMeta.executionKind,
          executionLabel: execMeta.executionLabel,
          status: "failed" as const,
          amountMinor: lockedRow.amountMinor,
          currency: lockedRow.currency,
          provider: lockedRow.provider,
          providerRefundRef: null,
          failureReasonCode: failCode,
          invoicePaymentState: pmtSnap?.invoicePaymentState ?? "paid",
          orderPaymentState: ledgerSnap.orderPaymentState,
          replayed: false,
        };
      }

      // execOutcome.outcome === "unknown": NEVER resend POST automatically; leave reserved for reconciliation.
      const unknownCode = (
        execOutcome.outcome === "unknown" ? execOutcome.failureReasonCode : "REFUND_OUTCOME_UNKNOWN"
      ).slice(0, 64);
      await tx
        .update(paymentRefunds)
        .set({
          status: "unknown",
          failureReasonCode: unknownCode,
          version: lockedRow.version + 1,
          updatedAt: now,
        })
        .where(eq(paymentRefunds.id, lockedRow.id));

      await deps.audit.record(
        {
          category: "integration",
          eventName: "payment.refund.unknown",
          action: "create",
          outcome: "unknown",
          severity: "WARN",
          reasonCode: unknownCode,
          actor: { userId: prepared.actorUserId, role: prepared.actorRole },
          resource: { type: "payment_refund", publicId: lockedRow.publicId },
          orderPublicId: lockedRow.orderPublicId,
          attributes: {
            order_public_id: lockedRow.orderPublicId,
            invoice_public_id: lockedRow.invoicePublicId,
            provider: lockedRow.provider,
          },
        },
        tx,
      );

      const ledgerSnap = await complianceSvc.invoices.listOrderPaymentsAndRefunds(
        lockedRow.orderPublicId,
        tx,
        { includeNotes: false },
      );
      const pmtSnap = ledgerSnap.payments.find((p) => p.paymentId === lockedRow.compliancePaymentId);
      return {
        refundPublicId: lockedRow.publicId,
        executionKind: execMeta.executionKind,
        executionLabel: execMeta.executionLabel,
        status: "unknown" as const,
        amountMinor: lockedRow.amountMinor,
        currency: lockedRow.currency,
        provider: lockedRow.provider,
        providerRefundRef: null,
        failureReasonCode: unknownCode,
        invoicePaymentState: pmtSnap?.invoicePaymentState ?? "paid",
        orderPaymentState: ledgerSnap.orderPaymentState,
        replayed: false,
      };
    });
  }

  /**
   * Durable job handler (`compliance.refund.reconcile`) registered via `registerRefundReconciliation`.
   * Performs ONLY read-only `lookupRefund` queries against the provider (NEVER submits a POST refund),
   * and fences finalization with `context.assertStillOwned(tx)` BEFORE locking `payment_refunds`.
   */
  async function reconcileProviderRefund(
    refundPublicId: string,
    context: RefundReconcileContext,
  ): Promise<"settled" | "pending"> {
    const [initialRow] = await deps.db
      .select()
      .from(paymentRefunds)
      .where(eq(paymentRefunds.publicId, refundPublicId))
      .limit(1);

    if (!initialRow || initialRow.status === "succeeded" || initialRow.status === "failed") {
      return "settled";
    }

    let credentials: ProviderCredentials;
    try {
      credentials = await loadProviderRefundCredentials(initialRow.provider, initialRow.environment);
    } catch {
      return "pending";
    }

    const refundAdapter = refundAdapters[initialRow.provider];
    const lookup = await refundAdapter.lookupRefund({
      credentials,
      refundPublicId: initialRow.publicId,
      providerIdempotencyKey: initialRow.providerIdempotencyKey,
      refundMarker: `ReadyPackets refund ${initialRow.publicId}`,
      providerPaymentRef: initialRow.providerPaymentRef,
      providerRefundRef: initialRow.providerRefundRef,
      amountMinor: initialRow.amountMinor,
      currency: initialRow.currency,
      signal: context.signal,
      beforeSend: () => context.assertStillOwned(),
    });

    return deps.db.transaction(async (tx) => {
      await context.assertStillOwned(tx);

      const [locked] = await tx
        .select()
        .from(paymentRefunds)
        .where(eq(paymentRefunds.id, initialRow.id))
        .for("update")
        .limit(1);

      if (!locked || locked.status === "succeeded" || locked.status === "failed") {
        return "settled";
      }

      const now = deps.clock.now();
      if (
        locked.providerRefundRef &&
        lookup.providerRefundRef &&
        locked.providerRefundRef !== lookup.providerRefundRef
      ) {
        return "pending";
      }
      const resolvedRef = lookup.providerRefundRef ?? locked.providerRefundRef;

      if (lookup.status === "succeeded" && lookup.providerRefundRef) {
        await settleProviderRefundSucceededInTx(
          tx,
          locked,
          lookup.providerRefundRef,
          lookup.settledAt ?? now,
          null,
        );
        return "settled";
      }

      if (lookup.status === "failed") {
        const failCode = (lookup.failureReasonCode ?? "PROVIDER_REFUND_FAILED").slice(0, 64);
        await tx
          .update(paymentRefunds)
          .set({
            status: "failed",
            providerRefundRef: resolvedRef,
            failureReasonCode: failCode,
            settledAt: now,
            lastReconciledAt: now,
            version: locked.version + 1,
            updatedAt: now,
          })
          .where(eq(paymentRefunds.id, locked.id));

        await deps.audit.record(
          {
            category: "business",
            eventName: "payment.refund.failed",
            action: "create",
            outcome: "failed",
            severity: "WARN",
            reasonCode: failCode,
            actor: { role: "system" },
            resource: { type: "payment_refund", publicId: locked.publicId },
            orderPublicId: locked.orderPublicId,
            attributes: {
              order_public_id: locked.orderPublicId,
              invoice_public_id: locked.invoicePublicId,
              provider: locked.provider,
            },
          },
          tx,
        );
        return "settled";
      }

      // lookup.status is "pending", "unknown", or "absent": never classify unconfirmed/not-yet-visible as failed.
      await tx
        .update(paymentRefunds)
        .set({
          providerRefundRef: resolvedRef,
          lastReconciledAt: now,
          updatedAt: now,
        })
        .where(eq(paymentRefunds.id, locked.id));

      return "pending";
    });
  }

  async function healthCounts(): Promise<{
    provider: PaymentProviderChoice;
    onlineEnabled: boolean;
    redirectedAttempts: number;
    retryPendingWebhooks: number;
  }> {
    const config = await loadConfig();
    const [onlineEnabled, [attRow], [whRow]] = await Promise.all([
      isProviderCredentialsReady(config),
      deps.db
        .select({ total: count() })
        .from(paymentAttempts)
        .where(eq(paymentAttempts.status, "redirected")),
      deps.db
        .select({ total: count() })
        .from(paymentWebhookEvents)
        .where(eq(paymentWebhookEvents.status, "retry_pending")),
    ]);

    return {
      provider: config.provider,
      onlineEnabled,
      redirectedAttempts: attRow?.total ?? 0,
      retryPendingWebhooks: whRow?.total ?? 0,
    };
  }

  /**
   * Authoritative conservative check for G-C3-02 (`compliance.orderPaymentExposureInTx`):
   * `providerAttemptEver` is `true` if ANY `payment_attempts` row has EVER been created for the order or its invoices,
   * regardless of status (`created`, `redirected`, `paid`, `failed`, `cancelled`, `expired`).
   * Uses `FOR SHARE NOWAIT` for a current read that fails closed (`true`) on lock contention without deadlocking.
   */
  async function getAttemptExposureForOrderInTx(
    tx: Tx,
    orderPublicId: string,
    invoiceIds: readonly number[],
  ): Promise<{ providerCapturePending: boolean; providerAttemptEver: boolean }> {
    try {
      const whereClause =
        invoiceIds.length > 0
          ? or(
              eq(paymentAttempts.orderPublicId, orderPublicId),
              inArray(paymentAttempts.invoiceId, [...invoiceIds]),
            )
          : eq(paymentAttempts.orderPublicId, orderPublicId);
      const rows = await tx
        .select({
          id: paymentAttempts.id,
          status: paymentAttempts.status,
          compliancePaymentPublicId: paymentAttempts.compliancePaymentPublicId,
          verifiedWebhookEventId: paymentAttempts.verifiedWebhookEventId,
        })
        .from(paymentAttempts)
        .where(whereClause)
        .orderBy(asc(paymentAttempts.id))
        .for("share", { noWait: true });
      const providerAttemptEver = rows.length > 0;
      const providerCapturePending = rows.some(
        (r) =>
          r.status === "created" ||
          r.status === "redirected" ||
          r.status === "cancelled" ||
          (r.status === "paid" && r.compliancePaymentPublicId === null) ||
          (r.status === "failed" && r.verifiedWebhookEventId !== null),
      );
      return { providerCapturePending, providerAttemptEver };
    } catch {
      return { providerCapturePending: true, providerAttemptEver: true };
    }
  }

  return {
    isOnlineCheckoutEnabled,
    getPublicCheckoutConfig,
    evaluateCheckoutAmount,
    startCheckout,
    getCheckoutStatus,
    cancelAttemptIfUnpaid,
    handleSignedWebhook,
    reconcilePendingAttempts,
    reconcileProviderRefund,
    getAttemptExposureForOrderInTx,
    refunds: {
      forOrder: forOrderRefunds,
      create: createOrderRefund,
    },
    admin: {
      getSettings: adminGetSettings,
      updateSettings: adminUpdateSettings,
      listAttempts: adminListAttempts,
      getAttempt: adminGetAttempt,
      listWebhooks: adminListWebhooks,
      reconcileNow: adminReconcileNow,
    },
    healthCounts,
  };
}

export type PaymentsService = ReturnType<typeof createPaymentsService>;
