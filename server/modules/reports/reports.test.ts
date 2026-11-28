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
import {
  complianceInvoicePayments,
  complianceInvoiceRefunds,
  complianceInvoices,
  policyAcceptances,
  policyDocuments,
} from "../compliance/schema.js";
import { signInEvents, users } from "../identity/schema.js";
import { orderLineItems, orders, orderStatusHistory, orderWorkflows, orderWorkflowVersions } from "../orders/schema.js";
import { promoBatches, promoCodes, promoRedemptions } from "../promotions/schema.js";
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
  db = await createTestDb({
    schema: {
      users,
      signInEvents,
      protectionSignInBans,
      reportDefinitions,
      reportRuns,
      orderWorkflows,
      orderWorkflowVersions,
      orders,
      orderLineItems,
      orderStatusHistory,
      complianceInvoices,
      complianceInvoicePayments,
      complianceInvoiceRefunds,
      policyDocuments,
      policyAcceptances,
      promoBatches,
      promoCodes,
      promoRedemptions,
    },
  });
});
afterAll(() => db?.cleanup());

beforeEach(async () => {
  for (const table of [
    reportRuns,
    reportDefinitions,
    signInEvents,
    complianceInvoiceRefunds,
    complianceInvoicePayments,
    complianceInvoices,
    policyAcceptances,
    policyDocuments,
    promoRedemptions,
    promoCodes,
    promoBatches,
    orderStatusHistory,
    orderLineItems,
    orders,
    orderWorkflowVersions,
    orderWorkflows,
    users,
  ]) {
    await db.db.delete(table);
  }
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

describe("Increment 09 D2.2 / D2.6 trash visibility and retained payments", () => {
  it("excludes trashed and tombstoned orders & customers from operational reports while keeping kept payments and redemptions in money reports", async () => {
    const LIVE_CUST = "01JRPTRPT00000000000000001";
    const TRASHED_CUST = "01JRPTRPT00000000000000002";
    const PURGED_CUST = "01JRPTRPT00000000000000003";
    const ADMIN_PUB = "01JRPTRPT00000000000000009";
    const LIVE_ORDER = "01JRPTRPT00000000000000011";
    const TRASHED_ORDER = "01JRPTRPT00000000000000012";
    const PURGED_ORDER = "01JRPTRPT00000000000000013";
    const createdAt = new Date("2026-11-12T12:00:00.000Z");

    const [adminRow] = await db.db.insert(users).values({
      publicId: ADMIN_PUB,
      role: "admin",
      status: "active",
      emailEnc: h.deps.crypto.encrypt("admin.synth@example.test", `users.email:${ADMIN_PUB}`),
      emailIndex: h.deps.crypto.blindIndex("admin.synth@example.test", "users.email"),
      nameEnc: h.deps.crypto.encrypt("Admin Synthetic", `users.name:${ADMIN_PUB}`),
      createdAt,
    });
    const adminUserId = Number(adminRow.insertId);

    const [liveCustRow] = await db.db.insert(users).values({
      publicId: LIVE_CUST,
      customerRef: "RPCUS-A1B2CJJG5",
      role: "customer",
      status: "active",
      emailEnc: h.deps.crypto.encrypt("zeus.greene@example.test", `users.email:${LIVE_CUST}`),
      emailIndex: h.deps.crypto.blindIndex("zeus.greene@example.test", "users.email"),
      nameEnc: h.deps.crypto.encrypt("Zeus Greene", `users.name:${LIVE_CUST}`),
      createdAt,
    });
    const liveCustId = Number(liveCustRow.insertId);

    const [trashedCustRow] = await db.db.insert(users).values({
      publicId: TRASHED_CUST,
      customerRef: "RPCUS-TRSH00002",
      role: "customer",
      status: "suspended",
      emailEnc: h.deps.crypto.encrypt("trashed.cust@example.test", `users.email:${TRASHED_CUST}`),
      emailIndex: h.deps.crypto.blindIndex("trashed.cust@example.test", "users.email"),
      nameEnc: h.deps.crypto.encrypt("Trashed Synthetic", `users.name:${TRASHED_CUST}`),
      trashedAt: createdAt,
      trashBatchId: "01JETRASHBATCH000000000011",
      createdAt,
    });
    const trashedCustId = Number(trashedCustRow.insertId);

    const [purgedCustRow] = await db.db.insert(users).values({
      publicId: PURGED_CUST,
      role: "customer",
      status: "deactivated",
      emailEnc: "tombstone",
      emailIndex: h.deps.crypto.blindIndex(`purged:${PURGED_CUST}`, "users.email"),
      nameEnc: "tombstone",
      trashedAt: createdAt,
      purgedAt: createdAt,
      trashBatchId: "01JETRASHBATCH000000000012",
      createdAt,
    });
    const purgedCustId = Number(purgedCustRow.insertId);

    const [liveOrdRow] = await db.db.insert(orders).values({
      publicId: LIVE_ORDER,
      reference: "RP-2026-2001",
      ownerUserId: liveCustId,
      projectName: "Ice Queen",
      workflowVersionId: 1,
      statusKey: "completed",
      subtotalMinor: 2000,
      totalMinor: 2000,
      currency: "USD",
      submittedAt: createdAt,
      createdAt,
    });
    const liveOrderId = Number(liveOrdRow.insertId);

    const [trashedOrdRow] = await db.db.insert(orders).values({
      publicId: TRASHED_ORDER,
      reference: "RP-2026-2002",
      ownerUserId: trashedCustId,
      projectName: "Ice Queen",
      workflowVersionId: 1,
      statusKey: "completed",
      subtotalMinor: 3000,
      totalMinor: 3000,
      currency: "USD",
      submittedAt: createdAt,
      trashedAt: createdAt,
      trashBatchId: "01JETRASHBATCH000000000011",
      createdAt,
    });
    const trashedOrderId = Number(trashedOrdRow.insertId);

    const [purgedOrdRow] = await db.db.insert(orders).values({
      publicId: PURGED_ORDER,
      reference: "RP-2026-2003",
      ownerUserId: purgedCustId,
      projectName: "Deleted order",
      workflowVersionId: 1,
      statusKey: "completed",
      subtotalMinor: 4000,
      totalMinor: 3500,
      discountMinor: 500,
      promoDiscountMinor: 500,
      currency: "USD",
      submittedAt: createdAt,
      trashedAt: createdAt,
      purgedAt: createdAt,
      trashBatchId: "01JETRASHBATCH000000000012",
      createdAt,
    });
    const purgedOrderId = Number(purgedOrdRow.insertId);

    await db.db.insert(orderStatusHistory).values([
      {
        publicId: "01JRPTRPT00000000000000021",
        orderId: liveOrderId,
        fromStatus: "new",
        toStatus: "completed",
        actorRole: "admin",
        occurredAt: new Date("2026-11-12T13:00:00.000Z"),
      },
      {
        publicId: "01JRPTRPT00000000000000022",
        orderId: trashedOrderId,
        fromStatus: "new",
        toStatus: "completed",
        actorRole: "admin",
        occurredAt: new Date("2026-11-12T13:00:00.000Z"),
      },
      {
        publicId: "01JRPTRPT00000000000000023",
        orderId: purgedOrderId,
        fromStatus: "new",
        toStatus: "completed",
        actorRole: "admin",
        occurredAt: new Date("2026-11-12T13:00:00.000Z"),
      },
    ]);

    // Kept invoices & payments on live, trashed, and purged orders
    const [invLive] = await db.db.insert(complianceInvoices).values({
      publicId: "01JRPTRPT00000000000000031",
      orderId: liveOrderId,
      orderPublicId: LIVE_ORDER,
      invoiceNumber: "RP-INV-2026-000101",
      status: "paid",
      currency: "USD",
      subtotalMinor: 2000,
      totalMinor: 2000,
      issuedAt: createdAt,
    });
    const [invPurged] = await db.db.insert(complianceInvoices).values({
      publicId: "01JRPTRPT00000000000000032",
      orderId: purgedOrderId,
      orderPublicId: PURGED_ORDER,
      invoiceNumber: "RP-INV-2026-000102",
      status: "paid",
      currency: "USD",
      subtotalMinor: 4000,
      discountMinor: 500,
      totalMinor: 3500,
      issuedAt: createdAt,
    });
    await db.db.insert(complianceInvoicePayments).values([
      {
        publicId: "01JRPTRPT00000000000000041",
        invoiceId: Number(invLive.insertId),
        method: "check",
        provider: "stripe",
        status: "succeeded",
        amountMinor: 2000,
        currency: "USD",
        reference: "pi_synth_live",
        receivedAt: createdAt,
        idempotencyKey: "idem-pay-live",
      },
      {
        publicId: "01JRPTRPT00000000000000042",
        invoiceId: Number(invPurged.insertId),
        method: "check",
        provider: "stripe",
        status: "succeeded",
        amountMinor: 3500,
        currency: "USD",
        reference: "pi_synth_purged",
        receivedAt: createdAt,
        idempotencyKey: "idem-pay-purged",
      },
    ]);

    const [batchRes] = await db.db.insert(promoBatches).values({
      publicId: "01JRPTRPT00000000000000051",
      name: "Autumn Launch",
      label: "Autumn 500",
      discountType: "fixed",
      fixedAmountMinor: 500,
      currency: "USD",
      scopeKind: "all",
      scopeProductPublicIds: [],
      scopeTierKeys: [],
      scopePacketNumbers: [],
      allowCustomerPublicIds: [],
      allowEmailDomains: [],
      redemptionCount: 1,
      createdByUserId: adminUserId,
    });
    const [codeRes] = await db.db.insert(promoCodes).values({
      publicId: "01JRPTRPT00000000000000052",
      batchId: Number(batchRes.insertId),
      codeIndex: h.deps.crypto.blindIndex("AUTUMN500", "promo_codes.code"),
      codeEnc: h.deps.crypto.encrypt("AUTUMN500", "promo_codes.code_enc:01JRPTRPT00000000000000052"),
      redemptionCount: 1,
    });
    await db.db.insert(promoRedemptions).values({
      publicId: "01JRPTRPT00000000000000053",
      batchId: Number(batchRes.insertId),
      promoCodeId: Number(codeRes.insertId),
      customerUserId: purgedCustId,
      actorUserId: purgedCustId,
      orderPublicId: PURGED_ORDER,
      status: "redeemed",
      customerSequence: 1,
      activeCodeSequence: 1,
      activeBatchSequence: 1,
      currency: "USD",
      subtotalMinor: 4000,
      promoDiscountMinor: 500,
      bundleDiscountMinor: 0,
      discountMinor: 500,
      totalMinor: 3500,
      labelSnapshot: "Autumn 500",
      correlationId: "corr-synth-1",
      createdAt,
    });

    const range = { from: new Date("2026-11-01T00:00:00Z"), to: new Date("2026-11-20T00:00:00Z") };

    // 1. Operational orders report excludes trashed & tombstoned orders
    const ordersOut = await mod.builtIn.run(admin, { key: "orders", range });
    expect(ordersOut.metrics.find((m) => m.key === "created")?.value).toBe(1);
    expect(ordersOut.metrics.find((m) => m.key === "completed")?.value).toBe(1);

    // 2. Operational customers report excludes trashed & tombstoned customers
    const custOut = await mod.builtIn.run(admin, { key: "customers", range });
    expect(custOut.metrics.find((m) => m.key === "new")?.value).toBe(1);
    const customCustomers = await mod.custom.preview(
      admin,
      reportSpecSchema.parse({ dataset: "customers", columns: ["customerPublicId"] }),
    );
    expect(customCustomers.rows.map((r) => r[0])).toEqual([LIVE_CUST]);

    // 3. Money report keeps kept payments & promo redemption counts even for purged orders/customers
    const moneyOut = await mod.builtIn.run(admin, { key: "payments_discounts", range });
    expect(moneyOut.metrics.find((m) => m.key === "paid")?.value).toBe(5500);
    expect(moneyOut.metrics.find((m) => m.key === "redemptions")?.value).toBe(1);
    expect(moneyOut.metrics.find((m) => m.key === "promo_discount")?.value).toBe(500);
  });
});
