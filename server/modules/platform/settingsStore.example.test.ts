import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { createTestDeps, silentLogger, withTestRequest, fakePrincipal, type TestHarness } from "../../../tests/helpers/fakes.js";
import { DomainError } from "../../core/errors.js";
import { platformSettings } from "./schema.js";
import { defineFeatureFlag, defineSecret, defineSetting, isFlagEnabled, readSecret, readSetting } from "./settingsRegistry.js";
import { createSettingsStore, SETTINGS_CACHE_TTL_MS, type PlatformSettingsStore } from "./settingsStore.js";
import { createFieldCrypto } from "../../security/fieldCrypto.js";
import { eq } from "drizzle-orm";

const MODE = defineSetting({
  key: "general.test_store_mode",
  owner: "platform",
  group: "general",
  label: "Test mode",
  description: "Synthetic setting for tests.",
  schema: z.enum(["alpha", "beta", "gamma"]),
  default: "alpha",
});
const NOTE = defineSetting({
  key: "general.test_store_note",
  owner: "platform",
  group: "general",
  label: "Test note",
  description: "Free text: never echoed into audit.",
  schema: z.string().max(200),
  default: "",
});
const TOKEN = defineSecret({ key: "integrations.test_store_token", owner: "platform", group: "integrations", label: "Test token", description: "Synthetic secret." });
const FLAG = defineFeatureFlag({ flag: "test_store.beta", owner: "platform", label: "Test beta", description: "Synthetic flag." });

let t: TestDb;
let h: TestHarness;
let store: PlatformSettingsStore;

beforeAll(async () => {
  t = await createTestDb({ schema: { platformSettings } });
});
afterAll(() => t.cleanup());
beforeEach(async () => {
  await t.db.delete(platformSettings);
  h = createTestDeps({ db: t.db });
  store = createSettingsStore({ db: t.db, clock: h.clock, logger: silentLogger, crypto: h.deps.crypto, audit: h.audit });
});

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return (error as DomainError).reasonCode;
  }
  throw new Error("expected DomainError");
}

describe("SettingsStore", () => {
  it("returns declared defaults, and feature flags default OFF", async () => {
    expect(await readSetting(store, MODE)).toBe("alpha");
    expect(await isFlagEnabled(store, FLAG)).toBe(false);
    expect(await store.isFeatureEnabled("never.declared")).toBe(false);
    expect(await readSecret(store, TOKEN)).toBeNull();
  });

  it("validates writes against the declared schema and refuses undeclared keys", async () => {
    expect(await reasonOf(store.update(MODE.key, "delta"))).toBe("INVALID_SETTING_VALUE");
    expect(await reasonOf(store.update("general.undeclared_key", "x"))).toBe("UNKNOWN_SETTING");
    expect(await reasonOf(store.update(TOKEN.key, "x"))).toBe("SETTING_KIND_MISMATCH");
    expect(await reasonOf(store.updateSecret(MODE.key, "x"))).toBe("SETTING_KIND_MISMATCH");
    expect(await reasonOf(store.setFeature("never.declared", true))).toBe("UNKNOWN_SETTING");
    expect(await t.db.select().from(platformSettings)).toHaveLength(0);
    expect(h.audit.events).toHaveLength(0);
  });

  it("writes, versions and audits inside the transaction", async () => {
    const principal = fakePrincipal({ role: "admin" });
    const v1 = await withTestRequest(() => store.update(MODE.key, "beta", { expectedVersion: 0 }), principal);
    expect(v1).toBe(1);
    expect(await readSetting(store, MODE)).toBe("beta");
    const [row] = await t.db.select().from(platformSettings).where(eq(platformSettings.settingKey, MODE.key));
    expect(row?.updatedByUserId).toBe(principal.userId);
    expect(h.audit.events).toEqual([
      expect.objectContaining({
        eventName: "platform.setting.changed",
        attributes: { setting_key: MODE.key, version: 1, old_value: null, new_value: "beta" },
      }),
    ]);
    expect(h.audit.recordedInTx).toEqual([true]);
  });

  it("never copies free-text values into audit", async () => {
    await store.update(NOTE.key, "Call Jane at jane@example.test");
    const event = h.audit.named("platform.setting.changed")[0]!;
    expect(JSON.stringify(event)).not.toContain("jane");
    expect(event.attributes).toEqual({ setting_key: NOTE.key, version: 1, value_changed: true });
  });

  it("enforces optimistic concurrency", async () => {
    await store.update(MODE.key, "beta", { expectedVersion: 0 });
    expect(await reasonOf(store.update(MODE.key, "gamma", { expectedVersion: 0 }))).toBe("VERSION_MISMATCH");
    expect(await store.update(MODE.key, "gamma", { expectedVersion: 1 })).toBe(2);
    expect(await reasonOf(store.update(MODE.key, "alpha", { expectedVersion: 1 }))).toBe("VERSION_MISMATCH");
  });

  it("serializes concurrent first writers (exactly one wins)", async () => {
    const results = await Promise.allSettled([
      store.update(MODE.key, "beta", { expectedVersion: 0 }),
      store.update(MODE.key, "gamma", { expectedVersion: 0 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(h.audit.events).toHaveLength(1);
  });

  it("does not write when the audit store is unavailable (fail closed)", async () => {
    h.audit.failRecords = true;
    await expect(store.update(MODE.key, "beta")).rejects.toThrow();
    await expect(store.updateSecret(TOKEN.key, "tok-synthetic")).rejects.toThrow();
    await expect(store.setFeature(FLAG.flag, true)).rejects.toThrow();
    expect(await t.db.select().from(platformSettings)).toHaveLength(0);
    expect(await readSetting(store, MODE)).toBe("alpha");
  });

  it("encrypts secrets at rest, binds them to the key, and never describes them", async () => {
    await store.updateSecret(TOKEN.key, "tok-synthetic-123");
    const [row] = await t.db.select().from(platformSettings).where(eq(platformSettings.settingKey, TOKEN.key));
    expect(row?.secretEnc).toMatch(/^rpenc:v1:/);
    expect(JSON.stringify(row)).not.toContain("tok-synthetic");
    expect(await readSecret(store, TOKEN)).toBe("tok-synthetic-123");
    const views = await store.describe();
    expect(JSON.stringify(views)).not.toContain("tok-synthetic");
    expect(views.find((v) => v.key === TOKEN.key)).toMatchObject({ configured: true, kind: "secret" });
    expect(views.find((v) => v.key === TOKEN.key)).not.toHaveProperty("value");
    expect(h.audit.named("platform.secret.changed")[0]?.attributes).toEqual({ setting_key: TOKEN.key, configured: true, version: 1 });
    expect(JSON.stringify(h.audit.events)).not.toContain("tok-synthetic");
    // get() never returns secrets through the value path
    expect(await store.get(TOKEN.key, (raw) => raw, "fallback")).toBe("fallback");
    // clearing
    await store.updateSecret(TOKEN.key, null);
    expect(await readSecret(store, TOKEN)).toBeNull();
  });

  it("fails closed with a safe error when a secret cannot be decrypted (moved row or lost key)", async () => {
    await store.updateSecret(TOKEN.key, "tok-synthetic-123");
    // Different keyring ⇒ UNKNOWN_KEY
    const other = createFieldCrypto({
      ...h.config,
      dataKeyring: { current: "zz", keys: { zz: Buffer.alloc(32, 9).map((b, i) => (b * 7 + i * 13) % 256).toString("base64") } },
    });
    const otherStore = createSettingsStore({ db: t.db, clock: h.clock, logger: silentLogger, crypto: other, audit: h.audit });
    const err = await otherStore.getSecret(TOKEN.key).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).reasonCode).toBe("SECRET_UNREADABLE");
    expect(String((err as DomainError).safeMessage)).not.toContain("tok");
    // Copying a secret envelope under another key ⇒ AAD mismatch
    const [row] = await t.db.select().from(platformSettings).where(eq(platformSettings.settingKey, TOKEN.key));
    await t.db.update(platformSettings).set({ secretEnc: row!.secretEnc }).where(eq(platformSettings.settingKey, TOKEN.key));
    const moved = defineSecret({ key: "integrations.test_store_token2", owner: "platform", group: "integrations", label: "Moved", description: "x" });
    await t.db.insert(platformSettings).values({ settingKey: moved.key, kind: "secret", secretEnc: row!.secretEnc, version: 1, createdAt: h.clock.now(), updatedAt: h.clock.now() });
    expect(await reasonOf(store.getSecret(moved.key))).toBe("SECRET_UNREADABLE");
  });

  it("falls back to the default when a stored value no longer validates", async () => {
    await t.db.insert(platformSettings).values({ settingKey: MODE.key, kind: "value", valueJson: "omega", version: 1, createdAt: h.clock.now(), updatedAt: h.clock.now() });
    expect(await readSetting(store, MODE)).toBe("alpha");
    expect((await store.describeOne(MODE.key)).invalidStored).toBe(true);
  });

  it("toggles flags with audit at WARN severity", async () => {
    await store.setFeature(FLAG.flag, true, { expectedVersion: 0 });
    expect(await isFlagEnabled(store, FLAG)).toBe(true);
    expect(h.audit.named("platform.feature.changed")[0]).toMatchObject({ severity: "WARN", attributes: { old_value: null, new_value: true } });
  });

  it("caches reads for the TTL, invalidates on local writes, and reads in a caller transaction", async () => {
    const other = createSettingsStore({ db: t.db, clock: h.clock, logger: silentLogger, crypto: h.deps.crypto, audit: h.audit });
    expect(await readSetting(other, MODE)).toBe("alpha"); // primes other's cache
    await store.update(MODE.key, "beta");
    expect(await readSetting(store, MODE)).toBe("beta"); // local write invalidated
    expect(await readSetting(other, MODE)).toBe("alpha"); // stale within TTL
    await t.db.transaction(async (tx) => {
      expect(await readSetting(other, MODE, tx)).toBe("beta"); // tx read bypasses cache
    });
    h.clock.advance(SETTINGS_CACHE_TTL_MS + 1);
    expect(await readSetting(other, MODE)).toBe("beta");
    other.invalidate();
  });
});
