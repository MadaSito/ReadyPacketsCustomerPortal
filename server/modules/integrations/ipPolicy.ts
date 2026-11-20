/**
 * Pure IPv4, IPv6, CIDR and hostname SSRF policy primitives.
 *
 * Covers:
 *  - Canonical IPv4 & IPv6 parsing (128-bit BigInt arithmetic, zero dependencies)
 *  - Rejection of decimal, octal, hex and shorthand IPv4 host tricks (`2130706433`, `0177.0.0.1`, `0x7f.0.0.1`, `127.1`)
 *  - Rejection of IPv6 zone identifiers (`%eth0`), local/special-use TLDs and metadata hostnames
 *  - Detection of embedded/transition IPv6 forms (IPv4-mapped `::ffff:0:0/96`, IPv4-compatible `::/96`,
 *    NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, Teredo `2001::/32`)
 *  - Exact classification into PUBLIC, PRIVATE_NETWORK (RFC 1918 / RFC 4193 / CGNAT), LOOPBACK, and
 *    unconditionally forbidden classes (CLOUD_METADATA, LINK_LOCAL, MULTICAST_OR_RESERVED, BROADCAST,
 *    UNSPECIFIED, DOCUMENTATION_OR_RESERVED, IPV4_TRANSITION_ADDRESS)
 */
import { domainToASCII } from "node:url";

export type IpAddressClass =
  | "PUBLIC"
  | "PRIVATE_NETWORK"
  | "LOOPBACK"
  | "CLOUD_METADATA"
  | "LINK_LOCAL"
  | "MULTICAST_OR_RESERVED"
  | "BROADCAST"
  | "UNSPECIFIED"
  | "DOCUMENTATION_OR_RESERVED"
  | "IPV4_TRANSITION_ADDRESS";

export interface ParsedIpAddress {
  family: 4 | 6;
  normalized: string;
  value: bigint;
  classification: IpAddressClass;
}

export interface ParsedCidr {
  family: 4 | 6;
  network: bigint;
  prefix: number;
  mask: bigint;
  normalized: string;
  classification: IpAddressClass;
}

const SPECIAL_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
]);

const SPECIAL_HOSTNAME_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".lan",
  ".home",
  ".home.arpa",
  ".corp",
  ".invalid",
  ".onion",
];

/** Parses a strict canonical dotted-decimal IPv4 (`0..255`, no leading zeros) into an unsigned 32-bit int. */
export function parseCanonicalIpv4(input: string): number | null {
  const parts = input.split(".");
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    acc = ((acc << 8) | octet) >>> 0;
  }
  return acc >>> 0;
}

export function formatIpv4(u32: number): string {
  const v = u32 >>> 0;
  return `${(v >>> 24) & 0xff}.${(v >>> 16) & 0xff}.${(v >>> 8) & 0xff}.${v & 0xff}`;
}

/**
 * Detects non-canonical IPv4 tricks BEFORE or AFTER URL parsing:
 *  - Single integer (`2130706433`, `0`)
 *  - Hex labels (`0x7f000001`, `0x7f.0.0.1`, `127.0.0.0x1`)
 *  - Octal leading-zero labels (`0177.0.0.1`, `127.0.0.01`)
 *  - Shorthand <4-part numeric (`127.1`, `127.0.1`, `10.0.1`)
 *  - Out-of-range all-numeric (`999.0.0.1`)
 */
export function isNonCanonicalIpv4Trick(rawHost: string): boolean {
  const trimmed = rawHost.trim().replace(/\.$/, "");
  if (trimmed === "" || trimmed.startsWith("[") || trimmed.includes(":")) return false;
  const labels = trimmed.split(".");
  const allNumericOrHex = labels.every((label) => /^(?:\d+|0x[0-9a-f]+)$/i.test(label));
  if (!allNumericOrHex) return false;
  // Every label looks like decimal/octal/hex integer, so this CANNOT be a valid ICANN domain (TLDs cannot be all-digits).
  // Therefore it is ONLY valid if it is a strict canonical 4-octet decimal IPv4.
  return parseCanonicalIpv4(trimmed) === null;
}

/** Parses an IPv6 literal (without brackets; rejects `%` zone identifiers) into an unsigned 128-bit BigInt. */
export function parseIpv6(input: string): { value: bigint; normalized: string } | null {
  if (input.includes("%") || input.length === 0 || input.length > 45) return null;
  if (!/^[0-9a-fA-F:.]+$/.test(input) || !input.includes(":")) return null;

  let working = input.toLowerCase();
  // Handle embedded trailing IPv4 (e.g. `::ffff:127.0.0.1` or `64:ff9b::169.254.169.254`)
  const lastColon = working.lastIndexOf(":");
  if (lastColon !== -1 && working.slice(lastColon + 1).includes(".")) {
    const v4Str = working.slice(lastColon + 1);
    // Reject non-canonical embedded IPv4 such as `::ffff:0177.0.0.1`
    const v4 = parseCanonicalIpv4(v4Str);
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    working = `${working.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const doubleColonParts = working.split("::");
  if (doubleColonParts.length > 2) return null;

  let groups: string[];
  if (doubleColonParts.length === 2) {
    const left = doubleColonParts[0] ? doubleColonParts[0].split(":") : [];
    const right = doubleColonParts[1] ? doubleColonParts[1].split(":") : [];
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  } else {
    groups = working.split(":");
    if (groups.length !== 8) return null;
  }

  if (groups.length !== 8) return null;
  let value = 0n;
  const numericGroups: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const word = Number.parseInt(g, 16);
    numericGroups.push(word);
    value = (value << 16n) | BigInt(word);
  }

  return { value, normalized: formatIpv6Groups(numericGroups) };
}

function formatIpv6Groups(groups: readonly number[]): string {
  // RFC 5952 canonical compression of longest run of >=2 zero 16-bit groups
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < 8; i += 1) {
    if (groups[i] === 0) {
      if (curStart === -1) {
        curStart = i;
        curLen = 1;
      } else {
        curLen += 1;
      }
      if (curLen > bestLen && curLen >= 2) {
        bestStart = curStart;
        bestLen = curLen;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }

  if (bestStart === -1) {
    return groups.map((g) => g.toString(16)).join(":");
  }
  const before = groups
    .slice(0, bestStart)
    .map((g) => g.toString(16))
    .join(":");
  const after = groups
    .slice(bestStart + bestLen)
    .map((g) => g.toString(16))
    .join(":");
  return `${before}::${after}`;
}

function inIpv4Range(u32: number, base: number, prefix: number): boolean {
  if (prefix === 0) return true;
  const mask = prefix === 32 ? 0xffffffff : (~((1 << (32 - prefix)) - 1)) >>> 0;
  return ((u32 & mask) >>> 0) === ((base & mask) >>> 0);
}

export function classifyIpv4(u32Input: number): IpAddressClass {
  const u32 = u32Input >>> 0;

  // Cloud metadata endpoints (check BEFORE link-local & CGNAT!)
  if (
    u32 === 0xa9fea9fe || // 169.254.169.254 (AWS/GCP/Azure/DO/OpenStack IMDS)
    u32 === 0xa9feaa02 || // 169.254.170.2   (AWS ECS metadata)
    u32 === 0xa9fea9fd || // 169.254.169.253 (AWS local DNS/IMDS)
    u32 === 0x646464c8 || // 100.100.100.200 (Alibaba Cloud metadata, inside 100.64/10)
    u32 === 0xc00000c0    // 192.0.0.192     (Oracle Cloud metadata)
  ) {
    return "CLOUD_METADATA";
  }

  if (inIpv4Range(u32, 0x00000000, 8)) return "UNSPECIFIED";          // 0.0.0.0/8
  if (u32 === 0xffffffff) return "BROADCAST";                         // 255.255.255.255
  if (inIpv4Range(u32, 0x7f000000, 8)) return "LOOPBACK";             // 127.0.0.0/8
  if (inIpv4Range(u32, 0xa9fe0000, 16)) return "LINK_LOCAL";          // 169.254.0.0/16
  if (inIpv4Range(u32, 0xe0000000, 4)) return "MULTICAST_OR_RESERVED";// 224.0.0.0/4 (multicast)
  if (inIpv4Range(u32, 0xf0000000, 4)) return "MULTICAST_OR_RESERVED";// 240.0.0.0/4 (reserved)

  // IETF special / documentation / benchmarking ranges
  if (
    inIpv4Range(u32, 0xc0000000, 24) || // 192.0.0.0/24 IETF protocol assignments
    inIpv4Range(u32, 0xc0000200, 24) || // 192.0.2.0/24 TEST-NET-1
    inIpv4Range(u32, 0xc6336400, 24) || // 198.51.100.0/24 TEST-NET-2
    inIpv4Range(u32, 0xcb007100, 24) || // 203.0.113.0/24 TEST-NET-3
    inIpv4Range(u32, 0xc6120000, 15) || // 198.18.0.0/15 Benchmarking
    inIpv4Range(u32, 0xc0586300, 24)    // 192.88.99.0/24 6to4 relay anycast
  ) {
    return "DOCUMENTATION_OR_RESERVED";
  }

  // Private RFC 1918 + RFC 6598 CGNAT (allowlistable by explicit admin policy)
  if (
    inIpv4Range(u32, 0x0a000000, 8) ||  // 10.0.0.0/8
    inIpv4Range(u32, 0xac100000, 12) || // 172.16.0.0/12
    inIpv4Range(u32, 0xc0a80000, 16) || // 192.168.0.0/16
    inIpv4Range(u32, 0x64400000, 10)    // 100.64.0.0/10 CGNAT
  ) {
    return "PRIVATE_NETWORK";
  }

  return "PUBLIC";
}

function inIpv6Range(u128: bigint, base: bigint, prefix: number): boolean {
  if (prefix === 0) return true;
  const shift = BigInt(128 - prefix);
  return (u128 >> shift) === (base >> shift);
}

const IPV6_EC2_IMDS = 0xfd000ec2_00000000_00000000_00000254n; // fd00:ec2::254

export function classifyIpv6(u128: bigint): IpAddressClass {
  // AWS IPv6 IMDS (must precede fc00::/7 ULA check!)
  if (u128 === IPV6_EC2_IMDS) return "CLOUD_METADATA";

  if (u128 === 0n) return "UNSPECIFIED"; // ::/128
  if (u128 === 1n) return "LOOPBACK";    // ::1/128

  // IPv4-mapped IPv6 `::ffff:0:0/96` — never allowlistable as IPv6; preserve CLOUD_METADATA reason if applicable
  if ((u128 >> 32n) === 0xffffn) {
    const embeddedV4 = Number(u128 & 0xffffffffn) >>> 0;
    const v4Class = classifyIpv4(embeddedV4);
    return v4Class === "CLOUD_METADATA" ? "CLOUD_METADATA" : "IPV4_TRANSITION_ADDRESS";
  }

  // IPv4-compatible `::/96` (excluding :: and ::1 handled above)
  if ((u128 >> 32n) === 0n) {
    const embeddedV4 = Number(u128 & 0xffffffffn) >>> 0;
    const v4Class = classifyIpv4(embeddedV4);
    return v4Class === "CLOUD_METADATA" ? "CLOUD_METADATA" : "IPV4_TRANSITION_ADDRESS";
  }

  // IPv4-translated SIIT `::ffff:0:0/96` (`0:0:0:0:ffff:0:w.x.y.z` -> bits 48..63 = 0xffff, bits 32..47 = 0x0000)
  if ((u128 >> 32n) === 0xffff0000n) {
    const embeddedV4 = Number(u128 & 0xffffffffn) >>> 0;
    const v4Class = classifyIpv4(embeddedV4);
    return v4Class === "CLOUD_METADATA" ? "CLOUD_METADATA" : "IPV4_TRANSITION_ADDRESS";
  }

  // NAT64 well-known prefix `64:ff9b::/96` and local-use `64:ff9b:1::/48`
  if (
    inIpv6Range(u128, 0x0064ff9b_00000000_00000000_00000000n, 96) ||
    inIpv6Range(u128, 0x0064ff9b_00010000_00000000_00000000n, 48)
  ) {
    const embeddedV4 = Number(u128 & 0xffffffffn) >>> 0;
    const v4Class = classifyIpv4(embeddedV4);
    return v4Class === "CLOUD_METADATA" ? "CLOUD_METADATA" : "IPV4_TRANSITION_ADDRESS";
  }

  // 6to4 `2002::/16` (bits 16..47 carry embedded IPv4)
  if (inIpv6Range(u128, 0x20020000_00000000_00000000_00000000n, 16)) {
    const embeddedV4 = Number((u128 >> 80n) & 0xffffffffn) >>> 0;
    const v4Class = classifyIpv4(embeddedV4);
    return v4Class === "CLOUD_METADATA" ? "CLOUD_METADATA" : "IPV4_TRANSITION_ADDRESS";
  }

  // Teredo `2001:0000::/32` (client IPv4 is bitwise-NOT of low 32 bits)
  if (inIpv6Range(u128, 0x20010000_00000000_00000000_00000000n, 32)) {
    const embeddedV4 = (~Number(u128 & 0xffffffffn)) >>> 0;
    const v4Class = classifyIpv4(embeddedV4);
    return v4Class === "CLOUD_METADATA" ? "CLOUD_METADATA" : "IPV4_TRANSITION_ADDRESS";
  }

  // Link-local `fe80::/10` + deprecated site-local `fec0::/10`
  if (
    inIpv6Range(u128, 0xfe800000_00000000_00000000_00000000n, 10) ||
    inIpv6Range(u128, 0xfec00000_00000000_00000000_00000000n, 10)
  ) {
    return "LINK_LOCAL";
  }

  // Multicast `ff00::/8`
  if (inIpv6Range(u128, 0xff000000_00000000_00000000_00000000n, 8)) {
    return "MULTICAST_OR_RESERVED";
  }

  // Documentation `2001:db8::/32` + RFC 9637 `3fff::/20`, SRv6 `5f00::/16`, Benchmarking `2001:2::/48`, ORCHID `2001:10::/28`, Discard `100::/64`
  if (
    inIpv6Range(u128, 0x20010db8_00000000_00000000_00000000n, 32) ||
    inIpv6Range(u128, 0x3fff0000_00000000_00000000_00000000n, 20) ||
    inIpv6Range(u128, 0x5f000000_00000000_00000000_00000000n, 16) ||
    inIpv6Range(u128, 0x20010002_00000000_00000000_00000000n, 48) ||
    inIpv6Range(u128, 0x20010010_00000000_00000000_00000000n, 28) ||
    inIpv6Range(u128, 0x01000000_00000000_00000000_00000000n, 64)
  ) {
    return "DOCUMENTATION_OR_RESERVED";
  }

  // RFC 4193 Unique Local `fc00::/7` (private network — allowlistable by explicit admin policy)
  if (inIpv6Range(u128, 0xfc000000_00000000_00000000_00000000n, 7)) {
    return "PRIVATE_NETWORK";
  }

  // Global unicast `2000::/3`
  if (inIpv6Range(u128, 0x20000000_00000000_00000000_00000000n, 3)) {
    return "PUBLIC";
  }

  return "MULTICAST_OR_RESERVED";
}

export function parseIpAddress(raw: string): ParsedIpAddress | null {
  const unbracketed = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  if (isNonCanonicalIpv4Trick(unbracketed)) return null;
  const v4 = parseCanonicalIpv4(unbracketed);
  if (v4 !== null) {
    return {
      family: 4,
      normalized: formatIpv4(v4),
      value: BigInt(v4),
      classification: classifyIpv4(v4),
    };
  }
  const v6 = parseIpv6(unbracketed);
  if (v6 !== null) {
    return {
      family: 6,
      normalized: v6.normalized,
      value: v6.value,
      classification: classifyIpv6(v6.value),
    };
  }
  return null;
}

/**
 * Parses a bounded CIDR (`a.b.c.d/8..32` or `ipv6/32..128`).
 * Broad catch-all prefixes (`/0..7` for IPv4, `/0..31` for IPv6) are rejected so an allowlist rule
 * can never accidentally authorize the entire address space.
 */
export function parseSafeCidr(raw: string): ParsedCidr | null {
  const parts = raw.trim().split("/");
  if (parts.length !== 2) return null;
  const [ipPart, prefixPart] = parts;
  if (!ipPart || !prefixPart || !/^(?:0|[1-9]\d{0,2})$/.test(prefixPart)) return null;
  const prefix = Number(prefixPart);
  const ip = parseIpAddress(ipPart);
  if (!ip) return null;
  const totalBits = ip.family === 4 ? 32 : 128;
  const minPrefix = ip.family === 4 ? 8 : 32;
  if (prefix < minPrefix || prefix > totalBits) return null;

  const allOnes = (1n << BigInt(totalBits)) - 1n;
  const hostBits = BigInt(totalBits - prefix);
  const mask = hostBits === 0n ? allOnes : ((allOnes >> hostBits) << hostBits) & allOnes;
  const network = ip.value & mask;
  const normalizedIp =
    ip.family === 4
      ? formatIpv4(Number(network))
      : parseIpv6(
          Array.from({ length: 8 }, (_, idx) => Number((network >> BigInt((7 - idx) * 16)) & 0xffffn).toString(16)).join(":"),
        )!.normalized;
  const networkClass = ip.family === 4 ? classifyIpv4(Number(network)) : classifyIpv6(network);
  return {
    family: ip.family,
    network,
    prefix,
    mask,
    normalized: `${normalizedIp}/${prefix}`,
    classification: networkClass,
  };
}

export function matchIpAgainstCidr(ip: ParsedIpAddress, cidr: ParsedCidr): boolean {
  if (ip.family !== cidr.family) return false;
  return (ip.value & cidr.mask) === cidr.network;
}

export type HostPrecheckResult =
  | { ok: true; kind: "ip"; ip: ParsedIpAddress; normalizedHost: string }
  | { ok: true; kind: "dns"; normalizedHost: string }
  | { ok: false; reasonCode: string; safeMessage: string };

/**
 * Validates raw host syntax BEFORE DNS resolution (rejecting non-canonical IP tricks, IPv6 zone IDs,
 * special-use local/metadata names, and invalid DNS labels).
 */
export function precheckHost(rawHostInput: string): HostPrecheckResult {
  const trimmed = rawHostInput.trim();
  if (trimmed.length === 0 || trimmed.length > 255) {
    return { ok: false, reasonCode: "INVALID_HOST", safeMessage: "The destination host is not valid." };
  }
  if (/[\s\0\r\n/@\\?#%]/.test(trimmed)) {
    return { ok: false, reasonCode: "INVALID_HOST", safeMessage: "The destination host contains forbidden characters." };
  }

  // Bracketed IPv6 literal (`[::1]`) or bare IPv6 literal (`::1`)
  if (trimmed.startsWith("[") || trimmed.includes(":")) {
    const unbracketed = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
    if (trimmed.startsWith("[") && !trimmed.endsWith("]")) {
      return { ok: false, reasonCode: "INVALID_IPV6_HOST", safeMessage: "The IPv6 destination host is malformed." };
    }
    const v6 = parseIpv6(unbracketed);
    if (!v6) {
      return { ok: false, reasonCode: "INVALID_IPV6_HOST", safeMessage: "The IPv6 destination host is not valid." };
    }
    const ip: ParsedIpAddress = {
      family: 6,
      normalized: v6.normalized,
      value: v6.value,
      classification: classifyIpv6(v6.value),
    };
    return { ok: true, kind: "ip", ip, normalizedHost: v6.normalized };
  }

  // Reject decimal/octal/hex/shorthand IPv4 tricks BEFORE DNS or URL normalization
  if (isNonCanonicalIpv4Trick(trimmed)) {
    return {
      ok: false,
      reasonCode: "NON_CANONICAL_IP_HOST",
      safeMessage: "Non-canonical numeric IP representations (decimal, octal, hex or shorthand) are not permitted.",
    };
  }

  const withoutTrailingDot = trimmed.replace(/\.$/, "");
  const v4 = parseCanonicalIpv4(withoutTrailingDot);
  if (v4 !== null) {
    const ip: ParsedIpAddress = {
      family: 4,
      normalized: formatIpv4(v4),
      value: BigInt(v4),
      classification: classifyIpv4(v4),
    };
    return { ok: true, kind: "ip", ip, normalizedHost: ip.normalized };
  }

  // Normalize IDN to ASCII punycode
  const ascii = domainToASCII(withoutTrailingDot).toLowerCase();
  if (!ascii || ascii.length > 253) {
    return { ok: false, reasonCode: "INVALID_HOST", safeMessage: "The destination domain name is not valid." };
  }

  if (SPECIAL_HOSTNAMES.has(ascii)) {
    const isMeta = ascii.includes("metadata") || ascii.includes("instance-data");
    return {
      ok: false,
      reasonCode: isMeta ? "EGRESS_METADATA_BLOCKED" : "SPECIAL_USE_HOSTNAME",
      safeMessage: "Local and cloud-metadata hostnames are not permitted.",
    };
  }
  for (const suffix of SPECIAL_HOSTNAME_SUFFIXES) {
    if (ascii.endsWith(suffix)) {
      return {
        ok: false,
        reasonCode: "SPECIAL_USE_HOSTNAME",
        safeMessage: "Reserved local and internal domain suffixes are not permitted.",
      };
    }
  }

  // Require valid multi-label DNS name (`host.tld`, labels 1..63, TLD has at least one ASCII letter)
  const labels = ascii.split(".");
  if (labels.length < 2) {
    return {
      ok: false,
      reasonCode: "SINGLE_LABEL_HOST_REFUSED",
      safeMessage: "Single-label hostnames are not permitted; use a fully qualified domain name.",
    };
  }
  for (const label of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
      return { ok: false, reasonCode: "INVALID_HOST", safeMessage: "The destination domain name is not valid." };
    }
  }
  const tld = labels[labels.length - 1]!;
  if (!/[a-z]/.test(tld)) {
    return { ok: false, reasonCode: "INVALID_HOST", safeMessage: "The destination top-level domain is not valid." };
  }

  return { ok: true, kind: "dns", normalizedHost: ascii };
}
