import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { mysqlTable, varchar } from "drizzle-orm/mysql-core";
import { AuditUnavailableError } from "../../core/errors.js";
import { newRequestContext, runWithRequestContext } from "../../core/requestContext.js";
import { idColumn } from "../../db/columns.js";
import { createTestDeps, silentLogger } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { createAuditEmitter, type DurableAuditEmitter } from "./emitter.js";
import * as auditSchema from "./schema.js";
import { auditEvents } from "./schema.js";
import { rowToEnvelope, decryptSourceAddress } from "./rows.js";

const businessThings = mysqlTable("test_business_things", { id: idColumn(), label: varchar("label", { length: 40 }).notNull() });

describe("audit emitter (real MySQL)", () => {
  let t: TestDb;
  let emitter: DurableAuditEmitter;
  const h = createTestDeps();

  beforeAll(async () => {
    t = await createTestDb({ schema: { ...auditSchema, businessThings } });
    emitter = createAuditEmitter({ config: h.config, db: t.db, clock: h.clock, logger: silentLogger, crypto: h.deps.crypto });
  });
  afterAll(() => t.cleanup());
  beforeEach(async () => {
    await t.db.delete(auditEvents);
    await t.db.delete(businessThings);
  });

  it("writes the canonical envelope with request correlation and actor pseudonym", async () => {
    const ctx = newRequestContext("http", { ipAddress: "203.0.113.9", correlationId: "corr-1" });
    ctx.actor = { userId: 42, role: "admin", sessionId: "sess_public_1" };
    await runWithRequestContext(ctx, () =>
      emitter.record({
        category: "admin",
        eventName: "order.reassigned",
        action: "reassign",
        outcome: "completed",
        resource: { type: "order", publicId: "01JD0000000000000000000001" },
        attributes: { from_status: "draft", count_ok: 3 },
        safeCounts: { orders: 1 },
      }),
    );
    const [row] = await t.db.select().from(auditEvents);
    expect(row).toBeDefined();
    const env = rowToEnvelope(row!);
    expect(env).toMatchObject({
      schema_version: "rp.audit/1",
      severity_text: "INFO",
      severity_number: 9,
      actor_role: "admin",
      actor_user_id: 42,
      request_id: ctx.requestId,
      trace_id: ctx.traceId,
      span_id: ctx.spanId,
      correlation_id: "corr-1",
      source_address_class: "public",
      resource_public_id: "01JD0000000000000000000001",
      attributes: { from_status: "draft", count_ok: 3 },
      safe_counts: { orders: 1 },
      durability: "durable",
    });
    expect(env.actor_ref).toMatch(/^[0-9a-f]{32}$/);
    expect(env.session_ref).toMatch(/^[0-9a-f]{32}$/);
    // Raw IP never stored in clear; decryptable only with the data key + AAD bound to the event id.
    expect(row!.sourceAddressEnc).not.toContain("203.0.113.9");
    expect(decryptSourceAddress(h.deps.crypto, row!)).toBe("203.0.113.9");
    expect(JSON.stringify(row)).not.toContain("sess_public_1");
  });

  it("drops unsafe attributes instead of storing them", async () => {
    await emitter.record({
      category: "security",
      eventName: "auth.login.failed",
      action: "login",
      outcome: "denied",
      reasonCode: "BAD_CREDENTIALS",
      attributes: {
        password: "hunter2-hunter2",
        email: "x@example.test",
        user_hint: "someone@example.test",
        jwt_like: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlLXNpZw",
        sql_like: "x'; DROP TABLE users; --",
        crlf: "ok\r\nFAKE LOG LINE",
        bearer_hdr: "Bearer abcdefghijklmnop",
        long_secret: "A".repeat(20) + "b1C2d3E4f5G6h7I8j9K0l1M2n3",
        huge: "y".repeat(200),
        Bad_Key: "v",
        method: "password",
      },
    });
    const [row] = await t.db.select().from(auditEvents);
    const env = rowToEnvelope(row!);
    expect(env.attributes).toEqual({ method: "password" });
    expect(env.dropped_attributes).toBe(10);
    expect(env.severity_text).toBe("WARN");
    const raw = JSON.stringify(row);
    for (const leaked of ["hunter2", "example.test", "eyJhbGci", "DROP TABLE", "FAKE LOG", "abcdefghijklmnop"]) expect(raw).not.toContain(leaked);
  });

  it("rejects malformed names and reason codes (fail closed)", async () => {
    const bad = [
      { eventName: "Order.Created" },
      { eventName: "order created" },
      { eventName: "order.${user}" },
      { eventName: "single" },
      { reasonCode: "lower_case" },
      { action: "Drop Table" },
      { category: "nope" },
      { outcome: "succeeded" },
    ];
    for (const patch of bad) {
      await expect(
        emitter.record({ category: "business", eventName: "order.created", action: "create", outcome: "completed", ...patch } as never),
      ).rejects.toBeInstanceOf(AuditUnavailableError);
    }
    expect(await t.db.select().from(auditEvents)).toHaveLength(0);
  });

  it("writes inside the caller's transaction and rolls back with it", async () => {
    await expect(
      t.db.transaction(async (tx) => {
        await tx.insert(businessThings).values({ label: "in-tx" });
        await emitter.record({ category: "business", eventName: "thing.created", action: "create", outcome: "completed" }, tx);
        throw new Error("business failure after audit");
      }),
    ).rejects.toThrow("business failure after audit");
    expect(await t.db.select().from(auditEvents)).toHaveLength(0);
    expect(await t.db.select().from(businessThings)).toHaveLength(0);
  });

  it("fails closed: an audit store failure aborts the business transaction", async () => {
    await t.db.execute(sql`RENAME TABLE audit_events TO audit_events_offline`);
    try {
      await expect(
        t.db.transaction(async (tx) => {
          await tx.insert(businessThings).values({ label: "must-not-commit" });
          await emitter.record({ category: "admin", eventName: "thing.deleted", action: "delete", outcome: "completed" }, tx);
        }),
      ).rejects.toBeInstanceOf(AuditUnavailableError);
    } finally {
      await t.db.execute(sql`RENAME TABLE audit_events_offline TO audit_events`);
    }
    expect(await t.db.select().from(businessThings).where(eq(businessThings.label, "must-not-commit"))).toHaveLength(0);
    expect(emitter.stats().recordFailures).toBeGreaterThan(0);
  });

  it("best-effort notes never throw, are bounded and record drops durably", async () => {
    emitter.note({ category: "system", eventName: "ui.page.viewed", action: "view", outcome: "completed" });
    emitter.note({ category: "system", eventName: "BAD NAME", action: "view", outcome: "completed" } as never);
    await emitter.flushNotes();
    const rows = await t.db.select().from(auditEvents);
    expect(rows.map((r) => [r.eventName, r.durability])).toEqual([["ui.page.viewed", "best_effort"]]);

    await t.db.execute(sql`RENAME TABLE audit_events TO audit_events_offline`);
    try {
      expect(() => emitter.note({ category: "system", eventName: "ui.page.viewed", action: "view", outcome: "completed" })).not.toThrow();
      await emitter.flushNotes();
    } finally {
      await t.db.execute(sql`RENAME TABLE audit_events_offline TO audit_events`);
    }
    expect(emitter.stats().notesDropped).toBeGreaterThanOrEqual(1);
    emitter.note({ category: "system", eventName: "ui.page.viewed", action: "view", outcome: "completed" });
    await emitter.flushNotes();
    const names = (await t.db.select().from(auditEvents)).map((r) => r.eventName);
    expect(names).toContain("audit.note.dropped");
  });
});
