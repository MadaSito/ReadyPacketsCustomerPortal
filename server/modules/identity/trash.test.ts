/**
 * Increment 09 (D2) — customer trash, restore, tombstone and the identity gates, on an isolated MySQL database.
 * Synthetic data only. Covers: suspended-only + customers-only rules, session/token revocation, one-winner CAS
 * (restore vs purge), every gate (sign-in, session, reset, invitation, reactivation, lists, search, API, lookups)
 * answering exactly like an unknown account (no existence oracle), the e-mail reservation until the tombstone,
 * re-registration of a purged address inheriting nothing, audit without personal data, portable hooks.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Services } from "../../container.js";
import { DomainError } from "../../core/errors.js";
import type { SessionPrincipal, Tx } from "../../core/types.js";
import { ulid } from "../../core/ids.js";
import { createTestDeps, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { createIdentityModule, type IdentityModule } from "./index.js";
import { emailIndexOf } from "./users.js";
import { liveUserPredicate } from "./live.js";
import { cleanTrashReason, DELETED_ACCOUNT_NAME, TOMBSTONE_EMAIL_DOMAIN } from "./trash.js";
import { PASSWORD_RESET_JOB } from "./auth.js";
import {
  customerRefHistory,
  customerRefReservations,
  identityTokens,
  sessionRestrictions,
  signInEvents,
  ssoAuthRequests,
  ssoIdentities,
  users,
  userSessions,
} from "./schema.js";
import type { TrashActor } from "../trash/ports.js";

const PW = "copper lantern drifts beyond quiet harbor";

async function reason(promise: Promise<unknown>): Promise<DomainError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DomainError);
  return error as DomainError;
}

describe("identity trash (MySQL)", () => {
  let db: TestDb;
  let h: TestHarness;
  let identity: IdentityModule;
  let seq = 0;

  function build() {
    h = createTestDeps({ db: db.db });
    h.services.assurance = {
      getAssuranceState: async () => ({ mfaEnrolled: true, recoveryCodesAcknowledged: true, passkeyCount: 0, totpEnrolled: true }),
      lockLocalAdministratorPolicy: async () => {},
      assertLocalAdministratorMayLoseAccess: async () => {},
    } as unknown as Services["assurance"];
    identity = createIdentityModule(h.deps);
    h.services.identity = identity;
  }

  async function makeUser(opts: { role?: "customer" | "staff" | "admin"; status?: "active" | "suspended" } = {}) {
    seq += 1;
    const email = `trash${seq}.${Date.now().toString(36)}@example.test`;
    const created = await db.db.transaction((tx) =>
      identity.auth.insertUser(tx as Tx, {
        email,
        nameParts: { firstName: "Zeus", lastName: `Greene${seq}`, preferredName: null },
        role: opts.role ?? "customer",
        status: "active",
        origin: "test",
        emailVerifiedAt: h.clock.now(),
      }),
    );
    await identity.setPassword(created.id, PW, { mustChange: false });
    if (opts.status === "suspended") await db.db.update(users).set({ status: "suspended" }).where(eq(users.id, created.id));
    h.audit.clear();
    h.mailer.sent = [];
    return { ...created, email };
  }

  async function session(email: string, opts: { stepUp?: boolean } = {}): Promise<{ principal: SessionPrincipal; token: string }> {
    const signed = await identity.auth.signIn({ email, password: PW }, { userAgent: "vitest" });
    let issued = await identity.sessions.markMfaVerified(signed.sessionId);
    if (opts.stepUp) issued = await identity.sessions.markStepUp(signed.sessionId);
    const principal = await identity.sessionResolver.resolve({ token: issued.token, transport: "cookie" });
    return { principal: principal!, token: issued.token };
  }

  const row = async (id: number) => (await db.db.select().from(users).where(eq(users.id, id)).limit(1))[0]!;
  const actorFor = (admin: { id: number; publicId: string }): TrashActor => ({ kind: "user", userId: admin.id, publicId: admin.publicId });
  const tx = <T>(work: (t: Tx) => Promise<T>) => db.db.transaction((t) => work(t as Tx));

  /** Admin + an active customer with a live session, suspended through the real admin path. */
  async function suspendedCustomer() {
    const admin = await makeUser({ role: "admin" });
    const customer = await makeUser();
    const live = await session(customer.email);
    const { principal } = await session(admin.email, { stepUp: true });
    await identity.admin.setCustomerStatus(principal, customer.publicId, "suspended", "POLICY_VIOLATION");
    h.audit.clear();
    h.mailer.sent = [];
    return { admin, customer, principal, customerToken: live.token };
  }

  async function trashed() {
    const s = await suspendedCustomer();
    const batchId = ulid(h.clock.now().getTime());
    await tx((t) => identity.trash.trashCustomerInTx(t, s.customer.id, { actor: actorFor(s.admin), batchId, reason: "Requested by the customer" }));
    h.audit.clear();
    h.mailer.sent = [];
    return { ...s, batchId };
  }

  async function purged() {
    const s = await trashed();
    const runId = ulid(h.clock.now().getTime());
    await tx((t) => identity.trash.markPurgeStartedInTx(t, s.customer.id, { actor: actorFor(s.admin), batchId: s.batchId, runId }));
    await identity.trash.participant().purge!({ kind: "customer", id: s.customer.id, publicId: s.customer.publicId, batchId: s.batchId }, { runId });
    await tx((t) => identity.trash.tombstoneCustomerInTx(t, s.customer.id, { actor: actorFor(s.admin), runId }));
    h.audit.clear();
    return { ...s, runId };
  }

  beforeAll(async () => {
    db = await createTestDb({ schema: { users, userSessions, identityTokens, customerRefReservations, customerRefHistory, signInEvents, sessionRestrictions, ssoIdentities, ssoAuthRequests } });
  });
  afterAll(async () => db?.cleanup());
  beforeEach(() => build());

  describe("move to trash", () => {
    it("refuses an account that is not suspended (409, plain message) and anything that is not a customer (not found)", async () => {
      const admin = await makeUser({ role: "admin" });
      const active = await makeUser();
      const staff = await makeUser({ role: "staff", status: "suspended" });
      const batchId = ulid();
      const e1 = await reason(tx((t) => identity.trash.trashCustomerInTx(t, active.id, { actor: actorFor(admin), batchId })));
      expect([e1.code, e1.reasonCode, e1.safeMessage]).toEqual(["CONFLICT", "CUSTOMER_NOT_SUSPENDED", "Suspend this account first."]);
      expect((await reason(tx((t) => identity.trash.trashCustomerInTx(t, staff.id, { actor: actorFor(admin), batchId })))).reasonCode).toBe("CUSTOMER_NOT_FOUND");
      expect((await reason(tx((t) => identity.trash.trashCustomerInTx(t, 987654321, { actor: actorFor(admin), batchId })))).reasonCode).toBe("CUSTOMER_NOT_FOUND");
      expect((await row(active.id)).trashedAt).toBeNull();
    });

    it("trashes a suspended customer: columns set, sessions and tokens revoked, audited without personal data; idempotent per batch", async () => {
      const s = await suspendedCustomer();
      // A pending token issued before the trash (e.g. an admin set-password link) must die with it.
      await db.db.insert(identityTokens).values({ userId: s.customer.id, purpose: "password_reset", tokenHash: "a".repeat(64), expiresAt: new Date(h.clock.now().getTime() + 3_600_000) });
      const batchId = ulid();
      const first = await tx((t) => identity.trash.trashCustomerInTx(t, s.customer.id, { actor: actorFor(s.admin), batchId, reason: "  Asked\u202E to leave  " }));
      expect(first.changed).toBe(true);
      const r = await row(s.customer.id);
      expect(r).toMatchObject({ status: "suspended", trashBatchId: batchId, trashedByUserId: s.admin.id, trashReason: "Asked to leave", purgeStartedAt: null, purgedAt: null });
      expect(r.trashedAt).toBeInstanceOf(Date);
      const liveTokens = await db.db.select().from(identityTokens).where(and(eq(identityTokens.userId, s.customer.id), isNull(identityTokens.consumedAt)));
      expect(liveTokens).toHaveLength(0);
      const liveSessions = await db.db.select().from(userSessions).where(and(eq(userSessions.userId, s.customer.id), isNull(userSessions.revokedAt)));
      expect(liveSessions).toHaveLength(0);
      expect(first.sessionsRevoked).toBe(0); // suspension already ended them; trash revokes any that remain
      // The coordinator owns the customer.* audit events (no double emission); identity's own rows carry no PII.
      expect(h.audit.named("customer.trashed")).toHaveLength(0);
      const serialized = JSON.stringify(h.audit.events);
      expect(serialized).not.toContain(s.customer.email);
      expect(serialized).not.toContain("Asked");
      // Same batch again → no-op; a different batch → 409.
      expect((await tx((t) => identity.trash.trashCustomerInTx(t, s.customer.id, { actor: actorFor(s.admin), batchId }))).changed).toBe(false);
      expect((await reason(tx((t) => identity.trash.trashCustomerInTx(t, s.customer.id, { actor: actorFor(s.admin), batchId: ulid() })))).reasonCode).toBe("ALREADY_IN_TRASH");
    });

    it("cleanTrashReason strips controls/bidi, collapses whitespace and bounds to 200", () => {
      expect(cleanTrashReason("  a\u0000b\u2066c  ")).toBe("a b c");
      expect(cleanTrashReason("   ")).toBeNull();
      expect(cleanTrashReason("x".repeat(300))).toHaveLength(200);
    });
  });

  describe("gates: a trashed account looks exactly like one that never existed", () => {
    it("lookups, lists, search, API and the identity port", async () => {
      const s = await trashed();
      expect(await identity.getUser(s.customer.id)).toBeNull();
      expect(await identity.getUserByPublicId(s.customer.publicId)).toBeNull();
      expect((await identity.getUsersByIds([s.customer.id])).size).toBe(0);
      expect(await identity.findUserIdByEmail(s.customer.email)).toBeNull();
      expect(await identity.findUserIdByEmail(s.customer.email, { includeTrashed: true })).toMatchObject({ userId: s.customer.id, trashed: true });
      expect(await tx((t) => identity.users.isTrashedInTx(t, s.customer.id))).toBe(true);
      expect(await tx((t) => identity.users.isTrashedInTx(t, s.admin.id))).toBe(false);
      expect(await identity.findCustomerIds(s.customer.email)).toEqual([]);
      const search = await identity.searchCustomers(s.principal, { query: s.customer.email });
      expect(search.items).toEqual([]);
      const all = await identity.searchCustomers(s.principal, { limit: 100 });
      expect(all.items.map((i) => i.publicId)).not.toContain(s.customer.publicId);
      const caller = { kind: "api_key", keyPublicId: "01J0000000000000000000TEST", scopes: ["customers:read"] } as never;
      expect(await identity.admin.apiCustomers.get(s.customer.publicId, caller)).toBeNull();
      const apiList = await identity.admin.apiCustomers.list({ limit: 100, filter: {} } as never, caller);
      expect(apiList.items.map((i) => i.id ?? (i as { publicId?: string }).publicId)).not.toContain(s.customer.publicId);
      await expect(tx((t) => identity.users.namePartsInTx(t, s.customer.id))).rejects.toMatchObject({ reasonCode: "USER_NOT_FOUND" });
      // The reusable predicate.
      const visible = await db.db.select({ id: users.id }).from(users).where(and(eq(users.id, s.customer.id), liveUserPredicate()));
      expect(visible).toEqual([]);
    });

    it("locking check for mutation consumers: unknown fails closed, ascending FOR SHARE blocks a concurrent trash until commit", async () => {
      const s = await suspendedCustomer();
      const other = await makeUser();
      // Plain read keeps the read contract (unknown → false); the locking form fails closed.
      expect(await tx((t) => identity.users.isTrashedInTx(t, 987654321))).toBe(false);
      expect(await tx((t) => identity.users.isTrashedInTx(t, 987654321, { lock: "share" }))).toBe(true);
      expect(await tx((t) => identity.users.isTrashedInTx(t, s.customer.id, { lock: "share" }))).toBe(false);
      expect(await tx((t) => identity.users.lockGoneInTx(t, [other.id, 987654321, s.customer.id, other.id]))).toEqual([987654321]);

      // While a consumer holds the share lock, the coordinator's trash (FOR UPDATE) must wait.
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const isLocked = new Promise<void>((r) => (locked = r));
      const consumer = tx(async (t) => {
        expect(await identity.users.lockGoneInTx(t, [s.customer.id])).toEqual([]);
        locked();
        await held;
      });
      await isLocked;
      const blocked = tx(async (t) => {
        await t.execute(sql`SET SESSION innodb_lock_wait_timeout = 1`);
        try {
          return await identity.trash.trashCustomerInTx(t, s.customer.id, { actor: actorFor(s.admin), batchId: ulid(), reason: null });
        } finally {
          await t.execute(sql`SET SESSION innodb_lock_wait_timeout = 50`);
        }
      });
      const err = (await blocked.then(() => null, (e: unknown) => e)) as { message?: string; cause?: { message?: string; code?: string } } | null;
      expect(err?.message).toMatch(/from `users` .* for update/);
      expect(err?.cause?.code ?? err?.cause?.message).toMatch(/ER_LOCK_WAIT_TIMEOUT|Lock wait timeout/i);
      release();
      await consumer;
      expect((await row(s.customer.id)).trashedAt).toBeNull();
      // After the consumer commits the trash proceeds, and the locking check then reports gone.
      await tx((t) => identity.trash.trashCustomerInTx(t, s.customer.id, { actor: actorFor(s.admin), batchId: ulid() }));
      expect(await tx((t) => identity.users.isTrashedInTx(t, s.customer.id, { lock: "share" }))).toBe(true);
      expect(await tx((t) => identity.users.lockGoneInTx(t, [s.customer.id, other.id]))).toEqual([s.customer.id]);
    });

    it("admin detail, reactivation and invitation answer the same not-found as an unknown id", async () => {
      const s = await trashed();
      const unknown = ulid();
      const shape = (e: DomainError) => [e.code, e.reasonCode, e.safeMessage];
      const detailTrashed = await reason(identity.admin.getCustomer(s.principal, s.customer.publicId));
      const detailUnknown = await reason(identity.admin.getCustomer(s.principal, unknown));
      expect(shape(detailTrashed)).toEqual(shape(detailUnknown));
      const reactivate = await reason(identity.admin.setCustomerStatus(s.principal, s.customer.publicId, "active", "REVIEW_CLEARED"));
      expect(shape(reactivate)).toEqual(shape(await reason(identity.admin.setCustomerStatus(s.principal, unknown, "active", "REVIEW_CLEARED"))));
      const invite = await reason(identity.admin.resendInvitation(s.principal, s.customer.publicId));
      expect(shape(invite)).toEqual(shape(await reason(identity.admin.resendInvitation(s.principal, unknown))));
      expect((await row(s.customer.id)).status).toBe("suspended");
      expect(h.mailer.sent).toHaveLength(0);
    });

    it("sign-in, old session, password reset and registration: same answers as an unknown address, no mail", async () => {
      const s = await trashed();
      expect(await identity.sessionResolver.resolve({ token: s.customerToken, transport: "cookie" })).toBeNull();
      const trashedSignIn = await reason(identity.auth.signIn({ email: s.customer.email, password: PW }, { userAgent: "vitest" }));
      const unknownSignIn = await reason(identity.auth.signIn({ email: `nobody${Date.now()}@example.test`, password: PW }, { userAgent: "vitest" }));
      expect([trashedSignIn.code, trashedSignIn.reasonCode, trashedSignIn.safeMessage]).toEqual([unknownSignIn.code, unknownSignIn.reasonCode, unknownSignIn.safeMessage]);
      expect(await identity.auth.requestPasswordReset({ email: s.customer.email })).toEqual({ accepted: true });
      expect(await identity.auth.dispatchPasswordReset({ emailIndex: emailIndexOf(h.deps.crypto, s.customer.email) })).toBe("ineligible");
      expect(await identity.auth.dispatchPasswordReset({ emailIndex: emailIndexOf(h.deps.crypto, s.customer.email), userId: s.customer.id })).toBe("ineligible");
      // Registration: the address stays reserved, the response is the uniform one, and nothing is mailed.
      const result = await identity.auth.register({ email: s.customer.email, nameParts: { firstName: "Ice", lastName: "Queen", preferredName: null }, password: PW }, {});
      expect(result).toEqual({ accepted: true });
      expect(h.mailer.sent).toHaveLength(0);
      const sameAddress = await db.db.select({ id: users.id }).from(users).where(eq(users.emailIndex, emailIndexOf(h.deps.crypto, s.customer.email)));
      expect(sameAddress.map((r) => r.id)).toEqual([s.customer.id]);
      expect(h.audit.named("auth.register.requested")[0]).toMatchObject({ outcome: "refused", reasonCode: "TRASHED_ACCOUNT" });
    });
  });

  describe("restore", () => {
    it("returns the account still suspended and visible again; other batch → 409; not in trash → no-op", async () => {
      const s = await trashed();
      expect((await reason(tx((t) => identity.trash.restoreCustomerInTx(t, s.customer.id, { actor: actorFor(s.admin), batchId: ulid() })))).reasonCode).toBe("TRASH_BATCH_MISMATCH");
      const restored = await tx((t) => identity.trash.restoreCustomerInTx(t, s.customer.id, { actor: actorFor(s.admin), batchId: s.batchId }));
      expect(restored.changed).toBe(true);
      expect(await row(s.customer.id)).toMatchObject({ status: "suspended", trashedAt: null, trashBatchId: null, trashReason: null, trashedByUserId: null });
      expect(await identity.getUser(s.customer.id)).toMatchObject({ status: "suspended" });
      expect((await tx((t) => identity.trash.restoreCustomerInTx(t, s.customer.id, { actor: actorFor(s.admin), batchId: s.batchId }))).changed).toBe(false);
      // Reactivation is a separate administrator action and works again.
      await identity.admin.setCustomerStatus(s.principal, s.customer.publicId, "active", "REVIEW_CLEARED");
      expect((await row(s.customer.id)).status).toBe("active");
    });

    it("restore vs purge has exactly one winner: once purge started, restore is refused", async () => {
      const s = await trashed();
      const runId = ulid();
      await tx((t) => identity.trash.markPurgeStartedInTx(t, s.customer.id, { actor: actorFor(s.admin), batchId: s.batchId, runId }));
      expect((await tx((t) => identity.trash.markPurgeStartedInTx(t, s.customer.id, { actor: actorFor(s.admin), batchId: s.batchId, runId }))).changed).toBe(false);
      const refused = await reason(tx((t) => identity.trash.restoreCustomerInTx(t, s.customer.id, { actor: actorFor(s.admin), batchId: s.batchId })));
      expect([refused.code, refused.reasonCode]).toEqual(["CONFLICT", "PURGE_IN_PROGRESS"]);
      expect((await row(s.customer.id)).trashedAt).not.toBeNull();
    });

    it("concurrent restore and purge claim: one succeeds, the other gets a 409", async () => {
      const s = await trashed();
      const results = await Promise.allSettled([
        tx((t) => identity.trash.restoreCustomerInTx(t, s.customer.id, { actor: actorFor(s.admin), batchId: s.batchId })),
        tx((t) => identity.trash.markPurgeStartedInTx(t, s.customer.id, { actor: actorFor(s.admin), batchId: s.batchId, runId: ulid() })),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect((loser.reason as DomainError).code).toBe("CONFLICT");
    });

    it("markPurgeStarted refuses an account that is not in the trash; tombstone refuses before the purge claim", async () => {
      const s = await suspendedCustomer();
      expect((await reason(tx((t) => identity.trash.markPurgeStartedInTx(t, s.customer.id, { actor: actorFor(s.admin), batchId: ulid(), runId: ulid() })))).reasonCode).toBe("NOT_IN_TRASH");
      const t2 = await trashed();
      expect((await reason(tx((t) => identity.trash.tombstoneCustomerInTx(t, t2.customer.id, { actor: actorFor(t2.admin), runId: ulid() })))).reasonCode).toBe("PURGE_NOT_STARTED");
      expect((await row(t2.customer.id)).purgedAt).toBeNull();
    });
  });

  describe("permanent deletion (tombstone)", () => {
    it("overwrites personal data, erases credentials, frees the address and keeps the customer ID; idempotent", async () => {
      const s = await trashed();
      const before = await row(s.customer.id);
      const runId = ulid();
      await tx((t) => identity.trash.markPurgeStartedInTx(t, s.customer.id, { actor: actorFor(s.admin), batchId: s.batchId, runId }));
      const ref = { kind: "customer" as const, id: s.customer.id, publicId: s.customer.publicId, batchId: s.batchId };
      const p1 = await identity.trash.participant().purge!(ref, { runId });
      expect(p1.deleted.sessions).toBeGreaterThan(0);
      expect((await identity.trash.participant().purge!(ref, { runId })).deleted).toMatchObject({ sessions: 0, tokens: 0 });
      const done = await tx((t) => identity.trash.tombstoneCustomerInTx(t, s.customer.id, { actor: actorFor(s.admin), runId }));
      expect(done.changed).toBe(true);
      const r = await row(s.customer.id);
      expect(r.purgedAt).toBeInstanceOf(Date);
      expect(r).toMatchObject({ status: "deactivated", passwordHash: null, firstNameEnc: null, lastNameEnc: null, preferredNameEnc: null, trashReason: null, customerRef: before.customerRef, publicId: before.publicId, nameFirstPrefixIndex: null, nameLastPrefixIndex: null });
      expect(r.emailIndex).not.toBe(before.emailIndex);
      expect(h.deps.crypto.decrypt(r.nameEnc, `users.name:${r.publicId}`)).toBe(DELETED_ACCOUNT_NAME);
      const placeholder = h.deps.crypto.decrypt(r.emailEnc, `users.email:${r.publicId}`);
      expect(placeholder).toMatch(new RegExp(`^deleted-[0-9a-z]{26}@${TOMBSTONE_EMAIL_DOMAIN.replace(".", "\\.")}$`));
      expect(placeholder).not.toContain(s.customer.email.split("@")[0]!);
      expect(await db.db.select().from(userSessions).where(eq(userSessions.userId, s.customer.id))).toEqual([]);
      expect(await db.db.select().from(identityTokens).where(eq(identityTokens.userId, s.customer.id))).toEqual([]);
      expect(done.erased.sessions).toBe(0); // the participant already erased them
      // Idempotent and never restorable.
      expect((await tx((t) => identity.trash.tombstoneCustomerInTx(t, s.customer.id, { actor: actorFor(s.admin), runId }))).changed).toBe(false);
      expect((await reason(tx((t) => identity.trash.restoreCustomerInTx(t, s.customer.id, { actor: actorFor(s.admin), batchId: s.batchId })))).reasonCode).toBe("PURGE_IN_PROGRESS");
      expect((await reason(tx((t) => identity.trash.trashCustomerInTx(t, s.customer.id, { actor: actorFor(s.admin), batchId: ulid() })))).reasonCode).toBe("CUSTOMER_NOT_FOUND");
    });

    it("a tombstone never appears anywhere, and the purged address registers again as a NEW account that inherits nothing", async () => {
      const s = await purged();
      expect(await identity.getUser(s.customer.id)).toBeNull();
      expect(await identity.getUserByPublicId(s.customer.publicId)).toBeNull();
      expect(await identity.findUserIdByEmail(s.customer.email, { includeTrashed: true })).toBeNull();
      expect((await identity.searchCustomers(s.principal, { limit: 100 })).items.map((i) => i.publicId)).not.toContain(s.customer.publicId);
      expect((await identity.trash.listTrashedCustomers({ limit: 100 })).items.map((i) => i.publicId)).not.toContain(s.customer.publicId);
      expect(await tx((t) => identity.users.isTrashedInTx(t, s.customer.id))).toBe(true);
      expect(await identity.sessionResolver.resolve({ token: s.customerToken, transport: "cookie" })).toBeNull();
      const result = await identity.auth.register({ email: s.customer.email, nameParts: { firstName: "Ice", lastName: "Queen", preferredName: null }, password: PW }, {});
      expect(result).toEqual({ accepted: true });
      const fresh = (await identity.findUserIdByEmail(s.customer.email))!;
      expect(fresh.userId).not.toBe(s.customer.id);
      expect(fresh.publicId).not.toBe(s.customer.publicId);
      const freshRow = await row(fresh.userId);
      expect(freshRow.customerRef).not.toBe((await row(s.customer.id)).customerRef);
      expect(freshRow.trashedAt).toBeNull();
      expect(await db.db.select().from(userSessions).where(eq(userSessions.userId, fresh.userId))).toEqual([]);
      // Kept records stay tied to the old immutable id: the tombstone is still there, unchanged.
      expect((await row(s.customer.id)).purgedAt).not.toBeNull();
      // The old session token stays dead.
      expect(await identity.sessionResolver.resolve({ token: s.customerToken, transport: "cookie" })).toBeNull();
    });
  });

  describe("queued work never reaches a re-registered address (D2.8)", () => {
    it("a reset queued before the purge is bound to the old id: after re-registration it issues nothing to the new account", async () => {
      const s = await suspendedCustomer();
      h.jobs.enqueued = [];
      // Queued while the old account still owned the address (a suspended account: the uniform intake still runs).
      expect(await identity.auth.requestPasswordReset({ email: s.customer.email })).toEqual({ accepted: true });
      const queued = h.jobs.enqueued.find((j) => j.type === PASSWORD_RESET_JOB)!.payload as { emailIndex: string; userId: number | null };
      expect(queued.userId).toBe(s.customer.id);
      const batchId = ulid();
      await tx((t) => identity.trash.trashCustomerInTx(t, s.customer.id, { actor: actorFor(s.admin), batchId }));
      const runId = ulid();
      await tx((t) => identity.trash.markPurgeStartedInTx(t, s.customer.id, { batchId, runId }));
      await identity.trash.participant().purge!({ kind: "customer", id: s.customer.id, publicId: s.customer.publicId, batchId }, { runId });
      await tx((t) => identity.trash.tombstoneCustomerInTx(t, s.customer.id, { runId }));
      await identity.auth.register({ email: s.customer.email, nameParts: { firstName: "Ice", lastName: "Queen", preferredName: null }, password: PW }, {});
      const fresh = (await identity.findUserIdByEmail(s.customer.email))!;
      await db.db.update(users).set({ emailVerifiedAt: h.clock.now() }).where(eq(users.id, fresh.userId));
      h.mailer.sent = [];
      expect(await identity.auth.dispatchPasswordReset(queued)).toBe("ineligible");
      expect(await db.db.select().from(identityTokens).where(and(eq(identityTokens.userId, fresh.userId), eq(identityTokens.purpose, "password_reset")))).toEqual([]);
      expect(h.mailer.sent.filter((m) => (m as { template?: string }).template === "auth.password_reset")).toEqual([]);
      // A request made AFTER re-registration serves the new account normally.
      h.jobs.enqueued = [];
      await identity.auth.requestPasswordReset({ email: s.customer.email });
      const next = h.jobs.enqueued.find((j) => j.type === PASSWORD_RESET_JOB)!.payload as { emailIndex: string; userId: number | null };
      expect(next.userId).toBe(fresh.userId);
      expect(await identity.auth.dispatchPasswordReset(next)).toBe("issued");
    });

    it("a reset job without a bound id (queued before this field) fails closed; unknown at intake stays unknown", async () => {
      const live = await makeUser();
      const emailIndex = emailIndexOf(h.deps.crypto, live.email);
      expect(await identity.auth.dispatchPasswordReset({ emailIndex })).toBe("ineligible");
      expect(await identity.auth.dispatchPasswordReset({ emailIndex, userId: null })).toBe("ineligible");
      expect(await identity.auth.dispatchPasswordReset({ emailIndex, userId: live.id + 100000 })).toBe("ineligible");
      expect(await identity.auth.dispatchPasswordReset({ emailIndex, userId: live.id })).toBe("issued");
    });

    it("security sign-in log hides a trashed account: no name, and filtering by its ID matches nothing (like an unknown ID)", async () => {
      const s = await suspendedCustomer();
      await tx((t) => identity.trash.trashCustomerInTx(t, s.customer.id, { actor: actorFor(s.admin), batchId: ulid() }));
      const all = await identity.centre.listSignInLog(s.principal, { limit: 100 } as never);
      const names = JSON.stringify(all.items);
      expect(all.items.length).toBeGreaterThan(0);
      expect(all.items.some((it) => it.user === null)).toBe(true); // the customer's kept events, account hidden
      expect(names).not.toContain(s.customer.publicId);
      const byId = await identity.centre.listSignInLog(s.principal, { userId: s.customer.publicId });
      const unknown = await identity.centre.listSignInLog(s.principal, { userId: "01J0000000000000000000NONE" });
      expect(byId.items).toEqual([]);
      expect(unknown.items).toEqual([]);
    });
  });

  describe("trash centre read and portable hooks", () => {
    it("listTrashedCustomers: trashed only, no names or e-mail, filters by mover and customer ID prefix", async () => {
      const s = await trashed();
      const page = await identity.trash.listTrashedCustomers({ limit: 100 });
      const item = page.items.find((i) => i.publicId === s.customer.publicId)!;
      expect(item).toMatchObject({ id: s.customer.id, batchId: s.batchId, trashedByUserId: s.admin.id, trashedByPublicId: s.admin.publicId, reason: "Requested by the customer", purgeStartedAt: null });
      expect(JSON.stringify(item)).not.toContain(s.customer.email);
      const ref = (await row(s.customer.id)).customerRef!;
      expect((await identity.trash.listTrashedCustomers({ q: ref })).items.map((i) => i.publicId)).toEqual([s.customer.publicId]);
      expect((await identity.trash.listTrashedCustomers({ movedBy: ulid() })).items).toEqual([]);
      expect(await identity.trash.resolveCustomerInTx(db.db, s.customer.publicId)).toMatchObject({ trashBatchId: s.batchId, status: "suspended" });
      expect(await identity.trash.resolveCustomerInTx(db.db, s.admin.publicId)).toBeNull();
      const meta = await identity.trash.getCustomerTrashMetaByIds([s.customer.id, s.admin.id]);
      expect(meta.get(s.customer.id)).toMatchObject({ publicId: s.customer.publicId, trashBatchId: s.batchId });
      expect(meta.has(s.admin.id)).toBe(false);
    });

    it("portableCustomers hides trash by default; includeTrashed returns state; portableCustomerRefInTx is ungated", async () => {
      const s = await trashed();
      const live = await tx((t) => identity.portableCustomers(t, null, 500, [s.customer.publicId]));
      expect(live).toEqual([]);
      const withTrash = await tx((t) => identity.portableCustomers(t, null, 500, [s.customer.publicId], { includeTrashed: true }));
      expect(withTrash[0]).toMatchObject({ userId: s.customer.id, trash: { batchId: s.batchId, purgedAt: null } });
      expect(await tx((t) => identity.portableCustomerRefInTx(t, { publicId: s.customer.publicId }))).toMatchObject({ userId: s.customer.id, trashed: true, purged: false });
      expect(await tx((t) => identity.portableCustomerRefInTx(t, { userId: s.customer.id }))).toMatchObject({ publicId: s.customer.publicId });
    });

    it("createPendingCustomer with trash state: in-trash import is suspended and gated; tombstone import frees the address", async () => {
      const email = `import${Date.now()}@example.test`;
      const inTrash = await tx((t) =>
        identity.createPendingCustomer({ email, name: "Zeus Greene", trash: { trashedAt: h.clock.now(), batchId: ulid(), reason: "Imported", purgedAt: null } }, { tx: t }),
      );
      expect(await row(inTrash.userId)).toMatchObject({ status: "suspended", purgedAt: null });
      expect(await identity.getUser(inTrash.userId)).toBeNull();
      expect(await identity.findUserIdByEmail(email, { includeTrashed: true })).toMatchObject({ trashed: true });
      const tombEmail = `tomb${Date.now()}@example.test`;
      const tomb = await tx((t) =>
        identity.createPendingCustomer({ email: tombEmail, name: "Zeus Greene", trash: { trashedAt: h.clock.now(), batchId: null, reason: null, purgedAt: h.clock.now() } }, { tx: t }),
      );
      const tr = await row(tomb.userId);
      expect(tr).toMatchObject({ status: "deactivated", passwordHash: null });
      expect(tr.purgedAt).not.toBeNull();
      expect(h.deps.crypto.decrypt(tr.nameEnc, `users.name:${tr.publicId}`)).toBe(DELETED_ACCOUNT_NAME);
      expect(await identity.findUserIdByEmail(tombEmail, { includeTrashed: true })).toBeNull();
    });
  });
});
