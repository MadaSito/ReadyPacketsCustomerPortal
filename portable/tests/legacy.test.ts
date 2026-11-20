/**
 * Legacy v1/v2 adapter. The fixtures are SYNTHESIZED here with the algorithm read from the reference
 * source (scripts/portableDataTransfer.ts); they were not produced by the old system itself.
 */
import { createCipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPackage } from "../src/reader.js";
import type { PortablePackage } from "../src/types.js";
import { PASS, cleanup, tmpDir } from "./fixtures.js";

const V2 = "readypackets.portable-data-transfer.v2";
const V2E = "readypackets.portable-data-transfer-envelope.v2";
const V1 = "readypackets.portable-data-transfer.v1";
const V1E = "readypackets.portable-data-transfer-envelope.v1";
const h = (s: string) => createHash("sha256").update(s).digest("hex");
const FILE_BYTES = Buffer.from("%PDF-1.4 synthetic legacy file\n");

function customer(ref: string, email: string) {
  return { ref: h(ref), email, firstName: "Ada", middleName: null, lastName: "Legacy", preferredName: null, suffix: null, company: null, phone: null, address: null, timezone: "America/New_York", marketingOptIn: false, status: "active" };
}
function order(ref: string, custRef: string, extra: Record<string, unknown> = {}) {
  return {
    ref: h(ref), customerRef: h(custRef), orderNumber: "RP-LEG-0001", projectName: "Legacy project", internalNotes: null, status: "in_production", paymentStatus: "paid", paymentRequirement: "upfront",
    subtotalCents: 150000, discountCents: 0, totalCents: 150000, priceSource: "catalog", manualPriceCents: null, isTestOrder: false, currency: "USD", bundleApplied: false, integrityChoice: null,
    mndaAcceptedAt: "2026-01-02T03:04:05.000Z", intakeCompletedAt: null, phase2ScheduledAt: null, deliveredAt: null, closedAt: null, dueAt: null, completionPercent: 40, createdAt: "2026-01-01T00:00:00.000Z",
    items: [{ sku: "PKT-STD", name: "Standard packet", tier: "standard", unitPriceCents: 150000, quantity: 1, lineTotalCents: 150000 }],
    statusHistory: [{ fromStatus: null, toStatus: "new", reason: "created", occurredAt: "2026-01-01T00:00:00.000Z" }],
    ...extra,
  };
}
function file(ref: string, orderRef: string, originalName = "brief.pdf") {
  return { ref: h(ref), orderRef: h(orderRef), originalName, detectedMime: "application/pdf", extension: "pdf", sizeBytes: FILE_BYTES.length, durationSeconds: null, sha256: createHash("sha256").update(FILE_BYTES).digest("hex"), category: "deliverable", phase: "phase_1", visibleToCustomer: true, version: 1, createdAt: "2026-01-01T00:00:00.000Z", contents: FILE_BYTES.toString("base64") };
}

/** Same algorithm as the reference source: draft key order, packageId = sha256(JSON.stringify(draft)). */
function payload(format: string, scope: string, contents: Record<string, unknown[]>, opts: { badId?: boolean } = {}) {
  const draft = { format, sourceSystemRef: h("legacy-source"), generatedAt: "2026-02-01T00:00:00.000Z", sourceRelease: "a".repeat(40), scope, contents };
  return { ...draft, packageId: opts.badId ? "f".repeat(64) : h(JSON.stringify(draft)) };
}
function seal(envFormat: string, payloadFormat: string, p: unknown, pass = PASS): Buffer {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(pass, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(payloadFormat));
  const ct = Buffer.concat([c.update(JSON.stringify(p)), c.final()]);
  const env = { format: envFormat, kdf: "scrypt", salt: salt.toString("base64url"), iv: iv.toString("base64url"), tag: c.getAuthTag().toString("base64url"), ciphertext: ct.toString("base64url") };
  return Buffer.from(JSON.stringify(env) + "\n");
}

let dir: string;
let i = 0;
async function open(bytes: Buffer, pass = PASS): Promise<PortablePackage> {
  const f = path.join(dir, `legacy-${i++}.rptransfer`);
  await writeFile(f, bytes);
  return openPackage({ input: f, passphrase: pass });
}
async function collect(pkg: PortablePackage) {
  const out: Array<{ type: string; record: Record<string, unknown> }> = [];
  for await (const r of pkg.allRecords()) out.push({ type: r.type, record: r.record as Record<string, unknown> });
  return out;
}

beforeAll(async () => {
  dir = await tmpDir();
});
afterAll(async () => cleanup(dir));

describe("legacy v2 adapter", () => {
  const v2 = () =>
    payload(V2, "customer", {
      customers: [customer("c1", "ada@legacy.example.test")],
      orders: [order("o1", "c1", { futureLegacyField: "kept" })],
      files: [file("f1", "o1", "../brief\u0007.pdf")],
    });

  it("upgrades a v2 package with explicit losses, held-unknown fields and derived ids", async () => {
    const pkg = await open(seal(V2E, V2, v2()));
    try {
      expect(pkg.manifest.contract.version).toBe("3.0");
      expect(pkg.sourceFormat).toBe("v2");
      const report = await pkg.verify();
      expect(report.issues).toEqual([]);
      expect(report.ok).toBe(true);
      expect(report.sourceFormat).toBe("v2");
      const lossCodes = report.losses.map((l) => l.code);
      expect(lossCodes).toEqual(expect.arrayContaining(["NOT_CARRIED_BILLING", "UNKNOWN_LOCK_STATE", "UNKNOWN_HISTORY_ACTOR"]));
      expect(lossCodes.some((c) => /FILE_NAME/.test(c))).toBe(true);
      expect(report.warnings.map((w) => w.code)).toContain("LEGACY_FORMAT");
      const recs = await collect(pkg);
      const o = recs.find((r) => r.type === "orders")!.record;
      expect(o.lock).toBeNull();
      expect(o.total).toEqual({ amountMinor: 150000, currency: "USD" });
      expect(o.heldUnknown).toMatchObject({ futureLegacyField: "kept", priceSource: "catalog", mndaAcceptedAt: "2026-01-02T03:04:05.000Z" });
      const c = recs.find((r) => r.type === "customers")!.record;
      expect(c.createdAt).toBeNull();
      const fv = recs.find((r) => r.type === "file-versions")?.record;
      expect(fv).toBeDefined();
      // The usable name is sanitized; the original is kept only as inert held-unknown evidence (never dropped).
      expect(fv!.originalName).toBe(".._brief_.pdf");
      expect(fv!.heldUnknown).toEqual({ originalName: "../brief\u0007.pdf" });
      expect(recs.some((r) => r.type === "provenance")).toBe(true);
      // Object bytes are the original file bytes.
      const sha = createHash("sha256").update(FILE_BYTES).digest("hex");
      const parts: Buffer[] = [];
      for await (const chunk of await pkg.openObject(sha)) parts.push(chunk as Buffer);
      expect(Buffer.concat(parts).equals(FILE_BYTES)).toBe(true);
    } finally {
      await pkg.close();
    }
  });

  it("derives the same portable ids for the same legacy package (re-import idempotence)", async () => {
    const p = v2();
    const ids = async () => {
      const pkg = await open(seal(V2E, V2, p));
      await pkg.verify();
      const r = (await collect(pkg)).map((x) => `${x.type}:${String(x.record.publicId)}`);
      await pkg.close();
      return r;
    };
    expect(await ids()).toEqual(await ids());
  });

  it("keeps record ids stable across re-exports with a different generatedAt", async () => {
    const contents = { customers: [customer("c1", "ada@legacy.example.test")], orders: [order("o1", "c1")], files: [] };
    const ids = async (generatedAt: string) => {
      const draft = { format: V2, sourceSystemRef: h("legacy-source"), generatedAt, sourceRelease: null, scope: "customer", contents };
      const pkg = await open(seal(V2E, V2, { ...draft, packageId: h(JSON.stringify(draft)) }));
      const report = await pkg.verify();
      expect(report.issues).toEqual([]);
      const r = (await collect(pkg)).filter((x) => x.type !== "provenance").map((x) => `${x.type}:${String(x.record.publicId)}`);
      await pkg.close();
      return r;
    };
    expect(await ids("2026-02-01T00:00:00.000Z")).toEqual(await ids("2026-06-30T12:00:00.000Z"));
  });

  it("enforces caller limits before decoding legacy contents", async () => {
    const f = path.join(dir, "limits.rptransfer");
    await writeFile(f, seal(V2E, V2, payload(V2, "order", { customers: [customer("c1", "ada@legacy.example.test")], orders: [order("o1", "c1")], files: [file("f1", "o1")] })));
    await expect(openPackage({ input: f, passphrase: PASS, limits: { maxObjectBytes: 8 } })).rejects.toMatchObject({ code: "SIZE_LIMIT" });
    await expect(openPackage({ input: f, passphrase: PASS, limits: { maxTotalUncompressed: 8 } })).rejects.toMatchObject({ code: "SIZE_LIMIT" });
  });

  it("budgets expanded records (items/history/provenance) and metadata-only packages", async () => {
    const many = { ...order("o1", "c1"), statusHistory: Array.from({ length: 20 }, (_, k) => ({ fromStatus: null, toStatus: "new", reason: `r${k}`, occurredAt: "2026-01-01T00:00:00.000Z" })) };
    const f = path.join(dir, "expanded.rptransfer");
    await writeFile(f, seal(V2E, V2, payload(V2, "order", { customers: [customer("c1", "ada@legacy.example.test")], orders: [many], files: [] })));
    // Only 1 customer and 1 order at top level, but 20 derived history records.
    await expect(openPackage({ input: f, passphrase: PASS, limits: { maxRecordsPerType: 5 } })).rejects.toMatchObject({ code: "SIZE_LIMIT", detail: { recordType: "order-status-history" } });
    // Metadata only (no files): the normalized record bytes alone exceed the total budget.
    await expect(openPackage({ input: f, passphrase: PASS, limits: { maxTotalUncompressed: 2048 } })).rejects.toMatchObject({ code: "SIZE_LIMIT" });
    const ok = await openPackage({ input: f, passphrase: PASS });
    expect((await ok.verify()).ok).toBe(true);
    await ok.close();
  });

  it("detects a forged legacy packageId", async () => {
    const pkg = await open(seal(V2E, V2, payload(V2, "customer", { customers: [customer("c1", "ada@legacy.example.test")], orders: [], files: [] }, { badId: true })));
    const report = await pkg.verify();
    await pkg.close();
    expect(report.ok).toBe(false);
    expect(report.issues.map((x) => x.code)).toContain("DIGEST_MISMATCH");
  });

  it("detects legacy file bytes that do not match their recorded hash", async () => {
    const f = { ...file("f1", "o1"), sha256: "0".repeat(64) };
    const pkg = await open(seal(V2E, V2, payload(V2, "order", { customers: [customer("c1", "ada@legacy.example.test")], orders: [order("o1", "c1")], files: [f] })));
    const report = await pkg.verify();
    await pkg.close();
    expect(report.issues.map((x) => x.code)).toContain("DIGEST_MISMATCH");
  });

  it("rejects a wrong passphrase, a tampered ciphertext and a malformed envelope", async () => {
    const sealed = seal(V2E, V2, v2());
    await expect(open(sealed, "wrong passphrase for legacy")).rejects.toMatchObject({ code: "PASSPHRASE_REJECTED" });
    const env = JSON.parse(sealed.toString()) as Record<string, string>;
    const ct = Buffer.from(env.ciphertext!, "base64url");
    ct[3] = ct[3]! ^ 1;
    env.ciphertext = ct.toString("base64url");
    await expect(open(Buffer.from(JSON.stringify(env) + "\n"))).rejects.toMatchObject({ code: "PASSPHRASE_REJECTED" });
    await expect(open(Buffer.from('{"format":"nope"}\n'))).rejects.toMatchObject({ code: "UNSUPPORTED_ENVELOPE" });
  });

  it("refuses an envelope/payload format mismatch (AAD binds the format)", async () => {
    await expect(open(seal(V1E, V2, v2()))).rejects.toMatchObject({ code: "PASSPHRASE_REJECTED" });
  });

  it("reports invalid legacy shapes instead of guessing", async () => {
    const bad = payload(V2, "customer", { customers: [{ ...customer("c1", "ada@legacy.example.test"), marketingOptIn: "yes" }], orders: [], files: [] });
    const pkg = await open(seal(V2E, V2, bad));
    const report = await pkg.verify();
    await pkg.close();
    expect(report.ok).toBe(false);
    expect(report.issues.map((x) => x.code)).toContain("LEGACY_INVALID");
  });

  it("refuses records after a failed verification", async () => {
    const pkg = await open(seal(V2E, V2, payload(V2, "customer", { customers: [customer("c1", "ada@legacy.example.test")], orders: [], files: [] }, { badId: true })));
    await pkg.verify();
    await expect(collect(pkg)).rejects.toMatchObject({ code: "NOT_VERIFIED" });
    await pkg.close();
  });
});

describe("legacy v1 adapter", () => {
  it("upgrades a single-record v1 file package", async () => {
    const p = payload(V1, "file", { customers: [customer("c1", "ada@legacy.example.test")], orders: [order("o1", "c1")], files: [file("f1", "o1")] });
    const pkg = await open(seal(V1E, V1, p));
    try {
      const report = await pkg.verify();
      expect(report.issues).toEqual([]);
      expect(report.sourceFormat).toBe("v1");
      const types = (await collect(pkg)).map((r) => r.type);
      expect(types).toEqual(expect.arrayContaining(["customers", "orders", "order-items", "order-status-history", "files", "file-versions", "provenance"]));
    } finally {
      await pkg.close();
    }
  });

  it("enforces the v1 single-record scope", async () => {
    const p = payload(V1, "customer", { customers: [customer("c1", "a@legacy.example.test"), customer("c2", "b@legacy.example.test")], orders: [], files: [] });
    const pkg = await open(seal(V1E, V1, p));
    const report = await pkg.verify();
    await pkg.close();
    expect(report.issues.map((x) => x.code)).toContain("LEGACY_INVALID");
  });
});
