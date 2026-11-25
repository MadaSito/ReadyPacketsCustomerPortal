/** D4 authorization layer: the stage runtime supplies authoritative facts for the pinned workflow. */
import { roleHasCapability } from "../../../shared/capabilities.js";
import type { StageAdminTask } from "../../../shared/workflowStages.js";
import { conflict, forbidden } from "../../core/errors.js";
import type { AuditEmitter, Clock, Db, DbOrTx, FieldCrypto, SessionPrincipal, Tx } from "../../core/types.js";
import type { ActorCheck } from "./actor.js";
import type { OrderGatesService } from "./gates.js";
import { lockBlocks, ORDER_NOT_FOUND, orderLocked, type OrderPolicy } from "./policy.js";
import type { OrderAccessView } from "./types.js";

export type PhaseRef = { orderId: string; stageKey: string };
export type ResolvedQuestionStage = {
  customerReadable: boolean;
  customerWritable: boolean;
  staffQuestionsWritable: boolean;
  answersEnabled: boolean;
  adminTasks: readonly StageAdminTask[];
};

export type ResolveQuestionStage = (order: OrderAccessView, stageKey: string, db: DbOrTx) => Promise<ResolvedQuestionStage | null>;

export interface QuestionsDeps {
  db: Db;
  audit: AuditEmitter;
  clock: Clock;
  crypto: FieldCrypto;
  policy: OrderPolicy;
  actorCheck: ActorCheck;
  gates: Pick<OrderGatesService, "assertCustomerMayWork">;
  resolveStage: ResolveQuestionStage;
  refreshAttentionInTx: (orderId: number, tx: Tx) => Promise<void>;
}

export const stageNotOpen = () => conflict("STAGE_NOT_OPEN", "This phase is not open for this action.");

export function canCustomerAnswer(view: OrderAccessView, stage: ResolvedQuestionStage) {
  return view.canWrite && stage.customerWritable && stage.answersEnabled;
}

export function createPhaseWorkAccess(deps: QuestionsDeps) {
  async function resolve(principal: SessionPrincipal, input: PhaseRef, scope: "customer" | "staff", tx?: Tx, forUpdate = false) {
    if (scope === "customer" && principal.role !== "customer") throw forbidden("CUSTOMER_ONLY");
    if (scope === "staff" && !roleHasCapability(principal.role, "orders.questions.manage")) throw forbidden("CAPABILITY_NOT_GRANTED");
    const view = await deps.policy.assertCanReadOrder(principal, input.orderId, { ...(tx ? { tx } : {}), forUpdate });
    if (forUpdate && tx) {
      await deps.actorCheck(principal, tx, scope === "staff" ? "orders.questions.manage" : undefined);
      if (scope === "customer" && view.accessRole === "viewer") throw forbidden("GRANT_READ_ONLY");
      if (lockBlocks(view.lockState, scope === "staff", "order")) throw orderLocked(view.lockState);
    }
    const stage = await deps.resolveStage(view, input.stageKey, tx ?? deps.db);
    if (!stage) throw ORDER_NOT_FOUND();
    if (scope === "customer") {
      if (forUpdate ? !canCustomerAnswer(view, stage) : !stage.customerReadable) throw stageNotOpen();
      if (!stage.answersEnabled) throw stageNotOpen();
      if (forUpdate && tx) await deps.gates.assertCustomerMayWork({ tx, orderId: view.id, actor: principal, action: "intake", statusKey: view.statusKey });
    }
    return { view, stage };
  }
  return resolve;
}
