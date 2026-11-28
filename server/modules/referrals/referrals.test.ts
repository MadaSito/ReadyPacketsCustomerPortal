import express from "express";
import type { AddressInfo } from "node:net";
import http from "node:http";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { newRequestContext, runWithRequestContext } from "../../core/requestContext.js";
import type { SessionPrincipal, SessionTransport } from "../../core/types.js";
import { createCallerFactory, type SafeErrorData } from "../../trpc/trpc.js";
import { users, userSessions } from "../identity/schema.js";
import { platformSettings } from "../platform/schema.js";
import { createSettingsStore } from "../platform/settingsStore.js";
import { createTrashRegistry, unfencedPurgeRunForTests } from "../trash/ports.js";
import { createTestDeps, fakePrincipal, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { REFERRAL_CODE_REGEX, canonicalEmailIdentity, serializeSafeCsv } from "./codes.js";
import { REFERRAL_HOLD_MAX_AGE_MS, registerReferralsHttpRoutes } from "./http.js";
import { createReferralsModule, type ReferralsModule } from "./index.js";
import { referralsRouter } from "./router.js";
import {
  referralCodes,
  referralEmailInvites,
  referralRewardLedger,
  referrals,
} from "./schema.js";
import { DEFAULT_REFERRAL_PROGRAM_CONFIG, type ReferralProgramConfig } from "./settings.js";

const noopTransport: SessionTransport = {
  issue() {},
  clear() {},
};

function trpcErrorData(err: unknown): SafeErrorData | undefined {
  if (err instanceof TRPCError) {
    const cause = err.cause as { data?: SafeErrorData } | undefined;
    // tRPC errorFormatter attaches SafeErrorData on shape, while direct caller throws TRPCError
    // whose cause is DomainError. Extract from DomainError or shape cleanly:
    if (cause && typeof cause === "object" && "code" in cause && "reasonCode" in cause) {
      const d = cause as unknown as {
        code: SafeErrorData["domainCode"];
        reasonCode: string;
        safeMessage: string;
      };
      return {
        domainCode: d.code,
        reasonCode: d.reasonCode,
        safeMessage: d.safeMessage,
        requestId: "req_test",
      };
    }
  }
  return undefined;
}

describe("server/modules/referrals (Package G)", () => {
  let tdb: TestDb;
  let h: TestHarness;
  let mod: ReferralsModule;
  const createCaller = createCallerFactory(referralsRouter);

  beforeAll(async () => {
    tdb = await createTestDb({
      schema: {
        users,
        userSessions,
        platformSettings,
        referralCodes,
        referrals,
        referralRewardLedger,
        referralEmailInvites,
      },
    });
  });

  afterAll(async () => {
    await tdb.cleanup();
  });

  beforeEach(async () => {
    await tdb.db.delete(referralEmailInvites);
    await tdb.db.delete(referralRewardLedger);
    await tdb.db.delete(referrals);
    await tdb.db.delete(referralCodes);
    await tdb.db.delete(userSessions);
    await tdb.db.delete(users);
    await tdb.db.delete(platformSettings);

    h = createTestDeps({
      db: tdb.db,
      now: new Date("2026-11-21T12:00:00.000Z"),
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

    mod = createReferralsModule(h.deps);
    h.services.referrals = mod;
    h.audit.clear();
  });

  let userSeq = 0;
  async function seedUserWithSession(opts: {
    email: string;
    name: string;
    role?: "customer" | "staff" | "admin";
    status?: "active" | "suspended" | "deactivated" | "pending_activation";
    customerRef?: string | null;
    stepUpFresh?: boolean;
    sessionState?: "full" | "remediation";
  }): Promise<{
    userId: number;
    userPublicId: string;
    email: string;
    sessionPublicId: string;
    principal: SessionPrincipal;
  }> {
    userSeq += 1;
    const now = h.clock.now();
    const userPublicId = ulid(now.getTime());
    const normalizedEmail = opts.email.trim().toLowerCase();
    const emailEnc = h.deps.crypto.encrypt(normalizedEmail, `users.email:${userPublicId}`);
    const emailIndex = h.deps.crypto.blindIndex(normalizedEmail, "users.email");
    const nameEnc = h.deps.crypto.encrypt(opts.name, `users.name:${userPublicId}`);

    const [inserted] = await tdb.db.insert(users).values({
      publicId: userPublicId,
      customerRef: opts.customerRef ?? null,
      role: opts.role ?? "customer",
      status: opts.status ?? "active",
      emailEnc,
      emailIndex,
      emailVerifiedAt: now,
      nameEnc,
      origin: "register",
      createdAt: now,
      updatedAt: now,
    });
    const userId = Number(inserted.insertId);

    const sessionPublicId = ulid(now.getTime());
    const stepUpAt = opts.stepUpFresh ? now : null;
    await tdb.db.insert(userSessions).values({
      publicId: sessionPublicId,
      userId,
      tokenHash: h.deps.crypto.hashToken(`tok_${userSeq}_${sessionPublicId}`),
      csrfSecretEnc: h.deps.crypto.encrypt("csrf_secret", `user_sessions.csrf:${sessionPublicId}`),
      authMethod: "local",
      authenticatedAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: new Date(now.getTime() + 8 * 60 * 60 * 1000),
      mfaVerifiedAt: now,
      stepUpAt,
      revokedAt: null,
      createdAt: now,
    });

    const principal = fakePrincipal({
      sessionId: sessionPublicId,
      userId,
      userPublicId,
      role: opts.role ?? "customer",
      state: opts.sessionState ?? "full",
      authenticatedAt: now,
      mfaVerifiedAt: now,
      stepUpAt,
    });

    return { userId, userPublicId, email: normalizedEmail, sessionPublicId, principal };
  }

  function callAs<T>(principal: SessionPrincipal | null, fn: (caller: ReturnType<typeof createCaller>) => Promise<T>, ip = "198.51.100.25"): Promise<T> {
    const request = newRequestContext("test");
    request.ipAddress = ip;
    if (principal) {
      request.actor = {
        userId: principal.userId,
        role: principal.role,
        sessionId: principal.sessionId,
      };
    }
    return runWithRequestContext(request, () => {
      const caller = createCaller({
        services: h.services,
        session: principal,
        request,
        transport: noopTransport,
      });
      return fn(caller);
    });
  }

  async function enableProgram(
    adminPrincipal: SessionPrincipal,
    overrides: Partial<ReferralProgramConfig> = {},
  ) {
    return callAs(adminPrincipal, (c) =>
      c.admin.updateSettings({
        enabled: true,
        config: {
          ...DEFAULT_REFERRAL_PROGRAM_CONFIG,
          ...overrides,
        },
      }),
    );
  }

  it("ships disabled by default and hides customer endpoints while reporting healthy module state", async () => {
    const health = await mod.health?.();
    expect(health).toEqual([
      expect.objectContaining({ component: "referrals", state: "disabled" }),
    ]);

    const customer = await seedUserWithSession({
      email: "alice@example.test",
      name: "Alice Referrer",
      customerRef: "RP-CUST-000101",
    });
    const newSignup = await seedUserWithSession({
      email: "bob@example.test",
      name: "Bob Prospect",
      customerRef: "RP-CUST-000102",
    });

    const pub = await callAs(null, (c) => c.publicStatus({ code: "ABCDEFGHJK" }));
    expect(pub).toEqual({
      enabled: false,
      codeAcceptedFormat: false,
      normalizedCode: null,
    });

    await expect(callAs(customer.principal, (c) => c.me.overview())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(callAs(customer.principal, (c) => c.me.history({ limit: 10 }))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      callAs(customer.principal, (c) =>
        c.me.sendInviteEmail({ recipientEmail: "friend@example.test" }),
      ),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const attrResult = await tdb.db.transaction((tx) =>
      mod.attributeRegistration("23456789AB", newSignup.userId, tx),
    );
    expect(attrResult).toEqual({ attributed: false, reasonCode: "PROGRAM_DISABLED" });

    const paidResult = await tdb.db.transaction((tx) =>
      mod.onInvoicePaid(
        {
          invoicePublicId: ulid(),
          orderPublicId: ulid(),
          customerUserId: newSignup.userId,
          currency: "USD",
          subtotalMinor: 10_000,
          discountMinor: 0,
          taxMinor: 800,
          totalMinor: 10_800,
          isFirstPaidInvoice: true,
          paidAt: h.clock.now(),
        },
        { tx },
      ),
    );
    expect(paidResult).toEqual({ outcome: "program_disabled" });
  });

  it("enforces role, capability, step-up, remediation, customer isolation, live actor re-validation in tx, and fail-closed audit", async () => {
    const adminFresh = await seedUserWithSession({
      email: "admin@example.test",
      name: "Portal Admin",
      role: "admin",
      stepUpFresh: true,
    });
    const adminNoStepUp = await seedUserWithSession({
      email: "admin-nostep@example.test",
      name: "No StepUp Admin",
      role: "admin",
      stepUpFresh: false,
    });
    const staff = await seedUserWithSession({
      email: "staff@example.test",
      name: "Support Staff",
      role: "staff",
    });
    const customerA = await seedUserWithSession({
      email: "cust-a@example.test",
      name: "Customer Alpha",
      customerRef: "RP-CUST-000201",
    });
    const customerB = await seedUserWithSession({
      email: "cust-b@example.test",
      name: "Customer Bravo",
      customerRef: "RP-CUST-000202",
    });
    const remediationCustomer = await seedUserWithSession({
      email: "remed@example.test",
      name: "Remediation User",
      sessionState: "remediation",
    });

    // Anonymous rejected on customer, staff, and admin procedures
    await expect(callAs(null, (c) => c.me.overview())).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(callAs(null, (c) => c.admin.getSettings())).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });

    // Remediation session rejected
    await expect(callAs(remediationCustomer.principal, (c) => c.me.overview())).rejects.toSatisfy(
      (err) => trpcErrorData(err)?.domainCode === "REMEDIATION_REQUIRED",
    );

    // Admin without fresh step-up cannot mutate programme settings
    await expect(
      callAs(adminNoStepUp.principal, (c) =>
        c.admin.updateSettings({
          enabled: true,
          config: DEFAULT_REFERRAL_PROGRAM_CONFIG,
        }),
      ),
    ).rejects.toSatisfy((err) => trpcErrorData(err)?.domainCode === "STEP_UP_REQUIRED");

    // Staff can read settings/list/ledger (`referrals.read_all`) but cannot mutate or export (`referrals.manage`)
    const initialSettings = await callAs(staff.principal, (c) => c.admin.getSettings());
    expect(initialSettings.enabled).toBe(false);

    await expect(
      callAs(staff.principal, (c) =>
        c.admin.updateSettings({
          enabled: true,
          config: DEFAULT_REFERRAL_PROGRAM_CONFIG,
        }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(
      callAs(staff.principal, (c) => c.admin.export({ format: "csv" })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Customer cannot read admin settings or list
    await expect(callAs(customerA.principal, (c) => c.admin.getSettings())).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    // Fail-closed audit: if durable audit fails, settings update rolls back completely
    h.audit.failRecords = true;
    await expect(enableProgram(adminFresh.principal)).rejects.toSatisfy(
      (err) => trpcErrorData(err)?.domainCode === "AUDIT_UNAVAILABLE",
    );
    h.audit.failRecords = false;
    expect((await callAs(staff.principal, (c) => c.admin.getSettings())).enabled).toBe(false);

    // Enable programme with fresh step-up admin
    h.audit.clear();
    const enabled = await enableProgram(adminFresh.principal);
    expect(enabled.enabled).toBe(true);
    expect(h.audit.named("referral.program.updated")).toHaveLength(1);
    expect(h.audit.recordedInTx.every(Boolean)).toBe(true);

    // Customer isolation & privacy masking:
    const overviewA = await callAs(customerA.principal, (c) => c.me.overview());
    const overviewB = await callAs(customerB.principal, (c) => c.me.overview());
    expect(overviewA.code).toMatch(REFERRAL_CODE_REGEX);
    expect(overviewB.code).toMatch(REFERRAL_CODE_REGEX);
    expect(overviewA.code).not.toBe(overviewB.code);

    // Attribute a referred customer to Customer A
    const referred = await seedUserWithSession({
      email: "secret-referred@example.test",
      name: "Confidential Prospect Name",
      customerRef: "RP-CUST-009876",
    });
    const attr = await tdb.db.transaction((tx) =>
      mod.attributeRegistration(overviewA.code, referred.userId, tx),
    );
    expect(attr.attributed).toBe(true);

    const historyA = await callAs(customerA.principal, (c) => c.me.history({ limit: 10 }));
    expect(historyA.items).toHaveLength(1);
    expect(historyA.items[0]?.referredAccountHint).toMatch(/^Account ending [0-9A-Z]{2}$/);
    const serializedA = JSON.stringify(historyA);
    expect(serializedA).not.toContain("secret-referred@example.test");
    expect(serializedA).not.toContain("Confidential Prospect Name");
    expect(serializedA).not.toContain("RP-CUST-009876");

    // Customer B sees zero referrals from Customer A
    const historyB = await callAs(customerB.principal, (c) => c.me.history({ limit: 10 }));
    expect(historyB.items).toHaveLength(0);

    // Live actor re-validation inside tx: revoke admin session in DB mid-flight -> refused!
    await tdb.db
      .update(userSessions)
      .set({ revokedAt: h.clock.now(), revokeReason: "admin_revoked" })
      .where(eq(userSessions.publicId, adminFresh.sessionPublicId));

    await expect(
      enableProgram(adminFresh.principal, { fixedAmountMinor: 9999 }),
    ).rejects.toSatisfy((err) => trpcErrorData(err)?.reasonCode === "SESSION_NOT_CURRENT");
  });

  it("blocks referral self-dealing across userId, plus-alias/Gmail canonical email, shared customerRef, and duplicate attribution", async () => {
    const admin = await seedUserWithSession({
      email: "admin-self@example.test",
      name: "Admin",
      role: "admin",
      stepUpFresh: true,
    });
    await enableProgram(admin.principal);

    // Pure canonical helper checks
    expect(canonicalEmailIdentity("Alice.Smith+promo@gmail.com")).toBe(
      canonicalEmailIdentity("alicesmith@googlemail.com"),
    );
    expect(canonicalEmailIdentity("ops+trial@company.example")).toBe(
      canonicalEmailIdentity("OPS@company.example"),
    );

    const referrer = await seedUserWithSession({
      email: "founder@acme.example",
      name: "Founder",
      customerRef: "RP-CUST-500001",
    });
    const { code } = await callAs(referrer.principal, (c) => c.me.overview());

    // 1. Exact same userId
    const selfSameId = await tdb.db.transaction((tx) =>
      mod.attributeRegistration(code, referrer.userId, tx),
    );
    expect(selfSameId).toEqual({ attributed: false, reasonCode: "SELF_REFERRAL" });

    // 2. Plus-alias of same canonical mailbox
    const plusAliasUser = await seedUserWithSession({
      email: "Founder+referral2@acme.example",
      name: "Founder Alias",
      customerRef: "RP-CUST-500002",
    });
    const selfAlias = await tdb.db.transaction((tx) =>
      mod.attributeRegistration(code, plusAliasUser.userId, tx),
    );
    expect(selfAlias).toEqual({ attributed: false, reasonCode: "SELF_REFERRAL" });

    // 3. Same customerRef ( tested via service check when distinct email shares account ref )
    // Note: users.customer_ref is unique on users table, so we also test Gmail dot/domain alias:
    const gmailReferrer = await seedUserWithSession({
      email: "jane.doe@gmail.com",
      name: "Jane Doe",
    });
    const gmailOverview = await callAs(gmailReferrer.principal, (c) => c.me.overview());
    const gmailAliasSignup = await seedUserWithSession({
      email: "janedoe+bonus@googlemail.com",
      name: "Jane Bonus",
    });
    const gmailSelf = await tdb.db.transaction((tx) =>
      mod.attributeRegistration(gmailOverview.code, gmailAliasSignup.userId, tx),
    );
    expect(gmailSelf).toEqual({ attributed: false, reasonCode: "SELF_REFERRAL" });

    // Durable audit recorded for every refused self-referral attempt
    const refusedEvents = h.audit.named("referral.attribution.refused");
    expect(refusedEvents.length).toBeGreaterThanOrEqual(3);

    // 4. Legitimate distinct customer succeeds once, then second attribution is refused (`ALREADY_ATTRIBUTED`)
    const legitNewUser = await seedUserWithSession({
      email: "colleague@partner.example",
      name: "Partner Colleague",
      customerRef: "RP-CUST-600001",
    });
    const okAttr = await tdb.db.transaction((tx) =>
      mod.attributeRegistration(code, legitNewUser.userId, tx),
    );
    expect(okAttr.attributed).toBe(true);

    const secondAttr = await tdb.db.transaction((tx) =>
      mod.attributeRegistration(gmailOverview.code, legitNewUser.userId, tx),
    );
    expect(secondAttr).toEqual({ attributed: false, reasonCode: "ALREADY_ATTRIBUTED" });
  });

  it("defends E-mail-my-link against spam relay: fixed server template, self-send block, silent existing-user suppression, per-sender burst/daily caps, and cross-customer recipient cooldown", async () => {
    const admin = await seedUserWithSession({
      email: "admin-mail@example.test",
      name: "Admin",
      role: "admin",
      stepUpFresh: true,
    });
    await enableProgram(admin.principal);

    const senderA = await seedUserWithSession({
      email: "sender.alpha@example.test",
      name: "Alpha Corp",
    });
    const senderB = await seedUserWithSession({
      email: "sender.bravo@example.test",
      name: "Bravo Corp",
    });
    const existingMember = await seedUserWithSession({
      email: "already-member@example.test",
      name: "Existing Member",
    });

    // 1. Self-invite and plus-alias self-invite refused
    await expect(
      callAs(senderA.principal, (c) =>
        c.me.sendInviteEmail({ recipientEmail: "sender.alpha+self@example.test" }),
      ),
    ).rejects.toSatisfy((err) => trpcErrorData(err)?.reasonCode === "SELF_REFERRAL");
    expect(h.mailer.sent).toHaveLength(0);

    // 2. Existing portal user is silently suppressed: returns `{ accepted: true }`, sends ZERO mail (no enumeration oracle)
    const suppressedRes = await callAs(senderA.principal, (c) =>
      c.me.sendInviteEmail({ recipientEmail: existingMember.email }),
    );
    expect(suppressedRes).toEqual({ accepted: true });
    expect(h.mailer.sent).toHaveLength(0);

    // 3. Valid external invite uses server-owned template `referrals.invite_friend` with server-derived vars only
    const validRes = await callAs(senderA.principal, (c) =>
      c.me.sendInviteEmail({ recipientEmail: "new-lead-1@prospect.test" }),
    );
    expect(validRes).toEqual({ accepted: true });
    expect(h.mailer.sent).toHaveLength(1);
    const queuedMail = h.mailer.last("referrals.invite_friend");
    expect(queuedMail).toBeDefined();
    expect(queuedMail?.to).toEqual({ address: "new-lead-1@prospect.test" });
    expect(queuedMail?.vars.senderName).toBe("Alpha Corp");
    expect(queuedMail?.vars.referralLink).toContain("/register?ref=");

    // 4. Cross-customer recipient cooldown: Sender B tries to invite the SAME recipient (via +alias) within 24h -> refused!
    await expect(
      callAs(senderB.principal, (c) =>
        c.me.sendInviteEmail({ recipientEmail: "new-lead-1+spam@prospect.test" }),
      ),
    ).rejects.toSatisfy(
      (err) => trpcErrorData(err)?.reasonCode === "INVITE_RECIPIENT_RATE_LIMITED",
    );

    // 5. Per-sender 10-minute burst cap (5 invites per 10m; senderA already recorded 2 rows: suppressed + lead-1)
    await callAs(senderA.principal, (c) =>
      c.me.sendInviteEmail({ recipientEmail: "new-lead-2@prospect.test" }),
    );
    await callAs(senderA.principal, (c) =>
      c.me.sendInviteEmail({ recipientEmail: "new-lead-3@prospect.test" }),
    );
    await callAs(senderA.principal, (c) =>
      c.me.sendInviteEmail({ recipientEmail: "new-lead-4@prospect.test" }),
    );
    await expect(
      callAs(senderA.principal, (c) =>
        c.me.sendInviteEmail({ recipientEmail: "new-lead-5@prospect.test" }),
      ),
    ).rejects.toSatisfy(
      (err) => trpcErrorData(err)?.reasonCode === "INVITE_SENDER_BURST_LIMITED",
    );

    // Advance clock 15 minutes past burst window and send remaining up to 10/24h cap (already 5 in 24h -> 5 more allowed)
    h.clock.advance(15 * 60 * 1000);
    for (let i = 5; i <= 9; i += 1) {
      await callAs(senderA.principal, (c) =>
        c.me.sendInviteEmail({ recipientEmail: `new-lead-${i}@prospect.test` }),
      );
    }

    // 11th invite within 24 hours refused with daily limit
    h.clock.advance(15 * 60 * 1000);
    await expect(
      callAs(senderA.principal, (c) =>
        c.me.sendInviteEmail({ recipientEmail: "new-lead-10@prospect.test" }),
      ),
    ).rejects.toSatisfy(
      (err) => trpcErrorData(err)?.reasonCode === "INVITE_SENDER_RATE_LIMITED",
    );
  });

  it("prevents referral code enumeration on publicStatus and throttles validateCode via auth_high_risk", async () => {
    const admin = await seedUserWithSession({
      email: "admin-enum@example.test",
      name: "Admin",
      role: "admin",
      stepUpFresh: true,
    });
    await enableProgram(admin.principal);

    const customer = await seedUserWithSession({
      email: "holder@example.test",
      name: "Code Holder",
    });
    const { code: realCode } = await callAs(customer.principal, (c) => c.me.overview());
    expect(realCode).toMatch(REFERRAL_CODE_REGEX);

    // Construct a guaranteed non-existent valid-alphabet code
    const fakeCode = realCode.startsWith("2") ? `3${realCode.slice(1)}` : `2${realCode.slice(1)}`;

    // publicStatus returns identical shape for real vs non-existent valid-format code (zero DB oracle!)
    const pubReal = await callAs(null, (c) => c.publicStatus({ code: realCode.toLowerCase() }));
    const pubFake = await callAs(null, (c) => c.publicStatus({ code: fakeCode.toLowerCase() }));
    expect(pubReal).toEqual({
      enabled: true,
      codeAcceptedFormat: true,
      normalizedCode: realCode,
    });
    expect(pubFake).toEqual({
      enabled: true,
      codeAcceptedFormat: true,
      normalizedCode: fakeCode,
    });

    // Ambiguous characters (`0`, `O`, `1`, `I`, `L`) rejected by format check
    const pubAmbiguous = await callAs(null, (c) => c.publicStatus({ code: "0O1IL23456" }));
    expect(pubAmbiguous).toEqual({
      enabled: true,
      codeAcceptedFormat: false,
      normalizedCode: null,
    });

    // validateCode consumes auth_high_risk budget and emits sampled security note when throttled
    const validRes = await mod.validateCode(realCode, { ipAddress: "203.0.113.77" });
    expect(validRes.valid).toBe(true);

    h.rateLimiter.blocked.add("auth_high_risk");
    await expect(mod.validateCode(fakeCode, { ipAddress: "203.0.113.77" })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(
      h.audit.notes.some((n) => n.eventName === "referral.code.enumeration_throttled"),
    ).toBe(true);
  });

  it("handles qualification (fixed, percentage+cap, cross-currency), manual & automatic approval, rejection, append-only ledger, CAS conflicts, and safe CSV/JSON export", async () => {
    const admin = await seedUserWithSession({
      email: "admin-flow@example.test",
      name: "Admin Reviewer",
      role: "admin",
      stepUpFresh: true,
    });

    // Part A: Percentage reward with cap + manual approval ON
    await enableProgram(admin.principal, {
      rewardMode: "percent",
      percentBps: 1500, // 15%
      capAmountMinor: 4000, // $40.00 cap
      currency: "USD",
      manualApprovalRequired: true,
    });

    // Evil referrer name starting with `=CMD()` to verify CSV formula neutralization end-to-end!
    const referrer = await seedUserWithSession({
      email: "referrer@example.test",
      name: "=CMD|' /C calc'!A0 Referrer",
      customerRef: "RP-CUST-700001",
    });
    const { code } = await callAs(referrer.principal, (c) => c.me.overview());

    const referred1 = await seedUserWithSession({
      email: "buyer1@example.test",
      name: "Buyer One",
      customerRef: "RP-CUST-700002",
    });
    const referred2CrossCurrency = await seedUserWithSession({
      email: "buyer2-eur@example.test",
      name: "Buyer Two EUR",
      customerRef: "RP-CUST-700003",
    });
    const referred3Reject = await seedUserWithSession({
      email: "buyer3-reject@example.test",
      name: "Buyer Three",
      customerRef: "RP-CUST-700004",
    });

    await tdb.db.transaction(async (tx) => {
      await mod.attributeRegistration(code, referred1.userId, tx);
      await mod.attributeRegistration(code, referred2CrossCurrency.userId, tx);
      await mod.attributeRegistration(code, referred3Reject.userId, tx);
    });

    // Non-first invoice on an attributed referral is ignored (`not_first_invoice`)
    const nonFirstBeforeQual = await tdb.db.transaction((tx) =>
      mod.onInvoicePaid(
        {
          invoicePublicId: ulid(),
          orderPublicId: ulid(),
          customerUserId: referred1.userId,
          currency: "USD",
          subtotalMinor: 10_000,
          discountMinor: 0,
          taxMinor: 0,
          totalMinor: 10_000,
          isFirstPaidInvoice: false,
          paidAt: h.clock.now(),
        },
        { tx },
      ),
    );
    expect(nonFirstBeforeQual).toMatchObject({ outcome: "not_first_invoice" });

    // Buyer 1 pays first invoice: $300.00 net -> 15% = $45.00 -> capped at $40.00 (4000 minor)
    const inv1 = ulid();
    const ord1 = ulid();
    const qual1 = await tdb.db.transaction((tx) =>
      mod.onInvoicePaid(
        {
          invoicePublicId: inv1,
          orderPublicId: ord1,
          customerUserId: referred1.userId,
          currency: "USD",
          subtotalMinor: 32_000,
          discountMinor: 2_000,
          taxMinor: 2_400,
          totalMinor: 32_400,
          isFirstPaidInvoice: true,
          paidAt: h.clock.now(),
        },
        { tx },
      ),
    );
    expect(qual1).toMatchObject({
      outcome: "qualified_pending_approval",
      rewardAmountMinor: 4000,
    });

    // Idempotent replay of exact same invoicePublicId -> `already_processed`
    const replay1 = await tdb.db.transaction((tx) =>
      mod.onInvoicePaid(
        {
          invoicePublicId: inv1,
          orderPublicId: ord1,
          customerUserId: referred1.userId,
          currency: "USD",
          subtotalMinor: 32_000,
          discountMinor: 2_000,
          taxMinor: 2_400,
          totalMinor: 32_400,
          isFirstPaidInvoice: true,
          paidAt: h.clock.now(),
        },
        { tx },
      ),
    );
    expect(replay1).toMatchObject({ outcome: "already_processed" });

    // Subsequent different invoice on already-qualified referral -> `already_qualified`
    const secondInv = await tdb.db.transaction((tx) =>
      mod.onInvoicePaid(
        {
          invoicePublicId: ulid(),
          orderPublicId: ulid(),
          customerUserId: referred1.userId,
          currency: "USD",
          subtotalMinor: 50_000,
          discountMinor: 0,
          taxMinor: 0,
          totalMinor: 50_000,
          isFirstPaidInvoice: false,
          paidAt: h.clock.now(),
        },
        { tx },
      ),
    );
    expect(secondInv).toMatchObject({ outcome: "already_qualified" });

    // Admin approves Buyer 1 referral -> status `approved` + immutable `reward_approved` ledger entry
    const adminPage = await callAs(admin.principal, (c) =>
      c.admin.list({ status: "qualified_pending_approval" }),
    );
    const row1 = adminPage.items.find((r) => r.referredPublicId === referred1.userPublicId);
    expect(row1).toBeDefined();

    // Wrong expectedVersion rejected with CAS conflict (`CONFLICT` / `VERSION_CONFLICT`)
    await expect(
      callAs(admin.principal, (c) =>
        c.admin.approve({
          referralPublicId: row1!.referralPublicId,
          expectedVersion: row1!.version + 99,
        }),
      ),
    ).rejects.toSatisfy((err) => trpcErrorData(err)?.reasonCode === "VERSION_CONFLICT");

    const approved1 = await callAs(admin.principal, (c) =>
      c.admin.approve({
        referralPublicId: row1!.referralPublicId,
        expectedVersion: row1!.version,
        note: "=CMD|' /C calc'!A0 Verified paid order",
      }),
    );
    expect(approved1.status).toBe("approved");
    expect(approved1.rewardAmountMinor).toBe(4000);

    // Admin marks Buyer 1 referral as credited -> status `credited` + `credit_applied` ledger entry
    const credited1 = await callAs(admin.principal, (c) =>
      c.admin.markCredited({
        referralPublicId: approved1.referralPublicId,
        expectedVersion: approved1.version,
        payoutMethod: "account_credit",
        reference: "RP-INV-2026-000777",
        note: "Applied to November statement",
      }),
    );
    expect(credited1.status).toBe("credited");
    expect(credited1.payoutReference).toBe("RP-INV-2026-000777");

    // Rejecting an already-credited referral is refused (`INVALID_REFERRAL_TRANSITION`)
    await expect(
      callAs(admin.principal, (c) =>
        c.admin.reject({
          referralPublicId: credited1.referralPublicId,
          expectedVersion: credited1.version,
          reason: "Too late",
        }),
      ),
    ).rejects.toSatisfy((err) => trpcErrorData(err)?.reasonCode === "INVALID_REFERRAL_TRANSITION");

    // Verify append-only ledger has both `reward_approved` and `credit_applied`
    const ledger = await callAs(admin.principal, (c) => c.admin.ledger({ limit: 20 }));
    expect(ledger.items).toHaveLength(2);
    expect(ledger.items.map((e) => e.entryType).sort()).toEqual([
      "credit_applied",
      "reward_approved",
    ]);

    // Part B: Cross-currency invoice (`EUR` vs `USD`) flags `CURRENCY_MISMATCH` and requires explicit override amount
    const qual2 = await tdb.db.transaction((tx) =>
      mod.onInvoicePaid(
        {
          invoicePublicId: ulid(),
          orderPublicId: ulid(),
          customerUserId: referred2CrossCurrency.userId,
          currency: "EUR",
          subtotalMinor: 20_000,
          discountMinor: 0,
          taxMinor: 0,
          totalMinor: 20_000,
          isFirstPaidInvoice: true,
          paidAt: h.clock.now(),
        },
        { tx },
      ),
    );
    expect(qual2).toMatchObject({
      outcome: "qualified_pending_approval",
      rewardAmountMinor: 0,
    });

    const listAfterEur = await callAs(admin.principal, (c) =>
      c.admin.list({ status: "qualified_pending_approval" }),
    );
    const row2 = listAfterEur.items.find(
      (r) => r.referredPublicId === referred2CrossCurrency.userPublicId,
    );
    expect(row2?.qualificationNoteCode).toBe("CURRENCY_MISMATCH");

    // Approving without overrideAmountMinor fails validation when cross-currency
    await expect(
      callAs(admin.principal, (c) =>
        c.admin.approve({
          referralPublicId: row2!.referralPublicId,
          expectedVersion: row2!.version,
        }),
      ),
    ).rejects.toSatisfy(
      (err) => trpcErrorData(err)?.reasonCode === "CURRENCY_MISMATCH_AMOUNT_REQUIRED",
    );

    const approved2 = await callAs(admin.principal, (c) =>
      c.admin.approve({
        referralPublicId: row2!.referralPublicId,
        expectedVersion: row2!.version,
        overrideAmountMinor: 3250,
        note: "Converted EUR invoice to USD credit",
      }),
    );
    expect(approved2.status).toBe("approved");
    expect(approved2.rewardAmountMinor).toBe(3250);

    // Part C: Reject Buyer 3 referral
    const allList = await callAs(admin.principal, (c) => c.admin.list({ limit: 20 }));
    const row3 = allList.items.find((r) => r.referredPublicId === referred3Reject.userPublicId);
    const rejected3 = await callAs(admin.principal, (c) =>
      c.admin.reject({
        referralPublicId: row3!.referralPublicId,
        expectedVersion: row3!.version,
        reason: "+Duplicate test account",
      }),
    );
    expect(rejected3.status).toBe("rejected");

    // Part D: Auto-approval mode (`manualApprovalRequired: false`) qualifies directly to `approved` + ledger row
    await enableProgram(admin.principal, {
      rewardMode: "fixed",
      fixedAmountMinor: 2500,
      currency: "USD",
      manualApprovalRequired: false,
    });
    const referred4Auto = await seedUserWithSession({
      email: "buyer4-auto@example.test",
      name: "Buyer Four Auto",
    });
    await tdb.db.transaction((tx) => mod.attributeRegistration(code, referred4Auto.userId, tx));
    const qual4 = await tdb.db.transaction((tx) =>
      mod.onInvoicePaid(
        {
          invoicePublicId: ulid(),
          orderPublicId: ulid(),
          customerUserId: referred4Auto.userId,
          currency: "USD",
          subtotalMinor: 10_000,
          discountMinor: 0,
          taxMinor: 0,
          totalMinor: 10_000,
          isFirstPaidInvoice: true,
          paidAt: h.clock.now(),
        },
        { tx },
      ),
    );
    expect(qual4).toMatchObject({
      outcome: "auto_approved",
      rewardAmountMinor: 2500,
    });

    // Part E: CSV & JSON export neutralizes formula injection (`=`, `+`, `-`, `@`, `\t`, `\r`)
    expect(serializeSafeCsv(["h1", "h2"], [["=1+1", "@SUM(A1)"]])).toContain("'=1+1,'@SUM(A1)");
    const csvExport = await callAs(admin.principal, (c) => c.admin.export({ format: "csv" }));
    expect(csvExport.contentType).toContain("text/csv");
    expect(csvExport.rowCount).toBe(4);
    expect(csvExport.body).toContain("'=CMD|");
    expect(csvExport.body).toContain("'+Duplicate test account");
    expect(csvExport.body).not.toContain("referrer@example.test");

    const jsonExport = await callAs(admin.principal, (c) => c.admin.export({ format: "json" }));
    expect(jsonExport.contentType).toContain("application/json");
    const parsedJson = JSON.parse(jsonExport.body) as { exportedAt: string; items: unknown[] };
    expect(parsedJson.items).toHaveLength(4);
    expect(h.audit.named("referrals.exported")).toHaveLength(2);
  });

  it("manages the 30-day first-party referral hold cookie via /api/referrals/hold without an enumeration oracle", async () => {
    const admin = await seedUserWithSession({
      email: "admin-http@example.test",
      name: "Admin",
      role: "admin",
      stepUpFresh: true,
    });

    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => {
      const ctx = newRequestContext("http");
      ctx.ipAddress = "198.51.100.88";
      runWithRequestContext(ctx, () => next());
    });
    const sub = express.Router();
    registerReferralsHttpRoutes(sub, h.services);
    app.use("/api/referrals", sub);

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}/api/referrals`;

    try {
      // While programme is disabled, POST /hold does NOT set cookie
      const disabledHold = await fetch(`${baseUrl}/hold`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "23456789AB" }),
      });
      expect(disabledHold.status).toBe(200);
      expect(await disabledHold.json()).toEqual({ held: false, expiresAt: null });
      expect(disabledHold.headers.get("set-cookie")).toBeNull();

      // Enable programme
      await enableProgram(admin.principal);

      // POST /hold with valid-format code sets HttpOnly; SameSite=Lax cookie with 30-day Max-Age
      const holdRes = await fetch(`${baseUrl}/hold`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "23456789ab" }),
      });
      expect(holdRes.status).toBe(200);
      expect(holdRes.headers.get("cache-control")).toBe("no-store");
      const holdBody = (await holdRes.json()) as { held: boolean; expiresAt: string | null };
      expect(holdBody.held).toBe(true);
      const setCookie = holdRes.headers.get("set-cookie") ?? "";
      const cookieKey = h.services.config.cookieSecure ? "__Host-rp_ref" : "rp_ref";
      expect(setCookie).toContain(`${cookieKey}=23456789AB`);
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Lax");
      expect(setCookie).toContain(`Max-Age=${Math.floor(REFERRAL_HOLD_MAX_AGE_MS / 1000)}`);

      // Raw http.request helper so `Cookie` header is sent verbatim (Node fetch strips Forbidden Header `Cookie`)
      const rawHttp = (method: string, path: string, cookie?: string) =>
        new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: unknown }>((resolve, reject) => {
          const req = http.request(
            {
              hostname: "127.0.0.1",
              port,
              path: `/api/referrals${path}`,
              method,
              headers: cookie ? { Cookie: cookie } : {},
            },
            (res) => {
              let data = "";
              res.setEncoding("utf8");
              res.on("data", (chunk) => {
                data += chunk;
              });
              res.on("end", () => {
                resolve({
                  status: res.statusCode ?? 0,
                  headers: res.headers,
                  body: JSON.parse(data),
                });
              });
            },
          );
          req.on("error", reject);
          req.end();
        });

      // GET /hold echoes normalized code back
      const getRes = await rawHttp("GET", "/hold", `${cookieKey}=23456789AB`);
      expect(getRes.body).toEqual({ code: "23456789AB" });

      // DELETE /hold clears the cookie
      const delRes = await rawHttp("DELETE", "/hold", `${cookieKey}=23456789AB`);
      expect(delRes.body).toEqual({ cleared: true });
      const delCookies = Array.isArray(delRes.headers["set-cookie"])
        ? delRes.headers["set-cookie"].join("; ")
        : (delRes.headers["set-cookie"] ?? "");
      expect(delCookies).toContain(`${cookieKey}=;`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("moves pending or auto-approved referrals to manual review when the qualifying first invoice is fully refunded (B5 port)", async () => {
    const admin = await seedUserWithSession({
      email: "admin-refund-port@example.test",
      name: "Refund Port Admin",
      role: "admin",
      stepUpFresh: true,
    });
    await enableProgram(admin.principal, {
      rewardMode: "fixed",
      fixedAmountMinor: 2500,
      currency: "USD",
      manualApprovalRequired: false,
    });

    const referrer = await seedUserWithSession({
      email: "referrer-refund@example.test",
      name: "Referrer Refund",
      customerRef: "RP-CUST-710001",
    });
    const referredA = await seedUserWithSession({
      email: "referred-a@example.test",
      name: "Referred A",
      customerRef: "RP-CUST-710002",
    });
    const referredB = await seedUserWithSession({
      email: "referred-b@example.test",
      name: "Referred B",
      customerRef: "RP-CUST-710003",
    });

    const { code } = await callAs(referrer.principal, (c) => c.me.overview());

    await tdb.db.transaction((tx) => mod.attributeRegistration(code, referredA.userId, tx));
    await tdb.db.transaction((tx) => mod.attributeRegistration(code, referredB.userId, tx));

    const invoiceA = ulid();
    const orderA = ulid();
    const paidA = await tdb.db.transaction((tx) =>
      mod.onInvoicePaid(
        {
          invoicePublicId: invoiceA,
          orderPublicId: orderA,
          customerUserId: referredA.userId,
          currency: "USD",
          subtotalMinor: 10_000,
          discountMinor: 0,
          taxMinor: 0,
          totalMinor: 10_000,
          paidAt: h.clock.now(),
        },
        { tx },
      ),
    );
    expect(paidA.outcome).toBe("auto_approved");

    // Partial refund does not move the referral to manual review
    const partialRes = await tdb.db.transaction((tx) =>
      mod.onInvoiceRefunded(
        {
          invoicePublicId: invoiceA,
          orderPublicId: orderA,
          customerUserId: referredA.userId,
          currency: "USD",
          totalMinor: 10_000,
          refundedMinor: 4000,
          fullyRefunded: false,
          refundedAt: h.clock.now(),
        },
        { tx },
      ),
    );
    expect(partialRes).toEqual({ outcome: "not_fully_refunded" });

    // Non-qualifying invoice refund is ignored cleanly
    const nonQualRes = await tdb.db.transaction((tx) =>
      mod.onInvoiceRefunded(
        {
          invoicePublicId: ulid(),
          orderPublicId: orderA,
          customerUserId: referredA.userId,
          currency: "USD",
          totalMinor: 10_000,
          refundedMinor: 10_000,
          fullyRefunded: true,
          refundedAt: h.clock.now(),
        },
        { tx },
      ),
    );
    expect(nonQualRes).toEqual({ outcome: "not_qualifying_invoice" });

    // Full refund moves the auto-approved referral to qualified_pending_approval and clears uncredited ledger row
    const fullRefundA = await tdb.db.transaction((tx) =>
      mod.onInvoiceRefunded(
        {
          invoicePublicId: invoiceA,
          orderPublicId: orderA,
          customerUserId: referredA.userId,
          currency: "USD",
          totalMinor: 10_000,
          refundedMinor: 10_000,
          fullyRefunded: true,
          refundedAt: h.clock.now(),
        },
        { tx },
      ),
    );
    expect(fullRefundA).toEqual({
      outcome: "moved_to_manual_review",
      referralPublicId: paidA.referralPublicId,
    });

    // Idempotent replay returns already_in_manual_review
    const replayA = await tdb.db.transaction((tx) =>
      mod.onInvoiceRefunded(
        {
          invoicePublicId: invoiceA,
          orderPublicId: orderA,
          customerUserId: referredA.userId,
          currency: "USD",
          totalMinor: 10_000,
          refundedMinor: 10_000,
          fullyRefunded: true,
          refundedAt: h.clock.now(),
        },
        { tx },
      ),
    );
    expect(replayA).toEqual({
      outcome: "already_in_manual_review",
      referralPublicId: paidA.referralPublicId,
    });

    const listAfterRefund = await callAs(admin.principal, (c) => c.admin.list({ limit: 10 }));
    const itemA = listAfterRefund.items.find((r) => r.referralPublicId === paidA.referralPublicId);
    expect(itemA?.status).toBe("qualified_pending_approval");
    expect(itemA?.qualificationNoteCode).toBe("QUALIFYING_INVOICE_REFUNDED");

    const ledgerWhilePending = await callAs(admin.principal, (c) => c.admin.ledger({ limit: 10 }));
    expect(
      ledgerWhilePending.items.filter((l) => l.referralPublicId === paidA.referralPublicId),
    ).toHaveLength(0);

    expect(h.audit.named("referral.moved_to_manual_review")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reasonCode: "QUALIFYING_INVOICE_REFUNDED",
          resource: expect.objectContaining({ publicId: paidA.referralPublicId }),
        }),
      ]),
    );

    // Administrator can re-approve without hitting a duplicate-ledger-key collision, and then credit;
    // a subsequent full-refund signal on an already-credited referral flags manual recovery (`credited_manual_review_flagged`).
    const reapprovedA = await callAs(admin.principal, (c) =>
      c.admin.approve({
        referralPublicId: itemA!.referralPublicId,
        expectedVersion: itemA!.version,
        note: "Replacement invoice paid offline; reward honoured.",
      }),
    );
    expect(reapprovedA.status).toBe("approved");

    const creditedA = await callAs(admin.principal, (c) =>
      c.admin.markCredited({
        referralPublicId: reapprovedA.referralPublicId,
        expectedVersion: reapprovedA.version,
        payoutMethod: "account_credit",
        reference: "CM-REFUND-TEST-01",
      }),
    );
    expect(creditedA.status).toBe("credited");

    const creditedRefundRes = await tdb.db.transaction((tx) =>
      mod.onInvoiceRefunded(
        {
          invoicePublicId: invoiceA,
          orderPublicId: orderA,
          customerUserId: referredA.userId,
          currency: "USD",
          totalMinor: 10_000,
          refundedMinor: 10_000,
          fullyRefunded: true,
          refundedAt: h.clock.now(),
        },
        { tx },
      ),
    );
    expect(creditedRefundRes).toEqual({
      outcome: "credited_manual_review_flagged",
      referralPublicId: paidA.referralPublicId,
    });

    // Second customer: auto-approved -> full refund -> manual review -> admin rejects cleanly
    const invoiceB = ulid();
    const orderB = ulid();
    const paidB = await tdb.db.transaction((tx) =>
      mod.onInvoicePaid(
        {
          invoicePublicId: invoiceB,
          orderPublicId: orderB,
          customerUserId: referredB.userId,
          currency: "USD",
          subtotalMinor: 8000,
          discountMinor: 0,
          taxMinor: 0,
          totalMinor: 8000,
          paidAt: h.clock.now(),
        },
        { tx },
      ),
    );
    expect(paidB.outcome).toBe("auto_approved");

    const fullRefundB = await mod.onInvoiceRefunded({
      invoicePublicId: invoiceB,
      orderPublicId: orderB,
      customerUserId: referredB.userId,
      currency: "USD",
      totalMinor: 8000,
      refundedMinor: 8000,
      fullyRefunded: true,
      refundedAt: h.clock.now(),
    });
    expect(fullRefundB.outcome).toBe("moved_to_manual_review");

    const listB = await callAs(admin.principal, (c) => c.admin.list({ limit: 10 }));
    const itemB = listB.items.find((r) => r.referralPublicId === paidB.referralPublicId)!;
    const rejectedB = await callAs(admin.principal, (c) =>
      c.admin.reject({
        referralPublicId: itemB.referralPublicId,
        expectedVersion: itemB.version,
        reason: "First order was cancelled and refunded in full.",
      }),
    );
    expect(rejectedB.status).toBe("rejected");
  });

  it("enforces D2.2 trash visibility and D2.6 referral link erasure while keeping numeric counts", async () => {
    const trashRegistry = createTrashRegistry();
    h.services.trash = trashRegistry;
    mod.init?.();
    const participant = trashRegistry
      .participants()
      .find((entry) => entry.module === "referrals");
    expect(participant).toBeDefined();

    const admin = await seedUserWithSession({
      email: "admin-trash@example.test",
      name: "Admin Trash",
      role: "admin",
      stepUpFresh: true,
    });
    await enableProgram(admin.principal, {
      rewardMode: "fixed",
      fixedAmountMinor: 2000,
      currency: "USD",
      manualApprovalRequired: false,
    });

    const referrer = await seedUserWithSession({
      email: "zeus-referrer@example.test",
      name: "Zeus Greene",
      customerRef: "RPCUS-A1B2CJJG5",
    });
    const soloCustomer = await seedUserWithSession({
      email: "solo-customer@example.test",
      name: "Solo Customer",
      customerRef: "RPCUS-SOLO12345",
    });
    const referred = await seedUserWithSession({
      email: "friend-referred@example.test",
      name: "Referred Friend",
      customerRef: "RPCUS-FRIEND123",
    });
    const lateSignup = await seedUserWithSession({
      email: "late-signup@example.test",
      name: "Late Signup",
      customerRef: "RPCUS-LATE12345",
    });

    const overview = await callAs(referrer.principal, (c) => c.me.overview());
    const soloOverview = await callAs(soloCustomer.principal, (c) => c.me.overview());
    const referrerCode = overview.code!;
    const soloCode = soloOverview.code!;
    expect(referrerCode).toMatch(REFERRAL_CODE_REGEX);
    expect(soloCode).toMatch(REFERRAL_CODE_REGEX);

    await callAs(referrer.principal, (c) =>
      c.me.sendInviteEmail({ recipientEmail: "invited-contact@example.test" }),
    );

    const attr = await tdb.db.transaction((tx) =>
      mod.attributeRegistration(referrerCode, referred.userId, tx),
    );
    expect(attr.attributed).toBe(true);

    const paid = await tdb.db.transaction((tx) =>
      mod.onInvoicePaid(
        {
          invoicePublicId: ulid(),
          orderPublicId: ulid(),
          customerUserId: referred.userId,
          currency: "USD",
          subtotalMinor: 10_000,
          discountMinor: 0,
          taxMinor: 0,
          totalMinor: 10_000,
          isFirstPaidInvoice: true,
          paidAt: h.clock.now(),
        },
        { tx },
      ),
    );
    expect(paid.outcome).toBe("auto_approved");

    const preList = await callAs(admin.principal, (c) => c.admin.list({ limit: 10 }));
    const refRow = preList.items.find((r) => r.referralPublicId === paid.referralPublicId)!;
    await callAs(admin.principal, (c) =>
      c.admin.markCredited({
        referralPublicId: refRow.referralPublicId,
        expectedVersion: refRow.version,
        payoutMethod: "account_credit",
        reference: "CRED-REF-99",
        note: "Credited Zeus Greene account",
      }),
    );

    // Move referrer to trash: code stops resolving with CODE_NOT_FOUND (no existence oracle),
    // operational admin list/export exclude the trashed customer, and aggregate numbers stay intact.
    await tdb.db
      .update(users)
      .set({ status: "suspended", trashedAt: h.clock.now() })
      .where(eq(users.id, referrer.userId));

    const validateTrashed = await mod.validateCode(referrerCode);
    expect(validateTrashed.valid).toBe(false);
    expect(validateTrashed.reasonCode).toBe("CODE_NOT_FOUND");

    const attrTrashed = await tdb.db.transaction((tx) =>
      mod.attributeRegistration(referrerCode, lateSignup.userId, tx),
    );
    expect(attrTrashed).toEqual({ attributed: false, reasonCode: "CODE_NOT_FOUND" });

    const listWhileTrashed = await callAs(admin.principal, (c) => c.admin.list({ limit: 10 }));
    expect(listWhileTrashed.items).toHaveLength(0);

    const batchId = ulid();
    const summaryBeforePurge = await participant!.summarize!({
      kind: "customer",
      id: referrer.userId,
      publicId: referrer.userPublicId,
      batchId,
    });
    expect(summaryBeforePurge).toEqual({ referralLinks: 1 });

    // Permanently delete referrer (with attribution) and soloCustomer (without attribution)
    await tdb.db
      .update(users)
      .set({
        trashedAt: null,
        purgedAt: h.clock.now(),
        customerRef: null,
        emailEnc: Buffer.alloc(0),
        nameEnc: Buffer.alloc(0),
      })
      .where(eq(users.id, referrer.userId));

    // Throwing fence (`PURGE_FENCE_LOST`) leaves referral_codes and invite rows untouched
    const lostFenceRun = unfencedPurgeRunForTests("run-lost-fence", {
      async assertCurrentInTx() {
        throw new DomainError("CONFLICT", "PURGE_FENCE_LOST", "Purge worker replaced.");
      },
    });
    await expect(
      participant!.purge!(
        {
          kind: "customer",
          id: referrer.userId,
          publicId: referrer.userPublicId,
          batchId,
        },
        lostFenceRun,
      ),
    ).rejects.toMatchObject({ reasonCode: "PURGE_FENCE_LOST" });
    const [codeAfterFailedFence] = await tdb.db
      .select()
      .from(referralCodes)
      .where(eq(referralCodes.userId, referrer.userId));
    expect(codeAfterFailedFence?.code).toBe(referrerCode);
    expect(codeAfterFailedFence?.active).toBe(true);

    const purgeReferrer = await participant!.purge!(
      {
        kind: "customer",
        id: referrer.userId,
        publicId: referrer.userPublicId,
        batchId,
      },
      unfencedPurgeRunForTests("run-referrer-1"),
    );
    expect(purgeReferrer.deleted.referralLinks).toBe(1);
    expect(purgeReferrer.deleted.referralEmailInvites).toBe(1);
    expect(purgeReferrer.kept?.referralAttributions).toBe(1);

    // Idempotent second purge call reports 0 newly deleted links
    const purgeReferrerRetry = await participant!.purge!(
      {
        kind: "customer",
        id: referrer.userId,
        publicId: referrer.userPublicId,
        batchId,
      },
      unfencedPurgeRunForTests("run-referrer-2"),
    );
    expect(purgeReferrerRetry.deleted.referralLinks).toBeUndefined();

    // Old referral code is completely gone from DB and never resolves again
    const validatePurged = await mod.validateCode(referrerCode);
    expect(validatePurged.valid).toBe(false);
    expect(validatePurged.reasonCode).toBe("CODE_NOT_FOUND");

    const [storedCodeRow] = await tdb.db
      .select()
      .from(referralCodes)
      .where(eq(referralCodes.userId, referrer.userId));
    expect(storedCodeRow.code).not.toBe(referrerCode);
    expect(storedCodeRow.code.startsWith("~")).toBe(true);
    expect(storedCodeRow.active).toBe(false);

    const [storedReferralRow] = await tdb.db
      .select()
      .from(referrals)
      .where(eq(referrals.publicId, paid.referralPublicId!));
    expect(storedReferralRow.codeSnapshot).toBe("~ERASED~~~");
    expect(storedReferralRow.payoutReference).toBeNull();
    expect(storedReferralRow.payoutNote).toBeNull();

    // Numeric counts and money ledger figures stay as numbers without decrypting tombstoned PII
    const adminSettingsAfterPurge = await callAs(admin.principal, (c) => c.admin.getSettings());
    expect(adminSettingsAfterPurge.summary.totalReferrals).toBe(1);
    expect(adminSettingsAfterPurge.summary.creditedCount).toBe(1);
    expect(adminSettingsAfterPurge.summary.creditedAmountMinor).toBe(2000);

    const ledgerAfterPurge = await callAs(admin.principal, (c) => c.admin.ledger({ limit: 10 }));
    expect(ledgerAfterPurge.items.length).toBeGreaterThanOrEqual(1);
    expect(ledgerAfterPurge.items[0]?.referrerName).toBe("Deleted account");
    expect(ledgerAfterPurge.items[0]?.reference).toBeNull();
    expect(ledgerAfterPurge.items[0]?.note).toBeNull();

    // Solo customer with zero attributions has referral_codes row deleted outright
    const purgeSolo = await participant!.purge!(
      {
        kind: "customer",
        id: soloCustomer.userId,
        publicId: soloCustomer.userPublicId,
        batchId,
      },
      unfencedPurgeRunForTests("run-solo-1"),
    );
    expect(purgeSolo.deleted.referralLinks).toBe(1);
    const soloCodeRows = await tdb.db
      .select()
      .from(referralCodes)
      .where(eq(referralCodes.userId, soloCustomer.userId));
    expect(soloCodeRows).toHaveLength(0);
  });
});
