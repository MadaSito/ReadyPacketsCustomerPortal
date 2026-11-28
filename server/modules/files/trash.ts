import { and, count, eq, gt, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import { DomainError } from "../../core/errors.js";
import type { Tx } from "../../core/types.js";
import { auditExports } from "../audit/schema.js";
import { users } from "../identity/schema.js";
import { keyHash } from "../jobs/queue.js";
import { jobRuns } from "../jobs/schema.js";
import { knowledgeArticleAttachments } from "../knowledge/schema.js";
import { orders } from "../orders/schema.js";
import { platformPresentationImages } from "../platform/schema.js";
import { portableExports } from "../portable/schema.js";
import type { TrashEntityRef, TrashParticipant } from "../trash/ports.js";
import { fileArchives, fileArchiveTickets } from "./archivesSchema.js";
import { audioJob } from "./audio.js";
import { fileDownloadTickets, filePlaybackGrants, orderFiles } from "./schema.js";

export const archiveObjectAad = (id: string) => `file_archives.object_key:${id}`;
const fileKey = /^files\/[a-f0-9]{32}$/u;
const zipKey = /^exports\/[a-f0-9]{32}$/u;
const batchSize = 100;
const unavailable = (code: string) => new DomainError("UNAVAILABLE", code, "File deletion could not be verified. Try deletion again.");

async function removeVerified(storage: ModuleDeps["storage"], key: string) {
  await storage.delete(key);
  if (await storage.stat(key)) throw unavailable("FILE_TRASH_OBJECT_REMAINS");
}

export async function removeUnsharedArchive(deps: ModuleDeps, row: Pick<typeof fileArchives.$inferSelect, "id" | "publicId" | "objectKeyEnc">, tx?: Tx) {
  const { storage, crypto } = deps;
  const db = tx ?? deps.db;
  const key = crypto.decrypt(row.objectKeyEnc!, archiveObjectAad(row.publicId));
  if (!zipKey.test(key)) throw unavailable("FILE_TRASH_OBJECT_INVALID");
  const [audit] = await db.select({ id: auditExports.id }).from(auditExports).where(eq(auditExports.objectKey, key)).limit(1);
  const [portable] = await db.select({ id: portableExports.id }).from(portableExports).where(eq(portableExports.storageKey, key)).limit(1);
  if (audit || portable) return false;
  let after = 0;
  for (;;) {
    const rows = await db.select({ id: fileArchives.id, publicId: fileArchives.publicId, objectKeyEnc: fileArchives.objectKeyEnc })
      .from(fileArchives).where(and(gt(fileArchives.id, after), ne(fileArchives.id, row.id),
        isNotNull(fileArchives.objectKeyEnc), isNull(fileArchives.purgedAt))).orderBy(fileArchives.id).limit(batchSize);
    for (const other of rows) {
      if (crypto.decrypt(other.objectKeyEnc!, archiveObjectAad(other.publicId)) === key) return false;
    }
    if (rows.length < batchSize) break;
    after = rows.at(-1)!.id;
  }
  await removeVerified(storage, key);
  return true;
}

export function createFilesTrashParticipant(deps: ModuleDeps): TrashParticipant {
  const { db, storage, services } = deps;
  const scope = (entity: TrashEntityRef) => entity.kind === "order"
    ? and(eq(fileArchives.orderId, Number(entity.id)), eq(fileArchives.orderPublicId, entity.publicId))
    : eq(fileArchives.requestedByUserId, Number(entity.id));
  const files = (entity: TrashEntityRef) =>
    and(eq(orderFiles.orderId, Number(entity.id)), eq(orderFiles.orderPublicId, entity.publicId));

  async function revoke(tx: Tx, entity: TrashEntityRef) {
    const byOrder = entity.kind === "order";
    // Customer tickets on other orders are revoked, but those orders' files remain owned by their orders.
    await tx.delete(fileDownloadTickets).where(byOrder ? eq(fileDownloadTickets.orderId, Number(entity.id))
      : eq(fileDownloadTickets.userId, Number(entity.id)));
    await tx.delete(filePlaybackGrants).where(byOrder ? eq(filePlaybackGrants.orderId, Number(entity.id))
      : eq(filePlaybackGrants.userId, Number(entity.id)));
    await tx.delete(fileArchiveTickets).where(inArray(fileArchiveTickets.archiveId,
      tx.select({ id: fileArchives.id }).from(fileArchives).where(scope(entity))));
    await tx.update(fileArchives).set({ state: "revoked", activeUserId: null, reasonCode: "ARCHIVE_ORDER_TRASHED",
      version: sql`${fileArchives.version} + 1` })
      .where(and(scope(entity), inArray(fileArchives.state, ["queued", "building", "ready"])));
  }

  async function purgeArchives(entity: TrashEntityRef) {
    let archives = 0, sharedObjects = 0;
    for (;;) {
      const rows = await db.select().from(fileArchives).where(scope(entity)).orderBy(fileArchives.id).limit(batchSize);
      if (!rows.length) return { archives, sharedObjects };
      for (const row of rows) {
        if (row.jobId) {
          const [job] = await db.select({ state: jobRuns.state }).from(jobRuns).where(eq(jobRuns.publicId, row.jobId)).limit(1);
          if (job?.state === "running") throw unavailable("FILE_TRASH_WORK_IN_FLIGHT");
          if (job?.state === "unknown" && row.objectKeyEnc && !row.builtAt && !row.purgedAt) {
            throw unavailable("FILE_TRASH_ARCHIVE_OUTCOME_UNVERIFIED");
          }
        }
        if (row.objectKeyEnc && !row.purgedAt) {
          if (!await removeUnsharedArchive(deps, row)) sharedObjects += 1;
        }
        await db.delete(fileArchives).where(and(eq(fileArchives.id, row.id), scope(entity)));
        archives += 1;
      }
    }
  }

  return {
    module: "files",
    async onTrashedInTx(tx, entity) {
      await revoke(tx, entity);
      if (entity.kind === "order") await services.storageConnections?.trashOrderCopiesInTx(tx, Number(entity.id), entity.publicId);
    },
    async summarize(entity) {
      const [archive] = await db.select({ total: count() }).from(fileArchives).where(and(scope(entity), isNull(fileArchives.purgedAt)));
      if (entity.kind === "customer") return { files: 0, recordings: 0, archives: archive?.total ?? 0 };
      const [rows] = await db.select({ files: count(), recordings: count(sql`CASE WHEN ${orderFiles.contentType} LIKE 'audio/%' THEN 1 END`) })
        .from(orderFiles).where(and(files(entity), isNull(orderFiles.purgedAt), isNull(orderFiles.deletedAt),
          isNull(orderFiles.supersededAt), isNull(orderFiles.derivedFromPublicId)));
      return { files: rows?.files ?? 0, recordings: rows?.recordings ?? 0, archives: archive?.total ?? 0 };
    },
    async purge(entity, run) {
      const table = entity.kind === "order" ? orders : users;
      const [fence] = await db.select({ id: table.id }).from(table).where(and(eq(table.id, Number(entity.id)),
        eq(table.publicId, entity.publicId), eq(table.trashBatchId, entity.batchId),
        isNotNull(table.purgeStartedAt), isNotNull(table.trashedAt), isNull(table.purgedAt)));
      if (!fence) throw unavailable("FILE_TRASH_FENCE_INVALID");
      await db.transaction((tx) => revoke(tx, entity));
      const zip = await purgeArchives(entity);
      let deletedFiles = 0, recordings = 0, sharedObjects = zip.sharedObjects;
      let copies = { deleted: 0, external: 0, shared: 0, receipts: 0, providerRecycleBin: 0,
        unverifiedExternalCopies: {} as Record<string, number>, acknowledgedExternalCopies: {} as Record<string, number> };
      if (entity.kind === "order") {
        copies = await services.storageConnections.purgeOrderCopies(Number(entity.id), entity.publicId, run);
        for (;;) {
          const rows = await db.select().from(orderFiles).where(files(entity)).orderBy(orderFiles.id).limit(batchSize);
          if (!rows.length) break;
          for (const row of rows) {
            const [job] = await db.select({ id: jobRuns.id }).from(jobRuns).where(and(eq(jobRuns.type, audioJob),
              eq(jobRuns.idempotencyHash, keyHash(`file-audio:${row.publicId}`)), eq(jobRuns.state, "running"))).limit(1);
            if (job) throw unavailable("FILE_TRASH_WORK_IN_FLIGHT");
            if (!row.purgedAt) {
              if (!fileKey.test(row.storageKey)) throw unavailable("FILE_TRASH_OBJECT_INVALID");
              const [knowledge] = await db.select({ id: knowledgeArticleAttachments.id }).from(knowledgeArticleAttachments)
                .where(eq(knowledgeArticleAttachments.storageKey, row.storageKey)).limit(1);
              const [brand] = await db.select({ id: platformPresentationImages.id }).from(platformPresentationImages)
                .where(eq(platformPresentationImages.storageKey, row.storageKey)).limit(1);
              if (knowledge || brand) sharedObjects += 1;
              else await removeVerified(storage, row.storageKey);
            }
            await db.delete(orderFiles).where(and(eq(orderFiles.id, row.id), files(entity)));
            deletedFiles += 1;
            if (!row.derivedFromPublicId && row.contentType.startsWith("audio/")) recordings += 1;
          }
        }
      }
      const destinations = Object.entries(copies.unverifiedExternalCopies);
      const acknowledged = Object.entries(copies.acknowledgedExternalCopies);
      return { deleted: { files: deletedFiles, recordings, archives: zip.archives, storageCopies: copies.deleted },
        kept: { sharedFileObjects: sharedObjects, externalCopies: copies.external, sharedCopies: copies.shared, receiptCopies: copies.receipts,
          providerRecycleBin: copies.providerRecycleBin, unverifiedExternalCopies: destinations.reduce((total, [, count]) => total + count, 0),
          acknowledgedExternalCopies: acknowledged.reduce((total, [, count]) => total + count, 0),
          ...Object.fromEntries(destinations.map(([id, count]) => [`unverifiedExternalCopies.${id}`, count])),
          ...Object.fromEntries(acknowledged.map(([id, count]) => [`acknowledgedExternalCopies.${id}`, count])) } };
    },
  };
}
