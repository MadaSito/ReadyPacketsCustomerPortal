import { count } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRateLimiter } from "../../server/security/rateLimiter.js";
import { rateLimitCounters } from "../../server/security/rateLimiterSchema.js";
import { createTestDeps, silentLogger } from "../helpers/fakes.js";
import { createTestDb, type TestDb } from "../helpers/testDb.js";

vi.mock("../../server/modules/platform/index.js", () => import("../../server/modules/platform/settingsRegistry.js"));

describe("database rate limiter", () => {
  let database: TestDb;
  beforeAll(async () => { database = await createTestDb({ schema: { rateLimitCounters } }); });
  afterAll(async () => { await database?.cleanup(); });

  it("serializes concurrent consumption across instances, honors duration/cost, and survives fresh instances", async () => {
    const h = createTestDeps({ db: database.db });
    await h.settings.set("http.rate_limit.auth_high_risk", { maxRequests: 9, windowSeconds: 4 });
    const deps = { ...h.deps, tokenHashKey: h.config.tokenHashKey };
    const first = createRateLimiter(deps);
    const second = createRateLimiter(deps);
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => (
      (index % 2 ? first : second).consume("auth_high_risk", "ip:198.51.100.41", 2)
    )));
    expect(results.filter((result) => result.allowed)).toHaveLength(4);
    expect(results.filter((result) => !result.allowed).every((result) => result.retryAfterSeconds === 4)).toBe(true);
    const restarted = createRateLimiter(deps);
    await expect(restarted.consume("auth_high_risk", "ip:198.51.100.41", 1)).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    await expect(restarted.consume("auth_high_risk", "ip:198.51.100.41")).resolves.toEqual({ allowed: false, retryAfterSeconds: 4 });
    await expect(restarted.consume("api", "ip:198.51.100.41")).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    h.clock.advance(4001);
    await expect(second.consume("auth_high_risk", "ip:198.51.100.41")).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(await second.consume("auth_high_risk", "synthetic-invalid-cost", -1)).toMatchObject({ allowed: false });
  });

  it("registers maintenance and prunes expired but not active counters", async () => {
    const h = createTestDeps({ db: database.db });
    const limiter = createRateLimiter({ ...h.deps, tokenHashKey: h.config.tokenHashKey });
    limiter.registerMaintenance(h.jobs);
    expect(h.jobs.schedules).toContainEqual({
      name: "http.rate_limit.cleanup", type: "http.rate_limit.cleanup", everyMs: 60_000,
    });
    await h.settings.set("http.rate_limit.expensive", { maxRequests: 6, windowSeconds: 1 });
    await limiter.consume("expensive", "ip:198.51.100.42");
    h.clock.advance(1001);
    await limiter.consume("expensive", "ip:198.51.100.43");
    await h.jobs.enqueue("http.rate_limit.cleanup", {});
    expect(await h.jobs.runAll()).toEqual([{ outcome: "completed", safeCounts: { deleted: 1 } }]);
    const [row] = await database.db.select({ total: count() }).from(rateLimitCounters);
    expect(row?.total).toBeGreaterThan(0);
    expect(await limiter.consume("expensive", "ip:198.51.100.43", 6)).toMatchObject({ allowed: false });
  });

  it("backs off repeated exceeded windows across instances without extending delays on retries, caps, and decays", async () => {
    const h = createTestDeps({ db: database.db });
    await h.settings.set("http.rate_limit.user_login", {
      maxRequests: 6, windowSeconds: 10, backoff: { enabled: true, factor: 3, maxSeconds: 40, resetAfterMinutes: 1 },
    });
    const make = () => createRateLimiter({ ...h.deps, tokenHashKey: h.config.tokenHashKey });
    const key = "ip:203.0.113.199";
    for (const expected of [10, 30, 40, 40]) {
      const limiter = make();
      await expect(limiter.consume("user_login", key, 6)).resolves.toMatchObject({ allowed: true });
      await expect(limiter.consume("user_login", key)).resolves.toEqual({ allowed: false, retryAfterSeconds: expected });
      h.clock.advance(1000);
      await expect(make().consume("user_login", key)).resolves.toEqual({ allowed: false, retryAfterSeconds: expected - 1 });
      h.clock.advance((expected - 1) * 1000 + 1);
    }
    h.clock.advance(60_001);
    const limiter = make();
    await limiter.consume("user_login", key, 6);
    await expect(limiter.consume("user_login", key)).resolves.toEqual({ allowed: false, retryAfterSeconds: 10 });
  });

  it("shares normalized address counters for replicas with the same root and separates a different root", async () => {
    const h = createTestDeps({ db: database.db });
    await h.settings.set("http.rate_limit.form_submission", { maxRequests: 8, windowSeconds: 60 });
    const deps = { ...h.deps, tokenHashKey: h.config.tokenHashKey };
    const first = createRateLimiter(deps);
    const replica = createRateLimiter(deps);
    const otherRoot = createRateLimiter({ ...deps, tokenHashKey: Buffer.alloc(32, 213).toString("base64") });
    await expect(first.consume("form_submission", "edge:ip:2001:db8:17:2::1", 8)).resolves.toMatchObject({ allowed: true });
    await expect(replica.consume("form_submission", "edge:ip:2001:0DB8:17:2:abcd:1234:5678:9abc"))
      .resolves.toMatchObject({ allowed: false });
    await expect(replica.consume("form_submission", "edge:ip:2001:db8:17:3::1")).resolves.toMatchObject({ allowed: true });
    await expect(otherRoot.consume("form_submission", "edge:ip:2001:db8:17:2::1")).resolves.toMatchObject({ allowed: true });
    await expect(first.consume("form_submission", "ip:::ffff:c000:20a", 8)).resolves.toMatchObject({ allowed: true });
    await expect(replica.consume("form_submission", "ip:192.0.2.10")).resolves.toMatchObject({ allowed: false });
  });

  it("fails closed for API/security traffic and alerts once per interval when standard browsing fails open", async () => {
    const h = createTestDeps(); // intentionally has no DB implementation
    const error = vi.fn();
    const limiter = createRateLimiter({ ...h.deps, tokenHashKey: h.config.tokenHashKey, logger: { ...silentLogger, error } });
    await expect(limiter.consume("auth_high_risk", "ip:198.51.100.41")).resolves.toEqual({ allowed: false, retryAfterSeconds: 30 });
    await expect(limiter.consume("api", "ip:198.51.100.41")).resolves.toEqual({ allowed: false, retryAfterSeconds: 30 });
    await expect(limiter.consume("standard_browsing", "ip:198.51.100.41")).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    await limiter.consume("standard_browsing", "ip:198.51.100.41");
    expect(error).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledWith("http rate limiter storage unavailable", { category: "standard_browsing", failsOpen: true });
    expect(JSON.stringify(error.mock.calls)).not.toContain("198.51.100.41");
  });
});
