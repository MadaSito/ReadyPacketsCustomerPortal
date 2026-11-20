import { and, asc, desc, eq, isNull, lt, lte } from "drizzle-orm";
import type { Readable } from "node:stream";
import { join } from "node:path";
import type { ModuleDeps } from "../../container.js";
import { conflict, DomainError, notFound, validation } from "../../core/errors.js";
import { ULID_PATTERN, ulid } from "../../core/ids.js";
import type { ClaimedJob, JobResult, SessionPrincipal, Tx } from "../../core/types.js";
import { CustodyError, inPrivateWorkspace, matchBytes, readExactObject, storeValidated } from "./custody.js";
import { collectAndWriteExport } from "./collectors/index.js";
import { portableExports } from "./schema.js";
import {
  assertCurrentTransferActor, assertNotDraining, authorizeTransfer, EXPORT_TTL_MS, pageLimit, PORTABLE_EXPORT_JOB, PORTABLE_RETENTION_JOB,
  type ExportSelection, type PageInput,
} from "./transferPolicy.js";

type ExportRow = typeof portableExports.$inferSelect;

function view(row: ExportRow, now: Date) {
  return {
    exportId: row.publicId, selection: row.selection, state: row.state, packageId: row.packageId,
    expiresAt: row.expiresAt, expired: row.expiresAt <= now,
    createdAt: row.createdAt, reasonCode: row.reasonCode,
    bytes: row.size, sha256: row.sha256, counts: row.counts,
  };
}

async function lockExport(tx: Tx, publicId: string) {
  const [row] = await tx.select().from(portableExports).where(eq(portableExports.publicId, publicId)).limit(1).for("update");
  if (!row) throw notFound("PORTABLE_EXPORT_NOT_FOUND");
  return row;
}

export function createExportService(deps: ModuleDeps) {
  async function recordDownload(principal: SessionPrincipal, exportId: string, packageId: string | null,
    outcome: "attempted" | "completed" | "failed" | "unknown" | "refused", reasonCode?: string, tx?: Tx) {
    await deps.audit.record({
      eventName: "portable.export.download", category: "portable_transfer", action: "download", outcome,
      actor: { role: principal.role, userId: principal.userId }, resource: { type: "portable_export", publicId: exportId },
      correlationId: exportId, packageId: packageId ?? undefined, reasonCode,
    }, tx);
  }

  async function publish(job: ClaimedJob<{ exportId: string }>): Promise<JobResult> {
    const { exportId } = job.payload;
    const [candidate] = await deps.db.select().from(portableExports).where(eq(portableExports.publicId, exportId)).limit(1);
    if (!candidate) return { outcome: "failed", reasonCode: "PORTABLE_EXPORT_NOT_FOUND", retryable: false };
    if (candidate.state === "completed") return { outcome: "completed", safeCounts: candidate.counts ?? undefined };
    if (candidate.state !== "queued" || !candidate.size || !candidate.sha256 || !candidate.packageId) {
      return { outcome: "failed", reasonCode: "PORTABLE_EXPORT_NOT_PREPARED", retryable: false };
    }
    let reason: string | undefined;
    try {
      await job.assertStillOwned();
      await readExactObject(deps.storage, { key: candidate.storageKey, size: candidate.size, sha256: candidate.sha256 });
    } catch (error) {
      if (error instanceof CustodyError) reason = "PORTABLE_EXPORT_DIGEST_MISMATCH";
      else throw error;
    }
    const result = await deps.db.transaction(async (tx) => {
      await job.assertStillOwned(tx);
      const account = await deps.services.identity.getUserByPublicId(candidate.requesterPublicId, { tx, forUpdate: true });
      const row = await lockExport(tx, exportId);
      if (row.state === "completed") return { counts: row.counts };
      if (row.state !== "queued") return { reason: row.reasonCode ?? "PORTABLE_EXPORT_NOT_PREPARED" };
      if (!account || account.id !== row.requestedBy || account.role !== "admin" || account.status !== "active") {
        reason = "PORTABLE_EXPORT_APPROVAL_REVOKED";
      }
      const session = await deps.services.identity.sessions.getState(row.requesterSessionId, { tx });
      if (!session?.live || !session.mfaVerifiedAt || session.userId !== row.requestedBy || session.role !== "admin") {
        reason = "PORTABLE_EXPORT_APPROVAL_REVOKED";
      }
      if (row.expiresAt <= deps.clock.now()) reason = "PORTABLE_EXPORT_EXPIRED";
      await deps.audit.record({
        category: "portable_transfer", eventName: "portable.export.published", action: "export",
        outcome: reason ? "refused" : "completed", reasonCode: reason, actor: { role: "system" },
        correlationId: exportId, resource: { type: "portable_export", publicId: exportId },
        jobId: job.jobId, packageId: row.packageId ?? undefined, safeCounts: row.counts ?? undefined,
      }, tx);
      await tx.update(portableExports).set({ state: reason ? "refused" : "completed", reasonCode: reason }).where(eq(portableExports.id, row.id));
      return { reason, counts: row.counts };
    });
    return result.reason
      ? { outcome: "failed", reasonCode: result.reason, retryable: false }
      : { outcome: "completed", safeCounts: result.counts ?? undefined };
  }

  async function retention(job: ClaimedJob): Promise<JobResult> {
    const rows = await deps.db.select().from(portableExports).where(and(
      isNull(portableExports.deletedAt), lte(portableExports.expiresAt, deps.clock.now()),
    )).orderBy(asc(portableExports.expiresAt)).limit(100);
    let removed = 0;
    for (const row of rows) {
      // Expiry gates access even before deletion; retries only target this ledger's immutable key.
      const key = await deps.db.transaction(async (tx) => {
        await job.assertStillOwned(tx);
        const locked = await lockExport(tx, row.publicId);
        if (locked.deletedAt || locked.expiresAt > deps.clock.now()) return null;
        await deps.audit.record({
          category: "portable_transfer", eventName: "portable.export.expired", action: "delete", outcome: "attempted",
          actor: { role: "system" }, resource: { type: "portable_export", publicId: locked.publicId },
          correlationId: locked.publicId, packageId: locked.packageId ?? undefined, jobId: job.jobId,
        }, tx);
        return locked.storageKey;
      });
      if (!key) continue;
      await job.assertStillOwned();
      await deps.storage.delete(key);
      await deps.db.transaction(async (tx) => {
        await job.assertStillOwned(tx);
        const locked = await lockExport(tx, row.publicId);
        if (locked.deletedAt) return;
        await deps.audit.record({
          category: "portable_transfer", eventName: "portable.export.expired", action: "delete", outcome: "completed",
          actor: { role: "system" }, resource: { type: "portable_export", publicId: row.publicId },
          correlationId: row.publicId, packageId: row.packageId ?? undefined, jobId: job.jobId,
        }, tx);
        await tx.update(portableExports).set({
          deletedAt: deps.clock.now(),
          ...(locked.state === "queued" || locked.state === "running"
            ? { state: "unknown", reasonCode: "PORTABLE_EXPORT_EXPIRED_UNFINISHED" } as const : {}),
        }).where(eq(portableExports.id, row.id));
        removed += 1;
      });
    }
    return { outcome: "completed", safeCounts: { removed } };
  }

  deps.jobs.register(PORTABLE_EXPORT_JOB, publish, { retrySafe: true });
  deps.jobs.register(PORTABLE_RETENTION_JOB, retention, { retrySafe: true });
  deps.jobs.registerSchedule({ name: "portable.export.retention.hourly", type: PORTABLE_RETENTION_JOB, everyMs: 3_600_000 });

  return {
    async listExports(principal: SessionPrincipal, input: PageInput) {
      await authorizeTransfer(deps, principal, "portable.export", false);
      const limit = pageLimit(input);
      const rows = await deps.db.select().from(portableExports)
        .where(input.cursor ? lt(portableExports.publicId, input.cursor) : undefined)
        .orderBy(desc(portableExports.publicId)).limit(limit + 1);
      const items = rows.slice(0, limit).map((row) => view(row, deps.clock.now()));
      return { items, nextCursor: rows.length > limit ? items.at(-1)?.exportId ?? null : null };
    },

    async startExport(principal: SessionPrincipal, input: { selection: ExportSelection; passphrase: string }) {
      await authorizeTransfer(deps, principal, "portable.export");
      await assertNotDraining(deps);
      const { selection, passphrase } = input;
      if (typeof passphrase !== "string" || passphrase.length < 16 || passphrase.length > 512) {
        throw validation("PORTABLE_PASSPHRASE_LENGTH", "Enter a transfer passphrase of 16 to 512 characters.");
      }
      if (selection.kind !== "all" && (!selection.ids.length || selection.ids.length > 100 ||
        selection.ids.some((id) => !ULID_PATTERN.test(id)) || new Set(selection.ids).size !== selection.ids.length)) {
        throw validation("PORTABLE_SELECTION_INVALID", "Provide 1 to 100 distinct valid public IDs.");
      }
      const now = deps.clock.now();
      const exportId = ulid(now.getTime());
      const key = deps.storage.newKey("exports");
      await deps.db.transaction(async (tx) => {
        await assertCurrentTransferActor(deps, principal, tx);
        await tx.insert(portableExports).values({
          publicId: exportId, requestedBy: principal.userId, requesterPublicId: principal.userPublicId,
          requesterSessionId: principal.sessionId,
          selection: selection.kind, storageKey: key, expiresAt: new Date(now.getTime() + EXPORT_TTL_MS), createdAt: now,
        });
        await deps.audit.record({
          category: "portable_transfer", eventName: "portable.export.requested", action: "export", outcome: "attempted",
          actor: { role: principal.role, userId: principal.userId }, correlationId: exportId,
          resource: { type: "portable_export", publicId: exportId },
        }, tx);
      });

      try {
        const result = await inPrivateWorkspace(async (workspace) => {
          const path = join(workspace, "output.rpkg");
          const compiled = await collectAndWriteExport(deps, principal, selection, { exportId, workspace, path, passphrase, now });
          if (deps.clock.now().getTime() >= now.getTime() + EXPORT_TTL_MS) {
            throw conflict("PORTABLE_EXPORT_EXPIRED", "The export request expired before its ciphertext could be stored.");
          }
          await storeValidated(deps.storage, key, path, { size: compiled.bytes, sha256: compiled.ciphertextSha256 });
          return compiled;
        });
        return await deps.db.transaction(async (tx) => {
          await assertCurrentTransferActor(deps, principal, tx);
          const row = await lockExport(tx, exportId);
          if (row.state !== "running" || row.expiresAt <= deps.clock.now()) {
            throw conflict("PORTABLE_EXPORT_NOT_AVAILABLE", "The export request is no longer active.");
          }
          await deps.audit.record({
            category: "portable_transfer", eventName: "portable.export.prepared", action: "export", outcome: "completed",
            actor: { role: principal.role, userId: principal.userId }, resource: { type: "portable_export", publicId: exportId },
            correlationId: exportId, packageId: result.packageId, safeCounts: result.counts,
          }, tx);
          const fields = {
            state: "queued", packageId: result.packageId, manifestSha256: result.manifestSha256,
            size: result.bytes, sha256: result.ciphertextSha256, counts: result.counts,
          } as const;
          await tx.update(portableExports).set(fields).where(eq(portableExports.id, row.id));
          await deps.jobs.enqueue(PORTABLE_EXPORT_JOB, { exportId }, {
            idempotencyKey: `export:${exportId}`, correlationId: exportId, maxAttempts: 4,
          }, tx);
          return view({ ...row, ...fields }, deps.clock.now());
        });
      } catch (error) {
        // Only mark a still-running request; if the enqueue transaction actually committed, preserve the queue outcome.
        const reason = error instanceof DomainError ? error.reasonCode : "PORTABLE_EXPORT_PREPARATION_FAILED";
        await deps.db.transaction(async (tx) => {
          const row = await lockExport(tx, exportId);
          if (row.state !== "running") return;
          const outcome = error instanceof DomainError && error.code === "VALIDATION" ? "refused" : "failed";
          await deps.audit.record({
            category: "portable_transfer", eventName: "portable.export.prepared", action: "export", outcome, reasonCode: reason,
            actor: { role: principal.role, userId: principal.userId }, resource: { type: "portable_export", publicId: exportId },
            correlationId: exportId,
          }, tx);
          await tx.update(portableExports).set({ state: outcome, reasonCode: reason }).where(eq(portableExports.id, row.id));
        });
        throw error instanceof DomainError ? error
          : new DomainError("UNAVAILABLE", reason, "The export could not be prepared. No download was published.");
      }
    },

    async openExport(principal: SessionPrincipal, exportId: string): Promise<{
      stream: Readable; size: number; finish(outcome: "completed" | "failed" | "unknown"): Promise<void>;
    }> {
      await authorizeTransfer(deps, principal, "portable.export");
      const [row] = await deps.db.select().from(portableExports).where(and(
        eq(portableExports.publicId, exportId), eq(portableExports.state, "completed"),
        isNull(portableExports.deletedAt),
      )).limit(1);
      if (!row || row.expiresAt <= deps.clock.now() || !row.packageId || !row.sha256 || !row.size) {
        await recordDownload(principal, exportId, null, "refused", "PORTABLE_EXPORT_NOT_FOUND");
        throw notFound("PORTABLE_EXPORT_NOT_FOUND");
      }
      await deps.db.transaction(async (tx) => {
        await assertCurrentTransferActor(deps, principal, tx);
        await recordDownload(principal, exportId, row.packageId, "attempted", undefined, tx);
      });
      try {
        const actual = await deps.storage.stat(row.storageKey);
        if (!actual) throw new CustodyError();
        matchBytes(actual, { size: row.size, sha256: row.sha256 });
        return {
          stream: await deps.storage.get(row.storageKey), size: row.size,
          finish: (outcome) => recordDownload(principal, exportId, row.packageId, outcome),
        };
      } catch {
        await recordDownload(principal, exportId, row.packageId, "failed", "PORTABLE_EXPORT_CUSTODY_UNAVAILABLE");
        throw new DomainError("UNAVAILABLE", "PORTABLE_EXPORT_CUSTODY_UNAVAILABLE", "The export is unavailable or no longer matches its verified checksum.");
      }
    },
  };
}
