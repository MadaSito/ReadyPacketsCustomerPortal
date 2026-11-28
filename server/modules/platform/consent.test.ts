import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { createTestDeps, silentLogger, withTestRequest, type TestHarness } from "../../../tests/helpers/fakes.js";
import { DomainError } from "../../core/errors.js";
import { platformConsentRecords, platformSettings } from "./schema.js";
import { createSettingsStore, type PlatformSettingsStore } from "./settingsStore.js";
import {
  CONSENT_FLAG,
  CONSENT_POLICY_VERSION,
  COOKIE_INVENTORY,
  DEFAULT_COOKIE_INVENTORY,
  RECEIPT_PATTERN,
  assertConsistent,
  constantTimeEqual,
  createConsentService,
  csvCell,
  recordInputSchema,
  searchInputSchema,
} from "./consent.js";
import { listSettingDefinitions, writeSetting } from "./settingsRegistry.js";
import { createPlatformTrashParticipant, PLATFORM_TRASH_MODULE } from "./trash.js";

let t: TestDb;
let h: TestHarness;
let store: PlatformSettingsStore;
let svc: ReturnType<typeof createConsentService>;

const NONE = { preferences: false, analytics: false, session_replay: false };
const ALL = { preferences: true, analytics: true, session_replay: true };
const anon = { userPublicId: null, ipAddress: "203.0.113.9" };

beforeAll(async () => {
  t = await createTestDb({ schema: { platformSettings, platformConsentRecords } });
});
afterAll(() => t.cleanup());
beforeEach(async () => {
  await t.db.delete(platformConsentRecords);
  await t.db.delete(platformSettings);
  h = createTestDeps({ db: t.db });
  store = createSettingsStore({ db: t.db, clock: h.clock, logger: silentLogger, crypto: h.deps.crypto, audit: h.audit });
  svc = createConsentService({ db: t.db, clock: h.clock, crypto: h.deps.crypto, audit: h.audit, settings: store, logger: silentLogger });
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

const enable = () => withTestRequest(() => store.setFeature(CONSENT_FLAG.flag, true, { expectedVersion: 0 }));

describe("consent: pure rules", () => {
  it("rejects inconsistent action/choices and signal-made grants", () => {
    expect(() => assertConsistent({ action: "accept_all", choices: { ...ALL, analytics: false }, source: "banner", gpc: false })).toThrow(DomainError);
    expect(() => assertConsistent({ action: "reject_all", choices: { ...NONE, analytics: true }, source: "banner", gpc: false })).toThrow(DomainError);
    expect(() => assertConsistent({ action: "withdraw", choices: { ...NONE, session_replay: true }, source: "account", gpc: false })).toThrow(DomainError);
    expect(() => assertConsistent({ action: "accept_all", choices: ALL, source: "gpc", gpc: true })).toThrow(DomainError);
    expect(() => assertConsistent({ action: "reject_all", choices: NONE, source: "gpc", gpc: false })).toThrow(DomainError);
    expect(() => assertConsistent({ action: "save", choices: { ...NONE, analytics: true }, source: "preferences", gpc: false })).not.toThrow();
  });

  it("validates inputs strictly", () => {
    const base = { policyVersion: 1, choices: NONE, action: "reject_all", source: "banner", gpc: false };
    expect(recordInputSchema.safeParse(base).success).toBe(true);
    expect(recordInputSchema.safeParse({ ...base, userPublicId: "x" }).success).toBe(false);
    expect(recordInputSchema.safeParse({ ...base, receipt: "x".repeat(65) }).success).toBe(false);
    expect(recordInputSchema.safeParse({ ...base, action: "grant_everything" }).success).toBe(false);
    expect(recordInputSchema.safeParse({ ...base, choices: { ...NONE, necessary: false } }).success).toBe(false);
    expect(searchInputSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(searchInputSchema.safeParse({ consentId: "'; drop table x" }).success).toBe(false);
  });

  it("neutralises CSV formula injection", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(csvCell("+1")).toBe("\"'+1\"");
    expect(csvCell("@a")).toBe("\"'@a\"");
    expect(csvCell("plain")).toBe("\"plain\"");
  });

  it("ships a valid default inventory and compares in constant time", () => {
    expect(COOKIE_INVENTORY.schema.safeParse(DEFAULT_COOKIE_INVENTORY).success).toBe(true);
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});

describe("consent: service", () => {
  it("bootstrap exposes only client-visible flags and fails closed", async () => {
    const b = await svc.bootstrap();
    const visible = listSettingDefinitions().filter((d) => d.kind === "flag" && d.clientVisible).map((d) => (d.kind === "flag" ? d.flag : ""));
    expect(Object.keys(b.features).sort()).toEqual(visible.sort());
    expect(b.features[CONSENT_FLAG.flag]).toBe(false);
    expect(b.consent.enabled).toBe(false);
  });

  it("refuses decisions while the feature is off", async () => {
    expect(await reasonOf(svc.record({ policyVersion: 1, choices: NONE, action: "reject_all", source: "banner", gpc: false }, anon))).toBe("CONSENT_DISABLED");
  });

  it("refuses a stale policy version", async () => {
    await enable();
    await writeSetting(store, CONSENT_POLICY_VERSION, 2);
    expect(await reasonOf(svc.record({ policyVersion: 1, choices: NONE, action: "reject_all", source: "banner", gpc: false }, anon))).toBe("CONSENT_POLICY_CHANGED");
  });

  it("records without the IP in clear and issues a signed receipt", async () => {
    await enable();
    const r = await svc.record({ policyVersion: 1, choices: ALL, action: "accept_all", source: "banner", gpc: false }, anon);
    expect(r.receipt).toMatch(RECEIPT_PATTERN);
    expect(r.receipt.startsWith(`${r.consentId}.`)).toBe(true);
    const rows = await t.db.select().from(platformConsentRecords);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("203.0.113.9");
    expect(rows[0]!.ipIndex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("groups decisions only through a genuine receipt; forged ones start a new id", async () => {
    await enable();
    const first = await svc.record({ policyVersion: 1, choices: ALL, action: "accept_all", source: "banner", gpc: false }, anon);
    const again = await svc.record({ receipt: first.receipt, policyVersion: 1, choices: NONE, action: "withdraw", source: "account", gpc: false }, anon);
    expect(again.consentId).toBe(first.consentId);
    const forged = `${first.consentId}.${"0".repeat(32)}`;
    const other = await svc.record({ receipt: forged, policyVersion: 1, choices: NONE, action: "reject_all", source: "banner", gpc: false }, anon);
    expect(other.consentId).not.toBe(first.consentId);
    const junk = await svc.record({ receipt: "not-a-receipt", policyVersion: 1, choices: NONE, action: "reject_all", source: "banner", gpc: false }, anon);
    expect(junk.consentId).not.toBe(first.consentId);
  });

  it("account history is selected by the signed-in user, never by consent id", async () => {
    await enable();
    const a = await svc.record({ policyVersion: 1, choices: ALL, action: "accept_all", source: "banner", gpc: false }, { userPublicId: "usr_a", ipAddress: null });
    await svc.record({ receipt: a.receipt, policyVersion: 1, choices: NONE, action: "withdraw", source: "account", gpc: false }, { userPublicId: "usr_b", ipAddress: null });
    const mineA = await svc.mine("usr_a");
    const mineB = await svc.mine("usr_b");
    expect(mineA).toHaveLength(1);
    expect(mineB).toHaveLength(1);
    expect(mineB[0]!.action).toBe("withdraw");
  });

  it("search paginates and export is audited", async () => {
    await enable();
    for (let i = 0; i < 3; i += 1) await svc.record({ policyVersion: 1, choices: NONE, action: "reject_all", source: "banner", gpc: i === 0 }, anon);
    const page = await svc.search({ limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    const rest = await svc.search({ limit: 2, cursor: page.nextCursor! });
    expect(rest.items).toHaveLength(1);
    expect((await svc.search({ gpc: true })).items).toHaveLength(1);
    const out = await withTestRequest(() => svc.exportCsv({}));
    expect(out.rows).toBe(3);
    expect(h.audit.named("privacy.consent.exported")).toHaveLength(1);
  });
});

describe("consent: retention", () => {
  it("purges superseded and expired records after the retention period and unlinks erased accounts", async () => {
    await enable();
    const month = 30.4375 * 24 * 60 * 60 * 1000;
    const first = await svc.record({ policyVersion: 1, choices: ALL, action: "accept_all", source: "banner", gpc: false }, { userPublicId: "usr_a", ipAddress: null });
    await svc.record({ receipt: first.receipt, policyVersion: 1, choices: NONE, action: "withdraw", source: "account", gpc: false }, { userPublicId: "usr_a", ipAddress: null });
    h.clock.advance(35 * month);
    expect(await svc.purge()).toEqual({ superseded: 0, expired: 0 });
    h.clock.advance(2 * month);
    expect(await svc.purge()).toEqual({ superseded: 1, expired: 0 });
    h.clock.advance(12 * month);
    expect(await svc.purge()).toEqual({ superseded: 0, expired: 1 });
    expect(await t.db.select().from(platformConsentRecords)).toHaveLength(0);

    await svc.record({ policyVersion: 1, choices: NONE, action: "reject_all", source: "banner", gpc: false }, { userPublicId: "usr_b", ipAddress: null });
    expect(await svc.forgetUser("usr_b")).toBe(1);
    expect(await svc.mine("usr_b")).toHaveLength(0);
    expect(await t.db.select().from(platformConsentRecords)).toHaveLength(1);
  });

  it("trash participant: a customer's permanent deletion unlinks only that customer's consent records, idempotently", async () => {
    await enable();
    await svc.record({ policyVersion: 1, choices: NONE, action: "reject_all", source: "banner", gpc: false }, { userPublicId: "usr_trash_a", ipAddress: null });
    await svc.record({ policyVersion: 1, choices: ALL, action: "accept_all", source: "banner", gpc: false }, { userPublicId: "usr_trash_b", ipAddress: null });
    const participant = createPlatformTrashParticipant(svc);
    expect(participant.module).toBe(PLATFORM_TRASH_MODULE);
    expect(participant.onTrashedInTx).toBeUndefined();
    expect(participant.onRestoredInTx).toBeUndefined();
    const order = { kind: "order" as const, id: 1, publicId: "ord_trash", batchId: "01J0000000000000000000BATCH" };
    expect(await participant.purge!(order, { runId: "run_1" })).toEqual({ deleted: {} });
    const customer = { kind: "customer" as const, id: 2, publicId: "usr_trash_a", batchId: "01J0000000000000000000BATCH" };
    expect(await participant.purge!(customer, { runId: "run_1" })).toEqual({ deleted: { consents: 1 } });
    expect(await participant.purge!(customer, { runId: "run_1" })).toEqual({ deleted: { consents: 0 } });
    expect(await svc.mine("usr_trash_a")).toHaveLength(0);
    expect(await svc.mine("usr_trash_b")).toHaveLength(1);
  });
});
