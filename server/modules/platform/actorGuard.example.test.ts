import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { createTestDeps, fakePrincipal, silentLogger, type TestHarness } from "../../../tests/helpers/fakes.js";
import { DomainError } from "../../core/errors.js";
import type { SessionPrincipal, Tx } from "../../core/types.js";
import { createPlatformModule, type PlatformModuleImpl } from "./module.js";
import { platformPresentationImages, platformSettings } from "./schema.js";
import { PRESENTATION_SUPPORT_TEXT } from "./settings.js";
import { createSettingsStore } from "./settingsStore.js";

type Current = { pendingSteps: string[]; role: SessionPrincipal["role"]; stepUpAt: Date | null; mfaVerifiedAt: Date | null };

let t: TestDb;
let h: TestHarness;
let platform: PlatformModuleImpl;
let current: Current | "revoked";
let sawTx: boolean[];

beforeAll(async () => {
  t = await createTestDb({ schema: { platformSettings, platformPresentationImages } });
});
afterAll(() => t.cleanup());
beforeEach(async () => {
  await t.db.delete(platformSettings);
  h = createTestDeps({ db: t.db });
  const store = createSettingsStore({ db: t.db, clock: h.clock, logger: silentLogger, crypto: h.deps.crypto, audit: h.audit });
  h.deps.settings = store;
  current = { pendingSteps: [], role: "admin", stepUpAt: h.clock.now(), mfaVerifiedAt: h.clock.now() };
  sawTx = [];
  (h.services as unknown as Record<string, unknown>).identity = {
    sessions: {
      async assertCurrent(_principal: SessionPrincipal, tx: Tx) {
        sawTx.push(tx !== undefined);
        if (current === "revoked") throw new DomainError("UNAUTHENTICATED", "SESSION_NOT_CURRENT", "Please sign in again.");
        return current;
      },
    },
  };
  platform = createPlatformModule(h.deps);
});

const admin = () => fakePrincipal({ role: "admin", stepUpAt: new Date("2026-11-20T12:00:00.000Z") });

async function attempt(): Promise<string | null> {
  try {
    await platform.updateSetting(PRESENTATION_SUPPORT_TEXT.key, "Call us", 0, platform.actorGuard(admin()));
    return null;
  } catch (error) {
    return error instanceof DomainError ? error.reasonCode : "UNEXPECTED";
  }
}

describe("actor re-validation inside the transaction", () => {
  it("allows a still-entitled administrator and runs the check on the transaction", async () => {
    expect(await attempt()).toBeNull();
    expect(sawTx).toEqual([true]);
    expect(h.audit.named("platform.setting.changed")).toHaveLength(1);
  });

  it.each([
    ["demoted to staff", () => ({ ...(current as Current), role: "staff" as const }), "ROLE_NOT_PERMITTED"],
    ["session lost its full state", () => ({ ...(current as Current), pendingSteps: ["mfa"] }), "NO_FULL_SESSION"],
    ["step-up expired", () => ({ ...(current as Current), stepUpAt: new Date(h.clock.now().getTime() - 11 * 60 * 1000) }), "STEP_UP_REQUIRED"],
    ["session revoked", () => "revoked" as const, "SESSION_NOT_CURRENT"],
  ])("refuses when the actor was %s after the request started — nothing written", async (_label, mutate, reason) => {
    current = mutate();
    expect(await attempt()).toBe(reason);
    expect(await t.db.select().from(platformSettings)).toHaveLength(0);
    expect(h.audit.events).toHaveLength(0);
  });

  it("fails closed when identity cannot verify the actor", async () => {
    (h.services as unknown as Record<string, unknown>).identity = undefined;
    expect(await attempt()).toBe("ACTOR_UNVERIFIABLE");
    expect(await t.db.select().from(platformSettings)).toHaveLength(0);
  });

  it("guards image deletion and config import in the same way", async () => {
    current = { ...(current as Current), role: "staff" };
    const guard = platform.actorGuard(admin());
    await expect(platform.presentationService.deleteImage("01ARZ3NDEKTSV4RRFFQ69G5FAV", guard)).rejects.toMatchObject({ reasonCode: "ROLE_NOT_PERMITTED" });
    await expect(platform.presentationService.uploadImage(Buffer.alloc(10), guard)).rejects.toMatchObject({ reasonCode: "IMAGE_UNSUPPORTED_TYPE" });
  });
});
