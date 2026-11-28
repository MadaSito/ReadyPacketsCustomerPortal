/**
 * Trash coordinator service (Increment 09, Decision D2 & D2.8). Owner: recovery_ops_engineer.
 *
 * Security invariants enforced (D2.8 + lead rulings):
 *  - Every procedure re-validates actor role, capability, session freshness, and MFA step-up inside `tx`
 *    via `createActorGuard` (fail closed if identity session verification is unavailable).
 *  - Missing `orders.trash`, `identity.trash`, or any expected `TrashParticipant` fails closed (`503 UNAVAILABLE`).
 *  - Legal hold (`orders.lock_state = 'legal_hold'`) blocks order & customer move-to-trash and purge with
 *    `409 ORDER_ON_LEGAL_HOLD` ("Release the legal hold first."); the retention job skips held items and raises
 *    an operational alert without failing the rest of the sweep.
 *  - Cascades enforce bounded target counts (`MAX_CASCADE_TARGETS`) and fail closed on overflow.
 *  - Idempotency keys are durably reserved BEFORE side effects and bound to `(actor, action, fingerprint, batchGenerations)`.
 *  - Purge runs use durable per-run lease + monotonic `fencingToken` + cross-entity overlap exclusion (`FOR UPDATE`),
 *    so two workers cannot run the same participant concurrently or overwrite checkpoints, and tombstones are
 *    written only after every participant succeeds and target batch generations still match under `FOR UPDATE`.
 *  - Retention preview & update use exact SQL `COUNT(*)` queries (zero in-memory scan truncation) and serialize
 *    cohort-changing writes (`FOR SHARE` on `trash_retention_state`) against settings CAS (`FOR UPDATE`).
 *  - Recorded-owned external copies on rotated/unreachable destinations fail resumably with
 *    `EXTERNAL_COPIES_UNREACHABLE`; only `finishLeavingExternalCopies` (`trash.purge` + step-up + typed reference
 *    + CAS on failed `runId`, durably audited BEFORE invoking destructive work) sets `acknowledgedUnreachableCopies: true`.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { STEP_UP_CAPABILITIES, type Capability } from "../../../shared/capabilities.js";
import type { ModuleDeps, Services } from "../../container.js";
import { DomainError, conflict, forbidden, notFound, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { DbOrTx, SessionPrincipal, Tx } from "../../core/types.js";
import { STEP_UP_MAX_AGE_MS } from "../../trpc/trpc.js";
import { users } from "../identity/schema.js";
import { keyHash } from "../jobs/queue.js";
import { orders } from "../orders/schema.js";
import { createActorGuard } from "../platform/actorGuard.js";
import { platformSettings } from "../platform/schema.js";
import { TRASH_JOB_RETENTION_CLEANUP } from "./jobNames.js";
import type {
  TrashActor,
  TrashEntityKind,
  TrashEntityRef,
  TrashParticipant,
  TrashRegistry,
} from "./ports.js";
import {
  trashCleanupSweeps,
  trashIdempotencyKeys,
  trashPurgeRuns,
  trashRetentionState,
} from "./schema.js";
import {
  parseRetentionDays,
  TRASH_AUTO_PURGE_ENABLED,
  TRASH_RETENTION_CUSTOMER_DAYS,
  TRASH_RETENTION_DEFAULT_DAYS,
  TRASH_RETENTION_MAX_DAYS,
  TRASH_RETENTION_MIN_DAYS,
  TRASH_RETENTION_ORDER_DAYS,
} from "./settings.js";
import type {
  RetentionValues,
  TrashCleanupResult,
  TrashCoordinatorOptions,
  TrashCounts,
  TrashFinishLeavingExternalInput,
  TrashFinishLeavingExternalOutput,
  TrashItemRef,
  TrashItemResult,
  TrashListOutput,
  TrashMoveOutput,
  TrashPerson,
  TrashPurgeOutput,
  TrashRestoreOutput,
  TrashRow,
  TrashRunSummary,
  TrashService,
  TrashSettings,
  TrashSettingsPreview,
  TrashSummary,
} from "./types.js";

const DAY_MS = 24 * 60 * 60_000;
const IDEM_TTL_MS = 24 * 60 * 60_000;
const PURGE_LEASE_MS = 2 * 60_000;
const MAX_BULK_ITEMS = 100;
const MAX_CASCADE_TARGETS = 10_000;
const MAX_LIST_COHORT = 10_000;
const SWEEP_BATCH_LIMIT = 500;
const REASON_MAX_LENGTH = 200;

/**
 * Complete explicit manifest of every module in `createContainer` that owns order/customer records (D2.6 & D2.8).
 * Missing any participant in this manifest fails purge closed with `TRASH_PARTICIPANT_MISSING`.
 */
export const EXPECTED_CONTAINER_PARTICIPANTS = [
  "identity",
  "assurance",
  "orders",
  "files",
  "platform",
  "jobs",
  "portable",
  "compliance",
  "billingProfile",
  "cart",
  "sharepoint",
  "integrations",
  "payments",
  "engagement",
  "community",
  "knowledge",
  "publicApi",
  "automations",
  "referrals",
  "promotions",
] as const;

interface PersistedTargetsEnvelope {
  targets: TrashEntityRef[];
  expectedModules: string[];
}

interface PersistedCheckpoint {
  completedSteps: string[];
  leaseOwner: string | null;
  leaseExpiresAtMs: number;
  fencingToken: number;
  acknowledgedUnreachableCopies?: boolean;
}

interface PersistedCounts {
  deleted: Record<string, number>;
  kept: Record<string, number>;
  unreachableByConnection?: Record<string, number>;
  unreachableTotal?: number;
}

interface StoredIdempotencyEnvelope<T> {
  status: "in_progress" | "completed";
  fingerprintHash: string;
  batchBindings: Record<string, string | null>;
  payload?: T;
}

const stepUpError = () =>
  new DomainError("STEP_UP_REQUIRED", "STEP_UP_REQUIRED", "Confirm your identity to continue.");

const legalHoldError = () =>
  conflict("ORDER_ON_LEGAL_HOLD", "Release the legal hold first.");

function stripUnsafeText(raw: string): string {
  let out = "";
  for (const ch of raw.normalize("NFC")) {
    const cp = ch.codePointAt(0) ?? 0;
    const isCtrl = cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f);
    const isBidi =
      cp === 0x061c ||
      cp === 0x200e ||
      cp === 0x200f ||
      (cp >= 0x202a && cp <= 0x202e) ||
      (cp >= 0x2066 && cp <= 0x2069);
    if (!isCtrl && !isBidi) out += ch;
  }
  return out.trim();
}

function cleanReason(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = stripUnsafeText(raw);
  if (cleaned.length > REASON_MAX_LENGTH) {
    throw validation("REASON_TOO_LONG", `Use ${REASON_MAX_LENGTH} characters or fewer.`);
  }
  return cleaned.length > 0 ? cleaned : null;
}

function addDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * DAY_MS);
}

function mergeCounts(into: Record<string, number>, delta: Record<string, number> | undefined): void {
  if (!delta) return;
  for (const [k, v] of Object.entries(delta)) {
    if (typeof v === "number" && Number.isFinite(v) && v !== 0) {
      into[k] = (into[k] ?? 0) + v;
    } else if (typeof v === "number" && Number.isFinite(v) && !(k in into)) {
      into[k] = 0;
    }
  }
}

function parseUnreachableDetails(err: DomainError): {
  byConnection: Record<string, number>;
  total: number;
} {
  const byConnection: Record<string, number> = {};
  let total = 0;
  const raw = err.details?.unreachableCopyCounts;
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== "string") continue;
      const sep = entry.lastIndexOf(":");
      if (sep <= 0) continue;
      const connId = entry.slice(0, sep).trim();
      const count = Number(entry.slice(sep + 1));
      if (connId && Number.isInteger(count) && count > 0) {
        byConnection[connId] = (byConnection[connId] ?? 0) + count;
        total += count;
      }
    }
  }
  if (total === 0 && typeof err.details?.unreachableCopies === "number" && err.details.unreachableCopies > 0) {
    total = Math.trunc(err.details.unreachableCopies);
  }
  return { byConnection, total: total > 0 ? total : 1 };
}

function parseOptionalDate(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw validation("INVALID_DATE", "Enter a valid date filter.");
  }
  return parsed;
}

function parseOptionalEndDate(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const end = new Date(`${trimmed}T23:59:59.999Z`);
    if (!Number.isNaN(end.getTime())) return end;
  }
  return parseOptionalDate(trimmed);
}

function validateRetentionValues(values: RetentionValues): RetentionValues {
  const check = (n: number) =>
    Number.isInteger(n) && n >= TRASH_RETENTION_MIN_DAYS && n <= TRASH_RETENTION_MAX_DAYS;
  if (!check(values.orderDays) || !check(values.customerDays)) {
    throw validation(
      "INVALID_RETENTION_DAYS",
      `Enter a whole number of days from ${TRASH_RETENTION_MIN_DAYS} to ${TRASH_RETENTION_MAX_DAYS}.`,
    );
  }
  return {
    autoPurgeEnabled: Boolean(values.autoPurgeEnabled),
    orderDays: values.orderDays,
    customerDays: values.customerDays,
  };
}

function assertUniqueItems(items: readonly TrashItemRef[]): void {
  if (items.length < 1 || items.length > MAX_BULK_ITEMS) {
    throw validation("INVALID_BULK_COUNT", `Select between 1 and ${MAX_BULK_ITEMS} items.`);
  }
  const seen = new Set<string>();
  for (const item of items) {
    const key = `${item.kind}:${item.publicId}`;
    if (seen.has(key)) {
      throw validation("DUPLICATE_TARGETS", "Each item may appear at most once in a request.");
    }
    seen.add(key);
  }
}

function normalizeRestoreError(err: unknown): DomainError {
  if (err instanceof DomainError) {
    if (err.reasonCode === "PACKET_ALREADY_IN_PROJECT") {
      return conflict("RESTORE_CONFLICT", err.safeMessage);
    }
    if (err.reasonCode === "TRASH_BATCH_MISMATCH") {
      return conflict("STALE", "This item changed meanwhile. Review again.");
    }
    return err;
  }
  return unavailable("TRASH_RESTORE_FAILED");
}

function safeCountsForAudit(counts: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [rawKey, val] of Object.entries(counts)) {
    if (typeof val !== "number" || !Number.isFinite(val)) continue;
    const safeKey = rawKey
      .replace(/[^a-zA-Z0-9_]/g, "_")
      .replace(/([A-Z])/g, (m) => `_${m.toLowerCase()}`)
      .replace(/^_+|_+$/g, "")
      .slice(0, 48);
    if (safeKey) out[safeKey] = (out[safeKey] ?? 0) + Math.trunc(val);
  }
  return out;
}

function parseCheckpoint(raw: string): PersistedCheckpoint {
  const parsed = JSON.parse(raw) as Partial<PersistedCheckpoint>;
  return {
    completedSteps: Array.isArray(parsed.completedSteps) ? parsed.completedSteps : [],
    leaseOwner: typeof parsed.leaseOwner === "string" ? parsed.leaseOwner : null,
    leaseExpiresAtMs: typeof parsed.leaseExpiresAtMs === "number" ? parsed.leaseExpiresAtMs : 0,
    fencingToken: typeof parsed.fencingToken === "number" ? parsed.fencingToken : 0,
    ...(parsed.acknowledgedUnreachableCopies ? { acknowledgedUnreachableCopies: true } : {}),
  };
}

function parseCounts(raw: string | null): PersistedCounts {
  if (!raw) return { deleted: {}, kept: {} };
  const parsed = JSON.parse(raw) as Partial<PersistedCounts>;
  return {
    deleted: parsed.deleted && typeof parsed.deleted === "object" ? parsed.deleted : {},
    kept: parsed.kept && typeof parsed.kept === "object" ? parsed.kept : {},
    ...(parsed.unreachableByConnection ? { unreachableByConnection: parsed.unreachableByConnection } : {}),
    ...(typeof parsed.unreachableTotal === "number" ? { unreachableTotal: parsed.unreachableTotal } : {}),
  };
}

const unavailable = (reason: string, safeMessage = "Trash service is temporarily unavailable.") =>
  new DomainError("UNAVAILABLE", reason, safeMessage);

export function createTrashCoordinator(
  deps: ModuleDeps,
  registry: TrashRegistry,
  options: TrashCoordinatorOptions = {},
): TrashService {
  const log = deps.logger.child({ module: "trash" });
  let initializedExpectedModules: ReadonlySet<string> | null = null;

  const services = (): Partial<Services> => deps.services as Partial<Services>;

  function requireOrdersTrash() {
    const port = services().orders?.trash;
    if (!port) throw unavailable("TRASH_UNAVAILABLE", "Order recovery service is unavailable.");
    return port;
  }

  function requireIdentityTrash() {
    const port = services().identity?.trash;
    if (!port) throw unavailable("TRASH_UNAVAILABLE", "Customer recovery service is unavailable.");
    return port;
  }

  function computeExpectedModules(): string[] {
    if (options.expectedParticipants) {
      return [...new Set(options.expectedParticipants)];
    }
    if (initializedExpectedModules) {
      return [...initializedExpectedModules];
    }
    const registered = registry.participants().map((p) => p.module);
    if (Array.isArray(services().allModules)) {
      return [...new Set([...EXPECTED_CONTAINER_PARTICIPANTS, ...registered])];
    }
    return [...new Set(registered)];
  }

  function resolveParticipantsOrFail(requiredModules: readonly string[]): readonly TrashParticipant[] {
    const current = registry.participants();
    const byName = new Map(current.map((p) => [p.module, p]));
    const missing = requiredModules.filter((m) => !byName.has(m));
    if (missing.length > 0) {
      log.error("expected trash participant missing; failing purge closed", { missing });
      throw unavailable("TRASH_PARTICIPANT_MISSING", "Permanent deletion is temporarily unavailable.");
    }
    return current;
  }

  async function guardActorInTx(
    tx: Tx,
    principal: SessionPrincipal,
    capability: Capability,
  ): Promise<void> {
    if (principal.role !== "admin") throw forbidden("ROLE_NOT_PERMITTED");
    if (STEP_UP_CAPABILITIES.has(capability)) {
      const at = principal.stepUpAt?.getTime();
      if (at === undefined || deps.clock.now().getTime() - at > STEP_UP_MAX_AGE_MS) {
        throw stepUpError();
      }
    }
    const guard = createActorGuard(deps.services, deps.clock, principal, capability);
    try {
      await guard(tx);
    } catch (err) {
      if (err instanceof DomainError && err.reasonCode === "STEP_UP_REQUIRED") {
        throw stepUpError();
      }
      throw err;
    }
  }

  async function guardRead(principal: SessionPrincipal): Promise<void> {
    await deps.db.transaction(async (tx) => {
      await guardActorInTx(tx, principal, "trash.read");
    });
  }

  async function readRetentionValues(tx?: Tx, synchronized = false): Promise<RetentionValues> {
    if (tx && synchronized) {
      const keys = [
        TRASH_AUTO_PURGE_ENABLED.key,
        TRASH_RETENTION_ORDER_DAYS.key,
        TRASH_RETENTION_CUSTOMER_DAYS.key,
      ];
      const rows = await tx
        .select({ settingKey: platformSettings.settingKey, valueJson: platformSettings.valueJson })
        .from(platformSettings)
        .where(inArray(platformSettings.settingKey, keys))
        .for("share");
      const byKey = new Map(rows.map((r) => [r.settingKey, r.valueJson]));
      const rawAuto = byKey.get(TRASH_AUTO_PURGE_ENABLED.key);
      const autoPurgeEnabled = typeof rawAuto === "boolean" ? rawAuto : true;
      const orderDays = parseRetentionDays(byKey.get(TRASH_RETENTION_ORDER_DAYS.key), TRASH_RETENTION_DEFAULT_DAYS);
      const customerDays = parseRetentionDays(
        byKey.get(TRASH_RETENTION_CUSTOMER_DAYS.key),
        TRASH_RETENTION_DEFAULT_DAYS,
      );
      return { autoPurgeEnabled, orderDays, customerDays };
    }

    const autoPurgeEnabled = await deps.settings.get<boolean>(
      TRASH_AUTO_PURGE_ENABLED.key,
      (raw) => (typeof raw === "boolean" ? raw : true),
      true,
      tx,
    );
    const orderDays = await deps.settings.get<number>(
      TRASH_RETENTION_ORDER_DAYS.key,
      (raw) => parseRetentionDays(raw, TRASH_RETENTION_DEFAULT_DAYS),
      TRASH_RETENTION_DEFAULT_DAYS,
      tx,
    );
    const customerDays = await deps.settings.get<number>(
      TRASH_RETENTION_CUSTOMER_DAYS.key,
      (raw) => parseRetentionDays(raw, TRASH_RETENTION_DEFAULT_DAYS),
      TRASH_RETENTION_DEFAULT_DAYS,
      tx,
    );
    return { autoPurgeEnabled, orderDays, customerDays };
  }

  async function ensureRetentionRowInTx(tx: Tx): Promise<void> {
    const [existing] = await tx
      .select({ id: trashRetentionState.id })
      .from(trashRetentionState)
      .where(eq(trashRetentionState.singletonKey, 1))
      .limit(1);
    if (existing) return;
    await tx
      .insert(trashRetentionState)
      .values({ singletonKey: 1, version: 1, updatedAt: deps.clock.now() })
      .onDuplicateKeyUpdate({ set: { singletonKey: sql`${trashRetentionState.singletonKey}` } });
  }

  /**
   * Takes a shared lock on `trash_retention_state` so cohort-changing writes (`moveToTrash`, `restore`)
   * serialize cleanly with `updateSettings`'s exclusive `FOR UPDATE` CAS check.
   */
  async function shareLockRetentionCohortInTx(tx: Tx): Promise<number> {
    await ensureRetentionRowInTx(tx);
    const [row] = await tx
      .select({ version: trashRetentionState.version })
      .from(trashRetentionState)
      .where(eq(trashRetentionState.singletonKey, 1))
      .for("share")
      .limit(1);
    return row?.version ?? 1;
  }

  async function exclusiveLockRetentionVersionInTx(tx: Tx): Promise<number> {
    await ensureRetentionRowInTx(tx);
    const [row] = await tx
      .select({ version: trashRetentionState.version })
      .from(trashRetentionState)
      .where(eq(trashRetentionState.singletonKey, 1))
      .for("update")
      .limit(1);
    return row?.version ?? 1;
  }

  async function readRetentionVersion(dbOrTx: DbOrTx = deps.db): Promise<number> {
    const [row] = await dbOrTx
      .select({ version: trashRetentionState.version })
      .from(trashRetentionState)
      .where(eq(trashRetentionState.singletonKey, 1))
      .limit(1);
    return row?.version ?? 1;
  }

  async function currentBatchOf(
    dbOrTx: DbOrTx,
    item: { kind: TrashEntityKind; publicId: string },
  ): Promise<string | null> {
    if (item.kind === "order") {
      const [row] = await dbOrTx
        .select({ batchId: orders.trashBatchId, purgedAt: orders.purgedAt })
        .from(orders)
        .where(eq(orders.publicId, item.publicId))
        .limit(1);
      return row && !row.purgedAt ? row.batchId : null;
    }
    const [row] = await dbOrTx
      .select({ batchId: users.trashBatchId, purgedAt: users.purgedAt })
      .from(users)
      .where(and(eq(users.publicId, item.publicId), eq(users.role, "customer")))
      .limit(1);
    return row && !row.purgedAt ? row.batchId : null;
  }

  /**
   * Durably reserves `(actorUserId, operation, idempotencyKey)` BEFORE side effects execute.
   * Serializes concurrent calls with the same key via the unique index + `FOR UPDATE`.
   */
  async function reserveIdempotency<T>(params: {
    principal: SessionPrincipal;
    capability: Capability;
    operation: string;
    idempotencyKey: string;
    fingerprintHash: string;
    verifyBatchGenerations: boolean;
  }): Promise<{ hit: true; payload: T } | { hit: false; rowId: number }> {
    const { principal, capability, operation, idempotencyKey, fingerprintHash, verifyBatchGenerations } = params;
    const actionKey = `${capability}:${operation}`.slice(0, 48);
    const kHash = keyHash(`trash.idem:${actionKey}:${idempotencyKey}`);

    return deps.db.transaction(async (tx) => {
      await guardActorInTx(tx, principal, capability);
      const now = deps.clock.now();

      const [existing] = await tx
        .select()
        .from(trashIdempotencyKeys)
        .where(
          and(
            eq(trashIdempotencyKeys.actorUserId, principal.userId),
            eq(trashIdempotencyKeys.action, actionKey),
            eq(trashIdempotencyKeys.keyHash, kHash),
          ),
        )
        .for("update")
        .limit(1);

      if (existing) {
        if (existing.createdAt.getTime() + IDEM_TTL_MS <= now.getTime()) {
          await tx.delete(trashIdempotencyKeys).where(eq(trashIdempotencyKeys.id, existing.id));
        } else {
          if (existing.fingerprintHash !== fingerprintHash) {
            throw conflict("IDEMPOTENCY_KEY_REUSED", "This request key was already used for a different action.");
          }
          const parsed = JSON.parse(existing.responseJson) as StoredIdempotencyEnvelope<T>;
          if (parsed.status === "in_progress") {
            throw conflict("REQUEST_IN_PROGRESS", "This request is already being processed.");
          }
          if (verifyBatchGenerations) {
            for (const [bindingKey, recordedBatch] of Object.entries(parsed.batchBindings)) {
              const sep = bindingKey.indexOf(":");
              if (sep <= 0) continue;
              const kind = bindingKey.slice(0, sep) as TrashEntityKind;
              const publicId = bindingKey.slice(sep + 1);
              const liveBatch = await currentBatchOf(tx, { kind, publicId });
              if (liveBatch !== null && recordedBatch !== null && liveBatch !== recordedBatch) {
                throw conflict("IDEMPOTENCY_KEY_REUSED", "This item moved into a new trash batch since that request.");
              }
            }
          }
          return { hit: true as const, payload: parsed.payload as T };
        }
      }

      const initial: StoredIdempotencyEnvelope<T> = {
        status: "in_progress",
        fingerprintHash,
        batchBindings: {},
      };
      const [ins] = await tx.insert(trashIdempotencyKeys).values({
        actorUserId: principal.userId,
        action: actionKey,
        keyHash: kHash,
        fingerprintHash,
        responseJson: JSON.stringify(initial),
        createdAt: now,
      });
      return { hit: false as const, rowId: Number(ins.insertId) };
    });
  }

  async function completeIdempotency<T>(
    rowId: number,
    fingerprintHash: string,
    batchBindings: Record<string, string | null>,
    payload: T,
    tx?: Tx,
  ): Promise<void> {
    const dbOrTx = tx ?? deps.db;
    const envelope: StoredIdempotencyEnvelope<T> = {
      status: "completed",
      fingerprintHash,
      batchBindings,
      payload,
    };
    await dbOrTx
      .update(trashIdempotencyKeys)
      .set({ responseJson: JSON.stringify(envelope) })
      .where(eq(trashIdempotencyKeys.id, rowId));
  }

  async function releaseUnmutatedIdempotency(rowId: number): Promise<void> {
    await deps.db
      .delete(trashIdempotencyKeys)
      .where(eq(trashIdempotencyKeys.id, rowId))
      .catch(() => undefined);
  }

  /**
   * Exact SQL totals & due counts (zero in-memory scan cap or truncation).
   * D2.4: Orders moved to the trash WITH a customer (`owner.trashed_at IS NOT NULL AND owner.purged_at IS NULL
   * AND owner.trash_batch_id = orders.trash_batch_id`) follow the customer's retention and are counted/purged
   * with that customer, never standalone.
   */
  async function exactCountsAtHorizon(
    retention: RetentionValues,
    withinMs: number,
    dbOrTx: DbOrTx = deps.db,
    lockForShare = false,
  ): Promise<{ ordersTotal: number; customersTotal: number; dueCustomers: number; dueStandaloneOrders: number; dueTotal: number }> {
    const nowMs = deps.clock.now().getTime() + withinMs;
    const customerCutoff = new Date(nowMs - retention.customerDays * DAY_MS);
    const orderCutoff = new Date(nowMs - retention.orderDays * DAY_MS);

    const custTotalQuery = dbOrTx
      .select({ total: sql<number>`COUNT(*)` })
      .from(users)
      .where(and(eq(users.role, "customer"), isNotNull(users.trashedAt), isNull(users.purgedAt)));
    const ordTotalQuery = dbOrTx
      .select({ total: sql<number>`COUNT(*)` })
      .from(orders)
      .where(and(isNotNull(orders.trashedAt), isNull(orders.purgedAt)));

    const [custRow] = lockForShare ? await custTotalQuery.for("share") : await custTotalQuery;
    const [ordRow] = lockForShare ? await ordTotalQuery.for("share") : await ordTotalQuery;
    const customersTotal = Number(custRow?.total ?? 0);
    const ordersTotal = Number(ordRow?.total ?? 0);

    if (!retention.autoPurgeEnabled) {
      return { ordersTotal, customersTotal, dueCustomers: 0, dueStandaloneOrders: 0, dueTotal: 0 };
    }

    const dueCustQuery = dbOrTx
      .select({ total: sql<number>`COUNT(*)` })
      .from(users)
      .where(
        and(
          eq(users.role, "customer"),
          isNotNull(users.trashedAt),
          isNull(users.purgedAt),
          lte(users.trashedAt, customerCutoff),
        ),
      );
    const standaloneOrderPredicate = and(
      isNotNull(orders.trashedAt),
      isNull(orders.purgedAt),
      lte(orders.trashedAt, orderCutoff),
      sql`NOT (${users.trashedAt} IS NOT NULL AND ${users.purgedAt} IS NULL AND ${users.trashBatchId} = ${orders.trashBatchId})`,
    );
    const dueOrdQuery = dbOrTx
      .select({ total: sql<number>`COUNT(*)` })
      .from(orders)
      .leftJoin(users, eq(users.id, orders.ownerUserId))
      .where(standaloneOrderPredicate);

    const [dueCustRow] = lockForShare ? await dueCustQuery.for("share") : await dueCustQuery;
    const [dueOrdRow] = lockForShare ? await dueOrdQuery.for("share") : await dueOrdQuery;
    const dueCustomers = Number(dueCustRow?.total ?? 0);
    const dueStandaloneOrders = Number(dueOrdRow?.total ?? 0);
    return {
      ordersTotal,
      customersTotal,
      dueCustomers,
      dueStandaloneOrders,
      dueTotal: dueCustomers + dueStandaloneOrders,
    };
  }

  /**
   * Exact SQL count of items currently in the trash that newly become due when moving from `current` to `proposed`.
   * Uses `FOR SHARE` when `lockForShare = true` inside `updateSettings` so MySQL RR performs a current read.
   */
  async function computeExactNewlyBecomingDueCount(
    current: RetentionValues,
    proposed: RetentionValues,
    dbOrTx: DbOrTx = deps.db,
    lockForShare = false,
  ): Promise<{ becomeDue: number; shorteningOrEnabling: boolean }> {
    const enabling = proposed.autoPurgeEnabled && !current.autoPurgeEnabled;
    const shortening =
      proposed.autoPurgeEnabled &&
      (proposed.orderDays < current.orderDays || proposed.customerDays < current.customerDays);
    if (!enabling && !shortening) {
      return { becomeDue: 0, shorteningOrEnabling: false };
    }
    if (!current.autoPurgeEnabled) {
      const snap = await exactCountsAtHorizon(proposed, 0, dbOrTx, lockForShare);
      return { becomeDue: snap.dueTotal, shorteningOrEnabling: true };
    }

    const nowMs = deps.clock.now().getTime();
    let newlyDueCustomers = 0;
    if (proposed.customerDays < current.customerDays) {
      const propCustCutoff = new Date(nowMs - proposed.customerDays * DAY_MS);
      const currCustCutoff = new Date(nowMs - current.customerDays * DAY_MS);
      const q = dbOrTx
        .select({ total: sql<number>`COUNT(*)` })
        .from(users)
        .where(
          and(
            eq(users.role, "customer"),
            isNotNull(users.trashedAt),
            isNull(users.purgedAt),
            lte(users.trashedAt, propCustCutoff),
            sql`${users.trashedAt} > ${currCustCutoff}`,
          ),
        );
      const [r] = lockForShare ? await q.for("share") : await q;
      newlyDueCustomers = Number(r?.total ?? 0);
    }

    let newlyDueOrders = 0;
    if (proposed.orderDays < current.orderDays) {
      const propOrdCutoff = new Date(nowMs - proposed.orderDays * DAY_MS);
      const currOrdCutoff = new Date(nowMs - current.orderDays * DAY_MS);
      const q = dbOrTx
        .select({ total: sql<number>`COUNT(*)` })
        .from(orders)
        .leftJoin(users, eq(users.id, orders.ownerUserId))
        .where(
          and(
            isNotNull(orders.trashedAt),
            isNull(orders.purgedAt),
            lte(orders.trashedAt, propOrdCutoff),
            sql`${orders.trashedAt} > ${currOrdCutoff}`,
            sql`NOT (${users.trashedAt} IS NOT NULL AND ${users.purgedAt} IS NULL AND ${users.trashBatchId} = ${orders.trashBatchId})`,
          ),
        );
      const [r] = lockForShare ? await q.for("share") : await q;
      newlyDueOrders = Number(r?.total ?? 0);
    }

    return { becomeDue: newlyDueCustomers + newlyDueOrders, shorteningOrEnabling: true };
  }

  function computeOrderDueAt(
    orderTrashedAt: Date,
    orderBatchId: string,
    ownerMeta: { trashedAt: Date | null; trashBatchId: string | null } | undefined,
    retention: RetentionValues,
  ): { dueAt: Date | null; movedWithCustomer: boolean } {
    const movedWithCustomer = Boolean(
      ownerMeta && ownerMeta.trashedAt !== null && ownerMeta.trashBatchId === orderBatchId,
    );
    if (!retention.autoPurgeEnabled) {
      return { dueAt: null, movedWithCustomer };
    }
    if (movedWithCustomer && ownerMeta?.trashedAt) {
      return { dueAt: addDays(ownerMeta.trashedAt, retention.customerDays), movedWithCustomer: true };
    }
    return { dueAt: addDays(orderTrashedAt, retention.orderDays), movedWithCustomer: false };
  }

  async function resolveStaffNamesByIds(
    userIds: readonly number[],
    dbOrTx: DbOrTx = deps.db,
  ): Promise<Map<number, TrashPerson>> {
    const unique = [...new Set(userIds.filter((id) => Number.isInteger(id) && id > 0))];
    const out = new Map<number, TrashPerson>();
    if (!unique.length) return out;
    const rows = await dbOrTx
      .select({
        id: users.id,
        publicId: users.publicId,
        role: users.role,
        nameEnc: users.nameEnc,
      })
      .from(users)
      .where(inArray(users.id, unique));
    for (const row of rows) {
      let displayName = row.role === "admin" ? "Administrator" : "Staff";
      if (row.nameEnc) {
        try {
          const decrypted = deps.crypto
            .decrypt(row.nameEnc, `users.name:${row.publicId}`)
            .trim();
          if (decrypted) displayName = decrypted;
        } catch {
          // Keep generic role label if ciphertext cannot be opened.
        }
      }
      out.set(row.id, { publicId: row.publicId, displayName });
    }
    return out;
  }

  async function latestPurgeRunsByEntity(
    kind: TrashEntityKind,
    entityIds: readonly number[],
    dbOrTx: DbOrTx = deps.db,
  ): Promise<
    Map<
      number,
      {
        publicId: string;
        status: "running" | "completed" | "failed";
        errorCode: string | null;
        targetsJson: string;
        countsJson: string | null;
        checkpointJson: string;
      }
    >
  > {
    const unique = [...new Set(entityIds)];
    const out = new Map<
      number,
      {
        publicId: string;
        status: "running" | "completed" | "failed";
        errorCode: string | null;
        targetsJson: string;
        countsJson: string | null;
        checkpointJson: string;
      }
    >();
    if (!unique.length) return out;
    const rows = await dbOrTx
      .select({
        entityId: trashPurgeRuns.entityId,
        publicId: trashPurgeRuns.publicId,
        status: trashPurgeRuns.status,
        errorCode: trashPurgeRuns.errorCode,
        targetsJson: trashPurgeRuns.targetsJson,
        countsJson: trashPurgeRuns.countsJson,
        checkpointJson: trashPurgeRuns.checkpointJson,
      })
      .from(trashPurgeRuns)
      .where(and(eq(trashPurgeRuns.entityKind, kind), inArray(trashPurgeRuns.entityId, unique)))
      .orderBy(desc(trashPurgeRuns.id));
    for (const row of rows) {
      if (!out.has(row.entityId)) {
        out.set(row.entityId, row);
      }
    }
    return out;
  }

  async function collectFilteredTrashedOrders(
    filter: { q?: string; from?: Date; to?: Date; trashedByUserId?: number },
    dbOrTx: DbOrTx = deps.db,
  ) {
    const ordersTrash = requireOrdersTrash();
    const out = [];
    let cursor: number | undefined;
    while (out.length <= MAX_LIST_COHORT) {
      const page = await ordersTrash.listTrashed(
        { ...filter, cursor, limit: 1_000 },
        dbOrTx,
      );
      out.push(...page.items);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    if (out.length > MAX_LIST_COHORT) {
      throw unavailable("TRASH_LIST_TOO_LARGE", "Narrow your search filters to view matching items.");
    }
    return out;
  }

  async function collectFilteredTrashedCustomers(
    filter: { q?: string; from?: Date; to?: Date; movedBy?: string },
    dbOrTx: DbOrTx = deps.db,
  ) {
    const idTrash = requireIdentityTrash();
    const out = [];
    let cursor: string | undefined;
    while (out.length <= MAX_LIST_COHORT) {
      const page = await idTrash.listTrashedCustomers(
        { ...filter, cursor, limit: 1_000 },
        dbOrTx,
      );
      out.push(...page.items);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    if (out.length > MAX_LIST_COHORT) {
      throw unavailable("TRASH_LIST_TOO_LARGE", "Narrow your search filters to view matching items.");
    }
    return out;
  }

  async function loadCustomerTrashMetaChunked(
    ownerIds: readonly number[],
    dbOrTx: DbOrTx = deps.db,
  ) {
    const idTrash = requireIdentityTrash();
    const unique = [...new Set(ownerIds.filter((id) => Number.isSafeInteger(id)))];
    const merged = new Map<
      number,
      { publicId: string; customerRef: string | null; trashedAt: Date | null; trashBatchId: string | null }
    >();
    for (let i = 0; i < unique.length; i += 500) {
      const part = await idTrash.getCustomerTrashMetaByIds(unique.slice(i, i + 500), dbOrTx);
      for (const [k, v] of part) merged.set(k, v);
    }
    return merged;
  }

  async function readLastSweepSummary(dbOrTx: DbOrTx = deps.db): Promise<TrashRunSummary | null> {
    const [sweep] = await dbOrTx
      .select()
      .from(trashCleanupSweeps)
      .orderBy(desc(trashCleanupSweeps.id))
      .limit(1);
    if (!sweep) return null;
    return {
      publicId: sweep.publicId,
      finishedAt: sweep.finishedAt,
      status: sweep.status,
      purged: sweep.purgedCount,
      failed: sweep.failedCount,
    };
  }

  async function buildSettingsView(dbOrTx: DbOrTx = deps.db): Promise<TrashSettings> {
    const [retention, version, lastRun] = await Promise.all([
      readRetentionValues(dbOrTx as Tx | undefined),
      readRetentionVersion(dbOrTx),
      readLastSweepSummary(dbOrTx),
    ]);
    const snap = await exactCountsAtHorizon(retention, 0, dbOrTx);
    return {
      ...retention,
      version,
      lastRun,
      nextDueCount: snap.dueTotal,
    };
  }

  async function isMaintenanceBlockingCleanup(tx?: Tx): Promise<string | null> {
    const jobAdmin = services().jobAdmin;
    if (jobAdmin?.isDraining && (await jobAdmin.isDraining())) {
      return "WORKER_DRAINING";
    }
    if (jobAdmin?.maintenance?.customerAccess) {
      const status = await jobAdmin.maintenance.customerAccess(tx);
      if (status.active) return "CUSTOMER_MAINTENANCE_ACTIVE";
    }
    return null;
  }

  /**
   * Checks under `FOR UPDATE` / `FOR SHARE` whether a customer owns any non-purged order on `legal_hold`.
   */
  async function assertCustomerHasNoLegalHoldInTx(tx: Tx, customerUserId: number): Promise<void> {
    const [held] = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.ownerUserId, customerUserId),
          isNull(orders.purgedAt),
          eq(orders.lockState, "legal_hold"),
        ),
      )
      .for("share")
      .limit(1);
    if (held) throw legalHoldError();
  }

  /**
   * Verifies no other active purge run (`status === "running"` with unexpired lease) overlaps any target
   * in `candidateOrderIds` or `candidateCustomerId` (locks overlapping run rows `FOR UPDATE`).
   */
  async function assertNoOverlappingActiveRunsInTx(
    tx: Tx,
    selfRunRowId: number | null,
    candidateOrderIds: readonly number[],
    candidateCustomerIds: readonly number[],
    nowMs: number,
  ): Promise<void> {
    const conditions = [];
    if (candidateOrderIds.length > 0) {
      conditions.push(
        and(eq(trashPurgeRuns.entityKind, "order"), inArray(trashPurgeRuns.entityId, [...candidateOrderIds])),
      );
    }
    if (candidateCustomerIds.length > 0) {
      conditions.push(
        and(
          eq(trashPurgeRuns.entityKind, "customer"),
          inArray(trashPurgeRuns.entityId, [...candidateCustomerIds]),
        ),
      );
    }
    if (!conditions.length) return;

    const overlapping = await tx
      .select()
      .from(trashPurgeRuns)
      .where(and(eq(trashPurgeRuns.status, "running"), or(...conditions)))
      .for("update");

    for (const run of overlapping) {
      if (selfRunRowId !== null && run.id === selfRunRowId) continue;
      const cp = parseCheckpoint(run.checkpointJson);
      if (cp.leaseExpiresAtMs > nowMs) {
        throw conflict(
          "PURGE_IN_PROGRESS",
          "Permanent deletion is already running for this item or an associated account.",
        );
      }
    }
  }

  async function restoreSingleInTx(
    tx: Tx,
    item: TrashItemRef,
    actor: TrashActor,
    auditPrincipal: SessionPrincipal,
  ): Promise<{ batchId: string }> {
    await shareLockRetentionCohortInTx(tx);
    const participants = registry.participants();
    const ordersTrash = requireOrdersTrash();
    const idTrash = requireIdentityTrash();

    if (item.kind === "order") {
      // Plain read for ownerUserId, then lock `users FOR SHARE` BEFORE `orders FOR UPDATE` (`users -> sessions -> orders`).
      const [peekOwner] = await tx
        .select({ ownerUserId: orders.ownerUserId })
        .from(orders)
        .where(eq(orders.publicId, item.publicId))
        .limit(1);
      if (!peekOwner) throw notFound("ORDER_NOT_FOUND");
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, peekOwner.ownerUserId))
        .for("share")
        .limit(1);

      const [lockedOrder] = await tx
        .select({
          id: orders.id,
          publicId: orders.publicId,
          trashBatchId: orders.trashBatchId,
          trashedAt: orders.trashedAt,
          purgeStartedAt: orders.purgeStartedAt,
          purgedAt: orders.purgedAt,
        })
        .from(orders)
        .where(eq(orders.publicId, item.publicId))
        .for("update")
        .limit(1);

      if (!lockedOrder || lockedOrder.purgedAt) throw notFound("ORDER_NOT_FOUND");
      if (!lockedOrder.trashedAt || !lockedOrder.trashBatchId) {
        throw conflict("NOT_IN_TRASH", "This order is not in the trash.");
      }
      if (lockedOrder.purgeStartedAt) {
        throw conflict(
          "PURGE_IN_PROGRESS",
          "Permanent deletion has started for this order, so it can no longer be restored.",
        );
      }
      if (item.batchId && lockedOrder.trashBatchId !== item.batchId) {
        throw conflict("STALE", "This order changed meanwhile. Review again.");
      }
      const batchId = lockedOrder.trashBatchId;

      let restoredEntities: TrashEntityRef[];
      try {
        const res = await ordersTrash.restoreOrderInTx(tx, {
          orderPublicId: item.publicId,
          actor,
        });
        restoredEntities = res.entities;
      } catch (err) {
        throw normalizeRestoreError(err);
      }
      for (const entity of restoredEntities) {
        for (const p of participants) {
          if (p.onRestoredInTx) {
            try {
              await p.onRestoredInTx(tx, entity, actor);
            } catch (err) {
              throw normalizeRestoreError(err);
            }
          }
        }
        await deps.audit.record(
          {
            category: "admin",
            eventName: "order.restored",
            action: "restore",
            outcome: "completed",
            severity: "INFO",
            actor: { userId: auditPrincipal.userId, role: auditPrincipal.role },
            resource: { type: "order", id: entity.id, publicId: entity.publicId },
            orderPublicId: entity.publicId,
            correlationId: entity.batchId,
            attributes: {
              order_public_id: entity.publicId,
              trash_batch_id: entity.batchId,
            },
          },
          tx,
        );
      }
      return { batchId };
    }

    // Customer restore: lock user row FIRST (`users -> orders` lock order), then lock customer's orders.
    const [lockedCust] = await tx
      .select({
        id: users.id,
        publicId: users.publicId,
        trashedAt: users.trashedAt,
        trashBatchId: users.trashBatchId,
        purgeStartedAt: users.purgeStartedAt,
        purgedAt: users.purgedAt,
      })
      .from(users)
      .where(and(eq(users.publicId, item.publicId), eq(users.role, "customer")))
      .for("update")
      .limit(1);

    if (!lockedCust || lockedCust.purgedAt) throw notFound("CUSTOMER_NOT_FOUND");

    const ownedOrderIds = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.ownerUserId, lockedCust.id))
      .orderBy(asc(orders.id))
      .limit(MAX_CASCADE_TARGETS + 1);
    if (ownedOrderIds.length > MAX_CASCADE_TARGETS) {
      throw conflict("CASCADE_TOO_LARGE", "This customer account has too many orders to restore at once.");
    }
    if (ownedOrderIds.length > 0) {
      await tx
        .select({ id: orders.id })
        .from(orders)
        .where(inArray(orders.id, ownedOrderIds.map((r) => r.id)))
        .orderBy(asc(orders.id))
        .for("update");
    }
    if (!lockedCust.trashedAt || !lockedCust.trashBatchId) {
      throw conflict("NOT_IN_TRASH", "This customer account is not in the trash.");
    }
    if (lockedCust.purgeStartedAt) {
      throw conflict(
        "PURGE_IN_PROGRESS",
        "Permanent deletion has started for this customer account, so it can no longer be restored.",
      );
    }
    if (item.batchId && lockedCust.trashBatchId !== item.batchId) {
      throw conflict("STALE", "This customer account changed meanwhile. Review again.");
    }
    const batchId = lockedCust.trashBatchId;

    try {
      await idTrash.restoreCustomerInTx(tx, lockedCust.id, { actor, batchId });
      const { entities: orderEntities } = await ordersTrash.restoreOrdersOfBatchInTx(tx, {
        ownerUserId: lockedCust.id,
        batchId,
        actor,
      });
      const customerEntity: TrashEntityRef = {
        kind: "customer",
        id: lockedCust.id,
        publicId: lockedCust.publicId,
        batchId,
      };
      for (const orderEntity of orderEntities) {
        for (const p of participants) {
          if (p.onRestoredInTx) await p.onRestoredInTx(tx, orderEntity, actor);
        }
      }
      for (const p of participants) {
        if (p.onRestoredInTx) await p.onRestoredInTx(tx, customerEntity, actor);
      }
      for (const orderEntity of orderEntities) {
        await deps.audit.record(
          {
            category: "admin",
            eventName: "order.restored",
            action: "restore",
            outcome: "completed",
            severity: "INFO",
            actor: { userId: auditPrincipal.userId, role: auditPrincipal.role },
            resource: { type: "order", id: orderEntity.id, publicId: orderEntity.publicId },
            orderPublicId: orderEntity.publicId,
            correlationId: batchId,
            attributes: {
              order_public_id: orderEntity.publicId,
              customer_public_id: lockedCust.publicId,
              trash_batch_id: batchId,
            },
          },
          tx,
        );
      }
      await deps.audit.record(
        {
          category: "admin",
          eventName: "customer.restored",
          action: "restore",
          outcome: "completed",
          severity: "INFO",
          actor: { userId: auditPrincipal.userId, role: auditPrincipal.role },
          resource: { type: "user", id: lockedCust.id, publicId: lockedCust.publicId },
          correlationId: batchId,
          safeCounts: { cascaded_orders: orderEntities.length },
          attributes: {
            customer_public_id: lockedCust.publicId,
            trash_batch_id: batchId,
            cascaded_orders: orderEntities.length,
          },
        },
        tx,
      );
    } catch (err) {
      throw normalizeRestoreError(err);
    }
    return { batchId };
  }

  /**
   * Executes or resumes one durable, lease-fenced purge run for an order or customer.
   */
  async function executePurgeOne(params: {
    item: TrashItemRef;
    actor: TrashActor;
    auditPrincipal?: SessionPrincipal;
    bulkCount: number;
    expectedSingleConfirmation?: string;
    sweepPublicId?: string;
    acknowledgeUnreachableRunId?: string;
  }): Promise<{ runId: string; batchId: string; keptExternalCopies: number }> {
    const {
      item,
      actor,
      auditPrincipal,
      bulkCount,
      expectedSingleConfirmation,
      sweepPublicId,
      acknowledgeUnreachableRunId,
    } = params;
    const triggerLabel = actor.kind === "user" ? "administrator" : "auto_cleanup";
    const ordersTrash = requireOrdersTrash();
    const idTrash = requireIdentityTrash();

    // Phase 1: Synchronized lock + claim / resume durable run inside TX.
    const claimed = await deps.db.transaction(async (tx) => {
      if (auditPrincipal) {
        await guardActorInTx(tx, auditPrincipal, "trash.purge");
      } else {
        // Scheduled job performs synchronized `FOR SHARE` reads of policy & maintenance under claim (D2.8).
        await shareLockRetentionCohortInTx(tx);
        const retention = await readRetentionValues(tx, true);
        if (!retention.autoPurgeEnabled) {
          throw conflict("AUTO_PURGE_DISABLED", "Automatic clean-up is disabled.");
        }
        const maint = await isMaintenanceBlockingCleanup(tx);
        if (maint) {
          throw conflict("MAINTENANCE_ACTIVE", "Maintenance mode is active.");
        }
      }

      const now = deps.clock.now();
      const nowMs = now.getTime();
      const leaseOwner = ulid(nowMs);

      if (item.kind === "order") {
        // Snapshot lookup of owner user id so we acquire `users` lock BEFORE `orders` lock (`users -> orders`).
        const [preOrder] = await tx
          .select({ id: orders.id, ownerUserId: orders.ownerUserId })
          .from(orders)
          .where(eq(orders.publicId, item.publicId))
          .limit(1);
        if (!preOrder) throw notFound("ORDER_NOT_FOUND");

        const [lockedOwner] = await tx
          .select({
            id: users.id,
            trashedAt: users.trashedAt,
            trashBatchId: users.trashBatchId,
            purgedAt: users.purgedAt,
          })
          .from(users)
          .where(eq(users.id, preOrder.ownerUserId))
          .for("share")
          .limit(1);

        const [lockedPrimary] = await tx
          .select()
          .from(orders)
          .where(eq(orders.id, preOrder.id))
          .for("update")
          .limit(1);

        if (!lockedPrimary) throw notFound("ORDER_NOT_FOUND");
        if (lockedPrimary.purgedAt) {
          const [doneRun] = await tx
            .select()
            .from(trashPurgeRuns)
            .where(
              and(
                eq(trashPurgeRuns.entityKind, "order"),
                eq(trashPurgeRuns.entityId, lockedPrimary.id),
                eq(trashPurgeRuns.status, "completed"),
              ),
            )
            .orderBy(desc(trashPurgeRuns.id))
            .limit(1);
          if (
            doneRun &&
            (!item.batchId || doneRun.batchId === item.batchId) &&
            (!acknowledgeUnreachableRunId || doneRun.publicId === acknowledgeUnreachableRunId)
          ) {
            const c = parseCounts(doneRun.countsJson);
            return {
              alreadyCompleted: true as const,
              runId: doneRun.publicId,
              batchId: doneRun.batchId,
              keptExternalCopies: c.kept.acknowledgedExternalCopies ?? 0,
            };
          }
          throw notFound("ORDER_NOT_FOUND");
        }
        if (!lockedPrimary.trashedAt || !lockedPrimary.trashBatchId) {
          throw conflict("NOT_IN_TRASH", "This order is no longer in the trash.");
        }
        if (lockedPrimary.lockState === "legal_hold") {
          throw legalHoldError();
        }
        if (item.batchId && lockedPrimary.trashBatchId !== item.batchId) {
          throw conflict("STALE", "This order changed meanwhile. Review again.");
        }
        if (
          expectedSingleConfirmation !== undefined &&
          expectedSingleConfirmation.trim() !== lockedPrimary.reference
        ) {
          throw validation(
            "CONFIRMATION_MISMATCH",
            "The confirmation you typed doesn't match. Nothing was deleted.",
          );
        }

        const expectedBatchId = lockedPrimary.trashBatchId;

        // Lock group additions if root order, and lock owner user `FOR SHARE` (`orders -> users`) for retention check.
        let groupAdditions: (typeof orders.$inferSelect)[] = [];
        if (lockedPrimary.groupRootOrderId === null) {
          const addIds = await tx
            .select({ id: orders.id })
            .from(orders)
            .where(
              and(
                eq(orders.groupRootOrderId, lockedPrimary.id),
                eq(orders.trashBatchId, expectedBatchId),
                isNull(orders.purgedAt),
              ),
            )
            .orderBy(asc(orders.id))
            .limit(MAX_CASCADE_TARGETS + 1);
          if (addIds.length > MAX_CASCADE_TARGETS) {
            throw conflict("CASCADE_TOO_LARGE", "This order group has too many additions to delete at once.");
          }
          if (addIds.length > 0) {
            groupAdditions = await tx
              .select()
              .from(orders)
              .where(inArray(orders.id, addIds.map((r) => r.id)))
              .orderBy(asc(orders.id))
              .for("update");
          }
          if (groupAdditions.some((a) => a.lockState === "legal_hold")) {
            throw legalHoldError();
          }
        }

        if (actor.kind === "system") {
          const retention = await readRetentionValues(tx, true);
          const { dueAt, movedWithCustomer } = computeOrderDueAt(
            lockedPrimary.trashedAt,
            expectedBatchId,
            lockedOwner && !lockedOwner.purgedAt
              ? { trashedAt: lockedOwner.trashedAt, trashBatchId: lockedOwner.trashBatchId }
              : undefined,
            retention,
          );
          if (movedWithCustomer || !dueAt || dueAt.getTime() > nowMs) {
            throw conflict("NOT_DUE", "This order is not yet due for automatic clean-up.");
          }
        }

        const [existingRun] = await tx
          .select()
          .from(trashPurgeRuns)
          .where(
            and(
              eq(trashPurgeRuns.entityKind, "order"),
              eq(trashPurgeRuns.entityId, lockedPrimary.id),
              eq(trashPurgeRuns.batchId, expectedBatchId),
            ),
          )
          .orderBy(desc(trashPurgeRuns.id))
          .for("update")
          .limit(1);

        const candidateOrderIds = [
          ...groupAdditions.map((a) => a.id),
          lockedPrimary.id,
        ];
        await assertNoOverlappingActiveRunsInTx(
          tx,
          existingRun?.id ?? null,
          candidateOrderIds,
          [lockedPrimary.ownerUserId],
          nowMs,
        );

        if (existingRun?.status === "completed") {
          const c = parseCounts(existingRun.countsJson);
          return {
            alreadyCompleted: true as const,
            runId: existingRun.publicId,
            batchId: expectedBatchId,
            keptExternalCopies: c.kept.acknowledgedExternalCopies ?? 0,
          };
        }

        if (acknowledgeUnreachableRunId !== undefined) {
          if (
            !existingRun ||
            existingRun.publicId !== acknowledgeUnreachableRunId ||
            existingRun.status !== "failed" ||
            existingRun.errorCode !== "EXTERNAL_COPIES_UNREACHABLE"
          ) {
            throw conflict("STALE", "The failed deletion run changed meanwhile. Review again.");
          }
        }

        if (existingRun) {
          const prevCp = parseCheckpoint(existingRun.checkpointJson);
          if (existingRun.status === "running" && prevCp.leaseExpiresAtMs > nowMs) {
            throw conflict(
              "PURGE_IN_PROGRESS",
              "Permanent deletion has started for this order, so it is already running.",
            );
          }

          const parsedTargets = JSON.parse(existingRun.targetsJson) as PersistedTargetsEnvelope;
          if (acknowledgeUnreachableRunId !== undefined && parsedTargets.targets.length !== 1) {
            throw conflict(
              "ACKNOWLEDGMENT_SINGLE_ORDER_ONLY",
              "Delete add-on orders individually before leaving external copies in place on an order.",
            );
          }
          // Re-verify all persisted order targets are not on legal hold and still match their recorded batch.
          for (const t of parsedTargets.targets) {
            if (t.kind === "order") {
              const [tRow] = await tx
                .select({
                  id: orders.id,
                  lockState: orders.lockState,
                  trashBatchId: orders.trashBatchId,
                  purgedAt: orders.purgedAt,
                })
                .from(orders)
                .where(eq(orders.id, t.id))
                .for("update")
                .limit(1);
              if (!tRow) throw notFound("ORDER_NOT_FOUND");
              if (tRow.lockState === "legal_hold") throw legalHoldError();
              if (!tRow.purgedAt && tRow.trashBatchId !== t.batchId) {
                throw conflict("STALE", "This order changed meanwhile. Review again.");
              }
              if (!tRow.purgedAt) {
                await ordersTrash.markPurgeStartedInTx(tx, {
                  orderId: t.id,
                  runId: existingRun.publicId,
                  actor,
                });
              }
            }
          }

          const parsedCounts = parseCounts(existingRun.countsJson);
          const nextToken = prevCp.fencingToken + 1;
          const nextAck =
            Boolean(acknowledgeUnreachableRunId) && actor.kind === "user" && Boolean(auditPrincipal);
          const nextCp: PersistedCheckpoint = {
            completedSteps: prevCp.completedSteps,
            leaseOwner,
            leaseExpiresAtMs: nowMs + PURGE_LEASE_MS,
            fencingToken: nextToken,
            ...(nextAck ? { acknowledgedUnreachableCopies: true } : {}),
          };

          if (nextAck && auditPrincipal) {
            const connIds = Object.keys(parsedCounts.unreachableByConnection ?? {}).join(",");
            const displayedBlocked = parsedCounts.unreachableTotal ?? 1;
            await deps.audit.record(
              {
                category: "admin",
                eventName: "order.purge_external_left",
                action: "delete",
                outcome: "completed",
                severity: "WARN",
                actor: { userId: auditPrincipal.userId, role: auditPrincipal.role },
                resource: { type: "order", id: lockedPrimary.id, publicId: lockedPrimary.publicId },
                orderPublicId: lockedPrimary.publicId,
                correlationId: expectedBatchId,
                safeCounts: { kept_count: displayedBlocked },
                attributes: {
                  order_public_id: lockedPrimary.publicId,
                  trash_batch_id: expectedBatchId,
                  run_public_id: existingRun.publicId,
                  kept_count: displayedBlocked,
                  ...(connIds ? { connection_public_ids: connIds.slice(0, 120) } : {}),
                },
              },
              tx,
            );
          }

          await tx
            .update(trashPurgeRuns)
            .set({
              status: "running",
              checkpointJson: JSON.stringify(nextCp),
              attemptCount: existingRun.attemptCount + 1,
              errorCode: null,
              failedModule: null,
              finishedAt: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(trashPurgeRuns.id, existingRun.id),
                eq(trashPurgeRuns.attemptCount, existingRun.attemptCount),
              ),
            );

          return {
            alreadyCompleted: false as const,
            runRowId: existingRun.id,
            runId: existingRun.publicId,
            batchId: expectedBatchId,
            leaseOwner,
            fencingToken: nextToken,
            acknowledgeUnreachable: nextAck,
            envelope: parsedTargets,
            checkpoint: nextCp,
            counts: parsedCounts,
          };
        }

        const runId = ulid(nowMs);
        const targets: TrashEntityRef[] = [
          ...groupAdditions
            .filter((a) => a.trashedAt !== null && a.purgedAt === null)
            .map((a) => ({
              kind: "order" as const,
              id: a.id,
              publicId: a.publicId,
              batchId: expectedBatchId,
            })),
          {
            kind: "order" as const,
            id: lockedPrimary.id,
            publicId: lockedPrimary.publicId,
            batchId: expectedBatchId,
          },
        ];

        for (const t of targets) {
          await ordersTrash.markPurgeStartedInTx(tx, { orderId: t.id, runId, actor });
        }

        const envelope: PersistedTargetsEnvelope = {
          targets,
          expectedModules: computeExpectedModules(),
        };
        const checkpoint: PersistedCheckpoint = {
          completedSteps: [],
          leaseOwner,
          leaseExpiresAtMs: nowMs + PURGE_LEASE_MS,
          fencingToken: 1,
        };
        const counts: PersistedCounts = { deleted: {}, kept: {} };

        const [ins] = await tx.insert(trashPurgeRuns).values({
          publicId: runId,
          trigger: actor.kind === "user" ? "manual" : "retention",
          actorUserId: actor.kind === "user" ? actor.userId : null,
          sweepPublicId: sweepPublicId ?? null,
          entityKind: "order",
          entityId: lockedPrimary.id,
          entityPublicId: lockedPrimary.publicId,
          batchId: expectedBatchId,
          status: "running",
          targetsJson: JSON.stringify(envelope),
          checkpointJson: JSON.stringify(checkpoint),
          countsJson: JSON.stringify(counts),
          attemptCount: 1,
          correlationId: expectedBatchId,
          startedAt: now,
          updatedAt: now,
        });

        for (const t of targets) {
          await deps.audit.record(
            {
              category: "admin",
              eventName: "order.purge_started",
              action: "delete",
              outcome: "attempted",
              severity: "WARN",
              actor:
                actor.kind === "user" && auditPrincipal
                  ? { userId: auditPrincipal.userId, role: auditPrincipal.role }
                  : { role: "system" },
              resource: { type: "order", id: t.id, publicId: t.publicId },
              orderPublicId: t.publicId,
              correlationId: t.batchId,
              attributes: {
                order_public_id: t.publicId,
                trash_batch_id: t.batchId,
                run_public_id: runId,
                trigger: triggerLabel,
                bulk_count: bulkCount,
              },
            },
            tx,
          );
        }

        return {
          alreadyCompleted: false as const,
          runRowId: Number(ins.insertId),
          runId,
          batchId: expectedBatchId,
          leaseOwner,
          fencingToken: 1,
          acknowledgeUnreachable: false,
          envelope,
          checkpoint,
          counts,
        };
      }

      // Customer target: lock `users` row FIRST (`users -> orders` lock order), then lock customer's orders `FOR UPDATE`.
      const [lockedCust] = await tx
        .select()
        .from(users)
        .where(and(eq(users.publicId, item.publicId), eq(users.role, "customer")))
        .for("update")
        .limit(1);

      if (!lockedCust) throw notFound("CUSTOMER_NOT_FOUND");

      const ownedOrderIdRows = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(and(eq(orders.ownerUserId, lockedCust.id), isNull(orders.purgedAt)))
        .orderBy(asc(orders.id))
        .limit(MAX_CASCADE_TARGETS + 1);
      if (ownedOrderIdRows.length > MAX_CASCADE_TARGETS) {
        throw conflict("CASCADE_TOO_LARGE", "This customer account has too many orders to delete at once.");
      }

      const lockedCustomerOrders = ownedOrderIdRows.length
        ? await tx
            .select()
            .from(orders)
            .where(inArray(orders.id, ownedOrderIdRows.map((r) => r.id)))
            .orderBy(asc(orders.id))
            .for("update")
        : [];
      if (lockedCust.purgedAt) {
        const [doneRun] = await tx
          .select()
          .from(trashPurgeRuns)
          .where(
            and(
              eq(trashPurgeRuns.entityKind, "customer"),
              eq(trashPurgeRuns.entityId, lockedCust.id),
              eq(trashPurgeRuns.status, "completed"),
            ),
          )
          .orderBy(desc(trashPurgeRuns.id))
          .limit(1);
        if (
          doneRun &&
          (!item.batchId || doneRun.batchId === item.batchId) &&
          (!acknowledgeUnreachableRunId || doneRun.publicId === acknowledgeUnreachableRunId)
        ) {
          const c = parseCounts(doneRun.countsJson);
          return {
            alreadyCompleted: true as const,
            runId: doneRun.publicId,
            batchId: doneRun.batchId,
            keptExternalCopies: c.kept.acknowledgedExternalCopies ?? 0,
          };
        }
        throw notFound("CUSTOMER_NOT_FOUND");
      }
      if (!lockedCust.trashedAt || !lockedCust.trashBatchId) {
        throw conflict("NOT_IN_TRASH", "This customer account is no longer in the trash.");
      }
      if (item.batchId && lockedCust.trashBatchId !== item.batchId) {
        throw conflict("STALE", "This customer account changed meanwhile. Review again.");
      }
      const expectedRef = lockedCust.customerRef ?? lockedCust.publicId;
      if (expectedSingleConfirmation !== undefined && expectedSingleConfirmation.trim() !== expectedRef) {
        throw validation(
          "CONFIRMATION_MISMATCH",
          "The confirmation you typed doesn't match. Nothing was deleted.",
        );
      }

      // Refuse if ANY non-purged order of this customer is on legal hold or is live!
      const nonPurgedOrders = lockedCustomerOrders.filter(
        (o) => o.ownerUserId === lockedCust.id && o.purgedAt === null,
      );
      if (nonPurgedOrders.some((o) => o.lockState === "legal_hold")) {
        throw legalHoldError();
      }
      if (nonPurgedOrders.some((o) => o.trashedAt === null || !o.trashBatchId)) {
        throw conflict(
          "CUSTOMER_HAS_LIVE_ORDERS",
          "Move all live orders of this customer account to the trash before deleting the account permanently.",
        );
      }

      const expectedBatchId = lockedCust.trashBatchId;

      if (actor.kind === "system") {
        const retention = await readRetentionValues(tx, true);
        const dueAt = retention.autoPurgeEnabled
          ? addDays(lockedCust.trashedAt, retention.customerDays)
          : null;
        if (!dueAt || dueAt.getTime() > nowMs) {
          throw conflict("NOT_DUE", "This customer account is not yet due for automatic clean-up.");
        }
      }

      const [existingRun] = await tx
        .select()
        .from(trashPurgeRuns)
        .where(
          and(
            eq(trashPurgeRuns.entityKind, "customer"),
            eq(trashPurgeRuns.entityId, lockedCust.id),
            eq(trashPurgeRuns.batchId, expectedBatchId),
          ),
        )
        .orderBy(desc(trashPurgeRuns.id))
        .for("update")
        .limit(1);

      await assertNoOverlappingActiveRunsInTx(
        tx,
        existingRun?.id ?? null,
        nonPurgedOrders.map((o) => o.id),
        [lockedCust.id],
        nowMs,
      );

      if (existingRun?.status === "completed") {
        const c = parseCounts(existingRun.countsJson);
        return {
          alreadyCompleted: true as const,
          runId: existingRun.publicId,
          batchId: expectedBatchId,
          keptExternalCopies: c.kept.acknowledgedExternalCopies ?? 0,
        };
      }

      if (acknowledgeUnreachableRunId !== undefined) {
        throw conflict(
          "ACKNOWLEDGMENT_SINGLE_ORDER_ONLY",
          "Leave external copies in place on each order individually, typing its order number.",
        );
      }

      if (existingRun) {
        const prevCp = parseCheckpoint(existingRun.checkpointJson);
        if (existingRun.status === "running" && prevCp.leaseExpiresAtMs > nowMs) {
          throw conflict(
            "PURGE_IN_PROGRESS",
            "Permanent deletion has started for this customer account, so it is already running.",
          );
        }

        const parsedTargets = JSON.parse(existingRun.targetsJson) as PersistedTargetsEnvelope;
        for (const t of parsedTargets.targets) {
          if (t.kind === "order") {
            const [tRow] = await tx
              .select({
                id: orders.id,
                lockState: orders.lockState,
                trashBatchId: orders.trashBatchId,
                purgedAt: orders.purgedAt,
              })
              .from(orders)
              .where(eq(orders.id, t.id))
              .for("update")
              .limit(1);
            if (!tRow) throw notFound("ORDER_NOT_FOUND");
            if (tRow.lockState === "legal_hold") throw legalHoldError();
            if (!tRow.purgedAt && tRow.trashBatchId !== t.batchId) {
              throw conflict("STALE", "An order of this customer changed meanwhile. Review again.");
            }
            if (!tRow.purgedAt) {
              await ordersTrash.markPurgeStartedInTx(tx, {
                orderId: t.id,
                runId: existingRun.publicId,
                actor,
              });
            }
          } else {
            await idTrash.markPurgeStartedInTx(tx, t.id, {
              batchId: t.batchId,
              runId: existingRun.publicId,
              actor,
            });
          }
        }

        const parsedCounts = parseCounts(existingRun.countsJson);
        const nextToken = prevCp.fencingToken + 1;
        const nextAck =
          Boolean(acknowledgeUnreachableRunId) && actor.kind === "user" && Boolean(auditPrincipal);
        const nextCp: PersistedCheckpoint = {
          completedSteps: prevCp.completedSteps,
          leaseOwner,
          leaseExpiresAtMs: nowMs + PURGE_LEASE_MS,
          fencingToken: nextToken,
          ...(nextAck ? { acknowledgedUnreachableCopies: true } : {}),
        };

        if (nextAck && auditPrincipal) {
          const connIds = Object.keys(parsedCounts.unreachableByConnection ?? {}).join(",");
          const displayedBlocked = parsedCounts.unreachableTotal ?? 1;
          await deps.audit.record(
            {
              category: "admin",
              eventName: "customer.purge_external_left",
              action: "delete",
              outcome: "completed",
              severity: "WARN",
              actor: { userId: auditPrincipal.userId, role: auditPrincipal.role },
              resource: { type: "user", id: lockedCust.id, publicId: lockedCust.publicId },
              correlationId: expectedBatchId,
              safeCounts: { kept_count: displayedBlocked },
              attributes: {
                customer_public_id: lockedCust.publicId,
                trash_batch_id: expectedBatchId,
                run_public_id: existingRun.publicId,
                kept_count: displayedBlocked,
                ...(connIds ? { connection_public_ids: connIds.slice(0, 120) } : {}),
              },
            },
            tx,
          );
        }

        await tx
          .update(trashPurgeRuns)
          .set({
            status: "running",
            checkpointJson: JSON.stringify(nextCp),
            attemptCount: existingRun.attemptCount + 1,
            errorCode: null,
            failedModule: null,
            finishedAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(trashPurgeRuns.id, existingRun.id),
              eq(trashPurgeRuns.attemptCount, existingRun.attemptCount),
            ),
          );

        return {
          alreadyCompleted: false as const,
          runRowId: existingRun.id,
          runId: existingRun.publicId,
          batchId: expectedBatchId,
          leaseOwner,
          fencingToken: nextToken,
          acknowledgeUnreachable: nextAck,
          envelope: parsedTargets,
          checkpoint: nextCp,
          counts: parsedCounts,
        };
      }

      const runId = ulid(nowMs);
      const targets: TrashEntityRef[] = [
        ...nonPurgedOrders.map((o) => ({
          kind: "order" as const,
          id: o.id,
          publicId: o.publicId,
          batchId: o.trashBatchId!,
        })),
        {
          kind: "customer" as const,
          id: lockedCust.id,
          publicId: lockedCust.publicId,
          batchId: expectedBatchId,
        },
      ];

      for (const ord of nonPurgedOrders) {
        await ordersTrash.markPurgeStartedInTx(tx, { orderId: ord.id, runId, actor });
      }
      await idTrash.markPurgeStartedInTx(tx, lockedCust.id, {
        batchId: expectedBatchId,
        runId,
        actor,
      });

      const envelope: PersistedTargetsEnvelope = {
        targets,
        expectedModules: computeExpectedModules(),
      };
      const checkpoint: PersistedCheckpoint = {
        completedSteps: [],
        leaseOwner,
        leaseExpiresAtMs: nowMs + PURGE_LEASE_MS,
        fencingToken: 1,
      };
      const counts: PersistedCounts = { deleted: {}, kept: {} };

      const [ins] = await tx.insert(trashPurgeRuns).values({
        publicId: runId,
        trigger: actor.kind === "user" ? "manual" : "retention",
        actorUserId: actor.kind === "user" ? actor.userId : null,
        sweepPublicId: sweepPublicId ?? null,
        entityKind: "customer",
        entityId: lockedCust.id,
        entityPublicId: lockedCust.publicId,
        batchId: expectedBatchId,
        status: "running",
        targetsJson: JSON.stringify(envelope),
        checkpointJson: JSON.stringify(checkpoint),
        countsJson: JSON.stringify(counts),
        attemptCount: 1,
        correlationId: expectedBatchId,
        startedAt: now,
        updatedAt: now,
      });

      for (const ord of nonPurgedOrders) {
        await deps.audit.record(
          {
            category: "admin",
            eventName: "order.purge_started",
            action: "delete",
            outcome: "attempted",
            severity: "WARN",
            actor:
              actor.kind === "user" && auditPrincipal
                ? { userId: auditPrincipal.userId, role: auditPrincipal.role }
                : { role: "system" },
            resource: { type: "order", id: ord.id, publicId: ord.publicId },
            orderPublicId: ord.publicId,
            correlationId: expectedBatchId,
            attributes: {
              order_public_id: ord.publicId,
              customer_public_id: lockedCust.publicId,
              trash_batch_id: ord.trashBatchId!,
              run_public_id: runId,
              trigger: triggerLabel,
              bulk_count: bulkCount,
            },
          },
          tx,
        );
      }
      await deps.audit.record(
        {
          category: "admin",
          eventName: "customer.purge_started",
          action: "delete",
          outcome: "attempted",
          severity: "WARN",
          actor:
            actor.kind === "user" && auditPrincipal
              ? { userId: auditPrincipal.userId, role: auditPrincipal.role }
              : { role: "system" },
          resource: { type: "user", id: lockedCust.id, publicId: lockedCust.publicId },
          correlationId: expectedBatchId,
          safeCounts: { cascaded_orders: nonPurgedOrders.length },
          attributes: {
            customer_public_id: lockedCust.publicId,
            trash_batch_id: expectedBatchId,
            run_public_id: runId,
            trigger: triggerLabel,
            bulk_count: bulkCount,
            cascaded_orders: nonPurgedOrders.length,
          },
        },
        tx,
      );

      return {
        alreadyCompleted: false as const,
        runRowId: Number(ins.insertId),
        runId,
        batchId: expectedBatchId,
        leaseOwner,
        fencingToken: 1,
        acknowledgeUnreachable: false,
        envelope,
        checkpoint,
        counts,
      };
    });

    if (claimed.alreadyCompleted) {
      return {
        runId: claimed.runId,
        batchId: claimed.batchId,
        keptExternalCopies: claimed.keptExternalCopies,
      };
    }

    const {
      runRowId,
      runId,
      batchId,
      leaseOwner,
      fencingToken,
      acknowledgeUnreachable,
      envelope,
      checkpoint,
      counts,
    } = claimed;
    const completedSet = new Set<string>(checkpoint.completedSteps);

    async function assertAndWriteCheckpoint(tx?: Tx): Promise<void> {
      const runTx = async (innerTx: Tx) => {
        const [liveRun] = await innerTx
          .select({ status: trashPurgeRuns.status, checkpointJson: trashPurgeRuns.checkpointJson })
          .from(trashPurgeRuns)
          .where(eq(trashPurgeRuns.id, runRowId))
          .for("update")
          .limit(1);
        if (!liveRun || liveRun.status !== "running") {
          throw conflict("PURGE_FENCE_LOST", "Permanent deletion claim was superseded.");
        }
        const liveCp = parseCheckpoint(liveRun.checkpointJson);
        if (liveCp.fencingToken !== fencingToken || liveCp.leaseOwner !== leaseOwner) {
          throw conflict("PURGE_FENCE_LOST", "Permanent deletion claim was superseded.");
        }
        const now = deps.clock.now();
        checkpoint.leaseExpiresAtMs = now.getTime() + PURGE_LEASE_MS;
        await innerTx
          .update(trashPurgeRuns)
          .set({
            checkpointJson: JSON.stringify(checkpoint),
            countsJson: JSON.stringify(counts),
            updatedAt: now,
          })
          .where(eq(trashPurgeRuns.id, runRowId));
      };
      if (tx) await runTx(tx);
      else await deps.db.transaction(runTx);
    }

    try {
      // Phase 2: Fail closed if any expected participant is missing; execute each step & checkpoint under fence.
      const requiredModules = [...new Set([...envelope.expectedModules, ...computeExpectedModules()])];
      const participants = resolveParticipantsOrFail(requiredModules);

      for (const target of envelope.targets) {
        for (const participant of participants) {
          const stepKey = `${target.kind}:${target.id}:${participant.module}`;
          if (completedSet.has(stepKey)) continue;
          if (participant.purge) {
            const passSingleOrderAck =
              acknowledgeUnreachable === true &&
              actor.kind === "user" &&
              envelope.targets.length === 1 &&
              target.kind === "order";
            const res = await participant.purge(target, {
              runId,
              ...(passSingleOrderAck ? { acknowledgedUnreachableCopies: true } : {}),
            });
            mergeCounts(counts.deleted, res.deleted);
            mergeCounts(counts.kept, res.kept);
          }
          completedSet.add(stepKey);
          checkpoint.completedSteps = [...completedSet];
          await assertAndWriteCheckpoint();
        }
      }

      // Phase 3: Under `FOR UPDATE` fence + target locks (`orders -> users`), verify batch generations & legal holds, then write tombstones.
      await deps.db.transaction(async (tx) => {
        const [liveRun] = await tx
          .select({ status: trashPurgeRuns.status, checkpointJson: trashPurgeRuns.checkpointJson })
          .from(trashPurgeRuns)
          .where(eq(trashPurgeRuns.id, runRowId))
          .for("update")
          .limit(1);
        if (!liveRun || liveRun.status !== "running") {
          throw conflict("PURGE_FENCE_LOST", "Permanent deletion claim was superseded.");
        }
        const liveCp = parseCheckpoint(liveRun.checkpointJson);
        if (liveCp.fencingToken !== fencingToken || liveCp.leaseOwner !== leaseOwner) {
          throw conflict("PURGE_FENCE_LOST", "Permanent deletion claim was superseded.");
        }

        const orderTargets = envelope.targets
          .filter((t) => t.kind === "order")
          .sort((a, b) => a.id - b.id);
        const customerTargets = envelope.targets
          .filter((t) => t.kind === "customer")
          .sort((a, b) => a.id - b.id);

        // Lock `users` targets FIRST (`users -> orders` lock order), then lock `orders` targets.
        for (const ct of customerTargets) {
          const [cRow] = await tx
            .select({
              id: users.id,
              trashBatchId: users.trashBatchId,
              purgedAt: users.purgedAt,
            })
            .from(users)
            .where(eq(users.id, ct.id))
            .for("update")
            .limit(1);
          if (!cRow) throw notFound("CUSTOMER_NOT_FOUND");
          if (!cRow.purgedAt && cRow.trashBatchId !== ct.batchId) {
            throw conflict("STALE", "Customer trash generation changed before completion.");
          }
        }

        if (orderTargets.length > 0) {
          const lockedOrders = await tx
            .select({
              id: orders.id,
              lockState: orders.lockState,
              trashBatchId: orders.trashBatchId,
              purgedAt: orders.purgedAt,
            })
            .from(orders)
            .where(inArray(orders.id, orderTargets.map((t) => t.id)))
            .orderBy(asc(orders.id))
            .for("update");
          const byId = new Map(lockedOrders.map((o) => [o.id, o]));
          for (const ot of orderTargets) {
            const row = byId.get(ot.id);
            if (!row) throw notFound("ORDER_NOT_FOUND");
            if (row.lockState === "legal_hold") throw legalHoldError();
            if (!row.purgedAt && row.trashBatchId !== ot.batchId) {
              throw conflict("STALE", "Order trash generation changed before completion.");
            }
          }
        }

        for (const ct of customerTargets) {
          // Verify no new live or legal-hold orders appeared for this customer before tombstoning.
          const [extraOrder] = await tx
            .select({ id: orders.id, lockState: orders.lockState, trashedAt: orders.trashedAt })
            .from(orders)
            .where(
              and(
                eq(orders.ownerUserId, ct.id),
                isNull(orders.purgedAt),
                or(isNull(orders.trashedAt), eq(orders.lockState, "legal_hold")),
              ),
            )
            .for("share")
            .limit(1);
          if (extraOrder?.lockState === "legal_hold") throw legalHoldError();
          if (extraOrder && extraOrder.trashedAt === null) {
            throw conflict(
              "CUSTOMER_HAS_LIVE_ORDERS",
              "Customer owns a live order and cannot be permanently deleted.",
            );
          }
        }

        for (const ot of orderTargets) {
          await ordersTrash.tombstoneOrderInTx(tx, { orderId: ot.id, runId, actor });
          await deps.audit.record(
            {
              category: "admin",
              eventName: "order.purged",
              action: "delete",
              outcome: "completed",
              severity: "WARN",
              actor:
                actor.kind === "user" && auditPrincipal
                  ? { userId: auditPrincipal.userId, role: auditPrincipal.role }
                  : { role: "system" },
              resource: { type: "order", id: ot.id, publicId: ot.publicId },
              orderPublicId: ot.publicId,
              correlationId: batchId,
              safeCounts: safeCountsForAudit(counts.deleted),
              attributes: {
                order_public_id: ot.publicId,
                trash_batch_id: ot.batchId,
                run_public_id: runId,
                trigger: triggerLabel,
              },
            },
            tx,
          );
        }

        for (const ct of customerTargets) {
          const done = await idTrash.tombstoneCustomerInTx(tx, ct.id, { runId, actor });
          mergeCounts(counts.deleted, done.erased);
          await deps.audit.record(
            {
              category: "admin",
              eventName: "customer.purged",
              action: "delete",
              outcome: "completed",
              severity: "WARN",
              actor:
                actor.kind === "user" && auditPrincipal
                  ? { userId: auditPrincipal.userId, role: auditPrincipal.role }
                  : { role: "system" },
              resource: { type: "user", id: ct.id, publicId: ct.publicId },
              correlationId: batchId,
              safeCounts: safeCountsForAudit(counts.deleted),
              attributes: {
                customer_public_id: ct.publicId,
                trash_batch_id: ct.batchId,
                run_public_id: runId,
                trigger: triggerLabel,
              },
            },
            tx,
          );
        }

        delete counts.unreachableByConnection;
        delete counts.unreachableTotal;
        checkpoint.leaseOwner = null;
        checkpoint.leaseExpiresAtMs = 0;

        const finishedAt = deps.clock.now();
        await tx
          .update(trashPurgeRuns)
          .set({
            status: "completed",
            checkpointJson: JSON.stringify(checkpoint),
            countsJson: JSON.stringify(counts),
            errorCode: null,
            failedModule: null,
            finishedAt,
            updatedAt: finishedAt,
          })
          .where(eq(trashPurgeRuns.id, runRowId));
      });

      const opsAlerts = services().opsAlerts;
      if (opsAlerts) {
        await opsAlerts.resolve({ source: "trash", dedupKey: `purge:${runId}` }).catch(() => false);
        const unverified = counts.kept.unverifiedExternalCopies ?? 0;
        if (unverified > 0) {
          await opsAlerts
            .emit({
              source: "trash",
              dedupKey: `purge-unverified-copies:${runId}`,
              severity: "warning",
              code: "TRASH_EXTERNAL_COPIES_UNVERIFIED",
              title: "External storage copies could not be verified after permanent deletion",
              text: `${unverified} historical external storage copy record(s) could not be verified with the remote provider.`,
              orderPublicId: item.kind === "order" ? item.publicId : undefined,
              runPublicId: runId,
              correlationId: batchId,
            })
            .catch((err: unknown) => {
              log.warn("failed to emit unverified external copies alert", { err, runId });
            });
        }
      }

      return {
        runId,
        batchId,
        keptExternalCopies: counts.kept.acknowledgedExternalCopies ?? 0,
      };
    } catch (err) {
      if (err instanceof DomainError && err.reasonCode === "PURGE_FENCE_LOST") {
        throw err;
      }

      const errorCode = err instanceof DomainError ? err.reasonCode : "TRASH_PURGE_FAILED";
      const safeMsg =
        err instanceof DomainError
          ? err.safeMessage.slice(0, 250)
          : "Permanent deletion did not finish cleanly and can be retried.";

      if (err instanceof DomainError && err.reasonCode === "EXTERNAL_COPIES_UNREACHABLE") {
        const parsedUnreachable = parseUnreachableDetails(err);
        counts.unreachableByConnection = parsedUnreachable.byConnection;
        counts.unreachableTotal = parsedUnreachable.total;
      }

      await deps.db
        .transaction(async (tx) => {
          const [liveRun] = await tx
            .select({ status: trashPurgeRuns.status, checkpointJson: trashPurgeRuns.checkpointJson })
            .from(trashPurgeRuns)
            .where(eq(trashPurgeRuns.id, runRowId))
            .for("update")
            .limit(1);
          if (!liveRun || liveRun.status !== "running") return;
          const liveCp = parseCheckpoint(liveRun.checkpointJson);
          if (liveCp.fencingToken !== fencingToken || liveCp.leaseOwner !== leaseOwner) return;
          checkpoint.leaseOwner = null;
          checkpoint.leaseExpiresAtMs = 0;
          const failedAt = deps.clock.now();
          await tx
            .update(trashPurgeRuns)
            .set({
              status: "failed",
              checkpointJson: JSON.stringify(checkpoint),
              countsJson: JSON.stringify(counts),
              errorCode,
              finishedAt: failedAt,
              updatedAt: failedAt,
            })
            .where(eq(trashPurgeRuns.id, runRowId));
        })
        .catch((dbErr: unknown) => {
          log.error("failed to record failed purge run state", { err: dbErr, runId });
        });

      await deps.audit
        .record({
          category: "admin",
          eventName: item.kind === "order" ? "order.purged" : "customer.purged",
          action: "delete",
          outcome: "failed",
          severity: "WARN",
          reasonCode: errorCode,
          actor:
            actor.kind === "user" && auditPrincipal
              ? { userId: auditPrincipal.userId, role: auditPrincipal.role }
              : { role: "system" },
          resource:
            item.kind === "order"
              ? { type: "order", publicId: item.publicId }
              : { type: "user", publicId: item.publicId },
          orderPublicId: item.kind === "order" ? item.publicId : undefined,
          correlationId: batchId,
          attributes: {
            ...(item.kind === "order"
              ? { order_public_id: item.publicId }
              : { customer_public_id: item.publicId }),
            trash_batch_id: batchId,
            run_public_id: runId,
            reason_code: errorCode,
            trigger: triggerLabel,
          },
        })
        .catch((auditErr: unknown) => {
          log.error("failed to record purge failure audit event", { err: auditErr, runId });
        });

      const opsAlerts = services().opsAlerts;
      if (opsAlerts) {
        await opsAlerts
          .emit({
            source: "trash",
            dedupKey: `purge:${runId}`,
            severity: "error",
            code: errorCode,
            title:
              errorCode === "EXTERNAL_COPIES_UNREACHABLE"
                ? "External storage destination unreachable during permanent deletion"
                : "Trash permanent deletion needs attention",
            text: safeMsg,
            orderPublicId: item.kind === "order" ? item.publicId : undefined,
            runPublicId: runId,
            correlationId: batchId,
          })
          .catch((alertErr: unknown) => {
            log.error("failed to emit ops alert for failed purge", { err: alertErr, runId });
          });
      }

      if (err instanceof DomainError) throw err;
      throw unavailable("TRASH_PURGE_FAILED", safeMsg);
    }
  }

  const service: TrashService = {
    register: registry.register,
    participants: registry.participants,

    init() {
      const registered = registry.participants().map((p) => p.module);
      if (options.expectedParticipants) {
        initializedExpectedModules = new Set(options.expectedParticipants);
      } else if (Array.isArray(services().allModules)) {
        initializedExpectedModules = new Set([...EXPECTED_CONTAINER_PARTICIPANTS, ...registered]);
      } else {
        initializedExpectedModules = new Set(registered);
      }
    },

    async list(principal, input): Promise<TrashListOutput> {
      await guardRead(principal);
      const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
      const sort = input.sort ?? "movedAt";
      const dir = input.dir ?? "desc";
      const movedFrom = parseOptionalDate(input.movedFrom);
      const movedTo = parseOptionalEndDate(input.movedTo);

      let movedByUserId: number | undefined;
      if (input.movedByPublicId) {
        const [staffRow] = await deps.db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.publicId, input.movedByPublicId))
          .limit(1);
        if (!staffRow) return { items: [], nextCursor: null, total: 0 };
        movedByUserId = staffRow.id;
      }

      const retention = await readRetentionValues();
      const nowMs = deps.clock.now().getTime();
      const dueHorizonMs =
        input.dueWithinDays !== undefined ? nowMs + input.dueWithinDays * DAY_MS : undefined;

      let allRows: TrashRow[] = [];

      if (input.kind === "order") {
        const orderItems = await collectFilteredTrashedOrders({
          q: input.q,
          from: movedFrom,
          to: movedTo,
          trashedByUserId: movedByUserId,
        });
        const ownerIds = [...new Set(orderItems.map((o) => o.ownerUserId))];
        const staffIds = orderItems
          .map((o) => o.trashedByUserId)
          .filter((id): id is number => id !== null);

        const [ownerMap, staffMap, runStatusMap] = await Promise.all([
          loadCustomerTrashMetaChunked(ownerIds),
          resolveStaffNamesByIds(staffIds),
          latestPurgeRunsByEntity("order", orderItems.map((o) => o.id)),
        ]);

        for (const ord of orderItems) {
          const batchId = ord.batchId ?? "";
          const ownerMeta = ownerMap.get(ord.ownerUserId);
          const { dueAt } = computeOrderDueAt(ord.trashedAt, batchId, ownerMeta, retention);
          if (dueHorizonMs !== undefined) {
            if (!dueAt || dueAt.getTime() > dueHorizonMs) continue;
          }

          const latestRun = runStatusMap.get(ord.id);
          let state: TrashRow["state"] = "in_trash";
          let failureCode: string | null = null;
          let unreachableExternalCopies: number | null = null;
          let failedRunId: string | null = null;

          if (ord.purgeStartedAt) {
            const cp = latestRun ? parseCheckpoint(latestRun.checkpointJson) : null;
            const activelyRunning = latestRun?.status === "running" && (cp?.leaseExpiresAtMs ?? 0) > nowMs;
            if (!activelyRunning && latestRun && latestRun.status === "failed") {
              state = "failed";
              failureCode = latestRun.errorCode ?? "TRASH_PURGE_FAILED";
              failedRunId = latestRun.publicId;
              if (failureCode === "EXTERNAL_COPIES_UNREACHABLE") {
                try {
                  const env = JSON.parse(latestRun.targetsJson) as PersistedTargetsEnvelope;
                  if (env.targets.length === 1) {
                    const c = parseCounts(latestRun.countsJson);
                    unreachableExternalCopies = c.unreachableTotal ?? 1;
                  }
                } catch {
                  // Only expose single-order acknowledgment when target envelope is valid.
                }
              }
            } else {
              state = "deleting";
            }
          }

          let canRestore = true;
          let restoreBlockedReason: string | null = null;
          if (ord.purgeStartedAt) {
            canRestore = false;
            restoreBlockedReason = "PURGE_IN_PROGRESS";
          } else if (ownerMeta?.trashedAt) {
            canRestore = false;
            restoreBlockedReason = "OWNER_IN_TRASH";
          } else if (ord.groupRootTrashed) {
            canRestore = false;
            restoreBlockedReason = "ROOT_IN_TRASH";
          }

          allRows.push({
            kind: "order",
            publicId: ord.publicId,
            label: `${ord.reference} — ${ord.projectName}`,
            reference: ord.reference,
            ownerCustomerId: ownerMeta?.customerRef ?? ownerMeta?.publicId ?? null,
            movedBy: ord.trashedByUserId ? (staffMap.get(ord.trashedByUserId) ?? null) : null,
            movedAt: ord.trashedAt,
            reason: ord.reason,
            dueAt,
            state,
            batchId,
            failureCode,
            unreachableExternalCopies,
            failedRunId,
            canRestore,
            restoreBlockedReason,
          });
        }
      } else {
        const custItems = await collectFilteredTrashedCustomers({
          q: input.q,
          from: movedFrom,
          to: movedTo,
          movedBy: input.movedByPublicId,
        });
        const staffIds = custItems
          .map((c) => c.trashedByUserId)
          .filter((id): id is number => id !== null);
        const [staffMap, runStatusMap] = await Promise.all([
          resolveStaffNamesByIds(staffIds),
          latestPurgeRunsByEntity("customer", custItems.map((c) => c.id)),
        ]);

        for (const cust of custItems) {
          const dueAt = retention.autoPurgeEnabled
            ? addDays(cust.trashedAt, retention.customerDays)
            : null;
          if (dueHorizonMs !== undefined) {
            if (!dueAt || dueAt.getTime() > dueHorizonMs) continue;
          }

          const latestRun = runStatusMap.get(cust.id);
          let state: TrashRow["state"] = "in_trash";
          let failureCode: string | null = null;
          const unreachableExternalCopies: number | null = null;
          let failedRunId: string | null = null;

          if (cust.purgeStartedAt) {
            const cp = latestRun ? parseCheckpoint(latestRun.checkpointJson) : null;
            const activelyRunning = latestRun?.status === "running" && (cp?.leaseExpiresAtMs ?? 0) > nowMs;
            if (!activelyRunning && latestRun && latestRun.status === "failed") {
              state = "failed";
              failureCode = latestRun.errorCode ?? "TRASH_PURGE_FAILED";
              failedRunId = latestRun.publicId;
            } else {
              state = "deleting";
            }
          }

          const ref = cust.customerRef ?? cust.publicId;
          allRows.push({
            kind: "customer",
            publicId: cust.publicId,
            label: ref,
            reference: ref,
            ownerCustomerId: null,
            movedBy: cust.trashedByUserId ? (staffMap.get(cust.trashedByUserId) ?? null) : null,
            movedAt: cust.trashedAt,
            reason: cust.reason,
            dueAt,
            state,
            batchId: cust.batchId ?? "",
            failureCode,
            unreachableExternalCopies,
            failedRunId,
            canRestore: cust.purgeStartedAt === null,
            restoreBlockedReason: cust.purgeStartedAt ? "PURGE_IN_PROGRESS" : null,
          });
        }
      }

      allRows = [...allRows].sort((a, b) => {
        const av =
          sort === "dueAt"
            ? (a.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER)
            : a.movedAt.getTime();
        const bv =
          sort === "dueAt"
            ? (b.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER)
            : b.movedAt.getTime();
        if (av !== bv) return dir === "asc" ? av - bv : bv - av;
        return dir === "asc"
          ? a.publicId.localeCompare(b.publicId)
          : b.publicId.localeCompare(a.publicId);
      });

      const total = allRows.length;
      let startIdx = 0;
      if (input.cursor) {
        const idx = allRows.findIndex((r) => r.publicId === input.cursor);
        startIdx = idx >= 0 ? idx + 1 : total;
      }
      const slice = allRows.slice(startIdx, startIdx + limit);
      const nextCursor =
        startIdx + limit < total && slice.length > 0 ? slice[slice.length - 1]!.publicId : null;

      return { items: slice, nextCursor, total };
    },

    async counts(principal): Promise<TrashCounts> {
      await guardRead(principal);
      const retention = await readRetentionValues();
      const snap = await exactCountsAtHorizon(retention, 7 * DAY_MS);
      return {
        orders: snap.ordersTotal,
        customers: snap.customersTotal,
        dueWithin7d: snap.dueTotal,
      };
    },

    async movedByOptions(principal): Promise<TrashPerson[]> {
      await guardRead(principal);
      const [ordStaff, custStaff] = await Promise.all([
        deps.db
          .selectDistinct({ userId: orders.trashedByUserId })
          .from(orders)
          .where(and(isNotNull(orders.trashedAt), isNull(orders.purgedAt), isNotNull(orders.trashedByUserId))),
        deps.db
          .selectDistinct({ userId: users.trashedByUserId })
          .from(users)
          .where(
            and(
              eq(users.role, "customer"),
              isNotNull(users.trashedAt),
              isNull(users.purgedAt),
              isNotNull(users.trashedByUserId),
            ),
          ),
      ]);
      const ids = [
        ...ordStaff.map((r) => r.userId),
        ...custStaff.map((r) => r.userId),
      ].filter((id): id is number => id !== null);
      const map = await resolveStaffNamesByIds(ids);
      return [...map.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
    },

    async summarize(principal, input): Promise<TrashSummary> {
      await guardRead(principal);
      const ordersTrash = requireOrdersTrash();
      const idTrash = requireIdentityTrash();
      const retention = await readRetentionValues();
      const now = deps.clock.now();
      const participants = registry.participants();
      const counts: Record<string, number> = {};

      if (input.kind === "order") {
        const ref = await ordersTrash.trashRefInTx(deps.db, input.publicId);
        if (!ref || ref.purgedAt) throw notFound("ORDER_NOT_FOUND");

        const effectiveBatch = ref.batchId ?? "preview";
        const targets: TrashEntityRef[] = [
          { kind: "order", id: ref.id, publicId: ref.publicId, batchId: effectiveBatch },
        ];
        let cascadedOrders = 0;
        if (ref.groupRootOrderId === null) {
          if (ref.batchId) {
            const batchOrders = await ordersTrash.ordersInBatchInTx(deps.db, ref.batchId);
            const additions = batchOrders.filter((o) => o.groupRootOrderId === ref.id && !o.purgedAt);
            cascadedOrders = additions.length;
            for (const add of additions) {
              targets.push({ kind: "order", id: add.id, publicId: add.publicId, batchId: effectiveBatch });
            }
          } else {
            const liveAdditions = await deps.db
              .select({ id: orders.id, publicId: orders.publicId })
              .from(orders)
              .where(
                and(
                  eq(orders.groupRootOrderId, ref.id),
                  isNull(orders.trashedAt),
                  isNull(orders.purgedAt),
                ),
              )
              .limit(MAX_CASCADE_TARGETS + 1);
            if (liveAdditions.length > MAX_CASCADE_TARGETS) {
              throw conflict("CASCADE_TOO_LARGE", "This order group has too many additions.");
            }
            cascadedOrders = liveAdditions.length;
            for (const add of liveAdditions) {
              targets.push({ kind: "order", id: add.id, publicId: add.publicId, batchId: effectiveBatch });
            }
          }
        }

        for (const t of targets) {
          for (const p of participants) {
            if (p.summarize) {
              mergeCounts(counts, await p.summarize(t));
            }
          }
        }

        const ownerMap = await idTrash.getCustomerTrashMetaByIds([ref.ownerUserId]);
        const dueAt =
          ref.trashedAt && ref.batchId
            ? computeOrderDueAt(ref.trashedAt, ref.batchId, ownerMap.get(ref.ownerUserId), retention).dueAt
            : retention.autoPurgeEnabled
              ? addDays(now, retention.orderDays)
              : null;

        const hasPayments =
          (counts.paidInvoices ?? 0) > 0 ||
          (counts.receipts ?? 0) > 0 ||
          (counts.paymentAttempts ?? 0) > 0 ||
          (counts.payments ?? 0) > 0;

        return {
          counts,
          dueAt,
          hasPayments,
          cascadedOrders,
          autoPurgeEnabled: retention.autoPurgeEnabled,
        };
      }

      const cust = await idTrash.resolveCustomerInTx(deps.db, input.publicId);
      if (!cust || cust.purgedAt) throw notFound("CUSTOMER_NOT_FOUND");

      const effectiveBatch = cust.trashBatchId ?? "preview";
      const custOrders = await ordersTrash.ordersOfCustomerInTx(deps.db, cust.id, {
        state: cust.trashedAt ? "trashed" : "live",
      });
      const cascadedOrders = cust.trashedAt
        ? custOrders.filter((o) => o.batchId === cust.trashBatchId).length
        : custOrders.length;

      if (cascadedOrders > 0) {
        counts.orders = cascadedOrders;
      }

      for (const ord of custOrders) {
        const ordRef: TrashEntityRef = {
          kind: "order",
          id: ord.id,
          publicId: ord.publicId,
          batchId: ord.batchId || effectiveBatch,
        };
        for (const p of participants) {
          if (p.summarize) {
            mergeCounts(counts, await p.summarize(ordRef));
          }
        }
      }

      const custEntity: TrashEntityRef = {
        kind: "customer",
        id: cust.id,
        publicId: cust.publicId,
        batchId: effectiveBatch,
      };
      for (const p of participants) {
        if (p.summarize) {
          mergeCounts(counts, await p.summarize(custEntity));
        }
      }

      const dueAt = retention.autoPurgeEnabled
        ? addDays(cust.trashedAt ?? now, retention.customerDays)
        : null;
      const hasPayments =
        (counts.paidInvoices ?? 0) > 0 ||
        (counts.receipts ?? 0) > 0 ||
        (counts.paymentAttempts ?? 0) > 0 ||
        (counts.payments ?? 0) > 0;

      return {
        counts,
        dueAt,
        hasPayments,
        cascadedOrders,
        autoPurgeEnabled: retention.autoPurgeEnabled,
      };
    },

    async moveToTrash(principal, input): Promise<TrashMoveOutput> {
      const reason = cleanReason(input.reason);
      const fingerprintHash = keyHash(
        `trash.fp:move:${JSON.stringify({ kind: input.kind, publicId: input.publicId, reason })}`,
      );
      const ordersTrash = requireOrdersTrash();
      const idTrash = requireIdentityTrash();

      const reservation = await reserveIdempotency<{
        batchId: string;
        dueAtIso: string | null;
        cascadedOrders: number;
      }>({
        principal,
        capability: "trash.manage",
        operation: "move_to_trash",
        idempotencyKey: input.idempotencyKey,
        fingerprintHash,
        verifyBatchGenerations: true,
      });
      if (reservation.hit) {
        return {
          batchId: reservation.payload.batchId,
          dueAt: reservation.payload.dueAtIso ? new Date(reservation.payload.dueAtIso) : null,
          cascadedOrders: reservation.payload.cascadedOrders,
        };
      }

      try {
        return await deps.db.transaction(async (tx) => {
          await guardActorInTx(tx, principal, "trash.manage");
          await shareLockRetentionCohortInTx(tx);

          const now = deps.clock.now();
          const batchId = ulid(now.getTime());
          const actor: TrashActor = {
            kind: "user",
            userId: principal.userId,
            publicId: principal.userPublicId,
            sessionId: principal.sessionId,
          };
          const participants = registry.participants();
          const retention = await readRetentionValues(tx, true);

          if (input.kind === "order") {
            const { entities } = await ordersTrash.trashOrderInTx(tx, {
              orderPublicId: input.publicId,
              batchId,
              actor,
              reason,
            });

            for (const entity of entities) {
              for (const p of participants) {
                if (p.onTrashedInTx) await p.onTrashedInTx(tx, entity, actor);
              }
              await deps.audit.record(
                {
                  category: "admin",
                  eventName: "order.trashed",
                  action: "transition",
                  outcome: "completed",
                  severity: "INFO",
                  actor: { userId: principal.userId, role: principal.role },
                  resource: { type: "order", id: entity.id, publicId: entity.publicId },
                  orderPublicId: entity.publicId,
                  correlationId: entity.batchId,
                  attributes: {
                    order_public_id: entity.publicId,
                    trash_batch_id: entity.batchId,
                    reason_present: reason !== null,
                  },
                },
                tx,
              );
            }

            const effectiveBatchId = entities[0]?.batchId ?? batchId;
            const dueAt = retention.autoPurgeEnabled ? addDays(now, retention.orderDays) : null;
            const cascadedOrders = Math.max(0, entities.length - 1);
            await completeIdempotency(
              reservation.rowId,
              fingerprintHash,
              { [`order:${input.publicId}`]: effectiveBatchId },
              {
                batchId: effectiveBatchId,
                dueAtIso: dueAt ? dueAt.toISOString() : null,
                cascadedOrders,
              },
              tx,
            );
            return { batchId: effectiveBatchId, dueAt, cascadedOrders };
          }

          // Customer move-to-trash: lock `users` row FIRST via `trashCustomerInTx` (`users -> orders` lock order),
          // then check legal holds & trash customer's orders (transaction rolls back atomically on legal hold).
          const cust = await idTrash.resolveCustomerInTx(tx, input.publicId);
          if (!cust || cust.purgedAt) throw notFound("CUSTOMER_NOT_FOUND");
          if (cust.trashedAt) {
            throw conflict("ALREADY_IN_TRASH", "This customer account is already in the trash.");
          }

          await idTrash.trashCustomerInTx(tx, cust.id, { actor, batchId, reason });
          await assertCustomerHasNoLegalHoldInTx(tx, cust.id);
          const { entities: orderEntities } = await ordersTrash.trashOrdersOfCustomerInTx(tx, {
            ownerUserId: cust.id,
            batchId,
            actor,
            reason,
          });

          const customerEntity: TrashEntityRef = {
            kind: "customer",
            id: cust.id,
            publicId: cust.publicId,
            batchId,
          };

          for (const ordEntity of orderEntities) {
            for (const p of participants) {
              if (p.onTrashedInTx) await p.onTrashedInTx(tx, ordEntity, actor);
            }
            await deps.audit.record(
              {
                category: "admin",
                eventName: "order.trashed",
                action: "transition",
                outcome: "completed",
                severity: "INFO",
                actor: { userId: principal.userId, role: principal.role },
                resource: { type: "order", id: ordEntity.id, publicId: ordEntity.publicId },
                orderPublicId: ordEntity.publicId,
                correlationId: batchId,
                attributes: {
                  order_public_id: ordEntity.publicId,
                  customer_public_id: cust.publicId,
                  trash_batch_id: batchId,
                  reason_present: reason !== null,
                },
              },
              tx,
            );
          }

          for (const p of participants) {
            if (p.onTrashedInTx) await p.onTrashedInTx(tx, customerEntity, actor);
          }

          await deps.audit.record(
            {
              category: "admin",
              eventName: "customer.trashed",
              action: "transition",
              outcome: "completed",
              severity: "INFO",
              actor: { userId: principal.userId, role: principal.role },
              resource: { type: "user", id: cust.id, publicId: cust.publicId },
              correlationId: batchId,
              safeCounts: { cascaded_orders: orderEntities.length },
              attributes: {
                customer_public_id: cust.publicId,
                trash_batch_id: batchId,
                reason_present: reason !== null,
                cascaded_orders: orderEntities.length,
              },
            },
            tx,
          );

          const dueAt = retention.autoPurgeEnabled ? addDays(now, retention.customerDays) : null;
          const cascadedOrders = orderEntities.length;
          await completeIdempotency(
            reservation.rowId,
            fingerprintHash,
            { [`customer:${input.publicId}`]: batchId },
            {
              batchId,
              dueAtIso: dueAt ? dueAt.toISOString() : null,
              cascadedOrders,
            },
            tx,
          );
          return { batchId, dueAt, cascadedOrders };
        });
      } catch (err) {
        await releaseUnmutatedIdempotency(reservation.rowId);
        throw err;
      }
    },

    async restore(principal, input): Promise<TrashRestoreOutput> {
      assertUniqueItems(input.items);
      const fingerprintHash = keyHash(
        `trash.fp:restore:${JSON.stringify(
          input.items.map((i) => ({ kind: i.kind, publicId: i.publicId, batchId: i.batchId ?? null })),
        )}`,
      );

      const reservation = await reserveIdempotency<TrashRestoreOutput>({
        principal,
        capability: "trash.manage",
        operation: "restore",
        idempotencyKey: input.idempotencyKey,
        fingerprintHash,
        verifyBatchGenerations: true,
      });
      if (reservation.hit) return reservation.payload;

      const actor: TrashActor = {
        kind: "user",
        userId: principal.userId,
        publicId: principal.userPublicId,
        sessionId: principal.sessionId,
      };
      const single = input.items.length === 1;
      const results: TrashItemResult[] = [];
      const batchBindings: Record<string, string | null> = {};
      let restored = 0;

      try {
        for (const item of input.items) {
          try {
            const one = await deps.db.transaction(async (tx) => {
              await guardActorInTx(tx, principal, "trash.manage");
              return restoreSingleInTx(tx, item, actor, principal);
            });
            restored += 1;
            batchBindings[`${item.kind}:${item.publicId}`] = one.batchId;
            results.push({ ...item, ok: true });
          } catch (err) {
            const normalized = normalizeRestoreError(err);
            if (
              normalized.reasonCode === "RESTORE_CONFLICT" ||
              normalized.reasonCode === "OWNER_IN_TRASH" ||
              normalized.reasonCode === "ROOT_IN_TRASH" ||
              normalized.reasonCode === "PURGE_IN_PROGRESS"
            ) {
              await deps.audit
                .record({
                  category: "admin",
                  eventName: item.kind === "order" ? "order.restored" : "customer.restored",
                  action: "restore",
                  outcome: "refused",
                  severity: "INFO",
                  reasonCode: normalized.reasonCode,
                  actor: { userId: principal.userId, role: principal.role },
                  resource:
                    item.kind === "order"
                      ? { type: "order", publicId: item.publicId }
                      : { type: "user", publicId: item.publicId },
                  orderPublicId: item.kind === "order" ? item.publicId : undefined,
                  ...(item.batchId ? { correlationId: item.batchId } : {}),
                  attributes: {
                    ...(item.kind === "order"
                      ? { order_public_id: item.publicId }
                      : { customer_public_id: item.publicId }),
                    ...(item.batchId ? { trash_batch_id: item.batchId } : {}),
                    reason_code: normalized.reasonCode,
                  },
                })
                .catch(() => undefined);
            }
            if (single) throw normalized;
            results.push({
              ...item,
              ok: false,
              reasonCode: normalized.reasonCode,
              safeMessage: normalized.safeMessage,
            });
          }
        }
      } catch (err) {
        await releaseUnmutatedIdempotency(reservation.rowId);
        throw err;
      }

      const output: TrashRestoreOutput = { restored, results };
      await completeIdempotency(reservation.rowId, fingerprintHash, batchBindings, output);
      return output;
    },

    async purge(principal, input): Promise<TrashPurgeOutput> {
      assertUniqueItems(input.items);
      const single = input.items.length === 1;
      const trimmedConfirmation = input.confirmation.trim();
      if (!single && trimmedConfirmation !== `DELETE ${input.items.length}`) {
        throw validation(
          "CONFIRMATION_MISMATCH",
          "The confirmation you typed doesn't match. Nothing was deleted.",
        );
      }

      const fingerprintHash = keyHash(
        `trash.fp:purge:${JSON.stringify({
          items: input.items.map((i) => ({ kind: i.kind, publicId: i.publicId, batchId: i.batchId ?? null })),
          confirmation: trimmedConfirmation,
        })}`,
      );

      const reservation = await reserveIdempotency<TrashPurgeOutput>({
        principal,
        capability: "trash.purge",
        operation: "purge",
        idempotencyKey: input.idempotencyKey,
        fingerprintHash,
        verifyBatchGenerations: true,
      });
      if (reservation.hit) return reservation.payload;

      const actor: TrashActor = {
        kind: "user",
        userId: principal.userId,
        publicId: principal.userPublicId,
        sessionId: principal.sessionId,
      };
      const runIds: string[] = [];
      const results: TrashItemResult[] = [];
      const batchBindings: Record<string, string | null> = {};

      try {
        for (const item of input.items) {
          try {
            const done = await executePurgeOne({
              item,
              actor,
              auditPrincipal: principal,
              bulkCount: input.items.length,
              expectedSingleConfirmation: single ? trimmedConfirmation : undefined,
            });
            runIds.push(done.runId);
            batchBindings[`${item.kind}:${item.publicId}`] = done.batchId;
            results.push({ ...item, ok: true, runId: done.runId });
          } catch (err) {
            if (single) throw err;
            const domErr = err instanceof DomainError ? err : unavailable("TRASH_PURGE_FAILED");
            results.push({
              ...item,
              ok: false,
              reasonCode: domErr.reasonCode,
              safeMessage: domErr.safeMessage,
            });
          }
        }
      } catch (err) {
        await releaseUnmutatedIdempotency(reservation.rowId);
        throw err;
      }

      const output: TrashPurgeOutput = { runIds, results };
      await completeIdempotency(reservation.rowId, fingerprintHash, batchBindings, output);
      return output;
    },

    async finishLeavingExternalCopies(
      principal,
      input: TrashFinishLeavingExternalInput,
    ): Promise<TrashFinishLeavingExternalOutput> {
      if (input.kind !== "order") {
        throw conflict(
          "ACKNOWLEDGMENT_SINGLE_ORDER_ONLY",
          "Leave external copies in place on each order individually, typing its order number.",
        );
      }
      const trimmedConfirmation = input.confirmation.trim();
      const fingerprintHash = keyHash(
        `trash.fp:finish_external:${JSON.stringify({
          kind: input.kind,
          publicId: input.publicId,
          batchId: input.batchId ?? null,
          runId: input.runId,
          confirmation: trimmedConfirmation,
        })}`,
      );

      const reservation = await reserveIdempotency<TrashFinishLeavingExternalOutput>({
        principal,
        capability: "trash.purge",
        operation: "finish_leaving_external_copies",
        idempotencyKey: input.idempotencyKey,
        fingerprintHash,
        verifyBatchGenerations: true,
      });
      if (reservation.hit) return reservation.payload;

      const actor: TrashActor = {
        kind: "user",
        userId: principal.userId,
        publicId: principal.userPublicId,
        sessionId: principal.sessionId,
      };

      try {
        const done = await executePurgeOne({
          item: { kind: input.kind, publicId: input.publicId, batchId: input.batchId },
          actor,
          auditPrincipal: principal,
          bulkCount: 1,
          expectedSingleConfirmation: trimmedConfirmation,
          acknowledgeUnreachableRunId: input.runId,
        });
        const output: TrashFinishLeavingExternalOutput = {
          ok: true,
          runId: done.runId,
          keptExternalCopies: done.keptExternalCopies,
        };
        await completeIdempotency(
          reservation.rowId,
          fingerprintHash,
          { [`${input.kind}:${input.publicId}`]: done.batchId },
          output,
        );
        return output;
      } catch (err) {
        await releaseUnmutatedIdempotency(reservation.rowId);
        throw err;
      }
    },

    async getSettings(principal): Promise<TrashSettings> {
      await guardRead(principal);
      return buildSettingsView();
    },

    async previewSettings(principal, input): Promise<TrashSettingsPreview> {
      await guardRead(principal);
      const proposed = validateRetentionValues(input);
      return deps.db.transaction(async (tx) => {
        const version = await shareLockRetentionCohortInTx(tx);
        const current = await readRetentionValues(tx, true);
        const { becomeDue, shorteningOrEnabling } = await computeExactNewlyBecomingDueCount(
          current,
          proposed,
          tx,
          true,
        );
        const requiresConfirmation = shorteningOrEnabling && becomeDue > 0;
        return {
          becomeDue,
          requiresConfirmation,
          confirmationPhrase: requiresConfirmation ? `DELETE ${becomeDue}` : null,
          version,
        };
      });
    },

    async updateSettings(principal, input): Promise<TrashSettings> {
      const proposed = validateRetentionValues(input);
      const fingerprintHash = keyHash(
        `trash.fp:settings:${JSON.stringify({
          ...proposed,
          expectedVersion: input.expectedVersion,
          reviewedDueCount: input.reviewedDueCount ?? null,
          confirmation: input.confirmation?.trim() ?? null,
        })}`,
      );

      const reservation = await reserveIdempotency<{ savedVersion: number }>({
        principal,
        capability: "trash.retention.manage",
        operation: "settings_update",
        idempotencyKey: input.idempotencyKey,
        fingerprintHash,
        verifyBatchGenerations: false,
      });
      if (reservation.hit) {
        return buildSettingsView();
      }

      try {
        await deps.db.transaction(async (tx) => {
          await guardActorInTx(tx, principal, "trash.retention.manage");
          const currentVersion = await exclusiveLockRetentionVersionInTx(tx);
          if (input.expectedVersion !== currentVersion) {
            throw conflict("STALE", "The settings or the number of items due changed meanwhile. Review again.");
          }

          const current = await readRetentionValues(tx, true);
          const { becomeDue, shorteningOrEnabling } = await computeExactNewlyBecomingDueCount(
            current,
            proposed,
            tx,
            true,
          );

          if (shorteningOrEnabling) {
            if (becomeDue > 0) {
              if (input.reviewedDueCount === undefined || input.reviewedDueCount !== becomeDue) {
                throw conflict(
                  "STALE",
                  "The settings or the number of items due changed meanwhile. Review again.",
                );
              }
              if ((input.confirmation ?? "").trim() !== `DELETE ${becomeDue}`) {
                throw validation(
                  "CONFIRMATION_MISMATCH",
                  "The confirmation you typed doesn't match. Nothing was changed.",
                );
              }
            } else if (input.reviewedDueCount !== undefined && input.reviewedDueCount !== 0) {
              throw conflict(
                "STALE",
                "The settings or the number of items due changed meanwhile. Review again.",
              );
            }
          }

          const nextVersion = currentVersion + 1;
          await deps.settings.set(TRASH_AUTO_PURGE_ENABLED.key, proposed.autoPurgeEnabled, tx);
          await deps.settings.set(TRASH_RETENTION_ORDER_DAYS.key, proposed.orderDays, tx);
          await deps.settings.set(TRASH_RETENTION_CUSTOMER_DAYS.key, proposed.customerDays, tx);
          await tx
            .update(trashRetentionState)
            .set({
              version: nextVersion,
              updatedByUserId: principal.userId,
              updatedAt: deps.clock.now(),
            })
            .where(eq(trashRetentionState.singletonKey, 1));

          await deps.audit.record(
            {
              category: "admin",
              eventName: "trash.retention_changed",
              action: "update",
              outcome: "completed",
              severity: shorteningOrEnabling ? "WARN" : "INFO",
              actor: { userId: principal.userId, role: principal.role },
              resource: { type: "setting", id: "trash.retention", publicId: "trash.retention" },
              attributes: {
                auto_purge_enabled: proposed.autoPurgeEnabled,
                order_days: proposed.orderDays,
                customer_days: proposed.customerDays,
                from_auto_purge_enabled: current.autoPurgeEnabled,
                from_order_days: current.orderDays,
                from_customer_days: current.customerDays,
                reviewed_due_count: becomeDue,
                settings_version: nextVersion,
              },
            },
            tx,
          );

          await completeIdempotency(
            reservation.rowId,
            fingerprintHash,
            {},
            { savedVersion: nextVersion },
            tx,
          );
        });
      } catch (err) {
        await releaseUnmutatedIdempotency(reservation.rowId);
        throw err;
      }

      return buildSettingsView();
    },

    async runRetentionCleanup(triggerJobId?: string): Promise<TrashCleanupResult> {
      const now = deps.clock.now();
      const sweepPublicId = ulid(now.getTime());

      const maintenanceSkip = await isMaintenanceBlockingCleanup();
      if (maintenanceSkip) {
        return {
          sweepPublicId,
          skippedReason: maintenanceSkip,
          due: 0,
          purged: 0,
          failed: 0,
        };
      }

      const retention = await readRetentionValues();
      if (!retention.autoPurgeEnabled) {
        return {
          sweepPublicId,
          skippedReason: "AUTO_PURGE_DISABLED",
          due: 0,
          purged: 0,
          failed: 0,
        };
      }

      const nowMs = now.getTime();
      const customerCutoff = new Date(nowMs - retention.customerDays * DAY_MS);
      const orderCutoff = new Date(nowMs - retention.orderDays * DAY_MS);

      const [dueCustRows, dueOrdRows] = await Promise.all([
        deps.db
          .select({ publicId: users.publicId })
          .from(users)
          .where(
            and(
              eq(users.role, "customer"),
              isNotNull(users.trashedAt),
              isNull(users.purgedAt),
              lte(users.trashedAt, customerCutoff),
            ),
          )
          .orderBy(asc(users.trashedAt), asc(users.id))
          .limit(SWEEP_BATCH_LIMIT),
        deps.db
          .select({ publicId: orders.publicId })
          .from(orders)
          .leftJoin(users, eq(users.id, orders.ownerUserId))
          .where(
            and(
              isNotNull(orders.trashedAt),
              isNull(orders.purgedAt),
              lte(orders.trashedAt, orderCutoff),
              sql`NOT (${users.trashedAt} IS NOT NULL AND ${users.purgedAt} IS NULL AND ${users.trashBatchId} = ${orders.trashBatchId})`,
            ),
          )
          .orderBy(asc(orders.trashedAt), asc(orders.id))
          .limit(SWEEP_BATCH_LIMIT),
      ]);

      const dueTargets: TrashItemRef[] = [
        ...dueCustRows.map((r) => ({ kind: "customer" as const, publicId: r.publicId })),
        ...dueOrdRows.map((r) => ({ kind: "order" as const, publicId: r.publicId })),
      ].slice(0, SWEEP_BATCH_LIMIT);

      const [sweepIns] = await deps.db.insert(trashCleanupSweeps).values({
        publicId: sweepPublicId,
        correlationId: triggerJobId ?? sweepPublicId,
        status: "running",
        purgedCount: 0,
        failedCount: 0,
        startedAt: now,
      });
      const sweepRowId = Number(sweepIns.insertId);

      const actor: TrashActor = { kind: "system", job: TRASH_JOB_RETENTION_CLEANUP };
      let purged = 0;
      let failed = 0;

      for (const target of dueTargets) {
        if (await isMaintenanceBlockingCleanup()) break;
        try {
          await executePurgeOne({
            item: target,
            actor,
            bulkCount: dueTargets.length,
            sweepPublicId,
          });
          purged += 1;
        } catch (err) {
          // Legal hold on a trashed item: skip + emit alert, do NOT fail the whole sweep (lead ruling).
          if (err instanceof DomainError && err.reasonCode === "ORDER_ON_LEGAL_HOLD") {
            const opsAlerts = services().opsAlerts;
            if (opsAlerts) {
              await opsAlerts
                .emit({
                  source: "trash",
                  dedupKey: `legal-hold:${target.kind}:${target.publicId}`,
                  severity: "warning",
                  code: "ORDER_ON_LEGAL_HOLD",
                  title: "Item on legal hold skipped during retention clean-up",
                  text: "Release the legal hold before automatic permanent deletion can proceed.",
                  orderPublicId: target.kind === "order" ? target.publicId : undefined,
                  runPublicId: sweepPublicId,
                  correlationId: sweepPublicId,
                })
                .catch(() => undefined);
            }
            continue;
          }
          // Concurrent restore / retention change / active manual purge is benign, not a sweep failure.
          if (
            err instanceof DomainError &&
            (err.reasonCode === "NOT_IN_TRASH" ||
              err.reasonCode === "NOT_DUE" ||
              err.reasonCode === "MAINTENANCE_ACTIVE" ||
              err.reasonCode === "AUTO_PURGE_DISABLED" ||
              err.reasonCode === "PURGE_IN_PROGRESS" ||
              err.reasonCode === "ORDER_NOT_FOUND" ||
              err.reasonCode === "CUSTOMER_NOT_FOUND")
          ) {
            continue;
          }
          failed += 1;
          log.warn("retention cleanup item failed; continuing sweep", { err, target, sweepPublicId });
        }
      }

      const finishedAt = deps.clock.now();
      const status: "completed" | "failed" = failed > 0 ? "failed" : "completed";
      await deps.db
        .update(trashCleanupSweeps)
        .set({
          status,
          purgedCount: purged,
          failedCount: failed,
          errorCode: failed > 0 ? "TRASH_CLEANUP_PARTIAL_FAILURE" : null,
          finishedAt,
        })
        .where(eq(trashCleanupSweeps.id, sweepRowId));

      await deps.audit.record({
        category: "job",
        eventName: "trash.cleanup_completed",
        action: "delete",
        outcome: failed > 0 ? "failed" : "completed",
        severity: failed > 0 ? "WARN" : "INFO",
        actor: { role: "system" },
        resource: { type: "trash_cleanup", id: sweepRowId, publicId: sweepPublicId },
        correlationId: sweepPublicId,
        ...(triggerJobId ? { jobId: triggerJobId } : {}),
        safeCounts: { due: dueTargets.length, purged, failed },
        attributes: {
          run_public_id: sweepPublicId,
          due: dueTargets.length,
          purged,
          failed,
        },
      });

      const opsAlerts = services().opsAlerts;
      if (opsAlerts && failed > 0) {
        await opsAlerts
          .emit({
            source: "trash",
            dedupKey: `retention:${sweepPublicId}`,
            severity: "error",
            code: "TRASH_PURGE_FAILED",
            title: "Trash cleanup needs attention",
            text: `${failed} item(s) could not be deleted permanently during scheduled retention cleanup.`,
            runPublicId: sweepPublicId,
            correlationId: sweepPublicId,
          })
          .catch((err: unknown) => {
            log.error("failed to emit retention sweep failure alert", { err, sweepPublicId });
          });
      }

      return {
        sweepPublicId,
        skippedReason: null,
        due: dueTargets.length,
        purged,
        failed,
      };
    },
  };

  deps.jobs?.register(
    TRASH_JOB_RETENTION_CLEANUP,
    async (job) => {
      if (job.signal.aborted) {
        return { outcome: "canceled", reasonCode: "ABORTED" };
      }
      await job.assertStillOwned();
      const res = await service.runRetentionCleanup(job.jobId);
      if (res.failed > 0) {
        return { outcome: "failed", reasonCode: "TRASH_PURGE_FAILED", retryable: true };
      }
      return {
        outcome: "completed",
        safeCounts: { due: res.due, purged: res.purged, failed: res.failed },
      };
    },
    { retrySafe: true },
  );

  return service;
}
