/**
 * Increment 09 — Compliance TrashParticipant, D2.6 finance & evidence retention,
 * D2.8 late provider payment booking on trashed orders, frozen buyer/order snapshots,
 * and OutboundMail.orderId correlation.
 *
 * All data is 100% synthetic.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDeps, fakePrincipal } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import type { ModuleDeps, Services } from "../../container.js";
import { conflict, DomainError, notFound } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { newRequestContext, runWithRequestContext } from "../../core/requestContext.js";
import type { DbOrTx, Logger, SessionPrincipal, Tx } from "../../core/types.js";
import { users } from "../identity/schema.js";
import type { OrderAccessRole, OrderAccessView, OrderLockState, OrdersModule } from "../orders/index.js";
import { orders } from "../orders/schema.js";
import * as paymentsSchema from "../payments/schema.js";
import { unfencedPurgeRunForTests, type TrashParticipant } from "../trash/ports.js";
import { createAcceptanceLogService } from "./acceptanceLogService.js";
import * as acceptanceSchema from "./acceptanceSchema.js";
import { createComplianceModule } from "./index.js";
import * as policyEnforcementSchema from "./policyEnforcementSchema.js";
import * as policyNoticesSchema from "./policyNoticesSchema.js";
import * as complianceSchema from "./schema.js";

interface TestOrderRow {
  id: number;
  publicId: string;
  reference: string;
  ownerUserId: number;
  ownerPublicId: string;
  projectName: string;
  lockState: OrderLockState;
  origin: "portal" | "import";
  trashed: boolean;
  purged: boolean;
}

function buildTrashAwareOrders(ordersByPubId: Map<string, TestOrderRow>): OrdersModule {
  const byId = () => {
    const map = new Map<number, TestOrderRow>();
    for (const o of ordersByPubId.values()) map.set(o.id, o);
    return map;
  };

  function resolveRole(principal: SessionPrincipal, order: TestOrderRow): OrderAccessRole | null {
    if (principal.role === "admin") return "admin";
    if (principal.role === "staff") return "staff";
    if (order.ownerUserId === principal.userId) return "owner";
    return null;
  }

  function toAccessView(order: TestOrderRow, role: OrderAccessRole): OrderAccessView {
    return {
      id: order.id,
      publicId: order.publicId,
      reference: order.reference,
      ownerUserId: order.ownerUserId,
      ownerPublicId: order.ownerPublicId,
      statusKey: "in_progress",
      lockState: order.lockState,
      locked: order.lockState !== "none",
      readOnlyImported: order.origin === "import",
      accessRole: role,
      canWrite: order.lockState === "none" && order.origin === "portal",
      origin: order.origin,
      version: 1,
      workflowVersionId: 1,
    };
  }

  async function assertCanReadOrder(principal: SessionPrincipal, orderPublicId: string): Promise<OrderAccessView> {
    if (principal.state !== "full" || principal.pendingSteps.length > 0) throw notFound("ORDER_NOT_FOUND");
    const order = ordersByPubId.get(orderPublicId);
    if (!order || order.trashed || order.purged) throw notFound("ORDER_NOT_FOUND");
    const role = resolveRole(principal, order);
    if (!role) throw notFound("ORDER_NOT_FOUND");
    return toAccessView(order, role);
  }

  return {
    assertCanReadOrder,
    async assertCanWriteOrder(principal: SessionPrincipal, orderPublicId: string) {
      const view = await assertCanReadOrder(principal, orderPublicId);
      return view;
    },
    async listAccessibleOrderIds(principal: SessionPrincipal) {
      if (principal.role === "admin" || principal.role === "staff") return { all: true as const };
      const orderIds: number[] = [];
      for (const o of ordersByPubId.values()) {
        if (!o.trashed && !o.purged && o.ownerUserId === principal.userId) {
          orderIds.push(o.id);
        }
      }
      return { all: false as const, orderIds };
    },
    async getOrderRefById(orderId: number) {
      const o = byId().get(orderId);
      if (!o || o.trashed || o.purged) return null;
      return {
        id: o.id,
        publicId: o.publicId,
        reference: o.reference,
        ownerUserId: o.ownerUserId,
        lockState: o.lockState,
        statusKey: "in_progress",
        name: o.projectName,
      };
    },
    async isTrashedInTx(_tx: Tx, orderId: number) {
      const o = byId().get(orderId);
      return Boolean(o && (o.trashed || o.purged));
    },
    async retainedOrderRefInTx(_tx: DbOrTx, orderId: number) {
      const o = byId().get(orderId);
      if (!o) return null;
      return {
        id: o.id,
        publicId: o.publicId,
        reference: o.reference,
        ownerUserId: o.ownerUserId,
        origin: o.origin,
        trashed: o.trashed,
        purged: o.purged,
      };
    },
    async getProductionScope(orderId: number) {
      const o = byId().get(orderId);
      if (!o || o.trashed || o.purged) throw notFound("ORDER_NOT_FOUND");
      return {
        orderId: o.id,
        orderPublicId: o.publicId,
        workflowKey: "standard",
        workflowVersionId: 1,
        productPublicIds: [],
      };
    },
    gates: {
      registerProvider() {},
      async assertCustomerMayWork(input: { orderId: number }) {
        const o = byId().get(input.orderId);
        if (!o || o.trashed || o.purged) throw notFound("ORDER_NOT_FOUND");
      },
    },
    orders: {
      async get(principal: SessionPrincipal, orderPublicId: string) {
        const o = ordersByPubId.get(orderPublicId);
        if (!o || o.trashed || o.purged) throw notFound("ORDER_NOT_FOUND");
        const role = resolveRole(principal, o);
        if (!role) throw notFound("ORDER_NOT_FOUND");
        return { lineItems: [] };
      },
    },
    payments: {
      async onInvoicePaidInTx() {},
      async onPaymentEventInTx() {},
    },
  } as unknown as OrdersModule;
}

describe("Increment 09 — Compliance TrashParticipant, frozen snapshots & finance retention", () => {
  let tdb: TestDb;
  let adminPrincipal: SessionPrincipal;
  let zeusPrincipal: SessionPrincipal;
  let otherCustomerPrincipal: SessionPrincipal;
  let zeusUserId = 0;
  let zeusPublicId = "";
  let adminUserId = 0;
  let adminPublicId = "";

  beforeAll(async () => {
    tdb = await createTestDb({
      schema: {
        users,
        orders,
        ...complianceSchema,
        ...acceptanceSchema,
        ...policyNoticesSchema,
        ...policyEnforcementSchema,
        ...paymentsSchema,
      },
    });

    const now = new Date("2026-11-27T10:00:00.000Z");
    const t = createTestDeps({ db: tdb.db, now });

    adminPublicId = ulid(now.getTime() + 1);
    const [adminIns] = await tdb.db.insert(users).values({
      publicId: adminPublicId,
      customerRef: null,
      emailEnc: t.deps.crypto.encrypt("admin.ops@example.test", `users.email:${adminPublicId}`),
      emailIndex: "a".repeat(64),
      nameEnc: t.deps.crypto.encrypt("Ops Admin", `users.name:${adminPublicId}`),
      role: "admin",
      status: "active",
      emailVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    adminUserId = adminIns.insertId;

    zeusPublicId = ulid(now.getTime() + 2);
    const [zeusIns] = await tdb.db.insert(users).values({
      publicId: zeusPublicId,
      customerRef: "RPCUS-A1B2CJJG5",
      emailEnc: t.deps.crypto.encrypt("zeus.greene@example.test", `users.email:${zeusPublicId}`),
      emailIndex: "b".repeat(64),
      nameEnc: t.deps.crypto.encrypt("Zeus Greene", `users.name:${zeusPublicId}`),
      role: "customer",
      status: "active",
      emailVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    zeusUserId = zeusIns.insertId;

    const otherPub = ulid(now.getTime() + 3);
    const [otherIns] = await tdb.db.insert(users).values({
      publicId: otherPub,
      customerRef: "RPCUS-Z9Y8X7W6V",
      emailEnc: t.deps.crypto.encrypt("athena.blake@example.test", `users.email:${otherPub}`),
      emailIndex: "c".repeat(64),
      nameEnc: t.deps.crypto.encrypt("Athena Blake", `users.name:${otherPub}`),
      role: "customer",
      status: "active",
      emailVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    adminPrincipal = fakePrincipal({
      userId: adminUserId,
      userPublicId: adminPublicId,
      role: "admin",
      stepUpAt: now,
    });
    zeusPrincipal = fakePrincipal({
      userId: zeusUserId,
      userPublicId: zeusPublicId,
      role: "customer",
    });
    otherCustomerPrincipal = fakePrincipal({
      userId: otherIns.insertId,
      userPublicId: otherPub,
      role: "customer",
    });
  });

  afterAll(async () => {
    await tdb?.cleanup();
  });

  function createHarness() {
    const now = new Date("2026-11-27T10:05:00.000Z");
    const t = createTestDeps({ db: tdb.db, now });
    const ordersMap = new Map<string, TestOrderRow>();
    const registeredTrashParticipants: TrashParticipant[] = [];
    let onInvoicePaidCalls = 0;

    const testLogger: Logger = {
      debug() {},
      info() {},
      warn() {},
      error() {},
      child() {
        return testLogger;
      },
    };

    const ordersModule = buildTrashAwareOrders(ordersMap);

    const services = {
      orders: ordersModule,
      identity: {
        sessions: {
          async getState(sessionId: string) {
            const match = [adminPrincipal, zeusPrincipal, otherCustomerPrincipal].find(
              (p) => p.sessionId === sessionId,
            );
            if (!match) return null;
            const [u] = await tdb.db
              .select({ status: users.status, trashedAt: users.trashedAt, purgedAt: users.purgedAt })
              .from(users)
              .where(eq(users.id, match.userId))
              .limit(1);
            if (!u || u.trashedAt !== null || u.purgedAt !== null) return null;
            return {
              live: u.status === "active",
              userId: match.userId,
              userPublicId: match.userPublicId,
              userStatus: u.status,
              role: match.role,
              authMethod: match.authMethod,
              stepUpAt: match.stepUpAt,
              mfaVerifiedAt: match.mfaVerifiedAt,
            };
          },
        },
      },
      trash: {
        register(p: TrashParticipant) {
          registeredTrashParticipants.push(p);
        },
      },
      payments: {
        async isOnlineCheckoutConfigured() {
          return true;
        },
      },
      engagement: {
        notifications: {
          async notifyUsers() {},
          async notifyRoles() {},
        },
      },
    } as unknown as Services;

    const moduleDeps: ModuleDeps = {
      ...t.deps,
      logger: testLogger,
      services,
    };

    const compliance = createComplianceModule(moduleDeps);
    compliance.onInvoicePaid(async () => {
      onInvoicePaidCalls += 1;
    });
    (services as unknown as { compliance: typeof compliance }).compliance = compliance;

    async function insertOrder(input: { reference: string; projectName: string }): Promise<TestOrderRow> {
      const pubId = ulid();
      const [ins] = await tdb.db.insert(orders).values({
        publicId: pubId,
        reference: input.reference,
        ownerUserId: zeusUserId,
        projectName: input.projectName,
        workflowVersionId: 1,
        statusKey: "in_progress",
        subtotalMinor: 25_000,
        totalMinor: 25_000,
        currency: "USD",
        createdAt: now,
        updatedAt: now,
      });
      const rec: TestOrderRow = {
        id: ins.insertId,
        publicId: pubId,
        reference: input.reference,
        ownerUserId: zeusUserId,
        ownerPublicId: zeusPublicId,
        projectName: input.projectName,
        lockState: "none",
        origin: "portal",
        trashed: false,
        purged: false,
      };
      ordersMap.set(pubId, rec);
      return rec;
    }

    async function trashOrder(order: TestOrderRow, participant: TrashParticipant): Promise<void> {
      const trashedAt = t.deps.clock.now();
      const batchId = ulid();
      await tdb.db.transaction(async (tx) => {
        await tx.update(orders).set({ trashedAt, trashBatchId: batchId }).where(eq(orders.id, order.id));
        order.trashed = true;
        await participant.onTrashedInTx?.(
          tx,
          { kind: "order", id: order.id, publicId: order.publicId, batchId },
          { kind: "user", userId: adminUserId, publicId: adminPublicId },
        );
      });
    }

    async function purgeOrder(order: TestOrderRow, participant: TrashParticipant) {
      const res = await participant.purge!(
        { kind: "order", id: order.id, publicId: order.publicId, batchId: ulid() },
        unfencedPurgeRunForTests(ulid()),
      );
      const purgedAt = t.deps.clock.now();
      await tdb.db
        .update(orders)
        .set({
          projectName: "Deleted order",
          trashedAt: null,
          purgedAt,
        })
        .where(eq(orders.id, order.id));
      order.trashed = false;
      order.purged = true;
      return res;
    }

    return {
      t,
      moduleDeps,
      compliance,
      registeredTrashParticipants,
      insertOrder,
      trashOrder,
      purgeOrder,
      getOnInvoicePaidCalls: () => onInvoicePaidCalls,
      resetOnInvoicePaidCalls: () => {
        onInvoicePaidCalls = 0;
      },
    };
  }

  it("registers TrashParticipant synchronously during init() without awaiting", () => {
    const h = createHarness();
    // Simulate container.ts synchronous invocation: `void module.init?.()`
    void h.compliance.init?.();
    expect(h.registeredTrashParticipants).toHaveLength(1);
    expect(h.registeredTrashParticipants[0]!.module).toBe("compliance");
  });

  it("enforces D2.6 & D2.8 across order trash, late provider webhook payment, order purge, and customer purge", async () => {
    const h = createHarness();
    await h.compliance.init?.();
    const participant = h.registeredTrashParticipants[0]!;

    await runWithRequestContext(newRequestContext("test"), async () => {
      await h.compliance.invoices.admin.updateCompanyProfile(adminPrincipal, {
        issuerName: "Ready Packets Synthetic LLC",
        issuerAddress: "100 Harbor Way\nSuite 400",
        issuerContact: "billing@example.test",
        issuerTaxId: "SYN-99-1234567",
        issuerLogo: {
          mode: "brand",
          brandPath: "/brand/readypackets-horizontal-light-600x180-v2026101502.png",
        },
        paymentInstructions: "Wire within 14 days.",
      });

      const orderA = await h.insertOrder({
        reference: "RP-2026-ICEQ01",
        projectName: "Ice Queen",
      });

      // 1. Create and issue a paid invoice, an unpaid issued invoice, and a draft invoice on Order A.
      const paidDraft = await h.compliance.invoices.admin.createDraft(adminPrincipal, {
        orderPublicId: orderA.publicId,
        currency: "USD",
        discountMinor: 0,
        taxMinor: 0,
        lines: [{ description: "Packet preparation", quantity: 1, unitAmountMinor: 15_000 }],
      });
      const paidIssued = await h.compliance.invoices.admin.issue(adminPrincipal, {
        invoicePublicId: paidDraft.invoicePublicId,
      });
      // OutboundMail.orderId is attached when issuing an invoice.
      const issueMail = h.t.mailer.sent.find((m) => m.template === "compliance.invoice_issued");
      expect(issueMail?.orderId).toBe(orderA.id);

      await h.compliance.invoices.admin.recordManualPayment(adminPrincipal, {
        invoicePublicId: paidIssued.invoicePublicId,
        amountMinor: 15_000,
        currency: "USD",
        method: "wire",
        reference: "WIRE-ICEQ-001",
        idempotencyKey: "idem-wire-iceq-001",
      });
      const receiptMail = h.t.mailer.sent.find((m) => m.template === "payment_receipt");
      expect(receiptMail?.orderId).toBe(orderA.id);
      const invoicePaidMail = h.t.mailer.sent.find((m) => m.template === "compliance.invoice_paid");
      expect(invoicePaidMail?.orderId).toBe(orderA.id);

      const unpaidDraft = await h.compliance.invoices.admin.createDraft(adminPrincipal, {
        orderPublicId: orderA.publicId,
        currency: "USD",
        discountMinor: 0,
        taxMinor: 0,
        lines: [{ description: "Expedited review", quantity: 1, unitAmountMinor: 8_000 }],
      });
      const unpaidIssued = await h.compliance.invoices.admin.issue(adminPrincipal, {
        invoicePublicId: unpaidDraft.invoicePublicId,
      });

      const unissuedDraft = await h.compliance.invoices.admin.createDraft(adminPrincipal, {
        orderPublicId: orderA.publicId,
        currency: "USD",
        discountMinor: 0,
        taxMinor: 0,
        lines: [{ description: "Optional addendum", quantity: 1, unitAmountMinor: 4_500 }],
      });

      // Seed an intake submission + revision + order policy acceptance on Order A.
      const qCreated = await h.compliance.intake.admin.createQuestionnaire(adminPrincipal, {
        slug: `ice-queen-intake-${ulid().toLowerCase()}`,
        title: "Ice Queen Intake",
        scopeKind: "default",
        fields: [
          {
            key: "project_goal",
            label: "Project goal",
            type: "short_text",
            required: true,
            sensitive: false,
          },
        ],
      });
      await h.compliance.intake.admin.publishVersion(adminPrincipal, qCreated.draftVersionPublicId);
      await h.compliance.intake.submit(zeusPrincipal, {
        orderPublicId: orderA.publicId,
        questionnairePublicId: qCreated.questionnairePublicId,
        answers: { project_goal: "Launch Ice Queen portal" },
      });

      // Seed a published policy + order policy acceptance + general acceptance.
      const polCreated = await h.compliance.policies.admin.createDocument(adminPrincipal, {
        slug: `terms-${ulid().toLowerCase()}`,
        title: "Master Service Terms",
        audience: "customer",
        requiresAcceptance: true,
        requiresTypedSignature: false,
        versionLabel: "v1.0",
        contentFormat: "plain_text",
        bodyText: "Synthetic service terms v1.",
        changeSummary: "Initial terms",
      });
      const publishedPol = await h.compliance.policies.admin.publishVersion(adminPrincipal, {
        versionPublicId: polCreated.draftVersionPublicId,
      });
      await h.compliance.policies.accept(zeusPrincipal, {
        versionPublicId: publishedPol.versionPublicId,
        contentHash: publishedPol.contentHash,
      });

      const checkoutPolCreated = await h.compliance.policies.admin.createDocument(adminPrincipal, {
        slug: `checkout-terms-${ulid().toLowerCase()}`,
        title: "Order Checkout Terms",
        audience: "customer",
        requiresAcceptance: true,
        requiresTypedSignature: false,
        versionLabel: "v1.0",
        contentFormat: "plain_text",
        bodyText: "Synthetic order checkout terms v1.",
        changeSummary: "Initial checkout terms",
      });
      const publishedCheckoutPol = await h.compliance.policies.admin.publishVersion(adminPrincipal, {
        versionPublicId: checkoutPolCreated.draftVersionPublicId,
      });
      await tdb.db.transaction(async (tx) => {
        await h.compliance.recordCheckoutAcceptances(
          {
            principal: zeusPrincipal,
            orderId: orderA.id,
            orderPublicId: orderA.publicId,
            items: [
              {
                versionPublicId: publishedCheckoutPol.versionPublicId,
                contentHash: publishedCheckoutPol.contentHash,
                signerName: "Zeus Greene",
              },
            ],
          },
          tx,
        );
      });

      // 2. Summarize BEFORE trashing/purging Order A: 1 paid, 2 unpaid (1 issued unpaid + 1 draft), 1 receipt, 1 intake item.
      const summaryBefore = await participant.summarize!({
        kind: "order",
        id: orderA.id,
        publicId: orderA.publicId,
        batchId: ulid(),
      });
      expect(summaryBefore).toEqual({
        paidInvoices: 1,
        unpaidInvoices: 2,
        receipts: 1,
        intakeItems: 1,
      });

      // 3. Move Order A to trash.
      await h.trashOrder(orderA, participant);

      // Customer sees ONLY the paid invoice in listMine; unpaid & draft are hidden!
      const mineInTrash = await h.compliance.invoices.listMine(zeusPrincipal, { limit: 25 });
      expect(mineInTrash.items.map((i) => i.invoicePublicId)).toEqual([paidIssued.invoicePublicId]);
      expect(mineInTrash.items[0]!.orderLifecycleState).toBe("trashed");

      // Customer cannot read or download or checkout the unpaid invoice while Order A is in trash.
      await expect(
        h.compliance.invoices.get(zeusPrincipal, unpaidIssued.invoicePublicId),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        h.compliance.invoices.downloadPdf(zeusPrincipal, unpaidIssued.invoicePublicId),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        h.compliance.getInvoiceForCheckout(unpaidIssued.invoicePublicId, { principal: zeusPrincipal }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      // Other customers still get NOT_FOUND even on paid invoices (zero existence oracle).
      await expect(
        h.compliance.invoices.get(otherCustomerPrincipal, paidIssued.invoicePublicId),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      // Customer CAN still view and download the paid invoice and its receipt while Order A is in trash!
      const paidViewInTrash = await h.compliance.invoices.get(zeusPrincipal, paidIssued.invoicePublicId);
      expect(paidViewInTrash.status).toBe("paid");
      expect(paidViewInTrash.orderLifecycleState).toBe("trashed");
      expect(paidViewInTrash.buyer).toEqual({
        name: "Zeus Greene",
        email: "zeus.greene@example.test",
        customerRef: "RPCUS-A1B2CJJG5",
      });
      const paidPdfInTrash = await h.compliance.invoices.downloadPdf(zeusPrincipal, paidIssued.invoicePublicId);
      expect(paidPdfInTrash.buffer.byteLength).toBeGreaterThan(200);

      const myReceiptsInTrash = await h.compliance.receipts.myList(zeusPrincipal, { limit: 20 });
      expect(myReceiptsInTrash.items).toHaveLength(1);
      const rcptPubId = myReceiptsInTrash.items[0]!.receiptPublicId;
      const rcptViewInTrash = await h.compliance.receipts.get(zeusPrincipal, rcptPubId);
      expect(rcptViewInTrash.orderLifecycleState).toBe("trashed");

      // Staff sees `trashed` lifecycle on admin finance list and detail, with management/payment/resend disabled.
      const staffListInTrash = await h.compliance.invoices.admin.list(adminPrincipal, { limit: 25 });
      const trashedAdminRows = staffListInTrash.items.filter((i) => i.orderPublicId === orderA.publicId);
      expect(trashedAdminRows).toHaveLength(3);
      expect(trashedAdminRows.every((r) => r.orderLifecycleState === "trashed")).toBe(true);

      const staffUnpaidInTrash = await h.compliance.invoices.get(adminPrincipal, unpaidIssued.invoicePublicId);
      expect(staffUnpaidInTrash.orderLifecycleState).toBe("trashed");
      expect(staffUnpaidInTrash.canManage).toBe(false);
      expect(staffUnpaidInTrash.canRecordPayment).toBe(false);

      const staffReceiptsForTrashed = await h.compliance.receipts.admin.listForOrder(
        adminPrincipal,
        orderA.publicId,
      );
      expect(staffReceiptsForTrashed).toHaveLength(1);
      expect(staffReceiptsForTrashed[0]!.orderLifecycleState).toBe("trashed");
      const staffReceiptDetailInTrash = await h.compliance.receipts.get(adminPrincipal, rcptPubId);
      expect(staffReceiptDetailInTrash.canResend).toBe(false);
      await expect(
        h.compliance.receipts.admin.resend(adminPrincipal, { receiptPublicId: rcptPubId }),
      ).rejects.toMatchObject({ reasonCode: "ORDER_NOT_LIVE" });

      // 4. Test D2.8 late verified provider webhook payment on a trashed order (using a second trashed order).
      const orderLate = await h.insertOrder({
        reference: "RP-2026-ICEQ02",
        projectName: "Ice Queen Late Webhook",
      });
      const lateDraft = await h.compliance.invoices.admin.createDraft(adminPrincipal, {
        orderPublicId: orderLate.publicId,
        currency: "USD",
        discountMinor: 0,
        taxMinor: 0,
        lines: [{ description: "Late webhook settlement", quantity: 1, unitAmountMinor: 9_500 }],
      });
      const lateIssued = await h.compliance.invoices.admin.issue(adminPrincipal, {
        invoicePublicId: lateDraft.invoicePublicId,
      });
      await h.trashOrder(orderLate, participant);

      // Without `principal`, verified webhook lookup succeeds on the trashed order.
      const checkoutLookup = await h.compliance.getInvoiceForCheckout(lateIssued.invoicePublicId);
      expect(checkoutLookup.balanceDueMinor).toBe(9_500);

      const mailCountBeforeLate = h.t.mailer.sent.length;
      h.resetOnInvoicePaidCalls();
      const bookedLate = await tdb.db.transaction((tx) =>
        h.compliance.bookVerifiedProviderPayment(
          {
            invoicePublicId: checkoutLookup.invoicePublicId,
            provider: "stripe",
            environment: "test",
            attemptPublicId: ulid(),
            providerPaymentRef: "pi_synthetic_late_001",
            amountMinor: 9_500,
            currency: "USD",
            paidAt: h.t.deps.clock.now(),
            idempotencyKey: "webhook-late-001",
            paymentMethodBrand: "visa",
            paymentMethodLast4: "4242",
          },
          tx,
        ),
      );
      expect(bookedLate.duplicate).toBe(false);
      expect(bookedLate.invoiceStatus).toBe("paid");
      expect(bookedLate.receiptPublicId).toBeTruthy();
      // No live order stage transition or receipt email sent while order is in trash!
      expect(h.getOnInvoicePaidCalls()).toBe(0);
      expect(h.t.mailer.sent.length).toBe(mailCountBeforeLate);

      // 5. Purge Order A!
      const orderAPurgeResult = await h.purgeOrder(orderA, participant);
      expect(orderAPurgeResult.kept).toMatchObject({
        paidInvoices: 1,
        voidedInvoices: 2,
        receipts: 1,
        policyAcceptances: 1,
      });
      expect(orderAPurgeResult.deleted.intakeItems).toBe(1);

      // Verify unpaid & draft invoices were voided in-place (never deleted!) and draft got no number.
      const remainingOrderAInvoices = await tdb.db
        .select()
        .from(complianceSchema.complianceInvoices)
        .where(eq(complianceSchema.complianceInvoices.orderId, orderA.id));
      expect(remainingOrderAInvoices).toHaveLength(3);
      const voidedUnpaidRow = remainingOrderAInvoices.find((r) => r.publicId === unpaidIssued.invoicePublicId)!;
      expect(voidedUnpaidRow.status).toBe("void");
      expect(voidedUnpaidRow.voidReason).toBe("Order permanently deleted");
      expect(voidedUnpaidRow.invoiceNumber).toBe(unpaidIssued.invoiceNumber);

      const voidedDraftRow = remainingOrderAInvoices.find((r) => r.publicId === unissuedDraft.invoicePublicId)!;
      expect(voidedDraftRow.status).toBe("void");
      expect(voidedDraftRow.invoiceNumber).toBeNull();

      // Issuing a new invoice on a live order NEVER reuses any previous invoice sequence number!
      const orderLiveNext = await h.insertOrder({
        reference: "RP-2026-ICEQ03",
        projectName: "Ice Queen Follow-up",
      });
      const nextDraft = await h.compliance.invoices.admin.createDraft(adminPrincipal, {
        orderPublicId: orderLiveNext.publicId,
        currency: "USD",
        discountMinor: 0,
        taxMinor: 0,
        lines: [{ description: "Follow-up service", quantity: 1, unitAmountMinor: 5_000 }],
      });
      const nextIssued = await h.compliance.invoices.admin.issue(adminPrincipal, {
        invoicePublicId: nextDraft.invoicePublicId,
      });
      expect(nextIssued.invoiceNumber).not.toBe(paidIssued.invoiceNumber);
      expect(nextIssued.invoiceNumber).not.toBe(unpaidIssued.invoiceNumber);
      expect(nextIssued.invoiceNumber).not.toBe(lateIssued.invoiceNumber);

      // Intake rows for Order A are completely erased.
      const remainingIntakes = await tdb.db
        .select()
        .from(complianceSchema.intakeSubmissions)
        .where(eq(complianceSchema.intakeSubmissions.orderId, orderA.id));
      expect(remainingIntakes).toHaveLength(0);

      // Customer still sees kept paid invoice & receipt with `"Deleted order"` and frozen buyer details!
      const paidAfterOrderPurge = await h.compliance.invoices.get(zeusPrincipal, paidIssued.invoicePublicId);
      expect(paidAfterOrderPurge.orderLifecycleState).toBe("deleted");
      expect(paidAfterOrderPurge.projectName).toBe("Deleted order");
      expect(paidAfterOrderPurge.orderReference).toBe("RP-2026-ICEQ01");
      expect(paidAfterOrderPurge.buyer).toEqual({
        name: "Zeus Greene",
        email: "zeus.greene@example.test",
        customerRef: "RPCUS-A1B2CJJG5",
      });

      const rcptAfterOrderPurge = await h.compliance.receipts.get(zeusPrincipal, rcptPubId);
      expect(rcptAfterOrderPurge.orderLifecycleState).toBe("deleted");
      expect(rcptAfterOrderPurge.projectName).toBe("Deleted order");
      expect(rcptAfterOrderPurge.snapshot.customer).toMatchObject({
        name: "Zeus Greene",
        email: "zeus.greene@example.test",
        customerRef: "RPCUS-A1B2CJJG5",
      });

      // 6. Customer summarize & purge (with tombstoned user row):
      //    - policyNoticeRecipients & policyEnforcementActions erased
      //    - policyAcceptances & orderPolicyAcceptances kept
      //    - acceptanceLogService renders `"Deleted account"` with empty email
      //    - kept paid invoice & receipt STILL render frozen buyer snapshot (`Zeus Greene`) for staff!
      const custSummary = await participant.summarize!({
        kind: "customer",
        id: zeusUserId,
        publicId: zeusPublicId,
        batchId: ulid(),
      });
      expect(custSummary.policyAcceptances).toBeGreaterThanOrEqual(2);

      const [verRow] = await tdb.db
        .select({ id: complianceSchema.policyVersions.id })
        .from(complianceSchema.policyVersions)
        .where(eq(complianceSchema.policyVersions.publicId, publishedPol.versionPublicId))
        .limit(1);
      await tdb.db.insert(policyEnforcementSchema.policyEnforcementActions).values({
        policyVersionId: verRow!.id,
        userId: zeusUserId,
        enforcementVersion: 1,
        reason: "deadline",
        createdAt: h.t.deps.clock.now(),
      });

      const custPurgeRes = await participant.purge!(
        { kind: "customer", id: zeusUserId, publicId: zeusPublicId, batchId: ulid() },
        unfencedPurgeRunForTests(ulid()),
      );
      expect(custPurgeRes.deleted.policyEnforcementActions).toBe(1);
      expect(custPurgeRes.kept?.policyAcceptances).toBeGreaterThanOrEqual(2);

      // Idempotent retry on customer purge.
      const custPurgeRetry = await participant.purge!(
        { kind: "customer", id: zeusUserId, publicId: zeusPublicId, batchId: ulid() },
        unfencedPurgeRunForTests(ulid()),
      );
      expect(custPurgeRetry.deleted.policyEnforcementActions).toBe(0);
      expect(custPurgeRetry.kept?.policyAcceptances).toBeGreaterThanOrEqual(2);

      // Tombstone Zeus's user row (matching identity's customer purge tombstone).
      await tdb.db
        .update(users)
        .set({
          status: "deactivated",
          purgedAt: h.t.deps.clock.now(),
          emailEnc: h.t.deps.crypto.encrypt(`deleted-${zeusPublicId}@purged.invalid`, `users.email:${zeusPublicId}`),
          nameEnc: h.t.deps.crypto.encrypt("Deleted account", `users.name:${zeusPublicId}`),
        })
        .where(eq(users.id, zeusUserId));

      // Tombstoned actor can no longer authenticate into compliance endpoints.
      let deniedErr: unknown;
      try {
        await h.compliance.invoices.listMine(zeusPrincipal, { limit: 10 });
      } catch (err) {
        deniedErr = err;
      }
      expect(deniedErr).toBeInstanceOf(DomainError);
      expect((deniedErr as DomainError).code).toBe("UNAUTHENTICATED");

      // Staff still views AND downloads the kept paid invoice & receipt using the frozen snapshot!
      const staffKeptInvoice = await h.compliance.invoices.get(adminPrincipal, paidIssued.invoicePublicId);
      expect(staffKeptInvoice.orderLifecycleState).toBe("deleted");
      expect(staffKeptInvoice.projectName).toBe("Deleted order");
      expect(staffKeptInvoice.buyer).toEqual({
        name: "Zeus Greene",
        email: "zeus.greene@example.test",
        customerRef: "RPCUS-A1B2CJJG5",
      });
      const staffKeptPdf = await h.compliance.invoices.downloadPdf(adminPrincipal, paidIssued.invoicePublicId);
      expect(staffKeptPdf.buffer.byteLength).toBeGreaterThan(200);

      // Acceptance log renders `"Deleted account"` and empty customerEmail for tombstoned user!
      const acceptanceLog = createAcceptanceLogService(h.moduleDeps);
      const logPage = await acceptanceLog.list(adminPrincipal, { limit: 25 });
      const zeusAcceptances = logPage.items.filter((row) => row.orderReference === "RP-2026-ICEQ01");
      expect(zeusAcceptances.length).toBeGreaterThanOrEqual(1);
      expect(zeusAcceptances[0]!.customer?.name).toBe("Deleted account");
      expect(zeusAcceptances[0]!.customer?.email).toBe("");
    });
  });

  it("leaves order and customer compliance data unchanged when TrashPurgeRun.assertCurrentInTx throws PURGE_FENCE_LOST", async () => {
    const h = createHarness();
    await h.compliance.init?.();
    const participant = h.registeredTrashParticipants[0]!;

    await runWithRequestContext(newRequestContext("test"), async () => {
      // Seed active customer for this test so session/user checks pass cleanly.
      const heraPub = ulid();
      const now = h.t.deps.clock.now();
      const [heraIns] = await tdb.db.insert(users).values({
        publicId: heraPub,
        customerRef: "RPCUS-F3NCE0001",
        emailEnc: h.t.deps.crypto.encrypt("hera.fence@example.test", `users.email:${heraPub}`),
        emailIndex: "d".repeat(64),
        nameEnc: h.t.deps.crypto.encrypt("Hera Fence", `users.name:${heraPub}`),
        role: "customer",
        status: "active",
        emailVerifiedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      const heraUserId = heraIns.insertId;

      // Seed an order + unpaid issued invoice + intake submission row for that order.
      const fenceOrder = await h.insertOrder({
        reference: "RP-2026-FENCE1",
        projectName: "Ice Queen Fence",
      });
      const orderId = fenceOrder.id;
      const ordPub = fenceOrder.publicId;

      const invPub = ulid();
      await tdb.db.insert(complianceSchema.complianceInvoices).values({
        publicId: invPub,
        invoiceNumber: "INV-2026-999001",
        orderId,
        orderPublicId: ordPub,
        status: "issued",
        origin: "portal",
        currency: "USD",
        subtotalMinor: 12_000,
        discountMinor: 0,
        taxMinor: 0,
        totalMinor: 12_000,
        issuedAt: now,
        createdByUserId: adminUserId,
        createdAt: now,
        updatedAt: now,
      });

      const qCreated = await h.compliance.intake.admin.createQuestionnaire(adminPrincipal, {
        slug: `fence-intake-${ulid().toLowerCase()}`,
        title: "Fence Intake",
        scopeKind: "default",
        fields: [{ key: "goal", label: "Goal", type: "short_text", required: true, sensitive: false }],
      });
      const [qRow] = await tdb.db
        .select({ id: complianceSchema.intakeQuestionnaires.id })
        .from(complianceSchema.intakeQuestionnaires)
        .where(eq(complianceSchema.intakeQuestionnaires.publicId, qCreated.questionnairePublicId))
        .limit(1);
      const [qvRow] = await tdb.db
        .select({ id: complianceSchema.intakeQuestionnaireVersions.id })
        .from(complianceSchema.intakeQuestionnaireVersions)
        .where(eq(complianceSchema.intakeQuestionnaireVersions.publicId, qCreated.draftVersionPublicId))
        .limit(1);
      const subPub = ulid();
      await tdb.db.insert(complianceSchema.intakeSubmissions).values({
        publicId: subPub,
        orderId,
        orderPublicId: ordPub,
        questionnaireId: qRow!.id,
        questionnaireVersionId: qvRow!.id,
        submittedByUserId: heraUserId,
        status: "submitted",
        currentAnswersEnc: h.t.deps.crypto.encrypt("{}", `intake_submissions.answers:${subPub}`),
        submittedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      const lostFenceRun = unfencedPurgeRunForTests(ulid(), {
        async assertCurrentInTx() {
          throw conflict("PURGE_FENCE_LOST", "Worker ownership fence lost.");
        },
      });

      await expect(
        participant.purge!(
          { kind: "order", id: orderId, publicId: ordPub, batchId: ulid() },
          lostFenceRun,
        ),
      ).rejects.toMatchObject({ code: "CONFLICT", reasonCode: "PURGE_FENCE_LOST" });

      // Invoice stays `issued` (not voided) and intake submission stays intact!
      const [invAfter] = await tdb.db
        .select()
        .from(complianceSchema.complianceInvoices)
        .where(eq(complianceSchema.complianceInvoices.publicId, invPub));
      expect(invAfter!.status).toBe("issued");
      expect(invAfter!.voidedAt).toBeNull();

      const subsAfter = await tdb.db
        .select()
        .from(complianceSchema.intakeSubmissions)
        .where(eq(complianceSchema.intakeSubmissions.orderId, orderId));
      expect(subsAfter).toHaveLength(1);

      // Customer enforcement row also stays untouched when customer purge fence throws!
      const polCreated = await h.compliance.policies.admin.createDocument(adminPrincipal, {
        slug: `fence-terms-${ulid().toLowerCase()}`,
        title: "Fence Terms",
        audience: "customer",
        requiresAcceptance: true,
        requiresTypedSignature: false,
        versionLabel: "v1.0",
        contentFormat: "plain_text",
        bodyText: "Fence policy text.",
      });
      const [polVerRow] = await tdb.db
        .select({ id: complianceSchema.policyVersions.id })
        .from(complianceSchema.policyVersions)
        .where(eq(complianceSchema.policyVersions.publicId, polCreated.draftVersionPublicId))
        .limit(1);
      await tdb.db.insert(policyEnforcementSchema.policyEnforcementActions).values({
        policyVersionId: polVerRow!.id,
        userId: heraUserId,
        enforcementVersion: 1,
        reason: "deadline",
        createdAt: now,
      });

      await expect(
        participant.purge!(
          { kind: "customer", id: heraUserId, publicId: heraPub, batchId: ulid() },
          lostFenceRun,
        ),
      ).rejects.toMatchObject({ code: "CONFLICT", reasonCode: "PURGE_FENCE_LOST" });

      const enfAfter = await tdb.db
        .select()
        .from(policyEnforcementSchema.policyEnforcementActions)
        .where(eq(policyEnforcementSchema.policyEnforcementActions.userId, heraUserId));
      expect(enfAfter).toHaveLength(1);
    });
  });
});
