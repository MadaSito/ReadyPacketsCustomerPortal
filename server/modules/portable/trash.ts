/**
 * Portable trash participant (Increment 09, D2.5/D2.6). A completed import keeps, per package, the sealed source
 * records (encrypted, readable by this installation) and the escrowed and prepared copies of imported file bytes.
 * Permanently deleting an imported customer or order erases this module's copies of that entity:
 *  - staged objects (escrow + prepared) of its file versions, unless another non-erased file version of the same
 *    import still needs the same bytes; deletion is verified (object absent afterwards) or the run fails;
 *  - its sealed records (the entity itself and every record that belongs to it: an order's items, history,
 *    shares, files, versions, threads, tickets, submissions, financial evidence; a customer's orders and the
 *    records under them) are replaced by a fixed redaction marker.
 * Mappings stay as id-only receipts (bundle ids and local ids, no personal data). The uploaded package itself is
 * sealed with a passphrase this installation never keeps, so it is not readable here and is reported as kept.
 * Idempotent and resumable: objects are erased before the records that name them, so a crash never loses the
 * digest needed to finish. Imports still executing make the run fail (retried later on the same targets).
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import { conflict } from "../../core/errors.js";
import { RECORD_TYPE_ORDER, referencesOf, type RecordType } from "../../../portable/src/index.js";
import type { TrashEntityRef, TrashParticipant, TrashPurgeResult, TrashPurgeRun } from "../trash/ports.js";
import { portableImportObjects, portableImportRecords, portableImports, portableMappings } from "./schema.js";
import { TRANSFER_MAX_RECORDS } from "./transferPolicy.js";

/** Stored in place of an erased sealed record. The worker can never decrypt it, so an import holding it fails safe. */
export const REDACTED_PAYLOAD = "redacted:v1";

const EXECUTING = new Set(["approved", "objects-prepared", "records-committed", "finalized"]);
/** Links that do not make the referencing record belong to the target (a group addition, a message attachment). */
const NOT_OWNERSHIP = new Set(["orders>orders", "messages>file-versions"]);
const KNOWN_TYPES: ReadonlySet<string> = new Set(RECORD_TYPE_ORDER);

interface SealedRow { id: number; recordType: string; portableId: string; position: number; digest: string; encryptedPayload: string }
interface Decoded extends SealedRow { record: Record<string, unknown> | null }

const key = (type: string, id: string) => `${type}:${id}`;

/** Pure: which sealed rows belong to the seeds (the seeds plus everything that references them by ownership). */
export function sealedClosure(rows: ReadonlyArray<{ recordType: string; portableId: string; record: Record<string, unknown> | null }>,
  seeds: Iterable<string>): Set<string> {
  const owned = new Set(seeds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      const own = key(row.recordType, row.portableId);
      if (owned.has(own) || !row.record || !KNOWN_TYPES.has(row.recordType)) continue;
      const refs = referencesOf(row.recordType as RecordType, row.record)
        .filter(([target]) => !NOT_OWNERSHIP.has(`${row.recordType}>${target}`));
      if (refs.some(([target, id]) => owned.has(key(target, id)))) { owned.add(own); grew = true; }
    }
  }
  return owned;
}

function sha256Of(row: Decoded): string | null {
  const value = row.recordType === "file-versions" ? row.record?.sha256 : null;
  return typeof value === "string" ? value : null;
}

export function createPortableTrashParticipant(deps: ModuleDeps): TrashParticipant {
  async function eraseFromImport(imp: { id: number; publicId: string; phase: string }, seeds: Set<string>, run: TrashPurgeRun) {
    if (EXECUTING.has(imp.phase)) {
      throw conflict("PORTABLE_IMPORT_IN_PROGRESS", "An import of this package is still running. Purge again when it has finished.");
    }
    const rows: SealedRow[] = await deps.db.select({
      id: portableImportRecords.id, recordType: portableImportRecords.recordType, portableId: portableImportRecords.portableId,
      position: portableImportRecords.position, digest: portableImportRecords.digest, encryptedPayload: portableImportRecords.encryptedPayload,
    }).from(portableImportRecords).where(eq(portableImportRecords.importId, imp.id))
      .orderBy(asc(portableImportRecords.position)).limit(TRANSFER_MAX_RECORDS + 1);
    const decoded: Decoded[] = rows.map((row) => {
      if (row.encryptedPayload === REDACTED_PAYLOAD) return { ...row, record: null };
      let parsed: unknown;
      try {
        parsed = JSON.parse(deps.crypto.decrypt(row.encryptedPayload, `portable.record:${imp.publicId}:${row.position}:${row.digest}`));
      } catch {
        throw conflict("PORTABLE_SEALED_UNREADABLE", "A sealed import record could not be read. The purge will be retried.");
      }
      return { ...row, record: parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null };
    });
    const owned = sealedClosure(decoded, seeds);
    const targets = decoded.filter((row) => owned.has(key(row.recordType, row.portableId)));
    const erasedShas = new Set(targets.map(sha256Of).filter((sha): sha is string => sha !== null));
    const neededShas = new Set(decoded.filter((row) => !owned.has(key(row.recordType, row.portableId)))
      .map(sha256Of).filter((sha): sha is string => sha !== null));
    let objects = 0;
    const candidates = [...erasedShas].filter((sha) => !neededShas.has(sha));
    if (candidates.length) {
      const staged = await deps.db.select().from(portableImportObjects)
        .where(and(eq(portableImportObjects.importId, imp.id), inArray(portableImportObjects.sha256, candidates)));
      for (const object of staged) {
        for (const storageKey of [object.escrowKey, object.preparedKey]) {
          // Fence before the external storage call (a replaced purge worker must not keep deleting).
          await deps.db.transaction((tx) => run.assertCurrentInTx(tx));
          await deps.storage.delete(storageKey);
          if (await deps.storage.stat(storageKey)) {
            throw conflict("PORTABLE_OBJECT_NOT_ERASED", "A staged import object could not be erased. The purge will be retried.");
          }
        }
        await deps.db.transaction(async (tx) => {
          await run.assertCurrentInTx(tx);
          await tx.delete(portableImportObjects).where(eq(portableImportObjects.id, object.id));
        });
        objects += 1;
      }
    }
    const pending = targets.filter((row) => row.encryptedPayload !== REDACTED_PAYLOAD).map((row) => row.id);
    if (pending.length) {
      await deps.db.transaction(async (tx) => {
        await run.assertCurrentInTx(tx);
        await tx.update(portableImportRecords).set({ encryptedPayload: REDACTED_PAYLOAD })
          .where(and(eq(portableImportRecords.importId, imp.id), inArray(portableImportRecords.id, pending)));
      });
    }
    return { records: pending.length, objects };
  }

  return {
    module: "portable",
    async purge(entity: TrashEntityRef, run: TrashPurgeRun): Promise<TrashPurgeResult> {
      const recordType = entity.kind === "order" ? "orders" : "customers";
      const mappings = await deps.db.select({ packageId: portableMappings.packageId, sourcePortableId: portableMappings.sourcePortableId })
        .from(portableMappings).where(and(eq(portableMappings.recordType, recordType), eq(portableMappings.localId, entity.id)));
      let records = 0;
      let objects = 0;
      let uploads = 0;
      const seedsByPackage = new Map<string, Set<string>>();
      for (const mapping of mappings) {
        const seeds = seedsByPackage.get(mapping.packageId) ?? new Set<string>();
        seeds.add(key(recordType, mapping.sourcePortableId));
        seedsByPackage.set(mapping.packageId, seeds);
      }
      for (const [packageId, seeds] of seedsByPackage) {
        const imports = await deps.db.select({ id: portableImports.id, publicId: portableImports.publicId, phase: portableImports.phase })
          .from(portableImports).where(eq(portableImports.packageId, packageId)).orderBy(asc(portableImports.id));
        for (const imp of imports) {
          const erased = await eraseFromImport(imp, seeds, run);
          records += erased.records;
          objects += erased.objects;
          uploads += 1;
        }
      }
      return {
        deleted: { portableSealedRecords: records, portableStagedObjects: objects },
        kept: { portableMappings: mappings.length, portablePassphraseSealedUploads: uploads },
      };
    },
  };
}
