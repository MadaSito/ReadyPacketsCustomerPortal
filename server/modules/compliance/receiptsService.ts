/**
 * Increment 06 D15 — Payment Receipts & Refund Notes runtime service.
 *
 * Invariants (ADR 0054):
 *  - Exactly one immutable receipt (`RPR-<year>-<6 digits>`) per confirmed payment or zero/waived checkout
 *    settlement, deduplicated on `settlement_key` (`payment:<paymentId>` or `zero_invoice:<invoiceId>`).
 *  - `snapshot_enc` and `pdf_enc` are encrypted at rest via `FieldCrypto` (AES-256-GCM) with row-bound AAD
 *    and NEVER altered after issuance.
 *  - Refunds advance `refunded_minor` / `refund_state` (`partially_refunded` | `refunded`) on the receipt row
 *    and append an immutable refund note (`RPRN-<year>-<6 digits>`) to `compliance_receipt_refund_notes`.
 *  - Customer email delivery runs inside the issuing transaction via `enqueuePaymentReceipt` (`payment_receipt`).
 *  - Staff "Send again" is capability-gated, rate-limited per receipt (60s cooldown + max 10 resends), and audited.
 */
import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import { roleHasCapability } from "../../../shared/capabilities.js";
import type { ModuleDeps } from "../../container.js";
import { DomainError, notFound, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { DbOrTx, SessionPrincipal, Tx } from "../../core/types.js";
import { users } from "../identity/schema.js";
import { emailAad, nameAad } from "../identity/users.js";
import { enqueuePaymentReceipt } from "../jobs/receiptMail.js";
import { orders } from "../orders/schema.js";
import {
  DEFAULT_PAYMENTS_RECEIPTS,
  parsePaymentsReceiptsSetting,
  PAYMENTS_RECEIPTS_SETTING,
  sanitizeCardBrand,
  sanitizeCardLast4,
} from "../payments/settings.js";
import { readSetting } from "../platform/index.js";
import { assertLiveActorInTx, denyComplianceAuthz, runComplianceTx } from "./actorAuth.js";
import { decodeIdCursor, encodeIdCursor } from "./domain.js";
import {
  formatPaymentMethodSummaryPlain,
  renderPaymentReceiptPdf,
  renderRefundNotePdf,
  type ReceiptSnapshot,
  type RefundNoteSnapshot,
} from "./invoicePdf.js";
import {
  complianceInvoiceLines,
  complianceInvoicePayments,
  complianceInvoiceRefunds,
  complianceInvoices,
  compliancePaymentReceipts,
  complianceReceiptRefundNotes,
  complianceSequences,
  type PaymentMethod,
  type ReceiptNoteRefundState,
  type ReceiptRefundState,
  type ReceiptSettlementKind,
} from "./schema.js";
import {
  DEFAULT_ISSUER_LOGO_SETTING,
  INVOICE_ISSUER_ADDRESS,
  INVOICE_ISSUER_CONTACT,
  INVOICE_ISSUER_LOGO,
  INVOICE_ISSUER_NAME,
  INVOICE_ISSUER_TAX_ID,
  parseIssuerLogoSetting,
} from "./settings.js";

export const RECEIPT_RESEND_COOLDOWN_MS = 60_000;
export const RECEIPT_RESEND_HOURLY_WINDOW_MS = 3_600_000;
export const RECEIPT_MAX_RESENDS_PER_HOUR = 3;
export const RECEIPT_MAX_RESEND_COUNT = 10;

export interface RefundNoteSummaryView {
  notePublicId: string;
  noteNumber: string;
  receiptPublicId: string;
  refundPublicId: string;
  orderPublicId: string;
  currency: string;
  refundAmountMinor: number;
  cumulativeRefundedMinor: number;
  resultingRefundState: ReceiptNoteRefundState;
  reasonCode: string;
  reference: string;
  issuedAt: Date;
}

export interface ReceiptSummaryView {
  receiptPublicId: string;
  receiptNumber: string;
  settlementKind: ReceiptSettlementKind;
  invoicePublicId: string;
  paymentPublicId: string | null;
  orderPublicId: string;
  orderReference: string;
  customerRef: string | null;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  bundleDiscountMinor: number;
  promoDiscountMinor: number;
  promoLabel: string | null;
  taxMinor: number;
  amountWaivedMinor: number;
  amountPaidMinor: number;
  refundedMinor: number;
  refundState: ReceiptRefundState;
  paymentMethod: PaymentMethod;
  paymentMethodBrand: string | null;
  paymentMethodLast4: string | null;
  paymentMethodSummary: string;
  provider: string | null;
  issuedAt: Date;
  origin: "portal" | "import";
  refundNotes: RefundNoteSummaryView[];
}

export interface AdminReceiptSummaryView extends ReceiptSummaryView {
  providerReference: string | null;
  emailedAt: Date | null;
  lastResentAt: Date | null;
  resendCount: number;
}

export interface ReceiptDetailView extends ReceiptSummaryView {
  snapshot: ReceiptSnapshot;
  emailedAt: Date | null;
  lastResentAt: Date | null;
  resendCount: number;
  canResend: boolean;
}

const receiptSnapshotAad = (publicId: string) => `compliance_payment_receipts.snapshot:${publicId}`;
const receiptPdfAad = (publicId: string) => `compliance_payment_receipts.pdf:${publicId}`;
const refundNoteSnapshotAad = (publicId: string) => `compliance_receipt_refund_notes.snapshot:${publicId}`;
const refundNotePdfAad = (publicId: string) => `compliance_receipt_refund_notes.pdf:${publicId}`;

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function formatReceiptNumber(now: Date, seq: number): string {
  const year = now.getUTCFullYear();
  return `RPR-${year}-${String(seq).padStart(6, "0")}`;
}

export function formatRefundNoteNumber(now: Date, seq: number): string {
  const year = now.getUTCFullYear();
  return `RPRN-${year}-${String(seq).padStart(6, "0")}`;
}

function isStaffOrAdmin(principal: SessionPrincipal): boolean {
  return principal.role === "staff" || principal.role === "admin";
}

function hasStaffReceiptReadCap(role: SessionPrincipal["role"]): boolean {
  return roleHasCapability(role, "invoices.read_all");
}

function hasExplicitOrderBillingGrant(orderView: unknown): boolean {
  if (!orderView || typeof orderView !== "object") return false;
  const candidate = orderView as {
    hasBillingGrant?: unknown;
    billingAccess?: unknown;
    accessRole?: unknown;
  };
  return (
    candidate.hasBillingGrant === true ||
    candidate.billingAccess === true ||
    candidate.accessRole === "billing"
  );
}

function buildReceiptResendSlotKeys(receiptId: number): string[] {
  const keys: string[] = [];
  for (let slot = 0; slot < RECEIPT_MAX_RESENDS_PER_HOUR; slot++) {
    keys.push(`rcpt_r${slot}:${receiptId}`);
  }
  return keys;
}

export function createReceiptsService(deps: ModuleDeps) {
  function requireOrdersService() {
    const svc = (deps.services as Partial<typeof deps.services>).orders;
    if (!svc) {
      throw new DomainError("UNAVAILABLE", "ORDERS_SERVICE_UNAVAILABLE", "Orders service is not initialized.");
    }
    return svc;
  }

  async function allocateYearlySequenceInTx(tx: Tx, prefixKey: string, now: Date): Promise<number> {
    const seqKey = `${prefixKey}:${now.getUTCFullYear()}`;
    const [existing] = await tx
      .select()
      .from(complianceSequences)
      .where(eq(complianceSequences.seqKey, seqKey))
      .for("update")
      .limit(1);

    if (!existing) {
      await tx
        .insert(complianceSequences)
        .values({
          seqKey,
          nextVal: 2,
          updatedAt: now,
        })
        .onDuplicateKeyUpdate({ set: { updatedAt: now } });
      const [locked] = await tx
        .select()
        .from(complianceSequences)
        .where(eq(complianceSequences.seqKey, seqKey))
        .for("update")
        .limit(1);
      if (!locked) return 1;
      if (locked.nextVal === 2) return 1;
      const allocated = locked.nextVal;
      await tx
        .update(complianceSequences)
        .set({ nextVal: allocated + 1, updatedAt: now })
        .where(eq(complianceSequences.seqKey, seqKey));
      return allocated;
    }

    const allocated = existing.nextVal;
    await tx
      .update(complianceSequences)
      .set({ nextVal: allocated + 1, updatedAt: now })
      .where(eq(complianceSequences.seqKey, seqKey));
    return allocated;
  }

  async function readReceiptsConfigInTx(tx?: DbOrTx) {
    try {
      const raw = await deps.settings.get(
        PAYMENTS_RECEIPTS_SETTING.key,
        parsePaymentsReceiptsSetting,
        DEFAULT_PAYMENTS_RECEIPTS,
        tx ? (tx as Tx) : undefined,
      );
      return parsePaymentsReceiptsSetting(raw);
    } catch {
      return { ...DEFAULT_PAYMENTS_RECEIPTS };
    }
  }

  async function readCompanyProfileInTx(tx: Tx) {
    const [legalName, address, contact, taxId, logoRaw] = await Promise.all([
      readSetting(deps.settings, INVOICE_ISSUER_NAME, tx),
      readSetting(deps.settings, INVOICE_ISSUER_ADDRESS, tx),
      readSetting(deps.settings, INVOICE_ISSUER_CONTACT, tx),
      readSetting(deps.settings, INVOICE_ISSUER_TAX_ID, tx),
      deps.settings
        .get(INVOICE_ISSUER_LOGO.key, parseIssuerLogoSetting, DEFAULT_ISSUER_LOGO_SETTING, tx)
        .catch(() => ({ ...DEFAULT_ISSUER_LOGO_SETTING })),
    ]);
    const logo = parseIssuerLogoSetting(logoRaw);
    return {
      legalName,
      address,
      contact,
      taxId,
      logoMode: logo.mode,
      logoBrandPath: logo.mode === "brand" ? logo.brandPath : null,
    };
  }

  async function readCustomerSnapshotInTx(
    tx: Tx,
    userId: number,
  ): Promise<{ name: string; email: string; customerRef: string | null }> {
    const identitySvc = (deps.services as Partial<typeof deps.services>).identity;
    if (identitySvc && typeof identitySvc.getUser === "function") {
      const view = await identitySvc.getUser(userId, { tx });
      if (view) {
        return {
          name: view.name || "Customer",
          email: view.email || "",
          customerRef: view.customerRef ?? null,
        };
      }
    }
    const [row] = await tx
      .select({
        publicId: users.publicId,
        nameEnc: users.nameEnc,
        emailEnc: users.emailEnc,
        customerRef: users.customerRef,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row) {
      return { name: "Customer", email: "", customerRef: null };
    }
    let name = "Customer";
    let email = "";
    try {
      name = deps.crypto.decrypt(row.nameEnc, nameAad(row.publicId)) || "Customer";
    } catch {
      // keep fallback
    }
    try {
      email = deps.crypto.decrypt(row.emailEnc, emailAad(row.publicId)) || "";
    } catch {
      // keep fallback
    }
    return { name, email, customerRef: row.customerRef ?? null };
  }

  async function readOrderDiscountContextInTx(
    tx: Tx,
    orderId: number,
    fallbackOrderPublicId: string,
    invoiceDiscountMinor: number,
  ): Promise<{
    ownerUserId: number;
    orderReference: string;
    bundleDiscountMinor: number;
    discountLabel: string | null;
    promoDiscountMinor: number;
    promoLabel: string | null;
  }> {
    let ownerUserId = 0;
    let orderReference = fallbackOrderPublicId;
    let orderDiscountMinor = 0;
    let orderPromoMinor = 0;
    let orderDiscountLabel: string | null = null;
    let orderPromoLabel: string | null = null;

    const ordersSvc = (deps.services as Partial<typeof deps.services>).orders;
    if (ordersSvc && typeof ordersSvc.getOrderRefById === "function") {
      const ref = await ordersSvc.getOrderRefById(orderId, tx);
      if (ref) {
        ownerUserId = ref.ownerUserId;
        orderReference = ref.reference;
      }
    }

    try {
      const [ord] = await tx
        .select({
          ownerUserId: orders.ownerUserId,
          reference: orders.reference,
          discountMinor: orders.discountMinor,
          discountLabel: orders.discountLabel,
          promoDiscountMinor: orders.promoDiscountMinor,
          promoLabel: orders.promoLabel,
        })
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1);
      if (ord) {
        if (!ownerUserId) ownerUserId = ord.ownerUserId;
        orderReference = ord.reference || orderReference;
        orderDiscountMinor = Math.max(0, ord.discountMinor ?? 0);
        orderPromoMinor = Math.max(0, ord.promoDiscountMinor ?? 0);
        orderDiscountLabel = ord.discountLabel ?? null;
        orderPromoLabel = ord.promoLabel ?? null;
      }
    } catch {
      // Standalone compliance unit tests may mock orders service without populating `orders` rows.
    }

    let bundleDiscountMinor = 0;
    let discountLabel: string | null = null;
    let promoDiscountMinor = 0;
    let promoLabel: string | null = null;

    if (invoiceDiscountMinor > 0) {
      const orderBundleMinor = Math.max(0, orderDiscountMinor - orderPromoMinor);
      if (orderPromoMinor > 0 && invoiceDiscountMinor === orderDiscountMinor) {
        promoDiscountMinor = Math.min(invoiceDiscountMinor, orderPromoMinor);
        promoLabel = orderPromoLabel ?? "Promotion";
        bundleDiscountMinor = Math.max(0, invoiceDiscountMinor - promoDiscountMinor);
        discountLabel = bundleDiscountMinor > 0 ? "Bundle discount" : null;
      } else if (orderPromoMinor > 0 && orderBundleMinor === 0 && invoiceDiscountMinor <= orderPromoMinor) {
        promoDiscountMinor = invoiceDiscountMinor;
        promoLabel = orderPromoLabel ?? "Promotion";
      } else {
        bundleDiscountMinor = invoiceDiscountMinor;
        discountLabel = invoiceDiscountMinor === orderDiscountMinor ? orderDiscountLabel : null;
      }
    }

    return {
      ownerUserId,
      orderReference,
      bundleDiscountMinor,
      discountLabel,
      promoDiscountMinor,
      promoLabel,
    };
  }

  /**
   * Issues an immutable payment receipt (`RPR-<year>-<6 digits>`) for a confirmed payment row inside `tx`.
   * Idempotent on `settlement_key = "payment:<paymentId>"`.
   */
  async function issueReceiptForPaymentInTx(
    tx: Tx,
    input: {
      invoiceId: number;
      paymentId: number;
      settlementKind: "provider_online" | "manual_payment" | "waived_small_total";
    },
  ): Promise<{ receiptPublicId: string; receiptNumber: string } | null> {
    const settlementKey = `payment:${input.paymentId}`;
    const [existing] = await tx
      .select({
        publicId: compliancePaymentReceipts.publicId,
        receiptNumber: compliancePaymentReceipts.receiptNumber,
      })
      .from(compliancePaymentReceipts)
      .where(eq(compliancePaymentReceipts.settlementKey, settlementKey))
      .limit(1);
    if (existing) {
      return { receiptPublicId: existing.publicId, receiptNumber: existing.receiptNumber };
    }

    const receiptSettings = await readReceiptsConfigInTx(tx);
    if (!receiptSettings.enabled) {
      return null;
    }

    const [inv] = await tx
      .select()
      .from(complianceInvoices)
      .where(eq(complianceInvoices.id, input.invoiceId))
      .limit(1);
    if (!inv || inv.origin !== "portal") return null;

    const [pmt] = await tx
      .select()
      .from(complianceInvoicePayments)
      .where(and(eq(complianceInvoicePayments.id, input.paymentId), eq(complianceInvoicePayments.invoiceId, inv.id)))
      .limit(1);
    if (!pmt || pmt.status !== "succeeded") return null;

    const orderCtx = await readOrderDiscountContextInTx(tx, inv.orderId, inv.orderPublicId, inv.discountMinor);
    if (!orderCtx.ownerUserId) return null;

    const [company, customer, lines] = await Promise.all([
      readCompanyProfileInTx(tx),
      readCustomerSnapshotInTx(tx, orderCtx.ownerUserId),
      tx
        .select()
        .from(complianceInvoiceLines)
        .where(eq(complianceInvoiceLines.invoiceId, inv.id))
        .orderBy(asc(complianceInvoiceLines.position)),
    ]);

    const now = deps.clock.now();
    const issuedAt = pmt.receivedAt ?? now;
    const sequenceNumber = await allocateYearlySequenceInTx(tx, "receipt", issuedAt);
    const receiptNumber = formatReceiptNumber(issuedAt, sequenceNumber);
    const receiptPublicId = ulid(now.getTime());

    const amountWaivedMinor =
      input.settlementKind === "waived_small_total" || pmt.method === "waiver"
        ? Math.max(pmt.waivedMinor ?? 0, pmt.amountMinor)
        : Math.max(0, pmt.waivedMinor ?? 0);
    const amountPaidMinor =
      input.settlementKind === "waived_small_total" || pmt.method === "waiver"
        ? 0
        : Math.max(0, pmt.amountMinor - amountWaivedMinor);

    const cleanBrand = sanitizeCardBrand(pmt.paymentMethodBrand);
    const cleanLast4 = sanitizeCardLast4(pmt.paymentMethodLast4);
    const invoiceLabel = inv.invoiceNumber ?? inv.publicId;

    const snapshot: ReceiptSnapshot = {
      schemaVersion: 1,
      receiptPublicId,
      receiptNumber,
      settlementKind: input.settlementKind,
      issuedAt: issuedAt.toISOString(),
      invoicePublicId: inv.publicId,
      invoiceNumber: invoiceLabel,
      paymentPublicId: pmt.publicId,
      orderPublicId: inv.orderPublicId,
      orderReference: orderCtx.orderReference,
      company: {
        legalName: inv.issuerNameSnapshot || company.legalName,
        address: inv.issuerAddressSnapshot ?? company.address,
        contact: company.contact,
        taxId: company.taxId,
        logoMode: company.logoMode,
        logoBrandPath: company.logoBrandPath,
      },
      customer,
      currency: inv.currency,
      lines: lines.map((l) => ({
        position: l.position,
        description: l.description,
        quantity: l.quantity,
        unitAmountMinor: l.unitAmountMinor,
        lineTotalMinor: l.lineTotalMinor,
      })),
      subtotalMinor: inv.subtotalMinor,
      discountMinor: inv.discountMinor,
      bundleDiscountMinor: orderCtx.bundleDiscountMinor,
      discountLabel: orderCtx.discountLabel,
      promoDiscountMinor: orderCtx.promoDiscountMinor,
      promoLabel: orderCtx.promoLabel,
      taxMinor: inv.taxMinor,
      amountWaivedMinor,
      amountPaidMinor,
      paymentMethod: pmt.method,
      paymentMethodBrand: cleanBrand,
      paymentMethodLast4: cleanLast4,
      provider: pmt.provider ?? null,
      providerReference: pmt.reference || null,
      footerText: receiptSettings.footerText,
    };

    const pdfBuffer = renderPaymentReceiptPdf(snapshot);
    const pdfSha256 = sha256Hex(pdfBuffer);
    const snapshotEnc = deps.crypto.encrypt(JSON.stringify(snapshot), receiptSnapshotAad(receiptPublicId));
    const pdfEnc = deps.crypto.encrypt(pdfBuffer.toString("base64"), receiptPdfAad(receiptPublicId));

    const shouldEmail = receiptSettings.emailCustomer;

    await tx.insert(compliancePaymentReceipts).values({
      publicId: receiptPublicId,
      receiptNumber,
      sequenceNumber,
      settlementKey,
      settlementKind: input.settlementKind,
      invoiceId: inv.id,
      invoicePublicId: inv.publicId,
      paymentId: pmt.id,
      paymentPublicId: pmt.publicId,
      orderId: inv.orderId,
      orderPublicId: inv.orderPublicId,
      orderReference: orderCtx.orderReference,
      customerUserId: orderCtx.ownerUserId,
      customerRefSnapshot: customer.customerRef,
      currency: inv.currency,
      subtotalMinor: inv.subtotalMinor,
      discountMinor: inv.discountMinor,
      bundleDiscountMinor: orderCtx.bundleDiscountMinor,
      promoDiscountMinor: orderCtx.promoDiscountMinor,
      promoLabelSnapshot: orderCtx.promoLabel,
      taxMinor: inv.taxMinor,
      amountWaivedMinor,
      amountPaidMinor,
      refundedMinor: 0,
      refundState: "none",
      paymentMethod: pmt.method,
      paymentMethodBrand: cleanBrand,
      paymentMethodLast4: cleanLast4,
      provider: pmt.provider ?? null,
      providerReference: pmt.reference || null,
      issuedAt,
      emailedAt: shouldEmail ? now : null,
      lastResentAt: null,
      resendCount: 0,
      snapshotEnc,
      pdfEnc,
      pdfSha256,
      pdfByteSize: pdfBuffer.byteLength,
      origin: "portal",
      createdAt: now,
      updatedAt: now,
    });

    await deps.audit.record(
      {
        category: "business",
        eventName: "compliance.receipt.issued",
        action: "create",
        outcome: "completed",
        actor: { role: "system" },
        resource: { type: "payment_receipt", publicId: receiptPublicId },
        attributes: {
          receipt_number: receiptNumber,
          settlement_kind: input.settlementKind,
          invoice_public_id: inv.publicId,
          payment_public_id: pmt.publicId,
          order_public_id: inv.orderPublicId,
          amount_paid_minor: amountPaidMinor,
          amount_waived_minor: amountWaivedMinor,
          currency: inv.currency,
        },
      },
      tx,
    );

    if (shouldEmail) {
      await enqueuePaymentReceipt(
        deps.mailer,
        {
          receiptPublicId,
          recipientUserId: orderCtx.ownerUserId,
          receiptNumber,
          pdf: pdfBuffer,
        },
        tx,
      );
    }

    return { receiptPublicId, receiptNumber };
  }

  /**
   * Issues an immutable zero-total payment receipt (`RPR-<year>-<6 digits>`) for an invoice whose
   * server-computed `totalMinor === 0`. Strictly refuses any invoice with `totalMinor > 0`.
   * Idempotent on `settlement_key = "zero_invoice:<invoiceId>"`.
   */
  async function issueReceiptForZeroInvoiceInTx(
    tx: Tx,
    input: { invoiceId: number },
  ): Promise<{ receiptPublicId: string; receiptNumber: string } | null> {
    const settlementKey = `zero_invoice:${input.invoiceId}`;
    const [existing] = await tx
      .select({
        publicId: compliancePaymentReceipts.publicId,
        receiptNumber: compliancePaymentReceipts.receiptNumber,
      })
      .from(compliancePaymentReceipts)
      .where(eq(compliancePaymentReceipts.settlementKey, settlementKey))
      .limit(1);
    if (existing) {
      return { receiptPublicId: existing.publicId, receiptNumber: existing.receiptNumber };
    }

    const receiptSettings = await readReceiptsConfigInTx(tx);
    if (!receiptSettings.enabled) {
      return null;
    }

    const [inv] = await tx
      .select()
      .from(complianceInvoices)
      .where(eq(complianceInvoices.id, input.invoiceId))
      .for("update")
      .limit(1);
    if (!inv || inv.origin !== "portal" || inv.voidedAt !== null || inv.issuedAt === null) {
      return null;
    }
    if (inv.totalMinor !== 0) {
      throw validation(
        "NON_ZERO_INVOICE_CANNOT_ZERO_SETTLE",
        "Only $0.00 invoices can issue a zero-total settlement receipt.",
      );
    }

    const orderCtx = await readOrderDiscountContextInTx(tx, inv.orderId, inv.orderPublicId, inv.discountMinor);
    if (!orderCtx.ownerUserId) return null;

    const [company, customer, lines] = await Promise.all([
      readCompanyProfileInTx(tx),
      readCustomerSnapshotInTx(tx, orderCtx.ownerUserId),
      tx
        .select()
        .from(complianceInvoiceLines)
        .where(eq(complianceInvoiceLines.invoiceId, inv.id))
        .orderBy(asc(complianceInvoiceLines.position)),
    ]);

    const now = deps.clock.now();
    const issuedAt = inv.issuedAt;
    const sequenceNumber = await allocateYearlySequenceInTx(tx, "receipt", issuedAt);
    const receiptNumber = formatReceiptNumber(issuedAt, sequenceNumber);
    const receiptPublicId = ulid(now.getTime());
    const invoiceLabel = inv.invoiceNumber ?? inv.publicId;

    const snapshot: ReceiptSnapshot = {
      schemaVersion: 1,
      receiptPublicId,
      receiptNumber,
      settlementKind: "zero_total",
      issuedAt: issuedAt.toISOString(),
      invoicePublicId: inv.publicId,
      invoiceNumber: invoiceLabel,
      paymentPublicId: null,
      orderPublicId: inv.orderPublicId,
      orderReference: orderCtx.orderReference,
      company: {
        legalName: inv.issuerNameSnapshot || company.legalName,
        address: inv.issuerAddressSnapshot ?? company.address,
        contact: company.contact,
        taxId: company.taxId,
        logoMode: company.logoMode,
        logoBrandPath: company.logoBrandPath,
      },
      customer,
      currency: inv.currency,
      lines: lines.map((l) => ({
        position: l.position,
        description: l.description,
        quantity: l.quantity,
        unitAmountMinor: l.unitAmountMinor,
        lineTotalMinor: l.lineTotalMinor,
      })),
      subtotalMinor: inv.subtotalMinor,
      discountMinor: inv.discountMinor,
      bundleDiscountMinor: orderCtx.bundleDiscountMinor,
      discountLabel: orderCtx.discountLabel,
      promoDiscountMinor: orderCtx.promoDiscountMinor,
      promoLabel: orderCtx.promoLabel,
      taxMinor: inv.taxMinor,
      amountWaivedMinor: 0,
      amountPaidMinor: 0,
      paymentMethod: "waiver",
      paymentMethodBrand: null,
      paymentMethodLast4: null,
      provider: null,
      providerReference: null,
      footerText: receiptSettings.footerText,
    };

    const pdfBuffer = renderPaymentReceiptPdf(snapshot);
    const pdfSha256 = sha256Hex(pdfBuffer);
    const snapshotEnc = deps.crypto.encrypt(JSON.stringify(snapshot), receiptSnapshotAad(receiptPublicId));
    const pdfEnc = deps.crypto.encrypt(pdfBuffer.toString("base64"), receiptPdfAad(receiptPublicId));
    const shouldEmail = receiptSettings.emailCustomer;

    await tx.insert(compliancePaymentReceipts).values({
      publicId: receiptPublicId,
      receiptNumber,
      sequenceNumber,
      settlementKey,
      settlementKind: "zero_total",
      invoiceId: inv.id,
      invoicePublicId: inv.publicId,
      paymentId: null,
      paymentPublicId: null,
      orderId: inv.orderId,
      orderPublicId: inv.orderPublicId,
      orderReference: orderCtx.orderReference,
      customerUserId: orderCtx.ownerUserId,
      customerRefSnapshot: customer.customerRef,
      currency: inv.currency,
      subtotalMinor: inv.subtotalMinor,
      discountMinor: inv.discountMinor,
      bundleDiscountMinor: orderCtx.bundleDiscountMinor,
      promoDiscountMinor: orderCtx.promoDiscountMinor,
      promoLabelSnapshot: orderCtx.promoLabel,
      taxMinor: inv.taxMinor,
      amountWaivedMinor: 0,
      amountPaidMinor: 0,
      refundedMinor: 0,
      refundState: "none",
      paymentMethod: "waiver",
      paymentMethodBrand: null,
      paymentMethodLast4: null,
      provider: null,
      providerReference: null,
      issuedAt,
      emailedAt: shouldEmail ? now : null,
      lastResentAt: null,
      resendCount: 0,
      snapshotEnc,
      pdfEnc,
      pdfSha256,
      pdfByteSize: pdfBuffer.byteLength,
      origin: "portal",
      createdAt: now,
      updatedAt: now,
    });

    await deps.audit.record(
      {
        category: "business",
        eventName: "compliance.receipt.issued",
        action: "create",
        outcome: "completed",
        actor: { role: "system" },
        resource: { type: "payment_receipt", publicId: receiptPublicId },
        attributes: {
          receipt_number: receiptNumber,
          settlement_kind: "zero_total",
          invoice_public_id: inv.publicId,
          order_public_id: inv.orderPublicId,
          amount_paid_minor: 0,
          amount_waived_minor: 0,
          currency: inv.currency,
        },
      },
      tx,
    );

    if (shouldEmail) {
      await enqueuePaymentReceipt(
        deps.mailer,
        {
          receiptPublicId,
          recipientUserId: orderCtx.ownerUserId,
          receiptNumber,
          pdf: pdfBuffer,
        },
        tx,
      );
    }

    return { receiptPublicId, receiptNumber };
  }

  /**
   * Called inside `tx` whenever a payment refund settles (`adminRecordRefund` or `bookSettledRefundInTx`).
   * Advances `refunded_minor` / `refund_state` on the receipt WITHOUT mutating `snapshot_enc` or `pdf_enc`,
   * and appends an immutable refund note (`RPRN-<year>-<6 digits>`).
   */
  async function onPaymentRefundedInTx(
    tx: Tx,
    input: { paymentId: number; refundId: number },
  ): Promise<{ notePublicId: string; noteNumber: string; resultingRefundState: ReceiptNoteRefundState } | null> {
    const [receipt] = await tx
      .select()
      .from(compliancePaymentReceipts)
      .where(eq(compliancePaymentReceipts.paymentId, input.paymentId))
      .for("update")
      .limit(1);
    if (!receipt || receipt.origin !== "portal" || receipt.amountPaidMinor <= 0) {
      return null;
    }

    const [existingNote] = await tx
      .select({
        publicId: complianceReceiptRefundNotes.publicId,
        noteNumber: complianceReceiptRefundNotes.noteNumber,
        resultingRefundState: complianceReceiptRefundNotes.resultingRefundState,
      })
      .from(complianceReceiptRefundNotes)
      .where(eq(complianceReceiptRefundNotes.refundId, input.refundId))
      .limit(1);
    if (existingNote) {
      return {
        notePublicId: existingNote.publicId,
        noteNumber: existingNote.noteNumber,
        resultingRefundState: existingNote.resultingRefundState,
      };
    }

    const [refundRow] = await tx
      .select()
      .from(complianceInvoiceRefunds)
      .where(eq(complianceInvoiceRefunds.id, input.refundId))
      .limit(1);
    if (!refundRow) return null;

    const allRefunds = await tx
      .select({ amountMinor: complianceInvoiceRefunds.amountMinor })
      .from(complianceInvoiceRefunds)
      .where(eq(complianceInvoiceRefunds.paymentId, input.paymentId));
    const totalRefundedOnPayment = allRefunds.reduce((sum, r) => sum + r.amountMinor, 0);
    const cumulativeRefundedMinor = Math.min(receipt.amountPaidMinor, totalRefundedOnPayment);
    const resultingRefundState: ReceiptNoteRefundState =
      cumulativeRefundedMinor >= receipt.amountPaidMinor ? "refunded" : "partially_refunded";

    const now = deps.clock.now();
    await tx
      .update(compliancePaymentReceipts)
      .set({
        refundedMinor: cumulativeRefundedMinor,
        refundState: resultingRefundState,
        updatedAt: now,
      })
      .where(eq(compliancePaymentReceipts.id, receipt.id));

    const [inv] = await tx
      .select({ publicId: complianceInvoices.publicId, invoiceNumber: complianceInvoices.invoiceNumber })
      .from(complianceInvoices)
      .where(eq(complianceInvoices.id, receipt.invoiceId))
      .limit(1);

    const [company, customer] = await Promise.all([
      readCompanyProfileInTx(tx),
      readCustomerSnapshotInTx(tx, receipt.customerUserId),
    ]);

    const issuedAt = refundRow.refundedAt ?? now;
    const sequenceNumber = await allocateYearlySequenceInTx(tx, "refund_note", issuedAt);
    const noteNumber = formatRefundNoteNumber(issuedAt, sequenceNumber);
    const notePublicId = ulid(now.getTime());

    const noteSnapshot: RefundNoteSnapshot = {
      schemaVersion: 1,
      notePublicId,
      noteNumber,
      issuedAt: issuedAt.toISOString(),
      receiptPublicId: receipt.publicId,
      receiptNumber: receipt.receiptNumber,
      invoicePublicId: receipt.invoicePublicId,
      invoiceNumber: inv?.invoiceNumber ?? receipt.invoicePublicId,
      refundPublicId: refundRow.publicId,
      orderPublicId: receipt.orderPublicId,
      orderReference: receipt.orderReference,
      company,
      customer,
      currency: receipt.currency,
      originalAmountPaidMinor: receipt.amountPaidMinor,
      refundAmountMinor: refundRow.amountMinor,
      cumulativeRefundedMinor,
      resultingRefundState,
      reasonCode: refundRow.reasonCode,
      reference: refundRow.reference,
    };

    const pdfBuffer = renderRefundNotePdf(noteSnapshot);
    const pdfSha256 = sha256Hex(pdfBuffer);
    const snapshotEnc = deps.crypto.encrypt(
      JSON.stringify(noteSnapshot),
      refundNoteSnapshotAad(notePublicId),
    );
    const pdfEnc = deps.crypto.encrypt(pdfBuffer.toString("base64"), refundNotePdfAad(notePublicId));

    await tx.insert(complianceReceiptRefundNotes).values({
      publicId: notePublicId,
      noteNumber,
      sequenceNumber,
      receiptId: receipt.id,
      receiptPublicId: receipt.publicId,
      refundId: refundRow.id,
      refundPublicId: refundRow.publicId,
      orderId: receipt.orderId,
      orderPublicId: receipt.orderPublicId,
      customerUserId: receipt.customerUserId,
      currency: receipt.currency,
      refundAmountMinor: refundRow.amountMinor,
      cumulativeRefundedMinor,
      resultingRefundState,
      reasonCode: refundRow.reasonCode,
      reference: refundRow.reference,
      issuedAt,
      snapshotEnc,
      pdfEnc,
      pdfSha256,
      pdfByteSize: pdfBuffer.byteLength,
      origin: "portal",
      createdAt: now,
    });

    await deps.audit.record(
      {
        category: "business",
        eventName: "compliance.receipt.refund_note_issued",
        action: "create",
        outcome: "completed",
        actor: { role: "system" },
        resource: { type: "receipt_refund_note", publicId: notePublicId },
        attributes: {
          note_number: noteNumber,
          receipt_public_id: receipt.publicId,
          receipt_number: receipt.receiptNumber,
          refund_public_id: refundRow.publicId,
          order_public_id: receipt.orderPublicId,
          refund_amount_minor: refundRow.amountMinor,
          cumulative_refunded_minor: cumulativeRefundedMinor,
          resulting_refund_state: resultingRefundState,
          currency: receipt.currency,
        },
      },
      tx,
    );

    return { notePublicId, noteNumber, resultingRefundState };
  }

  function toNoteSummaryView(row: typeof complianceReceiptRefundNotes.$inferSelect): RefundNoteSummaryView {
    return {
      notePublicId: row.publicId,
      noteNumber: row.noteNumber,
      receiptPublicId: row.receiptPublicId,
      refundPublicId: row.refundPublicId,
      orderPublicId: row.orderPublicId,
      currency: row.currency,
      refundAmountMinor: row.refundAmountMinor,
      cumulativeRefundedMinor: row.cumulativeRefundedMinor,
      resultingRefundState: row.resultingRefundState,
      reasonCode: row.reasonCode,
      reference: row.reference,
      issuedAt: row.issuedAt,
    };
  }

  function toSummaryView(
    row: typeof compliancePaymentReceipts.$inferSelect,
    notes: RefundNoteSummaryView[],
  ): ReceiptSummaryView {
    return {
      receiptPublicId: row.publicId,
      receiptNumber: row.receiptNumber,
      settlementKind: row.settlementKind,
      invoicePublicId: row.invoicePublicId,
      paymentPublicId: row.paymentPublicId ?? null,
      orderPublicId: row.orderPublicId,
      orderReference: row.orderReference,
      customerRef: row.customerRefSnapshot ?? null,
      currency: row.currency,
      subtotalMinor: row.subtotalMinor,
      discountMinor: row.discountMinor,
      bundleDiscountMinor: row.bundleDiscountMinor,
      promoDiscountMinor: row.promoDiscountMinor,
      promoLabel: row.promoLabelSnapshot ?? null,
      taxMinor: row.taxMinor,
      amountWaivedMinor: row.amountWaivedMinor,
      amountPaidMinor: row.amountPaidMinor,
      refundedMinor: row.refundedMinor,
      refundState: row.refundState,
      paymentMethod: row.paymentMethod,
      paymentMethodBrand: row.paymentMethodBrand ?? null,
      paymentMethodLast4: row.paymentMethodLast4 ?? null,
      paymentMethodSummary: formatPaymentMethodSummaryPlain({
        settlementKind: row.settlementKind,
        paymentMethod: row.paymentMethod,
        paymentMethodBrand: row.paymentMethodBrand ?? null,
        paymentMethodLast4: row.paymentMethodLast4 ?? null,
        provider: row.provider ?? null,
      }),
      provider: row.provider ?? null,
      issuedAt: row.issuedAt,
      origin: row.origin,
      refundNotes: notes,
    };
  }

  function toAdminSummaryView(
    row: typeof compliancePaymentReceipts.$inferSelect,
    notes: RefundNoteSummaryView[],
  ): AdminReceiptSummaryView {
    return {
      ...toSummaryView(row, notes),
      providerReference: row.providerReference ?? null,
      emailedAt: row.emailedAt ?? null,
      lastResentAt: row.lastResentAt ?? null,
      resendCount: row.resendCount,
    };
  }

  async function loadNotesMap(
    dbOrTx: DbOrTx,
    receiptIds: readonly number[],
  ): Promise<Map<number, RefundNoteSummaryView[]>> {
    const map = new Map<number, RefundNoteSummaryView[]>();
    if (receiptIds.length === 0) return map;
    const rows = await dbOrTx
      .select()
      .from(complianceReceiptRefundNotes)
      .where(inArray(complianceReceiptRefundNotes.receiptId, [...receiptIds]))
      .orderBy(asc(complianceReceiptRefundNotes.issuedAt), asc(complianceReceiptRefundNotes.id));
    for (const row of rows) {
      const arr = map.get(row.receiptId) ?? [];
      arr.push(toNoteSummaryView(row));
      map.set(row.receiptId, arr);
    }
    return map;
  }

  const collaboratorDeniedErrors = new WeakSet<DomainError>();

  async function assertCanReadReceiptRow(
    principal: SessionPrincipal,
    row: typeof compliancePaymentReceipts.$inferSelect,
    tx?: Tx,
    notFoundCode: "RECEIPT_NOT_FOUND" | "REFUND_NOTE_NOT_FOUND" = "RECEIPT_NOT_FOUND",
  ): Promise<{ liveRole: SessionPrincipal["role"]; liveUserId: number }> {
    const liveActor = await assertLiveActorInTx(deps, principal, tx ?? (deps.db as unknown as Tx));
    const livePrincipal: SessionPrincipal = { ...principal, role: liveActor.role };

    if (isStaffOrAdmin(livePrincipal) && hasStaffReceiptReadCap(livePrincipal.role)) {
      return { liveRole: livePrincipal.role, liveUserId: liveActor.userId };
    }

    if (row.customerUserId === liveActor.userId) {
      return { liveRole: livePrincipal.role, liveUserId: liveActor.userId };
    }

    // Increment 06 security boundary: generic order collaborators (`viewer` / `contributor`) do NOT
    // receive receipt or refund-note access. Only an explicit billing grant on the order qualifies.
    try {
      const ordersSvc = requireOrdersService();
      const orderView = await ordersSvc.assertCanReadOrder(
        livePrincipal,
        row.orderPublicId,
        tx ? { tx } : undefined,
      );
      if (orderView.ownerUserId === liveActor.userId || hasExplicitOrderBillingGrant(orderView)) {
        return { liveRole: livePrincipal.role, liveUserId: liveActor.userId };
      }
    } catch {
      throw notFound(notFoundCode);
    }

    if (!tx) {
      await deps.audit.record({
        category: "security",
        eventName: "authz.compliance.denied",
        action: "authorize",
        outcome: "denied",
        severity: "WARN",
        reasonCode: "NOT_RECEIPT_BUYER_OR_BILLING",
        actor: { userId: liveActor.userId, role: livePrincipal.role },
        resource: { type: "payment_receipt", publicId: row.publicId },
      });
    }
    const err = notFound(notFoundCode);
    collaboratorDeniedErrors.add(err);
    throw err;
  }

  async function myList(
    principal: SessionPrincipal,
    input?: { cursor?: string | undefined; limit?: number | undefined },
  ): Promise<{ items: ReceiptSummaryView[]; nextCursor: string | null }> {
    const liveActor = await assertLiveActorInTx(deps, principal, deps.db as unknown as Tx);
    const limit = Math.min(Math.max(input?.limit ?? 20, 1), 100);
    const afterId = decodeIdCursor(input?.cursor);

    const conditions = [eq(compliancePaymentReceipts.customerUserId, liveActor.userId)];
    if (afterId !== null) {
      conditions.push(lt(compliancePaymentReceipts.id, afterId));
    }

    const rows = await deps.db
      .select()
      .from(compliancePaymentReceipts)
      .where(and(...conditions))
      .orderBy(desc(compliancePaymentReceipts.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const notesMap = await loadNotesMap(
      deps.db,
      pageRows.map((r) => r.id),
    );

    return {
      items: pageRows.map((r) => toSummaryView(r, notesMap.get(r.id) ?? [])),
      nextCursor: hasMore && pageRows.length > 0 ? encodeIdCursor(pageRows[pageRows.length - 1]!.id) : null,
    };
  }

  async function forOrder(
    principal: SessionPrincipal,
    orderPublicId: string,
  ): Promise<ReceiptSummaryView[]> {
    const liveActor = await assertLiveActorInTx(deps, principal, deps.db as unknown as Tx);
    const livePrincipal: SessionPrincipal = { ...principal, role: liveActor.role };
    const ordersSvc = requireOrdersService();
    const orderView = await ordersSvc.assertCanReadOrder(livePrincipal, orderPublicId);

    const allowed =
      (isStaffOrAdmin(livePrincipal) && hasStaffReceiptReadCap(livePrincipal.role)) ||
      orderView.ownerUserId === liveActor.userId ||
      hasExplicitOrderBillingGrant(orderView);
    if (!allowed) {
      await denyComplianceAuthz(deps, livePrincipal, "NOT_RECEIPT_BUYER_OR_BILLING", {
        type: "order_receipts",
        publicId: orderPublicId,
      });
    }

    const rows = await deps.db
      .select()
      .from(compliancePaymentReceipts)
      .where(eq(compliancePaymentReceipts.orderPublicId, orderPublicId))
      .orderBy(desc(compliancePaymentReceipts.issuedAt), desc(compliancePaymentReceipts.id));

    const notesMap = await loadNotesMap(
      deps.db,
      rows.map((r) => r.id),
    );
    return rows.map((r) => toSummaryView(r, notesMap.get(r.id) ?? []));
  }

  async function get(principal: SessionPrincipal, receiptPublicId: string): Promise<ReceiptDetailView> {
    const [row] = await deps.db
      .select()
      .from(compliancePaymentReceipts)
      .where(eq(compliancePaymentReceipts.publicId, receiptPublicId))
      .limit(1);
    if (!row) throw notFound("RECEIPT_NOT_FOUND");

    const { liveRole } = await assertCanReadReceiptRow(principal, row);
    const notesMap = await loadNotesMap(deps.db, [row.id]);
    const rawSnapshot = deps.crypto.decrypt(row.snapshotEnc, receiptSnapshotAad(row.publicId));
    const snapshot = JSON.parse(rawSnapshot) as ReceiptSnapshot;

    const canResend =
      (liveRole === "staff" || liveRole === "admin") &&
      roleHasCapability(liveRole, "invoices.read_all") &&
      row.origin === "portal";

    return {
      ...toSummaryView(row, notesMap.get(row.id) ?? []),
      snapshot,
      emailedAt: row.emailedAt ?? null,
      lastResentAt: row.lastResentAt ?? null,
      resendCount: row.resendCount,
      canResend,
    };
  }

  async function downloadReceiptPdf(
    principal: SessionPrincipal,
    receiptPublicId: string,
  ): Promise<{ filename: string; contentType: "application/pdf"; buffer: Buffer }> {
    return runComplianceTx(
      deps,
      principal,
      { type: "payment_receipt", publicId: receiptPublicId },
      async (tx) => {
        const [row] = await tx
          .select()
          .from(compliancePaymentReceipts)
          .where(eq(compliancePaymentReceipts.publicId, receiptPublicId))
          .limit(1);
        if (!row) throw notFound("RECEIPT_NOT_FOUND");

        const { liveRole, liveUserId } = await assertCanReadReceiptRow(principal, row, tx, "RECEIPT_NOT_FOUND");
        const b64 = deps.crypto.decrypt(row.pdfEnc, receiptPdfAad(row.publicId));
        const buffer = Buffer.from(b64, "base64");
        if (sha256Hex(buffer) !== row.pdfSha256) {
          throw new DomainError(
            "INTERNAL" as never,
            "RECEIPT_PDF_INTEGRITY_MISMATCH",
            "Stored receipt PDF failed cryptographic integrity verification.",
          );
        }

        await deps.audit.record(
          {
            category: "business",
            eventName: "compliance.receipt.downloaded",
            action: "download",
            outcome: "completed",
            actor: { userId: liveUserId, role: liveRole },
            resource: { type: "payment_receipt", publicId: row.publicId },
            attributes: {
              receipt_number: row.receiptNumber,
              order_public_id: row.orderPublicId,
              invoice_public_id: row.invoicePublicId,
            },
          },
          tx,
        );

        return {
          filename: `${row.receiptNumber}.pdf`,
          contentType: "application/pdf" as const,
          buffer,
        };
      },
      {
        onRefusalAfterRollback: async (err: DomainError) => {
          if (collaboratorDeniedErrors.has(err)) {
            await deps.audit.record({
              category: "security",
              eventName: "authz.compliance.denied",
              action: "authorize",
              outcome: "denied",
              severity: "WARN",
              reasonCode: "NOT_RECEIPT_BUYER_OR_BILLING",
              actor: { userId: principal.userId, role: principal.role },
              resource: { type: "payment_receipt", publicId: receiptPublicId },
            });
          }
        },
      },
    );
  }

  async function downloadRefundNotePdf(
    principal: SessionPrincipal,
    notePublicId: string,
  ): Promise<{ filename: string; contentType: "application/pdf"; buffer: Buffer }> {
    return runComplianceTx(
      deps,
      principal,
      { type: "receipt_refund_note", publicId: notePublicId },
      async (tx) => {
        const [note] = await tx
          .select()
          .from(complianceReceiptRefundNotes)
          .where(eq(complianceReceiptRefundNotes.publicId, notePublicId))
          .limit(1);
        if (!note) throw notFound("REFUND_NOTE_NOT_FOUND");

        const [receipt] = await tx
          .select()
          .from(compliancePaymentReceipts)
          .where(eq(compliancePaymentReceipts.id, note.receiptId))
          .limit(1);
        if (!receipt) throw notFound("REFUND_NOTE_NOT_FOUND");

        const { liveRole, liveUserId } = await assertCanReadReceiptRow(principal, receipt, tx, "REFUND_NOTE_NOT_FOUND");
        const b64 = deps.crypto.decrypt(note.pdfEnc, refundNotePdfAad(note.publicId));
        const buffer = Buffer.from(b64, "base64");
        if (sha256Hex(buffer) !== note.pdfSha256) {
          throw new DomainError(
            "INTERNAL" as never,
            "REFUND_NOTE_PDF_INTEGRITY_MISMATCH",
            "Stored refund note PDF failed cryptographic integrity verification.",
          );
        }

        await deps.audit.record(
          {
            category: "business",
            eventName: "compliance.receipt_refund_note.downloaded",
            action: "download",
            outcome: "completed",
            actor: { userId: liveUserId, role: liveRole },
            resource: { type: "receipt_refund_note", publicId: note.publicId },
            attributes: {
              note_number: note.noteNumber,
              receipt_public_id: receipt.publicId,
              order_public_id: note.orderPublicId,
            },
          },
          tx,
        );

        return {
          filename: `${note.noteNumber}.pdf`,
          contentType: "application/pdf" as const,
          buffer,
        };
      },
      {
        onRefusalAfterRollback: async (err: DomainError) => {
          if (collaboratorDeniedErrors.has(err)) {
            await deps.audit.record({
              category: "security",
              eventName: "authz.compliance.denied",
              action: "authorize",
              outcome: "denied",
              severity: "WARN",
              reasonCode: "NOT_RECEIPT_BUYER_OR_BILLING",
              actor: { userId: principal.userId, role: principal.role },
              resource: { type: "receipt_refund_note", publicId: notePublicId },
            });
          }
        },
      },
    );
  }

  async function assertStaffReceiptAccess(principal: SessionPrincipal): Promise<void> {
    const resource = { type: "payment_receipt" };
    if (principal.state !== "full" || principal.pendingSteps.length > 0) {
      await denyComplianceAuthz(deps, principal, "REMEDIATION_SESSION", resource);
    }
    if (!isStaffOrAdmin(principal) || !hasStaffReceiptReadCap(principal.role)) {
      await denyComplianceAuthz(deps, principal, "CAPABILITY_NOT_GRANTED", resource);
    }
  }

  async function adminListForOrder(
    principal: SessionPrincipal,
    orderPublicId: string,
  ): Promise<AdminReceiptSummaryView[]> {
    await assertStaffReceiptAccess(principal);
    const liveActor = await assertLiveActorInTx(deps, principal, deps.db as unknown as Tx);
    const livePrincipal: SessionPrincipal = { ...principal, role: liveActor.role };
    const ordersSvc = requireOrdersService();
    await ordersSvc.assertCanReadOrder(livePrincipal, orderPublicId);

    const rows = await deps.db
      .select()
      .from(compliancePaymentReceipts)
      .where(eq(compliancePaymentReceipts.orderPublicId, orderPublicId))
      .orderBy(desc(compliancePaymentReceipts.issuedAt), desc(compliancePaymentReceipts.id));

    const notesMap = await loadNotesMap(
      deps.db,
      rows.map((r) => r.id),
    );
    return rows.map((r) => toAdminSummaryView(r, notesMap.get(r.id) ?? []));
  }

  async function adminListForCustomer(
    principal: SessionPrincipal,
    input: { customerPublicId: string; cursor?: string | undefined; limit?: number | undefined },
  ): Promise<{ items: AdminReceiptSummaryView[]; nextCursor: string | null }> {
    await assertStaffReceiptAccess(principal);
    await assertLiveActorInTx(deps, principal, deps.db as unknown as Tx);

    const [customer] = await deps.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.publicId, input.customerPublicId))
      .limit(1);
    if (!customer) throw notFound("CUSTOMER_NOT_FOUND");

    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const afterId = decodeIdCursor(input.cursor);

    const conditions = [eq(compliancePaymentReceipts.customerUserId, customer.id)];
    if (afterId !== null) {
      conditions.push(lt(compliancePaymentReceipts.id, afterId));
    }

    const rows = await deps.db
      .select()
      .from(compliancePaymentReceipts)
      .where(and(...conditions))
      .orderBy(desc(compliancePaymentReceipts.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const notesMap = await loadNotesMap(
      deps.db,
      pageRows.map((r) => r.id),
    );

    return {
      items: pageRows.map((r) => toAdminSummaryView(r, notesMap.get(r.id) ?? [])),
      nextCursor: hasMore && pageRows.length > 0 ? encodeIdCursor(pageRows[pageRows.length - 1]!.id) : null,
    };
  }

  async function adminResend(
    principal: SessionPrincipal,
    input: { receiptPublicId: string },
  ): Promise<{
    receiptPublicId: string;
    receiptNumber: string;
    resendCount: number;
    lastResentAt: Date;
    attachment: "attached" | "omitted_too_large";
  }> {
    await assertStaffReceiptAccess(principal);

    return runComplianceTx(
      deps,
      principal,
      { type: "payment_receipt", publicId: input.receiptPublicId },
      async (tx) => {
        const liveActor = await assertLiveActorInTx(deps, principal, tx);
        if (liveActor.role !== "staff" && liveActor.role !== "admin") {
          throw new DomainError("FORBIDDEN", "STAFF_REQUIRED", "Only staff or administrators may resend receipts.");
        }

        const [row] = await tx
          .select()
          .from(compliancePaymentReceipts)
          .where(eq(compliancePaymentReceipts.publicId, input.receiptPublicId))
          .for("update")
          .limit(1);
        if (!row) throw notFound("RECEIPT_NOT_FOUND");
        if (row.origin !== "portal") {
          throw new DomainError("CONFLICT", "IMPORTED_RECEIPT_READ_ONLY", "Imported historical receipts cannot be resent.");
        }

        const now = deps.clock.now();
        const nowMs = now.getTime();
        const nowSec = Math.floor(nowMs / 1000);
        const hourlyWindowSec = Math.floor(RECEIPT_RESEND_HOURLY_WINDOW_MS / 1000);
        if (row.resendCount >= RECEIPT_MAX_RESEND_COUNT) {
          throw new DomainError(
            "RATE_LIMITED",
            "RECEIPT_RESEND_LIMIT_REACHED",
            "This receipt has reached the maximum number of manual resend deliveries.",
          );
        }
        if (row.lastResentAt && nowMs - row.lastResentAt.getTime() < RECEIPT_RESEND_COOLDOWN_MS) {
          throw new DomainError(
            "RATE_LIMITED",
            "RECEIPT_RESEND_COOLDOWN",
            "This receipt was just sent. Please wait a minute before sending it again.",
          );
        }

        const slotKeys = buildReceiptResendSlotKeys(row.id);
        const slotRows = await tx
          .select()
          .from(complianceSequences)
          .where(inArray(complianceSequences.seqKey, slotKeys))
          .for("update");
        const recentInHour = slotRows.filter(
          (slot) => slot.nextVal > 0 && nowSec - slot.nextVal < hourlyWindowSec,
        ).length;
        if (recentInHour >= RECEIPT_MAX_RESENDS_PER_HOUR) {
          throw new DomainError(
            "RATE_LIMITED",
            "RECEIPT_RESEND_RATE_LIMITED",
            "This receipt has already been resent 3 times in the past hour. Try again later.",
          );
        }

        const b64 = deps.crypto.decrypt(row.pdfEnc, receiptPdfAad(row.publicId));
        const pdfBuffer = Buffer.from(b64, "base64");
        const resendRequestPublicId = ulid(now.getTime());

        const mailRes = await enqueuePaymentReceipt(
          deps.mailer,
          {
            receiptPublicId: row.publicId,
            recipientUserId: row.customerUserId,
            receiptNumber: row.receiptNumber,
            pdf: pdfBuffer,
            resendRequestPublicId,
          },
          tx,
        );

        const nextResendCount = row.resendCount + 1;
        await tx
          .update(compliancePaymentReceipts)
          .set({
            emailedAt: row.emailedAt ?? now,
            lastResentAt: now,
            resendCount: nextResendCount,
            updatedAt: now,
          })
          .where(eq(compliancePaymentReceipts.id, row.id));

        const targetSlotKey = `rcpt_r${row.resendCount % RECEIPT_MAX_RESENDS_PER_HOUR}:${row.id}`;
        await tx
          .insert(complianceSequences)
          .values({
            seqKey: targetSlotKey,
            nextVal: nowSec,
            updatedAt: now,
          })
          .onDuplicateKeyUpdate({
            set: {
              nextVal: nowSec,
              updatedAt: now,
            },
          });

        await deps.audit.record(
          {
            category: "business",
            eventName: "compliance.receipt.resent",
            action: "send",
            outcome: "completed",
            actor: { userId: liveActor.userId, role: liveActor.role },
            resource: { type: "payment_receipt", publicId: row.publicId },
            attributes: {
              receipt_number: row.receiptNumber,
              order_public_id: row.orderPublicId,
              invoice_public_id: row.invoicePublicId,
              resend_count: nextResendCount,
              resend_request_public_id: resendRequestPublicId,
              attachment: mailRes.attachment,
            },
          },
          tx,
        );

        return {
          receiptPublicId: row.publicId,
          receiptNumber: row.receiptNumber,
          resendCount: nextResendCount,
          lastResentAt: now,
          attachment: mailRes.attachment,
        };
      },
      {
        onRefusalAfterRollback: async (err: DomainError) => {
          if (err.code === "RATE_LIMITED") {
            await deps.audit.record({
              category: "security",
              eventName: "compliance.receipt.resend_rate_limited",
              action: "send",
              outcome: "refused",
              reasonCode: err.reasonCode,
              actor: { userId: principal.userId, role: principal.role },
              resource: { type: "payment_receipt", publicId: input.receiptPublicId },
            });
          }
        },
      },
    );
  }

  async function findLatestReceiptPublicIdForInvoice(
    dbOrTx: DbOrTx,
    invoiceId: number,
  ): Promise<string | null> {
    const [latest] = await dbOrTx
      .select({ publicId: compliancePaymentReceipts.publicId })
      .from(compliancePaymentReceipts)
      .where(eq(compliancePaymentReceipts.invoiceId, invoiceId))
      .orderBy(desc(compliancePaymentReceipts.id))
      .limit(1);
    return latest?.publicId ?? null;
  }

  return {
    issueReceiptForPaymentInTx,
    issueReceiptForZeroInvoiceInTx,
    onPaymentRefundedInTx,
    findLatestReceiptPublicIdForInvoice,
    myList,
    forOrder,
    get,
    downloadReceiptPdf,
    downloadRefundNotePdf,
    admin: {
      listForOrder: adminListForOrder,
      listForCustomer: adminListForCustomer,
      resend: adminResend,
    },
  };
}

export type ReceiptsService = ReturnType<typeof createReceiptsService>;
