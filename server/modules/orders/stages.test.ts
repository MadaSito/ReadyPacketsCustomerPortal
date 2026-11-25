import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { computeProgress, workflowStageSchema } from "../../../shared/workflowStages.js";
import { createTestDeps } from "../../../tests/helpers/fakes.js";
import { createTestDb } from "../../../tests/helpers/testDb.js";
import { ulid } from "../../core/ids.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { SessionPrincipal } from "../../core/types.js";
import { createCallerFactory } from "../../trpc/trpc.js";
import { createOrdersModule } from "./index.js";
import { ordersRouter } from "./router.js";
import { orders, orderWorkflowDrafts, orderWorkflows, orderWorkflowVersions } from "./schema.js";
import { STANDARD_V3_DEFINITION, stageModelOf, workflowFormatOf } from "./stageModel.js";
import { completedStageKeys, createStageRuntime } from "./stageRuntime.js";
import { createStageStartup } from "./stageStartup.js";
import { fakeIdentity, insertUser, ordersTestSchema } from "./testSupport.js";
import { transferFormatVersionFor } from "./workflowTransfer.js";
import { validateDraft } from "./workflowDesign.js";
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

  it("after a reopen, phases after the current one that were accepted before no longer count as completed", () => {
    const model = stageModelOf(workflowDefinitionSchema.parse(STANDARD_V3_DEFINITION));
    const keys = model.stages.map((stage) => stage.key);
    const accepted = keys.slice(0, 4).map((stageKey) => ({ stageKey, state: "accepted" as const }));
    const firstStatusOf = (index: number) => model.stages[index]!.statusKeys[0]!;
    // Back at phase 2 (index 1) after a reopen: only phase 1 and (if accepted) phase 2 count.
    expect([...completedStageKeys(model, accepted, firstStatusOf(1))].sort()).toEqual([keys[0], keys[1]].sort());
    // At phase 5 the earlier phases count; a final status outside the phases keeps every accepted row.
    expect(completedStageKeys(model, accepted, firstStatusOf(4)).size).toBe(4);
    expect(completedStageKeys(model, accepted, "canceled").size).toBe(4);
  });

  it("progress counts every phase by weight and never shows 100 before the done category", () => {
    const stages = [{ key: "a", weight: 1 }, { key: "b", weight: 2 }, { key: "c", weight: 1 }];
    const run = (done: string[], statusCategory: "working" | "done" = "working", explicitPercent: number | null = null) =>
      computeProgress({ stages, completedStageKeys: new Set(done), statusCategory, explicitPercent });
    expect(run([])).toEqual({ derived: 0, shown: 0 });
    expect(run(["a"])).toEqual({ derived: 25, shown: 25 });
    expect(run(["a", "b"])).toEqual({ derived: 75, shown: 75 });
    expect(run(["a", "b", "c"])).toEqual({ derived: 99, shown: 99 });
    expect(run(["a", "b", "c"], "done")).toEqual({ derived: 100, shown: 100 });
    expect(run(["a"], "working", 60)).toEqual({ derived: 25, shown: 60 });
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
    // Lead ruling: nothing for the customer to do on the payment phase — no Next, a clear wait reason, server refuses.
    expect(first.stages.find((stage) => stage.key === "payment_confirmed")).toMatchObject({ canNext: false, waitingOn: "payment" });
    await expect(buyer.stages.next({ orderId, stageKey: "payment_confirmed", expectedVersion: first.version }))
      .rejects.toMatchObject({ cause: { reasonCode: "STAGE_NOT_CUSTOMER_ACTIONABLE" } });
    expect(first.progress.percent).toBe(0);

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
    // Every phase counts by weight (7 phases of weight 1): payment done = floor(100 / 7).
    expect(progressAfterPayment).toBe(14);
    expect(intake.stages.find((stage) => stage.key === "phase_1_intake")).toMatchObject({ canSubmit: true, waitingOn: null });
    // Submit-and-lock cannot be bypassed with a plain status change; the header offers no such transition.
    const header = await buyer.get({ orderId });
    expect(header.transitions.map((t) => t.to)).not.toContain("in_review");
    await expect(buyer.transition({ orderId, expectedVersion: intake.version, toStatus: "in_review" }))
      .rejects.toMatchObject({ cause: { reasonCode: "STAGE_SUBMIT_REQUIRED" } });
    expect((await row()).statusKey).toBe("intake_open");
    // Staff are unaffected (checked on the header only, so the phase stays open for the customer path below).
    expect((await reviewer.get({ orderId })).transitions.map((t) => t.to)).toContain("in_review");
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
    expect((await buyer.get({ orderId })).transitions.map((t) => t.to)).not.toContain("in_review");

    // Stored values from the old rule are recalculated by the start-up job (allowed to lower a stale value).
    expect(accepted.progress.percent).toBe(28);
    await db.db.update(orders).set({ progressPercent: 100 }).where(eq(orders.publicId, orderId));
    const runtime = createStageRuntime({ db: db.db, clock: h.clock, services: h.services, workflows: mod.workflows });
    const startup = createStageStartup({ db: db.db, clock: h.clock, audit: h.deps.audit, logger: h.deps.logger, recalcStoredProgress: runtime.recalcStored });
    expect(await startup.refreshProgress()).toBe(1);
    expect((await row()).progressPercent).toBeLessThan(100);
    expect(await startup.refreshProgress()).toBe(0);
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

it("a staff status change that passes a phase without a submission is audited in the same transaction; boot enqueues the start-up job", async () => {
  const db = await createTestDb({ schema: ordersTestSchema });
  try {
    const h = createTestDeps({ db: db.db });
    const mod = createOrdersModule(h.deps);
    Object.assign(h.services, { orders: mod, identity: fakeIdentity(h, db.db) });
    mod.init?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.jobs.enqueued.some((job) => job.type === "orders.increment07.startup" && job.options?.idempotencyKey?.startsWith("orders.increment07.startup:boot:"))).toBe(true);
    const admin = await insertUser(h, db.db, { role: "admin" });
    const staff = await insertUser(h, db.db, { role: "staff" });
    const customer = await insertUser(h, db.db);
    const caller = createCallerFactory(ordersRouter);
    const as = (session: SessionPrincipal) => caller({ services: h.services, session, request: newRequestContext("test"), transport: { issue() {}, clear() {} } });
    const [workflow] = await db.db.insert(orderWorkflows).values({ publicId: ulid(), workflowKey: "synthetic_pass", name: "Synthetic pass" }).$returningId();
    const [pinned] = await db.db.insert(orderWorkflowVersions).values({
      publicId: ulid(), workflowId: workflow!.id, versionNumber: 1, createdByUserId: admin.id, definition: workflowDefinitionSchema.parse(STANDARD_V3_DEFINITION),
    }).$returningId();
    const orderId = ulid();
    await db.db.insert(orders).values({
      publicId: orderId, reference: orderId, projectName: "Synthetic pass", ownerUserId: customer.id, workflowVersionId: pinned!.id,
      statusKey: "awaiting_payment", subtotalMinor: 1000, totalMinor: 1000, currency: "USD", paymentState: "unpaid",
    });
    const reviewer = as(staff.principal);
    const version = async () => (await db.db.select().from(orders).where(eq(orders.publicId, orderId)))[0]!.version;
    h.audit.clear();
    // Payment phase has no customer work: passing it is not "without a submission".
    await reviewer.transition({ orderId, expectedVersion: await version(), toStatus: "intake_open" });
    expect(h.audit.named("order.stage.passed_by_status")).toHaveLength(0);
    await reviewer.transition({ orderId, expectedVersion: await version(), toStatus: "in_review" });
    expect(h.audit.named("order.stage.passed_by_status")).toHaveLength(0);
    await reviewer.transition({ orderId, expectedVersion: await version(), toStatus: "in_progress" });
    const passed = h.audit.named("order.stage.passed_by_status");
    expect(passed).toHaveLength(1);
    expect(passed[0]).toMatchObject({
      actor: { userId: staff.id, role: "staff" }, resource: { type: "order", publicId: orderId }, reasonCode: "TRANSITION",
      attributes: { stage_key: "phase_1_intake", from_status: "in_review", to_status: "in_progress", submitted: "false" },
    });
    expect(h.audit.recordedInTx.at(-1)).toBe(true);
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

it("start-up work on an existing install creates no draft and backfills paid orders without moving them", async () => {
  const db = await createTestDb({ schema: ordersTestSchema });
  try {
    const h = createTestDeps({ db: db.db });
    const customer = await insertUser(h, db.db);
    const [workflow] = await db.db.insert(orderWorkflows).values({ publicId: ulid(), workflowKey: "standard", name: "Standard", isDefault: true }).$returningId();
    const [version] = await db.db.insert(orderWorkflowVersions).values({
      publicId: ulid(), workflowId: workflow!.id, versionNumber: 1, definition: workflowDefinitionSchema.parse(DEFAULT_WORKFLOW),
    }).$returningId();
    await db.db.update(orderWorkflows).set({ currentVersionId: version!.id }).where(eq(orderWorkflows.id, workflow!.id));
    const initial = DEFAULT_WORKFLOW.states.find((state) => state.kind === "initial")!.key;
    const paidId = ulid();
    const openId = ulid();
    for (const publicId of [paidId, openId])
      await db.db.insert(orders).values({
        publicId, reference: publicId, projectName: "Existing order", ownerUserId: customer.id, workflowVersionId: version!.id,
        statusKey: initial, subtotalMinor: 500, totalMinor: 500, currency: "USD",
      });
    const startup = createStageStartup({
      db: db.db, clock: h.clock, audit: h.deps.audit, logger: h.deps.logger,
      paymentSummary: () => async (ids) => new Map(ids.map((id) => [id, { state: id === paidId ? "paid" : "unpaid" }])),
    });
    expect(await startup.run()).toBe("nothing_to_do");
    expect(await db.db.select().from(orderWorkflowDrafts)).toHaveLength(0);
    expect((await db.db.select().from(orderWorkflowVersions)).length).toBe(1);

    expect(await startup.backfillPaid()).toBe(1);
    expect(await startup.backfillPaid()).toBe(0);
    const rows = await db.db.select().from(orders);
    expect(rows.find((row) => row.publicId === paidId)).toMatchObject({ paymentState: "paid", statusKey: initial, workflowVersionId: version!.id });
    expect(rows.find((row) => row.publicId === openId)).toMatchObject({ paymentState: "not_required" });
  } finally {
    await db.cleanup();
  }
});

it("phases notice actions: add the standard phases workflow and convert the default, admin only, audited, idempotent", async () => {
  const db = await createTestDb({ schema: ordersTestSchema });
  try {
    const h = createTestDeps({ db: db.db });
    const mod = createOrdersModule(h.deps);
    Object.assign(h.services, { orders: mod, identity: fakeIdentity(h, db.db) });
    const admin = await insertUser(h, db.db, { role: "admin" });
    const staff = await insertUser(h, db.db, { role: "staff" });
    const caller = createCallerFactory(ordersRouter);
    const as = (session: SessionPrincipal) =>
      caller({ services: h.services, session, request: newRequestContext("test"), transport: { issue() {}, clear() {} } });
    // A classic default that uses the older status groups (format 2): converting must drop them.
    const classic = workflowDefinitionSchema.parse({
      ...DEFAULT_WORKFLOW,
      phases: [{ key: "intake", label: "Intake" }],
      states: DEFAULT_WORKFLOW.states.map((state, index) => (index === 0 ? { ...state, phase: "intake" } : state)),
    });
    const [workflow] = await db.db.insert(orderWorkflows).values({ publicId: ulid(), workflowKey: "standard", name: "Standard", isDefault: true }).$returningId();
    const [version] = await db.db.insert(orderWorkflowVersions).values({ publicId: ulid(), workflowId: workflow!.id, versionNumber: 1, definition: classic }).$returningId();
    await db.db.update(orderWorkflows).set({ currentVersionId: version!.id }).where(eq(orderWorkflows.id, workflow!.id));
    const owner = as(admin.principal);

    await expect(as(staff.principal).admin.workflows.phases.addStandard()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as(staff.principal).admin.workflows.phases.convertDefault()).rejects.toMatchObject({ code: "FORBIDDEN" });

    h.audit.clear();
    const added = await owner.admin.workflows.phases.addStandard();
    expect(added.created).toBe(true);
    expect(await owner.admin.workflows.phases.addStandard()).toEqual({ draftId: added.draftId, created: false });
    const [addedRow] = await db.db.select().from(orderWorkflowDrafts).where(eq(orderWorkflowDrafts.publicId, added.draftId));
    expect(addedRow).toMatchObject({ workflowId: null, workflowKey: "readypackets_standard", source: "standard" });
    expect((addedRow!.definition as { stages?: unknown[] }).stages).toHaveLength(STANDARD_V3_DEFINITION.stages!.length);
    expect(h.audit.named("workflow.draft.changed").at(-1)).toMatchObject({ reasonCode: "PHASES_WORKFLOW_DRAFT" });
    expect(h.audit.recordedInTx.at(-1)).toBe(true);

    const converted = await owner.admin.workflows.phases.convertDefault();
    expect(converted.created).toBe(true);
    expect(converted.outcome).toBe("created");
    expect(await owner.admin.workflows.phases.convertDefault()).toMatchObject({ draftId: converted.draftId, created: false, outcome: "opened" });
    const [convertedRow] = await db.db.select().from(orderWorkflowDrafts).where(eq(orderWorkflowDrafts.publicId, converted.draftId));
    expect(convertedRow).toMatchObject({ workflowId: workflow!.id, baseVersionId: version!.id });
    const definition = convertedRow!.definition as Parameters<typeof validateDraft>[0];
    expect(definition.stages?.length).toBeGreaterThan(0);
    expect(definition.phases ?? []).toHaveLength(0);
    expect(validateDraft(definition).filter((issue) => issue.severity === "error")).toEqual([]);
    expect(h.audit.named("workflow.draft.changed").at(-1)).toMatchObject({ reasonCode: "PHASES_CONVERT_DRAFT" });

    // An open draft without phases: first call only asks (unchanged, named); with its id it is converted in place.
    const [classicVersion] = await db.db.select().from(orderWorkflowVersions).where(eq(orderWorkflowVersions.id, version!.id));
    await db.db.update(orderWorkflowDrafts).set({ definition: classicVersion!.definition as never }).where(eq(orderWorkflowDrafts.publicId, converted.draftId));
    const ask = await owner.admin.workflows.phases.convertDefault();
    expect(ask).toMatchObject({ draftId: converted.draftId, created: false, outcome: "needs_confirm" });
    expect(ask.draftName.length).toBeGreaterThan(0);
    expect(((await db.db.select().from(orderWorkflowDrafts).where(eq(orderWorkflowDrafts.publicId, converted.draftId)))[0]!.definition as { stages?: unknown[] }).stages ?? []).toHaveLength(0);
    expect(await owner.admin.workflows.phases.convertDefault({ convertDraftId: converted.draftId })).toMatchObject({ draftId: converted.draftId, outcome: "converted" });
    const [inPlace] = await db.db.select().from(orderWorkflowDrafts).where(eq(orderWorkflowDrafts.publicId, converted.draftId));
    expect((inPlace!.definition as { stages?: unknown[] }).stages?.length).toBeGreaterThan(0);
    expect(h.audit.named("workflow.draft.changed").at(-1)).toMatchObject({ reasonCode: "PHASES_CONVERT_DRAFT", attributes: { in_place: true } });
    expect(h.audit.recordedInTx.at(-1)).toBe(true);

    // New workflow dialog: "phases" starts from the standard phases definition (stored source "standard").
    const created = await owner.admin.workflows.drafts.create({ from: "phases", workflowKey: "phases_two", name: "Phases two" });
    const [createdRow] = await db.db.select().from(orderWorkflowDrafts).where(eq(orderWorkflowDrafts.publicId, created.publicId));
    expect(createdRow!.source).toBe("standard");
    expect((createdRow!.definition as { stages?: unknown[] }).stages).toHaveLength(STANDARD_V3_DEFINITION.stages!.length);

    // Existing workflows are never touched.
    expect(await db.db.select().from(orderWorkflowVersions)).toHaveLength(1);
    expect((await db.db.select().from(orderWorkflows))).toHaveLength(1);
  } finally {
    await db.cleanup();
  }
});
