/**
 * Increment 06 (D8) — customer tasks: record, acknowledge (per-order staff note), respond_document, staff waive,
 * designer validation and the Files slot port. Abuse and router-auth cases included. All data SYNTHETIC.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { DomainError } from "../../core/errors.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { Services } from "../../container.js";
import type { Tx } from "../../core/types.js";
import { createCallerFactory } from "../../trpc/trpc.js";
import { createTestDeps, type fakePrincipal, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { users } from "../identity/schema.js";
import { createOrdersModule, type OrdersModule } from "./index.js";
import { documentAckText, sha256Hex } from "./requirements.js";
import { ordersRouter } from "./router.js";
import { orderNotes, orderTaskNotes, orderTaskWaivers, orders } from "./schema.js";
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
let staff: TestUser;
let alice: TestUser;
let bob: TestUser;
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

const NOTE_ACK = { key: "brief_note", title: "Your brief", body: "Please confirm the brief we wrote for you.", acceptedBy: "customer" as const, requireTypedName: false, source: "order_note" as const };
const DOC = { key: "contract", label: "Contract", hint: "Review and sign.", responseModes: ["upload_reply" as const, "acknowledge" as const], required: true, allowedTypes: ["docx", "pdf"] };

const RULES: WorkflowDraftDefinition = {
  states: [
    {
      key: "submitted",
      label: "Submitted",
      customerLabel: "Submitted",
      kind: "initial",
      tone: "info",
      requirements: {
        uploads: [{ key: "voice", label: "Voice note", kind: "audio", minCount: 1, maxCount: 1, allowedTypes: ["mp3", "m4a"], uploadedBy: ["customer"], capture: "record", maxMinutes: 5 }],
        acknowledgements: [NOTE_ACK],
        documents: [DOC],
      },
    },
    { key: "in_review", label: "In review", customerLabel: "Being reviewed", kind: "active", tone: "info" },
    { key: "completed", label: "Completed", customerLabel: "Completed", kind: "terminal", tone: "success" },
    { key: "canceled", label: "Canceled", customerLabel: "Canceled", kind: "terminal", tone: "neutral" },
  ],
  transitions: [
    { from: "submitted", to: "in_review", allowedBy: ["customer", "staff", "admin"], notifyCustomer: true, requiresNote: false },
    { from: "submitted", to: "canceled", allowedBy: ["customer", "staff", "admin"], notifyCustomer: true, requiresNote: false },
    { from: "in_review", to: "completed", allowedBy: ["staff", "admin"], notifyCustomer: true, requiresNote: false },
  ],
};

const newOrder = (who: TestUser = alice) => mod.orders.create(who.principal, { projectName: "Synthetic", items: [{ productPublicId: productId, quantity: 1 }], idempotencyKey: idemKey() });
const orderRow = async (publicId: string) => (await t.db.select().from(orders).where(eq(orders.publicId, publicId)))[0]!;
const move = async (who: TestUser, publicId: string, toStatus: string) => {
  const row = await orderRow(publicId);
  return mod.orders.transition(who.principal, { orderId: publicId, expectedVersion: row.version, toStatus });
};
const docSha = sha256Hex(documentAckText(DOC));

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
  staff = await insertUser(h, t.db, { role: "staff", stepUp: true });
  alice = await insertUser(h, t.db);
  bob = await insertUser(h, t.db);
  const group = await mod.catalog.createGroup(admin.principal, { name: "Synthetic group", description: "", sortOrder: 0, active: true });
  await mod.catalog.createProduct(admin.principal, {
    groupId: group.publicId,
    productKey: "synthetic-task-1",
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

const setCount = async (publicId: string, slotKey: string, n: number) => files.counts.set(`${(await orderRow(publicId)).id}:submitted:${slotKey}`, n);

describe("D8 definitions", () => {
  it("old definitions without tasks still parse; new task fields validate", () => {
    const legacy = { uploads: [{ key: "brief", label: "Brief", kind: "document", minCount: 1, maxCount: 1, allowedTypes: ["pdf"], uploadedBy: ["customer"] }], acknowledgements: [] };
    expect(validateDraft({ ...RULES, states: RULES.states.map((s, i) => (i === 0 ? { ...s, requirements: legacy as never } : s)) }).filter((x) => x.severity === "error")).toEqual([]);
    expect(validateDraft(RULES).filter((x) => x.severity === "error")).toEqual([]);
  });

  it("reports precise codes with jump paths for broken tasks", () => {
    const broken: WorkflowDraftDefinition = JSON.parse(JSON.stringify(RULES));
    const req = broken.states[0]!.requirements!;
    req.uploads.push({ key: "doc_rec", label: "Doc", kind: "document", minCount: 0, maxCount: 1, allowedTypes: ["pdf"], uploadedBy: ["customer"], capture: "record" });
    req.uploads[0]!.maxMinutes = 999;
    req.acknowledgements.push({ ...NOTE_ACK, key: "staff_note", acceptedBy: "staff" });
    req.documents!.push({ key: "contract", label: "", responseModes: [], required: true, allowedTypes: ["pdf"] });
    req.documents!.push({ key: "Bad Key", label: "Edit", responseModes: ["edit_in_portal", "edit_in_portal"], required: true, allowedTypes: ["pdf"] });
    const codes = validateDraft(broken).filter((x) => x.severity === "error").map((x) => `${x.code}@${x.path}`);
    expect(codes).toEqual(
      expect.arrayContaining([
        "RECORD_NOT_AUDIO@states.0.requirements.uploads.1.capture",
        "RECORD_MINUTES_RANGE@states.0.requirements.uploads.0.maxMinutes",
        "ACK_NOTE_SIDE@states.0.requirements.acknowledgements.1.acceptedBy",
        "DOC_KEY_DUPLICATE@states.0.requirements.documents.1.key",
        "DOC_LABEL_REQUIRED@states.0.requirements.documents.1.label",
        "DOC_RESPONSE_REQUIRED@states.0.requirements.documents.1.responseModes",
        "DOC_KEY_FORMAT@states.0.requirements.documents.2.key",
        "DOC_RESPONSE_DUPLICATE@states.0.requirements.documents.2.responseModes",
        "DOC_EDIT_NEEDS_DOCX@states.0.requirements.documents.2.allowedTypes",
      ]),
    );
  });
});

describe("D8 customer tasks on an order", () => {
  let orderId: string;
  beforeAll(async () => {
    await h.settings.set("orders.workflow_rules.enabled", true);
    const draft = await mod.workflows.createDraft(admin.principal, { from: "blank", workflowKey: "tasks_flow", name: "Tasks flow" });
    await mod.workflows.saveDraft(admin.principal, { draftId: draft.publicId, expectedVersion: 1, name: "Tasks flow", definition: RULES });
    await mod.workflows.publishDraft(admin.principal, { draftId: draft.publicId, expectedVersion: 2, makeDefault: true });
    orderId = (await newOrder()).publicId;
  });

  it("shows record, note and document tasks; blocks the transition with details", async () => {
    const view = await call(alice.principal).requirements.forOrder({ orderId });
    expect(view.uploads[0]).toMatchObject({ key: "voice", taskKind: "record", capture: "record", maxMinutes: 5, waived: false });
    expect(view.acknowledgements[0]).toMatchObject({ key: "brief_note", orderNote: null, canAccept: false, canEditNote: false });
    expect(view.documents[0]).toMatchObject({ key: "contract", replySlotKey: "contract_reply", sourceCount: 0, met: false, canReply: false, canStaffUpload: false, textSha256: docSha });
    expect(view.canWaive).toBe(false);
    const refused = await expectError(move(alice, orderId, "in_review"), "VALIDATION:REQUIREMENTS_UNMET");
    expect(refused.details).toEqual({ uploads: ["voice"], acknowledgements: ["brief_note"], documents: ["contract"] });
    const staffView = await mod.requirements.forOrder(staff.principal, { orderId });
    expect(staffView).toMatchObject({ canWaive: true });
    expect(staffView.acknowledgements[0]!.canEditNote).toBe(true);
    expect(staffView.documents[0]!.canStaffUpload).toBe(true);
  });

  it("files port: customer gets record + reply slots, staff get the document source slot", async () => {
    const customer = await mod.getFileUploadSlots(alice.principal, orderId);
    expect(customer.slots.map((slot) => `${slot.key}:${slot.task.kind}`)).toEqual(["voice:record", "contract_reply:document_reply"]);
    expect(customer.slots[0]).toMatchObject({ capture: "record", maxMinutes: 5, acceptsUpload: true });
    expect(customer.slots[1]).toMatchObject({ acceptsUpload: true, acceptsEdit: false, sourceSlotKey: "contract", allowedTypes: ["docx", "pdf"] });
    expect((await mod.getFileUploadSlots(staff.principal, orderId)).slots.map((slot) => slot.key)).toEqual(["contract"]);
    await t.db.transaction(async (tx) => {
      expect(await mod.getFileSlotForCustody(orderId, "submitted", "contract_reply", tx)).toMatchObject({ task: { kind: "document_reply", taskKey: "contract" } });
    });
  });

  it("order note: customers, viewers and other customers cannot write it; staff write plain text, audited", async () => {
    const input = { orderId, statusKey: "submitted", ackKey: "brief_note", body: "Synthetic brief: two pages." };
    await expect(call(null).requirements.setTaskNote(input)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(call(alice.principal).requirements.setTaskNote(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expectError(mod.requirements.setTaskNote(alice.principal, input), "NOT_FOUND:ORDER_NOT_FOUND");
    await expectError(mod.requirements.setTaskNote(bob.principal, input), "NOT_FOUND:ORDER_NOT_FOUND");
    await expect(call(staff.principal).requirements.setTaskNote({ ...input, body: "x".repeat(4001) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expectError(mod.requirements.setTaskNote(staff.principal, { ...input, body: "<img src=x onerror=alert(1)>" }), "VALIDATION:TASK_NOTE_MARKUP");
    await expectError(mod.requirements.setTaskNote(staff.principal, { ...input, ackKey: "ghost" }), "VALIDATION:TASK_NOT_FOUND");
    await expectError(mod.requirements.acknowledge(alice.principal, { orderId, statusKey: "submitted", ackKey: "brief_note", textSha256: "0".repeat(64) }), "CONFLICT:ACK_NOTE_MISSING");
    h.audit.events.length = 0;
    const saved = await call(staff.principal).requirements.setTaskNote(input);
    expect(saved.version).toBe(1);
    const [row] = await t.db.select().from(orderTaskNotes).where(eq(orderTaskNotes.publicId, saved.notePublicId));
    expect(row!.bodyEnc).not.toContain("Synthetic brief");
    const event = h.audit.events.find((candidate) => candidate.eventName === "order.task_note.saved");
    expect(event?.attributes).toMatchObject({ ack_key: "brief_note", note_version: 1 });
    expect(JSON.stringify(event)).not.toContain("Synthetic brief");
    expect(h.audit.recordedInTx.at(-1)).toBe(true);
    await expectError(mod.requirements.setTaskNote(staff.principal, { ...input, body: "Changed.", expectedVersion: 7 }), "CONFLICT:STALE_VERSION");
    const second = await mod.requirements.setTaskNote(staff.principal, { ...input, body: "Synthetic brief: three pages.", expectedVersion: 1 });
    expect(second.textSha256).toBe(sha256Hex(acknowledgementText(NOTE_ACK, "Synthetic brief: three pages.")));
    const view = await mod.requirements.forOrder(alice.principal, { orderId });
    expect(view.acknowledgements[0]).toMatchObject({ orderNote: "Synthetic brief: three pages.", textSha256: second.textSha256 });
    // The customer must acknowledge the exact current text; afterwards the note is frozen.
    await expectError(mod.requirements.acknowledge(alice.principal, { orderId, statusKey: "submitted", ackKey: "brief_note", textSha256: saved.textSha256 }), "CONFLICT:ACK_TEXT_CHANGED");
    await mod.requirements.acknowledge(alice.principal, { orderId, statusKey: "submitted", ackKey: "brief_note", textSha256: second.textSha256 });
    await expectError(mod.requirements.setTaskNote(staff.principal, { ...input, body: "Too late." }), "CONFLICT:TASK_NOTE_ACKNOWLEDGED");
  });

  it("respond_document: acknowledge needs the staff document first, then counts as met", async () => {
    await expectError(mod.requirements.acknowledge(alice.principal, { orderId, statusKey: "submitted", ackKey: "contract", textSha256: docSha }), "CONFLICT:DOCUMENT_NOT_READY");
    await setCount(orderId, "contract", 1);
    await expectError(mod.requirements.acknowledge(staff.principal, { orderId, statusKey: "submitted", ackKey: "contract", textSha256: docSha }), "FORBIDDEN:ACK_WRONG_SIDE");
    await mod.requirements.acknowledge(alice.principal, { orderId, statusKey: "submitted", ackKey: "contract", textSha256: docSha });
    const view = await mod.requirements.forOrder(alice.principal, { orderId });
    expect(view.documents[0]).toMatchObject({ sourceCount: 1, acknowledged: true, met: true, canReply: true });
  });

  it("a reply file also meets a document task", async () => {
    const other = (await newOrder()).publicId;
    await setCount(other, "contract", 1);
    await setCount(other, "contract_reply", 1);
    expect((await mod.requirements.forOrder(alice.principal, { orderId: other })).documents[0]!.met).toBe(true);
  });

  it("waive: staff only, reason required, once, audited; a waived task counts as met", async () => {
    const input = { orderId, statusKey: "submitted", taskKey: "voice", reason: "Customer sent the recording by post." };
    await expect(call(null).requirements.waive(input)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(call(alice.principal).requirements.waive(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expectError(mod.requirements.waiveTask(alice.principal, input), "NOT_FOUND:ORDER_NOT_FOUND");
    await expectError(mod.requirements.waiveTask(bob.principal, input), "NOT_FOUND:ORDER_NOT_FOUND");
    await expect(call(staff.principal).requirements.waive({ ...input, reason: "short" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expectError(mod.requirements.waiveTask(staff.principal, { ...input, taskKey: "ghost" }), "VALIDATION:TASK_NOT_FOUND");
    h.audit.events.length = 0;
    const done = await call(staff.principal).requirements.waive(input);
    expect(done.waiverId).toMatch(/^[0-9A-Z]{26}$/);
    const [row] = await t.db.select().from(orderTaskWaivers).where(eq(orderTaskWaivers.publicId, done.waiverId));
    expect(row).toMatchObject({ taskKind: "record", waivedByUserId: staff.id });
    const [note] = await t.db.select().from(orderNotes).where(eq(orderNotes.publicId, row!.reasonNotePublicId));
    expect(note).toMatchObject({ visibility: "internal" });
    expect(note!.bodyEnc).not.toContain("by post");
    const event = h.audit.events.find((candidate) => candidate.eventName === "order.task.waived");
    expect(event?.attributes).toMatchObject({ task_key: "voice", task_kind: "record" });
    expect(JSON.stringify(event)).not.toContain("by post");
    await expectError(mod.requirements.waiveTask(staff.principal, input), "CONFLICT:TASK_ALREADY_WAIVED");
    const view = await mod.requirements.forOrder(alice.principal, { orderId });
    expect(view.uploads[0]).toMatchObject({ waived: true, met: true });
    expect(view.unmet).toBe(0);
    await move(alice, orderId, "in_review");
    expect((await orderRow(orderId)).statusKey).toBe("in_review");
  });
});
