/**
 * Server-side Cart & Checkout business logic (Increment 04, Package L).
 * Owner: recovery_ops_engineer.
 *
 * Security & business invariants:
 *  - Feature `cart` defaults OFF; all customer operations fail closed (`NOT_FOUND: CART_FEATURE_DISABLED`) when off.
 *  - Customer ownership re-evaluated on every read/write; cross-customer IDs yield `NOT_FOUND` + `authz.cart.denied`.
 *  - Prices, bundle rules, and tax are ALWAYS recomputed on the server from the live catalogue and compliance settings.
 *  - Checkout creates the order and one issued invoice atomically in ONE DB transaction (`tx`), then invokes
 *    `payments.startCheckout` outside `tx` (no DB locks held across outbound HTTPS).
 *  - `getCheckoutStatus` is strictly read-only and NEVER marks an invoice or attempt paid (Decision 12).
 *  - `restoreCheckout` is an idempotent `POST` mutation that cancels unpaid attempts and refuses if already paid.
 */
import { and, asc, desc, eq, inArray, like, lt, lte, or } from "drizzle-orm";
import { roleHasCapability } from "../../../shared/capabilities.js";
import type { ModuleDeps } from "../../container.js";
import { conflict, DomainError, forbidden, notFound, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { ClaimedJob, DbOrTx, JobResult, ModuleHealth, SessionPrincipal, Tx } from "../../core/types.js";
import { users } from "../identity/schema.js";
import type { CatalogGroupView, CatalogProductView } from "../orders/catalog.js";
import { readSetting } from "../platform/index.js";
import {
  cartCompliancePort,
  cartOrdersPort,
  cartPaymentsPort,
  computeCartBundlePricing,
  createCartActorCheck,
} from "./ports.js";
import { cartItems, carts, type CartItemRow, type CartRow } from "./schema.js";
import { CART_ABANDONED_TTL_HOURS, CART_FEATURE_FLAG } from "./settings.js";
import {
  billingDetailsSchema,
  type AdminOpenCartDetail,
  type AdminOpenCartSummary,
  type BillingDetailsInput,
  type CartLineView,
  type CartModule,
  type CartTierOptionView,
  type CartTotalsView,
  type CartView,
  type CheckoutCartResult,
  type CheckoutConfirmationState,
  type CheckoutStatusResult,
  type PacketTierName,
  type RestoreCheckoutResult,
} from "./types.js";

export const CART_JOB_EXPIRE_ABANDONED = "cart.abandoned.expire";
export const CART_SCHEDULE_EXPIRE_ABANDONED = "cart.abandoned.hourly";
const MAX_CART_LINES = 50;
const MAX_ADMIN_PAGE = 100;

function encodeCartCursor(id: number): string {
  return Buffer.from(`c:${id}`, "utf8").toString("base64url");
}

function decodeCartCursor(cursor: string | undefined): number | null {
  if (!cursor) return null;
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const match = /^c:(\d{1,15})$/.exec(raw);
  if (!match) throw validation("INVALID_CURSOR", "The list position is not valid. Reload the list.");
  return Number(match[1]);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

const staleCartVersion = () =>
  conflict("STALE_VERSION", "Your cart was updated in another tab or window. Review the refreshed cart and try again.");

const cartFeatureDisabled = () => notFound("CART_FEATURE_DISABLED");

const cartNotFound = () => notFound("CART_NOT_FOUND");

interface IndexedCatalogProduct {
  product: CatalogProductView;
  groupName: string;
  tierOptions: CartTierOptionView[];
}

function indexCatalog(groups: readonly CatalogGroupView[]): Map<string, IndexedCatalogProduct> {
  const map = new Map<string, IndexedCatalogProduct>();
  for (const group of groups) {
    const tierOptions: CartTierOptionView[] = group.products
      .filter((p): p is CatalogProductView & { tier: PacketTierName } => p.packetNumber !== null && p.tier !== null && p.active)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((p) => ({
        productPublicId: p.publicId,
        tier: p.tier,
        name: p.name,
        priceMinor: p.priceMinor,
        currency: p.currency,
        timeline: p.timeline,
      }));
    for (const product of group.products) {
      map.set(product.publicId, {
        product,
        groupName: group.name,
        tierOptions: product.packetNumber !== null ? tierOptions : [],
      });
    }
  }
  return map;
}

function formatBillingMemo(billing: BillingDetailsInput): string {
  const parts: string[] = [`Bill to: ${billing.fullName}`];
  if (billing.company) parts.push(billing.company);
  const locality = [billing.city, billing.region, billing.postalCode, billing.country].filter(Boolean).join(", ");
  if (locality) parts.push(locality);
  if (billing.taxId) parts.push(`Tax ID: ${billing.taxId}`);
  return parts.join(" · ").slice(0, 950);
}

export function createCartService(deps: ModuleDeps): CartModule {
  const actorCheck = createCartActorCheck(deps.services, deps.clock);

  const encryptNote = (note: string, cartPublicId: string): string | null =>
    note.length > 0 ? deps.crypto.encrypt(note, `carts.note:${cartPublicId}`) : null;

  const decryptNote = (noteEnc: string | null, cartPublicId: string): string => {
    if (!noteEnc) return "";
    try {
      return deps.crypto.decrypt(noteEnc, `carts.note:${cartPublicId}`);
    } catch {
      deps.logger.warn("cart note could not be decrypted", { cartPublicId });
      return "";
    }
  };

  const encryptBilling = (billing: BillingDetailsInput | null, cartPublicId: string): string | null =>
    billing ? deps.crypto.encrypt(JSON.stringify(billing), `carts.billing:${cartPublicId}`) : null;

  const decryptBilling = (billingEnc: string | null, cartPublicId: string): BillingDetailsInput | null => {
    if (!billingEnc) return null;
    try {
      const raw = JSON.parse(deps.crypto.decrypt(billingEnc, `carts.billing:${cartPublicId}`)) as unknown;
      const parsed = billingDetailsSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    } catch {
      deps.logger.warn("cart billing details could not be decrypted", { cartPublicId });
      return null;
    }
  };

  async function denyCartAuthz(
    principal: SessionPrincipal,
    reasonCode: string,
    resource: { type: string; publicId?: string | null } = { type: "cart" },
  ): Promise<void> {
    await deps.audit.record({
      category: "security",
      eventName: "authz.cart.denied",
      action: "authorize",
      outcome: "denied",
      severity: "WARN",
      reasonCode,
      actor: { userId: principal.userId, role: principal.role },
      resource,
    });
  }

  async function assertCustomerPrecheck(principal: SessionPrincipal): Promise<void> {
    if (principal.state !== "full" || principal.pendingSteps.length > 0) {
      await denyCartAuthz(principal, "REMEDIATION_SESSION");
      throw new DomainError("REMEDIATION_REQUIRED", "ACCOUNT_STEP_PENDING", "Please finish securing your account to continue.");
    }
    if (principal.role !== "customer" || !roleHasCapability(principal.role, "orders.create")) {
      await denyCartAuthz(principal, "CUSTOMER_ROLE_REQUIRED");
      throw forbidden("CUSTOMER_ROLE_REQUIRED");
    }
  }

  async function assertStaffCartReadPrecheck(principal: SessionPrincipal): Promise<void> {
    if (principal.state !== "full" || principal.pendingSteps.length > 0) {
      await denyCartAuthz(principal, "REMEDIATION_SESSION", { type: "cart_admin" });
      throw new DomainError("REMEDIATION_REQUIRED", "ACCOUNT_STEP_PENDING", "Please finish securing your account to continue.");
    }
    if ((principal.role !== "staff" && principal.role !== "admin") || !roleHasCapability(principal.role, "carts.read_all")) {
      await denyCartAuthz(principal, "CAPABILITY_NOT_GRANTED", { type: "cart_admin" });
      throw forbidden("CAPABILITY_NOT_GRANTED");
    }
  }

  async function assertCartEnabled(tx?: Tx): Promise<void> {
    const enabled = await deps.settings.isFeatureEnabled(CART_FEATURE_FLAG.flag, tx);
    if (!enabled) throw cartFeatureDisabled();
  }

  /** Computes live line items + server totals from active catalogue, bundle rule, and compliance tax rate. */
  async function computeLiveLinesAndTotals(
    itemRows: readonly CartItemRow[],
    catalogMap: ReadonlyMap<string, IndexedCatalogProduct>,
    bundleRule: Awaited<ReturnType<ReturnType<typeof cartOrdersPort>["getBundleRule"]>>,
    billingCountry: string | null,
    billingRegion: string | null,
    tx?: DbOrTx,
  ): Promise<{
    lines: CartLineView[];
    hasUnavailableItems: boolean;
    mixedCurrency: boolean;
    totals: CartTotalsView;
  }> {
    const lines: CartLineView[] = itemRows.map((row) => {
      const entry = catalogMap.get(row.productPublicId);
      if (!entry || !entry.product.active) {
        const unitPriceMinor = row.snapshotUnitPriceMinor ?? 0;
        const currency = row.snapshotCurrency ?? "USD";
        return {
          itemPublicId: row.publicId,
          productPublicId: row.productPublicId,
          packetNumber: row.packetNumber ?? null,
          groupName: entry?.groupName ?? "Unavailable item",
          tier: (row.snapshotTier as PacketTierName | null) ?? null,
          tierOptions: [],
          name: row.snapshotName ?? "Unavailable catalogue item",
          description: "",
          outcome: "",
          timeline: "",
          quantity: row.quantity,
          unitPriceMinor,
          lineTotalMinor: unitPriceMinor * row.quantity,
          currency,
          available: false,
        };
      }
      const p = entry.product;
      const lineTotalMinor = p.priceMinor * row.quantity;
      if (!Number.isSafeInteger(lineTotalMinor)) {
        throw validation("AMOUNT_TOO_LARGE", "The cart total is too large.");
      }
      return {
        itemPublicId: row.publicId,
        productPublicId: p.publicId,
        packetNumber: p.packetNumber,
        groupName: entry.groupName,
        tier: p.tier,
        tierOptions: entry.tierOptions,
        name: p.name,
        description: p.description,
        outcome: p.outcome,
        timeline: p.timeline,
        quantity: row.quantity,
        unitPriceMinor: p.priceMinor,
        lineTotalMinor,
        currency: p.currency,
        available: true,
      };
    });

    const availableLines = lines.filter((l) => l.available);
    const hasUnavailableItems = availableLines.length !== lines.length;
    const currencies = new Set(availableLines.map((l) => l.currency));
    const mixedCurrency = currencies.size > 1;
    const currency = currencies.size === 1 ? [...currencies][0]! : null;

    if (availableLines.length === 0 || mixedCurrency || !currency) {
      return {
        lines,
        hasUnavailableItems,
        mixedCurrency,
        totals: {
          currency,
          subtotalMinor: 0,
          discountMinor: 0,
          discountLabel: null,
          subtotalAfterDiscountMinor: 0,
          taxRateBps: 0,
          taxMinor: 0,
          totalMinor: 0,
          bundle: null,
        },
      };
    }

    const bundlePricing = computeCartBundlePricing(
      availableLines.map((l) => ({
        packetNumber: l.packetNumber,
        quantity: l.quantity,
        lineTotalMinor: l.lineTotalMinor,
      })),
      bundleRule,
    );

    const taxQuote = await cartCompliancePort(deps.services).quoteTaxMinor(
      {
        subtotalAfterDiscountMinor: bundlePricing.subtotalAfterDiscountMinor,
        currency,
        billingCountry,
        billingRegion,
      },
      tx,
    );

    const totalMinor = bundlePricing.subtotalAfterDiscountMinor + taxQuote.taxMinor;
    if (!Number.isSafeInteger(totalMinor)) {
      throw validation("AMOUNT_TOO_LARGE", "The cart total is too large.");
    }

    return {
      lines,
      hasUnavailableItems,
      mixedCurrency,
      totals: {
        currency,
        subtotalMinor: bundlePricing.subtotalMinor,
        discountMinor: bundlePricing.discountMinor,
        discountLabel: bundlePricing.discountLabel,
        subtotalAfterDiscountMinor: bundlePricing.subtotalAfterDiscountMinor,
        taxRateBps: taxQuote.taxRateBps,
        taxMinor: taxQuote.taxMinor,
        totalMinor,
        bundle: bundlePricing.bundle,
      },
    };
  }

  async function hydrateOpenCartForUser(userId: number, tx?: Tx): Promise<CartView> {
    const dbOrTx: DbOrTx = tx ?? deps.db;
    const ordersSvc = cartOrdersPort(deps.services);
    const complianceSvc = cartCompliancePort(deps.services);
    const paymentsSvc = cartPaymentsPort(deps.services);

    const [openCart] = await dbOrTx
      .select()
      .from(carts)
      .where(and(eq(carts.ownerUserId, userId), eq(carts.status, "open")))
      .limit(1);

    const itemRows = openCart
      ? await dbOrTx
          .select()
          .from(cartItems)
          .where(eq(cartItems.cartId, openCart.id))
          .orderBy(asc(cartItems.position), asc(cartItems.id))
      : [];

    const [catalogGroups, bundleRule, paymentConfig, onlineEnabled, pendingPolicies] = await Promise.all([
      ordersSvc.listActiveCatalog(),
      ordersSvc.getBundleRule(tx),
      paymentsSvc.getPublicCheckoutConfig(dbOrTx),
      paymentsSvc.isOnlineCheckoutEnabled(dbOrTx),
      complianceSvc.requiredAcceptancesFor(userId, { audience: "customer", ...(tx ? { tx } : {}) }),
    ]);

    const catalogMap = indexCatalog(catalogGroups);
    const billing = openCart ? decryptBilling(openCart.billingEnc, openCart.publicId) : null;
    const note = openCart ? decryptNote(openCart.noteEnc, openCart.publicId) : "";

    const computed = await computeLiveLinesAndTotals(
      itemRows,
      catalogMap,
      bundleRule,
      openCart?.billingCountry ?? billing?.country ?? null,
      openCart?.billingRegion ?? billing?.region ?? null,
      dbOrTx,
    );

    const itemCount = computed.lines.reduce((sum, l) => sum + l.quantity, 0);

    return {
      cartPublicId: openCart?.publicId ?? null,
      version: openCart?.version ?? 1,
      status: "open",
      itemCount,
      projectName: openCart?.projectName ?? "",
      note,
      billing,
      items: computed.lines,
      hasUnavailableItems: computed.hasUnavailableItems,
      mixedCurrency: computed.mixedCurrency,
      totals: computed.totals,
      paymentProvider: paymentConfig.provider,
      paymentEnvironment: paymentConfig.mode,
      onlinePaymentEnabled: onlineEnabled,
      pendingPolicies,
      updatedAt: openCart?.updatedAt ?? null,
    };
  }

  /** Lock or create the single `open` cart row for `ownerUserId` inside `tx`. */
  async function getOrCreateOpenCartInTx(tx: Tx, ownerUserId: number, now: Date): Promise<CartRow> {
    const [existing] = await tx
      .select()
      .from(carts)
      .where(and(eq(carts.ownerUserId, ownerUserId), eq(carts.status, "open")))
      .for("update")
      .limit(1);
    if (existing) return existing;

    const publicId = ulid(now.getTime());
    await tx.insert(carts).values({
      publicId,
      ownerUserId,
      activeOwnerSlot: ownerUserId,
      status: "open",
      lastActivityAt: now,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const [created] = await tx
      .select()
      .from(carts)
      .where(eq(carts.publicId, publicId))
      .for("update")
      .limit(1);
    return created!;
  }

  async function requireOpenCartWithVersionInTx(
    tx: Tx,
    ownerUserId: number,
    expectedVersion: number,
    expectedPublicId?: string,
  ): Promise<CartRow> {
    const [cart] = await tx
      .select()
      .from(carts)
      .where(and(eq(carts.ownerUserId, ownerUserId), eq(carts.status, "open")))
      .for("update")
      .limit(1);
    if (!cart || (expectedPublicId && cart.publicId !== expectedPublicId)) {
      throw cartNotFound();
    }
    if (cart.version !== expectedVersion) {
      throw staleCartVersion();
    }
    return cart;
  }

  async function bumpCartVersionInTx(
    tx: Tx,
    cart: CartRow,
    now: Date,
    extra: Partial<typeof carts.$inferInsert> = {},
  ): Promise<number> {
    const nextVersion = cart.version + 1;
    const [res] = await tx
      .update(carts)
      .set({
        ...extra,
        lastActivityAt: now,
        version: nextVersion,
        updatedAt: now,
      })
      .where(and(eq(carts.id, cart.id), eq(carts.version, cart.version)));
    if (res.affectedRows !== 1) throw staleCartVersion();
    return nextVersion;
  }

  async function executeExpireBatch(
    options: { limit?: number; job?: ClaimedJob<Record<string, never>> } = {},
  ): Promise<{ expiredCount: number }> {
    const batchLimit = Math.min(Math.max(options.limit ?? 100, 1), 200);
    const ttlHours = await readSetting(deps.settings, CART_ABANDONED_TTL_HOURS);
    const now = deps.clock.now();
    const cutoff = new Date(now.getTime() - ttlHours * 3_600_000);

    return deps.db.transaction(async (tx) => {
      if (options.job) {
        await options.job.assertStillOwned(tx);
      }
      const staleRows = await tx
        .select()
        .from(carts)
        .where(and(eq(carts.status, "open"), lte(carts.lastActivityAt, cutoff)))
        .orderBy(asc(carts.lastActivityAt), asc(carts.id))
        .limit(batchLimit)
        .for("update");

      let expiredCount = 0;
      for (const row of staleRows) {
        const [updated] = await tx
          .update(carts)
          .set({
            status: "expired",
            activeOwnerSlot: null,
            expiredAt: now,
            version: row.version + 1,
            updatedAt: now,
          })
          .where(and(eq(carts.id, row.id), eq(carts.version, row.version), eq(carts.status, "open")));
        if (updated.affectedRows !== 1) continue;
        expiredCount += 1;
        await deps.audit.record(
          {
            category: "business",
            eventName: "cart.expired",
            action: "expire",
            outcome: "completed",
            actor: { role: "system" },
            resource: { type: "cart", publicId: row.publicId },
            ...(options.job ? { correlationId: options.job.correlationId, jobId: options.job.jobId } : {}),
            attributes: {
              inactivity_hours: ttlHours,
            },
          },
          tx,
        );
      }
      return { expiredCount };
    });
  }

  let initialized = false;

  return {
    init() {
      if (initialized) return;
      initialized = true;
      deps.jobs.register<Record<string, never>>(
        CART_JOB_EXPIRE_ABANDONED,
        async (job): Promise<JobResult> => {
          const { expiredCount } = await executeExpireBatch({ limit: 100, job });
          return { outcome: "completed", safeCounts: { expired_carts: expiredCount } };
        },
        { retrySafe: true },
      );
      deps.jobs.registerSchedule({
        name: CART_SCHEDULE_EXPIRE_ABANDONED,
        type: CART_JOB_EXPIRE_ABANDONED,
        everyMs: 60 * 60 * 1000,
        payload: {},
      });
    },

    async health(): Promise<ModuleHealth[]> {
      const checkedAt = deps.clock.now();
      try {
        const enabled = await deps.settings.isFeatureEnabled(CART_FEATURE_FLAG.flag);
        return [
          {
            component: "cart.checkout",
            state: "ok",
            summary: enabled
              ? "Shopping cart and checkout are enabled."
              : "Shopping cart is disabled (default).",
            checkedAt,
          },
        ];
      } catch {
        return [{ component: "cart.checkout", state: "failing", summary: "Cart state could not be checked.", checkedAt }];
      }
    },

    async getBadgeCount(principal) {
      if (principal.state !== "full" || principal.pendingSteps.length > 0 || principal.role !== "customer") {
        return { enabled: false, itemCount: 0 };
      }
      const enabled = await deps.settings.isFeatureEnabled(CART_FEATURE_FLAG.flag);
      if (!enabled) return { enabled: false, itemCount: 0 };

      const [openCart] = await deps.db
        .select({ id: carts.id })
        .from(carts)
        .where(and(eq(carts.ownerUserId, principal.userId), eq(carts.status, "open")))
        .limit(1);
      if (!openCart) return { enabled: true, itemCount: 0 };

      const rows = await deps.db
        .select({ quantity: cartItems.quantity })
        .from(cartItems)
        .where(eq(cartItems.cartId, openCart.id))
        .limit(MAX_CART_LINES);
      const itemCount = rows.reduce((sum, r) => sum + r.quantity, 0);
      return { enabled: true, itemCount };
    },

    async getMyCart(principal) {
      await assertCustomerPrecheck(principal);
      await assertCartEnabled();
      return hydrateOpenCartForUser(principal.userId);
    },

    async addItems(principal, input) {
      await assertCustomerPrecheck(principal);
      await assertCartEnabled();

      // Deduplicate repeated productPublicIds in the same call
      const seenProductIds = new Set<string>();
      for (const item of input.items) {
        if (seenProductIds.has(item.productPublicId)) {
          throw validation("DUPLICATE_ITEM", "Each item may appear once per request; adjust the quantity instead.");
        }
        seenProductIds.add(item.productPublicId);
      }

      const catalogGroups = await cartOrdersPort(deps.services).listActiveCatalog();
      const catalogMap = indexCatalog(catalogGroups);

      // Validate every requested item against the live active catalogue on the server
      const resolvedAdditions = input.items.map((item) => {
        const entry = catalogMap.get(item.productPublicId);
        if (!entry || !entry.product.active) {
          throw validation("PRODUCT_UNAVAILABLE", "One of the selected items is no longer available.");
        }
        if (entry.product.packetNumber !== null && item.quantity !== 1) {
          throw validation("PACKET_QUANTITY_ONE", "Each packet can be ordered once.");
        }
        return {
          product: entry.product,
          quantity: item.quantity,
        };
      });

      // Refuse two tiers of the same packet in one addItems call
      const seenPacketsInRequest = new Set<number>();
      for (const entry of resolvedAdditions) {
        if (entry.product.packetNumber !== null) {
          if (seenPacketsInRequest.has(entry.product.packetNumber)) {
            throw validation("PACKET_TIER_CONFLICT", "Choose one tier per packet.");
          }
          seenPacketsInRequest.add(entry.product.packetNumber);
        }
      }

      await deps.db.transaction(async (tx) => {
        const liveActor = await actorCheck(principal, tx, "orders.create");
        if (liveActor.role !== "customer") throw forbidden("CUSTOMER_ROLE_REQUIRED");
        await assertCartEnabled(tx);

        const now = deps.clock.now();
        const cart = await getOrCreateOpenCartInTx(tx, principal.userId, now);
        const existingItems = await tx
          .select()
          .from(cartItems)
          .where(eq(cartItems.cartId, cart.id))
          .orderBy(asc(cartItems.position), asc(cartItems.id))
          .for("update");

        // Enforce single currency across existing available items + newly added items
        const currencies = new Set<string>();
        for (const existing of existingItems) {
          const live = catalogMap.get(existing.productPublicId);
          if (live?.product.active) currencies.add(live.product.currency);
        }
        for (const add of resolvedAdditions) {
          currencies.add(add.product.currency);
        }
        if (currencies.size > 1) {
          throw validation("MIXED_CURRENCY", "Items priced in different currencies cannot be combined in one cart.");
        }

        let nextPosition = existingItems.reduce((maxPos, r) => Math.max(maxPos, r.position + 1), 0);
        let projectedCount = existingItems.length;

        for (const add of resolvedAdditions) {
          const sameProduct = existingItems.find((r) => r.productPublicId === add.product.publicId);
          if (sameProduct) {
            const nextQty = add.product.packetNumber !== null ? 1 : Math.min(1000, sameProduct.quantity + add.quantity);
            await tx
              .update(cartItems)
              .set({
                quantity: nextQty,
                snapshotName: add.product.name,
                snapshotTier: add.product.tier,
                snapshotUnitPriceMinor: add.product.priceMinor,
                snapshotCurrency: add.product.currency,
                updatedAt: now,
              })
              .where(eq(cartItems.id, sameProduct.id));
            continue;
          }

          if (add.product.packetNumber !== null) {
            const samePacket = existingItems.find((r) => r.packetNumber === add.product.packetNumber);
            if (samePacket) {
              if (input.replacePacketTiers === false) {
                throw validation("PACKET_TIER_CONFLICT", "Choose one tier per packet.");
              }
              await tx
                .update(cartItems)
                .set({
                  productPublicId: add.product.publicId,
                  packetNumber: add.product.packetNumber,
                  quantity: 1,
                  snapshotName: add.product.name,
                  snapshotTier: add.product.tier,
                  snapshotUnitPriceMinor: add.product.priceMinor,
                  snapshotCurrency: add.product.currency,
                  updatedAt: now,
                })
                .where(eq(cartItems.id, samePacket.id));
              continue;
            }
          }

          projectedCount += 1;
          if (projectedCount > MAX_CART_LINES) {
            throw validation("CART_LIMIT_REACHED", `A cart can hold at most ${MAX_CART_LINES} line items.`);
          }

          await tx.insert(cartItems).values({
            publicId: ulid(now.getTime()),
            cartId: cart.id,
            productPublicId: add.product.publicId,
            packetNumber: add.product.packetNumber,
            quantity: add.quantity,
            position: nextPosition++,
            snapshotName: add.product.name,
            snapshotTier: add.product.tier,
            snapshotUnitPriceMinor: add.product.priceMinor,
            snapshotCurrency: add.product.currency,
            createdAt: now,
            updatedAt: now,
          });
        }

        const extraUpdates: Partial<typeof carts.$inferInsert> = {};
        if (input.projectName !== undefined && input.projectName.length > 0) {
          extraUpdates.projectName = input.projectName;
        }
        if (input.note !== undefined && input.note.length > 0) {
          extraUpdates.noteEnc = encryptNote(input.note, cart.publicId);
        }
        await bumpCartVersionInTx(tx, cart, now, extraUpdates);

        await deps.audit.record(
          {
            category: "business",
            eventName: "cart.item_added",
            action: "update",
            outcome: "completed",
            actor: { userId: principal.userId, role: liveActor.role },
            resource: { type: "cart", publicId: cart.publicId },
            safeCounts: { added_items: resolvedAdditions.length },
          },
          tx,
        );
      });

      return hydrateOpenCartForUser(principal.userId);
    },

    async updateItem(principal, input) {
      await assertCustomerPrecheck(principal);
      await assertCartEnabled();

      const catalogGroups = await cartOrdersPort(deps.services).listActiveCatalog();
      const catalogMap = indexCatalog(catalogGroups);

      await deps.db.transaction(async (tx) => {
        const liveActor = await actorCheck(principal, tx, "orders.create");
        if (liveActor.role !== "customer") throw forbidden("CUSTOMER_ROLE_REQUIRED");
        await assertCartEnabled(tx);

        const now = deps.clock.now();
        const cart = await requireOpenCartWithVersionInTx(tx, principal.userId, input.expectedVersion);

        const [itemRow] = await tx
          .select()
          .from(cartItems)
          .where(and(eq(cartItems.cartId, cart.id), eq(cartItems.publicId, input.itemPublicId)))
          .for("update")
          .limit(1);
        if (!itemRow) throw notFound("CART_ITEM_NOT_FOUND");

        const targetProductPublicId = input.productPublicId ?? itemRow.productPublicId;
        const entry = catalogMap.get(targetProductPublicId);
        if (!entry || !entry.product.active) {
          throw validation("PRODUCT_UNAVAILABLE", "The selected item or tier is no longer available.");
        }

        const nextQuantity = input.quantity ?? itemRow.quantity;
        if (entry.product.packetNumber !== null && nextQuantity !== 1) {
          throw validation("PACKET_QUANTITY_ONE", "Each packet can be ordered once.");
        }

        // Prevent switching to another packet that already exists on a different line in the cart
        if (entry.product.packetNumber !== null) {
          const [conflictPacket] = await tx
            .select({ id: cartItems.id })
            .from(cartItems)
            .where(and(eq(cartItems.cartId, cart.id), eq(cartItems.packetNumber, entry.product.packetNumber)))
            .limit(2);
          if (conflictPacket && conflictPacket.id !== itemRow.id) {
            throw validation("PACKET_TIER_CONFLICT", "Choose one tier per packet.");
          }
        }

        if (targetProductPublicId !== itemRow.productPublicId) {
          const [conflictProd] = await tx
            .select({ id: cartItems.id })
            .from(cartItems)
            .where(and(eq(cartItems.cartId, cart.id), eq(cartItems.productPublicId, targetProductPublicId)))
            .limit(1);
          if (conflictProd && conflictProd.id !== itemRow.id) {
            throw validation("DUPLICATE_ITEM", "That item is already in your cart.");
          }
        }

        await tx
          .update(cartItems)
          .set({
            productPublicId: entry.product.publicId,
            packetNumber: entry.product.packetNumber,
            quantity: nextQuantity,
            snapshotName: entry.product.name,
            snapshotTier: entry.product.tier,
            snapshotUnitPriceMinor: entry.product.priceMinor,
            snapshotCurrency: entry.product.currency,
            updatedAt: now,
          })
          .where(eq(cartItems.id, itemRow.id));

        await bumpCartVersionInTx(tx, cart, now);

        await deps.audit.record(
          {
            category: "business",
            eventName: "cart.item_updated",
            action: "update",
            outcome: "completed",
            actor: { userId: principal.userId, role: liveActor.role },
            resource: { type: "cart", publicId: cart.publicId },
            attributes: {
              item_public_id: itemRow.publicId,
              product_public_id: entry.product.publicId,
              quantity: nextQuantity,
            },
          },
          tx,
        );
      });

      return hydrateOpenCartForUser(principal.userId);
    },

    async removeItem(principal, input) {
      await assertCustomerPrecheck(principal);
      await assertCartEnabled();

      await deps.db.transaction(async (tx) => {
        const liveActor = await actorCheck(principal, tx, "orders.create");
        if (liveActor.role !== "customer") throw forbidden("CUSTOMER_ROLE_REQUIRED");
        await assertCartEnabled(tx);

        const now = deps.clock.now();
        const cart = await requireOpenCartWithVersionInTx(tx, principal.userId, input.expectedVersion);

        const [deleted] = await tx
          .delete(cartItems)
          .where(and(eq(cartItems.cartId, cart.id), eq(cartItems.publicId, input.itemPublicId)));
        if (deleted.affectedRows === 0) {
          throw notFound("CART_ITEM_NOT_FOUND");
        }

        await bumpCartVersionInTx(tx, cart, now);

        await deps.audit.record(
          {
            category: "business",
            eventName: "cart.item_removed",
            action: "delete",
            outcome: "completed",
            actor: { userId: principal.userId, role: liveActor.role },
            resource: { type: "cart", publicId: cart.publicId },
            attributes: { item_public_id: input.itemPublicId },
          },
          tx,
        );
      });

      return hydrateOpenCartForUser(principal.userId);
    },

    async clearCart(principal, input) {
      await assertCustomerPrecheck(principal);
      await assertCartEnabled();

      await deps.db.transaction(async (tx) => {
        const liveActor = await actorCheck(principal, tx, "orders.create");
        if (liveActor.role !== "customer") throw forbidden("CUSTOMER_ROLE_REQUIRED");
        await assertCartEnabled(tx);

        const now = deps.clock.now();
        const cart = await requireOpenCartWithVersionInTx(tx, principal.userId, input.expectedVersion);
        const [deleted] = await tx.delete(cartItems).where(eq(cartItems.cartId, cart.id));

        await bumpCartVersionInTx(tx, cart, now);

        await deps.audit.record(
          {
            category: "business",
            eventName: "cart.cleared",
            action: "delete",
            outcome: "completed",
            actor: { userId: principal.userId, role: liveActor.role },
            resource: { type: "cart", publicId: cart.publicId },
            safeCounts: { removed_items: deleted.affectedRows },
          },
          tx,
        );
      });

      return hydrateOpenCartForUser(principal.userId);
    },

    async saveDraftDetails(principal, input) {
      await assertCustomerPrecheck(principal);
      await assertCartEnabled();

      await deps.db.transaction(async (tx) => {
        const liveActor = await actorCheck(principal, tx, "orders.create");
        if (liveActor.role !== "customer") throw forbidden("CUSTOMER_ROLE_REQUIRED");
        await assertCartEnabled(tx);

        const now = deps.clock.now();
        const cart = await requireOpenCartWithVersionInTx(tx, principal.userId, input.expectedVersion);

        const billingUpdates: Partial<typeof carts.$inferInsert> =
          input.billing === undefined
            ? {}
            : input.billing === null
              ? { billingEnc: null, billingCountry: null, billingRegion: null }
              : {
                  billingEnc: encryptBilling(input.billing, cart.publicId),
                  billingCountry: input.billing.country,
                  billingRegion: input.billing.region || null,
                };

        await bumpCartVersionInTx(tx, cart, now, {
          projectName: input.projectName || null,
          noteEnc: encryptNote(input.note ?? "", cart.publicId),
          ...billingUpdates,
        });

        await deps.audit.record(
          {
            category: "business",
            eventName: "cart.details_saved",
            action: "update",
            outcome: "completed",
            actor: { userId: principal.userId, role: liveActor.role },
            resource: { type: "cart", publicId: cart.publicId },
            attributes: {
              has_billing: input.billing !== null && input.billing !== undefined,
            },
          },
          tx,
        );
      });

      return hydrateOpenCartForUser(principal.userId);
    },

    async checkout(principal, input) {
      await assertCustomerPrecheck(principal);
      await assertCartEnabled();

      const ordersSvc = cartOrdersPort(deps.services);
      const complianceSvc = cartCompliancePort(deps.services);
      const paymentsSvc = cartPaymentsPort(deps.services);

      // Fast idempotency check: if this customer already checked out with the exact idempotencyKey, resume payment start
      const [existingByIdem] = await deps.db
        .select()
        .from(carts)
        .where(and(eq(carts.ownerUserId, principal.userId), eq(carts.checkoutIdempotencyKey, input.idempotencyKey)))
        .limit(1);

      let committed: {
        cartId: number;
        cartPublicId: string;
        cartVersion: number;
        orderPublicId: string;
        orderReference: string;
        invoicePublicId: string;
        invoiceNumber: string;
        currency: string;
        totalMinor: number;
        afterCommit?: () => Promise<void>;
      };

      if (
        existingByIdem &&
        existingByIdem.checkoutOrderPublicId &&
        existingByIdem.checkoutOrderReference &&
        existingByIdem.checkoutInvoicePublicId &&
        existingByIdem.checkoutInvoiceNumber &&
        existingByIdem.checkedOutCurrency &&
        existingByIdem.checkedOutTotalMinor !== null
      ) {
        committed = {
          cartId: existingByIdem.id,
          cartPublicId: existingByIdem.publicId,
          cartVersion: existingByIdem.version,
          orderPublicId: existingByIdem.checkoutOrderPublicId,
          orderReference: existingByIdem.checkoutOrderReference,
          invoicePublicId: existingByIdem.checkoutInvoicePublicId,
          invoiceNumber: existingByIdem.checkoutInvoiceNumber,
          currency: existingByIdem.checkedOutCurrency,
          totalMinor: existingByIdem.checkedOutTotalMinor,
        };
      } else {
        let deniedOtherCustomerCart = false;
        try {
          committed = await deps.db.transaction(async (tx) => {
            const liveActor = await actorCheck(principal, tx, "orders.create");
            if (liveActor.role !== "customer") throw forbidden("CUSTOMER_ROLE_REQUIRED");
            await assertCartEnabled(tx);

            const [targetCart] = await tx
              .select()
              .from(carts)
              .where(eq(carts.publicId, input.cartPublicId))
              .for("update")
              .limit(1);

            if (!targetCart) throw cartNotFound();
            if (targetCart.ownerUserId !== principal.userId) {
              deniedOtherCustomerCart = true;
              throw cartNotFound();
            }
            if (targetCart.status !== "open") {
              throw conflict("CART_NOT_OPEN", "This cart has already been submitted or expired.");
            }
            if (targetCart.version !== input.expectedVersion) {
              throw staleCartVersion();
            }

            const itemsInCart = await tx
              .select()
              .from(cartItems)
              .where(eq(cartItems.cartId, targetCart.id))
              .orderBy(asc(cartItems.position), asc(cartItems.id))
              .for("update");
            if (itemsInCart.length === 0) {
              throw validation("CART_EMPTY", "Add at least one packet or item to your cart before checking out.");
            }

            // Record any checkout policy acceptances before order creation (orders re-asserts compliance inside tx)
            if (input.policyAcceptances.length > 0) {
              await complianceSvc.recordCheckoutAcceptances(
                {
                  principal,
                  items: input.policyAcceptances,
                },
                tx,
              );
            }
            await complianceSvc.assertRequiredPoliciesAccepted(principal.userId, { audience: "customer", tx });

            // Recompute live catalogue prices & bundle discount via orders.createOrderFromCheckoutInTx
            const createdOrder = await ordersSvc.createOrderFromCheckoutInTx(
              principal,
              {
                projectName: input.projectName,
                items: itemsInCart.map((item) => ({
                  productPublicId: item.productPublicId,
                  quantity: item.quantity,
                })),
                ...(input.note ? { note: input.note } : {}),
                idempotencyKey: input.idempotencyKey,
              },
              tx,
            );

            // Recompute server-side tax in minor units on subtotal after bundle discount
            const taxQuote = await complianceSvc.quoteTaxMinor(
              {
                subtotalAfterDiscountMinor: createdOrder.totalMinor,
                currency: createdOrder.currency,
                billingCountry: input.billing.country,
                billingRegion: input.billing.region || null,
              },
              tx,
            );

            // Issue one consolidated invoice atomically in the SAME transaction
            const issuedInvoice = await complianceSvc.issueCheckoutInvoiceInTx(
              {
                principal,
                orderId: createdOrder.id,
                orderPublicId: createdOrder.publicId,
                currency: createdOrder.currency,
                lines: createdOrder.lineItems.map((li) => ({
                  description: li.name,
                  quantity: li.quantity,
                  unitAmountMinor: li.unitPriceMinor,
                })),
                discountMinor: createdOrder.discountMinor,
                taxMinor: taxQuote.taxMinor,
                memo: formatBillingMemo(input.billing),
              },
              tx,
            );

            const now = deps.clock.now();

            // Persist authoritative billed snapshots onto cart_items for auditability & cancel-restoration display
            const billedByProduct = new Map(createdOrder.lineItems.map((li) => [li.productPublicId, li]));
            for (const row of itemsInCart) {
              const billed = billedByProduct.get(row.productPublicId);
              if (billed) {
                await tx
                  .update(cartItems)
                  .set({
                    snapshotName: billed.name,
                    snapshotUnitPriceMinor: billed.unitPriceMinor,
                    snapshotCurrency: billed.currency,
                    updatedAt: now,
                  })
                  .where(eq(cartItems.id, row.id));
              }
            }

            const nextVersion = targetCart.version + 1;
            const [casUpdate] = await tx
              .update(carts)
              .set({
                activeOwnerSlot: null,
                status: "awaiting_payment",
                projectName: input.projectName,
                noteEnc: encryptNote(input.note ?? "", targetCart.publicId),
                billingEnc: encryptBilling(input.billing, targetCart.publicId),
                billingCountry: input.billing.country,
                billingRegion: input.billing.region || null,
                checkoutIdempotencyKey: input.idempotencyKey,
                checkoutOrderId: createdOrder.id,
                checkoutOrderPublicId: createdOrder.publicId,
                checkoutOrderReference: createdOrder.reference,
                checkoutInvoiceId: issuedInvoice.invoiceId,
                checkoutInvoicePublicId: issuedInvoice.invoicePublicId,
                checkoutInvoiceNumber: issuedInvoice.invoiceNumber,
                checkedOutCurrency: issuedInvoice.currency,
                checkedOutSubtotalMinor: issuedInvoice.subtotalMinor,
                checkedOutDiscountMinor: issuedInvoice.discountMinor,
                checkedOutDiscountLabel: createdOrder.discountLabel,
                checkedOutTaxRateBps: taxQuote.taxRateBps,
                checkedOutTaxMinor: issuedInvoice.taxMinor,
                checkedOutTotalMinor: issuedInvoice.totalMinor,
                lastActivityAt: now,
                checkedOutAt: now,
                version: nextVersion,
                updatedAt: now,
              })
              .where(and(eq(carts.id, targetCart.id), eq(carts.version, targetCart.version), eq(carts.status, "open")));
            if (casUpdate.affectedRows !== 1) throw staleCartVersion();

            await deps.audit.record(
              {
                category: "business",
                eventName: "cart.checked_out",
                action: "transition",
                outcome: "completed",
                actor: { userId: principal.userId, role: liveActor.role },
                resource: { type: "cart", publicId: targetCart.publicId },
                attributes: {
                  order_public_id: createdOrder.publicId,
                  invoice_public_id: issuedInvoice.invoicePublicId,
                  currency: issuedInvoice.currency,
                  subtotal_minor: issuedInvoice.subtotalMinor,
                  discount_minor: issuedInvoice.discountMinor,
                  tax_minor: issuedInvoice.taxMinor,
                  total_minor: issuedInvoice.totalMinor,
                },
                safeCounts: { items: itemsInCart.length },
              },
              tx,
            );

            return {
              cartId: targetCart.id,
              cartPublicId: targetCart.publicId,
              cartVersion: nextVersion,
              orderPublicId: createdOrder.publicId,
              orderReference: createdOrder.reference,
              invoicePublicId: issuedInvoice.invoicePublicId,
              invoiceNumber: issuedInvoice.invoiceNumber,
              currency: issuedInvoice.currency,
              totalMinor: issuedInvoice.totalMinor,
              afterCommit: createdOrder.afterCommit,
            };
          });
        } catch (err) {
          if (deniedOtherCustomerCart) {
            await denyCartAuthz(principal, "NOT_CART_OWNER", { type: "cart", publicId: input.cartPublicId });
          }
          throw err;
        }

        if (committed.afterCommit) {
          try {
            await committed.afterCommit();
          } catch (notifyErr) {
            deps.logger.warn("post-checkout order notification callback failed", {
              orderPublicId: committed.orderPublicId,
              errorName: notifyErr instanceof Error ? notifyErr.name : "unknown",
            });
          }
        }
      }

      // Start hosted payment session or settle into pay-by-invoice mode OUTSIDE the DB transaction
      const paymentStart = await paymentsSvc.startCheckout(
        committed.invoicePublicId,
        {
          successPath: "/checkout/return",
          cancelPath: "/checkout/cancel",
        },
        {
          principal,
          cartPublicId: committed.cartPublicId,
          idempotencyKey: input.idempotencyKey,
        },
      );

      await deps.db.transaction(async (tx) => {
        const [locked] = await tx.select().from(carts).where(eq(carts.id, committed.cartId)).for("update").limit(1);
        if (!locked) return;
        const now = deps.clock.now();
        const nextStatus = paymentStart.mode === "invoice" ? "checked_out" : "awaiting_payment";
        await tx
          .update(carts)
          .set({
            status: nextStatus,
            paymentMode: paymentStart.mode,
            paymentAttemptPublicId: paymentStart.mode === "redirect" ? paymentStart.attemptPublicId : null,
            version: locked.version + 1,
            updatedAt: now,
          })
          .where(eq(carts.id, locked.id));

        await deps.audit.record(
          {
            category: "business",
            eventName: "cart.checkout_payment_started",
            action: "transition",
            outcome: "completed",
            actor: { userId: principal.userId, role: principal.role },
            resource: { type: "cart", publicId: committed.cartPublicId },
            attributes: {
              order_public_id: committed.orderPublicId,
              invoice_public_id: committed.invoicePublicId,
              payment_mode: paymentStart.mode,
              provider: paymentStart.mode === "redirect" ? paymentStart.provider : "none",
              attempt_public_id: paymentStart.mode === "redirect" ? paymentStart.attemptPublicId : null,
            },
          },
          tx,
        );
      });

      if (paymentStart.mode === "invoice") {
        return {
          mode: "invoice",
          cartPublicId: committed.cartPublicId,
          orderPublicId: committed.orderPublicId,
          orderReference: committed.orderReference,
          invoicePublicId: committed.invoicePublicId,
          invoiceNumber: committed.invoiceNumber,
          currency: committed.currency,
          totalMinor: committed.totalMinor,
        } satisfies CheckoutCartResult;
      }

      return {
        mode: "redirect",
        cartPublicId: committed.cartPublicId,
        orderPublicId: committed.orderPublicId,
        orderReference: committed.orderReference,
        invoicePublicId: committed.invoicePublicId,
        invoiceNumber: committed.invoiceNumber,
        attemptPublicId: paymentStart.attemptPublicId,
        provider: paymentStart.provider,
        environment: paymentStart.environment,
        redirectUrl: paymentStart.redirectUrl,
        currency: committed.currency,
        totalMinor: committed.totalMinor,
      } satisfies CheckoutCartResult;
    },

    async getCheckoutStatus(principal, input) {
      await assertCustomerPrecheck(principal);
      await assertCartEnabled();

      // Strictly read-only: NEVER mutates cart, attempt, or invoice state (Decision 12).
      let cartRow: CartRow | undefined;
      if (input.cartPublicId) {
        const [found] = await deps.db.select().from(carts).where(eq(carts.publicId, input.cartPublicId)).limit(1);
        cartRow = found;
      } else if (input.attemptPublicId) {
        const [found] = await deps.db
          .select()
          .from(carts)
          .where(eq(carts.paymentAttemptPublicId, input.attemptPublicId))
          .limit(1);
        cartRow = found;
      }

      if (!cartRow) throw cartNotFound();
      if (cartRow.ownerUserId !== principal.userId) {
        await denyCartAuthz(principal, "NOT_CART_OWNER", { type: "cart", publicId: cartRow.publicId });
        throw cartNotFound();
      }
      if (!cartRow.checkoutInvoicePublicId || !cartRow.checkoutOrderPublicId || !cartRow.checkoutOrderReference) {
        throw conflict("CART_NOT_CHECKED_OUT", "This cart has not completed checkout yet.");
      }

      const paymentsSvc = cartPaymentsPort(deps.services);
      const paymentStatus = await paymentsSvc.getCheckoutStatus(principal, {
        invoicePublicId: cartRow.checkoutInvoicePublicId,
        ...(input.attemptPublicId
          ? { attemptPublicId: input.attemptPublicId }
          : cartRow.paymentAttemptPublicId
            ? { attemptPublicId: cartRow.paymentAttemptPublicId }
            : {}),
      });

      const attempt = paymentStatus.attempt;
      let confirmationState: CheckoutConfirmationState;
      if (paymentStatus.invoiceStatus === "paid") {
        confirmationState = "paid";
      } else if (cartRow.paymentMode === "invoice" && paymentStatus.invoiceStatus === "issued") {
        confirmationState = "invoice_issued";
      } else if (cartRow.status === "restored" || attempt?.status === "cancelled" || paymentStatus.invoiceStatus === "void") {
        confirmationState = "cancelled";
      } else if (attempt?.status === "failed" || attempt?.status === "expired") {
        confirmationState = "failed";
      } else {
        confirmationState = "pending_confirmation";
      }

      const alreadyRestored = cartRow.status === "restored";
      const canRestoreToCart =
        !alreadyRestored &&
        paymentStatus.invoiceStatus !== "paid" &&
        cartRow.paymentMode === "redirect";

      return {
        cartPublicId: cartRow.publicId,
        confirmationState,
        paymentMode: cartRow.paymentMode ?? "invoice",
        provider: attempt?.provider ?? paymentStatus.providerConfigured,
        attemptPublicId: attempt?.attemptPublicId ?? cartRow.paymentAttemptPublicId ?? null,
        attemptStatus: attempt?.status ?? null,
        failureReasonCode: attempt?.failureReasonCode ?? null,
        orderPublicId: cartRow.checkoutOrderPublicId,
        orderReference: cartRow.checkoutOrderReference,
        invoicePublicId: cartRow.checkoutInvoicePublicId,
        invoiceNumber: paymentStatus.invoiceNumber ?? cartRow.checkoutInvoiceNumber ?? null,
        invoiceStatus: paymentStatus.invoiceStatus,
        currency: cartRow.checkedOutCurrency ?? paymentStatus.currency,
        subtotalMinor: cartRow.checkedOutSubtotalMinor ?? paymentStatus.amountMinor,
        discountMinor: cartRow.checkedOutDiscountMinor ?? 0,
        discountLabel: cartRow.checkedOutDiscountLabel ?? null,
        taxRateBps: cartRow.checkedOutTaxRateBps ?? 0,
        taxMinor: cartRow.checkedOutTaxMinor ?? 0,
        totalMinor: cartRow.checkedOutTotalMinor ?? paymentStatus.amountMinor,
        balanceDueMinor: paymentStatus.balanceDueMinor,
        canRestoreToCart,
        alreadyRestored,
        checkedOutAt: cartRow.checkedOutAt ?? null,
      };
    },

    async restoreCheckout(principal, input): Promise<RestoreCheckoutResult> {
      await assertCustomerPrecheck(principal);
      await assertCartEnabled();

      const paymentsSvc = cartPaymentsPort(deps.services);
      const catalogGroups = await cartOrdersPort(deps.services).listActiveCatalog();
      const catalogMap = indexCatalog(catalogGroups);

      let deniedOtherCustomer = false;
      let targetCartPublicIdForAudit: string | null = input.cartPublicId ?? null;
      let alreadyRestoredFlag = false;

      try {
        await deps.db.transaction(async (tx) => {
          const liveActor = await actorCheck(principal, tx, "orders.create");
          if (liveActor.role !== "customer") throw forbidden("CUSTOMER_ROLE_REQUIRED");
          await assertCartEnabled(tx);

          const [sourceCart] = input.cartPublicId
            ? await tx.select().from(carts).where(eq(carts.publicId, input.cartPublicId)).for("update").limit(1)
            : await tx
                .select()
                .from(carts)
                .where(eq(carts.paymentAttemptPublicId, input.attemptPublicId!))
                .for("update")
                .limit(1);

          if (!sourceCart) throw cartNotFound();
          targetCartPublicIdForAudit = sourceCart.publicId;
          if (sourceCart.ownerUserId !== principal.userId) {
            deniedOtherCustomer = true;
            throw cartNotFound();
          }

          // Idempotent repeat: already restored -> return current open cart without duplicating items
          if (sourceCart.status === "restored") {
            alreadyRestoredFlag = true;
            return;
          }

          if (sourceCart.status === "open") {
            alreadyRestoredFlag = true;
            return;
          }

          if (!sourceCart.checkoutInvoicePublicId) {
            throw conflict("CART_NOT_RESTORABLE", "This cart cannot be restored.");
          }

          const cancelResult = await paymentsSvc.cancelAttemptIfUnpaid(
            principal,
            {
              invoicePublicId: sourceCart.checkoutInvoicePublicId,
              ...(sourceCart.paymentAttemptPublicId ? { attemptPublicId: sourceCart.paymentAttemptPublicId } : {}),
            },
            tx,
          );
          if (cancelResult.status === "paid") {
            throw conflict("CHECKOUT_ALREADY_PAID", "Payment has already been confirmed for this order.");
          }

          // Also verify invoice status has not transitioned to paid
          const statusCheck = await paymentsSvc.getCheckoutStatus(principal, {
            invoicePublicId: sourceCart.checkoutInvoicePublicId,
          });
          if (statusCheck.invoiceStatus === "paid") {
            throw conflict("CHECKOUT_ALREADY_PAID", "Payment has already been confirmed for this order.");
          }

          const sourceItems = await tx
            .select()
            .from(cartItems)
            .where(eq(cartItems.cartId, sourceCart.id))
            .orderBy(asc(cartItems.position), asc(cartItems.id));

          const now = deps.clock.now();
          const openCart = await getOrCreateOpenCartInTx(tx, principal.userId, now);
          const existingOpenItems = await tx
            .select()
            .from(cartItems)
            .where(eq(cartItems.cartId, openCart.id))
            .orderBy(asc(cartItems.position), asc(cartItems.id))
            .for("update");

          let nextPos = existingOpenItems.reduce((m, r) => Math.max(m, r.position + 1), 0);
          let countInOpen = existingOpenItems.length;

          for (const srcItem of sourceItems) {
            const liveEntry = catalogMap.get(srcItem.productPublicId);
            const sameProd = existingOpenItems.find((e) => e.productPublicId === srcItem.productPublicId);
            if (sameProd) continue;

            if (srcItem.packetNumber !== null) {
              const samePacket = existingOpenItems.find((e) => e.packetNumber === srcItem.packetNumber);
              if (samePacket) continue;
            }

            if (countInOpen >= MAX_CART_LINES) break;
            countInOpen += 1;

            await tx.insert(cartItems).values({
              publicId: ulid(now.getTime()),
              cartId: openCart.id,
              productPublicId: srcItem.productPublicId,
              packetNumber: srcItem.packetNumber,
              quantity: srcItem.packetNumber !== null ? 1 : srcItem.quantity,
              position: nextPos++,
              snapshotName: liveEntry?.product.name ?? srcItem.snapshotName,
              snapshotTier: liveEntry?.product.tier ?? srcItem.snapshotTier,
              snapshotUnitPriceMinor: liveEntry?.product.priceMinor ?? srcItem.snapshotUnitPriceMinor,
              snapshotCurrency: liveEntry?.product.currency ?? srcItem.snapshotCurrency,
              createdAt: now,
              updatedAt: now,
            });
          }

          const sourceBilling = decryptBilling(sourceCart.billingEnc, sourceCart.publicId);
          const sourceNote = decryptNote(sourceCart.noteEnc, sourceCart.publicId);

          await bumpCartVersionInTx(tx, openCart, now, {
            projectName: openCart.projectName ?? sourceCart.projectName,
            noteEnc: openCart.noteEnc ?? encryptNote(sourceNote, openCart.publicId),
            billingEnc: openCart.billingEnc ?? encryptBilling(sourceBilling, openCart.publicId),
            billingCountry: openCart.billingCountry ?? sourceCart.billingCountry,
            billingRegion: openCart.billingRegion ?? sourceCart.billingRegion,
          });

          const [casSource] = await tx
            .update(carts)
            .set({
              status: "restored",
              activeOwnerSlot: null,
              restoredIntoCartPublicId: openCart.publicId,
              restoredAt: now,
              version: sourceCart.version + 1,
              updatedAt: now,
            })
            .where(and(eq(carts.id, sourceCart.id), eq(carts.version, sourceCart.version)));
          if (casSource.affectedRows !== 1) throw staleCartVersion();

          await deps.audit.record(
            {
              category: "business",
              eventName: "cart.checkout_restored",
              action: "transition",
              outcome: "completed",
              actor: { userId: principal.userId, role: liveActor.role },
              resource: { type: "cart", publicId: sourceCart.publicId },
              attributes: {
                source_cart_public_id: sourceCart.publicId,
                restored_into_cart_public_id: openCart.publicId,
                invoice_public_id: sourceCart.checkoutInvoicePublicId,
              },
              safeCounts: { restored_items: sourceItems.length },
            },
            tx,
          );
        });
      } catch (err) {
        if (deniedOtherCustomer) {
          await denyCartAuthz(principal, "NOT_CART_OWNER", { type: "cart", publicId: targetCartPublicIdForAudit });
        }
        throw err;
      }

      const cartView = await hydrateOpenCartForUser(principal.userId);
      return {
        restored: !alreadyRestoredFlag,
        alreadyRestored: alreadyRestoredFlag,
        cart: cartView,
      };
    },

    async adminListOpen(principal, input) {
      await assertStaffCartReadPrecheck(principal);

      const pageLimit = Math.min(Math.max(input.limit ?? 25, 1), MAX_ADMIN_PAGE);
      const cursorId = decodeCartCursor(input.cursor);
      const searchTrimmed = input.search?.trim() ?? "";

      const [featureEnabled, abandonedTtlHours, catalogGroups, bundleRule] = await Promise.all([
        deps.settings.isFeatureEnabled(CART_FEATURE_FLAG.flag),
        readSetting(deps.settings, CART_ABANDONED_TTL_HOURS),
        cartOrdersPort(deps.services).listActiveCatalog(),
        cartOrdersPort(deps.services).getBundleRule(),
      ]);
      const catalogMap = indexCatalog(catalogGroups);

      return deps.db.transaction(
        async (tx) => {
          const predicates = [eq(carts.status, "open")];
          if (cursorId !== null) {
            predicates.push(lt(carts.id, cursorId));
          }
          if (searchTrimmed.length > 0) {
            const pattern = `%${escapeLike(searchTrimmed)}%`;
            predicates.push(
              or(
                like(carts.publicId, pattern),
                like(carts.projectName, pattern),
                like(users.publicId, pattern),
                like(users.customerRef, pattern),
              )!,
            );
          }

          const rows = await tx
            .select({
              cart: carts,
              customerPublicId: users.publicId,
              customerRef: users.customerRef,
            })
            .from(carts)
            .innerJoin(users, eq(users.id, carts.ownerUserId))
            .where(and(...predicates))
            .orderBy(desc(carts.id))
            .limit(pageLimit + 1);

          const hasMore = rows.length > pageLimit;
          const slice = hasMore ? rows.slice(0, pageLimit) : rows;
          const nextCursor = hasMore ? encodeCartCursor(slice[slice.length - 1]!.cart.id) : null;

          const cartIds = slice.map((r) => r.cart.id);
          const allItemRows = cartIds.length
            ? await tx
                .select()
                .from(cartItems)
                .where(inArray(cartItems.cartId, cartIds))
                .orderBy(asc(cartItems.position), asc(cartItems.id))
            : [];

          const itemsByCartId = new Map<number, CartItemRow[]>();
          for (const itemRow of allItemRows) {
            const list = itemsByCartId.get(itemRow.cartId) ?? [];
            list.push(itemRow);
            itemsByCartId.set(itemRow.cartId, list);
          }

          const summaries: AdminOpenCartSummary[] = [];
          for (const row of slice) {
            const cItems = itemsByCartId.get(row.cart.id) ?? [];
            const computed = await computeLiveLinesAndTotals(
              cItems,
              catalogMap,
              bundleRule,
              row.cart.billingCountry,
              row.cart.billingRegion,
              tx,
            );
            const itemCount = computed.lines.reduce((sum, l) => sum + l.quantity, 0);
            const packetSummary =
              computed.lines.length === 0
                ? "Empty cart"
                : computed.lines
                    .map((l) => (l.packetNumber !== null ? `P${l.packetNumber} ${l.tier ?? ""}`.trim() : `${l.name} ×${l.quantity}`))
                    .join(", ")
                    .slice(0, 160);

            summaries.push({
              cartPublicId: row.cart.publicId,
              customerPublicId: row.customerPublicId,
              customerRef: row.customerRef,
              projectName: row.cart.projectName,
              itemCount,
              packetSummary,
              currency: computed.totals.currency,
              subtotalMinor: computed.totals.subtotalMinor,
              discountMinor: computed.totals.discountMinor,
              taxMinor: computed.totals.taxMinor,
              totalMinor: computed.totals.totalMinor,
              bundleApplied: computed.totals.bundle?.applied ?? false,
              hasUnavailableItems: computed.hasUnavailableItems,
              lastActivityAt: row.cart.lastActivityAt,
              expiresAt: new Date(row.cart.lastActivityAt.getTime() + abandonedTtlHours * 3_600_000),
              createdAt: row.cart.createdAt,
            });
          }

          return {
            featureEnabled,
            abandonedTtlHours,
            items: summaries,
            nextCursor,
          };
        },
        { isolationLevel: "repeatable read", withConsistentSnapshot: true },
      );
    },

    async adminGetOpen(principal, input): Promise<AdminOpenCartDetail> {
      await assertStaffCartReadPrecheck(principal);

      const [abandonedTtlHours, catalogGroups, bundleRule] = await Promise.all([
        readSetting(deps.settings, CART_ABANDONED_TTL_HOURS),
        cartOrdersPort(deps.services).listActiveCatalog(),
        cartOrdersPort(deps.services).getBundleRule(),
      ]);
      const catalogMap = indexCatalog(catalogGroups);

      return deps.db.transaction(
        async (tx) => {
          const [row] = await tx
            .select({
              cart: carts,
              customerPublicId: users.publicId,
              customerRef: users.customerRef,
            })
            .from(carts)
            .innerJoin(users, eq(users.id, carts.ownerUserId))
            .where(and(eq(carts.publicId, input.cartPublicId), eq(carts.status, "open")))
            .limit(1);

          if (!row) throw cartNotFound();

          const cItems = await tx
            .select()
            .from(cartItems)
            .where(eq(cartItems.cartId, row.cart.id))
            .orderBy(asc(cartItems.position), asc(cartItems.id));

          const computed = await computeLiveLinesAndTotals(
            cItems,
            catalogMap,
            bundleRule,
            row.cart.billingCountry,
            row.cart.billingRegion,
            tx,
          );
          const itemCount = computed.lines.reduce((sum, l) => sum + l.quantity, 0);
          const packetSummary =
            computed.lines.length === 0
              ? "Empty cart"
              : computed.lines
                  .map((l) => (l.packetNumber !== null ? `P${l.packetNumber} ${l.tier ?? ""}`.trim() : `${l.name} ×${l.quantity}`))
                  .join(", ")
                  .slice(0, 160);

          return {
            cartPublicId: row.cart.publicId,
            customerPublicId: row.customerPublicId,
            customerRef: row.customerRef,
            projectName: row.cart.projectName,
            itemCount,
            packetSummary,
            currency: computed.totals.currency,
            subtotalMinor: computed.totals.subtotalMinor,
            discountMinor: computed.totals.discountMinor,
            taxMinor: computed.totals.taxMinor,
            totalMinor: computed.totals.totalMinor,
            bundleApplied: computed.totals.bundle?.applied ?? false,
            hasUnavailableItems: computed.hasUnavailableItems,
            lastActivityAt: row.cart.lastActivityAt,
            expiresAt: new Date(row.cart.lastActivityAt.getTime() + abandonedTtlHours * 3_600_000),
            createdAt: row.cart.createdAt,
            items: computed.lines,
            totals: computed.totals,
          };
        },
        { isolationLevel: "repeatable read", withConsistentSnapshot: true },
      );
    },

    expireAbandonedCarts(options) {
      return executeExpireBatch({ ...(options?.limit !== undefined ? { limit: options.limit } : {}) });
    },
  };
}
