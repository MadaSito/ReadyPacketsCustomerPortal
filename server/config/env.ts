/**
 * Validated runtime configuration. Owner: platform module (initial version by integrator).
 *
 * Rules:
 *  - No defaults for secrets. Missing/weak/placeholder secrets refuse startup (fail closed).
 *  - Secrets may be supplied as `<NAME>_FILE` pointing at a root-owned 0600/0640 file (preferred on hosts).
 *  - Configuration is DATA: nothing here is ever sourced or executed.
 *  - Optional providers stay inert until deliberately and completely configured (in the database
 *    settings store, not here).
 */
import { readFileSync } from "node:fs";
import { z } from "zod";

export const DEPLOYMENT_PROFILES = ["production", "development", "test", "preview"] as const;
export type DeploymentProfile = (typeof DEPLOYMENT_PROFILES)[number];

const base64Key32 = z
  .string()
  .regex(/^[A-Za-z0-9+/_-]{43,44}=?$/, "must be 32 random bytes, base64/base64url encoded")
  .refine((value) => Buffer.from(value, "base64").length === 32, "must decode to exactly 32 bytes")
  .refine((value) => new Set(Buffer.from(value, "base64")).size >= 12, "key has too little entropy");

const keyringSchema = z
  .object({
    /** Key id used for new encryptions. */
    current: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
    /** All readable keys, including retired-but-retained ids for dual-read. */
    keys: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/), base64Key32),
  })
  .refine((ring) => ring.current in ring.keys, "current key id must exist in keys");
export type DataKeyring = z.infer<typeof keyringSchema>;

const originSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password;
  }, "must be a bare origin such as https://my.readypackets.com");

const configSchema = z.object({
  nodeEnv: z.enum(["production", "development", "test"]),
  deploymentProfile: z.enum(DEPLOYMENT_PROFILES),
  role: z.enum(["web", "worker", "all"]),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  /** The single canonical cookie/CSRF origin. */
  canonicalOrigin: originSchema,
  /** Explicit alias hosts that 308-redirect to the canonical origin (never parallel auth origins). */
  aliasHosts: z.array(z.string().regex(/^[a-z0-9.-]+$/)).max(8),
  marketingOrigin: originSchema,
  /** CIDRs/IPs of reverse proxies whose X-Forwarded-* headers are trusted. Empty = trust none. */
  trustedProxies: z.array(z.string().min(1)).max(16),
  databaseUrl: z.string().regex(/^mysql:\/\//, "must be a mysql:// URL"),
  databasePoolSize: z.number().int().min(1).max(64),
  /** Private object storage root, outside any web root. */
  storageDir: z.string().min(1),
  installationId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/),
  releaseRef: z.string().min(1).max(80),
  serviceName: z.string().min(1).max(40),
  dataKeyring: keyringSchema,
  indexKey: base64Key32,
  pseudonymKey: base64Key32,
  tokenHashKey: base64Key32,
  auditChainKey: base64Key32,
  logLevel: z.enum(["debug", "info", "warn", "error"]),
});

export type AppConfig = Readonly<z.infer<typeof configSchema>> & {
  /** True only for the sandboxed preview profile: enables hash routing + in-memory header session transport. */
  readonly previewTransportEnabled: boolean;
  readonly cookieSecure: boolean;
  readonly sessionCookieName: string;
  readonly csrfCookieName: string;
};

type Env = Record<string, string | undefined>;

function readSecret(env: Env, name: string): string | undefined {
  const filePath = env[`${name}_FILE`];
  if (filePath) {
    return readFileSync(filePath, "utf8").trim();
  }
  return env[name];
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export class ConfigError extends Error {
  constructor(public readonly issues: readonly string[]) {
    // Issue text names the variable and rule only — never the offending value.
    super(`Invalid configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: Env = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  const profile = env.RP_DEPLOYMENT_PROFILE ?? (nodeEnv === "production" ? "production" : nodeEnv);
  let keyring: unknown;
  try {
    keyring = JSON.parse(readSecret(env, "RP_DATA_KEYRING") ?? "null");
  } catch {
    keyring = null;
  }
  const candidate = {
    nodeEnv,
    deploymentProfile: profile,
    role: env.RP_ROLE ?? "all",
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 5000),
    canonicalOrigin: env.RP_CANONICAL_ORIGIN,
    aliasHosts: list(env.RP_ALIAS_HOSTS),
    marketingOrigin: env.RP_MARKETING_ORIGIN ?? "https://www.readypackets.com",
    trustedProxies: list(env.RP_TRUSTED_PROXIES),
    databaseUrl: readSecret(env, "DATABASE_URL"),
    databasePoolSize: Number(env.RP_DB_POOL_SIZE ?? 10),
    storageDir: env.RP_STORAGE_DIR,
    installationId: env.RP_INSTALLATION_ID,
    releaseRef: env.RP_RELEASE_REF ?? "unreleased",
    serviceName: env.RP_SERVICE_NAME ?? "portal",
    dataKeyring: keyring,
    indexKey: readSecret(env, "RP_INDEX_KEY"),
    pseudonymKey: readSecret(env, "RP_PSEUDONYM_KEY"),
    tokenHashKey: readSecret(env, "RP_TOKEN_HASH_KEY"),
    auditChainKey: readSecret(env, "RP_AUDIT_CHAIN_KEY"),
    logLevel: env.RP_LOG_LEVEL ?? "info",
  };
  const parsed = configSchema.safeParse(candidate);
  const issues: string[] = [];
  if (!parsed.success) {
    for (const issue of parsed.error.issues) issues.push(`${issue.path.join(".")}: ${issue.message}`);
    throw new ConfigError(issues);
  }
  const config = parsed.data;
  const distinct = new Set([
    config.indexKey,
    config.pseudonymKey,
    config.tokenHashKey,
    config.auditChainKey,
    ...Object.values(config.dataKeyring.keys),
  ]);
  if (distinct.size !== 4 + Object.keys(config.dataKeyring.keys).length) {
    issues.push("keys: every key (data, index, pseudonym, token-hash, audit-chain) must be distinct");
  }
  const origin = new URL(config.canonicalOrigin);
  if (config.deploymentProfile === "production") {
    if (config.nodeEnv !== "production") issues.push("nodeEnv: production profile requires NODE_ENV=production");
    if (origin.protocol !== "https:") issues.push("canonicalOrigin: production requires an https origin");
  }
  if (config.deploymentProfile === "preview" && config.nodeEnv === "production" && origin.protocol === "https:" && origin.hostname.endsWith("readypackets.com")) {
    issues.push("deploymentProfile: the preview profile must never be used on a readypackets.com origin");
  }
  if (issues.length > 0) throw new ConfigError(issues);

  const cookieSecure = origin.protocol === "https:";
  return Object.freeze({
    ...config,
    previewTransportEnabled: config.deploymentProfile === "preview",
    cookieSecure,
    // __Host- requires Secure + Path=/ + no Domain. Plain-http local development uses an unprefixed name.
    sessionCookieName: cookieSecure ? "__Host-rp_session" : "rp_session_dev",
    csrfCookieName: cookieSecure ? "__Host-rp_csrf" : "rp_csrf_dev",
  });
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
