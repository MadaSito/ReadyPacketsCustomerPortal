/**
 * Reference importer (example, NOT the ReadyPackets server importer).
 *
 * Reads a VERIFIED portable package and emits a no-write plan of what a different target system — the
 * "reference CRM model" (accounts, contacts, projects, project lines, documents, notes) — would create.
 * It demonstrates that a package can be mapped without ReadyPackets code, database, hostname or keys.
 *
 * Rules a conforming importer follows and this example demonstrates:
 *  - never creates sign-in identities: contacts are created `inactive` and need local verification + MFA;
 *  - never matches existing records by e-mail (no implicit linking);
 *  - imported projects default to read-only;
 *  - unknown enumeration values that change business meaning are refused, not guessed;
 *  - held-unknown content is carried as inert notes, never interpreted;
 *  - historical billing/acceptance evidence is recorded as history; nothing is replayed.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "../src/json.js";
import type { PortablePackage, VerificationReport } from "../src/types.js";
import { PortableError } from "../src/errors.js";

export const PLAN_VERSION = "reference-plan.v1";

/** Business vocabulary the reference target understands (taken from the existing system's domain). */
export const KNOWN_ORDER_STATUSES = new Set(["new", "phase_1_intake", "phase_2_synthesis", "in_production", "delivered", "closed", "cancelled", "refunded"]);
export const KNOWN_PAYMENT_STATUSES = new Set(["unpaid", "awaiting_invoice", "processing", "paid", "partially_refunded", "refunded", "not_required", "waived"]);

export interface PlanAction {
  op: "create";
  entity: "account" | "contact" | "project" | "project-line" | "project-event" | "document" | "note" | "history";
  key: string;
  parentKey: string | null;
  fields: Record<string, unknown>;
}

export interface PlanRefusal {
  code: "UNKNOWN_ENUM" | "UNSUPPORTED_RECORD_TYPE" | "PACKAGE_NOT_VERIFIED";
  recordType: string;
  publicId: string | null;
  detail: string;
}

export interface ImportPlan {
  planVersion: typeof PLAN_VERSION;
  target: "reference-crm-model.v1";
  packageId: string;
  manifestSha256: string;
  ciphertextSha256: string;
  sourceFormat: string;
  actions: PlanAction[];
  refusals: PlanRefusal[];
  summary: Record<string, number>;
  /** Plan is applicable only when there are no refusals. */
  applicable: boolean;
  limitations: string[];
  /** SHA-256 of the canonical plan without this field — bind approvals to it. */
  planSha256: string;
}

export async function buildPlan(pkg: PortablePackage, report?: VerificationReport): Promise<ImportPlan> {
  const r = report ?? (await pkg.verify());
  if (!r.ok) throw new PortableError("NOT_VERIFIED", "A plan can only be built from a verified package.");
  const actions: PlanAction[] = [];
  const refusals: PlanRefusal[] = [];
  const summary: Record<string, number> = {};
  const add = (a: PlanAction) => {
    actions.push(a);
    summary[a.entity] = (summary[a.entity] ?? 0) + 1;
  };
  const note = (parentKey: string, held: unknown) => {
    if (held && typeof held === "object" && Object.keys(held).length) {
      add({ op: "create", entity: "note", key: `${parentKey}:held`, parentKey, fields: { kind: "inert-source-evidence", json: canonicalJson(held) } });
    }
  };

  for await (const { type, record } of pkg.allRecords()) {
    const rec = record as unknown as Record<string, unknown> & { publicId: string };
    switch (type) {
      case "customers": {
        add({ op: "create", entity: "account", key: `acct:${rec.publicId}`, parentKey: null, fields: { name: rec.company ?? ([rec.firstName, rec.lastName].filter(Boolean).join(" ") || "Imported account"), sourceId: rec.publicId } });
        add({
          op: "create",
          entity: "contact",
          key: `contact:${rec.publicId}`,
          parentKey: `acct:${rec.publicId}`,
          fields: { email: rec.email, givenName: rec.firstName, familyName: rec.lastName, state: "inactive-pending-verification", signInEnabled: false, marketingConsent: rec.marketingOptIn },
        });
        note(`contact:${rec.publicId}`, rec.heldUnknown);
        break;
      }
      case "orders": {
        const status = String(rec.status);
        const pay = String(rec.paymentStatus);
        if (!KNOWN_ORDER_STATUSES.has(status)) refusals.push({ code: "UNKNOWN_ENUM", recordType: type, publicId: rec.publicId, detail: "order status" });
        if (!KNOWN_PAYMENT_STATUSES.has(pay)) refusals.push({ code: "UNKNOWN_ENUM", recordType: type, publicId: rec.publicId, detail: "payment status" });
        const total = rec.total as { amountMinor: number; currency: string };
        add({
          op: "create",
          entity: "project",
          key: `proj:${rec.publicId}`,
          parentKey: `acct:${String(rec.customerPublicId)}`,
          fields: { reference: rec.orderNumber, title: rec.projectName, stage: status, billingState: pay, totalMinor: total.amountMinor, currency: total.currency, readOnly: true, openedAt: rec.createdAt },
        });
        note(`proj:${rec.publicId}`, rec.heldUnknown);
        break;
      }
      case "order-items": {
        const unit = rec.unitPrice as { amountMinor: number };
        add({ op: "create", entity: "project-line", key: `line:${rec.publicId}`, parentKey: `proj:${String(rec.orderPublicId)}`, fields: { sku: rec.sku, label: rec.name, quantity: rec.quantity, unitMinor: unit.amountMinor } });
        break;
      }
      case "order-status-history":
        add({ op: "create", entity: "project-event", key: `evt:${rec.publicId}`, parentKey: `proj:${String(rec.orderPublicId)}`, fields: { from: rec.fromStatus, to: rec.toStatus, at: rec.occurredAt, note: rec.note } });
        break;
      case "files":
        break; // documents are created per version below; the file record contributes visibility
      case "file-versions":
        add({
          op: "create",
          entity: "document",
          key: `doc:${rec.publicId}`,
          parentKey: `file:${String(rec.filePublicId)}`,
          fields: { displayName: rec.originalName, declaredType: rec.mediaType, bytes: rec.sizeBytes, sha256: rec.sha256, version: rec.version, mustReclassify: true },
        });
        break;
      case "provenance":
        add({ op: "create", entity: "history", key: `prov:${rec.publicId}`, parentKey: null, fields: { subject: `${String(rec.subjectType)}:${String(rec.subjectPublicId)}`, sourceReference: rec.sourceReference, sourceRecordType: rec.sourceRecordType } });
        break;
      case "invoices":
      case "payments":
      case "refunds":
      case "policy-acceptances":
      case "policy-versions":
        add({ op: "create", entity: "history", key: `hist:${type}:${rec.publicId}`, parentKey: null, fields: { kind: type, evidenceOnly: true, replay: false } });
        break;
      default:
        refusals.push({ code: "UNSUPPORTED_RECORD_TYPE", recordType: type, publicId: rec.publicId, detail: "the reference model has no mapping for this record type" });
    }
  }

  const body = {
    planVersion: PLAN_VERSION as typeof PLAN_VERSION,
    target: "reference-crm-model.v1" as const,
    packageId: r.packageId,
    manifestSha256: r.manifestSha256,
    ciphertextSha256: r.ciphertextSha256,
    sourceFormat: r.sourceFormat,
    actions,
    refusals,
    summary,
    applicable: refusals.length === 0,
    limitations: [
      "Example mapping only; it performs no writes.",
      "Contacts are never sign-in identities; activation needs local verification and MFA on the target.",
      "No e-mail based matching against existing target records is performed.",
      ...r.losses.map((l) => `Source loss ${l.code}: ${l.message}`),
    ],
  };
  const planSha256 = createHash("sha256").update(canonicalJson(body)).digest("hex");
  return { ...body, planSha256 };
}
