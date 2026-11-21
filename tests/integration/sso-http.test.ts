/**
 * Entra ID SSO over the assembled HTTP pipeline (real createApp, real MySQL, FAKE identity provider from
 * server/modules/identity/sso/testing.ts behind a substituted egress `fetchPinned`; no network).
 * Proves: the cross-site provider GET callback is not refused by the edge, the binder cookie is Lax/HttpOnly,
 * responses are no-store/no-referrer, the auth material never reaches a response/redirect/audit row, the
 * completion is a CSRF-protected POST, and only the canonical routes exist (aliases 404).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "../../server/core/types.js";
import { ssoConfiguration, ssoIdentities } from "../../server/modules/identity/schema.js";
import { createFakeEntra, type FakeEntra } from "../../server/modules/identity/sso/testing.js";
import { createSystem, responseLog, type System } from "./harness.js";

const TENANT = "11111111-2222-4333-8444-555555555555";
const CLIENT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

let sys: System;
let idp: FakeEntra;
const objectId = randomUUID();

beforeAll(async () => {
  sys = await createSystem();
  const { services } = sys.container;
  idp = createFakeEntra({ tenantId: TENANT, clientId: CLIENT, nowSeconds: () => Math.floor(sys.clock.now().getTime() / 1000) });
  (services.integrations.egress as { fetchPinned: unknown }).fetchPinned = idp.fetchPinned;
  await sys.t.db.insert(ssoConfiguration).values({
    id: 1, enabled: true, tenantId: TENANT, clientId: CLIENT,
    clientSecretEnc: services.crypto.encrypt("fake-client-secret-value-0001", "sso_configuration.client_secret"), clientSecretLast4: "0001",
    trustEntraMfa: true,
  });
  const created = await sys.t.db.transaction((tx) => services.identity.auth.insertUser(tx as Tx, {
    email: "ella.entra@contoso.test", name: "Ella Entra", role: "customer", status: "active", origin: "test", emailVerifiedAt: sys.clock.now(),
  }));
  await sys.t.db.insert(ssoIdentities).values({ userId: created.id, provider: "entra", tenantId: TENANT, objectId, linkMethod: "admin", linkedAt: sys.clock.now(), verifiedAt: sys.clock.now() });
}, 120_000);

afterAll(async () => sys?.close());

describe("SSO HTTP routes", () => {
  it("start → cross-site callback → CSRF-protected completion issues a session", async () => {
    const browser = sys.browser({ fetchSite: "none", origin: null });
    const logFrom = responseLog.length;
    const start = browser.absorb(await browser.raw("get", "/api/identity/sso/start?next=%2Forders"));
    expect(start.status).toBe(303);
    expect(start.headers["cache-control"]).toBe("no-store");
    expect(String(start.headers.location)).toMatch(/^https:\/\/login\.microsoftonline\.com\/11111111-2222-4333-8444-555555555555\/oauth2\/v2\.0\/authorize\?/);
    const binder = browser.setCookies.find((line) => /^(__Host-rp_sso|rp_sso_dev)=/.test(line))!;
    expect(binder).toMatch(/HttpOnly/i);
    expect(binder).toMatch(/SameSite=Lax/i);
    expect(binder).toMatch(/Path=\//);

    const { state, code } = idp.authorize(String(start.headers.location), { oid: objectId, email: "ella.entra@contoso.test" });
    // The provider redirect arrives as a top-level cross-site navigation without Origin.
    const crossSite = sys.browser({ fetchSite: "cross-site", origin: null });
    for (const [name, record] of browser.jar) crossSite.jar.set(name, record);
    const callback = crossSite.absorb(await crossSite.raw("get", `/api/identity/sso/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}&session_state=x`));
    expect(callback.status).toBe(303);
    expect(callback.headers["referrer-policy"]).toBe("no-referrer");
    const location = String(callback.headers.location);
    expect(location).toMatch(/^\/sso\/complete\?attempt=[0-9A-Z]{26}$/);
    const attempt = new URL(`https://x.test${location}`).searchParams.get("attempt")!;

    // Same-origin SPA page posts the opaque handle; CSRF is required.
    const spa = sys.browser();
    for (const [name, record] of crossSite.jar) spa.jar.set(name, record);
    const noCsrf = await spa.raw("post", "/api/identity/sso/complete", { csrf: null }).send({ attempt });
    expect(noCsrf.status).toBe(403);
    await spa.primeCsrf();
    const done = spa.absorb(await spa.raw("post", "/api/identity/sso/complete").send({ attempt }));
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ purpose: "sign_in", next: "/orders" });
    expect(spa.sessionToken).toBeTruthy();
    const me = await spa.query<{ session: { authMethod: string } }>("identity.me");
    expect(me.data.session.authMethod).toBe("entra");

    // Replay of the handle fails closed.
    const replay = await spa.raw("post", "/api/identity/sso/complete").send({ attempt });
    expect(replay.status).toBeGreaterThanOrEqual(400);

    // Auth material never appears in any response, redirect or audit row.
    // (responseLog.path is the request we sent; only what the server returned is checked.)
    // The start redirect necessarily carries state to Entra; everything after it must not.
    const responses = JSON.stringify(responseLog.slice(logFrom + 1).map(({ headers, text }) => ({ headers, text })));
    const audit = JSON.stringify(await sys.audit({}));
    for (const secret of [code, state, "fake-client-secret-value-0001"]) {
      expect(responses).not.toContain(secret);
      expect(audit).not.toContain(secret);
    }
  });

  it("serves only the canonical paths", async () => {
    const browser = sys.browser({ fetchSite: "cross-site", origin: null });
    for (const path of ["/api/auth/sso/callback?code=a&state=b", "/api/identity/sso/callback/?code=a&state=b", "/api/identity/SSO/callback?code=a&state=b", "/api/identity/sso/start/"]) {
      const res = await browser.raw("get", path);
      expect(res.status, path).not.toBe(303);
      expect(res.headers.location, path).toBeUndefined();
    }
  });

  it("an unknown state is refused with a generic reason", async () => {
    const browser = sys.browser({ fetchSite: "cross-site", origin: null });
    const res = await browser.raw("get", `/api/identity/sso/callback?code=${"c".repeat(20)}&state=${"s".repeat(43)}`);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/sso/refused?reason=SSO_EXPIRED");
  });
});
