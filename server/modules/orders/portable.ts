/**
 * Portable transfer hooks (export projection + transactional import adoption).
 * Import NEVER trusts archive-supplied identity: the target owner comes from the portable mapping and is
 * re-validated here; target public ids are freshly generated; no workflow, notification or mail is replayed.
 */
import { and, asc, eq, gt, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { conflict, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { AuditEmitter, Clock, Db, DbOrTx, FieldCrypto, Logger, SettingsStore, Tx } from "../../core/types.js";
import type { Services } from "../../container.js";
import { readSetting } from "../platform/index.js";
import { assertCurrency } from "./catalog.js";
import { identityPort, namePartsInTx } from "./ports.js";
import { allocateStemReference, buildReferenceStem, isReferenceReserved, normalizeReference, noteStemReferenceUsed, reserveReference, stemOfReference } from "./references.js";
import {
  orderImportProvenance,
  orderLineItems,
  orderNotes,
  orderReferences,
  orders,
  orderStatusHistory,
  orderWorkflows,
  orderWorkflowVersions,
  PACKET_TIERS,
} from "./schema.js";
import { ORDER_REFERENCE_PREFIX } from "./settings.js";
import type { ImportOrderInput, PortableOrder, PortableSelection } from "./types.js";
import type { WorkflowService } from "./workflows.js";
import { TOMBSTONE_PROJECT_NAME } from "./trash.js";
import { isLiveOrderRow, liveOrderPredicate } from "./trashGate.js";
import { DEFAULT_WORKFLOW, findState } from "./workflowTypes.js";

export interface PortableDeps {
  db: Db;
  clock: Clock;
  audit: AuditEmitter;
  crypto: FieldCrypto;
  settings: SettingsStore;
  logger: Logger;
  services: Services;
  workflows: WorkflowService;
}

const money = z.number().int().refine(Number.isSafeInteger);
const text = (max: number, min = 0) =>
  z
    .string()
    .transform((v) => v.normalize("NFC").trim())
    .pipe(z.string().min(min).max(max));
const sourceId = z.string().min(1).max(64).optional();

export const importOrderInputSchema = z.strictObject({
  importId: z.string().min(1).max(64),
  sourceInstallationId: z.string().min(1).max(64),
  sourceOrderPublicId: z.string().min(1).max(64),
  sourceReference: z.string().min(1).max(64).optional(),
  targetOwnerUserId: z.number().int().positive(),
  /** Increment 08 (D3): local id of the already-imported group root (absent/null = standalone, as in older packages). */
  groupRootOrderId: z.number().int().positive().nullable().optional(),
  projectName: text(160, 1),
  statusKey: z.string().min(1).max(64),
  /** Optional (v3): absent = totalMinor, i.e. no discount. totalMinor must equal subtotalMinor - discountMinor. */
  subtotalMinor: money.optional(),
  discountMinor: money.optional(),
  discountLabel: text(120).nullable().optional(),
  /** Optional (increment 05): the promotion code's part of discountMinor (historical fact only; no redemption row). */
  promoDiscountMinor: z.number().int().min(0).refine(Number.isSafeInteger).optional(),
  promoLabel: text(120).nullable().optional(),
  totalMinor: money,
  currency: z.string().length(3),
  createdAt: z.date(),
  submittedAt: z.date().nullable().optional(),
  lineItems: z
    .array(
      z.strictObject({
        sourcePublicId: sourceId,
        productPublicId: z.string().max(64).nullable(),
        productVersion: z.number().int().min(0).nullable(),
        name: text(160, 1),
        description: text(2000),
        features: z.array(text(200)).max(50),
        packetNumber: z.number().int().min(1).max(255).nullable().optional(),
        tier: z.enum(PACKET_TIERS).nullable().optional(),
        outcome: text(1000).optional(),
        timeline: text(120).optional(),
        deliverables: z.array(z.strictObject({ title: text(200, 1), detail: text(2000) })).max(100).optional(),
        unitPriceMinor: money,
        currency: z.string().length(3),
        quantity: z.number().int().min(1).max(10_000),
        lineTotalMinor: money,
      }),
    )
    .max(200),
  statusHistory: z
    .array(
      z.strictObject({
        sourcePublicId: sourceId,
        fromStatus: z.string().max(64).nullable(),
        toStatus: z.string().min(1).max(64),
        actorRole: z.string().max(16),
        reasonCode: z.string().max(48),
        occurredAt: z.date(),
      }),
    )
    .max(500)
    .optional(),
  customerNotes: z
    .array(z.strictObject({ sourcePublicId: sourceId, body: text(5000, 1), createdAt: z.date() }))
    .max(200)
    .optional(),
  editable: z.boolean().optional(),
  /**
   * Increment 09 (D2): trash state of the source order. purgedAt null = imported into the trash (hidden by the gate);
   * purgedAt set = imported as a tombstone (reference, totals, currency, createdAt and owner only; no lines or notes).
   */
  trash: z
    .strictObject({
      trashedAt: z.date(),
      batchId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/).nullable(),
      reason: text(200).nullable(),
      purgedAt: z.date().nullable(),
    })
    .nullable()
    .optional(),
});

export interface ImportReceipt {
  id: number;
  publicId: string;
  reference: string;
  created: boolean;
  receipts: {
    lineItems: { sourcePublicId: string | null; publicId: string }[];
    statusHistory: { sourcePublicId: string | null; publicId: string }[];
    customerNotes: { sourcePublicId: string | null; publicId: string }[];
  };
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export type ImportPreflightIssue =
  | "IMPORT_ORDER_INVALID"
  | "IMPORT_CURRENCY_UNSUPPORTED"
  | "IMPORT_MIXED_CURRENCY"
  | "IMPORT_LINE_TOTAL_MISMATCH"
  | "IMPORT_TOTAL_MISMATCH";

/**
 * Pure, write-free preflight of one imported order (schema, currency, exact line math, summed total).
 * importOrder runs the same checks again at apply time.
 */
export function preflightImportOrder(raw: unknown): { ok: true; input: ImportOrderInput } | { ok: false; reasonCode: ImportPreflightIssue; paths: string[] } {
  const parsed = importOrderInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reasonCode: "IMPORT_ORDER_INVALID", paths: parsed.error.issues.slice(0, 10).map((i) => i.path.join(".")) };
  const input = parsed.data;
  try {
    assertCurrency(input.currency);
  } catch {
    return { ok: false, reasonCode: "IMPORT_CURRENCY_UNSUPPORTED", paths: ["currency"] };
  }
  let sum = 0;
  for (const [index, item] of input.lineItems.entries()) {
    if (item.currency !== input.currency) return { ok: false, reasonCode: "IMPORT_MIXED_CURRENCY", paths: [`lineItems.${index}.currency`] };
    const product = item.unitPriceMinor * item.quantity;
    if (!Number.isSafeInteger(product) || product !== item.lineTotalMinor)
      return { ok: false, reasonCode: "IMPORT_LINE_TOTAL_MISMATCH", paths: [`lineItems.${index}.lineTotalMinor`] };
    sum += item.lineTotalMinor;
    if (!Number.isSafeInteger(sum)) return { ok: false, reasonCode: "IMPORT_TOTAL_MISMATCH", paths: ["totalMinor"] };
  }
  const subtotal = input.subtotalMinor ?? input.totalMinor + (input.discountMinor ?? 0);
  const discount = input.discountMinor ?? 0;
  if (discount < 0 || discount > subtotal || subtotal - discount !== input.totalMinor)
    return { ok: false, reasonCode: "IMPORT_TOTAL_MISMATCH", paths: ["totalMinor"] };
  if ((input.promoDiscountMinor ?? 0) > discount) return { ok: false, reasonCode: "IMPORT_TOTAL_MISMATCH", paths: ["promoDiscountMinor"] };
  if (input.trash?.purgedAt && input.trash.purgedAt < input.trash.trashedAt) return { ok: false, reasonCode: "IMPORT_ORDER_INVALID", paths: ["trash.purgedAt"] };
  if (input.lineItems.length > 0 && sum !== subtotal) return { ok: false, reasonCode: "IMPORT_TOTAL_MISMATCH", paths: ["totalMinor"] };
  for (const [index, item] of input.lineItems.entries())
    if ((item.packetNumber ?? null) === null !== ((item.tier ?? null) === null))
      return { ok: false, reasonCode: "IMPORT_ORDER_INVALID", paths: [`lineItems.${index}.tier`] };
  return { ok: true, input };
}

const PREFLIGHT_MESSAGES: Record<ImportPreflightIssue, string> = {
  IMPORT_ORDER_INVALID: "The imported order is not valid.",
  IMPORT_CURRENCY_UNSUPPORTED: "The imported order currency is not supported.",
  IMPORT_MIXED_CURRENCY: "Imported line items must share the order currency.",
  IMPORT_LINE_TOTAL_MISMATCH: "An imported line total does not match its price and quantity.",
  IMPORT_TOTAL_MISMATCH: "The imported order total does not match its line items.",
};

function assertImportOrderPreflight(raw: unknown): ImportOrderInput {
  const result = preflightImportOrder(raw);
  if (!result.ok) throw validation(result.reasonCode, PREFLIGHT_MESSAGES[result.reasonCode], { issues: result.paths });
  return result.input;
}

export function createPortableHooks(deps: PortableDeps) {
  async function findImportedOrder(sourceInstallationId: string, sourceOrderPublicId: string, tx?: DbOrTx) {
    const [row] = await (tx ?? deps.db)
      .select({
        id: orders.id,
        publicId: orders.publicId,
        reference: orders.reference,
        ownerUserId: orders.ownerUserId,
        lockState: orders.lockState,
        createdAt: orders.createdAt,
        submittedAt: orders.submittedAt,
        totalMinor: orders.totalMinor,
        currency: orders.currency,
        groupRootOrderId: orders.groupRootOrderId,
        trashedAt: orders.trashedAt,
        purgeStartedAt: orders.purgeStartedAt,
        purgedAt: orders.purgedAt,
        importId: orderImportProvenance.importId,
      })
      .from(orderImportProvenance)
      .innerJoin(orders, eq(orders.id, orderImportProvenance.orderId))
      .where(
        and(
          eq(orderImportProvenance.sourceInstallationId, sourceInstallationId),
          eq(orderImportProvenance.sourceOrderPublicId, sourceOrderPublicId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Increment 09: the owner of an order imported into the trash or as a tombstone may itself be in the trash or a
   * tombstone, so it is read UNGATED by internal id, after a locking current read (FOR SHARE) of the users row.
   * A trashed owner takes a trashed order or a tombstone; a tombstoned owner only a tombstone; never an owner whose
   * permanent deletion is still running. A tombstone owner is deactivated, so that check is skipped for tombstones.
   */
  async function trashedImportOwner(tx: Tx, userId: number, tombstone: boolean): Promise<{ id: number; publicId: string; role: string; status: string } | null> {
    const identity = (deps.services as Partial<Services>).identity;
    if (typeof identity?.users?.isTrashedInTx !== "function" || typeof identity.portableCustomerRefInTx !== "function") return null;
    await identity.users.isTrashedInTx(tx, userId, { lock: "share" });
    const ref = await identity.portableCustomerRefInTx(tx, { userId });
    if (!ref || ref.role !== "customer") return null;
    if (ref.purgeStartedAt && !ref.purged) return null;
    if (ref.purged && !tombstone) return null;
    if (!ref.trashed && !ref.purged) {
      const live = await identityPort(deps.services).getUser(userId, { tx });
      if (!live) return null;
      return { id: live.id, publicId: live.publicId, role: live.role, status: tombstone ? "active" : live.status };
    }
    return { id: ref.userId, publicId: ref.publicId, role: ref.role, status: "active" };
  }

  return {
    findImportedOrder,

    /** Write-free: is this status key known to the current default workflow (or the built-in default if none is installed yet)? */
    async isPortableStatusSupported(statusKey: string, tx?: DbOrTx): Promise<boolean> {
      if (typeof statusKey !== "string" || statusKey.length === 0 || statusKey.length > 64) return false;
      const current = await deps.workflows.currentDefault(tx ?? deps.db);
      return findState(current ? current.definition : DEFAULT_WORKFLOW, statusKey) !== undefined;
    },

    preflightImportOrder,

    /**
     * Increment 09 (D2, trusted custody read — NOT gated): the order row in any trash state, for portable custody
     * checks and kept-record owners (late payments on a trashed order). Callers must never expose a trashed order
     * through a customer-facing path. `forUpdate` locks the order row (requires a tx).
     */
    async orderCustodyInTx(tx: DbOrTx, orderId: number, options?: { forUpdate?: boolean }): Promise<OrderCustody | null> {
      const q = tx
        .select({ id: orders.id, publicId: orders.publicId, reference: orders.reference, ownerUserId: orders.ownerUserId, trashedAt: orders.trashedAt, purgeStartedAt: orders.purgeStartedAt, purgedAt: orders.purgedAt })
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1);
      const [row] = options?.forUpdate ? await q.for("update") : await q;
      if (!row) return null;
      // Ungated by internal id: the owner of a trashed order may itself be in the trash or a tombstone.
      const owner = await (deps.services as Partial<Services>).identity?.portableCustomerRefInTx?.(tx, { userId: row.ownerUserId });
      return {
        id: row.id,
        publicId: row.publicId,
        reference: row.reference,
        ownerUserId: row.ownerUserId,
        ownerPublicId: owner?.publicId ?? "",
        trashed: row.trashedAt !== null,
        purgeStarted: row.purgeStartedAt !== null,
        purged: row.purgedAt !== null,
      };
    },

    /** Bounded export projection (internal notes and grants are excluded — grants are authority, not data). */
    async portableOrders(tx: DbOrTx, selection: PortableSelection): Promise<{ items: PortableOrder[]; nextAfter: number | null }> {
      const limit = Math.min(Math.max(selection.limit, 1), 200);
      if (selection.customerIds?.length === 0 || selection.orderIds?.length === 0 || selection.groupRootIds?.length === 0) return { items: [], nextAfter: null };
      const rows = await tx
        .select({ order: orders, workflowKey: orderWorkflows.workflowKey })
        .from(orders)
        .innerJoin(orderWorkflowVersions, eq(orderWorkflowVersions.id, orders.workflowVersionId))
        .innerJoin(orderWorkflows, eq(orderWorkflows.id, orderWorkflowVersions.workflowId))
        .where(
          and(
            selection.after !== undefined ? gt(orders.id, selection.after) : undefined,
            // Increment 09 (D2): trashed orders and tombstones travel only in a whole-installation export.
            selection.includeTrashed ? undefined : liveOrderPredicate(),
            selection.customerIds ? inArray(orders.ownerUserId, selection.customerIds.slice(0, 1000)) : undefined,
            selection.orderIds ? inArray(orders.id, selection.orderIds.slice(0, 1000)) : undefined,
            // Increment 08 (D3): whole groups — the roots themselves and every addition pointing at them.
            selection.groupRootIds
              ? or(inArray(orders.id, selection.groupRootIds.slice(0, 1000)), inArray(orders.groupRootOrderId, selection.groupRootIds.slice(0, 1000)))
              : undefined,
          ),
        )
        .orderBy(asc(orders.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const ids = page.map((r) => r.order.id);
      if (ids.length === 0) return { items: [], nextAfter: null };
      const rootIds = [...new Set(page.map((r) => r.order.groupRootOrderId).filter((v): v is number => v !== null))];
      const rootPublicIds = new Map(
        rootIds.length ? (await tx.select({ id: orders.id, publicId: orders.publicId }).from(orders).where(inArray(orders.id, rootIds))).map((r) => [r.id, r.publicId] as const) : [],
      );
      const [items, history, notes, refs] = await Promise.all([
        tx.select().from(orderLineItems).where(inArray(orderLineItems.orderId, ids)).orderBy(asc(orderLineItems.orderId), asc(orderLineItems.sortOrder)),
        tx.select().from(orderStatusHistory).where(inArray(orderStatusHistory.orderId, ids)).orderBy(asc(orderStatusHistory.id)),
        tx
          .select()
          .from(orderNotes)
          .where(and(inArray(orderNotes.orderId, ids), eq(orderNotes.visibility, "customer")))
          .orderBy(asc(orderNotes.id)),
        tx
          .select()
          .from(orderReferences)
          .where(and(inArray(orderReferences.orderId, ids), eq(orderReferences.status, "retired"))),
      ]);
      return {
        items: page.map(({ order, workflowKey }) => ({
          id: order.id,
          publicId: order.publicId,
          reference: order.reference,
          retiredReferences: refs.filter((r) => r.orderId === order.id).map((r) => r.reference),
          groupRootOrderId: order.groupRootOrderId,
          groupRootPublicId: order.groupRootOrderId === null ? null : (rootPublicIds.get(order.groupRootOrderId) ?? null),
          ownerUserId: order.ownerUserId,
          projectName: order.projectName,
          statusKey: order.statusKey,
          workflowKey,
          lockState: order.lockState,
          subtotalMinor: order.subtotalMinor,
          discountMinor: order.discountMinor,
          discountLabel: order.discountLabel,
          promoDiscountMinor: order.promoDiscountMinor,
          promoLabel: order.promoLabel,
          totalMinor: order.totalMinor,
          currency: order.currency,
          origin: order.origin,
          createdAt: order.createdAt,
          updatedAt: order.updatedAt,
          submittedAt: order.submittedAt,
          trash: order.trashedAt
            ? { trashedAt: order.trashedAt, batchId: order.trashBatchId, reason: order.trashReason, purgeStartedAt: order.purgeStartedAt, purgedAt: order.purgedAt }
            : null,
          lineItems: items
            .filter((i) => i.orderId === order.id)
            .map((i) => ({
              publicId: i.publicId,
              productPublicId: i.productPublicId,
              productVersion: i.productVersionNumber,
              name: i.name,
              description: i.description,
              features: i.features,
              packetNumber: i.packetNumber,
              tier: i.tier,
              outcome: i.outcome,
              timeline: i.timeline,
              deliverables: i.deliverables ?? [],
              unitPriceMinor: i.unitPriceMinor,
              currency: i.currency,
              quantity: i.quantity,
              lineTotalMinor: i.lineTotalMinor,
            })),
          statusHistory: history
            .filter((h) => h.orderId === order.id)
            .map((h) => ({ publicId: h.publicId, fromStatus: h.fromStatus, toStatus: h.toStatus, actorRole: h.actorRole, reasonCode: h.reasonCode, occurredAt: h.occurredAt })),
          customerNotes: notes
            .filter((n) => n.orderId === order.id)
            .flatMap((n) => {
              try {
                return [{ publicId: n.publicId, body: deps.crypto.decrypt(n.bodyEnc, `order_notes.body:${n.publicId}`), createdAt: n.createdAt }];
              } catch {
                deps.logger.warn("order note could not be decrypted for export", { notePublicId: n.publicId });
                return [];
              }
            }),
        })),
        nextAfter: rows.length > limit ? page[page.length - 1]!.order.id : null,
      };
    },

    /** Transactional, idempotent adoption of one imported order inside the portable import transaction. */
    async importOrder(raw: ImportOrderInput, tx: Tx): Promise<ImportReceipt> {
      const input = assertImportOrderPreflight(raw);
      const existing = await findImportedOrder(input.sourceInstallationId, input.sourceOrderPublicId, tx);
      const tombstone = Boolean(input.trash?.purgedAt);
      if (existing) {
        if (existing.purgeStartedAt && !(tombstone && existing.purgedAt)) throw conflict("IMPORT_ORDER_PURGED", "This order was deleted permanently on this installation.");
        if (existing.ownerUserId !== input.targetOwnerUserId) throw conflict("IMPORT_LINK_CONFLICT", "This source order was already imported for a different customer.");
        return { id: existing.id, publicId: existing.publicId, reference: existing.reference, created: false, receipts: { lineItems: [], statusHistory: [], customerNotes: [] } };
      }

      const owner = input.trash ? await trashedImportOwner(tx, input.targetOwnerUserId, tombstone) : await identityPort(deps.services).getUser(input.targetOwnerUserId, { tx, forUpdate: true });
      if (!owner || owner.role !== "customer" || owner.status === "deactivated")
        throw validation("IMPORT_OWNER_NOT_ELIGIBLE", "The mapped owner is not an eligible customer account.");

      const now = deps.clock.now();
      const workflow = await deps.workflows.ensureDefault(tx);
      const knownStatus = findState(workflow.definition, input.statusKey);
      // Never guess: an unknown source status refuses the import instead of silently mapping.
      if (!knownStatus) throw validation("IMPORT_STATUS_UNSUPPORTED", "The imported order status is not supported by this installation.");
      const statusKey = knownStatus.key;

      let reference: string | null = null;
      if (input.sourceReference) {
        try {
          const candidate = normalizeReference(input.sourceReference);
          if (!(await isReferenceReserved(tx, candidate))) reference = candidate;
        } catch {
          reference = null;
        }
      }
      // Increment 08 (D3): an addition joins an already-imported root of the same owner and currency.
      let groupRoot: typeof orders.$inferSelect | null = null;
      if (input.groupRootOrderId !== undefined && input.groupRootOrderId !== null) {
        const [root] = await tx.select().from(orders).where(eq(orders.id, input.groupRootOrderId)).for("update").limit(1);
        // Increment 09: a live addition needs a live root; a tombstone root takes only tombstone additions.
        const rootStateOk = !root ? false : root.purgedAt ? tombstone : isLiveOrderRow(root) || Boolean(input.trash);
        if (!root || !rootStateOk || root.groupRootOrderId !== null || root.ownerUserId !== owner.id || root.currency !== input.currency || root.origin !== "import")
          throw validation("IMPORT_GROUP_ROOT_INVALID", "The imported order's project root is not available.");
        groupRoot = root;
      }
      const referenceReason = reference ? "IMPORTED_SOURCE" : "IMPORTED_GENERATED";
      // Increment 08 (D2): imports keep their reference; only a missing or taken one falls back to the stem generator.
      let referenceStem: string | null;
      if (reference) {
        referenceStem = stemOfReference(reference);
        await noteStemReferenceUsed(tx, reference);
      } else {
        const parts = groupRoot?.referenceStem ? null : await namePartsInTx(deps.services, tx, owner.id);
        referenceStem =
          groupRoot?.referenceStem ??
          buildReferenceStem({
            prefix: await readSetting(deps.settings, ORDER_REFERENCE_PREFIX, tx),
            customerRef: parts!.customerRef,
            firstName: parts!.firstName,
            lastName: parts!.lastName,
            projectName: groupRoot?.projectName ?? input.projectName,
          });
        reference = await allocateStemReference(tx, referenceStem);
      }

      const publicId = ulid(now.getTime());
      const lockState = input.editable ? "none" : "imported_read_only";
      await tx.insert(orders).values({
        publicId,
        reference,
        referenceStem,
        groupRootOrderId: groupRoot?.id ?? null,
        ownerUserId: owner.id,
        projectName: tombstone ? TOMBSTONE_PROJECT_NAME : input.projectName,
        workflowVersionId: workflow.versionId,
        statusKey,
        lockState,
        lockReasonCode: input.editable ? null : "IMPORTED",
        lockedAt: input.editable ? null : now,
        subtotalMinor: input.subtotalMinor ?? input.totalMinor + (input.discountMinor ?? 0),
        discountMinor: input.discountMinor ?? 0,
        discountLabel: tombstone ? null : (input.discountLabel ?? null),
        promoDiscountMinor: input.promoDiscountMinor ?? 0,
        promoLabel: tombstone ? null : (input.promoLabel ?? null),
        totalMinor: input.totalMinor,
        currency: input.currency,
        origin: "import",
        createdByUserId: null,
        submittedAt: input.submittedAt ?? null,
        createdAt: input.createdAt,
        updatedAt: now,
        ...(input.trash
          ? {
              trashedAt: input.trash.trashedAt,
              trashedByUserId: null,
              trashBatchId: input.trash.batchId,
              trashReason: tombstone ? null : input.trash.reason,
              purgeStartedAt: input.trash.purgedAt,
              purgedAt: input.trash.purgedAt,
            }
          : {}),
      });
      const [order] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.publicId, publicId));
      const orderId = order!.id;
      await reserveReference(tx, { reference, orderId, reasonCode: referenceReason, actorUserId: null, now });

      const receipts: ImportReceipt["receipts"] = { lineItems: [], statusHistory: [], customerNotes: [] };
      // A tombstone carries no lines, history or notes (D2.6); the line items of a trashed order travel.
      const lineInputs = tombstone ? [] : input.lineItems;
      if (lineInputs.length) {
        const values = lineInputs.map((item, index) => {
          const id = ulid(now.getTime());
          receipts.lineItems.push({ sourcePublicId: item.sourcePublicId ?? null, publicId: id });
          return {
            publicId: id,
            orderId,
            productId: null,
            productVersionId: null,
            productPublicId: item.productPublicId && ULID_RE.test(item.productPublicId) ? item.productPublicId : null,
            productVersionNumber: item.productVersion,
            name: item.name,
            description: item.description,
            features: item.features,
            packetNumber: item.packetNumber ?? null,
            tier: item.tier ?? null,
            outcome: item.outcome ?? "",
            timeline: item.timeline ?? "",
            deliverables: item.deliverables ?? [],
            unitPriceMinor: item.unitPriceMinor,
            currency: item.currency,
            quantity: item.quantity,
            lineTotalMinor: item.lineTotalMinor,
            sortOrder: index,
            createdAt: input.createdAt,
          };
        });
        await tx.insert(orderLineItems).values(values);
      }
      // Historical evidence only — never replayed through the workflow engine.
      const history = tombstone ? [] : (input.statusHistory ?? []);
      if (history.length) {
        await tx.insert(orderStatusHistory).values(
          history.map((h) => {
            const id = ulid(now.getTime());
            receipts.statusHistory.push({ sourcePublicId: h.sourcePublicId ?? null, publicId: id });
            return {
              publicId: id,
              orderId,
              fromStatus: h.fromStatus?.slice(0, 48) ?? null,
              toStatus: h.toStatus.slice(0, 48),
              actorUserId: null,
              actorRole: "imported",
              reasonCode: "IMPORTED_HISTORY",
              noteId: null,
              occurredAt: h.occurredAt,
            };
          }),
        );
      }
      await tx.insert(orderStatusHistory).values({
        publicId: ulid(now.getTime()),
        orderId,
        fromStatus: null,
        toStatus: statusKey,
        actorUserId: null,
        actorRole: "system",
        reasonCode: knownStatus ? "IMPORTED" : "IMPORTED_STATUS_UNMAPPED",
        noteId: null,
        occurredAt: now,
      });
      for (const note of tombstone ? [] : (input.customerNotes ?? [])) {
        const id = ulid(now.getTime());
        receipts.customerNotes.push({ sourcePublicId: note.sourcePublicId ?? null, publicId: id });
        await tx.insert(orderNotes).values({
          publicId: id,
          orderId,
          authorUserId: null,
          authorRole: "imported",
          visibility: "customer",
          bodyEnc: deps.crypto.encrypt(note.body, `order_notes.body:${id}`),
          createdAt: note.createdAt,
        });
      }
      await tx.insert(orderImportProvenance).values({
        orderId,
        importId: input.importId,
        sourceInstallationId: input.sourceInstallationId,
        sourceOrderPublicId: input.sourceOrderPublicId,
        sourceReference: input.sourceReference ?? null,
        sourceStatusKey: input.statusKey,
        createdAt: now,
      });
      await deps.audit.record(
        {
          category: "portable_transfer",
          eventName: "order.imported",
          action: "import",
          outcome: "completed",
          importId: input.importId,
          resource: { type: "order", publicId },
          reasonCode: knownStatus ? undefined : "STATUS_UNMAPPED",
          attributes: { lock_state: lockState, reference_source: referenceReason, owner_public_id: owner.publicId, trash_state: tombstone ? "tombstone" : input.trash ? "trashed" : "live" },
          safeCounts: { line_items: lineInputs.length, history: history.length, notes: tombstone ? 0 : (input.customerNotes?.length ?? 0) },
        },
        tx,
      );
      return { id: orderId, publicId, reference, created: true, receipts };
    },
  };
}

export interface OrderCustody {
  id: number;
  publicId: string;
  reference: string;
  ownerUserId: number;
  ownerPublicId: string;
  trashed: boolean;
  purgeStarted: boolean;
  purged: boolean;
}

export type PortableHooks = ReturnType<typeof createPortableHooks>;
