/**
 * Increment 05 (Package C1) — Promotions module MySQL integration, security, abuse-control,
 * concurrency ("last redemption: exactly one wins"), and G-C3-02 release-fence tests.
 * All test data is 100% synthetic.
 */
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Services } from "../../container.js";
import { DomainError } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { newRequestContext, runWithRequestContext } from "../../core/requestContext.js";
import type { SessionPrincipal, SessionTransport, Tx } from "../../core/types.js";
import { createCallerFactory, type SafeErrorData } from "../../trpc/trpc.js";
import { users, userSessions } from "../identity/schema.js";
import { orders, orderWorkflowVersions } from "../orders/schema.js";
import { DEFAULT_WORKFLOW, type WorkflowDefinition } from "../orders/workflowTypes.js";
import { platformSettings } from "../platform/schema.js";
import { createSettingsStore } from "../platform/settingsStore.js";
import { createTrashRegistry } from "../trash/ports.js";
import { createTestDeps, fakePrincipal, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { PROMO_CODE_ALPHABET } from "./codes.js";
import { createPromotionsModule, type PromotionsModule } from "./index.js";
import { promotionsRouter } from "./router.js";
import {
  promoBatches,
  promoCheckAttempts,
  promoCodes,
  promoRedemptions,
} from "./schema.js";
import {
  allocateMinorAcrossCapacities,
  computePromotionPricing,
  roundHalfUpBps,
} from "./service.js";
import {
  PROMOTIONS_POLICY_SETTING,
  parsePromotionsPolicy,
} from "./settings.js";

const noopTransport: SessionTransport = {
  issue() {},
  clear() {},
};

function extractSafeError(err: unknown): { code?: string; safe?: SafeErrorData } {
  if (err instanceof DomainError) {
    return {
      code: err.code,
      safe: {
        domainCode: err.code,
        reasonCode: err.reasonCode,
        safeMessage: err.safeMessage,
        details: err.details,
        requestId: "req_test",
      },
    };
  }
  if (err instanceof TRPCError) {
    const cause = err.cause;
    if (cause instanceof DomainError) {
      return {
        code: err.code,
        safe: {
          domainCode: cause.code,
          reasonCode: cause.reasonCode,
          safeMessage: cause.safeMessage,
          details: cause.details,
          requestId: "req_test",
        },
      };
    }
    return { code: err.code };
  }
  return {};
}

describe("server/modules/promotions (Increment 05, Package C1)", () => {
  let tdb: TestDb;
  let h: TestHarness;
  let mod: PromotionsModule;
  let stdWorkflowVersionId = 1;
  const createCaller = createCallerFactory(promotionsRouter);

  beforeAll(async () => {
    tdb = await createTestDb({
      schema: {
        users,
        userSessions,
        platformSettings,
        orderWorkflowVersions,
        orders,
        promoBatches,
        promoCodes,
        promoRedemptions,
        promoCheckAttempts,
      },
    });
  });

  afterAll(async () => {
    await tdb.cleanup();
  });

  beforeEach(async () => {
    await tdb.db.delete(promoRedemptions);
    await tdb.db.delete(promoCodes);
    await tdb.db.delete(promoBatches);
    await tdb.db.delete(promoCheckAttempts);
    await tdb.db.delete(orders);
    await tdb.db.delete(orderWorkflowVersions);
    await tdb.db.delete(userSessions);
    await tdb.db.delete(users);
    await tdb.db.delete(platformSettings);

    const [wfIns] = await tdb.db.insert(orderWorkflowVersions).values({
      publicId: ulid(),
      workflowId: 1,
      versionNumber: 1,
      definition: DEFAULT_WORKFLOW,
    });
    stdWorkflowVersionId = Number(wfIns.insertId);

    h = createTestDeps({
      db: tdb.db,
      now: new Date("2026-11-22T12:00:00.000Z"),
    });
    const realSettings = createSettingsStore({
      db: tdb.db,
      clock: h.clock,
      logger: h.deps.logger,
      crypto: h.deps.crypto,
      audit: h.audit,
    });
    h.deps.settings = realSettings;
    h.services.settings = realSettings;

    mod = createPromotionsModule(h.deps);
    (h.services as unknown as { promotions: PromotionsModule }).promotions = mod;
  });

  async function seedUser(opts: {
    email: string;
    role?: "customer" | "staff" | "admin";
    status?: "active" | "suspended";
    verified?: boolean;
    stepUp?: boolean;
    customerRef?: string | null;
  }): Promise<{
    id: number;
    publicId: string;
    email: string;
    principal: SessionPrincipal;
  }> {
    const publicId = ulid();
    const role = opts.role ?? "customer";
    const status = opts.status ?? "active";
    const normalizedEmail = opts.email.trim().toLowerCase();
    const now = h.clock.now();

    const [ins] = await tdb.db.insert(users).values({
      publicId,
      customerRef: opts.customerRef ?? null,
      role,
      status,
      emailEnc: h.deps.crypto.encrypt(normalizedEmail, `users.email:${publicId}`),
      emailIndex: h.deps.crypto.blindIndex(normalizedEmail, "users.email"),
      emailVerifiedAt: opts.verified === false ? null : now,
      nameEnc: h.deps.crypto.encrypt("Synthetic User", `users.name:${publicId}`),
    });
    const id = Number(ins.insertId);
    const sessionPublicId = ulid();
    const stepUpAt = opts.stepUp ? now : null;

    await tdb.db.insert(userSessions).values({
      publicId: sessionPublicId,
      userId: id,
      tokenHash: h.deps.crypto.hashToken(`tok_${sessionPublicId}`),
      csrfSecretEnc: h.deps.crypto.encrypt("csrf_synthetic", `user_sessions.csrf:${sessionPublicId}`),
      authMethod: "local",
      authenticatedAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: new Date(now.getTime() + 8 * 60 * 60 * 1000),
      mfaVerifiedAt: now,
      stepUpAt,
    });

    const principal = fakePrincipal({
      sessionId: sessionPublicId,
      userId: id,
      userPublicId: publicId,
      role,
      stepUpAt,
    });

    return { id, publicId, email: normalizedEmail, principal };
  }

  async function seedOrderRow(opts: {
    ownerUserId: number;
    publicId?: string;
    reference?: string;
    statusKey?: string;
    workflowVersionId?: number;
    subtotalMinor?: number;
    discountMinor?: number;
    promoDiscountMinor?: number;
    promoLabel?: string | null;
  }) {
    const publicId = opts.publicId ?? ulid();
    const subtotalMinor = opts.subtotalMinor ?? 10_000;
    const discountMinor = opts.discountMinor ?? 0;
    await tdb.db.insert(orders).values({
      publicId,
      reference: opts.reference ?? `ORD-${publicId.slice(-6)}`,
      ownerUserId: opts.ownerUserId,
      projectName: "Synthetic Project",
      workflowVersionId: opts.workflowVersionId ?? stdWorkflowVersionId,
      statusKey: opts.statusKey ?? "submitted",
      subtotalMinor,
      discountMinor,
      promoDiscountMinor: opts.promoDiscountMinor ?? 0,
      promoLabel: opts.promoLabel ?? null,
      totalMinor: subtotalMinor - discountMinor,
      currency: "USD",
    });
    return publicId;
  }

  function callerFor(principal: SessionPrincipal | null, ipAddress = "203.0.113.10") {
    const request = newRequestContext("test", { ipAddress });
    if (principal) {
      request.actor = {
        userId: principal.userId,
        role: principal.role,
        sessionId: principal.sessionId,
      };
    }
    return {
      request,
      caller: createCaller({
        services: h.services,
        session: principal,
        request,
        transport: noopTransport,
      }),
    };
  }

  const sampleProductA = ulid();
  const sampleProductB = ulid();

  it("enforces role, capability, step-up MFA, and in-transaction actor re-validation across all procedures", async () => {
    const anon = callerFor(null);
    const customer = await seedUser({ email: "cust@synthetic.test", role: "customer" });
    const staff = await seedUser({ email: "staff@synthetic.test", role: "staff" });
    const adminNoStepUp = await seedUser({
      email: "admin-nostep@synthetic.test",
      role: "admin",
      stepUp: false,
    });
    const admin = await seedUser({
      email: "admin@synthetic.test",
      role: "admin",
      stepUp: true,
    });

    // No customer-reachable `promotions.check` oracle exists on `promotionsRouter` (customers apply codes only via server-priced `cart.applyCode` / `orders.quoteWithPromo`).
    expect("check" in promotionsRouter._def.procedures).toBe(false);

    // Anonymous refused everywhere.
    await expect(anon.caller.admin.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    // Customer refused on admin read & write.
    const custCall = callerFor(customer.principal);
    await expect(custCall.caller.admin.list()).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Admin without step-up refused on `promotions.manage` writes.
    const adminNoStepCall = callerFor(adminNoStepUp.principal);
    const noStepErr = await adminNoStepCall.caller.admin
      .create({
        name: "Synthetic Promo",
        label: "Seasonal Offer",
        type: "percent",
        percentBps: 1_500,
        scope: { kind: "all" },
        code: "WINTER-26",
      })
      .then(() => { throw new Error("expected rejection"); }, (e: unknown) => extractSafeError(e));
    expect(noStepErr.safe?.reasonCode).toBe("STEP_UP_REQUIRED");

    // Admin with step-up succeeds; code encrypted at rest and never logged/audited in plaintext.
    const adminCall = callerFor(admin.principal);
    const created = await adminCall.caller.admin.create({
      name: "Synthetic Promo",
      label: "Seasonal Offer",
      type: "percent",
      percentBps: 1_500,
      scope: { kind: "all" },
      code: "winter-26",
    });
    expect(created.initialCode).toBe("WINTER-26");
    expect(created.promotion.codeMasked).toBe("WI••••26");

    const [rawCodeRow] = await tdb.db.select().from(promoCodes);
    expect(rawCodeRow!.codeEnc).toMatch(/^rpenc:v1:/);
    expect(rawCodeRow!.codeEnc).not.toContain("WINTER-26");
    expect(JSON.stringify(h.audit.events)).not.toContain("WINTER-26");

    // Staff (`promotions.read`) can list/get/stats/redemptions and sees masked codes, but cannot write/reveal/export.
    const staffCall = callerFor(staff.principal);
    const staffList = await staffCall.caller.admin.list();
    expect(staffList.items).toHaveLength(1);
    expect(staffList.items[0]!.codeMasked).toBe("WI••••26");

    await expect(
      staffCall.caller.admin.reveal({ publicId: created.promotion.publicId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      staffCall.caller.admin.exportCodes({ publicId: created.promotion.publicId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      staffCall.caller.admin.updateSettings({ enabled: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Admin reveal returns plaintext code and emits `promotion.revealed` without code text in audit.
    const revealed = await adminCall.caller.admin.reveal({ publicId: created.promotion.publicId });
    expect(revealed.code).toBe("WINTER-26");
    const revealAudit = h.audit.events.find((e) => e.eventName === "promotion.revealed");
    expect(revealAudit).toBeDefined();
    expect(JSON.stringify(revealAudit)).not.toContain("WINTER-26");

    // In-transaction re-validation: revoking the admin session in DB blocks subsequent writes even with stale principal.
    await tdb.db
      .update(userSessions)
      .set({ revokedAt: h.clock.now() })
      .where(eq(userSessions.publicId, admin.principal.sessionId));

    const revokedErr = await adminCall.caller.admin
      .pause({ publicId: created.promotion.publicId, expectedVersion: 1 })
      .then(() => { throw new Error("expected rejection"); }, (e: unknown) => extractSafeError(e));
    expect(revokedErr.safe?.reasonCode).toBe("SESSION_REVOKED");
  });

  it("rejects label matching code/prefix (LABEL_MATCHES_CODE) and keeps feature.promotions off by default", async () => {
    const admin = await seedUser({ email: "admin2@synthetic.test", role: "admin", stepUp: true });
    const alice = await seedUser({ email: "alice2@synthetic.test", role: "customer" });
    const adminCall = callerFor(admin.principal);

    const dupLabelErr = await adminCall.caller.admin
      .create({
        name: "Dup Label Test",
        label: "secret-50",
        type: "percent",
        percentBps: 5_000,
        scope: { kind: "all" },
        code: "SECRET-50",
      })
      .then(() => { throw new Error("expected rejection"); }, (e: unknown) => extractSafeError(e));
    expect(dupLabelErr.safe?.reasonCode).toBe("LABEL_MATCHES_CODE");

    // Create valid promotion while `feature.promotions` is still OFF (default).
    await adminCall.caller.admin.create({
      name: "Valid Off Test",
      label: "Welcome Discount",
      type: "percent",
      percentBps: 1_000,
      scope: { kind: "all" },
      code: "WELCOME-10",
    });

    const settingsDefault = await adminCall.caller.admin.getSettings();
    expect(settingsDefault).toEqual({
      enabled: false,
      maxDiscountPercent: 100,
      maxDiscountBps: 10_000,
      maxFixedAmountMinor: null,
      allowZeroTotal: true,
      minOrderTotalAfterDiscountMinor: 0,
    });

    const offErr = await mod
      .preview({
        code: "WELCOME-10",
        customerUserId: alice.id,
        actorUserId: alice.id,
        currency: "USD",
        lines: [{ productPublicId: sampleProductA, packetNumber: 1, tierKey: "Basic", lineTotalMinor: 10_000 }],
        subtotalMinor: 10_000,
        bundleDiscountMinor: 0,
        bundleLabel: null,
      })
      .then(() => { throw new Error("expected rejection"); }, (e: unknown) => extractSafeError(e));
    expect(offErr.safe?.reasonCode).toBe("PROMO_NOT_APPLICABLE");
    expect(offErr.safe?.safeMessage).toBe("This code cannot be applied.");

    // Enabling `feature.promotions` is audited (`promotion.settings_updated`) and activates code checks.
    const updatedSettings = await adminCall.caller.admin.updateSettings({ enabled: true });
    expect(updatedSettings.enabled).toBe(true);
    expect(h.audit.events.some((e) => e.eventName === "promotion.settings_updated")).toBe(true);

    const ok = await mod.preview({
      code: "  welcome-10 ",
      customerUserId: alice.id,
      actorUserId: alice.id,
      currency: "USD",
      lines: [{ productPublicId: sampleProductA, packetNumber: 1, tierKey: "Basic", lineTotalMinor: 10_000 }],
      subtotalMinor: 10_000,
      bundleDiscountMinor: 0,
      bundleLabel: null,
    });
    expect(ok).toMatchObject({
      label: "Welcome Discount",
      promoDiscountMinor: 1_000,
      bundleDiscountMinor: 0,
      discountMinor: 1_000,
      totalMinor: 9_000,
    });
  });

  it("computes pricing accurately: bundle vs promo winner, combineWithBundle, scopes, caps, and global 50% guard", async () => {
    const admin = await seedUser({ email: "admin3@synthetic.test", role: "admin", stepUp: true });
    const alice = await seedUser({ email: "alice3@synthetic.test", role: "customer" });
    const adminCall = callerFor(admin.principal);
    await adminCall.caller.admin.updateSettings({ enabled: true, maxDiscountPercent: 50 });

    // 1. Non-combinable 20% promo vs 15% bundle -> promo wins (2,000 > 1,500); vs 25% bundle -> bundle wins (2,500 > 2,000).
    await adminCall.caller.admin.create({
      name: "Non-Combinable 20%",
      label: "20% Promo",
      type: "percent",
      percentBps: 2_000,
      scope: { kind: "tiers", tierKeys: ["Standard"] },
      combineWithBundle: false,
      code: "STAND-20",
    });

    const promoWins = await mod.preview({
      code: "STAND-20",
      customerUserId: alice.id,
      actorUserId: alice.id,
      currency: "USD",
      // Lowercase `standard` matches `orders` runtime normalization!
      lines: [{ productPublicId: sampleProductA, packetNumber: 2, tierKey: "standard", lineTotalMinor: 10_000 }],
      subtotalMinor: 10_000,
      bundleDiscountMinor: 1_500,
      bundleLabel: "Bundle 15%",
    });
    expect(promoWins).toMatchObject({
      promoDiscountMinor: 2_000,
      bundleDiscountMinor: 0,
      discountMinor: 2_000,
      discountLabel: "20% Promo",
      totalMinor: 8_000,
    });

    const bundleWins = await mod.preview({
      code: "STAND-20",
      customerUserId: alice.id,
      actorUserId: alice.id,
      currency: "USD",
      lines: [{ productPublicId: sampleProductA, packetNumber: 2, tierKey: "standard", lineTotalMinor: 10_000 }],
      subtotalMinor: 10_000,
      bundleDiscountMinor: 2_500,
      bundleLabel: "Bundle 25%",
    });
    expect(bundleWins).toMatchObject({
      promoDiscountMinor: 0,
      bundleDiscountMinor: 2_500,
      discountMinor: 2_500,
      discountLabel: "Bundle 25%",
      totalMinor: 7_500,
    });

    // 2. Under D5, creating an 80% promo while `maxDiscountPercent` is 50% rejects naming `maxDiscountPercent`;
    // raising `maxDiscountPercent` to 90% allows creation, and lowering back to 50% rejects preview with `PROMO_LIMIT_MAX_PERCENT`.
    const blocked80 = await adminCall.caller.admin
      .create({
        name: "Combinable 80%",
        label: "VIP 80%",
        type: "percent",
        percentBps: 8_000,
        scope: { kind: "all" },
        combineWithBundle: true,
        code: "VIP-80-COMB",
      })
      .then(() => {
        throw new Error("expected limit rejection");
      }, (e: unknown) => extractSafeError(e));
    expect(blocked80.safe?.reasonCode).toBe("PROMO_LIMIT_MAX_PERCENT");
    expect(blocked80.safe?.details?.limit).toBe("maxDiscountPercent");

    // Raising global limit to 90% allows creation and full combined discount (1,000 bundle + 80% of remaining 9,000 = 7,200 -> 8,200).
    await adminCall.caller.admin.updateSettings({ maxDiscountPercent: 90 });
    await adminCall.caller.admin.create({
      name: "Combinable 80%",
      label: "VIP 80%",
      type: "percent",
      percentBps: 8_000,
      scope: { kind: "all" },
      combineWithBundle: true,
      code: "VIP-80-COMB",
    });

    const raised = await mod.preview({
      code: "VIP-80-COMB",
      customerUserId: alice.id,
      actorUserId: alice.id,
      currency: "USD",
      lines: [{ productPublicId: sampleProductA, packetNumber: 1, tierKey: "Basic", lineTotalMinor: 10_000 }],
      subtotalMinor: 10_000,
      bundleDiscountMinor: 1_000,
      bundleLabel: "Bundle 10%",
    });
    expect(raised).toMatchObject({
      bundleDiscountMinor: 1_000,
      promoDiscountMinor: 7_200,
      discountMinor: 8_200,
      totalMinor: 1_800,
    });

    await adminCall.caller.admin.updateSettings({ maxDiscountPercent: 50 });
    const guardRejected = await mod
      .preview({
        code: "VIP-80-COMB",
        customerUserId: alice.id,
        actorUserId: alice.id,
        currency: "USD",
        lines: [{ productPublicId: sampleProductA, packetNumber: 1, tierKey: "Basic", lineTotalMinor: 10_000 }],
        subtotalMinor: 10_000,
        bundleDiscountMinor: 1_000,
        bundleLabel: "Bundle 10%",
      })
      .then(() => {
        throw new Error("expected limit rejection");
      }, (e: unknown) => extractSafeError(e));
    expect(guardRejected.safe?.reasonCode).toBe("PROMO_LIMIT_MAX_PERCENT");
    expect(guardRejected.safe?.details?.limit).toBe("maxDiscountPercent");

    // 3. Fixed code larger than eligible subtotal + 100% guard never produces a negative total.
    await adminCall.caller.admin.updateSettings({ maxDiscountPercent: 100 });
    await adminCall.caller.admin.create({
      name: "Fixed $250",
      label: "$250 Credit",
      type: "fixed",
      amountMinor: 25_000,
      currency: "USD",
      scope: { kind: "products", productPublicIds: [sampleProductB] },
      minSubtotalMinor: 5_000,
      code: "FIXED-250",
    });

    // Entitled customer with no eligible items gets PROMO_NOT_ELIGIBLE_ITEMS; below minSubtotal gets PROMO_MIN_SUBTOTAL.
    const noEligibleErr = await mod
      .preview({
        code: "FIXED-250",
        customerUserId: alice.id,
        actorUserId: alice.id,
        currency: "USD",
        lines: [{ productPublicId: sampleProductA, packetNumber: 1, tierKey: "Basic", lineTotalMinor: 6_000 }],
        subtotalMinor: 6_000,
        bundleDiscountMinor: 0,
        bundleLabel: null,
      })
      .then(() => { throw new Error("expected rejection"); }, (e: unknown) => extractSafeError(e));
    expect(noEligibleErr.safe?.reasonCode).toBe("PROMO_NOT_ELIGIBLE_ITEMS");

    const minSubErr = await mod
      .preview({
        code: "FIXED-250",
        customerUserId: alice.id,
        actorUserId: alice.id,
        currency: "USD",
        lines: [{ productPublicId: sampleProductB, packetNumber: null, tierKey: null, lineTotalMinor: 3_000 }],
        subtotalMinor: 3_000,
        bundleDiscountMinor: 0,
        bundleLabel: null,
      })
      .then(() => { throw new Error("expected rejection"); }, (e: unknown) => extractSafeError(e));
    expect(minSubErr.safe?.reasonCode).toBe("PROMO_MIN_SUBTOTAL");

    const cappedAtZero = await mod.preview({
      code: "FIXED-250",
      customerUserId: alice.id,
      actorUserId: alice.id,
      currency: "USD",
      lines: [{ productPublicId: sampleProductB, packetNumber: null, tierKey: null, lineTotalMinor: 8_000 }],
      subtotalMinor: 8_000,
      bundleDiscountMinor: 0,
      bundleLabel: null,
    });
    expect(cappedAtZero).toMatchObject({
      promoDiscountMinor: 8_000,
      discountMinor: 8_000,
      totalMinor: 0,
    });
  });

  it("prevents enumeration with uniform errors, blocks IDOR/self-redemption, and pauses account after 5 failures in 15m (WARN SIEM event)", async () => {
    const admin = await seedUser({ email: "admin4@synthetic.test", role: "admin", stepUp: true });
    const staff = await seedUser({ email: "staff4@synthetic.test", role: "staff" });
    const unverified = await seedUser({
      email: "unverified@partner.org",
      role: "customer",
      verified: false,
    });
    const outsider = await seedUser({ email: "outsider@other.test", role: "customer" });
    const insider = await seedUser({ email: "insider@partner.org", role: "customer" });

    const adminCall = callerFor(admin.principal);
    await adminCall.caller.admin.updateSettings({ enabled: true });

    // Partner-domain + first-order-only + minSubtotal code: unentitled callers MUST NOT see PROMO_MIN_SUBTOTAL!
    const partnerPromo = await adminCall.caller.admin.create({
      name: "Partner First Order",
      label: "Partner Offer",
      type: "percent",
      percentBps: 2_500,
      currency: "USD",
      minSubtotalMinor: 20_000,
      firstOrderOnly: true,
      allowEmailDomains: ["@partner.org"],
      scope: { kind: "all" },
      code: "PARTNER-25",
    });

    const smallOrderInput = {
      code: "PARTNER-25",
      currency: "USD",
      lines: [{ productPublicId: sampleProductA, packetNumber: 1, tierKey: "Basic", lineTotalMinor: 5_000 }],
      subtotalMinor: 5_000,
      bundleDiscountMinor: 0,
      bundleLabel: null as string | null,
    };

    const previewAs = (
      actor: { id: number; principal: SessionPrincipal },
      customerUserId: number,
      override: Partial<typeof smallOrderInput> = {},
    ) =>
      runWithRequestContext(
        newRequestContext("test", {
          ipAddress: "203.0.113.10",
          actor: {
            userId: actor.id,
            role: actor.principal.role,
            sessionId: actor.principal.sessionId,
          },
        }),
        () =>
          mod.preview({
            ...smallOrderInput,
            ...override,
            customerUserId,
            actorUserId: actor.id,
          }),
      );

    // Outsider (wrong domain) with $50 cart -> uniform PROMO_NOT_APPLICABLE (NOT PROMO_MIN_SUBTOTAL!).
    const outErr = await previewAs(outsider, outsider.id)
      .then(() => { throw new Error("expected rejection"); }, (e: unknown) => extractSafeError(e));
    expect(outErr.safe).toMatchObject({
      reasonCode: "PROMO_NOT_APPLICABLE",
      safeMessage: "This code cannot be applied.",
    });

    // Unverified e-mail customer on @partner.org -> uniform PROMO_NOT_APPLICABLE!
    const unvErr = await previewAs(unverified, unverified.id)
      .then(() => { throw new Error("expected rejection"); }, (e: unknown) => extractSafeError(e));
    expect(unvErr.safe?.reasonCode).toBe("PROMO_NOT_APPLICABLE");

    // Staff self-redemption -> uniform PROMO_NOT_APPLICABLE; staff checking ON BEHALF of insider -> PROMO_MIN_SUBTOTAL!
    const staffSelfErr = await previewAs(staff, staff.id)
      .then(() => { throw new Error("expected rejection"); }, (e: unknown) => extractSafeError(e));
    expect(staffSelfErr.safe?.reasonCode).toBe("PROMO_NOT_APPLICABLE");

    const staffForInsiderErr = await previewAs(staff, insider.id)
      .then(() => { throw new Error("expected rejection"); }, (e: unknown) => extractSafeError(e));
    expect(staffForInsiderErr.safe?.reasonCode).toBe("PROMO_MIN_SUBTOTAL");

    // IDOR: outsider attempting to preview on behalf of insider (`actorUserId !== customerUserId` without `orders.manage`) is refused with FORBIDDEN!
    await expect(
      previewAs(outsider, insider.id),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // First-order-only: once insider has a historical order, insider receives uniform PROMO_NOT_APPLICABLE.
    await seedOrderRow({ ownerUserId: insider.id, statusKey: "submitted" });
    const notFirstErr = await previewAs(insider, insider.id, {
      subtotalMinor: 25_000,
      lines: [{ productPublicId: sampleProductA, packetNumber: 1, tierKey: "Basic", lineTotalMinor: 25_000 }],
    }).then(() => { throw new Error("expected rejection"); }, (e: unknown) => extractSafeError(e));
    expect(notFirstErr.safe?.reasonCode).toBe("PROMO_NOT_APPLICABLE");

    // Passive `recheck: true` never increments failed attempts even when paused/invalid.
    await adminCall.caller.admin.pause({
      publicId: partnerPromo.promotion.publicId,
      expectedVersion: partnerPromo.promotion.version,
    });
    for (let i = 0; i < 6; i += 1) {
      await expect(
        mod.preview(
          {
            code: "NO-SUCH-CODE",
            customerUserId: outsider.id,
            actorUserId: outsider.id,
            currency: "USD",
            lines: smallOrderInput.lines,
            subtotalMinor: 25_000,
            bundleDiscountMinor: 0,
            bundleLabel: null,
          },
          { recheck: true },
        ),
      ).rejects.toMatchObject({ reasonCode: "PROMO_NOT_APPLICABLE" });
    }

    // Outsider already had 1 interactive failure above; 4 more interactive failures reach 5 in 15m -> PROMO_ATTEMPTS_BLOCKED + WARN audit!
    for (let i = 2; i <= 4; i += 1) {
      const e = await previewAs(outsider, outsider.id, { code: `GUESS-000${i}` })
        .then(() => { throw new Error("expected rejection"); }, (err: unknown) => extractSafeError(err));
      expect(e.safe?.reasonCode).toBe("PROMO_NOT_APPLICABLE");
    }
    const fifthErr = await previewAs(outsider, outsider.id, { code: "GUESS-0005" })
      .then(() => { throw new Error("expected rejection"); }, (err: unknown) => extractSafeError(err));
    expect(fifthErr.safe?.reasonCode).toBe("PROMO_ATTEMPTS_BLOCKED");

    const blockedAudit = h.audit.events.find((e) => e.eventName === "promotion.attempts_blocked");
    expect(blockedAudit).toMatchObject({
      category: "security",
      severity: "WARN",
      outcome: "refused",
      reasonCode: "PROMO_ATTEMPTS_BLOCKED",
    });

    // Even a valid code is refused with PROMO_ATTEMPTS_BLOCKED during the 15-minute cooldown, then works after 15m01s!
    await adminCall.caller.admin.create({
      name: "Open Code",
      label: "Open 10%",
      type: "percent",
      percentBps: 1_000,
      scope: { kind: "all" },
      code: "OPEN-10-NOW",
    });

    const stillBlocked = await previewAs(outsider, outsider.id, { code: "OPEN-10-NOW" })
      .then(() => { throw new Error("expected rejection"); }, (err: unknown) => extractSafeError(err));
    expect(stillBlocked.safe?.reasonCode).toBe("PROMO_ATTEMPTS_BLOCKED");

    h.clock.advance(15 * 60 * 1000 + 1_000);
    const unblocked = await previewAs(outsider, outsider.id, { code: "OPEN-10-NOW" });
    expect(unblocked.promoDiscountMinor).toBe(500);
  });

  it("enforces atomic redemption under real MySQL concurrency: last redemption — exactly one wins", async () => {
    const admin = await seedUser({ email: "admin5@synthetic.test", role: "admin", stepUp: true });
    await callerFor(admin.principal).caller.admin.updateSettings({ enabled: true });

    // 1. Single shared code with `maxRedemptions = 1`: 5 customers race simultaneously on 5 pool connections.
    await callerFor(admin.principal).caller.admin.create({
      name: "Flash One Winner",
      label: "Flash Deal",
      type: "percent",
      percentBps: 2_000,
      maxRedemptions: 1,
      maxPerCustomer: 1,
      scope: { kind: "all" },
      code: "FLASH-ONE",
    });

    const racers = await Promise.all(
      Array.from({ length: 5 }, (_, idx) =>
        seedUser({ email: `racer${idx}@synthetic.test`, role: "customer" }),
      ),
    );

    const outcomes = await Promise.allSettled(
      racers.map((racer, idx) =>
        runWithRequestContext(
          newRequestContext("test"),
          () =>
            tdb.db.transaction((tx) =>
              mod.redeemInTx(tx, {
                code: "FLASH-ONE",
                customerUserId: racer.id,
                actorUserId: racer.id,
                currency: "USD",
                lines: [{ productPublicId: sampleProductA, packetNumber: 1, tierKey: "Basic", lineTotalMinor: 10_000 }],
                subtotalMinor: 10_000,
                bundleDiscountMinor: 0,
                bundleLabel: null,
                orderPublicId: ulid(),
                correlationId: `corr-race-${idx}`,
              }),
            ),
        ),
      ),
    );

    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const r of rejected) {
      const err = (r as PromiseRejectedResult).reason;
      expect(extractSafeError(err).safe?.reasonCode).toBe("PROMO_NOT_APPLICABLE");
    }

    const allRedemptions = await tdb.db.select().from(promoRedemptions);
    expect(allRedemptions).toHaveLength(1);

    // 2. Same customer racing `maxPerCustomer = 1` on an unlimited code: exactly one wins!
    await callerFor(admin.principal).caller.admin.create({
      name: "Unlimited Total, 1 Per Customer",
      label: "Once Per Account",
      type: "percent",
      percentBps: 1_000,
      maxRedemptions: null,
      maxPerCustomer: 1,
      scope: { kind: "all" },
      code: "ONCE-CUST",
    });

    const soloCustomer = await seedUser({ email: "solo@synthetic.test", role: "customer" });
    const sameCustRace = await Promise.allSettled(
      Array.from({ length: 4 }, (_, idx) =>
        tdb.db.transaction((tx) =>
          mod.redeemInTx(tx, {
            code: "ONCE-CUST",
            customerUserId: soloCustomer.id,
            actorUserId: soloCustomer.id,
            currency: "USD",
            lines: [{ productPublicId: sampleProductA, packetNumber: 1, tierKey: "Basic", lineTotalMinor: 10_000 }],
            subtotalMinor: 10_000,
            bundleDiscountMinor: 0,
            bundleLabel: null,
            orderPublicId: ulid(),
            correlationId: `corr-cust-${idx}`,
          }),
        ),
      ),
    );
    expect(sameCustRace.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(sameCustRace.filter((o) => o.status === "rejected")).toHaveLength(3);
  });

  it("generates idempotent CSPRNG single-use batches, neutralizes CSV formulas, and enforces G-C3-02 release fence", async () => {
    const admin = await seedUser({ email: "admin6@synthetic.test", role: "admin", stepUp: true });
    const alice = await seedUser({
      email: "alice6@synthetic.test",
      role: "customer",
      customerRef: "=CMD|' /C calc'!A0",
    });
    const bob = await seedUser({ email: "bob6@synthetic.test", role: "customer" });
    const adminCall = callerFor(admin.principal);
    await adminCall.caller.admin.updateSettings({ enabled: true });

    // Create batch promotion with formula-trigger name/label to test CSV neutralization too.
    const batchCreated = await adminCall.caller.admin.create({
      name: "=SUM(1,2) Batch",
      label: "+VIP Reward",
      type: "percent",
      percentBps: 1_500,
      maxPerCustomer: 1,
      scope: { kind: "all" },
      isBatch: true,
      codePrefix: "VIP26",
    });

    const gen1 = await adminCall.caller.admin.generateBatch({
      publicId: batchCreated.promotion.publicId,
      count: 25,
      idempotencyKey: "idem-batch-001",
    });
    expect(gen1.generated).toBe(25);
    expect(gen1.promotion.batchSize).toBe(25);

    // Idempotent replay with same `idempotencyKey` and `count` creates 0 duplicate codes; mismatched `count` conflicts.
    const genReplay = await adminCall.caller.admin.generateBatch({
      publicId: batchCreated.promotion.publicId,
      count: 25,
      idempotencyKey: "idem-batch-001",
    });
    expect(genReplay.generated).toBe(25);
    expect(genReplay.promotion.batchSize).toBe(25);

    const mismatchErr = await adminCall.caller.admin
      .generateBatch({
        publicId: batchCreated.promotion.publicId,
        count: 10,
        idempotencyKey: "idem-batch-001",
      })
      .then(() => { throw new Error("expected rejection"); }, (e: unknown) => extractSafeError(e));
    expect(mismatchErr.safe?.reasonCode).toBe("IDEMPOTENCY_KEY_MISMATCH");

    // Export codes CSV: verify unambiguous alphabet, >=12 random chars after prefix, `/promo#promo=` path, and formula neutralization.
    const exportedCodes = await adminCall.caller.admin.exportCodes({
      publicId: batchCreated.promotion.publicId,
    });
    expect(exportedCodes.rowCount).toBe(25);
    expect(exportedCodes.csv).toContain("\"'=SUM(1,2) Batch\"");
    expect(exportedCodes.csv).toContain("\"'+VIP Reward\"");

    const codeMatches = [...exportedCodes.csv.matchAll(/VIP26-([A-Z0-9]{12})/g)];
    expect(codeMatches).toHaveLength(50); // `code` column + `/promo#promo=` column per row
    const firstBatchCode = `VIP26-${codeMatches[0]![1]!}`;
    expect(exportedCodes.csv).toContain(`/promo#promo=${firstBatchCode}`);
    expect(exportedCodes.csv).not.toContain(`/#promo=${firstBatchCode}`);
    for (const ch of codeMatches[0]![1]!) {
      expect(PROMO_CODE_ALPHABET.includes(ch)).toBe(true);
    }

    // Alice redeems `firstBatchCode` on Order 1, then cancels unpaid before payment -> automatic release frees both the single-use code and Alice's customer slot!
    const order1PublicId = await seedOrderRow({ ownerUserId: alice.id, statusKey: "submitted" });
    await tdb.db.transaction((tx) =>
      mod.redeemInTx(tx, {
        code: firstBatchCode,
        customerUserId: alice.id,
        actorUserId: alice.id,
        currency: "USD",
        lines: [{ productPublicId: sampleProductA, packetNumber: 1, tierKey: "Basic", lineTotalMinor: 10_000 }],
        subtotalMinor: 10_000,
        bundleDiscountMinor: 0,
        bundleLabel: null,
        orderPublicId: order1PublicId,
        correlationId: "corr-ord-1",
      }),
    );

    // While redeemed, neither Bob (single-use code!) nor Alice (`maxPerCustomer = 1`) can redeem `firstBatchCode`.
    await expect(
      mod.preview({
        code: firstBatchCode,
        customerUserId: bob.id,
        actorUserId: bob.id,
        currency: "USD",
        lines: [{ productPublicId: sampleProductA, packetNumber: 1, tierKey: "Basic", lineTotalMinor: 10_000 }],
        subtotalMinor: 10_000,
        bundleDiscountMinor: 0,
        bundleLabel: null,
      }),
    ).rejects.toMatchObject({ reasonCode: "PROMO_NOT_APPLICABLE" });

    // Pre-payment cancel releases via `releaseForOrderInTx` -> Alice can now redeem again on Order 2!
    const relRes = await tdb.db.transaction((tx) =>
      mod.releaseForOrderInTx(tx, { orderPublicId: order1PublicId, reason: "order_cancelled" }),
    );
    expect(relRes).toEqual({ released: true });

    const order2PublicId = await seedOrderRow({ ownerUserId: alice.id, statusKey: "submitted" });
    await tdb.db.transaction((tx) =>
      mod.redeemInTx(tx, {
        code: firstBatchCode,
        customerUserId: alice.id,
        actorUserId: alice.id,
        currency: "USD",
        lines: [{ productPublicId: sampleProductA, packetNumber: 1, tierKey: "Basic", lineTotalMinor: 10_000 }],
        subtotalMinor: 10_000,
        bundleDiscountMinor: 0,
        bundleLabel: null,
        orderPublicId: order2PublicId,
        correlationId: "corr-ord-2",
      }),
    );

    const redemptionsPage = await adminCall.caller.admin.redemptions({
      promotionPublicId: batchCreated.promotion.publicId,
    });
    expect(redemptionsPage.items).toHaveLength(2);
    const activeRedemption = redemptionsPage.items.find((r) => r.status === "redeemed")!;

    // G-C3-02 Manual release fence (`admin.releaseRedemption`):
    // (a) Refused when order is NOT in a bound workflow terminal cancel state.
    const notCanceledErr = await adminCall.caller.admin
      .releaseRedemption({
        redemptionPublicId: activeRedemption.publicId,
        reason: "Invoice voided manually",
      })
      .then(() => { throw new Error("expected rejection"); }, (e: unknown) => extractSafeError(e));
    expect(notCanceledErr.safe?.reasonCode).toBe("REDEMPTION_RELEASE_NOT_ELIGIBLE");

    const customWorkflow: WorkflowDefinition = {
      states: [
        { key: "submitted", label: "Submitted", customerLabel: "Submitted", kind: "initial", tone: "neutral" },
        { key: "canceled", label: "Pending Cancel Review", customerLabel: "Cancel Review", kind: "active", tone: "warning" },
        { key: "cancelled_by_customer", label: "Cancelled", customerLabel: "Cancelled", kind: "terminal", tone: "danger" },
      ],
      transitions: [],
    };
    const [customWfIns] = await tdb.db.insert(orderWorkflowVersions).values({
      publicId: ulid(),
      workflowId: 2,
      versionNumber: 1,
      definition: customWorkflow,
    });
    const customWfVersionId = Number(customWfIns.insertId);

    // Custom NON-terminal `canceled` state is refused!
    await tdb.db
      .update(orders)
      .set({ workflowVersionId: customWfVersionId, statusKey: "canceled" })
      .where(eq(orders.publicId, order2PublicId));

    const nonTerminalErr = await adminCall.caller.admin
      .releaseRedemption({
        redemptionPublicId: activeRedemption.publicId,
        reason: "Invoice voided manually",
      })
      .then(() => { throw new Error("expected rejection"); }, (e: unknown) => extractSafeError(e));
    expect(nonTerminalErr.safe?.reasonCode).toBe("REDEMPTION_RELEASE_NOT_ELIGIBLE");

    // Move order2 to custom TERMINAL cancel state `cancelled_by_customer`.
    await tdb.db
      .update(orders)
      .set({ statusKey: "cancelled_by_customer" })
      .where(eq(orders.publicId, order2PublicId));

    // (b) Refused when compliance exposure port is absent (fail closed).
    const noPortErr = await adminCall.caller.admin
      .releaseRedemption({
        redemptionPublicId: activeRedemption.publicId,
        reason: "Invoice voided manually",
      })
      .then(() => { throw new Error("expected rejection"); }, (e: unknown) => extractSafeError(e));
    expect(noPortErr.safe?.reasonCode).toBe("REDEMPTION_RELEASE_NOT_ELIGIBLE");

    // (c) Refused when `grossPaidMinor > 0`, `payableInvoiceOpen`, `providerCapturePending`, or `providerAttemptEver`.
    let mockExposure = {
      grossPaidMinor: 5_000,
      payableInvoiceOpen: false,
      providerCapturePending: false,
      providerAttemptEver: false,
    };
    (h.services as unknown as Omit<Services, "compliance"> & { compliance: unknown }).compliance = {
      orderPaymentExposureInTx: async (_tx: Tx, pubId: string) => {
        expect(pubId).toBe(order2PublicId);
        return mockExposure;
      },
    };

    for (const blockedState of [
      { grossPaidMinor: 5_000, payableInvoiceOpen: false, providerCapturePending: false, providerAttemptEver: false },
      { grossPaidMinor: 0, payableInvoiceOpen: true, providerCapturePending: false, providerAttemptEver: false },
      { grossPaidMinor: 0, payableInvoiceOpen: false, providerCapturePending: true, providerAttemptEver: false },
      { grossPaidMinor: 0, payableInvoiceOpen: false, providerCapturePending: false, providerAttemptEver: true },
    ]) {
      mockExposure = blockedState;
      const e = await adminCall.caller.admin
        .releaseRedemption({
          redemptionPublicId: activeRedemption.publicId,
          reason: "Attempt release while exposed",
        })
        .then(() => { throw new Error("expected rejection"); }, (err: unknown) => extractSafeError(err));
      expect(e.safe?.reasonCode).toBe("REDEMPTION_RELEASE_NOT_ELIGIBLE");
    }

    // (d) Succeeds ONLY when order is in a terminal cancel state AND authoritative exposure is all-zero!
    mockExposure = {
      grossPaidMinor: 0,
      payableInvoiceOpen: false,
      providerCapturePending: false,
      providerAttemptEver: false,
    };
    const manualReleased = await adminCall.caller.admin.releaseRedemption({
      redemptionPublicId: activeRedemption.publicId,
      reason: "Voided draft invoice after pre-payment cancellation",
    });
    expect(manualReleased.status).toBe("released");
    expect(manualReleased.releaseReason).toBe("admin_manual_release");
    expect(manualReleased.releaseNote).toBe("Voided draft invoice after pre-payment cancellation");

    // Redemptions CSV export neutralizes Alice's formula-injected `customerRef`.
    const exportedRedemptions = await adminCall.caller.admin.exportRedemptions({
      promotionPublicId: batchCreated.promotion.publicId,
    });
    expect(exportedRedemptions.rowCount).toBe(2);
    expect(exportedRedemptions.csv).toContain("\"'=CMD|' /C calc'!A0\"");
  });

  it("reuses smallest free slot after non-last release, floors guard on tiny subtotals, suppresses zero-contribution redemptions, and enforces guardAttempt + non-consecutive 5-fail pause + IPv6 /64 normalization", async () => {
    const admin = await seedUser({ email: "admin7@synthetic.test", role: "admin", stepUp: true });
    const alice = await seedUser({ email: "alice7@synthetic.test", role: "customer" });
    const bob = await seedUser({ email: "bob7@synthetic.test", role: "customer" });
    const carol = await seedUser({ email: "carol7@synthetic.test", role: "customer" });
    const adminCall = callerFor(admin.principal);
    await adminCall.caller.admin.updateSettings({ enabled: true, maxDiscountPercent: 50 });

    // 1. Non-last release with cap >= 2 (`maxRedemptions = 2`, `maxPerCustomer = 2`):
    await adminCall.caller.admin.create({
      name: "Two Cap Promo",
      label: "Two Uses",
      type: "percent",
      percentBps: 1_000,
      maxRedemptions: 2,
      maxPerCustomer: 2,
      scope: { kind: "all" },
      code: "TWO-USES-26",
    });

    const ordA1 = await seedOrderRow({ ownerUserId: alice.id });
    const ordA2 = await seedOrderRow({ ownerUserId: alice.id });
    const ordA3 = await seedOrderRow({ ownerUserId: alice.id });

    for (const ordId of [ordA1, ordA2]) {
      await tdb.db.transaction((tx) =>
        mod.redeemInTx(tx, {
          code: "TWO-USES-26",
          customerUserId: alice.id,
          actorUserId: alice.id,
          currency: "USD",
          lines: [{ productPublicId: sampleProductA, packetNumber: 1, tierKey: "Basic", lineTotalMinor: 10_000 }],
          subtotalMinor: 10_000,
          bundleDiscountMinor: 0,
          bundleLabel: null,
          orderPublicId: ordId,
          correlationId: `corr-${ordId}`,
        }),
      );
    }

    // Release FIRST redemption (`ordA1`, slot 1), leaving `ordA2` occupying slot 2!
    const relFirst = await tdb.db.transaction((tx) =>
      mod.releaseForOrderInTx(tx, { orderPublicId: ordA1, reason: "order_cancelled" }),
    );
    expect(relFirst.released).toBe(true);

    // Redeem `ordA3`: must succeed by picking smallest free slot 1!
    const thirdRedeem = await tdb.db.transaction((tx) =>
      mod.redeemInTx(tx, {
        code: "TWO-USES-26",
        customerUserId: alice.id,
        actorUserId: alice.id,
        currency: "USD",
        lines: [{ productPublicId: sampleProductA, packetNumber: 1, tierKey: "Basic", lineTotalMinor: 10_000 }],
        subtotalMinor: 10_000,
        bundleDiscountMinor: 0,
        bundleLabel: null,
        orderPublicId: ordA3,
        correlationId: "corr-ordA3",
      }),
    );
    expect(thirdRedeem.promoDiscountMinor).toBe(1_000);

    // 2. Global 50% limit floors ($0.01 subtotal = 1 minor unit -> max guard is floor(0.5) = 0, rejecting 50% rounding up to 100%!).
    await adminCall.caller.admin.create({
      name: "50% Promo Under 50% Guard",
      label: "50% Promo",
      type: "percent",
      percentBps: 5_000,
      maxRedemptions: 1,
      maxPerCustomer: 1,
      combineWithBundle: false,
      scope: { kind: "all" },
      code: "FIFTY-26",
    });

    await expect(
      mod.preview({
        code: "FIFTY-26",
        customerUserId: bob.id,
        actorUserId: bob.id,
        currency: "USD",
        lines: [{ productPublicId: sampleProductA, packetNumber: 1, tierKey: "Basic", lineTotalMinor: 1 }],
        subtotalMinor: 1,
        bundleDiscountMinor: 0,
        bundleLabel: null,
      }),
    ).rejects.toMatchObject({ reasonCode: "PROMO_LIMIT_MAX_PERCENT" });

    // Bundle beats non-combinable 10% promo (bundle 2,000 vs promo 1,000): `redeemInTx` leaves code UNUSED!
    await adminCall.caller.admin.create({
      name: "Single Use 10%",
      label: "10% Code",
      type: "percent",
      percentBps: 1_000,
      maxRedemptions: 1,
      maxPerCustomer: 1,
      combineWithBundle: false,
      scope: { kind: "all" },
      code: "SINGLE-10",
    });

    const bundleWinsRedeem = await tdb.db.transaction((tx) =>
      mod.redeemInTx(tx, {
        code: "SINGLE-10",
        customerUserId: bob.id,
        actorUserId: bob.id,
        currency: "USD",
        lines: [{ productPublicId: sampleProductA, packetNumber: 1, tierKey: "Basic", lineTotalMinor: 10_000 }],
        subtotalMinor: 10_000,
        bundleDiscountMinor: 2_000,
        bundleLabel: "Bundle 20%",
        orderPublicId: ulid(),
        correlationId: "corr-bundle-wins",
      }),
    );
    expect(bundleWinsRedeem).toMatchObject({
      promoDiscountMinor: 0,
      bundleDiscountMinor: 2_000,
      discountMinor: 2_000,
      discountLabel: "Bundle 20%",
      totalMinor: 8_000,
    });

    // Because bundle won (`promoDiscountMinor === 0`), `SINGLE-10` still has its 1 redemption available!
    const bobUsesLater = await tdb.db.transaction((tx) =>
      mod.redeemInTx(tx, {
        code: "SINGLE-10",
        customerUserId: bob.id,
        actorUserId: bob.id,
        currency: "USD",
        lines: [{ productPublicId: sampleProductA, packetNumber: 1, tierKey: "Basic", lineTotalMinor: 10_000 }],
        subtotalMinor: 10_000,
        bundleDiscountMinor: 0,
        bundleLabel: null,
        orderPublicId: ulid(),
        correlationId: "corr-bob-real-use",
      }),
    );
    expect(bobUsesLater.promoDiscountMinor).toBe(1_000);

    // 3. `firstOrderOnly` refuses a customer who already had a historical order even if cancelled!
    await adminCall.caller.admin.create({
      name: "Strict First Order",
      label: "First Order 15%",
      type: "percent",
      percentBps: 1_500,
      firstOrderOnly: true,
      scope: { kind: "all" },
      code: "FIRST-STRICT",
    });
    await seedOrderRow({ ownerUserId: carol.id, statusKey: "canceled" });
    await expect(
      mod.preview({
        code: "FIRST-STRICT",
        customerUserId: carol.id,
        actorUserId: carol.id,
        currency: "USD",
        lines: [{ productPublicId: sampleProductA, packetNumber: 1, tierKey: "Basic", lineTotalMinor: 10_000 }],
        subtotalMinor: 10_000,
        bundleDiscountMinor: 0,
        bundleLabel: null,
      }),
    ).rejects.toMatchObject({ reasonCode: "PROMO_NOT_APPLICABLE" });

    // 4. Non-consecutive 5 failures in 15m across Orders (`guardAttempt` + rolled-back `tx`) and Cart (`preview` without `tx`),
    // plus concurrent first-row initialization and IPv6 `/64` `rateLimitAddress` normalization!
    const dave = await seedUser({ email: "dave7@synthetic.test", role: "customer" });

    const concurrentInit = await Promise.allSettled([
      runWithRequestContext(
        newRequestContext("test", { ipAddress: "2001:db8:abcd:1234::1" }),
        () =>
          mod.guardAttempt(dave.id, () =>
            tdb.db.transaction((tx) =>
              mod.redeemInTx(tx, {
                code: "WRONG-CODE-1",
                customerUserId: dave.id,
                actorUserId: dave.id,
                currency: "USD",
                lines: [{ productPublicId: sampleProductA, packetNumber: 1, tierKey: "Basic", lineTotalMinor: 10_000 }],
                subtotalMinor: 10_000,
                bundleDiscountMinor: 0,
                bundleLabel: null,
                orderPublicId: ulid(),
                correlationId: "corr-dave-1",
              }),
            ),
          ),
      ),
      runWithRequestContext(
        newRequestContext("test", { ipAddress: "2001:db8:abcd:1234::ffff" }),
        () =>
          mod.guardAttempt(dave.id, () =>
            tdb.db.transaction((tx) =>
              mod.preview(
                {
                  code: "WRONG-CODE-2",
                  customerUserId: dave.id,
                  actorUserId: dave.id,
                  currency: "USD",
                  lines: [{ productPublicId: sampleProductA, packetNumber: 1, tierKey: "Basic", lineTotalMinor: 10_000 }],
                  subtotalMinor: 10_000,
                  bundleDiscountMinor: 0,
                  bundleLabel: null,
                },
                { tx },
              ),
            ),
          ),
      ),
    ]);
    expect(concurrentInit.every((r) => r.status === "rejected")).toBe(true);

    // Verify IPv6 `/64` normalization mapped `::1` and `::ffff` to ONE shared `promo:ip:*` key!
    const ipLimiterKeys = h.rateLimiter.calls
      .map((c) => c.key)
      .filter((k) => k.startsWith("promo:ip:"));
    expect(ipLimiterKeys).toHaveLength(2);
    expect(ipLimiterKeys[0]).toBe(ipLimiterKeys[1]);

    // Failure #3 via Cart entrypoint (`preview` without `tx`), THEN a VALID preview — valid preview MUST NOT reset the 15m failure counter!
    await expect(
      mod.preview({
        code: "WRONG-CODE-3",
        customerUserId: dave.id,
        actorUserId: dave.id,
        currency: "USD",
        lines: [{ productPublicId: sampleProductA, packetNumber: 1, tierKey: "Basic", lineTotalMinor: 10_000 }],
        subtotalMinor: 10_000,
        bundleDiscountMinor: 0,
        bundleLabel: null,
      }),
    ).rejects.toMatchObject({ reasonCode: "PROMO_NOT_APPLICABLE" });

    const validBetweenFailures = await mod.preview({
      code: "FIFTY-26",
      customerUserId: dave.id,
      actorUserId: dave.id,
      currency: "USD",
      lines: [{ productPublicId: sampleProductA, packetNumber: 1, tierKey: "Basic", lineTotalMinor: 10_000 }],
      subtotalMinor: 10_000,
      bundleDiscountMinor: 0,
      bundleLabel: null,
    });
    expect(validBetweenFailures.promoDiscountMinor).toBe(5_000);

    // Failures #4 and #5 (via rolled-back `orders.create` under `guardAttempt`) -> #5 triggers `PROMO_ATTEMPTS_BLOCKED`!
    await expect(
      mod.guardAttempt(dave.id, () =>
        tdb.db.transaction((tx) =>
          mod.redeemInTx(tx, {
            code: "WRONG-CODE-4",
            customerUserId: dave.id,
            actorUserId: dave.id,
            currency: "USD",
            lines: [{ productPublicId: sampleProductA, packetNumber: 1, tierKey: "Basic", lineTotalMinor: 10_000 }],
            subtotalMinor: 10_000,
            bundleDiscountMinor: 0,
            bundleLabel: null,
            orderPublicId: ulid(),
            correlationId: "corr-dave-4",
          }),
        ),
      ),
    ).rejects.toMatchObject({ reasonCode: "PROMO_NOT_APPLICABLE" });

    await expect(
      mod.guardAttempt(dave.id, () =>
        tdb.db.transaction((tx) =>
          mod.redeemInTx(tx, {
            code: "WRONG-CODE-5",
            customerUserId: dave.id,
            actorUserId: dave.id,
            currency: "USD",
            lines: [{ productPublicId: sampleProductA, packetNumber: 1, tierKey: "Basic", lineTotalMinor: 10_000 }],
            subtotalMinor: 10_000,
            bundleDiscountMinor: 0,
            bundleLabel: null,
            orderPublicId: ulid(),
            correlationId: "corr-dave-5",
          }),
        ),
      ),
    ).rejects.toMatchObject({ reasonCode: "PROMO_ATTEMPTS_BLOCKED" });
  });

  describe("Increment 06 D5 — policy limits, two-decimal percent, set_total, allocation", () => {
    const lineFor = (lineTotalMinor: number, productPublicId = sampleProductA) => ({
      productPublicId,
      packetNumber: 1,
      tierKey: "Basic",
      lineTotalMinor,
    });

    it("parses legacy stored promotions.policy values with defaults and never throws", async () => {
      expect(parsePromotionsPolicy({ maxDiscountPercent: 50 })).toEqual({
        maxDiscountPercent: 50,
        maxFixedAmountMinor: null,
        allowZeroTotal: true,
        minOrderTotalAfterDiscountMinor: 0,
      });
      for (const legacy of [{}, null, undefined, "garbage", { maxDiscountPercent: "bad" }, { maxDiscountPercent: 0 }]) {
        expect(() => parsePromotionsPolicy(legacy)).not.toThrow();
        expect(parsePromotionsPolicy(legacy).allowZeroTotal).toBe(true);
      }
      expect(PROMOTIONS_POLICY_SETTING.schema.safeParse({ maxDiscountPercent: 50 }).success).toBe(true);
      expect(parsePromotionsPolicy({ maxDiscountPercent: 50.25 }).maxDiscountPercent).toBe(50.25);

      // Installed site upgraded in place: old row `{ maxDiscountPercent: 50 }` is read cleanly via getSettings.
      await tdb.db.insert(platformSettings).values({
        settingKey: PROMOTIONS_POLICY_SETTING.key,
        kind: "value",
        valueJson: { maxDiscountPercent: 50 },
      });
      const admin = await seedUser({ email: "admin-d5a@synthetic.test", role: "admin", stepUp: true });
      const s = await callerFor(admin.principal).caller.admin.getSettings();
      expect(s).toMatchObject({
        maxDiscountPercent: 50,
        maxDiscountBps: 5_000,
        maxFixedAmountMinor: null,
        allowZeroTotal: true,
        minOrderTotalAfterDiscountMinor: 0,
      });
    });

    it("supports two-decimal percent, set_total test orders, fixed-zero hint, limit rejections, and canReachZero", async () => {
      const admin = await seedUser({ email: "admin-d5b@synthetic.test", role: "admin", stepUp: true });
      const alice = await seedUser({ email: "alice-d5b@synthetic.test", role: "customer" });
      const adminCall = callerFor(admin.principal);
      await adminCall.caller.admin.updateSettings({ enabled: true, maxDiscountPercent: 50.25 });
      expect((await adminCall.caller.admin.getSettings()).maxDiscountBps).toBe(5_025);

      const ctx = (code: string, subtotal: number) => ({
        code,
        customerUserId: alice.id,
        actorUserId: alice.id,
        currency: "USD",
        lines: [lineFor(subtotal)],
        subtotalMinor: subtotal,
        bundleDiscountMinor: 0,
        bundleLabel: null,
      });

      // 50.25% code is allowed at 50.25% limit; 10,000 * 50.25% = 5,025.
      await adminCall.caller.admin.create({
        name: "Two decimal", label: "Two decimal", type: "percent", percentBps: 5_025,
        scope: { kind: "all" }, code: "TWODEC-5025",
      });
      expect((await mod.preview(ctx("TWODEC-5025", 10_000))).discountMinor).toBe(5_025);

      // 0.01% on 10,000 = 1 (half-up of exactly 1.0).
      await adminCall.caller.admin.create({
        name: "Tiny", label: "Tiny percent", type: "percent", percentBps: 1,
        scope: { kind: "all" }, code: "TINY-0001",
      });
      expect((await mod.preview(ctx("TINY-0001", 10_000))).discountMinor).toBe(1);

      // 50.26% exceeds limit at creation.
      const over = await adminCall.caller.admin
        .create({ name: "Over", label: "Over", type: "percent", percentBps: 5_026, scope: { kind: "all" }, code: "OVER-5026" })
        .then(() => { throw new Error("expected"); }, (e: unknown) => extractSafeError(e));
      expect(over.safe?.reasonCode).toBe("PROMO_LIMIT_MAX_PERCENT");
      expect(over.safe?.details?.limitsHref).toBe("/admin/promotions#limits");

      await adminCall.caller.admin.updateSettings({ maxDiscountPercent: 100 });

      // Fixed 0 -> hint to use set_total.
      const zeroFixed = await adminCall.caller.admin
        .create({ name: "Zero fixed", label: "Zero fixed", type: "fixed", amountMinor: 0, currency: "USD", scope: { kind: "all" }, code: "ZERO-FIXED" })
        .then(() => { throw new Error("expected"); }, (e: unknown) => extractSafeError(e));
      expect(zeroFixed.safe?.reasonCode).toBe("PROMO_ZERO_FIXED_USE_SET_TOTAL");

      // set_total $0.00 and $0.01.
      const zeroCreated = await adminCall.caller.admin.create({
        name: "Test order zero", label: "Test order", type: "set_total", setTotalMinor: 0,
        currency: "USD", scope: { kind: "all" }, code: "SETZERO-01", maxPerCustomer: 5,
      });
      expect(zeroCreated.promotion.canReachZero).toBe(true);
      expect(zeroCreated.promotion.setTotalMinor).toBe(0);
      const zeroOutcome = await mod.preview(ctx("SETZERO-01", 12_345));
      expect(zeroOutcome).toMatchObject({ discountMinor: 12_345, totalMinor: 0 });
      expect(zeroOutcome.discountLabel.length).toBeGreaterThan(0);

      const pennyCreated = await adminCall.caller.admin.create({
        name: "Test order penny", label: "Penny order", type: "set_total", setTotalMinor: 1,
        currency: "USD", scope: { kind: "all" }, code: "SETPENNY-01",
      });
      expect(pennyCreated.promotion.canReachZero).toBe(false);
      expect(await mod.preview(ctx("SETPENNY-01", 12_345))).toMatchObject({ discountMinor: 12_344, totalMinor: 1 });

      // set_total above subtotal -> PROMO_MIN_SUBTOTAL.
      const below = await mod
        .preview({ ...ctx("SETPENNY-01", 1), lines: [lineFor(1)], subtotalMinor: 1 })
        .then((o) => o, (e: unknown) => extractSafeError(e));
      // subtotal 1 == setTotal 1 is allowed (discount 0); set_total $10 on $5 cart -> PROMO_MIN_SUBTOTAL.
      expect(below).toMatchObject({ totalMinor: 1 });
      await adminCall.caller.admin.create({
        name: "Ten total", label: "Ten total", type: "set_total", setTotalMinor: 1_000,
        currency: "USD", scope: { kind: "all" }, code: "SETTEN-01",
      });
      const shortErr = await mod
        .preview(ctx("SETTEN-01", 500))
        .then(() => { throw new Error("expected"); }, (e: unknown) => extractSafeError(e));
      expect(shortErr.safe?.reasonCode).toBe("PROMO_MIN_SUBTOTAL");
      expect(shortErr.safe?.details?.shortfallMinor).toBe(500);

      // Percent canReachZero: 100% true, 99.99% false.
      const p100 = await adminCall.caller.admin.create({ name: "P100", label: "P100", type: "percent", percentBps: 10_000, scope: { kind: "all" }, code: "PCT-10000" });
      const p9999 = await adminCall.caller.admin.create({ name: "P9999", label: "P9999", type: "percent", percentBps: 9_999, scope: { kind: "all" }, code: "PCT-9999" });
      expect(p100.promotion.canReachZero).toBe(true);
      expect(p9999.promotion.canReachZero).toBe(false);
      const list = await adminCall.caller.admin.list({});
      expect(list.items.find((i) => i.publicId === zeroCreated.promotion.publicId)?.canReachZero).toBe(true);

      // allowZeroTotal = false: preview of zero-capable code rejects; creating a new zero-capable code rejects.
      await adminCall.caller.admin.updateSettings({ allowZeroTotal: false });
      const custZero = await mod
        .preview(ctx("SETZERO-01", 5_000))
        .then(() => { throw new Error("expected"); }, (e: unknown) => extractSafeError(e));
      expect(custZero.safe?.reasonCode).toBe("PROMO_LIMIT_ZERO_TOTAL");
      expect(custZero.safe?.details?.limit).toBe("allowZeroTotal");
      expect(custZero.safe?.details?.limitsHref).toBeUndefined();
      const createZero = await adminCall.caller.admin
        .create({ name: "Z2", label: "Z2", type: "set_total", setTotalMinor: 0, currency: "USD", scope: { kind: "all" }, code: "SETZERO-02" })
        .then(() => { throw new Error("expected"); }, (e: unknown) => extractSafeError(e));
      expect(createZero.safe?.reasonCode).toBe("PROMO_LIMIT_ZERO_TOTAL");
      await adminCall.caller.admin.updateSettings({ allowZeroTotal: true });

      // minOrderTotalAfterDiscountMinor.
      await adminCall.caller.admin.updateSettings({ minOrderTotalAfterDiscountMinor: 500 });
      const minTotal = await mod
        .preview(ctx("SETPENNY-01", 5_000))
        .then(() => { throw new Error("expected"); }, (e: unknown) => extractSafeError(e));
      expect(minTotal.safe?.reasonCode).toBe("PROMO_LIMIT_MIN_TOTAL");
      expect(minTotal.safe?.details?.limit).toBe("minOrderTotalAfterDiscountMinor");
      await adminCall.caller.admin.updateSettings({ minOrderTotalAfterDiscountMinor: 0 });

      // maxFixedAmountMinor.
      await adminCall.caller.admin.create({ name: "F30", label: "Thirty off", type: "fixed", amountMinor: 3_000, currency: "USD", scope: { kind: "all" }, code: "FIXED-3000" });
      await adminCall.caller.admin.updateSettings({ maxFixedAmountMinor: 2_000 });
      const fixedOver = await mod
        .preview(ctx("FIXED-3000", 10_000))
        .then(() => { throw new Error("expected"); }, (e: unknown) => extractSafeError(e));
      expect(fixedOver.safe?.reasonCode).toBe("PROMO_LIMIT_MAX_FIXED");
      expect(fixedOver.safe?.details?.limit).toBe("maxFixedAmountMinor");
      const fixedCreateOver = await adminCall.caller.admin
        .create({ name: "F25", label: "Twenty five off", type: "fixed", amountMinor: 2_500, currency: "USD", scope: { kind: "all" }, code: "FIXED-2500" })
        .then(() => { throw new Error("expected"); }, (e: unknown) => extractSafeError(e));
      expect(fixedCreateOver.safe?.reasonCode).toBe("PROMO_LIMIT_MAX_FIXED");

      const settingsEvents = h.audit.events.filter((e) => e.eventName === "promotion.settings_updated");
      expect(settingsEvents.length).toBeGreaterThanOrEqual(6);
    });

    it("rejects set_total when an ineligible line is mixed in", async () => {
      const admin = await seedUser({ email: "admin-d5c@synthetic.test", role: "admin", stepUp: true });
      const alice = await seedUser({ email: "alice-d5c@synthetic.test", role: "customer" });
      const adminCall = callerFor(admin.principal);
      await adminCall.caller.admin.updateSettings({ enabled: true });
      await adminCall.caller.admin.create({
        name: "Scoped set", label: "Scoped set", type: "set_total", setTotalMinor: 0, currency: "USD",
        scope: { kind: "products", productPublicIds: [sampleProductA] }, code: "SCOPED-SET",
      });
      const other = ulid();
      const err = await mod
        .preview({
          code: "SCOPED-SET", customerUserId: alice.id, actorUserId: alice.id, currency: "USD",
          lines: [lineFor(5_000), lineFor(3_000, other)], subtotalMinor: 8_000, bundleDiscountMinor: 0, bundleLabel: null,
        })
        .then(() => { throw new Error("expected"); }, (e: unknown) => extractSafeError(e));
      expect(err.safe?.reasonCode).toBe("PROMO_NOT_ELIGIBLE_ITEMS");
    });

    it("property test: single half-up rounding and allocation invariants over seeded random carts", () => {
      expect(roundHalfUpBps(1, 5_000)).toBe(1);
      expect(roundHalfUpBps(3, 3_333)).toBe(1);
      expect(allocateMinorAcrossCapacities(200, [100, 100, 1])).toEqual([99, 100, 1]);
      expect(allocateMinorAcrossCapacities(1_000, [1_000, 1_000, 1_000])).toEqual([333, 333, 334]);

      let seed = 0x5eed_d5;
      const rnd = (n: number) => {
        seed = (seed * 1_103_515_245 + 12_345) & 0x7fff_ffff;
        return seed % n;
      };
      const types = ["percent", "fixed", "set_total"] as const;
      for (let iter = 0; iter < 800; iter += 1) {
        const n = 1 + rnd(8);
        const lines = Array.from({ length: n }, (_, i) => ({
          productPublicId: `P${i}`,
          packetNumber: 1,
          tierKey: "basic",
          lineTotalMinor: rnd(4) === 0 ? 1 : 1 + rnd(50_000),
        }));
        if (iter === 0) {
          lines.splice(0, lines.length, ...[100, 100, 1].map((v, i) => ({ productPublicId: `P${i}`, packetNumber: 1, tierKey: "basic", lineTotalMinor: v })));
        }
        const subtotal = lines.reduce((a, l) => a + l.lineTotalMinor, 0);
        const type = types[rnd(3)]!;
        const scoped = type !== "set_total" && rnd(3) === 0;
        const mask = lines.map((_, i) => !scoped || i % 2 === 0);
        const bundle = rnd(3) === 0 ? rnd(subtotal + 1) : 0;
        const setTotal = iter === 0 ? 1 : rnd(subtotal + 1);
        const outcome = computePromotionPricing(
          {
            publicId: "PROMO",
            label: "Label",
            discountType: type,
            percentBps: type === "percent" ? 1 + rnd(10_000) : null,
            maxDiscountMinor: type === "percent" && rnd(2) === 0 ? 1 + rnd(subtotal) : null,
            fixedAmountMinor: type === "fixed" ? 1 + rnd(subtotal * 2) : null,
            setTotalMinor: type === "set_total" ? setTotal : null,
            combineWithBundle: rnd(2) === 0,
            scopeKind: scoped ? "products" : "all",
          },
          { lines, subtotalMinor: subtotal, bundleDiscountMinor: bundle, bundleLabel: "Bundle" },
          mask,
        );
        const allocs = outcome.lineAllocations!;
        expect(outcome.totalMinor).toBeGreaterThanOrEqual(0);
        expect(outcome.totalMinor).toBe(subtotal - outcome.discountMinor);
        expect(outcome.discountMinor).toBe(outcome.bundleDiscountMinor + outcome.promoDiscountMinor);
        expect(outcome.discountLabel.trim().length).toBeGreaterThan(0);
        expect(allocs.reduce((a, l) => a + l.discountMinor, 0)).toBe(outcome.discountMinor);
        expect(allocs.reduce((a, l) => a + l.netMinor, 0)).toBe(outcome.totalMinor);
        expect(allocs.reduce((a, l) => a + l.promoDiscountMinor, 0)).toBe(outcome.promoDiscountMinor);
        for (const [i, a] of allocs.entries()) {
          expect(a.netMinor).toBeGreaterThanOrEqual(0);
          expect(a.discountMinor).toBeGreaterThanOrEqual(0);
          expect(a.discountMinor).toBeLessThanOrEqual(a.grossMinor);
          if (!mask[i]) expect(a.promoDiscountMinor).toBe(0);
        }
        if (type === "set_total" && bundle <= subtotal - setTotal) {
          // Never below target unless bundle alone already went below it.
          expect(outcome.totalMinor).toBeGreaterThanOrEqual(
            Math.min(setTotal, subtotal - outcome.bundleDiscountMinor),
          );
        }
        if (iter === 0) {
          expect(allocs.map((a) => a.netMinor).every((v) => v >= 0)).toBe(true);
        }
      }
    });
  });

  it("Increment 09 D2.2/D2.6: registers promotions TrashParticipant, excludes trashed/tombstoned orders & customers from lists/exports/checks, and keeps redemption counts as numbers on purge", async () => {
    const registry = createTrashRegistry();
    (h.services as unknown as { trash: typeof registry }).trash = registry;
    mod.init?.();
    const participant = registry.participants().find((p) => p.module === "promotions");
    expect(participant).toBeDefined();

    const admin = await seedUser({ email: "admin-inc09@synthetic.test", role: "admin", stepUp: true });
    const zeus = await seedUser({
      email: "zeus.greene@synthetic.test",
      role: "customer",
      customerRef: "RPCUS-A1B2CJJG5",
    });
    const liveCust = await seedUser({
      email: "live.cust@synthetic.test",
      role: "customer",
      customerRef: "RPCUS-LIVE00001",
    });

    const adminCall = callerFor(admin.principal);
    await adminCall.caller.admin.updateSettings({ enabled: true, maxDiscountPercent: 50 });

    const created = await adminCall.caller.admin.create({
      name: "Ice Queen Launch",
      label: "Launch 10%",
      type: "percent",
      percentBps: 1_000,
      maxRedemptions: 10,
      maxPerCustomer: 2,
      allowCustomerPublicIds: [zeus.publicId, liveCust.publicId],
      scope: { kind: "all" },
      code: "ICEQUEEN10",
    });

    const ordZeus = await seedOrderRow({ ownerUserId: zeus.id });
    const ordLive = await seedOrderRow({ ownerUserId: liveCust.id });

    await tdb.db.transaction((tx) =>
      mod.redeemInTx(tx, {
        code: "ICEQUEEN10",
        customerUserId: zeus.id,
        actorUserId: zeus.id,
        currency: "USD",
        lines: [{ productPublicId: sampleProductA, packetNumber: 1, tierKey: "Basic", lineTotalMinor: 10_000 }],
        subtotalMinor: 10_000,
        bundleDiscountMinor: 0,
        bundleLabel: null,
        orderPublicId: ordZeus,
        correlationId: "corr-zeus-inc09",
      }),
    );
    await tdb.db.transaction((tx) =>
      mod.redeemInTx(tx, {
        code: "ICEQUEEN10",
        customerUserId: liveCust.id,
        actorUserId: liveCust.id,
        currency: "USD",
        lines: [{ productPublicId: sampleProductA, packetNumber: 1, tierKey: "Basic", lineTotalMinor: 10_000 }],
        subtotalMinor: 10_000,
        bundleDiscountMinor: 0,
        bundleLabel: null,
        orderPublicId: ordLive,
        correlationId: "corr-live-inc09",
      }),
    );

    // Seed check-attempt row and a release note on Zeus's redemption to verify purge scrubbing.
    await tdb.db.insert(promoCheckAttempts).values({
      userId: zeus.id,
      failedCount: 2,
      windowStartedAt: h.clock.now(),
      blockedUntil: null,
    });
    await tdb.db
      .update(promoRedemptions)
      .set({ releaseNote: "Operator note mentioning Ice Queen" })
      .where(eq(promoRedemptions.orderPublicId, ordZeus));

    // Move Zeus and Zeus's order to trash -> absent from admin redemptions list/export and ineligible for checks.
    const trashedAt = h.clock.now();
    await tdb.db
      .update(orders)
      .set({ trashedAt, trashBatchId: "01JTRASHBATCHZEUS000000001" })
      .where(eq(orders.publicId, ordZeus));
    await tdb.db
      .update(users)
      .set({ status: "suspended", trashedAt, trashBatchId: "01JTRASHBATCHZEUS000000001" })
      .where(eq(users.id, zeus.id));

    await expect(
      mod.preview({
        code: "ICEQUEEN10",
        customerUserId: zeus.id,
        actorUserId: zeus.id,
        currency: "USD",
        lines: [{ productPublicId: sampleProductA, packetNumber: 1, tierKey: "Basic", lineTotalMinor: 10_000 }],
        subtotalMinor: 10_000,
        bundleDiscountMinor: 0,
        bundleLabel: null,
      }),
    ).rejects.toMatchObject({ reasonCode: "PROMO_NOT_APPLICABLE" });

    const listedWhileTrashed = await adminCall.caller.admin.redemptions({
      promotionPublicId: created.promotion.publicId,
    });
    expect(listedWhileTrashed.items).toHaveLength(1);
    expect(listedWhileTrashed.items[0]?.orderPublicId).toBe(ordLive);

    const exportedWhileTrashed = await adminCall.caller.admin.exportRedemptions({
      promotionPublicId: created.promotion.publicId,
    });
    expect(exportedWhileTrashed.rowCount).toBe(1);
    expect(exportedWhileTrashed.csv).not.toContain(ordZeus);
    expect(exportedWhileTrashed.csv).not.toContain("RPCUS-A1B2CJJG5");

    // Summarize + permanent purge (order then customer, matching coordinator order).
    const [ordRow] = await tdb.db.select().from(orders).where(eq(orders.publicId, ordZeus));
    const ordSummary = await participant!.summarize!({
      kind: "order",
      id: ordRow!.id,
      publicId: ordZeus,
      batchId: "01JTRASHBATCHZEUS000000001",
    });
    expect(ordSummary).toEqual({ promoRedemptions: 1 });

    const ordPurge = await participant!.purge!(
      { kind: "order", id: ordRow!.id, publicId: ordZeus, batchId: "01JTRASHBATCHZEUS000000001" },
      { runId: "01JPURGERUNZEUS00000000001" },
    );
    expect(ordPurge.deleted).toEqual({ promoReleaseNotes: 1 });
    expect(ordPurge.kept).toEqual({ promoRedemptions: 1 });

    const custPurge = await participant!.purge!(
      { kind: "customer", id: zeus.id, publicId: zeus.publicId, batchId: "01JTRASHBATCHZEUS000000001" },
      { runId: "01JPURGERUNZEUS00000000001" },
    );
    expect(custPurge.deleted).toEqual({
      promoCheckAttempts: 1,
      promoAllowListEntries: 1,
    });
    expect(custPurge.kept).toEqual({ promoRedemptions: 1 });

    // Idempotent retry:
    const custPurgeRetry = await participant!.purge!(
      { kind: "customer", id: zeus.id, publicId: zeus.publicId, batchId: "01JTRASHBATCHZEUS000000001" },
      { runId: "01JPURGERUNZEUS00000000001" },
    );
    expect(custPurgeRetry.deleted).toEqual({});
    expect(custPurgeRetry.kept).toEqual({ promoRedemptions: 1 });

    // Verify numeric redemption counts stay as numbers!
    const [batchAfter] = await tdb.db
      .select()
      .from(promoBatches)
      .where(eq(promoBatches.publicId, created.promotion.publicId));
    expect(batchAfter?.redemptionCount).toBe(2);
    expect(batchAfter?.allowCustomerPublicIds).toEqual([liveCust.publicId]);

    const [codeAfter] = await tdb.db
      .select()
      .from(promoCodes)
      .where(eq(promoCodes.batchId, batchAfter!.id));
    expect(codeAfter?.redemptionCount).toBe(2);

    const statsAfter = await adminCall.caller.admin.stats({
      promotionPublicId: created.promotion.publicId,
    });
    expect(statsAfter.redemptions).toBe(2);

    const [zeusRedemptionAfter] = await tdb.db
      .select()
      .from(promoRedemptions)
      .where(eq(promoRedemptions.orderPublicId, ordZeus));
    expect(zeusRedemptionAfter?.releaseNote).toBeNull();
  });
});
