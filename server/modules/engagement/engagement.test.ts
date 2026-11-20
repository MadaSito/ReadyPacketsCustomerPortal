import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDeps, fakePrincipal, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import type { UserRole } from "../../../shared/domain.js";
import type { Services } from "../../container.js";
import { AuditUnavailableError, DomainError, forbidden, notFound } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { Db, DbOrTx, SessionPrincipal, Tx } from "../../core/types.js";
import { createCallerFactory, router, type TrpcContext } from "../../trpc/trpc.js";
import type { FileRecord } from "../files/index.js";
import { users, type UserStatus } from "../identity/schema.js";
import { createOrdersModule, type OrdersModule } from "../orders/index.js";
import * as orderTables from "../orders/schema.js";
import { createSettingsStore } from "../platform/settingsStore.js";
import { platformSettings } from "../platform/schema.js";
import {
  createEngagementModule,
  NOTIFICATIONS_RETENTION_JOB_TYPE,
  type EngagementModule,
} from "./index.js";
import { engagementRouter } from "./router.js";
import * as engagementTables from "./schema.js";
import {
  ENGAGEMENT_NOTIFICATIONS_EMAIL_ENABLED,
  ENGAGEMENT_NOTIFICATIONS_RETENTION_DAYS,
  ENGAGEMENT_TICKETS_REOPEN_WINDOW_DAYS,
} from "./settings.js";

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
  const email = `eng.user.${userSeq}@synthetic.test`;
  const name = opts.name ?? `Synthetic Person ${userSeq}`;
  const customerRef = opts.customerRef ?? (role === "customer" ? `CUST-SYN-${String(userSeq).padStart(4, "0")}` : null);

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

class SyntheticFilesPeer {
  records = new Map<string, FileRecord>();

  register(file: {
    publicId: string;
    orderPublicId: string;
    displayName: string;
    visibility?: "customer_visible" | "staff_only";
    size?: number;
    contentType?: string;
  }): FileRecord {
    const rec: FileRecord = {
      publicId: file.publicId,
      logicalPublicId: file.publicId,
      orderPublicId: file.orderPublicId,
      phasePublicId: null,
      statusKey: null,
      displayName: file.displayName,
      category: "supporting",
      visibility: file.visibility ?? "customer_visible",
      size: file.size ?? 2048,
      sha256: "a".repeat(64),
      contentType: file.contentType ?? "application/pdf",
      extension: "pdf",
      version: 1,
      createdAt: new Date("2026-11-20T12:00:00.000Z"),
      supersededAt: null,
      deletedAt: null,
    };
    this.records.set(rec.publicId, rec);
    return rec;
  }

  async assertCanReadFile(
    principal: SessionPrincipal,
    filePublicId: string,
    orderPublicId?: string,
  ): Promise<FileRecord> {
    const rec = this.records.get(filePublicId);
    if (!rec || rec.deletedAt !== null) {
      throw notFound("FILE_NOT_FOUND");
    }
    if (orderPublicId && rec.orderPublicId !== orderPublicId) {
      throw notFound("FILE_NOT_FOUND");
    }
    if (rec.visibility === "staff_only" && principal.role === "customer") {
      throw forbidden("STAFF_ONLY_FILE");
    }
    return rec;
  }

  async reassignOrderFiles(): Promise<void> {}
}

function buildIdentityPeer(
  h: TestHarness,
  db: Db,
  revokedSessions: Set<string>,
) {
  const toUserSummary = (row: typeof users.$inferSelect) => ({
    id: row.id,
    publicId: row.publicId,
    role: row.role,
    status: row.status,
    email: h.deps.crypto.decrypt(row.emailEnc, `users.email:${row.publicId}`),
    name: h.deps.crypto.decrypt(row.nameEnc, `users.name:${row.publicId}`),
    customerRef: row.customerRef,
    emailVerified: row.emailVerifiedAt !== null,
  });

  return {
    searchCustomersCalls: 0,
    assertCurrentSawTx: [] as boolean[],
    async getUser(userId: number, opts?: { tx?: DbOrTx }) {
      const [row] = await (opts?.tx ?? db).select().from(users).where(eq(users.id, userId)).limit(1);
      return row ? toUserSummary(row) : null;
    },
    async getUserByPublicId(publicId: string, opts?: { tx?: DbOrTx }) {
      const [row] = await (opts?.tx ?? db).select().from(users).where(eq(users.publicId, publicId)).limit(1);
      return row ? toUserSummary(row) : null;
    },
    async searchCustomers(
      principal: SessionPrincipal,
      input: { query?: string; limit?: number },
    ) {
      this.searchCustomersCalls += 1;
      if (principal.role === "customer") {
        throw forbidden("CUSTOMERS_READ_DENIED");
      }
      const allRows = await db.select().from(users).where(eq(users.role, "customer")).limit(50);
      const q = (input.query ?? "").toLowerCase();
      const matched = allRows
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
        if (revokedSessions.has(principal.sessionId)) {
          throw new DomainError(
            "UNAUTHENTICATED",
            "SESSION_NOT_CURRENT",
            "Your session is no longer active. Please sign in again.",
          );
        }
        const [u] = await tx.select().from(users).where(eq(users.id, principal.userId)).limit(1);
        if (!u || u.status !== "active" || u.role !== principal.role) {
          throw new DomainError(
            "UNAUTHENTICATED",
            "SESSION_NOT_CURRENT",
            "Your session is no longer active. Please sign in again.",
          );
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

let keyCounter = 0;
function nextIdemKey(prefix = "eng"): string {
  keyCounter += 1;
  return `${prefix}_idem_${keyCounter}_0123456789`;
}

describe("engagement module — messages, tickets, notifications, bounded search, portable & security invariants", () => {
  let tdb: TestDb;
  let h: TestHarness;
  let ordersMod: OrdersModule;
  let engagement: EngagementModule;
  let filesPeer: SyntheticFilesPeer;
  let identityPeer: ReturnType<typeof buildIdentityPeer>;
  let revokedSessions: Set<string>;

  let admin: SyntheticUser;
  let staff: SyntheticUser;
  let staffTwo: SyntheticUser;
  let alice: SyntheticUser;
  let bobContributor: SyntheticUser;
  let carolViewer: SyntheticUser;
  let eveOutsider: SyntheticUser;
  let catalogProductPublicId: string;

  const callerFor = (session: SessionPrincipal | null) =>
    createCaller({
      services: h.services,
      session,
      request: newRequestContext("test"),
      transport: { issue() {}, clear() {} },
    } satisfies TrpcContext);

  async function createAliceOrder(projectName = "Packet Alpha Filing") {
    return ordersMod.orders.create(alice.principal, {
      projectName,
      items: [{ productPublicId: catalogProductPublicId, quantity: 1 }],
      idempotencyKey: nextIdemKey("ord"),
    });
  }

  beforeAll(async () => {
    tdb = await createTestDb({ schema: testSchema });
    h = createTestDeps({ db: tdb.db });
    revokedSessions = new Set<string>();
    filesPeer = new SyntheticFilesPeer();
    identityPeer = buildIdentityPeer(h, tdb.db, revokedSessions);

    h.services.identity = identityPeer as unknown as Services["identity"];
    h.services.files = filesPeer as unknown as Services["files"];
    ordersMod = createOrdersModule(h.deps);
    h.services.orders = ordersMod;
    engagement = createEngagementModule(h.deps);
    h.services.engagement = engagement;

    admin = await insertSyntheticUser(h, tdb.db, { role: "admin", name: "Ada Admin", stepUp: true });
    staff = await insertSyntheticUser(h, tdb.db, { role: "staff", name: "Sam Staff" });
    staffTwo = await insertSyntheticUser(h, tdb.db, { role: "staff", name: "Taylor Support" });
    alice = await insertSyntheticUser(h, tdb.db, {
      role: "customer",
      name: "Alice Monroe",
      customerRef: "CUST-ALICE-01",
    });
    bobContributor = await insertSyntheticUser(h, tdb.db, {
      role: "customer",
      name: "Bob Contributor",
      customerRef: "CUST-BOB-02",
    });
    carolViewer = await insertSyntheticUser(h, tdb.db, {
      role: "customer",
      name: "Carol Viewer",
      customerRef: "CUST-CAROL-03",
    });
    eveOutsider = await insertSyntheticUser(h, tdb.db, {
      role: "customer",
      name: "Eve Outsider",
      customerRef: "CUST-EVE-04",
    });

    const group = await ordersMod.catalog.createGroup(admin.principal, {
      name: "Standard Packets",
      description: "Synthetic test group",
      sortOrder: 0,
      active: true,
    });
    const product = await ordersMod.catalog.createProduct(admin.principal, {
      groupId: group.publicId,
      productKey: "std-packet",
      sortOrder: 0,
      active: true,
      name: "Standard Packet",
      description: "Synthetic test product",
      features: ["Document review"],
      priceMinor: 25000,
      currency: "USD",
    });
    catalogProductPublicId = product.publicId;
  });

  beforeEach(async () => {
    h.audit.clear();
    h.mailer.sent = [];
    revokedSessions.clear();
    identityPeer.searchCustomersCalls = 0;
    await h.settings.set(ENGAGEMENT_NOTIFICATIONS_EMAIL_ENABLED.key, true);
  });

  afterAll(async () => {
    await tdb.cleanup();
  });

  describe("order messages — threads, grants, locks, internal notes, attachments, XSS & content-free mail", () => {
    it("supports owner, contributor, viewer (read-only), staff internal notes, unread receipts, and idempotency", async () => {
      const order = await createAliceOrder("Harbor Permit Packet");

      // Share order with Bob (contributor) and Carol (viewer)
      const bobGrant = await ordersMod.sharing.invite(alice.principal, {
        orderId: order.publicId,
        email: bobContributor.email,
        role: "contributor",
      });
      await ordersMod.sharing.respond(bobContributor.principal, { grantId: bobGrant.publicId, accept: true });

      const carolGrant = await ordersMod.sharing.invite(alice.principal, {
        orderId: order.publicId,
        email: carolViewer.email,
        role: "viewer",
      });
      await ordersMod.sharing.respond(carolViewer.principal, { grantId: carolGrant.publicId, accept: true });

      // Register a customer-visible file on the order and attach it to Alice's message
      const fileId = ulid(h.clock.now().getTime() + 500);
      filesPeer.register({
        publicId: fileId,
        orderPublicId: order.publicId,
        displayName: "signed-checklist.pdf",
        visibility: "customer_visible",
      });

      const aliceCaller = callerFor(alice.principal);
      const idem = nextIdemKey("msg");
      const sent1 = await aliceCaller.engagement.messages.send({
        orderId: order.publicId,
        body: "Hello team — attached is our signed checklist.",
        attachmentFileIds: [fileId],
        idempotencyKey: idem,
      });
      expect(sent1.body).toBe("Hello team — attached is our signed checklist.");
      expect(sent1.visibility).toBe("customer");
      expect(sent1.unread).toBe(false); // Author's own message is marked read immediately
      expect(sent1.attachments).toEqual([
        expect.objectContaining({
          filePublicId: fileId,
          displayName: "signed-checklist.pdf",
          available: true,
        }),
      ]);

      // Idempotent replay returns exact same message without extra audit event
      const auditCountBeforeReplay = h.audit.named("engagement.message.sent").length;
      const replay = await aliceCaller.engagement.messages.send({
        orderId: order.publicId,
        body: "Hello team — attached is our signed checklist.",
        attachmentFileIds: [fileId],
        idempotencyKey: idem,
      });
      expect(replay.publicId).toBe(sent1.publicId);
      expect(h.audit.named("engagement.message.sent")).toHaveLength(auditCountBeforeReplay);

      // Staff posts a customer-visible reply AND an internal note
      const staffCaller = callerFor(staff.principal);
      const staffPublicReply = await staffCaller.engagement.messages.send({
        orderId: order.publicId,
        body: "Thank you Alice, we have started reviewing page 2.",
        visibility: "customer",
        idempotencyKey: nextIdemKey("msg"),
      });
      const staffInternalNote = await staffCaller.engagement.messages.send({
        orderId: order.publicId,
        body: "INTERNAL QA NOTE: verify notary stamp expiration with supervisor.",
        visibility: "internal",
        idempotencyKey: nextIdemKey("msg"),
      });
      expect(staffInternalNote.visibility).toBe("internal");

      // Content-free email check: outbound mail NEVER contains message body text!
      const orderMails = h.mailer.sent.filter((m) => m.template === "engagement.order_message_received");
      expect(orderMails.length).toBeGreaterThanOrEqual(1);
      for (const mail of orderMails) {
        const tmpl = h.mailer.templates.get(mail.template)!;
        const renderedSubject = tmpl.subject(mail.vars);
        const renderedBody = tmpl.text(mail.vars);
        expect(renderedSubject).not.toContain("reviewing page 2");
        expect(renderedBody).not.toContain("reviewing page 2");
        expect(renderedBody).not.toContain("INTERNAL QA NOTE");
        expect(renderedBody).toContain(order.reference);
      }

      // Alice sees 2 customer messages (NEVER the internal note) and unreadCount === 1 (staffPublicReply)
      const aliceUnread = await aliceCaller.engagement.messages.unreadSummary({ orderId: order.publicId });
      expect(aliceUnread.totalUnread).toBe(1);

      const aliceList = await aliceCaller.engagement.messages.listByOrder({ orderId: order.publicId });
      expect(aliceList.items).toHaveLength(2);
      expect(aliceList.items.some((m) => m.visibility === "internal")).toBe(false);
      expect(aliceList.items.some((m) => m.body.includes("INTERNAL QA NOTE"))).toBe(false);

      // Staff sees all 3 messages including internal note
      const staffList = await staffCaller.engagement.messages.listByOrder({ orderId: order.publicId });
      expect(staffList.items).toHaveLength(3);
      expect(staffList.items.some((m) => m.publicId === staffInternalNote.publicId)).toBe(true);

      // Mark order read for Alice → unread drops to 0 and staff sees recipient read receipt (1)
      const staffListBeforeRead = await staffCaller.engagement.messages.listByOrder({ orderId: order.publicId });
      expect(staffListBeforeRead.items.find((m) => m.publicId === staffPublicReply.publicId)!.readReceiptsCount).toBe(0);

      const marked = await aliceCaller.engagement.messages.markOrderRead({ orderId: order.publicId });
      expect(marked.markedCount).toBe(1);
      expect((await aliceCaller.engagement.messages.unreadSummary({ orderId: order.publicId })).totalUnread).toBe(0);

      const staffListAfterRead = await staffCaller.engagement.messages.listByOrder({ orderId: order.publicId });
      const refreshedReply = staffListAfterRead.items.find((m) => m.publicId === staffPublicReply.publicId)!;
      expect(refreshedReply.readReceiptsCount).toBe(1);

      // Bob (contributor) CAN post a message
      const bobCaller = callerFor(bobContributor.principal);
      const bobMsg = await bobCaller.engagement.messages.send({
        orderId: order.publicId,
        body: "Contributor update: uploaded exhibit B.",
        idempotencyKey: nextIdemKey("msg"),
      });
      expect(bobMsg.authorRole).toBe("customer");

      // Carol (viewer) CAN read messages, CANNOT post (`GRANT_READ_ONLY`)
      const carolCaller = callerFor(carolViewer.principal);
      const carolList = await carolCaller.engagement.messages.listByOrder({ orderId: order.publicId });
      expect(carolList.items).toHaveLength(3);
      await expect(
        carolCaller.engagement.messages.send({
          orderId: order.publicId,
          body: "Viewer trying to write",
          idempotencyKey: nextIdemKey("msg"),
        }),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        cause: expect.objectContaining({ reasonCode: "GRANT_READ_ONLY" }),
      });

      // Revoking Bob's grant immediately revokes read, write, threads, and unread counts
      await ordersMod.sharing.revoke(alice.principal, { orderId: order.publicId, grantId: bobGrant.publicId });
      await expect(
        bobCaller.engagement.messages.listByOrder({ orderId: order.publicId }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        bobCaller.engagement.messages.send({
          orderId: order.publicId,
          body: "Post-revocation attempt",
          idempotencyKey: nextIdemKey("msg"),
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      const bobThreads = await bobCaller.engagement.messages.threads({});
      expect(bobThreads.items.find((t) => t.orderPublicId === order.publicId)).toBeUndefined();
    });

    it("enforces negative authorization: unrelated customer, internal note by customer, staff-only file, and all order lock states", async () => {
      const order = await createAliceOrder("Locked Order Suite");
      const aliceCaller = callerFor(alice.principal);
      const eveCaller = callerFor(eveOutsider.principal);
      const adminCaller = callerFor(admin.principal);

      await aliceCaller.engagement.messages.send({
        orderId: order.publicId,
        body: "Initial owner message before lock.",
        idempotencyKey: nextIdemKey("msg"),
      });

      // Unrelated customer Eve gets NOT_FOUND on read, send, markOrderRead
      await expect(eveCaller.engagement.messages.listByOrder({ orderId: order.publicId })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(
        eveCaller.engagement.messages.send({
          orderId: order.publicId,
          body: "Intruder message",
          idempotencyKey: nextIdemKey("msg"),
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(eveCaller.engagement.messages.markOrderRead({ orderId: order.publicId })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });

      // Customer attempting `visibility: "internal"` is forbidden and audited
      await expect(
        aliceCaller.engagement.messages.send({
          orderId: order.publicId,
          body: "Trying to post internal note as customer",
          visibility: "internal",
          idempotencyKey: nextIdemKey("msg"),
        }),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        cause: expect.objectContaining({ reasonCode: "INTERNAL_VISIBILITY_DENIED" }),
      });
      expect(h.audit.named("authz.engagement.denied")).toEqual(
        expect.arrayContaining([expect.objectContaining({ reasonCode: "INTERNAL_VISIBILITY_DENIED" })]),
      );

      // Staff-only file cannot be attached to a customer-visible message even by staff!
      const staffOnlyFileId = ulid(h.clock.now().getTime() + 900);
      filesPeer.register({
        publicId: staffOnlyFileId,
        orderPublicId: order.publicId,
        displayName: "internal-worksheet.pdf",
        visibility: "staff_only",
      });
      await expect(
        adminCaller.engagement.messages.send({
          orderId: order.publicId,
          body: "Accidental attachment of staff-only file to customer thread",
          visibility: "customer",
          attachmentFileIds: [staffOnlyFileId],
          idempotencyKey: nextIdemKey("msg"),
        }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        cause: expect.objectContaining({ reasonCode: "STAFF_FILE_ON_CUSTOMER_MESSAGE" }),
      });

      // Every lock state (`review`, `finalized`, `legal_hold`) blocks posting while allowing read
      for (const lockState of ["review", "finalized", "legal_hold"] as const) {
        const currentView = await ordersMod.assertCanReadOrder(admin.principal, order.publicId);
        await ordersMod.orders.setLock(admin.principal, {
          orderId: order.publicId,
          expectedVersion: currentView.version,
          lockState,
          reasonCode: "SECURITY_TEST",
        });

        await expect(
          aliceCaller.engagement.messages.send({
            orderId: order.publicId,
            body: `Blocked write during ${lockState}`,
            idempotencyKey: nextIdemKey("msg"),
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" });

        // Reading while locked remains allowed
        const readWhileLocked = await aliceCaller.engagement.messages.listByOrder({ orderId: order.publicId });
        expect(readWhileLocked.items.length).toBeGreaterThanOrEqual(1);
      }
    });

    it("stores XSS payloads encrypted at rest and returns them verbatim as inert NFC plain text", async () => {
      const order = await createAliceOrder("XSS Hardening Order");
      const aliceCaller = callerFor(alice.principal);
      const xssPayload = `<script>alert("xss")</script><img src=x onerror="fetch('//evil.test')">Cafe\u0301`;

      const msg = await aliceCaller.engagement.messages.send({
        orderId: order.publicId,
        body: xssPayload,
        idempotencyKey: nextIdemKey("xss"),
      });

      // NFC normalized ("Café"), literal angle brackets preserved as plain text (never HTML-stripped or executed)
      expect(msg.body).toBe(`<script>alert("xss")</script><img src=x onerror="fetch('//evil.test')">Café`);

      // Raw DB column is AES-256-GCM ciphertext (`rpenc:v1:...`), never plaintext
      const [rawRow] = await tdb.db
        .select()
        .from(engagementTables.engagementOrderMessages)
        .where(eq(engagementTables.engagementOrderMessages.publicId, msg.publicId));
      expect(rawRow!.bodyEnc.startsWith("rpenc:v1:")).toBe(true);
      expect(rawRow!.bodyEnc).not.toContain("<script>");
    });
  });

  describe("support tickets — lifecycle, internal notes, assignment, reopen window & cross-tenant isolation", () => {
    it("runs full customer & staff lifecycle, enforces reopen window & closed finality, and isolates tenants", async () => {
      const aliceOrder = await createAliceOrder("Ticket Linked Order");
      const aliceCaller = callerFor(alice.principal);
      const eveCaller = callerFor(eveOutsider.principal);
      const staffCaller = callerFor(staff.principal);

      // Customer cannot create a ticket linked to someone else's order
      const eveOrder = await ordersMod.orders.create(eveOutsider.principal, {
        projectName: "Eve Secret Order",
        items: [{ productPublicId: catalogProductPublicId, quantity: 1 }],
        idempotencyKey: nextIdemKey("ord"),
      });
      await expect(
        aliceCaller.engagement.tickets.create({
          subject: "Trying to probe Eve order",
          category: "order",
          body: "Can you tell me about this order?",
          relatedOrderId: eveOrder.publicId,
          idempotencyKey: nextIdemKey("tkt"),
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      // Alice creates a valid ticket linked to her own order
      const created = await aliceCaller.engagement.tickets.create({
        subject: "Question about notarized exhibit formatting",
        category: "order",
        body: "Should exhibit C be uploaded as single PDF or separate pages?",
        relatedOrderId: aliceOrder.publicId,
        idempotencyKey: nextIdemKey("tkt"),
      });
      expect(created.ticket.status).toBe("open");
      expect(created.ticket.relatedOrderReference).toBe(aliceOrder.reference);
      expect(created.replies).toHaveLength(1);
      expect(created.statusHistory).toHaveLength(1);

      // Cross-tenant isolation: Eve gets NOT_FOUND on get, reply, close, reopen and never sees Alice's ticket in list
      expect((await eveCaller.engagement.tickets.list({})).items).toHaveLength(0);
      await expect(eveCaller.engagement.tickets.get({ ticketId: created.ticket.publicId })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(
        eveCaller.engagement.tickets.reply({
          ticketId: created.ticket.publicId,
          body: "Cross-tenant reply attempt",
          idempotencyKey: nextIdemKey("tkt"),
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        eveCaller.engagement.tickets.close({ ticketId: created.ticket.publicId }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        eveCaller.engagement.tickets.reopen({
          ticketId: created.ticket.publicId,
          reason: "Cross-tenant reopen attempt",
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(h.audit.named("authz.engagement.denied").length).toBeGreaterThanOrEqual(4);

      // Staff assigns ticket to staffTwo (tests ascending userId lock order too!) and sets priority
      const assigned = await staffCaller.engagement.tickets.admin.assign({
        ticketId: created.ticket.publicId,
        assigneeUserId: staffTwo.publicId,
      });
      expect(assigned.ticket.assigneeUserPublicId).toBe(staffTwo.publicId);

      // Assigning to a customer account is rejected
      await expect(
        staffCaller.engagement.tickets.admin.assign({
          ticketId: created.ticket.publicId,
          assigneeUserId: alice.publicId,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });

      const reprioritized = await staffCaller.engagement.tickets.admin.setPriority({
        ticketId: created.ticket.publicId,
        priority: "high",
      });
      expect(reprioritized.ticket.priority).toBe("high");

      // Staff posts an internal note — status stays `open`, customer never sees it, no customer email sent
      h.mailer.sent = [];
      await staffCaller.engagement.tickets.admin.reply({
        ticketId: created.ticket.publicId,
        body: "INTERNAL: checked order template; single PDF is preferred.",
        internalOnly: true,
        idempotencyKey: nextIdemKey("tkt"),
      });
      expect(h.mailer.sent).toHaveLength(0);

      const aliceDetailAfterInternal = await aliceCaller.engagement.tickets.get({
        ticketId: created.ticket.publicId,
      });
      expect(aliceDetailAfterInternal.replies).toHaveLength(1);
      expect(aliceDetailAfterInternal.replies.some((r) => r.internalOnly)).toBe(false);

      // Staff posts a customer-visible reply → transitions to `pending_customer` and sends content-free email
      const afterStaffReply = await staffCaller.engagement.tickets.admin.reply({
        ticketId: created.ticket.publicId,
        body: "Please upload exhibit C as a single combined PDF.",
        internalOnly: false,
        idempotencyKey: nextIdemKey("tkt"),
      });
      expect(afterStaffReply.ticket.status).toBe("pending_customer");
      expect(afterStaffReply.replies).toHaveLength(3); // 2 public + 1 internal visible to staff

      const ticketMail = h.mailer.last("engagement.ticket_updated")!;
      expect(ticketMail).toBeDefined();
      const ticketTemplate = h.mailer.templates.get("engagement.ticket_updated")!;
      expect(ticketTemplate.text(ticketMail.vars)).not.toContain("single combined PDF");
      expect(ticketTemplate.text(ticketMail.vars)).not.toContain("notarized exhibit");

      // Alice replies → transitions `pending_customer` → `pending_staff`
      const afterCustomerReply = await aliceCaller.engagement.tickets.reply({
        ticketId: created.ticket.publicId,
        body: "Combined PDF uploaded — thank you!",
        idempotencyKey: nextIdemKey("tkt"),
      });
      expect(afterCustomerReply.ticket.status).toBe("pending_staff");

      // Staff resolves ticket → customer view reports `canReopen: true`
      const resolved = await staffCaller.engagement.tickets.admin.setStatus({
        ticketId: created.ticket.publicId,
        toStatus: "resolved",
        reasonCode: "ANSWERED",
      });
      expect(resolved.ticket.status).toBe("resolved");
      const aliceResolvedView = await aliceCaller.engagement.tickets.get({ ticketId: created.ticket.publicId });
      expect(aliceResolvedView.canReopen).toBe(true);

      // Advance clock 2 days (within 14-day default reopen window) → Alice reopens
      await h.settings.set(ENGAGEMENT_TICKETS_REOPEN_WINDOW_DAYS.key, 14);
      h.clock.advance(2 * 24 * 60 * 60 * 1000);
      const reopened = await aliceCaller.engagement.tickets.reopen({
        ticketId: created.ticket.publicId,
        reason: "One follow-up question about exhibit D.",
      });
      expect(reopened.ticket.status).toBe("open");

      // Resolve again, then advance past 14-day reopen window → reopen refused (`TICKET_REOPEN_EXPIRED`)
      await staffCaller.engagement.tickets.admin.setStatus({
        ticketId: created.ticket.publicId,
        toStatus: "resolved",
      });
      h.clock.advance(15 * 24 * 60 * 60 * 1000);
      await expect(
        aliceCaller.engagement.tickets.reopen({
          ticketId: created.ticket.publicId,
          reason: "Trying to reopen after 15 days",
        }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        cause: expect.objectContaining({ reasonCode: "TICKET_REOPEN_EXPIRED" }),
      });

      // Customer closes ticket → neither reopen nor customer reply is permitted (`TICKET_REOPEN_DENIED` / `TICKET_CLOSED`)
      const closed = await aliceCaller.engagement.tickets.close({ ticketId: created.ticket.publicId });
      expect(closed.ticket.status).toBe("closed");
      await expect(
        aliceCaller.engagement.tickets.reopen({
          ticketId: created.ticket.publicId,
          reason: "Reopen closed ticket",
        }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        cause: expect.objectContaining({ reasonCode: "TICKET_REOPEN_DENIED" }),
      });
      await expect(
        aliceCaller.engagement.tickets.reply({
          ticketId: created.ticket.publicId,
          body: "Reply on closed ticket",
          idempotencyKey: nextIdemKey("tkt"),
        }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        cause: expect.objectContaining({ reasonCode: "TICKET_CLOSED" }),
      });
    });
  });

  describe("notifications — preferences, mandatory security alerts, link safety & transactional retention", () => {
    it("enforces security in-app lock, safe links, cross-user isolation, and audited FOR UPDATE retention", async () => {
      const aliceCaller = callerFor(alice.principal);
      const eveCaller = callerFor(eveOutsider.principal);

      // Unsafe links (`javascript:`, external URLs, protocol-relative `//`) are rejected
      for (const badLink of ["javascript:alert(1)", "https://evil.example/phish", "//evil.example/x"]) {
        await expect(
          engagement.notify({
            userId: alice.id,
            kind: "order.status_changed",
            title: "Order updated",
            body: "Your order status changed.",
            link: badLink,
          }),
        ).rejects.toMatchObject({ code: "VALIDATION" });
      }

      // Security in-app notifications cannot be turned off
      await expect(
        aliceCaller.engagement.notifications.preferences.update({
          category: "security",
          inApp: false,
          email: true,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });

      // Turn off `order` in-app notifications → `order.status_changed` is suppressed in-app, while `security.mfa_reset` still delivers!
      await aliceCaller.engagement.notifications.preferences.update({
        category: "order",
        inApp: false,
        email: false,
      });

      const suppressed = await engagement.notify({
        userId: alice.id,
        kind: "order.status_changed",
        title: "Order progressed",
        body: "Your order moved to review.",
        link: "/orders",
      });
      expect(suppressed.deliveredInApp).toBe(false);

      const secAlert = await engagement.notify({
        userId: alice.id,
        kind: "security.mfa_reset",
        title: "Authenticator updated",
        body: "Multi-factor authentication was updated on your account.",
        link: "/account/security",
      });
      expect(secAlert.deliveredInApp).toBe(true);

      // Re-enable `order` notifications for subsequent tests
      await aliceCaller.engagement.notifications.preferences.update({
        category: "order",
        inApp: true,
        email: true,
      });

      // Cross-tenant markRead returns NOT_FOUND and audits `authz.engagement.denied`
      await expect(
        eveCaller.engagement.notifications.markRead({ notificationId: secAlert.publicId }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(h.audit.named("authz.engagement.denied")).toEqual(
        expect.arrayContaining([expect.objectContaining({ reasonCode: "CROSS_TENANT_NOTIFICATION" })]),
      );

      // Retention job regression: writes durable audit record in SAME tx BEFORE deleting expired rows
      await h.settings.set(ENGAGEMENT_NOTIFICATIONS_RETENTION_DAYS.key, 30);
      h.clock.advance(35 * 24 * 60 * 60 * 1000);

      // First verify fail-closed: if audit fails, NO notifications are deleted!
      h.audit.failRecords = true;
      await h.jobs.enqueue(NOTIFICATIONS_RETENTION_JOB_TYPE, {});
      await expect(h.jobs.runAll(NOTIFICATIONS_RETENTION_JOB_TYPE)).rejects.toBeInstanceOf(AuditUnavailableError);
      h.audit.failRecords = false;

      const stillPresent = await aliceCaller.engagement.notifications.list({});
      expect(stillPresent.items.some((n) => n.publicId === secAlert.publicId)).toBe(true);

      // Now run retention normally → audit recorded in `tx` (`recordedInTx: true`) and expired rows deleted
      h.audit.clear();
      await h.jobs.enqueue(NOTIFICATIONS_RETENTION_JOB_TYPE, {});
      const [jobResult] = await h.jobs.runAll(NOTIFICATIONS_RETENTION_JOB_TYPE);
      expect(jobResult).toMatchObject({ outcome: "completed" });
      const purgeEvents = h.audit.named("engagement.notifications.retention.purged");
      expect(purgeEvents).toHaveLength(1);
      expect(h.audit.recordedInTx[0]).toBe(true);

      const afterPurge = await aliceCaller.engagement.notifications.list({});
      expect(afterPurge.items.some((n) => n.publicId === secAlert.publicId)).toBe(false);
    });
  });

  describe("bounded search — strict scoping, blind-index matching, LIKE escaping & audited global search", () => {
    it("never leaks other customers' records, internal staff notes, or customer directory to a customer", async () => {
      const aliceOrder = await createAliceOrder("Zephyr Maritime Packet");
      const eveOrder = await ordersMod.orders.create(eveOutsider.principal, {
        projectName: "Obsidian Private Filing",
        items: [{ productPublicId: catalogProductPublicId, quantity: 1 }],
        idempotencyKey: nextIdemKey("ord"),
      });

      const aliceCaller = callerFor(alice.principal);
      const eveCaller = callerFor(eveOutsider.principal);
      const adminCaller = callerFor(admin.principal);

      // Post distinctive words in Alice's message, Eve's message, and a staff internal note on Alice's order
      await aliceCaller.engagement.messages.send({
        orderId: aliceOrder.publicId,
        body: "Please include the Albatross addendum in our filing.",
        idempotencyKey: nextIdemKey("srch"),
      });
      await eveCaller.engagement.messages.send({
        orderId: eveOrder.publicId,
        body: "Confidential Nightingale document ready for Eve.",
        idempotencyKey: nextIdemKey("srch"),
      });
      await adminCaller.engagement.messages.send({
        orderId: aliceOrder.publicId,
        body: "Staff-only Platypus verification note.",
        visibility: "internal",
        idempotencyKey: nextIdemKey("srch"),
      });

      // Eve creates a ticket with distinctive word
      await eveCaller.engagement.tickets.create({
        subject: "Nightingale billing inquiry",
        category: "billing",
        body: "Checking invoice line item for Nightingale.",
        idempotencyKey: nextIdemKey("srch"),
      });

      // 1. Alice finds her own "Albatross" message & "Zephyr" order
      const aliceOwnHit = await aliceCaller.engagement.search.query({ query: "Albatross" });
      expect(aliceOwnHit.messages).toHaveLength(1);
      expect(aliceOwnHit.messages[0]!.orderPublicId).toBe(aliceOrder.publicId);
      expect(aliceOwnHit.meta.globalScope).toBe(false);

      // 2. Alice searching Eve's "Nightingale" or Eve's order reference gets empty results (never existence oracle)
      const aliceCrossTenant = await aliceCaller.engagement.search.query({ query: "Nightingale" });
      expect(aliceCrossTenant.orders).toHaveLength(0);
      expect(aliceCrossTenant.tickets).toHaveLength(0);
      expect(aliceCrossTenant.messages).toHaveLength(0);
      expect(aliceCrossTenant.customers).toHaveLength(0);

      const aliceRefProbe = await aliceCaller.engagement.search.query({ query: eveOrder.reference });
      expect(aliceRefProbe.orders).toHaveLength(0);
      expect(aliceRefProbe.messages).toHaveLength(0);

      // 3. Alice searching staff internal note keyword "Platypus" on HER OWN order gets 0 results!
      const aliceInternalProbe = await aliceCaller.engagement.search.query({ query: "Platypus" });
      expect(aliceInternalProbe.messages).toHaveLength(0);

      // 4. Customer requesting `domains: ["customers"]` gets empty array and NEVER invokes identity.searchCustomers
      identityPeer.searchCustomersCalls = 0;
      const customerDomainAttempt = await aliceCaller.engagement.search.query({
        query: "Monroe",
        domains: ["customers"],
      });
      expect(customerDomainAttempt.customers).toHaveLength(0);
      expect(identityPeer.searchCustomersCalls).toBe(0);

      // 5. SQL LIKE wildcards (`%` and `_`) are escaped and do not dump all tickets/messages
      const wildcardProbe = await aliceCaller.engagement.search.query({ query: "%%__" });
      expect(wildcardProbe.tickets).toHaveLength(0);
      expect(wildcardProbe.messages).toHaveLength(0);

      // 6. Admin with `search.global` + `customers.read_all` finds Eve's records, internal notes, and customers,
      //    and emits `engagement.search.executed` WITHOUT logging the query string!
      h.audit.clear();
      const adminHit = await adminCaller.engagement.search.query({
        query: "Monroe",
        domains: ["customers"],
      });
      expect(adminHit.meta.globalScope).toBe(true);
      expect(adminHit.customers.some((c) => c.publicId === alice.publicId)).toBe(true);

      const adminInternalHit = await adminCaller.engagement.search.query({ query: "Platypus" });
      expect(adminInternalHit.messages).toHaveLength(1);

      const searchAudits = h.audit.named("engagement.search.executed");
      expect(searchAudits.length).toBeGreaterThanOrEqual(2);
      for (const ev of searchAudits) {
        expect(JSON.stringify(ev)).not.toContain("Monroe");
        expect(JSON.stringify(ev)).not.toContain("Platypus");
      }
    });

    it("enforces strict query bounds and rejects remediation sessions", async () => {
      const aliceCaller = callerFor(alice.principal);
      await expect(aliceCaller.engagement.search.query({ query: "a" })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      await expect(aliceCaller.engagement.search.query({ query: "x".repeat(65) })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });

      const remediationSession = fakePrincipal({
        userId: alice.id,
        userPublicId: alice.publicId,
        role: "customer",
        state: "remediation",
        pendingSteps: ["enroll_mfa"],
      });
      const remCaller = callerFor(remediationSession);
      await expect(remCaller.engagement.notifications.list({})).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });
  });

  describe("portable export/import & cross-model review regressions (fail-closed audit, actor re-validation, 1-slot pool)", () => {
    it("exports only customer-visible records and imports idempotently with verbatim timestamps and zero notifications", async () => {
      const order = await createAliceOrder("Portable Transfer Order");
      const aliceCaller = callerFor(alice.principal);
      const staffCaller = callerFor(staff.principal);

      await aliceCaller.engagement.messages.send({
        orderId: order.publicId,
        body: "Customer portable message",
        idempotencyKey: nextIdemKey("port"),
      });
      await staffCaller.engagement.messages.send({
        orderId: order.publicId,
        body: "Secret internal portable exclusion note",
        visibility: "internal",
        idempotencyKey: nextIdemKey("port"),
      });

      const exportedMsgs = await engagement.portableEvidence(tdb.db, [order.publicId], null, 50);
      expect(exportedMsgs.items).toHaveLength(1);
      expect(exportedMsgs.items[0]!.body).toBe("Customer portable message");

      // Import historical message + ticket with verbatim past timestamps; ensure 0 mail & 0 notifications
      h.mailer.sent = [];
      const beforeUnread = await aliceCaller.engagement.notifications.unreadCount({});
      const historicalDate = new Date("2025-04-15T09:30:00.000Z");
      const sourceMsgPublicId = ulid(historicalDate.getTime());
      const [orderRow] = await tdb.db
        .select()
        .from(orderTables.orders)
        .where(eq(orderTables.orders.publicId, order.publicId));

      const firstImport = await tdb.db.transaction((tx) =>
        engagement.importOrderMessage(
          {
            importId: "imp_batch_01",
            sourceInstallationId: "inst_source_alpha",
            sourcePublicId: sourceMsgPublicId,
            targetOrderId: orderRow!.id,
            targetOrderPublicId: order.publicId,
            targetOrderReference: order.reference,
            authorUserId: alice.id,
            authorUserPublicId: alice.publicId,
            authorRole: "customer",
            body: "Imported historical message from 2025",
            createdAt: historicalDate,
          },
          tx,
        ),
      );
      expect(firstImport).toEqual({ publicId: sourceMsgPublicId, created: true });

      // Second import with same provenance is idempotent (`created: false`)
      const duplicateImport = await tdb.db.transaction((tx) =>
        engagement.importOrderMessage(
          {
            importId: "imp_batch_02",
            sourceInstallationId: "inst_source_alpha",
            sourcePublicId: sourceMsgPublicId,
            targetOrderId: orderRow!.id,
            targetOrderPublicId: order.publicId,
            targetOrderReference: order.reference,
            authorUserId: alice.id,
            authorUserPublicId: alice.publicId,
            authorRole: "customer",
            body: "Imported historical message from 2025",
            createdAt: historicalDate,
          },
          tx,
        ),
      );
      expect(duplicateImport).toEqual({ publicId: sourceMsgPublicId, created: false });

      // Timestamp preserved verbatim & zero notifications/emails fired
      const listedMsgs = await aliceCaller.engagement.messages.listByOrder({ orderId: order.publicId });
      const importedMsgView = listedMsgs.items.find((m) => m.publicId === sourceMsgPublicId)!;
      expect(importedMsgView.createdAt.toISOString()).toBe(historicalDate.toISOString());
      expect(h.mailer.sent).toHaveLength(0);
      const afterUnread = await aliceCaller.engagement.notifications.unreadCount({});
      expect(afterUnread.unreadCount).toBe(beforeUnread.unreadCount);
    });

    it("fails closed when audit is unavailable and rejects mid-request revoked/suspended actors inside tx", async () => {
      const order = await createAliceOrder("Fail Closed & Actor Guard Order");
      const aliceCaller = callerFor(alice.principal);

      // 1. Fail-closed audit rolls back ticket creation completely
      h.audit.failRecords = true;
      await expect(
        aliceCaller.engagement.tickets.create({
          subject: "Should roll back when audit fails",
          category: "general",
          body: "No ticket row may survive when durable audit fails.",
          idempotencyKey: nextIdemKey("fc"),
        }),
      ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
      h.audit.failRecords = false;

      const listAfterRollback = await aliceCaller.engagement.tickets.list({});
      expect(listAfterRollback.items.find((t) => t.subject.includes("Should roll back"))).toBeUndefined();

      // 2. Cross-model regression: session revoked after request started is rejected inside `tx` (`SESSION_NOT_CURRENT`)
      revokedSessions.add(alice.principal.sessionId);
      await expect(
        aliceCaller.engagement.messages.send({
          orderId: order.publicId,
          body: "Should be refused because session was revoked in flight",
          idempotencyKey: nextIdemKey("rev"),
        }),
      ).rejects.toMatchObject({
        code: "UNAUTHORIZED",
        cause: expect.objectContaining({ reasonCode: "SESSION_NOT_CURRENT" }),
      });
      revokedSessions.delete(alice.principal.sessionId);

      // 3. Cross-model regression: suspending user row in DB rejects in-tx actor check even with full principal snapshot
      const tempUser = await insertSyntheticUser(h, tdb.db, { role: "staff", name: "Suspended Staff" });
      await tdb.db.update(users).set({ status: "suspended" }).where(eq(users.id, tempUser.id));
      const tempCaller = callerFor(tempUser.principal);
      await expect(
        tempCaller.engagement.notifications.preferences.update({
          category: "ticket",
          inApp: true,
          email: false,
        }),
      ).rejects.toMatchObject({
        code: "UNAUTHORIZED",
        cause: expect.objectContaining({ reasonCode: "SESSION_NOT_CURRENT" }),
      });
    });

    it("completes all transactional mutations on a strict 1-connection pool without self-deadlock", async () => {
      const singlePool = mysql.createPool({
        uri: tdb.url,
        connectionLimit: 1,
        timezone: "Z",
        supportBigNumbers: true,
        charset: "utf8mb4",
      });
      try {
        const singleDb = drizzle(singlePool, { mode: "default" }) as unknown as Db;
        const sh = createTestDeps({ db: singleDb });
        // Use the real DB-backed SettingsStore to prove `tx` is forwarded to every settings read inside transactions!
        sh.deps.settings = createSettingsStore({
          db: singleDb,
          clock: sh.clock,
          logger: sh.deps.logger,
          crypto: sh.deps.crypto,
          audit: sh.audit,
        });
        sh.services.settings = sh.deps.settings;

        const singleRevoked = new Set<string>();
        sh.services.identity = buildIdentityPeer(sh, singleDb, singleRevoked) as unknown as Services["identity"];
        sh.services.files = filesPeer as unknown as Services["files"];
        const singleOrders = createOrdersModule(sh.deps);
        sh.services.orders = singleOrders;
        const singleEngagement = createEngagementModule(sh.deps);
        sh.services.engagement = singleEngagement;

        const within = <T>(p: Promise<T>, label: string, ms = 4000) =>
          Promise.race([
            p,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`1-slot pool timed out in ${label} (missing tx pass-through?)`)), ms),
            ),
          ]);

        const order = await within(
          singleOrders.orders.create(alice.principal, {
            projectName: "Single Connection Pool Order",
            items: [{ productPublicId: catalogProductPublicId, quantity: 1 }],
            idempotencyKey: nextIdemKey("one"),
          }),
          "orders.create",
        );

        await within(
          singleEngagement.messages.send(alice.principal, {
            orderId: order.publicId,
            body: "Message sent over 1-connection pool",
            idempotencyKey: nextIdemKey("one"),
          }),
          "messages.send",
        );

        const tkt = await within(
          singleEngagement.tickets.create(alice.principal, {
            subject: "Ticket over 1-connection pool",
            category: "technical",
            body: "Testing settings, actor lock, notify, and audit on 1 connection.",
            relatedOrderId: order.publicId,
            idempotencyKey: nextIdemKey("one"),
          }),
          "tickets.create",
        );

        await within(
          singleEngagement.tickets.adminAssign(staff.principal, {
            ticketId: tkt.ticket.publicId,
            assigneeUserId: admin.publicId,
          }),
          "tickets.adminAssign",
        );

        await within(
          singleEngagement.tickets.adminSetStatus(staff.principal, {
            ticketId: tkt.ticket.publicId,
            toStatus: "resolved",
          }),
          "tickets.adminSetStatus",
        );

        await within(
          singleEngagement.tickets.reopen(alice.principal, {
            ticketId: tkt.ticket.publicId,
            reason: "Reopen check on 1-connection pool",
          }),
          "tickets.reopen",
        );

        await within(
          singleEngagement.notifications.updatePreference(alice.principal, {
            category: "message",
            inApp: true,
            email: true,
          }),
          "notifications.updatePreference",
        );

        await sh.jobs.enqueue(NOTIFICATIONS_RETENTION_JOB_TYPE, {});
        await within(sh.jobs.runAll(NOTIFICATIONS_RETENTION_JOB_TYPE), "notifications.retention");
      } finally {
        await singlePool.end();
      }
    });
  });

  describe("security review regressions — scoped search anti-starvation & ticket pagination/metadata isolation", () => {
    it("prevents cross-tenant token hits from starving an owner's search results and matches normalized reference prefixes", async () => {
      const aliceOrder = await createAliceOrder("Alice Starvation Test Order");
      const eveOrder = await ordersMod.orders.create(eveOutsider.principal, {
        projectName: "Eve High Volume Order",
        items: [{ productPublicId: catalogProductPublicId, quantity: 1 }],
        idempotencyKey: nextIdemKey("ord"),
      });

      const aliceCaller = callerFor(alice.principal);
      const eveCaller = callerFor(eveOutsider.principal);

      // 1. Alice creates ONE early ticket and ONE early order message containing shared token "quartztoken"
      const aliceTicket = await aliceCaller.engagement.tickets.create({
        subject: "Alice early quartztoken inquiry",
        category: "technical",
        body: "Checking quartztoken alignment before high volume traffic.",
        relatedOrderId: aliceOrder.publicId,
        idempotencyKey: nextIdemKey("tkt"),
      });
      const aliceMsg = await aliceCaller.engagement.messages.send({
        orderId: aliceOrder.publicId,
        body: "Alice order message mentioning quartztoken early.",
        idempotencyKey: nextIdemKey("msg"),
      });

      // 2. Eve creates 45 newer tickets and 45 newer order messages containing "quartztoken"
      // (exceeding maxCandidates = 40 when limitPerDomain = 10 — proving global pre-auth LIMIT would have starved Alice!)
      for (let i = 0; i < 45; i++) {
        await eveCaller.engagement.tickets.create({
          subject: `Eve flood quartztoken ticket ${i}`,
          category: "general",
          body: `Flooding token index with quartztoken entry number ${i}.`,
          idempotencyKey: nextIdemKey("tkt"),
        });
        await eveCaller.engagement.messages.send({
          orderId: eveOrder.publicId,
          body: `Flooding message token index with quartztoken entry ${i}.`,
          idempotencyKey: nextIdemKey("msg"),
        });
      }

      // 3. Alice searches for "quartztoken" — her owned ticket and message MUST still be returned!
      const aliceHit = await aliceCaller.engagement.search.query({
        query: "quartztoken",
        limitPerDomain: 10,
      });
      expect(aliceHit.tickets.map((t) => t.publicId)).toEqual([aliceTicket.ticket.publicId]);
      expect(aliceHit.messages.map((m) => m.publicId)).toEqual([aliceMsg.publicId]);

      // 4. Lowercase prefix lookup on ticketNumber and orderReference hits sargable normalized prefix
      const byTicketPrefix = await aliceCaller.engagement.search.query({
        query: aliceTicket.ticket.ticketNumber.slice(0, 10).toLowerCase(),
        domains: ["tickets"],
      });
      expect(byTicketPrefix.tickets.some((t) => t.publicId === aliceTicket.ticket.publicId)).toBe(true);

      const byOrderRefPrefix = await aliceCaller.engagement.search.query({
        query: aliceOrder.reference.toLowerCase(),
        domains: ["tickets", "messages"],
      });
      expect(byOrderRefPrefix.tickets.some((t) => t.publicId === aliceTicket.ticket.publicId)).toBe(true);
      expect(byOrderRefPrefix.messages.some((m) => m.publicId === aliceMsg.publicId)).toBe(true);
    });

    it("paginates ticket replies per page and hides internal-note / assignment timestamp updates from customers", async () => {
      const aliceCaller = callerFor(alice.principal);
      const staffCaller = callerFor(staff.principal);

      const created = await aliceCaller.engagement.tickets.create({
        subject: "Paginated replies and hidden internal timestamps",
        category: "general",
        body: "Initial ticket message #1 from customer.",
        idempotencyKey: nextIdemKey("tkt"),
      });

      const initialCustomerUpdatedAt = created.ticket.updatedAt.getTime();
      const initialCustomerLastMsgAt = created.ticket.lastMessageAt.getTime();

      // Advance clock 10 minutes and post an internal staff note + staff assignment
      h.clock.advance(10 * 60_000);
      await staffCaller.engagement.tickets.admin.reply({
        ticketId: created.ticket.publicId,
        body: "Internal triage note — must not bump customer-visible updatedAt.",
        internalOnly: true,
        idempotencyKey: nextIdemKey("tkt"),
      });
      h.clock.advance(5 * 60_000);
      await staffCaller.engagement.tickets.admin.assign({
        ticketId: created.ticket.publicId,
        assigneeUserId: staff.publicId,
      });

      // Customer-visible timestamps remain strictly unchanged!
      const customerViewAfterInternal = await aliceCaller.engagement.tickets.get({
        ticketId: created.ticket.publicId,
      });
      expect(customerViewAfterInternal.ticket.updatedAt.getTime()).toBe(initialCustomerUpdatedAt);
      expect(customerViewAfterInternal.ticket.lastMessageAt.getTime()).toBe(initialCustomerLastMsgAt);
      expect(customerViewAfterInternal.replies).toHaveLength(1);

      // Add 4 more customer-visible replies (total 5 customer-visible replies) and paginate with replyLimit: 2
      for (let i = 2; i <= 5; i++) {
        h.clock.advance(60_000);
        await aliceCaller.engagement.tickets.reply({
          ticketId: created.ticket.publicId,
          body: `Follow-up customer reply #${i} in thread.`,
          idempotencyKey: nextIdemKey("tkt"),
        });
      }

      const page1 = await aliceCaller.engagement.tickets.get({
        ticketId: created.ticket.publicId,
        replyLimit: 2,
      });
      expect(page1.replies).toHaveLength(2);
      expect(page1.replies[0]!.body).toContain("#1");
      expect(page1.replies[1]!.body).toContain("#2");
      expect(page1.repliesNextCursor).not.toBeNull();

      const page2 = await aliceCaller.engagement.tickets.get({
        ticketId: created.ticket.publicId,
        replyLimit: 2,
        replyCursor: page1.repliesNextCursor!,
      });
      expect(page2.replies).toHaveLength(2);
      expect(page2.replies[0]!.body).toContain("#3");
      expect(page2.replies[1]!.body).toContain("#4");
      expect(page2.repliesNextCursor).not.toBeNull();

      const page3 = await aliceCaller.engagement.tickets.get({
        ticketId: created.ticket.publicId,
        replyLimit: 2,
        replyCursor: page2.repliesNextCursor!,
      });
      expect(page3.replies).toHaveLength(1);
      expect(page3.replies[0]!.body).toContain("#5");
      expect(page3.repliesNextCursor).toBeNull();
    });
  });
});
