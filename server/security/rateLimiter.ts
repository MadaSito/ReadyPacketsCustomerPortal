/**
 * Database-backed, restart-safe rate limiter with distinct budgets per category. Owner: http_security engineer.
 * Integrator stub: replace the body; keep the factory signature.
 */
import { createHash } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import { z } from "zod";
import { RATE_LIMIT_CATEGORIES } from "../core/types.js";
import type { Clock, Db, Logger, MaintainableRateLimiter, RateLimitCategory, SettingsStore } from "../core/types.js";
import { defineSetting, readSetting, type ValueSettingDefinition } from "../modules/platform/index.js";
import { rateLimitCounters as counters } from "./rateLimiterSchema.js";

export interface RateLimiterDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  settings: SettingsStore;
}

export interface DbRateLimiter extends MaintainableRateLimiter {
  cleanup(): Promise<number>;
}

interface Budget {
  maxRequests: number;
  windowSeconds: number;
}

const DEFAULT_BUDGETS = {
  auth_high_risk: { maxRequests: 30, windowSeconds: 300 },
  user_login: { maxRequests: 15, windowSeconds: 300 },
  form_submission: { maxRequests: 30, windowSeconds: 60 },
  api: { maxRequests: 300, windowSeconds: 60 },
  expensive: { maxRequests: 30, windowSeconds: 60 },
  standard_browsing: { maxRequests: 400, windowSeconds: 60 },
} satisfies Record<RateLimitCategory, Budget>;

const budgetSchema = z.strictObject({
  maxRequests: z.number().int().min(1).max(100_000),
  windowSeconds: z.number().int().min(1).max(86_400),
});

const budgetSettings = Object.fromEntries(RATE_LIMIT_CATEGORIES.map((category) => [
  category,
  defineSetting({
    key: `http.rate_limit.${category}`,
    owner: "http",
    group: "security",
    label: `HTTP rate limit: ${category.replaceAll("_", " ")}`,
    description: "Maximum request cost in a fixed-duration bucket for one independently verified subject.",
    schema: budgetSchema,
    default: DEFAULT_BUDGETS[category],
    sensitivity: "internal",
  }),
])) as Record<RateLimitCategory, ValueSettingDefinition<Budget>>;

// Bounded hash buckets prevent arbitrary subject cardinality from growing the table indefinitely.
// Collisions share a bucket (a conservative denial, never a limiter bypass). No client keys are stored.
const SLOT_MASK = (1 << 18) - 1;

export function createRateLimiter(deps: RateLimiterDeps): DbRateLimiter {
  const nextAlert = new Map<RateLimitCategory, number>();

  const limiter: DbRateLimiter = {
    async consume(category, key, cost = 1) {
      if (!Number.isSafeInteger(cost) || cost < 1 || cost > 100_000 || !key || key.length > 512) {
        return { allowed: false, retryAfterSeconds: 60 };
      }
      try {
        // Override changes take effect without dropping active windows (new durations apply upon reset).
        const budget = await readSetting(deps.settings, budgetSettings[category]);
        const slot = createHash("sha256").update(category).update("\0").update(key).digest().readUInt32BE(0) & SLOT_MASK;
        const where = and(eq(counters.category, category), eq(counters.slot, slot));
        return await deps.db.transaction(async (tx) => {
          // The upsert takes the same exclusive row lock across processes, even when hits is unchanged.
          await tx.insert(counters).values({ category, slot, hits: 0, resetAt: deps.clock.now() })
            .onDuplicateKeyUpdate({ set: { slot } });
          const [row] = await tx.select({ hits: counters.hits, resetAt: counters.resetAt })
            .from(counters).where(where).for("update");
          if (!row) throw new Error("RATE_LIMIT_COUNTER_UNAVAILABLE");
          const now = deps.clock.now().getTime();
          const fresh = row.resetAt.getTime() <= now;
          const resetAt = fresh ? new Date(now + budget.windowSeconds * 1000) : row.resetAt;
          const hits = (fresh ? 0 : row.hits) + cost;
          if (hits > budget.maxRequests) {
            return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((resetAt.getTime() - now) / 1000)) };
          }
          await tx.update(counters).set({ hits, resetAt }).where(where);
          return { allowed: true, retryAfterSeconds: 0 };
        });
      } catch {
        const now = deps.clock.now().getTime();
        if ((nextAlert.get(category) ?? 0) <= now) {
          nextAlert.set(category, now + 60_000);
          deps.logger.error("http rate limiter storage unavailable", { category, failsOpen: category === "standard_browsing" });
        }
        return category === "standard_browsing"
          ? { allowed: true, retryAfterSeconds: 0 }
          : { allowed: false, retryAfterSeconds: 30 };
      }
    },
    async cleanup() {
      const cutoff = deps.clock.now();
      let deleted = 0;
      for (let i = 0; i < 4; i++) {
        const [result] = await deps.db.delete(counters).where(lte(counters.resetAt, cutoff)).limit(5_000);
        deleted += result.affectedRows;
        if (result.affectedRows < 5_000) break;
      }
      return deleted;
    },
    registerMaintenance(jobs) {
      const type = "http.rate_limit.cleanup";
      jobs.register(type, async (job) => {
        await job.assertStillOwned();
        return { outcome: "completed", safeCounts: { deleted: await limiter.cleanup() } };
      });
      jobs.registerSchedule({ name: type, type, everyMs: 60_000 });
    },
  };
  return limiter;
}
