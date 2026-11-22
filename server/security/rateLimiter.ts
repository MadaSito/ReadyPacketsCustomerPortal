/**
 * Database-backed, restart-safe rate limiter with distinct budgets per category. Owner: http_security engineer.
 */
import { createHmac, hkdfSync } from "node:crypto";
import { and, asc, eq, gt, isNotNull, lte } from "drizzle-orm";
import { z } from "zod";
import { RATE_LIMIT_CATEGORIES } from "../core/types.js";
import type { Clock, Db, Logger, MaintainableRateLimiter, RateLimitCategory, SettingsStore, Tx } from "../core/types.js";
import { ulid } from "../core/ids.js";
import { defineSetting, readSetting, type ValueSettingDefinition } from "../modules/platform/index.js";
import { rateLimitCounters as counters } from "./rateLimiterSchema.js";
import { normalizeRateLimitKey } from "./rateLimitAddress.js";

export interface RateLimiterDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  settings: SettingsStore;
  tokenHashKey: string;
  protectionDisabled?: boolean;
}

export interface DbRateLimiter extends MaintainableRateLimiter {
  cleanup(): Promise<number>;
  listBlocks(): Promise<{ publicId: string; category: RateLimitCategory; expiresAt: Date }[]>;
  releaseBlock(publicId: string, tx: Tx): Promise<boolean>;
}

export interface RateLimitBudget {
  maxRequests: number;
  windowSeconds: number;
}

export const DEFAULT_BUDGETS = {
  auth_high_risk: { maxRequests: 30, windowSeconds: 300 },
  user_login: { maxRequests: 15, windowSeconds: 300 },
  form_submission: { maxRequests: 30, windowSeconds: 60 },
  api: { maxRequests: 300, windowSeconds: 60 },
  expensive: { maxRequests: 30, windowSeconds: 60 },
  standard_browsing: { maxRequests: 400, windowSeconds: 60 },
} satisfies Record<RateLimitCategory, RateLimitBudget>;

export const RATE_LIMIT_BOUNDS = {
  auth_high_risk: { min: 8, max: 60, maxWindow: 600 },
  user_login: { min: 6, max: 30, maxWindow: 600 },
  form_submission: { min: 8, max: 60, maxWindow: 300 },
  api: { min: 40, max: 1_200, maxWindow: 300 },
  expensive: { min: 6, max: 60, maxWindow: 300 },
  standard_browsing: { min: 60, max: 1_200, maxWindow: 300 },
} satisfies Record<RateLimitCategory, { min: number; max: number; maxWindow: number }>;

const budgetSchema = z.strictObject({
  maxRequests: z.number().int().min(1).max(100_000),
  windowSeconds: z.number().int().min(1).max(86_400),
});

export const rateLimitSettings = Object.fromEntries(RATE_LIMIT_CATEGORIES.map((category) => [
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
    exportable: false,
    writeCapability: "security.firewall.manage",
    managedBy: { href: "/admin/protection/rate-limits", label: "Protection rate limits" },
  }),
])) as Record<RateLimitCategory, ValueSettingDefinition<RateLimitBudget>>;

export function boundedBudget(category: RateLimitCategory, budget: RateLimitBudget): RateLimitBudget {
  const { min, max, maxWindow } = RATE_LIMIT_BOUNDS[category];
  return {
    maxRequests: Math.max(min, Math.min(max, budget.maxRequests)),
    windowSeconds: Math.max(1, Math.min(maxWindow, budget.windowSeconds)),
  };
}

// Bounded hash buckets prevent arbitrary subject cardinality from growing the table indefinitely.
// Collisions share a bucket (a conservative denial, never a limiter bypass). No client keys are stored.
const SLOT_MASK = (1 << 18) - 1;

export function createRateLimiter(deps: RateLimiterDeps): DbRateLimiter {
  const slotKey = Buffer.from(hkdfSync(
    "sha256", Buffer.from(deps.tokenHashKey, "base64"), "", "readypackets/http/durable-rate-limit-slot/v1", 32,
  ));
  const nextAlert = new Map<RateLimitCategory, number>();

  const limiter: DbRateLimiter = {
    async consume(category, key, cost = 1) {
      if (!Number.isSafeInteger(cost) || cost < 1 || cost > 100_000 || !key || key.length > 512) {
        return { allowed: false, retryAfterSeconds: 60 };
      }
      try {
        // Override changes take effect without dropping active windows (new durations apply upon reset).
        const budget = deps.protectionDisabled ? DEFAULT_BUDGETS[category] :
          boundedBudget(category, await readSetting(deps.settings, rateLimitSettings[category]));
        const slot = createHmac("sha256", slotKey).update(category).update("\0")
          .update(normalizeRateLimitKey(key)).digest().readUInt32BE(0) & SLOT_MASK;
        const where = and(eq(counters.category, category), eq(counters.slot, slot));
        return await deps.db.transaction(async (tx) => {
          // The upsert takes the same exclusive row lock across processes, even when hits is unchanged.
          await tx.insert(counters).values({ category, slot, hits: 0, resetAt: deps.clock.now() })
            .onDuplicateKeyUpdate({ set: { slot } });
          const [row] = await tx.select({ hits: counters.hits, resetAt: counters.resetAt, blockPublicId: counters.blockPublicId })
            .from(counters).where(where).for("update");
          if (!row) throw new Error("RATE_LIMIT_COUNTER_UNAVAILABLE");
          const now = deps.clock.now().getTime();
          const fresh = row.resetAt.getTime() <= now;
          const resetAt = fresh ? new Date(now + budget.windowSeconds * 1000) : row.resetAt;
          const hits = (fresh ? 0 : row.hits) + cost;
          if (hits > budget.maxRequests) {
            if (fresh || !row.blockPublicId) {
              await tx.update(counters).set({
                hits: fresh ? 0 : row.hits,
                resetAt,
                blockPublicId: ulid(now),
              }).where(where);
            }
            return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((resetAt.getTime() - now) / 1000)) };
          }
          await tx.update(counters).set({ hits, resetAt, blockPublicId: fresh ? null : row.blockPublicId }).where(where);
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
    async listBlocks() {
      const rows = await deps.db.select({
        publicId: counters.blockPublicId, category: counters.category, expiresAt: counters.resetAt,
      }).from(counters).where(and(isNotNull(counters.blockPublicId), gt(counters.resetAt, deps.clock.now())))
        .orderBy(asc(counters.resetAt), asc(counters.blockPublicId)).limit(100);
      return rows.flatMap((row) => row.publicId ? [{ ...row, publicId: row.publicId }] : []);
    },
    async releaseBlock(publicId, tx) {
      const [result] = await tx.delete(counters).where(and(eq(counters.blockPublicId, publicId), gt(counters.resetAt, deps.clock.now())));
      return result.affectedRows === 1;
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
