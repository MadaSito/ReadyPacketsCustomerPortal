/**
 * Pure key-material helpers for the operator CLIs in this folder. Owner: platform engineer.
 * Nothing here logs; callers decide where (and whether) material is written.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { diagnoseConfig, type ConfigProblem } from "../../../server/config/env.js";

export const KEY_ID_PATTERN = /^[a-z0-9-]{1,32}$/;
export const MAX_RETAINED_KEYS = 16;

export interface Keyring {
  current: string;
  keys: Record<string, string>;
}

/** Single-purpose 32-byte HMAC keys. Each must be distinct; never reuse one value for two purposes. */
export const HMAC_KEY_VARIABLES = ["RP_INDEX_KEY", "RP_PSEUDONYM_KEY", "RP_TOKEN_HASH_KEY", "RP_AUDIT_CHAIN_KEY"] as const;

export const newKey = (): string => randomBytes(32).toString("base64");

/** Default key id: `k<YYYYMMDD>` (UTC) — sortable, carries no secret information. */
export function defaultKeyId(now: Date): string {
  return `k${now.toISOString().slice(0, 10).replaceAll("-", "")}`;
}

export function assertKeyId(id: string): void {
  if (!KEY_ID_PATTERN.test(id)) throw new Error("key id must match [a-z0-9-]{1,32}");
}

export function newKeyring(keyId: string): Keyring {
  assertKeyId(keyId);
  return { current: keyId, keys: { [keyId]: newKey() } };
}

export function parseKeyring(raw: string): Keyring {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("keyring is not valid JSON");
  }
  const ring = value as Partial<Keyring> | null;
  if (!ring || typeof ring.current !== "string" || typeof ring.keys !== "object" || ring.keys === null) throw new Error("keyring must be {current, keys}");
  for (const [id, key] of Object.entries(ring.keys)) {
    assertKeyId(id);
    if (typeof key !== "string" || Buffer.from(key, "base64").length !== 32) throw new Error(`key ${id} is not 32 bytes of base64`);
  }
  if (!(ring.current in ring.keys)) throw new Error("current key id must exist in keys");
  return { current: ring.current, keys: { ...ring.keys } };
}

/** Rotation step 1: add a new key and make it current. Old keys stay readable (dual-read). */
export function rotateKeyring(ring: Keyring, keyId: string): Keyring {
  assertKeyId(keyId);
  if (keyId in ring.keys) throw new Error("key id already exists in the keyring");
  if (Object.keys(ring.keys).length + 1 > MAX_RETAINED_KEYS) throw new Error(`at most ${MAX_RETAINED_KEYS} keys may be retained; retire one first`);
  return { current: keyId, keys: { ...ring.keys, [keyId]: newKey() } };
}

/** Retirement: only after the re-encryption report shows zero envelopes under `keyId` (see RUNBOOK.md). */
export function retireKey(ring: Keyring, keyId: string): Keyring {
  if (keyId === ring.current) throw new Error("the current key cannot be retired");
  if (!(keyId in ring.keys)) throw new Error("key id is not in the keyring");
  const keys = { ...ring.keys };
  delete keys[keyId];
  return { current: ring.current, keys };
}

export function generateAll(keyId: string): Record<string, string> {
  const out: Record<string, string> = { RP_DATA_KEYRING: JSON.stringify(newKeyring(keyId)) };
  for (const name of HMAC_KEY_VARIABLES) out[name] = newKey();
  return out;
}

/**
 * Writes each secret to `<dir>/<name>` with mode 0600 in a 0700 directory, refusing to overwrite.
 * Returns the `<NAME>_FILE=<path>` lines to put in the service environment (paths only, no values).
 */
export function writeSecretFiles(dir: string, secrets: Record<string, string>): string[] {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const lines: string[] = [];
  for (const [name, value] of Object.entries(secrets)) {
    const file = path.join(dir, name.toLowerCase());
    if (existsSync(file)) throw new Error(`${file} already exists; refusing to overwrite key material`);
    writeFileSync(file, `${value}\n`, { mode: 0o600, flag: "wx" });
    lines.push(`${name}_FILE=${file}`);
  }
  return lines;
}

export interface DoctorReport {
  ok: boolean;
  errors: ConfigProblem[];
  warnings: ConfigProblem[];
}

/** Configuration diagnosis by variable name and rule only — values are never included. */
export function doctor(env: NodeJS.ProcessEnv): DoctorReport {
  const diagnosis = diagnoseConfig(env);
  return {
    ok: diagnosis.ok,
    errors: diagnosis.problems.filter((p) => p.severity === "error"),
    warnings: diagnosis.problems.filter((p) => p.severity === "warning"),
  };
}
