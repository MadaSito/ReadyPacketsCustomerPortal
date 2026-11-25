import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STAGE_FILE_SYNC, DEFAULT_STAGE_FOLDERS } from "../../../shared/orderStageFileSync.js";
import { createTestDeps, fakePrincipal, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { ulid } from "../../core/ids.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { SessionPrincipal } from "../../core/types.js";
import { createCallerFactory } from "../../trpc/trpc.js";
import { jobAttempts, jobRuns } from "../jobs/schema.js";
import { graphDriveDefinitions } from "./adapters/graphDrive.js";
import { FakeGraph } from "./adapters/graphDriveFake.js";
import { createStorageModule, type StorageModule } from "./index.js";
import { storageRouter } from "./router.js";
import { storageAssignments, storageConnections, storageCopyAttempts, storageFileCopies,
  storageManagedFileCopies, storageManagedOrderRoots } from "./schema.js";

let testDb: TestDb;
let h: TestHarness;
let storage: StorageModule;
let graph: FakeGraph;
let admin: SessionPrincipal;
let orderId: string;
let customerId: string;
let name: string;
let plan: { key: string; folders: typeof DEFAULT_STAGE_FOLDERS; fileSync: Record<keyof typeof DEFAULT_STAGE_FILE_SYNC, string | null> };
const copyJob = "storage.copy_managed_order_file";
const emit = vi.fn();
const resolve = vi.fn();
const tables = { storageAssignments, storageConnections, storageCopyAttempts, storageFileCopies,
  storageManagedFileCopies, storageManagedOrderRoots, jobAttempts, jobRuns };
let files: Map<string, Awaited<ReturnType<TestHarness["services"]["files"]["getOrderFileCopySource"]>>>;

beforeAll(async () => { testDb = await createTestDb({ schema: tables }); });
afterAll(async () => { await testDb?.cleanup(); });
beforeEach(async () => {
  for (const table of Object.values(tables)) await testDb.db.delete(table);
  h = createTestDeps({ db: testDb.db });
  storage = createStorageModule(h.deps);
  h.services.storageConnections = storage;
  graph = new FakeGraph();
  storage.registerAdapter("sharepoint", graphDriveDefinitions(graph).sharepoint);
  admin = fakePrincipal({ role: "admin", stepUpAt: h.clock.now() });
  h.services.identity = {
    sessions: { assertCurrent: async (p: SessionPrincipal) => ({ role: p.role, pendingSteps: [], stepUpAt: p.stepUpAt }) },
    getUser: async () => ({ id: 42, publicId: customerId, status: "active", name }),
  } as unknown as TestHarness["services"]["identity"];
  h.services.orders = {
    stages: { async getOrderStageFileSync() { return plan; } },
    async assertCanReadOrder() { return {}; },
    async getOrderRefByPublicId(publicId: string) {
      return publicId === orderId ? { ownerUserId: 42, lockState: "none", reference: "ORDER-101", publicId } : null;
    },
  } as unknown as TestHarness["services"]["orders"];
  h.services.files = {
    async getOrderFileCopySource(id: string) { return files.get(id); },
    async listOrderFileCopyMetadata(_id: string, ids: string[]) {
      return ids.flatMap((id) => {
        const file = files.get(id);
        return file ? [{ filePublicId: id, displayName: file.displayName, sourceAvailable: true }] : [];
      });
    },
  } as unknown as TestHarness["services"]["files"];
  h.services.opsAlerts = { emit, resolve } as unknown as TestHarness["services"]["opsAlerts"];
  h.services.compliance = {
    receipts: { async getFileSyncPdf() { return Buffer.from("%PDF synthetic immutable receipt"); } },
  } as unknown as TestHarness["services"]["compliance"];
  emit.mockClear(); resolve.mockClear();
  files = new Map();
  name = "Synthetic Customer";
  customerId = ulid();
  orderId = ulid();
  plan = { key: "intake", folders: DEFAULT_STAGE_FOLDERS, fileSync: { ...DEFAULT_STAGE_FILE_SYNC } };
});

function caller(session: SessionPrincipal | null) {
  return createCallerFactory(storageRouter)({ services: h.services, session, request: newRequestContext("test"),
    transport: { issue() {}, clear() {} } });
}

async function createEnabled(label: string, driveId = graph.libraryDrive.id) {
  const r = await storage.connections.create(admin, { kind: "sharepoint", name: label, config: {
    tenantId: "33333333-3333-4333-8333-333333333333", clientId: "44444444-4444-4444-8444-444444444444",
    siteUrl: graph.site.webUrl, siteId: graph.site.id, driveId, driveName: label, rootFolderPath: "",
  }, credentials: { clientSecret: graph.validSecret } });
  const tested = await storage.connections.test(admin, { publicId: r.publicId, expectedVersion: r.version });
  return storage.connections.update(admin, { publicId: r.publicId, expectedVersion: tested.version, enabled: true });
}

async function approve(mode: "phase_files" | "receipts" = "phase_files", driveId?: string) {
  const r = await createEnabled("Synthetic destination", driveId);
  const input = { publicId: r.publicId, expectedVersion: r.version };
  expect(await storage.fileSync.testTarget(admin, input, "test-target")).toEqual({ ok: true, code: "OK" });
  await storage.fileSync.setTarget(admin, { ...input, mode, confirm: true }, "approve-target");
  return r;
}

async function stage(opts: Partial<Awaited<ReturnType<TestHarness["services"]["files"]["getOrderFileCopySource"]>>> = {}) {
  const filePublicId = ulid();
  const saved = await h.storage.put(h.storage.newKey("files"), Buffer.from("synthetic phase file"));
  files.set(filePublicId, { filePublicId, customerName: name, customerPublicId: customerId, customerReference: "CUS-1",
    orderPublicId: orderId, orderReference: "ORDER-101", orderName: "Synthetic order", ownerUserId: 42,
    visibility: "customer_visible", currentVersion: true, contentType: "application/pdf", displayName: "Synthetic.pdf", extension: "pdf",
    statusKey: "paid", stageKey: "intake", slotKey: null, derivative: false, conversionState: null, createdAt: h.clock.now(),
    storageKey: saved.key, size: saved.size, sha256: saved.sha256, ...opts });
  await testDb.db.transaction((tx) => storage.stageOrderFile(filePublicId, tx, { orderPublicId: orderId }));
  return filePublicId;
}

describe("managed Microsoft 365 file sync", () => {
  it("fails closed on read-only credentials, requires explicit approval and contains destination options", async () => {
    const r = await createEnabled("Read only");
    const input = { publicId: r.publicId, expectedVersion: r.version };
    graph.intercept((req) => req.path.endsWith("/createUploadSession") ? { status: 403, headers: {}, body: {} } : undefined);
    await expect(storage.fileSync.testTarget(admin, input, "test-target")).resolves.toEqual({ ok: false, code: "DESTINATION_DENIED" });
    await expect(storage.fileSync.setTarget(admin, { ...input, mode: "phase_files", confirm: true }, "approve-target"))
      .rejects.toMatchObject({ reasonCode: "STORAGE_WRITE_TEST_REQUIRED" });
    expect(await storage.fileSync.listTargets(admin)).toEqual([]);
    await expect(caller(null).fileSync.listTargets()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller(fakePrincipal({ role: "staff" })).fileSync.listTargets()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(fakePrincipal({ role: "customer" })).fileSync.forOrder({ orderPublicId: orderId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(fakePrincipal({ role: "staff" })).fileSync.previewResync({ scope: "target", publicId: r.publicId }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("deduplicates multiple roles, keeps staff and pending audio out of intake, and freezes the order hierarchy", async () => {
    const r = await approve();
    plan.fileSync = { originals: r.publicId, conversionStaging: r.publicId, intakeDelivery: r.publicId };
    expect(graph.sessions.size).toBe(0);
    expect([...graph.libraryDrive.items.values()].filter((i) => !i.folder)).toHaveLength(0);
    const audio = { contentType: "audio/webm", extension: "webm" };
    const original = await stage({ ...audio, conversionState: "converting" });
    name = "Renamed Customer";
    const derivative = await stage({ ...audio, derivative: true });
    const staff = await stage({ ...audio, derivative: true, visibility: "staff_only" });
    await testDb.db.transaction((tx) => storage.stageOrderFile(derivative, tx, { orderPublicId: orderId }));
    const intents = await testDb.db.select().from(storageManagedFileCopies);
    expect(intents.filter((row) => row.sourcePublicId === original).map((row) => row.role)).toEqual(["originals"]);
    expect(intents.filter((row) => row.sourcePublicId === derivative).map((row) => row.role).sort()).toEqual(["conversionStaging", "intakeDelivery"]);
    expect(intents.filter((row) => row.sourcePublicId === staff).map((row) => row.role)).toEqual(["originals"]);
    expect(JSON.stringify(intents)).not.toContain("Synthetic Customer");
    expect(h.jobs.enqueued).toHaveLength(4);
    const results = await h.jobs.runAll(copyJob);
    expect(results.every((r) => r.outcome === "completed")).toBe(true);
    expect(graph.findByPath(graph.libraryDrive, [`Synthetic Customer-${customerId}`, "ORDER-101", "intake", "Audio"])).not.toBeNull();
    expect(graph.findByPath(graph.libraryDrive, [`Renamed Customer-${customerId}`])).toBeNull();
    expect(await storage.fileSync.health(admin)).toEqual([expect.objectContaining({ lastSuccessAt: h.clock.now(), backlog: 0, blocked: 0 })]);
    expect(await storage.fileSync.forOrder(admin, { orderPublicId: orderId })).toMatchObject({ items: expect.arrayContaining([
      expect.objectContaining({ sourcePublicId: staff, role: "originals", state: "copied", fileName: "Synthetic.pdf" }),
    ]) });
  });

  it("never reuploads an unknown final chunk: operator resync and automated checks only inspect", async () => {
    const r = await approve();
    plan.fileSync.originals = r.publicId;
    const filePublicId = await stage();
    graph.intercept(({ kind, method }) => kind === "upload" && method === "PUT" ? "throw" : undefined);
    expect(await h.jobs.runAll(copyJob)).toMatchObject([{ outcome: "unknown" }]);
    expect(graph.calls.filter((call) => call.kind === "upload" && call.method === "PUT")).toHaveLength(1);
    expect(await h.jobs.runAll(copyJob)).toMatchObject([{ outcome: "unknown" }]);
    const scope = { scope: "file", orderPublicId: orderId, filePublicId } as const;
    const preview = await storage.fileSync.previewResync(admin, scope);
    expect(preview).toMatchObject({ count: 1, inspectOnly: 1 });
    await expect(storage.fileSync.resync(admin, { scope, previewToken: "a".repeat(64) }, "resync-test"))
      .rejects.toMatchObject({ reasonCode: "STORAGE_RESYNC_PREVIEW_STALE" });
    expect(await storage.fileSync.resync(admin, { scope, previewToken: preview.previewToken }, "resync-test")).toEqual({ queued: 1 });
    await h.jobs.runAll(copyJob);
    expect(graph.calls.filter((call) => call.kind === "upload" && call.method === "PUT")).toHaveLength(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ source: "file_sync", severity: "critical" }));
  });

  it("honors retry-after and blocks destination changes and files hidden before the next send", async () => {
    const r = await approve();
    plan.fileSync.intakeDelivery = r.publicId;
    const id = await stage();
    graph.intercept(({ kind, method }) => kind === "upload" && method === "PUT"
      ? { status: 429, headers: { "retry-after": "420" }, body: null } : undefined);
    await h.jobs.runAll(copyJob);
    expect(h.jobs.enqueued[0]?.options?.runAt).toEqual(new Date(h.clock.now().getTime() + 420_000));
    files.get(id)!.visibility = "staff_only";
    await h.jobs.runAll(copyJob);
    const [blocked] = await testDb.db.select().from(storageManagedFileCopies).where(eq(storageManagedFileCopies.sourcePublicId, id));
    expect(blocked).toMatchObject({ state: "blocked", reasonCode: "STORAGE_COPY_SOURCE_INACTIVE" });
    expect(graph.calls.filter((call) => call.kind === "upload" && call.method === "PUT")).toHaveLength(1);
    const current = await storage.connections.get(admin, { publicId: r.publicId });
    const rotated = await storage.connections.update(admin, { publicId: r.publicId, expectedVersion: current.version,
      credentials: { clientSecret: "new-synthetic-secret" } });
    expect(rotated.enabled).toBe(false);
    expect(await storage.fileSync.listTargets(admin)).toEqual([]);
    expect(await storage.fileSync.previewResync(admin, { scope: "target", publicId: r.publicId })).toMatchObject({ count: 0 });
  });

  it("does not stage receipts without explicit restricted approval and hides receipts from staff", async () => {
    const publication = { orderPublicId: orderId, receiptPublicId: ulid() };
    await testDb.db.transaction((tx) => storage.stageReceiptPdf(publication, tx));
    expect(h.jobs.enqueued).toHaveLength(0);
    const restricted = graph.addDrive("Restricted receipts", "documentLibrary", "https://contoso.sharepoint.com/sites/Finance/Receipts");
    await approve("receipts", restricted.id);
    await testDb.db.transaction((tx) => storage.stageReceiptPdf(publication, tx));
    expect(await h.jobs.runAll(copyJob)).toMatchObject([{ outcome: "completed" }]);
    expect(await storage.fileSync.forOrder(admin, { orderPublicId: orderId })).toMatchObject({ items: [{ role: "receipt", state: "copied" }] });
    expect(await storage.fileSync.forOrder(fakePrincipal({ role: "staff" }), { orderPublicId: orderId })).toEqual({ items: [], nextCursor: null });
    expect([...restricted.items.values()].filter((item) => !item.folder)).toHaveLength(1);
  });
});
