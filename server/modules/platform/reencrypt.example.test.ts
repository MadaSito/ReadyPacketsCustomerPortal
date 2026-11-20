import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { FakeAudit, silentLogger } from "../../../tests/helpers/fakes.js";
import { FakeClock } from "../../core/clock.js";
import { createFieldCrypto } from "../../security/fieldCrypto.js";
import { createReencryptor, type ReencryptTarget } from "./reencrypt.js";
import { platformReencryptCheckpoints, platformSettings } from "./schema.js";
import { defineSecret, readSecret } from "./settingsRegistry.js";
import { createSettingsStore } from "./settingsStore.js";

const SECRETS = Array.from({ length: 5 }, (_, i) =>
  defineSecret({ key: `integrations.test_reencrypt_${i}`, owner: "platform", group: "integrations", label: `R${i}`, description: "Synthetic." }),
);
const key = () => randomBytes(32).toString("base64");
const K1 = key();
const K2 = key();
const base = { indexKey: key(), pseudonymKey: key(), tokenHashKey: key() };
const oldCrypto = createFieldCrypto({ ...base, dataKeyring: { current: "k1", keys: { k1: K1 } } });
const newCrypto = createFieldCrypto({ ...base, dataKeyring: { current: "k2", keys: { k1: K1, k2: K2 } } });

/** The platform_settings secret column: AAD `platform_settings.secret:<setting_key>`. */
const target: ReencryptTarget = {
  name: "platform_settings.secret_enc",
  table: platformSettings,
  idColumn: platformSettings.id,
  envelopeColumn: platformSettings.secretEnc,
  aadColumns: { settingKey: platformSettings.settingKey },
  aadFor: (row) => `platform_settings.secret:${String(row.settingKey)}`,
};

let t: TestDb;
const clock = new FakeClock(new Date("2026-11-20T12:00:00.000Z"));

beforeAll(async () => {
  t = await createTestDb({ schema: { platformSettings, platformReencryptCheckpoints } });
});
afterAll(() => t.cleanup());
beforeEach(async () => {
  await t.db.delete(platformSettings);
  await t.db.delete(platformReencryptCheckpoints);
  const writer = createSettingsStore({ db: t.db, clock, logger: silentLogger, crypto: oldCrypto, audit: new FakeAudit() });
  for (const [i, def] of SECRETS.entries()) await writer.updateSecret(def.key, `secret-value-${i}`);
});

async function envelopes(): Promise<string[]> {
  const rows = await t.db.select({ e: platformSettings.secretEnc }).from(platformSettings).orderBy(platformSettings.id);
  return rows.map((r) => r.e!);
}

describe("re-encryption helper (platform_settings.secret_enc)", () => {
  it("re-encrypts in checkpointed batches under the current key with the same AAD", async () => {
    const audit = new FakeAudit();
    const tool = createReencryptor({ db: t.db, clock, audit, crypto: newCrypto });
    expect(await tool.remaining(target)).toMatchObject({ remaining: 5 });
    const first = await tool.runBatch(target, 2);
    expect(first).toMatchObject({ rewritten: 2, done: false });
    let result = first;
    while (!result.done) result = await tool.runBatch(target, 2);
    expect(await tool.remaining(target)).toMatchObject({ remaining: 0 });
    for (const envelope of await envelopes()) expect(newCrypto.keyIdOf(envelope)).toBe("k2");
    const reader = createSettingsStore({ db: t.db, clock, logger: silentLogger, crypto: createFieldCrypto({ ...base, dataKeyring: { current: "k2", keys: { k2: K2 } } }), audit });
    expect(await readSecret(reader, SECRETS[3]!)).toBe("secret-value-3");
    expect(audit.named("platform.crypto.reencrypt.batch").length).toBeGreaterThanOrEqual(3);
    expect(audit.recordedInTx.every(Boolean)).toBe(true);
    expect(JSON.stringify(audit.events)).not.toContain("secret-value");
  });

  it("leaves rows and checkpoint unchanged when the audit write fails", async () => {
    const audit = new FakeAudit();
    audit.failRecords = true;
    const tool = createReencryptor({ db: t.db, clock, audit, crypto: newCrypto });
    const before = await envelopes();
    await expect(tool.runBatch(target, 10)).rejects.toThrow();
    expect(await envelopes()).toEqual(before);
    const [checkpoint] = await t.db.select().from(platformReencryptCheckpoints);
    expect(checkpoint).toMatchObject({ lastId: 0, rewritten: 0 });
  });

  it("serializes overlapping runners so the cursor only moves forward", async () => {
    const tool = createReencryptor({ db: t.db, clock, audit: new FakeAudit(), crypto: newCrypto });
    const results = await Promise.all([tool.runBatch(target, 2), tool.runBatch(target, 2)]);
    expect(results.reduce((n, r) => n + r.rewritten, 0)).toBe(4);
    const [checkpoint] = await t.db.select().from(platformReencryptCheckpoints);
    expect(checkpoint?.lastId).toBe(Math.max(...results.map((r) => r.lastId)));
    expect(checkpoint?.rewritten).toBe(4);
  });

  it("counts rows that cannot be decrypted as failed and never rewrites them", async () => {
    const [row] = await t.db.select().from(platformSettings).limit(1);
    await t.db.update(platformSettings).set({ settingKey: "integrations.test_reencrypt_moved" }).where(eq(platformSettings.id, row!.id));
    const tool = createReencryptor({ db: t.db, clock, audit: new FakeAudit(), crypto: newCrypto });
    const result = await tool.runBatch(target, 100);
    expect(result).toMatchObject({ rewritten: 4, failed: 1, done: true });
    const [after] = await t.db.select().from(platformSettings).where(eq(platformSettings.id, row!.id));
    expect(after?.secretEnc).toBe(row!.secretEnc);
  });

  it("compare-and-set never overwrites a concurrent application write", async () => {
    const tool = createReencryptor({ db: t.db, clock, audit: new FakeAudit(), crypto: newCrypto });
    // Simulate an application write between read and CAS by rewriting one row under k2 first.
    const [row] = await t.db.select().from(platformSettings).limit(1);
    const fresh = newCrypto.encrypt("app-wrote-this", `platform_settings.secret:${row!.settingKey}`);
    await t.db.update(platformSettings).set({ secretEnc: fresh }).where(eq(platformSettings.id, row!.id));
    const result = await tool.runBatch(target, 100);
    expect(result).toMatchObject({ rewritten: 4, alreadyCurrent: 1 });
    const [after] = await t.db.select().from(platformSettings).where(eq(platformSettings.id, row!.id));
    expect(after?.secretEnc).toBe(fresh);
  });
});
