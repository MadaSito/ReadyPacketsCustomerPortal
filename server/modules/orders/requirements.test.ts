/**
 * Increment 04 — workflow phases, requirements (uploads + acknowledgements), phase locks, Files ports, console
 * access grants and the checkout-in-tx port. Authorisation matrix: anonymous, customer, other customer, viewer
 * grantee, staff, admin (with and without step-up). All data SYNTHETIC.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { DomainError } from "../../core/errors.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { Services } from "../../container.js";
import type { Tx } from "../../core/types.js";
import { createCallerFactory } from "../../trpc/trpc.js";
import { createTestDeps, type fakePrincipal, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { users } from "../identity/schema.js";
import { createOrdersModule, type OrdersModule } from "./index.js";
import { sha256Hex } from "./requirements.js";
import { ordersRouter } from "./router.js";
import { orderAcknowledgements, orderGrants, orderNotes, orderPhaseLocks, orders } from "./schema.js";
import { validateDraft, type WorkflowDraftDefinition } from "./workflowDesign.js";
import { acknowledgementText } from "./workflowTypes.js";
import { FakeEngagement, FakeFiles, fakeIdentity, idemKey, insertUser, ordersTestSchema, type TestUser } from "./testSupport.js";

class CountingFiles extends FakeFiles {
  counts = new Map<string, number>();
  missing = false;
  async countFilesInSlot(orderId: number, slotKey: string, _tx?: Tx, options?: { statusKey?: string }) {
    return this.counts.get(`${orderId}:${options?.statusKey}:${slotKey}`) ?? 0;
  }
}

let t: TestDb;
let h: TestHarness;
let mod: OrdersModule;
let files: CountingFiles;
let engagement: FakeEngagement;
let admin: TestUser;
let adminNoStepUp: TestUser;
let staff: TestUser;
let alice: TestUser;
let bob: TestUser;
let carol: TestUser;
let productId: string;

const code = (error: unknown) => (error instanceof DomainError ? `${error.code}:${error.reasonCode}` : String(error));
async function expectError(promise: Promise<unknown>, expected: string): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    expect(code(error)).toBe(expected);
    return error as DomainError;
  }
  throw new Error(`expected ${expected}`);
}
const call = (principal: ReturnType<typeof fakePrincipal> | null) =>
  createCallerFactory(ordersRouter)({ services: h.services, session: principal, request: newRequestContext("test"), transport: { issue() {}, clear() {} } });

const TERMS = { key: "terms", title: "Project terms", body: "I confirm the brief is complete.\nI accept the schedule.", acceptedBy: "customer" as const, requireTypedName: true };

const RULES: WorkflowDraftDefinition = {
  phases: [
    { key: "intake", label: "Intake" },
    { key: "production", label: "Production" },
  ],
  states: [
    {
      key: "submitted",
      label: "Submitted",
      customerLabel: "Submitted",
      kind: "initial",
      tone: "info",
      phase: "intake",
      requirements: {
        uploads: [{ key: "brief", label: "Project brief", kind: "document", minCount: 1, maxCount: 2, allowedTypes: ["pdf", "docx"], uploadedBy: ["customer"] }],
        acknowledgements: [TERMS],
      },
    },
    { key: "in_review", label: "In review", customerLabel: "Being reviewed", kind: "active", tone: "info", phase: "intake" },
    { key: "in_progress", label: "In progress", customerLabel: "In progress", kind: "active", tone: "info", phase: "production" },
    { key: "completed", label: "Completed", customerLabel: "Completed", kind: "terminal", tone: "success", phase: "production" },
    { key: "canceled", label: "Canceled", customerLabel: "Canceled", kind: "terminal", tone: "neutral" },
  ],
  transitions: [
    { from: "submitted", to: "in_review", allowedBy: ["customer", "staff", "admin"], notifyCustomer: true, requiresNote: false },
    { from: "submitted", to: "canceled", allowedBy: ["customer", "staff", "admin"], notifyCustomer: true, requiresNote: false },
    { from: "in_review", to: "in_progress", allowedBy: ["staff", "admin"], notifyCustomer: true, requiresNote: false },
    { from: "in_progress", to: "in_review", allowedBy: ["staff", "admin"], notifyCustomer: true, requiresNote: false },
    { from: "in_progress", to: "completed", allowedBy: ["staff", "admin"], notifyCustomer: true, requiresNote: false },
  ],
};

const newOrder = (who: TestUser = alice) => mod.orders.create(who.principal, { projectName: "Synthetic", items: [{ productPublicId: productId, quantity: 1 }], idempotencyKey: idemKey() });
const orderRow = async (publicId: string) => (await t.db.select().from(orders).where(eq(orders.publicId, publicId)))[0]!;
const move = async (who: TestUser, publicId: string, toStatus: string) => {
  const row = await orderRow(publicId);
  return mod.orders.transition(who.principal, { orderId: publicId, expectedVersion: row.version, toStatus });
};
const termsSha = sha256Hex(acknowledgementText(TERMS));

beforeAll(async () => {
  t = await createTestDb({ schema: ordersTestSchema });
  h = createTestDeps({ db: t.db });
  mod = createOrdersModule(h.deps);
  h.services.orders = mod;
  const identity = fakeIdentity(h, t.db);
  const extended = {
    ...identity,
    async findUserIdByEmail(email: string, opts?: { tx?: Tx }) {
      const index = h.deps.crypto.blindIndex(email.trim().toLowerCase(), "users.email");
      const [row] = await (opts?.tx ?? t.db).select().from(users).where(eq(users.emailIndex, index)).limit(1);
      return row ? { userId: row.id, publicId: row.publicId, role: row.role, status: row.status } : null;
    },
    async searchCustomers(_principal: unknown, input: { query?: string }) {
      const rows = await t.db.select().from(users).where(eq(users.role, "customer"));
      const items = [];
      for (const row of rows) {
        const user = await identity.getUser(row.id);
        if (user && (!input.query || user.name.includes(input.query) || user.email.includes(input.query)))
          items.push({ publicId: user.publicId, name: user.name, email: user.email, customerRef: user.customerRef, status: user.status, role: user.role });
      }
      return { items, nextCursor: null };
    },
  };
  h.services.identity = extended as unknown as Services["identity"];
  files = new CountingFiles();
  h.services.files = files as unknown as Services["files"];
  engagement = new FakeEngagement();
  h.services.engagement = engagement as unknown as Services["engagement"];
  admin = await insertUser(h, t.db, { role: "admin", stepUp: true });
  adminNoStepUp = await insertUser(h, t.db, { role: "admin" });
  staff = await insertUser(h, t.db, { role: "staff", stepUp: true });
  alice = await insertUser(h, t.db);
  bob = await insertUser(h, t.db);
  carol = await insertUser(h, t.db);
  const group = await mod.catalog.createGroup(admin.principal, { name: "Synthetic group", description: "", sortOrder: 0, active: true });
  await mod.catalog.createProduct(admin.principal, {
    groupId: group.publicId,
    productKey: "synthetic-req-1",
    sortOrder: 0,
    active: true,
    name: "Synthetic item",
    description: "",
    features: [],
    priceMinor: 1000,
    currency: "USD",
  });
  productId = (await mod.catalog.listAll())[0]!.products[0]!.publicId;
});
afterAll(() => t.cleanup());

describe("designer validation for phases and requirements", () => {
  it("accepts a sound rules definition", () => {
    expect(validateDraft(RULES).filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it("reports precise codes for broken rules", () => {
    const broken: WorkflowDraftDefinition = JSON.parse(JSON.stringify(RULES));
    broken.phases!.push({ key: "intake", label: "" });
    broken.states[1]!.phase = "ghost";
    const req = broken.states[0]!.requirements!;
    req.uploads.push({ ...req.uploads[0]!, minCount: 3, maxCount: 2, allowedTypes: [".pdf"], uploadedBy: [] });
    req.acknowledgements.push({ ...TERMS, key: "x", title: "", body: "<script>alert(1)</script>" });
    const codes = validateDraft(broken).filter((issue) => issue.severity === "error").map((issue) => `${issue.code}@${issue.path}`);
    expect(codes).toEqual(
      expect.arrayContaining([
        "PHASE_KEY_DUPLICATE@phases.2.key",
        "PHASE_LABEL_REQUIRED@phases.2.label",
        "STATE_PHASE_UNKNOWN@states.1.phase",
        "UPLOAD_KEY_DUPLICATE@states.0.requirements.uploads.1.key",
        "UPLOAD_MIN_ABOVE_MAX@states.0.requirements.uploads.1.minCount",
        "UPLOAD_TYPE_FORMAT@states.0.requirements.uploads.1.allowedTypes",
        "UPLOAD_NOBODY@states.0.requirements.uploads.1.uploadedBy",
        "ACK_KEY_FORMAT@states.0.requirements.acknowledgements.1.key",
        "ACK_TITLE_REQUIRED@states.0.requirements.acknowledgements.1.title",
        "ACK_MARKUP@states.0.requirements.acknowledgements.1.body",
      ]),
    );
  });
});

describe("publishing rules is gated by the feature setting", () => {
  it("refuses while off, publishes as default once on", async () => {
    const draft = await mod.workflows.createDraft(admin.principal, { from: "blank", workflowKey: "rules_flow", name: "Rules flow" });
    await mod.workflows.saveDraft(admin.principal, { draftId: draft.publicId, expectedVersion: 1, name: "Rules flow", definition: RULES });
    await expectError(mod.workflows.publishDraft(admin.principal, { draftId: draft.publicId, expectedVersion: 2, makeDefault: true }), "VALIDATION:WORKFLOW_RULES_DISABLED");
    await h.settings.set("orders.workflow_rules.enabled", true);
    await mod.workflows.publishDraft(admin.principal, { draftId: draft.publicId, expectedVersion: 2, makeDefault: true });
  });
});

describe("requirements block transitions until met", () => {
  let orderId: string;
  it("shows the checklist and refuses to leave the status", async () => {
    orderId = (await newOrder()).publicId;
    const view = await call(alice.principal).requirements.forOrder({ orderId });
    expect(view.phases.map((phase) => `${phase.key}:${phase.position}:${phase.locked}`)).toEqual(["intake:current:false", "production:upcoming:false"]);
    expect(view.unmet).toBe(2);
    expect(view.uploads[0]).toMatchObject({ key: "brief", count: 0, met: false, canUpload: true });
    expect(view.acknowledgements[0]).toMatchObject({ key: "terms", textSha256: termsSha, met: false, canAccept: true });
    const refused = await expectError(move(alice, orderId, "in_review"), "VALIDATION:REQUIREMENTS_UNMET");
    expect(refused.details).toEqual({ uploads: ["brief"], acknowledgements: ["terms"] });
    await expectError(move(staff, orderId, "in_review"), "VALIDATION:REQUIREMENTS_UNMET");
  });

  it("does not block cancellation", async () => {
    const other = (await newOrder()).publicId;
    await move(alice, other, "canceled");
  });

  it("authorisation matrix for read and acknowledge", async () => {
    await expect(call(null).requirements.forOrder({ orderId })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expectError(mod.requirements.forOrder(bob.principal, { orderId }), "NOT_FOUND:ORDER_NOT_FOUND");
    await expectError(mod.requirements.acknowledge(bob.principal, { orderId, statusKey: "submitted", ackKey: "terms", textSha256: termsSha, typedName: "Bob" }), "NOT_FOUND:ORDER_NOT_FOUND");
    await expectError(mod.requirements.acknowledge(staff.principal, { orderId, statusKey: "submitted", ackKey: "terms", textSha256: termsSha }), "FORBIDDEN:ACK_WRONG_SIDE");
    const staffView = await mod.requirements.forOrder(staff.principal, { orderId });
    expect(staffView.acknowledgements[0]!.canAccept).toBe(false);
    expect(staffView.uploads[0]!.canUpload).toBe(false);
  });

  it("records an acknowledgement of the exact text, once", async () => {
    await expectError(mod.requirements.acknowledge(alice.principal, { orderId, statusKey: "submitted", ackKey: "terms", textSha256: "0".repeat(64), typedName: "Alice" }), "CONFLICT:ACK_TEXT_CHANGED");
    await expectError(mod.requirements.acknowledge(alice.principal, { orderId, statusKey: "submitted", ackKey: "terms", textSha256: termsSha }), "VALIDATION:TYPED_NAME_REQUIRED");
    await expectError(mod.requirements.acknowledge(alice.principal, { orderId, statusKey: "submitted", ackKey: "nope", textSha256: termsSha }), "VALIDATION:ACK_NOT_FOUND");
    await expect(call(alice.principal).requirements.acknowledge({ orderId, statusKey: "submitted", ackKey: "terms", textSha256: "xyz" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    h.audit.events.length = 0;
    const done = await call(alice.principal).requirements.acknowledge({ orderId, statusKey: "submitted", ackKey: "terms", textSha256: termsSha, typedName: "Alice Synthetic" });
    expect(done.acknowledgementId).toMatch(/^[0-9A-Z]{26}$/);
    const [row] = await t.db.select().from(orderAcknowledgements).where(eq(orderAcknowledgements.publicId, done.acknowledgementId));
    expect(row).toMatchObject({ textSha256: termsSha, userId: alice.id, sessionId: alice.principal.sessionId, acceptorSide: "customer" });
    expect(row!.typedNameEnc).not.toContain("Alice");
    const event = h.audit.events.find((candidate) => candidate.eventName === "order.acknowledgement.recorded");
    expect(event?.attributes).toMatchObject({ text_sha256: termsSha, ack_key: "terms", acceptor_side: "customer" });
    expect(h.audit.recordedInTx.at(-1)).toBe(true);
    await expectError(mod.requirements.acknowledge(alice.principal, { orderId, statusKey: "submitted", ackKey: "terms", textSha256: termsSha, typedName: "Alice" }), "CONFLICT:ACK_ALREADY_RECORDED");
  });

  it("files ports expose writable slots per actor side", async () => {
    expect(await mod.getFileUploadSlots(alice.principal, orderId)).toEqual({
      statusKey: "submitted",
      slots: [{ key: "brief", label: "Project brief", kind: "document", maxCount: 2, allowedTypes: ["pdf", "docx"] }],
    });
    expect((await mod.getFileUploadSlots(staff.principal, orderId)).slots).toEqual([]);
    await expectError(mod.getFileUploadSlots(bob.principal, orderId), "NOT_FOUND:ORDER_NOT_FOUND");
    await t.db.transaction(async (tx) => {
      expect(await mod.getFileSlotForCustody(orderId, "submitted", "brief", tx)).toMatchObject({ key: "brief", maxCount: 2 });
      expect(await mod.getFileSlotForCustody(orderId, "submitted", "ghost", tx)).toBeNull();
    });
    expect((await mod.getOrderRefByPublicId(orderId))?.workflowVersionId).toBeGreaterThan(0);
  });

  it("allows the transition once uploads are counted, and fails closed without files", async () => {
    const row = await orderRow(orderId);
    files.counts.set(`${row.id}:submitted:brief`, 1);
    const saved = h.services.files;
    h.services.files = new FakeFiles() as unknown as Services["files"];
    await expectError(move(alice, orderId, "in_review"), "UNAVAILABLE:FILES_UNAVAILABLE");
    h.services.files = saved;
    await move(alice, orderId, "in_review");
    expect((await mod.requirements.forOrder(alice.principal, { orderId })).unmet).toBe(0);
  });

  it("locks the phase being left, enforces it, and staff can unlock with a reason", async () => {
    await move(staff, orderId, "in_progress");
    const [lock] = await t.db.select().from(orderPhaseLocks).where(eq(orderPhaseLocks.orderId, (await orderRow(orderId)).id));
    expect(lock).toMatchObject({ phaseKey: "intake", state: "locked", lockedFromStatus: "in_review" });
    const view = await mod.requirements.forOrder(staff.principal, { orderId });
    expect(view.phases.map((phase) => `${phase.key}:${phase.position}:${phase.locked}`)).toEqual(["intake:done:true", "production:current:false"]);
    expect(view.canUnlock).toBe(true);
    await expectError(mod.assertFileStatusWritable(alice.principal, orderId, "submitted"), "FORBIDDEN:PHASE_LOCKED");
    await mod.assertFileStatusWritable(alice.principal, orderId, "in_progress");
    await expectError(mod.requirements.acknowledge(alice.principal, { orderId, statusKey: "submitted", ackKey: "terms", textSha256: termsSha, typedName: "A" }), "FORBIDDEN:PHASE_LOCKED");
    await expect(call(alice.principal).phases.unlock({ orderId, phaseKey: "intake", reason: "Please fix the brief", notifyCustomer: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(call(staff.principal).phases.unlock({ orderId, phaseKey: "intake", reason: "short", notifyCustomer: false })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(call(null).phases.unlock({ orderId, phaseKey: "intake", reason: "Please fix the brief", notifyCustomer: false })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expectError(mod.requirements.unlockPhase(staff.principal, { orderId, phaseKey: "production", reason: "Not locked at all", notifyCustomer: false }), "CONFLICT:PHASE_NOT_LOCKED");
    engagement.notifications.length = 0;
    await call(staff.principal).phases.unlock({ orderId, phaseKey: "intake", reason: "Customer sent a corrected brief", notifyCustomer: true });
    await mod.assertFileStatusWritable(alice.principal, orderId, "submitted");
    expect(engagement.notifications.map((n) => `${n.userId}:${n.kind}`)).toEqual([`${alice.id}:order.phase_unlocked`]);
    const notes = await t.db.select().from(orderNotes).where(and(eq(orderNotes.orderId, (await orderRow(orderId)).id), eq(orderNotes.visibility, "internal")));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.bodyEnc).not.toContain("corrected");
    expect(h.audit.events.some((event) => event.eventName === "order.phase.unlocked")).toBe(true);
  });

  it("re-locks at the next status change and reopens a phase the order re-enters", async () => {
    await move(staff, orderId, "in_review");
    const rows = await t.db.select().from(orderPhaseLocks).where(eq(orderPhaseLocks.orderId, (await orderRow(orderId)).id));
    expect(rows.map((row) => `${row.phaseKey}:${row.state}`).sort()).toEqual(["intake:unlocked", "production:locked"]);
    await move(staff, orderId, "in_progress");
    await expectError(mod.assertFileStatusWritable(alice.principal, orderId, "submitted"), "FORBIDDEN:PHASE_LOCKED");
  });
});

describe("console access grants (item 13)", () => {
  let orderId: string;
  it("is off by default and needs admin + step-up", async () => {
    orderId = (await newOrder()).publicId;
    await expectError(mod.access.grant(admin.principal, { scope: { orderId }, email: bob.email, role: "viewer" }), "FORBIDDEN:FEATURE_DISABLED");
    await h.settings.set("orders.console_access.enabled", true);
    await expect(call(staff.principal).admin.access.grant({ scope: { orderId }, email: bob.email, role: "viewer" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(call(alice.principal).admin.access.grant({ scope: { orderId }, email: bob.email, role: "viewer" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(call(null).admin.access.grant({ scope: { orderId }, email: bob.email, role: "viewer" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(call(adminNoStepUp.principal).admin.access.grant({ scope: { orderId }, email: bob.email, role: "viewer" })).rejects.toMatchObject({ message: expect.stringMatching(/confirm|step/i) });
  });

  it("refuses unknown, ineligible and owner addresses with the same answer", async () => {
    await expectError(mod.access.grant(admin.principal, { scope: { orderId }, email: "nobody@example.test", role: "viewer" }), "VALIDATION:GRANTEE_NOT_FOUND");
    await expectError(mod.access.grant(admin.principal, { scope: { orderId }, email: alice.email, role: "viewer" }), "VALIDATION:GRANTEE_NOT_FOUND");
    await expectError(mod.access.grant(admin.principal, { scope: { orderId }, email: staff.email, role: "viewer" }), "VALIDATION:GRANTEE_NOT_FOUND");
  });

  it("grants a single order at once, notifies both parties, and viewers stay read-only", async () => {
    engagement.notifications.length = 0;
    const granted = await call(admin.principal).admin.access.grant({ scope: { orderId }, email: bob.email.toUpperCase(), role: "viewer" });
    expect(granted).toMatchObject({ scope: "order", ordersCovered: 1 });
    expect(engagement.notifications.map((n) => n.userId).sort()).toEqual([alice.id, bob.id].sort());
    expect((await mod.assertCanReadOrder(bob.principal, orderId)).accessRole).toBe("viewer");
    await expectError(mod.requirements.acknowledge(bob.principal, { orderId, statusKey: "submitted", ackKey: "terms", textSha256: termsSha, typedName: "Bob" }), "FORBIDDEN:GRANT_READ_ONLY");
    expect((await mod.getFileUploadSlots(bob.principal, orderId)).slots).toEqual([]);
    await expectError(mod.access.grant(admin.principal, { scope: { orderId }, email: bob.email, role: "contributor" }), "CONFLICT:ALREADY_SHARED");
    const listed = await call(staff.principal).admin.access.list({ orderId });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ scope: "order", role: "viewer", status: "active" });
    expect(listed.items[0]!.granteeEmailMasked).not.toBe(bob.email);
    await expect(call(alice.principal).admin.access.list({ orderId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await call(admin.principal).admin.access.revoke({ grantId: granted.grantId });
    await expectError(mod.assertCanReadOrder(bob.principal, orderId), "NOT_FOUND:ORDER_NOT_FOUND");
  });

  it("customer-wide grants cover current and future orders and revoke together", async () => {
    const existing = await t.db.select({ id: orders.id }).from(orders).where(eq(orders.ownerUserId, alice.id));
    const granted = await mod.access.grant(admin.principal, { scope: { customerPublicId: alice.publicId }, email: carol.email, role: "contributor" });
    expect(granted.ordersCovered).toBe(existing.length);
    expect((await mod.assertCanReadOrder(carol.principal, orderId)).accessRole).toBe("contributor");
    const later = (await newOrder()).publicId;
    expect((await mod.assertCanReadOrder(carol.principal, later)).accessRole).toBe("contributor");
    expect((await mod.requirements.forOrder(carol.principal, { orderId: later })).acknowledgements[0]!.canAccept).toBe(true);
    expect((await mod.access.list(staff.principal, { customerPublicId: alice.publicId })).items).toHaveLength(1);
    await expectError(mod.access.grant(admin.principal, { scope: { customerPublicId: alice.publicId }, email: carol.email, role: "viewer" }), "CONFLICT:ALREADY_SHARED");
    await mod.access.revoke(admin.principal, { grantId: granted.grantId });
    await expectError(mod.assertCanReadOrder(carol.principal, later), "NOT_FOUND:ORDER_NOT_FOUND");
    const live = await t.db.select().from(orderGrants).where(and(eq(orderGrants.granteeUserId, carol.id), eq(orderGrants.status, "active")));
    expect(live).toHaveLength(0);
    await expectError(mod.access.revoke(admin.principal, { grantId: granted.grantId }), "CONFLICT:GRANT_NOT_ACTIVE");
  });

  it("customer lookup is staff-only and masks e-mail", async () => {
    const hits = await call(staff.principal).admin.customerLookup({ query: "Synthetic" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => !hit.emailMasked.includes(alice.email.split("@")[0]!.slice(1)))).toBe(true);
    await expect(call(alice.principal).admin.customerLookup({ query: "Synthetic" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("checkout-in-tx port", () => {
  it("creates inside the caller's transaction and is idempotent; customers only", async () => {
    const key = idemKey();
    const first = await t.db.transaction((tx) => mod.createOrderFromCheckoutInTx(alice.principal, { projectName: "Cart", items: [{ productPublicId: productId, quantity: 2 }], idempotencyKey: key }, tx));
    expect(first).toMatchObject({ created: true, subtotalMinor: 2000, totalMinor: 2000, currency: "USD" });
    expect(first.lineItems).toEqual([expect.objectContaining({ productPublicId: productId, quantity: 2, lineTotalMinor: 2000 })]);
    const again = await t.db.transaction((tx) => mod.createOrderFromCheckoutInTx(alice.principal, { projectName: "Cart", items: [{ productPublicId: productId, quantity: 2 }], idempotencyKey: key }, tx));
    expect(again).toMatchObject({ created: false, publicId: first.publicId });
    await expectError(
      t.db.transaction((tx) => mod.createOrderFromCheckoutInTx(staff.principal, { projectName: "Cart", items: [{ productPublicId: productId, quantity: 1 }], idempotencyKey: idemKey() }, tx)),
      "FORBIDDEN:CAPABILITY_NOT_GRANTED",
    );
  });
});
