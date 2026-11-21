import express from "express";
import request from "supertest";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { createTestDeps, fakePrincipal, type TestHarness } from "../../../tests/helpers/fakes.js";
import { DomainError, notFound } from "../../core/errors.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { SessionPrincipal, Tx } from "../../core/types.js";
import { setHttpState } from "../../http/requestState.js";
import { registerFilesHttpRoutes } from "./http.js";
import { createFilesModule, type FilesModule, type UploadOptions } from "./index.js";
import { fileAccessLog, fileDownloadTickets, orderFiles } from "./schema.js";
import { exampleWav, exampleWebm } from "./fixtures.test-support.js";

const orderPublicId = `01JTEST${"0".repeat(19)}`;
const userPublicId = `01JTEST${"0".repeat(18)}1`;
const orderId = 201;
const upload: UploadOptions = { category: "supporting", visibility: "customer_visible" };
let t: TestDb;
let h: TestHarness;
let files: FilesModule;
let owner: SessionPrincipal;
let grantee: SessionPrincipal;
let stranger: SessionPrincipal;
let staff: SessionPrincipal;
let grant: false | "viewer" | "contributor";
let locked: "none" | "imported_read_only" | "legal_hold";
let orderOwner: SessionPrincipal;
let orderStage: string;
let orderOrigin: "portal" | "import";
let revokedSession: string | null;
let persistedAdminStepUp: Date | null | undefined;
let holdAtPurgeLock: boolean;

beforeAll(async () => {
  t = await createTestDb({ schema: { orderFiles, fileDownloadTickets, fileAccessLog } });
});
afterAll(() => t?.cleanup());
beforeEach(async () => {
  for (const table of [fileDownloadTickets, fileAccessLog, orderFiles]) await t.db.delete(table);
  h = createTestDeps({ db: t.db });
  files = createFilesModule(h.deps);
  h.services.files = files;
  owner = fakePrincipal({ userPublicId });
  grantee = fakePrincipal();
  stranger = fakePrincipal();
  staff = fakePrincipal({ role: "staff" });
  grant = false;
  locked = "none";
  orderOwner = owner;
  orderStage = "intake";
  orderOrigin = "portal";
  revokedSession = null;
  persistedAdminStepUp = undefined;
  holdAtPurgeLock = false;
  const read = async (principal: SessionPrincipal, id: number | string) => {
    if (id !== orderPublicId && id !== orderId) throw notFound("ORDER_NOT_FOUND");
    const accessRole = principal.role !== "customer" ? principal.role
      : principal.userId === orderOwner.userId ? "owner"
      : principal.userId === grantee.userId && grant ? grant : null;
    if (!accessRole || principal.state !== "full") throw notFound("ORDER_NOT_FOUND");
    return {
      id: orderId, publicId: orderPublicId, reference: "RP-TEST", ownerPublicId: orderOwner.userPublicId, ownerUserId: orderOwner.userId,
      lockState: locked, statusKey: orderStage, origin: orderOrigin, accessRole, canWrite: locked === "none", locked: locked !== "none",
      readOnlyImported: locked === "imported_read_only",
    };
  };
  const write = async (principal: SessionPrincipal, id: number | string) => {
    const view = await read(principal, id);
    if (locked !== "none") throw new DomainError("LOCKED", "ORDER_LOCKED", "This order is locked.");
    if (view.accessRole === "viewer") throw new DomainError("FORBIDDEN", "GRANT_READ_ONLY", "This grant is read-only.");
    return view;
  };
  h.services.orders = {
    assertCanReadOrder: read, assertCanWriteOrder: write, assertCanReadOrderById: read, assertCanWriteOrderById: write,
    async getOrderRefById(id: number, tx?: Tx, options?: { forUpdate?: boolean }) {
      if (id !== orderId) return null;
      if (tx && options?.forUpdate && holdAtPurgeLock) locked = "legal_hold";
      return { id, publicId: orderPublicId, lockState: locked };
    },
  } as unknown as TestHarness["services"]["orders"];
  h.services.identity = {
    sessions: {
      async assertCurrent(principal: SessionPrincipal) {
        if (principal.sessionId === revokedSession) throw new DomainError("UNAUTHENTICATED", "SESSION_NOT_CURRENT", "Please sign in again.");
        return { pendingSteps: [], role: principal.role, stepUpAt: persistedAdminStepUp === undefined ? principal.stepUpAt : persistedAdminStepUp };
      },
    },
  } as unknown as TestHarness["services"]["identity"];
});

async function add(principal = owner, options = upload, filename = "synthetic.wav") {
  const plan = await files.beginUpload(principal, orderPublicId, options);
  const stage = await files.stageUpload(filename, Readable.from([exampleWav()]), plan.rules);
  return files.commitUpload(principal, plan, stage).finally(() => files.cleanUpload(stage));
}

function appFor(principal: SessionPrincipal) {
  const app = express();
  app.use(express.json({ limit: "4kb" }));
  app.use((req, _res, next) => {
    setHttpState(req, { context: newRequestContext("test"), session: principal, cspNonce: "synthetic", transport: { issue() {}, clear() {} } });
    next();
  });
  const router = express.Router();
  registerFilesHttpRoutes(router, h.services);
  app.use("/api/files", router);
  // Test harness deliberately leaves shared production middleware and its tests to HTTP Security.
  const errors: express.ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof DomainError) {
      const status = error.code === "AUDIT_UNAVAILABLE" ? 503 : error.code === "NOT_FOUND" ? 404 : 400;
      res.status(status).json({ reason: error.reasonCode });
    } else res.status(500).json({ reason: "INTERNAL" });
  };
  return app.use(errors);
}

describe("private file admission and authorization", () => {
  it("stages cloud copy work in the active upload transaction and rolls back admission if staging fails", async () => {
    const stageOrderFile = vi.fn(async (publicId: string, tx: Tx) => {
      expect((await tx.select().from(orderFiles)).some((candidate) => candidate.publicId === publicId)).toBe(true);
      throw new Error("synthetic outbox failure");
    });
    h.services.storageConnections = { stageOrderFile } as unknown as TestHarness["services"]["storageConnections"];
    await expect(add()).rejects.toThrow("synthetic outbox failure");
    expect(stageOrderFile).toHaveBeenCalledOnce();
    expect(await t.db.select().from(orderFiles)).toEqual([]);
    expect(h.storage.objects.size).toBe(0);
  });

  it("binds owner and current order stage before and after a streamed upload", async () => {
    await expect(files.beginUpload(stranger, orderPublicId, upload)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const remediation = { ...owner, state: "remediation" as const };
    await expect(files.beginUpload(remediation, orderPublicId, upload)).rejects.toMatchObject({ code: "REMEDIATION_REQUIRED" });
    grant = "viewer";
    await expect(files.beginUpload(grantee, orderPublicId, upload)).rejects.toMatchObject({ reasonCode: "GRANT_READ_ONLY" });
    await expect(files.beginUpload(owner, orderPublicId, { ...upload, visibility: "staff_only" })).rejects.toMatchObject({ reasonCode: "FILE_STAFF_ONLY" });
    grant = "contributor";
    const plan = await files.beginUpload(grantee, orderPublicId, upload);
    const staged = await files.stageUpload("synthetic.wav", Readable.from([exampleWav()]), plan.rules);
    locked = "legal_hold";
    await expect(files.commitUpload(grantee, plan, staged)).rejects.toMatchObject({ code: "LOCKED" });
    locked = "none";
    orderStage = "concierge";
    await expect(files.commitUpload(grantee, plan, staged)).rejects.toMatchObject({ reasonCode: "ORDER_ACCESS_CHANGED" });
    orderStage = "intake";
    grant = false;
    await expect(files.commitUpload(grantee, plan, staged)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await t.db.select().from(orderFiles)).toEqual([]);
    await files.cleanUpload(staged);
    expect(h.storage.objects.size).toBe(0);
  });

  it("rejects empty, extension/magic mismatch, and disallowed types without retaining staged bytes", async () => {
    const plan = await files.beginUpload(owner, orderPublicId, upload);
    await expect(files.stageUpload("fake.pdf", Readable.from([exampleWav()]), plan.rules)).rejects.toMatchObject({ reasonCode: "FILE_TYPE_MISMATCH" });
    await expect(files.stageUpload("empty.wav", Readable.from([]), plan.rules)).rejects.toMatchObject({ reasonCode: "INVALID_FILE_SIZE" });
    await expect(files.stageUpload("unsafe.svg", Readable.from([Buffer.from("<svg/>")]), plan.rules)).rejects.toMatchObject({ reasonCode: "FILE_TYPE_DISABLED" });
    expect(h.storage.objects.size).toBe(0);
  });

  it("records version chains, honors visibility, and makes remove/restore transactions audit-dependent", async () => {
    const first = await add();
    const next = await add(owner, { ...upload, versionOf: first.publicId });
    expect(next.logicalPublicId).toBe(first.publicId);
    expect(next.version).toBe(2);
    expect((await files.list(owner, orderPublicId, {})).items.map((row) => row.publicId)).toEqual([next.publicId]);
    const page = await files.list(owner, orderPublicId, { includeVersions: true, limit: 1 });
    expect(page.nextCursor).toBeTruthy();
    expect((await files.list(owner, orderPublicId, { includeVersions: true, limit: 1, cursor: page.nextCursor! })).items.length).toBe(1);
    await expect(add(owner, { ...upload, versionOf: first.publicId })).rejects.toMatchObject({ reasonCode: "FILE_VERSION_CHANGED" });
    await files.setVisibility(staff, next.publicId, "staff_only");
    await expect(files.assertCanReadFile(owner, next.publicId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(files.remove(owner, first.publicId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    h.audit.failRecords = true;
    await expect(files.remove(staff, next.publicId)).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    await expect(files.assertCanReadFile(staff, next.publicId)).resolves.toMatchObject({ deletedAt: null });
    h.audit.failRecords = false;
    await files.remove(staff, next.publicId);
    await expect(files.assertCanReadFile(staff, next.publicId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await files.restore(staff, next.publicId);
    await expect(files.assertCanReadFile(staff, next.publicId)).resolves.toMatchObject({ deletedAt: null });
    expect(h.audit.recordedInTx.every(Boolean)).toBe(true);
  });

  it("records object-level write denials after rollback and precise visibility/removal outcomes (review F-1, F-2)", async () => {
    const file = await add();
    await files.setVisibility(staff, file.publicId, "staff_only");
    const changed = h.audit.named("file.visibility.changed");
    expect(changed.map((e) => [e.outcome, e.attributes])).toEqual([["completed", { from_visibility: "customer_visible", to_visibility: "staff_only" }]]);

    await files.remove(staff, file.publicId);
    await files.remove(staff, file.publicId);
    expect(h.audit.named("file.removed").map((e) => [e.outcome, e.reasonCode])).toEqual([["completed", undefined], ["refused", "ALREADY_REMOVED"]]);
    await files.restore(staff, file.publicId);
    expect(h.audit.recordedInTx.every(Boolean)).toBe(true);

    h.audit.recordedInTx = [];
    locked = "legal_hold";
    await expect(files.setVisibility(staff, file.publicId, "customer_visible")).rejects.toMatchObject({ code: "LOCKED" });
    locked = "none";
    orderOwner = grantee; // the file's recorded owner no longer matches the order: object-level refusal inside the tx
    await expect(files.remove(staff, file.publicId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const denied = h.audit.named("file.access.denied");
    expect(denied.map((e) => [e.category, e.outcome, e.action, e.reasonCode, e.resource])).toEqual([
      ["security", "denied", "update", "ORDER_LOCKED", { type: "file", publicId: file.publicId }],
      ["security", "denied", "delete", "FILE_NOT_FOUND", { type: "file", publicId: file.publicId }],
    ]);
    expect(h.audit.recordedInTx).toEqual([false, false]); // durable, after rollback, never on the held transaction
    expect(h.audit.named("file.visibility.changed")).toHaveLength(1);

    h.audit.failRecords = true; // the refusal itself never depends on the denial record
    await expect(files.remove(staff, file.publicId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    h.audit.failRecords = false;
  });

  it("refuses commit without durable audit and requires fresh step-up for type rules", async () => {
    const plan = await files.beginUpload(owner, orderPublicId, upload);
    const staged = await files.stageUpload("synthetic.wav", Readable.from([exampleWav()]), plan.rules);
    h.audit.failRecords = true;
    await expect(files.commitUpload(owner, plan, staged)).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    expect(await t.db.select().from(orderFiles)).toHaveLength(0);
    expect([...h.storage.objects.keys()].every((key) => key.startsWith("staging/"))).toBe(true);
    const admin = fakePrincipal({ role: "admin" });
    await expect(files.setTypeRules(admin, plan.rules)).rejects.toMatchObject({ code: "STEP_UP_REQUIRED" });
    h.audit.failRecords = false;
    await files.setTypeRules({ ...admin, stepUpAt: h.clock.now() }, { ...plan.rules, extensions: ["pdf"] });
    await expect(add()).rejects.toMatchObject({ reasonCode: "FILE_TYPE_DISABLED" });
    expect((await files.adminOverview(admin)).antivirus).toBe("not_configured");
  });

  it("refuses staged objects if the authenticated session was revoked during upload", async () => {
    const plan = await files.beginUpload(owner, orderPublicId, upload);
    const staged = await files.stageUpload("synthetic.wav", Readable.from([exampleWav()]), plan.rules);
    revokedSession = owner.sessionId;
    await expect(files.commitUpload(owner, plan, staged)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(await t.db.select().from(orderFiles)).toHaveLength(0);
    await files.cleanUpload(staged);
  });

  it("rejects rule changes after session revocation or loss of persisted step-up", async () => {
    const admin = fakePrincipal({ role: "admin", stepUpAt: h.clock.now() });
    const { rules } = await files.adminOverview(admin);
    revokedSession = admin.sessionId;
    await expect(files.setTypeRules(admin, { ...rules, extensions: ["pdf"] })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    revokedSession = null;
    persistedAdminStepUp = null;
    await expect(files.setTypeRules(admin, { ...rules, extensions: ["pdf"] })).rejects.toMatchObject({ code: "STEP_UP_REQUIRED" });
    expect((await files.adminOverview(admin)).rules).toEqual(rules);
    expect(h.audit.named("file.rules.changed")).toEqual([]);
  });

  it("requires a configured scan to consume all bytes and fails closed on incomplete scanning", async () => {
    const integrated = createFilesModule(h.deps, { scanner: {
      async health() { return "ok"; },
      async scan() { return "clean"; },
    } });
    const plan = await files.beginUpload(owner, orderPublicId, upload);
    await expect(integrated.stageUpload("synthetic.wav", Readable.from([exampleWav()]), plan.rules))
      .rejects.toMatchObject({ reasonCode: "FILE_SCANNER_UNAVAILABLE" });
    expect(h.storage.objects.size).toBe(0);
    expect(await integrated.health?.()).toEqual(expect.arrayContaining([expect.objectContaining({ component: "files.antivirus", state: "ok" })]));
  });
});

describe("retention custody", () => {
  it("rechecks holds under lock and refuses to unlink without durable intent", async () => {
    const file = await add();
    await files.remove(staff, file.publicId);
    h.clock.advance(31 * 86_400_000);
    const run = async () => {
      await h.jobs.enqueue("files.retention", {});
      return h.jobs.runAll("files.retention");
    };
    holdAtPurgeLock = true;
    await expect(run()).resolves.toMatchObject([{ safeCounts: { purged: 0 } }]);
    expect(h.storage.objects.size).toBe(1);
    expect(h.audit.named("file.retention.purged").map(({ outcome }) => outcome)).toEqual(["attempted"]);
    holdAtPurgeLock = false;
    locked = "none";
    h.audit.failRecords = true;
    await expect(run()).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    expect(h.storage.objects.size).toBe(1);
    h.audit.failRecords = false;
    const originalRecord = h.audit.record.bind(h.audit);
    const record = vi.spyOn(h.audit, "record").mockImplementation(async (event, tx) => {
      if (event.outcome === "completed") {
        throw new DomainError("AUDIT_UNAVAILABLE", "AUDIT_UNAVAILABLE", "Audit is temporarily unavailable.");
      }
      await originalRecord(event, tx);
    });
    await expect(run()).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    expect(h.storage.objects.size).toBe(1);
    record.mockRestore();
    await expect(run()).resolves.toMatchObject([{ safeCounts: { purged: 1 } }]);
    expect(h.storage.objects.size).toBe(0);
    expect((await t.db.select().from(orderFiles))[0]?.purgedAt).toEqual(h.clock.now());
    expect(h.audit.named("file.retention.purged").map(({ outcome }) => outcome)).toEqual(["attempted", "attempted", "attempted", "completed"]);
    expect(h.audit.recordedInTx.slice(-2)).toEqual([false, true]);
  });
});

describe("download ticket custody", () => {
  it("stores only a hash, denies other people/sessions, and redeems exactly once", async () => {
    const file = await add();
    const issued = await files.issueDownloadTicket(owner, file.publicId);
    const [stored] = await t.db.select().from(fileDownloadTickets);
    expect(stored?.tokenHash).toBe(h.deps.crypto.hashToken(issued.ticket));
    expect(stored?.tokenHash).not.toBe(issued.ticket);
    expect(issued.expiresAt.getTime() - h.clock.now().getTime()).toBe(60_000);
    await expect(files.redeemDownloadTicket(stranger, issued.ticket)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(files.redeemDownloadTicket({ ...owner, sessionId: grantee.sessionId }, issued.ticket)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const simultaneous = await Promise.allSettled([files.redeemDownloadTicket(owner, issued.ticket), files.redeemDownloadTicket(owner, issued.ticket)]);
    expect(simultaneous.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const success = simultaneous.find((result) => result.status === "fulfilled")!;
    expect(await buffer(success.value.stream)).toEqual(exampleWav());
    await expect(files.redeemDownloadTicket(owner, issued.ticket)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const logged = await t.db.select().from(fileAccessLog);
    expect(logged.filter((row) => row.outcome === "attempted")).toHaveLength(1);
    expect(logged.filter((row) => row.outcome === "denied")).toHaveLength(4);
  });

  it("rechecks live grants and reassignment, preserves read-only locked reads, and expires tickets at 60 s", async () => {
    const file = await add();
    grant = "viewer";
    const stale = await files.issueDownloadTicket(grantee, file.publicId);
    grant = false;
    await expect(files.redeemDownloadTicket(grantee, stale.ticket)).rejects.toMatchObject({ code: "NOT_FOUND" });
    locked = "imported_read_only";
    const lockedTicket = await files.issueDownloadTicket(owner, file.publicId);
    expect(await buffer((await files.redeemDownloadTicket(owner, lockedTicket.ticket)).stream)).toEqual(exampleWav());
    const expired = await files.issueDownloadTicket(owner, file.publicId);
    h.clock.advance(60_000);
    await expect(files.redeemDownloadTicket(owner, expired.ticket)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const beforeReassign = await files.issueDownloadTicket(owner, file.publicId);
    await t.db.transaction((tx) => files.reassignOrderFiles(orderId, stranger.userId, tx));
    orderOwner = stranger;
    await expect(files.redeemDownloadTicket(owner, beforeReassign.ticket)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(files.assertCanReadFile(stranger, file.publicId)).resolves.toMatchObject({ publicId: file.publicId });
    await expect(files.assertCanReadFile(stranger, `${file.publicId.slice(0, -1)}I`)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns no bytes and retains the unconsumed ticket if the durable access audit fails", async () => {
    const file = await add();
    const { ticket } = await files.issueDownloadTicket(owner, file.publicId);
    h.audit.failRecords = true;
    await request(appFor(owner)).post("/api/files/download").send({ ticket }).expect(503);
    expect(await t.db.select().from(fileAccessLog)).toHaveLength(0);
    expect(await t.db.select().from(fileDownloadTickets)).toHaveLength(1);
    h.audit.failRecords = false;
    expect(await buffer((await files.redeemDownloadTicket(owner, ticket)).stream)).toEqual(exampleWav());
  });

  it("sets safe attachment headers and records the actual HTTP response attempt and result", async () => {
    const file = await add(owner, upload, "Résumé\r\n/X-Synthetic: marker.wav");
    const { ticket } = await files.issueDownloadTicket(owner, file.publicId);
    const result = await request(appFor(owner)).post("/api/files/download").send({ ticket }).expect(200)
      .expect("X-Content-Type-Options", "nosniff").expect("Cache-Control", "no-store").expect("Content-Security-Policy", /sandbox/);
    expect(result.headers["content-disposition"]).toMatch(/^attachment; filename="[^"\r\n]+"; filename\*=UTF-8''/u);
    expect(result.headers).not.toHaveProperty("x-synthetic");
    expect(h.audit.named("file.download").map((event) => event.outcome)).toEqual(["attempted"]);
    // The result is recorded after flushing the response. Wait for the asynchronous result record.
    await vi.waitFor(() => expect(h.audit.named("file.download.result").map((event) => event.outcome)).toEqual(["completed"]));
  });
});

describe("raw multipart admission", () => {
  it("commits strong-format files and distinguishes refused files in one request", async () => {
    const result = await request(appFor(owner)).post(`/api/files/upload/${orderPublicId}`)
      .attach("files", exampleWav(), "good.wav")
      .attach("files", exampleWav(), "misleading.pdf")
      .expect(200);
    expect(result.body).toMatchObject({ results: [
      { index: 0, outcome: "completed", file: { extension: "wav" } },
      { index: 1, outcome: "refused", reason: "FILE_TYPE_MISMATCH" },
    ] });
    expect([...h.storage.objects.keys()].every((key) => key.startsWith("files/"))).toBe(true);
  });

  it("refuses too many or unexpected parts without publishing any bytes", async () => {
    const plan = await files.beginUpload(owner, orderPublicId, upload);
    await files.setTypeRules(fakePrincipal({ role: "admin", stepUpAt: h.clock.now() }), { ...plan.rules, maxFiles: 1 });
    await request(appFor(owner)).post(`/api/files/upload/${orderPublicId}`)
      .attach("files", exampleWav(), "first.wav")
      .attach("files", exampleWav(), "second.wav")
      .expect(400);
    await request(appFor(owner)).post(`/api/files/upload/${orderPublicId}`)
      .field("ownerId", "invalid").attach("files", exampleWav(), "first.wav").expect(400);
    expect(await t.db.select().from(orderFiles)).toHaveLength(0);
    expect(h.storage.objects.size).toBe(0);
  });

  it("refuses excessive per-file and total request sizes without retaining staged bytes", async () => {
    const plan = await files.beginUpload(owner, orderPublicId, upload);
    await files.setTypeRules(fakePrincipal({ role: "admin", stepUpAt: h.clock.now() }), {
      ...plan.rules, maxFileBytes: 1024, maxRequestBytes: 4096,
    });
    const badPart = await request(appFor(owner)).post(`/api/files/upload/${orderPublicId}`)
      .timeout({ response: 3000, deadline: 5000 })
      .attach("files", Buffer.alloc(1026), "too-large.wav").expect(200);
    expect(badPart.body).toMatchObject({ results: [{ outcome: "refused", reason: "FILE_TOO_LARGE" }] });
    const badRequest = await request(appFor(owner)).post(`/api/files/upload/${orderPublicId}`)
      .timeout({ response: 3000, deadline: 5000 })
      .attach("files", Buffer.alloc(5000), "too-large.wav").expect(400);
    expect(badRequest.body).toMatchObject({ reason: "UPLOAD_REQUEST_TOO_LARGE" });
    expect(h.storage.objects.size).toBe(0);
  });
});

describe("portable classification and backup traversal", () => {
  it("reclassifies staged bytes canonically and binds the owner/order on adoption", async () => {
    const admin = fakePrincipal({ role: "admin", stepUpAt: h.clock.now() });
    orderOrigin = "import";
    locked = "imported_read_only";
    const stagedObject = await h.storage.put(h.storage.newKey("staging"), exampleWebm("audio", true));
    const input = {
      principal: admin, orderId, orderPublicId, ownerUserId: owner.userId,
      displayName: "browser-capture.webm", category: "intake_attachment" as const, visibility: "customer_visible" as const,
      stagedObject, destinationKey: h.storage.newKey("files"), contentType: "video/webm",
      createdAt: new Date("2025-07-01T13:00:00.000Z"),
    };
    await expect(files.validatePortableObject(input)).resolves.toEqual({ extension: "webm", contentType: "audio/webm" });
    await expect(t.db.transaction((tx) => files.adoptVerifiedObject({ ...input, ownerUserId: stranger.userId }, tx))).rejects.toMatchObject({ code: "NOT_FOUND" });
    const settingGet = vi.spyOn(h.deps.settings, "get");
    const imported = await t.db.transaction(async (tx) => {
      const file = await files.adoptVerifiedObject(input, tx);
      expect(settingGet.mock.calls[0]?.[3]).toBe(tx);
      const auditSpy = vi.spyOn(h.deps.audit, "record");
      const opened = await files.openForExport(admin, file.publicId, orderPublicId, tx);
      expect(auditSpy.mock.calls.at(-1)?.[1]).toBe(tx);
      expect(await buffer(opened.stream)).toEqual(exampleWebm("audio", true));
      return file;
    });
    expect(imported.contentType).toBe("audio/webm");
    expect(imported.createdAt).toEqual(input.createdAt);
    const exported = await t.db.transaction((tx) => files.portableFiles(tx, { principal: admin, limit: 10 }));
    expect(exported.items[0]).toMatchObject({ publicId: imported.publicId, ownerPublicId: userPublicId, contentType: "audio/webm" });
    const collected = await t.db.transaction((tx) => files.backupFiles(tx, { limit: 10 }));
    expect(collected.items[0]).toMatchObject({ sha256: stagedObject.sha256, storageKey: input.destinationKey });
  });
});
