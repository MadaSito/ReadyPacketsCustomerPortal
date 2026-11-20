/** Customer packet picker (increment 02 §C). Owner: ui_foundation_engineer; mounted by NewOrderPage (orders). */
export { PacketPicker, NOT_INCLUDED, type PacketPickerProps } from "./PacketPicker";
export { PacketSummary, bundleHint, type PacketSummaryProps } from "./PacketSummary";
export { isPacketCatalog, nonPacketGroups, packetGroups, packetItems, selectedPackets, includedTier } from "./model";
export { PACKET_TIERS, type OrderQuote, type PacketSelection, type PacketTier, type PickerGroup, type PickerProduct, type PacketDeliverable } from "./types";
export { useOrderQuote, type OrderQuoteState } from "./useOrderQuote";
