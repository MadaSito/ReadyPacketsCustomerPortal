import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { workflowStageSchema } from "../../../shared/workflowStages.js";
import { createTestDeps } from "../../../tests/helpers/fakes.js";
import { createTestDb } from "../../../tests/helpers/testDb.js";
import { ulid } from "../../core/ids.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { SessionPrincipal } from "../../core/types.js";
import { createCallerFactory } from "../../trpc/trpc.js";
import { createOrdersModule } from "./index.js";
import { ordersRouter } from "./router.js";
import { orders, orderWorkflows, orderWorkflowVersions } from "./schema.js";
import { STANDARD_V3_DEFINITION, stageModelOf, workflowFormatOf } from "./stageModel.js";
import { createStageStartup } from "./stageStartup.js";
import { fakeIdentity, insertUser, ordersTestSchema } from "./testSupport.js";
import { transferFormatVersionFor } from "./workflowTransfer.js";
import { DEFAULT_WORKFLOW, workflowDefinitionSchema } from "./workflowTypes.js";

describe("stored shapes", () => {
  it("the standard format-3 definition and the legacy default both parse; old phases get folder and sync defaults", () => {
    const v3 = workflowDefinitionSchema.parse(STANDARD_V3_DEFINITION);
    expect(workflowFormatOf(v3)).toBe(3);
    expect(stageModelOf(v3).derived).toBe(false);
    const legacy = workflowDefinitionSchema.parse(DEFAULT_WORKFLOW);
    expect(workflowFormatOf(legacy)).not.toBe(3);
    expect(stageModelOf(legacy).derived).toBe(true);
    const old = workflowStageSchema.parse({ key: "intake", customerLabel: "Intake", staffLabel: "Intake", statusKeys: ["start"], actions: {} });
    expect(old).toMatchObject({ progression: "next", completesOn: "manual", weight: 1, acknowledgement: { policy: "none" }, adminTasks: [] });
    expect(old.fileSync).toEqual({ originals: null, conversionStaging: null, intakeDelivery: null });
  });

  it("transfer writes version 3 only when a workflow has phases", () => {
    expect(transferFormatVersionFor([{ stages: [] }, {}])).toBe(2);
    expect(transferFormatVersionFor([{}, { stages: [{}] }])).toBe(3);
  });
});

it("runs the standard phases end to end with owner-only actions, acknowledgement, review, payment and reopen", async () => {
  const db = await createTestDb({ schema: ordersTestSchema });
  try {
    const h = createTestDeps({ db: db.db });
    const mod = createOrdersModule(h.deps);
    Object.assign(h.services, { orders: mod, identity: fakeIdentity(h, db.db) });
    const admin = await insertUser(h, db.db, { role: "admin", stepUp: true });
    const staff = await insertUser(h, db.db, { role: "staff" });
    const customer = await insertUser(h, db.db);
    const outsider = await insertUser(h, db.db);
    const caller = createCallerFactory(ordersRouter);
    const as = (session: SessionPrincipal) =>
      caller({ services: h.services, session, request: newRequestContext("test"), transport: { issue() {}, clear() {} } });

    const [workflow] = await db.db.insert(orderWorkflows).values({ publicId: ulid(), workflowKey: "synthetic_v3", name: "Synthetic v3" }).$returningId();
    const [pinned] = await db.db.insert(orderWorkflowVersions).values({
      publicId: ulid(), workflowId: workflow!.id, versionNumber: 1, createdByUserId: admin.id,
      definition: workflowDefinitionSchema.parse(STANDARD_V3_DEFINITION),
    }).$returningId();
    const orderId = ulid();
    await db.db.insert(orders).values({
      publicId: orderId, reference: orderId, projectName: "Synthetic phases", ownerUserId: customer.id, workflowVersionId: pinned!.id,
      statusKey: "awaiting_payment", subtotalMinor: 1000, totalMinor: 1000, currency: "USD", paymentState: "unpaid",
    });
    const buyer = as(customer.principal);
    const reviewer = as(staff.principal);
    const workspace = () => buyer.stages.workspace({ orderId });
    const row = async () => (await db.db.select().from(orders).where(eq(orders.publicId, orderId)))[0]!;

    // Zero trust: a foreign customer sees nothing; staff cannot act for the owner; customers cannot review.
    await expect(as(outsider.principal).stages.workspace({ orderId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const first = await workspace();
    expect(first).toMatchObject({ workflowFormat: 3, derived: false, currentStageKey: "payment_confirmed" });

    // Payment port: paid completes the payment phase and advances; a repeat is a no-op.
    const paid = await db.db.transaction((tx) =>
      mod.payments.onInvoicePaidInTx({ orderPublicId: orderId, invoicePublicId: ulid(), paidAt: h.clock.now(), method: "manual", amountMinor: 1000, currency: "USD" }, tx));
    expect(paid).toMatchObject({ paymentState: "paid", stageCompleted: "payment_confirmed", advancedTo: "intake_open" });
    const again = await db.db.transaction((tx) =>
      mod.payments.onInvoicePaidInTx({ orderPublicId: orderId, invoicePublicId: ulid(), paidAt: h.clock.now(), method: "manual", amountMinor: 1000, currency: "USD" }, tx));
    expect(again).toMatchObject({ paymentState: "paid", advancedTo: null });
    expect((await row()).paymentState).toBe("paid");

    const intake = await workspace();
    expect(intake.currentStageKey).toBe("phase_1_intake");
    const progressAfterPayment = intake.progress.percent;
    const scope = { orderId, stageKey: "phase_1_intake" };
    await expect(reviewer.stages.submit({ ...scope, expectedVersion: intake.version })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(buyer.stages.review({ ...scope, expectedVersion: intake.version, outcome: "accepted" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(buyer.stages.next({ ...scope, expectedVersion: intake.version })).rejects.toMatchObject({ cause: { reasonCode: "STAGE_PROGRESSION" } });

    // Acknowledgement: required, and bound to the text the customer saw.
    await expect(buyer.stages.submit({ ...scope, expectedVersion: intake.version })).rejects.toMatchObject({ cause: { reasonCode: "ACK_REQUIRED" } });
    await expect(buyer.stages.submit({ ...scope, expectedVersion: intake.version, ack: { accepted: true, textSha256: "0".repeat(64) } }))
      .rejects.toMatchObject({ cause: { reasonCode: "ACK_TEXT_CHANGED" } });
    const sha = intake.stages.find((stage) => stage.key === "phase_1_intake")!.acknowledgement.textSha256!;
    await expect(buyer.stages.submit({ ...scope, expectedVersion: intake.version - 1, ack: { accepted: true, textSha256: sha } }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    await buyer.stages.submit({ ...scope, expectedVersion: intake.version, ack: { accepted: true, textSha256: sha } });
    const submitted = await workspace();
    expect(submitted.stages.find((stage) => stage.key === "phase_1_intake")).toMatchObject({ locked: true });
    expect((await row()).attention).toBe("staff_review");
    expect(submitted.progress.percent).toBeGreaterThanOrEqual(progressAfterPayment);

    // Review: changes need a note; accept moves to the next phase and never lowers progress.
    await expect(reviewer.stages.review({ ...scope, expectedVersion: submitted.version, outcome: "changes_requested" }))
      .rejects.toMatchObject({ cause: { reasonCode: "NOTE_REQUIRED" } });
    await reviewer.stages.review({ ...scope, expectedVersion: submitted.version, outcome: "accepted" });
    const accepted = await workspace();
    expect(accepted.currentStageKey).toBe("phase_2_synthesis");
    expect(accepted.progress.percent).toBeGreaterThan(progressAfterPayment);
    expect((await row()).attention).not.toBe("staff_review");

    // List rows carry the phase, progress, attention and payment state.
    const list = await buyer.list({});
    expect(list.items.find((item) => item.publicId === orderId)).toMatchObject({
      phaseLabel: "Phase 2 synthesis", phaseIndex: 2, phaseTotal: STANDARD_V3_DEFINITION.stages!.length,
      progressPercent: accepted.progress.percent, progressCanceled: false, paymentState: "paid",
    });
    const filtered = await reviewer.admin.list({ attention: "staff_review" });
    expect(filtered.items.some((item) => item.publicId === orderId)).toBe(false);

    // The legacy unlock refuses format 3; reopen is admin-only with fresh step-up and may lower progress.
    await expect(reviewer.phases.unlock({ orderId, phaseKey: "phase_1_intake", reason: "Customer needs to add files.", notifyCustomer: false }))
      .rejects.toMatchObject({ cause: { reasonCode: "USE_STAGE_REOPEN" } });
    const reopen = { ...scope, expectedVersion: accepted.version, reason: "Customer needs to add one more file.", confirm: true as const };
    await expect(reviewer.stages.reopen(reopen)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as({ ...admin.principal, stepUpAt: null }).stages.reopen(reopen)).rejects.toMatchObject({ cause: { reasonCode: "STEP_UP_REQUIRED" } });
    await as(admin.principal).stages.reopen(reopen);
    const reopened = await workspace();
    expect(reopened.currentStageKey).toBe("phase_1_intake");
    expect(reopened.stages.find((stage) => stage.key === "phase_1_intake")).toMatchObject({ state: "reopened", locked: false });
    expect(reopened.progress.percent).toBeLessThanOrEqual(accepted.progress.percent);
  } finally {
    await db.cleanup();
  }
});

it("derived (old format) workflows refuse stage writes and fill progress on first read", async () => {
  const db = await createTestDb({ schema: ordersTestSchema });
  try {
    const h = createTestDeps({ db: db.db });
    const mod = createOrdersModule(h.deps);
    Object.assign(h.services, { orders: mod, identity: fakeIdentity(h, db.db) });
    const customer = await insertUser(h, db.db);
    const caller = createCallerFactory(ordersRouter);
    const buyer = caller({ services: h.services, session: customer.principal, request: newRequestContext("test"), transport: { issue() {}, clear() {} } });
    const [workflow] = await db.db.insert(orderWorkflows).values({ publicId: ulid(), workflowKey: "legacy_flow", name: "Legacy" }).$returningId();
    const [pinned] = await db.db.insert(orderWorkflowVersions).values({
      publicId: ulid(), workflowId: workflow!.id, versionNumber: 1, definition: workflowDefinitionSchema.parse(DEFAULT_WORKFLOW),
    }).$returningId();
    const initial = DEFAULT_WORKFLOW.states.find((state) => state.kind === "initial")!.key;
    const orderId = ulid();
    await db.db.insert(orders).values({
      publicId: orderId, reference: orderId, projectName: "Legacy order", ownerUserId: customer.id, workflowVersionId: pinned!.id,
      statusKey: initial, subtotalMinor: 0, totalMinor: 0, currency: "USD",
    });
    expect((await db.db.select().from(orders).where(eq(orders.publicId, orderId)))[0]!.progressPercent).toBeNull();
    const list = await buyer.list({});
    expect(list.items[0]).toMatchObject({ publicId: orderId, paymentState: "not_required", attention: "none" });
    expect((await db.db.select().from(orders).where(eq(orders.publicId, orderId)))[0]!.progressPercent).not.toBeNull();
    const space = await buyer.stages.workspace({ orderId });
    expect(space).toMatchObject({ derived: true });
    await expect(buyer.stages.next({ orderId, stageKey: space.currentStageKey!, expectedVersion: space.version }))
      .rejects.toMatchObject({ cause: { reasonCode: "STAGE_ACTION_OFF" } });
  } finally {
    await db.cleanup();
  }
});

it("start-up work installs the standard phases once on a fresh install and is idempotent", async () => {
  const db = await createTestDb({ schema: ordersTestSchema });
  try {
    const h = createTestDeps({ db: db.db });
    const startup = createStageStartup({ db: db.db, clock: h.clock, audit: h.deps.audit, logger: h.deps.logger });
    expect(await startup.run()).toBe("installed_standard");
    expect(await startup.run()).toBe("nothing_to_do");
    const rows = await db.db.select().from(orderWorkflows);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workflowKey: "readypackets_standard", isDefault: true });
  } finally {
    await db.cleanup();
  }
});
