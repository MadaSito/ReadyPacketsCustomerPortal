import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ROLE_CAPABILITIES, type Capability } from "../../../shared/capabilities.js";
import { DomainError } from "../../core/errors.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { Services } from "../../container.js";
import { createCallerFactory } from "../../trpc/trpc.js";
import { createTestDeps, type fakePrincipal, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { createOrdersModule, type OrdersModule } from "./index.js";
import { ordersRouter } from "./router.js";
import { DEFAULT_WORKFLOW } from "./workflowTypes.js";
import { orderGrants, orderLineItems, orderReassignments, orders } from "./schema.js";
import { users } from "../identity/schema.js";
import { FakeEngagement, FakeFiles, fakeIdentity, idemKey, insertUser, ordersTestSchema, type TestUser } from "./testSupport.js";

let t: TestDb;
let h: TestHarness;
let mod: OrdersModule;
let files: FakeFiles;
let engagement: FakeEngagement;
let admin: TestUser;
let staff: TestUser;
let alice: TestUser;
let bob: TestUser;
let carol: TestUser;
let productA: string;
let productB: string;

const code = (error: unknown) => (error instanceof DomainError ? `${error.code}:${error.reasonCode}` : String(error));
async function expectError(promise: Promise<unknown>, expected: string) {
  try {
    await promise;
  } catch (error) {
    expect(code(error)).toBe(expected);
    return;
  }
  throw new Error(`expected ${expected}`);
}

async function newOrder(owner: TestUser, items = [{ productPublicId: productA, quantity: 2 }]) {
  return mod.orders.create(owner.principal, { projectName: "Synthetic project", items, idempotencyKey: idemKey() });
}

beforeAll(async () => {
  t = await createTestDb({ schema: ordersTestSchema });
  h = createTestDeps({ db: t.db });
  files = new FakeFiles();
  engagement = new FakeEngagement();
  mod = createOrdersModule(h.deps);
  h.services.orders = mod;
  h.services.identity = fakeIdentity(h, t.db) as unknown as Services["identity"];
  h.services.files = files as unknown as Services["files"];
  h.services.engagement = engagement as unknown as Services["engagement"];
  admin = await insertUser(h, t.db, { role: "admin", stepUp: true });
  staff = await insertUser(h, t.db, { role: "staff" });
  alice = await insertUser(h, t.db);
  bob = await insertUser(h, t.db);
  carol = await insertUser(h, t.db);
});
afterAll(() => t.cleanup());
beforeEach(() => {
  h.audit.failRecords = false;
  files.fail = false;
});

describe("catalog", () => {
  it("ships empty and reports not_configured; ordering from an empty catalog is refused", async () => {
    expect(await mod.catalog.listActive()).toEqual([]);
    const health = await mod.health!();
    expect(health.find((c) => c.component === "orders.catalog")?.state).toBe("not_configured");
    await expectError(newOrder(alice, [{ productPublicId: "01JD0000000000000000000099", quantity: 1 }]), "VALIDATION:PRODUCT_UNAVAILABLE");
  });

  it("admin creates versioned products (audited in-transaction)", async () => {
    const group = await mod.catalog.createGroup(admin.principal, { name: "Synthetic group", description: "", sortOrder: 0, active: true });
    const a = await mod.catalog.createProduct(admin.principal, {
      groupId: group.publicId,
      productKey: "synthetic-a",
      sortOrder: 0,
      active: true,
      name: "Synthetic item A",
      description: "Demo only",
      features: ["one"],
      priceMinor: 1500,
      currency: "USD",
    });
    const b = await mod.catalog.createProduct(admin.principal, {
      groupId: group.publicId,
      productKey: "synthetic-b",
      sortOrder: 1,
      active: true,
      name: "Synthetic item B",
      description: "",
      features: [],
      priceMinor: 999,
      currency: "USD",
    });
    productA = a.publicId;
    productB = b.publicId;
    const events = h.audit.named("catalog.product.changed");
    expect(events.length).toBe(2);
    expect(h.audit.recordedInTx.at(-1)).toBe(true);
    await expectError(
      mod.catalog.createProduct(admin.principal, { groupId: group.publicId, productKey: "synthetic-a", sortOrder: 0, active: true, name: "x", description: "", features: [], priceMinor: 1, currency: "USD" }),
      "CONFLICT:PRODUCT_KEY_TAKEN",
    );
    await expectError(
      mod.catalog.createProduct(admin.principal, { groupId: group.publicId, productKey: "bad-cur", sortOrder: 0, active: true, name: "x", description: "", features: [], priceMinor: 1, currency: "ZZ1" }),
      "VALIDATION:INVALID_CURRENCY",
    );
  });

  it("price changes create a new version; existing order line items keep their snapshot", async () => {
    const first = await newOrder(alice);
    const [product] = (await mod.catalog.listAll()).flatMap((g) => g.products).filter((p) => p.publicId === productA);
    await mod.catalog.updateProduct(admin.principal, {
      productId: productA,
      expectedVersion: product!.rowVersion,
      groupId: product!.groupPublicId,
      sortOrder: 0,
      active: true,
      name: "Synthetic item A",
      description: "Demo only",
      features: ["one"],
      priceMinor: 2500,
      currency: "USD",
    });
    const detail = await mod.orders.get(alice.principal, first.publicId);
    expect(detail.lineItems[0]).toMatchObject({ unitPriceMinor: 1500, quantity: 2, lineTotalMinor: 3000, productVersion: 1 });
    expect(detail.totalMinor).toBe(3000);
    const second = await newOrder(alice);
    const later = await mod.orders.get(alice.principal, second.publicId);
    expect(later.lineItems[0]).toMatchObject({ unitPriceMinor: 2500, productVersion: 2 });
    // stale optimistic version is refused
    await expectError(
      mod.catalog.updateProduct(admin.principal, { productId: productA, expectedVersion: product!.rowVersion, groupId: product!.groupPublicId, sortOrder: 0, active: true, name: "n", description: "", features: [], priceMinor: 1, currency: "USD" }),
      "CONFLICT:STALE_VERSION",
    );
  });
});

describe("order creation", () => {
  it("creates an order with a generated reference, initial status and audit; is idempotent", async () => {
    const key = idemKey();
    const input = { projectName: "Idempotent", items: [{ productPublicId: productB, quantity: 3 }], idempotencyKey: key, note: "Please hurry" };
    const created = await mod.orders.create(alice.principal, input);
    expect(created.created).toBe(true);
    expect(created.reference).toMatch(/^RP-2026-\d{6}$/);
    const replay = await mod.orders.create(alice.principal, input);
    expect(replay).toEqual({ ...created, created: false });
    const detail = await mod.orders.get(alice.principal, created.publicId);
    expect(detail).toMatchObject({ statusKey: "submitted", totalMinor: 2997, currency: "USD", accessRole: "owner", lockState: "none" });
    expect(detail.notes[0]?.body).toBe("Please hurry");
    expect(h.audit.named("order.created").at(-1)).toMatchObject({ resource: { type: "order", publicId: created.publicId } });
  });

  it("refuses mixed duplicates and writes nothing when audit is unavailable", async () => {
    await expectError(
      mod.orders.create(alice.principal, { projectName: "x", items: [{ productPublicId: productA, quantity: 1 }, { productPublicId: productA, quantity: 1 }], idempotencyKey: idemKey() }),
      "VALIDATION:DUPLICATE_ITEM",
    );
    const before = (await t.db.select({ id: orders.id }).from(orders)).length;
    h.audit.failRecords = true;
    await expectError(newOrder(alice), "AUDIT_UNAVAILABLE:AUDIT_WRITE_FAILED");
    h.audit.failRecords = false;
    expect((await t.db.select({ id: orders.id }).from(orders)).length).toBe(before);
  });

  it("customer list is scoped to own orders with bounded cursor pagination", async () => {
    await newOrder(bob);
    const page1 = await mod.orders.list(alice.principal, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await mod.orders.list(alice.principal, { limit: 100, cursor: page1.nextCursor! });
    const all = [...page1.items, ...page2.items];
    expect(new Set(all.map((o) => o.publicId)).size).toBe(all.length);
    expect(all.every((o) => o.accessRole === "owner")).toBe(true);
    const bobs = await mod.orders.list(bob.principal, {});
    expect(bobs.items.every((o) => !all.some((a) => a.publicId === o.publicId))).toBe(true);
    await expectError(mod.orders.list(alice.principal, { cursor: "not-a-cursor" }), "VALIDATION:INVALID_CURSOR");
  });
});

describe("negative authorization matrix", () => {
  let order: { publicId: string };
  beforeAll(async () => {
    order = await newOrder(alice);
  });

  it("other customer: NOT_FOUND on read, write, summary and is audited as denied", async () => {
    h.audit.clear();
    await expectError(mod.assertCanReadOrder(bob.principal, order.publicId), "NOT_FOUND:ORDER_NOT_FOUND");
    await expectError(mod.assertCanWriteOrder(bob.principal, order.publicId, { kind: "file" }), "NOT_FOUND:ORDER_NOT_FOUND");
    await expectError(mod.getOrderSummary(bob.principal, order.publicId), "NOT_FOUND:ORDER_NOT_FOUND");
    await expectError(mod.orders.get(bob.principal, order.publicId), "NOT_FOUND:ORDER_NOT_FOUND");
    expect(h.audit.named("authz.order.denied").length).toBeGreaterThanOrEqual(4);
    expect(h.audit.named("authz.order.denied")[0]).toMatchObject({ category: "security", outcome: "denied", reasonCode: "NOT_OWNER_OR_GRANTEE" });
  });

  it("tampered / malformed / unknown identifiers are indistinguishable NOT_FOUND", async () => {
    await expectError(mod.assertCanReadOrder(alice.principal, "1 OR 1=1"), "NOT_FOUND:ORDER_NOT_FOUND");
    await expectError(mod.assertCanReadOrder(alice.principal, "01JD0000000000000000000000"), "NOT_FOUND:ORDER_NOT_FOUND");
    await expectError(mod.assertCanReadOrderById(bob.principal, 1), "NOT_FOUND:ORDER_NOT_FOUND");
  });

  it("remediation session is refused even for the owner", async () => {
    const remediation = { ...alice.principal, state: "remediation" as const, pendingSteps: ["enroll_mfa" as const] };
    await expectError(mod.assertCanReadOrder(remediation, order.publicId), "NOT_FOUND:ORDER_NOT_FOUND");
    expect(await mod.listAccessibleOrderIds(remediation)).toEqual({ all: false, orderIds: [], truncated: false });
    await expectError(mod.orders.list(remediation, {}), "NOT_FOUND:ORDER_NOT_FOUND");
  });

  it("staff without the capability cannot read; staff without invoices.manage cannot write invoices", async () => {
    expect((await mod.assertCanReadOrder(staff.principal, order.publicId)).accessRole).toBe("staff");
    const set = ROLE_CAPABILITIES.staff as Set<Capability>;
    // Staff may hold invoices.manage by default; without it, invoice writes are refused.
    const hadInvoices = set.delete("invoices.manage");
    try {
      await expectError(mod.assertCanWriteOrder(staff.principal, order.publicId, { kind: "invoice" }), "NOT_FOUND:ORDER_NOT_FOUND");
    } finally {
      if (hadInvoices) set.add("invoices.manage");
    }
    set.delete("orders.read_all");
    try {
      await expectError(mod.assertCanReadOrder(staff.principal, order.publicId), "NOT_FOUND:ORDER_NOT_FOUND");
      expect(await mod.listAccessibleOrderIds(staff.principal)).toEqual({ all: false, orderIds: [], truncated: false });
      await expectError(mod.orders.adminList(staff.principal, {}), "FORBIDDEN:CAPABILITY_NOT_GRANTED");
    } finally {
      set.add("orders.read_all");
    }
  });

  it("customers can never write invoices", async () => {
    await expectError(mod.assertCanWriteOrder(alice.principal, order.publicId, { kind: "invoice" }), "FORBIDDEN:STAFF_ONLY");
  });
});

describe("sharing", () => {
  let order: { publicId: string };
  let grantId: string;
  beforeAll(async () => {
    order = await newOrder(alice);
  });

  it("pending invitation grants nothing; acceptance requires verified matching e-mail", async () => {
    const invite = await mod.sharing.invite(alice.principal, { orderId: order.publicId, email: bob.email.toUpperCase(), role: "viewer" });
    grantId = invite.publicId;
    expect(invite.status).toBe("pending");
    await expectError(mod.assertCanReadOrder(bob.principal, order.publicId), "NOT_FOUND:ORDER_NOT_FOUND");
    await expectError(mod.sharing.invite(alice.principal, { orderId: order.publicId, email: bob.email, role: "viewer" }), "CONFLICT:ALREADY_SHARED");
    // Unknown address yields the same pending result (no account-enumeration oracle).
    const ghost = await mod.sharing.invite(alice.principal, { orderId: order.publicId, email: "nobody.here@example.test", role: "viewer" });
    expect(ghost.status).toBe("pending");
    // Another customer cannot accept someone else's invitation.
    await expectError(mod.sharing.respond(carol.principal, { grantId, accept: true }), "NOT_FOUND:GRANT_NOT_FOUND");
    // Non-owner cannot manage sharing.
    await expectError(mod.sharing.invite(bob.principal, { orderId: order.publicId, email: carol.email, role: "viewer" }), "NOT_FOUND:ORDER_NOT_FOUND");
    expect((await mod.sharing.myInvitations(bob.principal)).map((i) => i.publicId)).toContain(grantId);
    const accepted = await mod.sharing.respond(bob.principal, { grantId, accept: true });
    expect(accepted.status).toBe("active");
    const view = await mod.assertCanReadOrder(bob.principal, order.publicId);
    expect(view.accessRole).toBe("viewer");
    const list = await mod.orders.list(bob.principal, {});
    expect(list.items.find((o) => o.publicId === order.publicId)?.accessRole).toBe("viewer");
  });

  it("an unverified account cannot accept an invitation addressed to its e-mail", async () => {
    const unverified = await insertUser(h, t.db, { verified: false });
    const invite = await mod.sharing.invite(alice.principal, { orderId: order.publicId, email: unverified.email, role: "contributor" });
    expect(await mod.sharing.myInvitations(unverified.principal)).toEqual([]);
    await expectError(mod.sharing.respond(unverified.principal, { grantId: invite.publicId, accept: true }), "NOT_FOUND:GRANT_NOT_FOUND");
  });

  it("viewer cannot write; contributor can write content but not share or transition", async () => {
    await expectError(mod.assertCanWriteOrder(bob.principal, order.publicId, { kind: "message" }), "FORBIDDEN:GRANT_READ_ONLY");
    const invite = await mod.sharing.invite(alice.principal, { orderId: order.publicId, email: carol.email, role: "contributor" });
    await mod.sharing.respond(carol.principal, { grantId: invite.publicId, accept: true });
    expect((await mod.assertCanWriteOrder(carol.principal, order.publicId, { kind: "file" })).accessRole).toBe("contributor");
    await expectError(mod.assertCanWriteOrder(carol.principal, order.publicId, { kind: "sharing" }), "FORBIDDEN:OWNER_ONLY");
    await expectError(mod.assertCanWriteOrder(carol.principal, order.publicId, { kind: "status" }), "FORBIDDEN:OWNER_ONLY");
  });

  it("locking re-check sees a revocation committed after the caller's REPEATABLE READ snapshot", async () => {
    const grants = await mod.sharing.list(alice.principal, order.publicId);
    const carolGrant = grants.find((g) => g.email === carol.email && g.status === "active")!;
    await t.db.transaction(async (tx) => {
      // Establish the snapshot before the revocation commits on another connection.
      await tx.select({ id: orderGrants.id }).from(orderGrants).where(eq(orderGrants.publicId, carolGrant.publicId));
      await mod.sharing.revoke(alice.principal, { orderId: order.publicId, grantId: carolGrant.publicId });
      await expectError(mod.assertCanWriteOrder(carol.principal, order.publicId, { kind: "file", tx, forUpdate: true }), "NOT_FOUND:ORDER_NOT_FOUND");
    });
  });

  it("revocation takes effect immediately on the next check", async () => {
    await mod.sharing.revoke(alice.principal, { orderId: order.publicId, grantId });
    await expectError(mod.assertCanReadOrder(bob.principal, order.publicId), "NOT_FOUND:ORDER_NOT_FOUND");
    const ids = await mod.listAccessibleOrderIds(bob.principal);
    expect(ids.all === false && ids.orderIds).not.toContain((await mod.assertCanReadOrder(alice.principal, order.publicId)).id);
    const grants = await mod.sharing.list(alice.principal, order.publicId);
    expect(grants.find((g) => g.publicId === grantId)?.status).toBe("revoked");
    expect(grants.find((g) => g.publicId === grantId)?.email).toBe(bob.email);
    // A revoked invitation cannot be re-accepted.
    await expectError(mod.sharing.respond(bob.principal, { grantId, accept: true }), "NOT_FOUND:GRANT_NOT_FOUND");
  });

  it("invitations expire", async () => {
    const dave = await insertUser(h, t.db);
    const invite = await mod.sharing.invite(alice.principal, { orderId: order.publicId, email: dave.email, role: "viewer" });
    h.clock.advance(15 * 86_400_000);
    try {
      await expectError(mod.sharing.respond(dave.principal, { grantId: invite.publicId, accept: true }), "NOT_FOUND:GRANT_NOT_FOUND");
    } finally {
      h.clock.advance(-15 * 86_400_000);
    }
  });
});

describe("locks", () => {
  it("review blocks customer writes, legal hold blocks everyone, reads continue", async () => {
    const order = await newOrder(alice);
    let view = await mod.assertCanReadOrder(staff.principal, order.publicId);
    await mod.orders.setLock(staff.principal, { orderId: order.publicId, expectedVersion: view.version, lockState: "review", reasonCode: "QUALITY_REVIEW" });
    await expectError(mod.assertCanWriteOrder(alice.principal, order.publicId, { kind: "file" }), "LOCKED:ORDER_LOCKED");
    await expectError(mod.orders.addNote(alice.principal, { orderId: order.publicId, body: "hi" }), "LOCKED:ORDER_LOCKED");
    expect((await mod.assertCanWriteOrder(staff.principal, order.publicId, { kind: "message" })).locked).toBe(true);
    expect((await mod.assertCanReadOrder(alice.principal, order.publicId)).lockState).toBe("review");

    view = await mod.assertCanReadOrder(staff.principal, order.publicId);
    await expectError(
      mod.orders.setLock(staff.principal, { orderId: order.publicId, expectedVersion: view.version, lockState: "legal_hold", reasonCode: "LEGAL" }),
      "FORBIDDEN:ADMIN_ONLY",
    );
    await expectError(mod.orders.setLock(alice.principal, { orderId: order.publicId, expectedVersion: view.version, lockState: "none", reasonCode: "MINE" }), "NOT_FOUND:ORDER_NOT_FOUND");
    await mod.orders.setLock(admin.principal, { orderId: order.publicId, expectedVersion: view.version, lockState: "legal_hold", reasonCode: "LEGAL" });
    await expectError(mod.assertCanWriteOrder(staff.principal, order.publicId, { kind: "message" }), "LOCKED:ORDER_LOCKED");
    await expectError(mod.assertCanWriteOrder(admin.principal, order.publicId, { kind: "status" }), "LOCKED:ORDER_LOCKED");
    expect(h.audit.named("order.lock.changed").at(-1)).toMatchObject({ attributes: { from_state: "review", to_state: "legal_hold" } });
    // legal hold blocks reassignment and reference changes
    view = await mod.assertCanReadOrder(admin.principal, order.publicId);
    await expectError(
      mod.orders.reassign(admin.principal, { orderId: order.publicId, targetCustomerPublicId: bob.publicId, expectedVersion: view.version, operationId: idemKey(), reasonCode: "MOVE" }),
      "LOCKED:ORDER_LOCKED",
    );
  });
});

describe("workflow transitions", () => {
  it("enforces who may trigger, requires notes, records history and notifies the customer", async () => {
    const order = await newOrder(alice);
    let view = await mod.assertCanReadOrder(alice.principal, order.publicId);
    expect((await mod.orders.get(alice.principal, order.publicId)).transitions).toEqual([
      { to: "canceled", label: "Canceled", actionLabel: "Cancel order", destructive: true, requiresNote: false },
    ]);
    expect((await mod.orders.get(staff.principal, order.publicId, "console")).transitions.map((t) => t.actionLabel)).toEqual(["Move to In review", "Cancel order"]);
    await expectError(mod.orders.transition(alice.principal, { orderId: order.publicId, expectedVersion: view.version, toStatus: "in_review" }), "FORBIDDEN:TRANSITION_NOT_ALLOWED");
    expect(h.audit.named("order.transition.denied").length).toBeGreaterThan(0);
    engagement.notifications = [];
    await mod.orders.transition(staff.principal, { orderId: order.publicId, expectedVersion: view.version, toStatus: "in_review" });
    expect(engagement.notifications).toContainEqual(expect.objectContaining({ userId: alice.id, kind: "order.status_changed", link: `/orders/${order.publicId}` }));
    view = await mod.assertCanReadOrder(staff.principal, order.publicId);
    await expectError(mod.orders.transition(staff.principal, { orderId: order.publicId, expectedVersion: view.version, toStatus: "awaiting_customer" }), "VALIDATION:NOTE_REQUIRED");
    await mod.orders.transition(staff.principal, { orderId: order.publicId, expectedVersion: view.version, toStatus: "awaiting_customer", note: "Need details" });
    const detail = await mod.orders.get(alice.principal, order.publicId);
    expect(detail.statusLabel).toBe("Action needed");
    expect(detail.history.map((e) => e.toStatus)).toEqual(["awaiting_customer", "in_review", "submitted"]);
    expect(detail.transitions.map((x) => x.to)).toEqual(["in_review"]);
    expect(detail.transitions[0]).toMatchObject({ actionLabel: "Return to review", destructive: false });
    expect(detail.notes.some((n) => n.body === "Need details")).toBe(true);
  });

  it("internal notes are never shown to customers", async () => {
    const order = await newOrder(alice);
    await mod.orders.addNote(staff.principal, { orderId: order.publicId, body: "internal only", visibility: "internal" });
    await expectError(mod.orders.addNote(alice.principal, { orderId: order.publicId, body: "x", visibility: "internal" }), "FORBIDDEN:STAFF_ONLY");
    expect((await mod.orders.get(alice.principal, order.publicId)).notes.some((n) => n.body === "internal only")).toBe(false);
    expect((await mod.orders.get(staff.principal, order.publicId, "customer")).notes.some((n) => n.body === "internal only")).toBe(false);
    expect((await mod.orders.get(staff.principal, order.publicId, "console")).notes.some((n) => n.body === "internal only")).toBe(true);
  });

  it("concurrent transitions with the same expected version: exactly one wins", async () => {
    const order = await newOrder(alice);
    const view = await mod.assertCanReadOrder(staff.principal, order.publicId);
    const results = await Promise.allSettled([
      mod.orders.transition(staff.principal, { orderId: order.publicId, expectedVersion: view.version, toStatus: "in_review" }),
      mod.orders.transition(admin.principal, { orderId: order.publicId, expectedVersion: view.version, toStatus: "in_review" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(code(rejected.reason)).toMatch(/^(CONFLICT:STALE_VERSION|FORBIDDEN:TRANSITION_NOT_ALLOWED)$/);
    const detail = await mod.orders.get(staff.principal, order.publicId, "console");
    expect(detail.history.filter((e) => e.toStatus === "in_review")).toHaveLength(1);
  });
});

describe("order references", () => {
  it("retired references are reserved forever", async () => {
    const one = await newOrder(alice);
    const two = await newOrder(bob);
    let view = await mod.assertCanReadOrder(admin.principal, one.publicId);
    await mod.orders.changeReference(admin.principal, { orderId: one.publicId, expectedVersion: view.version, newReference: "rp-custom-001", reasonCode: "CUSTOMER_REQUEST" });
    view = await mod.assertCanReadOrder(admin.principal, one.publicId);
    expect(view.reference).toBe("RP-CUSTOM-001");
    const viewTwo = await mod.assertCanReadOrder(admin.principal, two.publicId);
    await expectError(
      mod.orders.changeReference(admin.principal, { orderId: two.publicId, expectedVersion: viewTwo.version, newReference: one.reference, reasonCode: "REUSE" }),
      "CONFLICT:REFERENCE_RESERVED",
    );
    await expectError(
      mod.orders.changeReference(admin.principal, { orderId: two.publicId, expectedVersion: viewTwo.version, newReference: "RP-CUSTOM-001", reasonCode: "REUSE" }),
      "CONFLICT:REFERENCE_RESERVED",
    );
    // Even the original order cannot take back its retired reference.
    await expectError(
      mod.orders.changeReference(admin.principal, { orderId: one.publicId, expectedVersion: view.version, newReference: one.reference, reasonCode: "UNDO" }),
      "CONFLICT:REFERENCE_RESERVED",
    );
    await expectError(
      mod.orders.changeReference(staff.principal, { orderId: one.publicId, expectedVersion: view.version, newReference: "RP-X-1", reasonCode: "STAFF" }),
      "FORBIDDEN:CAPABILITY_NOT_GRANTED",
    );
    const history = await mod.orders.referenceHistory(admin.principal, one.publicId);
    expect(history.map((r) => [r.reference, r.status])).toEqual([
      [one.reference, "retired"],
      ["RP-CUSTOM-001", "active"],
    ]);
  });
});

describe("reassignment", () => {
  it("audit failure ⇒ nothing moved (owner, grants, history unchanged)", async () => {
    const order = await newOrder(alice);
    const invite = await mod.sharing.invite(alice.principal, { orderId: order.publicId, email: carol.email, role: "viewer" });
    await mod.sharing.respond(carol.principal, { grantId: invite.publicId, accept: true });
    const view = await mod.assertCanReadOrder(admin.principal, order.publicId);
    h.audit.failRecords = true;
    await expectError(
      mod.orders.reassign(admin.principal, { orderId: order.publicId, targetCustomerPublicId: bob.publicId, expectedVersion: view.version, operationId: idemKey(), reasonCode: "MOVE" }),
      "AUDIT_UNAVAILABLE:AUDIT_WRITE_FAILED",
    );
    h.audit.failRecords = false;
    const [row] = await t.db.select().from(orders).where(eq(orders.publicId, order.publicId));
    expect(row?.ownerUserId).toBe(alice.id);
    expect(row?.version).toBe(view.version);
    expect((await mod.assertCanReadOrder(carol.principal, order.publicId)).accessRole).toBe("viewer");
    expect(await t.db.select().from(orderReassignments).where(eq(orderReassignments.orderId, row!.id))).toHaveLength(0);
  });

  it("files failure ⇒ nothing moved", async () => {
    const order = await newOrder(alice);
    const view = await mod.assertCanReadOrder(admin.principal, order.publicId);
    files.fail = true;
    await expect(
      mod.orders.reassign(admin.principal, { orderId: order.publicId, targetCustomerPublicId: bob.publicId, expectedVersion: view.version, operationId: idemKey(), reasonCode: "MOVE" }),
    ).rejects.toThrow();
    const [row] = await t.db.select().from(orders).where(eq(orders.publicId, order.publicId));
    expect(row?.ownerUserId).toBe(alice.id);
  });

  it("moves ownership, revokes every grant, rebinds files, audits, and is idempotent", async () => {
    const order = await newOrder(alice);
    const invite = await mod.sharing.invite(alice.principal, { orderId: order.publicId, email: carol.email, role: "contributor" });
    await mod.sharing.respond(carol.principal, { grantId: invite.publicId, accept: true });
    await mod.sharing.invite(alice.principal, { orderId: order.publicId, email: "pending.person@example.test", role: "viewer" });
    const view = await mod.assertCanReadOrder(admin.principal, order.publicId);
    const operationId = idemKey();
    files.calls = [];
    const result = await mod.orders.reassign(admin.principal, { orderId: order.publicId, targetCustomerPublicId: bob.publicId, expectedVersion: view.version, operationId, reasonCode: "ACCOUNT_MERGE" });
    expect(result).toMatchObject({ replayed: false, revokedGrants: 2 });
    expect(files.calls).toEqual([{ orderId: view.id, ownerUserId: bob.id }]);
    await expectError(mod.assertCanReadOrder(alice.principal, order.publicId), "NOT_FOUND:ORDER_NOT_FOUND");
    await expectError(mod.assertCanReadOrder(carol.principal, order.publicId), "NOT_FOUND:ORDER_NOT_FOUND");
    expect((await mod.assertCanReadOrder(bob.principal, order.publicId)).accessRole).toBe("owner");
    const grants = await t.db.select().from(orderGrants).where(eq(orderGrants.orderId, view.id));
    expect(grants.every((g) => g.status === "revoked" && g.endReasonCode === "REASSIGNED" && g.liveKey === null)).toBe(true);
    const event = h.audit.named("order.reassigned").at(-1);
    expect(event).toMatchObject({ attributes: { from_owner: alice.publicId, to_owner: bob.publicId }, safeCounts: { revoked_grants: 2 } });
    // Idempotent replay with the same operation id.
    const replay = await mod.orders.reassign(admin.principal, { orderId: order.publicId, targetCustomerPublicId: bob.publicId, expectedVersion: view.version, operationId, reasonCode: "ACCOUNT_MERGE" });
    expect(replay.replayed).toBe(true);
    expect(files.calls).toHaveLength(1);
    await expectError(
      mod.orders.reassign(admin.principal, { orderId: order.publicId, targetCustomerPublicId: carol.publicId, expectedVersion: view.version + 1, operationId, reasonCode: "OTHER" }),
      "CONFLICT:OPERATION_ID_REUSED",
    );
  });

  it("refuses inactive / non-customer / same-owner targets and non-admin callers", async () => {
    const order = await newOrder(alice);
    const view = await mod.assertCanReadOrder(admin.principal, order.publicId);
    const suspended = await insertUser(h, t.db, { status: "suspended" });
    const base = { orderId: order.publicId, expectedVersion: view.version, reasonCode: "MOVE" };
    await expectError(mod.orders.reassign(admin.principal, { ...base, targetCustomerPublicId: suspended.publicId, operationId: idemKey() }), "VALIDATION:TARGET_INACTIVE");
    await expectError(mod.orders.reassign(admin.principal, { ...base, targetCustomerPublicId: staff.publicId, operationId: idemKey() }), "VALIDATION:TARGET_NOT_ELIGIBLE");
    await expectError(mod.orders.reassign(admin.principal, { ...base, targetCustomerPublicId: alice.publicId, operationId: idemKey() }), "CONFLICT:TARGET_IS_OWNER");
    await expectError(mod.orders.reassign(staff.principal, { ...base, targetCustomerPublicId: bob.publicId, operationId: idemKey() }), "FORBIDDEN:CAPABILITY_NOT_GRANTED");
    // Actor re-validated inside the transaction: a suspended admin whose session snapshot still looks valid is refused.
    const exAdmin = await insertUser(h, t.db, { role: "admin", stepUp: true });
    await t.db.update(users).set({ status: "suspended" }).where(eq(users.id, exAdmin.id));
    await expectError(mod.orders.reassign(exAdmin.principal, { ...base, targetCustomerPublicId: bob.publicId, operationId: idemKey() }), "UNAUTHENTICATED:SESSION_NOT_CURRENT");
    await expectError(mod.orders.changeReference(exAdmin.principal, { orderId: order.publicId, expectedVersion: view.version, newReference: "RP-NEW-2", reasonCode: "FIX" }), "UNAUTHENTICATED:SESSION_NOT_CURRENT");
    await expectError(mod.orders.setLock(exAdmin.principal, { orderId: order.publicId, expectedVersion: view.version, lockState: "review", reasonCode: "FIX" }), "UNAUTHENTICATED:SESSION_NOT_CURRENT");
    // Trusted ref lookup can lock the order row (files retention) and refuses a lock without a transaction.
    await t.db.transaction(async (tx) => {
      expect(await mod.getOrderRefById(view.id, tx, { forUpdate: true })).toMatchObject({ publicId: order.publicId, lockState: "none" });
    });
    await expectError(mod.getOrderRefById(view.id, undefined, { forUpdate: true }), "VALIDATION:TX_REQUIRED");
    const noStepUp = { ...admin.principal, stepUpAt: null };
    await expectError(mod.orders.reassign(noStepUp, { ...base, targetCustomerPublicId: bob.publicId, operationId: idemKey() }), "STEP_UP_REQUIRED:STEP_UP_REQUIRED");
    await expectError(mod.orders.changeReference(noStepUp, { orderId: order.publicId, expectedVersion: view.version, newReference: "RP-NEW-1", reasonCode: "FIX" }), "STEP_UP_REQUIRED:STEP_UP_REQUIRED");
    await expectError(mod.orders.reassign(admin.principal, { ...base, expectedVersion: view.version + 5, targetCustomerPublicId: bob.publicId, operationId: idemKey() }), "CONFLICT:STALE_VERSION");
    expect(h.audit.named("order.reassign.refused").map((e) => e.reasonCode)).toEqual(expect.arrayContaining(["TARGET_INACTIVE", "TARGET_NOT_ELIGIBLE", "TARGET_IS_OWNER"]));
  });
});

describe("in-transaction actor currency (O-01) and consistent reads (O-02)", () => {
  type SessionOverride = { revoked?: boolean; pendingSteps?: string[]; stepUpAt?: Date | null; role?: TestUser["principal"]["role"] };
  const sessions = () => (h.services.identity as unknown as { sessionState: Map<string, SessionOverride> }).sessionState;
  const withSession = async (user: TestUser, state: SessionOverride, fn: () => Promise<void>) => {
    sessions().set(user.principal.sessionId, state);
    try {
      await fn();
    } finally {
      sessions().delete(user.principal.sessionId);
    }
  };

  it("a revoked admin session is refused for lock, reference, reassign, catalog and workflow writes; nothing changes", async () => {
    const order = await newOrder(alice);
    const view = await mod.assertCanReadOrder(admin.principal, order.publicId);
    const before = (await t.db.select().from(orders).where(eq(orders.publicId, order.publicId)))[0]!;
    await withSession(admin, { revoked: true }, async () => {
      const stale = "UNAUTHENTICATED:SESSION_NOT_CURRENT";
      await expectError(mod.orders.setLock(admin.principal, { orderId: order.publicId, expectedVersion: view.version, lockState: "review", reasonCode: "X" }), stale);
      await expectError(mod.orders.changeReference(admin.principal, { orderId: order.publicId, expectedVersion: view.version, newReference: "RP-O01-1", reasonCode: "X" }), stale);
      await expectError(mod.orders.reassign(admin.principal, { orderId: order.publicId, targetCustomerPublicId: bob.publicId, expectedVersion: view.version, operationId: idemKey(), reasonCode: "X" }), stale);
      await expectError(mod.catalog.createGroup(admin.principal, { name: "Revoked group", description: "", sortOrder: 9, active: true }), stale);
      await expectError(mod.workflows.create(admin.principal, { workflowKey: "revoked-wf", name: "Revoked", definition: DEFAULT_WORKFLOW }), stale);
    });
    const after = (await t.db.select().from(orders).where(eq(orders.publicId, order.publicId)))[0]!;
    expect(after).toMatchObject({ ownerUserId: before.ownerUserId, reference: before.reference, lockState: before.lockState, version: before.version });
    expect((await mod.catalog.listAll()).some((g) => g.name === "Revoked group")).toBe(false);
    expect((await mod.workflows.list()).some((w) => w.workflowKey === "revoked-wf")).toBe(false);
  });

  it("authority comes from PERSISTED session state: stale persisted step-up, pending steps and demoted role are refused", async () => {
    const order = await newOrder(alice);
    const view = await mod.assertCanReadOrder(admin.principal, order.publicId);
    const input = { orderId: order.publicId, targetCustomerPublicId: bob.publicId, expectedVersion: view.version, operationId: idemKey(), reasonCode: "X" };
    // The request principal claims a fresh step-up, but the persisted session has none.
    await withSession(admin, { stepUpAt: null }, async () => {
      await expectError(mod.orders.reassign(admin.principal, input), "STEP_UP_REQUIRED:STEP_UP_REQUIRED");
      await expectError(mod.orders.changeReference(admin.principal, { orderId: order.publicId, expectedVersion: view.version, newReference: "RP-O01-2", reasonCode: "X" }), "STEP_UP_REQUIRED:STEP_UP_REQUIRED");
    });
    await withSession(admin, { pendingSteps: ["mfa_enrol"] }, async () => {
      await expectError(mod.catalog.createGroup(admin.principal, { name: "Pending group", description: "", sortOrder: 9, active: true }), "REMEDIATION_REQUIRED:ACCOUNT_STEP_PENDING");
    });
    await withSession(admin, { role: "staff" }, async () => {
      await expectError(mod.orders.setLock(admin.principal, { orderId: order.publicId, expectedVersion: view.version, lockState: "review", reasonCode: "X" }), "FORBIDDEN:ACTOR_NOT_AUTHORIZED");
    });
    await withSession(alice, { pendingSteps: ["password_change"] }, async () => {
      await expectError(mod.orders.update(alice.principal, { orderId: order.publicId, expectedVersion: view.version, projectName: "Renamed" }), "REMEDIATION_REQUIRED:ACCOUNT_STEP_PENDING");
    });
    const [row] = await t.db.select().from(orders).where(eq(orders.publicId, order.publicId));
    expect(row).toMatchObject({ ownerUserId: alice.id, lockState: "none", projectName: "Synthetic project", version: view.version });
  });

  it("customer writes and sharing re-validate the session in-transaction (owner and invitee)", async () => {
    const order = await newOrder(alice);
    const view = await mod.assertCanReadOrder(alice.principal, order.publicId);
    const invite = await mod.sharing.invite(alice.principal, { orderId: order.publicId, email: bob.email, role: "viewer" });
    const stale = "UNAUTHENTICATED:SESSION_NOT_CURRENT";
    await withSession(alice, { revoked: true }, async () => {
      await expectError(mod.orders.update(alice.principal, { orderId: order.publicId, expectedVersion: view.version, projectName: "Renamed" }), stale);
      await expectError(mod.orders.addNote(alice.principal, { orderId: order.publicId, body: "Synthetic note" }), stale);
      await expectError(mod.sharing.invite(alice.principal, { orderId: order.publicId, email: carol.email, role: "viewer" }), stale);
      await expectError(mod.sharing.revoke(alice.principal, { orderId: order.publicId, grantId: invite.publicId }), stale);
      await expectError(newOrder(alice), stale);
    });
    await withSession(bob, { revoked: true }, async () => {
      await expectError(mod.sharing.respond(bob.principal, { grantId: invite.publicId, accept: true }), stale);
    });
    const grants = await mod.sharing.list(alice.principal, order.publicId);
    expect(grants.find((g) => g.publicId === invite.publicId)?.status).toBe("pending");
    expect(grants.some((g) => g.email === carol.email)).toBe(false);
  });

  it("fails closed when identity cannot verify the session", async () => {
    const identity = h.services.identity as unknown as { sessions?: unknown };
    const saved = identity.sessions;
    identity.sessions = undefined;
    try {
      await expectError(mod.catalog.createGroup(admin.principal, { name: "Unverifiable", description: "", sortOrder: 9, active: true }), "FORBIDDEN:ACTOR_UNVERIFIABLE");
      await expectError(newOrder(alice), "FORBIDDEN:ACTOR_UNVERIFIABLE");
    } finally {
      identity.sessions = saved;
    }
  });

  it("detail read uses one snapshot: a transfer committed mid-request never leaks the new owner's data to the old owner", async () => {
    const order = await newOrder(alice);
    const view = await mod.assertCanReadOrder(admin.principal, order.publicId);
    const original = mod.workflows.byVersionId;
    let injected = false;
    mod.workflows.byVersionId = async (db, versionId) => {
      if (!injected) {
        injected = true;
        // Runs AFTER authorization inside alice's read: move the order to bob and let bob write a note.
        await mod.orders.reassign(admin.principal, { orderId: order.publicId, targetCustomerPublicId: bob.publicId, expectedVersion: view.version, operationId: idemKey(), reasonCode: "MOVE" });
        await mod.orders.addNote(bob.principal, { orderId: order.publicId, body: "Synthetic post-transfer note" });
      }
      return original(db, versionId);
    };
    try {
      const detail = await mod.orders.get(alice.principal, order.publicId);
      expect(injected).toBe(true);
      expect(detail.notes.map((n) => n.body)).not.toContain("Synthetic post-transfer note");
      expect(detail.version).toBe(view.version);
    } finally {
      mod.workflows.byVersionId = original;
    }
    await expectError(mod.orders.get(alice.principal, order.publicId), "NOT_FOUND:ORDER_NOT_FOUND");
  });

  it("concurrent accept and reassign on the same order never deadlock (order row is locked first by both)", async () => {
    for (let round = 0; round < 5; round += 1) {
      const order = await newOrder(alice);
      const invite = await mod.sharing.invite(alice.principal, { orderId: order.publicId, email: carol.email, role: "viewer" });
      const view = await mod.assertCanReadOrder(admin.principal, order.publicId);
      const results = await Promise.allSettled([
        mod.sharing.respond(carol.principal, { grantId: invite.publicId, accept: true }),
        mod.orders.reassign(admin.principal, { orderId: order.publicId, targetCustomerPublicId: bob.publicId, expectedVersion: view.version, operationId: idemKey(), reasonCode: "MOVE" }),
      ]);
      for (const r of results) if (r.status === "rejected") expect(String((r.reason as Error)?.message ?? r.reason)).not.toMatch(/deadlock/i);
      expect(results[1]!.status).toBe("fulfilled");
      // Whatever the interleaving, carol never holds a live grant on the reassigned order.
      await expectError(mod.assertCanReadOrder(carol.principal, order.publicId), "NOT_FOUND:ORDER_NOT_FOUND");
    }
  });
});

describe("router guards", () => {
  const call = (principal: ReturnType<typeof fakePrincipal> | null) =>
    createCallerFactory(ordersRouter)({ services: h.services, session: principal, request: newRequestContext("test"), transport: { issue() {}, clear() {} } });

  it("customer cannot reach admin procedures; reassignment requires fresh step-up", async () => {
    await expect(call(alice.principal).admin.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    const order = await newOrder(alice);
    const view = await mod.assertCanReadOrder(admin.principal, order.publicId);
    const input = { orderId: order.publicId, targetCustomerPublicId: bob.publicId, expectedVersion: view.version, operationId: idemKey(), reasonCode: "MOVE" };
    const noStepUp = { ...admin.principal, stepUpAt: null };
    await expect(call(noStepUp).admin.reassign(input)).rejects.toMatchObject({ cause: expect.objectContaining({ code: "STEP_UP_REQUIRED" }) });
    await expect(call(staff.principal).admin.reassign(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(call(alice.principal).admin.catalog.createGroup({ name: "x", description: "", sortOrder: 0, active: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(call(null).list({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    // mass assignment: unknown keys are rejected by strict schemas
    await expect(call(alice.principal).update({ orderId: order.publicId, expectedVersion: 1, projectName: "x", ownerUserId: bob.id } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const list = await call(alice.principal).list({});
    expect(list.items.length).toBeGreaterThan(0);
  });
});

describe("portable hooks", () => {
  it("imports read-only, idempotently, with validated owner and preserved money/dates; refuses link conflicts", async () => {
    engagement.notifications = [];
    const input = {
      importId: "imp_test_1",
      sourceInstallationId: "src-install",
      sourceOrderPublicId: "SRC-ORDER-1",
      sourceReference: "LEGACY-0001",
      targetOwnerUserId: carol.id,
      projectName: "Imported project",
      statusKey: "in_progress",
      totalMinor: 5000,
      currency: "EUR",
      createdAt: new Date("2024-01-02T03:04:05.000Z"),
      lineItems: [{ sourcePublicId: "SRC-LI-1", productPublicId: null, productVersion: null, name: "Old item", description: "", features: [], unitPriceMinor: 2500, currency: "EUR", quantity: 2, lineTotalMinor: 5000 }],
      statusHistory: [{ sourcePublicId: "SRC-H-1", fromStatus: null, toStatus: "submitted", actorRole: "customer", reasonCode: "CREATED", occurredAt: new Date("2024-01-02T03:04:05.000Z") }],
      customerNotes: [{ sourcePublicId: "SRC-N-1", body: "Imported note", createdAt: new Date("2024-01-03T00:00:00.000Z") }],
    };
    const result = await t.db.transaction((tx) => mod.importOrder(input, tx));
    expect(result.created).toBe(true);
    expect(result.reference).toBe("LEGACY-0001");
    expect(result.receipts.lineItems[0]?.sourcePublicId).toBe("SRC-LI-1");
    const view = await mod.assertCanReadOrder(carol.principal, result.publicId);
    expect(view).toMatchObject({ lockState: "imported_read_only", readOnlyImported: true, origin: "import", statusKey: "in_progress" });
    await expectError(mod.assertCanWriteOrder(carol.principal, result.publicId, { kind: "file" }), "LOCKED:ORDER_LOCKED");
    await expectError(mod.assertCanWriteOrder(admin.principal, result.publicId, { kind: "order" }), "LOCKED:ORDER_LOCKED");
    const [row] = await t.db.select().from(orders).where(eq(orders.publicId, result.publicId));
    expect(row?.createdAt.toISOString()).toBe("2024-01-02T03:04:05.000Z");
    expect(engagement.notifications).toEqual([]);
    const again = await t.db.transaction((tx) => mod.importOrder(input, tx));
    expect(again).toMatchObject({ created: false, publicId: result.publicId });
    await expectError(t.db.transaction((tx) => mod.importOrder({ ...input, targetOwnerUserId: bob.id }, tx)), "CONFLICT:IMPORT_LINK_CONFLICT");
    await expectError(t.db.transaction((tx) => mod.importOrder({ ...input, sourceOrderPublicId: "SRC-2", targetOwnerUserId: admin.id }, tx)), "VALIDATION:IMPORT_OWNER_NOT_ELIGIBLE");
    await expectError(t.db.transaction((tx) => mod.importOrder({ ...input, sourceOrderPublicId: "SRC-3", totalMinor: 1 }, tx)), "VALIDATION:IMPORT_TOTAL_MISMATCH");
    await expectError(t.db.transaction((tx) => mod.importOrder({ ...input, sourceOrderPublicId: "SRC-5", statusKey: "mystery_state" }, tx)), "VALIDATION:IMPORT_STATUS_UNSUPPORTED");
    expect(await mod.isPortableStatusSupported("in_progress")).toBe(true);
    expect(await mod.isPortableStatusSupported("mystery_state")).toBe(false);
    expect(await mod.isPortableStatusSupported("")).toBe(false);
    expect(mod.preflightImportOrder(input)).toMatchObject({ ok: true });
    expect(mod.preflightImportOrder({ ...input, lineItems: [{ ...input.lineItems[0]!, lineTotalMinor: 4999 }] })).toMatchObject({ ok: false, reasonCode: "IMPORT_LINE_TOTAL_MISMATCH", paths: ["lineItems.0.lineTotalMinor"] });
    expect(mod.preflightImportOrder({ ...input, lineItems: [{ ...input.lineItems[0]!, currency: "USD" }] })).toMatchObject({ ok: false, reasonCode: "IMPORT_MIXED_CURRENCY" });
    expect(mod.preflightImportOrder({ ...input, totalMinor: 4999 })).toMatchObject({ ok: false, reasonCode: "IMPORT_TOTAL_MISMATCH" });
    expect(mod.preflightImportOrder({ ...input, projectName: "" })).toMatchObject({ ok: false, reasonCode: "IMPORT_ORDER_INVALID" });
    // reference collision ⇒ fresh target reference
    const collide = await t.db.transaction((tx) => mod.importOrder({ ...input, sourceOrderPublicId: "SRC-4" }, tx));
    expect(collide.reference).toMatch(/^RP-2026-/);
    expect(await mod.findImportedOrder("src-install", "SRC-ORDER-1")).toMatchObject({ publicId: result.publicId, importId: "imp_test_1" });

    const exported = await mod.portableOrders(t.db, { limit: 10, orderIds: [view.id] });
    expect(exported.items[0]).toMatchObject({ publicId: result.publicId, totalMinor: 5000, currency: "EUR", customerNotes: [expect.objectContaining({ body: "Imported note" })] });
    const lines = await t.db.select().from(orderLineItems).where(eq(orderLineItems.orderId, view.id));
    expect(lines[0]?.publicId).not.toBe("SRC-LI-1");
  });
});

describe("search", () => {
  it("is scoped to accessible orders and treats wildcards literally", async () => {
    await mod.orders.create(bob.principal, { projectName: "Zebra unique", items: [{ productPublicId: productB, quantity: 1 }], idempotencyKey: idemKey() });
    expect(await mod.searchOrders(alice.principal, "Zebra")).toEqual([]);
    expect((await mod.searchOrders(bob.principal, "Zebra")).length).toBe(1);
    expect((await mod.searchOrders(staff.principal, "Zebra")).length).toBe(1);
    expect(await mod.searchOrders(bob.principal, "%%")).toEqual([]);
  });
});
