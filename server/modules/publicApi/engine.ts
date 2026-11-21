/**
 * The /api/v1 request pipeline, transport-independent (http.ts adapts Express; replay calls it directly).
 *
 * Order: route → enabled → key (constant-time, identical refusals) → IP allow-list → signature + replay cache
 * → per-key rate limit → scope → input validation → idempotency → provider → DTO re-validation → log.
 */
import { timingSafeEqual } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { ModuleDeps } from "../../container.js";
import { DomainError } from "../../core/errors.js";
import { ULID_PATTERN, ulid } from "../../core/ids.js";
import type { DbOrTx } from "../../core/types.js";
import { redact } from "../../observability/redact.js";
import { hasControlChar, ipAllowed, parseBearer, sha256Hex, verifySignature } from "./credentials.js";
import { type ApiCaller, type ApiScope, type PublicApiProviders } from "./ports.js";
import { type ApiRoute, ResourceUnavailable, buildOpenApiDocument, matchRoute } from "./routes.js";
import { apiIdempotency, apiKeys, apiRateWindows, apiRequestLog, apiSettings, apiSignatureNonces } from "./schema.js";

export const API_PREFIX = "/api/v1";
export const LOG_BODY_LIMIT = 64 * 1024;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const LAST_USED_GRANULARITY_MS = 60_000;
const DUMMY_HASH_TOKEN = "rpk_222222222222_2222222222222222222222222222222222222222";

export interface ApiHttpRequest {
  method: string;
  /** Path + optional query, relative to /api/v1 (e.g. `/orders?limit=5`). */
  target: string;
  /** Lower-case header names. */
  headers: Record<string, string | undefined>;
  body: Buffer;
  ipAddress?: string;
  /** Server-generated HTTP request id (requestContext) so API log, audit and HTTP events join; minted if absent. */
  requestId?: string;
}

export interface ApiHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface ReplayContext {
  keyId: number;
  ofRequestId: string;
  byUserId: number;
}

type KeyRow = typeof apiKeys.$inferSelect;

class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly extraHeaders: Record<string, string> = {},
  ) {
    super(code);
  }
}

const TITLES: Record<number, string> = {
  400: "Bad request",
  401: "Authentication required",
  403: "Forbidden",
  404: "Not found",
  405: "Method not allowed",
  409: "Conflict",
  413: "Payload too large",
  415: "Unsupported media type",
  422: "Validation failed",
  423: "Locked",
  429: "Too many requests",
  500: "Internal error",
  503: "Service unavailable",
};

const fail = (status: number, code: string, headers?: Record<string, string>) => new ApiFailure(status, code, TITLES[status] ?? "Error", headers);

function fromDomain(error: DomainError): ApiFailure {
  const status: Record<string, number> = {
    NOT_FOUND: 404,
    VALIDATION: 422,
    CONFLICT: 409,
    LOCKED: 423,
    FORBIDDEN: 403,
    UNAVAILABLE: 503,
    MAINTENANCE: 503,
    NOT_CONFIGURED: 503,
    RATE_LIMITED: 429,
  };
  const code = /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.reasonCode) ? error.reasonCode : error.code;
  return fail(status[error.code] ?? 500, status[error.code] ? code : "INTERNAL_ERROR");
}

const CORRELATION_RE = /^[A-Za-z0-9._:-]{1,64}$/u;
const IDEMPOTENCY_RE = /^[A-Za-z0-9._:-]{1,128}$/u;

function serialiseDates(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serialiseDates);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serialiseDates(v)]));
  return value;
}

function boundedJson(value: unknown): { text: string; truncated: boolean } {
  const text = JSON.stringify(value);
  return text.length > LOG_BODY_LIMIT ? { text: JSON.stringify({ truncated: true, bytes: text.length }), truncated: true } : { text, truncated: false };
}

export function createApiEngine(deps: ModuleDeps, providers: () => Partial<PublicApiProviders>) {
  const { db, clock, crypto, audit } = deps;
  const serverUrl = `${deps.config.canonicalOrigin.replace(/\/$/u, "")}${API_PREFIX}`;
  let openApiText: string | null = null;

  async function settings(handle: DbOrTx = db) {
    const [row] = await handle.select().from(apiSettings).where(eq(apiSettings.id, 1));
    return { enabled: row?.enabled ?? false, retentionDays: row?.retentionDays ?? 30 };
  }

  async function authenticate(req: ApiHttpRequest): Promise<KeyRow> {
    const bearer = parseBearer(req.headers.authorization);
    const [row] = bearer ? await db.select().from(apiKeys).where(eq(apiKeys.prefix, bearer.prefix)) : [];
    // Always one hash comparison, so unknown prefix and wrong secret take the same path.
    const presented = Buffer.from(crypto.hashToken(bearer?.token ?? DUMMY_HASH_TOKEN), "utf8");
    const stored = Buffer.from(row?.secretHash ?? crypto.hashToken(`${DUMMY_HASH_TOKEN}x`), "utf8");
    const valid = presented.length === stored.length && timingSafeEqual(presented, stored);
    const now = clock.now();
    if (!bearer || !row || !valid || row.state !== "active" || (row.expiresAt && row.expiresAt <= now)) {
      const limited = await deps.rateLimiter.consume("auth_high_risk", `api:${req.ipAddress ?? "unknown"}`);
      audit.note({ category: "security", eventName: "api.auth.denied", action: "authenticate", outcome: "denied", reasonCode: "API_KEY_INVALID", actor: { role: "anonymous" } });
      if (!limited.allowed) throw fail(429, "RATE_LIMITED", { "retry-after": String(limited.retryAfterSeconds) });
      throw fail(401, "API_KEY_INVALID", { "www-authenticate": 'Bearer realm="readypackets-api"' });
    }
    return row;
  }

  async function checkSignature(key: KeyRow, req: ApiHttpRequest): Promise<void> {
    const present = req.headers["x-rp-signature"] !== undefined || req.headers["x-rp-timestamp"] !== undefined;
    if (!key.requireSigning && !present) return;
    if (!key.signingSecretEnc) throw fail(401, "SIGNATURE_INVALID");
    const secret = crypto.decrypt(key.signingSecretEnc, `api_keys.signing_secret:${key.publicId}`);
    const now = clock.now();
    const check = verifySignature({
      secret,
      timestampHeader: req.headers["x-rp-timestamp"],
      signatureHeader: req.headers["x-rp-signature"],
      method: req.method,
      target: `${API_PREFIX}${req.target}`,
      body: req.body,
      nowSeconds: Math.floor(now.getTime() / 1000),
    });
    if (!check.ok) throw fail(401, check.reason);
    try {
      await db.insert(apiSignatureNonces).values({ keyId: key.id, signatureHash: check.signatureHash, expiresAt: new Date(now.getTime() + 2 * 300_000) });
    } catch (error) {
      if (isDuplicate(error)) throw fail(401, "SIGNATURE_REPLAYED");
      throw error;
    }
  }

  async function consumeRate(key: KeyRow): Promise<Record<string, string>> {
    const now = clock.now();
    const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    await db
      .insert(apiRateWindows)
      .values({ keyId: key.id, windowStart, count: 1 })
      .onDuplicateKeyUpdate({ set: { count: sql`${apiRateWindows.count} + 1` } });
    const [row] = await db.select({ count: apiRateWindows.count }).from(apiRateWindows).where(and(eq(apiRateWindows.keyId, key.id), eq(apiRateWindows.windowStart, windowStart)));
    const count = row?.count ?? 1;
    const reset = Math.max(1, Math.ceil((windowStart.getTime() + 60_000 - now.getTime()) / 1000));
    const headers = { "ratelimit-limit": String(key.rateLimitPerMinute), "ratelimit-remaining": String(Math.max(0, key.rateLimitPerMinute - count)), "ratelimit-reset": String(reset) };
    if (count > key.rateLimitPerMinute) throw fail(429, "RATE_LIMITED", { ...headers, "retry-after": String(reset) });
    return headers;
  }

  function parseQuery(route: ApiRoute, search: URLSearchParams) {
    const allowed = new Set(route.kind === "list" ? ["cursor", "limit", "updated_since", ...route.filters] : []);
    const seen = new Set<string>();
    for (const [name] of search) {
      if (!allowed.has(name) || seen.has(name)) throw fail(422, "INVALID_QUERY");
      seen.add(name);
    }
    const cursor = search.get("cursor");
    if (cursor !== null && !/^[A-Za-z0-9._~:=-]{1,200}$/u.test(cursor)) throw fail(422, "INVALID_CURSOR");
    const limitRaw = search.get("limit");
    const limit = limitRaw === null ? 25 : /^\d{1,3}$/u.test(limitRaw) ? Number(limitRaw) : Number.NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw fail(422, "INVALID_LIMIT");
    const since = search.get("updated_since");
    const updatedSince = since === null ? undefined : z.iso.datetime({ offset: true }).safeParse(since).success ? new Date(since) : null;
    if (updatedSince === null) throw fail(422, "INVALID_UPDATED_SINCE");
    const filter: Record<string, string> = {};
    for (const name of route.filters) {
      const value = search.get(name);
      if (value === null) continue;
      if (value.length < 1 || value.length > 100 || hasControlChar(value)) throw fail(422, "INVALID_FILTER");
      filter[name] = value.normalize("NFC");
    }
    return { cursor, limit, ...(updatedSince ? { updatedSince } : {}), filter };
  }

  function parseBody(route: ApiRoute, req: ApiHttpRequest): unknown {
    if (!route.body) {
      if (req.body.length > 0) throw fail(422, "BODY_NOT_ALLOWED");
      return undefined;
    }
    const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/json") throw fail(415, "UNSUPPORTED_MEDIA_TYPE");
    let json: unknown;
    try {
      json = JSON.parse(req.body.toString("utf8"));
    } catch {
      throw fail(400, "INVALID_JSON");
    }
    const parsed = route.body.safeParse(json);
    if (!parsed.success) throw fail(422, "VALIDATION_FAILED");
    return parsed.data;
  }

  /** Returns a stored response, or a `finish` callback to complete the reservation. */
  async function reserveIdempotency(key: KeyRow, idempotencyKey: string, requestHash: string) {
    const now = clock.now();
    const aad = `api_idempotency.response:${key.id}:${idempotencyKey}`;
    try {
      await db.insert(apiIdempotency).values({ keyId: key.id, idempotencyKey, requestHash, state: "in_progress", expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS) });
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      const [row] = await db.select().from(apiIdempotency).where(and(eq(apiIdempotency.keyId, key.id), eq(apiIdempotency.idempotencyKey, idempotencyKey)));
      if (!row) throw fail(409, "IDEMPOTENCY_IN_PROGRESS");
      if (row.requestHash !== requestHash) throw fail(422, "IDEMPOTENCY_KEY_REUSED");
      // in_progress + status set = an earlier attempt ended with an unknown outcome; never re-run it.
      if (row.state !== "completed" && row.status !== null) throw fail(409, "IDEMPOTENCY_OUTCOME_UNKNOWN");
      if (row.state !== "completed" || row.status === null || !row.responseEnc) throw fail(409, "IDEMPOTENCY_IN_PROGRESS");
      return { stored: { status: row.status, body: crypto.decrypt(row.responseEnc, aad) } } as const;
    }
    return {
      /** `effectFree`: the provider provably did not run (missing provider). Only then may the key be reused. */
      async finish(status: number, body: string, effectFree: boolean) {
        const where = and(eq(apiIdempotency.keyId, key.id), eq(apiIdempotency.idempotencyKey, idempotencyKey));
        if (status >= 500 && effectFree) {
          await db.delete(apiIdempotency).where(where);
          return;
        }
        if (status >= 500) {
          // Outcome unknown (provider may have committed): keep the reservation until TTL so it is not re-run.
          await db.update(apiIdempotency).set({ status }).where(where);
          return;
        }
        await db
          .update(apiIdempotency)
          .set({ state: "completed", status, responseEnc: crypto.encrypt(body, aad) })
          .where(where);
      },
    } as const;
  }

  async function touchKey(key: KeyRow): Promise<void> {
    const now = clock.now();
    if (key.lastUsedAt && now.getTime() - key.lastUsedAt.getTime() < LAST_USED_GRANULARITY_MS) return;
    await db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, key.id));
  }

  function problem(failure: ApiFailure, requestId: string): string {
    return JSON.stringify({ type: `urn:readypackets:problem:${failure.code.toLowerCase()}`, title: failure.title, status: failure.status, code: failure.code, request_id: requestId });
  }

  function requestView(req: ApiHttpRequest, search: URLSearchParams): { text: string; truncated: boolean } {
    const headers: Record<string, string> = {};
    for (const name of ["content-type", "content-length", "user-agent", "idempotency-key", "x-correlation-id", "x-rp-timestamp", "authorization", "x-rp-signature"]) {
      const value = req.headers[name];
      if (value !== undefined) headers[name] = value;
    }
    let body: unknown = null;
    if (req.body.length > 0) {
      try {
        body = JSON.parse(req.body.toString("utf8"));
      } catch {
        body = `[non-JSON body, ${req.body.length} bytes]`;
      }
    }
    return boundedJson(redact({ headers, query: Object.fromEntries(search), body }, { maxString: 4096 }));
  }

  async function handle(req: ApiHttpRequest, replay?: ReplayContext): Promise<ApiHttpResponse> {
    const started = clock.now();
    const requestId = !replay && req.requestId && ULID_PATTERN.test(req.requestId) ? req.requestId : ulid(started.getTime());
    const method = req.method.toUpperCase();
    const headerCorrelation = req.headers["x-correlation-id"];
    const correlationId = headerCorrelation && CORRELATION_RE.test(headerCorrelation) ? headerCorrelation : requestId;
    const baseHeaders: Record<string, string> = {
      "x-request-id": requestId,
      "x-correlation-id": correlationId,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...(replay ? { "x-readypackets-replay": "1" } : {}),
    };
    const [rawPath, rawQuery = ""] = req.target.split("?", 2) as [string, string | undefined];
    const path = rawPath.length > 512 ? rawPath.slice(0, 512) : rawPath;

    if (method === "GET" && path === "/openapi.json" && !replay) {
      openApiText ??= JSON.stringify(buildOpenApiDocument(serverUrl));
      return { status: 200, headers: { ...baseHeaders, "content-type": "application/json", "cache-control": "public, max-age=300" }, body: openApiText };
    }

    if (!(await settings()).enabled) {
      return { status: 404, headers: { ...baseHeaders, "content-type": "application/problem+json" }, body: problem(fail(404, "NOT_FOUND"), requestId) };
    }

    let key: KeyRow | null = null;
    let routeTemplate = "unmatched";
    let status = 200;
    let responseBody = "";
    let errorCode: string | null = null;
    let extraHeaders: Record<string, string> = {};
    let idempotencyKey: string | undefined;
    let logRow = true;
    /** Passed auth, IP, signature, rate, route, scope and validation: only such calls are replayable. */
    let admitted = false;
    let effectFree = true;
    let route: ApiRoute | null;
    const search = new URLSearchParams(rawQuery);
    try {
      if (replay) {
        const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, replay.keyId));
        if (!row || row.state !== "active" || (row.expiresAt && row.expiresAt <= clock.now())) throw fail(401, "API_KEY_INVALID");
        key = row;
      } else {
        try {
          key = await authenticate(req);
        } catch (error) {
          if (error instanceof ApiFailure && error.status === 429) logRow = false; // flood: counted, not stored
          throw error;
        }
        if (!ipAllowed(req.ipAddress, key.ipAllowList)) throw fail(403, "IP_NOT_ALLOWED");
        await checkSignature(key, req);
        extraHeaders = await consumeRate(key);
      }
      const matched = matchRoute(method, path);
      if (!matched) throw fail(404, "NOT_FOUND");
      if ("methodMismatch" in matched) throw fail(405, "METHOD_NOT_ALLOWED");
      route = matched.route;
      routeTemplate = route.template;
      if (!key.scopes.includes(route.scope)) throw fail(403, "INSUFFICIENT_SCOPE");
      const query = parseQuery(route, search);
      const body = parseBody(route, req);
      admitted = true;
      const caller: ApiCaller = { kind: "api_key", keyPublicId: key.publicId, scopes: key.scopes as ApiScope[], requestId, replay: Boolean(replay) };

      let reservation: Awaited<ReturnType<typeof reserveIdempotency>> | null = null;
      if (route.body) {
        const header = replay ? `replay:${replay.ofRequestId}` : req.headers["idempotency-key"];
        if (!header || !(replay || IDEMPOTENCY_RE.test(header))) throw fail(422, "IDEMPOTENCY_KEY_REQUIRED");
        idempotencyKey = header;
        caller.idempotencyKey = header;
        reservation = await reserveIdempotency(key, header, sha256Hex(`${method}\n${req.target}\n${req.body.toString("base64")}`));
        if ("stored" in reservation && reservation.stored) {
          status = reservation.stored.status;
          responseBody = reservation.stored.body;
          extraHeaders["idempotent-replayed"] = "true";
          reservation = null;
          route = null; // nothing executed
        }
        if (route) {
          // Durable attempt record first: if audit is unavailable, nothing is executed (fail closed).
          await audit.record({
            category: "integration",
            eventName: "api.request.write",
            action: method === "POST" ? "create" : "update",
            outcome: "attempted",
            actor: { role: "system" },
            resource: { type: "api_key", publicId: key.publicId },
            correlationId: requestId,
            attributes: { route: routeTemplate, method, replay: Boolean(replay) },
          });
        }
      }
      if (route) {
        try {
          effectFree = false;
          const result = await route.invoke(providers(), { params: matched.params, query, body, caller });
          if (result === null || result === undefined) throw fail(404, "NOT_FOUND");
          const plain = serialiseDates(result);
          const dto = route.kind === "list" ? route.response.safeParse({ data: (plain as { items?: unknown }).items, next_cursor: (plain as { nextCursor?: unknown }).nextCursor ?? null }) : route.response.safeParse(plain);
          if (!dto.success) throw fail(500, "PROVIDER_CONTRACT_VIOLATION");
          status = route.kind === "create" ? 201 : 200;
          responseBody = JSON.stringify(route.kind === "list" ? dto.data : { data: dto.data });
        } catch (error) {
          const failure = toFailure(error);
          if (error instanceof ResourceUnavailable) effectFree = true;
          status = failure.status;
          errorCode = failure.code;
          responseBody = problem(failure, requestId);
        }
        if (route.body) {
          await audit
            .record({
              category: "integration",
              eventName: "api.request.write",
              action: method === "POST" ? "create" : "update",
              outcome: status < 300 ? "completed" : status >= 500 ? "unknown" : "refused",
              ...(errorCode ? { reasonCode: errorCode } : {}),
              actor: { role: "system" },
              resource: { type: "api_key", publicId: key.publicId },
              correlationId: requestId,
              attributes: { route: routeTemplate, method, status, replay: Boolean(replay) },
            })
            .catch(() => deps.logger.warn("api.request.write result audit failed", { requestId }));
        }
        await reservation?.finish(status, responseBody, effectFree);
      }
      await touchKey(key);
    } catch (error) {
      const failure = toFailure(error);
      status = failure.status;
      errorCode = failure.code;
      responseBody = problem(failure, requestId);
      extraHeaders = { ...extraHeaders, ...failure.extraHeaders };
    }

    const isProblem = status >= 400;
    const response: ApiHttpResponse = {
      status,
      headers: { ...baseHeaders, ...extraHeaders, "content-type": isProblem ? "application/problem+json" : "application/json" },
      body: method === "HEAD" ? "" : responseBody,
    };
    if (logRow) {
      await writeLog({ req, requestId, key, admitted, method, path, routeTemplate, status, errorCode, correlationId, responseBody, search, idempotencyKey, replay, started }).catch(() =>
        deps.logger.warn("api request log write failed", { requestId }),
      );
    }
    return response;
  }

  function toFailure(error: unknown): ApiFailure {
    if (error instanceof ApiFailure) return error;
    if (error instanceof ResourceUnavailable) return fail(503, "RESOURCE_UNAVAILABLE");
    if (error instanceof DomainError) return fromDomain(error);
    deps.logger.error("api request failed", { error_name: error instanceof Error ? error.name : "unknown" });
    return fail(500, "INTERNAL_ERROR");
  }

  async function writeLog(input: {
    req: ApiHttpRequest;
    requestId: string;
    key: KeyRow | null;
    admitted: boolean;
    method: string;
    path: string;
    routeTemplate: string;
    status: number;
    errorCode: string | null;
    correlationId: string;
    responseBody: string;
    search: URLSearchParams;
    idempotencyKey: string | undefined;
    replay: ReplayContext | undefined;
    started: Date;
  }): Promise<void> {
    const { requestId } = input;
    const view = requestView(input.req, input.search);
    let responseJson: unknown;
    try {
      responseJson = input.responseBody ? JSON.parse(input.responseBody) : null;
    } catch {
      responseJson = null;
    }
    const responseView = boundedJson(redact(responseJson, { maxString: 4096 }));
    const replayable = input.req.body.length <= LOG_BODY_LIMIT && input.req.target.length <= 4096;
    // Clear columns hold only server-derived or validated values: the concrete path only when it matched a
    // route template (segments are pattern-checked ids); client correlation only after authentication and
    // when it does not look like a credential; the idempotency key only as a hash. Raw input stays encrypted.
    const matchedPath = input.routeTemplate !== "unmatched" ? input.path : "unmatched";
    const clientCorrelation = input.key && input.correlationId !== requestId && !looksLikeSecret(input.correlationId) ? input.correlationId : requestId;
    await db.insert(apiRequestLog).values({
      publicId: requestId,
      keyId: input.key?.id ?? null,
      keyPublicId: input.key?.publicId ?? null,
      method: input.method.slice(0, 8),
      route: input.routeTemplate,
      path: matchedPath,
      status: input.status,
      durationMs: Math.max(0, clock.now().getTime() - input.started.getTime()),
      correlationId: clientCorrelation,
      errorCode: input.errorCode,
      requestBytes: input.req.body.length,
      responseBytes: Buffer.byteLength(input.responseBody),
      requestViewEnc: crypto.encrypt(view.text, `api_request_log.request:${requestId}`),
      responseViewEnc: crypto.encrypt(responseView.text, `api_request_log.response:${requestId}`),
      replayEnc:
        input.key && input.admitted && replayable
          ? crypto.encrypt(
              JSON.stringify({ method: input.method, target: input.req.target, contentType: input.req.headers["content-type"] ?? null, body: input.req.body.toString("base64") }),
              `api_request_log.replay:${requestId}`,
            )
          : null,
      bodyTruncated: input.req.body.length > LOG_BODY_LIMIT || view.truncated,
      ipEnc: input.req.ipAddress ? crypto.encrypt(input.req.ipAddress, `api_request_log.ip:${requestId}`) : null,
      idempotencyKey: input.idempotencyKey ? `sha256:${sha256Hex(input.idempotencyKey).slice(0, 56)}` : null,
      replayOf: input.replay?.ofRequestId ?? null,
      replayedByUserId: input.replay?.byUserId ?? null,
    });
  }

  /** Bounded purge of expired rows; returns the number of deleted rows. */
  async function purge(batch = 500): Promise<number> {
    const now = clock.now();
    const { retentionDays } = await settings();
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
    let deleted = 0;
    const run = async (q: Promise<unknown>) => {
      const result = (await q) as [{ affectedRows?: number }] | { affectedRows?: number };
      deleted += (Array.isArray(result) ? result[0]?.affectedRows : result.affectedRows) ?? 0;
    };
    await run(db.delete(apiRequestLog).where(lt(apiRequestLog.createdAt, cutoff)).limit(batch));
    await run(db.delete(apiIdempotency).where(lt(apiIdempotency.expiresAt, now)).limit(batch));
    await run(db.delete(apiSignatureNonces).where(lt(apiSignatureNonces.expiresAt, now)).limit(batch));
    await run(db.delete(apiRateWindows).where(lt(apiRateWindows.windowStart, new Date(now.getTime() - 10 * 60_000))).limit(batch));
    return deleted;
  }

  return { handle, purge, settings };
}

export type ApiEngine = ReturnType<typeof createApiEngine>;

/** Token-shaped values (our key prefix, or one long unbroken high-entropy run) are never stored in clear. */
export function looksLikeSecret(value: string): boolean {
  return /rpk_/iu.test(value) || /[A-Za-z0-9+/=_-]{32,}/u.test(value);
}

export function isDuplicate(error: unknown): boolean {
  for (let e: unknown = error, i = 0; e && i < 4; e = (e as { cause?: unknown }).cause, i += 1) {
    const code = (e as { code?: unknown; errno?: unknown }).code;
    if (code === "ER_DUP_ENTRY" || (e as { errno?: unknown }).errno === 1062) return true;
  }
  return false;
}
