import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openPackage } from "../../../portable/src/index.js";
import { createTestDeps, fakePrincipal, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { ulid } from "../../core/ids.js";
import { DomainError } from "../../core/errors.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { JobResult, SessionPrincipal } from "../../core/types.js";
import { createCallerFactory } from "../../trpc/trpc.js";
import { createBillingProfileModule } from "../billingProfile/index.js";
import * as billingProfileSchema from "../billingProfile/schema.js";
import { examplePdf } from "../files/fixtures.test-support.js";
import { createFilesModule } from "../files/index.js";
import * as filesSchema from "../files/schema.js";
import { createIdentityModule } from "../identity/index.js";
import * as identitySchema from "../identity/schema.js";
import { createOrdersModule } from "../orders/index.js";
import { ordersRouter } from "../orders/router.js";
import { fakeIdentity, insertUser, ordersTestSchema } from "../orders/testSupport.js";
import { workflowDefinitionSchema } from "../orders/workflowTypes.js";
import * as ordersSchema from "../orders/schema.js";
import { copyExact, inPrivateWorkspace } from "./custody.js";
import { buildPlan, type PortableInputRecord } from "./importPlanning.js";
import { customerBillingProfile, customerIdentity, groupLinkProblem, projectedOrder } from "./importShapes.js";
import { createPortableModule } from "./index.js";
import * as portableSchema from "./schema.js";
import { PORTABLE_EXPORT_JOB, PORTABLE_IMPORT_JOB, PORTABLE_RETENTION_JOB } from "./transferPolicy.js";

const testSchema = { ...identitySchema, ...ordersSchema, ...filesSchema, ...portableSchema, ...billingProfileSchema };
const CREATED = new Date("2025-07-15T17:07:33.123Z");
const CUSTOMER_EMAIL = "case.owner@example.test";
const AUTH_MARKER = "source-password-hash-must-not-travel";
const PDF = examplePdf();
const PASSPHRASE = randomBytes(26).toString("base64url");
const ADMIN_PASSWORD = "synthetic portable verifier password";
const FILE_HASH = createHash("sha256").update(PDF).digest("hex");
const OFFERING_SNAPSHOT = {
  packetNumber: 2, tier: "Standard" as const, outcome: "Documented findings",
  timeline: "Five business days", deliverables: [{ title: "Summary", detail: "Reviewed findings and next steps" }],
};
const OFFERING_PRICE = {
  subtotalMinor: 2500, discountMinor: 375, discountLabel: "Fixture bundle discount", totalMinor: 2125,
  promoDiscountMinor: 125, promoLabel: "Fixture promo",
};

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iterable) result.push(item);
  return result;
}

function distinctKeyConfig() {
  const keys = { current: "target", keys: { target: randomBytes(32).toString("base64") } };
  return { dataKeyring: keys, indexKey: randomBytes(32).toString("base64"), pseudonymKey: randomBytes(32).toString("base64") };
}

async function environment(t: TestDb, installationId: string) {
  const h = createTestDeps({ db: t.db, config: { ...distinctKeyConfig(), installationId, canonicalOrigin: `https://${installationId}.example.test` } });
  const admins: SessionPrincipal[] = [];
  const assuranceFixture: Pick<TestHarness["services"]["assurance"], "getAssuranceState"> = {
    getAssuranceState: async () => ({ mfaEnrolled: true, recoveryCodesAcknowledged: true, passkeyCount: 0, totpEnrolled: true }),
  };
  h.services.assurance = assuranceFixture as TestHarness["services"]["assurance"];
  const identity = createIdentityModule(h.deps);
  h.services.identity = identity;
  const signInAdmin = async (email: string): Promise<SessionPrincipal> => {
    const signed = await identity.auth.signIn({ email, password: ADMIN_PASSWORD }, { userAgent: "vitest" });
    await identity.sessions.markMfaVerified(signed.sessionId);
    const issued = await identity.sessions.markStepUp(signed.sessionId);
    const principal = await identity.sessionResolver.resolve({ token: issued.token, transport: "cookie" });
    if (!principal || principal.state !== "full" || !principal.stepUpAt) throw new Error("Expected a full stepped-up admin session");
    return principal;
  };
  h.services.jobAdmin = { isDraining: async () => false } as TestHarness["services"]["jobAdmin"];
  h.services.orders = createOrdersModule(h.deps);
  h.services.files = createFilesModule(h.deps);
  h.services.billingProfile = createBillingProfileModule(h.deps);
  h.services.portable = createPortableModule(h.deps);
  for (const email of ["first.admin@example.test", "second.admin@example.test"]) {
    const user = await t.db.transaction((tx) => identity.auth.insertUser(tx, {
      email, name: "Synthetic administrator", role: "admin", status: "active", origin: "test", emailVerifiedAt: h.clock.now(),
    }));
    await identity.setPassword(user.id, ADMIN_PASSWORD, { mustChange: false });
    admins.push(await signInAdmin(email));
  }
  return { ...h, admins };
}

describe("portable transfer across isolated MySQL installations", () => {
  let sourceDb: TestDb;
  let targetDb: TestDb;
  let source: Awaited<ReturnType<typeof environment>>;
  let target: Awaited<ReturnType<typeof environment>>;
  let archive: Buffer;
  let sourceCustomer: { userId: number; publicId: string; customerRef: string };
  let sourceOrderId: string;

  beforeAll(async () => {
    sourceDb = await createTestDb({ schema: testSchema });
    targetDb = await createTestDb({ schema: testSchema });
    source = await environment(sourceDb, "portable-source");
    target = await environment(targetDb, "portable-target");
    sourceCustomer = await sourceDb.db.transaction((tx) => source.services.identity.createPendingCustomer({
      email: CUSTOMER_EMAIL, name: "Synthetic Case Owner", createdAt: CREATED,
    }, { tx }));
    await sourceDb.db.update(identitySchema.users).set({ passwordHash: AUTH_MARKER })
      .where(eq(identitySchema.users.id, sourceCustomer.userId));
    const order = await sourceDb.db.transaction((tx) => source.services.orders.importOrder({
      importId: ulid(), sourceInstallationId: "synthetic-source-fixture", sourceOrderPublicId: ulid(),
      targetOwnerUserId: sourceCustomer.userId, projectName: "Synthetic order", statusKey: "submitted",
      ...OFFERING_PRICE, currency: "USD", createdAt: CREATED, submittedAt: CREATED, editable: false,
      lineItems: [{ sourcePublicId: ulid(), productPublicId: null, productVersion: null, name: "Fixture line",
        description: "", features: [], ...OFFERING_SNAPSHOT, unitPriceMinor: 2500, currency: "USD", quantity: 1, lineTotalMinor: 2500 }],
      statusHistory: [{ sourcePublicId: ulid(), fromStatus: null, toStatus: "submitted", actorRole: "system",
        reasonCode: "SOURCE_FIXTURE", occurredAt: CREATED }],
    }, tx));
    sourceOrderId = order.publicId;
    const stage = await source.storage.put(source.storage.newKey("staging"), PDF);
    await sourceDb.db.transaction((tx) => source.services.files.adoptVerifiedObject({
      principal: source.admins[0]!, orderId: order.id, orderPublicId: order.publicId, ownerUserId: sourceCustomer.userId,
      displayName: "fixture.pdf", category: "deliverable", visibility: "customer_visible", stagedObject: stage,
      destinationKey: source.storage.newKey("files"), contentType: "application/pdf", createdAt: CREATED,
    }, tx));
  }, 60_000);

  afterAll(async () => {
    await Promise.all([sourceDb?.cleanup(), targetDb?.cleanup()]);
  });

  async function capture() {
    const created = await source.services.portable.startExport(source.admins[0]!, {
      selection: { kind: "orders", ids: [sourceOrderId] }, passphrase: PASSPHRASE,
    });
    expect(created.state).toBe("queued");
    expect(JSON.stringify(source.jobs.enqueued)).not.toContain(PASSPHRASE);
    expect(await source.jobs.runAll(PORTABLE_EXPORT_JOB)).toEqual([expect.objectContaining({ outcome: "completed" })]);
    const completed = await source.services.portable.openExport(source.admins[0]!, created.exportId);
    const payload = Buffer.concat(await collect(completed.stream as AsyncIterable<Buffer>));
    await completed.finish("completed");
    return payload;
  }

  it("exports a selected complete order and independently verifies ciphertext, record coverage, and excluded auth material", async () => {
    archive = await capture();
    const [row] = await sourceDb.db.select().from(portableSchema.portableExports);
    expect(row?.sha256).toMatch(/^[a-f0-9]{64}$/);
    if (!row?.sha256 || !row.size) throw new Error("no export receipt");
    expect(row.counts).toMatchObject({ customers: 1, orders: 1, order_items: 1, files: 1, file_versions: 1, objects: 1 });
    await inPrivateWorkspace(async (dir) => {
      const localPath = `${dir}/fixture.rpkg`;
      await copyExact(source.storage, row.storageKey, localPath, { size: row.size!, sha256: row.sha256! });
      const pkg = await openPackage({ input: localPath, passphrase: PASSPHRASE });
      try {
        const report = await pkg.verify();
        expect(report.ok).toBe(true);
        const records = await collect(pkg.allRecords());
        expect(records.find((entry) => entry.type === "orders")?.record).toMatchObject({
          subtotal: { amountMinor: OFFERING_PRICE.subtotalMinor, currency: "USD" },
          discount: { amountMinor: OFFERING_PRICE.discountMinor, currency: "USD" },
          discountLabel: OFFERING_PRICE.discountLabel, total: { amountMinor: OFFERING_PRICE.totalMinor, currency: "USD" },
          promoDiscount: { amountMinor: OFFERING_PRICE.promoDiscountMinor, currency: "USD" }, promoLabel: OFFERING_PRICE.promoLabel,
        });
        expect(pkg.manifest.exclusions.map((entry) => entry.category)).toEqual(expect.arrayContaining(["promotions", "cart-upsell-offers", "security-operations", "policy-notices", "report-definitions",
          "ephemeral-access", "phase-workspace", "operational-diagnostics", "installation-configuration"]));
        expect(records.find((entry) => entry.type === "order-items")?.record).toMatchObject({
          ...OFFERING_SNAPSHOT, tier: "standard", lineTotal: { amountMinor: OFFERING_PRICE.subtotalMinor, currency: "USD" },
        });
        const recordData = JSON.stringify(records);
        expect(recordData).not.toContain(AUTH_MARKER);
        expect(recordData).not.toContain(PASSPHRASE);
        // Auth material is checked by field name and record type. Matching the whole serialized text is unreliable:
        // random identifiers such as a customer number can spell "MFA" by chance.
        const fieldNames = new Set<string>();
        const collectFieldNames = (value: unknown): void => {
          if (Array.isArray(value)) { value.forEach(collectFieldNames); return; }
          if (value !== null && typeof value === "object") {
            for (const [name, child] of Object.entries(value)) { fieldNames.add(name); collectFieldNames(child); }
          }
        };
        collectFieldNames(records);
        const authMaterial = /password|mfa|session|storageKey/i;
        expect([...fieldNames].filter((name) => authMaterial.test(name))).toEqual([]);
        expect(records.map((entry) => entry.type).filter((type) => authMaterial.test(type))).toEqual([]);
        expect(Buffer.concat(await collect(await pkg.openObject(FILE_HASH) as AsyncIterable<Buffer>))).toEqual(PDF);
      } finally { await pkg.close(); }
    });
  });

  it("verifies and dry-plans, rolls back unaudited approval, resumes a lost fencing claim, and imports read-only orders/files", async () => {
    const admin = target.admins[0]!;
    const data = target.services.portable;
    const uploaded = await data.upload(admin, Readable.from(archive));
    const planned = await data.verifyAndPlan(admin, { importId: uploaded.importId, passphrase: PASSPHRASE });
    expect(planned.phase).toBe("planned");
    expect(planned.plan?.counts).toMatchObject({ creates: expect.any(Number), conflicts: 0, links: 0 });
    expect(await target.services.identity.getUserByPublicId(sourceCustomer.publicId)).toBeNull();
    expect(JSON.stringify(planned)).not.toContain(CUSTOMER_EMAIL);
    await expect(data.approve(admin, { importId: uploaded.importId, planDigest: "a".repeat(64) })).rejects.toMatchObject({ reasonCode: "PORTABLE_REVIEW_STALE" });
    target.audit.failRecords = true;
    await expect(data.approve(admin, { importId: uploaded.importId, planDigest: planned.planDigest! })).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    target.audit.failRecords = false;
    expect((await data.getImport(admin, uploaded.importId)).phase).toBe("planned");
    expect(target.jobs.enqueued).toHaveLength(0);
    const currentSession = vi.spyOn(target.services.identity.sessions, "assertCurrent").mockRejectedValueOnce(
      new DomainError("UNAUTHENTICATED", "SESSION_NOT_CURRENT", "Sign in again."),
    );
    try {
      await expect(data.approve(admin, { importId: uploaded.importId, planDigest: planned.planDigest! }))
        .rejects.toMatchObject({ reasonCode: "SESSION_NOT_CURRENT" });
      expect((await data.getImport(admin, uploaded.importId)).phase).toBe("planned");
      expect(target.jobs.enqueued).toHaveLength(0);
    } finally { currentSession.mockRestore(); }
    await expect(data.accept(admin, { importId: uploaded.importId, planDigest: planned.planDigest!, independentChecks: true }))
      .rejects.toMatchObject({ reasonCode: "PORTABLE_ACCEPTANCE_NOT_READY" });
    await data.approve(admin, { importId: uploaded.importId, planDigest: planned.planDigest! });
    const job = target.jobs.enqueued.find((entry) => entry.type === PORTABLE_IMPORT_JOB);
    const handler = target.jobs.handlers.get(PORTABLE_IMPORT_JOB);
    if (!handler || !job) throw new Error("missing import job");
    const lostClaim = new Error("Fixture claim lost");
    let fences = 0;
    await expect(handler({
      jobId: job.jobId, type: job.type, payload: job.payload as never, attempt: 1, fencingToken: 1,
      correlationId: uploaded.importId, signal: new AbortController().signal,
      assertStillOwned: async () => { fences += 1; if (fences === 4) throw lostClaim; },
    })).rejects.toBe(lostClaim);
    expect((await data.getImport(admin, uploaded.importId)).phase).toBe("approved");
    expect(await target.services.identity.getUserByPublicId(sourceCustomer.publicId)).toBeNull();
    const moveImpl = target.storage.move.bind(target.storage);
    const move = vi.spyOn(target.storage, "move");
    move.mockImplementationOnce(async function (from, to) {
      await moveImpl(from, to);
      throw new Error("Fixture interruption after private object move");
    });
    const recovered = (fence: number): Promise<JobResult> => handler({
      jobId: job.jobId, type: job.type, payload: job.payload as never, attempt: fence, fencingToken: fence,
      correlationId: uploaded.importId, signal: new AbortController().signal, assertStillOwned: async () => {},
    });
    await expect(recovered(2)).rejects.toThrow("Fixture interruption");
    expect((await data.getImport(admin, uploaded.importId)).phase).toBe("objects-prepared");
    expect(await targetDb.db.select().from(filesSchema.orderFiles)).toHaveLength(0);
    move.mockRestore();
    expect(await recovered(3)).toMatchObject({ outcome: "completed" });
    await target.jobs.runAll(PORTABLE_IMPORT_JOB);
    const detail = await data.getImport(admin, uploaded.importId);
    expect(detail.phase).toBe("reconciled");
    expect(detail.reconciliation).toMatchObject({ discrepancies: 0, objects: 1, verifiedObjects: 1 });
    expect(new Set(detail.steps.map((step) => step.operationId)).size).toBe(detail.steps.length);
    const imported = await target.services.identity.getUserByPublicId(sourceCustomer.publicId);
    expect(imported).toMatchObject({ email: CUSTOMER_EMAIL, status: "pending_activation", role: "customer", hasPassword: false, emailVerified: false, createdAt: CREATED });
    const [order] = await targetDb.db.select().from(ordersSchema.orders);
    expect(order).toMatchObject({ lockState: "imported_read_only", ownerUserId: imported?.id, ...OFFERING_PRICE, submittedAt: CREATED, createdAt: CREATED });
    const [line] = await targetDb.db.select().from(ordersSchema.orderLineItems);
    expect(line).toMatchObject({ orderId: order?.id, ...OFFERING_SNAPSHOT, lineTotalMinor: OFFERING_PRICE.subtotalMinor });
    const [file] = await targetDb.db.select().from(filesSchema.orderFiles);
    expect(file).toMatchObject({ ownerUserId: imported?.id, orderId: order?.id, sha256: FILE_HASH, createdAt: CREATED });
    if (!file || !order) throw new Error("missing target records");
    expect(await target.storage.get(file.storageKey).then(async (stream) => Buffer.concat(await collect(stream as AsyncIterable<Buffer>)))).toEqual(PDF);
    await expect(target.services.orders.assertCanReadOrder(fakePrincipal(), order.publicId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(data.accept(admin, { importId: uploaded.importId, planDigest: planned.planDigest!, independentChecks: true }))
      .rejects.toMatchObject({ reasonCode: "PORTABLE_ACCEPTANCE_NOT_READY" });
    expect((await data.accept(target.admins[1]!, { importId: uploaded.importId, planDigest: planned.planDigest!, independentChecks: true })).phase)
      .toBe("accepted");
  });

  it("reimports the exact same package as immutable links without creating customers, orders or files again", async () => {
    const admin = target.admins[0]!;
    const data = target.services.portable;
    const uploaded = await data.upload(admin, Readable.from(archive));
    const planned = await data.verifyAndPlan(admin, { importId: uploaded.importId, passphrase: PASSPHRASE });
    expect(planned.plan?.counts).toMatchObject({ creates: 0, conflicts: 0, links: expect.any(Number) });
    expect(planned.plan!.counts.links).toBeGreaterThan(2);
    await data.approve(admin, { importId: uploaded.importId, planDigest: planned.planDigest! });
    expect(await target.jobs.runAll(PORTABLE_IMPORT_JOB)).toEqual([expect.objectContaining({ outcome: "completed" })]);
    expect(await targetDb.db.select().from(ordersSchema.orders)).toHaveLength(1);
    expect(await targetDb.db.select().from(filesSchema.orderFiles)).toHaveLength(1);
  });

  it("passes real downstream session revalidation for a live import approver and refuses a revoked approval", async () => {
    const sessionDb = await createTestDb({ schema: testSchema });
    try {
      const env = await environment(sessionDb, "portable-real-sessions");
      const [revoked, live] = env.admins;
      if (!revoked || !live) throw new Error("Missing admin fixtures");
      const data = env.services.portable;
      const payload = archive ?? await capture();
      const queue = async (admin: SessionPrincipal) => {
        const uploaded = await data.upload(admin, Readable.from(payload));
        const planned = await data.verifyAndPlan(admin, { importId: uploaded.importId, passphrase: PASSPHRASE });
        await data.approve(admin, { importId: uploaded.importId, planDigest: planned.planDigest! });
        return uploaded.importId;
      };

      const revokedImport = await queue(revoked);
      await env.services.identity.sessions.revoke(revoked.sessionId, "test_revoked");
      expect(await env.jobs.runAll(PORTABLE_IMPORT_JOB)).toEqual([
        { outcome: "failed", reasonCode: "PORTABLE_APPLY_REFUSED", retryable: false },
      ]);
      expect(await data.getImport(live, revokedImport)).toMatchObject({ phase: "failed", state: "refused", reconciliation: null });
      expect(await sessionDb.db.select().from(ordersSchema.orders)).toHaveLength(0);
      expect(await sessionDb.db.select().from(filesSchema.orderFiles)).toHaveLength(0);

      const adopt = env.services.files.adoptVerifiedObject.bind(env.services.files);
      const recheck = vi.spyOn(env.services.files, "adoptVerifiedObject").mockImplementation(async (input, tx) => {
        await env.services.identity.sessions.assertCurrent(input.principal, tx);
        return adopt(input, tx);
      });
      try {
        const liveImport = await queue(live);
        expect(await env.jobs.runAll(PORTABLE_IMPORT_JOB)).toEqual([expect.objectContaining({ outcome: "completed" })]);
        expect((await data.getImport(live, liveImport)).phase).toBe("reconciled");
        expect(recheck).toHaveBeenCalledTimes(1);
        expect(await sessionDb.db.select().from(filesSchema.orderFiles)).toHaveLength(1);
      } finally {
        recheck.mockRestore();
      }
    } finally {
      await sessionDb.cleanup();
    }
  }, 20_000);

  it("refuses tampering before planning or writing business rows", async () => {
    const admin = target.admins[0]!;
    const data = target.services.portable;
    const bytes = Buffer.from(archive);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    const uploaded = await data.upload(admin, Readable.from(bytes));
    await expect(data.verifyAndPlan(admin, { importId: uploaded.importId, passphrase: PASSPHRASE })).rejects.toMatchObject({
      reasonCode: "PORTABLE_VERIFICATION_REFUSED",
    });
    expect(await data.getImport(admin, uploaded.importId)).toMatchObject({ phase: "failed", state: "refused", plan: null });
    expect(await targetDb.db.select().from(ordersSchema.orders)).toHaveLength(1);
  });

  it("refuses email-based linking to an existing account in a different package and blocks unauthorized actions", async () => {
    const admin = target.admins[0]!;
    const data = target.services.portable;
    const newPackage = await capture();
    const uploaded = await data.upload(admin, Readable.from(newPackage));
    const planned = await data.verifyAndPlan(admin, { importId: uploaded.importId, passphrase: PASSPHRASE });
    expect(planned.plan?.samples).toContainEqual(expect.objectContaining({ disposition: "conflict", reason: "PORTABLE_EMAIL_COLLISION" }));
    await expect(data.approve(admin, { importId: uploaded.importId, planDigest: planned.planDigest! }))
      .rejects.toMatchObject({ reasonCode: "PORTABLE_PLAN_CONFLICTS" });
    await expect(data.listImports(fakePrincipal({ role: "staff" }), {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(data.upload({ ...admin, stepUpAt: null }, Readable.from(newPackage))).rejects.toMatchObject({ code: "STEP_UP_REQUIRED" });
    await expect(data.getImport({ ...admin, state: "remediation", pendingSteps: ["enroll_mfa"] }, uploaded.importId))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await targetDb.db.select().from(ordersSchema.orders)).toHaveLength(1);
  });

  it("includes standalone profiles only for all-records scope while selected customers include their orders", async () => {
    await sourceDb.db.transaction((tx) => source.services.identity.createPendingCustomer({
      email: "standalone@example.test", name: "Standalone customer",
    }, { tx }));
    const admin = source.admins[0]!;
    const service = source.services.portable;
    const selected = await service.startExport(admin, { selection: { kind: "customers", ids: [sourceCustomer.publicId] }, passphrase: PASSPHRASE });
    expect(selected.counts).toMatchObject({ customers: 1, orders: 1, files: 1 });
    const all = await service.startExport(admin, { selection: { kind: "all" }, passphrase: PASSPHRASE });
    expect(all.counts).toMatchObject({ customers: 2, orders: 1, files: 1 });
    expect(await source.jobs.runAll(PORTABLE_EXPORT_JOB)).toEqual([
      expect.objectContaining({ outcome: "completed" }), expect.objectContaining({ outcome: "completed" }),
    ]);
    source.clock.advance(24 * 60 * 60_000 + 1);
    await expect(service.openExport({ ...admin, stepUpAt: source.clock.now() }, all.exportId))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    const [artifact] = await sourceDb.db.select().from(portableSchema.portableExports)
      .where(eq(portableSchema.portableExports.publicId, all.exportId));
    if (!artifact) throw new Error("Missing expiry fixture");
    const retention = source.jobs.handlers.get(PORTABLE_RETENTION_JOB);
    if (!retention) throw new Error("Missing expiry handler");
    const prune = () => retention({
      jobId: ulid(), type: PORTABLE_RETENTION_JOB, payload: {} as never, attempt: 1, fencingToken: 1,
      correlationId: all.exportId, signal: new AbortController().signal, assertStillOwned: async () => {},
    });
    source.audit.failRecords = true;
    try {
      await expect(prune()).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
      expect(await source.storage.stat(artifact.storageKey)).not.toBeNull();
    } finally { source.audit.failRecords = false; }
    expect(await prune()).toMatchObject({ outcome: "completed" });
    expect(await source.storage.stat(artifact.storageKey)).toBeNull();
  });

  it("preflights exact line totals, current workflow status, and normalized intra-package customer collisions", async () => {
    const customerId = ulid();
    const orderId = ulid();
    const amount = (amountMinor: number) => ({ amountMinor, currency: "USD" });
    const customer = { publicId: customerId, email: "unique.preflight@example.test", preferredName: "Plan fixture", createdAt: null };
    const order = { publicId: orderId, customerPublicId: customerId, status: "submitted",
      subtotal: amount(2500), discount: amount(0), total: amount(2500),
      projectName: "Fixture", orderNumber: "RP-42", currency: "USD", createdAt: CREATED.toISOString() };
    const item = { publicId: ulid(), orderPublicId: orderId, name: "Fixture", sku: "item", quantity: 2, unitPrice: amount(1250), lineTotal: amount(2500) };
    const run = (records: PortableInputRecord[]) => buildPlan(target.deps, {
      inputSha256: "a".repeat(64), manifestSha256: "b".repeat(64), packageId: ulid(),
      sourceSystem: "preflight-source", records, objects: [],
    });
    const wrongMath = await run([
      { type: "customers", record: customer }, { type: "orders", record: order },
      { type: "order-items", record: { ...item, lineTotal: amount(2200) } },
    ]);
    expect(wrongMath.summary.samples).toContainEqual(expect.objectContaining({ reason: "PORTABLE_IMPORT_LINE_TOTAL_MISMATCH" }));
    const wrongDiscount = await run([
      { type: "customers", record: customer }, { type: "orders", record: { ...order, discount: amount(375) } },
      { type: "order-items", record: item },
    ]);
    expect(wrongDiscount.summary.samples).toContainEqual(expect.objectContaining({ reason: "PORTABLE_IMPORT_TOTAL_MISMATCH" }));
    const unknownStatus = await run([
      { type: "customers", record: customer }, { type: "orders", record: { ...order, status: "unrecognized" } },
      { type: "order-items", record: item },
    ]);
    expect(unknownStatus.summary.samples).toContainEqual(expect.objectContaining({ reason: "PORTABLE_ORDER_STATUS_UNSUPPORTED" }));
    const duplicate = await run([
      { type: "customers", record: customer },
      { type: "customers", record: { ...customer, publicId: ulid(), email: customer.email.toUpperCase() } },
    ]);
    expect(duplicate.summary.counts.conflicts).toBe(2);
    expect(duplicate.summary.samples.every((sample) => sample.reason === "PORTABLE_DUPLICATE_CUSTOMER_IDENTIFIERS")).toBe(true);
    expect(await targetDb.db.select().from(ordersSchema.orders)).toHaveLength(1);
  });

  it("does not invent a packet number for an older record that only carried a tier token", () => {
    const money = { amountMinor: 2500, currency: "USD" };
    const order = { publicId: ulid(), projectName: "Legacy fixture", status: "submitted", orderNumber: "RP-42",
      currency: "USD", subtotal: money, discount: { ...money, amountMinor: 0 }, total: money, createdAt: CREATED.toISOString() };
    const line = { publicId: ulid(), name: "Legacy item", sku: "legacy-item", quantity: 1, unitPrice: money, lineTotal: money,
      tier: "standard" };
    const projected = projectedOrder(order, [line], []);
    expect(projected).toMatchObject({ discountLabel: null, promoDiscountMinor: 0, promoLabel: null, lineItems: [{ tier: null }] });
    const discounted = { ...order, discount: { ...money, amountMinor: 300 }, total: { ...money, amountMinor: 2200 } };
    expect(projectedOrder({ ...discounted, promoDiscount: { ...money, amountMinor: 300 }, promoLabel: "Spring code" }, [line], []))
      .toMatchObject({ discountMinor: 300, promoDiscountMinor: 300, promoLabel: "Spring code" });
    expect(() => projectedOrder({ ...discounted, promoDiscount: { ...money, amountMinor: 301 } }, [line], []))
      .toThrow("VALIDATION:PORTABLE_TARGET_POLICY");
    expect(() => projectedOrder({ ...discounted, promoDiscount: { amountMinor: 100, currency: "EUR" } }, [line], []))
      .toThrow("VALIDATION:PORTABLE_TARGET_POLICY");
    expect(() => projectedOrder({ ...discounted, promoDiscount: { ...money, amountMinor: 100 }, promoLabel: "x".repeat(121) }, [line], []))
      .toThrow("VALIDATION:PORTABLE_TARGET_POLICY");
    expect(projected.lineItems[0]?.packetNumber).toBeUndefined();
    expect(() => projectedOrder(order, [{ ...line, packetNumber: 2, tier: "unrecognized" }], []))
      .toThrow("VALIDATION:PORTABLE_TARGET_POLICY");
  });
});

describe("imported order on a format-3 workflow (increment 07, no phase-workspace rows travel)", () => {
  it("opens the phase workspace with no order_stage_progress rows and derives the current phase and progress", async () => {
    const db = await createTestDb({ schema: ordersTestSchema });
    try {
      const h = createTestDeps({ db: db.db });
      const mod = createOrdersModule(h.deps);
      Object.assign(h.services, { orders: mod, identity: fakeIdentity(h, db.db) });
      const admin = await insertUser(h, db.db, { role: "admin", stepUp: true });
      const customer = await insertUser(h, db.db);
      const [{ id: workflowId }] = (await db.db.insert(ordersSchema.orderWorkflows).values({
        publicId: ulid(), workflowKey: "synthetic_phased", name: "Synthetic phased", isDefault: true,
      }).$returningId()) as [{ id: number }];
      const [{ id: workflowVersionId }] = (await db.db.insert(ordersSchema.orderWorkflowVersions).values({
        publicId: ulid(), workflowId, versionNumber: 1, createdByUserId: admin.id,
        definition: workflowDefinitionSchema.parse({
          states: [
            { key: "start", label: "Intake", customerLabel: "Intake", kind: "initial", tone: "neutral" },
            { key: "middle", label: "Review", customerLabel: "Review", kind: "active", tone: "neutral" },
            { key: "finish", label: "Finished", customerLabel: "Finished", kind: "terminal", tone: "success" },
          ],
          transitions: [
            { from: "start", to: "middle", allowedBy: ["staff", "admin"], notifyCustomer: false },
            { from: "middle", to: "finish", allowedBy: ["staff", "admin"], notifyCustomer: false },
          ],
          stages: [
            { key: "intake", customerLabel: "Intake", staffLabel: "Intake", statusKeys: ["start"], actions: {} },
            { key: "review", customerLabel: "Review", staffLabel: "Review", statusKeys: ["middle"], actions: {} },
            { key: "delivery", customerLabel: "Delivery", staffLabel: "Delivery", statusKeys: ["finish"], actions: {} },
          ],
        }),
      }).$returningId()) as [{ id: number }];
      await db.db.update(ordersSchema.orderWorkflows).set({ currentVersionId: workflowVersionId }).where(eq(ordersSchema.orderWorkflows.id, workflowId));
      const imported = await db.db.transaction((tx) => mod.importOrder({
        importId: ulid(), sourceInstallationId: "synthetic-source-fixture", sourceOrderPublicId: ulid(),
        targetOwnerUserId: customer.id, projectName: "Synthetic imported order", statusKey: "middle",
        ...OFFERING_PRICE, currency: "USD", createdAt: CREATED, submittedAt: CREATED, editable: false,
        lineItems: [{ sourcePublicId: ulid(), productPublicId: null, productVersion: null, name: "Fixture line",
          description: "", features: [], ...OFFERING_SNAPSHOT, unitPriceMinor: 2500, currency: "USD", quantity: 1, lineTotalMinor: 2500 }],
        statusHistory: [{ sourcePublicId: ulid(), fromStatus: null, toStatus: "middle", actorRole: "system", reasonCode: "SOURCE_FIXTURE", occurredAt: CREATED }],
      }, tx));
      const [row] = await db.db.select().from(ordersSchema.orders).where(eq(ordersSchema.orders.id, imported.id));
      expect(row).toMatchObject({ workflowVersionId, statusKey: "middle", progressPercent: null, attention: "none", paymentState: "not_required" });
      const progressRows = () => db.db.select().from(ordersSchema.orderStageProgress).where(eq(ordersSchema.orderStageProgress.orderId, imported.id));
      expect(await progressRows()).toHaveLength(0);
      const caller = createCallerFactory(ordersRouter)({ services: h.services, session: customer.principal, request: newRequestContext("test"), transport: { issue() {}, clear() {} } });
      const workspace = await caller.stages.workspace({ orderId: imported.publicId });
      expect(workspace.workflowFormat).toBe(3);
      expect(workspace.currentStageKey).toBe("review");
      expect(workspace.progress.percent).toBeGreaterThan(0);
      expect(workspace.stages.map((stage) => stage.state)).toEqual([expect.not.stringMatching(/future/), expect.not.stringMatching(/future/), "future"]);
    } finally {
      await db.cleanup();
    }
  }, 20_000);
});

describe("increment 08: name parts, saved billing profile and order groups", () => {
  const BILLING = {
    fullName: "Zeus Greene", company: "Ice Queen Studio", email: "billing.zeus@example.test", country: "US", region: "CA",
    addressLine1: "1 Example Way", addressLine2: "", city: "Sampletown", postalCode: "90000", taxId: "",
  };
  const line = (packetNumber: number) => ({
    sourcePublicId: ulid(), productPublicId: null, productVersion: null, name: `Packet ${packetNumber}`, description: "",
    features: [], packetNumber, tier: "Standard" as const, outcome: "Outcome", timeline: "Five business days",
    deliverables: [{ title: "Summary", detail: "Findings" }], unitPriceMinor: 1000, currency: "USD", quantity: 1, lineTotalMinor: 1000,
  });

  it("exports the whole group for one selected addition and imports parts, billing profile and the group link", async () => {
    const sourceDb = await createTestDb({ schema: testSchema });
    const targetDb = await createTestDb({ schema: testSchema });
    try {
      const source = await environment(sourceDb, "inc08-source");
      const target = await environment(targetDb, "inc08-target");
      const customer = await sourceDb.db.transaction((tx) => source.services.identity.createPendingCustomer({
        email: "zeus.greene@example.test", name: "Zeus Greene", createdAt: CREATED,
        nameParts: { firstName: "Zeus", lastName: "Greene", preferredName: "Zed" },
      }, { tx }));
      await sourceDb.db.transaction((tx) => source.services.billingProfile.saveForUserInTx(tx, customer.userId, BILLING,
        { userId: null, role: "system", via: "portable_import" }));
      const order = (packetNumber: number, groupRootOrderId: number | null) => sourceDb.db.transaction((tx) => source.services.orders.importOrder({
        importId: ulid(), sourceInstallationId: "inc08-fixture", sourceOrderPublicId: ulid(), targetOwnerUserId: customer.userId,
        projectName: "Ice Queen", statusKey: "submitted", subtotalMinor: 1000, discountMinor: 0, discountLabel: null, totalMinor: 1000,
        promoDiscountMinor: 0, promoLabel: null, currency: "USD", createdAt: CREATED, submittedAt: CREATED, editable: false,
        lineItems: [line(packetNumber)], statusHistory: [], groupRootOrderId,
      }, tx));
      const root = await order(1, null);
      const addition = await order(2, root.id);

      const admin = source.admins[0]!;
      const started = await source.services.portable.startExport(admin, { selection: { kind: "orders", ids: [addition.publicId] }, passphrase: PASSPHRASE });
      expect(started.counts).toMatchObject({ customers: 1, orders: 2 });
      expect(await source.jobs.runAll(PORTABLE_EXPORT_JOB)).toEqual([expect.objectContaining({ outcome: "completed" })]);
      const opened = await source.services.portable.openExport(admin, started.exportId);
      const payload = Buffer.concat(await collect(opened.stream as AsyncIterable<Buffer>));
      await opened.finish("completed");

      await inPrivateWorkspace(async (dir) => {
        const [row] = await sourceDb.db.select().from(portableSchema.portableExports);
        if (!row?.sha256 || !row.size) throw new Error("no export receipt");
        await copyExact(source.storage, row.storageKey, `${dir}/inc08.rpkg`, { size: row.size, sha256: row.sha256 });
        const pkg = await openPackage({ input: `${dir}/inc08.rpkg`, passphrase: PASSPHRASE });
        try {
          expect((await pkg.verify()).ok).toBe(true);
          const records = await collect(pkg.allRecords());
          const orders = records.filter((entry) => entry.type === "orders").map((entry) => entry.record as Record<string, unknown>);
          const exportedRoot = orders.find((entry) => entry.publicId === root.publicId);
          expect(exportedRoot).toBeDefined();
          expect(exportedRoot).not.toHaveProperty("groupRootOrderPublicId");
          expect(orders.find((entry) => entry.publicId === addition.publicId)).toMatchObject({ groupRootOrderPublicId: root.publicId });
          expect(records.find((entry) => entry.type === "customers")?.record).toMatchObject({
            firstName: "Zeus", lastName: "Greene", preferredName: "Zed", billingProfile: BILLING,
          });
        } finally { await pkg.close(); }
      });

      const data = target.services.portable;
      const targetAdmin = target.admins[0]!;
      const uploaded = await data.upload(targetAdmin, Readable.from(payload));
      const planned = await data.verifyAndPlan(targetAdmin, { importId: uploaded.importId, passphrase: PASSPHRASE });
      expect(planned.plan?.counts).toMatchObject({ conflicts: 0 });
      await data.approve(targetAdmin, { importId: uploaded.importId, planDigest: planned.planDigest! });
      expect(await target.jobs.runAll(PORTABLE_IMPORT_JOB)).toEqual([expect.objectContaining({ outcome: "completed" })]);
      expect((await data.getImport(targetAdmin, uploaded.importId)).reconciliation).toMatchObject({ discrepancies: 0 });

      const imported = await target.services.identity.getUserByPublicId(customer.publicId);
      if (!imported) throw new Error("customer not imported");
      expect(imported.name).toBe("Zeus Greene");
      expect(await target.services.identity.users.namePartsInTx(targetDb.db, imported.id))
        .toMatchObject({ firstName: "Zeus", lastName: "Greene", preferredName: "Zed" });
      expect((await target.services.billingProfile.getForUserInTx(targetDb.db, imported.id))?.details).toEqual(BILLING);
      const rows = await targetDb.db.select().from(ordersSchema.orders);
      const targetRoot = rows.find((entry) => entry.reference === root.reference);
      const targetAddition = rows.find((entry) => entry.reference === addition.reference);
      expect(targetRoot?.groupRootOrderId).toBeNull();
      expect(targetAddition?.groupRootOrderId).toBe(targetRoot?.id);
    } finally {
      await Promise.all([sourceDb.cleanup(), targetDb.cleanup()]);
    }
  }, 40_000);

  it("keeps older records working and refuses inconsistent group links and invalid billing profiles", () => {
    const customerId = ulid();
    // Increment 07 and older exports: display name in preferredName, no parts, no billing profile.
    expect(customerIdentity({ publicId: customerId, firstName: null, lastName: null, preferredName: "Legacy Display Name" }))
      .toEqual({ name: "Legacy Display Name" });
    expect(customerBillingProfile({ publicId: customerId })).toBeNull();
    expect(customerIdentity({ publicId: customerId, firstName: "Zeus", lastName: "Greene", preferredName: null }))
      .toEqual({ name: "Zeus Greene", nameParts: { firstName: "Zeus", lastName: "Greene", preferredName: null } });
    expect(() => customerIdentity({ publicId: customerId, firstName: "Zeus", lastName: "<b>", preferredName: null })).toThrow();
    expect(() => customerBillingProfile({ publicId: customerId, billingProfile: { ...BILLING, country: "USA" } })).toThrow();

    const rootId = ulid();
    const root = { publicId: rootId, customerPublicId: customerId, currency: "USD" };
    const addition = { publicId: ulid(), customerPublicId: customerId, currency: "USD", groupRootOrderPublicId: rootId };
    const byId = (...records: Array<Record<string, unknown> & { publicId: string }>) => new Map(records.map((entry) => [entry.publicId, entry]));
    expect(groupLinkProblem(root, byId(root, addition))).toBeNull();
    expect(groupLinkProblem({ ...root, groupRootOrderPublicId: null }, byId(root))).toBeNull();
    expect(groupLinkProblem(addition, byId(root, addition))).toBeNull();
    expect(groupLinkProblem(addition, byId(addition))).toBe("PORTABLE_ORDER_GROUP_ROOT_MISSING");
    expect(groupLinkProblem({ ...addition, groupRootOrderPublicId: addition.publicId }, byId(root, addition))).toBe("PORTABLE_ORDER_GROUP_INVALID");
    expect(groupLinkProblem(addition, byId({ ...root, currency: "EUR" }, addition))).toBe("PORTABLE_ORDER_GROUP_INVALID");
    expect(groupLinkProblem(addition, byId({ ...root, customerPublicId: ulid() }, addition))).toBe("PORTABLE_ORDER_GROUP_INVALID");
    expect(groupLinkProblem(addition, byId({ ...root, groupRootOrderPublicId: ulid() }, addition))).toBe("PORTABLE_ORDER_GROUP_INVALID");
  });
});
