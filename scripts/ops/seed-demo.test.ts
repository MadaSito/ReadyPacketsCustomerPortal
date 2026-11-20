/**
 * Demo seeder against the real composition root and an isolated MySQL test database (SYNTHETIC data only).
 * Only substitutions: FakeClock (deterministic session/step-up windows) and a temporary storage directory.
 */
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testConfig, type AppConfig } from "../../server/config/env.js";
import { createContainer, type Container } from "../../server/container.js";
import { FakeClock } from "../../server/core/clock.js";
import { auditEvents } from "../../server/modules/audit/schema.js";
import { userSessions } from "../../server/modules/identity/schema.js";
import { createTestDb, type TestDb } from "../../tests/helpers/testDb.js";
import { DEMO_ACCOUNTS, renderResult, runDemoSeed, syntheticPdf, type DemoSeedResult } from "./seed-demo.js";

let t: TestDb;
let storageDir: string;
let config: AppConfig;
let container: Container;
let first: DemoSeedResult;

const eventCount = async (names: string[]) => {
  const rows = await t.db
    .select({ name: auditEvents.eventName, n: count() })
    .from(auditEvents)
    .where(inArray(auditEvents.eventName, names))
    .groupBy(auditEvents.eventName);
  return Object.fromEntries(rows.map((r) => [r.name, Number(r.n)]));
};

beforeAll(async () => {
  t = await createTestDb();
  storageDir = await mkdtemp(join(tmpdir(), "rp-seed-demo-"));
  config = testConfig({ databaseUrl: t.url, storageDir });
  container = createContainer(config, { db: t.db, clock: new FakeClock(new Date("2026-11-20T09:00:00.000Z")) });
  first = await runDemoSeed(container.services, config);
}, 120_000);

afterAll(async () => {
  await container?.close().catch(() => undefined);
  await t?.cleanup();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

describe("seed-demo", () => {
  it("seeds every demo account and the demo data through the module services", () => {
    expect(first.status).toBe("seeded");
    expect(first.failed).toEqual([]);
    expect(first.skipped).toEqual([]);
    expect(first.credentials.map((c) => c.email).sort()).toEqual(DEMO_ACCOUNTS.map((a) => a.email).sort());
    for (const c of first.credentials) expect(c.email).toMatch(/@example\.com$/);
    const out = renderResult(first).join("\n");
    expect(out).toContain("DEMO-ONLY CREDENTIALS");
  });

  it("produces audit records for the seeded mutations and revokes every ops session", async () => {
    const counts = await eventCount([
      "identity.account.provisioned",
      "identity.session.ops_opened",
      "order.created",
      "order.status.changed",
      "file.uploaded",
      "engagement.message.sent",
      "engagement.ticket.created",
      "policy.version.published",
      "policy.accepted",
      "intake.version.published",
      "intake.submission.submitted",
      "invoice.issued",
      "invoice.payment.recorded",
    ]);
    expect(counts["identity.account.provisioned"]).toBe(4);
    expect(counts["order.created"]).toBe(5);
    for (const name of [
      "identity.session.ops_opened",
      "order.status.changed",
      "file.uploaded",
      "engagement.message.sent",
      "engagement.ticket.created",
      "policy.version.published",
      "policy.accepted",
      "intake.version.published",
      "intake.submission.submitted",
      "invoice.issued",
      "invoice.payment.recorded",
    ]) {
      expect(counts[name] ?? 0, name).toBeGreaterThan(0);
    }
    const live = await t.db.select({ n: count() }).from(userSessions).where(and(eq(userSessions.deviceSummary, "ops:demo_seed"), isNull(userSessions.revokedAt)));
    expect(Number(live[0]!.n)).toBe(0);
  });

  it("is idempotent: a second run changes nothing and says so (also with --fill-missing)", async () => {
    const before = await t.db.select({ n: count() }).from(auditEvents);
    const second = await runDemoSeed(container.services, config);
    expect(second).toMatchObject({ status: "already_seeded", changed: [], failed: [], credentials: [] });
    expect(renderResult(second)[0]).toBe("Demo data already seeded; nothing changed.");
    const after = await t.db.select({ n: count() }).from(auditEvents);
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n));

    const filled = await runDemoSeed(container.services, config, { fillMissing: true });
    expect(filled.failed).toEqual([]);
    expect(filled.changed).toEqual([]);
    expect(filled.status).toBe("already_seeded");
    const business = await eventCount(["identity.account.provisioned", "order.created", "invoice.issued", "engagement.ticket.created"]);
    expect(business["identity.account.provisioned"]).toBe(4);
    expect(business["order.created"]).toBe(5);
  });

  it("refuses under a production-profile configuration", async () => {
    const production = { ...config, deploymentProfile: "production" } as AppConfig;
    await expect(runDemoSeed(container.services, production)).rejects.toMatchObject({ reasonCode: "DEMO_SEED_FORBIDDEN" });
  });

  it("generates a structurally valid, passive sample PDF", () => {
    const pdf = syntheticPdf("Demo (synthetic)").toString("latin1");
    const xref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(pdf)![1]);
    expect(pdf.slice(xref, xref + 5)).toBe("xref\n");
    expect(pdf).not.toMatch(/\/(JavaScript|JS|AA|OpenAction|Launch|EmbeddedFile)\b/);
  });

  it("no operator command imports another command that runs when executed directly", () => {
    // Each command is bundled into one file; a bundled "run when executed directly" guard of an imported
    // command would fire inside the importing command (this once made the demo seed run the catalog import
    // and exit). Shared code belongs in a module without an entry point.
    const dir = import.meta.dirname;
    const commands = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const withEntryPoint = commands.filter((f) => /import\.meta\.url\s*===/.test(readFileSync(join(dir, f), "utf8")));
    expect(withEntryPoint).toContain("seed-demo.ts");
    const offenders: string[] = [];
    for (const file of commands) {
      const source = readFileSync(join(dir, file), "utf8");
      for (const target of withEntryPoint) {
        if (target !== file && source.includes(`"./${target.replace(/\.ts$/, ".js")}"`)) offenders.push(`${file} -> ${target}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
