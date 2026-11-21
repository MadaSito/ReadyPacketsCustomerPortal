/**
 * Increment 04 (package D): session restrictions (parsed policy + admission decisions) and the sign-in log
 * writer. Pure helpers are exported for unit tests. No outside lookups: the country comes from the protection
 * module's offline resolver (`clientCountry()`), the address from the trusted request context.
 */
import { eq } from "drizzle-orm";
import { isIP } from "node:net";
import type { ModuleDeps } from "../../container.js";
import { getRequestContext } from "../../core/requestContext.js";
import { ulid } from "../../core/ids.js";
import type { DbOrTx, Tx } from "../../core/types.js";
import type { AuthMethod, UserRole } from "../../../shared/domain.js";
import { sessionRestrictions, signInEvents, type SessionRestrictionsRow, type SignInEventKind } from "./schema.js";

/* ------------------------------------------------------------------ addresses */

export interface ParsedIp {
  family: 4 | 6;
  value: bigint;
  normalized: string;
}
export interface ParsedCidr {
  family: 4 | 6;
  network: bigint;
  prefix: number;
  normalized: string;
}

function v4ToBig(text: string): bigint | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

function v6ToBig(text: string): bigint | null {
  if (isIP(text) !== 6 || text.includes("%")) return null;
  let head = text;
  let tailV4: bigint | null = null;
  const lastColon = text.lastIndexOf(":");
  if (text.slice(lastColon + 1).includes(".")) {
    tailV4 = v4ToBig(text.slice(lastColon + 1));
    if (tailV4 === null) return null;
    head = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const [left, right] = head.split("::") as [string, string | undefined];
  const l = left ? left.split(":") : [];
  const r = right !== undefined && right !== "" ? right.split(":") : [];
  const groups = right === undefined ? l : [...l, ...Array<string>(8 - l.length - r.length).fill("0"), ...r];
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) value = (value << 16n) | BigInt(parseInt(group || "0", 16));
  if (tailV4 !== null) value = (value & ~0xffffffffn) | tailV4;
  return value;
}

function formatV6(value: bigint): string {
  const groups = Array.from({ length: 8 }, (_, i) => Number((value >> BigInt((7 - i) * 16)) & 0xffffn).toString(16));
  // Compress the longest run of zero groups (RFC 5952).
  let best = -1, bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== "0") { i += 1; continue; }
    let j = i;
    while (j < 8 && groups[j] === "0") j += 1;
    if (j - i > bestLen && j - i > 1) { best = i; bestLen = j - i; }
    i = j;
  }
  if (best < 0) return groups.join(":");
  return `${groups.slice(0, best).join(":")}::${groups.slice(best + bestLen).join(":")}`;
}

/** Canonical IPv4 / IPv6; IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is treated as IPv4. */
export function parseIp(raw: string | null | undefined): ParsedIp | null {
  if (!raw || raw.length > 64) return null;
  const text = raw.trim().replace(/^\[|\]$/g, "");
  const v4 = v4ToBig(text);
  if (v4 !== null) return { family: 4, value: v4, normalized: text };
  const v6 = v6ToBig(text.toLowerCase());
  if (v6 === null) return null;
  if (v6 >> 32n === 0xffffn) {
    const n = v6 & 0xffffffffn;
    return { family: 4, value: n, normalized: [24n, 16n, 8n, 0n].map((s) => String((n >> s) & 255n)).join(".") };
  }
  return { family: 6, value: v6, normalized: formatV6(v6) };
}

/** `a.b.c.d/8..32`, `ipv6/16..128`, or a bare address (host route). Host bits must be zero. */
export function parseCidr(raw: string): ParsedCidr | null {
  const [addr, prefixText, extra] = raw.trim().split("/");
  if (extra !== undefined || !addr) return null;
  const ip = parseIp(addr);
  if (!ip || (addr.includes(":") && ip.family === 4)) return null;
  const bits = ip.family === 4 ? 32 : 128;
  if (prefixText !== undefined && !/^(?:0|[1-9]\d{0,2})$/.test(prefixText)) return null;
  const prefix = prefixText === undefined ? bits : Number(prefixText);
  if (prefix < (ip.family === 4 ? 8 : 16) || prefix > bits) return null;
  const shift = BigInt(bits - prefix);
  if ((ip.value >> shift) << shift !== ip.value) return null;
  return { family: ip.family, network: ip.value, prefix, normalized: `${ip.normalized}/${prefix}` };
}

export function ipInCidrs(ip: ParsedIp | null, cidrs: readonly ParsedCidr[]): boolean {
  if (!ip) return false;
  return cidrs.some((c) => {
    if (c.family !== ip.family) return false;
    const shift = BigInt((c.family === 4 ? 32 : 128) - c.prefix);
    return ip.value >> shift === c.network >> shift;
  });
}

/* ------------------------------------------------------------------ restrictions */

export interface Restrictions {
  enabled: boolean;
  maxConcurrentPerUser: number | null;
  idleMinutes: Record<UserRole, number | null>;
  absoluteHours: Record<UserRole, number | null>;
  consoleIpAllowList: string[];
  countryMode: "off" | "allow" | "deny";
  countryScope: "all" | "customers" | "console";
  countries: string[];
  allowUnknownCountry: boolean;
  version: number;
  updatedAt: Date | null;
}

export const DEFAULT_RESTRICTIONS: Restrictions = {
  enabled: false,
  maxConcurrentPerUser: null,
  idleMinutes: { customer: null, staff: null, admin: null },
  absoluteHours: { customer: null, staff: null, admin: null },
  consoleIpAllowList: [],
  countryMode: "off",
  countryScope: "all",
  countries: [],
  allowUnknownCountry: true,
  version: 1,
  updatedAt: null,
};

function listOf(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string").slice(0, 100) : [];
  } catch {
    return [];
  }
}

export function restrictionsFromRow(row: SessionRestrictionsRow | undefined): Restrictions {
  if (!row) return DEFAULT_RESTRICTIONS;
  return {
    enabled: row.enabled,
    maxConcurrentPerUser: row.maxConcurrentPerUser,
    idleMinutes: { customer: row.idleMinutesCustomer, staff: row.idleMinutesStaff, admin: row.idleMinutesAdmin },
    absoluteHours: { customer: row.absoluteHoursCustomer, staff: row.absoluteHoursStaff, admin: row.absoluteHoursAdmin },
    consoleIpAllowList: listOf(row.consoleIpAllowList),
    countryMode: row.countryMode,
    countryScope: row.countryScope,
    countries: (row.countries ?? "").split(",").filter((c) => /^[A-Z]{2}$/.test(c)),
    allowUnknownCountry: row.allowUnknownCountry,
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

export type RestrictionRefusal = "RESTRICTION_IP" | "RESTRICTION_COUNTRY";

/**
 * Admission decision for (role, address, country). Disabled restrictions or the host break-glass switch admit
 * everything. Console = staff + admin. An unknown address is refused when a console allow-list applies.
 */
export function admission(r: Restrictions, role: UserRole, ip: string | null, country: string | null, breakGlass = false): RestrictionRefusal | null {
  if (!r.enabled || breakGlass) return null;
  const console = role !== "customer";
  if (console && r.consoleIpAllowList.length > 0) {
    const cidrs = r.consoleIpAllowList.map(parseCidr).filter((c): c is ParsedCidr => c !== null);
    if (!ipInCidrs(parseIp(ip), cidrs)) return "RESTRICTION_IP";
  }
  if (r.countryMode !== "off") {
    const inScope = r.countryScope === "all" || (r.countryScope === "console") === console;
    if (inScope) {
      if (country === null) {
        if (!r.allowUnknownCountry) return "RESTRICTION_COUNTRY";
      } else {
        const listed = r.countries.includes(country);
        if (r.countryMode === "allow" ? !listed : listed) return "RESTRICTION_COUNTRY";
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ request facts */

export interface RequestFacts {
  ip: string | null;
  country: string | null;
}

export function createSessionPolicy(deps: ModuleDeps) {
  const CACHE_MS = 5_000;
  let cache: { at: number; value: Restrictions } | null = null;

  /** Current request address (trusted-proxy normalised) and country (protection, offline). Never throws. */
  function requestFacts(): RequestFacts {
    const ip = parseIp(getRequestContext()?.ipAddress)?.normalized ?? null;
    let country: string | null = null;
    try {
      const protection = (deps.services as unknown as { protection?: { clientCountry?: () => string | null } }).protection;
      const value = protection?.clientCountry?.() ?? null;
      country = typeof value === "string" && /^[A-Z]{2}$/.test(value) ? value : null;
    } catch {
      country = null;
    }
    return { ip, country };
  }

  return {
    requestFacts,

    /** Inside a transaction: authoritative read through that connection. Outside: ≤ 5 s cache per process. */
    async load(tx?: DbOrTx, opts: { forUpdate?: boolean } = {}): Promise<Restrictions> {
      if (!tx) {
        const now = deps.clock.now().getTime();
        if (cache && now - cache.at >= 0 && now - cache.at < CACHE_MS) return cache.value;
        const [row] = await deps.db.select().from(sessionRestrictions).where(eq(sessionRestrictions.id, 1)).limit(1);
        const value = restrictionsFromRow(row);
        cache = { at: now, value };
        return value;
      }
      const query = tx.select().from(sessionRestrictions).where(eq(sessionRestrictions.id, 1)).limit(1);
      const rows = opts.forUpdate ? await (query as unknown as { for(m: "update"): Promise<SessionRestrictionsRow[]> }).for("update") : await query;
      return restrictionsFromRow(rows[0]);
    },

    invalidate(): void {
      cache = null;
    },

    breakGlass(): boolean {
      return deps.config.protectionDisabled === true;
    },
  };
}
export type SessionPolicy = ReturnType<typeof createSessionPolicy>;

/* ------------------------------------------------------------------ sign-in log */

export interface SignInEventInput {
  kind: SignInEventKind;
  reasonCode?: string | null;
  userId?: number | null;
  role?: UserRole | null;
  authMethod?: AuthMethod | null;
  sessionPublicId?: string | null;
  actorUserId?: number | null;
  deviceSummary?: string | null;
  /** Defaults to the current request's facts; pass explicitly for rows about other sessions (forced ends). */
  facts?: RequestFacts;
}

export const SIGN_IN_IP_PURPOSE = "identity.sign_in_events.ip";

export function createSignInLog(deps: ModuleDeps, policy: SessionPolicy) {
  function row(input: SignInEventInput) {
    const now = deps.clock.now();
    const publicId = ulid(now.getTime());
    const facts = input.facts ?? policy.requestFacts();
    const requestId = getRequestContext()?.requestId ?? null;
    return {
      publicId,
      occurredAt: now,
      kind: input.kind,
      reasonCode: input.reasonCode?.slice(0, 40) ?? null,
      userId: input.userId ?? null,
      role: input.role ?? null,
      authMethod: input.authMethod ?? null,
      sessionPublicId: input.sessionPublicId ?? null,
      ipAddressEnc: facts.ip ? deps.crypto.encrypt(facts.ip, `identity_sign_in_events.ip:${publicId}`) : null,
      ipIndex: facts.ip ? deps.crypto.blindIndex(facts.ip, SIGN_IN_IP_PURPOSE) : null,
      country: facts.country,
      deviceSummary: input.deviceSummary?.slice(0, 80) ?? null,
      actorUserId: input.actorUserId ?? null,
      requestId: requestId && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(requestId) ? requestId : null,
    };
  }

  return {
    /** Inside a transaction: part of it (fails with it). */
    async record(input: SignInEventInput, tx: Tx): Promise<void> {
      await tx.insert(signInEvents).values(row(input));
    },
    async recordMany(inputs: SignInEventInput[], tx: Tx): Promise<void> {
      for (let i = 0; i < inputs.length; i += 500) await tx.insert(signInEvents).values(inputs.slice(i, i + 500).map(row));
    },
    /** Outside any transaction (failures, refusals after rollback, expiry). Best effort; never throws. */
    async note(input: SignInEventInput): Promise<void> {
      try {
        await deps.db.insert(signInEvents).values(row(input));
      } catch (error) {
        deps.logger.warn("identity.sign_in_log.write_failed", { errorName: error instanceof Error ? error.name : "unknown", kind: input.kind });
      }
    },
  };
}
export type SignInLog = ReturnType<typeof createSignInLog>;
