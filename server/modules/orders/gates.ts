/**
 * Part B (B6) — `orders.gates`: the one server check other modules call before a customer-side mutation on an
 * order (upload, recording, intake answer, phase submit). Gates live in the order's PINNED workflow version;
 * evidence lives with the acceptance provider (identity_engineer, server/modules/compliance/acceptance*), which
 * registers itself here at wiring time. Orders never imports it.
 *
 * Rules (fail closed):
 *  - staff and administrators are never gated;
 *  - `order_start` gates apply to every action; a step gate applies when the action's status
 *    (`statusKey ?? order.statusKey`; for phase_submit the FROM status) equals its `stepKey`;
 *  - gates present but no provider registered ⇒ UNAVAILABLE / ORDER_GATES_UNAVAILABLE;
 *  - system / API v1 transitions are checked against the ORDER OWNER's acceptance;
 *  - always called inside the caller's transaction, after the caller locked the order row.
 */
import { eq } from "drizzle-orm";
import { DomainError } from "../../core/errors.js";
import type { DbOrTx, SessionPrincipal, Tx } from "../../core/types.js";
import type { UserRole } from "../../../shared/domain.js";
import type { OrderPolicy } from "./policy.js";
import { orders } from "./schema.js";
import type { WorkflowService } from "./workflows.js";
import type { AcceptanceGate, WorkflowDefinition } from "./workflowTypes.js";

export type { AcceptanceGate } from "./workflowTypes.js";
export type OrderGateAction = "upload" | "record" | "intake" | "acknowledge" | "phase_submit";
export type OrderGatePoint = { kind: "order_start" } | { kind: "step"; stepKey: string };

export interface OrderGateProvider {
  /** Throws CONFLICT / ORDER_ACCEPTANCE_REQUIRED when `actor` has an unmet gate among `gates`. Reads only. */
  assertMet(input: {
    tx: Tx;
    orderId: number;
    workflowVersionId: number;
    gates: AcceptanceGate[];
    actor: { userId: number; role: UserRole };
    point: OrderGatePoint;
  }): Promise<void>;
}

export interface OrderGateContext {
  orderId: number;
  orderPublicId: string;
  reference: string;
  name: string;
  customerUserId: number;
  workflowVersionId: number;
  currentStatusKey: string;
  gates: AcceptanceGate[];
  actorAccess: "owner" | "grantee" | "staff";
}

export interface OrderGatesService {
  registerProvider(key: "acceptance", provider: OrderGateProvider): void;
  /** Scoped read for the acceptance UI: null when the actor cannot read the order (caller answers NOT_FOUND). */
  context(orderPublicId: string, actor: SessionPrincipal, tx?: DbOrTx): Promise<OrderGateContext | null>;
  /** Session actor. Call inside the tx that commits the protected write. */
  assertCustomerMayWork(input: { tx: Tx; orderId: number; actor: SessionPrincipal; action: OrderGateAction; statusKey: string | null }): Promise<void>;
  /** System / API v1 actor: checked against the order owner's acceptance. */
  assertSystemMayWork(input: { tx: Tx; orderId: number; action: OrderGateAction; statusKey: string | null }): Promise<void>;
  /** Trusted: the gates of a pinned version (empty when none). */
  gatesOf(definition: WorkflowDefinition): AcceptanceGate[];
}

const unavailable = () =>
  new DomainError("UNAVAILABLE", "ORDER_GATES_UNAVAILABLE", "This action is temporarily unavailable. Please try again later.");

export function applicableGates(gates: AcceptanceGate[], statusKey: string): AcceptanceGate[] {
  return gates.filter((gate) => gate.point === "order_start" || gate.point.stepKey === statusKey);
}

export function createGatesService(deps: { db: DbOrTx; policy: OrderPolicy; workflows: WorkflowService }): OrderGatesService {
  let provider: OrderGateProvider | null = null;
  const gatesOf = (definition: WorkflowDefinition) => definition.acceptanceGates ?? [];

  async function check(tx: Tx, orderId: number, actor: { userId: number; role: UserRole }, statusKey: string | null) {
    const [row] = await tx
      .select({ id: orders.id, statusKey: orders.statusKey, workflowVersionId: orders.workflowVersionId, ownerUserId: orders.ownerUserId })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    if (!row) throw new DomainError("NOT_FOUND", "ORDER_NOT_FOUND", "We couldn't find that order.");
    const bound = await deps.workflows.byVersionId(tx, row.workflowVersionId);
    const effective = statusKey ?? row.statusKey;
    const gates = applicableGates(gatesOf(bound.definition), effective);
    if (gates.length === 0) return row;
    if (!provider) throw unavailable();
    const stepGate = gates.find((gate) => gate.point !== "order_start");
    const point: OrderGatePoint = stepGate ? { kind: "step", stepKey: effective } : { kind: "order_start" };
    await provider.assertMet({ tx, orderId: row.id, workflowVersionId: row.workflowVersionId, gates, actor: actor.userId === 0 ? { userId: row.ownerUserId, role: "customer" } : actor, point });
    return row;
  }

  return {
    gatesOf,
    registerProvider(key, next) {
      if (key !== "acceptance" || typeof next?.assertMet !== "function") throw new Error("invalid order gate provider");
      provider = next;
    },
    async context(orderPublicId, actor, tx) {
      let view;
      try {
        view = await deps.policy.assertCanReadOrder(actor, orderPublicId, { tx });
      } catch (error) {
        if (error instanceof DomainError && (error.code === "NOT_FOUND" || error.code === "FORBIDDEN")) return null;
        throw error;
      }
      const db = tx ?? deps.db;
      const [row] = await db.select({ projectName: orders.projectName }).from(orders).where(eq(orders.id, view.id)).limit(1);
      const bound = await deps.workflows.byVersionId(db, view.workflowVersionId);
      return {
        orderId: view.id,
        orderPublicId: view.publicId,
        reference: view.reference,
        name: row?.projectName ?? "",
        customerUserId: view.ownerUserId,
        workflowVersionId: view.workflowVersionId,
        currentStatusKey: view.statusKey,
        gates: gatesOf(bound.definition),
        actorAccess: view.accessRole === "staff" || view.accessRole === "admin" ? "staff" : view.accessRole === "owner" ? "owner" : "grantee",
      };
    },
    async assertCustomerMayWork({ tx, orderId, actor, statusKey }) {
      if (actor.role === "staff" || actor.role === "admin") return;
      if (!Number.isInteger(actor.userId) || actor.userId <= 0) throw unavailable();
      await check(tx, orderId, { userId: actor.userId, role: actor.role }, statusKey);
    },
    async assertSystemMayWork({ tx, orderId, statusKey }) {
      // userId 0 is the sentinel for "use the owner" inside check(); never a real user id.
      await check(tx, orderId, { userId: 0, role: "customer" }, statusKey);
    },
  };
}
