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
 *
 * Increment 06 (D14) — order agreement (MNDA): setting `orders.agreement_gate` adds ONE implicit, account-level
 * gate on the same provider (`agreementStatus`). When enabled, customer actors are checked on placing an order
 * (`assertCustomerMayPlaceOrder`, `applyTo.placeOrder`) and on every `assertCustomerMayWork` action
 * (`applyTo.workOnOrder`). Refusal: CONFLICT / AGREEMENT_REQUIRED with `{ policyPublicId, signatureMode }`; the
 * client opens the acceptance dialog and repeats the action. Staff, administrators and API v1 keys
 * (`assertSystemMayWork`) are never checked against it. Provider without `agreementStatus` ⇒ UNAVAILABLE.
 */
import { and, eq } from "drizzle-orm";
import { DomainError } from "../../core/errors.js";
import type { DbOrTx, SessionPrincipal, Tx } from "../../core/types.js";
import type { UserRole } from "../../../shared/domain.js";
import type { OrderPolicy } from "./policy.js";
import type { AgreementGateSetting } from "./settings.js";
import { orders } from "./schema.js";
import { liveOrderPredicate } from "./trashGate.js";
import type { WorkflowService } from "./workflows.js";
import type { AcceptanceGate, WorkflowDefinition } from "./workflowTypes.js";

export type { AcceptanceGate } from "./workflowTypes.js";
export type OrderGateAction = "upload" | "record" | "intake" | "acknowledge" | "phase_submit" | "edit_document";

/** Increment 06 (D14): the implicit gate key used for the account-level order agreement. */
export const AGREEMENT_GATE_KEY = "order_agreement";
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
  /**
   * Increment 06 (D14), optional: ACCOUNT-level check (not per order) — has `userId` accepted `gate.policyPublicId`
   * (its current version when `gate.askAgainOnNewVersion`)? Reads only, inside `tx`.
   */
  agreementStatus?(input: { tx: DbOrTx; userId: number; gate: AcceptanceGate }): Promise<{ met: boolean }>;
}

export interface AgreementRequirement {
  /** Gate on and applicable to this actor/action. */
  required: boolean;
  met: boolean;
  policyPublicId: string | null;
  signatureMode: AgreementGateSetting["signatureMode"];
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
  /** Increment 06 (D14): checkout / order creation by a customer actor. Call inside the creating tx. */
  assertCustomerMayPlaceOrder(input: { tx: DbOrTx; actor: SessionPrincipal }): Promise<void>;
  /** Increment 06 (D14): display state for the signed-in customer (staff ⇒ never required). Writes re-check. */
  agreementFor(input: { tx?: DbOrTx; actor: SessionPrincipal; scope: "placeOrder" | "workOnOrder" }): Promise<AgreementRequirement>;
  /** Trusted: the gates of a pinned version (empty when none). */
  gatesOf(definition: WorkflowDefinition): AcceptanceGate[];
}

const unavailable = () =>
  new DomainError("UNAVAILABLE", "ORDER_GATES_UNAVAILABLE", "This action is temporarily unavailable. Please try again later.");

export function applicableGates(gates: AcceptanceGate[], statusKey: string): AcceptanceGate[] {
  return gates.filter((gate) => gate.point === "order_start" || gate.point.stepKey === statusKey);
}

export const agreementRequired = (setting: Pick<AgreementGateSetting, "policyPublicId" | "signatureMode">) =>
  new DomainError("CONFLICT", "AGREEMENT_REQUIRED", "Please read and accept the agreement to continue.", {
    policyPublicId: setting.policyPublicId ?? "",
    signatureMode: setting.signatureMode,
  });

export function agreementGateOf(setting: AgreementGateSetting): AcceptanceGate | null {
  if (!setting.enabled || setting.policyPublicId === null) return null;
  return { key: AGREEMENT_GATE_KEY, policyPublicId: setting.policyPublicId, point: "order_start", signatureMode: setting.signatureMode, askAgainOnNewVersion: setting.askAgainOnNewVersion };
}

export function createGatesService(deps: {
  db: DbOrTx;
  policy: OrderPolicy;
  workflows: WorkflowService;
  /** Increment 06 (D14): `orders.agreement_gate`, parsed with defaults (never throws). */
  agreementGate: (tx?: DbOrTx) => Promise<AgreementGateSetting>;
}): OrderGatesService {
  let provider: OrderGateProvider | null = null;
  const gatesOf = (definition: WorkflowDefinition) => definition.acceptanceGates ?? [];
  const isStaff = (actor: SessionPrincipal) => actor.role === "staff" || actor.role === "admin";

  /** null when the gate does not apply; else whether the account has accepted. Fails closed without a provider. */
  async function agreement(tx: DbOrTx, actor: SessionPrincipal, scope: "placeOrder" | "workOnOrder") {
    if (isStaff(actor)) return null;
    const setting = await deps.agreementGate(tx);
    // Enabled without a usable policy = a damaged stored value: fail closed rather than drop the agreement.
    if (setting.enabled && setting.policyPublicId === null) throw unavailable();
    const gate = agreementGateOf(setting);
    if (!gate || !setting.applyTo[scope]) return null;
    if (!Number.isInteger(actor.userId) || actor.userId <= 0 || typeof provider?.agreementStatus !== "function") throw unavailable();
    const status = await provider.agreementStatus({ tx, userId: actor.userId, gate });
    return { setting, met: status?.met === true };
  }

  async function assertAgreement(tx: DbOrTx, actor: SessionPrincipal, scope: "placeOrder" | "workOnOrder") {
    const outcome = await agreement(tx, actor, scope);
    if (outcome && !outcome.met) throw agreementRequired(outcome.setting);
  }

  async function check(tx: Tx, orderId: number, actor: { userId: number; role: UserRole }, statusKey: string | null) {
    const [row] = await tx
      .select({ id: orders.id, statusKey: orders.statusKey, workflowVersionId: orders.workflowVersionId, ownerUserId: orders.ownerUserId })
      .from(orders)
      .where(and(eq(orders.id, orderId), liveOrderPredicate()))
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
      if (next.agreementStatus !== undefined && typeof next.agreementStatus !== "function") throw new Error("invalid order gate provider");
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
      if (isStaff(actor)) return;
      if (!Number.isInteger(actor.userId) || actor.userId <= 0) throw unavailable();
      await assertAgreement(tx, actor, "workOnOrder");
      await check(tx, orderId, { userId: actor.userId, role: actor.role }, statusKey);
    },
    async assertCustomerMayPlaceOrder({ tx, actor }) {
      await assertAgreement(tx, actor, "placeOrder");
    },
    async agreementFor({ tx, actor, scope }) {
      const setting = await deps.agreementGate(tx ?? deps.db);
      const off = { required: false, met: true, policyPublicId: null, signatureMode: setting.signatureMode };
      try {
        const outcome = await agreement(tx ?? deps.db, actor, scope);
        if (!outcome) return off;
        return { required: true, met: outcome.met, policyPublicId: outcome.setting.policyPublicId, signatureMode: outcome.setting.signatureMode };
      } catch (error) {
        // Display only; provider missing ⇒ shown as required (writes fail closed with UNAVAILABLE).
        if (error instanceof DomainError && error.code === "UNAVAILABLE")
          return { required: true, met: false, policyPublicId: setting.policyPublicId, signatureMode: setting.signatureMode };
        throw error;
      }
    },
    async assertSystemMayWork({ tx, orderId, statusKey }) {
      // userId 0 is the sentinel for "use the owner" inside check(); never a real user id.
      await check(tx, orderId, { userId: 0, role: "customer" }, statusKey);
    },
  };
}
