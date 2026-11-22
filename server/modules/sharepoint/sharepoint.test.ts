/**
 * SharePoint order-data sync against LOCAL FAKES ONLY: FakeGraph (protocol fake), fake storage connections,
 * orders and identity, and the local dev MySQL test database. Never run against a real tenant.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDeps, fakePrincipal, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { DomainError } from "../../core/errors.js";
import type { SessionPrincipal, Tx } from "../../core/types.js";
import { FakeGraph } from "../storage/adapters/graphDriveFake.js";
import { storageCopyAttempts } from "../storage/schema.js";
import { LIST_COLUMNS, ORDER_ID_COLUMN, buildOrderFields, fieldsHash, isCompatible, packetsSummary, safeText, toMajor, validListName } from "./fields.js";
import { createSharepointModule, type SharepointModule } from "./index.js";
import { sharepointOrderSync, sharepointSyncConfig } from "./schema.js";
import { BACKFILL_JOB, SYNC_JOB } from "./service.js";

const CONN = "01JCONN0000000000000000001";
const ORDER = "01JORDER000000000000000001";
const TENANT = "33333333-3333-4333-8333-333333333333";
const CLIENT = "44444444-4444-4444-8444-444444444444";

let db: TestDb;
let h: TestHarness;
let graph: FakeGraph;
let mod: SharepointModule;
let admin: SessionPrincipal;
let assigned: boolean;
let destinationVersion: number;
let orderStatus: string;
let duringView: (() => Promise<void>) | null;
let enabledListId: string | null;
let renamedAt: Date | null;
let listeners: ((e: { orderId: number; orderPublicId: string; kind: string }, tx: Tx) => Promise<void>)[];

const orderView = () => ({
  publicId: ORDER,
  reference: "RP-2026-0001",
  status: { key: "s", label: orderStatus, kind: "active" as const },
  ownerUserId: 7,
  items: [{ packetNumber: 3, tier: "gold", name: "Packet" }],
  currency: "USD",
  subtotalMinor: 12345,
  discountMinor: 345,
  totalMinor: 12000,
  createdAt: new Date("2026-11-01T10:00:00Z"),
  submittedAt: null,
  closedAt: null,
  updatedAt: renamedAt ?? new Date("2026-11-02T10:00:00Z"),
});

beforeAll(async () => {
  db = await createTestDb({ schema: { sharepointSyncConfig, sharepointOrderSync, storageCopyAttempts } });
});
afterAll(() => db?.cleanup());

beforeEach(async () => {
  for (const t of [sharepointOrderSync, sharepointSyncConfig, storageCopyAttempts]) await db.db.delete(t);
  h = createTestDeps({ db: db.db });
  graph = new FakeGraph();
  admin = fakePrincipal({ role: "admin", stepUpAt: h.clock.now() });
  assigned = true;
  destinationVersion = 1;
  orderStatus = "In progress";
  listeners = [];
  renamedAt = null;
  duringView = null;
  enabledListId = null;
  const config = { tenantId: TENANT, clientId: CLIENT, siteUrl: "https://contoso.sharepoint.com/sites/Orders", siteId: graph.site.id, driveId: "", driveName: "", rootFolderPath: "" };
  h.services.identity = {
    sessions: { assertCurrent: async (p: SessionPrincipal) => ({ role: p.role, stepUpAt: p.stepUpAt, pendingSteps: [] }) },
    getUser: async () => ({ customerRef: "RPCUS-ABC123XYZ" }),
  } as never;
  h.services.orders = {
    registerChangeListener: (l: (typeof listeners)[number]) => void listeners.push(l),
    getOrderSyncView: async (id: string) => {
      const rendered = id === ORDER ? orderView() : null; // rendered before concurrent changes land
      await duringView?.();
      return rendered;
    },
  } as never;
  h.services.storageConnections = {
    registerAdapter: () => undefined,
    listAssigned: async () => (assigned ? [{ purpose: "order_data", connectionPublicId: CONN, kind: "sharepoint", name: "Orders site", destinationVersion }] : []),
    readAssignedProvider: async (input: { assertStillOwned: () => Promise<void> }) => {
      await input.assertStillOwned();
      if (!assigned) throw new DomainError("NOT_CONFIGURED", "STORAGE_NOT_ASSIGNED", "x");
      return { config, credentials: { clientSecret: graph.validSecret } };
    },
    readProviderSetup: async () => ({ config, credentials: { clientSecret: graph.validSecret } }),
    connections: { get: async () => ({ publicId: CONN, version: 2, name: "Orders site", config }) },
  } as never;
  mod = createSharepointModule(h.deps, { port: graph });
  h.services.sharepoint = mod;
  mod.init?.();
});

const changeOrder = () => db.db.transaction((tx) => listeners[0]!({ orderId: 1, orderPublicId: ORDER, kind: "updated" }, tx));
const copyRows = async () => (await db.db.select().from(storageCopyAttempts)).sort((a, b) => a.id - b.id);
const items = () => (enabledListId ? graph.site.lists.get(enabledListId)?.items : undefined) ?? new Map();

async function enable() {
  const { listId } = await mod.orderSync.createList(admin, { displayName: "Portal orders" });
  enabledListId = listId;
  return mod.orderSync.update(admin, { expectedVersion: 0, enabled: true, listId, listLabel: "Portal orders", includePortalLink: true });
}

describe("field mapping", () => {
  it("builds the minimal field set without names or email", () => {
    const fields = buildOrderFields(orderView(), { customerReference: "RPCUS-ABC123XYZ", portalLink: null });
    expect(Object.keys(fields).sort()).toEqual(["Title", ...LIST_COLUMNS.map((c) => c.name)].sort());
    expect(fields).toMatchObject({ Title: "RP-2026-0001", RpOrderId: ORDER, RpSubtotal: 123.45, RpTotal: 120, RpPackets: "#3 gold", RpPortalLink: null });
    expect(fieldsHash(fields)).toBe(fieldsHash({ ...fields }));
    expect(toMajor(500, "JPY")).toBe(500);
    expect(toMajor(1234, "KWD")).toBe(1.234);
    expect(safeText("a\u202eb\u0000c")).toBe("abc");
    expect(packetsSummary(Array.from({ length: 45 }, (_, i) => ({ packetNumber: i, tier: null, name: "x" })))).toMatch(/\+5$/u);
    expect(validListName("Portal orders")).toBe(true);
    expect(validListName("a/b")).toBe(false);
    expect(isCompatible([{ name: ORDER_ID_COLUMN, text: {} }])).toBe(false);
  });
});

describe("sharepoint order sync (local fakes only)", () => {
  it("dispatches a newer version whose own job exhausted against the busy claim", async () => {
    await enable();
    await changeOrder(); // v1
    const handler = h.jobs.handlers.get(SYNC_JOB)!;
    let blocked = 0;
    duringView = async () => {
      duringView = null;
      orderStatus = "Delivered";
      await changeOrder(); // v2 staged while v1 is rendering/writing
      const v2 = h.jobs.enqueued.find((j) => j.options?.idempotencyKey === `sharepoint:order:${ORDER}:v2`)!;
      for (let attempt = 1; attempt <= 6; attempt += 1) {
        const r = await handler({ jobId: v2.jobId, type: SYNC_JOB, payload: v2.payload as never, attempt, fencingToken: 1, correlationId: "c", signal: new AbortController().signal, assertStillOwned: async () => {} });
        if (r.outcome === "failed" && r.reasonCode === "SHAREPOINT_SYNC_BUSY") blocked += 1;
      }
      h.jobs.enqueued = h.jobs.enqueued.filter((j) => j !== v2); // exhausted: the queue will never run it again
    };
    expect(await h.jobs.runAll(SYNC_JOB)).toEqual([{ outcome: "completed", safeCounts: { created: 1 } }]);
    expect(blocked).toBe(6);
    expect((await db.db.select().from(sharepointOrderSync))[0]).toMatchObject({ syncedVersion: 1, desiredVersion: 2, state: "pending", claimToken: null });
    expect(h.jobs.enqueued.map((j) => j.options?.idempotencyKey)).toEqual([expect.stringMatching(new RegExp(`^sharepoint:order:${ORDER}:v2:after:`, "u"))]);
    expect(await h.jobs.runAll(SYNC_JOB)).toEqual([{ outcome: "completed", safeCounts: { updated: 1 } }]);
    expect(items().size).toBe(1);
    expect((await db.db.select().from(sharepointOrderSync))[0]).toMatchObject({ syncedVersion: 2, state: "synced" });
    expect(h.jobs.enqueued).toHaveLength(0); // caught up: no further follow-up
  });

  it("a retryable failure on the final attempt still dispatches a newer staged version", async () => {
    await enable();
    await changeOrder(); // v1
    duringView = async () => {
      duringView = null;
      await changeOrder(); // v2 staged (its job may later exhaust against the claim)
      h.jobs.enqueued = h.jobs.enqueued.filter((j) => j.options?.idempotencyKey !== `sharepoint:order:${ORDER}:v2`);
    };
    graph.intercept(({ method }) => (method === "POST" ? { status: 503, headers: {}, body: {} } : undefined));
    expect(await h.jobs.runAll(SYNC_JOB)).toEqual([{ outcome: "failed", reasonCode: "SHAREPOINT_PROVIDER_UNAVAILABLE", retryable: true }]);
    expect(h.jobs.enqueued.map((j) => j.options?.idempotencyKey)).toEqual([expect.stringMatching(new RegExp(`^sharepoint:order:${ORDER}:v2:after:`, "u"))]);
  });

  it("cancels a backfill when its settings or destination scope changes after a page was read", async () => {
    await enable();
    const second = "01JORDER000000000000000002";
    let onList: (() => Promise<void>) | null = null;
    (h.services.orders as unknown as Record<string, unknown>).listOrderPublicIdsForSync = async () => {
      await onList?.();
      return { publicIds: [ORDER, second], nextAfter: null };
    };
    // Destination generation change after the page read.
    await mod.orderSync.backfill(admin);
    onList = async () => void (destinationVersion += 1);
    expect(await h.jobs.runAll(BACKFILL_JOB)).toEqual([{ outcome: "canceled", reasonCode: "SHAREPOINT_BACKFILL_SCOPE_CHANGED" }]);
    expect(h.jobs.enqueued).toHaveLength(0);
    expect((await mod.orderSync.get(admin)).backfill).toMatchObject({ state: "failed", reasonCode: "SHAREPOINT_BACKFILL_SCOPE_CHANGED", enqueued: 0 });
    expect(await db.db.select().from(sharepointOrderSync)).toHaveLength(0);

    // Settings change (disable) while running ends the run; re-enabling does not silently resume it.
    onList = null;
    await mod.orderSync.backfill(admin);
    const view = await mod.orderSync.get(admin);
    onList = async () => {
      onList = null;
      await mod.orderSync.update(admin, { expectedVersion: view.version, enabled: false, listId: view.listId, listLabel: null, includePortalLink: true });
    };
    expect(await h.jobs.runAll(BACKFILL_JOB)).toEqual([{ outcome: "canceled", reasonCode: "SHAREPOINT_BACKFILL_SUPERSEDED" }]);
    expect(h.jobs.enqueued).toHaveLength(0);
    expect((await mod.orderSync.get(admin)).backfill).toMatchObject({ state: "failed", reasonCode: "SHAREPOINT_BACKFILL_SCOPE_CHANGED" });
    await expect(mod.orderSync.backfill(admin)).rejects.toMatchObject({ reasonCode: "SHAREPOINT_SYNC_DISABLED" });
  });

  it("does not dispatch already-staged bulk jobs after the destination scope changes", async () => {
    await enable();
    (h.services.orders as unknown as Record<string, unknown>).listOrderPublicIdsForSync = async () => ({ publicIds: [ORDER], nextAfter: null });
    await mod.orderSync.backfill(admin);
    expect(await h.jobs.runAll(BACKFILL_JOB)).toEqual([{ outcome: "completed", safeCounts: { enqueued: 1 } }]);
    expect((await mod.orderSync.get(admin)).backfill).toMatchObject({ state: "completed", enqueued: 1 });
    const writes = graph.calls.filter((c) => c.method !== "GET").length;
    destinationVersion += 1; // administrator re-points the destination before the bulk jobs drain
    expect(await h.jobs.runAll(SYNC_JOB)).toEqual([{ outcome: "canceled", reasonCode: "SHAREPOINT_BACKFILL_SCOPE_CHANGED" }]);
    expect(items().size).toBe(0);
    expect(graph.calls.filter((c) => c.method !== "GET")).toHaveLength(writes);
    expect((await db.db.select().from(sharepointOrderSync))[0]).toMatchObject({ state: "failed", reasonCode: "SHAREPOINT_BACKFILL_SCOPE_CHANGED", claimToken: null });
    // An ordinary order change afterwards follows the current settings.
    await changeOrder();
    expect(await h.jobs.runAll(SYNC_JOB)).toEqual([{ outcome: "completed", safeCounts: { created: 1 } }]);
  });

  it("backfills existing orders in resumable bounded batches without duplicating list items", async () => {
    const all = [ORDER, "01JORDER000000000000000002", "01JORDER000000000000000003", "01JORDER000000000000000004", "01JORDER000000000000000005"];
    await expect(mod.orderSync.backfill(admin)).rejects.toMatchObject({ reasonCode: "SHAREPOINT_SYNC_DISABLED" });
    await enable();
    await expect(mod.orderSync.backfill(fakePrincipal({ role: "admin", stepUpAt: null }))).rejects.toBeInstanceOf(DomainError);

    // Orders listing port absent → fails closed, progress kept.
    let view = await mod.orderSync.backfill(admin);
    expect(view.backfill).toMatchObject({ state: "running", enqueued: 0 });
    expect(await h.jobs.runAll(BACKFILL_JOB)).toEqual([{ outcome: "failed", reasonCode: "ORDERS_LISTING_UNAVAILABLE", retryable: false }]);
    expect((await mod.orderSync.get(admin)).backfill).toMatchObject({ state: "failed", reasonCode: "ORDERS_LISTING_UNAVAILABLE" });

    const pages: (string | null)[] = [];
    (h.services.orders as unknown as Record<string, unknown>).listOrderPublicIdsForSync = async (input: { afterPublicId: string | null; limit: number }) => {
      pages.push(input.afterPublicId);
      const rest = all.filter((id) => input.afterPublicId === null || id > input.afterPublicId).slice(0, Math.min(2, input.limit));
      const last = rest[rest.length - 1];
      return { publicIds: rest, nextAfter: last && last !== all[all.length - 1] ? last : null };
    };
    await mod.orderSync.backfill(admin); // resume
    for (let i = 0; i < 5 && h.jobs.enqueued.some((j) => j.type === BACKFILL_JOB); i += 1) await h.jobs.runAll(BACKFILL_JOB);
    expect(pages).toEqual([null, all[1], all[3]]);
    view = await mod.orderSync.get(admin);
    expect(view.backfill).toMatchObject({ state: "completed", enqueued: 5 });
    expect(h.jobs.enqueued.filter((j) => j.type === SYNC_JOB)).toHaveLength(5);
    await h.jobs.runAll(SYNC_JOB);
    expect(items().size).toBe(1); // only ORDER exists in the fake orders module

    // A replayed batch job for an advanced cursor writes nothing.
    await mod.orderSync.backfill(admin, { restart: true });
    const first = h.jobs.enqueued.find((j) => j.type === BACKFILL_JOB)!;
    await h.jobs.runAll(BACKFILL_JOB);
    const replay = await h.jobs.handlers.get(BACKFILL_JOB)!({ jobId: first.jobId, type: BACKFILL_JOB, payload: first.payload as never, attempt: 2, fencingToken: 1, correlationId: "c", signal: new AbortController().signal, assertStillOwned: async () => {} });
    expect(replay).toEqual({ outcome: "canceled", reasonCode: "SHAREPOINT_BACKFILL_SUPERSEDED" });
    for (let i = 0; i < 5 && h.jobs.enqueued.some((j) => j.type === BACKFILL_JOB); i += 1) await h.jobs.runAll(BACKFILL_JOB);
    await h.jobs.runAll(SYNC_JOB);
    expect(items().size).toBe(1);
    expect((await mod.orderSync.get(admin)).backfill).toMatchObject({ state: "completed", enqueued: 5 });
    const events = h.audit.events.map((e) => e.eventName);
    expect(events).toEqual(expect.arrayContaining(["sharepoint.sync.backfill_started", "sharepoint.sync.backfill_resumed", "sharepoint.sync.backfill_finished"]));
  });

  it("ships disabled: order changes stage nothing", async () => {
    await changeOrder();
    expect(h.jobs.enqueued).toHaveLength(0);
    expect(await db.db.select().from(sharepointOrderSync)).toHaveLength(0);
    expect((await mod.orderSync.get(admin)).state).toBe("disabled");
  });

  it("creates a compatible list, refuses enabling an incompatible one, then syncs idempotently by order id", async () => {
    graph.site.lists.set("bad", { id: "bad", displayName: "Other", columns: [], items: new Map() });
    await expect(mod.orderSync.update(admin, { expectedVersion: 0, enabled: true, listId: "bad", listLabel: null, includePortalLink: false })).rejects.toMatchObject({ reasonCode: "SHAREPOINT_TEST_LIST_INCOMPATIBLE" });
    const view = await enable();
    expect(view).toMatchObject({ enabled: true, state: "ready", siteLabel: "Orders site" });
    const lists = (await mod.orderSync.listLists(admin)).lists;
    expect(lists.find((l) => l.listId === "bad")?.compatible).toBe(false);
    expect(lists.find((l) => l.listId === view.listId)?.compatible).toBe(true);

    await changeOrder();
    expect(h.jobs.enqueued.map((j) => j.options?.idempotencyKey)).toEqual([`sharepoint:order:${ORDER}:v1`]);
    expect(await h.jobs.runAll(SYNC_JOB)).toEqual([{ outcome: "completed", safeCounts: { created: 1 } }]);
    expect(items().size).toBe(1);
    const item = [...items().values()][0]!;
    expect(item.fields).toMatchObject({ Title: "RP-2026-0001", RpOrderId: ORDER, RpStatus: "In progress", RpCustomerRef: "RPCUS-ABC123XYZ" });
    expect(String(item.fields.RpPortalLink)).toMatch(new RegExp(`/orders/${ORDER}$`, "u"));

    orderStatus = "Delivered";
    await changeOrder();
    expect(await h.jobs.runAll(SYNC_JOB)).toEqual([{ outcome: "completed", safeCounts: { updated: 1 } }]);
    expect(items().size).toBe(1);
    expect([...items().values()][0]!.fields.RpStatus).toBe("Delivered");

    await changeOrder(); // same content → no write
    const writesBefore = graph.calls.filter((c) => c.method !== "GET").length;
    expect(await h.jobs.runAll(SYNC_JOB)).toEqual([{ outcome: "completed", safeCounts: { unchanged: 1 } }]);
    expect(graph.calls.filter((c) => c.method !== "GET").length).toBe(writesBefore);
    const [row] = await db.db.select().from(sharepointOrderSync);
    expect(row).toMatchObject({ state: "synced", desiredVersion: 3, syncedVersion: 3 });

    // Copy log (package R): one row per job attempt, marker-only readback is "written", never "verified".
    const log = await copyRows();
    expect(log.map((r) => [r.kind, r.sourcePublicId, r.connectionPublicId, r.attempt, r.state, r.verification])).toEqual([
      ["sharepoint_order", ORDER, CONN, 1, "written", null],
      ["sharepoint_order", ORDER, CONN, 1, "written", null],
      ["sharepoint_order", ORDER, CONN, 1, "not_written", null],
    ]);
    expect(log.every((r) => r.startedAt && r.finishedAt && r.errorCode === null)).toBe(true);
    expect(JSON.stringify(log)).not.toMatch(/contoso|Portal orders|RP-2026|item/iu);
  });

  it("a renamed order (B2: updatedAt bump + \"updated\" event) updates its list row", async () => {
    await enable();
    await changeOrder();
    await h.jobs.runAll(SYNC_JOB);
    const before = { ...[...items().values()][0]!.fields };
    // orders.console.rename sets updatedAt and emits { kind: "updated" } in the rename tx (orders_engineer).
    renamedAt = new Date("2026-11-03T09:30:00Z");
    await changeOrder();
    expect(await h.jobs.runAll(SYNC_JOB)).toEqual([{ outcome: "completed", safeCounts: { updated: 1 } }]);
    expect(items().size).toBe(1);
    const after = [...items().values()][0]!.fields;
    expect(after.RpUpdatedAt).not.toBe(before.RpUpdatedAt);
    expect({ ...after, RpUpdatedAt: null }).toEqual({ ...before, RpUpdatedAt: null }); // reference/Title unchanged
  });

  it("finds an existing item by order id when the local remote id was lost (no duplicate)", async () => {
    await enable();
    await changeOrder();
    await h.jobs.runAll(SYNC_JOB);
    await db.db.update(sharepointOrderSync).set({ remoteItemId: null, contentHash: null });
    orderStatus = "Closed";
    await changeOrder();
    expect(await h.jobs.runAll(SYNC_JOB)).toEqual([{ outcome: "completed", safeCounts: { updated: 1 } }]);
    expect(items().size).toBe(1);
  });

  it("serialises concurrent jobs for different versions of one order (single item)", async () => {
    await enable();
    await changeOrder();
    orderStatus = "Delivered";
    await changeOrder();
    const handler = h.jobs.handlers.get(SYNC_JOB)!;
    const run = (jobId: string) =>
      handler({ jobId, type: SYNC_JOB, payload: { orderPublicId: ORDER } as never, attempt: 1, fencingToken: 1, correlationId: "c", signal: new AbortController().signal, assertStillOwned: async () => {} });
    const results = await Promise.all([run("job_a"), run("job_b")]);
    expect(items().size).toBe(1);
    expect(results.filter((r) => r.outcome === "completed").length).toBeGreaterThanOrEqual(1);
    for (const r of results) if (r.outcome !== "completed") expect(r).toMatchObject({ reasonCode: "SHAREPOINT_SYNC_BUSY", retryable: true });
  });

  it("honours a live claim, reclaims an expired one and never regresses the synced version", async () => {
    await enable();
    await changeOrder();
    const live = new Date(h.clock.now().getTime() + 60_000);
    await db.db.update(sharepointOrderSync).set({ claimJobId: "job_other", claimToken: "01JCLAIM000000000000000001", claimedUntil: live });
    expect(await h.jobs.runAll(SYNC_JOB)).toEqual([{ outcome: "failed", reasonCode: "SHAREPOINT_SYNC_BUSY", retryable: true }]);
    expect(items().size).toBe(0);
    await db.db.update(sharepointOrderSync).set({ claimedUntil: new Date(h.clock.now().getTime() - 1) });
    await changeOrder();
    expect(await h.jobs.runAll(SYNC_JOB)).toEqual([{ outcome: "completed", safeCounts: { created: 1 } }]);
    // A stale job for an older version arriving after v2 completed finds the row caught up and writes nothing.
    const writes = graph.calls.filter((c) => c.method !== "GET").length;
    const handler = h.jobs.handlers.get(SYNC_JOB)!;
    const stale = await handler({ jobId: "job_stale", type: SYNC_JOB, payload: { orderPublicId: ORDER } as never, attempt: 1, fencingToken: 1, correlationId: "c", signal: new AbortController().signal, assertStillOwned: async () => {} });
    expect(stale).toEqual({ outcome: "completed", safeCounts: { unchanged: 1 } });
    expect(graph.calls.filter((c) => c.method !== "GET").length).toBe(writes);
    const [row] = await db.db.select().from(sharepointOrderSync);
    expect(row).toMatchObject({ syncedVersion: 2, desiredVersion: 2, claimToken: null, state: "synced" });
  });

  it("reads back and updates when the unique order-id column refuses a second create", async () => {
    await enable();
    await changeOrder();
    await h.jobs.runAll(SYNC_JOB);
    await db.db.update(sharepointOrderSync).set({ remoteItemId: null, contentHash: null });
    let hidden = false;
    graph.intercept(({ method, path }) => {
      if (method === "GET" && path.endsWith("/items") && !hidden) {
        hidden = true; // a lagging index: the first lookup misses the existing item
        return { status: 200, headers: {}, body: { value: [] } };
      }
      return undefined;
    });
    orderStatus = "Closed";
    await changeOrder();
    expect(await h.jobs.runAll(SYNC_JOB)).toEqual([{ outcome: "completed", safeCounts: { updated: 1 } }]);
    expect(items().size).toBe(1);
    expect([...items().values()][0]!.fields.RpStatus).toBe("Closed");
  });

  it("does not send fields rendered under settings that changed before dispatch", async () => {
    await enable();
    await changeOrder();
    duringView = async () => {
      duringView = null;
      await db.db.update(sharepointSyncConfig).set({ includePortalLink: false, version: 2 });
    };
    const [result] = await h.jobs.runAll(SYNC_JOB);
    expect(result).toMatchObject({ outcome: "failed", reasonCode: "SHAREPOINT_NOT_CONFIGURED" });
    expect(items().size).toBe(0);
  });

  it("rechecks revocation before writing and never writes after unassignment", async () => {
    await enable();
    await changeOrder();
    assigned = false;
    const [result] = await h.jobs.runAll(SYNC_JOB);
    expect(result).toMatchObject({ outcome: "failed", reasonCode: "SHAREPOINT_NOT_CONFIGURED", retryable: false });
    expect(items().size).toBe(0);
  });

  it("stops when the destination generation changes between read and write", async () => {
    await enable();
    await changeOrder();
    let reads = 0;
    const original = h.services.storageConnections.listAssigned;
    h.services.storageConnections.listAssigned = (async (...args: Parameters<typeof original>) => {
      if (++reads > 1) destinationVersion = 2;
      return original(...args);
    }) as typeof original;
    const [result] = await h.jobs.runAll(SYNC_JOB);
    expect(result).toMatchObject({ outcome: "failed", reasonCode: "SHAREPOINT_DESTINATION_DENIED" });
    expect(items().size).toBe(0);
  });

  it("propagates a lost fence unchanged and records nothing as synced", async () => {
    await enable();
    await changeOrder();
    const job = h.jobs.enqueued[0]!;
    const handler = h.jobs.handlers.get(SYNC_JOB)!;
    let n = 0;
    const lost = new Error("lease lost");
    await expect(
      handler({ jobId: job.jobId, type: SYNC_JOB, payload: job.payload as never, attempt: 1, fencingToken: 1, correlationId: "c", signal: new AbortController().signal, assertStillOwned: async () => { if (++n > 1) throw lost; } }),
    ).rejects.toBe(lost);
    expect(items().size).toBe(0);
    const [row] = await db.db.select().from(sharepointOrderSync);
    expect(row?.state).toBe("pending");
  });

  it("maps provider failures to fixed retryable codes", async () => {
    await enable();
    await changeOrder();
    graph.intercept(({ method }) => (method === "POST" ? { status: 503, headers: {}, body: { error: { message: "secret" } } } : undefined));
    expect(await h.jobs.runAll(SYNC_JOB)).toEqual([{ outcome: "failed", reasonCode: "SHAREPOINT_PROVIDER_UNAVAILABLE", retryable: true }]);
    expect((await mod.orderSync.get(admin)).lastError?.reasonCode).toBe("SHAREPOINT_PROVIDER_UNAVAILABLE");
    const log = await copyRows();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ kind: "sharepoint_order", connectionPublicId: CONN, state: "failed", errorCode: "SHAREPOINT_PROVIDER_UNAVAILABLE" });
    expect(JSON.stringify(log)).not.toMatch(/secret/iu);
  });

  it("queues a copy-log row at staging and records nothing when no destination is assigned", async () => {
    await enable();
    await changeOrder();
    const [queued] = await copyRows();
    expect(queued).toMatchObject({ state: "queued", startedAt: null, attempt: 1, jobPublicId: h.jobs.enqueued[0]!.jobId });
    await db.db.delete(storageCopyAttempts);
    assigned = false;
    await changeOrder();
    await h.jobs.runAll(SYNC_JOB);
    expect(await copyRows()).toEqual([]);
  });

  it("refuses non-step-up administrators and audits the denial", async () => {
    const stale = fakePrincipal({ role: "admin", stepUpAt: null });
    await expect(mod.orderSync.get(stale)).rejects.toMatchObject({ code: "STEP_UP_REQUIRED" });
    expect(h.audit.events.some((e) => e.eventName === "sharepoint.admin.denied")).toBe(true);
  });

  it("discovers the site through the connection setup", async () => {
    const site = await mod.discovery.discoverSite(admin, { connectionPublicId: CONN, expectedVersion: 2, siteUrl: "https://contoso.sharepoint.com/sites/Orders" });
    expect(site.siteId).toBe(graph.site.id);
    await expect(mod.discovery.discoverSite(admin, { connectionPublicId: CONN, expectedVersion: 2, siteUrl: "https://evil.example/" })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("the automation action refuses staff-only triggers", async () => {
    await enable();
    const { syncOrderAction } = await import("./automation.js");
    expect(syncOrderAction.forbidOnStaffOnlyTrigger).toBe(true);
    const result = await syncOrderAction.run({ dryRun: false, staffOnlyTrigger: true, orderPublicId: ORDER, correlationId: "c", idempotencyKey: "k", assertStillOwned: async () => {}, deps: h.deps } as never);
    expect(result).toEqual({ outcome: "skipped", reasonCode: "SHAREPOINT_SYNC_STAFF_ONLY_TRIGGER" });
    expect(h.jobs.enqueued).toHaveLength(0);
  });

  it("the automation action queues only when enabled", async () => {
    expect(await mod.enqueueOrder(ORDER, { correlationId: "automation:r1", idempotencyKey: "auto:r1:step:step_1" })).toBe("disabled");
    await enable();
    expect(await mod.enqueueOrder(ORDER, { correlationId: "automation:r1", idempotencyKey: "auto:r1:step:step_1" })).toBe("queued");
    expect(h.jobs.enqueued[0]?.options).toMatchObject({ idempotencyKey: "auto:r1:step:step_1", correlationId: "automation:r1" });
    expect(await mod.enqueueOrder("01JORDER000000000000000009", { correlationId: "c", idempotencyKey: "k" })).toBe("order_not_found");
  });
});
