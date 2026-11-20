import { randomInt } from "node:crypto";

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** Optional deterministic jitter factor `[0, 1)` for tests. */
  jitterUnit?: number;
}

/**
 * Computes bounded exponential backoff with ±25% cryptographic jitter.
 * Attempt 1 => ~2s, attempt 2 => ~4s, ..., capped at `maxMs` (default 15 minutes).
 */
export function computeRetryBackoffMs(attempt: number, options: BackoffOptions = {}): number {
  const baseMs = options.baseMs ?? 2_000;
  const maxMs = options.maxMs ?? 15 * 60 * 1_000;
  const safeAttempt = Math.max(1, Math.min(20, Math.trunc(attempt)));
  const exp = Math.min(maxMs, baseMs * 2 ** (safeAttempt - 1));
  const unit = options.jitterUnit !== undefined ? Math.max(0, Math.min(1, options.jitterUnit)) : randomInt(0, 10_000) / 10_000;
  const factor = 0.75 + unit * 0.5; // [0.75, 1.25]
  return Math.max(500, Math.min(maxMs, Math.round(exp * factor)));
}
