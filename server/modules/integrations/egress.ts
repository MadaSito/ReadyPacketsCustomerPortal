/**
 * Outbound Egress & SSRF Policy (`services.integrations.egress`).
 *
 * Enforces:
 *  - Purpose-specific default schemes and ports
 *  - URL credential (`user:pass@host`) rejection
 *  - Hostname & numeric IPv4/IPv6 pre-validation (decimal/octal/hex/shorthand tricks, special TLDs, zone IDs)
 *  - Full A/AAAA DNS resolution with validation of EVERY returned address (mixed public + private refused)
 *  - Explicit step-up-protected administrator allowlist (`integration_egress_allowlist`) for legitimate
 *    private SIEM/SMTP destinations or custom ports — while unconditionally blocking cloud metadata,
 *    link-local, multicast, broadcast, unspecified, and production loopback addresses
 *  - Pinned IP address + TLS SNI `servername` return value to prevent DNS rebinding
 *  - `fetchPinned` HTTPS helper with pinned `lookup`, TLS >= 1.2, strict cert validation, streaming size bound,
 *    and automatic redirect refusal (`3xx` rejected)
 */
import dns from "node:dns/promises";
import https from "node:https";
import { and, asc, eq } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import { DomainError, conflict, notFound, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { SessionPrincipal } from "../../core/types.js";
import { assertIntegrationsManageInTx, assertIntegrationsManagePreflight } from "./authz.js";
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

export const EGRESS_PURPOSES = ["siem", "smtp", "webhook", "sharepoint", "stripe", "antivirus"] as const;
export type EgressPurpose = (typeof EGRESS_PURPOSES)[number];

export const EGRESS_PROTOCOLS = ["https:", "tls:", "smtp:", "smtps:"] as const;
export type EgressProtocol = (typeof EGRESS_PROTOCOLS)[number];

export type EgressMatchType = "host" | "ip" | "cidr";

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
  servername?: string;
  normalizedUrl?: string;
  allowlistRulePublicId?: string;
}

export interface ResolveEgressInput {
  url: string;
  purpose: EgressPurpose;
  allowedSchemes?: readonly string[];
  allowApprovedPrivate?: boolean;
}

export interface EgressFetchOptions {
  method?: "GET" | "HEAD" | "POST" | "PUT";
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
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
  options: Required<Pick<EgressFetchOptions, "method" | "timeoutMs" | "maxResponseBytes">> &
    Pick<EgressFetchOptions, "headers" | "body" | "signal">,
) => Promise<EgressFetchResponse>;

export interface EgressPolicyOptions {
  dnsLookup?: DnsLookupFn;
  httpsRequester?: HttpsPinnedRequester;
}

export interface EgressPolicy {
  assertAllowed(target: EgressTargetInput, purpose: EgressPurpose): Promise<PinnedEgressTarget>;
  resolveAndAssertAllowed(input: ResolveEgressInput): Promise<PinnedEgressTarget>;
  fetchPinned(url: string | URL, purpose: EgressPurpose, options?: EgressFetchOptions): Promise<EgressFetchResponse>;
  listAllowlist(): Promise<EgressAllowlistRuleView[]>;
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
  antivirus: { protocols: ["https:"], ports: [443] },
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

    const bodyBuffer =
      options.body === undefined
        ? undefined
        : typeof options.body === "string"
          ? Buffer.from(options.body, "utf8")
          : Buffer.from(options.body);

    const reqHeaders: Record<string, string> = {
      Accept: "application/json, text/plain;q=0.8",
      ...options.headers,
      Host: pinned.port === 443 ? pinned.hostname : `${pinned.hostname}:${pinned.port}`,
    };
    if (bodyBuffer !== undefined && reqHeaders["Content-Length"] === undefined && reqHeaders["content-length"] === undefined) {
      reqHeaders["Content-Length"] = String(bodyBuffer.byteLength);
    }

    let settled = false;
    const finishError = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const req = https.request(
      {
        protocol: "https:",
        hostname: pinned.hostname,
        port: pinned.port,
        path: `${url.pathname}${url.search}`,
        method: options.method,
        headers: reqHeaders,
        servername: pinned.servername,
        minVersion: "TLSv1.2",
        rejectUnauthorized: true,
        agent: false,
        lookup: (_host, _opts, cb) => {
          cb(null, pinned.address, pinned.family);
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // Refuse all HTTP redirects rather than following across hosts or leaking payloads.
        if (status >= 300 && status < 400) {
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
          const headersOut: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") headersOut[k.toLowerCase()] = v;
            else if (Array.isArray(v)) headersOut[k.toLowerCase()] = v.join(", ");
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
      },
    );

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

    req.on("error", () => {
      finishError(
        new DomainError(
          "UNAVAILABLE",
          "EGRESS_CONNECTION_FAILED",
          "Connecting to the outbound provider failed.",
        ),
      );
    });

    req.on("close", () => {
      options.signal?.removeEventListener("abort", onAbort);
    });

    if (bodyBuffer !== undefined) req.write(bodyBuffer);
    req.end();
  });

function normalizeAndValidateRulePattern(matchType: EgressMatchType, rawPattern: string): string {
  const trimmed = rawPattern.trim();
  if (matchType === "host") {
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
  const requester = options.httpsRequester ?? defaultHttpsRequester;
  const isProd = deps.config.nodeEnv === "production";
  const isTest = deps.config.nodeEnv === "test";

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
          // Fail closed to an empty allowlist when foreign module tests run with partial DB schemas.
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
    extra?: { allowedSchemes?: readonly string[]; allowApprovedPrivate?: boolean },
  ): Promise<PinnedEgressTarget> {
    if (!EGRESS_PURPOSES.includes(purpose)) {
      throw validation("INVALID_EGRESS_PURPOSE", "Unknown outbound egress purpose.");
    }

    let rawHost: string;
    let protocol: EgressProtocol;
    let port: number;
    let normalizedUrl: string | undefined;

    if (typeof target === "string" || target instanceof URL) {
      const rawString = typeof target === "string" ? target.trim() : target.toString();
      if (rawString.length === 0 || rawString.length > 2048) {
        throw validation("INVALID_EGRESS_URL", "The outbound URL is empty or exceeds the maximum length.");
      }
      // Inspect raw authority BEFORE WHATWG URL normalizes octal/decimal/hex IPv4 tricks!
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

    if (extra?.allowedSchemes) {
      const normalizedAllowed = extra.allowedSchemes.map((s) => (s.endsWith(":") ? s.toLowerCase() : `${s.toLowerCase()}:`));
      if (!normalizedAllowed.includes(protocol)) {
        recordDenialNote(purpose, "EGRESS_SCHEME_FORBIDDEN");
        throw new DomainError(
          "FORBIDDEN",
          "EGRESS_SCHEME_FORBIDDEN",
          "The outbound scheme is not allowed for this operation.",
        );
      }
    }

    const hostCheck = precheckHost(rawHost);
    if (!hostCheck.ok) {
      recordDenialNote(purpose, hostCheck.reasonCode);
      throw new DomainError("FORBIDDEN", hostCheck.reasonCode, hostCheck.safeMessage);
    }

    let resolvedIps: ParsedIpAddress[];
    if (hostCheck.kind === "ip") {
      resolvedIps = [hostCheck.ip];
    } else {
      let rawRecords: readonly DnsResolvedAddress[];
      try {
        rawRecords = await lookup(hostCheck.normalizedHost);
      } catch {
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

    // 1. Unconditionally forbidden classes (cloud metadata, link-local, multicast, broadcast, unspecified, IPv4-mapped/transition)
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

    // Load explicit administrator allowlist rules for this purpose
    const rules = await loadEnabledRulesForPurpose(purpose);
    const matchingRule = findMatchingRule(rules, protocol, port, hostCheck.normalizedHost, resolvedIps);
    const siemApprovedPrivate = purpose === "siem" && extra?.allowApprovedPrivate === true;

    // 2. Validate protocol & port against default policy unless authorized by matching allowlist rule (or SIEM approved destination)
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

    // 3. Validate EVERY resolved IP (prevents round-robin mixed public + private DNS bypass)
    for (const ip of resolvedIps) {
      if (ip.classification === "LOOPBACK") {
        // Non-production only (prod already rejected above): still requires explicit private allowlist rule or SIEM approved flag
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
      });
    },

    async fetchPinned(url, purpose, fetchOptions = {}) {
      const pinned = await evaluateTarget(url, purpose, { allowedSchemes: ["https:"] });
      const parsedUrl = new URL(pinned.normalizedUrl ?? String(url));
      return requester(pinned, parsedUrl, {
        method: fetchOptions.method ?? "GET",
        headers: fetchOptions.headers,
        body: fetchOptions.body,
        timeoutMs: Math.min(Math.max(fetchOptions.timeoutMs ?? 10_000, 500), 30_000),
        maxResponseBytes: Math.min(Math.max(fetchOptions.maxResponseBytes ?? 262_144, 1024), 2 * 1024 * 1024),
        signal: fetchOptions.signal,
      });
    },

    async listAllowlist() {
      const rows = await deps.db
        .select()
        .from(integrationEgressAllowlist)
        .orderBy(asc(integrationEgressAllowlist.purpose), asc(integrationEgressAllowlist.pattern))
        .limit(200);
      return rows.map(toRuleView);
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
      const justification = input.justification.trim();
      if (justification.length < 8 || justification.length > 280) {
        throw validation("INVALID_JUSTIFICATION", "Provide a justification between 8 and 280 characters.");
      }

      const normalizedPattern = normalizeAndValidateRulePattern(input.matchType, input.pattern);
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

        // Record durable audit BEFORE deletion inside the same transaction.
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
      // Perform DNS lookup & policy evaluation BEFORE touching any transaction connection!
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
