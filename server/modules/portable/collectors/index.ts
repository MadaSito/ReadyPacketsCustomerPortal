import { createPackageWriter, type RecordOf, type RecordType } from "../../../../portable/src/index.js";
import type { ModuleDeps } from "../../../container.js";
import type { SessionPrincipal } from "../../../core/types.js";
import { notFound, validation } from "../../../core/errors.js";
import type { PortableOrder } from "../../orders/index.js";
import type { PortableStoredFile } from "../../files/index.js";
import { CustodyError, readExactObject } from "../custody.js";
import { PACKAGE_LIMITS, TRANSFER_MAX_OBJECTS, TRANSFER_MAX_RECORDS, type ExportSelection } from "../transferPolicy.js";

const ORDERS_PAGE = 100;
const MAX_METADATA = 16 * 1024 * 1024;
const time = (value: Date | null) => value?.toISOString() ?? null;
const actor = (role: string) => ({
  kind: role === "admin" || role === "staff" || role === "customer" ? role : "system" as const,
  publicId: null,
});

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

  const snapshot = await deps.db.transaction(async (tx) => {
    const orders = new Map<number, { order: PortableOrder; ownerPublicId: string }>();
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
    const customerByInternal = new Map<number, string>();
    let cursor: number | undefined;
    do {
      const { items, nextAfter } = await deps.services.orders.portableOrders(tx, {
        after: cursor, limit: ORDERS_PAGE, orderIds: rootOrderIds, customerIds: rootCustomerIds,
      });
      for (const order of items) {
        let ownerPublicId = customerByInternal.get(order.ownerUserId);
        if (!ownerPublicId) {
          const owner = await deps.services.identity.getUser(order.ownerUserId, { tx });
          if (!owner || owner.role !== "customer") throw validation("PORTABLE_SOURCE_OWNER_MISMATCH", "An order has invalid source ownership.");
          ownerPublicId = owner.publicId;
          customerByInternal.set(owner.id, ownerPublicId);
        }
        customerPublicIds.add(ownerPublicId);
        orders.set(order.id, { order, ownerPublicId });
        emit("orders", {
          publicId: order.publicId, customerPublicId: ownerPublicId, orderNumber: order.reference,
          projectName: order.projectName, status: order.statusKey, paymentStatus: "unknown", paymentRequirement: null,
          currency: order.currency, subtotal: { amountMinor: order.totalMinor, currency: order.currency },
          discount: { amountMinor: 0, currency: order.currency }, total: { amountMinor: order.totalMinor, currency: order.currency },
          isTestOrder: false, lock: { readOnly: order.lockState !== "none", reasonCode: null },
          completionPercent: null, internalNotes: null, dueAt: null, deliveredAt: null, closedAt: null,
          createdAt: order.createdAt.toISOString(), updatedAt: order.updatedAt.toISOString(),
          heldUnknown: {
            sourceWorkflow: order.workflowKey,
            sourceLock: order.lockState,
            sourceSubmittedAt: time(order.submittedAt),
            retiredOrderReferences: order.retiredReferences,
          },
        });
        for (const [position, item] of order.lineItems.entries()) emit("order-items", {
          publicId: item.publicId, orderPublicId: order.publicId, position,
          sku: item.productPublicId ?? "historical-item", name: item.name, tier: null, quantity: item.quantity,
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
    if (rootOrderIds && orders.size !== rootOrderIds.length) throw notFound("PORTABLE_SELECTION_NOT_FOUND");

    async function enumerateCustomers(ids?: string[]) {
      let after: string | null = null;
      const expectedIds = ids ? new Set(ids) : undefined;
      for (;;) {
        const customers = await deps.services.identity.portableCustomers(tx, after, 100, ids);
        for (const item of customers) {
          expectedIds?.delete(item.publicId);
          emit("customers", {
            publicId: item.publicId, customerNumber: item.customerRef, status: "business-profile",
            email: item.email, firstName: null, middleName: null, lastName: null, preferredName: item.name,
            suffix: null, company: null, phone: null, address: null, timezone: null, locale: null,
            marketingOptIn: false, createdAt: item.createdAt.toISOString(), updatedAt: null,
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
    const orderIds = [...orders.keys()];
    for (let batch = 0; batch < orderIds.length; batch += 250) {
      let after: string | undefined;
      do {
        const page = await deps.services.files.portableFiles(tx, {
          principal, after, limit: 100, orderIds: orderIds.slice(batch, batch + 250),
        });
        for (const file of page.items) {
          const origin = orders.get(file.orderId);
          if (!origin || origin.ownerPublicId !== file.ownerPublicId || origin.order.publicId !== file.orderPublicId ||
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
  }, { isolationLevel: "repeatable read", accessMode: "read only", withConsistentSnapshot: true });

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
        { category: "internal-order-notes", reason: "Internal order comments and access grants are not exported." },
        { category: "historical-evidence", reason: "Engagement, billing and compliance collectors do not contribute to this export." },
      ],
      limitations: ["Source file bytes are verified against the database snapshot, not read from an object-store snapshot.",
        "A business package is not a full-system backup. Passphrase custody does not authenticate the source organisation."],
    },
  });
  try {
    for (const [type, items] of records) for (const record of items) await writer.addRecord(type, record);
    const objectDigests = new Set<string>();
    for (const file of snapshot.files) {
      const live = await deps.services.orders.assertCanReadOrder(principal, file.orderPublicId);
      if (live.ownerUserId !== file.ownerUserId || live.ownerPublicId !== file.ownerPublicId) throw new CustodyError();
      if (objectDigests.has(file.sha256)) {
        // Even content already represented by another object's digest must be checked against this file's exact source bytes.
        await readExactObject(deps.storage, { key: file.storageKey, sha256: file.sha256, size: file.size });
      } else {
        const opened = await deps.services.files.openForExport(principal, file.publicId, file.orderPublicId);
        if (opened.file.sha256 !== file.sha256 || opened.file.size !== file.size) { opened.stream.destroy(); throw new CustodyError(); }
        await writer.addObject({ source: opened.stream, expectedSha256: file.sha256, expectedSize: file.size });
        objectDigests.add(file.sha256);
      }
    }
    const finished = await writer.finalize();
    const counts = Object.fromEntries([...records.entries()].map(([type, items]) => [type.replaceAll("-", "_"), items.length]));
    return { ...finished, counts: { ...counts, objects: objectDigests.size } };
  } catch (error) {
    await writer.abort().catch(() => undefined);
    throw error;
  }
}
