import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { createTestDeps, silentLogger, type TestHarness } from "../../../tests/helpers/fakes.js";
import { DomainError, forbidden } from "../../core/errors.js";
import { createConfigTransfer, type ConfigTransfer } from "./configTransfer.js";
import { platformSettings } from "./schema.js";
import { defineSecret, defineSetting, readSecret, readSetting } from "./settingsRegistry.js";
import { createSettingsStore, type PlatformSettingsStore } from "./settingsStore.js";

const COLOR = defineSetting({
  key: "general.test_transfer_color",
  owner: "platform",
  group: "general",
  label: "Color",
  description: "Synthetic.",
  schema: z.enum(["red", "green", "blue"]),
  default: "red",
});
const LOCAL = defineSetting({
  key: "general.test_transfer_local",
  owner: "platform",
  group: "general",
  label: "Local only",
  description: "Synthetic, not exportable.",
  schema: z.number().int(),
  default: 1,
  exportable: false,
});
const API_KEY = defineSecret({ key: "integrations.test_transfer_key", owner: "platform", group: "integrations", label: "Key", description: "Synthetic.", exportable: true });
const DEFAULT_SECRET = defineSecret({ key: "integrations.test_transfer_default", owner: "platform", group: "integrations", label: "Default", description: "Not opted in." });

const PASS = "correct horse battery staple";
const allow = async () => undefined;

let t: TestDb;
let h: TestHarness;
let store: PlatformSettingsStore;
let transfer: ConfigTransfer;

beforeAll(async () => {
  t = await createTestDb({ schema: { platformSettings } });
});
afterAll(() => t.cleanup());
beforeEach(async () => {
  await t.db.delete(platformSettings);
  h = createTestDeps({ db: t.db });
  store = createSettingsStore({ db: t.db, clock: h.clock, logger: silentLogger, crypto: h.deps.crypto, audit: h.audit });
  transfer = createConfigTransfer({ db: t.db, clock: h.clock, audit: h.audit, settings: store, installationId: "test-install", releaseRef: "test" });
  await store.update(COLOR.key, "green");
  await store.update(LOCAL.key, 5);
  await store.updateSecret(API_KEY.key, "sk-synthetic-123");
  await store.updateSecret(DEFAULT_SECRET.key, "default-synthetic-456");
  h.audit.clear();
});

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(DomainError);
  return (error as DomainError).reasonCode;
}

describe("config export/import", () => {
  it("defineSecret is not exportable unless explicitly opted in", () => {
    expect(DEFAULT_SECRET.exportable).toBe(false);
    expect(API_KEY.exportable).toBe(true);
  });

  it("exports without secrets by default and never leaks secret values", async () => {
    const { document, counts } = await transfer.exportDocument({ includeSecrets: false }, allow);
    expect(counts.secrets).toBe(0);
    expect(document).not.toContain("sk-synthetic");
    expect(document).not.toContain(LOCAL.key);
    const doc = JSON.parse(document);
    expect(doc).toMatchObject({ format: "readypackets.platform-config", formatVersion: 1, secrets: null, integrity: { alg: "sha256" } });
    expect(h.audit.named("platform.config.exported")[0]).toMatchObject({ attributes: { secrets_included: false } });
    expect(h.audit.recordedInTx.at(-1)).toBe(true);
  });

  it("encrypts opted-in secrets with the passphrase and round-trips them", async () => {
    const { document, counts } = await transfer.exportDocument({ includeSecrets: true, passphrase: PASS }, allow);
    expect(counts.secrets).toBe(1);
    expect(document).not.toContain("sk-synthetic");
    expect(document).not.toContain("default-synthetic");
    await store.update(COLOR.key, "blue");
    await store.updateSecret(API_KEY.key, "sk-other");
    const preview = await transfer.preview(document, PASS);
    expect(preview).toMatchObject({ integrity: "authenticated", secretsIncluded: true, counts: { modify: 2, rejected: 0 } });
    await transfer.apply(document, preview.digest, allow, PASS);
    expect(await readSetting(store, COLOR)).toBe("green");
    expect(await readSecret(store, API_KEY)).toBe("sk-synthetic-123");
    expect(h.audit.named("platform.config.imported")).toHaveLength(1);
  });

  it("refuses weak passphrases, wrong passphrases and tampered documents", async () => {
    expect(await reasonOf(transfer.exportDocument({ includeSecrets: true, passphrase: "short" }, allow))).toBe("WEAK_PASSPHRASE");
    const { document } = await transfer.exportDocument({ includeSecrets: true, passphrase: PASS }, allow);
    expect(await reasonOf(transfer.preview(document, "the wrong passphrase!!"))).toBe("INTEGRITY_MISMATCH");
    const tampered = document.replace('"green"', '"blue"');
    expect(await reasonOf(transfer.preview(tampered, PASS))).toBe("INTEGRITY_MISMATCH");
    const plain = (await transfer.exportDocument({ includeSecrets: false }, allow)).document;
    expect(await reasonOf(transfer.preview(plain.replace('"green"', '"blue"')))).toBe("INTEGRITY_MISMATCH");
    expect(await reasonOf(transfer.preview("{not json"))).toBe("DOCUMENT_MALFORMED");
    expect(await reasonOf(transfer.preview(JSON.stringify({ ...JSON.parse(plain), extra: 1 })))).toBe("DOCUMENT_MALFORMED");
  });

  it("refuses a stale preview digest and changes nothing", async () => {
    const { document } = await transfer.exportDocument({ includeSecrets: false }, allow);
    await store.update(COLOR.key, "blue");
    const preview = await transfer.preview(document);
    await store.update(COLOR.key, "red"); // concurrent change after preview
    expect(await reasonOf(transfer.apply(document, preview.digest, allow))).toBe("PREVIEW_STALE");
    expect(await readSetting(store, COLOR)).toBe("red");
    expect(h.audit.named("platform.config.import.refused")).toHaveLength(1);
  });

  it("re-validates the actor before reading secrets and before the export audit; refused import writes nothing", async () => {
    let calls = 0;
    const revokedSecondTime = async () => {
      calls += 1;
      if (calls > 1) throw forbidden("ROLE_NOT_PERMITTED");
    };
    expect(await reasonOf(transfer.exportDocument({ includeSecrets: true, passphrase: PASS }, revokedSecondTime))).toBe("ROLE_NOT_PERMITTED");
    expect(calls).toBe(2);
    expect(h.audit.named("platform.config.exported")).toHaveLength(0);

    const { document } = await transfer.exportDocument({ includeSecrets: false }, allow);
    await store.update(COLOR.key, "blue");
    const preview = await transfer.preview(document);
    expect(await reasonOf(transfer.apply(document, preview.digest, async () => Promise.reject(forbidden("ROLE_NOT_PERMITTED"))))).toBe("ROLE_NOT_PERMITTED");
    expect(await readSetting(store, COLOR)).toBe("blue");
    expect(h.audit.named("platform.config.imported")).toHaveLength(0);
  });

  it("rolls back the whole import when the audit store fails", async () => {
    const { document } = await transfer.exportDocument({ includeSecrets: true, passphrase: PASS }, allow);
    await store.update(COLOR.key, "blue");
    await store.updateSecret(API_KEY.key, "sk-other");
    const preview = await transfer.preview(document, PASS);
    h.audit.failRecords = true;
    await expect(transfer.apply(document, preview.digest, allow, PASS)).rejects.toThrow();
    h.audit.failRecords = false;
    expect(await readSetting(store, COLOR)).toBe("blue");
    expect(await readSecret(store, API_KEY)).toBe("sk-other");
  });

  it("rejects non-exportable and undeclared keys in an imported document", async () => {
    const { document } = await transfer.exportDocument({ includeSecrets: false }, allow);
    const doc = JSON.parse(document);
    doc.settings.push({ key: LOCAL.key, value: 9 }, { key: "general.no_such_key", value: 1 });
    const { integrity: _ignored, ...body } = doc;
    const { canonicalJson } = await import("./configTransfer.js");
    const { createHash } = await import("node:crypto");
    doc.integrity = { alg: "sha256", salt: null, value: createHash("sha256").update(canonicalJson(body)).digest("hex") };
    const preview = await transfer.preview(JSON.stringify(doc));
    expect(preview.rejected).toEqual(
      expect.arrayContaining([
        { key: LOCAL.key, reason: "NOT_EXPORTABLE" },
        { key: "(undeclared)", reason: "UNKNOWN_SETTING" },
      ]),
    );
    expect(await reasonOf(transfer.apply(JSON.stringify(doc), preview.digest, allow))).toBe("IMPORT_HAS_REJECTIONS");
  });
});
