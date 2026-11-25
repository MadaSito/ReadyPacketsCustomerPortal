/**
 * Microsoft Graph client, upload-session, and mail-admin contract types (`server/modules/integrations/graph`).
 */
import { DomainError } from "../../../core/errors.js";
import type { SessionPrincipal } from "../../../core/types.js";
import type { ProviderState } from "../smtp.js";

type DomainErrorCode = ConstructorParameters<typeof DomainError>[0];

export type GraphHttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface GraphCredentialsInput {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Optional version stamp to force immediate token-cache isolation on rotation. */
  credentialVersion?: string | number;
}

export interface GraphRequestInput {
  method: GraphHttpMethod;
  /** Graph v1.0 relative path starting with `/` (e.g. `/users/{sender}/sendMail` or `/drives/{id}/root`). */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON-serializable body OR raw `Uint8Array` bytes for small Graph `PUT /content` uploads. */
  body?: unknown;
  /** Explicit raw byte body (takes precedence over `body` when provided). */
  rawBody?: Uint8Array;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
  /**
   * Optional pre-wire fencing callback (`G-02`).
   * Runs AFTER token acquisition + egress DNS/allowlist validation and IMMEDIATELY BEFORE
   * opening/writing to the outbound HTTPS socket. Any thrown error propagates unchanged.
   */
  beforeSend?: () => Promise<void>;
}

export interface GraphResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  rawBody: Buffer;
  json<U = T>(): U;
}

export interface GraphUploadChunkInput {
  /** Pre-authenticated upload-session URL returned by Graph `createUploadSession` (NEVER logged). */
  uploadUrl: string;
  bytes: Uint8Array;
  /** Exact RFC 9110 range header value, e.g. `bytes 0-327679/1048576`. */
  contentRange: string;
  /** Allowed SharePoint/OneDrive host suffixes; defaults to `["*.sharepoint.com", "*.files.1drv.com"]`. */
  allowedHostSuffixes?: readonly string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  beforeSend?: () => Promise<void>;
}

export interface GraphUploadSessionControlInput {
  uploadUrl: string;
  method: "GET" | "DELETE";
  allowedHostSuffixes?: readonly string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  beforeSend?: () => Promise<void>;
}

export interface GraphUploadChunkResult {
  status: number;
  headers: Record<string, string>;
  rawBody: Buffer;
  json<T = unknown>(): T | null;
}

export interface GraphApiErrorInit {
  code: DomainErrorCode;
  reasonCode: string;
  safeMessage: string;
  status: number | null;
  graphCode?: string | null;
  retryable: boolean;
  /** `true` if the HTTPS request entered the wire stage (ambiguous for non-idempotent mutations like `sendMail`). */
  requestSent: boolean;
  /** Bounded `Retry-After` delay in seconds parsed from `429` / `503` Graph or upload-session responses (`1..300`, else `null`). */
  retryAfterSeconds?: number | null;
  aborted?: boolean;
}

export class GraphApiError extends DomainError {
  readonly status: number | null;
  readonly graphCode: string | null;
  readonly retryable: boolean;
  readonly requestSent: boolean;
  readonly retryAfterSeconds: number | null;
  /** Alias matching `graphDriveGraph.ts` error-classifier inspection (`e.reason`). */
  readonly reason: string;

  constructor(init: GraphApiErrorInit) {
    super(init.code, init.reasonCode, init.safeMessage);
    this.name = init.aborted ? "AbortError" : "GraphApiError";
    this.status = init.status;
    this.graphCode = init.graphCode ?? null;
    this.retryable = init.retryable;
    this.requestSent = init.requestSent;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
    this.reason = init.reasonCode;
  }
}

export interface GraphClient {
  isConfigured(): Promise<boolean>;
  request<T = unknown>(input: GraphRequestInput): Promise<GraphResponse<T>>;
  /**
   * Uploads one byte range to a Graph resumable upload-session URL through `egress` purpose `"graph_upload"`:
   *  - Enforces HTTPS + port 443 + host suffix lineage (`*.sharepoint.com` / `*.files.1drv.com`),
   *  - NEVER forwards the Graph `Authorization: Bearer` header or cookies,
   *  - NEVER logs or exposes the pre-authenticated `uploadUrl`.
   */
  uploadChunk(input: GraphUploadChunkInput): Promise<GraphUploadChunkResult>;
  /** Queries (`GET`) or cancels (`DELETE`) a Graph upload session under the same `graph_upload` guardrails. */
  uploadSessionControl(input: GraphUploadSessionControlInput): Promise<GraphUploadChunkResult>;
}

export interface GraphConfigView {
  enabled: boolean;
  configured: boolean;
  verified: boolean;
  state: ProviderState;
  summary: string;
  tenantId: string;
  clientId: string;
  clientSecretConfigured: boolean;
  clientSecretLast4: string | null;
  senderMailbox: string;
  egressPresetEnabled: boolean;
  uploadEgressPresetEnabled?: boolean;
  egressReady: boolean;
  lastCheckedAt: Date | null;
  lastOutcome: "succeeded" | "failed" | "unknown" | null;
  sitesSelectedLastCheckedAt?: Date | null;
  sitesSelectedLastOutcome?: "succeeded" | "failed" | "unknown" | null;
  mailboxRestrictionNote: string;
}

export interface UpdateGraphConfigInput {
  enabled: boolean;
  tenantId: string;
  clientId: string;
  /** Omit or `undefined` to keep existing secret; `null` to clear; non-empty string to replace. */
  clientSecret?: string | null;
  senderMailbox?: string;
  /** Optional convenience toggle for the `"microsoft_graph"` egress preset in the same step-up write. */
  enableEgressPreset?: boolean;
}

export interface GraphConnectionTestResult {
  outcome: "succeeded" | "failed";
  reasonCode: string;
  safeMessage: string;
  durationMs: number;
  checkedAt: Date;
}

export interface GraphMailTestResult {
  outcome: "accepted" | "rejected" | "unknown";
  reasonCode: string;
  safeMessage: string;
  recipientAddress: string;
  durationMs: number;
  checkedAt: Date;
}

export interface GraphReadiness {
  enabled: boolean;
  configured: boolean;
  verified: boolean;
  ready: boolean;
  state: ProviderState;
  summary: string;
}

export interface GraphSitesSelectedWriteCheckInput {
  /** SharePoint site Graph ID (e.g. `contoso.sharepoint.com,guid,guid`) or HTTPS site URL. */
  siteUrlOrId?: string;
  /** Optional drive Graph ID; when omitted, resolves the site's default document library (`GET /sites/{id}/drive`). */
  driveId?: string;
  /** Optional relative probe folder inside the library (defaults to `.readypackets-probe`). */
  probeFolderPath?: string;
  /** Optional explicit credentials when verifying a scoped storage connection's Entra app rather than platform Graph config. */
  credentials?: GraphCredentialsInput;
}

export interface GraphSitesSelectedWriteCheckResult {
  outcome: "succeeded" | "failed";
  reasonCode: string;
  safeMessage: string;
  graphEgressEnabled: boolean;
  uploadEgressEnabled: boolean;
  tokenAcquired: boolean;
  readVerified: boolean;
  writeVerified: boolean;
  durationMs: number;
  checkedAt: Date;
}

export interface GraphEntraRunbookView {
  requiredApplicationPermission: "Sites.Selected";
  discouragedBroadPermissions: readonly string[];
  steps: readonly string[];
  siteGrantEndpointTemplate: string;
  siteGrantPayloadExample: string;
  powershellExample: string;
  oneDriveNote: string;
}

export interface GraphAdminService {
  getReadiness(): Promise<GraphReadiness>;
  getConfig(): Promise<GraphConfigView>;
  updateConfig(principal: SessionPrincipal, input: UpdateGraphConfigInput): Promise<GraphConfigView>;
  testConnection(principal: SessionPrincipal): Promise<GraphConnectionTestResult>;
  sendTestMessage(principal: SessionPrincipal, input?: { toAddress?: string }): Promise<GraphMailTestResult>;
  verifySitesSelectedWrite(
    principal: SessionPrincipal,
    input?: GraphSitesSelectedWriteCheckInput,
  ): Promise<GraphSitesSelectedWriteCheckResult>;
  getEntraRunbook(): GraphEntraRunbookView;
}
