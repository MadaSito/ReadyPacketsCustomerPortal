import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDeps, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { DomainError } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { auditExports } from "../audit/schema.js";
import { users } from "../identity/schema.js";
import { jobRuns } from "../jobs/schema.js";
import { knowledgeArticleAttachments } from "../knowledge/schema.js";
import { orders } from "../orders/schema.js";
import { platformPresentationImages } from "../platform/schema.js";
import { portableExports } from "../portable/schema.js";
import { StorageAdapterError } from "../storage/contracts.js";
import { COPY_OWNED } from "../storage/fileCopies.js";
import { createTrashCopies } from "../storage/trashCopies.js";
import { storageConnections, storageCopyAttempts, storageFileCopies, storageManagedFileCopies, storageManagedOrderRoots } from "../storage/schema.js";
import { unfencedPurgeRunForTests, type TrashEntityRef } from "../trash/ports.js";
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
let remove: ReturnType<typeof vi.fn<(remoteId: string) => Promise<void | { providerRecycleBin: true }>>>;
const run = () => unfencedPurgeRunForTests(ulid());
const fenceLost = () => new DomainError("CONFLICT", "PURGE_FENCE_LOST", "The purge worker was replaced.");
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
  remove = vi.fn<(remoteId: string) => Promise<void | { providerRecycleBin: true }>>(async () => {});
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
  it("leaves Files rows, access grants, and bytes unchanged when the purge worker has been replaced", async () => {
    const f = await file(a), now = h.clock.now();
    await t.db.insert(fileDownloadTickets).values({ orderId: a.id, fileId: f.id, userId: 42,
      sessionId: "synthetic", issuedAt: now, expiresAt: now, tokenHash: "a".repeat(64) });
    const key = h.storage.newKey("exports");
    await h.storage.put(key, Buffer.from("synthetic ZIP"));
    await archive(a, key);
    const assertCurrentInTx = vi.fn(async () => { throw fenceLost(); });
    await expect(trash.purge!(a, unfencedPurgeRunForTests(ulid(), { assertCurrentInTx })))
      .rejects.toMatchObject({ reasonCode: "PURGE_FENCE_LOST" });
    expect(assertCurrentInTx).toHaveBeenCalledTimes(1);
    expect(await h.storage.stat(f.key)).not.toBeNull();
    expect(await h.storage.stat(key)).not.toBeNull();
    expect(await t.db.select().from(fileArchives)).toMatchObject([{ state: "ready", activeUserId: 42 }]);
    expect(await t.db.select().from(orderFiles)).toMatchObject([{ id: f.id }]);
    expect(await t.db.select().from(fileDownloadTickets)).toMatchObject([{ fileId: f.id }]);
  });

  it("rechecks the fence immediately before unlinking ZIP bytes", async () => {
    const key = h.storage.newKey("exports");
    await h.storage.put(key, Buffer.from("synthetic ZIP"));
    const archiveId = await archive(a, key);
    await hook(a);
    const unlink = vi.spyOn(h.storage, "delete");
    const assertCurrentInTx = vi.fn(async () => {}).mockResolvedValueOnce(undefined).mockRejectedValueOnce(fenceLost());
    await expect(trash.purge!(a, unfencedPurgeRunForTests(ulid(), { assertCurrentInTx })))
      .rejects.toMatchObject({ reasonCode: "PURGE_FENCE_LOST" });
    expect(assertCurrentInTx).toHaveBeenCalledTimes(2);
    expect(unlink).not.toHaveBeenCalled();
    expect(await h.storage.stat(key)).not.toBeNull();
    expect(await t.db.select().from(fileArchives)).toMatchObject([{ id: archiveId, state: "revoked" }]);
  });

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
    await expect(trash.purge!(a, { ...run(), acknowledgedUnreachableCopies: true }))
      .rejects.toMatchObject({ reasonCode: "STORAGE_TRASH_WORK_IN_FLIGHT" });
    expect(remove).not.toHaveBeenCalled();
    expect(await h.storage.stat(f.key)).not.toBeNull();
    await t.db.update(storageManagedFileCopies).set({ state: "copied", remoteIdEnc: h.deps.crypto.encrypt(remoteId,
      `storage_managed_file_copies.remote_id_enc:${id}`) }).where(eq(storageManagedFileCopies.publicId, id));
    remove.mockRejectedValueOnce(new StorageAdapterError("OUTCOME_UNKNOWN"));
    await expect(trash.purge!(a, { ...run(), acknowledgedUnreachableCopies: true }))
      .rejects.toMatchObject({ reasonCode: "STORAGE_TRASH_DELETE_UNVERIFIED" });
    expect(await t.db.select().from(storageManagedFileCopies).where(eq(storageManagedFileCopies.publicId, id))).toHaveLength(1);
    await t.db.update(storageConnections).set({ credentialsEnc: null }).where(eq(storageConnections.publicId, connectionPublicId));
    await expect(trash.purge!(a, { ...run(), acknowledgedUnreachableCopies: true }))
      .rejects.toMatchObject({ reasonCode: "STORAGE_TRASH_DELETE_UNVERIFIED" });
    expect(remove).toHaveBeenCalledTimes(1);
    await t.db.update(storageConnections).set({ credentialsEnc: "synthetic" }).where(eq(storageConnections.publicId, connectionPublicId));
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

  it("holds known-owned locators across failed retries and journals an explicit leave-behind by connection", async () => {
    const f = await file(a), now = h.clock.now();
    const rotated = ulid(), offline = ulid();
    await t.db.insert(storageConnections).values([rotated, offline].map((publicId, i) => ({
      publicId, kind: "sharepoint" as const, name: `Synthetic destination ${i}`, config: {},
      credentialsEnc: "synthetic", createdAt: now, updatedAt: now, destinationVersion: i === 0 ? 2 : 1,
    })));
    const leg = ulid(), man = ulid(), remoteId = "synthetic-remote";
    const legacyEnc = h.deps.crypto.encrypt("do-not-send-to-rotated-destination", `storage_file_copies.remote_id_enc:${leg}`);
    const managedEnc = h.deps.crypto.encrypt(remoteId, `storage_managed_file_copies.remote_id_enc:${man}`);
    await t.db.insert(storageFileCopies).values({ publicId: leg, filePublicId: f.publicId,
      connectionPublicId: rotated, destinationVersion: 1, state: "copied", reasonCode: COPY_OWNED,
      createdAt: now, updatedAt: now, remoteIdEnc: legacyEnc });
    await t.db.insert(storageManagedFileCopies).values({ publicId: man, orderPublicId: a.publicId,
      sourcePublicId: f.publicId, connectionPublicId: offline, destinationVersion: 1, role: "originals",
      state: "copied", remoteIdEnc: managedEnc, targetEnc: "synthetic", createdAt: now, updatedAt: now });
    remove.mockRejectedValue(new StorageAdapterError("PROVIDER_UNAVAILABLE"));
    const ref = run();
    for (let i = 0; i < 2; i++) {
      await expect(trash.purge!(a, ref)).rejects.toMatchObject({
        reasonCode: "EXTERNAL_COPIES_UNREACHABLE",
        details: { unreachableCopies: 2, unreachableCopyCounts: [`${rotated}:1`, `${offline}:1`].sort() },
      });
      expect(await t.db.select().from(storageFileCopies)).toMatchObject([{ remoteIdEnc: legacyEnc }]);
      expect(await t.db.select().from(storageManagedFileCopies)).toMatchObject([{ remoteIdEnc: managedEnc }]);
      expect(await h.storage.stat(f.key)).not.toBeNull();
    }
    const late = ulid(), lateFile = await file(a);
    const lateEnc = h.deps.crypto.encrypt("late-copy", `storage_file_copies.remote_id_enc:${late}`);
    await t.db.insert(storageFileCopies).values({ publicId: late, filePublicId: lateFile.publicId,
      connectionPublicId: rotated, destinationVersion: 1, state: "copied", reasonCode: COPY_OWNED,
      createdAt: now, updatedAt: now, remoteIdEnc: lateEnc });
    await expect(trash.purge!(a, { ...ref, acknowledgedUnreachableCopies: true })).rejects.toMatchObject({
      reasonCode: "EXTERNAL_COPIES_UNREACHABLE",
      details: { unreachableCopies: 1, unreachableCopyCounts: [`${rotated}:1`] },
    });
    expect(await t.db.select().from(storageFileCopies)).toMatchObject([{ remoteIdEnc: lateEnc }]);
    const unlink = h.storage.delete.bind(h.storage);
    vi.spyOn(h.storage, "delete").mockImplementationOnce(async (key) => { await unlink(key); throw new Error("synthetic crash"); });
    await expect(trash.purge!(a, { ...ref, acknowledgedUnreachableCopies: true })).rejects.toThrow("synthetic crash");
    expect(await t.db.select().from(storageFileCopies)).toHaveLength(0);
    expect(await t.db.select().from(storageManagedFileCopies)).toHaveLength(0);
    expect(remove.mock.calls.map(([id]) => id)).toEqual([remoteId, remoteId, remoteId]);
    await expect(trash.purge!(a, ref)).resolves.toMatchObject({ deleted: { storageCopies: 0, files: 2 },
      kept: { unverifiedExternalCopies: 0, acknowledgedExternalCopies: 3,
        [`acknowledgedExternalCopies.${rotated}`]: 2, [`acknowledgedExternalCopies.${offline}`]: 1 } });
    expect(await t.db.select().from(storageCopyAttempts)).toMatchObject([
      { targetPathEnc: null, phaseLabelEnc: null, connectionPublicId: rotated },
      { targetPathEnc: null, phaseLabelEnc: null, connectionPublicId: offline },
      { targetPathEnc: null, phaseLabelEnc: null, connectionPublicId: rotated },
    ]);
  });

  it("reports only verified active removal to a provider bin and preserves statutory receipts", async () => {
    const f = await file(a), now = h.clock.now(), connectionPublicId = ulid();
    await t.db.insert(storageConnections).values({ publicId: connectionPublicId, kind: "dropbox", name: "Synthetic destination",
      config: {}, credentialsEnc: "synthetic", createdAt: now, updatedAt: now });
    for (const role of ["originals", "receipt"] as const) {
      const publicId = ulid();
      await t.db.insert(storageManagedFileCopies).values({ publicId, orderPublicId: a.publicId, sourcePublicId: f.publicId,
        connectionPublicId, destinationVersion: 1, role, state: "copied", targetEnc: "synthetic", createdAt: now, updatedAt: now,
        remoteIdEnc: h.deps.crypto.encrypt(`synthetic-${role}`, `storage_managed_file_copies.remote_id_enc:${publicId}`) });
    }
    remove.mockResolvedValueOnce({ providerRecycleBin: true });
    await expect(trash.purge!(a, run())).resolves.toMatchObject({
      deleted: { storageCopies: 1 }, kept: { providerRecycleBin: 1, receiptCopies: 1, acknowledgedExternalCopies: 0 },
    });
    expect(remove.mock.calls.map(([id]) => id)).toEqual(["synthetic-originals"]);
    expect(await t.db.select().from(storageManagedFileCopies)).toMatchObject([{ role: "receipt" }]);
    await expect(trash.purge!(a, run())).resolves.toMatchObject({
      deleted: { storageCopies: 0 }, kept: { providerRecycleBin: 1, receiptCopies: 1 },
    });
  });
});

describe("Storage copy purge fence", () => {
  it("does not call the provider or change the copy journal if the immediate preflight loses its fence", async () => {
    const f = await file(a), now = h.clock.now(), connectionPublicId = ulid();
    await t.db.insert(storageConnections).values({ publicId: connectionPublicId, kind: "sharepoint", name: "Synthetic destination",
      config: {}, credentialsEnc: "synthetic", createdAt: now, updatedAt: now });
    const publicId = ulid();
    const remoteIdEnc = h.deps.crypto.encrypt("synthetic-provider-copy", `storage_managed_file_copies.remote_id_enc:${publicId}`);
    await t.db.insert(storageManagedFileCopies).values({ publicId, orderPublicId: a.publicId, sourcePublicId: f.publicId,
      connectionPublicId, destinationVersion: 1, role: "originals", state: "copied", targetEnc: "synthetic",
      remoteIdEnc, createdAt: now, updatedAt: now });
    const assertCurrentInTx = vi.fn(async () => {}).mockResolvedValueOnce(undefined).mockRejectedValueOnce(fenceLost());
    await expect(h.services.storageConnections.purgeOrderCopies(Number(a.id), a.publicId,
      unfencedPurgeRunForTests(ulid(), { assertCurrentInTx }))).rejects.toMatchObject({ reasonCode: "PURGE_FENCE_LOST" });
    expect(assertCurrentInTx).toHaveBeenCalledTimes(2);
    expect(remove).not.toHaveBeenCalled();
    expect(await t.db.select().from(storageManagedFileCopies)).toMatchObject([{ state: "copied", remoteIdEnc, reasonCode: null }]);
    expect(await t.db.select().from(storageCopyAttempts)).toHaveLength(0);
  });
});
