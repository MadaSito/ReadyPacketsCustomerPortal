/**
 * Database-backed, restart-safe rate limiter with distinct budgets per category. Owner: http_security engineer.
 * Integrator stub: replace the body; keep the factory signature.
 */
import type { Clock, Db, Logger, RateLimiter, SettingsStore } from "../core/types.js";

export interface RateLimiterDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  settings: SettingsStore;
}

export function createRateLimiter(_deps: RateLimiterDeps): RateLimiter {
  throw new Error("NOT_IMPLEMENTED: createRateLimiter (http_security engineer)");
}
