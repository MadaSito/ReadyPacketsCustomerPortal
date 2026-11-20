/**
 * Legacy v1/v2 (.rptransfer) adapter: decrypts the source envelope, validates the payload with the source
 * system's own field bounds, recomputes the legacy packageId digest (the source only checked its shape),
 * and upgrades contents in memory to contract-v3 records with explicit loss reporting.
 *
 * Unknown legacy fields are preserved in `heldUnknown`; fields v3 does not model are preserved there too.
 * Nothing is silently discarded: every transformation that changes a value is reported in `losses`.
 */
import { createDecipheriv, createHash, scrypt } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { PortableError } from "../errors.js";
import { canonicalJson, hasControlChars, safeJsonParse, sanitizeFileName } from "../json.js";
import type { PortableLimits } from "../limits.js";
import { derivedUlid } from "../ulid.js";
import { CONTRACT_NAME, CONTRACT_VERSION, HARD_EXCLUSIONS, ManifestSchema, PACKAGE_FORMAT, type Manifest } from "../contract/manifest.js";
import { RECORD_TYPE_ORDER, referencesOf, type AnyRecord, type RecordOf, type RecordType } from "../contract/records.js";
import { computeContentDigest } from "../digest.js";
import { checkRecord } from "../validate.js";
import type { PortablePackage, RecordEnvelope, VerificationIssue, VerificationReport } from "../types.js";
import { LegacyCustomer, LegacyEnvelope, LegacyFile, LegacyHistory, LegacyItem, LegacyOrder, LegacyPayload, V1_ENVELOPE, V1_FORMAT, V2_FORMAT } from "./schemas.js";

export const LEGACY_ADAPTER = { adapter: "legacy-v1v2", version: "1.0" } as const;
const LEGACY_KDF = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 } as const;

type Loss = VerificationReport["losses"][number];

/** Fixed ULID time component for legacy-derived record ids (2020-01-01T00:00:00Z). */
export const LEGACY_ID_EPOCH_MS = Date.UTC(2020, 0, 1);

/** Enforce caller limits on the untrusted decrypted payload BEFORE any base64 decode or conversion. */
function preflightLegacy(raw: unknown, limits: PortableLimits): void {
  const contents = (raw as { contents?: Record<string, unknown> } | null)?.contents;
  if (!contents || typeof contents !== "object") return; // shape errors are reported by validation
  let total = 0;
  for (const key of ["customers", "orders", "files"] as const) {
    const list = contents[key];
    if (!Array.isArray(list)) continue;
    if (list.length > limits.maxRecordsPerType) throw new PortableError("SIZE_LIMIT", "The legacy package has too many records of one type.", { recordType: key });
    if (key !== "files") continue;
    for (const f of list as Array<{ contents?: unknown }>) {
      const encoded = typeof f?.contents === "string" ? f.contents.length : 0;
      const decoded = Math.floor((encoded * 3) / 4);
      if (decoded > limits.maxObjectBytes) throw new PortableError("SIZE_LIMIT", "A legacy file exceeds the object size limit.");
      total += decoded;
      if (total > limits.maxTotalUncompressed) throw new PortableError("SIZE_LIMIT", "The legacy package exceeds the total size limit.");
    }
  }
}

/** Categories the v1/v2 formats never carried (architecture §6.1). */
const FORMAT_LOSSES: Loss[] = [
  { code: "NOT_CARRIED_BILLING", message: "Invoices, payments, refunds and receipts are not in v1/v2; a payment status flag is not payment evidence." },
  { code: "NOT_CARRIED_LEGAL", message: "Legal/policy acceptance evidence is not in v1/v2 (only an MNDA timestamp, preserved as held-unknown)." },
  { code: "NOT_CARRIED_INTAKE", message: "Intake definitions and answers are not in v1/v2 (only a completion timestamp, preserved as held-unknown)." },
  { code: "NOT_CARRIED_MESSAGES", message: "Messages and tickets are not in v1/v2." },
  { code: "NOT_CARRIED_CUSTOM_FIELDS", message: "Custom profile values are not in v1/v2." },
  { code: "NOT_CARRIED_FILE_HISTORY", message: "Only the active current version of each file is in v1/v2; prior versions, derivatives and deleted history are absent." },
  { code: "NOT_CARRIED_ACCESS_EVIDENCE", message: "Order shares, provider, workflow and file-access evidence are not in v1/v2." },
  { code: "UNKNOWN_CUSTOMER_NUMBER", message: "Customer numbers and profile creation times are not in v1/v2 (set to null)." },
  { code: "UNKNOWN_LOCK_STATE", message: "Order read-only lock state is not in v1/v2 (set to null = unknown); importers must default to read-only." },
  { code: "UNKNOWN_HISTORY_ACTOR", message: "Status-history actors are not in v1/v2 (actor kind = unknown); free-text reasons are kept as notes." },
];

function lossOf(list: Loss[], code: string, message: string): void {
  const l = list.find((x) => x.code === code);
  if (l) l.count = (l.count ?? 1) + 1;
  else list.push({ code, message, count: 1 });
}

const iso = (v: string): string => new Date(v).toISOString();
const isoN = (v: string | null): string | null => (v === null ? null : iso(v));

type Held = NonNullable<RecordOf<"customers">["heldUnknown"]>;

function extraKeys(obj: Record<string, unknown>, known: ReadonlySet<string>): Held {
  const out: Held = {};
  for (const [k, v] of Object.entries(obj)) if (!known.has(k)) out[k] = v as Held[string];
  return out;
}

async function deriveLegacyKey(passphrase: string | Uint8Array, salt: Buffer): Promise<Buffer> {
  const pass = typeof passphrase === "string" ? Buffer.from(passphrase, "utf8") : Buffer.from(passphrase);
  return new Promise((resolve, reject) => scrypt(pass, salt, 32, LEGACY_KDF, (e, k) => (e ? reject(e) : resolve(k))));
}

export async function openLegacyPackage(bytes: Buffer, passphrase: string | Uint8Array, limits: PortableLimits): Promise<PortablePackage> {
  const ciphertextSha256 = createHash("sha256").update(bytes).digest("hex");
  let envelope: ReturnType<typeof LegacyEnvelope.parse>;
  try {
    const text = bytes.toString("utf8");
    if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) throw new Error("shape");
    envelope = LegacyEnvelope.parse(safeJsonParse(text.slice(0, -1)));
  } catch {
    throw new PortableError("UNSUPPORTED_ENVELOPE", "The legacy package envelope is malformed or unsupported.");
  }
  const salt = Buffer.from(envelope.salt, "base64url");
  const iv = Buffer.from(envelope.iv, "base64url");
  const tag = Buffer.from(envelope.tag, "base64url");
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) throw new PortableError("HEADER_INVALID", "The legacy envelope parameters are invalid.");
  const payloadFormat = envelope.format === V1_ENVELOPE ? V1_FORMAT : V2_FORMAT;
  const key = await deriveLegacyKey(passphrase, salt);
  let plain: Buffer;
  try {
    const d = createDecipheriv("aes-256-gcm", key, iv);
    d.setAAD(Buffer.from(payloadFormat, "utf8"));
    d.setAuthTag(tag);
    plain = Buffer.concat([d.update(Buffer.from(envelope.ciphertext, "base64url")), d.final()]);
  } catch {
    throw new PortableError("PASSPHRASE_REJECTED", "The passphrase is incorrect or the legacy package was altered.");
  } finally {
    key.fill(0);
  }
  let raw: unknown;
  try {
    raw = safeJsonParse(plain.toString("utf8"));
  } catch {
    throw new PortableError("LEGACY_INVALID", "The legacy payload is not valid JSON.");
  }
  const manifestSha256 = createHash("sha256").update(plain).digest("hex");
  preflightLegacy(raw, limits);
  return LegacyPackage.build(raw, payloadFormat, limits, manifestSha256, ciphertextSha256);
}

/**
 * Budget over the EXPANDED result (every derived record type incl. items, history, file versions and
 * provenance, plus normalized record bytes and object bytes) — the same limits a v3 package is held to.
 */
function enforceConvertedBudget(c: Converted, limits: PortableLimits): void {
  let total = 0;
  for (const [type, list] of c.records) {
    if (list.length > limits.maxRecordsPerType) throw new PortableError("SIZE_LIMIT", "The upgraded legacy package has too many records of one type.", { recordType: type });
    for (const rec of list) {
      total += Buffer.byteLength(canonicalJson(rec)) + 1;
      if (total > limits.maxTotalUncompressed) throw new PortableError("SIZE_LIMIT", "The upgraded legacy package exceeds the total size limit.");
    }
  }
  for (const buf of c.objects.values()) {
    if (buf.length > limits.maxObjectBytes) throw new PortableError("SIZE_LIMIT", "A legacy file exceeds the object size limit.");
    total += buf.length;
    if (total > limits.maxTotalUncompressed) throw new PortableError("SIZE_LIMIT", "The upgraded legacy package exceeds the total size limit.");
  }
}

interface Converted {
  records: Map<RecordType, AnyRecord[]>;
  objects: Map<string, Buffer>;
  issues: VerificationIssue[];
  losses: Loss[];
  warnings: Array<{ code: string; message: string }>;
  manifest: Manifest;
  sourceFormat: "v1" | "v2";
}

export function convertLegacyPayload(raw: unknown, payloadFormat: string): Converted {
  const issues: VerificationIssue[] = [];
  const losses: Loss[] = FORMAT_LOSSES.map((l) => ({ ...l }));
  const warnings: Array<{ code: string; message: string }> = [];
  const records = new Map<RecordType, AnyRecord[]>();
  const objects = new Map<string, Buffer>();
  const push = <T extends RecordType>(type: T, rec: RecordOf<T>) => {
    const list = records.get(type) ?? [];
    list.push(rec as AnyRecord);
    records.set(type, list);
  };
  const sourceFormat = payloadFormat === V1_FORMAT ? "v1" : "v2";
  const parsed = LegacyPayload.safeParse(raw);
  const r = (raw ?? {}) as Record<string, unknown>;
  const generatedAt = parsed.success ? iso(parsed.data.generatedAt) : "1970-01-01T00:00:00.000Z";
  const legacyPackageId = parsed.success ? parsed.data.packageId : "0".repeat(64);
  const sourceRef = parsed.success ? parsed.data.sourceSystemRef : "0".repeat(64);
  const pseudonym = `legacy-${sourceRef.slice(0, 32)}`;
  const t0 = Date.parse(generatedAt);
  // Ids depend only on the source system ref + the stable per-record legacy ref, never on export time, so
  // re-exports of the same source records map to the same portable ids (idempotent re-import).
  const pid = (kind: string, ref: string) => derivedUlid(`rp-legacy:${sourceRef}:${kind}`, ref, LEGACY_ID_EPOCH_MS);

  if (!parsed.success) {
    const i = parsed.error.issues[0];
    issues.push({ code: "LEGACY_INVALID", message: "The legacy payload does not match the v1/v2 source format.", path: i ? `/${i.path.map(String).join("/")}` : "" });
  } else {
    const p = parsed.data;
    if (p.format !== payloadFormat) issues.push({ code: "LEGACY_INVALID", message: "The legacy envelope and payload formats disagree." });
    // Recompute the legacy package id (source wrote SHA-256 of the draft JSON without packageId).
    const { packageId: _ignored, ...draft } = r;
    void _ignored;
    const digest = createHash("sha256").update(JSON.stringify(draft), "utf8").digest("hex");
    if (digest !== p.packageId) issues.push({ code: "DIGEST_MISMATCH", message: "The legacy packageId does not match the SHA-256 of its payload." });
    const { customers, orders, files } = p.contents;
    if (sourceFormat === "v1") {
      if (customers.length !== 1 || orders.length > 1 || files.length > 1) issues.push({ code: "LEGACY_INVALID", message: "The v1 package exceeds its single-record scope." });
      if (p.scope === "customer" && (orders.length || files.length)) issues.push({ code: "LEGACY_INVALID", message: "A v1 customer package contains dependent records." });
      if (p.scope === "order" && !orders.length) issues.push({ code: "LEGACY_INVALID", message: "A v1 order package is missing its order." });
      if (p.scope === "file" && (!orders.length || !files.length)) issues.push({ code: "LEGACY_INVALID", message: "A v1 file package is incomplete." });
    } else if (p.scope === "file") issues.push({ code: "LEGACY_INVALID", message: "A v2 package cannot have file scope." });
    if (customers.length + orders.length + files.length > 10_000) issues.push({ code: "LEGACY_INVALID", message: "The v2 package exceeds 10000 records." });

    const custKnown = new Set(Object.keys(LegacyCustomer.shape));
    const orderKnown = new Set(Object.keys(LegacyOrder.shape));
    const itemKnown = new Set(Object.keys(LegacyItem.shape));
    const histKnown = new Set(Object.keys(LegacyHistory.shape));
    const fileKnown = new Set(Object.keys(LegacyFile.shape));
    const emails = new Set<string>();
    const orderNumbers = new Set<string>();
    const fileHashes = new Set<string>();
    const custOwner = new Map<string, string>();
    const prov = (subjectType: RecordType, subjectPublicId: string, kind: string, ref: string, notes: string[] = []) =>
      push("provenance", {
        publicId: pid(`provenance:${kind}`, ref),
        subjectType,
        subjectPublicId,
        sourceSystemPseudonym: pseudonym,
        sourceRecordType: `legacy-${sourceFormat}:${kind}`,
        sourceReference: ref,
        transformation: { ...LEGACY_ADAPTER },
        notes,
      });
    const unknownFrom = (obj: Record<string, unknown>, known: ReadonlySet<string>) => {
      const extra = extraKeys(obj, known);
      if (Object.keys(extra).length) lossOf(losses, "HELD_UNKNOWN_LEGACY_FIELDS", "Legacy fields not defined by the v1/v2 source format were preserved verbatim as held-unknown.");
      return extra;
    };

    for (const c of customers) {
      const email = c.email.trim().toLowerCase();
      if (email !== c.email) {
        if (sourceFormat === "v2") issues.push({ code: "LEGACY_INVALID", message: "A v2 customer email is not normalized." });
        else lossOf(losses, "EMAIL_NORMALIZED", "Customer e-mail addresses were trimmed and lower-cased.");
      }
      if (emails.has(email)) issues.push({ code: "LEGACY_INVALID", message: "The legacy package has duplicate customer emails." });
      emails.add(email);
      const publicId = pid("customer", c.ref);
      custOwner.set(c.ref, publicId);
      const held = unknownFrom(c, custKnown);
      push("customers", {
        publicId,
        customerNumber: null,
        status: c.status,
        email,
        firstName: c.firstName,
        middleName: c.middleName,
        lastName: c.lastName,
        preferredName: c.preferredName,
        suffix: c.suffix,
        company: c.company,
        phone: c.phone,
        address: c.address,
        timezone: c.timezone,
        locale: null,
        marketingOptIn: c.marketingOptIn,
        createdAt: null,
        updatedAt: null,
        ...(Object.keys(held).length ? { heldUnknown: held } : {}),
      });
      prov("customers", publicId, "customer", c.ref);
    }

    const orderIds = new Map<string, string>();
    for (const o of orders) {
      const customerPublicId = custOwner.get(o.customerRef);
      if (!customerPublicId) issues.push({ code: "REFERENCE_UNRESOLVED", message: "A legacy order references a customer that is not in the package.", recordType: "orders" });
      if (orderNumbers.has(o.orderNumber.toLowerCase())) issues.push({ code: "LEGACY_INVALID", message: "The legacy package has duplicate order numbers." });
      orderNumbers.add(o.orderNumber.toLowerCase());
      const skus = new Set(o.items.map((i) => i.sku.toLowerCase()));
      if (sourceFormat === "v2" && skus.size !== o.items.length) issues.push({ code: "LEGACY_INVALID", message: "A legacy order has duplicate SKUs." });
      const publicId = pid("order", o.ref);
      orderIds.set(o.ref, publicId);
      const money = (amountMinor: number) => ({ amountMinor, currency: o.currency });
      push("orders", {
        publicId,
        customerPublicId: customerPublicId ?? pid("customer", o.customerRef),
        orderNumber: o.orderNumber,
        projectName: o.projectName,
        status: o.status,
        paymentStatus: o.paymentStatus,
        paymentRequirement: o.paymentRequirement,
        currency: o.currency,
        subtotal: money(o.subtotalCents),
        discount: money(o.discountCents),
        total: money(o.totalCents),
        isTestOrder: o.isTestOrder,
        lock: null,
        completionPercent: o.completionPercent,
        internalNotes: o.internalNotes,
        dueAt: isoN(o.dueAt),
        deliveredAt: isoN(o.deliveredAt),
        closedAt: isoN(o.closedAt),
        createdAt: iso(o.createdAt),
        updatedAt: null,
        heldUnknown: {
          ...unknownFrom(o, orderKnown),
          priceSource: o.priceSource,
          manualPriceCents: o.manualPriceCents,
          bundleApplied: o.bundleApplied,
          integrityChoice: o.integrityChoice,
          mndaAcceptedAt: isoN(o.mndaAcceptedAt),
          intakeCompletedAt: isoN(o.intakeCompletedAt),
          phase2ScheduledAt: isoN(o.phase2ScheduledAt),
        },
      });
      prov("orders", publicId, "order", o.ref);
      o.items.forEach((it, idx) => {
        const extra = unknownFrom(it, itemKnown);
        push("order-items", {
          publicId: pid("order-item", `${o.ref}:${idx}`),
          orderPublicId: publicId,
          position: idx,
          sku: it.sku,
          name: it.name,
          tier: it.tier,
          quantity: it.quantity,
          unitPrice: money(it.unitPriceCents),
          lineTotal: money(it.lineTotalCents),
          ...(Object.keys(extra).length ? { heldUnknown: extra } : {}),
        });
      });
      o.statusHistory.forEach((h, idx) => {
        const extra = unknownFrom(h, histKnown);
        push("order-status-history", {
          publicId: pid("status-history", `${o.ref}:${idx}`),
          orderPublicId: publicId,
          fromStatus: h.fromStatus,
          toStatus: h.toStatus,
          reasonCode: null,
          note: h.reason,
          actor: { kind: "unknown", publicId: null },
          occurredAt: iso(h.occurredAt),
          ...(Object.keys(extra).length ? { heldUnknown: extra } : {}),
        });
      });
    }

    for (const f of files) {
      const orderPublicId = orderIds.get(f.orderRef);
      if (!orderPublicId) issues.push({ code: "REFERENCE_UNRESOLVED", message: "A legacy file references an order that is not in the package.", recordType: "files" });
      const content = Buffer.from(f.contents, "base64");
      if (content.toString("base64") !== f.contents) issues.push({ code: "LEGACY_INVALID", message: "A legacy file has non-canonical base64 content.", recordType: "files" });
      const sha = createHash("sha256").update(content).digest("hex");
      if (content.length !== f.sizeBytes || sha !== f.sha256) issues.push({ code: "DIGEST_MISMATCH", message: "Legacy file bytes do not match their recorded size/SHA-256.", recordType: "files" });
      const dupKey = `${f.orderRef}:${f.sha256}`;
      if (fileHashes.has(dupKey)) issues.push({ code: "LEGACY_INVALID", message: "The legacy package has duplicate file content on an order." });
      fileHashes.add(dupKey);
      objects.set(sha, content);
      const filePublicId = pid("file", f.ref);
      const held: Held = { ...unknownFrom(f, fileKnown) };
      let name = f.originalName;
      if (/[\\/]/.test(name) || hasControlChars(name) || name === "." || name === "..") {
        held.originalName = f.originalName;
        name = sanitizeFileName(name);
        if (name === "." || name === "..") name = "_";
        lossOf(losses, "FILE_NAME_SANITIZED", "File names with path or control characters were sanitized; originals are kept as held-unknown.");
      }
      let mediaType = f.detectedMime.toLowerCase();
      if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(mediaType)) {
        held.detectedMime = f.detectedMime;
        mediaType = "application/octet-stream";
        lossOf(losses, "MEDIA_TYPE_GENERALIZED", "Media types outside the v3 grammar were set to application/octet-stream; originals are kept as held-unknown.");
      }
      push("files", {
        publicId: filePublicId,
        orderPublicId: orderPublicId ?? pid("order", f.orderRef),
        category: f.category,
        phase: f.phase,
        visibleToCustomer: f.visibleToCustomer,
        createdAt: iso(f.createdAt),
        deletedAt: null,
      });
      push("file-versions", {
        publicId: pid("file-version", f.ref),
        filePublicId,
        version: f.version,
        originalName: name,
        mediaType,
        extension: f.extension,
        sizeBytes: content.length,
        sha256: sha,
        durationSeconds: f.durationSeconds,
        uploadedBy: { kind: "unknown", publicId: null },
        createdAt: iso(f.createdAt),
        ...(Object.keys(held).length ? { heldUnknown: held } : {}),
      });
      prov("files", filePublicId, "file", f.ref);
    }
  }

  // Provenance last (contract order), then synthesize the v3 manifest from canonical lines.
  const entries = RECORD_TYPE_ORDER.filter((t) => records.has(t)).map((t) => {
    const lines = records.get(t)!.map((rec) => canonicalJson(rec) + "\n").join("");
    const buf = Buffer.from(lines, "utf8");
    return { type: t, file: `records/${t}.jsonl`, count: records.get(t)!.length, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
  });
  const objs = [...objects.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([sha256, b]) => ({ sha256, size: b.length }));
  const profile = !parsed.success ? "custom" : sourceFormat === "v1" ? ({ customer: "customer-only", order: "complete-order-with-files", file: "selected-files" } as const)[parsed.data.scope] : "custom";
  const manifest: Manifest = {
    format: PACKAGE_FORMAT,
    formatVersion: 3,
    contract: { name: CONTRACT_NAME, version: CONTRACT_VERSION },
    compatibility: { minReaderVersion: CONTRACT_VERSION, requiredModules: ["core"] },
    packageId: derivedUlid("rp-legacy-package", legacyPackageId, t0),
    exportId: legacyPackageId,
    producer: { name: `legacy-${sourceFormat}-adapter`, version: LEGACY_ADAPTER.version },
    sourceSystem: { pseudonym },
    sourceRelease: parsed.success ? parsed.data.sourceRelease : null,
    generatedAt,
    snapshot: { kind: sourceFormat === "v2" ? "repeatable-read" : "none", takenAt: generatedAt, identity: null },
    scope: { profile, description: `Upgraded in memory from ${payloadFormat}${parsed.success ? ` (scope ${parsed.data.scope})` : ""}.`, selection: null },
    modules: [{ name: "core", version: CONTRACT_VERSION }],
    records: entries,
    objects: objs,
    extensions: [],
    dependencyClosure: { external: [] },
    exclusions: HARD_EXCLUSIONS.map((category) => ({ category, reason: "Never carried by v1/v2 packages." })),
    limitations: [
      "Upgraded from a legacy v1/v2 package; see the verification report losses.",
      "Legacy encryption authenticates a shared passphrase only, not the source organization.",
    ],
    contentDigest: computeContentDigest(entries, objs, []),
  };
  const checked = ManifestSchema.safeParse(manifest);
  if (!checked.success) issues.push({ code: "MANIFEST_INVALID", message: "The upgraded manifest could not be built from the legacy package." });
  warnings.push({ code: "LEGACY_FORMAT", message: `This package uses the legacy ${payloadFormat} format and was upgraded in memory to contract ${CONTRACT_VERSION}.` });
  return { records, objects, issues, losses, warnings, manifest, sourceFormat };
}

class LegacyPackage implements PortablePackage {
  private verified = false;
  private report: VerificationReport | null = null;
  readonly sourceFormat: "v1" | "v2";
  readonly manifest: Manifest;
  private constructor(
    private readonly c: Converted,
    private readonly limits: PortableLimits,
    readonly manifestSha256: string,
    readonly ciphertextSha256: string,
  ) {
    this.sourceFormat = c.sourceFormat;
    this.manifest = c.manifest;
  }

  static build(raw: unknown, payloadFormat: string, limits: PortableLimits, manifestSha256: string, ciphertextSha256: string): LegacyPackage {
    const converted = convertLegacyPayload(raw, payloadFormat);
    enforceConvertedBudget(converted, limits);
    return new LegacyPackage(converted, limits, manifestSha256, ciphertextSha256);
  }

  async verify(): Promise<VerificationReport> {
    if (this.report) return this.report;
    const issues = [...this.c.issues];
    const ids = new Set<string>();
    const counts: Partial<Record<RecordType, number>> = {};
    let held = 0;
    const refs: Array<[RecordType, string, RecordType]> = [];
    for (const [type, list] of this.c.records) {
      counts[type] = list.length;
      list.forEach((rec, i) => {
        const res = checkRecord(type, rec, false, this.limits);
        if (!res.ok) {
          issues.push({ ...res.issue, line: i + 1 });
          return;
        }
        held += res.held;
        const key = `${type}:${String(res.value.publicId)}`;
        if (ids.has(key)) issues.push({ code: "DUPLICATE_ID", message: "A legacy reference maps to a duplicate portable id.", recordType: type });
        ids.add(key);
        for (const [t, id] of referencesOf(type, res.value)) refs.push([t, id, type]);
      });
    }
    for (const [t, id, from] of refs) if (!ids.has(`${t}:${id}`)) issues.push({ code: "REFERENCE_UNRESOLVED", message: `A ${from} record references a ${t} record that is not in the package.`, recordType: from });
    const bytes = [...this.c.objects.values()].reduce((a, b) => a + b.length, 0);
    this.verified = issues.length === 0;
    this.report = {
      ok: this.verified,
      packageId: this.manifest.packageId,
      sourceFormat: this.sourceFormat,
      contractVersion: this.manifest.contract.version,
      manifestSha256: this.manifestSha256,
      ciphertextSha256: this.ciphertextSha256,
      counts,
      objects: { count: this.c.objects.size, bytes },
      issues: issues.slice(0, 100),
      issueCount: issues.length,
      warnings: this.c.warnings,
      losses: this.c.losses,
      heldUnknown: held,
      heldExtensions: [],
    };
    return this.report;
  }

  private assertVerified(): void {
    if (!this.verified) throw new PortableError("NOT_VERIFIED", "The package must pass verification before records or objects are read.");
  }

  async *records<T extends RecordType>(type: T): AsyncGenerator<RecordOf<T>> {
    this.assertVerified();
    for (const r of this.c.records.get(type) ?? []) yield structuredClone(r) as RecordOf<T>;
  }

  async *allRecords(): AsyncGenerator<RecordEnvelope> {
    this.assertVerified();
    for (const type of RECORD_TYPE_ORDER) {
      let line = 0;
      for (const r of this.c.records.get(type) ?? []) yield { type, record: structuredClone(r), line: ++line };
    }
  }

  listObjects(): ReadonlyArray<{ sha256: string; size: number }> {
    return this.manifest.objects.map((o) => ({ ...o }));
  }

  async openObject(sha256: string): Promise<Readable> {
    this.assertVerified();
    const b = this.c.objects.get(sha256);
    if (!b) throw new PortableError("OBJECT_MISSING", "The object is not in the package.");
    return Readable.from([b]).pipe(new Transform({ transform: (c: Buffer, _e, cb) => cb(null, c) }));
  }

  heldExtension(): AsyncIterable<string> {
    this.assertVerified();
    return { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true as const, value: undefined }) }) };
  }

  async close(): Promise<void> {
    this.c.objects.clear();
    this.c.records.clear();
  }
}
