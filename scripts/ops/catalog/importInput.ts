/**
 * Offerings document -> catalog service input. Kept in its own module (no command-line entry point) so that
 * other operator commands, e.g. the demo seed, can reuse it: bundling a module that has a "run when executed
 * directly" guard into another command would run that guard too.
 */
import type { OfferingsImportInput } from "../../../server/modules/orders/catalog.js";
import type { Offerings } from "./offerings.js";

/** Maps the offerings document onto the catalog service input (listed packets + bundle rule only). */
export function toImportInput(doc: Offerings): OfferingsImportInput {
  return {
    currency: doc.currency,
    packets: doc.packets.map((packet) => ({
      packetNumber: packet.packetNumber,
      groupKey: packet.groupKey,
      name: packet.name,
      sortOrder: packet.packetNumber * 10,
      tiers: packet.tiers.map((t) => ({
        tier: t.tier,
        productKey: t.productKey,
        name: t.name,
        priceMinor: t.priceMinor,
        outcome: t.outcome,
        timeline: t.timeline,
        deliverables: t.deliverables.map((d) => ({ title: d.title, detail: d.detail })),
      })),
    })),
    bundle: { requiredPacketNumbers: [...doc.bundle.requiredPacketNumbers], discountPercent: doc.bundle.discountPercent, label: doc.bundle.name },
  };
}
