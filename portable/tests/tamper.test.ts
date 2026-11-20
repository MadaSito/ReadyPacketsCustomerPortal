/**
 * Tamper matrix: every modification of the ciphertext is detected while opening, BEFORE any archive
 * member or record is parsed. Content-level tampering by a passphrase holder (re-sealed archives) is
 * detected by verify().
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPackage } from "../src/reader.js";
import { canonicalJson } from "../src/json.js";
import { PASS, cleanup, manifestOf, mutatePackage, setManifest, tmpDir, writeSample, type ZipMember } from "./fixtures.js";

let dir: string;
let file: string;
let bytes: Buffer;
let chunks: Array<{ start: number; end: number }>;

beforeAll(async () => {
  dir = await tmpDir();
  ({ file } = await writeSample(dir, { chunkSize: 1024 }));
  bytes = await readFile(file);
  const hlen = bytes.readUInt32BE(8);
  let pos = 12 + hlen + 32;
  chunks = [];
  while (pos < bytes.length) {
    const len = bytes.readUInt32BE(pos);
    chunks.push({ start: pos, end: pos + 4 + len + 16 });
    pos += 4 + len + 16;
  }
});
afterAll(async () => cleanup(dir));

async function openBytes(name: string, data: Buffer, passphrase = PASS) {
  const p = path.join(dir, name);
  await writeFile(p, data);
  return openPackage({ input: p, passphrase });
}

function flip(data: Buffer, at: number): Buffer {
  const c = Buffer.from(data);
  c[at] = c[at]! ^ 0x01;
  return c;
}

describe("ciphertext tamper matrix (detected at open)", () => {
  it("has several chunks to tamper with", () => {
    expect(chunks.length).toBeGreaterThan(3);
  });

  it.each([
    ["magic", 2, "UNSUPPORTED_ENVELOPE"],
    ["header length", 10, "HEADER_INVALID"],
  ] as const)("flipping a byte in the %s is rejected", async (_n, at, code) => {
    await expect(openBytes(`t-${at}.rpkg`, flip(bytes, at))).rejects.toMatchObject({ code });
  });

  it("flipping a byte inside the header JSON is rejected (header invalid or MAC mismatch)", async () => {
    const hlen = bytes.readUInt32BE(8);
    // Flip a byte inside the base64url salt value: still parseable, so only the MAC can catch it.
    const text = bytes.subarray(12, 12 + hlen).toString("utf8");
    const at = 12 + text.indexOf('"salt":"') + 10;
    const t = Buffer.from(bytes);
    t[at] = t[at] === 0x41 ? 0x42 : 0x41;
    await expect(openBytes("t-salt.rpkg", t)).rejects.toMatchObject({ code: "PASSPHRASE_REJECTED" });
    await expect(openBytes("t-hjson.rpkg", flip(bytes, 12 + 3))).rejects.toMatchObject({ code: "HEADER_INVALID" });
  });

  it("flipping a byte in the header MAC is rejected", async () => {
    const hlen = bytes.readUInt32BE(8);
    await expect(openBytes("t-mac.rpkg", flip(bytes, 12 + hlen + 5))).rejects.toMatchObject({ code: "PASSPHRASE_REJECTED" });
  });

  it("a wrong passphrase is rejected without revealing which part failed", async () => {
    await expect(openBytes("t-pass.rpkg", bytes, "a different passphrase entirely")).rejects.toMatchObject({ code: "PASSPHRASE_REJECTED" });
  });

  it.each(["first", "middle", "last"] as const)("flipping a ciphertext byte in the %s chunk fails authentication", async (which) => {
    const c = which === "first" ? chunks[0]! : which === "last" ? chunks[chunks.length - 1]! : chunks[Math.floor(chunks.length / 2)]!;
    await expect(openBytes(`t-c-${which}.rpkg`, flip(bytes, c.start + 4 + 3))).rejects.toMatchObject({ code: "CHUNK_AUTH_FAILED" });
  });

  it("flipping a GCM tag byte fails authentication", async () => {
    const c = chunks[1]!;
    await expect(openBytes("t-tag.rpkg", flip(bytes, c.end - 2))).rejects.toMatchObject({ code: "CHUNK_AUTH_FAILED" });
  });

  it("changing a chunk length field is rejected", async () => {
    const c = chunks[0]!;
    await expect(openBytes("t-len.rpkg", flip(bytes, c.start + 3))).rejects.toMatchObject({ code: expect.stringMatching(/CHUNK_AUTH_FAILED|TRUNCATED/) });
  });

  it("swapping two chunks (reordering) is rejected", async () => {
    const a = chunks[1]!;
    const b = chunks[2]!;
    expect(a.end - a.start).toBe(b.end - b.start);
    const swapped = Buffer.concat([bytes.subarray(0, a.start), bytes.subarray(b.start, b.end), bytes.subarray(a.start, a.end), bytes.subarray(b.end)]);
    await expect(openBytes("t-swap.rpkg", swapped)).rejects.toMatchObject({ code: "CHUNK_AUTH_FAILED" });
  });

  it("duplicating a chunk is rejected", async () => {
    const a = chunks[1]!;
    const dup = Buffer.concat([bytes.subarray(0, a.end), bytes.subarray(a.start, a.end), bytes.subarray(a.end)]);
    await expect(openBytes("t-dup.rpkg", dup)).rejects.toMatchObject({ code: "CHUNK_AUTH_FAILED" });
  });

  it("dropping the final chunk (clean truncation at a chunk boundary) is detected", async () => {
    const last = chunks[chunks.length - 1]!;
    await expect(openBytes("t-trunc.rpkg", bytes.subarray(0, last.start))).rejects.toMatchObject({ code: "TRUNCATED" });
  });

  it("truncating mid-chunk and mid-header is detected", async () => {
    await expect(openBytes("t-trunc2.rpkg", bytes.subarray(0, chunks[1]!.start + 10))).rejects.toMatchObject({ code: "TRUNCATED" });
    await expect(openBytes("t-trunc3.rpkg", bytes.subarray(0, 40))).rejects.toMatchObject({ code: "TRUNCATED" });
    await expect(openBytes("t-trunc4.rpkg", bytes.subarray(0, 0))).rejects.toMatchObject({ code: "TRUNCATED" });
  });

  it("trailing bytes after the final chunk are rejected", async () => {
    await expect(openBytes("t-trail.rpkg", Buffer.concat([bytes, Buffer.from("x")]))).rejects.toMatchObject({ code: expect.stringMatching(/TRAILING_DATA|TRUNCATED|CHUNK_AUTH_FAILED/) });
    await expect(openBytes("t-trail2.rpkg", Buffer.concat([bytes, bytes.subarray(chunks[0]!.start, chunks[0]!.end)]))).rejects.toMatchObject({ code: "TRAILING_DATA" });
  });

  it("rejects KDF parameters outside the accepted range before deriving keys", async () => {
    const hlen = bytes.readUInt32BE(8);
    const header = JSON.parse(bytes.subarray(12, 12 + hlen).toString("utf8")) as { kdf: { N: number } };
    header.kdf.N = 2 ** 24;
    const json = Buffer.from(canonicalJson(header));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(json.length);
    const forged = Buffer.concat([bytes.subarray(0, 8), len, json, bytes.subarray(12 + hlen)]);
    await expect(openBytes("t-kdf.rpkg", forged)).rejects.toMatchObject({ code: "KDF_PARAMS_REJECTED" });
  });

  it("rejects a non-package file and a symlink path", async () => {
    await expect(openBytes("t-junk.rpkg", Buffer.from("PK\u0003\u0004 not a package"))).rejects.toMatchObject({ code: "UNSUPPORTED_ENVELOPE" });
    const { symlink } = await import("node:fs/promises");
    const link = path.join(dir, "link.rpkg");
    await symlink(file, link);
    await expect(openPackage({ input: link, passphrase: PASS })).rejects.toMatchObject({ code: "IO_ERROR" });
    await expect(openPackage({ input: "relative.rpkg", passphrase: PASS })).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });
});

describe("content tamper by a passphrase holder (detected by verify)", () => {
  async function verifyMutated(name: string, fn: (m: ZipMember[]) => ZipMember[]) {
    const out = path.join(dir, name);
    await mutatePackage(file, out, fn);
    const pkg = await openPackage({ input: out, passphrase: PASS });
    try {
      return await pkg.verify();
    } finally {
      await pkg.close();
    }
  }
  const editRecord = (m: ZipMember[], type: string, edit: (line: string) => string) =>
    m.map((x) => (x.name === `records/${type}.jsonl` ? { ...x, data: Buffer.from(x.data.toString("utf8").split("\n").map((l, i) => (i === 0 && l ? edit(l) : l)).join("\n")) } : x));

  it("detects a modified record byte (digest mismatch)", async () => {
    const r = await verifyMutated("c-rec.rpkg", (m) => editRecord(m, "orders", (l) => l.replace("Synthetic project", "Synthetic projecT")));
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["DIGEST_MISMATCH"]));
    expect(r.issues.some((i) => i.recordType === "orders")).toBe(true);
  });

  it("detects a modified object byte", async () => {
    const r = await verifyMutated("c-obj.rpkg", (m) => m.map((x) => (x.name.startsWith("objects/") ? { ...x, data: Buffer.concat([x.data.subarray(0, 5), Buffer.from("Z"), x.data.subarray(6)]) } : x)));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === "DIGEST_MISMATCH" && i.path?.startsWith("objects/"))).toBe(true);
  });

  it("detects a manifest count change and a manifest digest edit", async () => {
    const r = await verifyMutated("c-man.rpkg", (m) => {
      const man = manifestOf(m) as { records: Array<{ type: string; count: number }> };
      man.records.find((x) => x.type === "customers")!.count = 3;
      return setManifest(m, man);
    });
    expect(r.issues.map((i) => i.code)).toContain("COUNT_MISMATCH");
    const r2 = await verifyMutated("c-man2.rpkg", (m) => {
      const man = manifestOf(m) as { contentDigest: string };
      man.contentDigest = "0".repeat(64);
      return setManifest(m, man);
    });
    expect(r2.issues.map((i) => i.code)).toContain("DIGEST_MISMATCH");
  });

  it("detects a removed record line even when the manifest is rewritten consistently except the digest", async () => {
    const r = await verifyMutated("c-drop.rpkg", (m) => m.map((x) => (x.name === "records/customers.jsonl" ? { ...x, data: Buffer.from(x.data.toString().split("\n").slice(1).join("\n")) } : x)));
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["DIGEST_MISMATCH", "COUNT_MISMATCH"]));
  });

  it("detects missing and extra entries", async () => {
    const r = await verifyMutated("c-miss.rpkg", (m) => m.filter((x) => !x.name.startsWith("objects/")));
    expect(r.issues.map((i) => i.code)).toContain("OBJECT_MISSING");
    const r2 = await verifyMutated("c-extra.rpkg", (m) => [...m, { name: `objects/${"b".repeat(64)}`, data: Buffer.from("extra") }]);
    expect(r2.issues.map((i) => i.code)).toContain("ARCHIVE_INVALID");
  });

  it("detects a duplicate publicId and a dangling reference", async () => {
    const r = await verifyMutated("c-dupid.rpkg", (m) =>
      m.map((x) => {
        if (x.name !== "records/customers.jsonl") return x;
        const [a] = x.data.toString().split("\n");
        return { ...x, data: Buffer.from(`${a}\n${a}\n`) };
      }),
    );
    expect(r.issues.map((i) => i.code)).toContain("DUPLICATE_ID");
    expect(r.issues.map((i) => i.code)).toContain("REFERENCE_UNRESOLVED"); // share grantee (second customer) vanished
  });

  it("rejects a manifest whose packageId differs from the envelope header", async () => {
    const out = path.join(dir, "c-pid.rpkg");
    await expect(
      mutatePackage(file, out, (m) => {
        const man = manifestOf(m) as { packageId: string };
        man.packageId = "01JAAAAAAAAAAAAAAAAAAAAAAA";
        return setManifest(m, man);
      }).then(() => openPackage({ input: out, passphrase: PASS })),
    ).rejects.toMatchObject({ code: "MANIFEST_INVALID" });
  });
});
