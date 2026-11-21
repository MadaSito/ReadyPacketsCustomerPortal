/**
 * Microsoft Graph v1.0 client & resumable upload-session client (`server/modules/integrations/graph/client.ts`).
 *
 * Security invariants:
 *  - Every Graph API call routes through `egress.fetchPinned(..., "graph")` to `https://graph.microsoft.com/v1.0/...`.
 *  - Every upload-session call routes through `egress.fetchPinned(..., "graph_upload")` with bounded SharePoint /
 *    OneDrive host suffix lineage (`*.sharepoint.com`, `*.files.1drv.com`), ZERO bearer token / cookie forwarding,
 *    and ZERO logging or exposure of the pre-authenticated `uploadUrl`.
 *  - Zero hidden retries: caller `beforeSend` fencing (`G-02`) runs 1:1 after token acquisition + DNS/allowlist
 *    resolution and directly before wire socket creation; any error thrown by `beforeSend` propagates unchanged.
 */
import { DomainError } from "../../../core/errors.js";
import { GRAPH_UPLOAD_WILDCARD_SUFFIXES } from "../egressPresets.js";
import type { EgressPolicy } from "../egress.js";
import { hasNoHeaderInjection } from "../settings.js";
import type { GraphTokenCache } from "./tokenCache.js";
import {
  GraphApiError,
  type GraphClient,
  type GraphCredentialsInput,
  type GraphRequestInput,
  type GraphResponse,
  type GraphUploadChunkInput,
  type GraphUploadChunkResult,
  type GraphUploadSessionControlInput,
} from "./types.js";

const GRAPH_BASE_ORIGIN = "https://graph.microsoft.com";
const GRAPH_API_PREFIX = "/v1.0";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_UPLOAD_MAX_RESPONSE_BYTES = 512 * 1024;
const SAFE_GRAPH_ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const SAFE_HEADER_NAME = /^[A-Za-z0-9-]+$/;
const CONTENT_RANGE_PATTERN = /^bytes (\d+)-(\d+)\/(\d+|\*)$/;

const DEFAULT_UPLOAD_HOST_SUFFIXES: readonly string[] = GRAPH_UPLOAD_WILDCARD_SUFFIXES.map((s) => `*.${s}`);

const DEFINITIVE_PREWIRE_EGRESS_REASONS = new Set([
  "EGRESS_CONNECT_REFUSED",
  "EGRESS_TLS_VALIDATION_FAILED",
]);

export type GraphCredentialResolver = () => Promise<GraphCredentialsInput | null>;

function buildGraphV1Url(
  rawPath: string,
  query?: Record<string, string | number | boolean | undefined>,
): URL {
  if (
    typeof rawPath !== "string" ||
    rawPath.length === 0 ||
    rawPath.length > 2048 ||
    !rawPath.startsWith("/") ||
    rawPath.startsWith("//") ||
    rawPath.includes("//") ||
    rawPath.includes("?") ||
    rawPath.includes("#") ||
    rawPath.includes("\\") ||
    !hasNoHeaderInjection(rawPath)
  ) {
    throw new GraphApiError({
      code: "VALIDATION",
      reasonCode: "GRAPH_INVALID_PATH",
      safeMessage: "Invalid Microsoft Graph API resource path.",
      status: null,
      retryable: false,
      requestSent: false,
    });
  }

  const decodedSegments = rawPath.split("/").slice(1);
  for (const segment of decodedSegments) {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new GraphApiError({
        code: "VALIDATION",
        reasonCode: "GRAPH_INVALID_PATH",
        safeMessage: "Malformed percent-encoding in Microsoft Graph API path.",
        status: null,
        retryable: false,
        requestSent: false,
      });
    }
    if (
      segment === "." ||
      segment === ".." ||
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      (decoded !== "" && !hasNoHeaderInjection(decoded))
    ) {
      throw new GraphApiError({
        code: "VALIDATION",
        reasonCode: "GRAPH_PATH_TRAVERSAL_FORBIDDEN",
        safeMessage: "Relative path traversal segments are forbidden in Microsoft Graph paths.",
        status: null,
        retryable: false,
        requestSent: false,
      });
    }
  }

  const url = new URL(`${GRAPH_API_PREFIX}${rawPath}`, GRAPH_BASE_ORIGIN);
  if (url.origin !== GRAPH_BASE_ORIGIN || !url.pathname.startsWith(`${GRAPH_API_PREFIX}/`)) {
    throw new GraphApiError({
      code: "VALIDATION",
      reasonCode: "GRAPH_INVALID_PATH",
      safeMessage: "Microsoft Graph request escaped expected v1.0 origin.",
      status: null,
      retryable: false,
      requestSent: false,
    });
  }

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      const strVal = String(value);
      if (!key || !hasNoHeaderInjection(key) || (strVal !== "" && !hasNoHeaderInjection(strVal))) {
        throw new GraphApiError({
          code: "VALIDATION",
          reasonCode: "GRAPH_INVALID_QUERY",
          safeMessage: "Invalid Microsoft Graph query parameter.",
          status: null,
          retryable: false,
          requestSent: false,
        });
      }
      url.searchParams.set(key, strVal);
    }
  }

  return url;
}

function validateSafeCallerHeaders(headers?: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  if (!headers) return sanitized;
  for (const [rawKey, rawVal] of Object.entries(headers)) {
    const key = rawKey.trim();
    const lower = key.toLowerCase();
    // Never permit caller overrides of Authorization, Cookie, or Host.
    if (lower === "authorization" || lower === "cookie" || lower === "host") {
      throw new GraphApiError({
        code: "VALIDATION",
        reasonCode: "GRAPH_RESERVED_HEADER_FORBIDDEN",
        safeMessage: `Caller override of reserved header ${key} is forbidden.`,
        status: null,
        retryable: false,
        requestSent: false,
      });
    }
    if (!SAFE_HEADER_NAME.test(key) || (rawVal !== "" && !hasNoHeaderInjection(rawVal))) {
      throw new GraphApiError({
        code: "VALIDATION",
        reasonCode: "GRAPH_INVALID_HEADER",
        safeMessage: "Invalid Microsoft Graph HTTP header.",
        status: null,
        retryable: false,
        requestSent: false,
      });
    }
    sanitized[key] = rawVal;
  }
  return sanitized;
}

function validateContentRange(contentRange: string, chunkByteLength: number): void {
  const match = CONTENT_RANGE_PATTERN.exec(contentRange.trim());
  if (!match) {
    throw new GraphApiError({
      code: "VALIDATION",
      reasonCode: "GRAPH_INVALID_CONTENT_RANGE",
      safeMessage: "Invalid Content-Range header for Graph upload chunk.",
      status: null,
      retryable: false,
      requestSent: false,
    });
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  const totalStr = match[3]!;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end - start + 1 !== chunkByteLength
  ) {
    throw new GraphApiError({
      code: "VALIDATION",
      reasonCode: "GRAPH_CONTENT_RANGE_MISMATCH",
      safeMessage: "Graph upload chunk byte length does not match declared Content-Range.",
      status: null,
      retryable: false,
      requestSent: false,
    });
  }
  if (totalStr !== "*") {
    const total = Number(totalStr);
    if (!Number.isSafeInteger(total) || total <= end) {
      throw new GraphApiError({
        code: "VALIDATION",
        reasonCode: "GRAPH_CONTENT_RANGE_MISMATCH",
        safeMessage: "Graph upload total size must exceed chunk end offset.",
        status: null,
        retryable: false,
        requestSent: false,
      });
    }
  }
}

function precheckUploadSessionUrl(rawUploadUrl: string): void {
  if (typeof rawUploadUrl !== "string" || rawUploadUrl.trim().length === 0 || rawUploadUrl.length > 8192) {
    throw new GraphApiError({
      code: "VALIDATION",
      reasonCode: "EGRESS_INVALID_URL",
      safeMessage: "Invalid Microsoft Graph upload-session URL.",
      status: null,
      retryable: false,
      requestSent: false,
    });
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUploadUrl);
  } catch {
    // Never include `rawUploadUrl` in error messages!
    throw new GraphApiError({
      code: "VALIDATION",
      reasonCode: "EGRESS_INVALID_URL",
      safeMessage: "Malformed Microsoft Graph upload-session URL.",
      status: null,
      retryable: false,
      requestSent: false,
    });
  }
  if (parsed.protocol !== "https:" || (parsed.port !== "" && parsed.port !== "443")) {
    throw new GraphApiError({
      code: "FORBIDDEN",
      reasonCode: "EGRESS_HTTPS_REQUIRED",
      safeMessage: "Microsoft Graph upload-session URLs must use HTTPS on port 443.",
      status: null,
      retryable: false,
      requestSent: false,
    });
  }
  if (parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") {
    throw new GraphApiError({
      code: "VALIDATION",
      reasonCode: "EGRESS_INVALID_URL",
      safeMessage: "Microsoft Graph upload-session URL contains forbidden userinfo or fragment components.",
      status: null,
      retryable: false,
      requestSent: false,
    });
  }
}

function extractSafeGraphErrorCode(rawBody: Buffer): string | null {
  try {
    const parsed = JSON.parse(rawBody.toString("utf8")) as {
      error?: { code?: unknown; innerError?: { code?: unknown } };
    } | null;
    const candidate = parsed?.error?.code;
    if (typeof candidate === "string" && SAFE_GRAPH_ERROR_CODE.test(candidate)) {
      return candidate;
    }
  } catch {
    // Ignore non-JSON body; never expose raw provider error text.
  }
  return null;
}

function mapEgressFailureToGraphError(error: unknown, wireEntered: boolean): GraphApiError {
  if (error instanceof GraphApiError) return error;
  if (error instanceof DomainError) {
    const preWire = !wireEntered || DEFINITIVE_PREWIRE_EGRESS_REASONS.has(error.reasonCode);
    if (error.reasonCode === "EGRESS_ABORTED") {
      return new GraphApiError({
        code: "UNAVAILABLE",
        reasonCode: "GRAPH_ABORTED",
        safeMessage: "The Microsoft Graph request was aborted.",
        status: null,
        retryable: preWire,
        requestSent: !preWire,
        aborted: true,
      });
    }
    if (error.reasonCode === "EGRESS_TIMEOUT") {
      return new GraphApiError({
        code: "UNAVAILABLE",
        reasonCode: "GRAPH_TIMEOUT",
        safeMessage: "The Microsoft Graph request timed out.",
        status: null,
        retryable: true,
        requestSent: !preWire,
      });
    }
    if (error.reasonCode === "EGRESS_RESPONSE_TOO_LARGE") {
      return new GraphApiError({
        code: "VALIDATION",
        reasonCode: "GRAPH_RESPONSE_TOO_LARGE",
        safeMessage: "The Microsoft Graph response exceeded the maximum allowed size.",
        status: null,
        retryable: false,
        requestSent: !preWire,
      });
    }
    const isPolicyDeny = error.code === "FORBIDDEN" || error.code === "VALIDATION";
    return new GraphApiError({
      code: isPolicyDeny ? "FORBIDDEN" : "UNAVAILABLE",
      reasonCode: error.reasonCode,
      safeMessage: error.safeMessage,
      status: null,
      retryable: !isPolicyDeny,
      requestSent: !preWire,
    });
  }
  return new GraphApiError({
    code: "UNAVAILABLE",
    reasonCode: "GRAPH_NETWORK_FAILED",
    safeMessage: "Microsoft Graph network request failed.",
    status: null,
    retryable: true,
    requestSent: wireEntered,
  });
}

export function createGraphClientFromResolver(
  egress: EgressPolicy,
  tokenCache: GraphTokenCache,
  resolveCredentials: GraphCredentialResolver,
  checkIsConfigured?: () => Promise<boolean>,
): GraphClient {
  return {
    async isConfigured(): Promise<boolean> {
      if (checkIsConfigured) {
        return checkIsConfigured();
      }
      const creds = await resolveCredentials();
      return creds !== null;
    },

    async request<T = unknown>(input: GraphRequestInput): Promise<GraphResponse<T>> {
      const url = buildGraphV1Url(input.path, input.query);
      const callerHeaders = validateSafeCallerHeaders(input.headers);

      const creds = await resolveCredentials();
      if (!creds) {
        throw new GraphApiError({
          code: "NOT_CONFIGURED",
          reasonCode: "GRAPH_NOT_CONFIGURED",
          safeMessage: "Microsoft Graph integration is not configured or enabled.",
          status: null,
          retryable: false,
          requestSent: false,
        });
      }

      // 1. Acquire bearer token FIRST (before caller `beforeSend` fencing per G-02).
      const accessToken = await tokenCache.getAccessToken(creds, input.signal);

      const rawBytes =
        input.rawBody instanceof Uint8Array
          ? input.rawBody
          : input.body instanceof Uint8Array
            ? input.body
            : undefined;

      let serializedBody: string | Uint8Array | undefined;
      const headers: Record<string, string> = {
        Accept: "application/json",
        ...callerHeaders,
        Authorization: `Bearer ${accessToken}`,
      };

      const hasContentType = Object.keys(callerHeaders).some((k) => k.toLowerCase() === "content-type");
      if (rawBytes !== undefined) {
        serializedBody = rawBytes;
        if (!hasContentType) headers["Content-Type"] = "application/octet-stream";
      } else if (input.body !== undefined) {
        serializedBody = JSON.stringify(input.body);
        if (!hasContentType) headers["Content-Type"] = "application/json";
      }

      let wireEntered = false;
      let callerFenceThrew = false;
      let callerFenceError: unknown;

      const internalBeforeSend = async () => {
        if (input.beforeSend) {
          try {
            await input.beforeSend();
          } catch (err) {
            callerFenceThrew = true;
            callerFenceError = err;
            throw err;
          }
        }
        wireEntered = true;
      };

      let response: Awaited<ReturnType<EgressPolicy["fetchPinned"]>>;
      try {
        response = await egress.fetchPinned(url, "graph", {
          method: input.method,
          headers,
          body: serializedBody,
          timeoutMs: input.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
          maxResponseBytes: input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
          signal: input.signal,
          beforeSend: internalBeforeSend,
        });
      } catch (error) {
        if (callerFenceThrew) {
          throw callerFenceError;
        }
        throw mapEgressFailureToGraphError(error, wireEntered);
      }

      if (response.status >= 400) {
        const graphCode = extractSafeGraphErrorCode(response.body);
        const retryable = response.status === 429 || response.status >= 500;
        const code =
          response.status === 401 || response.status === 403
            ? "FORBIDDEN"
            : response.status === 404
              ? "NOT_FOUND"
              : retryable
                ? "UNAVAILABLE"
                : "VALIDATION";
        throw new GraphApiError({
          code,
          reasonCode: response.status === 429 ? "GRAPH_THROTTLED" : `GRAPH_HTTP_${response.status}`,
          safeMessage:
            response.status === 429
              ? "Microsoft Graph throttled the request."
              : `Microsoft Graph rejected the request with HTTP ${response.status}.`,
          status: response.status,
          graphCode,
          retryable,
          requestSent: true,
        });
      }

      const rawBody = response.body;
      return {
        status: response.status,
        headers: response.headers,
        rawBody,
        json<U = T>(): U {
          if (rawBody.byteLength === 0) {
            throw new GraphApiError({
              code: "UNAVAILABLE",
              reasonCode: "GRAPH_EMPTY_JSON_RESPONSE",
              safeMessage: "Microsoft Graph returned an empty response body where JSON was expected.",
              status: response.status,
              retryable: false,
              requestSent: true,
            });
          }
          try {
            return JSON.parse(rawBody.toString("utf8")) as U;
          } catch {
            throw new GraphApiError({
              code: "UNAVAILABLE",
              reasonCode: "GRAPH_INVALID_JSON_RESPONSE",
              safeMessage: "Microsoft Graph returned an invalid JSON payload.",
              status: response.status,
              retryable: false,
              requestSent: true,
            });
          }
        },
      };
    },

    async uploadChunk(input: GraphUploadChunkInput): Promise<GraphUploadChunkResult> {
      precheckUploadSessionUrl(input.uploadUrl);
      if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
        throw new GraphApiError({
          code: "VALIDATION",
          reasonCode: "GRAPH_EMPTY_UPLOAD_CHUNK",
          safeMessage: "Graph upload chunk must contain at least one byte.",
          status: null,
          retryable: false,
          requestSent: false,
        });
      }
      validateContentRange(input.contentRange, input.bytes.byteLength);

      let wireEntered = false;
      let callerFenceThrew = false;
      let callerFenceError: unknown;

      const internalBeforeSend = async () => {
        if (input.beforeSend) {
          try {
            await input.beforeSend();
          } catch (err) {
            callerFenceThrew = true;
            callerFenceError = err;
            throw err;
          }
        }
        wireEntered = true;
      };

      let response: Awaited<ReturnType<EgressPolicy["fetchPinned"]>>;
      try {
        response = await egress.fetchPinned(input.uploadUrl, "graph_upload", {
          method: "PUT",
          headers: {
            "Content-Length": String(input.bytes.byteLength),
            "Content-Range": input.contentRange.trim(),
            Accept: "application/json",
          },
          body: input.bytes,
          expectedHostSuffixes: input.allowedHostSuffixes ?? DEFAULT_UPLOAD_HOST_SUFFIXES,
          timeoutMs: input.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS,
          maxResponseBytes: DEFAULT_UPLOAD_MAX_RESPONSE_BYTES,
          signal: input.signal,
          beforeSend: internalBeforeSend,
        });
      } catch (error) {
        if (callerFenceThrew) {
          throw callerFenceError;
        }
        throw mapEgressFailureToGraphError(error, wireEntered);
      }

      if (response.status >= 400) {
        const graphCode = extractSafeGraphErrorCode(response.body);
        const retryable = response.status === 429 || response.status >= 500;
        throw new GraphApiError({
          code: retryable ? "UNAVAILABLE" : "VALIDATION",
          reasonCode: response.status === 429 ? "GRAPH_UPLOAD_THROTTLED" : `GRAPH_UPLOAD_HTTP_${response.status}`,
          safeMessage: `Microsoft Graph upload session returned HTTP ${response.status}.`,
          status: response.status,
          graphCode,
          retryable,
          requestSent: true,
        });
      }

      const rawBody = response.body;
      return {
        status: response.status,
        headers: response.headers,
        rawBody,
        json<T = unknown>(): T | null {
          if (rawBody.byteLength === 0) return null;
          try {
            return JSON.parse(rawBody.toString("utf8")) as T;
          } catch {
            return null;
          }
        },
      };
    },

    async uploadSessionControl(input: GraphUploadSessionControlInput): Promise<GraphUploadChunkResult> {
      precheckUploadSessionUrl(input.uploadUrl);
      if (input.method !== "GET" && input.method !== "DELETE") {
        throw new GraphApiError({
          code: "VALIDATION",
          reasonCode: "GRAPH_INVALID_UPLOAD_CONTROL_METHOD",
          safeMessage: "Graph upload session control supports only GET or DELETE.",
          status: null,
          retryable: false,
          requestSent: false,
        });
      }

      let wireEntered = false;
      let callerFenceThrew = false;
      let callerFenceError: unknown;

      const internalBeforeSend = async () => {
        if (input.beforeSend) {
          try {
            await input.beforeSend();
          } catch (err) {
            callerFenceThrew = true;
            callerFenceError = err;
            throw err;
          }
        }
        wireEntered = true;
      };

      let response: Awaited<ReturnType<EgressPolicy["fetchPinned"]>>;
      try {
        response = await egress.fetchPinned(input.uploadUrl, "graph_upload", {
          method: input.method,
          headers: { Accept: "application/json" },
          expectedHostSuffixes: input.allowedHostSuffixes ?? DEFAULT_UPLOAD_HOST_SUFFIXES,
          timeoutMs: input.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
          maxResponseBytes: DEFAULT_UPLOAD_MAX_RESPONSE_BYTES,
          signal: input.signal,
          beforeSend: internalBeforeSend,
        });
      } catch (error) {
        if (callerFenceThrew) {
          throw callerFenceError;
        }
        throw mapEgressFailureToGraphError(error, wireEntered);
      }

      if (response.status >= 400) {
        const graphCode = extractSafeGraphErrorCode(response.body);
        const retryable = response.status === 429 || response.status >= 500;
        throw new GraphApiError({
          code: retryable ? "UNAVAILABLE" : "VALIDATION",
          reasonCode: `GRAPH_UPLOAD_HTTP_${response.status}`,
          safeMessage: `Microsoft Graph upload session returned HTTP ${response.status}.`,
          status: response.status,
          graphCode,
          retryable,
          requestSent: true,
        });
      }

      const rawBody = response.body;
      return {
        status: response.status,
        headers: response.headers,
        rawBody,
        json<T = unknown>(): T | null {
          if (rawBody.byteLength === 0) return null;
          try {
            return JSON.parse(rawBody.toString("utf8")) as T;
          } catch {
            return null;
          }
        },
      };
    },
  };
}
