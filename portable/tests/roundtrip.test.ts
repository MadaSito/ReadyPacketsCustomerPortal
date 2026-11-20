import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPackage } from "../src/reader.js";
import { createPackageWriter } from "../src/writer.js";
import { RECORD_TYPE_ORDER } from "../src/contract/records.js";
import { PortableError } from "../src/errors.js";
import { FAST_KDF, ID, OBJECT_BYTES, OBJECT_SHA, PASS, T, cleanup, decryptToZip, sampleRecords, seededRandom, tmpDir, writeSample } from "./fixtures.js";

let dir: string;
beforeAll(async () => {
  dir = await tmpDir();
});
afterAll(async () => cleanup(dir));

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("portable v3 round trip", () => {
  it("writes, verifies and reads every record type and object", async () => {
    const { file, result } = await writeSample(dir);
    expect(result.manifest.records.map((r) => r.type)).toEqual(RECORD_TYPE_ORDER.filter((t) => sampleRecords().some(([x]) => x === t)));
    expect(result.ciphertextSha256).toBe(createHash("sha256").update(await readFile(file)).digest("hex"));
    const pkg = await openPackage({ input: file, passphrase: PASS });
    try {
      const report = await pkg.verify();
      expect(report.issues).toEqual([]);
      expect(report.ok).toBe(true);
      expect(report.sourceFormat).toBe("v3");
      expect(report.counts.customers).toBe(2);
      expect(report.objects).toEqual({ count: 1, bytes: OBJECT_BYTES.length });
      expect(report.heldUnknown).toBe(1);
      expect(report.manifestSha256).toBe(result.manifestSha256);
      expect(report.ciphertextSha256).toBe(result.ciphertextSha256);
      const customers = await collect(pkg.records("customers"));
      expect(customers[0]).toEqual(sampleRecords()[0]![1]);
      const all = await collect(pkg.allRecords());
      expect(all.length).toBe(sampleRecords().length);
      // dependency order: types appear in RECORD_TYPE_ORDER
      const order = all.map((e) => RECORD_TYPE_ORDER.indexOf(e.type));
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(pkg.listObjects()).toEqual([{ sha256: OBJECT_SHA, size: OBJECT_BYTES.length }]);
      const bytes = Buffer.concat(await collect((await pkg.openObject(OBJECT_SHA)) as AsyncIterable<Buffer>));
      expect(bytes.equals(OBJECT_BYTES)).toBe(true);
      // independent re-open of the same object
      const again = Buffer.concat(await collect((await pkg.openObject(OBJECT_SHA)) as AsyncIterable<Buffer>));
      expect(again.equals(OBJECT_BYTES)).toBe(true);
    } finally {
      await pkg.close();
    }
  });

  it("refuses records/objects before verify()", async () => {
    const { file } = await writeSample(dir, {}, "nv.rpkg");
    const pkg = await openPackage({ input: file, passphrase: PASS });
    try {
      await expect(collect(pkg.records("orders"))).rejects.toMatchObject({ code: "NOT_VERIFIED" });
      await expect(pkg.openObject(OBJECT_SHA)).rejects.toMatchObject({ code: "NOT_VERIFIED" });
    } finally {
      await pkg.close();
    }
  });

  it("produces byte-identical output for identical input and randomness (deterministic)", async () => {
    const a = await writeSample(dir, { randomBytes: seededRandom("det") }, "det-a.rpkg");
    const b = await writeSample(dir, { randomBytes: seededRandom("det") }, "det-b.rpkg");
    expect(a.result.ciphertextSha256).toBe(b.result.ciphertextSha256);
    // Different salt ⇒ different ciphertext, same authenticated plaintext archive.
    const c = await writeSample(dir, { randomBytes: seededRandom("other") }, "det-c.rpkg");
    expect(c.result.ciphertextSha256).not.toBe(a.result.ciphertextSha256);
    expect((await decryptToZip(c.file)).equals(await decryptToZip(a.file))).toBe(true);
    expect(c.result.manifestSha256).toBe(a.result.manifestSha256);
  });

  it("is independent of the process time zone", async () => {
    const before = process.env.TZ;
    process.env.TZ = "Pacific/Kiritimati";
    try {
      const x = await writeSample(dir, { randomBytes: seededRandom("det") }, "tz.rpkg");
      const a = await writeSample(dir, { randomBytes: seededRandom("det") }, "tz-ref.rpkg");
      expect(x.result.ciphertextSha256).toBe(a.result.ciphertextSha256);
    } finally {
      process.env.TZ = before;
    }
  });

  it("streams many records across multiple encrypted chunks", async () => {
    const file = path.join(dir, "many.rpkg");
    const w = await createPackageWriter({ output: file, passphrase: PASS, kdf: FAST_KDF, chunkSize: 1024, manifest: { sourceSystem: { pseudonym: "rp-src-test" }, sourceRelease: null, scope: { profile: "customer-only", description: "many", selection: { mode: "dynamic-all" } } } });
    for (let i = 0; i < 300; i++) {
      const base = sampleRecords()[1]![1] as Record<string, unknown>;
      const id = `01J${String(i).padStart(23, "0")}`;
      await w.addRecord("customers", { ...(base as never), publicId: id, email: `c${i}@customer.example.test` });
    }
    const res = await w.finalize();
    expect(res.bytes).toBeGreaterThan(1024 * 3);
    const pkg = await openPackage({ input: file, passphrase: PASS });
    try {
      const r = await pkg.verify();
      expect(r.ok).toBe(true);
      expect(r.counts.customers).toBe(300);
    } finally {
      await pkg.close();
    }
  });

  it("writer rejects duplicates, invalid records, unresolved references and missing objects", async () => {
    const mk = async (name: string, extra: Record<string, unknown> = {}) =>
      createPackageWriter({ output: path.join(dir, name), passphrase: PASS, kdf: FAST_KDF, manifest: { sourceSystem: { pseudonym: "x" }, sourceRelease: null, scope: { profile: "custom", description: "t" } }, ...extra });
    const recs = sampleRecords();
    const w1 = await mk("w1.rpkg");
    await w1.addRecord("customers", recs[0]![1] as never);
    await expect(w1.addRecord("customers", recs[0]![1] as never)).rejects.toMatchObject({ code: "DUPLICATE_ID" });
    await expect(w1.addRecord("customers", { ...(recs[0]![1] as object), createdAt: "2026-02-30T00:00:00Z" } as never)).rejects.toMatchObject({ code: "RECORD_INVALID" });
    await expect(w1.addRecord("customers", { ...(recs[0]![1] as object), publicId: "01JZZZZZZZZZZZZZZZZZZZZZZY", surprise: 1 } as never)).rejects.toMatchObject({ code: "RECORD_INVALID" });
    await expect(w1.addRecord("orders", { ...(recs[2]![1] as object), total: { amountMinor: 1.5, currency: "USD" } } as never)).rejects.toMatchObject({ code: "RECORD_INVALID" });
    await w1.addRecord("orders", { ...(recs[2]![1] as object), customerPublicId: ID.cust2 } as never);
    await expect(w1.finalize()).rejects.toMatchObject({ code: "REFERENCE_UNRESOLVED" });
    await expect(w1.addRecord("customers", recs[1]![1] as never)).rejects.toMatchObject({ code: "WRITER_STATE" });

    const w2 = await mk("w2.rpkg", { allowExternalReferences: true });
    await w2.addRecord("files", recs[6]![1] as never);
    await w2.addRecord("file-versions", recs[7]![1] as never);
    await expect(w2.finalize()).rejects.toMatchObject({ code: "OBJECT_MISSING" });

    const w3 = await mk("w3.rpkg", { allowExternalReferences: true });
    await w3.addRecord("files", recs[6]![1] as never);
    await w3.addRecord("file-versions", recs[7]![1] as never);
    await expect(w3.addObject({ source: Buffer.from("x"), expectedSha256: OBJECT_SHA })).rejects.toMatchObject({ code: "DIGEST_MISMATCH" });
    await w3.addObject({ source: (async function* () { yield OBJECT_BYTES.subarray(0, 10); yield OBJECT_BYTES.subarray(10); })() });
    const res = await w3.finalize();
    expect(res.manifest.dependencyClosure.external).toEqual([{ type: "orders", publicId: ID.order }]);
    expect(res.manifest.scope.profile).toBe("custom");
    const pkg = await openPackage({ input: path.join(dir, "w3.rpkg"), passphrase: PASS });
    try {
      const r = await pkg.verify();
      expect(r.ok).toBe(true);
      expect(r.warnings.map((w) => w.code)).toContain("EXTERNAL_REFERENCES");
    } finally {
      await pkg.close();
    }
  });

  it("validates inputs: short passphrase, weak/oversized KDF, relative output", async () => {
    const base = { manifest: { sourceSystem: { pseudonym: "x" }, sourceRelease: null, scope: { profile: "custom" as const, description: "t" } } };
    await expect(createPackageWriter({ ...base, output: path.join(dir, "p.rpkg"), passphrase: "short" })).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(createPackageWriter({ ...base, output: path.join(dir, "p.rpkg"), passphrase: PASS, kdf: { N: 2 ** 10 } })).rejects.toMatchObject({ code: "KDF_PARAMS_REJECTED" });
    await expect(createPackageWriter({ ...base, output: path.join(dir, "p.rpkg"), passphrase: PASS, kdf: { N: 3 * 2 ** 14 } })).rejects.toBeInstanceOf(PortableError);
    await expect(createPackageWriter({ ...base, output: "relative.rpkg", passphrase: PASS, kdf: FAST_KDF })).rejects.toMatchObject({ code: "INPUT_INVALID" });
    void T;
  });

  it("uses strong default KDF parameters recorded in the header", async () => {
    const file = path.join(dir, "default-kdf.rpkg");
    const w = await createPackageWriter({ output: file, passphrase: PASS, manifest: { sourceSystem: { pseudonym: "x" }, sourceRelease: null, scope: { profile: "custom", description: "t" } } });
    await w.finalize();
    const bytes = await readFile(file);
    const header = JSON.parse(bytes.subarray(12, 12 + bytes.readUInt32BE(8)).toString("utf8")) as { kdf: { N: number; r: number; p: number }; cipher: string };
    expect(header.kdf).toMatchObject({ N: 131072, r: 8, p: 1 });
    expect(header.cipher).toBe("AES-256-GCM");
  });
});
