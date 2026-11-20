/**
 * Validated runtime configuration. Owner: platform engineer.
 *
 * Rules:
 *  - No defaults for secrets. Missing/weak/placeholder/duplicated secrets refuse startup (fail closed).
 *  - Secrets may be supplied as `<NAME>_FILE` pointing at a root-owned 0600/0640 file (preferred on hosts);
 *    setting both `<NAME>` and `<NAME>_FILE` is refused as ambiguous.
 *  - Configuration is DATA: nothing here is ever sourced or executed.
 *  - Problems are reported by VARIABLE NAME and RULE only. Values are never echoed.
 *  - Optional providers stay inert until deliberately and completely configured (in the database
 *    settings store, not here).
 *
 * Every variable is declared once in `ENV_VARIABLES` (also used by the config doctor and to verify that
 * `server/config/env.example` documents every variable).
 */
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { readSecretFile, SecretFileError, type SecretFileOptions } from "./secretFiles.js";

/** Exact value an operator must set in RP_PREVIEW_ACKNOWLEDGED to run the preview profile. */
export const PREVIEW_ACKNOWLEDGEMENT = "synthetic-data-only";
export const DEPLOYMENT_PROFILES = ["production", "development", "test", "preview"] as const;
export type DeploymentProfile = (typeof DEPLOYMENT_PROFILES)[number];

/* ------------------------------------------------------------------ catalogue */

export interface EnvVariable {
  name: string;
  /** Secret: may be supplied via `<name>_FILE`, never logged, never exported. */
  secret: boolean;
  required: boolean;
  description: string;
  /** Set when another module reads and validates the variable itself (not part of AppConfig). */
  consumer?: string;
}

export const ENV_VARIABLES: readonly EnvVariable[] = [
  { name: "NODE_ENV", secret: false, required: true, description: "production | development | test" },
  { name: "RP_DEPLOYMENT_PROFILE", secret: false, required: false, description: "production | development | test | preview (defaults from NODE_ENV). preview is for the sandboxed demo only." },
  { name: "RP_PREVIEW_ACKNOWLEDGED", secret: false, required: false, description: "Required with RP_DEPLOYMENT_PROFILE=preview: must be exactly synthetic-data-only (the preview never holds real customer data)" },
  { name: "RP_ROLE", secret: false, required: false, description: "web | worker | all (default all)" },
  { name: "HOST", secret: false, required: false, description: "Listen address (default 127.0.0.1; keep loopback behind Nginx)" },
  { name: "PORT", secret: false, required: false, description: "Listen port (default 5000)" },
  { name: "RP_CANONICAL_ORIGIN", secret: false, required: true, description: "The single canonical origin, e.g. https://my.readypackets.com (https required in production)" },
  { name: "RP_ALIAS_HOSTS", secret: false, required: false, description: "Comma-separated alias hostnames that redirect to the canonical origin" },
  { name: "RP_MARKETING_ORIGIN", secret: false, required: false, description: "Public marketing site origin for outbound links" },
  { name: "RP_TRUSTED_PROXIES", secret: false, required: false, description: "Comma-separated IPs/CIDRs of reverse proxies whose X-Forwarded-* headers are trusted (empty = none)" },
  { name: "DATABASE_URL", secret: true, required: true, description: "mysql:// URL for a least-privilege application account" },
  { name: "RP_DB_POOL_SIZE", secret: false, required: false, description: "Connection pool size 1-64 (default 10)" },
  { name: "RP_STORAGE_DIR", secret: false, required: true, description: "Absolute path of private object storage, outside any web root" },
  { name: "RP_INSTALLATION_ID", secret: false, required: true, description: "Stable installation identifier, lowercase [a-z0-9-], 3-63 chars" },
  { name: "RP_RELEASE_REF", secret: false, required: false, description: "Release reference reported in health/audit" },
  { name: "RP_SERVICE_NAME", secret: false, required: false, description: "Service name for logs/SIEM (default portal)" },
  { name: "RP_DATA_KEYRING", secret: true, required: true, description: "JSON {\"current\":\"<id>\",\"keys\":{\"<id>\":\"<base64 32 bytes>\"}} — field-encryption keyring incl. retired keys for dual-read" },
  { name: "RP_INDEX_KEY", secret: true, required: true, description: "Base64 32-byte blind-index HMAC key" },
  { name: "RP_INDEX_KEY_PREVIOUS", secret: true, required: false, description: "Previous blind-index key, set ONLY during a blind-index transition (dual lookup)" },
  { name: "RP_PSEUDONYM_KEY", secret: true, required: true, description: "Base64 32-byte audit/SIEM pseudonym HMAC key" },
  { name: "RP_TOKEN_HASH_KEY", secret: true, required: true, description: "Base64 32-byte HMAC key for stored single-use token hashes" },
  { name: "RP_AUDIT_CHAIN_KEY", secret: true, required: true, description: "Base64 32-byte audit tamper-evidence chain key" },
  { name: "RP_LOG_LEVEL", secret: false, required: false, description: "debug | info | warn | error (default info)" },
  { name: "RP_MIGRATIONS_DIR", secret: false, required: false, description: "Directory holding the release's Drizzle migrations (default ./migrations)" },
  // Read and validated by the owning module (documented here so the doctor recognizes them).
  { name: "RP_BACKUP_KEY", secret: true, required: false, consumer: "backup", description: "Backup encryption keyring JSON or 32-byte key; prefer RP_BACKUP_KEY_FILE (0600)" },
  { name: "RP_BACKUP_KEY_ID", secret: false, required: false, consumer: "backup", description: "Key id used for new backup archives" },
  { name: "RP_RECOVERY_SANDBOX_DIR", secret: false, required: false, consumer: "backup", description: "Absolute path of the private restore-verification sandbox" },
];

const KNOWN_NAMES = new Set(ENV_VARIABLES.flatMap((v) => (v.secret ? [v.name, `${v.name}_FILE`] : [v.name])));

/* ------------------------------------------------------------------- schemas */

/** Minimum distinct byte values in a 32-byte key. Random keys have ~30; P(<16) is negligible. */
export const MIN_DISTINCT_KEY_BYTES = 16;

const base64Key32 = z
  .string()
  .regex(/^[A-Za-z0-9+/_-]{43}=?$/, "must be 32 random bytes, base64/base64url encoded")
  .refine((value) => decodeKey(value).length === 32, "must decode to exactly 32 bytes")
  .refine((value) => new Set(decodeKey(value)).size >= MIN_DISTINCT_KEY_BYTES, "key has too little entropy");

/** Accepts standard base64 and base64url. */
export function decodeKey(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

const KEY_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

const keyringSchema = z
  .object({
    /** Key id used for new encryptions. */
    current: z.string().regex(KEY_ID, "current key id must match [a-z0-9-]{1,32}"),
    /** All readable keys, including retired-but-retained ids for dual-read. */
    keys: z.record(z.string().regex(KEY_ID, "key ids must match [a-z0-9-]{1,32}"), base64Key32),
  })
  .strict()
  .refine((ring) => ring.current in ring.keys, "current key id must exist in keys")
  .refine((ring) => Object.keys(ring.keys).length <= 16, "at most 16 keys may be retained");
export type DataKeyring = z.infer<typeof keyringSchema>;

const originSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password &&
      !value.endsWith("/")
    );
  }, "must be a bare origin such as https://my.readypackets.com (no path, query or trailing slash)");

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

/** Exact numeric IP or CIDR only (no named classes such as `loopback`, which Express would expand broadly). */
export function isNumericIpOrCidr(value: string): boolean {
  const [address, prefix, extra] = value.split("/");
  if (extra !== undefined || !address) return false;
  const v4 = isIpv4(address);
  const v6 = !v4 && isIP(address) === 6;
  if (!v4 && !v6) return false;
  if (prefix === undefined) return true;
  if (!/^(0|[1-9]\d{0,2})$/.test(prefix)) return false;
  return Number(prefix) <= (v4 ? 32 : 128);
}

const proxySchema = z.string().max(64).refine(isNumericIpOrCidr, "must be an exact numeric IP address or CIDR");

const configSchema = z.object({
  nodeEnv: z.enum(["production", "development", "test"]),
  deploymentProfile: z.enum(DEPLOYMENT_PROFILES),
  role: z.enum(["web", "worker", "all"]),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  /** The single canonical cookie/CSRF origin. */
  canonicalOrigin: originSchema,
  /** Explicit alias hosts that 308-redirect to the canonical origin (never parallel auth origins). */
  aliasHosts: z.array(z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, "must be lowercase hostnames")).max(8),
  marketingOrigin: originSchema,
  /** CIDRs/IPs of reverse proxies whose X-Forwarded-* headers are trusted. Empty = trust none. */
  trustedProxies: z.array(proxySchema).max(16),
  databaseUrl: z.string().regex(/^mysql:\/\//, "must be a mysql:// URL").max(2048),
  databasePoolSize: z.number().int().min(1).max(64),
  /** Private object storage root, outside any web root. */
  storageDir: z.string().min(1).max(1024),
  installationId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/, "must be lowercase [a-z0-9-], 3-63 characters"),
  releaseRef: z.string().regex(/^[A-Za-z0-9._+-]{1,80}$/, "must be 1-80 characters of [A-Za-z0-9._+-]"),
  serviceName: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, "must be lowercase [a-z0-9-], at most 40 characters"),
  dataKeyring: keyringSchema,
  indexKey: base64Key32,
  /** Set only during a blind-index transition: lookups try current then previous. */
  previousIndexKey: base64Key32.optional(),
  pseudonymKey: base64Key32,
  tokenHashKey: base64Key32,
  auditChainKey: base64Key32,
  logLevel: z.enum(["debug", "info", "warn", "error"]),
  migrationsDir: z.string().min(1).max(1024),
});

export type AppConfig = Readonly<z.infer<typeof configSchema>> & {
  /** True only for the sandboxed preview profile: enables hash routing + in-memory header session transport. */
  readonly previewTransportEnabled: boolean;
  readonly cookieSecure: boolean;
  readonly sessionCookieName: string;
  readonly csrfCookieName: string;
};

type Env = Record<string, string | undefined>;

/** Field path → environment variable, so issues name what the operator actually sets. */
const FIELD_TO_VARIABLE: Record<string, string> = {
  nodeEnv: "NODE_ENV",
  deploymentProfile: "RP_DEPLOYMENT_PROFILE",
  role: "RP_ROLE",
  host: "HOST",
  port: "PORT",
  canonicalOrigin: "RP_CANONICAL_ORIGIN",
  aliasHosts: "RP_ALIAS_HOSTS",
  marketingOrigin: "RP_MARKETING_ORIGIN",
  trustedProxies: "RP_TRUSTED_PROXIES",
  databaseUrl: "DATABASE_URL",
  databasePoolSize: "RP_DB_POOL_SIZE",
  storageDir: "RP_STORAGE_DIR",
  installationId: "RP_INSTALLATION_ID",
  releaseRef: "RP_RELEASE_REF",
  serviceName: "RP_SERVICE_NAME",
  dataKeyring: "RP_DATA_KEYRING",
  indexKey: "RP_INDEX_KEY",
  previousIndexKey: "RP_INDEX_KEY_PREVIOUS",
  pseudonymKey: "RP_PSEUDONYM_KEY",
  tokenHashKey: "RP_TOKEN_HASH_KEY",
  auditChainKey: "RP_AUDIT_CHAIN_KEY",
  logLevel: "RP_LOG_LEVEL",
  migrationsDir: "RP_MIGRATIONS_DIR",
};

export interface ConfigProblem {
  /** Environment variable name (never its value). */
  variable: string;
  rule: string;
  severity: "error" | "warning";
}

export class ConfigError extends Error {
  public readonly issues: readonly string[];
  constructor(public readonly problems: readonly ConfigProblem[]) {
    const issues = problems.filter((p) => p.severity === "error").map((p) => `${p.variable}: ${p.rule}`);
    // Issue text names the variable and rule only — never the offending value.
    super(`Invalid configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/** Values that betray an unedited template or a well-known example. Compared case-insensitively. */
const PLACEHOLDER = /(change.?me|placeholder|replace.?me|your[-_ ]|example|dummy|sample|todo|xxxx|<[^>]*>|\$\{)/i;
/**
 * The same screen without its short tokens. Random base64 spells "todo", "xxxx" or "dummy" (in any letter
 * case) in about one key in 13,000, which would refuse a correctly generated key. Values that already are
 * well-formed 32-byte keys with enough distinct bytes are therefore screened with the long words only;
 * low-entropy templates such as a run of "x" still fail the key entropy rule.
 */
const PLACEHOLDER_IN_RANDOM_KEY = /(change.?me|placeholder|replace.?me|your[-_ ]|example|sample)/i;

function looksLikePlaceholderKey(value: string): boolean {
  return (base64Key32.safeParse(value).success ? PLACEHOLDER_IN_RANDOM_KEY : PLACEHOLDER).test(value);
}
const WEAK_DB_PASSWORDS = new Set(["password", "passw0rd", "root", "mysql", "admin", "secret", "readypackets", "rp_dev_local_only", "123456", "12345678"]);

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export interface LoadOptions extends SecretFileOptions {
  /** Include advisory warnings in the result (doctor). loadConfig ignores warnings. */
  collectWarnings?: boolean;
}

interface Evaluation {
  problems: ConfigProblem[];
  config?: AppConfig;
}

function readSecretVariable(env: Env, name: string, problems: ConfigProblem[], options: SecretFileOptions): string | undefined {
  const direct = env[name];
  const file = env[`${name}_FILE`];
  if (direct !== undefined && direct !== "" && file !== undefined && file !== "") {
    problems.push({ variable: name, rule: `set only one of ${name} or ${name}_FILE`, severity: "error" });
    return undefined;
  }
  if (file) {
    try {
      return readSecretFile(`${name}_FILE`, file, options);
    } catch (error) {
      if (error instanceof SecretFileError) problems.push({ variable: error.variable, rule: error.rule, severity: "error" });
      else problems.push({ variable: `${name}_FILE`, rule: "file is unreadable or missing", severity: "error" });
      return undefined;
    }
  }
  return direct === "" ? undefined : direct;
}

function evaluate(env: Env, options: LoadOptions): Evaluation {
  const problems: ConfigProblem[] = [];
  const err = (variable: string, rule: string) => problems.push({ variable, rule, severity: "error" });
  const warn = (variable: string, rule: string) => problems.push({ variable, rule, severity: "warning" });

  const nodeEnv = env.NODE_ENV ?? "development";
  const profile = env.RP_DEPLOYMENT_PROFILE ?? (nodeEnv === "production" ? "production" : nodeEnv);

  const secrets: Record<string, string | undefined> = {};
  for (const variable of ENV_VARIABLES) {
    if (variable.consumer) continue;
    if (variable.secret) secrets[variable.name] = readSecretVariable(env, variable.name, problems, options);
    else if (env[`${variable.name}_FILE`] !== undefined) err(`${variable.name}_FILE`, "only secret variables support _FILE");
  }

  let keyring: unknown;
  const rawKeyring = secrets.RP_DATA_KEYRING;
  if (rawKeyring !== undefined) {
    try {
      keyring = JSON.parse(rawKeyring);
    } catch {
      err("RP_DATA_KEYRING", "must be valid JSON");
      keyring = undefined;
    }
  }

  const numeric = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    return /^\d{1,6}$/.test(raw) ? Number(raw) : Number.NaN;
  };

  const candidate = {
    nodeEnv,
    deploymentProfile: profile,
    role: env.RP_ROLE ?? "all",
    host: env.HOST ?? "127.0.0.1",
    port: numeric("PORT", 5000),
    canonicalOrigin: env.RP_CANONICAL_ORIGIN,
    aliasHosts: list(env.RP_ALIAS_HOSTS),
    marketingOrigin: env.RP_MARKETING_ORIGIN ?? "https://www.readypackets.com",
    trustedProxies: list(env.RP_TRUSTED_PROXIES),
    databaseUrl: secrets.DATABASE_URL,
    databasePoolSize: numeric("RP_DB_POOL_SIZE", 10),
    storageDir: env.RP_STORAGE_DIR,
    installationId: env.RP_INSTALLATION_ID,
    releaseRef: env.RP_RELEASE_REF ?? "unreleased",
    serviceName: env.RP_SERVICE_NAME ?? "portal",
    dataKeyring: keyring,
    indexKey: secrets.RP_INDEX_KEY,
    previousIndexKey: secrets.RP_INDEX_KEY_PREVIOUS,
    pseudonymKey: secrets.RP_PSEUDONYM_KEY,
    tokenHashKey: secrets.RP_TOKEN_HASH_KEY,
    auditChainKey: secrets.RP_AUDIT_CHAIN_KEY,
    logLevel: env.RP_LOG_LEVEL ?? "info",
    migrationsDir: env.RP_MIGRATIONS_DIR ?? "migrations",
  };

  // Placeholder screening on raw secret text (before schema checks, which would not explain why).
  for (const name of ["RP_INDEX_KEY", "RP_INDEX_KEY_PREVIOUS", "RP_PSEUDONYM_KEY", "RP_TOKEN_HASH_KEY", "RP_AUDIT_CHAIN_KEY"]) {
    const value = secrets[name];
    if (value !== undefined && looksLikePlaceholderKey(value)) err(name, "looks like a placeholder value");
  }

  const parsed = configSchema.safeParse(candidate);
  if (!parsed.success) {
    const seen = new Set<string>();
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? "");
      const variable = FIELD_TO_VARIABLE[field] ?? field;
      // Required-but-missing reads better than a type error.
      const missing = candidate[field as keyof typeof candidate] === undefined;
      const rule = missing ? "is required" : field === "dataKeyring" ? keyringRule(issue) : issue.message;
      const dedupe = `${variable}|${rule}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      // Do not double-report variables that already failed at file/JSON stage.
      if (missing && problems.some((p) => p.variable.startsWith(variable))) continue;
      err(variable, rule);
    }
    return { problems };
  }
  const config = parsed.data;

  // Every key distinct (copy/paste of one key into two roles defeats separation of duties).
  const roles: [string, string][] = [
    ["RP_INDEX_KEY", config.indexKey],
    ["RP_PSEUDONYM_KEY", config.pseudonymKey],
    ["RP_TOKEN_HASH_KEY", config.tokenHashKey],
    ["RP_AUDIT_CHAIN_KEY", config.auditChainKey],
    ...(config.previousIndexKey ? ([["RP_INDEX_KEY_PREVIOUS", config.previousIndexKey]] as [string, string][]) : []),
    ...Object.values(config.dataKeyring.keys).map((key): [string, string] => ["RP_DATA_KEYRING", key]),
  ];
  const byBytes = new Map<string, string>();
  for (const [variable, key] of roles) {
    const normalized = decodeKey(key).toString("hex");
    const previous = byBytes.get(normalized);
    if (previous !== undefined) {
      err(variable, previous === variable ? "contains the same key twice" : `must differ from ${previous}`);
    } else byBytes.set(normalized, variable);
  }

  const origin = new URL(config.canonicalOrigin);
  const production = config.deploymentProfile === "production";
  if (production) {
    if (config.nodeEnv !== "production") err("NODE_ENV", "production profile requires NODE_ENV=production");
    if (origin.protocol !== "https:") err("RP_CANONICAL_ORIGIN", "production requires an https origin");
    if (!isAbsolute(config.storageDir)) err("RP_STORAGE_DIR", "must be an absolute path in production");
    if (config.logLevel === "debug") warn("RP_LOG_LEVEL", "debug logging in production increases data exposure");
    if (config.host === "0.0.0.0" || config.host === "::") warn("HOST", "listening on all interfaces; prefer loopback behind the reverse proxy");
    const db = dbUrlFacts(config.databaseUrl);
    if (!db) err("DATABASE_URL", "must be a valid mysql:// URL");
    else {
      if (!db.password) err("DATABASE_URL", "must include a password in production");
      else if (db.password.length < 16) err("DATABASE_URL", "password must be at least 16 characters in production");
      else if (WEAK_DB_PASSWORDS.has(db.password.toLowerCase()) || PLACEHOLDER.test(db.password)) err("DATABASE_URL", "password is a default or placeholder value");
      if (db.user === "root") warn("DATABASE_URL", "uses the MySQL root account; use a least-privilege application account");
    }
  } else if (config.nodeEnv === "production" && config.deploymentProfile !== "preview") {
    err("RP_DEPLOYMENT_PROFILE", "NODE_ENV=production requires the production profile");
  }
  if (config.deploymentProfile === "preview") {
    // Preview relaxes authority (header-only credentials, proxied API): never on a real ReadyPackets origin,
    // in any NODE_ENV or protocol, including alias hosts. (The marketing origin is an outbound link only.)
    const hosts = [origin.hostname, ...config.aliasHosts];
    if (hosts.some(isReadyPacketsHost)) {
      err("RP_DEPLOYMENT_PROFILE", "the preview profile must never be used on a readypackets.com origin");
    }
    if (env.RP_PREVIEW_ACKNOWLEDGED !== PREVIEW_ACKNOWLEDGEMENT) {
      err("RP_PREVIEW_ACKNOWLEDGED", `must be exactly ${PREVIEW_ACKNOWLEDGEMENT} when the preview profile is used`);
    }
  } else if (env.RP_PREVIEW_ACKNOWLEDGED !== undefined) {
    warn("RP_PREVIEW_ACKNOWLEDGED", "has no effect outside the preview profile; remove it");
  }
  if (config.aliasHosts.includes(origin.hostname)) err("RP_ALIAS_HOSTS", "must not contain the canonical hostname");
  if (config.previousIndexKey) warn("RP_INDEX_KEY_PREVIOUS", "a blind-index transition is in progress; remove once complete");

  if (options.collectWarnings) {
    for (const name of Object.keys(env)) {
      if ((name.startsWith("RP_") || name === "DATABASE_URL_FILE") && !KNOWN_NAMES.has(name)) warn(name, "unrecognized variable (typo?)");
    }
  }

  const cookieSecure = origin.protocol === "https:";
  const app: AppConfig = Object.freeze({
    ...config,
    aliasHosts: Object.freeze([...config.aliasHosts]) as string[],
    trustedProxies: Object.freeze([...config.trustedProxies]) as string[],
    dataKeyring: Object.freeze({ current: config.dataKeyring.current, keys: Object.freeze({ ...config.dataKeyring.keys }) }),
    previewTransportEnabled: config.deploymentProfile === "preview",
    cookieSecure,
    // __Host- requires Secure + Path=/ + no Domain. Plain-http local development uses an unprefixed name.
    sessionCookieName: cookieSecure ? "__Host-rp_session" : "rp_session_dev",
    csrfCookieName: cookieSecure ? "__Host-rp_csrf" : "rp_csrf_dev",
  });
  return { problems, config: app };
}

function keyringRule(issue: z.core.$ZodIssue): string {
  // Never include key ids from the record path beyond the fixed shape; ids are not secret but keep output stable.
  if (issue.code === "unrecognized_keys") return "has unexpected fields (only current and keys are allowed)";
  if (issue.path.length >= 3) return `key ${String(issue.path[2])}: ${issue.message}`;
  return issue.message === "Invalid input: expected object, received undefined" ? "is required" : issue.message;
}

/** readypackets.com or any subdomain (case-insensitive, trailing dot tolerated). */
export function isReadyPacketsHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "readypackets.com" || host.endsWith(".readypackets.com");
}

function dbUrlFacts(value: string): { user: string; password: string } | null {
  try {
    const url = new URL(value);
    return { user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
  } catch {
    return null;
  }
}

/** Loads and validates configuration. Throws ConfigError (variable + rule, never values). */
export function loadConfig(env: Env = process.env, options: SecretFileOptions = {}): AppConfig {
  const result = evaluate(env, options);
  const errors = result.problems.filter((p) => p.severity === "error");
  if (errors.length > 0 || !result.config) throw new ConfigError(errors);
  return result.config;
}

export interface ConfigDiagnosis {
  ok: boolean;
  problems: ConfigProblem[];
}

/** Doctor: every problem (errors + warnings) by variable name and rule. Never returns values. */
export function diagnoseConfig(env: Env = process.env, options: SecretFileOptions = {}): ConfigDiagnosis {
  const result = evaluate(env, { ...options, collectWarnings: true });
  return { ok: !result.problems.some((p) => p.severity === "error") && result.config !== undefined, problems: result.problems };
}

/** Deterministic synthetic configuration for tests. Keys are fixed test vectors, never real secrets. */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const key = (seed: number) => Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + seed * 31) % 251)).toString("base64");
  const base = loadConfig({
    NODE_ENV: "test",
    RP_DEPLOYMENT_PROFILE: "test",
    RP_CANONICAL_ORIGIN: "https://my.readypackets.test",
    RP_ALIAS_HOSTS: "portal.readypackets.test",
    RP_MARKETING_ORIGIN: "https://www.readypackets.test",
    DATABASE_URL: "mysql://test.invalid/none",
    RP_STORAGE_DIR: "/nonexistent/rp-test-storage",
    RP_INSTALLATION_ID: "synthetic-install",
    RP_RELEASE_REF: "test-release",
    RP_DATA_KEYRING: JSON.stringify({ current: "t1", keys: { t1: key(1) } }),
    RP_INDEX_KEY: key(2),
    RP_PSEUDONYM_KEY: key(3),
    RP_TOKEN_HASH_KEY: key(4),
    RP_AUDIT_CHAIN_KEY: key(5),
    RP_LOG_LEVEL: "error",
  });
  return Object.freeze({ ...base, ...overrides });
}

/**
 * For modules that own an optional secret variable (e.g. backup's RP_BACKUP_KEY): applies the same
 * `<NAME>`/`<NAME>_FILE` rules (exclusive, protected file, bounded). Returns undefined when unset;
 * throws ConfigError (variable + rule only) when misconfigured.
 */
export function readSecretEnv(name: string, env: Env = process.env, options: SecretFileOptions = {}): string | undefined {
  const problems: ConfigProblem[] = [];
  const value = readSecretVariable(env, name, problems, options);
  if (problems.length > 0) throw new ConfigError(problems);
  return value;
}
