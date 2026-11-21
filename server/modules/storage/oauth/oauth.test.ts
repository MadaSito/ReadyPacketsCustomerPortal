import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { Router } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HEADER_CSRF } from "../../../../shared/sessionTransportHeaders.js";
import { createTestDeps, fakePrincipal, silentLogger } from "../../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../../tests/helpers/testDb.js";
import { forbidden } from "../../../core/errors.js";
import type { SessionPrincipal } from "../../../core/types.js";
import { createApp } from "../../../http/app.js";
import { deriveSessionCsrfToken } from "../../../security/csrf.js";
import { router } from "../../../trpc/trpc.js";
import type { EgressFetchResponse } from "../../integrations/egress.js";
import { createStorageModule } from "../index.js";
import { storageConnections } from "../schema.js";
import { registerStorageOAuthRoutes } from "./http.js";
import type { StorageRequest } from "./provider.js";
import { registerStorageOAuthAdapters } from "./register.js";
import { storageOAuthAttempts } from "./schema.js";
import { OAUTH_TTL_MS, storageOAuthService } from "./service.js";

vi.mock("../../../trpc/root.js", () => ({ appRouter: undefined }));
vi.mock("../../../http/moduleRoutes.js", () => ({ createModuleHttpRouter: vi.fn() }));
vi.mock("../../integrations/http.js", () => ({ registerSignedIntegrationWebhooks: vi.fn() }));

const response = (status: number, value: unknown = {}): EgressFetchResponse => ({ status, headers: {}, body: Buffer.from(JSON.stringify(value)) });
const secret = "synthetic-client-secret-never-echo";
const refresh = "synthetic-refresh-grant-never-echo";
const code = "synthetic-code-never-log";
const grant = { token_type: "Bearer", access_token: "synthetic-access-token", refresh_token: refresh, expires_in: 3_600 };
const host = "my.readypackets.test";
const origin = `https://${host}`;
const cb = "/api/storage/oauth/callback/dropbox";

let t: TestDb;
beforeAll(async () => { t = await createTestDb({ schema: { storageConnections, storageOAuthAttempts } }); }, 20_000);
afterAll(async () => { await t?.cleanup(); });

async function fixture(kind: "dropbox" | "google_drive" = "dropbox") {
  const h = createTestDeps({ db: t.db, config: { canonicalOrigin: origin, aliasHosts: ["portal.readypackets.test"] } });
  let allowed = true;
  const principal = fakePrincipal({ role: "admin", stepUpAt: h.clock.now() });
  const current = vi.fn(async (actor: SessionPrincipal) => {
    if (!allowed || actor.sessionId !== principal.sessionId || actor.csrfSecret !== principal.csrfSecret) throw forbidden("SESSION_NOT_CURRENT");
    return { role: "admin" as const, stepUpAt: principal.stepUpAt, pendingSteps: [], mfaVerifiedAt: principal.mfaVerifiedAt };
  });
  h.services.identity = { sessions: { assertCurrent: current } } as unknown as typeof h.services.identity;
  h.services.sessionResolver = { resolve: async ({ token }) => token === "synthetic-admin-session" ? principal : null };
  const network = vi.fn<StorageRequest>().mockResolvedValue(response(200, grant));
  const fetchPinned = vi.fn(async (url, _purpose, options) => network(url, options));
  h.services.integrations = { egress: { fetchPinned } } as unknown as typeof h.services.integrations;
  h.services.storageConnections = createStorageModule(h.deps);
  registerStorageOAuthAdapters(h.services);
  const connection = await h.services.storageConnections.connections.create(principal, {
    kind, name: "Synthetic cloud connection", config: { clientId: "synthetic-app" }, credentials: { clientSecret: secret },
  });
  const target = { provider: kind, publicId: connection.publicId, expectedVersion: connection.version };
  const oauth = storageOAuthService(h.services, () => network);
  return { h, oauth, target, network, fetchPinned, principal, current, revokeSession: () => { allowed = false; } };
}

function callbackData(authorization: { authorizeUrl: string; binder: string }) {
  return { binder: authorization.binder, state: new URL(authorization.authorizeUrl).searchParams.get("state")!, code };
}

describe("storage OAuth with isolated MySQL and local provider protocol fakes", () => {
  it("requires the same binder and provider, consumes concurrent callbacks once, and stores the grant encrypted", async () => {
    const f = await fixture();
    const start = await f.oauth.start(f.principal, f.target);
    const url = new URL(start.authorizeUrl);
    const input = callbackData(start);
    const [pending] = await t.db.select().from(storageOAuthAttempts).where(eq(storageOAuthAttempts.connectionPublicId, f.target.publicId));
    expect(pending?.stateHash).not.toBe(input.state);
    expect(pending?.binderHash).not.toBe(input.binder);
    expect(pending?.payloadEnc).toMatch(/^rpenc:/);
    expect(JSON.stringify(pending)).not.toContain(f.principal.csrfSecret);
    await expect(f.oauth.callback("google_drive", input)).rejects.toMatchObject({ reasonCode: "STORAGE_OAUTH_CALLBACK_REJECTED" });
    await expect(f.oauth.callback("dropbox", { ...input, binder: "Z".repeat(43) })).rejects.toMatchObject({ reasonCode: "STORAGE_OAUTH_CALLBACK_REJECTED" });
    expect(f.network).not.toHaveBeenCalled();
    const results = await Promise.allSettled([f.oauth.callback("dropbox", input), f.oauth.callback("dropbox", input)]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(f.network).toHaveBeenCalledTimes(1);
    const [tokenUrl, opts] = f.network.mock.calls[0]!;
    expect(tokenUrl).toBe("https://api.dropboxapi.com/oauth2/token");
    const form = new URLSearchParams(opts?.body as string);
    expect(form.get("code")).toBe(code);
    expect(form.get("client_secret")).toBe(secret);
    expect(form.get("redirect_uri")).toBe(`${origin}${cb}`);
    expect(url.searchParams.get("redirect_uri")).toBe(form.get("redirect_uri"));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(createHash("sha256").update(form.get("code_verifier")!).digest("base64url"));
    const [row] = await t.db.select().from(storageConnections).where(eq(storageConnections.publicId, f.target.publicId));
    expect(row).toMatchObject({ oauthConnected: true, enabled: false, credentialsEnc: expect.stringMatching(/^rpenc:/) });
    expect(JSON.stringify(row)).not.toContain(refresh);
    const view = await f.h.services.storageConnections.connections.get(f.principal, { publicId: f.target.publicId });
    expect(view).toMatchObject({ credentialsConfigured: true, oauthConnected: true, enabled: false });
    expect(JSON.stringify([view, f.h.audit.events])).not.toMatch(/synthetic-(?:code|client-secret|refresh-grant|access-token)/);
    const completed = f.h.audit.events.findIndex(({ eventName, outcome }) => eventName === "storage.oauth.connect" && outcome === "completed");
    expect(f.h.audit.recordedInTx[completed]).toBe(true);
  });

  it("rejects admin session mismatch, expiration, config drift and revocation before reaching the provider", async () => {
    const f = await fixture();
    const first = await f.oauth.start(f.principal, f.target);
    await expect(f.oauth.callback("dropbox", { ...callbackData(first), currentSession: fakePrincipal({ role: "admin" }) })).rejects.toThrow();
    await expect(f.oauth.callback("dropbox", callbackData(first))).rejects.toThrow();
    const expired = await f.oauth.start(f.principal, f.target);
    f.h.clock.advance(OAUTH_TTL_MS + 1);
    await expect(f.oauth.callback("dropbox", callbackData(expired))).rejects.toThrow();
    const changed = await f.oauth.start(f.principal, f.target);
    const updated = await f.h.services.storageConnections.connections.update(f.principal, {
      publicId: f.target.publicId, expectedVersion: f.target.expectedVersion, name: "Updated",
    });
    await expect(f.oauth.callback("dropbox", callbackData(changed))).rejects.toThrow();
    const revoked = await f.oauth.start(f.principal, { ...f.target, expectedVersion: updated.version });
    f.revokeSession();
    await expect(f.oauth.callback("dropbox", callbackData(revoked))).rejects.toThrow();
    expect(f.network).not.toHaveBeenCalled();
  });

  it("checks authorization again after exchange and refuses malformed or missing offline grants", async () => {
    const f = await fixture("google_drive");
    f.network.mockResolvedValueOnce(response(200, { ...grant, refresh_token: undefined }));
    const first = await f.oauth.start(f.principal, f.target);
    await expect(f.oauth.callback("google_drive", callbackData(first))).rejects.toThrow();
    const second = await f.oauth.start(f.principal, f.target);
    f.network.mockResolvedValueOnce(response(200, { ...grant, token_type: "invalid" }));
    await expect(f.oauth.callback("google_drive", callbackData(second))).rejects.toThrow();
    const third = await f.oauth.start(f.principal, f.target);
    f.network.mockImplementationOnce(async () => { f.revokeSession(); return response(200, grant); });
    await expect(f.oauth.callback("google_drive", callbackData(third))).rejects.toThrow();
    const [row] = await t.db.select().from(storageConnections).where(eq(storageConnections.publicId, f.target.publicId));
    expect(row?.oauthConnected).toBe(false);
    expect(f.h.audit.named("storage.oauth.connect").map(({ outcome }) => outcome)).not.toContain("completed");
  });

  it.each(["google_drive", "dropbox"] as const)("detaches %s before provider revocation and reports the actual outcome", async (kind) => {
    const f = await fixture(kind);
    const started = await f.oauth.start(f.principal, f.target);
    await f.oauth.callback(kind, callbackData(started));
    f.network.mockImplementation(async (url, opts) => {
      const [row] = await t.db.select().from(storageConnections).where(eq(storageConnections.publicId, f.target.publicId));
      expect(row).toMatchObject({ enabled: false, oauthConnected: false });
      expect(String(url)).not.toContain(refresh);
      if (kind === "google_drive") {
        expect(url).toBe("https://oauth2.googleapis.com/revoke");
        expect(new URLSearchParams(opts?.body as string).get("token")).toBe(refresh);
        return response(503);
      }
      if (String(url).endsWith("/oauth2/token")) {
        expect(new URLSearchParams(opts?.body as string).get("refresh_token")).toBe(refresh);
        return response(200, grant);
      }
      expect(String(url)).toBe("https://api.dropboxapi.com/2/auth/token/revoke");
      expect(opts?.headers?.Authorization).toBe("Bearer synthetic-access-token");
      return response(200);
    });
    const result = await f.oauth.disconnect(f.principal, { ...f.target, expectedVersion: f.target.expectedVersion + 1 });
    expect(result).toEqual({ remoteRevoked: kind === "dropbox" });
    expect(f.h.audit.named("storage.oauth.revoke").map(({ outcome }) => outcome)).toEqual(["attempted", kind === "dropbox" ? "completed" : "unknown"]);
  });

  it("enforces CSRF, canonical origin and private callback logging using the real HTTP pipeline", async () => {
    const f = await fixture();
    const logs = vi.fn();
    f.h.services.logger = { ...silentLogger, info: logs };
    const moduleRouter = Router();
    registerStorageOAuthRoutes(moduleRouter, f.h.services);
    const http = request(createApp(f.h.services, { trpcRouter: router({}), moduleRouter }));
    const authCookie = `${f.h.config.sessionCookieName}=synthetic-admin-session`;
    const csrfToken = deriveSessionCsrfToken(f.principal.sessionId, f.principal.csrfSecret);
    const startRequest = () => http.post("/api/storage/oauth/start").set("Host", host).set("Origin", origin)
      .set("Cookie", `${authCookie}; ${f.h.config.csrfCookieName}=${csrfToken}`).send(f.target);
    await startRequest().expect(403);
    await http.get("/api/storage/oauth/redirect-uri/dropbox").set("Host", host).set("Cookie", authCookie)
      .expect(200, { redirectUri: `${origin}${cb}` });
    const start = await startRequest().set(HEADER_CSRF, csrfToken).expect(200);
    const [binderCookie] = start.headers["set-cookie"] as unknown as string[];
    expect(binderCookie).toMatch(/^__Host-rp_storage_oauth_/);
    expect(binderCookie).toMatch(/Path=\/;.*HttpOnly; Secure; SameSite=Lax/);
    expect(Object.keys(start.body)).toEqual(["authorizeUrl"]);
    const state = new URL(start.body.authorizeUrl).searchParams.get("state")!;
    const url = `${cb}?state=${state}&code=${code}`;
    const alias = await http.get(url).set("Host", "portal.readypackets.test").expect(404);
    expect(alias.headers.location).toBeUndefined();
    await http.head(url).set("Host", host).set("Cookie", binderCookie!.split(";")[0]!).expect(405);
    await http.get(url).set("Host", host).expect(303).expect("Location", "/admin/storage?oauth=failed");
    await http.get(url).set("Host", host).set("Cookie", binderCookie!.split(";")[0]!).expect(303)
      .expect("Location", "/admin/storage?oauth=connected").expect("Cache-Control", "no-store").expect("Referrer-Policy", "no-referrer");
    const replay = await http.get(url).set("Host", host).set("Cookie", binderCookie!.split(";")[0]!).expect(303);
    expect(replay.headers.location).toBe("/admin/storage?oauth=failed");
    expect(f.fetchPinned).toHaveBeenCalledOnce();
    expect(f.fetchPinned).toHaveBeenCalledWith("https://api.dropboxapi.com/oauth2/token", "storage_dropbox",
      expect.objectContaining({ requireAllowlistRule: true, publicAddressesOnly: true }));
    expect(logs).toHaveBeenCalledWith("http request", expect.objectContaining({ route: "/api/storage/oauth/callback/:provider", status: 303 }));
    expect(JSON.stringify(logs.mock.calls)).not.toContain(code);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(state);
  });
});
