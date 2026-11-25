/**
 * File archives (increment 07, package J, D8). Phase ZIP and administrator whole-order ZIP, built by a job
 * from a fixed manifest and re-authorised at request, at build (per entry, as the requester's live session)
 * and at download. See ARCHIVES.md.
 */
import { createHash, randomBytes } from "node:crypto";
import { PassThrough, Transform, type Readable } from "node:stream";
import { and, eq, isNull, lt, inArray } from "drizzle-orm";
import yazl from "yazl";
import { roleHasCapability } from "../../../shared/capabilities.js";
import type { ModuleDeps } from "../../container.js";
import { DomainError, conflict, forbidden, notFound, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { ModuleHealth, ModuleLifecycle, SessionPrincipal, Tx } from "../../core/types.js";
import { hasFreshStepUp } from "../../trpc/trpc.js";
import { orders } from "../orders/schema.js";
import { archiveEntryNames, isSafeEntryName } from "./archiveNames.js";
import { fileArchiveTickets, fileArchives, type FileArchiveManifestEntry, type FileArchiveScope, type FileArchiveState } from "./archivesSchema.js";

export const ARCHIVE_BUILD_JOB = "files.archive.build";
export const ARCHIVE_EXPIRE_JOB = "files.archive.expire";
export const ARCHIVE_LIMITS = { maxFiles: 250, maxBytes: 500 * 1024 * 1024, ttlMs: 30 * 60_000, ticketMs: 60_000 } as const;
const ACTIVE_STATES: FileArchiveState[] = ["queued", "building", "ready"];
const STAGE_KEY = /^[a-z][a-z0-9_-]{0,63}$/u;
const PUBLIC_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

/* ------------------------------------------------------------------ Files port (files_engineer) ------------- */

export interface DeliverableFile {
  publicId: string;
  displayName: string;
  extension?: string | null;
  stageKey?: string | null;
  size: number;
  sha256: string;
  version: number;
}

export interface DeliverablePort {
  listDeliverableFiles(
    principal: SessionPrincipal,
    input: { orderPublicId: string; stageKey?: string; after?: string; limit?: number },
    tx?: Tx,
  ): Promise<{ items: DeliverableFile[]; nextCursor: string | null }>;
  openDeliverableFile(
    principal: SessionPrincipal,
    input: { orderPublicId: string; filePublicId: string; stageKey?: string },
    tx?: Tx,
  ): Promise<{ file: DeliverableFile; stream: Readable }>;
}

export interface ArchiveView {
  archiveId: string;
  orderId: string;
  scope: FileArchiveScope;
  stageKey: string | null;
  state: FileArchiveState;
  reasonCode: string | null;
  fileCount: number;
  totalBytes: number;
  zipBytes: number | null;
  createdAt: string;
  builtAt: string | null;
  expiresAt: string;
  /** Admitted downloads so far; the form-download client watches this to confirm the browser received the ZIP. */
  downloadCount: number;
}

export interface ArchiveDownload { stream: Readable; filename: string; size: number; archiveId: string }

export interface FileArchivesModule extends ModuleLifecycle {
  request(principal: SessionPrincipal, input: { orderId: string; stageKey?: string | null }): Promise<ArchiveView>;
  status(principal: SessionPrincipal, archiveId: string): Promise<ArchiveView>;
  latest(principal: SessionPrincipal, input: { orderId: string; stageKey?: string | null }): Promise<ArchiveView | null>;
  cancel(principal: SessionPrincipal, archiveId: string): Promise<ArchiveView>;
  issueDownloadTicket(principal: SessionPrincipal, archiveId: string): Promise<{ ticket: string; expiresAt: string }>;
  redeemDownloadTicket(principal: SessionPrincipal, ticket: string): Promise<ArchiveDownload>;
  recordDownloadResult(principal: SessionPrincipal, archiveId: string, outcome: "completed" | "failed" | "unknown"): Promise<void>;
  recordDenied(principal: SessionPrincipal | null, reasonCode: string): Promise<void>;
  /** Job bodies (exported for tests). */
  build(archivePublicId: string, assertOwned?: (tx?: Tx) => Promise<void>): Promise<FileArchiveState>;
  expire(): Promise<number>;
}

type ArchiveRow = typeof fileArchives.$inferSelect;

/** Manifest digest: an identical request while one is active returns the same archive. */
export function manifestDigest(entries: readonly FileArchiveManifestEntry[]): string {
  return createHash("sha256").update(JSON.stringify(entries.map((e) => [e.filePublicId, e.version, e.size, e.sha256, e.entryName]))).digest("hex");
}

export function toArchiveView(row: ArchiveRow): ArchiveView {
  return {
    archiveId: row.publicId, orderId: row.orderPublicId, scope: row.scope, stageKey: row.stageKey, state: row.state,
    reasonCode: row.reasonCode, fileCount: row.fileCount, totalBytes: row.totalBytes, zipBytes: row.zipBytes,
    createdAt: row.createdAt.toISOString(), builtAt: row.builtAt?.toISOString() ?? null, expiresAt: row.expiresAt.toISOString(),
    downloadCount: row.downloadCount,
  };
}

/** Streams through unchanged while hashing; errors if size or SHA-256 differ from the manifest. */
function verifying(expected: FileArchiveManifestEntry): Transform {
  const hash = createHash("sha256");
  let size = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length;
      if (size > expected.size) return done(new DomainError("CONFLICT", "ARCHIVE_STALE", "A file changed while the archive was being prepared."));
      hash.update(chunk);
      done(null, chunk);
    },
    flush(done) {
      const digest = hash.digest("hex");
      if (size !== expected.size || (expected.sha256 && digest !== expected.sha256)) {
        return done(new DomainError("CONFLICT", "ARCHIVE_STALE", "A file changed while the archive was being prepared."));
      }
      done();
    },
  });
}

export function createFileArchivesModule(deps: ModuleDeps): FileArchivesModule {
  const { db, clock, audit, storage, crypto } = deps;
  const port = (): DeliverablePort => {
    const files = deps.services.files as unknown as Partial<DeliverablePort> | undefined;
    if (!files?.listDeliverableFiles || !files.openDeliverableFile) {
      throw new DomainError("UNAVAILABLE", "ARCHIVES_UNAVAILABLE", "File archives are not available right now.");
    }
    return files as DeliverablePort;
  };
  const keyAad = (publicId: string) => `file_archives.object_key:${publicId}`;
  const actor = (p: SessionPrincipal) => ({ userId: p.userId, role: p.role });

  async function live(principal: SessionPrincipal, tx: Tx): Promise<SessionPrincipal> {
    if (principal.state !== "full" || principal.pendingSteps.length) {
      throw new DomainError("REMEDIATION_REQUIRED", "ACCOUNT_STEP_PENDING", "Please finish securing your account to continue.");
    }
    const sessions = deps.services.identity?.sessions;
    if (!sessions?.assertCurrent) throw forbidden("ACTOR_UNVERIFIABLE");
    const current = await sessions.assertCurrent(principal, tx);
    if (current.pendingSteps.length) throw new DomainError("REMEDIATION_REQUIRED", "ACCOUNT_STEP_PENDING", "Please finish securing your account to continue.");
    return { ...principal, role: current.role, pendingSteps: current.pendingSteps, stepUpAt: current.stepUpAt, mfaVerifiedAt: current.mfaVerifiedAt };
  }

  function assertScope(p: SessionPrincipal, scope: FileArchiveScope) {
    if (scope !== "order") return;
    if (p.role !== "admin" || !roleHasCapability(p.role, "files.archive.order")) throw forbidden("CAPABILITY_NOT_GRANTED");
    if (!hasFreshStepUp(p, clock.now())) {
      throw new DomainError("STEP_UP_REQUIRED", "STEP_UP_REQUIRED", "Please confirm your password and authentication code to continue.", { capability: "files.archive.order" });
    }
  }

  async function denied(principal: SessionPrincipal | null, reasonCode: string, resource?: { orderPublicId?: string; archiveId?: string }) {
    await audit.record({
      category: "file", eventName: "file.archive.denied", action: "access", outcome: "denied", reasonCode,
      actor: principal ? actor(principal) : { role: "anonymous" },
      resource: { type: "file_archive", publicId: resource?.archiveId ?? null }, orderPublicId: resource?.orderPublicId ?? null,
    }).catch(() => undefined);
  }

  async function guarded<T>(principal: SessionPrincipal, fn: () => Promise<T>, resource?: { orderPublicId?: string; archiveId?: string }): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof DomainError && ["FORBIDDEN", "STEP_UP_REQUIRED", "REMEDIATION_REQUIRED", "NOT_FOUND"].includes(error.code)) {
        await denied(principal, error.reasonCode, resource);
      }
      throw error;
    }
  }

  /** Collects the full eligible set (≤ 250) through the Files selector, as `principal`. */
  async function collect(principal: SessionPrincipal, orderPublicId: string, stageKey: string | null, scope: FileArchiveScope, tx?: Tx) {
    const items: DeliverableFile[] = [];
    let after: string | undefined;
    for (let page = 0; page < 3; page += 1) {
      const result = await port().listDeliverableFiles(principal, { orderPublicId, ...(stageKey ? { stageKey } : {}), ...(after ? { after } : {}), limit: 250 }, tx);
      items.push(...result.items);
      if (items.length > ARCHIVE_LIMITS.maxFiles) throw validation("ARCHIVE_TOO_LARGE", `An archive can hold at most ${ARCHIVE_LIMITS.maxFiles} files. Download files individually.`);
      if (!result.nextCursor) break;
      after = result.nextCursor;
    }
    const names = archiveEntryNames(items.map((f) => ({ displayName: f.displayName, extension: f.extension ?? null, stageKey: f.stageKey ?? null })), scope);
    const entries: FileArchiveManifestEntry[] = items.map((f, i) => ({ filePublicId: f.publicId, version: f.version, size: f.size, sha256: f.sha256 || null, entryName: names[i]! }));
    const totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
    if (totalBytes > ARCHIVE_LIMITS.maxBytes) throw validation("ARCHIVE_TOO_LARGE", "These files are larger than 500 MiB together. Download files individually.");
    return { entries, totalBytes };
  }

  async function orderIdFor(tx: Tx, orderPublicId: string): Promise<number> {
    const [row] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.publicId, orderPublicId));
    if (!row) throw notFound("ORDER_NOT_FOUND");
    return row.id;
  }

  async function ownArchive(tx: Tx, p: SessionPrincipal, archiveId: string, forUpdate = false): Promise<ArchiveRow> {
    if (!PUBLIC_ID.test(archiveId)) throw notFound("ARCHIVE_NOT_FOUND");
    const query = tx.select().from(fileArchives).where(eq(fileArchives.publicId, archiveId));
    const [row] = forUpdate ? await query.for("update") : await query;
    if (!row || row.requestedByUserId !== p.userId) throw notFound("ARCHIVE_NOT_FOUND");
    return row;
  }

  /** Current access under the order fence: the requester must still be able to read the order (and, for a
   * whole-order archive, still hold the admin capability). Losing access hides the archive entirely. */
  async function stillReadable(p: SessionPrincipal, row: ArchiveRow, tx: Tx): Promise<boolean> {
    try {
      if (row.scope === "order" && (p.role !== "admin" || !roleHasCapability(p.role, "files.archive.order"))) return false;
      await port().listDeliverableFiles(p, { orderPublicId: row.orderPublicId, ...(row.stageKey ? { stageKey: row.stageKey } : {}), limit: 1 }, tx);
      return true;
    } catch (error) {
      if (error instanceof DomainError) return false;
      throw error;
    }
  }

  /** Releases the user's slot when its archive has expired (lazy; the expire job does the rest). */
  async function releaseExpired(tx: Tx, userId: number) {
    await tx.update(fileArchives).set({ state: "expired", activeUserId: null, reasonCode: "ARCHIVE_EXPIRED" })
      .where(and(eq(fileArchives.activeUserId, userId), lt(fileArchives.expiresAt, clock.now())));
  }

  async function finish(row: ArchiveRow, state: "failed" | "expired" | "revoked", reasonCode: string, tx?: Tx) {
    const runner = tx ?? db;
    await runner.update(fileArchives).set({ state, reasonCode, activeUserId: null, version: row.version + 1 }).where(eq(fileArchives.id, row.id));
    if (row.objectKeyEnc && !row.purgedAt) {
      try {
        await storage.delete(crypto.decrypt(row.objectKeyEnc, keyAad(row.publicId)));
        await runner.update(fileArchives).set({ purgedAt: clock.now() }).where(eq(fileArchives.id, row.id));
      } catch {
        // The expire job retries the purge; never surface storage detail.
      }
    }
  }

  function normaliseStage(stageKey: string | null | undefined): string | null {
    if (stageKey === undefined || stageKey === null) return null;
    if (!STAGE_KEY.test(stageKey)) throw validation("STAGE_KEY_INVALID", "This phase is not valid.");
    return stageKey;
  }

  const module: FileArchivesModule = {
    async request(principal, input) {
      const stageKey = normaliseStage(input.stageKey);
      const scope: FileArchiveScope = stageKey ? "stage" : "order";
      return guarded(principal, async () => {
        const p = await db.transaction((tx) => live(principal, tx));
        assertScope(p, scope);
        const limited = await deps.rateLimiter.consume("expensive", `files.archive:${p.userId}`);
        if (!limited.allowed) throw new DomainError("RATE_LIMITED", "ARCHIVE_RATE_LIMITED", "Please wait a moment before preparing another archive.", { retryAfterSeconds: limited.retryAfterSeconds });
        const { entries, totalBytes } = await collect(p, input.orderId, stageKey, scope);
        if (!entries.length) throw validation("ARCHIVE_EMPTY", "There are no files to download here yet.");
        const digest = manifestDigest(entries);
        const now = clock.now();
        const publicId = ulid(now.getTime());
        const view = await db.transaction(async (tx) => {
          const orderId = await orderIdFor(tx, input.orderId);
          await releaseExpired(tx, p.userId);
          const [active] = await tx.select().from(fileArchives).where(eq(fileArchives.activeUserId, p.userId)).for("update");
          if (active) {
            const same = active.orderId === orderId && active.stageKey === stageKey && active.scope === scope && active.sessionId === p.sessionId
              && manifestDigest(active.manifest) === digest;
            if (same) return toArchiveView(active);
            throw conflict("ARCHIVE_BUSY", "Another archive of yours is still being prepared or waiting to download. Cancel it or wait for it to expire.");
          }
          try {
            await tx.insert(fileArchives).values({
              publicId, orderId, orderPublicId: input.orderId, scope, stageKey, requestedByUserId: p.userId, sessionId: p.sessionId,
              activeUserId: p.userId, state: "queued", manifest: entries, fileCount: entries.length, totalBytes,
              expiresAt: new Date(now.getTime() + ARCHIVE_LIMITS.ttlMs),
            });
          } catch (error) {
            const code = (error as { cause?: { code?: string }; code?: string });
            if (code.code === "ER_DUP_ENTRY" || code.cause?.code === "ER_DUP_ENTRY") throw conflict("ARCHIVE_BUSY", "Another archive of yours is still being prepared. Wait for it to finish.");
            throw error;
          }
          const { jobId } = await deps.jobs.enqueue(ARCHIVE_BUILD_JOB, { archiveId: publicId }, undefined, tx);
          await tx.update(fileArchives).set({ jobId }).where(eq(fileArchives.publicId, publicId));
          await audit.record({
            category: "file", eventName: "file.archive.requested", action: "create", outcome: "completed", actor: actor(p),
            resource: { type: "file_archive", publicId }, orderPublicId: input.orderId,
            safeCounts: { files: entries.length, bytes: totalBytes }, attributes: { scope, ...(stageKey ? { stage_key: stageKey } : {}) },
          }, tx);
          const [row] = await tx.select().from(fileArchives).where(eq(fileArchives.publicId, publicId));
          return toArchiveView(row!);
        });
        return view;
      }, { orderPublicId: input.orderId });
    },

    async status(principal, archiveId) {
      return guarded(principal, () => db.transaction(async (tx) => {
        const p = await live(principal, tx);
        const row = await ownArchive(tx, p, archiveId);
        if (!(await stillReadable(p, row, tx))) throw notFound("ARCHIVE_NOT_FOUND");
        return toArchiveView(row);
      }), { archiveId });
    },

    async latest(principal, input) {
      const stageKey = normaliseStage(input.stageKey);
      return db.transaction(async (tx) => {
        const p = await live(principal, tx);
        const [row] = await tx.select().from(fileArchives)
          .where(and(eq(fileArchives.activeUserId, p.userId), eq(fileArchives.orderPublicId, input.orderId),
            stageKey ? eq(fileArchives.stageKey, stageKey) : isNull(fileArchives.stageKey)));
        if (!row || !(await stillReadable(p, row, tx))) return null;
        return row.expiresAt < clock.now() ? { ...toArchiveView(row), state: "expired" as const } : toArchiveView(row);
      });
    },

    async cancel(principal, archiveId) {
      return guarded(principal, () => db.transaction(async (tx) => {
        const p = await live(principal, tx);
        const row = await ownArchive(tx, p, archiveId, true);
        if (ACTIVE_STATES.includes(row.state)) {
          await finish(row, "revoked", "ARCHIVE_CANCELED", tx);
          await audit.record({ category: "file", eventName: "file.archive.revoked", action: "delete", outcome: "completed", actor: actor(p), resource: { type: "file_archive", publicId: row.publicId }, orderPublicId: row.orderPublicId }, tx);
        }
        return toArchiveView((await tx.select().from(fileArchives).where(eq(fileArchives.id, row.id)))[0]!);
      }), { archiveId });
    },

    async issueDownloadTicket(principal, archiveId) {
      return guarded(principal, () => db.transaction(async (tx) => {
        const p = await live(principal, tx);
        const row = await ownArchive(tx, p, archiveId, true);
        if (row.sessionId !== p.sessionId) throw forbidden("ARCHIVE_SESSION_MISMATCH");
        assertScope(p, row.scope);
        if (row.state !== "ready" || row.expiresAt <= clock.now()) throw conflict("ARCHIVE_NOT_READY", "This archive is not ready to download.");
        const ticket = randomBytes(32).toString("base64url");
        const now = clock.now();
        const expiresAt = new Date(Math.min(now.getTime() + ARCHIVE_LIMITS.ticketMs, row.expiresAt.getTime()));
        await tx.insert(fileArchiveTickets).values({ tokenHash: crypto.hashToken(ticket), archiveId: row.id, userId: p.userId, sessionId: p.sessionId, issuedAt: now, expiresAt });
        await audit.record({ category: "file", eventName: "file.archive.ticket_issued", action: "issue", outcome: "completed", actor: actor(p), resource: { type: "file_archive", publicId: row.publicId }, orderPublicId: row.orderPublicId }, tx);
        return { ticket, expiresAt: expiresAt.toISOString() };
      }), { archiveId });
    },

    async redeemDownloadTicket(principal, ticket) {
      return guarded(principal, async () => {
        if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw validation("DOWNLOAD_TICKET_INVALID", "The download request is invalid.");
        // 1. Spend: only a ticket bound to this account AND this session is consumed (committed on its own, so a
        //    refusal below still burns it). Another party's ticket is never touched.
        const spent = await db.transaction(async (tx) => {
          const p = await live(principal, tx);
          const [t] = await tx.select().from(fileArchiveTickets).where(and(
            eq(fileArchiveTickets.tokenHash, crypto.hashToken(ticket)), eq(fileArchiveTickets.userId, p.userId),
            eq(fileArchiveTickets.sessionId, p.sessionId), isNull(fileArchiveTickets.usedAt))).for("update");
          if (!t) return null;
          await tx.delete(fileArchiveTickets).where(eq(fileArchiveTickets.id, t.id));
          return t.expiresAt > clock.now() ? t.archiveId : null;
        });
        if (spent === null) throw forbidden("DOWNLOAD_TICKET_INVALID");
        // 2. Admit: live principal, archive row, the order fence (Files selector locks the order FOR UPDATE), the
        //    fixed manifest, the audit row and the object open all happen in ONE transaction. Only the byte stream
        //    continues after commit.
        const stale: { row: ArchiveRow | null } = { row: null };
        const opened: { stream: Readable | null } = { stream: null };
        try {
          return await db.transaction(async (tx) => {
            const p = await live(principal, tx);
            const [row] = await tx.select().from(fileArchives).where(eq(fileArchives.id, spent)).for("update");
            if (!row || row.requestedByUserId !== p.userId || row.sessionId !== p.sessionId) throw forbidden("DOWNLOAD_TICKET_INVALID");
            assertScope(p, row.scope);
            if (row.state !== "ready" || row.expiresAt <= clock.now() || !row.objectKeyEnc) throw conflict("ARCHIVE_NOT_READY", "This archive is not ready to download.");
            const current = await collect(p, row.orderPublicId, row.stageKey, row.scope, tx);
            if (manifestDigest(current.entries) !== manifestDigest(row.manifest)) {
              stale.row = row;
              throw conflict("ARCHIVE_STALE", "The files changed since this archive was prepared. Prepare it again.");
            }
            await audit.record({
              category: "file", eventName: "file.archive.downloaded", action: "download", outcome: "attempted", actor: actor(p),
              resource: { type: "file_archive", publicId: row.publicId }, orderPublicId: row.orderPublicId, safeCounts: { files: row.fileCount, bytes: row.zipBytes ?? 0 },
            }, tx);
            await tx.update(fileArchives).set({ downloadCount: row.downloadCount + 1, lastDownloadedAt: clock.now() }).where(eq(fileArchives.id, row.id));
            const stream = await storage.get(crypto.decrypt(row.objectKeyEnc, keyAad(row.publicId)));
            opened.stream = stream;
            const suffix = row.scope === "stage" ? `phase-${row.stageKey}` : "all-files";
            return { stream, filename: `order-${row.orderPublicId}-${suffix}.zip`, size: row.zipBytes ?? 0, archiveId: row.publicId };
          });
        } catch (error) {
          opened.stream?.destroy();
          throw error;
        } finally {
          // Revoke outside the rolled-back transaction so the stale archive cannot be retried.
          if (stale.row) await finish(stale.row, "revoked", "ARCHIVE_STALE").catch(() => undefined);
        }
      });
    },

    async recordDownloadResult(principal, archiveId, outcome) {
      await audit.record({
        category: "file", eventName: "file.archive.downloaded", action: "download", outcome, actor: actor(principal), resource: { type: "file_archive", publicId: archiveId },
      });
    },

    async recordDenied(principal, reasonCode) {
      await denied(principal, reasonCode);
    },

    async build(archivePublicId, assertOwned) {
      const [row] = await db.select().from(fileArchives).where(eq(fileArchives.publicId, archivePublicId));
      if (!row || row.state !== "queued") return row?.state ?? "failed";
      if (row.expiresAt <= clock.now()) { await finish(row, "expired", "ARCHIVE_EXPIRED"); return "expired"; }
      await db.update(fileArchives).set({ state: "building" }).where(and(eq(fileArchives.id, row.id), eq(fileArchives.state, "queued")));
      let objectKey: string | null = null;
      try {
        const p = await principalFor(row);
        assertScope(p, row.scope);
        for (const entry of row.manifest) if (!isSafeEntryName(entry.entryName)) throw new DomainError("CONFLICT", "ARCHIVE_ENTRY_INVALID", "The archive could not be prepared.");
        const zip = new yazl.ZipFile();
        // Any member failure (open refused, size or sha256 mismatch) aborts the whole output stream, so put() rejects.
        const output = new PassThrough();
        const abort = (error: unknown) => output.destroy(error instanceof Error ? error : new Error("archive member failed"));
        for (const entry of row.manifest) {
          zip.addReadStreamLazy(entry.entryName, { size: entry.size, compress: false, mtime: row.createdAt }, (cb) => {
            port().openDeliverableFile(p, { orderPublicId: row.orderPublicId, filePublicId: entry.filePublicId, ...(row.stageKey ? { stageKey: row.stageKey } : {}) })
              .then(({ file, stream }) => {
                if (file.publicId !== entry.filePublicId || file.version !== entry.version || file.size !== entry.size) {
                  stream.destroy();
                  const stale = new DomainError("CONFLICT", "ARCHIVE_STALE", "A file changed while the archive was being prepared.");
                  abort(stale);
                  return cb(stale, new PassThrough());
                }
                const checked = verifying(entry);
                checked.on("error", abort);
                stream.on("error", (error) => checked.destroy(error));
                return cb(null, stream.pipe(checked));
              })
              .catch((error: unknown) => { abort(error); cb(error, new PassThrough()); });
          });
        }
        zip.end();
        objectKey = storage.newKey("exports");
        zip.on("error", abort);
        zip.outputStream.pipe(output);
        const info = await storage.put(objectKey, output, { maxBytes: ARCHIVE_LIMITS.maxBytes + 16 * 1024 * 1024 });
        await db.transaction(async (tx) => {
          await assertOwned?.(tx);
          const [currentRow] = await tx.select().from(fileArchives).where(eq(fileArchives.id, row.id)).for("update");
          if (!currentRow || currentRow.state !== "building") throw new DomainError("CONFLICT", "ARCHIVE_CANCELED", "The archive was canceled.");
          await tx.update(fileArchives).set({
            state: "ready", zipBytes: info.size, zipSha256: info.sha256, objectKeyEnc: crypto.encrypt(objectKey!, keyAad(row.publicId)), builtAt: clock.now(),
            version: currentRow.version + 1,
          }).where(eq(fileArchives.id, row.id));
          await audit.record({
            category: "file", eventName: "file.archive.built", action: "create", outcome: "completed", actor: { userId: row.requestedByUserId, role: "system" },
            resource: { type: "file_archive", publicId: row.publicId }, orderPublicId: row.orderPublicId,
            safeCounts: { files: row.fileCount, bytes: row.totalBytes, zip_bytes: info.size }, attributes: { scope: row.scope },
          }, tx);
        });
        return "ready";
      } catch (error) {
        if (objectKey) await storage.delete(objectKey).catch(() => undefined);
        const reasonCode = error instanceof DomainError ? error.reasonCode : "ARCHIVE_BUILD_FAILED";
        const [latestRow] = await db.select().from(fileArchives).where(eq(fileArchives.id, row.id));
        if (latestRow && ACTIVE_STATES.includes(latestRow.state)) await finish(latestRow, "failed", reasonCode);
        await audit.record({
          category: "file", eventName: "file.archive.failed", action: "create", outcome: "failed", reasonCode, actor: { userId: row.requestedByUserId, role: "system" },
          resource: { type: "file_archive", publicId: row.publicId }, orderPublicId: row.orderPublicId,
        }).catch(() => undefined);
        return "failed";
      }
    },

    async expire() {
      const now = clock.now();
      const rows = await db.select().from(fileArchives)
        .where(and(inArray(fileArchives.state, ["queued", "building", "ready"]), lt(fileArchives.expiresAt, now))).limit(200);
      for (const row of rows) {
        await finish(row, "expired", "ARCHIVE_EXPIRED");
        await audit.record({ category: "file", eventName: "file.archive.expired", action: "delete", outcome: "completed", actor: { role: "system" }, resource: { type: "file_archive", publicId: row.publicId }, orderPublicId: row.orderPublicId }).catch(() => undefined);
      }
      await db.delete(fileArchiveTickets).where(lt(fileArchiveTickets.expiresAt, now));
      return rows.length;
    },

    async health(): Promise<ModuleHealth[]> {
      return [{ component: "files.archives", state: "ok", summary: "File archives are available.", checkedAt: clock.now() }];
    },
  };

  /** The requester's LIVE session, rebuilt for the build job by Identity (real CSRF secret, auth facts and
   * derived steps, so the Files selector's assertCurrent accepts it). Ended, downgraded or pending: refused. */
  async function principalFor(row: ArchiveRow): Promise<SessionPrincipal> {
    const sessions = deps.services.identity?.sessions;
    if (!sessions?.principalForJob) throw new DomainError("FORBIDDEN", "ARCHIVE_SESSION_ENDED", "The session that requested this archive has ended.");
    try {
      const principal = await sessions.principalForJob(row.sessionId, row.requestedByUserId);
      if (principal.userId !== row.requestedByUserId || principal.sessionId !== row.sessionId || principal.state !== "full" || principal.pendingSteps.length) {
        throw new Error("principal mismatch");
      }
      return principal;
    } catch {
      throw new DomainError("FORBIDDEN", "ARCHIVE_SESSION_ENDED", "The session that requested this archive has ended.");
    }
  }

  deps.jobs.register<{ archiveId: string }>(ARCHIVE_BUILD_JOB, async (job) => {
    if (!PUBLIC_ID.test(job.payload?.archiveId ?? "")) return { outcome: "failed", reasonCode: "ARCHIVE_PAYLOAD_INVALID", retryable: false };
    const state = await module.build(job.payload.archiveId, (tx) => job.assertStillOwned(tx));
    return state === "ready" ? { outcome: "completed" } : { outcome: "failed", reasonCode: "ARCHIVE_BUILD_FAILED", retryable: false };
  });
  deps.jobs.register(ARCHIVE_EXPIRE_JOB, async () => ({ outcome: "completed", safeCounts: { expired: await module.expire() } }), { retrySafe: true });
  deps.jobs.registerSchedule({ name: "files.archive.expire.minutely", type: ARCHIVE_EXPIRE_JOB, everyMs: 60_000 });

  return module;
}
