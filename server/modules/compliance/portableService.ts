import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { RECORD_SCHEMAS, type RecordOf } from "../../../portable/src/index.js";
import type { ModuleDeps } from "../../container.js";
import { validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { DbOrTx, Tx } from "../../core/types.js";
import { users } from "../identity/schema.js";
import { canonicalizeIntakeFields, deriveInvoiceStatus, hashPolicyContent, hashQuestionnaireFields, normalizePolicyBody } from "./domain.js";
import {
  complianceInvoiceLines,
  complianceInvoicePayments,
  complianceInvoiceRefunds,
  complianceInvoices,
  intakeQuestionnaires,
  intakeQuestionnaireVersions,
  intakeSubmissionRevisions,
  intakeSubmissions,
  policyAcceptances,
  policyDocuments,
  policyVersions,
  type StoredIntakeFieldDef,
} from "./schema.js";

export interface PortableEvidenceOptions {
  includeCompliance?: boolean | undefined;
  includeBilling?: boolean | undefined;
  /** Optional set of exported customer publicIds to include account-level (`orderPublicId: null`) policy acceptances. */
  customerPublicIds?: readonly string[] | undefined;
}

export interface PortableEvidenceBatch {
  policyVersions: RecordOf<"policy-versions">[];
  policyAcceptances: RecordOf<"policy-acceptances">[];
  intakeDefinitions: RecordOf<"intake-definitions">[];
  intakeSubmissions: RecordOf<"intake-submissions">[];
  invoices: RecordOf<"invoices">[];
  payments: RecordOf<"payments">[];
  refunds: RecordOf<"refunds">[];
  nextCursor: string | null;
}

export interface ImportPortableEvidenceInput {
  importId: string;
  sourceInstallationId: string;
  /** Map of archive customerPublicId -> local users.id */
  customerIdBySourcePublicId: ReadonlyMap<string, number>;
  /** Map of archive orderPublicId -> local { id: number; publicId: string } */
  orderBySourcePublicId: ReadonlyMap<string, { id: number; publicId: string }>;
  policyVersions?: readonly RecordOf<"policy-versions">[];
  policyAcceptances?: readonly RecordOf<"policy-acceptances">[];
  intakeDefinitions?: readonly RecordOf<"intake-definitions">[];
  intakeSubmissions?: readonly RecordOf<"intake-submissions">[];
  invoices?: readonly RecordOf<"invoices">[];
  payments?: readonly RecordOf<"payments">[];
  refunds?: readonly RecordOf<"refunds">[];
}

export interface ImportPortableEvidenceReceipt {
  importedPolicyVersions: number;
  importedPolicyAcceptances: number;
  importedIntakeDefinitions: number;
  importedIntakeSubmissions: number;
  importedInvoices: number;
  importedPayments: number;
  importedRefunds: number;
}

function toSafeToken(raw: string, fallbackPrefix = "k"): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_:.-]/g, "-")
    .slice(0, 64);
  if (!cleaned) return fallbackPrefix;
  return /^[a-z]/.test(cleaned) ? cleaned : `${fallbackPrefix}-${cleaned}`.slice(0, 64);
}

function toSafeReasonCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const up = raw
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .slice(0, 64);
  if (!up) return null;
  return /^[A-Z]/.test(up) ? up : `R_${up}`.slice(0, 64);
}

export function createPortableComplianceService(deps: ModuleDeps) {
  function decryptAnswersForExport(ciphertext: string, submissionPublicId: string): Record<string, unknown> {
    const plain = deps.crypto.decrypt(ciphertext, `intake_submissions.answers:${submissionPublicId}`);
    const parsed = JSON.parse(plain) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  }

  /**
   * Read-only repeatable-read-safe enumeration of normative portable v3 compliance & billing evidence
   * scoped to an authorized slice of `orderIds` (order `publicId` ULIDs).
   *
   * Never acquires row locks (`FOR UPDATE`) so it runs safely inside `READ ONLY` repeatable-read snapshots,
   * never emits installation-local numeric IDs, raw IP addresses, or provider secrets/tokens, and validates
   * every emitted record against `RECORD_SCHEMAS`.
   */
  async function portableEvidence(
    tx: DbOrTx,
    orderIds: readonly string[],
    after: string | null,
    limit: number,
    opts?: PortableEvidenceOptions,
  ): Promise<PortableEvidenceBatch> {
    const includeCompliance = opts?.includeCompliance ?? true;
    const includeBilling = opts?.includeBilling ?? true;
    const boundedLimit = Math.min(Math.max(Math.trunc(limit) || 100, 1), 250);

    const uniqueSortedOrders = Array.from(new Set(orderIds)).sort();
    const startIdx =
      after === null
        ? 0
        : (() => {
            const idx = uniqueSortedOrders.findIndex((id) => id > after);
            return idx === -1 ? uniqueSortedOrders.length : idx;
          })();

    const pageOrderPublicIds = uniqueSortedOrders.slice(startIdx, startIdx + boundedLimit);
    if (pageOrderPublicIds.length === 0) {
      return {
        policyVersions: [],
        policyAcceptances: [],
        intakeDefinitions: [],
        intakeSubmissions: [],
        invoices: [],
        payments: [],
        refunds: [],
        nextCursor: null,
      };
    }

    const hasMore = startIdx + boundedLimit < uniqueSortedOrders.length;
    const nextCursor = hasMore ? pageOrderPublicIds[pageOrderPublicIds.length - 1]! : null;
    const selectedOrderSet = new Set(uniqueSortedOrders);

    // Resolve owner customer publicIds for orders referenced in compliance/billing tables
    // plus any explicit opts.customerPublicIds.
    const [subRows, invRows] = await Promise.all([
      includeCompliance
        ? tx
            .select()
            .from(intakeSubmissions)
            .where(inArray(intakeSubmissions.orderPublicId, pageOrderPublicIds))
            .orderBy(asc(intakeSubmissions.id))
        : Promise.resolve([]),
      includeBilling
        ? tx
            .select()
            .from(complianceInvoices)
            .where(inArray(complianceInvoices.orderPublicId, pageOrderPublicIds))
            .orderBy(asc(complianceInvoices.id))
        : Promise.resolve([]),
    ]);

    const internalOrderIds = new Set<number>();
    for (const s of subRows) internalOrderIds.add(s.orderId);
    for (const i of invRows) internalOrderIds.add(i.orderId);

    const ordersSvc = (deps.services as Partial<typeof deps.services>).orders;
    const ownerUserIdByOrderPublicId = new Map<string, number>();
    if (ordersSvc?.getOrderRefById) {
      for (const internalOrderId of internalOrderIds) {
        const ref = await ordersSvc.getOrderRefById(internalOrderId, tx);
        if (ref) {
          ownerUserIdByOrderPublicId.set(ref.publicId, ref.ownerUserId);
        }
      }
    }

    // Resolve customer user rows (both from order owners and explicit opts.customerPublicIds)
    const explicitCustomerPublicIds = opts?.customerPublicIds ? [...opts.customerPublicIds] : [];
    const ownerUserIds = Array.from(new Set(ownerUserIdByOrderPublicId.values()));

    const userConds = [];
    if (ownerUserIds.length > 0) userConds.push(inArray(users.id, ownerUserIds));
    if (explicitCustomerPublicIds.length > 0) userConds.push(inArray(users.publicId, explicitCustomerPublicIds));

    const userRows =
      userConds.length > 0
        ? await tx
            .select({ id: users.id, publicId: users.publicId, role: users.role })
            .from(users)
            .where(userConds.length === 1 ? userConds[0] : or(...userConds))
        : [];

    const customerPublicIdByUserId = new Map<number, string>();
    for (const u of userRows) {
      if (u.role === "customer") {
        customerPublicIdByUserId.set(u.id, u.publicId);
      }
    }

    const policyVersionRecords: RecordOf<"policy-versions">[] = [];
    const policyAcceptanceRecords: RecordOf<"policy-acceptances">[] = [];
    const intakeDefinitionRecords: RecordOf<"intake-definitions">[] = [];
    const intakeSubmissionRecords: RecordOf<"intake-submissions">[] = [];
    const invoiceRecords: RecordOf<"invoices">[] = [];
    const paymentRecords: RecordOf<"payments">[] = [];
    const refundRecords: RecordOf<"refunds">[] = [];

    /* ---- 1. Policy acceptances & closed policy versions ---- */
    if (includeCompliance) {
      const customerUserIds = Array.from(customerPublicIdByUserId.keys());
      const accConds = [inArray(policyAcceptances.orderPublicId, pageOrderPublicIds)];
      // Emit account-level acceptances (orderPublicId IS NULL) only on the first page so multi-page calls don't duplicate them
      if (after === null && customerUserIds.length > 0) {
        const accountLevelCond = and(
          inArray(policyAcceptances.userId, customerUserIds),
          isNull(policyAcceptances.orderPublicId),
        );
        if (accountLevelCond) accConds.push(accountLevelCond);
      }

      const rawAcceptances = await tx
        .select()
        .from(policyAcceptances)
        .where(accConds.length === 1 ? accConds[0] : or(...accConds))
        .orderBy(asc(policyAcceptances.id));

      // Ensure user lookup covers any order-bound acceptance user
      const missingAccUserIds = Array.from(
        new Set(rawAcceptances.map((a) => a.userId).filter((uid) => !customerPublicIdByUserId.has(uid))),
      );
      if (missingAccUserIds.length > 0) {
        const extraUsers = await tx
          .select({ id: users.id, publicId: users.publicId, role: users.role })
          .from(users)
          .where(inArray(users.id, missingAccUserIds));
        for (const u of extraUsers) {
          if (u.role === "customer") customerPublicIdByUserId.set(u.id, u.publicId);
        }
      }

      const exportableAcceptances = rawAcceptances.filter((a) => customerPublicIdByUserId.has(a.userId));
      const neededPolicyVerIds = Array.from(new Set(exportableAcceptances.map((a) => a.policyVersionId)));

      if (neededPolicyVerIds.length > 0) {
        const verRows = await tx
          .select({ ver: policyVersions, doc: policyDocuments })
          .from(policyVersions)
          .innerJoin(policyDocuments, eq(policyVersions.documentId, policyDocuments.id))
          .where(inArray(policyVersions.id, neededPolicyVerIds))
          .orderBy(asc(policyVersions.id));

        const verPublicIdById = new Map<number, string>();
        for (const { ver, doc } of verRows) {
          verPublicIdById.set(ver.id, ver.publicId);
          const rec = RECORD_SCHEMAS["policy-versions"].parse({
            publicId: ver.publicId,
            policyKey: toSafeToken(doc.slug, "policy"),
            version: ver.versionLabel.slice(0, 64),
            title: doc.title.slice(0, 500),
            contentSha256: ver.contentHash.toLowerCase(),
            contentText: ver.bodyText.slice(0, 500_000),
            effectiveAt: ver.effectiveAt.toISOString(),
            retiredAt:
              doc.currentPublishedVersionId !== null && doc.currentPublishedVersionId !== ver.id
                ? doc.updatedAt.toISOString()
                : null,
          });
          policyVersionRecords.push(rec);
        }

        for (const acc of exportableAcceptances) {
          const customerPublicId = customerPublicIdByUserId.get(acc.userId);
          const policyVersionPublicId = verPublicIdById.get(acc.policyVersionId);
          if (!customerPublicId || !policyVersionPublicId) continue;

          const safeOrderPublicId =
            acc.orderPublicId && selectedOrderSet.has(acc.orderPublicId) ? acc.orderPublicId : null;

          const rec = RECORD_SCHEMAS["policy-acceptances"].parse({
            publicId: acc.publicId,
            policyVersionPublicId,
            customerPublicId,
            orderPublicId: safeOrderPublicId,
            method: toSafeToken(acc.method, "method"),
            acceptedAt: acc.acceptedAt.toISOString(),
            evidenceNote: `sha256:${acc.versionContentHash.toLowerCase()};origin:${acc.origin}`,
          });
          policyAcceptanceRecords.push(rec);
        }
      }

      /* ---- 2. Intake submissions & closed intake definitions ---- */
      if (subRows.length > 0) {
        const neededQVerIds = Array.from(new Set(subRows.map((s) => s.questionnaireVersionId)));
        const qVerRows = await tx
          .select({ ver: intakeQuestionnaireVersions, q: intakeQuestionnaires })
          .from(intakeQuestionnaireVersions)
          .innerJoin(intakeQuestionnaires, eq(intakeQuestionnaireVersions.questionnaireId, intakeQuestionnaires.id))
          .where(inArray(intakeQuestionnaireVersions.id, neededQVerIds))
          .orderBy(asc(intakeQuestionnaireVersions.id));

        const qVerPublicIdById = new Map<number, string>();
        for (const { ver, q } of qVerRows) {
          qVerPublicIdById.set(ver.id, ver.publicId);
          const defRec = RECORD_SCHEMAS["intake-definitions"].parse({
            publicId: ver.publicId,
            key: toSafeToken(q.slug, "intake"),
            version: ver.versionNumber,
            title: q.title.slice(0, 500),
            questions: ver.fieldsJson.map((f) => ({
              key: toSafeToken(f.key, "q"),
              label: f.label.slice(0, 1000),
              kind: toSafeToken(f.type, "text"),
              required: f.required,
              options: f.options ? f.options.map((o) => o.value.slice(0, 500)) : null,
            })),
            createdAt: ver.createdAt.toISOString(),
          });
          intakeDefinitionRecords.push(defRec);
        }

        for (const sub of subRows) {
          const definitionPublicId = qVerPublicIdById.get(sub.questionnaireVersionId);
          if (!definitionPublicId) continue;

          const ownerUserId = ownerUserIdByOrderPublicId.get(sub.orderPublicId);
          const customerPublicId =
            ownerUserId !== undefined ? (customerPublicIdByUserId.get(ownerUserId) ?? null) : null;

          const rawAns = decryptAnswersForExport(sub.currentAnswersEnc, sub.publicId);
          const answersList: Array<{
            questionKey: string;
            value: string | number | boolean | null | string[];
          }> = [];
          for (const [k, v] of Object.entries(rawAns)) {
            if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
            if (
              v === null ||
              typeof v === "string" ||
              typeof v === "number" ||
              typeof v === "boolean" ||
              (Array.isArray(v) && v.every((x): x is string => typeof x === "string"))
            ) {
              answersList.push({
                questionKey: toSafeToken(k, "q"),
                value: typeof v === "string" ? v.slice(0, 20_000) : v,
              });
            }
          }

          const subRec = RECORD_SCHEMAS["intake-submissions"].parse({
            publicId: sub.publicId,
            definitionPublicId,
            orderPublicId: sub.orderPublicId,
            customerPublicId,
            status: toSafeToken(sub.status, "draft"),
            answers: answersList,
            submittedAt: sub.submittedAt ? sub.submittedAt.toISOString() : null,
          });
          intakeSubmissionRecords.push(subRec);
        }
      }
    }

    /* ---- 3. Invoices, payments & refunds ---- */
    if (includeBilling && invRows.length > 0) {
      // Export issued/paid/void invoices (drafts are internal pre-issuance work, not customer billing evidence)
      const exportableInvoices = invRows.filter((inv) => inv.issuedAt !== null || inv.origin === "import");
      if (exportableInvoices.length > 0) {
        const invIds = exportableInvoices.map((i) => i.id);
        const [lineRows, pmtRows, rfdRows] = await Promise.all([
          tx
            .select()
            .from(complianceInvoiceLines)
            .where(inArray(complianceInvoiceLines.invoiceId, invIds))
            .orderBy(asc(complianceInvoiceLines.invoiceId), asc(complianceInvoiceLines.position)),
          tx
            .select()
            .from(complianceInvoicePayments)
            .where(inArray(complianceInvoicePayments.invoiceId, invIds))
            .orderBy(asc(complianceInvoicePayments.id)),
          tx
            .select()
            .from(complianceInvoiceRefunds)
            .where(inArray(complianceInvoiceRefunds.invoiceId, invIds))
            .orderBy(asc(complianceInvoiceRefunds.id)),
        ]);

        const linesByInv = new Map<number, (typeof complianceInvoiceLines.$inferSelect)[]>();
        for (const l of lineRows) {
          const arr = linesByInv.get(l.invoiceId) ?? [];
          arr.push(l);
          linesByInv.set(l.invoiceId, arr);
        }

        const pmtsByInv = new Map<number, (typeof complianceInvoicePayments.$inferSelect)[]>();
        const pmtById = new Map<number, typeof complianceInvoicePayments.$inferSelect>();
        for (const p of pmtRows) {
          pmtById.set(p.id, p);
          const arr = pmtsByInv.get(p.invoiceId) ?? [];
          arr.push(p);
          pmtsByInv.set(p.invoiceId, arr);
        }

        const rfdsByInv = new Map<number, (typeof complianceInvoiceRefunds.$inferSelect)[]>();
        for (const r of rfdRows) {
          const arr = rfdsByInv.get(r.invoiceId) ?? [];
          arr.push(r);
          rfdsByInv.set(r.invoiceId, arr);
        }

        for (const inv of exportableInvoices) {
          const ownerUserId = ownerUserIdByOrderPublicId.get(inv.orderPublicId);
          const customerPublicId =
            ownerUserId !== undefined ? customerPublicIdByUserId.get(ownerUserId) : undefined;
          if (!customerPublicId) continue;

          const invLines = linesByInv.get(inv.id) ?? [];
          const invPmts = pmtsByInv.get(inv.id) ?? [];
          const invRfds = rfdsByInv.get(inv.id) ?? [];

          const grossPaidMinor = invPmts
            .filter((p) => p.status === "succeeded")
            .reduce((s, p) => s + p.amountMinor, 0);
          const refundedMinor = invRfds.reduce((s, r) => s + r.amountMinor, 0);
          const derivedStatus = deriveInvoiceStatus({
            issuedAt: inv.issuedAt,
            voidedAt: inv.voidedAt,
            totalMinor: inv.totalMinor,
            grossPaidMinor,
            refundedMinor,
          });

          const invRec = RECORD_SCHEMAS.invoices.parse({
            publicId: inv.publicId,
            customerPublicId,
            orderPublicId: inv.orderPublicId,
            invoiceNumber: (inv.invoiceNumber ?? `INV-${inv.publicId.slice(-8)}`).slice(0, 64),
            status: toSafeToken(derivedStatus, "issued"),
            currency: inv.currency,
            lines: invLines.map((l) => ({
              description: l.description.slice(0, 500),
              quantity: l.quantity,
              unitPrice: { amountMinor: l.unitAmountMinor, currency: inv.currency },
              total: { amountMinor: l.lineTotalMinor, currency: inv.currency },
            })),
            subtotal: { amountMinor: inv.subtotalMinor, currency: inv.currency },
            tax: { amountMinor: inv.taxMinor, currency: inv.currency },
            total: { amountMinor: inv.totalMinor, currency: inv.currency },
            issuedAt: inv.issuedAt ? inv.issuedAt.toISOString() : null,
            dueAt: inv.dueAt ? inv.dueAt.toISOString() : null,
            providerReference: null,
            ...(inv.discountMinor > 0 ? { heldUnknown: { discountMinor: inv.discountMinor } } : {}),
          });
          invoiceRecords.push(invRec);

          for (const pmt of invPmts) {
            const pmtRec = RECORD_SCHEMAS.payments.parse({
              publicId: pmt.publicId,
              customerPublicId,
              invoicePublicId: inv.publicId,
              orderPublicId: inv.orderPublicId,
              amount: { amountMinor: pmt.amountMinor, currency: pmt.currency },
              method: toSafeToken(pmt.method, "manual"),
              status: toSafeToken(pmt.status, "succeeded"),
              receivedAt: pmt.receivedAt.toISOString(),
              providerReference: pmt.provider
                ? { provider: toSafeToken(pmt.provider, "provider"), reference: pmt.reference.slice(0, 128) }
                : { provider: "manual", reference: pmt.reference.slice(0, 128) },
            });
            paymentRecords.push(pmtRec);
          }

          for (const rfd of invRfds) {
            const parentPmt = pmtById.get(rfd.paymentId);
            if (!parentPmt) continue;
            const rfdRec = RECORD_SCHEMAS.refunds.parse({
              publicId: rfd.publicId,
              paymentPublicId: parentPmt.publicId,
              amount: { amountMinor: rfd.amountMinor, currency: rfd.currency },
              status: "succeeded",
              reasonCode: toSafeReasonCode(rfd.reasonCode),
              refundedAt: rfd.refundedAt.toISOString(),
              providerReference: rfd.provider
                ? { provider: toSafeToken(rfd.provider, "provider"), reference: rfd.reference.slice(0, 128) }
                : { provider: "manual", reference: rfd.reference.slice(0, 128) },
            });
            refundRecords.push(rfdRec);
          }
        }
      }
    }

    return {
      policyVersions: policyVersionRecords,
      policyAcceptances: policyAcceptanceRecords,
      intakeDefinitions: intakeDefinitionRecords,
      intakeSubmissions: intakeSubmissionRecords,
      invoices: invoiceRecords,
      payments: paymentRecords,
      refunds: refundRecords,
      nextCursor,
    };
  }

  /**
   * Imports historical compliance & billing evidence inside `tx` with explicit provenance (`origin = "import"`).
   * - Never promotes imported policy versions to active required portal policies (`currentPublishedVersionId` untouched).
   * - Never treats imported acceptances as live consent (`origin = "import"` is ignored by `requiredAcceptancesFor`).
   * - Never replays emails, notifications, or payment provider calls.
   * - Generates fresh local ULIDs and stores `sourcePublicId` + `sourceInstallationId` + `importId`.
   */
  async function importPortableEvidence(
    input: ImportPortableEvidenceInput,
    tx: Tx,
  ): Promise<ImportPortableEvidenceReceipt> {
    if (!input.importId || !input.sourceInstallationId) {
      throw validation("INVALID_IMPORT_PROVENANCE", "importId and sourceInstallationId are required.");
    }
    const now = deps.clock.now();

    let importedPolicyVersions = 0;
    let importedPolicyAcceptances = 0;
    let importedIntakeDefinitions = 0;
    let importedIntakeSubmissions = 0;
    let importedInvoices = 0;
    let importedPayments = 0;
    let importedRefunds = 0;

    // 1. Policy versions (stored inertly under origin="import")
    const localPolicyVerBySourceId = new Map<string, { id: number; documentId: number; contentHash: string }>();
    for (const rawPv of input.policyVersions ?? []) {
      const pv = RECORD_SCHEMAS["policy-versions"].parse(rawPv);
      const bodyText = normalizePolicyBody(pv.contentText ?? `[Imported policy ${pv.policyKey} ${pv.version}]`);
      const actualHash = pv.contentText ? hashPolicyContent(bodyText) : pv.contentSha256;
      const recordedHash = pv.contentSha256.toLowerCase();

      const importSlug = toSafeToken(`imp-${pv.policyKey}`, "imp-policy").replace(/[^a-z0-9-]/g, "-").slice(0, 64);
      let [doc] = await tx
        .select()
        .from(policyDocuments)
        .where(eq(policyDocuments.slug, importSlug))
        .limit(1);

      if (!doc) {
        const docPubId = ulid(now.getTime());
        const [ins] = await tx.insert(policyDocuments).values({
          publicId: docPubId,
          slug: importSlug,
          title: pv.title.slice(0, 160),
          audience: "customer",
          requiresAcceptance: false,
          requiresTypedSignature: false,
          active: false, // Inactive so imported historical policies never gate portal users
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
        const [loaded] = await tx.select().from(policyDocuments).where(eq(policyDocuments.id, ins.insertId)).limit(1);
        doc = loaded!;
      }

      const [existingVer] = await tx
        .select()
        .from(policyVersions)
        .where(
          and(
            eq(policyVersions.sourceInstallationId, input.sourceInstallationId),
            eq(policyVersions.sourcePublicId, pv.publicId),
          ),
        )
        .limit(1);

      if (existingVer) {
        localPolicyVerBySourceId.set(pv.publicId, {
          id: existingVer.id,
          documentId: doc.id,
          contentHash: existingVer.contentHash,
        });
        continue;
      }

      const existingCount = await tx
        .select({ versionNumber: policyVersions.versionNumber })
        .from(policyVersions)
        .where(eq(policyVersions.documentId, doc.id));
      const nextNum = existingCount.reduce((m, r) => Math.max(m, r.versionNumber), 0) + 1;
      const verPubId = ulid(now.getTime());

      const [verIns] = await tx.insert(policyVersions).values({
        publicId: verPubId,
        documentId: doc.id,
        versionNumber: nextNum,
        versionLabel: `${pv.version.slice(0, 20)}-${nextNum}`,
        status: "published",
        contentFormat: "plain_text",
        bodyText,
        contentHash: recordedHash || actualHash,
        effectiveAt: new Date(pv.effectiveAt),
        publishedAt: new Date(pv.effectiveAt),
        origin: "import",
        importId: input.importId,
        sourceInstallationId: input.sourceInstallationId,
        sourcePublicId: pv.publicId,
        createdAt: now,
        updatedAt: now,
      });

      localPolicyVerBySourceId.set(pv.publicId, {
        id: verIns.insertId,
        documentId: doc.id,
        contentHash: recordedHash || actualHash,
      });
      importedPolicyVersions += 1;
    }

    // 2. Policy acceptances (origin="import" — historical evidence only, never satisfies live requiredAcceptancesFor)
    for (const rawPa of input.policyAcceptances ?? []) {
      const pa = RECORD_SCHEMAS["policy-acceptances"].parse(rawPa);
      const localUserId = input.customerIdBySourcePublicId.get(pa.customerPublicId);
      const localPv = localPolicyVerBySourceId.get(pa.policyVersionPublicId);
      if (!localUserId || !localPv) continue;

      const [dup] = await tx
        .select({ id: policyAcceptances.id })
        .from(policyAcceptances)
        .where(
          and(
            eq(policyAcceptances.sourceInstallationId, input.sourceInstallationId),
            eq(policyAcceptances.sourcePublicId, pa.publicId),
          ),
        )
        .limit(1);
      if (dup) continue;

      const mappedOrder = pa.orderPublicId ? input.orderBySourcePublicId.get(pa.orderPublicId) : undefined;
      const accPubId = ulid(now.getTime());

      await tx.insert(policyAcceptances).values({
        publicId: accPubId,
        userId: localUserId,
        documentId: localPv.documentId,
        policyVersionId: localPv.id,
        versionContentHash: localPv.contentHash,
        acceptedAt: new Date(pa.acceptedAt),
        requestId: `imp-${input.importId}`.slice(0, 64),
        sourceAddressPseudonym: null,
        method: "imported_historical",
        orderId: mappedOrder?.id ?? null,
        orderPublicId: mappedOrder?.publicId ?? null,
        origin: "import",
        importId: input.importId,
        sourceInstallationId: input.sourceInstallationId,
        sourcePublicId: pa.publicId,
        createdAt: now,
      });
      importedPolicyAcceptances += 1;
    }

    // 3. Intake definitions
    const localIntakeVerBySourceId = new Map<string, { versionId: number; questionnaireId: number }>();
    for (const rawDef of input.intakeDefinitions ?? []) {
      const def = RECORD_SCHEMAS["intake-definitions"].parse(rawDef);
      const importSlug = toSafeToken(`imp-${def.key}`, "imp-intake").replace(/[^a-z0-9-]/g, "-").slice(0, 64);

      let [q] = await tx
        .select()
        .from(intakeQuestionnaires)
        .where(eq(intakeQuestionnaires.slug, importSlug))
        .limit(1);

      if (!q) {
        const qPubId = ulid(now.getTime());
        const [qIns] = await tx.insert(intakeQuestionnaires).values({
          publicId: qPubId,
          slug: importSlug,
          title: def.title.slice(0, 160),
          scopeKind: "default",
          active: false, // Historical definition only
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
        const [loaded] = await tx.select().from(intakeQuestionnaires).where(eq(intakeQuestionnaires.id, qIns.insertId)).limit(1);
        q = loaded!;
      }

      const [existingVer] = await tx
        .select()
        .from(intakeQuestionnaireVersions)
        .where(
          and(
            eq(intakeQuestionnaireVersions.sourceInstallationId, input.sourceInstallationId),
            eq(intakeQuestionnaireVersions.sourcePublicId, def.publicId),
          ),
        )
        .limit(1);

      if (existingVer) {
        localIntakeVerBySourceId.set(def.publicId, { versionId: existingVer.id, questionnaireId: q.id });
        continue;
      }

      const mappedFields: StoredIntakeFieldDef[] = canonicalizeIntakeFields(
        def.questions.slice(0, 40).map((question) => {
          const kind =
            question.kind === "long_text" ||
            question.kind === "single_choice" ||
            question.kind === "multi_choice" ||
            question.kind === "date" ||
            question.kind === "number"
              ? question.kind
              : "short_text";
          return {
            key: question.key.replace(/[^a-z0-9_]/g, "_").slice(0, 64) || "field_1",
            label: question.label.slice(0, 240),
            type: kind,
            required: question.required,
            sensitive: true,
            ...(question.options
              ? { options: question.options.slice(0, 50).map((o) => ({ value: o.slice(0, 64), label: o.slice(0, 160) })) }
              : {}),
          };
        }),
      );

      const fieldsToStore: StoredIntakeFieldDef[] =
        mappedFields.length > 0
          ? mappedFields
          : [{ key: "imported_notes", label: "Imported Notes", type: "long_text", required: false, sensitive: true }];

      const existingCount = await tx
        .select({ versionNumber: intakeQuestionnaireVersions.versionNumber })
        .from(intakeQuestionnaireVersions)
        .where(eq(intakeQuestionnaireVersions.questionnaireId, q.id));
      const nextNum = existingCount.reduce((m, r) => Math.max(m, r.versionNumber), 0) + 1;
      const verPubId = ulid(now.getTime());

      const [verIns] = await tx.insert(intakeQuestionnaireVersions).values({
        publicId: verPubId,
        questionnaireId: q.id,
        versionNumber: nextNum,
        status: "published",
        fieldsJson: fieldsToStore,
        schemaHash: hashQuestionnaireFields(fieldsToStore),
        publishedAt: new Date(def.createdAt),
        origin: "import",
        importId: input.importId,
        sourceInstallationId: input.sourceInstallationId,
        sourcePublicId: def.publicId,
        createdAt: new Date(def.createdAt),
        updatedAt: now,
      });

      localIntakeVerBySourceId.set(def.publicId, { versionId: verIns.insertId, questionnaireId: q.id });
      importedIntakeDefinitions += 1;
    }

    // 4. Intake submissions
    for (const rawSub of input.intakeSubmissions ?? []) {
      const sub = RECORD_SCHEMAS["intake-submissions"].parse(rawSub);
      const localDef = localIntakeVerBySourceId.get(sub.definitionPublicId);
      const localOrder = input.orderBySourcePublicId.get(sub.orderPublicId);
      if (!localDef || !localOrder) continue;

      const [dup] = await tx
        .select({ id: intakeSubmissions.id })
        .from(intakeSubmissions)
        .where(
          and(
            eq(intakeSubmissions.sourceInstallationId, input.sourceInstallationId),
            eq(intakeSubmissions.sourcePublicId, sub.publicId),
          ),
        )
        .limit(1);
      if (dup) continue;

      const answerObj: Record<string, unknown> = {};
      for (const ans of sub.answers) {
        if (ans.questionKey !== "__proto__" && ans.questionKey !== "constructor" && ans.questionKey !== "prototype") {
          answerObj[ans.questionKey] = ans.value;
        }
      }

      const subPubId = ulid(now.getTime());
      const revPubId = ulid(now.getTime());
      const status =
        sub.status === "submitted" || sub.status === "returned_for_changes" || sub.status === "accepted"
          ? sub.status
          : "draft";
      const submittedAt = sub.submittedAt ? new Date(sub.submittedAt) : null;

      const [subIns] = await tx.insert(intakeSubmissions).values({
        publicId: subPubId,
        orderId: localOrder.id,
        orderPublicId: localOrder.publicId,
        questionnaireId: localDef.questionnaireId,
        questionnaireVersionId: localDef.versionId,
        status,
        revisionNumber: 1,
        currentAnswersEnc: deps.crypto.encrypt(JSON.stringify(answerObj), `intake_submissions.answers:${subPubId}`),
        submittedAt,
        origin: "import",
        importId: input.importId,
        sourceInstallationId: input.sourceInstallationId,
        sourcePublicId: sub.publicId,
        version: 1,
        createdAt: submittedAt ?? now,
        updatedAt: now,
      });

      await tx.insert(intakeSubmissionRevisions).values({
        publicId: revPubId,
        submissionId: subIns.insertId,
        revisionNumber: 1,
        eventKind: "imported",
        actorRole: "system",
        answersEnc: deps.crypto.encrypt(JSON.stringify(answerObj), `intake_submission_revisions.answers:${revPubId}`),
        occurredAt: submittedAt ?? now,
      });

      importedIntakeSubmissions += 1;
    }

    // 5. Invoices, payments & refunds
    const localInvBySourceId = new Map<string, { id: number; publicId: string; currency: string; totalMinor: number; issuedAt: Date | null; voidedAt: Date | null }>();
    for (const rawInv of input.invoices ?? []) {
      const inv = RECORD_SCHEMAS.invoices.parse(rawInv);
      if (!inv.orderPublicId) continue;
      const localOrder = input.orderBySourcePublicId.get(inv.orderPublicId);
      if (!localOrder) continue;

      const [dup] = await tx
        .select()
        .from(complianceInvoices)
        .where(
          and(
            eq(complianceInvoices.sourceInstallationId, input.sourceInstallationId),
            eq(complianceInvoices.sourcePublicId, inv.publicId),
          ),
        )
        .limit(1);
      if (dup) {
        localInvBySourceId.set(inv.publicId, {
          id: dup.id,
          publicId: dup.publicId,
          currency: dup.currency,
          totalMinor: dup.totalMinor,
          issuedAt: dup.issuedAt,
          voidedAt: dup.voidedAt,
        });
        continue;
      }

      const invPubId = ulid(now.getTime());
      const safeInvNumber = `IMP-${inv.invoiceNumber.slice(0, 28)}-${invPubId.slice(-6)}`.slice(0, 40);
      const issuedAt = inv.issuedAt ? new Date(inv.issuedAt) : now;
      const voidedAt = inv.status === "void" ? now : null;
      const status = inv.status === "void" ? "void" : inv.status === "paid" ? "paid" : "issued";
      const discountMinor = Math.max(0, inv.subtotal.amountMinor + inv.tax.amountMinor - inv.total.amountMinor);

      const [invIns] = await tx.insert(complianceInvoices).values({
        publicId: invPubId,
        orderId: localOrder.id,
        orderPublicId: localOrder.publicId,
        invoiceNumber: safeInvNumber,
        status,
        currency: inv.currency,
        subtotalMinor: inv.subtotal.amountMinor,
        discountMinor,
        taxMinor: inv.tax.amountMinor,
        totalMinor: inv.total.amountMinor,
        issuedAt,
        dueAt: inv.dueAt ? new Date(inv.dueAt) : null,
        voidedAt,
        origin: "import",
        importId: input.importId,
        sourceInstallationId: input.sourceInstallationId,
        sourcePublicId: inv.publicId,
        version: 1,
        createdAt: issuedAt,
        updatedAt: now,
      });

      if (inv.lines.length > 0) {
        await tx.insert(complianceInvoiceLines).values(
          inv.lines.map((line, idx) => ({
            publicId: ulid(now.getTime()),
            invoiceId: invIns.insertId,
            position: idx + 1,
            description: line.description.slice(0, 240),
            quantity: line.quantity,
            unitAmountMinor: line.unitPrice.amountMinor,
            lineTotalMinor: line.total.amountMinor,
          })),
        );
      }

      localInvBySourceId.set(inv.publicId, {
        id: invIns.insertId,
        publicId: invPubId,
        currency: inv.currency,
        totalMinor: inv.total.amountMinor,
        issuedAt,
        voidedAt,
      });
      importedInvoices += 1;
    }

    const localPmtBySourceId = new Map<string, { id: number; invoiceId: number }>();
    for (const rawPmt of input.payments ?? []) {
      const pmt = RECORD_SCHEMAS.payments.parse(rawPmt);
      if (!pmt.invoicePublicId) continue;
      const localInv = localInvBySourceId.get(pmt.invoicePublicId);
      if (!localInv) continue;

      const [dup] = await tx
        .select()
        .from(complianceInvoicePayments)
        .where(
          and(
            eq(complianceInvoicePayments.sourceInstallationId, input.sourceInstallationId),
            eq(complianceInvoicePayments.sourcePublicId, pmt.publicId),
          ),
        )
        .limit(1);
      if (dup) {
        localPmtBySourceId.set(pmt.publicId, { id: dup.id, invoiceId: dup.invoiceId });
        continue;
      }

      const pmtPubId = ulid(now.getTime());
      const pmtStatus = pmt.status === "failed" ? "failed" : "succeeded";
      const [pmtIns] = await tx.insert(complianceInvoicePayments).values({
        publicId: pmtPubId,
        invoiceId: localInv.id,
        method: "imported_historical",
        status: pmtStatus,
        amountMinor: pmt.amount.amountMinor,
        currency: pmt.amount.currency,
        reference: (pmt.providerReference?.reference ?? pmt.publicId).slice(0, 128),
        provider: pmt.providerReference?.provider ? pmt.providerReference.provider.slice(0, 32) : null,
        receivedAt: pmt.receivedAt ? new Date(pmt.receivedAt) : now,
        idempotencyKey: `imp:${input.importId}:${pmt.publicId}`.slice(0, 128),
        origin: "import",
        importId: input.importId,
        sourceInstallationId: input.sourceInstallationId,
        sourcePublicId: pmt.publicId,
        createdAt: now,
      });

      localPmtBySourceId.set(pmt.publicId, { id: pmtIns.insertId, invoiceId: localInv.id });
      importedPayments += 1;
    }

    for (const rawRfd of input.refunds ?? []) {
      const rfd = RECORD_SCHEMAS.refunds.parse(rawRfd);
      const localPmt = localPmtBySourceId.get(rfd.paymentPublicId);
      if (!localPmt) continue;

      const [dup] = await tx
        .select({ id: complianceInvoiceRefunds.id })
        .from(complianceInvoiceRefunds)
        .where(
          and(
            eq(complianceInvoiceRefunds.sourceInstallationId, input.sourceInstallationId),
            eq(complianceInvoiceRefunds.sourcePublicId, rfd.publicId),
          ),
        )
        .limit(1);
      if (dup) continue;

      const rfdPubId = ulid(now.getTime());
      await tx.insert(complianceInvoiceRefunds).values({
        publicId: rfdPubId,
        invoiceId: localPmt.invoiceId,
        paymentId: localPmt.id,
        amountMinor: rfd.amount.amountMinor,
        currency: rfd.amount.currency,
        reasonCode: (rfd.reasonCode ?? "IMPORTED_REFUND").slice(0, 64),
        reference: (rfd.providerReference?.reference ?? rfd.publicId).slice(0, 128),
        provider: rfd.providerReference?.provider ? rfd.providerReference.provider.slice(0, 32) : null,
        refundedAt: rfd.refundedAt ? new Date(rfd.refundedAt) : now,
        idempotencyKey: `imp:${input.importId}:${rfd.publicId}`.slice(0, 128),
        origin: "import",
        importId: input.importId,
        sourceInstallationId: input.sourceInstallationId,
        sourcePublicId: rfd.publicId,
        createdAt: now,
      });

      importedRefunds += 1;
    }

    await deps.audit.record(
      {
        category: "portable_transfer",
        eventName: "compliance.evidence.imported",
        action: "import",
        outcome: "completed",
        actor: { role: "system" },
        attributes: {
          import_id: input.importId,
        },
        safeCounts: {
          imported_policy_versions: importedPolicyVersions,
          imported_policy_acceptances: importedPolicyAcceptances,
          imported_intake_definitions: importedIntakeDefinitions,
          imported_intake_submissions: importedIntakeSubmissions,
          imported_invoices: importedInvoices,
          imported_payments: importedPayments,
          imported_refunds: importedRefunds,
        },
      },
      tx,
    );

    return {
      importedPolicyVersions,
      importedPolicyAcceptances,
      importedIntakeDefinitions,
      importedIntakeSubmissions,
      importedInvoices,
      importedPayments,
      importedRefunds,
    };
  }

  return {
    portableEvidence,
    importPortableEvidence,
  };
}

export type PortableComplianceService = ReturnType<typeof createPortableComplianceService>;
