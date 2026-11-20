import { and, asc, desc, eq, isNull, lt, or } from "drizzle-orm";
import type { Readable } from "node:stream";
import { join } from "node:path";
import { openPackage, PortableError } from "../../../portable/src/index.js";
import type { ModuleDeps } from "../../container.js";
import type { SessionPrincipal } from "../../core/types.js";
import { conflict, DomainError, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import {
  canonical, copyExact, CustodyError, decryptEscrow, digest, encryptEscrow, inPrivateWorkspace, newEscrowKey,
} from "./custody.js";
import { importView, lockImport, readImport, recordReceived, transition } from "./importLedger.js";
import { buildPlan, type JsonRecord, type PortableInputRecord } from "./importPlanning.js";
import { fileCategory, numberField, selectLiveVersions, stringField } from "./importShapes.js";
import { createImportWorker } from "./importWorker.js";
import { matchBytes } from "./custody.js";
import {
  portableImportObjects, portableImportRecords, portableImports, portableImportSteps, portablePackageReservations,
} from "./schema.js";
import {
  assertCurrentTransferActor, assertNotDraining, authorizeTransfer, PACKAGE_LIMITS, pageLimit, PORTABLE_IMPORT_JOB, REVIEW_TTL_MS,
  TRANSFER_MAX_BYTES, TRANSFER_MAX_OBJECTS, TRANSFER_MAX_RECORDS, type PageInput,
} from "./transferPolicy.js";

const HEX64 = /^[0-9a-f]{64}$/;
const PACKAGE_ID = /^(?:[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{64})$/;
const SAFE_SOURCE = /^[a-zA-Z0-9._:-]{1,128}$/;

function stateConflict() {
  return conflict("PORTABLE_PHASE_MISMATCH", "The import is not ready for that operation.");
}

export function createImportService(deps: ModuleDeps) {
  const apply = createImportWorker(deps);
  deps.jobs.register(PORTABLE_IMPORT_JOB, apply, { retrySafe: true });
  return {
    async listImports(principal: SessionPrincipal, input: PageInput) {
      await authorizeTransfer(deps, principal, "portable.import", false);
      const limit = pageLimit(input);
      const rows = await deps.db.select().from(portableImports)
        .where(input.cursor ? lt(portableImports.publicId, input.cursor) : undefined)
        .orderBy(desc(portableImports.publicId)).limit(limit + 1);
      const items = rows.slice(0, limit).map(importView);
      return { items, nextCursor: rows.length > limit ? items.at(-1)?.importId ?? null : null };
    },

    async getImport(principal: SessionPrincipal, importId: string) {
      await authorizeTransfer(deps, principal, "portable.import", false);
      const row = await readImport(deps, importId);
      const steps = await deps.db.select({
        operationId: portableImportSteps.publicId, phase: portableImportSteps.toPhase, occurredAt: portableImportSteps.createdAt,
      }).from(portableImportSteps).where(eq(portableImportSteps.importId, row.id))
        .orderBy(asc(portableImportSteps.id)).limit(16);
      const held = await deps.db.select({
        portableId: portableImportRecords.portableId, type: portableImportRecords.recordType,
        reasonCode: portableImportRecords.reasonCode,
      }).from(portableImportRecords).where(and(
        eq(portableImportRecords.importId, row.id), or(
          eq(portableImportRecords.disposition, "hold"), eq(portableImportRecords.reasonCode, "PORTABLE_HELD_FIELDS"),
        ),
      )).orderBy(asc(portableImportRecords.position)).limit(100);
      return { ...importView(row), steps, held };
    },

    async upload(principal: SessionPrincipal, stream: Readable) {
      await authorizeTransfer(deps, principal, "portable.import");
      await assertNotDraining(deps);
      const now = deps.clock.now();
      const importId = ulid(now.getTime());
      const storageKey = deps.storage.newKey("quarantine");
      const before = await deps.db.transaction(async (tx) => {
        await assertCurrentTransferActor(deps, principal, tx);
        await tx.insert(portableImports).values({
          publicId: importId, submittedBy: principal.userId, installationId: deps.config.installationId,
          storageKey, createdAt: now, updatedAt: now,
        });
        const inserted = await lockImport(tx, importId);
        await recordReceived(deps, tx, inserted, principal);
        return inserted;
      });
      let stored;
      try {
        stored = await deps.storage.put(storageKey, stream, { maxBytes: TRANSFER_MAX_BYTES });
        if (stored.size < 1 || !HEX64.test(stored.sha256)) throw new CustodyError();
      } catch {
        await deps.db.transaction(async (tx) => {
          const current = await lockImport(tx, importId);
          if (current.phase !== before.phase) return;
          await transition(deps, tx, current, "failed", { principal, reasonCode: "PORTABLE_UPLOAD_INCOMPLETE" });
        });
        throw validation("PORTABLE_UPLOAD_INCOMPLETE", "The transfer upload did not complete. Submit a non-empty package within the upload limit.");
      }
      return deps.db.transaction(async (tx) => {
        await assertCurrentTransferActor(deps, principal, tx);
        const current = await lockImport(tx, importId);
        const row = await transition(deps, tx, current, "quarantined", { principal }, {
          inputSize: stored.size, inputSha256: stored.sha256,
        });
        return importView(row);
      });
    },

    async verifyAndPlan(principal: SessionPrincipal, input: { importId: string; passphrase: string }) {
      await authorizeTransfer(deps, principal, "portable.import");
      await assertNotDraining(deps);
      if (typeof input.passphrase !== "string" || !input.passphrase.length || input.passphrase.length > 512) {
        throw validation("PORTABLE_PASSPHRASE_LENGTH", "Enter the transfer package passphrase.");
      }
      const { importId } = input;
      await deps.db.transaction((tx) => assertCurrentTransferActor(deps, principal, tx));
      const admitted = await readImport(deps, importId);
      if (admitted.phase === "planned") return importView(admitted);
      if ((admitted.phase !== "quarantined" && admitted.phase !== "verified") || !admitted.inputSha256 || !admitted.inputSize) {
        throw stateConflict();
      }
      const inputSha256 = admitted.inputSha256;
      const inputSize = admitted.inputSize;
      try {
        return await inPrivateWorkspace(async (workspace) => {
          const path = join(workspace, "quarantined.rpkg");
          await copyExact(deps.storage, admitted.storageKey, path, { size: inputSize, sha256: inputSha256 });
          const pkg = await openPackage({ input: path, passphrase: input.passphrase, limits: PACKAGE_LIMITS, workDir: workspace });
          try {
            const report = await pkg.verify();
            if (!report.ok) throw validation("PORTABLE_VERIFICATION_REFUSED", "The package failed integrity or compatibility verification.");
            if (pkg.manifest.dependencyClosure.external.length ||
              pkg.manifest.compatibility.requiredModules.some((module) => module !== "core")) {
              throw validation("PORTABLE_UNSUPPORTED_REQUIRED_SCOPE", "This transfer requires records or history beyond the target import contract.");
            }
            const packageId = pkg.manifest.packageId;
            const manifestSha256 = pkg.manifestSha256;
            const sourceSystem = pkg.manifest.sourceSystem.pseudonym;
            if (!PACKAGE_ID.test(packageId) || !HEX64.test(manifestSha256) || !SAFE_SOURCE.test(sourceSystem) ||
              pkg.ciphertextSha256 !== inputSha256) {
              throw validation("PORTABLE_PACKAGE_IDENTITY", "The package contains an unsupported identity.");
            }
            const objects = pkg.listObjects();
            if (objects.length > TRANSFER_MAX_OBJECTS) throw validation("PORTABLE_OBJECT_LIMIT", "The package has too many objects.");
            if (admitted.phase === "quarantined") {
              const records: PortableInputRecord[] = [];
              let payloadBytes = 0;
              for await (const entry of pkg.allRecords()) {
                const record = entry.record as JsonRecord;
                payloadBytes += Buffer.byteLength(canonical(record));
                if (records.length >= TRANSFER_MAX_RECORDS || payloadBytes > 16 * 1024 * 1024) {
                  throw validation("PORTABLE_RECORD_LIMIT", "The package exceeds the installation transfer limits.");
                }
                records.push({ type: entry.type, record });
              }
              for (const extension of report.heldExtensions) {
                let line = 0;
                for await (const raw of pkg.heldExtension(extension.name)) {
                  line += 1;
                  const entry = { name: extension.name, version: extension.version, line, raw };
                  const encoded = canonical(entry);
                  payloadBytes += Buffer.byteLength(encoded);
                  if (records.length >= TRANSFER_MAX_RECORDS || payloadBytes > 16 * 1024 * 1024) {
                    throw validation("PORTABLE_EXTENSION_LIMIT", "The package exceeds the installation's held-content limit.");
                  }
                  records.push({ type: "optional-extension", record: { publicId: digest(encoded), entry } });
                }
                if (line !== extension.count) throw new CustodyError();
              }
              const filePolicyRefusals = new Set<string>();
              const { parents, latest } = selectLiveVersions(records);
              for (const [parentId, version] of latest) {
                const parent = parents.get(parentId)!;
                const key = deps.storage.newKey("staging");
                const expected = { sha256: stringField(version.sha256), size: numberField(version, "sizeBytes") };
                try {
                  const category = fileCategory(parent.category);
                  const source = await pkg.openObject(expected.sha256);
                  const staged = await deps.storage.put(key, source as Readable, { maxBytes: expected.size });
                  matchBytes(staged, expected);
                  await deps.services.files.validatePortableObject({
                    stagedObject: staged, category, displayName: stringField(version.originalName),
                    contentType: stringField(version.mediaType),
                  });
                } catch (error) {
                  if (!(error instanceof DomainError) || error.code !== "VALIDATION") throw error;
                  filePolicyRefusals.add(version.publicId);
                } finally {
                  await deps.storage.delete(key).catch(() => undefined);
                }
              }
              const plan = await buildPlan(deps, { inputSha256, packageId, manifestSha256, sourceSystem, records, objects, filePolicyRefusals });
              await deps.db.transaction(async (tx) => {
                await assertCurrentTransferActor(deps, principal, tx);
                const row = await lockImport(tx, importId);
                if (row.phase !== "quarantined" || row.inputSha256 !== inputSha256) throw stateConflict();
                const escrowKey = newEscrowKey(deps.crypto, importId);
                for (let batch = 0; batch < plan.records.length; batch += 25) {
                  await tx.insert(portableImportRecords).values(plan.records.slice(batch, batch + 25).map((item) => ({
                    importId: row.id, portableId: item.record.publicId, recordType: item.type, position: item.position,
                    digest: item.digest, disposition: item.disposition,
                    reasonCode: item.reason ?? (item.record.heldUnknown ? "PORTABLE_HELD_FIELDS" : undefined),
                    encryptedPayload: deps.crypto.encrypt(canonical(item.record), `portable.record:${importId}:${item.position}:${item.digest}`),
                    destinationKey: item.type === "file-versions" && item.disposition === "create" ? deps.storage.newKey("files") : null,
                    adoptionKey: item.type === "file-versions" && item.disposition === "create" ? deps.storage.newKey("staging") : null,
                  })));
                }
                for (let batch = 0; batch < objects.length; batch += 100) {
                  await tx.insert(portableImportObjects).values(objects.slice(batch, batch + 100).map((object) => ({
                    importId: row.id, sha256: object.sha256, size: object.size,
                    escrowKey: deps.storage.newKey("quarantine"), preparedKey: deps.storage.newKey("staging"),
                  })));
                }
                await transition(deps, tx, row, "verified", { principal }, {
                  packageId, manifestSha256, sourceSystem, encryptedEscrowKey: escrowKey,
                  planDigest: plan.planDigest, plan: plan.summary,
                });
              });
            }
            const verified = await readImport(deps, importId);
            if (verified.phase !== "verified" || verified.packageId !== packageId || verified.manifestSha256 !== manifestSha256 ||
              verified.inputSha256 !== inputSha256 || !verified.encryptedEscrowKey) throw new CustodyError();
            const objectRows = await deps.db.select().from(portableImportObjects).where(eq(portableImportObjects.importId, verified.id))
              .orderBy(asc(portableImportObjects.sha256)).limit(TRANSFER_MAX_OBJECTS + 1);
            if (objects.length !== objectRows.length) throw new CustodyError();
            for (const object of objectRows) {
              if (object.escrowCipherDigest) continue;
              // A crash after storage commit can leave an existing escrow key. Reauthenticate it entirely before recording its receipt.
              let stored = await deps.storage.stat(object.escrowKey);
              if (stored) {
                if (stored.size !== object.size + 28) throw new CustodyError();
                const bytes = await deps.storage.get(object.escrowKey);
                const validated = decryptEscrow(bytes as AsyncIterable<Buffer>, deps.crypto, verified.encryptedEscrowKey, importId,
                  { ...object, ciphertextSha256: stored.sha256 });
                for await (const _chunk of validated) { /* drain until GCM and both digests are checked */ }
              } else {
                const source = await pkg.openObject(object.sha256);
                const encrypted = encryptEscrow(source as unknown as AsyncIterable<Buffer>, deps.crypto,
                  verified.encryptedEscrowKey, importId, object);
                stored = await deps.storage.put(object.escrowKey, encrypted, { maxBytes: object.size + 28 });
                if (stored.size !== object.size + 28) throw new CustodyError();
              }
              await deps.db.transaction(async (tx) => {
                await assertCurrentTransferActor(deps, principal, tx);
                const row = await lockImport(tx, importId);
                if (row.phase !== "verified" || row.planDigest !== verified.planDigest) throw stateConflict();
                await tx.update(portableImportObjects).set({ escrowCipherDigest: stored!.sha256 })
                  .where(and(eq(portableImportObjects.id, object.id), isNull(portableImportObjects.escrowCipherDigest)));
              });
            }
            return deps.db.transaction(async (tx) => {
              await assertCurrentTransferActor(deps, principal, tx);
              const row = await lockImport(tx, importId);
              const next = await transition(deps, tx, row, "planned", { principal }, {
                planExpiresAt: new Date(deps.clock.now().getTime() + REVIEW_TTL_MS),
              });
              return importView(next);
            });
          } finally {
            await pkg.close().catch(() => undefined);
          }
        });
      } catch (error) {
        if (!(error instanceof PortableError) && !(error instanceof CustodyError) &&
          !(error instanceof DomainError && error.code === "VALIDATION")) throw error;
        const passphrase = error instanceof PortableError && error.code === "PASSPHRASE_REJECTED";
        const reasonCode = passphrase ? "PORTABLE_PASSPHRASE_REJECTED" : "PORTABLE_VERIFICATION_REFUSED";
        await deps.db.transaction(async (tx) => {
          const row = await lockImport(tx, importId);
          if (row.phase !== "quarantined" && row.phase !== "verified") return;
          if (passphrase) {
            await deps.audit.record({
              category: "portable_transfer", eventName: "portable.import.verification_refused", action: "verify",
              outcome: "refused", reasonCode, correlationId: importId, importId, packageId: row.packageId ?? undefined,
              actor: { role: "admin", userId: principal.userId }, resource: { type: "portable_import", publicId: importId },
            }, tx);
          } else {
            await transition(deps, tx, row, "failed", { principal, reasonCode, state: "refused" });
          }
        });
        throw validation(reasonCode, passphrase
          ? "The passphrase or encrypted package was rejected. Check the passphrase and try again."
          : "The package did not pass verification. No business records were imported.");
      }
    },

    async approve(principal: SessionPrincipal, input: { importId: string; planDigest: string }) {
      await authorizeTransfer(deps, principal, "portable.import");
      await assertNotDraining(deps);
      return deps.db.transaction(async (tx) => {
        await assertCurrentTransferActor(deps, principal, tx);
        const row = await lockImport(tx, input.importId);
        if ((row.phase === "approved" || row.phase === "objects-prepared" || row.phase === "records-committed" ||
          row.phase === "finalized" || row.phase === "reconciled" || row.phase === "accepted") &&
          row.planDigest === input.planDigest) return importView(row);
        if (row.phase !== "planned" || row.planDigest !== input.planDigest || row.installationId !== deps.config.installationId ||
          !row.plan || !row.planExpiresAt || row.planExpiresAt <= deps.clock.now() || !row.packageId || !row.manifestSha256) {
          throw conflict("PORTABLE_REVIEW_STALE", "The reviewed plan no longer matches or has expired. Upload and verify the package again.");
        }
        if (row.plan.counts.conflicts) throw conflict("PORTABLE_PLAN_CONFLICTS", "This plan contains unresolved conflicts; no data was written.");
        await tx.insert(portablePackageReservations).values({
          packageId: row.packageId, manifestSha256: row.manifestSha256, importId: row.id,
        }).onDuplicateKeyUpdate({ set: { packageId: row.packageId } });
        const [reservation] = await tx.select().from(portablePackageReservations)
          .where(eq(portablePackageReservations.packageId, row.packageId)).limit(1).for("update");
        if (!reservation || reservation.manifestSha256 !== row.manifestSha256 ||
          (reservation.importId !== null && reservation.importId !== row.id)) {
          throw conflict("PORTABLE_PACKAGE_RESERVED", "Another operation or a different manifest already owns this package identifier.");
        }
        await tx.update(portablePackageReservations).set({ importId: row.id })
          .where(eq(portablePackageReservations.packageId, row.packageId));
        const next = await transition(deps, tx, row, "approved", { principal }, {
          approvedBy: principal.userId, approverPublicId: principal.userPublicId,
          approverSessionId: principal.sessionId, approvalStepUpAt: principal.stepUpAt,
        });
        await deps.jobs.enqueue(PORTABLE_IMPORT_JOB, { importId: row.publicId }, {
          idempotencyKey: `import:${row.publicId}`, correlationId: row.publicId, maxAttempts: 5,
        }, tx);
        return importView(next);
      });
    },

    async cancel(principal: SessionPrincipal, importId: string) {
      await authorizeTransfer(deps, principal, "portable.import");
      return deps.db.transaction(async (tx) => {
        await assertCurrentTransferActor(deps, principal, tx);
        const row = await lockImport(tx, importId);
        if (!["received", "quarantined", "verified", "planned", "canceled"].includes(row.phase)) throw stateConflict();
        return importView(await transition(deps, tx, row, "canceled", { principal, reasonCode: "PORTABLE_CANCELED" }));
      });
    },

    async accept(principal: SessionPrincipal, input: { importId: string; planDigest: string; independentChecks: true }) {
      await authorizeTransfer(deps, principal, "portable.import");
      if (input.independentChecks !== true) throw stateConflict();
      return deps.db.transaction(async (tx) => {
        await assertCurrentTransferActor(deps, principal, tx);
        const row = await lockImport(tx, input.importId);
        if (row.phase === "accepted" && row.planDigest === input.planDigest) return importView(row);
        if (row.phase !== "reconciled" || row.planDigest !== input.planDigest || !row.reconciliation ||
          row.reconciliation.discrepancies !== 0 || row.approvedBy === principal.userId) {
          throw conflict("PORTABLE_ACCEPTANCE_NOT_READY", "A different administrator must verify the reconciled results before accepting this import.");
        }
        return importView(await transition(deps, tx, row, "accepted", { principal }));
      });
    },
  };
}
