/**
 * Generates fresh key material for a new installation, or rotates the data keyring.
 *
 *   pnpm tsx scripts/ops/keys/generate.ts --out-dir /etc/readypackets/secrets [--key-id k20261120]
 *       New install: writes RP_DATA_KEYRING + the four HMAC keys as 0600 files (refuses to overwrite)
 *       and prints only the `<NAME>_FILE=<path>` lines. Recommended.
 *   pnpm tsx scripts/ops/keys/generate.ts --stdout [--key-id …]
 *       Prints `NAME=value` lines ONCE to stdout (for piping into a secret manager). Never logged.
 *   RP_DATA_KEYRING_FILE=… pnpm tsx scripts/ops/keys/generate.ts --rotate-data-key --out-dir DIR [--key-id …]
 *       Writes a NEW keyring file (old keys retained for dual-read, new key current) to DIR.
 *   … --retire-data-key <id> --out-dir DIR   — only after the re-encryption report shows 0 envelopes.
 *
 * Exit codes: 0 ok · 64 usage · 1 failure. Error messages never contain key material.
 */
import { readFileSync } from "node:fs";
import { defaultKeyId, generateAll, parseKeyring, retireKey, rotateKeyring, writeSecretFiles } from "./lib.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(name);

function main(): number {
  const keyId = arg("--key-id") ?? defaultKeyId(new Date());
  const outDir = arg("--out-dir");
  try {
    if (has("--rotate-data-key") || has("--retire-data-key")) {
      const file = process.env.RP_DATA_KEYRING_FILE;
      if (!file || !outDir) {
        console.error("Usage: RP_DATA_KEYRING_FILE=<current keyring file> generate.ts --rotate-data-key|--retire-data-key <id> --out-dir <dir>");
        return 64;
      }
      const ring = parseKeyring(readFileSync(file, "utf8").trim());
      const retire = arg("--retire-data-key");
      const next = has("--rotate-data-key") ? rotateKeyring(ring, keyId) : retireKey(ring, retire ?? "");
      for (const line of writeSecretFiles(outDir, { RP_DATA_KEYRING: JSON.stringify(next) })) console.log(line);
      console.error(`Keyring written. current=${next.current} retained=${Object.keys(next.keys).sort().join(",")}`);
      return 0;
    }
    const secrets = generateAll(keyId);
    if (outDir) {
      for (const line of writeSecretFiles(outDir, secrets)) console.log(line);
      return 0;
    }
    if (has("--stdout")) {
      for (const [name, value] of Object.entries(secrets)) console.log(`${name}=${value}`);
      return 0;
    }
    console.error("Usage: generate.ts --out-dir <dir> | --stdout  [--key-id <id>]");
    return 64;
  } catch (error) {
    console.error(`Key generation failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return 1;
  }
}

process.exitCode = main();
