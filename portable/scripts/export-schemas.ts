/**
 * Exports the contract-v3 Zod schemas as JSON Schema (draft 2020-12) documents into portable/schemas/v3/.
 *   tsx portable/scripts/export-schemas.ts
 * A test (schemas.test.ts) fails when the committed files are stale.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { ManifestSchema, CONTRACT_VERSION } from "../src/contract/manifest.js";
import { RECORD_SCHEMAS, RECORD_TYPE_ORDER } from "../src/contract/records.js";

export const SCHEMA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "schemas", "v3");
const BASE = "https://schemas.readypackets.example/portable/v3/";

export function buildSchemas(): Map<string, string> {
  const out = new Map<string, string>();
  const emit = (name: string, schema: z.ZodType, title: string) => {
    const doc = { $id: `${BASE}${name}`, title, ...z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any", io: "input" }) };
    out.set(name, JSON.stringify(doc, null, 2) + "\n");
  };
  emit("manifest.schema.json", ManifestSchema, `ReadyPackets portable manifest (contract ${CONTRACT_VERSION})`);
  for (const type of RECORD_TYPE_ORDER) emit(`records/${type}.schema.json`, RECORD_SCHEMAS[type] as z.ZodType, `ReadyPackets portable record: ${type} (contract ${CONTRACT_VERSION})`);
  return out;
}

export async function writeSchemas(dir = SCHEMA_DIR): Promise<number> {
  const docs = buildSchemas();
  await mkdir(path.join(dir, "records"), { recursive: true });
  for (const [name, text] of docs) await writeFile(path.join(dir, name), text);
  return docs.size;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  writeSchemas().then(
    (n) => process.stdout.write(`wrote ${n} schema documents to ${SCHEMA_DIR}\n`),
    (e: unknown) => {
      process.stderr.write(`schema export failed: ${e instanceof Error ? e.message : "unknown error"}\n`);
      process.exitCode = 1;
    },
  );
}
