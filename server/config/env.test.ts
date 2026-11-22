import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigError, ENV_VARIABLES, diagnoseConfig, isNumericIpOrCidr, isReadyPacketsHost, loadConfig, readSecretEnv, testConfig } from "./env.js";
import { readSecretFile, SecretFileError } from "./secretFiles.js";

const key = (seed: number) => Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 11 + seed * 37) % 256)).toString("base64");
const STRONG_DB = "mysql://rp_app:Zq8-synthetic-Long-Pass-91@db.internal.test/rp";

function prodEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    NODE_ENV: "production",
    RP_CANONICAL_ORIGIN: "https://my.readypackets.com",
    DATABASE_URL: STRONG_DB,
    RP_STORAGE_DIR: "/srv/readypackets/storage",
    RP_INSTALLATION_ID: "prod-1",
    RP_DATA_KEYRING: JSON.stringify({ current: "k2", keys: { k1: key(1), k2: key(2) } }),
    RP_INDEX_KEY: key(3),
    RP_PSEUDONYM_KEY: key(4),
    RP_TOKEN_HASH_KEY: key(5),
    RP_AUDIT_CHAIN_KEY: key(6),
    ...overrides,
  };
}

function problemsOf(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env, { uid: process.getuid?.() });
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return [...(error as ConfigError).issues];
  }
}

const dir = mkdtempSync(join(tmpdir(), "rp-config-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
function secretFile(name: string, content: string, mode = 0o600): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

describe("config: strict validation", () => {
  it("accepts a complete production configuration", () => {
    const config = loadConfig(prodEnv());
    expect(config.deploymentProfile).toBe("production");
    expect(config.cookieSecure).toBe(true);
    expect(config.sessionCookieName).toBe("__Host-rp_session");
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.dataKeyring.keys)).toBe(true);
  });

  it("keeps media path and Protection defaults optional and validates configured values", () => {
    const defaults = loadConfig(prodEnv());
    expect(defaults.ffmpegPath).toBe("/usr/bin/ffmpeg");
    expect(defaults.protectionMmdbPath).toBeUndefined();
    expect(defaults.protectionCountryHeader).toBeUndefined();
    expect(defaults.protectionDisabled).toBe(false);
    expect(loadConfig(prodEnv({
      RP_FFMPEG_PATH: "/opt/readypackets/bin/ffmpeg",
      PROTECTION_MMDB_PATH: "/var/lib/readypackets/geo/country.mmdb",
      PROTECTION_COUNTRY_HEADER: "x-readypackets-country",
      PROTECTION_DISABLED: "1",
    }))).toMatchObject({
      ffmpegPath: "/opt/readypackets/bin/ffmpeg",
      protectionMmdbPath: "/var/lib/readypackets/geo/country.mmdb",
      protectionCountryHeader: "x-readypackets-country",
      protectionDisabled: true,
    });
    const issues = problemsOf(prodEnv({
      RP_FFMPEG_PATH: "ffmpeg",
      PROTECTION_MMDB_PATH: "/tmp/country.mmdb\nunexpected",
      PROTECTION_COUNTRY_HEADER: "x-other-valid-header",
      PROTECTION_DISABLED: "true",
    }));
    expect(issues.map((issue) => issue.split(":")[0])).toEqual([
      "RP_FFMPEG_PATH", "PROTECTION_MMDB_PATH", "PROTECTION_DISABLED", "PROTECTION_COUNTRY_HEADER",
    ]);
    expect(issues.join("\n")).not.toContain("unexpected");
  });

  it("reports every missing required variable by name", () => {
    const issues = problemsOf({ NODE_ENV: "production" });
    for (const name of ["RP_CANONICAL_ORIGIN", "DATABASE_URL", "RP_STORAGE_DIR", "RP_INSTALLATION_ID", "RP_DATA_KEYRING", "RP_INDEX_KEY", "RP_PSEUDONYM_KEY", "RP_TOKEN_HASH_KEY", "RP_AUDIT_CHAIN_KEY"]) {
      expect(issues).toContain(`${name}: is required`);
    }
  });

  it("accepts a random key whose base64 text happens to spell a short template token", () => {
    // 3 bytes -> 4 base64 characters: these keys contain "todo", "XXXX" and "DuMmY" by construction.
    const spelling = (text: string, seed: number) => {
      const bytes = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 11 + seed * 37) % 256));
      Buffer.from(text, "base64").copy(bytes, 3);
      return bytes.toString("base64");
    };
    const keys = { RP_INDEX_KEY: spelling("todo", 21), RP_PSEUDONYM_KEY: spelling("XXXX", 22), RP_AUDIT_CHAIN_KEY: spelling("DuMmYA==", 23) };
    expect(keys.RP_INDEX_KEY).toContain("todo");
    expect(keys.RP_PSEUDONYM_KEY).toContain("XXXX");
    expect(keys.RP_AUDIT_CHAIN_KEY).toContain("DuMmY");
    expect(problemsOf(prodEnv(keys)).filter((issue) => issue.includes("placeholder"))).toEqual([]);
    // Templates are still refused: by the word screen when not a well-formed key, by entropy otherwise.
    const templates = problemsOf(prodEnv({ RP_INDEX_KEY: "todo-set-this-key", RP_PSEUDONYM_KEY: `${"x".repeat(43)}=` }));
    expect(templates).toContain("RP_INDEX_KEY: looks like a placeholder value");
    expect(templates).toContain("RP_PSEUDONYM_KEY: key has too little entropy");
  });

  it("refuses weak, placeholder, malformed and duplicated keys without echoing them", () => {
    const weak = Buffer.alloc(32, 7).toString("base64");
    const issues = problemsOf(prodEnv({ RP_INDEX_KEY: weak, RP_PSEUDONYM_KEY: "change-me-placeholder-value-0000000000000000", RP_TOKEN_HASH_KEY: key(6) }));
    expect(issues).toContain("RP_INDEX_KEY: key has too little entropy");
    expect(issues.some((i) => i.startsWith("RP_PSEUDONYM_KEY: looks like a placeholder"))).toBe(true);
    const joined = issues.join("\n");
    expect(joined).not.toContain(weak);
    expect(joined).not.toContain("change-me");
    // duplicated key between token-hash and audit-chain
    const dup = problemsOf(prodEnv({ RP_TOKEN_HASH_KEY: key(6) }));
    expect(dup).toContain("RP_AUDIT_CHAIN_KEY: must differ from RP_TOKEN_HASH_KEY");
    expect(dup.join("\n")).not.toContain(key(6));
  });

  it("treats base64url and base64 spellings of the same key as duplicates", () => {
    const k = key(9);
    const url = Buffer.from(k, "base64").toString("base64url");
    expect(problemsOf(prodEnv({ RP_INDEX_KEY: k, RP_PSEUDONYM_KEY: url }))).toContain("RP_PSEUDONYM_KEY: must differ from RP_INDEX_KEY");
  });

  it("refuses a keyring whose current key is missing, extra fields, or a key reused as an HMAC key", () => {
    expect(problemsOf(prodEnv({ RP_DATA_KEYRING: JSON.stringify({ current: "k9", keys: { k1: key(1) } }) }))).toContain(
      "RP_DATA_KEYRING: current key id must exist in keys",
    );
    expect(problemsOf(prodEnv({ RP_DATA_KEYRING: JSON.stringify({ current: "k1", keys: { k1: key(1) }, note: "x" }) }))[0]).toMatch(/^RP_DATA_KEYRING:/);
    expect(problemsOf(prodEnv({ RP_DATA_KEYRING: "{not json" }))).toEqual(["RP_DATA_KEYRING: must be valid JSON"]);
    expect(problemsOf(prodEnv({ RP_INDEX_KEY: key(1) }))).toContain("RP_DATA_KEYRING: must differ from RP_INDEX_KEY");
  });

  it("refuses default, short or placeholder database passwords in production, without echoing", () => {
    for (const url of ["mysql://rp:rp_dev_local_only@db/x", "mysql://rp@db/x", "mysql://rp:short@db/x", "mysql://rp:changeme-changeme-changeme@db/x"]) {
      const issues = problemsOf(prodEnv({ DATABASE_URL: url }));
      expect(issues.some((i) => i.startsWith("DATABASE_URL:"))).toBe(true);
      expect(issues.join("\n")).not.toContain(url.split("@")[0]!.split(":")[2] ?? "\u0000");
    }
  });

  it("requires https, absolute storage and NODE_ENV=production for the production profile", () => {
    expect(problemsOf(prodEnv({ RP_CANONICAL_ORIGIN: "http://my.readypackets.com" }))).toContain("RP_CANONICAL_ORIGIN: production requires an https origin");
    expect(problemsOf(prodEnv({ RP_STORAGE_DIR: "relative/dir" }))).toContain("RP_STORAGE_DIR: must be an absolute path in production");
    expect(problemsOf(prodEnv({ NODE_ENV: "development", RP_DEPLOYMENT_PROFILE: "production" }))).toContain(
      "NODE_ENV: production profile requires NODE_ENV=production",
    );
    expect(problemsOf(prodEnv({ RP_DEPLOYMENT_PROFILE: "development" }))).toContain("RP_DEPLOYMENT_PROFILE: NODE_ENV=production requires the production profile");
  });

  it("refuses origins with paths, trailing slashes or credentials", () => {
    for (const origin of ["https://my.readypackets.com/", "https://my.readypackets.com/app", "https://u:p@my.readypackets.com", "ftp://my.readypackets.com"]) {
      expect(problemsOf(prodEnv({ RP_CANONICAL_ORIGIN: origin })).some((i) => i.startsWith("RP_CANONICAL_ORIGIN:"))).toBe(true);
    }
  });

  it("never allows the preview profile on readypackets.com or any subdomain, in any NODE_ENV or protocol", () => {
    for (const nodeEnv of ["production", "development", "test"]) {
      for (const origin of ["https://my.readypackets.com", "http://preview.readypackets.com", "https://READYPACKETS.COM"]) {
        const issues = problemsOf(prodEnv({ NODE_ENV: nodeEnv, RP_DEPLOYMENT_PROFILE: "preview", RP_CANONICAL_ORIGIN: origin }));
        expect(issues).toContain("RP_DEPLOYMENT_PROFILE: the preview profile must never be used on a readypackets.com origin");
      }
    }
    // alias hosts are protected too
    expect(problemsOf(prodEnv({ NODE_ENV: "development", RP_DEPLOYMENT_PROFILE: "preview", RP_CANONICAL_ORIGIN: "https://demo.example.test", RP_ALIAS_HOSTS: "portal.readypackets.com" }))).toContain(
      "RP_DEPLOYMENT_PROFILE: the preview profile must never be used on a readypackets.com origin",
    );
    // the default marketing origin is an outbound link only and does not block preview
    const preview = loadConfig(prodEnv({ NODE_ENV: "development", RP_DEPLOYMENT_PROFILE: "preview", RP_PREVIEW_ACKNOWLEDGED: "synthetic-data-only", RP_CANONICAL_ORIGIN: "https://demo.example.test" }));
    expect(preview.previewTransportEnabled).toBe(true);
    expect(isReadyPacketsHost("notreadypackets.com")).toBe(false);
    expect(isReadyPacketsHost("my.readypackets.com.")).toBe(true);
  });

  it("requires the exact synthetic-data acknowledgement for the preview profile in every NODE_ENV", () => {
    const rule = "RP_PREVIEW_ACKNOWLEDGED: must be exactly synthetic-data-only when the preview profile is used";
    for (const nodeEnv of ["production", "development", "test"]) {
      for (const ack of [undefined, "", "yes", "synthetic-data-only ", "SYNTHETIC-DATA-ONLY"]) {
        const issues = problemsOf(prodEnv({ NODE_ENV: nodeEnv, RP_DEPLOYMENT_PROFILE: "preview", RP_CANONICAL_ORIGIN: "https://demo.example.test", RP_PREVIEW_ACKNOWLEDGED: ack }));
        expect(issues).toContain(rule);
      }
      const ok = problemsOf(prodEnv({ NODE_ENV: nodeEnv, RP_DEPLOYMENT_PROFILE: "preview", RP_CANONICAL_ORIGIN: "https://demo.example.test", RP_PREVIEW_ACKNOWLEDGED: "synthetic-data-only" }));
      expect(ok).not.toContain(rule);
    }
    // acknowledgement never unlocks a readypackets.com origin
    expect(problemsOf(prodEnv({ RP_DEPLOYMENT_PROFILE: "preview", RP_PREVIEW_ACKNOWLEDGED: "synthetic-data-only" }))).toContain(
      "RP_DEPLOYMENT_PROFILE: the preview profile must never be used on a readypackets.com origin",
    );
    const diagnosis = diagnoseConfig(prodEnv({ RP_PREVIEW_ACKNOWLEDGED: "synthetic-data-only" }));
    expect(diagnosis.problems).toContainEqual({ variable: "RP_PREVIEW_ACKNOWLEDGED", rule: "has no effect outside the preview profile; remove it", severity: "warning" });
  });

  it("accepts only exact numeric trusted-proxy IPs/CIDRs", () => {
    for (const ok of ["127.0.0.1", "10.0.0.0/8", "::1", "fd00::/8", "192.168.1.1/32"]) expect(isNumericIpOrCidr(ok)).toBe(true);
    for (const bad of ["loopback", "linklocal", "uniquelocal", "256.1.1.1", "10.0.0.0/33", "::1/129", "01.2.3.4", "1.2.3.4/8/1", "*", "example.test"]) {
      expect(isNumericIpOrCidr(bad)).toBe(false);
    }
    expect(problemsOf(prodEnv({ RP_TRUSTED_PROXIES: "127.0.0.1,loopback" }))).toContain("RP_TRUSTED_PROXIES: must be an exact numeric IP address or CIDR");
  });

  it("refuses non-numeric ports and pool sizes", () => {
    expect(problemsOf(prodEnv({ PORT: "80; rm -rf /" })).some((i) => i.startsWith("PORT:"))).toBe(true);
    expect(problemsOf(prodEnv({ RP_DB_POOL_SIZE: "0x10" })).some((i) => i.startsWith("RP_DB_POOL_SIZE:"))).toBe(true);
  });

  it("keeps the deterministic test configuration valid", () => {
    expect(testConfig().deploymentProfile).toBe("test");
  });
});

describe("config: secret files", () => {
  const uid = process.getuid?.();

  it("loads <NAME>_FILE secrets and trims whitespace", () => {
    const path = secretFile("index.key", `${key(3)}\n`);
    const config = loadConfig(prodEnv({ RP_INDEX_KEY: undefined, RP_INDEX_KEY_FILE: path }), { uid });
    expect(config.indexKey).toBe(key(3));
  });

  it("refuses setting both NAME and NAME_FILE", () => {
    const path = secretFile("both.key", key(3));
    expect(problemsOf(prodEnv({ RP_INDEX_KEY_FILE: path }))).toContain("RP_INDEX_KEY: set only one of RP_INDEX_KEY or RP_INDEX_KEY_FILE");
  });

  it("refuses world-readable, group-writable, missing, empty, oversized and non-regular files", () => {
    expect(() => readSecretFile("X_FILE", secretFile("world.key", key(3), 0o644), { uid })).toThrow(SecretFileError);
    expect(() => readSecretFile("X_FILE", secretFile("gw.key", key(3), 0o660), { uid })).toThrow(/too broad/);
    expect(readSecretFile("X_FILE", secretFile("group-read.key", key(3), 0o640), { uid })).toBe(key(3));
    expect(() => readSecretFile("X_FILE", join(dir, "absent"), { uid })).toThrow(/unreadable or missing/);
    expect(() => readSecretFile("X_FILE", secretFile("empty.key", "  \n"), { uid })).toThrow(/empty/);
    expect(() => readSecretFile("X_FILE", secretFile("big.key", "a".repeat(70_000)), { uid })).toThrow(/64 KiB/);
    expect(() => readSecretFile("X_FILE", dir, { uid })).toThrow(SecretFileError);
  });

  it("refuses files owned by another non-root user", () => {
    const path = secretFile("owner.key", key(3));
    expect(() => readSecretFile("X_FILE", path, { uid: (uid ?? 1000) + 12345 })).toThrow(/owned by the service user or root/);
  });

  it("checks the symlink target, not the link", () => {
    const target = secretFile("target.key", key(3), 0o644);
    const link = join(dir, "link.key");
    symlinkSync(target, link);
    expect(() => readSecretFile("X_FILE", link, { uid })).toThrow(/too broad/);
  });

  it("never includes file contents or paths in errors", () => {
    const path = secretFile("leak.key", "SUPER-SECRET-SYNTHETIC-VALUE", 0o644);
    const issues = problemsOf(prodEnv({ RP_INDEX_KEY: undefined, RP_INDEX_KEY_FILE: path }));
    expect(issues).toEqual(["RP_INDEX_KEY_FILE: file permissions are too broad (must not be group/other writable or other readable)"]);
    expect(issues.join("")).not.toContain("SUPER-SECRET");
    expect(issues.join("")).not.toContain(dir);
  });

  it("refuses _FILE on non-secret variables", () => {
    expect(problemsOf(prodEnv({ RP_STORAGE_DIR_FILE: "/x" }))).toContain("RP_STORAGE_DIR_FILE: only secret variables support _FILE");
  });

  it("readSecretEnv applies the same rules for module-owned secrets", () => {
    expect(readSecretEnv("RP_BACKUP_KEY", {})).toBeUndefined();
    expect(readSecretEnv("RP_BACKUP_KEY", { RP_BACKUP_KEY_FILE: secretFile("backup.key", key(7)) }, { uid })).toBe(key(7));
    expect(() => readSecretEnv("RP_BACKUP_KEY", { RP_BACKUP_KEY: "a", RP_BACKUP_KEY_FILE: "/x" })).toThrow(ConfigError);
  });
});

describe("config: doctor", () => {
  it("reports errors and warnings by variable name only", () => {
    const diagnosis = diagnoseConfig(prodEnv({ RP_LOG_LEVEL: "debug", RP_INDEXKEY: "typo-value", DATABASE_URL: "mysql://root:Zq8-synthetic-Long-Pass-91@db/x" }));
    expect(diagnosis.ok).toBe(true);
    const text = JSON.stringify(diagnosis);
    expect(diagnosis.problems).toContainEqual({ variable: "RP_INDEXKEY", rule: "unrecognized variable (typo?)", severity: "warning" });
    expect(diagnosis.problems).toContainEqual(expect.objectContaining({ variable: "RP_LOG_LEVEL", severity: "warning" }));
    expect(diagnosis.problems).toContainEqual(expect.objectContaining({ variable: "DATABASE_URL", severity: "warning" }));
    expect(text).not.toContain("typo-value");
    expect(text).not.toContain("Zq8");
    expect(diagnoseConfig({ NODE_ENV: "production" }).ok).toBe(false);
  });

  it("env.example documents every variable and carries no values", () => {
    const example = readFileSync(join(import.meta.dirname, "env.example"), "utf8");
    for (const variable of ENV_VARIABLES) expect(example).toMatch(new RegExp(`^${variable.name}=$`, "m"));
    for (const line of example.split("\n")) {
      if (/^[A-Z_]+=/.test(line)) expect(line).toMatch(/^[A-Z0-9_]+=$/);
    }
  });
});
