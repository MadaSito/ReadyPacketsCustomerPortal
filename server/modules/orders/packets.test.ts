/**
 * Increment 02 — packet catalog fields, server-enforced packet rules, bundle discount, quote,
 * getProductionScope and the offerings import. All data here is SYNTHETIC (no real offerings or prices).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { DomainError } from "../../core/errors.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { Services } from "../../container.js";
import { createCallerFactory } from "../../trpc/trpc.js";
import { createTestDeps, type fakePrincipal, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { createOrdersModule, type OrdersModule } from "./index.js";
import { ordersRouter } from "./router.js";
import { orderLineItems, orders } from "./schema.js";
import { percentOf, priceOrder } from "./pricing.js";
import { FakeEngagement, FakeFiles, fakeIdentity, idemKey, insertUser, ordersTestSchema, type TestUser } from "./testSupport.js";
import type { OfferingsImportInput } from "./catalog.js";

let t: TestDb;
let h: TestHarness;
let mod: OrdersModule;
let admin: TestUser;
let alice: TestUser;

const code = (error: unknown) => (error instanceof DomainError ? `${error.code}:${error.reasonCode}` : String(error));
async function expectError(promise: Promise<unknown>, expected: string) {
  try {
    await promise;
  } catch (error) {
    expect(code(error)).toBe(expected);
    return;
  }
  throw new Error(`expected ${expected}`);
}
const call = (principal: ReturnType<typeof fakePrincipal> | null) =>
  createCallerFactory(ordersRouter)({ services: h.services, session: principal, request: newRequestContext("test"), transport: { issue() {}, clear() {} } });

const deliverables = (prefix: string) => [
  { title: `${prefix} deliverable one`, detail: "Synthetic detail one" },
  { title: `${prefix} deliverable two`, detail: "Synthetic detail two" },
];

/** Synthetic offerings document: packets 41 and 42 (numbers chosen so they cannot be mistaken for real packets). */
function syntheticOfferings(overrides: { price41Basic?: number; bundle?: OfferingsImportInput["bundle"] } = {}): OfferingsImportInput {
  const tier = (packet: number, name: "Basic" | "Standard" | "Premium", priceMinor: number) => ({
    tier: name,
    productKey: `synthetic-${packet}-${name.toLowerCase()}`,
    name: `Synthetic Packet ${packet} - ${name}`,
    priceMinor,
    outcome: `Synthetic outcome ${packet} ${name}`,
    timeline: "1 - 2 synthetic days",
    deliverables: deliverables(`P${packet} ${name}`),
  });
  return {
    currency: "USD",
    packets: [
      { packetNumber: 41, groupKey: "synthetic-41", name: "Synthetic Packet 41", description: "Synthetic", tiers: [tier(41, "Basic", overrides.price41Basic ?? 1005), tier(41, "Premium", 3000)] },
      { packetNumber: 42, groupKey: "synthetic-42", name: "Synthetic Packet 42", tiers: [tier(42, "Basic", 2005), tier(42, "Standard", 2500)] },
    ],
    bundle: overrides.bundle === undefined ? { requiredPacketNumbers: [42, 41], discountPercent: 15, label: "Synthetic bundle" } : overrides.bundle,
  };
}

beforeAll(async () => {
  t = await createTestDb({ schema: ordersTestSchema });
  h = createTestDeps({ db: t.db });
  mod = createOrdersModule(h.deps);
  h.services.orders = mod;
  h.services.identity = fakeIdentity(h, t.db) as unknown as Services["identity"];
  h.services.files = new FakeFiles() as unknown as Services["files"];
  h.services.engagement = new FakeEngagement() as unknown as Services["engagement"];
  admin = await insertUser(h, t.db, { role: "admin", stepUp: true });
  alice = await insertUser(h, t.db);
});
afterAll(() => t.cleanup());
beforeEach(() => {
  h.audit.failRecords = false;
});

describe("pricing (pure)", () => {
  it("rounds half up in integer minor units and caps at the subtotal", () => {
    expect(percentOf(3010, 15)).toBe(452); // 451.5 -> 452
    expect(percentOf(3003, 15)).toBe(450); // 450.45 -> 450
    const rule = { enabled: true, requiredPacketNumbers: [1, 2], discountPercent: 100, label: "All" };
    const priced = priceOrder(
      [
        { packetNumber: 1, quantity: 1, lineTotalMinor: 5 },
        { packetNumber: 2, quantity: 1, lineTotalMinor: 5 },
      ],
      rule,
    );
    expect(priced).toMatchObject({ subtotalMinor: 10, discountMinor: 10, totalMinor: 0, discountLabel: "All" });
  });
});

describe("packet catalog", () => {
  let group41: string;
  let other: string;

  it("stores and returns groupKey, packetNumber, tier, outcome, timeline and deliverables (features = titles)", async () => {
    group41 = (await mod.catalog.createGroup(admin.principal, { name: "Synthetic Packet 41", description: "Short", sortOrder: 0, active: true, groupKey: "synthetic-41", packetNumber: 41 })).publicId;
    other = (await mod.catalog.createGroup(admin.principal, { name: "Synthetic extras", description: "", sortOrder: 1, active: true })).publicId;
    await mod.catalog.createProduct(admin.principal, {
      groupId: group41,
      productKey: "synthetic-41-basic",
      sortOrder: 0,
      active: true,
      name: "Synthetic Packet 41 - Basic",
      description: "",
      features: ["ignored"],
      priceMinor: 1005,
      currency: "USD",
      packetNumber: 41,
      tier: "Basic",
      outcome: "Synthetic outcome",
      timeline: "1 - 2 synthetic days",
      deliverables: deliverables("A"),
    });
    const [group] = (await mod.catalog.listActive()).filter((g) => g.publicId === group41);
    expect(group).toMatchObject({ groupKey: "synthetic-41", packetNumber: 41 });
    expect(group!.products[0]).toMatchObject({
      packetNumber: 41,
      tier: "Basic",
      outcome: "Synthetic outcome",
      timeline: "1 - 2 synthetic days",
      deliverables: deliverables("A"),
      features: ["A deliverable one", "A deliverable two"],
    });
    expect(h.audit.recordedInTx.at(-1)).toBe(true);
    expect(h.audit.named("catalog.product.changed").at(-1)?.attributes).toMatchObject({ packet_number: 41, tier: "Basic" });
  });

  it("rejects incomplete placement, group mismatch, duplicate tier and duplicate packet/group keys", async () => {
    const base = { groupId: group41, sortOrder: 1, active: true, name: "x", description: "", features: [], priceMinor: 1, currency: "USD" };
    await expectError(mod.catalog.createProduct(admin.principal, { ...base, productKey: "syn-x1", packetNumber: 41, tier: null }), "VALIDATION:PACKET_PLACEMENT_INCOMPLETE");
    await expectError(mod.catalog.createProduct(admin.principal, { ...base, productKey: "syn-x2", packetNumber: 43, tier: "Basic" }), "VALIDATION:PACKET_GROUP_MISMATCH");
    await expectError(mod.catalog.createProduct(admin.principal, { ...base, groupId: other, productKey: "syn-x3", packetNumber: 41, tier: "Premium" }), "VALIDATION:PACKET_GROUP_MISMATCH");
    await expectError(mod.catalog.createProduct(admin.principal, { ...base, productKey: "syn-x4", packetNumber: 41, tier: "Basic" }), "CONFLICT:PACKET_TIER_TAKEN");
    await expectError(mod.catalog.createGroup(admin.principal, { name: "dup", description: "", sortOrder: 0, active: true, packetNumber: 41 }), "CONFLICT:PACKET_NUMBER_TAKEN");
    await expectError(mod.catalog.createGroup(admin.principal, { name: "dup", description: "", sortOrder: 0, active: true, groupKey: "synthetic-41" }), "CONFLICT:GROUP_KEY_TAKEN");
    await expect(call(admin.principal).admin.catalog.createProduct({ ...base, productKey: "syn-x5", deliverables: [{ title: "", detail: "" }] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("an outcome/timeline/deliverables change writes a new version; omitted fields are kept", async () => {
    const product = (await mod.catalog.listAll()).find((g) => g.publicId === group41)!.products[0]!;
    const terms = { name: product.name, description: product.description, features: product.features, priceMinor: product.priceMinor, currency: product.currency };
    const same = await mod.catalog.updateProduct(admin.principal, { productId: product.publicId, expectedVersion: product.rowVersion, groupId: group41, sortOrder: 0, active: true, ...terms });
    expect(same.versionNumber).toBe(product.versionNumber);
    const changed = await mod.catalog.updateProduct(admin.principal, {
      productId: product.publicId,
      expectedVersion: same.rowVersion,
      groupId: group41,
      sortOrder: 0,
      active: true,
      ...terms,
      timeline: "3 - 4 synthetic days",
    });
    expect(changed.versionNumber).toBe(product.versionNumber + 1);
    const after = (await mod.catalog.listAll()).find((g) => g.publicId === group41)!.products[0]!;
    expect(after).toMatchObject({ timeline: "3 - 4 synthetic days", outcome: "Synthetic outcome", tier: "Basic", deliverables: deliverables("A") });
  });
});

describe("offerings import, packet rules, bundle discount, quote, production scope", () => {
  let ids: Record<string, string>;
  let extra: string;

  it("upsertFromOfferings is idempotent, versions only changed terms, audits as system, and dry-runs without writing", async () => {
    const system = { system: "ops.catalog_import" } as const;
    const dry = await mod.catalog.upsertFromOfferings(system, syntheticOfferings({ price41Basic: 1111 }), { dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, bundleRule: "created" });
    expect((await mod.catalog.getBundleRule()).enabled).toBe(false);
    const first = await mod.catalog.upsertFromOfferings(system, syntheticOfferings());
    // group 41 and product synthetic-41-basic already exist from the previous block (matched by key, re-versioned).
    expect(first).toMatchObject({ dryRun: false, groups: { created: 1, updated: 1, unchanged: 0 }, products: { created: 3, versioned: 1 }, bundleRule: "created" });
    expect(await mod.catalog.getBundleRule()).toEqual({ enabled: true, requiredPacketNumbers: [41, 42], discountPercent: 15, label: "Synthetic bundle" });
    const again = await mod.catalog.upsertFromOfferings(system, syntheticOfferings());
    expect(again).toMatchObject({ groups: { created: 0, updated: 0, unchanged: 2 }, products: { created: 0, versioned: 0, unchanged: 4 }, bundleRule: "unchanged" });
    const repriced = await mod.catalog.upsertFromOfferings(system, syntheticOfferings({ price41Basic: 1005 }));
    expect(repriced.products).toMatchObject({ versioned: 0, unchanged: 4 });
    const systemEvents = h.audit.events.filter((e) => e.attributes?.source === "offerings_import");
    expect(systemEvents.length).toBeGreaterThan(0);
    expect(systemEvents.every((e) => e.actor?.role === "system")).toBe(true);
    await expectError(mod.catalog.upsertFromOfferings(system, { currency: "USD", packets: [] } as unknown as OfferingsImportInput), "VALIDATION:OFFERINGS_INVALID");
    const groups = await mod.catalog.listActive();
    // Inside a caller's tx (cart): same result on that connection, plain and share-locked.
    const inTx = await t.db.transaction(async (tx) => [await mod.catalog.listActive(tx), await mod.catalog.listActive(tx, { forShare: true })]);
    expect(inTx[0]).toEqual(groups);
    expect(inTx[1]).toEqual(groups);
    ids = Object.fromEntries(groups.flatMap((g) => g.products.map((p) => [p.productKey, p.publicId])));
    extra = (
      await mod.catalog.createProduct(admin.principal, {
        groupId: groups.find((g) => g.packetNumber === null)!.publicId,
        productKey: "synthetic-extra",
        sortOrder: 0,
        active: true,
        name: "Synthetic extra",
        description: "",
        features: [],
        priceMinor: 500,
        currency: "USD",
      })
    ).publicId;
  });

  it("admin bundle rule edit is validated, audited and capability-gated", async () => {
    await expectError(mod.catalog.updateBundleRule(admin.principal, { enabled: true, requiredPacketNumbers: [], discountPercent: 15, label: "x" }), "VALIDATION:BUNDLE_RULE_INVALID");
    await expect(call(alice.principal).admin.catalog.updateBundleRule({ rule: { enabled: false, requiredPacketNumbers: [], discountPercent: 0, label: "" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const rule = await call(admin.principal).admin.catalog.bundleRule();
    expect(rule.enabled).toBe(true);
    await mod.catalog.updateBundleRule(admin.principal, rule);
    expect(h.audit.named("catalog.bundle_rule.changed").at(-1)).toMatchObject({ actor: { role: "admin" }, attributes: { enabled: true, discount_percent: 15, required_packet_count: 2 } });
  });

  it("enforces quantity 1 and one tier per packet on quote and create; non-packet items keep quantities", async () => {
    await expectError(mod.orders.quote(alice.principal, { items: [{ productPublicId: ids["synthetic-41-basic"]!, quantity: 2 }] }), "VALIDATION:PACKET_QUANTITY_ONE");
    const conflictItems = [
      { productPublicId: ids["synthetic-41-basic"]!, quantity: 1 },
      { productPublicId: ids["synthetic-41-premium"]!, quantity: 1 },
    ];
    await expectError(mod.orders.quote(alice.principal, { items: conflictItems }), "VALIDATION:PACKET_TIER_CONFLICT");
    await expectError(mod.orders.create(alice.principal, { projectName: "Synthetic", items: conflictItems, idempotencyKey: idemKey() }), "VALIDATION:PACKET_TIER_CONFLICT");
    const q = await call(alice.principal).quote({ items: [{ productPublicId: extra, quantity: 3 }] });
    expect(q).toMatchObject({ subtotalMinor: 1500, discountMinor: 0, discountLabel: null, totalMinor: 1500 });
  });

  it("quotes the bundle hint, then applies the discount server-side and snapshots it on create", async () => {
    const one = await call(alice.principal).quote({ items: [{ productPublicId: ids["synthetic-41-basic"]!, quantity: 1 }] });
    expect(one).toEqual({
      currency: "USD",
      promo: null,
      subtotalMinor: 1005,
      discountMinor: 0,
      discountLabel: null,
      totalMinor: 1005,
      bundle: { enabled: true, label: "Synthetic bundle", discountPercent: 15, requiredPacketNumbers: [41, 42], missingPacketNumbers: [42], applied: false },
    });
    const items = [
      { productPublicId: ids["synthetic-42-basic"]!, quantity: 1 },
      { productPublicId: ids["synthetic-41-basic"]!, quantity: 1 },
      { productPublicId: extra, quantity: 1 },
    ];
    const both = await mod.orders.quote(alice.principal, { items });
    // 1005 + 2005 + 500 = 3510; 15% = 526.5 -> 527
    expect(both).toMatchObject({ subtotalMinor: 3510, discountMinor: 527, discountLabel: "Synthetic bundle", totalMinor: 2983, bundle: { applied: true, missingPacketNumbers: [] } });
    const created = await mod.orders.create(alice.principal, { projectName: "Synthetic bundle order", items, idempotencyKey: idemKey() });
    const [row] = await t.db.select().from(orders).where(eq(orders.publicId, created.publicId));
    expect(row).toMatchObject({ subtotalMinor: 3510, discountMinor: 527, discountLabel: "Synthetic bundle", totalMinor: 2983 });
    const view = await mod.orders.get(alice.principal, created.publicId, "customer");
    expect(view).toMatchObject({ subtotalMinor: 3510, discountMinor: 527, discountLabel: "Synthetic bundle", totalMinor: 2983 });
    expect(view.lineItems[0]).toMatchObject({ packetNumber: 42, tier: "Basic", outcome: "Synthetic outcome 42 Basic", timeline: "1 - 2 synthetic days", deliverables: deliverables("P42 Basic") });
    expect(view.lineItems[2]).toMatchObject({ packetNumber: null, tier: null, outcome: "", deliverables: [] });
    expect(h.audit.named("order.created").at(-1)?.attributes).toMatchObject({ total_minor: 2983, discount_minor: 527 });

    // Snapshot survives later catalog changes.
    await mod.catalog.upsertFromOfferings({ system: "ops.catalog_import" }, syntheticOfferings({ price41Basic: 1200 }));
    const later = await mod.orders.get(alice.principal, created.publicId, "customer");
    expect(later.lineItems[1]!.unitPriceMinor).toBe(1005);

    // getProductionScope: sorted packets, other items counted, caller tx honoured, null when missing.
    const scope = await t.db.transaction((tx) => mod.getProductionScope(row!.id, { tx }));
    expect(scope).toEqual({
      orderId: row!.id,
      orderPublicId: created.publicId,
      reference: created.reference,
      ownerUserId: alice.id,
      statusKey: row!.statusKey,
      lockState: row!.lockState,
      origin: "portal",
      packets: [
        { packetNumber: 41, tier: "Basic" },
        { packetNumber: 42, tier: "Basic" },
      ],
      otherItemCount: 1,
    });
    expect(await mod.getProductionScope(999_999)).toBeNull();
    const stored = await t.db.select().from(orderLineItems).where(eq(orderLineItems.orderId, row!.id));
    expect(stored.map((i) => i.tier).sort()).toEqual(["Basic", "Basic", null].sort());
  });

  it("disabled rule: no discount and bundle is null", async () => {
    await mod.catalog.updateBundleRule(admin.principal, { enabled: false, requiredPacketNumbers: [41, 42], discountPercent: 15, label: "Synthetic bundle" });
    const q = await mod.orders.quote(alice.principal, {
      items: [
        { productPublicId: ids["synthetic-41-basic"]!, quantity: 1 },
        { productPublicId: ids["synthetic-42-basic"]!, quantity: 1 },
      ],
    });
    expect(q).toMatchObject({ discountMinor: 0, discountLabel: null, bundle: null });
  });
});
