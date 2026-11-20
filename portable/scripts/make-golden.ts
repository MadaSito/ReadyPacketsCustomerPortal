/**
 * Regenerates the synthetic golden fixture portable/fixtures/golden-v3.rpkg (deterministic: seeded
 * randomness, fixed time, test KDF parameters). Passphrase: see portable/fixtures/README.md.
 *   tsx portable/scripts/make-golden.ts
 */
import { copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, tmpDir, writeSample } from "../tests/fixtures.js";

const target = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "golden-v3.rpkg");
const dir = await tmpDir();
try {
  const { file, result } = await writeSample(dir);
  await copyFile(file, target);
  process.stdout.write(`golden fixture ${result.packageId} ${result.bytes} bytes sha256 ${result.ciphertextSha256}\n`);
} finally {
  await cleanup(dir);
}
