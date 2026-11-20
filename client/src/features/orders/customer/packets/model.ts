/** Pure helpers for the packet picker (no amounts are computed here). */
import { PACKET_TIERS, type PacketSelection, type PacketTier, type PickerGroup, type PickerProduct } from "./types";

export interface PacketGroup extends PickerGroup {
  packetNumber: number;
  /** Tier products in Basic → Standard → Premium order. */
  tiers: Array<PickerProduct & { tier: PacketTier }>;
}

const tierRank = (tier: PacketTier) => PACKET_TIERS.indexOf(tier);

/** Groups that are packets (a packet number and at least one tiered product), ordered by packet number. */
export function packetGroups(groups: readonly PickerGroup[]): PacketGroup[] {
  return groups
    .filter((group): group is PickerGroup & { packetNumber: number } => group.packetNumber !== null)
    .map((group) => ({
      ...group,
      tiers: group.products
        .filter((product): product is PickerProduct & { tier: PacketTier } => product.tier !== null && product.packetNumber === group.packetNumber)
        .sort((a, b) => tierRank(a.tier) - tierRank(b.tier)),
    }))
    .filter((group) => group.tiers.length > 0)
    .sort((a, b) => a.packetNumber - b.packetNumber);
}

/** True when the catalog has packet products (the wizard then shows the packet picker). */
export function isPacketCatalog(groups: readonly PickerGroup[] | undefined): boolean {
  return packetGroups(groups ?? []).length > 0;
}

/** Groups that keep the existing quantity picker. */
export function nonPacketGroups<G extends PickerGroup>(groups: readonly G[]): G[] {
  const packets = new Set(packetGroups(groups).map((group) => group.publicId));
  return groups.filter((group) => !packets.has(group.publicId));
}

/** Order items for the selection: exactly one of each chosen tier, quantity 1, in packet order. */
export function packetItems(selection: PacketSelection, groups?: readonly PickerGroup[]): Array<{ productPublicId: string; quantity: 1 }> {
  if (!groups) {
    return Object.keys(selection)
      .map(Number)
      .sort((a, b) => a - b)
      .flatMap((packetNumber) => {
        const chosen = selection[packetNumber];
        return chosen ? [{ productPublicId: chosen, quantity: 1 as const }] : [];
      });
  }
  return packetGroups(groups).flatMap((group) => {
    const chosen = selection[group.packetNumber];
    return chosen && group.tiers.some((tier) => tier.publicId === chosen) ? [{ productPublicId: chosen, quantity: 1 as const }] : [];
  });
}

/** The tier a higher tier builds on ("Everything in Basic, plus:"), or null for the first tier. */
export function includedTier(tier: PacketTier): PacketTier | null {
  const rank = tierRank(tier);
  return rank > 0 ? (PACKET_TIERS[rank - 1] ?? null) : null;
}

export interface SelectedPacket {
  packetNumber: number;
  packetName: string;
  product: PickerProduct & { tier: PacketTier };
}

export function selectedPackets(selection: PacketSelection, groups: readonly PickerGroup[]): SelectedPacket[] {
  return packetGroups(groups).flatMap((group) => {
    const product = group.tiers.find((tier) => tier.publicId === selection[group.packetNumber]);
    return product ? [{ packetNumber: group.packetNumber, packetName: group.name, product }] : [];
  });
}
