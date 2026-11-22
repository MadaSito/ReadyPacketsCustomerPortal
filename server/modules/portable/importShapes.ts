import { OrderItemRecord, OrderRecord } from "../../../portable/src/index.js";
import type { FileCategory } from "../files/index.js";
import { validation } from "../../core/errors.js";
import { ULID_PATTERN } from "../../core/ids.js";
import { nameSchema } from "../identity/normalize.js";
import type { ImportOrderInput } from "../orders/index.js";
import type { JsonRecord, PortableInputRecord } from "./importPlanning.js";

const discountLabelSchema = OrderRecord.shape.discountLabel;
const promoLabelSchema = OrderRecord.shape.promoLabel;
const itemSnapshotSchema = OrderItemRecord.pick({ packetNumber: true, outcome: true, timeline: true, deliverables: true });

export function customerName(record: JsonRecord) {
  const supplied = [record.preferredName, [record.firstName, record.middleName, record.lastName, record.suffix]
    .filter((part): part is string => typeof part === "string" && Boolean(part.trim())).join(" ")].
    find((part): part is string => typeof part === "string" && Boolean(part.trim()));
  const valid = nameSchema.safeParse(supplied);
  if (!valid.success) throw invalidTarget();
  return valid.data;
}

export function fileCategory(value: unknown): FileCategory {
  if (value === "supporting" || value === "intake_attachment" || value === "deliverable") return value;
  throw invalidTarget();
}

export function integer(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw invalidTarget();
  return value;
}

export function targetDate(value: unknown): Date {
  const date = new Date(stringField(value));
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1000) throw invalidTarget();
  return date;
}

export function customerCreatedAt(value: unknown): Date | undefined {
  return value === null || value === undefined ? undefined : targetDate(value);
}

export function numberField(record: JsonRecord, field: string) { return integer(record[field]); }

export function targetMoney(value: unknown, currency: string) {
  if (!value || typeof value !== "object" || !("amountMinor" in value) || !("currency" in value) || currency !== value.currency) {
    throw invalidTarget();
  }
  return integer(value.amountMinor);
}

export function fieldObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function invalidTarget() {
  return validation("PORTABLE_TARGET_POLICY", "A source record does not meet target transfer requirements.");
}

export function stringField(value: unknown): string {
  if (typeof value !== "string" || !value) throw invalidTarget();
  return value;
}

function targetTier(value: unknown, packetNumber: number | null | undefined) {
  // Older archives may carry a generic tier token but no packet number. Do not infer packet identity.
  if (packetNumber === null || packetNumber === undefined) return null;
  switch (value) {
    case "basic": return "Basic";
    case "standard": return "Standard";
    case "premium": return "Premium";
    default: throw invalidTarget();
  }
}

export function projectedOrder(order: JsonRecord, items: JsonRecord[], history: JsonRecord[]) {
  const currency = stringField(order.currency);
  const projectName = stringField(order.projectName).trim();
  if (!/^[A-Z]{3}$/.test(currency) || projectName.length < 1 || projectName.length > 160 ||
    items.length > 200 || history.length > 500) throw invalidTarget();
  const discountLabel = discountLabelSchema.safeParse(order.discountLabel);
  if (!discountLabel.success) throw invalidTarget();
  const promoLabel = promoLabelSchema.safeParse(order.promoLabel);
  const discountMinor = targetMoney(order.discount, currency);
  // Older 3.0 records carry no promo fields: no promotion. A promo share above the discount is refused.
  const promoDiscountMinor = order.promoDiscount === undefined ? 0 : targetMoney(order.promoDiscount, currency);
  if (!promoLabel.success || promoDiscountMinor < 0 || promoDiscountMinor > discountMinor) throw invalidTarget();
  return {
    projectName, statusKey: stringField(order.status), totalMinor: targetMoney(order.total, currency), currency,
    subtotalMinor: targetMoney(order.subtotal, currency), discountMinor,
    discountLabel: discountLabel.data ?? null, promoDiscountMinor, promoLabel: promoLabel.data ?? null,
    sourceReference: stringField(order.orderNumber), createdAt: targetDate(order.createdAt),
    // heldUnknown must not control application state, amounts, access, or execution. It remains inert.
    submittedAt: order.submittedAt ? targetDate(order.submittedAt) : null,
    lineItems: items.map((record) => {
      const name = stringField(record.name);
      const quantity = numberField(record, "quantity");
      if (name.length > 160 || quantity < 1 || quantity > 10_000) throw invalidTarget();
      const sku = stringField(record.sku);
      const snapshot = itemSnapshotSchema.safeParse({
        packetNumber: record.packetNumber, outcome: record.outcome, timeline: record.timeline, deliverables: record.deliverables,
      });
      if (!snapshot.success) throw invalidTarget();
      return {
        sourcePublicId: record.publicId, productPublicId: ULID_PATTERN.test(sku) ? sku : null, productVersion: null,
        name, description: "", features: [], quantity, currency,
        ...snapshot.data, tier: targetTier(record.tier, snapshot.data.packetNumber),
        unitPriceMinor: targetMoney(record.unitPrice, currency), lineTotalMinor: targetMoney(record.lineTotal, currency),
      };
    }),
    statusHistory: history.map((record) => {
      const actor = fieldObject(record.actor);
      return {
        sourcePublicId: record.publicId, fromStatus: typeof record.fromStatus === "string" ? record.fromStatus : null,
        toStatus: stringField(record.toStatus), actorRole: typeof actor.kind === "string" ? actor.kind : "system",
        reasonCode: typeof record.reasonCode === "string" ? record.reasonCode : "PORTABLE_IMPORTED_HISTORY",
        occurredAt: targetDate(record.occurredAt),
      };
    }),
  } satisfies Pick<ImportOrderInput, "projectName" | "statusKey" | "totalMinor" | "currency" | "subtotalMinor" |
    "discountMinor" | "discountLabel" | "promoDiscountMinor" | "promoLabel" | "sourceReference" | "createdAt" | "submittedAt" | "lineItems" | "statusHistory">;
}

export function selectLiveVersions(records: PortableInputRecord[]) {
  const parents = new Map(records.filter((item) => item.type === "files").map((item) => [item.record.publicId, item.record]));
  const latest = new Map<string, JsonRecord>();
  const duplicated = new Set<string>();
  for (const { type, record } of records) {
    if (type !== "file-versions") continue;
    const file = stringField(record.filePublicId);
    const parent = parents.get(file);
    if (!parent || parent.deletedAt) continue;
    const previous = latest.get(file);
    if (!previous || numberField(record, "version") > numberField(previous, "version")) {
      latest.set(file, record); duplicated.delete(file);
    } else if (numberField(record, "version") === numberField(previous, "version")) duplicated.add(file);
  }
  return { parents, latest, duplicated };
}
