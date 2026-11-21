/**
 * Binds the drive adapter's GraphHttpPort to the shared Microsoft Graph client of package C
 * (services.integrations.createScopedGraphClient, server/modules/integrations/API.md §1.2).
 *
 * Bound to the integrations GraphClient runtime (server/modules/integrations/graph/**, commit 7668b53). The client
 * is typed structurally (a subset of integrations/graph/types.ts GraphClient). graphDriveGraph.test.ts checks
 * this mapping against a structural stub AND against the real client over a local fake transport; never a tenant.
 *
 * Gates (§4.1 G/H):
 *  - Graph API calls go through `request` (purpose "graph", egress-pinned, bearer token added by the client).
 *  - Upload-session URLs go through `uploadChunk` (purpose "graph_upload", which refuses Authorization/Cookie),
 *    narrowed to the exact host the adapter already checked against the tenant lineage. The URL is never
 *    logged or placed into an error here.
 *  - Small files use `request` with a raw byte body (`supportsRawBody: true`). Upload-session status/cancel use
 *    `uploadSessionControl` under the same graph_upload guardrails, narrowed to the checked host.
 *  - Fencing (G-02): the caller's `beforeSend` is passed to the client, which runs it after token acquisition and
 *    egress resolution, directly before each send; its error propagates unchanged.
 */
import { type GraphCredentials, type GraphHttpPort, type GraphRequest, type GraphResponse, GraphTransportError } from "./graphDrivePort.js";

/** Structural view of the published GraphClient (integrations API.md §1.2). */
export interface PublishedGraphClient {
  request(input: {
    method: GraphRequest["method"];
    path: string;
    query?: Record<string, string>;
    body?: unknown;
    rawBody?: Uint8Array;
    headers?: Record<string, string>;
    maxResponseBytes?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** G-02: called by the client after token acquisition, directly before each send; throws propagate unchanged. */
    beforeSend?: () => Promise<void>;
  }): Promise<{ status: number; headers: Record<string, string>; rawBody: Buffer }>;
  uploadChunk(input: {
    uploadUrl: string;
    bytes: Uint8Array;
    contentRange: string;
    allowedHostSuffixes?: readonly string[];
    timeoutMs?: number;
    signal?: AbortSignal;
    beforeSend?: () => Promise<void>;
  }): Promise<{ status: number; headers: Record<string, string>; rawBody: Buffer }>;
  uploadSessionControl(input: {
    uploadUrl: string;
    method: "GET" | "DELETE";
    allowedHostSuffixes?: readonly string[];
    timeoutMs?: number;
    signal?: AbortSignal;
    beforeSend?: () => Promise<void>;
  }): Promise<{ status: number; headers: Record<string, string>; rawBody: Buffer }>;
}

function assertCheckedUploadUrl(url: URL): void {
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) throw new GraphTransportError("EGRESS_DENIED", false);
}

/** Wraps a fence so its error can be told apart from transport errors and rethrown unchanged. */
function trackFence(fence: (() => Promise<void>) | undefined) {
  const state: { lost: { error: unknown } | null } = { lost: null };
  const wrapped = fence
    ? async () => {
        try {
          await fence();
        } catch (error) {
          state.lost = { error };
          throw error;
        }
      }
    : undefined;
  return { state, wrapped };
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
  reasonCode?: unknown;
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
  const tag = [e.reasonCode, e.reason, e.code].map((v) => (typeof v === "string" ? v : "")).join(" ").toUpperCase();
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
    supportsRawBody: true,

    async request(credentials: GraphCredentials, req: GraphRequest): Promise<GraphResponse> {
      if (!req.path.startsWith("/") || req.path.startsWith("//")) throw new GraphTransportError("EGRESS_DENIED", false);
      const fence = trackFence(req.beforeSend);
      try {
        const client = factory(credentials);
        const res = await client.request({
          method: req.method,
          path: req.path,
          ...(req.query ? { query: req.query } : {}),
          ...(req.rawBody ? { rawBody: new Uint8Array(req.rawBody.buffer, req.rawBody.byteOffset, req.rawBody.byteLength) } : req.body !== undefined ? { body: req.body } : {}),
          ...(req.headers ? { headers: req.headers } : {}),
          maxResponseBytes: MAX_RESPONSE_BYTES,
          timeoutMs: REQUEST_TIMEOUT_MS,
          ...(req.signal ? { signal: req.signal } : {}),
          ...(fence.wrapped ? { beforeSend: fence.wrapped } : {}),
        });
        return { status: res.status, headers: lowerHeaders(res.headers), body: parseBody(res.rawBody) };
      } catch (error) {
        if (fence.state.lost) throw fence.state.lost.error;
        return mapGraphError(error);
      }
    },

    async uploadSessionPut(input): Promise<GraphResponse> {
      // Re-assert the invariants the adapter already checked; the exact host is the only allowed suffix.
      assertCheckedUploadUrl(input.url);
      const fence = trackFence(input.beforeSend);
      try {
        const client = uploader();
        const res = await client.uploadChunk({
          uploadUrl: input.url.href,
          bytes: input.body,
          contentRange: input.contentRange,
          allowedHostSuffixes: [input.url.hostname],
          timeoutMs: CHUNK_TIMEOUT_MS,
          ...(input.signal ? { signal: input.signal } : {}),
          ...(fence.wrapped ? { beforeSend: fence.wrapped } : {}),
        });
        return { status: res.status, headers: lowerHeaders(res.headers), body: parseBody(res.rawBody) };
      } catch (error) {
        if (fence.state.lost) throw fence.state.lost.error;
        return mapGraphError(error);
      }
    },

    async uploadSessionControl(input): Promise<GraphResponse> {
      assertCheckedUploadUrl(input.url);
      const fence = trackFence(input.beforeSend);
      try {
        const res = await uploader().uploadSessionControl({
          uploadUrl: input.url.href,
          method: input.method,
          allowedHostSuffixes: [input.url.hostname],
          timeoutMs: REQUEST_TIMEOUT_MS,
          ...(input.signal ? { signal: input.signal } : {}),
          ...(fence.wrapped ? { beforeSend: fence.wrapped } : {}),
        });
        return { status: res.status, headers: lowerHeaders(res.headers), body: parseBody(res.rawBody) };
      } catch (error) {
        if (fence.state.lost) throw fence.state.lost.error;
        return mapGraphError(error);
      }
    },
  };
}
