import { and, asc, count, desc, eq, gt, gte, lt, lte, type SQL } from "drizzle-orm";
import type { Request } from "express";
import { roleHasCapability } from "../../../shared/capabilities.js";
import type { ModuleDeps } from "../../container.js";
import { conflict, DomainError, forbidden, notFound, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { getRequestContext } from "../../core/requestContext.js";
import { RATE_LIMIT_CATEGORIES, type ModuleLifecycle, type RateLimitCategory, type RequestContext, type SessionPrincipal, type Tx } from "../../core/types.js";
import { clientAddress } from "../../http/edge.js";
import type { RateLimitBucket } from "../../http/edgeAdmission.js";
import { readSetting, writeSetting } from "../platform/index.js";
import { boundedBudget, DEFAULT_BUDGETS, RATE_LIMIT_BOUNDS, rateLimitSettings, type DbRateLimiter, type RateLimitBudget } from "../../security/rateLimiter.js";
import { hasFreshStepUp } from "../../trpc/trpc.js";
import { createCountryResolver } from "./geo.js";
import { addressOf, compilePolicy, defaultPolicy, policySchema, type ProtectionPolicy, type RequestSignals } from "./policy.js";
import { isProtectionExempt, recoverySignals, requestEventLabels, requestSignals } from "./request.js";
import { protectionBlocks, protectionEvents, protectionPolicies } from "./schema.js";

const POLICY_ID = 1;
const CACHE_MS = 2_000;
const CLOCK_MINUTE = 60_000;
const AUTO_SLOTS = 4096;
const EVENT_SLOTS = 16;
const OTHER_RATE_EVENT_SLOTS = 2;
const RETENTION_MS = 14 * 86_400_000;
const MAX_EXPORT = 1000;
const IDENTIFIER = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const NO_PERMISSIONS = "CAPABILITY_NOT_GRANTED";

export interface EventFilters {
  action?: "detect" | "block";
  country?: string;
  rule?: string;
  method?: string;
  since?: Date;
  until?: Date;
}
export interface EventPageInput extends EventFilters { limit?: number; cursor?: string }
type ReadActor = SessionPrincipal | null;

type ProtectionApi = ReturnType<typeof buildProtection>;
export interface ProtectionModule extends ModuleLifecycle, ProtectionApi {}

export function createProtectionModule(deps: ModuleDeps): ProtectionModule {
  return buildProtection(deps);
}

function buildProtection(deps: ModuleDeps) {
  const { config, db, clock, audit, crypto, logger, settings, jobs } = deps;
  const geo = createCountryResolver(config, clock, logger);
  const signalsByContext = new WeakMap<RequestContext, RequestSignals>();
  let cached: { version: number; policy: ProtectionPolicy; evaluate: ReturnType<typeof compilePolicy>; validUntil: number } | undefined;
  let loading: Promise<NonNullable<typeof cached>> | undefined;
  let localSampleMinute = -1;
  let localSampleSlots = 0;
  let lastLogFailure = Number.NEGATIVE_INFINITY;
  const strikes = new Map<number, { key: string; minute: number; hits: number }>();

  function runtimeWarning(reasonCode: string) {
    const now = clock.now().getTime();
    if (lastLogFailure + CLOCK_MINUTE > now) return;
    lastLogFailure = now;
    logger.warn("protection telemetry could not be recorded", { reasonCode });
  }

  async function assertActor(principal: ReadActor, manage: boolean, tx: Tx) {
    const capability = manage ? "security.firewall.manage" : "security.firewall.read";
    if (!principal || principal.role !== "admin" || principal.state !== "full" || !roleHasCapability(principal.role, capability)) {
      throw forbidden(NO_PERMISSIONS);
    }
    const live = await deps.services.identity.sessions.assertCurrent(principal, tx);
    if (live.role !== "admin" || live.pendingSteps.length || !roleHasCapability(live.role, capability)) {
      throw forbidden(NO_PERMISSIONS);
    }
    if (manage && !hasFreshStepUp({ ...principal, stepUpAt: live.stepUpAt }, clock.now())) {
      throw new DomainError("STEP_UP_REQUIRED", "STEP_UP_REQUIRED", "Confirm your identity before updating protection.", { capability });
    }
  }

  async function storeRead(tx?: Tx) {
    const [row] = await (tx ?? db).select({ policy: protectionPolicies.policy, version: protectionPolicies.version })
      .from(protectionPolicies).where(eq(protectionPolicies.id, POLICY_ID)).limit(1);
    return { policy: row ? policySchema.parse(row.policy) : defaultPolicy, version: row?.version ?? 1 };
  }

  function currentPolicy() {
    const now = clock.now().getTime();
    if (cached && cached.validUntil > now) return Promise.resolve(cached);
    if (loading) return loading;
    loading = storeRead().then((row) => {
      cached = { ...row, evaluate: compilePolicy(row.policy), validUntil: now + CACHE_MS };
      return cached;
    }).finally(() => { loading = undefined; });
    return loading;
  }

  async function detectEvent(
    source: Pick<RequestSignals, "address" | "country">, action: "detect" | "block", rule: string,
    labels: ReturnType<typeof requestEventLabels>, rateLimitBucket?: RateLimitBucket,
  ) {
    const now = clock.now();
    const minute = Math.floor(now.getTime() / CLOCK_MINUTE);
    const ctx = getRequestContext();
    if (!ctx) return;
    const address = source.address?.text;
    const key = crypto.blindIndex(`${address ?? "unknown"}:${rule}`, "protection.event-slot");
    // Reserve independent rate-limit slots so a 429 flood cannot consume policy-event samples.
    const hash = Number.parseInt(key.slice(0, 8), 16);
    const slot = rateLimitBucket === "edge_requests" ? EVENT_SLOTS :
      rateLimitBucket === "edge_static" ? EVENT_SLOTS + 1 :
      rateLimitBucket ? EVENT_SLOTS + 2 + hash % OTHER_RATE_EVENT_SLOTS : hash % EVENT_SLOTS;
    if (localSampleMinute !== minute) { localSampleMinute = minute; localSampleSlots = 0; }
    if ((localSampleSlots & (1 << slot)) !== 0) return;
    localSampleSlots |= 1 << slot;
    const publicId = ulid(now.getTime());
    try {
      await db.transaction(async (tx) => {
        // Unique (minute, slot) across replicas; duplicate slots never create additional audit events.
        const [inserted] = await tx.insert(protectionEvents).ignore().values({
          publicId, minute, slot, action, rule, ...labels, country: source.country, correlationId: ctx.correlationId ?? ctx.requestId,
          addressEnc: address ? crypto.encrypt(address, `protection_events.address_enc:${publicId}`) : null, createdAt: now,
        });
        if (!inserted.affectedRows) return;
        await audit.record({
          category: "security", eventName: "protection.request_evaluated", action: "evaluate",
          severity: action === "block" ? "WARN" : "INFO", outcome: action === "block" ? "denied" : "completed",
          reasonCode: rateLimitBucket ? "RATE_LIMITED" : action === "block" ? "PROTECTION_BLOCK" : "PROTECTION_DETECT",
          resource: { type: "protection_event", publicId },
          attributes: { rule, method: labels.method, route: labels.route, ...(source.country ? { country: source.country } : {}),
            ...(rateLimitBucket ? { rateLimitBucket } : {}) },
        }, tx);
      });
    } catch {
      runtimeWarning("PROTECTION_EVENT_WRITE_FAILED");
    }
  }

  async function incrementStrike(address: string, addressKey: string, bucket: number, policy: ProtectionPolicy) {
    const now = clock.now();
    const minute = Math.floor(now.getTime() / CLOCK_MINUTE);
    const prior = strikes.get(bucket);
    if (prior && prior.minute === minute && prior.key !== addressKey) return;
    const hits = prior?.minute === minute ? prior.hits + 1 : 1;
    strikes.set(bucket, { key: addressKey, minute, hits });
    if (hits !== policy.automatic.threshold) return;
    const publicId = ulid(now.getTime());
    try {
      await db.transaction(async (tx) => {
        // A collision with an unexpired slot never blocks the wrong address or extends that block.
        await tx.delete(protectionBlocks).where(and(eq(protectionBlocks.bucket, bucket), lte(protectionBlocks.expiresAt, now)));
        const [result] = await tx.insert(protectionBlocks).ignore().values({
          publicId, bucket, addressKey, addressEnc: crypto.encrypt(address, `protection_blocks.address_enc:${publicId}`),
          expiresAt: new Date(now.getTime() + policy.automatic.minutes * CLOCK_MINUTE), createdAt: now,
        });
        if (result.affectedRows) await audit.record({
          category: "security", eventName: "protection.temporary_block_created", action: "create",
          outcome: "completed", severity: "WARN", resource: { type: "protection_block", publicId },
          attributes: { durationMinutes: policy.automatic.minutes },
        }, tx);
      });
    } catch {
      runtimeWarning("PROTECTION_TEMPORARY_BLOCK_WRITE_FAILED");
    }
  }

  const maintainable = deps.rateLimiter as Partial<DbRateLimiter>;

  function whereEvents(input: EventFilters, cursor?: string) {
    const filters: SQL[] = [];
    if (input.action) filters.push(eq(protectionEvents.action, input.action));
    if (input.country) filters.push(eq(protectionEvents.country, input.country));
    if (input.rule) filters.push(eq(protectionEvents.rule, input.rule));
    if (input.method) filters.push(eq(protectionEvents.method, input.method));
    if (input.since) filters.push(gte(protectionEvents.createdAt, input.since));
    if (input.until) filters.push(lte(protectionEvents.createdAt, input.until));
    if (cursor) filters.push(lt(protectionEvents.publicId, cursor));
    return and(...filters);
  }

  function eventView(row: typeof protectionEvents.$inferSelect) {
    const { publicId, action, rule, method, route, country, agent, correlationId, createdAt } = row;
    return {
      publicId, action, rule, method, route, country, agent, correlationId, createdAt,
      ipAddress: row.addressEnc ? crypto.decrypt(row.addressEnc, `protection_events.address_enc:${publicId}`) : null,
    };
  }

  const cleanupJob = "protection.cleanup";
  jobs.register(cleanupJob, async (job) => {
    await job.assertStillOwned();
    const now = clock.now();
    const [events] = await db.delete(protectionEvents).where(lt(protectionEvents.createdAt, new Date(now.getTime() - RETENTION_MS))).limit(4000);
    const [blocks] = await db.delete(protectionBlocks).where(lte(protectionBlocks.expiresAt, now)).limit(AUTO_SLOTS);
    return { outcome: "completed", safeCounts: { events: events.affectedRows, blocks: blocks.affectedRows } };
  });
  jobs.registerSchedule({ name: cleanupJob, type: cleanupJob, everyMs: 15 * CLOCK_MINUTE });

  return {
    clientCountry(req?: Request) {
      if (req) return geo.lookup(addressOf(clientAddress(req))?.text, req);
      const ctx = getRequestContext();
      return ctx ? signalsByContext.get(ctx)?.country ?? null : null;
    },
    async recordRateLimit(req: Request, route: string, bucket: RateLimitBucket): Promise<void> {
      const ctx = getRequestContext();
      if (!ctx || config.protectionDisabled) return;
      const country = signalsByContext.get(ctx)?.country ?? null;
      await detectEvent({ address: addressOf(ctx.ipAddress), country }, "block", `rate_limit.${bucket}`,
        { ...requestEventLabels(req, ctx.userAgent?.toLowerCase()), route }, bucket);
    },
    async inspect(req: Request): Promise<{ action: "allow" | "block" }> {
      if (isProtectionExempt(req)) return { action: "allow" };
      const ctx = getRequestContext();
      await geo.ensure();
      const source = requestSignals(req, geo.lookup(addressOf(clientAddress(req))?.text, req));
      if (ctx) signalsByContext.set(ctx, source);
      if (config.protectionDisabled) return { action: "allow" };
      const { evaluate, policy } = await currentPolicy();
      const now = clock.now();
      const decision = evaluate(source, now.getTime());
      if (decision.action === "allow" && decision.exempt) return { action: "allow" };
      if (policy.mode === "enforce" && policy.automatic.enabled && source.address) {
        const address = source.address.text;
        const key = crypto.blindIndex(address, "protection.automatic-address");
        const bucket = Number.parseInt(key.slice(0, 8), 16) % AUTO_SLOTS;
        const [blocked] = await db.select({ addressKey: protectionBlocks.addressKey }).from(protectionBlocks)
          .where(and(eq(protectionBlocks.bucket, bucket), gt(protectionBlocks.expiresAt, now))).limit(1);
        if (blocked?.addressKey === key) {
          await detectEvent(source, "block", "ip.automatic", requestEventLabels(req, source.headers["user-agent"]));
          return { action: "block" };
        }
        if (decision.action === "block") await incrementStrike(address, key, bucket, policy);
      }
      if (decision.action !== "allow") {
        await detectEvent(source, decision.action, decision.rule, requestEventLabels(req, source.headers["user-agent"]));
      }
      return { action: decision.action === "block" ? "block" : "allow" };
    },
    getPolicy(principal: ReadActor) {
      return db.transaction(async (tx) => {
        await assertActor(principal, false, tx);
        return storeRead(tx);
      });
    },
    setPolicy(principal: ReadActor, input: { version: number; policy: ProtectionPolicy }) {
      const policy = policySchema.parse(input.policy);
      return db.transaction(async (tx) => {
        await assertActor(principal, true, tx);
        const context = getRequestContext();
        const source = context ? signalsByContext.get(context) : undefined;
        if (!source?.address) throw forbidden("ADMIN_ADDRESS_UNVERIFIABLE");
        // A temporary allow rule must not be the only protection against locking the administrator out.
        const check = compilePolicy({ ...policy, ipLists: policy.ipLists.filter((r) => r.action !== "allow" || r.expiresAt === null) });
        if (recoverySignals(source).some((s) => check(s, clock.now().getTime()).action === "block")) {
          throw validation("PROTECTION_SELF_LOCKOUT", "This policy would block access from your current IP address or country.");
        }
        await tx.insert(protectionPolicies).values({ id: POLICY_ID, policy: defaultPolicy, version: 1, updatedAt: clock.now() })
          .onDuplicateKeyUpdate({ set: { id: POLICY_ID } });
        const [result] = await tx.update(protectionPolicies).set({ policy, version: input.version + 1, updatedAt: clock.now() })
          .where(and(eq(protectionPolicies.id, POLICY_ID), eq(protectionPolicies.version, input.version)));
        if (result.affectedRows !== 1) throw conflict("PROTECTION_VERSION_CONFLICT", "Protection changed. Reload before saving.");
        await audit.record({
          category: "security", eventName: "protection.policy_updated", action: "update", outcome: "completed", severity: "INFO",
          attributes: { version: input.version + 1, mode: policy.mode, countryMode: policy.countries.mode, automatic: policy.automatic.enabled },
        }, tx);
        return { version: input.version + 1, policy };
      }).then((result) => { cached = undefined; return result; });
    },
    getRateLimits(principal: ReadActor) {
      return db.transaction(async (tx) => {
        await assertActor(principal, false, tx);
        return Promise.all(RATE_LIMIT_CATEGORIES.map(async (category) => ({
          category, defaults: DEFAULT_BUDGETS[category], bounds: RATE_LIMIT_BOUNDS[category],
          budget: config.protectionDisabled ? DEFAULT_BUDGETS[category] : boundedBudget(category, await readSetting(settings, rateLimitSettings[category], tx)),
        })));
      });
    },
    setRateLimit(principal: ReadActor, category: RateLimitCategory, budget?: RateLimitBudget) {
      const selected = budget ?? DEFAULT_BUDGETS[category];
      const bounded = boundedBudget(category, selected);
      if (!Number.isSafeInteger(selected.maxRequests) || !Number.isSafeInteger(selected.windowSeconds) ||
          bounded.maxRequests !== selected.maxRequests || bounded.windowSeconds !== selected.windowSeconds) {
        throw validation("RATE_LIMIT_OUTSIDE_SAFE_BOUNDS", "Set a request limit and window within the displayed safe bounds.");
      }
      return db.transaction(async (tx) => {
        await assertActor(principal, true, tx);
        await writeSetting(settings, rateLimitSettings[category], bounded, tx);
        await audit.record({
          category: "security", eventName: "protection.rate_limit_updated", action: budget ? "update" : "reset",
          outcome: "completed", severity: "INFO",
          attributes: { category, maxRequests: bounded.maxRequests, windowSeconds: bounded.windowSeconds },
        }, tx);
        return bounded;
      });
    },
    listBlocks(principal: ReadActor) {
      return db.transaction(async (tx) => {
        await assertActor(principal, false, tx);
        const rows = await tx.select().from(protectionBlocks).where(gt(protectionBlocks.expiresAt, clock.now()))
          .orderBy(asc(protectionBlocks.expiresAt), asc(protectionBlocks.publicId)).limit(100);
        return rows.map((row) => ({
          publicId: row.publicId, expiresAt: row.expiresAt, ipAddress: crypto.decrypt(row.addressEnc, `protection_blocks.address_enc:${row.publicId}`),
        }));
      }).then(async (automatic) => ({ automatic, rateLimits: await (maintainable.listBlocks?.() ?? Promise.resolve([])) }));
    },
    releaseBlock(principal: ReadActor, input: { source: "automatic" | "rate"; publicId: string }) {
      return db.transaction(async (tx) => {
        await assertActor(principal, true, tx);
        let bucket: number | undefined;
        if (input.source === "automatic") {
          const [row] = await tx.select({ bucket: protectionBlocks.bucket }).from(protectionBlocks)
            .where(and(eq(protectionBlocks.publicId, input.publicId), gt(protectionBlocks.expiresAt, clock.now()))).for("update");
          if (!row) throw notFound("PROTECTION_BLOCK_NOT_FOUND");
          await tx.delete(protectionBlocks).where(eq(protectionBlocks.publicId, input.publicId));
          bucket = row.bucket;
        } else if (!(await maintainable.releaseBlock?.(input.publicId, tx))) {
          throw notFound("PROTECTION_BLOCK_NOT_FOUND");
        }
        await audit.record({
          category: "security", eventName: "protection.block_released", action: "release", outcome: "completed", severity: "WARN",
          resource: { type: "protection_block", publicId: input.publicId }, attributes: { source: input.source },
        }, tx);
        return bucket;
      }).then((bucket) => {
        if (bucket !== undefined) strikes.delete(bucket);
        return { released: true as const };
      });
    },
    overview(principal: ReadActor) {
      return db.transaction(async (tx) => {
        await assertActor(principal, false, tx);
        const { policy } = await storeRead(tx);
        const rows = await tx.select({ action: protectionEvents.action, total: count() }).from(protectionEvents)
          .where(gte(protectionEvents.createdAt, new Date(clock.now().getTime() - 86_400_000))).groupBy(protectionEvents.action);
        return {
          mode: policy.mode, bypassed: config.protectionDisabled === true, countrySourceConfigured: Boolean(config.protectionMmdbPath || config.protectionCountryHeader),
          detected: rows.find((r) => r.action === "detect")?.total ?? 0, blocked: rows.find((r) => r.action === "block")?.total ?? 0,
        };
      });
    },
    listEvents(principal: ReadActor, input: EventPageInput) {
      return db.transaction(async (tx) => {
        await assertActor(principal, false, tx);
        if (input.cursor && !IDENTIFIER.test(input.cursor)) throw validation("INVALID_CURSOR", "The page cursor is invalid.");
        const limit = Math.min(100, Math.max(1, input.limit ?? 25));
        const rows = await tx.select().from(protectionEvents).where(whereEvents(input, input.cursor))
          .orderBy(desc(protectionEvents.publicId)).limit(limit + 1);
        const items = rows.slice(0, limit).map(eventView);
        return { items, nextCursor: rows.length > limit ? items.at(-1)?.publicId ?? null : null };
      });
    },
    exportEvents(principal: ReadActor, input: EventFilters) {
      return db.transaction(async (tx) => {
        await assertActor(principal, false, tx);
        const rows = await tx.select().from(protectionEvents).where(whereEvents(input))
          .orderBy(desc(protectionEvents.publicId)).limit(MAX_EXPORT + 1);
        const items = rows.slice(0, MAX_EXPORT).map(eventView);
        await audit.record({
          category: "security", eventName: "protection.events_exported", action: "export",
          outcome: "completed", severity: "WARN", attributes: { rows: items.length, truncated: rows.length > MAX_EXPORT },
        }, tx);
        return { items, truncated: rows.length > MAX_EXPORT };
      });
    },
  };
}
