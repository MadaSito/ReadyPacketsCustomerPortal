/**
 * Cart Upsell service: server-side suggestion engine, per-cart counters/dismissals, idempotent accept,
 * and administrator CRUD (`carts.upsells.manage`) (Increment 05, Package B, Decision D2 / ADR 0043).
 * Owner: recovery_ops_engineer.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { roleHasCapability } from "../../../shared/capabilities.js";
import type { ModuleDeps } from "../../container.js";
import { DomainError, conflict, forbidden, notFound, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { DbOrTx, SessionPrincipal, Tx } from "../../core/types.js";
import type { CatalogGroupView, CatalogProductView } from "../orders/catalog.js";
import type { BundleRule } from "../orders/settings.js";
import { readSetting, writeSetting } from "../platform/index.js";
import {
  cartOrdersPort,
  roundHalfUpPercent,
  type CartActorCheck,
} from "./ports.js";
import {
  CART_UPSELL_RULE_TYPES,
  cartItems,
  cartUpsellAcceptances,
  cartUpsellCartStates,
  cartUpsellOffers,
  carts,
  type CartRow,
  type CartUpsellOfferRow,
  type CartUpsellRuleType,
} from "./schema.js";
import {
  CART_FEATURE_FLAG,
  CART_UPSELL_FEATURE_FLAG,
  CART_UPSELL_SEEDED_KEYS,
} from "./settings.js";
import {
  BUNDLE_COMPLETION_OFFER_KEY,
  type AdminCartUpsellCatalogProductView,
  type AdminCartUpsellOfferView,
  type AdminCartUpsellsListResult,
  type CartLineView,
  type CartTierOptionView,
  type CartUpsellSuggestionView,
  type CartUpsellTargetProductView,
  type CartView,
  type PacketTierName,
  type acceptUpsellInputSchema,
  type adminUpsellCreateInputSchema,
  type adminUpsellDeleteInputSchema,
  type adminUpsellDuplicateInputSchema,
  type adminUpsellSetActiveInputSchema,
  type adminUpsellSetAllActiveInputSchema,
  type adminUpsellSetFeatureInputSchema,
  type adminUpsellUpdateInputSchema,
  type dismissUpsellInputSchema,
} from "./types.js";
import { buildCatalogStarterSuggestions } from "./upsellSeed.js";
import type { z } from "zod";

export const MAX_CART_UPSELLS = 3;
const BUNDLE_COMPLETION_PRIORITY = 50;
const MAX_CART_LINES = 50;

export interface IndexedCatalogEntry {
  product: CatalogProductView;
  groupName: string;
  tierOptions: CartTierOptionView[];
}

const upsellFeatureDisabled = () =>
  notFound("CART_UPSELL_DISABLED");

const offerNotFound = () =>
  notFound("UPSELL_OFFER_NOT_FOUND");

const staleOfferVersion = () =>
  conflict("UPSELL_OFFER_VERSION_CONFLICT", "This suggestion was updated in another session. Refresh and try again.");

function normalizeRuleType(raw: string | null | undefined): CartUpsellRuleType {
  if (raw && (CART_UPSELL_RULE_TYPES as readonly string[]).includes(raw)) {
    return raw as CartUpsellRuleType;
  }
  return "standard";
}

function buildBundleCompletionCandidate(params: {
  availableLines: readonly CartLineView[];
  lineByPacket: ReadonlyMap<number, CartLineView>;
  catalogGroups: readonly CatalogGroupView[];
  bundleRule: BundleRule;
  currency: string;
  offerPublicId: string;
  priority: number;
  tieBreak: number;
  customTitle?: string;
  customShortText?: string;
  requireMultiplePacketsForLargeBundle: boolean;
}): {
  priority: number;
  tieBreak: number;
  claimedProductIds: string[];
  claimedPackets: number[];
  suggestion: CartUpsellSuggestionView;
} | null {
  const {
    availableLines,
    lineByPacket,
    catalogGroups,
    bundleRule,
    currency,
    offerPublicId,
    priority,
    tieBreak,
    customTitle,
    customShortText,
    requireMultiplePacketsForLargeBundle,
  } = params;

  if (!bundleRule.enabled || bundleRule.discountPercent <= 0 || bundleRule.requiredPacketNumbers.length === 0) {
    return null;
  }

  const required = [...bundleRule.requiredPacketNumbers].sort((a, b) => a - b);
  const presentRequiredCount = required.filter((n) => lineByPacket.has(n)).length;
  const missingPacketNumbers = required.filter((n) => !lineByPacket.has(n));
  if (missingPacketNumbers.length < 1) return null;

  if (requireMultiplePacketsForLargeBundle && required.length >= 4) {
    // D3(b): complete-the-bundle when several packets (>= 2) are in the cart.
    if (presentRequiredCount < 2) return null;
  } else if (missingPacketNumbers.length > 2) {
    return null;
  }

  // Match the customer's existing tier when uniform across cart packets; otherwise pick lowest-priced active tier.
  const existingTiers = new Set(
    [...lineByPacket.values()].map((l) => l.tier).filter((t): t is PacketTierName => t !== null),
  );
  const preferredTier = existingTiers.size === 1 ? [...existingTiers][0]! : null;

  const missingTargets: CartUpsellTargetProductView[] = [];
  for (const pktNum of missingPacketNumbers) {
    const groupMatches: { product: CatalogProductView; groupName: string }[] = [];
    for (const group of catalogGroups) {
      for (const p of group.products) {
        if (p.active && p.packetNumber === pktNum && p.currency === currency) {
          groupMatches.push({ product: p, groupName: group.name });
        }
      }
    }
    if (groupMatches.length === 0) {
      return null;
    }
    groupMatches.sort((a, b) => a.product.priceMinor - b.product.priceMinor);
    const chosen =
      (preferredTier ? groupMatches.find((m) => m.product.tier === preferredTier) : undefined) ??
      groupMatches[0]!;
    missingTargets.push({
      productPublicId: chosen.product.publicId,
      name: chosen.product.name,
      groupName: chosen.groupName,
      packetNumber: chosen.product.packetNumber,
      tier: chosen.product.tier as PacketTierName | null,
      unitPriceMinor: chosen.product.priceMinor,
      currency: chosen.product.currency,
    });
  }

  if (missingTargets.length === 0) return null;

  const currentSubtotalMinor = availableLines.reduce((sum, l) => sum + l.lineTotalMinor, 0);
  const addedSubtotalMinor = missingTargets.reduce((sum, t) => sum + t.unitPriceMinor, 0);
  const combinedSubtotalMinor = currentSubtotalMinor + addedSubtotalMinor;

  if (!Number.isSafeInteger(combinedSubtotalMinor) || !Number.isSafeInteger(combinedSubtotalMinor * 100)) {
    return null;
  }
  const bundleSavingMinor = Math.min(
    combinedSubtotalMinor,
    roundHalfUpPercent(combinedSubtotalMinor, bundleRule.discountPercent),
  );
  if (bundleSavingMinor <= 0) return null;

  const netDeltaMinor = Math.max(0, addedSubtotalMinor - bundleSavingMinor);
  const namesText = missingTargets.map((t) => t.name).join(" and ");
  const defaultTitle =
    missingTargets.length === 1
      ? `Complete ${bundleRule.label}`
      : `Add ${missingTargets.length} packets to complete ${bundleRule.label}`;
  const defaultShortText = `Add ${namesText} to complete ${bundleRule.label} (${bundleRule.discountPercent}% off your bundle subtotal).`;
  const title = customTitle?.trim() ? customTitle.trim() : defaultTitle;
  const rawShortText = customShortText?.trim() ? customShortText.trim() : defaultShortText;

  return {
    priority,
    tieBreak,
    claimedProductIds: missingTargets.map((t) => t.productPublicId),
    claimedPackets: missingPacketNumbers,
    suggestion: {
      offerPublicId,
      kind: "bundle_completion",
      title: title.length <= 120 ? title : `${title.slice(0, 119)}…`,
      shortText: rawShortText.length <= 200 ? rawShortText : `${rawShortText.slice(0, 199)}…`,
      currency,
      priceMinor: netDeltaMinor,
      fullTargetPriceMinor: addedSubtotalMinor,
      savingMinor: bundleSavingMinor,
      targetProducts: missingTargets,
      currentProduct: null,
    },
  };
}

/**
 * Pure server-side upsell suggestion evaluator (Decisions D2 & D3).
 * Never suggests inactive products, items already in the cart, lower/equal-priced packet tiers,
 * mixed-currency products, or offers dismissed on this cart. Capped at 3 suggestions.
 */
export function computeEligibleUpsells(input: {
  availableLines: readonly CartLineView[];
  catalogGroups: readonly CatalogGroupView[];
  catalogMap: ReadonlyMap<string, IndexedCatalogEntry>;
  bundleRule: BundleRule;
  activeOffers: readonly CartUpsellOfferRow[];
  dismissedOfferKeys: ReadonlySet<string>;
  now: Date;
  hasConfiguredBundleOffer?: boolean;
}): CartUpsellSuggestionView[] {
  const {
    availableLines,
    catalogGroups,
    catalogMap,
    bundleRule,
    activeOffers,
    dismissedOfferKeys,
    now,
    hasConfiguredBundleOffer = false,
  } = input;
  if (availableLines.length === 0) return [];

  const currencies = new Set(availableLines.map((l) => l.currency));
  if (currencies.size !== 1) return [];
  const currency = [...currencies][0]!;

  const cartProductIds = new Set(availableLines.map((l) => l.productPublicId));
  const lineByPacket = new Map<number, CartLineView>();
  for (const line of availableLines) {
    if (line.packetNumber !== null) {
      lineByPacket.set(line.packetNumber, line);
    }
  }

  interface Candidate {
    priority: number;
    tieBreak: number;
    claimedProductIds: string[];
    claimedPackets: number[];
    suggestion: CartUpsellSuggestionView;
  }

  const candidates: Candidate[] = [];
  const nowMs = now.getTime();
  let evaluatedBundleRow = false;

  for (const offer of activeOffers) {
    if (!offer.active) continue;
    if (offer.startsAt && offer.startsAt.getTime() > nowMs) continue;
    if (offer.endsAt && offer.endsAt.getTime() <= nowMs) continue;
    if (dismissedOfferKeys.has(offer.publicId)) continue;

    if (offer.triggerMode === "products") {
      const triggers = Array.isArray(offer.triggerProductPublicIds) ? offer.triggerProductPublicIds : [];
      if (!triggers.some((pid) => cartProductIds.has(pid))) continue;
    }

    const ruleType = normalizeRuleType(offer.ruleType);
    if (ruleType === "bundle_completion") {
      evaluatedBundleRow = true;
      const bundleCand = buildBundleCompletionCandidate({
        availableLines,
        lineByPacket,
        catalogGroups,
        bundleRule,
        currency,
        offerPublicId: offer.publicId,
        priority: offer.priority,
        tieBreak: offer.id,
        customTitle: offer.title,
        customShortText: offer.shortText,
        requireMultiplePacketsForLargeBundle: true,
      });
      if (bundleCand) {
        candidates.push(bundleCand);
      }
      continue;
    }

    const targetEntry = catalogMap.get(offer.targetProductPublicId);
    if (!targetEntry || !targetEntry.product.active) continue;
    const target = targetEntry.product;
    if (target.currency !== currency) continue;
    if (cartProductIds.has(target.publicId)) continue;

    const targetView: CartUpsellTargetProductView = {
      productPublicId: target.publicId,
      name: target.name,
      groupName: targetEntry.groupName,
      packetNumber: target.packetNumber,
      tier: target.tier as PacketTierName | null,
      unitPriceMinor: target.priceMinor,
      currency: target.currency,
    };

    if (offer.kind === "add_on") {
      // Never suggest a packet product whose packet number is already in the cart (would break 1-tier-per-packet).
      if (target.packetNumber !== null && lineByPacket.has(target.packetNumber)) continue;

      candidates.push({
        priority: offer.priority,
        tieBreak: offer.id,
        claimedProductIds: [target.publicId],
        claimedPackets: target.packetNumber !== null ? [target.packetNumber] : [],
        suggestion: {
          offerPublicId: offer.publicId,
          kind: "add_on",
          title: offer.title,
          shortText: offer.shortText,
          currency,
          priceMinor: target.priceMinor,
          fullTargetPriceMinor: target.priceMinor,
          savingMinor: null,
          targetProducts: [targetView],
          currentProduct: null,
        },
      });
    } else if (offer.kind === "tier_upgrade") {
      if (target.packetNumber === null) continue;
      const currentLine = lineByPacket.get(target.packetNumber);
      if (!currentLine) continue;
      // Strictly higher-priced tier only — never suggest a lower-priced or equal-priced tier (D2).
      if (target.priceMinor <= currentLine.unitPriceMinor) continue;
      const deltaMinor = target.priceMinor - currentLine.unitPriceMinor;

      candidates.push({
        priority: offer.priority,
        tieBreak: offer.id,
        claimedProductIds: [target.publicId],
        claimedPackets: [target.packetNumber],
        suggestion: {
          offerPublicId: offer.publicId,
          kind: "tier_upgrade",
          title: offer.title,
          shortText: offer.shortText,
          currency,
          priceMinor: deltaMinor,
          fullTargetPriceMinor: target.priceMinor,
          savingMinor: null,
          targetProducts: [targetView],
          currentProduct: {
            productPublicId: currentLine.productPublicId,
            name: currentLine.name,
            packetNumber: currentLine.packetNumber,
            tier: currentLine.tier,
            unitPriceMinor: currentLine.unitPriceMinor,
          },
        },
      });
    }
  }

  // Automatic bundle-completion fallback ONLY when no `bundle_completion` row is configured in `cart_upsell_offers`.
  if (!hasConfiguredBundleOffer && !evaluatedBundleRow && !dismissedOfferKeys.has(BUNDLE_COMPLETION_OFFER_KEY)) {
    const fallbackCand = buildBundleCompletionCandidate({
      availableLines,
      lineByPacket,
      catalogGroups,
      bundleRule,
      currency,
      offerPublicId: BUNDLE_COMPLETION_OFFER_KEY,
      priority: BUNDLE_COMPLETION_PRIORITY,
      tieBreak: 0,
      requireMultiplePacketsForLargeBundle: false,
    });
    if (fallbackCand) {
      candidates.push(fallbackCand);
    }
  }

  candidates.sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.tieBreak - b.tieBreak));

  const selected: CartUpsellSuggestionView[] = [];
  const usedProductIds = new Set<string>();
  const usedPackets = new Set<number>();

  for (const cand of candidates) {
    if (selected.length >= MAX_CART_UPSELLS) break;
    if (cand.claimedProductIds.some((pid) => usedProductIds.has(pid))) continue;
    if (cand.claimedPackets.some((pkt) => usedPackets.has(pkt))) continue;

    for (const pid of cand.claimedProductIds) usedProductIds.add(pid);
    for (const pkt of cand.claimedPackets) usedPackets.add(pkt);
    selected.push(cand.suggestion);
  }

  return selected;
}

export interface CartUpsellServiceDeps {
  deps: ModuleDeps;
  actorCheck: CartActorCheck;
  indexCatalog: (groups: readonly CatalogGroupView[]) => Map<string, IndexedCatalogEntry>;
  assertCustomerPrecheck: (principal: SessionPrincipal) => Promise<void>;
  assertCartEnabled: (tx?: Tx) => Promise<void>;
  denyCartAuthz: (
    principal: SessionPrincipal,
    reasonCode: string,
    resource?: { type: string; publicId?: string | null },
  ) => Promise<void>;
  bumpCartVersionInTx: (
    tx: Tx,
    cart: CartRow,
    now: Date,
    extra?: Partial<typeof carts.$inferInsert>,
  ) => Promise<number>;
  hydrateOpenCartForUser: (principal: SessionPrincipal, tx?: Tx, opts?: { recordImpressions?: boolean }) => Promise<CartView>;
  computeLiveLines: (
    cartId: number,
    catalogMap: ReadonlyMap<string, IndexedCatalogEntry>,
    tx: DbOrTx,
  ) => Promise<CartLineView[]>;
}

export function createCartUpsellService(ctx: CartUpsellServiceDeps) {
  const {
    deps,
    actorCheck,
    indexCatalog,
    assertCustomerPrecheck,
    assertCartEnabled,
    denyCartAuthz,
    bumpCartVersionInTx,
    hydrateOpenCartForUser,
    computeLiveLines,
  } = ctx;

  async function isUpsellEnabled(tx?: DbOrTx): Promise<boolean> {
    const [cartOn, upsellOn] = await Promise.all([
      deps.settings.isFeatureEnabled(CART_FEATURE_FLAG.flag, tx as Tx | undefined),
      deps.settings.isFeatureEnabled(CART_UPSELL_FEATURE_FLAG.flag, tx as Tx | undefined),
    ]);
    return cartOn && upsellOn;
  }

  async function assertUpsellEnabled(tx?: Tx): Promise<void> {
    await assertCartEnabled(tx);
    const enabled = await deps.settings.isFeatureEnabled(CART_UPSELL_FEATURE_FLAG.flag, tx);
    if (!enabled) throw upsellFeatureDisabled();
  }

  /**
   * Abuse case (§4): customer calling admin upsell procedures receives `NOT_FOUND` (`404`);
   * staff without `carts.upsells.manage` receives `FORBIDDEN` (`403`).
   */
  async function assertAdminUpsellManagePrecheck(principal: SessionPrincipal): Promise<void> {
    if (principal.state !== "full" || principal.pendingSteps.length > 0) {
      await denyCartAuthz(principal, "REMEDIATION_SESSION", { type: "cart_upsell_offer" });
      throw new DomainError("REMEDIATION_REQUIRED", "ACCOUNT_STEP_PENDING", "Please finish securing your account to continue.");
    }
    if (principal.role === "customer") {
      await denyCartAuthz(principal, "CUSTOMER_HIDDEN", { type: "cart_upsell_offer" });
      throw notFound("NOT_FOUND");
    }
    if (!roleHasCapability(principal.role, "carts.upsells.manage")) {
      await denyCartAuthz(principal, "CAPABILITY_NOT_GRANTED", { type: "cart_upsell_offer" });
      throw forbidden("CAPABILITY_NOT_GRANTED");
    }
  }

  async function assertAdminUpsellActorInTx(principal: SessionPrincipal, tx: Tx) {
    const liveActor = await actorCheck(principal, tx);
    if (liveActor.role === "customer") {
      throw notFound("NOT_FOUND");
    }
    if (!roleHasCapability(liveActor.role, "carts.upsells.manage")) {
      throw forbidden("CAPABILITY_NOT_GRANTED");
    }
    return liveActor;
  }

  function validateOfferAgainstCatalog(
    fields: {
      kind: "add_on" | "tier_upgrade";
      triggerMode: "any_cart" | "products";
      triggerProductPublicIds: string[];
      targetProductPublicId: string;
    },
    catalogGroups: readonly CatalogGroupView[],
    catalogMap: ReadonlyMap<string, IndexedCatalogEntry>,
  ): { normalizedTriggerIds: string[]; targetEntry: IndexedCatalogEntry } {
    const targetEntry = catalogMap.get(fields.targetProductPublicId);
    if (!targetEntry || !targetEntry.product.active) {
      throw validation("TARGET_PRODUCT_UNAVAILABLE", "Select an active target product from the catalogue.");
    }

    if (fields.kind === "tier_upgrade") {
      if (targetEntry.product.packetNumber === null || targetEntry.product.tier === null) {
        throw validation(
          "TIER_UPGRADE_REQUIRES_PACKET_TIER",
          "Tier upgrade suggestions must target a packet tier product.",
        );
      }
      // Target tier must be strictly higher-priced than at least one active sibling tier of the same packet.
      let hasCheaperSibling = false;
      for (const g of catalogGroups) {
        for (const p of g.products) {
          if (
            p.active &&
            p.packetNumber === targetEntry.product.packetNumber &&
            p.publicId !== targetEntry.product.publicId &&
            p.priceMinor < targetEntry.product.priceMinor
          ) {
            hasCheaperSibling = true;
            break;
          }
        }
      }
      if (!hasCheaperSibling) {
        throw validation(
          "TIER_UPGRADE_MUST_BE_HIGHER_TIER",
          "Tier upgrade suggestions must target a higher-priced tier than an existing lower tier.",
        );
      }
    }

    let normalizedTriggerIds: string[] = [];
    if (fields.triggerMode === "products") {
      const deduped = [...new Set(fields.triggerProductPublicIds)];
      if (deduped.length === 0) {
        throw validation("TRIGGER_PRODUCTS_REQUIRED", "Select at least one trigger product.");
      }
      for (const pid of deduped) {
        if (pid === fields.targetProductPublicId) {
          throw validation("TRIGGER_EQUALS_TARGET", "A suggestion cannot use its own target product as its only trigger.");
        }
        if (!catalogMap.has(pid)) {
          throw validation("TRIGGER_PRODUCT_NOT_FOUND", "One of the selected trigger products does not exist.");
        }
      }
      normalizedTriggerIds = deduped;
    }

    return { normalizedTriggerIds, targetEntry };
  }

  function toAdminOfferView(
    row: CartUpsellOfferRow,
    catalogMap: ReadonlyMap<string, IndexedCatalogEntry>,
    bundleRule?: BundleRule,
  ): AdminCartUpsellOfferView {
    const triggerIds = Array.isArray(row.triggerProductPublicIds) ? row.triggerProductPublicIds : [];
    const ruleType = normalizeRuleType(row.ruleType);
    const targetEntry = catalogMap.get(row.targetProductPublicId);
    const isBundleRuleRow = ruleType === "bundle_completion";
    const bundleActive = Boolean(bundleRule ? bundleRule.enabled && bundleRule.discountPercent > 0 : true);
    return {
      offerPublicId: row.publicId,
      version: row.version,
      seedKey: row.seedKey ?? null,
      ruleType,
      kind: row.kind,
      title: row.title,
      shortText: row.shortText,
      triggerMode: row.triggerMode,
      triggerProductPublicIds: triggerIds,
      triggerProductNames: triggerIds.map((pid) => catalogMap.get(pid)?.product.name ?? pid),
      targetProductPublicId: row.targetProductPublicId,
      targetProductName: isBundleRuleRow
        ? (bundleRule?.label ?? "Complete bundle")
        : (targetEntry?.product.name ?? "Inactive or removed item"),
      targetProductAvailable: isBundleRuleRow
        ? Boolean(bundleActive && catalogMap.size > 0)
        : Boolean(targetEntry?.product.active),
      targetProductPriceMinor: isBundleRuleRow ? null : (targetEntry?.product.priceMinor ?? null),
      targetProductCurrency: targetEntry?.product.currency ?? null,
      priority: row.priority,
      active: row.active,
      startsAt: row.startsAt ?? null,
      endsAt: row.endsAt ?? null,
      shownCount: row.shownCount,
      acceptedCount: row.acceptedCount,
      dismissedCount: row.dismissedCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async function writeFeatureFlagInTx(flag: string, enabled: boolean, tx: Tx): Promise<void> {
    await deps.settings.set(`feature.${flag}`, enabled, tx);
    const maybeMemoryFlags = (deps.settings as { flags?: unknown }).flags;
    if (maybeMemoryFlags instanceof Set) {
      if (enabled) maybeMemoryFlags.add(flag);
      else maybeMemoryFlags.delete(flag);
    }
  }

  async function seedStarterOffersInternal(opts: {
    mode: "startup" | "manual";
    principal?: SessionPrincipal;
  }): Promise<{ addedCount: number; skippedExistingCount: number }> {
    let ordersSvc: ReturnType<typeof cartOrdersPort>;
    try {
      ordersSvc = cartOrdersPort(deps.services);
    } catch {
      return { addedCount: 0, skippedExistingCount: 0 };
    }

    const [catalogGroups, bundleRule] = await Promise.all([
      ordersSvc.listActiveCatalog(),
      ordersSvc.getBundleRule(),
    ]);
    const candidates = buildCatalogStarterSuggestions(catalogGroups, bundleRule);
    if (candidates.length === 0) {
      return { addedCount: 0, skippedExistingCount: 0 };
    }

    return deps.db.transaction(async (tx) => {
      let liveRole: SessionPrincipal["role"] | "system" = "system";
      if (opts.principal) {
        const liveActor = await assertAdminUpsellActorInTx(opts.principal, tx);
        liveRole = liveActor.role;
      }

      const [existingRows, previouslySeededKeys] = await Promise.all([
        tx.select({ seedKey: cartUpsellOffers.seedKey }).from(cartUpsellOffers).for("update"),
        readSetting(deps.settings, CART_UPSELL_SEEDED_KEYS, tx),
      ]);

      const existingKeySet = new Set(
        existingRows.map((r) => r.seedKey).filter((k): k is string => typeof k === "string" && k.length > 0),
      );
      const historyKeySet = new Set(previouslySeededKeys);

      const now = deps.clock.now();
      let baseMs = now.getTime();
      let addedCount = 0;
      let skippedExistingCount = 0;

      for (const candidate of candidates) {
        // Never overwrite existing rows; on automatic startup also respect previously-seeded keys so admin deletions stay deleted.
        const alreadyPresent =
          existingKeySet.has(candidate.seedKey) ||
          (opts.mode === "startup" && historyKeySet.has(candidate.seedKey));
        if (alreadyPresent) {
          skippedExistingCount += 1;
          continue;
        }

        const publicId = ulid(baseMs++);
        await tx
          .insert(cartUpsellOffers)
          .ignore()
          .values({
            publicId,
            seedKey: candidate.seedKey,
            kind: candidate.kind,
            ruleType: candidate.ruleType,
            title: candidate.title,
            shortText: candidate.shortText,
            triggerMode: candidate.triggerMode,
            triggerProductPublicIds: candidate.triggerProductPublicIds,
            targetProductPublicId: candidate.targetProductPublicId,
            priority: candidate.priority,
            active: false, // D3: sets every seeded row disabled (`active = false`).
            startsAt: null,
            endsAt: null,
            createdByUserId: opts.principal?.userId ?? null,
            version: 1,
            createdAt: now,
            updatedAt: now,
          });

        const [verifyInserted] = await tx
          .select({ id: cartUpsellOffers.id })
          .from(cartUpsellOffers)
          .where(eq(cartUpsellOffers.publicId, publicId))
          .limit(1);
        if (verifyInserted) {
          addedCount += 1;
          existingKeySet.add(candidate.seedKey);
        } else {
          skippedExistingCount += 1;
        }
        historyKeySet.add(candidate.seedKey);
      }

      const mergedHistory = [...historyKeySet].sort();
      if (mergedHistory.length !== previouslySeededKeys.length || addedCount > 0) {
        await writeSetting(deps.settings, CART_UPSELL_SEEDED_KEYS, mergedHistory, tx);
      }

      if (addedCount > 0 || opts.mode === "manual") {
        await deps.audit.record(
          {
            category: opts.principal ? "admin" : "system",
            eventName: "cart.upsell_offers.seeded",
            action: "create",
            outcome: "completed",
            actor: opts.principal
              ? { userId: opts.principal.userId, role: liveRole }
              : { userId: null, role: "system" },
            resource: { type: "cart_upsell_offer" },
            attributes: {
              mode: opts.mode,
              added_count: addedCount,
              skipped_existing_count: skippedExistingCount,
              candidate_count: candidates.length,
            },
          },
          tx,
        );
      }

      return { addedCount, skippedExistingCount };
    });
  }

  return {
    async seedOnStartup(): Promise<{ addedCount: number; skippedExistingCount: number }> {
      return seedStarterOffersInternal({ mode: "startup" });
    },

    async computeForOpenCart(input: {
      openCart: CartRow | undefined;
      availableLines: readonly CartLineView[];
      catalogGroups: readonly CatalogGroupView[];
      catalogMap: ReadonlyMap<string, IndexedCatalogEntry>;
      bundleRule: BundleRule;
      dbOrTx: DbOrTx;
      recordImpressions: boolean;
    }): Promise<CartUpsellSuggestionView[]> {
      const { openCart, availableLines, catalogGroups, catalogMap, bundleRule, dbOrTx, recordImpressions } = input;
      if (!openCart || availableLines.length === 0) return [];

      const enabled = await isUpsellEnabled(dbOrTx);
      if (!enabled) return [];

      const [activeOffers, configuredBundleRows, stateRows] = await Promise.all([
        dbOrTx
          .select()
          .from(cartUpsellOffers)
          .where(eq(cartUpsellOffers.active, true))
          .orderBy(asc(cartUpsellOffers.priority), asc(cartUpsellOffers.id)),
        dbOrTx
          .select({ id: cartUpsellOffers.id })
          .from(cartUpsellOffers)
          .where(eq(cartUpsellOffers.ruleType, "bundle_completion"))
          .limit(1),
        dbOrTx
          .select()
          .from(cartUpsellCartStates)
          .where(eq(cartUpsellCartStates.cartId, openCart.id)),
      ]);

      const stateByKey = new Map(stateRows.map((s) => [s.offerKey, s]));
      const dismissedOfferKeys = new Set(
        stateRows.filter((s) => s.dismissedAt !== null).map((s) => s.offerKey),
      );

      const now = deps.clock.now();
      const suggestions = computeEligibleUpsells({
        availableLines,
        catalogGroups,
        catalogMap,
        bundleRule,
        activeOffers,
        dismissedOfferKeys,
        now,
        hasConfiguredBundleOffer: configuredBundleRows.length > 0,
      });

      if (recordImpressions && suggestions.length > 0) {
        const offerByPublicId = new Map(activeOffers.map((o) => [o.publicId, o]));
        const newlyShown = suggestions.filter((s) => !stateByKey.get(s.offerPublicId)?.firstShownAt);

        if (newlyShown.length > 0) {
          await deps.db.transaction(async (tx) => {
            // Canonical lock order across `computeForOpenCart`, `acceptUpsell`, and `dismissUpsell`:
            //   1. `carts` -> 2. (`cart_items`) -> 3. `cart_upsell_offers` (id ASC) -> 4. `cart_upsell_cart_states` (offer_key ASC).
            const [lockedCart] = await tx
              .select({ id: carts.id })
              .from(carts)
              .where(and(eq(carts.id, openCart.id), eq(carts.status, "open")))
              .for("update")
              .limit(1);
            if (!lockedCart) return;

            const offerIdsToLock = [
              ...new Set(
                newlyShown
                  .map((s) => offerByPublicId.get(s.offerPublicId)?.id)
                  .filter((id): id is number => id !== undefined),
              ),
            ].sort((a, b) => a - b);

            const lockedOffers =
              offerIdsToLock.length > 0
                ? await tx
                    .select()
                    .from(cartUpsellOffers)
                    .where(inArray(cartUpsellOffers.id, offerIdsToLock))
                    .orderBy(asc(cartUpsellOffers.id))
                    .for("update")
                : [];
            const lockedOfferByPublicId = new Map(lockedOffers.map((o) => [o.publicId, o]));

            const offerKeysToLock = [...new Set(newlyShown.map((s) => s.offerPublicId))].sort();
            const lockedStates = await tx
              .select()
              .from(cartUpsellCartStates)
              .where(
                and(
                  eq(cartUpsellCartStates.cartId, openCart.id),
                  inArray(cartUpsellCartStates.offerKey, offerKeysToLock),
                ),
              )
              .orderBy(asc(cartUpsellCartStates.offerKey))
              .for("update");
            const lockedStateByKey = new Map(lockedStates.map((s) => [s.offerKey, s]));

            for (const s of newlyShown) {
              const offerRow = lockedOfferByPublicId.get(s.offerPublicId);
              if (s.offerPublicId !== BUNDLE_COMPLETION_OFFER_KEY && !offerRow) continue;

              const existingState = lockedStateByKey.get(s.offerPublicId);
              if (existingState?.firstShownAt) continue;

              if (existingState) {
                await tx
                  .update(cartUpsellCartStates)
                  .set({ firstShownAt: now, updatedAt: now })
                  .where(eq(cartUpsellCartStates.id, existingState.id));
              } else {
                await tx.insert(cartUpsellCartStates).values({
                  cartId: openCart.id,
                  offerId: offerRow?.id ?? null,
                  offerKey: s.offerPublicId,
                  firstShownAt: now,
                  createdAt: now,
                  updatedAt: now,
                });
              }

              if (offerRow) {
                await tx
                  .update(cartUpsellOffers)
                  .set({
                    shownCount: sql`${cartUpsellOffers.shownCount} + 1`,
                    updatedAt: now,
                  })
                  .where(eq(cartUpsellOffers.id, offerRow.id));
              }
            }
          });
        }
      }

      return suggestions;
    },

    async acceptUpsell(
      principal: SessionPrincipal,
      input: z.infer<typeof acceptUpsellInputSchema>,
    ): Promise<CartView> {
      await assertCustomerPrecheck(principal);
      await assertUpsellEnabled();

      const ordersSvc = cartOrdersPort(deps.services);

      await deps.db.transaction(async (tx) => {
        const liveActor = await actorCheck(principal, tx, "orders.create");
        if (liveActor.role !== "customer") throw forbidden("CUSTOMER_ROLE_REQUIRED");
        await assertUpsellEnabled(tx);

        // 1. Lock cart row first.
        const [cart] = await tx
          .select()
          .from(carts)
          .where(and(eq(carts.ownerUserId, principal.userId), eq(carts.status, "open")))
          .for("update")
          .limit(1);
        if (!cart) throw notFound("CART_NOT_FOUND");

        // Idempotent replay check: exact `(cart_id, idempotency_key, offer_key)` is a no-op;
        // reusing the same idempotency_key for a different offer is rejected (`CONFLICT`).
        const [existingAccept] = await tx
          .select()
          .from(cartUpsellAcceptances)
          .where(
            and(
              eq(cartUpsellAcceptances.cartId, cart.id),
              eq(cartUpsellAcceptances.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1);
        if (existingAccept) {
          if (existingAccept.offerKey !== input.offerPublicId) {
            throw conflict("IDEMPOTENCY_KEY_REUSED", "Idempotency key was already used for a different suggestion.");
          }
          return;
        }

        // 2. Lock cart lines.
        const existingItems = await tx
          .select()
          .from(cartItems)
          .where(eq(cartItems.cartId, cart.id))
          .orderBy(asc(cartItems.position), asc(cartItems.id))
          .for("update");

        // 3. Lock active upsell offers in canonical `id ASC` order.
        const [lockedActiveOffers, configuredBundleRows] = await Promise.all([
          tx
            .select()
            .from(cartUpsellOffers)
            .where(eq(cartUpsellOffers.active, true))
            .orderBy(asc(cartUpsellOffers.id))
            .for("update"),
          tx
            .select({ id: cartUpsellOffers.id })
            .from(cartUpsellOffers)
            .where(eq(cartUpsellOffers.ruleType, "bundle_completion"))
            .limit(1),
        ]);
        const activeOffers = [...lockedActiveOffers].sort(
          (a, b) => a.priority - b.priority || a.id - b.id,
        );
        const offerRow = activeOffers.find((o) => o.publicId === input.offerPublicId);
        if (input.offerPublicId !== BUNDLE_COMPLETION_OFFER_KEY && !offerRow) {
          throw validation("UPSELL_NOT_AVAILABLE", "This suggestion is no longer available for your cart.");
        }

        // 4. Lock per-cart upsell states in canonical `offer_key ASC` order.
        const stateRows = await tx
          .select()
          .from(cartUpsellCartStates)
          .where(eq(cartUpsellCartStates.cartId, cart.id))
          .orderBy(asc(cartUpsellCartStates.offerKey))
          .for("update");
        const dismissedOfferKeys = new Set(
          stateRows.filter((s) => s.dismissedAt !== null).map((s) => s.offerKey),
        );

        // 5. Read live catalog + bundle rule INSIDE the transaction under `tx` (`forShare: true`) so deactivated
        //    or repriced products and updated bundle rules are evaluated atomically without taking a 2nd pool connection.
        const catalogGroups = await ordersSvc.listActiveCatalog(tx, { forShare: true });
        const bundleRule = await ordersSvc.getBundleRule(tx);
        const catalogMap = indexCatalog(catalogGroups);
        const liveLines = await computeLiveLines(cart.id, catalogMap, tx);
        const availableLines = liveLines.filter((l) => l.available);

        const now = deps.clock.now();
        // Evaluate the exact same full eligibility, conflict-suppression, and top-3 display set as `cart.get`.
        const eligibleSuggestions = computeEligibleUpsells({
          availableLines,
          catalogGroups,
          catalogMap,
          bundleRule,
          activeOffers,
          dismissedOfferKeys,
          now,
          hasConfiguredBundleOffer: configuredBundleRows.length > 0,
        });

        const matched = eligibleSuggestions.find((s) => s.offerPublicId === input.offerPublicId);
        if (!matched) {
          throw validation("UPSELL_NOT_AVAILABLE", "This suggestion is no longer available for your cart.");
        }

        let nextPosition = existingItems.reduce((maxPos, r) => Math.max(maxPos, r.position + 1), 0);
        let projectedCount = existingItems.length;
        const addedProductIds: string[] = [];

        if (matched.kind === "tier_upgrade") {
          const target = matched.targetProducts[0]!;
          const targetEntry = catalogMap.get(target.productPublicId);
          if (!targetEntry || !targetEntry.product.active || target.packetNumber === null) {
            throw validation("UPSELL_NOT_AVAILABLE", "This suggestion is no longer available for your cart.");
          }
          const currentPacketRow = existingItems.find((r) => r.packetNumber === target.packetNumber);
          if (!currentPacketRow) {
            throw validation("UPSELL_NOT_AVAILABLE", "This suggestion is no longer available for your cart.");
          }
          await tx
            .update(cartItems)
            .set({
              productPublicId: targetEntry.product.publicId,
              packetNumber: targetEntry.product.packetNumber,
              quantity: 1,
              snapshotName: targetEntry.product.name,
              snapshotTier: targetEntry.product.tier,
              snapshotUnitPriceMinor: targetEntry.product.priceMinor,
              snapshotCurrency: targetEntry.product.currency,
              updatedAt: now,
            })
            .where(eq(cartItems.id, currentPacketRow.id));
          addedProductIds.push(targetEntry.product.publicId);
        } else {
          for (const target of matched.targetProducts) {
            const targetEntry = catalogMap.get(target.productPublicId);
            if (!targetEntry || !targetEntry.product.active) {
              throw validation("UPSELL_NOT_AVAILABLE", "This suggestion is no longer available for your cart.");
            }
            projectedCount += 1;
            if (projectedCount > MAX_CART_LINES) {
              throw validation("CART_LIMIT_REACHED", `A cart can hold at most ${MAX_CART_LINES} line items.`);
            }
            await tx.insert(cartItems).values({
              publicId: ulid(now.getTime()),
              cartId: cart.id,
              productPublicId: targetEntry.product.publicId,
              packetNumber: targetEntry.product.packetNumber,
              quantity: 1,
              position: nextPosition++,
              snapshotName: targetEntry.product.name,
              snapshotTier: targetEntry.product.tier,
              snapshotUnitPriceMinor: targetEntry.product.priceMinor,
              snapshotCurrency: targetEntry.product.currency,
              createdAt: now,
              updatedAt: now,
            });
            addedProductIds.push(targetEntry.product.publicId);
          }
        }

        await tx.insert(cartUpsellAcceptances).values({
          cartId: cart.id,
          offerId: offerRow?.id ?? null,
          offerKey: matched.offerPublicId,
          idempotencyKey: input.idempotencyKey,
          addedProductPublicIds: addedProductIds,
          createdAt: now,
        });

        const existingState = stateRows.find((s) => s.offerKey === matched.offerPublicId);
        const wasAlreadyShown = Boolean(existingState?.firstShownAt);
        if (existingState) {
          await tx
            .update(cartUpsellCartStates)
            .set({
              firstShownAt: existingState.firstShownAt ?? now,
              acceptedAt: now,
              updatedAt: now,
            })
            .where(eq(cartUpsellCartStates.id, existingState.id));
        } else {
          await tx.insert(cartUpsellCartStates).values({
            cartId: cart.id,
            offerId: offerRow?.id ?? null,
            offerKey: matched.offerPublicId,
            firstShownAt: now,
            acceptedAt: now,
            createdAt: now,
            updatedAt: now,
          });
        }

        if (offerRow) {
          await tx
            .update(cartUpsellOffers)
            .set({
              shownCount: wasAlreadyShown ? offerRow.shownCount : sql`${cartUpsellOffers.shownCount} + 1`,
              acceptedCount: sql`${cartUpsellOffers.acceptedCount} + 1`,
              updatedAt: now,
            })
            .where(eq(cartUpsellOffers.id, offerRow.id));
        }

        await bumpCartVersionInTx(tx, cart, now);

        await deps.audit.record(
          {
            category: "business",
            eventName: "cart.upsell.accepted",
            action: "update",
            outcome: "completed",
            actor: { userId: principal.userId, role: liveActor.role },
            resource: { type: "cart", publicId: cart.publicId },
            attributes: {
              offer_key: matched.offerPublicId,
              offer_public_id: offerRow?.publicId ?? null,
              kind: matched.kind,
              target_product_count: addedProductIds.length,
              primary_target_product_public_id: addedProductIds[0] ?? null,
            },
          },
          tx,
        );
      });

      return hydrateOpenCartForUser(principal, undefined, { recordImpressions: true });
    },

    async dismissUpsell(
      principal: SessionPrincipal,
      input: z.infer<typeof dismissUpsellInputSchema>,
    ): Promise<CartView> {
      await assertCustomerPrecheck(principal);
      await assertUpsellEnabled();

      await deps.db.transaction(async (tx) => {
        const liveActor = await actorCheck(principal, tx, "orders.create");
        if (liveActor.role !== "customer") throw forbidden("CUSTOMER_ROLE_REQUIRED");
        await assertUpsellEnabled(tx);

        const [cart] = await tx
          .select()
          .from(carts)
          .where(and(eq(carts.ownerUserId, principal.userId), eq(carts.status, "open")))
          .for("update")
          .limit(1);
        if (!cart) throw notFound("CART_NOT_FOUND");

        let offerRow: CartUpsellOfferRow | undefined;
        if (input.offerPublicId !== BUNDLE_COMPLETION_OFFER_KEY) {
          const [foundOffer] = await tx
            .select()
            .from(cartUpsellOffers)
            .where(eq(cartUpsellOffers.publicId, input.offerPublicId))
            .for("update")
            .limit(1);
          if (!foundOffer) throw offerNotFound();
          offerRow = foundOffer;
        }

        const [existingState] = await tx
          .select()
          .from(cartUpsellCartStates)
          .where(
            and(
              eq(cartUpsellCartStates.cartId, cart.id),
              eq(cartUpsellCartStates.offerKey, input.offerPublicId),
            ),
          )
          .for("update")
          .limit(1);

        if (existingState?.dismissedAt) {
          return;
        }

        const now = deps.clock.now();
        const wasAlreadyShown = Boolean(existingState?.firstShownAt);

        if (existingState) {
          await tx
            .update(cartUpsellCartStates)
            .set({
              firstShownAt: existingState.firstShownAt ?? now,
              dismissedAt: now,
              updatedAt: now,
            })
            .where(eq(cartUpsellCartStates.id, existingState.id));
        } else {
          await tx.insert(cartUpsellCartStates).values({
            cartId: cart.id,
            offerId: offerRow?.id ?? null,
            offerKey: input.offerPublicId,
            firstShownAt: now,
            dismissedAt: now,
            createdAt: now,
            updatedAt: now,
          });
        }

        if (offerRow) {
          await tx
            .update(cartUpsellOffers)
            .set({
              shownCount: wasAlreadyShown ? offerRow.shownCount : sql`${cartUpsellOffers.shownCount} + 1`,
              dismissedCount: sql`${cartUpsellOffers.dismissedCount} + 1`,
              updatedAt: now,
            })
            .where(eq(cartUpsellOffers.id, offerRow.id));
        }

        await deps.audit.record(
          {
            category: "business",
            eventName: "cart.upsell.dismissed",
            action: "update",
            outcome: "completed",
            actor: { userId: principal.userId, role: liveActor.role },
            resource: { type: "cart", publicId: cart.publicId },
            attributes: {
              offer_key: input.offerPublicId,
              offer_public_id: offerRow?.publicId ?? null,
            },
          },
          tx,
        );
      });

      return hydrateOpenCartForUser(principal, undefined, { recordImpressions: true });
    },

    async adminListUpsellOffers(principal: SessionPrincipal): Promise<AdminCartUpsellsListResult> {
      await assertAdminUpsellManagePrecheck(principal);

      const ordersSvc = cartOrdersPort(deps.services);
      const [featureCartEnabled, featureUpsellEnabled, catalogGroups, bundleRule, rows] = await Promise.all([
        deps.settings.isFeatureEnabled(CART_FEATURE_FLAG.flag),
        deps.settings.isFeatureEnabled(CART_UPSELL_FEATURE_FLAG.flag),
        ordersSvc.listActiveCatalog(),
        ordersSvc.getBundleRule(),
        deps.db
          .select()
          .from(cartUpsellOffers)
          .orderBy(asc(cartUpsellOffers.priority), asc(cartUpsellOffers.id)),
      ]);

      const catalogMap = indexCatalog(catalogGroups);
      const minPacketPrice = new Map<number, number>();
      for (const group of catalogGroups) {
        for (const p of group.products) {
          if (p.active && p.packetNumber !== null) {
            const cur = minPacketPrice.get(p.packetNumber);
            if (cur === undefined || p.priceMinor < cur) {
              minPacketPrice.set(p.packetNumber, p.priceMinor);
            }
          }
        }
      }

      const catalogProducts: AdminCartUpsellCatalogProductView[] = [];
      for (const group of catalogGroups) {
        for (const p of group.products) {
          const minPrice = p.packetNumber !== null ? minPacketPrice.get(p.packetNumber) : undefined;
          catalogProducts.push({
            productPublicId: p.publicId,
            name: p.name,
            groupName: group.name,
            packetNumber: p.packetNumber,
            tier: p.tier as PacketTierName | null,
            priceMinor: p.priceMinor,
            currency: p.currency,
            active: p.active,
            canBeTierUpgradeTarget:
              p.active &&
              p.packetNumber !== null &&
              p.tier !== null &&
              minPrice !== undefined &&
              p.priceMinor > minPrice,
          });
        }
      }

      return {
        featureCartEnabled,
        featureUpsellEnabled,
        bundleRuleEnabled: bundleRule.enabled && bundleRule.discountPercent > 0,
        bundleRuleLabel: bundleRule.enabled ? bundleRule.label : null,
        offers: rows.map((row) => toAdminOfferView(row, catalogMap, bundleRule)),
        catalogProducts,
      };
    },

    async adminCreateUpsellOffer(
      principal: SessionPrincipal,
      input: z.infer<typeof adminUpsellCreateInputSchema>,
    ): Promise<AdminCartUpsellOfferView> {
      await assertAdminUpsellManagePrecheck(principal);

      const ordersSvc = cartOrdersPort(deps.services);
      const [catalogGroups, bundleRule] = await Promise.all([
        ordersSvc.listActiveCatalog(),
        ordersSvc.getBundleRule(),
      ]);
      const catalogMap = indexCatalog(catalogGroups);
      const { normalizedTriggerIds } = validateOfferAgainstCatalog(input, catalogGroups, catalogMap);

      const createdRow = await deps.db.transaction(async (tx) => {
        const liveActor = await assertAdminUpsellActorInTx(principal, tx);
        const now = deps.clock.now();
        const publicId = ulid(now.getTime());

        await tx.insert(cartUpsellOffers).values({
          publicId,
          seedKey: null,
          kind: input.kind,
          ruleType: "standard",
          title: input.title,
          shortText: input.shortText,
          triggerMode: input.triggerMode,
          triggerProductPublicIds: normalizedTriggerIds,
          targetProductPublicId: input.targetProductPublicId,
          priority: input.priority ?? 100,
          active: input.active ?? true,
          startsAt: input.startsAt ?? null,
          endsAt: input.endsAt ?? null,
          createdByUserId: principal.userId,
          version: 1,
          createdAt: now,
          updatedAt: now,
        });

        const [inserted] = await tx
          .select()
          .from(cartUpsellOffers)
          .where(eq(cartUpsellOffers.publicId, publicId))
          .limit(1);

        await deps.audit.record(
          {
            category: "admin",
            eventName: "cart.upsell_offer.created",
            action: "create",
            outcome: "completed",
            actor: { userId: principal.userId, role: liveActor.role },
            resource: { type: "cart_upsell_offer", publicId },
            attributes: {
              kind: input.kind,
              trigger_mode: input.triggerMode,
              target_product_public_id: input.targetProductPublicId,
              priority: input.priority ?? 100,
              active: input.active ?? true,
            },
          },
          tx,
        );

        return inserted!;
      });

      return toAdminOfferView(createdRow, catalogMap, bundleRule);
    },

    async adminUpdateUpsellOffer(
      principal: SessionPrincipal,
      input: z.infer<typeof adminUpsellUpdateInputSchema>,
    ): Promise<AdminCartUpsellOfferView> {
      await assertAdminUpsellManagePrecheck(principal);

      const ordersSvc = cartOrdersPort(deps.services);
      const [catalogGroups, bundleRule] = await Promise.all([
        ordersSvc.listActiveCatalog(),
        ordersSvc.getBundleRule(),
      ]);
      const catalogMap = indexCatalog(catalogGroups);

      const updatedRow = await deps.db.transaction(async (tx) => {
        const liveActor = await assertAdminUpsellActorInTx(principal, tx);
        const [existing] = await tx
          .select()
          .from(cartUpsellOffers)
          .where(eq(cartUpsellOffers.publicId, input.offerPublicId))
          .for("update")
          .limit(1);

        if (!existing) throw offerNotFound();
        if (existing.version !== input.expectedVersion) throw staleOfferVersion();

        const isBundleRuleRow = normalizeRuleType(existing.ruleType) === "bundle_completion";
        let normalizedTriggerIds: string[] = [];
        if (isBundleRuleRow) {
          if (input.triggerMode === "products") {
            const deduped = [...new Set(input.triggerProductPublicIds)];
            if (deduped.length === 0) {
              throw validation("TRIGGER_PRODUCTS_REQUIRED", "Select at least one trigger product.");
            }
            for (const pid of deduped) {
              if (!catalogMap.has(pid)) {
                throw validation("TRIGGER_PRODUCT_NOT_FOUND", "One of the selected trigger products does not exist.");
              }
            }
            normalizedTriggerIds = deduped;
          }
        } else {
          normalizedTriggerIds = validateOfferAgainstCatalog(input, catalogGroups, catalogMap).normalizedTriggerIds;
        }

        const now = deps.clock.now();
        const nextVersion = existing.version + 1;
        const [cas] = await tx
          .update(cartUpsellOffers)
          .set({
            kind: isBundleRuleRow ? "add_on" : input.kind,
            title: input.title,
            shortText: input.shortText,
            triggerMode: input.triggerMode,
            triggerProductPublicIds: normalizedTriggerIds,
            targetProductPublicId: isBundleRuleRow ? existing.targetProductPublicId : input.targetProductPublicId,
            priority: input.priority,
            active: input.active,
            startsAt: input.startsAt ?? null,
            endsAt: input.endsAt ?? null,
            version: nextVersion,
            updatedAt: now,
          })
          .where(and(eq(cartUpsellOffers.id, existing.id), eq(cartUpsellOffers.version, existing.version)));
        if (cas.affectedRows !== 1) throw staleOfferVersion();

        const [reloaded] = await tx
          .select()
          .from(cartUpsellOffers)
          .where(eq(cartUpsellOffers.id, existing.id))
          .limit(1);

        await deps.audit.record(
          {
            category: "admin",
            eventName: "cart.upsell_offer.updated",
            action: "update",
            outcome: "completed",
            actor: { userId: principal.userId, role: liveActor.role },
            resource: { type: "cart_upsell_offer", publicId: existing.publicId },
            attributes: {
              kind: isBundleRuleRow ? "add_on" : input.kind,
              rule_type: normalizeRuleType(existing.ruleType),
              trigger_mode: input.triggerMode,
              target_product_public_id: isBundleRuleRow ? existing.targetProductPublicId : input.targetProductPublicId,
              priority: input.priority,
              active: input.active,
            },
          },
          tx,
        );

        return reloaded!;
      });

      return toAdminOfferView(updatedRow, catalogMap, bundleRule);
    },

    async adminSetUpsellOfferActive(
      principal: SessionPrincipal,
      input: z.infer<typeof adminUpsellSetActiveInputSchema>,
    ): Promise<AdminCartUpsellOfferView> {
      await assertAdminUpsellManagePrecheck(principal);

      const ordersSvc = cartOrdersPort(deps.services);
      const [catalogGroups, bundleRule] = await Promise.all([
        ordersSvc.listActiveCatalog(),
        ordersSvc.getBundleRule(),
      ]);
      const catalogMap = indexCatalog(catalogGroups);

      const updatedRow = await deps.db.transaction(async (tx) => {
        const liveActor = await assertAdminUpsellActorInTx(principal, tx);
        const [existing] = await tx
          .select()
          .from(cartUpsellOffers)
          .where(eq(cartUpsellOffers.publicId, input.offerPublicId))
          .for("update")
          .limit(1);

        if (!existing) throw offerNotFound();
        if (existing.version !== input.expectedVersion) throw staleOfferVersion();

        if (input.active && normalizeRuleType(existing.ruleType) !== "bundle_completion") {
          const targetEntry = catalogMap.get(existing.targetProductPublicId);
          if (!targetEntry || !targetEntry.product.active) {
            throw validation(
              "TARGET_PRODUCT_UNAVAILABLE",
              "This suggestion targets a retired catalogue item. Choose an active target product before enabling it.",
            );
          }
        }

        const now = deps.clock.now();
        const [cas] = await tx
          .update(cartUpsellOffers)
          .set({
            active: input.active,
            version: existing.version + 1,
            updatedAt: now,
          })
          .where(and(eq(cartUpsellOffers.id, existing.id), eq(cartUpsellOffers.version, existing.version)));
        if (cas.affectedRows !== 1) throw staleOfferVersion();

        const [reloaded] = await tx
          .select()
          .from(cartUpsellOffers)
          .where(eq(cartUpsellOffers.id, existing.id))
          .limit(1);

        await deps.audit.record(
          {
            category: "admin",
            eventName: input.active ? "cart.upsell_offer.activated" : "cart.upsell_offer.deactivated",
            action: "update",
            outcome: "completed",
            actor: { userId: principal.userId, role: liveActor.role },
            resource: { type: "cart_upsell_offer", publicId: existing.publicId },
            attributes: { active: input.active },
          },
          tx,
        );

        return reloaded!;
      });

      return toAdminOfferView(updatedRow, catalogMap, bundleRule);
    },

    async adminSetUpsellFeature(
      principal: SessionPrincipal,
      input: z.infer<typeof adminUpsellSetFeatureInputSchema>,
    ): Promise<{ featureCartEnabled: boolean; featureUpsellEnabled: boolean }> {
      await assertAdminUpsellManagePrecheck(principal);

      return deps.db.transaction(async (tx) => {
        const liveActor = await assertAdminUpsellActorInTx(principal, tx);
        await writeFeatureFlagInTx(CART_UPSELL_FEATURE_FLAG.flag, input.enabled, tx);
        if (input.enabled && input.alsoEnableCart) {
          await writeFeatureFlagInTx(CART_FEATURE_FLAG.flag, true, tx);
        }

        const [featureCartEnabled, featureUpsellEnabled] = await Promise.all([
          deps.settings.isFeatureEnabled(CART_FEATURE_FLAG.flag, tx),
          deps.settings.isFeatureEnabled(CART_UPSELL_FEATURE_FLAG.flag, tx),
        ]);

        await deps.audit.record(
          {
            category: "admin",
            eventName: "cart.upsell_feature.toggled",
            action: "update",
            outcome: "completed",
            actor: { userId: principal.userId, role: liveActor.role },
            resource: { type: "platform_setting", publicId: "feature.cart.upsell" },
            attributes: {
              feature_cart_upsell: featureUpsellEnabled,
              feature_cart: featureCartEnabled,
              also_enable_cart: Boolean(input.alsoEnableCart),
            },
          },
          tx,
        );

        return { featureCartEnabled, featureUpsellEnabled };
      });
    },

    async adminSetAllUpsellOffersActive(
      principal: SessionPrincipal,
      input: z.infer<typeof adminUpsellSetAllActiveInputSchema>,
    ): Promise<{ active: boolean; updatedCount: number; skippedUnavailableCount: number }> {
      await assertAdminUpsellManagePrecheck(principal);

      const ordersSvc = cartOrdersPort(deps.services);
      const [catalogGroups, bundleRule] = await Promise.all([
        ordersSvc.listActiveCatalog(),
        ordersSvc.getBundleRule(),
      ]);
      const catalogMap = indexCatalog(catalogGroups);
      const bundleActive = bundleRule.enabled && bundleRule.discountPercent > 0 && catalogMap.size > 0;

      return deps.db.transaction(async (tx) => {
        const liveActor = await assertAdminUpsellActorInTx(principal, tx);
        const rows = await tx
          .select()
          .from(cartUpsellOffers)
          .orderBy(asc(cartUpsellOffers.id))
          .for("update");

        const now = deps.clock.now();
        let updatedCount = 0;
        let skippedUnavailableCount = 0;

        for (const row of rows) {
          if (row.active === input.active) continue;
          if (input.active) {
            const isBundleRuleRow = normalizeRuleType(row.ruleType) === "bundle_completion";
            const targetAvailable = isBundleRuleRow
              ? bundleActive
              : Boolean(catalogMap.get(row.targetProductPublicId)?.product.active);
            if (!targetAvailable) {
              skippedUnavailableCount += 1;
              continue;
            }
          }

          await tx
            .update(cartUpsellOffers)
            .set({
              active: input.active,
              version: row.version + 1,
              updatedAt: now,
            })
            .where(eq(cartUpsellOffers.id, row.id));
          updatedCount += 1;
        }

        await deps.audit.record(
          {
            category: "admin",
            eventName: input.active ? "cart.upsell_offers.enabled_all" : "cart.upsell_offers.disabled_all",
            action: "update",
            outcome: "completed",
            actor: { userId: principal.userId, role: liveActor.role },
            resource: { type: "cart_upsell_offer" },
            attributes: {
              active: input.active,
              updated_count: updatedCount,
              skipped_unavailable_count: skippedUnavailableCount,
            },
          },
          tx,
        );

        return { active: input.active, updatedCount, skippedUnavailableCount };
      });
    },

    async adminSeedSuggestedUpsellOffers(
      principal: SessionPrincipal,
    ): Promise<{ addedCount: number; skippedExistingCount: number }> {
      await assertAdminUpsellManagePrecheck(principal);
      return seedStarterOffersInternal({ mode: "manual", principal });
    },

    async adminDuplicateUpsellOffer(
      principal: SessionPrincipal,
      input: z.infer<typeof adminUpsellDuplicateInputSchema>,
    ): Promise<AdminCartUpsellOfferView> {
      await assertAdminUpsellManagePrecheck(principal);

      const ordersSvc = cartOrdersPort(deps.services);
      const [catalogGroups, bundleRule] = await Promise.all([
        ordersSvc.listActiveCatalog(),
        ordersSvc.getBundleRule(),
      ]);
      const catalogMap = indexCatalog(catalogGroups);

      const createdRow = await deps.db.transaction(async (tx) => {
        const liveActor = await assertAdminUpsellActorInTx(principal, tx);
        const [existing] = await tx
          .select()
          .from(cartUpsellOffers)
          .where(eq(cartUpsellOffers.publicId, input.offerPublicId))
          .limit(1);
        if (!existing) throw offerNotFound();

        const now = deps.clock.now();
        const publicId = ulid(now.getTime());
        const copySuffix = " (Copy)";
        const copyTitle =
          existing.title.length + copySuffix.length <= 120
            ? `${existing.title}${copySuffix}`
            : `${existing.title.slice(0, 120 - copySuffix.length).trimEnd()}${copySuffix}`;

        await tx.insert(cartUpsellOffers).values({
          publicId,
          seedKey: null,
          kind: existing.kind,
          ruleType: normalizeRuleType(existing.ruleType),
          title: copyTitle,
          shortText: existing.shortText,
          triggerMode: existing.triggerMode,
          triggerProductPublicIds: Array.isArray(existing.triggerProductPublicIds)
            ? existing.triggerProductPublicIds
            : [],
          targetProductPublicId: existing.targetProductPublicId,
          priority: existing.priority,
          active: false,
          startsAt: existing.startsAt ?? null,
          endsAt: existing.endsAt ?? null,
          createdByUserId: principal.userId,
          version: 1,
          createdAt: now,
          updatedAt: now,
        });

        const [inserted] = await tx
          .select()
          .from(cartUpsellOffers)
          .where(eq(cartUpsellOffers.publicId, publicId))
          .limit(1);

        await deps.audit.record(
          {
            category: "admin",
            eventName: "cart.upsell_offer.duplicated",
            action: "create",
            outcome: "completed",
            actor: { userId: principal.userId, role: liveActor.role },
            resource: { type: "cart_upsell_offer", publicId },
            attributes: {
              source_offer_public_id: existing.publicId,
              kind: existing.kind,
              rule_type: normalizeRuleType(existing.ruleType),
              active: false,
            },
          },
          tx,
        );

        return inserted!;
      });

      return toAdminOfferView(createdRow, catalogMap, bundleRule);
    },

    async adminDeleteUpsellOffer(
      principal: SessionPrincipal,
      input: z.infer<typeof adminUpsellDeleteInputSchema>,
    ): Promise<{ deleted: true; offerPublicId: string }> {
      await assertAdminUpsellManagePrecheck(principal);

      await deps.db.transaction(async (tx) => {
        const liveActor = await assertAdminUpsellActorInTx(principal, tx);
        const [existing] = await tx
          .select()
          .from(cartUpsellOffers)
          .where(eq(cartUpsellOffers.publicId, input.offerPublicId))
          .for("update")
          .limit(1);

        if (!existing) throw offerNotFound();

        await tx.delete(cartUpsellOffers).where(eq(cartUpsellOffers.id, existing.id));

        await deps.audit.record(
          {
            category: "admin",
            eventName: "cart.upsell_offer.deleted",
            action: "delete",
            outcome: "completed",
            actor: { userId: principal.userId, role: liveActor.role },
            resource: { type: "cart_upsell_offer", publicId: existing.publicId },
            attributes: {
              kind: existing.kind,
              target_product_public_id: existing.targetProductPublicId,
            },
          },
          tx,
        );
      });

      return { deleted: true, offerPublicId: input.offerPublicId };
    },
  };
}
