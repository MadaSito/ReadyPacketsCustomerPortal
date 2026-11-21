/**
 * Administrator operations of the public API: settings, keys, request log, replay. Every method re-checks the
 * live administrator (role + capability + fresh step-up where required) inside its transaction.
 */
import { and, desc, eq, gte, isNotNull, isNull, like, lt, lte, or, type SQL } from "drizzle-orm";
import { STEP_UP_CAPABILITIES, roleHasCapability, type Capability } from "../../../shared/capabilities.js";
import type { ModuleDeps } from "../../container.js";
import { DomainError, conflict, forbidden, notFound, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { SessionPrincipal, Tx } from "../../core/types.js";
import { hasFreshStepUp } from "../../trpc/trpc.js";
import { generateKeyToken, generateSigningSecret, hasControlChar, normaliseCidr } from "./credentials.js";
import { type ApiEngine } from "./engine.js";
import { API_SCOPES, type ApiScope } from "./ports.js";
import { apiKeys, apiRequestLog, apiSettings } from "./schema.js";

export interface KeyInput {
  name: string;
  scopes: ApiScope[];
  expiresAt: Date | null;
  ipAllowList: string[];
  rateLimitPerMinute: number;
  requireSigning: boolean;
}

export interface KeyView {
  keyId: string;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  expiresAt: Date | null;
  ipAllowList: string[];
  rateLimitPerMinute: number;
  requireSigning: boolean;
  state: "active" | "revoked" | "expired";
  version: number;
  lastUsedAt: Date | null;
  createdAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
}

export interface LogFilter {
  cursor?: string | null;
  limit?: number;
  keyId?: string;
  method?: string;
  status?: number;
  statusClass?: "2xx" | "3xx" | "4xx" | "5xx";
  pathPrefix?: string;
  correlationId?: string;
  from?: Date;
  to?: Date;
  replay?: boolean;
  search?: string;
}

const MAX_KEYS = 200;

export function createPublicApiService(deps: ModuleDeps, engine: ApiEngine) {
  const { db, clock, crypto, audit } = deps;

  async function assertAdmin(principal: SessionPrincipal, capability: Capability, tx: Tx): Promise<void> {
    const check = (p: Pick<SessionPrincipal, "role" | "state" | "pendingSteps" | "stepUpAt">) => {
      if (p.state !== "full" || p.pendingSteps.length) throw new DomainError("REMEDIATION_REQUIRED", "ACCOUNT_STEP_PENDING", "Please finish securing your account to continue.");
      if (p.role !== "admin" || !roleHasCapability(p.role, capability)) throw forbidden("CAPABILITY_NOT_GRANTED");
      if (STEP_UP_CAPABILITIES.has(capability) && !hasFreshStepUp({ ...principal, ...p }, clock.now())) {
        throw new DomainError("STEP_UP_REQUIRED", "STEP_UP_REQUIRED", "Please confirm your identity to continue.", { capability });
      }
    };
    check(principal);
    const sessions = deps.services.identity?.sessions;
    if (!sessions?.assertCurrent) throw forbidden("ACTOR_UNVERIFIABLE");
    const current = await sessions.assertCurrent(principal, tx);
    check({ role: current.role, state: principal.state, pendingSteps: current.pendingSteps, stepUpAt: current.stepUpAt });
  }

  async function guard<T>(principal: SessionPrincipal, capability: Capability, fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await db.transaction(async (tx) => {
        await assertAdmin(principal, capability, tx);
        return fn(tx);
      });
    } catch (error) {
      if (error instanceof DomainError && ["FORBIDDEN", "STEP_UP_REQUIRED", "REMEDIATION_REQUIRED"].includes(error.code)) {
        await audit.record({
          category: "security",
          eventName: "api.admin.denied",
          action: "access",
          outcome: "denied",
          reasonCode: error.reasonCode,
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "api_admin" },
        });
      }
      throw error;
    }
  }

  const adminActor = (p: SessionPrincipal) => ({ userId: p.userId, role: p.role });

  function toView(row: typeof apiKeys.$inferSelect): KeyView {
    const expired = row.state === "active" && row.expiresAt !== null && row.expiresAt <= clock.now();
    return {
      keyId: row.publicId,
      name: row.name,
      prefix: `rpk_${row.prefix}`,
      scopes: row.scopes.filter((s): s is ApiScope => (API_SCOPES as readonly string[]).includes(s)),
      expiresAt: row.expiresAt,
      ipAllowList: row.ipAllowList,
      rateLimitPerMinute: row.rateLimitPerMinute,
      requireSigning: row.requireSigning,
      state: expired ? "expired" : row.state,
      version: row.version,
      lastUsedAt: row.lastUsedAt,
      createdAt: row.createdAt,
      rotatedAt: row.rotatedAt,
      revokedAt: row.revokedAt,
    };
  }

  function checkKeyInput(input: KeyInput): KeyInput {
    const name = input.name.normalize("NFC").trim();
    if (!name || name.length > 120 || hasControlChar(name) || /[<>]/u.test(name)) throw validation("API_KEY_NAME_INVALID", "Enter a name of up to 120 characters.");
    const scopes = [...new Set(input.scopes)].filter((s) => (API_SCOPES as readonly string[]).includes(s));
    if (scopes.length === 0) throw validation("API_KEY_SCOPES_REQUIRED", "Choose at least one scope.");
    const ipAllowList: string[] = [];
    for (const entry of input.ipAllowList) {
      const normalised = normaliseCidr(entry);
      if (!normalised) throw validation("API_KEY_IP_INVALID", "Each allowed address must be an IP address or CIDR range.");
      ipAllowList.push(normalised);
    }
    if (ipAllowList.length > 50) throw validation("API_KEY_IP_TOO_MANY", "Up to 50 allowed addresses.");
    if (!Number.isInteger(input.rateLimitPerMinute) || input.rateLimitPerMinute < 1 || input.rateLimitPerMinute > 6000) {
      throw validation("API_KEY_RATE_INVALID", "The rate limit must be between 1 and 6000 requests per minute.");
    }
    if (input.expiresAt && input.expiresAt <= clock.now()) throw validation("API_KEY_EXPIRY_PAST", "The expiry must be in the future.");
    return { ...input, name, scopes, ipAllowList: [...new Set(ipAllowList)] };
  }

  async function loadKey(tx: Tx, keyId: string, expectedVersion?: number) {
    const [row] = await tx.select().from(apiKeys).where(eq(apiKeys.publicId, keyId)).for("update");
    if (!row) throw notFound("API_KEY_NOT_FOUND");
    if (expectedVersion !== undefined && row.version !== expectedVersion) throw conflict("STALE_VERSION", "This key was changed by someone else. Reload and try again.");
    return row;
  }

  async function keyAudit(principal: SessionPrincipal, eventName: string, action: string, keyId: string, tx: Tx, attributes?: Record<string, string | number | boolean>) {
    await audit.record(
      { category: "admin", eventName, action, outcome: "completed", actor: adminActor(principal), resource: { type: "api_key", publicId: keyId }, ...(attributes ? { attributes } : {}) },
      tx,
    );
  }

  function issueSecrets(publicId: string, requireSigning: boolean) {
    const { token, prefix } = generateKeyToken();
    const signingSecret = requireSigning ? generateSigningSecret() : null;
    return {
      token,
      prefix,
      signingSecret,
      columns: { prefix, secretHash: crypto.hashToken(token), signingSecretEnc: signingSecret ? crypto.encrypt(signingSecret, `api_keys.signing_secret:${publicId}`) : null },
    };
  }

  return {
    settings: {
      async get(principal: SessionPrincipal) {
        return guard(principal, "api.keys.manage", async (tx) => {
          const [row] = await tx.select().from(apiSettings).where(eq(apiSettings.id, 1));
          return { enabled: row?.enabled ?? false, retentionDays: row?.retentionDays ?? 30, version: row?.version ?? 0 };
        });
      },
      async update(principal: SessionPrincipal, input: { expectedVersion: number; enabled: boolean; retentionDays: number }) {
        if (!Number.isInteger(input.retentionDays) || input.retentionDays < 1 || input.retentionDays > 90) throw validation("API_RETENTION_INVALID", "Retention must be between 1 and 90 days.");
        await guard(principal, "api.keys.manage", async (tx) => {
          const [row] = await tx.select().from(apiSettings).where(eq(apiSettings.id, 1)).for("update");
          if ((row?.version ?? 0) !== input.expectedVersion) throw conflict("STALE_VERSION", "These settings were changed by someone else. Reload and try again.");
          const values = { enabled: input.enabled, retentionDays: input.retentionDays, updatedByUserId: principal.userId };
          if (!row) await tx.insert(apiSettings).values({ id: 1, version: 1, ...values });
          else await tx.update(apiSettings).set({ ...values, version: row.version + 1 }).where(eq(apiSettings.id, 1));
          const changed = (row?.enabled ?? false) !== input.enabled;
          await audit.record(
            {
              category: "admin",
              eventName: changed ? (input.enabled ? "api.settings.enabled" : "api.settings.disabled") : "api.settings.updated",
              action: "update",
              outcome: "completed",
              actor: adminActor(principal),
              resource: { type: "api_settings", id: 1 },
              safeCounts: { retention_days: input.retentionDays },
            },
            tx,
          );
        });
        return this.get(principal);
      },
    },

    keys: {
      async list(principal: SessionPrincipal, input: { cursor?: string | null; state?: "active" | "revoked" } = {}) {
        return guard(principal, "api.keys.manage", async (tx) => {
          const conditions: SQL[] = [];
          if (input.state) conditions.push(eq(apiKeys.state, input.state));
          if (input.cursor) {
            const cursorId = Number(input.cursor);
            if (!Number.isSafeInteger(cursorId) || cursorId < 1) throw validation("INVALID_CURSOR", "Invalid cursor.");
            conditions.push(lt(apiKeys.id, cursorId));
          }
          const rows = await tx.select().from(apiKeys).where(conditions.length ? and(...conditions) : undefined).orderBy(desc(apiKeys.id)).limit(51);
          const page = rows.slice(0, 50);
          return { items: page.map(toView), nextCursor: rows.length > 50 ? String(page[page.length - 1]!.id) : null };
        });
      },
      async get(principal: SessionPrincipal, keyId: string) {
        return guard(principal, "api.keys.manage", async (tx) => toView(await loadKey(tx, keyId)));
      },
      /** Returns the token (and signing secret) exactly once. */
      async create(principal: SessionPrincipal, raw: KeyInput) {
        const input = checkKeyInput(raw);
        return guard(principal, "api.keys.manage", async (tx) => {
          const active = await tx.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.state, "active")).limit(MAX_KEYS + 1);
          if (active.length >= MAX_KEYS) throw conflict("API_KEY_LIMIT", "Revoke unused keys before creating more.");
          const publicId = ulid(clock.now().getTime());
          const secrets = issueSecrets(publicId, input.requireSigning);
          await tx.insert(apiKeys).values({
            publicId,
            name: input.name,
            scopes: input.scopes,
            ipAllowList: input.ipAllowList,
            expiresAt: input.expiresAt,
            rateLimitPerMinute: input.rateLimitPerMinute,
            requireSigning: input.requireSigning,
            createdByUserId: principal.userId,
            ...secrets.columns,
          });
          await keyAudit(principal, "api.key.created", "create", publicId, tx, { scopes: input.scopes.length, signing: input.requireSigning });
          return { key: toView(await loadKey(tx, publicId)), token: secrets.token, signingSecret: secrets.signingSecret };
        });
      },
      async update(principal: SessionPrincipal, keyId: string, expectedVersion: number, raw: KeyInput) {
        const input = checkKeyInput(raw);
        return guard(principal, "api.keys.manage", async (tx) => {
          const row = await loadKey(tx, keyId, expectedVersion);
          if (row.state !== "active") throw conflict("API_KEY_REVOKED", "A revoked key cannot be changed.");
          // Turning signing on issues a signing secret (returned once); turning it off removes it.
          const signingSecret = input.requireSigning && !row.signingSecretEnc ? generateSigningSecret() : null;
          await tx
            .update(apiKeys)
            .set({
              name: input.name,
              scopes: input.scopes,
              ipAllowList: input.ipAllowList,
              expiresAt: input.expiresAt,
              rateLimitPerMinute: input.rateLimitPerMinute,
              requireSigning: input.requireSigning,
              ...(signingSecret ? { signingSecretEnc: crypto.encrypt(signingSecret, `api_keys.signing_secret:${row.publicId}`) } : {}),
              ...(!input.requireSigning ? { signingSecretEnc: null } : {}),
              version: row.version + 1,
            })
            .where(eq(apiKeys.id, row.id));
          await keyAudit(principal, "api.key.updated", "update", keyId, tx, { scopes: input.scopes.length, signing: input.requireSigning });
          return { key: toView(await loadKey(tx, keyId)), signingSecret };
        });
      },
      /** New token (and signing secret when signing is on); the old token stops working immediately. */
      async rotate(principal: SessionPrincipal, keyId: string, expectedVersion: number) {
        return guard(principal, "api.keys.manage", async (tx) => {
          const row = await loadKey(tx, keyId, expectedVersion);
          if (row.state !== "active") throw conflict("API_KEY_REVOKED", "A revoked key cannot be rotated.");
          const secrets = issueSecrets(row.publicId, row.requireSigning);
          await tx.update(apiKeys).set({ ...secrets.columns, rotatedAt: clock.now(), version: row.version + 1 }).where(eq(apiKeys.id, row.id));
          await keyAudit(principal, "api.key.rotated", "rotate", keyId, tx);
          return { key: toView(await loadKey(tx, keyId)), token: secrets.token, signingSecret: secrets.signingSecret };
        });
      },
      async revoke(principal: SessionPrincipal, keyId: string, expectedVersion: number) {
        return guard(principal, "api.keys.manage", async (tx) => {
          const row = await loadKey(tx, keyId, expectedVersion);
          if (row.state === "revoked") return toView(row);
          await tx.update(apiKeys).set({ state: "revoked", revokedAt: clock.now(), signingSecretEnc: null, version: row.version + 1 }).where(eq(apiKeys.id, row.id));
          await keyAudit(principal, "api.key.revoked", "revoke", keyId, tx);
          return toView(await loadKey(tx, keyId));
        });
      },
    },

    log: {
      async list(principal: SessionPrincipal, filter: LogFilter = {}) {
        return guard(principal, "api.logs.read", async (tx) => {
          const limit = Math.min(Math.max(filter.limit ?? 50, 1), 100);
          const c: SQL[] = [];
          if (filter.cursor) {
            const cursorId = Number(filter.cursor);
            if (!Number.isSafeInteger(cursorId) || cursorId < 1) throw validation("INVALID_CURSOR", "Invalid cursor.");
            c.push(lt(apiRequestLog.id, cursorId));
          }
          if (filter.keyId) c.push(eq(apiRequestLog.keyPublicId, filter.keyId));
          if (filter.method) c.push(eq(apiRequestLog.method, filter.method));
          if (filter.status) c.push(eq(apiRequestLog.status, filter.status));
          if (filter.statusClass) {
            const base = Number(filter.statusClass[0]) * 100;
            c.push(gte(apiRequestLog.status, base), lt(apiRequestLog.status, base + 100));
          }
          if (filter.pathPrefix) c.push(like(apiRequestLog.path, `${escapeLike(filter.pathPrefix)}%`));
          if (filter.correlationId) c.push(or(eq(apiRequestLog.correlationId, filter.correlationId), eq(apiRequestLog.correlationId, engine.correlationDigest(filter.correlationId)))!);
          if (filter.from) c.push(gte(apiRequestLog.createdAt, filter.from));
          if (filter.to) c.push(lte(apiRequestLog.createdAt, filter.to));
          if (filter.replay !== undefined) c.push(filter.replay ? isNotNull(apiRequestLog.replayOf) : isNull(apiRequestLog.replayOf));
          if (filter.search) {
            const term = `%${escapeLike(filter.search)}%`;
            c.push(or(like(apiRequestLog.path, term), like(apiRequestLog.route, term), like(apiRequestLog.errorCode, term), eq(apiRequestLog.publicId, filter.search))!);
          }
          const rows = await tx
            .select({
              id: apiRequestLog.id,
              requestId: apiRequestLog.publicId,
              keyId: apiRequestLog.keyPublicId,
              method: apiRequestLog.method,
              route: apiRequestLog.route,
              path: apiRequestLog.path,
              status: apiRequestLog.status,
              durationMs: apiRequestLog.durationMs,
              correlationId: apiRequestLog.correlationId,
              errorCode: apiRequestLog.errorCode,
              replayOf: apiRequestLog.replayOf,
              createdAt: apiRequestLog.createdAt,
            })
            .from(apiRequestLog)
            .where(c.length ? and(...c) : undefined)
            .orderBy(desc(apiRequestLog.id))
            .limit(limit + 1);
          const page = rows.slice(0, limit);
          const nextCursor = rows.length > limit ? String(rows[limit - 1]!.id) : null;
          return { items: page.map(({ id: _id, ...rest }) => rest), nextCursor };
        });
      },
      /** Redacted request/response views (the exact replay payload is never returned). */
      async get(principal: SessionPrincipal, requestId: string) {
        return guard(principal, "api.logs.read", async (tx) => {
          const [row] = await tx.select().from(apiRequestLog).where(eq(apiRequestLog.publicId, requestId));
          if (!row) throw notFound("API_LOG_NOT_FOUND");
          const open = (value: string | null, aad: string) => (value ? (JSON.parse(crypto.decrypt(value, aad)) as unknown) : null);
          const replays = await tx.select({ requestId: apiRequestLog.publicId, status: apiRequestLog.status, createdAt: apiRequestLog.createdAt }).from(apiRequestLog).where(eq(apiRequestLog.replayOf, requestId)).orderBy(desc(apiRequestLog.id)).limit(20);
          return {
            requestId: row.publicId,
            keyId: row.keyPublicId,
            method: row.method,
            route: row.route,
            path: row.path,
            status: row.status,
            durationMs: row.durationMs,
            correlationId: row.correlationId,
            errorCode: row.errorCode,
            requestBytes: row.requestBytes,
            responseBytes: row.responseBytes,
            ipAddress: row.ipEnc ? crypto.decrypt(row.ipEnc, `api_request_log.ip:${row.publicId}`) : null,
            idempotencyKey: row.idempotencyKey,
            replayOf: row.replayOf,
            replayable: row.replayEnc !== null && row.keyId !== null,
            bodyTruncated: row.bodyTruncated,
            request: open(row.requestViewEnc, `api_request_log.request:${row.publicId}`),
            response: open(row.responseViewEnc, `api_request_log.response:${row.publicId}`),
            replays,
            createdAt: row.createdAt,
          };
        });
      },
      /** Re-runs a stored call under the original key's CURRENT scopes. Writes need `confirmWrite`. */
      async replay(principal: SessionPrincipal, requestId: string, options: { confirmWrite?: boolean } = {}) {
        const stored = await guard(principal, "api.replay", async (tx) => {
          const [row] = await tx.select().from(apiRequestLog).where(eq(apiRequestLog.publicId, requestId));
          if (!row) throw notFound("API_LOG_NOT_FOUND");
          if (!row.replayEnc || row.keyId === null) throw conflict("API_REPLAY_UNAVAILABLE", "This call cannot be replayed: its stored body was truncated, purged or it had no valid key.");
          const payload = JSON.parse(crypto.decrypt(row.replayEnc, `api_request_log.replay:${row.publicId}`)) as { method: string; target: string; contentType: string | null; body: string };
          const write = payload.method !== "GET" && payload.method !== "HEAD";
          if (write && !options.confirmWrite) throw validation("API_REPLAY_CONFIRM_WRITE", "Replaying a write call changes data. Confirm to continue.");
          await audit.record(
            {
              category: "admin",
              eventName: "api.request.replayed",
              action: "replay",
              outcome: "attempted",
              actor: adminActor(principal),
              resource: { type: "api_request", publicId: row.publicId },
              attributes: { route: row.route, method: payload.method },
            },
            tx,
          );
          return { keyId: row.keyId, payload };
        });
        const response = await engine.handle(
          {
            method: stored.payload.method,
            target: stored.payload.target,
            headers: stored.payload.contentType ? { "content-type": stored.payload.contentType } : {},
            body: Buffer.from(stored.payload.body, "base64"),
          },
          { keyId: stored.keyId, ofRequestId: requestId, byUserId: principal.userId },
        );
        return { requestId: response.headers["x-request-id"] ?? null, status: response.status };
      },
    },
  };
}

export type PublicApiService = ReturnType<typeof createPublicApiService>;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (c) => `\\${c}`);
}
