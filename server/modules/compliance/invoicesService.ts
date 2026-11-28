import { and, asc, count, desc, eq, inArray, lt, ne } from "drizzle-orm";
import { roleHasCapability } from "../../../shared/capabilities.js";
import type { ModuleDeps } from "../../container.js";
import { conflict, DomainError, notFound, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { DbOrTx, SessionPrincipal, Tx } from "../../core/types.js";
import { readSetting, writeSetting } from "../platform/index.js";
import { users } from "../identity/schema.js";
import { isLiveUserRow } from "../identity/live.js";
import { orders } from "../orders/schema.js";
import { liveOrderIdPredicate } from "../orders/trashGate.js";
import { sanitizeCardBrand, sanitizeCardLast4 } from "../payments/settings.js";
import { assertLiveActorInTx, denyComplianceAuthz, runComplianceTx } from "./actorAuth.js";
import {
  computeInvoiceTotals,
  decodeIdCursor,
  deriveInvoicePaymentState,
  deriveInvoiceStatus,
  deriveOrderPaymentSummaryState,
  encodeIdCursor,
  formatInvoiceNumber,
  type InvoicePaymentState,
  type OrderHeaderPaymentState,
} from "./domain.js";
import { renderInvoicePdf } from "./invoicePdf.js";
import type { ReceiptsService } from "./receiptsService.js";
import {
  complianceInvoiceLines,
  complianceInvoicePayments,
  complianceInvoiceRefunds,
  complianceInvoices,
  complianceProviderEvents,
  complianceSequences,
  type InvoiceStatus,
  type PaymentMethod,
  type PaymentRecordStatus,
} from "./schema.js";
import {
  DEFAULT_ISSUER_LOGO_SETTING,
  INVOICE_DEFAULT_TAX_RATE_BPS,
  INVOICE_ISSUER_ADDRESS,
  INVOICE_ISSUER_CONTACT,
  INVOICE_ISSUER_LOGO,
  INVOICE_ISSUER_NAME,
  INVOICE_ISSUER_TAX_ID,
  INVOICE_NUMBER_PREFIX,
  INVOICE_PAYMENT_INSTRUCTIONS,
  type IssuerLogoSetting,
  parseIssuerLogoSetting,
} from "./settings.js";

export interface InvoiceLineView {
  linePublicId: string;
  position: number;
  description: string;
  quantity: number;
  unitAmountMinor: number;
  lineTotalMinor: number;
}

export interface InvoicePaymentView {
  paymentPublicId: string;
  method: PaymentMethod;
  status: PaymentRecordStatus;
  amountMinor: number;
  currency: string;
  reference: string;
  provider: string | null;
  notes: string | null;
  receivedAt: Date;
  origin: "portal" | "import";
}

export interface InvoiceRefundView {
  refundPublicId: string;
  paymentPublicId: string;
  amountMinor: number;
  currency: string;
  reasonCode: string;
  reference: string;
  provider: string | null;
  notes: string | null;
  refundedAt: Date;
  origin: "portal" | "import";
}

export type InvoiceOrderLifecycleState = "live" | "trashed" | "deleted";

export interface InvoiceBuyerSnapshot {
  name: string;
  email: string;
  customerRef: string | null;
}

export interface InvoiceSummaryView {
  invoicePublicId: string;
  orderPublicId: string;
  orderReference: string;
  projectName?: string | null;
  orderLifecycleState?: InvoiceOrderLifecycleState;
  invoiceNumber: string | null;
  status: InvoiceStatus;
  paymentState: InvoicePaymentState;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  grossPaidMinor: number;
  waivedMinor: number;
  refundedMinor: number;
  netPaidMinor: number;
  balanceDueMinor: number;
  issuedAt: Date | null;
  dueAt: Date | null;
  voidedAt: Date | null;
  origin: "portal" | "import";
  version: number;
  createdAt: Date;
}

export interface InvoiceDetailView extends InvoiceSummaryView {
  bundleDiscountMinor: number;
  discountLabel: string | null;
  promoDiscountMinor: number;
  promoLabel: string | null;
  issuerName: string;
  issuerAddress: string;
  issuerContact?: string | null;
  buyer?: InvoiceBuyerSnapshot | null;
  memo: string | null;
  voidReason: string | null;
  paymentInstructions: string;
  onlinePaymentConfigured: boolean;
  onlinePaymentMessage: string | null;
  lines: InvoiceLineView[];
  payments: InvoicePaymentView[];
  refunds: InvoiceRefundView[];
  canManage: boolean;
  canRecordPayment: boolean;
}

export interface OrderPaymentExposure {
  grossPaidMinor: number;
  payableInvoiceOpen: boolean;
  providerCapturePending: boolean;
  providerAttemptEver: boolean;
}

export interface RecordProviderPaymentInput {
  provider: string;
  providerEventId: string;
  /** Provider payment reference (either `providerReference` or `providerPaymentId` accepted). */
  providerReference?: string | undefined;
  providerPaymentId?: string | undefined;
  invoicePublicId?: string | undefined;
  orderPublicId?: string | undefined;
  kind?: "succeeded" | "failed" | "refunded" | undefined;
  amountMinor: number;
  currency: string;
  receivedAt?: Date | undefined;
  occurredAt?: Date | undefined;
  reasonCode?: string | undefined;
  tx?: Tx | undefined;
}

export interface RecordProviderPaymentResult {
  applied: boolean;
  duplicate: boolean;
  reasonCode?: string;
  paymentPublicId?: string;
  recordPublicId?: string;
  invoicePublicId?: string;
  invoiceStatus?: InvoiceStatus;
}

export interface InvoicePaidEvent {
  invoiceId: number;
  invoicePublicId: string;
  invoiceNumber: string | null;
  orderId: number;
  orderPublicId: string;
  orderReference: string;
  ownerUserId: number;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  netPaidMinor: number;
  currency: string;
  paymentPublicId: string;
  method: PaymentMethod;
  provider: "stripe" | "square" | null;
  paidAt: Date;
}

export type InvoicePaidListener = (event: InvoicePaidEvent, tx: Tx) => Promise<void>;

export interface IssueCheckoutInvoiceInput {
  principal: SessionPrincipal;
  orderId?: number | undefined;
  orderPublicId: string;
  currency: string;
  lines: readonly {
    description: string;
    quantity: number;
    unitAmountMinor: number;
    productKey?: string | undefined;
    tierKey?: string | undefined;
  }[];
  discountMinor: number;
  taxMinor?: number | undefined;
  dueAt?: Date | undefined;
  memo?: string | undefined;
}

export interface IssuedCheckoutInvoice {
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
}

export interface BookVerifiedProviderPaymentInput {
  invoicePublicId: string;
  provider: "stripe" | "square";
  environment: "test" | "live";
  attemptPublicId: string;
  providerPaymentRef: string;
  amountMinor: number;
  currency: string;
  paidAt: Date;
  idempotencyKey: string;
  paymentMethodBrand?: string | null | undefined;
  paymentMethodLast4?: string | null | undefined;
}

export interface BookVerifiedProviderPaymentResult {
  paymentPublicId: string;
  receiptPublicId?: string | null | undefined;
  invoiceId: number;
  invoicePublicId: string;
  invoiceNumber: string | null;
  invoiceStatus: InvoiceStatus;
  balanceDueMinor: number;
  duplicate: boolean;
}

export type SettleCheckoutInvoiceInput =
  | {
      settlementKind: "zero_total";
      invoicePublicId: string;
    }
  | {
      settlementKind: "waived_small_total";
      invoicePublicId: string;
      providerMinimumMinor: number;
    };

export interface SettleCheckoutInvoiceResult {
  settlementKind: "zero_total" | "waived_small_total";
  invoiceId: number;
  invoicePublicId: string;
  invoiceNumber: string | null;
  invoiceStatus: InvoiceStatus;
  waivedMinor: number;
  receiptPublicId: string | null;
  duplicate: boolean;
}

export interface CheckoutInvoiceSnapshot {
  invoiceId: number;
  invoicePublicId: string;
  invoiceNumber: string | null;
  orderId: number;
  orderPublicId: string;
  orderReference: string;
  ownerUserId: number;
  status: InvoiceStatus;
  currency: string;
  totalMinor: number;
  balanceDueMinor: number;
  waivedMinor: number;
  receiptPublicId?: string | null | undefined;
  issuedAt: Date | null;
  voidedAt: Date | null;
  origin: "portal" | "import";
}

export interface OrderPaymentSummary {
  state: OrderHeaderPaymentState;
  totalMinor: number;
  currency: string;
}

export interface OrderInvoiceRefundLedgerEntry {
  refundId: number;
  refundPublicId: string;
  paymentId: number;
  paymentPublicId: string;
  amountMinor: number;
  currency: string;
  reasonCode: string;
  reference: string;
  provider: string | null;
  providerEventId: string | null;
  notes: string | null;
  refundedAt: Date;
  origin: "portal" | "import";
}

export interface OrderInvoicePaymentLedgerEntry {
  paymentId: number;
  paymentPublicId: string;
  invoiceId: number;
  invoicePublicId: string;
  invoiceNumber: string;
  invoiceStatus: InvoiceStatus;
  invoicePaymentState: InvoicePaymentState;
  method: PaymentMethod;
  provider: string | null;
  reference: string;
  providerEventId: string | null;
  capturedMinor: number;
  ledgerRefundedMinor: number;
  currency: string;
  receivedAt: Date;
  origin: "portal" | "import";
  ledgerRefunds: OrderInvoiceRefundLedgerEntry[];
}

export interface OrderRefundLedgerSnapshot {
  orderPublicId: string;
  orderPaymentState: InvoicePaymentState | "none";
  orderHeaderState: OrderHeaderPaymentState;
  payments: OrderInvoicePaymentLedgerEntry[];
}

export interface LockedOrderPaymentForRefund {
  orderId: number;
  orderPublicId: string;
  orderReference: string;
  ownerUserId: number;
  invoiceId: number;
  invoicePublicId: string;
  invoiceNumber: string;
  invoiceStatus: InvoiceStatus;
  invoicePaymentState: InvoicePaymentState;
  currency: string;
  totalMinor: number;
  paymentId: number;
  paymentPublicId: string;
  method: PaymentMethod;
  provider: string | null;
  providerReference: string;
  providerEventId: string | null;
  capturedMinor: number;
  paidAt: Date;
  ledgerRefunds: Array<{
    refundPublicId: string;
    amountMinor: number;
    idempotencyKey: string;
    providerEventId: string | null;
  }>;
}

export interface BookSettledRefundInput {
  invoiceId: number;
  paymentId: number;
  amountMinor: number;
  currency: string;
  reasonCode: string;
  reference: string;
  notes?: string | null | undefined;
  refundedAt: Date;
  recordedByUserId: number | null;
  idempotencyKey: string;
  provider?: "stripe" | "square" | null | undefined;
  providerEventId?: string | null | undefined;
}

export interface BookSettledRefundResult {
  complianceRefundPublicId: string;
  invoiceStatus: InvoiceStatus;
  invoicePaymentState: InvoicePaymentState;
  orderPaymentState: InvoicePaymentState | "none";
  balanceDueMinor: number;
  fullyRefundedInvoice: boolean;
  duplicate: boolean;
}


function isStaffOrAdmin(principal: SessionPrincipal): boolean {
  return principal.role === "staff" || principal.role === "admin";
}

async function assertStaffInvoiceRead(deps: ModuleDeps, principal: SessionPrincipal): Promise<void> {
  const resource = { type: "invoice" };
  if (principal.state !== "full" || principal.pendingSteps.length > 0) {
    await denyComplianceAuthz(deps, principal, "REMEDIATION_SESSION", resource);
  }
  if (
    !roleHasCapability(principal.role, "invoices.read_all") &&
    !roleHasCapability(principal.role, "invoices.manage") &&
    !roleHasCapability(principal.role, "invoices.record_payment")
  ) {
    await denyComplianceAuthz(deps, principal, "CAPABILITY_NOT_GRANTED", resource);
  }
}

/**
 * Compile-time constant per integrator security decision:
 * Stripe / external online payment ledger booking is a DISABLED SCAFFOLD in this release
 * and cannot be enabled by any runtime setting or feature flag.
 */
export const PROVIDER_LEDGER_BOOKING_ENABLED = false as const;

export function createInvoicesService(deps: ModuleDeps, receiptsSvc?: ReceiptsService) {
  const paidListeners: InvoicePaidListener[] = [];

  function onInvoicePaid(listener: InvoicePaidListener): void {
    paidListeners.push(listener);
  }

  function requireOrdersService() {
    const ordersSvc = (deps.services as Partial<typeof deps.services>).orders;
    if (!ordersSvc) {
      throw new DomainError("UNAVAILABLE", "ORDERS_UNAVAILABLE", "Order service is temporarily unavailable.");
    }
    return ordersSvc;
  }

  /**
   * Workflow-aware check matching `orders/workflowTypes.ts:isCancelState` (`kind === "terminal" && /cancel/.test(key)`),
   * resolved directly against the `FOR UPDATE`-locked `(workflowVersionId, statusKey)` so `REPEATABLE READ`
   * snapshots never re-read stale order rows.
   */
  async function isOrderCancelledInTx(
    workflowVersionId: number | undefined,
    statusKey: string,
    tx: Tx,
  ): Promise<boolean> {
    const ordersSvc = (deps.services as Partial<typeof deps.services>).orders;
    if (
      workflowVersionId !== undefined &&
      ordersSvc?.workflows &&
      typeof ordersSvc.workflows.byVersionId === "function"
    ) {
      const bound = await ordersSvc.workflows.byVersionId(tx, workflowVersionId);
      const state = bound.definition.states.find((s) => s.key === statusKey);
      return Boolean(state && state.kind === "terminal" && /cancel/.test(state.key));
    }
    return /cancel/.test(statusKey);
  }

  async function isOnlinePaymentConfigured(tx?: DbOrTx): Promise<boolean> {
    const paymentsSvc = (
      deps.services as unknown as {
        payments?: { isOnlineCheckoutEnabled?: (dbOrTx?: DbOrTx) => Promise<boolean> };
      }
    ).payments;
    if (paymentsSvc && typeof paymentsSvc.isOnlineCheckoutEnabled === "function") {
      return paymentsSvc.isOnlineCheckoutEnabled(tx);
    }
    return PROVIDER_LEDGER_BOOKING_ENABLED;
  }

  async function isCustomerFirstPaidInvoiceInTx(
    tx: Tx,
    ownerUserId: number,
    currentInvoiceId: number,
  ): Promise<boolean> {
    const ordersSvc = (deps.services as Partial<typeof deps.services>).orders;
    if (!ordersSvc || typeof ordersSvc.portableOrders !== "function") {
      return true;
    }
    const orderIds: number[] = [];
    let after: number | undefined;
    for (let page = 0; page < 10; page += 1) {
      const batch = await ordersSvc.portableOrders(tx, {
        customerIds: [ownerUserId],
        limit: 200,
        ...(after !== undefined ? { after } : {}),
      });
      for (const item of batch.items) {
        orderIds.push(item.id);
      }
      if (batch.nextAfter === null) break;
      after = batch.nextAfter;
    }
    if (orderIds.length === 0) return true;
    const [prior] = await tx
      .select({ total: count() })
      .from(complianceInvoices)
      .where(
        and(
          inArray(complianceInvoices.orderId, orderIds),
          eq(complianceInvoices.status, "paid"),
          ne(complianceInvoices.id, currentInvoiceId),
        ),
      );
    return (prior?.total ?? 0) === 0;
  }

  async function syncOrderAndCartOnPaidInTx(
    tx: Tx,
    input: {
      orderPublicId: string;
      invoicePublicId: string;
      paidAt: Date;
      method: "stripe" | "manual";
      amountMinor: number;
      currency: string;
    },
  ): Promise<void> {
    const cartSvc = (
      deps.services as unknown as {
        cart?: {
          onInvoicePaidInTx?: (
            arg: { invoicePublicId: string; orderPublicId?: string; paidAt?: Date },
            txArg: Tx,
          ) => Promise<unknown>;
        };
      }
    ).cart;
    if (cartSvc && typeof cartSvc.onInvoicePaidInTx === "function") {
      await cartSvc.onInvoicePaidInTx(
        {
          invoicePublicId: input.invoicePublicId,
          orderPublicId: input.orderPublicId,
          paidAt: input.paidAt,
        },
        tx,
      );
    }

    const ordersPaymentsSvc = (
      deps.services as unknown as {
        orders?: {
          payments?: {
            onInvoicePaidInTx?: (
              arg: {
                orderPublicId: string;
                invoicePublicId: string;
                paidAt: Date;
                method: "stripe" | "manual";
                amountMinor: number;
                currency: string;
              },
              txArg: Tx,
            ) => Promise<unknown>;
          };
        };
      }
    ).orders?.payments;
    if (ordersPaymentsSvc && typeof ordersPaymentsSvc.onInvoicePaidInTx === "function") {
      await ordersPaymentsSvc.onInvoicePaidInTx(input, tx);
    }
  }

  async function syncOrderPaymentEventInTx(
    tx: Tx,
    input: {
      orderPublicId: string;
      kind: "pending_async" | "failed" | "refunded" | "partially_refunded";
      eventRef: string;
    },
  ): Promise<void> {
    const ordersPaymentsSvc = (
      deps.services as unknown as {
        orders?: {
          payments?: {
            onPaymentEventInTx?: (
              arg: {
                orderPublicId: string;
                kind: "pending_async" | "failed" | "refunded" | "partially_refunded";
                eventRef: string;
              },
              txArg: Tx,
            ) => Promise<unknown>;
          };
        };
      }
    ).orders?.payments;
    if (ordersPaymentsSvc && typeof ordersPaymentsSvc.onPaymentEventInTx === "function") {
      await ordersPaymentsSvc.onPaymentEventInTx(input, tx);
    }
  }

  async function dispatchInvoicePaidInTx(tx: Tx, event: InvoicePaidEvent): Promise<void> {
    await syncOrderAndCartOnPaidInTx(tx, {
      orderPublicId: event.orderPublicId,
      invoicePublicId: event.invoicePublicId,
      paidAt: event.paidAt,
      method: event.provider ? "stripe" : "manual",
      amountMinor: event.netPaidMinor,
      currency: event.currency,
    });

    const referralsSvc = (
      deps.services as unknown as {
        referrals?: {
          onInvoicePaid?: (
            evt: {
              invoicePublicId: string;
              orderPublicId: string;
              customerUserId: number;
              currency: string;
              subtotalMinor: number;
              discountMinor: number;
              taxMinor: number;
              totalMinor: number;
              isFirstPaidInvoice?: boolean;
              paidAt?: Date;
            },
            opts?: { tx?: Tx },
          ) => Promise<unknown>;
        };
      }
    ).referrals;

    if (referralsSvc && typeof referralsSvc.onInvoicePaid === "function") {
      const isFirstPaidInvoice = await isCustomerFirstPaidInvoiceInTx(tx, event.ownerUserId, event.invoiceId);
      await referralsSvc.onInvoicePaid(
        {
          invoicePublicId: event.invoicePublicId,
          orderPublicId: event.orderPublicId,
          customerUserId: event.ownerUserId,
          currency: event.currency,
          subtotalMinor: event.subtotalMinor,
          discountMinor: event.discountMinor,
          taxMinor: event.taxMinor,
          totalMinor: event.totalMinor,
          isFirstPaidInvoice,
          paidAt: event.paidAt,
        },
        { tx },
      );
    }

    for (const listener of paidListeners) {
      await listener(event, tx);
    }
  }

  async function dispatchInvoiceRefundedInTx(
    tx: Tx,
    event: {
      invoicePublicId: string;
      orderPublicId: string;
      customerUserId: number;
      currency: string;
      totalMinor: number;
      refundedMinor: number;
      fullyRefunded: boolean;
      refundedAt: Date;
    },
  ): Promise<void> {
    if (!event.fullyRefunded) return;
    const referralsSvc = (
      deps.services as unknown as {
        referrals?: {
          onInvoiceRefunded?: (
            evt: {
              invoicePublicId: string;
              orderPublicId: string;
              customerUserId: number;
              currency: string;
              totalMinor: number;
              refundedMinor: number;
              fullyRefunded: boolean;
              refundedAt: Date;
            },
            opts?: { tx?: Tx },
          ) => Promise<unknown>;
        };
      }
    ).referrals;

    if (referralsSvc && typeof referralsSvc.onInvoiceRefunded === "function") {
      await referralsSvc.onInvoiceRefunded(event, { tx });
    }
  }

  interface LedgerSums {
    /** Actual captured cash (excludes waived balances). */
    grossPaidMinor: number;
    /** Non-cash balance waived at checkout (`waived_small_total` / `method = "waiver"`). */
    waivedMinor: number;
    /** `grossPaidMinor + waivedMinor` — total settled credit toward invoice total. */
    settledGrossMinor: number;
    refundedMinor: number;
  }

  const EMPTY_LEDGER_SUMS: LedgerSums = {
    grossPaidMinor: 0,
    waivedMinor: 0,
    settledGrossMinor: 0,
    refundedMinor: 0,
  };

  async function computeLedgerSums(
    dbOrTx: DbOrTx,
    invoiceIds: readonly number[],
    options?: { currentRead?: boolean },
  ): Promise<Map<number, LedgerSums>> {
    const map = new Map<number, LedgerSums>();
    if (invoiceIds.length === 0) return map;
    for (const id of invoiceIds) {
      map.set(id, { ...EMPTY_LEDGER_SUMS });
    }

    const paymentsQuery = dbOrTx
      .select({
        invoiceId: complianceInvoicePayments.invoiceId,
        method: complianceInvoicePayments.method,
        status: complianceInvoicePayments.status,
        amountMinor: complianceInvoicePayments.amountMinor,
        waivedMinor: complianceInvoicePayments.waivedMinor,
      })
      .from(complianceInvoicePayments)
      .where(inArray(complianceInvoicePayments.invoiceId, [...invoiceIds]))
      .orderBy(asc(complianceInvoicePayments.id));

    const refundsQuery = dbOrTx
      .select({
        invoiceId: complianceInvoiceRefunds.invoiceId,
        amountMinor: complianceInvoiceRefunds.amountMinor,
      })
      .from(complianceInvoiceRefunds)
      .where(inArray(complianceInvoiceRefunds.invoiceId, [...invoiceIds]))
      .orderBy(asc(complianceInvoiceRefunds.id));

    let payments;
    let refunds;
    if (options?.currentRead) {
      // Canonical lock order under parent `orders -> compliance_invoices FOR UPDATE`:
      // lock `compliance_invoice_payments` (asc id) before `compliance_invoice_refunds` (asc id),
      // forcing InnoDB current reads past any earlier REPEATABLE READ snapshot in `dbOrTx`.
      payments = await paymentsQuery.for("update");
      refunds = await refundsQuery.for("update");
    } else {
      [payments, refunds] = await Promise.all([paymentsQuery, refundsQuery]);
    }

    for (const p of payments) {
      if (p.status === "succeeded") {
        const entry = map.get(p.invoiceId);
        if (entry) {
          const rowWaived =
            p.method === "waiver"
              ? Math.max(0, p.waivedMinor || p.amountMinor)
              : Math.max(0, Math.min(p.amountMinor, p.waivedMinor ?? 0));
          const rowCaptured = Math.max(0, p.amountMinor - rowWaived);
          entry.grossPaidMinor += rowCaptured;
          entry.waivedMinor += rowWaived;
          entry.settledGrossMinor += rowCaptured + rowWaived;
        }
      }
    }
    for (const r of refunds) {
      const entry = map.get(r.invoiceId);
      if (entry) entry.refundedMinor += r.amountMinor;
    }

    return map;
  }

  const invoiceBuyerSnapshotAad = (invoicePublicId: string) =>
    `compliance_invoices.buyer_snapshot:${invoicePublicId}`;

  function encodeBuyerSnapshot(invoicePublicId: string, buyer: InvoiceBuyerSnapshot): string {
    return deps.crypto.encrypt(JSON.stringify(buyer), invoiceBuyerSnapshotAad(invoicePublicId));
  }

  function decodeBuyerSnapshot(
    invoicePublicId: string,
    enc: string | null | undefined,
    customerRefFallback: string | null,
  ): InvoiceBuyerSnapshot | null {
    if (!enc) return null;
    try {
      const parsed = JSON.parse(
        deps.crypto.decrypt(enc, invoiceBuyerSnapshotAad(invoicePublicId)),
      ) as Partial<InvoiceBuyerSnapshot>;
      const name = typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : "Customer";
      const email = typeof parsed.email === "string" ? parsed.email.trim() : "";
      const customerRef =
        typeof parsed.customerRef === "string" && parsed.customerRef.trim()
          ? parsed.customerRef.trim()
          : customerRefFallback;
      return { name, email, customerRef };
    } catch {
      return null;
    }
  }

  async function resolveFreshBuyerProfileInTx(
    dbOrTx: DbOrTx,
    ownerUserId: number,
  ): Promise<InvoiceBuyerSnapshot | null> {
    if (!Number.isInteger(ownerUserId) || ownerUserId <= 0) return null;
    try {
      const [row] = await dbOrTx
        .select({
          id: users.id,
          publicId: users.publicId,
          emailEnc: users.emailEnc,
          nameEnc: users.nameEnc,
          customerRef: users.customerRef,
          purgedAt: users.purgedAt,
        })
        .from(users)
        .where(eq(users.id, ownerUserId))
        .limit(1);
      if (row) {
        if (row.purgedAt !== null) {
          return {
            name: "Deleted account",
            email: "",
            customerRef: row.customerRef ?? null,
          };
        }
        const name = deps.crypto.decrypt(row.nameEnc, `users.name:${row.publicId}`).trim();
        const email = deps.crypto.decrypt(row.emailEnc, `users.email:${row.publicId}`).trim();
        return {
          name: name || "Customer",
          email,
          customerRef: row.customerRef ?? null,
        };
      }
    } catch {
      // Standalone compliance unit tests may omit `users` rows.
    }

    const identitySvc = (deps.services as Partial<typeof deps.services>).identity;
    if (identitySvc && typeof identitySvc.getUser === "function") {
      try {
        const user = await identitySvc.getUser(ownerUserId);
        if (user) {
          return {
            name: user.name?.trim() || "Customer",
            email: user.email?.trim() || "",
            customerRef: user.customerRef ?? null,
          };
        }
      } catch {
        // Ignore lookup error.
      }
    }
    return null;
  }

  async function captureFreshBuyerSnapshotInTx(
    tx: Tx,
    ownerUserId: number,
    invoicePublicId: string,
  ): Promise<{ buyerSnapshotEnc: string | null; customerRefSnapshot: string | null }> {
    const buyer = await resolveFreshBuyerProfileInTx(tx, ownerUserId);
    if (!buyer || buyer.name === "Deleted account") {
      return {
        buyerSnapshotEnc: null,
        customerRefSnapshot: buyer?.customerRef ?? null,
      };
    }
    return {
      buyerSnapshotEnc: encodeBuyerSnapshot(invoicePublicId, buyer),
      customerRefSnapshot: buyer.customerRef,
    };
  }

  async function readLiveOrFrozenBuyerInTx(
    dbOrTx: DbOrTx,
    ownerUserId: number | null,
    inv: {
      publicId: string;
      buyerSnapshotEnc: string | null;
      customerRefSnapshot: string | null;
    },
  ): Promise<InvoiceBuyerSnapshot | null> {
    const frozen = decodeBuyerSnapshot(inv.publicId, inv.buyerSnapshotEnc, inv.customerRefSnapshot);
    if (frozen) return frozen;
    if (ownerUserId !== null && ownerUserId > 0) {
      const live = await resolveFreshBuyerProfileInTx(dbOrTx, ownerUserId);
      if (live) {
        return {
          ...live,
          customerRef: live.customerRef ?? inv.customerRefSnapshot ?? null,
        };
      }
    }
    if (inv.customerRefSnapshot) {
      return {
        name: "Customer",
        email: "",
        customerRef: inv.customerRefSnapshot,
      };
    }
    return null;
  }

  async function freezeInvoicesForOrderInTx(tx: Tx, orderId: number): Promise<void> {
    const issuedRows = await tx
      .select()
      .from(complianceInvoices)
      .where(eq(complianceInvoices.orderId, orderId))
      .orderBy(asc(complianceInvoices.id))
      .for("update");

    const targets = issuedRows.filter((row) => row.issuedAt !== null);
    if (targets.length === 0) return;

    let orderRef: string | null = null;
    let ownerUserId: number | null = null;
    try {
      const [ord] = await tx
        .select({
          reference: orders.reference,
          ownerUserId: orders.ownerUserId,
        })
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1);
      if (ord) {
        orderRef = ord.reference || null;
        ownerUserId = ord.ownerUserId;
      }
    } catch {
      // Standalone tests may omit `orders` rows.
    }
    const ordersSvc = (deps.services as Partial<typeof deps.services>).orders;
    if ((!orderRef || ownerUserId === null) && ordersSvc) {
      if (typeof ordersSvc.retainedOrderRefInTx === "function") {
        const ret = await ordersSvc.retainedOrderRefInTx(tx, orderId);
        if (ret) {
          orderRef = orderRef ?? ret.reference;
          ownerUserId = ownerUserId ?? ret.ownerUserId;
        }
      } else if (typeof ordersSvc.getOrderRefById === "function") {
        const ref = await ordersSvc.getOrderRefById(orderId, tx);
        if (ref) {
          orderRef = orderRef ?? ref.reference;
          ownerUserId = ownerUserId ?? ref.ownerUserId;
        }
      }
    }

    const [issuerName, issuerAddress, issuerContact] = await Promise.all([
      readSetting(deps.settings, INVOICE_ISSUER_NAME, tx),
      readSetting(deps.settings, INVOICE_ISSUER_ADDRESS, tx),
      readSetting(deps.settings, INVOICE_ISSUER_CONTACT, tx),
    ]);
    const freshBuyer =
      ownerUserId !== null ? await resolveFreshBuyerProfileInTx(tx, ownerUserId) : null;

    const now = deps.clock.now();
    for (const inv of targets) {
      const needsBuyer = !inv.buyerSnapshotEnc && freshBuyer && freshBuyer.name !== "Deleted account";
      const nextBuyerEnc = needsBuyer
        ? encodeBuyerSnapshot(inv.publicId, freshBuyer)
        : inv.buyerSnapshotEnc;
      const nextCustomerRef =
        inv.customerRefSnapshot ?? freshBuyer?.customerRef ?? null;
      const nextOrderRef =
        inv.orderReferenceSnapshot ?? orderRef ?? inv.orderPublicId;
      const nextIssuerName = inv.issuerNameSnapshot ?? issuerName;
      const nextIssuerAddress = inv.issuerAddressSnapshot ?? issuerAddress;
      const nextIssuerContact = inv.issuerContactSnapshot ?? issuerContact;

      if (
        nextBuyerEnc !== inv.buyerSnapshotEnc ||
        nextCustomerRef !== inv.customerRefSnapshot ||
        nextOrderRef !== inv.orderReferenceSnapshot ||
        nextIssuerName !== inv.issuerNameSnapshot ||
        nextIssuerAddress !== inv.issuerAddressSnapshot ||
        nextIssuerContact !== inv.issuerContactSnapshot
      ) {
        await tx
          .update(complianceInvoices)
          .set({
            buyerSnapshotEnc: nextBuyerEnc,
            customerRefSnapshot: nextCustomerRef,
            orderReferenceSnapshot: nextOrderRef,
            issuerNameSnapshot: nextIssuerName,
            issuerAddressSnapshot: nextIssuerAddress,
            issuerContactSnapshot: nextIssuerContact,
            updatedAt: now,
          })
          .where(eq(complianceInvoices.id, inv.id));
      }
    }
  }

  async function resolveOrderMetaMap(
    dbOrTx: DbOrTx,
    orderIds: readonly number[],
  ): Promise<
    Map<
      number,
      {
        reference: string;
        projectName: string | null;
        lifecycle: InvoiceOrderLifecycleState;
        ownerUserId: number | null;
      }
    >
  > {
    const out = new Map<
      number,
      {
        reference: string;
        projectName: string | null;
        lifecycle: InvoiceOrderLifecycleState;
        ownerUserId: number | null;
      }
    >();
    const uniqueIds = [...new Set(orderIds.filter((id) => Number.isInteger(id) && id > 0))];
    if (uniqueIds.length === 0) return out;

    const seenSqlIds = new Set<number>();
    try {
      const ordRows = await dbOrTx
        .select({
          id: orders.id,
          reference: orders.reference,
          projectName: orders.projectName,
          ownerUserId: orders.ownerUserId,
          trashedAt: orders.trashedAt,
          purgedAt: orders.purgedAt,
        })
        .from(orders)
        .where(inArray(orders.id, uniqueIds));
      for (const row of ordRows) {
        seenSqlIds.add(row.id);
        const trimmedProject = row.projectName?.trim() || null;
        if (row.purgedAt !== null) {
          out.set(row.id, {
            reference: row.reference,
            projectName: "Deleted order",
            lifecycle: "deleted",
            ownerUserId: row.ownerUserId,
          });
        } else if (row.trashedAt !== null) {
          out.set(row.id, {
            reference: row.reference,
            projectName: trimmedProject,
            lifecycle: "trashed",
            ownerUserId: row.ownerUserId,
          });
        } else {
          out.set(row.id, {
            reference: row.reference,
            projectName: trimmedProject,
            lifecycle: "live",
            ownerUserId: row.ownerUserId,
          });
        }
      }
    } catch {
      // Standalone compliance unit tests may run without `orders` table populated.
    }

    const ordersSvc = (deps.services as Partial<typeof deps.services>).orders;
    for (const orderId of uniqueIds) {
      const existing = out.get(orderId);
      if (existing && (existing.lifecycle !== "live" || existing.projectName)) continue;

      if (ordersSvc && typeof ordersSvc.getOrderRefById === "function") {
        const ref = await ordersSvc.getOrderRefById(
          orderId,
          dbOrTx !== deps.db ? (dbOrTx as Tx) : undefined,
        );
        if (ref) {
          const candidateName =
            typeof (ref as { name?: unknown }).name === "string" ? ref.name.trim() : "";
          out.set(orderId, {
            reference: existing?.reference || ref.reference,
            projectName: existing?.projectName ?? (candidateName || null),
            lifecycle: "live",
            ownerUserId: existing?.ownerUserId ?? ref.ownerUserId,
          });
          continue;
        }
      }

      if (!seenSqlIds.has(orderId)) {
        if (ordersSvc && typeof ordersSvc.retainedOrderRefInTx === "function") {
          const ret = await ordersSvc.retainedOrderRefInTx(dbOrTx as Tx, orderId);
          if (ret) {
            out.set(orderId, {
              reference: ret.reference,
              projectName: ret.purged ? "Deleted order" : null,
              lifecycle: ret.purged ? "deleted" : ret.trashed ? "trashed" : "live",
              ownerUserId: ret.ownerUserId,
            });
            continue;
          }
        }
        out.set(orderId, {
          reference: "",
          projectName: "Deleted order",
          lifecycle: "deleted",
          ownerUserId: null,
        });
      }
    }

    return out;
  }

  function toSummaryView(
    inv: typeof complianceInvoices.$inferSelect,
    orderReference: string,
    sums: LedgerSums,
    projectName: string | null = null,
    orderLifecycleState: InvoiceOrderLifecycleState = "live",
  ): InvoiceSummaryView {
    const derivedStatus = deriveInvoiceStatus({
      issuedAt: inv.issuedAt,
      voidedAt: inv.voidedAt,
      totalMinor: inv.totalMinor,
      grossPaidMinor: sums.settledGrossMinor,
      refundedMinor: sums.refundedMinor,
    });
    const derivedPaymentState = deriveInvoicePaymentState({
      issuedAt: inv.issuedAt,
      voidedAt: inv.voidedAt,
      totalMinor: inv.totalMinor,
      grossPaidMinor: sums.settledGrossMinor,
      refundedMinor: sums.refundedMinor,
    });
    const netPaidMinor = Math.max(0, sums.grossPaidMinor - sums.refundedMinor);
    const netSettledMinor = Math.max(0, sums.settledGrossMinor - sums.refundedMinor);
    const balanceDueMinor =
      derivedStatus === "void" || derivedStatus === "draft"
        ? 0
        : Math.max(0, inv.totalMinor - netSettledMinor);

    return {
      invoicePublicId: inv.publicId,
      orderPublicId: inv.orderPublicId,
      orderReference: orderReference || inv.orderReferenceSnapshot || inv.orderPublicId,
      projectName: orderLifecycleState === "deleted" ? (projectName ?? "Deleted order") : projectName,
      orderLifecycleState,
      invoiceNumber: inv.invoiceNumber,
      status: derivedStatus,
      paymentState: derivedPaymentState,
      currency: inv.currency,
      subtotalMinor: inv.subtotalMinor,
      discountMinor: inv.discountMinor,
      taxMinor: inv.taxMinor,
      totalMinor: inv.totalMinor,
      grossPaidMinor: sums.grossPaidMinor,
      waivedMinor: sums.waivedMinor,
      refundedMinor: sums.refundedMinor,
      netPaidMinor,
      balanceDueMinor,
      issuedAt: inv.issuedAt,
      dueAt: inv.dueAt,
      voidedAt: inv.voidedAt,
      origin: inv.origin,
      version: inv.version,
      createdAt: inv.createdAt,
    };
  }

  async function allocateInvoiceSequenceInTx(tx: Tx, now: Date): Promise<number> {
    const [existing] = await tx
      .select()
      .from(complianceSequences)
      .where(eq(complianceSequences.seqKey, "invoice"))
      .for("update")
      .limit(1);

    if (!existing) {
      await tx
        .insert(complianceSequences)
        .values({
          seqKey: "invoice",
          nextVal: 2,
          updatedAt: now,
        })
        .onDuplicateKeyUpdate({ set: { updatedAt: now } });
      // Re-select under lock in case a concurrent tx inserted simultaneously
      const [locked] = await tx
        .select()
        .from(complianceSequences)
        .where(eq(complianceSequences.seqKey, "invoice"))
        .for("update")
        .limit(1);
      if (!locked) return 1;
      if (locked.nextVal === 2) return 1;
      const allocated = locked.nextVal;
      await tx
        .update(complianceSequences)
        .set({ nextVal: allocated + 1, updatedAt: now })
        .where(eq(complianceSequences.seqKey, "invoice"));
      return allocated;
    }

    const allocated = existing.nextVal;
    await tx
      .update(complianceSequences)
      .set({ nextVal: allocated + 1, updatedAt: now })
      .where(eq(complianceSequences.seqKey, "invoice"));
    return allocated;
  }

  /* --------------------------------------------------- customer & order read */

  async function listForOrder(
    principal: SessionPrincipal,
    orderPublicId: string,
  ): Promise<{
    orderPublicId: string;
    orderReference: string;
    lockState: string;
    onlinePaymentConfigured: boolean;
    items: InvoiceSummaryView[];
  }> {
    const ordersSvc = requireOrdersService();
    const orderView = await ordersSvc.assertCanReadOrder(principal, orderPublicId);
    const staffView = isStaffOrAdmin(principal);

    const rows = await deps.db
      .select()
      .from(complianceInvoices)
      .where(eq(complianceInvoices.orderId, orderView.id))
      .orderBy(desc(complianceInvoices.id));

    const visibleRows = staffView ? rows : rows.filter((r) => r.issuedAt !== null);
    const [sumsMap, onlineConfigured, orderMetaMap] = await Promise.all([
      computeLedgerSums(
        deps.db,
        visibleRows.map((r) => r.id),
      ),
      isOnlinePaymentConfigured(),
      resolveOrderMetaMap(deps.db, [orderView.id]),
    ]);
    const projectName = orderMetaMap.get(orderView.id)?.projectName ?? null;

    return {
      orderPublicId: orderView.publicId,
      orderReference: orderView.reference,
      lockState: orderView.lockState,
      onlinePaymentConfigured: onlineConfigured,
      items: visibleRows.map((inv) =>
        toSummaryView(inv, orderView.reference, sumsMap.get(inv.id) ?? EMPTY_LEDGER_SUMS, projectName),
      ),
    };
  }

  async function listMine(
    principal: SessionPrincipal,
    input: { status?: InvoiceStatus | undefined; cursor?: string | undefined; limit?: number | undefined },
  ): Promise<{ items: InvoiceSummaryView[]; nextCursor: string | null }> {
    if (principal.state !== "full" || principal.pendingSteps.length > 0) {
      throw notFound("INVOICE_NOT_FOUND");
    }
    const liveActor = await assertLiveActorInTx(deps, principal, deps.db as unknown as Tx);
    const livePrincipal: SessionPrincipal = { ...principal, role: liveActor.role };
    const ordersSvc = requireOrdersService();
    const accessible = await ordersSvc.listAccessibleOrderIds(livePrincipal, { limit: 1000 });
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
    const afterId = decodeIdCursor(input.cursor);
    const staffView = isStaffOrAdmin(livePrincipal);

    // D2.6: while an order is in trash or deleted, paid invoices stay available to the owning customer
    // while unpaid/void/draft invoices are hidden.
    const nonLiveOwnedOrderIds = new Set<number>();
    if (!accessible.all) {
      try {
        const ownedRows = await deps.db
          .select({
            id: orders.id,
            trashedAt: orders.trashedAt,
            purgedAt: orders.purgedAt,
          })
          .from(orders)
          .where(eq(orders.ownerUserId, liveActor.userId));
        for (const row of ownedRows) {
          if (row.trashedAt !== null || row.purgedAt !== null) {
            nonLiveOwnedOrderIds.add(row.id);
          }
        }
      } catch {
        // Standalone compliance unit tests may omit `orders` rows.
      }
    }

    const candidateOrderIds = accessible.all
      ? []
      : Array.from(new Set([...accessible.orderIds, ...nonLiveOwnedOrderIds]));

    if (!accessible.all && candidateOrderIds.length === 0) {
      return { items: [], nextCursor: null };
    }

    const conds = [];
    if (!accessible.all) {
      conds.push(inArray(complianceInvoices.orderId, candidateOrderIds));
    }
    if (afterId !== null) {
      conds.push(lt(complianceInvoices.id, afterId));
    }
    if (input.status) {
      conds.push(eq(complianceInvoices.status, input.status));
    }

    const rows = await deps.db
      .select()
      .from(complianceInvoices)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(complianceInvoices.id))
      .limit(limit + 50);

    const candidates = staffView ? rows : rows.filter((r) => r.issuedAt !== null);
    const candidateUniqueOrderIds = Array.from(new Set(candidates.map((r) => r.orderId)));
    const [sumsMap, orderMetaMap] = await Promise.all([
      computeLedgerSums(
        deps.db,
        candidates.map((r) => r.id),
      ),
      resolveOrderMetaMap(deps.db, candidateUniqueOrderIds),
    ]);

    const visible = candidates.filter((r) => {
      const s = sumsMap.get(r.id) ?? EMPTY_LEDGER_SUMS;
      const derived = deriveInvoiceStatus({
        totalMinor: r.totalMinor,
        issuedAt: r.issuedAt,
        voidedAt: r.voidedAt,
        grossPaidMinor: s.settledGrossMinor,
        refundedMinor: s.refundedMinor,
      });
      if (!staffView) {
        const meta = orderMetaMap.get(r.orderId);
        const isNonLive =
          nonLiveOwnedOrderIds.has(r.orderId) || (meta !== undefined && meta.lifecycle !== "live");
        if (isNonLive && derived !== "paid") {
          return false;
        }
      }
      if (input.status && derived !== input.status) {
        return false;
      }
      return true;
    });

    const hasMore = visible.length > limit;
    const slice = hasMore ? visible.slice(0, limit) : visible;

    const items = slice
      .map((inv) => {
        const meta = orderMetaMap.get(inv.orderId);
        return toSummaryView(
          inv,
          meta?.reference || inv.orderReferenceSnapshot || inv.orderPublicId,
          sumsMap.get(inv.id) ?? EMPTY_LEDGER_SUMS,
          meta?.projectName ?? null,
          meta?.lifecycle ?? "live",
        );
      })
      .filter((view) => (input.status ? view.status === input.status : true));

    const last = slice[slice.length - 1];
    return {
      items,
      nextCursor: hasMore && last ? encodeIdCursor(last.id) : null,
    };
  }

  async function resolveInvoiceOrderAccess(
    principal: SessionPrincipal,
    inv: typeof complianceInvoices.$inferSelect,
    sums: LedgerSums,
    opts?: { tx?: Tx },
  ): Promise<{
    liveActor: { userId: number; role: SessionPrincipal["role"] };
    livePrincipal: SessionPrincipal;
    staffView: boolean;
    lifecycle: InvoiceOrderLifecycleState;
    orderReference: string;
    ownerUserId: number | null;
    liveOrderView: Awaited<ReturnType<ReturnType<typeof requireOrdersService>["assertCanReadOrder"]>> | null;
  }> {
    const dbOrTx = opts?.tx ?? (deps.db as unknown as Tx);
    const liveActor = await assertLiveActorInTx(deps, principal, dbOrTx);
    const livePrincipal: SessionPrincipal = { ...principal, role: liveActor.role };
    const staffView = isStaffOrAdmin(livePrincipal);
    const ordersSvc = requireOrdersService();

    try {
      const orderView = await ordersSvc.assertCanReadOrder(
        livePrincipal,
        inv.orderPublicId,
        opts?.tx ? { tx: opts.tx } : undefined,
      );
      return {
        liveActor,
        livePrincipal,
        staffView,
        lifecycle: "live",
        orderReference: orderView.reference || inv.orderReferenceSnapshot || inv.orderPublicId,
        ownerUserId: orderView.ownerUserId,
        liveOrderView: orderView,
      };
    } catch (err) {
      if (!(err instanceof DomainError && err.code === "NOT_FOUND")) {
        throw err;
      }
    }

    // Order is either not accessible to this caller OR in trash / permanently deleted.
    let lifecycle: InvoiceOrderLifecycleState = "deleted";
    let ownerUserId: number | null = null;
    let retainedReference: string | null = null;

    try {
      const [ordRow] = await dbOrTx
        .select({
          reference: orders.reference,
          ownerUserId: orders.ownerUserId,
          trashedAt: orders.trashedAt,
          purgedAt: orders.purgedAt,
        })
        .from(orders)
        .where(eq(orders.id, inv.orderId))
        .limit(1);
      if (ordRow) {
        if (ordRow.purgedAt === null && ordRow.trashedAt === null) {
          // Live order that `assertCanReadOrder` denied -> strictly NOT_FOUND (no existence oracle).
          throw notFound("INVOICE_NOT_FOUND");
        }
        lifecycle = ordRow.purgedAt !== null ? "deleted" : "trashed";
        ownerUserId = ordRow.ownerUserId;
        retainedReference = ordRow.reference || null;
      } else if (typeof ordersSvc.retainedOrderRefInTx === "function") {
        const ret = await ordersSvc.retainedOrderRefInTx(dbOrTx, inv.orderId);
        if (ret) {
          if (!ret.trashed && !ret.purged) {
            throw notFound("INVOICE_NOT_FOUND");
          }
          lifecycle = ret.purged ? "deleted" : "trashed";
          ownerUserId = ret.ownerUserId;
          retainedReference = ret.reference || null;
        } else if (typeof ordersSvc.getOrderRefById === "function") {
          const liveRef = await ordersSvc.getOrderRefById(inv.orderId, opts?.tx);
          if (liveRef) {
            throw notFound("INVOICE_NOT_FOUND");
          }
        }
      } else if (typeof ordersSvc.getOrderRefById === "function") {
        const liveRef = await ordersSvc.getOrderRefById(inv.orderId, opts?.tx);
        if (liveRef) {
          throw notFound("INVOICE_NOT_FOUND");
        }
      }
    } catch (err) {
      if (err instanceof DomainError) throw err;
    }

    const derivedStatus = deriveInvoiceStatus({
      issuedAt: inv.issuedAt,
      voidedAt: inv.voidedAt,
      totalMinor: inv.totalMinor,
      grossPaidMinor: sums.settledGrossMinor,
      refundedMinor: sums.refundedMinor,
    });

    if (staffView && roleHasCapability(livePrincipal.role, "invoices.read_all")) {
      return {
        liveActor,
        livePrincipal,
        staffView,
        lifecycle,
        orderReference: retainedReference || inv.orderReferenceSnapshot || inv.orderPublicId,
        ownerUserId,
        liveOrderView: null,
      };
    }

    if (
      ownerUserId !== null &&
      ownerUserId === liveActor.userId &&
      inv.issuedAt !== null &&
      derivedStatus === "paid"
    ) {
      return {
        liveActor,
        livePrincipal,
        staffView: false,
        lifecycle,
        orderReference: retainedReference || inv.orderReferenceSnapshot || inv.orderPublicId,
        ownerUserId,
        liveOrderView: null,
      };
    }

    throw notFound("INVOICE_NOT_FOUND");
  }

  async function get(principal: SessionPrincipal, invoicePublicId: string): Promise<InvoiceDetailView> {
    const [inv] = await deps.db
      .select()
      .from(complianceInvoices)
      .where(eq(complianceInvoices.publicId, invoicePublicId))
      .limit(1);
    if (!inv) throw notFound("INVOICE_NOT_FOUND");

    const sumsMap = await computeLedgerSums(deps.db, [inv.id]);
    const sums = sumsMap.get(inv.id) ?? EMPTY_LEDGER_SUMS;
    const access = await resolveInvoiceOrderAccess(principal, inv, sums);
    const { staffView, lifecycle, orderReference, ownerUserId, liveOrderView, livePrincipal } = access;

    if (!staffView && inv.issuedAt === null) {
      throw notFound("INVOICE_NOT_FOUND");
    }

    const [
      lines,
      payments,
      refunds,
      issuerNameFallback,
      issuerAddrFallback,
      issuerContactFallback,
      paymentInstructions,
      onlineConfiguredRaw,
      orderMetaMap,
      buyer,
    ] = await Promise.all([
      deps.db
        .select()
        .from(complianceInvoiceLines)
        .where(eq(complianceInvoiceLines.invoiceId, inv.id))
        .orderBy(asc(complianceInvoiceLines.position)),
      deps.db
        .select()
        .from(complianceInvoicePayments)
        .where(eq(complianceInvoicePayments.invoiceId, inv.id))
        .orderBy(asc(complianceInvoicePayments.id)),
      deps.db
        .select()
        .from(complianceInvoiceRefunds)
        .where(eq(complianceInvoiceRefunds.invoiceId, inv.id))
        .orderBy(asc(complianceInvoiceRefunds.id)),
      readSetting(deps.settings, INVOICE_ISSUER_NAME),
      readSetting(deps.settings, INVOICE_ISSUER_ADDRESS),
      readSetting(deps.settings, INVOICE_ISSUER_CONTACT),
      readSetting(deps.settings, INVOICE_PAYMENT_INSTRUCTIONS),
      isOnlinePaymentConfigured(),
      resolveOrderMetaMap(deps.db, [inv.orderId]),
      readLiveOrFrozenBuyerInTx(deps.db, ownerUserId, inv),
    ]);

    const paymentById = new Map(payments.map((p) => [p.id, p]));
    const meta = orderMetaMap.get(inv.orderId);
    const resolvedProjectName =
      lifecycle === "deleted" ? "Deleted order" : (meta?.projectName ?? null);
    const summary = toSummaryView(
      inv,
      orderReference,
      sums,
      resolvedProjectName,
      lifecycle,
    );

    const orderDiscountMinor = Math.max(0, liveOrderView?.discountMinor ?? 0);
    const orderPromoMinor = Math.max(0, liveOrderView?.promoDiscountMinor ?? 0);
    const orderBundleMinor = Math.max(
      0,
      liveOrderView?.bundleDiscountMinor ?? orderDiscountMinor - orderPromoMinor,
    );

    let bundleDiscountMinor = 0;
    let discountLabel: string | null = null;
    let promoDiscountMinor = 0;
    let promoLabel: string | null = null;

    if (inv.discountMinor > 0) {
      if (orderPromoMinor > 0 && inv.discountMinor === orderDiscountMinor) {
        promoDiscountMinor = Math.min(inv.discountMinor, orderPromoMinor);
        promoLabel = liveOrderView?.promoLabel ?? "Promotion";
        bundleDiscountMinor = Math.max(0, inv.discountMinor - promoDiscountMinor);
        discountLabel = bundleDiscountMinor > 0 ? "Bundle discount" : null;
      } else if (orderPromoMinor > 0 && orderBundleMinor === 0 && inv.discountMinor <= orderPromoMinor) {
        promoDiscountMinor = inv.discountMinor;
        promoLabel = liveOrderView?.promoLabel ?? "Promotion";
        bundleDiscountMinor = 0;
        discountLabel = null;
      } else {
        bundleDiscountMinor = inv.discountMinor;
        discountLabel = inv.discountMinor === orderDiscountMinor ? (liveOrderView?.discountLabel ?? null) : null;
      }
    }

    const orderAllowsInvoiceWrite =
      lifecycle === "live" &&
      liveOrderView !== null &&
      liveOrderView.lockState !== "legal_hold" &&
      liveOrderView.lockState !== "imported_read_only" &&
      !liveOrderView.readOnlyImported &&
      inv.origin === "portal";
    const onlineConfigured = lifecycle === "live" && onlineConfiguredRaw;

    return {
      ...summary,
      bundleDiscountMinor,
      discountLabel,
      promoDiscountMinor,
      promoLabel,
      issuerName: inv.issuerNameSnapshot ?? issuerNameFallback,
      issuerAddress: inv.issuerAddressSnapshot ?? issuerAddrFallback,
      issuerContact: (inv.issuerContactSnapshot ?? issuerContactFallback).trim() || null,
      buyer,
      memo: inv.memo,
      voidReason: inv.voidReason,
      paymentInstructions,
      onlinePaymentConfigured: onlineConfigured,
      onlinePaymentMessage:
        lifecycle !== "live"
          ? "Order is not active"
          : onlineConfigured
            ? null
            : "Online payment is not configured",
      lines: lines.map((l) => ({
        linePublicId: l.publicId,
        position: l.position,
        description: l.description,
        quantity: l.quantity,
        unitAmountMinor: l.unitAmountMinor,
        lineTotalMinor: l.lineTotalMinor,
      })),
      payments: payments
        .filter((p) => staffView || p.status === "succeeded")
        .map((p) => ({
          paymentPublicId: p.publicId,
          method: p.method,
          status: p.status,
          amountMinor: p.amountMinor,
          currency: p.currency,
          reference: p.reference,
          provider: p.provider,
          notes:
            staffView && p.notesEnc
              ? deps.crypto.decrypt(p.notesEnc, `compliance_invoice_payments.notes:${p.publicId}`)
              : null,
          receivedAt: p.receivedAt,
          origin: p.origin,
        })),
      refunds: refunds.map((r) => ({
        refundPublicId: r.publicId,
        paymentPublicId: paymentById.get(r.paymentId)?.publicId ?? "",
        amountMinor: r.amountMinor,
        currency: r.currency,
        reasonCode: r.reasonCode,
        reference: r.reference,
        provider: r.provider,
        notes:
          staffView && r.notesEnc
            ? deps.crypto.decrypt(r.notesEnc, `compliance_invoice_refunds.notes:${r.publicId}`)
            : null,
        refundedAt: r.refundedAt,
        origin: r.origin,
      })),
      canManage: orderAllowsInvoiceWrite && roleHasCapability(livePrincipal.role, "invoices.manage"),
      canRecordPayment:
        orderAllowsInvoiceWrite &&
        summary.status !== "draft" &&
        summary.status !== "void" &&
        summary.balanceDueMinor > 0 &&
        roleHasCapability(livePrincipal.role, "invoices.manage"),
    };
  }

  /* ------------------------------------------------- staff/admin management */

  async function adminList(
    principal: SessionPrincipal,
    input: {
      status?: InvoiceStatus | undefined;
      orderPublicId?: string | undefined;
      cursor?: string | undefined;
      limit?: number | undefined;
    },
  ): Promise<{ items: InvoiceSummaryView[]; nextCursor: string | null }> {
    await assertStaffInvoiceRead(deps, principal);
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const afterId = decodeIdCursor(input.cursor);
    requireOrdersService();

    const conds = [];
    if (afterId !== null) conds.push(lt(complianceInvoices.id, afterId));
    if (input.status) conds.push(eq(complianceInvoices.status, input.status));
    if (input.orderPublicId) conds.push(eq(complianceInvoices.orderPublicId, input.orderPublicId));

    const rows = await deps.db
      .select()
      .from(complianceInvoices)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(complianceInvoices.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    const sumsMap = await computeLedgerSums(
      deps.db,
      slice.map((r) => r.id),
    );

    const uniqueOrderIds = Array.from(new Set(slice.map((s) => s.orderId)));
    const orderMetaMap = await resolveOrderMetaMap(deps.db, uniqueOrderIds);

    return {
      items: slice.map((inv) => {
        const meta = orderMetaMap.get(inv.orderId);
        return toSummaryView(
          inv,
          meta?.reference || inv.orderReferenceSnapshot || inv.orderPublicId,
          sumsMap.get(inv.id) ?? EMPTY_LEDGER_SUMS,
          meta?.projectName ?? null,
          meta?.lifecycle ?? "live",
        );
      }),
      nextCursor: hasMore && slice.length > 0 ? encodeIdCursor(slice[slice.length - 1]!.id) : null,
    };
  }

  async function adminCreateDraft(
    principal: SessionPrincipal,
    input: {
      orderPublicId: string;
      currency: string;
      lines: readonly { description: string; quantity: number; unitAmountMinor: number }[];
      discountMinor: number;
      taxMinor: number;
      dueAt?: Date | null | undefined;
      memo?: string | null | undefined;
    },
  ): Promise<{ invoicePublicId: string; totalMinor: number; currency: string }> {
    const computed = computeInvoiceTotals({
      lines: input.lines,
      discountMinor: input.discountMinor,
      taxMinor: input.taxMinor,
    });
    const now = deps.clock.now();
    const currency = input.currency.toUpperCase();

    return runComplianceTx(deps, principal, { type: "invoice" }, async (tx) => {
      const liveActor = await assertLiveActorInTx(deps, principal, tx, "invoices.manage");
      const livePrincipal: SessionPrincipal = { ...principal, role: liveActor.role };
      const ordersSvc = requireOrdersService();
      const orderView = await ordersSvc.assertCanWriteOrder(livePrincipal, input.orderPublicId, {
        kind: "invoice",
        tx,
        forUpdate: true,
      });
      if (await isOrderCancelledInTx(orderView.workflowVersionId, orderView.statusKey, tx)) {
        throw conflict("ORDER_CANCELLED", "Cannot create an invoice for a cancelled order.");
      }

      const invoicePublicId = ulid(now.getTime());
      const [ins] = await tx.insert(complianceInvoices).values({
        publicId: invoicePublicId,
        orderId: orderView.id,
        orderPublicId: orderView.publicId,
        status: "draft",
        currency,
        subtotalMinor: computed.subtotalMinor,
        discountMinor: computed.discountMinor,
        taxMinor: computed.taxMinor,
        totalMinor: computed.totalMinor,
        dueAt: input.dueAt ?? null,
        memo: input.memo ?? null,
        origin: "portal",
        version: 1,
        createdByUserId: liveActor.userId,
        createdAt: now,
        updatedAt: now,
      });

      await tx.insert(complianceInvoiceLines).values(
        computed.lines.map((line) => ({
          publicId: ulid(now.getTime()),
          invoiceId: ins.insertId,
          position: line.position,
          description: line.description,
          quantity: line.quantity,
          unitAmountMinor: line.unitAmountMinor,
          lineTotalMinor: line.lineTotalMinor,
        })),
      );

      await deps.audit.record(
        {
          category: "business",
          eventName: "invoice.created",
          action: "create",
          outcome: "completed",
          actor: { userId: liveActor.userId, role: liveActor.role },
          resource: { type: "invoice", publicId: invoicePublicId },
          attributes: {
            order_public_id: orderView.publicId,
            currency,
            subtotal_minor: computed.subtotalMinor,
            discount_minor: computed.discountMinor,
            tax_minor: computed.taxMinor,
            total_minor: computed.totalMinor,
          },
          safeCounts: { line_items: computed.lines.length },
        },
        tx,
      );

      return { invoicePublicId, totalMinor: computed.totalMinor, currency };
    });
  }

  async function adminUpdateDraft(
    principal: SessionPrincipal,
    input: {
      invoicePublicId: string;
      expectedVersion: number;
      currency: string;
      lines: readonly { description: string; quantity: number; unitAmountMinor: number }[];
      discountMinor: number;
      taxMinor: number;
      dueAt?: Date | null | undefined;
      memo?: string | null | undefined;
    },
  ): Promise<{ invoicePublicId: string; version: number; totalMinor: number }> {
    const computed = computeInvoiceTotals({
      lines: input.lines,
      discountMinor: input.discountMinor,
      taxMinor: input.taxMinor,
    });
    const now = deps.clock.now();
    const currency = input.currency.toUpperCase();

    return runComplianceTx(deps, principal, { type: "invoice", publicId: input.invoicePublicId }, async (tx) => {
      const liveActor = await assertLiveActorInTx(deps, principal, tx, "invoices.manage");
      const livePrincipal: SessionPrincipal = { ...principal, role: liveActor.role };

      const [invRef] = await tx
        .select({
          id: complianceInvoices.id,
          orderPublicId: complianceInvoices.orderPublicId,
          origin: complianceInvoices.origin,
        })
        .from(complianceInvoices)
        .where(eq(complianceInvoices.publicId, input.invoicePublicId))
        .limit(1);
      if (!invRef) throw notFound("INVOICE_NOT_FOUND");
      if (invRef.origin !== "portal") {
        throw conflict("IMPORTED_INVOICE_READ_ONLY", "Imported invoices cannot be modified.");
      }

      const ordersSvc = requireOrdersService();
      await ordersSvc.assertCanWriteOrder(livePrincipal, invRef.orderPublicId, {
        kind: "invoice",
        tx,
        forUpdate: true,
      });

      const [inv] = await tx
        .select()
        .from(complianceInvoices)
        .where(eq(complianceInvoices.id, invRef.id))
        .for("update")
        .limit(1);
      if (!inv) throw notFound("INVOICE_NOT_FOUND");

      if (inv.issuedAt !== null || inv.voidedAt !== null || inv.status !== "draft") {
        throw conflict("INVOICE_NOT_DRAFT", "Only draft invoices can be edited. Void and reissue if needed.");
      }
      if (inv.version !== input.expectedVersion) {
        throw conflict("VERSION_MISMATCH", "This invoice was modified by another staff member. Reload and try again.");
      }

      const nextVersion = inv.version + 1;
      await tx
        .update(complianceInvoices)
        .set({
          currency,
          subtotalMinor: computed.subtotalMinor,
          discountMinor: computed.discountMinor,
          taxMinor: computed.taxMinor,
          totalMinor: computed.totalMinor,
          dueAt: input.dueAt ?? null,
          memo: input.memo ?? null,
          version: nextVersion,
          updatedAt: now,
        })
        .where(eq(complianceInvoices.id, inv.id));

      await tx.delete(complianceInvoiceLines).where(eq(complianceInvoiceLines.invoiceId, inv.id));
      await tx.insert(complianceInvoiceLines).values(
        computed.lines.map((line) => ({
          publicId: ulid(now.getTime()),
          invoiceId: inv.id,
          position: line.position,
          description: line.description,
          quantity: line.quantity,
          unitAmountMinor: line.unitAmountMinor,
          lineTotalMinor: line.lineTotalMinor,
        })),
      );

      await deps.audit.record(
        {
          category: "business",
          eventName: "invoice.draft_updated",
          action: "update",
          outcome: "completed",
          actor: { userId: liveActor.userId, role: liveActor.role },
          resource: { type: "invoice", publicId: inv.publicId },
          attributes: {
            order_public_id: inv.orderPublicId,
            currency,
            total_minor: computed.totalMinor,
          },
          safeCounts: { line_items: computed.lines.length },
        },
        tx,
      );

      return { invoicePublicId: inv.publicId, version: nextVersion, totalMinor: computed.totalMinor };
    });
  }

  async function adminIssue(
    principal: SessionPrincipal,
    input: { invoicePublicId: string; dueAt?: Date | null | undefined },
  ): Promise<{ invoicePublicId: string; invoiceNumber: string; status: InvoiceStatus; issuedAt: Date }> {
    const now = deps.clock.now();

    return runComplianceTx(deps, principal, { type: "invoice", publicId: input.invoicePublicId }, async (tx) => {
      const liveActor = await assertLiveActorInTx(deps, principal, tx, "invoices.manage");
      const livePrincipal: SessionPrincipal = { ...principal, role: liveActor.role };

      const [invRef] = await tx
        .select({
          id: complianceInvoices.id,
          orderPublicId: complianceInvoices.orderPublicId,
          origin: complianceInvoices.origin,
        })
        .from(complianceInvoices)
        .where(eq(complianceInvoices.publicId, input.invoicePublicId))
        .limit(1);
      if (!invRef) throw notFound("INVOICE_NOT_FOUND");
      if (invRef.origin !== "portal") {
        throw conflict("IMPORTED_INVOICE_READ_ONLY", "Imported invoices cannot be issued.");
      }

      const ordersSvc = requireOrdersService();
      const orderView = await ordersSvc.assertCanWriteOrder(livePrincipal, invRef.orderPublicId, {
        kind: "invoice",
        tx,
        forUpdate: true,
      });
      if (await isOrderCancelledInTx(orderView.workflowVersionId, orderView.statusKey, tx)) {
        throw conflict("ORDER_CANCELLED", "Cannot issue an invoice for a cancelled order.");
      }

      const [inv] = await tx
        .select()
        .from(complianceInvoices)
        .where(eq(complianceInvoices.id, invRef.id))
        .for("update")
        .limit(1);
      if (!inv) throw notFound("INVOICE_NOT_FOUND");

      if (inv.voidedAt !== null) {
        throw conflict("INVOICE_VOIDED", "Voided invoices cannot be issued.");
      }
      if (inv.issuedAt !== null) {
        throw conflict("INVOICE_ALREADY_ISSUED", "This invoice has already been issued.");
      }

      // Pass tx to all settings reads so we never open a second pool connection inside tx!
      const [prefix, issuerName, issuerAddress, issuerContact, buyerSnapshot] = await Promise.all([
        readSetting(deps.settings, INVOICE_NUMBER_PREFIX, tx),
        readSetting(deps.settings, INVOICE_ISSUER_NAME, tx),
        readSetting(deps.settings, INVOICE_ISSUER_ADDRESS, tx),
        readSetting(deps.settings, INVOICE_ISSUER_CONTACT, tx),
        captureFreshBuyerSnapshotInTx(tx, orderView.ownerUserId, inv.publicId),
      ]);

      const sequenceNumber = await allocateInvoiceSequenceInTx(tx, now);
      const invoiceNumber = formatInvoiceNumber(prefix, now, sequenceNumber);
      const dueAt = input.dueAt !== undefined ? input.dueAt : inv.dueAt;

      const derivedStatus = deriveInvoiceStatus({
        issuedAt: now,
        voidedAt: null,
        totalMinor: inv.totalMinor,
        grossPaidMinor: 0,
        refundedMinor: 0,
      });

      await tx
        .update(complianceInvoices)
        .set({
          sequenceNumber,
          invoiceNumber,
          status: derivedStatus,
          issuedAt: now,
          dueAt,
          issuerNameSnapshot: issuerName,
          issuerAddressSnapshot: issuerAddress,
          issuerContactSnapshot: issuerContact,
          orderReferenceSnapshot: orderView.reference,
          customerRefSnapshot: buyerSnapshot.customerRefSnapshot,
          buyerSnapshotEnc: buyerSnapshot.buyerSnapshotEnc,
          issuedByUserId: liveActor.userId,
          version: inv.version + 1,
          updatedAt: now,
        })
        .where(eq(complianceInvoices.id, inv.id));

      await deps.audit.record(
        {
          category: "business",
          eventName: "invoice.issued",
          action: "transition",
          outcome: "completed",
          actor: { userId: liveActor.userId, role: liveActor.role },
          resource: { type: "invoice", publicId: inv.publicId },
          attributes: {
            order_public_id: orderView.publicId,
            invoice_number: invoiceNumber,
            currency: inv.currency,
            total_minor: inv.totalMinor,
            status: derivedStatus,
          },
        },
        tx,
      );

      const engagementSvc = (deps.services as Partial<typeof deps.services>).engagement;
      if (engagementSvc && typeof engagementSvc.notify === "function") {
        await engagementSvc.notify(
          {
            userId: orderView.ownerUserId,
            kind: "order.invoice_issued",
            title: `Invoice ${invoiceNumber} issued`,
            body: `A new invoice for order ${orderView.reference} is available to review.`,
            link: `/invoices/${inv.publicId}`,
            idempotencyKey: `invoice-issued:${inv.publicId}`,
            skipEmail: true,
          },
          tx,
        );
      }

      const issueOrderMeta = await resolveOrderMetaMap(tx, [orderView.id]);
      const issueProjectName = issueOrderMeta.get(orderView.id)?.projectName ?? null;

      await deps.mailer.enqueue(
        {
          template: "compliance.invoice_issued",
          to: { userId: orderView.ownerUserId },
          orderId: orderView.id,
          vars: {
            invoiceNumber,
            orderReference: orderView.reference,
            ...(issueProjectName ? { projectName: issueProjectName } : {}),
            portalPath: `/invoices/${inv.publicId}`,
          },
          idempotencyKey: `mail:invoice-issued:${inv.publicId}`,
        },
        tx,
      );

      return {
        invoicePublicId: inv.publicId,
        invoiceNumber,
        status: derivedStatus,
        issuedAt: now,
      };
    });
  }

  async function adminVoid(
    principal: SessionPrincipal,
    input: { invoicePublicId: string; reason: string },
  ): Promise<{ invoicePublicId: string; status: "void"; voidedAt: Date }> {
    const reason = input.reason.normalize("NFC").trim();
    if (reason.length < 3 || reason.length > 500) {
      throw validation("VOID_REASON_REQUIRED", "Please provide a reason between 3 and 500 characters to void an invoice.");
    }
    const now = deps.clock.now();

    return runComplianceTx(deps, principal, { type: "invoice", publicId: input.invoicePublicId }, async (tx) => {
      const liveActor = await assertLiveActorInTx(deps, principal, tx, "invoices.manage");
      const livePrincipal: SessionPrincipal = { ...principal, role: liveActor.role };

      const [invRef] = await tx
        .select({
          id: complianceInvoices.id,
          orderPublicId: complianceInvoices.orderPublicId,
          origin: complianceInvoices.origin,
        })
        .from(complianceInvoices)
        .where(eq(complianceInvoices.publicId, input.invoicePublicId))
        .limit(1);
      if (!invRef) throw notFound("INVOICE_NOT_FOUND");
      if (invRef.origin !== "portal") {
        throw conflict("IMPORTED_INVOICE_READ_ONLY", "Imported invoices cannot be voided.");
      }

      const ordersSvc = requireOrdersService();
      await ordersSvc.assertCanWriteOrder(livePrincipal, invRef.orderPublicId, {
        kind: "invoice",
        tx,
        forUpdate: true,
      });

      const [inv] = await tx
        .select()
        .from(complianceInvoices)
        .where(eq(complianceInvoices.id, invRef.id))
        .for("update")
        .limit(1);
      if (!inv) throw notFound("INVOICE_NOT_FOUND");

      if (inv.voidedAt !== null) {
        return { invoicePublicId: inv.publicId, status: "void", voidedAt: inv.voidedAt };
      }

      const sumsMap = await computeLedgerSums(tx, [inv.id], { currentRead: true });
      const sums = sumsMap.get(inv.id) ?? EMPTY_LEDGER_SUMS;
      const netPaidMinor = sums.grossPaidMinor - sums.refundedMinor;
      if (netPaidMinor > 0) {
        throw conflict(
          "INVOICE_HAS_UNREFUNDED_PAYMENTS",
          "Cannot void an invoice that has unrefunded payments. Record a refund first.",
        );
      }
      if (sums.waivedMinor > 0) {
        throw conflict(
          "INVOICE_ALREADY_SETTLED",
          "Cannot void an invoice that has already been settled via checkout waiver.",
        );
      }

      const derivedStatus = deriveInvoiceStatus({
        issuedAt: inv.issuedAt,
        voidedAt: now,
        totalMinor: inv.totalMinor,
        grossPaidMinor: sums.settledGrossMinor,
        refundedMinor: sums.refundedMinor,
      });

      await tx
        .update(complianceInvoices)
        .set({
          status: derivedStatus,
          voidedAt: now,
          voidReason: reason,
          voidedByUserId: liveActor.userId,
          version: inv.version + 1,
          updatedAt: now,
        })
        .where(eq(complianceInvoices.id, inv.id));

      await deps.audit.record(
        {
          category: "business",
          eventName: "invoice.voided",
          action: "transition",
          outcome: "completed",
          actor: { userId: liveActor.userId, role: liveActor.role },
          resource: { type: "invoice", publicId: inv.publicId },
          attributes: {
            order_public_id: inv.orderPublicId,
            invoice_number: inv.invoiceNumber,
            previous_status: inv.status,
          },
        },
        tx,
      );

      return { invoicePublicId: inv.publicId, status: "void", voidedAt: now };
    });
  }

  async function adminRecordManualPayment(
    principal: SessionPrincipal,
    input: {
      invoicePublicId: string;
      method: PaymentMethod;
      amountMinor: number;
      currency: string;
      reference: string;
      notes?: string | undefined;
      receivedAt?: Date | undefined;
      idempotencyKey: string;
    },
  ): Promise<{
    paymentPublicId: string;
    receiptPublicId: string | null;
    invoiceStatus: InvoiceStatus;
    balanceDueMinor: number;
    duplicate: boolean;
  }> {
    const now = deps.clock.now();
    const receivedAt = input.receivedAt ?? now;
    const currency = input.currency.toUpperCase();
    if (input.method === "provider_online") {
      throw validation("INVALID_PAYMENT_METHOD", "Manual payments cannot claim online provider method.");
    }
    if (!input.idempotencyKey || input.idempotencyKey.trim().length < 8) {
      throw validation("INVALID_IDEMPOTENCY_KEY", "An idempotency key of at least 8 characters is required.");
    }

    const PAYMENT_REFUSAL_REASONS = new Set([
      "IMPORTED_INVOICE_READ_ONLY",
      "INVOICE_VOIDED",
      "INVOICE_NOT_ISSUED",
      "CURRENCY_MISMATCH",
      "PAYMENT_EXCEEDS_BALANCE_DUE",
      "ORDER_LOCKED",
    ]);

    return runComplianceTx(
      deps,
      principal,
      { type: "invoice", publicId: input.invoicePublicId },
      async (tx) => {
      const liveActor = await assertLiveActorInTx(deps, principal, tx, "invoices.manage");
      const livePrincipal: SessionPrincipal = { ...principal, role: liveActor.role };

      const [invRef] = await tx
        .select({
          id: complianceInvoices.id,
          orderPublicId: complianceInvoices.orderPublicId,
          origin: complianceInvoices.origin,
        })
        .from(complianceInvoices)
        .where(eq(complianceInvoices.publicId, input.invoicePublicId))
        .limit(1);
      if (!invRef) throw notFound("INVOICE_NOT_FOUND");
      if (invRef.origin !== "portal") {
        throw conflict("IMPORTED_INVOICE_READ_ONLY", "Imported invoices are historical and cannot accept new payments.");
      }

      const ordersSvc = requireOrdersService();
      const orderView = await ordersSvc.assertCanWriteOrder(livePrincipal, invRef.orderPublicId, {
        kind: "invoice",
        tx,
        forUpdate: true,
      });

      const [inv] = await tx
        .select()
        .from(complianceInvoices)
        .where(eq(complianceInvoices.id, invRef.id))
        .for("update")
        .limit(1);
      if (!inv) throw notFound("INVOICE_NOT_FOUND");

      const [existingIdem] = await tx
        .select()
        .from(complianceInvoicePayments)
        .where(
          and(
            eq(complianceInvoicePayments.invoiceId, inv.id),
            eq(complianceInvoicePayments.idempotencyKey, input.idempotencyKey),
          ),
        )
        .for("update")
        .limit(1);

      if (existingIdem) {
        const receiptRes = receiptsSvc
          ? await receiptsSvc.issueReceiptForPaymentInTx(tx, {
              invoiceId: inv.id,
              paymentId: existingIdem.id,
              settlementKind: existingIdem.method === "waiver" ? "waived_small_total" : "manual_payment",
            })
          : null;
        const sumsMap = await computeLedgerSums(tx, [inv.id], { currentRead: true });
        const sums = sumsMap.get(inv.id) ?? EMPTY_LEDGER_SUMS;
        const status = deriveInvoiceStatus({
          issuedAt: inv.issuedAt,
          voidedAt: inv.voidedAt,
          totalMinor: inv.totalMinor,
          grossPaidMinor: sums.settledGrossMinor,
          refundedMinor: sums.refundedMinor,
        });
        const netSettled = Math.max(0, sums.settledGrossMinor - sums.refundedMinor);
        return {
          paymentPublicId: existingIdem.publicId,
          receiptPublicId: receiptRes?.receiptPublicId ?? null,
          invoiceStatus: status,
          balanceDueMinor: Math.max(0, inv.totalMinor - netSettled),
          duplicate: true,
        };
      }

      if (inv.voidedAt !== null) {
        throw conflict("INVOICE_VOIDED", "Cannot record a payment against a voided invoice.");
      }
      if (inv.issuedAt === null) {
        throw conflict("INVOICE_NOT_ISSUED", "Issue the invoice before recording a payment.");
      }
      if (currency !== inv.currency) {
        throw validation("CURRENCY_MISMATCH", `Payment currency (${currency}) must match invoice currency (${inv.currency}).`);
      }

      const sumsMap = await computeLedgerSums(tx, [inv.id], { currentRead: true });
      const sums = sumsMap.get(inv.id) ?? EMPTY_LEDGER_SUMS;
      const currentNetSettled = sums.settledGrossMinor - sums.refundedMinor;
      const remainingBalance = inv.totalMinor - currentNetSettled;
      if (input.amountMinor > remainingBalance) {
        throw validation(
          "PAYMENT_EXCEEDS_BALANCE_DUE",
          "Payment amount cannot exceed the remaining balance due on this invoice.",
          { remainingBalanceMinor: Math.max(0, remainingBalance) },
        );
      }

      const paymentPublicId = ulid(now.getTime());
      const notesEnc = input.notes?.trim()
        ? deps.crypto.encrypt(input.notes.trim(), `compliance_invoice_payments.notes:${paymentPublicId}`)
        : null;

      const [insPmt] = await tx.insert(complianceInvoicePayments).values({
        publicId: paymentPublicId,
        invoiceId: inv.id,
        method: input.method,
        status: "succeeded",
        amountMinor: input.amountMinor,
        waivedMinor: input.method === "waiver" ? input.amountMinor : 0,
        currency,
        reference: input.reference,
        notesEnc,
        receivedAt,
        recordedByUserId: liveActor.userId,
        idempotencyKey: input.idempotencyKey,
        origin: "portal",
        createdAt: now,
      });

      const nextSettledGross = sums.settledGrossMinor + input.amountMinor;
      const nextStatus = deriveInvoiceStatus({
        issuedAt: inv.issuedAt,
        voidedAt: inv.voidedAt,
        totalMinor: inv.totalMinor,
        grossPaidMinor: nextSettledGross,
        refundedMinor: sums.refundedMinor,
      });
      const nextBalance = Math.max(0, inv.totalMinor - (nextSettledGross - sums.refundedMinor));

      if (nextStatus !== inv.status) {
        await tx
          .update(complianceInvoices)
          .set({
            status: nextStatus,
            version: inv.version + 1,
            updatedAt: now,
          })
          .where(eq(complianceInvoices.id, inv.id));
      }

      const receiptRes = receiptsSvc
        ? await receiptsSvc.issueReceiptForPaymentInTx(tx, {
            invoiceId: inv.id,
            paymentId: insPmt.insertId,
            settlementKind: input.method === "waiver" ? "waived_small_total" : "manual_payment",
          })
        : null;

      await deps.audit.record(
        {
          category: "business",
          eventName: "invoice.payment.recorded",
          action: "create",
          outcome: "completed",
          actor: { userId: liveActor.userId, role: liveActor.role },
          resource: { type: "invoice_payment", publicId: paymentPublicId },
          orderPublicId: orderView.publicId,
          attributes: {
            invoice_public_id: inv.publicId,
            order_public_id: orderView.publicId,
            method: input.method,
            amount_minor: input.amountMinor,
            currency,
            derived_invoice_status: nextStatus,
            payment_state: nextStatus === "paid" ? "paid" : "unpaid",
          },
        },
        tx,
      );

      if (nextStatus === "paid" && inv.status !== "paid" && input.method === "waiver") {
        await syncOrderAndCartOnPaidInTx(tx, {
          orderPublicId: orderView.publicId,
          invoicePublicId: inv.publicId,
          paidAt: receivedAt,
          method: "manual",
          amountMinor: 0,
          currency,
        });
      }

      if (nextStatus === "paid" && inv.status !== "paid" && input.method !== "waiver") {
        const engagementSvc = (deps.services as Partial<typeof deps.services>).engagement;
        if (engagementSvc && typeof engagementSvc.notify === "function") {
          await engagementSvc.notify(
            {
              userId: orderView.ownerUserId,
              kind: "order.invoice_paid",
              title: `Payment recorded for ${inv.invoiceNumber ?? "invoice"}`,
              body: `Your invoice for order ${orderView.reference} is now paid in full.`,
              link: `/invoices/${inv.publicId}`,
              idempotencyKey: `invoice-paid:${inv.publicId}:${paymentPublicId}`,
              skipEmail: true,
            },
            tx,
          );
        }
        const paidOrderMeta = await resolveOrderMetaMap(tx, [orderView.id]);
        const paidProjectName = paidOrderMeta.get(orderView.id)?.projectName ?? null;
        await deps.mailer.enqueue(
          {
            template: "compliance.invoice_paid",
            to: { userId: orderView.ownerUserId },
            orderId: orderView.id,
            vars: {
              invoiceNumber: inv.invoiceNumber ?? inv.publicId,
              orderReference: orderView.reference,
              ...(paidProjectName ? { projectName: paidProjectName } : {}),
              portalPath: `/invoices/${inv.publicId}`,
            },
            idempotencyKey: `mail:invoice-paid:${inv.publicId}:${paymentPublicId}`,
          },
          tx,
        );
        await dispatchInvoicePaidInTx(tx, {
          invoiceId: inv.id,
          invoicePublicId: inv.publicId,
          invoiceNumber: inv.invoiceNumber,
          orderId: orderView.id,
          orderPublicId: orderView.publicId,
          orderReference: orderView.reference,
          ownerUserId: orderView.ownerUserId,
          subtotalMinor: inv.subtotalMinor,
          discountMinor: inv.discountMinor,
          taxMinor: inv.taxMinor,
          totalMinor: inv.totalMinor,
          netPaidMinor: sums.grossPaidMinor + input.amountMinor - sums.refundedMinor,
          currency,
          paymentPublicId,
          method: input.method,
          provider: null,
          paidAt: receivedAt,
        });
      }

      return {
        paymentPublicId,
        receiptPublicId: receiptRes?.receiptPublicId ?? null,
        invoiceStatus: nextStatus,
        balanceDueMinor: nextBalance,
        duplicate: false,
      };
      },
      {
        onRefusalAfterRollback: async (err) => {
          if (PAYMENT_REFUSAL_REASONS.has(err.reasonCode)) {
            await deps.audit.record({
              category: "business",
              eventName: "invoice.payment.refused",
              action: "refuse",
              outcome: "refused",
              reasonCode: err.reasonCode,
              actor: { userId: principal.userId, role: principal.role },
              resource: { type: "invoice", publicId: input.invoicePublicId },
              attributes: {
                invoice_public_id: input.invoicePublicId,
                method: input.method,
                amount_minor: input.amountMinor,
                currency,
              },
            });
          }
        },
      },
    );
  }

  function containsRefundPanDigits(value: string): boolean {
    const matches = value.match(/\d[\d -]{11,22}\d/gu);
    if (!matches) return false;
    return matches.some((m) => {
      const digits = m.replace(/\D/gu, "");
      return digits.length >= 13 && digits.length <= 19;
    });
  }

  async function adminRecordRefund(
    principal: SessionPrincipal,
    input: {
      invoicePublicId: string;
      paymentPublicId: string;
      amountMinor: number;
      currency: string;
      reasonCode: string;
      reference: string;
      notes?: string | undefined;
      refundedAt?: Date | undefined;
      confirmationPhrase: string;
      idempotencyKey: string;
    },
  ): Promise<{
    refundPublicId: string;
    invoiceStatus: InvoiceStatus;
    balanceDueMinor: number;
    duplicate: boolean;
  }> {
    const now = deps.clock.now();
    const refundedAt = input.refundedAt ?? now;
    const currency = input.currency.toUpperCase();
    if (!input.idempotencyKey || input.idempotencyKey.trim().length < 8) {
      throw validation("INVALID_IDEMPOTENCY_KEY", "An idempotency key of at least 8 characters is required.");
    }
    if (input.confirmationPhrase.trim() !== "REFUND ORDER") {
      throw validation("INVALID_REFUND_CONFIRMATION", "Type REFUND ORDER to confirm.");
    }
    if (
      containsRefundPanDigits(input.reference) ||
      (input.notes !== undefined && containsRefundPanDigits(input.notes))
    ) {
      throw validation("CARD_DATA_FORBIDDEN", "Card numbers must never be entered in refund references or notes.");
    }

    const REFUND_REFUSAL_REASONS = new Set([
      "IMPORTED_INVOICE_READ_ONLY",
      "PAYMENT_NOT_FOUND",
      "CURRENCY_MISMATCH",
      "REFUND_EXCEEDS_PAYMENT",
      "PROVIDER_PAYMENT_USE_ORDER_REFUNDS",
      "WAIVED_PAYMENT_NOT_REFUNDABLE",
      "ORDER_LOCKED",
    ]);

    return runComplianceTx(
      deps,
      principal,
      { type: "invoice", publicId: input.invoicePublicId },
      async (tx) => {
      const liveActor = await assertLiveActorInTx(deps, principal, tx, "payments.refund");
      const livePrincipal: SessionPrincipal = { ...principal, role: liveActor.role };

      const [invRef] = await tx
        .select({
          id: complianceInvoices.id,
          orderPublicId: complianceInvoices.orderPublicId,
          origin: complianceInvoices.origin,
        })
        .from(complianceInvoices)
        .where(eq(complianceInvoices.publicId, input.invoicePublicId))
        .limit(1);
      if (!invRef) throw notFound("INVOICE_NOT_FOUND");
      if (invRef.origin !== "portal") {
        throw conflict("IMPORTED_INVOICE_READ_ONLY", "Imported invoices cannot accept new refund records.");
      }

      const ordersSvc = requireOrdersService();
      const orderView = await ordersSvc.assertCanWriteOrder(livePrincipal, invRef.orderPublicId, {
        kind: "invoice",
        tx,
        forUpdate: true,
      });

      const [inv] = await tx
        .select()
        .from(complianceInvoices)
        .where(eq(complianceInvoices.id, invRef.id))
        .for("update")
        .limit(1);
      if (!inv) throw notFound("INVOICE_NOT_FOUND");

      const [existingIdem] = await tx
        .select()
        .from(complianceInvoiceRefunds)
        .where(
          and(
            eq(complianceInvoiceRefunds.invoiceId, inv.id),
            eq(complianceInvoiceRefunds.idempotencyKey, input.idempotencyKey),
          ),
        )
        .for("update")
        .limit(1);

      if (existingIdem) {
        const sumsMap = await computeLedgerSums(tx, [inv.id], { currentRead: true });
        const sums = sumsMap.get(inv.id) ?? EMPTY_LEDGER_SUMS;
        const status = deriveInvoiceStatus({
          issuedAt: inv.issuedAt,
          voidedAt: inv.voidedAt,
          totalMinor: inv.totalMinor,
          grossPaidMinor: sums.settledGrossMinor,
          refundedMinor: sums.refundedMinor,
        });
        const netSettled = Math.max(0, sums.settledGrossMinor - sums.refundedMinor);
        return {
          refundPublicId: existingIdem.publicId,
          invoiceStatus: status,
          balanceDueMinor: Math.max(0, inv.totalMinor - netSettled),
          duplicate: true,
        };
      }

      const [pmt] = await tx
        .select()
        .from(complianceInvoicePayments)
        .where(
          and(
            eq(complianceInvoicePayments.publicId, input.paymentPublicId),
            eq(complianceInvoicePayments.invoiceId, inv.id),
          ),
        )
        .for("update")
        .limit(1);
      if (!pmt || pmt.status !== "succeeded") {
        throw notFound("PAYMENT_NOT_FOUND");
      }
      if (pmt.method === "waiver" || (pmt.waivedMinor ?? 0) >= pmt.amountMinor) {
        throw conflict(
          "WAIVED_PAYMENT_NOT_REFUNDABLE",
          "Waived balances have no collected funds to refund.",
        );
      }
      if (pmt.method === "provider_online" || pmt.provider !== null) {
        throw conflict(
          "PROVIDER_PAYMENT_USE_ORDER_REFUNDS",
          "Online provider payments must be refunded from the order Refunds workspace so provider state and reservations stay synchronized.",
        );
      }
      if (currency !== inv.currency) {
        throw validation("CURRENCY_MISMATCH", `Refund currency (${currency}) must match invoice currency (${inv.currency}).`);
      }

      const priorPaymentRefunds = await tx
        .select({ amountMinor: complianceInvoiceRefunds.amountMinor })
        .from(complianceInvoiceRefunds)
        .where(eq(complianceInvoiceRefunds.paymentId, pmt.id))
        .for("update");
      const alreadyRefunded = priorPaymentRefunds.reduce((sum, r) => sum + r.amountMinor, 0);
      const refundableBase = Math.max(0, pmt.amountMinor - (pmt.waivedMinor ?? 0));

      if (alreadyRefunded + input.amountMinor > refundableBase) {
        throw validation(
          "REFUND_EXCEEDS_PAYMENT",
          "Refund amount exceeds the remaining refundable amount on that payment.",
          { maxRefundableMinor: Math.max(0, refundableBase - alreadyRefunded) },
        );
      }

      const refundPublicId = ulid(now.getTime());
      const notesEnc = input.notes?.trim()
        ? deps.crypto.encrypt(input.notes.trim(), `compliance_invoice_refunds.notes:${refundPublicId}`)
        : null;

      const [insRfd] = await tx.insert(complianceInvoiceRefunds).values({
        publicId: refundPublicId,
        invoiceId: inv.id,
        paymentId: pmt.id,
        amountMinor: input.amountMinor,
        currency,
        reasonCode: input.reasonCode,
        reference: input.reference,
        notesEnc,
        refundedAt,
        recordedByUserId: liveActor.userId,
        idempotencyKey: input.idempotencyKey,
        origin: "portal",
        createdAt: now,
      });

      if (receiptsSvc) {
        await receiptsSvc.onPaymentRefundedInTx(tx, {
          paymentId: pmt.id,
          refundId: insRfd.insertId,
        });
      }

      const sumsMap = await computeLedgerSums(tx, [inv.id], { currentRead: true });
      const sums = sumsMap.get(inv.id) ?? EMPTY_LEDGER_SUMS;
      const nextStatus = deriveInvoiceStatus({
        issuedAt: inv.issuedAt,
        voidedAt: inv.voidedAt,
        totalMinor: inv.totalMinor,
        grossPaidMinor: sums.settledGrossMinor,
        refundedMinor: sums.refundedMinor,
      });
      const nextBalance = Math.max(0, inv.totalMinor - Math.max(0, sums.settledGrossMinor - sums.refundedMinor));

      if (nextStatus !== inv.status) {
        await tx
          .update(complianceInvoices)
          .set({
            status: nextStatus,
            version: inv.version + 1,
            updatedAt: now,
          })
          .where(eq(complianceInvoices.id, inv.id));
      }

      const fullyRefunded = sums.grossPaidMinor > 0 && sums.refundedMinor >= sums.grossPaidMinor;
      const refundPaymentState = fullyRefunded ? "refunded" : "partially_refunded";

      await syncOrderPaymentEventInTx(tx, {
        orderPublicId: orderView.publicId,
        kind: refundPaymentState,
        eventRef: refundPublicId,
      });

      await deps.audit.record(
        {
          category: "business",
          eventName: "invoice.refund.recorded",
          action: "create",
          outcome: "completed",
          actor: { userId: liveActor.userId, role: liveActor.role },
          resource: { type: "invoice_refund", publicId: refundPublicId },
          orderPublicId: orderView.publicId,
          attributes: {
            invoice_public_id: inv.publicId,
            payment_public_id: pmt.publicId,
            order_public_id: orderView.publicId,
            reason_code: input.reasonCode,
            amount_minor: input.amountMinor,
            currency,
            derived_invoice_status: nextStatus,
            payment_state: refundPaymentState,
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
          resource: { type: "invoice_refund", publicId: refundPublicId },
          orderPublicId: orderView.publicId,
          attributes: {
            order_public_id: orderView.publicId,
            invoice_public_id: inv.publicId,
            provider: "manual",
            execution_kind: "manual_invoice_refund",
            payment_state: refundPaymentState,
          },
        },
        tx,
      );

      if (fullyRefunded) {
        const orderRef =
          typeof ordersSvc.getOrderRefById === "function"
            ? await ordersSvc.getOrderRefById(inv.orderId, tx)
            : null;
        if (orderRef) {
          await dispatchInvoiceRefundedInTx(tx, {
            invoicePublicId: inv.publicId,
            orderPublicId: orderView.publicId,
            customerUserId: orderRef.ownerUserId,
            currency,
            totalMinor: inv.totalMinor,
            refundedMinor: sums.refundedMinor,
            fullyRefunded: true,
            refundedAt,
          });
        }
      }

      return {
        refundPublicId,
        invoiceStatus: nextStatus,
        balanceDueMinor: nextBalance,
        duplicate: false,
      };
      },
      {
        onRefusalAfterRollback: async (err) => {
          if (REFUND_REFUSAL_REASONS.has(err.reasonCode)) {
            await deps.audit.record({
              category: "business",
              eventName: "invoice.refund.refused",
              action: "refuse",
              outcome: "refused",
              reasonCode: err.reasonCode,
              actor: { userId: principal.userId, role: principal.role },
              resource: { type: "invoice", publicId: input.invoicePublicId },
              attributes: {
                invoice_public_id: input.invoicePublicId,
                payment_public_id: input.paymentPublicId,
                reason_code: input.reasonCode,
                amount_minor: input.amountMinor,
                currency,
              },
            });
          }
        },
      },
    );
  }

  /* ------------------------------------ verified provider webhook hook (DISABLED SCAFFOLD) */

  /**
   * Per integrator security decision, online provider ledger booking is a DISABLED SCAFFOLD in this release
   * (`PROVIDER_LEDGER_BOOKING_ENABLED === false` compile-time constant, cannot be enabled by settings/flags).
   * Signed provider webhook events are durably deduplicated in `compliance_provider_events` and audited,
   * then acknowledged with `applied: false` and ZERO effect on invoices, payments, or refunds.
   */
  async function recordProviderPaymentInTx(
    tx: Tx,
    input: RecordProviderPaymentInput,
  ): Promise<RecordProviderPaymentResult> {
    const provider = input.provider.trim().toLowerCase().slice(0, 32);
    const providerEventId = input.providerEventId.trim().slice(0, 128);
    const kind = input.kind ?? "succeeded";
    const now = deps.clock.now();

    if (!provider || !providerEventId) {
      throw validation("INVALID_PROVIDER_EVENT", "Provider and providerEventId are required.");
    }
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw validation("INVALID_MONEY_AMOUNT", "Provider payment amountMinor must be a positive integer.");
    }

    const [existingEvt] = await tx
      .select()
      .from(complianceProviderEvents)
      .where(
        and(
          eq(complianceProviderEvents.provider, provider),
          eq(complianceProviderEvents.providerEventId, providerEventId),
        ),
      )
      .for("update")
      .limit(1);

    if (existingEvt) {
      return {
        applied: false,
        duplicate: true,
        reasonCode: "DUPLICATE_EVENT",
        invoicePublicId: input.invoicePublicId,
      };
    }

    await tx.insert(complianceProviderEvents).values({
      provider,
      providerEventId,
      invoiceId: null,
      paymentPublicId: null,
      refundPublicId: null,
      processedAt: now,
    });

    await deps.audit.record(
      {
        category: "integration",
        eventName: "invoice.provider_event.scaffold_recorded",
        action: "receive",
        outcome: "refused",
        reasonCode: "PROVIDER_LEDGER_DISABLED_IN_RELEASE",
        actor: { role: "system" },
        attributes: {
          provider,
          provider_event_id: providerEventId,
          kind,
          invoice_public_id: input.invoicePublicId ?? null,
          order_public_id: input.orderPublicId ?? null,
          ledger_booking_enabled: PROVIDER_LEDGER_BOOKING_ENABLED,
        },
      },
      tx,
    );

    return {
      applied: false,
      duplicate: false,
      reasonCode: "PROVIDER_LEDGER_DISABLED_IN_RELEASE",
      invoicePublicId: input.invoicePublicId,
    };
  }

  async function recordProviderPayment(
    input: RecordProviderPaymentInput,
  ): Promise<RecordProviderPaymentResult> {
    if (input.tx) {
      return recordProviderPaymentInTx(input.tx, input);
    }
    return deps.db.transaction((tx) => recordProviderPaymentInTx(tx, input));
  }

  /* --------------------------------------------------- PDF stream builder */

  async function downloadPdf(
    principal: SessionPrincipal,
    invoicePublicId: string,
  ): Promise<{ filename: string; contentType: "application/pdf"; buffer: Buffer }> {
    // 1. Read and pre-render outside the transaction so no extra pool connection is acquired inside tx.
    const detail = await get(principal, invoicePublicId);

    const [issuerContactFallback, issuerTaxId, issuerLogoRaw] = await Promise.all([
      readSetting(deps.settings, INVOICE_ISSUER_CONTACT),
      readSetting(deps.settings, INVOICE_ISSUER_TAX_ID),
      deps.settings
        .get(INVOICE_ISSUER_LOGO.key, parseIssuerLogoSetting, DEFAULT_ISSUER_LOGO_SETTING)
        .catch(() => ({ ...DEFAULT_ISSUER_LOGO_SETTING })),
    ]);
    const issuerLogo = parseIssuerLogoSetting(issuerLogoRaw);
    const resolvedIssuerContact = detail.issuerContact ?? issuerContactFallback;
    const buyer = detail.buyer;

    const invoiceLabel = detail.invoiceNumber ?? `DRAFT-${detail.invoicePublicId.slice(-8)}`;
    const pdfBuffer = renderInvoicePdf({
      invoicePublicId: detail.invoicePublicId,
      invoiceNumber: invoiceLabel,
      status: detail.status,
      orderReference: detail.orderReference,
      projectName: detail.projectName,
      issuerName: detail.issuerName,
      issuerAddress: detail.issuerAddress,
      issuerContact: resolvedIssuerContact,
      issuerTaxId,
      issuerLogo,
      customerName: buyer?.name ?? "Customer",
      customerEmail: buyer?.email ?? "",
      customerRef: buyer?.customerRef ?? null,
      currency: detail.currency,
      issuedAt: detail.issuedAt,
      dueAt: detail.dueAt,
      voidedAt: detail.voidedAt,
      voidReason: detail.voidReason,
      memo: detail.memo,
      paymentInstructions: detail.paymentInstructions,
      lines: detail.lines,
      subtotalMinor: detail.subtotalMinor,
      discountMinor: detail.discountMinor,
      bundleDiscountMinor: detail.bundleDiscountMinor,
      discountLabel: detail.discountLabel,
      promoDiscountMinor: detail.promoDiscountMinor,
      promoLabel: detail.promoLabel,
      taxMinor: detail.taxMinor,
      totalMinor: detail.totalMinor,
      grossPaidMinor: detail.grossPaidMinor,
      waivedMinor: detail.waivedMinor,
      refundedMinor: detail.refundedMinor,
      netPaidMinor: detail.netPaidMinor,
      balanceDueMinor: detail.balanceDueMinor,
      payments: detail.payments
        .filter((p) => p.status === "succeeded")
        .map((p) => ({
          method: p.method,
          reference: p.reference,
          amountMinor: p.amountMinor,
          receivedAt: p.receivedAt,
        })),
      refunds: detail.refunds.map((r) => ({
        reasonCode: r.reasonCode,
        reference: r.reference,
        amountMinor: r.amountMinor,
        refundedAt: r.refundedAt,
      })),
    });

    // 2. Re-validate live actor + live/retained order read access and emit durable audit BEFORE bytes are streamed.
    await runComplianceTx(deps, principal, { type: "invoice", publicId: detail.invoicePublicId }, async (tx) => {
      const [inv] = await tx
        .select()
        .from(complianceInvoices)
        .where(eq(complianceInvoices.publicId, detail.invoicePublicId))
        .limit(1);
      if (!inv) throw notFound("INVOICE_NOT_FOUND");
      const sumsMap = await computeLedgerSums(tx, [inv.id]);
      const sums = sumsMap.get(inv.id) ?? EMPTY_LEDGER_SUMS;
      const access = await resolveInvoiceOrderAccess(principal, inv, sums, { tx });

      await deps.audit.record(
        {
          category: "business",
          eventName: "invoice.downloaded",
          action: "download",
          outcome: "completed",
          actor: { userId: access.liveActor.userId, role: access.liveActor.role },
          resource: { type: "invoice", publicId: detail.invoicePublicId },
          attributes: {
            order_public_id: detail.orderPublicId,
            invoice_number: detail.invoiceNumber,
            status: detail.status,
          },
          safeCounts: { pdf_bytes: pdfBuffer.byteLength },
        },
        tx,
      );
    });

    return {
      filename: `${invoiceLabel}.pdf`,
      contentType: "application/pdf",
      buffer: pdfBuffer,
    };
  }

  async function quoteTaxMinor(
    input: {
      subtotalAfterDiscountMinor: number;
      currency: string;
      billingCountry?: string | null | undefined;
      billingRegion?: string | null | undefined;
    },
    tx?: DbOrTx,
  ): Promise<{ taxRateBps: number; taxMinor: number }> {
    if (!Number.isSafeInteger(input.subtotalAfterDiscountMinor) || input.subtotalAfterDiscountMinor < 0) {
      throw validation("INVALID_MONEY_AMOUNT", "Subtotal after discount must be a non-negative integer.");
    }
    const currency = input.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/u.test(currency)) {
      throw validation("INVALID_CURRENCY", "Currency must be a 3-letter uppercase ISO 4217 code.");
    }
    const taxRateBps = await readSetting(deps.settings, INVOICE_DEFAULT_TAX_RATE_BPS, tx as Tx | undefined);
    const taxMinor = Math.round((input.subtotalAfterDiscountMinor * taxRateBps) / 10_000);
    return { taxRateBps, taxMinor };
  }

  async function issueCheckoutInvoiceInTx(
    input: IssueCheckoutInvoiceInput,
    tx: Tx,
  ): Promise<IssuedCheckoutInvoice> {
    const now = deps.clock.now();
    const currency = input.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/u.test(currency)) {
      throw validation("INVALID_CURRENCY", "Currency must be a 3-letter uppercase ISO 4217 code.");
    }

    const liveActor = await assertLiveActorInTx(deps, input.principal, tx);
    const livePrincipal: SessionPrincipal = { ...input.principal, role: liveActor.role };
    const ordersSvc = requireOrdersService();
    const orderView = await ordersSvc.assertCanReadOrder(livePrincipal, input.orderPublicId, {
      tx,
      forUpdate: true,
    });

    if (orderView.ownerUserId !== liveActor.userId && !isStaffOrAdmin(livePrincipal)) {
      throw new DomainError("FORBIDDEN", "OWNER_ONLY", "Only the order owner may issue a checkout invoice.");
    }
    if (
      orderView.lockState === "legal_hold" ||
      orderView.lockState === "imported_read_only" ||
      orderView.readOnlyImported
    ) {
      throw new DomainError("LOCKED", "ORDER_LOCKED", "This order cannot accept new checkout invoices.", {
        lockState: orderView.lockState,
      });
    }
    if (await isOrderCancelledInTx(orderView.workflowVersionId, orderView.statusKey, tx)) {
      throw conflict("ORDER_CANCELLED", "Cannot issue a checkout invoice for a cancelled order.");
    }

    const preliminary = computeInvoiceTotals({
      lines: input.lines,
      discountMinor: input.discountMinor,
      taxMinor: 0,
    });
    const subtotalAfterDiscountMinor = Math.max(0, preliminary.subtotalMinor - preliminary.discountMinor);
    const resolvedTaxMinor =
      input.taxMinor !== undefined
        ? input.taxMinor
        : (await quoteTaxMinor({ subtotalAfterDiscountMinor, currency }, tx)).taxMinor;

    const computed = computeInvoiceTotals({
      lines: input.lines,
      discountMinor: input.discountMinor,
      taxMinor: resolvedTaxMinor,
    });

    const [prefix, issuerName, issuerAddress, issuerContact] = await Promise.all([
      readSetting(deps.settings, INVOICE_NUMBER_PREFIX, tx),
      readSetting(deps.settings, INVOICE_ISSUER_NAME, tx),
      readSetting(deps.settings, INVOICE_ISSUER_ADDRESS, tx),
      readSetting(deps.settings, INVOICE_ISSUER_CONTACT, tx),
    ]);

    const sequenceNumber = await allocateInvoiceSequenceInTx(tx, now);
    const invoiceNumber = formatInvoiceNumber(prefix, now, sequenceNumber);
    const invoicePublicId = ulid(now.getTime());
    const buyerSnapshot = await captureFreshBuyerSnapshotInTx(
      tx,
      orderView.ownerUserId,
      invoicePublicId,
    );
    const derivedStatus = deriveInvoiceStatus({
      issuedAt: now,
      voidedAt: null,
      totalMinor: computed.totalMinor,
      grossPaidMinor: 0,
      refundedMinor: 0,
    });

    const [ins] = await tx.insert(complianceInvoices).values({
      publicId: invoicePublicId,
      orderId: orderView.id,
      orderPublicId: orderView.publicId,
      sequenceNumber,
      invoiceNumber,
      status: derivedStatus,
      currency,
      subtotalMinor: computed.subtotalMinor,
      discountMinor: computed.discountMinor,
      taxMinor: computed.taxMinor,
      totalMinor: computed.totalMinor,
      issuedAt: now,
      dueAt: input.dueAt ?? null,
      memo: input.memo ?? null,
      issuerNameSnapshot: issuerName,
      issuerAddressSnapshot: issuerAddress,
      issuerContactSnapshot: issuerContact,
      orderReferenceSnapshot: orderView.reference,
      customerRefSnapshot: buyerSnapshot.customerRefSnapshot,
      buyerSnapshotEnc: buyerSnapshot.buyerSnapshotEnc,
      origin: "portal",
      version: 1,
      createdByUserId: liveActor.userId,
      issuedByUserId: liveActor.userId,
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(complianceInvoiceLines).values(
      computed.lines.map((line) => ({
        publicId: ulid(now.getTime()),
        invoiceId: ins.insertId,
        position: line.position,
        description: line.description,
        quantity: line.quantity,
        unitAmountMinor: line.unitAmountMinor,
        lineTotalMinor: line.lineTotalMinor,
      })),
    );

    await deps.audit.record(
      {
        category: "business",
        eventName: "invoice.created",
        action: "create",
        outcome: "completed",
        actor: { userId: liveActor.userId, role: liveActor.role },
        resource: { type: "invoice", publicId: invoicePublicId },
        attributes: {
          order_public_id: orderView.publicId,
          currency,
          subtotal_minor: computed.subtotalMinor,
          discount_minor: computed.discountMinor,
          tax_minor: computed.taxMinor,
          total_minor: computed.totalMinor,
          source: "checkout",
        },
        safeCounts: { line_items: computed.lines.length },
      },
      tx,
    );

    await deps.audit.record(
      {
        category: "business",
        eventName: "invoice.issued",
        action: "transition",
        outcome: "completed",
        actor: { userId: liveActor.userId, role: liveActor.role },
        resource: { type: "invoice", publicId: invoicePublicId },
        attributes: {
          order_public_id: orderView.publicId,
          invoice_number: invoiceNumber,
          currency,
          total_minor: computed.totalMinor,
          status: derivedStatus,
          source: "checkout",
        },
      },
      tx,
    );

    const engagementSvc = (deps.services as Partial<typeof deps.services>).engagement;
    if (engagementSvc && typeof engagementSvc.notify === "function") {
      await engagementSvc.notify(
        {
          userId: orderView.ownerUserId,
          kind: "order.invoice_issued",
          title: `Invoice ${invoiceNumber} issued`,
          body: `A new invoice for order ${orderView.reference} is available to review.`,
          link: `/invoices/${invoicePublicId}`,
          idempotencyKey: `invoice-issued:${invoicePublicId}`,
          skipEmail: true,
        },
        tx,
      );
    }

    const checkoutOrderMeta = await resolveOrderMetaMap(tx, [orderView.id]);
    const checkoutProjectName = checkoutOrderMeta.get(orderView.id)?.projectName ?? null;

    await deps.mailer.enqueue(
      {
        template: "compliance.invoice_issued",
        to: { userId: orderView.ownerUserId },
        orderId: orderView.id,
        vars: {
          invoiceNumber,
          orderReference: orderView.reference,
          ...(checkoutProjectName ? { projectName: checkoutProjectName } : {}),
          portalPath: `/invoices/${invoicePublicId}`,
        },
        idempotencyKey: `mail:invoice-issued:${invoicePublicId}`,
      },
      tx,
    );

    return {
      invoiceId: ins.insertId,
      invoicePublicId,
      invoiceNumber,
      orderId: orderView.id,
      orderPublicId: orderView.publicId,
      currency,
      subtotalMinor: computed.subtotalMinor,
      discountMinor: computed.discountMinor,
      taxMinor: computed.taxMinor,
      totalMinor: computed.totalMinor,
      issuedAt: now,
    };
  }

  async function getInvoiceForCheckout(
    invoicePublicId: string,
    opts?: {
      principal?: SessionPrincipal | undefined;
      tx?: DbOrTx | undefined;
      forUpdate?: boolean | undefined;
      allowTrashedOrder?: boolean | undefined;
    },
  ): Promise<CheckoutInvoiceSnapshot> {
    const dbOrTx = opts?.tx ?? deps.db;
    const [invRef] = await dbOrTx
      .select({
        id: complianceInvoices.id,
        orderId: complianceInvoices.orderId,
        orderPublicId: complianceInvoices.orderPublicId,
        orderReferenceSnapshot: complianceInvoices.orderReferenceSnapshot,
      })
      .from(complianceInvoices)
      .where(eq(complianceInvoices.publicId, invoicePublicId))
      .limit(1);
    if (!invRef) throw notFound("INVOICE_NOT_FOUND");

    const ordersSvc = requireOrdersService();
    let orderReference = invRef.orderReferenceSnapshot ?? invRef.orderPublicId;
    let ownerUserId = 0;

    if (opts?.principal) {
      // Customer/interactive checkout ALWAYS requires a live accessible order; trashed orders are refused.
      const orderView = await ordersSvc.assertCanReadOrder(
        opts.principal,
        invRef.orderPublicId,
        opts.tx
          ? { tx: opts.tx as Tx, ...(opts.forUpdate ? { forUpdate: true } : {}) }
          : undefined,
      );
      orderReference = orderView.reference;
      ownerUserId = orderView.ownerUserId;
    } else if (typeof ordersSvc.getOrderRefById === "function") {
      const ref = await ordersSvc.getOrderRefById(
        invRef.orderId,
        opts?.tx as Tx | undefined,
        opts?.tx && opts?.forUpdate ? { forUpdate: true } : undefined,
      );
      if (ref) {
        orderReference = ref.reference;
        ownerUserId = ref.ownerUserId;
      } else {
        // D2.8: verified webhook / reconciliation path (`!opts?.principal` or `allowTrashedOrder`) may
        // inspect invoices on trashed or tombstoned orders to book late payments safely.
        let resolvedRetained = false;
        if (typeof ordersSvc.retainedOrderRefInTx === "function") {
          const ret = await ordersSvc.retainedOrderRefInTx(
            dbOrTx as Tx,
            invRef.orderId,
            opts?.tx && opts?.forUpdate ? { forUpdate: true } : undefined,
          );
          if (ret) {
            orderReference = ret.reference || orderReference;
            ownerUserId = ret.ownerUserId;
            resolvedRetained = true;
          }
        }
        if (!resolvedRetained) {
          try {
            const ordQuery = dbOrTx
              .select({
                reference: orders.reference,
                ownerUserId: orders.ownerUserId,
              })
              .from(orders)
              .where(eq(orders.id, invRef.orderId))
              .limit(1);
            const [ordRow] =
              opts?.tx && opts?.forUpdate
                ? await dbOrTx
                    .select({
                      reference: orders.reference,
                      ownerUserId: orders.ownerUserId,
                    })
                    .from(orders)
                    .where(eq(orders.id, invRef.orderId))
                    .for("update")
                    .limit(1)
                : await ordQuery;
            if (ordRow) {
              orderReference = ordRow.reference || orderReference;
              ownerUserId = ordRow.ownerUserId;
              resolvedRetained = true;
            }
          } catch {
            // Standalone unit tests may omit `orders` rows.
          }
        }
        if (!resolvedRetained) {
          throw notFound("INVOICE_NOT_FOUND");
        }
      }
    }

    const [inv] =
      opts?.tx && opts?.forUpdate
        ? await (opts.tx as Tx)
            .select()
            .from(complianceInvoices)
            .where(eq(complianceInvoices.id, invRef.id))
            .for("update")
            .limit(1)
        : await dbOrTx
            .select()
            .from(complianceInvoices)
            .where(eq(complianceInvoices.id, invRef.id))
            .limit(1);
    if (!inv) throw notFound("INVOICE_NOT_FOUND");
    if (opts?.principal && !isStaffOrAdmin(opts.principal) && inv.issuedAt === null) {
      throw notFound("INVOICE_NOT_FOUND");
    }

    const currentRead = Boolean(opts?.tx && opts?.forUpdate);
    const sumsMap = await computeLedgerSums(dbOrTx, [inv.id], { currentRead });
    const summary = toSummaryView(
      inv,
      orderReference,
      sumsMap.get(inv.id) ?? EMPTY_LEDGER_SUMS,
    );
    const receiptPublicId =
      receiptsSvc && (summary.status === "paid" || inv.totalMinor === 0)
        ? await receiptsSvc.findLatestReceiptPublicIdForInvoice(dbOrTx, inv.id, { currentRead })
        : null;

    return {
      invoiceId: inv.id,
      invoicePublicId: inv.publicId,
      invoiceNumber: inv.invoiceNumber,
      orderId: inv.orderId,
      orderPublicId: inv.orderPublicId,
      orderReference,
      ownerUserId,
      status: summary.status,
      currency: inv.currency,
      totalMinor: inv.totalMinor,
      balanceDueMinor: summary.balanceDueMinor,
      waivedMinor: summary.waivedMinor,
      receiptPublicId,
      issuedAt: inv.issuedAt,
      voidedAt: inv.voidedAt,
      origin: inv.origin,
    };
  }

  async function bookVerifiedProviderPayment(
    input: BookVerifiedProviderPaymentInput,
    tx: Tx,
  ): Promise<BookVerifiedProviderPaymentResult> {
    const now = deps.clock.now();
    const currency = input.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/u.test(currency)) {
      throw validation("INVALID_CURRENCY", "Currency must be a 3-letter uppercase ISO 4217 code.");
    }
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw validation("INVALID_MONEY_AMOUNT", "Provider payment amountMinor must be a positive integer.");
    }
    const idempotencyKey = input.idempotencyKey.trim();
    if (idempotencyKey.length < 6 || idempotencyKey.length > 128) {
      throw validation("INVALID_IDEMPOTENCY_KEY", "Idempotency key must be between 6 and 128 characters.");
    }
    const providerRef = input.providerPaymentRef.trim().slice(0, 128);
    if (!providerRef) {
      throw validation("INVALID_PROVIDER_PAYMENT_REF", "Provider payment reference is required.");
    }

    const [invRef] = await tx
      .select({
        id: complianceInvoices.id,
        orderId: complianceInvoices.orderId,
        origin: complianceInvoices.origin,
      })
      .from(complianceInvoices)
      .where(eq(complianceInvoices.publicId, input.invoicePublicId))
      .limit(1);
    if (!invRef) throw notFound("INVOICE_NOT_FOUND");
    if (invRef.origin !== "portal") {
      throw conflict("IMPORTED_INVOICE_READ_ONLY", "Imported invoices cannot accept online provider payments.");
    }

    // Canonical lock order: order FOR UPDATE first, then compliance_invoices FOR UPDATE.
    // D2.8: late verified provider webhooks arriving while the order is in trash still book the payment
    // and receipt so money and ledger match, while keeping the order in trash and suppressing notifications/mail.
    const ordersSvc = requireOrdersService();
    let orderRef: {
      id: number;
      publicId: string;
      reference: string;
      ownerUserId: number;
      lockState: string;
      name?: string | null;
    } | null =
      typeof ordersSvc.getOrderRefById === "function"
        ? await ordersSvc.getOrderRefById(invRef.orderId, tx, { forUpdate: true })
        : null;
    let isLiveOrder = orderRef !== null;

    if (!orderRef) {
      if (typeof ordersSvc.retainedOrderRefInTx === "function") {
        const ret = await ordersSvc.retainedOrderRefInTx(tx, invRef.orderId, { forUpdate: true });
        if (ret) {
          let lockState = "none";
          try {
            const [ordLockRow] = await tx
              .select({ lockState: orders.lockState })
              .from(orders)
              .where(eq(orders.id, invRef.orderId))
              .limit(1);
            if (ordLockRow) lockState = ordLockRow.lockState;
          } catch {
            // Standalone tests may omit `orders` rows.
          }
          orderRef = {
            id: ret.id,
            publicId: ret.publicId,
            reference: ret.reference,
            ownerUserId: ret.ownerUserId,
            lockState,
          };
          isLiveOrder = !ret.trashed && !ret.purged;
        }
      }
      if (!orderRef) {
        try {
          const [ordRow] = await tx
            .select({
              id: orders.id,
              publicId: orders.publicId,
              reference: orders.reference,
              ownerUserId: orders.ownerUserId,
              lockState: orders.lockState,
              projectName: orders.projectName,
              trashedAt: orders.trashedAt,
              purgedAt: orders.purgedAt,
            })
            .from(orders)
            .where(eq(orders.id, invRef.orderId))
            .for("update")
            .limit(1);
          if (ordRow) {
            orderRef = {
              id: ordRow.id,
              publicId: ordRow.publicId,
              reference: ordRow.reference,
              ownerUserId: ordRow.ownerUserId,
              lockState: ordRow.lockState,
              name: ordRow.projectName,
            };
            isLiveOrder = ordRow.trashedAt === null && ordRow.purgedAt === null;
          }
        } catch {
          // Standalone tests may omit `orders` rows.
        }
      }
    }

    if (!orderRef) {
      throw notFound("ORDER_NOT_FOUND");
    }

    let isLiveCustomer = true;
    try {
      const [custRow] = await tx
        .select({ trashedAt: users.trashedAt, purgedAt: users.purgedAt })
        .from(users)
        .where(eq(users.id, orderRef.ownerUserId))
        .limit(1);
      if (custRow) {
        isLiveCustomer = isLiveUserRow(custRow);
      }
    } catch {
      // Standalone tests may omit `users` rows.
    }

    const [inv] = await tx
      .select()
      .from(complianceInvoices)
      .where(eq(complianceInvoices.id, invRef.id))
      .for("update")
      .limit(1);
    if (!inv) throw notFound("INVOICE_NOT_FOUND");

    const [existingIdem] = await tx
      .select()
      .from(complianceInvoicePayments)
      .where(
        and(
          eq(complianceInvoicePayments.invoiceId, inv.id),
          eq(complianceInvoicePayments.idempotencyKey, idempotencyKey),
        ),
      )
      .for("update")
      .limit(1);

    if (existingIdem) {
      const receiptRes = receiptsSvc
        ? await receiptsSvc.issueReceiptForPaymentInTx(tx, {
            invoiceId: inv.id,
            paymentId: existingIdem.id,
            settlementKind: "provider_online",
          })
        : null;
      const sumsMap = await computeLedgerSums(tx, [inv.id], { currentRead: true });
      const sums = sumsMap.get(inv.id) ?? EMPTY_LEDGER_SUMS;
      const status = deriveInvoiceStatus({
        issuedAt: inv.issuedAt,
        voidedAt: inv.voidedAt,
        totalMinor: inv.totalMinor,
        grossPaidMinor: sums.settledGrossMinor,
        refundedMinor: sums.refundedMinor,
      });
      const netSettled = Math.max(0, sums.settledGrossMinor - sums.refundedMinor);
      return {
        paymentPublicId: existingIdem.publicId,
        receiptPublicId: receiptRes?.receiptPublicId ?? null,
        invoiceId: inv.id,
        invoicePublicId: inv.publicId,
        invoiceNumber: inv.invoiceNumber,
        invoiceStatus: status,
        balanceDueMinor: Math.max(0, inv.totalMinor - netSettled),
        duplicate: true,
      };
    }

    if (inv.voidedAt !== null) {
      throw conflict("INVOICE_VOIDED", "Cannot book a payment against a voided invoice.");
    }
    if (inv.issuedAt === null) {
      throw conflict("INVOICE_NOT_ISSUED", "Cannot book a payment against an unissued invoice.");
    }
    if (currency !== inv.currency) {
      throw validation(
        "CURRENCY_MISMATCH",
        `Verified payment currency (${currency}) does not match invoice currency (${inv.currency}).`,
      );
    }

    if (orderRef.lockState === "legal_hold" || orderRef.lockState === "imported_read_only") {
      throw new DomainError("LOCKED", "ORDER_LOCKED", "Order is locked against invoice ledger changes.", {
        lockState: orderRef.lockState,
      });
    }

    const sumsMap = await computeLedgerSums(tx, [inv.id], { currentRead: true });
    const sums = sumsMap.get(inv.id) ?? EMPTY_LEDGER_SUMS;
    const currentNetSettled = sums.settledGrossMinor - sums.refundedMinor;
    const remainingBalance = inv.totalMinor - currentNetSettled;
    if (input.amountMinor > remainingBalance) {
      throw conflict(
        "PAYMENT_EXCEEDS_BALANCE_DUE",
        "Verified payment amount exceeds the remaining balance due on this invoice.",
      );
    }

    const paymentPublicId = ulid(now.getTime());
    const cleanBrand = sanitizeCardBrand(input.paymentMethodBrand);
    const cleanLast4 = sanitizeCardLast4(input.paymentMethodLast4);
    const [insPmt] = await tx.insert(complianceInvoicePayments).values({
      publicId: paymentPublicId,
      invoiceId: inv.id,
      method: "provider_online",
      status: "succeeded",
      amountMinor: input.amountMinor,
      waivedMinor: 0,
      currency,
      reference: providerRef,
      provider: input.provider,
      providerEventId: input.attemptPublicId,
      paymentMethodBrand: cleanBrand,
      paymentMethodLast4: cleanLast4,
      notesEnc: null,
      receivedAt: input.paidAt,
      recordedByUserId: null,
      idempotencyKey,
      origin: "portal",
      createdAt: now,
    });

    const nextSettledGross = sums.settledGrossMinor + input.amountMinor;
    const nextCapturedGross = sums.grossPaidMinor + input.amountMinor;
    const nextStatus = deriveInvoiceStatus({
      issuedAt: inv.issuedAt,
      voidedAt: inv.voidedAt,
      totalMinor: inv.totalMinor,
      grossPaidMinor: nextSettledGross,
      refundedMinor: sums.refundedMinor,
    });
    const nextBalance = Math.max(0, inv.totalMinor - (nextSettledGross - sums.refundedMinor));

    if (nextStatus !== inv.status) {
      await tx
        .update(complianceInvoices)
        .set({
          status: nextStatus,
          version: inv.version + 1,
          updatedAt: now,
        })
        .where(eq(complianceInvoices.id, inv.id));
    }

    const receiptRes = receiptsSvc
      ? await receiptsSvc.issueReceiptForPaymentInTx(tx, {
          invoiceId: inv.id,
          paymentId: insPmt.insertId,
          settlementKind: "provider_online",
        })
      : null;

    await deps.audit.record(
      {
        category: "business",
        eventName: "invoice.payment.recorded",
        action: "create",
        outcome: "completed",
        actor: { role: "system" },
        resource: { type: "invoice_payment", publicId: paymentPublicId },
        orderPublicId: inv.orderPublicId,
        attributes: {
          invoice_public_id: inv.publicId,
          order_public_id: inv.orderPublicId,
          method: "provider_online",
          provider: input.provider,
          environment: input.environment,
          attempt_public_id: input.attemptPublicId,
          amount_minor: input.amountMinor,
          currency,
          derived_invoice_status: nextStatus,
          payment_state: nextStatus === "paid" ? "paid" : "unpaid",
        },
      },
      tx,
    );

    if (!isLiveOrder || !isLiveCustomer) {
      await freezeInvoicesForOrderInTx(tx, inv.orderId);
    }

    if (nextStatus === "paid" && inv.status !== "paid" && isLiveOrder && isLiveCustomer) {
      const engagementSvc = (deps.services as Partial<typeof deps.services>).engagement;
      if (engagementSvc && typeof engagementSvc.notify === "function") {
        await engagementSvc.notify(
          {
            userId: orderRef.ownerUserId,
            kind: "order.invoice_paid",
            title: `Payment received for ${inv.invoiceNumber ?? "invoice"}`,
            body: `Your invoice for order ${orderRef.reference} is now paid in full.`,
            link: `/invoices/${inv.publicId}`,
            idempotencyKey: `invoice-paid:${inv.publicId}:${paymentPublicId}`,
            skipEmail: true,
          },
          tx,
        );
      }

      const providerPaidMeta = await resolveOrderMetaMap(tx, [orderRef.id]);
      const providerPaidProjectName =
        providerPaidMeta.get(orderRef.id)?.projectName ??
        (typeof orderRef.name === "string" && orderRef.name.trim() ? orderRef.name.trim() : null);

      await deps.mailer.enqueue(
        {
          template: "compliance.invoice_paid",
          to: { userId: orderRef.ownerUserId },
          orderId: orderRef.id,
          vars: {
            invoiceNumber: inv.invoiceNumber ?? inv.publicId,
            orderReference: orderRef.reference,
            ...(providerPaidProjectName ? { projectName: providerPaidProjectName } : {}),
            portalPath: `/invoices/${inv.publicId}`,
          },
          idempotencyKey: `mail:invoice-paid:${inv.publicId}:${paymentPublicId}`,
        },
        tx,
      );

      await dispatchInvoicePaidInTx(tx, {
        invoiceId: inv.id,
        invoicePublicId: inv.publicId,
        invoiceNumber: inv.invoiceNumber,
        orderId: orderRef.id,
        orderPublicId: orderRef.publicId,
        orderReference: orderRef.reference,
        ownerUserId: orderRef.ownerUserId,
        subtotalMinor: inv.subtotalMinor,
        discountMinor: inv.discountMinor,
        taxMinor: inv.taxMinor,
        totalMinor: inv.totalMinor,
        netPaidMinor: nextCapturedGross - sums.refundedMinor,
        currency,
        paymentPublicId,
        method: "provider_online",
        provider: input.provider,
        paidAt: input.paidAt,
      });
    }

    return {
      paymentPublicId,
      receiptPublicId: receiptRes?.receiptPublicId ?? null,
      invoiceId: inv.id,
      invoicePublicId: inv.publicId,
      invoiceNumber: inv.invoiceNumber,
      invoiceStatus: nextStatus,
      balanceDueMinor: nextBalance,
      duplicate: false,
    };
  }

  /**
   * Increment 06 D5 + D15: Settles a $0.00 checkout invoice (`zero_total`) or waives a sub-minimum
   * checkout balance (`waived_small_total`) under canonical order -> invoice `FOR UPDATE` locking,
   * issuing a `RPR-<year>-<6 digits>` payment receipt inside `tx`.
   *
   * Security boundary:
   *  - `zero_total` is ONLY permitted when the server-locked invoice has `totalMinor === 0`.
   *  - `waived_small_total` is ONLY permitted when `0 < remainingBalance < providerMinimumMinor`.
   *  - Waived payments record `waivedMinor = amountMinor`, `capturedMinor = 0`, and never trigger
   *    referral cash rewards or allow cash refunds.
   */
  async function settleCheckoutInvoiceInTx(
    input: SettleCheckoutInvoiceInput,
    tx: Tx,
  ): Promise<SettleCheckoutInvoiceResult> {
    const [invRef] = await tx
      .select({
        id: complianceInvoices.id,
        orderId: complianceInvoices.orderId,
        origin: complianceInvoices.origin,
      })
      .from(complianceInvoices)
      .where(eq(complianceInvoices.publicId, input.invoicePublicId))
      .limit(1);
    if (!invRef) throw notFound("INVOICE_NOT_FOUND");
    if (invRef.origin !== "portal") {
      throw conflict("IMPORTED_INVOICE_READ_ONLY", "Imported historical invoices cannot be settled.");
    }

    const ordersSvc = requireOrdersService();
    const orderRef =
      typeof ordersSvc.getOrderRefById === "function"
        ? await ordersSvc.getOrderRefById(invRef.orderId, tx, { forUpdate: true })
        : null;
    if (!orderRef) {
      throw notFound("ORDER_NOT_FOUND");
    }
    if (orderRef.lockState === "legal_hold" || orderRef.lockState === "imported_read_only") {
      throw new DomainError("LOCKED", "ORDER_LOCKED", "Order is locked against invoice ledger changes.", {
        lockState: orderRef.lockState,
      });
    }

    const [inv] = await tx
      .select()
      .from(complianceInvoices)
      .where(eq(complianceInvoices.id, invRef.id))
      .for("update")
      .limit(1);
    if (!inv) throw notFound("INVOICE_NOT_FOUND");
    if (inv.voidedAt !== null) {
      throw conflict("INVOICE_VOIDED", "Cannot settle a voided invoice.");
    }
    if (inv.issuedAt === null) {
      throw conflict("INVOICE_NOT_ISSUED", "Cannot settle an unissued invoice.");
    }

    if (input.settlementKind === "zero_total") {
      if (inv.totalMinor !== 0) {
        throw validation(
          "NON_ZERO_INVOICE_CANNOT_ZERO_SETTLE",
          "Only $0.00 invoices can be settled without payment.",
        );
      }
      const receiptRes = receiptsSvc
        ? await receiptsSvc.issueReceiptForZeroInvoiceInTx(tx, { invoiceId: inv.id })
        : null;
      await syncOrderAndCartOnPaidInTx(tx, {
        orderPublicId: orderRef.publicId,
        invoicePublicId: inv.publicId,
        paidAt: inv.issuedAt,
        method: "manual",
        amountMinor: 0,
        currency: inv.currency,
      });
      return {
        settlementKind: "zero_total",
        invoiceId: inv.id,
        invoicePublicId: inv.publicId,
        invoiceNumber: inv.invoiceNumber,
        invoiceStatus: "paid",
        waivedMinor: 0,
        receiptPublicId: receiptRes?.receiptPublicId ?? null,
        duplicate: false,
      };
    }

    // `waived_small_total`
    const idempotencyKey = `waive:${inv.publicId}`;
    const [existingWaive] = await tx
      .select()
      .from(complianceInvoicePayments)
      .where(
        and(
          eq(complianceInvoicePayments.invoiceId, inv.id),
          eq(complianceInvoicePayments.idempotencyKey, idempotencyKey),
        ),
      )
      .for("update")
      .limit(1);

    if (existingWaive) {
      const receiptRes = receiptsSvc
        ? await receiptsSvc.issueReceiptForPaymentInTx(tx, {
            invoiceId: inv.id,
            paymentId: existingWaive.id,
            settlementKind: "waived_small_total",
          })
        : null;
      return {
        settlementKind: "waived_small_total",
        invoiceId: inv.id,
        invoicePublicId: inv.publicId,
        invoiceNumber: inv.invoiceNumber,
        invoiceStatus: "paid",
        waivedMinor: existingWaive.waivedMinor || existingWaive.amountMinor,
        receiptPublicId: receiptRes?.receiptPublicId ?? null,
        duplicate: true,
      };
    }

    const sumsMap = await computeLedgerSums(tx, [inv.id], { currentRead: true });
    const sums = sumsMap.get(inv.id) ?? EMPTY_LEDGER_SUMS;
    const remainingBalance = inv.totalMinor - (sums.settledGrossMinor - sums.refundedMinor);
    if (remainingBalance <= 0) {
      throw conflict("INVOICE_ALREADY_PAID", "This invoice has already been paid.");
    }
    if (
      !Number.isSafeInteger(input.providerMinimumMinor) ||
      input.providerMinimumMinor <= 1 ||
      remainingBalance >= input.providerMinimumMinor
    ) {
      throw conflict(
        "AMOUNT_NOT_BELOW_PROVIDER_MINIMUM",
        "Only balances strictly below the configured card processor minimum may be waived.",
      );
    }

    const now = deps.clock.now();
    const paymentPublicId = ulid(now.getTime());
    const [insPmt] = await tx.insert(complianceInvoicePayments).values({
      publicId: paymentPublicId,
      invoiceId: inv.id,
      method: "waiver",
      status: "succeeded",
      amountMinor: remainingBalance,
      waivedMinor: remainingBalance,
      currency: inv.currency,
      reference: "WAIVED-BELOW-MINIMUM",
      provider: null,
      providerEventId: null,
      paymentMethodBrand: null,
      paymentMethodLast4: null,
      notesEnc: null,
      receivedAt: now,
      recordedByUserId: null,
      idempotencyKey,
      origin: "portal",
      createdAt: now,
    });

    await tx
      .update(complianceInvoices)
      .set({
        status: "paid",
        version: inv.version + 1,
        updatedAt: now,
      })
      .where(eq(complianceInvoices.id, inv.id));

    const receiptRes = receiptsSvc
      ? await receiptsSvc.issueReceiptForPaymentInTx(tx, {
          invoiceId: inv.id,
          paymentId: insPmt.insertId,
          settlementKind: "waived_small_total",
        })
      : null;

    await deps.audit.record(
      {
        category: "business",
        eventName: "invoice.payment.recorded",
        action: "create",
        outcome: "completed",
        actor: { role: "system" },
        resource: { type: "invoice_payment", publicId: paymentPublicId },
        orderPublicId: inv.orderPublicId,
        attributes: {
          invoice_public_id: inv.publicId,
          order_public_id: inv.orderPublicId,
          method: "waiver",
          amount_minor: remainingBalance,
          waived_minor: remainingBalance,
          provider_minimum_minor: input.providerMinimumMinor,
          currency: inv.currency,
          derived_invoice_status: "paid",
          payment_state: "paid",
        },
      },
      tx,
    );

    await syncOrderAndCartOnPaidInTx(tx, {
      orderPublicId: orderRef.publicId,
      invoicePublicId: inv.publicId,
      paidAt: now,
      method: "manual",
      amountMinor: 0,
      currency: inv.currency,
    });

    const engagementSvc = (deps.services as Partial<typeof deps.services>).engagement;
    if (engagementSvc && typeof engagementSvc.notify === "function") {
      await engagementSvc.notify(
        {
          userId: orderRef.ownerUserId,
          kind: "order.invoice_paid",
          title: `Order ${orderRef.reference} confirmed`,
          body: `Your balance below the card minimum on ${inv.invoiceNumber ?? "your invoice"} was waived.`,
          link: `/invoices/${inv.publicId}`,
          idempotencyKey: `invoice-paid:${inv.publicId}:${paymentPublicId}`,
          skipEmail: true,
        },
        tx,
      );
    }

    return {
      settlementKind: "waived_small_total",
      invoiceId: inv.id,
      invoicePublicId: inv.publicId,
      invoiceNumber: inv.invoiceNumber,
      invoiceStatus: "paid",
      waivedMinor: remainingBalance,
      receiptPublicId: receiptRes?.receiptPublicId ?? null,
      duplicate: false,
    };
  }

  async function getOrderPaymentSummaries(
    orderPublicIds: readonly string[],
    dbOrTx?: DbOrTx,
  ): Promise<Map<string, OrderPaymentSummary>> {
    const out = new Map<string, OrderPaymentSummary>();
    const uniqueOrderIds = [...new Set(orderPublicIds.filter((id) => id.length > 0))];
    if (uniqueOrderIds.length === 0) return out;
    const db = dbOrTx ?? deps.db;

    const invoices = await db
      .select()
      .from(complianceInvoices)
      .where(inArray(complianceInvoices.orderPublicId, uniqueOrderIds))
      .orderBy(asc(complianceInvoices.id));
    if (invoices.length === 0) return out;

    const sumsMap = await computeLedgerSums(
      db,
      invoices.map((inv) => inv.id),
    );

    const byOrder = new Map<string, Array<typeof complianceInvoices.$inferSelect>>();
    for (const inv of invoices) {
      const list = byOrder.get(inv.orderPublicId) ?? [];
      list.push(inv);
      byOrder.set(inv.orderPublicId, list);
    }

    for (const [orderPubId, rows] of byOrder) {
      const evidence = rows.map((inv) => {
        const sums = sumsMap.get(inv.id) ?? EMPTY_LEDGER_SUMS;
        return {
          issuedAt: inv.issuedAt,
          voidedAt: inv.voidedAt,
          totalMinor: inv.totalMinor,
          grossPaidMinor: sums.settledGrossMinor,
          refundedMinor: sums.refundedMinor,
        };
      });
      const { headerState } = deriveOrderPaymentSummaryState(evidence);
      const nonVoid = rows.filter((r) => r.voidedAt === null);
      const activeRows = nonVoid.length > 0 ? nonVoid : rows;
      const totalMinor = activeRows.reduce((sum, r) => sum + r.totalMinor, 0);
      const currency = activeRows[0]?.currency ?? "USD";
      out.set(orderPubId, {
        state: headerState,
        totalMinor,
        currency,
      });
    }

    return out;
  }

  async function computeOrderWorkspacePaymentState(
    dbOrTx: DbOrTx,
    orderPublicId: string,
  ): Promise<{ headerState: OrderHeaderPaymentState; workspaceState: InvoicePaymentState | "none" }> {
    const rows = await dbOrTx
      .select()
      .from(complianceInvoices)
      .where(eq(complianceInvoices.orderPublicId, orderPublicId))
      .orderBy(asc(complianceInvoices.id));
    if (rows.length === 0) {
      return { headerState: "unpaid", workspaceState: "none" };
    }
    const sumsMap = await computeLedgerSums(
      dbOrTx,
      rows.map((r) => r.id),
    );
    return deriveOrderPaymentSummaryState(
      rows.map((inv) => {
        const sums = sumsMap.get(inv.id) ?? EMPTY_LEDGER_SUMS;
        return {
          issuedAt: inv.issuedAt,
          voidedAt: inv.voidedAt,
          totalMinor: inv.totalMinor,
          grossPaidMinor: sums.settledGrossMinor,
          refundedMinor: sums.refundedMinor,
        };
      }),
    );
  }

  async function listOrderPaymentsAndRefunds(
    orderPublicId: string,
    dbOrTx?: DbOrTx,
    opts?: { includeNotes?: boolean },
  ): Promise<OrderRefundLedgerSnapshot> {
    const db = dbOrTx ?? deps.db;
    const includeNotes = opts?.includeNotes ?? true;
    const invoices = await db
      .select()
      .from(complianceInvoices)
      .where(eq(complianceInvoices.orderPublicId, orderPublicId))
      .orderBy(asc(complianceInvoices.id));

    if (invoices.length === 0) {
      return {
        orderPublicId,
        orderPaymentState: "none",
        orderHeaderState: "unpaid",
        payments: [],
      };
    }

    const invoiceIds = invoices.map((i) => i.id);
    const invById = new Map(invoices.map((i) => [i.id, i]));
    const [sumsMap, paymentRows, refundRows] = await Promise.all([
      computeLedgerSums(db, invoiceIds),
      db
        .select()
        .from(complianceInvoicePayments)
        .where(
          and(
            inArray(complianceInvoicePayments.invoiceId, invoiceIds),
            eq(complianceInvoicePayments.status, "succeeded"),
          ),
        )
        .orderBy(desc(complianceInvoicePayments.receivedAt), desc(complianceInvoicePayments.id)),
      db
        .select()
        .from(complianceInvoiceRefunds)
        .where(inArray(complianceInvoiceRefunds.invoiceId, invoiceIds))
        .orderBy(desc(complianceInvoiceRefunds.refundedAt), desc(complianceInvoiceRefunds.id)),
    ]);

    const summaryStates = deriveOrderPaymentSummaryState(
      invoices.map((inv) => {
        const sums = sumsMap.get(inv.id) ?? EMPTY_LEDGER_SUMS;
        return {
          issuedAt: inv.issuedAt,
          voidedAt: inv.voidedAt,
          totalMinor: inv.totalMinor,
          grossPaidMinor: sums.settledGrossMinor,
          refundedMinor: sums.refundedMinor,
        };
      }),
    );

    const pmtPubById = new Map(paymentRows.map((p) => [p.id, p.publicId]));
    const refundsByPaymentId = new Map<number, OrderInvoiceRefundLedgerEntry[]>();
    for (const r of refundRows) {
      const paymentPublicId = pmtPubById.get(r.paymentId);
      if (!paymentPublicId) continue;
      const list = refundsByPaymentId.get(r.paymentId) ?? [];
      list.push({
        refundId: r.id,
        refundPublicId: r.publicId,
        paymentId: r.paymentId,
        paymentPublicId,
        amountMinor: r.amountMinor,
        currency: r.currency,
        reasonCode: r.reasonCode,
        reference: r.reference,
        provider: r.provider,
        providerEventId: r.providerEventId,
        notes:
          includeNotes && r.notesEnc
            ? deps.crypto.decrypt(r.notesEnc, `compliance_invoice_refunds.notes:${r.publicId}`)
            : null,
        refundedAt: r.refundedAt,
        origin: r.origin,
      });
      refundsByPaymentId.set(r.paymentId, list);
    }

    const payments: OrderInvoicePaymentLedgerEntry[] = [];
    for (const p of paymentRows) {
      const inv = invById.get(p.invoiceId);
      if (!inv) continue;
      const sums = sumsMap.get(inv.id) ?? EMPTY_LEDGER_SUMS;
      const invoiceStatus = deriveInvoiceStatus({
        issuedAt: inv.issuedAt,
        voidedAt: inv.voidedAt,
        totalMinor: inv.totalMinor,
        grossPaidMinor: sums.settledGrossMinor,
        refundedMinor: sums.refundedMinor,
      });
      const invoicePaymentState = deriveInvoicePaymentState({
        issuedAt: inv.issuedAt,
        voidedAt: inv.voidedAt,
        totalMinor: inv.totalMinor,
        grossPaidMinor: sums.settledGrossMinor,
        refundedMinor: sums.refundedMinor,
      });
      const ledgerRefunds = refundsByPaymentId.get(p.id) ?? [];
      const ledgerRefundedMinor = ledgerRefunds.reduce((sum, item) => sum + item.amountMinor, 0);
      payments.push({
        paymentId: p.id,
        paymentPublicId: p.publicId,
        invoiceId: inv.id,
        invoicePublicId: inv.publicId,
        invoiceNumber: inv.invoiceNumber ?? inv.publicId,
        invoiceStatus,
        invoicePaymentState,
        method: p.method,
        provider: p.provider,
        reference: p.reference,
        providerEventId: p.providerEventId,
        capturedMinor: p.method === "waiver" ? 0 : Math.max(0, p.amountMinor - (p.waivedMinor ?? 0)),
        ledgerRefundedMinor,
        currency: p.currency,
        receivedAt: p.receivedAt,
        origin: p.origin,
        ledgerRefunds,
      });
    }

    return {
      orderPublicId,
      orderPaymentState: summaryStates.workspaceState,
      orderHeaderState: summaryStates.headerState,
      payments,
    };
  }

  async function lockOrderPaymentForRefundInTx(
    tx: Tx,
    input: { orderPublicId: string; paymentPublicId: string },
  ): Promise<LockedOrderPaymentForRefund> {
    const [candidatePmt] = await tx
      .select({
        id: complianceInvoicePayments.id,
        invoiceId: complianceInvoicePayments.invoiceId,
        status: complianceInvoicePayments.status,
      })
      .from(complianceInvoicePayments)
      .where(eq(complianceInvoicePayments.publicId, input.paymentPublicId))
      .limit(1);
    if (!candidatePmt || candidatePmt.status !== "succeeded") {
      throw notFound("PAYMENT_NOT_FOUND");
    }

    const [invRef] = await tx
      .select({
        id: complianceInvoices.id,
        orderId: complianceInvoices.orderId,
        origin: complianceInvoices.origin,
      })
      .from(complianceInvoices)
      .where(
        and(
          eq(complianceInvoices.id, candidatePmt.invoiceId),
          eq(complianceInvoices.orderPublicId, input.orderPublicId),
        ),
      )
      .limit(1);
    if (!invRef) {
      throw notFound("PAYMENT_NOT_FOUND");
    }
    if (invRef.origin !== "portal") {
      throw conflict("IMPORTED_INVOICE_READ_ONLY", "Imported invoices cannot accept new refund records.");
    }

    const ordersSvc = requireOrdersService();
    const orderRef =
      typeof ordersSvc.getOrderRefById === "function"
        ? await ordersSvc.getOrderRefById(invRef.orderId, tx, { forUpdate: true })
        : null;
    if (!orderRef || orderRef.publicId !== input.orderPublicId) {
      throw notFound("ORDER_NOT_FOUND");
    }
    if (orderRef.lockState === "legal_hold" || orderRef.lockState === "imported_read_only") {
      throw new DomainError("LOCKED", "ORDER_LOCKED", "Order is locked against invoice ledger changes.", {
        lockState: orderRef.lockState,
      });
    }

    const [inv] = await tx
      .select()
      .from(complianceInvoices)
      .where(eq(complianceInvoices.id, invRef.id))
      .for("update")
      .limit(1);
    if (!inv) {
      throw notFound("PAYMENT_NOT_FOUND");
    }

    const [pmt] = await tx
      .select()
      .from(complianceInvoicePayments)
      .where(
        and(
          eq(complianceInvoicePayments.id, candidatePmt.id),
          eq(complianceInvoicePayments.invoiceId, inv.id),
          eq(complianceInvoicePayments.status, "succeeded"),
        ),
      )
      .for("update")
      .limit(1);
    if (!pmt) {
      throw notFound("PAYMENT_NOT_FOUND");
    }
    if (pmt.method === "waiver" || (pmt.waivedMinor ?? 0) >= pmt.amountMinor) {
      throw conflict("WAIVED_PAYMENT_NOT_REFUNDABLE", "Waived balances have no collected funds to refund.");
    }

    const sumsMap = await computeLedgerSums(tx, [inv.id], { currentRead: true });
    const ledgerRefundRows = await tx
      .select({
        refundPublicId: complianceInvoiceRefunds.publicId,
        amountMinor: complianceInvoiceRefunds.amountMinor,
        idempotencyKey: complianceInvoiceRefunds.idempotencyKey,
        providerEventId: complianceInvoiceRefunds.providerEventId,
      })
      .from(complianceInvoiceRefunds)
      .where(eq(complianceInvoiceRefunds.paymentId, pmt.id))
      .for("update");
    const sums = sumsMap.get(inv.id) ?? EMPTY_LEDGER_SUMS;

    return {
      orderId: orderRef.id,
      orderPublicId: orderRef.publicId,
      orderReference: orderRef.reference,
      ownerUserId: orderRef.ownerUserId,
      invoiceId: inv.id,
      invoicePublicId: inv.publicId,
      invoiceNumber: inv.invoiceNumber ?? inv.publicId,
      invoiceStatus: deriveInvoiceStatus({
        issuedAt: inv.issuedAt,
        voidedAt: inv.voidedAt,
        totalMinor: inv.totalMinor,
        grossPaidMinor: sums.settledGrossMinor,
        refundedMinor: sums.refundedMinor,
      }),
      invoicePaymentState: deriveInvoicePaymentState({
        issuedAt: inv.issuedAt,
        voidedAt: inv.voidedAt,
        totalMinor: inv.totalMinor,
        grossPaidMinor: sums.settledGrossMinor,
        refundedMinor: sums.refundedMinor,
      }),
      currency: inv.currency,
      totalMinor: inv.totalMinor,
      paymentId: pmt.id,
      paymentPublicId: pmt.publicId,
      method: pmt.method,
      provider: pmt.provider,
      providerReference: pmt.reference,
      providerEventId: pmt.providerEventId,
      capturedMinor: Math.max(0, pmt.amountMinor - (pmt.waivedMinor ?? 0)),
      paidAt: pmt.receivedAt,
      ledgerRefunds: ledgerRefundRows,
    };
  }

  async function bookSettledRefundInTx(
    tx: Tx,
    input: BookSettledRefundInput,
  ): Promise<BookSettledRefundResult> {
    const now = deps.clock.now();
    const currency = input.currency.toUpperCase();

    const [invRef] = await tx
      .select({
        id: complianceInvoices.id,
        orderId: complianceInvoices.orderId,
        origin: complianceInvoices.origin,
      })
      .from(complianceInvoices)
      .where(eq(complianceInvoices.id, input.invoiceId))
      .limit(1);
    if (!invRef) {
      throw notFound("INVOICE_NOT_FOUND");
    }
    if (invRef.origin !== "portal") {
      throw conflict("IMPORTED_INVOICE_READ_ONLY", "Imported invoices cannot accept new refund records.");
    }

    const ordersSvc = requireOrdersService();
    if (typeof ordersSvc.getOrderRefById === "function") {
      await ordersSvc.getOrderRefById(invRef.orderId, tx, { forUpdate: true });
    }

    const [inv] = await tx
      .select()
      .from(complianceInvoices)
      .where(eq(complianceInvoices.id, invRef.id))
      .for("update")
      .limit(1);
    if (!inv) {
      throw notFound("INVOICE_NOT_FOUND");
    }

    const [pmt] = await tx
      .select()
      .from(complianceInvoicePayments)
      .where(
        and(
          eq(complianceInvoicePayments.id, input.paymentId),
          eq(complianceInvoicePayments.invoiceId, inv.id),
          eq(complianceInvoicePayments.status, "succeeded"),
        ),
      )
      .for("update")
      .limit(1);
    if (!pmt) {
      throw notFound("PAYMENT_NOT_FOUND");
    }

    const [existingIdem] = await tx
      .select()
      .from(complianceInvoiceRefunds)
      .where(
        and(
          eq(complianceInvoiceRefunds.invoiceId, inv.id),
          eq(complianceInvoiceRefunds.idempotencyKey, input.idempotencyKey),
        ),
      )
      .for("update")
      .limit(1);

    if (existingIdem) {
      const sumsMap = await computeLedgerSums(tx, [inv.id], { currentRead: true });
      const orderState = await computeOrderWorkspacePaymentState(tx, inv.orderPublicId);
      const sums = sumsMap.get(inv.id) ?? EMPTY_LEDGER_SUMS;
      const invoiceStatus = deriveInvoiceStatus({
        issuedAt: inv.issuedAt,
        voidedAt: inv.voidedAt,
        totalMinor: inv.totalMinor,
        grossPaidMinor: sums.settledGrossMinor,
        refundedMinor: sums.refundedMinor,
      });
      const invoicePaymentState = deriveInvoicePaymentState({
        issuedAt: inv.issuedAt,
        voidedAt: inv.voidedAt,
        totalMinor: inv.totalMinor,
        grossPaidMinor: sums.settledGrossMinor,
        refundedMinor: sums.refundedMinor,
      });
      const netSettled = Math.max(0, sums.settledGrossMinor - sums.refundedMinor);
      return {
        complianceRefundPublicId: existingIdem.publicId,
        invoiceStatus,
        invoicePaymentState,
        orderPaymentState: orderState.workspaceState,
        balanceDueMinor: Math.max(0, inv.totalMinor - netSettled),
        fullyRefundedInvoice: sums.grossPaidMinor > 0 && sums.refundedMinor >= sums.grossPaidMinor,
        duplicate: true,
      };
    }

    if (currency !== inv.currency) {
      throw validation("CURRENCY_MISMATCH", `Refund currency (${currency}) must match invoice currency (${inv.currency}).`);
    }
    if (pmt.method === "waiver" || (pmt.waivedMinor ?? 0) >= pmt.amountMinor) {
      throw conflict("WAIVED_PAYMENT_NOT_REFUNDABLE", "Waived balances have no collected funds to refund.");
    }

    const priorPaymentRefunds = await tx
      .select({ amountMinor: complianceInvoiceRefunds.amountMinor })
      .from(complianceInvoiceRefunds)
      .where(eq(complianceInvoiceRefunds.paymentId, pmt.id))
      .for("update");
    const alreadyRefunded = priorPaymentRefunds.reduce((sum, r) => sum + r.amountMinor, 0);
    const capturedMinor = Math.max(0, pmt.amountMinor - (pmt.waivedMinor ?? 0));
    if (alreadyRefunded + input.amountMinor > capturedMinor) {
      throw conflict(
        "REFUND_EXCEEDS_REFUNDABLE",
        "Refund amount exceeds the remaining refundable amount on that payment.",
      );
    }

    const complianceRefundPublicId = ulid(now.getTime());
    const notesEnc = input.notes?.trim()
      ? deps.crypto.encrypt(input.notes.trim(), `compliance_invoice_refunds.notes:${complianceRefundPublicId}`)
      : null;

    const [insRfd] = await tx.insert(complianceInvoiceRefunds).values({
      publicId: complianceRefundPublicId,
      invoiceId: inv.id,
      paymentId: pmt.id,
      amountMinor: input.amountMinor,
      currency,
      reasonCode: input.reasonCode,
      reference: input.reference,
      notesEnc,
      refundedAt: input.refundedAt,
      recordedByUserId: input.recordedByUserId,
      idempotencyKey: input.idempotencyKey,
      provider: input.provider ?? null,
      providerEventId: input.providerEventId ?? null,
      origin: "portal",
      createdAt: now,
    });

    if (receiptsSvc) {
      await receiptsSvc.onPaymentRefundedInTx(tx, {
        paymentId: pmt.id,
        refundId: insRfd.insertId,
      });
    }

    const sumsMap = await computeLedgerSums(tx, [inv.id], { currentRead: true });
    const sums = sumsMap.get(inv.id) ?? EMPTY_LEDGER_SUMS;
    const nextStatus = deriveInvoiceStatus({
      issuedAt: inv.issuedAt,
      voidedAt: inv.voidedAt,
      totalMinor: inv.totalMinor,
      grossPaidMinor: sums.settledGrossMinor,
      refundedMinor: sums.refundedMinor,
    });
    const nextPaymentState = deriveInvoicePaymentState({
      issuedAt: inv.issuedAt,
      voidedAt: inv.voidedAt,
      totalMinor: inv.totalMinor,
      grossPaidMinor: sums.settledGrossMinor,
      refundedMinor: sums.refundedMinor,
    });
    const nextBalance = Math.max(0, inv.totalMinor - Math.max(0, sums.settledGrossMinor - sums.refundedMinor));

    if (nextStatus !== inv.status) {
      await tx
        .update(complianceInvoices)
        .set({
          status: nextStatus,
          version: inv.version + 1,
          updatedAt: now,
        })
        .where(eq(complianceInvoices.id, inv.id));
    }

    const fullyRefundedInvoice = sums.grossPaidMinor > 0 && sums.refundedMinor >= sums.grossPaidMinor;
    const orderRefundKind = fullyRefundedInvoice ? "refunded" : "partially_refunded";

    await syncOrderPaymentEventInTx(tx, {
      orderPublicId: inv.orderPublicId,
      kind: orderRefundKind,
      eventRef: complianceRefundPublicId,
    });

    await deps.audit.record(
      {
        category: "business",
        eventName: "invoice.refund.recorded",
        action: "create",
        outcome: "completed",
        actor: input.recordedByUserId
          ? { userId: input.recordedByUserId, role: "admin" }
          : { role: "system" },
        resource: { type: "invoice_refund", publicId: complianceRefundPublicId },
        orderPublicId: inv.orderPublicId,
        attributes: {
          invoice_public_id: inv.publicId,
          payment_public_id: pmt.publicId,
          order_public_id: inv.orderPublicId,
          reason_code: input.reasonCode,
          amount_minor: input.amountMinor,
          currency,
          provider: input.provider ?? "manual",
          derived_invoice_status: nextStatus,
          derived_payment_state: nextPaymentState,
          payment_state: orderRefundKind,
        },
      },
      tx,
    );

    if (fullyRefundedInvoice) {
      const ordersSvc = requireOrdersService();
      const orderRef =
        typeof ordersSvc.getOrderRefById === "function"
          ? await ordersSvc.getOrderRefById(inv.orderId, tx)
          : null;
      if (orderRef) {
        await dispatchInvoiceRefundedInTx(tx, {
          invoicePublicId: inv.publicId,
          orderPublicId: inv.orderPublicId,
          customerUserId: orderRef.ownerUserId,
          currency,
          totalMinor: inv.totalMinor,
          refundedMinor: sums.refundedMinor,
          fullyRefunded: true,
          refundedAt: input.refundedAt,
        });
      }
    }

    const orderState = await computeOrderWorkspacePaymentState(tx, inv.orderPublicId);

    return {
      complianceRefundPublicId,
      invoiceStatus: nextStatus,
      invoicePaymentState: nextPaymentState,
      orderPaymentState: orderState.workspaceState,
      balanceDueMinor: nextBalance,
      fullyRefundedInvoice,
      duplicate: false,
    };
  }

  async function healthCounts(): Promise<{ issuedUnpaidInvoices: number }> {
    try {
      const [row] = await deps.db
        .select({ total: count() })
        .from(complianceInvoices)
        .where(
          and(
            eq(complianceInvoices.status, "issued"),
            eq(complianceInvoices.origin, "portal"),
            liveOrderIdPredicate(complianceInvoices.orderId),
          ),
        );
      return {
        issuedUnpaidInvoices: row?.total ?? 0,
      };
    } catch {
      const [row] = await deps.db
        .select({ total: count() })
        .from(complianceInvoices)
        .where(and(eq(complianceInvoices.status, "issued"), eq(complianceInvoices.origin, "portal")));
      return {
        issuedUnpaidInvoices: row?.total ?? 0,
      };
    }
  }

  /**
   * Increment 05 (G-C3-02): Authoritative transactional payment exposure for an order.
   * Acquires locks in canonical order (`order` -> `compliance_invoices` -> `compliance_invoice_payments` -> `payment_attempts`).
   * Used by `orders.cancel` and `promotions.admin.releaseRedemption` to fail-closed when any payment was ever made,
   * any payable invoice remains open, or any provider checkout attempt is pending capture / webhook booking.
   */
  async function orderPaymentExposureInTx(
    tx: Tx,
    orderPublicId: string,
  ): Promise<OrderPaymentExposure> {
    const ordersSvc = requireOrdersService();
    let orderId: number | null = null;
    if (typeof ordersSvc.getOrderRefByPublicId === "function") {
      const orderRef = await ordersSvc.getOrderRefByPublicId(orderPublicId, tx, { forUpdate: true });
      if (!orderRef) {
        throw notFound("ORDER_NOT_FOUND");
      }
      orderId = orderRef.id;
    }

    let invoices;
    try {
      invoices = await tx
        .select()
        .from(complianceInvoices)
        .where(
          orderId !== null
            ? eq(complianceInvoices.orderId, orderId)
            : eq(complianceInvoices.orderPublicId, orderPublicId),
        )
        .orderBy(asc(complianceInvoices.id))
        .for("share", { noWait: true });
    } catch {
      return {
        grossPaidMinor: 1,
        payableInvoiceOpen: true,
        providerCapturePending: true,
        providerAttemptEver: true,
      };
    }

    const paymentsSvc = (deps.services as Partial<typeof deps.services>).payments;

    if (invoices.length === 0) {
      let attemptExp = { providerCapturePending: true, providerAttemptEver: true };
      if (paymentsSvc && typeof paymentsSvc.getAttemptExposureForOrderInTx === "function") {
        try {
          attemptExp = await paymentsSvc.getAttemptExposureForOrderInTx(tx, orderPublicId, []);
        } catch {
          attemptExp = { providerCapturePending: true, providerAttemptEver: true };
        }
      }
      return {
        grossPaidMinor: 0,
        payableInvoiceOpen: false,
        providerCapturePending: attemptExp.providerCapturePending,
        providerAttemptEver: attemptExp.providerAttemptEver,
      };
    }

    const invoiceIds = invoices.map((inv) => inv.id);
    let paymentRows;
    let refundRows;
    try {
      paymentRows = await tx
        .select()
        .from(complianceInvoicePayments)
        .where(inArray(complianceInvoicePayments.invoiceId, invoiceIds))
        .orderBy(asc(complianceInvoicePayments.id))
        .for("share", { noWait: true });
      refundRows = await tx
        .select({
          invoiceId: complianceInvoiceRefunds.invoiceId,
          amountMinor: complianceInvoiceRefunds.amountMinor,
        })
        .from(complianceInvoiceRefunds)
        .where(inArray(complianceInvoiceRefunds.invoiceId, invoiceIds))
        .for("share", { noWait: true });
    } catch {
      return {
        grossPaidMinor: 1,
        payableInvoiceOpen: true,
        providerCapturePending: true,
        providerAttemptEver: true,
      };
    }

    let grossPaidMinor = 0;
    const settledByInvoice = new Map<number, number>();
    for (const pmt of paymentRows) {
      if (pmt.status === "succeeded") {
        const rowWaived =
          pmt.method === "waiver"
            ? Math.max(0, pmt.waivedMinor || pmt.amountMinor)
            : Math.max(0, Math.min(pmt.amountMinor, pmt.waivedMinor ?? 0));
        const rowCaptured = Math.max(0, pmt.amountMinor - rowWaived);
        grossPaidMinor += rowCaptured;
        settledByInvoice.set(pmt.invoiceId, (settledByInvoice.get(pmt.invoiceId) ?? 0) + rowCaptured + rowWaived);
      }
    }

    const refundedByInvoice = new Map<number, number>();
    for (const rfd of refundRows) {
      refundedByInvoice.set(rfd.invoiceId, (refundedByInvoice.get(rfd.invoiceId) ?? 0) + rfd.amountMinor);
    }

    const payableInvoiceOpen = invoices.some((inv) => {
      if (inv.voidedAt !== null || inv.issuedAt === null || inv.totalMinor <= 0) {
        return false;
      }
      const invSettled = settledByInvoice.get(inv.id) ?? 0;
      const invRefunded = refundedByInvoice.get(inv.id) ?? 0;
      const invNetSettled = Math.max(0, invSettled - invRefunded);
      return inv.totalMinor - invNetSettled > 0;
    });

    // Fail closed if the payments evidence port is unavailable, throws, or if ANY payment_attempts
    // row has EVER been created for this order/invoices (regardless of status).
    let attemptExp = { providerCapturePending: true, providerAttemptEver: true };
    if (paymentsSvc && typeof paymentsSvc.getAttemptExposureForOrderInTx === "function") {
      try {
        attemptExp = await paymentsSvc.getAttemptExposureForOrderInTx(tx, orderPublicId, invoiceIds);
      } catch {
        attemptExp = { providerCapturePending: true, providerAttemptEver: true };
      }
    }

    return {
      grossPaidMinor,
      payableInvoiceOpen,
      providerCapturePending: attemptExp.providerCapturePending,
      providerAttemptEver: attemptExp.providerAttemptEver,
    };
  }

  async function readCompanyProfile(tx?: Tx) {
    const [issuerName, issuerAddress, issuerContact, issuerTaxId, rawLogo, paymentInstructions, defaultTaxRateBps] =
      await Promise.all([
        readSetting(deps.settings, INVOICE_ISSUER_NAME, tx),
        readSetting(deps.settings, INVOICE_ISSUER_ADDRESS, tx),
        readSetting(deps.settings, INVOICE_ISSUER_CONTACT, tx),
        readSetting(deps.settings, INVOICE_ISSUER_TAX_ID, tx),
        deps.settings.get(INVOICE_ISSUER_LOGO.key, parseIssuerLogoSetting, DEFAULT_ISSUER_LOGO_SETTING, tx),
        readSetting(deps.settings, INVOICE_PAYMENT_INSTRUCTIONS, tx),
        readSetting(deps.settings, INVOICE_DEFAULT_TAX_RATE_BPS, tx),
      ]);
    return {
      issuerName: issuerName.trim() || "Ready Packets Consulting LLC",
      issuerAddress: issuerAddress.trim(),
      issuerContact: issuerContact.trim(),
      issuerTaxId: issuerTaxId.trim(),
      issuerLogo: parseIssuerLogoSetting(rawLogo),
      paymentInstructions: paymentInstructions.trim(),
      defaultTaxRateBps,
    };
  }

  async function adminGetCompanyProfile(principal: SessionPrincipal): Promise<{
    issuerName: string;
    issuerAddress: string;
    issuerContact: string;
    issuerTaxId: string;
    issuerLogo: IssuerLogoSetting;
    paymentInstructions: string;
    defaultTaxRateBps: number;
  }> {
    await assertLiveActorInTx(deps, principal, deps.db as unknown as Tx, "invoices.manage");
    return readCompanyProfile();
  }

  async function adminUpdateCompanyProfile(
    principal: SessionPrincipal,
    input: {
      issuerName: string;
      issuerAddress: string;
      issuerContact: string;
      issuerTaxId: string;
      issuerLogo: IssuerLogoSetting;
      paymentInstructions?: string | undefined;
    },
  ) {
    return runComplianceTx(deps, principal, { type: "compliance_setting", publicId: "compliance.invoices.company_profile" }, async (tx) => {
      const liveActor = await assertLiveActorInTx(deps, principal, tx, "invoices.manage");
      const cleanedLogo = parseIssuerLogoSetting(input.issuerLogo);
      await writeSetting(deps.settings, INVOICE_ISSUER_NAME, input.issuerName.trim(), tx);
      await writeSetting(deps.settings, INVOICE_ISSUER_ADDRESS, input.issuerAddress.trim(), tx);
      await writeSetting(deps.settings, INVOICE_ISSUER_CONTACT, input.issuerContact.trim(), tx);
      await writeSetting(deps.settings, INVOICE_ISSUER_TAX_ID, input.issuerTaxId.trim(), tx);
      await writeSetting(deps.settings, INVOICE_ISSUER_LOGO, cleanedLogo, tx);
      if (input.paymentInstructions !== undefined) {
        await writeSetting(deps.settings, INVOICE_PAYMENT_INSTRUCTIONS, input.paymentInstructions.trim(), tx);
      }

      await deps.audit.record(
        {
          category: "admin",
          eventName: "compliance.company_profile.updated",
          action: "update",
          outcome: "completed",
          actor: { userId: liveActor.userId, role: liveActor.role },
          resource: { type: "compliance_setting", publicId: "compliance.invoices.company_profile" },
          attributes: {
            issuer_name: input.issuerName.trim(),
            has_address: input.issuerAddress.trim().length > 0,
            has_contact: input.issuerContact.trim().length > 0,
            has_tax_id: input.issuerTaxId.trim().length > 0,
            logo_mode: cleanedLogo.mode,
            logo_brand_path: cleanedLogo.brandPath,
          },
        },
        tx,
      );

      return readCompanyProfile(tx);
    });
  }

  return {
    listForOrder,
    listMine,
    get,
    downloadPdf,
    recordProviderPayment,
    quoteTaxMinor,
    issueCheckoutInvoiceInTx,
    getInvoiceForCheckout,
    bookVerifiedProviderPayment,
    settleCheckoutInvoiceInTx,
    onInvoicePaid,
    getOrderPaymentSummaries,
    listOrderPaymentsAndRefunds,
    lockOrderPaymentForRefundInTx,
    bookSettledRefundInTx,
    orderPaymentExposureInTx,
    freezeInvoicesForOrderInTx,
    admin: {
      list: adminList,
      createDraft: adminCreateDraft,
      updateDraft: adminUpdateDraft,
      issue: adminIssue,
      void: adminVoid,
      recordManualPayment: adminRecordManualPayment,
      recordRefund: adminRecordRefund,
      getCompanyProfile: adminGetCompanyProfile,
      updateCompanyProfile: adminUpdateCompanyProfile,
    },
    healthCounts,
  };
}

export type InvoicesService = ReturnType<typeof createInvoicesService>;
