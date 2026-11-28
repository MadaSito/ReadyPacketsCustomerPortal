import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { isResolvedOrderFileFolder, resolveStageOrderFileFolder, safeOrderFileFolderValue } from "../../../shared/orderFileFolder.js";
import type { ManagedFileSyncRole, StageFileSyncPlan } from "../../../shared/orderStageFileSync.js";
import type { ModuleDeps } from "../../container.js";
import { conflict, DomainError, forbidden, notFound, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { ClaimedJob, JobResult, SessionPrincipal, Tx } from "../../core/types.js";
import { jobRuns } from "../jobs/schema.js";
import { orders } from "../orders/schema.js";
import { liveOrderPredicate } from "../orders/trashGate.js";
import { assertCurrentStorageAdmin } from "./authz.js";
import { StorageAdapterError, type StorageAdapter } from "./contracts.js";
import { storageAssignments, storageConnections as connections, storageManagedFileCopies as copies, storageManagedOrderRoots as roots } from "./schema.js";
import { copySegment, storagePublicId, storageTest } from "./validation.js";

export const managedTargetUpdate = storageTest.extend({ mode: z.enum(["phase_files", "receipts"]).nullable(), confirm: z.literal(true) });
export const managedResyncScope = z.discriminatedUnion("scope", [
  z.strictObject({ scope: z.literal("file"), orderPublicId: storagePublicId, filePublicId: storagePublicId }),
  z.strictObject({ scope: z.literal("order"), orderPublicId: storagePublicId }),
  z.strictObject({ scope: z.literal("target"), publicId: storagePublicId }),
]);
export const managedResyncInput = z.strictObject({ scope: managedResyncScope, previewToken: z.string().min(32).max(1024) });
export const managedOrderInput = z.strictObject({ orderPublicId: storagePublicId, cursor: storagePublicId.optional() });
type Scope = z.infer<typeof managedResyncScope>;
type Row = typeof copies.$inferSelect;
type Connection = typeof connections.$inferSelect;
const COPY_JOB = "storage.copy_managed_order_file";
const RECOVER_JOB = "storage.reconcile_interrupted_file_sync";
const MAX_RESYNC = 100;
const MAX_TRIES = 5;
const target = z.strictObject({ path: z.array(copySegment).min(1).max(8), name: copySegment, ownerUserId: z.number().int().positive(),
  visibility: z.enum(["staff_only", "customer_visible"]).nullable(), invalidPath: z.literal(true).optional() });
const jobBody = z.strictObject({ publicId: storagePublicId, inspect: z.boolean(), tryNo: z.number().int().min(1).max(MAX_TRIES) });
type Target = z.infer<typeof target>;
const rootAad = (id: string) => `storage_managed_order_roots.root_enc:${id}`;
const targetAad = (id: string) => `storage_managed_file_copies.target_enc:${id}`;
const previewAad = (userId: number, sessionId: string) => `storage_managed_file_copies.resync_preview:${userId}:${sessionId}`;
const previewProof = z.strictObject({ expiresAt: z.number().int(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/u) });
const enabled = (r: Connection | undefined, mode: "phase_files" | "receipts") =>
  !!r && r.enabled && !!r.credentialsEnc && (r.kind === "sharepoint" || r.kind === "onedrive") &&
  r.fileSyncMode === mode && r.fileSyncWriteTestVersion === r.destinationVersion;
const modeFor = (role: ManagedFileSyncRole) => role === "receipt" ? "receipts" : "phase_files";
const inactive = () => notFound("STORAGE_COPY_SOURCE_INACTIVE");
const targetInactive = () => notFound("STORAGE_FILE_SYNC_TARGET_INACTIVE");
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const liveCopyOrder = () => sql`exists (select 1 from ${orders} where ${orders.publicId} = ${copies.orderPublicId} and ${liveOrderPredicate()})`;

export function createManagedFileSync(deps: ModuleDeps, adapterFor: (row: Connection) => StorageAdapter) {
  const { clock, audit, db, crypto, services, jobs, storage } = deps;
  const transaction = <T>(f: (tx: Tx) => Promise<T>) => db.transaction(f, { isolationLevel: "read committed" });
  const auditAdmin = (principal: SessionPrincipal, action: string, correlationId: string, tx: Tx, publicId?: string,
    count?: number, outcome: "attempted" | "completed" | "failed" = "completed") =>
    audit.record({ category: "integration", eventName: `storage.file_sync.${action}`, action, outcome, correlationId,
      actor: { userId: principal.userId, role: principal.role },
      ...(publicId ? { resource: { type: "storage_connection", publicId } } : {}),
      ...(count !== undefined ? { safeCounts: { intents: count } } : {}) }, tx);
  async function getConnection(id: string, tx: Tx, lock = false) {
    const query = tx.select().from(connections).where(eq(connections.publicId, id)).limit(1);
    return (await (lock ? query.for("update") : query))[0];
  }
  async function assertDestination(row: Row, tx: Tx) {
    const r = await getConnection(row.connectionPublicId, tx, true);
    if (!r || !enabled(r, modeFor(row.role)) || r.destinationVersion !== row.destinationVersion) throw targetInactive();
    return r;
  }
  async function getRoot(input: { orderPublicId: string; orderReference: string; customerName: string; customerPublicId: string; ownerUserId: number }, tx: Tx) {
    const customer = `${safeOrderFileFolderValue(input.customerName, 42)}-${input.customerPublicId}`;
    const order = safeOrderFileFolderValue(input.orderReference, 75);
    await tx.insert(roots).values({ orderPublicId: input.orderPublicId, createdAt: clock.now(),
      rootEnc: crypto.encrypt(JSON.stringify({ customer, order, ownerUserId: input.ownerUserId }), rootAad(input.orderPublicId)),
    }).onDuplicateKeyUpdate({ set: { id: sql`${roots.id}` } });
    const [r] = await tx.select({ rootEnc: roots.rootEnc }).from(roots).where(eq(roots.orderPublicId, input.orderPublicId));
    if (!r) throw new Error("STORAGE_ORDER_ROOT_UNAVAILABLE");
    const frozen = z.strictObject({ customer: copySegment, order: copySegment, ownerUserId: z.number().int().positive() })
      .parse(JSON.parse(crypto.decrypt(r.rootEnc, rootAad(input.orderPublicId))));
    return frozen.ownerUserId === input.ownerUserId ? frozen : null;
  }
  async function queue(row: Row, tx: Tx, correlationId?: string, inspect = false, tryNo = 1, delaySeconds = 0) {
    const { jobId } = await jobs.enqueue(COPY_JOB, { publicId: row.publicId, inspect, tryNo }, {
      maxAttempts: 1, correlationId, ...(delaySeconds > 0 ? { runAt: new Date(clock.now().getTime() + delaySeconds * 1000) } : {}),
    }, tx);
    await tx.update(copies).set({ jobPublicId: jobId, updatedAt: clock.now(), ...(inspect ? {} :
      { state: "queued" as const, reasonCode: null, finishedAt: null }) }).where(eq(copies.id, row.id));
  }
  async function stage(input: { orderPublicId: string; sourcePublicId: string; role: ManagedFileSyncRole; destination: Connection; target: Target }, tx: Tx) {
    if (!isResolvedOrderFileFolder(input.target.path) || !isResolvedOrderFileFolder([input.target.name])) return;
    const publicId = ulid(clock.now().getTime());
    await tx.insert(copies).values({ publicId, orderPublicId: input.orderPublicId, sourcePublicId: input.sourcePublicId,
      connectionPublicId: input.destination.publicId, destinationVersion: input.destination.destinationVersion, role: input.role,
      targetEnc: crypto.encrypt(JSON.stringify(input.target), targetAad(publicId)), createdAt: clock.now(), updatedAt: clock.now(),
    }).onDuplicateKeyUpdate({ set: { id: sql`${copies.id}` } });
    const [row] = await tx.select().from(copies).where(eq(copies.publicId, publicId));
    if (row) await queue(row, tx);
  }
  function readTarget(row: Row) {
    return target.parse(JSON.parse(crypto.decrypt(row.targetEnc, targetAad(row.publicId))));
  }
  async function readSource(row: Row, destination: Target, tx: Tx) {
    if (row.role === "receipt") {
      const order = await services.orders.getOrderRefByPublicId(row.orderPublicId, tx, { forUpdate: true });
      if (!order || order.lockState !== "none" || order.ownerUserId !== destination.ownerUserId) throw inactive();
      const owner = await services.identity.getUser(order.ownerUserId, { tx, forUpdate: true });
      if (owner?.status !== "active") throw inactive();
      const pdf = await services.compliance.receipts.getFileSyncPdf({ receiptPublicId: row.sourcePublicId, orderPublicId: row.orderPublicId }, tx);
      if (!pdf || pdf.length === 0 || pdf.length > 8 * 1024 * 1024) throw inactive();
      return { size: pdf.length, sha256: sha256(pdf), contentType: "application/pdf", pdf, storageKey: null } as const;
    }
    const file = await services.files.getOrderFileCopySource(row.sourcePublicId, tx);
    if (file.orderPublicId !== row.orderPublicId || file.ownerUserId !== destination.ownerUserId ||
        file.visibility !== destination.visibility) throw inactive();
    return { size: file.size, sha256: file.sha256, contentType: file.contentType, pdf: null, storageKey: file.storageKey } as const;
  }
  async function finish(row: Row, job: ClaimedJob, tx: Tx, state: Row["state"], reasonCode: string | null, remoteId?: string) {
    const at = clock.now();
    await tx.update(copies).set({ state, reasonCode, finishedAt: at, updatedAt: at,
      ...(remoteId ? { remoteIdEnc: crypto.encrypt(remoteId, `storage_managed_file_copies.remote_id_enc:${row.publicId}`) } : {}),
    }).where(and(eq(copies.id, row.id), eq(copies.jobPublicId, job.jobId)));
    await audit.record({ category: "integration", eventName: `storage.file_sync.${state === "copied" ? "completed" : state}`,
      action: "copy", outcome: state === "copied" ? "completed" : state === "unknown" ? "unknown" : state === "blocked" ? "refused" : "failed",
      actor: { role: "system" }, orderPublicId: row.orderPublicId, jobId: job.jobId, correlationId: job.correlationId,
      resource: { type: "storage_managed_file_copy", publicId: row.publicId }, ...(reasonCode ? { reasonCode } : {}),
    }, tx);
  }
  async function report(row: Row, job: ClaimedJob, state: Row["state"], code?: string) {
    const reference = { source: "file_sync" as const, dedupKey: row.publicId, correlationId: job.correlationId };
    try {
      if (state === "copied") await services.opsAlerts.resolve(reference);
      else if (code && code !== "STORAGE_COPY_SOURCE_INACTIVE") await services.opsAlerts.emit({ ...reference,
        code, orderPublicId: row.orderPublicId, severity: state === "unknown" ? "critical" : "error",
        title: state === "unknown" ? "Microsoft 365 file sync needs reconciliation" : "Microsoft 365 file sync blocked",
      });
    } catch { /* The durable transfer result must survive an unavailable alert service. */ }
  }
  jobs.register(COPY_JOB, async (job): Promise<JobResult> => {
    const parsed = jobBody.safeParse(job.payload);
    if (!parsed.success) return { outcome: "failed", reasonCode: "STORAGE_FILE_SYNC_INVALID_JOB", retryable: false };
    const { publicId, inspect, tryNo } = parsed.data;
    const [row] = await db.select().from(copies).where(eq(copies.publicId, publicId)).limit(1);
    if (!row || row.jobPublicId !== job.jobId || row.state === "copied" || row.reasonCode === "STORAGE_COPY_ORDER_TRASHED") {
      return { outcome: "completed" };
    }
    let body: Readable | undefined;
    const readOnly = inspect || row.state === "copying" || row.state === "unknown";
    try {
      const destination = readTarget(row);
      if (destination.invalidPath) throw validation("STORAGE_FILE_SYNC_FOLDER_INVALID", "The configured phase folder is too long or invalid.");
      const prepared = await transaction(async (tx) => {
        await job.assertStillOwned(tx);
        if (readOnly && !await services.orders.getOrderRefByPublicId(row.orderPublicId, tx, { forUpdate: true })) throw inactive();
        const source = readOnly ? null : await readSource(row, destination, tx);
        const connection = await assertDestination(row, tx);
        const [locked] = await tx.select().from(copies).where(eq(copies.id, row.id)).for("update");
        if (!locked || locked.jobPublicId !== job.jobId || locked.reasonCode === "STORAGE_COPY_ORDER_TRASHED") throw inactive();
        if (!readOnly) await tx.update(copies).set({ state: "copying", updatedAt: clock.now() }).where(eq(copies.id, row.id));
        await audit.record({ category: "integration", eventName: "storage.file_sync.attempted", action: readOnly ? "inspect" : "copy",
          outcome: "attempted", actor: { role: "system" }, orderPublicId: row.orderPublicId, jobId: job.jobId,
          correlationId: job.correlationId, resource: { type: "storage_managed_file_copy", publicId: row.publicId } }, tx);
        return { source, connection };
      });
      const adapter = adapterFor(prepared.connection);
      const { source } = prepared;
      if (!source) {
        const existence = await adapter.inspectExact?.(destination.path, destination.name, job.signal);
        const code = existence === "present" ? "STORAGE_FILE_SYNC_REMOTE_PRESENT" : "STORAGE_FILE_SYNC_REMOTE_UNCONFIRMED";
        await transaction(async (tx) => { await job.assertStillOwned(tx); await finish(row, job, tx, "unknown", code); });
        await report(row, job, "unknown", code);
        return { outcome: "unknown", reasonCode: code };
      }
      const beforeWrite = () => transaction(async (tx) => {
        job.signal.throwIfAborted();
        await job.assertStillOwned(tx);
        const current = await readSource(row, destination, tx);
        if (current.sha256 !== source.sha256 || current.size !== source.size || current.storageKey !== source.storageKey) throw inactive();
        await assertDestination(row, tx);
        const [locked] = await tx.select({ jobPublicId: copies.jobPublicId }).from(copies).where(eq(copies.id, row.id)).for("update");
        if (locked?.jobPublicId !== job.jobId) throw inactive();
      });
      if (source.pdf) body = Readable.from([source.pdf]);
      else {
        const local = await storage.stat(source.storageKey).catch(() => null);
        if (!local || local.size !== source.size || local.sha256 !== source.sha256) throw new StorageAdapterError("INTEGRITY_MISMATCH");
        body = await storage.get(source.storageKey).catch(() => { throw new StorageAdapterError("PROVIDER_UNAVAILABLE", true); });
      }
      await beforeWrite();
      const result = await adapter.put({ path: destination.path, name: destination.name, size: source.size, sha256: source.sha256,
        contentType: source.contentType, body, beforeWrite, exactCreate: true, signal: job.signal });
      if (result.size !== source.size || !result.remoteId || !result.verifiedTransportDigest) throw new StorageAdapterError("OUTCOME_UNKNOWN");
      await transaction(async (tx) => { await job.assertStillOwned(tx); await finish(row, job, tx, "copied", null, result.remoteId); });
      await report(row, job, "copied");
      return { outcome: "completed", safeCounts: { files: 1 } };
    } catch (error) {
      job.signal.throwIfAborted();
      const stopped = error instanceof DomainError && ["STORAGE_COPY_SOURCE_INACTIVE", "STORAGE_FILE_SYNC_TARGET_INACTIVE",
        "STORAGE_FILE_SYNC_FOLDER_INVALID"].includes(error.reasonCode);
      const adapterError = error instanceof StorageAdapterError ? error : null;
      const uncertain = readOnly || (!stopped && (!adapterError || adapterError.code === "OUTCOME_UNKNOWN"));
      const code = uncertain ? "STORAGE_FILE_SYNC_UNCERTAIN" : stopped ? error.reasonCode : `STORAGE_FILE_SYNC_${adapterError?.code}`;
      const providerDelay = adapterError?.retryAfterSeconds ?? 0;
      const retry = !uncertain && adapterError?.retryable && tryNo < MAX_TRIES && providerDelay <= 86_400;
      const state = uncertain ? "unknown" : stopped ? "blocked" : "failed";
      await transaction(async (tx) => {
        await job.assertStillOwned(tx);
        await finish(row, job, tx, state, code);
        if (retry) await queue(row, tx, job.correlationId, false, tryNo + 1,
          Math.max(30 * 2 ** tryNo, providerDelay));
        else if (uncertain && !readOnly) await queue(row, tx, job.correlationId, true, 1, 30);
      });
      if (!retry) await report(row, job, state, code);
      return uncertain ? { outcome: "unknown", reasonCode: code } : { outcome: "failed", reasonCode: code, retryable: false };
    } finally { body?.destroy(); }
  });
  jobs.register(RECOVER_JOB, async (job) => {
    return transaction(async (tx) => {
      await job.assertStillOwned(tx);
      // An interrupted copy never schedules another write. Start a read-only inspection once.
      const interrupted = await tx.select({ copy: copies }).from(copies).innerJoin(jobRuns, eq(jobRuns.publicId, copies.jobPublicId))
        .where(and(liveCopyOrder(), inArray(copies.state, ["queued", "copying"]), inArray(jobRuns.state, ["unknown", "failed"])))
        .orderBy(copies.id).limit(50);
      let inspected = 0;
      for (const { copy } of interrupted) {
        const [current] = await tx.select().from(copies).where(eq(copies.id, copy.id)).for("update");
        if (!current || current.jobPublicId !== copy.jobPublicId || current.state !== copy.state) continue;
        await tx.update(copies).set({ state: "unknown", reasonCode: "STORAGE_FILE_SYNC_UNCERTAIN", updatedAt: clock.now() }).where(eq(copies.id, current.id));
        await queue(current, tx, job.correlationId, true);
        inspected++;
      }
      return { outcome: "completed", safeCounts: { inspected } };
    });
  }, { retrySafe: true });
  jobs.registerSchedule({ name: RECOVER_JOB, type: RECOVER_JOB, everyMs: 120_000 });

  async function summarize(tx: Tx, scope: Scope) {
    const condition = scope.scope === "target" ? eq(copies.connectionPublicId, scope.publicId) :
      and(eq(copies.orderPublicId, scope.orderPublicId), scope.scope === "file" ? eq(copies.sourcePublicId, scope.filePublicId) : undefined);
    const rows = await tx.select({ copy: copies, jobState: jobRuns.state }).from(copies)
      .leftJoin(jobRuns, eq(jobRuns.publicId, copies.jobPublicId)).leftJoin(connections, eq(connections.publicId, copies.connectionPublicId))
      .where(and(liveCopyOrder(), condition, or(inArray(copies.state, ["failed", "blocked", "unknown"]), eq(jobRuns.state, "unknown")),
        sql`coalesce(${jobRuns.state}, '') not in ('queued', 'running')`,
        eq(connections.enabled, true), isNotNull(connections.credentialsEnc), inArray(connections.kind, ["sharepoint", "onedrive"]),
        eq(connections.destinationVersion, copies.destinationVersion), eq(connections.fileSyncWriteTestVersion, connections.destinationVersion),
        sql`${connections.fileSyncMode} = case when ${copies.role} = 'receipt' then 'receipts' else 'phase_files' end`,
        sql`coalesce(${copies.reasonCode}, '') <> 'STORAGE_FILE_SYNC_FOLDER_INVALID'`,
        scope.scope === "file" ? undefined : sql`coalesce(${copies.reasonCode}, '') not in
          ('STORAGE_FILE_SYNC_REMOTE_PRESENT', 'STORAGE_FILE_SYNC_REMOTE_UNCONFIRMED', 'STORAGE_COPY_SOURCE_INACTIVE')`))
      .orderBy(copies.id).limit(MAX_RESYNC + 1);
    const candidates = rows.slice(0, MAX_RESYNC);
    const fingerprint = sha256(JSON.stringify([scope, candidates.map(({ copy }) => [copy.publicId, copy.jobPublicId, copy.state])]));
    return { candidates, fingerprint, count: candidates.length, more: rows.length > MAX_RESYNC,
      inspectOnly: candidates.filter(({ copy, jobState }) => copy.state === "unknown" || jobState === "unknown").length };
  }

  return {
    async stageFile(filePublicId: string, orderPublicId: string, tx: Tx): Promise<boolean> {
      const file = await services.files.getOrderFileCopySource(filePublicId, tx).catch((error: unknown) => {
        if (error instanceof DomainError && error.reasonCode === "STORAGE_COPY_SOURCE_INACTIVE") return null;
        throw error;
      });
      if (!file || file.orderPublicId !== orderPublicId || !file.stageKey) return false;
      const plan = await services.orders.stages.getOrderStageFileSync({ orderPublicId, stageKey: file.stageKey }, tx);
      if (!plan) return false;
      const intents = file.visibility === "staff_only" ? (["originals"] as const) :
        file.derivative ? (["conversionStaging", "intakeDelivery"] as const) :
        file.conversionState !== null ? (["originals"] as const) : (["originals", "intakeDelivery"] as const);
      const ids = intents.flatMap((role) => plan.fileSync[role] ? [plan.fileSync[role]] : []);
      if (!ids.length) return true;
      const frozen = await getRoot(file, tx);
      if (!frozen) return true;
      const destinations = await tx.select().from(connections).where(inArray(connections.publicId, ids));
      const audio = /^(?:audio|video)\//u.test(file.contentType);
      let path: string[];
      let invalidPath: true | undefined;
      try {
        path = [frozen.customer, frozen.order, ...resolveStageOrderFileFolder(audio ? plan.folders.audio : plan.folders.documents, {
          customer_ref: file.customerReference, order_ref: file.orderReference, order_name: file.orderName, phase: plan.key,
          slot: file.slotKey ?? "unslotted", yyyy: String(file.createdAt.getUTCFullYear()), mm: String(file.createdAt.getUTCMonth() + 1).padStart(2, "0"),
          phase_key: plan.key, order_number: frozen.order, customer_folder: frozen.customer,
        })];
        if (!isResolvedOrderFileFolder(path)) throw new RangeError("STORAGE_FILE_SYNC_FOLDER_INVALID");
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        path = [frozen.customer, frozen.order];
        invalidPath = true; // Display a blocked transfer; never send to this fallback path.
      }
      for (const role of intents) {
        const destination = destinations.find((r) => r.publicId === plan.fileSync[role]);
        if (!destination || (destination.kind !== "sharepoint" && destination.kind !== "onedrive") || destination.fileSyncMode !== "phase_files") continue;
        const ext = /^[a-z0-9]{1,12}$/u.test(file.extension) ? file.extension : "bin";
        const stem = safeOrderFileFolderValue(file.displayName.replace(/\.[^.]*$/u, ""), 75);
        await stage({ orderPublicId, sourcePublicId: filePublicId, role, destination,
          target: { path, name: `${stem} - ${role} - ${filePublicId}.${ext}`, ownerUserId: file.ownerUserId, visibility: file.visibility,
            ...(invalidPath ? { invalidPath } : {}) } }, tx);
      }
      return true;
    },
    async stageReceiptPdf(input: { receiptPublicId: string; orderPublicId: string }, tx: Tx) {
      const rows = await tx.select().from(connections).where(eq(connections.fileSyncMode, "receipts")).limit(2);
      const destination = rows[0];
      if (rows.length !== 1 || !destination || !enabled(destination, "receipts")) return;
      const order = await services.orders.getOrderRefByPublicId(input.orderPublicId, tx, { forUpdate: true });
      if (!order || order.lockState !== "none") return;
      const owner = await services.identity.getUser(order.ownerUserId, { tx, forUpdate: true });
      if (owner?.status !== "active") return;
      const frozen = await getRoot({ orderPublicId: order.publicId, orderReference: order.reference,
        customerName: owner.name, customerPublicId: owner.publicId, ownerUserId: owner.id }, tx);
      if (!frozen) return;
      await stage({ orderPublicId: input.orderPublicId, sourcePublicId: input.receiptPublicId, role: "receipt", destination,
        target: { path: [frozen.customer, frozen.order, "Receipts"], name: `Receipt-${input.receiptPublicId}.pdf`, ownerUserId: owner.id, visibility: null } }, tx);
    },
    async validateStageFileSyncTargets(stages: readonly Pick<StageFileSyncPlan, "fileSync">[], tx: Tx) {
      const ids = [...new Set(stages.flatMap(({ fileSync }) => Object.values(fileSync).filter((value): value is string => !!value)))];
      if (ids.length === 0) return;
      const rows = await tx.select().from(connections).where(inArray(connections.publicId, ids));
      if (rows.length !== ids.length || rows.some((r) => !enabled(r, "phase_files"))) {
        throw validation("STORAGE_FILE_SYNC_TARGET_INVALID", "Select an approved Microsoft 365 destination or Do not transfer.");
      }
    },
    listTargets(principal: SessionPrincipal) {
      return transaction(async (tx) => {
        const live = await services.identity.sessions.assertCurrent(principal, tx);
        if (principal.state !== "full" || live.role !== "admin" || live.pendingSteps.length) throw forbidden("CAPABILITY_NOT_GRANTED");
        const rows = await tx.select().from(connections).where(eq(connections.fileSyncMode, "phase_files")).orderBy(connections.name, connections.id);
        return rows.filter((r) => enabled(r, "phase_files")).map((r) => ({ publicId: r.publicId, label: r.name, kind: r.kind }));
      });
    },
    async testTarget(principal: SessionPrincipal, input: z.infer<typeof storageTest>, correlationId: string) {
      const check = async (tx: Tx) => {
        await assertCurrentStorageAdmin(deps, principal, tx);
        const row = await getConnection(input.publicId, tx, true);
        if (!row || (row.kind !== "sharepoint" && row.kind !== "onedrive")) throw targetInactive();
        if (row.version !== input.expectedVersion) throw conflict("STORAGE_CONNECTION_CHANGED", "The connection changed. Reload and try again.");
        return row;
      };
      const row = await transaction(async (tx) => {
        const r = await check(tx);
        await auditAdmin(principal, "write_test", correlationId, tx, r.publicId, undefined, "attempted");
        return r;
      });
      const adapter = adapterFor(row);
      const result = await adapter.testWrite?.(async () => { await transaction(check); }, AbortSignal.timeout(20_000)) ??
        { ok: false, code: "NOT_CONFIGURED" as const };
      await transaction(async (tx) => {
        const active = await check(tx);
        await tx.update(connections).set({ fileSyncWriteTestVersion: result.ok ? active.destinationVersion : null })
          .where(eq(connections.id, active.id));
        await auditAdmin(principal, "write_test", correlationId, tx, row.publicId, undefined, result.ok ? "completed" : "failed");
      });
      return result;
    },
    setTarget(principal: SessionPrincipal, input: z.infer<typeof managedTargetUpdate>, correlationId: string) {
      return transaction(async (tx) => {
        await assertCurrentStorageAdmin(deps, principal, tx);
        // Serialize approval with legacy assignment writes, and prevent mixed receipt/legacy routing.
        await tx.insert(storageAssignments).values({ purpose: "order_files", connectionPublicIds: [], updatedAt: clock.now() })
          .onDuplicateKeyUpdate({ set: { purpose: "order_files" } });
        const assignments = await tx.select().from(storageAssignments).orderBy(storageAssignments.purpose).for("update");
        const row = await getConnection(input.publicId, tx, true);
        if (!row || (row.kind !== "sharepoint" && row.kind !== "onedrive")) throw targetInactive();
        if (row.version !== input.expectedVersion) throw conflict("STORAGE_CONNECTION_CHANGED", "The connection changed. Reload and try again.");
        if (input.mode && (!row.enabled || row.fileSyncWriteTestVersion !== row.destinationVersion || !row.credentialsEnc)) {
          throw conflict("STORAGE_WRITE_TEST_REQUIRED", "Enable the connection and pass its write test before approving it.");
        }
        if (input.mode === "receipts") {
          const existing = await tx.select({ id: connections.id }).from(connections).where(eq(connections.fileSyncMode, "receipts"));
          const conflicts = await tx.select().from(connections).where(isNotNull(connections.fileSyncMode));
          const ids = [...new Set(assignments.flatMap((item) => item.connectionPublicIds))];
          const assigned = ids.length ? await tx.select({ publicId: connections.publicId, config: connections.config })
            .from(connections).where(inArray(connections.publicId, ids)) : [];
          if (assigned.some((c) => c.publicId === row.publicId || c.config.driveId === row.config.driveId) || existing.some((r) => r.id !== row.id) ||
              conflicts.some((r) => r.id !== row.id && r.config.driveId === row.config.driveId)) {
            throw conflict("STORAGE_RECEIPTS_TARGET_NOT_RESTRICTED", "Use one dedicated drive for Receipts that is not a phase or legacy file destination.");
          }
        } else if (input.mode === "phase_files") {
          const receipts = await tx.select().from(connections).where(eq(connections.fileSyncMode, "receipts"));
          if (receipts.some((r) => r.id !== row.id && r.config.driveId === row.config.driveId)) throw targetInactive();
        }
        await tx.update(connections).set({ fileSyncMode: input.mode, version: row.version + 1, updatedAt: clock.now() }).where(eq(connections.id, row.id));
        await auditAdmin(principal, "target_changed", correlationId, tx, row.publicId);
        return { mode: input.mode };
      });
    },
    /** Internal, read-only hub telemetry. Never returns connection or transfer identifiers. */
    async statusSummary() {
      const approved = sql`${connections.fileSyncMode} is not null`;
      const writeTested = sql`${connections.fileSyncWriteTestVersion} <=> ${connections.destinationVersion}`;
      const ready = sql`${connections.enabled} and ${approved} and (${writeTested}) and ${connections.credentialsEnc} is not null`;
      const blocked = sql`${copies.state} in ('blocked', 'failed', 'unknown') or ${jobRuns.state} = 'unknown'`;
      const [summary] = await db.select({
        totalConnections: sql<number>`count(distinct ${connections.id})`.mapWith(Number),
        enabledConnections: sql<number>`count(distinct case when ${connections.enabled} then ${connections.id} end)`.mapWith(Number),
        approvedConnections: sql<number>`count(distinct case when ${approved} then ${connections.id} end)`.mapWith(Number),
        writeTestedConnections: sql<number>`count(distinct case when ${writeTested} then ${connections.id} end)`.mapWith(Number),
        readyConnections: sql<number>`count(distinct case when ${ready} then ${connections.id} end)`.mapWith(Number),
        failingConnections: sql<number>`count(distinct case when ${connections.enabled} and (
          ${connections.lastTestCode} <> 'OK' or (${approved} and not (${ready})) or
          (${copies.destinationVersion} = ${connections.destinationVersion} and (${blocked}))
        ) then ${connections.id} end)`.mapWith(Number),
        blockedTransfers: sql<number>`count(case when ${blocked} then 1 end)`.mapWith(Number),
        lastCheckedAt: sql<Date | null>`max(${connections.lastTestAt})`.mapWith(connections.lastTestAt),
        lastSuccessAt: sql<Date | null>`max(case when ${copies.state} = 'copied' then ${copies.finishedAt} end)`.mapWith(copies.finishedAt),
      }).from(connections).leftJoin(copies, eq(copies.connectionPublicId, connections.publicId))
        .leftJoin(jobRuns, eq(jobRuns.publicId, copies.jobPublicId))
        .where(inArray(connections.kind, ["sharepoint", "onedrive"]));
      // Ungrouped SQL aggregates always return one row, including for an empty installation.
      return summary!;
    },
    health(principal: SessionPrincipal) {
      return transaction(async (tx) => {
        await assertCurrentStorageAdmin(deps, principal, tx);
        const rows = await tx.select({ publicId: connections.publicId, label: connections.name, kind: connections.kind,
          mode: connections.fileSyncMode, version: connections.version, enabled: connections.enabled,
          writeTested: sql<boolean>`${connections.fileSyncWriteTestVersion} <=> ${connections.destinationVersion}`.mapWith(Boolean),
          lastSuccessAt: sql<Date | null>`max(case when ${copies.state} = 'copied' then ${copies.finishedAt} end)`.mapWith(copies.finishedAt),
          backlog: sql<number>`coalesce(sum(${copies.state} in ('queued','copying') and coalesce(${jobRuns.state}, '') <> 'unknown'), 0)`.mapWith(Number),
          blocked: sql<number>`coalesce(sum(${copies.state} in ('blocked','failed','unknown') or ${jobRuns.state} = 'unknown'), 0)`.mapWith(Number),
        }).from(connections).leftJoin(copies, and(eq(copies.connectionPublicId, connections.publicId), liveCopyOrder()))
          .leftJoin(jobRuns, eq(jobRuns.publicId, copies.jobPublicId))
          .where(inArray(connections.kind, ["sharepoint", "onedrive"])).groupBy(connections.id).orderBy(connections.name).limit(100);
        return rows;
      });
    },
    forOrder(principal: SessionPrincipal, input: z.infer<typeof managedOrderInput>) {
      return transaction(async (tx) => {
        const live = await services.identity.sessions.assertCurrent(principal, tx);
        if (principal.state !== "full" || live.role !== principal.role || live.pendingSteps.length || (live.role !== "staff" && live.role !== "admin")) throw forbidden("CAPABILITY_NOT_GRANTED");
        await services.orders.assertCanReadOrder(principal, input.orderPublicId, { tx });
        const rows = await tx.select({ publicId: copies.publicId, sourcePublicId: copies.sourcePublicId, role: copies.role,
          state: copies.state, reasonCode: copies.reasonCode, jobState: jobRuns.state, destination: connections.name, updatedAt: copies.updatedAt,
        }).from(copies).leftJoin(connections, eq(connections.publicId, copies.connectionPublicId))
          .leftJoin(jobRuns, eq(jobRuns.publicId, copies.jobPublicId)).where(and(eq(copies.orderPublicId, input.orderPublicId),
            live.role === "admin" ? undefined : sql`${copies.role} <> 'receipt'`,
            input.cursor ? sql`${copies.publicId} < ${input.cursor}` : undefined)).orderBy(desc(copies.publicId)).limit(41);
        const page = rows.slice(0, 40);
        const fileIds = [...new Set(page.filter((row) => row.role !== "receipt").map((row) => row.sourcePublicId))];
        const metadata = new Map(fileIds.length ? (await services.files.listOrderFileCopyMetadata(input.orderPublicId, fileIds, tx))
          .map((file) => [file.filePublicId, file.displayName]) : []);
        const items = page.map(({ jobState, ...row }) => ({ ...row, fileName: metadata.get(row.sourcePublicId) ?? null,
          state: jobState === "unknown" ? "unknown" as const : row.state }));
        return { items, nextCursor: rows.length > 40 ? items.at(-1)?.publicId ?? null : null };
      });
    },
    previewResync(principal: SessionPrincipal, scope: Scope) {
      return transaction(async (tx) => {
        await assertCurrentStorageAdmin(deps, principal, tx);
        if (scope.scope !== "target") await services.orders.assertCanReadOrder(principal, scope.orderPublicId, { tx });
        const { count, more, inspectOnly, fingerprint } = await summarize(tx, scope);
        const previewToken = crypto.encrypt(JSON.stringify({ fingerprint, expiresAt: clock.now().getTime() + 300_000 }),
          previewAad(principal.userId, principal.sessionId));
        return { count, more, inspectOnly, previewToken };
      });
    },
    resync(principal: SessionPrincipal, input: z.infer<typeof managedResyncInput>, correlationId: string) {
      return transaction(async (tx) => {
        await assertCurrentStorageAdmin(deps, principal, tx);
        if (input.scope.scope !== "target") await services.orders.assertCanReadOrder(principal, input.scope.orderPublicId, { tx });
        const { candidates, fingerprint } = await summarize(tx, input.scope);
        const proof = (() => {
          try { return previewProof.parse(JSON.parse(crypto.decrypt(input.previewToken, previewAad(principal.userId, principal.sessionId)))); }
          catch { return null; }
        })();
        if (!proof || proof.fingerprint !== fingerprint || proof.expiresAt <= clock.now().getTime()) {
          throw conflict("STORAGE_RESYNC_PREVIEW_STALE", "The preview expired or transfers changed. Preview this resync again.");
        }
        let queued = 0;
        for (const { copy, jobState } of candidates) {
          const [current] = await tx.select().from(copies).where(eq(copies.id, copy.id)).for("update");
          if (!current || current.jobPublicId !== copy.jobPublicId || current.state !== copy.state) continue;
          await queue(copy, tx, correlationId, copy.state === "unknown" || jobState === "unknown");
          queued++;
        }
        await auditAdmin(principal, "resync_requested", correlationId, tx, undefined, queued);
        return { queued };
      });
    },
  };
}

export type ManagedFileSync = ReturnType<typeof createManagedFileSync>;
