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
import { createComplianceModule } from "./index.js";
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
      statusKey: "in_progress",
      lockState: order.lockState,
      locked: order.lockState !== "none",
      readOnlyImported: order.origin === "import" || order.lockState === "imported_read_only",
      accessRole: role,
      canWrite: order.lockState === "none" && order.origin === "portal" && role !== "viewer",
      origin: order.origin,
      version: 1,
      workflowVersionId: 1,
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
        ownerUserId: o.ownerUserId,
        lockState: o.lockState,
        statusKey: "in_progress",
      };
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
});
