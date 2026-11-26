/**
 * Billing profile module tests (Increment 08, Decision D4 — synthetic data only).
 * Covers encryption + AAD binding, plaintext column minimisation, owner isolation, active-user check,
 * optimistic concurrency (`expectedVersion`), idempotent clear, `form_submission` rate limit, zero-PII
 * durable audit events, transactional ports (`getForUserInTx`, `saveForUserInTx`, `clearForUserInTx`),
 * transaction rollback atomicity, and `ON DELETE CASCADE`.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Services } from "../../container.js";
import { DomainError } from "../../core/errors.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { SessionPrincipal, SessionTransport } from "../../core/types.js";
import { createCallerFactory, router } from "../../trpc/trpc.js";
import { createTestDeps, fakePrincipal, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { users } from "../identity/schema.js";
import {
  billingProfileDetailsAad,
  createBillingProfileModule,
  type BillingDetailsInput,
  type BillingProfileModule,
} from "./index.js";
import { billingProfileRouter } from "./router.js";
import { customerBillingProfiles } from "./schema.js";

const transport: SessionTransport = { issue() {}, clear() {} };

const SYNTHETIC_BILLING_A: BillingDetailsInput = {
  fullName: "Zeus Greene",
  company: "Ice Queen Studio LLC",
  email: "zeus.greene@example.test",
  country: "us",
  region: "NY",
  addressLine1: "742 Frostway Avenue",
  addressLine2: "Suite 400",
  city: "Syracuse",
  postalCode: "13202",
  taxId: "US-SYNTH-998877",
};

const SYNTHETIC_BILLING_B: BillingDetailsInput = {
  fullName: "Hera Vance",
  company: "",
  email: "hera.vance@example.test",
  country: "CA",
  region: "ON",
  addressLine1: "180 Example Crescent",
  addressLine2: "",
  city: "Ottawa",
  postalCode: "K1P 1J1",
  taxId: "",
};

describe("billingProfile module (MySQL)", () => {
  let t: TestDb;
  let h: TestHarness;
  let billingProfile: BillingProfileModule;
  let userA: { id: number; publicId: string; principal: SessionPrincipal };
  let userB: { id: number; publicId: string; principal: SessionPrincipal };
  let suspendedUser: { id: number; publicId: string; principal: SessionPrincipal };

  const testAppRouter = router({
    billingProfile: billingProfileRouter,
  });

  const callerFor = (session: SessionPrincipal | null) =>
    createCallerFactory(testAppRouter)({
      services: h.services,
      session,
      request: newRequestContext("test"),
      transport,
    });

  async function seedUser(publicId: string, email: string, name: string, status: "active" | "suspended" = "active") {
    await t.db.insert(users).values({
      publicId,
      emailEnc: h.deps.crypto.encrypt(email, `users.email:${publicId}`),
      emailIndex: h.deps.crypto.blindIndex(email, "users.email"),
      nameEnc: h.deps.crypto.encrypt(name, `users.name:${publicId}`),
      status,
    });
    const [row] = await t.db.select().from(users).where(eq(users.publicId, publicId));
    if (!row) throw new Error("Expected seeded user");
    return {
      id: row.id,
      publicId: row.publicId,
      principal: fakePrincipal({
        userId: row.id,
        userPublicId: row.publicId,
        role: "customer",
      }),
    };
  }

  beforeAll(async () => {
    t = await createTestDb({ schema: { users, customerBillingProfiles } });
    h = createTestDeps({ db: t.db });
    billingProfile = createBillingProfileModule(h.deps);
    (h.services as Services & { billingProfile: BillingProfileModule }).billingProfile = billingProfile;

    userA = await seedUser("01JD8000000000000000000001", "zeus.greene@example.test", "Zeus Greene");
    userB = await seedUser("01JD8000000000000000000002", "hera.vance@example.test", "Hera Vance");
    suspendedUser = await seedUser("01JD8000000000000000000003", "suspended@example.test", "Suspended Account", "suspended");
  });

  afterAll(async () => {
    await t.cleanup();
  });

  beforeEach(async () => {
    await t.db.delete(customerBillingProfiles);
    h.audit.clear();
    h.rateLimiter.blocked.clear();
  });

  it("encrypts details with user-public-id AAD, stores no plaintext PII columns, and round-trips get/save/clear with zero PII in audit", async () => {
    const callerA = callerFor(userA.principal);
    const callerB = callerFor(userB.principal);

    expect(await callerA.billingProfile.get()).toBeNull();

    const created = await callerA.billingProfile.save({
      details: SYNTHETIC_BILLING_A,
      expectedVersion: 0,
    });
    expect(created.version).toBe(1);
    expect(created.details).toEqual({
      ...SYNTHETIC_BILLING_A,
      country: "US",
    });

    // Customer B remains completely isolated and sees null.
    expect(await callerB.billingProfile.get()).toBeNull();

    // Inspect raw MySQL row: no plaintext personal fields outside encrypted envelope.
    const [rawRow] = await t.db
      .select()
      .from(customerBillingProfiles)
      .where(eq(customerBillingProfiles.userId, userA.id));
    expect(rawRow).toBeDefined();
    expect(rawRow!.country).toBe("US");
    expect(rawRow!.region).toBe("NY");
    expect(rawRow!.detailsEnc.startsWith("rpenc:v1:")).toBe(true);
    for (const secretText of [
      "Zeus Greene",
      "Ice Queen Studio LLC",
      "zeus.greene@example.test",
      "742 Frostway Avenue",
      "Suite 400",
      "Syracuse",
      "13202",
      "US-SYNTH-998877",
    ]) {
      expect(rawRow!.detailsEnc).not.toContain(secretText);
    }

    // Decrypting with the owning user's AAD succeeds; decrypting with another user's AAD throws.
    expect(
      JSON.parse(h.deps.crypto.decrypt(rawRow!.detailsEnc, billingProfileDetailsAad(userA.publicId))),
    ).toMatchObject({ fullName: "Zeus Greene", country: "US" });
    expect(() =>
      h.deps.crypto.decrypt(rawRow!.detailsEnc, billingProfileDetailsAad(userB.publicId)),
    ).toThrow();

    // Update at expectedVersion = 1 + expectedPublicId -> version 2.
    const updated = await callerA.billingProfile.save({
      details: { ...SYNTHETIC_BILLING_A, addressLine1: "900 Glacier Way", region: "" },
      expectedVersion: 1,
      expectedPublicId: created.publicId,
    });
    expect(updated.version).toBe(2);
    expect(updated.publicId).toBe(created.publicId);
    expect(updated.details.addressLine1).toBe("900 Glacier Way");
    expect(updated.details.region).toBe("");

    const fetched = await callerA.billingProfile.get();
    expect(fetched).toMatchObject({
      publicId: created.publicId,
      version: 2,
      details: expect.objectContaining({ addressLine1: "900 Glacier Way", country: "US" }),
    });

    // Clear at expectedVersion = 2 + expectedPublicId -> cleared: true, then idempotent cleared: false when repeated.
    expect(
      await callerA.billingProfile.clear({
        expectedVersion: 2,
        expectedPublicId: created.publicId,
      }),
    ).toEqual({ cleared: true });
    expect(await callerA.billingProfile.get()).toBeNull();
    expect(
      await callerA.billingProfile.clear({
        expectedVersion: 2,
        expectedPublicId: created.publicId,
      }),
    ).toEqual({ cleared: false });

    // Audit events contain zero field values (including country/region).
    const savedEvents = h.audit.named("billing_profile.saved");
    expect(savedEvents.map((e) => e.action)).toEqual(["create", "update"]);
    const clearedEvents = h.audit.named("billing_profile.cleared");
    expect(clearedEvents).toHaveLength(1);

    const serializedAudit = JSON.stringify(h.audit.events);
    for (const forbidden of [
      "Zeus Greene",
      "Ice Queen Studio LLC",
      "zeus.greene@example.test",
      "742 Frostway Avenue",
      "900 Glacier Way",
      "Suite 400",
      "Syracuse",
      "13202",
      "US-SYNTH-998877",
    ]) {
      expect(serializedAudit).not.toContain(forbidden);
    }
  });

  it("fails closed when ciphertext is copied across accounts (AAD mismatch)", async () => {
    const callerA = callerFor(userA.principal);
    const callerB = callerFor(userB.principal);

    await callerA.billingProfile.save({ details: SYNTHETIC_BILLING_A, expectedVersion: 0 });
    await callerB.billingProfile.save({ details: SYNTHETIC_BILLING_B, expectedVersion: 0 });

    const [rowA] = await t.db
      .select()
      .from(customerBillingProfiles)
      .where(eq(customerBillingProfiles.userId, userA.id));

    // Simulate an attacker/DB tamper copying A's ciphertext into B's row.
    await t.db
      .update(customerBillingProfiles)
      .set({ detailsEnc: rowA!.detailsEnc })
      .where(eq(customerBillingProfiles.userId, userB.id));

    await expect(callerB.billingProfile.get()).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      cause: expect.objectContaining({
        code: "UNAVAILABLE",
        reasonCode: "BILLING_PROFILE_CORRUPT",
      }),
    });
  });

  it("enforces optimistic concurrency and generation (ABA) binding on save and clear and audits refusals", async () => {
    const callerA = callerFor(userA.principal);

    const gen1 = await callerA.billingProfile.save({ details: SYNTHETIC_BILLING_A, expectedVersion: 0 });

    // Stale expectedVersion = 0 when version 1 already exists -> CONFLICT.
    await expect(
      callerA.billingProfile.save({ details: SYNTHETIC_BILLING_B, expectedVersion: 0 }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      cause: expect.objectContaining({
        code: "CONFLICT",
        reasonCode: "BILLING_PROFILE_VERSION_CONFLICT",
        details: { currentVersion: 1, currentPublicId: gen1.publicId },
      }),
    });

    // Advance to version 2, then try stale expectedVersion = 1 on save and clear.
    await callerA.billingProfile.save({
      details: { ...SYNTHETIC_BILLING_A, city: "Rochester" },
      expectedVersion: 1,
      expectedPublicId: gen1.publicId,
    });

    await expect(
      callerA.billingProfile.save({
        details: SYNTHETIC_BILLING_B,
        expectedVersion: 1,
        expectedPublicId: gen1.publicId,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      cause: expect.objectContaining({
        reasonCode: "BILLING_PROFILE_VERSION_CONFLICT",
        details: { currentVersion: 2, currentPublicId: gen1.publicId },
      }),
    });

    await expect(
      callerA.billingProfile.clear({ expectedVersion: 1, expectedPublicId: gen1.publicId }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      cause: expect.objectContaining({
        reasonCode: "BILLING_PROFILE_VERSION_CONFLICT",
        details: { currentVersion: 2, currentPublicId: gen1.publicId },
      }),
    });

    // ABA scenario: clear gen1 (version 2), recreate gen2 (back at version 1 via checkout/save),
    // then verify a stale tab still holding { expectedVersion: 1, expectedPublicId: gen1.publicId }
    // cannot overwrite OR clear gen2 even though gen2.version === 1!
    expect(
      await callerA.billingProfile.clear({ expectedVersion: 2, expectedPublicId: gen1.publicId }),
    ).toEqual({ cleared: true });

    const gen2 = await t.db.transaction((tx) =>
      billingProfile.saveForUserInTx(tx, userA.id, SYNTHETIC_BILLING_B, {
        userId: userA.id,
        role: "customer",
        via: "checkout",
      }),
    );
    expect(gen2.version).toBe(1);
    expect(gen2.publicId).not.toBe(gen1.publicId);

    await expect(
      callerA.billingProfile.save({
        details: SYNTHETIC_BILLING_A,
        expectedVersion: 1,
        expectedPublicId: gen1.publicId,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      cause: expect.objectContaining({
        reasonCode: "BILLING_PROFILE_VERSION_CONFLICT",
        details: { currentVersion: 1, currentPublicId: gen2.publicId },
      }),
    });

    await expect(
      callerA.billingProfile.clear({
        expectedVersion: 1,
        expectedPublicId: gen1.publicId,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      cause: expect.objectContaining({
        reasonCode: "BILLING_PROFILE_VERSION_CONFLICT",
        details: { currentVersion: 1, currentPublicId: gen2.publicId },
      }),
    });

    expect(h.audit.named("billing_profile.save_refused")).toHaveLength(3);
    expect(h.audit.named("billing_profile.clear_refused")).toHaveLength(2);

    // Generation 2 data remains intact.
    expect((await callerA.billingProfile.get())?.details.fullName).toBe("Hera Vance");
  });

  it("enforces anonymous/remediation/suspended guards and form_submission rate limits", async () => {
    await expect(callerFor(null).billingProfile.get()).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const remediation = fakePrincipal({
      userId: userA.id,
      userPublicId: userA.publicId,
      state: "remediation",
      pendingSteps: ["enroll_mfa"],
    });
    await expect(callerFor(remediation).billingProfile.get()).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(callerFor(suspendedUser.principal).billingProfile.get()).rejects.toMatchObject({
      code: "FORBIDDEN",
      cause: expect.objectContaining({ reasonCode: "ACCOUNT_NOT_ACTIVE" }),
    });

    h.rateLimiter.blocked.add("form_submission");
    await expect(
      callerFor(userA.principal).billingProfile.save({ details: SYNTHETIC_BILLING_A, expectedVersion: 0 }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    await expect(
      callerFor(userA.principal).billingProfile.clear({
        expectedVersion: 1,
        expectedPublicId: "01JD8000000000000000000999",
      }),
    ).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    h.rateLimiter.blocked.clear();
  });

  it("executes getForUserInTx, saveForUserInTx, and clearForUserInTx strictly on caller tx without mail", async () => {
    const mailBefore = h.mailer.sent.length;

    // 1. Committed registration write inside caller transaction.
    const saved = await t.db.transaction(async (tx) => {
      expect(await billingProfile.getForUserInTx(tx, userA.id)).toBeNull();
      const created = await billingProfile.saveForUserInTx(tx, userA.id, SYNTHETIC_BILLING_A, {
        userId: userA.id,
        role: "customer",
        via: "registration",
      });
      // Visible immediately on the same uncommitted tx.
      const inTx = await billingProfile.getForUserInTx(tx, userA.id);
      expect(inTx?.version).toBe(1);
      expect(inTx?.details.fullName).toBe("Zeus Greene");
      return created;
    });
    expect(saved.version).toBe(1);
    expect(h.mailer.sent).toHaveLength(mailBefore);
    expect(h.audit.recordedInTx.every(Boolean)).toBe(true);
    expect(h.audit.named("billing_profile.saved").at(-1)?.attributes).toMatchObject({
      version: 1,
      via: "registration",
    });

    // 2. Aborted outer transaction rolls back saveForUserInTx atomically.
    await expect(
      t.db.transaction(async (tx) => {
        await billingProfile.saveForUserInTx(tx, userA.id, SYNTHETIC_BILLING_B, {
          userId: userA.id,
          role: "customer",
          via: "checkout",
        });
        throw new DomainError("CONFLICT", "SIMULATED_ABORT", "Simulated checkout rollback.");
      }),
    ).rejects.toBeInstanceOf(DomainError);

    const afterRollback = await t.db.transaction((tx) => billingProfile.getForUserInTx(tx, userA.id));
    expect(afterRollback).toMatchObject({
      version: 1,
      details: expect.objectContaining({ fullName: "Zeus Greene" }),
    });

    // 3. Checkout overwrite increments version cleanly on tx, then clearForUserInTx removes it.
    const overwritten = await t.db.transaction((tx) =>
      billingProfile.saveForUserInTx(tx, userA.id, SYNTHETIC_BILLING_B, {
        userId: userA.id,
        role: "customer",
        via: "checkout",
      }),
    );
    expect(overwritten.version).toBe(2);
    expect(overwritten.details.fullName).toBe("Hera Vance");

    const cleared = await t.db.transaction((tx) =>
      billingProfile.clearForUserInTx(tx, userA.id, {
        userId: null,
        role: "system",
        via: "account_erasure",
      }),
    );
    expect(cleared).toEqual({ cleared: true });
    expect(await t.db.transaction((tx) => billingProfile.getForUserInTx(tx, userA.id))).toBeNull();
    expect(h.mailer.sent).toHaveLength(mailBefore);

    // 4. Deleting a user cascades deletion of customer_billing_profiles.
    const tempUser = await seedUser("01JD8000000000000000000099", "temp.cascade@example.test", "Temp Cascade");
    await t.db.transaction((tx) =>
      billingProfile.saveForUserInTx(tx, tempUser.id, SYNTHETIC_BILLING_A, {
        userId: tempUser.id,
        role: "customer",
        via: "registration",
      }),
    );
    await t.db.delete(users).where(eq(users.id, tempUser.id));
    const remaining = await t.db
      .select()
      .from(customerBillingProfiles)
      .where(eq(customerBillingProfiles.userId, tempUser.id));
    expect(remaining).toHaveLength(0);
  });

  it("performs a current locking read in getForUserInTx({ forUpdate: true }) past an earlier REPEATABLE READ snapshot", async () => {
    const callerA = callerFor(userA.principal);

    // 1. Concurrent create + update while outer checkout-like tx already opened its RR snapshot.
    await t.db.transaction(async (tx) => {
      // Establish InnoDB REPEATABLE READ snapshot before any profile row exists.
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userA.id));
      expect(await billingProfile.getForUserInTx(tx, userA.id)).toBeNull();

      // Concurrent settings tab creates v1 and updates to v2 on separate committed transactions.
      const v1 = await callerA.billingProfile.save({ details: SYNTHETIC_BILLING_A, expectedVersion: 0 });
      const v2 = await callerA.billingProfile.save({
        details: SYNTHETIC_BILLING_B,
        expectedVersion: 1,
        expectedPublicId: v1.publicId,
      });

      // Plain snapshot read still sees the pre-commit empty snapshot under REPEATABLE READ.
      expect(await billingProfile.getForUserInTx(tx, userA.id)).toBeNull();

      // Caller acquires `users FOR UPDATE` then calls `getForUserInTx(..., { forUpdate: true })` -> sees committed v2.
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userA.id)).for("update");
      const current = await billingProfile.getForUserInTx(tx, userA.id, { forUpdate: true });
      expect(current).toMatchObject({
        publicId: v2.publicId,
        version: 2,
        details: expect.objectContaining({ fullName: "Hera Vance" }),
      });
    });

    // 2. Concurrent clear after RR snapshot established -> `{ forUpdate: true }` sees null rather than stale v2.
    await t.db.transaction(async (tx) => {
      const staleSnapshot = await billingProfile.getForUserInTx(tx, userA.id);
      expect(staleSnapshot?.version).toBe(2);

      await callerA.billingProfile.clear({
        expectedVersion: 2,
        expectedPublicId: staleSnapshot!.publicId,
      });

      // Plain snapshot read still returns v2, whereas `{ forUpdate: true }` sees the committed deletion.
      expect((await billingProfile.getForUserInTx(tx, userA.id))?.version).toBe(2);
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userA.id)).for("update");
      expect(await billingProfile.getForUserInTx(tx, userA.id, { forUpdate: true })).toBeNull();
    });
  });
});
