import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { createTestDeps, silentLogger, type TestHarness } from "../../../tests/helpers/fakes.js";
import { DomainError } from "../../core/errors.js";
import type { ModuleHealth, ModuleLifecycle } from "../../core/types.js";
import { createPlatformModule, type PlatformModuleImpl } from "./module.js";
import { platformPresentationImages, platformSettings } from "./schema.js";
import { computeSchemaStatus, readReleaseMigrations } from "./schemaContract.js";
import { createSettingsStore } from "./settingsStore.js";

const root = mkdtempSync(join(tmpdir(), "rp-migrations-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function migrationsDir(name: string, entries: { tag: string; when: number; sql: string }[]): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "meta"), { recursive: true });
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ version: "7", dialect: "mysql", entries: entries.map((e, idx) => ({ idx, version: "5", when: e.when, tag: e.tag, breakpoints: true })) }));
  for (const entry of entries) writeFileSync(join(dir, `${entry.tag}.sql`), entry.sql);
  return dir;
}
const M1 = { tag: "0000_init", when: 1_700_000_000_000, sql: "CREATE TABLE a (id int);" };
const M2 = { tag: "0001_more", when: 1_700_000_100_000, sql: "CREATE TABLE b (id int);" };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb({ schema: { platformSettings, platformPresentationImages } });
});
afterAll(() => t.cleanup());

async function setApplied(rows: { sql: string; when: number }[]): Promise<void> {
  await t.db.execute(sql`create table if not exists __drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`);
  await t.db.execute(sql`delete from __drizzle_migrations`);
  for (const row of rows) await t.db.execute(sql`insert into __drizzle_migrations (hash, created_at) values (${sha(row.sql)}, ${row.when})`);
}

describe("schema contract", () => {
  const two = () => migrationsDir("two", [M1, M2]);

  it("reads the journal and hashes files like drizzle", async () => {
    expect(await readReleaseMigrations(two())).toEqual([
      { tag: M1.tag, when: M1.when, hash: sha(M1.sql) },
      { tag: M2.tag, when: M2.when, hash: sha(M2.sql) },
    ]);
  });

  it("classifies current, behind, ahead, unknown and unreadable", async () => {
    const dir = two();
    await setApplied([M1, M2]);
    expect(await computeSchemaStatus(t.db, dir)).toEqual({ state: "current", releaseCount: 2, appliedCount: 2, lastReleaseTag: M2.tag });
    await setApplied([M1]);
    expect((await computeSchemaStatus(t.db, dir)).state).toBe("behind");
    await setApplied([M1, M2, { sql: "x", when: 1_800_000_000_000 }]);
    expect((await computeSchemaStatus(t.db, dir)).state).toBe("ahead");
    await setApplied([M1, { sql: "edited", when: M2.when }]);
    expect((await computeSchemaStatus(t.db, dir)).state).toBe("unknown");
    expect((await computeSchemaStatus(t.db, join(root, "missing"))).state).toBe("unreadable");
    const bad = migrationsDir("bad", [M2, M1]);
    expect((await computeSchemaStatus(t.db, bad)).state).toBe("unreadable");
  });

  it("assertSchemaContract refuses to start on mismatch, with counts only", async () => {
    const dir = two();
    const h = createTestDeps({ db: t.db, config: { migrationsDir: dir } });
    const platform = createPlatformModule(h.deps);
    await setApplied([M1, M2]);
    await expect(platform.assertSchemaContract()).resolves.toBeUndefined();
    await setApplied([M1]);
    const error = await platform.assertSchemaContract().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).reasonCode).toBe("SCHEMA_BEHIND");
    expect(h.audit.notes).toContainEqual(expect.objectContaining({ eventName: "platform.schema.contract.refused", safeCounts: { release_migrations: 2, applied_migrations: 1 } }));
    expect(JSON.stringify(h.audit.notes)).not.toContain("CREATE TABLE");
    await setApplied([M1, M2, { sql: "x", when: 1_800_000_000_000 }]);
    expect(((await platform.assertSchemaContract().catch((e: unknown) => e)) as DomainError).reasonCode).toBe("SCHEMA_AHEAD");
  });
});

describe("health aggregation, readiness and setup", () => {
  let h: TestHarness;
  let platform: PlatformModuleImpl;

  function probe(health: () => Promise<ModuleHealth[]> | ModuleHealth[]): ModuleLifecycle {
    return { health } as ModuleLifecycle;
  }

  beforeEach(async () => {
    const dir = migrationsDir("health", [M1]);
    await setApplied([M1]);
    h = createTestDeps({ db: t.db, config: { migrationsDir: dir } });
    const store = createSettingsStore({ db: t.db, clock: h.clock, logger: silentLogger, crypto: h.deps.crypto, audit: h.audit });
    h.deps.settings = store;
    h.services.settings = store;
    platform = createPlatformModule(h.deps);
    h.services.platform = platform;
  });

  it("reports platform components and aggregates module probes", async () => {
    const now = h.clock.now();
    h.services.allModules = [
      platform,
      probe(() => [{ component: "mail.smtp", state: "not_configured", summary: "Not configured.", checkedAt: now }]),
      probe(() => [{ component: "siem.delivery", state: "degraded", summary: "Backlog.", metrics: { backlog: 3 }, checkedAt: now }]),
    ];
    const report = await platform.healthReport();
    expect(report.components.map((c) => c.component)).toEqual([
      "platform.database",
      "platform.schema",
      "platform.keys",
      "platform.settings",
      "mail.smtp",
      "siem.delivery",
    ]);
    expect(report.state).toBe("degraded");
    expect((await platform.readiness()).ready).toBe(true);
  });

  it("bounds slow probes with a timeout and contains throwing probes", async () => {
    h.services.allModules = [platform, probe(() => new Promise(() => undefined)), probe(() => Promise.reject(new Error("db password=hunter2")))];
    const started = Date.now();
    const report = await platform.healthReport({ timeoutMs: 150 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(report.components).toContainEqual(expect.objectContaining({ component: "module_1.health", state: "failing", summary: "Health probe timed out." }));
    expect(report.components).toContainEqual(expect.objectContaining({ component: "module_2.health", state: "failing", summary: "Health probe failed." }));
    expect(JSON.stringify(report)).not.toContain("hunter2");
    expect(report.state).toBe("failing");
    // a hung or failing peer never delays or fails readiness
    const readyStarted = Date.now();
    expect((await platform.readiness()).ready).toBe(true);
    expect(Date.now() - readyStarted).toBeLessThan(1_000);
  });

  it("sanitizes invalid or oversized component reports", async () => {
    const now = h.clock.now();
    h.services.allModules = [
      platform,
      probe(() => [
        { component: "Bad Name<script>", state: "ok", summary: "x", checkedAt: now },
        { component: "files.storage", state: "ok", summary: "y".repeat(500), metrics: { "Bad-Key": 1, used_bytes: 12, nan: Number.NaN }, checkedAt: now },
      ]),
    ];
    const report = await platform.healthReport();
    expect(report.components).toContainEqual(expect.objectContaining({ component: "module_1.health", state: "degraded" }));
    const files = report.components.find((c) => c.component === "files.storage")!;
    expect(files.summary).toHaveLength(200);
    expect(files.metrics).toEqual({ used_bytes: 12 });
  });

  it("fails readiness when the schema does not match (critical component)", async () => {
    await setApplied([]);
    h.services.allModules = [platform];
    expect(await platform.readiness()).toEqual({ ready: false, state: "failing" });
    await setApplied([M1]);
    // cached for 2s
    expect((await platform.readiness()).ready).toBe(false);
    h.clock.advance(2_001);
    expect((await platform.readiness()).ready).toBe(true);
  });

  it("setupStatus fails closed when identity is unavailable", async () => {
    expect(await platform.setupStatus()).toEqual({ administratorExists: true, preview: false });
    (h.services as unknown as Record<string, unknown>).identity = { hasActiveAdministrator: async () => false };
    expect(await platform.setupStatus()).toEqual({ administratorExists: false, preview: false });
    (h.services as unknown as Record<string, unknown>).identity = { hasActiveAdministrator: async () => Promise.reject(new Error("x")) };
    expect(await platform.setupStatus()).toEqual({ administratorExists: true, preview: false });
  });

  it("flags the preview profile publicly and warns exactly once at startup", async () => {
    const warnings: string[] = [];
    const capture = { ...silentLogger, warn: (message: string) => void warnings.push(message), child: () => capture };
    const previewPlatform = createPlatformModule({ ...h.deps, logger: capture, config: { ...h.deps.config, deploymentProfile: "preview" } });
    previewPlatform.init?.();
    expect(warnings).toEqual(["preview profile active: relaxed framing/CORS, in-memory session transport, synthetic data only"]);
    expect(await previewPlatform.setupStatus()).toMatchObject({ preview: true });
    expect(await previewPlatform.presentation()).toMatchObject({ preview: true });
    platform.init?.();
    expect(await platform.presentation()).toMatchObject({ preview: false });
  });

  it("builds the admin setup checklist from identity and health", async () => {
    const now = h.clock.now();
    (h.services as unknown as Record<string, unknown>).identity = { hasActiveAdministrator: async () => true };
    h.services.allModules = [
      platform,
      probe(() => [{ component: "mail.smtp", state: "ok", summary: "ok", checkedAt: now }]),
      probe(() => [{ component: "backup.status", state: "failing", summary: "x", checkedAt: now }]),
    ];
    const items = await platform.setupChecklist();
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId.admin_exists).toMatchObject({ state: "complete", required: true });
    expect(byId.mfa_enforced).toMatchObject({ state: "complete", required: true });
    expect(byId.schema).toMatchObject({ state: "complete" });
    expect(byId.smtp).toMatchObject({ state: "complete", required: false });
    expect(byId.backups).toMatchObject({ state: "incomplete" });
    expect(byId.siem).toMatchObject({ state: "unknown" });
    expect(byId.canonical_origin?.state).toMatch(/complete|incomplete/);
  });
});
