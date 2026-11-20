import { createHash } from "node:crypto";
import { canonicalJson } from "./json.js";

/**
 * Package content digest: SHA-256 over canonical JSON of the record-file, object and extension inventories.
 * Readers recompute it from the bytes they actually hashed (closes the v1/v2 "packageId shape-only" gap).
 */
export function computeContentDigest(
  records: ReadonlyArray<{ type: string; sha256: string; count: number; bytes: number }>,
  objects: ReadonlyArray<{ sha256: string; size: number }>,
  extensions: ReadonlyArray<{ name: string; sha256: string; count: number; bytes: number }>,
): string {
  const doc = {
    records: records.map((r) => ({ type: r.type, sha256: r.sha256, count: r.count, bytes: r.bytes })),
    objects: objects.map((o) => ({ sha256: o.sha256, size: o.size })),
    extensions: extensions.map((e) => ({ name: e.name, sha256: e.sha256, count: e.count, bytes: e.bytes })),
  };
  return createHash("sha256").update(canonicalJson(doc), "utf8").digest("hex");
}
