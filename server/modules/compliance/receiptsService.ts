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
import { isLiveUserRow } from "../identity/live.js";
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

export type OrderLifecycleState = "live" | "trashed" | "deleted";

export interface ReceiptSummaryView {
  receiptPublicId: string;
  receiptNumber: string;
  settlementKind: ReceiptSettlementKind;
  invoicePublicId: string;
  paymentPublicId: string | null;
  orderPublicId: string;
  orderReference: string;
  projectName?: string | null;
  orderLifecycleState?: OrderLifecycleState;
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
const invoiceBuyerSnapshotAad = (publicId: string) => `compliance_invoices.buyer_snapshot:${publicId}`;

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

  function decodeFrozenInvoiceBuyer(inv: {
    publicId: string;
    buyerSnapshotEnc?: string | null;
    customerRefSnapshot?: string | null;
  }): { name: string; email: string; customerRef: string | null } | null {
    if (!inv.buyerSnapshotEnc) return null;
    try {
      const parsed = JSON.parse(
        deps.crypto.decrypt(inv.buyerSnapshotEnc, invoiceBuyerSnapshotAad(inv.publicId)),
      ) as { name?: unknown; email?: unknown; customerRef?: unknown };
      return {
        name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : "Customer",
        email: typeof parsed.email === "string" ? parsed.email.trim() : "",
        customerRef:
          typeof parsed.customerRef === "string" && parsed.customerRef.trim()
            ? parsed.customerRef.trim()
            : (inv.customerRefSnapshot ?? null),
      };
    } catch {
      return null;
    }
  }

  async function readCustomerSnapshotInTx(
    tx: Tx,
    userId: number,
    fallbackInvoice?: {
      publicId: string;
      buyerSnapshotEnc?: string | null;
      customerRefSnapshot?: string | null;
    },
  ): Promise<{ name: string; email: string; customerRef: string | null; live: boolean }> {
    const frozen = fallbackInvoice ? decodeFrozenInvoiceBuyer(fallbackInvoice) : null;
    const identitySvc = (deps.services as Partial<typeof deps.services>).identity;
    if (identitySvc && typeof identitySvc.getUser === "function") {
      const view = await identitySvc.getUser(userId, { tx });
      if (view) {
        return {
          name: view.name || "Customer",
          email: view.email || "",
          customerRef: view.customerRef ?? null,
          live: true,
        };
      }
    }
    const [row] = await tx
      .select({
        publicId: users.publicId,
        nameEnc: users.nameEnc,
        emailEnc: users.emailEnc,
        customerRef: users.customerRef,
        trashedAt: users.trashedAt,
        purgedAt: users.purgedAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row || row.purgedAt !== null) {
      if (frozen) {
        return { ...frozen, live: false };
      }
      return {
        name: "Deleted account",
        email: "",
        customerRef: row?.customerRef ?? fallbackInvoice?.customerRefSnapshot ?? null,
        live: false,
      };
    }
    let name = frozen?.name || "Customer";
    let email = frozen?.email || "";
    try {
      name = deps.crypto.decrypt(row.nameEnc, nameAad(row.publicId)) || name;
    } catch {
      // keep fallback
    }
    try {
      email = deps.crypto.decrypt(row.emailEnc, emailAad(row.publicId)) || email;
    } catch {
      // keep fallback
    }
    return {
      name,
      email,
      customerRef: row.customerRef ?? frozen?.customerRef ?? null,
      live: isLiveUserRow(row),
    };
  }

  async function resolveOrderMetaByOrderIds(
    dbOrTx: DbOrTx,
    orderIds: readonly number[],
  ): Promise<Map<number, { projectName: string | null; lifecycle: OrderLifecycleState }>> {
    const out = new Map<number, { projectName: string | null; lifecycle: OrderLifecycleState }>();
    const uniqueIds = [...new Set(orderIds.filter((id) => Number.isInteger(id) && id > 0))];
    if (uniqueIds.length === 0) return out;

    try {
      const ordRows = await dbOrTx
        .select({
          id: orders.id,
          projectName: orders.projectName,
          trashedAt: orders.trashedAt,
          purgedAt: orders.purgedAt,
        })
        .from(orders)
        .where(inArray(orders.id, uniqueIds));
      for (const row of ordRows) {
        const lifecycle: OrderLifecycleState =
          row.purgedAt !== null ? "deleted" : row.trashedAt !== null ? "trashed" : "live";
        const trimmed = row.projectName?.trim() || null;
        out.set(row.id, {
          projectName: lifecycle === "deleted" ? "Deleted order" : trimmed,
          lifecycle,
        });
      }
    } catch {
      // Standalone compliance unit tests may mock orders service without populating `orders` rows.
    }

    const ordersSvc = (deps.services as Partial<typeof deps.services>).orders;
    for (const orderId of uniqueIds) {
      const current = out.get(orderId);
      if (current) {
        if (!current.projectName && current.lifecycle === "live" && ordersSvc && typeof ordersSvc.getOrderRefById === "function") {
          const ref = await ordersSvc.getOrderRefById(
            orderId,
            dbOrTx !== deps.db ? (dbOrTx as Tx) : undefined,
          );
          const candidateName =
            ref && typeof (ref as { name?: unknown }).name === "string" ? ref.name.trim() : "";
          if (candidateName) {
            out.set(orderId, { projectName: candidateName, lifecycle: "live" });
          }
        }
        continue;
      }

      if (ordersSvc && typeof ordersSvc.retainedOrderRefInTx === "function" && dbOrTx !== deps.db) {
        const retained = await ordersSvc.retainedOrderRefInTx(dbOrTx as Tx, orderId);
        if (retained) {
          const lifecycle: OrderLifecycleState = retained.purged
            ? "deleted"
            : retained.trashed
              ? "trashed"
              : "live";
          out.set(orderId, {
            projectName: lifecycle === "deleted" ? "Deleted order" : null,
            lifecycle,
          });
          continue;
        }
      }

      if (ordersSvc && typeof ordersSvc.getOrderRefById === "function") {
        const ref = await ordersSvc.getOrderRefById(
          orderId,
          dbOrTx !== deps.db ? (dbOrTx as Tx) : undefined,
        );
        if (ref) {
          const candidateName =
            typeof (ref as { name?: unknown }).name === "string" ? ref.name.trim() : "";
          out.set(orderId, {
            projectName: candidateName || null,
            lifecycle: "live",
          });
          continue;
        }
      }

      out.set(orderId, { projectName: "Deleted order", lifecycle: "deleted" });
    }

    return out;
  }

  async function resolveProjectNamesByOrderIds(
    dbOrTx: DbOrTx,
    orderIds: readonly number[],
  ): Promise<Map<number, string>> {
    const meta = await resolveOrderMetaByOrderIds(dbOrTx, orderIds);
    const out = new Map<number, string>();
    for (const [id, entry] of meta.entries()) {
      if (entry.projectName) out.set(id, entry.projectName);
    }
    return out;
  }

  async function readOrderDiscountContextInTx(
    tx: Tx,
    orderId: number,
    fallbackOrderPublicId: string,
    invoiceDiscountMinor: number,
    fallbackOrderReference?: string | null,
  ): Promise<{
    ownerUserId: number;
    orderReference: string;
    projectName: string | null;
    bundleDiscountMinor: number;
    discountLabel: string | null;
    promoDiscountMinor: number;
    promoLabel: string | null;
    lifecycle: OrderLifecycleState;
  }> {
    let ownerUserId = 0;
    let orderReference = fallbackOrderReference || fallbackOrderPublicId;
    let projectName: string | null = null;
    let lifecycle: OrderLifecycleState = "live";
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
        const refName =
          typeof (ref as { name?: unknown }).name === "string" ? ref.name.trim() : "";
        if (refName) projectName = refName;
      } else if (typeof ordersSvc.retainedOrderRefInTx === "function") {
        const retained = await ordersSvc.retainedOrderRefInTx(tx, orderId);
        if (retained) {
          ownerUserId = retained.ownerUserId;
          orderReference = retained.reference || orderReference;
          lifecycle = retained.purged ? "deleted" : retained.trashed ? "trashed" : "live";
          if (retained.purged) projectName = "Deleted order";
        }
      }
    }

    try {
      const [ord] = await tx
        .select({
          ownerUserId: orders.ownerUserId,
          reference: orders.reference,
          projectName: orders.projectName,
          discountMinor: orders.discountMinor,
          discountLabel: orders.discountLabel,
          promoDiscountMinor: orders.promoDiscountMinor,
          promoLabel: orders.promoLabel,
          trashedAt: orders.trashedAt,
          purgedAt: orders.purgedAt,
        })
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1);
      if (ord) {
        if (!ownerUserId) ownerUserId = ord.ownerUserId;
        orderReference = ord.reference || orderReference;
        lifecycle =
          ord.purgedAt !== null ? "deleted" : ord.trashedAt !== null ? "trashed" : "live";
        if (lifecycle === "deleted") {
          projectName = "Deleted order";
        } else if (ord.projectName?.trim()) {
          projectName = ord.projectName.trim();
        }
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
      projectName,
      bundleDiscountMinor,
      discountLabel,
      promoDiscountMinor,
      promoLabel,
      lifecycle,
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

    const orderCtx = await readOrderDiscountContextInTx(
      tx,
      inv.orderId,
      inv.orderPublicId,
      inv.discountMinor,
      inv.orderReferenceSnapshot,
    );
    if (!orderCtx.ownerUserId) return null;

    const [company, customerRead, lines] = await Promise.all([
      readCompanyProfileInTx(tx),
      readCustomerSnapshotInTx(tx, orderCtx.ownerUserId, inv),
      tx
        .select()
        .from(complianceInvoiceLines)
        .where(eq(complianceInvoiceLines.invoiceId, inv.id))
        .orderBy(asc(complianceInvoiceLines.position)),
    ]);
    const { live: customerLive, ...customer } = customerRead;
    const isLiveContext = orderCtx.lifecycle === "live" && customerLive;

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
      projectName: orderCtx.projectName,
      company: {
        legalName: inv.issuerNameSnapshot || company.legalName,
        address: inv.issuerAddressSnapshot ?? company.address,
        contact: inv.issuerContactSnapshot ?? company.contact,
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

    const shouldEmail = receiptSettings.emailCustomer && isLiveContext;

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
          orderId: inv.orderId,
          receiptNumber,
          orderReference: orderCtx.orderReference,
          ...(orderCtx.projectName ? { projectName: orderCtx.projectName } : {}),
          pdf: pdfBuffer,
        },
        tx,
      );
    }

    if (isLiveContext) {
      await stageReceiptInStorageInTx(tx, { receiptPublicId, orderPublicId: inv.orderPublicId });
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

    const orderCtx = await readOrderDiscountContextInTx(
      tx,
      inv.orderId,
      inv.orderPublicId,
      inv.discountMinor,
      inv.orderReferenceSnapshot,
    );
    if (!orderCtx.ownerUserId) return null;

    const [company, customerRead, lines] = await Promise.all([
      readCompanyProfileInTx(tx),
      readCustomerSnapshotInTx(tx, orderCtx.ownerUserId, inv),
      tx
        .select()
        .from(complianceInvoiceLines)
        .where(eq(complianceInvoiceLines.invoiceId, inv.id))
        .orderBy(asc(complianceInvoiceLines.position)),
    ]);
    const { live: customerLive, ...customer } = customerRead;
    const isLiveContext = orderCtx.lifecycle === "live" && customerLive;

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
      projectName: orderCtx.projectName,
      company: {
        legalName: inv.issuerNameSnapshot || company.legalName,
        address: inv.issuerAddressSnapshot ?? company.address,
        contact: inv.issuerContactSnapshot ?? company.contact,
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
    const shouldEmail = receiptSettings.emailCustomer && isLiveContext;

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
          orderId: inv.orderId,
          receiptNumber,
          orderReference: orderCtx.orderReference,
          ...(orderCtx.projectName ? { projectName: orderCtx.projectName } : {}),
          pdf: pdfBuffer,
        },
        tx,
      );
    }

    if (isLiveContext) {
      await stageReceiptInStorageInTx(tx, { receiptPublicId, orderPublicId: inv.orderPublicId });
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

    const [company, customer, projectByOrder] = await Promise.all([
      readCompanyProfileInTx(tx),
      readCustomerSnapshotInTx(tx, receipt.customerUserId),
      resolveProjectNamesByOrderIds(tx, [receipt.orderId]),
    ]);

    let receiptProjectName: string | null = null;
    try {
      const parsedOrig = JSON.parse(
        deps.crypto.decrypt(receipt.snapshotEnc, receiptSnapshotAad(receipt.publicId)),
      ) as Partial<ReceiptSnapshot>;
      if (typeof parsedOrig.projectName === "string" && parsedOrig.projectName.trim()) {
        receiptProjectName = parsedOrig.projectName.trim();
      }
    } catch {
      // Preserve refund note issuance even if legacy snapshot omits projectName.
    }
    if (!receiptProjectName) {
      receiptProjectName = projectByOrder.get(receipt.orderId) ?? null;
    }

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
      projectName: receiptProjectName,
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
    projectName: string | null = null,
    orderLifecycleState: OrderLifecycleState = "live",
  ): ReceiptSummaryView {
    return {
      receiptPublicId: row.publicId,
      receiptNumber: row.receiptNumber,
      settlementKind: row.settlementKind,
      invoicePublicId: row.invoicePublicId,
      paymentPublicId: row.paymentPublicId ?? null,
      orderPublicId: row.orderPublicId,
      orderReference: row.orderReference,
      projectName,
      orderLifecycleState,
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
    projectName: string | null = null,
    orderLifecycleState: OrderLifecycleState = "live",
  ): AdminReceiptSummaryView {
    return {
      ...toSummaryView(row, notes, projectName, orderLifecycleState),
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
    const [notesMap, orderMetaMap] = await Promise.all([
      loadNotesMap(
        deps.db,
        pageRows.map((r) => r.id),
      ),
      resolveOrderMetaByOrderIds(
        deps.db,
        pageRows.map((r) => r.orderId),
      ),
    ]);

    return {
      items: pageRows.map((r) => {
        const meta = orderMetaMap.get(r.orderId);
        return toSummaryView(
          r,
          notesMap.get(r.id) ?? [],
          meta?.projectName ?? null,
          meta?.lifecycle ?? "live",
        );
      }),
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

    const [notesMap, orderMetaMap] = await Promise.all([
      loadNotesMap(
        deps.db,
        rows.map((r) => r.id),
      ),
      resolveOrderMetaByOrderIds(deps.db, [orderView.id]),
    ]);
    const meta = orderMetaMap.get(orderView.id);
    return rows.map((r) =>
      toSummaryView(r, notesMap.get(r.id) ?? [], meta?.projectName ?? null, meta?.lifecycle ?? "live"),
    );
  }

  async function get(principal: SessionPrincipal, receiptPublicId: string): Promise<ReceiptDetailView> {
    const [row] = await deps.db
      .select()
      .from(compliancePaymentReceipts)
      .where(eq(compliancePaymentReceipts.publicId, receiptPublicId))
      .limit(1);
    if (!row) throw notFound("RECEIPT_NOT_FOUND");

    const { liveRole } = await assertCanReadReceiptRow(principal, row);
    const [notesMap, orderMetaMap, customerRows] = await Promise.all([
      loadNotesMap(deps.db, [row.id]),
      resolveOrderMetaByOrderIds(deps.db, [row.orderId]),
      deps.db
        .select({ trashedAt: users.trashedAt, purgedAt: users.purgedAt })
        .from(users)
        .where(eq(users.id, row.customerUserId))
        .limit(1),
    ]);
    const rawSnapshot = deps.crypto.decrypt(row.snapshotEnc, receiptSnapshotAad(row.publicId));
    const snapshot = JSON.parse(rawSnapshot) as ReceiptSnapshot;
    const orderMeta = orderMetaMap.get(row.orderId);
    const orderLifecycleState = orderMeta?.lifecycle ?? "live";
    const customerLive = customerRows[0] ? isLiveUserRow(customerRows[0]) : true;

    const resolvedProjectName =
      orderLifecycleState === "deleted"
        ? "Deleted order"
        : ((typeof snapshot.projectName === "string" && snapshot.projectName.trim()
            ? snapshot.projectName.trim()
            : null) ??
          orderMeta?.projectName ??
          null);

    const canResend =
      (liveRole === "staff" || liveRole === "admin") &&
      roleHasCapability(liveRole, "invoices.read_all") &&
      row.origin === "portal" &&
      orderLifecycleState === "live" &&
      customerLive;

    return {
      ...toSummaryView(row, notesMap.get(row.id) ?? [], resolvedProjectName, orderLifecycleState),
      snapshot:
        orderLifecycleState === "deleted"
          ? { ...snapshot, projectName: "Deleted order" }
          : snapshot.projectName === undefined && resolvedProjectName !== null
            ? { ...snapshot, projectName: resolvedProjectName }
            : snapshot,
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

    let orderConfirmed = false;
    try {
      await ordersSvc.assertCanReadOrder(livePrincipal, orderPublicId);
      orderConfirmed = true;
    } catch (err) {
      if (!(err instanceof DomainError && err.code === "NOT_FOUND")) {
        throw err;
      }
      try {
        const [ord] = await deps.db
          .select({ id: orders.id })
          .from(orders)
          .where(eq(orders.publicId, orderPublicId))
          .limit(1);
        if (ord) orderConfirmed = true;
      } catch {
        // Standalone compliance unit tests may omit `orders` rows.
      }
    }

    const rows = await deps.db
      .select()
      .from(compliancePaymentReceipts)
      .where(eq(compliancePaymentReceipts.orderPublicId, orderPublicId))
      .orderBy(desc(compliancePaymentReceipts.issuedAt), desc(compliancePaymentReceipts.id));

    if (!orderConfirmed && rows.length === 0) {
      throw notFound("ORDER_NOT_FOUND");
    }

    const [notesMap, orderMetaMap] = await Promise.all([
      loadNotesMap(
        deps.db,
        rows.map((r) => r.id),
      ),
      resolveOrderMetaByOrderIds(
        deps.db,
        rows.map((r) => r.orderId),
      ),
    ]);
    return rows.map((r) => {
      const meta = orderMetaMap.get(r.orderId);
      return toAdminSummaryView(
        r,
        notesMap.get(r.id) ?? [],
        meta?.projectName ?? null,
        meta?.lifecycle ?? "live",
      );
    });
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
    const [notesMap, orderMetaMap] = await Promise.all([
      loadNotesMap(
        deps.db,
        pageRows.map((r) => r.id),
      ),
      resolveOrderMetaByOrderIds(
        deps.db,
        pageRows.map((r) => r.orderId),
      ),
    ]);

    return {
      items: pageRows.map((r) => {
        const meta = orderMetaMap.get(r.orderId);
        return toAdminSummaryView(
          r,
          notesMap.get(r.id) ?? [],
          meta?.projectName ?? null,
          meta?.lifecycle ?? "live",
        );
      }),
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

        const orderMetaMap = await resolveOrderMetaByOrderIds(tx, [row.orderId]);
        const orderLifecycle = orderMetaMap.get(row.orderId)?.lifecycle ?? "live";
        if (orderLifecycle !== "live") {
          throw new DomainError(
            "CONFLICT",
            "ORDER_NOT_LIVE",
            "Receipts cannot be emailed while the order is in trash or permanently deleted.",
          );
        }

        const [customerRow] = await tx
          .select({ trashedAt: users.trashedAt, purgedAt: users.purgedAt })
          .from(users)
          .where(eq(users.id, row.customerUserId))
          .limit(1);
        if (customerRow && !isLiveUserRow(customerRow)) {
          throw new DomainError(
            "CONFLICT",
            "CUSTOMER_NOT_LIVE",
            "Receipts cannot be emailed while the customer account is in trash or permanently deleted.",
          );
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

        let resendProjectName: string | null = null;
        try {
          const parsedSnap = JSON.parse(
            deps.crypto.decrypt(row.snapshotEnc, receiptSnapshotAad(row.publicId)),
          ) as Partial<ReceiptSnapshot>;
          if (typeof parsedSnap.projectName === "string" && parsedSnap.projectName.trim()) {
            resendProjectName = parsedSnap.projectName.trim();
          }
        } catch {
          // Fall back to live order lookup when resending pre-07.2 receipts.
        }
        if (!resendProjectName) {
          const projectMap = await resolveProjectNamesByOrderIds(tx, [row.orderId]);
          resendProjectName = projectMap.get(row.orderId) ?? null;
        }

        const mailRes = await enqueuePaymentReceipt(
          deps.mailer,
          {
            receiptPublicId: row.publicId,
            recipientUserId: row.customerUserId,
            orderId: row.orderId,
            receiptNumber: row.receiptNumber,
            orderReference: row.orderReference,
            ...(resendProjectName ? { projectName: resendProjectName } : {}),
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

  async function stageReceiptInStorageInTx(
    tx: Tx,
    input: { receiptPublicId: string; orderPublicId: string },
  ): Promise<void> {
    const storageConnectionsSvc = (
      deps.services as unknown as {
        storageConnections?: {
          stageReceiptPdf?: (
            arg: { receiptPublicId: string; orderPublicId: string },
            txArg: Tx,
          ) => Promise<void>;
        };
      }
    ).storageConnections;
    if (storageConnectionsSvc && typeof storageConnectionsSvc.stageReceiptPdf === "function") {
      await storageConnectionsSvc.stageReceiptPdf(input, tx);
    }
  }

  /**
   * Internal port for `storageConnections` managed file sync (Decision D12).
   * Decrypts and returns the immutable receipt PDF bytes iff the receipt belongs to `orderPublicId`
   * and was issued by this portal (`origin === "portal"`).
   */
  async function getFileSyncPdf(
    input: { receiptPublicId: string; orderPublicId: string },
    tx: Tx,
  ): Promise<Buffer | null> {
    const [row] = await tx
      .select({
        publicId: compliancePaymentReceipts.publicId,
        orderPublicId: compliancePaymentReceipts.orderPublicId,
        origin: compliancePaymentReceipts.origin,
        pdfEnc: compliancePaymentReceipts.pdfEnc,
      })
      .from(compliancePaymentReceipts)
      .where(eq(compliancePaymentReceipts.publicId, input.receiptPublicId))
      .limit(1);
    if (!row || row.origin !== "portal" || row.orderPublicId !== input.orderPublicId || !row.pdfEnc) {
      return null;
    }
    const base64 = deps.crypto.decrypt(row.pdfEnc, receiptPdfAad(row.publicId));
    return Buffer.from(base64, "base64");
  }

  async function findLatestReceiptPublicIdForInvoice(
    dbOrTx: DbOrTx,
    invoiceId: number,
    options?: { currentRead?: boolean },
  ): Promise<string | null> {
    const baseQuery = dbOrTx
      .select({ publicId: compliancePaymentReceipts.publicId })
      .from(compliancePaymentReceipts)
      .where(eq(compliancePaymentReceipts.invoiceId, invoiceId))
      .orderBy(desc(compliancePaymentReceipts.id))
      .limit(1);
    const [latest] = options?.currentRead ? await baseQuery.for("update") : await baseQuery;
    return latest?.publicId ?? null;
  }

  return {
    issueReceiptForPaymentInTx,
    issueReceiptForZeroInvoiceInTx,
    onPaymentRefundedInTx,
    findLatestReceiptPublicIdForInvoice,
    getFileSyncPdf,
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
