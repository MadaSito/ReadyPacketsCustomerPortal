import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { int, mysqlTable } from "drizzle-orm/mysql-core";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { createTestDeps, fakePrincipal, type TestHarness } from "../../../tests/helpers/fakes.js";
import { DomainError, notFound } from "../../core/errors.js";
import { sanitiseAttribute } from "../audit/envelope.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { SessionPrincipal, Tx } from "../../core/types.js";
import type { StageGovernance, StageUploadIntent } from "../../../shared/workflowStages.js";
import { setHttpState } from "../../http/requestState.js";
import { registerFilesHttpRoutes } from "./http.js";
import { createFilesModule, type FilesModule, type FileUploadSlot, type UploadOptions } from "./index.js";
import type { ApiCaller, PublicApiProviders } from "../publicApi/ports.js";
import { createObjectStorage } from "./storage.js";
import { fileAccessLog, fileDownloadTickets, filePlaybackGrants, orderFiles } from "./schema.js";
import { exampleDocx, exampleMp4, examplePdf, exampleWav, exampleWebm } from "./fixtures.test-support.js";

const orderPublicId = `01JTEST${"0".repeat(19)}`;
const userPublicId = `01JTEST${"0".repeat(18)}1`;
const orderId = 201;
const lockRows = mysqlTable("test_file_order_locks", { id: int("id").primaryKey() });
const upload: UploadOptions = { category: "supporting", visibility: "customer_visible" };
const voiceSlot: FileUploadSlot = {
  key: "voice_evidence", label: "Voice evidence", kind: "audio", maxCount: 1, allowedTypes: ["wav", "webm"],
  task: { kind: "upload", taskKey: "voice_evidence" }, acceptsUpload: true, acceptsEdit: false,
};
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
let slotEnabled: boolean;
let phaseLocked: boolean;
let acceptanceRequired: boolean;
let agreementRequired: boolean;
let extraSlots: FileUploadSlot[];
  let gateActions: { action: string; statusKey: string | null }[];

beforeAll(async () => {
  t = await createTestDb({ schema: { orderFiles, fileDownloadTickets, filePlaybackGrants, fileAccessLog, lockRows } });
  await t.db.insert(lockRows).values({ id: orderId });
});
afterAll(() => t?.cleanup());
beforeEach(async () => {
  for (const table of [fileDownloadTickets, filePlaybackGrants, fileAccessLog, orderFiles]) await t.db.delete(table);
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
  slotEnabled = false;
  phaseLocked = false;
  acceptanceRequired = false;
  agreementRequired = false;
  extraSlots = [];
  gateActions = [];
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
  const write = async (principal: SessionPrincipal, id: number | string, options?: { tx?: Tx; forUpdate?: boolean }) => {
    if (options?.forUpdate && options.tx) await options.tx.select().from(lockRows).where(eq(lockRows.id, orderId)).for("update");
    const view = await read(principal, id);
    if (locked !== "none") throw new DomainError("LOCKED", "ORDER_LOCKED", "This order is locked.");
    if (view.accessRole === "viewer") throw new DomainError("FORBIDDEN", "GRANT_READ_ONLY", "This grant is read-only.");
    return view;
  };
  h.services.orders = {
    assertCanReadOrder: read, assertCanWriteOrder: write, assertCanReadOrderById: read, assertCanWriteOrderById: write,
    gates: {
      async assertCustomerMayWork({ action, statusKey }: { action: string; statusKey: string | null }) {
        gateActions.push({ action, statusKey });
        if (agreementRequired) throw new DomainError("CONFLICT", "AGREEMENT_REQUIRED", "Accept the order agreement.",
          { policyPublicId: userPublicId, signatureMode: "checkbox" });
        if (acceptanceRequired) throw new DomainError("CONFLICT", "ORDER_ACCEPTANCE_REQUIRED", "Accept the required order policy.");
      },
    },
    async getOrderRefByPublicId(id: string) {
      if (id !== orderPublicId) return null;
      return { id: orderId, publicId: id, name: "Synthetic order", reference: "RP-TEST", ownerUserId: orderOwner.userId, lockState: locked, statusKey: orderStage, workflowVersionId: 1 };
    },
    async getOrderRefById(id: number, tx?: Tx, options?: { forUpdate?: boolean }) {
      if (id !== orderId) return null;
      if (tx && options?.forUpdate && holdAtPurgeLock) locked = "legal_hold";
      return { id, publicId: orderPublicId, name: "Synthetic order", reference: "RP-TEST", ownerUserId: orderOwner.userId, lockState: locked, statusKey: orderStage, workflowVersionId: 1 };
    },
    async getFileUploadSlots(principal: SessionPrincipal, id: string) {
      await write(principal, id);
      return { statusKey: orderStage, slots: phaseLocked ? [] :
        [...(slotEnabled && principal.role === "customer" ? [voiceSlot] : []), ...extraSlots] };
    },
    async assertFileStatusWritable() {
      if (phaseLocked) throw new DomainError("FORBIDDEN", "PHASE_LOCKED", "This phase is locked.");
    },
    async isStatusPhaseLocked() { return phaseLocked; },
    async getFileSlotForCustody() { return slotEnabled ? voiceSlot : null; },
  } as unknown as TestHarness["services"]["orders"];
  h.services.identity = {
    async getUser(userId: number) { return userId === orderOwner.userId ?
      { id: userId, publicId: orderOwner.userPublicId, name: "Synthetic customer", customerRef: "SAMPLE", status: "active" } : null; },
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
      const status = error.code === "AUDIT_UNAVAILABLE" ? 503 : error.code === "NOT_FOUND" ? 404 : error.code === "CONFLICT" ? 409 : 400;
      res.status(status).json({ reason: error.reasonCode, details: error.details });
    } else res.status(500).json({ reason: "INTERNAL" });
  };
  return app.use(errors);
}

describe("private file admission and authorization", () => {
  it("enforces recording task capture, detected audio, duration and platform intersection", async () => {
    const root = await mkdtemp(join(tmpdir(), "rp-files-record-task-"));
    try {
      h.deps.storage = createObjectStorage({ config: { storageDir: root }, logger: h.deps.logger });
      h.deps.config = { ...h.deps.config, ffmpegPath: join(root, "missing-ffmpeg") };
      files = createFilesModule(h.deps);
      h.services.files = files;
      const slot: FileUploadSlot = {
        ...voiceSlot, task: { kind: "record", taskKey: voiceSlot.key }, capture: "record", maxMinutes: 1, allowedTypes: ["wav", "mp4"],
      };
      extraSlots = [slot];
      const options = { ...upload, slotKey: slot.key, statusKey: "intake" };
      await expect(files.beginUpload(owner, orderPublicId, options)).rejects.toMatchObject({ reasonCode: "UPLOAD_TASK_METHOD" });
      await expect(files.recordingPreflight(owner, orderPublicId, slot.key)).resolves.toMatchObject({
        enabled: true, conversionAvailable: false, acceptedTypes: ["wav", "mp4"], maxMinutes: 1,
      });
      const path = `/api/files/upload/${orderPublicId}?slotKey=${slot.key}&statusKey=intake&source=recording`;
      const video = await request(appFor(owner)).post(path).attach("files", exampleMp4("video"), "video.mp4").expect(200);
      expect(video.body.results[0]).toMatchObject({ outcome: "refused", reason: "UPLOAD_RECORDING_TYPE" });
      const tooLong = await request(appFor(owner)).post(path).attach("files", exampleWav(61 * 8000), "long.wav").expect(200);
      expect(tooLong.body.results[0]).toMatchObject({ outcome: "refused", reason: "AUDIO_DURATION_EXCEEDED" });
      const admissible = await request(appFor(owner)).post(path).attach("files", exampleWav(8000), "short.wav").expect(200);
      expect(admissible.body.results[0]).toMatchObject({ outcome: "completed", file: { durationSeconds: 1, conversionState: "converting" } });
      const admin = fakePrincipal({ role: "admin", stepUpAt: h.clock.now() });
      const { rules } = await files.adminOverview(admin);
      await files.setTypeRules(admin, { ...rules, extensions: ["mp4"] });
      await expect(files.recordingPreflight(owner, orderPublicId, slot.key)).resolves.toMatchObject({ acceptedTypes: ["mp4"] });
      await expect(files.countFilesInSlot(orderId, slot.key, undefined, { statusKey: "intake" })).resolves.toBe(1);
    } finally { await rm(root, { force: true, recursive: true }); }
  });

  it("opens authorised Word blobs and saves immutable, linked versions under the current owner, phase and agreement", async () => {
    const initial = await request(appFor(owner)).post(`/api/files/upload/${orderPublicId}`).attach("files", exampleDocx(), "sample.docx").expect(200);
    const source = initial.body.results[0].file.publicId as string;
    const locator = { orderPublicId, filePublicId: source };
    const path = `/api/files/orders/${orderPublicId}/${source}/document`;
    await request(appFor(stranger)).get(path).expect(404);
    const blob = await request(appFor(owner)).get(path).expect(200).expect("Cache-Control", "no-store");
    expect(blob.headers["content-disposition"]).toContain("attachment;");
    expect(Number(blob.headers["content-length"])).toBe(exampleDocx().length);
    grant = "contributor";
    await expect(files.documentStatus(grantee, locator)).resolves.toMatchObject({ canEdit: false });
    agreementRequired = true;
    await expect(files.documentStatus(owner, locator)).resolves.toMatchObject({
      canEdit: false, agreementPolicyPublicId: userPublicId, agreementSignatureMode: "checkbox",
    });
    await request(appFor(owner)).post(path).attach("files", exampleDocx("Refused"), "edited.docx").expect(409);
    agreementRequired = false;
    await request(appFor(owner)).post(path).attach("files", exampleWav(), "misleading.docx").expect(400);
    await request(appFor(owner)).post(path).field("transcript", "not a document field").attach("files", exampleDocx(), "edited.docx").expect(400);
    const result = await request(appFor(owner)).post(path).attach("files", exampleDocx("Edited text"), "edited.docx").expect(200);
    expect(result.body).toMatchObject({ version: 2, derivedFromFileId: source, extension: "docx", visibility: "customer_visible" });
    const versions = await files.listDocumentVersions(owner, locator);
    expect(versions).toHaveLength(2);
    expect(versions).toEqual(expect.arrayContaining([
      expect.objectContaining({ publicId: source, supersededAt: expect.any(Date) }),
      expect.objectContaining({ publicId: result.body.publicId, derivedFromFileId: source, supersededAt: null }),
    ]));
    const original = await files.openDocumentForEditing(owner, locator);
    expect(await buffer(original.stream)).toEqual(exampleDocx());
    await request(appFor(owner)).post(path).attach("files", exampleDocx(), "stale.docx").expect(409);
    expect(h.audit.named("file.edited_version_created")).toHaveLength(1);
    expect(gateActions).toContainEqual({ action: "edit_document", statusKey: "intake" });
  });

  it("keeps a staff task source current when the customer creates a Word response", async () => {
    const task = "review_document";
    const reply = `${task}_reply`;
    extraSlots = [
      { key: task, kind: "document", label: "Source", maxCount: 1, allowedTypes: ["docx"], task: { kind: "document_source", taskKey: task } },
      { key: reply, kind: "document", label: "Reply", maxCount: 5, allowedTypes: ["docx"], acceptsUpload: false, acceptsEdit: true,
        sourceSlotKey: task, task: { kind: "document_reply", taskKey: task } },
    ];
    const initial = await request(appFor(staff)).post(`/api/files/upload/${orderPublicId}?category=deliverable&slotKey=${task}&statusKey=intake`)
      .attach("files", exampleDocx(), "source.docx").expect(200);
    const id = initial.body.results[0].file.publicId as string;
    const plan = await files.beginEditedVersion(owner, { orderPublicId, filePublicId: id, taskKey: task });
    const staged = await files.stageUpload("reply.docx", Readable.from([exampleDocx("Reply")]), plan.rules);
    agreementRequired = true;
    await expect(files.saveEditedVersion(owner, plan, staged)).rejects.toMatchObject({ reasonCode: "AGREEMENT_REQUIRED" });
    agreementRequired = false;
    const saved = await files.saveEditedVersion(owner, plan, staged).finally(() => files.cleanUpload(staged));
    expect(saved).toMatchObject({ category: "supporting", slotKey: reply, version: 1, derivedFromFileId: id });
    await expect(files.assertCanReadFile(owner, id)).resolves.toMatchObject({ supersededAt: null });
    await expect(files.listDocumentVersions(owner, { orderPublicId, filePublicId: id, taskKey: task })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ publicId: saved.publicId, derivedFromFileId: id })]));
    await expect(files.beginEditedVersion(owner, { orderPublicId, filePublicId: id, taskKey: task })).rejects.toMatchObject({ reasonCode: "DOCUMENT_REPLY_EXISTS" });
    await expect(files.countFilesInSlot(orderId, reply, undefined, { statusKey: "intake" })).resolves.toBe(1);
  });

  it("enforces scope, actor, classified slot kind, capacity and phase policy before and after staging", async () => {
    slotEnabled = true;
    const slot = { ...upload, statusKey: "intake", slotKey: "voice_evidence" } as const;
    await expect(files.beginUpload(stranger, orderPublicId, slot)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(files.beginUpload(staff, orderPublicId, slot)).rejects.toMatchObject({ reasonCode: "UPLOAD_SLOT_UNAVAILABLE" });
    await expect(files.beginUpload(owner, orderPublicId, { ...slot, statusKey: "different" }))
      .rejects.toMatchObject({ reasonCode: "UPLOAD_SLOT_STATUS_CHANGED" });
    const plan = await files.beginUpload(owner, orderPublicId, slot);
    await expect(files.stageUpload("not-audio.pdf", Readable.from([examplePdf()]), plan.rules)).rejects.toMatchObject({ reasonCode: "FILE_TYPE_DISABLED" });
    const staged = await files.stageUpload("slot.wav", Readable.from([exampleWav()]), plan.rules);
    phaseLocked = true;
    await expect(files.commitUpload(owner, plan, staged)).rejects.toMatchObject({ reasonCode: "PHASE_LOCKED" });
    phaseLocked = false;
    const original = await files.commitUpload(owner, plan, staged);
    expect(original).toMatchObject({ slotKey: "voice_evidence", statusKey: "intake", conversionState: "converting" });
    expect(h.jobs.enqueued).toContainEqual(expect.objectContaining({ type: "files.audio_conversion", payload: { filePublicId: original.publicId } }));
    await expect(files.countFilesInSlot(orderId, "voice_evidence", undefined, { statusKey: "intake" })).resolves.toBe(1);
    await expect(files.countFilesInSlot(orderId, "voice_evidence", undefined, { statusKey: "new_status" })).resolves.toBe(0);
    await expect(add(owner, slot)).rejects.toMatchObject({ reasonCode: "UPLOAD_SLOT_FULL" });
    const replacement = await add(owner, { ...slot, versionOf: original.publicId });
    expect(replacement).toMatchObject({ version: 2, slotKey: slot.slotKey });
    await expect(files.countFilesInSlot(orderId, "voice_evidence")).resolves.toBe(1);
    await files.remove(staff, replacement.publicId);
    const other = await add(owner, slot);
    await expect(files.restore(staff, replacement.publicId)).rejects.toMatchObject({ reasonCode: "UPLOAD_SLOT_FULL" });
    await files.remove(staff, other.publicId);
    await expect(files.restore(staff, replacement.publicId)).resolves.toMatchObject({ deletedAt: null });
  });

  it("lists only bounded current, customer-visible metadata for a scoped API key", async () => {
    let provider!: PublicApiProviders["orderFiles"];
    Object.assign(h.services, { publicApi: { registerProvider: (name: string, registered: typeof provider) => {
      expect(name).toBe("orderFiles");
      provider = registered;
    } } });
    files.init?.();
    const v1 = await add(owner);
    const v2 = await add(owner, { ...upload, versionOf: v1.publicId });
    const active = await add(owner);
    await add(staff, { ...upload, visibility: "staff_only" });
    const removed = await add(owner);
    await files.remove(staff, removed.publicId);
    const caller: ApiCaller = { kind: "api_key", keyPublicId: orderPublicId, scopes: ["files:read"], requestId: orderPublicId, replay: false };
    const query = { limit: 1, cursor: null, filter: {} };
    await expect(provider.list(orderPublicId, query, { ...caller, scopes: ["orders:read"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(provider.list(v1.publicId, query, caller)).resolves.toBeNull();
    const first = await provider.list(orderPublicId, query, caller);
    expect(first!.nextCursor).not.toBeNull();
    const second = await provider.list(orderPublicId, { ...query, cursor: first!.nextCursor }, caller);
    expect([first!.items[0]!.id, second!.items[0]!.id].sort()).toEqual([v2.publicId, active.publicId].sort());
    expect(second!.nextCursor).toBeNull();
    expect(Object.keys(first!.items[0]!).sort()).toEqual(["category", "contentType", "createdAt", "displayName", "id", "orderId", "size", "version"]);
    orderOwner = stranger;
    await expect(provider.list(orderPublicId, query, caller)).resolves.toEqual({ items: [], nextCursor: null });
  });

  it("keeps the original, adds one verified derivative, and applies custody changes to both", async () => {
    const root = await mkdtemp(join(tmpdir(), "rp-files-audio-"));
    try {
      h.deps.storage = createObjectStorage({ config: { storageDir: root }, logger: h.deps.logger });
      files = createFilesModule(h.deps);
      h.services.files = files;
      const rules = { enabled: true, maxMinutes: 1, bitrateKbps: 48, keepOriginal: true } as const;
      await expect(files.setAudioRules(staff, rules)).rejects.toMatchObject({ code: "FORBIDDEN" });
      const admin = fakePrincipal({ role: "admin", stepUpAt: h.clock.now() });
      await expect(files.setAudioRules(admin, rules)).resolves.toEqual(rules);
      expect(h.audit.named("file.audio.rules.changed")).toHaveLength(1);
      slotEnabled = true;
      const stageOrderFile = vi.fn(async (publicId: string, tx: Tx, scope: { orderPublicId: string }) => {
        expect(scope).toEqual({ orderPublicId });
        await expect(files.getOrderFileCopySource(publicId, tx)).resolves.toMatchObject({
          filePublicId: publicId, orderName: "Synthetic order", orderPublicId, statusKey: "intake", slotKey: "voice_evidence", createdAt: expect.any(Date),
        });
      });
      h.services.storageConnections = { stageOrderFile } as unknown as TestHarness["services"]["storageConnections"];
      const result = await request(appFor(owner)).post(`/api/files/upload/${orderPublicId}?statusKey=intake&slotKey=voice_evidence&source=recording`)
        .field("transcript", "Synthetic audio transcript").attach("files", exampleWav(8000), "source.wav").expect(200);
      const id = result.body.results[0].file.publicId as string;
      expect(stageOrderFile).not.toHaveBeenCalled();
      await t.db.transaction(async (tx) => {
        await expect(files.listOrderFileCopyCandidates(orderPublicId, tx, id)).resolves.toEqual([]);
      });
      expect(gateActions).toEqual([{ action: "record", statusKey: "intake" }, { action: "record", statusKey: "intake" }]);
      expect(h.audit.named("file.uploaded")).toContainEqual(expect.objectContaining({
        orderPublicId, attributes: expect.objectContaining({ file_source: "recording", file_visibility: "customer_visible" }),
      }));
      expect(result.body.results[0]).toMatchObject({ outcome: "completed", file: { conversionState: "converting" } });
      await expect(files.readTranscript(stranger, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(files.readTranscript(owner, id)).resolves.toEqual({ transcript: "Synthetic audio transcript" });
      expect((await t.db.select().from(orderFiles))[0]?.transcriptEnc).not.toContain("Synthetic audio transcript");
      const queued = h.jobs.enqueued.find((entry) => entry.type === "files.audio_conversion")!;
      const execute = h.jobs.handlers.get(queued.type)!;
      const claim = {
        jobId: queued.jobId, correlationId: queued.jobId, payload: queued.payload as never,
        type: queued.type, attempt: 1, fencingToken: 1, signal: new AbortController().signal,
      };
      let fence = 0;
      await expect(execute({ ...claim, assertStillOwned: async () => {
        if (++fence === 3) throw new Error("synthetic lease loss before publication");
      } })).rejects.toThrow("synthetic lease loss");
      expect((await files.list(owner, orderPublicId, {})).items).toHaveLength(1);
      const originalRecord = h.audit.record.bind(h.audit);
      const record = vi.spyOn(h.audit, "record").mockImplementation(async (event, tx) => {
        if (event.eventName === "file.audio.conversion" && event.outcome === "completed") throw new Error("synthetic audit interruption");
        return originalRecord(event, tx);
      });
      try {
        await expect(execute({ ...claim, assertStillOwned: async () => {} })).rejects.toThrow("synthetic audit interruption");
      } finally { record.mockRestore(); }
      expect((await files.list(owner, orderPublicId, {})).items).toHaveLength(1);
      phaseLocked = true;
      await expect(h.jobs.runAll("files.audio_conversion")).resolves.toEqual([{ outcome: "completed", safeCounts: { converted: 1 } }]);
      phaseLocked = false;
      await expect(execute({ ...claim, assertStillOwned: async () => {} })).resolves.toEqual({ outcome: "completed" });
      const found = await files.list(owner, orderPublicId, {});
      const derived = found.items.find((item) => item.derivedFromPublicId === id)!;
      expect(derived).toMatchObject({ contentType: "audio/webm", extension: "webm", slotKey: "voice_evidence" });
      await expect(files.listDeliverableFiles(owner, { orderPublicId })).resolves.toMatchObject({
        items: [expect.objectContaining({ publicId: derived.publicId })],
      });
      expect(stageOrderFile.mock.calls.map(([publicId]) => publicId).filter((publicId) => publicId === derived.publicId)).toHaveLength(1);
      expect(stageOrderFile.mock.calls.map(([publicId]) => publicId)).not.toContain(id);
      expect(found.items.find((item) => item.publicId === id)).toMatchObject({ extension: "wav", conversionState: "converted" });
      await expect(files.list(owner, orderPublicId, { preferConvertedAudio: true })).resolves.toMatchObject({ items: [expect.objectContaining({ publicId: derived.publicId })] });
      await t.db.transaction(async (tx) => {
        await expect(files.listOrderFileCopyCandidates(orderPublicId, tx, id)).resolves.toEqual([derived.publicId]);
        await expect(files.listOrderFileCopyCandidates(orderPublicId, tx)).resolves.toEqual([derived.publicId]);
        await expect(files.listOrderFileCopyMetadata(orderPublicId, [id, derived.publicId], tx)).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ filePublicId: id, displayName: expect.stringContaining("(unconverted)") }),
            expect.objectContaining({ filePublicId: derived.publicId, displayName: expect.stringContaining("(WebM)") }),
          ]),
        );
      });
      await expect(files.countFilesInSlot(orderId, "voice_evidence")).resolves.toBe(1);
      await expect(files.remove(staff, derived.publicId)).rejects.toMatchObject({ reasonCode: "AUDIO_DERIVATIVE_READ_ONLY" });
      await files.setVisibility(staff, id, "staff_only");
      await expect(files.assertCanReadFile(owner, derived.publicId)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(files.readTranscript(owner, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(h.audit.named("file.audio.conversion").map((event) => event.outcome)).toEqual(["attempted", "attempted", "attempted", "completed"]);
      expect(h.audit.named("file.audio.conversion").at(-1)).toMatchObject({
        orderPublicId, attributes: { file_visibility: "customer_visible" },
      });
    } finally { await rm(root, { force: true, recursive: true }); }
  });

  it("keeps the original available when the configured FFmpeg executable does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "rp-files-no-audio-"));
    try {
      h.deps.storage = createObjectStorage({ config: { storageDir: root }, logger: h.deps.logger });
      h.deps.config = { ...h.deps.config, ffmpegPath: join(root, "missing-ffmpeg") };
      files = createFilesModule(h.deps);
      const admin = fakePrincipal({ role: "admin", stepUpAt: h.clock.now() });
      await files.setAudioRules(admin, { enabled: true, maxMinutes: 1, bitrateKbps: 48, keepOriginal: true });
      const stageOrderFile = vi.fn();
      h.services.storageConnections = { stageOrderFile } as unknown as TestHarness["services"]["storageConnections"];
      expect(await files.health?.()).toContainEqual(expect.objectContaining({ component: "files.audio", state: "degraded" }));
      const original = await add(owner);
      expect(stageOrderFile).not.toHaveBeenCalled();
      await expect(h.jobs.runAll("files.audio_conversion")).resolves.toEqual([
        { outcome: "failed", reasonCode: "AUDIO_CONVERSION_UNAVAILABLE", retryable: false },
      ]);
      const list = await files.list(owner, orderPublicId, {});
      expect(list.items).toHaveLength(1);
      expect(list.items[0]).toMatchObject({ publicId: original.publicId, conversionState: "failed", conversionReason: "AUDIO_CONVERSION_UNAVAILABLE" });
      expect(stageOrderFile).toHaveBeenCalledExactlyOnceWith(original.publicId, expect.anything(), { orderPublicId });
      await t.db.transaction(async (tx) => {
        await expect(files.getOrderFileCopySource(original.publicId, tx)).resolves.toMatchObject({ displayName: expect.stringContaining("(unconverted)") });
        await expect(files.listOrderFileCopyCandidates(orderPublicId, tx)).resolves.toEqual([original.publicId]);
      });
      const { ticket } = await files.issueDownloadTicket(owner, original.publicId);
      const download = await files.redeemDownloadTicket(owner, ticket);
      expect(await buffer(download.stream)).toEqual(exampleWav());
    } finally { await rm(root, { force: true, recursive: true }); }
  });
  it("admits only current customer-visible file versions to automation copy batches", async () => {
    await files.setAudioRules(fakePrincipal({ role: "admin", stepUpAt: h.clock.now() }),
      { enabled: false, maxMinutes: 30, bitrateKbps: 128, keepOriginal: true });
    const first = await add();
    const latest = await add(owner, { ...upload, versionOf: first.publicId });
    const privateFile = await add(staff, { ...upload, visibility: "staff_only" });
    expect(latest).toMatchObject({ conversionState: "failed", conversionReason: "AUDIO_CONVERSION_DISABLED" });
    expect(h.audit.named("file.uploaded").map((event) => sanitiseAttribute("file_visibility", event.attributes?.file_visibility)))
      .toEqual(["customer_visible", "customer_visible", "staff_only"]);
    await expect(files.getUploadAutomationContext(privateFile.publicId, t.db)).resolves.toBeNull();
    await expect(files.getUploadAutomationContext(first.publicId, t.db)).resolves.toBeNull();
    await expect(files.getUploadAutomationContext(latest.publicId, t.db)).resolves.toMatchObject({ orderPublicId, category: "supporting" });
    await t.db.transaction(async (tx) => {
      await expect(files.listOrderFileCopyCandidates(orderPublicId, tx)).resolves.toEqual([latest.publicId]);
      await expect(files.listOrderFileCopyCandidates(orderPublicId, tx, latest.publicId)).resolves.toEqual([latest.publicId]);
      await expect(files.listOrderFileCopyCandidates(orderPublicId, tx, first.publicId)).resolves.toBeNull();
      await expect(files.listOrderFileCopyCandidates(orderPublicId, tx, privateFile.publicId)).resolves.toBeNull();
    });
  });

  it("stages cloud copy work in the active upload transaction and rolls back admission if staging fails", async () => {
    const stageOrderFile = vi.fn(async (publicId: string, tx: Tx) => {
      expect((await tx.select().from(orderFiles)).some((candidate) => candidate.publicId === publicId)).toBe(true);
      throw new Error("synthetic outbox failure");
    });
    h.services.storageConnections = { stageOrderFile } as unknown as TestHarness["services"]["storageConnections"];
    const plan = await files.beginUpload(owner, orderPublicId, upload);
    const staged = await files.stageUpload("synthetic.pdf", Readable.from([examplePdf()]), plan.rules);
    await expect(files.commitUpload(owner, plan, staged).finally(() => files.cleanUpload(staged))).rejects.toThrow("synthetic outbox failure");
    expect(stageOrderFile).toHaveBeenCalledOnce();
    expect(await t.db.select().from(orderFiles)).toEqual([]);
    expect(h.storage.objects.size).toBe(0);
  });

  it("stages a clean scanned document with its order and original status, and reports bounded metadata", async () => {
    const scan = vi.fn(async ({ stream }: { stream: Readable }) => {
      await buffer(stream);
      return "clean" as const;
    });
    files = createFilesModule(h.deps, { scanner: { scan, health: async () => "ok" } });
    const stageOrderFile = vi.fn(async (publicId: string, tx: Tx, scope: { orderPublicId: string }) => {
      expect(scan).toHaveBeenCalledOnce();
      expect(scope).toEqual({ orderPublicId });
      await expect(files.getOrderFileCopySource(publicId, tx)).resolves.toMatchObject({
        orderPublicId, orderName: "Synthetic order", filePublicId: publicId, displayName: "clean.pdf", statusKey: "intake", slotKey: null,
      });
    });
    h.services.storageConnections = { stageOrderFile } as unknown as TestHarness["services"]["storageConnections"];
    const plan = await files.beginUpload(owner, orderPublicId, upload);
    const staged = await files.stageUpload("clean.pdf", Readable.from([examplePdf()]), plan.rules);
    const accepted = await files.commitUpload(owner, plan, staged);
    expect(stageOrderFile).toHaveBeenCalledExactlyOnceWith(accepted.publicId, expect.anything(), { orderPublicId });
    orderStage = "production";
    await t.db.transaction(async (tx) => {
      await expect(files.listOrderFileCopyMetadata(orderPublicId, [accepted.publicId], tx)).resolves.toEqual([{
        filePublicId: accepted.publicId, displayName: "clean.pdf", statusKey: "intake", slotKey: null, stageKey: null, sourceAvailable: true,
      }]);
      await expect(files.listOrderFileCopyMetadata(userPublicId, [accepted.publicId], tx)).resolves.toEqual([]);
    });
    await files.remove(staff, accepted.publicId);
    await t.db.transaction(async (tx) => {
      await expect(files.listOrderFileCopyMetadata(orderPublicId, [accepted.publicId], tx)).resolves.toEqual([
        expect.objectContaining({ sourceAvailable: false }),
      ]);
    });
  });

  it("refuses customer upload before staging and rechecks acceptance after bytes have been staged", async () => {
    acceptanceRequired = true;
    await expect(files.list(owner, orderPublicId, {})).resolves.toMatchObject({ canUpload: false, items: [], audio: null });
    await expect(files.beginUpload(owner, orderPublicId, upload)).rejects.toMatchObject({ code: "CONFLICT", reasonCode: "ORDER_ACCEPTANCE_REQUIRED" });
    expect(h.storage.objects.size).toBe(0);
    acceptanceRequired = false;
    const plan = await files.beginUpload(owner, orderPublicId, upload);
    const staged = await files.stageUpload("clean.pdf", Readable.from([examplePdf()]), plan.rules);
    acceptanceRequired = true;
    try {
      await expect(files.commitUpload(owner, plan, staged)).rejects.toMatchObject({ code: "CONFLICT", reasonCode: "ORDER_ACCEPTANCE_REQUIRED" });
    } finally { await files.cleanUpload(staged); }
    expect(await t.db.select().from(orderFiles)).toEqual([]);
    expect(h.storage.objects.size).toBe(0);
    await expect(add(staff)).resolves.toMatchObject({ orderPublicId });
    expect(gateActions).toEqual(Array.from({ length: 4 }, () => ({ action: "upload", statusKey: null })));
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

describe("phase files", () => {
  const stageKey = "intake_phase";
  const documentUpload = { ...upload, stageKey, intent: "document" } as const;
  function setPhase(governance: StageGovernance, { visible = true, teamReview = true }: { visible?: boolean; teamReview?: boolean } = {}) {
    h.services.orders.stages = {
      async resolveStageForUpload(input: { stageKey?: string; intent: StageUploadIntent; actor: SessionPrincipal }) {
        if (!input.stageKey) throw new DomainError("CONFLICT", "STAGE_REQUIRED", "Select a phase.");
        if (input.stageKey !== stageKey) throw notFound("STAGE_NOT_FOUND");
        if (phaseLocked && input.actor.role === "customer") throw new DomainError("FORBIDDEN", "STAGE_LOCKED", "Phase locked.");
        return { stageKey, statusKey: "intake", governance };
      },
      async listForOrder() {
        return { format: 3, stages: [{ key: stageKey, customerLabel: "Intake", staffLabel: "Intake", viewable: visible, governance }], statusToStage: {} };
      },
      async assertStageAccess() { return { stage: { actions: { teamFileReview: teamReview }, governance } }; },
    } as unknown as TestHarness["services"]["orders"]["stages"];
  }
  async function prepare(principal = owner, options: UploadOptions = documentUpload, name = "item.pdf", input = examplePdf()) {
    const plan = await files.beginUpload(principal, orderPublicId, options);
    const staged = await files.stageUpload(name, Readable.from([input]), plan.rules);
    return () => files.commitUpload(principal, plan, staged).finally(() => files.cleanUpload(staged));
  }

  it("binds stable phases and serializes concurrent quota checks before publication", async () => {
    setPhase({ documentCount: 1 });
    await expect(files.beginUpload(owner, orderPublicId, upload)).rejects.toMatchObject({ reasonCode: "STAGE_REQUIRED" });
    await expect(prepare(owner, documentUpload, "voice.wav", exampleWav())).rejects.toMatchObject({ reasonCode: "FILE_TYPE_DISABLED" });
    const [first, second] = await Promise.all([prepare(), prepare()]);
    const results = await Promise.allSettled([first(), second()]);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "fulfilled", value: expect.objectContaining({ stageKey }) }),
      expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ reasonCode: "PHASE_FILE_COUNT_LIMIT" }) }),
    ]));
    expect((await files.list(owner, orderPublicId, { stageKey })).items).toHaveLength(1);
    const [only] = await t.db.select().from(orderFiles);
    expect(only?.stageKey).toBe(stageKey);
    const replace = await prepare(owner, { ...documentUpload, versionOf: only!.publicId });
    await expect(replace()).resolves.toMatchObject({ stageKey, version: 2 });
    const selected = await files.listDeliverableFiles(owner, { orderPublicId, stageKey });
    expect(selected.items.map(({ version }) => version)).toEqual([2]);
    await expect(files.openDeliverableFile(owner, { orderPublicId, stageKey, filePublicId: only!.publicId }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    const current = selected.items[0]!;
    await files.remove(staff, current.publicId);
    const standIn = await (await prepare())();
    await expect(files.restore(staff, current.publicId)).rejects.toMatchObject({ reasonCode: "PHASE_FILE_COUNT_LIMIT" });
    await files.remove(staff, standIn.publicId);
    await expect(files.restore(staff, current.publicId)).resolves.toMatchObject({ stageKey, deletedAt: null });
  });

  it("verifies audio from staged bytes and enforces individual and combined phase limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "rp-phase-audio-"));
    try {
      h.deps.storage = createObjectStorage({ config: { storageDir: root }, logger: h.deps.logger });
      files = createFilesModule(h.deps);
      setPhase({ audioCount: 4, recordingMaxSeconds: 1, totalAudioMaxSeconds: 2 });
      const recording = { ...upload, stageKey, intent: "recording" } as const;
      const prerecorded = { ...upload, stageKey, intent: "prerecorded_audio" } as const;
      await expect((await prepare(owner, recording, "too-long.wav", exampleWav(8001)))())
        .rejects.toMatchObject({ reasonCode: "AUDIO_DURATION_EXCEEDED" });
      await expect((await prepare(owner, recording, "recorded.wav", exampleWav(8000)))())
        .resolves.toMatchObject({ durationSeconds: 1, stageKey });
      await expect((await prepare(owner, prerecorded, "over-total.wav", exampleWav(8001)))())
        .rejects.toMatchObject({ reasonCode: "PHASE_AUDIO_DURATION_LIMIT" });
      await expect((await prepare(owner, prerecorded, "at-total.wav", exampleWav(8000)))())
        .resolves.toMatchObject({ durationSeconds: 1, stageKey });
      await expect(files.recordingPreflight(owner, orderPublicId, undefined, stageKey))
        .resolves.toMatchObject({ enabled: false, maxSeconds: 0 });
    } finally { await rm(root, { force: true, recursive: true }); }
  });

  it("accepts explicit phase document intent over multipart and refuses incomplete bindings", async () => {
    setPhase({});
    const url = `/api/files/upload/${orderPublicId}`;
    await request(appFor(owner)).post(`${url}?stageKey=${stageKey}`)
      .attach("files", examplePdf(), "phase.pdf").expect(400);
    await request(appFor(owner)).post(`${url}?stageKey=${stageKey}&intent=document&source=recording`)
      .attach("files", examplePdf(), "phase.pdf").expect(400);
    const response = await request(appFor(owner)).post(`${url}?stageKey=${stageKey}&intent=document`)
      .attach("files", examplePdf(), "phase.pdf").expect(200);
    expect(response.body.results).toMatchObject([{ outcome: "completed", file: { stageKey } }]);
    const pending = await prepare();
    phaseLocked = true;
    await expect(pending()).rejects.toMatchObject({ reasonCode: "STAGE_LOCKED" });
    expect(h.audit.named("file.uploaded")).toHaveLength(1);
    expect(h.audit.named("file.uploaded")[0]?.attributes).toMatchObject({ stage_key: stageKey, file_source: "document" });
  });

  it("selects only active, authorized bytes and gates team review separately", async () => {
    setPhase({});
    const publicFile = await (await prepare(staff, { ...documentUpload, category: "deliverable" }))();
    const privateFile = await (await prepare(staff, { ...documentUpload, category: "deliverable", visibility: "staff_only" }))();
    const supportFile = await (await prepare())();
    const ids = (list: { items: Array<{ publicId: string }> }) => list.items.map(({ publicId }) => publicId);
    expect(ids(await files.teamFiles(owner, orderPublicId, stageKey))).toEqual([publicFile.publicId]);
    expect(ids(await files.listDeliverableFiles(owner, { orderPublicId, stageKey }))).toEqual([publicFile.publicId, supportFile.publicId].sort());
    await expect(files.openDeliverableFile(owner, { orderPublicId, filePublicId: privateFile.publicId }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    const opened = await files.openDeliverableFile(owner, { orderPublicId, stageKey, filePublicId: publicFile.publicId });
    expect(await buffer(opened.stream)).toEqual(examplePdf());
    expect(h.audit.named("file.deliverable.open")).toHaveLength(1);
    setPhase({}, { teamReview: false });
    await expect(files.teamFiles(owner, orderPublicId, stageKey)).rejects.toMatchObject({ code: "NOT_FOUND" });
    setPhase({}, { visible: false });
    await expect(files.listDeliverableFiles(owner, { orderPublicId, stageKey })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(files.issueDownloadTicket(owner, publicFile.publicId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("playback grant custody and HTTP", () => {
  async function token(filePublicId: string) {
    return files.issuePlaybackTicket(owner, orderPublicId, filePublicId);
  }
  it("rekeys a single-use ticket to a path-scoped cookie and handles only GET ranges", async () => {
    const file = await add();
    const { ticket } = await token(file.publicId);
    expect((await t.db.select().from(filePlaybackGrants))[0]?.tokenHash).toBe(h.deps.crypto.hashToken(ticket));
    await request(appFor({ ...owner, sessionId: grantee.sessionId })).post("/api/files/playback").send({ ticket }).expect(404);
    const app = appFor(owner);
    const opened = await request(app).post("/api/files/playback").send({ ticket }).expect(200);
    const path = `/api/files/playback/${opened.body.grantPublicId as string}`;
    const cookieHeader = (opened.headers["set-cookie"] as unknown as string[])[0]!;
    expect(cookieHeader).toContain(`Path=${path}`);
    expect(cookieHeader).toContain("HttpOnly");
    expect(cookieHeader).toContain("SameSite=Strict");
    expect(cookieHeader).not.toContain(ticket);
    const cookie = cookieHeader.split(";")[0]!;
    await request(app).post("/api/files/playback").send({ ticket }).expect(404);
    await request(app).get(path).set("Range", "bytes=0-3").expect(404);
    await request(appFor(grantee)).get(path).set("Cookie", cookie).expect(404);
    const partial = await request(app).get(path).set("Cookie", cookie).set("Range", "bytes=0-3")
      .buffer(true).parse((res, done) => { void buffer(res).then<void>((body) => done(null, body), (error: Error) => done(error)); })
      .expect(206).expect("Content-Range", `bytes 0-3/${file.size}`).expect("Cache-Control", "private, no-store");
    expect(partial.body).toEqual(exampleWav().subarray(0, 4));
    await vi.waitFor(() => expect(h.audit.named("file.playback.result")).toContainEqual(expect.objectContaining({
      orderPublicId, outcome: "completed", attributes: { bytes_sent: 4 },
    })));
    await request(app).get(path).set("Cookie", cookie).set("Range", "bytes=0-2,4-").expect(416).expect("Content-Range", `bytes */${file.size}`);
    await request(app).head(path).set("Cookie", cookie).set("Range", "bytes=0-3").expect(200).expect("Content-Length", String(file.size));
    await request(app).get(path).set("Cookie", cookie).set("Range", "bytes=0-3").set("If-Range", "\"stale\"")
      .expect(200).expect("Content-Length", String(file.size));
    expect((await t.db.select().from(fileAccessLog)).some((event) =>
      event.action === "playback" && event.orderPublicId === orderPublicId && event.reasonCode === "PLAYBACK_RANGE_INVALID")).toBe(true);
  });

  it("rechecks session and expires or revokes grants on visibility, replacement and removal", async () => {
    const file = await add();
    async function grantFor(fileId: string) { return files.redeemPlaybackTicket(owner, (await token(fileId)).ticket); }
    const first = await grantFor(file.publicId);
    revokedSession = owner.sessionId;
    await expect(files.openPlayback(owner, first.grantPublicId, first.secret, undefined, false)).rejects.toMatchObject({ code: "NOT_FOUND" });
    revokedSession = null;
    h.clock.advance(10 * 60_000);
    await expect(files.openPlayback(owner, first.grantPublicId, first.secret, undefined, false)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const hidden = await grantFor(file.publicId);
    await files.setVisibility(staff, file.publicId, "staff_only");
    await expect(files.openPlayback(owner, hidden.grantPublicId, hidden.secret, undefined, false)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await files.setVisibility(staff, file.publicId, "customer_visible");
    const replaced = await grantFor(file.publicId);
    const next = await add(owner, { ...upload, versionOf: file.publicId });
    await expect(files.openPlayback(owner, replaced.grantPublicId, replaced.secret, undefined, false)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const removed = await grantFor(next.publicId);
    await files.remove(staff, next.publicId);
    await expect(files.openPlayback(owner, removed.grantPublicId, removed.secret, undefined, false)).rejects.toMatchObject({ code: "NOT_FOUND" });
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
