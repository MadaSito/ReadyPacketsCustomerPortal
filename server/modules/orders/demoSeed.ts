/**
 * SYNTHETIC DEMO DATA — never imported by the container or run automatically.
 *
 * The real catalog ships EMPTY: there is intentionally no legacy catalog, no legacy prices and no
 * "Packet 8". An operator (or /root's demo script) may call `seedOrdersDemo` explicitly on a demo or
 * development installation. Every name says "Demo" so the data cannot be mistaken for real offerings.
 * It goes through the normal audited catalog service (actor = the supplied admin principal).
 */
import type { SessionPrincipal } from "../../core/types.js";
import type { OrdersModule } from "./index.js";

export interface OrdersDemoSeedResult {
  seeded: boolean;
  groupPublicId: string | null;
  productPublicIds: string[];
}

const DEMO_PRODUCTS = [
  { productKey: "demo-starter", name: "Demo Starter Item", description: "Synthetic demo item for trying the order flow.", features: ["Demo feature A", "Demo feature B"], priceMinor: 1000 },
  { productKey: "demo-standard", name: "Demo Standard Item", description: "Synthetic demo item with a different price.", features: ["Demo feature A", "Demo feature C"], priceMinor: 2500 },
  { productKey: "demo-extended", name: "Demo Extended Item", description: "Synthetic demo item for multi-item orders.", features: ["Demo feature D"], priceMinor: 5000 },
] as const;

/**
 * Seeds a clearly synthetic demo catalog. Idempotent: does nothing unless the catalog is completely empty.
 * @param admin a full-session admin principal with `catalog.manage` (all writes are audited as this actor)
 */
export async function seedOrdersDemo(orders: OrdersModule, admin: SessionPrincipal, options: { currency?: string } = {}): Promise<OrdersDemoSeedResult> {
  if (!(await orders.catalog.isEmpty())) return { seeded: false, groupPublicId: null, productPublicIds: [] };
  const currency = options.currency ?? "USD";
  const group = await orders.catalog.createGroup(admin, {
    name: "Demo Catalog (synthetic)",
    description: "Synthetic demo data. Replace with your real catalog before going live.",
    sortOrder: 0,
    active: true,
  });
  const productPublicIds: string[] = [];
  for (const [index, product] of DEMO_PRODUCTS.entries()) {
    const created = await orders.catalog.createProduct(admin, {
      ...product,
      features: [...product.features],
      currency,
      groupId: group.publicId,
      sortOrder: index,
      active: true,
    });
    productPublicIds.push(created.publicId);
  }
  return { seeded: true, groupPublicId: group.publicId, productPublicIds };
}
