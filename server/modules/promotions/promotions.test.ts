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

    // Anonymous refused everywhere.
    await expect(anon.caller.admin.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      anon.caller.check({
        code: "WINTER26",
        currency: "USD",
        lines: [{ productPublicId: sampleProductA, packetNumber: 1, tierKey: "Basic", lineTotalMinor: 10_000 }],
        subtotalMinor: 10_000,
        bundleDiscountMinor: 0,
        bundleLabel: null,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

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
    const aliceCall = callerFor(alice.principal);

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
    expect(settingsDefault).toEqual({ enabled: false, maxDiscountPercent: 50 });

    const offErr = await aliceCall.caller
      .check({
        code: "WELCOME-10",
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

    const ok = await aliceCall.caller.check({
      code: "  welcome-10 ",
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

    // 2. Combinable 80% promo + 10% bundle capped by the global 50% guard (never exceeds 50% = 5,000 minor units).
    await adminCall.caller.admin.create({
      name: "Combinable 80%",
      label: "VIP 80%",
      type: "percent",
      percentBps: 8_000,
      scope: { kind: "all" },
      combineWithBundle: true,
      code: "VIP-80-COMB",
    });

    const guardCapped = await mod.preview({
      code: "VIP-80-COMB",
      customerUserId: alice.id,
      actorUserId: alice.id,
      currency: "USD",
      lines: [{ productPublicId: sampleProductA, packetNumber: 1, tierKey: "Basic", lineTotalMinor: 10_000 }],
      subtotalMinor: 10_000,
      bundleDiscountMinor: 1_000,
      bundleLabel: "Bundle 10%",
    });
    expect(guardCapped).toMatchObject({
      bundleDiscountMinor: 1_000,
      promoDiscountMinor: 4_000,
      discountMinor: 5_000,
      totalMinor: 5_000,
    });

    // Raising global guard to 90% allows full combined discount (1,000 bundle + 80% of remaining 9,000 = 7,200 -> 8,200).
    await adminCall.caller.admin.updateSettings({ maxDiscountPercent: 90 });
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

    // Outsider (wrong domain) with $50 cart -> uniform PROMO_NOT_APPLICABLE (NOT PROMO_MIN_SUBTOTAL!).
    const outsiderCall = callerFor(outsider.principal);
    const outErr = await outsiderCall.caller
      .check(smallOrderInput)
      .then(() => { throw new Error("expected rejection"); }, (e: unknown) => extractSafeError(e));
    expect(outErr.safe).toMatchObject({
      reasonCode: "PROMO_NOT_APPLICABLE",
      safeMessage: "This code cannot be applied.",
    });

    // Unverified e-mail customer on @partner.org -> uniform PROMO_NOT_APPLICABLE!
    const unverifiedCall = callerFor(unverified.principal);
    const unvErr = await unverifiedCall.caller
      .check(smallOrderInput)
      .then(() => { throw new Error("expected rejection"); }, (e: unknown) => extractSafeError(e));
    expect(unvErr.safe?.reasonCode).toBe("PROMO_NOT_APPLICABLE");

    // Staff self-redemption -> uniform PROMO_NOT_APPLICABLE; staff checking ON BEHALF of insider -> PROMO_MIN_SUBTOTAL!
    const staffCall = callerFor(staff.principal);
    const staffSelfErr = await staffCall.caller
      .check(smallOrderInput)
      .then(() => { throw new Error("expected rejection"); }, (e: unknown) => extractSafeError(e));
    expect(staffSelfErr.safe?.reasonCode).toBe("PROMO_NOT_APPLICABLE");

    const staffForInsiderErr = await staffCall.caller
      .check({ ...smallOrderInput, customerPublicId: insider.publicId })
      .then(() => { throw new Error("expected rejection"); }, (e: unknown) => extractSafeError(e));
    expect(staffForInsiderErr.safe?.reasonCode).toBe("PROMO_MIN_SUBTOTAL");

    // IDOR: outsider attempting to check using insider's `customerPublicId` is refused with FORBIDDEN!
    await expect(
      outsiderCall.caller.check({ ...smallOrderInput, customerPublicId: insider.publicId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // First-order-only: once insider has a non-canceled order, insider receives uniform PROMO_NOT_APPLICABLE.
    await seedOrderRow({ ownerUserId: insider.id, statusKey: "submitted" });
    const insiderCall = callerFor(insider.principal);
    const notFirstErr = await insiderCall.caller
      .check({ ...smallOrderInput, subtotalMinor: 25_000, lines: [{ productPublicId: sampleProductA, packetNumber: 1, tierKey: "Basic", lineTotalMinor: 25_000 }] })
      .then(() => { throw new Error("expected rejection"); }, (e: unknown) => extractSafeError(e));
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
      const e = await outsiderCall.caller
        .check({ ...smallOrderInput, code: `GUESS-000${i}` })
        .then(() => { throw new Error("expected rejection"); }, (err: unknown) => extractSafeError(err));
      expect(e.safe?.reasonCode).toBe("PROMO_NOT_APPLICABLE");
    }
    const fifthErr = await outsiderCall.caller
      .check({ ...smallOrderInput, code: "GUESS-0005" })
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

    const stillBlocked = await outsiderCall.caller
      .check({ ...smallOrderInput, code: "OPEN-10-NOW" })
      .then(() => { throw new Error("expected rejection"); }, (err: unknown) => extractSafeError(err));
    expect(stillBlocked.safe?.reasonCode).toBe("PROMO_ATTEMPTS_BLOCKED");

    h.clock.advance(15 * 60 * 1000 + 1_000);
    const unblocked = await outsiderCall.caller.check({
      ...smallOrderInput,
      code: "OPEN-10-NOW",
    });
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

    // 2. Global 50% guard floors ($0.01 subtotal = 1 minor unit -> max guard is floor(0.5) = 0, never 100%!).
    await adminCall.caller.admin.create({
      name: "100% Promo Under 50% Guard",
      label: "100% Promo",
      type: "percent",
      percentBps: 10_000,
      maxRedemptions: 1,
      maxPerCustomer: 1,
      combineWithBundle: false,
      scope: { kind: "all" },
      code: "HUNDRED-26",
    });

    const oneCentPreview = await mod.preview({
      code: "HUNDRED-26",
      customerUserId: bob.id,
      actorUserId: bob.id,
      currency: "USD",
      lines: [{ productPublicId: sampleProductA, packetNumber: 1, tierKey: "Basic", lineTotalMinor: 1 }],
      subtotalMinor: 1,
      bundleDiscountMinor: 0,
      bundleLabel: null,
    });
    expect(oneCentPreview).toMatchObject({
      promoDiscountMinor: 0,
      discountMinor: 0,
      discountLabel: "",
      totalMinor: 1,
    });

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
      code: "HUNDRED-26",
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
});
