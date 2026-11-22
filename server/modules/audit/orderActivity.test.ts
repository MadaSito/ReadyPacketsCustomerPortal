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
import { classifyOrderEvent, humanizeEventName, listOrderActivity, listOrderStatusHistory } from "./orderActivity.js";
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
const at = (m: number) => new Date(Date.UTC(2026, 10, 19, 9, m));
const TRANSITIONS = [
  { id: 4, at: at(40), from: "review", to: "done", note: "Staff-only synthetic note", internal: true, actor: staff.userId, role: "staff" as const },
  { id: 3, at: at(30), from: "draft", to: "review", note: "Customer synthetic note", internal: false, actor: owner.userId, role: "customer" as const },
  { id: 2, at: at(20), from: "new", to: "draft", note: null, internal: false, actor: null, role: "system" as const },
  { id: 1, at: at(10), from: null, to: "new", note: null, internal: false, actor: sharer.userId, role: "customer" as const },
];
/** Ids newest first; id 3 ties with transition id 3 (at 30) to exercise the deterministic tie order. */
const RENAMES = [
  { id: 3, at: at(30), oldName: "Synthetic name B", newName: "Synthetic name C" },
  { id: 2, at: at(25), oldName: "Synthetic name A", newName: "Synthetic name B" },
  { id: 1, at: at(5), oldName: "Synthetic name 0", newName: "Synthetic name A" },
];

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
        return { id: orderPublicId === ORDER_A ? 1 : 2, publicId: orderPublicId };
      },
      listStatusTransitions: async (orderId: number, opts: { cursor?: string | null; limit: number; customerView: boolean }) => {
        const all = TRANSITIONS.filter((x) => orderId === 1 && (opts.cursor ? x.id < Number(opts.cursor) : true));
        const page = all.slice(0, opts.limit);
        return {
          items: page.map((x) => ({ at: x.at, from: x.from, fromLabel: x.from, to: x.to, toLabel: x.to, note: opts.customerView && x.internal ? null : x.note, actorUserId: x.actor, actorRole: x.role })),
          nextCursor: all.length > opts.limit ? String(page[page.length - 1]!.id) : null,
        };
      },
      listNameHistory: async (orderId: number, opts: { cursor?: string | null; limit: number; customerView: boolean }) => {
        const all = RENAMES.filter((x) => orderId === 1 && (opts.cursor ? x.id < Number(opts.cursor) : true));
        const page = all.slice(0, opts.limit);
        return {
          items: page.map((x) => ({ at: x.at, oldName: x.oldName, newName: x.newName, actorUserId: opts.customerView ? null : staff.userId, actorRole: "staff" as const })),
          nextCursor: all.length > opts.limit ? String(page[page.length - 1]!.id) : null,
        };
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
    expect(byName["order.mystery.thing:completed"]).toMatchObject({ category: "other", label: "Order mystery thing" });
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
    expect(other.items.map((i) => i.label)).toEqual(["Order mystery thing"]);
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

  it("status lane: customers get generic renames, no staff identity and no internal notes; staff see names", async () => {
    const page = await listOrderStatusHistory(ctx, owner, { orderPublicId: ORDER_A });
    expect(page.items.map((i) => [i.kind, i.actor, i.to ?? null])).toEqual([
      ["transition", "ReadyPackets staff", "done"],
      ["transition", "You", "review"],
      ["rename", "ReadyPackets staff", null],
      ["rename", "ReadyPackets staff", null],
      ["transition", "ReadyPackets", "draft"],
      ["transition", "Someone with access to this order", "new"],
      ["rename", "ReadyPackets staff", null],
    ]);
    const json = JSON.stringify(page);
    for (const leak of [STAFF_NAME, "Staff-only synthetic note", "Synthetic name", "oldName", "newName"]) expect(json).not.toContain(leak);
    const staffView = await listOrderStatusHistory(ctx, staff, { orderPublicId: ORDER_A });
    expect(staffView.items[0]).toMatchObject({ actor: STAFF_NAME, note: "Staff-only synthetic note" });
    expect(staffView.items.filter((i) => i.kind === "rename").map((i) => `${i.oldName} -> ${i.newName}`)).toEqual([
      "Synthetic name B -> Synthetic name C", "Synthetic name A -> Synthetic name B", "Synthetic name 0 -> Synthetic name A",
    ]);
    await expect(listOrderStatusHistory(ctx, outsider, { orderPublicId: ORDER_A })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it.each([1, 2, 3, 50])("status lane keyset merge at limit %i returns every entry once in deterministic order", async (limit) => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await listOrderStatusHistory(ctx, staff, { orderPublicId: ORDER_A, limit, cursor });
      expect(page.items.length).toBeLessThanOrEqual(limit);
      seen.push(...page.items.map((i) => (i.kind === "transition" ? `t:${i.to}` : `r:${i.newName}`)));
      if (page.nextCursor) expect(Buffer.from(page.nextCursor, "base64url").toString("utf8")).not.toMatch(/"c"|review|2026/u);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 20);
    expect(seen).toEqual(["t:done", "t:review", "r:Synthetic name C", "r:Synthetic name B", "t:draft", "t:new", "r:Synthetic name A"]);
  });

  it("status lane cursor is bound to the reader and view", async () => {
    const first = await listOrderStatusHistory(ctx, owner, { orderPublicId: ORDER_A, limit: 1 });
    expect(first.nextCursor).not.toBeNull();
    await expect(listOrderStatusHistory(ctx, sharer, { orderPublicId: ORDER_A, limit: 1, cursor: first.nextCursor })).rejects.toMatchObject({ reasonCode: "CURSOR_INVALID" });
    await expect(listOrderStatusHistory(ctx, staff, { orderPublicId: ORDER_A, limit: 1, cursor: first.nextCursor })).rejects.toMatchObject({ reasonCode: "CURSOR_INVALID" });
    await expect(listOrderStatusHistory(ctx, owner, { orderPublicId: ORDER_A, limit: 1, cursor: "AAAA" })).rejects.toMatchObject({ reasonCode: "CURSOR_INVALID" });
  });

  it("invoice and payment events get friendly labels in Payments; unknown ones are humanised", async () => {
    const names = ["invoice.created", "invoice.issued", "invoice.payment.recorded", "invoice.refund.recorded", "invoice.voided", "invoice.refund.refused", "invoice.brand_new.thing"];
    for (const eventName of names) await emit(staff, { eventName, outcome: "completed", resource: { type: "invoice", publicId: "inv_synthetic_0001" }, attributes: { order_public_id: ORDER_A } });
    const page = await staffPage({ orderPublicId: ORDER_A, category: "payments" });
    expect(page.items.map((i) => i.label).sort()).toEqual(
      ["Invoice created", "Invoice issued", "Payment recorded", "Refund recorded", "Invoice voided", "Refund refused", "Invoice brand new thing"].sort(),
    );
    expect(page.items.every((i) => i.category === "payments")).toBe(true);
    expect((await listOrderActivity(ctx, staff, { orderPublicId: ORDER_A, category: "other" })).items).toEqual([]);
    const customer = await listOrderActivity(ctx, owner, { orderPublicId: ORDER_A, category: "payments" });
    expect(customer.items.map((i) => i.label).sort()).toEqual(["Invoice issued", "Invoice voided", "Payment recorded", "Refund recorded"]);
    expect(humanizeEventName("invoice.refund.recorded")).toBe("Invoice refund recorded");
    expect(humanizeEventName("payment.provider_event.x")).toBe("Payment provider event x");
  });

  it("classifies exact customer entries before their wildcard", () => {
    expect(classifyOrderEvent("payment.refund.succeeded")).toMatchObject({ customer: true });
    expect(classifyOrderEvent("payment.refund.failed")).toMatchObject({ customer: false });
    expect(classifyOrderEvent("order.acceptance.recorded")).toMatchObject({ customer: true });
    expect(classifyOrderEvent("unrelated.event")).toBeNull();
  });
});
