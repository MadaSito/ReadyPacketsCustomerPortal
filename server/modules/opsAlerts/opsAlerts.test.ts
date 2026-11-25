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
  it("registers the daily attention queue and leaves it off on older configuration", async () => {
    expect(await service.reminderConfig()).toEqual({ enabled: false, hours: 48 });
    const schedule = harness.jobs.schedules.find(({ type }) => type === "ops.alerts.attention_check")!;
    expect(schedule.everyMs).toBe(86_400_000);
    await harness.jobs.enqueue(schedule.type, null);
    expect(await harness.jobs.runAll(schedule.type)).toEqual([{ outcome: "completed" }]);
    expect(await service.list({})).toEqual({ items: [], nextCursor: null });
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
    const ids = [ulid(), ulid(), ulid()];
    await database.db.insert(orders).values(ids.map((id, i) => ({
      publicId: id, reference: `RP-TEST-${i}`, ownerUserId: Number(user.insertId), projectName: "Synthetic order",
      workflowVersionId: 1, statusKey: "received", subtotalMinor: 0, totalMinor: 0, currency: "USD",
      attention: i === 1 ? "customer_response" as const : "staff_review" as const,
      attentionSince: i === 2 ? now : old, createdAt: now, updatedAt: now,
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
