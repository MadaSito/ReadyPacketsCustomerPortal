/**
 * Types the packet picker needs from `orders.catalog.list` and `orders.quote` (agreed with orders_engineer,
 * increment 02 contract §B/§C). Structural on purpose: the router output satisfies them.
 */
export const PACKET_TIERS = ["Basic", "Standard", "Premium"] as const;
export type PacketTier = (typeof PACKET_TIERS)[number];

export interface PacketDeliverable {
  title: string;
  detail: string;
}

export interface PickerProduct {
  publicId: string;
  name: string;
  priceMinor: number;
  currency: string;
  packetNumber: number | null;
  tier: PacketTier | null;
  outcome: string;
  timeline: string;
  deliverables: readonly PacketDeliverable[];
}

export interface PickerGroup {
  publicId: string;
  name: string;
  description: string;
  packetNumber: number | null;
  products: readonly PickerProduct[];
}

/** Display figures from the server quote — the client never computes amounts. */
export interface OrderQuote {
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  discountLabel: string | null;
  totalMinor: number;
  bundle: {
    label: string;
    discountPercent: number;
    requiredPacketNumbers: readonly number[];
    missingPacketNumbers: readonly number[];
    applied: boolean;
  } | null;
}

/** packetNumber → chosen productPublicId (absent or null = not included). */
export type PacketSelection = Readonly<Record<number, string | null | undefined>>;
