import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDeps } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import type { Services } from "../../container.js";
import { randomToken, ulid } from "../../core/ids.js";
import type { SessionPrincipal } from "../../core/types.js";
import { createIdentityModule } from "../identity/index.js";
import { identityTokens, sessionRestrictions, signInEvents, ssoAuthRequests, ssoConfiguration, ssoIdentities, users, userSessions } from "../identity/schema.js";
import { entraEndpoints, pkceChallenge, verifyIdToken } from "../identity/sso/oidc.js";
import { emailColumns, nameColumns } from "../identity/users.js";
import { assessEntraSignIn, isFreshEntraAuthentication } from "./entra.js";
import { createAssuranceModule } from "./index.js";
import * as assuranceSchema from "./schema.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const otherTenant = "22222222-2222-4222-8222-222222222222";
const clientId = "33333333-3333-4333-8333-333333333333";
const oid = "44444444-4444-4444-8444-444444444444";
const nonce = "synthetic-nonce";
const nowSeconds = 1_800_000_000;
const expected = { tenantId, clientId, nonce, nowSeconds };
const completionPath = /^\/sso\/complete\?attempt=[0-9A-HJKMNP-TV-Z]{26}$/;
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });
const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString("base64url");
const claims = {
  iss: entraEndpoints(tenantId).issuer, tid: tenantId, aud: clientId, oid, sub: "synthetic-subject",
  exp: nowSeconds + 300, iat: nowSeconds, auth_time: nowSeconds, nonce, amr: ["pwd", "mfa"],
};
function token(overrides: Record<string, unknown> = {}, alg = "RS256", signed = true): string {
  const payload = `${encode({ alg, kid: "synthetic" })}.${encode({ ...claims, ...overrides })}`;
  const signature = signed ? sign("RSA-SHA256", Buffer.from(payload), privateKey).toString("base64url") : "";
  return `${payload}.${signature}`;
}

describe("Entra ID assurance claim boundary", () => {
  it("rejects a correctly signed token from another tenant or for another application", () => {
    expect(() => verifyIdToken(token({ tid: otherTenant }), jwk, expected)).toThrow("TOKEN_TENANT_MISMATCH");
    expect(() => verifyIdToken(token({ tid: otherTenant, iss: entraEndpoints(otherTenant).issuer }), jwk, expected))
      .toThrow("TOKEN_ISSUER_MISMATCH");
    expect(() => verifyIdToken(token({ aud: "other-app" }), jwk, expected)).toThrow("TOKEN_AUDIENCE_MISMATCH");
  });

  it("rejects unsigned tokens and the none algorithm before accepting any authentication claims", () => {
    expect(() => verifyIdToken(token({}, "RS256", false), jwk, expected)).toThrow("TOKEN_MALFORMED");
    expect(() => verifyIdToken(token({}, "none", false), jwk, expected)).toThrow("TOKEN_ALG_NOT_ALLOWED");
  });

  it("allows validated trusted MFA at ordinary sign-in, but never uses a fresh issue time as fresh authentication", () => {
    const verified = verifyIdToken(token({ auth_time: nowSeconds - 1 }), jwk, expected);
    const now = new Date(nowSeconds * 1000);
    expect(assessEntraSignIn(verified.amr, false).mfaVerified).toBe(false);
    expect(assessEntraSignIn(verified.amr, true).mfaVerified).toBe(true);
    expect(isFreshEntraAuthentication(verified.authTime!, now, now)).toBe(false);
    expect(isFreshEntraAuthentication(verifyIdToken(token(), jwk, expected).authTime!, now, now)).toBe(true);
  });
});

describe("Assurance through the Entra callback and completion service", () => {
  let db: TestDb;
  let h: ReturnType<typeof createTestDeps>;
  let service: Services["identity"]["sso"];
  let fetchPinned: ReturnType<typeof vi.fn<Services["integrations"]["egress"]["fetchPinned"]>>;
  const provider = new Map<string, { token: string; challenge: string }>();
  const endpoint = entraEndpoints(tenantId);

  beforeAll(async () => {
    db = await createTestDb({ schema: { users, userSessions, identityTokens, sessionRestrictions, signInEvents, ssoAuthRequests, ssoConfiguration, ssoIdentities, ...assuranceSchema } });
  });
  afterAll(() => db?.cleanup());
  beforeEach(async () => {
    provider.clear();
    h = createTestDeps({ db: db.db, now: new Date(nowSeconds * 1000) });
    h.services.assurance = createAssuranceModule(h.deps);
    h.services.identity = createIdentityModule(h.deps);
    fetchPinned = vi.fn<Services["integrations"]["egress"]["fetchPinned"]>(async (url, _purpose, options) => {
      const response = (value: unknown) => ({ status: 200, headers: {}, body: Buffer.from(JSON.stringify(value)) });
      if (url === endpoint.jwks && options?.method === "GET") return response({ keys: [{ ...jwk, kid: "synthetic", alg: "RS256", use: "sig" }] });
      if (url !== endpoint.token || options?.method !== "POST" || typeof options.body !== "string") throw new Error("unexpected synthetic provider request");
      const form = new URLSearchParams(options.body);
      const choice = provider.get(form.get("code")!);
      if (!choice || form.get("client_id") !== clientId || pkceChallenge(form.get("code_verifier")!) !== choice.challenge
        || form.get("redirect_uri") !== `${h.deps.config.canonicalOrigin}/api/identity/sso/callback`) throw new Error("synthetic provider rejected exchange");
      provider.delete(form.get("code")!);
      return response({ id_token: choice.token });
    });
    h.services.integrations = { egress: { fetchPinned } } as unknown as Services["integrations"];
    service = h.services.identity.sso;
    await db.db.delete(ssoConfiguration);
    await db.db.insert(ssoConfiguration).values({
      id: 1, enabled: true, clientId, tenantId, trustEntraMfa: true,
      clientSecretEnc: h.deps.crypto.encrypt("synthetic-secret", "sso_configuration.client_secret"),
    });
  });

  async function seed(options: { linked: boolean; status?: "active" | "deactivated" }) {
    const publicId = ulid(+h.clock.now());
    const objectId = randomUUID();
    const email = `${publicId.toLowerCase()}@example.test`;
    const [created] = await db.db.insert(users).values({
      publicId, emailVerifiedAt: h.clock.now(), status: options.status ?? "active",
      ...emailColumns(h.deps.crypto, publicId, email), ...nameColumns(h.deps.crypto, publicId, "Synthetic"),
    }).$returningId();
    const id = created!.id;
    if (options.linked) await db.db.insert(ssoIdentities).values({ userId: id, tenantId, objectId, linkMethod: "admin", linkedAt: h.clock.now(), verifiedAt: h.clock.now() });
    return { id, objectId, email };
  }

  async function prepare(options: { claims?: Record<string, unknown>; session?: SessionPrincipal; alg?: string; signed?: boolean } = {}) {
    const browser = randomToken(32);
    let authorization: string;
    if (options.session) {
      const { startUrl } = await service.prepare(options.session, "step_up", null);
      const ticket = new URL(startUrl, h.deps.config.canonicalOrigin).searchParams.get("ticket")!;
      authorization = await service.startWithTicket({ ticket, browser, session: options.session });
    } else {
      authorization = await service.startSignIn({ next: null, browser });
    }
    const params = new URL(authorization).searchParams;
    if (options.session) expect(params.get("max_age")).toBe("0");
    const code = randomToken(24);
    provider.set(code, {
      challenge: params.get("code_challenge")!,
      token: token({ nonce: params.get("nonce"), ...options.claims }, options.alg, options.signed),
    });
    const state = params.get("state")!;
    let attempt = "";
    const callback = async (binding = browser) => {
      const path = await service.callback({ browser: binding, state, code, error: undefined });
      if (completionPath.test(path)) attempt = new URL(path, h.deps.config.canonicalOrigin).searchParams.get("attempt")!;
      return path;
    };
    const complete = (session: SessionPrincipal | null = null, binding = browser) => service.complete({ attempt, browser: binding, session });
    return { callback, complete };
  }

  it("binds state to a browser, consumes it once, and allows just one existing linked sign-in", async () => {
    const user = await seed({ linked: true });
    const flow = await prepare({ claims: { oid: user.objectId, email: user.email } });
    await expect(flow.callback(randomToken(32))).resolves.toBe("/sso/refused?reason=SSO_EXPIRED");
    expect(fetchPinned).not.toHaveBeenCalled();
    const results = await Promise.all([flow.callback(), flow.callback()]);
    expect(results.sort()).toEqual([expect.stringMatching(completionPath), "/sso/refused?reason=SSO_EXPIRED"]);
    expect(fetchPinned.mock.calls.filter(([url]) => url === endpoint.token)).toHaveLength(1);
    await expect(flow.complete(null, randomToken(32))).rejects.toMatchObject({ reasonCode: "SSO_EXPIRED" });
    const completed = await flow.complete();
    expect(completed).toMatchObject({ purpose: "sign_in", provisioned: false, nextStep: null });
    await expect(flow.complete()).rejects.toMatchObject({ reasonCode: "SSO_EXPIRED" });
    expect(await db.db.select().from(userSessions).where(eq(userSessions.userId, user.id))).toHaveLength(1);
  });

  it("refuses wrong tenant, wrong audience and unsigned callbacks without issuing a session", async () => {
    const user = await seed({ linked: true });
    for (const variant of [{ claims: { tid: otherTenant } }, { claims: { aud: "other-app" } }, { signed: false }, { alg: "none", signed: false }]) {
      const flow = await prepare({ ...variant, claims: { oid: user.objectId, ...variant.claims } });
      await expect(flow.callback()).resolves.toBe("/sso/refused?reason=SSO_FAILED");
      await expect(flow.complete()).rejects.toMatchObject({ reasonCode: "SSO_EXPIRED" });
    }
    expect(await db.db.select().from(userSessions).where(eq(userSessions.userId, user.id))).toHaveLength(0);
  });

  it("refuses unlinked and deactivated identities and will not link an existing email during JIT", async () => {
    const unlinked = await seed({ linked: false });
    const inactive = await seed({ linked: true, status: "deactivated" });
    for (const [user, reasonCode] of [[unlinked, "SSO_NOT_LINKED"], [inactive, "SSO_ACCOUNT_INACTIVE"]] as const) {
      const flow = await prepare({ claims: { oid: user.objectId, email: user.email } });
      await expect(flow.callback()).resolves.toMatch(completionPath);
      await expect(flow.complete()).rejects.toMatchObject({ reasonCode });
      expect(await db.db.select().from(userSessions).where(eq(userSessions.userId, user.id))).toHaveLength(0);
    }
    await db.db.update(ssoConfiguration).set({ jitMode: "customers" }).where(eq(ssoConfiguration.id, 1));
    const flow = await prepare({ claims: { oid: unlinked.objectId, email: unlinked.email } });
    await expect(flow.callback()).resolves.toMatch(completionPath);
    await expect(flow.complete()).rejects.toMatchObject({ reasonCode: "SSO_ACCOUNT_EXISTS" });
    expect(await db.db.select().from(ssoIdentities).where(eq(ssoIdentities.userId, unlinked.id))).toHaveLength(0);
    expect(await db.db.select().from(userSessions).where(eq(userSessions.userId, unlinked.id))).toHaveLength(0);
  });

  it("requires local MFA when Entra trust is off, and requires local sign-in for a forced password change even when trust is on", async () => {
    const user = await seed({ linked: true });
    const identity = { oid: user.objectId, email: user.email };
    await db.db.update(ssoConfiguration).set({ trustEntraMfa: false }).where(eq(ssoConfiguration.id, 1));
    const fallback = await prepare({ claims: identity });
    await expect(fallback.callback()).resolves.toMatch(completionPath);
    await expect(fallback.complete()).resolves.toMatchObject({ purpose: "sign_in", nextStep: "enroll_mfa" });

    await db.db.update(users).set({ mustChangePassword: true }).where(eq(users.id, user.id));
    await db.db.update(ssoConfiguration).set({ trustEntraMfa: true }).where(eq(ssoConfiguration.id, 1));
    const forcedChange = await prepare({ claims: identity });
    await expect(forcedChange.callback()).resolves.toMatch(completionPath);
    await expect(forcedChange.complete()).rejects.toMatchObject({ reasonCode: "SSO_LOCAL_SIGN_IN_REQUIRED" });
    expect(await db.db.select().from(userSessions).where(eq(userSessions.userId, user.id))).toHaveLength(1);
  });

  it("only elevates the original portal session with the same linked identity and fresh MFA", async () => {
    const user = await seed({ linked: true });
    const another = await seed({ linked: true });
    const login = await prepare({ claims: { oid: user.objectId, email: user.email } });
    await expect(login.callback()).resolves.toMatch(completionPath);
    const signedIn = await login.complete();
    if (signedIn.purpose !== "sign_in") throw new Error("expected sign-in");
    const resolve = (token: string) => h.services.identity.sessionResolver.resolve({ token, transport: "cookie" });
    const principal = (await resolve(signedIn.issued.token))!;
    expect(principal).toMatchObject({ state: "full", authMethod: "entra", stepUpAt: null });
    for (const [proof, reasonCode, session] of [
      [{ oid: user.objectId, auth_time: nowSeconds - 1 }, "SSO_MFA_REQUIRED", principal],
      [{ oid: user.objectId, amr: ["pwd"] }, "SSO_MFA_REQUIRED", principal],
      [{ oid: another.objectId }, "SSO_WRONG_ACCOUNT", principal],
      [{ oid: user.objectId }, "SSO_SESSION_CHANGED", { ...principal, sessionId: ulid() }],
    ] as const) {
      const flow = await prepare({ session: principal, claims: proof });
      const exchanges = fetchPinned.mock.calls.filter(([url]) => url === endpoint.token).length;
      await expect(flow.callback()).resolves.toMatch(completionPath);
      expect(fetchPinned.mock.calls.filter(([url]) => url === endpoint.token)).toHaveLength(exchanges);
      await expect(flow.complete(session)).rejects.toMatchObject({ reasonCode });
      if (reasonCode === "SSO_SESSION_CHANGED") {
        expect(fetchPinned.mock.calls.filter(([url]) => url === endpoint.token)).toHaveLength(exchanges);
        await expect(flow.complete(principal)).rejects.toMatchObject({ reasonCode: "SSO_EXPIRED" });
      }
      await expect(resolve(signedIn.issued.token)).resolves.toMatchObject({ stepUpAt: null });
    }
    const verified = await prepare({ session: principal, claims: { oid: user.objectId } });
    await expect(verified.callback()).resolves.toMatch(completionPath);
    const elevated = await verified.complete(principal);
    if (elevated.purpose !== "step_up") throw new Error("expected step-up");
    await expect(resolve(signedIn.issued.token)).resolves.toBeNull();
    await expect(resolve(elevated.issued.token)).resolves.toMatchObject({ state: "full", stepUpAt: h.clock.now() });
    expect(h.audit.named("auth.step_up.verified")).toMatchObject([{ provider: "entra", attributes: { auth_method: "entra" } }]);
  });
});
