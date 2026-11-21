/**
 * Binds the drive adapter's GraphHttpPort to the shared Microsoft Graph client of package C
 * (services.integrations.createScopedGraphClient, server/modules/integrations/API.md §1.2).
 *
 * The integrations runtime (server/modules/integrations/graph/**) was not present when this was written, so the
 * client is typed structurally from the published API instead of imported. Behaviour against the real client
 * is NOT verified; graphDriveGraph.test.ts checks this mapping against a structural stub only.
 *
 * Gates (§4.1 G/H):
 *  - Graph API calls go through `request` (purpose "graph", egress-pinned, bearer token added by the client).
 *  - Upload-session URLs go through `uploadChunk` (purpose "graph_upload", which refuses Authorization/Cookie),
 *    narrowed to the exact host the adapter already checked against the tenant lineage. The URL is never
 *    logged or placed into an error here.
 *  - The published client has no raw-bytes `request` body and no upload-session GET/DELETE yet; the port
 *    reports `supportsRawBody: false` (the adapter then uses upload sessions for every file) and session
 *    control fails closed (resume is not attempted; cancel is best-effort, sessions expire on their own).
 */
import { type GraphCredentials, type GraphHttpPort, type GraphRequest, type GraphResponse, GraphTransportError } from "./graphDrivePort.js";

/** Structural view of the published GraphClient (integrations API.md §1.2). */
export interface PublishedGraphClient {
  request(input: {
    method: GraphRequest["method"];
    path: string;
    query?: Record<string, string>;
    body?: unknown;
    headers?: Record<string, string>;
    maxResponseBytes?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<{ status: number; headers: Record<string, string>; rawBody: Buffer }>;
  uploadChunk(input: {
    uploadUrl: string;
    bytes: Uint8Array;
    contentRange: string;
    allowedHostSuffixes?: readonly string[];
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<{ status: number; headers: Record<string, string>; rawBody: Buffer }>;
}

export type ScopedGraphClientFactory = (credentials: GraphCredentials) => PublishedGraphClient;

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const CHUNK_TIMEOUT_MS = 120_000;

function lowerHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) out[k.toLowerCase()] = v;
  return out;
}

function parseBody(raw: Buffer | undefined): unknown {
  if (!raw || raw.length === 0) return null;
  try {
    return JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

interface GraphApiErrorLike {
  name?: unknown;
  status?: unknown;
  retryable?: unknown;
  requestSent?: unknown;
  reason?: unknown;
  code?: unknown;
}

/**
 * GraphApiError with an HTTP status becomes a plain response (the adapter maps statuses itself); everything
 * else becomes a fixed GraphTransportError. Provider bodies, messages and URLs are dropped.
 * An ambiguous send (`requestSent`) stays retryable: drive writes use conflictBehavior "fail" and a re-run
 * recognises an identical existing object; list writes look the item up by OrderId before creating.
 */
export function mapGraphError(error: unknown): GraphResponse {
  if (error instanceof GraphTransportError) throw error;
  const e = (typeof error === "object" && error !== null ? error : {}) as GraphApiErrorLike;
  if (e.name === "AbortError") throw new GraphTransportError("ABORTED", false);
  const tag = `${typeof e.reason === "string" ? e.reason : ""} ${typeof e.code === "string" ? e.code : ""}`.toUpperCase();
  if (tag.includes("EGRESS")) throw new GraphTransportError("EGRESS_DENIED", false);
  if (tag.includes("TOO_LARGE")) throw new GraphTransportError("RESPONSE_TOO_LARGE", false);
  if (tag.includes("TIMEOUT")) throw new GraphTransportError("TIMEOUT", true);
  if (typeof e.status === "number" && Number.isInteger(e.status) && e.status >= 100 && e.status <= 599) {
    return { status: e.status, headers: {}, body: null };
  }
  if (tag.includes("TOKEN") || tag.includes("AUTH")) throw new GraphTransportError("AUTH_FAILED", false);
  throw new GraphTransportError("NETWORK", e.retryable !== false);
}

/**
 * `scoped` = (creds) => services.integrations.createScopedGraphClient(creds);
 * `uploader` = () => services.integrations.graph (uploadChunk carries no credentials at all).
 * Both are resolved lazily per call, never during module construction.
 */
export function createGraphDrivePort(factory: ScopedGraphClientFactory, uploader: () => PublishedGraphClient): GraphHttpPort {
  return {
    supportsRawBody: false,

    async request(credentials: GraphCredentials, req: GraphRequest): Promise<GraphResponse> {
      if (req.rawBody) throw new GraphTransportError("NETWORK", false); // not supported by the published client
      if (!req.path.startsWith("/") || req.path.startsWith("//")) throw new GraphTransportError("EGRESS_DENIED", false);
      try {
        const client = factory(credentials);
        const res = await client.request({
          method: req.method,
          path: req.path,
          ...(req.query ? { query: req.query } : {}),
          ...(req.body !== undefined ? { body: req.body } : {}),
          ...(req.headers ? { headers: req.headers } : {}),
          maxResponseBytes: MAX_RESPONSE_BYTES,
          timeoutMs: REQUEST_TIMEOUT_MS,
          ...(req.signal ? { signal: req.signal } : {}),
        });
        return { status: res.status, headers: lowerHeaders(res.headers), body: parseBody(res.rawBody) };
      } catch (error) {
        return mapGraphError(error);
      }
    },

    async uploadSessionPut(input): Promise<GraphResponse> {
      // Re-assert the invariants the adapter already checked; the exact host is the only allowed suffix.
      if (input.url.protocol !== "https:" || input.url.port !== "" || input.url.username || input.url.password) {
        throw new GraphTransportError("EGRESS_DENIED", false);
      }
      try {
        const client = uploader();
        const res = await client.uploadChunk({
          uploadUrl: input.url.href,
          bytes: input.body,
          contentRange: input.contentRange,
          allowedHostSuffixes: [input.url.hostname],
          timeoutMs: CHUNK_TIMEOUT_MS,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        return { status: res.status, headers: lowerHeaders(res.headers), body: parseBody(res.rawBody) };
      } catch (error) {
        return mapGraphError(error);
      }
    },

    async uploadSessionControl(): Promise<GraphResponse> {
      // Not in the published client yet: fail closed (no resume; cancel is best-effort and ignored).
      throw new GraphTransportError("NETWORK", false);
    },
  };
}
