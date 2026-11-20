/**
 * Configuration export / import. Owner: platform engineer.
 *
 * Format `readypackets.platform-config` v1 — strict JSON DATA, never executed or sourced.
 *  - Non-secret exportable settings are included in clear.
 *  - Secrets are EXCLUDED unless the operator asks for them AND supplies a passphrase; they are then
 *    encrypted with AES-256-GCM under a key derived by scrypt (N=2^15, r=8, p=1) from the passphrase.
 *  - Integrity: with a passphrase, HMAC-SHA-256 under a second scrypt-derived subkey (authenticity against
 *    anyone without the passphrase). Without a passphrase, SHA-256 of the canonical body detects
 *    corruption only — it does not prove who produced the file.
 *  - Import is two-phase: preview (dry-run diff + digest bound to the document AND the current setting
 *    versions) then apply with that digest; any concurrent change or invalid value refuses the whole import.
 */
import type { ActorGuard } from "./actorGuard.js";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { DomainError, validation } from "../../core/errors.js";
import type { AuditEmitter, Clock, Db, Tx } from "../../core/types.js";
import type { PlatformSettingsStore } from "./settingsStore.js";
import { getSettingDefinition, listSettingDefinitions } from "./settingsRegistry.js";

export const CONFIG_FORMAT = "readypackets.platform-config";
export const CONFIG_FORMAT_VERSION = 1;
export const MAX_CONFIG_DOCUMENT_BYTES = 512 * 1024;
export const MIN_PASSPHRASE_LENGTH = 16;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1 } as const;
const B64URL = /^[A-Za-z0-9_-]+$/;

const settingEntry = z.strictObject({ key: z.string().min(3).max(96), value: z.json() });

const documentSchema = z.strictObject({
  format: z.literal(CONFIG_FORMAT),
  formatVersion: z.literal(CONFIG_FORMAT_VERSION),
  exportedAt: z.iso.datetime(),
  source: z.strictObject({
    installationId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/),
    releaseRef: z.string().regex(/^[A-Za-z0-9._+-]{1,80}$/),
  }),
  settings: z.array(settingEntry).max(1000),
  secrets: z
    .strictObject({
      kdf: z.strictObject({
        name: z.literal("scrypt"),
        N: z.literal(SCRYPT.N),
        r: z.literal(SCRYPT.r),
        p: z.literal(SCRYPT.p),
        salt: z.string().regex(B64URL).length(22),
      }),
      cipher: z.literal("aes-256-gcm"),
      iv: z.string().regex(B64URL).length(16),
      ciphertext: z.string().regex(B64URL).max(MAX_CONFIG_DOCUMENT_BYTES),
      tag: z.string().regex(B64URL).length(22),
    })
    .nullable(),
  integrity: z.strictObject({
    alg: z.enum(["hmac-sha256", "sha256"]),
    /** Present for hmac-sha256: salt used to derive the MAC key. */
    salt: z.string().regex(B64URL).length(22).nullable(),
    value: z.string().regex(/^[0-9a-f]{64}$/),
  }),
});
export type ConfigDocument = z.infer<typeof documentSchema>;

const secretPayloadSchema = z.array(z.strictObject({ key: z.string().min(3).max(96), value: z.string().min(1).max(16384) })).max(200);

/** Deterministic JSON (sorted object keys) for MAC / digest computation. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

function deriveKeys(passphrase: string, salt: Buffer): { encKey: Buffer; macKey: Buffer } {
  const material = scryptSync(passphrase.normalize("NFC"), salt, 64, { ...SCRYPT, maxmem: 64 * 1024 * 1024 });
  return { encKey: material.subarray(0, 32), macKey: material.subarray(32, 64) };
}

function assertPassphrase(passphrase: string | undefined): asserts passphrase is string {
  if (!passphrase || [...passphrase.normalize("NFC")].length < MIN_PASSPHRASE_LENGTH || passphrase.length > 1024) {
    throw validation("WEAK_PASSPHRASE", `The passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  }
}

type Body = Omit<ConfigDocument, "integrity">;

function integrityFor(body: Body, macKey: Buffer | null, salt: string | null): ConfigDocument["integrity"] {
  const canonical = canonicalJson(body);
  if (macKey) return { alg: "hmac-sha256", salt, value: createHmac("sha256", macKey).update(canonical).digest("hex") };
  return { alg: "sha256", salt: null, value: createHash("sha256").update(canonical).digest("hex") };
}

export interface ConfigTransferDeps {
  db: Db;
  clock: Clock;
  audit: AuditEmitter;
  settings: PlatformSettingsStore;
  installationId: string;
  releaseRef: string;
  /** Cross-record validation run under the setting's row lock (e.g. slides reference existing images). */
  afterLock?: (key: string, value: unknown, tx: Tx) => Promise<void>;
}

export interface ImportChange {
  key: string;
  kind: "value" | "secret" | "flag";
  change: "add" | "modify" | "unchanged" | "clear";
}
export interface ImportRejection {
  key: string;
  reason: "UNKNOWN_SETTING" | "NOT_EXPORTABLE" | "INVALID_VALUE" | "DUPLICATE";
}
export interface ImportPreview {
  digest: string;
  changes: ImportChange[];
  rejected: ImportRejection[];
  secretsIncluded: boolean;
  integrity: "authenticated" | "checksum-only";
  counts: { add: number; modify: number; unchanged: number; rejected: number };
}

export function createConfigTransfer(deps: ConfigTransferDeps) {
  const { settings, audit, clock, db } = deps;

  async function exportDocument(options: { includeSecrets: boolean; passphrase?: string }): Promise<{ document: string; counts: { settings: number; secrets: number } }> {
    if (options.includeSecrets || options.passphrase !== undefined) assertPassphrase(options.passphrase);
    const defs = listSettingDefinitions().filter((def) => def.exportable);
    const entries: { key: string; value: z.core.util.JSONType }[] = [];
    const secretValues: { key: string; value: string }[] = [];
    for (const def of defs) {
      if (def.kind === "secret") {
        if (!options.includeSecrets) continue;
        const value = await settings.getSecret(def.key);
        if (value !== null) secretValues.push({ key: def.key, value });
      } else {
        const value = await settings.storedValue(def.key);
        if (value !== undefined) entries.push({ key: def.key, value: value as z.core.util.JSONType });
      }
    }
    const salt = options.passphrase ? randomBytes(16) : null;
    const keys = options.passphrase && salt ? deriveKeys(options.passphrase, salt) : null;
    const header = {
      format: CONFIG_FORMAT,
      formatVersion: CONFIG_FORMAT_VERSION,
      exportedAt: clock.now().toISOString(),
      source: { installationId: deps.installationId, releaseRef: deps.releaseRef },
    } as const;
    let secrets: ConfigDocument["secrets"] = null;
    if (options.includeSecrets && keys) {
      const secretSalt = randomBytes(16);
      const secretKeys = deriveKeys(options.passphrase!, secretSalt);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", secretKeys.encKey, iv);
      cipher.setAAD(Buffer.from(canonicalJson(header)));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secretValues), "utf8"), cipher.final()]);
      secrets = {
        kdf: { name: "scrypt", N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: secretSalt.toString("base64url") },
        cipher: "aes-256-gcm",
        iv: iv.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
      };
      secretKeys.encKey.fill(0);
    }
    const body: Body = { ...header, settings: entries, secrets };
    const document: ConfigDocument = { ...body, integrity: integrityFor(body, keys?.macKey ?? null, salt?.toString("base64url") ?? null) };
    keys?.encKey.fill(0);
    keys?.macKey.fill(0);
    await audit.record({
      category: "admin",
      eventName: "platform.config.exported",
      action: "export",
      outcome: "completed",
      severity: options.includeSecrets ? "WARN" : "INFO",
      resource: { type: "platform_config" },
      safeCounts: { settings: entries.length, secrets: secretValues.length },
      attributes: { secrets_included: options.includeSecrets, integrity: document.integrity.alg },
    });
    return { document: JSON.stringify(document, null, 2), counts: { settings: entries.length, secrets: secretValues.length } };
  }

  function parse(raw: string, passphrase: string | undefined): { doc: ConfigDocument; secrets: { key: string; value: string }[]; integrity: ImportPreview["integrity"] } {
    if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_CONFIG_DOCUMENT_BYTES) {
      throw validation("DOCUMENT_TOO_LARGE", "The configuration file is too large.");
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw validation("DOCUMENT_MALFORMED", "The configuration file is not valid JSON.");
    }
    const parsed = documentSchema.safeParse(json);
    if (!parsed.success) throw validation("DOCUMENT_MALFORMED", "The configuration file does not match the expected format.");
    const doc = parsed.data;
    const { integrity, ...body } = doc;
    let macKey: Buffer | null = null;
    if (integrity.alg === "hmac-sha256") {
      assertPassphrase(passphrase);
      if (!integrity.salt) throw validation("DOCUMENT_MALFORMED", "The configuration file does not match the expected format.");
      macKey = deriveKeys(passphrase, Buffer.from(integrity.salt, "base64url")).macKey;
    } else if (doc.secrets) {
      throw validation("DOCUMENT_MALFORMED", "Encrypted secrets require an authenticated configuration file.");
    }
    const expected = Buffer.from(integrityFor(body, macKey, integrity.salt).value, "hex");
    macKey?.fill(0);
    if (!timingSafeEqual(expected, Buffer.from(integrity.value, "hex"))) {
      throw validation("INTEGRITY_MISMATCH", "The configuration file failed its integrity check (wrong passphrase or modified file).");
    }
    let secrets: { key: string; value: string }[] = [];
    if (doc.secrets) {
      const keys = deriveKeys(passphrase!, Buffer.from(doc.secrets.kdf.salt, "base64url"));
      try {
        const decipher = createDecipheriv("aes-256-gcm", keys.encKey, Buffer.from(doc.secrets.iv, "base64url"));
        decipher.setAAD(Buffer.from(canonicalJson({ format: doc.format, formatVersion: doc.formatVersion, exportedAt: doc.exportedAt, source: doc.source })));
        decipher.setAuthTag(Buffer.from(doc.secrets.tag, "base64url"));
        const plain = Buffer.concat([decipher.update(Buffer.from(doc.secrets.ciphertext, "base64url")), decipher.final()]).toString("utf8");
        secrets = secretPayloadSchema.parse(JSON.parse(plain));
      } catch {
        throw validation("INTEGRITY_MISMATCH", "The configuration file failed its integrity check (wrong passphrase or modified file).");
      } finally {
        keys.encKey.fill(0);
        keys.macKey.fill(0);
      }
    }
    return { doc, secrets, integrity: integrity.alg === "hmac-sha256" ? "authenticated" : "checksum-only" };
  }

  interface Plan {
    preview: ImportPreview;
    values: { key: string; value: unknown; version: number }[];
    secretWrites: { key: string; value: string; version: number }[];
  }

  async function plan(raw: string, passphrase: string | undefined): Promise<Plan> {
    const { doc, secrets, integrity } = parse(raw, passphrase);
    const changes: ImportChange[] = [];
    const rejected: ImportRejection[] = [];
    const values: Plan["values"] = [];
    const secretWrites: Plan["secretWrites"] = [];
    const seen = new Set<string>();
    const versions: Record<string, number> = {};
    for (const entry of doc.settings) {
      const def = getSettingDefinition(entry.key);
      if (seen.has(entry.key)) {
        rejected.push({ key: entry.key, reason: "DUPLICATE" });
        continue;
      }
      seen.add(entry.key);
      if (!def || def.kind === "secret") {
        rejected.push({ key: def ? entry.key : "(undeclared)", reason: "UNKNOWN_SETTING" });
        continue;
      }
      if (!def.exportable) {
        rejected.push({ key: entry.key, reason: "NOT_EXPORTABLE" });
        continue;
      }
      const parsed = def.schema.safeParse(entry.value);
      if (!parsed.success) {
        rejected.push({ key: entry.key, reason: "INVALID_VALUE" });
        continue;
      }
      const view = await settings.describeOne(def.key);
      versions[def.key] = view.version;
      const current = await settings.storedValue(def.key);
      const same = current !== undefined && canonicalJson(current) === canonicalJson(parsed.data);
      changes.push({ key: def.key, kind: def.kind, change: same ? "unchanged" : current === undefined ? "add" : "modify" });
      if (!same) values.push({ key: def.key, value: parsed.data, version: view.version });
    }
    for (const entry of secrets) {
      const def = getSettingDefinition(entry.key);
      if (seen.has(entry.key)) {
        rejected.push({ key: entry.key, reason: "DUPLICATE" });
        continue;
      }
      seen.add(entry.key);
      if (!def || def.kind !== "secret") {
        rejected.push({ key: def ? entry.key : "(undeclared)", reason: "UNKNOWN_SETTING" });
        continue;
      }
      if (!def.exportable) {
        rejected.push({ key: entry.key, reason: "NOT_EXPORTABLE" });
        continue;
      }
      if (!def.schema.safeParse(entry.value).success) {
        rejected.push({ key: entry.key, reason: "INVALID_VALUE" });
        continue;
      }
      const view = await settings.describeOne(def.key);
      versions[def.key] = view.version;
      // Secret values are never compared against the current secret in a way that leaks; always rewritten.
      changes.push({ key: def.key, kind: "secret", change: view.configured ? "modify" : "add" });
      secretWrites.push({ key: def.key, value: entry.value, version: view.version });
    }
    const digest = createHash("sha256")
      .update(canonicalJson({ integrity: doc.integrity.value, versions }))
      .digest("hex");
    const count = (c: ImportChange["change"]) => changes.filter((x) => x.change === c).length;
    return {
      preview: {
        digest,
        changes,
        rejected,
        secretsIncluded: doc.secrets !== null,
        integrity,
        counts: { add: count("add"), modify: count("modify"), unchanged: count("unchanged"), rejected: rejected.length },
      },
      values,
      secretWrites,
    };
  }

  async function preview(raw: string, passphrase?: string): Promise<ImportPreview> {
    try {
      const result = await plan(raw, passphrase);
      await audit.record({
        category: "admin",
        eventName: "platform.config.import.previewed",
        action: "import",
        outcome: "completed",
        resource: { type: "platform_config" },
        safeCounts: { ...result.preview.counts },
        attributes: { integrity: result.preview.integrity, secrets_included: result.preview.secretsIncluded },
      });
      return result.preview;
    } catch (error) {
      await recordRefusal(error);
      throw error;
    }
  }

  async function recordRefusal(error: unknown): Promise<void> {
    if (!(error instanceof DomainError) || error.code === "AUDIT_UNAVAILABLE") return;
    await audit.record({
      category: "admin",
      eventName: "platform.config.import.refused",
      action: "import",
      outcome: "refused",
      severity: "WARN",
      reasonCode: error.reasonCode,
      resource: { type: "platform_config" },
    });
  }

  async function apply(raw: string, expectedDigest: string, guard: ActorGuard, passphrase?: string): Promise<ImportPreview> {
    try {
      const result = await plan(raw, passphrase);
      if (result.preview.digest !== expectedDigest) {
        throw new DomainError("CONFLICT", "PREVIEW_STALE", "Settings changed since the preview. Preview the import again.");
      }
      if (result.preview.rejected.length > 0) {
        throw validation("IMPORT_HAS_REJECTIONS", "The file contains settings that cannot be imported. Nothing was changed.");
      }
      // Deterministic lock order: actor (users → sessions) first, then settings rows by key.
      const values = [...result.values].sort((a, b) => (a.key < b.key ? -1 : 1));
      const secrets = [...result.secretWrites].sort((a, b) => (a.key < b.key ? -1 : 1));
      await db.transaction(async (tx: Tx) => {
        await guard(tx);
        for (const item of values) {
          const check = deps.afterLock;
          await settings.update(item.key, item.value, { expectedVersion: item.version, tx, ...(check ? { afterLock: (t: Tx) => check(item.key, item.value, t) } : {}) });
        }
        for (const item of secrets) await settings.updateSecret(item.key, item.value, { expectedVersion: item.version, tx });
        await audit.record(
          {
            category: "admin",
            eventName: "platform.config.imported",
            action: "import",
            outcome: "completed",
            severity: "WARN",
            resource: { type: "platform_config" },
            safeCounts: { settings: result.values.length, secrets: result.secretWrites.length },
            attributes: { integrity: result.preview.integrity },
          },
          tx,
        );
      });
      settings.invalidate();
      return result.preview;
    } catch (error) {
      settings.invalidate();
      await recordRefusal(error).catch(() => undefined);
      throw error;
    }
  }

  return { exportDocument, preview, apply };
}
export type ConfigTransfer = ReturnType<typeof createConfigTransfer>;
