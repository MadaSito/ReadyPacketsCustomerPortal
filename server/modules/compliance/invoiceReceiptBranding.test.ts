import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDeps, fakePrincipal } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { DomainError, forbidden, notFound } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { DbOrTx, SessionPrincipal } from "../../core/types.js";
import { users } from "../identity/schema.js";
import { enqueuePaymentReceipt } from "../jobs/receiptMail.js";
import { buildSystemTemplateMetadata } from "../mailTemplates/systemCatalogue.js";
import type { OrderAccessRole, OrderAccessView, OrderLockState, OrdersModule } from "../orders/index.js";
import { orders as ordersTable } from "../orders/schema.js";
import { createComplianceModule } from "./index.js";
import {
  decodePdfLiteralText,
  PDF_BRAND_LEGAL_NAME,
  PDF_BRAND_PORTAL_HOST,
  PDF_BRAND_SHORT_NAME,
  PDF_BRAND_TAGLINE,
  PDF_LOGO_ALT_TEXT,
  type ReceiptSnapshot,
  type RefundNoteSnapshot,
  renderInvoicePdf,
  renderPaymentReceiptPdf,
  renderRefundNotePdf,
  sanitizePdfTextToWinAnsi,
} from "./invoicePdf.js";
import { complianceRouter } from "./router.js";
import * as complianceSchema from "./schema.js";
import { DEFAULT_ISSUER_LOGO_SETTING, INVOICE_ISSUER_NAME } from "./settings.js";

function extractDecodedPdfText(pdf: Buffer): string {
  return decodePdfLiteralText(pdf);
}

function extractTextDrawsWithCoords(pdf: Buffer): { x: number; y: number; text: string }[] {
  const raw = pdf.toString("latin1");
  const out: { x: number; y: number; text: string }[] = [];
  const re = /([0-9]+(?:\.[0-9]+)?)\s+([0-9]+(?:\.[0-9]+)?)\s+Td\s*\(((?:\\.|[^\\()])*)\)\s*Tj/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    out.push({
      x: Number(m[1]),
      y: Number(m[2]),
      text: decodePdfLiteralText(Buffer.from(`(${m[3]!}) Tj`, "latin1")),
    });
  }
  return out;
}

interface FakeOrderRecord {
  id: number;
  publicId: string;
  reference: string;
  projectName: string;
  ownerUserId: number;
  ownerPublicId: string;
  lockState: OrderLockState;
  origin: "portal" | "import";
}

function buildOrdersModuleForBrandingTests(
  ordersByPubId: Map<string, FakeOrderRecord>,
): OrdersModule {
  const byId = () => {
    const m = new Map<number, FakeOrderRecord>();
    for (const o of ordersByPubId.values()) m.set(o.id, o);
    return m;
  };

  function resolveRole(principal: SessionPrincipal, order: FakeOrderRecord): OrderAccessRole | null {
    if (principal.role === "admin") return "admin";
    if (principal.role === "staff") return "staff";
    if (order.ownerUserId === principal.userId) return "owner";
    return null;
  };

  function toAccessView(order: FakeOrderRecord, role: OrderAccessRole): OrderAccessView {
    return {
      id: order.id,
      publicId: order.publicId,
      reference: order.reference,
      ownerUserId: order.ownerUserId,
      ownerPublicId: order.ownerPublicId,
      statusKey: "in_progress",
      lockState: order.lockState,
      locked: order.lockState !== "none",
      readOnlyImported: order.origin === "import" || order.lockState === "imported_read_only",
      accessRole: role,
      canWrite: order.lockState === "none" && order.origin === "portal",
      origin: order.origin,
      version: 1,
      workflowVersionId: 1,
    };
  }

  async function assertCanReadOrder(
    principal: SessionPrincipal,
    orderPublicId: string,
  ): Promise<OrderAccessView> {
    if (principal.state !== "full" || principal.pendingSteps.length > 0) {
      throw notFound("ORDER_NOT_FOUND");
    }
    const order = ordersByPubId.get(orderPublicId);
    if (!order) throw notFound("ORDER_NOT_FOUND");
    const role = resolveRole(principal, order);
    if (!role) throw notFound("ORDER_NOT_FOUND");
    return toAccessView(order, role);
  }

  return {
    assertCanReadOrder,
    async assertCanWriteOrder(
      principal: SessionPrincipal,
      orderPublicId: string,
      options: { kind?: string; tx?: DbOrTx; forUpdate?: boolean },
    ) {
      const view = await assertCanReadOrder(principal, orderPublicId);
      const order = ordersByPubId.get(orderPublicId)!;
      if (options.kind === "invoice") {
        if (view.accessRole !== "staff" && view.accessRole !== "admin") {
          throw notFound("ORDER_NOT_FOUND");
        }
        if (order.lockState === "legal_hold" || order.origin === "import") {
          throw new DomainError("LOCKED", "ORDER_LOCKED", "Order is locked.");
        }
        return view;
      }
      if (view.accessRole === "viewer") throw forbidden("READ_ONLY_GRANT");
      return view;
    },
    async listAccessibleOrderIds(principal: SessionPrincipal) {
      if (principal.role === "admin" || principal.role === "staff") return { all: true };
      const ids = Array.from(ordersByPubId.values())
        .filter((o) => o.ownerUserId === principal.userId)
        .map((o) => o.id);
      return { all: false, orderIds: ids, truncated: false };
    },
    async getOrderRefById(orderId: number) {
      const o = byId().get(orderId);
      if (!o) return null;
      return {
        id: o.id,
        publicId: o.publicId,
        reference: o.reference,
        name: o.projectName,
        ownerUserId: o.ownerUserId,
        lockState: o.lockState,
        statusKey: "in_progress",
        workflowVersionId: 1,
      };
    },
    async getOrderRefByPublicId(orderPublicId: string) {
      const o = ordersByPubId.get(orderPublicId);
      if (!o) return null;
      return {
        id: o.id,
        publicId: o.publicId,
        reference: o.reference,
        name: o.projectName,
        ownerUserId: o.ownerUserId,
        lockState: o.lockState,
        statusKey: "in_progress",
        workflowVersionId: 1,
      };
    },
    workflows: {
      async byVersionId() {
        return {
          id: 1,
          workflowId: 1,
          workflowKey: "standard",
          versionNumber: 1,
          definition: {
            initialStateKey: "in_progress",
            states: [{ key: "in_progress", label: "In Progress", kind: "active", tone: "info" }],
            transitions: [],
          },
        };
      },
    },
    gates: {
      async assertCustomerMayWork() {},
    },
  } as unknown as OrdersModule;
}

describe("Fix Pack 07.2 — branded invoice, receipt & refund-note PDFs, Order/Project prominence, WinAnsi encoding & immutability", () => {
  it("renders out-of-the-box branded Invoice, Payment Receipt, and Refund Note PDFs with embedded logo XObject, Order & Project block, accessibility tags, and footer", () => {
    expect(INVOICE_ISSUER_NAME.default).toBe(PDF_BRAND_LEGAL_NAME);
    expect(DEFAULT_ISSUER_LOGO_SETTING).toEqual({
      mode: "brand",
      brandPath: "/brand/readypackets-approved-header-icon-light.png",
    });

    const issuedAt = new Date("2026-11-25T15:00:00.000Z");
    const dueAt = new Date("2026-12-09T15:00:00.000Z");

    const invoicePdf = renderInvoicePdf({
      invoicePublicId: "01JBRANDTESTINVOICE0000001",
      invoiceNumber: "RP-INV-2026-000101",
      status: "issued",
      orderReference: "RP-2026-000412",
      projectName: "Northwind Series A Incorporation Packet",
      // Even when legacy snapshot stored "ReadyPackets", out-of-the-box legal name upgrades cleanly:
      issuerName: "ReadyPackets",
      issuerAddress: "1200 Market Street, Suite 400\nWilmington, DE 19801",
      issuerContact: "billing@example.test",
      issuerTaxId: "EIN 99-0000000",
      customerName: "Synthetic Buyer Co.",
      customerEmail: "buyer@example.test",
      customerRef: "CUST-2026-009",
      currency: "USD",
      issuedAt,
      dueAt,
      voidedAt: null,
      voidReason: null,
      memo: "Bundle: Delaware C-Corp · Promo: LAUNCH10 (10% off)",
      paymentInstructions: "Pay online in your order workspace or remit via ACH.",
      lines: [
        {
          position: 1,
          description: "Delaware C-Corp Formation & Board Consent Packet",
          quantity: 1,
          unitAmountMinor: 50_000,
          lineTotalMinor: 50_000,
        },
      ],
      subtotalMinor: 50_000,
      discountMinor: 5_000,
      bundleDiscountMinor: 0,
      promoDiscountMinor: 5_000,
      promoLabel: "LAUNCH10 (10% off)",
      taxMinor: 0,
      totalMinor: 45_000,
      grossPaidMinor: 0,
      refundedMinor: 0,
      netPaidMinor: 0,
      balanceDueMinor: 45_000,
      payments: [],
      refunds: [],
    });

    const receiptSnapshot: ReceiptSnapshot = {
      schemaVersion: 1,
      receiptPublicId: "01JBRANDTESTRECEIPT0000001",
      receiptNumber: "RPR-2026-000101",
      settlementKind: "provider_online",
      issuedAt: issuedAt.toISOString(),
      orderPublicId: "01JBRANDTESTORDER000000001",
      orderReference: "RP-2026-000412",
      projectName: "Northwind Series A Incorporation Packet",
      invoicePublicId: "01JBRANDTESTINVOICE0000001",
      invoiceNumber: "RP-INV-2026-000101",
      paymentPublicId: "01JBRANDTESTPAYMENT0000001",
      company: {
        legalName: PDF_BRAND_LEGAL_NAME,
        address: "1200 Market Street, Suite 400\nWilmington, DE 19801",
        contact: "billing@example.test",
        taxId: "EIN 99-0000000",
        logoMode: "brand",
        logoBrandPath: DEFAULT_ISSUER_LOGO_SETTING.brandPath,
      },
      customer: {
        name: "Synthetic Buyer Co.",
        email: "buyer@example.test",
        customerRef: "CUST-2026-009",
      },
      currency: "USD",
      lines: [
        {
          position: 1,
          description: "Delaware C-Corp Formation & Board Consent Packet",
          quantity: 1,
          unitAmountMinor: 50_000,
          lineTotalMinor: 50_000,
        },
      ],
      subtotalMinor: 50_000,
      discountMinor: 5_000,
      bundleDiscountMinor: 0,
      discountLabel: null,
      promoDiscountMinor: 5_000,
      promoLabel: "LAUNCH10 (10% off)",
      taxMinor: 0,
      amountWaivedMinor: 0,
      amountPaidMinor: 45_000,
      paymentMethod: "provider_online",
      paymentMethodBrand: "visa",
      paymentMethodLast4: "4242",
      provider: "stripe",
      providerReference: "pi_fake_test_0001",
      footerText: "Retain this official receipt for your corporate records.",
    };
    const receiptPdf = renderPaymentReceiptPdf(receiptSnapshot);

    const refundNoteSnapshot: RefundNoteSnapshot = {
      schemaVersion: 1,
      notePublicId: "01JBRANDTESTREFNOTE0000001",
      noteNumber: "RPRN-2026-000101",
      issuedAt: issuedAt.toISOString(),
      receiptPublicId: receiptSnapshot.receiptPublicId,
      receiptNumber: receiptSnapshot.receiptNumber,
      invoicePublicId: receiptSnapshot.invoicePublicId,
      orderPublicId: receiptSnapshot.orderPublicId,
      orderReference: receiptSnapshot.orderReference,
      projectName: receiptSnapshot.projectName,
      invoiceNumber: receiptSnapshot.invoiceNumber,
      refundPublicId: "01JBRANDTESTREFUND00000001",
      company: {
        legalName: PDF_BRAND_LEGAL_NAME,
        address: "1200 Market Street, Suite 400\nWilmington, DE 19801",
        contact: "billing@example.test",
        taxId: "EIN 99-0000000",
        logoMode: "brand",
        logoBrandPath: DEFAULT_ISSUER_LOGO_SETTING.brandPath,
      },
      customer: {
        name: "Synthetic Buyer Co.",
        email: "buyer@example.test",
        customerRef: "CUST-2026-009",
      },
      currency: "USD",
      originalAmountPaidMinor: 45_000,
      refundAmountMinor: 10_000,
      cumulativeRefundedMinor: 10_000,
      resultingRefundState: "partially_refunded",
      reasonCode: "ADJUSTMENT",
      reference: "re_fake_test_0001",
    };
    const refundNotePdf = renderRefundNotePdf(refundNoteSnapshot);

    for (const [label, pdf, expectedHeading] of [
      ["invoice", invoicePdf, "INVOICE"],
      ["receipt", receiptPdf, "PAYMENT RECEIPT"],
      ["refundNote", refundNotePdf, "REFUND NOTE"],
    ] as const) {
      const raw = pdf.toString("latin1");
      const decoded = extractDecodedPdfText(pdf);

      expect(raw.startsWith("%PDF-1.4\n"), `${label} header`).toBe(true);
      expect(raw, `${label} image XObject`).toContain("/Subtype /Image");
      expect(raw, `${label} ImLogo resource`).toContain("/XObject << /ImLogo");
      expect(raw, `${label} ImLogo draw`).toContain("/ImLogo Do");

      // Accessibility & metadata checks (honest tagged figure + language + DisplayDocTitle + tab order)
      expect(raw, `${label} /Lang (en)`).toContain("/Lang (en)");
      expect(raw, `${label} DisplayDocTitle`).toContain("/ViewerPreferences << /DisplayDocTitle true >>");
      expect(raw, `${label} StructTreeRoot`).toContain("/StructTreeRoot");
      expect(raw, `${label} Figure Alt`).toContain(`/Alt (${PDF_LOGO_ALT_TEXT})`);
      expect(raw, `${label} page tab order`).toContain("/Tabs /S");

      // Brand identity + Order & Project prominence + portal footer
      expect(decoded, `${label} heading`).toContain(expectedHeading);
      expect(decoded, `${label} short brand`).toContain(PDF_BRAND_SHORT_NAME);
      expect(decoded, `${label} tagline`).toContain(PDF_BRAND_TAGLINE);
      expect(decoded, `${label} legal name`).toContain(PDF_BRAND_LEGAL_NAME);
      expect(decoded, `${label} Order label`).toContain("Order");
      expect(decoded, `${label} order ref`).toContain("RP-2026-000412");
      expect(decoded, `${label} Project label`).toContain("Project");
      expect(decoded, `${label} project name`).toContain("Northwind Series A Incorporation Packet");
      expect(decoded, `${label} footer host`).toContain(PDF_BRAND_PORTAL_HOST);
      expect(decoded, `${label} page numbering`).toContain("Page 1 of 1");
      expect(decoded, `${label} zero question marks`).not.toContain("?");
    }

    // Verify production container fallback (`dist/public/brand/...` when `client/public` is absent)
    const tmpStaticDir = mkdtempSync(path.join(os.tmpdir(), "rp-static-brand-"));
    try {
      mkdirSync(path.join(tmpStaticDir, "brand"), { recursive: true });
      copyFileSync(
        path.resolve(process.cwd(), "client/public/brand/readypackets-approved-header-icon-light.png"),
        path.join(tmpStaticDir, "brand/readypackets-approved-header-icon-light.png"),
      );
      const prodContainerPdf = renderInvoicePdf(
        {
          invoicePublicId: "01JBRANDTESTINVOICE0000002",
          invoiceNumber: "RP-INV-2026-000102",
          status: "paid",
          orderReference: "RP-2026-000413",
          projectName: "Container Runtime Logo Test",
          issuerName: "Custom Legal Holdings LLC",
          issuerAddress: "1 Main St",
          customerName: "Buyer",
          customerEmail: "buyer@example.test",
          currency: "USD",
          issuedAt,
          dueAt: null,
          voidedAt: null,
          voidReason: null,
          memo: null,
          paymentInstructions: "",
          lines: [{ position: 1, description: "Packet", quantity: 1, unitAmountMinor: 1000, lineTotalMinor: 1000 }],
          subtotalMinor: 1000,
          discountMinor: 0,
          taxMinor: 0,
          totalMinor: 1000,
          grossPaidMinor: 1000,
          refundedMinor: 0,
          netPaidMinor: 1000,
          balanceDueMinor: 0,
          payments: [],
          refunds: [],
        },
        { staticDir: tmpStaticDir },
      );
      expect(prodContainerPdf.toString("latin1")).toContain("/Subtype /Image");
      // Custom admin issuerName is preserved verbatim alongside ReadyPackets brand mark:
      expect(extractDecodedPdfText(prodContainerPdf)).toContain("Custom Legal Holdings LLC");
    } finally {
      rmSync(tmpStaticDir, { recursive: true, force: true });
    }
  });

  it("encodes WinAnsi punctuation & accented Latin and transliterates arrows/Extended-A without ever emitting '?'", () => {
    const richSample =
      "Bundle: Corporate · Starter • Tier 1 – Standard — Enterprise ‘Single’ “Double” ™ ® © € → ← ↔ ⇒ ✓ María Elena García-López / François Côté / Łukasz Żółć — Český Krumlov";
    const sanitized = sanitizePdfTextToWinAnsi(richSample);
    expect(sanitized).not.toContain("?");
    expect(sanitized).toContain("·");
    expect(sanitized).toContain("•");
    expect(sanitized).toContain("–");
    expect(sanitized).toContain("—");
    expect(sanitized).toContain("™");
    expect(sanitized).toContain("->");
    expect(sanitized).toContain("<-");
    expect(sanitized).toContain("<->");
    expect(sanitized).toContain("=>");
    expect(sanitized).toContain("María Elena García-López");
    expect(sanitized).toContain("François Côté");
    expect(sanitized).toContain("Lukasz Zólc");
    expect(sanitized).toContain("Ceský Krumlov");

    // Preserve an intentional literal question mark in user text while never introducing synthetic '?'
    expect(sanitizePdfTextToWinAnsi("Need rush filing?")).toBe("Need rush filing?");

    const pdf = renderInvoicePdf({
      invoicePublicId: "01JBRANDTESTUNICODE0000001",
      invoiceNumber: "RP-INV-2026-000201",
      status: "issued",
      orderReference: "RP-2026-000777",
      projectName: "Łukasz Żółć — Český Krumlov → Kraków Expansion™",
      issuerName: PDF_BRAND_LEGAL_NAME,
      issuerAddress: "500 Fifth Avenue · Suite 1200 — New York, NY",
      customerName: "María Elena García-López & François Côté",
      customerEmail: "maria.garcia@example.test",
      currency: "EUR",
      issuedAt: new Date("2026-11-25T15:00:00.000Z"),
      dueAt: new Date("2026-12-10T15:00:00.000Z"),
      voidedAt: null,
      voidReason: null,
      memo: "Bundle: EU Launch · Promo: FALL25 • Priority review — Phase 1 → Phase 2 “Approved” ™",
      paymentInstructions: "SEPA wire — include reference ‘RP-INV-2026-000201’ • EUR account",
      lines: [
        {
          position: 1,
          description: "Cross-border NDA • Master Service Agreement — ‘Gold’ Tier™ → €450",
          quantity: 1,
          unitAmountMinor: 45_000,
          lineTotalMinor: 45_000,
        },
      ],
      subtotalMinor: 45_000,
      discountMinor: 0,
      taxMinor: 0,
      totalMinor: 45_000,
      grossPaidMinor: 0,
      refundedMinor: 0,
      netPaidMinor: 0,
      balanceDueMinor: 45_000,
      payments: [],
      refunds: [],
    });

    const decoded = extractDecodedPdfText(pdf);
    expect(decoded).not.toContain("?");
    expect(decoded).toContain("María Elena García-López & François Côté");
    expect(decoded).toContain("Lukasz Zólc — Ceský Krumlov -> Kraków Expansion™");
    expect(decoded).toContain("Bundle: EU Launch · Promo: FALL25 • Priority review");
  });

  it("wraps long project names and unbroken tokens cleanly inside page margins on both Letter and A4", () => {
    const longSpacedProject =
      "Global Multi-Jurisdiction Subsidiary Governance Restructuring Compliance Readiness & Executive Board Packet Initiative 2026 Phase Two";
    const longUnbrokenProject =
      "PRJ_2026_ENTERPRISE_CONSOLIDATED_HOLDINGS_SUBSIDIARY_GOVERNANCE_AND_REGULATORY_PACKET_SERIES_B_000987654321";

    for (const [pageSize, expectedMediaBox, minX, maxRightX] of [
      ["LETTER", "/MediaBox [0 0 612 792]", 48, 564],
      ["A4", "/MediaBox [0 0 595.28 841.89]", 48, 547.28],
    ] as const) {
      for (const projectName of [longSpacedProject, longUnbrokenProject]) {
        const pdf = renderInvoicePdf({
          invoicePublicId: "01JBRANDTESTWRAP0000000001",
          invoiceNumber: "RP-INV-2026-000301",
          status: "issued",
          orderReference: "RP-2026-000888",
          projectName,
          pageSize,
          issuerName: PDF_BRAND_LEGAL_NAME,
          issuerAddress: "1200 Market Street, Suite 400, Wilmington, DE 19801",
          customerName: "Synthetic Wrapping Client LLC",
          customerEmail: "wrap@example.test",
          currency: "USD",
          issuedAt: new Date("2026-11-25T15:00:00.000Z"),
          dueAt: new Date("2026-12-25T15:00:00.000Z"),
          voidedAt: null,
          voidReason: null,
          memo: null,
          paymentInstructions: "Remit via portal checkout.",
          lines: [
            {
              position: 1,
              description:
                "LINE_ITEM_WITH_EXTREMELY_LONG_UNBROKEN_SKU_IDENTIFIER_RP_PACKET_ENTERPRISE_2026_Q4_GOVERNANCE_BUNDLE_V3 and detailed scope narrative across multiple wrapped lines",
              quantity: 2,
              unitAmountMinor: 25_000,
              lineTotalMinor: 50_000,
            },
          ],
          subtotalMinor: 50_000,
          discountMinor: 0,
          taxMinor: 0,
          totalMinor: 50_000,
          grossPaidMinor: 0,
          refundedMinor: 0,
          netPaidMinor: 0,
          balanceDueMinor: 50_000,
          payments: [],
          refunds: [],
        });

        expect(pdf.toString("latin1")).toContain(expectedMediaBox);
        const draws = extractTextDrawsWithCoords(pdf);
        expect(draws.length).toBeGreaterThan(10);
        for (const d of draws) {
          expect(d.x, `${pageSize} x>=${minX} for "${d.text}"`).toBeGreaterThanOrEqual(minX);
          expect(d.x, `${pageSize} x<=${maxRightX} for "${d.text}"`).toBeLessThanOrEqual(maxRightX);
          // Estimate rendered width ceiling (~5.2pt/char at <=10pt) for wrapped project/description lines
          if (d.x <= 240 && d.text.length > 0) {
            expect(d.text.length, `${pageSize} wrapped line length "${d.text}"`).toBeLessThanOrEqual(92);
          }
        }
      }
    }
  });

  describe("service, mail & immutability integration", () => {
    let tdb: TestDb;
    let adminPrincipal: SessionPrincipal;
    let customerPrincipal: SessionPrincipal;
    let orderRec: FakeOrderRecord;
    const ordersMap = new Map<string, FakeOrderRecord>();

    beforeAll(async () => {
      tdb = await createTestDb({
        schema: {
          users,
          orders: ordersTable,
          ...complianceSchema,
        },
      });
      const now = new Date("2026-11-25T15:00:00.000Z");
      const adminPubId = ulid(now.getTime() + 10);
      const custPubId = ulid(now.getTime() + 20);

      const [adminIns] = await tdb.db.insert(users).values({
        publicId: adminPubId,
        emailEnc: "enc:admin-brand@example.test",
        emailIndex: "1".padStart(64, "b"),
        nameEnc: "enc:Admin Reviewer",
        role: "admin",
        status: "active",
        emailVerifiedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      const [custIns] = await tdb.db.insert(users).values({
        publicId: custPubId,
        emailEnc: "enc:maria.buyer@example.test",
        emailIndex: "2".padStart(64, "b"),
        nameEnc: "enc:María Elena García-López",
        role: "customer",
        status: "active",
        emailVerifiedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      adminPrincipal = fakePrincipal({
        userId: adminIns.insertId,
        userPublicId: adminPubId,
        role: "admin",
        stepUpAt: now,
      });
      customerPrincipal = fakePrincipal({
        userId: custIns.insertId,
        userPublicId: custPubId,
        role: "customer",
      });

      orderRec = {
        id: 9101,
        publicId: ulid(now.getTime() + 500),
        reference: "RP-2026-009101",
        projectName: "Horizon FinTech SOC2 & Vendor Packet",
        ownerUserId: customerPrincipal.userId,
        ownerPublicId: customerPrincipal.userPublicId,
        lockState: "none",
        origin: "portal",
      };
      ordersMap.set(orderRec.publicId, orderRec);
    }, 60_000);

    afterAll(async () => {
      if (tdb) await tdb.cleanup();
    });

    it("propagates Order & Project across invoice/receipt views, emails, on-demand invoice PDFs, and preserves pre-existing encrypted receipt PDFs unchanged", async () => {
      const h = createTestDeps({ db: tdb.db });
      h.services.orders = buildOrdersModuleForBrandingTests(ordersMap);
      h.services.identity = {
        async getUser(userId: number) {
          if (userId === customerPrincipal.userId) {
            return {
              id: customerPrincipal.userId,
              publicId: customerPrincipal.userPublicId,
              email: "maria.buyer@example.test",
              name: "María Elena García-López",
              role: "customer" as const,
              status: "active" as const,
            };
          }
          return {
            id: adminPrincipal.userId,
            userPublicId: adminPrincipal.userPublicId,
            publicId: adminPrincipal.userPublicId,
            email: "admin-brand@example.test",
            name: "Admin Reviewer",
            role: "admin" as const,
            status: "active" as const,
          };
        },
      } as unknown as typeof h.services.identity;
      h.services.engagement = {
        async notify() {
          return { delivered: true };
        },
      } as unknown as typeof h.services.engagement;

      const mod = createComplianceModule(h.deps);
      h.services.compliance = mod;
      const steppedUpAdmin = { ...adminPrincipal, stepUpAt: h.clock.now() };
      const caller = (principal: SessionPrincipal) =>
        complianceRouter.createCaller({
          services: h.services,
          session: principal,
          request: newRequestContext("http"),
          transport: "cookie" as const,
        } as never);

      // 1. Issue invoice and verify Order & Project in views, email vars/templates, and on-demand PDF
      const draft = await caller(steppedUpAdmin).invoices.admin.createDraft({
        orderPublicId: orderRec.publicId,
        currency: "USD",
        memo: "Bundle: FinTech Launch · Priority review — Q4",
        lines: [
          {
            description: "SOC2 Policy & Vendor Security Packet",
            quantity: 1,
            unitAmountMinor: 35_000,
          },
        ],
        discountMinor: 0,
        taxMinor: 0,
      });
      await caller(steppedUpAdmin).invoices.admin.issue({
        invoicePublicId: draft.invoicePublicId,
      });

      const issuedMail = h.mailer.last("compliance.invoice_issued");
      expect(issuedMail?.vars).toMatchObject({
        orderReference: "RP-2026-009101",
        projectName: "Horizon FinTech SOC2 & Vendor Packet",
      });
      const issuedRegistered = h.mailer.templates.get("compliance.invoice_issued")!;
      expect(issuedRegistered.text(issuedMail!.vars)).toContain("Order: RP-2026-009101");
      expect(issuedRegistered.text(issuedMail!.vars)).toContain(
        "Project: Horizon FinTech SOC2 & Vendor Packet",
      );
      for (const tplKey of [
        "compliance.invoice_issued",
        "compliance.invoice_paid",
      ] as const) {
        const builtinTpl = h.mailer.templates.get(tplKey)!;
        expect(builtinTpl, `${tplKey} registered`).toBeDefined();
        const sysTpl = buildSystemTemplateMetadata(builtinTpl);
        expect(sysTpl.defaultBodyText, `${tplKey} text Order`).toContain("Order:");
        expect(sysTpl.defaultBodyText, `${tplKey} text Project`).toContain("Project:");
        expect(sysTpl.defaultBodyHtml, `${tplKey} html Order`).toContain("Order:");
        expect(sysTpl.defaultBodyHtml, `${tplKey} html Project`).toContain("Project:");
      }
      const receiptBuiltinTpl = h.mailer.templates.get("payment_receipt")!;
      const renderedReceiptText = receiptBuiltinTpl.text({
        receiptNumber: "RPR-2026-000001",
        orderReference: "RP-2026-009101",
        projectName: "Horizon FinTech SOC2 & Vendor Packet",
      });
      expect(renderedReceiptText).toContain("Order: RP-2026-009101");
      expect(renderedReceiptText).toContain("Project: Horizon FinTech SOC2 & Vendor Packet");

      const custList = await caller(customerPrincipal).invoices.listMine({ limit: 10 });
      expect(custList.items[0]).toMatchObject({
        orderReference: "RP-2026-009101",
        projectName: "Horizon FinTech SOC2 & Vendor Packet",
      });

      const custDetail = await caller(customerPrincipal).invoices.get({
        invoicePublicId: draft.invoicePublicId,
      });
      expect(custDetail.orderReference).toBe("RP-2026-009101");
      expect(custDetail.projectName).toBe("Horizon FinTech SOC2 & Vendor Packet");

      const adminList = await caller(adminPrincipal).invoices.admin.list({ limit: 10 });
      expect(adminList.items[0]).toMatchObject({
        orderReference: "RP-2026-009101",
        projectName: "Horizon FinTech SOC2 & Vendor Packet",
      });

      // On-demand invoice PDF picks up updated project name automatically without mutating invoice rows:
      orderRec.projectName = "Horizon FinTech Series A Security Packet";
      const onDemandPdf = await mod.invoices.downloadPdf(customerPrincipal, draft.invoicePublicId);
      const onDemandText = extractDecodedPdfText(onDemandPdf.buffer);
      expect(onDemandPdf.buffer.toString("latin1")).toContain("/Subtype /Image");
      expect(onDemandText).toContain("RP-2026-009101");
      expect(onDemandText).toContain("Horizon FinTech Series A Security Packet");
      expect(onDemandText).toContain("Bundle: FinTech Launch · Priority review — Q4");
      expect(onDemandText).not.toContain("?");

      // 2. Record manual payment -> issues branded receipt PDF & enqueues `compliance.invoice_paid` + `payment_receipt` with Order & Project
      await caller(steppedUpAdmin).invoices.admin.recordManualPayment({
        invoicePublicId: draft.invoicePublicId,
        method: "wire",
        amountMinor: 35_000,
        currency: "USD",
        reference: "WIRE-BRAND-001",
        idempotencyKey: "idem-brand-wire-001",
      });

      const paidMail = h.mailer.last("compliance.invoice_paid");
      expect(paidMail?.vars).toMatchObject({
        orderReference: "RP-2026-009101",
        projectName: "Horizon FinTech Series A Security Packet",
      });
      const receiptMail = h.mailer.last("payment_receipt");
      expect(receiptMail?.vars).toMatchObject({
        orderReference: "RP-2026-009101",
        projectName: "Horizon FinTech Series A Security Packet",
      });

      const myReceipts = await caller(customerPrincipal).receipts.myList({ limit: 10 });
      expect(myReceipts.items[0]).toMatchObject({
        orderReference: "RP-2026-009101",
        projectName: "Horizon FinTech Series A Security Packet",
      });
      const receiptId = myReceipts.items[0]!.receiptPublicId;
      const receiptDetail = await caller(customerPrincipal).receipts.get({ receiptPublicId: receiptId });
      expect(receiptDetail.projectName).toBe("Horizon FinTech Series A Security Packet");
      expect(receiptDetail.snapshot.projectName).toBe("Horizon FinTech Series A Security Packet");

      const newReceiptPdf = await mod.receipts.downloadReceiptPdf(customerPrincipal, receiptId);
      expect(newReceiptPdf.buffer.toString("latin1")).toContain("/Subtype /Image");
      expect(extractDecodedPdfText(newReceiptPdf.buffer)).toContain(
        "Horizon FinTech Series A Security Packet",
      );

      // 3. Immutability guarantee for pre-existing encrypted receipts issued before 07.2:
      //    Insert a legacy encrypted receipt row whose stored PDF bytes had NO new branding and NO snapshot.projectName.
      const legacyReceiptPubId = ulid(Date.now() + 9000);
      const legacyPdfBytes = Buffer.from("%PDF-1.4\n%legacy-pre-07-2-receipt-bytes\n%%EOF\n", "latin1");
      const legacySha256 = createHash("sha256").update(legacyPdfBytes).digest("hex");
      const legacySnapshot: ReceiptSnapshot = {
        schemaVersion: 1,
        receiptPublicId: legacyReceiptPubId,
        receiptNumber: "RPR-2025-000099",
        settlementKind: "manual_payment",
        issuedAt: "2025-12-15T10:00:00.000Z",
        orderPublicId: orderRec.publicId,
        orderReference: orderRec.reference,
        // Intentionally omit `projectName` to simulate pre-07.2 snapshot!
        invoicePublicId: draft.invoicePublicId,
        invoiceNumber: "RP-INV-2025-000099",
        paymentPublicId: null,
        company: {
          legalName: "ReadyPackets",
          address: "",
          contact: "",
          taxId: "",
          logoMode: "none",
          logoBrandPath: null,
        },
        customer: {
          name: "María Elena García-López",
          email: "maria.buyer@example.test",
          customerRef: null,
        },
        currency: "USD",
        lines: [{ position: 1, description: "Legacy item", quantity: 1, unitAmountMinor: 1000, lineTotalMinor: 1000 }],
        subtotalMinor: 1000,
        discountMinor: 0,
        bundleDiscountMinor: 0,
        discountLabel: null,
        promoDiscountMinor: 0,
        promoLabel: null,
        taxMinor: 0,
        amountWaivedMinor: 0,
        amountPaidMinor: 1000,
        paymentMethod: "wire",
        paymentMethodBrand: null,
        paymentMethodLast4: null,
        provider: null,
        providerReference: "LEGACY-WIRE-99",
        footerText: "",
      };

      const [invRow] = await tdb.db
        .select({ id: complianceSchema.complianceInvoices.id })
        .from(complianceSchema.complianceInvoices)
        .where(eq(complianceSchema.complianceInvoices.publicId, draft.invoicePublicId))
        .limit(1);

      await tdb.db.insert(complianceSchema.compliancePaymentReceipts).values({
        publicId: legacyReceiptPubId,
        receiptNumber: "RPR-2025-000099",
        sequenceNumber: 99,
        settlementKey: `legacy_manual:${legacyReceiptPubId}`,
        settlementKind: "manual_payment",
        invoiceId: invRow!.id,
        invoicePublicId: draft.invoicePublicId,
        paymentId: null,
        paymentPublicId: null,
        orderId: orderRec.id,
        orderPublicId: orderRec.publicId,
        orderReference: orderRec.reference,
        customerUserId: customerPrincipal.userId,
        customerRefSnapshot: null,
        currency: "USD",
        subtotalMinor: 1000,
        discountMinor: 0,
        bundleDiscountMinor: 0,
        promoDiscountMinor: 0,
        promoLabelSnapshot: null,
        taxMinor: 0,
        amountWaivedMinor: 0,
        amountPaidMinor: 1000,
        refundedMinor: 0,
        refundState: "none",
        paymentMethod: "wire",
        paymentMethodBrand: null,
        paymentMethodLast4: null,
        provider: null,
        providerReference: null,
        issuedAt: new Date("2025-12-15T10:00:00.000Z"),
        emailedAt: null,
        lastResentAt: null,
        resendCount: 0,
        snapshotEnc: h.deps.crypto.encrypt(
          JSON.stringify(legacySnapshot),
          `compliance_payment_receipts.snapshot:${legacyReceiptPubId}`,
        ),
        pdfEnc: h.deps.crypto.encrypt(
          legacyPdfBytes.toString("base64"),
          `compliance_payment_receipts.pdf:${legacyReceiptPubId}`,
        ),
        pdfSha256: legacySha256,
        pdfByteSize: legacyPdfBytes.byteLength,
        origin: "portal",
        createdAt: new Date("2025-12-15T10:00:00.000Z"),
        updatedAt: new Date("2025-12-15T10:00:00.000Z"),
      });

      // Stored PDF bytes + SHA-256 remain 100% untouched on download:
      const downloadedLegacy = await mod.receipts.downloadReceiptPdf(
        customerPrincipal,
        legacyReceiptPubId,
      );
      expect(downloadedLegacy.buffer.equals(legacyPdfBytes)).toBe(true);
      expect(createHash("sha256").update(downloadedLegacy.buffer).digest("hex")).toBe(legacySha256);

      // Yet on-screen detail view and admin resend email resolve live `projectName` cleanly!
      const legacyView = await caller(customerPrincipal).receipts.get({
        receiptPublicId: legacyReceiptPubId,
      });
      expect(legacyView.orderReference).toBe("RP-2026-009101");
      expect(legacyView.projectName).toBe("Horizon FinTech Series A Security Packet");

      await caller(steppedUpAdmin).receipts.admin.resend({
        receiptPublicId: legacyReceiptPubId,
      });
      const resentMail = h.mailer.last("payment_receipt");
      expect(resentMail?.vars).toEqual({
        receiptNumber: "RPR-2025-000099",
        orderReference: "RP-2026-009101",
        projectName: "Horizon FinTech Series A Security Packet",
      });
      // And verify direct `enqueuePaymentReceipt` helper contract as well:
      await enqueuePaymentReceipt(h.mailer, {
        receiptPublicId: legacyReceiptPubId,
        recipientUserId: customerPrincipal.userId,
        receiptNumber: "RPR-2025-000099",
        orderReference: "RP-2026-009101",
        projectName: "Horizon FinTech Series A Security Packet",
        pdf: legacyPdfBytes,
        resendRequestPublicId: "01JBRANDTESTRESEND00000001",
      });
      expect(h.mailer.last("payment_receipt")?.vars).toEqual({
        receiptNumber: "RPR-2025-000099",
        orderReference: "RP-2026-009101",
        projectName: "Horizon FinTech Series A Security Packet",
      });
    });
  });
});
