/**
 * SharePoint order-data sync and Graph drive discovery (increment 03 package H + SharePoint/OneDrive setup).
 *
 *  - Ships disabled. Nothing is staged, queued or sent until an administrator assigns a SharePoint connection
 *    to the `order_data` purpose (storage module), picks or creates a compatible list here, tests it and
 *    enables the sync.
 *  - Order changes (orders.registerChangeListener, in the order's own transaction) bump a desired version and
 *    enqueue one fenced `sharepoint.sync_order` job per (order, version) — the transactional outbox.
 *  - The worker reads the live assignment and credentials through storage.readAssignedProvider (fence-checked),
 *    finds the remote item by stored remote id or by the RpOrderId column (idempotent by order public id),
 *    rechecks assignment/enablement/list and its fence immediately before every write, verifies the item
 *    identity after writing and records the outcome under its fence.
 *  - Logs, audit and errors carry only order public ids, counts and fixed codes; never list item content,
 *    customer data, site/list labels, URLs or provider bodies.
 */
import { and, asc, count, eq, gt, ne, or, isNull, sql } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import { DomainError, conflict, notFound, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { ClaimedJob, DbOrTx, JobResult, SessionPrincipal, Tx } from "../../core/types.js";
import type {
  TrashEntityRef,
  TrashParticipant,
  TrashPurgeResult,
  TrashPurgeRun,
} from "../trash/ports.js";
import { graphDriveDiscovery } from "../storage/adapters/graphDrive.js";
import { StorageAdapterError } from "../storage/adapters/graphDriveErrors.js";
import type { GraphCredentials, GraphHttpPort } from "../storage/adapters/graphDrivePort.js";
import { assertCurrentStorageAdmin } from "../storage/authz.js";
import { recordCopyAttempt } from "../storage/copyLogWriter.js";
import { buildOrderFields, fieldsHash, portalLinkFor, validListName } from "./fields.js";
import { createListClient } from "./listClient.js";
import { sharepointOrderSync, sharepointSyncConfig, type SharepointSyncState } from "./schema.js";

export const SYNC_JOB = "sharepoint.sync_order";
export const BACKFILL_JOB = "sharepoint.backfill_orders";
const BACKFILL_BATCH = 200;

export interface BackfillJobPayload {
  runId: string;
  /** Cursor this batch was planned for; a replay after the cursor advanced is a no-op. */
  after: string | null;
}

/** Orders-owned keyset listing port (system use only; ids only). */
type OrderIdLister = (input: { afterPublicId: string | null; limit: number }, tx?: DbOrTx) => Promise<{ publicIds: string[]; nextAfter: string | null }>;
const CONFIG_ID = 1;
const MAX_STATUS_PAGE = 100;
const RESYNC_BATCH = 500;
const CLAIM_MS = 10 * 60 * 1000;
const ORDER_TRASHED_REASON = "ORDER_TRASHED";

class OrderTrashedSyncAbort extends Error {
  constructor() {
    super(ORDER_TRASHED_REASON);
  }
}

export interface SyncJobPayload {
  orderPublicId: string;
  /** Set for bulk (backfill) work: the authorized scope; the job is cancelled if the live scope differs. */
  backfillScope?: string;
}

export interface OrderSyncSettingsView {
  enabled: boolean;
  connectionPublicId: string | null;
  siteId: string | null;
  siteLabel: string | null;
  listId: string | null;
  listLabel: string | null;
  includePortalLink: boolean;
  version: number;
  state: "disabled" | "not_configured" | "ready" | "error";
  lastError: { reasonCode: string; at: Date } | null;
  counts: { pending: number; synced: number; failed: number };
  backfill: { state: "running" | "completed" | "failed"; enqueued: number; reasonCode: string | null; startedAt: Date | null; finishedAt: Date | null } | null;
}

export type OrderSyncTestCode = "OK" | "NOT_CONFIGURED" | "LIST_NOT_FOUND" | "LIST_INCOMPATIBLE" | "AUTH_FAILED" | "DESTINATION_DENIED" | "EGRESS_DENIED" | "RATE_LIMITED" | "PROVIDER_UNAVAILABLE";

type ConfigRow = typeof sharepointSyncConfig.$inferSelect;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Fixed reason codes for persisted state and audit. */
export function reasonFor(error: unknown): { reasonCode: string; retryable: boolean } {
  if (error instanceof StorageAdapterError) return { reasonCode: `SHAREPOINT_${error.code}`, retryable: error.retryable };
  if (error instanceof DomainError) return { reasonCode: `SHAREPOINT_${error.reasonCode}`.slice(0, 64), retryable: false };
  return { reasonCode: "SHAREPOINT_PROVIDER_UNAVAILABLE", retryable: true };
}

function adminError(error: unknown): never {
  if (error instanceof DomainError) throw error;
  if (error instanceof StorageAdapterError) {
    switch (error.code) {
      case "NOT_CONFIGURED":
        throw new DomainError("NOT_CONFIGURED", "SHAREPOINT_NOT_CONFIGURED", "Finish the SharePoint connection settings first.");
      case "INVALID_INPUT":
        throw validation("SHAREPOINT_INVALID_INPUT", "Check the address or selection and try again.");
      case "DESTINATION_NOT_FOUND":
        throw notFound("SHAREPOINT_NOT_FOUND");
      case "DESTINATION_CONFLICT":
        throw conflict("SHAREPOINT_CONFLICT", "An item with that name already exists.");
      case "RATE_LIMITED":
        throw new DomainError("RATE_LIMITED", "SHAREPOINT_RATE_LIMITED", "Microsoft 365 is throttling requests. Try again shortly.");
      default:
        throw new DomainError("UNAVAILABLE", `SHAREPOINT_${error.code}`, "Microsoft 365 could not complete the request. Check the connection and try again.");
    }
  }
  throw new DomainError("UNAVAILABLE", "SHAREPOINT_PROVIDER_UNAVAILABLE", "Microsoft 365 could not complete the request. Try again.");
}

function credentialsFrom(config: Record<string, unknown>, credentials: Record<string, unknown> | null): GraphCredentials | null {
  const tenantId = str(config.tenantId);
  const clientId = str(config.clientId);
  const clientSecret = str(credentials?.clientSecret);
  return tenantId && clientId && clientSecret ? { tenantId, clientId, clientSecret } : null;
}

export function createSharepointService(deps: ModuleDeps, port: GraphHttpPort) {
  const { db, audit, clock, jobs } = deps;
  const discovery = graphDriveDiscovery(port);

  async function readConfig(handle: DbOrTx, lock = false): Promise<ConfigRow | null> {
    const q = handle.select().from(sharepointSyncConfig).where(eq(sharepointSyncConfig.id, CONFIG_ID));
    const rows = lock ? await q.for("update") : await q;
    return rows[0] ?? null;
  }

  async function assignedDestination(handle?: DbOrTx): Promise<{ connectionPublicId: string; destinationVersion: number } | null> {
    const assigned = await deps.services.storageConnections.listAssigned("order_data", handle);
    const hit = assigned.find((a) => a.kind === "sharepoint");
    return hit ? { connectionPublicId: hit.connectionPublicId, destinationVersion: hit.destinationVersion } : null;
  }
  const assignedConnection = async (handle?: DbOrTx) => (await assignedDestination(handle))?.connectionPublicId ?? null;

  /** Bumps the desired version and enqueues one job per (order, version), in the caller's transaction. */
  async function stage(orderPublicId: string, tx: Tx, options: { correlationId?: string; idempotencyKey?: string; backfillScope?: string } = {}): Promise<boolean> {
    await tx
      .insert(sharepointOrderSync)
      .values({ orderPublicId, desiredVersion: 1, state: "pending" })
      .onDuplicateKeyUpdate({ set: { desiredVersion: sql`${sharepointOrderSync.desiredVersion} + 1`, state: "pending", reasonCode: null } });
    const [row] = await tx.select({ v: sharepointOrderSync.desiredVersion }).from(sharepointOrderSync).where(eq(sharepointOrderSync.orderPublicId, orderPublicId));
    const { jobId } = await jobs.enqueue<SyncJobPayload>(
      SYNC_JOB,
      { orderPublicId, ...(options.backfillScope ? { backfillScope: options.backfillScope } : {}) },
      { idempotencyKey: options.idempotencyKey ?? `sharepoint:order:${orderPublicId}:v${row?.v ?? 1}`, ...(options.correlationId ? { correlationId: options.correlationId } : {}), maxAttempts: 6 },
      tx,
    );
    // Copy log: stage attempt 1 against the intended connection (idempotent when the enqueue was deduplicated).
    const connectionPublicId = await assignedConnection(tx);
    if (connectionPublicId) await copyAttempt(tx, { orderPublicId, jobId, attempt: 1, connectionPublicId, correlationId: options.correlationId }, { phase: "queued" });
    return true;
  }

  type CopyPhase =
    | { phase: "queued" }
    | { phase: "started" }
    | { phase: "finished"; result: "written"; alreadyAudited?: true }
    | { phase: "finished"; result: "failed" | "not_written"; errorCode?: string; alreadyAudited?: true };
  /** Copy log hook (storage package R). Called only inside fenced owner transactions; no provider data. */
  async function copyAttempt(tx: Tx, at: { orderPublicId: string; jobId: string; attempt: number; connectionPublicId: string; correlationId?: string | null }, phase: CopyPhase): Promise<void> {
    await recordCopyAttempt(
      deps,
      { kind: "sharepoint_order", sourcePublicId: at.orderPublicId, connectionPublicId: at.connectionPublicId, jobPublicId: at.jobId, attempt: at.attempt, correlationId: at.correlationId ?? null, ...phase },
      tx,
    );
  }
  const attemptOf = (job: ClaimedJob<SyncJobPayload>, connectionPublicId: string) => ({ orderPublicId: job.payload.orderPublicId, jobId: job.jobId, attempt: job.attempt, connectionPublicId, correlationId: job.correlationId });

  /** orders change listener: runs inside the order write transaction; a throw aborts that write. */
  async function onOrderChange(event: { orderId: number; orderPublicId: string; kind: string }, tx: Tx): Promise<void> {
    if (event.kind === "deleted" || event.kind === "trashed" || event.kind === "purged") return; // orders in trash are never synced; remote items are never removed automatically
    const config = await readConfig(tx);
    if (!config?.enabled || !config.listId) return;
    if (typeof deps.services.orders.isTrashedInTx === "function" && (await deps.services.orders.isTrashedInTx(tx, event.orderId))) return;
    await stage(event.orderPublicId, tx);
  }

  /**
   * Liveness: when a claim is released while a newer version was staged, the newer version's own job may
   * have exhausted its attempts against the BUSY claim. Enqueue a fresh follow-up (distinct key) so the
   * latest version is always dispatched. A redundant follow-up ends as caught_up.
   */
  async function followUp(tx: Tx, orderPublicId: string, latestVersion: number, targetVersion: number, job: ClaimedJob<SyncJobPayload>): Promise<void> {
    if (latestVersion <= targetVersion) return;
    const { jobId } = await jobs.enqueue<SyncJobPayload>(
      SYNC_JOB,
      // Bulk work stays bound to its authorized scope; ordinary change dispatch follows current settings.
      { orderPublicId, ...(job.payload.backfillScope ? { backfillScope: job.payload.backfillScope } : {}) },
      { idempotencyKey: `sharepoint:order:${orderPublicId}:v${latestVersion}:after:${job.jobId}`, correlationId: job.correlationId, maxAttempts: 6 },
      tx,
    );
    const connectionPublicId = await assignedConnection(tx);
    if (connectionPublicId) await copyAttempt(tx, { orderPublicId, jobId, attempt: 1, connectionPublicId, correlationId: job.correlationId }, { phase: "queued" });
  }

  async function markFailure(orderPublicId: string, reasonCode: string, state: SharepointSyncState, job: ClaimedJob<SyncJobPayload>, claimToken: string, targetVersion?: number, connectionPublicId?: string): Promise<void> {
    await db.transaction(async (tx) => {
      await job.assertStillOwned(tx);
      // Unknown outcome (the remote write may have landed) is reported as failed with its reason code: the
      // copy log never claims a write it cannot confirm. The owner's result audit is in this transaction.
      if (connectionPublicId) await copyAttempt(tx, attemptOf(job, connectionPublicId), { phase: "finished", result: "failed", errorCode: reasonCode, alreadyAudited: true });
      if (targetVersion !== undefined) {
        const [latest] = await tx.select({ v: sharepointOrderSync.desiredVersion, token: sharepointOrderSync.claimToken }).from(sharepointOrderSync).where(eq(sharepointOrderSync.orderPublicId, orderPublicId)).for("update");
        if (latest?.token === claimToken) await followUp(tx, orderPublicId, latest.v, targetVersion, job);
      }
      await tx
        .update(sharepointOrderSync)
        .set({ state, reasonCode, attempts: sql`${sharepointOrderSync.attempts} + 1`, claimJobId: null, claimToken: null, claimedUntil: null })
        .where(and(eq(sharepointOrderSync.orderPublicId, orderPublicId), eq(sharepointOrderSync.claimToken, claimToken)));
      await tx.update(sharepointSyncConfig).set({ lastErrorCode: reasonCode, lastErrorAt: clock.now() }).where(eq(sharepointSyncConfig.id, CONFIG_ID));
      await audit.record(
        {
          category: "integration",
          eventName: "sharepoint.order.sync",
          action: "sync",
          outcome: state === "unknown" ? "unknown" : "failed",
          reasonCode,
          actor: { role: "system" },
          resource: { type: "order", publicId: orderPublicId },
          jobId: job.jobId,
          correlationId: job.correlationId,
          provider: "sharepoint",
        },
        tx,
      );
    });
  }

  /**
   * Increment 09 D2.8: release a claimed sync when the order moved to the trash (or was purged) before the
   * external Graph write. Never marks `sharepoint_sync_config.last_error_code`, and records `not_written`.
   */
  async function dropTrashedSync(orderPublicId: string, job: ClaimedJob<SyncJobPayload>, claimToken: string, connectionPublicId?: string): Promise<void> {
    await db.transaction(async (tx) => {
      await job.assertStillOwned(tx);
      if (connectionPublicId) {
        await copyAttempt(tx, attemptOf(job, connectionPublicId), { phase: "finished", result: "not_written", errorCode: ORDER_TRASHED_REASON, alreadyAudited: true });
      }
      const [existing] = await tx
        .select({ remoteItemId: sharepointOrderSync.remoteItemId, desiredVersion: sharepointOrderSync.desiredVersion })
        .from(sharepointOrderSync)
        .where(eq(sharepointOrderSync.orderPublicId, orderPublicId))
        .for("update");
      if (existing) {
        await tx
          .update(sharepointOrderSync)
          .set({
            syncedVersion: existing.desiredVersion,
            state: existing.remoteItemId ? "synced" : "pending",
            reasonCode: ORDER_TRASHED_REASON,
            claimJobId: null,
            claimToken: null,
            claimedUntil: null,
          })
          .where(eq(sharepointOrderSync.orderPublicId, orderPublicId));
      }
      await audit.record(
        {
          category: "integration",
          eventName: "sharepoint.order.sync",
          action: "sync",
          outcome: "canceled",
          reasonCode: ORDER_TRASHED_REASON,
          actor: { role: "system" },
          resource: { type: "order", publicId: orderPublicId },
          jobId: job.jobId,
          correlationId: job.correlationId,
          provider: "sharepoint",
        },
        tx,
      );
    });
  }

  async function runSync(job: ClaimedJob<SyncJobPayload>): Promise<JobResult> {
    const { orderPublicId } = job.payload;
    const config = await readConfig(db);
    if (!config?.enabled || !config.listId) return { outcome: "canceled", reasonCode: "SHAREPOINT_SYNC_DISABLED" };
    const listId = config.listId;
    const settingsVersion = config.version;

    // Durable per-order write claim: jobs for different versions of one order never write concurrently.
    // Everything below uses the snapshot locked here (never an earlier, possibly stale read).
    const now = clock.now();
    const claimToken = ulid(now.getTime());
    const claim = await db.transaction(async (tx) => {
      await job.assertStillOwned(tx);
      const [locked] = await tx.select().from(sharepointOrderSync).where(eq(sharepointOrderSync.orderPublicId, orderPublicId)).for("update");
      if (!locked) return { kind: "missing" as const };
      if (locked.reasonCode === ORDER_TRASHED_REASON) return { kind: "trashed" as const };
      if (locked.claimToken && locked.claimJobId !== job.jobId && locked.claimedUntil && locked.claimedUntil > now) return { kind: "busy" as const };
      if (locked.syncedVersion >= locked.desiredVersion && locked.listId === listId) return { kind: "caught_up" as const };
      await tx.update(sharepointOrderSync).set({ claimJobId: job.jobId, claimToken, claimedUntil: new Date(now.getTime() + CLAIM_MS) }).where(eq(sharepointOrderSync.orderPublicId, orderPublicId));
      return { kind: "claimed" as const, row: locked };
    });
    if (claim.kind === "missing") return { outcome: "canceled", reasonCode: "SHAREPOINT_SYNC_NOT_STAGED" };
    if (claim.kind === "trashed") return { outcome: "canceled", reasonCode: ORDER_TRASHED_REASON };
    if (claim.kind === "caught_up") {
      // Nothing to write: close this attempt as an intentional no-op (no result audit for no-ops).
      const caughtUpConnection = await assignedConnection(db);
      if (caughtUpConnection) {
        await db.transaction(async (tx) => {
          await job.assertStillOwned(tx);
          await copyAttempt(tx, attemptOf(job, caughtUpConnection), { phase: "started" });
          await copyAttempt(tx, attemptOf(job, caughtUpConnection), { phase: "finished", result: "not_written" });
        });
      }
      return { outcome: "completed", safeCounts: { unchanged: 1 } };
    }
    if (claim.kind === "busy") return { outcome: "failed", reasonCode: "SHAREPOINT_SYNC_BUSY", retryable: true };
    const row = claim.row;
    const targetVersion = row.desiredVersion;
    const ownsClaim = and(eq(sharepointOrderSync.orderPublicId, orderPublicId), eq(sharepointOrderSync.claimToken, claimToken));

    const destination = await assignedDestination(db);
    if (!destination) {
      await markFailure(orderPublicId, "SHAREPOINT_NOT_CONFIGURED", "failed", job, claimToken, targetVersion);
      return { outcome: "failed", reasonCode: "SHAREPOINT_NOT_CONFIGURED", retryable: false };
    }

    const { connectionPublicId, destinationVersion } = destination;
    // Bulk work: the settings revision and destination this run will use (pinned below by beforeWrite)
    // must equal the scope the administrator authorized.
    if (job.payload.backfillScope !== undefined && job.payload.backfillScope !== `${settingsVersion}:${connectionPublicId}:${destinationVersion}`) {
      await markFailure(orderPublicId, "SHAREPOINT_BACKFILL_SCOPE_CHANGED", "failed", job, claimToken, targetVersion, connectionPublicId);
      return { outcome: "canceled", reasonCode: "SHAREPOINT_BACKFILL_SCOPE_CHANGED" };
    }
    await db.transaction(async (tx) => {
      await job.assertStillOwned(tx);
      await copyAttempt(tx, attemptOf(job, connectionPublicId), { phase: "started" });
    });
    try {
      const readProvider = () => deps.services.storageConnections.readAssignedProvider({ purpose: "order_data", connectionPublicId, kind: "sharepoint", assertStillOwned: job.assertStillOwned });
      const provider = await readProvider();
      const creds = credentialsFrom(provider.config, provider.credentials);
      const siteId = str(provider.config.siteId);
      if (!creds || !siteId) throw new StorageAdapterError("NOT_CONFIGURED", false);
      const list = createListClient(port, creds, siteId);

      const order = await deps.services.orders.getOrderSyncView(orderPublicId);
      if (!order) {
        await dropTrashedSync(orderPublicId, job, claimToken, connectionPublicId);
        return { outcome: "canceled", reasonCode: ORDER_TRASHED_REASON };
      }
      const owner = await deps.services.identity.getUser(order.ownerUserId);
      const fields = buildOrderFields(order, {
        customerReference: owner?.customerRef ?? null,
        portalLink: config.includePortalLink ? portalLinkFor(deps.config.canonicalOrigin, order.publicId) : null,
      });
      const hash = fieldsHash(fields);

      // Revocation + D2.8 trash recheck immediately before every external Graph write.
      const beforeWrite = async () => {
        await job.assertStillOwned();
        const live = await readProvider();
        const now = await assignedDestination(db);
        // A credential replacement or material config change bumps the destination generation.
        if (now?.connectionPublicId !== connectionPublicId || now.destinationVersion !== destinationVersion || str(live.config.siteId) !== siteId) {
          throw new StorageAdapterError("DESTINATION_DENIED", false);
        }
        const current = await readConfig(db);
        // Any settings change (list, portal-link policy, disable) invalidates the rendered fields.
        if (!current?.enabled || current.listId !== listId || current.version !== settingsVersion) throw new StorageAdapterError("NOT_CONFIGURED", false);
        const [mine] = await db
          .select({ token: sharepointOrderSync.claimToken, until: sharepointOrderSync.claimedUntil, reasonCode: sharepointOrderSync.reasonCode })
          .from(sharepointOrderSync)
          .where(eq(sharepointOrderSync.orderPublicId, orderPublicId));
        if (mine?.reasonCode === ORDER_TRASHED_REASON) throw new OrderTrashedSyncAbort();
        const liveOrder = await deps.services.orders.getOrderSyncView(orderPublicId);
        if (!liveOrder) throw new OrderTrashedSyncAbort();
        if (mine?.token !== claimToken || !mine.until || mine.until <= clock.now()) throw new StorageAdapterError("OUTCOME_UNKNOWN", false);
      };

      let itemId: string | null = null;
      if (row.remoteItemId && row.listId === listId && (await list.verifyItem(listId, row.remoteItemId, orderPublicId))) itemId = row.remoteItemId;
      if (!itemId) itemId = await list.findByOrderId(listId, orderPublicId);

      let action: "created" | "updated" | "unchanged";
      if (itemId && row.contentHash === hash && row.listId === listId) {
        action = "unchanged";
      } else if (itemId) {
        await beforeWrite();
        await list.updateItem(listId, itemId, fields, beforeWrite);
        action = "updated";
      } else {
        await beforeWrite();
        try {
          itemId = await list.createItem(listId, fields, beforeWrite);
          action = "created";
        } catch (error) {
          // The unique RpOrderId column refused a second item: read the existing one back and update it.
          if (!(error instanceof StorageAdapterError && error.code === "DESTINATION_CONFLICT")) throw error;
          const existing = await list.findByOrderId(listId, orderPublicId);
          if (!existing) throw error;
          itemId = existing;
          await beforeWrite();
          await list.updateItem(listId, itemId, fields, beforeWrite);
          action = "updated";
        }
      }
      // Identity of the object after the write (§4.1 H).
      if (action !== "unchanged" && !(await list.verifyItem(listId, itemId, orderPublicId))) throw new StorageAdapterError("INTEGRITY_MISMATCH", false);

      await db.transaction(async (tx) => {
        await job.assertStillOwned(tx);
        const [latest] = await tx.select({ v: sharepointOrderSync.desiredVersion, token: sharepointOrderSync.claimToken }).from(sharepointOrderSync).where(eq(sharepointOrderSync.orderPublicId, orderPublicId)).for("update");
        if (latest?.token !== claimToken) throw new StorageAdapterError("OUTCOME_UNKNOWN", false);
        await tx
          .update(sharepointOrderSync)
          .set({
            listId,
            remoteItemId: itemId,
            contentHash: hash,
            syncedVersion: sql`GREATEST(${sharepointOrderSync.syncedVersion}, ${targetVersion})`,
            state: (latest?.v ?? targetVersion) > targetVersion ? "pending" : "synced",
            reasonCode: null,
            attempts: sql`${sharepointOrderSync.attempts} + 1`,
            lastSyncedAt: clock.now(),
            claimJobId: null,
            claimToken: null,
            claimedUntil: null,
          })
          .where(ownsClaim);
        await followUp(tx, orderPublicId, latest?.v ?? targetVersion, targetVersion, job);
        // Readback confirms only the RpOrderId marker, not the field contents, so the copy is "written", not
        // "verified". Unchanged items are an intentional no-op.
        await copyAttempt(tx, attemptOf(job, connectionPublicId), action === "unchanged" ? { phase: "finished", result: "not_written", alreadyAudited: true } : { phase: "finished", result: "written", alreadyAudited: true });
        await audit.record(
          {
            category: "integration",
            eventName: "sharepoint.order.sync",
            action: "sync",
            outcome: "completed",
            actor: { role: "system" },
            resource: { type: "order", publicId: orderPublicId },
            jobId: job.jobId,
            correlationId: job.correlationId,
            provider: "sharepoint",
            safeCounts: { [action]: 1 },
          },
          tx,
        );
      });
      return { outcome: "completed", safeCounts: { [action]: 1 } };
    } catch (error) {
      if (error instanceof OrderTrashedSyncAbort) {
        await dropTrashedSync(orderPublicId, job, claimToken, connectionPublicId);
        return { outcome: "canceled", reasonCode: ORDER_TRASHED_REASON };
      }
      if (!(error instanceof StorageAdapterError) && !(error instanceof DomainError)) throw error; // lost fence etc.
      const { reasonCode, retryable } = reasonFor(error);
      await markFailure(orderPublicId, reasonCode, retryable ? "pending" : "failed", job, claimToken, targetVersion, connectionPublicId);
      return { outcome: "failed", reasonCode, retryable };
    }
  }

  /* ------------------------------------------------------------------ administrator operations */

  async function guard<T>(principal: SessionPrincipal, fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await db.transaction(async (tx) => {
        await assertCurrentStorageAdmin(deps, principal, tx);
        return fn(tx);
      });
    } catch (error) {
      if (error instanceof DomainError && ["FORBIDDEN", "STEP_UP_REQUIRED", "REMEDIATION_REQUIRED"].includes(error.code)) {
        await audit.record({
          category: "security",
          eventName: "sharepoint.admin.denied",
          action: "access",
          outcome: "denied",
          reasonCode: error.reasonCode,
          actor: { userId: principal.userId, role: principal.role },
        });
      }
      throw error;
    }
  }

  /** Decrypted setup for an explicit connection (wizard discovery); network I/O happens after the tx commits. */
  async function setupFor(principal: SessionPrincipal, input: { connectionPublicId: string; expectedVersion: number }, kind: "sharepoint" | "onedrive") {
    const setup = await guard(principal, (tx) => deps.services.storageConnections.readProviderSetup(principal, { publicId: input.connectionPublicId, kind, expectedVersion: input.expectedVersion }, tx));
    const config = { tenantId: str(setup.config.tenantId), clientId: str(setup.config.clientId) };
    return { config, credentials: setup.credentials ? { clientSecret: str(setup.credentials.clientSecret) } : null, raw: setup.config };
  }

  /** The assigned order_data SharePoint connection's site + credentials, for list operations. */
  async function assignedSite(principal: SessionPrincipal) {
    const connectionPublicId = await guard(principal, (tx) => assignedConnection(tx));
    if (!connectionPublicId) throw new DomainError("NOT_CONFIGURED", "SHAREPOINT_NOT_ASSIGNED", "Assign a SharePoint connection to order data first.");
    const view = await deps.services.storageConnections.connections.get(principal, { publicId: connectionPublicId });
    const setup = await setupFor(principal, { connectionPublicId, expectedVersion: view.version }, "sharepoint");
    const creds = credentialsFrom(setup.raw, setup.credentials);
    const siteId = str(setup.raw.siteId);
    if (!creds || !siteId) throw new DomainError("NOT_CONFIGURED", "SHAREPOINT_NOT_CONFIGURED", "Finish the SharePoint connection settings first.");
    return { list: createListClient(port, creds, siteId), connectionPublicId, siteId, siteLabel: view.name };
  }

  async function adminAudit(principal: SessionPrincipal, eventName: string, action: string, tx: Tx, extra: { reasonCode?: string; outcome?: "completed" | "failed"; safeCounts?: Record<string, number> } = {}) {
    await audit.record(
      {
        category: "admin",
        eventName,
        action,
        outcome: extra.outcome ?? "completed",
        ...(extra.reasonCode ? { reasonCode: extra.reasonCode } : {}),
        ...(extra.safeCounts ? { safeCounts: extra.safeCounts } : {}),
        actor: { userId: principal.userId, role: principal.role },
        resource: { type: "sharepoint_sync", id: CONFIG_ID },
        provider: "sharepoint",
      },
      tx,
    );
  }

  async function view(principal: SessionPrincipal): Promise<OrderSyncSettingsView> {
    const { config, connectionPublicId, counts } = await guard(principal, async (tx) => {
      const config = await readConfig(tx);
      const connectionPublicId = await assignedConnection(tx);
      const grouped = await tx
        .select({ state: sharepointOrderSync.state, n: count() })
        .from(sharepointOrderSync)
        .where(or(isNull(sharepointOrderSync.reasonCode), ne(sharepointOrderSync.reasonCode, ORDER_TRASHED_REASON)))
        .groupBy(sharepointOrderSync.state);
      const n = (s: SharepointSyncState) => grouped.find((g) => g.state === s)?.n ?? 0;
      return { config, connectionPublicId, counts: { pending: n("pending"), synced: n("synced"), failed: n("failed") + n("unknown") } };
    });
    let siteId: string | null = null;
    let siteLabel: string | null = null;
    if (connectionPublicId) {
      const conn = await deps.services.storageConnections.connections.get(principal, { publicId: connectionPublicId });
      siteId = str(conn.config.siteId) || null;
      siteLabel = conn.name;
    }
    const enabled = config?.enabled ?? false;
    const state: OrderSyncSettingsView["state"] = !enabled ? "disabled" : !connectionPublicId || !siteId || !config?.listId ? "not_configured" : config.lastErrorCode ? "error" : "ready";
    return {
      enabled,
      connectionPublicId,
      siteId,
      siteLabel,
      listId: config?.listId ?? null,
      listLabel: config?.listLabel ?? null,
      includePortalLink: config?.includePortalLink ?? false,
      version: config?.version ?? 0,
      state,
      lastError: config?.lastErrorCode && config.lastErrorAt ? { reasonCode: config.lastErrorCode, at: config.lastErrorAt } : null,
      counts,
      backfill: config?.backfillState
        ? { state: config.backfillState, enqueued: config.backfillEnqueued, reasonCode: config.backfillReasonCode, startedAt: config.backfillStartedAt, finishedAt: config.backfillFinishedAt }
        : null,
    };
  }

  async function testList(principal: SessionPrincipal, listId: string | null): Promise<{ ok: boolean; code: OrderSyncTestCode }> {
    let code: OrderSyncTestCode;
    try {
      const { list } = await assignedSite(principal);
      code = listId ? await list.checkList(listId) : "NOT_CONFIGURED";
    } catch (error) {
      if (error instanceof DomainError && error.code === "NOT_CONFIGURED") code = "NOT_CONFIGURED";
      else if (error instanceof StorageAdapterError) {
        const known: OrderSyncTestCode[] = ["NOT_CONFIGURED", "AUTH_FAILED", "DESTINATION_DENIED", "EGRESS_DENIED", "RATE_LIMITED"];
        code = known.includes(error.code as OrderSyncTestCode) ? (error.code as OrderSyncTestCode) : error.code === "DESTINATION_NOT_FOUND" ? "LIST_NOT_FOUND" : "PROVIDER_UNAVAILABLE";
      } else throw error;
    }
    return { ok: code === "OK", code };
  }

  const orderLister = (): OrderIdLister | null => {
    const fn = (deps.services.orders as unknown as { listOrderPublicIdsForSync?: OrderIdLister }).listOrderPublicIdsForSync;
    return typeof fn === "function" ? fn.bind(deps.services.orders) : null;
  };

  async function currentScope(tx: DbOrTx, config: { version: number } | null): Promise<string | null> {
    const destination = await assignedDestination(tx);
    return config && destination ? `${config.version}:${destination.connectionPublicId}:${destination.destinationVersion}` : null;
  }

  /** One bounded batch per job; the next batch is a new job keyed by (run, cursor). DB work only. */
  async function runBackfill(job: ClaimedJob<BackfillJobPayload>): Promise<JobResult> {
    const config = await readConfig(db);
    if (!config || config.backfillRunId !== job.payload.runId || config.backfillState !== "running") return { outcome: "canceled", reasonCode: "SHAREPOINT_BACKFILL_SUPERSEDED" };
    const finish = async (state: "completed" | "failed", reasonCode: string | null, tx: Tx) => {
      await tx.update(sharepointSyncConfig).set({ backfillState: state, backfillReasonCode: reasonCode, backfillFinishedAt: clock.now() }).where(eq(sharepointSyncConfig.id, CONFIG_ID));
      await audit.record(
        { category: "integration", eventName: "sharepoint.sync.backfill_finished", action: "sync", outcome: state, ...(reasonCode ? { reasonCode } : {}), actor: { role: "system" }, resource: { type: "sharepoint_sync", id: CONFIG_ID }, jobId: job.jobId, correlationId: job.correlationId, provider: "sharepoint", safeCounts: { enqueued: config.backfillEnqueued } },
        tx,
      );
    };
    if (!config.enabled || !config.listId) {
      await db.transaction(async (tx) => {
        await job.assertStillOwned(tx);
        await finish("failed", "SHAREPOINT_SYNC_DISABLED", tx);
      });
      return { outcome: "canceled", reasonCode: "SHAREPOINT_SYNC_DISABLED" };
    }
    const lister = orderLister();
    if (!lister) {
      await db.transaction(async (tx) => {
        await job.assertStillOwned(tx);
        await finish("failed", "ORDERS_LISTING_UNAVAILABLE", tx);
      });
      return { outcome: "failed", reasonCode: "ORDERS_LISTING_UNAVAILABLE", retryable: false };
    }
    const cursor = job.payload.after ?? null;
    if (config.backfillCursor !== cursor) return { outcome: "canceled", reasonCode: "SHAREPOINT_BACKFILL_SUPERSEDED" };
    const page = await lister({ afterPublicId: cursor, limit: BACKFILL_BATCH });
    const ids = page.publicIds.filter((id) => /^[0-9A-Z]{26}$/u.test(id)).slice(0, BACKFILL_BATCH);
    return db.transaction(async (tx) => {
      await job.assertStillOwned(tx);
      const locked = await readConfig(tx, true);
      // Resumable and exactly-once per batch: only the run/cursor this job was planned for may advance.
      if (!locked || locked.backfillRunId !== job.payload.runId || locked.backfillState !== "running" || locked.backfillCursor !== cursor) {
        return { outcome: "canceled" as const, reasonCode: "SHAREPOINT_BACKFILL_SUPERSEDED" };
      }
      // Bound to the authorized scope: settings revision, list, connection and destination generation.
      if (!locked.enabled || !locked.listId || locked.backfillScope === null || (await currentScope(tx, locked)) !== locked.backfillScope) {
        await finish("failed", "SHAREPOINT_BACKFILL_SCOPE_CHANGED", tx);
        return { outcome: "canceled" as const, reasonCode: "SHAREPOINT_BACKFILL_SCOPE_CHANGED" };
      }
      for (const id of ids) await stage(id, tx, { correlationId: job.correlationId, backfillScope: locked.backfillScope });
      const last = ids[ids.length - 1] ?? cursor;
      const done = page.nextAfter === null || ids.length === 0;
      await tx
        .update(sharepointSyncConfig)
        .set({ backfillCursor: last, backfillEnqueued: sql`${sharepointSyncConfig.backfillEnqueued} + ${ids.length}` })
        .where(eq(sharepointSyncConfig.id, CONFIG_ID));
      if (done) {
        await finish("completed", null, tx);
      } else {
        await jobs.enqueue<BackfillJobPayload>(BACKFILL_JOB, { runId: job.payload.runId, after: last }, { idempotencyKey: `sharepoint:backfill:${job.payload.runId}:${last}`, correlationId: job.correlationId }, tx);
      }
      return { outcome: "completed" as const, safeCounts: { enqueued: ids.length } };
    });
  }

  const trashParticipant: TrashParticipant = {
    module: "sharepoint",
    async onTrashedInTx(tx: Tx, entity: TrashEntityRef): Promise<void> {
      if (entity.kind !== "order") return;
      const [existing] = await tx
        .select({ remoteItemId: sharepointOrderSync.remoteItemId, desiredVersion: sharepointOrderSync.desiredVersion })
        .from(sharepointOrderSync)
        .where(eq(sharepointOrderSync.orderPublicId, entity.publicId))
        .for("update");
      if (!existing) return;
      await tx
        .update(sharepointOrderSync)
        .set({
          syncedVersion: existing.desiredVersion,
          state: existing.remoteItemId ? "synced" : "pending",
          reasonCode: ORDER_TRASHED_REASON,
          claimJobId: null,
          claimToken: null,
          claimedUntil: null,
        })
        .where(eq(sharepointOrderSync.orderPublicId, entity.publicId));
    },
    async onRestoredInTx(tx: Tx, entity: TrashEntityRef): Promise<void> {
      if (entity.kind !== "order") return;
      const [existing] = await tx
        .select({ id: sharepointOrderSync.id })
        .from(sharepointOrderSync)
        .where(eq(sharepointOrderSync.orderPublicId, entity.publicId))
        .for("update");
      if (existing) {
        await tx
          .update(sharepointOrderSync)
          .set({ reasonCode: null })
          .where(eq(sharepointOrderSync.orderPublicId, entity.publicId));
      }
      const config = await readConfig(tx);
      if (config?.enabled && config.listId) {
        await stage(entity.publicId, tx);
      }
    },
    async summarize(entity: TrashEntityRef): Promise<Record<string, number>> {
      if (entity.kind !== "order") return {};
      const [row] = await db
        .select({ n: count() })
        .from(sharepointOrderSync)
        .where(eq(sharepointOrderSync.orderPublicId, entity.publicId));
      const mappings = row?.n ?? 0;
      const out: Record<string, number> = {};
      if (mappings > 0) out.sharepointMappings = mappings;
      return out;
    },
    async purge(entity: TrashEntityRef, run: TrashPurgeRun): Promise<TrashPurgeResult> {
      // Increment 09 D2.6: erase portal SharePoint mapping rows only; folders/items already written
      // in SharePoint or OneDrive are NOT deleted automatically.
      if (entity.kind !== "order") return { deleted: {} };
      return db.transaction(async (tx) => {
        await run.assertCurrentInTx(tx);
        const [res] = await tx
          .delete(sharepointOrderSync)
          .where(eq(sharepointOrderSync.orderPublicId, entity.publicId));
        const deleted: Record<string, number> = {};
        if (res.affectedRows > 0) deleted.sharepointMappings = res.affectedRows;
        return { deleted };
      });
    },
  };

  return {
    onOrderChange,
    runSync,
    runBackfill,
    trashParticipant,

    /** Automation action / manual resync for one order. Returns false when the sync is not enabled. */
    async enqueueOrder(orderPublicId: string, options: { correlationId: string; idempotencyKey: string }): Promise<"queued" | "disabled" | "order_not_found"> {
      return db.transaction(async (tx) => {
        const config = await readConfig(tx);
        if (!config?.enabled || !config.listId) return "disabled";
        const order = await deps.services.orders.getOrderSyncView(orderPublicId, tx);
        if (!order) return "order_not_found";
        await stage(orderPublicId, tx, options);
        return "queued";
      });
    },

    discovery: {
      async discoverSite(principal: SessionPrincipal, input: { connectionPublicId: string; expectedVersion: number; siteUrl: string }) {
        const s = await setupFor(principal, input, "sharepoint");
        return discovery.discoverSite(s.config, s.credentials, input.siteUrl).catch(adminError);
      },
      async listDrives(principal: SessionPrincipal, input: { connectionPublicId: string; expectedVersion: number; siteId: string }) {
        const s = await setupFor(principal, input, "sharepoint");
        return discovery.listDrives(s.config, s.credentials, input.siteId).catch(adminError);
      },
      async resolveOneDrive(principal: SessionPrincipal, input: { connectionPublicId: string; expectedVersion: number; userPrincipalName: string }) {
        const s = await setupFor(principal, input, "onedrive");
        return discovery.resolveOneDrive(s.config, s.credentials, input.userPrincipalName).catch(adminError);
      },
      async listFolders(principal: SessionPrincipal, input: { connectionPublicId: string; expectedVersion: number; kind: "sharepoint" | "onedrive"; driveId: string; parentItemId?: string | null; cursor?: string | null }) {
        const s = await setupFor(principal, input, input.kind);
        return discovery.listFolders(s.config, s.credentials, { driveId: input.driveId, parentItemId: input.parentItemId ?? null, cursor: input.cursor ?? null }).catch(adminError);
      },
    },

    orderSync: {
      get: view,

      async listLists(principal: SessionPrincipal) {
        const { list } = await assignedSite(principal);
        return { lists: await list.listLists().catch(adminError) };
      },

      async createList(principal: SessionPrincipal, input: { displayName: string }) {
        if (!validListName(input.displayName)) throw validation("SHAREPOINT_LIST_NAME_INVALID", "Use a list name of up to 120 characters without # % * : < > ? / \\ | or quotes.");
        const { list } = await assignedSite(principal);
        const created = await list.createList(input.displayName.trim(), async () => {
          await guard(principal, async () => undefined);
        }).catch(adminError);
        await guard(principal, (tx) => adminAudit(principal, "sharepoint.list.created", "create", tx));
        return created;
      },

      async update(principal: SessionPrincipal, input: { expectedVersion: number; enabled: boolean; listId: string | null; listLabel: string | null; includePortalLink: boolean }) {
        if (input.listId !== null && !/^[A-Za-z0-9!._,{}-]{1,200}$/u.test(input.listId)) throw validation("SHAREPOINT_INVALID_INPUT", "Choose a list from the list.");
        const listLabel = input.listLabel === null ? null : input.listLabel.trim().slice(0, 255) || null;
        if (input.enabled) {
          if (!input.listId) throw validation("SHAREPOINT_LIST_REQUIRED", "Choose a compatible list before enabling the sync.");
          const test = await testList(principal, input.listId);
          if (!test.ok) throw new DomainError("VALIDATION", `SHAREPOINT_TEST_${test.code}`.slice(0, 64), "The list did not pass the connection test. Fix it, then enable the sync.");
        }
        await guard(principal, async (tx) => {
          const current = await readConfig(tx, true);
          const currentVersion = current?.version ?? 0;
          if (currentVersion !== input.expectedVersion) throw conflict("STALE_VERSION", "These settings were changed by someone else. Reload and try again.");
          const values = { enabled: input.enabled, listId: input.listId, listLabel, includePortalLink: input.includePortalLink, updatedByUserId: principal.userId, lastErrorCode: null, lastErrorAt: null };
          if (!current) await tx.insert(sharepointSyncConfig).values({ id: CONFIG_ID, version: 1, ...values });
          else
            await tx
              .update(sharepointSyncConfig)
              .set({
                ...values,
                version: currentVersion + 1,
                // A settings change ends a running backfill; the administrator must start it again explicitly.
                ...(current.backfillState === "running" ? { backfillState: "failed" as const, backfillReasonCode: "SHAREPOINT_BACKFILL_SCOPE_CHANGED", backfillFinishedAt: clock.now() } : {}),
              })
              .where(eq(sharepointSyncConfig.id, CONFIG_ID));
          const changedList = (current?.listId ?? null) !== input.listId;
          await adminAudit(principal, current?.enabled !== input.enabled ? (input.enabled ? "sharepoint.sync.enabled" : "sharepoint.sync.disabled") : "sharepoint.sync.updated", "update", tx, { safeCounts: { listChanged: changedList ? 1 : 0 } });
        });
        return view(principal);
      },

      async test(principal: SessionPrincipal) {
        const config = await guard(principal, (tx) => readConfig(tx));
        const result = await testList(principal, config?.listId ?? null);
        await guard(principal, (tx) => adminAudit(principal, "sharepoint.sync.tested", "test", tx, { outcome: result.ok ? "completed" : "failed", reasonCode: result.code }));
        return result;
      },

      /**
       * "Sync all existing orders now": starts (or resumes after a failure) a bounded, fenced backfill over the
       * orders module's keyset listing. Every order is staged through the same outbox; the list item is found
       * by RpOrderId, so repeated runs never duplicate items. `restart` begins again from the first order.
       */
      async backfill(principal: SessionPrincipal, input: { restart?: boolean } = {}) {
        await guard(principal, async (tx) => {
          const config = await readConfig(tx, true);
          if (!config?.enabled || !config.listId) throw new DomainError("NOT_CONFIGURED", "SHAREPOINT_SYNC_DISABLED", "Enable the sync first.");
          if (config.backfillState === "running" && !input.restart) return;
          const scope = await currentScope(tx, config);
          if (!scope) throw new DomainError("NOT_CONFIGURED", "SHAREPOINT_NOT_CONFIGURED", "Assign a SharePoint connection first.");
          // Resume only within the same authorized scope; any settings/destination change starts a new run.
          const resume = !input.restart && config.backfillState === "failed" && config.backfillRunId !== null && config.backfillScope === scope;
          const runId = resume ? config.backfillRunId! : ulid(clock.now().getTime());
          await tx
            .update(sharepointSyncConfig)
            .set({
              backfillRunId: runId,
              backfillScope: scope,
              backfillState: "running",
              backfillReasonCode: null,
              backfillFinishedAt: null,
              ...(resume ? {} : { backfillCursor: null, backfillEnqueued: 0, backfillStartedAt: clock.now() }),
            })
            .where(eq(sharepointSyncConfig.id, CONFIG_ID));
          await jobs.enqueue<BackfillJobPayload>(BACKFILL_JOB, { runId, after: resume ? config.backfillCursor : null }, { idempotencyKey: `sharepoint:backfill:${runId}:${resume ? (config.backfillCursor ?? "start") : "start"}:${clock.now().getTime()}` }, tx);
          await adminAudit(principal, resume ? "sharepoint.sync.backfill_resumed" : "sharepoint.sync.backfill_started", "sync", tx);
        });
        return view(principal);
      },

      /** Re-stages every live order already known to the sync (bounded batch); trashed orders are skipped. */
      async resyncAll(principal: SessionPrincipal) {
        return guard(principal, async (tx) => {
          const config = await readConfig(tx);
          if (!config?.enabled || !config.listId) throw new DomainError("NOT_CONFIGURED", "SHAREPOINT_SYNC_DISABLED", "Enable the sync first.");
          const rows = await tx
            .select({ orderPublicId: sharepointOrderSync.orderPublicId })
            .from(sharepointOrderSync)
            .where(or(isNull(sharepointOrderSync.reasonCode), ne(sharepointOrderSync.reasonCode, ORDER_TRASHED_REASON)))
            .orderBy(asc(sharepointOrderSync.id))
            .limit(RESYNC_BATCH);
          let enqueued = 0;
          for (const r of rows) {
            const order = await deps.services.orders.getOrderSyncView(r.orderPublicId, tx);
            if (!order) continue;
            await stage(r.orderPublicId, tx);
            enqueued += 1;
          }
          await adminAudit(principal, "sharepoint.sync.resync_requested", "sync", tx, { safeCounts: { enqueued } });
          return { enqueued };
        });
      },

      async status(principal: SessionPrincipal, input: { cursor?: string | null; limit?: number; state?: SharepointSyncState }) {
        const limit = Math.min(Math.max(input.limit ?? 50, 1), MAX_STATUS_PAGE);
        const after = input.cursor && /^\d{1,15}$/u.test(input.cursor) ? Number(input.cursor) : 0;
        return guard(principal, async (tx) => {
          const rows = await tx
            .select()
            .from(sharepointOrderSync)
            .where(
              and(
                gt(sharepointOrderSync.id, after),
                or(isNull(sharepointOrderSync.reasonCode), ne(sharepointOrderSync.reasonCode, ORDER_TRASHED_REASON)),
                input.state ? eq(sharepointOrderSync.state, input.state) : undefined,
              ),
            )
            .orderBy(asc(sharepointOrderSync.id))
            .limit(limit + 1);
          const page = rows.slice(0, limit);
          const items = [];
          for (const r of page) {
            const order = await deps.services.orders.getOrderSyncView(r.orderPublicId, tx);
            if (!order) continue;
            items.push({ orderPublicId: r.orderPublicId, reference: order.reference, state: r.state, attempts: r.attempts, lastSyncedAt: r.lastSyncedAt, reasonCode: r.reasonCode });
          }
          return { items, nextCursor: rows.length > limit ? String(page[page.length - 1]!.id) : null };
        });
      },
    },
  };
}

export type SharepointService = ReturnType<typeof createSharepointService>;
