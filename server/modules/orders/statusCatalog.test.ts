/**
 * Increment 07 (D2) — Order status catalogue (`order_status_catalog`) server & router tests.
 *
 * Covers:
 *  - Idempotent seeding from `BUILT_IN_STATUS_CATALOG` + custom keys in published `order_workflow_versions`
 *    without overwriting existing admin edits.
 *  - Router authz matrix (`null`, `customer`, `staff`, `admin` without step-up, `admin` with step-up).
 *  - Bidirectional cancel key/category rule, plain-text label validation, duplicate key & optimistic concurrency.
 *  - Draft-reference protection on `retire` (`states`, `transitions`, `stages[].statusKeys`, `stages[].stageActions.setStatusKey`, `acceptanceGates`).
 *  - Reordering active statuses while preserving omitted retired rows, plus `attentionCounts` on `orders.attention`.
 *  - Backward compatibility: format-1/2 orders retain snapshot labels when catalogue labels are renamed, and
 *    `getManyInTx` falls back deterministically for unseeded legacy keys.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUILT_IN_STATUS_CATALOG } from "../../../shared/orderStatusCatalog.js";
import { createTestDeps, type fakePrincipal, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import type { Services } from "../../container.js";
import { DomainError } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { newRequestContext } from "../../core/requestContext.js";
import { createCallerFactory } from "../../trpc/trpc.js";
import { createOrdersModule, type OrdersModule } from "./index.js";
import { ordersRouter } from "./router.js";
import { orders, orderWorkflowDrafts, orderWorkflows, orderWorkflowVersions } from "./schema.js";
import { FakeEngagement, FakeFiles, fakeIdentity, idemKey, insertUser, ordersTestSchema, type TestUser } from "./testSupport.js";
import { DEFAULT_WORKFLOW } from "./workflowTypes.js";

let t: TestDb;
let h: TestHarness;
let mod: OrdersModule;
let adminWithStepUp: TestUser;
let adminNoStepUp: TestUser;
let staffUser: TestUser;
let customerUser: TestUser;
let productId: string;

const code = (error: unknown): string => {
  if (error instanceof DomainError) return `${error.code}:${error.reasonCode}`;
  if (typeof error === "object" && error !== null && "cause" in error) {
    const cause = (error as { cause: unknown }).cause;
    if (cause instanceof DomainError) return `${cause.code}:${cause.reasonCode}`;
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    return String((error as { code: unknown }).code);
  }
  return String(error);
};

async function expectDomainError(promise: Promise<unknown>, expected: string) {
  try {
    await promise;
  } catch (error) {
    expect(code(error)).toBe(expected);
    return;
  }
  throw new Error(`expected ${expected}`);
}

const call = (principal: ReturnType<typeof fakePrincipal> | null) =>
  createCallerFactory(ordersRouter)({
    services: h.services,
    session: principal,
    request: newRequestContext("test"),
    transport: { issue() {}, clear() {} },
  });

beforeAll(async () => {
  t = await createTestDb({ schema: ordersTestSchema });
  h = createTestDeps({ db: t.db });
  mod = createOrdersModule(h.deps);
  h.services.orders = mod;
  h.services.identity = fakeIdentity(h, t.db) as unknown as Services["identity"];
  h.services.files = new FakeFiles() as unknown as Services["files"];
  h.services.engagement = new FakeEngagement() as unknown as Services["engagement"];

  adminWithStepUp = await insertUser(h, t.db, { role: "admin", stepUp: true });
  adminNoStepUp = await insertUser(h, t.db, { role: "admin", stepUp: false });
  staffUser = await insertUser(h, t.db, { role: "staff" });
  customerUser = await insertUser(h, t.db, { role: "customer" });

  // Insert a published workflow version containing a custom status BEFORE seeding so startup seed discovers it.
  const wfPublicId = ulid(h.clock.now().getTime());
  await t.db.insert(orderWorkflows).values({
    publicId: wfPublicId,
    workflowKey: "legacy-custom-wf",
    name: "Legacy Custom Workflow",
    isDefault: false,
  });
  const [wfRow] = await t.db.select({ id: orderWorkflows.id }).from(orderWorkflows).where(eq(orderWorkflows.publicId, wfPublicId));
  const verPublicId = ulid(h.clock.now().getTime() + 1);
  await t.db.insert(orderWorkflowVersions).values({
    publicId: verPublicId,
    workflowId: wfRow!.id,
    versionNumber: 1,
    definition: {
      ...DEFAULT_WORKFLOW,
      states: [
        ...DEFAULT_WORKFLOW.states,
        {
          key: "partner_qa_review",
          label: "Partner QA review",
          customerLabel: "Quality review",
          kind: "active",
          tone: "info",
        },
      ],
    },
  });
  const [verRow] = await t.db.select({ id: orderWorkflowVersions.id }).from(orderWorkflowVersions).where(eq(orderWorkflowVersions.publicId, verPublicId));
  await t.db.update(orderWorkflows).set({ currentVersionId: verRow!.id }).where(eq(orderWorkflows.id, wfRow!.id));

  const group = await mod.catalog.createGroup(adminWithStepUp.principal, {
    name: "Synthetic Status Group",
    description: "",
    sortOrder: 0,
    active: true,
  });
  const product = await mod.catalog.createProduct(adminWithStepUp.principal, {
    groupId: group.publicId,
    productKey: "status-cat-p1",
    sortOrder: 0,
    active: true,
    name: "Synthetic Status Product",
    description: "",
    priceMinor: 2500,
    currency: "USD",
    features: [],
  });
  productId = product.publicId;
});

afterAll(() => t.cleanup());

describe("order status catalogue (Increment 07 D2)", () => {
  it("seeds built-in statuses plus custom keys from published workflow versions idempotently", async () => {
    await mod.statusCatalog.ensureSeeded();
    const list = await call(staffUser.principal).statusCatalog.list({ includeRetired: true, includeUsage: true });

    const keys = list.map((s) => s.key);
    for (const builtIn of BUILT_IN_STATUS_CATALOG) {
      expect(keys).toContain(builtIn.key);
    }
    expect(keys).toContain("partner_qa_review");

    const customSeeded = list.find((s) => s.key === "partner_qa_review")!;
    expect(customSeeded.staffLabel).toBe("Partner QA review");
    expect(customSeeded.customerLabel).toBe("Quality review");
    expect(customSeeded.category).toBe("working");
    expect(customSeeded.attention).toBe("staff_review");
    expect(customSeeded.usage?.publishedVersionCount).toBeGreaterThanOrEqual(1);
  });

  it("enforces router authorization and MFA step-up across read and write procedures", async () => {
    await expect(call(null).statusCatalog.list()).rejects.toThrow();
    await expect(call(null).statusCatalog.attentionCounts()).rejects.toThrow();
    await expect(call(customerUser.principal).statusCatalog.list()).rejects.toThrow();
    await expect(call(customerUser.principal).statusCatalog.attentionCounts()).rejects.toThrow();

    // Staff can list and read attentionCounts, but cannot mutate
    const staffList = await call(staffUser.principal).statusCatalog.list();
    expect(staffList.length).toBeGreaterThanOrEqual(BUILT_IN_STATUS_CATALOG.length);
    const counts = await call(staffUser.principal).statusCatalog.attentionCounts();
    expect(counts).toEqual({ staffReview: 0, customerResponse: 0 });

    await expect(
      call(staffUser.principal).statusCatalog.create({
        key: "staff_attempt",
        staffLabel: "Staff Attempt",
        customerLabel: "Staff Attempt",
        tone: "info",
        category: "working",
        attention: "none",
      }),
    ).rejects.toThrow();

    // Admin without fresh step-up is refused with STEP_UP_REQUIRED
    await expectDomainError(
      call(adminNoStepUp.principal).statusCatalog.create({
        key: "no_step_up",
        staffLabel: "No Step Up",
        customerLabel: "No Step Up",
        tone: "info",
        category: "working",
        attention: "none",
      }),
      "STEP_UP_REQUIRED:STEP_UP_REQUIRED",
    );
  });

  it("creates, updates, enforces bidirectional cancel rules, and never overwrites admin edits on re-seed", async () => {
    // Reject key containing 'cancel' when category !== 'canceled'
    await expect(
      call(adminWithStepUp.principal).statusCatalog.create({
        key: "canceled_by_client",
        staffLabel: "Client canceled",
        customerLabel: "Canceled by you",
        tone: "neutral",
        category: "done",
        attention: "none",
      }),
    ).rejects.toThrow();

    // Reject category === 'canceled' when key does not contain 'cancel'
    await expect(
      call(adminWithStepUp.principal).statusCatalog.create({
        key: "stopped_early",
        staffLabel: "Stopped early",
        customerLabel: "Stopped early",
        tone: "danger",
        category: "canceled",
        attention: "none",
      }),
    ).rejects.toThrow();

    // Reject HTML markup in labels
    await expect(
      call(adminWithStepUp.principal).statusCatalog.create({
        key: "markup_test",
        staffLabel: "<script>alert(1)</script>",
        customerLabel: "Safe",
        tone: "info",
        category: "working",
        attention: "none",
      }),
    ).rejects.toThrow();

    // Valid cancel status succeeds
    const createdCancel = await call(adminWithStepUp.principal).statusCatalog.create({
      key: "canceled_by_client",
      staffLabel: "Client canceled",
      customerLabel: "Canceled by you",
      tone: "danger",
      category: "canceled",
      attention: "none",
    });
    expect(createdCancel.key).toBe("canceled_by_client");
    expect(createdCancel.category).toBe("canceled");
    expect(createdCancel.version).toBe(1);

    // Duplicate key rejected
    await expectDomainError(
      call(adminWithStepUp.principal).statusCatalog.create({
        key: "canceled_by_client",
        staffLabel: "Duplicate",
        customerLabel: "Duplicate",
        tone: "neutral",
        category: "canceled",
        attention: "none",
      }),
      "CONFLICT:STATUS_KEY_TAKEN",
    );

    // Update label & attention on a custom working status; optimistic concurrency enforced
    const createdWork = await call(adminWithStepUp.principal).statusCatalog.create({
      key: "legal_vetting",
      staffLabel: "Legal vetting",
      customerLabel: "Under legal check",
      tone: "info",
      category: "working",
      attention: "staff_review",
    });

    const updatedWork = await call(adminWithStepUp.principal).statusCatalog.update({
      key: "legal_vetting",
      expectedVersion: createdWork.version,
      staffLabel: "Counsel review",
      customerLabel: "Legal review in progress",
      tone: "warning",
      category: "working",
      attention: "none",
    });
    expect(updatedWork.staffLabel).toBe("Counsel review");
    expect(updatedWork.customerLabel).toBe("Legal review in progress");
    expect(updatedWork.version).toBe(2);

    // Stale expectedVersion fails with VERSION_CONFLICT
    await expectDomainError(
      call(adminWithStepUp.principal).statusCatalog.update({
        key: "legal_vetting",
        expectedVersion: 1,
        staffLabel: "Stale edit",
        customerLabel: "Stale edit",
        tone: "info",
        category: "working",
        attention: "none",
      }),
      "CONFLICT:VERSION_CONFLICT",
    );

    // Re-running ensureSeeded inside a tx does not overwrite customized built-in or custom labels
    const intakeRow = (await call(staffUser.principal).statusCatalog.list()).find((s) => s.key === "intake_open")!;
    await call(adminWithStepUp.principal).statusCatalog.update({
      key: "intake_open",
      expectedVersion: intakeRow.version,
      staffLabel: "Custom Intake Open",
      customerLabel: "Please upload your intake packet",
      tone: intakeRow.tone,
      category: intakeRow.category,
      attention: intakeRow.attention,
    });
    await t.db.transaction(async (tx) => {
      await mod.statusCatalog.ensureSeeded(tx);
    });
    const afterReseed = (await call(staffUser.principal).statusCatalog.list()).find((s) => s.key === "intake_open")!;
    expect(afterReseed.staffLabel).toBe("Custom Intake Open");
    expect(afterReseed.customerLabel).toBe("Please upload your intake packet");

    expect(h.audit.events.some((e) => e.eventName === "order.status_catalog.created")).toBe(true);
    expect(h.audit.events.some((e) => e.eventName === "order.status_catalog.updated")).toBe(true);
  });

  it("blocks retiring a status referenced in an open workflow draft (states or stages), then allows retire and restore", async () => {
    const draftPublicId = ulid(h.clock.now().getTime() + 50);
    await t.db.insert(orderWorkflowDrafts).values({
      publicId: draftPublicId,
      workflowKey: "draft-using-legal-vetting",
      name: "Enterprise Draft",
      source: "blank",
      definition: {
        states: [],
        transitions: [],
        stages: [
          {
            key: "vetting_phase",
            customerLabel: "Vetting",
            staffLabel: "Vetting",
            statusKeys: ["legal_vetting"],
            stageActions: { setStatusKey: "canceled_by_client" },
          },
        ],
      },
    });

    const withUsage = await call(adminWithStepUp.principal).statusCatalog.list({ includeRetired: true, includeUsage: true });
    const vetting = withUsage.find((s) => s.key === "legal_vetting")!;
    const cancelByClient = withUsage.find((s) => s.key === "canceled_by_client")!;
    expect(vetting.usage?.draftCount).toBe(1);
    expect(cancelByClient.usage?.draftCount).toBe(1);

    await expectDomainError(
      call(adminWithStepUp.principal).statusCatalog.retire({
        key: "legal_vetting",
        expectedVersion: vetting.version,
      }),
      "CONFLICT:STATUS_USED_BY_DRAFT",
    );

    await expectDomainError(
      call(adminWithStepUp.principal).statusCatalog.retire({
        key: "canceled_by_client",
        expectedVersion: cancelByClient.version,
      }),
      "CONFLICT:STATUS_USED_BY_DRAFT",
    );

    // Discard draft -> retire succeeds
    await t.db.delete(orderWorkflowDrafts).where(eq(orderWorkflowDrafts.publicId, draftPublicId));

    const retired = await call(adminWithStepUp.principal).statusCatalog.retire({
      key: "legal_vetting",
      expectedVersion: vetting.version,
    });
    expect(retired.retiredAt).not.toBeNull();

    const activeOnly = await call(staffUser.principal).statusCatalog.list({ includeRetired: false });
    expect(activeOnly.some((s) => s.key === "legal_vetting")).toBe(false);

    const allRows = await call(staffUser.principal).statusCatalog.list({ includeRetired: true });
    expect(allRows.some((s) => s.key === "legal_vetting")).toBe(true);

    // Existing orders / runtime reads still resolve retired statuses cleanly via getManyInTx
    const lookupMap = await mod.statusCatalog.getManyInTx(["legal_vetting", "unknown_legacy_v1_key"]);
    expect(lookupMap.get("legal_vetting")?.retired).toBe(true);
    expect(lookupMap.get("legal_vetting")?.staffLabel).toBe("Counsel review");
    expect(lookupMap.get("unknown_legacy_v1_key")?.staffLabel).toBe("Unknown legacy v1 key");

    // Reordering active keys while `legal_vetting` is retired preserves the retired row at the tail
    const activeKeys = activeOnly.map((s) => s.key);
    const swapped = [activeKeys[1]!, activeKeys[0]!, ...activeKeys.slice(2)];
    const reordered = await call(adminWithStepUp.principal).statusCatalog.reorder({ orderedKeys: swapped });
    expect(reordered[0]!.key).toBe(swapped[0]);
    expect(reordered[1]!.key).toBe(swapped[1]);
    expect(reordered[reordered.length - 1]!.key).toBe("legal_vetting");

    // Incomplete active list is rejected
    await expectDomainError(
      call(adminWithStepUp.principal).statusCatalog.reorder({ orderedKeys: activeKeys.slice(1) }),
      "VALIDATION:INCOMPLETE_STATUS_ORDER",
    );

    // Restore brings the status back into the active list
    const latestRetired = reordered.find((s) => s.key === "legal_vetting")!;
    const restored = await call(adminWithStepUp.principal).statusCatalog.restore({
      key: "legal_vetting",
      expectedVersion: latestRetired.version,
    });
    expect(restored.retiredAt).toBeNull();

    expect(h.audit.events.some((e) => e.eventName === "order.status_catalog.retired")).toBe(true);
    expect(h.audit.events.some((e) => e.eventName === "order.status_catalog.reordered")).toBe(true);
    expect(h.audit.events.some((e) => e.eventName === "order.status_catalog.restored")).toBe(true);
  });

  it("preserves format-1/2 order snapshot labels on catalogue rename and reports live attentionCounts", async () => {
    const order = await mod.orders.create(customerUser.principal, {
      projectName: "Synthetic Legacy Workflow Order",
      items: [{ productPublicId: productId, quantity: 1 }],
      idempotencyKey: idemKey(),
    });

    // Rename `submitted` in the catalogue
    const submittedRow = (await call(staffUser.principal).statusCatalog.list()).find((s) => s.key === "submitted")!;
    await call(adminWithStepUp.principal).statusCatalog.update({
      key: "submitted",
      expectedVersion: submittedRow.version,
      staffLabel: "Catalogue Renamed Submitted",
      customerLabel: "Catalogue Renamed Customer Submitted",
      tone: submittedRow.tone,
      category: submittedRow.category,
      attention: "staff_review",
    });

    // Format-1 DEFAULT_WORKFLOW order keeps its pinned version snapshot label ("Submitted"), proving backward compatibility
    const customerDetail = await call(customerUser.principal).get({ orderId: order.publicId });
    expect(customerDetail.statusKey).toBe("submitted");
    expect(customerDetail.statusLabel).toBe("Submitted");

    // Meanwhile format-3 / catalogue consumers reading getOneInTx receive the updated label
    const liveLookup = await mod.statusCatalog.getOneInTx("submitted");
    expect(liveLookup.staffLabel).toBe("Catalogue Renamed Submitted");
    expect(liveLookup.customerLabel).toBe("Catalogue Renamed Customer Submitted");

    // Verify attentionCounts reflects `orders.attention` accurately
    const order2 = await mod.orders.create(customerUser.principal, {
      projectName: "Synthetic Customer Attention Order",
      items: [{ productPublicId: productId, quantity: 1 }],
      idempotencyKey: idemKey(),
    });
    await t.db.update(orders).set({ attention: "staff_review" }).where(eq(orders.publicId, order.publicId));
    await t.db.update(orders).set({ attention: "customer_response" }).where(eq(orders.publicId, order2.publicId));

    const counts = await call(staffUser.principal).statusCatalog.attentionCounts();
    expect(counts).toEqual({ staffReview: 1, customerResponse: 1 });
  });
});
