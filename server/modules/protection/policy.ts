import { isIP } from "node:net";
import { z } from "zod";

export const managedGroups = ["injection", "traversal", "protocol", "scanner", "oversize"] as const;
export const managedMode = z.enum(["off", "detect", "block"]);
export const fieldSchema = z.enum(["path", "method", "header", "query", "ip", "country"]);
const inspectedHeaders = ["user-agent", "content-type", "accept", "accept-language", "sec-fetch-site"] as const;
const country = z.string().regex(/^[A-Z]{2}$/);
const literal = z.string().trim().min(1).max(160).refine((s) => !/[\u0000-\u001f\u007f]/.test(s));

export interface Address { family: 4 | 6; text: string; number: bigint }
export interface Network { address: Address; length: number }

export function addressOf(input: string | undefined): Address | undefined {
  const source = input?.split("%", 1)[0];
  if (!source) return undefined;
  const family = isIP(source);
  if (family === 4) {
    const bytes = source.split(".").map(Number);
    return { family, text: source, number: bytes.reduce((a, b) => (a << 8n) + BigInt(b), 0n) };
  }
  if (family !== 6) return undefined;
  const text = new URL(`http://[${source}]`).hostname.slice(1, -1);
  const [left = "", right] = text.split("::");
  const head = left ? left.split(":") : [];
  const tail = right ? right.split(":") : [];
  const groups = right === undefined ? head : [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail];
  const number = groups.reduce((a, b) => (a << 16n) + BigInt(`0x${b}`), 0n);
  if (number >> 32n === 0xffffn) {
    return addressOf([24n, 16n, 8n, 0n].map((shift) => Number((number >> shift) & 255n)).join("."));
  }
  return { family, text, number };
}

export function parseNetwork(input: string): Network | undefined {
  const [raw, prefix, extra] = input.split("/");
  if (!raw || raw.includes("%") || extra !== undefined) return undefined;
  const address = addressOf(raw);
  if (!address || (raw.includes(":") && address.family === 4 && prefix !== undefined)) return undefined;
  const bits = address.family === 4 ? 32 : 128;
  if (prefix !== undefined && !/^(?:0|[1-9][0-9]{0,2})$/.test(prefix)) return undefined;
  const length = prefix === undefined ? bits : Number(prefix);
  if (length < (address.family === 4 ? 8 : 16) || length > bits) return undefined;
  const shift = BigInt(bits - length);
  if ((address.number >> shift) << shift !== address.number) return undefined;
  return { address, length };
}

function contains(network: Network, address: Address | undefined) {
  if (!address || network.address.family !== address.family) return false;
  const shift = BigInt((address.family === 4 ? 32 : 128) - network.length);
  return network.address.number >> shift === address.number >> shift;
}

const customRule = z.strictObject({
  id: z.uuid(),
  label: literal,
  field: fieldSchema,
  operator: z.enum(["exact", "prefix", "contains"]),
  header: z.enum(inspectedHeaders).optional(),
  value: literal,
  action: z.enum(["log", "block"]),
}).superRefine((value, ctx) => {
  if ((value.field === "header") !== Boolean(value.header)) ctx.addIssue({ code: "custom", path: ["header"], message: "Choose an allowed header for header rules only." });
  if (value.field === "ip" && (value.operator !== "exact" || !parseNetwork(value.value))) ctx.addIssue({ code: "custom", path: ["value"], message: "Enter an IP or canonical CIDR and use exact matching." });
  if (value.field === "country" && (value.operator !== "exact" || !country.safeParse(value.value).success)) ctx.addIssue({ code: "custom", path: ["value"], message: "Enter an uppercase two-letter country code and use exact matching." });
});

const ipRule = z.strictObject({
  network: z.string().trim().max(48).transform((value, ctx) => {
    const network = parseNetwork(value);
    if (!network) {
      ctx.addIssue({ code: "custom", message: "Enter an IP or canonical CIDR (IPv4 /8–/32, IPv6 /16–/128)." });
      return z.NEVER;
    }
    return `${network.address.text}/${network.length}`;
  }),
  action: z.enum(["allow", "deny"]),
  reason: literal,
  expiresAt: z.iso.datetime().nullable(),
});

export const policySchema = z.strictObject({
  mode: z.enum(["detect", "enforce"]),
  managed: z.strictObject({
    injection: managedMode, traversal: managedMode, protocol: managedMode, scanner: managedMode, oversize: managedMode,
  }),
  custom: z.array(customRule).max(32),
  ipLists: z.array(ipRule).max(128),
  countries: z.strictObject({ mode: z.enum(["off", "allow", "deny"]), codes: z.array(country).max(249) }),
  automatic: z.strictObject({
    enabled: z.boolean(),
    threshold: z.number().int().min(5).max(50),
    minutes: z.number().int().min(1).max(60),
  }),
}).superRefine((value, ctx) => {
  if (new Set(value.custom.map((r) => r.id)).size !== value.custom.length) ctx.addIssue({ code: "custom", path: ["custom"], message: "Rule identifiers must be unique." });
  if (new Set(value.ipLists.map((r) => `${r.action}:${r.network}`)).size !== value.ipLists.length) ctx.addIssue({ code: "custom", path: ["ipLists"], message: "IP list entries must be unique." });
  if (new Set(value.countries.codes).size !== value.countries.codes.length) ctx.addIssue({ code: "custom", path: ["countries", "codes"], message: "Country codes must be unique." });
  if (value.countries.mode !== "off" && !value.countries.codes.length) ctx.addIssue({ code: "custom", path: ["countries", "codes"], message: "Add a country before enabling this policy." });
});
export type ProtectionPolicy = z.output<typeof policySchema>;
export const defaultPolicy: ProtectionPolicy = {
  mode: "detect",
  managed: { injection: "detect", traversal: "detect", protocol: "detect", scanner: "detect", oversize: "detect" },
  custom: [], ipLists: [], countries: { mode: "off", codes: [] },
  automatic: { enabled: false, threshold: 8, minutes: 10 },
};

export interface RequestSignals {
  path: string;
  query: string;
  method: string;
  headers: Partial<Record<(typeof inspectedHeaders)[number], string>>;
  address: Address | undefined;
  country: string | null;
  oversize: boolean;
  recovery?: boolean;
}

export function inspectedHeaderNames() { return inspectedHeaders; }
export type RuleMatch = { action: "detect" | "block"; rule: string; exempt?: never } | { action: "allow"; exempt: boolean };

function managedMatch(group: (typeof managedGroups)[number], s: RequestSignals): boolean {
  const agent = s.headers["user-agent"] ?? "";
  switch (group) {
    case "injection": return ["<script", "<iframe", "union select", "union+select", "information_schema", "sleep(", "benchmark("]
      .some((part) => s.path.includes(part) || s.query.includes(part));
    case "traversal": return s.path.includes("\\") || s.path.split("/").some((part) => part === ".." || part === ".");
    case "protocol": return s.path.startsWith("//") || s.path.includes("\0") || ["CONNECT", "TRACE", "TRACK"].includes(s.method);
    case "scanner": return ["/.git", "/.env", "/wp-login.php", "/phpmyadmin"].some((part) => s.path === part || s.path.startsWith(`${part}/`)) ||
      ["sqlmap", "nikto", "masscan", "acunetix"].some((name) => agent.includes(name));
    case "oversize": return s.oversize;
  }
}

export function compilePolicy(policy: ProtectionPolicy) {
  const ranges = policy.ipLists.map((rule) => ({ ...rule, range: parseNetwork(rule.network)!, expiry: rule.expiresAt ? Date.parse(rule.expiresAt) : Infinity }));
  const custom = policy.custom.map((rule) => ({ ...rule, needle: rule.value.toLowerCase(), network: rule.field === "ip" ? parseNetwork(rule.value) : undefined }));
  const codes = new Set(policy.countries.codes);
  return (signals: RequestSignals, now: number): RuleMatch => {
    const allow = ranges.some((r) => r.action === "allow" && r.expiry > now && contains(r.range, signals.address));
    if (allow) return { action: "allow", exempt: true };
    let detected: RuleMatch | undefined;
    const match = (rule: string, block: boolean): RuleMatch | undefined => {
      if (block && policy.mode === "enforce") return { action: "block", rule };
      detected ??= { action: "detect", rule };
      return undefined;
    };
    if (ranges.some((r) => r.action === "deny" && r.expiry > now && contains(r.range, signals.address))) {
      const blocked = match("ip.deny", true);
      if (blocked) return blocked;
    }
    const listed = signals.country !== null && codes.has(signals.country);
    if ((policy.countries.mode === "allow" && !listed) || (policy.countries.mode === "deny" && listed)) {
      const blocked = match("country.policy", true);
      if (blocked) return blocked;
    }
    for (const group of managedGroups) {
      const mode = policy.managed[group];
      if (mode !== "off" && managedMatch(group, signals)) {
        const blocked = match(`managed.${group}`, mode === "block" && !signals.recovery);
        if (blocked) return blocked;
      }
    }
    for (const rule of custom) {
      let matches: boolean;
      if (rule.network) matches = contains(rule.network, signals.address);
      else {
        const haystack =
          rule.field === "header" ? signals.headers[rule.header!] ?? "" :
          rule.field === "country" ? signals.country?.toLowerCase() ?? "" :
          rule.field === "method" ? signals.method.toLowerCase() :
          rule.field === "path" ? signals.path : signals.query;
        matches = rule.operator === "exact" ? haystack === rule.needle :
          rule.operator === "prefix" ? haystack.startsWith(rule.needle) : haystack.includes(rule.needle);
      }
      if (matches) {
        const addressRule = rule.field === "ip" || rule.field === "country";
        const blocked = match(`custom.${rule.id}`, rule.action === "block" && (addressRule || !signals.recovery));
        if (blocked) return blocked;
      }
    }
    return detected ?? { action: "allow", exempt: false };
  };
}
