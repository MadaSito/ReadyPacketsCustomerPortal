/**
 * Increment 07 (D1/D3/D9): phases-first workflows — `orders.stages.*` procedures and the stage ports other owners
 * call (files, assurance, engagement, portable_ops, compliance). See API.md "Increment 07".
 *
 * Rules: the customer works only in the CURRENT stage (open / reopened, not locked); earlier stages are read-only,
 * later stages are `future` (STAGE_NOT_OPEN). Gates and requirements are never bypassed. A status change for a stage
 * is an allowed transition of the pinned version, or an audited administrator override. Every write recalculates
 * progress and attention in the same transaction.
 */
import { and, eq } from "drizzle-orm";
import { roleHasCapability } from "../../../shared/capabilities.js";
import type { StageAdminTask, StageGovernance, StageUploadIntent, WorkflowStage } from "../../../shared/workflowStages.js";
import type { StageFileSyncPlan } from "../../../shared/orderStageFileSync.js";
import { conflict, DomainError, forbidden, notFound, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { AuditEmitter, Clock, Db, DbOrTx, FieldCrypto, Logger, SessionPrincipal, Tx } from "../../core/types.js";
import { hasFreshStepUp } from "../../trpc/trpc.js";
import type { ActorCheck } from "./actor.js";
import type { OrderGatesService } from "./gates.js";
import type { OrderService } from "./orderService.js";
import { ORDER_NOT_FOUND, orderLocked, type OrderPolicy } from "./policy.js";
import { assertStageQuestionsAnswered } from "./questions.js";
import type { ResolvedQuestionStage } from "./questionsAccess.js";
import type { RequirementsService } from "./requirements.js";
import { sha256Hex } from "./requirements.js";
import { orderNotes, orderPhaseLocks, orders, orderStageProgress, type OrderPaymentState } from "./schema.js";
import { isCanceledStatus, type StageProgressRow, type StageRuntime } from "./stageRuntime.js";
import { customerMayNext, stageAckText, stageIndexOfStatus, stageModelOf, type StageModel } from "./stageModel.js";
import type { OrderAccessView } from "./types.js";
import type { BoundWorkflow, WorkflowService } from "./workflows.js";
import { findState, transitionsFrom, type WorkflowActor } from "./workflowTypes.js";

export interface StagesDeps {
  db: Db;
  clock: Clock;
  audit: AuditEmitter;
  crypto: FieldCrypto;
  logger: Logger;
  policy: OrderPolicy;
  actorCheck: ActorCheck;
  workflows: Pick<WorkflowService, "byVersionId">;
  requirements: Pick<RequirementsService, "assertRequirementsMetInTx">;
  gates: Pick<OrderGatesService, "assertCustomerMayWork">;
  orders: Pick<OrderService, "applyStatusInTx" | "notifyStatusChanged">;
  runtime: StageRuntime;
}

export type StageViewState = "future" | "open" | "submitted" | "in_review" | "accepted" | "reopened";

export interface StageWorkspaceStage {
  key: string;
  customerLabel: string;
  staffLabel?: string;
  index: number;
  state: StageViewState;
  completed: boolean;
  locked: boolean;
  viewable: boolean;
  futureReason?: "PREVIOUS_PHASE_OPEN" | "NOT_REACHED";
  progression: WorkflowStage["progression"];
  acknowledgement: { policy: WorkflowStage["acknowledgement"]["policy"]; message: string | null; textSha256: string | null };
  contentMarkdown: string | null;
  actions: WorkflowStage["actions"];
  governance: StageGovernance | null;
  adminTasks?: StageAdminTask[];
  submittedAt: string | null;
  review: { outcome: "accepted" | "changes_requested"; note: string | null; at: string } | null;
  canNext: boolean;
  /** Current phase, customer view: "payment" = waiting for payment confirmation, "team" = staff complete it. */
  waitingOn: "payment" | "team" | null;
  canSubmit: boolean;
  canReview: boolean;
  canReopen: boolean;
}

export interface StageWorkspace {
  orderId: string;
  version: number;
  workflowFormat: 1 | 2 | 3;
  derived: boolean;
  progress: { percent: number; canceled: boolean; currentIndex: number; total: number; currentLabel: string | null };
  currentStageKey: string | null;
  orderLocked: boolean;
  stages: StageWorkspaceStage[];
}

const actorOf = (principal: SessionPrincipal) => ({ userId: principal.userId, role: principal.role });
const staleVersion = () => conflict("STALE_VERSION", "This order was changed by someone else. Reload and try again.");
const stageNotFound = () => notFound("STAGE_NOT_FOUND");
const stageNotOpen = () => conflict("STAGE_NOT_OPEN", "This phase is not open yet. Finish the current phase first.");
const stageLocked = () => new DomainError("FORBIDDEN", "STAGE_LOCKED", "This phase is locked. Ask our team to reopen it if something needs to change.");
const stageActionOff = () => conflict("STAGE_ACTION_OFF", "This action is not available in this phase.");
const isStaffSide = (view: Pick<OrderAccessView, "accessRole">) => view.accessRole === "staff" || view.accessRole === "admin";
const workingStates = new Set<StageViewState>(["open", "reopened"]);

function staffActor(principal: SessionPrincipal): WorkflowActor {
  return principal.role === "admin" ? "admin" : "staff";
}

export function createStagesService(deps: StagesDeps) {
  const { runtime } = deps;

  /* ------------------------------------------------------------------------------------------ projection */

  interface Projection {
    model: StageModel;
    rows: StageProgressRow[];
    lockedKeys: Set<string>;
    currentIndex: number;
    canceled: boolean;
  }

  async function project(db: DbOrTx, view: Pick<OrderAccessView, "id" | "statusKey" | "workflowVersionId">, bound: BoundWorkflow, forUpdate = false): Promise<Projection> {
    const model = stageModelOf(bound.definition);
    const rows = model.derived ? [] : await runtime.progressRows(db, view.id, view.workflowVersionId, forUpdate);
    const locks = await db.select({ phaseKey: orderPhaseLocks.phaseKey, state: orderPhaseLocks.state }).from(orderPhaseLocks).where(eq(orderPhaseLocks.orderId, view.id));
    const lookup = await runtime.statusLookup(db, bound, view.statusKey);
    return {
      model,
      rows,
      lockedKeys: new Set(model.derived ? [] : locks.filter((row) => row.state === "locked").map((row) => row.phaseKey)),
      currentIndex: stageIndexOfStatus(model, view.statusKey),
      canceled: isCanceledStatus(view.statusKey, lookup),
    };
  }

  function stateAt(projection: Projection, index: number): StageViewState {
    const stage = projection.model.stages[index]!;
    const row = projection.rows.find((candidate) => candidate.stageKey === stage.key);
    if (row && (row.state !== "accepted" || index <= projection.currentIndex || projection.currentIndex < 0)) return row.state;
    if (projection.currentIndex < 0) return "future";
    if (index < projection.currentIndex) return "accepted";
    if (index === projection.currentIndex) return "open";
    return "future";
  }

  function isViewable(projection: Projection, index: number): boolean {
    const key = projection.model.stages[index]!.key;
    return (projection.currentIndex >= 0 && index <= projection.currentIndex) || projection.rows.some((row) => row.stageKey === key);
  }

  function findStage(projection: Projection, stageKey: string): { stage: WorkflowStage; index: number } {
    const index = projection.model.stages.findIndex((stage) => stage.key === stageKey);
    if (index < 0) throw stageNotFound();
    return { stage: projection.model.stages[index]!, index };
  }

  async function loadOrderRow(db: DbOrTx, orderPublicId: string, forUpdate: boolean) {
    const query = db.select().from(orders).where(eq(orders.publicId, orderPublicId)).limit(1);
    const [row] = forUpdate ? await query.for("update") : await query;
    if (!row) throw ORDER_NOT_FOUND();
    return row;
  }

  async function bumpVersion(tx: Tx, orderId: number, version: number): Promise<number> {
    const result = await tx.update(orders).set({ version: version + 1, updatedAt: deps.clock.now() }).where(and(eq(orders.id, orderId), eq(orders.version, version)));
    const affected = (result as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? (result as unknown as { affectedRows?: number }).affectedRows;
    if (affected !== 1) throw staleVersion();
    return version + 1;
  }

  async function progressRow(tx: Tx, orderId: number, workflowVersionId: number, stage: WorkflowStage): Promise<StageProgressRow> {
    const rows = await runtime.progressRows(tx, orderId, workflowVersionId, true);
    const existing = rows.find((row) => row.stageKey === stage.key);
    if (existing) return existing;
    await runtime.openStage(tx, orderId, workflowVersionId, stage, rows);
    const [created] = await runtime.progressRows(tx, orderId, workflowVersionId, true).then((list) => list.filter((row) => row.stageKey === stage.key));
    return created!;
  }

  async function insertNote(tx: Tx, orderId: number, principal: SessionPrincipal, visibility: "customer" | "internal", body: string): Promise<string> {
    const publicId = ulid(deps.clock.now().getTime());
    await tx.insert(orderNotes).values({
      publicId,
      orderId,
      authorUserId: principal.userId,
      authorRole: principal.role,
      visibility,
      bodyEnc: deps.crypto.encrypt(body, `order_notes.body:${publicId}`),
      createdAt: deps.clock.now(),
    });
    return publicId;
  }

  async function noteBody(db: DbOrTx, publicId: string | null): Promise<string | null> {
    if (!publicId) return null;
    const [row] = await db.select({ bodyEnc: orderNotes.bodyEnc, visibility: orderNotes.visibility }).from(orderNotes).where(eq(orderNotes.publicId, publicId)).limit(1);
    if (!row || row.visibility !== "customer") return null;
    try {
      return deps.crypto.decrypt(row.bodyEnc, `order_notes.body:${publicId}`);
    } catch {
      return null;
    }
  }

  /** The first allowed transition (for `actor`) from the current status into one of `targets`, in target order. */
  function pickTransition(bound: BoundWorkflow, fromStatus: string, actor: WorkflowActor, targets: readonly string[]): string | null {
    const allowed = new Set(transitionsFrom(bound.definition, fromStatus, actor).map((transition) => transition.to));
    return targets.find((target) => target !== fromStatus && allowed.has(target)) ?? null;
  }

  /** Statuses an order may move to when `stage` is done: the next stage's statuses (in order). */
  function nextStageTargets(model: StageModel, index: number): string[] {
    return model.stages[index + 1]?.statusKeys ?? [];
  }

  async function record(tx: Tx, principal: SessionPrincipal | null, eventName: string, orderPublicId: string, attributes: Record<string, string | number | boolean>, category: "business" | "admin" = "business") {
    await deps.audit.record(
      {
        category,
        eventName,
        action: eventName.split(".").pop() ?? "update",
        outcome: "completed",
        actor: principal ? actorOf(principal) : { role: "system" },
        resource: { type: "order", publicId: orderPublicId },
        attributes,
      },
      tx,
    );
  }

  /* ------------------------------------------------------------------------------------------ workspace */

  async function buildWorkspace(db: DbOrTx, principal: SessionPrincipal, view: OrderAccessView, bound: BoundWorkflow): Promise<StageWorkspace> {
    const projection = await project(db, view, bound);
    const staff = isStaffSide(view);
    const [order] = await db.select({ progressPercent: orders.progressPercent }).from(orders).where(eq(orders.id, view.id)).limit(1);
    const format = projection.model.format;
    const v3 = format === 3;
    const orderLockedNow = view.lockState !== "none";
    const owner = view.accessRole === "owner";
    const stages: StageWorkspaceStage[] = [];
    for (const [index, stage] of projection.model.stages.entries()) {
      const state = stateAt(projection, index);
      const row = projection.rows.find((candidate) => candidate.stageKey === stage.key) ?? null;
      const locked = projection.lockedKeys.has(stage.key);
      const viewable = isViewable(projection, index);
      const current = index === projection.currentIndex;
      const customerCanWork = v3 && owner && current && workingStates.has(state) && !locked && !orderLockedNow && !projection.canceled;
      const ackPolicy = stage.acknowledgement.policy;
      stages.push({
        key: stage.key,
        customerLabel: stage.customerLabel,
        ...(staff ? { staffLabel: stage.staffLabel } : {}),
        index,
        state,
        completed: state === "accepted" || (projection.currentIndex >= 0 && index < projection.currentIndex),
        locked,
        viewable: staff || viewable,
        ...(state === "future" ? { futureReason: index === projection.currentIndex + 1 ? ("PREVIOUS_PHASE_OPEN" as const) : ("NOT_REACHED" as const) } : {}),
        progression: stage.progression,
        acknowledgement: {
          policy: ackPolicy,
          message: ackPolicy === "none" ? null : stageAckText(stage),
          textSha256: ackPolicy === "none" ? null : sha256Hex(stageAckText(stage)),
        },
        contentMarkdown: staff || viewable ? (stage.content?.markdown ?? null) : null,
        actions: stage.actions,
        governance: v3 ? (stage.governance ?? {}) : null,
        ...(staff ? { adminTasks: [...stage.adminTasks] } : {}),
        submittedAt: row?.submittedAt ? row.submittedAt.toISOString() : null,
        review: row?.reviewOutcome && row.reviewedAt ? { outcome: row.reviewOutcome, note: await noteBody(db, row.reviewNotePublicId), at: row.reviewedAt.toISOString() } : null,
        canNext: customerCanWork && customerMayNext(stage),
        /** Lead ruling (QA e8fe1ec): why the customer has no Next/Submit on the current phase (null = they do, or not theirs). */
        waitingOn: customerCanWork && !customerMayNext(stage) && stage.progression !== "submit_lock" ? (stage.completesOn === "payment" ? ("payment" as const) : ("team" as const)) : null,
        canSubmit: customerCanWork && stage.progression === "submit_lock",
        canReview: v3 && staff && roleHasCapability(principal.role, "orders.stage.review") && (state === "submitted" || state === "in_review") && !projection.canceled,
        canReopen:
          v3 && principal.role === "admin" && view.accessRole === "admin" && !projection.canceled && !orderLockedNow && (locked || state === "submitted" || state === "in_review" || state === "accepted") && viewable,
      });
    }
    const currentStage = projection.currentIndex >= 0 ? projection.model.stages[projection.currentIndex]! : null;
    return {
      orderId: view.publicId,
      version: view.version,
      workflowFormat: format,
      derived: projection.model.derived,
      progress: {
        percent: order?.progressPercent ?? 0,
        canceled: projection.canceled,
        currentIndex: projection.currentIndex,
        total: projection.model.stages.length,
        currentLabel: currentStage ? (staff ? currentStage.staffLabel : currentStage.customerLabel) : null,
      },
      currentStageKey: currentStage?.key ?? null,
      orderLocked: orderLockedNow,
      stages,
    };
  }

  /* ------------------------------------------------------------------------------- customer: next / submit */

  async function customerStep(principal: SessionPrincipal, input: { orderId: string; stageKey: string; expectedVersion: number; ack?: { accepted: true; textSha256: string } }, kind: "next" | "submit") {
    const outcome = await deps.db.transaction(async (tx) => {
      const view = await deps.policy.assertCanWriteOrder(principal, input.orderId, { kind: "status", tx, forUpdate: true });
      await deps.actorCheck(principal, tx);
      if (view.accessRole !== "owner") throw forbidden("STAGE_OWNER_ONLY");
      if (view.version !== input.expectedVersion) throw staleVersion();
      const bound = await deps.workflows.byVersionId(tx, view.workflowVersionId);
      const projection = await project(tx, view, bound, true);
      if (projection.model.derived) throw stageActionOff();
      const { stage, index } = findStage(projection, input.stageKey);
      if (projection.canceled || index !== projection.currentIndex) throw stageNotOpen();
      if (!workingStates.has(stateAt(projection, index))) throw stageNotOpen();
      if (projection.lockedKeys.has(stage.key)) throw stageLocked();
      if (kind === "next" && stage.progression === "next" && !customerMayNext(stage))
        throw conflict("STAGE_NOT_CUSTOMER_ACTIONABLE", stage.completesOn === "payment" ? "This phase completes when payment is confirmed." : "Our team completes this phase. Nothing is needed from you right now.");
      if ((kind === "next") !== (stage.progression === "next"))
        throw conflict("STAGE_PROGRESSION", kind === "next" ? "This phase is finished with Submit and lock." : "This phase is finished with Next.");
      await deps.gates.assertCustomerMayWork({ tx, orderId: view.id, actor: principal, action: "phase_submit", statusKey: view.statusKey });
      await deps.requirements.assertRequirementsMetInTx(tx, view, bound);
      await assertStageQuestionsAnswered(view.id, view.workflowVersionId, stage.key, tx);
      const ackPolicy = stage.acknowledgement.policy;
      const expectedSha = sha256Hex(stageAckText(stage));
      if (kind === "submit") {
        if (ackPolicy === "required" && !input.ack) throw validation("ACK_REQUIRED", "Please read and accept the statement before submitting.");
        if (input.ack && input.ack.textSha256 !== expectedSha) throw conflict("ACK_TEXT_CHANGED", "The statement changed. Read it again before submitting.");
      }
      const row = await progressRow(tx, view.id, view.workflowVersionId, stage);
      const now = deps.clock.now();
      const reviewNeeded = kind === "submit" && stage.adminTasks.includes("review_submission");
      if (kind === "submit") {
        const acked = Boolean(input.ack) && ackPolicy !== "none";
        await tx
          .update(orderStageProgress)
          .set({
            state: reviewNeeded ? "submitted" : "accepted",
            submittedAt: now,
            submittedByUserId: principal.userId,
            ackPolicy,
            ackTextSha256: acked ? expectedSha : null,
            ackAt: acked ? now : null,
            ackByUserId: acked ? principal.userId : null,
            reviewOutcome: null,
            ...(reviewNeeded ? {} : { completedAt: now, completedHow: "submit" as const }),
            version: row.version + 1,
            updatedAt: now,
          })
          .where(eq(orderStageProgress.id, row.id));
        // Submit and lock: the phase lock (keyed by the stage key) — administrator reopen only.
        const [lock] = await tx.select().from(orderPhaseLocks).where(and(eq(orderPhaseLocks.orderId, view.id), eq(orderPhaseLocks.phaseKey, stage.key))).limit(1).for("update");
        if (lock) {
          await tx
            .update(orderPhaseLocks)
            .set({ state: "locked", lockedAt: now, lockedFromStatus: view.statusKey, workflowVersionId: view.workflowVersionId, version: lock.version + 1, updatedAt: now })
            .where(eq(orderPhaseLocks.id, lock.id));
        } else {
          await tx.insert(orderPhaseLocks).values({ orderId: view.id, workflowVersionId: view.workflowVersionId, phaseKey: stage.key, state: "locked", lockedAt: now, lockedFromStatus: view.statusKey, createdAt: now, updatedAt: now });
        }
      } else {
        await runtime.markAccepted(tx, row, "next");
      }
      // Move the status when an allowed customer transition exists; otherwise the status waits for staff.
      const targets = reviewNeeded ? stage.statusKeys.slice(stage.statusKeys.indexOf(view.statusKey) + 1) : nextStageTargets(projection.model, index);
      const target = pickTransition(bound, view.statusKey, "customer", targets);
      let version: number;
      let moved: Awaited<ReturnType<StagesDeps["orders"]["applyStatusInTx"]>> | null = null;
      if (target) {
        moved = await deps.orders.applyStatusInTx(tx, {
          orderId: view.id,
          toStatus: target,
          principal,
          actor: "customer",
          mode: "transition",
          reasonCode: kind === "next" ? "STAGE_NEXT" : "STAGE_SUBMIT",
          expectedVersion: view.version,
        });
        version = moved.version;
      } else {
        version = await bumpVersion(tx, view.id, view.version);
      }
      const recalc = await runtime.recalcInTx(tx, view.id);
      await record(tx, principal, kind === "next" ? "order.stage.advanced" : "order.stage.submitted", view.publicId, {
        stage_key: stage.key,
        ack_policy: ackPolicy,
        acknowledged: Boolean(input.ack),
        review_needed: reviewNeeded,
        moved_to: target ?? "none",
        progress_percent: recalc.progressPercent,
      });
      const [after] = await tx.select({ statusKey: orders.statusKey }).from(orders).where(eq(orders.id, view.id)).limit(1);
      const currentIndex = stageIndexOfStatus(projection.model, after?.statusKey ?? view.statusKey);
      return { version, moved, progressPercent: recalc.progressPercent, currentStageKey: currentIndex >= 0 ? projection.model.stages[currentIndex]!.key : null };
    });
    if (outcome.moved?.notify)
      await deps.orders.notifyStatusChanged({ view: outcome.moved.view, bound: outcome.moved.bound, toStatus: outcome.moved.toStatus, version: outcome.moved.version, actorUserId: principal.userId });
    return { version: outcome.version, currentStageKey: outcome.currentStageKey, progressPercent: outcome.progressPercent };
  }

  /* --------------------------------------------------------------------------------------- order lookup */

  async function trustedView(tx: DbOrTx, orderPublicId: string, forUpdate: boolean): Promise<OrderAccessView> {
    const row = await loadOrderRow(tx, orderPublicId, forUpdate);
    return {
      id: row.id,
      publicId: row.publicId,
      reference: row.reference,
      ownerUserId: row.ownerUserId,
      ownerPublicId: "",
      statusKey: row.statusKey,
      lockState: row.lockState,
      locked: row.lockState !== "none",
      readOnlyImported: row.lockState === "imported_read_only",
      accessRole: "staff",
      canWrite: row.lockState === "none",
      origin: row.origin,
      version: row.version,
      workflowVersionId: row.workflowVersionId,
    };
  }

  async function viewFor(actor: SessionPrincipal | null, orderPublicId: string, tx: DbOrTx | undefined, forUpdate: boolean): Promise<OrderAccessView> {
    if (actor === null) return trustedView(tx ?? deps.db, orderPublicId, forUpdate && Boolean(tx));
    return deps.policy.assertCanReadOrder(actor, orderPublicId, { ...(tx ? { tx: tx as Tx } : {}), forUpdate: forUpdate && Boolean(tx) });
  }

  const intentAction: Record<Exclude<StageUploadIntent, "legacy">, (stage: WorkflowStage, slotKey?: string) => boolean> = {
    document: (stage) => stage.actions.uploadDocuments,
    recording: (stage) => stage.actions.recordAudio,
    prerecorded_audio: (stage) => stage.actions.uploadAudio,
    document_edit: (stage, slotKey) => stage.actions.uploadDocuments || Boolean(slotKey),
  };

  /* ---------------------------------------------------------------------------------------------- API */

  return {
    /** `orders.stages.workspace` */
    async workspace(principal: SessionPrincipal, input: { orderId: string }): Promise<StageWorkspace> {
      const first = await deps.policy.assertCanReadOrder(principal, input.orderId);
      await runtime.fillForRead([first.id]);
      return deps.db.transaction(async (tx) => {
        const view = await deps.policy.assertCanReadOrder(principal, input.orderId, { tx });
        const bound = await deps.workflows.byVersionId(tx, view.workflowVersionId);
        return buildWorkspace(tx, principal, view, bound);
      });
    },

    /** `orders.stages.next` — finish a "Next" phase. */
    next(principal: SessionPrincipal, input: { orderId: string; stageKey: string; expectedVersion: number }) {
      return customerStep(principal, input, "next");
    },

    /** `orders.stages.submit` — finish a "Submit and lock" phase (acknowledgement evidence + phase lock). */
    submit(principal: SessionPrincipal, input: { orderId: string; stageKey: string; expectedVersion: number; ack?: { accepted: true; textSha256: string } }) {
      return customerStep(principal, input, "submit");
    },

    /** `orders.stages.review` — staff record the outcome of a submitted phase. `changes_requested` does not unlock. */
    async review(principal: SessionPrincipal, input: { orderId: string; stageKey: string; outcome: "accepted" | "changes_requested"; note?: string; expectedVersion: number }) {
      if (!roleHasCapability(principal.role, "orders.stage.review")) throw forbidden("CAPABILITY_NOT_GRANTED");
      if (input.outcome === "changes_requested" && !input.note?.trim())
        throw validation("NOTE_REQUIRED", "Tell the customer what needs to change.");
      const outcome = await deps.db.transaction(async (tx) => {
        const view = await deps.policy.assertCanReadOrder(principal, input.orderId, { tx, forUpdate: true });
        if (!isStaffSide(view)) throw ORDER_NOT_FOUND();
        await deps.actorCheck(principal, tx, "orders.stage.review");
        if (view.lockState === "legal_hold" || view.lockState === "imported_read_only") throw orderLocked(view.lockState);
        if (view.version !== input.expectedVersion) throw staleVersion();
        const bound = await deps.workflows.byVersionId(tx, view.workflowVersionId);
        const projection = await project(tx, view, bound, true);
        if (projection.model.derived) throw stageActionOff();
        const { stage, index } = findStage(projection, input.stageKey);
        const row = projection.rows.find((candidate) => candidate.stageKey === stage.key);
        if (!row || (row.state !== "submitted" && row.state !== "in_review")) throw conflict("STAGE_NOT_SUBMITTED", "This phase has not been submitted.");
        const now = deps.clock.now();
        const notePublicId = input.note ? await insertNote(tx, view.id, principal, "customer", input.note) : null;
        const accepted = input.outcome === "accepted";
        await tx
          .update(orderStageProgress)
          .set({
            reviewOutcome: input.outcome,
            reviewedAt: now,
            reviewedByUserId: principal.userId,
            reviewNotePublicId: notePublicId,
            ...(accepted ? { state: "accepted" as const, completedAt: now, completedHow: "review" as const } : { state: "in_review" as const }),
            version: row.version + 1,
            updatedAt: now,
          })
          .where(eq(orderStageProgress.id, row.id));
        let moved: Awaited<ReturnType<StagesDeps["orders"]["applyStatusInTx"]>> | null = null;
        let version: number;
        const target = accepted && index === projection.currentIndex ? pickTransition(bound, view.statusKey, staffActor(principal), nextStageTargets(projection.model, index)) : null;
        if (target) {
          moved = await deps.orders.applyStatusInTx(tx, { orderId: view.id, toStatus: target, principal, actor: staffActor(principal), mode: "transition", reasonCode: "STAGE_REVIEW_ACCEPTED", expectedVersion: view.version });
          version = moved.version;
        } else {
          version = await bumpVersion(tx, view.id, view.version);
        }
        const recalc = await runtime.recalcInTx(tx, view.id);
        await record(tx, principal, "order.stage.reviewed", view.publicId, { stage_key: stage.key, outcome: input.outcome, note: Boolean(notePublicId), moved_to: target ?? "none", progress_percent: recalc.progressPercent });
        return { version, moved };
      });
      if (outcome.moved?.notify)
        await deps.orders.notifyStatusChanged({ view: outcome.moved.view, bound: outcome.moved.bound, toStatus: outcome.moved.toStatus, version: outcome.moved.version, actorUserId: principal.userId });
      return { version: outcome.version };
    },

    /**
     * `orders.stages.reopen` — administrator, fresh step-up, explicit confirm, reason 10–500 (internal note). Unlocks
     * the phase, moves the order back into it when needed (audited override), and may LOWER progress (audited).
     */
    async reopen(principal: SessionPrincipal, input: { orderId: string; stageKey: string; reason: string; confirm: boolean; expectedVersion: number }) {
      if (principal.role !== "admin" || !roleHasCapability(principal.role, "orders.stage.reopen")) throw forbidden("CAPABILITY_NOT_GRANTED");
      if (!hasFreshStepUp(principal, deps.clock.now())) throw new DomainError("STEP_UP_REQUIRED", "STEP_UP_REQUIRED", "Please confirm your password and authentication code to continue.");
      if (input.confirm !== true) throw validation("CONFIRM_REQUIRED", "Please confirm that you want to reopen this phase.");
      const reason = input.reason.trim();
      if (reason.length < 10 || reason.length > 500) throw validation("REASON_REQUIRED", "Please give a reason of 10 to 500 characters.");
      return deps.db.transaction(async (tx) => {
        const view = await deps.policy.assertCanReadOrder(principal, input.orderId, { tx, forUpdate: true });
        if (view.accessRole !== "admin") throw ORDER_NOT_FOUND();
        await deps.actorCheck(principal, tx, "orders.stage.reopen");
        if (view.lockState !== "none") throw orderLocked(view.lockState);
        if (view.version !== input.expectedVersion) throw staleVersion();
        const bound = await deps.workflows.byVersionId(tx, view.workflowVersionId);
        const projection = await project(tx, view, bound, true);
        if (projection.model.derived) throw stageActionOff();
        const { stage, index } = findStage(projection, input.stageKey);
        const state = stateAt(projection, index);
        const locked = projection.lockedKeys.has(stage.key);
        if (projection.canceled || !isViewable(projection, index) || !(locked || state === "submitted" || state === "in_review" || state === "accepted"))
          throw conflict("STAGE_NOT_REOPENABLE", "This phase cannot be reopened.");
        const now = deps.clock.now();
        const notePublicId = await insertNote(tx, view.id, principal, "internal", `Phase reopened (${stage.key}): ${reason}`);
        const row = await progressRow(tx, view.id, view.workflowVersionId, stage);
        await tx
          .update(orderStageProgress)
          .set({
            state: "reopened",
            completedAt: null,
            completedHow: null,
            reopenedAt: now,
            reopenedByUserId: principal.userId,
            reopenNotePublicId: notePublicId,
            reopenCount: row.reopenCount + 1,
            version: row.version + 1,
            updatedAt: now,
          })
          .where(eq(orderStageProgress.id, row.id));
        const [lock] = await tx.select().from(orderPhaseLocks).where(and(eq(orderPhaseLocks.orderId, view.id), eq(orderPhaseLocks.phaseKey, stage.key))).limit(1).for("update");
        if (lock && lock.state === "locked")
          await tx
            .update(orderPhaseLocks)
            .set({ state: "unlocked", unlockedAt: now, unlockedByUserId: principal.userId, unlockNotePublicId: notePublicId, version: lock.version + 1, updatedAt: now })
            .where(eq(orderPhaseLocks.id, lock.id));
        let version: number;
        if (index !== projection.currentIndex) {
          const moved = await deps.orders.applyStatusInTx(tx, {
            orderId: view.id,
            toStatus: stage.statusKeys[0]!,
            principal,
            actor: "admin",
            mode: "override",
            reasonCode: "STAGE_REOPEN",
            overrideReason: reason,
            expectedVersion: view.version,
          });
          version = moved.version;
        } else {
          version = await bumpVersion(tx, view.id, view.version);
        }
        // A reopen fences pending completion runs and clears the explicit completion.
        const [order] = await tx.select({ completionRevision: orders.completionRevision }).from(orders).where(eq(orders.id, view.id)).limit(1);
        await tx.update(orders).set({ completionPercent: null, completionRevision: (order?.completionRevision ?? 0) + 1 }).where(eq(orders.id, view.id));
        const recalc = await runtime.recalcInTx(tx, view.id, { allowLower: true });
        await record(tx, principal, "order.stage.reopened", view.publicId, { stage_key: stage.key, note_public_id: notePublicId, moved_back: index !== projection.currentIndex }, "admin");
        if (recalc.previousPercent !== null && recalc.progressPercent < recalc.previousPercent)
          await record(tx, principal, "order.progress.lowered", view.publicId, { stage_key: stage.key, from_percent: recalc.previousPercent, to_percent: recalc.progressPercent }, "admin");
        return { version, progressPercent: recalc.progressPercent };
      });
    },

    /* ------------------------------------------------------------------------------------ ports */

    /** Files (D8): which stage an upload belongs to. Null = formats 1/2 without an explicit stage (legacy behaviour). */
    async resolveStageForUpload(
      input: { orderPublicId: string; stageKey?: string | null; intent: StageUploadIntent; actor: SessionPrincipal | null; slotKey?: string },
      tx: Tx,
    ): Promise<{ stageKey: string; statusKey: string; governance: StageGovernance | null } | null> {
      const view = await viewFor(input.actor, input.orderPublicId, tx, true);
      const bound = await deps.workflows.byVersionId(tx, view.workflowVersionId);
      const projection = await project(tx, view, bound);
      const staff = input.actor === null || isStaffSide(view);
      const current = projection.currentIndex >= 0 ? projection.model.stages[projection.currentIndex]! : null;
      if (projection.model.derived) {
        if (!input.stageKey) return null;
        if (!current || current.key !== input.stageKey) throw stageNotOpen();
        return { stageKey: current.key, statusKey: view.statusKey, governance: null };
      }
      let stageKey = input.stageKey ?? null;
      if (!stageKey) {
        // Format 3: only a task-based document edit may omit the phase; everything else names it (fail closed).
        if (input.intent !== "document_edit") throw validation("STAGE_REQUIRED", "Choose the phase this file belongs to.");
        if (!current) throw stageNotOpen();
        stageKey = current.key;
      }
      const { stage, index } = findStage(projection, stageKey);
      const state = stateAt(projection, index);
      if (staff) {
        if (!isViewable(projection, index)) throw stageNotOpen();
      } else {
        if (projection.canceled || index !== projection.currentIndex || !workingStates.has(state)) throw stageNotOpen();
        if (projection.lockedKeys.has(stage.key)) throw stageLocked();
        // A customer "legacy" upload into a format-3 phase needs the phase's document upload action.
        const allowed = input.intent === "legacy" ? stage.actions.uploadDocuments : intentAction[input.intent](stage, input.slotKey);
        if (!allowed) throw stageActionOff();
      }
      const statusKey = stage.statusKeys.includes(view.statusKey) ? view.statusKey : stage.statusKeys[0]!;
      return { stageKey: stage.key, statusKey, governance: stage.governance ?? {} };
    },

    /** Files / pickers: the stages of an order with folders and file sync (read; actor null = trusted). */
    async listForOrder(input: { orderPublicId: string; actor: SessionPrincipal | null; stageKey?: string }, tx?: DbOrTx) {
      const db = tx ?? deps.db;
      const view = await viewFor(input.actor, input.orderPublicId, tx, false);
      const bound = await deps.workflows.byVersionId(db, view.workflowVersionId);
      const projection = await project(db, view, bound);
      const staff = input.actor === null || isStaffSide(view);
      const statusToStage: Record<string, string> = Object.fromEntries(projection.model.statusToStage);
      const stages = projection.model.stages
        .map((stage, index) => ({
          key: stage.key,
          customerLabel: stage.customerLabel,
          staffLabel: stage.staffLabel,
          index,
          statusKeys: [...stage.statusKeys],
          viewable: staff || isViewable(projection, index),
          governance: projection.model.derived ? null : (stage.governance ?? {}),
          folders: stage.folders,
          fileSync: stage.fileSync,
        }))
        .filter((stage) => !input.stageKey || stage.key === input.stageKey);
      return { format: projection.model.format, stages, statusToStage };
    },

    /** Assurance (D4) guard: locks the order row; enforces the pin, the current stage and the role. */
    async assertStageAccess(input: { orderPublicId: string; actor: SessionPrincipal; stageKey: string; mode: "customer_write" | "staff_manage" | "read" }, tx: Tx) {
      const view =
        input.mode === "customer_write"
          ? await deps.policy.assertCanWriteOrder(input.actor, input.orderPublicId, { kind: "order", tx, forUpdate: true })
          : await deps.policy.assertCanReadOrder(input.actor, input.orderPublicId, { tx, forUpdate: true });
      const bound = await deps.workflows.byVersionId(tx, view.workflowVersionId);
      const projection = await project(tx, view, bound, true);
      const { stage, index } = findStage(projection, input.stageKey);
      const state = stateAt(projection, index);
      const locked = projection.lockedKeys.has(stage.key);
      if (input.mode === "customer_write") {
        if (projection.model.derived) throw stageActionOff();
        if (isStaffSide(view)) throw forbidden("CUSTOMER_ONLY");
        if (projection.canceled || index !== projection.currentIndex || !workingStates.has(state)) throw stageNotOpen();
        if (locked) throw stageLocked();
      } else if (input.mode === "staff_manage") {
        if (!isStaffSide(view)) throw ORDER_NOT_FOUND();
        if (projection.model.derived) throw stageActionOff();
      } else if (!isStaffSide(view) && !isViewable(projection, index)) {
        throw stageNotOpen();
      }
      return { orderId: view.id, orderPublicId: view.publicId, workflowVersionId: view.workflowVersionId, stage, state, locked };
    },

    /** Assurance (D4) phaseWork adapter: the same projection, no new transaction. */
    async resolveQuestionStage(order: OrderAccessView, stageKey: string, db: DbOrTx): Promise<ResolvedQuestionStage | null> {
      const bound = await deps.workflows.byVersionId(db, order.workflowVersionId);
      const projection = await project(db, order, bound);
      const index = projection.model.stages.findIndex((stage) => stage.key === stageKey);
      if (index < 0 || projection.model.derived) return null;
      const stage = projection.model.stages[index]!;
      const state = stateAt(projection, index);
      const locked = projection.lockedKeys.has(stage.key);
      const current = index === projection.currentIndex;
      return {
        customerReadable: isViewable(projection, index) && state !== "future",
        customerWritable: current && workingStates.has(state) && !locked && !projection.canceled,
        staffQuestionsWritable: !projection.canceled && (state === "future" || workingStates.has(state)),
        answersEnabled: stage.actions.answerQuestions,
        adminTasks: stage.adminTasks,
      };
    },

    /** Portable ops (D12): folders + file sync of one stage of the pinned version. Null for formats 1/2 or unknown. */
    async getOrderStageFileSync(input: { orderPublicId: string; stageKey: string }, tx: DbOrTx): Promise<StageFileSyncPlan | null> {
      const row = await loadOrderRow(tx, input.orderPublicId, false).catch(() => null);
      if (!row) return null;
      const bound = await deps.workflows.byVersionId(tx, row.workflowVersionId);
      const model = stageModelOf(bound.definition);
      if (model.derived) return null;
      const stage = model.stages.find((candidate) => candidate.key === input.stageKey);
      return stage ? { key: stage.key, folders: stage.folders, fileSync: stage.fileSync } : null;
    },

    refreshAttentionInTx: (orderId: number, tx: Tx) => runtime.refreshAttentionInTx(orderId, tx),

    /** Engagement (D5): context for a stage action bundle run (trusted; caller authorised). */
    async contextForRun(orderPublicId: string, tx: DbOrTx) {
      const row = await loadOrderRow(tx, orderPublicId, false);
      const bound = await deps.workflows.byVersionId(tx, row.workflowVersionId);
      const model = stageModelOf(bound.definition);
      const index = stageIndexOfStatus(model, row.statusKey);
      return {
        orderId: row.id,
        workflowVersionId: row.workflowVersionId,
        statusKey: row.statusKey,
        currentStageKey: index >= 0 ? model.stages[index]!.key : null,
        stages: model.derived ? [] : model.stages,
        completionRevision: row.completionRevision,
        progressPercent: row.progressPercent ?? 0,
      };
    },

    /** Engagement (D5): status change of a human-confirmed bundle run — allowed transition, or audited admin override. */
    async applyStageStatus(input: { orderPublicId: string; toStatus: string; actor: SessionPrincipal; runPublicId: string; override?: { reason: string } }, tx: Tx) {
      if (!roleHasCapability(input.actor.role, "orders.stage.run")) throw forbidden("CAPABILITY_NOT_GRANTED");
      const row = await loadOrderRow(tx, input.orderPublicId, true);
      const result = await deps.orders.applyStatusInTx(tx, {
        orderId: row.id,
        toStatus: input.toStatus,
        principal: input.actor,
        actor: staffActor(input.actor),
        mode: input.override ? "override" : "transition",
        reasonCode: "STAGE_RUN",
        ...(input.override ? { overrideReason: input.override.reason } : {}),
      });
      return { fromStatus: result.fromStatus, toStatus: result.toStatus, version: result.version };
    },

    /** Engagement (D5): explicit completion percent, fenced by `completion_revision` (stale ⇒ applied: false). */
    async applyCompletionPercent(input: { orderPublicId: string; percent: number; expectedRevision: number; source: "stage_run" | "rule" | "job"; sourceRef: string }, tx: Tx) {
      if (!Number.isInteger(input.percent) || input.percent < 0 || input.percent > 100) throw validation("PERCENT_INVALID", "The percentage must be a whole number from 0 to 100.");
      const row = await loadOrderRow(tx, input.orderPublicId, true);
      if (row.completionRevision !== input.expectedRevision) return { applied: false, revision: row.completionRevision, progressPercent: row.progressPercent ?? 0 };
      const revision = row.completionRevision + 1;
      await tx.update(orders).set({ completionPercent: input.percent, completionRevision: revision }).where(eq(orders.id, row.id));
      const recalc = await runtime.recalcInTx(tx, row.id);
      await record(tx, null, "order.progress.completion_applied", row.publicId, { percent: input.percent, source: input.source, source_ref: input.sourceRef.slice(0, 128), shown: recalc.progressPercent });
      return { applied: true, revision, progressPercent: recalc.progressPercent };
    },
  };
}

export type StagesService = ReturnType<typeof createStagesService>;

/* ============================================================================================= payments (D9) */

export interface OrderPaymentsDeps {
  clock: Clock;
  audit: AuditEmitter;
  logger: Logger;
  workflows: Pick<WorkflowService, "byVersionId">;
  orders: Pick<OrderService, "applyStatusInTx">;
  runtime: StageRuntime;
}

export function createOrderPaymentsPort(deps: OrderPaymentsDeps) {
  async function lockOrder(tx: Tx, orderPublicId: string) {
    const [row] = await tx.select().from(orders).where(eq(orders.publicId, orderPublicId)).limit(1).for("update");
    if (!row) throw ORDER_NOT_FOUND();
    return row;
  }

  async function recordChange(tx: Tx, orderPublicId: string, from: OrderPaymentState, to: OrderPaymentState, ref: string) {
    await deps.audit.record(
      {
        category: "business",
        eventName: "order.payment_state.changed",
        action: "update",
        outcome: "completed",
        actor: { role: "system" },
        resource: { type: "order", publicId: orderPublicId },
        attributes: { from_state: from, to_state: to, ref: ref.slice(0, 128) },
      },
      tx,
    );
  }

  return {
    /** Compliance (M): in the invoice-paid tx. Idempotent; completes a `completesOn: payment` stage and advances. */
    async onInvoicePaidInTx(
      input: { orderPublicId: string; invoicePublicId: string; paidAt: Date; method: "stripe" | "manual"; amountMinor: number; currency: string },
      tx: Tx,
    ): Promise<{ paymentState: OrderPaymentState; stageCompleted: string | null; advancedTo: string | null }> {
      const row = await lockOrder(tx, input.orderPublicId);
      if (row.paymentState === "paid") return { paymentState: "paid", stageCompleted: null, advancedTo: null };
      await tx.update(orders).set({ paymentState: "paid", paidAt: input.paidAt }).where(eq(orders.id, row.id));
      await recordChange(tx, row.publicId, row.paymentState, "paid", input.invoicePublicId);
      const bound = await deps.workflows.byVersionId(tx, row.workflowVersionId);
      const model = stageModelOf(bound.definition);
      let stageCompleted: string | null = null;
      let advancedTo: string | null = null;
      const index = stageIndexOfStatus(model, row.statusKey);
      const stage = index >= 0 ? model.stages[index]! : null;
      if (!model.derived && stage?.completesOn === "payment" && row.lockState === "none") {
        const rows = await deps.runtime.progressRows(tx, row.id, row.workflowVersionId, true);
        await deps.runtime.openStage(tx, row.id, row.workflowVersionId, stage, rows);
        const [progress] = (await deps.runtime.progressRows(tx, row.id, row.workflowVersionId, true)).filter((candidate) => candidate.stageKey === stage.key);
        if (progress) await deps.runtime.markAccepted(tx, progress, "payment");
        stageCompleted = stage.key;
        const targets = model.stages[index + 1]?.statusKeys ?? [];
        for (const actor of ["api", "staff", "admin"] as const) {
          const allowed = new Set(transitionsFrom(bound.definition, row.statusKey, actor).map((transition) => transition.to));
          const target = targets.find((candidate) => allowed.has(candidate));
          if (!target) continue;
          try {
            await deps.orders.applyStatusInTx(tx, { orderId: row.id, toStatus: target, principal: null, actor, mode: "transition", reasonCode: "INVOICE_PAID" });
            advancedTo = target;
          } catch (error) {
            // Payment must never fail because the order cannot move (e.g. an acceptance gate): staff move it later.
            if (!(error instanceof DomainError)) throw error;
            deps.logger.warn("paid order could not advance", { orderPublicId: row.publicId, reasonCode: error.reasonCode });
          }
          break;
        }
      }
      if (!advancedTo) await deps.runtime.recalcInTx(tx, row.id);
      return { paymentState: "paid", stageCompleted, advancedTo };
    },

    /** Compliance / payments (M): async payment events. Never moves the status. */
    async onPaymentEventInTx(input: { orderPublicId: string; kind: "pending_async" | "failed" | "refunded" | "partially_refunded"; eventRef: string }, tx: Tx): Promise<{ paymentState: OrderPaymentState }> {
      const row = await lockOrder(tx, input.orderPublicId);
      const current = row.paymentState;
      let next: OrderPaymentState = current;
      if (input.kind === "refunded") next = "refunded";
      else if (input.kind === "partially_refunded") next = current === "refunded" ? current : "partially_refunded";
      else if (input.kind === "pending_async") next = current === "unpaid" || current === "not_required" ? "pending_async" : current;
      else if (input.kind === "failed") next = current === "pending_async" ? "unpaid" : current;
      if (next !== current) {
        await tx.update(orders).set({ paymentState: next }).where(eq(orders.id, row.id));
        await recordChange(tx, row.publicId, current, next, input.eventRef);
      }
      return { paymentState: next };
    },
  };
}

export type OrderPaymentsPort = ReturnType<typeof createOrderPaymentsPort>;

/** Used by findState-based callers that need the stage of a status (re-export for API consumers). */
export { findState };
