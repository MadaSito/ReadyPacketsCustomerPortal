/**
 * Promotions module — business service, atomic redemption port, abuse throttling, and admin console operations.
 * Owner: siem_engineer (Increment 05, Package C1).
 */
import { and, desc, eq, gte, inArray, lt, lte, notInArray, sql } from "drizzle-orm";
import { ulid as newPublicId } from "../../core/ids.js";
import { STEP_UP_CAPABILITIES, roleHasCapability, type Capability } from "../../../shared/capabilities.js";
import {
  DomainError,
  conflict,
  forbidden,
  notFound,
  validation,
} from "../../core/errors.js";
import { getRequestContext } from "../../core/requestContext.js";
import type { DbOrTx, SessionPrincipal, Tx } from "../../core/types.js";
import type { ModuleDeps, Services } from "../../container.js";
import { STEP_UP_MAX_AGE_MS } from "../../trpc/trpc.js";
import { users, userSessions } from "../identity/schema.js";
import { orders } from "../orders/schema.js";
import {
  assertLabelDistinctFromCode,
  computePromoCodeCandidates,
  computePromoCodeIndex,
  decryptPromoCode,
  encryptPromoCode,
  generatePromoCode,
  isPlausiblePromoCode,
  maskBatchSummary,
  maskPromoCode,
  normalizePromoCode,
  normalizePromoPrefix,
  toFormulaSafeCsv,
  validateAdminPromoCode,
} from "./codes.js";
import type {
  CursorPage,
  PromoDerivedStatus,
  PromoDiscountType,
  PromoRedemptionStatus,
  PromoStatus,
  PromotionContext,
  PromotionCsvExportView,
  PromotionOutcome,
  PromotionRedemptionView,
  PromotionScope,
  PromotionStatsView,
  PromotionView,
  PromotionsSettingsView,
} from "./contracts.js";
import {
  promoBatches,
  promoCheckAttempts,
  promoCodes,
  promoRedemptions,
  type PromoBatchRow,
  type PromoCodeRow,
  type PromoRedemptionRow,
} from "./schema.js";
import {
  DEFAULT_PROMOTIONS_POLICY,
  PROMOTIONS_ENABLED_FLAG,
  PROMOTIONS_POLICY_SETTING,
  promotionsPolicySchema,
  type PromotionsPolicyConfig,
} from "./settings.js";

const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const ATTEMPT_PAUSE_MS = 15 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;
const BATCH_INSERT_CHUNK = 500;
const MAX_BATCH_SIZE_PER_CALL = 5_000;
const MAX_TOTAL_CODES_PER_PROMO = 25_000;

export const promoNotApplicable = () =>
  new DomainError("VALIDATION", "PROMO_NOT_APPLICABLE", "This code cannot be applied.");

export const promoAttemptsBlocked = (retryAfterSeconds: number) =>
  new DomainError(
    "RATE_LIMITED",
    "PROMO_ATTEMPTS_BLOCKED",
    "Too many unsuccessful code attempts. Please wait 15 minutes before trying another code.",
    { retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)) },
  );

interface OrderPaymentExposure {
  grossPaidMinor: number;
  payableInvoiceOpen: boolean;
  providerCapturePending: boolean;
}

type OrderPaymentExposureFn = (tx: Tx, orderPublicId: string) => Promise<OrderPaymentExposure>;

function resolvePaymentExposurePort(services: Services): OrderPaymentExposureFn | null {
  const compliance = (services as Partial<Services>).compliance as Record<string, unknown> | undefined;
  const fn = compliance?.orderPaymentExposureInTx;
  return typeof fn === "function" ? (fn.bind(compliance) as OrderPaymentExposureFn) : null;
}

function isZeroPaymentExposure(exposure: unknown): exposure is OrderPaymentExposure {
  if (!exposure || typeof exposure !== "object") return false;
  const e = exposure as Partial<OrderPaymentExposure>;
  return (
    e.grossPaidMinor === 0 &&
    e.payableInvoiceOpen === false &&
    e.providerCapturePending === false
  );
}

function isMysqlDuplicateError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const rec = err as { errno?: number; code?: string; cause?: { errno?: number; code?: string } };
  return (
    rec.errno === 1062 ||
    rec.code === "ER_DUP_ENTRY" ||
    rec.cause?.errno === 1062 ||
    rec.cause?.code === "ER_DUP_ENTRY"
  );
}

function isMysqlDeadlockError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const rec = err as { errno?: number; code?: string; cause?: { errno?: number; code?: string } };
  return (
    rec.errno === 1213 ||
    rec.code === "ER_LOCK_DEADLOCK" ||
    rec.cause?.errno === 1213 ||
    rec.cause?.code === "ER_LOCK_DEADLOCK"
  );
}

function formatMoneyMinor(minor: number, currency: string): string {
  const code = currency.trim().toUpperCase() || "USD";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${code}`;
  }
}

function parseIsoOrNull(iso: string | null | undefined, fieldName: string): Date | null {
  if (iso === null || iso === undefined || iso === "") return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    throw validation("INVALID_DATE", `Provide a valid ISO-8601 timestamp for ${fieldName}.`);
  }
  return parsed;
}

function normalizeEmailDomains(domains: readonly string[] | undefined): string[] {
  if (!domains || domains.length === 0) return [];
  const out = new Set<string>();
  for (const raw of domains) {
    const cleaned = raw.trim().replace(/^@+/, "").toLowerCase();
    if (!cleaned) continue;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(cleaned)) {
      throw validation("INVALID_EMAIL_DOMAIN", "Enter valid e-mail domains such as example.com.");
    }
    out.add(cleaned);
  }
  return [...out];
}

function normalizeCustomerPublicIds(ids: readonly string[] | undefined): string[] {
  if (!ids || ids.length === 0) return [];
  const out = new Set<string>();
  for (const raw of ids) {
    const cleaned = raw.trim();
    if (!cleaned) continue;
    if (!/^[0-9A-Za-z]{16,32}$/.test(cleaned)) {
      throw validation("INVALID_CUSTOMER_ID", "Customer identifiers must be valid public IDs.");
    }
    out.add(cleaned);
  }
  return [...out];
}

function extractScopeColumns(scope: PromotionScope): {
  scopeKind: PromotionScope["kind"];
  scopeProductPublicIds: string[];
  scopeTierKeys: string[];
  scopePacketNumbers: number[];
} {
  switch (scope.kind) {
    case "all":
      return {
        scopeKind: "all",
        scopeProductPublicIds: [],
        scopeTierKeys: [],
        scopePacketNumbers: [],
      };
    case "products": {
      const ids = [...new Set(scope.productPublicIds.map((v) => v.trim()).filter(Boolean))];
      if (ids.length === 0) {
        throw validation("EMPTY_SCOPE_PRODUCTS", "Select at least one product for a product-scoped code.");
      }
      return {
        scopeKind: "products",
        scopeProductPublicIds: ids,
        scopeTierKeys: [],
        scopePacketNumbers: [],
      };
    }
    case "tiers": {
      if (scope.tierKeys.length === 0) {
        throw validation("EMPTY_SCOPE_TIERS", "Select at least one tier for a tier-scoped code.");
      }
      return {
        scopeKind: "tiers",
        scopeProductPublicIds: [],
        scopeTierKeys: [...new Set(scope.tierKeys)],
        scopePacketNumbers: [],
      };
    }
    case "packets": {
      const nums = [...new Set(scope.packetNumbers)];
      if (nums.length === 0) {
        throw validation("EMPTY_SCOPE_PACKETS", "Select at least one packet number for a packet-scoped code.");
      }
      return {
        scopeKind: "packets",
        scopeProductPublicIds: [],
        scopeTierKeys: [],
        scopePacketNumbers: nums,
      };
    }
  }
}

function buildScopeView(row: PromoBatchRow): PromotionScope {
  switch (row.scopeKind) {
    case "products":
      return { kind: "products", productPublicIds: row.scopeProductPublicIds ?? [] };
    case "tiers":
      return {
        kind: "tiers",
        tierKeys: (row.scopeTierKeys ?? []) as ("Basic" | "Standard" | "Premium")[],
      };
    case "packets":
      return { kind: "packets", packetNumbers: row.scopePacketNumbers ?? [] };
    case "all":
    default:
      return { kind: "all" };
  }
}

export function computeDerivedStatus(row: PromoBatchRow, now: Date): PromoDerivedStatus {
  if (row.status === "revoked") return "revoked";
  if (row.status === "paused") return "paused";
  if (row.endsAt && now.getTime() >= row.endsAt.getTime()) return "expired";
  if (row.maxRedemptions !== null && row.redemptionCount >= row.maxRedemptions) return "exhausted";
  if (row.isBatch && row.batchSize > 0 && row.redemptionCount >= row.batchSize) return "exhausted";
  if (row.startsAt && now.getTime() < row.startsAt.getTime()) return "scheduled";
  return "active";
}

export interface CreatePromotionInput {
  name: string;
  label: string;
  type: PromoDiscountType;
  percentBps?: number | null;
  maxDiscountMinor?: number | null;
  amountMinor?: number | null;
  currency?: string | null;
  scope: PromotionScope;
  minSubtotalMinor?: number;
  startsAt?: string | null;
  endsAt?: string | null;
  maxRedemptions?: number | null;
  maxPerCustomer?: number;
  firstOrderOnly?: boolean;
  allowCustomerPublicIds?: string[];
  allowEmailDomains?: string[];
  combineWithBundle?: boolean;
  note?: string | null;
  isBatch?: boolean;
  code?: string;
  codePrefix?: string | null;
  initialBatchCount?: number;
  idempotencyKey?: string;
}

export interface UpdatePromotionInput {
  publicId: string;
  expectedVersion: number;
  name?: string;
  label?: string;
  maxDiscountMinor?: number | null;
  scope?: PromotionScope;
  minSubtotalMinor?: number;
  startsAt?: string | null;
  endsAt?: string | null;
  maxRedemptions?: number | null;
  maxPerCustomer?: number;
  firstOrderOnly?: boolean;
  allowCustomerPublicIds?: string[];
  allowEmailDomains?: string[];
  combineWithBundle?: boolean;
  note?: string | null;
}

export interface ListPromotionsInput {
  status?: PromoDerivedStatus;
  type?: PromoDiscountType;
  endingWithinDays?: number;
  query?: string;
  cursor?: string;
  limit?: number;
}

export interface GenerateBatchInput {
  publicId: string;
  count: number;
  prefix?: string | null;
  idempotencyKey: string;
}

export interface CheckPromotionInput {
  code: string;
  customerPublicId?: string;
  currency: string;
  lines: {
    productPublicId: string;
    packetNumber: number | null;
    tierKey: string | null;
    lineTotalMinor: number;
  }[];
  subtotalMinor: number;
  bundleDiscountMinor: number;
  bundleLabel: string | null;
}

export interface PromotionsService {
  isEnabled(opts?: { tx?: DbOrTx }): Promise<boolean>;
  preview(ctx: PromotionContext, opts?: { tx?: DbOrTx; recheck?: boolean }): Promise<PromotionOutcome>;
  redeemInTx(
    tx: Tx,
    ctx: PromotionContext & { orderPublicId: string; correlationId: string },
  ): Promise<PromotionOutcome>;
  releaseForOrderInTx(
    tx: Tx,
    input: { orderPublicId: string; reason: "order_cancelled" },
  ): Promise<{ released: boolean }>;
  check(actor: SessionPrincipal, input: CheckPromotionInput): Promise<PromotionOutcome>;
  admin: {
    list(actor: SessionPrincipal, input: ListPromotionsInput): Promise<CursorPage<PromotionView>>;
    get(actor: SessionPrincipal, publicId: string): Promise<PromotionView>;
    create(
      actor: SessionPrincipal,
      input: CreatePromotionInput,
    ): Promise<{ promotion: PromotionView; initialCode: string | null; generatedCount: number }>;
    update(actor: SessionPrincipal, input: UpdatePromotionInput): Promise<PromotionView>;
    pause(actor: SessionPrincipal, input: { publicId: string; expectedVersion: number }): Promise<PromotionView>;
    resume(actor: SessionPrincipal, input: { publicId: string; expectedVersion: number }): Promise<PromotionView>;
    revoke(actor: SessionPrincipal, input: { publicId: string; expectedVersion: number }): Promise<PromotionView>;
    setStatus(
      actor: SessionPrincipal,
      input: { publicId: string; expectedVersion: number; status: PromoStatus },
    ): Promise<PromotionView>;
    generateBatch(
      actor: SessionPrincipal,
      input: GenerateBatchInput,
    ): Promise<{ promotion: PromotionView; generated: number }>;
    reveal(
      actor: SessionPrincipal,
      input: { publicId: string; codePublicId?: string },
    ): Promise<{ code: string }>;
    redemptions(
      actor: SessionPrincipal,
      input: { promotionPublicId?: string; status?: PromoRedemptionStatus; cursor?: string; limit?: number },
    ): Promise<CursorPage<PromotionRedemptionView>>;
    releaseRedemption(
      actor: SessionPrincipal,
      input: { redemptionPublicId: string; reason: string },
    ): Promise<PromotionRedemptionView>;
    stats(actor: SessionPrincipal, input: { promotionPublicId?: string }): Promise<PromotionStatsView>;
    exportCodes(actor: SessionPrincipal, input: { publicId: string }): Promise<PromotionCsvExportView>;
    exportRedemptions(
      actor: SessionPrincipal,
      input: { promotionPublicId?: string; status?: PromoRedemptionStatus },
    ): Promise<PromotionCsvExportView>;
    getSettings(actor: SessionPrincipal): Promise<PromotionsSettingsView>;
    updateSettings(
      actor: SessionPrincipal,
      input: { enabled?: boolean; maxDiscountPercent?: number },
    ): Promise<PromotionsSettingsView>;
  };
  healthCounts(): Promise<{ enabled: boolean; activePromotions: number }>;
}

export function createPromotionsService(deps: ModuleDeps): PromotionsService {
  function assertCapabilitySnapshot(actor: SessionPrincipal, capability: Capability): void {
    if (!roleHasCapability(actor.role, capability)) {
      throw forbidden("CAPABILITY_NOT_GRANTED");
    }
    if (STEP_UP_CAPABILITIES.has(capability)) {
      const stepUpAt = actor.stepUpAt?.getTime();
      if (stepUpAt === undefined || deps.clock.now().getTime() - stepUpAt > STEP_UP_MAX_AGE_MS) {
        throw new DomainError(
          "STEP_UP_REQUIRED",
          "STEP_UP_REQUIRED",
          "Please confirm your password and authentication code to continue.",
        );
      }
    }
  }

  /**
   * Re-validates the actor inside `tx` (persisted active user, role capability, non-revoked session, fresh step-up).
   */
  async function revalidateActorInTx(
    actor: SessionPrincipal,
    tx: Tx,
    capability: Capability,
  ): Promise<void> {
    const now = deps.clock.now();
    const identityHolder = (deps.services as Partial<Services>).identity as
      | { sessions?: { assertCurrent?: (p: SessionPrincipal, t: Tx) => Promise<{ pendingSteps: readonly unknown[]; role: SessionPrincipal["role"]; stepUpAt: Date | null }> } }
      | undefined;
    const assertCurrent = identityHolder?.sessions?.assertCurrent;

    if (typeof assertCurrent === "function") {
      const persisted = await assertCurrent.call(identityHolder!.sessions, actor, tx);
      if (persisted.pendingSteps.length > 0) {
        throw new DomainError(
          "REMEDIATION_REQUIRED",
          "ACCOUNT_STEP_PENDING",
          "Please finish securing your account to continue.",
        );
      }
      if (!roleHasCapability(persisted.role, capability)) {
        throw forbidden("ACTOR_NOT_AUTHORIZED");
      }
      if (STEP_UP_CAPABILITIES.has(capability)) {
        const at = persisted.stepUpAt?.getTime();
        if (at === undefined || now.getTime() - at > STEP_UP_MAX_AGE_MS) {
          throw new DomainError(
            "STEP_UP_REQUIRED",
            "STEP_UP_REQUIRED",
            "Please confirm your password and authentication code to continue.",
          );
        }
      }
      return;
    }

    const [userRow] = await tx
      .select({
        id: users.id,
        role: users.role,
        status: users.status,
      })
      .from(users)
      .where(eq(users.id, actor.userId))
      .for("update");

    if (!userRow || userRow.status !== "active") {
      throw forbidden("ACTOR_INACTIVE");
    }
    if (!roleHasCapability(userRow.role, capability)) {
      throw forbidden("ACTOR_NOT_AUTHORIZED");
    }

    const [sessionRow] = await tx
      .select({
        revokedAt: userSessions.revokedAt,
        absoluteExpiresAt: userSessions.absoluteExpiresAt,
        stepUpAt: userSessions.stepUpAt,
      })
      .from(userSessions)
      .where(eq(userSessions.publicId, actor.sessionId))
      .for("update");

    if (sessionRow) {
      if (sessionRow.revokedAt !== null || sessionRow.absoluteExpiresAt.getTime() <= now.getTime()) {
        throw new DomainError("UNAUTHENTICATED", "SESSION_REVOKED", "Your session is no longer active.");
      }
      if (STEP_UP_CAPABILITIES.has(capability)) {
        const at = sessionRow.stepUpAt?.getTime();
        if (at === undefined || now.getTime() - at > STEP_UP_MAX_AGE_MS) {
          throw new DomainError(
            "STEP_UP_REQUIRED",
            "STEP_UP_REQUIRED",
            "Please confirm your password and authentication code to continue.",
          );
        }
      }
    } else if (STEP_UP_CAPABILITIES.has(capability)) {
      const at = actor.stepUpAt?.getTime();
      if (at === undefined || now.getTime() - at > STEP_UP_MAX_AGE_MS) {
        throw new DomainError(
          "STEP_UP_REQUIRED",
          "STEP_UP_REQUIRED",
          "Please confirm your password and authentication code to continue.",
        );
      }
    }
  }

  function asAmbientTx(dbOrTx: DbOrTx | undefined): Tx | undefined {
    if (!dbOrTx || dbOrTx === deps.db) return undefined;
    return dbOrTx as Tx;
  }

  async function isEnabled(opts?: { tx?: DbOrTx }): Promise<boolean> {
    return deps.settings.isFeatureEnabled(PROMOTIONS_ENABLED_FLAG.flag, asAmbientTx(opts?.tx));
  }

  async function readPolicy(dbOrTx?: DbOrTx): Promise<PromotionsPolicyConfig> {
    return deps.settings.get(
      PROMOTIONS_POLICY_SETTING.key,
      (raw) => promotionsPolicySchema.parse(raw),
      DEFAULT_PROMOTIONS_POLICY,
      asAmbientTx(dbOrTx),
    );
  }

  async function buildPromotionView(row: PromoBatchRow, dbOrTx: DbOrTx): Promise<PromotionView> {
    const now = deps.clock.now();
    let codeMasked: string;
    if (row.isBatch) {
      codeMasked = maskBatchSummary(row.codePrefix, row.batchSize);
    } else {
      const [singleCode] = await dbOrTx
        .select({ publicId: promoCodes.publicId, codeEnc: promoCodes.codeEnc })
        .from(promoCodes)
        .where(eq(promoCodes.batchId, row.id))
        .limit(1);
      if (singleCode) {
        const plain = decryptPromoCode(deps.crypto, singleCode.publicId, singleCode.codeEnc);
        codeMasked = maskPromoCode(plain);
      } else {
        codeMasked = "••••••";
      }
    }

    return {
      publicId: row.publicId,
      name: row.name,
      label: row.label,
      type: row.discountType,
      percentBps: row.percentBps ?? null,
      maxDiscountMinor: row.maxDiscountMinor ?? null,
      amountMinor: row.fixedAmountMinor ?? null,
      currency: row.currency ?? null,
      scope: buildScopeView(row),
      minSubtotalMinor: row.minSubtotalMinor,
      startsAt: row.startsAt ? row.startsAt.toISOString() : null,
      endsAt: row.endsAt ? row.endsAt.toISOString() : null,
      maxRedemptions: row.maxRedemptions ?? null,
      maxPerCustomer: row.maxPerCustomer,
      firstOrderOnly: row.firstOrderOnly,
      allowCustomerPublicIds: row.allowCustomerPublicIds ?? [],
      allowEmailDomains: row.allowEmailDomains ?? [],
      combineWithBundle: row.combineWithBundle,
      status: row.status,
      derivedStatus: computeDerivedStatus(row, now),
      note: row.note ?? null,
      codeMasked,
      isBatch: row.isBatch,
      codePrefix: row.codePrefix ?? null,
      batchSize: row.batchSize,
      redemptionCount: row.redemptionCount,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function assertNotBlocked(userId: number, dbOrTx: DbOrTx): Promise<void> {
    const now = deps.clock.now();
    const [attempt] = await dbOrTx
      .select({ blockedUntil: promoCheckAttempts.blockedUntil })
      .from(promoCheckAttempts)
      .where(eq(promoCheckAttempts.userId, userId))
      .limit(1);

    if (attempt?.blockedUntil && attempt.blockedUntil.getTime() > now.getTime()) {
      const retryAfterSeconds = (attempt.blockedUntil.getTime() - now.getTime()) / 1000;
      throw promoAttemptsBlocked(retryAfterSeconds);
    }
  }

  async function consumeCheckRateLimits(actorUserId: number): Promise<void> {
    const acctRes = await deps.rateLimiter.consume("auth_high_risk", `promo:acct:${actorUserId}`);
    if (!acctRes.allowed) {
      throw promoAttemptsBlocked(acctRes.retryAfterSeconds);
    }
    const ip = getRequestContext()?.ipAddress;
    if (ip) {
      const ipIndex = deps.crypto.blindIndex(ip, "promo_check.ip");
      const ipRes = await deps.rateLimiter.consume("auth_high_risk", `promo:ip:${ipIndex}`);
      if (!ipRes.allowed) {
        throw promoAttemptsBlocked(ipRes.retryAfterSeconds);
      }
    }
  }

  /**
   * Records a failed interactive code check on `deps.db` so the failure counter persists even though
   * the check throws `PROMO_NOT_APPLICABLE`. On the 5th failure within 15 minutes, pauses checks for
   * 15 minutes and emits `promotion.attempts_blocked` (`WARN`, forwarded to SIEM).
   */
  async function recordFailedInteractiveAttempt(actorUserId: number): Promise<void> {
    const now = deps.clock.now();
    let blockedUntilReached: Date | null = null;

    await deps.db.transaction(async (tx) => {
      const [userRow] = await tx
        .select({ id: users.id, publicId: users.publicId, role: users.role })
        .from(users)
        .where(eq(users.id, actorUserId))
        .limit(1);
      if (!userRow) return;

      const [existing] = await tx
        .select()
        .from(promoCheckAttempts)
        .where(eq(promoCheckAttempts.userId, actorUserId))
        .for("update");

      if (!existing) {
        await tx.insert(promoCheckAttempts).values({
          userId: actorUserId,
          failedCount: 1,
          windowStartedAt: now,
          blockedUntil: null,
        });
        return;
      }

      if (existing.blockedUntil && existing.blockedUntil.getTime() > now.getTime()) {
        blockedUntilReached = existing.blockedUntil;
        return;
      }

      const windowExpired =
        now.getTime() - existing.windowStartedAt.getTime() >= ATTEMPT_WINDOW_MS;
      const nextCount = windowExpired ? 1 : existing.failedCount + 1;
      const nextWindowStart = windowExpired ? now : existing.windowStartedAt;
      const shouldBlock = nextCount >= MAX_FAILED_ATTEMPTS;
      const nextBlockedUntil = shouldBlock ? new Date(now.getTime() + ATTEMPT_PAUSE_MS) : null;

      await tx
        .update(promoCheckAttempts)
        .set({
          failedCount: shouldBlock ? 0 : nextCount,
          windowStartedAt: nextWindowStart,
          blockedUntil: nextBlockedUntil,
          version: existing.version + 1,
          updatedAt: now,
        })
        .where(eq(promoCheckAttempts.id, existing.id));

      if (shouldBlock && nextBlockedUntil) {
        blockedUntilReached = nextBlockedUntil;
        await deps.audit.record(
          {
            category: "security",
            eventName: "promotion.attempts_blocked",
            action: "block",
            outcome: "refused",
            severity: "WARN",
            reasonCode: "PROMO_ATTEMPTS_BLOCKED",
            actor: { userId: userRow.id, role: userRow.role },
            resource: { type: "user", publicId: userRow.publicId },
            attributes: {
              failedCount: nextCount,
              windowMinutes: 15,
              pauseMinutes: 15,
            },
          },
          tx,
        );
      }
    });

    if (blockedUntilReached) {
      const retryAfterSeconds =
        ((blockedUntilReached as Date).getTime() - now.getTime()) / 1000;
      throw promoAttemptsBlocked(retryAfterSeconds);
    }
  }

  async function clearFailedAttemptsIfAny(actorUserId: number): Promise<void> {
    await deps.db
      .update(promoCheckAttempts)
      .set({ failedCount: 0, blockedUntil: null, updatedAt: deps.clock.now() })
      .where(
        and(
          eq(promoCheckAttempts.userId, actorUserId),
          gtOrZeroFailed(),
        ),
      );
  }

  function gtOrZeroFailed() {
    return sql`${promoCheckAttempts.failedCount} > 0`;
  }

  function computePricingOutcome(
    batch: PromoBatchRow,
    ctx: PromotionContext,
    eligibleSubtotalMinor: number,
    maxDiscountPercent: number,
  ): PromotionOutcome {
    const subtotalMinor = ctx.subtotalMinor;
    const guardCapMinor = Math.min(
      subtotalMinor,
      Math.floor((subtotalMinor * maxDiscountPercent + 50) / 100),
    );
    const rawBundleMinor = Math.max(0, Math.min(ctx.bundleDiscountMinor, subtotalMinor));

    const calcRawPromo = (baseMinor: number): number => {
      if (baseMinor <= 0) return 0;
      if (batch.discountType === "percent") {
        const bps = batch.percentBps ?? 0;
        let raw = Math.floor((baseMinor * bps + 5_000) / 10_000);
        if (batch.maxDiscountMinor !== null && batch.maxDiscountMinor !== undefined) {
          raw = Math.min(raw, batch.maxDiscountMinor);
        }
        return Math.min(raw, baseMinor);
      }
      return Math.min(batch.fixedAmountMinor ?? 0, baseMinor);
    };

    if (batch.combineWithBundle) {
      let eligibleAfterBundle = eligibleSubtotalMinor;
      if (rawBundleMinor > 0 && subtotalMinor > 0) {
        if (batch.scopeKind === "all" || eligibleSubtotalMinor >= subtotalMinor) {
          eligibleAfterBundle = Math.max(0, subtotalMinor - rawBundleMinor);
        } else {
          const proratedBundle = Math.floor(
            (rawBundleMinor * eligibleSubtotalMinor + Math.floor(subtotalMinor / 2)) / subtotalMinor,
          );
          eligibleAfterBundle = Math.max(
            0,
            Math.min(eligibleSubtotalMinor - proratedBundle, subtotalMinor - rawBundleMinor),
          );
        }
      }
      const rawPromoMinor = calcRawPromo(eligibleAfterBundle);
      const discountMinor = Math.min(
        subtotalMinor,
        guardCapMinor,
        rawBundleMinor + rawPromoMinor,
      );
      const bundleDiscountMinor = Math.min(rawBundleMinor, discountMinor);
      const promoDiscountMinor = discountMinor - bundleDiscountMinor;
      const discountLabel =
        bundleDiscountMinor > 0 && promoDiscountMinor > 0
          ? `${ctx.bundleLabel ?? "Bundle discount"} + ${batch.label}`.slice(0, 120)
          : bundleDiscountMinor > 0
            ? (ctx.bundleLabel ?? batch.label).slice(0, 120)
            : batch.label.slice(0, 120);

      return {
        promoPublicId: batch.publicId,
        label: batch.label,
        promoDiscountMinor,
        bundleDiscountMinor,
        discountMinor,
        discountLabel,
        totalMinor: subtotalMinor - discountMinor,
      };
    }

    // `combineWithBundle === false`: the larger of bundle and code wins; the other is not applied.
    const rawPromoMinor = calcRawPromo(eligibleSubtotalMinor);
    if (rawPromoMinor >= rawBundleMinor) {
      const promoDiscountMinor = Math.min(rawPromoMinor, guardCapMinor, subtotalMinor);
      return {
        promoPublicId: batch.publicId,
        label: batch.label,
        promoDiscountMinor,
        bundleDiscountMinor: 0,
        discountMinor: promoDiscountMinor,
        discountLabel: batch.label.slice(0, 120),
        totalMinor: subtotalMinor - promoDiscountMinor,
      };
    }

    const bundleDiscountMinor = Math.min(rawBundleMinor, guardCapMinor, subtotalMinor);
    return {
      promoPublicId: batch.publicId,
      label: batch.label,
      promoDiscountMinor: 0,
      bundleDiscountMinor,
      discountMinor: bundleDiscountMinor,
      discountLabel: (ctx.bundleLabel ?? batch.label).slice(0, 120),
      totalMinor: subtotalMinor - bundleDiscountMinor,
    };
  }

  /**
   * Evaluates customer entitlement, code validity, caps, scope, minimum subtotal, and pricing.
   * When `lockForRedemption = true`, `dbOrTx` MUST be a `Tx` and locks `promo_batches` then `promo_codes` (`FOR UPDATE`).
   */
  async function evaluateCode(
    dbOrTx: DbOrTx,
    ctx: PromotionContext,
    opts: { lockForRedemption: boolean },
  ): Promise<{
    batch: PromoBatchRow;
    codeRow: PromoCodeRow;
    outcome: PromotionOutcome;
    activeCodeCustCount: number;
    activeBatchCustCount: number;
    historicalCustCount: number;
  }> {
    const now = deps.clock.now();
    const orderCurrency = ctx.currency.trim().toUpperCase();

    if (
      !Number.isSafeInteger(ctx.subtotalMinor) ||
      ctx.subtotalMinor < 0 ||
      !Number.isSafeInteger(ctx.bundleDiscountMinor) ||
      ctx.bundleDiscountMinor < 0
    ) {
      throw promoNotApplicable();
    }

    // 1. Customer account verification (verified email, active customer role — staff/admins cannot redeem for themselves).
    const [customer] = await dbOrTx
      .select({
        id: users.id,
        publicId: users.publicId,
        role: users.role,
        status: users.status,
        emailEnc: users.emailEnc,
        emailVerifiedAt: users.emailVerifiedAt,
      })
      .from(users)
      .where(eq(users.id, ctx.customerUserId))
      .limit(1);

    if (!customer || customer.status !== "active") throw promoNotApplicable();
    if (customer.role !== "customer") throw promoNotApplicable();
    if (!customer.emailVerifiedAt) throw promoNotApplicable();

    // 2. Normalise & candidate lookup by keyed blind index.
    const normalized = normalizePromoCode(ctx.code);
    if (!isPlausiblePromoCode(normalized)) throw promoNotApplicable();

    const candidates = computePromoCodeCandidates(deps.crypto, normalized);
    const [candidateCode] = await dbOrTx
      .select({ id: promoCodes.id, batchId: promoCodes.batchId })
      .from(promoCodes)
      .where(inArray(promoCodes.codeIndex, candidates))
      .limit(1);

    if (!candidateCode) throw promoNotApplicable();

    // 3. Deterministic lock order when redeeming: `promo_batches` FIRST, then `promo_codes`.
    let batch: PromoBatchRow | undefined;
    let codeRow: PromoCodeRow | undefined;
    if (opts.lockForRedemption) {
      const tx = dbOrTx as Tx;
      [batch] = await tx
        .select()
        .from(promoBatches)
        .where(eq(promoBatches.id, candidateCode.batchId))
        .for("update");
      [codeRow] = await tx
        .select()
        .from(promoCodes)
        .where(eq(promoCodes.id, candidateCode.id))
        .for("update");
    } else {
      [batch] = await dbOrTx
        .select()
        .from(promoBatches)
        .where(eq(promoBatches.id, candidateCode.batchId))
        .limit(1);
      [codeRow] = await dbOrTx
        .select()
        .from(promoCodes)
        .where(eq(promoCodes.id, candidateCode.id))
        .limit(1);
    }

    if (!batch || !codeRow) throw promoNotApplicable();

    // Verify exact decrypted match against blind-index collision.
    const decrypted = decryptPromoCode(deps.crypto, codeRow.publicId, codeRow.codeEnc);
    if (decrypted !== normalized) throw promoNotApplicable();

    // 4. Status, schedule window, global & per-code caps, currency.
    if (batch.status !== "active" || codeRow.status !== "active") throw promoNotApplicable();
    if (batch.startsAt && now.getTime() < batch.startsAt.getTime()) throw promoNotApplicable();
    if (batch.endsAt && now.getTime() >= batch.endsAt.getTime()) throw promoNotApplicable();
    if (codeRow.maxUses !== null && codeRow.redemptionCount >= codeRow.maxUses) {
      throw promoNotApplicable();
    }
    if (batch.maxRedemptions !== null && batch.redemptionCount >= batch.maxRedemptions) {
      throw promoNotApplicable();
    }

    if (batch.discountType === "fixed" && batch.currency !== orderCurrency) {
      throw promoNotApplicable();
    }
    if (
      batch.currency &&
      (batch.maxDiscountMinor !== null || batch.minSubtotalMinor > 0) &&
      batch.currency !== orderCurrency
    ) {
      throw promoNotApplicable();
    }

    // 5. Per-customer active counts (counted inside `dbOrTx` under lock when redeeming).
    const customerRedemptions = await dbOrTx
      .select({
        promoCodeId: promoRedemptions.promoCodeId,
        status: promoRedemptions.status,
      })
      .from(promoRedemptions)
      .where(
        and(
          eq(promoRedemptions.batchId, batch.id),
          eq(promoRedemptions.customerUserId, ctx.customerUserId),
        ),
      );

    const historicalCustCount = customerRedemptions.length;
    const activeBatchCustCount = customerRedemptions.filter((r) => r.status === "redeemed").length;
    const activeCodeCustCount = customerRedemptions.filter(
      (r) => r.status === "redeemed" && r.promoCodeId === codeRow.id,
    ).length;

    if (
      activeBatchCustCount >= batch.maxPerCustomer ||
      activeCodeCustCount >= batch.maxPerCustomer
    ) {
      throw promoNotApplicable();
    }

    // 6. Customer / e-mail domain allow-list.
    const allowedIds = batch.allowCustomerPublicIds ?? [];
    const allowedDomains = batch.allowEmailDomains ?? [];
    if (allowedIds.length > 0 || allowedDomains.length > 0) {
      const idMatch = allowedIds.includes(customer.publicId);
      let domainMatch = false;
      if (!idMatch && allowedDomains.length > 0) {
        const plainEmail = deps.crypto
          .decrypt(customer.emailEnc, `users.email:${customer.publicId}`)
          .trim()
          .toLowerCase();
        const atIdx = plainEmail.lastIndexOf("@");
        const emailDomain = atIdx >= 0 ? plainEmail.slice(atIdx + 1) : "";
        domainMatch = allowedDomains.includes(emailDomain);
      }
      if (!idMatch && !domainMatch) throw promoNotApplicable();
    }

    // 7. First order only (`redeemInTx` runs before the new order row is inserted).
    if (batch.firstOrderOnly) {
      const [priorOrder] = await dbOrTx
        .select({ id: orders.id })
        .from(orders)
        .where(
          and(
            eq(orders.ownerUserId, ctx.customerUserId),
            notInArray(orders.statusKey, ["canceled", "cancelled"]),
          ),
        )
        .limit(1);
      if (priorOrder) throw promoNotApplicable();

      // Also refuse if a prior canceled order still holds an un-released promo redemption (e.g. canceled after payment).
      const [priorUsedRedemption] = await dbOrTx
        .select({ id: promoRedemptions.id })
        .from(promoRedemptions)
        .where(
          and(
            eq(promoRedemptions.customerUserId, ctx.customerUserId),
            eq(promoRedemptions.status, "redeemed"),
          ),
        )
        .limit(1);
      if (priorUsedRedemption) throw promoNotApplicable();
    }

    // --- Entitlement succeeded! Only now may cart-specific hints (`PROMO_NOT_ELIGIBLE_ITEMS`, `PROMO_MIN_SUBTOTAL`) be shown. ---

    // 8. Scope / eligible lines filter.
    const eligibleLines = ctx.lines.filter((line) => {
      if (!Number.isSafeInteger(line.lineTotalMinor) || line.lineTotalMinor <= 0) return false;
      switch (batch.scopeKind) {
        case "all":
          return true;
        case "products":
          return (batch.scopeProductPublicIds ?? []).includes(line.productPublicId);
        case "tiers":
          return (
            line.tierKey !== null &&
            (batch.scopeTierKeys ?? []).some(
              (allowed) => allowed.toLowerCase() === line.tierKey!.toLowerCase(),
            )
          );
        case "packets":
          return (
            line.packetNumber !== null &&
            (batch.scopePacketNumbers ?? []).includes(line.packetNumber)
          );
        default:
          return false;
      }
    });

    const eligibleSubtotalMinor = eligibleLines.reduce((acc, l) => acc + l.lineTotalMinor, 0);
    if (eligibleSubtotalMinor <= 0) {
      throw validation(
        "PROMO_NOT_ELIGIBLE_ITEMS",
        "None of the items in your order are eligible for this code.",
      );
    }

    // 9. Minimum subtotal check.
    if (ctx.subtotalMinor < batch.minSubtotalMinor) {
      const shortfallMinor = batch.minSubtotalMinor - ctx.subtotalMinor;
      throw validation(
        "PROMO_MIN_SUBTOTAL",
        `Add ${formatMoneyMinor(shortfallMinor, orderCurrency)} more to use this code.`,
        {
          minSubtotalMinor: batch.minSubtotalMinor,
          shortfallMinor,
          currency: orderCurrency,
        },
      );
    }

    // 10. Global discount guard & pricing outcome.
    const policy = await readPolicy(dbOrTx);
    const outcome = computePricingOutcome(
      batch,
      ctx,
      eligibleSubtotalMinor,
      policy.maxDiscountPercent,
    );

    return {
      batch,
      codeRow,
      outcome,
      activeCodeCustCount,
      activeBatchCustCount,
      historicalCustCount,
    };
  }

  async function preview(
    ctx: PromotionContext,
    opts?: { tx?: DbOrTx; recheck?: boolean },
  ): Promise<PromotionOutcome> {
    const dbOrTx = opts?.tx ?? deps.db;
    const enabled = await isEnabled({ tx: dbOrTx });
    if (!enabled) throw promoNotApplicable();

    const interactive = !opts?.recheck;
    const hasAmbientTx = Boolean(opts?.tx);

    if (interactive) {
      if (!hasAmbientTx) {
        await consumeCheckRateLimits(ctx.actorUserId);
      }
      await assertNotBlocked(ctx.actorUserId, dbOrTx);
    }

    try {
      const evaluated = await evaluateCode(dbOrTx, ctx, { lockForRedemption: false });
      if (interactive && !hasAmbientTx) {
        await clearFailedAttemptsIfAny(ctx.actorUserId);
      }
      return evaluated.outcome;
    } catch (err) {
      if (
        interactive &&
        !hasAmbientTx &&
        err instanceof DomainError &&
        err.reasonCode === "PROMO_NOT_APPLICABLE"
      ) {
        await recordFailedInteractiveAttempt(ctx.actorUserId);
      }
      throw err;
    }
  }

  async function redeemInTx(
    tx: Tx,
    ctx: PromotionContext & { orderPublicId: string; correlationId: string },
  ): Promise<PromotionOutcome> {
    const enabled = await isEnabled({ tx });
    if (!enabled) throw promoNotApplicable();

    await assertNotBlocked(ctx.actorUserId, tx);

    // Idempotent replay check if the exact orderPublicId already redeemed in a retried call.
    const [existingForOrder] = await tx
      .select()
      .from(promoRedemptions)
      .where(
        and(
          eq(promoRedemptions.orderPublicId, ctx.orderPublicId),
          eq(promoRedemptions.status, "redeemed"),
        ),
      )
      .limit(1);

    if (existingForOrder) {
      const [existingBatch] = await tx
        .select({ publicId: promoBatches.publicId })
        .from(promoBatches)
        .where(eq(promoBatches.id, existingForOrder.batchId))
        .limit(1);
      if (existingBatch && existingForOrder.customerUserId === ctx.customerUserId) {
        return {
          promoPublicId: existingBatch.publicId,
          label: existingForOrder.labelSnapshot,
          promoDiscountMinor: existingForOrder.promoDiscountMinor,
          bundleDiscountMinor: existingForOrder.bundleDiscountMinor,
          discountMinor: existingForOrder.discountMinor,
          discountLabel: existingForOrder.labelSnapshot,
          totalMinor: existingForOrder.totalMinor,
        };
      }
      throw promoNotApplicable();
    }

    const {
      batch,
      codeRow,
      outcome,
      activeCodeCustCount,
      activeBatchCustCount,
      historicalCustCount,
    } = await evaluateCode(tx, ctx, { lockForRedemption: true });

    const now = deps.clock.now();
    const redemptionPublicId = newPublicId();
    const nextCodeGlobalCount = codeRow.redemptionCount + 1;
    const nextBatchGlobalCount = batch.redemptionCount + 1;

    if (codeRow.maxUses !== null && nextCodeGlobalCount > codeRow.maxUses) {
      throw promoNotApplicable();
    }
    if (batch.maxRedemptions !== null && nextBatchGlobalCount > batch.maxRedemptions) {
      throw promoNotApplicable();
    }

    try {
      await tx.insert(promoRedemptions).values({
        publicId: redemptionPublicId,
        batchId: batch.id,
        promoCodeId: codeRow.id,
        customerUserId: ctx.customerUserId,
        actorUserId: ctx.actorUserId,
        orderPublicId: ctx.orderPublicId,
        status: "redeemed",
        customerSequence: historicalCustCount + 1,
        activeCodeSequence: activeCodeCustCount + 1,
        activeBatchSequence: activeBatchCustCount + 1,
        activeCodeSlot: nextCodeGlobalCount,
        currency: ctx.currency.trim().toUpperCase(),
        subtotalMinor: ctx.subtotalMinor,
        promoDiscountMinor: outcome.promoDiscountMinor,
        bundleDiscountMinor: outcome.bundleDiscountMinor,
        discountMinor: outcome.discountMinor,
        totalMinor: outcome.totalMinor,
        labelSnapshot: outcome.discountLabel.slice(0, 120),
        correlationId: ctx.correlationId.slice(0, 64),
      });
    } catch (err) {
      if (isMysqlDuplicateError(err)) {
        throw promoNotApplicable();
      }
      throw err;
    }

    await tx
      .update(promoCodes)
      .set({
        redemptionCount: nextCodeGlobalCount,
        version: codeRow.version + 1,
        updatedAt: now,
      })
      .where(eq(promoCodes.id, codeRow.id));

    await tx
      .update(promoBatches)
      .set({
        redemptionCount: nextBatchGlobalCount,
        version: batch.version + 1,
        updatedAt: now,
      })
      .where(eq(promoBatches.id, batch.id));

    const [actorRow] = await tx
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(eq(users.id, ctx.actorUserId))
      .limit(1);

    await deps.audit.record(
      {
        category: "business",
        eventName: "promotion.redeemed",
        action: "redeem",
        outcome: "completed",
        severity: "INFO",
        actor: actorRow ? { userId: actorRow.id, role: actorRow.role } : undefined,
        resource: { type: "promotion", publicId: batch.publicId },
        orderPublicId: ctx.orderPublicId,
        attributes: {
          promoPublicId: batch.publicId,
          redemptionPublicId,
          label: batch.label,
          orderPublicId: ctx.orderPublicId,
          promoDiscountMinor: outcome.promoDiscountMinor,
          discountMinor: outcome.discountMinor,
          currency: ctx.currency.trim().toUpperCase(),
        },
      },
      tx,
    );

    return outcome;
  }

  async function releaseRedemptionRowsInTx(
    tx: Tx,
    target: { id: number; batchId: number; promoCodeId: number },
    meta: {
      reason: string;
      note: string | null;
      releasedByUserId: number | null;
      manual: boolean;
      actor?: { userId: number; role: SessionPrincipal["role"] };
    },
  ): Promise<{ released: boolean; redemption: PromoRedemptionRow; batch: PromoBatchRow; codeRow: PromoCodeRow } | null> {
    const [batch] = await tx
      .select()
      .from(promoBatches)
      .where(eq(promoBatches.id, target.batchId))
      .for("update");
    const [codeRow] = await tx
      .select()
      .from(promoCodes)
      .where(eq(promoCodes.id, target.promoCodeId))
      .for("update");
    const [redemption] = await tx
      .select()
      .from(promoRedemptions)
      .where(eq(promoRedemptions.id, target.id))
      .for("update");

    if (!batch || !codeRow || !redemption) return null;
    if (redemption.status !== "redeemed") {
      return { released: false, redemption, batch, codeRow };
    }

    const now = deps.clock.now();
    await tx
      .update(promoRedemptions)
      .set({
        status: "released",
        activeCodeSequence: null,
        activeBatchSequence: null,
        activeCodeSlot: null,
        releasedAt: now,
        releaseReason: meta.reason.slice(0, 48),
        releaseNote: meta.note ? meta.note.slice(0, 240) : null,
        releasedByUserId: meta.releasedByUserId,
        version: redemption.version + 1,
        updatedAt: now,
      })
      .where(eq(promoRedemptions.id, redemption.id));

    await tx
      .update(promoCodes)
      .set({
        redemptionCount: Math.max(0, codeRow.redemptionCount - 1),
        version: codeRow.version + 1,
        updatedAt: now,
      })
      .where(eq(promoCodes.id, codeRow.id));

    await tx
      .update(promoBatches)
      .set({
        redemptionCount: Math.max(0, batch.redemptionCount - 1),
        version: batch.version + 1,
        updatedAt: now,
      })
      .where(eq(promoBatches.id, batch.id));

    await deps.audit.record(
      {
        category: "business",
        eventName: "promotion.released",
        action: "release",
        outcome: "completed",
        severity: "INFO",
        actor: meta.actor,
        resource: { type: "promotion", publicId: batch.publicId },
        orderPublicId: redemption.orderPublicId,
        attributes: {
          promoPublicId: batch.publicId,
          redemptionPublicId: redemption.publicId,
          label: batch.label,
          orderPublicId: redemption.orderPublicId,
          releaseReason: meta.reason,
          manual: meta.manual,
        },
      },
      tx,
    );

    const [updatedRedemption] = await tx
      .select()
      .from(promoRedemptions)
      .where(eq(promoRedemptions.id, redemption.id))
      .limit(1);

    return {
      released: true,
      redemption: updatedRedemption ?? redemption,
      batch,
      codeRow,
    };
  }

  async function releaseForOrderInTx(
    tx: Tx,
    input: { orderPublicId: string; reason: "order_cancelled" },
  ): Promise<{ released: boolean }> {
    const [candidate] = await tx
      .select({
        id: promoRedemptions.id,
        batchId: promoRedemptions.batchId,
        promoCodeId: promoRedemptions.promoCodeId,
        status: promoRedemptions.status,
      })
      .from(promoRedemptions)
      .where(eq(promoRedemptions.orderPublicId, input.orderPublicId))
      .limit(1);

    if (!candidate || candidate.status !== "redeemed") {
      return { released: false };
    }

    const reqActor = getRequestContext()?.actor;
    const res = await releaseRedemptionRowsInTx(tx, candidate, {
      reason: input.reason,
      note: null,
      releasedByUserId: reqActor?.userId ?? null,
      manual: false,
      actor: reqActor
        ? { userId: reqActor.userId, role: reqActor.role }
        : undefined,
    });

    return { released: Boolean(res?.released) };
  }

  async function check(
    actor: SessionPrincipal,
    input: CheckPromotionInput,
  ): Promise<PromotionOutcome> {
    let customerUserId = actor.userId;
    if (input.customerPublicId && input.customerPublicId !== actor.userPublicId) {
      if (!roleHasCapability(actor.role, "orders.manage")) {
        throw forbidden("CAPABILITY_NOT_GRANTED");
      }
      const [owner] = await deps.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.publicId, input.customerPublicId))
        .limit(1);
      if (!owner) throw promoNotApplicable();
      customerUserId = owner.id;
    }

    return preview({
      code: input.code,
      customerUserId,
      actorUserId: actor.userId,
      currency: input.currency,
      lines: input.lines,
      subtotalMinor: input.subtotalMinor,
      bundleDiscountMinor: input.bundleDiscountMinor,
      bundleLabel: input.bundleLabel,
    });
  }

  async function insertBatchCodesInTx(
    tx: Tx,
    batchRow: PromoBatchRow,
    count: number,
    prefix: string | null,
    generationKey: string | null,
  ): Promise<string[]> {
    if (count < 1 || count > MAX_BATCH_SIZE_PER_CALL) {
      throw validation("INVALID_BATCH_COUNT", "Batch size must be between 1 and 5,000 codes.");
    }
    if (batchRow.batchSize + count > MAX_TOTAL_CODES_PER_PROMO) {
      throw validation(
        "BATCH_LIMIT_EXCEEDED",
        `A single promotion may hold at most ${MAX_TOTAL_CODES_PER_PROMO.toLocaleString()} generated codes.`,
      );
    }

    const generatedPlainCodes: string[] = [];
    const seenIndexes = new Set<string>();
    const toInsert: {
      publicId: string;
      batchId: number;
      codeIndex: string;
      codeEnc: string;
      maxUses: number;
      generationKey: string | null;
    }[] = [];

    let safetyAttempts = 0;
    while (toInsert.length < count) {
      safetyAttempts += 1;
      if (safetyAttempts > count * 5 + 100) {
        throw conflict("CODE_GENERATION_COLLISION", "Could not generate unique batch codes; please retry.");
      }
      const candidate = generatePromoCode(prefix);
      const codeIdx = computePromoCodeIndex(deps.crypto, candidate);
      if (seenIndexes.has(codeIdx)) continue;
      seenIndexes.add(codeIdx);

      const codePublicId = newPublicId();
      const codeEnc = encryptPromoCode(deps.crypto, codePublicId, candidate);
      generatedPlainCodes.push(candidate);
      toInsert.push({
        publicId: codePublicId,
        batchId: batchRow.id,
        codeIndex: codeIdx,
        codeEnc,
        maxUses: 1,
        generationKey,
      });
    }

    for (let offset = 0; offset < toInsert.length; offset += BATCH_INSERT_CHUNK) {
      const slice = toInsert.slice(offset, offset + BATCH_INSERT_CHUNK);
      await tx.insert(promoCodes).values(slice);
    }

    return generatedPlainCodes;
  }

  async function hydrateRedemptionViews(
    rows: PromoRedemptionRow[],
    dbOrTx: DbOrTx,
  ): Promise<PromotionRedemptionView[]> {
    if (rows.length === 0) return [];

    const batchIds = [...new Set(rows.map((r) => r.batchId))];
    const codeIds = [...new Set(rows.map((r) => r.promoCodeId))];
    const customerIds = [...new Set(rows.map((r) => r.customerUserId))];
    const orderPublicIds = [...new Set(rows.map((r) => r.orderPublicId))];

    const [batchRows, codeRows, customerRows, orderRows] = await Promise.all([
      dbOrTx.select().from(promoBatches).where(inArray(promoBatches.id, batchIds)),
      dbOrTx
        .select({
          id: promoCodes.id,
          publicId: promoCodes.publicId,
          codeEnc: promoCodes.codeEnc,
        })
        .from(promoCodes)
        .where(inArray(promoCodes.id, codeIds)),
      dbOrTx
        .select({
          id: users.id,
          publicId: users.publicId,
          customerRef: users.customerRef,
        })
        .from(users)
        .where(inArray(users.id, customerIds)),
      dbOrTx
        .select({
          publicId: orders.publicId,
          reference: orders.reference,
        })
        .from(orders)
        .where(inArray(orders.publicId, orderPublicIds)),
    ]);

    const batchMap = new Map(batchRows.map((b) => [b.id, b]));
    const codeMaskMap = new Map(
      codeRows.map((c) => [
        c.id,
        maskPromoCode(decryptPromoCode(deps.crypto, c.publicId, c.codeEnc)),
      ]),
    );
    const customerMap = new Map(customerRows.map((u) => [u.id, u]));
    const orderRefMap = new Map(orderRows.map((o) => [o.publicId, o.reference]));

    return rows.map((r) => {
      const batch = batchMap.get(r.batchId);
      const cust = customerMap.get(r.customerUserId);
      const promoPublicId = batch?.publicId ?? "";
      const label = batch?.label ?? r.labelSnapshot;
      const isoCreated = r.createdAt.toISOString();
      return {
        publicId: r.publicId,
        promoPublicId,
        promotionPublicId: promoPublicId,
        promotionName: batch?.name ?? r.labelSnapshot,
        label,
        promotionLabel: label,
        codeMasked: codeMaskMap.get(r.promoCodeId) ?? "••••••",
        orderPublicId: r.orderPublicId,
        orderNumber: orderRefMap.get(r.orderPublicId) ?? null,
        customerPublicId: cust?.publicId ?? "",
        customerRef: cust?.customerRef ?? null,
        status: r.status,
        currency: r.currency,
        subtotalMinor: r.subtotalMinor,
        promoDiscountMinor: r.promoDiscountMinor,
        bundleDiscountMinor: r.bundleDiscountMinor,
        discountMinor: r.discountMinor,
        totalMinor: r.totalMinor,
        redeemedAt: isoCreated,
        createdAt: isoCreated,
        releasedAt: r.releasedAt ? r.releasedAt.toISOString() : null,
        releaseReason: r.releaseReason ?? null,
        releaseNote: r.releaseNote ?? null,
      };
    });
  }

  return {
    isEnabled,
    preview,
    redeemInTx,
    releaseForOrderInTx,
    check,

    admin: {
      async list(actor, input) {
        assertCapabilitySnapshot(actor, "promotions.read");
        const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
        const now = deps.clock.now();
        const cursorId = input.cursor ? Number.parseInt(input.cursor, 10) : null;

        const conditions = [];
        if (cursorId !== null && Number.isFinite(cursorId) && cursorId > 0) {
          conditions.push(lt(promoBatches.id, cursorId));
        }
        if (input.type) {
          conditions.push(eq(promoBatches.discountType, input.type));
        }
        if (input.status === "paused" || input.status === "revoked") {
          conditions.push(eq(promoBatches.status, input.status));
        } else if (input.status === "active" || input.status === "scheduled" || input.status === "expired" || input.status === "exhausted") {
          conditions.push(eq(promoBatches.status, "active"));
        }
        if (input.endingWithinDays !== undefined) {
          const horizon = new Date(now.getTime() + input.endingWithinDays * 24 * 60 * 60 * 1000);
          conditions.push(and(gte(promoBatches.endsAt, now), lte(promoBatches.endsAt, horizon))!);
        }

        const qNorm = input.query?.trim().toLowerCase() ?? "";

        // Scan in bounded chunks so derivedStatus / text filters paginate accurately.
        const matched: PromoBatchRow[] = [];
        let scanCursor = cursorId;
        let safetyRounds = 0;

        while (matched.length <= limit && safetyRounds < 10) {
          safetyRounds += 1;
          const roundConds = [...conditions];
          if (scanCursor !== null && Number.isFinite(scanCursor) && scanCursor > 0) {
            roundConds.push(lt(promoBatches.id, scanCursor));
          }
          const rows = await deps.db
            .select()
            .from(promoBatches)
            .where(roundConds.length > 0 ? and(...roundConds) : undefined)
            .orderBy(desc(promoBatches.id))
            .limit(100);

          if (rows.length === 0) break;
          scanCursor = rows[rows.length - 1]!.id;

          for (const row of rows) {
            if (input.status && computeDerivedStatus(row, now) !== input.status) continue;
            if (qNorm.length > 0) {
              const hay = `${row.name} ${row.label} ${row.publicId} ${row.codePrefix ?? ""}`.toLowerCase();
              if (!hay.includes(qNorm)) continue;
            }
            matched.push(row);
            if (matched.length > limit) break;
          }
          if (rows.length < 100) break;
        }

        const hasMore = matched.length > limit;
        const slice = hasMore ? matched.slice(0, limit) : matched;
        const items = await Promise.all(slice.map((row) => buildPromotionView(row, deps.db)));
        const nextCursor = hasMore && slice.length > 0 ? String(slice[slice.length - 1]!.id) : null;
        return { items, nextCursor };
      },

      async get(actor, publicId) {
        assertCapabilitySnapshot(actor, "promotions.read");
        const [row] = await deps.db
          .select()
          .from(promoBatches)
          .where(eq(promoBatches.publicId, publicId))
          .limit(1);
        if (!row) throw notFound("PROMOTION_NOT_FOUND");
        return buildPromotionView(row, deps.db);
      },

      async create(actor, input) {
        assertCapabilitySnapshot(actor, "promotions.manage");

        const name = input.name.trim();
        const label = input.label.trim();
        if (!name || name.length > 120) {
          throw validation("INVALID_PROMO_NAME", "Enter an internal promotion name up to 120 characters.");
        }
        if (!label || label.length > 120) {
          throw validation("INVALID_PROMO_LABEL", "Enter a customer-facing label up to 120 characters.");
        }

        const startsAt = parseIsoOrNull(input.startsAt, "startsAt");
        const endsAt = parseIsoOrNull(input.endsAt, "endsAt");
        if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) {
          throw validation("INVALID_DATE_RANGE", "The end time must be after the start time.");
        }

        let percentBps: number | null = null;
        let maxDiscountMinor: number | null = null;
        let fixedAmountMinor: number | null = null;
        let currency = input.currency ? input.currency.trim().toUpperCase() : null;
        if (currency && !/^[A-Z]{3}$/.test(currency)) {
          throw validation("INVALID_CURRENCY", "Enter a 3-letter uppercase ISO currency code.");
        }

        const minSubtotalMinor = input.minSubtotalMinor ?? 0;
        if (!Number.isSafeInteger(minSubtotalMinor) || minSubtotalMinor < 0) {
          throw validation("INVALID_MIN_SUBTOTAL", "Minimum subtotal must be zero or a positive amount.");
        }

        if (input.type === "percent") {
          if (
            input.percentBps === null ||
            input.percentBps === undefined ||
            !Number.isInteger(input.percentBps) ||
            input.percentBps < 1 ||
            input.percentBps > 10_000
          ) {
            throw validation(
              "INVALID_PERCENT_BPS",
              "Percentage discount must be between 0.01% (1 bps) and 100% (10000 bps).",
            );
          }
          percentBps = input.percentBps;
          if (input.maxDiscountMinor !== null && input.maxDiscountMinor !== undefined) {
            if (!Number.isSafeInteger(input.maxDiscountMinor) || input.maxDiscountMinor < 1) {
              throw validation("INVALID_MAX_DISCOUNT", "Maximum discount cap must be at least 1 minor unit.");
            }
            maxDiscountMinor = input.maxDiscountMinor;
            if (!currency) {
              throw validation("CURRENCY_REQUIRED", "Specify a currency when setting a monetary cap.");
            }
          }
          if (minSubtotalMinor > 0 && !currency) {
            currency = "USD";
          }
        } else {
          if (
            input.amountMinor === null ||
            input.amountMinor === undefined ||
            !Number.isSafeInteger(input.amountMinor) ||
            input.amountMinor < 1
          ) {
            throw validation("INVALID_FIXED_AMOUNT", "Fixed discount amount must be at least 1 minor unit.");
          }
          if (!currency) {
            throw validation("CURRENCY_REQUIRED", "Fixed-amount codes require a 3-letter currency code.");
          }
          fixedAmountMinor = input.amountMinor;
        }

        const maxPerCustomer = input.maxPerCustomer ?? 1;
        if (!Number.isInteger(maxPerCustomer) || maxPerCustomer < 1 || maxPerCustomer > 1_000) {
          throw validation("INVALID_MAX_PER_CUSTOMER", "Per-customer limit must be at least 1.");
        }
        const maxRedemptions = input.maxRedemptions ?? null;
        if (maxRedemptions !== null && (!Number.isInteger(maxRedemptions) || maxRedemptions < 1)) {
          throw validation("INVALID_MAX_REDEMPTIONS", "Total redemption limit must be at least 1.");
        }

        const scopeCols = extractScopeColumns(input.scope);
        const allowCustomerPublicIds = normalizeCustomerPublicIds(input.allowCustomerPublicIds);
        const allowEmailDomains = normalizeEmailDomains(input.allowEmailDomains);
        const isBatch = Boolean(input.isBatch);
        const codePrefix = isBatch ? normalizePromoPrefix(input.codePrefix) : null;

        let chosenSingleCode: string | null = null;
        if (!isBatch) {
          chosenSingleCode = input.code
            ? validateAdminPromoCode(input.code)
            : generatePromoCode(null);
          assertLabelDistinctFromCode(label, chosenSingleCode);
        } else {
          assertLabelDistinctFromCode(label, codePrefix);
        }

        return deps.db.transaction(async (tx) => {
          await revalidateActorInTx(actor, tx, "promotions.manage");

          const promoPublicId = newPublicId();
          const initialBatchCount = isBatch ? (input.initialBatchCount ?? 0) : 0;
          if (isBatch && initialBatchCount > MAX_BATCH_SIZE_PER_CALL) {
            throw validation("INVALID_BATCH_COUNT", "Batch size must not exceed 5,000 codes.");
          }

          const [insertHeader] = await tx.insert(promoBatches).values({
            publicId: promoPublicId,
            name,
            label,
            discountType: input.type,
            percentBps,
            maxDiscountMinor,
            fixedAmountMinor,
            currency,
            ...scopeCols,
            minSubtotalMinor,
            startsAt,
            endsAt,
            maxRedemptions,
            maxPerCustomer,
            firstOrderOnly: Boolean(input.firstOrderOnly),
            allowCustomerPublicIds,
            allowEmailDomains,
            combineWithBundle: Boolean(input.combineWithBundle),
            status: "active",
            isBatch,
            codePrefix,
            batchSize: isBatch ? initialBatchCount : 1,
            redemptionCount: 0,
            note: input.note?.trim() ? input.note.trim().slice(0, 500) : null,
            createdByUserId: actor.userId,
          });

          const batchId = Number(insertHeader.insertId);
          const [batchRow] = await tx
            .select()
            .from(promoBatches)
            .where(eq(promoBatches.id, batchId))
            .limit(1);
          if (!batchRow) throw new Error("promo_batches insert missing");

          let generatedCount = 0;
          if (!isBatch && chosenSingleCode) {
            const codePublicId = newPublicId();
            const codeIndex = computePromoCodeIndex(deps.crypto, chosenSingleCode);
            const codeEnc = encryptPromoCode(deps.crypto, codePublicId, chosenSingleCode);
            try {
              await tx.insert(promoCodes).values({
                publicId: codePublicId,
                batchId: batchRow.id,
                codeIndex,
                codeEnc,
                maxUses: null,
                status: "active",
                generationKey: input.idempotencyKey?.slice(0, 80) ?? null,
              });
            } catch (err) {
              if (isMysqlDuplicateError(err)) {
                throw conflict(
                  "PROMO_CODE_ALREADY_EXISTS",
                  "That promotion code already exists. Choose a different code.",
                );
              }
              throw err;
            }
            generatedCount = 1;
          } else if (isBatch && initialBatchCount > 0) {
            const zeroSizedRow = { ...batchRow, batchSize: 0 };
            await insertBatchCodesInTx(
              tx,
              zeroSizedRow,
              initialBatchCount,
              codePrefix,
              input.idempotencyKey?.slice(0, 80) ?? null,
            );
            generatedCount = initialBatchCount;
          }

          await deps.audit.record(
            {
              category: "admin",
              eventName: "promotion.created",
              action: "create",
              outcome: "completed",
              severity: "INFO",
              actor: { userId: actor.userId, role: actor.role },
              resource: { type: "promotion", id: promoPublicId },
              attributes: {
                promoPublicId,
                label: batchRow.label,
                discountType: batchRow.discountType,
                scopeKind: batchRow.scopeKind,
                isBatch: batchRow.isBatch,
                batchSize: batchRow.batchSize,
              },
            },
            tx,
          );

          const view = await buildPromotionView(batchRow, tx);
          return {
            promotion: view,
            initialCode: isBatch ? null : chosenSingleCode,
            generatedCount,
          };
        });
      },

      async update(actor, input) {
        assertCapabilitySnapshot(actor, "promotions.manage");

        return deps.db.transaction(async (tx) => {
          await revalidateActorInTx(actor, tx, "promotions.manage");

          const [existing] = await tx
            .select()
            .from(promoBatches)
            .where(eq(promoBatches.publicId, input.publicId))
            .for("update");
          if (!existing) throw notFound("PROMOTION_NOT_FOUND");
          if (existing.version !== input.expectedVersion) {
            throw conflict(
              "VERSION_CONFLICT",
              "This promotion was modified by another session. Reload and try again.",
            );
          }

          const nextName = input.name !== undefined ? input.name.trim() : existing.name;
          const nextLabel = input.label !== undefined ? input.label.trim() : existing.label;
          if (!nextName || nextName.length > 120) {
            throw validation("INVALID_PROMO_NAME", "Enter an internal promotion name up to 120 characters.");
          }
          if (!nextLabel || nextLabel.length > 120) {
            throw validation("INVALID_PROMO_LABEL", "Enter a customer-facing label up to 120 characters.");
          }

          if (!existing.isBatch) {
            const [singleCode] = await tx
              .select({ publicId: promoCodes.publicId, codeEnc: promoCodes.codeEnc })
              .from(promoCodes)
              .where(eq(promoCodes.batchId, existing.id))
              .limit(1);
            if (singleCode) {
              const plain = decryptPromoCode(deps.crypto, singleCode.publicId, singleCode.codeEnc);
              assertLabelDistinctFromCode(nextLabel, plain);
            }
          } else {
            assertLabelDistinctFromCode(nextLabel, existing.codePrefix);
          }

          const nextStartsAt =
            input.startsAt !== undefined ? parseIsoOrNull(input.startsAt, "startsAt") : existing.startsAt;
          const nextEndsAt =
            input.endsAt !== undefined ? parseIsoOrNull(input.endsAt, "endsAt") : existing.endsAt;
          if (nextStartsAt && nextEndsAt && nextEndsAt.getTime() <= nextStartsAt.getTime()) {
            throw validation("INVALID_DATE_RANGE", "The end time must be after the start time.");
          }

          const scopeCols = input.scope ? extractScopeColumns(input.scope) : null;
          const nextMaxDiscountMinor =
            input.maxDiscountMinor !== undefined ? input.maxDiscountMinor : existing.maxDiscountMinor;
          if (
            nextMaxDiscountMinor !== null &&
            existing.discountType === "percent" &&
            !existing.currency
          ) {
            throw validation(
              "CURRENCY_REQUIRED",
              "This percentage promotion has no currency set for a monetary cap.",
            );
          }

          const nextMinSubtotal =
            input.minSubtotalMinor !== undefined ? input.minSubtotalMinor : existing.minSubtotalMinor;
          const nextMaxRedemptions =
            input.maxRedemptions !== undefined ? input.maxRedemptions : existing.maxRedemptions;
          const nextMaxPerCustomer =
            input.maxPerCustomer !== undefined ? input.maxPerCustomer : existing.maxPerCustomer;
          const now = deps.clock.now();

          await tx
            .update(promoBatches)
            .set({
              name: nextName,
              label: nextLabel,
              maxDiscountMinor: existing.discountType === "percent" ? nextMaxDiscountMinor : null,
              ...(scopeCols ?? {}),
              minSubtotalMinor: nextMinSubtotal,
              startsAt: nextStartsAt,
              endsAt: nextEndsAt,
              maxRedemptions: nextMaxRedemptions,
              maxPerCustomer: nextMaxPerCustomer,
              firstOrderOnly:
                input.firstOrderOnly !== undefined ? input.firstOrderOnly : existing.firstOrderOnly,
              allowCustomerPublicIds:
                input.allowCustomerPublicIds !== undefined
                  ? normalizeCustomerPublicIds(input.allowCustomerPublicIds)
                  : existing.allowCustomerPublicIds,
              allowEmailDomains:
                input.allowEmailDomains !== undefined
                  ? normalizeEmailDomains(input.allowEmailDomains)
                  : existing.allowEmailDomains,
              combineWithBundle:
                input.combineWithBundle !== undefined
                  ? input.combineWithBundle
                  : existing.combineWithBundle,
              note:
                input.note !== undefined
                  ? input.note?.trim()
                    ? input.note.trim().slice(0, 500)
                    : null
                  : existing.note,
              version: existing.version + 1,
              updatedAt: now,
            })
            .where(eq(promoBatches.id, existing.id));

          const [updated] = await tx
            .select()
            .from(promoBatches)
            .where(eq(promoBatches.id, existing.id))
            .limit(1);

          await deps.audit.record(
            {
              category: "admin",
              eventName: "promotion.updated",
              action: "update",
              outcome: "completed",
              severity: "INFO",
              actor: { userId: actor.userId, role: actor.role },
              resource: { type: "promotion", id: existing.publicId },
              attributes: {
                promoPublicId: existing.publicId,
                label: nextLabel,
                version: existing.version + 1,
              },
            },
            tx,
          );

          return buildPromotionView(updated!, tx);
        });
      },

      async setStatus(actor, input) {
        assertCapabilitySnapshot(actor, "promotions.manage");

        return deps.db.transaction(async (tx) => {
          await revalidateActorInTx(actor, tx, "promotions.manage");

          const [existing] = await tx
            .select()
            .from(promoBatches)
            .where(eq(promoBatches.publicId, input.publicId))
            .for("update");
          if (!existing) throw notFound("PROMOTION_NOT_FOUND");
          if (existing.version !== input.expectedVersion) {
            throw conflict(
              "VERSION_CONFLICT",
              "This promotion was modified by another session. Reload and try again.",
            );
          }
          if (existing.status === "revoked" && input.status !== "revoked") {
            throw conflict(
              "PROMOTION_REVOKED_FINAL",
              "A revoked promotion cannot be resumed or paused.",
            );
          }
          if (existing.status === input.status) {
            return buildPromotionView(existing, tx);
          }

          const now = deps.clock.now();
          await tx
            .update(promoBatches)
            .set({
              status: input.status,
              version: existing.version + 1,
              updatedAt: now,
            })
            .where(eq(promoBatches.id, existing.id));

          const eventName =
            input.status === "paused"
              ? "promotion.paused"
              : input.status === "revoked"
                ? "promotion.revoked"
                : "promotion.resumed";

          await deps.audit.record(
            {
              category: "admin",
              eventName,
              action: input.status,
              outcome: "completed",
              severity: input.status === "revoked" ? "WARN" : "INFO",
              actor: { userId: actor.userId, role: actor.role },
              resource: { type: "promotion", id: existing.publicId },
              attributes: {
                promoPublicId: existing.publicId,
                label: existing.label,
                previousStatus: existing.status,
                status: input.status,
              },
            },
            tx,
          );

          const [updated] = await tx
            .select()
            .from(promoBatches)
            .where(eq(promoBatches.id, existing.id))
            .limit(1);

          return buildPromotionView(updated!, tx);
        });
      },

      async pause(actor, input) {
        return this.setStatus(actor, { ...input, status: "paused" });
      },

      async resume(actor, input) {
        return this.setStatus(actor, { ...input, status: "active" });
      },

      async revoke(actor, input) {
        return this.setStatus(actor, { ...input, status: "revoked" });
      },

      async generateBatch(actor, input) {
        assertCapabilitySnapshot(actor, "promotions.manage");
        const idemKey = input.idempotencyKey.trim();
        if (!idemKey || idemKey.length > 80) {
          throw validation("INVALID_IDEMPOTENCY_KEY", "Provide an idempotency key up to 80 characters.");
        }

        return deps.db.transaction(async (tx) => {
          await revalidateActorInTx(actor, tx, "promotions.manage");

          const [batch] = await tx
            .select()
            .from(promoBatches)
            .where(eq(promoBatches.publicId, input.publicId))
            .for("update");
          if (!batch) throw notFound("PROMOTION_NOT_FOUND");
          if (!batch.isBatch) {
            throw validation(
              "NOT_A_BATCH_PROMOTION",
              "Batch codes can only be generated on a batch promotion.",
            );
          }
          if (batch.status === "revoked") {
            throw conflict("PROMOTION_REVOKED_FINAL", "Cannot generate codes for a revoked promotion.");
          }

          // Idempotency check on `(batchId, generationKey)`.
          const existingRunRows = await tx
            .select({ id: promoCodes.id })
            .from(promoCodes)
            .where(and(eq(promoCodes.batchId, batch.id), eq(promoCodes.generationKey, idemKey)));

          if (existingRunRows.length > 0) {
            if (existingRunRows.length !== input.count) {
              throw conflict(
                "IDEMPOTENCY_KEY_MISMATCH",
                "This idempotency key was already used with a different batch count.",
              );
            }
            return {
              promotion: await buildPromotionView(batch, tx),
              generated: existingRunRows.length,
            };
          }

          const effectivePrefix =
            input.prefix !== undefined ? normalizePromoPrefix(input.prefix) : batch.codePrefix;
          assertLabelDistinctFromCode(batch.label, effectivePrefix);

          await insertBatchCodesInTx(tx, batch, input.count, effectivePrefix, idemKey);

          const nextBatchSize = batch.batchSize + input.count;
          const now = deps.clock.now();
          await tx
            .update(promoBatches)
            .set({
              codePrefix: effectivePrefix ?? batch.codePrefix,
              batchSize: nextBatchSize,
              version: batch.version + 1,
              updatedAt: now,
            })
            .where(eq(promoBatches.id, batch.id));

          await deps.audit.record(
            {
              category: "admin",
              eventName: "promotion.batch_generated",
              action: "generate_batch",
              outcome: "completed",
              severity: "INFO",
              actor: { userId: actor.userId, role: actor.role },
              resource: { type: "promotion", id: batch.publicId },
              attributes: {
                promoPublicId: batch.publicId,
                label: batch.label,
                generatedCount: input.count,
                totalBatchSize: nextBatchSize,
              },
            },
            tx,
          );

          const [updated] = await tx
            .select()
            .from(promoBatches)
            .where(eq(promoBatches.id, batch.id))
            .limit(1);

          return {
            promotion: await buildPromotionView(updated!, tx),
            generated: input.count,
          };
        });
      },

      async reveal(actor, input) {
        assertCapabilitySnapshot(actor, "promotions.manage");

        return deps.db.transaction(async (tx) => {
          await revalidateActorInTx(actor, tx, "promotions.manage");

          const [batch] = await tx
            .select()
            .from(promoBatches)
            .where(eq(promoBatches.publicId, input.publicId))
            .limit(1);
          if (!batch) throw notFound("PROMOTION_NOT_FOUND");

          if (batch.isBatch && !input.codePublicId) {
            throw validation(
              "BATCH_REVEAL_REQUIRES_EXPORT",
              "Batch promotions hold multiple single-use codes; export the batch CSV to retrieve codes.",
            );
          }

          const [codeRow] = await tx
            .select()
            .from(promoCodes)
            .where(
              input.codePublicId
                ? and(eq(promoCodes.batchId, batch.id), eq(promoCodes.publicId, input.codePublicId))
                : eq(promoCodes.batchId, batch.id),
            )
            .limit(1);

          if (!codeRow) throw notFound("PROMO_CODE_NOT_FOUND");
          const code = decryptPromoCode(deps.crypto, codeRow.publicId, codeRow.codeEnc);

          await deps.audit.record(
            {
              category: "security",
              eventName: "promotion.revealed",
              action: "reveal",
              outcome: "completed",
              severity: "INFO",
              actor: { userId: actor.userId, role: actor.role },
              resource: { type: "promotion", id: batch.publicId },
              attributes: {
                promoPublicId: batch.publicId,
                label: batch.label,
                codePublicId: codeRow.publicId,
              },
            },
            tx,
          );

          return { code };
        });
      },

      async redemptions(actor, input) {
        assertCapabilitySnapshot(actor, "promotions.read");
        const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
        const conditions = [];

        if (input.promotionPublicId) {
          const [batch] = await deps.db
            .select({ id: promoBatches.id })
            .from(promoBatches)
            .where(eq(promoBatches.publicId, input.promotionPublicId))
            .limit(1);
          if (!batch) return { items: [], nextCursor: null };
          conditions.push(eq(promoRedemptions.batchId, batch.id));
        }
        if (input.status) {
          conditions.push(eq(promoRedemptions.status, input.status));
        }
        if (input.cursor) {
          const cursorId = Number.parseInt(input.cursor, 10);
          if (Number.isFinite(cursorId) && cursorId > 0) {
            conditions.push(lt(promoRedemptions.id, cursorId));
          }
        }

        const rows = await deps.db
          .select()
          .from(promoRedemptions)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(promoRedemptions.id))
          .limit(limit + 1);

        const hasMore = rows.length > limit;
        const slice = hasMore ? rows.slice(0, limit) : rows;
        const items = await hydrateRedemptionViews(slice, deps.db);
        const nextCursor = hasMore && slice.length > 0 ? String(slice[slice.length - 1]!.id) : null;
        return { items, nextCursor };
      },

      async releaseRedemption(actor, input) {
        assertCapabilitySnapshot(actor, "promotions.manage");
        const reasonText = input.reason.trim();
        if (reasonText.length < 3 || reasonText.length > 240) {
          throw validation(
            "RELEASE_REASON_REQUIRED",
            "Provide a brief reason (3 to 240 characters) to release this redemption.",
          );
        }

        const runOnce = () =>
          deps.db.transaction(async (tx) => {
            const [candidate] = await tx
              .select()
              .from(promoRedemptions)
              .where(eq(promoRedemptions.publicId, input.redemptionPublicId))
              .limit(1);
            if (!candidate) throw notFound("REDEMPTION_NOT_FOUND");
            if (candidate.status === "released") {
              throw conflict(
                "REDEMPTION_ALREADY_RELEASED",
                "This redemption has already been released.",
              );
            }

            // G-C3-02 lock & evidence order: order FOR UPDATE -> compliance.orderPaymentExposureInTx -> actor -> promo locks.
            const [orderRow] = await tx
              .select({
                id: orders.id,
                publicId: orders.publicId,
                statusKey: orders.statusKey,
              })
              .from(orders)
              .where(eq(orders.publicId, candidate.orderPublicId))
              .for("update");

            if (
              !orderRow ||
              (orderRow.statusKey !== "canceled" && orderRow.statusKey !== "cancelled")
            ) {
              throw conflict(
                "REDEMPTION_RELEASE_NOT_ELIGIBLE",
                "This redemption can only be released after the order is cancelled.",
              );
            }

            const exposurePort = resolvePaymentExposurePort(deps.services);
            if (!exposurePort) {
              throw conflict(
                "REDEMPTION_RELEASE_NOT_ELIGIBLE",
                "Payment exposure verification is unavailable; redemption stays used.",
              );
            }

            let exposure: unknown;
            try {
              exposure = await exposurePort(tx, candidate.orderPublicId);
            } catch {
              throw conflict(
                "REDEMPTION_RELEASE_NOT_ELIGIBLE",
                "Payment exposure could not be verified; redemption stays used.",
              );
            }

            if (!isZeroPaymentExposure(exposure)) {
              throw conflict(
                "REDEMPTION_RELEASE_NOT_ELIGIBLE",
                "This redemption can only be released when the order is cancelled, unpaid (including never refunded), and has no open invoice or pending payment.",
              );
            }

            await revalidateActorInTx(actor, tx, "promotions.manage");

            const released = await releaseRedemptionRowsInTx(tx, candidate, {
              reason: "admin_manual_release",
              note: reasonText,
              releasedByUserId: actor.userId,
              manual: true,
              actor: { userId: actor.userId, role: actor.role },
            });

            if (!released) throw notFound("REDEMPTION_NOT_FOUND");
            const [view] = await hydrateRedemptionViews([released.redemption], tx);
            return view!;
          });

        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            return await runOnce();
          } catch (err) {
            if (attempt === 0 && isMysqlDeadlockError(err)) continue;
            throw err;
          }
        }
        throw conflict("LOCK_CONFLICT", "Please retry releasing the redemption.");
      },

      async stats(actor, input) {
        assertCapabilitySnapshot(actor, "promotions.read");
        const now = deps.clock.now();

        let targetBatchId: number | null = null;
        if (input.promotionPublicId) {
          const [batch] = await deps.db
            .select({ id: promoBatches.id })
            .from(promoBatches)
            .where(eq(promoBatches.publicId, input.promotionPublicId))
            .limit(1);
          if (!batch) {
            return {
              activePromotions: 0,
              redemptions: 0,
              releasedRedemptions: 0,
              discountMinorByCurrency: {},
            };
          }
          targetBatchId = batch.id;
        }

        const allBatches = await deps.db
          .select()
          .from(promoBatches)
          .where(targetBatchId !== null ? eq(promoBatches.id, targetBatchId) : undefined);

        const activePromotions = allBatches.filter(
          (b) => computeDerivedStatus(b, now) === "active",
        ).length;

        const aggRows = await deps.db
          .select({
            status: promoRedemptions.status,
            currency: promoRedemptions.currency,
            count: sql<number>`count(*)`,
            promoSum: sql<number>`coalesce(sum(${promoRedemptions.promoDiscountMinor}), 0)`,
          })
          .from(promoRedemptions)
          .where(
            targetBatchId !== null ? eq(promoRedemptions.batchId, targetBatchId) : undefined,
          )
          .groupBy(promoRedemptions.status, promoRedemptions.currency);

        let redemptions = 0;
        let releasedRedemptions = 0;
        const discountMinorByCurrency: Record<string, number> = {};

        for (const r of aggRows) {
          const c = Number(r.count ?? 0);
          if (r.status === "redeemed") {
            redemptions += c;
            const sum = Number(r.promoSum ?? 0);
            if (sum > 0) {
              discountMinorByCurrency[r.currency] =
                (discountMinorByCurrency[r.currency] ?? 0) + sum;
            }
          } else {
            releasedRedemptions += c;
          }
        }

        return {
          activePromotions,
          redemptions,
          releasedRedemptions,
          discountMinorByCurrency,
        };
      },

      async exportCodes(actor, input) {
        assertCapabilitySnapshot(actor, "promotions.manage");

        return deps.db.transaction(async (tx) => {
          await revalidateActorInTx(actor, tx, "promotions.manage");

          const [batch] = await tx
            .select()
            .from(promoBatches)
            .where(eq(promoBatches.publicId, input.publicId))
            .limit(1);
          if (!batch) throw notFound("PROMOTION_NOT_FOUND");

          const codeRows = await tx
            .select()
            .from(promoCodes)
            .where(eq(promoCodes.batchId, batch.id))
            .orderBy(promoCodes.id);

          const csvRows = codeRows.map((c) => {
            const plainCode = decryptPromoCode(deps.crypto, c.publicId, c.codeEnc);
            return [
              c.publicId,
              batch.publicId,
              batch.name,
              batch.label,
              plainCode,
              `/#promo=${encodeURIComponent(plainCode)}`,
              batch.status === "active" ? c.status : batch.status,
              c.redemptionCount,
              c.maxUses ?? batch.maxRedemptions ?? "unlimited",
              c.createdAt.toISOString(),
            ];
          });

          const csv = toFormulaSafeCsv(
            [
              "code_public_id",
              "promotion_public_id",
              "promotion_name",
              "customer_label",
              "code",
              "fragment_link_path",
              "status",
              "redemption_count",
              "max_uses",
              "created_at",
            ],
            csvRows,
          );

          await deps.audit.record(
            {
              category: "security",
              eventName: "promotion.exported",
              action: "export",
              outcome: "completed",
              severity: "INFO",
              actor: { userId: actor.userId, role: actor.role },
              resource: { type: "promotion_export", id: batch.publicId },
              attributes: {
                exportKind: "codes",
                promoPublicId: batch.publicId,
                rowCount: csvRows.length,
              },
            },
            tx,
          );

          return {
            fileName: `promotion-codes-${batch.publicId}.csv`,
            csv,
            rowCount: csvRows.length,
          };
        });
      },

      async exportRedemptions(actor, input) {
        assertCapabilitySnapshot(actor, "promotions.manage");

        return deps.db.transaction(async (tx) => {
          await revalidateActorInTx(actor, tx, "promotions.manage");

          const conditions = [];
          let targetPromoPublicId: string | null = null;

          if (input.promotionPublicId) {
            const [batch] = await tx
              .select({ id: promoBatches.id, publicId: promoBatches.publicId })
              .from(promoBatches)
              .where(eq(promoBatches.publicId, input.promotionPublicId))
              .limit(1);
            if (!batch) throw notFound("PROMOTION_NOT_FOUND");
            conditions.push(eq(promoRedemptions.batchId, batch.id));
            targetPromoPublicId = batch.publicId;
          }
          if (input.status) {
            conditions.push(eq(promoRedemptions.status, input.status));
          }

          const rows = await tx
            .select()
            .from(promoRedemptions)
            .where(conditions.length > 0 ? and(...conditions) : undefined)
            .orderBy(desc(promoRedemptions.id))
            .limit(10_000);

          const views = await hydrateRedemptionViews(rows, tx);
          const csvRows = views.map((v) => [
            v.publicId,
            v.promoPublicId,
            v.promotionName,
            v.label,
            v.codeMasked,
            v.orderPublicId,
            v.orderNumber ?? "",
            v.customerPublicId,
            v.customerRef ?? "",
            v.status,
            v.currency,
            v.subtotalMinor,
            v.promoDiscountMinor,
            v.bundleDiscountMinor,
            v.discountMinor,
            v.totalMinor,
            v.redeemedAt,
            v.releasedAt ?? "",
            v.releaseReason ?? "",
            v.releaseNote ?? "",
          ]);

          const csv = toFormulaSafeCsv(
            [
              "redemption_public_id",
              "promotion_public_id",
              "promotion_name",
              "customer_label",
              "code_masked",
              "order_public_id",
              "order_reference",
              "customer_public_id",
              "customer_ref",
              "status",
              "currency",
              "subtotal_minor",
              "promo_discount_minor",
              "bundle_discount_minor",
              "total_discount_minor",
              "total_minor",
              "redeemed_at",
              "released_at",
              "release_reason",
              "release_note",
            ],
            csvRows,
          );

          await deps.audit.record(
            {
              category: "security",
              eventName: "promotion.exported",
              action: "export",
              outcome: "completed",
              severity: "INFO",
              actor: { userId: actor.userId, role: actor.role },
              resource: { type: "promotion_export", id: targetPromoPublicId ?? "all" },
              attributes: {
                exportKind: "redemptions",
                promoPublicId: targetPromoPublicId ?? "all",
                rowCount: csvRows.length,
              },
            },
            tx,
          );

          return {
            fileName: targetPromoPublicId
              ? `promotion-redemptions-${targetPromoPublicId}.csv`
              : "promotion-redemptions-all.csv",
            csv,
            rowCount: csvRows.length,
          };
        });
      },

      async getSettings(actor) {
        assertCapabilitySnapshot(actor, "promotions.read");
        const [enabled, policy] = await Promise.all([
          isEnabled(),
          readPolicy(),
        ]);
        return {
          enabled,
          maxDiscountPercent: policy.maxDiscountPercent,
        };
      },

      async updateSettings(actor, input) {
        assertCapabilitySnapshot(actor, "promotions.manage");

        return deps.db.transaction(async (tx) => {
          await revalidateActorInTx(actor, tx, "promotions.manage");

          const currentEnabled = await isEnabled({ tx });
          const currentPolicy = await readPolicy(tx);

          const nextEnabled = input.enabled !== undefined ? input.enabled : currentEnabled;
          const nextMaxDiscountPercent =
            input.maxDiscountPercent !== undefined
              ? input.maxDiscountPercent
              : currentPolicy.maxDiscountPercent;

          if (
            !Number.isInteger(nextMaxDiscountPercent) ||
            nextMaxDiscountPercent < 1 ||
            nextMaxDiscountPercent > 100
          ) {
            throw validation(
              "INVALID_MAX_DISCOUNT_PERCENT",
              "Largest discount per order must be an integer between 1% and 100%.",
            );
          }

          if (nextEnabled !== currentEnabled) {
            await deps.settings.set(PROMOTIONS_ENABLED_FLAG.key, nextEnabled, tx);
          }
          if (nextMaxDiscountPercent !== currentPolicy.maxDiscountPercent) {
            await deps.settings.set(
              PROMOTIONS_POLICY_SETTING.key,
              { maxDiscountPercent: nextMaxDiscountPercent },
              tx,
            );
          }

          await deps.audit.record(
            {
              category: "admin",
              eventName: "promotion.settings_updated",
              action: "update",
              outcome: "completed",
              severity: "WARN",
              actor: { userId: actor.userId, role: actor.role },
              resource: { type: "setting", id: "promotions.policy" },
              attributes: {
                enabled: nextEnabled,
                maxDiscountPercent: nextMaxDiscountPercent,
              },
            },
            tx,
          );

          return {
            enabled: nextEnabled,
            maxDiscountPercent: nextMaxDiscountPercent,
          };
        });
      },
    },

    async healthCounts() {
      const [enabled, countRows] = await Promise.all([
        isEnabled(),
        deps.db
          .select({ count: sql<number>`count(*)` })
          .from(promoBatches)
          .where(eq(promoBatches.status, "active")),
      ]);
      return {
        enabled,
        activePromotions: Number(countRows[0]?.count ?? 0),
      };
    },
  };
}
