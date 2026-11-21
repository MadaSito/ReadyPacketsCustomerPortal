/**
 * The narrow Graph transport the drive adapter and the SharePoint order sync need. It is satisfied by the
 * Graph client of package C (server/modules/integrations/graph, integrations_engineer). graphDriveGraph.ts
 * binds it; tests use the local protocol fake in graphDriveFake.ts.
 *
 * Rules the implementation must keep (security review gates §4.1 G/H):
 *  - `request` targets https://graph.microsoft.com/v1.0 only (path is relative, starts with "/"), carries the
 *    client-credentials bearer token, runs through the egress policy (purpose "graph"), with no redirects.
 *  - `uploadSession*` target an ABSOLUTE upload-session URL that the adapter has already checked
 *    (graphDriveUrls.ts: https, port 443, no userinfo, host in the tenant's SharePoint host lineage). They
 *    NEVER carry the bearer token, run through the egress policy with no redirects, and the URL is never
 *    logged, audited or put into an error.
 *  - Errors are thrown as GraphTransportError with a fixed code; never provider bodies or tokens.
 */

export interface GraphCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

export type GraphMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface GraphRequest {
  method: GraphMethod;
  /** Relative to https://graph.microsoft.com/v1.0, e.g. "/sites/{id}/drives". Already URL-encoded. */
  path: string;
  query?: Record<string, string>;
  /** JSON body, or raw bytes for content uploads. */
  body?: unknown;
  rawBody?: Buffer;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface GraphResponse {
  status: number;
  /** Lower-case header names. */
  headers: Record<string, string>;
  /** Parsed JSON (bounded) or null for empty bodies. */
  body: unknown;
}

export type GraphTransportCode = "EGRESS_DENIED" | "AUTH_FAILED" | "TIMEOUT" | "NETWORK" | "RESPONSE_TOO_LARGE" | "ABORTED";

export class GraphTransportError extends Error {
  constructor(
    readonly code: GraphTransportCode,
    readonly retryable: boolean,
  ) {
    super(`graph transport: ${code}`);
    this.name = "GraphTransportError";
  }
}

export interface GraphHttpPort {
  request(credentials: GraphCredentials, request: GraphRequest): Promise<GraphResponse>;
  /** PUT a byte range to a checked upload-session URL. No Authorization header. */
  uploadSessionPut(input: { url: URL; body: Buffer; contentRange: string; signal?: AbortSignal }): Promise<GraphResponse>;
  /** GET the status of (or DELETE / cancel) a checked upload session. No Authorization header. */
  uploadSessionControl(input: { url: URL; method: "GET" | "DELETE"; signal?: AbortSignal }): Promise<GraphResponse>;
}
