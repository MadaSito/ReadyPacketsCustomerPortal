/**
 * Archive defences (traversal, links, directories, duplicates, zip bombs, limits) and hard exclusions
 * (writer refuses; verifier fails a crafted package). All inputs are synthetic.
 */
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPackage } from "../src/reader.js";
import { createPackageWriter } from "../src/writer.js";
import { FAST_KDF, ID, PASS, T, buildZip, cleanup, decryptToZip, mutatePackage, readZipMembers, sampleRecords, sealZip, tmpDir, writeSample, type ZipMember } from "./fixtures.js";

let dir: string;
let file: string;
let members: ZipMember[];
beforeAll(async () => {
  dir = await tmpDir();
  ({ file } = await writeSample(dir));
  members = await readZipMembers(await decryptToZip(file));
});
afterAll(async () => cleanup(dir));

let n = 0;
async function openZipBytes(zip: Buffer, limits?: Record<string, number>) {
  const out = path.join(dir, `a-${n++}.rpkg`);
  await sealZip(zip, out);
  const pkg = await openPackage({ input: out, passphrase: PASS, ...(limits ? { limits } : {}) });
  await pkg.close();
  return pkg;
}

/** yazl refuses unsafe names, so build with a same-length placeholder and replace it in the raw bytes. */
function renameRaw(zip: Buffer, from: string, to: string): Buffer {
  expect(to.length).toBe(from.length);
  const src = Buffer.from(from, "latin1");
  const dst = Buffer.from(to, "latin1");
  const out = Buffer.from(zip);
  let i = out.indexOf(src);
  let hits = 0;
  while (i >= 0) {
    dst.copy(out, i);
    hits++;
    i = out.indexOf(src, i + 1);
  }
  expect(hits).toBe(2); // local header + central directory
  return out;
}

describe("archive defences", () => {
  it("accepts the unmodified archive when re-sealed", async () => {
    await expect(openZipBytes(await buildZip(members))).resolves.toBeDefined();
  });

  it.each([
    ["../../../../etc/pass", "parent traversal"],
    ["/abs/records/x.json", "absolute path"],
    ["records\\winpath.txt", "backslash separator"],
    ["C:/records/aaaa.txt", "drive letter"],
    ["records/../manifes.", "embedded dot-dot"],
  ])("rejects entry name %s (%s)", async (bad) => {
    const placeholder = "q".repeat(bad.length);
    const zip = renameRaw(await buildZip([...members, { name: placeholder, data: Buffer.from("x") }]), placeholder, bad);
    await expect(openZipBytes(zip)).rejects.toMatchObject({ code: expect.stringMatching(/ENTRY_NAME_REJECTED|ARCHIVE_INVALID/) });
  });

  it("rejects names outside the allowlist", async () => {
    await expect(openZipBytes(await buildZip([...members, { name: "notes.txt", data: Buffer.from("x") }]))).rejects.toMatchObject({ code: "ENTRY_NAME_REJECTED" });
    await expect(openZipBytes(await buildZip([...members, { name: "objects/ABC", data: Buffer.from("x") }]))).rejects.toMatchObject({ code: "ENTRY_NAME_REJECTED" });
  });

  it("rejects symbolic links and special files", async () => {
    const zip = await buildZip([...members, { name: `objects/${"c".repeat(64)}`, data: Buffer.from("/etc/passwd"), mode: 0o120777 }]);
    await expect(openZipBytes(zip)).rejects.toMatchObject({ code: "ARCHIVE_INVALID" });
  });

  it("rejects directory entries", async () => {
    const yazl = (await import("yazl")).default;
    const z = new yazl.ZipFile();
    for (const m of members) z.addBuffer(m.data, m.name, { mtime: new Date(1980, 0, 1) });
    z.addEmptyDirectory("records/sub", { mtime: new Date(1980, 0, 1) });
    z.end();
    const parts: Buffer[] = [];
    for await (const c of z.outputStream as AsyncIterable<Buffer>) parts.push(c);
    await expect(openZipBytes(Buffer.concat(parts))).rejects.toMatchObject({ code: expect.stringMatching(/ENTRY_NAME_REJECTED|ARCHIVE_INVALID/) });
  });

  it("rejects duplicate entries", async () => {
    const m = members.find((x) => x.name === "manifest.json")!;
    await expect(openZipBytes(await buildZip([...members, m]))).rejects.toMatchObject({ code: "DUPLICATE_ENTRY" });
  });

  it("rejects a high-ratio entry (zip bomb) before inflating it", async () => {
    const bomb = { name: "records/customers.jsonl", data: Buffer.alloc(20 * 1024 * 1024, 0x20), compress: true };
    const zip = await buildZip([...members.filter((x) => x.name !== bomb.name), bomb]);
    expect(zip.length).toBeLessThan(200 * 1024);
    await expect(openZipBytes(zip)).rejects.toMatchObject({ code: "RATIO_LIMIT" });
  });

  it("enforces entry-count, total-size and object-size limits", async () => {
    const zip = await buildZip(members);
    await expect(openZipBytes(zip, { maxEntries: 3 })).rejects.toMatchObject({ code: "ENTRY_LIMIT" });
    await expect(openZipBytes(zip, { maxTotalUncompressed: 2048 })).rejects.toMatchObject({ code: "SIZE_LIMIT" });
    await expect(openZipBytes(zip, { maxObjectBytes: 100 })).rejects.toMatchObject({ code: "SIZE_LIMIT" });
  });

  it("rejects declared sizes that do not match actual sizes", async () => {
    // Corrupt the declared uncompressed size of the manifest in the central directory.
    const zip = await buildZip(members);
    const cd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const name = zip.subarray(cd + 46, cd + 46 + zip.readUInt16LE(cd + 28)).toString();
    const out = Buffer.from(zip);
    out.writeUInt32LE(out.readUInt32LE(cd + 24) + 7, cd + 24);
    const pkgFile = path.join(dir, "size.rpkg");
    await sealZip(out, pkgFile);
    const result = openPackage({ input: pkgFile, passphrase: PASS }).then(async (p) => {
      try {
        return await p.verify();
      } finally {
        await p.close();
      }
    });
    // Either the archive is refused outright or verification fails for that entry; never success.
    const outcome = await result.then((r) => (r.ok ? "ok" : "failed")).catch((e: { code: string }) => e.code);
    expect(outcome, name).not.toBe("ok");
  });
});

async function writer(name: string) {
  return createPackageWriter({
    output: path.join(dir, name),
    passphrase: PASS,
    kdf: FAST_KDF,
    allowExternalReferences: true,
    manifest: { sourceSystem: { pseudonym: "rp-src-test" }, sourceRelease: "2026.11.0", generatedAt: T, scope: { profile: "all-core", description: "x", selection: { mode: "fixed", count: 1 } } },
  });
}

describe("hard exclusions", () => {
  const base = () => structuredClone(sampleRecords()[0]![1]) as Record<string, unknown>;

  it.each([
    ["passwordHash", "x"],
    ["password_hash", "x"],
    ["mfaSecret", "x"],
    ["totpSeed", "x"],
    ["recoveryCodes", ["a"]],
    ["sessionId", "x"],
    ["refreshToken", "x"],
    ["samlNameId", "x"],
    ["apiKey", "x"],
    ["encryptionKey", "x"],
    ["storageKey", "x"],
    ["auditChainKey", "x"],
  ])("writer refuses key %s at top level and inside heldUnknown", async (key, value) => {
    const w = await writer(`x-${key}.rpkg`);
    await expect(w.addRecord("customers", { ...base(), [key]: value } as never)).rejects.toMatchObject({ code: "EXCLUDED_FIELD" });
    await expect(w.addRecord("customers", { ...base(), heldUnknown: { nested: { [key]: value } } } as never)).rejects.toMatchObject({ code: "EXCLUDED_FIELD" });
    await w.abort();
  });

  it.each([
    ["$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA"],
    ["$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234"],
    ["otpauth://totp/Example:ada?secret=JBSWY3DPEHPK3PXP"],
    ["-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c2lnbmF0dXJl"],
  ])("writer refuses secret-shaped value %#", async (value) => {
    const w = await writer(`v-${value.length}.rpkg`);
    await expect(w.addRecord("customers", { ...base(), company: value } as never)).rejects.toMatchObject({ code: "EXCLUDED_FIELD" });
    await w.abort();
  });

  it("does not leak the offending value in the error", async () => {
    const w = await writer("leak.rpkg");
    const err = (await w.addRecord("customers", { ...base(), heldUnknown: { mfaSecret: "JBSWY3DPEHPK3PXP" } } as never).catch((e: unknown) => e)) as Error & { detail?: unknown };
    expect(JSON.stringify({ m: err.message, d: err.detail })).not.toContain("JBSWY3DPEHPK3PXP");
    await w.abort();
  });

  it("verifier fails a crafted package that contains excluded fields", async () => {
    const out = path.join(dir, "crafted.rpkg");
    await mutatePackage(file, out, (m) =>
      m.map((x) => {
        if (x.name !== "records/customers.jsonl") return x;
        const lines = x.data.toString().split("\n");
        const rec = JSON.parse(lines[0]!) as Record<string, unknown>;
        rec.heldUnknown = { passwordHash: "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA" };
        lines[0] = JSON.stringify(rec);
        return { ...x, data: Buffer.from(lines.join("\n")) };
      }),
    );
    const pkg = await openPackage({ input: out, passphrase: PASS });
    const report = await pkg.verify();
    await pkg.close();
    expect(report.ok).toBe(false);
    const hit = report.issues.find((i) => i.code === "EXCLUDED_FIELD");
    expect(hit).toMatchObject({ recordType: "customers" });
    expect(JSON.stringify(report)).not.toContain("argon2");
  });

  it("allows ordinary fields that merely resemble excluded words in values", async () => {
    const w = await writer("ok.rpkg");
    await expect(w.addRecord("customers", { ...base(), publicId: ID.cust, company: "Password Manager Inc" } as never)).resolves.toBeUndefined();
    await w.abort();
  });
});
