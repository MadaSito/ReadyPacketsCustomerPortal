/** Increment 07 D4: pinned phase questions, append-only answers and administrator checklist. */
import { boolean, foreignKey, index, int, mysqlTable, text, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { idColumn, publicIdColumn, refColumn, utcDateTime, versionColumn } from "../../db/columns.js";
import { users } from "../identity/schema.js";

export const orderQuestions = mysqlTable(
  "order_questions",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    orderId: refColumn("order_id").notNull(),
    workflowVersionId: refColumn("workflow_version_id").notNull(),
    stageKey: varchar("stage_key", { length: 48 }).notNull(),
    promptEnc: text("prompt_enc").notNull(),
    required: boolean("required").notNull().default(false),
    askedByUserId: refColumn("asked_by_user_id").notNull(),
    askedAt: utcDateTime("asked_at").notNull(),
    withdrawnByUserId: refColumn("withdrawn_by_user_id"),
    withdrawnAt: utcDateTime("withdrawn_at"),
  },
  (t) => [
    uniqueIndex("order_questions_public_uq").on(t.publicId),
    index("order_questions_stage_idx").on(t.orderId, t.workflowVersionId, t.stageKey, t.withdrawnAt, t.id),
    foreignKey({ name: "oq_asker_fk", columns: [t.askedByUserId], foreignColumns: [users.id] }),
    foreignKey({ name: "oq_withdrawer_fk", columns: [t.withdrawnByUserId], foreignColumns: [users.id] }),
  ],
);

export const orderQuestionAnswers = mysqlTable(
  "order_question_answers",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    questionId: refColumn("question_id").notNull(),
    version: int("version", { unsigned: true }).notNull(),
    bodyEnc: text("body_enc").notNull(),
    answeredByUserId: refColumn("answered_by_user_id").notNull(),
    answeredAt: utcDateTime("answered_at").notNull(),
  },
  (t) => [
    uniqueIndex("order_question_answers_public_uq").on(t.publicId),
    uniqueIndex("order_question_answers_version_uq").on(t.questionId, t.version),
    foreignKey({ name: "oqa_question_fk", columns: [t.questionId], foreignColumns: [orderQuestions.id] }),
    foreignKey({ name: "oqa_actor_fk", columns: [t.answeredByUserId], foreignColumns: [users.id] }),
  ],
);

export const orderAdminTasks = mysqlTable(
  "order_admin_tasks",
  {
    id: idColumn(),
    orderId: refColumn("order_id").notNull(),
    workflowVersionId: refColumn("workflow_version_id").notNull(),
    stageKey: varchar("stage_key", { length: 48 }).notNull(),
    taskKey: varchar("task_key", { length: 48 }).notNull(),
    checkedByUserId: refColumn("checked_by_user_id"),
    checkedAt: utcDateTime("checked_at"),
    rowVersion: versionColumn("row_version"),
  },
  (t) => [
    uniqueIndex("order_admin_tasks_task_uq").on(t.orderId, t.workflowVersionId, t.stageKey, t.taskKey),
    foreignKey({ name: "oat_actor_fk", columns: [t.checkedByUserId], foreignColumns: [users.id] }),
  ],
);
