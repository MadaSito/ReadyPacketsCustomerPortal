/** Synthetic fixtures for portable tests (no real data; *.example.test addresses only). */
import type { Entry as YauzlEntry } from "yauzl";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import yazl from "yazl";
import { createPackageWriter, type CreateWriterOptions, type FinalizeResult } from "../src/writer.js";
import { DEFAULT_CHUNK_SIZE, EncryptStream, deriveKeys, encodeHeader, newHeader, openEnvelopeHeader, decryptBody } from "../src/crypto/envelope.js";
import { resolveLimits } from "../src/limits.js";
import { open } from "node:fs/promises";
import type { RecordOf, RecordType } from "../src/contract/records.js";
import { canonicalJson } from "../src/json.js";
import { derivedUlid } from "../src/ulid.js";

export const PASS = "correct horse battery staple 2026";
export const FAST_KDF = { N: 2 ** 14, r: 8, p: 1 };
export const T = "2026-03-01T12:00:00.000Z";

/** Deterministic pseudo-random bytes for reproducible fixtures. */
export function seededRandom(seed: string): (n: number) => Uint8Array {
  let counter = 0;
  return (n: number) => {
    const out = Buffer.alloc(n);
    let off = 0;
    while (off < n) {
      const block = createHash("sha256").update(`${seed}:${counter++}`).digest();
      off += block.copy(out, off);
    }
    return out;
  };
}

const FIXTURE_KEYS = ["cust", "cust2", "order", "item", "hist", "share", "file", "ver", "thread", "msg", "ticket", "tcomment", "policy", "accept", "intakeDef", "intakeSub", "invoice", "payment", "refund", "prov"] as const;
export const ID = Object.fromEntries(FIXTURE_KEYS.map((k) => [k, derivedUlid("fixture", k, Date.parse(T))])) as Record<(typeof FIXTURE_KEYS)[number], string>;
export const PACKAGE_ID = derivedUlid("fixture", "package", Date.parse(T));

export const OBJECT_BYTES = Buffer.from("synthetic portable object bytes\n".repeat(200));
export const OBJECT_SHA = createHash("sha256").update(OBJECT_BYTES).digest("hex");

const usd = (n: number) => ({ amountMinor: n, currency: "USD" });

export function sampleRecords(): Array<{ [K in RecordType]: [K, RecordOf<K>] }[RecordType]> {
  return [
    ["customers", { publicId: ID.cust, customerNumber: "C-1001", status: "active", email: "ada@customer.example.test", firstName: "Ada", middleName: null, lastName: "Example", preferredName: null, suffix: null, company: "Example Co", phone: null, address: null, timezone: "America/New_York", locale: "en-US", marketingOptIn: false, createdAt: T, updatedAt: null, heldUnknown: { legacyTier: "gold" } }],
    ["customers", { publicId: ID.cust2, customerNumber: null, status: "active", email: "bo@customer.example.test", firstName: "Bo", middleName: null, lastName: null, preferredName: null, suffix: null, company: null, phone: null, address: null, timezone: null, locale: null, marketingOptIn: true, createdAt: T, updatedAt: T }],
    ["orders", { publicId: ID.order, customerPublicId: ID.cust, orderNumber: "RP-2026-0001", projectName: "Synthetic project", status: "in_production", paymentStatus: "paid", paymentRequirement: "upfront", currency: "USD", subtotal: usd(150000), discount: usd(0), total: usd(150000), isTestOrder: false, lock: { readOnly: false, reasonCode: null }, completionPercent: 40, internalNotes: "staff only", submittedAt: T, dueAt: null, deliveredAt: null, closedAt: null, createdAt: T, updatedAt: T }],
    ["order-items", { publicId: ID.item, orderPublicId: ID.order, position: 0, sku: "PKT-STD", name: "Standard packet", tier: "standard", quantity: 1, unitPrice: usd(150000), lineTotal: usd(150000) }],
    ["order-status-history", { publicId: ID.hist, orderPublicId: ID.order, fromStatus: "new", toStatus: "in_production", reasonCode: null, note: null, actor: { kind: "staff", publicId: null }, occurredAt: T }],
    ["order-shares", { publicId: ID.share, orderPublicId: ID.order, granteeCustomerPublicId: ID.cust2, access: "read", grantedBy: { kind: "customer", publicId: ID.cust }, grantedAt: T, expiresAt: null, revokedAt: null }],
    ["files", { publicId: ID.file, orderPublicId: ID.order, category: "deliverable", phase: "phase_1", visibleToCustomer: true, createdAt: T, deletedAt: null }],
    ["file-versions", { publicId: ID.ver, filePublicId: ID.file, version: 1, originalName: "brief.pdf", mediaType: "application/pdf", extension: "pdf", sizeBytes: OBJECT_BYTES.length, sha256: OBJECT_SHA, durationSeconds: null, uploadedBy: { kind: "customer", publicId: ID.cust }, createdAt: T }],
    ["message-threads", { publicId: ID.thread, customerPublicId: ID.cust, orderPublicId: ID.order, subject: "Kickoff", createdAt: T, closedAt: null }],
    ["messages", { publicId: ID.msg, threadPublicId: ID.thread, author: { kind: "customer", publicId: ID.cust }, body: "Hello <b>not html</b>", attachmentFileVersionPublicIds: [ID.ver], sentAt: T, editedAt: null }],
    ["tickets", { publicId: ID.ticket, customerPublicId: ID.cust, orderPublicId: null, ticketNumber: "T-1", subject: "Question", status: "open", priority: null, category: null, createdAt: T, closedAt: null }],
    ["ticket-comments", { publicId: ID.tcomment, ticketPublicId: ID.ticket, author: { kind: "staff", publicId: null }, body: "Internal", internal: true, createdAt: T }],
    ["policy-versions", { publicId: ID.policy, policyKey: "mnda", version: "2026.1", title: "Mutual NDA", contentSha256: "a".repeat(64), contentText: null, effectiveAt: T, retiredAt: null }],
    ["policy-acceptances", { publicId: ID.accept, policyVersionPublicId: ID.policy, customerPublicId: ID.cust, orderPublicId: ID.order, method: "click-through", acceptedAt: T, evidenceNote: null }],
    ["intake-definitions", { publicId: ID.intakeDef, key: "p101", version: 1, title: "Intake", questions: [{ key: "goal", label: "Goal?", kind: "text", required: true, options: null }], createdAt: T }],
    ["intake-submissions", { publicId: ID.intakeSub, definitionPublicId: ID.intakeDef, orderPublicId: ID.order, customerPublicId: ID.cust, status: "submitted", answers: [{ questionKey: "goal", value: "Ship" }], submittedAt: T }],
    ["invoices", { publicId: ID.invoice, customerPublicId: ID.cust, orderPublicId: ID.order, invoiceNumber: "INV-1", status: "paid", currency: "USD", lines: [{ description: "Packet", quantity: 1, unitPrice: usd(150000), total: usd(150000) }], subtotal: usd(150000), tax: usd(0), total: usd(150000), issuedAt: T, dueAt: null, providerReference: null }],
    ["payments", { publicId: ID.payment, customerPublicId: ID.cust, invoicePublicId: ID.invoice, orderPublicId: ID.order, amount: usd(150000), method: "card", status: "succeeded", receivedAt: T, providerReference: { provider: "stripe", reference: "pi_synthetic_1" } }],
    ["refunds", { publicId: ID.refund, paymentPublicId: ID.payment, amount: usd(1000), status: "succeeded", reasonCode: "GOODWILL", refundedAt: T, providerReference: null }],
    ["provenance", { publicId: ID.prov, subjectType: "orders", subjectPublicId: ID.order, sourceSystemPseudonym: "rp-src-test", sourceRecordType: "order", sourceReference: ID.order, transformation: null, notes: [] }],
  ];
}

export async function tmpDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "rp-portable-test-"));
}

export async function writeSample(dir: string, overrides: Partial<CreateWriterOptions> = {}, name = "pkg.rpkg"): Promise<{ file: string; result: FinalizeResult }> {
  const file = path.join(dir, name);
  const w = await createPackageWriter({
    output: file,
    passphrase: PASS,
    kdf: FAST_KDF,
    manifest: {
      packageId: PACKAGE_ID,
      sourceSystem: { pseudonym: "rp-src-test" },
      sourceRelease: "2026.11.0",
      generatedAt: T,
      scope: { profile: "all-core", description: "Synthetic all-core test package", selection: { mode: "fixed", count: 2 } },
    },
    randomBytes: seededRandom("fixture"),
    ...overrides,
  });
  for (const [type, rec] of sampleRecords()) await w.addRecord(type, rec as never);
  await w.addObject({ source: OBJECT_BYTES, expectedSha256: OBJECT_SHA });
  const result = await w.finalize();
  return { file, result };
}

/** Decrypt a package into its plaintext zip (test-only helper for tamper scenarios). */
export async function decryptToZip(file: string, passphrase = PASS): Promise<Buffer> {
  const fh = await open(file, "r");
  try {
    const st = await fh.stat();
    const env = await openEnvelopeHeader(fh, passphrase, resolveLimits());
    const parts: Buffer[] = [];
    await decryptBody(fh, env, st.size, async (p) => void parts.push(p), Number.MAX_SAFE_INTEGER);
    return Buffer.concat(parts);
  } finally {
    await fh.close();
  }
}

/** Seal arbitrary plaintext zip bytes with a valid envelope — simulates a passphrase holder crafting content. */
export async function sealZip(zipBytes: Buffer, file: string, opts: { packageId?: string; passphrase?: string; chunkSize?: number } = {}): Promise<void> {
  const header = newHeader(opts.packageId ?? PACKAGE_ID, FAST_KDF, opts.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const keys = await deriveKeys(opts.passphrase ?? PASS, header.kdf);
  const enc = new EncryptStream(keys, encodeHeader(header), header.chunkSize);
  const out: Buffer[] = [];
  enc.on("data", (c: Buffer) => out.push(c));
  const done = new Promise<void>((resolve, reject) => {
    enc.on("end", resolve);
    enc.on("error", reject);
  });
  enc.end(zipBytes);
  await done;
  await writeFile(file, Buffer.concat(out));
}

export interface ZipMember {
  name: string;
  data: Buffer;
  compress?: boolean;
  mode?: number;
}

export async function buildZip(members: ZipMember[]): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const m of members) zip.addBuffer(m.data, m.name, { compress: m.compress ?? true, mtime: new Date(1980, 0, 1), forceDosTimestamp: true, ...(m.mode ? { mode: m.mode } : {}) });
  zip.end();
  const parts: Buffer[] = [];
  for await (const c of zip.outputStream as AsyncIterable<Buffer>) parts.push(c);
  return Buffer.concat(parts);
}

/** Read members of a plaintext zip (test helper). */
export async function readZipMembers(zipBytes: Buffer): Promise<ZipMember[]> {
  const yauzl = (await import("yauzl")).default;
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(zipBytes, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const out: ZipMember[] = [];
      zip.on("entry", (e: YauzlEntry) => {
        zip.openReadStream(e, (er, s) => {
          if (er || !s) return reject(er);
          const parts: Buffer[] = [];
          s.on("data", (c: Buffer) => parts.push(c));
          s.on("end", () => {
            out.push({ name: e.fileName, data: Buffer.concat(parts), compress: e.compressionMethod === 8 });
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => resolve(out));
      zip.readEntry();
    });
  });
}

/** Re-seal a package after transforming its members (keeps manifest unless transform changes it). */
export async function mutatePackage(src: string, dest: string, transform: (members: ZipMember[]) => ZipMember[] | Promise<ZipMember[]>): Promise<void> {
  const members = await readZipMembers(await decryptToZip(src));
  await sealZip(await buildZip(await transform(members)), dest);
}

export function manifestOf(members: ZipMember[]): Record<string, unknown> {
  return JSON.parse(members.find((m) => m.name === "manifest.json")!.data.toString("utf8")) as Record<string, unknown>;
}
export function setManifest(members: ZipMember[], manifest: unknown): ZipMember[] {
  return members.map((m) => (m.name === "manifest.json" ? { ...m, data: Buffer.from(canonicalJson(manifest) + "\n") } : m));
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export { readFile };
