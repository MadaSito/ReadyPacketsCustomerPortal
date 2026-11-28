import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDeps, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { ulid } from "../../core/ids.js";
import { auditExports } from "../audit/schema.js";
import { users } from "../identity/schema.js";
import { jobRuns } from "../jobs/schema.js";
import { knowledgeArticleAttachments } from "../knowledge/schema.js";
import { orders } from "../orders/schema.js";
import { platformPresentationImages } from "../platform/schema.js";
import { portableExports } from "../portable/schema.js";
import { createTrashCopies } from "../storage/trashCopies.js";
import { storageConnections, storageCopyAttempts, storageFileCopies, storageManagedFileCopies, storageManagedOrderRoots } from "../storage/schema.js";
import type { TrashEntityRef } from "../trash/ports.js";
import { fileArchives, fileArchiveTickets } from "./archivesSchema.js";
import { fileDownloadTickets, filePlaybackGrants, orderFiles } from "./schema.js";
import { archiveObjectAad, createFilesTrashParticipant } from "./trash.js";

const schema = { auditExports, users, jobRuns, knowledgeArticleAttachments, orders, platformPresentationImages, portableExports,
  storageConnections, storageCopyAttempts, storageFileCopies, storageManagedFileCopies, storageManagedOrderRoots,
  fileArchives, fileArchiveTickets, fileDownloadTickets, filePlaybackGrants, orderFiles };
let t: TestDb;
let h: TestHarness;
let trash: ReturnType<typeof createFilesTrashParticipant>;
let a: TrashEntityRef;
let b: TrashEntityRef;
let remove: ReturnType<typeof vi.fn<(remoteId: string) => Promise<void>>>;
const run = () => ({ runId: ulid() });
const hook = (entity: TrashEntityRef) => t.db.transaction((tx) => trash.onTrashedInTx!(tx, entity, { kind: "system", job: "test" }));

beforeAll(async () => { t = await createTestDb({ schema }); });
afterAll(() => t?.cleanup());
beforeEach(async () => {
  for (const table of [...Object.values(schema)].reverse()) await t.db.delete(table);
  h = createTestDeps({ db: t.db });
  const now = h.clock.now();
  a = { kind: "order", id: 111, publicId: ulid(), batchId: ulid() };
  b = { kind: "order", id: 222, publicId: ulid(), batchId: ulid() };
  await t.db.insert(users).values({ id: 42, publicId: ulid(), role: "customer", status: "active", emailEnc: "synthetic",
    emailIndex: "a".repeat(64), nameEnc: "synthetic" });
  await t.db.insert(orders).values([a, b].map((o) => ({
    id: o.id, publicId: o.publicId, reference: `TEST-${o.id}`, ownerUserId: 42, projectName: "Synthetic",
    workflowVersionId: 1, statusKey: "intake", subtotalMinor: 0, totalMinor: 0, currency: "USD" as const,
    ...(o === a ? { trashedAt: now, purgeStartedAt: now, trashBatchId: a.batchId } : {}),
  })));
  remove = vi.fn(async () => {});
  h.services.storageConnections = createTrashCopies(h.deps, () => ({ remove }) as never) as never;
  trash = createFilesTrashParticipant(h.deps);
});

async function file(entity: TrashEntityRef, type = "application/pdf") {
  const publicId = ulid();
  const key = h.storage.newKey("files");
  const { size, sha256 } = await h.storage.put(key, Buffer.from(`synthetic-${publicId}`));
  const [header] = await t.db.insert(orderFiles).values({ publicId, logicalPublicId: publicId, orderId: entity.id,
    orderPublicId: entity.publicId, ownerUserId: 42, uploadedByUserId: 42, storageKey: key,
    displayNameEnc: "synthetic", category: "supporting", visibility: "customer_visible", byteSize: size, sha256,
    contentType: type, extension: type.startsWith("audio/") ? "webm" : "pdf" });
  return { publicId, key, id: Number(header.insertId), sha256, size };
}

async function archive(entity: TrashEntityRef, key: string, requester = 42) {
  const publicId = ulid(), now = h.clock.now();
  const [inserted] = await t.db.insert(fileArchives).values({ publicId, orderId: entity.id, orderPublicId: entity.publicId,
    requestedByUserId: requester, activeUserId: requester, sessionId: "test", scope: "order", state: "ready",
    manifest: [], fileCount: 0, totalBytes: 0, expiresAt: now, builtAt: now,
    objectKeyEnc: h.deps.crypto.encrypt(key, archiveObjectAad(publicId)), createdAt: now });
  return Number(inserted.insertId);
}

describe("Files trash participant", () => {
  it("revokes all scoped links, releases the ZIP slot and preserves another order's file and shared ZIP", async () => {
    const gone = await file(a, "audio/webm");
    const kept = await file(b);
    const zip = h.storage.newKey("exports");
    await h.storage.put(zip, Buffer.from("synthetic ZIP"));
    const goneArchive = await archive(a, zip);
    const keptArchive = await archive(b, zip, 43);
    const now = h.clock.now();
    const link = { userId: 42, sessionId: "test", issuedAt: now, expiresAt: now };
    for (const [f, o, ar, token] of [[gone, a, goneArchive, "a"], [kept, b, keptArchive, "b"]] as const) {
      await t.db.insert(fileDownloadTickets).values({ ...link, orderId: o.id, fileId: f.id, tokenHash: token.repeat(64) });
      await t.db.insert(filePlaybackGrants).values({ ...link, publicId: ulid(), orderId: o.id, fileId: f.id, tokenHash: token.repeat(64) });
      await t.db.insert(fileArchiveTickets).values({ ...link, archiveId: ar, tokenHash: token.repeat(64) });
    }
    await expect(trash.summarize!(a)).resolves.toEqual({ files: 1, recordings: 1, archives: 1 });
    await hook(a);
    expect((await t.db.select().from(fileArchives).where(eq(fileArchives.id, goneArchive)))[0]).toMatchObject({ state: "revoked", activeUserId: null });
    expect((await t.db.select().from(fileDownloadTickets)).map((row) => row.orderId)).toEqual([b.id]);
    expect((await t.db.select().from(filePlaybackGrants)).map((row) => row.orderId)).toEqual([b.id]);
    expect((await t.db.select().from(fileArchiveTickets)).map((row) => row.archiveId)).toEqual([keptArchive]);
    await expect(trash.purge!(a, run())).resolves.toMatchObject({ deleted: { files: 1, recordings: 1, archives: 1 },
      kept: { sharedFileObjects: 1 } });
    expect(await h.storage.stat(gone.key)).toBeNull();
    expect(await h.storage.stat(kept.key)).not.toBeNull();
    expect(await h.storage.stat(zip)).not.toBeNull();
    await expect(trash.purge!(b, run())).rejects.toMatchObject({ reasonCode: "FILE_TRASH_FENCE_INVALID" });
  });

  it("resumes if the process loses its result after unlink and verifies already-missing bytes", async () => {
    const { key, id } = await file(a);
    const unlink = h.storage.delete.bind(h.storage);
    vi.spyOn(h.storage, "delete").mockImplementationOnce(async (k) => { await unlink(k); throw new Error("synthetic crash after unlink"); });
    await expect(trash.purge!(a, run())).rejects.toThrow("synthetic crash");
    expect(await h.storage.stat(key)).toBeNull();
    expect(await t.db.select().from(orderFiles).where(eq(orderFiles.id, id))).toHaveLength(1);
    await expect(trash.purge!(a, run())).resolves.toMatchObject({ deleted: { files: 1 } });
    expect(await t.db.select().from(orderFiles).where(eq(orderFiles.id, id))).toHaveLength(0);
    await expect(trash.purge!(a, run())).resolves.toMatchObject({ deleted: { files: 0 } });
  });

  it("does not touch local bytes or guess a remote key until a copying worker settles", async () => {
    const f = await file(a);
    const other = await file(b);
    const connectionPublicId = ulid();
    const now = h.clock.now();
    await t.db.insert(storageConnections).values({ publicId: connectionPublicId, kind: "sharepoint", name: "Synthetic destination",
      config: {}, credentialsEnc: "synthetic", createdAt: now, updatedAt: now });
    const id = ulid(), otherId = ulid(), remoteId = "known-portal-copy";
    await t.db.insert(storageManagedFileCopies).values([
      { publicId: id, orderPublicId: a.publicId, sourcePublicId: f.publicId, connectionPublicId, destinationVersion: 1,
        role: "originals", state: "copying", targetEnc: "synthetic", createdAt: now, updatedAt: now },
      { publicId: otherId, orderPublicId: b.publicId, sourcePublicId: other.publicId, connectionPublicId, destinationVersion: 1,
        role: "originals", state: "copied", targetEnc: "synthetic", createdAt: now, updatedAt: now,
        remoteIdEnc: h.deps.crypto.encrypt("keep-copy", `storage_managed_file_copies.remote_id_enc:${otherId}`) },
    ]);
    await expect(trash.purge!(a, run())).rejects.toMatchObject({ reasonCode: "STORAGE_TRASH_WORK_IN_FLIGHT" });
    expect(remove).not.toHaveBeenCalled();
    expect(await h.storage.stat(f.key)).not.toBeNull();
    await t.db.update(storageManagedFileCopies).set({ state: "copied", remoteIdEnc: h.deps.crypto.encrypt(remoteId,
      `storage_managed_file_copies.remote_id_enc:${id}`) }).where(eq(storageManagedFileCopies.publicId, id));
    remove.mockRejectedValueOnce(new Error("synthetic provider failure"));
    await expect(trash.purge!(a, run())).rejects.toMatchObject({ reasonCode: "STORAGE_TRASH_DELETE_UNVERIFIED" });
    expect(await t.db.select().from(storageManagedFileCopies).where(eq(storageManagedFileCopies.publicId, id))).toHaveLength(1);
    await expect(trash.purge!(a, run())).resolves.toMatchObject({ deleted: { storageCopies: 1, files: 1 } });
    expect(remove.mock.calls.map(([key]) => key)).toEqual([remoteId, remoteId]);
    expect(await h.storage.stat(other.key)).not.toBeNull();
    expect(await t.db.select().from(storageManagedFileCopies).where(eq(storageManagedFileCopies.publicId, otherId))).toHaveLength(1);
  });

  it("keeps the per-connection external count across a partial purge and never sends its remote locator", async () => {
    const f = await file(a), now = h.clock.now();
    const connectionPublicId = ulid();
    await t.db.insert(storageConnections).values({ publicId: connectionPublicId, kind: "sharepoint", name: "Synthetic destination",
      config: {}, credentialsEnc: "synthetic", createdAt: now, updatedAt: now, destinationVersion: 2 });
    const external = ulid(), unsettled = ulid();
    await t.db.insert(storageFileCopies).values({ publicId: external, filePublicId: f.publicId,
      connectionPublicId, destinationVersion: 1, state: "copied", createdAt: now, updatedAt: now,
      remoteIdEnc: h.deps.crypto.encrypt("never-send-this", `storage_file_copies.remote_id_enc:${external}`) });
    await t.db.insert(storageManagedFileCopies).values({ publicId: unsettled, orderPublicId: a.publicId,
      sourcePublicId: f.publicId, connectionPublicId, destinationVersion: 2, role: "originals", state: "unknown",
      targetEnc: "synthetic", createdAt: now, updatedAt: now });
    await expect(trash.purge!(a, run())).rejects.toMatchObject({ reasonCode: "STORAGE_TRASH_OUTCOME_UNVERIFIED" });
    expect(await t.db.select().from(storageFileCopies)).toHaveLength(0);
    expect(remove).not.toHaveBeenCalled();
    await t.db.update(storageManagedFileCopies).set({ state: "blocked", reasonCode: "STORAGE_COPY_SOURCE_INACTIVE" })
      .where(eq(storageManagedFileCopies.publicId, unsettled));
    await expect(trash.purge!(a, run())).resolves.toMatchObject({
      kept: { unverifiedExternalCopies: 1, [`unverifiedExternalCopies.${connectionPublicId}`]: 1 },
    });
    expect(remove).not.toHaveBeenCalled();
  });
});
