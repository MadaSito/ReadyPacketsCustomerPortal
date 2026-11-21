/**
 * Outbound Egress & SSRF Policy (`services.integrations.egress`).
 *
 * Enforces:
 *  - Purpose-specific default schemes and ports (plus mandatory allowlist + public-only IP rules for
 *    cloud/provider purposes: `graph`, `graph_upload`, `entra_oidc`, `storage_*`)
 *  - URL credential (`user:pass@host`) rejection and bounded URL length (2 KiB default; 12 KiB for
 *    signed/encoded cloud object-storage and upload-session URLs; URLs are never logged)
 *  - Hostname & numeric IPv4/IPv6 pre-validation (decimal/octal/hex/shorthand tricks, special TLDs, zone IDs)
 *  - Full A/AAAA DNS resolution with validation of EVERY returned address (mixed public + private refused)
 *  - Explicit step-up-protected administrator allowlist (`integration_egress_allowlist`) and provider presets
 *  - Pinned IP address + TLS SNI `servername` return value to prevent DNS rebinding
 *  - `fetchPinned` HTTPS helper with pinned `lookup`, TLS >= 1.2, strict cert validation, streaming `Readable`
 *    request bodies with exact `Content-Length` enforcement (no buffering), bounded response size, and
 *    automatic redirect refusal (`3xx` rejected; Google Drive `PUT` chunk `308` permitted only behind
 *    explicit `acceptUploadIncomplete: true` with `Location` stripped)
 */
import dns from "node:dns/promises";
import https from "node:https";
import { and, asc, eq } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import { DomainError, conflict, notFound, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { SessionPrincipal } from "../../core/types.js";
import {
  assertAdminStepUpAnyInTx,
  assertAdminStepUpAnyPreflight,
  assertIntegrationsManageInTx,
  assertIntegrationsManagePreflight,
} from "./authz.js";
import {
  buildPresetView,
  EGRESS_PRESET_KEYS,
  FORBIDDEN_UPLOAD_SESSION_HEADERS,
  getPresetMeta,
  GRAPH_UPLOAD_WILDCARD_SUFFIXES,
  MANDATORY_CLOUD_ALLOWLIST_PURPOSES,
  PRESET_CATALOG,
  resolvePresetHosts,
  type EgressPresetKey,
  type EgressPresetParams,
  type EgressPresetView,
  type SetEgressPresetInput,
} from "./egressPresets.js";
import {
  isNonCanonicalIpv4Trick,
  matchIpAgainstCidr,
  parseIpAddress,
  parseSafeCidr,
  precheckHost,
  type IpAddressClass,
  type ParsedIpAddress,
} from "./ipPolicy.js";
import { integrationEgressAllowlist } from "./schema.js";

export {
  EGRESS_PRESET_KEYS,
  type EgressPresetKey,
  type EgressPresetParams,
  type EgressPresetView,
  type SetEgressPresetInput,
};

export const EGRESS_PURPOSES = [
  "siem",
  "smtp",
  "webhook",
  "sharepoint",
  "stripe",
  "square",
  "antivirus",
  "graph",
  "graph_upload",
  "entra_oidc",
  "storage_s3",
  "storage_azure",
  "storage_dropbox",
  "storage_gdrive",
] as const;
export type EgressPurpose = (typeof EGRESS_PURPOSES)[number];

export const EGRESS_PROTOCOLS = ["https:", "tls:", "smtp:", "smtps:"] as const;
export type EgressProtocol = (typeof EGRESS_PROTOCOLS)[number];

export type EgressMatchType = "host" | "ip" | "cidr";
export type EgressHttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export type EgressTargetInput =
  | string
  | URL
  | {
      host: string;
      port: number;
      protocol?: EgressProtocol;
    };

export interface PinnedEgressTarget {
  hostname: string;
  port: number;
  protocol: EgressProtocol;
  address: string;
  family: 4 | 6;
  resolvedAddresses?: readonly string[];
  servername?: string;
  normalizedUrl?: string;
  allowlistRulePublicId?: string;
}

export interface ResolveEgressInput {
  url: string;
  purpose: EgressPurpose;
  allowedSchemes?: readonly string[];
  allowApprovedPrivate?: boolean;
  requireAllowlistRule?: boolean;
  publicAddressesOnly?: boolean;
  expectedHostSuffixes?: readonly string[];
}

export interface EgressFetchOptions {
  method?: EgressHttpMethod;
  headers?: Record<string, string>;
  body?: string | Uint8Array | NodeJS.ReadableStream;
  /** Required when `body` is a `NodeJS.ReadableStream` (`bodyLength` accepted as an alias); 0..5 GiB. */
  contentLength?: number;
  bodyLength?: number;
  maxRequestBytes?: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
  requireAllowlistRule?: boolean;
  publicAddressesOnly?: boolean;
  expectedHostSuffixes?: readonly string[];
  /**
   * Permits HTTP `308 Resume Incomplete` ONLY when `purpose === "storage_gdrive"` and `method === "PUT"`.
   * Any `Location` header is stripped from the returned headers and redirects are never followed.
   */
  acceptUploadIncomplete?: boolean;
  /**
   * Optional pre-wire fence invoked AFTER DNS & allowlist resolution and immediately BEFORE `requester()`
   * opens the outbound socket. Any thrown error propagates unchanged so job-lease fences abort cleanly.
   */
  beforeSend?: () => Promise<void>;
}

export interface EgressFetchResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface EgressAllowlistRuleView {
  publicId: string;
  purpose: EgressPurpose;
  matchType: EgressMatchType;
  pattern: string;
  port: number;
  protocol: EgressProtocol;
  allowPrivateAddress: boolean;
  enabled: boolean;
  justification: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateEgressRuleInput {
  purpose: EgressPurpose;
  matchType: EgressMatchType;
  pattern: string;
  port: number;
  protocol: EgressProtocol;
  allowPrivateAddress: boolean;
  enabled?: boolean;
  justification: string;
}

export interface UpdateEgressRuleInput {
  publicId: string;
  expectedVersion: number;
  port?: number;
  allowPrivateAddress?: boolean;
  enabled?: boolean;
  justification?: string;
}

export interface DnsResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type DnsLookupFn = (hostname: string) => Promise<readonly DnsResolvedAddress[]>;
export type HttpsPinnedRequester = (
  pinned: PinnedEgressTarget,
  url: URL,
  options: {
    method: EgressHttpMethod;
    headers?: Record<string, string>;
    body?: string | Uint8Array | NodeJS.ReadableStream;
    declaredStreamLength?: number;
    timeoutMs: number;
    maxResponseBytes: number;
    signal?: AbortSignal;
    allowStatus308?: boolean;
  },
) => Promise<EgressFetchResponse>;

export interface EgressPolicyOptions {
  dnsLookup?: DnsLookupFn;
  dnsTimeoutMs?: number;
  httpsRequester?: HttpsPinnedRequester;
}

const MAX_STREAM_REQUEST_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB single-PUT object storage ceiling
const MAX_RESPONSE_BYTES_CAP = 16 * 1024 * 1024; // 16 MiB bounded metadata/list response ceiling
const EXTENDED_URL_PURPOSES: ReadonlySet<EgressPurpose> = new Set<EgressPurpose>([
  "graph_upload",
  "storage_s3",
  "storage_azure",
  "storage_dropbox",
  "storage_gdrive",
]);

function isReadableStream(value: unknown): value is NodeJS.ReadableStream {
  return (
    typeof value === "object" &&
    value !== null &&
    !(value instanceof Uint8Array) &&
    typeof (value as NodeJS.ReadableStream).pipe === "function" &&
    typeof (value as NodeJS.ReadableStream).on === "function"
  );
}

/**
 * Node `net`/`https` custom `lookup` implementation that pins socket resolution to the verified
 * `(address, family)` tuple while honoring both scalar callbacks and Node >=20 `autoSelectFamily`
 * `{ all: true }` array callbacks (`LookupAddress[]`).
 */
export function createPinnedLookup(pinned: Pick<PinnedEgressTarget, "address" | "family">) {
  return (
    _hostname: string,
    optionsOrCallback:
      | number
      | { family?: number; hints?: number; all?: boolean; verbatim?: boolean }
      | ((err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void),
    maybeCallback?: (
      err: NodeJS.ErrnoException | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void,
  ): void => {
    const cb = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
    if (!cb) return;
    const wantsAll =
      typeof optionsOrCallback === "object" &&
      optionsOrCallback !== null &&
      optionsOrCallback.all === true;
    if (wantsAll) {
      cb(null, [{ address: pinned.address, family: pinned.family }]);
    } else {
      cb(null, pinned.address, pinned.family);
    }
  };
}

export interface EgressPolicy {
  assertAllowed(target: EgressTargetInput, purpose: EgressPurpose): Promise<PinnedEgressTarget>;
  resolveAndAssertAllowed(input: ResolveEgressInput): Promise<PinnedEgressTarget>;
  fetchPinned(url: string | URL, purpose: EgressPurpose, options?: EgressFetchOptions): Promise<EgressFetchResponse>;
  listAllowlist(): Promise<EgressAllowlistRuleView[]>;
  listPresets(): Promise<EgressPresetView[]>;
  setPresetEnabled(principal: SessionPrincipal, input: SetEgressPresetInput): Promise<EgressPresetView>;
  createAllowlistRule(principal: SessionPrincipal, input: CreateEgressRuleInput): Promise<EgressAllowlistRuleView>;
  updateAllowlistRule(principal: SessionPrincipal, input: UpdateEgressRuleInput): Promise<EgressAllowlistRuleView>;
  deleteAllowlistRule(principal: SessionPrincipal, publicId: string): Promise<void>;
  checkTarget(
    principal: SessionPrincipal,
    input: { target: string; purpose: EgressPurpose },
  ): Promise<{
    allowed: boolean;
    pinned?: PinnedEgressTarget;
    reasonCode?: string;
    safeMessage: string;
  }>;
}

const DEFAULT_PURPOSE_POLICY: Record<
  EgressPurpose,
  { protocols: readonly EgressProtocol[]; ports: readonly number[] }
> = {
  webhook: { protocols: ["https:"], ports: [443] },
  sharepoint: { protocols: ["https:"], ports: [443] },
  stripe: { protocols: ["https:"], ports: [443] },
  square: { protocols: ["https:"], ports: [443] },
  antivirus: { protocols: ["https:"], ports: [443] },
  graph: { protocols: ["https:"], ports: [443] },
  graph_upload: { protocols: ["https:"], ports: [443] },
  entra_oidc: { protocols: ["https:"], ports: [443] },
  storage_s3: { protocols: ["https:"], ports: [443] },
  storage_azure: { protocols: ["https:"], ports: [443] },
  storage_dropbox: { protocols: ["https:"], ports: [443] },
  storage_gdrive: { protocols: ["https:"], ports: [443] },
  siem: { protocols: ["tls:", "https:"], ports: [6514, 443] },
  smtp: { protocols: ["smtp:", "smtps:"], ports: [587, 465] },
};

const DEFAULT_PROTOCOL_PORT: Record<EgressProtocol, number> = {
  "https:": 443,
  "tls:": 6514,
  "smtp:": 587,
  "smtps:": 465,
};

function isUnconditionallyForbiddenClass(cls: IpAddressClass): boolean {
  return (
    cls === "CLOUD_METADATA" ||
    cls === "LINK_LOCAL" ||
    cls === "MULTICAST_OR_RESERVED" ||
    cls === "BROADCAST" ||
    cls === "UNSPECIFIED" ||
    cls === "DOCUMENTATION_OR_RESERVED" ||
    cls === "IPV4_TRANSITION_ADDRESS"
  );
}

function extractRawHostFromUrlString(rawUrl: string): string | null {
  const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/.exec(rawUrl.trim());
  if (!match?.[1]) return null;
  const authority = match[1];
  if (authority.includes("@")) {
    throw new DomainError(
      "FORBIDDEN",
      "EGRESS_USERINFO_FORBIDDEN",
      "Outbound URLs must not contain embedded credentials.",
    );
  }
  if (authority.startsWith("[")) {
    const closeIdx = authority.indexOf("]");
    if (closeIdx === -1) return authority;
    return authority.slice(0, closeIdx + 1);
  }
  const colonIdx = authority.indexOf(":");
  return colonIdx === -1 ? authority : authority.slice(0, colonIdx);
}

function hostMatchesLineage(normalizedHost: string, allowedSuffixes: readonly string[]): boolean {
  for (const rawEntry of allowedSuffixes) {
    const trimmed = rawEntry.trim().toLowerCase();
    if (!trimmed) continue;
    if (trimmed.startsWith("*.")) {
      const suffix = trimmed.slice(2);
      if (suffix.length > 0 && normalizedHost.endsWith(`.${suffix}`) && normalizedHost.length > suffix.length + 1) {
        return true;
      }
      continue;
    }
    const clean = trimmed.startsWith(".") ? trimmed.slice(1) : trimmed;
    if (normalizedHost === clean || normalizedHost.endsWith(`.${clean}`)) {
      return true;
    }
  }
  return false;
}

const defaultDnsLookup: DnsLookupFn = async (hostname: string) => {
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  return results
    .filter((r): r is { address: string; family: 4 | 6 } => r.family === 4 || r.family === 6)
    .map((r) => ({ address: r.address, family: r.family }));
};

const defaultHttpsRequester: HttpsPinnedRequester = (pinned, url, options) =>
  new Promise<EgressFetchResponse>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DomainError("UNAVAILABLE", "EGRESS_ABORTED", "The outbound request was aborted."));
      return;
    }

    const streaming = isReadableStream(options.body);
    const bodyBuffer =
      options.body === undefined || streaming
        ? undefined
        : typeof options.body === "string"
          ? Buffer.from(options.body, "utf8")
          : Buffer.from(options.body as Uint8Array);

    const reqHeaders: Record<string, string> = {
      Accept: "application/json, text/plain;q=0.8",
      ...options.headers,
      Host: pinned.port === 443 ? pinned.hostname : `${pinned.hostname}:${pinned.port}`,
    };
    if (streaming && options.declaredStreamLength !== undefined) {
      if (reqHeaders["Content-Length"] === undefined && reqHeaders["content-length"] === undefined) {
        reqHeaders["Content-Length"] = String(options.declaredStreamLength);
      }
    } else if (
      bodyBuffer !== undefined &&
      reqHeaders["Content-Length"] === undefined &&
      reqHeaders["content-length"] === undefined
    ) {
      reqHeaders["Content-Length"] = String(bodyBuffer.byteLength);
    }

    let settled = false;
    let totalDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const clearDeadline = () => {
      if (totalDeadlineTimer !== undefined) {
        clearTimeout(totalDeadlineTimer);
        totalDeadlineTimer = undefined;
      }
    };
    const destroyInputStream = () => {
      const destroyFn = streaming ? (options.body as unknown as { destroy?: () => void }).destroy : undefined;
      if (typeof destroyFn === "function") {
        destroyFn.call(options.body);
      }
    };
    const finishError = (err: Error) => {
      if (settled) return;
      settled = true;
      clearDeadline();
      destroyInputStream();
      reject(err);
    };

    const reqOptions: https.RequestOptions & { autoSelectFamily?: boolean } = {
      protocol: "https:",
      hostname: pinned.hostname,
      port: pinned.port,
      family: pinned.family,
      autoSelectFamily: false,
      path: `${url.pathname}${url.search}`,
      method: options.method,
      headers: reqHeaders,
      servername: pinned.servername,
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
      agent: false,
      lookup: createPinnedLookup(pinned) as never,
    };

    const req = https.request(reqOptions, (res) => {
      const status = res.statusCode ?? 0;
      const isPermitted308 = status === 308 && options.allowStatus308 === true;
      // Refuse all HTTP redirects rather than following across hosts or leaking payloads.
      if (status >= 300 && status < 400 && !isPermitted308) {
        res.resume();
        req.destroy();
        finishError(
          new DomainError(
            "FORBIDDEN",
            "EGRESS_REDIRECT_REFUSED",
            "Outbound destination attempted an HTTP redirect, which is refused by egress policy.",
          ),
        );
        return;
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      res.on("data", (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buf.byteLength;
        if (totalBytes > options.maxResponseBytes) {
          req.destroy();
          finishError(
            new DomainError(
              "VALIDATION",
              "EGRESS_RESPONSE_TOO_LARGE",
              "The outbound destination returned a response exceeding the allowed size.",
            ),
          );
          return;
        }
        chunks.push(buf);
      });
      res.on("end", () => {
        if (settled) return;
        settled = true;
        clearDeadline();
        const headersOut: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          const lower = k.toLowerCase();
          // Never expose a redirect Location header on permitted Google Drive 308 chunk status responses.
          if (isPermitted308 && lower === "location") continue;
          if (typeof v === "string") headersOut[lower] = v;
          else if (Array.isArray(v)) headersOut[lower] = v.join(", ");
        }
        resolve({
          status,
          headers: headersOut,
          body: Buffer.concat(chunks),
        });
      });
      res.on("error", () => {
        finishError(
          new DomainError(
            "UNAVAILABLE",
            "EGRESS_STREAM_FAILED",
            "Reading the outbound provider response failed.",
          ),
        );
      });
    });

    totalDeadlineTimer = setTimeout(() => {
      req.destroy();
      finishError(
        new DomainError("UNAVAILABLE", "EGRESS_TIMEOUT", "The outbound provider request timed out."),
      );
    }, options.timeoutMs);

    req.setTimeout(options.timeoutMs, () => {
      req.destroy();
      finishError(
        new DomainError("UNAVAILABLE", "EGRESS_TIMEOUT", "The outbound provider request timed out."),
      );
    });

    const onAbort = () => {
      req.destroy();
      finishError(new DomainError("UNAVAILABLE", "EGRESS_ABORTED", "The outbound request was aborted."));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    let tlsConnected = false;
    req.on("socket", (socket) => {
      socket.once("secureConnect", () => {
        tlsConnected = true;
      });
    });

    req.on("error", (err: NodeJS.ErrnoException) => {
      const errCode = typeof err?.code === "string" ? err.code.toUpperCase() : "";
      if (!tlsConnected && (errCode.includes("CERT") || errCode.includes("TLS") || errCode.includes("SSL"))) {
        finishError(
          new DomainError(
            "FORBIDDEN",
            "EGRESS_TLS_VALIDATION_FAILED",
            "Outbound TLS certificate validation failed.",
          ),
        );
        return;
      }
      if (
        !tlsConnected &&
        (errCode === "ECONNREFUSED" || errCode === "EHOSTUNREACH" || errCode === "ENETUNREACH")
      ) {
        finishError(
          new DomainError(
            "UNAVAILABLE",
            "EGRESS_CONNECT_REFUSED",
            "The outbound provider refused the TCP connection before TLS negotiation.",
          ),
        );
        return;
      }
      finishError(
        new DomainError(
          "UNAVAILABLE",
          "EGRESS_CONNECTION_FAILED",
          "Connecting to the outbound provider failed.",
        ),
      );
    });

    req.on("close", () => {
      clearDeadline();
      options.signal?.removeEventListener("abort", onAbort);
    });

    if (streaming) {
      const stream = options.body as NodeJS.ReadableStream;
      const expectedBytes = options.declaredStreamLength ?? 0;
      let sentBytes = 0;
      stream.on("data", (chunk: Buffer | string) => {
        if (settled) return;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        sentBytes += buf.byteLength;
        if (sentBytes > expectedBytes) {
          req.destroy();
          finishError(
            new DomainError(
              "VALIDATION",
              "EGRESS_STREAM_LENGTH_MISMATCH",
              "The outbound upload stream exceeded its declared Content-Length.",
            ),
          );
          return;
        }
        if (!req.write(buf) && typeof stream.pause === "function") {
          stream.pause();
          req.once("drain", () => {
            if (!settled && typeof stream.resume === "function") stream.resume();
          });
        }
      });
      stream.on("end", () => {
        if (settled) return;
        if (sentBytes !== expectedBytes) {
          req.destroy();
          finishError(
            new DomainError(
              "VALIDATION",
              "EGRESS_STREAM_LENGTH_MISMATCH",
              "The outbound upload stream ended before matching its declared Content-Length.",
            ),
          );
          return;
        }
        req.end();
      });
      stream.on("error", () => {
        req.destroy();
        finishError(
          new DomainError(
            "UNAVAILABLE",
            "EGRESS_REQUEST_STREAM_FAILED",
            "Reading the local upload stream failed.",
          ),
        );
      });
    } else {
      if (bodyBuffer !== undefined) req.write(bodyBuffer);
      req.end();
    }
  });

function normalizeAndValidateRulePattern(
  matchType: EgressMatchType,
  rawPattern: string,
  purpose: EgressPurpose,
): string {
  const trimmed = rawPattern.trim();
  if (matchType === "host") {
    if (trimmed.startsWith("*.")) {
      const suffix = trimmed.slice(2).toLowerCase();
      if (
        purpose === "graph_upload" &&
        (GRAPH_UPLOAD_WILDCARD_SUFFIXES as readonly string[]).includes(suffix)
      ) {
        return `*.${suffix}`;
      }
      throw validation(
        "INVALID_ALLOWLIST_PATTERN",
        "Wildcard host rules are permitted only for curated Microsoft upload-session suffixes.",
      );
    }
    const check = precheckHost(trimmed);
    if (!check.ok || check.kind !== "dns") {
      throw validation(
        "INVALID_ALLOWLIST_PATTERN",
        "Host allowlist rules require a valid fully qualified domain name (not an IP literal or local suffix).",
      );
    }
    return check.normalizedHost;
  }
  if (matchType === "ip") {
    const parsed = parseIpAddress(trimmed);
    if (!parsed) {
      throw validation("INVALID_ALLOWLIST_IP", "Enter a canonical IPv4 or IPv6 address.");
    }
    if (isUnconditionallyForbiddenClass(parsed.classification)) {
      throw validation(
        "FORBIDDEN_ALLOWLIST_IP",
        "Cloud metadata, link-local, multicast, broadcast and unspecified addresses can never be allowlisted.",
      );
    }
    return parsed.normalized;
  }
  const cidr = parseSafeCidr(trimmed);
  if (!cidr) {
    throw validation(
      "INVALID_ALLOWLIST_CIDR",
      "Enter a bounded CIDR range (IPv4 /8–/32 or IPv6 /32–/128).",
    );
  }
  if (isUnconditionallyForbiddenClass(cidr.classification)) {
    throw validation(
      "FORBIDDEN_ALLOWLIST_CIDR",
      "Cloud metadata, link-local, multicast and reserved ranges can never be allowlisted.",
    );
  }
  return cidr.normalized;
}

function assertCloudPurposeRuleConstraints(
  purpose: EgressPurpose,
  protocol: EgressProtocol,
  port: number,
  allowPrivateAddress: boolean,
): void {
  if (!MANDATORY_CLOUD_ALLOWLIST_PURPOSES.has(purpose)) return;
  if (protocol !== "https:" || port !== 443 || allowPrivateAddress) {
    throw validation(
      "CLOUD_PURPOSE_REQUIRES_PUBLIC_HTTPS_443",
      "Cloud storage, Graph, and OIDC egress rules must use public HTTPS on port 443.",
    );
  }
}

function toRuleView(row: typeof integrationEgressAllowlist.$inferSelect): EgressAllowlistRuleView {
  return {
    publicId: row.publicId,
    purpose: row.purpose as EgressPurpose,
    matchType: row.matchType as EgressMatchType,
    pattern: row.pattern,
    port: row.port,
    protocol: row.protocol as EgressProtocol,
    allowPrivateAddress: row.allowPrivateAddress,
    enabled: row.enabled,
    justification: row.justification,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createEgressPolicy(deps: ModuleDeps, options: EgressPolicyOptions = {}): EgressPolicy {
  const lookup = options.dnsLookup ?? defaultDnsLookup;
  const dnsTimeoutMs = Math.min(Math.max(options.dnsTimeoutMs ?? 5_000, 100), 30_000);
  const requester = options.httpsRequester ?? defaultHttpsRequester;
  const isProd = deps.config.nodeEnv === "production";
  const isTest = deps.config.nodeEnv === "test";

  async function lookupWithDeadline(hostname: string): Promise<readonly DnsResolvedAddress[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        lookup(hostname),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new DomainError(
                "UNAVAILABLE",
                "EGRESS_DNS_TIMEOUT",
                "Resolving the outbound destination hostname timed out.",
              ),
            );
          }, dnsTimeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function loadAllRulesSafe(): Promise<EgressAllowlistRuleView[]> {
    try {
      const rows = await deps.db
        .select()
        .from(integrationEgressAllowlist)
        .orderBy(asc(integrationEgressAllowlist.purpose), asc(integrationEgressAllowlist.pattern))
        .limit(300);
      return rows.map(toRuleView);
    } catch (error) {
      if (isTest) {
        const msg = error instanceof Error ? error.message : String(error);
        const code = (error as { code?: string } | null)?.code;
        if (code === "ER_NO_SUCH_TABLE" || msg.includes("no db supplied") || msg.includes("doesn't exist")) {
          return [];
        }
      }
      throw new DomainError(
        "UNAVAILABLE",
        "EGRESS_POLICY_UNAVAILABLE",
        "Outbound egress policy rules could not be loaded.",
      );
    }
  }

  async function loadEnabledRulesForPurpose(purpose: EgressPurpose): Promise<EgressAllowlistRuleView[]> {
    try {
      const rows = await deps.db
        .select()
        .from(integrationEgressAllowlist)
        .where(
          and(
            eq(integrationEgressAllowlist.purpose, purpose),
            eq(integrationEgressAllowlist.enabled, true),
          ),
        )
        .limit(200);
      return rows.map(toRuleView);
    } catch (error) {
      if (isTest) {
        const msg = error instanceof Error ? error.message : String(error);
        const code = (error as { code?: string } | null)?.code;
        if (code === "ER_NO_SUCH_TABLE" || msg.includes("no db supplied") || msg.includes("doesn't exist")) {
          return [];
        }
      }
      throw new DomainError(
        "UNAVAILABLE",
        "EGRESS_POLICY_UNAVAILABLE",
        "Outbound egress policy rules could not be loaded.",
      );
    }
  }

  function findMatchingRule(
    purpose: EgressPurpose,
    rules: readonly EgressAllowlistRuleView[],
    protocol: EgressProtocol,
    port: number,
    normalizedHost: string,
    resolvedIps: readonly ParsedIpAddress[],
  ): EgressAllowlistRuleView | undefined {
    for (const rule of rules) {
      if (rule.protocol !== protocol || rule.port !== port) continue;
      if (rule.matchType === "host") {
        if (rule.pattern === normalizedHost) return rule;
        if (purpose === "graph_upload" && rule.pattern.startsWith("*.")) {
          const suffix = rule.pattern.slice(2);
          if (
            (GRAPH_UPLOAD_WILDCARD_SUFFIXES as readonly string[]).includes(suffix) &&
            normalizedHost.endsWith(`.${suffix}`) &&
            normalizedHost.length > suffix.length + 1
          ) {
            return rule;
          }
        }
      } else if (rule.matchType === "ip") {
        if (resolvedIps.length > 0 && resolvedIps.every((ip) => ip.normalized === rule.pattern)) {
          return rule;
        }
      } else if (rule.matchType === "cidr") {
        const cidr = parseSafeCidr(rule.pattern);
        if (cidr && resolvedIps.length > 0 && resolvedIps.every((ip) => matchIpAgainstCidr(ip, cidr))) {
          return rule;
        }
      }
    }
    return undefined;
  }

  function recordDenialNote(purpose: EgressPurpose, reasonCode: string): void {
    deps.audit.note({
      category: "security",
      eventName: "integration.egress.denied",
      action: "validate_egress",
      outcome: "denied",
      severity: "WARN",
      reasonCode,
      resource: { type: "egress_policy" },
      attributes: { purpose },
    });
  }

  async function evaluateTarget(
    target: EgressTargetInput,
    purpose: EgressPurpose,
    extra?: {
      allowedSchemes?: readonly string[];
      allowApprovedPrivate?: boolean;
      requireAllowlistRule?: boolean;
      publicAddressesOnly?: boolean;
      expectedHostSuffixes?: readonly string[];
    },
  ): Promise<PinnedEgressTarget> {
    if (!EGRESS_PURPOSES.includes(purpose)) {
      throw validation("INVALID_EGRESS_PURPOSE", "Unknown outbound egress purpose.");
    }

    const mandatoryCloud = MANDATORY_CLOUD_ALLOWLIST_PURPOSES.has(purpose);
    const effectiveRequireAllowlist = mandatoryCloud || extra?.requireAllowlistRule === true;
    const effectivePublicOnly = mandatoryCloud || extra?.publicAddressesOnly === true;
    const maxUrlChars = EXTENDED_URL_PURPOSES.has(purpose) ? 12_288 : 2_048;

    let rawHost: string;
    let protocol: EgressProtocol;
    let port: number;
    let normalizedUrl: string | undefined;

    if (typeof target === "string" || target instanceof URL) {
      const rawString = typeof target === "string" ? target.trim() : target.toString();
      if (rawString.length === 0 || rawString.length > maxUrlChars) {
        throw validation("INVALID_EGRESS_URL", "The outbound URL is empty or exceeds the maximum length.");
      }
      const extractedHost = extractRawHostFromUrlString(rawString);
      if (extractedHost !== null && isNonCanonicalIpv4Trick(extractedHost)) {
        recordDenialNote(purpose, "NON_CANONICAL_IP_HOST");
        throw new DomainError(
          "FORBIDDEN",
          "NON_CANONICAL_IP_HOST",
          "Non-canonical numeric IP representations (decimal, octal, hex or shorthand) are not permitted.",
        );
      }
      if (extractedHost !== null && extractedHost.includes("%")) {
        recordDenialNote(purpose, "INVALID_IPV6_HOST");
        throw new DomainError("FORBIDDEN", "INVALID_IPV6_HOST", "IPv6 zone identifiers are not permitted.");
      }

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(rawString);
      } catch {
        throw validation("INVALID_EGRESS_URL", "The outbound URL is malformed.");
      }

      if (parsedUrl.username !== "" || parsedUrl.password !== "") {
        recordDenialNote(purpose, "EGRESS_USERINFO_FORBIDDEN");
        throw new DomainError(
          "FORBIDDEN",
          "EGRESS_USERINFO_FORBIDDEN",
          "Outbound URLs must not contain embedded credentials.",
        );
      }

      if (!EGRESS_PROTOCOLS.includes(parsedUrl.protocol as EgressProtocol)) {
        recordDenialNote(purpose, "EGRESS_SCHEME_FORBIDDEN");
        throw new DomainError(
          "FORBIDDEN",
          "EGRESS_SCHEME_FORBIDDEN",
          "The outbound URL scheme is not permitted.",
        );
      }
      protocol = parsedUrl.protocol as EgressProtocol;

      if (parsedUrl.port !== "") {
        const parsedPort = Number(parsedUrl.port);
        if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
          throw validation("INVALID_EGRESS_PORT", "The outbound port is out of range.");
        }
        port = parsedPort;
      } else {
        port = DEFAULT_PROTOCOL_PORT[protocol];
      }
      rawHost = parsedUrl.hostname;
      normalizedUrl = parsedUrl.toString();
    } else {
      rawHost = target.host;
      protocol = target.protocol ?? DEFAULT_PURPOSE_POLICY[purpose].protocols[0]!;
      if (!EGRESS_PROTOCOLS.includes(protocol)) {
        recordDenialNote(purpose, "EGRESS_SCHEME_FORBIDDEN");
        throw new DomainError(
          "FORBIDDEN",
          "EGRESS_SCHEME_FORBIDDEN",
          "The outbound protocol is not permitted.",
        );
      }
      if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
        throw validation("INVALID_EGRESS_PORT", "The outbound port must be between 1 and 65535.");
      }
      port = target.port;
    }

    const effectiveSchemes = mandatoryCloud ? ["https:"] : extra?.allowedSchemes;
    if (effectiveSchemes) {
      const normalizedAllowed = effectiveSchemes.map((s) =>
        s.endsWith(":") ? s.toLowerCase() : `${s.toLowerCase()}:`,
      );
      if (!normalizedAllowed.includes(protocol)) {
        recordDenialNote(purpose, "EGRESS_SCHEME_FORBIDDEN");
        throw new DomainError(
          "FORBIDDEN",
          "EGRESS_SCHEME_FORBIDDEN",
          "The outbound scheme is not allowed for this operation.",
        );
      }
    }
    if (mandatoryCloud && port !== 443) {
      recordDenialNote(purpose, "EGRESS_PORT_FORBIDDEN");
      throw new DomainError(
        "FORBIDDEN",
        "EGRESS_PORT_FORBIDDEN",
        "Cloud provider egress is permitted only over HTTPS port 443.",
      );
    }

    const hostCheck = precheckHost(rawHost);
    if (!hostCheck.ok) {
      recordDenialNote(purpose, hostCheck.reasonCode);
      throw new DomainError("FORBIDDEN", hostCheck.reasonCode, hostCheck.safeMessage);
    }
    if (mandatoryCloud && hostCheck.kind !== "dns") {
      recordDenialNote(purpose, "EGRESS_IP_LITERAL_FORBIDDEN");
      throw new DomainError(
        "FORBIDDEN",
        "EGRESS_IP_LITERAL_FORBIDDEN",
        "Cloud provider destinations require a verified DNS hostname.",
      );
    }
    if (
      extra?.expectedHostSuffixes &&
      extra.expectedHostSuffixes.length > 0 &&
      !hostMatchesLineage(hostCheck.normalizedHost, extra.expectedHostSuffixes)
    ) {
      recordDenialNote(purpose, "EGRESS_HOST_LINEAGE_MISMATCH");
      throw new DomainError(
        "FORBIDDEN",
        "EGRESS_HOST_LINEAGE_MISMATCH",
        "Outbound destination host is outside the permitted provider host lineage.",
      );
    }

    let resolvedIps: ParsedIpAddress[];
    if (hostCheck.kind === "ip") {
      resolvedIps = [hostCheck.ip];
    } else {
      let rawRecords: readonly DnsResolvedAddress[];
      try {
        rawRecords = await lookupWithDeadline(hostCheck.normalizedHost);
      } catch (err) {
        if (err instanceof DomainError) throw err;
        throw new DomainError(
          "UNAVAILABLE",
          "EGRESS_DNS_RESOLUTION_FAILED",
          "The outbound destination hostname could not be resolved.",
        );
      }
      if (rawRecords.length === 0) {
        throw new DomainError(
          "UNAVAILABLE",
          "EGRESS_DNS_RESOLUTION_FAILED",
          "The outbound destination hostname returned no addresses.",
        );
      }
      resolvedIps = [];
      for (const rec of rawRecords) {
        const parsed = parseIpAddress(rec.address);
        if (!parsed) {
          recordDenialNote(purpose, "EGRESS_INVALID_RESOLVED_IP");
          throw new DomainError(
            "FORBIDDEN",
            "EGRESS_INVALID_RESOLVED_IP",
            "DNS resolution returned an invalid address.",
          );
        }
        resolvedIps.push(parsed);
      }
    }

    for (const ip of resolvedIps) {
      if (isUnconditionallyForbiddenClass(ip.classification)) {
        const reason =
          ip.classification === "CLOUD_METADATA"
            ? "EGRESS_METADATA_BLOCKED"
            : `EGRESS_${ip.classification}_BLOCKED`;
        recordDenialNote(purpose, reason);
        throw new DomainError(
          "FORBIDDEN",
          reason,
          "Outbound connections to cloud metadata, link-local, multicast or special-purpose addresses are forbidden.",
        );
      }
      if (ip.classification === "LOOPBACK" && isProd) {
        recordDenialNote(purpose, "EGRESS_LOOPBACK_BLOCKED");
        throw new DomainError(
          "FORBIDDEN",
          "EGRESS_LOOPBACK_BLOCKED",
          "Outbound connections to loopback addresses are forbidden.",
        );
      }
    }

    const rules = await loadEnabledRulesForPurpose(purpose);
    const matchingRule = findMatchingRule(purpose, rules, protocol, port, hostCheck.normalizedHost, resolvedIps);
    if (effectiveRequireAllowlist && !matchingRule) {
      recordDenialNote(purpose, "EGRESS_ALLOWLIST_REQUIRED");
      throw new DomainError(
        "FORBIDDEN",
        "EGRESS_ALLOWLIST_REQUIRED",
        "Outbound destination must match an enabled administrator egress allowlist rule.",
      );
    }
    const siemApprovedPrivate = purpose === "siem" && extra?.allowApprovedPrivate === true;

    const defaultPolicy = DEFAULT_PURPOSE_POLICY[purpose];
    if (!defaultPolicy.protocols.includes(protocol) && !matchingRule) {
      recordDenialNote(purpose, "EGRESS_SCHEME_FORBIDDEN");
      throw new DomainError(
        "FORBIDDEN",
        "EGRESS_SCHEME_FORBIDDEN",
        "The outbound protocol is not permitted for this integration.",
      );
    }
    if (!defaultPolicy.ports.includes(port) && !matchingRule && !siemApprovedPrivate) {
      recordDenialNote(purpose, "EGRESS_PORT_FORBIDDEN");
      throw new DomainError(
        "FORBIDDEN",
        "EGRESS_PORT_FORBIDDEN",
        "The outbound port is not permitted unless explicitly allowlisted by an administrator.",
      );
    }

    for (const ip of resolvedIps) {
      if (effectivePublicOnly && ip.classification !== "PUBLIC") {
        recordDenialNote(purpose, "EGRESS_NON_PUBLIC_ADDRESS_BLOCKED");
        throw new DomainError(
          "FORBIDDEN",
          "EGRESS_NON_PUBLIC_ADDRESS_BLOCKED",
          "Outbound destination must resolve exclusively to public routable addresses.",
        );
      }
      if (ip.classification === "LOOPBACK") {
        const allowedLoopback = Boolean((matchingRule && matchingRule.allowPrivateAddress) || siemApprovedPrivate);
        if (!allowedLoopback) {
          recordDenialNote(purpose, "EGRESS_LOOPBACK_BLOCKED");
          throw new DomainError(
            "FORBIDDEN",
            "EGRESS_LOOPBACK_BLOCKED",
            "Outbound connections to loopback addresses are forbidden.",
          );
        }
      } else if (ip.classification === "PRIVATE_NETWORK") {
        const allowedPrivate = Boolean((matchingRule && matchingRule.allowPrivateAddress) || siemApprovedPrivate);
        if (!allowedPrivate) {
          recordDenialNote(purpose, "EGRESS_PRIVATE_ADDRESS_BLOCKED");
          throw new DomainError(
            "FORBIDDEN",
            "EGRESS_PRIVATE_ADDRESS_BLOCKED",
            "Outbound connections to private network addresses require an explicit administrator egress allowlist rule.",
          );
        }
      }
    }

    const primary = resolvedIps[0]!;
    return {
      hostname: hostCheck.normalizedHost,
      port,
      protocol,
      address: primary.normalized,
      family: primary.family,
      resolvedAddresses: resolvedIps.map((ip) => ip.normalized),
      servername: hostCheck.kind === "dns" ? hostCheck.normalizedHost : undefined,
      normalizedUrl,
      allowlistRulePublicId: matchingRule?.publicId,
    };
  }

  return {
    assertAllowed(target, purpose) {
      return evaluateTarget(target, purpose);
    },

    resolveAndAssertAllowed(input) {
      return evaluateTarget(input.url, input.purpose, {
        allowedSchemes: input.allowedSchemes,
        allowApprovedPrivate: input.allowApprovedPrivate,
        requireAllowlistRule: input.requireAllowlistRule,
        publicAddressesOnly: input.publicAddressesOnly,
        expectedHostSuffixes: input.expectedHostSuffixes,
      });
    },

    async fetchPinned(url, purpose, fetchOptions = {}) {
      const method: EgressHttpMethod = fetchOptions.method ?? "GET";
      if (purpose === "graph_upload" && fetchOptions.headers) {
        for (const headerName of Object.keys(fetchOptions.headers)) {
          if (FORBIDDEN_UPLOAD_SESSION_HEADERS.has(headerName.toLowerCase())) {
            recordDenialNote(purpose, "EGRESS_FORBIDDEN_UPLOAD_HEADER");
            throw new DomainError(
              "FORBIDDEN",
              "EGRESS_FORBIDDEN_UPLOAD_HEADER",
              "Pre-authenticated upload session requests must not carry bearer or cookie credentials.",
            );
          }
        }
      }
      if (fetchOptions.acceptUploadIncomplete === true && !(purpose === "storage_gdrive" && method === "PUT")) {
        recordDenialNote(purpose, "EGRESS_REDIRECT_REFUSED");
        throw new DomainError(
          "FORBIDDEN",
          "EGRESS_REDIRECT_REFUSED",
          "HTTP 308 upload-incomplete status is permitted only on Google Drive chunk PUT requests.",
        );
      }

      const streaming = isReadableStream(fetchOptions.body);
      const maxReqBytes = Math.min(
        Math.max(fetchOptions.maxRequestBytes ?? MAX_STREAM_REQUEST_BYTES, 0),
        MAX_STREAM_REQUEST_BYTES,
      );
      let declaredStreamLength: number | undefined;
      if (streaming) {
        const rawLen = fetchOptions.contentLength ?? fetchOptions.bodyLength;
        if (typeof rawLen !== "number" || !Number.isSafeInteger(rawLen) || rawLen < 0) {
          throw validation(
            "EGRESS_STREAM_LENGTH_REQUIRED",
            "Streaming outbound uploads require a known non-negative integer contentLength.",
          );
        }
        if (rawLen > maxReqBytes) {
          throw validation(
            "EGRESS_REQUEST_TOO_LARGE",
            "The outbound upload exceeds the maximum permitted request size.",
          );
        }
        declaredStreamLength = rawLen;
      } else if (fetchOptions.body !== undefined) {
        const byteLen =
          typeof fetchOptions.body === "string"
            ? Buffer.byteLength(fetchOptions.body, "utf8")
            : (fetchOptions.body as Uint8Array).byteLength;
        if (byteLen > maxReqBytes) {
          throw validation(
            "EGRESS_REQUEST_TOO_LARGE",
            "The outbound payload exceeds the maximum permitted request size.",
          );
        }
      }

      const pinned = await evaluateTarget(url, purpose, {
        allowedSchemes: ["https:"],
        requireAllowlistRule: fetchOptions.requireAllowlistRule,
        publicAddressesOnly: fetchOptions.publicAddressesOnly,
        expectedHostSuffixes: fetchOptions.expectedHostSuffixes,
      });
      const parsedUrl = new URL(pinned.normalizedUrl ?? String(url));
      const maxTimeoutCap =
        streaming || (EXTENDED_URL_PURPOSES.has(purpose) && method === "PUT") ? 600_000 : 30_000;
      const allowStatus308 =
        fetchOptions.acceptUploadIncomplete === true && purpose === "storage_gdrive" && method === "PUT";

      if (fetchOptions.beforeSend) {
        await fetchOptions.beforeSend();
      }

      const resp = await requester(pinned, parsedUrl, {
        method,
        headers: fetchOptions.headers,
        body: fetchOptions.body,
        declaredStreamLength,
        timeoutMs: Math.min(Math.max(fetchOptions.timeoutMs ?? 10_000, 100), maxTimeoutCap),
        maxResponseBytes: Math.min(
          Math.max(fetchOptions.maxResponseBytes ?? 262_144, 1_024),
          MAX_RESPONSE_BYTES_CAP,
        ),
        signal: fetchOptions.signal,
        allowStatus308,
      });
      if (resp.status >= 300 && resp.status < 400) {
        if (resp.status === 308 && allowStatus308) {
          const cleanHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(resp.headers)) {
            if (k.toLowerCase() !== "location") cleanHeaders[k.toLowerCase()] = v;
          }
          return { status: resp.status, headers: cleanHeaders, body: resp.body };
        }
        throw new DomainError(
          "FORBIDDEN",
          "EGRESS_REDIRECT_REFUSED",
          "Outbound destination attempted an HTTP redirect, which is refused by egress policy.",
        );
      }
      return resp;
    },

    async listAllowlist() {
      return loadAllRulesSafe();
    },

    async listPresets() {
      const rules = await loadAllRulesSafe();
      return PRESET_CATALOG.map((meta) => buildPresetView(meta, rules));
    },

    async setPresetEnabled(principal, input) {
      const now = deps.clock.now();
      const meta = getPresetMeta(input.presetKey);
      assertAdminStepUpAnyPreflight(principal, now, meta.capabilities);
      const concreteHosts =
        meta.parameterized && !input.enabled && !input.params?.region && !input.params?.accountName
          ? undefined
          : resolvePresetHosts(input.presetKey, input.params);

      await deps.db.transaction(async (tx) => {
        await assertAdminStepUpAnyInTx(deps, principal, tx, meta.capabilities);

        if (!concreteHosts) {
          // Disable all existing rules belonging to this parameterized preset family.
          const existingRows = await tx
            .select()
            .from(integrationEgressAllowlist)
            .where(eq(integrationEgressAllowlist.purpose, meta.purpose))
            .for("update");
          const matchingView = buildPresetView(meta, existingRows.map(toRuleView));
          for (const row of existingRows) {
            if (matchingView.matchingRulePublicIds.includes(row.publicId) && row.enabled) {
              await tx
                .update(integrationEgressAllowlist)
                .set({
                  enabled: false,
                  updatedByUserId: principal.userId,
                  version: row.version + 1,
                  updatedAt: now,
                })
                .where(eq(integrationEgressAllowlist.id, row.id));
            }
          }
        } else {
          for (const hostPattern of concreteHosts) {
            const normalizedPattern = normalizeAndValidateRulePattern("host", hostPattern, meta.purpose);
            const [existing] = await tx
              .select()
              .from(integrationEgressAllowlist)
              .where(
                and(
                  eq(integrationEgressAllowlist.purpose, meta.purpose),
                  eq(integrationEgressAllowlist.pattern, normalizedPattern),
                  eq(integrationEgressAllowlist.port, 443),
                  eq(integrationEgressAllowlist.protocol, "https:"),
                ),
              )
              .limit(1)
              .for("update");

            if (existing) {
              if (existing.enabled !== input.enabled || existing.allowPrivateAddress) {
                await tx
                  .update(integrationEgressAllowlist)
                  .set({
                    enabled: input.enabled,
                    allowPrivateAddress: false,
                    updatedByUserId: principal.userId,
                    version: existing.version + 1,
                    updatedAt: now,
                  })
                  .where(eq(integrationEgressAllowlist.id, existing.id));
              }
            } else if (input.enabled) {
              await tx.insert(integrationEgressAllowlist).values({
                publicId: ulid(),
                purpose: meta.purpose,
                matchType: "host",
                pattern: normalizedPattern,
                port: 443,
                protocol: "https:",
                allowPrivateAddress: false,
                enabled: true,
                justification: meta.justification,
                createdByUserId: principal.userId,
                updatedByUserId: principal.userId,
                version: 1,
                createdAt: now,
                updatedAt: now,
              });
            }
          }
        }

        await deps.audit.record(
          {
            category: "integration",
            eventName: "integration.egress.preset_updated",
            action: "update",
            outcome: "completed",
            severity: "INFO",
            resource: { type: "egress_preset", publicId: meta.key },
            attributes: {
              preset: meta.key,
              purpose: meta.purpose,
              enabled: input.enabled,
              host_count: concreteHosts ? concreteHosts.length : 0,
            },
          },
          tx,
        );
      });

      const updatedRules = await loadAllRulesSafe();
      return buildPresetView(meta, updatedRules, concreteHosts);
    },

    async createAllowlistRule(principal, input) {
      const now = deps.clock.now();
      assertIntegrationsManagePreflight(principal, now);
      if (!EGRESS_PURPOSES.includes(input.purpose)) {
        throw validation("INVALID_EGRESS_PURPOSE", "Select a valid egress purpose.");
      }
      if (!EGRESS_PROTOCOLS.includes(input.protocol)) {
        throw validation("INVALID_EGRESS_PROTOCOL", "Select a valid egress protocol.");
      }
      if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
        throw validation("INVALID_EGRESS_PORT", "Port must be between 1 and 65535.");
      }
      assertCloudPurposeRuleConstraints(input.purpose, input.protocol, input.port, input.allowPrivateAddress);
      const justification = input.justification.trim();
      if (justification.length < 8 || justification.length > 280) {
        throw validation("INVALID_JUSTIFICATION", "Provide a justification between 8 and 280 characters.");
      }

      const normalizedPattern = normalizeAndValidateRulePattern(input.matchType, input.pattern, input.purpose);
      const publicId = ulid();
      const enabled = input.enabled ?? true;

      return deps.db.transaction(async (tx) => {
        await assertIntegrationsManageInTx(deps, principal, tx);
        const [duplicate] = await tx
          .select({ id: integrationEgressAllowlist.id })
          .from(integrationEgressAllowlist)
          .where(
            and(
              eq(integrationEgressAllowlist.purpose, input.purpose),
              eq(integrationEgressAllowlist.pattern, normalizedPattern),
              eq(integrationEgressAllowlist.port, input.port),
              eq(integrationEgressAllowlist.protocol, input.protocol),
            ),
          )
          .limit(1)
          .for("update");
        if (duplicate) {
          throw conflict(
            "EGRESS_RULE_EXISTS",
            "An egress allowlist rule already exists for this purpose, destination, protocol and port.",
          );
        }

        await tx.insert(integrationEgressAllowlist).values({
          publicId,
          purpose: input.purpose,
          matchType: input.matchType,
          pattern: normalizedPattern,
          port: input.port,
          protocol: input.protocol,
          allowPrivateAddress: input.allowPrivateAddress,
          enabled,
          justification,
          createdByUserId: principal.userId,
          updatedByUserId: principal.userId,
          version: 1,
          createdAt: now,
          updatedAt: now,
        });

        await deps.audit.record(
          {
            category: "integration",
            eventName: "integration.egress.rule_created",
            action: "create",
            outcome: "completed",
            severity: "INFO",
            resource: { type: "egress_rule", publicId },
            attributes: {
              purpose: input.purpose,
              match_type: input.matchType,
              port: input.port,
              protocol: input.protocol,
              allow_private: input.allowPrivateAddress,
              enabled,
            },
          },
          tx,
        );

        const [inserted] = await tx
          .select()
          .from(integrationEgressAllowlist)
          .where(eq(integrationEgressAllowlist.publicId, publicId))
          .limit(1);
        return toRuleView(inserted!);
      });
    },

    async updateAllowlistRule(principal, input) {
      const now = deps.clock.now();
      assertIntegrationsManagePreflight(principal, now);
      if (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) {
        throw validation("INVALID_EGRESS_PORT", "Port must be between 1 and 65535.");
      }
      const nextJustification = input.justification !== undefined ? input.justification.trim() : undefined;
      if (nextJustification !== undefined && (nextJustification.length < 8 || nextJustification.length > 280)) {
        throw validation("INVALID_JUSTIFICATION", "Provide a justification between 8 and 280 characters.");
      }

      return deps.db.transaction(async (tx) => {
        await assertIntegrationsManageInTx(deps, principal, tx);
        const [existing] = await tx
          .select()
          .from(integrationEgressAllowlist)
          .where(eq(integrationEgressAllowlist.publicId, input.publicId))
          .limit(1)
          .for("update");
        if (!existing) throw notFound("EGRESS_RULE_NOT_FOUND");
        if (existing.version !== input.expectedVersion) {
          throw conflict(
            "VERSION_MISMATCH",
            "This egress rule was modified by another administrator. Refresh and try again.",
          );
        }

        const nextPort = input.port ?? existing.port;
        const nextAllowPrivate = input.allowPrivateAddress ?? existing.allowPrivateAddress;
        const nextEnabled = input.enabled ?? existing.enabled;
        assertCloudPurposeRuleConstraints(
          existing.purpose as EgressPurpose,
          existing.protocol as EgressProtocol,
          nextPort,
          nextAllowPrivate,
        );

        await tx
          .update(integrationEgressAllowlist)
          .set({
            port: nextPort,
            allowPrivateAddress: nextAllowPrivate,
            enabled: nextEnabled,
            justification: nextJustification ?? existing.justification,
            updatedByUserId: principal.userId,
            version: existing.version + 1,
            updatedAt: now,
          })
          .where(eq(integrationEgressAllowlist.id, existing.id));

        await deps.audit.record(
          {
            category: "integration",
            eventName: "integration.egress.rule_updated",
            action: "update",
            outcome: "completed",
            severity: "INFO",
            resource: { type: "egress_rule", publicId: existing.publicId },
            attributes: {
              purpose: existing.purpose,
              port: nextPort,
              allow_private: nextAllowPrivate,
              enabled: nextEnabled,
            },
          },
          tx,
        );

        const [updated] = await tx
          .select()
          .from(integrationEgressAllowlist)
          .where(eq(integrationEgressAllowlist.id, existing.id))
          .limit(1);
        return toRuleView(updated!);
      });
    },

    async deleteAllowlistRule(principal, publicId) {
      const now = deps.clock.now();
      assertIntegrationsManagePreflight(principal, now);
      await deps.db.transaction(async (tx) => {
        await assertIntegrationsManageInTx(deps, principal, tx);
        const [existing] = await tx
          .select()
          .from(integrationEgressAllowlist)
          .where(eq(integrationEgressAllowlist.publicId, publicId))
          .limit(1)
          .for("update");
        if (!existing) throw notFound("EGRESS_RULE_NOT_FOUND");

        await deps.audit.record(
          {
            category: "integration",
            eventName: "integration.egress.rule_deleted",
            action: "delete",
            outcome: "completed",
            severity: "INFO",
            resource: { type: "egress_rule", publicId: existing.publicId },
            attributes: {
              purpose: existing.purpose,
              port: existing.port,
            },
          },
          tx,
        );

        await tx.delete(integrationEgressAllowlist).where(eq(integrationEgressAllowlist.id, existing.id));
      });
    },

    async checkTarget(principal, input) {
      const now = deps.clock.now();
      assertIntegrationsManagePreflight(principal, now);
      let pinned: PinnedEgressTarget | undefined;
      let domainErr: DomainError | null = null;
      try {
        pinned = await evaluateTarget(input.target, input.purpose);
      } catch (error) {
        domainErr = error instanceof DomainError ? error : null;
      }

      if (pinned) {
        await deps.audit.record({
          category: "integration",
          eventName: "integration.egress.checked",
          action: "validate",
          outcome: "completed",
          severity: "INFO",
          resource: { type: "egress_policy" },
          attributes: {
            purpose: input.purpose,
            allowed: true,
            port: pinned.port,
            protocol: pinned.protocol,
          },
        });
        return {
          allowed: true,
          pinned,
          safeMessage: `Destination permitted and pinned to ${pinned.address}:${pinned.port}.`,
        };
      }

      await deps.audit.record({
        category: "integration",
        eventName: "integration.egress.checked",
        action: "validate",
        outcome: "refused",
        severity: "INFO",
        reasonCode: domainErr?.reasonCode ?? "EGRESS_CHECK_FAILED",
        resource: { type: "egress_policy" },
        attributes: {
          purpose: input.purpose,
          allowed: false,
        },
      });
      return {
        allowed: false,
        reasonCode: domainErr?.reasonCode ?? "EGRESS_CHECK_FAILED",
        safeMessage: domainErr?.safeMessage ?? "Destination was refused by egress policy.",
      };
    },
  };
}
