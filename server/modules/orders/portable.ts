/**
 * Portable transfer hooks (export projection + transactional import adoption).
 * Import NEVER trusts archive-supplied identity: the target owner comes from the portable mapping and is
 * re-validated here; target public ids are freshly generated; no workflow, notification or mail is replayed.
 */
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { z } from "zod";
import { conflict, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { AuditEmitter, Clock, Db, DbOrTx, FieldCrypto, Logger, SettingsStore, Tx } from "../../core/types.js";
import type { Services } from "../../container.js";
import { readSetting } from "../platform/index.js";
import { assertCurrency } from "./catalog.js";
import { identityPort } from "./ports.js";
import { allocateReference, isReferenceReserved, normalizeReference, reserveReference } from "./references.js";
import {
  orderImportProvenance,
  orderLineItems,
  orderNotes,
  orderReferences,
  orders,
  orderStatusHistory,
  orderWorkflows,
  orderWorkflowVersions,
} from "./schema.js";
import { ORDER_REFERENCE_PREFIX } from "./settings.js";
import type { ImportOrderInput, PortableOrder, PortableSelection } from "./types.js";
import type { WorkflowService } from "./workflows.js";
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
  projectName: text(160, 1),
  statusKey: z.string().min(1).max(64),
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
  if (input.lineItems.length > 0 && sum !== input.totalMinor) return { ok: false, reasonCode: "IMPORT_TOTAL_MISMATCH", paths: ["totalMinor"] };
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

  return {
    findImportedOrder,

    /** Write-free: is this status key known to the current default workflow (or the built-in default if none is installed yet)? */
    async isPortableStatusSupported(statusKey: string, tx?: DbOrTx): Promise<boolean> {
      if (typeof statusKey !== "string" || statusKey.length === 0 || statusKey.length > 64) return false;
      const current = await deps.workflows.currentDefault(tx ?? deps.db);
      return findState(current ? current.definition : DEFAULT_WORKFLOW, statusKey) !== undefined;
    },

    preflightImportOrder,

    /** Bounded export projection (internal notes and grants are excluded — grants are authority, not data). */
    async portableOrders(tx: DbOrTx, selection: PortableSelection): Promise<{ items: PortableOrder[]; nextAfter: number | null }> {
      const limit = Math.min(Math.max(selection.limit, 1), 200);
      if (selection.customerIds?.length === 0 || selection.orderIds?.length === 0) return { items: [], nextAfter: null };
      const rows = await tx
        .select({ order: orders, workflowKey: orderWorkflows.workflowKey })
        .from(orders)
        .innerJoin(orderWorkflowVersions, eq(orderWorkflowVersions.id, orders.workflowVersionId))
        .innerJoin(orderWorkflows, eq(orderWorkflows.id, orderWorkflowVersions.workflowId))
        .where(
          and(
            selection.after !== undefined ? gt(orders.id, selection.after) : undefined,
            selection.customerIds ? inArray(orders.ownerUserId, selection.customerIds.slice(0, 1000)) : undefined,
            selection.orderIds ? inArray(orders.id, selection.orderIds.slice(0, 1000)) : undefined,
          ),
        )
        .orderBy(asc(orders.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const ids = page.map((r) => r.order.id);
      if (ids.length === 0) return { items: [], nextAfter: null };
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
          ownerUserId: order.ownerUserId,
          projectName: order.projectName,
          statusKey: order.statusKey,
          workflowKey,
          lockState: order.lockState,
          totalMinor: order.totalMinor,
          currency: order.currency,
          origin: order.origin,
          createdAt: order.createdAt,
          updatedAt: order.updatedAt,
          submittedAt: order.submittedAt,
          lineItems: items
            .filter((i) => i.orderId === order.id)
            .map((i) => ({
              publicId: i.publicId,
              productPublicId: i.productPublicId,
              productVersion: i.productVersionNumber,
              name: i.name,
              description: i.description,
              features: i.features,
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
      if (existing) {
        if (existing.ownerUserId !== input.targetOwnerUserId) throw conflict("IMPORT_LINK_CONFLICT", "This source order was already imported for a different customer.");
        return { id: existing.id, publicId: existing.publicId, reference: existing.reference, created: false, receipts: { lineItems: [], statusHistory: [], customerNotes: [] } };
      }

      const owner = await identityPort(deps.services).getUser(input.targetOwnerUserId, { tx, forUpdate: true });
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
      const referenceReason = reference ? "IMPORTED_SOURCE" : "IMPORTED_GENERATED";
      reference ??= await allocateReference(tx, await readSetting(deps.settings, ORDER_REFERENCE_PREFIX), now);

      const publicId = ulid(now.getTime());
      const lockState = input.editable ? "none" : "imported_read_only";
      await tx.insert(orders).values({
        publicId,
        reference,
        ownerUserId: owner.id,
        projectName: input.projectName,
        workflowVersionId: workflow.versionId,
        statusKey,
        lockState,
        lockReasonCode: input.editable ? null : "IMPORTED",
        lockedAt: input.editable ? null : now,
        totalMinor: input.totalMinor,
        currency: input.currency,
        origin: "import",
        createdByUserId: null,
        submittedAt: input.submittedAt ?? null,
        createdAt: input.createdAt,
        updatedAt: now,
      });
      const [order] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.publicId, publicId));
      const orderId = order!.id;
      await reserveReference(tx, { reference, orderId, reasonCode: referenceReason, actorUserId: null, now });

      const receipts: ImportReceipt["receipts"] = { lineItems: [], statusHistory: [], customerNotes: [] };
      if (input.lineItems.length) {
        const values = input.lineItems.map((item, index) => {
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
      const history = input.statusHistory ?? [];
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
      for (const note of input.customerNotes ?? []) {
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
          attributes: { lockState, referenceSource: referenceReason, ownerPublicId: owner.publicId },
          safeCounts: { lineItems: input.lineItems.length, history: history.length, notes: input.customerNotes?.length ?? 0 },
        },
        tx,
      );
      return { id: orderId, publicId, reference, created: true, receipts };
    },
  };
}

export type PortableHooks = ReturnType<typeof createPortableHooks>;
