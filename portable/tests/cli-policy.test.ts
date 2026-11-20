/**
 * Verifier CLI (in-process via runCli), reference importer plan, and the version / unknown-field policy.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT, runCli } from "../cli/verify.js";
import { buildPlan } from "../reference-importer/plan.js";
import { computeContentDigest } from "../src/digest.js";
import { openPackage } from "../src/reader.js";
import { OBJECT_BYTES, OBJECT_SHA, PASS, cleanup, manifestOf, mutatePackage, setManifest, tmpDir, writeSample, type ZipMember } from "./fixtures.js";

let dir: string;
let file: string;
let passFile: string;
beforeAll(async () => {
  dir = await tmpDir();
  ({ file } = await writeSample(dir));
  passFile = path.join(dir, "pass.txt");
  await writeFile(passFile, PASS + "\n", { mode: 0o600 });
});
afterAll(async () => cleanup(dir));

function io(env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => void out.push(s), err: (s: string) => void err.push(s), env, cwd: dir }, out, err };
}

/** Rewrites manifest inventories (sha/bytes/count/contentDigest) so content-level edits stay self-consistent. */
function reinventory(m: ZipMember[], edit?: (man: Record<string, unknown>) => void): ZipMember[] {
  const man = manifestOf(m) as { records: Array<{ type: string; file: string; count: number; bytes: number; sha256: string }>; objects: Array<{ sha256: string; size: number }>; extensions: Array<{ name: string; file: string; count: number; bytes: number; sha256: string }>; contentDigest: string };
  for (const r of man.records) {
    const data = m.find((x) => x.name === r.file)!.data;
    r.bytes = data.length;
    r.sha256 = createHash("sha256").update(data).digest("hex");
    r.count = data.toString().split("\n").filter(Boolean).length;
  }
  for (const e of man.extensions) {
    const data = m.find((x) => x.name === e.file)!.data;
    e.bytes = data.length;
    e.sha256 = createHash("sha256").update(data).digest("hex");
    e.count = data.toString().split("\n").filter(Boolean).length;
  }
  edit?.(man as unknown as Record<string, unknown>);
  man.contentDigest = computeContentDigest(man.records, man.objects, man.extensions);
  return setManifest(m, man);
}

async function variant(name: string, fn: (m: ZipMember[]) => ZipMember[]) {
  const out = path.join(dir, name);
  await mutatePackage(file, out, fn);
  return out;
}

describe("verifier CLI", () => {
  it("verifies a good package (exit 0) with a truthful human report", async () => {
    const t = io();
    expect(await runCli(["verify", file, "--passphrase-file", passFile], t.io)).toBe(EXIT.OK);
    const text = t.out.join("");
    expect(text).toContain("result:            VERIFIED");
    expect(text).toContain("does not prove the source organization's identity");
    expect(text).not.toContain(PASS);
  });

  it("emits a JSON report and reads the passphrase from an environment variable", async () => {
    const t = io({ RP_TEST_PASS: PASS });
    expect(await runCli(["verify", file, "--passphrase-env", "RP_TEST_PASS", "--json"], t.io)).toBe(EXIT.OK);
    const report = JSON.parse(t.out.join("")) as { ok: boolean; counts: Record<string, number>; objects: { count: number } };
    expect(report.ok).toBe(true);
    expect(report.counts.customers).toBe(2);
    expect(report.objects.count).toBe(1);
  });

  it("returns usage errors (exit 2) and never accepts a passphrase on the command line", async () => {
    expect(await runCli([], io().io)).toBe(EXIT.USAGE);
    expect(await runCli(["verify", file], io().io)).toBe(EXIT.USAGE);
    expect(await runCli(["verify", file, "--passphrase", PASS], io().io)).toBe(EXIT.USAGE);
    expect(await runCli(["verify", file, "--passphrase-file", passFile, "--passphrase-env", "X"], io().io)).toBe(EXIT.USAGE);
    expect(await runCli(["verify", file, "--passphrase-env", "lower-case"], io().io)).toBe(EXIT.USAGE);
    expect(await runCli(["frobnicate", file, "--passphrase-file", passFile], io().io)).toBe(EXIT.USAGE);
  });

  it("returns 3 for a wrong passphrase, 4 for an unsupported format, 5 for I/O errors", async () => {
    const wrong = path.join(dir, "wrong.txt");
    await writeFile(wrong, "not the passphrase");
    expect(await runCli(["verify", file, "--passphrase-file", wrong], io().io)).toBe(EXIT.PASSPHRASE);
    const junk = path.join(dir, "junk.bin");
    await writeFile(junk, "GIF89a not a package");
    expect(await runCli(["verify", junk, "--passphrase-file", passFile], io().io)).toBe(EXIT.UNSUPPORTED);
    expect(await runCli(["verify", path.join(dir, "missing.rpkg"), "--passphrase-file", passFile], io().io)).toBe(EXIT.IO);
    expect(await runCli(["verify", file, "--passphrase-file", path.join(dir, "missing.txt")], io().io)).toBe(EXIT.IO);
  });

  it("returns 1 when verification fails", async () => {
    const bad = await variant("cli-bad.rpkg", (m) => m.filter((x) => !x.name.startsWith("objects/")));
    const t = io();
    expect(await runCli(["verify", bad, "--passphrase-file", passFile], t.io)).toBe(EXIT.FAILED);
    expect(t.out.join("")).toContain("OBJECT_MISSING");
  });

  it("extracts into a new directory; extracted bytes match the manifest", async () => {
    const dest = path.join(dir, "out");
    const t = io();
    expect(await runCli(["extract", file, dest, "--passphrase-file", passFile], t.io)).toBe(EXIT.OK);
    expect((await readdir(path.join(dest, "objects"))).sort()).toEqual([OBJECT_SHA]);
    expect((await readFile(path.join(dest, "objects", OBJECT_SHA))).equals(OBJECT_BYTES)).toBe(true);
    const man = JSON.parse(await readFile(path.join(dest, "manifest.json"), "utf8")) as { records: Array<{ type: string; count: number; file: string; sha256: string; bytes: number }> };
    for (const r of man.records) {
      const data = await readFile(path.join(dest, r.file));
      expect(data.toString().split("\n").filter(Boolean).length, r.type).toBe(r.count);
      expect(createHash("sha256").update(data).digest("hex"), r.type).toBe(r.sha256); // verbatim bytes
      expect(data.length).toBe(r.bytes);
    }
    const info = JSON.parse(await readFile(path.join(dest, "extraction-info.json"), "utf8")) as { mode: string };
    expect(info.mode).toBe("verbatim");
  });

  it("refuses to extract into an existing directory or an unverified package", async () => {
    const existing = path.join(dir, "exists");
    await mkdir(existing);
    expect(await runCli(["extract", file, existing, "--passphrase-file", passFile], io().io)).toBe(EXIT.USAGE);
    const bad = await variant("cli-bad2.rpkg", (m) => m.filter((x) => !x.name.startsWith("objects/")));
    expect(await runCli(["extract", bad, path.join(dir, "never"), "--passphrase-file", passFile], io().io)).toBe(EXIT.FAILED);
    await expect(readdir(path.join(dir, "never"))).rejects.toThrow();
  });

  it("prints a deterministic import plan", async () => {
    const a = io();
    const b = io();
    expect(await runCli(["plan", file, "--passphrase-file", passFile], a.io)).toBe(EXIT.OK);
    expect(await runCli(["plan", file, "--passphrase-file", passFile], b.io)).toBe(EXIT.OK);
    expect(a.out.join("")).toBe(b.out.join(""));
    const plan = JSON.parse(a.out.join("")) as { applicable: boolean; planSha256: string; summary: Record<string, number>; refusals: Array<{ code: string }> };
    // The reference model deliberately maps only core CRM entities; everything else is refused explicitly.
    expect(new Set(plan.refusals.map((r) => r.code))).toEqual(new Set(["UNSUPPORTED_RECORD_TYPE"]));
    expect(plan.applicable).toBe(false);
    expect(plan.summary.account).toBe(2);
    expect(plan.planSha256).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("reference importer", () => {
  it("refuses unknown enum values instead of mapping them", async () => {
    const f = await variant("enum.rpkg", (m) =>
      reinventory(m.map((x) => (x.name === "records/orders.jsonl" ? { ...x, data: Buffer.from(x.data.toString().replace('"status":"in_production"', '"status":"teleported"')) } : x))),
    );
    const pkg = await openPackage({ input: f, passphrase: PASS });
    try {
      const report = await pkg.verify();
      expect(report.ok).toBe(true); // enums are open tokens in the contract; refusal is the importer's decision
      const plan = await buildPlan(pkg, report);
      expect(plan.applicable).toBe(false);
      expect(plan.refusals.filter((r) => r.code === "UNKNOWN_ENUM")).toEqual([expect.objectContaining({ recordType: "orders", detail: "order status" })]);
    } finally {
      await pkg.close();
    }
  });

  it("will not plan from an unverified package", async () => {
    const pkg = await openPackage({ input: file, passphrase: PASS });
    try {
      await expect(buildPlan(pkg, { ok: false } as never)).rejects.toMatchObject({ code: "NOT_VERIFIED" });
    } finally {
      await pkg.close();
    }
  });
});

describe("version and unknown-field policy", () => {
  const addField = (m: ZipMember[]) =>
    m.map((x) => (x.name === "records/customers.jsonl" ? { ...x, data: Buffer.from(x.data.toString().replace(/^\{/, '{"loyaltyTier":"platinum",')) } : x));

  it("holds unknown fields of a newer minor version as held-unknown and reports them", async () => {
    const f = await variant("minor.rpkg", (m) => reinventory(addField(m), (man) => {
      (man.contract as { version: string }).version = "3.4";
      man.futureTopLevel = { a: 1 };
    }));
    const pkg = await openPackage({ input: f, passphrase: PASS });
    try {
      const report = await pkg.verify();
      expect(report.issues).toEqual([]);
      expect(report.heldUnknown).toBe(2); // pre-existing legacyTier + newly held loyaltyTier
      expect(report.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["NEWER_MINOR_VERSION", "NEWER_MINOR_MANIFEST_FIELDS"]));
      const recs: Array<Record<string, unknown>> = [];
      for await (const c of pkg.records("customers")) recs.push(c as unknown as Record<string, unknown>);
      const held = recs.map((r) => r.heldUnknown as Record<string, unknown> | undefined);
      expect(held[0]).toMatchObject({ loyaltyTier: "platinum", legacyTier: "gold" });
      expect(recs[0]).not.toHaveProperty("loyaltyTier");
    } finally {
      await pkg.close();
    }
  });

  it("rejects unknown fields in a same-version package (strict)", async () => {
    const f = await variant("strict.rpkg", (m) => reinventory(addField(m)));
    const pkg = await openPackage({ input: f, passphrase: PASS });
    const report = await pkg.verify();
    await pkg.close();
    expect(report.issues.map((i) => i.code)).toContain("RECORD_INVALID");
  });

  it("refuses an unsupported major version or a too-new minimum reader version", async () => {
    const major = await variant("major.rpkg", (m) => reinventory(m, (man) => void ((man.contract as { version: string }).version = "4.0")));
    await expect(openPackage({ input: major, passphrase: PASS })).rejects.toMatchObject({ code: "UNSUPPORTED_CONTRACT" });
    const min = await variant("min.rpkg", (m) => reinventory(m, (man) => {
      (man.contract as { version: string }).version = "3.2";
      (man.compatibility as { minReaderVersion: string }).minReaderVersion = "3.2";
    }));
    await expect(openPackage({ input: min, passphrase: PASS })).rejects.toMatchObject({ code: "UNSUPPORTED_CONTRACT" });
  });

  it("fails on a required unknown module or extension, holds an optional unknown extension", async () => {
    const reqMod = await variant("reqmod.rpkg", (m) => reinventory(m, (man) => void (man.compatibility as { requiredModules: string[] }).requiredModules.push("teleportation")));
    const p1 = await openPackage({ input: reqMod, passphrase: PASS });
    const r1 = await p1.verify();
    await p1.close();
    expect(r1.issues.map((i) => i.code)).toContain("UNSUPPORTED_EXTENSION");

    const ext = (required: boolean) => (m: ZipMember[]) =>
      reinventory([...m, { name: "extensions/acme-notes.jsonl", data: Buffer.from('{"note":"inert"}\n') }], (man) =>
        void (man.extensions as unknown[]).push({ name: "acme-notes", version: "1.0", required, file: "extensions/acme-notes.jsonl", count: 0, bytes: 0, sha256: "0".repeat(64) }),
      );
    // reinventory runs before the push for this entry, so recompute after adding it.
    const fix = (fn: (m: ZipMember[]) => ZipMember[]) => (m: ZipMember[]) => reinventory(fn(m));
    const opt = await variant("optext.rpkg", fix(ext(false)));
    const p2 = await openPackage({ input: opt, passphrase: PASS });
    const r2 = await p2.verify();
    expect(r2.issues).toEqual([]);
    expect(r2.heldExtensions).toEqual([{ name: "acme-notes", version: "1.0", count: 1 }]);
    const lines: string[] = [];
    for await (const l of p2.heldExtension("acme-notes")) lines.push(l);
    expect(lines).toEqual(['{"note":"inert"}']);
    await p2.close();

    const req = await variant("reqext.rpkg", fix(ext(true)));
    const p3 = await openPackage({ input: req, passphrase: PASS });
    const r3 = await p3.verify();
    await p3.close();
    expect(r3.issues.map((i) => i.code)).toContain("UNSUPPORTED_EXTENSION");
    expect(await runCli(["verify", req, "--passphrase-file", passFile], io().io)).toBe(EXIT.UNSUPPORTED);
  });

  it("rejects duplicate or non-canonical extension inventory entries", async () => {
    const entry = (file: string) => ({ name: "acme-notes", version: "1.0", required: false, file, count: 0, bytes: 0, sha256: "0".repeat(64) });
    const dup = await variant("dupext.rpkg", (m) =>
      reinventory([...m, { name: "extensions/acme-notes.jsonl", data: Buffer.from('{"a":1}\n') }], (man) => void (man.extensions as unknown[]).push(entry("extensions/acme-notes.jsonl"), entry("extensions/acme-notes.jsonl"))),
    );
    await expect(openPackage({ input: dup, passphrase: PASS })).rejects.toMatchObject({ code: "MANIFEST_INVALID" });
    const alias = await variant("aliasext.rpkg", (m) =>
      reinventory([...m, { name: "extensions/other.jsonl", data: Buffer.from('{"a":1}\n') }], (man) => void (man.extensions as unknown[]).push(entry("extensions/other.jsonl"))),
    );
    await expect(openPackage({ input: alias, passphrase: PASS })).rejects.toMatchObject({ code: "MANIFEST_INVALID" });
  });

  it("rejects an optional extension nested beyond the scanning budget (fail closed)", async () => {
    const deep = "[".repeat(40) + '{"passwordHash":"x"}' + "]".repeat(40);
    const f = await variant("deepext.rpkg", (m) =>
      reinventory(
        reinventory([...m, { name: "extensions/acme-notes.jsonl", data: Buffer.from(deep + "\n") }], (man) =>
          void (man.extensions as unknown[]).push({ name: "acme-notes", version: "1.0", required: false, file: "extensions/acme-notes.jsonl", count: 0, bytes: 0, sha256: "0".repeat(64) }),
        ),
      ),
    );
    const pkg = await openPackage({ input: f, passphrase: PASS });
    const r = await pkg.verify();
    await pkg.close();
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toContain("RECORD_INVALID");
  });
});
