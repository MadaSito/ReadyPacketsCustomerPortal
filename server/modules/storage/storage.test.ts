import { buffer } from "node:stream/consumers";
import { z } from "zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDeps, fakePrincipal, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { DomainError } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { SessionPrincipal } from "../../core/types.js";
import { jobAttempts, jobRuns } from "../jobs/schema.js";
import { orderFilesCopyAction } from "./automation.js";
import { StorageAdapterError, type StorageConnectionView } from "./contracts.js";
import { createStorageModule, type StorageModule } from "./index.js";
import { storageAssignments, storageConnections, storageCopyAttempts, storageFileCopies, storageManagedFileCopies } from "./schema.js";

const jobType = "storage.copy_order_file";
const sourceBytes = Buffer.from("synthetic local order file");
const configuration = { root: "example-folder" };
const credentials = { clientSecret: "synthetic_oauth_app_secret" };
const testProvider = z.strictObject({ root: z.string().min(1) });
const testSecrets = z.strictObject({ clientSecret: z.string().min(8), refreshToken: z.string().min(8).optional() });

let db: TestDb;
let h: TestHarness;
let module: StorageModule;
let admin: SessionPrincipal;
let stepUp: Date | null;
let providerFault: StorageAdapterError | undefined;
let overrideDigest: string | undefined;
let visitEnsure: (() => Promise<void>) | undefined;
let sourceUnavailable: boolean;
let sourceVisibility: "customer_visible" | "staff_only";
let currentVersion: boolean;
let route: { slotTemplate: string | null; workflowTemplate: string | null; phaseLabel: string | null };
let finalPath: readonly string[] | undefined;
let adapterPuts: ReturnType<typeof vi.fn<(path: readonly string[], name: string, data: Buffer) => void>>;
let adapterRemovals: ReturnType<typeof vi.fn<() => void>>;

beforeAll(async () => {
  db = await createTestDb({ schema: { storageConnections, storageAssignments, storageFileCopies, storageManagedFileCopies, storageCopyAttempts, jobRuns, jobAttempts } });
});
afterAll(() => db?.cleanup());
beforeEach(async () => {
  for (const table of [storageCopyAttempts, storageFileCopies, storageAssignments, storageConnections, jobAttempts, jobRuns]) await db.db.delete(table);
  h = createTestDeps({ db: db.db });
  admin = fakePrincipal({ role: "admin", stepUpAt: h.clock.now() });
  stepUp = admin.stepUpAt;
  providerFault = undefined;
  overrideDigest = undefined;
  visitEnsure = undefined;
  sourceUnavailable = false;
  sourceVisibility = "customer_visible";
  currentVersion = true;
  route = { slotTemplate: null, workflowTemplate: null, phaseLabel: "Intake" };
  finalPath = undefined;
  adapterPuts = vi.fn();
  adapterRemovals = vi.fn();
  h.services.identity = {
    sessions: { async assertCurrent(principal: SessionPrincipal) {
      return { role: principal.role, stepUpAt: stepUp, pendingSteps: [] };
    } },
  } as unknown as TestHarness["services"]["identity"];
  h.services.orders = {
    async assertCanReadOrder() { return {}; },
    async getOrderFileFolderRouting() { return route; },
  } as unknown as TestHarness["services"]["orders"];
  h.services.jobAdmin = {
    async canReplaceFailedOutboxJob() { return true; },
  } as unknown as TestHarness["services"]["jobAdmin"];
  module = createStorageModule(h.deps);
  module.registerAdapter("dropbox", {
    configSchema: testProvider, credentialsSchema: testSecrets, purposes: ["order_files", "backups"],
    create() {
      return {
        async test() { return { ok: true, code: "OK" }; },
        async ensureFolder() { await visitEnsure?.(); },
        async put(input) {
          await input.beforeWrite?.();
          const data = await buffer(input.body);
          adapterPuts(input.path, input.name, data);
          if (providerFault) throw providerFault;
          return { remoteId: "synthetic-remote-reference", size: data.length, sha256: overrideDigest ?? input.sha256, targetPath: finalPath };
        },
        async remove() { adapterRemovals(); },
      };
    },
  });
});

async function create(name = "Synthetic storage", enable = true): Promise<StorageConnectionView> {
  const row = await module.connections.create(admin, { kind: "dropbox", name, config: configuration, credentials });
  if (!enable) return row;
  return testEnable(row);
}

async function testEnable(row: StorageConnectionView) {
  const tested = await module.connections.test(admin, { publicId: row.publicId, expectedVersion: row.version });
  return module.connections.update(admin, { publicId: tested.publicId, expectedVersion: tested.version, enabled: true });
}

async function stage() {
  const filePublicId = ulid();
  const orderPublicId = ulid();
  const storageKey = h.storage.newKey("files");
  const local = await h.storage.put(storageKey, sourceBytes);
  h.services.files = {
    async getOrderFileCopySource() {
      if (sourceUnavailable) throw new DomainError("NOT_FOUND", "STORAGE_COPY_SOURCE_INACTIVE", "Source unavailable.");
      return {
        storageKey, size: sourceBytes.length, sha256: local.sha256, contentType: "application/octet-stream",
        displayName: "Synthetic ../Doc.pdf", extension: "pdf", ownerUserId: 42, visibility: sourceVisibility, currentVersion,
        customerName: "E\u0301lodie Beispiel", customerReference: "RPCUS-TEST00001", customerPublicId: ulid(),
        orderReference: "Order / synthetic", orderName: "../A/B", orderPublicId, filePublicId,
        statusKey: "intake", slotKey: "documents", createdAt: new Date("2026-11-21T15:30:00Z"),
      };
    },
    async listOrderFileCopyCandidates(requestedOrder: string) {
      return !sourceUnavailable && requestedOrder === orderPublicId ? [filePublicId] : null;
    },
    async listOrderFileCopyMetadata(requestedOrder: string, ids: string[]) {
      return requestedOrder === orderPublicId && ids.includes(filePublicId)
        ? [{ filePublicId, displayName: "Synthetic ../Doc.pdf", sourceAvailable: !sourceUnavailable }] : [];
    },
  } as unknown as TestHarness["services"]["files"];
  await db.db.transaction((tx) => module.stageOrderFile(filePublicId, tx, { orderPublicId }));
  return { filePublicId, storageKey, orderPublicId };
}

describe("storage registry", () => {
  it("requires persisted administrator step-up and fails closed if a write cannot be audited", async () => {
    await expect(module.connections.list(fakePrincipal({ role: "staff", stepUpAt: h.clock.now() }), {}))
      .rejects.toMatchObject({ reasonCode: "CAPABILITY_NOT_GRANTED" });
    await expect(module.connections.list({ ...admin, state: "remediation" }, {}))
      .rejects.toMatchObject({ reasonCode: "ACCOUNT_STEP_PENDING" });
    stepUp = null;
    await expect(create("Denied", false)).rejects.toMatchObject({ code: "STEP_UP_REQUIRED" });
    expect(h.audit.named("storage.admin.denied")).toHaveLength(3);
    stepUp = admin.stepUpAt;
    h.audit.failRecords = true;
    await expect(create("No audit", false)).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    expect(await db.db.select().from(storageConnections)).toEqual([]);
  });

  it("keeps credentials encrypted and write-only; only the internal OAuth update can persist refresh tokens", async () => {
    const row = await create("Synthetic OAuth", false);
    expect(row).toMatchObject({ enabled: false, credentialsConfigured: true, oauthConnected: false, lastTest: null });
    expect(JSON.stringify(row)).not.toContain(credentials.clientSecret);
    expect((await db.db.select().from(storageConnections))[0]?.credentialsEnc).not.toContain(credentials.clientSecret);
    await expect(module.connections.update(admin, { publicId: row.publicId, expectedVersion: row.version, enabled: true }))
      .rejects.toMatchObject({ reasonCode: "STORAGE_TEST_REQUIRED" });
    const replacement = { ...credentials, refreshToken: "synthetic_refresh_token" };
    await expect(module.connections.update(admin, { publicId: row.publicId, expectedVersion: row.version, credentials: replacement }))
      .rejects.toMatchObject({ reasonCode: "STORAGE_OAUTH_REQUIRED" });
    const updated = await db.db.transaction(async (tx) => {
      await expect(module.readProviderSetup(admin, { publicId: row.publicId, kind: "google_drive", expectedVersion: row.version }, tx))
        .rejects.toMatchObject({ reasonCode: "STORAGE_CONNECTION_NOT_FOUND" });
      return module.connections.update(admin, { publicId: row.publicId, expectedVersion: row.version, credentials: replacement }, tx);
    });
    expect(updated.oauthConnected).toBe(true);
    expect(JSON.stringify([updated, h.audit.events])).not.toContain(replacement.refreshToken);
    await expect(module.connections.update(admin, { publicId: row.publicId, expectedVersion: updated.version,
      config: { root: "other-folder" }, credentials })).rejects.toMatchObject({ reasonCode: "STORAGE_CREDENTIAL_REPLACEMENT_REQUIRED" });
  });

  it("pins credentialed configuration and rate-limits tests; config changes disable and invalidate prior successful tests", async () => {
    const row = await create();
    await expect(module.connections.update(admin, { publicId: row.publicId, expectedVersion: row.version,
      config: { root: "another-destination" } })).rejects.toMatchObject({ reasonCode: "STORAGE_CREDENTIAL_REPLACEMENT_REQUIRED" });
    h.rateLimiter.blocked.add("expensive");
    await expect(module.connections.test(admin, { publicId: row.publicId, expectedVersion: row.version }))
      .rejects.toMatchObject({ reasonCode: "STORAGE_TEST_RATE_LIMITED" });
    const changed = await module.connections.update(admin, { publicId: row.publicId, expectedVersion: row.version,
      config: { root: "another-destination" }, credentials });
    expect(changed).toMatchObject({ enabled: false, lastTest: null, credentialsConfigured: true });
    await expect(module.connections.update(admin, { publicId: row.publicId, expectedVersion: row.version, name: "stale edit" }))
      .rejects.toMatchObject({ reasonCode: "STORAGE_CONNECTION_CHANGED" });
  });

  it("supports several backups without changing order_data cardinality or exposing disabled connections to workers", async () => {
    const first = await create("Backup A");
    const second = await create("Backup B");
    const third = await create("Disabled backup", false);
    const ids = [first.publicId, second.publicId, third.publicId];
    await expect(module.assignments.set(admin, { purpose: "backups", connectionPublicIds: ids })).resolves.toHaveLength(3);
    expect((await module.listAssigned("backups")).map((a) => a.connectionPublicId)).toEqual(ids.slice(0, 2).sort());
    await expect(module.assignments.set(admin, { purpose: "order_data", connectionPublicIds: ids.slice(0, 2) }))
      .rejects.toMatchObject({ code: "VALIDATION" });
    await expect(module.assignments.set(admin, { purpose: "order_data", connectionPublicIds: ids.slice(0, 1) }))
      .rejects.toMatchObject({ reasonCode: "STORAGE_PURPOSE_UNSUPPORTED" });
  });
});

describe("fenced order-file copy jobs", () => {
  async function provision() {
    const row = await create();
    await module.assignments.set(admin, { purpose: "order_files", connectionPublicIds: [row.publicId] });
    const file = await stage();
    return { row, file };
  }

  it("stays inert without assignments; active jobs copy to every connection without modifying the local object", async () => {
    await stage();
    expect(h.jobs.enqueued).toHaveLength(0);
    const first = await create("One");
    const second = await create("Two");
    await module.assignments.set(admin, { purpose: "order_files", connectionPublicIds: [first.publicId, second.publicId] });
    const { storageKey } = await stage();
    expect(h.jobs.enqueued).toHaveLength(2);
    const queued = await db.db.select().from(storageCopyAttempts);
    expect(queued).toHaveLength(2);
    expect(queued.every((row) => row.kind === "order_file" && row.state === "queued")).toBe(true);
    expect(await h.jobs.runAll(jobType)).toEqual([
      { outcome: "completed", safeCounts: { files: 1, digestVerified: 1 } },
      { outcome: "completed", safeCounts: { files: 1, digestVerified: 1 } },
    ]);
    const copies = await db.db.select().from(storageFileCopies);
    expect(copies.every((row) => row.state === "copied" && row.digestVerified)).toBe(true);
    const attempts = await db.db.select().from(storageCopyAttempts);
    expect(attempts.map((row) => row.publicId).sort()).toEqual(queued.map((row) => row.publicId).sort());
    expect(attempts.every((row) => row.state === "verified" && row.verification === "checksum" && row.bytes === sourceBytes.length)).toBe(true);
    expect(h.audit.named("storage.copy_result")).toHaveLength(0);
    expect(JSON.stringify([copies, attempts, h.audit.events])).not.toMatch(/Beispiel|RPCUS-|synthetic-remote-reference/u);
    expect(adapterPuts.mock.calls[0]?.[0]).toEqual(["customers", "RPCUS-TEST00001", "orders", "Order _ synthetic", "Intake"]);
    expect(h.storage.objects.get(storageKey)).toEqual(sourceBytes);
    expect(adapterRemovals).not.toHaveBeenCalled();
  });

  it("does not dispatch a queued order file after credential replacement, even after retest and re-enable", async () => {
    const { row } = await provision();
    const replaced = await module.connections.update(admin, { publicId: row.publicId, expectedVersion: row.version,
      credentials: { clientSecret: "synthetic_rotation_staged_after_upload" } });
    await testEnable(replaced);
    expect(await h.jobs.runAll(jobType)).toEqual([{ outcome: "completed", safeCounts: { skipped: 1 } }]);
    expect(adapterPuts).not.toHaveBeenCalled();
    expect((await db.db.select().from(storageFileCopies))[0]).toMatchObject({
      state: "skipped", reasonCode: "STORAGE_ASSIGNMENT_INACTIVE",
    });
    expect((await db.db.select().from(storageCopyAttempts))[0]).toMatchObject({
      state: "not_written", verification: null, errorCode: "STORAGE_ASSIGNMENT_INACTIVE",
    });
  });

  it("uses slot, then workflow, then assignment default and records the provider-observed path", async () => {
    const { file } = await provision();
    route = { slotTemplate: "slot/{slot}/{order_name}/{yyyy}/{mm}", workflowTemplate: "workflow/{phase}", phaseLabel: "Stage 1" };
    finalPath = ["Slot", "documents", "_A_B", "2026", "11", "Accepted (1).pdf"];
    await h.jobs.runAll(jobType);
    expect(adapterPuts.mock.calls[0]?.[0]).toEqual(["slot", "documents", "_A_B", "2026", "11"]);
    let transfers = await module.orderCopies.forOrder(admin, { orderPublicId: file.orderPublicId });
    expect(transfers).toMatchObject({ hasAssignedConnection: true, hasSharePoint: false,
      totals: { total: 1, synced: 1, inProgress: 0, failed: 0 },
      items: [{ fileName: "Synthetic ../Doc.pdf", phase: "Stage 1", targetPath: finalPath.join("/"), state: "verified" }],
    });
    expect((await module.copies.list(admin, { orderPublicId: file.orderPublicId })).items[0]?.targetPath).toBe(finalPath.join("/"));
    expect((await module.copies.list(admin, { orderPublicId: ulid() })).items).toEqual([]);
    expect(JSON.stringify(await db.db.select().from(storageCopyAttempts))).not.toContain("Accepted (1).pdf");
    route.slotTemplate = null;
    finalPath = undefined;
    const next = await stage();
    await h.jobs.runAll(jobType);
    expect(adapterPuts.mock.calls[1]?.[0]).toEqual(["workflow", "Stage 1"]);
    transfers = await module.orderCopies.forOrder(admin, { orderPublicId: next.orderPublicId });
    expect(transfers.items).toHaveLength(1);
    await expect(module.orderCopies.forOrder(admin, {
      orderPublicId: next.orderPublicId, cursor: (await module.copies.list(admin, { orderPublicId: file.orderPublicId })).items[0]!.publicId,
    })).rejects.toMatchObject({ reasonCode: "COPY_ATTEMPT_NOT_FOUND" });
  });

  it("refuses an unsafe pinned folder before touching the provider and retries only a current scoped, intact source", async () => {
    const { file } = await provision();
    route.slotTemplate = "escape/../private";
    const { jobId } = h.jobs.enqueued[0]!;
    expect(await h.jobs.runAll(jobType)).toEqual([{ outcome: "failed", reasonCode: "STORAGE_FOLDER_INVALID", retryable: false }]);
    expect(adapterPuts).not.toHaveBeenCalled();
    await db.db.insert(jobRuns).values({
      publicId: jobId, type: jobType, state: "failed", correlationId: "synthetic", allowRetry: false,
      attempt: 1, maxAttempts: 6, runAt: h.clock.now(),
    });
    const [attempt] = (await module.orderCopies.forOrder(admin, { orderPublicId: file.orderPublicId })).items;
    expect(attempt).toMatchObject({ state: "failed", canRetry: true, targetPath: null });
    const input = { orderPublicId: file.orderPublicId, publicId: attempt!.publicId };
    await expect(module.orderCopies.forOrder(fakePrincipal({ role: "customer" }), input)).rejects.toMatchObject({ reasonCode: "ORDER_COPY_DENIED" });
    await expect(module.orderCopies.retryOrderFile(admin, { ...input, orderPublicId: ulid() })).rejects.toMatchObject({ reasonCode: "COPY_RETRY_UNAVAILABLE" });
    h.storage.objects.delete(file.storageKey);
    await expect(module.orderCopies.retryOrderFile(admin, input)).rejects.toMatchObject({ reasonCode: "COPY_RETRY_UNAVAILABLE" });
    h.storage.objects.set(file.storageKey, sourceBytes);
    route.slotTemplate = "safe/{slot}";
    const concurrent = await Promise.allSettled([
      module.orderCopies.retryOrderFile(admin, input), module.orderCopies.retryOrderFile(admin, input),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toEqual([{ status: "fulfilled", value: { queued: true } }]);
    expect(concurrent.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ reasonCode: "COPY_RETRY_UNAVAILABLE" }) }),
    ]);
    await expect(module.orderCopies.retryOrderFile(admin, input)).rejects.toMatchObject({ reasonCode: "COPY_RETRY_UNAVAILABLE" });
    expect(h.jobs.enqueued).toHaveLength(1);
    expect(h.audit.named("order.file.copy.retry_queued")).toEqual([
      expect.objectContaining({ orderPublicId: file.orderPublicId, resource: { type: "file", publicId: file.filePublicId } }),
    ]);
    expect((await module.orderCopies.forOrder(admin, { orderPublicId: file.orderPublicId })).totals)
      .toEqual({ total: 1, synced: 0, inProgress: 1, failed: 0 });
  });

  it("rechecks current source scope after folder setup and before writing", async () => {
    await provision();
    visitEnsure = async () => { sourceUnavailable = true; };
    expect(await h.jobs.runAll(jobType)).toEqual([{ outcome: "completed", safeCounts: { skipped: 1 } }]);
    expect(adapterPuts).not.toHaveBeenCalled();
  });

  it("fails on a provider-reported digest mismatch and never deletes remotely", async () => {
    const { file } = await provision();
    overrideDigest = "0".repeat(64);
    expect(await h.jobs.runAll(jobType)).toEqual([{ outcome: "failed", reasonCode: "STORAGE_INTEGRITY_MISMATCH", retryable: false }]);
    expect(h.storage.objects.get(file.storageKey)).toEqual(sourceBytes);
    expect(adapterRemovals).not.toHaveBeenCalled();
  });

  it("hands duplicate-safe failures to bounded queue backoff and does not replay an ambiguous outcome", async () => {
    const { file } = await provision();
    providerFault = new StorageAdapterError("RATE_LIMITED", true);
    const pending = h.jobs.enqueued[0]!;
    expect(pending.options?.maxAttempts).toBe(6);
    expect(h.jobs.handlerOptions.get(jobType)?.retrySafe).not.toBe(true);
    expect(await h.jobs.runAll(jobType)).toEqual([{ outcome: "failed", reasonCode: "STORAGE_PROVIDER_RETRY", retryable: true }]);
    expect((await db.db.select().from(storageFileCopies))[0]).toMatchObject({ state: "queued", attempts: 1 });
    h.jobs.enqueued.push(pending);
    providerFault = new StorageAdapterError("OUTCOME_UNKNOWN");
    expect(await h.jobs.runAll(jobType)).toEqual([{ outcome: "unknown", reasonCode: "STORAGE_COPY_UNCERTAIN" }]);
    expect(h.audit.named("order.file.copy.unknown").at(-1)?.outcome).toBe("unknown");
    await db.db.insert(jobRuns).values({
      publicId: pending.jobId, type: jobType, state: "unknown", correlationId: "synthetic",
      attempt: 1, maxAttempts: 6, runAt: h.clock.now(),
    });
    const [item] = (await module.orderCopies.forOrder(admin, { orderPublicId: file.orderPublicId })).items;
    expect(item?.canRetry).toBe(false);
    await expect(module.orderCopies.retryOrderFile(admin, { orderPublicId: file.orderPublicId, publicId: item!.publicId }))
      .rejects.toMatchObject({ reasonCode: "COPY_RETRY_UNAVAILABLE" });
  });

  it("deduplicates automation replays, preserves their origin, and cannot target an unassigned destination", async () => {
    const { orderPublicId } = await stage();
    const active = await create("Active");
    const unassigned = await create("Unassigned");
    await module.assignments.set(admin, { purpose: "order_files", connectionPublicIds: [active.publicId] });
    const fence = vi.fn(async () => {});
    const input = { orderPublicId, signal: new AbortController().signal, assertStillOwned: fence, correlationId: `automation:${ulid()}` };
    await expect(module.stageOrderFilesForAutomation({ ...input, correlationId: "request-not-an-automation" }))
      .rejects.toMatchObject({ reasonCode: "STORAGE_AUTOMATION_ORIGIN_INVALID" });
    await expect(module.stageOrderFilesForAutomation({ ...input, connectionPublicId: unassigned.publicId }))
      .resolves.toEqual({ queued: 0, cause: "STORAGE_ASSIGNMENT_INACTIVE" });
    await expect(module.stageOrderFilesForAutomation(input)).resolves.toEqual({ queued: 1 });
    await expect(module.stageOrderFilesForAutomation(input)).resolves.toEqual({ queued: 0 });
    expect(fence).toHaveBeenCalledTimes(3);
    expect(h.jobs.enqueued).toHaveLength(1);
    expect(h.jobs.enqueued[0]?.options?.correlationId).toBe(input.correlationId);
    await h.jobs.runAll(jobType);
    expect(h.audit.events.filter((row) => row.eventName.startsWith("order.file.copy.")).map((row) => row.correlationId))
      .toEqual([input.correlationId, input.correlationId]);
  });

  it("does not send an automation-staged file after it becomes staff only", async () => {
    const { orderPublicId, filePublicId } = await stage();
    const active = await create();
    await module.assignments.set(admin, { purpose: "order_files", connectionPublicIds: [active.publicId] });
    await module.stageOrderFilesForAutomation({ orderPublicId, filePublicId, signal: new AbortController().signal,
      assertStillOwned: async () => {}, correlationId: `automation:${ulid()}` });
    sourceVisibility = "staff_only";
    expect(await h.jobs.runAll(jobType)).toEqual([{ outcome: "completed", safeCounts: { skipped: 1 } }]);
    expect(adapterPuts).not.toHaveBeenCalled();
  });

  it("blocks an automation write if the staged file version is superseded before the write", async () => {
    const { orderPublicId, filePublicId } = await stage();
    const active = await create();
    await module.assignments.set(admin, { purpose: "order_files", connectionPublicIds: [active.publicId] });
    await module.stageOrderFilesForAutomation({ orderPublicId, filePublicId, signal: new AbortController().signal,
      assertStillOwned: async () => {}, correlationId: `automation:${ulid()}` });
    visitEnsure = async () => { currentVersion = false; };
    expect(await h.jobs.runAll(jobType)).toEqual([{ outcome: "completed", safeCounts: { skipped: 1 } }]);
    expect(adapterPuts).not.toHaveBeenCalled();
  });

  it("refuses all staff-only triggers and file upload triggers lacking the canonical file ID", async () => {
    const orderPublicId = ulid();
    const runPublicId = ulid();
    const ctx: Parameters<typeof orderFilesCopyAction.run>[0] = {
      automationPublicId: ulid(), automationVersion: 1, runPublicId, stepIndex: 0, stepKey: "step_1",
      idempotencyKey: `auto:${runPublicId}:step:step_1`, correlationId: `automation:${runPublicId}`,
      triggerMode: "event", triggerKey: "file.uploaded", triggerEventId: ulid(), config: {}, secrets: {},
      fields: {}, recipients: {}, orderPublicId, filePublicId: ulid(), staffOnlyTrigger: true, dryRun: false,
      assertStillOwned: async () => {}, signal: new AbortController().signal, deps: h.deps,
    };
    const stageCopy = vi.spyOn(module, "stageOrderFilesForAutomation");
    expect(orderFilesCopyAction.forbidOnStaffOnlyTrigger).toBe(true);
    await expect(orderFilesCopyAction.run(ctx)).resolves.toMatchObject({ outcome: "skipped" });
    await expect(orderFilesCopyAction.run({ ...ctx, staffOnlyTrigger: false, filePublicId: null }))
      .resolves.toMatchObject({ outcome: "skipped" });
    expect(stageCopy).not.toHaveBeenCalled();
  });
});
