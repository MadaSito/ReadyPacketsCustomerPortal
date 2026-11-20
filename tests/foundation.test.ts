import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { users } from "../server/modules/identity/schema.js";
import { ConfigError, loadConfig, testConfig } from "../server/config/env.js";
import { DomainError } from "../server/core/errors.js";
import { newRequestContext } from "../server/core/requestContext.js";
import type { SessionTransport } from "../server/core/types.js";
import {
  adminProcedure,
  createCallerFactory,
  protectedProcedure,
  publicProcedure,
  requireCapability,
  router,
  sessionProcedure,
  type TrpcContext,
} from "../server/trpc/trpc.js";
import { createTestDeps, fakePrincipal, type TestHarness } from "./helpers/fakes.js";
import { createTestDb, type TestDb } from "./helpers/testDb.js";

const transport: SessionTransport = { issue() {}, clear() {} };

describe("foundation: configuration", () => {
  it("refuses missing and weak secrets without echoing values", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(ConfigError);
    const weak = Buffer.alloc(32, 1).toString("base64");
    try {
      loadConfig({
        NODE_ENV: "production",
        RP_CANONICAL_ORIGIN: "https://my.readypackets.com",
        DATABASE_URL: "mysql://u:hunter2-secret@db/x",
        RP_STORAGE_DIR: "/srv/x",
        RP_INSTALLATION_ID: "prod-1",
        RP_DATA_KEYRING: JSON.stringify({ current: "k1", keys: { k1: weak } }),
        RP_INDEX_KEY: weak,
        RP_PSEUDONYM_KEY: weak,
        RP_TOKEN_HASH_KEY: weak,
        RP_AUDIT_CHAIN_KEY: weak,
      });
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect(String((error as Error).message)).not.toContain("hunter2");
      expect(String((error as Error).message)).not.toContain(weak);
    }
  });

  it("enables the preview session transport only for the preview profile", () => {
    expect(testConfig().previewTransportEnabled).toBe(false);
    expect(testConfig().sessionCookieName).toBe("__Host-rp_session");
  });
});

describe("foundation: procedure guards", () => {
  let h: TestHarness;
  const appRouter = router({
    open: publicProcedure.query(() => "open"),
    transition: sessionProcedure.query(() => "transition"),
    data: protectedProcedure.query(() => "data"),
    admin: adminProcedure.query(() => "admin"),
    reassign: protectedProcedure.use(requireCapability("orders.reassign")).mutation(() => "moved"),
    boom: publicProcedure.input(z.object({ kind: z.enum(["domain", "raw"]) })).query(({ input }) => {
      if (input.kind === "domain") throw new DomainError("CONFLICT", "TARGET_COLLISION", "That reference is already in use.");
      throw new Error("SELECT secret FROM users -- raw internal detail");
    }),
  });
  const caller = (session: TrpcContext["session"]) =>
    createCallerFactory(appRouter)({ services: h.services, session, request: newRequestContext("test"), transport });

  beforeAll(() => {
    h = createTestDeps();
  });

  it("denies anonymous and remediation sessions access to data procedures and audits the denial", async () => {
    await expect(caller(null).data()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const remediation = fakePrincipal({ state: "remediation", pendingSteps: ["enroll_mfa"] });
    await expect(caller(remediation).data()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(remediation).transition()).resolves.toBe("transition");
    expect(h.audit.named("authz.access.denied").map((event) => event.reasonCode)).toEqual(["NO_SESSION", "REMEDIATION_SESSION"]);
  });

  it("enforces role, capability and fresh step-up", async () => {
    const customer = fakePrincipal();
    await expect(caller(customer).admin()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(customer).reassign()).rejects.toMatchObject({ code: "FORBIDDEN" });
    const admin = fakePrincipal({ role: "admin" });
    await expect(caller(admin).reassign()).rejects.toMatchObject({ cause: expect.objectContaining({ code: "STEP_UP_REQUIRED" }) });
    const stale = fakePrincipal({ role: "admin", stepUpAt: new Date(h.clock.now().getTime() - 11 * 60_000) });
    await expect(caller(stale).reassign()).rejects.toMatchObject({ cause: expect.objectContaining({ code: "STEP_UP_REQUIRED" }) });
    const future = fakePrincipal({ role: "admin", stepUpAt: new Date(h.clock.now().getTime() + 60_000) });
    await expect(caller(future).reassign()).rejects.toMatchObject({ cause: expect.objectContaining({ code: "STEP_UP_REQUIRED" }) });
    const invalid = fakePrincipal({ role: "admin", stepUpAt: new Date(Number.NaN) });
    await expect(caller(invalid).reassign()).rejects.toMatchObject({ cause: expect.objectContaining({ code: "STEP_UP_REQUIRED" }) });
    const fresh = fakePrincipal({ role: "admin", stepUpAt: h.clock.now() });
    await expect(caller(fresh).reassign()).resolves.toBe("moved");
  });

  it("maps domain errors and never leaks raw internals", async () => {
    await expect(caller(null).boom({ kind: "domain" })).rejects.toMatchObject({ code: "CONFLICT", message: "That reference is already in use." });
    await expect(caller(null).boom({ kind: "raw" })).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });

  it("applies the rate limiter", async () => {
    h.rateLimiter.blocked.add("api");
    await expect(caller(null).open()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    h.rateLimiter.blocked.clear();
  });
});

describe("foundation: isolated MySQL test database", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb({ schema: { users } });
  });
  afterAll(() => t.cleanup());

  it("creates the schema and round-trips an encrypted row", async () => {
    const h = createTestDeps({ db: t.db });
    const publicId = "01JD0000000000000000000001";
    await t.db.insert(users).values({
      publicId,
      emailEnc: h.deps.crypto.encrypt("synthetic.user@example.test", `users.email:${publicId}`),
      emailIndex: h.deps.crypto.blindIndex("synthetic.user@example.test", "users.email"),
      nameEnc: h.deps.crypto.encrypt("Synthetic User", `users.name:${publicId}`),
    });
    const [row] = await t.db.select().from(users).where(eq(users.publicId, publicId));
    expect(row?.role).toBe("customer");
    expect(row?.emailEnc).not.toContain("synthetic.user");
    expect(h.deps.crypto.decrypt(row!.emailEnc, `users.email:${publicId}`)).toBe("synthetic.user@example.test");
    expect(() => h.deps.crypto.decrypt(row!.emailEnc, "users.email:other")).toThrow();
    expect(row?.createdAt).toBeInstanceOf(Date);
  });
});
