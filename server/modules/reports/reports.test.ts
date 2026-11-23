/**
 * Reports (D6) against LOCAL FAKES and the local dev MySQL test database: compiler whitelist and personal-data
 * gate, saved definitions, run slot / rate limit, CSV guard and byte cap, router authorization. Synthetic data only.
 */
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDeps, fakePrincipal, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { DomainError } from "../../core/errors.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { SessionPrincipal } from "../../core/types.js";
import { createCallerFactory, router } from "../../trpc/trpc.js";
import { signInEvents, users } from "../identity/schema.js";
import { protectionSignInBans } from "../protection/schema.js";
import { datasetViews } from "./catalogue.js";
import { REPORT_RUN_PURGE_JOB, createReportsModule, type ReportsModule } from "./index.js";
import { compileSpec, isStatementTimeout } from "./query.js";
import { reportsRouter } from "./router.js";
import { reportDefinitions, reportRuns } from "./schema.js";
import { buildCsv, createCsvWriter, filterShape, previousRange, specHash } from "./service.js";
import { REPORT_LIMITS, reportSpecSchema, type ReportSpecInput } from "./spec.js";

const createCaller = createCallerFactory(router({ reports: reportsRouter }));

let db: TestDb;
let h: TestHarness;
let mod: ReportsModule;
let admin: SessionPrincipal;
let staff: SessionPrincipal;
let liveRole: Record<number, SessionPrincipal["role"]>;

const spec = (over: Partial<ReportSpecInput> = {}) => reportSpecSchema.parse({ dataset: "sign_ins", columns: ["kind", "occurredAt"], ...over });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const cause = error instanceof TRPCError ? error.cause : error;
    if (cause instanceof DomainError) return cause.reasonCode;
    if (error instanceof TRPCError) return error.code;
    return "UNEXPECTED";
  }
  return "NO_ERROR";
}

function caller(principal: SessionPrincipal | null) {
  return createCaller({ services: h.services, session: principal, request: newRequestContext("test"), transport: { issue() {}, clear() {} } } as never);
}

beforeAll(async () => {
  db = await createTestDb({ schema: { users, signInEvents, protectionSignInBans, reportDefinitions, reportRuns } });
});
afterAll(() => db?.cleanup());

beforeEach(async () => {
  for (const table of [reportRuns, reportDefinitions, signInEvents]) await db.db.delete(table);
  h = createTestDeps({ db: db.db });
  admin = fakePrincipal({ role: "admin", stepUpAt: h.clock.now() });
  staff = fakePrincipal({ role: "staff", stepUpAt: h.clock.now() });
  liveRole = {};
  h.services.identity = {
    sessions: {
      assertCurrent: async (p: SessionPrincipal) => ({ role: liveRole[p.userId] ?? p.role, stepUpAt: p.stepUpAt, pendingSteps: [], mfaVerifiedAt: p.mfaVerifiedAt }),
    },
  } as never;
  mod = createReportsModule(h.deps);
  (h.services as unknown as { reports: ReportsModule }).reports = mod;
  const base = new Date("2026-11-10T00:00:00.000Z").getTime();
  await db.db.insert(signInEvents).values([
    { publicId: "01JSGNEVT00000000000000001", occurredAt: new Date(base), kind: "success", role: "customer", country: "US" },
    { publicId: "01JSGNEVT00000000000000002", occurredAt: new Date(base + 3_600_000), kind: "failure", reasonCode: "=HYPERLINK(1)" },
    { publicId: "01JSGNEVT00000000000000003", occurredAt: new Date(base + 7_200_000), kind: "success", role: "staff", country: "CA" },
  ] as never);
});

describe("spec compiler (whitelist only)", () => {
  it("refuses unknown datasets, unknown fields and non-whitelisted columns", () => {
    expect(() => compileSpec(spec({ dataset: "users" }), { includePersonal: true })).toThrow(DomainError);
    expect(() => compileSpec(spec({ columns: ["ipAddressEnc"] }), { includePersonal: true })).toThrow(DomainError);
    expect(() => compileSpec(spec({ columns: ["ipIndex"] }), { includePersonal: true })).toThrow(DomainError);
  });

  it("rejects SQL-looking names at the schema and treats SQL-looking values as data", async () => {
    expect(reportSpecSchema.safeParse({ dataset: "sign_ins; DROP TABLE users", columns: ["kind"] }).success).toBe(false);
    expect(reportSpecSchema.safeParse({ dataset: "sign_ins", columns: ["kind) OR (1=1"] }).success).toBe(false);
    expect(reportSpecSchema.safeParse({ dataset: "sign_ins", columns: ["kind"], extra: 1 }).success).toBe(false);
    const result = await mod.custom.preview(admin, spec({ filters: [{ field: "reasonCode", op: "eq", value: "x' OR '1'='1" }] }));
    expect(result.rowCount).toBe(0);
  });

  it("gates personal fields: staff never see them in the catalogue or compiler", () => {
    expect(() => compileSpec(spec({ columns: ["country"] }), { includePersonal: false })).toThrow(DomainError);
    expect(() => compileSpec(spec({ columns: ["country"] }), { includePersonal: true })).not.toThrow();
    const staffFields = datasetViews(false).flatMap((d) => d.fields.map((f) => `${d.key}.${f.key}`));
    expect(staffFields).not.toContain("sign_ins.country");
    for (const view of datasetViews(true)) for (const field of view.fields) expect(field.key).not.toMatch(/Enc$|Index$|secret|password|token/i);
  });

  it("maps MySQL statement timeouts", () => {
    expect(isStatementTimeout({ errno: 3024 })).toBe(true);
    expect(isStatementTimeout({ cause: { errno: 1317 } })).toBe(true);
    expect(isStatementTimeout({ errno: 1062 })).toBe(false);
  });
});

describe("CSV", () => {
  it("guards formulas, keeps numbers, uses BOM and CRLF", () => {
    const { csv } = buildCsv([{ key: "a", label: "A", type: "string" }, { key: "n", label: "N", type: "number" }], [["=SUM(1)", -5], ["@x", 3]]);
    expect(csv.startsWith("\uFEFFA,N\r\n")).toBe(true);
    expect(csv).toContain("'=SUM(1),-5\r\n");
    expect(csv).toContain("'@x,3\r\n");
  });

  it("stops at the cumulative byte cap and reports truncation", () => {
    const writer = createCsvWriter([{ key: "a", label: "A", type: "string" }], 64);
    let written = 0;
    while (writer.push(["x".repeat(20)])) written += 1;
    const out = writer.finish();
    expect(out.truncated).toBe(true);
    expect(out.rowCount).toBe(written);
    expect(out.bytes).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(out.csv, "utf8")).toBe(out.bytes);
  });

  it("hashes canonically and audits filter shape without values", () => {
    expect(specHash({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(specHash({ a: [2, { c: 2, d: 1 }], b: 1 }));
    expect(filterShape(spec({ filters: [{ field: "reasonCode", op: "eq", value: "secret-value" }] }))).toBe("reasonCode:eq");
    const range = { from: new Date("2026-11-10T00:00:00Z"), to: new Date("2026-11-20T00:00:00Z") };
    expect(previousRange(range)).toEqual({ from: new Date("2026-10-31T00:00:00Z"), to: range.from });
  });
});

describe("definitions and runs", () => {
  it("creates, runs and exports a saved definition with audit", async () => {
    const created = await mod.custom.create(admin, { name: "Sign-ins", spec: spec({ sort: [{ key: "occurredAt", dir: "asc" }] }) });
    expect(created.valid).toBe(true);
    const run = await mod.custom.run(admin, created.definitionId);
    expect(run.rowCount).toBe(3);
    const csv = await mod.custom.export(admin, created.definitionId);
    expect(csv.rowCount).toBe(3);
    expect(csv.csv).not.toContain("\r\nfailure,=");
    const exported = h.audit.named("report.exported")[0]!;
    expect(exported.attributes).toMatchObject({ spec_hash: created.specHash, truncated: false });
    expect(h.audit.named("report.run")).toHaveLength(1);
    expect(JSON.stringify(h.audit.events)).not.toContain("HYPERLINK");
  });

  it("enforces ownership, shared visibility and version conflicts", async () => {
    const other = fakePrincipal({ role: "admin", stepUpAt: h.clock.now() });
    const mine = await mod.custom.create(admin, { name: "Private", spec: spec() });
    expect(await codeOf(mod.custom.get(other, mine.definitionId))).toBe("REPORT_NOT_FOUND");
    expect(await codeOf(mod.custom.run(other, mine.definitionId))).toBe("REPORT_NOT_FOUND");
    const shared = await mod.custom.create(admin, { name: "Shared", visibility: "shared", spec: spec() });
    expect((await mod.custom.get(other, shared.definitionId)).ownedByMe).toBe(false);
    expect(await codeOf(mod.custom.update(other, shared.definitionId, 1, { name: "x", spec: spec() }))).toBe("REPORT_NOT_OWNER");
    expect(await codeOf(mod.custom.delete(admin, shared.definitionId, 9))).toBe("VERSION_CONFLICT");
    const copy = await mod.custom.duplicate(other, shared.definitionId);
    expect(copy.ownedByMe).toBe(true);
    expect(copy.visibility).toBe("private");
  });

  it("re-checks the live role before reading a saved spec", async () => {
    const created = await mod.custom.create(admin, { name: "Live", spec: spec() });
    liveRole[admin.userId] = "staff";
    expect(await codeOf(mod.custom.run(admin, created.definitionId))).toBe("CAPABILITY_NOT_GRANTED");
    expect(h.audit.named("report.denied")).toHaveLength(1);
  });

  it("allows one run per user, recovers stale slots, and rate limits", async () => {
    await db.db.insert(reportRuns).values({
      publicId: "01JRPTRUN00000000000000001", userId: admin.userId, activeUserId: admin.userId, kind: "custom", reportKey: "sign_ins",
      specHash: "0".repeat(64), state: "running", leaseUntil: new Date(h.clock.now().getTime() + 60_000), startedAt: new Date(h.clock.now().getTime() - 120_000),
    });
    expect(await codeOf(mod.custom.preview(admin, spec()))).toBe("REPORT_BUSY");
    h.clock.advance(61_000);
    await expect(mod.custom.preview(admin, spec())).resolves.toMatchObject({ rowCount: 3 });
    for (let i = 1; i < REPORT_LIMITS.runsPerMinute; i += 1) await mod.custom.preview(admin, spec());
    expect(await codeOf(mod.custom.preview(admin, spec()))).toBe("REPORT_RATE_LIMITED");
    expect(await codeOf(mod.custom.preview(staff, spec()))).toBe("CAPABILITY_NOT_GRANTED");
  });

  it("exports in pages and respects the definition limit", async () => {
    const created = await mod.custom.create(admin, { name: "Two", spec: spec({ limit: 2, sort: [{ key: "occurredAt", dir: "asc" }] }) });
    const csv = await mod.custom.export(admin, created.definitionId);
    expect(csv.rowCount).toBe(2);
    expect(csv.truncated).toBe(true);
  });

  it("built-in sign-ins report runs for staff without personal panels", async () => {
    const result = await mod.builtIn.run(staff, { key: "signins_security", range: { from: new Date("2026-11-01T00:00:00Z"), to: new Date("2026-11-20T00:00:00Z") } });
    expect(result.key).toBe("signins_security");
    expect(JSON.stringify(result)).not.toMatch(/"country"/);
  });

  it("registers the purge job", () => {
    expect(REPORT_RUN_PURGE_JOB).toMatch(/^[a-z][a-z0-9_]*(?:[.-][a-z0-9_]+)*$/);
  });
});

describe("router authorization", () => {
  it("refuses anonymous and customer callers", async () => {
    expect(await codeOf(caller(null).reports.catalogue())).toBe("NO_SESSION");
    expect(await codeOf(caller(fakePrincipal({ role: "customer" })).reports.catalogue())).not.toBe("NO_ERROR");
  });

  it("gives staff built-ins only and admins custom reports", async () => {
    const view = await caller(staff).reports.catalogue();
    expect(view.canManage).toBe(false);
    expect(view.datasets).toEqual([]);
    expect(await codeOf(caller(staff).reports.custom.list({}))).not.toBe("NO_ERROR");
    await expect(caller(admin).reports.custom.list({})).resolves.toMatchObject({ items: [], nextCursor: null });
  });

  it("requires fresh step-up for exports", async () => {
    const created = await mod.custom.create(admin, { name: "Step", spec: spec() });
    const stale = { ...admin, stepUpAt: null };
    expect(await codeOf(caller(stale).reports.custom.export({ definitionId: created.definitionId }))).toBe("STEP_UP_REQUIRED");
  });

  it("rejects non-strict input", async () => {
    expect(await codeOf(caller(admin).reports.custom.preview({ spec: { dataset: "sign_ins", columns: ["kind"], sql: "1" } } as never))).toBe("BAD_REQUEST");
  });
});
