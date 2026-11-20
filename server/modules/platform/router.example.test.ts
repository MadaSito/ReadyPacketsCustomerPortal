import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { createTestDeps, fakePrincipal, silentLogger, type TestHarness } from "../../../tests/helpers/fakes.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { SessionPrincipal, SessionTransport } from "../../core/types.js";
import { createCallerFactory, router, type TrpcContext } from "../../trpc/trpc.js";
import { createPlatformModule } from "./module.js";
import { platformRouter } from "./router.js";
import { platformPresentationImages, platformSettings } from "./schema.js";
import { PRESENTATION_SUPPORT_TEXT } from "./settings.js";
import { defineSecret } from "./settingsRegistry.js";
import { createSettingsStore } from "./settingsStore.js";

const SECRET = defineSecret({ key: "integrations.test_router_secret", owner: "platform", group: "integrations", label: "Router secret", description: "Synthetic." });
const transport: SessionTransport = { issue() {}, clear() {} };
const appRouter = router({ platform: platformRouter });

let t: TestDb;
let h: TestHarness;

beforeAll(async () => {
  t = await createTestDb({ schema: { platformSettings, platformPresentationImages } });
});
afterAll(() => t.cleanup());
beforeEach(async () => {
  await t.db.delete(platformSettings);
  h = createTestDeps({ db: t.db });
  const store = createSettingsStore({ db: t.db, clock: h.clock, logger: silentLogger, crypto: h.deps.crypto, audit: h.audit });
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
const admin = (stepUp = true) => fakePrincipal({ role: "admin", stepUpAt: stepUp ? now() : null });
const update = { key: PRESENTATION_SUPPORT_TEXT.key, value: "Call us", expectedVersion: 0 };

describe("platform router authorization", () => {
  it("public procedures expose only safe data", async () => {
    expect(await caller(null).setupStatus()).toEqual({ administratorExists: true });
    const presentation = await caller(null).presentation();
    expect(Object.keys(presentation).sort()).toEqual(["announcement", "slides", "slideshow", "supportText"]);
  });

  it("denies anonymous, customer, staff and remediation sessions on admin procedures", async () => {
    await expect(caller(null).admin.settings.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller(fakePrincipal({ role: "customer" })).admin.settings.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(fakePrincipal({ role: "staff" })).admin.settings.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(fakePrincipal({ role: "staff", stepUpAt: now() })).admin.settings.update(update)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const remediation = fakePrincipal({ role: "admin", state: "remediation", pendingSteps: ["mfa_enrollment"] as never });
    await expect(caller(remediation).admin.settings.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(fakePrincipal({ role: "customer" })).admin.health()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(fakePrincipal({ role: "customer" })).admin.config.export({ includeSecrets: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.audit.named("platform.setting.changed")).toHaveLength(0);
  });

  it("requires a fresh step-up for every change", async () => {
    const stale = admin(false);
    await expect(caller(stale).admin.settings.update(update)).rejects.toMatchObject({ cause: expect.objectContaining({ code: "STEP_UP_REQUIRED" }) });
    await expect(caller(stale).admin.settings.setSecret({ key: SECRET.key, value: "x", expectedVersion: 0 })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "STEP_UP_REQUIRED" }),
    });
    await expect(caller(stale).admin.features.set({ key: "feature.x", enabled: true, expectedVersion: 0 })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "STEP_UP_REQUIRED" }),
    });
    await expect(caller(stale).admin.config.export({ includeSecrets: false })).rejects.toMatchObject({ cause: expect.objectContaining({ code: "STEP_UP_REQUIRED" }) });
    await expect(caller(stale).admin.presentation.deleteImage({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "STEP_UP_REQUIRED" }),
    });
  });

  it("validates inputs strictly", async () => {
    await expect(caller(admin()).admin.settings.update({ ...update, extra: 1 } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller(admin()).admin.settings.update({ ...update, key: "../etc" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller(admin()).admin.settings.update({ ...update, value: "<script>" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller(admin()).admin.settings.update({ ...update, key: "general.undeclared" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("lets an administrator with fresh step-up change settings; secrets never come back", async () => {
    const view = await caller(admin()).admin.settings.update(update);
    expect(view).toMatchObject({ key: update.key, value: "Call us", version: 1 });
    const secret = await caller(admin()).admin.settings.setSecret({ key: SECRET.key, value: "sk-router-synthetic", expectedVersion: 0 });
    expect(secret).toMatchObject({ configured: true });
    const list = await caller(admin(false)).admin.settings.list();
    expect(JSON.stringify(list)).not.toContain("sk-router-synthetic");
    expect(JSON.stringify(secret)).not.toContain("sk-router-synthetic");
    await expect(caller(admin()).admin.settings.update(update)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("serves health and the setup checklist to administrators", async () => {
    const report = await caller(admin(false)).admin.health();
    expect(report.components.map((c) => c.component)).toContain("platform.database");
    const checklist = await caller(admin(false)).admin.setupChecklist();
    expect(checklist.map((i) => i.id)).toContain("admin_exists");
  });
});
