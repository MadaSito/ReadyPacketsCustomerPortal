import { and, eq } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import { validation } from "../../core/errors.js";
import { canonical, digest } from "./custody.js";
import { portableMappings, type PlanSummary } from "./schema.js";
import { TRANSFER_MAX_RECORDS } from "./transferPolicy.js";
import { customerName, fileCategory, projectedOrder, selectLiveVersions, stringField, targetDate } from "./importShapes.js";

export type JsonRecord = Record<string, unknown> & { publicId: string };
export interface PortableInputRecord { type: string; record: JsonRecord }
export interface PlannedRecord {
  type: string;
  record: JsonRecord;
  position: number;
  disposition: PlanSummary["samples"][number]["disposition"];
  reason?: string;
  digest: string;
}

export const EVIDENCE_TYPES = new Set([
  "order-shares", "message-threads", "messages", "tickets", "ticket-comments", "policy-versions",
  "policy-acceptances", "intake-definitions", "intake-submissions", "invoices", "payments", "refunds", "provenance",
]);

export const LIVE_TYPES = new Set(["customers", "orders", "order-items", "order-status-history", "files", "file-versions"]);

export function computePlanDigest(args: {
  inputSha256: string; packageId: string; manifestSha256: string; sourceSystem: string; installationId: string;
  records: ReadonlyArray<{ type: string; portableId: string; digest: string; disposition: string }>;
  objects: ReadonlyArray<{ sha256: string; size: number }>;
}) {
  return digest(canonical({
    inputSha256: args.inputSha256, packageId: args.packageId, manifestSha256: args.manifestSha256,
    target: args.installationId, source: args.sourceSystem, policy: "strict-read-only-v1",
    records: args.records.map((record) => [record.type, record.portableId, record.digest, record.disposition]),
    objects: [...args.objects].sort((a, b) => a.sha256.localeCompare(b.sha256)).map(({ sha256, size }) => ({ sha256, size })),
  }));
}

export async function buildPlan(deps: ModuleDeps, args: {
  inputSha256: string; packageId: string; manifestSha256: string; sourceSystem: string;
  records: PortableInputRecord[]; objects: ReadonlyArray<{ sha256: string; size: number }>;
  filePolicyRefusals?: ReadonlySet<string>;
}) {
  if (args.records.length > TRANSFER_MAX_RECORDS) {
    throw validation("PORTABLE_RECORD_LIMIT", "The package exceeds the installation's transfer record limit.");
  }
  return deps.db.transaction(async (tx) => {
    const { parents, latest, duplicated } = selectLiveVersions(args.records);
    const orderItems = groupChildren(args.records, "order-items");
    const orderHistory = groupChildren(args.records, "order-status-history");
    const existing = await tx.select().from(portableMappings)
      .where(eq(portableMappings.packageId, args.packageId)).limit(TRANSFER_MAX_RECORDS + 1);
    if (existing.length > TRANSFER_MAX_RECORDS) throw validation("PORTABLE_RECORD_LIMIT", "The package exceeds the transfer record limit.");
    const bySource = new Map(existing.map((item) => [`${item.recordType}:${item.sourcePortableId}`, item]));
    const records: PlannedRecord[] = [];
    const selected = new Map<string, PlannedRecord>();
    const summary: PlanSummary = { counts: { creates: 0, links: 0, conflicts: 0, heldUnknown: 0 }, samples: [] };
    const sampled: Record<PlannedRecord["disposition"], number> = { create: 0, link: 0, conflict: 0, hold: 0 };
    let metaBytes = 0;
    for (const item of args.records) {
      const encoded = canonical(item.record);
      metaBytes += Buffer.byteLength(encoded);
      if (metaBytes > 16 * 1024 * 1024) {
        throw validation("PORTABLE_METADATA_LIMIT", "The package exceeds the transfer metadata limit.");
      }
      const ref = `${item.type}:${item.record.publicId}`;
      const step: PlannedRecord = {
        ...item, position: records.length, digest: digest(encoded), disposition: "create",
      };
      const mapped = bySource.get(ref);
      if (mapped) {
        step.disposition = mapped.sourceDigest === step.digest ? "link" : "conflict";
        if (step.disposition === "conflict") step.reason = "PORTABLE_PROVENANCE_MISMATCH";
      } else if (!LIVE_TYPES.has(item.type)) {
        step.disposition = "hold";
        step.reason = EVIDENCE_TYPES.has(item.type) ? "PORTABLE_HISTORICAL_EVIDENCE" : "PORTABLE_OPTIONAL_EXTENSION";
      } else if (item.type === "customers") {
        const email = item.record.email;
        if (typeof email !== "string") {
          step.disposition = "conflict";
          step.reason = "PORTABLE_CUSTOMER_EMAIL_REQUIRED";
        } else {
          const collision = await deps.services.identity.findUserIdByEmail(email, { tx });
          const idCollision = await deps.services.identity.getUserByPublicId(item.record.publicId, { tx });
          if (collision || idCollision) {
            step.disposition = "conflict";
            step.reason = collision ? "PORTABLE_EMAIL_COLLISION" : "PORTABLE_PUBLIC_ID_COLLISION";
          } else {
            try { customerName(item.record); targetDate(item.record.createdAt); }
            catch { step.disposition = "conflict"; step.reason = "PORTABLE_TARGET_POLICY"; }
          }
        }
      } else if (item.type === "orders") {
        const order = await deps.services.orders.findImportedOrder(args.sourceSystem, item.record.publicId, tx);
        const owner = selected.get(`customers:${String(item.record.customerPublicId)}`);
        if (order || !owner || owner.disposition === "conflict") {
          step.disposition = "conflict";
          step.reason = order ? "PORTABLE_ORDER_PROVENANCE_COLLISION" : "PORTABLE_OWNER_NOT_PLANNED";
        } else {
          try { projectedOrder(item.record, orderItems.get(item.record.publicId) ?? [], orderHistory.get(item.record.publicId) ?? []); }
          catch { step.disposition = "conflict"; step.reason = "PORTABLE_TARGET_POLICY"; }
        }
      } else if (item.type === "files") {
        if (duplicated.has(item.record.publicId)) {
          step.disposition = "conflict"; step.reason = "PORTABLE_AMBIGUOUS_FILE_VERSION";
        } else if (!latest.has(item.record.publicId)) {
          step.disposition = "hold"; step.reason = "PORTABLE_HISTORICAL_FILE";
        } else if (selected.get(`orders:${String(item.record.orderPublicId)}`)?.disposition !== "create") {
          step.disposition = "conflict"; step.reason = "PORTABLE_FILE_ORDER_NOT_PLANNED";
        } else {
          try { fileCategory(item.record.category); }
          catch { step.disposition = "conflict"; step.reason = "PORTABLE_TARGET_POLICY"; }
        }
      } else if (item.type === "file-versions") {
        const parentId = stringField(item.record.filePublicId);
        if (!parents.has(parentId)) {
          step.disposition = "conflict"; step.reason = "PORTABLE_EXTERNAL_FILE_ROOT_UNSUPPORTED";
        } else if (latest.get(parentId)?.publicId !== item.record.publicId) {
          step.disposition = "hold"; step.reason = "PORTABLE_HISTORICAL_FILE";
        } else if (args.filePolicyRefusals?.has(item.record.publicId)) {
          step.disposition = "conflict"; step.reason = "PORTABLE_TARGET_FILE_POLICY";
        }
      } else if ((item.type === "order-items" || item.type === "order-status-history") &&
        selected.get(`orders:${String(item.record.orderPublicId)}`)?.disposition !== "create") {
        step.disposition = "conflict"; step.reason = "PORTABLE_ORDER_NOT_PLANNED";
      }
      // Unknown fields on a known record are preserved separately in its sealed provenance.
      if (item.record.heldUnknown && step.disposition !== "hold") summary.counts.heldUnknown += 1;
      const counter = {
        create: "creates", link: "links", conflict: "conflicts", hold: "heldUnknown",
      } as const;
      summary.counts[counter[step.disposition]] += 1;
      if (sampled[step.disposition] < 12) {
        summary.samples.push({ portableId: item.record.publicId, disposition: step.disposition, reason: step.reason });
        sampled[step.disposition] += 1;
      }
      records.push(step);
      selected.set(ref, step);
    }
    const planDigest = computePlanDigest({ ...args, installationId: deps.config.installationId,
      records: records.map(({ type, record, digest: recordDigest, disposition }) => ({
        type, portableId: record.publicId, digest: recordDigest, disposition,
      })),
    });
    return { records, summary, planDigest };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export function groupChildren(records: PortableInputRecord[], part: string) {
  const groups = new Map<string, JsonRecord[]>();
  for (const { type, record } of records) {
    if (type !== part) continue;
    const parent = stringField(record.orderPublicId);
    const rows = groups.get(parent) ?? [];
    rows.push(record);
    groups.set(parent, rows);
  }
  return groups;
}

export const mappedRecord = (packageId: string, type: string, portableId: string) => and(
  eq(portableMappings.packageId, packageId), eq(portableMappings.recordType, type), eq(portableMappings.sourcePortableId, portableId),
);
