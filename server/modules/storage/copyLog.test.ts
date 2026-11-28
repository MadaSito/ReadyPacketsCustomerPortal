import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDeps, fakePrincipal, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { ulid } from "../../core/ids.js";
import type { SessionPrincipal } from "../../core/types.js";
import { jobAttempts, jobRuns } from "../jobs/schema.js";
import { orders } from "../orders/schema.js";
import { copyLogConnections, copyLogHealth, copyLogList, createCopyLogService, safeCopyCsvCell } from "./copyLog.js";
import type { CopyAttemptEvent } from "./copyLogTypes.js";
import { recordCopyAttempt } from "./copyLogWriter.js";
import { storageConnections, storageCopyAttempts } from "./schema.js";

let db: TestDb;
let h: TestHarness;
let admin: SessionPrincipal;
let service: ReturnType<typeof createCopyLogService>;
let connectionPublicId: string;
let sourcePublicId: string;
let jobPublicId: string;
let currentRole: SessionPrincipal["role"];

beforeAll(async () => {
  db = await createTestDb({ schema: { orders, storageConnections, storageCopyAttempts, jobRuns, jobAttempts } });
});
afterAll(() => db?.cleanup());
beforeEach(async () => {
  for (const table of [jobAttempts, jobRuns, storageCopyAttempts, storageConnections]) await db.db.delete(table);
  h = createTestDeps({ db: db.db });
  admin = fakePrincipal({ role: "admin", stepUpAt: null });
  currentRole = "admin";
  h.services.identity = { sessions: {
    async assertCurrent() { return { role: currentRole, stepUpAt: null, pendingSteps: [] }; },
  } } as unknown as TestHarness["services"]["identity"];
  service = createCopyLogService(h.deps);
  connectionPublicId = ulid();
  sourcePublicId = ulid();
  jobPublicId = ulid();
  await db.db.insert(storageConnections).values({
    publicId: connectionPublicId, name: "  =FORMULA", kind: "dropbox", config: { folder: "secret-folder-marker" },
    credentialsEnc: "secret-credential-marker",
  });
});

async function write(...events: CopyAttemptEvent[]) {
  return db.db.transaction(async (tx) => {
    for (const event of events) await recordCopyAttempt(h.deps, event, tx);
  });
}

const identity = (extras: Partial<Pick<CopyAttemptEvent, "kind" | "jobPublicId" | "attempt">> = {}) => ({
  kind: "order_file" as const, sourcePublicId, connectionPublicId, jobPublicId, attempt: 1,
  correlationId: "workflow:copy-1", ...extras,
});

describe("storage copy log", () => {
  it("retains each attempt, separates verified from written, and never overwrites a terminal row", async () => {
    await write({ ...identity(), phase: "queued" }, { ...identity(), phase: "started", bytes: 10 },
      { ...identity(), phase: "finished", result: "failed", errorCode: "STORAGE_PROVIDER_RETRY" });
    h.clock.advance(1);
    await write({ ...identity({ attempt: 2 }), phase: "finished", result: "verified", verification: "checksum", bytes: 10 },
      { ...identity(), phase: "finished", result: "written" },
      { ...identity({ jobPublicId: ulid() }), phase: "finished", result: "written" });
    const page = await service.list(admin, { connectionPublicId, limit: 1 });
    expect(page.totals).toEqual({ failed: 1, not_written: 0, queued: 0, verified: 1, written: 1 });
    expect(page.nextCursor).toBe(page.items[0]?.publicId);
    const next = await service.list(admin, { connectionPublicId, cursor: page.nextCursor ?? undefined });
    const matches = [...page.items, ...next.items];
    expect(new Set(matches.map((row) => row.publicId)).size).toBe(3);
    expect(matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ attempt: 1, state: "failed", verified: false, bytes: 10, errorCode: "STORAGE_PROVIDER_RETRY" }),
      expect.objectContaining({ attempt: 2, state: "verified", verified: true, verification: "checksum", bytes: 10 }),
      expect.objectContaining({ state: "written", verified: false, verification: null }),
    ]));
    expect(h.audit.named("storage.copy_result").map((event) => event.outcome)).toEqual(["failed", "completed", "completed"]);
    expect((await copyLogHealth(h.deps)).state).toBe("degraded");
    expect((await service.list(admin, { state: "failed", text: "workflow:copy-1" })).items).toHaveLength(1);
    expect((await service.list(admin, { state: "failed", text: "%_" })).items).toHaveLength(0);
  });

  it("projects a lost worker lease as unconfirmed, and never infers a successful write from Jobs", async () => {
    await write({ ...identity(), phase: "queued", correlationId: null });
    const [job] = await db.db.insert(jobRuns).values({
      publicId: jobPublicId, type: "storage.copy_order_file", state: "unknown", maxAttempts: 6,
      runAt: h.clock.now(), correlationId: "queue:lost",
    }).$returningId();
    await db.db.insert(jobAttempts).values({
      jobId: job!.id, state: "interrupted", attempt: 1, fencingToken: 1, startedAt: h.clock.now(), finishedAt: h.clock.now(),
    });
    const result = await service.list(admin, {});
    expect(result.items[0]).toMatchObject({
      state: "failed", verified: false, errorCode: "COPY_ATTEMPT_INTERRUPTED", correlationId: "queue:lost", finishedAt: h.clock.now(),
    });
    expect((await copyLogHealth(h.deps)).state).toBe("degraded");
  });

  it("rejects unbounded date searches and does not use a later job result for an earlier attempt", async () => {
    await write({ ...identity(), phase: "queued" });
    await db.db.insert(jobRuns).values({
      publicId: jobPublicId, type: "storage.copy_order_file", state: "completed", attempt: 2,
      maxAttempts: 6, runAt: h.clock.now(), correlationId: "queue:later",
    });
    expect((await service.list(admin, {})).items[0]).toMatchObject({ state: "queued", verified: false });
    await expect(service.list(admin, {
      from: "2026-01-01T00:00:00.000Z", through: "2026-07-01T00:00:00.000Z",
    })).rejects.toMatchObject({ reasonCode: "COPY_LOG_DATE_RANGE" });
  });

  it("accepts the forward pagination metadata sent by the tRPC client", () => {
    const paging = { direction: "forward", cursor: sourcePublicId };
    expect(copyLogList.parse({ ...paging, state: "written" })).toEqual({ ...paging, state: "written" });
    expect(copyLogConnections.parse(paging)).toEqual(paging);
    expect(copyLogList.safeParse({ ...paging, direction: "backward" }).success).toBe(false);
  });

  it("guards all reads with live admin authorization and audits spreadsheet-safe CSV export", async () => {
    await write({ ...identity(), phase: "finished", result: "failed", errorCode: "provider-secret-url:raw", alreadyAudited: true });
    const { csv, count } = await service.exportCsv(admin, {});
    expect(count).toBe(1);
    expect(csv).toContain("\"'  =FORMULA\"");
    expect(csv).toContain("COPY_FAILED");
    expect(csv).not.toMatch(/secret-marker|secret-folder|secret-credential|secret-url/);
    expect(h.audit.named("storage.copy_log.exported")).toHaveLength(1);
    expect(h.audit.recordedInTx).toEqual([true]);
    expect(safeCopyCsvCell('hi,"there"')).toBe('"hi,""there"""');
    expect(safeCopyCsvCell("＝1")).toBe("\"'＝1\"");
    currentRole = "staff";
    await expect(service.exportCsv(admin, {})).rejects.toMatchObject({ reasonCode: "COPY_LOG_DENIED" });
    await expect(service.connections(fakePrincipal({ role: "customer" }), {})).rejects.toMatchObject({ reasonCode: "COPY_LOG_DENIED" });
  });

  it("keeps provider results and copy history in the same audit transaction", async () => {
    await write({ ...identity(), phase: "queued" });
    h.audit.failRecords = true;
    await expect(write({ ...identity(), phase: "finished", result: "written" })).rejects.toThrow();
    expect((await service.list(admin, {})).items[0]).toMatchObject({ state: "queued", verified: false });
  });

  it("delegates only a current failed backup attempt to the owner's guarded retry", async () => {
    const eligible = vi.fn(async () => true);
    const copy = vi.fn(async () => ({ queued: [{}] }));
    h.services.backup = { mayRetryOffsiteCopy: eligible, copyOffsiteNow: copy } as unknown as TestHarness["services"]["backup"];
    await write({ ...identity({ kind: "backup_archive" }), phase: "finished", result: "failed" });
    const [row] = (await service.list(admin, {})).items;
    expect((await service.detail(admin, { publicId: row!.publicId })).canRetry).toBe(true);
    expect(await service.retry(admin, { publicId: row!.publicId })).toEqual({ queued: 1 });
    expect(copy).toHaveBeenCalledWith(admin, { backupPublicId: sourcePublicId, connectionPublicId, expectedFailedJobId: jobPublicId });
    eligible.mockResolvedValue(false);
    await expect(service.retry(admin, { publicId: row!.publicId })).rejects.toMatchObject({ reasonCode: "COPY_RETRY_UNAVAILABLE" });
    expect(copy).toHaveBeenCalledTimes(1);
  });
});
