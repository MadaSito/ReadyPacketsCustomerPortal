/** D4: pinned-phase questions. The order-row lock serializes writes and progression across both features. */
import { alias } from "drizzle-orm/mysql-core";
import { and, asc, count, desc, eq, isNull, lt, notExists } from "drizzle-orm";
import { conflict, notFound, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { DbOrTx, SessionPrincipal, Tx } from "../../core/types.js";
import { users } from "../identity/schema.js";
import { lockBlocks } from "./policy.js";
import { canCustomerAnswer, createPhaseWorkAccess, stageNotOpen, type PhaseRef, type QuestionsDeps } from "./questionsAccess.js";
import { orderQuestionAnswers as answers, orderQuestions as questions } from "./questionsSchema.js";

export const MAX_STAGE_QUESTIONS = 40;
export const MAX_ANSWER_VERSION = 1_000;
export const MAX_QUESTION_PROMPT_LENGTH = 2_000;
export const MAX_QUESTION_ANSWER_LENGTH = 8_000;
const HISTORY_PAGE_SIZE = 10;
type QuestionRef = PhaseRef & { questionId: string };
const answerActor = alias(users, "question_answer_actor");
const askActor = alias(users, "question_ask_actor");
const withdrawActor = alias(users, "question_withdraw_actor");
const newerAnswer = alias(answers, "newer_question_answer");

export const promptAad = (id: string) => `order_questions.prompt:${id}`;
export const answerAad = (id: string) => `order_question_answers.body:${id}`;

export function normalizeQuestionText(text: string, field: "prompt" | "body") {
  const cleaned = text.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  const max = field === "prompt" ? MAX_QUESTION_PROMPT_LENGTH : MAX_QUESTION_ANSWER_LENGTH;
  if (cleaned.length < 1 || cleaned.length > max || /\p{Cc}/u.test(cleaned.replace(/[\n\t]/gu, ""))) {
    throw validation("QUESTION_TEXT_INVALID", `Enter between 1 and ${max.toLocaleString("en-US")} characters of plain text.`, { field });
  }
  return cleaned;
}

const inPhase = (orderId: number, workflowVersionId: number, stageKey: string) =>
  and(eq(questions.orderId, orderId), eq(questions.workflowVersionId, workflowVersionId), eq(questions.stageKey, stageKey));

/** Same pinned phase scope for progression and attention. Optional questions need not affect attention. */
export async function hasUnansweredStageQuestions(orderId: number, workflowVersionId: number, stageKey: string, db: DbOrTx, requiredOnly = true) {
  const [missing] = await db.select({ id: questions.id }).from(questions).where(and(
    inPhase(orderId, workflowVersionId, stageKey), requiredOnly ? eq(questions.required, true) : undefined, isNull(questions.withdrawnAt),
    notExists(db.select({ id: answers.id }).from(answers).where(eq(answers.questionId, questions.id))),
  )).limit(1);
  return Boolean(missing);
}

/** Must run in the same transaction, under the same order-row lock, as `next` or `submit`. */
export async function assertStageQuestionsAnswered(orderId: number, workflowVersionId: number, stageKey: string, tx: Tx) {
  if (await hasUnansweredStageQuestions(orderId, workflowVersionId, stageKey, tx)) {
    throw conflict("QUESTIONS_UNANSWERED", "Answer the required questions before continuing.");
  }
}

export function createQuestionsService(deps: QuestionsDeps) {
  const resolve = createPhaseWorkAccess(deps);
  const actor = (principal: SessionPrincipal) => ({ userId: principal.userId, role: principal.role });
  async function findQuestion(db: DbOrTx, orderId: number, versionId: number, ref: QuestionRef, activeOnly = false) {
    const [row] = await db.select({ id: questions.id, withdrawnAt: questions.withdrawnAt }).from(questions).where(and(
      inPhase(orderId, versionId, ref.stageKey), eq(questions.publicId, ref.questionId),
      activeOnly ? isNull(questions.withdrawnAt) : undefined,
    )).limit(1);
    if (!row) throw notFound("QUESTION_NOT_FOUND");
    return row;
  }
  function visibleAnswer(row: { publicId: string; bodyEnc: string; version: number; answeredAt: Date }) {
    return { version: row.version, body: deps.crypto.decrypt(row.bodyEnc, answerAad(row.publicId)), answeredAt: row.answeredAt };
  }
  async function listQuestions(db: DbOrTx, orderId: number, versionId: number, stageKey: string, staff: boolean) {
    return db.select({
      questionPublicId: questions.publicId, promptEnc: questions.promptEnc, required: questions.required,
      askedAt: questions.askedAt, withdrawnAt: questions.withdrawnAt, askedByPublicId: askActor.publicId,
      withdrawnByPublicId: withdrawActor.publicId,
      answer: { publicId: answers.publicId, bodyEnc: answers.bodyEnc, version: answers.version, answeredAt: answers.answeredAt },
      answeredByPublicId: answerActor.publicId,
    }).from(questions)
      .leftJoin(answers, and(eq(answers.questionId, questions.id), notExists(
        db.select({ id: newerAnswer.id }).from(newerAnswer)
          .where(and(eq(newerAnswer.questionId, answers.questionId), lt(answers.version, newerAnswer.version))),
      )))
      .leftJoin(askActor, eq(questions.askedByUserId, askActor.id))
      .leftJoin(withdrawActor, eq(questions.withdrawnByUserId, withdrawActor.id))
      .leftJoin(answerActor, eq(answers.answeredByUserId, answerActor.id))
      .where(and(inPhase(orderId, versionId, stageKey), staff ? undefined : isNull(questions.withdrawnAt)))
      .orderBy(asc(questions.id)).limit(MAX_STAGE_QUESTIONS);
  }
  type ListedQuestion = Awaited<ReturnType<typeof listQuestions>>[number];
  function customerProjection(row: ListedQuestion) {
    return {
      questionId: row.questionPublicId, prompt: deps.crypto.decrypt(row.promptEnc, promptAad(row.questionPublicId)),
      required: row.required, askedAt: row.askedAt, latestAnswer: row.answer ? visibleAnswer(row.answer) : null,
    };
  }

  return {
    async customerList(principal: SessionPrincipal, input: PhaseRef) {
      return deps.db.transaction(async (tx) => {
        const { view, stage } = await resolve(principal, input, "customer", tx);
        const rows = await listQuestions(tx, view.id, view.workflowVersionId, input.stageKey, false);
        return { canAnswer: canCustomerAnswer(view, stage), questions: rows.map(customerProjection) };
      });
    },
    async list(principal: SessionPrincipal, input: PhaseRef) {
      return deps.db.transaction(async (tx) => {
        const { view, stage } = await resolve(principal, input, "staff", tx);
        const rows = await listQuestions(tx, view.id, view.workflowVersionId, input.stageKey, true);
        return {
          canManage: stage.answersEnabled && stage.staffQuestionsWritable && !lockBlocks(view.lockState, true, "order"),
          questions: rows.map((row) => {
            const projection = customerProjection(row);
            return {
              ...projection, askedByPublicId: row.askedByPublicId, withdrawnAt: row.withdrawnAt, withdrawnByPublicId: row.withdrawnByPublicId,
              latestAnswer: projection.latestAnswer ? { ...projection.latestAnswer, answeredByPublicId: row.answeredByPublicId } : null,
            };
          }),
        };
      });
    },
    async ask(principal: SessionPrincipal, input: PhaseRef & { prompt: string; required: boolean }) {
      const prompt = normalizeQuestionText(input.prompt, "prompt");
      return deps.db.transaction(async (tx) => {
        const { view, stage } = await resolve(principal, input, "staff", tx, true);
        if (!stage.answersEnabled || !stage.staffQuestionsWritable) throw stageNotOpen();
        const [total] = await tx.select({ count: count() }).from(questions)
          .where(inPhase(view.id, view.workflowVersionId, input.stageKey));
        if (!total || total.count >= MAX_STAGE_QUESTIONS) throw conflict("QUESTION_LIMIT_REACHED", "This phase has reached its question limit.");
        const askedAt = deps.clock.now();
        const questionId = ulid(askedAt.getTime());
        await tx.insert(questions).values({
          publicId: questionId, orderId: view.id, workflowVersionId: view.workflowVersionId, stageKey: input.stageKey,
          promptEnc: deps.crypto.encrypt(prompt, promptAad(questionId)), required: input.required,
          askedByUserId: principal.userId, askedAt,
        });
        await deps.refreshAttentionInTx(view.id, tx);
        await deps.audit.record({
          category: "business", eventName: "order.question.asked", action: "create", outcome: "completed",
          actor: actor(principal), resource: { type: "order", publicId: view.publicId },
          attributes: { stage_key: input.stageKey, question_public_id: questionId, required: input.required },
        }, tx);
        return { questionId };
      });
    },
    async withdraw(principal: SessionPrincipal, input: QuestionRef) {
      return deps.db.transaction(async (tx) => {
        const { view, stage } = await resolve(principal, input, "staff", tx, true);
        if (!stage.answersEnabled || !stage.staffQuestionsWritable) throw stageNotOpen();
        const question = await findQuestion(tx, view.id, view.workflowVersionId, input);
        if (question.withdrawnAt) return { changed: false };
        await tx.update(questions).set({ withdrawnByUserId: principal.userId, withdrawnAt: deps.clock.now() }).where(eq(questions.id, question.id));
        await deps.refreshAttentionInTx(view.id, tx);
        await deps.audit.record({
          category: "business", eventName: "order.question.withdrawn", action: "update", outcome: "completed",
          actor: actor(principal), resource: { type: "order", publicId: view.publicId },
          attributes: { stage_key: input.stageKey, question_public_id: input.questionId },
        }, tx);
        return { changed: true };
      });
    },
    async answer(principal: SessionPrincipal, input: QuestionRef & { body: string; expectedVersion: number }) {
      const body = normalizeQuestionText(input.body, "body");
      return deps.db.transaction(async (tx) => {
        const { view } = await resolve(principal, input, "customer", tx, true);
        const question = await findQuestion(tx, view.id, view.workflowVersionId, input, true);
        const [latest] = await tx.select({ version: answers.version }).from(answers)
          .where(eq(answers.questionId, question.id)).orderBy(desc(answers.version)).limit(1);
        const current = latest?.version ?? 0;
        if (current !== input.expectedVersion) throw conflict("QUESTION_ANSWER_VERSION_CHANGED", "This answer changed. Reload it before saving your edit.");
        if (current >= MAX_ANSWER_VERSION) throw conflict("QUESTION_ANSWER_LIMIT_REACHED", "This answer has reached its edit limit.");
        const version = current + 1;
        const answeredAt = deps.clock.now();
        const publicId = ulid(answeredAt.getTime());
        await tx.insert(answers).values({
          publicId, questionId: question.id, version, bodyEnc: deps.crypto.encrypt(body, answerAad(publicId)),
          answeredByUserId: principal.userId, answeredAt,
        });
        await deps.refreshAttentionInTx(view.id, tx);
        await deps.audit.record({
          category: "business", eventName: "order.question.answered", action: "submit", outcome: "completed",
          actor: actor(principal), resource: { type: "order", publicId: view.publicId },
          attributes: { stage_key: input.stageKey, question_public_id: input.questionId, answer_version: version },
        }, tx);
        return { version };
      });
    },
    async history(principal: SessionPrincipal, input: QuestionRef & { beforeVersion?: number }) {
      return deps.db.transaction(async (tx) => {
        const { view } = await resolve(principal, input, "staff", tx);
        const question = await findQuestion(tx, view.id, view.workflowVersionId, input);
        const rows = await tx.select({
          publicId: answers.publicId, version: answers.version, bodyEnc: answers.bodyEnc,
          answeredAt: answers.answeredAt, answeredByPublicId: answerActor.publicId,
        }).from(answers).leftJoin(answerActor, eq(answers.answeredByUserId, answerActor.id))
          .where(and(eq(answers.questionId, question.id), input.beforeVersion ? lt(answers.version, input.beforeVersion) : undefined))
          .orderBy(desc(answers.version)).limit(HISTORY_PAGE_SIZE + 1);
        return {
          answers: rows.slice(0, HISTORY_PAGE_SIZE).map((row) => ({ ...visibleAnswer(row), answeredByPublicId: row.answeredByPublicId })),
          nextBeforeVersion: rows.length > HISTORY_PAGE_SIZE ? rows[HISTORY_PAGE_SIZE - 1]!.version : null,
        };
      });
    },
  };
}
