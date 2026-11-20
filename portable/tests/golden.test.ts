/** Golden fixture + exported JSON Schema documents are current and reproducible. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPackage } from "../src/reader.js";
import { RECORD_TYPE_ORDER } from "../src/contract/records.js";
import { SCHEMA_DIR, buildSchemas } from "../scripts/export-schemas.js";
import { PASS, cleanup, tmpDir, writeSample } from "./fixtures.js";

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "golden-v3.rpkg");
let dir: string;
beforeAll(async () => {
  dir = await tmpDir();
});
afterAll(async () => cleanup(dir));

describe("golden fixture", () => {
  it("rebuilds byte-identically (deterministic writer)", async () => {
    const { file } = await writeSample(dir);
    expect((await readFile(file)).equals(await readFile(GOLDEN))).toBe(true);
  });

  it("verifies and contains every record type", async () => {
    const pkg = await openPackage({ input: GOLDEN, passphrase: PASS });
    try {
      const r = await pkg.verify();
      expect(r.ok).toBe(true);
      expect(Object.keys(r.counts).sort()).toEqual([...RECORD_TYPE_ORDER].sort());
    } finally {
      await pkg.close();
    }
  });
});

describe("exported JSON Schemas", () => {
  it("committed schema documents match the Zod contract (run portable/scripts/export-schemas.ts)", async () => {
    const docs = buildSchemas();
    expect(docs.size).toBe(RECORD_TYPE_ORDER.length + 1);
    for (const [name, text] of docs) expect(await readFile(path.join(SCHEMA_DIR, name), "utf8"), name).toBe(text);
  });

  it("record schemas are closed (strict) and declare heldUnknown", () => {
    for (const [name, text] of buildSchemas()) {
      if (!name.startsWith("records/")) continue;
      const doc = JSON.parse(text) as { additionalProperties?: unknown; properties: Record<string, unknown> };
      expect(doc.additionalProperties, name).toBe(false);
      expect(doc.properties, name).toHaveProperty("heldUnknown");
    }
  });
});
