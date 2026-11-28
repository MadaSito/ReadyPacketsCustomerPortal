import { createHash } from "node:crypto";
import { and, asc, count, eq, isNotNull } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import { DomainError, conflict } from "../../core/errors.js";
import type { JobResult, SessionPrincipal, Tx } from "../../core/types.js";
import { CustodyError, decryptEscrow, digest, matchBytes, readExactObject } from "./custody.js";
import { type ImportJob, type ImportRow, lockImport, readImport, transition } from "./importLedger.js";
import { computePlanDigest, groupChildren, type JsonRecord, mappedRecord } from "./importPlanning.js";
import {
  customerBillingProfile, customerCreatedAt, customerIdentity, fileCategory, groupRootOf, numberField, projectedOrder, stringField,
  targetDate, trashOf,
} from "./importShapes.js";
import {
  portableImportObjects, portableImportRecords, portableMappings, portablePackageReservations,
  type ReconciliationReport,
} from "./schema.js";
import { TRANSFER_MAX_OBJECTS, TRANSFER_MAX_RECORDS, TRANSFER_STEP_UP_MS } from "./transferPolicy.js";

type SealedRow = typeof portableImportRecords.$inferSelect;
type DecodedRow = SealedRow & { record: JsonRecord };
type ObjectRow = typeof portableImportObjects.$inferSelect;
type Mapping = typeof portableMappings.$inferSelect;
type LocalRef = { id?: number | null; publicId?: string | null };

const PREPARED = new Set(["objects-prepared", "records-committed", "finalized", "reconciled", "accepted"]);

function proof(row: ImportRow) {
  if (!row.inputSha256 || !row.inputSize || !row.planDigest || !row.packageId || !row.manifestSha256 ||
    !row.sourceSystem || !row.encryptedEscrowKey || !row.approverPublicId || !row.approverSessionId ||
    !row.approvalStepUpAt || !row.approvedBy || !row.plan) throw new CustodyError();
  return {
    inputSha256: row.inputSha256, inputSize: row.inputSize, planDigest: row.planDigest, packageId: row.packageId,
    manifestSha256: row.manifestSha256, sourceSystem: row.sourceSystem, installationId: row.installationId,
    encryptedEscrowKey: row.encryptedEscrowKey, approverPublicId: row.approverPublicId,
    approverSessionId: row.approverSessionId, approvalStepUpAt: row.approvalStepUpAt, approvedBy: row.approvedBy,
    plan: row.plan,
  };
}

export function createImportWorker(deps: ModuleDeps) {
  async function authorizeWorker(tx: Tx, initial: ImportRow): Promise<SessionPrincipal> {
    const expected = proof(initial);
    const refused = () => new DomainError("FORBIDDEN", "PORTABLE_APPROVAL_NO_LONGER_CURRENT", "The import approval is no longer current.");
    const age = deps.clock.now().getTime() - expected.approvalStepUpAt.getTime();
    if (age < 0 || age > TRANSFER_STEP_UP_MS) throw refused();
    let principal: SessionPrincipal;
    try {
      principal = await deps.services.identity.sessions.principalForJob(expected.approverSessionId, expected.approvedBy, { tx });
    } catch (error) {
      if (error instanceof DomainError && ["SESSION_NOT_CURRENT", "ACCOUNT_STEP_PENDING"].includes(error.reasonCode)) throw refused();
      throw error;
    }
    if (principal.userPublicId !== expected.approverPublicId || principal.role !== "admin" || !principal.mfaVerifiedAt ||
      !principal.stepUpAt || principal.stepUpAt < expected.approvalStepUpAt) throw refused();
    return principal;
  }

  async function fenced<T>(job: ImportJob, initial: ImportRow, fn: (tx: Tx, row: ImportRow, principal: SessionPrincipal) => Promise<T>) {
    return deps.db.transaction(async (tx) => {
      await job.assertStillOwned(tx);
      const principal = await authorizeWorker(tx, initial);
      const row = await lockImport(tx, initial.publicId);
      const expected = proof(row);
      if (row.planDigest !== initial.planDigest || row.inputSha256 !== initial.inputSha256 ||
        row.installationId !== deps.config.installationId) throw new CustodyError();
      const [reservation] = await tx.select().from(portablePackageReservations)
        .where(eq(portablePackageReservations.packageId, expected.packageId)).limit(1).for("update");
      if (!reservation || reservation.importId !== row.id || reservation.manifestSha256 !== expected.manifestSha256) {
        throw new CustodyError();
      }
      return fn(tx, row, principal);
    });
  }

  async function readMapping(tx: Tx, row: ImportRow, type: string, publicId: string): Promise<Mapping | undefined> {
    const [mapping] = await tx.select().from(portableMappings).where(mappedRecord(proof(row).packageId, type, publicId)).limit(1);
    return mapping;
  }

  async function receipt(tx: Tx, row: ImportRow, job: ImportJob, entry: DecodedRow, local: LocalRef = {}) {
    const existed = await readMapping(tx, row, entry.recordType, entry.portableId);
    if (existed) {
      if (entry.disposition !== "link" || existed.sourceDigest !== entry.digest) throw new CustodyError();
    } else {
      if (entry.disposition === "link" || entry.disposition === "conflict") throw new CustodyError();
      await tx.insert(portableMappings).values({
        packageId: proof(row).packageId, sourcePortableId: entry.portableId, recordType: entry.recordType,
        sourceDigest: entry.digest, localId: local.id, localPublicId: local.publicId, originalImportId: row.id,
        createdAt: deps.clock.now(),
      });
    }
    await tx.update(portableImportRecords).set({ receiptAt: deps.clock.now() }).where(eq(portableImportRecords.id, entry.id));
    await deps.audit.record({
      category: "portable_transfer", eventName: "portable.import.record", action: "import", outcome: "completed",
      actor: { role: "system" }, jobId: job.jobId, importId: row.publicId, packageId: row.packageId ?? undefined,
      correlationId: row.publicId, resource: { type: "portable_import", publicId: row.publicId },
      attributes: { disposition: entry.disposition, record_type: entry.recordType },
    }, tx);
  }

  async function prepareObject(tx: Tx, row: ImportRow, object: ObjectRow) {
    if (!object.escrowCipherDigest) throw new CustodyError();
    const expected = proof(row);
    const prior = await deps.storage.stat(object.preparedKey);
    if (prior) {
      matchBytes(prior, object);
    } else {
      const source = await deps.storage.get(object.escrowKey);
      const stream = decryptEscrow(source as AsyncIterable<Buffer>, deps.crypto, expected.encryptedEscrowKey, row.publicId,
        { ...object, ciphertextSha256: object.escrowCipherDigest });
      const stored = await deps.storage.put(object.preparedKey, stream, { maxBytes: object.size });
      matchBytes(stored, object);
    }
    if (!object.preparedAt) {
      await tx.update(portableImportObjects).set({ preparedAt: deps.clock.now() }).where(eq(portableImportObjects.id, object.id));
    }
  }

  async function worker(job: ImportJob): Promise<JobResult> {
    const initial = await readImport(deps, job.payload.importId);
    if (initial.phase === "reconciled" || initial.phase === "accepted") {
      return { outcome: "completed", safeCounts: initial.reconciliation ? { ...initial.reconciliation } : undefined };
    }
    if (initial.phase === "held-unknown") return { outcome: "unknown", reasonCode: initial.reasonCode ?? "PORTABLE_HELD" };
    if (initial.phase === "failed" || initial.phase === "canceled") {
      return { outcome: "failed", reasonCode: initial.reasonCode ?? "PORTABLE_NOT_EXECUTABLE", retryable: false };
    }
    if (initial.phase !== "approved" && !PREPARED.has(initial.phase)) {
      return { outcome: "failed", reasonCode: "PORTABLE_NOT_APPROVED", retryable: false };
    }
    try {
      const expected = proof(initial);
      await job.assertStillOwned();
      await readExactObject(deps.storage, { key: initial.storageKey, sha256: expected.inputSha256, size: expected.inputSize });
      const metadata = await deps.db.select().from(portableImportRecords).where(eq(portableImportRecords.importId, initial.id))
        .orderBy(asc(portableImportRecords.position)).limit(TRANSFER_MAX_RECORDS + 1);
      const objects = await deps.db.select().from(portableImportObjects).where(eq(portableImportObjects.importId, initial.id))
        .orderBy(asc(portableImportObjects.sha256)).limit(TRANSFER_MAX_OBJECTS + 1);
      if (metadata.length > TRANSFER_MAX_RECORDS || objects.length > TRANSFER_MAX_OBJECTS ||
        computePlanDigest({ ...expected, records: metadata.map((record) => ({ ...record, type: record.recordType })), objects }) !== expected.planDigest) {
        throw new CustodyError();
      }
      const data: DecodedRow[] = metadata.map((entry) => {
        const plaintext = deps.crypto.decrypt(entry.encryptedPayload, `portable.record:${initial.publicId}:${entry.position}:${entry.digest}`);
        const record: unknown = JSON.parse(plaintext);
        if (digest(plaintext) !== entry.digest || !record || typeof record !== "object" || !("publicId" in record) ||
          record.publicId !== entry.portableId) throw new CustodyError();
        return { ...entry, record: record as JsonRecord };
      });
      const ref = new Map(data.map((entry) => [`${entry.recordType}:${entry.portableId}`, entry]));
      const objectsByDigest = new Map(objects.map((entry) => [entry.sha256, entry]));
      const groups = data.map((entry) => ({ type: entry.recordType, record: entry.record }));
      const items = groupChildren(groups, "order-items");
      const history = groupChildren(groups, "order-status-history");
      // Group roots are written before the orders added to them (and before those orders' files), whatever the
      // package order. Planning has already refused chains, self-links and roots outside the package.
      const additions = new Set(data.filter((entry) => entry.recordType === "orders" && groupRootOf(entry.record) !== null)
        .map((entry) => entry.portableId));
      const late = (entry: DecodedRow) => entry.recordType === "orders" ? additions.has(entry.portableId)
        : entry.recordType === "file-versions" &&
          additions.has(String(ref.get(`files:${stringField(entry.record.filePublicId)}`)?.record.orderPublicId));
      const applyOrder = [...data.filter((entry) => !late(entry)), ...data.filter(late)];

      if (initial.phase === "approved") {
        for (const object of objects) {
          job.signal.throwIfAborted();
          await fenced(job, initial, async (tx, row) => {
            if (row.phase !== "approved") return;
            await prepareObject(tx, row, object);
          });
        }
        await fenced(job, initial, async (tx, row) => {
          if (row.phase === "approved") await transition(deps, tx, row, "objects-prepared", { job });
        });
      }

      if (initial.phase === "approved" || initial.phase === "objects-prepared") {
        for (const entry of applyOrder) {
          if (entry.receiptAt || (entry.disposition === "create" &&
            ["order-items", "order-status-history", "files"].includes(entry.recordType))) continue;
          job.signal.throwIfAborted();
          await fenced(job, initial, async (tx, row, principal) => {
            if (row.phase !== "objects-prepared") return;
            const [current] = await tx.select().from(portableImportRecords).where(eq(portableImportRecords.id, entry.id)).limit(1).for("update");
            if (!current || current.digest !== entry.digest) throw new CustodyError();
            if (current.receiptAt) return;
            if (entry.disposition === "link" || entry.disposition === "hold") {
              await receipt(tx, row, job, entry);
            } else if (entry.recordType === "customers") {
              const customer = await deps.services.identity.createPendingCustomer({
                email: stringField(entry.record.email), ...customerIdentity(entry.record), publicId: entry.portableId,
                createdAt: customerCreatedAt(entry.record.createdAt),
                customerRef: typeof entry.record.customerNumber === "string" ? entry.record.customerNumber : null,
                // Increment 09: a trashed account stays in the trash; a tombstone stays a tombstone (identity's placeholder).
                trash: trashOf(entry.record),
              }, { tx });
              const billing = customerBillingProfile(entry.record);
              if (billing && !trashOf(entry.record)?.purgedAt) {
                await deps.services.billingProfile.saveForUserInTx(tx, customer.userId, billing,
                  { userId: null, role: "system", via: "portable_import" });
              }
              await receipt(tx, row, job, entry, { id: customer.userId, publicId: customer.publicId });
            } else if (entry.recordType === "orders") {
              const customer = await readMapping(tx, row, "customers", stringField(entry.record.customerPublicId));
              if (!customer?.localId) throw new CustodyError();
              const orderItems = items.get(entry.portableId) ?? [];
              const orderHistory = history.get(entry.portableId) ?? [];
              const fields = projectedOrder(entry.record, orderItems, orderHistory);
              const rootPortableId = groupRootOf(entry.record);
              const root = rootPortableId ? await readMapping(tx, row, "orders", rootPortableId) : undefined;
              if (rootPortableId && !root?.localId) throw new CustodyError();
              const imported = await deps.services.orders.importOrder({
                ...fields, importId: row.publicId, sourceInstallationId: expected.sourceSystem, sourceOrderPublicId: entry.portableId,
                targetOwnerUserId: customer.localId, editable: false, groupRootOrderId: root?.localId ?? null,
                trash: trashOf(entry.record),
              }, tx);
              if (!imported.created) throw conflict("PORTABLE_ORDER_PROVENANCE_COLLISION", "The target order has changed since planning.");
              await receipt(tx, row, job, entry, imported);
              for (const [type, children, receipts] of [
                ["order-items", orderItems, imported.receipts.lineItems],
                ["order-status-history", orderHistory, imported.receipts.statusHistory],
              ] as const) {
                if (children.length !== receipts.length) throw new CustodyError();
                const targetRefs = new Map(receipts.map((item) => [item.sourcePublicId, item.publicId]));
                for (const item of children) {
                  const child = ref.get(`${type}:${item.publicId}`);
                  const publicId = targetRefs.get(item.publicId);
                  if (!child || !publicId || child.disposition !== "create") throw new CustodyError();
                  await receipt(tx, row, job, child, { publicId });
                }
              }
            } else if (entry.recordType === "file-versions") {
              const file = ref.get(`files:${stringField(entry.record.filePublicId)}`);
              const object = objectsByDigest.get(stringField(entry.record.sha256));
              if (!file || !object || object.size !== numberField(entry.record, "sizeBytes") ||
                !entry.destinationKey || !entry.adoptionKey) throw new CustodyError();
              const order = await readMapping(tx, row, "orders", stringField(file.record.orderPublicId));
              if (!order?.localId || !order.localPublicId) throw new CustodyError();
              // Ungated custody read (the order may be in the trash); a purge-started or purged order never takes a file.
              const targetOrder = await deps.services.orders.portableOrderCustodyInTx(tx, order.localId, { forUpdate: true });
              const importedOrder = await deps.services.orders.findImportedOrder(expected.sourceSystem, stringField(file.record.orderPublicId), tx);
              if (!targetOrder || targetOrder.purgeStarted || targetOrder.purged || targetOrder.publicId !== order.localPublicId ||
                importedOrder?.id !== order.localId || importedOrder.lockState !== "imported_read_only") throw new CustodyError();
              const prior = await deps.storage.stat(entry.destinationKey);
              let staging = await deps.storage.stat(entry.adoptionKey);
              if (prior) {
                // This exact reserved operation has no committed receipt (locked above). Do not guess from a timeout.
                if (staging || await readMapping(tx, row, "file-versions", entry.portableId)) throw new CustodyError();
                matchBytes(prior, object);
                await deps.storage.move(entry.destinationKey, entry.adoptionKey);
                staging = { ...prior, key: entry.adoptionKey };
              }
              if (!staging) {
                staging = await deps.storage.put(entry.adoptionKey, await deps.storage.get(object.preparedKey), { maxBytes: object.size });
              }
              matchBytes(staging, object);
              const adopted = await deps.services.files.adoptVerifiedObject({
                principal, orderId: order.localId, orderPublicId: order.localPublicId, ownerUserId: targetOrder.ownerUserId,
                displayName: stringField(entry.record.originalName), category: fileCategory(file.record.category),
                contentType: stringField(entry.record.mediaType), stagedObject: staging, destinationKey: entry.destinationKey,
                visibility: file.record.visibleToCustomer === true ? "customer_visible" : "staff_only",
                createdAt: targetDate(entry.record.createdAt), allowTrashedOrder: true,
              }, tx);
              await receipt(tx, row, job, file, { publicId: adopted.logicalPublicId });
              await receipt(tx, row, job, entry, { publicId: adopted.publicId });
            } else {
              throw new CustodyError();
            }
          });
        }
        await fenced(job, initial, async (tx, row) => {
          if (row.phase !== "objects-prepared") return;
          const [actual] = await tx.select({ total: count() }).from(portableImportRecords)
            .where(and(eq(portableImportRecords.importId, row.id), isNotNull(portableImportRecords.receiptAt)));
          if (actual?.total !== data.length) throw new CustodyError();
          await transition(deps, tx, row, "records-committed", { job });
        });
      }

      await fenced(job, initial, async (tx, row) => {
        if (row.phase === "records-committed") await transition(deps, tx, row, "finalized", { job });
      });
      const report: ReconciliationReport = {
        inventory: data.length, imported: 0, linked: 0, heldUnknown: 0, objects: objects.length,
        verifiedObjects: 0, discrepancies: 0,
      };
      for (const object of objects) {
        job.signal.throwIfAborted();
        const actual = await deps.storage.stat(object.preparedKey);
        if (actual && actual.size === object.size && actual.sha256 === object.sha256) report.verifiedObjects += 1;
        else report.discrepancies += 1;
      }
      for (const entry of data) {
        job.signal.throwIfAborted();
        const checked = await fenced(job, initial, async (tx, row, principal) => {
          const mapping = await readMapping(tx, row, entry.recordType, entry.portableId);
          if (!mapping || mapping.sourceDigest !== entry.digest) return false;
          if (entry.disposition === "hold" || !mapping.localPublicId) return mapping.localPublicId === null && entry.disposition !== "create";
          if (entry.recordType === "customers") {
            const sourceTrash = trashOf(entry.record);
            if (sourceTrash) {
              // Ungated by public id (never by e-mail): the account must carry the same trash state.
              const ref = await deps.services.identity.portableCustomerRefInTx(tx, { publicId: mapping.localPublicId });
              return ref?.role === "customer" && ref.userId === mapping.localId && (sourceTrash.purgedAt ? ref.purged : ref.trashed && !ref.purged && ref.purgeStartedAt === null);
            }
            const user = await deps.services.identity.getUserByPublicId(mapping.localPublicId, { tx });
            const sourceDate = customerCreatedAt(entry.record.createdAt);
            if (entry.disposition === "create" && customerBillingProfile(entry.record) && user?.id === mapping.localId &&
              !await deps.services.billingProfile.getForUserInTx(tx, user.id)) return false;
            return user?.role === "customer" && user.id === mapping.localId &&
              (!sourceDate || user.createdAt.getTime() === sourceDate.getTime());
          }
          if (entry.recordType === "orders") {
            const customer = await readMapping(tx, row, "customers", stringField(entry.record.customerPublicId));
            const order = await deps.services.orders.findImportedOrder(expected.sourceSystem, entry.portableId, tx);
            const source = projectedOrder(entry.record, items.get(entry.portableId) ?? [], history.get(entry.portableId) ?? []);
            const rootPortableId = groupRootOf(entry.record);
            const root = rootPortableId ? await readMapping(tx, row, "orders", rootPortableId) : undefined;
            if ((order?.groupRootOrderId ?? null) !== (rootPortableId ? root?.localId ?? -1 : null)) return false;
            const sourceTrash = trashOf(entry.record);
            if (Boolean(order?.purgedAt) !== Boolean(sourceTrash?.purgedAt) ||
              (!sourceTrash?.purgedAt && Boolean(order?.trashedAt) !== Boolean(sourceTrash))) return false;
            return Boolean(order && order.id === mapping.localId && order.publicId === mapping.localPublicId &&
              order.ownerUserId === customer?.localId && order.lockState === "imported_read_only" &&
              order.createdAt.getTime() === source.createdAt.getTime() && order.currency === source.currency &&
              order.totalMinor === source.totalMinor && (order.submittedAt?.getTime() ?? null) === (source.submittedAt?.getTime() ?? null));
          }
          if (entry.recordType === "file-versions") {
            const file = ref.get(`files:${stringField(entry.record.filePublicId)}`);
            const order = file ? await readMapping(tx, row, "orders", stringField(file.record.orderPublicId)) : null;
            if (!order?.localPublicId) return false;
            const opened = await deps.services.files.openForExport(principal, mapping.localPublicId, order.localPublicId, tx,
              { allowTrashedOrder: true });
            const visible = opened.file.visibility === "customer_visible";
            if (opened.file.deletedAt || opened.file.supersededAt || visible !== file?.record.visibleToCustomer ||
              opened.file.createdAt.getTime() !== targetDate(entry.record.createdAt).getTime()) {
              opened.stream.destroy();
              return false;
            }
            return opened.stream;
          }
          return true;
        });
        let result: boolean;
        if (typeof checked === "boolean") {
          result = checked;
        } else {
          // Hash outside the SQL transaction; final reconciliation still commits under a fresh fence.
          const hash = createHash("sha256");
          const expectedSize = numberField(entry.record, "sizeBytes");
          let size = 0;
          for await (const chunk of checked as AsyncIterable<Buffer>) {
            job.signal.throwIfAborted();
            size += chunk.length;
            if (size > expectedSize) throw new CustodyError();
            hash.update(chunk);
          }
          result = size === expectedSize && hash.digest("hex") === entry.record.sha256;
        }
        if (!result) report.discrepancies += 1;
        if (entry.disposition === "link") report.linked += 1;
        if (entry.disposition === "create") report.imported += 1;
        if (entry.disposition === "hold" || entry.record.heldUnknown) report.heldUnknown += 1;
      }

      await fenced(job, initial, async (tx, row) => {
        if (row.phase !== "finalized") return;
        const next = await transition(deps, tx, row, "reconciled", { job }, { reconciliation: report });
        if (report.discrepancies) {
          await transition(deps, tx, next, "held-unknown", { job, reasonCode: "PORTABLE_RECONCILIATION_DISCREPANCY" });
        } else {
          await tx.update(portablePackageReservations).set({ importId: null })
            .where(eq(portablePackageReservations.packageId, expected.packageId));
        }
      });
      return report.discrepancies
        ? { outcome: "unknown", reasonCode: "PORTABLE_RECONCILIATION_DISCREPANCY" }
        : { outcome: "completed", safeCounts: { ...report } };
    } catch (error) {
      if (!(error instanceof CustodyError) && (!(error instanceof DomainError) ||
        !["VALIDATION", "CONFLICT", "FORBIDDEN", "NOT_FOUND"].includes(error.code))) throw error;
      return deps.db.transaction(async (tx): Promise<JobResult> => {
        await job.assertStillOwned(tx);
        const row = await lockImport(tx, initial.publicId);
        if (row.phase === "failed") return { outcome: "failed", reasonCode: row.reasonCode ?? "PORTABLE_APPLY_REFUSED", retryable: false };
        if (row.phase === "held-unknown") return { outcome: "unknown", reasonCode: row.reasonCode ?? "PORTABLE_HELD" };
        const [existing] = await tx.select({ total: count() }).from(portableImportRecords)
          .where(and(eq(portableImportRecords.importId, row.id), isNotNull(portableImportRecords.receiptAt)));
        const held = error instanceof CustodyError || Boolean(existing?.total);
        const reasonCode = held ? "PORTABLE_APPLY_HELD" : "PORTABLE_APPLY_REFUSED";
        await transition(deps, tx, row, held ? "held-unknown" : "failed", { job, reasonCode, state: held ? "unknown" : "refused" });
        if (!held && row.packageId) {
          await tx.update(portablePackageReservations).set({ importId: null })
            .where(eq(portablePackageReservations.packageId, row.packageId));
        }
        return held ? { outcome: "unknown", reasonCode } : { outcome: "failed", reasonCode, retryable: false };
      });
    }
  }
  return worker;
}
