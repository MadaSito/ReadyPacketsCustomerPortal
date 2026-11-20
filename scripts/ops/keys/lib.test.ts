import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../../server/config/env.js";
import { defaultKeyId, doctor, generateAll, HMAC_KEY_VARIABLES, parseKeyring, retireKey, rotateKeyring, writeSecretFiles } from "./lib.js";

const dir = mkdtempSync(join(tmpdir(), "rp-keys-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const base = {
  NODE_ENV: "production",
  RP_CANONICAL_ORIGIN: "https://my.readypackets.com",
  DATABASE_URL: "mysql://rp_app:Zq8-synthetic-Long-Pass-91@db.internal.test/rp",
  RP_STORAGE_DIR: "/srv/readypackets/storage",
  RP_INSTALLATION_ID: "prod-1",
};

describe("key tooling", () => {
  it("generates distinct, valid material that the config loader accepts", () => {
    const secrets = generateAll("k20261120");
    const values = HMAC_KEY_VARIABLES.map((n) => secrets[n]);
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) expect(Buffer.from(v!, "base64")).toHaveLength(32);
    expect(parseKeyring(secrets.RP_DATA_KEYRING!).current).toBe("k20261120");
    expect(() => loadConfig({ ...base, ...secrets })).not.toThrow();
    expect(doctor({ ...base, ...secrets }).ok).toBe(true);
    expect(defaultKeyId(new Date("2026-11-20T23:00:00Z"))).toBe("k20261120");
  });

  it("rotates with dual-read and refuses unsafe retirement", () => {
    const ring = parseKeyring(generateAll("k1").RP_DATA_KEYRING!);
    const rotated = rotateKeyring(ring, "k2");
    expect(rotated.current).toBe("k2");
    expect(rotated.keys.k1).toBe(ring.keys.k1);
    expect(() => rotateKeyring(rotated, "k2")).toThrow(/already exists/);
    expect(() => rotateKeyring(rotated, "Bad Id")).toThrow(/key id/);
    expect(() => retireKey(rotated, "k2")).toThrow(/current/);
    expect(Object.keys(retireKey(rotated, "k1").keys)).toEqual(["k2"]);
    expect(() => parseKeyring(JSON.stringify({ current: "k9", keys: rotated.keys }))).toThrow(/current/);
    expect(() => parseKeyring("{")).toThrow(/JSON/);
  });

  it("writes 0600 files in a 0700 dir, refuses overwrite, and prints paths only", () => {
    const out = join(dir, "secrets");
    const secrets = generateAll("k1");
    const lines = writeSecretFiles(out, secrets);
    expect(statSync(out).mode & 0o777).toBe(0o700);
    for (const line of lines) {
      const [name, file] = line.split("=") as [string, string];
      expect(name.endsWith("_FILE")).toBe(true);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(line).not.toContain(secrets[name.replace(/_FILE$/, "")]!);
    }
    expect(() => writeSecretFiles(out, { RP_INDEX_KEY: "x" })).toThrow(/refusing to overwrite/);
    expect(readFileSync(join(out, "rp_index_key"), "utf8").trim()).toBe(secrets.RP_INDEX_KEY);
    const fileEnv = Object.fromEntries(lines.map((l) => l.split("=") as [string, string]));
    expect(() => loadConfig({ ...base, ...fileEnv }, { uid: process.getuid?.() })).not.toThrow();
  });

  it("doctor reports variable names and rules, never values", () => {
    const secrets = generateAll("k1");
    const report = doctor({ ...base, ...secrets, RP_INDEX_KEY: "c2hvcnQ=" });
    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => e.variable)).toContain("RP_INDEX_KEY");
    expect(JSON.stringify(report)).not.toContain("c2hvcnQ=");
    expect(JSON.stringify(report)).not.toContain(secrets.RP_PSEUDONYM_KEY!);
  });
});
