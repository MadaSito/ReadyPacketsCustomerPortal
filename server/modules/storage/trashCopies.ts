import { and, count, eq, gt, inArray, isNotNull, like, ne, sql } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import { DomainError } from "../../core/errors.js";
import { ULID_PATTERN, ulid } from "../../core/ids.js";
import type { Tx } from "../../core/types.js";
import { orderFiles } from "../files/schema.js";
import { jobRuns } from "../jobs/schema.js";
import type { TrashPurgeRun } from "../trash/ports.js";
import { readObjectRef } from "./adapters/objectProtocol.js";
import { StorageAdapterError, type StorageAdapter, type StorageAdapterErrorCode } from "./contracts.js";
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
const acknowledgedExternal = "STORAGE_TRASH_EXTERNAL_ACKNOWLEDGED";
const blockedExternal = "EXTERNAL_COPIES_UNREACHABLE";
const providerRecycleBin = "STORAGE_TRASH_PROVIDER_RECYCLE_BIN";
const deleteUnverified = "STORAGE_TRASH_DELETE_UNVERIFIED";
const unavailableProvider = new Set<StorageAdapterErrorCode>(["NOT_CONFIGURED", "AUTH_FAILED", "DESTINATION_NOT_FOUND",
  "DESTINATION_DENIED", "EGRESS_DENIED", "PROVIDER_UNAVAILABLE"]);
type Removal = "deleted" | "external" | "shared" | "providerRecycleBin" | "unverifiedExternal" | "unreachable" | "deleteUnverified";
type BlockedCopy = { copy: string; source: string; connection: string };

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

  async function remove(tx: Tx, row: Legacy | Managed, run: TrashPurgeRun): Promise<Removal> {
    const isLegacy = !("role" in row);
    if (!row.remoteIdEnc) {
      if (row.state === "copying") throw unavailable("STORAGE_TRASH_WORK_IN_FLIGHT");
      if (row.state === "queued" && (isLegacy ? row.attempts === 0 : row.reasonCode === null)) return "deleted";
      if ((isLegacy ? legacyNotWritten : managedNotWritten).has(row.reasonCode ?? "")) return "deleted";
      throw unavailable("STORAGE_TRASH_OUTCOME_UNVERIFIED");
    }
    if (row.state !== "copied") throw unavailable("STORAGE_TRASH_OUTCOME_UNVERIFIED");
    if (isLegacy && row.reasonCode === COPY_EXTERNAL) return "external";
    // Historical rows without a recorded ownership outcome must never justify an outbound DELETE.
    if (isLegacy && row.reasonCode !== COPY_OWNED && row.reasonCode !== deleteUnverified) return "unverifiedExternal";
    const ifUnreachable = () => row.reasonCode === deleteUnverified ? "deleteUnverified" : "unreachable";
    const [connection] = await tx.select().from(connections).where(eq(connections.publicId, row.connectionPublicId)).for("update");
    if (!connection?.credentialsEnc || connection.destinationVersion !== row.destinationVersion) return ifUnreachable();
    const remoteId = decode(row);
    if ((connection.kind === "s3" || connection.kind === "azure_blob") && !readObjectRef(remoteId).etag) {
      // A pre-versioning reference does not authorize deleting whatever now occupies the key.
      return "deleteUnverified";
    }
    if (await isShared(tx, row, remoteId, connection)) return "shared";
    // The copy transaction already holds the run fence and pins the destination against rotation. Use a
    // short savepoint to recheck immediately before the adapter, without taking another pooled connection.
    // Do not classify fence loss as a provider error or persist it on the copy.
    await tx.transaction((fenceTx) => run.assertCurrentInTx(fenceTx));
    try {
      const result = await adapterFor(connection).remove(remoteId, AbortSignal.timeout(30_000));
      if (result?.providerRecycleBin) return "providerRecycleBin";
    } catch (error) {
      if (error instanceof StorageAdapterError && unavailableProvider.has(error.code)) return ifUnreachable();
      if (error instanceof DomainError && ["STORAGE_ADAPTER_UNAVAILABLE", "STORAGE_FILE_SYNC_TARGET_INACTIVE",
        "STORAGE_OAUTH_APP_REQUIRED", "STORAGE_OAUTH_AUTHORIZATION_REJECTED",
        "STORAGE_DESTINATION_DENIED", "STORAGE_DESTINATION_NOT_FOUND"].includes(error.reasonCode)) {
        return ifUnreachable();
      }
      return "deleteUnverified";
    }
    return "deleted";
  }

  async function recordKept(tx: Tx, orderPublicId: string, row: Legacy | Managed, outcome: Removal) {
    if (outcome !== "unverifiedExternal" && outcome !== "providerRecycleBin" && outcome !== "unreachable") return;
    if (!ULID_PATTERN.test(row.connectionPublicId)) throw unavailable("STORAGE_TRASH_CONNECTION_INVALID");
    const now = clock.now();
    // Commit the non-content disposition with the pointer removal so a resumed purge cannot lose the
    // operational handoff. No provider path, locator, filename or credentials are retained.
    await tx.insert(attempts).values({ publicId: ulid(now.getTime()), kind: "order_file",
      sourcePublicId: "role" in row ? row.sourcePublicId : row.filePublicId, orderPublicId,
      connectionPublicId: row.connectionPublicId, jobPublicId: `trash-copy:${row.publicId}`, attempt: 1,
      state: "not_written", errorCode: outcome === "unverifiedExternal" ? unverifiedExternal :
        outcome === "unreachable" ? acknowledgedExternal : providerRecycleBin,
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
    async purgeOrderCopies(orderId: number, orderPublicId: string, run: TrashPurgeRun) {
      if (!ULID_PATTERN.test(run.runId)) throw unavailable("STORAGE_TRASH_RUN_INVALID");
      const result = { deleted: 0, external: 0, shared: 0, receipts: 0, providerRecycleBin: 0,
        unverifiedExternalCopies: {} as Record<string, number>, acknowledgedExternalCopies: {} as Record<string, number> };
      const unreachable = new Map<string, number>();
      const pending: BlockedCopy[] = [];
      const prefix = `trash-un:${run.runId}:`;
      const proofScope = and(eq(attempts.kind, "order_file"), eq(attempts.orderPublicId, orderPublicId),
        eq(attempts.errorCode, blockedExternal), like(attempts.jobPublicId, `${prefix}%`));
      const proofId = (copy: string, source: string, connection: string) => `${copy}:${source}:${connection}`;
      const approved = new Set(run.acknowledgedUnreachableCopies === true ?
        (await db.select({ journalId: attempts.jobPublicId, source: attempts.sourcePublicId, connection: attempts.connectionPublicId })
          .from(attempts).where(proofScope))
          .map((row) => proofId(row.journalId.slice(prefix.length), row.source, row.connection)) : []);
      function track(disposition: { outcome: Removal; blocked?: BlockedCopy } | undefined) {
        if (!disposition || disposition.outcome === "unverifiedExternal") return;
        const { outcome, blocked } = disposition;
        if (outcome === "deleteUnverified") throw unavailable(deleteUnverified);
        if (outcome === "unreachable") {
          if (blocked) {
            if (![blocked.copy, blocked.source, blocked.connection].every((id) => ULID_PATTERN.test(id))) {
              throw unavailable("STORAGE_TRASH_CONNECTION_INVALID");
            }
            pending.push(blocked);
            unreachable.set(blocked.connection, (unreachable.get(blocked.connection) ?? 0) + 1);
          }
          return;
        }
        if (outcome === "providerRecycleBin") result.deleted += 1;
        else result[outcome] += 1;
      }
      let after = 0;
      for (;;) {
        const rows = await db.select({ id: legacy.id }).from(legacy)
          .where(and(gt(legacy.id, after), inArray(legacy.filePublicId, scopedFiles(db, orderId, orderPublicId))))
          .orderBy(legacy.id).limit(batchSize);
        if (!rows.length) break;
        after = rows.at(-1)!.id;
        for (const { id } of rows) {
          const disposition = await db.transaction(async (tx) => {
            await run.assertCurrentInTx(tx);
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
            const outcome = await remove(tx, row, run);
            const disposition = { outcome };
            if (outcome === "deleteUnverified") {
              await tx.update(legacy).set({ reasonCode: deleteUnverified, updatedAt: clock.now() }).where(eq(legacy.id, id));
              return disposition;
            }
            if (outcome === "unreachable" && !approved.has(proofId(row.publicId, row.filePublicId, row.connectionPublicId))) {
              return { outcome, blocked: { copy: row.publicId, source: row.filePublicId, connection: row.connectionPublicId } };
            }
            await recordKept(tx, orderPublicId, row, outcome);
            await tx.delete(legacy).where(eq(legacy.id, id));
            return disposition;
          }, { isolationLevel: "read committed" });
          track(disposition);
        }
      }
      after = 0;
      for (;;) {
        const rows = await db.select({ id: managed.id }).from(managed).where(and(gt(managed.id, after), managedScope(orderPublicId)))
          .orderBy(managed.id).limit(batchSize);
        if (!rows.length) break;
        after = rows.at(-1)!.id;
        for (const { id } of rows) {
          const disposition = await db.transaction(async (tx) => {
            await run.assertCurrentInTx(tx);
            const [row] = await tx.select().from(managed).where(and(eq(managed.id, id), managedScope(orderPublicId))).for("update");
            if (!row) return;
            if (row.jobPublicId && !row.remoteIdEnc) {
              const [job] = await tx.select({ state: jobRuns.state }).from(jobRuns).where(eq(jobRuns.publicId, row.jobPublicId));
              if (job?.state === "running") throw unavailable("STORAGE_TRASH_WORK_IN_FLIGHT");
              if (job?.state === "unknown" && row.reasonCode !== COPY_TRASHED) throw unavailable("STORAGE_TRASH_OUTCOME_UNVERIFIED");
            }
            const outcome = await remove(tx, row, run);
            const disposition = { outcome };
            if (outcome === "deleteUnverified") {
              await tx.update(managed).set({ reasonCode: deleteUnverified, updatedAt: clock.now() }).where(eq(managed.id, id));
              return disposition;
            }
            if (outcome === "unreachable" && !approved.has(proofId(row.publicId, row.sourcePublicId, row.connectionPublicId))) {
              return { outcome, blocked: { copy: row.publicId, source: row.sourcePublicId, connection: row.connectionPublicId } };
            }
            await recordKept(tx, orderPublicId, row, outcome);
            await tx.delete(managed).where(eq(managed.id, id));
            return disposition;
          }, { isolationLevel: "read committed" });
          track(disposition);
        }
      }
      // Save the exact blocked set reported by this failure, not a blanket permission for the whole run.
      // Proofs contain no locators and are separate from the durable dispositions for pointers already erased.
      await db.transaction(async (tx) => {
        await run.assertCurrentInTx(tx);
        await tx.delete(attempts).where(proofScope);
        const now = clock.now();
        for (let i = 0; i < pending.length; i += batchSize) {
          await tx.insert(attempts).values(pending.slice(i, i + batchSize).map<typeof attempts.$inferInsert>(({ copy, source, connection }) => ({
            publicId: ulid(now.getTime()), kind: "order_file", sourcePublicId: source, orderPublicId,
            connectionPublicId: connection, jobPublicId: prefix + copy, attempt: 1,
            state: "not_written", errorCode: blockedExternal, createdAt: now, finishedAt: now,
          })));
        }
      });
      if (pending.length) {
        const entries = [...unreachable].sort(([a], [b]) => a.localeCompare(b));
        throw new DomainError("UNAVAILABLE", blockedExternal, "A destination for a known copy is unreachable. Recover the destination or explicitly leave the copies in place.", {
          unreachableCopies: pending.length,
          unreachableCopyCounts: entries.map(([connection, count]) => `${connection}:${count}`),
        });
      }
      const receipts = await db.select({ id: managed.id }).from(managed)
        .where(and(eq(managed.orderPublicId, orderPublicId), eq(managed.role, "receipt")));
      result.receipts = receipts.length;
      await db.transaction(async (tx) => {
        await run.assertCurrentInTx(tx);
        if (!result.receipts) await tx.delete(storageManagedOrderRoots).where(eq(storageManagedOrderRoots.orderPublicId, orderPublicId));
        // Retain evidence (outcome, provider, reason, job and correlation) without keeping working path text.
        await tx.update(attempts).set({ targetPathEnc: null, phaseLabelEnc: null })
          .where(and(eq(attempts.kind, "order_file"),
            sql`(${attempts.orderPublicId} = ${orderPublicId} OR ${attempts.sourcePublicId} IN (${scopedFiles(tx, orderId, orderPublicId)}))`));
      });
      const retained = await db.select({ connection: attempts.connectionPublicId, reason: attempts.errorCode, total: count() })
        .from(attempts).where(and(eq(attempts.orderPublicId, orderPublicId),
          inArray(attempts.errorCode, [unverifiedExternal, acknowledgedExternal, providerRecycleBin])))
        .groupBy(attempts.connectionPublicId, attempts.errorCode);
      for (const row of retained) {
        if (row.reason === unverifiedExternal) result.unverifiedExternalCopies[row.connection] = row.total;
        else if (row.reason === acknowledgedExternal) result.acknowledgedExternalCopies[row.connection] = row.total;
        else result.providerRecycleBin += row.total;
      }
      return result;
    },
  };
}
