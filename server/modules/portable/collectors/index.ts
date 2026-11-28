import { createPackageWriter, type RecordOf, type RecordType } from "../../../../portable/src/index.js";
import type { ModuleDeps } from "../../../container.js";
import type { SessionPrincipal } from "../../../core/types.js";
import { notFound, validation } from "../../../core/errors.js";
import type { PortableOrder } from "../../orders/index.js";
import type { PortableStoredFile } from "../../files/index.js";
import type { UserRole } from "../../../../shared/domain.js";
import { CustodyError } from "../custody.js";
import { PACKAGE_LIMITS, TRANSFER_MAX_OBJECTS, TRANSFER_MAX_RECORDS, type ExportSelection } from "../transferPolicy.js";

const ORDERS_PAGE = 100;
const MAX_METADATA = 16 * 1024 * 1024;
const PORTABLE_TIER = {
  Basic: "basic", Standard: "standard", Premium: "premium",
} as const satisfies Record<NonNullable<PortableOrder["lineItems"][number]["tier"]>, string>;
const time = (value: Date | null) => value?.toISOString() ?? null;
const actor = (role: string) => ({
  kind: (role === "admin" || role === "staff" || role === "customer" ? role : "system") as UserRole | "system",
  publicId: null,
});

/** Trash state as the source row holds it (orders and customers ports, increment 09). */
interface SourceTrash { trashedAt: Date; batchId: string | null; reason: string | null; purgeStartedAt: Date | null; purgedAt: Date | null }

/**
 * Increment 09: a row whose permanent deletion has started but not finished cannot travel (it is neither a trash
 * item nor a tombstone yet). The export refuses rather than guess; the operator retries after the purge.
 */
function portableTrash(trash: SourceTrash | null | undefined) {
  if (!trash) return null;
  if (trash.purgeStartedAt && !trash.purgedAt) {
    throw validation("PORTABLE_PURGE_IN_PROGRESS", "A permanent deletion is still running. Export again when it has finished.");
  }
  return {
    trashedAt: trash.trashedAt.toISOString(), batchId: trash.batchId, reason: trash.reason,
    purgeStartedAt: time(trash.purgeStartedAt), purgedAt: time(trash.purgedAt),
  };
}

/** Placeholder address a tombstone carries in a package; never a real mailbox (RFC 2606 `.invalid`). */
export const tombstoneEmail = (publicId: string) => `deleted-${publicId.toLowerCase()}@tombstone.invalid`;

interface WriteInput { exportId: string; workspace: string; path: string; passphrase: string; now: Date }

export async function collectAndWriteExport(
  deps: ModuleDeps, principal: SessionPrincipal, selection: ExportSelection, input: WriteInput,
) {
  const records = new Map<RecordType, RecordOf<RecordType>[]>();
  let recordCount = 0;
  let metadata = 0;
  const emit = <T extends RecordType>(type: T, record: RecordOf<T>) => {
    const items = records.get(type) ?? [];
    items.push(record);
    records.set(type, items);
    recordCount += 1;
    metadata += Buffer.byteLength(JSON.stringify(record));
    if (recordCount > TRANSFER_MAX_RECORDS || metadata > MAX_METADATA) {
      throw validation("PORTABLE_EXPORT_LIMIT", "The selected records exceed the transfer limit. Make a smaller selection.");
    }
  };

  // Increment 09: only a full installation export carries the trash and tombstones (so a migration keeps them);
  // selected exports read live rows only through the owners' gates.
  const all = selection.kind === "all";
  const snapshot = await deps.db.transaction(async (tx) => {
    const orders = new Map<number, { order: PortableOrder; ownerPublicId: string; tombstone: boolean }>();
    const customerPublicIds = new Set<string>();
    let rootCustomerIds: number[] | undefined;
    let rootOrderIds: number[] | undefined;
    if (selection.kind === "customers") {
      rootCustomerIds = [];
      for (const publicId of selection.ids) {
        const customer = await deps.services.identity.getUserByPublicId(publicId, { tx });
        if (!customer || customer.role !== "customer") throw notFound("PORTABLE_SELECTION_NOT_FOUND");
        rootCustomerIds.push(customer.id);
        customerPublicIds.add(customer.publicId);
      }
    } else if (selection.kind === "orders") {
      rootOrderIds = [];
      for (const publicId of selection.ids) {
        const order = await deps.services.orders.assertCanReadOrder(principal, publicId, { tx });
        rootOrderIds.push(order.id);
      }
    }
    // A selected order travels with its whole order group (the project's first order and every order added to it),
    // so group links always resolve inside the package.
    let groupRootIds: number[] | undefined;
    if (rootOrderIds) {
      const roots = new Set<number>();
      let after: number | undefined;
      do {
        const page = await deps.services.orders.portableOrders(tx, { after, limit: ORDERS_PAGE, orderIds: rootOrderIds });
        for (const order of page.items) roots.add(order.groupRootOrderId ?? order.id);
        if (page.nextAfter !== null && page.nextAfter === after) throw new CustodyError();
        after = page.nextAfter ?? undefined;
      } while (after !== undefined);
      groupRootIds = [...roots];
    }
    const customerByInternal = new Map<number, string>();
    let cursor: number | undefined;
    do {
      const { items, nextAfter } = await deps.services.orders.portableOrders(tx, {
        after: cursor, limit: ORDERS_PAGE, customerIds: rootCustomerIds, ...(groupRootIds ? { groupRootIds } : {}),
        ...(all ? { includeTrashed: true } : {}),
      });
      for (const order of items) {
        let ownerPublicId = customerByInternal.get(order.ownerUserId);
        if (!ownerPublicId) {
          // Ungated by internal id: the owner of a trashed order is itself in the trash (or a tombstone).
          const owner = await deps.services.identity.portableCustomerRefInTx(tx, { userId: order.ownerUserId });
          if (!owner || owner.role !== "customer") throw validation("PORTABLE_SOURCE_OWNER_MISMATCH", "An order has invalid source ownership.");
          ownerPublicId = owner.publicId;
          customerByInternal.set(owner.userId, ownerPublicId);
        }
        customerPublicIds.add(ownerPublicId);
        const trash = portableTrash(order.trash);
        const tombstone = Boolean(trash?.purgedAt);
        orders.set(order.id, { order, ownerPublicId, tombstone });
        emit("orders", {
          publicId: order.publicId, customerPublicId: ownerPublicId, orderNumber: order.reference,
          // Omitted for a root so packages without groups stay readable by increment 07 installations.
          ...(order.groupRootPublicId ? { groupRootOrderPublicId: order.groupRootPublicId } : {}),
          projectName: order.projectName, status: order.statusKey, paymentStatus: "unknown", paymentRequirement: null,
          currency: order.currency, subtotal: { amountMinor: order.subtotalMinor, currency: order.currency },
          discount: { amountMinor: order.discountMinor, currency: order.currency }, discountLabel: order.discountLabel,
          promoDiscount: { amountMinor: order.promoDiscountMinor, currency: order.currency }, promoLabel: order.promoLabel,
          total: { amountMinor: order.totalMinor, currency: order.currency },
          isTestOrder: false, lock: { readOnly: order.lockState !== "none", reasonCode: null },
          completionPercent: null, internalNotes: null, dueAt: null, deliveredAt: null, closedAt: null,
          createdAt: order.createdAt.toISOString(), updatedAt: order.updatedAt.toISOString(), submittedAt: time(order.submittedAt),
          heldUnknown: {
            sourceWorkflow: order.workflowKey,
            sourceLock: order.lockState,
            retiredOrderReferences: order.retiredReferences,
          },
          // Omitted for a live order so packages stay readable by increment 07 and 08 installations.
          ...(trash ? { trash } : {}),
        });
        // A tombstone holds only what a tombstone keeps: no lines, history or files.
        if (tombstone) continue;
        for (const [position, item] of order.lineItems.entries()) emit("order-items", {
          publicId: item.publicId, orderPublicId: order.publicId, position,
          sku: item.productPublicId ?? "historical-item", name: item.name, quantity: item.quantity,
          tier: item.tier === null ? null : PORTABLE_TIER[item.tier], packetNumber: item.packetNumber,
          outcome: item.outcome, timeline: item.timeline, deliverables: item.deliverables,
          unitPrice: { amountMinor: item.unitPriceMinor, currency: item.currency },
          lineTotal: { amountMinor: item.lineTotalMinor, currency: item.currency },
          heldUnknown: { description: item.description, features: item.features, sourceProductVersion: item.productVersion },
        });
        for (const item of order.statusHistory) emit("order-status-history", {
          publicId: item.publicId, orderPublicId: order.publicId, fromStatus: item.fromStatus, toStatus: item.toStatus,
          reasonCode: item.reasonCode || null, note: null, actor: actor(item.actorRole), occurredAt: item.occurredAt.toISOString(),
        });
      }
      if (nextAfter !== null && nextAfter === cursor) throw new CustodyError();
      cursor = nextAfter ?? undefined;
    } while (cursor !== undefined);
    if (rootOrderIds?.some((id) => !orders.has(id))) throw notFound("PORTABLE_SELECTION_NOT_FOUND");
    for (const { order } of orders.values()) {
      if (order.groupRootOrderId !== null && (!order.groupRootPublicId || !orders.has(order.groupRootOrderId))) throw new CustodyError();
    }

    async function enumerateCustomers(ids?: string[]) {
      let after: string | null = null;
      const expectedIds = ids ? new Set(ids) : undefined;
      for (;;) {
        const customers = await deps.services.identity.portableCustomers(tx, after, 100, ids, all ? { includeTrashed: true } : {});
        for (const item of customers) {
          expectedIds?.delete(item.publicId);
          const trash = portableTrash(item.trash);
          if (trash?.purgedAt) {
            // A tombstone keeps only its ids, dates and trash state: placeholder address and name, no parts or billing.
            emit("customers", {
              publicId: item.publicId, customerNumber: item.customerRef, status: "business-profile",
              email: tombstoneEmail(item.publicId), firstName: null, lastName: null, preferredName: "Deleted account",
              middleName: null, suffix: null, company: null, phone: null, address: null, timezone: null, locale: null,
              marketingOptIn: false, createdAt: item.createdAt.toISOString(), updatedAt: null, trash,
            });
            continue;
          }
          const billing = await deps.services.billingProfile.getForUserInTx(tx, item.userId);
          // Stored name parts travel as parts; otherwise the display name keeps its legacy place (preferredName).
          const parts = item.firstName && item.lastName
            ? { firstName: item.firstName, lastName: item.lastName, preferredName: item.preferredName }
            : { firstName: null, lastName: null, preferredName: item.name };
          emit("customers", {
            publicId: item.publicId, customerNumber: item.customerRef, status: "business-profile",
            email: item.email, ...parts, middleName: null,
            suffix: null, company: null, phone: null, address: null, timezone: null, locale: null,
            marketingOptIn: false, createdAt: item.createdAt.toISOString(), updatedAt: null,
            // Omitted when there is none so such packages stay readable by increment 07 installations.
            ...(billing ? { billingProfile: billing.details } : {}),
            ...(trash ? { trash } : {}),
          });
        }
        if (customers.length < 100) break;
        const next = customers.at(-1)?.publicId;
        if (!next || next === after) throw new CustodyError();
        after = next;
      }
      if (expectedIds?.size) throw validation("PORTABLE_SOURCE_OWNER_MISMATCH", "The selected orders are missing a portable customer profile.");
    }
    if (selection.kind === "all") await enumerateCustomers();
    else {
      const ids = [...customerPublicIds].sort();
      for (let batch = 0; batch < ids.length; batch += 100) await enumerateCustomers(ids.slice(batch, batch + 100));
    }

    const files: PortableStoredFile[] = [];
    const orderIds = [...orders.entries()].filter(([, entry]) => !entry.tombstone).map(([id]) => id);
    for (let batch = 0; batch < orderIds.length; batch += 250) {
      let after: string | undefined;
      do {
        const page = await deps.services.files.portableFiles(tx, {
          principal, after, limit: 100, orderIds: orderIds.slice(batch, batch + 250), ...(all ? { includeTrashedOrders: true } : {}),
        });
        for (const file of page.items) {
          const origin = orders.get(file.orderId);
          if (!origin || origin.tombstone || origin.ownerPublicId !== file.ownerPublicId || origin.order.publicId !== file.orderPublicId ||
            origin.order.ownerUserId !== file.ownerUserId) {
            throw validation("PORTABLE_SOURCE_OWNER_MISMATCH", "A source file is not bound to its selected order and owner.");
          }
          files.push(file);
          if (files.length > TRANSFER_MAX_OBJECTS) throw validation("PORTABLE_OBJECT_LIMIT", "The selection has too many file objects.");
          emit("files", {
            publicId: file.logicalPublicId, orderPublicId: file.orderPublicId, category: file.category,
            phase: null, visibleToCustomer: file.visibility === "customer_visible", createdAt: file.createdAt.toISOString(),
            deletedAt: null, ...(file.phasePublicId ? { heldUnknown: { originalPhase: file.phasePublicId } } : {}),
          });
          emit("file-versions", {
            publicId: file.publicId, filePublicId: file.logicalPublicId, version: file.version,
            originalName: file.displayName, mediaType: file.contentType, extension: file.extension,
            sizeBytes: file.size, sha256: file.sha256, durationSeconds: null, uploadedBy: actor("system"),
            createdAt: file.createdAt.toISOString(),
          });
        }
        if (page.nextCursor !== null && page.nextCursor === after) throw new CustodyError();
        after = page.nextCursor ?? undefined;
      } while (after !== undefined);
    }
    return { files, orders };
  // InnoDB opens the consistent read view at the first non-locking SELECT.
  // Drizzle 0.45 joins these transaction characteristics without MySQL's required comma.
  }, { isolationLevel: "repeatable read", accessMode: "read only" });

  const writer = await createPackageWriter({
    output: input.path, workDir: input.workspace, passphrase: input.passphrase, limits: PACKAGE_LIMITS,
    ...(deps.config.nodeEnv === "test" ? { kdf: { N: 1 << 14 } } : {}),
    manifest: {
      exportId: input.exportId, generatedAt: input.now.toISOString(),
      sourceSystem: { pseudonym: deps.crypto.pseudonym(deps.config.installationId, "portable.source").slice(0, 64) },
      sourceRelease: deps.config.releaseRef.slice(0, 64),
      snapshot: { kind: "repeatable-read", takenAt: input.now.toISOString(), identity: input.exportId },
      scope: {
        profile: selection.kind === "all" ? "all-core" : "complete-order-with-files",
        description: selection.kind === "all" ? "All portable customer and order records" : "Selected roots and portable dependencies",
        selection: selection.kind === "all" ? { mode: "dynamic-all" } : { mode: "fixed", count: selection.ids.length },
      },
      exclusions: [
        { category: "provider-runtime", reason: "Provider and workflow execution state are outside business transfer." },
        { category: "file-history", reason: "Only active current file versions are included in this export." },
        { category: "internal-order-notes", reason: "Internal order comments, access grants, and order task notes and waivers are not exported." },
        { category: "historical-evidence", reason: "Engagement, billing (invoices, payments and payment attempts including their booking source, payment receipts and receipt refund notes) and compliance collectors do not contribute to this export." },
        { category: "promotions", reason: "Promotion codes, batches and redemptions are live installation configuration and redeemable secrets; orders carry only the promo amount and label." },
        { category: "cart-upsell-offers", reason: "Cart upsell offers are installation sales configuration, not customer business records." },
        { category: "security-operations", reason: "Security incidents, their timelines and correlation state are installation security operations, not business records." },
        { category: "policy-notices", reason: "Policy notice and enforcement preferences, notices, recipients and actions are installation compliance operations." },
        { category: "report-definitions", reason: "Saved report definitions and the report run log are installation configuration and operational records." },
        { category: "ephemeral-access", reason: "ZIP archives, archive download tickets and audio playback grants are short-lived access artefacts." },
        { category: "phase-workspace", reason: "Phase questions, answers, administrator tasks, phase progress, phase runs and completion jobs, and derived order progress, attention and payment state, are workflow runtime." },
        { category: "trash-operations", reason: "Trash purge run records are installation operations; trash state travels on orders and customers." },
        { category: "operational-diagnostics", reason: "Operational alerts and rejected payment webhook diagnostics are installation operations." },
        { category: "installation-configuration", reason: "SSO role mappings and SAML certificates, the order status catalogue, managed storage file sync and automations are installation configuration." },
      ],
      limitations: ["Source file bytes are verified against the database snapshot, not read from an object-store snapshot.",
        "A business package is not a full-system backup. Passphrase custody does not authenticate the source organisation."],
    },
  });
  try {
    for (const [type, items] of records) for (const record of items) await writer.addRecord(type, record);
    const objectDigests = new Set<string>();
    let verifiedSourceBytes = 0;
    for (const file of snapshot.files) {
      verifiedSourceBytes += file.size;
      if (verifiedSourceBytes > PACKAGE_LIMITS.maxTotalUncompressed) {
        throw validation("PORTABLE_EXPORT_LIMIT", "The selected file bytes exceed the transfer limit. Make a smaller selection.");
      }
      // Ungated custody read; a selected export still refuses a trashed order, and no export reads a purge.
      const live = await deps.db.transaction((tx) => deps.services.orders.portableOrderCustodyInTx(tx, file.orderId));
      if (!live || live.purgeStarted || live.purged || (!all && live.trashed) || live.publicId !== file.orderPublicId ||
        live.ownerUserId !== file.ownerUserId) throw new CustodyError();
      const opened = await deps.services.files.openForExport(principal, file.publicId, file.orderPublicId, undefined,
        all ? { allowTrashedOrder: true } : undefined);
      if (opened.file.sha256 !== file.sha256 || opened.file.size !== file.size || opened.file.version !== file.version ||
        opened.file.supersededAt || opened.file.deletedAt || opened.file.visibility !== file.visibility) {
        opened.stream.destroy();
        throw new CustodyError();
      }
      // The writer verifies every source stream against its snapshot receipt, even when identical hashes deduplicate.
      await writer.addObject({ source: opened.stream, expectedSha256: file.sha256, expectedSize: file.size });
      objectDigests.add(file.sha256);
    }
    const finished = await writer.finalize();
    const counts = Object.fromEntries([...records.entries()].map(([type, items]) => [type.replaceAll("-", "_"), items.length]));
    return { ...finished, counts: { ...counts, objects: objectDigests.size } };
  } catch (error) {
    await writer.abort().catch(() => undefined);
    throw error;
  }
}
