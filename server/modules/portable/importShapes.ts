import { OrderItemRecord, OrderRecord } from "../../../portable/src/index.js";
import type { FileCategory } from "../files/index.js";
import { DomainError, validation } from "../../core/errors.js";
import { ULID_PATTERN } from "../../core/ids.js";
import { billingDetailsSchema, type BillingDetails } from "../../../shared/billingDetails.js";
import { firstNameSchema, fullNameOf, lastNameSchema, nameSchema, preferredNameSchema, type NameParts } from "../identity/normalize.js";
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

const present = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim());

/**
 * Display name and, when the record carries them, name parts (increment 08). A record with both a first and a last
 * name is read as parts: display = "<First> <Last>", preferredName = nickname. Anything else is a legacy record
 * (≤ increment 07 exports put the display name in preferredName) and keeps the legacy display-name rule.
 */
export function customerIdentity(record: JsonRecord): { name: string; nameParts?: NameParts } {
  if (!present(record.firstName) || !present(record.lastName)) return { name: customerName(record) };
  const firstName = firstNameSchema.safeParse(record.firstName);
  const lastName = lastNameSchema.safeParse(record.lastName);
  const preferredName = preferredNameSchema.safeParse(typeof record.preferredName === "string" ? record.preferredName : "");
  if (!firstName.success || !lastName.success || !preferredName.success) throw invalidTarget();
  const nameParts = { firstName: firstName.data, lastName: lastName.data, preferredName: preferredName.data };
  const name = nameSchema.safeParse(fullNameOf(nameParts));
  if (!name.success) throw invalidTarget();
  return { name: name.data, nameParts };
}

/** Saved billing profile carried on a customer record (increment 08). Absent / null = none. Re-validated here. */
export function customerBillingProfile(record: JsonRecord): BillingDetails | null {
  if (record.billingProfile === undefined || record.billingProfile === null) return null;
  const parsed = billingDetailsSchema.safeParse(record.billingProfile);
  if (!parsed.success) throw invalidTarget();
  return parsed.data;
}

export interface ImportTrash { trashedAt: Date; batchId: string | null; reason: string | null; purgedAt: Date | null }

/**
 * Trash state of a customer or order record (increment 09). Absent / null = live. A half-finished permanent deletion
 * (purgeStartedAt without purgedAt) is refused: import never makes such a row live and never guesses its content.
 */
export function trashOf(record: JsonRecord): ImportTrash | null {
  const value = record.trash;
  if (value === undefined || value === null) return null;
  const trash = fieldObject(value);
  if (trash.purgeStartedAt !== null && trash.purgeStartedAt !== undefined && (trash.purgedAt === null || trash.purgedAt === undefined)) {
    throw validation("PORTABLE_PURGE_IN_PROGRESS", "A source record is in the middle of a permanent deletion.");
  }
  const batchId = trash.batchId ?? null;
  const reason = trash.reason ?? null;
  if ((batchId !== null && (typeof batchId !== "string" || !ULID_PATTERN.test(batchId))) ||
    (reason !== null && (typeof reason !== "string" || reason.length > 200))) throw invalidTarget();
  const trashedAt = targetDate(trash.trashedAt);
  const purgedAt = trash.purgedAt === null || trash.purgedAt === undefined ? null : targetDate(trash.purgedAt);
  if (purgedAt && purgedAt < trashedAt) throw invalidTarget();
  return { trashedAt, batchId, reason, purgedAt };
}

/** Reason code for a record's trash state, or null when it is acceptable. */
export function trashProblem(record: JsonRecord): string | null {
  try { trashOf(record); return null; } catch (error) {
    return error instanceof DomainError && error.reasonCode === "PORTABLE_PURGE_IN_PROGRESS"
      ? "PORTABLE_PURGE_IN_PROGRESS" : "PORTABLE_TARGET_POLICY";
  }
}

/** Portable id of the order group root (increment 08). Absent / null = the order is its own root. */
export function groupRootOf(record: JsonRecord): string | null {
  const value = record.groupRootOrderPublicId;
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !ULID_PATTERN.test(value) || value === record.publicId) throw invalidTarget();
  return value;
}

/**
 * Group links must stay consistent: the root is another order in the same package, is itself a root and has the
 * same customer and currency. Returns a reason code, or null when the record is fine.
 */
export function groupLinkProblem(record: JsonRecord, ordersById: ReadonlyMap<string, JsonRecord>): string | null {
  let rootId: string | null;
  try { rootId = groupRootOf(record); } catch { return "PORTABLE_ORDER_GROUP_INVALID"; }
  if (rootId === null) return null;
  const root = ordersById.get(rootId);
  if (!root) return "PORTABLE_ORDER_GROUP_ROOT_MISSING";
  if ((root.groupRootOrderPublicId ?? null) !== null || root.customerPublicId !== record.customerPublicId ||
    root.currency !== record.currency) return "PORTABLE_ORDER_GROUP_INVALID";
  // A live addition under a root in the trash cannot occur at the source (increment 09 group rules).
  if ((record.trash ?? null) === null && (root.trash ?? null) !== null) return "PORTABLE_ORDER_GROUP_INVALID";
  return null;
}

/**
 * Trash consistency of an order with its owner and its children (increment 09): an order of a customer in the trash is
 * itself in the trash, an order of a tombstoned customer is a tombstone, and a tombstone has no items, history or files.
 */
export function orderTrashProblem(record: JsonRecord, owner: JsonRecord | undefined, children: number): string | null {
  const own = trashProblem(record);
  if (own) return own;
  const trash = trashOf(record);
  let ownerTrash: ImportTrash | null;
  try { ownerTrash = owner ? trashOf(owner) : null; } catch { return "PORTABLE_OWNER_NOT_PLANNED"; }
  if (ownerTrash && !trash) return "PORTABLE_TRASH_STATE_INVALID";
  if (ownerTrash?.purgedAt && !trash?.purgedAt) return "PORTABLE_TRASH_STATE_INVALID";
  if (trash?.purgedAt && children > 0) return "PORTABLE_TRASH_STATE_INVALID";
  return null;
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
