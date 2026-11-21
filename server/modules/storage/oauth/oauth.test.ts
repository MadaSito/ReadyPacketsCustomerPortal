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
import { createEgressPolicy, type EgressFetchResponse } from "../../integrations/egress.js";
import { integrationEgressAllowlist } from "../../integrations/schema.js";
import { googleDriveAdapter } from "../adapters/googleDrive.js";
import { createStorageModule } from "../index.js";
import { storageConnections } from "../schema.js";
import { registerStorageOAuthRoutes } from "./http.js";
import { reserveGoogleDriveFolder } from "./googleDriveFolders.js";
import type { StorageRequest } from "./provider.js";
import { registerStorageOAuthAdapters, requestForOAuthProvider } from "./register.js";
import { storageGoogleDriveFolders, storageOAuthAttempts } from "./schema.js";
import { OAUTH_PARK_TTL_MS, OAUTH_TTL_MS, storageOAuthService } from "./service.js";

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
beforeAll(async () => {
  t = await createTestDb({ schema: { storageConnections, storageOAuthAttempts, storageGoogleDriveFolders, integrationEgressAllowlist } });
}, 20_000);
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
    await expect(f.oauth.park("google_drive", input)).rejects.toMatchObject({ reasonCode: "STORAGE_OAUTH_CALLBACK_REJECTED" });
    await expect(f.oauth.park("dropbox", { ...input, binder: "Z".repeat(43) })).rejects.toMatchObject({ reasonCode: "STORAGE_OAUTH_CALLBACK_REJECTED" });
    expect(f.network).not.toHaveBeenCalled();
    const parked = await Promise.allSettled([f.oauth.park("dropbox", input), f.oauth.park("dropbox", input)]);
    expect(parked.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const handle = parked.find((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")!.value;
    const [stage] = await t.db.select().from(storageOAuthAttempts).where(eq(storageOAuthAttempts.connectionPublicId, f.target.publicId));
    expect(stage).toMatchObject({ binderHash: null, phase: "parked", payloadEnc: expect.stringMatching(/^rpenc:/) });
    expect(stage?.stateHash).not.toBe(pending?.stateHash);
    expect(JSON.stringify(stage)).not.toContain(code);
    expect(f.network).not.toHaveBeenCalled();
    const results = await Promise.allSettled([f.oauth.finish(handle, f.principal), f.oauth.finish(handle, f.principal)]);
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
    const handle = await f.oauth.park("dropbox", callbackData(first));
    await expect(f.oauth.finish(handle, fakePrincipal({ role: "admin" }))).rejects.toThrow();
    await expect(f.oauth.finish(handle, f.principal)).rejects.toThrow();
    const withoutSession = await f.oauth.park("dropbox", callbackData(await f.oauth.start(f.principal, f.target)));
    await expect(f.oauth.finish(withoutSession, null)).rejects.toThrow();
    await expect(f.oauth.finish(withoutSession, f.principal)).rejects.toThrow();
    const parkExpired = await f.oauth.park("dropbox", callbackData(await f.oauth.start(f.principal, f.target)));
    f.h.clock.advance(OAUTH_PARK_TTL_MS + 1);
    await expect(f.oauth.finish(parkExpired, f.principal)).rejects.toThrow();
    const expired = await f.oauth.start(f.principal, f.target);
    f.h.clock.advance(OAUTH_TTL_MS + 1);
    await expect(f.oauth.park("dropbox", callbackData(expired))).rejects.toThrow();
    const changed = await f.oauth.park("dropbox", callbackData(await f.oauth.start(f.principal, f.target)));
    const updated = await f.h.services.storageConnections.connections.update(f.principal, {
      publicId: f.target.publicId, expectedVersion: f.target.expectedVersion, name: "Updated",
    });
    await expect(f.oauth.finish(changed, f.principal)).rejects.toThrow();
    const revoked = await f.oauth.park("dropbox", callbackData(await f.oauth.start(f.principal, { ...f.target, expectedVersion: updated.version })));
    f.revokeSession();
    await expect(f.oauth.finish(revoked, f.principal)).rejects.toThrow();
    expect(f.network).not.toHaveBeenCalled();
  });

  it("checks authorization again after exchange and refuses malformed or missing offline grants", async () => {
    const f = await fixture("google_drive");
    f.network.mockResolvedValueOnce(response(200, { ...grant, refresh_token: undefined }));
    const makeHandle = async () => f.oauth.park("google_drive", callbackData(await f.oauth.start(f.principal, f.target)));
    await expect(f.oauth.finish(await makeHandle(), f.principal)).rejects.toThrow();
    f.network.mockResolvedValueOnce(response(200, { ...grant, token_type: "invalid" }));
    await expect(f.oauth.finish(await makeHandle(), f.principal)).rejects.toThrow();
    f.network.mockImplementationOnce(async () => { f.revokeSession(); return response(200, grant); });
    await expect(f.oauth.finish(await makeHandle(), f.principal)).rejects.toThrow();
    const [row] = await t.db.select().from(storageConnections).where(eq(storageConnections.publicId, f.target.publicId));
    expect(row?.oauthConnected).toBe(false);
    expect(f.h.audit.named("storage.oauth.connect").map(({ outcome }) => outcome)).not.toContain("completed");
  });

  it("fails closed and consumes state if the high-impact audit cannot be persisted", async () => {
    const f = await fixture();
    const handle = await f.oauth.park("dropbox", callbackData(await f.oauth.start(f.principal, f.target)));
    f.network.mockImplementationOnce(async () => { f.h.audit.failRecords = true; return response(200, grant); });
    await expect(f.oauth.finish(handle, f.principal)).rejects.toThrow();
    f.h.audit.failRecords = false;
    await expect(f.oauth.finish(handle, f.principal)).rejects.toMatchObject({ reasonCode: "STORAGE_OAUTH_CALLBACK_REJECTED" });
    expect(f.network).toHaveBeenCalledOnce();
    const [row] = await t.db.select().from(storageConnections).where(eq(storageConnections.publicId, f.target.publicId));
    expect(row?.oauthConnected).toBe(false);
  });

  it.each(["google_drive", "dropbox"] as const)("detaches %s before provider revocation and reports the actual outcome", async (kind) => {
    const f = await fixture(kind);
    const started = await f.oauth.start(f.principal, f.target);
    await f.oauth.finish(await f.oauth.park(kind, callbackData(started)), f.principal);
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
    const callback = await http.get(url).set("Host", host).set("Cookie", binderCookie!.split(";")[0]!).expect(303)
      .expect("Cache-Control", "no-store").expect("Referrer-Policy", "no-referrer");
    expect(callback.headers.location).toMatch(/^\/admin\/storage\?oauth=finish#oauth-attempt=[A-Za-z0-9_-]{43}$/);
    expect(callback.headers.location).not.toContain(state);
    expect(callback.headers.location).not.toContain(code);
    const replay = await http.get(url).set("Host", host).set("Cookie", binderCookie!.split(";")[0]!).expect(303);
    expect(replay.headers.location).toBe("/admin/storage?oauth=failed");
    expect(f.fetchPinned).not.toHaveBeenCalled();
    const attemptHandle = String(callback.headers.location).split("#oauth-attempt=")[1]!;
    const finishRequest = () => http.post("/api/storage/oauth/finish").set("Host", host).set("Origin", origin)
      .set("Cookie", `${authCookie}; ${f.h.config.csrfCookieName}=${csrfToken}`).send({ attemptHandle });
    await finishRequest().expect(403);
    await finishRequest().set(HEADER_CSRF, csrfToken).expect(200, { connected: true });
    await finishRequest().set(HEADER_CSRF, csrfToken).expect(400);
    expect(f.fetchPinned).toHaveBeenCalledOnce();
    expect(f.fetchPinned).toHaveBeenCalledWith("https://api.dropboxapi.com/oauth2/token", "storage_dropbox",
      expect.objectContaining({ requireAllowlistRule: true, publicAddressesOnly: true }));
    expect(logs).toHaveBeenCalledWith("http request", expect.objectContaining({ route: "/api/storage/oauth/callback/:provider", status: 303 }));
    expect(JSON.stringify(logs.mock.calls)).not.toContain(code);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(state);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(attemptHandle);
  });

  it("burns a finish handle presented through valid anonymous CSRF without a live portal session", async () => {
    const f = await fixture();
    const moduleRouter = Router();
    registerStorageOAuthRoutes(moduleRouter, f.h.services);
    const http = request(createApp(f.h.services, { trpcRouter: router({}), moduleRouter }));
    const attemptHandle = await f.oauth.park("dropbox", callbackData(await f.oauth.start(f.principal, f.target)));
    const csrf = await http.get("/api/csrf").set("Host", host).set("Origin", origin).expect(204);
    const [anonymousCookie] = csrf.headers["set-cookie"] as unknown as string[];
    const cookie = anonymousCookie!.split(";")[0]!;
    await http.post("/api/storage/oauth/finish").set("Host", host).set("Origin", origin)
      .set("Cookie", cookie).set(HEADER_CSRF, decodeURIComponent(cookie.split("=")[1]!)).send({ attemptHandle }).expect(400);
    await expect(f.oauth.finish(attemptHandle, f.principal)).rejects.toMatchObject({ reasonCode: "STORAGE_OAUTH_CALLBACK_REJECTED" });
    expect(f.fetchPinned).not.toHaveBeenCalled();
  });

  it("uses one encrypted generated Drive ID when workers create the same folder concurrently", async () => {
    const f = await fixture("google_drive");
    const created = new Map<string, Record<string, unknown>>();
    let generated = 0;
    const outbound: StorageRequest = async (target, options) => {
      const path = new URL(target).pathname;
      if (path === "/token") return response(200, grant);
      if (path === "/drive/v3/about") return response(200, { user: { permissionId: "fake_account" } });
      if (path === "/drive/v3/files/generateIds") return response(200, { ids: [`fake_folder_${++generated}`] });
      if (path === "/drive/v3/files" && options?.method !== "POST") return response(200, { files: [] });
      if (path === "/drive/v3/files") {
        const payload = JSON.parse(options?.body as string) as Record<string, unknown> & { id: string };
        if (created.has(payload.id)) return response(409);
        created.set(payload.id, { ...payload, trashed: false, parents: ["drive_fake_root"] });
        return response(200, { id: payload.id });
      }
      if (path.startsWith("/drive/v3/files/")) return response(200, created.get(path.split("/").at(-1)!));
      throw new Error("unexpected local Drive request");
    };
    const definition = googleDriveAdapter(outbound, reserveGoogleDriveFolder(f.h.services));
    const input = { publicId: f.target.publicId, config: { clientId: "synthetic-app" }, credentials: { clientSecret: secret, refreshToken: refresh } };
    await Promise.all([definition.create(input).ensureFolder([]), definition.create(input).ensureFolder([])]);
    expect(created.size).toBe(1);
    expect(generated).toBeGreaterThanOrEqual(1);
    const rows = await t.db.select().from(storageGoogleDriveFolders);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.providerIdEnc).toMatch(/^rpenc:/);
    expect(JSON.stringify(rows)).not.toMatch(/fake_folder|fake_account|ReadyPackets/);
  });

  it("requires the real public-only egress policy before contacting either fake provider", async () => {
    const f = await fixture();
    let providerResponse = response(200, grant);
    const httpsRequester = vi.fn(async () => providerResponse);
    let address = "93.184.216.34";
    const egress = createEgressPolicy(f.h.deps, {
      dnsLookup: async () => [{ address, family: 4 }], httpsRequester,
    });
    f.h.services.integrations = { egress } as typeof f.h.services.integrations;
    const dropbox = requestForOAuthProvider(f.h.services, "dropbox");
    const gdrive = requestForOAuthProvider(f.h.services, "google_drive");
    const dropboxUrl = "https://api.dropboxapi.com/oauth2/token";
    const gdriveUrl = "https://oauth2.googleapis.com/token";
    await expect(dropbox(dropboxUrl)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(gdrive(gdriveUrl)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(httpsRequester).not.toHaveBeenCalled();
    await egress.setPresetEnabled(f.principal, { presetKey: "dropbox", enabled: true });
    await egress.setPresetEnabled(f.principal, { presetKey: "google_drive", enabled: true });
    await expect(dropbox(dropboxUrl)).resolves.toMatchObject({ status: 200 });
    await expect(gdrive(gdriveUrl)).resolves.toMatchObject({ status: 200 });
    address = "127.0.0.1";
    await expect(dropbox(dropboxUrl)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(gdrive(gdriveUrl)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(httpsRequester).toHaveBeenCalledTimes(2);
    address = "93.184.216.34";
    providerResponse = { ...response(308), headers: { range: "bytes=0-1023", location: "https://outside.example.test/" } };
    const driveUploadUrl = "https://www.googleapis.com/upload/drive/v3/files?upload_id=synthetic";
    await expect(gdrive(driveUploadUrl, { method: "PUT", acceptUploadIncomplete: true })).resolves.toMatchObject({
      status: 308, headers: { range: "bytes=0-1023" },
    });
    const progress = await gdrive(driveUploadUrl, { method: "PUT", acceptUploadIncomplete: true });
    expect(progress.headers.location).toBeUndefined();
    await expect(gdrive(driveUploadUrl, { method: "POST", acceptUploadIncomplete: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(dropbox(dropboxUrl, { method: "PUT", acceptUploadIncomplete: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
