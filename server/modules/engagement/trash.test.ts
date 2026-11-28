import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDeps, fakePrincipal, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import type { UserRole } from "../../../shared/domain.js";
import type { Services } from "../../container.js";
import { DomainError, forbidden } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { Db, DbOrTx, SessionPrincipal, Tx } from "../../core/types.js";
import { createCallerFactory, router, type TrpcContext } from "../../trpc/trpc.js";
import { liveUserPredicate } from "../identity/live.js";
import { users, type UserStatus } from "../identity/schema.js";
import { createOrdersModule, type OrdersModule } from "../orders/index.js";
import * as orderTables from "../orders/schema.js";
import { platformSettings } from "../platform/schema.js";
import { createTrashRegistry, type TrashRegistry } from "../trash/ports.js";
import { createEngagementModule, type EngagementModule } from "./index.js";
import {
  MAIL_GENERIC_NOTIFICATION,
  MAIL_ORDER_MESSAGE_RECEIVED,
  MAIL_TICKET_UPDATED,
} from "./mail.js";
import { engagementRouter } from "./router.js";
import * as engagementTables from "./schema.js";
import { ENGAGEMENT_NOTIFICATIONS_EMAIL_ENABLED } from "./settings.js";

const testSchema = {
  users,
  platformSettings,
  ...orderTables,
  ...engagementTables,
};

const appTestRouter = router({ engagement: engagementRouter });
const createCaller = createCallerFactory(appTestRouter);

interface SyntheticUser {
  id: number;
  publicId: string;
  email: string;
  name: string;
  customerRef: string | null;
  role: UserRole;
  principal: SessionPrincipal;
}

let userSeq = 0;
let idemSeq = 0;

function nextIdemKey(prefix = "eng9"): string {
  idemSeq += 1;
  return `${prefix}_idem_${idemSeq}_abcdefghij`;
}

async function insertSyntheticUser(
  h: TestHarness,
  db: Db,
  opts: {
    role?: UserRole;
    status?: UserStatus;
    name?: string;
    customerRef?: string | null;
    stepUp?: boolean;
  } = {},
): Promise<SyntheticUser> {
  userSeq += 1;
  const publicId = ulid(h.clock.now().getTime() + userSeq);
  const role = opts.role ?? "customer";
  const email = `trash.eng.${userSeq}@synthetic.test`;
  const name = opts.name ?? `Synthetic Member ${userSeq}`;
  const customerRef =
    opts.customerRef ?? (role === "customer" ? `RPCUS-A1B2CJJ${String(userSeq).padStart(2, "0")}` : null);

  await db.insert(users).values({
    publicId,
    customerRef,
    role,
    status: opts.status ?? "active",
    emailEnc: h.deps.crypto.encrypt(email, `users.email:${publicId}`),
    emailIndex: h.deps.crypto.blindIndex(email, "users.email"),
    emailVerifiedAt: h.clock.now(),
    nameEnc: h.deps.crypto.encrypt(name, `users.name:${publicId}`),
  });
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.publicId, publicId));
  const principal = fakePrincipal({
    userId: row!.id,
    userPublicId: publicId,
    role,
    stepUpAt: opts.stepUp ? h.clock.now() : null,
  });
  return { id: row!.id, publicId, email, name, customerRef, role, principal };
}

function buildIdentityPeer(h: TestHarness, db: Db) {
  const toUserSummary = (row: typeof users.$inferSelect) => ({
    id: row.id,
    publicId: row.publicId,
    role: row.role,
    status: row.status,
    email: h.deps.crypto.decrypt(row.emailEnc, `users.email:${row.publicId}`),
    name: h.deps.crypto.decrypt(row.nameEnc, `users.name:${publicIdOrRow(row)}`),
    customerRef: row.customerRef,
    emailVerified: row.emailVerifiedAt !== null,
  });

  function publicIdOrRow(row: typeof users.$inferSelect): string {
    return row.publicId;
  }

  return {
    async getUser(userId: number, opts?: { tx?: DbOrTx }) {
      const [row] = await (opts?.tx ?? db).select().from(users).where(eq(users.id, userId)).limit(1);
      if (!row || row.trashedAt !== null || row.purgedAt !== null) return null;
      return toUserSummary(row);
    },
    async getUserByPublicId(publicId: string, opts?: { tx?: DbOrTx }) {
      const [row] = await (opts?.tx ?? db).select().from(users).where(eq(users.publicId, publicId)).limit(1);
      if (!row || row.trashedAt !== null || row.purgedAt !== null) return null;
      return toUserSummary(row);
    },
    async searchCustomers(principal: SessionPrincipal, input: { query?: string; limit?: number }) {
      if (principal.role === "customer") throw forbidden("CUSTOMERS_READ_DENIED");
      const allRows = await db
        .select()
        .from(users)
        .where(liveUserPredicate(users))
        .limit(50);
      const q = (input.query ?? "").toLowerCase();
      const matched = allRows
        .filter((r) => r.role === "customer")
        .map(toUserSummary)
        .filter(
          (u) =>
            u.name.toLowerCase().includes(q) ||
            u.email.toLowerCase().includes(q) ||
            (u.customerRef ?? "").toLowerCase().includes(q),
        )
        .slice(0, input.limit ?? 5)
        .map((u) => ({
          publicId: u.publicId,
          customerRef: u.customerRef,
          name: u.name,
          email: u.email,
          status: u.status,
          role: u.role,
          emailVerified: true,
          createdAt: h.clock.now(),
        }));
      return { items: matched, nextCursor: null };
    },
    sessions: {
      assertCurrent: async (principal: SessionPrincipal, tx: Tx) => {
        const [u] = await tx.select().from(users).where(eq(users.id, principal.userId)).limit(1);
        if (!u || u.status !== "active" || u.role !== principal.role) {
          throw new DomainError("UNAUTHENTICATED", "SESSION_NOT_CURRENT", "Sign in again.");
        }
        return {
          pendingSteps: [] as string[],
          role: u.role,
          stepUpAt: principal.stepUpAt,
          mfaVerifiedAt: principal.mfaVerifiedAt,
        };
      },
    },
  };
}

describe("engagement module — Trash & Permanent Erasure (increment 09)", () => {
  let tdb: TestDb;
  let h: TestHarness;
  let ordersMod: OrdersModule;
  let engagement: EngagementModule;
  let trashRegistry: TrashRegistry;

  let admin: SyntheticUser;
  let staff: SyntheticUser;
  let zeus: SyntheticUser;
  let productPublicId: string;

  const callerFor = (session: SessionPrincipal | null) =>
    createCaller({
      services: h.services,
      session,
      request: newRequestContext("test"),
      transport: { issue() {}, clear() {} },
    } satisfies TrpcContext);

  beforeAll(async () => {
    tdb = await createTestDb({ schema: testSchema });
    h = createTestDeps({ db: tdb.db });
    trashRegistry = createTrashRegistry();
    (h.services as unknown as { trash: TrashRegistry }).trash = trashRegistry;
    h.services.identity = buildIdentityPeer(h, tdb.db) as unknown as Services["identity"];

    ordersMod = createOrdersModule(h.deps);
    h.services.orders = ordersMod;
    engagement = createEngagementModule(h.deps);
    h.services.engagement = engagement;
    engagement.init?.();

    admin = await insertSyntheticUser(h, tdb.db, { role: "admin", name: "Ada Console", stepUp: true });
    staff = await insertSyntheticUser(h, tdb.db, { role: "staff", name: "Sam Desk" });
    zeus = await insertSyntheticUser(h, tdb.db, {
      role: "customer",
      name: "Zeus Greene",
      customerRef: "RPCUS-A1B2CJJG5",
    });

    const group = await ordersMod.catalog.createGroup(admin.principal, {
      name: "Filing Packets",
      description: "Synthetic group",
      sortOrder: 0,
      active: true,
    });
    const product = await ordersMod.catalog.createProduct(admin.principal, {
      groupId: group.publicId,
      productKey: "ice-queen-packet",
      sortOrder: 0,
      active: true,
      name: "Ice Queen Packet",
      description: "Synthetic packet",
      features: ["Exhibit prep"],
      priceMinor: 19900,
      currency: "USD",
    });
    productPublicId = product.publicId;
  });

  beforeEach(async () => {
    h.audit.clear();
    h.mailer.sent = [];
    await h.settings.set(ENGAGEMENT_NOTIFICATIONS_EMAIL_ENABLED.key, true);
  });

  afterAll(async () => {
    await tdb.cleanup();
  });

  it("registers TrashParticipant 'engagement' and propagates internal orderId on OutboundMail for order messages, order tickets, and notifications", async () => {
    const participant = trashRegistry.participants().find((p) => p.module === "engagement");
    expect(participant).toBeDefined();

    const ord = await ordersMod.orders.create(zeus.principal, {
      projectName: "Ice Queen Mail Check",
      items: [{ productPublicId, quantity: 1 }],
      idempotencyKey: nextIdemKey("ord"),
    });
    const [ordRow] = await tdb.db
      .select({ id: orderTables.orders.id })
      .from(orderTables.orders)
      .where(eq(orderTables.orders.publicId, ord.publicId));

    h.mailer.sent = [];
    await callerFor(staff.principal).engagement.messages.send({
      orderId: ord.publicId,
      body: "Staff update on Ice Queen exhibits.",
      visibility: "customer",
      idempotencyKey: nextIdemKey("msg"),
    });
    expect(
      h.mailer.sent.some((m) => m.template === MAIL_ORDER_MESSAGE_RECEIVED && m.orderId === ordRow!.id),
    ).toBe(true);

    const tktCreated = await callerFor(zeus.principal).engagement.tickets.create({
      subject: "Ice Queen exhibit binder",
      category: "order",
      relatedOrderId: ord.publicId,
      body: "Question about exhibit tabs and numbering.",
      idempotencyKey: nextIdemKey("tkt"),
    });
    const tkt = tktCreated.ticket;

    h.mailer.sent = [];
    await callerFor(staff.principal).engagement.tickets.admin.reply({
      ticketId: tkt.publicId,
      body: "Tabs are included in your packet.",
      internalOnly: false,
      idempotencyKey: nextIdemKey("rpl"),
    });
    expect(
      h.mailer.sent.some((m) => m.template === MAIL_TICKET_UPDATED && m.orderId === ordRow!.id),
    ).toBe(true);

    await callerFor(zeus.principal).engagement.notifications.preferences.update({
      category: "order",
      inApp: true,
      email: true,
    });
    h.mailer.sent = [];
    await engagement.notify({
      userId: zeus.id,
      kind: "order.phase_changed",
      orderId: ordRow!.id,
      title: "Phase updated",
      body: "Your order advanced to review.",
      link: `/orders/${ord.publicId}`,
    });
    expect(
      h.mailer.sent.some((m) => m.template === MAIL_GENERIC_NOTIFICATION && m.orderId === ordRow!.id),
    ).toBe(true);
  });

  it("hides trashed orders across messages, tickets, notifications (including legacy links), unread counts, global search, portable export & automations, suppresses mail, and restores cleanly", async () => {
    const ord = await ordersMod.orders.create(zeus.principal, {
      projectName: "Ice Queen Trashed Order",
      items: [{ productPublicId, quantity: 1 }],
      idempotencyKey: nextIdemKey("ord"),
    });
    const [ordRow] = await tdb.db
      .select({ id: orderTables.orders.id })
      .from(orderTables.orders)
      .where(eq(orderTables.orders.publicId, ord.publicId));

    // Customer & staff exchange order messages with unique search token
    await callerFor(zeus.principal).engagement.messages.send({
      orderId: ord.publicId,
      body: "UniqueOrderMsgToken991 for Ice Queen.",
      idempotencyKey: nextIdemKey("msg"),
    });
    await callerFor(staff.principal).engagement.messages.send({
      orderId: ord.publicId,
      body: "Staff reply creating unread receipt and notification.",
      visibility: "customer",
      idempotencyKey: nextIdemKey("msg"),
    });

    // Order-linked ticket with unique search token
    const tktCreated = await callerFor(zeus.principal).engagement.tickets.create({
      subject: "UniqueOrderTktToken992 support",
      category: "order",
      relatedOrderId: ord.publicId,
      body: "Order-linked ticket body for Ice Queen.",
      idempotencyKey: nextIdemKey("tkt"),
    });
    const tkt = tktCreated.ticket;
    const [tktRow] = await tdb.db
      .select({ id: engagementTables.engagementSupportTickets.id })
      .from(engagementTables.engagementSupportTickets)
      .where(eq(engagementTables.engagementSupportTickets.publicId, tkt.publicId));

    // Insert a legacy pre-0009 unread notification that only has `link` (orderId = null, ticketId = null)
    await tdb.db.insert(engagementTables.engagementNotifications).values({
      publicId: ulid(),
      userId: zeus.id,
      kind: "orders.status",
      category: "order",
      staffOnly: false,
      title: "Legacy Order Link Notification",
      body: "Legacy row without order_id column populated yet.",
      link: `/orders/${ord.publicId}`,
      orderId: null,
      ticketId: null,
      createdAt: h.clock.now(),
    });

    // Sanity before trash: visible in threads, tickets, notifications, and global search
    expect(
      (await callerFor(zeus.principal).engagement.messages.threads({})).items.some(
        (i) => i.orderPublicId === ord.publicId,
      ),
    ).toBe(true);
    expect(
      (await callerFor(zeus.principal).engagement.tickets.list({})).items.some((i) => i.publicId === tkt.publicId),
    ).toBe(true);

    // Move order to Trash
    const now = h.clock.now();
    await tdb.db
      .update(orderTables.orders)
      .set({ trashedAt: now })
      .where(eq(orderTables.orders.id, ordRow!.id));

    // 1. Messages: hidden from customer threads & staff adminInbox; direct read/write returns NOT_FOUND
    expect(
      (await callerFor(zeus.principal).engagement.messages.threads({})).items.some(
        (i) => i.orderPublicId === ord.publicId,
      ),
    ).toBe(false);
    expect(
      (await callerFor(staff.principal).engagement.messages.adminInbox({})).items.some(
        (i) => i.orderPublicId === ord.publicId,
      ),
    ).toBe(false);
    await expect(
      callerFor(zeus.principal).engagement.messages.listByOrder({ orderId: ord.publicId }),
    ).rejects.toThrow();
    await expect(
      callerFor(staff.principal).engagement.messages.send({
        orderId: ord.publicId,
        body: "Should fail",
        visibility: "customer",
        idempotencyKey: nextIdemKey("msg"),
      }),
    ).rejects.toThrow();

    // 2. Tickets: hidden from customer & staff lists, get, reply, and automation creation
    expect(
      (await callerFor(zeus.principal).engagement.tickets.list({})).items.some((i) => i.publicId === tkt.publicId),
    ).toBe(false);
    expect(
      (await callerFor(staff.principal).engagement.tickets.admin.list({})).items.some(
        (i) => i.publicId === tkt.publicId,
      ),
    ).toBe(false);
    await expect(callerFor(zeus.principal).engagement.tickets.get({ ticketId: tkt.publicId })).rejects.toThrow();
    await expect(callerFor(staff.principal).engagement.tickets.admin.get({ ticketId: tkt.publicId })).rejects.toThrow();
    await expect(
      engagement.createAutomationTicket({
        requesterUserId: zeus.id,
        category: "order",
        priority: "normal",
        relatedOrderPublicId: ord.publicId,
        subject: "Auto ticket on trashed order",
        body: "Blocked because order is in Trash.",
        idempotencyKey: nextIdemKey("auto"),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", reasonCode: "ORDER_NOT_FOUND" });

    // 3. Notifications & unread count: both explicit orderId notifications AND backfilled legacy link notifications are hidden
    const zeusNotifsWhileTrashed = await callerFor(zeus.principal).engagement.notifications.list({});
    expect(zeusNotifsWhileTrashed.items.some((n) => n.link === `/orders/${ord.publicId}`)).toBe(false);
    const unreadWhileTrashed = await callerFor(zeus.principal).engagement.notifications.unreadCount();
    expect(zeusNotifsWhileTrashed.items.filter((n) => n.readAt === null).length).toBe(
      unreadWhileTrashed.unreadCount,
    );

    // 4. Global search: zero hits for trashed order, its messages, or its linked ticket
    const staffMsgSearch = await callerFor(staff.principal).engagement.search.query({
      query: "UniqueOrderMsgToken991",
    });
    expect(staffMsgSearch.messages).toHaveLength(0);
    const staffTktSearch = await callerFor(staff.principal).engagement.search.query({
      query: "UniqueOrderTktToken992",
    });
    expect(staffTktSearch.tickets).toHaveLength(0);
    const staffOrdSearch = await callerFor(staff.principal).engagement.search.query({
      query: ord.reference,
    });
    expect(staffOrdSearch.orders).toHaveLength(0);

    // 5. Portable export excludes trashed order messages & tickets
    const portableMsgs = await engagement.portableOrderMessages(tdb.db, {
      orderPublicIds: [ord.publicId],
      limit: 50,
    });
    expect(portableMsgs.items).toHaveLength(0);
    const portableTkts = await engagement.portableTickets(tdb.db, {
      customerUserIds: [zeus.id],
      orderPublicIds: [ord.publicId],
      limit: 50,
    });
    expect(portableTkts.items.some((st) => st.publicId === tkt.publicId)).toBe(false);

    // 6. Suppresses notifications & mail for trashed order or trashed ticket
    h.mailer.sent = [];
    const suppressedOrderNotif = await engagement.notify({
      userId: zeus.id,
      kind: "order.status_changed",
      orderId: ordRow!.id,
      title: "Should not send",
      body: "Trashed order.",
    });
    expect(suppressedOrderNotif).toEqual({ publicId: "", deliveredInApp: false, enqueuedEmail: false });
    const suppressedTicketNotif = await engagement.notify({
      userId: zeus.id,
      kind: "ticket.updated",
      ticketId: tktRow!.id,
      title: "Should not send",
      body: "Ticket on trashed order.",
    });
    expect(suppressedTicketNotif).toEqual({ publicId: "", deliveredInApp: false, enqueuedEmail: false });
    expect(h.mailer.sent).toHaveLength(0);

    // 7. Restore order -> thread, ticket, notifications, and search hits reappear intact
    await tdb.db
      .update(orderTables.orders)
      .set({ trashedAt: null })
      .where(eq(orderTables.orders.id, ordRow!.id));

    expect(
      (await callerFor(zeus.principal).engagement.messages.threads({})).items.some(
        (i) => i.orderPublicId === ord.publicId,
      ),
    ).toBe(true);
    expect(
      (await callerFor(zeus.principal).engagement.tickets.list({})).items.some((i) => i.publicId === tkt.publicId),
    ).toBe(true);
    expect(
      (await callerFor(zeus.principal).engagement.notifications.list({})).items.some(
        (n) => n.link === `/orders/${ord.publicId}`,
      ),
    ).toBe(true);
    expect(
      (await callerFor(staff.principal).engagement.search.query({ query: "UniqueOrderMsgToken991" })).messages.length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("hides trashed customers across engagement surfaces, partitions summarize without double-counting, and purges order + customer fail-closed & idempotently", async () => {
    const participant = trashRegistry.participants().find((p) => p.module === "engagement")!;

    const cust = await insertSyntheticUser(h, tdb.db, {
      role: "customer",
      name: "Helena Frost",
      customerRef: "RPCUS-H9F8E7D6C",
    });

    // Save custom notification preference so customer purge has preferences to erase
    await callerFor(cust.principal).engagement.notifications.preferences.update({
      category: "order",
      inApp: true,
      email: false,
    });

    const ord = await ordersMod.orders.create(cust.principal, {
      projectName: "Ice Queen Customer Purge",
      items: [{ productPublicId, quantity: 1 }],
      idempotencyKey: nextIdemKey("ord"),
    });
    const [ordRow] = await tdb.db
      .select({ id: orderTables.orders.id })
      .from(orderTables.orders)
      .where(eq(orderTables.orders.publicId, ord.publicId));

    await callerFor(cust.principal).engagement.messages.send({
      orderId: ord.publicId,
      body: "UniqueCustOrderMsgToken771",
      idempotencyKey: nextIdemKey("msg"),
    });

    const orderTicket = (
      await callerFor(cust.principal).engagement.tickets.create({
        subject: "UniqueCustOrderTkt772",
        category: "order",
        relatedOrderId: ord.publicId,
        body: "Order-linked ticket body.",
        idempotencyKey: nextIdemKey("tkt"),
      })
    ).ticket;

    const standaloneTicket = (
      await callerFor(cust.principal).engagement.tickets.create({
        subject: "UniqueCustStandaloneTkt773",
        category: "account",
        body: "Standalone customer ticket without an order.",
        idempotencyKey: nextIdemKey("tkt"),
      })
    ).ticket;

    // Summarize partitioning before purge:
    // - Order owns 1 message + 1 order-linked ticket
    // - Customer owns 0 non-order messages + 1 standalone ticket (no double-counting with non-purged order!)
    const batchId = ulid();
    const orderSummary = await participant.summarize!({
      kind: "order",
      id: ordRow!.id,
      publicId: ord.publicId,
      batchId,
    });
    expect(orderSummary).toEqual({ messages: 1, tickets: 1 });

    const custSummary = await participant.summarize!({
      kind: "customer",
      id: cust.id,
      publicId: cust.publicId,
      batchId,
    });
    expect(custSummary).toEqual({ messages: 0, tickets: 1 });

    // Move customer to Trash (even before order row itself has trashedAt set, customer gate hides everything!)
    const now = h.clock.now();
    await tdb.db.update(users).set({ trashedAt: now }).where(eq(users.id, cust.id));

    // Customer reads return empty/zero and customer writes are refused in-tx
    expect((await callerFor(cust.principal).engagement.tickets.list({})).items).toHaveLength(0);
    expect((await callerFor(cust.principal).engagement.notifications.unreadCount()).unreadCount).toBe(0);
    await expect(
      callerFor(cust.principal).engagement.tickets.create({
        subject: "Blocked while trashed",
        category: "account",
        body: "Trashed customer cannot open tickets.",
        idempotencyKey: nextIdemKey("tkt"),
      }),
    ).rejects.toThrow();

    // Staff cannot see trashed customer's tickets, threads, or global search hits
    const adminTickets = await callerFor(staff.principal).engagement.tickets.admin.list({});
    expect(
      adminTickets.items.some(
        (t) => t.publicId === orderTicket.publicId || t.publicId === standaloneTicket.publicId,
      ),
    ).toBe(false);
    expect(
      (await callerFor(staff.principal).engagement.messages.adminInbox({})).items.some(
        (i) => i.orderPublicId === ord.publicId,
      ),
    ).toBe(false);
    const staffSearch = await callerFor(staff.principal).engagement.search.query({ query: "Helena Frost" });
    expect(staffSearch.customers).toHaveLength(0);
    expect(
      (await callerFor(staff.principal).engagement.search.query({ query: "UniqueCustStandaloneTkt773" })).tickets,
    ).toHaveLength(0);

    // Notifications & mail suppressed for trashed customer; automation ticket refused
    h.mailer.sent = [];
    expect(
      await engagement.notify({
        userId: cust.id,
        kind: "security.notice",
        title: "Suppressed",
        body: "Suppressed",
      }),
    ).toEqual({ publicId: "", deliveredInApp: false, enqueuedEmail: false });
    expect(h.mailer.sent).toHaveLength(0);

    await expect(
      engagement.createAutomationTicket({
        requesterUserId: cust.id,
        category: "account",
        priority: "normal",
        subject: "Blocked automation ticket",
        body: "Blocked because customer is in Trash.",
        idempotencyKey: nextIdemKey("auto"),
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      reasonCode: "AUTOMATION_TICKET_REQUESTER_INACTIVE",
    });

    // Purge fails closed for order and customer when purgeStartedAt is missing
    await tdb.db
      .update(orderTables.orders)
      .set({ trashedAt: now })
      .where(eq(orderTables.orders.id, ordRow!.id));

    const runMeta = { runId: ulid() };

    await expect(
      participant.purge!({ kind: "order", id: ordRow!.id, publicId: ord.publicId, batchId }, runMeta),
    ).rejects.toMatchObject({ code: "CONFLICT", reasonCode: "ORDER_PURGE_NOT_STARTED" });

    await expect(
      participant.purge!({ kind: "customer", id: cust.id, publicId: cust.publicId, batchId }, runMeta),
    ).rejects.toMatchObject({ code: "CONFLICT", reasonCode: "PURGE_NOT_STARTED" });

    // Authorize & purge order first (matching Trash service customer-purge sequence: orders -> customer), then replay
    await tdb.db
      .update(orderTables.orders)
      .set({ purgeStartedAt: now, purgedAt: now })
      .where(eq(orderTables.orders.id, ordRow!.id));

    const ordPurge1 = await participant.purge!(
      { kind: "order", id: ordRow!.id, publicId: ord.publicId, batchId },
      runMeta,
    );
    expect(ordPurge1.deleted.messages).toBe(1);
    expect(ordPurge1.deleted.tickets).toBe(1);

    const ordPurge2 = await participant.purge!(
      { kind: "order", id: ordRow!.id, publicId: ord.publicId, batchId },
      runMeta,
    );
    expect(ordPurge2.deleted).toEqual({});

    // Authorize & purge customer, then replay
    await tdb.db
      .update(users)
      .set({ purgeStartedAt: now, purgedAt: now })
      .where(eq(users.id, cust.id));

    const custPurge1 = await participant.purge!(
      { kind: "customer", id: cust.id, publicId: cust.publicId, batchId },
      runMeta,
    );
    expect(custPurge1.deleted.tickets).toBe(1);
    expect(custPurge1.deleted.notificationPreferences).toBe(1);

    const custPurge2 = await participant.purge!(
      { kind: "customer", id: cust.id, publicId: cust.publicId, batchId },
      runMeta,
    );
    expect(custPurge2.deleted).toEqual({});
  });
});
