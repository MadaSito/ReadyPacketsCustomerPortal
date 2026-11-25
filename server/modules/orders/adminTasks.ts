/** Increment 07 D4: checklist state is separate from authoritative reviews, file custody and action runs. */
import { and, eq } from "drizzle-orm";
import type { StageAdminTask } from "../../../shared/workflowStages.js";
import { conflict, notFound } from "../../core/errors.js";
import type { SessionPrincipal } from "../../core/types.js";
import { users } from "../identity/schema.js";
import { lockBlocks } from "./policy.js";
import { createPhaseWorkAccess, type PhaseRef, type QuestionsDeps } from "./questionsAccess.js";
import { orderAdminTasks as tasks } from "./questionsSchema.js";

const inPhase = (orderId: number, workflowVersionId: number, stageKey: string) =>
  and(eq(tasks.orderId, orderId), eq(tasks.workflowVersionId, workflowVersionId), eq(tasks.stageKey, stageKey));

export function createAdminTasksService(deps: QuestionsDeps) {
  const resolve = createPhaseWorkAccess(deps);
  return {
    async list(principal: SessionPrincipal, input: PhaseRef) {
      return deps.db.transaction(async (tx) => {
        const { view, stage } = await resolve(principal, input, "staff", tx);
        const rows = await tx.select({
          taskKey: tasks.taskKey, checkedAt: tasks.checkedAt, version: tasks.rowVersion, checkedByPublicId: users.publicId,
        }).from(tasks).leftJoin(users, eq(tasks.checkedByUserId, users.id))
          .where(inPhase(view.id, view.workflowVersionId, input.stageKey));
        const byKey = new Map(rows.map((row) => [row.taskKey, row]));
        return {
          canManage: !lockBlocks(view.lockState, true, "order"),
          tasks: stage.adminTasks.map((taskKey) => {
            const row = byKey.get(taskKey);
            return { taskKey, checkedAt: row?.checkedAt ?? null, checkedByPublicId: row?.checkedByPublicId ?? null, version: row?.version ?? 0 };
          }),
        };
      });
    },
    async set(principal: SessionPrincipal, input: PhaseRef & { taskKey: StageAdminTask; checked: boolean; expectedVersion: number }) {
      return deps.db.transaction(async (tx) => {
        const { view, stage } = await resolve(principal, input, "staff", tx, true);
        if (!stage.adminTasks.includes(input.taskKey)) throw notFound("PHASE_TASK_NOT_FOUND");
        const [current] = await tx.select({ id: tasks.id, checkedAt: tasks.checkedAt, version: tasks.rowVersion }).from(tasks)
          .where(and(inPhase(view.id, view.workflowVersionId, input.stageKey), eq(tasks.taskKey, input.taskKey))).limit(1);
        const previous = current?.version ?? 0;
        if (previous !== input.expectedVersion) throw conflict("STALE_VERSION", "This checklist item changed. Reload the checklist before trying again.");
        if (Boolean(current?.checkedAt) === input.checked) return { version: previous, changed: false };
        const version = previous + 1;
        const data = {
          checkedAt: input.checked ? deps.clock.now() : null,
          checkedByUserId: input.checked ? principal.userId : null,
          rowVersion: version,
        };
        if (current) await tx.update(tasks).set(data).where(eq(tasks.id, current.id));
        else await tx.insert(tasks).values({
          orderId: view.id, workflowVersionId: view.workflowVersionId, stageKey: input.stageKey, taskKey: input.taskKey, ...data,
        });
        await deps.audit.record({
          category: "business", eventName: input.checked ? "order.admin_task.checked" : "order.admin_task.unchecked",
          action: "update", outcome: "completed", actor: { userId: principal.userId, role: principal.role },
          resource: { type: "order", publicId: view.publicId },
          attributes: { stage_key: input.stageKey, task_key: input.taskKey, task_version: version },
        }, tx);
        return { version, changed: true };
      });
    },
  };
}
