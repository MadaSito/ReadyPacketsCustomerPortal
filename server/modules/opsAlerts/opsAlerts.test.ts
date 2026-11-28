import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDeps, fakePrincipal, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { ulid } from "../../core/ids.js";
import { users } from "../identity/schema.js";
import { registerSamlMetadataCheck, SAML_METADATA_CHECK_JOB } from "../jobs/samlMetadata.js";
import { orders } from "../orders/schema.js";
import { ATTENTION_ALERTS_ENABLED } from "./attention.js";
import { createOpsAlertsModule, type OpsAlertsModule } from "./index.js";
import { operationalAlerts } from "./schema.js";
import { stripeWebhookDeliveryMissingAlert } from "./stripeWebhook.js";

let database: TestDb;
let harness: TestHarness;
let service: OpsAlertsModule;
const fixture = {
  source: "webhook",
  dedupKey: "delivery:sample",
  code: "DELIVERY_UNAVAILABLE",
  severity: "warning",
  title: "Webhook delivery failed",
  text: "Review the configured endpoint.",
} as const;

beforeAll(async () => { database = await createTestDb({ schema: { operationalAlerts, orders, users } }); });
afterAll(async () => { await database?.cleanup(); });
beforeEach(async () => {
  await database.db.delete(operationalAlerts);
  await database.db.delete(orders);
  await database.db.delete(users);
  harness = createTestDeps({ db: database.db });
  service = createOpsAlertsModule(harness.deps);
  service.init();
});

describe("operations alert persistence", () => {
  it("accepts a deduplicated retention failure alert from the trash coordinator", async () => {
    const input = { source: "trash", severity: "error", code: "TRASH_PURGE_FAILED", title: "Trash cleanup needs attention",
      dedupKey: "retention:synthetic-run" } as const;
    const first = await service.emit(input);
    expect(await service.emit(input)).toEqual(first);
    expect(await service.list({ source: "trash" })).toMatchObject({ items: [{ publicId: first.publicId, code: input.code }] });
  });

  it("deduplicates missing Stripe webhook warnings by environment, not by payment", async () => {
    const test = stripeWebhookDeliveryMissingAlert("test");
    const [first, second] = await Promise.all([service.emit(test), service.emit(test)]);
    expect(second.publicId).toBe(first.publicId);
    const live = await service.emit(stripeWebhookDeliveryMissingAlert("live"));
    expect(live.publicId).not.toBe(first.publicId);
    expect(await service.summary()).toMatchObject({ warning: 2 });
    const alerts = await service.list({ source: "payment" });
    expect(alerts.items.map(({ title, code, orderPublicId }) => ({ title, code, orderPublicId }))).toEqual(
      Array.from({ length: 2 }, () => ({
        title: "Stripe is not delivering webhooks to this server", code: "STRIPE_WEBHOOK_DELIVERY_MISSING", orderPublicId: null,
      })),
    );
  });

  it("registers the daily attention queue and leaves it off on older configuration", async () => {
    expect(await service.reminderConfig()).toEqual({ enabled: false, hours: 48 });
    const schedule = harness.jobs.schedules.find(({ type }) => type === "ops.alerts.attention_check")!;
    expect(schedule.everyMs).toBe(86_400_000);
    await harness.jobs.enqueue(schedule.type, null);
    expect(await harness.jobs.runAll(schedule.type)).toEqual([{ outcome: "completed" }]);
    expect(await service.list({})).toEqual({ items: [], nextCursor: null });
  });

  it("requires current admin step-up before changing reminder settings", async () => {
    const principal = fakePrincipal({ role: "admin", stepUpAt: harness.clock.now() });
    let currentStepUpAt: Date | null = null;
    harness.services.identity = {
      sessions: { assertCurrent: async () => ({ role: "admin", pendingSteps: [], stepUpAt: currentStepUpAt }) },
    } as unknown as TestHarness["services"]["identity"];
    const input = { enabled: true, hours: 36 };
    await expect(service.updateReminderConfig(principal, input)).rejects.toMatchObject({ reasonCode: "STEP_UP_REQUIRED" });
    expect(await service.reminderConfig()).toEqual({ enabled: false, hours: 48 });
    currentStepUpAt = harness.clock.now();
    await expect(service.updateReminderConfig(principal, input)).resolves.toEqual(input);
    expect(await service.reminderConfig()).toEqual(input);
  });

  it("writes one alert per overdue waiting episode and checks its fencing token before writing", async () => {
    const now = harness.clock.now();
    const owner = ulid(now.getTime());
    const [user] = await database.db.insert(users).values({
      publicId: owner, role: "customer", status: "active",
      emailEnc: "test", emailIndex: harness.deps.crypto.blindIndex("staff@example.test", "users.email"),
      nameEnc: "test", createdAt: now, updatedAt: now,
    });
    const old = new Date(now.getTime() - 72 * 60 * 60 * 1000);
    const ids = [ulid(), ulid(), ulid(), ulid()];
    await database.db.insert(orders).values(ids.map((id, i) => ({
      publicId: id, reference: `RP-TEST-${i}`, ownerUserId: Number(user.insertId), projectName: "Synthetic order",
      workflowVersionId: 1, statusKey: "received", subtotalMinor: 0, totalMinor: 0, currency: "USD",
      attention: i === 1 ? "customer_response" as const : "staff_review" as const,
      attentionSince: i === 2 ? now : old, createdAt: now, updatedAt: now,
      ...(i === 3 ? { trashedAt: now } : {}),
    })));
    await harness.settings.set(ATTENTION_ALERTS_ENABLED.key, true);
    const kind = "ops.alerts.attention_check";
    const handler = harness.jobs.handlers.get(kind)!;
    const fence = vi.fn(async () => {});
    const run = { jobId: ulid(), type: kind, payload: null as never, attempt: 1, fencingToken: 1,
      correlationId: ulid(), signal: new AbortController().signal, assertStillOwned: fence };
    await expect(handler({ ...run, assertStillOwned: async () => { throw new Error("fence lost"); } })).rejects.toThrow("fence lost");
    expect((await service.list({})).items).toHaveLength(0);
    expect(await handler(run)).toMatchObject({ outcome: "completed", safeCounts: { orders_checked: 2 } });
    expect(fence).toHaveBeenCalledWith(expect.anything());
    await handler({ ...run, jobId: ulid() });
    expect((await service.list({ source: "attention" })).items.map(({ orderPublicId }) => orderPublicId).sort()).toEqual(ids.slice(0, 2).sort());
    expect(harness.mailer.sent).toHaveLength(0);
  });

  it("hides historical waiting-order alerts from list, counts and management without hiding payment alerts", async () => {
    const now = harness.clock.now();
    const orderPublicId = ulid();
    const [owner] = await database.db.insert(users).values({
      publicId: ulid(), role: "customer", status: "active",
      emailEnc: "test", emailIndex: harness.deps.crypto.blindIndex("buyer@example.test", "users.email"),
      nameEnc: "test", createdAt: now, updatedAt: now,
    });
    await database.db.insert(orders).values({
      publicId: orderPublicId, reference: "RP-TEST-HISTORY", ownerUserId: Number(owner.insertId), projectName: "Synthetic order",
      workflowVersionId: 1, statusKey: "received", subtotalMinor: 0, totalMinor: 0, currency: "USD", createdAt: now, updatedAt: now,
    });
    const waiting = await service.emit({ ...fixture, source: "attention", orderPublicId, code: "ORDER_ATTENTION_OVERDUE",
      dedupKey: "waiting:example", title: "Order is waiting" });
    const payment = await service.emit({ ...fixture, source: "payment", orderPublicId, code: "PAYMENT_REVIEW",
      dedupKey: "payment:example", title: "Review payment" });
    expect(await service.summary()).toEqual({ warning: 2, error: 0, critical: 0 });
    expect((await service.list({ source: "attention" })).items[0]?.publicId).toBe(waiting.publicId);

    const staff = fakePrincipal({ role: "staff" });
    harness.services.identity = {
      sessions: { assertCurrent: async () => ({ role: "staff", pendingSteps: [] }) },
    } as unknown as TestHarness["services"]["identity"];
    await database.db.update(orders).set({ trashedAt: now }).where(eq(orders.publicId, orderPublicId));
    expect((await service.list({})).items.map(({ publicId }) => publicId)).toEqual([payment.publicId]);
    expect(await service.summary()).toEqual({ warning: 1, error: 0, critical: 0 });
    await expect(service.manage(staff, waiting.publicId, "acknowledged")).rejects.toMatchObject({ reasonCode: "NOT_FOUND" });
    expect(await service.manage(staff, payment.publicId, "acknowledged")).toEqual({ changed: true });
    expect(await service.summary()).toEqual({ warning: 0, error: 0, critical: 0 });

    await database.db.update(orders).set({ trashedAt: null }).where(eq(orders.publicId, orderPublicId));
    expect(await service.manage(staff, waiting.publicId, "acknowledged")).toEqual({ changed: true });
  });

  it("registers a single daily, retry-safe SAML slot", async () => {
    const handler = vi.fn(async () => ({ outcome: "completed" as const }));
    registerSamlMetadataCheck(harness.jobs, handler);
    expect(harness.jobs.schedules.filter(({ type }) => type === SAML_METADATA_CHECK_JOB)).toEqual([
      { name: SAML_METADATA_CHECK_JOB, type: SAML_METADATA_CHECK_JOB, everyMs: 86_400_000 },
    ]);
    expect(harness.jobs.handlerOptions.get(SAML_METADATA_CHECK_JOB)).toEqual({ retrySafe: true });
    await harness.jobs.enqueue(SAML_METADATA_CHECK_JOB, null);
    await harness.jobs.runAll(SAML_METADATA_CHECK_JOB);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("deduplicates concurrent retries; escalates once and preserves a terminal resolution", async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => service.emit(fixture)));
    const id = results[0]!.publicId;
    expect(new Set(results.map((row) => row.publicId))).toEqual(new Set([id]));
    expect(await service.summary()).toEqual({ warning: 1, error: 0, critical: 0 });
    const staff = fakePrincipal({ role: "staff" });
    harness.services.identity = {
      sessions: { assertCurrent: async () => ({ role: "staff", pendingSteps: [] }) },
    } as unknown as TestHarness["services"]["identity"];
    expect(await service.manage(staff, id, "acknowledged")).toEqual({ changed: true });
    expect(await service.summary()).toEqual({ warning: 0, error: 0, critical: 0 });
    expect(await service.emit({ ...fixture, severity: "error" })).toEqual({ publicId: id, state: "open" });
    expect(await service.resolve({ source: fixture.source, dedupKey: fixture.dedupKey })).toBe(true);
    expect(await service.emit({ ...fixture, severity: "critical" })).toEqual({ publicId: id, state: "resolved" });
    expect(await service.resolve({ source: fixture.source, dedupKey: fixture.dedupKey })).toBe(false);
    expect(await service.list({ state: "resolved", severity: "error", source: "webhook" })).toMatchObject({ items: [{ publicId: id }] });
  });

  it("rolls back with its caller and does not audit raw prose or keys", async () => {
    let recorded: unknown;
    harness.deps.audit.record = async (event) => { recorded = event; };
    await expect(database.db.transaction(async (tx) => {
      await service.emit(fixture, tx);
      throw new Error("caller rollback");
    })).rejects.toThrow("caller rollback");
    expect(await service.list({})).toEqual({ items: [], nextCursor: null });
    expect(recorded).toMatchObject({ eventName: "ops.alert.opened", reasonCode: fixture.code });
    const audit = JSON.stringify(recorded);
    for (const sensitive of [fixture.dedupKey, fixture.title, fixture.text]) expect(audit).not.toContain(sensitive);
  });

  it("pages without exposing hashes, rejects unsafe markup, and checks live mutation authority", async () => {
    const first = await service.emit(fixture);
    const second = await service.emit({ ...fixture, dedupKey: "delivery:next" });
    const [earlier, later] = [first.publicId, second.publicId].sort();
    const page = await service.list({ limit: 1 });
    expect(page.items[0]).toMatchObject({ publicId: later });
    expect(page.items[0]).not.toHaveProperty("dedupHash");
    expect((await service.list({ cursor: page.nextCursor! })).items.map((item) => item.publicId)).toEqual([earlier]);
    await expect(service.emit({ ...fixture, title: "<b>Invalid</b>" })).rejects.toMatchObject({ reasonCode: "INVALID_OPERATIONAL_ALERT" });
    await expect(service.emit({ ...fixture, text: "Contact private@example.test" })).rejects.toMatchObject({ reasonCode: "INVALID_OPERATIONAL_ALERT" });
    harness.services.identity = {
      sessions: { assertCurrent: async () => ({ role: "customer", pendingSteps: [] }) },
    } as unknown as TestHarness["services"]["identity"];
    await expect(service.manage(fakePrincipal({ role: "staff" }), first.publicId, "resolved")).rejects.toMatchObject({ reasonCode: "OPS_ALERT_MANAGE_FORBIDDEN" });
  });
});
