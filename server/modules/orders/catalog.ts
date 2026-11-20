/**
 * Admin-managed, versioned catalog. Ships EMPTY — there is no hardcoded product list or price.
 * Any change to a product's customer-facing terms (name, description, features, price, currency) writes a new
 * immutable version; existing orders keep the snapshot they were created with.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { conflict, notFound, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { AuditEmitter, Clock, Db, SessionPrincipal, Tx } from "../../core/types.js";
import { catalogGroups, catalogProducts, catalogProductVersions } from "./schema.js";

export interface CatalogDeps {
  db: Db;
  clock: Clock;
  audit: AuditEmitter;
}

export interface CatalogProductView {
  publicId: string;
  productKey: string;
  groupPublicId: string;
  name: string;
  description: string;
  features: string[];
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
  features: string[];
  priceMinor: number;
  currency: string;
}

export interface ResolvedLineItem {
  productId: number;
  productVersionId: number;
  productPublicId: string;
  productVersionNumber: number;
  name: string;
  description: string;
  features: string[];
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

const actorOf = (principal: SessionPrincipal) => ({ userId: principal.userId, role: principal.role });

export function createCatalogService(deps: CatalogDeps) {
  async function load(db: Db | Tx, onlyActive: boolean): Promise<CatalogGroupView[]> {
    const groups = await db
      .select()
      .from(catalogGroups)
      .where(onlyActive ? eq(catalogGroups.active, true) : undefined)
      .orderBy(asc(catalogGroups.sortOrder), asc(catalogGroups.id))
      .limit(200);
    if (groups.length === 0) return [];
    const rows = await db
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
    return groups.map((group) => ({
      publicId: group.publicId,
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
          name: version.name,
          description: version.description,
          features: version.features,
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

  async function insertVersion(tx: Tx, productId: number, versionNumber: number, terms: ProductTerms, actorUserId: number) {
    assertCurrency(terms.currency);
    const publicId = ulid(deps.clock.now().getTime());
    await tx.insert(catalogProductVersions).values({
      publicId,
      productId,
      versionNumber,
      name: terms.name,
      description: terms.description,
      features: terms.features,
      priceMinor: terms.priceMinor,
      currency: terms.currency,
      createdByUserId: actorUserId,
      createdAt: deps.clock.now(),
    });
    const [row] = await tx
      .select({ id: catalogProductVersions.id })
      .from(catalogProductVersions)
      .where(eq(catalogProductVersions.publicId, publicId));
    return row!.id;
  }

  return {
    /** Customer-facing: active groups with active products at their current version. */
    listActive(): Promise<CatalogGroupView[]> {
      return load(deps.db, true);
    },
    listAll(): Promise<CatalogGroupView[]> {
      return load(deps.db, false);
    },
    async isEmpty(): Promise<boolean> {
      const rows = await deps.db.select({ id: catalogProducts.id }).from(catalogProducts).where(eq(catalogProducts.active, true)).limit(1);
      return rows.length === 0;
    },

    async createGroup(principal: SessionPrincipal, input: { name: string; description: string; sortOrder: number; active: boolean }) {
      return deps.db.transaction(async (tx) => {
        const publicId = ulid(deps.clock.now().getTime());
        await tx.insert(catalogGroups).values({ publicId, ...input });
        await deps.audit.record(
          {
            category: "admin",
            eventName: "catalog.group.changed",
            action: "create",
            outcome: "completed",
            actor: actorOf(principal),
            resource: { type: "catalog_group", publicId },
          },
          tx,
        );
        return { publicId };
      });
    },

    async updateGroup(
      principal: SessionPrincipal,
      input: { groupId: string; expectedVersion: number; name: string; description: string; sortOrder: number; active: boolean },
    ) {
      return deps.db.transaction(async (tx) => {
        const group = await groupByPublicId(tx, input.groupId);
        if (group.version !== input.expectedVersion)
          throw conflict("STALE_VERSION", "This item was changed by someone else. Reload and try again.");
        await tx
          .update(catalogGroups)
          .set({
            name: input.name,
            description: input.description,
            sortOrder: input.sortOrder,
            active: input.active,
            version: group.version + 1,
          })
          .where(and(eq(catalogGroups.id, group.id), eq(catalogGroups.version, group.version)));
        await deps.audit.record(
          {
            category: "admin",
            eventName: "catalog.group.changed",
            action: "update",
            outcome: "completed",
            actor: actorOf(principal),
            resource: { type: "catalog_group", publicId: group.publicId },
            attributes: { active: input.active },
          },
          tx,
        );
        return { publicId: group.publicId, rowVersion: group.version + 1 };
      });
    },

    async createProduct(
      principal: SessionPrincipal,
      input: ProductTerms & { groupId: string; productKey: string; sortOrder: number; active: boolean },
    ) {
      assertCurrency(input.currency);
      return deps.db.transaction(async (tx) => {
        const group = await groupByPublicId(tx, input.groupId);
        const [existing] = await tx
          .select({ id: catalogProducts.id })
          .from(catalogProducts)
          .where(eq(catalogProducts.productKey, input.productKey))
          .limit(1);
        if (existing) throw conflict("PRODUCT_KEY_TAKEN", "A product with that key already exists.");
        const publicId = ulid(deps.clock.now().getTime());
        await tx.insert(catalogProducts).values({
          publicId,
          groupId: group.id,
          productKey: input.productKey,
          sortOrder: input.sortOrder,
          active: input.active,
        });
        const [product] = await tx.select({ id: catalogProducts.id }).from(catalogProducts).where(eq(catalogProducts.publicId, publicId));
        const versionId = await insertVersion(tx, product!.id, 1, input, principal.userId);
        await tx.update(catalogProducts).set({ currentVersionId: versionId }).where(eq(catalogProducts.id, product!.id));
        await deps.audit.record(
          {
            category: "admin",
            eventName: "catalog.product.changed",
            action: "create",
            outcome: "completed",
            actor: actorOf(principal),
            resource: { type: "catalog_product", publicId },
            attributes: { versionNumber: 1, currency: input.currency, priceMinor: input.priceMinor },
          },
          tx,
        );
        return { publicId, versionNumber: 1 };
      });
    },

    /** Terms changes create a new immutable version; placement/active changes only bump the row version. */
    async updateProduct(
      principal: SessionPrincipal,
      input: ProductTerms & { productId: string; expectedVersion: number; groupId: string; sortOrder: number; active: boolean },
    ) {
      assertCurrency(input.currency);
      return deps.db.transaction(async (tx) => {
        const [row] = await tx
          .select({ product: catalogProducts, version: catalogProductVersions })
          .from(catalogProducts)
          .innerJoin(catalogProductVersions, eq(catalogProductVersions.id, catalogProducts.currentVersionId))
          .where(eq(catalogProducts.publicId, input.productId))
          .limit(1)
          .for("update");
        if (!row) throw notFound("CATALOG_PRODUCT_NOT_FOUND");
        if (row.product.version !== input.expectedVersion)
          throw conflict("STALE_VERSION", "This item was changed by someone else. Reload and try again.");
        const group = await groupByPublicId(tx, input.groupId);
        const termsChanged =
          row.version.name !== input.name ||
          row.version.description !== input.description ||
          JSON.stringify(row.version.features) !== JSON.stringify(input.features) ||
          row.version.priceMinor !== input.priceMinor ||
          row.version.currency !== input.currency;
        let versionNumber = row.version.versionNumber;
        let currentVersionId = row.version.id;
        if (termsChanged) {
          versionNumber += 1;
          currentVersionId = await insertVersion(tx, row.product.id, versionNumber, input, principal.userId);
        }
        await tx
          .update(catalogProducts)
          .set({
            groupId: group.id,
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
            attributes: { versionNumber, termsChanged, active: input.active },
          },
          tx,
        );
        return { publicId: row.product.publicId, versionNumber, rowVersion: row.product.version + 1 };
      });
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
          unitPriceMinor: row.version.priceMinor,
          currency: row.version.currency,
          quantity: item.quantity,
          lineTotalMinor,
        };
      });
      const currencies = new Set(resolved.map((item) => item.currency));
      if (currencies.size > 1) throw validation("MIXED_CURRENCY", "Items priced in different currencies cannot be combined in one order.");
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
