/**
 * Catalogue-driven starter upsell suggestion generator (Increment 06, Package D, Decision D3).
 * Owner: recovery_ops_engineer.
 *
 * Builds deterministic, idempotent starter offers from the live active catalogue and bundle rule
 * (grounded in `docs/source-specs/increment-02/PRODUCT_MATRIX_v3.0.md` and `readypackets-offerings-v3.0.json`):
 *  (a) Tier upgrades (`Basic -> Standard` and `Standard -> Premium`, plus `Basic -> Premium` when Standard is absent)
 *  (b) Complete-the-bundle (`ruleType: "bundle_completion"`) when several packets are in the cart
 *  (c) Natural next packet (`Packet N -> Packet N+1`, `ruleType: "next_packet"`)
 *  (d) Add-on style suggestions (standalone non-packet catalogue items + complementary matrix pairings)
 *
 * Every seeded row ships disabled (`active: false`) and carries a stable `seedKey` so re-seeding
 * never overwrites an existing or administrator-edited offer.
 */
import type { CatalogGroupView, CatalogProductView } from "../orders/catalog.js";
import type { BundleRule } from "../orders/settings.js";
import type { CartUpsellOfferKind, CartUpsellRuleType, CartUpsellTriggerMode } from "./schema.js";

export interface StarterUpsellCandidate {
  seedKey: string;
  kind: CartUpsellOfferKind;
  ruleType: CartUpsellRuleType;
  title: string;
  shortText: string;
  triggerMode: CartUpsellTriggerMode;
  triggerProductPublicIds: string[];
  targetProductPublicId: string;
  priority: number;
  active: false;
}

interface PacketTierCopy {
  basicToStandardTitle: string;
  basicToStandardReason: string;
  standardToPremiumTitle: string;
  standardToPremiumReason: string;
}

const MATRIX_TIER_UPGRADE_COPY: Readonly<Record<number, PacketTierCopy>> = {
  1: {
    basicToStandardTitle: "Step up Idea & IP Protection to Standard",
    basicToStandardReason:
      "Adds the 8-14 page inventor packet, complex system figures, teaching-away positioning, and a light prior-art scan.",
    standardToPremiumTitle: "Upgrade Idea & IP Protection to Premium",
    standardToPremiumReason:
      "Adds the 15+ page attorney-ready dossier, preliminary freedom-to-operate analysis, claim-theme map, and two revision rounds.",
  },
  2: {
    basicToStandardTitle: "Step up Business Foundation to Standard",
    basicToStandardReason:
      "Expands your 30-day launch map with unit economics, competitive positioning, and a 90-day execution roadmap.",
    standardToPremiumTitle: "Upgrade Business Foundation to Premium",
    standardToPremiumReason:
      "Adds multi-stream revenue modeling, risk mitigation playbooks, and executive operating architecture.",
  },
  3: {
    basicToStandardTitle: "Step up Business Plans to Standard",
    basicToStandardReason:
      "Adds multi-year financial projections, market sizing, and a structured partner- and lender-ready narrative.",
    standardToPremiumTitle: "Upgrade Business Plans to Premium",
    standardToPremiumReason:
      "Delivers an institutional-grade business plan with scenario modeling and diligence-ready financial schedules.",
  },
  4: {
    basicToStandardTitle: "Step up Operating Design to Standard",
    basicToStandardReason:
      "Adds cross-functional SOP workflows, role accountability matrices, and vendor selection criteria.",
    standardToPremiumTitle: "Upgrade Operating Design to Premium",
    standardToPremiumReason:
      "Delivers end-to-end operating manuals, KPI governance scorecards, and scale-readiness playbooks.",
  },
  5: {
    basicToStandardTitle: "Step up Execution & Partnerships to Standard",
    basicToStandardReason:
      "Adds partner evaluation scorecards, commercial term-sheet frameworks, and structured outreach playbooks.",
    standardToPremiumTitle: "Upgrade Execution & Partnerships to Premium",
    standardToPremiumReason:
      "Delivers deal-room preparation, commercial negotiation playbooks, and strategic alliance governance.",
  },
  6: {
    basicToStandardTitle: "Step up Launch & Revenue Ready to Standard",
    basicToStandardReason:
      "Adds conversion funnel architecture, launch runbooks, and structured customer onboarding workflows.",
    standardToPremiumTitle: "Upgrade Launch & Revenue Ready to Premium",
    standardToPremiumReason:
      "Adds payment and membership integration blueprints, SEO tuning, deployment handover, and 60-day launch guidance.",
  },
};

const MATRIX_NEXT_PACKET_COPY: Readonly<Record<string, { title: string; reason: string }>> = {
  "1->2": {
    title: "Add Packet 2: Business Foundation",
    reason: "Pair your IP protection blueprint with a 30-day business launch roadmap and revenue model.",
  },
  "2->3": {
    title: "Add Packet 3: Business Plans",
    reason: "Turn your business foundation into a structured, partner- and lender-ready business plan.",
  },
  "3->4": {
    title: "Add Packet 4: Operating Design",
    reason: "Translate your business plan into day-to-day workflows, SOPs, and team accountability.",
  },
  "4->5": {
    title: "Add Packet 5: Execution & Partnerships",
    reason: "Move from internal operating design into commercial partnerships, outreach, and deal execution.",
  },
  "5->6": {
    title: "Add Packet 6: Launch & Revenue Ready",
    reason: "Complete your go-to-market sequence with launch deployment protocols and revenue systems.",
  },
};

function clampPlainText(value: string, max: number): string {
  const cleaned = value.normalize("NFC").replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1).trimEnd()}…`;
}

function summarizeAddonReason(product: CatalogProductView): string {
  const source = product.outcome.trim() || product.description.trim();
  if (source.length > 0) {
    return clampPlainText(source, 200);
  }
  return clampPlainText(`Add ${product.name} to complement the packets in your cart.`, 200);
}

interface ActivePacketBucket {
  packetNumber: number;
  groupName: string;
  products: CatalogProductView[];
  basic: CatalogProductView | undefined;
  standard: CatalogProductView | undefined;
  premium: CatalogProductView | undefined;
  entryProduct: CatalogProductView;
}

/**
 * Pure builder returning all valid starter suggestion rows whose referenced products exist and are active.
 * Every returned candidate has `active: false`.
 */
export function buildCatalogStarterSuggestions(
  catalogGroups: readonly CatalogGroupView[],
  bundleRule: BundleRule,
): StarterUpsellCandidate[] {
  const activeById = new Map<string, CatalogProductView>();
  const packetProductsByNum = new Map<number, { groupName: string; products: CatalogProductView[] }>();
  const standaloneAddons: { groupName: string; product: CatalogProductView }[] = [];

  for (const group of catalogGroups) {
    for (const product of group.products) {
      if (!product.active) continue;
      activeById.set(product.publicId, product);
      if (product.packetNumber !== null) {
        const bucket = packetProductsByNum.get(product.packetNumber) ?? {
          groupName: group.name,
          products: [],
        };
        bucket.products.push(product);
        packetProductsByNum.set(product.packetNumber, bucket);
      } else {
        standaloneAddons.push({ groupName: group.name, product });
      }
    }
  }

  const packetBuckets: ActivePacketBucket[] = [...packetProductsByNum.entries()]
    .sort(([a], [b]) => a - b)
    .map(([packetNumber, entry]) => {
      const sorted = [...entry.products].sort((a, b) => a.priceMinor - b.priceMinor || a.sortOrder - b.sortOrder);
      const basic = sorted.find((p) => p.tier === "Basic");
      const standard = sorted.find((p) => p.tier === "Standard");
      const premium = sorted.find((p) => p.tier === "Premium");
      return {
        packetNumber,
        groupName: entry.groupName,
        products: sorted,
        basic,
        standard,
        premium,
        entryProduct: basic ?? sorted[0]!,
      };
    });

  const candidates: StarterUpsellCandidate[] = [];
  const seenSeedKeys = new Set<string>();

  const pushCandidate = (candidate: StarterUpsellCandidate) => {
    if (seenSeedKeys.has(candidate.seedKey)) return;
    if (!activeById.has(candidate.targetProductPublicId)) return;
    if (candidate.triggerMode === "products") {
      if (candidate.triggerProductPublicIds.length === 0) return;
      if (candidate.triggerProductPublicIds.some((id) => !activeById.has(id))) return;
    }
    seenSeedKeys.add(candidate.seedKey);
    candidates.push(candidate);
  };

  // (a) Tier upgrades: Basic -> Standard and Standard -> Premium (or Basic -> Premium if Standard is absent)
  for (const bucket of packetBuckets) {
    const pkt = bucket.packetNumber;
    const matrixCopy = MATRIX_TIER_UPGRADE_COPY[pkt];

    if (
      bucket.basic &&
      bucket.standard &&
      bucket.basic.currency === bucket.standard.currency &&
      bucket.standard.priceMinor > bucket.basic.priceMinor
    ) {
      pushCandidate({
        seedKey: `tier-upgrade:packet-${pkt}:basic-to-standard`,
        kind: "tier_upgrade",
        ruleType: "standard",
        title: clampPlainText(matrixCopy?.basicToStandardTitle ?? `Step up ${bucket.groupName} to Standard`, 120),
        shortText: clampPlainText(
          matrixCopy?.basicToStandardReason ??
            `Expands ${bucket.groupName} with deeper deliverables, structured analysis, and broader coverage.`,
          200,
        ),
        triggerMode: "products",
        triggerProductPublicIds: [bucket.basic.publicId],
        targetProductPublicId: bucket.standard.publicId,
        priority: 10 + pkt,
        active: false,
      });
    }

    if (
      bucket.standard &&
      bucket.premium &&
      bucket.standard.currency === bucket.premium.currency &&
      bucket.premium.priceMinor > bucket.standard.priceMinor
    ) {
      pushCandidate({
        seedKey: `tier-upgrade:packet-${pkt}:standard-to-premium`,
        kind: "tier_upgrade",
        ruleType: "standard",
        title: clampPlainText(matrixCopy?.standardToPremiumTitle ?? `Upgrade ${bucket.groupName} to Premium`, 120),
        shortText: clampPlainText(
          matrixCopy?.standardToPremiumReason ??
            `Delivers the comprehensive ${bucket.groupName} engagement with executive-ready depth and revision support.`,
          200,
        ),
        triggerMode: "products",
        triggerProductPublicIds: [bucket.standard.publicId],
        targetProductPublicId: bucket.premium.publicId,
        priority: 20 + pkt,
        active: false,
      });
    } else if (
      !bucket.standard &&
      bucket.basic &&
      bucket.premium &&
      bucket.basic.currency === bucket.premium.currency &&
      bucket.premium.priceMinor > bucket.basic.priceMinor
    ) {
      pushCandidate({
        seedKey: `tier-upgrade:packet-${pkt}:basic-to-premium`,
        kind: "tier_upgrade",
        ruleType: "standard",
        title: clampPlainText(matrixCopy?.standardToPremiumTitle ?? `Upgrade ${bucket.groupName} to Premium`, 120),
        shortText: clampPlainText(
          matrixCopy?.standardToPremiumReason ??
            `Delivers the comprehensive ${bucket.groupName} engagement with executive-ready depth and revision support.`,
          200,
        ),
        triggerMode: "products",
        triggerProductPublicIds: [bucket.basic.publicId],
        targetProductPublicId: bucket.premium.publicId,
        priority: 20 + pkt,
        active: false,
      });
    }
  }

  // (b) Complete-the-bundle when several packets are in the cart
  const requiredBundlePackets = [...bundleRule.requiredPacketNumbers].sort((a, b) => a - b);
  if (requiredBundlePackets.length >= 2) {
    const anchorBucket = packetBuckets.find((b) => requiredBundlePackets.includes(b.packetNumber));
    if (anchorBucket) {
      const pct = bundleRule.discountPercent > 0 ? bundleRule.discountPercent : 15;
      const bundleTitle = bundleRule.label.trim()
        ? `Complete ${bundleRule.label.trim()} (${pct}% off)`
        : `Complete the full packet bundle (${pct}% off)`;
      pushCandidate({
        seedKey: "bundle:complete-all-in",
        kind: "add_on",
        ruleType: "bundle_completion",
        title: clampPlainText(bundleTitle, 120),
        shortText: clampPlainText(
          `Add the remaining packets to complete your ${requiredBundlePackets.length}-packet bundle and apply the ${pct}% multi-packet discount across your order.`,
          200,
        ),
        triggerMode: "any_cart",
        triggerProductPublicIds: [],
        targetProductPublicId: anchorBucket.entryProduct.publicId,
        priority: 35,
        active: false,
      });
    }
  }

  // (c) Natural next packet for each packet in sequence (Packet N -> Packet N+1)
  for (let idx = 0; idx < packetBuckets.length - 1; idx++) {
    const current = packetBuckets[idx]!;
    const next = packetBuckets[idx + 1]!;
    const target = next.entryProduct;
    const triggerIds = current.products
      .filter((p) => p.currency === target.currency)
      .map((p) => p.publicId);
    if (triggerIds.length === 0) continue;

    const pairKey = `${current.packetNumber}->${next.packetNumber}`;
    const pairCopy = MATRIX_NEXT_PACKET_COPY[pairKey];
    pushCandidate({
      seedKey: `next-packet:packet-${current.packetNumber}-to-${next.packetNumber}`,
      kind: "add_on",
      ruleType: "next_packet",
      title: clampPlainText(pairCopy?.title ?? `Continue with Packet ${next.packetNumber}: ${next.groupName}`, 120),
      shortText: clampPlainText(
        pairCopy?.reason ??
          `Follow ${current.groupName} with ${next.groupName}, the next stage in the ReadyPackets sequence.`,
        200,
      ),
      triggerMode: "products",
      triggerProductPublicIds: triggerIds,
      targetProductPublicId: target.publicId,
      priority: 40 + current.packetNumber,
      active: false,
    });
  }

  // (d) Add-on style suggestions:
  //   1. Any standalone non-packet products in the active catalogue (`packetNumber === null`)
  standaloneAddons.forEach(({ product }, idx) => {
    const safeKey = product.productKey.replace(/[^a-zA-Z0-9._:-]/g, "-").slice(0, 72);
    pushCandidate({
      seedKey: `addon:${safeKey}`,
      kind: "add_on",
      ruleType: "standard",
      title: clampPlainText(`Add ${product.name}`, 120),
      shortText: summarizeAddonReason(product),
      triggerMode: "any_cart",
      triggerProductPublicIds: [],
      targetProductPublicId: product.publicId,
      priority: 60 + idx,
      active: false,
    });
  });

  //   2. Complementary cross-stage add-ons from the ReadyPackets matrix when Packets 1–6 are present
  const bucketByPacket = new Map(packetBuckets.map((b) => [b.packetNumber, b]));
  const p1 = bucketByPacket.get(1);
  const p2 = bucketByPacket.get(2);
  const p3 = bucketByPacket.get(3);
  const p6 = bucketByPacket.get(6);

  if (p6 && (p1 || p2 || p3)) {
    const earlyTriggers = [p1, p2, p3]
      .filter((b): b is ActivePacketBucket => Boolean(b))
      .flatMap((b) => b.products)
      .filter((p) => p.currency === p6.entryProduct.currency)
      .map((p) => p.publicId);
    if (earlyTriggers.length > 0) {
      pushCandidate({
        seedKey: "addon:matrix-launch-readiness",
        kind: "add_on",
        ruleType: "standard",
        title: "Add Launch & Revenue Readiness (Packet 6)",
        shortText:
          "Prepare your launch checklist, deployment handover, and Day-1 revenue setup alongside early planning.",
        triggerMode: "products",
        triggerProductPublicIds: earlyTriggers,
        targetProductPublicId: p6.entryProduct.publicId,
        priority: 75,
        active: false,
      });
    }
  }

  if (p1 && (p2 || p3)) {
    const businessTriggers = [p2, p3]
      .filter((b): b is ActivePacketBucket => Boolean(b))
      .flatMap((b) => b.products)
      .filter((p) => p.currency === p1.entryProduct.currency)
      .map((p) => p.publicId);
    if (businessTriggers.length > 0) {
      pushCandidate({
        seedKey: "addon:matrix-ip-foundation",
        kind: "add_on",
        ruleType: "standard",
        title: "Add Idea & IP Protection (Packet 1)",
        shortText:
          "Document your core invention architecture and filing checklist alongside your business foundation.",
        triggerMode: "products",
        triggerProductPublicIds: businessTriggers,
        targetProductPublicId: p1.entryProduct.publicId,
        priority: 76,
        active: false,
      });
    }
  }

  return candidates;
}
