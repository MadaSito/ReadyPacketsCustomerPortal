import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { deriveStages } from "../../../shared/workflowStages.js";
import { createTestDeps } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { conflict } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { SessionPrincipal } from "../../core/types.js";
import { createCallerFactory, router } from "../../trpc/trpc.js";
import { users } from "../identity/schema.js";
import { createActorCheck } from "./actor.js";
import { createOrdersModule } from "./index.js";
import { createOrderPolicy } from "./policy.js";
import { answerAad, assertStageQuestionsAnswered, normalizeQuestionText, promptAad } from "./questions.js";
import type { ResolveQuestionStage } from "./questionsAccess.js";
import { adminTasksRouter, createPhaseWorkServices, questionsRouter } from "./questionsRouter.js";
import { orderAdminTasks, orderQuestionAnswers, orderQuestions } from "./questionsSchema.js";
import { ordersRouter } from "./router.js";
import { orderGrants, orders, orderWorkflows, orderWorkflowVersions } from "./schema.js";
import { fakeIdentity, insertUser, ordersTestSchema, type TestUser } from "./testSupport.js";
import { workflowDefinitionSchema } from "./workflowTypes.js";

describe("plain text and legacy phases", () => {
  it("normalizes Unicode and line endings, limits length, and treats markup as literal text", () => {
    expect(normalizeQuestionText("  Cafe\u0301\r\n<type>  ", "body")).toBe("Café\n<type>");
    expect(normalizeQuestionText("a".repeat(8_000), "body")).toHaveLength(8_000);
    expect(() => normalizeQuestionText("a".repeat(8_001), "body")).toThrow();
    expect(() => normalizeQuestionText("a\u0000b", "prompt")).toThrow();
    expect(() => normalizeQuestionText(" \t\r\n ", "prompt")).toThrow();
  });

  it("derives readable old-format phases without enabling questions or checklist items", () => {
    const [stage] = deriveStages({
      states: [{ key: "intake", label: "Intake", customerLabel: "Get started", kind: "initial" }],
    });
    expect(stage).toMatchObject({ key: "intake", actions: { answerQuestions: false }, adminTasks: [] });
  });
});

it("integrates phase questions with submit, attention, review and administrator reopen", async () => {
  const db = await createTestDb({ schema: ordersTestSchema });
  try {
    const h = createTestDeps({ db: db.db });
    const mod = createOrdersModule(h.deps);
    Object.assign(h.services, { orders: mod, identity: fakeIdentity(h, db.db) });
    const admin = await insertUser(h, db.db, { role: "admin", stepUp: true });
    const staff = await insertUser(h, db.db, { role: "staff" });
    const customer = await insertUser(h, db.db);
    const caller = createCallerFactory(ordersRouter);
    const as = (session: SessionPrincipal) =>
      caller({ services: h.services, session, request: newRequestContext("test"), transport: { issue() {}, clear() {} } });
    const [workflow] = await db.db.insert(orderWorkflows).values({
      publicId: ulid(), workflowKey: "synthetic_d4", name: "Synthetic D4",
    }).$returningId();
    const [pinned] = await db.db.insert(orderWorkflowVersions).values({
      publicId: ulid(), workflowId: workflow!.id, versionNumber: 1, createdByUserId: admin.id,
      definition: workflowDefinitionSchema.parse({
        states: [
          { key: "start", label: "Intake", customerLabel: "Intake", kind: "initial", tone: "neutral" },
          { key: "finish", label: "Finished", customerLabel: "Finished", kind: "terminal", tone: "success" },
        ],
        transitions: [{ from: "start", to: "finish", allowedBy: ["staff", "admin"], notifyCustomer: false }],
        stages: [
          {
            key: "intake", customerLabel: "Intake", staffLabel: "Intake",
            statusKeys: ["start"], actions: { answerQuestions: true }, progression: "submit_lock",
            adminTasks: ["review_submission"],
          },
          { key: "delivery", customerLabel: "Delivery", staffLabel: "Delivery", statusKeys: ["finish"], actions: {} },
        ],
      }),
    }).$returningId();
    const scope = { orderId: ulid(), stageKey: "intake" };
    await db.db.insert(orders).values({
      publicId: scope.orderId, reference: scope.orderId, projectName: "Synthetic pinned workspace",
      ownerUserId: customer.id, workflowVersionId: pinned!.id, statusKey: "start", subtotalMinor: 100, totalMinor: 100, currency: "USD",
    });
    const buyer = as(customer.principal);
    const reviewer = as(staff.principal);
    const attention = async () => (await db.db.select({ attention: orders.attention }).from(orders)
      .where(eq(orders.publicId, scope.orderId)))[0]?.attention;
    const workspace = () => buyer.stages.workspace({ orderId: scope.orderId });
    const { questionId } = await reviewer.questions.ask({ ...scope, required: true, prompt: "Where is the final evidence?" });
    expect(await attention()).toBe("customer_response");
    await expect(buyer.stages.submit({ ...scope, expectedVersion: (await workspace()).version }))
      .rejects.toMatchObject({ code: "CONFLICT", cause: { reasonCode: "QUESTIONS_UNANSWERED" } });
    await buyer.questions.answer({ ...scope, questionId, expectedVersion: 0, body: "In the synthetic folder." });
    expect(await attention()).not.toBe("customer_response");
    await buyer.stages.submit({ ...scope, expectedVersion: (await workspace()).version });
    expect(await attention()).toBe("staff_review");
    await reviewer.stages.review({
      ...scope, expectedVersion: (await workspace()).version, outcome: "changes_requested", note: "Attach the updated document.",
    });
    expect((await workspace()).stages[0]).toMatchObject({ locked: true, review: { outcome: "changes_requested", note: "Attach the updated document." } });
    const edit = { ...scope, questionId, expectedVersion: 1, body: "Updated evidence." };
    await expect(buyer.questions.answer(edit)).rejects.toMatchObject({ code: "CONFLICT" });
    const reopen = { ...scope, expectedVersion: (await workspace()).version, reason: "Allow the customer to update evidence.", confirm: true as const };
    await expect(reviewer.stages.reopen(reopen)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as({ ...admin.principal, stepUpAt: null }).stages.reopen(reopen))
      .rejects.toMatchObject({ cause: { reasonCode: "STEP_UP_REQUIRED" } });
    await as(admin.principal).stages.reopen(reopen);
    expect((await workspace()).stages[0]).toMatchObject({ state: "reopened", locked: false });
    expect(await buyer.questions.answer(edit)).toEqual({ version: 2 });
    await buyer.stages.submit({ ...scope, expectedVersion: (await workspace()).version });
    await reviewer.stages.review({ ...scope, expectedVersion: (await workspace()).version, outcome: "accepted" });
    expect(await workspace()).toMatchObject({ currentStageKey: "delivery", stages: [
      expect.objectContaining({ state: "accepted", review: { outcome: "accepted", note: null, at: expect.any(String) } }),
      expect.objectContaining({ key: "delivery" }),
    ] });
  } finally {
    await db.cleanup();
  }
});

describe("phase question and checklist procedures with MySQL order locking", () => {
  const stageKey = "intake";
  const version = 701;
  let db: TestDb;
  let h: ReturnType<typeof createTestDeps>;
  let identity: ReturnType<typeof fakeIdentity>;
  let staff: TestUser;
  let customer: TestUser;
  let outsider: TestUser;
  let viewer: TestUser;
  const refresh = vi.fn(async () => {});
  const gates = vi.fn(async () => {});
  const resolveStage: ResolveQuestionStage = async (order, key) => {
    if (!["intake", "future", "done", "derived"].includes(key)) return null;
    return {
      customerReadable: key !== "future",
      customerWritable: order.statusKey === "intake" && key === "intake",
      staffQuestionsWritable: key === "intake" || key === "future",
      answersEnabled: key !== "derived",
      adminTasks: key === "intake" ? ["review_submission"] : [],
    };
  };
  const caller = createCallerFactory(router({ questions: questionsRouter, adminTasks: adminTasksRouter }));
  const call = (session: SessionPrincipal | null) =>
    caller({ services: h.services, session, request: newRequestContext("test"), transport: { issue() {}, clear() {} } });
  async function createOrder() {
    const orderId = ulid();
    await db.db.insert(orders).values({
      publicId: orderId, reference: orderId, projectName: "Synthetic order", ownerUserId: customer.id,
      workflowVersionId: version, statusKey: "intake", subtotalMinor: 100, totalMinor: 100, currency: "USD",
    });
    return { orderId, stageKey };
  }
  beforeAll(async () => {
    db = await createTestDb({ schema: { users, orders, orderGrants, orderQuestions, orderQuestionAnswers, orderAdminTasks } });
    h = createTestDeps({ db: db.db });
    identity = fakeIdentity(h, db.db);
    Object.assign(h.services, { identity });
    staff = await insertUser(h, db.db, { role: "staff" });
    customer = await insertUser(h, db.db);
    outsider = await insertUser(h, db.db);
    viewer = await insertUser(h, db.db);
    Object.assign(h.services, {
      orders: {
        phaseWork: createPhaseWorkServices({
          ...h.deps, policy: createOrderPolicy(h.deps), actorCheck: createActorCheck(h.services, h.clock),
          gates: { assertCustomerMayWork: gates }, resolveStage, refreshAttentionInTx: refresh,
        }),
      },
    });
  });
  afterAll(async () => { await db?.cleanup(); });

  it("requires answers before progressing, stores encrypted revisions, and separates customer from staff history", async () => {
    const scope = await createOrder();
    const prompt = "Where is the synthetic document?";
    const first = "In the first folder.";
    const second = "In the second folder.";
    const operator = call(staff.principal);
    const owner = call(customer.principal);
    refresh.mockClear();
    const { questionId } = await operator.questions.ask({ ...scope, prompt, required: true });
    const [order] = await db.db.select({ id: orders.id }).from(orders).where(eq(orders.publicId, scope.orderId));
    const required = () => db.db.transaction((tx) => assertStageQuestionsAnswered(order!.id, version, stageKey, tx));
    await expect(required()).rejects.toMatchObject({ reasonCode: "QUESTIONS_UNANSWERED" });
    await expect(owner.questions.answer({ ...scope, questionId, body: first, expectedVersion: 0 })).resolves.toEqual({ version: 1 });
    await expect(required()).resolves.toBeUndefined();
    await expect(owner.questions.answer({ ...scope, questionId, body: second, expectedVersion: 1 })).resolves.toEqual({ version: 2 });
    await expect(owner.questions.answer({ ...scope, questionId, body: "Stale answer", expectedVersion: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
    const visible = await owner.questions.customerList(scope);
    expect(visible).toMatchObject({ canAnswer: true, questions: [{ prompt, latestAnswer: { version: 2, body: second } }] });
    expect(visible.questions[0]).not.toHaveProperty("askedByPublicId");
    expect(visible.questions[0]?.latestAnswer).not.toHaveProperty("answeredByPublicId");
    const history = await operator.questions.history({ ...scope, questionId });
    expect(history.answers).toEqual([
      expect.objectContaining({ version: 2, body: second, answeredByPublicId: customer.publicId }),
      expect.objectContaining({ version: 1, body: first, answeredByPublicId: customer.publicId }),
    ]);
    const [row] = await db.db.select().from(orderQuestions).where(eq(orderQuestions.publicId, questionId));
    const stored = await db.db.select().from(orderQuestionAnswers).where(eq(orderQuestionAnswers.questionId, row!.id));
    expect(row?.promptEnc).toMatch(/^rpenc:/u);
    expect(h.deps.crypto.decrypt(row!.promptEnc, promptAad(questionId))).toBe(prompt);
    expect(h.deps.crypto.decrypt(stored[0]!.bodyEnc, answerAad(stored[0]!.publicId))).toBe(first);
    expect(JSON.stringify(h.audit.events)).not.toMatch(/synthetic document|first folder|second folder/i);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(await operator.questions.withdraw({ ...scope, questionId })).toEqual({ changed: true });
    expect(await operator.questions.withdraw({ ...scope, questionId })).toEqual({ changed: false });
    expect((await owner.questions.customerList(scope)).questions).toEqual([]);
    expect((await operator.questions.history({ ...scope, questionId })).answers).toHaveLength(2);
  });

  it("refuses cross-order IDs, working ahead, closed phases, view-only grants and unmet policy gates", async () => {
    const scope = await createOrder();
    const secondScope = await createOrder();
    const operator = call(staff.principal);
    const owner = call(customer.principal);
    const { questionId } = await operator.questions.ask({ ...scope, prompt: "Restricted synthetic question", required: false });
    const write = { ...scope, questionId, body: "Draft", expectedVersion: 0 };
    await expect(call(null).questions.customerList(scope)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(call(outsider.principal).questions.customerList(scope)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(owner.questions.list(scope)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(owner.questions.answer({ ...write, ...secondScope })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(operator.questions.history({ ...secondScope, questionId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(owner.questions.customerList({ ...scope, stageKey: "future" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(owner.questions.answer({ ...write, stageKey: "done" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(operator.questions.ask({ ...scope, stageKey: "derived", prompt: "Hidden", required: false })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(operator.questions.ask({ ...scope, prompt: "Unexpected property", required: false, raw: true } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const [order] = await db.db.select({ id: orders.id }).from(orders).where(eq(orders.publicId, scope.orderId));
    const grantPublicId = ulid();
    await db.db.insert(orderGrants).values({
      publicId: grantPublicId, orderId: order!.id, granteeUserId: viewer.id, status: "active", role: "viewer",
      inviteeEmailEnc: h.deps.crypto.encrypt(viewer.email, `order_grants.invitee_email:${grantPublicId}`),
      inviteeEmailIndex: h.deps.crypto.blindIndex(viewer.email, "order_grants.invitee_email"),
    });
    expect((await call(viewer.principal).questions.customerList(scope)).canAnswer).toBe(false);
    await expect(call(viewer.principal).questions.answer(write)).rejects.toMatchObject({ code: "FORBIDDEN" });
    gates.mockRejectedValueOnce(conflict("AGREEMENT_REQUIRED", "Accept the agreement."));
    await expect(owner.questions.answer(write)).rejects.toMatchObject({ code: "CONFLICT" });
    identity.sessionState.set(customer.principal.sessionId, { revoked: true });
    try {
      await expect(owner.questions.answer(write)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    } finally {
      identity.sessionState.delete(customer.principal.sessionId);
    }
  });

  it("requires configured checklist items and atomically audits both ticks and unticks", async () => {
    const scope = await createOrder();
    const operator = call(staff.principal);
    const task = { ...scope, taskKey: "review_submission" as const };
    await expect(call(customer.principal).adminTasks.list(scope)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(operator.adminTasks.set({ ...task, taskKey: "run_automation", expectedVersion: 0, checked: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await operator.adminTasks.set({ ...task, expectedVersion: 0, checked: true })).toEqual({ version: 1, changed: true });
    expect((await operator.adminTasks.list(scope)).tasks[0]).toMatchObject({ version: 1, checkedAt: expect.any(Date), checkedByPublicId: staff.publicId });
    await expect(operator.adminTasks.set({ ...task, expectedVersion: 0, checked: false })).rejects.toMatchObject({ code: "CONFLICT" });
    h.audit.failRecords = true;
    try {
      await expect(operator.adminTasks.set({ ...task, expectedVersion: 1, checked: false })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
      expect((await operator.adminTasks.list(scope)).tasks[0]?.version).toBe(1);
    } finally {
      h.audit.failRecords = false;
    }
    expect(await operator.adminTasks.set({ ...task, expectedVersion: 1, checked: false })).toEqual({ version: 2, changed: true });
    expect((await operator.adminTasks.list(scope)).tasks[0]).toMatchObject({ version: 2, checkedByPublicId: null, checkedAt: null });
    expect(h.audit.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventName: "order.admin_task.checked", resource: { type: "order", publicId: scope.orderId } }),
      expect.objectContaining({ eventName: "order.admin_task.unchecked", attributes: { stage_key: stageKey, task_key: "review_submission", task_version: 2 } }),
    ]));
    const [order] = await db.db.select({ id: orders.id }).from(orders).where(eq(orders.publicId, scope.orderId));
    const old = await db.db.select().from(orderAdminTasks)
      .where(and(eq(orderAdminTasks.orderId, order!.id), eq(orderAdminTasks.workflowVersionId, version + 1)));
    expect(old).toHaveLength(0);
  });

  it("serializes concurrent answers and scopes history to the exact pinned version", async () => {
    const scope = await createOrder();
    const operator = call(staff.principal);
    const owner = call(customer.principal);
    const { questionId } = await operator.questions.ask({ ...scope, prompt: "Which revision wins?", required: false });
    const input = { ...scope, questionId, expectedVersion: 0 };
    const attempts = await Promise.allSettled([
      owner.questions.answer({ ...input, body: "First concurrent draft" }),
      owner.questions.answer({ ...input, body: "Second concurrent draft" }),
    ]);
    expect(attempts.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const [replayed] = attempts.filter((result) => result.status === "rejected");
    expect(replayed?.reason).toMatchObject({ code: "CONFLICT" });
    expect((await operator.questions.history({ ...scope, questionId })).answers).toHaveLength(1);
    // Simulates a corrupt legacy reference/re-pin, which normal workflows never do. Data from the old pin stays private.
    await db.db.update(orders).set({ workflowVersionId: version + 1 }).where(eq(orders.publicId, scope.orderId));
    await expect(operator.questions.history({ ...scope, questionId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await owner.questions.customerList(scope)).questions).toEqual([]);
  });
});
