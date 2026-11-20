/**
 * In-memory hand-off of a freshly issued recovery-code batch to the /mfa/recovery-codes screen, so a
 * guard redirect (e.g. me refetch on window focus) never loses a one-time batch. Memory only: no storage,
 * not in the query cache; cleared on acknowledgment, on sign-out (page reload) and when explicitly discarded.
 */
import { useSyncExternalStore } from "react";

export interface RecoveryBatch {
  recoveryCodes: readonly string[];
  recoverySetId: string;
}

let current: RecoveryBatch | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Stage a batch BEFORE refreshing the session. Replaces any earlier batch. */
export function stageRecoveryBatch(batch: RecoveryBatch): void {
  current = { recoveryCodes: [...batch.recoveryCodes], recoverySetId: batch.recoverySetId };
  emit();
}

export function clearRecoveryBatch(): void {
  current = null;
  emit();
}

export function useRecoveryBatch(): RecoveryBatch | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => null,
  );
}
