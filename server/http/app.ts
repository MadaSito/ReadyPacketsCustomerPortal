/**
 * Express application composition. Owner: http_security engineer.
 *
 * REQUIRED ORDER (architecture §4.1 / §9.3):
 *   1. trust-proxy from config.trustedProxies; server-generated request context (AsyncLocalStorage)
 *   2. host validation (canonical host only; alias hosts 308 → canonical; unknown hosts refused)
 *   3. security headers + per-response nonce CSP; preview CORS
 *   4. cheap address admission, origin checks, durable edge budgets and bounded body parsers
 *      (signed webhooks use a separate raw body route with no browser credentials)
 *   5. session resolution (services.sessionResolver) → request actor
 *   6. session-bound CSRF validation for unsafe methods
 *   7. CSRF bootstrap  8. /api/trpc (independent procedure budgets)  9. module raw routes
 *  10. health endpoints  11. static assets + SPA fallback (prebuilt dist/public; no dev server in production)
 *  12. safe JSON error handler (never stacks/SQL/paths)
 */
import { performance } from "node:perf_hooks";
import express, { type ErrorRequestHandler, type Express, type Request, type RequestHandler, type Router } from "express";
import type { AnyTRPCProcedure, AnyTRPCRouter } from "@trpc/server";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { HEADER_CSRF } from "../../shared/sessionTransportHeaders.js";
import { MAX_REQUEST_TARGET_LENGTH, TRPC_MAX_BATCH_SIZE } from "../../shared/apiLimits.js";
import type { Services } from "../container.js";
import { DomainError, notFound, validation } from "../core/errors.js";
import { getRequestContext, newRequestContext, runWithRequestContext, setRequestActor, traceFromHeader } from "../core/requestContext.js";
import type { AuditEventInput, RateLimitCategory } from "../core/types.js";
import * as integrationHttp from "../modules/integrations/http.js";
import type { ProtectionModule } from "../modules/protection/index.js";
import {
  ANONYMOUS_CSRF_MAX_AGE_MS, deriveSessionCsrfToken, isAnonymousCsrfToken,
  issueAnonymousCsrfToken, matchesSessionCsrfToken, secureEqual,
} from "../security/csrf.js";
import { applySecurityHeaders, newCspNonce, setAnalyticsCsp, type AnalyticsCspPolicy } from "../security/headers.js";
import { rateLimitAddress } from "../security/rateLimitAddress.js";
import { createTrpcContext } from "../trpc/context.js";
import { appRouter } from "../trpc/root.js";
import { API_PATH, SIGNED_WEBHOOK_PATH, TRPC_PATH, acceptsLocalProbe, clientAddress, isNavigation, providerCallbackRoute, requestHost, routeTemplate } from "./edge.js";
import { createEdgeAdmission } from "./edgeAdmission.js";
import { sendSafeError, trpcRetryAfter } from "./errors.js";
import { createIsolatedHttpRouter, isolatedRoutePrefix, type IsolatedRouterFactories } from "./isolatedRoutes.js";
import { createModuleHttpRouter } from "./moduleRoutes.js";
import { previewProfile } from "./previewProfile.js";
import { getHttpState, setHttpState } from "./requestState.js";
import { cookieCredentials, cookieTransport, readCookie, setCsrfCookie } from "./sessionTransport.js";
import { assertSeparateStorage, registerStatic } from "./static.js";

export interface AppOptions {
  /** Directory with the built client (dist/public). Omit to serve API only (tests). */
  staticDir?: string;
  /** Exact public HTML paths explicitly reviewed for indexing. Default: empty (all portal pages noindex). */
  publicPaths?: readonly string[];
  /** Internal application composition seams; never set from runtime configuration. */
  trpcRouter?: AnyTRPCRouter;
  moduleRouter?: Router;
  signedWebhookRouter?: Router;
  isolatedRouters?: IsolatedRouterFactories;
}

const JSON_LIMIT_BYTES = 256 * 1024;
const MAX_BATCH_SIZE = TRPC_MAX_BATCH_SIZE;
const MAX_REQUEST_TARGET = MAX_REQUEST_TARGET_LENGTH;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const PROBE_PATHS = new Set(["/healthz", "/readyz"]);
const CATEGORY_PRIORITY: Record<RateLimitCategory, number> = {
  standard_browsing: 0, api: 1, form_submission: 2, expensive: 3, user_login: 4, auth_high_risk: 5,
};
const METHOD_LABELS = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "CONNECT", "TRACE"]);
const WEBHOOK_LIMIT = 256 * 1024;
const ANALYTICS_CSP_PATHS = new Set(["/privacy", "/terms"]);

function hasCanonicalOrigin(req: Request, origin: string, allowMissingOrigin = false): boolean {
  const site = req.get("Sec-Fetch-Site");
  if (site !== undefined && site !== "same-origin") return false;
  const sent = req.get("Origin");
  return sent === origin || (allowMissingOrigin && sent === undefined);
}

function pathIn(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function tRpcCalls(req: Request): string[] {
  const path = req.path.slice(TRPC_PATH.length + 1);
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return [];
  }
  if (!/^[a-zA-Z0-9_.]+(?:,[a-zA-Z0-9_.]+)*$/.test(decoded)) return [];
  return decoded.split(",", MAX_BATCH_SIZE + 1);
}

function batchSizeForError(req: Request): number | undefined {
  if (!pathIn(TRPC_PATH, req.path) || req.query.batch !== "1") return undefined;
  const count = tRpcCalls(req).length;
  return count > 0 && count <= MAX_BATCH_SIZE ? count : undefined;
}

function tRpcBudget(router: AnyTRPCRouter, calls: readonly string[]): RateLimitCategory {
  const procedures: Record<string, AnyTRPCProcedure> = router._def.procedures;
  let strictest: RateLimitCategory = "api";
  for (const path of calls) {
    const meta = Object.hasOwn(procedures, path) ? procedures[path]?._def.meta : undefined;
    if (!meta || typeof meta !== "object" || !("rateLimit" in meta) || typeof meta.rateLimit !== "string" ||
        !Object.hasOwn(CATEGORY_PRIORITY, meta.rateLimit)) continue;
    const category = meta.rateLimit as RateLimitCategory;
    if (CATEGORY_PRIORITY[category] > CATEGORY_PRIORITY[strictest]) strictest = category;
  }
  return strictest;
}

async function applyRateLimit(services: Services, category: RateLimitCategory, key: string, cost = 1): Promise<void> {
  const verdict = await services.rateLimiter.consume(category, key, cost);
  if (!verdict.allowed) throw rateLimited(verdict.retryAfterSeconds);
}

function rateLimited(retryAfterSeconds: number): DomainError {
  return new DomainError("RATE_LIMITED", "RATE_LIMITED", "Too many requests. Please wait a moment and try again.", { retryAfterSeconds });
}

export function createApp(services: Services, options: AppOptions = {}): Express {
  const { config } = services;
  const canonical = new URL(config.canonicalOrigin);
  if (canonical.protocol !== "https:" && canonical.protocol !== "http:") throw new Error("Invalid canonical HTTP origin");
  if (options.staticDir) assertSeparateStorage(options.staticDir, config.storageDir);
  const anonymousKey = Buffer.from(config.tokenHashKey, "base64");
  const admission = createEdgeAdmission(anonymousKey);
  const currentAddress = () => rateLimitAddress(getRequestContext()?.ipAddress);
  function noteDenial(kind: 1 | 2 | 4, event: Pick<AuditEventInput, "eventName" | "reasonCode" | "attributes">): void {
    if (admission.shouldNote(currentAddress(), services.clock.now().getTime(), kind)) {
      try {
        services.audit.note({
          ...event, category: "security", action: "request", outcome: "denied", severity: "WARN",
        });
      } catch { /* A failed best-effort audit note cannot affect the denial. */ }
    }
  }
  function denyBrowserRequest(reason: "ORIGIN_NOT_ALLOWED" | "CSRF_INVALID"): never {
    const origin = reason === "ORIGIN_NOT_ALLOWED";
    noteDenial(origin ? 1 : 2, { eventName: origin ? "http.origin.denied" : "http.csrf.denied", reasonCode: reason });
    throw new DomainError("FORBIDDEN", reason, origin
      ? "This request did not come from the portal origin."
      : "Your security token is no longer valid. Reload the page and try again.");
  }
  const app = express();
  const preview = previewProfile(config);
  const router = options.trpcRouter ?? appRouter;
  const publicPaths = new Set(options.publicPaths ?? []);
  const aliases = new Set(config.aliasHosts);
  app.disable("x-powered-by");
  app.enable("case sensitive routing");
  app.enable("strict routing");
  app.set("query parser", "simple");
  app.set("trust proxy", config.trustedProxies.length ? [...config.trustedProxies] : false);
  const trust = app.get("trust proxy fn") as (address: string, distance: number) => boolean;
  const nonceByRequest = new WeakMap<Request, string>();

  // 1. Set the request identity before every rejection and preserve correlation in access records.
  app.use((req, res, next) => {
    const peer = req.socket.remoteAddress;
    const address = clientAddress(req);
    const trusted = peer !== undefined && trust(peer, 0);
    const context = newRequestContext("http", {
      ...traceFromHeader(req.get("traceparent"), trusted),
      ipAddress: address,
      userAgent: req.get("User-Agent")?.slice(0, 256),
      startedAt: services.clock.now(),
    });
    const started = performance.now();
    const route = routeTemplate(req);
    const method = METHOD_LABELS.has(req.method) ? req.method : "OTHER";
    res.setHeader("X-Request-Id", context.requestId);
    runWithRequestContext(context, () => {
      res.once("close", () => runWithRequestContext(context, () => {
        services.logger.info("http request", {
          method, route,
          status: res.writableFinished ? res.statusCode : 499,
          durationMs: Math.round(performance.now() - started),
          requestId: context.requestId, traceId: context.traceId, spanId: context.spanId,
        });
      }));
      next();
    });
  });

  // 2–3. Decide authority first; set security headers even on early refusals.
  app.use((req, res, next) => {
    const actual = requestHost(req, canonical);
    const alias = !!actual && aliases.has(actual.hostname) && actual.host === actual.hostname;
    const canonicalHost = actual?.host === canonical.host;
    const accepted = preview?.avoidsCanonicalHost || canonicalHost || acceptsLocalProbe(req, actual?.hostname);
    const nonce = newCspNonce();
    nonceByRequest.set(req, nonce);
    applySecurityHeaders(res, nonce, {
      https: (canonicalHost || alias) && (canonical.protocol === "https:" || req.secure),
      preview,
      noStore: API_PATH.test(req.path) || !accepted || req.path === "/healthz" || req.path === "/readyz",
    });
    // Reject non-origin-form and ambiguous separators before any redirect or routing.
    if (req.originalUrl.length > MAX_REQUEST_TARGET || !req.originalUrl.startsWith("/") || /[\s\\#]/.test(req.originalUrl)) {
      throw validation("INVALID_REQUEST_TARGET", "The request target is invalid.");
    }
    // Path-pattern test only (no lookup): provider callbacks exist on the canonical host and nowhere else.
    const isolated = isolatedRoutePrefix(req.path);
    if ((!canonicalHost && (providerCallbackRoute(req.path) || isolated)) || (isolated && preview)) throw notFound();
    if (!accepted) {
      if (alias) {
        // Concatenate only an origin-form target to the known origin; never resolve a user-controlled URL.
        res.redirect(308, `${canonical.origin}${req.originalUrl}`);
        return;
      }
      throw validation("HOST_NOT_ALLOWED", "This host is not served by the portal.");
    }
    if (preview && API_PATH.test(req.path)) {
      preview.applyHeaders(res);
      if (preview.handlePreflight(req, res)) return;
    }
    next();
  });

  // No database, credential lookup or durable audit before this admission gate.
  app.use((req, _res, next) => {
    if (PROBE_PATHS.has(req.path) && (req.method === "GET" || req.method === "HEAD")) return next();
    const retry = admission.consume(currentAddress(), services.clock.now().getTime());
    if (retry > 0) throw rateLimited(retry);
    next();
  });

  app.use(async (req, _res, next) => {
    const protection = (services as Services & { protection?: ProtectionModule }).protection;
    if (protection && (await protection.inspect(req)).action === "block") {
      throw new DomainError("FORBIDDEN", "PROTECTION_BLOCKED", "This request was refused by the portal's protection policy.");
    }
    next();
  });

  app.use(createIsolatedHttpRouter(services, options.isolatedRouters ?? {}, async (_req, _res, next) => {
    await applyRateLimit(services, "api", `ip:${currentAddress()}`);
    next();
  }));

  app.use((req, _res, next) => {
    const bootstrap = req.path === "/api/csrf" && (req.method === "GET" || req.method === "HEAD");
    if (!pathIn(SIGNED_WEBHOOK_PATH, req.path) && !preview?.usesExplicitCredentials &&
        (bootstrap || !SAFE_METHODS.has(req.method)) && !hasCanonicalOrigin(req, canonical.origin, bootstrap)) {
      denyBrowserRequest("ORIGIN_NOT_ALLOWED");
    }
    next();
  });

  const signedWebhooks = options.signedWebhookRouter ?? express.Router({ caseSensitive: true, strict: true });
  if (!options.signedWebhookRouter) {
    const integrations = integrationHttp as typeof integrationHttp & {
      registerSignedIntegrationWebhooks?: (handler: Router, services: Services) => void;
    };
    integrations.registerSignedIntegrationWebhooks?.(signedWebhooks, services);
  }
  app.use(SIGNED_WEBHOOK_PATH,
    (async (req, _res, next) => {
      if (req.method !== "POST") throw notFound();
      if (!req.is("application/json")) throw validation("UNSUPPORTED_WEBHOOK_CONTENT", "This endpoint accepts JSON.");
      const subject = `ip:${currentAddress()}`;
      await applyRateLimit(services, "api", subject);
      next();
    }) satisfies RequestHandler,
    express.raw({ type: "application/json", limit: WEBHOOK_LIMIT, inflate: false }),
    signedWebhooks,
    () => { throw notFound(); },
  );

  // Cross-replica admission, also before session resolution. The strictest tRPC budget wins.
  app.use(async (req, _res, next) => {
    const subject = `ip:${currentAddress()}`;
    if (pathIn(TRPC_PATH, req.path)) {
      const calls = tRpcCalls(req);
      if (!calls.length || (calls.length > 1 && req.query.batch !== "1")) {
        throw validation("INVALID_PROCEDURE_PATH", "The requested operation is not valid.");
      }
      if (calls.length > MAX_BATCH_SIZE) throw validation("BATCH_TOO_LARGE", "This batch includes too many operations.");
      await applyRateLimit(services, tRpcBudget(router, calls), `edge:${subject}`, calls.length);
    } else if (API_PATH.test(req.path)) {
      const category = pathIn("/api/files", req.path) || pathIn("/api/portable", req.path) || pathIn("/api/backup", req.path)
        ? "expensive" : pathIn("/api/identity", req.path) || pathIn("/api/assurance", req.path)
          ? "auth_high_risk" : "api";
      await applyRateLimit(services, category, subject);
    } else if (isNavigation(req) && !PROBE_PATHS.has(req.path)) {
      await applyRateLimit(services, "standard_browsing", subject);
    }
    next();
  });

  // 4. Reject oversized/malformed JSON (no inflation); multipart and binary remain untouched.
  app.use("/api", express.json({ limit: JSON_LIMIT_BYTES, inflate: false, strict: true }));

  // 5. Resolve authoritative identity once, before CSRF, including remediation sessions.
  app.use(async (req, res, next) => {
    const context = getRequestContext()!;
    const credentials = preview?.credentials(req) ?? cookieCredentials(req, config);
    const probe = PROBE_PATHS.has(req.path);
    const session = !probe && credentials.token && credentials.token.length <= 512
      ? await services.sessionResolver.resolve(credentials) : null;
    const transport = preview?.transport(res) ?? cookieTransport(res, config);
    setHttpState(req, { context, session, transport, cspNonce: nonceByRequest.get(req)! });
    if (session) {
      setRequestActor({ userId: session.userId, role: session.role, sessionId: session.sessionId });
      res.setHeader("Cache-Control", "no-store");
    }
    next();
  });

  // 6. Session-bound double submit on unsafe methods. Origin was already checked.
  app.use((req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const { session } = getHttpState(req);
    const token = req.get(HEADER_CSRF);
    const cookie = preview?.usesExplicitCredentials ? token : readCookie(req, config.csrfCookieName);
    const matches = token && cookie && secureEqual(token, cookie) && (session
      ? matchesSessionCsrfToken(token, session.sessionId, session.csrfSecret)
      : isAnonymousCsrfToken(token, services.clock.now(), anonymousKey));
    if (!matches) denyBrowserRequest("CSRF_INVALID");
    next();
  });

  app.get("/api/csrf", async (req, res) => {
    const session = getHttpState(req).session;
    const now = services.clock.now();
    const existing = preview ? undefined : readCookie(req, config.csrfCookieName);
    const validExisting = !session && existing && isAnonymousCsrfToken(existing, now, anonymousKey);
    const token = session ? deriveSessionCsrfToken(session.sessionId, session.csrfSecret)
      : validExisting ? existing : issueAnonymousCsrfToken(now, anonymousKey);
    if (preview) preview.setCsrf(res, token);
    else if (!validExisting) setCsrfCookie(res, config, token, session ? undefined : new Date(now.getTime() + ANONYMOUS_CSRF_MAX_AGE_MS));
    res.status(204).end();
  });

  // 8. tRPC method dispatch (mutations are never GET), with both path and body bounded.
  app.use(TRPC_PATH, createExpressMiddleware({
    router,
    createContext: ({ req }) => createTrpcContext(services, req),
    onError({ error, path }) {
      const cause = error.cause;
      if (cause instanceof DomainError && cause.code === "RATE_LIMITED" && path &&
          Object.hasOwn(router._def.procedures, path)) {
        noteDenial(4, { eventName: "http.rate_limited", reasonCode: "RATE_LIMITED", attributes: { procedure: path } });
      }
    },
    maxBatchSize: MAX_BATCH_SIZE,
    maxBodySize: JSON_LIMIT_BYTES,
    allowMethodOverride: false,
    responseMeta({ errors }) {
      const seconds = trpcRetryAfter(errors);
      return seconds === undefined ? {} : { headers: new Headers({ "Retry-After": String(seconds) }) };
    },
  }));

  // 9. Raw module routes and an explicit API fallback; no API request reaches the SPA.
  app.use("/api", options.moduleRouter ?? createModuleHttpRouter(services), () => { throw notFound(); });

  // 10. Liveness intentionally avoids database and session stores.
  app.get("/healthz", (_req, res) => { res.json({ ok: true }); });
  app.get("/readyz", async (_req, res) => {
    let ready = false;
    try {
      ready = (await services.platform.readiness()).ready === true;
    } catch {
      services.logger.warn("http readiness probe unavailable");
    }
    res.status(ready ? 200 : 503).json({ ready });
  });

  // 11. Portal indexing is opt-in; analytics CSP can only be admitted on anonymous reviewed routes.
  app.get("/robots.txt", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.type("text/plain").send("User-agent: *\nDisallow: /\n");
  });
  if (options.staticDir) {
    app.use(async (req, res, next) => {
      const { session, cspNonce } = getHttpState(req);
      if (!session && ANALYTICS_CSP_PATHS.has(req.path) && isNavigation(req)) {
        const integrations = services.integrations as (typeof services.integrations & {
          analyticsCsp?: (path: string) => Promise<AnalyticsCspPolicy | null>;
        }) | undefined;
        try {
          const policy = await integrations?.analyticsCsp?.(req.path);
          if (policy) setAnalyticsCsp(res, cspNonce, preview, policy);
        } catch {
          services.logger.warn("http analytics CSP policy unavailable");
        }
      }
      next();
    });
    registerStatic(app, options.staticDir, publicPaths);
  }
  app.use(() => { throw notFound(); });

  // 12. The only raw Express error response; never call the Express default stack renderer.
  app.use(((error: unknown, req, res, _next) => {
    if (res.headersSent || res.destroyed) {
      if (!res.destroyed) res.destroy();
      return;
    }
    if (!(error instanceof DomainError) && !(error instanceof Error && "type" in error)) {
      services.logger.error("unhandled http request error");
    }
    sendSafeError(error, req, res, getRequestContext()?.requestId ?? "unknown", batchSizeForError(req));
  }) satisfies ErrorRequestHandler);
  return app;
}
