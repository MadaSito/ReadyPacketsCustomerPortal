import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Router, type Request } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AppConfig, DeploymentProfile } from "../../server/config/env.js";
import { DomainError } from "../../server/core/errors.js";
import { getRequestContext } from "../../server/core/requestContext.js";
import type { RateLimiter } from "../../server/core/types.js";
import { createApp, type AppOptions } from "../../server/http/app.js";
import { sendPrivateDownload } from "../../server/http/downloads.js";
import { EDGE_REQUESTS_PER_WINDOW, EDGE_STATIC_PER_WINDOW, edgeAdmissionBucket } from "../../server/http/edgeAdmission.js";
import { getHttpState } from "../../server/http/requestState.js";
import { registerFileArchiveHttpRoutes } from "../../server/modules/files/archivesHttp.js";
import { compilePolicy, defaultPolicy, type ProtectionPolicy } from "../../server/modules/protection/policy.js";
import { requestSignals } from "../../server/modules/protection/request.js";
import { isSignInRequest } from "../../server/modules/protection/signInBans.js";
import { ANONYMOUS_CSRF_MAX_AGE_MS, deriveSessionCsrfToken } from "../../server/security/csrf.js";
import { protectedProcedure, publicProcedure, router } from "../../server/trpc/trpc.js";
import {
  HEADER_CSRF, HEADER_PREVIEW_CSRF_SET, HEADER_PREVIEW_SESSION, HEADER_PREVIEW_SESSION_SET,
} from "../../shared/sessionTransportHeaders.js";
import { createTestDeps, fakePrincipal, silentLogger } from "../helpers/fakes.js";

// Synthetic routers drive the real pipeline without loading peer module factories.
vi.mock("../../server/trpc/root.js", () => ({ appRouter: undefined }));
vi.mock("../../server/http/moduleRoutes.js", () => ({ createModuleHttpRouter: vi.fn() }));
vi.mock("../../server/modules/integrations/http.js", () => ({ registerSignedIntegrationWebhooks: vi.fn() }));

const HOST = "my.readypackets.test";
const ORIGIN = `https://${HOST}`;
const TOKEN_A = "synthetic-session-a";
const TOKEN_B = "synthetic-session-b";
const a = fakePrincipal({ sessionId: "synthetic-session-id-a" });
// Same synthetic secret to exercise independent session-ID binding.
const b = fakePrincipal({ sessionId: "synthetic-session-id-b", csrfSecret: a.csrfSecret });
const csrfA = deriveSessionCsrfToken(a.sessionId, a.csrfSecret);
const csrfB = deriveSessionCsrfToken(b.sessionId, b.csrfSecret);
const STATIC = fileURLToPath(new URL("./fixtures", import.meta.url));
const TRACE_ID = "0123456789abcdef0123456789abcdef";
const TRACE = `00-${TRACE_ID}-0123456789abcdef-01`;

function harness(options: AppOptions = {}, config: Partial<AppConfig> = {}) {
  const h = createTestDeps({ config });
  const sessionResolver = vi.fn(async ({ token }: { token: string | undefined }) => (
    token === TOKEN_A ? a : token === TOKEN_B ? b : null
  ));
  h.services.sessionResolver = { resolve: sessionResolver };
  h.services.platform = {
    readiness: vi.fn(async () => ({ ready: true, state: "ok" })),
  } as unknown as typeof h.services.platform;
  const access = vi.fn();
  h.services.logger = { ...silentLogger, info: access };
  const effect = vi.fn();
  const workflowImport = protectedProcedure.input(z.object({ packageText: z.string() })).mutation(({ input }) => {
    effect();
    return { bytes: Buffer.byteLength(input.packageText) };
  });
  const trpcRouter = router({
    open: publicProcedure.query(({ ctx }) => ({
      authenticated: ctx.session !== null,
      requestId: ctx.request.requestId,
      traceId: ctx.request.traceId,
      spanId: ctx.request.spanId,
      ipAddress: ctx.request.ipAddress,
    })),
    scarce: publicProcedure.meta({ rateLimit: "auth_high_risk" }).query(() => "bounded"),
    update: protectedProcedure.mutation(({ ctx }) => {
      effect();
      return { requestId: ctx.request.requestId, actor: getRequestContext()?.actor?.sessionId };
    }),
    signIn: publicProcedure.meta({ rateLimit: "auth_high_risk" }).mutation(({ ctx }) => {
      ctx.transport.issue({
        token: TOKEN_A, csrfToken: csrfA, absoluteExpiresAt: new Date("2026-11-21T12:00:00.000Z"),
      });
      return "signed in";
    }),
    signOut: publicProcedure.mutation(({ ctx }) => {
      ctx.transport.clear();
      return "signed out";
    }),
    domain: publicProcedure.query(() => {
      throw new DomainError("CONFLICT", "SYNTHETIC_CONFLICT", "That example is already in use.");
    }),
    failure: publicProcedure.query(() => { throw new Error("SELECT synthetic_internal_only FROM settings"); }),
    orders: router({ admin: router({ workflows: router({ transfer: router({
      preview: workflowImport,
      applyImport: workflowImport,
    }) }) }) }),
  });
  const moduleRouter = Router();
  moduleRouter.get("/check", (req, res) => { res.json({ actor: getHttpState(req).session?.sessionId ?? null }); });
  moduleRouter.post("/mutate", (_req, res) => { effect(); res.status(204).end(); });
  moduleRouter.post("/stream", async (req, res) => {
    expect(req.body).toBeUndefined();
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    res.json({ bytes: Buffer.concat(chunks).length });
  });
  moduleRouter.get("/failure", () => { throw new Error("synthetic path /srv/never-echo"); });
  moduleRouter.get("/domain", () => {
    throw new DomainError("NOT_FOUND", "SYNTHETIC_NOT_FOUND", "An example was not found.");
  });
  moduleRouter.get("/private/download", async (_req, res) => {
    await sendPrivateDownload(res, {
      stream: Readable.from(["example"]), filename: "café\r\n/bill.pdf", contentType: "application/pdf", size: 7,
    });
  });
  return {
    ...h, access, effect, sessionResolver,
    http: request(createApp(h.services, { trpcRouter, moduleRouter, ...options })),
  };
}

function scopedCookie(name: string, value: string): string {
  return `${name}=${encodeURIComponent(value)}`;
}

function extractCsrf(response: { headers: Record<string, unknown> }, config: AppConfig): string {
  const fields = response.headers["set-cookie"] as string[];
  return decodeURIComponent(fields.find((field) => field.startsWith(`${config.csrfCookieName}=`))!.split(";")[0]!.split("=")[1]!);
}

function requestCookies(config: AppConfig, bearer?: string, csrf?: string): string {
  return [
    ...(bearer ? [scopedCookie(config.sessionCookieName, bearer)] : []),
    ...(csrf ? [scopedCookie(config.csrfCookieName, csrf)] : []),
  ].join("; ");
}

describe("HTTP edge: authority, headers, proxy and probes", () => {
  it("sets a fresh strict CSP, browser protections and no-store on API responses", async () => {
    const h = harness();
    const res = await h.http.get("/api/check").set("Host", HOST).expect(200);
    const second = await h.http.get("/api/check").set("Host", HOST).expect(200);
    const csp = res.headers["content-security-policy"];
    expect(csp).toMatch(/default-src 'none'; script-src 'self' 'nonce-[A-Za-z0-9_-]{24}'/);
    expect(csp).toContain("style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'");
    expect(csp).toContain("; media-src 'self' blob:;");
    expect(csp).toContain("frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(second.headers["content-security-policy"]).not.toBe(csp);
    expect(res.headers).toMatchObject({
      "strict-transport-security": "max-age=31536000",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-resource-policy": "same-origin",
      "x-frame-options": "DENY",
      "x-robots-tag": "noindex, nofollow",
      "cache-control": "no-store",
    });
    expect(res.headers["permissions-policy"]).toContain("camera=()");
    expect(String(res.headers["permissions-policy"]).split(/,\s*/u)).toContain("microphone=(self)");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("redirects aliases to the exact canonical origin, preserves the target, and refuses unknown hosts", async () => {
    const h = harness();
    await h.http.get("//other.example.test/a?b=1").set("Host", "portal.readypackets.test")
      .expect(308).expect("Location", `${ORIGIN}//other.example.test/a?b=1`);
    await h.http.post("/api/check").set("Host", "portal.readypackets.test")
      .expect(308).expect("Location", `${ORIGIN}/api/check`);
    await h.http.get("/api/check").set("Host", `${HOST}:12345`).expect(400);
    const denied = await h.http.get("/api/check").set("Host", "unrecognized.example.test")
      .set("X-Forwarded-Host", HOST).expect(400);
    expect(denied.body.safe.reasonCode).toBe("HOST_NOT_ALLOWED");
    expect(denied.headers.location).toBeUndefined();
  });

  it("trusts configured peers but not client-supplied request IDs, unrelated forwarding or invalid traces", async () => {
    const untrusted = harness();
    const first = await untrusted.http.get("/api/trpc/open?example=synthetic-query-data").set("Host", HOST)
      .set("X-Request-Id", "untrusted-id").set("X-Forwarded-For", "203.0.113.43").set("traceparent", TRACE).expect(200);
    const payload = first.body.result.data.json;
    expect(payload.requestId).toBe(first.headers["x-request-id"]);
    expect(payload.requestId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(payload.traceId).not.toBe(TRACE_ID);
    expect(payload.ipAddress).not.toBe("203.0.113.43");
    expect(untrusted.access).toHaveBeenCalledWith("http request", expect.objectContaining({
      route: "/api/trpc/:procedures", status: 200, requestId: payload.requestId, traceId: payload.traceId,
    }));
    expect(JSON.stringify(untrusted.access.mock.calls)).not.toMatch(/synthetic-query-data|untrusted-id|203\.0\.113/);

    const trusted = harness({}, { trustedProxies: ["127.0.0.1/32", "::1/128"] });
    const proxied = await trusted.http.get("/api/trpc/open").set("Host", HOST)
      .set("X-Forwarded-For", "203.0.113.3, 198.51.100.4").set("traceparent", TRACE).expect(200);
    expect(proxied.body.result.data.json).toMatchObject({ traceId: TRACE_ID, ipAddress: "198.51.100.4" });
    expect(proxied.body.result.data.json.spanId).not.toBe("0123456789abcdef");
    const invalid = await trusted.http.get("/api/trpc/open").set("Host", HOST)
      .set("traceparent", `00-${"0".repeat(32)}-0123456789abcdef-01`).expect(200);
    expect(invalid.body.result.data.json.traceId).not.toBe("0".repeat(32));
  });

  it("admits local health probes without admitting non-probe routes on the local host", async () => {
    const h = harness();
    await h.http.get("/healthz").set("Host", "127.0.0.1:5000").expect(200, { ok: true });
    await h.http.get("/api/check").set("Host", "127.0.0.1:5000").expect(400);
    await h.http.get("/healthz").set("Host", "127.0.0.1:5000").set("X-Forwarded-For", "203.0.113.1").expect(400);
    await h.http.get("/readyz").set("Host", "localhost:5000").expect(200, { ready: true });
    vi.mocked(h.services.platform.readiness).mockRejectedValueOnce(new Error("synthetic unsafe detail"));
    await h.http.get("/readyz").set("Host", "localhost:5000").expect(503, { ready: false });
    expect(h.sessionResolver).not.toHaveBeenCalled();
  });
});

describe("HTTP edge: cookie CSRF, sessions and tRPC", () => {
  it("checks origins before session lookup and validates CSRF against the resolved session", async () => {
    const h = harness();
    const perform = (browserOrigin: string, cookieToken: string, csrfHeader?: string) => {
      const pending = h.http.post("/api/trpc/update").set("Host", HOST).set("Origin", browserOrigin)
        .set("Cookie", requestCookies(h.config, TOKEN_A, cookieToken)).send({});
      return csrfHeader === undefined ? pending : pending.set(HEADER_CSRF, csrfHeader);
    };
    const missing = await perform(ORIGIN, csrfA).expect(403);
    expect(missing.body.error.json.data.safe.reasonCode).toBe("CSRF_INVALID");
    await perform(ORIGIN, "forged", "forged").expect(403);
    await perform(ORIGIN, csrfB, csrfB).expect(403);
    await perform("https://outside.example.test", csrfA, csrfA).expect(403);
    await perform("http://my.readypackets.test", csrfA, csrfA).expect(403);
    await perform(`${ORIGIN}:444`, csrfA, csrfA).expect(403);
    await perform(ORIGIN, csrfA, csrfA).set("Sec-Fetch-Site", "cross-site").expect(403);
    await perform(ORIGIN, csrfA, csrfA).set("Sec-Fetch-Site", "same-site").expect(403);
    expect(h.effect).not.toHaveBeenCalled();
    const good = await perform(ORIGIN, csrfA, csrfA).set("Sec-Fetch-Site", "same-origin").expect(200);
    expect(good.body.result.data.json).toEqual({ requestId: good.headers["x-request-id"], actor: a.sessionId });
    expect(h.effect).toHaveBeenCalledTimes(1);
    expect(h.sessionResolver).toHaveBeenCalledTimes(4);
    expect(h.audit.events).toHaveLength(0);
    expect(h.audit.notes.map(({ eventName }) => eventName)).toEqual(["http.csrf.denied", "http.origin.denied"]);
  });

  it("stops repeated denials at the local gate before the durable limiter, session, or audit", async () => {
    const h = harness({}, { trustedProxies: ["127.0.0.1/32", "::1/128"] });
    const consume = vi.fn<RateLimiter["consume"]>(async () => ({ allowed: true, retryAfterSeconds: 0 }));
    h.services.rateLimiter = { consume };
    const target = (address: string) => h.http.post("/api/mutate").set("Host", HOST)
      .set("X-Forwarded-For", address).set("Origin", "https://outside.example.test")
      .set("Cookie", requestCookies(h.config, TOKEN_A, csrfA));
    for (let index = 0; index < EDGE_REQUESTS_PER_WINDOW; index++) {
      await target(`2001:db8:1234:5678::${(index + 1).toString(16)}`).expect(403);
    }
    const cookie = requestCookies(h.config, TOKEN_A, csrfA);
    await h.http.get("/unmatched-asset").set("Host", HOST).set("X-Forwarded-For", "2001:0DB8:1234:5678::cc")
      .set("Cookie", cookie).expect(429).expect("Retry-After", "10");
    await h.http.get("/healthz").set("Host", HOST).set("X-Forwarded-For", "2001:db8:1234:5678::cc")
      .set("Cookie", cookie).expect(200);
    expect(h.sessionResolver).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(h.audit.events).toHaveLength(0);
    expect(h.audit.notes.map(({ eventName }) => eventName)).toEqual(["http.origin.denied"]);
    h.clock.advance(10_000);
    await h.http.get("/api/check").set("Host", HOST).set("X-Forwarded-For", "2001:db8:1234:5678::dd")
      .set("Cookie", cookie).expect(200, { actor: a.sessionId });
    expect(consume).toHaveBeenCalledWith("api", "ip:2001:db8:1234:5678::/64", 1);
  });

  it("gives three 60-asset cold loads from one address separate bounded capacity without raising API admission", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "readypackets-edge-"));
    try {
      const assets = Array.from({ length: 60 }, (_, i) => `chunk-${i.toString(16).padStart(8, "0")}.js`);
      await mkdir(join(staticDir, "assets"));
      await Promise.all(assets.map((asset) => writeFile(join(staticDir, "assets", asset), "export {};")));
      const h = harness({ staticDir }, { trustedProxies: ["127.0.0.1/32", "::1/128"] });
      const consume = vi.fn<RateLimiter["consume"]>(async () => ({ allowed: true, retryAfterSeconds: 0 }));
      type Protection = NonNullable<typeof h.services.protection>;
      const recordRateLimit = vi.fn<Protection["recordRateLimit"]>(async () => {});
      h.services.rateLimiter = { consume };
      const protectionStub: Pick<Protection, "inspect" | "recordRateLimit"> = {
        inspect: async () => ({ action: "allow" }), recordRateLimit,
      };
      h.services.protection = protectionStub as Protection;
      const get = (path: string, client = 0) => h.http.get(path).set("Host", HOST)
        .set("X-Forwarded-For", "198.51.100.45").set("User-Agent", `test-client/${client}`);
      for (const asset of assets) {
        for (let client = 0; client < 3; client++) await get(`/assets/${asset}`, client).expect(200);
      }
      expect(consume).not.toHaveBeenCalled();
      for (let i = 0; i < EDGE_REQUESTS_PER_WINDOW - 1; i++) await get("/api/check").expect(200);
      for (let i = 180; i < EDGE_STATIC_PER_WINDOW; i++) await get(`/assets/${assets[0]}`).expect(200);
      const staticDenial = await get(`/assets/${assets[0]}`).expect(429).expect("Retry-After", "10");
      await get("/api/check").expect(200);
      const apiDenial = await get("/api/check").expect(429).expect("Retry-After", "10");
      expect(consume).toHaveBeenCalledTimes(120);
      for (const [bucket, response] of [["edge_static", staticDenial], ["edge_requests", apiDenial]] as const) {
        expect(h.access).toHaveBeenCalledWith("http request", expect.objectContaining({
          status: 429, rateLimitBucket: bucket, requestId: response.headers["x-request-id"],
        }));
        expect(recordRateLimit).toHaveBeenCalledWith(expect.anything(), expect.any(String), bucket);
      }
      h.clock.advance(10_000);
      await get(`/assets/${assets[0]}`).expect(200);
      await get("/api/check").expect(200);
    } finally {
      await rm(staticDir, { recursive: true, force: true });
    }
  }, 20_000);

  it("classifies only canonical static GET/HEAD paths into the higher admission bucket", () => {
    expect(edgeAdmissionBucket("GET", "/assets/adminKnowledge.test-BR1MlJtE.js")).toBe("edge_static");
    expect(edgeAdmissionBucket("HEAD", "/fonts/inter-400.woff2")).toBe("edge_static");
    expect(edgeAdmissionBucket("GET", "/brand/banner.png")).toBe("edge_static");
    for (const path of ["/assets/plain.js", "/assets/../chunk-12345678.js", "/assets/%2echunk-12345678.js",
      "/assets/chunk-12345678.html", "/api/trpc/identity.signIn", "/sign-in", "/brand/license.txt"]) {
      expect(edgeAdmissionBucket("GET", path)).toBe("edge_requests");
    }
    expect(edgeAdmissionBucket("POST", "/assets/chunk-12345678.js")).toBe("edge_requests");
  });

  it("maps trusted forwarded IPv4-mapped forms to the same durable subject as IPv4", async () => {
    const h = harness({}, { trustedProxies: ["127.0.0.1/32", "::1/128"] });
    const consume = vi.fn<RateLimiter["consume"]>(async () => ({ allowed: true, retryAfterSeconds: 0 }));
    h.services.rateLimiter = { consume };
    for (const address of ["192.0.2.7", "::ffff:192.0.2.7", "::FFFF:C000:207"]) {
      await h.http.get("/api/check").set("Host", HOST).set("X-Forwarded-For", address).expect(200);
    }
    expect(consume.mock.calls).toEqual(Array.from({ length: 3 }, () => ["api", "ip:192.0.2.7", 1]));
  });

  it("serves a generic batched sign-in refusal before session resolution or firewall inspection", async () => {
    const h = harness();
    const captureClientAddress = vi.fn();
    const inspect = vi.fn();
    h.services.protection = {
      captureClientAddress, inspect, recordRateLimit: async () => undefined, credentialRetryAfter: async () => 85,
    } as unknown as typeof h.services.protection;
    const result = await h.http.post("/api/trpc/identity.me%2Cidentity.signIn?batch=1")
      .set("Host", HOST).set("Origin", ORIGIN).send({}).expect(429).expect("Retry-After", "85");
    expect(captureClientAddress).toHaveBeenCalledOnce();
    expect(inspect).not.toHaveBeenCalled();
    expect(h.sessionResolver).not.toHaveBeenCalled();
    expect(result.body).toHaveLength(2);
    for (const item of result.body as { error: { json: { data: { safe: unknown } } } }[]) {
      expect(item.error.json.data.safe).toMatchObject({ domainCode: "RATE_LIMITED", reasonCode: "RATE_LIMITED" });
    }
  });

  it("applies identical CSRF controls to raw module routes and refuses mutation over GET", async () => {
    const h = harness();
    const cookie = requestCookies(h.config, TOKEN_A, csrfA);
    await h.http.get("/api/trpc/update").set("Host", HOST).set("Cookie", cookie).expect(405);
    await h.http.post("/api/mutate").set("Host", HOST).set("Origin", ORIGIN).set("Cookie", cookie).expect(403);
    await h.http.post("/api/mutate").set("Host", HOST).set("Origin", ORIGIN).set("Cookie", cookie).set(HEADER_CSRF, csrfA).expect(204);
    expect(h.effect).toHaveBeenCalledTimes(1);
  });

  it("requires valid signed, expiring anonymous tokens and sets/clears strict cookies", async () => {
    const h = harness();
    await h.http.post("/api/trpc/signIn").set("Host", HOST).set("Origin", ORIGIN)
      .set("Cookie", requestCookies(h.config, undefined, "arbitrary")).set(HEADER_CSRF, "arbitrary").expect(403);
    await h.http.get("/api/csrf").set("Host", HOST).set("Origin", "https://outside.example.test").expect(403);
    const bootstrap = await h.http.get("/api/csrf").set("Host", HOST).expect(204);
    const token = extractCsrf(bootstrap, h.config);
    expect(bootstrap.headers["set-cookie"]).toHaveLength(1);
    expect(bootstrap.headers["set-cookie"]?.[0]).toMatch(/^__Host-rp_csrf=.*; Path=\/; Expires=.+; Secure; SameSite=Strict$/);
    const signIn = await h.http.post("/api/trpc/signIn").set("Host", HOST).set("Origin", ORIGIN)
      .set("Cookie", requestCookies(h.config, undefined, token)).set(HEADER_CSRF, token).send({}).expect(200);
    const cookies = signIn.headers["set-cookie"] ?? [];
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatch(/^__Host-rp_session=.*; Path=\/; Expires=.+; HttpOnly; Secure; SameSite=Strict$/);
    expect(cookies[0]).not.toContain("Domain=");
    expect(cookies[1]).not.toMatch(/HttpOnly|Domain=/);
    expect(extractCsrf(signIn, h.config)).toBe(csrfA);
    expect(signIn.headers[HEADER_PREVIEW_SESSION_SET]).toBeUndefined();

    const logout = await h.http.post("/api/trpc/signOut").set("Host", HOST).set("Origin", ORIGIN)
      .set("Cookie", requestCookies(h.config, TOKEN_A, csrfA)).set(HEADER_CSRF, csrfA).send({}).expect(200);
    expect(logout.headers["set-cookie"]?.[0]).toMatch(/^__Host-rp_session=; Path=\/; Expires=Thu, 01 Jan 1970/);
    h.clock.advance(ANONYMOUS_CSRF_MAX_AGE_MS + 1);
    await h.http.post("/api/trpc/signIn").set("Host", HOST).set("Origin", ORIGIN)
      .set("Cookie", requestCookies(h.config, undefined, token)).set(HEADER_CSRF, token).expect(403);
  });

  it("rejects excessive batches, applies the strictest per-IP budget, and sets Retry-After", async () => {
    const h = harness();
    const consume: RateLimiter["consume"] = vi.fn(async () => ({ allowed: false, retryAfterSeconds: 24 }));
    h.services.rateLimiter = { consume };
    const result = await h.http.get("/api/trpc/open,scarce?batch=1").set("Host", HOST)
      .set("Cookie", requestCookies(h.config, TOKEN_A, csrfA)).expect(429);
    expect(result.headers["retry-after"]).toBe("24");
    expect(result.body).toHaveLength(2);
    expect(consume).toHaveBeenCalledWith("auth_high_risk", expect.stringMatching(/^edge:ip:/), 2);
    expect(h.access).toHaveBeenCalledWith("http request", expect.objectContaining({ status: 429, rateLimitBucket: "auth_high_risk" }));
    expect(h.sessionResolver).not.toHaveBeenCalled();
    const big = await h.http.get(`/api/trpc/${Array(9).fill("open").join(",")}?batch=1`).set("Host", HOST).expect(400);
    expect(big.body.error.json.data.safe.reasonCode).toBe("BATCH_TOO_LARGE");
    await h.http.get("/api/trpc/open,scarce").set("Host", HOST).expect(400);
  });

  it("expands JSON limits only for the two exact non-batched workflow import POST paths", async () => {
    const h = harness();
    const base = "/api/trpc/orders.admin.workflows.transfer";
    const cookie = requestCookies(h.config, TOKEN_A, csrfA);
    const packageText = `{${"\t".repeat(2 * 1024 * 1024 - 2)}}`;
    const envelope = { json: { packageText } };
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBeGreaterThan(4 * 1024 * 1024);
    for (const path of [`${base}.preview`, `${base}.applyImport`]) {
      const result = await h.http.post(path).set("Host", HOST).set("Origin", ORIGIN)
        .set("Cookie", cookie).set(HEADER_CSRF, csrfA).send(envelope).expect(200);
      expect(result.body.result.data.json.bytes).toBe(2 * 1024 * 1024);
    }
    const smaller = { json: { packageText: "x".repeat(256 * 1024) } };
    for (const path of ["/api/trpc/update", "/api/mutate", `${base}.%70review`]) {
      await h.http.post(path).set("Host", HOST).set("Origin", ORIGIN)
        .set("Cookie", cookie).set(HEADER_CSRF, csrfA).send(smaller).expect(413);
    }
    await h.http.put(`${base}.applyImport`).set("Host", HOST).set("Origin", ORIGIN)
      .set("Cookie", cookie).set(HEADER_CSRF, csrfA).send(smaller).expect(413);
    const oversized = await h.http.post(`${base}.applyImport`).set("Host", HOST).set("Origin", ORIGIN)
      .set("Cookie", cookie).set(HEADER_CSRF, csrfA)
      .send({ json: { packageText: "x".repeat(4 * 1024 * 1024 + 256 * 1024) } }).expect(413);
    expect(oversized.body.error.json.data.safe.reasonCode).toBe("BODY_TOO_LARGE");
    expect(h.effect).toHaveBeenCalledTimes(2);
  });

  it("refuses workflow batches and validates origin, session and CSRF before expanded parsing", async () => {
    const h = harness();
    const path = "/api/trpc/orders.admin.workflows.transfer.preview";
    const malformed = () => `{"json":"${"x".repeat(256 * 1024)}`;
    const cookie = requestCookies(h.config, TOKEN_A, csrfA);
    for (const [target, count] of [[`${path}?batch=1`, 1], [`${path}%2Cupdate?batch=1`, 2], [`${path}?%62atch=1&batch=0`, 0]] as const) {
      const result = await h.http.post(target).set("Host", HOST).set("Origin", ORIGIN)
        .set("Cookie", cookie).set(HEADER_CSRF, csrfA).type("application/json").send(malformed()).expect(400);
      if (count > 0) expect(result.body).toHaveLength(count);
      const item = count > 0 ? result.body[0] : result.body;
      expect(item.error.json.data.safe.reasonCode).toBe("WORKFLOW_IMPORT_BATCH_NOT_ALLOWED");
    }
    await h.http.post(path).set("Host", HOST).set("Origin", "https://outside.example.test")
      .set("Cookie", cookie).set(HEADER_CSRF, csrfA).type("application/json").send(malformed()).expect(403);
    expect(h.sessionResolver).not.toHaveBeenCalled();
    const invalidCsrf = await h.http.post(path).set("Host", HOST).set("Origin", ORIGIN)
      .set("Cookie", cookie).set(HEADER_CSRF, csrfB).type("application/json").send(malformed()).expect(403);
    expect(invalidCsrf.body.error.json.data.safe.reasonCode).toBe("CSRF_INVALID");
    const bootstrap = await h.http.get("/api/csrf").set("Host", HOST).expect(204);
    const token = extractCsrf(bootstrap, h.config);
    const anonymous = await h.http.post(path).set("Host", HOST).set("Origin", ORIGIN)
      .set("Cookie", requestCookies(h.config, undefined, token)).set(HEADER_CSRF, token)
      .type("application/json").send(malformed()).expect(401);
    expect(anonymous.body.error.json.data.safe.reasonCode).toBe("NO_SESSION");
    const invalidJson = await h.http.post(path).set("Host", HOST).set("Origin", ORIGIN)
      .set("Cookie", cookie).set(HEADER_CSRF, csrfA).type("application/json").send(malformed()).expect(400);
    expect(invalidJson.body.error.json.data.safe.reasonCode).toBe("INVALID_JSON");
    expect(h.effect).not.toHaveBeenCalled();
  });

  it("samples procedure rate denials even when the HTTP batch contains a success", async () => {
    const h = harness();
    h.services.rateLimiter = {
      consume: async (category, subject) => category === "auth_high_risk" && subject === `s:${a.sessionId}`
        ? { allowed: false, retryAfterSeconds: 24 } : { allowed: true, retryAfterSeconds: 0 },
    };
    const cookie = requestCookies(h.config, TOKEN_A, csrfA);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await h.http.get("/api/trpc/open,scarce?batch=1").set("Host", HOST)
        .set("Cookie", cookie).expect(207).expect("Retry-After", "24");
      expect(result.body[0].result.data.json.authenticated).toBe(true);
      expect(result.body[1].error.json.data.safe.reasonCode).toBe("RATE_LIMITED");
    }
    expect(h.audit.events).toHaveLength(0);
    expect(h.audit.notes).toEqual([expect.objectContaining({
      eventName: "http.rate_limited", reasonCode: "RATE_LIMITED", attributes: { procedure: "scarce", rateLimitBucket: "auth_high_risk" },
    })]);
  });
});

describe("HTTP edge: isolated preview controls", () => {
  it("uses header-only session/CSRF in preview with credentialless CORS and allows preview framing", async () => {
    const h = harness({}, { deploymentProfile: "preview", previewTransportEnabled: true });
    const host = "preview-proxy.example.test";
    const preview = await h.http.options("/api/trpc/signIn").set("Host", host).set("Origin", "null")
      .set("Access-Control-Request-Method", "POST").set("Access-Control-Request-Headers", `${HEADER_CSRF}, content-type`).expect(204);
    expect(preview.headers["access-control-allow-origin"]).toBe("*");
    expect(preview.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(preview.headers["content-security-policy"]).not.toContain("frame-ancestors");
    expect(preview.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(preview.headers["x-frame-options"]).toBeUndefined();
    await h.http.options("/api/trpc/signIn").set("Host", host).set("Origin", "null")
      .set("Access-Control-Request-Method", "POST").set("Access-Control-Request-Headers", "authorization").expect(403);
    const bootstrap = await h.http.get("/api/csrf").set("Host", host).set("Origin", "null").expect(204);
    const anonymous = bootstrap.headers[HEADER_PREVIEW_CSRF_SET] ?? "";
    expect(typeof anonymous).toBe("string");
    expect(bootstrap.headers["set-cookie"]).toBeUndefined();
    const signed = await h.http.post("/api/trpc/signIn").set("Host", host).set("Origin", "null")
      .set("Sec-Fetch-Site", "cross-site").set(HEADER_CSRF, anonymous).send({}).expect(200);
    expect(signed.headers[HEADER_PREVIEW_SESSION_SET]).toBe(TOKEN_A);
    expect(signed.headers[HEADER_PREVIEW_CSRF_SET]).toBe(csrfA);
    expect(signed.headers["access-control-expose-headers"]).toContain(HEADER_PREVIEW_SESSION_SET);
    expect(signed.headers["set-cookie"]).toBeUndefined();
    const cookieOnly = await h.http.get("/api/check").set("Host", host)
      .set("Cookie", requestCookies(h.config, TOKEN_A)).expect(200);
    expect(cookieOnly.body).toEqual({ actor: null });
    await h.http.post("/api/trpc/update").set("Host", host).set(HEADER_PREVIEW_SESSION, TOKEN_A).set(HEADER_CSRF, csrfB).expect(403);
    await h.http.post("/api/trpc/update").set("Host", host).set(HEADER_PREVIEW_SESSION, TOKEN_A).set(HEADER_CSRF, csrfA).send({}).expect(200);
    const clear = await h.http.post("/api/trpc/signOut").set("Host", host)
      .set(HEADER_PREVIEW_SESSION, TOKEN_A).set(HEADER_CSRF, csrfA).send({}).expect(200);
    expect(clear.headers[HEADER_PREVIEW_SESSION_SET]).toBe("");
    expect(clear.headers[HEADER_PREVIEW_CSRF_SET]).toBe("");
    expect(h.sessionResolver).toHaveBeenCalledWith({ token: TOKEN_A, transport: "preview-header" });
  });

  it.each(["production", "development", "test"] satisfies DeploymentProfile[])(
    "ignores every preview relaxation in %s, even if the derived feature boolean is true",
    async (deploymentProfile) => {
      const h = harness({}, { deploymentProfile, previewTransportEnabled: true });
      const res = await h.http.get("/api/check").set("Host", HOST).set("Origin", "null")
        .set(HEADER_PREVIEW_SESSION, TOKEN_A).expect(200, { actor: null });
      expect(h.sessionResolver).not.toHaveBeenCalled();
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      expect(res.headers[HEADER_PREVIEW_CSRF_SET]).toBeUndefined();
      expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(res.headers["cross-origin-resource-policy"]).toBe("same-origin");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      await h.http.get("/api/check").set("Host", "preview-proxy.example.test").expect(400);
      await h.http.post("/api/mutate").set("Host", HOST).set("Origin", "null").set(HEADER_CSRF, csrfA).expect(403);
    },
  );
});

describe("HTTP edge: bounds, errors, static assets and rendering", () => {
  const archivePath = "/api/files/archives/download";
  const archiveTicket = "synthetic-download-ticket".padEnd(43, "A");
  const archiveForm = { ticket: archiveTicket, csrf: csrfA };
  const archiveNavigation = {
    "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document",
  };

  it("accepts a bounded native ZIP form with canonical Origin or same-origin navigation and full-session CSRF", async () => {
    const payload = vi.fn();
    const moduleRouter = Router({ caseSensitive: true, strict: true });
    moduleRouter.post("/files/archives/download", (req, res) => { payload(req.body); res.status(204).end(); });
    const h = harness({ moduleRouter }, { aliasHosts: ["portal.readypackets.test"] });
    const { ticket } = archiveForm;
    const post = (url = archivePath, session = TOKEN_A, proof = csrfA) => h.http.post(url).set("Host", HOST)
      .set("Origin", ORIGIN).set("Sec-Fetch-Site", "same-origin").set("Cookie", requestCookies(h.config, session, proof));
    const refused = async (pending: ReturnType<typeof post>, denialReasonCode: string) => {
      const response = await pending.expect(204, "");
      expect(h.access).toHaveBeenCalledWith("http request", expect.objectContaining({
        status: 204, denialReasonCode, requestId: response.headers["x-request-id"],
      }));
    };

    await post().type("form").send(archiveForm).expect(204);
    await post().type("form").set("Origin", "null").set(archiveNavigation).send(archiveForm).expect(204);
    await post().type("form").set("Origin", "null").set({ ...archiveNavigation, "Sec-Fetch-Dest": "empty" })
      .send(archiveForm).expect(204);
    await post().type("json").set(HEADER_CSRF, csrfA).send({ ticket }).expect(204);
    expect(payload.mock.calls).toEqual(Array.from({ length: 4 }, () => [{ ticket }]));
    await refused(post().type("form").set("Origin", "https://external.example.test").send(archiveForm), "ORIGIN_NOT_ALLOWED");
    await refused(post().type("form").set("Host", "portal.readypackets.test").send(archiveForm), "NOT_FOUND");
    await refused(post(archivePath, "", csrfA).type("form").set("Origin", "null").set(archiveNavigation).send(archiveForm), "NO_SESSION");
    await refused(post(archivePath, TOKEN_B).type("form").set("Origin", "null").set(archiveNavigation).send(archiveForm), "CSRF_INVALID");
    await refused(post(archivePath, TOKEN_A, csrfB).type("form").send(archiveForm), "CSRF_INVALID");
    await refused(post().type("form").set(HEADER_CSRF, csrfA).send({ ticket }), "CSRF_INVALID");
    await refused(post().type("form").send({ csrf: csrfA, other: ticket }), "DOWNLOAD_TICKET_INVALID");
    await post().type("json").send(archiveForm).expect(403);
    await refused(post().type("form").send(`ticket=${ticket}&csrf=${csrfA}&csrf=${csrfA}`), "TOO_MANY_FORM_FIELDS");
    await refused(post().type("form").send({ csrf: csrfA, ticket: "A".repeat(1024) }), "BODY_TOO_LARGE");
    await refused(post().type("form").set("Content-Encoding", "gzip")
      .send(gzipSync(`ticket=${ticket}&csrf=${csrfA}`)), "UNSUPPORTED_ENCODING");
    for (const url of [`${archivePath}/`, `${archivePath}?alternate=1`, "/api/files/Archives/download", "/api/files/download"]) {
      await post(url).type("form").send(archiveForm).expect(403);
      await post(url).type("form").set("Origin", "null").set(archiveNavigation).send(archiveForm).expect(403);
    }
    await post().type("json").set("Origin", "null").set(archiveNavigation).set(HEADER_CSRF, csrfA).send({ ticket }).expect(403);
    const preview = harness({ moduleRouter }, { deploymentProfile: "preview" });
    await preview.http.post(archivePath).set("Host", HOST).type("form").send(archiveForm).expect(204, "");
    expect(payload).toHaveBeenCalledTimes(4);
    expect(h.audit.notes).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventName: "http.csrf.denied", reasonCode: "CSRF_INVALID" }),
    ]));
    const access = JSON.stringify(h.access.mock.calls);
    expect(access).not.toContain(ticket);
    expect(access).not.toContain(csrfA);
  });

  it.each([
    ["missing fetch site", { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" }],
    ["cross-site", { ...archiveNavigation, "Sec-Fetch-Site": "cross-site" }],
    ["same-site", { ...archiveNavigation, "Sec-Fetch-Site": "same-site" }],
    ["CORS mode", { ...archiveNavigation, "Sec-Fetch-Mode": "cors" }],
    ["missing mode", { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Dest": "document" }],
    ["missing destination", { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "navigate" }],
    ["framed navigation", { ...archiveNavigation, "Sec-Fetch-Dest": "iframe" }],
  ] as const)("audits and silently refuses a null-origin ZIP form with %s", async (_name, metadata) => {
    const h = harness();
    const response = await h.http.post(archivePath).set("Host", HOST).set("Origin", "null").set({ ...metadata })
      .set("Cookie", requestCookies(h.config, TOKEN_A, csrfA)).type("form").send(archiveForm).expect(204, "");
    expect(h.sessionResolver).not.toHaveBeenCalled();
    expect(h.audit.notes).toEqual([expect.objectContaining({
      eventName: "http.origin.denied", reasonCode: "ORIGIN_NOT_ALLOWED", outcome: "denied",
    })]);
    expect(h.access).toHaveBeenCalledWith("http request", expect.objectContaining({
      status: 204, denialReasonCode: "ORIGIN_NOT_ALLOWED", requestId: response.headers["x-request-id"],
    }));
  });

  it("preserves the page and Files audit on a malformed native ticket without changing JSON refusals", async () => {
    const moduleRouter = Router({ caseSensitive: true, strict: true });
    const files = Router({ caseSensitive: true, strict: true });
    moduleRouter.use("/files", files);
    const h = harness({ moduleRouter });
    const recordDenied = vi.fn(async () => undefined);
    const redeemDownloadTicket = vi.fn();
    Object.assign(h.services, { fileArchives: { recordDenied, redeemDownloadTicket } });
    registerFileArchiveHttpRoutes(files, h.services);
    const post = () => h.http.post(archivePath).set("Host", HOST).set("Cookie", requestCookies(h.config, TOKEN_A, csrfA));
    await post().set("Origin", "null").set(archiveNavigation).type("form")
      .send({ csrf: csrfA, ticket: "invalid" }).expect(204, "");
    await post().set("Origin", ORIGIN).set(HEADER_CSRF, csrfA).type("json").send({ ticket: "invalid" }).expect(400);
    expect(recordDenied.mock.calls).toEqual([[a, "DOWNLOAD_TICKET_INVALID"], [a, "DOWNLOAD_TICKET_INVALID"]]);
    expect(redeemDownloadTicket).not.toHaveBeenCalled();
  });

  it("admits only the literal ACS POST without browser credentials and applies the form cap before dispatch", async () => {
    const payload = vi.fn();
    const h = harness({ samlAcs: (req, res) => {
      payload(req.body);
      expect(getRequestContext()?.actor).toBeUndefined();
      res.redirect(303, "/sign-in");
    } }, { aliasHosts: ["portal.readypackets.test"] });
    const consume = vi.fn<RateLimiter["consume"]>(async () => ({ allowed: true, retryAfterSeconds: 0 }));
    h.services.rateLimiter = { consume };
    const path = "/api/identity/saml/acs";
    const form = "SAMLResponse=assertion-marker&RelayState=state-marker";
    const post = (url = path) => h.http.post(url).set("Host", HOST)
      .set("Origin", "https://provider.example.test").set("Sec-Fetch-Site", "cross-site")
      .set("User-Agent", "private-header-marker");
    const success = await post().type("form").set("Cookie", requestCookies(h.config, TOKEN_A)).send(form)
      .expect(303).expect("Cache-Control", "no-store").expect("Location", "/sign-in");
    expect(success.headers["set-cookie"]).toBeUndefined();
    expect(payload).toHaveBeenCalledWith({ SAMLResponse: "assertion-marker", RelayState: "state-marker" });
    expect(consume.mock.calls[0]?.[0]).toBe("auth_high_risk");
    for (const spelling of [`${path}/`, `${path}?RelayState=state-marker`, "/api/identity/saml/ACS", "/api/identity/saml/%61cs",
      "/api/identity/saml/start", "/api/identity/saml/metadata"]) {
      await post(spelling).type("form").send(form).expect(404);
    }
    await h.http.get(path).set("Host", HOST).expect(404);
    const alias = await post().set("Host", "portal.readypackets.test").type("form").send(form).expect(404);
    expect(alias.headers.location).toBeUndefined();
    await post().type("json").send({}).expect(415);
    await post().type("form").set("Content-Encoding", "gzip").send(gzipSync(form)).expect(415);
    await post().type("form").send(`SAMLResponse=${"A".repeat(262_145)}`).expect(413);
    await post().type("form").send(`${form}&extra=ignored`).expect(413);
    await post("/api/mutate").type("form").send(form).expect(403);
    await post("/api/identity/sso/complete").type("json").send({ attempt: "synthetic" }).expect(403);
    expect(payload).toHaveBeenCalledOnce();
    expect(h.sessionResolver).not.toHaveBeenCalled();
    const access = JSON.stringify(h.access.mock.calls);
    for (const marker of ["assertion-marker", "state-marker", "private-header-marker"]) expect(access).not.toContain(marker);

    const preview = harness({ samlAcs: vi.fn() }, { deploymentProfile: "preview" });
    await preview.http.post(path).set("Host", HOST).type("form").send(form).expect(404);
    expect(preview.sessionResolver).not.toHaveBeenCalled();
  });

  it("keeps the credential ban and durable rate budget on the isolated ACS path", async () => {
    const handler = vi.fn();
    const h = harness({ samlAcs: handler });
    let banned = true;
    h.services.protection = {
      credentialRetryAfter: async (req: Request) => banned && isSignInRequest(req) ? 85 : 0,
      inspect: async () => ({ action: "allow" }), recordRateLimit: async () => undefined,
    } as unknown as typeof h.services.protection;
    h.services.rateLimiter = { consume: async () => ({ allowed: false, retryAfterSeconds: 30 }) };
    const post = () => h.http.post("/api/identity/saml/acs").set("Host", HOST).type("form").send("SAMLResponse=synthetic");
    await post().expect(429).expect("Retry-After", "85");
    banned = false;
    await post().expect(429).expect("Retry-After", "30");
    expect(handler).not.toHaveBeenCalled();
    expect(h.sessionResolver).not.toHaveBeenCalled();
  });

  it("exempts only the canonical Stripe POST from the built-in country allow-list", async () => {
    const seen = vi.fn();
    const paymentWebhooks = () => {
      const r = Router({ caseSensitive: true, strict: true });
      r.post("/stripe", (req, res) => { seen(req.body); res.status(204).end(); });
      return r;
    };
    const h = harness({ isolatedRouters: { paymentWebhooks } }, { trustedProxies: ["127.0.0.1/32", "::1/128"] });
    const policy: ProtectionPolicy = { ...defaultPolicy, mode: "enforce", countries: { mode: "allow", codes: ["CA"] } };
    h.services.protection = {
      inspect: async (req: Request) => {
        const decision = compilePolicy(policy)(requestSignals(req, "US"), h.clock.now().getTime());
        return { action: decision.action === "block" ? "block" : "allow" };
      }, recordRateLimit: async () => undefined,
    } as unknown as typeof h.services.protection;
    const raw = '{\n "event":"synthetic"\n}';
    const path = "/api/payments/webhooks/stripe";
    const post = (url = path, body = raw) => h.http.post(url).set("Host", HOST)
      .set("X-Forwarded-For", "192.0.2.7").type("json").send(body);
    await post().expect(204);
    expect(seen).toHaveBeenCalledWith(Buffer.from(raw));
    await post(`${path}/`).expect(403);
    await post("/api/payments/webhooks/Stripe").expect(403);
    await post("/api/payments/webhooks/other").expect(403);
    await h.http.get(path).set("Host", HOST).expect(403);
    await post(path, JSON.stringify({ data: "A".repeat(262_145) })).expect(413);
    policy.ipLists = [{ network: "192.0.2.7/32", action: "deny", reason: "Synthetic policy fixture", expiresAt: null }];
    await post().expect(403);
    policy.ipLists = [];
    policy.countries = { mode: "deny", codes: ["US"] };
    await post().expect(403);
    policy.countries = { mode: "allow", codes: ["CA"] };
    policy.custom = [{
      id: "33333333-3333-4333-8333-333333333333", label: "Synthetic policy fixture",
      field: "country", operator: "exact", value: "US", action: "block",
    }];
    await post().expect(403);
    policy.custom = [];
    h.services.rateLimiter = { consume: async () => ({ allowed: false, retryAfterSeconds: 30 }) };
    await post().expect(429).expect("Retry-After", "30");
    expect(seen).toHaveBeenCalledOnce();
  });

  it("dispatches the isolated SAML POST to Identity by default and refuses an invalid form", async () => {
    const h = harness();
    const acs = vi.fn(async ({ samlResponse }: { samlResponse: unknown }) =>
      samlResponse === undefined ? "/sso/refused?reason=SSO_FAILED" : "/sso/complete?attempt=synthetic-attempt");
    h.services.identity = { sso: { acs } } as unknown as typeof h.services.identity;
    const post = (form: string) => h.http.post("/api/identity/saml/acs").set("Host", HOST)
      .set("Origin", "https://idp.example.test").set("Sec-Fetch-Site", "cross-site")
      .set("Cookie", requestCookies(h.config, TOKEN_A)).type("form").send(form);
    const accepted = await post("SAMLResponse=synthetic-assertion&RelayState=synthetic-state").expect(303)
      .expect("Location", "/sso/complete?attempt=synthetic-attempt")
      .expect("Cache-Control", "no-store").expect("Referrer-Policy", "no-referrer");
    expect(accepted.headers["set-cookie"]).toBeUndefined();
    expect(acs).toHaveBeenCalledWith({ samlResponse: "synthetic-assertion" });
    expect(acs).toHaveBeenCalledOnce();
    await post("RelayState=synthetic-state").expect(303).expect("Location", "/sso/refused?reason=SSO_FAILED");
    expect(acs).toHaveBeenNthCalledWith(2, { samlResponse: undefined });
    expect(acs).toHaveBeenCalledTimes(2);
    expect(h.sessionResolver).not.toHaveBeenCalled();
    expect(JSON.stringify(h.access.mock.calls)).not.toMatch(/synthetic-(?:assertion|state|attempt)/);
  });

  it("isolates increment 04 routers, preserves signed bytes and refuses alias, preview and alternate methods", async () => {
    const inbound = vi.fn();
    const returns = vi.fn();
    const publicApi = () => {
      const r = Router({ caseSensitive: true, strict: true });
      r.post("/orders", (req, res) => {
        expect(Buffer.isBuffer(req.body)).toBe(true);
        expect(getRequestContext()?.actor).toBeUndefined();
        res.json({ raw: req.body.toString("utf8"), path: req.path, requestId: getRequestContext()?.requestId });
      });
      return r;
    };
    const inboundWebhooks = () => {
      const r = Router({ caseSensitive: true, strict: true });
      r.post("/hook", (req, res) => { inbound(req.body); res.status(204).end(); });
      return r;
    };
    const paymentReturn = () => {
      const r = Router({ caseSensitive: true, strict: true });
      r.get("/example", (_req, res) => { returns(); res.status(204).end(); });
      return r;
    };
    const raw = "{\n  \"status\" : \"synthetic\"\n}";
    const h = harness({ isolatedRouters: { publicApi, inboundWebhooks, paymentReturn } }, { aliasHosts: ["portal.readypackets.test"] });
    const api = await h.http.post("/api/v1/orders").set("Host", HOST).set("X-RP-CSRF", "synthetic")
      .set("Cookie", requestCookies(h.config, TOKEN_A)).type("json").send(raw).expect(200);
    expect(api.body).toEqual({ raw, path: "/orders", requestId: api.headers["x-request-id"] });
    await h.http.post("/api/webhooks/inbound/hook").set("Host", HOST).type("json").send(raw).expect(204);
    expect(inbound).toHaveBeenCalledWith(Buffer.from(raw));
    await h.http.post("/api/webhooks/inbound/hook").set("Host", HOST).type("text").send(raw).expect(400);
    await h.http.post("/api/webhooks/inbound/hook").set("Host", HOST).type("json").send({ huge: "a".repeat(270_000) }).expect(413);
    await h.http.get("/api/webhooks/inbound/hook").set("Host", HOST).expect(404);
    const missing = await h.http.post("/api/v1/missing").set("Host", HOST).type("json").send(raw)
      .expect("Content-Type", /application\/problem\+json/u).expect(404);
    expect(missing.body).toMatchObject({ status: 404, request_id: missing.headers["x-request-id"] });
    await h.http.post("/API/V1/orders").set("Host", HOST).type("json").send(raw).expect(404);
    await h.http.get("/api/payments/return/example").set("Host", HOST).expect(204);
    const alias = await h.http.get("/Api/Payments/Return/example?state=synthetic-query").set("Host", "portal.readypackets.test").expect(404);
    expect(alias.headers.location).toBeUndefined();
    expect(JSON.stringify(h.access.mock.calls)).not.toContain("synthetic-query");
    expect(returns).toHaveBeenCalledTimes(1);
    expect(h.sessionResolver).not.toHaveBeenCalled();
    const preview = harness({ isolatedRouters: { publicApi } }, { deploymentProfile: "preview" });
    await preview.http.post("/api/v1/orders").set("Host", HOST).type("json").send(raw).expect(404);
  });

  it("mounts the default Public API adapter without resolving browser cookies", async () => {
    const h = harness();
    const handle = vi.fn(async () => ({
      status: 200, headers: { "content-type": "application/json" }, body: '{"openapi":"3.1.0"}',
    }));
    h.services.publicApi = { handle } as unknown as typeof h.services.publicApi;
    const response = await h.http.get("/api/v1/openapi.json").set("Host", HOST)
      .set("X-Request-Id", "untrusted-api-id").set("Cookie", requestCookies(h.config, TOKEN_A))
      .expect(200, { openapi: "3.1.0" });
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({
      method: "GET", target: "/openapi.json", body: Buffer.alloc(0), requestId: response.headers["x-request-id"],
    }));
    expect(response.headers["x-request-id"]).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(h.sessionResolver).not.toHaveBeenCalled();
  });

  it("passes exact JSON bytes to the default inbound webhook adapter without resolving cookies", async () => {
    const h = harness();
    const receiveInboundHttp = vi.fn(async () => ({ httpStatus: 200, body: { ok: true } }));
    h.services.integrations = { webhooks: { receiveInboundHttp } } as unknown as typeof h.services.integrations;
    const endpointPublicId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const body = '{\n "event":"synthetic"\n}';
    const response = await h.http.post(`/api/webhooks/inbound/${endpointPublicId}`).set("Host", HOST)
      .set("Cookie", requestCookies(h.config, TOKEN_A)).type("json").send(body).expect(200, { ok: true });
    expect(receiveInboundHttp).toHaveBeenCalledWith(expect.objectContaining({
      endpointPublicId, rawBody: Buffer.from(body), correlationId: response.headers["x-correlation-id"],
    }));
    expect(response.headers["x-correlation-id"]).toBe(response.headers["x-request-id"]);
    expect(h.sessionResolver).not.toHaveBeenCalled();
  });

  it("mounts the default payment adapters with a fixed return and canonical notification target", async () => {
    const h = harness();
    const handleSignedWebhook = vi.fn(async () => ({
      httpStatus: 200, accepted: true, duplicate: false, booked: false, reasonCode: "SYNTHETIC",
    }));
    Object.assign(h.services, { payments: { handleSignedWebhook } });
    const attempt = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const body = '{\n "id":"synthetic"\n}';
    await h.http.post("/api/payments/webhooks/square").set("Host", HOST).type("json")
      .set("Cookie", requestCookies(h.config, TOKEN_A)).send(body).expect(200);
    expect(handleSignedWebhook).toHaveBeenCalledWith(expect.objectContaining({
      provider: "square", rawBody: Buffer.from(body), notificationUrl: `${ORIGIN}/api/payments/webhooks/square`,
    }));
    await h.http.get(`/api/payments/return/stripe/${attempt}?flow=checkout&next=https://other.example.test`).set("Host", HOST)
      .expect(303).expect("Location", `/checkout/return?attempt=${attempt}`);
    expect(handleSignedWebhook).toHaveBeenCalledTimes(1);
    expect(h.sessionResolver).not.toHaveBeenCalled();
  });

  it("does not log the payment receiver's exception message", async () => {
    const h = harness();
    const error = vi.fn();
    h.services.logger.error = error;
    Object.assign(h.services, { payments: { handleSignedWebhook: async () => { throw new Error("synthetic-sensitive-provider-detail"); } } });
    await h.http.post("/api/payments/webhooks/stripe").set("Host", HOST)
      .type("json").send({ id: "synthetic" }).expect(500)
      .expect({ ok: false, reasonCode: "INTERNAL_WEBHOOK_ERROR" });
    expect(error).toHaveBeenCalledWith("Unhandled error in payment webhook receiver", expect.objectContaining({
      provider: "stripe", reasonCode: "UNHANDLED_EXCEPTION", errorName: "Error",
    }));
    expect(JSON.stringify(error.mock.calls)).not.toContain("synthetic-sensitive-provider-detail");
  });

  it("passes only narrow webhook bytes ahead of JSON parsing and enforces request body limits", async () => {
    const signedWebhookRouter = Router();
    signedWebhookRouter.post("/synthetic", (req, res) => {
      expect(Buffer.isBuffer(req.body)).toBe(true);
      expect(req.body.toString("utf8")).toBe("{\n \"example\": true\n}");
      if (req.get("X-Synthetic-Signature") !== "example") return res.status(403).end();
      return res.status(204).end();
    });
    const h = harness({ signedWebhookRouter });
    await h.http.post("/api/integrations/webhooks/synthetic").set("Host", HOST).set("Content-Type", "application/json")
      .set("X-Synthetic-Signature", "example").set("Cookie", requestCookies(h.config, TOKEN_A)).send("{\n \"example\": true\n}").expect(204);
    expect(h.sessionResolver).not.toHaveBeenCalled();
    await h.http.post("/api/integrations/webhooks/unknown").set("Host", HOST).send({ example: true }).expect(404);
    await h.http.get("/api/integrations/webhooks/synthetic").set("Host", HOST).expect(404);
    const oversized = await h.http.post("/api/mutate").set("Host", HOST).set("Origin", ORIGIN)
      .send({ example: "x".repeat(256 * 1024) }).expect(413);
    expect(oversized.body.safe.reasonCode).toBe("BODY_TOO_LARGE");
    const malformed = await h.http.post("/api/mutate").set("Host", HOST).set("Origin", ORIGIN)
      .set("Content-Type", "application/json").send("{not json").expect(400);
    expect(malformed.body.safe.reasonCode).toBe("INVALID_JSON");
    expect(malformed.text).not.toContain("{not json");
  });

  it("leaves multipart and octet-stream bodies for authorized streaming module handlers", async () => {
    const h = harness();
    const post = () => h.http.post("/api/stream").set("Host", HOST).set("Origin", ORIGIN)
      .set(HEADER_CSRF, csrfA).set("Cookie", requestCookies(h.config, TOKEN_A, csrfA));
    await post().set("Content-Type", "application/octet-stream").send(Buffer.from("example")).expect(200, { bytes: 7 });
    const multipart = await post().field("example", "sample").expect(200);
    expect(multipart.body.bytes).toBeGreaterThan(7);
  });

  it("formats safe HTTP and tRPC errors and streams downloads with defensive attachment headers", async () => {
    const h = harness();
    const domain = await h.http.get("/api/domain").set("Host", HOST).expect(404);
    expect(domain.body.safe).toMatchObject({ reasonCode: "SYNTHETIC_NOT_FOUND", requestId: domain.headers["x-request-id"] });
    const raw = await h.http.get("/api/failure").set("Host", HOST).expect(500);
    expect(raw.body.safe).toMatchObject({ domainCode: "INTERNAL", reasonCode: "INTERNAL_ERROR" });
    expect(raw.text).not.toMatch(/never-echo|stack|synthetic path/);
    const trpc = await h.http.get("/api/trpc/failure").set("Host", HOST).expect(500);
    expect(trpc.body.error.json.data.safe.requestId).toBe(trpc.headers["x-request-id"]);
    expect(trpc.text).not.toMatch(/SELECT|synthetic_internal_only|stack/);
    const conflict = await h.http.get("/api/trpc/domain").set("Host", HOST).expect(409);
    expect(conflict.body.error.json.data.safe.reasonCode).toBe("SYNTHETIC_CONFLICT");

    const download = await h.http.get("/api/private/download").set("Host", HOST).expect(200);
    expect(download.body.toString()).toBe("example");
    expect(download.headers["content-disposition"]).toBe("attachment; filename=\"caf____bill.pdf\"; filename*=UTF-8''caf%C3%A9___bill.pdf");
    expect(download.headers["content-security-policy"]).toContain("sandbox");
    expect(download.headers["content-length"]).toBe("7");
    expect(download.headers["x-content-type-options"]).toBe("nosniff");
    expect(download.headers["cache-control"]).toBe("no-store");
  });

  it("serves only navigation fallback, nonces the shell, excludes API/static misses and honors caching", async () => {
    const h = harness({ staticDir: STATIC, publicPaths: ["/samples"] });
    const shell = await h.http.get("/orders/example").set("Host", HOST).set("Accept", "text/html").expect(200);
    const nonce = /'nonce-([^']+)'/.exec(shell.headers["content-security-policy"] ?? "")?.[1];
    expect(shell.text).toContain(`src="/assets/app-A123b456.js" nonce="${nonce}"`);
    expect(shell.headers["cache-control"]).toBe("no-cache");
    expect(shell.headers["x-robots-tag"]).toContain("noindex");
    await h.http.get("/orders/example").set("Host", HOST).expect(404);
    await h.http.get("/orders/example").set("Host", HOST).set("Accept", "text/html").set("Sec-Fetch-Mode", "cors").expect(404);
    await h.http.get("/api/unknown").set("Host", HOST).set("Accept", "text/html").expect(404);
    await h.http.get("/API/unknown").set("Host", HOST).set("Accept", "text/html").expect(404);
    await h.http.get("/assets/unknown").set("Host", HOST).set("Accept", "text/html").expect(404);
    await h.http.get("/assets/app-A123b456.js").set("Host", HOST).expect(200).expect("Cache-Control", "public, max-age=31536000, immutable");
    await h.http.get("/sw.js").set("Host", HOST).expect(200).expect("Cache-Control", "no-cache");
    await h.http.get("/robots.txt").set("Host", HOST).expect(200, "User-agent: *\nDisallow: /\n");
    const reviewedPublic = await h.http.get("/samples").set("Host", HOST).set("Accept", "text/html").expect(200);
    expect(reviewedPublic.headers["x-robots-tag"]).toBeUndefined();
    const authenticated = await h.http.get("/samples").set("Host", HOST).set("Accept", "text/html")
      .set("Cookie", requestCookies(h.config, TOKEN_A)).expect(200);
    expect(authenticated.headers["x-robots-tag"]).toContain("noindex");
    expect(authenticated.headers["cache-control"]).toBe("no-store");
  });

  it("nonces navigations to dotted mail-template identifiers without serving the shell for file probes", async () => {
    const h = harness({ staticDir: STATIC });
    h.services.jobAdmin = { getBuiltinMailTemplates: () => [
      { key: "auth.password_reset" }, { key: "orders.phase_update" },
    ] } as typeof h.services.jobAdmin;
    const get = (path: string) => h.http.get(path).set("Host", HOST).set("Accept", "text/html");
    for (const path of [
      "/admin/email-templates/auth.password_reset", "/admin/email-templates/auth%2Epassword_reset",
      "/admin/email-templates/orders.phase_update", "/admin/email-templates/custom.order_followup",
    ]) {
      const shell = await get(path).set("Sec-Fetch-Mode", "navigate").expect(200).expect("Content-Type", /html/);
      const nonce = /'nonce-([^']+)'/.exec(shell.headers["content-security-policy"] ?? "")?.[1];
      expect(nonce).toMatch(/^[A-Za-z0-9_-]{24}$/u);
      expect(shell.text).toContain(`src="/assets/app-A123b456.js" nonce="${nonce}"`);
    }
    for (const path of [
      "/missing.png", "/admin/email-templates/x.png?check=1", "/admin/email-templates/auth.png",
      "/admin/email-templates/x%2Epng", "/admin/email-templates/Auth.password_reset",
      "/admin/email-templates/nested%2Fauth.password_reset", "/admin/email-templates-extra/auth.password_reset",
      "/.env", "/%2Eenv", "/.git/config", "/foo.php", "/foo.php%2Fbar", "/wp-login.php", "/admin/x.js.map", "/sitemap.xml",
    ]) {
      const missing = await get(path).expect(404);
      expect(missing.text, path).not.toContain("Synthetic portal shell");
    }
    await get("/admin/email-templates/auth.password_reset").set("Sec-Fetch-Mode", "cors").expect(404);
    await h.http.get("/admin/email-templates/auth.password_reset").set("Host", HOST).expect(404);
  });

  it("refuses static roots that overlap private storage even if the storage child does not yet exist", () => {
    expect(() => harness({ staticDir: STATIC }, { storageDir: `${STATIC}/future-private-data` })).toThrow(/must not overlap/);
    expect(() => harness({ staticDir: STATIC }, { storageDir: fileURLToPath(new URL(".", import.meta.url)) })).toThrow(/must not overlap/);
  });

  it("permits only exact HTTPS analytics sources and does not consult policy on authenticated or sensitive routes", async () => {
    const h = harness({ staticDir: STATIC });
    const analyticsCsp = vi.fn(async (_path: string) => ({
      scriptSrc: ["https://scripts.example.test", "'unsafe-inline'", "https://*.example.test"],
      connectSrc: ["https://collect.example.test", "https://no.example.test; object-src https:", "http://insecure.example.test"],
    }));
    h.services.integrations = { analyticsCsp } as unknown as typeof h.services.integrations;
    const receive = (path: string) => h.http.get(path).set("Host", HOST).set("Accept", "text/html");
    const anonymous = await receive("/privacy?plan=untrusted").expect(200);
    expect(anonymous.headers["content-security-policy"]).toContain("https://scripts.example.test");
    expect(anonymous.headers["content-security-policy"]).toContain("https://collect.example.test");
    expect(anonymous.headers["content-security-policy"]).not.toMatch(/unsafe-inline|no\.example|insecure\.example|\*/);
    await receive("/terms").set("Cookie", requestCookies(h.config, TOKEN_A)).expect(200);
    await receive("/sign-in").expect(200);
    await receive("/admin").expect(200);
    expect(analyticsCsp.mock.calls).toEqual([["/privacy"]]);
  });
});
