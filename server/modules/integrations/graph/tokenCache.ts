/**
 * Single-tenant Entra OAuth 2.0 `client_credentials` token cache for Microsoft Graph.
 *
 * Security invariants:
 *  - Strictly enforces single-tenant GUID `tenantId` (`common`, `organizations`, `consumers` refused).
 *  - Fetches exclusively through `egress.fetchPinned(..., "graph")` (pinned DNS, TLS >= 1.2, no redirects).
 *  - Coalesces concurrent requests single-flight per credential fingerprint (`tenantId + clientId + version + secretHash`).
 *  - Refreshes proactively at `expires_in - 60s` using `Clock`.
 *  - NEVER logs or surfaces bearer tokens, client secrets, or raw provider error descriptions.
 */
import { createHash } from "node:crypto";
import { DomainError } from "../../../core/errors.js";
import type { Clock } from "../../../core/types.js";
import type { EgressPolicy } from "../egress.js";
import {
  FORBIDDEN_MULTI_TENANT_ALIASES,
  hasNoHeaderInjection,
  isValidEntraClientGuid,
  isValidSingleTenantGuid,
} from "../settings.js";
import { GraphApiError, type GraphCredentialsInput } from "./types.js";

const GRAPH_DEFAULT_SCOPE = "https://graph.microsoft.com/.default";
const EXPIRY_SAFETY_WINDOW_SEC = 60;
const TOKEN_TIMEOUT_MS = 10_000;
const TOKEN_MAX_RESPONSE_BYTES = 64 * 1024;
const SAFE_OAUTH_ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

interface CachedTokenEntry {
  accessToken: string;
  expiresAtMs: number;
}

export interface GraphTokenCache {
  getAccessToken(credentials: GraphCredentialsInput, signal?: AbortSignal): Promise<string>;
  invalidate(credentials: Pick<GraphCredentialsInput, "tenantId" | "clientId">): void;
  clear(): void;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function buildCredentialKey(creds: GraphCredentialsInput): string {
  const secretDigest = sha256Hex(creds.clientSecret);
  const version = creds.credentialVersion !== undefined ? String(creds.credentialVersion) : "0";
  return `${creds.tenantId.trim().toLowerCase()}:${creds.clientId.trim().toLowerCase()}:${version}:${secretDigest}`;
}

export function assertValidSingleTenantGraphCredentials(creds: GraphCredentialsInput): {
  tenantId: string;
  clientId: string;
  clientSecret: string;
} {
  const tenantId = creds.tenantId.trim().toLowerCase();
  const clientId = creds.clientId.trim().toLowerCase();
  const clientSecret = creds.clientSecret;

  if (FORBIDDEN_MULTI_TENANT_ALIASES.has(tenantId)) {
    throw new GraphApiError({
      code: "VALIDATION",
      reasonCode: "GRAPH_MULTI_TENANT_FORBIDDEN",
      safeMessage:
        "Multi-tenant Entra authorities (common, organizations, consumers) are forbidden; enter a single-tenant directory GUID.",
      status: null,
      retryable: false,
      requestSent: false,
    });
  }
  if (!isValidSingleTenantGuid(tenantId)) {
    throw new GraphApiError({
      code: "VALIDATION",
      reasonCode: "GRAPH_INVALID_TENANT_ID",
      safeMessage: "Microsoft Graph requires a valid single-tenant Entra directory GUID.",
      status: null,
      retryable: false,
      requestSent: false,
    });
  }
  if (!isValidEntraClientGuid(clientId)) {
    throw new GraphApiError({
      code: "VALIDATION",
      reasonCode: "GRAPH_INVALID_CLIENT_ID",
      safeMessage: "Microsoft Graph requires a valid Entra application (client) GUID.",
      status: null,
      retryable: false,
      requestSent: false,
    });
  }
  if (!clientSecret || clientSecret.length > 1024 || !hasNoHeaderInjection(clientSecret)) {
    throw new GraphApiError({
      code: "VALIDATION",
      reasonCode: "GRAPH_INVALID_CLIENT_SECRET",
      safeMessage: "Microsoft Graph requires a configured Entra application client secret.",
      status: null,
      retryable: false,
      requestSent: false,
    });
  }
  return { tenantId, clientId, clientSecret };
}

function parseSafeOAuthErrorCode(rawBody: Buffer): string | null {
  try {
    const parsed = JSON.parse(rawBody.toString("utf8")) as { error?: unknown } | null;
    if (parsed && typeof parsed.error === "string" && SAFE_OAUTH_ERROR_CODE.test(parsed.error)) {
      return parsed.error;
    }
  } catch {
    // Ignore malformed JSON — never surface raw body.
  }
  return null;
}

export function createGraphTokenCache(egress: EgressPolicy, clock: Clock): GraphTokenCache {
  const cache = new Map<string, CachedTokenEntry>();
  const inflight = new Map<string, Promise<string>>();
  let generation = 0;

  async function fetchFreshToken(
    creds: { tenantId: string; clientId: string; clientSecret: string },
    cacheKey: string,
    expectedGeneration: number,
  ): Promise<string> {
    const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(creds.tenantId)}/oauth2/v2.0/token`;
    const form = new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      scope: GRAPH_DEFAULT_SCOPE,
      grant_type: "client_credentials",
    });

    let response: Awaited<ReturnType<EgressPolicy["fetchPinned"]>>;
    try {
      response = await egress.fetchPinned(tokenUrl, "graph", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: form.toString(),
        timeoutMs: TOKEN_TIMEOUT_MS,
        maxResponseBytes: TOKEN_MAX_RESPONSE_BYTES,
      });
    } catch (error) {
      if (error instanceof DomainError) {
        const isEgressPolicyDeny = error.code === "FORBIDDEN" || error.code === "VALIDATION";
        throw new GraphApiError({
          code: isEgressPolicyDeny ? "FORBIDDEN" : "UNAVAILABLE",
          reasonCode: error.reasonCode,
          safeMessage: error.safeMessage,
          status: null,
          retryable: !isEgressPolicyDeny,
          requestSent: false,
        });
      }
      throw new GraphApiError({
        code: "UNAVAILABLE",
        reasonCode: "GRAPH_TOKEN_NETWORK_FAILED",
        safeMessage: "Unable to reach Microsoft Entra token endpoint.",
        status: null,
        retryable: true,
        requestSent: false,
      });
    }

    if (response.status < 200 || response.status >= 300) {
      const oauthError = parseSafeOAuthErrorCode(response.body);
      const retryable = response.status === 429 || response.status >= 500;
      throw new GraphApiError({
        code: retryable ? "UNAVAILABLE" : "FORBIDDEN",
        reasonCode: retryable ? "GRAPH_TOKEN_UNAVAILABLE" : "GRAPH_TOKEN_AUTH_FAILED",
        safeMessage: retryable
          ? "Microsoft Entra temporarily throttled or failed the token request."
          : "Microsoft Entra rejected the application credentials or tenant ID.",
        // Keep `status: null` so downstream Graph callers distinguish OAuth token failures from Graph API HTTP statuses.
        status: null,
        graphCode: oauthError,
        retryable,
        requestSent: false,
      });
    }

    let parsed: { access_token?: unknown; token_type?: unknown; expires_in?: unknown };
    try {
      parsed = JSON.parse(response.body.toString("utf8")) as {
        access_token?: unknown;
        token_type?: unknown;
        expires_in?: unknown;
      };
    } catch {
      throw new GraphApiError({
        code: "UNAVAILABLE",
        reasonCode: "GRAPH_TOKEN_INVALID_RESPONSE",
        safeMessage: "Microsoft Entra returned an unreadable token response.",
        status: null,
        retryable: false,
        requestSent: false,
      });
    }

    const accessToken = typeof parsed?.access_token === "string" ? parsed.access_token.trim() : "";
    const tokenType = typeof parsed?.token_type === "string" ? parsed.token_type.trim().toLowerCase() : "bearer";
    const rawExpiresIn =
      typeof parsed?.expires_in === "number"
        ? parsed.expires_in
        : typeof parsed?.expires_in === "string"
          ? Number.parseInt(parsed.expires_in, 10)
          : NaN;

    if (!accessToken || !hasNoHeaderInjection(accessToken) || tokenType !== "bearer") {
      throw new GraphApiError({
        code: "UNAVAILABLE",
        reasonCode: "GRAPH_TOKEN_INVALID_RESPONSE",
        safeMessage: "Microsoft Entra returned an invalid bearer token payload.",
        status: null,
        retryable: false,
        requestSent: false,
      });
    }

    const expiresInSec = Number.isFinite(rawExpiresIn) && rawExpiresIn > 0 ? rawExpiresIn : 3600;
    const ttlMs = Math.max(0, expiresInSec - EXPIRY_SAFETY_WINDOW_SEC) * 1000;
    if (ttlMs > 0 && generation === expectedGeneration) {
      cache.set(cacheKey, {
        accessToken,
        expiresAtMs: clock.now().getTime() + ttlMs,
      });
    }

    return accessToken;
  }

  return {
    async getAccessToken(credentials, signal): Promise<string> {
      if (signal?.aborted) {
        throw new GraphApiError({
          code: "UNAVAILABLE",
          reasonCode: "GRAPH_ABORTED",
          safeMessage: "The Microsoft Graph request was aborted before sending.",
          status: null,
          retryable: true,
          requestSent: false,
          aborted: true,
        });
      }

      const normalized = assertValidSingleTenantGraphCredentials(credentials);
      const cacheKey = buildCredentialKey({
        ...normalized,
        credentialVersion: credentials.credentialVersion,
      });

      const nowMs = clock.now().getTime();
      const hit = cache.get(cacheKey);
      if (hit && hit.expiresAtMs > nowMs) {
        return hit.accessToken;
      }
      if (hit) {
        cache.delete(cacheKey);
      }

      let pending = inflight.get(cacheKey);
      if (!pending) {
        const genAtStart = generation;
        pending = fetchFreshToken(normalized, cacheKey, genAtStart).finally(() => {
          inflight.delete(cacheKey);
        });
        inflight.set(cacheKey, pending);
      }

      const token = await pending;
      if (signal?.aborted) {
        throw new GraphApiError({
          code: "UNAVAILABLE",
          reasonCode: "GRAPH_ABORTED",
          safeMessage: "The Microsoft Graph request was aborted before sending.",
          status: null,
          retryable: true,
          requestSent: false,
          aborted: true,
        });
      }
      return token;
    },

    invalidate(credentials): void {
      const prefix = `${credentials.tenantId.trim().toLowerCase()}:${credentials.clientId.trim().toLowerCase()}:`;
      generation += 1;
      for (const key of cache.keys()) {
        if (key.startsWith(prefix)) cache.delete(key);
      }
    },

    clear(): void {
      generation += 1;
      cache.clear();
      inflight.clear();
    },
  };
}
