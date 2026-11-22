import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { createTestDeps, fakePrincipal, silentLogger, withTestRequest, type TestHarness } from "../../../tests/helpers/fakes.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { SessionPrincipal, SessionTransport } from "../../core/types.js";
import { createCallerFactory, router, type TrpcContext } from "../../trpc/trpc.js";
import { CONSENT_FLAG } from "./consent.js";
import { createPlatformModule } from "./module.js";
import { platformRouter } from "./router.js";
import { platformConsentRecords, platformPresentationImages, platformSettings } from "./schema.js";
import { createSettingsStore, type PlatformSettingsStore } from "./settingsStore.js";

const transport: SessionTransport = { issue() {}, clear() {} };
const appRouter = router({ platform: platformRouter });
const NONE = { preferences: false, analytics: false, session_replay: false };
const decision = { policyVersion: 1, choices: NONE, action: "reject_all" as const, source: "banner" as const, gpc: false };

let t: TestDb;
let h: TestHarness;
let store: PlatformSettingsStore;

beforeAll(async () => {
  t = await createTestDb({ schema: { platformSettings, platformPresentationImages, platformConsentRecords } });
});
afterAll(() => t.cleanup());
beforeEach(async () => {
  await t.db.delete(platformConsentRecords);
  await t.db.delete(platformSettings);
  h = createTestDeps({ db: t.db });
  store = createSettingsStore({ db: t.db, clock: h.clock, logger: silentLogger, crypto: h.deps.crypto, audit: h.audit });
  h.deps.settings = store;
  h.services.settings = store;
  const platform = createPlatformModule(h.deps);
  h.services.platform = platform;
  h.services.allModules = [platform];
  (h.services as unknown as Record<string, unknown>).identity = {
    hasActiveAdministrator: async () => true,
    sessions: { assertCurrent: async (p: SessionPrincipal) => ({ pendingSteps: [], role: p.role, stepUpAt: p.stepUpAt, mfaVerifiedAt: p.mfaVerifiedAt }) },
  };
});

const caller = (session: TrpcContext["session"]) =>
  createCallerFactory(appRouter)({ services: h.services, session, request: newRequestContext("test"), transport }).platform;
const now = () => h.clock.now();
const enable = () => withTestRequest(() => store.setFeature(CONSENT_FLAG.flag, true, { expectedVersion: 0 }));

describe("consent router authorization", () => {
  it("bootstrap and inventory are public and expose only safe data", async () => {
    const b = await caller(null).bootstrap();
    expect(Object.keys(b).sort()).toEqual(["consent", "features"]);
    const inv = await caller(null).consent.inventory();
    expect(Object.keys(inv).sort()).toEqual(["categories", "enabled", "items", "policyVersion", "renewMonths"]);
  });

  it("anonymous visitors can record; the user id comes only from a full session", async () => {
    await enable();
    await caller(null).consent.record(decision);
    const customer = fakePrincipal({ role: "customer" });
    await caller(customer).consent.record(decision);
    const remediation = fakePrincipal({ role: "customer", state: "remediation", pendingSteps: ["mfa_enrollment"] as never });
    await caller(remediation).consent.record(decision);
    const rows = await t.db.select().from(platformConsentRecords);
    expect(rows.map((r) => r.userPublicId)).toEqual([null, customer.userPublicId, null]);
  });

  it("refuses a client-supplied user id", async () => {
    await enable();
    await expect(caller(null).consent.record({ ...decision, userPublicId: "usr_victim" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("history needs a session; ledger tools need an administrator", async () => {
    await expect(caller(null).consent.mine()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    for (const role of ["customer", "staff"] as const) {
      const p = fakePrincipal({ role, stepUpAt: now() });
      await expect(caller(p).admin.consent.stats({ days: 30 })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller(p).admin.consent.search({})).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller(p).admin.consent.export({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(caller(null).admin.consent.search({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const admin = fakePrincipal({ role: "admin", stepUpAt: now() });
    expect((await caller(admin).admin.consent.stats({ days: 30 })).total).toBe(0);
  });

  it("customers cannot change consent settings through the generic settings API", async () => {
    const p = fakePrincipal({ role: "customer", stepUpAt: now() });
    await expect(caller(p).admin.settings.update({ key: "privacy.consent.policy_version", value: 2, expectedVersion: 0 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
