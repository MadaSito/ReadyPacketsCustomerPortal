import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { notFound } from "../../core/errors.js";
import { newRequestContext, runWithRequestContext } from "../../core/requestContext.js";
import type { AuditEventInput, SessionPrincipal } from "../../core/types.js";
import type { ModuleDeps } from "../../container.js";
import { createTestDeps, fakePrincipal, silentLogger } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import type { AuditCtx } from "./access.js";
import { createChainService } from "./chain.js";
import { createAuditEmitter, type DurableAuditEmitter } from "./emitter.js";
import { canonicalBytes } from "./envelope.js";
import { classifyOrderEvent, listOrderActivity } from "./orderActivity.js";
import { rowToEnvelope } from "./rows.js";
import * as auditSchema from "./schema.js";
import { auditEvents } from "./schema.js";

/* Synthetic ids only. */
const ORDER_A = "ord_synthetic_aaaa01";
const ORDER_B = "ord_synthetic_bbbb02";
const owner = fakePrincipal({ role: "customer" });
const sharer = fakePrincipal({ role: "customer" });
const outsider = fakePrincipal({ role: "customer" });
const staff = fakePrincipal({ role: "staff" });
const STAFF_NAME = "Synthetic Staffer";

describe("order activity port (real MySQL)", () => {
  let t: TestDb;
  let emitter: DurableAuditEmitter;
  let ctx: AuditCtx;
  const h = createTestDeps();
  let minute = 0;

  const emit = (who: SessionPrincipal | "system", event: Omit<AuditEventInput, "occurredAt" | "category" | "action"> & Partial<AuditEventInput>) => {
    const rc = newRequestContext("http", { ipAddress: "203.0.113.77", correlationId: `corr-${minute}` });
    if (who !== "system") rc.actor = { userId: who.userId, role: who.role, sessionId: who.sessionId };
    minute += 1;
    return runWithRequestContext(rc, () =>
      emitter.record({
        category: "business",
        action: "update",
        ...(who === "system" ? { actor: { role: "system" } } : {}),
        ...event,
        occurredAt: new Date(Date.UTC(2026, 10, 20, 9, minute)),
      }),
    );
  };

  beforeAll(async () => {
    t = await createTestDb({ schema: auditSchema });
    emitter = createAuditEmitter({ config: h.config, db: t.db, clock: h.clock, logger: silentLogger, crypto: h.deps.crypto });
    const orders = {
      assertCanReadOrder: async (principal: SessionPrincipal, orderPublicId: string) => {
        const allowed = principal.role !== "customer" || ((principal.userId === owner.userId || principal.userId === sharer.userId) && orderPublicId === ORDER_A);
        if (!allowed || (orderPublicId !== ORDER_A && orderPublicId !== ORDER_B)) throw notFound("ORDER_NOT_FOUND");
        return { publicId: orderPublicId };
      },
    };
    const identity = { getUser: async (id: number) => (id === staff.userId ? { name: STAFF_NAME } : id === owner.userId ? { name: "Synthetic Owner" } : null) };
    const deps = { ...h.deps, db: t.db, audit: emitter, services: { ...h.services, orders, identity } } as unknown as ModuleDeps;
    ctx = { deps, chain: createChainService({ db: t.db, clock: h.clock, logger: silentLogger, auditChainKey: h.config.auditChainKey, installationId: h.config.installationId }) };
  });
  afterAll(() => t.cleanup());
  beforeEach(async () => {
    await t.db.delete(auditEvents);
    minute = 0;
  });

  const staffPage = async (input: Parameters<typeof listOrderActivity>[2]) => {
    const page = await listOrderActivity(ctx, staff, input);
    if (page.view !== "staff") throw new Error("expected the staff projection");
    return page;
  };

  async function seed() {
    await emit(owner, { eventName: "order.created", outcome: "completed", resource: { type: "order", publicId: ORDER_A } });
    await emit(staff, { eventName: "order.status.changed", outcome: "completed", resource: { type: "order", publicId: ORDER_A }, attributes: { from_status: "draft", to_status: "in_review" } });
    await emit(staff, { eventName: "order.reassigned", outcome: "completed", resource: { type: "order", publicId: ORDER_A } });
    await emit(sharer, { eventName: "file.uploaded", outcome: "completed", resource: { type: "file", publicId: "fil_synthetic_0001" }, attributes: { order_public_id: ORDER_A, file_visibility: "customer_visible" } });
    await emit(staff, { eventName: "file.uploaded", outcome: "completed", resource: { type: "file", publicId: "fil_synthetic_0002" }, attributes: { order_public_id: ORDER_A, file_visibility: "staff_only" } });
    await emit(staff, { eventName: "order.file.converted", outcome: "completed", resource: { type: "file", publicId: "fil_synthetic_0003" }, orderPublicId: ORDER_A });
    await emit("system", { eventName: "order.production.dispatch.failed", outcome: "failed", resource: { type: "production_dispatch", publicId: "dsp_synthetic_001" }, orderPublicId: ORDER_A });
    await emit(owner, { eventName: "order.status.changed", outcome: "denied", resource: { type: "order", publicId: ORDER_A } });
    await emit(staff, { eventName: "order.mystery.thing", outcome: "completed", orderPublicId: ORDER_A, resource: { type: "widget", publicId: "wid_synthetic_001" } });
    await emit(owner, { eventName: "order.created", outcome: "completed", resource: { type: "order", publicId: ORDER_B } });
  }

  it("customer projection: curated events of this order only, no staff identity, ids, IP or staff-only files", async () => {
    await seed();
    const page = await listOrderActivity(ctx, owner, { orderPublicId: ORDER_A });
    expect(page.view).toBe("customer");
    expect(page.items.map((i) => [i.label, i.actor])).toEqual([
      ["File uploaded", "Someone with access to this order"],
      ["Status changed", "ReadyPackets staff"],
      ["Order created", "You"],
    ]);
    expect(page.items[1]!.details).toEqual({ from_status: "draft", to_status: "in_review" });
    const json = JSON.stringify(page);
    for (const leak of [STAFF_NAME, "203.0.113.77", "corr-", "fil_synthetic", ORDER_B, "staff_only"]) expect(json).not.toContain(leak);
    const ids = (await t.db.select({ id: auditEvents.eventId }).from(auditEvents)).map((r) => r.id);
    for (const id of ids) expect(json).not.toContain(id);
  });

  it("a file event without file_visibility is not shown to customers (fail closed)", async () => {
    await emit(staff, { eventName: "file.uploaded", outcome: "completed", resource: { type: "file", publicId: "fil_synthetic_0009" }, attributes: { order_public_id: ORDER_A } });
    expect((await listOrderActivity(ctx, owner, { orderPublicId: ORDER_A })).items).toEqual([]);
    expect((await listOrderActivity(ctx, staff, { orderPublicId: ORDER_A })).items).toHaveLength(1);
  });

  it("staff projection: every order-scoped event with actor names and correlation, never the source address", async () => {
    await seed();
    const page = await staffPage({ orderPublicId: ORDER_A });
    expect(page.items).toHaveLength(9);
    const byName = Object.fromEntries(page.items.map((i) => [`${i.eventName}:${i.outcome}`, i]));
    expect(byName["order.status.changed:completed"]).toMatchObject({ actor: STAFF_NAME, actorRole: "staff", category: "status" });
    expect(byName["order.production.dispatch.failed:failed"]).toMatchObject({ actor: "System", category: "production" });
    expect(byName["order.mystery.thing:completed"]).toMatchObject({ category: "other", label: "order.mystery.thing" });
    expect(page.items.every((i) => i.correlationId?.startsWith("corr-"))).toBe(true);
    expect(JSON.stringify(page)).not.toContain("203.0.113.77");
    expect(JSON.stringify(page)).not.toContain("order_public_id");
  });

  it("finds rows written before the order_public_id column (order as resource) without duplicates", async () => {
    await seed();
    const [first] = await t.db.select().from(auditEvents).where(eq(auditEvents.eventName, "order.created")).limit(1);
    await t.db.update(auditEvents).set({ orderPublicId: null }).where(eq(auditEvents.id, first!.id));
    const page = await staffPage({ orderPublicId: ORDER_A });
    expect(page.items).toHaveLength(9);
    expect(new Set(page.items.map((i) => i.eventId)).size).toBe(9);
  });

  it("paginates across both lookups with an opaque cursor bound to order, viewer and filter", async () => {
    await seed();
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await listOrderActivity(ctx, staff, { orderPublicId: ORDER_A, limit: 2, cursor });
      if (page.view !== "staff") throw new Error("expected staff view");
      seen.push(...page.items.map((i) => i.eventId));
      if (page.nextCursor) for (const id of page.items.map((i) => i.eventId)) expect(Buffer.from(page.nextCursor, "base64url").toString("utf8")).not.toContain(id);
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(9);
    expect(new Set(seen).size).toBe(9);

    const p1 = await listOrderActivity(ctx, owner, { orderPublicId: ORDER_A, limit: 1 });
    expect(p1.nextCursor).toBeTruthy();
    await expect(listOrderActivity(ctx, sharer, { orderPublicId: ORDER_A, limit: 1, cursor: p1.nextCursor })).rejects.toMatchObject({ reasonCode: "CURSOR_INVALID" });
    await expect(listOrderActivity(ctx, owner, { orderPublicId: ORDER_A, limit: 1, cursor: p1.nextCursor, category: "files" })).rejects.toMatchObject({ reasonCode: "CURSOR_INVALID" });
    const s1 = await listOrderActivity(ctx, staff, { orderPublicId: ORDER_A, limit: 1 });
    await expect(listOrderActivity(ctx, staff, { orderPublicId: ORDER_B, limit: 1, cursor: s1.nextCursor })).rejects.toMatchObject({ reasonCode: "CURSOR_INVALID" });
    await expect(listOrderActivity(ctx, staff, { orderPublicId: ORDER_A, cursor: "bm90LWEtY3Vyc29y" })).rejects.toMatchObject({ reasonCode: "CURSOR_INVALID" });
  });

  it("filters by category; customers get nothing for staff-only categories", async () => {
    await seed();
    const files = await listOrderActivity(ctx, staff, { orderPublicId: ORDER_A, category: "files" });
    expect(files.items).toHaveLength(3);
    const other = await listOrderActivity(ctx, staff, { orderPublicId: ORDER_A, category: "other" });
    expect(other.items.map((i) => i.label)).toEqual(["order.mystery.thing"]);
    expect((await listOrderActivity(ctx, owner, { orderPublicId: ORDER_A, category: "production" })).items).toEqual([]);
    expect((await listOrderActivity(ctx, owner, { orderPublicId: ORDER_A, category: "other" })).items).toEqual([]);
  });

  it("cross-customer probe: a customer without access gets NOT_FOUND for the order", async () => {
    await seed();
    await expect(listOrderActivity(ctx, outsider, { orderPublicId: ORDER_A })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(listOrderActivity(ctx, owner, { orderPublicId: ORDER_B })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("hash chain: old envelopes keep their bytes; order_public_id is covered when set", async () => {
    await seed();
    const rows = await t.db.select().from(auditEvents);
    const env = rowToEnvelope(rows.find((r) => r.orderPublicId !== null)!);
    const legacy = { ...env, order_public_id: null };
    const { order_public_id: _dropped, ...withoutField } = env;
    expect(canonicalBytes(legacy)).toBe(canonicalBytes(withoutField as typeof env));
    expect(canonicalBytes(env)).not.toBe(canonicalBytes(legacy));
    expect(await ctx.chain.sealPending()).toMatchObject({ sealed: rows.length });
    expect(await ctx.chain.verify()).toMatchObject({ ok: true });
    await t.db.update(auditEvents).set({ orderPublicId: ORDER_B }).where(eq(auditEvents.eventId, env.event_id));
    expect(await ctx.chain.verify()).toMatchObject({ ok: false });
  });

  it("classifies exact customer entries before their wildcard", () => {
    expect(classifyOrderEvent("payment.refund.succeeded")).toMatchObject({ customer: true });
    expect(classifyOrderEvent("payment.refund.failed")).toMatchObject({ customer: false });
    expect(classifyOrderEvent("order.acceptance.recorded")).toMatchObject({ customer: true });
    expect(classifyOrderEvent("unrelated.event")).toBeNull();
  });
});
