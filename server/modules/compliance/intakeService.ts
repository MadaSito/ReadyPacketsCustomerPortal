import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { roleHasCapability } from "../../../shared/capabilities.js";
import type { ModuleDeps } from "../../container.js";
import { conflict, DomainError, forbidden, notFound, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { SessionPrincipal, Tx } from "../../core/types.js";
import { assertLiveActorInTx } from "./actorAuth.js";
import {
  canonicalizeIntakeFields,
  hashQuestionnaireFields,
  validateIntakeAnswers,
  type IntakeAnswerMap,
} from "./domain.js";
import {
  intakeQuestionnaires,
  intakeQuestionnaireVersions,
  intakeSubmissionRevisions,
  intakeSubmissions,
  type IntakeRevisionEvent,
  type IntakeScopeKind,
  type IntakeSubmissionStatus,
  type StoredIntakeFieldDef,
} from "./schema.js";

export interface QuestionnaireVersionView {
  versionPublicId: string;
  versionNumber: number;
  status: "draft" | "published";
  fields: StoredIntakeFieldDef[];
  schemaHash: string;
  publishedAt: Date | null;
  origin: "portal" | "import";
  createdAt: Date;
}

export interface QuestionnaireAdminSummary {
  questionnairePublicId: string;
  slug: string;
  title: string;
  description: string | null;
  scopeKind: IntakeScopeKind;
  scopeRef: string | null;
  active: boolean;
  version: number;
  currentPublishedVersion: {
    versionPublicId: string;
    versionNumber: number;
    schemaHash: string;
    fieldCount: number;
    publishedAt: Date | null;
  } | null;
  draftVersionPublicId: string | null;
  updatedAt: Date;
}

export interface OrderIntakeItemView {
  questionnairePublicId: string;
  slug: string;
  title: string;
  description: string | null;
  scopeKind: IntakeScopeKind;
  scopeRef: string | null;
  boundVersion: {
    versionPublicId: string;
    versionNumber: number;
    schemaHash: string;
    fields: StoredIntakeFieldDef[];
  };
  submission: {
    submissionPublicId: string;
    status: IntakeSubmissionStatus;
    revisionNumber: number;
    answers: IntakeAnswerMap;
    latestReviewNote: string | null;
    submittedAt: Date | null;
    reviewedAt: Date | null;
    origin: "portal" | "import";
    updatedAt: Date;
  } | null;
  canWrite: boolean;
  canReview: boolean;
}

export interface IntakeRevisionView {
  revisionPublicId: string;
  revisionNumber: number;
  eventKind: IntakeRevisionEvent;
  actorRole: "customer" | "staff" | "admin" | "system";
  answers: IntakeAnswerMap;
  reviewNote: string | null;
  occurredAt: Date;
}

function assertIntakeAdminRead(principal: SessionPrincipal): void {
  if (principal.state !== "full" || principal.pendingSteps.length > 0) {
    throw forbidden("REMEDIATION_SESSION");
  }
  if (!roleHasCapability(principal.role, "intake.manage")) {
    throw forbidden("CAPABILITY_NOT_GRANTED");
  }
}

export function createIntakeService(deps: ModuleDeps) {
  function encryptAnswers(answers: IntakeAnswerMap, contextSuffix: string): string {
    return deps.crypto.encrypt(JSON.stringify(answers), contextSuffix);
  }

  function decryptAnswers(ciphertext: string, contextSuffix: string): IntakeAnswerMap {
    const plain = deps.crypto.decrypt(ciphertext, contextSuffix);
    const parsed = JSON.parse(plain) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const safe: IntakeAnswerMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      if (
        v === null ||
        typeof v === "string" ||
        typeof v === "number" ||
        (Array.isArray(v) && v.every((x): x is string => typeof x === "string"))
      ) {
        safe[k] = v;
      }
    }
    return safe;
  }

  function requireOrdersService() {
    const ordersSvc = (deps.services as Partial<typeof deps.services>).orders;
    if (!ordersSvc) {
      throw new DomainError("UNAVAILABLE", "ORDERS_UNAVAILABLE", "Order service is temporarily unavailable.");
    }
    return ordersSvc;
  }

  async function resolveOrderProductPublicIds(
    principal: SessionPrincipal,
    orderPublicId: string,
  ): Promise<Set<string>> {
    const ordersSvc = requireOrdersService();
    const productIds = new Set<string>();
    if (ordersSvc.orders && typeof ordersSvc.orders.get === "function") {
      const detail = await ordersSvc.orders.get(principal, orderPublicId);
      for (const item of detail.lineItems) {
        if (item.productPublicId) productIds.add(item.productPublicId);
      }
    }
    return productIds;
  }

  function questionnaireMatchesOrder(
    q: typeof intakeQuestionnaires.$inferSelect,
    productPublicIds: ReadonlySet<string>,
  ): boolean {
    if (!q.active) return false;
    if (q.scopeKind === "default") return true;
    if (q.scopeKind === "catalog_item") {
      return q.scopeRef !== null && productPublicIds.has(q.scopeRef);
    }
    // Workflow-scoped questionnaires match when scopeRef is explicitly matched or default fallback
    return false;
  }

  async function listForOrder(
    principal: SessionPrincipal,
    orderPublicId: string,
  ): Promise<{
    orderPublicId: string;
    orderReference: string;
    lockState: string;
    items: OrderIntakeItemView[];
  }> {
    const ordersSvc = requireOrdersService();
    const orderView = await ordersSvc.assertCanReadOrder(principal, orderPublicId);
    const productPublicIds = await resolveOrderProductPublicIds(principal, orderPublicId);

    const [allQuestionnaires, existingSubs] = await Promise.all([
      deps.db.select().from(intakeQuestionnaires).orderBy(asc(intakeQuestionnaires.slug)),
      deps.db
        .select()
        .from(intakeSubmissions)
        .where(eq(intakeSubmissions.orderId, orderView.id))
        .orderBy(asc(intakeSubmissions.id)),
    ]);

    const subByQuestionnaireId = new Map<number, typeof intakeSubmissions.$inferSelect>();
    for (const sub of existingSubs) {
      subByQuestionnaireId.set(sub.questionnaireId, sub);
    }

    const applicableQuestionnaires = allQuestionnaires.filter(
      (q) =>
        subByQuestionnaireId.has(q.id) ||
        (q.currentPublishedVersionId !== null && questionnaireMatchesOrder(q, productPublicIds)),
    );

    if (applicableQuestionnaires.length === 0) {
      return {
        orderPublicId: orderView.publicId,
        orderReference: orderView.reference,
        lockState: orderView.lockState,
        items: [],
      };
    }

    const neededVersionIds = new Set<number>();
    for (const q of applicableQuestionnaires) {
      const sub = subByQuestionnaireId.get(q.id);
      if (sub) neededVersionIds.add(sub.questionnaireVersionId);
      else if (q.currentPublishedVersionId !== null) neededVersionIds.add(q.currentPublishedVersionId);
    }

    const versions =
      neededVersionIds.size > 0
        ? await deps.db
            .select()
            .from(intakeQuestionnaireVersions)
            .where(inArray(intakeQuestionnaireVersions.id, Array.from(neededVersionIds)))
        : [];
    const versionById = new Map(versions.map((v) => [v.id, v]));

    // Fetch latest review notes for submissions that were returned or accepted
    const subIds = existingSubs.map((s) => s.id);
    const revisions =
      subIds.length > 0
        ? await deps.db
            .select()
            .from(intakeSubmissionRevisions)
            .where(inArray(intakeSubmissionRevisions.submissionId, subIds))
            .orderBy(desc(intakeSubmissionRevisions.revisionNumber))
        : [];
    const latestNoteBySubId = new Map<number, string | null>();
    for (const rev of revisions) {
      if (!latestNoteBySubId.has(rev.submissionId) && rev.noteEnc) {
        latestNoteBySubId.set(
          rev.submissionId,
          deps.crypto.decrypt(rev.noteEnc, `intake_submission_revisions.note:${rev.publicId}`),
        );
      }
    }

    const orderAllowsIntakeWrite =
      orderView.lockState === "none" &&
      !orderView.readOnlyImported &&
      (orderView.accessRole === "owner" ||
        orderView.accessRole === "contributor" ||
        orderView.accessRole === "staff" ||
        orderView.accessRole === "admin");

    const actorCanReview =
      orderView.lockState === "none" &&
      !orderView.readOnlyImported &&
      roleHasCapability(principal.role, "intake.review");

    const items: OrderIntakeItemView[] = [];
    for (const q of applicableQuestionnaires) {
      const sub = subByQuestionnaireId.get(q.id) ?? null;
      const versionId = sub ? sub.questionnaireVersionId : q.currentPublishedVersionId;
      if (!versionId) continue;
      const ver = versionById.get(versionId);
      if (!ver) continue;

      const editableStatus =
        sub === null || sub.status === "draft" || sub.status === "returned_for_changes";

      items.push({
        questionnairePublicId: q.publicId,
        slug: q.slug,
        title: q.title,
        description: q.description,
        scopeKind: q.scopeKind,
        scopeRef: q.scopeRef,
        boundVersion: {
          versionPublicId: ver.publicId,
          versionNumber: ver.versionNumber,
          schemaHash: ver.schemaHash,
          fields: ver.fieldsJson,
        },
        submission: sub
          ? {
              submissionPublicId: sub.publicId,
              status: sub.status,
              revisionNumber: sub.revisionNumber,
              answers: decryptAnswers(sub.currentAnswersEnc, `intake_submissions.answers:${sub.publicId}`),
              latestReviewNote: latestNoteBySubId.get(sub.id) ?? null,
              submittedAt: sub.submittedAt,
              reviewedAt: sub.reviewedAt,
              origin: sub.origin,
              updatedAt: sub.updatedAt,
            }
          : null,
        canWrite: orderAllowsIntakeWrite && editableStatus && (sub?.origin ?? "portal") === "portal",
        canReview: actorCanReview && sub?.status === "submitted" && sub.origin === "portal",
      });
    }

    return {
      orderPublicId: orderView.publicId,
      orderReference: orderView.reference,
      lockState: orderView.lockState,
      items,
    };
  }

  async function getSubmission(
    principal: SessionPrincipal,
    input: { orderPublicId: string; questionnairePublicId: string },
  ): Promise<{
    item: OrderIntakeItemView;
    revisions: IntakeRevisionView[];
  }> {
    const listed = await listForOrder(principal, input.orderPublicId);
    const item = listed.items.find((i) => i.questionnairePublicId === input.questionnairePublicId);
    if (!item) throw notFound("INTAKE_QUESTIONNAIRE_NOT_FOUND");

    if (!item.submission) {
      return { item, revisions: [] };
    }

    const [subRow] = await deps.db
      .select({ id: intakeSubmissions.id })
      .from(intakeSubmissions)
      .where(eq(intakeSubmissions.publicId, item.submission.submissionPublicId))
      .limit(1);
    if (!subRow) return { item, revisions: [] };

    const revs = await deps.db
      .select()
      .from(intakeSubmissionRevisions)
      .where(eq(intakeSubmissionRevisions.submissionId, subRow.id))
      .orderBy(desc(intakeSubmissionRevisions.revisionNumber));

    return {
      item,
      revisions: revs.map((r) => ({
        revisionPublicId: r.publicId,
        revisionNumber: r.revisionNumber,
        eventKind: r.eventKind,
        actorRole: r.actorRole,
        answers: decryptAnswers(r.answersEnc, `intake_submission_revisions.answers:${r.publicId}`),
        reviewNote: r.noteEnc
          ? deps.crypto.decrypt(r.noteEnc, `intake_submission_revisions.note:${r.publicId}`)
          : null,
        occurredAt: r.occurredAt,
      })),
    };
  }

  async function writeSubmissionInTx(
    tx: Tx,
    principal: SessionPrincipal,
    input: {
      orderPublicId: string;
      questionnairePublicId: string;
      answers: IntakeAnswerMap;
      mode: "draft" | "submit";
    },
  ): Promise<{
    submissionPublicId: string;
    status: IntakeSubmissionStatus;
    revisionNumber: number;
  }> {
    const liveActor = await assertLiveActorInTx(deps, principal, tx);
    const livePrincipal: SessionPrincipal = { ...principal, role: liveActor.role };
    const ordersSvc = requireOrdersService();
    const orderView = await ordersSvc.assertCanWriteOrder(livePrincipal, input.orderPublicId, {
      kind: "intake",
      tx,
      forUpdate: true,
    });

    const [q] = await tx
      .select()
      .from(intakeQuestionnaires)
      .where(eq(intakeQuestionnaires.publicId, input.questionnairePublicId))
      .limit(1);
    if (!q) throw notFound("INTAKE_QUESTIONNAIRE_NOT_FOUND");

    const [existing] = await tx
      .select()
      .from(intakeSubmissions)
      .where(
        and(
          eq(intakeSubmissions.orderId, orderView.id),
          eq(intakeSubmissions.questionnaireId, q.id),
        ),
      )
      .for("update")
      .limit(1);

    if (existing) {
      if (existing.origin !== "portal") {
        throw conflict("IMPORTED_INTAKE_READ_ONLY", "Imported intake records are historical and cannot be edited.");
      }
      if (existing.status === "accepted") {
        throw conflict("INTAKE_ALREADY_ACCEPTED", "This intake questionnaire has already been accepted.");
      }
      if (existing.status === "submitted") {
        throw conflict(
          "INTAKE_UNDER_REVIEW",
          "This intake questionnaire is currently under review. Staff can return it if changes are needed.",
        );
      }
    } else if (!q.active || !q.currentPublishedVersionId) {
      throw notFound("INTAKE_QUESTIONNAIRE_NOT_FOUND");
    }

    const boundVersionId = existing ? existing.questionnaireVersionId : q.currentPublishedVersionId!;
    const [ver] = await tx
      .select()
      .from(intakeQuestionnaireVersions)
      .where(eq(intakeQuestionnaireVersions.id, boundVersionId))
      .limit(1);
    if (!ver) throw notFound("INTAKE_VERSION_NOT_FOUND");

    const cleanedAnswers = validateIntakeAnswers(ver.fieldsJson, input.answers, input.mode);
    const now = deps.clock.now();

    let submissionPublicId: string;
    let submissionId: number;
    let nextRevision: number;
    let nextStatus: IntakeSubmissionStatus;

    if (!existing) {
      submissionPublicId = ulid(now.getTime());
      nextRevision = 1;
      nextStatus = input.mode === "submit" ? "submitted" : "draft";
      const currentAnswersEnc = encryptAnswers(
        cleanedAnswers,
        `intake_submissions.answers:${submissionPublicId}`,
      );
      const [ins] = await tx.insert(intakeSubmissions).values({
        publicId: submissionPublicId,
        orderId: orderView.id,
        orderPublicId: orderView.publicId,
        questionnaireId: q.id,
        questionnaireVersionId: ver.id,
        status: nextStatus,
        revisionNumber: nextRevision,
        currentAnswersEnc,
        submittedAt: input.mode === "submit" ? now : null,
        submittedByUserId: input.mode === "submit" ? liveActor.userId : null,
        origin: "portal",
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      submissionId = ins.insertId;
    } else {
      submissionPublicId = existing.publicId;
      submissionId = existing.id;
      nextRevision = existing.revisionNumber + 1;
      nextStatus =
        input.mode === "submit"
          ? "submitted"
          : existing.status === "returned_for_changes"
            ? "returned_for_changes"
            : "draft";
      const currentAnswersEnc = encryptAnswers(
        cleanedAnswers,
        `intake_submissions.answers:${submissionPublicId}`,
      );
      await tx
        .update(intakeSubmissions)
        .set({
          status: nextStatus,
          revisionNumber: nextRevision,
          currentAnswersEnc,
          ...(input.mode === "submit"
            ? { submittedAt: now, submittedByUserId: liveActor.userId }
            : {}),
          version: existing.version + 1,
          updatedAt: now,
        })
        .where(eq(intakeSubmissions.id, existing.id));
    }

    const revisionPublicId = ulid(now.getTime());
    const revisionEvent: IntakeRevisionEvent = input.mode === "submit" ? "submitted" : "draft_saved";
    await tx.insert(intakeSubmissionRevisions).values({
      publicId: revisionPublicId,
      submissionId,
      revisionNumber: nextRevision,
      eventKind: revisionEvent,
      actorUserId: liveActor.userId,
      actorRole: liveActor.role,
      answersEnc: encryptAnswers(cleanedAnswers, `intake_submission_revisions.answers:${revisionPublicId}`),
      noteEnc: null,
      occurredAt: now,
    });

    await deps.audit.record(
      {
        category: "business",
        eventName: input.mode === "submit" ? "intake.submission.submitted" : "intake.submission.draft_saved",
        action: input.mode === "submit" ? "transition" : "update",
        outcome: "completed",
        actor: { userId: liveActor.userId, role: liveActor.role },
        resource: { type: "intake_submission", publicId: submissionPublicId },
        attributes: {
          orderPublicId: orderView.publicId,
          questionnairePublicId: q.publicId,
          questionnaireVersionPublicId: ver.publicId,
          revisionNumber: nextRevision,
          status: nextStatus,
        },
        safeCounts: {
          answeredFields: Object.values(cleanedAnswers).filter((v) => v !== null).length,
        },
      },
      tx,
    );

    return {
      submissionPublicId,
      status: nextStatus,
      revisionNumber: nextRevision,
    };
  }

  async function saveDraft(
    principal: SessionPrincipal,
    input: { orderPublicId: string; questionnairePublicId: string; answers: IntakeAnswerMap },
  ) {
    return deps.db.transaction((tx) =>
      writeSubmissionInTx(tx, principal, { ...input, mode: "draft" }),
    );
  }

  async function submit(
    principal: SessionPrincipal,
    input: { orderPublicId: string; questionnairePublicId: string; answers: IntakeAnswerMap },
  ) {
    return deps.db.transaction((tx) =>
      writeSubmissionInTx(tx, principal, { ...input, mode: "submit" }),
    );
  }

  async function review(
    principal: SessionPrincipal,
    input: {
      submissionPublicId: string;
      decision: "accepted" | "returned_for_changes";
      reviewNote?: string | undefined;
    },
  ): Promise<{ submissionPublicId: string; status: IntakeSubmissionStatus; revisionNumber: number }> {
    const trimmedNote = input.reviewNote?.normalize("NFC").trim() ?? "";
    if (input.decision === "returned_for_changes" && trimmedNote.length < 3) {
      throw validation(
        "REVIEW_NOTE_REQUIRED",
        "Please include a note explaining what changes the customer should make.",
      );
    }

    return deps.db.transaction(async (tx) => {
      const liveActor = await assertLiveActorInTx(deps, principal, tx, "intake.review");
      const livePrincipal: SessionPrincipal = { ...principal, role: liveActor.role };

      const [sub] = await tx
        .select()
        .from(intakeSubmissions)
        .where(eq(intakeSubmissions.publicId, input.submissionPublicId))
        .for("update")
        .limit(1);
      if (!sub) throw notFound("INTAKE_SUBMISSION_NOT_FOUND");
      if (sub.origin !== "portal") {
        throw conflict("IMPORTED_INTAKE_READ_ONLY", "Imported intake records cannot be reviewed.");
      }

      const ordersSvc = requireOrdersService();
      const orderView = await ordersSvc.assertCanWriteOrder(livePrincipal, sub.orderPublicId, {
        kind: "intake",
        tx,
        forUpdate: true,
      });

      if (sub.status !== "submitted") {
        throw conflict(
          "INTAKE_NOT_SUBMITTED",
          "Only submitted intake questionnaires can be accepted or returned for changes.",
        );
      }

      const [q] = await tx
        .select()
        .from(intakeQuestionnaires)
        .where(eq(intakeQuestionnaires.id, sub.questionnaireId))
        .limit(1);

      const now = deps.clock.now();
      const nextRevision = sub.revisionNumber + 1;
      const currentAnswers = decryptAnswers(sub.currentAnswersEnc, `intake_submissions.answers:${sub.publicId}`);

      await tx
        .update(intakeSubmissions)
        .set({
          status: input.decision,
          revisionNumber: nextRevision,
          reviewedAt: now,
          reviewedByUserId: liveActor.userId,
          version: sub.version + 1,
          updatedAt: now,
        })
        .where(eq(intakeSubmissions.id, sub.id));

      const revisionPublicId = ulid(now.getTime());
      await tx.insert(intakeSubmissionRevisions).values({
        publicId: revisionPublicId,
        submissionId: sub.id,
        revisionNumber: nextRevision,
        eventKind: input.decision,
        actorUserId: liveActor.userId,
        actorRole: liveActor.role,
        answersEnc: encryptAnswers(currentAnswers, `intake_submission_revisions.answers:${revisionPublicId}`),
        noteEnc:
          trimmedNote.length > 0
            ? deps.crypto.encrypt(trimmedNote, `intake_submission_revisions.note:${revisionPublicId}`)
            : null,
        occurredAt: now,
      });

      await deps.audit.record(
        {
          category: "business",
          eventName: "intake.submission.reviewed",
          action: "transition",
          outcome: "completed",
          actor: { userId: liveActor.userId, role: liveActor.role },
          resource: { type: "intake_submission", publicId: sub.publicId },
          attributes: {
            orderPublicId: orderView.publicId,
            decision: input.decision,
            revisionNumber: nextRevision,
            hasReviewNote: trimmedNote.length > 0,
          },
        },
        tx,
      );

      if (input.decision === "returned_for_changes") {
        const engagementSvc = (deps.services as Partial<typeof deps.services>).engagement;
        if (engagementSvc && typeof engagementSvc.notify === "function") {
          await engagementSvc.notify(
            {
              userId: orderView.ownerUserId,
              kind: "order.intake_returned",
              title: "Intake questionnaire needs updates",
              body: `Your intake responses for order ${orderView.reference} were returned with feedback.`,
              link: `/orders/${orderView.publicId}?tab=intake`,
              idempotencyKey: `intake-return:${sub.publicId}:${nextRevision}`,
              skipEmail: true,
            },
            tx,
          );
        }
        await deps.mailer.enqueue(
          {
            template: "compliance.intake_returned",
            to: { userId: orderView.ownerUserId },
            vars: {
              orderReference: orderView.reference,
              questionnaireTitle: q?.title ?? "Intake Questionnaire",
              portalPath: `/orders/${orderView.publicId}?tab=intake`,
            },
            idempotencyKey: `mail:intake-return:${sub.publicId}:${nextRevision}`,
          },
          tx,
        );
      }

      return {
        submissionPublicId: sub.publicId,
        status: input.decision,
        revisionNumber: nextRevision,
      };
    });
  }

  /* --------------------------------------------------- admin questionnaires */

  async function adminListQuestionnaires(principal: SessionPrincipal): Promise<QuestionnaireAdminSummary[]> {
    assertIntakeAdminRead(principal);
    const rows = await deps.db.select().from(intakeQuestionnaires).orderBy(asc(intakeQuestionnaires.slug));
    if (rows.length === 0) return [];

    const qIds = rows.map((r) => r.id);
    const versions = await deps.db
      .select()
      .from(intakeQuestionnaireVersions)
      .where(inArray(intakeQuestionnaireVersions.questionnaireId, qIds))
      .orderBy(desc(intakeQuestionnaireVersions.versionNumber));

    const versionsByQ = new Map<number, (typeof intakeQuestionnaireVersions.$inferSelect)[]>();
    for (const v of versions) {
      const arr = versionsByQ.get(v.questionnaireId) ?? [];
      arr.push(v);
      versionsByQ.set(v.questionnaireId, arr);
    }

    return rows.map((q) => {
      const qVers = versionsByQ.get(q.id) ?? [];
      const pub =
        qVers.find((v) => v.id === q.currentPublishedVersionId) ??
        qVers.find((v) => v.status === "published" && v.origin === "portal") ??
        null;
      const draft = qVers.find((v) => v.status === "draft") ?? null;
      return {
        questionnairePublicId: q.publicId,
        slug: q.slug,
        title: q.title,
        description: q.description,
        scopeKind: q.scopeKind,
        scopeRef: q.scopeRef,
        active: q.active,
        version: q.version,
        currentPublishedVersion: pub
          ? {
              versionPublicId: pub.publicId,
              versionNumber: pub.versionNumber,
              schemaHash: pub.schemaHash,
              fieldCount: pub.fieldsJson.length,
              publishedAt: pub.publishedAt,
            }
          : null,
        draftVersionPublicId: draft?.publicId ?? null,
        updatedAt: q.updatedAt,
      };
    });
  }

  async function adminGetQuestionnaire(
    principal: SessionPrincipal,
    questionnairePublicId: string,
  ): Promise<{
    questionnaire: Omit<QuestionnaireAdminSummary, "currentPublishedVersion" | "draftVersionPublicId">;
    versions: QuestionnaireVersionView[];
  }> {
    assertIntakeAdminRead(principal);
    const [q] = await deps.db
      .select()
      .from(intakeQuestionnaires)
      .where(eq(intakeQuestionnaires.publicId, questionnairePublicId))
      .limit(1);
    if (!q) throw notFound("INTAKE_QUESTIONNAIRE_NOT_FOUND");

    const versions = await deps.db
      .select()
      .from(intakeQuestionnaireVersions)
      .where(eq(intakeQuestionnaireVersions.questionnaireId, q.id))
      .orderBy(desc(intakeQuestionnaireVersions.versionNumber));

    return {
      questionnaire: {
        questionnairePublicId: q.publicId,
        slug: q.slug,
        title: q.title,
        description: q.description,
        scopeKind: q.scopeKind,
        scopeRef: q.scopeRef,
        active: q.active,
        version: q.version,
        updatedAt: q.updatedAt,
      },
      versions: versions.map((v) => ({
        versionPublicId: v.publicId,
        versionNumber: v.versionNumber,
        status: v.status,
        fields: v.fieldsJson,
        schemaHash: v.schemaHash,
        publishedAt: v.publishedAt,
        origin: v.origin,
        createdAt: v.createdAt,
      })),
    };
  }

  async function adminCreateQuestionnaire(
    principal: SessionPrincipal,
    input: {
      slug: string;
      title: string;
      description?: string | undefined;
      scopeKind: IntakeScopeKind;
      scopeRef?: string | null | undefined;
      fields: readonly StoredIntakeFieldDef[];
    },
  ): Promise<{ questionnairePublicId: string; draftVersionPublicId: string; schemaHash: string }> {
    const now = deps.clock.now();
    const canonicalFields = canonicalizeIntakeFields(input.fields);
    const schemaHash = hashQuestionnaireFields(canonicalFields);

    return deps.db.transaction(async (tx) => {
      const liveActor = await assertLiveActorInTx(deps, principal, tx, "intake.manage");

      const [existing] = await tx
        .select({ id: intakeQuestionnaires.id })
        .from(intakeQuestionnaires)
        .where(eq(intakeQuestionnaires.slug, input.slug))
        .for("update")
        .limit(1);
      if (existing) {
        throw conflict("INTAKE_SLUG_IN_USE", "An intake questionnaire with that slug already exists.");
      }

      const questionnairePublicId = ulid(now.getTime());
      const [qIns] = await tx.insert(intakeQuestionnaires).values({
        publicId: questionnairePublicId,
        slug: input.slug,
        title: input.title,
        description: input.description ?? null,
        scopeKind: input.scopeKind,
        scopeRef: input.scopeKind === "default" ? null : (input.scopeRef ?? null),
        active: true,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });

      const draftVersionPublicId = ulid(now.getTime());
      await tx.insert(intakeQuestionnaireVersions).values({
        publicId: draftVersionPublicId,
        questionnaireId: qIns.insertId,
        versionNumber: 1,
        status: "draft",
        fieldsJson: canonicalFields,
        schemaHash,
        origin: "portal",
        createdAt: now,
        updatedAt: now,
      });

      await deps.audit.record(
        {
          category: "admin",
          eventName: "intake.questionnaire.created",
          action: "create",
          outcome: "completed",
          actor: { userId: liveActor.userId, role: liveActor.role },
          resource: { type: "intake_questionnaire", publicId: questionnairePublicId },
          attributes: {
            slug: input.slug,
            scopeKind: input.scopeKind,
            draftVersionPublicId,
            schemaHash,
          },
          safeCounts: { fieldCount: canonicalFields.length },
        },
        tx,
      );

      return { questionnairePublicId, draftVersionPublicId, schemaHash };
    });
  }

  async function adminUpdateQuestionnaire(
    principal: SessionPrincipal,
    input: {
      questionnairePublicId: string;
      expectedVersion: number;
      title: string;
      description?: string | null | undefined;
      scopeKind: IntakeScopeKind;
      scopeRef?: string | null | undefined;
      active: boolean;
    },
  ): Promise<{ questionnairePublicId: string; version: number }> {
    const now = deps.clock.now();

    return deps.db.transaction(async (tx) => {
      const liveActor = await assertLiveActorInTx(deps, principal, tx, "intake.manage");

      const [q] = await tx
        .select()
        .from(intakeQuestionnaires)
        .where(eq(intakeQuestionnaires.publicId, input.questionnairePublicId))
        .for("update")
        .limit(1);
      if (!q) throw notFound("INTAKE_QUESTIONNAIRE_NOT_FOUND");
      if (q.version !== input.expectedVersion) {
        throw conflict("VERSION_MISMATCH", "This questionnaire was modified by another administrator. Reload and try again.");
      }

      const nextVersion = q.version + 1;
      await tx
        .update(intakeQuestionnaires)
        .set({
          title: input.title,
          description: input.description ?? null,
          scopeKind: input.scopeKind,
          scopeRef: input.scopeKind === "default" ? null : (input.scopeRef ?? null),
          active: input.active,
          version: nextVersion,
          updatedAt: now,
        })
        .where(eq(intakeQuestionnaires.id, q.id));

      await deps.audit.record(
        {
          category: "admin",
          eventName: "intake.questionnaire.updated",
          action: "update",
          outcome: "completed",
          actor: { userId: liveActor.userId, role: liveActor.role },
          resource: { type: "intake_questionnaire", publicId: q.publicId },
          attributes: {
            scopeKind: input.scopeKind,
            active: input.active,
          },
        },
        tx,
      );

      return { questionnairePublicId: q.publicId, version: nextVersion };
    });
  }

  async function adminSaveDraftVersion(
    principal: SessionPrincipal,
    input: {
      questionnairePublicId: string;
      versionPublicId?: string | undefined;
      fields: readonly StoredIntakeFieldDef[];
    },
  ): Promise<{ versionPublicId: string; versionNumber: number; schemaHash: string }> {
    const now = deps.clock.now();
    const canonicalFields = canonicalizeIntakeFields(input.fields);
    const schemaHash = hashQuestionnaireFields(canonicalFields);

    return deps.db.transaction(async (tx) => {
      const liveActor = await assertLiveActorInTx(deps, principal, tx, "intake.manage");

      const [q] = await tx
        .select()
        .from(intakeQuestionnaires)
        .where(eq(intakeQuestionnaires.publicId, input.questionnairePublicId))
        .for("update")
        .limit(1);
      if (!q) throw notFound("INTAKE_QUESTIONNAIRE_NOT_FOUND");

      if (input.versionPublicId) {
        const [ver] = await tx
          .select()
          .from(intakeQuestionnaireVersions)
          .where(
            and(
              eq(intakeQuestionnaireVersions.publicId, input.versionPublicId),
              eq(intakeQuestionnaireVersions.questionnaireId, q.id),
            ),
          )
          .for("update")
          .limit(1);
        if (!ver) throw notFound("INTAKE_VERSION_NOT_FOUND");
        if (ver.status !== "draft") {
          throw conflict("INTAKE_VERSION_IMMUTABLE", "Published questionnaire versions cannot be modified.");
        }

        await tx
          .update(intakeQuestionnaireVersions)
          .set({
            fieldsJson: canonicalFields,
            schemaHash,
            updatedAt: now,
          })
          .where(eq(intakeQuestionnaireVersions.id, ver.id));

        await deps.audit.record(
          {
            category: "admin",
            eventName: "intake.version.draft_saved",
            action: "update",
            outcome: "completed",
            actor: { userId: liveActor.userId, role: liveActor.role },
            resource: { type: "intake_questionnaire_version", publicId: ver.publicId },
            attributes: { questionnairePublicId: q.publicId, versionNumber: ver.versionNumber, schemaHash },
            safeCounts: { fieldCount: canonicalFields.length },
          },
          tx,
        );

        return { versionPublicId: ver.publicId, versionNumber: ver.versionNumber, schemaHash };
      }

      const existingVers = await tx
        .select({ versionNumber: intakeQuestionnaireVersions.versionNumber })
        .from(intakeQuestionnaireVersions)
        .where(eq(intakeQuestionnaireVersions.questionnaireId, q.id))
        .orderBy(desc(intakeQuestionnaireVersions.versionNumber))
        .limit(1);

      const nextNum = (existingVers[0]?.versionNumber ?? 0) + 1;
      const versionPublicId = ulid(now.getTime());

      await tx.insert(intakeQuestionnaireVersions).values({
        publicId: versionPublicId,
        questionnaireId: q.id,
        versionNumber: nextNum,
        status: "draft",
        fieldsJson: canonicalFields,
        schemaHash,
        origin: "portal",
        createdAt: now,
        updatedAt: now,
      });

      await deps.audit.record(
        {
          category: "admin",
          eventName: "intake.version.draft_saved",
          action: "create",
          outcome: "completed",
          actor: { userId: liveActor.userId, role: liveActor.role },
          resource: { type: "intake_questionnaire_version", publicId: versionPublicId },
          attributes: { questionnairePublicId: q.publicId, versionNumber: nextNum, schemaHash },
          safeCounts: { fieldCount: canonicalFields.length },
        },
        tx,
      );

      return { versionPublicId, versionNumber: nextNum, schemaHash };
    });
  }

  async function adminPublishVersion(
    principal: SessionPrincipal,
    versionPublicId: string,
  ): Promise<{ versionPublicId: string; schemaHash: string; publishedAt: Date }> {
    const now = deps.clock.now();

    return deps.db.transaction(async (tx) => {
      const liveActor = await assertLiveActorInTx(deps, principal, tx, "intake.manage");

      const [ver] = await tx
        .select()
        .from(intakeQuestionnaireVersions)
        .where(eq(intakeQuestionnaireVersions.publicId, versionPublicId))
        .for("update")
        .limit(1);
      if (!ver) throw notFound("INTAKE_VERSION_NOT_FOUND");
      if (ver.status === "published") {
        throw conflict("INTAKE_VERSION_IMMUTABLE", "This questionnaire version is already published.");
      }

      const [q] = await tx
        .select()
        .from(intakeQuestionnaires)
        .where(eq(intakeQuestionnaires.id, ver.questionnaireId))
        .for("update")
        .limit(1);
      if (!q) throw notFound("INTAKE_QUESTIONNAIRE_NOT_FOUND");

      const canonicalFields = canonicalizeIntakeFields(ver.fieldsJson);
      const lockedHash = hashQuestionnaireFields(canonicalFields);

      await tx
        .update(intakeQuestionnaireVersions)
        .set({
          status: "published",
          fieldsJson: canonicalFields,
          schemaHash: lockedHash,
          publishedAt: now,
          publishedByUserId: liveActor.userId,
          updatedAt: now,
        })
        .where(eq(intakeQuestionnaireVersions.id, ver.id));

      await tx
        .update(intakeQuestionnaires)
        .set({
          currentPublishedVersionId: ver.id,
          version: q.version + 1,
          updatedAt: now,
        })
        .where(eq(intakeQuestionnaires.id, q.id));

      await deps.audit.record(
        {
          category: "admin",
          eventName: "intake.version.published",
          action: "transition",
          outcome: "completed",
          actor: { userId: liveActor.userId, role: liveActor.role },
          resource: { type: "intake_questionnaire_version", publicId: ver.publicId },
          attributes: {
            questionnairePublicId: q.publicId,
            slug: q.slug,
            versionNumber: ver.versionNumber,
            schemaHash: lockedHash,
          },
          safeCounts: { fieldCount: canonicalFields.length },
        },
        tx,
      );

      return { versionPublicId: ver.publicId, schemaHash: lockedHash, publishedAt: now };
    });
  }

  async function healthCounts(): Promise<{ activeQuestionnaires: number; pendingReviews: number }> {
    const [[qRow], [subRow]] = await Promise.all([
      deps.db
        .select({ total: count() })
        .from(intakeQuestionnaires)
        .where(eq(intakeQuestionnaires.active, true)),
      deps.db
        .select({ total: count() })
        .from(intakeSubmissions)
        .where(and(eq(intakeSubmissions.status, "submitted"), eq(intakeSubmissions.origin, "portal"))),
    ]);
    return {
      activeQuestionnaires: qRow?.total ?? 0,
      pendingReviews: subRow?.total ?? 0,
    };
  }

  return {
    listForOrder,
    getSubmission,
    saveDraft,
    submit,
    review,
    admin: {
      listQuestionnaires: adminListQuestionnaires,
      getQuestionnaire: adminGetQuestionnaire,
      createQuestionnaire: adminCreateQuestionnaire,
      updateQuestionnaire: adminUpdateQuestionnaire,
      saveDraftVersion: adminSaveDraftVersion,
      publishVersion: adminPublishVersion,
    },
    healthCounts,
  };
}

export type IntakeService = ReturnType<typeof createIntakeService>;
