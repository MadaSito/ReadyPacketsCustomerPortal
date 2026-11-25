import { z } from "zod";
import { STAGE_ADMIN_TASKS, stageKeySchema } from "../../../shared/workflowStages.js";
import { ULID_PATTERN } from "../../core/ids.js";
import { protectedProcedure, requireCapability, router, staffProcedure } from "../../trpc/trpc.js";
import { createAdminTasksService } from "./adminTasks.js";
import { createQuestionsService, MAX_ANSWER_VERSION, MAX_QUESTION_ANSWER_LENGTH, MAX_QUESTION_PROMPT_LENGTH } from "./questions.js";
import type { QuestionsDeps } from "./questionsAccess.js";

export function createPhaseWorkServices(deps: QuestionsDeps) {
  return { questions: createQuestionsService(deps), adminTasks: createAdminTasksService(deps) };
}
export type PhaseWorkServices = ReturnType<typeof createPhaseWorkServices>;

const id = z.string().regex(ULID_PATTERN);
const phase = { orderId: id, stageKey: stageKeySchema };
const question = { ...phase, questionId: id };
const staffQuestions = staffProcedure.use(requireCapability("orders.questions.manage"));

export const questionsRouter = router({
  customerList: protectedProcedure.input(z.strictObject(phase))
    .query(({ ctx, input }) => ctx.services.orders.phaseWork.questions.customerList(ctx.session, input)),
  answer: protectedProcedure.meta({ rateLimit: "form_submission" })
    .input(z.strictObject({ ...question, body: z.string().min(1).max(MAX_QUESTION_ANSWER_LENGTH), expectedVersion: z.number().int().min(0).max(MAX_ANSWER_VERSION) }))
    .mutation(({ ctx, input }) => ctx.services.orders.phaseWork.questions.answer(ctx.session, input)),
  list: staffQuestions.input(z.strictObject(phase))
    .query(({ ctx, input }) => ctx.services.orders.phaseWork.questions.list(ctx.session, input)),
  ask: staffQuestions.meta({ rateLimit: "form_submission" }).input(z.strictObject({
    ...phase, prompt: z.string().min(1).max(MAX_QUESTION_PROMPT_LENGTH), required: z.boolean(),
  })).mutation(({ ctx, input }) => ctx.services.orders.phaseWork.questions.ask(ctx.session, input)),
  withdraw: staffQuestions.meta({ rateLimit: "form_submission" }).input(z.strictObject(question))
    .mutation(({ ctx, input }) => ctx.services.orders.phaseWork.questions.withdraw(ctx.session, input)),
  history: staffQuestions.input(z.strictObject({ ...question, beforeVersion: z.number().int().min(1).max(MAX_ANSWER_VERSION).optional() }))
    .query(({ ctx, input }) => ctx.services.orders.phaseWork.questions.history(ctx.session, input)),
});

export const adminTasksRouter = router({
  list: staffQuestions.input(z.strictObject(phase))
    .query(({ ctx, input }) => ctx.services.orders.phaseWork.adminTasks.list(ctx.session, input)),
  set: staffQuestions.meta({ rateLimit: "form_submission" }).input(z.strictObject({
    ...phase, taskKey: z.enum(STAGE_ADMIN_TASKS), checked: z.boolean(), expectedVersion: z.number().int().min(0).max(2_147_483_647),
  })).mutation(({ ctx, input }) => ctx.services.orders.phaseWork.adminTasks.set(ctx.session, input)),
});
