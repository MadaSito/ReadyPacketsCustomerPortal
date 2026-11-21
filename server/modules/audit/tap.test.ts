import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { mysqlTable, varchar } from "drizzle-orm/mysql-core";
import { AuditUnavailableError } from "../../core/errors.js";
import { newRequestContext, runWithRequestContext } from "../../core/requestContext.js";
import type { AuditEventInput, Tx } from "../../core/types.js";
import { idColumn } from "../../db/columns.js";
import { createTestDeps, silentLogger } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { createAuditEmitter, type DurableAuditEmitter } from "./emitter.js";
import { EVENT_NAME_RE } from "./envelope.js";
import * as auditSchema from "./schema.js";
import { auditEvents } from "./schema.js";
import { abortsTransaction, automationCorrelationId, isAutomationOrigin, type AuditTap, type AuditTapEvent } from "./tap.js";
import { CATALOGUE_EVENT_NAMES, TRIGGER_CATALOGUE, entriesForEvent } from "./triggerCatalogue.js";

const things = mysqlTable("test_tap_things", { id: idColumn(), label: varchar("label", { length: 40 }).notNull() });
const RUN_ID = "01JD0000000000000000000RUN";

const event = (patch: Partial<AuditEventInput> = {}): AuditEventInput => ({
  category: "business", eventName: "order.created", action: "create", outcome: "completed", actor: { userId: 7, role: "customer" },
  resource: { type: "order", publicId: "01JD0000000000000000000001" }, attributes: { currency: "USD", total_minor: 1200, contact_email: "a@b.example.test" },
  ...patch,
});

describe("audit tap (real MySQL)", () => {
  let t: TestDb;
  let emitter: DurableAuditEmitter;
  let detach: (() => void) | null = null;
  const h = createTestDeps();

  beforeAll(async () => {
    t = await createTestDb({ schema: { ...auditSchema, things } });
    emitter = createAuditEmitter({ config: h.config, db: t.db, clock: h.clock, logger: silentLogger, crypto: h.deps.crypto });
  });
  afterAll(() => t.cleanup());
  beforeEach(async () => {
    detach?.();
    detach = null;
    await t.db.delete(auditEvents);
    await t.db.delete(things);
  });

  const install = (tap: AuditTap) => { detach = emitter.setTap(tap); };

  it("does nothing beyond one synchronous lookup when no automation listens", async () => {
    const onRecorded = vi.fn(async () => undefined);
    const listens = vi.fn(() => false);
    install({ listens, onRecorded });
    await t.db.transaction(async (tx) => {
      await tx.insert(things).values({ label: "business" });
      await emitter.record(event(), tx);
    });
    expect(listens).toHaveBeenCalledTimes(1);
    expect(listens).toHaveBeenCalledWith("order.created");
    expect(onRecorded).not.toHaveBeenCalled();
    expect(await t.db.select().from(things)).toHaveLength(1);
  });

  it("offers a listened event inside the caller's transaction with only validated fields", async () => {
    const seen: AuditTapEvent[] = [];
    install({
      listens: (name) => name === "order.created",
      onRecorded: async (e, tx) => { seen.push(e); await (tx as Tx).insert(things).values({ label: "job" }); },
    });
    await expect(t.db.transaction(async (tx) => {
      await tx.insert(things).values({ label: "business" });
      await runWithRequestContext(newRequestContext("http", { ipAddress: "203.0.113.9", correlationId: "corr-1" }), () => emitter.record(event(), tx));
      throw new Error("business rollback");
    })).rejects.toThrow("business rollback");
    expect(await t.db.select().from(things)).toHaveLength(0);
    expect(seen).toHaveLength(1);
    const e = seen[0]!;
    expect(e).toMatchObject({ eventName: "order.created", outcome: "completed", correlationId: "corr-1", resource: { type: "order", publicId: "01JD0000000000000000000001" }, actor: { role: "customer", userId: 7 } });
    expect(e.attributes).toEqual({ currency: "USD", total_minor: 1200 });
    expect(JSON.stringify(e)).not.toMatch(/203\.0\.113|example\.test|sess/u);
    expect(Object.isFrozen(e) && Object.isFrozen(e.attributes)).toBe(true);
  });

  it("never offers events that carry the automation-origin marker, including in descendants", async () => {
    const onRecorded = vi.fn(async () => undefined);
    install({ listens: () => true, onRecorded });
    const marker = automationCorrelationId(RUN_ID);
    await runWithRequestContext(newRequestContext("worker", { correlationId: marker }), () => emitter.record(event({ eventName: "job.mail.failed", outcome: "failed" })));
    await emitter.record(event({ eventName: "job.mail.failed", outcome: "failed", correlationId: "corr-2", parentCorrelationId: marker }));
    expect(onRecorded).not.toHaveBeenCalled();
    expect(emitter.tapStats().suppressedAutomationOrigin).toBe(2);
    expect(await t.db.select().from(auditEvents)).toHaveLength(2);
  });

  it("a tap failure never fails the business transaction", async () => {
    install({ listens: () => true, onRecorded: async () => { throw new Error("enqueue failed"); } });
    const before = emitter.tapStats().failures;
    await t.db.transaction(async (tx) => {
      await tx.insert(things).values({ label: "business" });
      await emitter.record(event(), tx);
    });
    expect(await t.db.select().from(things)).toHaveLength(1);
    expect(await t.db.select().from(auditEvents)).toHaveLength(1);
    expect(emitter.tapStats().failures).toBe(before + 1);
  });

  it("fails closed when the database has already rolled the transaction back", async () => {
    const deadlock = Object.assign(new Error("Deadlock found"), { errno: 1213 });
    install({ listens: () => true, onRecorded: async () => { throw new Error("wrapped", { cause: deadlock }); } });
    await expect(t.db.transaction(async (tx) => {
      await tx.insert(things).values({ label: "business" });
      await emitter.record(event(), tx);
    })).rejects.toBeInstanceOf(AuditUnavailableError);
    expect(await t.db.select().from(things)).toHaveLength(0);
  });

  it("treats a throwing listens() as not listening and never offers best-effort notes", async () => {
    const onRecorded = vi.fn(async () => undefined);
    install({ listens: () => { throw new Error("boom"); }, onRecorded });
    await emitter.record(event());
    detach?.();
    install({ listens: () => true, onRecorded });
    emitter.note(event());
    await emitter.flushNotes();
    expect(onRecorded).not.toHaveBeenCalled();
  });

  it("offers events recorded outside a transaction with tx undefined", async () => {
    const onRecorded = vi.fn(async (_e: AuditTapEvent, _tx: Tx | undefined) => undefined);
    install({ listens: () => true, onRecorded });
    await emitter.record(event());
    expect(onRecorded).toHaveBeenCalledTimes(1);
    expect(onRecorded.mock.calls[0]![1]).toBeUndefined();
  });

  it("isolates a multi-write tap in a savepoint so a failing tap leaves no partial rows", async () => {
    install({
      listens: () => true,
      onRecorded: async (_e, tx) => { await (tx as Tx).insert(things).values({ label: "tap-1" }); throw new Error("second write failed"); },
    });
    await t.db.transaction(async (tx) => {
      await tx.insert(things).values({ label: "business" });
      await emitter.record(event(), tx);
    });
    expect((await t.db.select().from(things)).map((r) => r.label)).toEqual(["business"]);
  });

  it("fails closed when the transaction was really rolled back under the tap and the callback threw (J-A02)", async () => {
    install({
      listens: () => true,
      onRecorded: async (_e, tx) => { await (tx as Tx).execute(sql`ROLLBACK`); throw new Error("enqueue failed after rollback"); },
    });
    let reachedLaterWrite = false;
    await expect(t.db.transaction(async (tx) => {
      await tx.insert(things).values({ label: "business" });
      await emitter.record(event(), tx);
      reachedLaterWrite = true;
      await tx.insert(things).values({ label: "later" });
    })).rejects.toBeInstanceOf(AuditUnavailableError);
    expect(reachedLaterWrite).toBe(false);
    expect(await t.db.select().from(things)).toHaveLength(0);
    expect(await t.db.select().from(auditEvents)).toHaveLength(0);
  });

  it("fails closed when the savepoint vanished even though the callback returned normally (J-A02)", async () => {
    install({ listens: () => true, onRecorded: async (_e, tx) => { await (tx as Tx).execute(sql`ROLLBACK`); } });
    let reachedLaterWrite = false;
    await expect(t.db.transaction(async (tx) => {
      await tx.insert(things).values({ label: "business" });
      await emitter.record(event(), tx);
      reachedLaterWrite = true;
      await tx.insert(things).values({ label: "later" });
    })).rejects.toBeInstanceOf(AuditUnavailableError);
    expect(reachedLaterWrite).toBe(false);
    expect(await t.db.select().from(things)).toHaveLength(0);
  });

  it("recognises a missing savepoint as transaction-ending", () => {
    expect(abortsTransaction(Object.assign(new Error("SAVEPOINT sp1 does not exist"), { errno: 1305 }))).toBe(true);
  });

  it("allows one tap at a time", () => {
    install({ listens: () => false, onRecorded: async () => undefined });
    expect(() => emitter.setTap({ listens: () => false, onRecorded: async () => undefined })).toThrow(/already installed/u);
  });
});

describe("automation-origin marker and transaction-abort detection", () => {
  it("builds and recognises the marker within correlation limits", () => {
    const id = automationCorrelationId(RUN_ID);
    expect(id.length).toBeLessThanOrEqual(64);
    expect(isAutomationOrigin(id)).toBe(true);
    expect(isAutomationOrigin("corr-1")).toBe(false);
    expect(isAutomationOrigin(null)).toBe(false);
    expect(() => automationCorrelationId("bad id with spaces")).toThrow();
  });

  it("recognises MySQL deadlock and lock-wait errors through causes", () => {
    expect(abortsTransaction(Object.assign(new Error("x"), { errno: 1205 }))).toBe(true);
    expect(abortsTransaction(new Error("outer", { cause: Object.assign(new Error("x"), { errno: 1213 }) }))).toBe(true);
    expect(abortsTransaction(Object.assign(new Error("dup"), { errno: 1062 }))).toBe(false);
  });
});

describe("trigger catalogue", () => {
  const tapEvent = (patch: Partial<AuditTapEvent>): AuditTapEvent => ({
    eventId: "01JD00000000000000000000EV", eventName: "order.created", category: "business", action: "create", outcome: "completed", reasonCode: null,
    occurredAt: "2026-11-21T00:00:00.000Z", actor: { role: "customer", userId: 1 }, resource: { type: "order", publicId: "01JD0000000000000000000001" },
    correlationId: null, jobId: null, attributes: {}, safeCounts: {}, ...patch,
  });

  it("is well-formed: unique keys, valid event names, safe field rules", () => {
    const keys = TRIGGER_CATALOGUE.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of TRIGGER_CATALOGUE) {
      expect(entry.eventName).toMatch(EVENT_NAME_RE);
      expect(entry.outcomes.length).toBeGreaterThan(0);
      expect(entry.recipients.length).toBeGreaterThan(0);
      const fieldKeys = entry.fields.map((field) => field.key);
      expect(new Set(fieldKeys).size).toBe(fieldKeys.length);
      for (const field of entry.fields) if (field.personal) expect(field.from).toBe("context");
    }
    expect(CATALOGUE_EVENT_NAMES.has("backup.archive.failed")).toBe(true);
    expect(CATALOGUE_EVENT_NAMES.has("backup.policy.unmet")).toBe(true);
  });

  it("covers the initial list from the contract", () => {
    expect(TRIGGER_CATALOGUE.map((e) => e.key)).toEqual(expect.arrayContaining([
      "account.registered", "account.activated", "account.password_reset_requested", "account.password_changed", "order.created",
      "order.status_changed", "order.assigned", "file.uploaded", "message.posted", "ticket.opened", "ticket.replied", "ticket.closed",
      "invoice.issued", "invoice.paid", "maintenance.enabled", "backup.completed", "backup.failed", "mail.delivery_failed",
    ]));
  });

  it("never triggers on a refused registration for an existing address", () => {
    expect(entriesForEvent(tapEvent({ eventName: "auth.register.requested", outcome: "refused", resource: { type: "user", publicId: "01JD0000000000000000000002" } }))).toEqual([]);
    expect(entriesForEvent(tapEvent({ eventName: "auth.register.requested", outcome: "completed", resource: { type: "user", publicId: "01JD0000000000000000000002" } })).map((e) => e.key)).toEqual(["account.registered"]);
  });

  it("applies fixed matches (ticket closed, public replies only, maintenance on)", () => {
    const ticket = { type: "ticket", publicId: "01JD0000000000000000000003" };
    expect(entriesForEvent(tapEvent({ eventName: "engagement.ticket.status.changed", resource: ticket, attributes: { to_status: "closed" } })).map((e) => e.key)).toEqual(["ticket.closed"]);
    expect(entriesForEvent(tapEvent({ eventName: "engagement.ticket.status.changed", resource: ticket, attributes: { to_status: "resolved" } }))).toEqual([]);
    expect(entriesForEvent(tapEvent({ eventName: "engagement.ticket.replied", resource: ticket, attributes: { internal_only: true } }))).toEqual([]);
    expect(entriesForEvent(tapEvent({ eventName: "job.maintenance.changed", resource: { type: "job_maintenance", publicId: null }, reasonCode: "MAINTENANCE_DISABLED" }))).toEqual([]);
    expect(entriesForEvent(tapEvent({ eventName: "job.maintenance.changed", resource: { type: "job_maintenance", publicId: null }, reasonCode: "MAINTENANCE_ENABLED" })).map((e) => e.key)).toEqual(["maintenance.enabled"]);
  });

  it("keeps internal order notes away from customer-facing triggers (review J-A01)", () => {
    const message = { type: "order_message", publicId: "01JD0000000000000000000004" };
    expect(entriesForEvent(tapEvent({ eventName: "engagement.message.sent", resource: message, attributes: { visibility: "internal", attachment_count: 1 } })).map((e) => e.key)).toEqual(["message.internal_note"]);
    expect(entriesForEvent(tapEvent({ eventName: "engagement.message.sent", resource: message, attributes: { visibility: "customer" } })).map((e) => e.key)).toEqual(["message.posted"]);
    expect(entriesForEvent(tapEvent({ eventName: "engagement.message.sent", resource: message, attributes: {} }))).toEqual([]);
    const internal = TRIGGER_CATALOGUE.find((e) => e.key === "message.internal_note")!;
    expect(internal.staffOnly).toBe(true);
    expect(internal.recipients.map((r) => r.key)).not.toContain("order_owner");
    for (const entry of TRIGGER_CATALOGUE) {
      if (entry.eventName === "engagement.message.sent" || entry.eventName === "engagement.ticket.replied") expect(entry.match).toBeDefined();
    }
  });

  it("requires the expected resource type", () => {
    expect(entriesForEvent(tapEvent({ resource: { type: "ticket", publicId: "01JD0000000000000000000001" } }))).toEqual([]);
  });
});
