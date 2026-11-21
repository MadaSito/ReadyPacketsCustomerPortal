import { and, count, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { Readable } from "node:stream";
import type { ModuleDeps } from "../../container.js";
import { conflict, DomainError, forbidden, notFound, validation } from "../../core/errors.js";
import { randomToken, ULID_PATTERN, ulid } from "../../core/ids.js";
import { getRequestContext } from "../../core/requestContext.js";
import type { AuditEventInput, DbOrTx, ModuleLifecycle, SessionPrincipal, StoredObjectInfo, Tx } from "../../core/types.js";
import { roleHasCapability, type Capability } from "../../../shared/capabilities.js";
import { STEP_UP_MAX_AGE_MS } from "../../trpc/trpc.js";
import { registerAutomationTrigger } from "../automations/contracts.js";
import { readSetting, writeSetting } from "../platform/settingsRegistry.js";
import { acceptsDeclaredType, allowedExtensions, classifyFile, displayExtension, sanitizeDisplayName, type FileClassification, type FileExtension } from "./classification.js";
import { fileAccessLog, fileDownloadTickets, orderFiles, type FileCategory, type FileVisibility } from "./schema.js";
import { fileRulesSetting, hardMaxFileBytes, hardMaxFiles, hardMaxRequestBytes, type FileRules } from "./settings.js";
import type { LocalObjectStorage } from "./storage.js";

export type { FileCategory, FileVisibility } from "./schema.js";
const ticketLifetimeMs = 60_000;
const day = 86_400_000;
const retentionJob = "files.retention";
const stagingKey = /^staging\/[a-f0-9]{32}$/u;
const filesKey = /^files\/[a-f0-9]{32}$/u;
const tokenShape = /^[a-zA-Z0-9_-]{43}$/u;
const publicIdShape = (value: string) => value.length === 26 && ULID_PATTERN.test(value);
type FileRow = typeof orderFiles.$inferSelect;
type AccessOutcome = typeof fileAccessLog.$inferInsert.outcome;

export interface FileRecord {
  publicId: string;
  logicalPublicId: string;
  orderPublicId: string;
  phasePublicId: string | null;
  statusKey: string | null;
  displayName: string;
  category: FileCategory;
  visibility: FileVisibility;
  size: number;
  sha256: string;
  contentType: string;
  extension: string;
  version: number;
  createdAt: Date;
  supersededAt: Date | null;
  deletedAt: Date | null;
}

export interface ListOptions {
  cursor?: string;
  limit?: number;
  includeVersions?: boolean;
  includeDeleted?: boolean;
}
type Page<T> = { items: T[]; nextCursor: string | null };
export type PortableStoredFile = FileRecord & { storageKey: string; orderId: number; ownerUserId: number; ownerPublicId: string };
export type BackupStoredFile = FileRecord & { storageKey: string };

export interface AdoptVerifiedObjectInput {
  principal: SessionPrincipal;
  publicId?: string;
  orderId: number;
  orderPublicId: string;
  ownerUserId: number;
  phasePublicId?: string | null;
  displayName: string;
  category: FileCategory;
  visibility: FileVisibility;
  stagedObject: StoredObjectInfo;
  destinationKey: string;
  contentType?: string;
  createdAt?: Date;
}

export type UploadOptions = { category: FileCategory; visibility: FileVisibility; versionOf?: string };
export type UploadAuthorization = UploadOptions & {
  orderId: number;
  orderPublicId: string;
  ownerUserId: number;
  statusKey: string;
  rules: FileRules;
};
export type StagedUpload = { info: StoredObjectInfo; classification: FileClassification; displayName: string };
export type Download = { file: FileRecord; stream: Readable };
export type UploadPolicy = Pick<FileRules, "extensions" | "maxFileBytes" | "maxRequestBytes" | "maxFiles">;
export interface FileScanProvider {
  scan(input: { stream: Readable; size: number; mime: string }): Promise<"clean" | "blocked">;
  health(): Promise<"ok" | "degraded" | "failing">;
}

export interface FilesModule extends ModuleLifecycle {
  beginUpload(principal: SessionPrincipal, orderPublicId: string, options: UploadOptions): Promise<UploadAuthorization>;
  stageUpload(name: string, stream: Readable, rules: FileRules): Promise<StagedUpload>;
  commitUpload(principal: SessionPrincipal, upload: UploadAuthorization, staged: StagedUpload): Promise<FileRecord>;
  rejectUpload(principal: SessionPrincipal, orderPublicId: string, reason: string): Promise<void>;
  cleanUpload(staged: StagedUpload): Promise<void>;
  list(principal: SessionPrincipal, orderPublicId: string, options: ListOptions): Promise<Page<FileRecord> & { canUpload: boolean; uploadPolicy: UploadPolicy | null }>;
  assertCanReadFile(principal: SessionPrincipal, filePublicId: string, orderPublicId?: string): Promise<FileRecord>;
  enumerateOrderFiles(principal: SessionPrincipal, orderPublicId: string, options?: ListOptions): Promise<Page<FileRecord>>;
  openForExport(principal: SessionPrincipal, filePublicId: string, orderPublicId: string, tx?: Tx): Promise<Download>;
  issueDownloadTicket(principal: SessionPrincipal, filePublicId: string): Promise<{ ticket: string; expiresAt: Date }>;
  redeemDownloadTicket(principal: SessionPrincipal, ticket: string): Promise<Download>;
  recordDownloadDenied(principal: SessionPrincipal | null, reason: string): Promise<void>;
  recordDownloadResult(principal: SessionPrincipal, filePublicId: string, outcome: "completed" | "failed" | "unknown"): Promise<void>;
  setVisibility(principal: SessionPrincipal, filePublicId: string, visibility: FileVisibility): Promise<FileRecord>;
  remove(principal: SessionPrincipal, filePublicId: string): Promise<FileRecord>;
  restore(principal: SessionPrincipal, filePublicId: string): Promise<FileRecord>;
  adminOverview(principal: SessionPrincipal): Promise<{
    rules: FileRules; storedFiles: number; storedBytes: string; retainedFiles: number; antivirus: "not_configured" | "configured";
    supported: UploadPolicy;
  }>;
  setTypeRules(principal: SessionPrincipal, rules: FileRules): Promise<FileRules>;
  revokeTicketsForOrder(orderId: number, tx?: Tx): Promise<void>;
  reassignOrderFiles(orderId: number, ownerUserId: number, tx: Tx): Promise<void>;
  validatePortableObject(input: { stagedObject: StoredObjectInfo; displayName: string; category: FileCategory; contentType?: string }, tx?: Tx): Promise<{ extension: string; contentType: string }>;
  adoptVerifiedObject(input: AdoptVerifiedObjectInput, tx: Tx): Promise<FileRecord>;
  portableFiles(tx: Tx, options: { principal: SessionPrincipal; after?: string; limit: number; orderIds?: readonly number[] }): Promise<Page<PortableStoredFile>>;
  backupFiles(tx: Tx, options: { after?: string; limit: number }): Promise<Page<BackupStoredFile>>;
  /** Fenced storage-copy worker only; locks current order/file scope and returns private source metadata. */
  getOrderFileCopySource(filePublicId: string, tx: Tx): Promise<{
    storageKey: string; size: number; sha256: string; contentType: string; displayName: string; extension: string;
    ownerUserId: number; customerName: string; customerReference: string; customerPublicId: string;
    orderReference: string; orderPublicId: string; filePublicId: string;
  }>;
  /** Automation-only bounded traversal: null for unknown/held orders, ≥51 means do not copy the batch. */
  listOrderFileCopyCandidates(orderPublicId: string, tx: Tx): Promise<string[] | null>;
  /** Trusted audit-trigger resolver; returns IDs/category only, never file bytes or names. */
  getUploadAutomationContext(filePublicId: string, handle: DbOrTx): Promise<{
    orderPublicId: string; orderOwnerUserId: number; category: FileCategory;
  } | null>;
}

registerAutomationTrigger({
  key: "file.uploaded",
  async resolveContext({ event, db, services, signal }) {
    signal.throwIfAborted();
    const filePublicId = event.resource?.type === "file" ? event.resource.publicId : null;
    if (!filePublicId || !publicIdShape(filePublicId)) return {};
    const context = await services.files.getUploadAutomationContext(filePublicId, db);
    if (!context) return {};
    const order = await services.orders.getOrderSyncView(context.orderPublicId, db);
    if (!order || order.ownerUserId !== context.orderOwnerUserId) return {};
    return {
      orderPublicId: order.publicId,
      fields: { file_category: context.category, order_reference: order.reference, order_status_label: order.status.label,
        order_link: new URL(`/orders/${order.publicId}`, services.config.canonicalOrigin).href },
      recipients: { order_owner: [order.ownerUserId] },
    };
  },
});

function boundedLimit(value = 30) {
  if (!Number.isInteger(value) || value < 1 || value > 100) throw validation("INVALID_FILE_LIMIT", "Choose a file page size between 1 and 100.");
  return value;
}

function cursorValue(cursor?: string): string | undefined {
  if (cursor === undefined) return undefined;
  const value = Buffer.from(cursor, "base64url").toString("ascii");
  if (!publicIdShape(value) || Buffer.from(value, "ascii").toString("base64url") !== cursor) {
    throw validation("INVALID_FILE_CURSOR", "The file page cursor is invalid.");
  }
  return value;
}

const encodeCursor = (publicId: string) => Buffer.from(publicId, "ascii").toString("base64url");

export function createFilesModule(deps: ModuleDeps, { scanner }: { scanner?: FileScanProvider } = {}): FilesModule {
  const { db, clock, storage, audit, crypto, logger, settings } = deps;
  const local = storage as Partial<LocalObjectStorage>;
  const rules = (tx?: Tx) => readSetting(settings, fileRulesSetting, tx);
  const currentTx = <T>(fn: (tx: Tx) => Promise<T>) => db.transaction(fn, { isolationLevel: "read committed" });
  let retentionCursor: { after: Date; id: number } | undefined;

  function requireFull(principal: SessionPrincipal) {
    if (principal.state !== "full" || principal.pendingSteps.length > 0) {
      throw new DomainError("REMEDIATION_REQUIRED", "ACCOUNT_STEP_PENDING", "Please finish securing your account to continue.");
    }
  }

  async function requireCurrent(principal: SessionPrincipal, tx: Tx) {
    requireFull(principal);
    const current = await deps.services.identity.sessions.assertCurrent(principal, tx);
    if (current.pendingSteps.length) {
      throw new DomainError("REMEDIATION_REQUIRED", "ACCOUNT_STEP_PENDING", "Please finish securing your account to continue.");
    }
    return current;
  }

  function actor(principal: SessionPrincipal | null): NonNullable<AuditEventInput["actor"]> {
    return principal ? { userId: principal.userId, role: principal.role } : { role: "anonymous" };
  }

  function event(principal: SessionPrincipal | null, eventName: string, action: string, outcome: AuditEventInput["outcome"], publicId?: string, reasonCode?: string): AuditEventInput {
    return {
      category: "file", eventName, action, outcome, actor: actor(principal),
      ...(publicId ? { resource: { type: "file", publicId } } : {}),
      ...(reasonCode ? { reasonCode } : {}),
    };
  }

  function orderEvent(principal: SessionPrincipal, orderPublicId: string, reasonCode: string) {
    return audit.record({
      category: "file", eventName: "file.upload.denied", action: "upload", outcome: "denied", actor: actor(principal),
      resource: publicIdShape(orderPublicId) ? { type: "order", publicId: orderPublicId } : undefined,
      reasonCode,
    });
  }

  async function access(principal: SessionPrincipal | null, outcome: AccessOutcome, tx: Tx, filePublicId?: string, reason?: string) {
    const request = getRequestContext();
    await tx.insert(fileAccessLog).values({
      filePublicId, userId: principal?.userId, requestId: request?.requestId, traceId: request?.traceId, correlationId: request?.correlationId,
      outcome, reasonCode: reason, createdAt: clock.now(),
    });
    await audit.record(event(principal, outcome === "attempted" || outcome === "denied" ? "file.download" : "file.download.result",
      "download", outcome, filePublicId, reason), tx);
  }

  function fullCapability(principal: SessionPrincipal, capability: Capability, stepUp = false) {
    requireFull(principal);
    if (!roleHasCapability(principal.role, capability)) throw forbidden("CAPABILITY_NOT_GRANTED");
    if (stepUp) {
      const age = principal.stepUpAt ? clock.now().getTime() - principal.stepUpAt.getTime() : Number.POSITIVE_INFINITY;
      if (age < 0 || age > STEP_UP_MAX_AGE_MS) {
        throw new DomainError("STEP_UP_REQUIRED", "STEP_UP_REQUIRED", "Please confirm your password and authentication code to continue.", { capability });
      }
    }
  }

  function output(row: FileRow): FileRecord {
    return {
      publicId: row.publicId, logicalPublicId: row.logicalPublicId, orderPublicId: row.orderPublicId, phasePublicId: row.phasePublicId,
      statusKey: row.statusKey, displayName: crypto.decrypt(row.displayNameEnc, `order_files.display_name:${row.publicId}`),
      category: row.category, visibility: row.visibility, size: row.byteSize,
      sha256: row.sha256, contentType: row.contentType, extension: row.extension, version: row.version,
      createdAt: row.createdAt, supersededAt: row.supersededAt, deletedAt: row.deletedAt,
    };
  }

  async function findFile(publicId: string, handle: DbOrTx = db, forUpdate = false) {
    if (!publicIdShape(publicId)) throw notFound("FILE_NOT_FOUND");
    const query = handle.select().from(orderFiles).where(eq(orderFiles.publicId, publicId)).limit(1);
    const [file] = await (forUpdate ? query.for("update") : query);
    if (!file) throw notFound("FILE_NOT_FOUND");
    return file;
  }

  function enforceVisibility(row: FileRow, principal: SessionPrincipal, ownerUserId: number, includeDeleted = false) {
    if (row.ownerUserId !== ownerUserId || row.purgedAt || (!includeDeleted && row.deletedAt) ||
        (row.visibility === "staff_only" && !roleHasCapability(principal.role, "files.read_all"))) throw notFound("FILE_NOT_FOUND");
  }

  const publicPolicy = ({ extensions, maxFileBytes, maxRequestBytes, maxFiles }: FileRules): UploadPolicy =>
    ({ extensions, maxFileBytes, maxRequestBytes, maxFiles });

  async function readFile(principal: SessionPrincipal, publicId: string, orderPublicId?: string, tx?: Tx) {
    requireFull(principal);
    const initial = await findFile(publicId, tx);
    if (orderPublicId && initial.orderPublicId !== orderPublicId) throw notFound("FILE_NOT_FOUND");
    const order = await deps.services.orders.assertCanReadOrderById(principal, initial.orderId, { tx, forUpdate: !!tx });
    const file = tx ? await findFile(publicId, tx, true) : initial;
    if (file.orderPublicId !== order.publicId || file.orderId !== order.id) throw notFound("FILE_NOT_FOUND");
    enforceVisibility(file, principal, order.ownerUserId);
    return file;
  }

  async function getPage(principal: SessionPrincipal, orderPublicId: string, options: ListOptions, tx: Tx) {
    requireFull(principal);
    const limit = boundedLimit(options.limit);
    const after = cursorValue(options.cursor);
    const order = await deps.services.orders.assertCanReadOrder(principal, orderPublicId, { tx, forUpdate: true });
    const staff = roleHasCapability(principal.role, "files.read_all");
    if (options.includeDeleted && !staff) throw forbidden("CAPABILITY_NOT_GRANTED");
    const rows = await tx.select().from(orderFiles).where(and(
      eq(orderFiles.orderId, order.id), eq(orderFiles.ownerUserId, order.ownerUserId),
      isNull(orderFiles.purgedAt),
      options.includeDeleted ? undefined : isNull(orderFiles.deletedAt),
      options.includeVersions ? undefined : isNull(orderFiles.supersededAt),
      staff ? undefined : eq(orderFiles.visibility, "customer_visible"),
      after ? gt(orderFiles.publicId, after) : undefined,
    )).orderBy(orderFiles.publicId).limit(limit + 1).for("update");
    const canUpload = ["owner", "contributor", "staff", "admin"].includes(order.accessRole) &&
      (order.lockState === "none" || (staff && order.lockState === "review"));
    return {
      items: rows.slice(0, limit).map(output),
      nextCursor: rows.length > limit ? encodeCursor(rows[limit - 1]!.publicId) : null,
      canUpload,
    };
  }

  async function classifyObject(info: StoredObjectInfo, displayName: string, options: FileRules) {
    if (!stagingKey.test(info.key) || displayExtension(displayName) === displayName) {
      throw validation("INVALID_FILE_REFERENCE", "The staged file reference is invalid.");
    }
    const extension = displayExtension(displayName);
    if (!options.extensions.includes(extension as FileExtension)) {
      throw validation("FILE_TYPE_DISABLED", "The file extension is not enabled for uploads.");
    }
    if (info.size <= 0 || info.size > options.maxFileBytes) {
      throw validation("INVALID_FILE_SIZE", "The file is empty or exceeds the allowed size.");
    }
    const classification = local.inspect
      ? await local.inspect(info.key, (read, size) => size === info.size ? classifyFile(read, size) : Promise.resolve(null))
      : await classifyFile(async (offset, length) => {
        const stream = await storage.get(info.key, { start: offset, end: offset + length - 1 });
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const raw of stream) {
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
          size += chunk.length;
          if (size > length) throw validation("INVALID_FILE_SIZE", "The staged file could not be verified.");
          chunks.push(chunk);
        }
        return Buffer.concat(chunks, size);
      }, info.size);
    if (!classification || classification.extension !== extension) {
      throw validation("FILE_TYPE_MISMATCH", "The file contents do not match an approved file type and extension.");
    }
    return classification;
  }

  async function validatePortable(input: Parameters<FilesModule["validatePortableObject"]>[0], tx?: Tx) {
    const displayName = sanitizeDisplayName(input.displayName);
    if (!stagingKey.test(input.stagedObject.key)) throw validation("INVALID_FILE_REFERENCE", "The staged file reference is invalid.");
    const options = await rules(tx);
    if (!Number.isSafeInteger(input.stagedObject.size) || input.stagedObject.size <= 0 || input.stagedObject.size > options.maxFileBytes) {
      throw validation("INVALID_FILE_SIZE", "The staged file is empty or exceeds the allowed size.");
    }
    const info = await storage.stat(input.stagedObject.key);
    if (!info || info.size !== input.stagedObject.size || info.sha256 !== input.stagedObject.sha256) {
      throw validation("FILE_INTEGRITY_MISMATCH", "The staged file could not be verified.");
    }
    const classification = await classifyObject(info, displayName, options);
    if (input.contentType !== undefined && !acceptsDeclaredType(classification, input.contentType)) {
      throw validation("FILE_TYPE_MISMATCH", "The file contents do not match the declared file type.");
    }
    return { info, classification, displayName };
  }

  async function cleanup(key: string) {
    await storage.delete(key).catch(() => logger.error("Private file cleanup requires attention"));
  }

  async function scanStaged(staged: StagedUpload) {
    if (!scanner) return;
    let stream: Readable | undefined;
    try {
      stream = await storage.get(staged.info.key);
      const result = await scanner.scan({ stream, size: staged.info.size, mime: staged.classification.mime });
      if (result === "blocked") throw validation("FILE_SCAN_REFUSED", "The file did not pass the configured scanning policy.");
      if (result === "clean" && stream.readableEnded) return;
      throw new Error("FILE_SCAN_INCOMPLETE");
    } catch (error) {
      if (error instanceof DomainError && error.reasonCode === "FILE_SCAN_REFUSED") throw error;
      throw new DomainError("UNAVAILABLE", "FILE_SCANNER_UNAVAILABLE", "The configured file scanner is unavailable.");
    } finally {
      stream?.destroy();
    }
  }

  async function readObject(row: FileRow): Promise<Readable> {
    try {
      return await storage.get(row.storageKey);
    } catch {
      throw new DomainError("UNAVAILABLE", "FILE_BYTES_UNAVAILABLE", "The private file is unavailable. Please try again later.");
    }
  }

  async function insertVersion(tx: Tx, principal: SessionPrincipal, input: {
    publicId?: string; orderPublicId: string; orderId: number; ownerUserId: number; phasePublicId?: string | null;
    statusKey: string; category: FileCategory; visibility: FileVisibility; staged: StagedUpload; storageKey: string;
    previous?: FileRow; imported?: boolean; createdAt?: Date;
  }) {
    const now = clock.now();
    const publicId = input.publicId ?? ulid(now.getTime());
    await tx.insert(orderFiles).values({
      publicId,
      logicalPublicId: input.previous?.logicalPublicId ?? publicId,
      previousVersionId: input.previous?.id,
      orderPublicId: input.orderPublicId, orderId: input.orderId, ownerUserId: input.ownerUserId, phasePublicId: input.phasePublicId,
      statusKey: input.statusKey,
      uploadedByUserId: principal.userId, storageKey: input.storageKey,
      displayNameEnc: crypto.encrypt(input.staged.displayName, `order_files.display_name:${publicId}`),
      category: input.category, visibility: input.visibility, byteSize: input.staged.info.size,
      sha256: input.staged.info.sha256, contentType: input.staged.classification.mime, extension: input.staged.classification.extension,
      version: (input.previous?.version ?? 0) + 1, createdAt: input.createdAt ?? now,
    });
    if (input.previous) {
      await tx.update(orderFiles).set({ supersededAt: now }).where(eq(orderFiles.id, input.previous.id));
    }
    await audit.record({ ...event(principal, input.imported ? "file.imported" : "file.uploaded",
      input.imported ? "import" : "upload", "completed", publicId),
      ...(!input.imported ? { attributes: { order_public_id: input.orderPublicId } } : {}) }, tx);
    return output(await findFile(publicId, tx, true));
  }

  /** Object-level write denials raised inside the write transaction (review F-1): recorded durably AFTER it has
   *  rolled back, never on a second pool connection while the tx is held. Best effort: the request is refused
   *  regardless. Capability refusals before the tx are recorded by the tRPC capability guard. */
  const deniedCodes = new Set(["NOT_FOUND", "FORBIDDEN", "LOCKED", "REMEDIATION_REQUIRED", "STEP_UP_REQUIRED", "UNAUTHENTICATED"]);
  async function recordWriteDenied(principal: SessionPrincipal, filePublicId: string, action: string, error: unknown) {
    if (!(error instanceof DomainError) || !deniedCodes.has(error.code)) return;
    await audit.record({
      category: "security", eventName: "file.access.denied", action, outcome: "denied", severity: "WARN",
      actor: actor(principal), reasonCode: error.reasonCode,
      ...(publicIdShape(filePublicId) ? { resource: { type: "file", publicId: filePublicId } } : {}),
    }).catch(() => undefined);
  }

  async function writeFile(principal: SessionPrincipal, filePublicId: string, change: { visibility: FileVisibility } | "delete" | "restore") {
    fullCapability(principal, typeof change === "object" ? "files.visibility.change" : "files.manage");
    const policy = change === "delete" ? await rules() : null;
    try {
      return await writeFileInTx(principal, filePublicId, change, policy);
    } catch (error) {
      await recordWriteDenied(principal, filePublicId, typeof change === "object" ? "update" : change, error);
      throw error;
    }
  }

  function writeFileInTx(principal: SessionPrincipal, filePublicId: string, change: { visibility: FileVisibility } | "delete" | "restore", policy: FileRules | null) {
    return currentTx(async (tx) => {
      const initial = await findFile(filePublicId, tx);
      const order = await deps.services.orders.assertCanWriteOrderById(principal, initial.orderId, { kind: "file", tx, forUpdate: true });
      await requireCurrent(principal, tx);
      const row = await findFile(filePublicId, tx, true);
      enforceVisibility(row, principal, order.ownerUserId, true);
      if (row.orderPublicId !== order.publicId) throw notFound("FILE_NOT_FOUND");
      const now = clock.now();
      let outcome: AuditEventInput["outcome"] = "completed";
      let reasonCode: string | undefined;
      let attributes: AuditEventInput["attributes"];
      if (typeof change === "object") {
        if (row.deletedAt) throw notFound("FILE_NOT_FOUND");
        await tx.update(orderFiles).set(change).where(eq(orderFiles.id, row.id));
        attributes = { from_visibility: row.visibility, to_visibility: change.visibility };
      } else if (change === "delete" && row.deletedAt) {
        // Review F-2: a repeated delete changes nothing and must not claim a completed removal.
        outcome = "refused";
        reasonCode = "ALREADY_REMOVED";
      } else if (change === "delete") {
        await tx.update(orderFiles).set({ deletedAt: now, purgeAfter: new Date(now.getTime() + policy!.retentionDays * day) }).where(eq(orderFiles.id, row.id));
      } else if (change === "restore") {
        if (!row.deletedAt || !row.purgeAfter || row.purgeAfter <= now) {
          throw conflict("FILE_NOT_RESTORABLE", "The file is not available to restore.");
        }
        await tx.update(orderFiles).set({ deletedAt: null, purgeAfter: null }).where(eq(orderFiles.id, row.id));
      }
      await tx.delete(fileDownloadTickets).where(eq(fileDownloadTickets.fileId, row.id));
      await audit.record({
        ...event(principal, typeof change === "object" ? "file.visibility.changed" : change === "delete" ? "file.removed" : "file.restored",
          typeof change === "object" ? "update" : change, outcome, filePublicId, reasonCode),
        ...(attributes ? { attributes } : {}),
      }, tx);
      return output(await findFile(filePublicId, tx, true));
    });
  }

  deps.jobs.register(retentionJob, async (job) => {
    await job.assertStillOwned();
    const now = clock.now();
    const stagingRemoved = await local.sweepStaging?.(new Date(now.getTime() - 2 * day), job.signal) ?? 0;
    const expired = await db.select({ id: fileDownloadTickets.id }).from(fileDownloadTickets)
      .where(lte(fileDownloadTickets.expiresAt, now)).orderBy(fileDownloadTickets.expiresAt).limit(1000);
    if (expired.length) await db.delete(fileDownloadTickets).where(inArray(fileDownloadTickets.id, expired.map(({ id }) => id)));
    const candidates = await db.select({
      id: orderFiles.id, orderId: orderFiles.orderId, publicId: orderFiles.publicId, purgeAfter: orderFiles.purgeAfter,
    }).from(orderFiles)
      .where(and(isNotNull(orderFiles.deletedAt), lte(orderFiles.purgeAfter, now), isNull(orderFiles.purgedAt),
        retentionCursor ? or(gt(orderFiles.purgeAfter, retentionCursor.after),
          and(eq(orderFiles.purgeAfter, retentionCursor.after), gt(orderFiles.id, retentionCursor.id))) : undefined))
      .orderBy(orderFiles.purgeAfter, orderFiles.id).limit(100);
    let purged = 0;
    for (const candidate of candidates) {
      job.signal.throwIfAborted();
      await job.assertStillOwned();
      const initialOrder = await deps.services.orders.getOrderRefById(candidate.orderId);
      if (!initialOrder || initialOrder.lockState === "legal_hold") continue;
      const input: AuditEventInput = {
        category: "file", eventName: "file.retention.purged", action: "purge", outcome: "attempted",
        actor: { role: "system" }, resource: { type: "file", publicId: candidate.publicId }, correlationId: job.correlationId, jobId: job.jobId,
      };
      // Commit intent before acquiring the publication transaction. A lost commit after an unlink
      // leaves a durable attempted event; the retry can safely unlink an already absent object.
      await audit.record(input);
      const didPurge = await currentTx(async (tx) => {
        await job.assertStillOwned(tx);
        const order = await deps.services.orders.getOrderRefById(candidate.orderId, tx, { forUpdate: true });
        if (!order || order.lockState === "legal_hold") return false;
        const [row] = await tx.select().from(orderFiles).where(eq(orderFiles.id, candidate.id)).limit(1).for("update");
        if (!row?.deletedAt || !row.purgeAfter || row.purgedAt || row.purgeAfter > now) return false;
        if (row.orderId !== order.id || row.orderPublicId !== order.publicId || row.publicId !== candidate.publicId) return false;
        await audit.record({ ...input, outcome: "completed" }, tx);
        job.signal.throwIfAborted();
        await storage.delete(row.storageKey);
        await tx.update(orderFiles).set({ purgedAt: now }).where(eq(orderFiles.id, row.id));
        return true;
      });
      if (didPurge) purged++;
    }
    // Cycle through due rows so a batch of held orders cannot indefinitely starve later files.
    const last = candidates.at(-1);
    retentionCursor = candidates.length === 100 && last?.purgeAfter ? { after: last.purgeAfter, id: last.id } : undefined;
    return { outcome: "completed", safeCounts: { purged, stagingRemoved, expiredTickets: expired.length } };
  });
  deps.jobs.registerSchedule({ name: retentionJob, type: retentionJob, everyMs: 60 * 60_000 });

  const service: FilesModule = {
    async health() {
      let healthy = true;
      try {
        await local.checkRoot?.();
      } catch {
        healthy = false;
      }
      const antivirus = scanner ? await scanner.health().catch(() => "failing" as const) : "not_configured";
      return [
        { component: "storage.local", state: healthy ? "ok" : "failing", summary: healthy ? "Private storage is available." : "Private storage is unavailable.", checkedAt: clock.now() },
        { component: "files.antivirus", state: antivirus, summary: scanner ? "An external scanner is configured." : "External antivirus scanning is not configured.", checkedAt: clock.now() },
      ];
    },
    async beginUpload(principal, orderPublicId, options) {
      try {
        requireFull(principal);
        if (principal.role === "customer" && (options.category === "deliverable" || options.visibility === "staff_only")) {
          throw forbidden("FILE_STAFF_ONLY");
        }
        if (principal.role !== "customer") fullCapability(principal, "files.manage");
        const order = await deps.services.orders.assertCanWriteOrder(principal, orderPublicId, { kind: "file" });
        return { ...options, orderPublicId: order.publicId, orderId: order.id, ownerUserId: order.ownerUserId, statusKey: order.statusKey, rules: await rules() };
      } catch (error) {
        if (error instanceof DomainError && error.code !== "AUDIT_UNAVAILABLE") await orderEvent(principal, orderPublicId, error.reasonCode);
        throw error;
      }
    },
    async stageUpload(name, stream, policy) {
      const displayName = sanitizeDisplayName(name);
      if (!policy.extensions.includes(displayExtension(displayName) as FileExtension)) {
        throw validation("FILE_TYPE_DISABLED", "The file extension is not enabled for uploads.");
      }
      const key = local.newUploadKey?.() ?? storage.newKey("staging");
      try {
        const info = await storage.put(key, stream, { maxBytes: policy.maxFileBytes });
        const classification = await classifyObject(info, displayName, policy);
        const staged = { info, classification, displayName };
        await scanStaged(staged);
        return staged;
      } catch (error) {
        await cleanup(key);
        throw error;
      }
    },
    rejectUpload: orderEvent,
    cleanUpload: (staged) => cleanup(staged.info.key),
    async commitUpload(principal, request, staged) {
      requireFull(principal);
      if (!stagingKey.test(staged.info.key)) throw validation("INVALID_FILE_REFERENCE", "The staged file reference is invalid.");
      if (principal.role === "customer" && (request.category === "deliverable" || request.visibility === "staff_only")) {
        throw forbidden("FILE_STAFF_ONLY");
      }
      if (principal.role !== "customer") fullCapability(principal, "files.manage");
      const policy = await rules();
      if (!policy.extensions.includes(staged.classification.extension as FileExtension) || staged.info.size > policy.maxFileBytes) {
        throw validation("FILE_POLICY_CHANGED", "The file no longer meets the current upload rules.");
      }
      const storageKey = storage.newKey("files");
      let placementAttempted = false;
      try {
        return await currentTx(async (tx) => {
          const order = await deps.services.orders.assertCanWriteOrder(principal, request.orderPublicId, { kind: "file", tx, forUpdate: true });
          await requireCurrent(principal, tx);
          if (order.id !== request.orderId || order.ownerUserId !== request.ownerUserId || order.statusKey !== request.statusKey) {
            throw conflict("ORDER_ACCESS_CHANGED", "The order changed during upload. Please reload and try again.");
          }
          const previous = request.versionOf ? await findFile(request.versionOf, tx, true) : undefined;
          if (previous) {
            if (previous.orderId !== order.id || previous.orderPublicId !== order.publicId) throw notFound("FILE_NOT_FOUND");
            enforceVisibility(previous, principal, order.ownerUserId);
            if (previous.supersededAt) throw conflict("FILE_VERSION_CHANGED", "This file already has a newer version.");
            if (previous.category !== request.category || previous.visibility !== request.visibility) {
              throw validation("FILE_VERSION_SCOPE", "A new version must preserve its file category and visibility.");
            }
          }
          const file = await insertVersion(tx, principal, { ...request, staged, storageKey, previous });
          placementAttempted = true;
          await storage.move(staged.info.key, storageKey);
          await deps.services.storageConnections?.stageOrderFile(file.publicId, tx);
          return file;
        });
      } catch (error) {
        if (placementAttempted) {
          // The client could lose the MySQL COMMIT acknowledgement. Never delete committed data on an
          // uncertain outcome; leave it for operator reconciliation if the authoritative check fails.
          const committed = await db.select({ id: orderFiles.id }).from(orderFiles).where(eq(orderFiles.storageKey, storageKey)).limit(1)
            .then((rows) => rows.length > 0).catch(() => undefined);
          if (committed === false) await cleanup(storageKey);
          else if (committed === undefined) logger.warn("Private file publication outcome requires reconciliation");
        }
        throw error;
      }
    },
    async list(principal, orderPublicId, options) {
      const page = await currentTx((tx) => getPage(principal, orderPublicId, options, tx));
      return { ...page, uploadPolicy: page.canUpload ? publicPolicy(await rules()) : null };
    },
    async enumerateOrderFiles(principal, orderPublicId, options = {}) {
      const { items, nextCursor } = await service.list(principal, orderPublicId, { ...options, includeDeleted: false });
      return { items, nextCursor };
    },
    async assertCanReadFile(principal, filePublicId, orderPublicId) {
      return output(await currentTx((tx) => readFile(principal, filePublicId, orderPublicId, tx)));
    },
    async openForExport(principal, filePublicId, orderPublicId, callerTx) {
      fullCapability(principal, "portable.export");
      let stream: Readable | undefined;
      try {
        const open = async (tx: Tx) => {
          const row = await readFile(principal, filePublicId, orderPublicId, tx);
          await audit.record(event(principal, "file.export.open", "export", "attempted", filePublicId), tx);
          const file = output(row);
          stream = await readObject(row);
          return { file, stream };
        };
        return await (callerTx ? open(callerTx) : currentTx(open));
      } catch (error) {
        stream?.destroy();
        throw error;
      }
    },
    async issueDownloadTicket(principal, filePublicId) {
      try {
        return await currentTx(async (tx) => {
          const row = await readFile(principal, filePublicId, undefined, tx);
          await requireCurrent(principal, tx);
          const ticket = randomToken();
          const now = clock.now();
          const expiresAt = new Date(now.getTime() + ticketLifetimeMs);
          await tx.insert(fileDownloadTickets).values({
            tokenHash: crypto.hashToken(ticket), orderId: row.orderId, fileId: row.id, userId: principal.userId, sessionId: principal.sessionId,
            issuedAt: now, expiresAt,
          });
          await audit.record(event(principal, "file.download.ticket_issued", "create", "completed", row.publicId), tx);
          return { ticket, expiresAt };
        });
      } catch (error) {
        if (error instanceof DomainError && ["NOT_FOUND", "FORBIDDEN", "UNAUTHENTICATED", "REMEDIATION_REQUIRED"].includes(error.code)) {
          await service.recordDownloadDenied(principal, error.reasonCode);
        }
        throw error;
      }
    },
    async redeemDownloadTicket(principal, ticket) {
      let stream: Readable | undefined;
      try {
        requireFull(principal);
        if (!tokenShape.test(ticket) || ticket.length !== 43) throw notFound("DOWNLOAD_TICKET_INVALID");
        const ticketHash = crypto.hashToken(ticket);
        return await currentTx(async (tx) => {
          const [candidate] = await tx.select().from(fileDownloadTickets).where(eq(fileDownloadTickets.tokenHash, ticketHash)).limit(1);
          if (!candidate || candidate.userId !== principal.userId || candidate.sessionId !== principal.sessionId || candidate.expiresAt <= clock.now()) {
            throw notFound("DOWNLOAD_TICKET_INVALID");
          }
          // Order row before ticket row: matches the reassignment/revoke lock order.
          const order = await deps.services.orders.assertCanReadOrderById(principal, candidate.orderId, { tx, forUpdate: true });
          await requireCurrent(principal, tx);
          const [current] = await tx.select().from(fileDownloadTickets).where(eq(fileDownloadTickets.id, candidate.id)).limit(1).for("update");
          if (!current || current.userId !== principal.userId || current.sessionId !== principal.sessionId || current.expiresAt <= clock.now()) {
            throw notFound("DOWNLOAD_TICKET_INVALID");
          }
          const [row] = await tx.select().from(orderFiles).where(eq(orderFiles.id, current.fileId)).limit(1).for("update");
          if (!row || row.orderId !== order.id || row.orderPublicId !== order.publicId) throw notFound("FILE_NOT_FOUND");
          enforceVisibility(row, principal, order.ownerUserId);
          const file = output(row);
          await access(principal, "attempted", tx, row.publicId);
          await tx.delete(fileDownloadTickets).where(eq(fileDownloadTickets.id, current.id));
          stream = await readObject(row);
          return { file, stream };
        });
      } catch (error) {
        stream?.destroy();
        if (error instanceof DomainError && ["NOT_FOUND", "FORBIDDEN", "UNAUTHENTICATED", "REMEDIATION_REQUIRED"].includes(error.code)) {
          await service.recordDownloadDenied(principal, error.reasonCode);
          throw notFound("DOWNLOAD_TICKET_INVALID");
        }
        if (error instanceof DomainError && error.reasonCode === "FILE_BYTES_UNAVAILABLE") {
          await db.transaction((tx) => access(principal, "failed", tx, undefined, "FILE_BYTES_UNAVAILABLE"));
        }
        throw error;
      }
    },
    recordDownloadDenied: (principal, reason) => db.transaction((tx) => access(principal, "denied", tx, undefined, reason)),
    recordDownloadResult: (principal, publicId, outcome) => db.transaction((tx) => access(principal, outcome, tx, publicId)),
    setVisibility: (principal, publicId, visibility) => writeFile(principal, publicId, { visibility }),
    remove: (principal, publicId) => writeFile(principal, publicId, "delete"),
    restore: (principal, publicId) => writeFile(principal, publicId, "restore"),
    async adminOverview(principal) {
      requireFull(principal);
      if (principal.role !== "admin") throw forbidden("CAPABILITY_NOT_GRANTED");
      const [row] = await db.select({
        storedFiles: count(orderFiles.id),
        storedBytes: sql<string>`COALESCE(SUM(${orderFiles.byteSize}), 0)`,
        retainedFiles: sql<number>`COALESCE(SUM(${orderFiles.deletedAt} IS NOT NULL), 0)`,
      }).from(orderFiles).where(isNull(orderFiles.purgedAt));
      return { rules: await rules(), storedFiles: row?.storedFiles ?? 0, storedBytes: String(row?.storedBytes ?? 0),
        retainedFiles: Number(row?.retainedFiles ?? 0), antivirus: scanner ? "configured" : "not_configured",
        supported: { extensions: [...allowedExtensions], maxFileBytes: hardMaxFileBytes, maxRequestBytes: hardMaxRequestBytes, maxFiles: hardMaxFiles } };
    },
    async setTypeRules(principal, value) {
      fullCapability(principal, "platform.settings.manage", true);
      if (principal.role !== "admin") throw forbidden("CAPABILITY_NOT_GRANTED");
      return currentTx(async (tx) => {
        const current = await requireCurrent(principal, tx);
        fullCapability({ ...principal, role: current.role, stepUpAt: current.stepUpAt }, "platform.settings.manage", true);
        if (current.role !== "admin") throw forbidden("CAPABILITY_NOT_GRANTED");
        await writeSetting(settings, fileRulesSetting, value, tx);
        await audit.record(event(principal, "file.rules.changed", "update", "completed"), tx);
        return value;
      });
    },
    async revokeTicketsForOrder(orderId, tx = undefined) {
      await (tx ?? db).delete(fileDownloadTickets).where(eq(fileDownloadTickets.orderId, orderId));
    },
    async reassignOrderFiles(orderId, ownerUserId, tx) {
      await tx.update(orderFiles).set({ ownerUserId }).where(eq(orderFiles.orderId, orderId));
      await service.revokeTicketsForOrder(orderId, tx);
    },
    async validatePortableObject(input, tx) {
      const { classification } = await validatePortable(input, tx);
      return { extension: classification.extension, contentType: classification.mime };
    },
    async adoptVerifiedObject(input, tx) {
      fullCapability(input.principal, "portable.import", true);
      if (!filesKey.test(input.destinationKey) || (input.publicId !== undefined && !publicIdShape(input.publicId)) ||
          (input.phasePublicId !== undefined && input.phasePublicId !== null)) {
        throw validation("INVALID_FILE_REFERENCE", "The imported file reference is invalid.");
      }
      if (input.createdAt && (!Number.isFinite(input.createdAt.getTime()) || input.createdAt.getUTCFullYear() < 1000 || input.createdAt.getUTCFullYear() >= 9999)) {
        throw validation("INVALID_FILE_DATE", "The imported file timestamp is invalid.");
      }
      const order = await deps.services.orders.assertCanReadOrderById(input.principal, input.orderId, { tx, forUpdate: true });
      if (order.publicId !== input.orderPublicId || order.ownerUserId !== input.ownerUserId || order.origin !== "import") {
        throw notFound("ORDER_NOT_FOUND");
      }
      const staged = await validatePortable(input, tx);
      await scanStaged(staged);
      const file = await insertVersion(tx, input.principal, {
        ...input, staged, storageKey: input.destinationKey, statusKey: order.statusKey, imported: true,
      });
      await storage.move(input.stagedObject.key, input.destinationKey);
      return file;
    },
    async portableFiles(tx, options) {
      fullCapability(options.principal, "portable.export");
      const limit = boundedLimit(options.limit);
      if (options.orderIds?.length === 0) return { items: [], nextCursor: null };
      if (options.orderIds && options.orderIds.length > 500) throw validation("INVALID_FILE_SELECTION", "Select fewer orders at a time.");
      const after = cursorValue(options.after);
      const rows = await tx.select().from(orderFiles).where(and(
        options.orderIds ? inArray(orderFiles.orderId, [...options.orderIds]) : undefined,
        after ? gt(orderFiles.publicId, after) : undefined,
        isNull(orderFiles.deletedAt), isNull(orderFiles.supersededAt), isNull(orderFiles.purgedAt),
      )).orderBy(orderFiles.publicId).limit(limit + 1);
      const items: PortableStoredFile[] = [];
      for (const row of rows.slice(0, limit)) {
        const order = await deps.services.orders.assertCanReadOrderById(options.principal, row.orderId, { tx });
        enforceVisibility(row, options.principal, order.ownerUserId);
        if (row.orderPublicId !== order.publicId) throw notFound("FILE_NOT_FOUND");
        items.push({ ...output(row), storageKey: row.storageKey, orderId: order.id, ownerUserId: order.ownerUserId, ownerPublicId: order.ownerPublicId });
      }
      return { items, nextCursor: rows.length > limit ? encodeCursor(rows[limit - 1]!.publicId) : null };
    },
    async backupFiles(tx, options) {
      const limit = boundedLimit(options.limit);
      const after = cursorValue(options.after);
      const rows = await tx.select().from(orderFiles).where(and(
        after ? gt(orderFiles.publicId, after) : undefined, isNull(orderFiles.purgedAt),
      )).orderBy(orderFiles.publicId).limit(limit + 1);
      return {
        items: rows.slice(0, limit).map((row) => ({ ...output(row), storageKey: row.storageKey })),
        nextCursor: rows.length > limit ? encodeCursor(rows[limit - 1]!.publicId) : null,
      };
    },
    async getOrderFileCopySource(filePublicId, tx) {
      const unavailable = () => notFound("STORAGE_COPY_SOURCE_INACTIVE");
      const findSource = (lock: boolean) => findFile(filePublicId, tx, lock).catch((error: unknown) => {
        if (error instanceof DomainError && error.code === "NOT_FOUND") throw unavailable();
        throw error;
      });
      const initial = await findSource(false);
      const order = await deps.services.orders.getOrderRefById(initial.orderId, tx, { forUpdate: true });
      if (!order || order.lockState !== "none") throw unavailable();
      const owner = await deps.services.identity.getUser(order.ownerUserId, { tx, forUpdate: true });
      const row = await findSource(true);
      if (!owner || owner.status !== "active" || row.orderId !== order.id || row.orderPublicId !== order.publicId ||
          row.ownerUserId !== owner.id || row.deletedAt || row.purgedAt) throw unavailable();
      return {
        storageKey: row.storageKey, size: row.byteSize, sha256: row.sha256, contentType: row.contentType,
        displayName: output(row).displayName, extension: row.extension, ownerUserId: owner.id,
        customerName: owner.name, customerReference: owner.customerRef ?? owner.publicId,
        customerPublicId: owner.publicId, orderReference: order.reference, orderPublicId: order.publicId, filePublicId: row.publicId,
      };
    },
    async listOrderFileCopyCandidates(orderPublicId, tx) {
      const order = await deps.services.orders.getOrderRefByPublicId(orderPublicId, tx, { forUpdate: true });
      if (!order || order.lockState !== "none") return null;
      const owner = await deps.services.identity.getUser(order.ownerUserId, { tx, forUpdate: true });
      if (!owner || owner.status !== "active") return null;
      const rows = await tx.select({ publicId: orderFiles.publicId }).from(orderFiles)
        .where(and(eq(orderFiles.orderId, order.id), eq(orderFiles.orderPublicId, order.publicId),
          eq(orderFiles.ownerUserId, order.ownerUserId), isNull(orderFiles.deletedAt), isNull(orderFiles.purgedAt),
          isNull(orderFiles.supersededAt))).orderBy(orderFiles.publicId).limit(51);
      return rows.map(({ publicId }) => publicId);
    },
    async getUploadAutomationContext(filePublicId, handle) {
      if (!publicIdShape(filePublicId)) return null;
      const [row] = await handle.select({
        orderPublicId: orderFiles.orderPublicId, orderOwnerUserId: orderFiles.ownerUserId, category: orderFiles.category,
      }).from(orderFiles).where(and(eq(orderFiles.publicId, filePublicId), isNull(orderFiles.deletedAt),
        isNull(orderFiles.purgedAt))).limit(1);
      return row ?? null;
    },
  };
  return service;
}
