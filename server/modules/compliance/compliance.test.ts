import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RECORD_SCHEMAS, referencesOf } from "../../../portable/src/index.js";
import { DomainError, forbidden, notFound } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { newRequestContext, runWithRequestContext } from "../../core/requestContext.js";
import type { Db, DbOrTx, SessionPrincipal } from "../../core/types.js";
import { users } from "../identity/schema.js";
import type { OrderAccessRole, OrderAccessView, OrderLockState, OrdersModule } from "../orders/index.js";
import { createTestDeps, fakePrincipal } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { computeInvoiceTotals, validateIntakeAnswers } from "./domain.js";
import { createAcceptanceLogService } from "./acceptanceLogService.js";
import { createComplianceModule } from "./index.js";
import { complianceRouter } from "./router.js";
import * as complianceSchema from "./schema.js";

interface FakeOrderRecord {
  id: number;
  publicId: string;
  reference: string;
  ownerUserId: number;
  ownerPublicId: string;
  lockState: OrderLockState;
  origin: "portal" | "import";
  productPublicIds: string[];
  workflowKey?: string;
  statusKey?: string;
  discountMinor?: number;
  discountLabel?: string | null;
  promoDiscountMinor?: number;
  promoLabel?: string | null;
  bundleDiscountMinor?: number;
  grants: Map<number, "contributor" | "viewer">;
}

function buildFakeOrdersModule(ordersByPubId: Map<string, FakeOrderRecord>): OrdersModule {
  const byId = () => {
    const m = new Map<number, FakeOrderRecord>();
    for (const o of ordersByPubId.values()) m.set(o.id, o);
    return m;
  };

  function resolveRole(principal: SessionPrincipal, order: FakeOrderRecord): OrderAccessRole | null {
    if (principal.role === "admin") return "admin";
    if (principal.role === "staff") return "staff";
    if (order.ownerUserId === principal.userId) return "owner";
    return order.grants.get(principal.userId) ?? null;
  }

  function toAccessView(order: FakeOrderRecord, role: OrderAccessRole): OrderAccessView {
    return {
      id: order.id,
      publicId: order.publicId,
      reference: order.reference,
      ownerUserId: order.ownerUserId,
      ownerPublicId: order.ownerPublicId,
      statusKey: order.statusKey ?? "in_progress",
      lockState: order.lockState,
      locked: order.lockState !== "none",
      readOnlyImported: order.origin === "import" || order.lockState === "imported_read_only",
      accessRole: role,
      canWrite: order.lockState === "none" && order.origin === "portal" && role !== "viewer",
      origin: order.origin,
      version: 1,
      workflowVersionId: 1,
      ...(order.discountMinor !== undefined ? { discountMinor: order.discountMinor } : {}),
      ...(order.discountLabel !== undefined ? { discountLabel: order.discountLabel } : {}),
      ...(order.promoDiscountMinor !== undefined
        ? { promoDiscountMinor: order.promoDiscountMinor }
        : {}),
      ...(order.promoLabel !== undefined ? { promoLabel: order.promoLabel } : {}),
      ...(order.bundleDiscountMinor !== undefined
        ? { bundleDiscountMinor: order.bundleDiscountMinor }
        : {}),
    };
  }

  async function assertCanReadOrder(principal: SessionPrincipal, orderPublicId: string): Promise<OrderAccessView> {
    if (principal.state !== "full" || principal.pendingSteps.length > 0) throw notFound("ORDER_NOT_FOUND");
    const order = ordersByPubId.get(orderPublicId);
    if (!order) throw notFound("ORDER_NOT_FOUND");
    const role = resolveRole(principal, order);
    if (!role) throw notFound("ORDER_NOT_FOUND");
    return toAccessView(order, role);
  }

  return {
    assertCanReadOrder,
    async assertCanWriteOrder(
      principal: SessionPrincipal,
      orderPublicId: string,
      options: { kind?: string; tx?: DbOrTx; forUpdate?: boolean },
    ) {
      const view = await assertCanReadOrder(principal, orderPublicId);
      const order = ordersByPubId.get(orderPublicId)!;

      // Mirror orders/API.md §1 access & lock rules
      if (options.kind === "invoice") {
        if (view.accessRole !== "staff" && view.accessRole !== "admin") {
          throw notFound("ORDER_NOT_FOUND");
        }
        if (order.lockState === "legal_hold" || order.lockState === "imported_read_only" || order.origin === "import") {
          throw new DomainError("LOCKED", "ORDER_LOCKED", "Order is locked.");
        }
        // Note: `finalized` explicitly ALLOWS staff `invoice` writes per orders/API.md §1!
        return view;
      }

      if (options.kind === "intake") {
        if (view.accessRole === "viewer") {
          throw notFound("ORDER_NOT_FOUND");
        }
        if (order.lockState !== "none" || order.origin === "import") {
          throw new DomainError("LOCKED", "ORDER_LOCKED", "Order is locked.");
        }
        return view;
      }

      if (view.accessRole === "viewer") throw forbidden("READ_ONLY_GRANT");
      if (order.lockState !== "none") throw new DomainError("LOCKED", "ORDER_LOCKED", "Order is locked.");
      return view;
    },
    async listAccessibleOrderIds(principal: SessionPrincipal) {
      if (principal.role === "admin" || principal.role === "staff") return { all: true };
      const ids: number[] = [];
      for (const o of ordersByPubId.values()) {
        if (o.ownerUserId === principal.userId || o.grants.has(principal.userId)) {
          ids.push(o.id);
        }
      }
      return { all: false, orderIds: ids, truncated: false };
    },
    async getOrderRefById(orderId: number, _tx?: DbOrTx) {
      const o = byId().get(orderId);
      if (!o) return null;
      return {
        id: o.id,
        publicId: o.publicId,
        reference: o.reference,
        name: o.reference,
        ownerUserId: o.ownerUserId,
        lockState: o.lockState,
        statusKey: o.statusKey ?? "in_progress",
        workflowVersionId: 1,
      };
    },
    async getOrderRefByPublicId(orderPublicId: string, _tx?: DbOrTx) {
      const o = ordersByPubId.get(orderPublicId);
      if (!o) return null;
      return {
        id: o.id,
        publicId: o.publicId,
        reference: o.reference,
        name: o.reference,
        ownerUserId: o.ownerUserId,
        lockState: o.lockState,
        statusKey: o.statusKey ?? "in_progress",
        workflowVersionId: 1,
      };
    },
    async searchOrders(_principal: SessionPrincipal, query: string, limit = 20) {
      const q = query.trim().toUpperCase();
      return Array.from(ordersByPubId.values())
        .filter((o) => o.publicId === query.trim() || o.reference.toUpperCase().startsWith(q))
        .slice(0, limit)
        .map((o) => ({
          publicId: o.publicId,
          reference: o.reference,
          projectName: o.reference,
          statusLabel: o.statusKey ?? "in_progress",
          updatedAt: new Date("2026-11-20T12:00:00.000Z"),
        }));
    },
    workflows: {
      async byVersionId() {
        return {
          id: 1,
          workflowId: 1,
          workflowKey: "standard",
          versionNumber: 1,
          definition: {
            initialStateKey: "in_progress",
            states: [
              { key: "in_progress", label: "In Progress", kind: "active", tone: "info" },
              { key: "cancelled", label: "Cancelled", kind: "terminal", tone: "danger" },
            ],
            transitions: [],
          },
        };
      },
    },
    async portableOrders(_tx: DbOrTx, sel: { limit: number; orderIds?: number[] }) {
      const targetIds = sel.orderIds ? new Set(sel.orderIds) : null;
      const items = Array.from(ordersByPubId.values())
        .filter((o) => (targetIds ? targetIds.has(o.id) : true))
        .slice(0, sel.limit)
        .map((o) => ({
          id: o.id,
          publicId: o.publicId,
          reference: o.reference,
          retiredReferences: [],
          ownerUserId: o.ownerUserId,
          projectName: o.reference,
          statusKey: "in_progress",
          workflowKey: o.workflowKey ?? "standard",
          lockState: o.lockState,
          totalMinor: 1000,
          currency: "USD",
          createdAt: new Date("2026-11-20T12:00:00.000Z"),
          updatedAt: new Date("2026-11-20T12:00:00.000Z"),
          submittedAt: new Date("2026-11-20T12:00:00.000Z"),
          lineItems: o.productPublicIds.map((pid, idx) => ({
            publicId: ulid(1_700_000_000_000 + idx),
            productPublicId: pid,
            productVersion: 1,
            name: "Item",
            description: "",
            features: [],
            unitPriceMinor: 1000,
            currency: "USD",
            quantity: 1,
            lineTotalMinor: 1000,
          })),
          statusHistory: [],
          customerNotes: [],
        }));
      return { items, nextAfter: null };
    },
    gates: {
      async assertCustomerMayWork() {},
    },
    orders: {
      async get(principal: SessionPrincipal, orderPublicId: string) {
        const o = ordersByPubId.get(orderPublicId);
        if (!o) throw notFound("ORDER_NOT_FOUND");
        const role = resolveRole(principal, o);
        if (!role) throw notFound("ORDER_NOT_FOUND");
        return {
          lineItems: o.productPublicIds.map((pid, idx) => ({
            publicId: ulid(1_700_000_000_000 + idx),
            productPublicId: pid,
            productVersion: 1,
            name: "Item",
            description: "",
            features: [],
            unitPriceMinor: 1000,
            currency: "USD",
            quantity: 1,
            lineTotalMinor: 1000,
          })),
        };
      },
    },
  } as unknown as OrdersModule;
}

describe("compliance module — policies, intake, invoices, portable evidence & security invariants", () => {
  let tdb: TestDb;
  let adminPrincipal: SessionPrincipal;
  let staffPrincipal: SessionPrincipal;
  let customerAPrincipal: SessionPrincipal;
  let customerBPrincipal: SessionPrincipal;
  let viewerPrincipal: SessionPrincipal;
  let orderA: FakeOrderRecord;
  let orderB: FakeOrderRecord;
  const ordersMap = new Map<string, FakeOrderRecord>();

  beforeAll(async () => {
    tdb = await createTestDb({
      schema: {
        users,
        ...complianceSchema,
      },
    });

    const now = new Date("2026-11-20T12:00:00.000Z");
    const seedUsers = [
      { key: "admin", role: "admin" as const, email: "admin@example.test", name: "Alice Admin" },
      { key: "staff", role: "staff" as const, email: "staff@example.test", name: "Sam Staff" },
      { key: "custA", role: "customer" as const, email: "custa@example.test", name: "Clara Customer" },
      { key: "custB", role: "customer" as const, email: "custb@example.test", name: "Bob Other" },
      { key: "viewer", role: "customer" as const, email: "viewer@example.test", name: "Vera Viewer" },
    ];

    const inserted: Record<string, { id: number; publicId: string; name: string; email: string; role: "customer" | "staff" | "admin" }> = {};
    for (const [idx, u] of seedUsers.entries()) {
      const pubId = ulid(now.getTime() + idx * 10);
      const [res] = await tdb.db.insert(users).values({
        publicId: pubId,
        emailEnc: `enc:${u.email}`,
        emailIndex: `${idx + 1}`.padStart(64, "a"),
        nameEnc: `enc:${u.name}`,
        role: u.role,
        status: "active",
        emailVerifiedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      inserted[u.key] = { id: res.insertId, publicId: pubId, name: u.name, email: u.email, role: u.role };
    }

    adminPrincipal = fakePrincipal({
      userId: inserted.admin!.id,
      userPublicId: inserted.admin!.publicId,
      role: "admin",
      stepUpAt: now,
    });
    staffPrincipal = fakePrincipal({
      userId: inserted.staff!.id,
      userPublicId: inserted.staff!.publicId,
      role: "staff",
      stepUpAt: now,
    });
    customerAPrincipal = fakePrincipal({
      userId: inserted.custA!.id,
      userPublicId: inserted.custA!.publicId,
      role: "customer",
    });
    customerBPrincipal = fakePrincipal({
      userId: inserted.custB!.id,
      userPublicId: inserted.custB!.publicId,
      role: "customer",
    });
    viewerPrincipal = fakePrincipal({
      userId: inserted.viewer!.id,
      userPublicId: inserted.viewer!.publicId,
      role: "customer",
    });

    orderA = {
      id: 501,
      publicId: ulid(now.getTime() + 1000),
      reference: "RP-2026-000501",
      ownerUserId: customerAPrincipal.userId,
      ownerPublicId: customerAPrincipal.userPublicId,
      lockState: "none",
      origin: "portal",
      productPublicIds: [],
      grants: new Map([[viewerPrincipal.userId, "viewer"]]),
    };
    orderB = {
      id: 502,
      publicId: ulid(now.getTime() + 2000),
      reference: "RP-2026-000502",
      ownerUserId: customerBPrincipal.userId,
      ownerPublicId: customerBPrincipal.userPublicId,
      lockState: "none",
      origin: "portal",
      productPublicIds: [],
      grants: new Map(),
    };
    ordersMap.set(orderA.publicId, orderA);
    ordersMap.set(orderB.publicId, orderB);
  }, 60_000);

  afterAll(async () => {
    if (tdb) await tdb.cleanup();
  });

  function makeHarness() {
    const h = createTestDeps({ db: tdb.db });
    h.services.orders = buildFakeOrdersModule(ordersMap);
    h.services.identity = {
      async getUser(userId: number) {
        if (userId === customerAPrincipal.userId) {
          return {
            id: customerAPrincipal.userId,
            publicId: customerAPrincipal.userPublicId,
            email: "custa@example.test",
            name: "Clara Customer",
            role: "customer" as const,
            status: "active" as const,
          };
        }
        if (userId === customerBPrincipal.userId) {
          return {
            id: customerBPrincipal.userId,
            publicId: customerBPrincipal.userPublicId,
            email: "custb@example.test",
            name: "Bob Other",
            role: "customer" as const,
            status: "active" as const,
          };
        }
        if (userId === adminPrincipal.userId) {
          return {
            id: adminPrincipal.userId,
            publicId: adminPrincipal.userPublicId,
            email: "admin@example.test",
            name: "Alice Admin",
            role: "admin" as const,
            status: "active" as const,
          };
        }
        if (userId === staffPrincipal.userId) {
          return {
            id: staffPrincipal.userId,
            publicId: staffPrincipal.userPublicId,
            email: "staff@example.test",
            name: "Sam Staff",
            role: "staff" as const,
            status: "active" as const,
          };
        }
        return null;
      },
    } as unknown as typeof h.services.identity;

    const notifications: unknown[] = [];
    h.services.engagement = {
      async notify(input: unknown) {
        notifications.push(input);
        return { delivered: true };
      },
    } as unknown as typeof h.services.engagement;

    const compliance = createComplianceModule(h.deps);
    h.services.compliance = compliance;
    return { h, compliance, notifications };
  }

  it("enforces immutable published policy versions, SHA-256 hash-bound acceptance, and re-acceptance when a new version is published", async () => {
    const { h, compliance } = makeHarness();

    // Create Terms v1.0 draft & publish
    const created = await compliance.policies.admin.createDocument(adminPrincipal, {
      slug: "terms-of-service",
      title: "Terms of Service",
      audience: "customer",
      requiresAcceptance: true,
      requiresTypedSignature: false,
      versionLabel: "1.0",
      contentFormat: "safe_markdown",
      bodyText: "# Terms of Service\n\nAll services are governed by these binding terms.",
    });

    // Draft can be updated before publishing
    const updatedDraft = await compliance.policies.admin.updateDraftVersion(adminPrincipal, {
      versionPublicId: created.draftVersionPublicId,
      versionLabel: "1.0",
      contentFormat: "safe_markdown",
      bodyText: "# Terms of Service v1.0\n\nUpdated draft text before publication.",
      effectiveAt: h.clock.now(),
    });

    const pubV1 = await compliance.policies.admin.publishVersion(adminPrincipal, {
      versionPublicId: created.draftVersionPublicId,
    });
    expect(pubV1.contentHash).toBe(updatedDraft.contentHash);

    // Published version CANNOT be edited or deleted!
    await expect(
      compliance.policies.admin.updateDraftVersion(adminPrincipal, {
        versionPublicId: created.draftVersionPublicId,
        versionLabel: "1.0-tampered",
        contentFormat: "safe_markdown",
        bodyText: "# Tampered Terms\n\nAttempting to rewrite published evidence.",
        effectiveAt: h.clock.now(),
      }),
    ).rejects.toMatchObject({ reasonCode: "POLICY_VERSION_IMMUTABLE" });

    await expect(
      compliance.policies.admin.deleteDraftVersion(adminPrincipal, created.draftVersionPublicId),
    ).rejects.toMatchObject({ reasonCode: "POLICY_VERSION_IMMUTABLE" });

    // Customer A is gated before accepting v1.0
    await expect(
      compliance.assertRequiredPoliciesAccepted(customerAPrincipal.userId),
    ).rejects.toMatchObject({ reasonCode: "POLICY_ACCEPTANCE_REQUIRED" });

    // Accepting with a mismatched SHA-256 contentHash fails closed
    await expect(
      compliance.policies.accept(customerAPrincipal, {
        versionPublicId: pubV1.versionPublicId,
        contentHash: "0".repeat(64),
        method: "portal_checkbox",
      }),
    ).rejects.toMatchObject({ reasonCode: "POLICY_HASH_MISMATCH" });

    // Accepting inside request context pseudonymizes IP (never stores raw IP) and passes exact hash check
    const reqCtx = newRequestContext("test");
    reqCtx.ipAddress = "203.0.113.42";
    const accV1 = await runWithRequestContext(reqCtx, () =>
      compliance.policies.accept(customerAPrincipal, {
        versionPublicId: pubV1.versionPublicId,
        contentHash: pubV1.contentHash,
        method: "portal_checkbox",
        orderPublicId: orderA.publicId,
      }),
    );
    expect(accV1.duplicate).toBe(false);

    // Verify DB never stores raw IP
    const [accRow] = await tdb.db
      .select()
      .from(complianceSchema.policyAcceptances)
      .where(eq(complianceSchema.policyAcceptances.publicId, accV1.acceptancePublicId));
    expect(accRow?.sourceAddressPseudonym).toHaveLength(32);
    expect(accRow?.sourceAddressPseudonym).not.toContain("203.0.113.42");
    expect(accRow?.versionContentHash).toBe(pubV1.contentHash);

    // Customer A now passes required policy gate
    await expect(
      compliance.assertRequiredPoliciesAccepted(customerAPrincipal.userId),
    ).resolves.toBeUndefined();

    // Admin creates a temporary draft v1.1 and deletes it — audit is recorded in tx BEFORE delete
    const tempDraft = await compliance.policies.admin.createDraftVersion(adminPrincipal, {
      documentPublicId: created.documentPublicId,
      versionLabel: "1.1-discard",
      contentFormat: "plain_text",
      bodyText: "Temporary draft version to verify safe draft deletion.",
    });
    h.audit.clear();
    await compliance.policies.admin.deleteDraftVersion(adminPrincipal, tempDraft.versionPublicId);
    expect(h.audit.named("policy.version.draft_deleted")).toHaveLength(1);
    expect(h.audit.recordedInTx[0]).toBe(true);

    // Admin publishes v2.0 -> Customer A MUST re-accept!
    h.clock.advance(60_000);
    const draftV2 = await compliance.policies.admin.createDraftVersion(adminPrincipal, {
      documentPublicId: created.documentPublicId,
      versionLabel: "2.0",
      contentFormat: "safe_markdown",
      bodyText: "# Terms of Service v2.0\n\nMaterial updates requiring fresh customer acceptance.",
    });
    const pubV2 = await compliance.policies.admin.publishVersion(adminPrincipal, {
      versionPublicId: draftV2.versionPublicId,
    });

    const pendingAfterV2 = await compliance.requiredAcceptancesFor(customerAPrincipal.userId);
    expect(pendingAfterV2.map((p) => p.versionPublicId)).toContain(pubV2.versionPublicId);
    await expect(
      compliance.assertRequiredPoliciesAccepted(customerAPrincipal.userId),
    ).rejects.toMatchObject({ reasonCode: "POLICY_ACCEPTANCE_REQUIRED" });

    // Customer A accepts v2.0 -> gate clears again, and both v1.0 & v2.0 remain in history
    await compliance.policies.accept(customerAPrincipal, {
      versionPublicId: pubV2.versionPublicId,
      contentHash: pubV2.contentHash,
      method: "portal_checkbox",
    });
    const status = await compliance.policies.myStatus(customerAPrincipal);
    expect(status.pendingRequired).toHaveLength(0);
    expect(status.acceptances.length).toBeGreaterThanOrEqual(2);
  });

  it("enforces typed signature matching and encrypts signer name at rest", async () => {
    const { compliance } = makeHarness();

    const mnda = await compliance.policies.admin.createDocument(adminPrincipal, {
      slug: "mutual-nda",
      title: "Mutual Non-Disclosure Agreement",
      audience: "customer",
      requiresAcceptance: true,
      requiresTypedSignature: true,
      versionLabel: "1.0",
      contentFormat: "plain_text",
      bodyText: "Confidential information disclosed by either party must be protected.",
    });
    const pubMnda = await compliance.policies.admin.publishVersion(adminPrincipal, {
      versionPublicId: mnda.draftVersionPublicId,
    });

    // Wrong signer name rejected
    await expect(
      compliance.policies.accept(customerAPrincipal, {
        versionPublicId: pubMnda.versionPublicId,
        contentHash: pubMnda.contentHash,
        method: "typed_signature",
        signerName: "Someone Else",
      }),
    ).rejects.toMatchObject({ reasonCode: "SIGNER_NAME_MISMATCH" });

    // Matching profile name ("Clara Customer") succeeds and encrypts at rest
    const res = await compliance.policies.accept(customerAPrincipal, {
      versionPublicId: pubMnda.versionPublicId,
      contentHash: pubMnda.contentHash,
      method: "typed_signature",
      signerName: "clara   customer",
    });
    const [row] = await tdb.db
      .select()
      .from(complianceSchema.policyAcceptances)
      .where(eq(complianceSchema.policyAcceptances.publicId, res.acceptancePublicId));
    expect(row?.signerNameEnc).toBeTruthy();
    expect(row?.signerNameEnc).not.toContain("clara");
    expect(row?.method).toBe("typed_signature");
  });

  it("validates intake questionnaires, blocks Object.prototype hazards, encrypts answers, preserves full revision history, and enforces order locks & negative authz", async () => {
    const { h, compliance, notifications } = makeHarness();

    // Prototype key safety unit check: omitted optional fields NEVER read Object.prototype
    const protoSafe = validateIntakeAnswers(
      [
        { key: "project_summary", label: "Summary", type: "short_text", required: false, sensitive: true },
      ],
      {},
      "draft",
    );
    expect(protoSafe).toEqual({ project_summary: null });
    expect(() =>
      validateIntakeAnswers(
        [{ key: "project_summary", label: "Summary", type: "short_text", required: false, sensitive: true }],
        { constructor: "evil" } as unknown as Record<string, string>,
        "draft",
      ),
    ).toThrow();

    // Admin creates & publishes an intake questionnaire covering all 6 field types
    const qCreated = await compliance.intake.admin.createQuestionnaire(adminPrincipal, {
      slug: "security-intake",
      title: "Security & Scope Intake",
      description: "Required project scoping questionnaire.",
      scopeKind: "default",
      fields: [
        { key: "company_domain", label: "Primary Domain", type: "short_text", required: true, sensitive: true, minLength: 4, maxLength: 120 },
        { key: "architecture_notes", label: "Architecture Notes", type: "long_text", required: true, sensitive: true, minLength: 10, maxLength: 4000 },
        {
          key: "environment_tier",
          label: "Environment",
          type: "single_choice",
          required: true,
          sensitive: false,
          options: [
            { value: "staging", label: "Staging" },
            { value: "production", label: "Production" },
          ],
        },
        {
          key: "compliance_targets",
          label: "Compliance Targets",
          type: "multi_choice",
          required: true,
          sensitive: false,
          minSelections: 1,
          maxSelections: 2,
          options: [
            { value: "soc2", label: "SOC 2" },
            { value: "hipaa", label: "HIPAA" },
            { value: "iso27001", label: "ISO 27001" },
          ],
        },
        { key: "target_launch_date", label: "Target Launch Date", type: "date", required: true, sensitive: false },
        { key: "endpoint_count", label: "Endpoint Count", type: "number", required: true, sensitive: false, minNumber: 1, maxNumber: 5000 },
      ],
    });
    await compliance.intake.admin.publishVersion(adminPrincipal, qCreated.draftVersionPublicId);

    // Negative authz: Customer B cannot see or write Customer A's order intake (NOT_FOUND, no existence oracle)
    await expect(
      compliance.intake.listForOrder(customerBPrincipal, orderA.publicId),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      compliance.intake.saveDraft(customerBPrincipal, {
        orderPublicId: orderA.publicId,
        questionnairePublicId: qCreated.questionnairePublicId,
        answers: { company_domain: "attacker.example" },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Negative authz: Viewer grant can READ order A intake, but CANNOT write (NOT_FOUND per orders/API.md)
    const viewerList = await compliance.intake.listForOrder(viewerPrincipal, orderA.publicId);
    expect(viewerList.items[0]?.canWrite).toBe(false);
    await expect(
      compliance.intake.saveDraft(viewerPrincipal, {
        orderPublicId: orderA.publicId,
        questionnairePublicId: qCreated.questionnairePublicId,
        answers: { company_domain: "viewer.example" },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Customer A saves partial draft (missing required fields allowed in draft mode)
    const draft1 = await compliance.intake.saveDraft(customerAPrincipal, {
      orderPublicId: orderA.publicId,
      questionnairePublicId: qCreated.questionnairePublicId,
      answers: {
        company_domain: "secret-corp.example",
      },
    });
    expect(draft1.status).toBe("draft");
    expect(draft1.revisionNumber).toBe(1);

    // Verify encrypted at rest in MySQL!
    const [rawSub] = await tdb.db
      .select()
      .from(complianceSchema.intakeSubmissions)
      .where(eq(complianceSchema.intakeSubmissions.publicId, draft1.submissionPublicId));
    expect(rawSub?.currentAnswersEnc).not.toContain("secret-corp.example");

    // Submitting incomplete answers fails validation
    await expect(
      compliance.intake.submit(customerAPrincipal, {
        orderPublicId: orderA.publicId,
        questionnairePublicId: qCreated.questionnairePublicId,
        answers: { company_domain: "secret-corp.example" },
      }),
    ).rejects.toMatchObject({ reasonCode: "INTAKE_REQUIRED_FIELDS_MISSING" });

    // Submitting complete valid answers transitions to `submitted` (revision 2)
    const sub1 = await compliance.intake.submit(customerAPrincipal, {
      orderPublicId: orderA.publicId,
      questionnairePublicId: qCreated.questionnairePublicId,
      answers: {
        company_domain: "secret-corp.example",
        architecture_notes: "Zero-trust VPC with mTLS service mesh.",
        environment_tier: "production",
        compliance_targets: ["soc2", "iso27001"],
        target_launch_date: "2026-12-15",
        endpoint_count: 42,
      },
    });
    expect(sub1.status).toBe("submitted");
    expect(sub1.revisionNumber).toBe(2);

    // Staff return-for-changes requires a review note
    await expect(
      compliance.intake.review(staffPrincipal, {
        submissionPublicId: sub1.submissionPublicId,
        decision: "returned_for_changes",
        reviewNote: "  ",
      }),
    ).rejects.toMatchObject({ reasonCode: "REVIEW_NOTE_REQUIRED" });

    // Staff returns with review feedback -> revision 3 + notification + mail enqueued
    const returned = await compliance.intake.review(staffPrincipal, {
      submissionPublicId: sub1.submissionPublicId,
      decision: "returned_for_changes",
      reviewNote: "Please include staging CIDR details in Architecture Notes.",
    });
    expect(returned.status).toBe("returned_for_changes");
    expect(returned.revisionNumber).toBe(3);
    expect(notifications.length).toBeGreaterThanOrEqual(1);
    expect(h.mailer.last("compliance.intake_returned")).toBeDefined();

    // Order lock check: if order is finalized, customer & staff intake writes are blocked!
    orderA.lockState = "finalized";
    try {
      await expect(
        compliance.intake.submit(customerAPrincipal, {
          orderPublicId: orderA.publicId,
          questionnairePublicId: qCreated.questionnairePublicId,
          answers: {
            company_domain: "secret-corp.example",
            architecture_notes: "Zero-trust VPC with mTLS service mesh and 10.20.0.0/16 staging.",
            environment_tier: "production",
            compliance_targets: ["soc2", "iso27001"],
            target_launch_date: "2026-12-15",
            endpoint_count: 42,
          },
        }),
      ).rejects.toMatchObject({ code: "LOCKED" });
    } finally {
      orderA.lockState = "none";
    }

    // Customer A resubmits (revision 4) and staff accepts (revision 5)
    await compliance.intake.submit(customerAPrincipal, {
      orderPublicId: orderA.publicId,
      questionnairePublicId: qCreated.questionnairePublicId,
      answers: {
        company_domain: "secret-corp.example",
        architecture_notes: "Zero-trust VPC with mTLS service mesh and 10.20.0.0/16 staging.",
        environment_tier: "production",
        compliance_targets: ["soc2", "iso27001"],
        target_launch_date: "2026-12-15",
        endpoint_count: 42,
      },
    });
    const accepted = await compliance.intake.review(staffPrincipal, {
      submissionPublicId: sub1.submissionPublicId,
      decision: "accepted",
      reviewNote: "Scope verified.",
    });
    expect(accepted.status).toBe("accepted");
    expect(accepted.revisionNumber).toBe(5);

    const history = await compliance.intake.getSubmission(customerAPrincipal, {
      orderPublicId: orderA.publicId,
      questionnairePublicId: qCreated.questionnairePublicId,
    });
    expect(history.revisions.map((r) => r.eventKind)).toEqual([
      "accepted",
      "submitted",
      "returned_for_changes",
      "submitted",
      "draft_saved",
    ]);
  });

  it("enforces pure minor-unit math, sequential invoice numbering, derived status from payment/refund evidence, PDF streaming, and online-payment honesty", async () => {
    const { h, compliance } = makeHarness();

    // Pure integer minor-unit math checks (no float drift, discount bounds enforced)
    const totals = computeInvoiceTotals({
      lines: [
        { description: "Penetration Test Retainer", quantity: 3, unitAmountMinor: 199_99 },
        { description: "Compliance Evidence Package", quantity: 2, unitAmountMinor: 50_01 },
      ],
      discountMinor: 50_00,
      taxMinor: 45_50,
    });
    expect(totals.subtotalMinor).toBe(699_99);
    expect(totals.totalMinor).toBe(695_49);

    expect(() =>
      computeInvoiceTotals({
        lines: [{ description: "Item", quantity: 1, unitAmountMinor: 1000 }],
        discountMinor: 1001,
        taxMinor: 0,
      }),
    ).toThrow();
    expect(() =>
      computeInvoiceTotals({
        lines: [{ description: "Float attempt", quantity: 1, unitAmountMinor: 19.99 }],
        discountMinor: 0,
        taxMinor: 0,
      }),
    ).toThrow();

    // Staff creates draft invoice on Order A
    const draftInv = await compliance.invoices.admin.createDraft(staffPrincipal, {
      orderPublicId: orderA.publicId,
      currency: "USD",
      lines: [
        { description: "ReadyPackets Security Assessment", quantity: 2, unitAmountMinor: 125_000 },
        { description: "Expedited Audit Report", quantity: 1, unitAmountMinor: 50_000 },
      ],
      discountMinor: 10_000,
      taxMinor: 15_000,
      memo: "Net 30 terms.",
    });
    expect(draftInv.totalMinor).toBe(305_000);

    // Draft invoice is invisible to Customer A (NOT_FOUND, no existence oracle)
    await expect(
      compliance.invoices.get(customerAPrincipal, draftInv.invoicePublicId),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Staff issues invoice -> allocates sequential number RP-INV-2026-000001
    const issued = await compliance.invoices.admin.issue(staffPrincipal, {
      invoicePublicId: draftInv.invoicePublicId,
    });
    expect(issued.invoiceNumber).toBe("RP-INV-2026-000001");
    expect(issued.status).toBe("issued");
    expect(h.mailer.last("compliance.invoice_issued")).toBeDefined();

    // Customer B still gets NOT_FOUND on Customer A's issued invoice
    await expect(
      compliance.invoices.get(customerBPrincipal, draftInv.invoicePublicId),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Customer A sees issued invoice + honest "Online payment is not configured" status
    const custView1 = await compliance.invoices.get(customerAPrincipal, draftInv.invoicePublicId);
    expect(custView1.status).toBe("issued");
    expect(custView1.balanceDueMinor).toBe(305_000);
    expect(custView1.onlinePaymentConfigured).toBe(false);
    expect(custView1.onlinePaymentMessage).toBe("Online payment is not configured");

    // Finalized order ALLOWS staff invoice payment & refund evidence (`kind: "invoice"`), whereas legal_hold blocks it!
    orderA.lockState = "finalized";
    const pmt1 = await compliance.invoices.admin.recordManualPayment(staffPrincipal, {
      invoicePublicId: draftInv.invoicePublicId,
      method: "wire",
      amountMinor: 105_000,
      currency: "USD",
      reference: "WIRE-99101",
      notes: "Initial wire tranche",
      idempotencyKey: "idem-wire-99101",
    });
    expect(pmt1.invoiceStatus).toBe("issued"); // Partial payment keeps status `issued`!
    expect(pmt1.balanceDueMinor).toBe(200_000);

    // Duplicate manual payment idempotencyKey returns duplicate: true without double-counting
    const pmt1Dup = await compliance.invoices.admin.recordManualPayment(staffPrincipal, {
      invoicePublicId: draftInv.invoicePublicId,
      method: "wire",
      amountMinor: 105_000,
      currency: "USD",
      reference: "WIRE-99101",
      idempotencyKey: "idem-wire-99101",
    });
    expect(pmt1Dup.duplicate).toBe(true);
    expect(pmt1Dup.balanceDueMinor).toBe(200_000);

    // Legal hold blocks invoice mutations!
    orderA.lockState = "legal_hold";
    await expect(
      compliance.invoices.admin.recordManualPayment(staffPrincipal, {
        invoicePublicId: draftInv.invoicePublicId,
        method: "wire",
        amountMinor: 200_000,
        currency: "USD",
        reference: "WIRE-99102",
        idempotencyKey: "idem-wire-blocked",
      }),
    ).rejects.toMatchObject({ code: "LOCKED" });
    orderA.lockState = "none";

    // Overpayment rejected
    await expect(
      compliance.invoices.admin.recordManualPayment(staffPrincipal, {
        invoicePublicId: draftInv.invoicePublicId,
        method: "ach",
        amountMinor: 200_001,
        currency: "USD",
        reference: "ACH-OVER",
        idempotencyKey: "idem-ach-over",
      }),
    ).rejects.toMatchObject({ reasonCode: "PAYMENT_EXCEEDS_BALANCE_DUE" });

    // Remaining payment derives `paid` automatically!
    const pmt2 = await compliance.invoices.admin.recordManualPayment(staffPrincipal, {
      invoicePublicId: draftInv.invoicePublicId,
      method: "ach",
      amountMinor: 200_000,
      currency: "USD",
      reference: "ACH-99102",
      idempotencyKey: "idem-ach-99102",
    });
    expect(pmt2.invoiceStatus).toBe("paid");
    expect(pmt2.balanceDueMinor).toBe(0);
    expect(h.mailer.last("compliance.invoice_paid")).toBeDefined();

    // Voiding a paid invoice with unrefunded funds is refused!
    await expect(
      compliance.invoices.admin.void(staffPrincipal, {
        invoicePublicId: draftInv.invoicePublicId,
        reason: "Customer requested cancellation",
      }),
    ).rejects.toMatchObject({ reasonCode: "INVOICE_HAS_UNREFUNDED_PAYMENTS" });

    // Staff (who holds `invoices.manage` with step-up, not `payments.refund`) cannot record refunds
    await expect(
      compliance.invoices.admin.recordRefund(staffPrincipal, {
        invoicePublicId: draftInv.invoicePublicId,
        paymentPublicId: pmt1.paymentPublicId,
        amountMinor: 10_000,
        currency: "USD",
        reasonCode: "SCOPE_REDUCTION",
        reference: "RFD-STAFF-DENY",
        confirmationPhrase: "REFUND ORDER",
        idempotencyKey: "idem-rfd-staff-deny",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Admin without exact `REFUND ORDER` phrase is refused
    await expect(
      compliance.invoices.admin.recordRefund(adminPrincipal, {
        invoicePublicId: draftInv.invoicePublicId,
        paymentPublicId: pmt1.paymentPublicId,
        amountMinor: 10_000,
        currency: "USD",
        reasonCode: "SCOPE_REDUCTION",
        reference: "RFD-WRONG-PHRASE",
        confirmationPhrase: "RP-INV-2026-000001",
        idempotencyKey: "idem-rfd-wrong-phrase",
      }),
    ).rejects.toMatchObject({ reasonCode: "INVALID_REFUND_CONFIRMATION" });

    // Refund exceeding payment amount is refused!
    await expect(
      compliance.invoices.admin.recordRefund(adminPrincipal, {
        invoicePublicId: draftInv.invoicePublicId,
        paymentPublicId: pmt1.paymentPublicId,
        amountMinor: 105_001,
        currency: "USD",
        reasonCode: "OVER_REFUND",
        reference: "RFD-BAD",
        confirmationPhrase: "REFUND ORDER",
        idempotencyKey: "idem-rfd-bad",
      }),
    ).rejects.toMatchObject({ reasonCode: "REFUND_EXCEEDS_PAYMENT" });

    // Partial refund of 50_000 re-derives invoice status back to `issued` with balanceDue = 50_000!
    const rfd1 = await compliance.invoices.admin.recordRefund(adminPrincipal, {
      invoicePublicId: draftInv.invoicePublicId,
      paymentPublicId: pmt1.paymentPublicId,
      amountMinor: 50_000,
      currency: "USD",
      reasonCode: "SCOPE_REDUCTION",
      reference: "RFD-5001",
      confirmationPhrase: "REFUND ORDER",
      idempotencyKey: "idem-rfd-5001",
    });
    expect(rfd1.invoiceStatus).toBe("issued");
    expect(rfd1.balanceDueMinor).toBe(50_000);

    // Customer A downloads valid PDF 1.4 and emits durable `invoice.downloaded` audit
    h.audit.clear();
    const pdf = await compliance.invoices.downloadPdf(customerAPrincipal, draftInv.invoicePublicId);
    expect(pdf.filename).toBe("RP-INV-2026-000001.pdf");
    expect(pdf.contentType).toBe("application/pdf");
    const pdfText = pdf.buffer.toString("latin1");
    expect(pdfText.startsWith("%PDF-1.4\n")).toBe(true);
    expect(pdfText).toContain("RP-INV-2026-000001");
    expect(pdfText.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(h.audit.named("invoice.downloaded")).toHaveLength(1);
    expect(h.audit.recordedInTx[0]).toBe(true);
  });

  it("keeps online provider ledger disabled as a scaffold — valid signed payment/refund events record receipt + audit and leave the ledger unchanged", async () => {
    const { h, compliance } = makeHarness();

    const draft = await compliance.invoices.admin.createDraft(staffPrincipal, {
      orderPublicId: orderB.publicId,
      currency: "USD",
      lines: [{ description: "Online Stripe Disabled Scaffold Package", quantity: 1, unitAmountMinor: 89_00 }],
      discountMinor: 0,
      taxMinor: 0,
    });
    const issued = await compliance.invoices.admin.issue(staffPrincipal, {
      invoicePublicId: draft.invoicePublicId,
    });
    expect(issued.invoiceNumber).toBe("RP-INV-2026-000002");

    // Valid signed payment/checkout event arrives from webhook adapter:
    // must record received-event row + audit note, return applied: false, and leave ledger 100% UNCHANGED!
    h.audit.clear();
    const okHook = await compliance.recordProviderPayment({
      provider: "stripe",
      providerEventId: "evt_paid_001",
      providerReference: "pi_paid_001",
      invoicePublicId: draft.invoicePublicId,
      kind: "succeeded",
      amountMinor: 89_00,
      currency: "USD",
      receivedAt: new Date("2026-11-20T13:00:00.000Z"),
    });
    expect(okHook.applied).toBe(false);
    expect(okHook.duplicate).toBe(false);
    expect(okHook.reasonCode).toBe("PROVIDER_LEDGER_DISABLED_IN_RELEASE");
    expect(h.audit.named("invoice.provider_event.scaffold_recorded")).toHaveLength(1);
    expect(h.audit.named("invoice.provider_event.scaffold_recorded")[0]?.outcome).toBe("refused");

    // Duplicate delivery of the exact same providerEventId is idempotent and also leaves ledger unchanged
    const dupHook = await compliance.recordProviderPayment({
      provider: "stripe",
      providerEventId: "evt_paid_001",
      providerReference: "pi_paid_001",
      invoicePublicId: draft.invoicePublicId,
      amountMinor: 89_00,
      currency: "USD",
    });
    expect(dupHook.applied).toBe(false);
    expect(dupHook.duplicate).toBe(true);

    // Provider refund event also leaves ledger unchanged
    const refundHook = await compliance.recordProviderPayment({
      provider: "stripe",
      providerEventId: "evt_refund_001",
      providerReference: "pi_paid_001",
      invoicePublicId: draft.invoicePublicId,
      kind: "refunded",
      amountMinor: 89_00,
      currency: "USD",
    });
    expect(refundHook.applied).toBe(false);
    expect(refundHook.reasonCode).toBe("PROVIDER_LEDGER_DISABLED_IN_RELEASE");

    // Verify invoice status, balances, payments, and refunds are COMPLETELY UNCHANGED!
    const afterEvents = await compliance.invoices.get(staffPrincipal, draft.invoicePublicId);
    expect(afterEvents.status).toBe("issued");
    expect(afterEvents.grossPaidMinor).toBe(0);
    expect(afterEvents.refundedMinor).toBe(0);
    expect(afterEvents.netPaidMinor).toBe(0);
    expect(afterEvents.balanceDueMinor).toBe(89_00);
    expect(afterEvents.payments).toHaveLength(0);
    expect(afterEvents.refunds).toHaveLength(0);
    expect(afterEvents.onlinePaymentConfigured).toBe(false);
  });

  it("exports normative portable v3 evidence in READ ONLY repeatable-read snapshots and imports inertly without fabricating active consent", async () => {
    const { h, compliance } = makeHarness();

    // Run portableEvidence inside an actual READ ONLY repeatable-read transaction (matching portable/collectors)
    const batch = await tdb.db.transaction(
      async (tx) =>
        compliance.portableEvidence(tx, [orderA.publicId, orderB.publicId], null, 100, {
          customerPublicIds: [customerAPrincipal.userPublicId, customerBPrincipal.userPublicId],
        }),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );

    expect(batch.policyVersions.length).toBeGreaterThanOrEqual(2);
    expect(batch.policyAcceptances.length).toBeGreaterThanOrEqual(2);
    expect(batch.intakeDefinitions.length).toBeGreaterThanOrEqual(1);
    expect(batch.intakeSubmissions.length).toBeGreaterThanOrEqual(1);
    expect(batch.invoices.length).toBeGreaterThanOrEqual(2);
    expect(batch.payments.length).toBeGreaterThanOrEqual(2);
    expect(batch.refunds.length).toBeGreaterThanOrEqual(1);
    expect(batch.nextCursor).toBeNull();

    // Every emitted record satisfies RECORD_SCHEMAS and internal reference closure
    const pvIds = new Set(batch.policyVersions.map((r) => RECORD_SCHEMAS["policy-versions"].parse(r).publicId));
    for (const pa of batch.policyAcceptances) {
      RECORD_SCHEMAS["policy-acceptances"].parse(pa);
      for (const [target, id] of referencesOf("policy-acceptances", pa)) {
        if (target === "policy-versions") expect(pvIds.has(id)).toBe(true);
      }
    }
    const defIds = new Set(batch.intakeDefinitions.map((r) => RECORD_SCHEMAS["intake-definitions"].parse(r).publicId));
    for (const sub of batch.intakeSubmissions) {
      RECORD_SCHEMAS["intake-submissions"].parse(sub);
      expect(defIds.has(sub.definitionPublicId)).toBe(true);
    }

    // Serialized JSON contains zero secret/token/password keys or raw IPs
    const serialized = JSON.stringify(batch);
    expect(serialized).not.toContain("203.0.113.42");
    expect(serialized).not.toMatch(/"[^"]*(?:secret|token|password)[^"]*":/i);

    // Import into Viewer user (who has NOT accepted live portal policies) -> must NOT satisfy live requiredAcceptancesFor!
    const importedOrderPubId = ulid(h.clock.now().getTime() + 9999);
    ordersMap.set(importedOrderPubId, {
      id: 999,
      publicId: importedOrderPubId,
      reference: "RP-IMP-000999",
      ownerUserId: viewerPrincipal.userId,
      ownerPublicId: viewerPrincipal.userPublicId,
      lockState: "imported_read_only",
      origin: "import",
      productPublicIds: [],
      grants: new Map(),
    });

    const receipt = await tdb.db.transaction((tx) =>
      compliance.importPortableEvidence(
        {
          importId: "imp_batch_01",
          sourceInstallationId: "src_inst_alpha",
          customerIdBySourcePublicId: new Map([[customerAPrincipal.userPublicId, viewerPrincipal.userId]]),
          orderBySourcePublicId: new Map([[orderA.publicId, { id: 999, publicId: importedOrderPubId }]]),
          policyVersions: batch.policyVersions,
          policyAcceptances: batch.policyAcceptances,
          intakeDefinitions: batch.intakeDefinitions,
          intakeSubmissions: batch.intakeSubmissions,
          invoices: batch.invoices.filter((i) => i.orderPublicId === orderA.publicId),
          payments: batch.payments.filter((p) => p.orderPublicId === orderA.publicId),
          refunds: batch.refunds,
        },
        tx,
      ),
    );
    expect(receipt.importedPolicyAcceptances).toBeGreaterThanOrEqual(1);
    expect(receipt.importedIntakeSubmissions).toBe(1);
    expect(receipt.importedInvoices).toBe(1);

    // Crucial zero-trust invariant: imported historical acceptances do NOT fabricate active portal consent!
    await expect(
      compliance.assertRequiredPoliciesAccepted(viewerPrincipal.userId),
    ).rejects.toMatchObject({ reasonCode: "POLICY_ACCEPTANCE_REQUIRED" });
  });

  it("enforces transactional live-actor re-validation, fail-closed durable audit rollback, and zero self-deadlock on a 1-connection pool", async () => {
    const { h, compliance } = makeHarness();

    // 1. Durable audit fail-closed: if audit.record throws, DB changes inside tx MUST roll back!
    h.audit.failRecords = true;
    await expect(
      compliance.policies.admin.createDocument(adminPrincipal, {
        slug: "audit-rollback-doc",
        title: "Should Roll Back",
        audience: "customer",
        requiresAcceptance: false,
        requiresTypedSignature: false,
        versionLabel: "1.0",
        contentFormat: "plain_text",
        bodyText: "This document must never persist when durable audit fails.",
      }),
    ).rejects.toThrow();
    h.audit.failRecords = false;

    const [rolledBackDoc] = await tdb.db
      .select()
      .from(complianceSchema.policyDocuments)
      .where(eq(complianceSchema.policyDocuments.slug, "audit-rollback-doc"));
    expect(rolledBackDoc).toBeUndefined();

    // 2. Live-actor re-validation inside tx: create a stale admin principal whose DB row was demoted to `customer`
    const now = h.clock.now();
    const demotedPubId = ulid(now.getTime() + 55555);
    const [demotedIns] = await tdb.db.insert(users).values({
      publicId: demotedPubId,
      emailEnc: "enc:demoted@example.test",
      emailIndex: "d".repeat(64),
      nameEnc: "enc:Demoted User",
      role: "customer", // Live DB role is customer!
      status: "active",
      emailVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const staleAdminPrincipal = fakePrincipal({
      userId: demotedIns.insertId,
      userPublicId: demotedPubId,
      role: "admin", // Stale snapshot claims admin!
      stepUpAt: now,
    });

    await expect(
      compliance.policies.admin.createDocument(staleAdminPrincipal, {
        slug: "stale-admin-attempt",
        title: "Stale Admin Attempt",
        audience: "customer",
        requiresAcceptance: false,
        requiresTypedSignature: false,
        versionLabel: "1.0",
        contentFormat: "plain_text",
        bodyText: "Must be rejected inside tx when actor role in DB was demoted.",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", reasonCode: "CAPABILITY_NOT_GRANTED" });

    // 3. Single-connection pool (`connectionLimit: 1`): issuing an invoice + recording payment must NOT self-deadlock!
    const singlePool = mysql.createPool({
      uri: tdb.url,
      connectionLimit: 1,
      timezone: "Z",
      supportBigNumbers: true,
      charset: "utf8mb4",
    });
    try {
      const singleDb = drizzle(singlePool, { mode: "default" }) as unknown as Db;
      const singleH = createTestDeps({ db: singleDb });
      // Spy on settings.get to prove `tx` is passed inside transactions!
      const txPassedFlags: boolean[] = [];
      const origGet = singleH.settings.get.bind(singleH.settings);
      singleH.settings.get = (async <T>(
        key: string,
        parse: (raw: unknown) => T,
        fallback: T,
        tx?: unknown,
      ): Promise<T> => {
        txPassedFlags.push(tx !== undefined);
        return origGet(key, parse, fallback);
      }) as typeof singleH.settings.get;
      singleH.services.orders = buildFakeOrdersModule(ordersMap);
      singleH.services.compliance = createComplianceModule(singleH.deps);

      const singleDraft = await singleH.services.compliance.invoices.admin.createDraft(staffPrincipal, {
        orderPublicId: orderA.publicId,
        currency: "USD",
        lines: [{ description: "Single Pool Concurrency Test", quantity: 1, unitAmountMinor: 15_00 }],
        discountMinor: 0,
        taxMinor: 0,
      });
      const singleIssued = await singleH.services.compliance.invoices.admin.issue(staffPrincipal, {
        invoicePublicId: singleDraft.invoicePublicId,
      });
      expect(singleIssued.status).toBe("issued");
      expect(txPassedFlags.length).toBeGreaterThanOrEqual(3);
      expect(txPassedFlags.every(Boolean)).toBe(true);
    } finally {
      await singlePool.end();
    }
  });

  it("enforces reviewer security & audit invariants: staff policy audience isolation, server-derived acceptance method & effectiveAt/supersession, intake scope applicability, paginated revisions, and denial/refusal audits", async () => {
    const { h, compliance } = makeHarness();

    // 1. Staff-only policy must NEVER leak on public listPublished() or customer myStatus(), and customer accept() returns NOT_FOUND
    const staffDoc = await compliance.policies.admin.createDocument(adminPrincipal, {
      slug: "staff-security-charter",
      title: "Internal Staff Security Charter",
      audience: "staff",
      requiresAcceptance: true,
      requiresTypedSignature: false,
      versionLabel: "1.0",
      contentFormat: "plain_text",
      bodyText: "Confidential staff security handling procedures.",
    });
    const pubStaffV1 = await compliance.policies.admin.publishVersion(adminPrincipal, {
      versionPublicId: staffDoc.draftVersionPublicId,
    });

    const publicList = await compliance.policies.listPublished();
    expect(publicList.some((p) => p.slug === "staff-security-charter")).toBe(false);

    const custStatus = await compliance.policies.myStatus(customerAPrincipal);
    expect(custStatus.published.some((p) => p.slug === "staff-security-charter")).toBe(false);

    const staffStatus = await compliance.policies.myStatus(staffPrincipal);
    expect(staffStatus.published.some((p) => p.slug === "staff-security-charter")).toBe(true);

    await expect(
      compliance.policies.accept(customerAPrincipal, {
        versionPublicId: pubStaffV1.versionPublicId,
        contentHash: pubStaffV1.contentHash,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // 2. Server-derived acceptance method + future effectiveAt + superseded version check
    const checkboxDoc = await compliance.policies.admin.createDocument(adminPrincipal, {
      slug: "acceptable-use",
      title: "Acceptable Use Policy",
      audience: "customer",
      requiresAcceptance: true,
      requiresTypedSignature: false,
      versionLabel: "1.0",
      contentFormat: "plain_text",
      bodyText: "Acceptable use v1.",
    });
    const pubUseV1 = await compliance.policies.admin.publishVersion(adminPrincipal, {
      versionPublicId: checkboxDoc.draftVersionPublicId,
    });

    // Customer sends unsolicited `typed_signature` + `signerName` on a non-signature policy -> server derives `portal_checkbox` and ignores signerName!
    const accUse = await compliance.policies.accept(customerAPrincipal, {
      versionPublicId: pubUseV1.versionPublicId,
      contentHash: pubUseV1.contentHash,
      method: "typed_signature",
      signerName: "Spoofed Signer",
    });
    const [accUseRow] = await tdb.db
      .select()
      .from(complianceSchema.policyAcceptances)
      .where(eq(complianceSchema.policyAcceptances.publicId, accUse.acceptancePublicId));
    expect(accUseRow?.method).toBe("portal_checkbox");
    expect(accUseRow?.signerNameEnc).toBeNull();

    // Publish v2 effective now -> v1 is now superseded for new acceptances (Customer B cannot accept v1!)
    const draftUseV2 = await compliance.policies.admin.createDraftVersion(adminPrincipal, {
      documentPublicId: checkboxDoc.documentPublicId,
      versionLabel: "2.0",
      contentFormat: "plain_text",
      bodyText: "Acceptable use v2.",
    });
    await compliance.policies.admin.publishVersion(adminPrincipal, {
      versionPublicId: draftUseV2.versionPublicId,
    });
    await expect(
      compliance.policies.accept(customerBPrincipal, {
        versionPublicId: pubUseV1.versionPublicId,
        contentHash: pubUseV1.contentHash,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", reasonCode: "POLICY_VERSION_SUPERSEDED" });

    // Future effectiveAt version is not yet accept-eligible (`NOT_FOUND`)
    const futureDoc = await compliance.policies.admin.createDocument(adminPrincipal, {
      slug: "future-policy",
      title: "Future Policy",
      audience: "customer",
      requiresAcceptance: true,
      requiresTypedSignature: false,
      versionLabel: "1.0",
      contentFormat: "plain_text",
      bodyText: "Effective next year.",
    });
    const pubFuture = await compliance.policies.admin.publishVersion(adminPrincipal, {
      versionPublicId: futureDoc.draftVersionPublicId,
      effectiveAt: new Date("2027-06-01T00:00:00.000Z"),
    });
    await expect(
      compliance.policies.accept(customerAPrincipal, {
        versionPublicId: pubFuture.versionPublicId,
        contentHash: pubFuture.contentHash,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // 3. Intake scope applicability (`catalog_item` + `workflow`) inside tx & paginated revisions
    const unrelatedProductId = ulid(h.clock.now().getTime() + 50_000);
    const catQ = await compliance.intake.admin.createQuestionnaire(adminPrincipal, {
      slug: "hipaa-addendum",
      title: "HIPAA Addendum",
      scopeKind: "catalog_item",
      scopeRef: unrelatedProductId,
      fields: [{ key: "covered_entity", label: "Covered Entity Name", type: "short_text", required: true, sensitive: false }],
    });
    await compliance.intake.admin.publishVersion(adminPrincipal, catQ.draftVersionPublicId);

    // Order A does NOT contain `unrelatedProductId` -> saveDraft & submit MUST reject with NOT_FOUND (no existence oracle)!
    await expect(
      compliance.intake.saveDraft(customerAPrincipal, {
        orderPublicId: orderA.publicId,
        questionnairePublicId: catQ.questionnairePublicId,
        answers: { covered_entity: "Acme Health" },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", reasonCode: "INTAKE_QUESTIONNAIRE_NOT_FOUND" });

    // Workflow-scoped questionnaire: rejected on orderB (`standard`), accepted on orderA when `workflowKey === "expedited"`
    const wfQ = await compliance.intake.admin.createQuestionnaire(adminPrincipal, {
      slug: "expedited-intake",
      title: "Expedited Workflow Intake",
      scopeKind: "workflow",
      scopeRef: "expedited",
      fields: [{ key: "target_date", label: "Target Go-Live", type: "date", required: true, sensitive: false }],
    });
    await compliance.intake.admin.publishVersion(adminPrincipal, wfQ.draftVersionPublicId);

    await expect(
      compliance.intake.submit(customerBPrincipal, {
        orderPublicId: orderB.publicId,
        questionnairePublicId: wfQ.questionnairePublicId,
        answers: { target_date: "2026-12-01" },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", reasonCode: "INTAKE_QUESTIONNAIRE_NOT_FOUND" });

    orderA.workflowKey = "expedited";
    await compliance.intake.saveDraft(customerAPrincipal, {
      orderPublicId: orderA.publicId,
      questionnairePublicId: wfQ.questionnairePublicId,
      answers: { target_date: "2026-12-01" },
    });
    await compliance.intake.saveDraft(customerAPrincipal, {
      orderPublicId: orderA.publicId,
      questionnairePublicId: wfQ.questionnairePublicId,
      answers: { target_date: "2026-12-05" },
    });
    await compliance.intake.submit(customerAPrincipal, {
      orderPublicId: orderA.publicId,
      questionnairePublicId: wfQ.questionnairePublicId,
      answers: { target_date: "2026-12-10" },
    });

    const page1 = await compliance.intake.getSubmission(customerAPrincipal, {
      orderPublicId: orderA.publicId,
      questionnairePublicId: wfQ.questionnairePublicId,
      limit: 2,
    });
    expect(page1.revisions).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await compliance.intake.getSubmission(customerAPrincipal, {
      orderPublicId: orderA.publicId,
      questionnairePublicId: wfQ.questionnairePublicId,
      cursor: page1.nextCursor!,
      limit: 2,
    });
    expect(page2.revisions).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    // 4. Audit coverage C-1 (authz/step-up denial outside tx) & C-2 (financial refusal after rollback) & snake_case attributes
    h.audit.clear();
    await expect(
      compliance.policies.admin.listDocuments(customerAPrincipal),
    ).rejects.toMatchObject({ code: "FORBIDDEN", reasonCode: "CAPABILITY_NOT_GRANTED" });
    expect(h.audit.named("authz.compliance.denied")).toHaveLength(1);
    expect(h.audit.named("authz.compliance.denied")[0]?.outcome).toBe("denied");
    expect(h.audit.recordedInTx[0]).toBe(false);

    // Stale/missing stepUpAt on staffPrincipal attempting `invoices.manage` mutation -> STEP_UP_REQUIRED + authz.compliance.denied!
    const noStepUpStaff = fakePrincipal({
      userId: staffPrincipal.userId,
      userPublicId: staffPrincipal.userPublicId,
      role: "staff",
      stepUpAt: null,
    });
    h.audit.clear();
    await expect(
      compliance.invoices.admin.createDraft(noStepUpStaff, {
        orderPublicId: orderA.publicId,
        currency: "USD",
        lines: [{ description: "Needs Step-Up", quantity: 1, unitAmountMinor: 10_00 }],
        discountMinor: 0,
        taxMinor: 0,
      }),
    ).rejects.toMatchObject({ code: "STEP_UP_REQUIRED", reasonCode: "STEP_UP_REQUIRED" });
    expect(h.audit.named("authz.compliance.denied")).toHaveLength(1);
    expect(h.audit.recordedInTx[0]).toBe(false);

    // Financial refusal (payment exceeding balance due) records `invoice.payment.refused` after rollback with snake_case attributes
    const refDraft = await compliance.invoices.admin.createDraft(staffPrincipal, {
      orderPublicId: orderA.publicId,
      currency: "USD",
      lines: [{ description: "Refusal Audit Check", quantity: 1, unitAmountMinor: 20_00 }],
      discountMinor: 0,
      taxMinor: 0,
    });
    await compliance.invoices.admin.issue(staffPrincipal, { invoicePublicId: refDraft.invoicePublicId });
    h.audit.clear();
    await expect(
      compliance.invoices.admin.recordManualPayment(staffPrincipal, {
        invoicePublicId: refDraft.invoicePublicId,
        method: "wire",
        amountMinor: 25_00,
        currency: "USD",
        reference: "WIRE-TOO-HIGH",
        idempotencyKey: "idem-wire-too-high",
      }),
    ).rejects.toMatchObject({ reasonCode: "PAYMENT_EXCEEDS_BALANCE_DUE" });
    const refusedEvt = h.audit.named("invoice.payment.refused")[0];
    expect(refusedEvt?.outcome).toBe("refused");
    expect(refusedEvt?.reasonCode).toBe("PAYMENT_EXCEEDS_BALANCE_DUE");
    expect(Object.keys(refusedEvt?.attributes ?? {}).every((k) => /^[a-z0-9_]+$/.test(k))).toBe(true);
  });

  it("policies.versionForGate & versionById: returns current published version with exact text & SHA-256 hash, currentVersion: null for unpublished/archived, and historical versionById after archive", async () => {
    const { h, compliance } = makeHarness();

    // Unknown policyPublicId / versionId -> null
    expect(await compliance.policies.versionForGate(ulid(h.clock.now().getTime() + 77_777))).toBeNull();
    expect(await compliance.policies.versionById(999_999)).toBeNull();

    // Draft-only policy -> versionForGate returns currentVersion: null
    const exactBody = "# Service Engagement Terms\n\nCustomer agrees to scope, timeline, and delivery rules.";
    const created = await compliance.policies.admin.createDocument(adminPrincipal, {
      slug: "order-service-terms-b6",
      title: "Order Service Engagement Terms",
      audience: "customer",
      requiresAcceptance: true,
      requiresTypedSignature: true,
      versionLabel: "2.1",
      contentFormat: "safe_markdown",
      bodyText: exactBody,
    });
    const draftGate = await compliance.policies.versionForGate(created.documentPublicId);
    expect(draftGate?.active).toBe(true);
    expect(draftGate?.currentVersion).toBeNull();

    // Publish -> versionForGate returns exact text, version number, version label, title, and SHA-256 hex
    const published = await compliance.policies.admin.publishVersion(adminPrincipal, {
      versionPublicId: created.draftVersionPublicId,
    });
    const gateView = await compliance.policies.versionForGate(created.documentPublicId);
    expect(gateView).not.toBeNull();
    expect(gateView?.documentPublicId).toBe(created.documentPublicId);
    expect(gateView?.slug).toBe("order-service-terms-b6");
    expect(gateView?.title).toBe("Order Service Engagement Terms");
    expect(gateView?.active).toBe(true);
    expect(gateView?.currentVersion?.publicId).toBe(published.versionPublicId);
    expect(gateView?.currentVersion?.versionNumber).toBe(1);
    expect(gateView?.currentVersion?.versionLabel).toBe("2.1");
    expect(gateView?.currentVersion?.bodyText).toBe(exactBody);
    expect(gateView?.currentVersion?.contentHash).toBe(
      createHash("sha256").update(exactBody, "utf8").digest("hex"),
    );

    // Deactivate/archive policy -> versionForGate returns active: false & currentVersion: null,
    // while versionById still resolves the historical published version for signed evidence display!
    const docDetail = await compliance.policies.admin.getDocument(adminPrincipal, created.documentPublicId);
    await compliance.policies.admin.updateDocument(adminPrincipal, {
      documentPublicId: created.documentPublicId,
      expectedVersion: docDetail.document.version,
      title: docDetail.document.title,
      audience: docDetail.document.audience,
      requiresAcceptance: docDetail.document.requiresAcceptance,
      requiresTypedSignature: docDetail.document.requiresTypedSignature,
      active: false,
    });
    const archivedGate = await compliance.policies.versionForGate(created.documentPublicId);
    expect(archivedGate?.active).toBe(false);
    expect(archivedGate?.currentVersion).toBeNull();

    const historical = await compliance.policies.versionById(gateView!.currentVersion!.id);
    expect(historical).not.toBeNull();
    expect(historical?.active).toBe(false);
    expect(historical?.currentVersion?.publicId).toBe(published.versionPublicId);
    expect(historical?.currentVersion?.contentHash).toBe(gateView?.currentVersion?.contentHash);
    expect(historical?.currentVersion?.bodyText).toBe(exactBody);
  });

  it("intake.saveDraft & submit: enforces fail-closed orders.gates.assertCustomerMayWork for customers while allowing staff writes", async () => {
    const { h, compliance } = makeHarness();
    const now = h.clock.now();
    const gatedOrder: FakeOrderRecord = {
      id: 599,
      publicId: ulid(now.getTime() + 59_900),
      reference: "RP-2026-000599",
      ownerUserId: customerAPrincipal.userId,
      ownerPublicId: customerAPrincipal.userPublicId,
      lockState: "none",
      origin: "portal",
      productPublicIds: [],
      grants: new Map(),
    };
    ordersMap.set(gatedOrder.publicId, gatedOrder);

    let gateBlocked = true;
    const gateCalls: Array<{ role: string; orderId: number; action: string; hasTx: boolean }> = [];
    (h.services.orders as unknown as Record<string, unknown>).gates = {
      async assertCustomerMayWork(input: {
        tx: DbOrTx;
        orderId: number;
        actor: SessionPrincipal;
        action: string;
        statusKey: string | null;
      }) {
        gateCalls.push({
          role: input.actor.role,
          orderId: input.orderId,
          action: input.action,
          hasTx: input.tx !== undefined,
        });
        if (gateBlocked) {
          throw new DomainError(
            "CONFLICT",
            "ACCEPTANCE_REQUIRED",
            "Order policy acceptance is required before working on this order.",
          );
        }
      },
    };

    const q = await compliance.intake.admin.createQuestionnaire(adminPrincipal, {
      slug: "gated-order-questionnaire",
      title: "Gated Order Questionnaire",
      scopeKind: "default",
      fields: [
        { key: "legal_entity", label: "Legal Entity", type: "short_text", required: true, sensitive: false, minLength: 2, maxLength: 100 },
      ],
    });
    await compliance.intake.admin.publishVersion(adminPrincipal, q.draftVersionPublicId);

    // Customer saveDraft and submit fail closed when acceptance gate rejects
    await expect(
      compliance.intake.saveDraft(customerAPrincipal, {
        orderPublicId: gatedOrder.publicId,
        questionnairePublicId: q.questionnairePublicId,
        answers: { legal_entity: "Acme Holdings LLC" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", reasonCode: "ACCEPTANCE_REQUIRED" });

    await expect(
      compliance.intake.submit(customerAPrincipal, {
        orderPublicId: gatedOrder.publicId,
        questionnairePublicId: q.questionnairePublicId,
        answers: { legal_entity: "Acme Holdings LLC" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", reasonCode: "ACCEPTANCE_REQUIRED" });

    expect(gateCalls).toHaveLength(2);
    expect(gateCalls.every((c) => c.hasTx)).toBe(true);

    // Staff can still save intake notes/drafts on the order while customer acceptance is pending
    const staffSaved = await compliance.intake.saveDraft(staffPrincipal, {
      orderPublicId: gatedOrder.publicId,
      questionnairePublicId: q.questionnairePublicId,
      answers: { legal_entity: "Acme Holdings LLC" },
    });
    expect(staffSaved.status).toBe("draft");
    expect(gateCalls).toHaveLength(2); // Not invoked for staff

    // Once customer completes acceptance gate, customer submit succeeds
    gateBlocked = false;
    const customerSubmitted = await compliance.intake.submit(customerAPrincipal, {
      orderPublicId: gatedOrder.publicId,
      questionnairePublicId: q.questionnairePublicId,
      answers: { legal_entity: "Acme Holdings LLC" },
    });
    expect(customerSubmitted.status).toBe("submitted");
    expect(gateCalls).toHaveLength(3);
  });

  it("invoices.getOrderPaymentSummaries & paymentState: transitions unpaid -> paid -> partially_refunded -> refunded", async () => {
    const { h, compliance } = makeHarness();
    const now = h.clock.now();
    const payOrder: FakeOrderRecord = {
      id: 601,
      publicId: ulid(now.getTime() + 60_100),
      reference: "RP-2026-000601",
      ownerUserId: customerBPrincipal.userId,
      ownerPublicId: customerBPrincipal.userPublicId,
      lockState: "none",
      origin: "portal",
      productPublicIds: [],
      grants: new Map(),
    };
    ordersMap.set(payOrder.publicId, payOrder);

    const draft = await compliance.invoices.admin.createDraft(adminPrincipal, {
      orderPublicId: payOrder.publicId,
      currency: "USD",
      lines: [{ description: "Compliance Review Package", quantity: 1, unitAmountMinor: 10_000 }],
      discountMinor: 0,
      taxMinor: 0,
    });
    await compliance.invoices.admin.issue(adminPrincipal, { invoicePublicId: draft.invoicePublicId });

    // 1. Issued, unpaid -> `unpaid`
    const s1 = (await compliance.invoices.getOrderPaymentSummaries([payOrder.publicId])).get(payOrder.publicId);
    expect(s1?.state).toBe("unpaid");
    expect(s1?.totalMinor).toBe(10_000);
    const list1 = await compliance.invoices.listForOrder(customerBPrincipal, payOrder.publicId);
    expect(list1.items[0]?.paymentState).toBe("unpaid");

    // 2. Paid in full -> `paid`
    const pmt = await compliance.invoices.admin.recordManualPayment(adminPrincipal, {
      invoicePublicId: draft.invoicePublicId,
      method: "wire",
      amountMinor: 10_000,
      currency: "USD",
      reference: "WIRE-601",
      idempotencyKey: "idem-601-pay",
    });
    const s2 = (await compliance.invoices.getOrderPaymentSummaries([payOrder.publicId])).get(payOrder.publicId);
    expect(s2?.state).toBe("paid");
    expect((await compliance.invoices.listForOrder(customerBPrincipal, payOrder.publicId)).items[0]?.paymentState).toBe(
      "paid",
    );

    // 3. Partial refund ($35.00 of $100.00) -> `partially_refunded`
    await compliance.invoices.admin.recordRefund(adminPrincipal, {
      invoicePublicId: draft.invoicePublicId,
      paymentPublicId: pmt.paymentPublicId,
      amountMinor: 3_500,
      currency: "USD",
      reasonCode: "CUSTOMER_REQUEST",
      reference: "RFD-601-PART",
      confirmationPhrase: "REFUND ORDER",
      idempotencyKey: "idem-601-rfd-1",
    });
    const s3 = (await compliance.invoices.getOrderPaymentSummaries([payOrder.publicId])).get(payOrder.publicId);
    expect(s3?.state).toBe("partially_refunded");
    const inv3 = (await compliance.invoices.listForOrder(customerBPrincipal, payOrder.publicId)).items[0];
    expect(inv3?.paymentState).toBe("partially_refunded");
    expect(inv3?.refundedMinor).toBe(3_500);

    // 4. Remaining refund ($65.00) -> `refunded`
    await compliance.invoices.admin.recordRefund(adminPrincipal, {
      invoicePublicId: draft.invoicePublicId,
      paymentPublicId: pmt.paymentPublicId,
      amountMinor: 6_500,
      currency: "USD",
      reasonCode: "CUSTOMER_REQUEST",
      reference: "RFD-601-FULL",
      confirmationPhrase: "REFUND ORDER",
      idempotencyKey: "idem-601-rfd-2",
    });
    const s4 = (await compliance.invoices.getOrderPaymentSummaries([payOrder.publicId])).get(payOrder.publicId);
    expect(s4?.state).toBe("refunded");
    const inv4 = (await compliance.invoices.listForOrder(customerBPrincipal, payOrder.publicId)).items[0];
    expect(inv4?.paymentState).toBe("refunded");
    expect(inv4?.refundedMinor).toBe(10_000);
  });

  it("Increment 05 (C4 + G-C3-02): renders separate bundle and promo discount lines, derives paid for 100% zero-total invoices, and enforces conservative orderPaymentExposureInTx + cancelled-order refusal", async () => {
    const h = createTestDeps({ db: tdb.db as unknown as Db });
    const now = new Date("2026-11-22T15:00:00.000Z");
    h.clock.set(now);
    const localAdmin = fakePrincipal({
      ...adminPrincipal,
      stepUpAt: now,
    });

    const localOrders = new Map<string, FakeOrderRecord>();
    const promoOrder: FakeOrderRecord = {
      id: 701,
      publicId: ulid(now.getTime() + 701),
      reference: "RP-2026-0701",
      ownerUserId: customerAPrincipal.userId,
      ownerPublicId: customerAPrincipal.userPublicId,
      lockState: "none",
      origin: "portal",
      productPublicIds: [],
      discountMinor: 3_500,
      discountLabel: "Bundle save + SPRING15 (15% off)",
      promoDiscountMinor: 1_500,
      promoLabel: "SPRING15 (15% off)",
      bundleDiscountMinor: 2_000,
      grants: new Map(),
    };
    const zeroOrder: FakeOrderRecord = {
      id: 702,
      publicId: ulid(now.getTime() + 702),
      reference: "RP-2026-0702",
      ownerUserId: customerAPrincipal.userId,
      ownerPublicId: customerAPrincipal.userPublicId,
      lockState: "none",
      origin: "portal",
      productPublicIds: [],
      discountMinor: 5_000,
      discountLabel: "VIP100 (100% off)",
      promoDiscountMinor: 5_000,
      promoLabel: "VIP100 (100% off)",
      bundleDiscountMinor: 0,
      grants: new Map(),
    };
    const exposureOrder: FakeOrderRecord = {
      id: 703,
      publicId: ulid(now.getTime() + 703),
      reference: "RP-2026-0703",
      ownerUserId: customerBPrincipal.userId,
      ownerPublicId: customerBPrincipal.userPublicId,
      lockState: "none",
      origin: "portal",
      productPublicIds: [],
      grants: new Map(),
    };
    const cancelledOrder: FakeOrderRecord = {
      id: 704,
      publicId: ulid(now.getTime() + 704),
      reference: "RP-2026-0704",
      ownerUserId: customerBPrincipal.userId,
      ownerPublicId: customerBPrincipal.userPublicId,
      lockState: "none",
      origin: "portal",
      statusKey: "cancelled",
      productPublicIds: [],
      grants: new Map(),
    };
    for (const o of [promoOrder, zeroOrder, exposureOrder, cancelledOrder]) {
      localOrders.set(o.publicId, o);
    }

    let simulatedAttemptState = { providerCapturePending: false, providerAttemptEver: false };
    h.services.orders = buildFakeOrdersModule(localOrders);
    (h.services as unknown as Record<string, unknown>).payments = {
      async getAttemptExposureForOrderInTx() {
        return simulatedAttemptState;
      },
    };
    const compliance = createComplianceModule(h.deps);
    h.services.compliance = compliance;

    // 1. C4: Separate bundle + promo discount lines on invoice view & PDF
    const promoIssued = await tdb.db.transaction((tx) =>
      compliance.issueCheckoutInvoiceInTx(
        {
          principal: customerAPrincipal,
          orderId: promoOrder.id,
          orderPublicId: promoOrder.publicId,
          currency: "USD",
          lines: [{ description: "Packet 1 + Packet 2", quantity: 1, unitAmountMinor: 10_000 }],
          discountMinor: 3_500,
        },
        tx,
      ),
    );
    expect(promoIssued.totalMinor).toBe(6_500);

    const promoDetail = await compliance.invoices.get(customerAPrincipal, promoIssued.invoicePublicId);
    expect(promoDetail.discountMinor).toBe(3_500);
    expect(promoDetail.bundleDiscountMinor).toBe(2_000);
    expect(promoDetail.promoDiscountMinor).toBe(1_500);
    expect(promoDetail.promoLabel).toBe("SPRING15 (15% off)");

    const pdf = await compliance.invoices.downloadPdf(customerAPrincipal, promoIssued.invoicePublicId);
    const pdfText = pdf.buffer.toString("latin1");
    expect(pdfText).toContain("Bundle discount");
    expect(pdfText).toContain("-USD 20.00");
    expect(pdfText).toContain("Discount \\(SPRING15 \\(15% off\\)\\)");
    expect(pdfText).toContain("-USD 15.00");

    // If an admin issues a supplemental invoice with a different custom discount, order promo breakdown is not misattributed
    const customDraft = await compliance.invoices.admin.createDraft(localAdmin, {
      orderPublicId: promoOrder.publicId,
      currency: "USD",
      lines: [{ description: "Add-on consultation", quantity: 1, unitAmountMinor: 4_000 }],
      discountMinor: 500,
      taxMinor: 0,
    });
    const customDetail = await compliance.invoices.get(localAdmin, customDraft.invoicePublicId);
    expect(customDetail.promoDiscountMinor).toBe(0);
    expect(customDetail.promoLabel).toBeNull();
    expect(customDetail.bundleDiscountMinor).toBe(500);
    expect(customDetail.discountLabel).toBeNull();

    // 2. C4: 100% discount ($0.00 total) invoice derives `paid`, balanceDue = 0, and no open payable exposure
    const zeroIssued = await tdb.db.transaction((tx) =>
      compliance.issueCheckoutInvoiceInTx(
        {
          principal: customerAPrincipal,
          orderId: zeroOrder.id,
          orderPublicId: zeroOrder.publicId,
          currency: "USD",
          lines: [{ description: "Packet 1 Basic", quantity: 1, unitAmountMinor: 5_000 }],
          discountMinor: 5_000,
        },
        tx,
      ),
    );
    expect(zeroIssued.totalMinor).toBe(0);
    const zeroDetail = await compliance.invoices.get(customerAPrincipal, zeroIssued.invoicePublicId);
    expect(zeroDetail.status).toBe("paid");
    expect(zeroDetail.paymentState).toBe("paid");
    expect(zeroDetail.balanceDueMinor).toBe(0);
    expect(zeroDetail.canRecordPayment).toBe(false);
    expect(zeroDetail.promoDiscountMinor).toBe(5_000);
    expect(zeroDetail.promoLabel).toBe("VIP100 (100% off)");
    expect(zeroDetail.bundleDiscountMinor).toBe(0);

    const zeroSummary = (await compliance.invoices.getOrderPaymentSummaries([zeroOrder.publicId])).get(
      zeroOrder.publicId,
    );
    expect(zeroSummary?.state).toBe("paid");

    const zeroExposure = await tdb.db.transaction((tx) =>
      compliance.orderPaymentExposureInTx(tx, zeroOrder.publicId),
    );
    expect(zeroExposure).toEqual({
      grossPaidMinor: 0,
      payableInvoiceOpen: false,
      providerCapturePending: false,
      providerAttemptEver: false,
    });

    // 3. G-C3-02: Conservative `orderPaymentExposureInTx` transitions
    const expInitial = await tdb.db.transaction((tx) =>
      compliance.orderPaymentExposureInTx(tx, exposureOrder.publicId),
    );
    expect(expInitial).toEqual({
      grossPaidMinor: 0,
      payableInvoiceOpen: false,
      providerCapturePending: false,
      providerAttemptEver: false,
    });

    // Any provider attempt ever created (even failed/expired) -> providerAttemptEver: true
    simulatedAttemptState = { providerCapturePending: false, providerAttemptEver: true };
    const expAfterFailedAttempt = await tdb.db.transaction((tx) =>
      compliance.orderPaymentExposureInTx(tx, exposureOrder.publicId),
    );
    expect(expAfterFailedAttempt.providerAttemptEver).toBe(true);
    simulatedAttemptState = { providerCapturePending: false, providerAttemptEver: false };

    // Issued open invoice -> payableInvoiceOpen: true
    const expDraft = await compliance.invoices.admin.createDraft(localAdmin, {
      orderPublicId: exposureOrder.publicId,
      currency: "USD",
      lines: [{ description: "Standard Packet", quantity: 1, unitAmountMinor: 8_000 }],
      discountMinor: 0,
      taxMinor: 0,
    });
    await compliance.invoices.admin.issue(localAdmin, { invoicePublicId: expDraft.invoicePublicId });
    const expIssued = await tdb.db.transaction((tx) =>
      compliance.orderPaymentExposureInTx(tx, exposureOrder.publicId),
    );
    expect(expIssued).toEqual({
      grossPaidMinor: 0,
      payableInvoiceOpen: true,
      providerCapturePending: false,
      providerAttemptEver: false,
    });

    // Partial payment -> grossPaidMinor = 3_000, payableInvoiceOpen = true
    const partialPmt = await compliance.invoices.admin.recordManualPayment(localAdmin, {
      invoicePublicId: expDraft.invoicePublicId,
      method: "wire",
      amountMinor: 3_000,
      currency: "USD",
      reference: "WIRE-703-PART",
      idempotencyKey: "idem-703-part",
    });
    const expPartial = await tdb.db.transaction((tx) =>
      compliance.orderPaymentExposureInTx(tx, exposureOrder.publicId),
    );
    expect(expPartial.grossPaidMinor).toBe(3_000);
    expect(expPartial.payableInvoiceOpen).toBe(true);

    // Refunded payment still keeps grossPaidMinor > 0 so redemption is never released after refund
    await compliance.invoices.admin.recordRefund(localAdmin, {
      invoicePublicId: expDraft.invoicePublicId,
      paymentPublicId: partialPmt.paymentPublicId,
      amountMinor: 3_000,
      currency: "USD",
      reasonCode: "CUSTOMER_REQUEST",
      reference: "RFD-703-PART",
      confirmationPhrase: "REFUND ORDER",
      idempotencyKey: "idem-703-rfd",
    });
    const expAfterRefund = await tdb.db.transaction((tx) =>
      compliance.orderPaymentExposureInTx(tx, exposureOrder.publicId),
    );
    expect(expAfterRefund.grossPaidMinor).toBe(3_000);

    // 4. G-C3-02: Absent payments port with ZERO invoices still fails closed (`providerAttemptEver: true`)
    const savedPayments = h.services.payments;
    delete (h.services as Partial<typeof h.services>).payments;
    try {
      const noPortZeroInvoicesOrder: FakeOrderRecord = {
        id: 705,
        publicId: ulid(now.getTime() + 705),
        reference: "RP-2026-0705",
        ownerUserId: customerAPrincipal.userId,
        ownerPublicId: customerAPrincipal.userPublicId,
        lockState: "none",
        origin: "portal",
        productPublicIds: [],
        grants: new Map(),
      };
      localOrders.set(noPortZeroInvoicesOrder.publicId, noPortZeroInvoicesOrder);
      const absentPortExposure = await tdb.db.transaction((tx) =>
        compliance.orderPaymentExposureInTx(tx, noPortZeroInvoicesOrder.publicId),
      );
      expect(absentPortExposure).toEqual({
        grossPaidMinor: 0,
        payableInvoiceOpen: false,
        providerCapturePending: true,
        providerAttemptEver: true,
      });
    } finally {
      h.services.payments = savedPayments;
    }

    // 5. G-C3-02: Real 2-connection MariaDB/InnoDB `FOR SHARE NOWAIT` contention test:
    //    when another connection holds `FOR UPDATE` on an invoice row, `orderPaymentExposureInTx`
    //    fails closed immediately (`providerAttemptEver: true`) AND the outer cancellation tx STILL COMMITS!
    const lockPool = mysql.createPool({
      uri: tdb.url,
      connectionLimit: 2,
      timezone: "Z",
      supportBigNumbers: true,
      charset: "utf8mb4",
    });
    const blockerConn = await lockPool.getConnection();
    try {
      await blockerConn.beginTransaction();
      await blockerConn.query(
        "SELECT id FROM compliance_invoices WHERE public_id = ? FOR UPDATE",
        [promoIssued.invoicePublicId],
      );

      const markerDocPubId = ulid(now.getTime() + 706);
      const contendedExposure = await tdb.db.transaction(async (tx) => {
        const exp = await compliance.orderPaymentExposureInTx(tx, promoOrder.publicId);
        // Prove the outer transaction remains healthy and committable after NOWAIT lock refusal!
        await tx.insert(complianceSchema.policyDocuments).values({
          publicId: markerDocPubId,
          slug: `nowait-tx-commit-${markerDocPubId.toLowerCase()}`,
          title: "NOWAIT Commit Proof",
          audience: "staff",
          active: false,
          requiresAcceptance: false,
          requiresTypedSignature: false,
          createdAt: now,
          updatedAt: now,
        });
        return exp;
      });

      expect(contendedExposure).toEqual({
        grossPaidMinor: 1,
        payableInvoiceOpen: true,
        providerCapturePending: true,
        providerAttemptEver: true,
      });

      const [committedMarker] = await tdb.db
        .select({ publicId: complianceSchema.policyDocuments.publicId })
        .from(complianceSchema.policyDocuments)
        .where(eq(complianceSchema.policyDocuments.publicId, markerDocPubId));
      expect(committedMarker?.publicId).toBe(markerDocPubId);
    } finally {
      await blockerConn.rollback();
      blockerConn.release();
      await lockPool.end();
    }

    // 6. G-C3-02: Cancelled orders refuse new invoice drafts and checkout invoice issuance
    await expect(
      compliance.invoices.admin.createDraft(localAdmin, {
        orderPublicId: cancelledOrder.publicId,
        currency: "USD",
        lines: [{ description: "Blocked on cancelled order", quantity: 1, unitAmountMinor: 2_000 }],
        discountMinor: 0,
        taxMinor: 0,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", reasonCode: "ORDER_CANCELLED" });

    await expect(
      tdb.db.transaction((tx) =>
        compliance.issueCheckoutInvoiceInTx(
          {
            principal: customerBPrincipal,
            orderId: cancelledOrder.id,
            orderPublicId: cancelledOrder.publicId,
            currency: "USD",
            lines: [{ description: "Blocked checkout invoice", quantity: 1, unitAmountMinor: 2_000 }],
            discountMinor: 0,
          },
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT", reasonCode: "ORDER_CANCELLED" });
  });

  it("Increment 05 (D1): Policy Acceptance Log Centre unifies account + order-gate evidence, enforces §4 authz & signer-name privacy, tracks coverage/updates/customer profile, and exports formula-safe CSV", async () => {
    const h = createTestDeps({ db: tdb.db as unknown as Db });
    const baseTime = new Date("2026-11-22T16:00:00.000Z");
    h.clock.set(baseTime);

    // Seed dedicated active customers with real AES-256-GCM envelopes (required by `compliance.acceptance.accept`)
    const d1CustAPubId = ulid(baseTime.getTime() + 11);
    const [insD1CustA] = await tdb.db.insert(users).values({
      publicId: d1CustAPubId,
      emailEnc: h.deps.crypto.encrypt("d1.clara@example.test", `users.email:${d1CustAPubId}`),
      emailIndex: "1".padStart(64, "c"),
      nameEnc: h.deps.crypto.encrypt("Clara Signer", `users.name:${d1CustAPubId}`),
      customerRef: "CUST-8801",
      role: "customer",
      status: "active",
      emailVerifiedAt: baseTime,
      createdAt: baseTime,
      updatedAt: baseTime,
    });
    const d1CustAPrincipal = fakePrincipal({
      userId: insD1CustA.insertId,
      userPublicId: d1CustAPubId,
      role: "customer",
    });

    const d1CustBPubId = ulid(baseTime.getTime() + 12);
    const [insD1CustB] = await tdb.db.insert(users).values({
      publicId: d1CustBPubId,
      emailEnc: h.deps.crypto.encrypt("d1.bob@example.test", `users.email:${d1CustBPubId}`),
      emailIndex: "2".padStart(64, "c"),
      nameEnc: h.deps.crypto.encrypt("Bob Prior", `users.name:${d1CustBPubId}`),
      customerRef: "CUST-8802",
      role: "customer",
      status: "active",
      emailVerifiedAt: baseTime,
      createdAt: baseTime,
      updatedAt: baseTime,
    });
    const d1CustBPrincipal = fakePrincipal({
      userId: insD1CustB.insertId,
      userPublicId: d1CustBPubId,
      role: "customer",
    });

    const formulaCustomerPubId = ulid(baseTime.getTime() + 13);
    const [insFormula] = await tdb.db.insert(users).values({
      publicId: formulaCustomerPubId,
      emailEnc: h.deps.crypto.encrypt("formula@example.test", `users.email:${formulaCustomerPubId}`),
      emailIndex: "f".padStart(64, "9"),
      nameEnc: h.deps.crypto.encrypt("=CMD|' /C calc'!A0", `users.name:${formulaCustomerPubId}`),
      customerRef: "CUST-9901",
      role: "customer",
      status: "active",
      emailVerifiedAt: baseTime,
      createdAt: baseTime,
      updatedAt: baseTime,
    });
    const formulaCustomerPrincipal = fakePrincipal({
      userId: insFormula.insertId,
      userPublicId: formulaCustomerPubId,
      role: "customer",
    });

    const localAdminFresh = fakePrincipal({
      ...adminPrincipal,
      sessionId: ulid(baseTime.getTime() + 901),
      stepUpAt: baseTime,
    });
    const localAdminStaleStepUp = fakePrincipal({
      ...adminPrincipal,
      sessionId: ulid(baseTime.getTime() + 902),
      stepUpAt: new Date(baseTime.getTime() - 2 * 60 * 60_000),
    });
    const localStaff = fakePrincipal({
      ...staffPrincipal,
      sessionId: ulid(baseTime.getTime() + 903),
      stepUpAt: baseTime,
    });

    // Live session registry for `identity.sessions.{getState,assertCurrent}` + user lookups
    interface MockSessionRecord {
      sessionId: string;
      userId: number;
      userPublicId: string;
      role: "customer" | "staff" | "admin";
      userStatus: "active" | "suspended" | "deactivated";
      live: boolean;
      stepUpAt: Date | null;
      mfaVerifiedAt: Date | null;
      authMethod: "local";
      assertCurrentError?: Error;
    }
    const sessionRegistry = new Map<string, MockSessionRecord>();
    const registerSessionFor = (p: SessionPrincipal) => {
      sessionRegistry.set(p.sessionId, {
        sessionId: p.sessionId,
        userId: p.userId,
        userPublicId: p.userPublicId,
        role: p.role,
        userStatus: "active",
        live: true,
        stepUpAt: p.stepUpAt,
        mfaVerifiedAt: p.mfaVerifiedAt,
        authMethod: "local",
      });
    };
    for (const p of [
      localAdminFresh,
      localAdminStaleStepUp,
      localStaff,
      d1CustAPrincipal,
      d1CustBPrincipal,
      formulaCustomerPrincipal,
      viewerPrincipal,
    ]) {
      registerSessionFor(p);
    }

    const userBook = new Map<
      number,
      { id: number; publicId: string; customerRef: string | null; email: string; name: string; role: "customer" | "staff" | "admin" }
    >([
      [
        d1CustAPrincipal.userId,
        {
          id: d1CustAPrincipal.userId,
          publicId: d1CustAPubId,
          customerRef: "CUST-8801",
          email: "d1.clara@example.test",
          name: "Clara Signer",
          role: "customer",
        },
      ],
      [
        d1CustBPrincipal.userId,
        {
          id: d1CustBPrincipal.userId,
          publicId: d1CustBPubId,
          customerRef: "CUST-8802",
          email: "d1.bob@example.test",
          name: "Bob Prior",
          role: "customer",
        },
      ],
      [
        formulaCustomerPrincipal.userId,
        {
          id: formulaCustomerPrincipal.userId,
          publicId: formulaCustomerPubId,
          customerRef: "CUST-9901",
          email: "formula@example.test",
          name: "=CMD|' /C calc'!A0",
          role: "customer",
        },
      ],
      [
        viewerPrincipal.userId,
        {
          id: viewerPrincipal.userId,
          publicId: viewerPrincipal.userPublicId,
          customerRef: "CUST-7700",
          email: "viewer@example.test",
          name: "Vera Viewer",
          role: "customer",
        },
      ],
      [
        customerAPrincipal.userId,
        {
          id: customerAPrincipal.userId,
          publicId: customerAPrincipal.userPublicId,
          customerRef: "CUST-7701",
          email: "custa@example.test",
          name: "Clara Customer",
          role: "customer",
        },
      ],
      [
        customerBPrincipal.userId,
        {
          id: customerBPrincipal.userId,
          publicId: customerBPrincipal.userPublicId,
          customerRef: "CUST-7702",
          email: "custb@example.test",
          name: "Bob Other",
          role: "customer",
        },
      ],
    ]);

    h.services.identity = {
      sessions: {
        async getState(sessionId: string) {
          const s = sessionRegistry.get(sessionId);
          if (!s) return null;
          return {
            sessionId: s.sessionId,
            userId: s.userId,
            userPublicId: s.userPublicId,
            role: s.role,
            userStatus: s.userStatus,
            live: s.live,
            revokedAt: s.live ? null : h.clock.now(),
            mfaVerifiedAt: s.mfaVerifiedAt,
            stepUpAt: s.stepUpAt,
            absoluteExpiresAt: new Date(h.clock.now().getTime() + 3_600_000),
            authMethod: s.authMethod,
          };
        },
        async assertCurrent(principal: SessionPrincipal) {
          const s = sessionRegistry.get(principal.sessionId);
          if (!s || !s.live || s.userId !== principal.userId || s.role !== principal.role) {
            throw new DomainError("UNAUTHENTICATED", "SESSION_NOT_CURRENT", "Session not current.");
          }
          if (s.assertCurrentError) throw s.assertCurrentError;
          return {
            pendingSteps: [],
            role: s.role,
            stepUpAt: s.stepUpAt,
            mfaVerifiedAt: s.mfaVerifiedAt,
          };
        },
      },
      async getUsersByIds(ids: readonly number[]) {
        const map = new Map();
        for (const id of ids) {
          const u = userBook.get(id);
          if (u) {
            map.set(id, {
              id: u.id,
              publicId: u.publicId,
              customerRef: u.customerRef,
              email: u.email,
              name: u.name,
              role: u.role,
              status: "active",
              emailVerified: true,
              mfaEnabled: false,
              lastSignedInAt: null,
              createdAt: baseTime,
            });
          }
        }
        return map;
      },
      async findCustomerIds(q: string) {
        const needle = q.trim().toLowerCase();
        const matches: number[] = [];
        for (const u of userBook.values()) {
          if (
            u.publicId.toLowerCase() === needle ||
            (u.customerRef && u.customerRef.toLowerCase().includes(needle)) ||
            u.email.toLowerCase().includes(needle) ||
            u.name.toLowerCase().includes(needle)
          ) {
            matches.push(u.id);
          }
        }
        return matches;
      },
    } as unknown as typeof h.services.identity;

    const gateOrder: FakeOrderRecord = {
      id: 801,
      publicId: ulid(baseTime.getTime() + 801),
      reference: "RP-2026-0801",
      ownerUserId: d1CustAPrincipal.userId,
      ownerPublicId: d1CustAPubId,
      lockState: "none",
      origin: "portal",
      productPublicIds: [],
      grants: new Map(),
    };
    const checkoutOrder: FakeOrderRecord = {
      id: 802,
      publicId: ulid(baseTime.getTime() + 802),
      reference: "RP-2026-0802",
      ownerUserId: formulaCustomerPrincipal.userId,
      ownerPublicId: formulaCustomerPubId,
      lockState: "none",
      origin: "portal",
      productPublicIds: [],
      grants: new Map(),
    };
    const localOrders = new Map<string, FakeOrderRecord>([
      [gateOrder.publicId, gateOrder],
      [checkoutOrder.publicId, checkoutOrder],
    ]);

    const fakeOrders = buildFakeOrdersModule(localOrders);
    // Attach `gates.context` so `compliance.acceptance.accept` records a real `order_policy_acceptances` row!
    let gatedPolicyPubId = "";
    (fakeOrders.gates as unknown as Record<string, unknown>).context = async (
      orderPublicId: string,
      actor: SessionPrincipal,
    ) => {
      const o = localOrders.get(orderPublicId);
      if (!o || o.ownerUserId !== actor.userId) return null;
      return {
        orderId: o.id,
        orderPublicId: o.publicId,
        reference: o.reference,
        name: o.reference,
        customerUserId: o.ownerUserId,
        workflowVersionId: 1,
        currentStatusKey: "in_progress",
        gates: [
          {
            key: "order_start",
            policyPublicId: gatedPolicyPubId,
            point: "order_start" as const,
            signatureMode: "typed_name" as const,
            askAgainOnNewVersion: true,
          },
        ],
        actorAccess: "owner" as const,
      };
    };
    (fakeOrders.gates as unknown as Record<string, unknown>).registerProvider = () => {};

    h.services.orders = fakeOrders;
    const compliance = createComplianceModule(h.deps);
    h.services.compliance = compliance;
    await compliance.init?.();

    // 1. Create and publish v1.0 of a required typed-signature customer policy, then accept across sources
    const createdDoc = await compliance.policies.admin.createDocument(localAdminFresh, {
      slug: "d1-master-terms",
      title: "D1 Master Service Terms",
      audience: "customer",
      requiresAcceptance: true,
      requiresTypedSignature: true,
      versionLabel: "1.0",
      contentFormat: "safe_markdown",
      bodyText: "## Master Terms v1.0\n\nCustomer agrees to the version 1.0 service terms.",
      changeSummary: "Initial publication",
    });
    gatedPolicyPubId = createdDoc.documentPublicId;
    await compliance.policies.admin.publishVersion(localAdminFresh, {
      versionPublicId: createdDoc.draftVersionPublicId,
      effectiveAt: baseTime,
    });

    // Optional informational policy (`requiresAcceptance: false`) to test `not_required` state in `forCustomer`
    const optionalDoc = await compliance.policies.admin.createDocument(localAdminFresh, {
      slug: "d1-privacy-notice",
      title: "D1 Privacy Notice",
      audience: "customer",
      requiresAcceptance: false,
      requiresTypedSignature: false,
      versionLabel: "2026.1",
      contentFormat: "plain_text",
      bodyText: "Informational privacy notice that does not require active acceptance.",
    });
    await compliance.policies.admin.publishVersion(localAdminFresh, {
      versionPublicId: optionalDoc.draftVersionPublicId,
      effectiveAt: baseTime,
    });

    // a) Registration acceptance for d1CustB on v1.0 (eventually superseded when v2.0 is published)
    h.clock.advance(1_000);
    await runWithRequestContext(
      Object.assign(newRequestContext("http"), { ipAddress: "198.51.100.10" }),
      () =>
        compliance.recordRegistrationAcceptances({
          userId: d1CustBPrincipal.userId,
          items: [
            {
              versionPublicId: createdDoc.draftVersionPublicId,
              contentHash: createdDoc.contentHash,
              signerName: "Bob Prior",
            },
          ],
        }),
    );

    // b) Portal acceptance for d1CustA on v1.0 (typed signature)
    h.clock.advance(1_000);
    const v1PortalAcc = await runWithRequestContext(
      Object.assign(newRequestContext("http"), { ipAddress: "198.51.100.11" }),
      () =>
        compliance.policies.accept(d1CustAPrincipal, {
          versionPublicId: createdDoc.draftVersionPublicId,
          contentHash: createdDoc.contentHash,
          signerName: "Clara Signer",
        }),
    );

    // Publish v2.0 so v1.0 becomes `superseded` and v2.0 becomes `current`!
    h.clock.advance(2_000);
    const v2Now = h.clock.now();
    localAdminFresh.stepUpAt = v2Now;
    sessionRegistry.get(localAdminFresh.sessionId)!.stepUpAt = v2Now;
    const draftV2 = await compliance.policies.admin.createDraftVersion(localAdminFresh, {
      documentPublicId: createdDoc.documentPublicId,
      versionLabel: "2.0",
      contentFormat: "safe_markdown",
      bodyText: "## Master Terms v2.0\n\nUpdated terms requiring customer re-acceptance.",
      changeSummary: "Added SLA schedule",
    });
    await compliance.policies.admin.publishVersion(localAdminFresh, {
      versionPublicId: draftV2.versionPublicId,
      effectiveAt: v2Now,
    });

    // Draft v3.0 (unpublished) — must NOT appear in `updates`, `filterOptions`, or `versionText`!
    const draftV3 = await compliance.policies.admin.createDraftVersion(localAdminFresh, {
      documentPublicId: createdDoc.documentPublicId,
      versionLabel: "3.0-draft",
      contentFormat: "plain_text",
      bodyText: "Unpublished draft version 3.0 text that should never appear in versionText.",
    });

    // c) Portal re-acceptance by d1CustA on v2.0 (`portal_reacceptance`)
    h.clock.advance(1_000);
    const v2Reaccept = await runWithRequestContext(
      Object.assign(newRequestContext("http"), { ipAddress: "198.51.100.11" }),
      () =>
        compliance.policies.accept(d1CustAPrincipal, {
          versionPublicId: draftV2.versionPublicId,
          contentHash: draftV2.contentHash,
          signerName: "Clara Signer",
        }),
    );

    // d) Checkout acceptance by formulaCustomer on v2.0 (`checkout`)
    h.clock.advance(1_000);
    await tdb.db.transaction((tx) =>
      compliance.recordCheckoutAcceptances(
        {
          principal: formulaCustomerPrincipal,
          orderId: checkoutOrder.id,
          orderPublicId: checkoutOrder.publicId,
          items: [
            {
              versionPublicId: draftV2.versionPublicId,
              contentHash: draftV2.contentHash,
              signerName: "=CMD|' /C calc'!A0",
            },
          ],
        },
        tx,
      ),
    );

    // e) Order-gate acceptance by d1CustA on v2.0 (`order_gate` in `order_policy_acceptances` with typed signature)
    h.clock.advance(1_000);
    const gateReceipt = await runWithRequestContext(
      Object.assign(newRequestContext("http"), { ipAddress: "198.51.100.11" }),
      () =>
        compliance.acceptance.accept(d1CustAPrincipal, {
          orderId: gateOrder.publicId,
          gateKey: "order_start",
          policyVersionId: draftV2.versionPublicId,
          textSha256: draftV2.contentHash,
          typedName: "Clara Signer",
        }),
    );

    const log = compliance.policies.admin.acceptanceLog;

    // 2. §4 Authorization invariants: customer gets NOT_FOUND on EVERY admin procedure; staff gets FORBIDDEN on export
    await expect(log.filterOptions(d1CustAPrincipal)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(log.list(d1CustAPrincipal, {})).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      log.detail(d1CustAPrincipal, { publicId: v2Reaccept.acceptancePublicId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(log.coverage(d1CustAPrincipal, {})).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(log.updates(d1CustAPrincipal, {})).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      log.forCustomer(d1CustAPrincipal, { customerPublicId: d1CustAPubId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      log.versionText(d1CustAPrincipal, { versionPublicId: draftV2.versionPublicId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(log.export(d1CustAPrincipal, {})).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Staff has `policies.acceptances.read` -> can read, but gets FORBIDDEN on `export`
    await expect(log.export(localStaff, {})).rejects.toMatchObject({
      code: "FORBIDDEN",
      reasonCode: "CAPABILITY_NOT_GRANTED",
    });

    // Admin with stale step-up gets STEP_UP_REQUIRED on `export`
    await expect(log.export(localAdminStaleStepUp, {})).rejects.toMatchObject({
      code: "STEP_UP_REQUIRED",
      reasonCode: "STEP_UP_REQUIRED",
    });

    // 2b. Session-binding hardening: missing session port, userId mismatch, role mismatch, and `assertCurrent` revocation before signer decrypt
    const hijackedSessionPrincipal = fakePrincipal({
      ...localStaff,
      sessionId: d1CustAPrincipal.sessionId, // belongs to a different userId!
    });
    await expect(log.list(hijackedSessionPrincipal, {})).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      reasonCode: "SESSION_NOT_CURRENT",
    });

    const roleMismatchSessionId = ulid(baseTime.getTime() + 950);
    sessionRegistry.set(roleMismatchSessionId, {
      sessionId: roleMismatchSessionId,
      userId: localStaff.userId,
      userPublicId: localStaff.userPublicId,
      role: "admin", // mismatches persisted `staff` role!
      userStatus: "active",
      live: true,
      stepUpAt: baseTime,
      mfaVerifiedAt: baseTime,
      authMethod: "local",
    });
    await expect(
      log.list(fakePrincipal({ ...localStaff, sessionId: roleMismatchSessionId }), {}),
    ).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      reasonCode: "SESSION_NOT_CURRENT",
    });

    const savedIdentity = h.services.identity;
    h.services.identity = {} as unknown as typeof h.services.identity;
    try {
      await expect(log.list(localStaff, {})).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
        reasonCode: "SESSION_NOT_CURRENT",
      });
    } finally {
      h.services.identity = savedIdentity;
    }

    // `detail` with `policies.manage` calls `sessions.assertCurrent` BEFORE decrypting `typedSignerName`
    const adminRec = sessionRegistry.get(localAdminFresh.sessionId)!;
    adminRec.assertCurrentError = new DomainError(
      "UNAUTHENTICATED",
      "SESSION_NOT_CURRENT",
      "Revoked right before signer decrypt.",
    );
    try {
      await expect(
        log.detail(localAdminFresh, { publicId: v1PortalAcc.acceptancePublicId }),
      ).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
        reasonCode: "SESSION_NOT_CURRENT",
      });
    } finally {
      delete adminRec.assertCurrentError;
    }

    // 3. `filterOptions` & `versionText`
    const opts = await log.filterOptions(localStaff);
    const masterOpt = opts.policies.find((p) => p.documentPublicId === createdDoc.documentPublicId);
    expect(masterOpt).toBeDefined();
    expect(masterOpt?.versions.map((v) => v.versionLabel)).toEqual(["2.0", "1.0"]);
    expect(masterOpt?.versions[0]?.isCurrent).toBe(true);
    expect(masterOpt?.versions[1]?.isCurrent).toBe(false);

    const v2Text = await log.versionText(localStaff, { versionPublicId: draftV2.versionPublicId });
    expect(v2Text.versionLabel).toBe("2.0");
    expect(v2Text.isCurrent).toBe(true);
    expect(v2Text.bodyText).toContain("Master Terms v2.0");
    await expect(
      log.versionText(localStaff, { versionPublicId: draftV3.versionPublicId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // 4. Unified `list`: merges `order_gate` + `checkout` + `portal_reacceptance` + `portal_acceptance` + `registration`
    //    newest-first, paginates cleanly with cursor, and omits `typedSignerName` from raw objects!
    const page1 = await log.list(localStaff, {
      policyDocumentPublicId: createdDoc.documentPublicId,
      limit: 2,
    });
    expect(page1.items).toHaveLength(2);
    expect(page1.items[0]?.source).toBe("order_gate");
    expect(page1.items[0]?.evidenceKind).toBe("order_gate");
    expect(page1.items[0]?.orderReference).toBe("RP-2026-0801");
    expect(page1.items[0]?.freshness).toBe("current");
    expect(page1.items[1]?.source).toBe("checkout");
    expect(page1.items[1]?.orderReference).toBe("RP-2026-0802");
    expect(page1.nextCursor).toBeTruthy();

    const page2 = await log.list(localStaff, {
      policyDocumentPublicId: createdDoc.documentPublicId,
      cursor: page1.nextCursor!,
      limit: 10,
    });
    expect(page2.items.map((i) => i.source)).toEqual([
      "portal_reacceptance",
      "portal_acceptance",
      "registration",
    ]);
    expect(page2.items[0]?.freshness).toBe("current");
    expect(page2.items[1]?.freshness).toBe("superseded");
    expect(page2.items[1]?.supersededByVersionPublicId).toBe(draftV2.versionPublicId);
    expect(page2.items[1]?.supersededByVersionLabel).toBe("2.0");
    expect(page2.nextCursor).toBeNull();

    // Signer name MUST be completely absent (not even null/masked) from raw list payloads
    for (const item of [...page1.items, ...page2.items]) {
      expect("typedSignerName" in item).toBe(false);
      expect("signerNameEnc" in item).toBe(false);
      expect("signerNameRedacted" in item).toBe(false);
    }

    // Filter checks: source, freshness, orderReference, customerQuery
    const onlyGate = await log.list(localStaff, {
      policyDocumentPublicId: createdDoc.documentPublicId,
      source: "order_gate",
    });
    expect(onlyGate.items).toHaveLength(1);
    expect(onlyGate.items[0]?.publicId).toBe(gateReceipt.receipt.receiptId);

    const onlySuperseded = await log.list(localStaff, {
      policyDocumentPublicId: createdDoc.documentPublicId,
      freshness: "superseded",
    });
    expect(onlySuperseded.items).toHaveLength(2);
    expect(onlySuperseded.items.every((i) => i.versionLabel === "1.0")).toBe(true);

    const byOrderRef = await log.list(localStaff, { orderReference: "RP-2026-0802" });
    expect(byOrderRef.items).toHaveLength(1);
    expect(byOrderRef.items[0]?.source).toBe("checkout");

    const byCustRef = await log.list(localStaff, { customerQuery: "CUST-9901" });
    expect(byCustRef.items).toHaveLength(1);
    expect(byCustRef.items[0]?.customer?.userPublicId).toBe(formulaCustomerPubId);

    // Same IP address produces identical HMAC pseudonym across `policy_acceptances` and `order_policy_acceptances`
    expect(page1.items[0]?.addressPseudonym).toBeTruthy();
    expect(page1.items[0]?.addressPseudonym).toBe(page2.items[0]?.addressPseudonym);

    // 4b. Bounded scan ceiling (`maxScannedRows: 1`): sparse post-refinement filter (`portal_acceptance`,
    //     where newest `context='portal'` row is `portal_reacceptance` and gets dropped!)
    //     caps page 1 at 0 items with a valid frontier `nextCursor`, recovers `v1PortalAcc` on page 2,
    //     and sets `truncated: true` + `scan_capped: true` on `export`!
    const boundedLog = createAcceptanceLogService(h.deps, { maxScannedRows: 1 });
    const walkedIds: string[] = [];
    let walkCursor: string | undefined;
    let walkLoops = 0;
    do {
      const step = await boundedLog.list(localStaff, {
        policyDocumentPublicId: createdDoc.documentPublicId,
        source: "portal_acceptance",
        limit: 10,
        ...(walkCursor ? { cursor: walkCursor } : {}),
      });
      if (walkLoops === 0) {
        // Page 1 scanned 1 row (`v2Reaccept`, dropped by refinement) -> 0 items + non-null frontier cursor!
        expect(step.items).toHaveLength(0);
        expect(step.nextCursor).toBeTruthy();
      }
      walkedIds.push(...step.items.map((i) => i.publicId));
      walkCursor = step.nextCursor ?? undefined;
      walkLoops += 1;
      expect(walkLoops).toBeLessThanOrEqual(5);
    } while (walkCursor);
    expect(walkLoops).toBe(2);
    expect(walkedIds).toEqual([v1PortalAcc.acceptancePublicId]);

    h.audit.clear();
    const nowBeforeCapExport = h.clock.now();
    localAdminFresh.stepUpAt = nowBeforeCapExport;
    sessionRegistry.get(localAdminFresh.sessionId)!.stepUpAt = nowBeforeCapExport;
    const cappedExport = await boundedLog.export(localAdminFresh, {
      policyDocumentPublicId: createdDoc.documentPublicId,
      source: "portal_acceptance",
    });
    expect(cappedExport.rowCount).toBe(0);
    expect(cappedExport.truncated).toBe(true);
    expect(h.audit.named("policy.acceptance_log.exported")[0]?.attributes).toMatchObject({
      truncated: true,
      scan_capped: true,
      max_scanned_rows: 1,
    });

    // 5. Signer-name privacy on `detail` (staff redacted vs admin decrypted, for BOTH account & order_gate rows)
    const staffAcctDetail = await log.detail(localStaff, { publicId: v1PortalAcc.acceptancePublicId });
    expect(staffAcctDetail.hasTypedSignature).toBe(true);
    expect(staffAcctDetail.typedSignerName).toBeNull();
    expect(staffAcctDetail.signerNameRedacted).toBe(true);

    const adminAcctDetail = await log.detail(localAdminFresh, {
      publicId: v1PortalAcc.acceptancePublicId,
    });
    expect(adminAcctDetail.typedSignerName).toBe("Clara Signer");
    expect(adminAcctDetail.signerNameRedacted).toBe(false);

    const staffGateDetail = await log.detail(localStaff, { publicId: gateReceipt.receipt.receiptId });
    expect(staffGateDetail.typedSignerName).toBeNull();
    expect(staffGateDetail.signerNameRedacted).toBe(true);

    const adminGateDetail = await log.detail(localAdminFresh, { publicId: gateReceipt.receipt.receiptId });
    expect(adminGateDetail.typedSignerName).toBe("Clara Signer");
    expect(adminGateDetail.signerNameRedacted).toBe(false);

    // 6. `coverage`: d1CustA & formulaCustomer accepted v2.0; d1CustB accepted v1.0 (outstanding with prior v1.0); viewer never accepted
    const cov = await log.coverage(localStaff, {
      documentPublicId: createdDoc.documentPublicId,
    });
    const docCov = cov.policies[0]!;
    expect(docCov.currentVersionLabel).toBe("2.0");
    expect(docCov.acceptedCurrentCount).toBe(2);
    expect(docCov.outstandingCount).toBe(docCov.activeCustomerCount - 2);
    const bobOut = docCov.outstandingCustomers.find(
      (c) => c.customer.userPublicId === d1CustBPubId,
    );
    expect(bobOut?.lastAcceptedVersionLabel).toBe("1.0");
    const veraOut = docCov.outstandingCustomers.find(
      (c) => c.customer.userPublicId === viewerPrincipal.userPublicId,
    );
    expect(veraOut?.lastAcceptedVersionPublicId).toBeNull();

    const covTrunc = await log.coverage(localStaff, {
      documentPublicId: createdDoc.documentPublicId,
      outstandingLimit: 1,
    });
    expect(covTrunc.policies[0]?.outstandingCustomers).toHaveLength(1);
    expect(covTrunc.policies[0]?.outstandingTruncated).toBe(true);

    // 7. `updates`: published versions newest-first with distinct customer counts
    const upd = await log.updates(localStaff, {
      documentPublicId: createdDoc.documentPublicId,
    });
    expect(upd.items.map((u) => u.versionLabel)).toEqual(["2.0", "1.0"]);
    expect(upd.items[0]?.isCurrent).toBe(true);
    expect(upd.items[0]?.acceptedCustomerCount).toBe(2);
    expect(upd.items[1]?.isCurrent).toBe(false);
    expect(upd.items[1]?.acceptedCustomerCount).toBe(2);

    // 8. `forCustomer`: current status across required & optional policies + unified history (no signer name!)
    const bobProfile = await log.forCustomer(localStaff, {
      customerPublicId: d1CustBPubId,
    });
    const bobMaster = bobProfile.policies.find(
      (p) => p.documentPublicId === createdDoc.documentPublicId,
    );
    expect(bobMaster?.state).toBe("update_pending");
    expect(bobMaster?.acceptedVersionLabel).toBe("1.0");
    const bobOptional = bobProfile.policies.find(
      (p) => p.documentPublicId === optionalDoc.documentPublicId,
    );
    expect(bobOptional?.state).toBe("not_required");
    for (const hItem of bobProfile.history) {
      expect("typedSignerName" in hItem).toBe(false);
    }
    // Non-customer (staff/admin) publicId -> NOT_FOUND (no role existence oracle)
    await expect(
      log.forCustomer(localStaff, { customerPublicId: localStaff.userPublicId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // 9. `export`: formula neutralization, no signer name column/value, transactional audit `policy.acceptance_log.exported`
    h.audit.clear();
    const exportNow = h.clock.now();
    localAdminFresh.stepUpAt = exportNow;
    sessionRegistry.get(localAdminFresh.sessionId)!.stepUpAt = exportNow;
    const exported = await log.export(localAdminFresh, {
      policyDocumentPublicId: createdDoc.documentPublicId,
    });
    expect(exported.contentType).toBe("text/csv; charset=utf-8");
    expect(exported.rowCount).toBe(5);
    expect(exported.truncated).toBe(false);
    const csvLines = exported.csv.trim().split("\r\n");
    expect(csvLines[0]).toBe(
      "evidence_public_id,accepted_at_utc,customer_public_id,customer_reference,customer_name,customer_email,policy_slug,policy_title,version_number,version_label,content_sha256,freshness,source,method,order_reference,correlation_id",
    );
    expect(csvLines[0]).not.toContain("signer");
    // Formula payload `=CMD|' /C calc'!A0` is neutralized with a leading single quote `'`!
    expect(exported.csv).toContain("'=CMD|' /C calc'!A0");
    expect(exported.csv).not.toContain(",=CMD|");
    // Plaintext signer names for non-formula customers must not appear as a signer column
    expect(csvLines.every((line) => line.split(",").length >= 16)).toBe(true);

    const exportAudits = h.audit.named("policy.acceptance_log.exported");
    expect(exportAudits).toHaveLength(1);
    expect(exportAudits[0]?.attributes).toMatchObject({
      filter_summary: "policy",
      row_count: 5,
      truncated: false,
      scan_capped: false,
      policy_document_public_id: createdDoc.documentPublicId,
    });
    const exportAuditIdx = h.audit.events.findIndex(
      (e) => e.eventName === "policy.acceptance_log.exported",
    );
    expect(h.audit.recordedInTx[exportAuditIdx]).toBe(true);

    // 10. End-to-end tRPC router check (`compliance.policies.admin.acceptanceLog.*`)
    const makeTrpcCtx = (principal: SessionPrincipal) => ({
      services: h.services,
      session: principal,
      request: newRequestContext("http"),
      transport: "cookie" as const,
    });
    const customerCaller = complianceRouter.createCaller(makeTrpcCtx(d1CustAPrincipal) as never);
    await expect(
      customerCaller.policies.admin.acceptanceLog.list({}),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const staffCaller = complianceRouter.createCaller(makeTrpcCtx(localStaff) as never);
    const routerList = await staffCaller.policies.admin.acceptanceLog.list({
      policyDocumentPublicId: createdDoc.documentPublicId,
      limit: 5,
    });
    expect(routerList.items).toHaveLength(5);
    expect(routerList.items.every((it) => !("typedSignerName" in it))).toBe(true);
    await expect(
      staffCaller.policies.admin.acceptanceLog.export({}),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
