import { and, count, eq, gt, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import { DomainError } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { Tx } from "../../core/types.js";
import { orderFiles } from "../files/schema.js";
import { jobRuns } from "../jobs/schema.js";
import { readObjectRef } from "./adapters/objectProtocol.js";
import type { StorageAdapter } from "./contracts.js";
import { COPY_EXTERNAL, COPY_OWNED, COPY_TRASHED } from "./fileCopies.js";
import { storageConnections as connections, storageCopyAttempts as attempts, storageFileCopies as legacy, storageManagedFileCopies as managed, storageManagedOrderRoots } from "./schema.js";

type Legacy = typeof legacy.$inferSelect;
type Managed = typeof managed.$inferSelect;
type Connection = typeof connections.$inferSelect;
const batchSize = 100;
const managedAad = (id: string) => `storage_managed_file_copies.remote_id_enc:${id}`;
const legacyAad = (id: string) => `storage_file_copies.remote_id_enc:${id}`;
const unavailable = (code: string) => new DomainError("UNAVAILABLE", code, "A storage copy could not be removed safely. Resolve its destination or outcome and try again.");
const legacyNotWritten = new Set(["STORAGE_COPY_SOURCE_INACTIVE", "STORAGE_ASSIGNMENT_INACTIVE",
  "STORAGE_LOCAL_READ_FAILED", "STORAGE_LOCAL_INTEGRITY_MISMATCH", "STORAGE_FOLDER_INVALID", COPY_TRASHED]);
const managedNotWritten = new Set(["STORAGE_COPY_SOURCE_INACTIVE", "STORAGE_FILE_SYNC_TARGET_INACTIVE",
  "STORAGE_FILE_SYNC_FOLDER_INVALID", "STORAGE_FILE_SYNC_DESTINATION_CONFLICT", COPY_TRASHED]);
const unverifiedExternal = "STORAGE_TRASH_EXTERNAL_UNVERIFIED";
const providerRecycleBin = "STORAGE_TRASH_PROVIDER_RECYCLE_BIN";

export function createTrashCopies(deps: ModuleDeps, adapterFor: (row: Connection) => StorageAdapter) {
  const { clock, db, crypto } = deps;
  const scopedFiles = (tx: typeof db | Tx, id: number, publicId: string) =>
    tx.select({ publicId: orderFiles.publicId }).from(orderFiles)
      .where(and(eq(orderFiles.orderId, id), eq(orderFiles.orderPublicId, publicId)));
  const managedScope = (id: string) => and(eq(managed.orderPublicId, id), ne(managed.role, "receipt"));

  function decode(row: Legacy | Managed) {
    return crypto.decrypt(row.remoteIdEnc!, "role" in row ? managedAad(row.publicId) : legacyAad(row.publicId));
  }

  async function isShared(tx: Tx, row: Legacy | Managed, remoteId: string, connection: Connection) {
    // IDs can be equal across different provider roots or aliases of the same root. Search all connections of
    // this provider, and prefer preserving the object if ownership of a duplicate ID cannot be separated.
    for (const table of [legacy, managed] as const) {
      let after = 0;
      for (;;) {
        const rows = await tx.select({ publicId: table.publicId, id: table.id, remoteIdEnc: table.remoteIdEnc })
          .from(table).innerJoin(connections, eq(connections.publicId, table.connectionPublicId))
          .where(and(gt(table.id, after), eq(connections.kind, connection.kind), isNotNull(table.remoteIdEnc),
            ne(table.publicId, row.publicId))).orderBy(table.id).limit(batchSize);
        for (const other of rows) {
          const reference = crypto.decrypt(other.remoteIdEnc!, table === managed ? managedAad(other.publicId) : legacyAad(other.publicId));
          if (remoteId === reference) return true;
          if (connection.kind === "s3" || connection.kind === "azure_blob") {
            const target = readObjectRef(remoteId), candidate = readObjectRef(reference);
            if (target.key === candidate.key && (target.version === undefined || candidate.version === undefined || target.version === candidate.version)) return true;
          }
        }
        if (rows.length < batchSize) break;
        after = rows.at(-1)!.id;
      }
    }
    return false;
  }

  async function remove(tx: Tx, row: Legacy | Managed): Promise<"deleted" | "external" | "shared" | "providerRecycleBin" | "unverifiedExternal"> {
    const isLegacy = !("role" in row);
    if (!row.remoteIdEnc) {
      if (row.state === "copying") throw unavailable("STORAGE_TRASH_WORK_IN_FLIGHT");
      if (row.state === "queued" && (isLegacy ? row.attempts === 0 : row.reasonCode === null)) return "deleted";
      if ((isLegacy ? legacyNotWritten : managedNotWritten).has(row.reasonCode ?? "")) return "deleted";
      throw unavailable("STORAGE_TRASH_OUTCOME_UNVERIFIED");
    }
    if (isLegacy && row.reasonCode === COPY_EXTERNAL) return "external";
    const [connection] = await tx.select().from(connections).where(eq(connections.publicId, row.connectionPublicId)).for("update");
    if (!connection || connection.destinationVersion !== row.destinationVersion) return "unverifiedExternal";
    if (!connection.credentialsEnc) throw unavailable("STORAGE_TRASH_DESTINATION_UNAVAILABLE");
    // Historical S3 and Graph copies could adopt a pre-existing matching object without recording ownership.
    if (isLegacy && row.reasonCode !== COPY_OWNED && ["s3", "azure_blob", "dropbox", "sharepoint", "onedrive"].includes(connection.kind)) {
      return "unverifiedExternal";
    }
    const remoteId = decode(row);
    if (await isShared(tx, row, remoteId, connection)) return "shared";
    try {
      const result = await adapterFor(connection).remove(remoteId, AbortSignal.timeout(30_000));
      if (result?.providerRecycleBin) return "providerRecycleBin";
    } catch {
      throw unavailable("STORAGE_TRASH_DELETE_UNVERIFIED");
    }
    return "deleted";
  }

  async function recordKept(tx: Tx, orderPublicId: string, row: Legacy | Managed, outcome: Awaited<ReturnType<typeof remove>>) {
    if (outcome !== "unverifiedExternal" && outcome !== "providerRecycleBin") return;
    const now = clock.now();
    // Commit the non-content disposition with the pointer removal so a resumed purge cannot lose the
    // operational handoff. No provider path, locator, filename or credentials are retained.
    await tx.insert(attempts).values({ publicId: ulid(now.getTime()), kind: "order_file",
      sourcePublicId: "role" in row ? row.sourcePublicId : row.filePublicId, orderPublicId,
      connectionPublicId: row.connectionPublicId, jobPublicId: `trash-copy:${row.publicId}`, attempt: 1,
      state: "not_written", errorCode: outcome === "unverifiedExternal" ? unverifiedExternal : providerRecycleBin,
      createdAt: now, finishedAt: now,
    });
  }

  return {
    async trashOrderCopiesInTx(tx: Tx, orderId: number, orderPublicId: string) {
      // Do not hold queue locks while holding the order lock; running workers lock their job first. The
      // order gate fences those workers; marking untouched legacy copies skipped prevents later retries.
      await tx.update(legacy).set({ state: "skipped", reasonCode: COPY_TRASHED, finishedAt: clock.now(), updatedAt: clock.now() })
        .where(and(inArray(legacy.filePublicId, scopedFiles(tx, orderId, orderPublicId)), eq(legacy.state, "queued"), eq(legacy.attempts, 0)));
      await tx.update(managed).set({ state: "blocked", reasonCode: COPY_TRASHED, finishedAt: clock.now(), updatedAt: clock.now() })
        .where(and(eq(managed.orderPublicId, orderPublicId), eq(managed.state, "queued"),
          sql`NOT EXISTS (SELECT 1 FROM ${jobRuns} WHERE ${jobRuns.publicId} = ${managed.jobPublicId} AND ${jobRuns.state} IN ('running','unknown'))`));
    },
    async purgeOrderCopies(orderId: number, orderPublicId: string) {
      const result = { deleted: 0, external: 0, shared: 0, receipts: 0, providerRecycleBin: 0, unverifiedExternalCopies: {} as Record<string, number> };
      function track(outcome: Awaited<ReturnType<typeof remove>> | undefined) {
        if (!outcome || outcome === "unverifiedExternal") return;
        if (outcome === "providerRecycleBin") result.deleted += 1;
        else result[outcome] += 1;
      }
      for (;;) {
        const rows = await db.select({ id: legacy.id }).from(legacy)
          .where(inArray(legacy.filePublicId, scopedFiles(db, orderId, orderPublicId))).orderBy(legacy.id).limit(batchSize);
        if (!rows.length) break;
        for (const { id } of rows) {
          const disposition = await db.transaction(async (tx) => {
            const [row] = await tx.select().from(legacy)
              .where(and(eq(legacy.id, id), inArray(legacy.filePublicId, scopedFiles(tx, orderId, orderPublicId)))).for("update");
            if (!row) return;
            if (!row.remoteIdEnc && row.reasonCode !== COPY_TRASHED) {
              const [inFlight] = await tx.select({ id: jobRuns.id }).from(attempts)
                .innerJoin(jobRuns, eq(jobRuns.publicId, attempts.jobPublicId))
                .where(and(eq(attempts.kind, "order_file"), eq(attempts.sourcePublicId, row.filePublicId),
                  eq(attempts.connectionPublicId, row.connectionPublicId), eq(jobRuns.state, "running"))).limit(1);
              if (inFlight) throw unavailable("STORAGE_TRASH_WORK_IN_FLIGHT");
            }
            const outcome = await remove(tx, row);
            await recordKept(tx, orderPublicId, row, outcome);
            await tx.delete(legacy).where(eq(legacy.id, id));
            return outcome;
          }, { isolationLevel: "read committed" });
          track(disposition);
        }
      }
      for (;;) {
        const rows = await db.select({ id: managed.id }).from(managed).where(managedScope(orderPublicId)).orderBy(managed.id).limit(batchSize);
        if (!rows.length) break;
        for (const { id } of rows) {
          const disposition = await db.transaction(async (tx) => {
            const [row] = await tx.select().from(managed).where(and(eq(managed.id, id), managedScope(orderPublicId))).for("update");
            if (!row) return;
            if (row.jobPublicId && !row.remoteIdEnc) {
              const [job] = await tx.select({ state: jobRuns.state }).from(jobRuns).where(eq(jobRuns.publicId, row.jobPublicId));
              if (job?.state === "running") throw unavailable("STORAGE_TRASH_WORK_IN_FLIGHT");
              if (job?.state === "unknown" && row.reasonCode !== COPY_TRASHED) throw unavailable("STORAGE_TRASH_OUTCOME_UNVERIFIED");
            }
            const outcome = await remove(tx, row);
            await recordKept(tx, orderPublicId, row, outcome);
            await tx.delete(managed).where(eq(managed.id, id));
            return outcome;
          }, { isolationLevel: "read committed" });
          track(disposition);
        }
      }
      const receipts = await db.select({ id: managed.id }).from(managed)
        .where(and(eq(managed.orderPublicId, orderPublicId), eq(managed.role, "receipt")));
      result.receipts = receipts.length;
      if (!result.receipts) await db.delete(storageManagedOrderRoots).where(eq(storageManagedOrderRoots.orderPublicId, orderPublicId));
      // Retain evidence (outcome, provider, reason, job and correlation) without keeping working path text.
      await db.update(attempts).set({ targetPathEnc: null, phaseLabelEnc: null })
        .where(and(eq(attempts.kind, "order_file"),
          sql`(${attempts.orderPublicId} = ${orderPublicId} OR ${attempts.sourcePublicId} IN (${scopedFiles(db, orderId, orderPublicId)}))`));
      const retained = await db.select({ connection: attempts.connectionPublicId, reason: attempts.errorCode, total: count() })
        .from(attempts).where(and(eq(attempts.orderPublicId, orderPublicId), inArray(attempts.errorCode, [unverifiedExternal, providerRecycleBin])))
        .groupBy(attempts.connectionPublicId, attempts.errorCode);
      for (const row of retained) {
        if (row.reason === unverifiedExternal) result.unverifiedExternalCopies[row.connection] = row.total;
        else result.providerRecycleBin += row.total;
      }
      return result;
    },
  };
}
