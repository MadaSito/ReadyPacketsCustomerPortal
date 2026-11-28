/**
 * Trash coordinator service (Increment 09, Decision D2 & D2.8). Owner: recovery_ops_engineer.
 *
 * Security & durability invariants enforced (D2.8 + lead rulings):
 *  - Every procedure re-validates actor role, capability, session freshness, and MFA step-up inside `tx`
 *    via `createActorGuard` (fail closed if identity session verification is unavailable).
 *  - Missing `orders.trash`, `identity.trash`, `jobAdmin` maintenance gates, or any expected `TrashParticipant`
 *    fails closed (`503 UNAVAILABLE`).
 *  - Legal hold (`orders.lock_state = 'legal_hold'`) blocks order & customer move-to-trash and purge with
 *    `409 ORDER_ON_LEGAL_HOLD` ("Release the legal hold first."); the retention sweep skips held items, emits an
 *    operational alert, and advances its cursor past them so later due items never starve.
 *  - Cascades enforce bounded target counts (`MAX_CASCADE_TARGETS`) and fail closed on overflow.
 *  - Generation (`batchId`) is mandatory on all manual `restore`, `purge`, and `finishLeavingExternalCopies` inputs.
 *    Idempotency reservations store `(actor, action, fingerprintHash, batchBindings)` BEFORE any side effect and are
 *    retained permanently once a purge claim or participant/restore effect commits (failed outcomes recorded & replayed;
 *    only unmutated pre-claim rejections release the reservation).
 *  - Durable per-target run ownership (`trash_purge_run_targets`, permanent `UNIQUE(entity_kind, entity_id)`):
 *    every claimed target (root, all group additions including reassigned cross-owner members, customer-cascaded orders,
 *    and the customer row) belongs to at most one purge run forever; failed runs are resumed, never replaced.
 *  - Pure row-fenced participant & coordinator execution (`assertCurrentInTx(tx)`):
 *    no advisory lock or pinned pool connection (`RP_DB_POOL_SIZE=1` safe). Every participant mutation transaction
 *    executes `SELECT ... FOR SHARE` on `trash_purge_runs` verifying `(status='running', fencing_token, lease_owner)`.
 *    Takeover locks `trash_purge_runs` `FOR UPDATE` (waiting for any in-flight participant `FOR SHARE` transaction),
 *    requires an expired lease (`lease_expires_at <= now`), and increments `fencing_token`. Worker renews its lease
 *    by token-CAS between steps and on a background heartbeat timer during steps.
 *  - Retention preview & update use exact SQL `COUNT(*)` queries and require step-up + typed `DELETE <N>` confirmation
 *    for every risky change (enabling automatic clean-up or shortening either active period, including `DELETE 0`).
 *  - Row-fenced single-active retention sweep (`trash_cleanup_sweeps.active_slot = 1`) with persistent per-target
 *    progression (`trash_retention_deferrals`, 24 h backoff cap, single operational alert per deferral generation).
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, like, lte, ne, or, sql } from "drizzle-orm";
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
import { storageCopyAttempts } from "../storage/schema.js";
import { TRASH_JOB_RETENTION_CLEANUP } from "./jobNames.js";
import type {
  TrashActor,
  TrashEntityKind,
  TrashEntityRef,
  TrashParticipant,
  TrashPurgeResult,
  TrashPurgeRun,
  TrashRegistry,
} from "./ports.js";
import {
  trashCleanupSweeps,
  trashIdempotencyKeys,
  trashPurgeRuns,
  trashPurgeRunTargets,
  trashRetentionDeferrals,
  trashRetentionState,
  type TrashPurgeRunRow,
  type TrashPurgeRunTargetRow,
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
  TrashCleanupJobFence,
  TrashCleanupResult,
  TrashCoordinatorOptions,
  TrashCounts,
  TrashFinishLeavingExternalInput,
  TrashFinishLeavingExternalOutput,
  TrashItemRef,
  TrashItemResult,
  TrashListOutput,
  TrashMoveOutput,
  TrashMutationItemRef,
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
const MAX_BULK_ITEMS = 100;
const MAX_CASCADE_TARGETS = 10_000;
const MAX_LIST_COHORT = 10_000;
const SWEEP_BATCH_LIMIT = 500;
const SWEEP_PAGE_SIZE = 100;
const SWEEP_MAX_SCANNED = 10_000;
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

/**
 * Explicit allowlist of manifest modules that intentionally own zero order or customer rows,
 * mapped to a mandatory human-readable reason. Any module in `EXPECTED_CONTAINER_PARTICIPANTS`
 * that registers without a `purge` handler and is not listed here fails closed
 * (`TRASH_PARTICIPANT_NO_PURGE_HANDLER`).
 */
export const MANIFEST_NO_DATA_TO_PURGE: Readonly<Record<string, string>> = {};

const DEFAULT_RUN_LEASE_MS = 60_000;
const DEFAULT_RUN_HEARTBEAT_MS = 15_000;
const DEFAULT_SWEEP_LEASE_MS = 120_000;
const DEFERRAL_BASE_MS = 60 * 60_000; // 1 hour initial deferral for held/refused retention items

interface PersistedRunMeta {
  expectedModules: string[];
}

type PerTargetCheckpointMap = Record<string, TrashPurgeResult>;

interface PersistedCounts {
  deleted: Record<string, number>;
  kept: Record<string, number>;
  unreachableByConnection?: Record<string, number>;
  unreachableTotal?: number;
}

interface StoredFailedDomainError {
  code: DomainError["code"];
  reasonCode: string;
  safeMessage: string;
}

interface StoredIdempotencyEnvelope<T> {
  status: "in_progress" | "completed" | "failed";
  fingerprintHash: string;
  batchBindings: Record<string, string | null>;
  attemptOwner?: string;
  leaseExpiresAtMs?: number;
  claimedRunPublicIds?: string[];
  restoredItems?: Record<string, TrashItemResult>;
  payload?: T;
  failedError?: StoredFailedDomainError;
}

class RetryRunFirstSignal extends Error {
  constructor() {
    super("RETRY_RUN_FIRST");
  }
}

interface ExternalCopyProof {
  runId: string;
  orderPublicId: string;
  stamps: string[];
  unreachableTotal: number;
  unreachableByConnection: Record<string, number>;
}

const stepUpError = () =>
  new DomainError("STEP_UP_REQUIRED", "STEP_UP_REQUIRED", "Confirm your identity to continue.");

const legalHoldError = () =>
  conflict("ORDER_ON_LEGAL_HOLD", "Release the legal hold first.");

function isMysqlDupEntry(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const rec = err as { code?: unknown; errno?: unknown; cause?: unknown };
  if (rec.code === "ER_DUP_ENTRY" || rec.errno === 1062) return true;
  if (rec.cause && typeof rec.cause === "object") {
    const c = rec.cause as { code?: unknown; errno?: unknown };
    return c.code === "ER_DUP_ENTRY" || c.errno === 1062;
  }
  return false;
}

function computeRetryBackoffMs(attemptCount: number): number {
  const exp = Math.min(Math.max(attemptCount - 1, 0), 12);
  return Math.min(DAY_MS, 30_000 * Math.pow(2, exp));
}

function computeDeferralBackoffMs(attemptCount: number): number {
  const exp = Math.min(Math.max(attemptCount - 1, 0), 6);
  return Math.min(DAY_MS, DEFERRAL_BASE_MS * Math.pow(2, exp));
}

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

function assertUniqueMutationItems(items: readonly TrashMutationItemRef[]): void {
  if (items.length < 1 || items.length > MAX_BULK_ITEMS) {
    throw validation("INVALID_BULK_COUNT", `Select between 1 and ${MAX_BULK_ITEMS} items.`);
  }
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.batchId || item.batchId.trim().length === 0) {
      throw validation("BATCH_ID_REQUIRED", "Include the trash batch identifier for each item.");
    }
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

function parseRunMeta(raw: string): PersistedRunMeta {
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedRunMeta>;
    return {
      expectedModules: Array.isArray(parsed.expectedModules) ? parsed.expectedModules : [],
    };
  } catch {
    return { expectedModules: [] };
  }
}

function parseTargetCheckpoint(raw: string): PerTargetCheckpointMap {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as PerTargetCheckpointMap;
    }
  } catch {
    // Fall back to empty checkpoint if malformed.
  }
  return {};
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
  const runLeaseMs = Math.max(options.runLeaseMs ?? DEFAULT_RUN_LEASE_MS, 200);
  const runHeartbeatMs = Math.max(
    options.runHeartbeatMs ?? Math.min(DEFAULT_RUN_HEARTBEAT_MS, Math.floor(runLeaseMs / 3)),
    15,
  );
  const sweepLeaseMs = Math.max(options.sweepLeaseMs ?? DEFAULT_SWEEP_LEASE_MS, 500);
  const explicitNoOpModules: Readonly<Record<string, string>> =
    options.manifestNoDataToPurge ?? MANIFEST_NO_DATA_TO_PURGE;
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
    const missingPurgeHandler = requiredModules.filter((m) => {
      const part = byName.get(m);
      if (typeof part?.purge === "function") return false;
      const documentedReason = explicitNoOpModules[m];
      return typeof documentedReason !== "string" || documentedReason.trim().length === 0;
    });
    if (missingPurgeHandler.length > 0) {
      log.error("manifest participant registered without purge handler and not on no-data allowlist", {
        missingPurgeHandler,
      });
      throw unavailable(
        "TRASH_PARTICIPANT_NO_PURGE_HANDLER",
        "Permanent deletion is temporarily unavailable.",
      );
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
      const autoPurgeEnabled = byKey.has(TRASH_AUTO_PURGE_ENABLED.key)
        ? typeof byKey.get(TRASH_AUTO_PURGE_ENABLED.key) === "boolean"
          ? (byKey.get(TRASH_AUTO_PURGE_ENABLED.key) as boolean)
          : true
        : await deps.settings.get<boolean>(
            TRASH_AUTO_PURGE_ENABLED.key,
            (raw) => (typeof raw === "boolean" ? raw : true),
            true,
            tx,
          );
      const orderDays = byKey.has(TRASH_RETENTION_ORDER_DAYS.key)
        ? parseRetentionDays(byKey.get(TRASH_RETENTION_ORDER_DAYS.key), TRASH_RETENTION_DEFAULT_DAYS)
        : await deps.settings.get<number>(
            TRASH_RETENTION_ORDER_DAYS.key,
            (raw) => parseRetentionDays(raw, TRASH_RETENTION_DEFAULT_DAYS),
            TRASH_RETENTION_DEFAULT_DAYS,
            tx,
          );
      const customerDays = byKey.has(TRASH_RETENTION_CUSTOMER_DAYS.key)
        ? parseRetentionDays(byKey.get(TRASH_RETENTION_CUSTOMER_DAYS.key), TRASH_RETENTION_DEFAULT_DAYS)
        : await deps.settings.get<number>(
            TRASH_RETENTION_CUSTOMER_DAYS.key,
            (raw) => parseRetentionDays(raw, TRASH_RETENTION_DEFAULT_DAYS),
            TRASH_RETENTION_DEFAULT_DAYS,
            tx,
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
   * Stores `fingerprintHash` AND `initialBatchBindings` upfront so any subsequent generation mismatch is rejected.
   */
  async function reserveIdempotency<T>(params: {
    principal: SessionPrincipal;
    capability: Capability;
    operation: string;
    idempotencyKey: string;
    fingerprintHash: string;
    initialBatchBindings?: Record<string, string | null>;
    verifyBatchGenerations: boolean;
    resumablePurgeOperation?: boolean;
    resumableRestoreOperation?: boolean;
  }): Promise<
    | { hit: true; payload: T }
    | {
        hit: false;
        rowId: number;
        attemptOwner: string;
        hadCommittedClaim: boolean;
        priorRestoredItems: Record<string, TrashItemResult>;
      }
  > {
    const {
      principal,
      capability,
      operation,
      idempotencyKey,
      fingerprintHash,
      initialBatchBindings = {},
      verifyBatchGenerations,
      resumablePurgeOperation = false,
      resumableRestoreOperation = false,
    } = params;
    const actionKey = `${capability}:${operation}`.slice(0, 48);
    const kHash = keyHash(`trash.idem:${actionKey}:${idempotencyKey}`);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await deps.db.transaction(async (tx) => {
          // Canonical lock order: actor user/session -> trash_purge_runs (FOR SHARE, id ASC) -> trash_idempotency_keys (FOR UPDATE).
          await guardActorInTx(tx, principal, capability);
          const now = deps.clock.now();
          const nowMs = now.getTime();
          const nextAttemptOwner = ulid(nowMs);
          const nextLeaseExpiresAtMs = nowMs + runLeaseMs;

          const [preExisting] = await tx
            .select()
            .from(trashIdempotencyKeys)
            .where(
              and(
                eq(trashIdempotencyKeys.actorUserId, principal.userId),
                eq(trashIdempotencyKeys.action, actionKey),
                eq(trashIdempotencyKeys.keyHash, kHash),
              ),
            )
            .limit(1);

          const preParsed = preExisting
            ? (JSON.parse(preExisting.responseJson) as StoredIdempotencyEnvelope<T>)
            : null;
          const liveBatches = new Map<string, string | null>();
          if (preParsed && verifyBatchGenerations) {
            for (const bindingKey of Object.keys(preParsed.batchBindings ?? {})) {
              const sep = bindingKey.indexOf(":");
              if (sep <= 0) continue;
              const kind = bindingKey.slice(0, sep) as TrashEntityKind;
              const publicId = bindingKey.slice(sep + 1);
              liveBatches.set(bindingKey, await currentBatchOf(tx, { kind, publicId }));
            }
          }

          const preRunPubIds = [
            ...new Set([
              ...(preParsed?.claimedRunPublicIds ?? []),
              ...(preExisting?.claimedRunPublicId ? [preExisting.claimedRunPublicId] : []),
            ]),
          ];
          const linkedRunsByPubId = new Map<
            string,
            { id: number; publicId: string; status: "running" | "completed" | "failed"; leaseExpiresAt: Date | null }
          >();
          if (preRunPubIds.length > 0) {
            const runRows = await tx
              .select({
                id: trashPurgeRuns.id,
                publicId: trashPurgeRuns.publicId,
                status: trashPurgeRuns.status,
                leaseExpiresAt: trashPurgeRuns.leaseExpiresAt,
              })
              .from(trashPurgeRuns)
              .where(inArray(trashPurgeRuns.publicId, preRunPubIds))
              .orderBy(asc(trashPurgeRuns.id))
              .for("share");
            for (const r of runRows) {
              linkedRunsByPubId.set(r.publicId, r);
            }
          }

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
            const parsed = JSON.parse(existing.responseJson) as StoredIdempotencyEnvelope<T>;
            const allRunPubIds = [
              ...new Set([
                ...(parsed.claimedRunPublicIds ?? []),
                ...(existing.claimedRunPublicId ? [existing.claimedRunPublicId] : []),
              ]),
            ];
            if (allRunPubIds.some((pid) => !preRunPubIds.includes(pid))) {
              // Never lock `trash_purge_runs` after `trash_idempotency_keys`; restart tx to lock runs FOR SHARE first.
              throw new RetryRunFirstSignal();
            }

            const priorRestored = parsed.restoredItems ?? {};
            const hasPriorRestored = Object.keys(priorRestored).length > 0;
            const ttlElapsed = existing.createdAt.getTime() + IDEM_TTL_MS <= nowMs;
            // Never recycle by 24h TTL while ANY linked purge run or committed partial restore is incomplete!
            const hasIncompleteCommittedClaim =
              allRunPubIds.length > 0
                ? allRunPubIds.some((pid) => {
                    const r = linkedRunsByPubId.get(pid);
                    return !r || r.status !== "completed";
                  })
                : existing.status === "claimed" || existing.status === "failed" || hasPriorRestored;
            const canRecycleByTtl =
              ttlElapsed &&
              !hasIncompleteCommittedClaim &&
              (existing.status === "completed" ||
                (existing.status === "in_progress" &&
                  (parsed.leaseExpiresAtMs ?? existing.updatedAt.getTime() + runLeaseMs) <= nowMs));

            if (canRecycleByTtl) {
              await tx.delete(trashIdempotencyKeys).where(eq(trashIdempotencyKeys.id, existing.id));
            } else {
              if (existing.fingerprintHash !== fingerprintHash) {
                throw conflict("IDEMPOTENCY_KEY_REUSED", "This request key was already used for a different action.");
              }
              if (verifyBatchGenerations) {
                for (const [bindingKey, recordedBatch] of Object.entries(parsed.batchBindings ?? {})) {
                  const sep = bindingKey.indexOf(":");
                  if (sep <= 0) continue;
                  const kind = bindingKey.slice(0, sep) as TrashEntityKind;
                  const publicId = bindingKey.slice(sep + 1);
                  const liveBatch = liveBatches.has(bindingKey)
                    ? (liveBatches.get(bindingKey) ?? null)
                    : await currentBatchOf(tx, { kind, publicId });
                  if (liveBatch !== null && recordedBatch !== null && liveBatch !== recordedBatch) {
                    throw conflict("IDEMPOTENCY_KEY_REUSED", "This item moved into a new trash batch since that request.");
                  }
                }
              }

              if (existing.status === "completed" || parsed.status === "completed") {
                return { hit: true as const, payload: parsed.payload as T };
              }

              // Same-fingerprint retry on a claimed/failed purge orack reservation resumes once no linked run has an active lease!
              if (
                resumablePurgeOperation &&
                (allRunPubIds.length > 0 || existing.status === "claimed" || existing.status === "failed")
              ) {
                const anyActiveRunLease = allRunPubIds.some((pid) => {
                  const r = linkedRunsByPubId.get(pid);
                  return (
                    r?.status === "running" &&
                    r.leaseExpiresAt !== null &&
                    r.leaseExpiresAt.getTime() > nowMs
                  );
                });
                const unlinkedAttemptStillLive =
                  allRunPubIds.length === 0 &&
                  existing.status !== "failed" &&
                  (parsed.leaseExpiresAtMs ?? existing.updatedAt.getTime() + runLeaseMs) > nowMs;
                if (anyActiveRunLease || unlinkedAttemptStillLive) {
                  throw conflict("REQUEST_IN_PROGRESS", "This request is already being processed.");
                }
                const resumingEnvelope: StoredIdempotencyEnvelope<T> = {
                  status: "in_progress",
                  fingerprintHash,
                  batchBindings: parsed.batchBindings ?? { ...initialBatchBindings },
                  attemptOwner: nextAttemptOwner,
                  leaseExpiresAtMs: nextLeaseExpiresAtMs,
                  claimedRunPublicIds: allRunPubIds,
                };
                await tx
                  .update(trashIdempotencyKeys)
                  .set({
                    status: "claimed",
                    responseJson: JSON.stringify(resumingEnvelope),
                    updatedAt: now,
                  })
                  .where(eq(trashIdempotencyKeys.id, existing.id));
                return {
                  hit: false as const,
                  rowId: existing.id,
                  attemptOwner: nextAttemptOwner,
                  hadCommittedClaim: true,
                  priorRestoredItems: {},
                };
              }

              // Same-fingerprint retry on a partially-committed bulk restore resumes remaining items!
              if (
                resumableRestoreOperation &&
                (hasPriorRestored || existing.status === "claimed" || existing.status === "failed")
              ) {
                const attemptStillLive =
                  existing.status !== "failed" &&
                  (parsed.leaseExpiresAtMs ?? existing.updatedAt.getTime() + runLeaseMs) > nowMs;
                if (attemptStillLive) {
                  throw conflict("REQUEST_IN_PROGRESS", "This request is already being processed.");
                }
                const resumingRestoreEnv: StoredIdempotencyEnvelope<T> = {
                  status: "in_progress",
                  fingerprintHash,
                  batchBindings: parsed.batchBindings ?? { ...initialBatchBindings },
                  attemptOwner: nextAttemptOwner,
                  leaseExpiresAtMs: nextLeaseExpiresAtMs,
                  restoredItems: priorRestored,
                };
                await tx
                  .update(trashIdempotencyKeys)
                  .set({
                    status: "claimed",
                    responseJson: JSON.stringify(resumingRestoreEnv),
                    updatedAt: now,
                  })
                  .where(eq(trashIdempotencyKeys.id, existing.id));
                return {
                  hit: false as const,
                  rowId: existing.id,
                  attemptOwner: nextAttemptOwner,
                  hadCommittedClaim: hasPriorRestored,
                  priorRestoredItems: priorRestored,
                };
              }

              // Pre-claim `in_progress`: if the worker's reservation lease is still active, reject concurrent duplicate;
              // once the pre-claim lease expires (crashed worker with zero committed effects), recover cleanly!
              if (existing.status === "in_progress" || parsed.status === "in_progress") {
                const inProgressExpiresAtMs =
                  parsed.leaseExpiresAtMs ?? existing.updatedAt.getTime() + runLeaseMs;
                if (inProgressExpiresAtMs > nowMs) {
                  throw conflict("REQUEST_IN_PROGRESS", "This request is already being processed.");
                }
                const recoveredEnvelope: StoredIdempotencyEnvelope<T> = {
                  status: "in_progress",
                  fingerprintHash,
                  batchBindings: { ...initialBatchBindings },
                  attemptOwner: nextAttemptOwner,
                  leaseExpiresAtMs: nextLeaseExpiresAtMs,
                  claimedRunPublicIds: [],
                  restoredItems: {},
                };
                await tx
                  .update(trashIdempotencyKeys)
                  .set({
                    status: "in_progress",
                    responseJson: JSON.stringify(recoveredEnvelope),
                    updatedAt: now,
                  })
                  .where(eq(trashIdempotencyKeys.id, existing.id));
                return {
                  hit: false as const,
                  rowId: existing.id,
                  attemptOwner: nextAttemptOwner,
                  hadCommittedClaim: false,
                  priorRestoredItems: {},
                };
              }

              if (parsed.status === "failed" && parsed.failedError) {
                throw new DomainError(
                  parsed.failedError.code,
                  parsed.failedError.reasonCode,
                  parsed.failedError.safeMessage,
                );
              }
              return { hit: true as const, payload: parsed.payload as T };
            }
          }

          const initial: StoredIdempotencyEnvelope<T> = {
            status: "in_progress",
            fingerprintHash,
            batchBindings: { ...initialBatchBindings },
            attemptOwner: nextAttemptOwner,
            leaseExpiresAtMs: nextLeaseExpiresAtMs,
            claimedRunPublicIds: [],
            restoredItems: {},
          };
          const [ins] = await tx.insert(trashIdempotencyKeys).values({
            actorUserId: principal.userId,
            action: actionKey,
            keyHash: kHash,
            status: "in_progress",
            claimedRunPublicId: null,
            fingerprintHash,
            responseJson: JSON.stringify(initial),
            createdAt: now,
            updatedAt: now,
          });
          return {
            hit: false as const,
            rowId: Number(ins.insertId),
            attemptOwner: nextAttemptOwner,
            hadCommittedClaim: false,
            priorRestoredItems: {},
          };
        });
      } catch (err) {
        if (err instanceof RetryRunFirstSignal && attempt < 2) {
          continue;
        }
        throw err;
      }
    }
    throw conflict("REQUEST_IN_PROGRESS", "This request is already being processed.");
  }

  async function bindIdempotencyClaimInTx(params: {
    tx: Tx;
    idempotencyRowId: number | undefined;
    attemptOwner: string | undefined;
    runPublicId: string;
    bindingKey?: string;
    batchId?: string;
    now: Date;
  }): Promise<void> {
    const { tx, idempotencyRowId, attemptOwner, runPublicId, bindingKey, batchId, now } = params;
    if (idempotencyRowId === undefined) return;
    const [row] = await tx
      .select()
      .from(trashIdempotencyKeys)
      .where(eq(trashIdempotencyKeys.id, idempotencyRowId))
      .for("update")
      .limit(1);
    if (!row || row.status === "completed") return;
    const parsed = JSON.parse(row.responseJson) as StoredIdempotencyEnvelope<unknown>;
    if (parsed.status === "completed") return;
    if (attemptOwner && parsed.attemptOwner && parsed.attemptOwner !== attemptOwner) {
      throw conflict("PURGE_FENCE_LOST", "Idempotency reservation attempt was superseded.");
    }
    const mergedRuns = [
      ...new Set([
        ...(parsed.claimedRunPublicIds ?? []),
        ...(row.claimedRunPublicId ? [row.claimedRunPublicId] : []),
        runPublicId,
      ]),
    ];
    const mergedBindings: Record<string, string | null> = {
      ...(parsed.batchBindings ?? {}),
      ...(bindingKey && batchId ? { [bindingKey]: batchId } : {}),
    };
    const nextEnv: StoredIdempotencyEnvelope<unknown> = {
      ...parsed,
      status: "in_progress",
      attemptOwner: attemptOwner ?? parsed.attemptOwner,
      leaseExpiresAtMs: now.getTime() + runLeaseMs,
      batchBindings: mergedBindings,
      claimedRunPublicIds: mergedRuns,
    };
    await tx
      .update(trashIdempotencyKeys)
      .set({
        status: "claimed",
        claimedRunPublicId: runPublicId,
        responseJson: JSON.stringify(nextEnv),
        updatedAt: now,
      })
      .where(eq(trashIdempotencyKeys.id, idempotencyRowId));
  }

  async function recordRestoreProgressInTx(params: {
    tx: Tx;
    rowId: number;
    attemptOwner: string;
    itemKey: string;
    batchId: string;
    itemResult: TrashItemResult;
    now: Date;
  }): Promise<void> {
    const { tx, rowId, attemptOwner, itemKey, batchId, itemResult, now } = params;
    const [row] = await tx
      .select()
      .from(trashIdempotencyKeys)
      .where(eq(trashIdempotencyKeys.id, rowId))
      .for("update")
      .limit(1);
    if (!row || row.status === "completed") return;
    const parsed = JSON.parse(row.responseJson) as StoredIdempotencyEnvelope<unknown>;
    if (parsed.status === "completed") return;
    if (parsed.attemptOwner && parsed.attemptOwner !== attemptOwner) {
      throw conflict("REQUEST_IN_PROGRESS", "Restore reservation attempt was superseded.");
    }
    const nextEnv: StoredIdempotencyEnvelope<unknown> = {
      ...parsed,
      status: "in_progress",
      attemptOwner,
      leaseExpiresAtMs: now.getTime() + runLeaseMs,
      batchBindings: { ...(parsed.batchBindings ?? {}), [itemKey]: batchId },
      restoredItems: { ...(parsed.restoredItems ?? {}), [itemKey]: itemResult },
    };
    await tx
      .update(trashIdempotencyKeys)
      .set({
        status: "claimed",
        responseJson: JSON.stringify(nextEnv),
        updatedAt: now,
      })
      .where(eq(trashIdempotencyKeys.id, rowId));
  }

  async function completeIdempotency<T>(
    rowId: number,
    attemptOwner: string,
    fingerprintHash: string,
    batchBindings: Record<string, string | null>,
    payload: T,
    tx?: Tx,
  ): Promise<void> {
    const applyInTx = async (innerTx: Tx): Promise<void> => {
      const [row] = await innerTx
        .select()
        .from(trashIdempotencyKeys)
        .where(eq(trashIdempotencyKeys.id, rowId))
        .for("update")
        .limit(1);
      if (!row || row.status === "completed") return;
      const parsed = JSON.parse(row.responseJson) as StoredIdempotencyEnvelope<T>;
      if (parsed.status === "completed") return;
      if (parsed.attemptOwner && parsed.attemptOwner !== attemptOwner) return;
      const now = deps.clock.now();
      const envelope: StoredIdempotencyEnvelope<T> = {
        status: "completed",
        fingerprintHash,
        batchBindings: { ...(parsed.batchBindings ?? {}), ...batchBindings },
        attemptOwner,
        claimedRunPublicIds: parsed.claimedRunPublicIds,
        restoredItems: parsed.restoredItems,
        payload,
      };
      await innerTx
        .update(trashIdempotencyKeys)
        .set({
          status: "completed",
          responseJson: JSON.stringify(envelope),
          updatedAt: now,
        })
        .where(eq(trashIdempotencyKeys.id, rowId));
    };
    if (tx) {
      await applyInTx(tx);
    } else {
      await deps.db.transaction(applyInTx);
    }
  }

  /**
   * Retains the idempotency key and records the failed outcome ONLY if this `attemptOwner` still owns
   * the reservation and it has not already transitioned to terminal `completed`.
   */
  async function failIdempotency(
    rowId: number,
    attemptOwner: string,
    fingerprintHash: string,
    batchBindings: Record<string, string | null>,
    err: unknown,
  ): Promise<void> {
    const domErr =
      err instanceof DomainError
        ? err
        : unavailable("TRASH_PURGE_FAILED", "Permanent deletion did not finish cleanly and can be retried.");
    await deps.db
      .transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(trashIdempotencyKeys)
          .where(eq(trashIdempotencyKeys.id, rowId))
          .for("update")
          .limit(1);
        if (!row || row.status === "completed") return;
        const parsed = JSON.parse(row.responseJson) as StoredIdempotencyEnvelope<never>;
        if (parsed.status === "completed") return;
        if (parsed.attemptOwner && parsed.attemptOwner !== attemptOwner) return;
        const now = deps.clock.now();
        const envelope: StoredIdempotencyEnvelope<never> = {
          status: "failed",
          fingerprintHash,
          batchBindings: { ...(parsed.batchBindings ?? {}), ...batchBindings },
          attemptOwner,
          claimedRunPublicIds: parsed.claimedRunPublicIds,
          restoredItems: parsed.restoredItems,
          failedError: {
            code: domErr.code,
            reasonCode: domErr.reasonCode,
            safeMessage: domErr.safeMessage,
          },
        };
        await tx
          .update(trashIdempotencyKeys)
          .set({
            status: "failed",
            responseJson: JSON.stringify(envelope),
            updatedAt: now,
          })
          .where(eq(trashIdempotencyKeys.id, rowId));
      })
      .catch(() => undefined);
  }

  async function releaseUnmutatedIdempotency(rowId: number, attemptOwner: string): Promise<void> {
    await deps.db
      .transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(trashIdempotencyKeys)
          .where(eq(trashIdempotencyKeys.id, rowId))
          .for("update")
          .limit(1);
        if (!row || row.status !== "in_progress" || row.claimedRunPublicId !== null) return;
        const parsed = JSON.parse(row.responseJson) as StoredIdempotencyEnvelope<unknown>;
        if (parsed.status === "completed") return;
        if (parsed.attemptOwner && parsed.attemptOwner !== attemptOwner) return;
        if ((parsed.claimedRunPublicIds?.length ?? 0) > 0) return;
        if (Object.keys(parsed.restoredItems ?? {}).length > 0) return;
        await tx.delete(trashIdempotencyKeys).where(eq(trashIdempotencyKeys.id, rowId));
      })
      .catch(() => undefined);
  }

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

  /**
   * Resolves the owning purge run for each entity via `trash_purge_run_targets` JOIN `trash_purge_runs`,
   * plus the failing target's `publicId` and `targetReference` when the run halted on a specific target.
   */
  async function owningPurgeRunsByEntity(
    kind: TrashEntityKind,
    entityIds: readonly number[],
    dbOrTx: DbOrTx = deps.db,
  ): Promise<
    Map<
      number,
      {
        runId: number;
        publicId: string;
        status: "running" | "completed" | "failed";
        errorCode: string | null;
        countsJson: string | null;
        failedTargetPublicId: string | null;
        failedTargetReference: string | null;
      }
    >
  > {
    const unique = [...new Set(entityIds)];
    const out = new Map<
      number,
      {
        runId: number;
        publicId: string;
        status: "running" | "completed" | "failed";
        errorCode: string | null;
        countsJson: string | null;
        failedTargetPublicId: string | null;
        failedTargetReference: string | null;
      }
    >();
    if (!unique.length) return out;

    const rows = await dbOrTx
      .select({
        targetEntityId: trashPurgeRunTargets.entityId,
        runId: trashPurgeRuns.id,
        publicId: trashPurgeRuns.publicId,
        status: trashPurgeRuns.status,
        errorCode: trashPurgeRuns.errorCode,
        countsJson: trashPurgeRuns.countsJson,
        failedTargetPublicId: trashPurgeRuns.failedTargetPublicId,
      })
      .from(trashPurgeRunTargets)
      .innerJoin(trashPurgeRuns, eq(trashPurgeRuns.id, trashPurgeRunTargets.runId))
      .where(
        and(
          eq(trashPurgeRunTargets.entityKind, kind),
          inArray(trashPurgeRunTargets.entityId, unique),
        ),
      );

    const failedPubIds = [
      ...new Set(rows.map((r) => r.failedTargetPublicId).filter((v): v is string => Boolean(v))),
    ];
    const failedRefByPubId = new Map<string, string | null>();
    if (failedPubIds.length > 0) {
      const failedTargetRows = await dbOrTx
        .select({
          entityPublicId: trashPurgeRunTargets.entityPublicId,
          targetReference: trashPurgeRunTargets.targetReference,
        })
        .from(trashPurgeRunTargets)
        .where(inArray(trashPurgeRunTargets.entityPublicId, failedPubIds));
      for (const ft of failedTargetRows) {
        failedRefByPubId.set(ft.entityPublicId, ft.targetReference);
      }
    }

    for (const row of rows) {
      out.set(row.targetEntityId, {
        runId: row.runId,
        publicId: row.publicId,
        status: row.status,
        errorCode: row.errorCode,
        countsJson: row.countsJson,
        failedTargetPublicId: row.failedTargetPublicId,
        failedTargetReference: row.failedTargetPublicId
          ? (failedRefByPubId.get(row.failedTargetPublicId) ?? null)
          : null,
      });
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

  /**
   * Synchronized worker-drain and customer-maintenance gate (D2.8).
   * Passes `tx` so `jobAdmin.isDraining(tx)` and `customerAccess(tx)` lock their singleton rows `FOR SHARE`.
   * Fails closed if `jobAdmin` or its drain/maintenance gates are unavailable.
   */
  async function isMaintenanceBlockingCleanup(tx?: Tx): Promise<string | null> {
    const jobAdmin = services().jobAdmin as
      | {
          isDraining?: (t?: DbOrTx) => Promise<boolean>;
          maintenance?: { customerAccess?: (t?: Tx) => Promise<{ active: boolean }> };
        }
      | undefined;
    if (
      !jobAdmin ||
      typeof jobAdmin.isDraining !== "function" ||
      typeof jobAdmin.maintenance?.customerAccess !== "function"
    ) {
      throw unavailable("MAINTENANCE_GATE_UNAVAILABLE", "Maintenance gate is temporarily unavailable.");
    }
    if (await jobAdmin.isDraining(tx)) {
      return "WORKER_DRAINING";
    }
    const status = await jobAdmin.maintenance.customerAccess(tx);
    if (status.active) return "CUSTOMER_MAINTENANCE_ACTIVE";
    return null;
  }

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

  async function restoreSingleInTx(
    tx: Tx,
    item: TrashMutationItemRef,
    actor: TrashActor,
    auditPrincipal: SessionPrincipal,
  ): Promise<{ batchId: string }> {
    await shareLockRetentionCohortInTx(tx);
    const participants = registry.participants();
    const ordersTrash = requireOrdersTrash();
    const idTrash = requireIdentityTrash();

    if (item.kind === "order") {
      const [peekOwner] = await tx
        .select({ id: orders.id, ownerUserId: orders.ownerUserId })
        .from(orders)
        .where(eq(orders.publicId, item.publicId))
        .limit(1);
      if (!peekOwner) throw notFound("ORDER_NOT_FOUND");

      // Lock `trash_purge_run_targets` BEFORE `users -> orders` to preserve strict global lock ordering!
      const [ownedTarget] = await tx
        .select({ id: trashPurgeRunTargets.id })
        .from(trashPurgeRunTargets)
        .where(
          and(
            eq(trashPurgeRunTargets.entityKind, "order"),
            eq(trashPurgeRunTargets.entityId, peekOwner.id),
          ),
        )
        .for("share")
        .limit(1);
      if (ownedTarget) {
        throw conflict(
          "PURGE_IN_PROGRESS",
          "Permanent deletion has started for this order, so it can no longer be restored.",
        );
      }

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
      if (lockedOrder.trashBatchId !== item.batchId) {
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
      for (const entity of restoredEntities) {
        await tx
          .delete(trashRetentionDeferrals)
          .where(
            and(
              eq(trashRetentionDeferrals.entityKind, "order"),
              eq(trashRetentionDeferrals.entityId, entity.id),
            ),
          );
      }
      return { batchId };
    }

    const [peekCust] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.publicId, item.publicId), eq(users.role, "customer")))
      .limit(1);
    if (!peekCust) throw notFound("CUSTOMER_NOT_FOUND");

    // Lock `trash_purge_run_targets` BEFORE `users -> orders` to preserve strict global lock ordering!
    const [ownedCustTarget] = await tx
      .select({ id: trashPurgeRunTargets.id })
      .from(trashPurgeRunTargets)
      .where(
        and(
          eq(trashPurgeRunTargets.entityKind, "customer"),
          eq(trashPurgeRunTargets.entityId, peekCust.id),
        ),
      )
      .for("share")
      .limit(1);
    if (ownedCustTarget) {
      throw conflict(
        "PURGE_IN_PROGRESS",
        "Permanent deletion has started for this customer account, so it can no longer be restored.",
      );
    }

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
      .where(and(eq(users.id, peekCust.id), eq(users.role, "customer")))
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
    if (lockedCust.trashBatchId !== item.batchId) {
      throw conflict("STALE", "This customer account changed meanwhile. Review again.");
    }
    const batchId = lockedCust.trashBatchId;

    try {
      await idTrash.restoreCustomerInTx(tx, lockedCust.id, { actor, batchId });
      await tx
        .delete(trashRetentionDeferrals)
        .where(
          and(
            eq(trashRetentionDeferrals.entityKind, "customer"),
            eq(trashRetentionDeferrals.entityId, lockedCust.id),
          ),
        );
      const { entities: orderEntities } = await ordersTrash.restoreOrdersOfBatchInTx(tx, {
        ownerUserId: lockedCust.id,
        batchId,
        actor,
      });
      for (const ordEntity of orderEntities) {
        await tx
          .delete(trashRetentionDeferrals)
          .where(
            and(
              eq(trashRetentionDeferrals.entityKind, "order"),
              eq(trashRetentionDeferrals.entityId, ordEntity.id),
            ),
          );
      }
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
   * Locks `trash_purge_runs FOR UPDATE` FIRST (so takeover waits for any in-flight participant transaction
   * holding `FOR SHARE` BEFORE touching `users` or `orders`), then locks `trash_purge_run_targets`,
   * `users`, `orders`, and `trash_idempotency_keys` in strict canonical order, revalidates targets,
   * optionally records per-target typed external-copy acknowledgment, increments `fencingToken`, and resumes.
   */
  async function resumeExistingPurgeRunInTx(params: {
    tx: Tx;
    existingRun: TrashPurgeRunRow;
    actor: TrashActor;
    auditPrincipal?: SessionPrincipal;
    now: Date;
    workerLeaseOwner: string;
    idempotencyRowId?: number;
    attemptOwner?: string;
    bindingKey?: string;
    expectedPrimary?: {
      item: TrashItemRef;
      expectedSingleConfirmation?: string;
    };
    acknowledgeExternal?: {
      targetOrderPublicId?: string;
      confirmation: string;
    };
  }): Promise<
    | { alreadyCompleted: true; runId: string; batchId: string; keptExternalCopies: number }
    | {
        alreadyCompleted: false;
        runRowId: number;
        runId: string;
        batchId: string;
        fencingToken: number;
        expectedModules: string[];
        targets: TrashPurgeRunTargetRow[];
        counts: PersistedCounts;
        acknowledgedOrderPublicId: string | null;
      }
  > {
    const {
      tx,
      existingRun,
      actor,
      auditPrincipal,
      now,
      workerLeaseOwner,
      idempotencyRowId,
      attemptOwner,
      bindingKey,
      expectedPrimary,
      acknowledgeExternal,
    } = params;
    const ordersTrash = requireOrdersTrash();
    const idTrash = requireIdentityTrash();
    const nowMs = now.getTime();

    // Lock the run row FOR UPDATE FIRST inside this transaction: if an in-flight participant transaction
    // currently holds FOR SHARE via `run.assertCurrentInTx(tx)`, MySQL blocks here BEFORE we touch `users`/`orders`!
    const [lockedRun] = await tx
      .select()
      .from(trashPurgeRuns)
      .where(eq(trashPurgeRuns.id, existingRun.id))
      .for("update")
      .limit(1);
    if (!lockedRun) throw notFound("PURGE_RUN_NOT_FOUND");
    if (lockedRun.status === "completed") {
      if (expectedPrimary?.item.batchId && lockedRun.batchId !== expectedPrimary.item.batchId) {
        if (expectedPrimary.item.kind === "order") {
          const [ord] = await tx
            .select({ trashBatchId: orders.trashBatchId })
            .from(orders)
            .where(eq(orders.id, lockedRun.entityId))
            .for("share")
            .limit(1);
          if (ord?.trashBatchId !== expectedPrimary.item.batchId) {
            throw conflict("STALE", "This order changed meanwhile. Review again.");
          }
        } else {
          const [cust] = await tx
            .select({ trashBatchId: users.trashBatchId })
            .from(users)
            .where(eq(users.id, lockedRun.entityId))
            .for("share")
            .limit(1);
          if (cust?.trashBatchId !== expectedPrimary.item.batchId) {
            throw conflict("STALE", "This customer account changed meanwhile. Review again.");
          }
        }
      }
      await bindIdempotencyClaimInTx({
        tx,
        idempotencyRowId,
        attemptOwner,
        runPublicId: lockedRun.publicId,
        bindingKey,
        batchId: lockedRun.batchId,
        now,
      });
      const c = parseCounts(lockedRun.countsJson);
      return {
        alreadyCompleted: true,
        runId: lockedRun.publicId,
        batchId: lockedRun.batchId,
        keptExternalCopies: c.kept.acknowledgedExternalCopies ?? 0,
      };
    }

    if (
      lockedRun.status === "running" &&
      lockedRun.leaseExpiresAt !== null &&
      lockedRun.leaseExpiresAt.getTime() > nowMs
    ) {
      throw conflict(
        "PURGE_IN_PROGRESS",
        "Permanent deletion is already running for this item or an associated account.",
      );
    }

    if (
      actor.kind === "system" &&
      lockedRun.status === "failed" &&
      lockedRun.nextRetryAt &&
      lockedRun.nextRetryAt.getTime() > nowMs
    ) {
      throw conflict("PURGE_RETRY_BACKOFF", "Deletion run is waiting for retry backoff.");
    }

    const targetRows = await tx
      .select()
      .from(trashPurgeRunTargets)
      .where(eq(trashPurgeRunTargets.runId, lockedRun.id))
      .orderBy(asc(trashPurgeRunTargets.position))
      .for("update");

    if (expectedPrimary !== undefined) {
      if (actor.kind === "user" && !expectedPrimary.item.batchId) {
        throw validation("BATCH_ID_REQUIRED", "Include the trash batch identifier.");
      }
      if (expectedPrimary.item.batchId && lockedRun.batchId !== expectedPrimary.item.batchId) {
        throw conflict(
          "STALE",
          expectedPrimary.item.kind === "order"
            ? "This order changed meanwhile. Review again."
            : "This customer account changed meanwhile. Review again.",
        );
      }
      const primaryTarget = targetRows.find(
        (t) => t.entityKind === lockedRun.entityKind && t.entityId === lockedRun.entityId,
      );
      if (
        expectedPrimary.expectedSingleConfirmation !== undefined &&
        primaryTarget?.targetReference &&
        expectedPrimary.expectedSingleConfirmation.trim() !== primaryTarget.targetReference
      ) {
        throw validation(
          "CONFIRMATION_MISMATCH",
          "The confirmation you typed doesn't match. Nothing was deleted.",
        );
      }
    }

    let acknowledgedOrderPublicId: string | null = null;

    if (acknowledgeExternal !== undefined) {
      if (
        lockedRun.status !== "failed" ||
        lockedRun.failedModule !== "files" ||
        lockedRun.errorCode !== "EXTERNAL_COPIES_UNREACHABLE" ||
        !lockedRun.failedTargetPublicId
      ) {
        throw conflict("STALE", "The failed deletion run changed meanwhile. Review again.");
      }

      // Strictly require the run's CURRENT failed target from Files; refuse any sibling order!
      if (
        acknowledgeExternal.targetOrderPublicId !== undefined &&
        acknowledgeExternal.targetOrderPublicId !== lockedRun.failedTargetPublicId
      ) {
        throw conflict(
          "EXTERNAL_COPIES_ACK_NOT_APPLICABLE",
          "Only the current failed order with unreachable external copies can be acknowledged.",
        );
      }

      const ackTarget = targetRows.find(
        (t) => t.entityKind === "order" && t.entityPublicId === lockedRun.failedTargetPublicId,
      );
      if (!ackTarget || ackTarget.status === "completed") {
        throw conflict(
          "EXTERNAL_COPIES_ACK_NOT_APPLICABLE",
          "Specify the exact failing order and type its order number to leave external copies in place.",
        );
      }
      if (!ackTarget.targetReference || acknowledgeExternal.confirmation.trim() !== ackTarget.targetReference) {
        throw validation(
          "CONFIRMATION_MISMATCH",
          "The confirmation you typed doesn't match. Nothing was deleted.",
        );
      }
      if (!auditPrincipal || actor.kind !== "user") {
        throw forbidden("ROLE_NOT_PERMITTED");
      }

      const parsedCounts = parseCounts(lockedRun.countsJson);
      const journalPrefix = `trash-un:${lockedRun.publicId}:`;
      const journalRows = await tx
        .select({
          jobPublicId: storageCopyAttempts.jobPublicId,
          sourcePublicId: storageCopyAttempts.sourcePublicId,
          connectionPublicId: storageCopyAttempts.connectionPublicId,
        })
        .from(storageCopyAttempts)
        .where(
          and(
            eq(storageCopyAttempts.kind, "order_file"),
            eq(storageCopyAttempts.orderPublicId, ackTarget.entityPublicId),
            eq(storageCopyAttempts.errorCode, "EXTERNAL_COPIES_UNREACHABLE"),
            like(storageCopyAttempts.jobPublicId, `${journalPrefix}%`),
          ),
        );

      if (services().storageConnections && journalRows.length === 0) {
        throw conflict(
          "EXTERNAL_COPIES_ACK_NOT_APPLICABLE",
          "No verified unreachable external-copy proof was recorded for this order.",
        );
      }

      const stamps = journalRows
        .map(
          (r) =>
            `${r.jobPublicId.slice(journalPrefix.length)}:${r.sourcePublicId}:${r.connectionPublicId}`,
        )
        .sort();

      let proofByConnection: Record<string, number>;
      let displayedBlocked: number;
      if (journalRows.length > 0) {
        proofByConnection = {};
        for (const r of journalRows) {
          proofByConnection[r.connectionPublicId] =
            (proofByConnection[r.connectionPublicId] ?? 0) + 1;
        }
        displayedBlocked = journalRows.length;
      } else {
        proofByConnection = parsedCounts.unreachableByConnection ?? {};
        displayedBlocked = parsedCounts.unreachableTotal ?? 1;
      }

      const proof: ExternalCopyProof = {
        runId: lockedRun.publicId,
        orderPublicId: ackTarget.entityPublicId,
        stamps,
        unreachableTotal: displayedBlocked,
        unreachableByConnection: proofByConnection,
      };
      const proofJson = JSON.stringify(proof);

      await tx
        .update(trashPurgeRunTargets)
        .set({
          leaveExternalCopiesApprovedAt: now,
          leaveExternalCopiesActorUserId: auditPrincipal.userId,
          leaveExternalCopiesProofJson: proofJson,
          updatedAt: now,
        })
        .where(eq(trashPurgeRunTargets.id, ackTarget.id));
      ackTarget.leaveExternalCopiesApprovedAt = now;
      ackTarget.leaveExternalCopiesActorUserId = auditPrincipal.userId;
      ackTarget.leaveExternalCopiesProofJson = proofJson;
      acknowledgedOrderPublicId = ackTarget.entityPublicId;

      const connIds = Object.keys(proofByConnection).sort().join(",");
      await deps.audit.record(
        {
          category: "admin",
          eventName: "order.purge_external_left",
          action: "delete",
          outcome: "completed",
          severity: "WARN",
          actor: { userId: auditPrincipal.userId, role: auditPrincipal.role },
          resource: { type: "order", id: ackTarget.entityId, publicId: ackTarget.entityPublicId },
          orderPublicId: ackTarget.entityPublicId,
          correlationId: ackTarget.batchId,
          safeCounts: { kept_count: displayedBlocked },
          attributes: {
            order_public_id: ackTarget.entityPublicId,
            trash_batch_id: ackTarget.batchId,
            run_public_id: lockedRun.publicId,
            kept_count: displayedBlocked,
            ...(connIds ? { connection_public_ids: connIds.slice(0, 120) } : {}),
          },
        },
        tx,
      );
    }

    // If system retention sweep is resuming an order run, read its ownerUserId (unlocked) so we lock `users` BEFORE `orders`.
    let primaryOrderOwnerSnapshot:
      | { id: number; trashedAt: Date | null; trashBatchId: string | null; purgedAt: Date | null }
      | undefined;
    let primaryOrderOwnerId: number | null = null;
    if (actor.kind === "system" && lockedRun.entityKind === "order") {
      const [ordOwner] = await tx
        .select({ ownerUserId: orders.ownerUserId })
        .from(orders)
        .where(eq(orders.id, lockedRun.entityId))
        .limit(1);
      primaryOrderOwnerId = ordOwner?.ownerUserId ?? null;
    }

    // Re-lock customer targets (and any primary order owner) FIRST (`users -> orders` ascending order), then order targets.
    const customerTargets = targetRows
      .filter((t) => t.entityKind === "customer")
      .sort((a, b) => a.entityId - b.entityId);
    const orderTargets = targetRows
      .filter((t) => t.entityKind === "order")
      .sort((a, b) => a.entityId - b.entityId);

    const customerTargetById = new Map(customerTargets.map((ct) => [ct.entityId, ct]));
    const allUserIdsToLock = [
      ...new Set([
        ...customerTargets.map((ct) => ct.entityId),
        ...(primaryOrderOwnerId !== null ? [primaryOrderOwnerId] : []),
      ]),
    ].sort((a, b) => a - b);

    const lockedCustomerRows = new Map<
      number,
      { id: number; trashedAt: Date | null; trashBatchId: string | null; purgedAt: Date | null; customerRef: string | null; publicId: string }
    >();
    for (const uid of allUserIdsToLock) {
      const ct = customerTargetById.get(uid);
      if (ct) {
        const [cRow] = await tx
          .select({
            id: users.id,
            trashedAt: users.trashedAt,
            trashBatchId: users.trashBatchId,
            purgedAt: users.purgedAt,
            customerRef: users.customerRef,
            publicId: users.publicId,
          })
          .from(users)
          .where(eq(users.id, ct.entityId))
          .for("update")
          .limit(1);
        if (!cRow) throw notFound("CUSTOMER_NOT_FOUND");
        if (!cRow.purgedAt && (!cRow.trashedAt || !cRow.trashBatchId)) {
          throw conflict("NOT_IN_TRASH", "This customer account is no longer in the trash.");
        }
        if (!cRow.purgedAt && cRow.trashBatchId !== ct.batchId) {
          throw conflict("STALE", "Customer trash generation changed meanwhile. Review again.");
        }
        if (
          expectedPrimary?.expectedSingleConfirmation !== undefined &&
          lockedRun.entityKind === "customer" &&
          ct.entityId === lockedRun.entityId
        ) {
          const expectedRef = cRow.customerRef ?? cRow.publicId;
          if (expectedPrimary.expectedSingleConfirmation.trim() !== expectedRef) {
            throw validation(
              "CONFIRMATION_MISMATCH",
              "The confirmation you typed doesn't match. Nothing was deleted.",
            );
          }
        }
        if (!cRow.purgedAt) {
          await idTrash.markPurgeStartedInTx(tx, ct.entityId, {
            batchId: ct.batchId,
            runId: lockedRun.publicId,
            actor,
          });
        }
        lockedCustomerRows.set(uid, cRow);
      } else {
        const [oUser] = await tx
          .select({
            id: users.id,
            trashedAt: users.trashedAt,
            trashBatchId: users.trashBatchId,
            purgedAt: users.purgedAt,
          })
          .from(users)
          .where(eq(users.id, uid))
          .for("share")
          .limit(1);
        if (oUser) primaryOrderOwnerSnapshot = oUser;
      }
    }

    const lockedOrderRows = new Map<
      number,
      {
        id: number;
        reference: string;
        groupRootOrderId: number | null;
        lockState: string;
        trashedAt: Date | null;
        trashBatchId: string | null;
        purgedAt: Date | null;
      }
    >();
    if (orderTargets.length > 0) {
      const lockedOrders = await tx
        .select({
          id: orders.id,
          reference: orders.reference,
          groupRootOrderId: orders.groupRootOrderId,
          lockState: orders.lockState,
          trashedAt: orders.trashedAt,
          trashBatchId: orders.trashBatchId,
          purgedAt: orders.purgedAt,
        })
        .from(orders)
        .where(inArray(orders.id, orderTargets.map((t) => t.entityId)))
        .orderBy(asc(orders.id))
        .for("update");
      const byId = new Map(lockedOrders.map((o) => [o.id, o]));
      for (const ot of orderTargets) {
        const oRow = byId.get(ot.entityId);
        if (!oRow) throw notFound("ORDER_NOT_FOUND");
        if (oRow.lockState === "legal_hold") throw legalHoldError();
        if (!oRow.purgedAt && (!oRow.trashedAt || !oRow.trashBatchId)) {
          throw conflict("NOT_IN_TRASH", "This order is no longer in the trash.");
        }
        if (!oRow.purgedAt && oRow.trashBatchId !== ot.batchId) {
          throw conflict("STALE", "Order trash generation changed meanwhile. Review again.");
        }
        if (
          expectedPrimary?.expectedSingleConfirmation !== undefined &&
          lockedRun.entityKind === "order" &&
          ot.entityId === lockedRun.entityId &&
          expectedPrimary.expectedSingleConfirmation.trim() !== oRow.reference
        ) {
          throw validation(
            "CONFIRMATION_MISMATCH",
            "The confirmation you typed doesn't match. Nothing was deleted.",
          );
        }
        if (!oRow.purgedAt) {
          await ordersTrash.markPurgeStartedInTx(tx, {
            orderId: ot.entityId,
            runId: lockedRun.publicId,
            actor,
          });
        }
        lockedOrderRows.set(ot.entityId, oRow);
      }
    }

    // Revalidate live/held additions or live/held customer orders and system due cutoff under target locks.
    if (lockedRun.entityKind === "order") {
      const primaryOrd = lockedOrderRows.get(lockedRun.entityId);
      if (primaryOrd && primaryOrd.groupRootOrderId === null) {
        const [badAdd] = await tx
          .select({ id: orders.id, lockState: orders.lockState, trashedAt: orders.trashedAt })
          .from(orders)
          .where(
            and(
              eq(orders.groupRootOrderId, primaryOrd.id),
              isNull(orders.purgedAt),
              or(isNull(orders.trashedAt), eq(orders.lockState, "legal_hold")),
            ),
          )
          .for("share")
          .limit(1);
        if (badAdd?.lockState === "legal_hold") throw legalHoldError();
        if (badAdd && badAdd.trashedAt === null) {
          throw conflict(
            "ROOT_HAS_LIVE_ADDITIONS",
            "Move all add-on orders in this project to the trash before deleting the first order permanently.",
          );
        }
      }
      if (actor.kind === "system" && primaryOrd && !primaryOrd.purgedAt && primaryOrd.trashedAt) {
        const retention = await readRetentionValues(tx, true);
        const { dueAt, movedWithCustomer } = computeOrderDueAt(
          primaryOrd.trashedAt,
          lockedRun.batchId,
          primaryOrderOwnerSnapshot && !primaryOrderOwnerSnapshot.purgedAt
            ? {
                trashedAt: primaryOrderOwnerSnapshot.trashedAt,
                trashBatchId: primaryOrderOwnerSnapshot.trashBatchId,
              }
            : undefined,
          retention,
        );
        if (movedWithCustomer || !dueAt || dueAt.getTime() > nowMs) {
          throw conflict("NOT_DUE", "This order is not yet due for automatic clean-up.");
        }
      }
    } else {
      const primaryCust = lockedCustomerRows.get(lockedRun.entityId);
      const [badCustOrd] = await tx
        .select({ id: orders.id, lockState: orders.lockState, trashedAt: orders.trashedAt })
        .from(orders)
        .where(
          and(
            eq(orders.ownerUserId, lockedRun.entityId),
            isNull(orders.purgedAt),
            or(isNull(orders.trashedAt), eq(orders.lockState, "legal_hold")),
          ),
        )
        .for("share")
        .limit(1);
      if (badCustOrd?.lockState === "legal_hold") throw legalHoldError();
      if (badCustOrd && badCustOrd.trashedAt === null) {
        throw conflict(
          "CUSTOMER_HAS_LIVE_ORDERS",
          "Move all live orders of this customer account to the trash before deleting the account permanently.",
        );
      }
      if (actor.kind === "system" && primaryCust && !primaryCust.purgedAt && primaryCust.trashedAt) {
        const retention = await readRetentionValues(tx, true);
        const dueAt = retention.autoPurgeEnabled
          ? addDays(primaryCust.trashedAt, retention.customerDays)
          : null;
        if (!dueAt || dueAt.getTime() > nowMs) {
          throw conflict("NOT_DUE", "This customer account is not yet due for automatic clean-up.");
        }
      }
    }

    const nextToken = lockedRun.fencingToken + 1;
    const parsedCounts = parseCounts(lockedRun.countsJson);
    const meta = parseRunMeta(lockedRun.checkpointJson);

    const leaseExpiresAt = new Date(nowMs + runLeaseMs);
    await tx
      .update(trashPurgeRuns)
      .set({
        status: "running",
        fencingToken: nextToken,
        leaseOwner: workerLeaseOwner,
        leaseExpiresAt,
        attemptCount: lockedRun.attemptCount + 1,
        errorCode: null,
        failedModule: null,
        failedTargetPublicId: null,
        nextRetryAt: null,
        finishedAt: null,
        updatedAt: now,
      })
      .where(and(eq(trashPurgeRuns.id, lockedRun.id), eq(trashPurgeRuns.fencingToken, lockedRun.fencingToken)));

    await bindIdempotencyClaimInTx({
      tx,
      idempotencyRowId,
      attemptOwner,
      runPublicId: lockedRun.publicId,
      bindingKey,
      batchId: lockedRun.batchId,
      now,
    });

    return {
      alreadyCompleted: false,
      runRowId: lockedRun.id,
      runId: lockedRun.publicId,
      batchId: lockedRun.batchId,
      fencingToken: nextToken,
      expectedModules: meta.expectedModules,
      targets: targetRows,
      counts: parsedCounts,
      acknowledgedOrderPublicId,
    };
  }

  /**
   * Claims or resumes one durable, pure-row-fenced purge run for an order or customer.
   */
  async function executePurgeOne(params: {
    item: TrashItemRef;
    actor: TrashActor;
    auditPrincipal?: SessionPrincipal;
    bulkCount: number;
    expectedSingleConfirmation?: string;
    sweepPublicId?: string;
    sweepFence?: {
      sweepRowId: number;
      sweepToken: number;
      sweepLeaseOwner: string;
      jobFence?: TrashCleanupJobFence;
    };
    idempotencyRowId?: number;
    attemptOwner?: string;
    acknowledgeExternal?: {
      runPublicId: string;
      targetOrderPublicId?: string;
      confirmation: string;
    };
    onClaimCommitted?: (batchId: string) => void;
  }): Promise<{ runId: string; batchId: string; keptExternalCopies: number }> {
    const {
      item,
      actor,
      auditPrincipal,
      bulkCount,
      expectedSingleConfirmation,
      sweepPublicId,
      sweepFence,
      idempotencyRowId,
      attemptOwner,
      acknowledgeExternal,
      onClaimCommitted,
    } = params;
    const triggerLabel = actor.kind === "user" ? "administrator" : "auto_cleanup";
    const ordersTrash = requireOrdersTrash();
    const idTrash = requireIdentityTrash();
    const workerLeaseOwner = ulid(deps.clock.now().getTime());
    const bindingKey = `${item.kind}:${item.publicId}`;

    type PhaseOneClaimResult = Awaited<ReturnType<typeof resumeExistingPurgeRunInTx>>;
    let claimed: PhaseOneClaimResult | undefined;

    for (let claimAttempt = 0; claimAttempt < 3; claimAttempt += 1) {
      try {
        // Phase 1: Synchronized lock + durable per-target ownership claim / resume inside TX.
        // Canonical lock order:
        //   job_runs (if jobFence) -> trash_cleanup_sweeps (if sweep) -> trash_purge_runs -> trash_purge_run_targets -> users (id ASC) -> orders (id ASC) -> trash_idempotency_keys.
        claimed = await deps.db.transaction(async (tx) => {
          if (sweepFence) {
            if (sweepFence.jobFence) {
              if (sweepFence.jobFence.signal.aborted) {
                throw conflict("SWEEP_FENCE_LOST", "Retention clean-up job was aborted.");
              }
              try {
                await sweepFence.jobFence.assertStillOwned(tx);
              } catch {
                throw conflict("SWEEP_FENCE_LOST", "Retention clean-up job lost ownership.");
              }
            }
            const sNow = deps.clock.now();
            const [currSweep] = await tx
              .select({
                status: trashCleanupSweeps.status,
                activeSlot: trashCleanupSweeps.activeSlot,
                fencingToken: trashCleanupSweeps.fencingToken,
                leaseOwner: trashCleanupSweeps.leaseOwner,
                leaseExpiresAt: trashCleanupSweeps.leaseExpiresAt,
              })
              .from(trashCleanupSweeps)
              .where(eq(trashCleanupSweeps.id, sweepFence.sweepRowId))
              .for("update")
              .limit(1);
            if (
              !currSweep ||
              currSweep.status !== "running" ||
              currSweep.activeSlot !== 1 ||
              currSweep.fencingToken !== sweepFence.sweepToken ||
              currSweep.leaseOwner !== sweepFence.sweepLeaseOwner ||
              currSweep.leaseExpiresAt === null ||
              currSweep.leaseExpiresAt.getTime() <= sNow.getTime()
            ) {
              throw conflict("SWEEP_FENCE_LOST", "Retention clean-up sweep lost its lease.");
            }
            await tx
              .update(trashCleanupSweeps)
              .set({ leaseExpiresAt: new Date(sNow.getTime() + sweepLeaseMs) })
              .where(eq(trashCleanupSweeps.id, sweepFence.sweepRowId));
          }

          if (auditPrincipal) {
            const maint = await isMaintenanceBlockingCleanup(tx);
            if (maint === "WORKER_DRAINING") {
              throw conflict("MAINTENANCE_ACTIVE", "Workers are draining for maintenance. Try again shortly.");
            }
            await guardActorInTx(tx, auditPrincipal, "trash.purge");
          } else {
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

          // Fail closed BEFORE claiming or mutating any run row if the current manifest is incomplete or missing a purge handler!
          resolveParticipantsOrFail(computeExpectedModules());

          const now = deps.clock.now();
          const nowMs = now.getTime();

          // Explicit `finishLeavingExternalCopies` resumption by `runPublicId` (`run-first`: locks `trash_purge_runs` BEFORE `users`/`orders`!)
          if (acknowledgeExternal !== undefined) {
            const [targetRun] = await tx
              .select()
              .from(trashPurgeRuns)
              .where(eq(trashPurgeRuns.publicId, acknowledgeExternal.runPublicId))
              .limit(1);
            if (!targetRun) throw notFound("PURGE_RUN_NOT_FOUND");

            const runTargets = await tx
              .select()
              .from(trashPurgeRunTargets)
              .where(eq(trashPurgeRunTargets.runId, targetRun.id))
              .orderBy(asc(trashPurgeRunTargets.position));

            const matchesPrimary =
              targetRun.entityKind === item.kind &&
              targetRun.entityPublicId === item.publicId &&
              (!item.batchId || targetRun.batchId === item.batchId);
            const matchesTarget = runTargets.some(
              (t) =>
                t.entityKind === item.kind &&
                t.entityPublicId === item.publicId &&
                (!item.batchId || t.batchId === item.batchId),
            );
            if (!matchesPrimary && !matchesTarget) {
              throw conflict("STALE", "The failed deletion run does not match this item or trash batch.");
            }

            return resumeExistingPurgeRunInTx({
              tx,
              existingRun: targetRun,
              actor,
              auditPrincipal,
              now,
              workerLeaseOwner,
              idempotencyRowId,
              attemptOwner,
              bindingKey,
              acknowledgeExternal: {
                targetOrderPublicId: acknowledgeExternal.targetOrderPublicId,
                confirmation: acknowledgeExternal.confirmation,
              },
            });
          }

          if (item.kind === "order") {
            const [preOrder] = await tx
              .select({
                id: orders.id,
                ownerUserId: orders.ownerUserId,
                groupRootOrderId: orders.groupRootOrderId,
              })
              .from(orders)
              .where(eq(orders.publicId, item.publicId))
              .limit(1);
            if (!preOrder) throw notFound("ORDER_NOT_FOUND");

            const preAdditions =
              preOrder.groupRootOrderId === null
                ? await tx
                    .select({ id: orders.id, ownerUserId: orders.ownerUserId })
                    .from(orders)
                    .where(and(eq(orders.groupRootOrderId, preOrder.id), isNull(orders.purgedAt)))
                    .orderBy(asc(orders.id))
                    .limit(MAX_CASCADE_TARGETS + 1)
                : [];
            if (preAdditions.length > MAX_CASCADE_TARGETS) {
              throw conflict("CASCADE_TOO_LARGE", "This order group has too many additions to delete at once.");
            }

            const candidateIds = [preOrder.id, ...preAdditions.map((a) => a.id)].sort((a, b) => a - b);

            // Unlocked check for existing target ownership BEFORE acquiring any `users`/`orders` locks!
            const preExistingTargets = await tx
              .select({ runId: trashPurgeRunTargets.runId })
              .from(trashPurgeRunTargets)
              .where(
                and(
                  eq(trashPurgeRunTargets.entityKind, "order"),
                  inArray(trashPurgeRunTargets.entityId, candidateIds),
                ),
              );

            if (preExistingTargets.length > 0) {
              const distinctRunIds = [...new Set(preExistingTargets.map((t) => t.runId))].sort(
                (a, b) => a - b,
              );
              const preOwningRuns = await tx
                .select()
                .from(trashPurgeRuns)
                .where(inArray(trashPurgeRuns.id, distinctRunIds))
                .orderBy(asc(trashPurgeRuns.id));

              if (
                preOwningRuns.length === 1 &&
                preOwningRuns[0]!.entityKind === "order" &&
                preOwningRuns[0]!.entityId === preOrder.id
              ) {
                return resumeExistingPurgeRunInTx({
                  tx,
                  existingRun: preOwningRuns[0]!,
                  actor,
                  auditPrincipal,
                  now,
                  workerLeaseOwner,
                  idempotencyRowId,
                  attemptOwner,
                  bindingKey,
                  expectedPrimary: { item, expectedSingleConfirmation },
                });
              }

              if (preOwningRuns.length > 0) {
                const lockedConflictRuns = await tx
                  .select()
                  .from(trashPurgeRuns)
                  .where(inArray(trashPurgeRuns.id, distinctRunIds))
                  .orderBy(asc(trashPurgeRuns.id))
                  .for("share");
                const conflictingRun = lockedConflictRuns[0];
                if (conflictingRun) {
                  throw new DomainError(
                    "CONFLICT",
                    "PURGE_ALREADY_OWNED",
                    "Permanent deletion is already owned by an existing deletion run. Resume that run first.",
                    {
                      owningRunPublicId: conflictingRun.publicId,
                      owningEntityKind: conflictingRun.entityKind,
                      owningEntityPublicId: conflictingRun.entityPublicId,
                    },
                  );
                }
              }
            }

            // Initial claim path (no owning run existed on unlocked read): lock `users -> orders` in `id ASC`.
            const allOwnerIds = [
              ...new Set([preOrder.ownerUserId, ...preAdditions.map((a) => a.ownerUserId)]),
            ].sort((a, b) => a - b);
            const lockedOwners = await tx
              .select({
                id: users.id,
                trashedAt: users.trashedAt,
                trashBatchId: users.trashBatchId,
                purgedAt: users.purgedAt,
              })
              .from(users)
              .where(inArray(users.id, allOwnerIds))
              .orderBy(asc(users.id))
              .for("share");
            const lockedOwner = lockedOwners.find((u) => u.id === preOrder.ownerUserId);

            const lockedOrders = await tx
              .select()
              .from(orders)
              .where(inArray(orders.id, candidateIds))
              .orderBy(asc(orders.id))
              .for("update");
            const lockedPrimary = lockedOrders.find((o) => o.id === preOrder.id);
            if (!lockedPrimary) throw notFound("ORDER_NOT_FOUND");

            // Re-verify complete group additions under lock (including cross-batch or reassigned additions).
            let groupAdditions: (typeof orders.$inferSelect)[] = [];
            if (!lockedPrimary.purgedAt && lockedPrimary.groupRootOrderId === null) {
              const liveCheck = await tx
                .select({ id: orders.id })
                .from(orders)
                .where(and(eq(orders.groupRootOrderId, lockedPrimary.id), isNull(orders.purgedAt)))
                .orderBy(asc(orders.id))
                .limit(MAX_CASCADE_TARGETS + 1);
              if (liveCheck.length > MAX_CASCADE_TARGETS) {
                throw conflict("CASCADE_TOO_LARGE", "This order group has too many additions to delete at once.");
              }
              if (liveCheck.length > 0) {
                groupAdditions = await tx
                  .select()
                  .from(orders)
                  .where(inArray(orders.id, liveCheck.map((r) => r.id)))
                  .orderBy(asc(orders.id))
                  .for("update");
              }
            }

            const allOrderIdsForRaceCheck = [
              ...new Set([lockedPrimary.id, ...groupAdditions.map((o) => o.id)]),
            ];
            const racedTargets = await tx
              .select({ id: trashPurgeRunTargets.id })
              .from(trashPurgeRunTargets)
              .where(
                and(
                  eq(trashPurgeRunTargets.entityKind, "order"),
                  inArray(trashPurgeRunTargets.entityId, allOrderIdsForRaceCheck),
                ),
              )
              .limit(1);
            if (racedTargets.length > 0) {
              // Concurrent claim created a run while we were locking `users`/`orders`; never lock `trash_purge_runs` after `orders`!
              throw new RetryRunFirstSignal();
            }

            if (lockedPrimary.purgedAt) {
              throw notFound("ORDER_NOT_FOUND");
            }
            if (!lockedPrimary.trashedAt || !lockedPrimary.trashBatchId) {
              throw conflict("NOT_IN_TRASH", "This order is no longer in the trash.");
            }
            if (lockedPrimary.lockState === "legal_hold") {
              throw legalHoldError();
            }
            if (actor.kind === "user" && !item.batchId) {
              throw validation("BATCH_ID_REQUIRED", "Include the trash batch identifier.");
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

            for (const add of groupAdditions) {
              if (add.lockState === "legal_hold") throw legalHoldError();
              if (!add.trashedAt || !add.trashBatchId) {
                throw conflict(
                  "ROOT_HAS_LIVE_ADDITIONS",
                  "Move all add-on orders in this project to the trash before deleting the first order permanently.",
                );
              }
            }

            const expectedBatchId = lockedPrimary.trashBatchId;

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

            const allOrderRows = [
              ...groupAdditions.sort((a, b) => a.id - b.id),
              lockedPrimary,
            ];

            const runId = ulid(nowMs);
            const expectedModules = computeExpectedModules();
            const meta: PersistedRunMeta = { expectedModules };
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
              fencingToken: 1,
              leaseOwner: workerLeaseOwner,
              leaseExpiresAt: new Date(nowMs + runLeaseMs),
              targetsJson: "[]",
              checkpointJson: JSON.stringify(meta),
              countsJson: JSON.stringify(counts),
              attemptCount: 1,
              correlationId: expectedBatchId,
              startedAt: now,
              updatedAt: now,
            });
            const runRowId = Number(ins.insertId);

            const insertedTargets: TrashPurgeRunTargetRow[] = [];
            try {
              for (let idx = 0; idx < allOrderRows.length; idx++) {
                const ord = allOrderRows[idx]!;
                const [tIns] = await tx.insert(trashPurgeRunTargets).values({
                  runId: runRowId,
                  entityKind: "order",
                  entityId: ord.id,
                  entityPublicId: ord.publicId,
                  targetReference: ord.reference,
                  batchId: ord.trashBatchId!,
                  position: idx,
                  status: "pending",
                  checkpointJson: "{}",
                  createdAt: now,
                  updatedAt: now,
                });
                insertedTargets.push({
                  id: Number(tIns.insertId),
                  runId: runRowId,
                  entityKind: "order",
                  entityId: ord.id,
                  entityPublicId: ord.publicId,
                  targetReference: ord.reference,
                  batchId: ord.trashBatchId!,
                  position: idx,
                  status: "pending",
                  checkpointJson: "{}",
                  leaveExternalCopiesApprovedAt: null,
                  leaveExternalCopiesActorUserId: null,
                  leaveExternalCopiesProofJson: null,
                  tombstonedAt: null,
                  createdAt: now,
                  updatedAt: now,
                });
              }
            } catch (err) {
              if (isMysqlDupEntry(err)) {
                throw new RetryRunFirstSignal();
              }
              throw err;
            }

            await bindIdempotencyClaimInTx({
              tx,
              idempotencyRowId,
              attemptOwner,
              runPublicId: runId,
              bindingKey,
              batchId: expectedBatchId,
              now,
            });

            for (const ord of allOrderRows) {
              await ordersTrash.markPurgeStartedInTx(tx, { orderId: ord.id, runId, actor });
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
                  correlationId: ord.trashBatchId!,
                  attributes: {
                    order_public_id: ord.publicId,
                    trash_batch_id: ord.trashBatchId!,
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
              runRowId,
              runId,
              batchId: expectedBatchId,
              fencingToken: 1,
              expectedModules,
              targets: insertedTargets,
              counts,
              acknowledgedOrderPublicId: null,
            };
          }

          // Customer target: unlocked pre-read of customer + cascaded orders to check existing run ownership FIRST!
          const [preCust] = await tx
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.publicId, item.publicId), eq(users.role, "customer")))
            .limit(1);
          if (!preCust) throw notFound("CUSTOMER_NOT_FOUND");

          const preOwnedOrders = await tx
            .select({ id: orders.id, ownerUserId: orders.ownerUserId, groupRootOrderId: orders.groupRootOrderId })
            .from(orders)
            .where(and(eq(orders.ownerUserId, preCust.id), isNull(orders.purgedAt)))
            .orderBy(asc(orders.id))
            .limit(MAX_CASCADE_TARGETS + 1);
          if (preOwnedOrders.length > MAX_CASCADE_TARGETS) {
            throw conflict("CASCADE_TOO_LARGE", "This customer account has too many orders to delete at once.");
          }

          const ownedRootIds = preOwnedOrders
            .filter((o) => o.groupRootOrderId === null)
            .map((o) => o.id);
          const preReassignedAdditions =
            ownedRootIds.length > 0
              ? await tx
                  .select({ id: orders.id, ownerUserId: orders.ownerUserId })
                  .from(orders)
                  .where(
                    and(
                      inArray(orders.groupRootOrderId, ownedRootIds),
                      ne(orders.ownerUserId, preCust.id),
                      isNull(orders.purgedAt),
                    ),
                  )
                  .orderBy(asc(orders.id))
                  .limit(MAX_CASCADE_TARGETS + 1)
              : [];
          if (preOwnedOrders.length + preReassignedAdditions.length > MAX_CASCADE_TARGETS) {
            throw conflict("CASCADE_TOO_LARGE", "This customer account has too many orders to delete at once.");
          }

          const preCascadeIds = [
            ...new Set([
              ...preOwnedOrders.map((o) => o.id),
              ...preReassignedAdditions.map((a) => a.id),
            ]),
          ];
          const preCustLookupPredicates = [
            and(
              eq(trashPurgeRunTargets.entityKind, "customer"),
              eq(trashPurgeRunTargets.entityId, preCust.id),
            ),
            ...(preCascadeIds.length > 0
              ? [
                  and(
                    eq(trashPurgeRunTargets.entityKind, "order"),
                    inArray(trashPurgeRunTargets.entityId, preCascadeIds),
                  ),
                ]
              : []),
          ];

          const preExistingCustTargets = await tx
            .select({ runId: trashPurgeRunTargets.runId })
            .from(trashPurgeRunTargets)
            .where(or(...preCustLookupPredicates));

          if (preExistingCustTargets.length > 0) {
            const distinctRunIds = [...new Set(preExistingCustTargets.map((t) => t.runId))].sort(
              (a, b) => a - b,
            );
            const preOwningRuns = await tx
              .select()
              .from(trashPurgeRuns)
              .where(inArray(trashPurgeRuns.id, distinctRunIds))
              .orderBy(asc(trashPurgeRuns.id));

            if (
              preOwningRuns.length === 1 &&
              preOwningRuns[0]!.entityKind === "customer" &&
              preOwningRuns[0]!.entityId === preCust.id
            ) {
              return resumeExistingPurgeRunInTx({
                tx,
                existingRun: preOwningRuns[0]!,
                actor,
                auditPrincipal,
                now,
                workerLeaseOwner,
                idempotencyRowId,
                attemptOwner,
                bindingKey,
                expectedPrimary: { item, expectedSingleConfirmation },
              });
            }

            if (preOwningRuns.length > 0) {
              const lockedConflictRuns = await tx
                .select()
                .from(trashPurgeRuns)
                .where(inArray(trashPurgeRuns.id, distinctRunIds))
                .orderBy(asc(trashPurgeRuns.id))
                .for("share");
              const conflictingRun = lockedConflictRuns[0];
              if (conflictingRun) {
                throw new DomainError(
                  "CONFLICT",
                  "PURGE_ALREADY_OWNED",
                  "An associated order or account already has an unfinished permanent deletion run. Resume that run first.",
                  {
                    owningRunPublicId: conflictingRun.publicId,
                    owningEntityKind: conflictingRun.entityKind,
                    owningEntityPublicId: conflictingRun.entityPublicId,
                  },
                );
              }
            }
          }

          // Initial claim path: lock `users` (`id ASC`) BEFORE `orders` (`id ASC`).
          const otherOwnerIds = [...new Set(preReassignedAdditions.map((a) => a.ownerUserId))].sort(
            (a, b) => a - b,
          );
          const allUserIdsSorted = [...new Set([preCust.id, ...otherOwnerIds])].sort((a, b) => a - b);

          let lockedCust: typeof users.$inferSelect | undefined;
          for (const uid of allUserIdsSorted) {
            if (uid === preCust.id) {
              const [cRow] = await tx
                .select()
                .from(users)
                .where(and(eq(users.id, uid), eq(users.role, "customer")))
                .for("update")
                .limit(1);
              lockedCust = cRow;
            } else {
              await tx.select({ id: users.id }).from(users).where(eq(users.id, uid)).for("share").limit(1);
            }
          }
          if (!lockedCust) throw notFound("CUSTOMER_NOT_FOUND");

          const lockedCascadeOrders =
            preCascadeIds.length > 0
              ? await tx
                  .select()
                  .from(orders)
                  .where(inArray(orders.id, preCascadeIds))
                  .orderBy(asc(orders.id))
                  .for("update")
              : [];

          const nonPurgedOrders = lockedCascadeOrders.filter((o) => o.purgedAt === null);
          const orderedCascadeOrders = [...nonPurgedOrders].sort((a, b) => a.id - b.id);
          const raceLookupPredicates = [
            and(
              eq(trashPurgeRunTargets.entityKind, "customer"),
              eq(trashPurgeRunTargets.entityId, lockedCust.id),
            ),
            ...(orderedCascadeOrders.length > 0
              ? [
                  and(
                    eq(trashPurgeRunTargets.entityKind, "order"),
                    inArray(
                      trashPurgeRunTargets.entityId,
                      orderedCascadeOrders.map((o) => o.id),
                    ),
                  ),
                ]
              : []),
          ];
          const racedCustTargets = await tx
            .select({ id: trashPurgeRunTargets.id })
            .from(trashPurgeRunTargets)
            .where(or(...raceLookupPredicates))
            .limit(1);
          if (racedCustTargets.length > 0) {
            // Concurrent claim inserted target rows while we locked `users`/`orders`; restart to lock `trash_purge_runs` FIRST!
            throw new RetryRunFirstSignal();
          }

          if (lockedCust.purgedAt) {
            throw notFound("CUSTOMER_NOT_FOUND");
          }
          if (!lockedCust.trashedAt || !lockedCust.trashBatchId) {
            throw conflict("NOT_IN_TRASH", "This customer account is no longer in the trash.");
          }
          if (actor.kind === "user" && !item.batchId) {
            throw validation("BATCH_ID_REQUIRED", "Include the trash batch identifier.");
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

          const runId = ulid(nowMs);
          const expectedModules = computeExpectedModules();
          const meta: PersistedRunMeta = { expectedModules };
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
            fencingToken: 1,
            leaseOwner: workerLeaseOwner,
            leaseExpiresAt: new Date(nowMs + runLeaseMs),
            targetsJson: "[]",
            checkpointJson: JSON.stringify(meta),
            countsJson: JSON.stringify(counts),
            attemptCount: 1,
            correlationId: expectedBatchId,
            startedAt: now,
            updatedAt: now,
          });
          const runRowId = Number(ins.insertId);

          const insertedTargets: TrashPurgeRunTargetRow[] = [];
          try {
            let pos = 0;
            for (const ord of orderedCascadeOrders) {
              const [tIns] = await tx.insert(trashPurgeRunTargets).values({
                runId: runRowId,
                entityKind: "order",
                entityId: ord.id,
                entityPublicId: ord.publicId,
                targetReference: ord.reference,
                batchId: ord.trashBatchId!,
                position: pos,
                status: "pending",
                checkpointJson: "{}",
                createdAt: now,
                updatedAt: now,
              });
              insertedTargets.push({
                id: Number(tIns.insertId),
                runId: runRowId,
                entityKind: "order",
                entityId: ord.id,
                entityPublicId: ord.publicId,
                targetReference: ord.reference,
                batchId: ord.trashBatchId!,
                position: pos,
                status: "pending",
                checkpointJson: "{}",
                leaveExternalCopiesApprovedAt: null,
                leaveExternalCopiesActorUserId: null,
                leaveExternalCopiesProofJson: null,
                tombstonedAt: null,
                createdAt: now,
                updatedAt: now,
              });
              pos += 1;
            }

            const [custTargetIns] = await tx.insert(trashPurgeRunTargets).values({
              runId: runRowId,
              entityKind: "customer",
              entityId: lockedCust.id,
              entityPublicId: lockedCust.publicId,
              targetReference: expectedRef,
              batchId: expectedBatchId,
              position: pos,
              status: "pending",
              checkpointJson: "{}",
              createdAt: now,
              updatedAt: now,
            });
            insertedTargets.push({
              id: Number(custTargetIns.insertId),
              runId: runRowId,
              entityKind: "customer",
              entityId: lockedCust.id,
              entityPublicId: lockedCust.publicId,
              targetReference: expectedRef,
              batchId: expectedBatchId,
              position: pos,
              status: "pending",
              checkpointJson: "{}",
              leaveExternalCopiesApprovedAt: null,
              leaveExternalCopiesActorUserId: null,
              leaveExternalCopiesProofJson: null,
              tombstonedAt: null,
              createdAt: now,
              updatedAt: now,
            });
          } catch (err) {
            if (isMysqlDupEntry(err)) {
              throw new RetryRunFirstSignal();
            }
            throw err;
          }

          await bindIdempotencyClaimInTx({
            tx,
            idempotencyRowId,
            attemptOwner,
            runPublicId: runId,
            bindingKey,
            batchId: expectedBatchId,
            now,
          });

        for (const ord of orderedCascadeOrders) {
          await ordersTrash.markPurgeStartedInTx(tx, { orderId: ord.id, runId, actor });
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

        await idTrash.markPurgeStartedInTx(tx, lockedCust.id, {
          batchId: expectedBatchId,
          runId,
          actor,
        });
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
            safeCounts: { cascaded_orders: orderedCascadeOrders.length },
            attributes: {
              customer_public_id: lockedCust.publicId,
              trash_batch_id: expectedBatchId,
              run_public_id: runId,
              trigger: triggerLabel,
              bulk_count: bulkCount,
              cascaded_orders: orderedCascadeOrders.length,
            },
          },
          tx,
        );

          return {
            alreadyCompleted: false as const,
            runRowId,
            runId,
            batchId: expectedBatchId,
            fencingToken: 1,
            expectedModules,
            targets: insertedTargets,
            counts,
            acknowledgedOrderPublicId: null,
          };
        });
        break;
      } catch (err) {
        if (err instanceof RetryRunFirstSignal && claimAttempt < 2) {
          continue;
        }
        throw err;
      }
    }

    if (!claimed) {
      throw conflict("PURGE_IN_PROGRESS", "Permanent deletion is already running for this item.");
    }

    onClaimCommitted?.(claimed.batchId);

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
        fencingToken,
        expectedModules,
        targets,
        counts,
        acknowledgedOrderPublicId,
      } = claimed;

      let fenceLostFlag = false;
      let keptForAcknowledgedOrder = 0;

      async function assertCurrentInParticipantTx(tx: Tx): Promise<void> {
        if (fenceLostFlag) {
          throw conflict("PURGE_FENCE_LOST", "Permanent deletion claim was superseded.");
        }
        const [row] = await tx
          .select({
            status: trashPurgeRuns.status,
            fencingToken: trashPurgeRuns.fencingToken,
            leaseOwner: trashPurgeRuns.leaseOwner,
          })
          .from(trashPurgeRuns)
          .where(eq(trashPurgeRuns.id, runRowId))
          .for("share")
          .limit(1);
        if (
          !row ||
          row.status !== "running" ||
          row.fencingToken !== fencingToken ||
          row.leaseOwner !== workerLeaseOwner
        ) {
          fenceLostFlag = true;
          throw conflict("PURGE_FENCE_LOST", "Permanent deletion claim was superseded.");
        }
      }

      async function assertFencedRunInTx(tx: Tx): Promise<TrashPurgeRunRow> {
        if (fenceLostFlag) {
          throw conflict("PURGE_FENCE_LOST", "Permanent deletion claim was superseded.");
        }
        const [liveRun] = await tx
          .select()
          .from(trashPurgeRuns)
          .where(eq(trashPurgeRuns.id, runRowId))
          .for("update")
          .limit(1);
        if (
          !liveRun ||
          liveRun.status !== "running" ||
          liveRun.fencingToken !== fencingToken ||
          liveRun.leaseOwner !== workerLeaseOwner
        ) {
          fenceLostFlag = true;
          throw conflict("PURGE_FENCE_LOST", "Permanent deletion claim was superseded.");
        }
        const extNow = deps.clock.now();
        await tx
          .update(trashPurgeRuns)
          .set({
            leaseExpiresAt: new Date(extNow.getTime() + runLeaseMs),
            updatedAt: extNow,
          })
          .where(
            and(
              eq(trashPurgeRuns.id, runRowId),
              eq(trashPurgeRuns.status, "running"),
              eq(trashPurgeRuns.fencingToken, fencingToken),
              eq(trashPurgeRuns.leaseOwner, workerLeaseOwner),
            ),
          );
        return liveRun;
      }

      async function renewRunLeaseByCas(): Promise<void> {
        if (fenceLostFlag) {
          throw conflict("PURGE_FENCE_LOST", "Permanent deletion claim was superseded.");
        }
        await deps.db.transaction(async (tx) => {
          await assertFencedRunInTx(tx);
        });
      }

      async function runStepWithHeartbeat<T>(fn: () => Promise<T>): Promise<T> {
        let heartbeatBusy = false;
        const timer = setInterval(() => {
          if (heartbeatBusy || fenceLostFlag) return;
          heartbeatBusy = true;
          void renewRunLeaseByCas()
            .catch(() => {
              // If lease renewal fails for any reason, mark the fence lost immediately so this worker stops.
              fenceLostFlag = true;
            })
            .finally(() => {
              heartbeatBusy = false;
            });
        }, runHeartbeatMs);
        timer.unref?.();
        try {
          return await fn();
        } finally {
          clearInterval(timer);
        }
      }

      let activeTargetPublicId: string | null = null;
      let activeModuleName: string | null = null;

      try {
        // Phase 2: Fail closed if any expected participant is missing or lacks a `purge` handler.
        const requiredModules = [...new Set([...expectedModules, ...computeExpectedModules()])];
        const participants = resolveParticipantsOrFail(requiredModules);

        for (const targetRow of targets) {
          if (targetRow.status === "completed") continue;
          activeTargetPublicId = targetRow.entityPublicId;
          const targetRef: TrashEntityRef = {
            kind: targetRow.entityKind,
            id: targetRow.entityId,
            publicId: targetRow.entityPublicId,
            batchId: targetRow.batchId,
          };
          const targetCp = parseTargetCheckpoint(targetRow.checkpointJson);

          if (targetRow.status === "pending") {
            await deps.db.transaction(async (tx) => {
              await assertFencedRunInTx(tx);
              await tx
                .update(trashPurgeRunTargets)
                .set({ status: "running", updatedAt: deps.clock.now() })
                .where(eq(trashPurgeRunTargets.id, targetRow.id));
            });
            targetRow.status = "running";
          }

          for (const participant of participants) {
            if (Object.prototype.hasOwnProperty.call(targetCp, participant.module)) {
              const existingStep = targetCp[participant.module];
              if (
                participant.module === "files" &&
                acknowledgedOrderPublicId === targetRow.entityPublicId &&
                existingStep?.kept?.acknowledgedExternalCopies
              ) {
                keptForAcknowledgedOrder = existingStep.kept.acknowledgedExternalCopies;
              }
              continue;
            }
            activeModuleName = participant.module;
            // Renew lease by token-CAS before every step; if renewal fails, stop immediately!
            await renewRunLeaseByCas();

            let stepResult: TrashPurgeResult = { deleted: {} };
            if (participant.purge) {
              let passScopedOrderAck = false;
              if (
                actor.kind === "user" &&
                targetRow.entityKind === "order" &&
                targetRow.leaveExternalCopiesApprovedAt !== null &&
                targetRow.leaveExternalCopiesProofJson !== null
              ) {
                try {
                  const parsedProof = JSON.parse(
                    targetRow.leaveExternalCopiesProofJson,
                  ) as ExternalCopyProof;
                  if (
                    parsedProof.runId === runId &&
                    parsedProof.orderPublicId === targetRow.entityPublicId
                  ) {
                    if (Array.isArray(parsedProof.stamps) && parsedProof.stamps.length > 0) {
                      const journalPrefix = `trash-un:${runId}:`;
                      const liveJournal = await deps.db
                        .select({
                          jobPublicId: storageCopyAttempts.jobPublicId,
                          sourcePublicId: storageCopyAttempts.sourcePublicId,
                          connectionPublicId: storageCopyAttempts.connectionPublicId,
                        })
                        .from(storageCopyAttempts)
                        .where(
                          and(
                            eq(storageCopyAttempts.kind, "order_file"),
                            eq(storageCopyAttempts.orderPublicId, targetRow.entityPublicId),
                            eq(storageCopyAttempts.errorCode, "EXTERNAL_COPIES_UNREACHABLE"),
                            like(storageCopyAttempts.jobPublicId, `${journalPrefix}%`),
                          ),
                        );
                      const approvedSet = new Set(parsedProof.stamps);
                      passScopedOrderAck =
                        liveJournal.length > 0 &&
                        liveJournal.every((r) =>
                          approvedSet.has(
                            `${r.jobPublicId.slice(journalPrefix.length)}:${r.sourcePublicId}:${r.connectionPublicId}`,
                          ),
                        );
                    } else if (!services().storageConnections) {
                      passScopedOrderAck = true;
                    }
                  }
                } catch {
                  passScopedOrderAck = false;
                }
              }
              const purgeRunFence: TrashPurgeRun = {
                runId,
                ...(passScopedOrderAck ? { acknowledgedUnreachableCopies: true } : {}),
                assertCurrentInTx: assertCurrentInParticipantTx,
              };
              stepResult = await runStepWithHeartbeat(() => participant.purge!(targetRef, purgeRunFence));
            }

            if (
              participant.module === "files" &&
              targetRow.entityKind === "order" &&
              targetRow.entityPublicId === acknowledgedOrderPublicId
            ) {
              keptForAcknowledgedOrder = stepResult.kept?.acknowledgedExternalCopies ?? 0;
            }

            targetCp[participant.module] = {
              deleted: stepResult.deleted ?? {},
              ...(stepResult.kept ? { kept: stepResult.kept } : {}),
            };
            mergeCounts(counts.deleted, stepResult.deleted);
            mergeCounts(counts.kept, stepResult.kept);

            await deps.db.transaction(async (tx) => {
              await assertFencedRunInTx(tx);
              const stepNow = deps.clock.now();
              await tx
                .update(trashPurgeRunTargets)
                .set({
                  checkpointJson: JSON.stringify(targetCp),
                  updatedAt: stepNow,
                })
                .where(eq(trashPurgeRunTargets.id, targetRow.id));
              await tx
                .update(trashPurgeRuns)
                .set({
                  countsJson: JSON.stringify(counts),
                  updatedAt: stepNow,
                })
                .where(
                  and(
                    eq(trashPurgeRuns.id, runRowId),
                    eq(trashPurgeRuns.fencingToken, fencingToken),
                    eq(trashPurgeRuns.leaseOwner, workerLeaseOwner),
                  ),
                );
            });
            activeModuleName = null;
          }
          activeTargetPublicId = null;
        }

        // Phase 3: Lock `trash_purge_runs -> users -> orders -> trash_purge_run_targets` in strict `run-first` canonical order!
        await deps.db.transaction(async (tx) => {
          await assertFencedRunInTx(tx);

          const orderTargetRows = targets
            .filter((t) => t.entityKind === "order")
            .sort((a, b) => a.entityId - b.entityId);
          const customerTargetRows = targets
            .filter((t) => t.entityKind === "customer")
            .sort((a, b) => a.entityId - b.entityId);

          for (const ct of customerTargetRows) {
            const [cRow] = await tx
              .select({
                id: users.id,
                trashBatchId: users.trashBatchId,
                purgedAt: users.purgedAt,
              })
              .from(users)
              .where(eq(users.id, ct.entityId))
              .for("update")
              .limit(1);
            if (!cRow) throw notFound("CUSTOMER_NOT_FOUND");
            if (!cRow.purgedAt && cRow.trashBatchId !== ct.batchId) {
              throw conflict("STALE", "Customer trash generation changed before completion.");
            }
          }

          if (orderTargetRows.length > 0) {
            const lockedOrders = await tx
              .select({
                id: orders.id,
                lockState: orders.lockState,
                trashBatchId: orders.trashBatchId,
                purgedAt: orders.purgedAt,
              })
              .from(orders)
              .where(inArray(orders.id, orderTargetRows.map((t) => t.entityId)))
              .orderBy(asc(orders.id))
              .for("update");
            const byId = new Map(lockedOrders.map((o) => [o.id, o]));
            for (const ot of orderTargetRows) {
              const row = byId.get(ot.entityId);
              if (!row) throw notFound("ORDER_NOT_FOUND");
              if (row.lockState === "legal_hold") throw legalHoldError();
              if (!row.purgedAt && row.trashBatchId !== ot.batchId) {
                throw conflict("STALE", "Order trash generation changed before completion.");
              }
            }
          }

          for (const ct of customerTargetRows) {
            const [extraOrder] = await tx
              .select({ id: orders.id, lockState: orders.lockState, trashedAt: orders.trashedAt })
              .from(orders)
              .where(
                and(
                  eq(orders.ownerUserId, ct.entityId),
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

          const finishedAt = deps.clock.now();

          // Tombstone additions before roots (`entityId DESC`), then customers.
          const tombstoneOrdersDesc = [...orderTargetRows].sort((a, b) => b.entityId - a.entityId);
          for (const ot of tombstoneOrdersDesc) {
            await ordersTrash.tombstoneOrderInTx(tx, { orderId: ot.entityId, runId, actor });
            await tx
              .update(trashPurgeRunTargets)
              .set({ status: "completed", tombstonedAt: finishedAt, updatedAt: finishedAt })
              .where(eq(trashPurgeRunTargets.id, ot.id));
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
                resource: { type: "order", id: ot.entityId, publicId: ot.entityPublicId },
                orderPublicId: ot.entityPublicId,
                correlationId: batchId,
                safeCounts: safeCountsForAudit(counts.deleted),
                attributes: {
                  order_public_id: ot.entityPublicId,
                  trash_batch_id: ot.batchId,
                  run_public_id: runId,
                  trigger: triggerLabel,
                },
              },
              tx,
            );
          }

          for (const ct of customerTargetRows) {
            const done = await idTrash.tombstoneCustomerInTx(tx, ct.entityId, { runId, actor });
            mergeCounts(counts.deleted, done.erased);
            await tx
              .update(trashPurgeRunTargets)
              .set({ status: "completed", tombstonedAt: finishedAt, updatedAt: finishedAt })
              .where(eq(trashPurgeRunTargets.id, ct.id));
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
                resource: { type: "user", id: ct.entityId, publicId: ct.entityPublicId },
                correlationId: batchId,
                safeCounts: safeCountsForAudit(counts.deleted),
                attributes: {
                  customer_public_id: ct.entityPublicId,
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

          await tx
            .update(trashPurgeRuns)
            .set({
              status: "completed",
              leaseOwner: null,
              leaseExpiresAt: null,
              countsJson: JSON.stringify(counts),
              errorCode: null,
              failedModule: null,
              failedTargetPublicId: null,
              nextRetryAt: null,
              finishedAt,
              updatedAt: finishedAt,
            })
            .where(
              and(
                eq(trashPurgeRuns.id, runRowId),
                eq(trashPurgeRuns.fencingToken, fencingToken),
                eq(trashPurgeRuns.leaseOwner, workerLeaseOwner),
              ),
            );
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
          keptExternalCopies:
            acknowledgedOrderPublicId !== null
              ? keptForAcknowledgedOrder
              : (counts.kept.acknowledgedExternalCopies ?? 0),
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
              .select({
                status: trashPurgeRuns.status,
                fencingToken: trashPurgeRuns.fencingToken,
                leaseOwner: trashPurgeRuns.leaseOwner,
                attemptCount: trashPurgeRuns.attemptCount,
              })
              .from(trashPurgeRuns)
              .where(eq(trashPurgeRuns.id, runRowId))
              .for("update")
              .limit(1);
            if (
              !liveRun ||
              liveRun.status !== "running" ||
              liveRun.fencingToken !== fencingToken ||
              liveRun.leaseOwner !== workerLeaseOwner
            ) {
              return;
            }
            const failedAt = deps.clock.now();
            if (errorCode === "EXTERNAL_COPIES_UNREACHABLE" && activeTargetPublicId) {
              await tx
                .update(trashPurgeRunTargets)
                .set({
                  leaveExternalCopiesApprovedAt: null,
                  leaveExternalCopiesActorUserId: null,
                  leaveExternalCopiesProofJson: null,
                  updatedAt: failedAt,
                })
                .where(
                  and(
                    eq(trashPurgeRunTargets.runId, runRowId),
                    eq(trashPurgeRunTargets.entityPublicId, activeTargetPublicId),
                  ),
                );
            }
            const retryAt = new Date(failedAt.getTime() + computeRetryBackoffMs(liveRun.attemptCount));
            await tx
              .update(trashPurgeRuns)
              .set({
                status: "failed",
                leaseOwner: null,
                leaseExpiresAt: null,
                countsJson: JSON.stringify(counts),
                errorCode,
                failedModule: activeModuleName,
                failedTargetPublicId: activeTargetPublicId,
                nextRetryAt: retryAt,
                finishedAt: failedAt,
                updatedAt: failedAt,
              })
              .where(
                and(
                  eq(trashPurgeRuns.id, runRowId),
                  eq(trashPurgeRuns.fencingToken, fencingToken),
                  eq(trashPurgeRuns.leaseOwner, workerLeaseOwner),
                ),
              );
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
            orderPublicId: activeTargetPublicId ?? (item.kind === "order" ? item.publicId : undefined),
            correlationId: batchId,
            attributes: {
              ...(item.kind === "order"
                ? { order_public_id: item.publicId }
                : { customer_public_id: item.publicId }),
              ...(activeTargetPublicId ? { failed_target_public_id: activeTargetPublicId } : {}),
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
              orderPublicId: activeTargetPublicId ?? (item.kind === "order" ? item.publicId : undefined),
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
          owningPurgeRunsByEntity("order", orderItems.map((o) => o.id)),
        ]);

        for (const ord of orderItems) {
          const batchId = ord.batchId ?? "";
          const ownerMeta = ownerMap.get(ord.ownerUserId);
          const { dueAt } = computeOrderDueAt(ord.trashedAt, batchId, ownerMeta, retention);
          if (dueHorizonMs !== undefined) {
            if (!dueAt || dueAt.getTime() > dueHorizonMs) continue;
          }

          const owningRun = runStatusMap.get(ord.id);
          let state: TrashRow["state"] = "in_trash";
          let failureCode: string | null = null;
          let unreachableExternalCopies: number | null = null;
          let failedRunId: string | null = null;
          let failedTargetPublicId: string | null = null;
          let failedTargetReference: string | null = null;

          if (ord.purgeStartedAt || owningRun) {
            if (owningRun?.status === "failed") {
              state = "failed";
              failureCode = owningRun.errorCode ?? "TRASH_PURGE_FAILED";
              failedRunId = owningRun.publicId;
              failedTargetPublicId = owningRun.failedTargetPublicId;
              failedTargetReference = owningRun.failedTargetReference;
              if (failureCode === "EXTERNAL_COPIES_UNREACHABLE") {
                const c = parseCounts(owningRun.countsJson);
                unreachableExternalCopies = c.unreachableTotal ?? 1;
              }
            } else {
              state = "deleting";
            }
          }

          let canRestore = true;
          let restoreBlockedReason: string | null = null;
          if (ord.purgeStartedAt || owningRun) {
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
            failedTargetPublicId,
            failedTargetReference,
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
          owningPurgeRunsByEntity("customer", custItems.map((c) => c.id)),
        ]);

        for (const cust of custItems) {
          const dueAt = retention.autoPurgeEnabled
            ? addDays(cust.trashedAt, retention.customerDays)
            : null;
          if (dueHorizonMs !== undefined) {
            if (!dueAt || dueAt.getTime() > dueHorizonMs) continue;
          }

          const owningRun = runStatusMap.get(cust.id);
          let state: TrashRow["state"] = "in_trash";
          let failureCode: string | null = null;
          let unreachableExternalCopies: number | null = null;
          let failedRunId: string | null = null;
          let failedTargetPublicId: string | null = null;
          let failedTargetReference: string | null = null;

          if (cust.purgeStartedAt || owningRun) {
            if (owningRun?.status === "failed") {
              state = "failed";
              failureCode = owningRun.errorCode ?? "TRASH_PURGE_FAILED";
              failedRunId = owningRun.publicId;
              failedTargetPublicId = owningRun.failedTargetPublicId;
              failedTargetReference = owningRun.failedTargetReference;
              if (failureCode === "EXTERNAL_COPIES_UNREACHABLE") {
                const c = parseCounts(owningRun.countsJson);
                unreachableExternalCopies = c.unreachableTotal ?? 1;
              }
            } else {
              state = "deleting";
            }
          }

          const ref = cust.customerRef ?? cust.publicId;
          const blockedByPurge = Boolean(cust.purgeStartedAt || owningRun);
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
            failedTargetPublicId,
            failedTargetReference,
            canRestore: !blockedByPurge,
            restoreBlockedReason: blockedByPurge ? "PURGE_IN_PROGRESS" : null,
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
              reservation.attemptOwner,
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
            reservation.attemptOwner,
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
        await releaseUnmutatedIdempotency(reservation.rowId, reservation.attemptOwner);
        throw err;
      }
    },

    async restore(principal, input): Promise<TrashRestoreOutput> {
      assertUniqueMutationItems(input.items);
      const initialBatchBindings: Record<string, string | null> = {};
      for (const item of input.items) {
        initialBatchBindings[`${item.kind}:${item.publicId}`] = item.batchId;
      }
      const fingerprintHash = keyHash(
        `trash.fp:restore:${JSON.stringify(
          input.items.map((i) => ({ kind: i.kind, publicId: i.publicId, batchId: i.batchId })),
        )}`,
      );

      const reservation = await reserveIdempotency<TrashRestoreOutput>({
        principal,
        capability: "trash.manage",
        operation: "restore",
        idempotencyKey: input.idempotencyKey,
        fingerprintHash,
        initialBatchBindings,
        verifyBatchGenerations: true,
        resumableRestoreOperation: true,
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
      const batchBindings: Record<string, string | null> = { ...initialBatchBindings };
      let restored = 0;

      try {
        for (const item of input.items) {
          const itemKey = `${item.kind}:${item.publicId}`;
          const priorOk = reservation.priorRestoredItems[itemKey];
          if (priorOk?.ok) {
            restored += 1;
            results.push(priorOk);
            continue;
          }
          try {
            const one = await deps.db.transaction(async (tx) => {
              await guardActorInTx(tx, principal, "trash.manage");
              const res = await restoreSingleInTx(tx, item, actor, principal);
              await recordRestoreProgressInTx({
                tx,
                rowId: reservation.rowId,
                attemptOwner: reservation.attemptOwner,
                itemKey,
                batchId: res.batchId,
                itemResult: { ...item, ok: true },
                now: deps.clock.now(),
              });
              return res;
            });
            restored += 1;
            batchBindings[itemKey] = one.batchId;
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
                  correlationId: item.batchId,
                  attributes: {
                    ...(item.kind === "order"
                      ? { order_public_id: item.publicId }
                      : { customer_public_id: item.publicId }),
                    trash_batch_id: item.batchId,
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
        if (restored > 0 || reservation.hadCommittedClaim) {
          await failIdempotency(
            reservation.rowId,
            reservation.attemptOwner,
            fingerprintHash,
            batchBindings,
            err,
          );
        } else {
          await releaseUnmutatedIdempotency(reservation.rowId, reservation.attemptOwner);
        }
        throw err;
      }

      const output: TrashRestoreOutput = { restored, results };
      await completeIdempotency(
        reservation.rowId,
        reservation.attemptOwner,
        fingerprintHash,
        batchBindings,
        output,
      );
      return output;
    },

    async purge(principal, input): Promise<TrashPurgeOutput> {
      assertUniqueMutationItems(input.items);
      const single = input.items.length === 1;
      const trimmedConfirmation = input.confirmation.trim();
      if (!single && trimmedConfirmation !== `DELETE ${input.items.length}`) {
        throw validation(
          "CONFIRMATION_MISMATCH",
          "The confirmation you typed doesn't match. Nothing was deleted.",
        );
      }

      const initialBatchBindings: Record<string, string | null> = {};
      for (const item of input.items) {
        initialBatchBindings[`${item.kind}:${item.publicId}`] = item.batchId;
      }

      const fingerprintHash = keyHash(
        `trash.fp:purge:${JSON.stringify({
          items: input.items.map((i) => ({ kind: i.kind, publicId: i.publicId, batchId: i.batchId })),
          confirmation: trimmedConfirmation,
        })}`,
      );

      const reservation = await reserveIdempotency<TrashPurgeOutput>({
        principal,
        capability: "trash.purge",
        operation: "purge",
        idempotencyKey: input.idempotencyKey,
        fingerprintHash,
        initialBatchBindings,
        verifyBatchGenerations: true,
        resumablePurgeOperation: true,
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
      const batchBindings: Record<string, string | null> = { ...initialBatchBindings };
      let anyClaimCommitted = reservation.hadCommittedClaim;

      try {
        for (const item of input.items) {
          try {
            const done = await executePurgeOne({
              item,
              actor,
              auditPrincipal: principal,
              bulkCount: input.items.length,
              expectedSingleConfirmation: single ? trimmedConfirmation : undefined,
              idempotencyRowId: reservation.rowId,
              attemptOwner: reservation.attemptOwner,
              onClaimCommitted: (claimedBatchId) => {
                anyClaimCommitted = true;
                batchBindings[`${item.kind}:${item.publicId}`] = claimedBatchId;
              },
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
        if (anyClaimCommitted) {
          await failIdempotency(
            reservation.rowId,
            reservation.attemptOwner,
            fingerprintHash,
            batchBindings,
            err,
          );
        } else {
          await releaseUnmutatedIdempotency(reservation.rowId, reservation.attemptOwner);
        }
        throw err;
      }

      const output: TrashPurgeOutput = { runIds, results };
      if (results.some((r) => !r.ok)) {
        const firstErr = results.find((r) => !r.ok);
        await failIdempotency(
          reservation.rowId,
          reservation.attemptOwner,
          fingerprintHash,
          batchBindings,
          conflict(firstErr?.reasonCode ?? "TRASH_PURGE_FAILED", firstErr?.safeMessage ?? "Some items could not be deleted."),
        );
        return output;
      }
      await completeIdempotency(
        reservation.rowId,
        reservation.attemptOwner,
        fingerprintHash,
        batchBindings,
        output,
      );
      return output;
    },

    async finishLeavingExternalCopies(
      principal,
      input: TrashFinishLeavingExternalInput,
    ): Promise<TrashFinishLeavingExternalOutput> {
      if (!input.batchId || input.batchId.trim().length === 0) {
        throw validation("BATCH_ID_REQUIRED", "Include the trash batch identifier.");
      }
      const trimmedConfirmation = input.confirmation.trim();
      const initialBatchBindings: Record<string, string | null> = {
        [`${input.kind}:${input.publicId}`]: input.batchId,
      };
      const fingerprintHash = keyHash(
        `trash.fp:finish_external:${JSON.stringify({
          kind: input.kind,
          publicId: input.publicId,
          batchId: input.batchId,
          runId: input.runId,
          targetOrderPublicId: input.targetOrderPublicId ?? null,
          confirmation: trimmedConfirmation,
        })}`,
      );

      const reservation = await reserveIdempotency<TrashFinishLeavingExternalOutput>({
        principal,
        capability: "trash.purge",
        operation: "finish_leaving_external_copies",
        idempotencyKey: input.idempotencyKey,
        fingerprintHash,
        initialBatchBindings,
        verifyBatchGenerations: true,
        resumablePurgeOperation: true,
      });
      if (reservation.hit) return reservation.payload;

      const actor: TrashActor = {
        kind: "user",
        userId: principal.userId,
        publicId: principal.userPublicId,
        sessionId: principal.sessionId,
      };
      let claimCommitted = reservation.hadCommittedClaim;

      try {
        const done = await executePurgeOne({
          item: { kind: input.kind, publicId: input.publicId, batchId: input.batchId },
          actor,
          auditPrincipal: principal,
          bulkCount: 1,
          idempotencyRowId: reservation.rowId,
          attemptOwner: reservation.attemptOwner,
          acknowledgeExternal: {
            runPublicId: input.runId,
            targetOrderPublicId: input.targetOrderPublicId,
            confirmation: trimmedConfirmation,
          },
          onClaimCommitted: (claimedBatchId) => {
            claimCommitted = true;
            initialBatchBindings[`${input.kind}:${input.publicId}`] = claimedBatchId;
          },
        });
        const output: TrashFinishLeavingExternalOutput = {
          ok: true,
          runId: done.runId,
          keptExternalCopies: done.keptExternalCopies,
        };
        await completeIdempotency(
          reservation.rowId,
          reservation.attemptOwner,
          fingerprintHash,
          initialBatchBindings,
          output,
        );
        return output;
      } catch (err) {
        if (claimCommitted) {
          await failIdempotency(
            reservation.rowId,
            reservation.attemptOwner,
            fingerprintHash,
            initialBatchBindings,
            err,
          );
        } else {
          await releaseUnmutatedIdempotency(reservation.rowId, reservation.attemptOwner);
        }
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
        // D2.8: Enabling auto clean-up or shortening an active period ALWAYS requires typed confirmation (including `DELETE 0`).
        const requiresConfirmation = shorteningOrEnabling;
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
            reservation.attemptOwner,
            fingerprintHash,
            {},
            { savedVersion: nextVersion },
            tx,
          );
        });
      } catch (err) {
        await releaseUnmutatedIdempotency(reservation.rowId, reservation.attemptOwner);
        throw err;
      }

      return buildSettingsView();
    },

    async runRetentionCleanup(
      triggerJobId?: string,
      jobFence?: TrashCleanupJobFence,
    ): Promise<TrashCleanupResult> {
      const now = deps.clock.now();
      const sweepPublicId = ulid(now.getTime());
      const sweepLeaseOwner = ulid(now.getTime() + 1);

      const recordDeferralAndCheckAlert = async (
        candidate: { kind: TrashEntityKind; id: number; publicId: string; batchId: string },
        reasonCode: string,
      ): Promise<{ shouldAlert: boolean }> => {
        return deps.db.transaction(async (tx) => {
          const dNow = deps.clock.now();
          const [existing] = await tx
            .select()
            .from(trashRetentionDeferrals)
            .where(
              and(
                eq(trashRetentionDeferrals.entityKind, candidate.kind),
                eq(trashRetentionDeferrals.entityId, candidate.id),
                eq(trashRetentionDeferrals.batchId, candidate.batchId),
              ),
            )
            .for("update")
            .limit(1);

          const nextAttemptCount = (existing?.attemptCount ?? 0) + 1;
          const delayMs = computeDeferralBackoffMs(nextAttemptCount);
          const nextAttemptAt = new Date(dNow.getTime() + delayMs);
          const shouldAlert = !existing?.alertedAt;

          if (existing) {
            await tx
              .update(trashRetentionDeferrals)
              .set({
                reasonCode,
                attemptCount: nextAttemptCount,
                nextAttemptAt,
                alertedAt: existing.alertedAt ?? dNow,
                updatedAt: dNow,
              })
              .where(eq(trashRetentionDeferrals.id, existing.id));
          } else {
            await tx.insert(trashRetentionDeferrals).values({
              entityKind: candidate.kind,
              entityId: candidate.id,
              entityPublicId: candidate.publicId,
              batchId: candidate.batchId,
              reasonCode,
              attemptCount: 1,
              nextAttemptAt,
              alertedAt: dNow,
              createdAt: dNow,
              updatedAt: dNow,
            });
          }
          return { shouldAlert };
        });
      };

      type ClaimSweepOutcome =
        | { acquired: false; reason: string }
        | { acquired: true; sweepRowId: number; sweepToken: number; retention: RetentionValues };

      let claimOutcome: ClaimSweepOutcome;
      try {
        claimOutcome = await deps.db.transaction(async (tx): Promise<ClaimSweepOutcome> => {
          if (jobFence) {
            if (jobFence.signal.aborted) return { acquired: false, reason: "ABORTED" };
            try {
              await jobFence.assertStillOwned(tx);
            } catch {
              return { acquired: false, reason: "JOB_LEASE_LOST" };
            }
          }
          const txNow = deps.clock.now();
          const [activeRow] = await tx
            .select()
            .from(trashCleanupSweeps)
            .where(eq(trashCleanupSweeps.activeSlot, 1))
            .for("update")
            .limit(1);

          if (activeRow) {
            if (activeRow.leaseExpiresAt !== null && activeRow.leaseExpiresAt.getTime() > txNow.getTime()) {
              return { acquired: false, reason: "SWEEP_ALREADY_RUNNING" };
            }
            await tx
              .update(trashCleanupSweeps)
              .set({
                status: "failed",
                activeSlot: null,
                leaseOwner: null,
                leaseExpiresAt: null,
                errorCode: "SWEEP_LEASE_EXPIRED",
                finishedAt: txNow,
              })
              .where(eq(trashCleanupSweeps.id, activeRow.id));
          }

          await shareLockRetentionCohortInTx(tx);
          const maint = await isMaintenanceBlockingCleanup(tx);
          if (maint) return { acquired: false, reason: maint };
          const ret = await readRetentionValues(tx, true);
          if (!ret.autoPurgeEnabled) return { acquired: false, reason: "AUTO_PURGE_DISABLED" };

          const nextToken = (activeRow?.fencingToken ?? 0) + 1;
          const [ins] = await tx.insert(trashCleanupSweeps).values({
            publicId: sweepPublicId,
            correlationId: triggerJobId ?? sweepPublicId,
            status: "running",
            activeSlot: 1,
            fencingToken: nextToken,
            leaseOwner: sweepLeaseOwner,
            leaseExpiresAt: new Date(txNow.getTime() + sweepLeaseMs),
            purgedCount: 0,
            failedCount: 0,
            startedAt: txNow,
          });
          return {
            acquired: true,
            sweepRowId: Number(ins.insertId),
            sweepToken: nextToken,
            retention: ret,
          };
        });
      } catch (err) {
        if (isMysqlDupEntry(err)) {
          return {
            sweepPublicId,
            skippedReason: "SWEEP_ALREADY_RUNNING",
            due: 0,
            purged: 0,
            failed: 0,
          };
        }
        throw err;
      }

      if (!claimOutcome.acquired) {
        return {
          sweepPublicId,
          skippedReason: claimOutcome.reason,
          due: 0,
          purged: 0,
          failed: 0,
        };
      }

      const { sweepRowId, sweepToken, retention } = claimOutcome;

      const renewSweepLeaseOrStop = async (): Promise<boolean> => {
        return deps.db.transaction(async (tx) => {
          if (jobFence) {
            if (jobFence.signal.aborted) return false;
            try {
              await jobFence.assertStillOwned(tx);
            } catch {
              return false;
            }
          }
          const rNow = deps.clock.now();
          const [curr] = await tx
            .select({
              status: trashCleanupSweeps.status,
              activeSlot: trashCleanupSweeps.activeSlot,
              fencingToken: trashCleanupSweeps.fencingToken,
              leaseOwner: trashCleanupSweeps.leaseOwner,
            })
            .from(trashCleanupSweeps)
            .where(eq(trashCleanupSweeps.id, sweepRowId))
            .for("update")
            .limit(1);
          if (
            !curr ||
            curr.status !== "running" ||
            curr.activeSlot !== 1 ||
            curr.fencingToken !== sweepToken ||
            curr.leaseOwner !== sweepLeaseOwner
          ) {
            return false;
          }
          await tx
            .update(trashCleanupSweeps)
            .set({ leaseExpiresAt: new Date(rNow.getTime() + sweepLeaseMs) })
            .where(eq(trashCleanupSweeps.id, sweepRowId));
          return true;
        });
      };

      const actor: TrashActor = { kind: "system", job: TRASH_JOB_RETENTION_CLEANUP };
      let dueEvaluated = 0;
      let purged = 0;
      let failed = 0;
      let scanned = 0;
      let stoppedEarly = false;

      type DueCandidate = {
        kind: TrashEntityKind;
        id: number;
        publicId: string;
        batchId: string;
        trashedAt: Date;
        dueAtMs: number;
        neverTried: boolean;
        nextAttemptMs: number;
      };

      const seenCustomers = new Set<number>();
      const seenOrders = new Set<number>();

      try {
        const fetchDueCustomers = async (sweepNow: Date): Promise<DueCandidate[]> => {
          const customerCutoff = new Date(sweepNow.getTime() - retention.customerDays * DAY_MS);
          const rows = await deps.db
            .select({
              id: users.id,
              publicId: users.publicId,
              batchId: users.trashBatchId,
              trashedAt: users.trashedAt,
              targetId: trashPurgeRunTargets.id,
              runNextRetryAt: trashPurgeRuns.nextRetryAt,
              deferralId: trashRetentionDeferrals.id,
              deferralNextAttemptAt: trashRetentionDeferrals.nextAttemptAt,
            })
            .from(users)
            .leftJoin(
              trashPurgeRunTargets,
              and(
                eq(trashPurgeRunTargets.entityKind, "customer"),
                eq(trashPurgeRunTargets.entityId, users.id),
              ),
            )
            .leftJoin(trashPurgeRuns, eq(trashPurgeRuns.id, trashPurgeRunTargets.runId))
            .leftJoin(
              trashRetentionDeferrals,
              and(
                eq(trashRetentionDeferrals.entityKind, "customer"),
                eq(trashRetentionDeferrals.entityId, users.id),
                eq(trashRetentionDeferrals.batchId, users.trashBatchId),
              ),
            )
            .where(
              and(
                eq(users.role, "customer"),
                isNotNull(users.trashedAt),
                isNotNull(users.trashBatchId),
                isNull(users.purgedAt),
                lte(users.trashedAt, customerCutoff),
                sql`(${trashPurgeRunTargets.id} IS NULL OR (${trashPurgeRuns.entityKind} = 'customer' AND ${trashPurgeRuns.entityId} = ${users.id}))`,
                sql`(${trashPurgeRuns.id} IS NULL OR (${trashPurgeRuns.status} != 'completed' AND NOT (${trashPurgeRuns.status} = 'running' AND ${trashPurgeRuns.leaseExpiresAt} IS NOT NULL AND ${trashPurgeRuns.leaseExpiresAt} > ${sweepNow}) AND (${trashPurgeRuns.nextRetryAt} IS NULL OR ${trashPurgeRuns.nextRetryAt} <= ${sweepNow})))`,
                sql`(${trashRetentionDeferrals.id} IS NULL OR ${trashRetentionDeferrals.nextAttemptAt} <= ${sweepNow})`,
              ),
            )
            .orderBy(
              sql`CASE WHEN ${trashPurgeRuns.id} IS NULL AND ${trashRetentionDeferrals.id} IS NULL THEN 0 ELSE 1 END ASC`,
              sql`COALESCE(${trashPurgeRuns.nextRetryAt}, ${trashRetentionDeferrals.nextAttemptAt}, ${users.trashedAt}) ASC`,
              asc(users.trashedAt),
              asc(users.id),
            )
            .limit(SWEEP_PAGE_SIZE);

          const out: DueCandidate[] = [];
          for (const r of rows) {
            if (!r.trashedAt || !r.batchId || seenCustomers.has(r.id)) continue;
            const dueAtMs = r.trashedAt.getTime() + retention.customerDays * DAY_MS;
            out.push({
              kind: "customer",
              id: r.id,
              publicId: r.publicId,
              batchId: r.batchId,
              trashedAt: r.trashedAt,
              dueAtMs,
              neverTried: r.targetId === null && r.deferralId === null,
              nextAttemptMs: r.runNextRetryAt?.getTime() ?? r.deferralNextAttemptAt?.getTime() ?? dueAtMs,
            });
          }
          return out;
        };

        const fetchDueOrders = async (sweepNow: Date): Promise<DueCandidate[]> => {
          const orderCutoff = new Date(sweepNow.getTime() - retention.orderDays * DAY_MS);
          const rows = await deps.db
            .select({
              id: orders.id,
              publicId: orders.publicId,
              batchId: orders.trashBatchId,
              trashedAt: orders.trashedAt,
              targetId: trashPurgeRunTargets.id,
              runNextRetryAt: trashPurgeRuns.nextRetryAt,
              deferralId: trashRetentionDeferrals.id,
              deferralNextAttemptAt: trashRetentionDeferrals.nextAttemptAt,
            })
            .from(orders)
            .leftJoin(users, eq(users.id, orders.ownerUserId))
            .leftJoin(
              trashPurgeRunTargets,
              and(
                eq(trashPurgeRunTargets.entityKind, "order"),
                eq(trashPurgeRunTargets.entityId, orders.id),
              ),
            )
            .leftJoin(trashPurgeRuns, eq(trashPurgeRuns.id, trashPurgeRunTargets.runId))
            .leftJoin(
              trashRetentionDeferrals,
              and(
                eq(trashRetentionDeferrals.entityKind, "order"),
                eq(trashRetentionDeferrals.entityId, orders.id),
                eq(trashRetentionDeferrals.batchId, orders.trashBatchId),
              ),
            )
            .where(
              and(
                isNotNull(orders.trashedAt),
                isNotNull(orders.trashBatchId),
                isNull(orders.purgedAt),
                lte(orders.trashedAt, orderCutoff),
                sql`NOT (${users.trashedAt} IS NOT NULL AND ${users.purgedAt} IS NULL AND ${users.trashBatchId} = ${orders.trashBatchId})`,
                sql`(${orders.groupRootOrderId} IS NULL OR NOT EXISTS (SELECT 1 FROM orders root_ord WHERE root_ord.id = ${orders.groupRootOrderId} AND root_ord.trashed_at IS NOT NULL AND root_ord.purged_at IS NULL))`,
                sql`(${trashPurgeRunTargets.id} IS NULL OR (${trashPurgeRuns.entityKind} = 'order' AND ${trashPurgeRuns.entityId} = ${orders.id}))`,
                sql`(${trashPurgeRuns.id} IS NULL OR (${trashPurgeRuns.status} != 'completed' AND NOT (${trashPurgeRuns.status} = 'running' AND ${trashPurgeRuns.leaseExpiresAt} IS NOT NULL AND ${trashPurgeRuns.leaseExpiresAt} > ${sweepNow}) AND (${trashPurgeRuns.nextRetryAt} IS NULL OR ${trashPurgeRuns.nextRetryAt} <= ${sweepNow})))`,
                sql`(${trashRetentionDeferrals.id} IS NULL OR ${trashRetentionDeferrals.nextAttemptAt} <= ${sweepNow})`,
              ),
            )
            .orderBy(
              sql`CASE WHEN ${trashPurgeRuns.id} IS NULL AND ${trashRetentionDeferrals.id} IS NULL THEN 0 ELSE 1 END ASC`,
              sql`COALESCE(${trashPurgeRuns.nextRetryAt}, ${trashRetentionDeferrals.nextAttemptAt}, ${orders.trashedAt}) ASC`,
              asc(orders.trashedAt),
              asc(orders.id),
            )
            .limit(SWEEP_PAGE_SIZE);

          const out: DueCandidate[] = [];
          for (const r of rows) {
            if (!r.trashedAt || !r.batchId || seenOrders.has(r.id)) continue;
            const dueAtMs = r.trashedAt.getTime() + retention.orderDays * DAY_MS;
            out.push({
              kind: "order",
              id: r.id,
              publicId: r.publicId,
              batchId: r.batchId,
              trashedAt: r.trashedAt,
              dueAtMs,
              neverTried: r.targetId === null && r.deferralId === null,
              nextAttemptMs: r.runNextRetryAt?.getTime() ?? r.deferralNextAttemptAt?.getTime() ?? dueAtMs,
            });
          }
          return out;
        };

        const compareCandidates = (a: DueCandidate, b: DueCandidate): number => {
          if (a.neverTried !== b.neverTried) return a.neverTried ? -1 : 1;
          if (a.nextAttemptMs !== b.nextAttemptMs) return a.nextAttemptMs - b.nextAttemptMs;
          if (a.dueAtMs !== b.dueAtMs) return a.dueAtMs - b.dueAtMs;
          if (a.kind !== b.kind) return a.kind === "customer" ? -1 : 1;
          return a.id - b.id;
        };

        while (dueEvaluated < SWEEP_BATCH_LIMIT && scanned < SWEEP_MAX_SCANNED) {
          const sweepNow = deps.clock.now();
          const [custPage, ordPage] = await Promise.all([
            fetchDueCustomers(sweepNow),
            fetchDueOrders(sweepNow),
          ]);
          const merged = [...custPage, ...ordPage].sort(compareCandidates);
          if (merged.length === 0) break;

          for (const nextCandidate of merged) {
            if (dueEvaluated >= SWEEP_BATCH_LIMIT || scanned >= SWEEP_MAX_SCANNED) break;

            if (nextCandidate.kind === "customer") {
              seenCustomers.add(nextCandidate.id);
            } else {
              seenOrders.add(nextCandidate.id);
            }
            scanned += 1;

            if (!(await renewSweepLeaseOrStop())) {
              stoppedEarly = true;
              break;
            }
            if (jobFence?.signal.aborted) {
              stoppedEarly = true;
              break;
            }

            try {
              await executePurgeOne({
                item: {
                  kind: nextCandidate.kind,
                  publicId: nextCandidate.publicId,
                  batchId: nextCandidate.batchId,
                },
                actor,
                bulkCount: 1,
                sweepPublicId,
                sweepFence: {
                  sweepRowId,
                  sweepToken,
                  sweepLeaseOwner,
                  jobFence,
                },
              });
              dueEvaluated += 1;
              purged += 1;
            } catch (err) {
              if (
                err instanceof DomainError &&
                (err.reasonCode === "ORDER_ON_LEGAL_HOLD" ||
                  err.reasonCode === "CASCADE_TOO_LARGE" ||
                  err.reasonCode === "CUSTOMER_HAS_LIVE_ORDERS" ||
                  err.reasonCode === "ROOT_HAS_LIVE_ADDITIONS")
              ) {
                const { shouldAlert } = await recordDeferralAndCheckAlert(nextCandidate, err.reasonCode);
                const opsAlerts = services().opsAlerts;
                if (opsAlerts && shouldAlert) {
                  await opsAlerts
                    .emit({
                      source: "trash",
                      dedupKey: `retention-deferred:${err.reasonCode}:${nextCandidate.kind}:${nextCandidate.publicId}:${nextCandidate.batchId}`,
                      severity: err.reasonCode === "ORDER_ON_LEGAL_HOLD" ? "warning" : "error",
                      code: err.reasonCode,
                      title:
                        err.reasonCode === "ORDER_ON_LEGAL_HOLD"
                          ? "Item on legal hold skipped during retention clean-up"
                          : "Item skipped during retention clean-up",
                      text: err.safeMessage,
                      orderPublicId: nextCandidate.kind === "order" ? nextCandidate.publicId : undefined,
                      runPublicId: sweepPublicId,
                      correlationId: sweepPublicId,
                    })
                    .catch(() => undefined);
                }
                continue;
              }
              if (
                err instanceof DomainError &&
                (err.reasonCode === "MAINTENANCE_ACTIVE" ||
                  err.reasonCode === "AUTO_PURGE_DISABLED" ||
                  err.reasonCode === "SWEEP_FENCE_LOST")
              ) {
                stoppedEarly = true;
                break;
              }
              if (
                err instanceof DomainError &&
                (err.reasonCode === "NOT_IN_TRASH" ||
                  err.reasonCode === "NOT_DUE" ||
                  err.reasonCode === "STALE" ||
                  err.reasonCode === "PURGE_IN_PROGRESS" ||
                  err.reasonCode === "PURGE_ALREADY_OWNED" ||
                  err.reasonCode === "PURGE_RETRY_BACKOFF" ||
                  err.reasonCode === "ORDER_NOT_FOUND" ||
                  err.reasonCode === "CUSTOMER_NOT_FOUND")
              ) {
                continue;
              }
              dueEvaluated += 1;
              failed += 1;
              log.warn("retention cleanup item failed; continuing sweep", {
                err,
                target: { kind: nextCandidate.kind, publicId: nextCandidate.publicId },
                sweepPublicId,
              });
            }
          }

          if (stoppedEarly) break;
        }

        const finishedAt = deps.clock.now();
        const status: "completed" | "failed" = failed > 0 ? "failed" : "completed";
        await deps.db
          .update(trashCleanupSweeps)
          .set({
            status,
            activeSlot: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            purgedCount: purged,
            failedCount: failed,
            errorCode: failed > 0 ? "TRASH_CLEANUP_PARTIAL_FAILURE" : stoppedEarly ? "SWEEP_INTERRUPTED" : null,
            finishedAt,
          })
          .where(and(eq(trashCleanupSweeps.id, sweepRowId), eq(trashCleanupSweeps.fencingToken, sweepToken)));

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
          safeCounts: { due: dueEvaluated, purged, failed },
          attributes: {
            run_public_id: sweepPublicId,
            due: dueEvaluated,
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
          due: dueEvaluated,
          purged,
          failed,
        };
      } finally {
        const endNow = deps.clock.now();
        await deps.db
          .update(trashCleanupSweeps)
          .set({
            activeSlot: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            finishedAt: endNow,
          })
          .where(
            and(
              eq(trashCleanupSweeps.id, sweepRowId),
              eq(trashCleanupSweeps.fencingToken, sweepToken),
              eq(trashCleanupSweeps.activeSlot, 1),
            ),
          )
          .catch(() => undefined);
      }
    },
  };

  deps.jobs?.register(
    TRASH_JOB_RETENTION_CLEANUP,
    async (job) => {
      if (job.signal.aborted) {
        return { outcome: "canceled", reasonCode: "ABORTED" };
      }
      const res = await service.runRetentionCleanup(job.jobId, job);
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
