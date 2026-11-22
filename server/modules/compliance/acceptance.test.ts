/**
 * Package V — order policy acceptance gateway on an isolated MySQL database (synthetic data only).
 * The orders gate port is a local fake implementing the agreed contract (context + assertCustomerMayWork
 * delegating to the registered provider). Covers order_start and named-step gates, cross-customer probe,
 * replay for another order, stale text hash, grantee accepts separately, staff bypass, re-ask on a new
 * version, typed-name validation, unpublished policy fails closed, console address visibility, receipts.
 */
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { newRequestContext, runWithRequestContext } from "../../core/requestContext.js";
import type { SessionPrincipal, Tx } from "../../core/types.js";
import type { UserRole } from "../../../shared/domain.js";
import { createTestDeps, fakePrincipal, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { users } from "../identity/schema.js";
import { nameAad } from "../identity/users.js";
import { createAcceptanceService, gatesForPoint, normalizeTypedName, type AcceptanceGate, type AcceptanceService, type AssertMetInput, type OrderGateContext } from "./acceptance.js";
import { orderPolicyAcceptances } from "./acceptanceSchema.js";
import { normalizePolicyBody } from "./domain.js";
import { policyDocuments, policyVersions } from "./schema.js";

const IP = "198.51.100.23";
const UA = "Mozilla/5.0 (Macintosh) Safari/17.0";

async function rejects(promise: Promise<unknown>, code: string, reasonCode: string): Promise<void> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(DomainError);
  expect({ code: (error as DomainError).code, reasonCode: (error as DomainError).reasonCode }).toEqual({ code, reasonCode });
}

describe("acceptance helpers (pure)", () => {
  it("typed names are NFC, collapsed, 2–120 characters with a letter and no control characters", () => {
    expect(normalizeTypedName("  Ana   María  ")).toBe("Ana María");
    expect(normalizeTypedName("A")).toBeNull();
    expect(normalizeTypedName("12345")).toBeNull();
    expect(normalizeTypedName("Ana\u0000Bad")).toBeNull();
    expect(normalizeTypedName("x".repeat(121))).toBeNull();
  });
  it("order_start gates always apply; step gates only on their step", () => {
    const gates: AcceptanceGate[] = [
      { key: "terms", policyPublicId: "P", point: "order_start", signatureMode: "checkbox", askAgainOnNewVersion: false },
      { key: "release", policyPublicId: "Q", point: { stepKey: "review" }, signatureMode: "typed_name", askAgainOnNewVersion: false },
    ];
    expect(gatesForPoint(gates, { kind: "order_start" }).map((g) => g.key)).toEqual(["terms"]);
    expect(gatesForPoint(gates, { kind: "step", stepKey: "review" }).map((g) => g.key)).toEqual(["terms", "release"]);
    expect(gatesForPoint(gates, { kind: "step", stepKey: "intake" }).map((g) => g.key)).toEqual(["terms"]);
  });
});

describe("order acceptance gateway (MySQL)", () => {
  let db: TestDb;
  let h: TestHarness;
  let svc: AcceptanceService;
  let provider: { assertMet(input: AssertMetInput): Promise<void> } | null;

  interface FakeOrder { id: number; publicId: string; reference: string; ownerUserId: number; grantees: Set<number>; statusKey: string; gates: AcceptanceGate[]; workflowVersionId: number }
  const orders = new Map<string, FakeOrder>();
  let orderSeq = 0;
  let userSeq = 0;

  const at = <T>(fn: () => Promise<T>) => runWithRequestContext(newRequestContext("test", { ipAddress: IP, userAgent: UA }), fn);

  function build() {
    h = createTestDeps({ db: db.db });
    provider = null;
    const gates = {
      async context(orderPublicId: string, actor: SessionPrincipal): Promise<OrderGateContext | null> {
        const o = orders.get(orderPublicId);
        if (!o) return null;
        const access = actor.role === "staff" || actor.role === "admin" ? "staff" : o.ownerUserId === actor.userId ? "owner" : o.grantees.has(actor.userId) ? "grantee" : null;
        if (!access) return null;
        return { orderId: o.id, orderPublicId: o.publicId, reference: o.reference, name: `Project ${o.id}`, customerUserId: o.ownerUserId, workflowVersionId: o.workflowVersionId, currentStatusKey: o.statusKey, gates: o.gates, actorAccess: access };
      },
      registerProvider(key: "acceptance", impl: { assertMet(input: AssertMetInput): Promise<void> }) {
        if (key === "acceptance") provider = impl;
      },
    };
    (h.services as unknown as Record<string, unknown>).orders = { gates };
    svc = createAcceptanceService(h.deps);
    svc.register();
    expect(provider).not.toBeNull();
  }

  /** What orders.gates.assertCustomerMayWork does: staff skip, then the provider. */
  async function mayWork(order: FakeOrder, actor: SessionPrincipal, statusKey: string | null = null): Promise<void> {
    if (actor.role !== "customer") return;
    const step = statusKey ?? order.statusKey;
    await db.db.transaction((tx) =>
      provider!.assertMet({ tx: tx as Tx, orderId: order.id, workflowVersionId: order.workflowVersionId, gates: order.gates, actor: { userId: actor.userId, role: actor.role }, point: { kind: "step", stepKey: step } }),
    );
  }

  async function makeUser(role: UserRole = "customer"): Promise<SessionPrincipal> {
    userSeq += 1;
    const publicId = ulid();
    const name = `Synthetic Signer ${userSeq}`;
    const now = h.clock.now();
    const [res] = await db.db.insert(users).values({
      publicId, emailEnc: `enc:${publicId}`, emailIndex: randomBytes(32).toString("hex"), nameEnc: h.deps.crypto.encrypt(name, nameAad(publicId)),
      role, status: "active", emailVerifiedAt: now, createdAt: now, updatedAt: now,
    });
    return fakePrincipal({ userId: res.insertId, userPublicId: publicId, role });
  }

  async function makePolicy(body = "You agree to the synthetic terms.", audience: "customer" | "all" | "staff" = "customer"): Promise<{ documentPublicId: string; documentId: number }> {
    const publicId = ulid();
    const now = h.clock.now();
    const [doc] = await db.db.insert(policyDocuments).values({ publicId, slug: `p-${publicId.toLowerCase()}`, title: `Policy ${publicId.slice(-4)}`, audience, createdAt: now, updatedAt: now });
    const documentId = doc.insertId;
    await publishVersion(documentId, 1, body);
    return { documentPublicId: publicId, documentId };
  }

  async function publishVersion(documentId: number, versionNumber: number, body: string) {
    const normalized = normalizePolicyBody(body);
    const now = h.clock.now();
    await db.db.insert(policyVersions).values({
      publicId: ulid(), documentId, versionNumber, versionLabel: `v${versionNumber}`, status: "published", contentFormat: "plain_text",
      bodyText: normalized, contentHash: createHash("sha256").update(normalized, "utf8").digest("hex"),
      effectiveAt: new Date(now.getTime() - 1000), publishedAt: now, createdAt: now, updatedAt: now,
    });
  }

  function makeOrder(owner: SessionPrincipal, gates: AcceptanceGate[], statusKey = "intake"): FakeOrder {
    orderSeq += 1;
    const order: FakeOrder = { id: 5000 + orderSeq, publicId: ulid(), reference: `RP-${1000 + orderSeq}`, ownerUserId: owner.userId, grantees: new Set(), statusKey, gates, workflowVersionId: 7 };
    orders.set(order.publicId, order);
    return order;
  }

  const gate = (policyPublicId: string, patch: Partial<AcceptanceGate> = {}): AcceptanceGate => ({ key: "terms", policyPublicId, point: "order_start", signatureMode: "checkbox", askAgainOnNewVersion: false, ...patch });

  async function acceptCurrent(actor: SessionPrincipal, order: FakeOrder, gateKey = "terms", typedName?: string) {
    const view = await svc.forOrder(actor, { orderId: order.publicId });
    const g = view.gates.find((x) => x.key === gateKey)!;
    return at(() => svc.accept(actor, { orderId: order.publicId, gateKey, policyVersionId: g.policy!.versionId, textSha256: g.policy!.textSha256, ...(typedName ? { typedName } : {}) }));
  }

  beforeAll(async () => {
    db = await createTestDb({ schema: { users, policyDocuments, policyVersions, orderPolicyAcceptances } });
  });
  afterAll(async () => db?.cleanup());
  beforeEach(() => build());

  it("order_start gate: blocks customer work until accepted; evidence bound to text hash, encrypted address, user agent; idempotent", async () => {
    const owner = await makeUser();
    const policy = await makePolicy();
    const order = makeOrder(owner, [gate(policy.documentPublicId)]);
    await rejects(mayWork(order, owner), "CONFLICT", "ORDER_ACCEPTANCE_REQUIRED");
    const before = await svc.forOrder(owner, { orderId: order.publicId });
    expect(before.blocking).toBe(true);
    expect(before.gates[0]!.policy!.text).toContain("synthetic terms");

    const first = await acceptCurrent(owner, order);
    expect(first.duplicate).toBe(false);
    await mayWork(order, owner);
    expect((await svc.forOrder(owner, { orderId: order.publicId })).blocking).toBe(false);

    const again = await acceptCurrent(owner, order);
    expect(again.duplicate).toBe(true);
    expect(again.receipt.receiptId).toBe(first.receipt.receiptId);
    expect(h.audit.named("order.acceptance.recorded")).toHaveLength(1);

    const rows = await db.db.select().from(orderPolicyAcceptances).where(eq(orderPolicyAcceptances.orderId, order.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textSha256).toBe(before.gates[0]!.policy!.textSha256);
    expect(rows[0]!.sourceAddressEnc).not.toContain(IP);
    expect(rows[0]!.userAgent).toBe(UA);
    expect(JSON.stringify(h.audit.events)).not.toContain(IP);
  });

  it("named-step gate applies only on that step (typed signature required and stored encrypted)", async () => {
    const owner = await makeUser();
    const policy = await makePolicy("Release terms for review.");
    const order = makeOrder(owner, [gate(policy.documentPublicId, { key: "release", point: { stepKey: "review" }, signatureMode: "typed_name" })]);
    await mayWork(order, owner, "intake");
    await rejects(mayWork(order, owner, "review"), "CONFLICT", "ORDER_ACCEPTANCE_REQUIRED");
    await rejects(acceptCurrent(owner, order, "release"), "VALIDATION", "TYPED_NAME_REQUIRED");
    await rejects(acceptCurrent(owner, order, "release", "1"), "VALIDATION", "TYPED_NAME_REQUIRED");
    const done = await acceptCurrent(owner, order, "release", "  Synthetic   Signer ");
    expect(done.receipt.typedName).toBe("Synthetic Signer");
    expect(done.receipt.signatureMode).toBe("typed_name");
    const [row] = await db.db.select().from(orderPolicyAcceptances).where(eq(orderPolicyAcceptances.publicId, done.receipt.receiptId));
    expect(row!.typedNameEnc).not.toContain("Synthetic");
    await mayWork(order, owner, "review");
  });

  it("cross-customer probe: another customer can't read gates, accept or read the receipt (NOT_FOUND)", async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const policy = await makePolicy();
    const order = makeOrder(owner, [gate(policy.documentPublicId)]);
    const view = await svc.forOrder(owner, { orderId: order.publicId });
    const g = view.gates[0]!;
    await rejects(svc.forOrder(stranger, { orderId: order.publicId }), "NOT_FOUND", "ORDER_NOT_FOUND");
    await rejects(at(() => svc.accept(stranger, { orderId: order.publicId, gateKey: "terms", policyVersionId: g.policy!.versionId, textSha256: g.policy!.textSha256 })), "NOT_FOUND", "ORDER_NOT_FOUND");
    const done = await acceptCurrent(owner, order);
    await rejects(svc.receipt(stranger, { receiptId: done.receipt.receiptId }), "NOT_FOUND", "RECEIPT_NOT_FOUND");
    await rejects(svc.consoleList(stranger, { orderId: order.publicId }), "FORBIDDEN", "CONSOLE_ONLY");
    expect((await svc.receipt(owner, { receiptId: done.receipt.receiptId })).order.reference).toBe(order.reference);
  });

  it("an acceptance can't be replayed for another order (evidence is order-bound)", async () => {
    const owner = await makeUser();
    const policy = await makePolicy();
    const a = makeOrder(owner, [gate(policy.documentPublicId)]);
    const b = makeOrder(owner, [gate(policy.documentPublicId)]);
    await acceptCurrent(owner, a);
    await mayWork(a, owner);
    await rejects(mayWork(b, owner), "CONFLICT", "ORDER_ACCEPTANCE_REQUIRED");
    expect((await svc.forOrder(owner, { orderId: b.publicId })).blocking).toBe(true);
  });

  it("a stale text hash or an older version id is refused (CONFLICT / POLICY_TEXT_CHANGED)", async () => {
    const owner = await makeUser();
    const policy = await makePolicy();
    const order = makeOrder(owner, [gate(policy.documentPublicId)]);
    const old = (await svc.forOrder(owner, { orderId: order.publicId })).gates[0]!.policy!;
    await rejects(at(() => svc.accept(owner, { orderId: order.publicId, gateKey: "terms", policyVersionId: old.versionId, textSha256: "0".repeat(64) })), "CONFLICT", "POLICY_TEXT_CHANGED");
    await publishVersion(policy.documentId, 2, "Updated synthetic terms.");
    await rejects(at(() => svc.accept(owner, { orderId: order.publicId, gateKey: "terms", policyVersionId: old.versionId, textSha256: old.textSha256 })), "CONFLICT", "POLICY_TEXT_CHANGED");
    await rejects(at(() => svc.accept(owner, { orderId: order.publicId, gateKey: "nope", policyVersionId: old.versionId, textSha256: old.textSha256 })), "NOT_FOUND", "GATE_NOT_FOUND");
  });

  it("a person with access must accept separately; console lists both with roles", async () => {
    const owner = await makeUser();
    const grantee = await makeUser();
    const admin = await makeUser("admin");
    const policy = await makePolicy();
    const order = makeOrder(owner, [gate(policy.documentPublicId)]);
    order.grantees.add(grantee.userId);
    await acceptCurrent(owner, order);
    await mayWork(order, owner);
    await rejects(mayWork(order, grantee), "CONFLICT", "ORDER_ACCEPTANCE_REQUIRED");
    const g = await acceptCurrent(grantee, order);
    await mayWork(order, grantee);
    await rejects(svc.receipt(owner, { receiptId: g.receipt.receiptId }), "NOT_FOUND", "RECEIPT_NOT_FOUND");
    const list = await svc.consoleList(admin, { orderId: order.publicId });
    expect(list.total).toBe(2);
    expect(list.items.map((i) => i.signerRole).sort()).toEqual(["grantee", "owner"]);
    expect(list.items.every((i) => i.signerName.startsWith("Synthetic Signer"))).toBe(true);
    expect((await svc.consoleCount(admin, { orderId: order.publicId })).total).toBe(2);
  });

  it("staff are not gated and can't record acceptances; source address shown only with sessions.read_all", async () => {
    const owner = await makeUser();
    const staff = await makeUser("staff");
    const admin = await makeUser("admin");
    const policy = await makePolicy();
    const order = makeOrder(owner, [gate(policy.documentPublicId)]);
    await db.db.transaction((tx) =>
      provider!.assertMet({ tx: tx as Tx, orderId: order.id, workflowVersionId: order.workflowVersionId, gates: order.gates, actor: { userId: staff.userId, role: "staff" }, point: { kind: "order_start" } }),
    );
    const staffView = await svc.forOrder(staff, { orderId: order.publicId });
    expect(staffView.blocking).toBe(false);
    expect(staffView.gates[0]!.required).toBe(false);
    const g = staffView.gates[0]!.policy!;
    await rejects(at(() => svc.accept(staff, { orderId: order.publicId, gateKey: "terms", policyVersionId: g.versionId, textSha256: g.textSha256 })), "FORBIDDEN", "STAFF_NOT_GATED");
    const done = await acceptCurrent(owner, order);
    const asStaff = await svc.consoleList(staff, { orderId: order.publicId });
    expect(asStaff.items[0]!.sourceAddress).toBeNull();
    const asAdmin = await svc.consoleList(admin, { orderId: order.publicId });
    expect(asAdmin.items[0]!.sourceAddress).toBe(IP);
    expect(h.audit.named("order.acceptance.addresses_viewed")).toHaveLength(1);
    expect((await svc.receipt(staff, { receiptId: done.receipt.receiptId })).receiptId).toBe(done.receipt.receiptId);
  });

  it("ask again on a new version re-gates; without it an older acceptance still counts", async () => {
    const owner = await makeUser();
    const policy = await makePolicy();
    const strict = makeOrder(owner, [gate(policy.documentPublicId, { askAgainOnNewVersion: true })]);
    const relaxed = makeOrder(owner, [gate(policy.documentPublicId, { askAgainOnNewVersion: false })]);
    await acceptCurrent(owner, strict);
    await acceptCurrent(owner, relaxed);
    h.clock.advance(5_000);
    await publishVersion(policy.documentId, 2, "Version two of the synthetic terms.");
    await rejects(mayWork(strict, owner), "CONFLICT", "ORDER_ACCEPTANCE_REQUIRED");
    await mayWork(relaxed, owner);
    const view = await svc.forOrder(owner, { orderId: strict.publicId });
    expect(view.gates[0]!.policy!.versionNumber).toBe(2);
    expect(view.gates[0]!.met).toBe(false);
    await acceptCurrent(owner, strict);
    await mayWork(strict, owner);
  });

  it("a gate whose policy has no published version fails closed", async () => {
    const owner = await makeUser();
    const order = makeOrder(owner, [gate(ulid())]);
    await rejects(mayWork(order, owner), "CONFLICT", "ORDER_ACCEPTANCE_REQUIRED");
    const view = await svc.forOrder(owner, { orderId: order.publicId });
    expect(view.gates[0]!.policy).toBeNull();
    expect(view.blocking).toBe(true);
  });

  it("staff-only policies never surface to customers and fail closed, also when changed after acceptance", async () => {
    const owner = await makeUser();
    const staffOnly = await makePolicy("Internal handbook.", "staff");
    const order = makeOrder(owner, [gate(staffOnly.documentPublicId)]);
    const view = await svc.forOrder(owner, { orderId: order.publicId });
    expect(view.gates[0]!.policy).toBeNull();
    expect(JSON.stringify(view)).not.toContain("Internal handbook");
    await rejects(mayWork(order, owner), "CONFLICT", "ORDER_ACCEPTANCE_REQUIRED");

    const forAll = await makePolicy("Terms for everyone.", "all");
    const second = makeOrder(owner, [gate(forAll.documentPublicId)]);
    const { receipt } = await acceptCurrent(owner, second);
    await mayWork(second, owner);
    await db.db.update(policyDocuments).set({ audience: "staff", title: "Internal escalation playbook" }).where(eq(policyDocuments.id, forAll.documentId));
    await rejects(mayWork(second, owner), "CONFLICT", "ORDER_ACCEPTANCE_REQUIRED");
    // The historical receipt stays readable, but a reclassified + renamed document's current title is withheld.
    const mine = await svc.receipt(owner, { receiptId: receipt.receiptId });
    expect(mine.policy.title).toBe("Policy");
    expect(mine.textSha256).toBe(receipt.textSha256);
    expect(JSON.stringify(mine)).not.toContain("Internal escalation playbook");
    const staff = await makeUser("staff");
    expect((await svc.receipt(staff, { receiptId: receipt.receiptId })).policy.title).toBe("Internal escalation playbook");
  });

  it("evidence is bound to the order's pinned workflow version: a re-pinned order asks again", async () => {
    const owner = await makeUser();
    const policy = await makePolicy();
    const order = makeOrder(owner, [gate(policy.documentPublicId)]);
    await acceptCurrent(owner, order);
    await mayWork(order, owner);
    order.workflowVersionId = 8;
    await rejects(mayWork(order, owner), "CONFLICT", "ORDER_ACCEPTANCE_REQUIRED");
    const again = await acceptCurrent(owner, order);
    expect(again.duplicate).toBe(false);
    await mayWork(order, owner);
  });
  it("evidencePage (acceptance log read port): filters, newest-first keyset across equal times, pseudonymised address, encrypted names", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const terms = await makePolicy("Log terms.");
    const typed = await makePolicy("Log signature policy.");
    const o1 = makeOrder(a, [gate(terms.documentPublicId), gate(typed.documentPublicId, { key: "sign", signatureMode: "typed_name" })]);
    const o2 = makeOrder(b, [gate(terms.documentPublicId)]);
    const o3 = makeOrder(a, [gate(terms.documentPublicId)]);
    await acceptCurrent(a, o1); // t0
    await acceptCurrent(a, o1, "sign", "Synthetic Signer"); // t0 (same timestamp: publicId breaks the tie)
    h.clock.advance(60_000);
    await acceptCurrent(b, o2); // t1
    h.clock.advance(60_000);
    await acceptCurrent(a, o3); // t2
    const mine = { userIds: [a.userId, b.userId] };

    // Newest first, stable keyset paging of size 1 visits every row exactly once.
    const seen: string[] = [];
    let before: { acceptedAt: Date; publicId: string } | undefined;
    for (let i = 0; i < 10; i += 1) {
      const page = await svc.evidencePage({ ...mine, before, limit: 1 });
      if (page.items.length === 0) break;
      const item = page.items[0]!;
      seen.push(item.publicId);
      before = { acceptedAt: item.acceptedAt, publicId: item.publicId };
      if (!page.hasMore) break;
    }
    const all = await svc.evidencePage({ ...mine, limit: 50 });
    expect(all.hasMore).toBe(false);
    expect(seen).toEqual(all.items.map((i) => i.publicId));
    expect(all.items.map((i) => i.orderId)).toEqual([o3.id, o2.id, o1.id, o1.id]);
    for (let i = 1; i < all.items.length; i += 1) {
      const [p, c] = [all.items[i - 1]!, all.items[i]!];
      expect(p.acceptedAt.getTime() > c.acceptedAt.getTime() || (p.acceptedAt.getTime() === c.acceptedAt.getTime() && p.publicId > c.publicId)).toBe(true);
    }

    // Filters.
    expect((await svc.evidencePage({ userIds: [b.userId], limit: 50 })).items.map((i) => i.orderPublicId)).toEqual([o2.publicId]);
    expect((await svc.evidencePage({ ...mine, policyDocumentIds: [typed.documentId], limit: 50 })).items.map((i) => i.gateKey)).toEqual(["sign"]);
    expect((await svc.evidencePage({ ...mine, method: "typed_name", limit: 50 })).items).toHaveLength(1);
    expect((await svc.evidencePage({ ...mine, orderIds: [o1.id], limit: 50 })).items).toHaveLength(2);
    const t1 = all.items[1]!.acceptedAt;
    expect((await svc.evidencePage({ ...mine, from: t1, to: new Date(t1.getTime() + 1), limit: 50 })).items.map((i) => i.orderId)).toEqual([o2.id]);
    const v = all.items[0]!.policyVersionId;
    expect((await svc.evidencePage({ ...mine, policyVersionIds: [v], limit: 50 })).items.every((i) => i.policyVersionId === v)).toBe(true);
    expect(await svc.evidencePage({ userIds: [], limit: 50 })).toEqual({ items: [], hasMore: false });
    await rejects(svc.evidencePage({ userIds: Array.from({ length: 501 }, (_, i) => i + 1), limit: 5 }), "VALIDATION", "FILTER_TOO_LARGE");
    expect((await svc.evidencePage({ ...mine, limit: 10_000 })).items.length).toBeLessThanOrEqual(200);

    // Fields: the same pseudonym policy_acceptances stores, never the raw address; typed names stay encrypted.
    const item = all.items.find((i) => i.gateKey === "sign")!;
    expect(item.addressPseudonym).toBe(h.deps.crypto.pseudonym(IP, "compliance.policy_acceptance.ip"));
    expect(JSON.stringify(all)).not.toContain(IP);
    expect(JSON.stringify(all)).not.toContain("Synthetic Signer");
    expect(h.deps.crypto.decrypt(item.signerNameEnc!, item.signerNameAad!)).toBe("Synthetic Signer");
    expect(all.items.find((i) => i.gateKey === "terms")!.signerNameEnc).toBeNull();
    expect(item).toMatchObject({ method: "typed_name", policyVersionNumber: 1, workflowVersionId: 7, userId: a.userId });
    expect(item.textSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(item.correlationId).toBeTruthy();
  });
});
