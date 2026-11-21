/**
 * SharePoint order-data list mapping (increment 03 package H). Pure and tested.
 *
 * Minimal field set (§4.1 H "minimize SharePoint field set"): the order reference (Title), the opaque order
 * public id (idempotency key), the customer reference (never names or email), status label, packet/tier
 * summary, money totals, lifecycle dates and an optional portal link. Nothing else leaves the portal.
 * Column names carry an "Rp" prefix so they never collide with SharePoint built-ins (Created, Modified, …).
 */
import { createHash } from "node:crypto";

export type ListColumnType = "text" | "number" | "dateTime";

export interface ListColumn {
  name: string;
  displayName: string;
  type: ListColumnType;
  /** Only the idempotency column is indexed (needed for $filter on large lists). */
  indexed?: boolean;
}

export const ORDER_ID_COLUMN = "RpOrderId";
export const PORTAL_LINK_COLUMN = "RpPortalLink";

export const LIST_COLUMNS: readonly ListColumn[] = [
  { name: ORDER_ID_COLUMN, displayName: "Order ID", type: "text", indexed: true },
  { name: "RpCustomerRef", displayName: "Customer reference", type: "text" },
  { name: "RpStatus", displayName: "Status", type: "text" },
  { name: "RpPackets", displayName: "Packets", type: "text" },
  { name: "RpCurrency", displayName: "Currency", type: "text" },
  { name: "RpSubtotal", displayName: "Subtotal", type: "number" },
  { name: "RpDiscount", displayName: "Discount", type: "number" },
  { name: "RpTotal", displayName: "Total", type: "number" },
  { name: "RpCreatedAt", displayName: "Created at", type: "dateTime" },
  { name: "RpSubmittedAt", displayName: "Submitted at", type: "dateTime" },
  { name: "RpClosedAt", displayName: "Closed at", type: "dateTime" },
  { name: "RpUpdatedAt", displayName: "Updated at", type: "dateTime" },
  { name: PORTAL_LINK_COLUMN, displayName: "Portal link", type: "text" },
];

/** The subset of the orders module's OrderSyncView this mapping reads. */
export interface OrderSyncSource {
  publicId: string;
  reference: string;
  status: { key: string; label: string };
  items: readonly { packetNumber: number | null; tier: string | null; name: string }[];
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  createdAt: Date;
  submittedAt: Date | null;
  closedAt: Date | null;
  updatedAt: Date;
}

export type ListFields = Record<string, string | number | null>;

const TEXT_MAX = 255;
const PACKETS_MAX_ITEMS = 40;

/** Removes control/format characters and bounds length; SharePoint single-line text holds 255 chars. */
export function safeText(value: string, max = TEXT_MAX): string {
  let out = "";
  for (const ch of value.normalize("NFC")) {
    if (/[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/u.test(ch)) continue;
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out.trim();
}

/** Minor units → major units using the currency's ISO exponent (JPY 0, USD 2, KWD 3). */
export function toMajor(minor: number, currency: string): number {
  let digits = 2;
  try {
    digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    digits = 2;
  }
  return Number((minor / 10 ** digits).toFixed(digits));
}

export function packetsSummary(items: OrderSyncSource["items"]): string {
  const parts = items.slice(0, PACKETS_MAX_ITEMS).map((item) => {
    if (item.packetNumber !== null) return `#${item.packetNumber}${item.tier ? ` ${item.tier}` : ""}`;
    return item.name;
  });
  if (items.length > PACKETS_MAX_ITEMS) parts.push(`+${items.length - PACKETS_MAX_ITEMS}`);
  return safeText(parts.join("; "));
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function buildOrderFields(order: OrderSyncSource, options: { customerReference: string | null; portalLink: string | null }): ListFields {
  return {
    Title: safeText(order.reference),
    [ORDER_ID_COLUMN]: order.publicId,
    RpCustomerRef: options.customerReference ? safeText(options.customerReference, 64) : null,
    RpStatus: safeText(order.status.label, 120),
    RpPackets: packetsSummary(order.items),
    RpCurrency: safeText(order.currency, 3),
    RpSubtotal: toMajor(order.subtotalMinor, order.currency),
    RpDiscount: toMajor(order.discountMinor, order.currency),
    RpTotal: toMajor(order.totalMinor, order.currency),
    RpCreatedAt: iso(order.createdAt),
    RpSubmittedAt: iso(order.submittedAt),
    RpClosedAt: iso(order.closedAt),
    RpUpdatedAt: iso(order.updatedAt),
    [PORTAL_LINK_COLUMN]: options.portalLink,
  };
}

/** Stable SHA-256 of the field set (sorted keys): an unchanged order is not re-written. */
export function fieldsHash(fields: ListFields): string {
  const sorted = Object.keys(fields)
    .sort()
    .map((k) => [k, fields[k]]);
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

/** Portal link from the canonical origin only (never from request headers). */
export function portalLinkFor(canonicalOrigin: string, orderPublicId: string): string {
  return new URL(`/orders/${encodeURIComponent(orderPublicId)}`, canonicalOrigin).href;
}

/** Graph column definition for list creation. */
export function columnDefinition(column: ListColumn): Record<string, unknown> {
  const base: Record<string, unknown> = { name: column.name, displayName: column.displayName, indexed: column.indexed === true };
  if (column.type === "text") base.text = { maxLength: TEXT_MAX };
  if (column.type === "number") base.number = { decimalPlaces: "automatic" };
  if (column.type === "dateTime") base.dateTime = { format: "dateTime" };
  return base;
}

/** A list is compatible when every required column exists with the expected type. */
export function isCompatible(columns: readonly Record<string, unknown>[]): boolean {
  return LIST_COLUMNS.every((required) =>
    columns.some((c) => c.name === required.name && typeof c[required.type] === "object" && c[required.type] !== null),
  );
}

/** Admin-chosen list names: printable, bounded. */
export function validListName(value: string): boolean {
  const s = value.trim();
  return s.length >= 1 && s.length <= 120 && safeText(s, 120) === s && !/[#%*:<>?/\\|"]/u.test(s);
}
