/**
 * Typed tRPC bridge for `trpc.trash.*` (increment 09 D2; router owner recovery_ops_engineer, UI audit_engineer).
 * The shapes are the ones agreed for the Trash centre, so the client type-checks before and after the router is
 * mounted; `features/facadeContracts.typecheck.ts` pins them to the real router once it exists. The server decides
 * scope, counts and permissions (D2.8): the client sends public ids, typed confirmations and idempotency keys only.
 */
import type { UseMutationOptions, UseQueryOptions } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";

interface Query<I, O> {
  queryOptions(input: I, opts?: Record<string, unknown>): UseQueryOptions<O, unknown, O, readonly unknown[]>;
  queryKey(input?: I): readonly unknown[];
  pathFilter(): { queryKey: readonly unknown[] };
}
interface QueryNoInput<O> {
  queryOptions(input?: undefined, opts?: Record<string, unknown>): UseQueryOptions<O, unknown, O, readonly unknown[]>;
  queryKey(): readonly unknown[];
  pathFilter(): { queryKey: readonly unknown[] };
}
interface Mutation<I, O> {
  mutationOptions(opts?: UseMutationOptions<O, unknown, I>): UseMutationOptions<O, unknown, I>;
}

export type TrashKind = "order" | "customer";
export type TrashState = "in_trash" | "deleting" | "failed";
export type TrashSort = "movedAt" | "dueAt";

export interface TrashPerson { publicId: string; displayName: string }

export interface TrashRow {
  kind: TrashKind;
  publicId: string;
  /** Order: order number and project name; customer: the customer ID (never an e-mail address). */
  label: string;
  /** The order number or customer ID the administrator types to delete permanently. */
  reference: string;
  /** Orders: the owner's customer ID; customers: null. */
  ownerCustomerId: string | null;
  movedBy: TrashPerson | null;
  movedAt: string | Date;
  reason: string | null;
  /** trashed_at + the current retention; null while automatic clean-up is off. */
  dueAt: string | Date | null;
  state: TrashState;
  batchId: string;
  failureCode: string | null;
  /** Lead ruling (B): with failureCode EXTERNAL_COPIES_UNREACHABLE, how many recorded external copies could not be reached. */
  unreachableExternalCopies: number | null;
  /** The failed purge run the administrator may finish. */
  failedRunId: string | null;
  canRestore: boolean;
  restoreBlockedReason: string | null;
}

export interface TrashListInput {
  kind: TrashKind;
  q?: string;
  movedFrom?: string;
  movedTo?: string;
  movedByPublicId?: string;
  dueWithinDays?: number;
  sort: TrashSort;
  dir: "asc" | "desc";
  cursor?: string | null;
  limit: number;
}
export interface TrashListOutput { items: TrashRow[]; nextCursor: string | null; total: number }

export interface TrashCounts { orders: number; customers: number; dueWithin7d: number }

export interface TrashSummary {
  /** e.g. { orders: 2, files: 12, messages: 3, paidInvoices: 1 }; computed by the server (no personal data). */
  counts: Record<string, number>;
  /** When it would be deleted permanently under the current setting; null = kept until an administrator deletes it. */
  dueAt: string | Date | null;
  hasPayments: boolean;
  /** Customers: orders moved to the trash with the account. */
  cascadedOrders: number;
  autoPurgeEnabled: boolean;
}

export interface TrashItemRef { kind: TrashKind; publicId: string; batchId?: string }
export interface TrashItemResult extends TrashItemRef { ok: boolean; reasonCode?: string | null; safeMessage?: string | null; runId?: string }
export interface TrashResults { results: TrashItemResult[] }

export interface TrashRun {
  publicId: string;
  finishedAt: string | Date | null;
  status: "running" | "completed" | "failed";
  purged: number;
  failed: number;
}

export interface TrashSettings {
  autoPurgeEnabled: boolean;
  orderDays: number;
  customerDays: number;
  version: number;
  lastRun: TrashRun | null;
  nextDueCount: number;
}
export interface RetentionValues { autoPurgeEnabled: boolean; orderDays: number; customerDays: number }

export interface TrashApi {
  list: Query<TrashListInput, TrashListOutput>;
  counts: QueryNoInput<TrashCounts>;
  movedByOptions: QueryNoInput<TrashPerson[]>;
  summarize: Query<TrashItemRef, TrashSummary>;
  moveToTrash: Mutation<TrashItemRef & { reason?: string; idempotencyKey: string }, { batchId: string; dueAt: string | Date | null; cascadedOrders: number }>;
  restore: Mutation<{ items: TrashItemRef[]; idempotencyKey: string }, { restored: number } & TrashResults>;
  purge: Mutation<{ items: TrashItemRef[]; confirmation: string; idempotencyKey: string }, { runIds: string[] } & TrashResults>;
  /** Finish a failed run, leaving the unreachable external copies in place (trash.purge + step-up + typed reference). */
  finishLeavingExternalCopies: Mutation<TrashItemRef & { runId: string; confirmation: string; idempotencyKey: string }, { ok: boolean; runId: string; keptExternalCopies: number }>;
  settings: {
    get: QueryNoInput<TrashSettings>;
    preview: Query<RetentionValues, { becomeDue: number; requiresConfirmation: boolean; confirmationPhrase: string | null; version: number }>;
    update: Mutation<RetentionValues & { expectedVersion: number; reviewedDueCount?: number; confirmation?: string; idempotencyKey: string }, TrashSettings>;
  };
}

export function useTrashApi(): TrashApi {
  return (useTRPC() as unknown as { trash: TrashApi }).trash;
}
