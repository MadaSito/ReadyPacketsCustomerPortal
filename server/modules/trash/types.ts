/**
 * Trash coordinator public types (Increment 09, Decision D2 & D2.8). Owner: recovery_ops_engineer.
 */
import type { ModuleLifecycle, SessionPrincipal, Tx } from "../../core/types.js";
import type { TrashEntityKind, TrashRegistry } from "./ports.js";

export type TrashState = "in_trash" | "deleting" | "failed";
export type TrashSort = "movedAt" | "dueAt";

export interface TrashPerson {
  publicId: string;
  displayName: string;
}

export interface TrashRow {
  kind: TrashEntityKind;
  publicId: string;
  /** Order: order number and project name; customer: customer ID (never an email address). */
  label: string;
  /** Exact order number (`RP-...`) or customer ID (`RPCUS-...`) typed for single-item purge confirmation. */
  reference: string;
  /** Orders: owner's customer ID (`RPCUS-...`); customers: null. */
  ownerCustomerId: string | null;
  movedBy: TrashPerson | null;
  movedAt: Date;
  reason: string | null;
  /** `trashed_at + current retention`; `null` while automatic clean-up is off. */
  dueAt: Date | null;
  state: TrashState;
  batchId: string;
  failureCode: string | null;
  /** Non-null when `state === "failed"` and `failureCode === "EXTERNAL_COPIES_UNREACHABLE"`. */
  unreachableExternalCopies: number | null;
  /** Public id of the failed purge run when `state === "failed"`, otherwise `null`. */
  failedRunId: string | null;
  /** Specific failing target public ID inside a single-order or cascade run when `state === "failed"`. */
  failedTargetPublicId: string | null;
  /** Non-personal `RP-...` / `RPCUS-...` reference of the failing target when `state === "failed"`. */
  failedTargetReference: string | null;
  canRestore: boolean;
  restoreBlockedReason: string | null;
}

export interface TrashListInput {
  kind: TrashEntityKind;
  q?: string;
  movedFrom?: string;
  movedTo?: string;
  movedByPublicId?: string;
  dueWithinDays?: number;
  sort?: TrashSort;
  dir?: "asc" | "desc";
  cursor?: string | null;
  limit?: number;
}

export interface TrashListOutput {
  items: TrashRow[];
  nextCursor: string | null;
  total: number;
}

export interface TrashCounts {
  orders: number;
  customers: number;
  dueWithin7d: number;
}

export interface TrashSummary {
  counts: Record<string, number>;
  dueAt: Date | null;
  hasPayments: boolean;
  cascadedOrders: number;
  autoPurgeEnabled: boolean;
}

/** Read-only item reference (e.g. `summarize` on live or trashed items). */
export interface TrashItemRef {
  kind: TrashEntityKind;
  publicId: string;
  batchId?: string;
}

/** Generation-pinned item reference required on all manual `restore` and `purge` mutations (D2.8). */
export interface TrashMutationItemRef {
  kind: TrashEntityKind;
  publicId: string;
  batchId: string;
}

export interface TrashItemResult {
  kind: TrashEntityKind;
  publicId: string;
  batchId?: string;
  ok: boolean;
  reasonCode?: string | null;
  safeMessage?: string | null;
  runId?: string;
}

export interface TrashMoveInput {
  kind: TrashEntityKind;
  publicId: string;
  batchId?: string;
  reason?: string | null;
  idempotencyKey: string;
}

export interface TrashMoveOutput {
  batchId: string;
  dueAt: Date | null;
  cascadedOrders: number;
}

export interface TrashRestoreInput {
  items: TrashMutationItemRef[];
  idempotencyKey: string;
}

export interface TrashRestoreOutput {
  restored: number;
  results: TrashItemResult[];
}

export interface TrashPurgeInput {
  items: TrashMutationItemRef[];
  confirmation: string;
  idempotencyKey: string;
}

export interface TrashPurgeOutput {
  runIds: string[];
  results: TrashItemResult[];
}

export interface TrashFinishLeavingExternalInput {
  kind: TrashEntityKind;
  publicId: string;
  batchId: string;
  runId: string;
  /** Optional specific order public ID inside a root-order or customer cascade run; defaults to `failedTargetPublicId`. */
  targetOrderPublicId?: string;
  confirmation: string;
  idempotencyKey: string;
}

export interface TrashFinishLeavingExternalOutput {
  ok: boolean;
  runId: string;
  keptExternalCopies: number;
}

export interface TrashRunSummary {
  publicId: string;
  finishedAt: Date | null;
  status: "running" | "completed" | "failed";
  purged: number;
  failed: number;
}

export interface RetentionValues {
  autoPurgeEnabled: boolean;
  orderDays: number;
  customerDays: number;
}

export interface TrashSettings extends RetentionValues {
  version: number;
  lastRun: TrashRunSummary | null;
  nextDueCount: number;
}

export interface TrashSettingsPreview {
  becomeDue: number;
  requiresConfirmation: boolean;
  confirmationPhrase: string | null;
  version: number;
}

export interface TrashSettingsUpdateInput extends RetentionValues {
  expectedVersion: number;
  reviewedDueCount?: number;
  confirmation?: string;
  idempotencyKey: string;
}

export interface TrashCleanupJobFence {
  signal: AbortSignal;
  assertStillOwned(tx?: Tx): Promise<void>;
}

export interface TrashCleanupResult {
  sweepPublicId: string;
  skippedReason: string | null;
  due: number;
  purged: number;
  failed: number;
}

export interface TrashCoordinatorOptions {
  /**
   * Explicit expected participant module names for fail-closed purge verification (D2.8).
   * In full container startup, defaults to the complete 20-module destructive participant manifest.
   */
  expectedParticipants?: readonly string[];
  /**
   * Explicit manifest exceptions for modules that intentionally own zero order or customer rows,
   * mapped to their documented reason. Any manifest module without a `purge` handler and not in
   * this map fails closed (`TRASH_PARTICIPANT_NO_PURGE_HANDLER`).
   */
  manifestNoDataToPurge?: Readonly<Record<string, string>>;
  runLeaseMs?: number;
  runHeartbeatMs?: number;
  sweepLeaseMs?: number;
}

export interface TrashService extends ModuleLifecycle, TrashRegistry {
  list(principal: SessionPrincipal, input: TrashListInput): Promise<TrashListOutput>;
  counts(principal: SessionPrincipal): Promise<TrashCounts>;
  movedByOptions(principal: SessionPrincipal): Promise<TrashPerson[]>;
  summarize(principal: SessionPrincipal, input: TrashItemRef): Promise<TrashSummary>;
  moveToTrash(principal: SessionPrincipal, input: TrashMoveInput): Promise<TrashMoveOutput>;
  restore(principal: SessionPrincipal, input: TrashRestoreInput): Promise<TrashRestoreOutput>;
  purge(principal: SessionPrincipal, input: TrashPurgeInput): Promise<TrashPurgeOutput>;
  finishLeavingExternalCopies(
    principal: SessionPrincipal,
    input: TrashFinishLeavingExternalInput,
  ): Promise<TrashFinishLeavingExternalOutput>;
  getSettings(principal: SessionPrincipal): Promise<TrashSettings>;
  previewSettings(principal: SessionPrincipal, input: RetentionValues): Promise<TrashSettingsPreview>;
  updateSettings(principal: SessionPrincipal, input: TrashSettingsUpdateInput): Promise<TrashSettings>;
  /** Internal scheduled retention clean-up handler; never exposed via tRPC. */
  runRetentionCleanup(triggerJobId?: string, jobFence?: TrashCleanupJobFence): Promise<TrashCleanupResult>;
}
