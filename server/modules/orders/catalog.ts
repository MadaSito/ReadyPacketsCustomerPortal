/**
 * Admin-managed, versioned catalog. Ships EMPTY — there is no hardcoded product list or price.
 * Any change to a product's customer-facing terms (name, description, features, outcome, timeline, deliverables,
 * price, currency) writes a new immutable version; existing orders keep the snapshot they were created with.
 * Packet products (increment 02) carry packetNumber + tier; both set or both null, and the packet number must
 * equal the group's packet number.
 */
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { conflict, notFound, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { readSetting } from "../platform/index.js";
import type { ActorCheck } from "./actor.js";
import type { AuditEmitter, Clock, Db, SessionPrincipal, SettingsStore, Tx } from "../../core/types.js";
import { catalogGroups, catalogProducts, catalogProductVersions, PACKET_TIERS, type Deliverable, type PacketTier } from "./schema.js";
import { assertPacketRules } from "./pricing.js";
import { bundleRuleSchema, ORDER_BUNDLE_RULE, type BundleRule } from "./settings.js";

export interface CatalogDeps {
  db: Db;
  clock: Clock;
  audit: AuditEmitter;
  settings: SettingsStore;
  /** In-tx actor re-validation (first statement of every admin write; these writes lock no order row). */
  actorCheck: ActorCheck;
}

export interface CatalogProductView {
  publicId: string;
  productKey: string;
  groupPublicId: string;
  packetNumber: number | null;
  tier: PacketTier | null;
  name: string;
  description: string;
  features: string[];
  outcome: string;
  timeline: string;
  deliverables: Deliverable[];
  priceMinor: number;
  currency: string;
  versionNumber: number;
  versionPublicId: string;
  sortOrder: number;
  active: boolean;
  rowVersion: number;
}

export interface CatalogGroupView {
  publicId: string;
  groupKey: string | null;
  packetNumber: number | null;
  name: string;
  description: string;
  sortOrder: number;
  active: boolean;
  rowVersion: number;
  products: CatalogProductView[];
}

export interface ProductTerms {
  name: string;
  description: string;
  /** Ignored when deliverables are non-empty (features = deliverable titles). */
  features: string[];
  priceMinor: number;
  currency: string;
  /** Omitted on update = keep the current value; omitted on create = "" / []. */
  outcome?: string;
  timeline?: string;
  deliverables?: Deliverable[];
}

/** Omitted on update = keep the current placement. Both set or both null. */
export interface PacketPlacement {
  packetNumber?: number | null;
  tier?: PacketTier | null;
}

interface StoredTerms {
  name: string;
  description: string;
  features: string[];
  outcome: string;
  timeline: string;
  deliverables: Deliverable[];
  priceMinor: number;
  currency: string;
}

const nfc = (min: number, max: number) =>
  z
    .string()
    .transform((value) => value.normalize("NFC").trim())
    .pipe(z.string().min(min).max(max));
export const deliverableSchema = z.object({ title: nfc(1, 200), detail: nfc(0, 2000) }).transform(({ title, detail }) => ({ title, detail }));
const productKeySchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/);
const groupKeySchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/);
const packetNumberSchema = z.number().int().min(1).max(255);

/** Input of catalog.upsertFromOfferings (the import script maps the offerings data file onto this). Extra keys ignored. */
export const offeringsImportSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  packets: z
    .array(
      z.object({
        packetNumber: packetNumberSchema,
        groupKey: groupKeySchema,
        name: nfc(1, 120),
        description: nfc(0, 1000).optional(),
        sortOrder: z.number().int().min(0).max(10_000).optional(),
        tiers: z
          .array(
            z.object({
              tier: z.enum(PACKET_TIERS),
              productKey: productKeySchema,
              name: nfc(1, 160),
              description: nfc(0, 2000).optional(),
              priceMinor: z.number().int().min(0).max(100_000_000_000),
              outcome: nfc(0, 1000),
              timeline: nfc(0, 120),
              deliverables: z.array(deliverableSchema).max(100),
            }),
          )
          .min(1)
          .max(PACKET_TIERS.length),
      }),
    )
    .min(1)
    .max(50),
  bundle: z
    .object({ requiredPacketNumbers: z.array(packetNumberSchema).min(1).max(50), discountPercent: z.number().int().min(1).max(100), label: nfc(1, 120) })
    .nullable()
    .optional(),
});
export type OfferingsImportInput = z.input<typeof offeringsImportSchema>;

export interface OfferingsImportResult {
  dryRun: boolean;
  groups: { created: number; updated: number; unchanged: number };
  products: { created: number; versioned: number; unchanged: number };
  bundleRule: "created" | "updated" | "unchanged" | "skipped";
}

class DryRunRollback extends Error {
  constructor(readonly result: OfferingsImportResult) {
    super("dry run");
  }
}

function assertPlacementPair(packetNumber: number | null, tier: PacketTier | null): void {
  if ((packetNumber === null) !== (tier === null))
    throw validation("PACKET_PLACEMENT_INCOMPLETE", "Set both the packet number and the tier, or neither.");
}

function storedTerms(input: ProductTerms, current?: StoredTerms): StoredTerms {
  const deliverables = input.deliverables ?? current?.deliverables ?? [];
  return {
    name: input.name,
    description: input.description,
    features: deliverables.length > 0 ? deliverables.map((d) => d.title) : input.features,
    outcome: input.outcome ?? current?.outcome ?? "",
    timeline: input.timeline ?? current?.timeline ?? "",
    deliverables,
    priceMinor: input.priceMinor,
    currency: input.currency,
  };
}

function termsDiffer(a: StoredTerms, b: StoredTerms): boolean {
  return (
    a.name !== b.name ||
    a.description !== b.description ||
    JSON.stringify(a.features) !== JSON.stringify(b.features) ||
    a.outcome !== b.outcome ||
    a.timeline !== b.timeline ||
    JSON.stringify(a.deliverables.map((d) => [d.title, d.detail])) !== JSON.stringify(b.deliverables.map((d) => [d.title, d.detail])) ||
    a.priceMinor !== b.priceMinor ||
    a.currency !== b.currency
  );
}

export interface ResolvedLineItem {
  productId: number;
  productVersionId: number;
  productPublicId: string;
  productVersionNumber: number;
  name: string;
  description: string;
  features: string[];
  packetNumber: number | null;
  tier: PacketTier | null;
  outcome: string;
  timeline: string;
  deliverables: Deliverable[];
  unitPriceMinor: number;
  currency: string;
  quantity: number;
  lineTotalMinor: number;
}

export function assertCurrency(currency: string): void {
  if (!/^[A-Z]{3}$/.test(currency)) throw validation("INVALID_CURRENCY", "Use a three-letter ISO currency code.");
  try {
    new Intl.NumberFormat("en-US", { style: "currency", currency });
  } catch {
    throw validation("INVALID_CURRENCY", "Use a three-letter ISO currency code.");
  }
}

/** Trusted ops entry (scripts/ops/catalog-import.ts on a production install): audited as role "system". */
export interface CatalogSystemActor {
  system: "ops.catalog_import";
}
export type CatalogActor = SessionPrincipal | CatalogSystemActor;
const isSystem = (actor: CatalogActor): actor is CatalogSystemActor => "system" in actor;
const actorOf = (actor: CatalogActor) => (isSystem(actor) ? { userId: null, role: "system" as const } : { userId: actor.userId, role: actor.role });
const actorUserId = (actor: CatalogActor): number | null => (isSystem(actor) ? null : actor.userId);

export function createCatalogService(deps: CatalogDeps) {
  async function load(db: Db | Tx, onlyActive: boolean, forShare = false): Promise<CatalogGroupView[]> {
    const groupQuery = db
      .select()
      .from(catalogGroups)
      .where(onlyActive ? eq(catalogGroups.active, true) : undefined)
      .orderBy(asc(catalogGroups.sortOrder), asc(catalogGroups.id))
      .limit(200);
    const groups = await (forShare ? groupQuery.for("share") : groupQuery);
    if (groups.length === 0) return [];
    const productQuery = db
      .select({ product: catalogProducts, version: catalogProductVersions })
      .from(catalogProducts)
      .innerJoin(catalogProductVersions, eq(catalogProductVersions.id, catalogProducts.currentVersionId))
      .where(
        and(
          inArray(
            catalogProducts.groupId,
            groups.map((g) => g.id),
          ),
          onlyActive ? eq(catalogProducts.active, true) : undefined,
        ),
      )
      .orderBy(asc(catalogProducts.sortOrder), asc(catalogProducts.id))
      .limit(1000);
    const rows = await (forShare ? productQuery.for("share") : productQuery);
    return groups.map((group) => ({
      publicId: group.publicId,
      groupKey: group.groupKey,
      packetNumber: group.packetNumber,
      name: group.name,
      description: group.description,
      sortOrder: group.sortOrder,
      active: group.active,
      rowVersion: group.version,
      products: rows
        .filter((row) => row.product.groupId === group.id)
        .map(({ product, version }) => ({
          publicId: product.publicId,
          productKey: product.productKey,
          groupPublicId: group.publicId,
          packetNumber: product.packetNumber,
          tier: product.tier,
          name: version.name,
          description: version.description,
          features: version.features,
          outcome: version.outcome,
          timeline: version.timeline,
          deliverables: version.deliverables ?? [],
          priceMinor: version.priceMinor,
          currency: version.currency,
          versionNumber: version.versionNumber,
          versionPublicId: version.publicId,
          sortOrder: product.sortOrder,
          active: product.active,
          rowVersion: product.version,
        })),
    }));
  }

  async function groupByPublicId(tx: Tx, publicId: string) {
    const [group] = await tx.select().from(catalogGroups).where(eq(catalogGroups.publicId, publicId)).limit(1).for("update");
    if (!group) throw notFound("CATALOG_GROUP_NOT_FOUND");
    return group;
  }

  async function insertVersion(tx: Tx, productId: number, versionNumber: number, terms: StoredTerms, createdByUserId: number | null) {
    assertCurrency(terms.currency);
    const publicId = ulid(deps.clock.now().getTime());
    await tx.insert(catalogProductVersions).values({
      publicId,
      productId,
      versionNumber,
      name: terms.name,
      description: terms.description,
      features: terms.features,
      outcome: terms.outcome,
      timeline: terms.timeline,
      deliverables: terms.deliverables,
      priceMinor: terms.priceMinor,
      currency: terms.currency,
      createdByUserId,
      createdAt: deps.clock.now(),
    });
    const [row] = await tx
      .select({ id: catalogProductVersions.id })
      .from(catalogProductVersions)
      .where(eq(catalogProductVersions.publicId, publicId));
    return row!.id;
  }

  type GroupRow = typeof catalogGroups.$inferSelect;
  type ProductRow = { product: typeof catalogProducts.$inferSelect; version: typeof catalogProductVersions.$inferSelect };

  async function assertGroupKeysFree(tx: Tx, groupKey: string | null, packetNumber: number | null, exceptId?: number) {
    if (groupKey !== null) {
      const [taken] = await tx
        .select({ id: catalogGroups.id })
        .from(catalogGroups)
        .where(and(eq(catalogGroups.groupKey, groupKey), exceptId === undefined ? undefined : ne(catalogGroups.id, exceptId)))
        .limit(1);
      if (taken) throw conflict("GROUP_KEY_TAKEN", "A group with that key already exists.");
    }
    if (packetNumber !== null) {
      const [taken] = await tx
        .select({ id: catalogGroups.id })
        .from(catalogGroups)
        .where(and(eq(catalogGroups.packetNumber, packetNumber), exceptId === undefined ? undefined : ne(catalogGroups.id, exceptId)))
        .limit(1);
      if (taken) throw conflict("PACKET_NUMBER_TAKEN", "Another group already uses that packet number.");
    }
  }

  async function insertGroup(
    tx: Tx,
    input: { name: string; description: string; sortOrder: number; active: boolean; groupKey?: string | null; packetNumber?: number | null },
  ): Promise<string> {
    const groupKey = input.groupKey ?? null;
    const packetNumber = input.packetNumber ?? null;
    await assertGroupKeysFree(tx, groupKey, packetNumber);
    const publicId = ulid(deps.clock.now().getTime());
    await tx.insert(catalogGroups).values({
      publicId,
      groupKey,
      packetNumber,
      name: input.name,
      description: input.description,
      sortOrder: input.sortOrder,
      active: input.active,
    });
    return publicId;
  }

  async function applyGroupUpdate(
    tx: Tx,
    group: GroupRow,
    input: { name: string; description: string; sortOrder: number; active: boolean; groupKey?: string | null; packetNumber?: number | null },
  ): Promise<number> {
    const groupKey = input.groupKey === undefined ? group.groupKey : input.groupKey;
    const packetNumber = input.packetNumber === undefined ? group.packetNumber : input.packetNumber;
    if (groupKey !== group.groupKey || packetNumber !== group.packetNumber) await assertGroupKeysFree(tx, groupKey, packetNumber, group.id);
    if (packetNumber !== group.packetNumber) {
      const [mismatch] = await tx
        .select({ id: catalogProducts.id })
        .from(catalogProducts)
        .where(eq(catalogProducts.groupId, group.id))
        .limit(1);
      if (mismatch) throw validation("PACKET_GROUP_NOT_EMPTY", "Move this group's products elsewhere before changing its packet number.");
    }
    await tx
      .update(catalogGroups)
      .set({ groupKey, packetNumber, name: input.name, description: input.description, sortOrder: input.sortOrder, active: input.active, version: group.version + 1 })
      .where(and(eq(catalogGroups.id, group.id), eq(catalogGroups.version, group.version)));
    return group.version + 1;
  }

  function auditGroup(tx: Tx, principal: CatalogActor, publicId: string, action: "create" | "update", attributes: Record<string, string | number | boolean | null>) {
    return deps.audit.record(
      {
        category: "admin",
        eventName: "catalog.group.changed",
        action,
        outcome: "completed",
        actor: actorOf(principal),
        resource: { type: "catalog_group", publicId },
        attributes,
      },
      tx,
    );
  }

  /** Placement rules: pair complete, matches the group's packet number, (packet, tier) not used by another product. */
  async function resolvePlacement(tx: Tx, group: GroupRow, placement: PacketPlacement, current: { id: number; packetNumber: number | null; tier: PacketTier | null } | null) {
    const packetNumber = placement.packetNumber === undefined ? (current?.packetNumber ?? null) : placement.packetNumber;
    const tier = placement.tier === undefined ? (current?.tier ?? null) : placement.tier;
    assertPlacementPair(packetNumber, tier);
    if (packetNumber !== null && group.packetNumber !== packetNumber)
      throw validation("PACKET_GROUP_MISMATCH", "A packet product must sit in the group for the same packet number.");
    if (packetNumber !== null && tier !== null) {
      const [taken] = await tx
        .select({ id: catalogProducts.id })
        .from(catalogProducts)
        .where(and(eq(catalogProducts.packetNumber, packetNumber), eq(catalogProducts.tier, tier), current ? ne(catalogProducts.id, current.id) : undefined))
        .limit(1);
      if (taken) throw conflict("PACKET_TIER_TAKEN", "Another product already offers that tier of this packet.");
    }
    return { packetNumber, tier };
  }

  async function productForUpdate(tx: Tx, where: ReturnType<typeof eq>): Promise<ProductRow | undefined> {
    const [row] = await tx
      .select({ product: catalogProducts, version: catalogProductVersions })
      .from(catalogProducts)
      .innerJoin(catalogProductVersions, eq(catalogProductVersions.id, catalogProducts.currentVersionId))
      .where(where)
      .limit(1)
      .for("update");
    return row;
  }

  async function insertProduct(
    tx: Tx,
    principal: CatalogActor,
    group: GroupRow,
    input: ProductTerms & PacketPlacement & { productKey: string; sortOrder: number; active: boolean },
    source?: string,
  ): Promise<string> {
    const [existing] = await tx.select({ id: catalogProducts.id }).from(catalogProducts).where(eq(catalogProducts.productKey, input.productKey)).limit(1);
    if (existing) throw conflict("PRODUCT_KEY_TAKEN", "A product with that key already exists.");
    const placement = await resolvePlacement(tx, group, input, null);
    const terms = storedTerms(input);
    const publicId = ulid(deps.clock.now().getTime());
    await tx.insert(catalogProducts).values({
      publicId,
      groupId: group.id,
      productKey: input.productKey,
      packetNumber: placement.packetNumber,
      tier: placement.tier,
      sortOrder: input.sortOrder,
      active: input.active,
    });
    const [product] = await tx.select({ id: catalogProducts.id }).from(catalogProducts).where(eq(catalogProducts.publicId, publicId));
    const versionId = await insertVersion(tx, product!.id, 1, terms, actorUserId(principal));
    await tx.update(catalogProducts).set({ currentVersionId: versionId }).where(eq(catalogProducts.id, product!.id));
    await deps.audit.record(
      {
        category: "admin",
        eventName: "catalog.product.changed",
        action: "create",
        outcome: "completed",
        actor: actorOf(principal),
        resource: { type: "catalog_product", publicId },
        attributes: {
          version_number: 1,
          currency: terms.currency,
          price_minor: terms.priceMinor,
          packet_number: placement.packetNumber,
          tier: placement.tier,
          ...(source ? { source } : {}),
        },
      },
      tx,
    );
    return publicId;
  }

  async function applyProductUpdate(
    tx: Tx,
    principal: CatalogActor,
    row: ProductRow,
    group: GroupRow,
    input: ProductTerms & PacketPlacement & { sortOrder: number; active: boolean },
    source?: string,
  ) {
    const placement = await resolvePlacement(tx, group, input, row.product);
    const terms = storedTerms(input, row.version);
    const termsChanged = termsDiffer(row.version, terms);
    let versionNumber = row.version.versionNumber;
    let currentVersionId = row.version.id;
    if (termsChanged) {
      versionNumber += 1;
      currentVersionId = await insertVersion(tx, row.product.id, versionNumber, terms, actorUserId(principal));
    }
    await tx
      .update(catalogProducts)
      .set({
        groupId: group.id,
        packetNumber: placement.packetNumber,
        tier: placement.tier,
        sortOrder: input.sortOrder,
        active: input.active,
        currentVersionId,
        version: row.product.version + 1,
      })
      .where(and(eq(catalogProducts.id, row.product.id), eq(catalogProducts.version, row.product.version)));
    await deps.audit.record(
      {
        category: "admin",
        eventName: "catalog.product.changed",
        action: "update",
        outcome: "completed",
        actor: actorOf(principal),
        resource: { type: "catalog_product", publicId: row.product.publicId },
        attributes: {
          version_number: versionNumber,
          terms_changed: termsChanged,
          active: input.active,
          packet_number: placement.packetNumber,
          tier: placement.tier,
          ...(source ? { source } : {}),
        },
      },
      tx,
    );
    return { publicId: row.product.publicId, versionNumber, rowVersion: row.product.version + 1 };
  }

  async function writeBundleRule(tx: Tx, principal: CatalogActor, rule: BundleRule, source?: string) {
    await deps.settings.set(ORDER_BUNDLE_RULE.key, rule, tx);
    await deps.audit.record(
      {
        category: "admin",
        eventName: "catalog.bundle_rule.changed",
        action: "update",
        outcome: "completed",
        actor: actorOf(principal),
        resource: { type: "platform_setting" },
        attributes: {
          enabled: rule.enabled,
          discount_percent: rule.discountPercent,
          required_packet_count: rule.requiredPacketNumbers.length,
          ...(source ? { source } : {}),
        },
      },
      tx,
    );
  }

  return {
    /**
     * Customer-facing: active groups with active products at their current version. Pass `tx` when called inside a
     * transaction (the read then uses that connection; never a second connection).
     */
    listActive(tx?: Tx, opts: { forShare?: boolean } = {}): Promise<CatalogGroupView[]> {
      // `forShare` (cart checkout/item mutations): current, share-locked read in the caller's tx, so a concurrent
      // deactivation or repricing waits for it. Only meaningful with a tx.
      return load(tx ?? deps.db, true, Boolean(tx && opts.forShare));
    },
    listAll(): Promise<CatalogGroupView[]> {
      return load(deps.db, false);
    },
    async isEmpty(): Promise<boolean> {
      const rows = await deps.db.select({ id: catalogProducts.id }).from(catalogProducts).where(eq(catalogProducts.active, true)).limit(1);
      return rows.length === 0;
    },

    async createGroup(
      principal: SessionPrincipal,
      input: { name: string; description: string; sortOrder: number; active: boolean; groupKey?: string | null; packetNumber?: number | null },
    ) {
      return deps.db.transaction(async (tx) => {
        await deps.actorCheck(principal, tx, "catalog.manage");
        const publicId = await insertGroup(tx, input);
        await auditGroup(tx, principal, publicId, "create", { packet_number: input.packetNumber ?? null });
        return { publicId };
      });
    },

    async updateGroup(
      principal: SessionPrincipal,
      input: {
        groupId: string;
        expectedVersion: number;
        name: string;
        description: string;
        sortOrder: number;
        active: boolean;
        groupKey?: string | null;
        packetNumber?: number | null;
      },
    ) {
      return deps.db.transaction(async (tx) => {
        await deps.actorCheck(principal, tx, "catalog.manage");
        const group = await groupByPublicId(tx, input.groupId);
        if (group.version !== input.expectedVersion)
          throw conflict("STALE_VERSION", "This item was changed by someone else. Reload and try again.");
        const rowVersion = await applyGroupUpdate(tx, group, input);
        await auditGroup(tx, principal, group.publicId, "update", { active: input.active, packet_number: input.packetNumber === undefined ? group.packetNumber : input.packetNumber });
        return { publicId: group.publicId, rowVersion };
      });
    },

    async createProduct(
      principal: SessionPrincipal,
      input: ProductTerms & PacketPlacement & { groupId: string; productKey: string; sortOrder: number; active: boolean },
    ) {
      assertCurrency(input.currency);
      return deps.db.transaction(async (tx) => {
        await deps.actorCheck(principal, tx, "catalog.manage");
        const group = await groupByPublicId(tx, input.groupId);
        const publicId = await insertProduct(tx, principal, group, input);
        return { publicId, versionNumber: 1 };
      });
    },

    /** Terms changes create a new immutable version; placement/active changes only bump the row version. */
    async updateProduct(
      principal: SessionPrincipal,
      input: ProductTerms & PacketPlacement & { productId: string; expectedVersion: number; groupId: string; sortOrder: number; active: boolean },
    ) {
      assertCurrency(input.currency);
      return deps.db.transaction(async (tx) => {
        await deps.actorCheck(principal, tx, "catalog.manage");
        const row = await productForUpdate(tx, eq(catalogProducts.publicId, input.productId));
        if (!row) throw notFound("CATALOG_PRODUCT_NOT_FOUND");
        if (row.product.version !== input.expectedVersion)
          throw conflict("STALE_VERSION", "This item was changed by someone else. Reload and try again.");
        const group = await groupByPublicId(tx, input.groupId);
        return applyProductUpdate(tx, principal, row, group, input);
      });
    },

    /* ------------------------------------------------------------ bundle rule */
    getBundleRule(tx?: Tx): Promise<BundleRule> {
      return readSetting(deps.settings, ORDER_BUNDLE_RULE, tx);
    },

    async updateBundleRule(principal: SessionPrincipal, rule: BundleRule): Promise<BundleRule> {
      const parsed = bundleRuleSchema.safeParse(rule);
      if (!parsed.success) throw validation("BUNDLE_RULE_INVALID", "An enabled bundle rule needs packets, a percentage and a label.");
      return deps.db.transaction(async (tx) => {
        await deps.actorCheck(principal, tx, "catalog.manage");
        await writeBundleRule(tx, principal, parsed.data);
        return parsed.data;
      });
    },

    /**
     * Idempotent import of the offerings data (one transaction, audited as `principal`). Matches groups by
     * groupKey and products by productKey; writes a new product version only when terms differ; never deletes
     * and never changes `active`. `dryRun` runs every check and write, then rolls back.
     */
    async upsertFromOfferings(principal: CatalogActor, doc: OfferingsImportInput, opts: { dryRun?: boolean } = {}): Promise<OfferingsImportResult> {
      const parsed = offeringsImportSchema.safeParse(doc);
      if (!parsed.success) throw validation("OFFERINGS_INVALID", "The offerings document does not match the expected shape.");
      const input = parsed.data;
      assertCurrency(input.currency);
      const groupKeys = new Set(input.packets.map((p) => p.groupKey));
      const packetNumbers = new Set(input.packets.map((p) => p.packetNumber));
      const productKeys = new Set(input.packets.flatMap((p) => p.tiers.map((t) => t.productKey)));
      const tierCount = input.packets.reduce((n, p) => n + p.tiers.length, 0);
      if (groupKeys.size !== input.packets.length || packetNumbers.size !== input.packets.length || productKeys.size !== tierCount)
        throw validation("OFFERINGS_DUPLICATE_KEY", "Packet numbers, group keys and product keys must be unique.");
      for (const packet of input.packets)
        if (new Set(packet.tiers.map((t) => t.tier)).size !== packet.tiers.length)
          throw validation("OFFERINGS_DUPLICATE_KEY", "Each packet may list each tier once.");
      const result: OfferingsImportResult = {
        dryRun: Boolean(opts.dryRun),
        groups: { created: 0, updated: 0, unchanged: 0 },
        products: { created: 0, versioned: 0, unchanged: 0 },
        bundleRule: "skipped",
      };
      try {
        await deps.db.transaction(async (tx) => {
          if (!isSystem(principal)) await deps.actorCheck(principal, tx, "catalog.manage");
          // Deterministic lock order: groups by packet number, then each group's products by tier order.
          const packets = [...input.packets].sort((a, b) => a.packetNumber - b.packetNumber);
          for (const packet of packets) {
            const groupInput = {
              name: packet.name,
              description: packet.description ?? "",
              sortOrder: packet.sortOrder ?? packet.packetNumber,
              groupKey: packet.groupKey,
              packetNumber: packet.packetNumber,
            };
            const [existingGroup] = await tx.select().from(catalogGroups).where(eq(catalogGroups.groupKey, packet.groupKey)).limit(1).for("update");
            let group: GroupRow;
            if (!existingGroup) {
              const publicId = await insertGroup(tx, { ...groupInput, active: true });
              await auditGroup(tx, principal, publicId, "create", { packet_number: packet.packetNumber, source: "offerings_import" });
              group = (await tx.select().from(catalogGroups).where(eq(catalogGroups.publicId, publicId)).limit(1))[0]!;
              result.groups.created += 1;
            } else if (
              existingGroup.name !== groupInput.name ||
              existingGroup.description !== groupInput.description ||
              existingGroup.sortOrder !== groupInput.sortOrder ||
              existingGroup.packetNumber !== groupInput.packetNumber
            ) {
              await applyGroupUpdate(tx, existingGroup, { ...groupInput, active: existingGroup.active });
              await auditGroup(tx, principal, existingGroup.publicId, "update", { packet_number: packet.packetNumber, source: "offerings_import" });
              group = (await tx.select().from(catalogGroups).where(eq(catalogGroups.id, existingGroup.id)).limit(1))[0]!;
              result.groups.updated += 1;
            } else {
              group = existingGroup;
              result.groups.unchanged += 1;
            }
            const tiers = [...packet.tiers].sort((a, b) => PACKET_TIERS.indexOf(a.tier) - PACKET_TIERS.indexOf(b.tier));
            for (const tier of tiers) {
              const terms: ProductTerms & PacketPlacement = {
                name: tier.name,
                description: tier.description ?? "",
                features: [],
                outcome: tier.outcome,
                timeline: tier.timeline,
                deliverables: tier.deliverables,
                priceMinor: tier.priceMinor,
                currency: input.currency,
                packetNumber: packet.packetNumber,
                tier: tier.tier,
              };
              const sortOrder = PACKET_TIERS.indexOf(tier.tier);
              const row = await productForUpdate(tx, eq(catalogProducts.productKey, tier.productKey));
              if (!row) {
                await insertProduct(tx, principal, group, { ...terms, productKey: tier.productKey, sortOrder, active: true }, "offerings_import");
                result.products.created += 1;
                continue;
              }
              const nextTerms = storedTerms(terms, row.version);
              const placementSame =
                row.product.groupId === group.id && row.product.packetNumber === packet.packetNumber && row.product.tier === tier.tier && row.product.sortOrder === sortOrder;
              if (!termsDiffer(row.version, nextTerms) && placementSame) {
                result.products.unchanged += 1;
                continue;
              }
              const updated = await applyProductUpdate(tx, principal, row, group, { ...terms, sortOrder, active: row.product.active }, "offerings_import");
              if (updated.versionNumber !== row.version.versionNumber) result.products.versioned += 1;
              else result.products.unchanged += 1;
            }
          }
          if (input.bundle) {
            const next: BundleRule = {
              enabled: true,
              requiredPacketNumbers: [...input.bundle.requiredPacketNumbers].sort((a, b) => a - b),
              discountPercent: input.bundle.discountPercent,
              label: input.bundle.label,
            };
            const parsedRule = bundleRuleSchema.safeParse(next);
            if (!parsedRule.success) throw validation("BUNDLE_RULE_INVALID", "The bundle rule in the offerings document is not valid.");
            const current = await readSetting(deps.settings, ORDER_BUNDLE_RULE, tx);
            const defaultRule = ORDER_BUNDLE_RULE.default;
            if (JSON.stringify(current) === JSON.stringify(next)) result.bundleRule = "unchanged";
            else {
              result.bundleRule = JSON.stringify(current) === JSON.stringify(defaultRule) ? "created" : "updated";
              // Not written on a dry run (the transaction rolls back anyway; this also keeps non-transactional stores clean).
              if (!opts.dryRun) await writeBundleRule(tx, principal, next, "offerings_import");
            }
          }
          if (opts.dryRun) throw new DryRunRollback(result);
        });
      } catch (error) {
        if (error instanceof DryRunRollback) return error.result;
        throw error;
      }
      return result;
    },

    /**
     * Resolves order selections to immutable snapshots inside the caller's transaction. Only active products in
     * active groups at their CURRENT version; all items must share one currency.
     */
    async resolveForOrder(tx: Tx, items: { productPublicId: string; quantity: number }[]): Promise<ResolvedLineItem[]> {
      const ids = [...new Set(items.map((item) => item.productPublicId))];
      if (ids.length !== items.length) throw validation("DUPLICATE_ITEM", "Each product can be selected once; adjust the quantity instead.");
      const rows = await tx
        .select({ product: catalogProducts, version: catalogProductVersions, groupActive: catalogGroups.active })
        .from(catalogProducts)
        .innerJoin(catalogProductVersions, eq(catalogProductVersions.id, catalogProducts.currentVersionId))
        .innerJoin(catalogGroups, eq(catalogGroups.id, catalogProducts.groupId))
        .where(inArray(catalogProducts.publicId, ids));
      const resolved = items.map((item) => {
        const row = rows.find((candidate) => candidate.product.publicId === item.productPublicId);
        if (!row || !row.product.active || !row.groupActive)
          throw validation("PRODUCT_UNAVAILABLE", "One of the selected items is no longer available. Please review your selection.");
        const lineTotalMinor = row.version.priceMinor * item.quantity;
        if (!Number.isSafeInteger(lineTotalMinor)) throw validation("AMOUNT_TOO_LARGE", "The order total is too large.");
        return {
          productId: row.product.id,
          productVersionId: row.version.id,
          productPublicId: row.product.publicId,
          productVersionNumber: row.version.versionNumber,
          name: row.version.name,
          description: row.version.description,
          features: row.version.features,
          packetNumber: row.product.packetNumber,
          tier: row.product.tier,
          outcome: row.version.outcome,
          timeline: row.version.timeline,
          deliverables: row.version.deliverables ?? [],
          unitPriceMinor: row.version.priceMinor,
          currency: row.version.currency,
          quantity: item.quantity,
          lineTotalMinor,
        };
      });
      const currencies = new Set(resolved.map((item) => item.currency));
      if (currencies.size > 1) throw validation("MIXED_CURRENCY", "Items priced in different currencies cannot be combined in one order.");
      assertPacketRules(resolved);
      return resolved;
    },

    async checkViability(items: { productPublicId?: string; name: string; currency: string }[]) {
      const ids = items.map((item) => item.productPublicId).filter((id): id is string => typeof id === "string");
      const rows = ids.length
        ? await deps.db
            .select({ publicId: catalogProducts.publicId, active: catalogProducts.active })
            .from(catalogProducts)
            .where(inArray(catalogProducts.publicId, ids.slice(0, 500)))
        : [];
      const matched = items.filter((item) => rows.some((row) => row.publicId === item.productPublicId && row.active)).length;
      return { matched, unmatched: items.length - matched };
    },
  };
}

export type CatalogService = ReturnType<typeof createCatalogService>;
