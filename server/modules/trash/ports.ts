/**
 * Trash participant port (Increment 09, Decision D2.5). Owner: recovery_ops_engineer.
 * Shape fixed by docs/engineering/INCREMENT_09_CONTRACT.md; every module that holds data about an order or a
 * customer registers one participant from its `init()` through `services.trash.register(participant)`.
 */
import type { Tx } from "../../core/types.js";

export type TrashEntityKind = "order" | "customer";

export interface TrashEntityRef {
  kind: TrashEntityKind;
  /** Internal id of the `orders` / `users` row. Never crosses the wire. */
  id: number;
  publicId: string;
  /** The trash generation: one value per "move to trash" cascade. */
  batchId: string;
}

/** Who caused the action: an administrator session or the retention job. */
export type TrashActor =
  | { kind: "user"; userId: number; publicId: string; sessionId?: string }
  | { kind: "system"; job: string };

export interface TrashPurgeRun {
  /** Public id of the purge run; stable across retries of the same purge. */
  runId: string;
  /**
   * Set by the coordinator ONLY after an administrator with `trash.purge` confirmed (step-up + typed order
   * number) that known copies on an unreachable destination are left in place. Never set by the retention job.
   */
  acknowledgedUnreachableCopies?: boolean;
  /**
   * Ownership fence (D2.8). A participant MUST call this as the first statement of EVERY transaction in which
   * its `purge` changes data, and directly before any call to an external provider (in a short transaction of
   * its own). It takes a shared row lock on the purge run and throws `PURGE_FENCE_LOST` (409) when this worker
   * no longer owns the run, so a worker that was replaced can never change data again, and a takeover waits
   * for transactions that are still in flight. Deleting at an external provider must stay idempotent.
   */
  assertCurrentInTx(tx: Tx): Promise<void>;
}

/** For unit tests of a participant only: a purge run whose fence always passes. Never use in server code. */
export function unfencedPurgeRunForTests(runId: string, extra: Partial<Omit<TrashPurgeRun, "runId">> = {}): TrashPurgeRun {
  return { runId, assertCurrentInTx: async () => undefined, ...extra };
}

export interface TrashPurgeResult {
  /** Rows / objects erased by this call, by plain label. Counts only, never personal data. */
  deleted: Record<string, number>;
  /** What this module keeps by design (D2.6), by plain label. */
  kept?: Record<string, number>;
}

export interface TrashParticipant {
  /** Module name, unique across the registry. */
  module: string;
  /**
   * Inside the trash transaction. Stop what must not continue (open checkouts, queued deliveries, reminders,
   * shares). Idempotent. Must not call external services (enqueue an outbox job instead).
   */
  onTrashedInTx?(tx: Tx, entity: TrashEntityRef, actor: TrashActor): Promise<void>;
  /** Inside the restore transaction. Throw a 409 AppError to veto with a plain message. Idempotent. */
  onRestoredInTx?(tx: Tx, entity: TrashEntityRef, actor: TrashActor): Promise<void>;
  /** Counts for the confirmation dialogs, e.g. `{ files: 12, messages: 3, paidInvoices: 1 }`. No personal data. */
  summarize?(entity: TrashEntityRef): Promise<Record<string, number>>;
  /**
   * Permanent deletion of THIS module's data for the entity. Runs outside one long transaction and may run
   * again after a crash: idempotent and resumable. Throw to fail the run (it is retried on the same targets).
   */
  purge?(entity: TrashEntityRef, run: TrashPurgeRun): Promise<TrashPurgeResult>;
}

export interface TrashRegistry {
  /** Call from a module's `init()`. A duplicate module name throws. */
  register(participant: TrashParticipant): void;
  /** Registered participants in registration order (coordinator use). */
  participants(): readonly TrashParticipant[];
}

export function createTrashRegistry(): TrashRegistry {
  const byModule = new Map<string, TrashParticipant>();
  return {
    register(participant) {
      if (!participant.module || byModule.has(participant.module)) {
        throw new Error(`trash participant already registered or unnamed: ${participant.module}`);
      }
      byModule.set(participant.module, participant);
    },
    participants: () => [...byModule.values()],
  };
}
