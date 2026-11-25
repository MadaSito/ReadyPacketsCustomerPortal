/**
 * Entra ID single sign-on — service tests on an isolated MySQL database with a FAKE identity provider
 * (sso/testing.ts: synthetic RSA keys, JWKS and token endpoint behind a fake egress `fetchPinned`).
 * No network, no real tenant. Covers token validation, state/browser binding, linking rules, JIT bounds,
 * the parked-code two-step pattern (G-O01) and the configuration-change race (I-A02).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import type { Services } from "../../../container.js";
import { DomainError } from "../../../core/errors.js";
import type { SessionPrincipal, Tx } from "../../../core/types.js";
import type { AuditEventInput } from "../../../core/types.js";
import type { AppConfig } from "../../../config/env.js";
import { createTestDeps, type TestHarness } from "../../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../../tests/helpers/testDb.js";
import { createEntraAssurance } from "../../assurance/entra.js";
import { createIdentityModule, type IdentityModule } from "../index.js";
import { customerRefHistory, customerRefReservations, identityTokens, sessionRestrictions, signInEvents, ssoAuthRequests, ssoConfiguration, ssoIdentities, ssoRoleMappings, ssoSamlCertificates, users, userSessions } from "../schema.js";
import { authorizationUrl, entraEndpoints, OidcValidationError, peekKeyId, verifyIdToken } from "./oidc.js";
import { createFakeEntra, type FakeEntra, type FakeEntraIdentity } from "./testing.js";
import type { SsoConfigInput } from "./service.js";
import { inflateRawSync } from "node:zlib";
import { spUrls } from "./saml.js";
import { buildSignedResponse, TEST_IDP } from "./samlTesting.js";

const PW = "copper lantern drifts beyond quiet harbor";
const TENANT = "11111111-2222-4333-8444-555555555555";
const CLIENT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SECRET = "fake-client-secret-value-0001";
const oid = () => randomUUID();

async function rejects(promise: Promise<unknown>, reasonCode: string): Promise<DomainError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).reasonCode).toBe(reasonCode);
  return error as DomainError;
}

describe("Entra ID single sign-on (MySQL, fake IdP)", () => {
  let db: TestDb;
  let h: TestHarness;
  let identity: IdentityModule;
  let idp: FakeEntra;
  let seq = 0;
  let admin: SessionPrincipal;
  const mfa = new Map<number, boolean>();

  const sso = () => identity.sso;

  async function build(config: Partial<AppConfig> = {}) {
    await db.db.delete(ssoAuthRequests);
    await db.db.delete(ssoIdentities);
    await db.db.delete(ssoConfiguration);
    h = createTestDeps({ db: db.db, config: { canonicalOrigin: "https://portal.example.test", ...config } });
    const entra = createEntraAssurance(h.deps);
    h.services.assurance = {
      getAssuranceState: async (userId: number) => ({ mfaEnrolled: mfa.get(userId) ?? false, recoveryCodesAcknowledged: mfa.get(userId) ?? false, passkeyCount: 0, totpEnrolled: mfa.get(userId) ?? false }),
      lockLocalAdministratorPolicy: async () => {},
      assertLocalAdministratorRemains: async () => {},
      assertLocalAdministratorMayLoseAccess: async () => {},
      breakGlassHealth: async () => ({ localMfaAdministrators: 1, soleLocalMfaAdministratorHasPasskey: false }),
      assessEntraSignIn: entra.assessEntraSignIn,
      completeEntraStepUp: entra.completeEntraStepUp,
    } as unknown as Services["assurance"];
    idp = createFakeEntra({ tenantId: TENANT, clientId: CLIENT, nowSeconds: () => Math.floor(h.clock.now().getTime() / 1000) });
    h.services.integrations = { egress: { fetchPinned: idp.fetchPinned } } as unknown as Services["integrations"];
    identity = createIdentityModule(h.deps);
    h.services.identity = identity;
    const a = await makeUser({ role: "admin" });
    admin = (await session(a.email, { stepUp: true })).principal;
  }

  async function makeUser(opts: { role?: "customer" | "staff" | "admin"; mfa?: boolean } = {}) {
    seq += 1;
    const email = `sso${seq}.${randomUUID().slice(0, 6)}@contoso.test`;
    const created = await db.db.transaction((tx) =>
      identity.auth.insertUser(tx as Tx, { email, name: `Synthetic Person${seq}`, role: opts.role ?? "customer", status: "active", origin: "test", emailVerifiedAt: h.clock.now() }),
    );
    await identity.setPassword(created.id, PW, { mustChange: false });
    mfa.set(created.id, opts.mfa !== false);
    return { ...created, email };
  }

  async function session(email: string, opts: { stepUp?: boolean } = {}) {
    const signed = await identity.auth.signIn({ email, password: PW }, { userAgent: "vitest" });
    let issued = await identity.sessions.markMfaVerified(signed.sessionId);
    if (opts.stepUp) issued = await identity.sessions.markStepUp(signed.sessionId);
    const principal = await identity.sessionResolver.resolve({ token: issued.token, transport: "cookie" });
    return { principal: principal!, token: issued.token };
  }

  const baseConfig = (patch: Partial<SsoConfigInput> = {}): SsoConfigInput => ({
    expectedVersion: 1, tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET, buttonLabel: null, allowedDomains: [],
    jitMode: "off", jitStaffAppRole: null, jitDailyLimit: 25,
    protocol: "oidc", samlEntityId: null, entraMfaMode: "claim", acceptedAuthnContexts: [], allowedRoles: ["admin", "staff", "customer"], ...patch,
  });

  async function configure(patch: Partial<SsoConfigInput> = {}, enable = true) {
    const current = await sso().adminView();
    let view = await sso().updateConfig(admin, { ...baseConfig(patch), expectedVersion: current.version });
    if (enable && !view.enabled) view = await sso().setEnabled(admin, true, view.version);
    return view;
  }

  async function bind(userPublicId: string, objectId: string) {
    await sso().bindUser(admin, userPublicId, objectId);
  }

  /** Full sign-in: start → (fake Entra) → callback → complete. Returns the callback location and result. */
  async function signIn(who: FakeEntraIdentity, opts: { browserAtCallback?: string } = {}) {
    const browser = `b-${randomUUID()}`;
    const url = await sso().startSignIn({ next: "/orders", browser });
    const { state, code } = idp.authorize(url, who);
    const location = await sso().callback({ state, code, error: undefined, browser: opts.browserAtCallback ?? browser });
    return { location, state, code, browser, finish: () => sso().complete({ attempt: attemptOf(location), browser, session: null, userAgent: "vitest" }) };
  }

  const attemptOf = (location: string) => new URL(`https://x.test${location}`).searchParams.get("attempt") ?? "";
  const reasonOf = (location: string) => new URL(`https://x.test${location}`).searchParams.get("reason");

  /** Session-bound purpose: prepare (tRPC) → start with ticket (GET) → fake Entra → callback (parks the code). */
  async function sessionBound(principal: SessionPrincipal, purpose: "link" | "step_up" | "test", who: FakeEntraIdentity) {
    const browser = `b-${randomUUID()}`;
    const { startUrl } = await sso().prepare(principal, purpose, "/account");
    const ticket = new URL(`https://x.test${startUrl}`).searchParams.get("ticket")!;
    const url = await sso().startWithTicket({ ticket, session: principal, browser });
    const { state, code } = idp.authorize(url, who);
    const location = await sso().callback({ state, code, error: undefined, browser });
    return { location, browser, attempt: attemptOf(location) };
  }

  const entraSessions = async (userId: number) =>
    db.db.select().from(userSessions).where(and(eq(userSessions.userId, userId), eq(userSessions.authMethod, "entra"), isNull(userSessions.revokedAt)));

  beforeAll(async () => {
    db = await createTestDb({ schema: { users, userSessions, identityTokens, customerRefReservations, customerRefHistory, signInEvents, sessionRestrictions, ssoConfiguration, ssoIdentities, ssoAuthRequests, ssoSamlCertificates, ssoRoleMappings } });
  });
  afterAll(async () => db?.cleanup());
  beforeEach(async () => build());

  /* ------------------------------------------------------------------ configuration */

  describe("configuration", () => {
    it("is write-only for the secret, validates tenant, and is disabled until enabled", async () => {
      const view = await configure({}, false);
      expect(view.enabled).toBe(false);
      expect(view.clientSecret).toEqual({ configured: true, last4: SECRET.slice(-4) });
      expect(JSON.stringify(view)).not.toContain(SECRET);
      expect(view.redirectUri).toBe("https://portal.example.test/api/identity/sso/callback");
      expect(view.breakGlass).toEqual({ localMfaAdministrators: 1, soleLocalMfaAdministratorHasPasskey: false });
      expect((await sso().publicConfig()).enabled).toBe(false);
      await rejects(sso().updateConfig(admin, { ...baseConfig({ tenantId: "common" }), expectedVersion: view.version }), "SSO_CONFIG_INVALID");
      await rejects(sso().updateConfig(admin, baseConfig({ jitDailyLimit: 5 })), "STALE_VERSION");
      expect(JSON.stringify(h.audit.events)).not.toContain(SECRET);
    });

    it("cannot be enabled in the preview deployment", async () => {
      await build({ deploymentProfile: "preview" });
      await configure({}, false);
      const view = await sso().adminView();
      expect(view.availableInThisDeployment).toBe(false);
      await rejects(sso().setEnabled(admin, true, view.version), "SSO_NOT_AVAILABLE_IN_PREVIEW");
    });

    it("refuses sign-in start while disabled", async () => {
      await configure({}, false);
      await rejects(sso().startSignIn({ next: "/", browser: "b" }), "SSO_UNAVAILABLE");
    });
  });

  /* ------------------------------------------------------------------ sign-in */

  describe("sign-in", () => {
    it("signs in an administrator-bound identity, verifies the binding, and trusts Entra MFA", async () => {
      await configure();
      const user = await makeUser({ mfa: false });
      const id = oid();
      await bind(user.publicId, id);
      const run = await signIn({ oid: id });
      expect(run.location).toMatch(/^\/sso\/complete\?attempt=[0-9A-Z]{26}$/);
      const done = await run.finish();
      expect(done.purpose).toBe("sign_in");
      if (done.purpose !== "sign_in") throw new Error("unreachable");
      expect(done.next).toBe("/orders");
      expect(done.nextStep).toBeNull();
      const principal = await identity.sessionResolver.resolve({ token: done.issued.token, transport: "cookie" });
      expect(principal?.authMethod).toBe("entra");
      expect(principal?.state).toBe("full");
      const [link] = await db.db.select().from(ssoIdentities).where(eq(ssoIdentities.userId, user.id));
      expect(link?.verifiedAt).not.toBeNull();
      expect(h.audit.named("identity.sso.binding_verified")).toHaveLength(1);
      // The exchange posted the secret and the verifier but the fixture saw them only as present.
      expect(idp.calls.find((c) => c.form)?.form).toMatchObject({ code: "[present]", client_secret: "[present]", code_verifier: "[present]", grant_type: "authorization_code" });
      expect(idp.calls.every((c) => c.purpose === "entra_oidc")).toBe(true);
    });

    it("without Entra MFA trust, an Entra session still needs local MFA", async () => {
      await configure({ entraMfaMode: "portal" });
      const user = await makeUser({ mfa: false });
      const id = oid();
      await bind(user.publicId, id);
      const done = await (await signIn({ oid: id })).finish();
      if (done.purpose !== "sign_in") throw new Error("unreachable");
      expect(done.nextStep).not.toBeNull();
    });

    it("consumes state once and binds it to the starting browser", async () => {
      await configure();
      const user = await makeUser();
      const id = oid();
      await bind(user.publicId, id);
      const run = await signIn({ oid: id });
      const replay = await sso().callback({ state: run.state, code: run.code, error: undefined, browser: run.browser });
      expect(reasonOf(replay)).toBe("SSO_EXPIRED");
      const wrong = await signIn({ oid: id }, { browserAtCallback: "another-browser" });
      expect(reasonOf(wrong.location)).toBe("SSO_EXPIRED");
      const missing = await sso().callback({ state: run.state, code: run.code, error: undefined, browser: undefined });
      expect(reasonOf(missing)).toBe("SSO_EXPIRED");
      // The finished attempt cannot complete twice.
      await run.finish();
      await rejects(run.finish(), "SSO_EXPIRED");
    });

    it("reports a cancelled Entra sign-in without exchanging anything", async () => {
      await configure();
      const browser = "b-cancel";
      const url = await sso().startSignIn({ next: "/", browser });
      const state = new URL(url).searchParams.get("state");
      const location = await sso().callback({ state, code: undefined, error: "access_denied", browser });
      expect(reasonOf(location)).toBe("SSO_CANCELLED");
      expect(idp.calls).toHaveLength(0);
    });

    const invalidTokens: [string, FakeEntraIdentity["claims"] | undefined, Record<string, unknown> | undefined, string][] = [
      ["wrong tenant", { tid: "99999999-2222-4333-8444-555555555555" }, undefined, "TOKEN_TENANT_MISMATCH"],
      ["wrong audience", { aud: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee" }, undefined, "TOKEN_AUDIENCE_MISMATCH"],
      ["wrong issuer", { iss: "https://login.microsoftonline.com/common/v2.0" }, undefined, "TOKEN_ISSUER_MISMATCH"],
      ["expired", { exp: 1_000, iat: 900, nbf: 900 }, undefined, "TOKEN_EXPIRED"],
      ["nonce mismatch", { nonce: "not-the-nonce" }, undefined, "TOKEN_NONCE_MISMATCH"],
      ["alg none", undefined, { alg: "none" }, "TOKEN_ALGORITHM_REFUSED"],
      ["HS256", undefined, { alg: "HS256" }, "TOKEN_ALGORITHM_REFUSED"],
    ];
    for (const [name, claims, header, reason] of invalidTokens) {
      it(`refuses an ID token: ${name}`, async () => {
        await configure();
        const before = (await db.db.select().from(userSessions).where(eq(userSessions.authMethod, "entra"))).length;
        const run = await signIn({ oid: oid(), claims, header });
        expect(reasonOf(run.location)).toBe("SSO_FAILED");
        const refused = h.audit.named("identity.sso.callback_refused").at(-1);
        expect(refused?.reasonCode).toMatch(reason === "TOKEN_ALGORITHM_REFUSED" ? /^TOKEN_/ : new RegExp(`^${reason}$`));
        expect(await db.db.select().from(userSessions).where(eq(userSessions.authMethod, "entra"))).toHaveLength(before);
      });
    }

    it("refuses a bad signature", async () => {
      await configure();
      const run = await signIn({ oid: oid(), signWith: idp.otherKey() });
      expect(reasonOf(run.location)).toBe("SSO_FAILED");
      expect(h.audit.named("identity.sso.callback_refused").at(-1)?.reasonCode).toBe("TOKEN_SIGNATURE_INVALID");
    });

    it("D7: a refused callback publishes one sso_callback failure signal (no account ref) and tags the audit step", async () => {
      await configure();
      const signals: { kind: string; outcome: string; accountRef?: string }[] = [];
      (h.services as unknown as { protection: unknown }).protection = {
        recordSignInSignal: async (x: { kind: string; outcome: string; accountRef?: string }) => { signals.push(x); },
      };
      await signIn({ oid: oid(), signWith: idp.otherKey() });
      expect(signals).toEqual([expect.objectContaining({ kind: "sso_callback", outcome: "failure" })]);
      expect(signals[0]!.accountRef).toBeUndefined();
      expect(h.audit.named("identity.sso.callback_refused").at(-1)?.attributes?.step).toBe("sso");
    });

    it("refetches the JWKS once for an unknown key id, then stays bounded", async () => {
      await configure();
      const user = await makeUser();
      const id = oid();
      await bind(user.publicId, id);
      await (await signIn({ oid: id })).finish();
      expect(idp.jwksFetches()).toBe(1);
      idp.rotate(false); // Entra signs with a key it has not published
      expect(reasonOf((await signIn({ oid: id })).location)).toBe("SSO_FAILED");
      expect(idp.jwksFetches()).toBe(2);
      expect(reasonOf((await signIn({ oid: id })).location)).toBe("SSO_FAILED");
      expect(idp.jwksFetches()).toBe(2); // no amplification
      idp.rotate(true);
      h.clock.advance(5 * 60_000 + 1);
      const ok = await signIn({ oid: id });
      expect(ok.location).toMatch(/^\/sso\/complete/);
    });

    it("refuses customers with SSO_MAINTENANCE during customer maintenance (no session); staff still sign in", async () => {
      await configure();
      const customer = await makeUser({ role: "customer" });
      const cid = oid();
      await bind(customer.publicId, cid);
      const staff = await makeUser({ role: "staff", mfa: true });
      const sid = oid();
      await bind(staff.publicId, sid);
      (h.services as unknown as Record<string, unknown>).jobAdmin = { maintenance: { customerAccess: async () => ({ active: true, message: null, expectedEnd: null }) } };
      const before = await db.db.select().from(userSessions).where(eq(userSessions.userId, customer.id));
      await rejects((await signIn({ oid: cid })).finish(), "SSO_MAINTENANCE");
      expect(await db.db.select().from(userSessions).where(eq(userSessions.userId, customer.id))).toHaveLength(before.length);
      const done = await (await signIn({ oid: sid })).finish();
      expect(done.purpose).toBe("sign_in");
    });

    it("refuses unlinked identities, deactivated accounts and pending local remediation", async () => {
      await configure();
      await rejects((await signIn({ oid: oid() })).finish(), "SSO_NOT_LINKED");

      const gone = await makeUser();
      const goneId = oid();
      await bind(gone.publicId, goneId);
      await db.db.update(users).set({ status: "deactivated" }).where(eq(users.id, gone.id));
      await rejects((await signIn({ oid: goneId })).finish(), "SSO_ACCOUNT_INACTIVE");

      const recovering = await makeUser();
      const recId = oid();
      await bind(recovering.publicId, recId);
      await db.db.update(users).set({ mustChangePassword: true }).where(eq(users.id, recovering.id));
      await rejects((await signIn({ oid: recId })).finish(), "SSO_LOCAL_SIGN_IN_REQUIRED");
      expect(h.audit.named("auth.login.refused").map((e) => e.reasonCode)).toEqual(["IDENTITY_NOT_LINKED", "ACCOUNT_DEACTIVATED", "LOCAL_REMEDIATION_PENDING"]);
    });

    it("never links by e-mail: a matching address without a link is refused", async () => {
      await configure({ jitMode: "customers" });
      const existing = await makeUser();
      await rejects((await signIn({ oid: oid(), email: existing.email })).finish(), "SSO_ACCOUNT_EXISTS");
      expect(await db.db.select().from(ssoIdentities).where(eq(ssoIdentities.userId, existing.id))).toHaveLength(0);
    });

    it("enforces the allowed domains", async () => {
      await configure({ allowedDomains: ["fabrikam.test"], jitMode: "customers" });
      await rejects((await signIn({ oid: oid(), email: "someone@contoso.test" })).finish(), "SSO_DOMAIN_NOT_ALLOWED");
      const ok = await (await signIn({ oid: oid(), email: "someone@fabrikam.test" })).finish();
      expect(ok.purpose).toBe("sign_in");
    });
  });

  /* ------------------------------------------------------------------ JIT */

  describe("just-in-time provisioning", () => {
    it("creates customers, or staff only with the app role, never administrators", async () => {
      await configure({ jitMode: "staff", jitStaffAppRole: "Portal.Staff" });
      await rejects((await signIn({ oid: oid(), roles: ["Portal.Admin"] })).finish(), "SSO_ROLE_NOT_ASSIGNED");
      const done = await (await signIn({ oid: oid(), roles: ["Portal.Staff", "Portal.Admin", "admin"] })).finish();
      if (done.purpose !== "sign_in") throw new Error("unreachable");
      expect(done.provisioned).toBe(true);
      const principal = await identity.sessionResolver.resolve({ token: done.issued.token, transport: "cookie" });
      expect(principal?.role).toBe("staff");
      const [row] = await db.db.select().from(users).where(eq(users.id, principal!.userId));
      expect(row?.authSource).toBe("entra");
      expect(row?.passwordHash).toBeNull();
    });

    it("stops at the daily limit", async () => {
      await configure({ jitMode: "customers", jitDailyLimit: 1 });
      await (await signIn({ oid: oid() })).finish();
      await rejects((await signIn({ oid: oid() })).finish(), "SSO_PROVISIONING_LIMIT");
    });
  });

  /* ------------------------------------------------------------------ parked code (G-O01) */

  describe("session-bound flows park the code (two-step)", () => {
    it("link: the callback never exchanges; completion needs the initiating live session", async () => {
      await configure();
      const user = await makeUser();
      const { principal } = await session(user.email, { stepUp: true });
      const id = oid();
      const run = await sessionBound(principal, "link", { oid: id });
      expect(run.location).toMatch(/^\/sso\/complete\?attempt=/);
      expect(idp.calls.filter((c) => c.form)).toHaveLength(0); // nothing exchanged at the callback
      const [parked] = await db.db.select().from(ssoAuthRequests).where(eq(ssoAuthRequests.publicId, run.attempt));
      expect(parked?.codeEnc).toBeTruthy();
      expect(parked?.codeEnc).not.toContain("fake-code");
      const done = await sso().complete({ attempt: run.attempt, browser: run.browser, session: principal });
      expect(done.purpose).toBe("link");
      const [link] = await db.db.select().from(ssoIdentities).where(eq(ssoIdentities.userId, user.id));
      expect(link).toMatchObject({ objectId: id, linkMethod: "self" });
      const [after] = await db.db.select().from(ssoAuthRequests).where(eq(ssoAuthRequests.publicId, run.attempt));
      expect(after?.codeEnc).toBeNull();
    });

    it("no session: refused and the attempt is burned", async () => {
      await configure();
      const user = await makeUser();
      const { principal } = await session(user.email, { stepUp: true });
      const run = await sessionBound(principal, "link", { oid: oid() });
      await rejects(sso().complete({ attempt: run.attempt, browser: run.browser, session: null }), "SSO_SESSION_CHANGED");
      await rejects(sso().complete({ attempt: run.attempt, browser: run.browser, session: principal }), "SSO_EXPIRED");
      expect(idp.calls.filter((c) => c.form)).toHaveLength(0);
    });

    it("another session of the same user: refused (fails closed)", async () => {
      await configure();
      const user = await makeUser();
      const { principal } = await session(user.email, { stepUp: true });
      const other = (await session(user.email, { stepUp: true })).principal;
      const run = await sessionBound(principal, "link", { oid: oid() });
      await rejects(sso().complete({ attempt: run.attempt, browser: run.browser, session: other }), "SSO_SESSION_CHANGED");
      expect(await db.db.select().from(ssoIdentities).where(eq(ssoIdentities.userId, user.id))).toHaveLength(0);
    });

    it("replayed handle and wrong browser are refused", async () => {
      await configure();
      const user = await makeUser();
      const { principal } = await session(user.email, { stepUp: true });
      const run = await sessionBound(principal, "link", { oid: oid() });
      await rejects(sso().complete({ attempt: run.attempt, browser: "other-browser", session: principal }), "SSO_EXPIRED");
      await sso().complete({ attempt: run.attempt, browser: run.browser, session: principal });
      await rejects(sso().complete({ attempt: run.attempt, browser: run.browser, session: principal }), "SSO_EXPIRED");
    });

    it("an expired park cannot complete", async () => {
      await configure();
      const user = await makeUser();
      const { principal } = await session(user.email, { stepUp: true });
      const run = await sessionBound(principal, "link", { oid: oid() });
      h.clock.advance(2 * 60_000 + 1);
      await rejects(sso().complete({ attempt: run.attempt, browser: run.browser, session: principal }), "SSO_EXPIRED");
      expect(idp.calls.filter((c) => c.form)).toHaveLength(0);
    });

    it("test sign-in reports checks without linking or signing in", async () => {
      await configure({}, false);
      const run = await sessionBound(admin, "test", { oid: oid(), amr: ["pwd"] });
      const done = await sso().complete({ attempt: run.attempt, browser: run.browser, session: admin });
      if (done.purpose !== "test") throw new Error("unreachable");
      expect(done.test).toMatchObject({ signatureVerified: true, mfaClaimPresent: false, linkedToYou: false, linkedToAnotherAccount: false });
      expect(await db.db.select().from(ssoIdentities)).toHaveLength(0);
    });

    it("step-up re-authenticates an Entra session through assurance", async () => {
      await configure();
      const user = await makeUser({ mfa: false });
      const id = oid();
      await bind(user.publicId, id);
      const signed = await (await signIn({ oid: id })).finish();
      if (signed.purpose !== "sign_in") throw new Error("unreachable");
      const principal = (await identity.sessionResolver.resolve({ token: signed.issued.token, transport: "cookie" }))!;
      const run = await sessionBound(principal, "step_up", { oid: id });
      const done = await sso().complete({ attempt: run.attempt, browser: run.browser, session: principal });
      expect(done.purpose).toBe("step_up");
      expect(h.audit.named("auth.step_up.verified")).toHaveLength(1);
      // Without the MFA claim the proof is refused.
      const fresh = (await identity.sessionResolver.resolve({ token: (done as { issued: { token: string } }).issued.token, transport: "cookie" }))!;
      const weak = await sessionBound(fresh, "step_up", { oid: id, amr: ["pwd"] });
      await rejects(sso().complete({ attempt: weak.attempt, browser: weak.browser, session: fresh }), "SSO_MFA_REQUIRED");
    });
  });

  /* ------------------------------------------------------------------ configuration race (I-A02) */

  describe("configuration changes serialize with completion", () => {
    /** Holds a transaction at its in-tx audit write for `eventName` until released. */
    function gateAudit(eventName: string) {
      let release!: () => void;
      let reached!: () => void;
      const opened = new Promise<void>((resolve) => (release = resolve));
      const arrived = new Promise<void>((resolve) => (reached = resolve));
      const original = h.audit.record.bind(h.audit);
      h.audit.record = async (event: AuditEventInput, tx?: Tx) => {
        if (event.eventName === eventName) {
          reached();
          await opened;
        }
        return original(event, tx);
      };
      return { release, arrived };
    }

    async function prepared() {
      const user = await makeUser({ mfa: false });
      const id = oid();
      await bind(user.publicId, id);
      const run = await signIn({ oid: id });
      expect(run.location).toMatch(/^\/sso\/complete/);
      return { user, run };
    }

    it("trust withdrawn while a sign-in completes: the change wins, no full Entra session survives", async () => {
      const view = await configure();
      const { user, run } = await prepared();
      const gate = gateAudit("identity.sso.config_updated");
      const change = sso().updateConfig(admin, { ...baseConfig({ entraMfaMode: "portal" }), clientSecret: undefined, expectedVersion: view.version });
      await gate.arrived; // updateConfig holds the configuration lock
      const completion = run.finish();
      await new Promise((resolve) => setTimeout(resolve, 150));
      gate.release();
      await change;
      const done = await completion;
      if (done.purpose !== "sign_in") throw new Error("unreachable");
      expect(done.nextStep).not.toBeNull(); // evaluated under the NEW policy
      const live = await entraSessions(user.id);
      expect(live.every((s) => s.mfaVerifiedAt === null)).toBe(true);
    });

    it("completion first, then trust withdrawn: the new session is revoked", async () => {
      const view = await configure();
      const { user, run } = await prepared();
      const gate = gateAudit("auth.login.succeeded");
      const completion = run.finish();
      await gate.arrived; // completion holds the configuration lock
      const change = sso().updateConfig(admin, { ...baseConfig({ entraMfaMode: "portal" }), clientSecret: undefined, expectedVersion: view.version });
      await new Promise((resolve) => setTimeout(resolve, 150));
      gate.release();
      await completion;
      await change;
      expect(await entraSessions(user.id)).toHaveLength(0);
    });

    it("binding changed (epoch) after the callback: completion is refused", async () => {
      const view = await configure();
      const { user, run } = await prepared();
      await sso().updateConfig(admin, { ...baseConfig(), clientSecret: "rotated-client-secret-0002", expectedVersion: view.version });
      await rejects(run.finish(), "SSO_EXPIRED");
      expect(await entraSessions(user.id)).toHaveLength(0);
    });
  });

  /* ------------------------------------------------------------------ SAML 2.0 (increment 07, D10) */

  describe("SAML 2.0", () => {
    const sp = spUrls("https://portal.example.test", null);
    const requestIdOf = (url: string) => {
      const xml = inflateRawSync(Buffer.from(new URL(url).searchParams.get("SAMLRequest")!, "base64")).toString("utf8");
      return /ID="([^"]+)"/.exec(xml)![1]!;
    };

    async function configureSaml(patch: Partial<SsoConfigInput> = {}, opts: { cert?: boolean; enable?: boolean } = {}) {
      let view = await configure({ protocol: "saml", clientId: null, clientSecret: null, ...patch }, false);
      if (opts.cert !== false && !view.saml.certificates.some((c) => c.state === "trusted")) {
        await sso().saml.addCertificate(admin, { expectedVersion: view.version, pem: TEST_IDP.certificatePem });
        view = await sso().adminView();
      }
      if (opts.enable !== false) view = await sso().setEnabled(admin, true, view.version);
      return view;
    }

    async function samlSignIn(objectId: string, extra: Partial<Parameters<typeof buildSignedResponse>[0]> = {}) {
      const browser = `b-${randomUUID()}`;
      const url = await sso().startSignIn({ next: "/orders", browser });
      const inResponseTo = requestIdOf(url);
      const response = buildSignedResponse({ sp, inResponseTo, nowMs: h.clock.now().getTime(), tenantId: TENANT, objectId, ...extra });
      const location = await sso().acs({ samlResponse: response });
      return { location, response, inResponseTo, browser, finish: () => sso().complete({ attempt: attemptOf(location), browser, session: null, userAgent: "vitest" }) };
    }

    it("needs a trusted certificate before it can be enabled, then signs in a bound identity", async () => {
      const view = await configureSaml({}, { cert: false, enable: false });
      expect(view.protocol).toBe("saml");
      expect(view.complete).toBe(false);
      await rejects(sso().setEnabled(admin, true, view.version), "SSO_SAML_CERTIFICATE_REQUIRED");
      await sso().saml.addCertificate(admin, { expectedVersion: view.version, pem: TEST_IDP.certificatePem });
      const enabled = await sso().setEnabled(admin, true, (await sso().adminView()).version);
      expect(enabled.enabled).toBe(true);
      expect(enabled.saml.certificates[0]?.state).toBe("trusted");
      expect(await sso().samlMetadata()).toContain(sp.acsUrl);

      const user = await makeUser({ mfa: false });
      const id = oid();
      await bind(user.publicId, id);
      const run = await samlSignIn(id);
      expect(run.location).toMatch(/^\/sso\/complete\?attempt=[0-9A-Z]{26}$/);
      const done = await run.finish();
      if (done.purpose !== "sign_in") throw new Error("unreachable");
      const principal = await identity.sessionResolver.resolve({ token: done.issued.token, transport: "cookie" });
      expect(principal?.authMethod).toBe("entra");
      expect(principal?.state).toBe("full"); // claim mode + multipleauthn
      const login = h.audit.named("auth.login.succeeded").at(-1)!;
      expect(login.attributes).toMatchObject({ protocol: "saml", mfa_mode: "claim", mfa_basis: "saml_claim" });
      expect(JSON.stringify([...h.audit.events, ...h.audit.notes])).not.toContain(run.response.slice(0, 40));
    });

    it("refuses a replayed response (InResponseTo is single use) and a response for no request", async () => {
      await configureSaml();
      const user = await makeUser();
      const id = oid();
      await bind(user.publicId, id);
      const run = await samlSignIn(id);
      expect(reasonOf(await sso().acs({ samlResponse: run.response }))).toBe("SSO_EXPIRED");
      const stray = buildSignedResponse({ sp, inResponseTo: `_${"x".repeat(30)}`, nowMs: h.clock.now().getTime(), tenantId: TENANT, objectId: id });
      expect(reasonOf(await sso().acs({ samlResponse: stray }))).toBe("SSO_EXPIRED");
      expect(h.audit.named("identity.sso.callback_refused").length).toBeGreaterThanOrEqual(2);
      await run.finish();
    });

    it("refuses forged responses and maps an IdP error to cancelled", async () => {
      await configureSaml();
      const run = await samlSignIn(oid(), { unsigned: true });
      expect(reasonOf(run.location)).toBe("SSO_FAILED");
      const cancelled = await samlSignIn(oid(), { statusCode: "urn:oasis:names:tc:SAML:2.0:status:Responder" });
      expect(reasonOf(cancelled.location)).toBe("SSO_CANCELLED");
      expect(reasonOf(await sso().acs({ samlResponse: undefined }))).toBe("SSO_FAILED");
    });

    it("MFA modes: portal always asks, entra never asks, claim follows multipleauthn", async () => {
      const user = await makeUser({ mfa: false });
      const id = oid();
      await configureSaml({ entraMfaMode: "portal" });
      await bind(user.publicId, id);
      const portal = await (await samlSignIn(id)).finish();
      if (portal.purpose !== "sign_in") throw new Error("unreachable");
      expect(portal.nextStep).not.toBeNull();

      let view = await sso().adminView();
      await rejects(sso().updateConfig(admin, { ...baseConfig({ protocol: "saml", clientId: null, clientSecret: undefined, entraMfaMode: "entra" }), expectedVersion: view.version }), "SSO_ENTRA_MODE_CONFIRMATION");
      view = await sso().updateConfig(admin, { ...baseConfig({ protocol: "saml", clientId: null, clientSecret: undefined, entraMfaMode: "entra", entraModeConfirmation: "ENTRA MANAGES MFA" }), expectedVersion: view.version });
      expect(view.entraMfaMode).toBe("entra");
      const changed = h.audit.named("identity.sso.mfa_mode_changed").at(-1)!;
      expect(changed.severity).toBe("WARN");
      const entra = await (await samlSignIn(id, { methods: ["http://schemas.microsoft.com/ws/2008/06/identity/authenticationmethod/password"] })).finish();
      if (entra.purpose !== "sign_in") throw new Error("unreachable");
      expect(entra.nextStep).toBeNull();

      // Back to claim (stricter): Entra sessions are revoked; a password-only Entra sign-in needs the portal factor.
      await sso().updateConfig(admin, { ...baseConfig({ protocol: "saml", clientId: null, clientSecret: undefined, entraMfaMode: "claim" }), expectedVersion: view.version });
      expect(await entraSessions(user.id)).toHaveLength(0);
      const weak = await (await samlSignIn(id, { methods: ["http://schemas.microsoft.com/ws/2008/06/identity/authenticationmethod/password"] })).finish();
      if (weak.purpose !== "sign_in") throw new Error("unreachable");
      expect(weak.nextStep).not.toBeNull();
    });

    it("refuses roles that may not use SSO, and revokes their sessions when a role is removed", async () => {
      await configureSaml({ allowedRoles: ["admin", "staff"] });
      const customer = await makeUser({ role: "customer" });
      const id = oid();
      await bind(customer.publicId, id);
      await rejects((await samlSignIn(id)).finish(), "SSO_ROLE_NOT_ALLOWED");

      const staff = await makeUser({ role: "staff" });
      const sid = oid();
      await bind(staff.publicId, sid);
      await (await samlSignIn(sid)).finish();
      expect(await entraSessions(staff.id)).toHaveLength(1);
      const view = await sso().adminView();
      await sso().updateConfig(admin, { ...baseConfig({ protocol: "saml", clientId: null, clientSecret: undefined, allowedRoles: ["admin"] }), expectedVersion: view.version });
      expect(await entraSessions(staff.id)).toHaveLength(0);
    });

    it("provisions by app-role mapping, never as administrator", async () => {
      const view = await configureSaml({ jitMode: "staff", jitStaffAppRole: "Portal.LegacyStaff", allowedRoles: ["admin", "staff", "customer"] });
      await sso().saml.setRoleMappings(admin, { expectedVersion: view.version, mappings: [{ appRoleValue: "Portal.Staff", role: "staff" }, { appRoleValue: "Portal.Customer", role: "customer" }] });
      const email = `jit.${randomUUID().slice(0, 6)}@contoso.test`;
      const staff = await (await samlSignIn(oid(), { email, roles: ["Portal.Staff"] })).finish();
      if (staff.purpose !== "sign_in") throw new Error("unreachable");
      expect(staff.provisioned).toBe(true);
      const principal = await identity.sessionResolver.resolve({ token: staff.issued.token, transport: "cookie" });
      expect(principal?.role).toBe("staff");
      await rejects((await samlSignIn(oid(), { email: `none.${randomUUID().slice(0, 6)}@contoso.test`, roles: ["Unmapped"] })).finish(), "SSO_ROLE_NOT_ASSIGNED");
    });

    it("an older row (no MFA mode, no allowed roles) keeps its previous behaviour", async () => {
      await configureSaml();
      await db.db.update(ssoConfiguration).set({ entraMfaMode: null, allowedRoles: null, trustEntraMfa: false });
      const view = await sso().adminView();
      expect(view.entraMfaMode).toBe("portal");
      expect(view.allowedRoles).toEqual(["admin", "staff", "customer"]);
      const user = await makeUser({ role: "customer", mfa: false });
      const id = oid();
      await bind(user.publicId, id);
      const done = await (await samlSignIn(id)).finish();
      if (done.purpose !== "sign_in") throw new Error("unreachable");
      expect(done.nextStep).not.toBeNull();
    });

    it("a protocol switch cancels pending attempts but keeps sessions", async () => {
      await configureSaml({ clientId: CLIENT, clientSecret: SECRET });
      const user = await makeUser();
      const id = oid();
      await bind(user.publicId, id);
      await (await samlSignIn(id)).finish();
      const pending = await samlSignIn(id);
      const view = await sso().adminView();
      await sso().updateConfig(admin, { ...baseConfig({ protocol: "oidc", clientSecret: undefined }), expectedVersion: view.version });
      await rejects(pending.finish(), "SSO_EXPIRED");
      expect(await entraSessions(user.id)).toHaveLength(1);
    });
  });

  /* ------------------------------------------------------------------ hygiene */

  it("never records the code, state, secret or ID token in audit", async () => {
    await configure();
    const user = await makeUser();
    const id = oid();
    await bind(user.publicId, id);
    const run = await signIn({ oid: id });
    await run.finish();
    await signIn({ oid: oid(), signWith: idp.otherKey() });
    const text = JSON.stringify([...h.audit.events, ...h.audit.notes]);
    for (const secret of [run.code, run.state, SECRET, "fake-code-"]) expect(text).not.toContain(secret);
    expect(run.location).not.toContain(run.code);
    expect(run.location).not.toContain(run.state);
  });

  it("lists sign-in methods for staff and customer lists", async () => {
    await configure();
    const user = await makeUser();
    await bind(user.publicId, oid());
    const methods = await sso().signInMethods([user.publicId, admin.userPublicId]);
    expect(methods.get(user.publicId)).toEqual({ password: true, sso: "pending" });
    expect(methods.get(admin.userPublicId)).toEqual({ password: true, sso: null });
  });
});

/* -------------------------------------------------------------------- pure OIDC */

describe("oidc helpers", () => {
  it("builds a single-tenant PKCE authorization URL; step-up forces re-authentication", () => {
    const url = new URL(authorizationUrl({ tenantId: TENANT, clientId: CLIENT, redirectUri: "https://p.test/api/identity/sso/callback", state: "s", nonce: "n", verifier: "v".repeat(64), forceReauthentication: true }));
    expect(url.origin + url.pathname).toBe(entraEndpoints(TENANT).authorize);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("prompt")).toBe("login");
    expect(url.searchParams.get("max_age")).toBe("0");
    expect(() => entraEndpoints("common")).toThrow();
  });

  it("refuses non-RS256 headers before any key lookup", () => {
    const token = (header: object) => `${Buffer.from(JSON.stringify(header)).toString("base64url")}.e30.`;
    expect(() => peekKeyId(token({ alg: "none", kid: "k" }))).toThrow(OidcValidationError);
    expect(() => peekKeyId(token({ alg: "HS256", kid: "k" }))).toThrow(OidcValidationError);
    expect(() => peekKeyId(token({ alg: "RS256", kid: "k", crit: ["x"] }))).toThrow(OidcValidationError);
    expect(peekKeyId(token({ alg: "RS256", kid: "k" }))).toBe("k");
  });

  it("verifies a fixture token and rejects a tampered payload", async () => {
    let now = 1_800_000_000;
    const idp = createFakeEntra({ tenantId: TENANT, clientId: CLIENT, nowSeconds: () => now });
    const authorize = authorizationUrl({ tenantId: TENANT, clientId: CLIENT, redirectUri: "https://p.test/cb", state: "s", nonce: "nonce-1", verifier: "v".repeat(64), forceReauthentication: false });
    const { code } = idp.authorize(authorize, { oid: "12345678-1234-4234-8234-123456789012" });
    const res = await idp.fetchPinned(entraEndpoints(TENANT).token, "entra_oidc", { method: "POST", body: new URLSearchParams({ client_id: CLIENT, code, code_verifier: "x" }).toString() });
    const idToken = (JSON.parse(res.body.toString()) as { id_token: string }).id_token;
    const keys = (JSON.parse((await idp.fetchPinned(entraEndpoints(TENANT).jwks, "entra_oidc")).body.toString()) as { keys: never[] }).keys;
    const claims = verifyIdToken(idToken, keys[0]!, { tenantId: TENANT, clientId: CLIENT, nonce: "nonce-1", nowSeconds: now });
    expect(claims.objectId).toBe("12345678-1234-4234-8234-123456789012");
    const [hd, , sig] = idToken.split(".");
    const forged = `${hd}.${Buffer.from(JSON.stringify({ oid: "x" })).toString("base64url")}.${sig}`;
    expect(() => verifyIdToken(forged, keys[0]!, { tenantId: TENANT, clientId: CLIENT, nonce: "nonce-1", nowSeconds: now })).toThrow(OidcValidationError);
    now += 10_000;
    expect(() => verifyIdToken(idToken, keys[0]!, { tenantId: TENANT, clientId: CLIENT, nonce: "nonce-1", nowSeconds: now })).toThrow(OidcValidationError);
  });
});
