/** Pure order pricing (increment 02): packet rules and the bundle discount. No I/O. */
import { validation } from "../../core/errors.js";
import type { BundleRule } from "./settings.js";

export interface PricedLine {
  packetNumber: number | null;
  quantity: number;
  lineTotalMinor: number;
}

export interface BundleQuote {
  enabled: true;
  label: string;
  discountPercent: number;
  requiredPacketNumbers: number[];
  missingPacketNumbers: number[];
  applied: boolean;
}

export interface OrderPricing {
  subtotalMinor: number;
  discountMinor: number;
  discountLabel: string | null;
  totalMinor: number;
  bundle: BundleQuote | null;
}

/** Packet items: quantity exactly 1 and at most one tier per packet. */
export function assertPacketRules(lines: readonly PricedLine[]): void {
  const seen = new Set<number>();
  for (const line of lines) {
    if (line.packetNumber === null) continue;
    if (line.quantity !== 1) throw validation("PACKET_QUANTITY_ONE", "Each packet can be ordered once.");
    if (seen.has(line.packetNumber)) throw validation("PACKET_TIER_CONFLICT", "Choose one tier per packet.");
    seen.add(line.packetNumber);
  }
}

/** Round-half-up percentage of a non-negative integer amount, in integer arithmetic. */
export function percentOf(amountMinor: number, percent: number): number {
  return Math.floor((amountMinor * percent + 50) / 100);
}

export function priceOrder(lines: readonly PricedLine[], rule: BundleRule): OrderPricing {
  assertPacketRules(lines);
  const subtotalMinor = lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);
  if (!Number.isSafeInteger(subtotalMinor) || !Number.isSafeInteger(subtotalMinor * 100))
    throw validation("AMOUNT_TOO_LARGE", "The order total is too large.");
  let bundle: BundleQuote | null = null;
  let discountMinor = 0;
  let discountLabel: string | null = null;
  if (rule.enabled && rule.requiredPacketNumbers.length > 0 && rule.discountPercent > 0) {
    const present = new Set(lines.map((line) => line.packetNumber).filter((n): n is number => n !== null));
    const required = [...rule.requiredPacketNumbers].sort((a, b) => a - b);
    const missingPacketNumbers = required.filter((n) => !present.has(n));
    const applied = missingPacketNumbers.length === 0;
    bundle = { enabled: true, label: rule.label, discountPercent: rule.discountPercent, requiredPacketNumbers: required, missingPacketNumbers, applied };
    if (applied) {
      discountMinor = Math.min(subtotalMinor, percentOf(subtotalMinor, rule.discountPercent));
      discountLabel = rule.label;
    }
  }
  return { subtotalMinor, discountMinor, discountLabel, totalMinor: subtotalMinor - discountMinor, bundle };
}
