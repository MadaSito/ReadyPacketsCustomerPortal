/**
 * Order lifecycle: create, read, list, edit, notes, workflow transitions, locks, reference changes and
 * reassignment. Every entry point re-checks resource scope through the order policy.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, like, lt, lte, or, sql } from "drizzle-orm";
import { roleHasCapability, type Capability } from "../../../shared/capabilities.js";
import { createActorCheck } from "./actor.js";
import { hasFreshStepUp } from "../../trpc/trpc.js";
import { conflict, DomainError, forbidden, notFound, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { AuditEmitter, Clock, Db, DbOrTx, FieldCrypto, Logger, Mailer, SessionPrincipal, SettingsStore, Tx } from "../../core/types.js";
import type { Services } from "../../container.js";
import { readSetting } from "../platform/index.js";
import type { CatalogService } from "./catalog.js";
import { orderGrants, orderLineItems, orderLockHistory, orderNotes, orderReassignments, orderNameHistory, orderReferences, orders, orderStageProgress, orderStatusHistory } from "./schema.js";
import { ORDER_NOT_FOUND, orderLocked, type OrderPolicy } from "./policy.js";
import { compliancePort, engagementPort, filesPort, identityPort, namePartsInTx, paymentExposurePort, promoNotApplicable, promotionsPort, releaseIsSafe, requirePromotions, withPromoAttemptGuard, type PromotionContext, type PromotionOutcome } from "./ports.js";
import { getRequestContext } from "../../core/requestContext.js";
import { allocateStemReference, buildReferenceStem, normalizeReference, reserveReference } from "./references.js";
import { addOnTarget, assertAddOnAllowed, groupMembers, isGroupOrderCancelled, lockGroupRoot, packetNumbersByOrder, prelockGroupRoot } from "./orderGroups.js";
import { ORDER_NOTIFY_MAIL, ORDER_REFERENCE_PREFIX } from "./settings.js";
import type { OrderAccessRole, OrderAccessView, OrderLockState, OrderProductionScope, OrderQuote, OrderSummary, NoteVisibility } from "./types.js";
import type { PacketTier } from "./schema.js";
import { priceOrder, type OrderPricing } from "./pricing.js";
import type { BoundWorkflow, WorkflowService } from "./workflows.js";
import type { RequirementsService } from "./requirements.js";
import type { OrderGatesService } from "./gates.js";
import type { StageRuntime } from "./stageRuntime.js";
import { stageIndexOfStatus, stageModelOf, submitLockStageOf } from "./stageModel.js";
import { assertStageQuestionsAnswered } from "./questions.js";
import type { OrderAttention, OrderPaymentState as OrderPaymentStateV7 } from "./schema.js";
import { findState, initialState, isCancelState, transitionActionLabel, transitionsFrom, type WorkflowActor } from "./workflowTypes.js";

export interface OrderServiceDeps {
  db: Db;
  clock: Clock;
  audit: AuditEmitter;
  crypto: FieldCrypto;
  settings: SettingsStore;
  mailer: Mailer;
  logger: Logger;
  services: Services;
  policy: OrderPolicy;
  catalog: CatalogService;
  workflows: WorkflowService;
  /** Increment 04: requirement guard + phase bookkeeping, run inside the transition tx. */
  requirements: Pick<RequirementsService, "onTransition">;
  /** Increment 04: copies active customer-wide console grants onto a new order (inside the create tx). */
  access: { onOrderCreated(tx: Tx, input: { orderId: number; ownerUserId: number; now: Date }): Promise<number> };
  /** Part B (B6): acceptance gate, run inside the transition tx. */
  gates: Pick<OrderGatesService, "assertCustomerMayWork" | "assertSystemMayWork" | "assertCustomerMayPlaceOrder">;
  /** Part B (B1): console payment badge; registered by compliance at init. Null ⇒ badge hidden. */
  paymentSummary: () => OrderPaymentSummaryProvider | null;
  /** Increment 07 (D1/D2/D3): stage progress, progress percent and attention, in the same tx as every status write. */
  stageRuntime?: Pick<StageRuntime, "afterStatusChangeInTx" | "fillForRead">;
}

export type OrderPaymentState = "unpaid" | "paid" | "partially_refunded" | "refunded" | "void";
export type OrderPaymentSummaryProvider = (
  orderPublicIds: string[],
  tx: DbOrTx,
) => Promise<Map<string, { state: OrderPaymentState; totalMinor: number; currency: string }>>;

export const MAX_PAGE = 100;

/** Increment 03: in-transaction change listeners (e.g. SharePoint order sync). A throwing listener aborts the write. */
export type OrderChangeKind = "created" | "updated" | "status_changed" | "assigned" | "deleted";
export interface OrderChangeEvent {
  orderId: number;
  orderPublicId: string;
  kind: OrderChangeKind;
}
export type OrderChangeListener = (event: OrderChangeEvent, tx: Tx) => Promise<void>;

export function encodeCursor(id: number): string {
  return Buffer.from(`o:${id}`, "utf8").toString("base64url");
}
export function decodeCursor(cursor: string | undefined | null): number | null {
  if (!cursor) return null;
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const match = /^o:(\d{1,15})$/.exec(raw);
  if (!match) throw validation("INVALID_CURSOR", "The list position is not valid. Reload the list.");
  return Number(match[1]);
}

function encodeNameCursor(at: Date, id: number): string {
  return Buffer.from(`n:${at.getTime()}:${id}`, "utf8").toString("base64url");
}
function decodeNameCursor(cursor: string | undefined | null): { at: Date; id: number } | null {
  if (!cursor) return null;
  const match = /^n:(\d{1,15}):(\d{1,15})$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!match) throw validation("INVALID_CURSOR", "The list position is not valid. Reload the list.");
  return { at: new Date(Number(match[1])), id: Number(match[2]) };
}

/** Escapes LIKE wildcards so user input is always a literal prefix/substring. */
export function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

const actorOf = (principal: SessionPrincipal) => ({ userId: principal.userId, role: principal.role });
const staleVersion = () => conflict("STALE_VERSION", "This order was changed by someone else. Reload and try again.");

function workflowActor(view: OrderAccessView): WorkflowActor | null {
  if (view.accessRole === "admin") return "admin";
  if (view.accessRole === "staff") return "staff";
  if (view.accessRole === "owner") return "customer";
  return null;
}

export interface OrderListItem {
  publicId: string;
  reference: string;
  projectName: string;
  statusKey: string;
  statusLabel: string;
  statusTone: string;
  lockState: OrderLockState;
  totalMinor: number;
  currency: string;
  accessRole: OrderAccessRole;
  ownerPublicId?: string;
  ownerName?: string;
  createdAt: Date;
  updatedAt: Date;
  /** Increment 07 (D3): shown progress (0–100); frozen with `progressCanceled` on a canceled order. */
  progressPercent: number;
  progressCanceled: boolean;
  /** Current phase (customer label for customers, staff label for staff); index 0-based, null when none. */
  phaseLabel: string | null;
  phaseIndex: number | null;
  phaseTotal: number;
  /** Increment 07 (D9 / D2). */
  paymentState: OrderPaymentStateV7;
  attention: OrderAttention;
  /** Increment 08 (D3): set on an addition — the project's first order (null for a root or when not shown). */
  group: { rootPublicId: string; rootReference: string } | null;
}

export function createOrderService(deps: OrderServiceDeps) {
  /** Defence in depth: the router already enforces step-up for these capabilities; services re-check. */
  function assertFreshStepUp(principal: SessionPrincipal): void {
    if (!hasFreshStepUp(principal, deps.clock.now())) throw new DomainError("STEP_UP_REQUIRED", "STEP_UP_REQUIRED", "Please confirm your password and authentication code to continue.");
  }

  /** In-tx actor re-validation against PERSISTED session state (see actor.ts for the lock order). */
  const actorCheck = createActorCheck(deps.services, deps.clock);
  const assertActorCurrent = (principal: SessionPrincipal, tx: Tx, capability?: Capability) => actorCheck(principal, tx, capability);

  const { policy, workflows } = deps;

  const changeListeners: OrderChangeListener[] = [];
  /** Called inside the business transaction, after the audit record; listeners run in registration order. */
  async function emitChange(tx: Tx, event: OrderChangeEvent) {
    for (const listener of changeListeners) await listener(event, tx);
  }

  /**
   * Lead QA: a phase with customer work passed by a status change before the customer submitted or finished it.
   * Same transaction as the status change; the status history row carries the same who/when.
   */
  async function auditPassedByStatus(
    tx: Tx,
    stageKeys: string[] | undefined,
    input: { actor: Parameters<AuditEmitter["record"]>[0]["actor"]; orderPublicId: string; fromStatus: string; toStatus: string; reasonCode: string },
  ) {
    for (const stageKey of stageKeys ?? []) {
      await deps.audit.record(
        {
          category: "business",
          eventName: "order.stage.passed_by_status",
          action: "update",
          outcome: "completed",
          actor: input.actor,
          resource: { type: "order", publicId: input.orderPublicId },
          reasonCode: input.reasonCode,
          attributes: { stage_key: stageKey, from_status: input.fromStatus, to_status: input.toStatus, submitted: "false" },
        },
        tx,
      );
    }
  }

  /**
   * Authorization and projection read from ONE consistent snapshot (O-02): a transfer or grant revoke that
   * commits after the snapshot is invisible to both, so a former owner/grantee can never see post-revocation
   * data. No row locks. (Not `accessMode: "read only"`: Drizzle renders it with the snapshot clause as invalid
   * MySQL — "WITH CONSISTENT SNAPSHOT READ ONLY" lacks the required comma.)
   */
  const snapshot = <T>(fn: (tx: Tx) => Promise<T>) =>
    deps.db.transaction(fn, { isolationLevel: "repeatable read", withConsistentSnapshot: true });

  /** B1 console header extras. A failing payment provider never breaks the order page (badge hidden). */
  async function consoleHeader(tx: Tx, orderPublicId: string, ownerUserId: number) {
    const owner = await identityPort(deps.services).getUser(ownerUserId, { tx });
    let payment: { state: OrderPaymentState; totalMinor: number; currency: string } | null = null;
    const provider = deps.paymentSummary();
    if (provider) {
      try {
        payment = (await provider([orderPublicId], tx)).get(orderPublicId) ?? null;
      } catch {
        deps.logger.warn("order payment summary unavailable", { orderPublicId });
      }
    }
    return { customer: owner ? { publicId: owner.publicId, name: owner.name, customerRef: owner.customerRef } : null, payment };
  }

  const encryptNote = (body: string, publicId: string) => deps.crypto.encrypt(body, `order_notes.body:${publicId}`);
  const decryptNote = (bodyEnc: string, publicId: string) => {
    try {
      return deps.crypto.decrypt(bodyEnc, `order_notes.body:${publicId}`);
    } catch {
      deps.logger.warn("order note could not be decrypted", { notePublicId: publicId });
      return null;
    }
  };

  async function insertNote(
    tx: Tx,
    input: { orderId: number; principal: SessionPrincipal | null; visibility: NoteVisibility; body: string },
  ): Promise<{ id: number; publicId: string }> {
    const publicId = ulid(deps.clock.now().getTime());
    await tx.insert(orderNotes).values({
      publicId,
      orderId: input.orderId,
      authorUserId: input.principal?.userId ?? null,
      authorRole: input.principal?.role ?? "system",
      visibility: input.visibility,
      bodyEnc: encryptNote(input.body, publicId),
      createdAt: deps.clock.now(),
    });
    const [row] = await tx.select({ id: orderNotes.id }).from(orderNotes).where(eq(orderNotes.publicId, publicId));
    return { id: row!.id, publicId };
  }

  async function statusPresentation(versionId: number, statusKey: string, db: DbOrTx = deps.db) {
    const bound = await workflows.byVersionId(db, versionId);
    const state = findState(bound.definition, statusKey);
    return {
      label: state?.label ?? statusKey,
      customerLabel: state?.customerLabel ?? statusKey,
      tone: state?.tone ?? "neutral",
      kind: state?.kind ?? "active",
    };
  }

  /** Best-effort in-app notification (+ optional mail). Never blocks or undoes a committed change. */
  async function notifyParticipants(
    order: { id: number; publicId: string; reference: string; ownerUserId: number },
    exceptUserId: number | null,
    kind: string,
    title: string,
    body: string,
    mail?: { template: string; vars: Record<string, string>; idempotencyKey: string },
    idempotencySuffix: string = mail?.idempotencyKey ?? ulid(deps.clock.now().getTime()),
  ) {
    try {
      const grantees = await deps.db
        .select({ userId: orderGrants.granteeUserId })
        .from(orderGrants)
        .where(and(eq(orderGrants.orderId, order.id), eq(orderGrants.status, "active"), isNotNull(orderGrants.granteeUserId)))
        .limit(50);
      const recipients = [...new Set([order.ownerUserId, ...grantees.map((g) => g.userId!)])].filter((id) => id !== exceptUserId);
      const engagement = engagementPort(deps.services);
      const mailOn = mail ? await readSetting(deps.settings, ORDER_NOTIFY_MAIL) : false;
      for (const userId of recipients) {
        if (engagement)
          await engagement.notify({ userId, kind, title, body, link: `/orders/${order.publicId}`, idempotencyKey: `${kind}:${order.publicId}:${idempotencySuffix}:${userId}`, skipEmail: true });
        if (mail && mailOn) {
          await deps.mailer.enqueue({ template: mail.template, to: { userId }, vars: mail.vars, idempotencyKey: `${mail.idempotencyKey}:${userId}` });
        }
      }
    } catch (error) {
      deps.logger.warn("order notification failed", { orderPublicId: order.publicId, kind, errorName: error instanceof Error ? error.name : "unknown" });
    }
  }

  /**
   * Increment 05 (C3): an order with a code that is cancelled BEFORE payment releases its redemption (promotions
   * restores the counters; idempotent). Paid or refunded orders keep it used. When the payment state is not
   * definitively unpaid/void the redemption is kept (fail closed); a release failure aborts the cancellation's transaction.
   */
  async function releasePromotionOnCancel(tx: Tx, orderId: number) {
    const [row] = await tx.select({ publicId: orders.publicId, promoLabel: orders.promoLabel, promoDiscountMinor: orders.promoDiscountMinor }).from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!row || (row.promoLabel === null && row.promoDiscountMinor === 0)) return;
    const port = promotionsPort(deps.services);
    if (!port) return;
    // Fail closed (/root G-C3-02): release only on compliance's authoritative exposure read in THIS transaction:
    // nothing ever paid (partial payments count), no open payable invoice, no pending provider capture, and no
    // provider payment attempt ever created (any status). Port absent, error (incl. compliance's NOWAIT lock
    // contention) or any exposure ⇒ the redemption stays used; the cancellation itself still succeeds.
    const exposure = paymentExposurePort(deps.services);
    if (!exposure) return;
    try {
      if (!releaseIsSafe(await exposure(tx, row.publicId))) return;
    } catch {
      deps.logger.warn("order payment exposure unavailable; promotion kept", { orderPublicId: row.publicId });
      return;
    }
    await port.releaseForOrderInTx(tx, { orderPublicId: row.publicId, reason: "order_cancelled" });
  }

  /** Increment 05 (C3): the promotion context for priced lines; eligibility is judged for the order OWNER. */
  function promotionContext(
    code: string,
    owner: number,
    actor: number,
    currency: string,
    lineItems: readonly { productPublicId: string; packetNumber: number | null; tier: PacketTier | null; lineTotalMinor: number }[],
    pricing: OrderPricing,
  ): PromotionContext {
    return {
      code,
      customerUserId: owner,
      actorUserId: actor,
      currency,
      lines: lineItems.map((line) => ({ productPublicId: line.productPublicId, packetNumber: line.packetNumber, tierKey: line.tier ? line.tier.toLowerCase() : null, lineTotalMinor: line.lineTotalMinor })),
      subtotalMinor: pricing.subtotalMinor,
      bundleDiscountMinor: pricing.discountMinor,
      bundleLabel: pricing.discountLabel,
    };
  }

  /** Final figures after a promotion outcome; refuses anything inconsistent (fail closed, never a negative total). */
  function applyOutcome(pricing: OrderPricing, outcome: PromotionOutcome) {
    const ok =
      [outcome.discountMinor, outcome.promoDiscountMinor, outcome.bundleDiscountMinor, outcome.totalMinor].every((n) => Number.isSafeInteger(n) && n >= 0) &&
      outcome.discountMinor <= pricing.subtotalMinor &&
      outcome.promoDiscountMinor <= outcome.discountMinor &&
      outcome.totalMinor === pricing.subtotalMinor - outcome.discountMinor &&
      outcome.label.trim().length > 0;
    if (!ok) throw new DomainError("UNAVAILABLE", "PROMOTIONS_UNAVAILABLE", "This action is temporarily unavailable. Please try again later.");
    return {
      ...pricing,
      discountMinor: outcome.discountMinor,
      // A code that contributes nothing (bundle won, or the cap left 0) leaves no promo figures or label behind;
      // promotions likewise writes no redemption for it.
      discountLabel: outcome.discountMinor > 0 ? outcome.discountLabel.slice(0, 120) : null,
      totalMinor: outcome.totalMinor,
      ...(outcome.promoDiscountMinor > 0 ? { promo: { publicId: outcome.promoPublicId, label: outcome.label.slice(0, 120), promoDiscountMinor: outcome.promoDiscountMinor } } : {}),
    };
  }

  /** Creates the order rows inside `tx` (actor already re-validated by the caller). */
  async function createInTx(
    tx: Tx,
    principal: SessionPrincipal | null,
    input: { projectName: string; items: { productPublicId: string; quantity: number }[]; note?: string; idempotencyKey: string; promoCode?: string; addToOrderPublicId?: string },
    ownerUserId: number,
    prefix: string,
    system?: { correlationId: string; channel: string },
  ) {
    const now = deps.clock.now();
    const workflow = await workflows.ensureDefault(tx);
    const lineItems = await deps.catalog.resolveForOrder(tx, input.items);
    const currency = lineItems[0]!.currency;
    // Increment 08 (D3): an addition is checked under the group root's row lock before anything is redeemed or written.
    const groupRoot = input.addToOrderPublicId
      ? await assertAddOnAllowed(tx, workflows, { orderPublicId: input.addToOrderPublicId, ownerUserId, currency, packetNumbers: lineItems.map((item) => item.packetNumber) })
      : null;
    const projectName = groupRoot ? groupRoot.projectName : input.projectName;
    const basePricing = priceOrder(lineItems, await deps.catalog.getBundleRule(tx));
    const publicId = ulid(now.getTime());
    // Increment 05 (C3): redeem inside this transaction BEFORE the order row; any refusal rolls everything back.
    let pricing: OrderPricing & { promo?: { publicId: string; label: string; promoDiscountMinor: number } } = basePricing;
    if (input.promoCode !== undefined) {
      // Codes are for portal orders only (API v1 does not accept codes in this increment), and need a person.
      if (system || !principal) throw promoNotApplicable();
      const port = await requirePromotions(deps.services, tx);
      const outcome = await port.redeemInTx(tx, {
        ...promotionContext(input.promoCode, ownerUserId, principal.userId, currency, lineItems, basePricing),
        orderPublicId: publicId,
        correlationId: getRequestContext()?.correlationId ?? getRequestContext()?.requestId ?? publicId,
      });
      pricing = applyOutcome(basePricing, outcome);
    }
    const totalMinor = pricing.totalMinor;
    // Increment 08 (D2): `PREFIX-C4-F3L3-P6-NNN`; an addition reuses the root's frozen stem when it has one.
    const referenceStem = groupRoot?.referenceStem ?? (await stemFor(tx, prefix, ownerUserId, projectName));
    const reference = await allocateStemReference(tx, referenceStem);
    const initial = initialState(workflow.definition);
    await tx.insert(orders).values({
      publicId,
      reference,
      referenceStem,
      groupRootOrderId: groupRoot?.id ?? null,
      ownerUserId,
      projectName,
      workflowVersionId: workflow.versionId,
      statusKey: initial.key,
      subtotalMinor: pricing.subtotalMinor,
      discountMinor: pricing.discountMinor,
      discountLabel: pricing.discountLabel,
      promoDiscountMinor: pricing.promo?.promoDiscountMinor ?? 0,
      promoLabel: pricing.promo?.label ?? null,
      totalMinor,
      currency,
      origin: "portal",
      createdByUserId: principal?.userId ?? null,
      createKey: input.idempotencyKey,
      submittedAt: now,
      // Increment 07 (D9): a new order with something to pay starts unpaid; existing orders are never re-gated.
      paymentState: totalMinor > 0 ? "unpaid" : "not_required",
      createdAt: now,
      updatedAt: now,
    });
    const [order] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.publicId, publicId));
    const orderId = order!.id;
    await tx.insert(orderLineItems).values(
      lineItems.map((item, index) => ({
        publicId: ulid(now.getTime()),
        orderId,
        productId: item.productId,
        productVersionId: item.productVersionId,
        productPublicId: item.productPublicId,
        productVersionNumber: item.productVersionNumber,
        name: item.name,
        description: item.description,
        features: item.features,
        packetNumber: item.packetNumber,
        tier: item.tier,
        outcome: item.outcome,
        timeline: item.timeline,
        deliverables: item.deliverables,
        unitPriceMinor: item.unitPriceMinor,
        currency: item.currency,
        quantity: item.quantity,
        lineTotalMinor: item.lineTotalMinor,
        sortOrder: index,
        createdAt: now,
      })),
    );
    await reserveReference(tx, { reference, orderId, reasonCode: "GENERATED", actorUserId: principal?.userId ?? null, now });
    const note = input.note ? await insertNote(tx, { orderId, principal, visibility: "customer", body: input.note }) : null;
    await tx.insert(orderStatusHistory).values({
      publicId: ulid(now.getTime()),
      orderId,
      fromStatus: null,
      toStatus: initial.key,
      actorUserId: principal?.userId ?? null,
      actorRole: principal?.role ?? "system",
      reasonCode: "CREATED",
      noteId: note?.id ?? null,
      occurredAt: now,
    });
    await deps.stageRuntime?.afterStatusChangeInTx(tx, { orderId, bound: workflow, fromStatus: null, toStatus: initial.key });
    const inherited = await deps.access.onOrderCreated(tx, { orderId, ownerUserId, now });
    await deps.audit.record(
      {
        category: "business",
        eventName: "order.created",
        action: "create",
        outcome: "completed",
        actor: principal ? actorOf(principal) : { role: "system" },
        ...(system ? { correlationId: system.correlationId } : {}),
        resource: { type: "order", publicId },
        attributes: {
          currency,
          total_minor: totalMinor,
          discount_minor: pricing.discountMinor,
          ...(pricing.promo ? { promo_public_id: pricing.promo.publicId, promo_discount_minor: pricing.promo.promoDiscountMinor } : {}),
          on_behalf: ownerUserId !== principal?.userId,
          ...(system ? { channel: system.channel } : {}),
          workflow_version: workflow.versionNumber,
          inherited_grants: inherited,
          ...(groupRoot ? { group_root_public_id: groupRoot.publicId } : {}),
        },
        safeCounts: { line_items: lineItems.length, packet_items: lineItems.filter((item) => item.packetNumber !== null).length },
      },
      tx,
    );
    await emitChange(tx, { orderId, orderPublicId: publicId, kind: "created" });
    return { orderId, publicId, reference, currency, pricing, lineItems };
  }

  /**
   * Increment 08 (D3): `group` (owner-scoped: owner and staff see every order of the project; a shared-access viewer
   * sees only this order) and `canAddPackets` (the owning customer, root not cancelled).
   */
  async function groupReadModel(
    tx: DbOrTx,
    principal: SessionPrincipal,
    accessRole: OrderAccessRole,
    order: typeof orders.$inferSelect,
    consoleView: boolean,
  ): Promise<{
    group: { rootPublicId: string; orders: { publicId: string; reference: string; createdAt: Date; statusLabel: string; packetNumbers: number[]; current: boolean }[] };
    canAddPackets: boolean;
  }> {
    const rootId = order.groupRootOrderId ?? order.id;
    const seesGroup = accessRole === "owner" || accessRole === "staff" || accessRole === "admin";
    const members = seesGroup
      ? await groupMembers(tx, { id: rootId, ownerUserId: order.ownerUserId })
      : [{ id: order.id, publicId: order.publicId, reference: order.reference, createdAt: order.createdAt, statusKey: order.statusKey, workflowVersionId: order.workflowVersionId, groupRootOrderId: order.groupRootOrderId }];
    const root = members.find((m) => m.id === rootId) ?? null;
    const packets = await packetNumbersByOrder(tx, members.map((m) => m.id));
    const bounds = new Map<number, BoundWorkflow>();
    const boundOf = async (versionId: number) => {
      let bound = bounds.get(versionId);
      if (!bound) {
        bound = await workflows.byVersionId(tx, versionId);
        bounds.set(versionId, bound);
      }
      return bound;
    };
    const items = [];
    for (const member of members) {
      const state = findState((await boundOf(member.workflowVersionId)).definition, member.statusKey);
      items.push({
        publicId: member.publicId,
        reference: member.reference,
        createdAt: member.createdAt,
        statusLabel: state ? (consoleView ? state.label : state.customerLabel) : member.statusKey,
        packetNumbers: packets.get(member.id) ?? [],
        current: member.id === order.id,
      });
    }
    const canAddPackets =
      accessRole === "owner" &&
      principal.role === "customer" &&
      root !== null &&
      !(await isGroupOrderCancelled(tx, workflows, root));
    return { group: { rootPublicId: root?.publicId ?? order.publicId, orders: items }, canAddPackets };
  }

  /** Increment 08 (D2): the stem from identity's name parts (never logged) and the project name. */
  async function stemFor(tx: DbOrTx, prefix: string, ownerUserId: number, projectName: string): Promise<string> {
    const parts = await namePartsInTx(deps.services, tx, ownerUserId);
    return buildReferenceStem({ prefix, customerRef: parts.customerRef, firstName: parts.firstName, lastName: parts.lastName, projectName });
  }

  async function ownerUser(publicId: string, tx?: DbOrTx) {
    const user = await identityPort(deps.services).getUserByPublicId(publicId, { tx });
    if (!user || user.role !== "customer" || user.status !== "active") return null;
    return user;
  }

  async function toListItems(
    rows: (typeof orders.$inferSelect)[],
    principal: SessionPrincipal,
    withOwner: boolean,
  ): Promise<OrderListItem[]> {
    const ownerViews = new Map<number, { publicId: string; name: string }>();
    if (withOwner) {
      const identity = identityPort(deps.services);
      for (const ownerId of new Set(rows.map((r) => r.ownerUserId))) {
        const user = await identity.getUser(ownerId);
        if (user) ownerViews.set(ownerId, { publicId: user.publicId, name: user.name });
      }
    }
    const items: OrderListItem[] = [];
    // Increment 07 (D3): old orders get their progress cache filled on first read.
    const unfilled = rows.filter((row) => row.progressPercent === null).map((row) => row.id);
    const filled = unfilled.length && deps.stageRuntime ? await deps.stageRuntime.fillForRead(unfilled) : new Map<number, number>();
    // Increment 08 (D3): additions name their project's first order (owner and staff only; a shared viewer sees none).
    const rootIds = [...new Set(rows.map((row) => row.groupRootOrderId).filter((id): id is number => id !== null))];
    const roots = new Map(
      rootIds.length
        ? (await deps.db.select({ id: orders.id, publicId: orders.publicId, reference: orders.reference, ownerUserId: orders.ownerUserId }).from(orders).where(inArray(orders.id, rootIds))).map(
            (root) => [root.id, root] as const,
          )
        : [],
    );
    for (const row of rows) {
      const status = await statusPresentation(row.workflowVersionId, row.statusKey);
      const staffSide = principal.role !== "customer";
      const root = row.groupRootOrderId !== null ? roots.get(row.groupRootOrderId) : undefined;
      const showsGroup = root !== undefined && root.ownerUserId === row.ownerUserId && (staffSide || row.ownerUserId === principal.userId);
      const model = stageModelOf((await workflows.byVersionId(deps.db, row.workflowVersionId)).definition);
      const phaseIndex = stageIndexOfStatus(model, row.statusKey);
      const phase = phaseIndex >= 0 ? model.stages[phaseIndex]! : null;
      items.push({
        publicId: row.publicId,
        reference: row.reference,
        projectName: row.projectName,
        statusKey: row.statusKey,
        statusLabel: staffSide ? status.label : status.customerLabel,
        statusTone: status.tone,
        lockState: row.lockState,
        totalMinor: row.totalMinor,
        currency: row.currency,
        accessRole: staffSide ? (principal.role as OrderAccessRole) : row.ownerUserId === principal.userId ? "owner" : "viewer",
        ...(withOwner ? { ownerPublicId: ownerViews.get(row.ownerUserId)?.publicId, ownerName: ownerViews.get(row.ownerUserId)?.name } : {}),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        progressPercent: row.progressPercent ?? filled.get(row.id) ?? 0,
        progressCanceled: row.statusKey.includes("cancel"),
        phaseLabel: phase ? (staffSide ? phase.staffLabel : phase.customerLabel) : null,
        phaseIndex: phase ? phaseIndex : null,
        phaseTotal: model.stages.length,
        paymentState: row.paymentState,
        attention: row.attention,
        group: showsGroup ? { rootPublicId: root.publicId, rootReference: root.reference } : null,
      });
    }
    return items;
  }

  async function grantRolesFor(principal: SessionPrincipal, orderIds: number[]) {
    if (orderIds.length === 0) return new Map<number, OrderAccessRole>();
    const rows = await deps.db
      .select({ orderId: orderGrants.orderId, role: orderGrants.role })
      .from(orderGrants)
      .where(and(eq(orderGrants.granteeUserId, principal.userId), eq(orderGrants.status, "active"), inArray(orderGrants.orderId, orderIds)));
    return new Map(rows.map((r) => [r.orderId, r.role as OrderAccessRole]));
  }

  const service = {
    /* ---------------------------------------------------------------- create */
    async create(
      principal: SessionPrincipal,
      input: {
        projectName: string;
        items: { productPublicId: string; quantity: number }[];
        note?: string;
        idempotencyKey: string;
        onBehalfOfCustomerPublicId?: string;
        promoCode?: string;
        /** Increment 08 (D3): add to this order's project (any group member's public id). */
        addToOrderPublicId?: string;
      },
    ): Promise<{ publicId: string; reference: string; created: boolean }> {
      if (principal.state !== "full") throw ORDER_NOT_FOUND();
      if (!roleHasCapability(principal.role, "orders.create")) throw forbidden("CAPABILITY_NOT_GRANTED");
      let ownerUserId = principal.userId;
      if (input.onBehalfOfCustomerPublicId) {
        if (!roleHasCapability(principal.role, "orders.manage")) throw forbidden("CAPABILITY_NOT_GRANTED");
        const owner = await ownerUser(input.onBehalfOfCustomerPublicId);
        if (!owner) throw validation("CUSTOMER_NOT_ELIGIBLE", "Choose an active customer account.");
        ownerUserId = owner.id;
      }
      if (principal.role === "customer") await compliancePort(deps.services)?.assertRequiredPoliciesAccepted(ownerUserId, { audience: "customer" });
      const [existing] = await deps.db
        .select({ publicId: orders.publicId, reference: orders.reference })
        .from(orders)
        .where(and(eq(orders.ownerUserId, ownerUserId), eq(orders.createKey, input.idempotencyKey)))
        .limit(1);
      if (existing) return { ...existing, created: false };

      const prefix = await readSetting(deps.settings, ORDER_REFERENCE_PREFIX);
      try {
        // C1: with a code, the promotions attempt guard wraps the whole tx (refusals are recorded after rollback).
        return await withPromoAttemptGuard(deps.services, input.promoCode, principal.userId, () =>
          deps.db.transaction(async (tx) => {
            // Increment 08 (D3): an addition locks the group root FIRST — the same order as every existing-order write
            // (order row → actor users row, actor.ts) — so an add-on and a concurrent root mutation cannot deadlock.
            // Lock only; ownership and eligibility are decided after the actor check, inside createInTx.
            if (input.addToOrderPublicId) await prelockGroupRoot(tx, input.addToOrderPublicId);
            // Otherwise no existing order row is locked here, so the actor check is the first statement.
            const actor = await assertActorCurrent(principal, tx, "orders.create");
            if (input.onBehalfOfCustomerPublicId && !roleHasCapability(actor.role, "orders.manage")) throw forbidden("ACTOR_NOT_AUTHORIZED");
            if (input.onBehalfOfCustomerPublicId) {
              // Re-validate the target customer inside the transaction (the pre-check above ran outside it).
              const owner = await ownerUser(input.onBehalfOfCustomerPublicId, tx);
              if (!owner || owner.id !== ownerUserId) throw validation("CUSTOMER_NOT_ELIGIBLE", "Choose an active customer account.");
            }
            // D14: a customer placing an order accepts the order agreement first (staff creating for a customer are
            // not gated; that customer is checked when they work on the order).
            await deps.gates.assertCustomerMayPlaceOrder({ tx, actor: principal });
            const result = await createInTx(tx, principal, input, ownerUserId, prefix);
            return { publicId: result.publicId, reference: result.reference, created: true as const };
          }),
        );
      } catch (error) {
        // A concurrent duplicate submit with the same idempotency key resolves to the first order.
        if (isDuplicateKey(error)) {
          const [again] = await deps.db
            .select({ publicId: orders.publicId, reference: orders.reference })
            .from(orders)
            .where(and(eq(orders.ownerUserId, ownerUserId), eq(orders.createKey, input.idempotencyKey)))
            .limit(1);
          if (again) return { ...again, created: false };
        }
        throw error;
      }
    },

    /**
     * Increment 04 (cart checkout, Decision 13): customer order creation inside the CALLER's transaction. Same
     * validation, pricing, bundle rule and audit as `create`; the caller must not open another connection.
     */
    async createOrderFromCheckoutInTx(
      principal: SessionPrincipal,
      input: { projectName: string; items: { productPublicId: string; quantity: number }[]; note?: string; idempotencyKey: string; promoCode?: string; addToOrderPublicId?: string | null },
      tx: Tx,
    ) {
      if (principal.state !== "full" || principal.pendingSteps.length > 0) throw ORDER_NOT_FOUND();
      if (principal.role !== "customer" || !roleHasCapability(principal.role, "orders.create")) throw forbidden("CAPABILITY_NOT_GRANTED");
      await assertActorCurrent(principal, tx, "orders.create");
      await compliancePort(deps.services)?.assertRequiredPoliciesAccepted(principal.userId, { audience: "customer", tx });
      await deps.gates.assertCustomerMayPlaceOrder({ tx, actor: principal });
      const [existing] = await tx
        .select({ id: orders.id, publicId: orders.publicId, reference: orders.reference, currency: orders.currency, subtotalMinor: orders.subtotalMinor, discountMinor: orders.discountMinor, discountLabel: orders.discountLabel, promoDiscountMinor: orders.promoDiscountMinor, promoLabel: orders.promoLabel, totalMinor: orders.totalMinor })
        .from(orders)
        .where(and(eq(orders.ownerUserId, principal.userId), eq(orders.createKey, input.idempotencyKey)))
        .limit(1);
      const afterCommit = async () => undefined;
      if (existing) {
        const lines = await tx.select().from(orderLineItems).where(eq(orderLineItems.orderId, existing.id)).orderBy(asc(orderLineItems.sortOrder));
        return {
          ...existing,
          created: false,
          lineItems: lines.map((line) => ({ productPublicId: line.productPublicId, name: line.name, quantity: line.quantity, unitPriceMinor: line.unitPriceMinor, lineTotalMinor: line.lineTotalMinor, currency: line.currency })),
          afterCommit,
        };
      }
      const prefix = await readSetting(deps.settings, ORDER_REFERENCE_PREFIX, tx);
      const { addToOrderPublicId, ...rest } = input;
      const result = await createInTx(tx, principal, { ...rest, ...(addToOrderPublicId ? { addToOrderPublicId } : {}) }, principal.userId, prefix);
      return {
        id: result.orderId,
        publicId: result.publicId,
        reference: result.reference,
        created: true,
        currency: result.currency,
        subtotalMinor: result.pricing.subtotalMinor,
        discountMinor: result.pricing.discountMinor,
        discountLabel: result.pricing.discountLabel,
        promoDiscountMinor: result.pricing.promo?.promoDiscountMinor ?? 0,
        promoLabel: result.pricing.promo?.label ?? null,
        totalMinor: result.pricing.totalMinor,
        lineItems: result.lineItems.map((line) => ({ productPublicId: line.productPublicId, name: line.name, quantity: line.quantity, unitPriceMinor: line.unitPriceMinor, lineTotalMinor: line.lineTotalMinor, currency: line.currency })),
        afterCommit,
      };
    },

    /**
     * Increment 08 (D3) read port, trusted (cart / checkout summary / new-order page): may `ownerUserId` add packets to
     * the project of `orderPublicId`? Null when not (missing, foreign or cancelled root). No lock, no audit.
     */
    async addOnTargetInTx(tx: DbOrTx, ownerUserId: number, orderPublicId: string) {
      return addOnTarget(tx, workflows, ownerUserId, orderPublicId);
    },

    /**
     * Increment 08 (D3) lock-order port for checkout: call FIRST in the checkout transaction, before the actor check,
     * when the cart has an add-on target. Locks the group root row (FOR UPDATE); null when the order is missing or not
     * this owner's (eligibility is re-checked under the same lock by createOrderFromCheckoutInTx). No audit.
     */
    async lockAddOnRootInTx(tx: Tx, ownerUserId: number, orderPublicId: string): Promise<{ rootPublicId: string } | null> {
      const root = await lockGroupRoot(tx, orderPublicId, ownerUserId);
      return root ? { rootPublicId: root.publicId } : null;
    },

    /** Increment 08 (D3): `orders.addOnTarget` for the signed-in customer (NewOrderPage `?addTo=`). */
    async addOnTarget(principal: SessionPrincipal, input: { orderId: string }) {
      if (principal.state !== "full" || principal.pendingSteps.length > 0) throw ORDER_NOT_FOUND();
      if (principal.role !== "customer") return null;
      return snapshot((tx) => addOnTarget(tx, workflows, principal.userId, input.orderId));
    },

    /* ------------------------------------------------------------------ list */
    async list(
      principal: SessionPrincipal,
      input: { cursor?: string; limit?: number; status?: string },
    ): Promise<{ items: OrderListItem[]; nextCursor: string | null }> {
      if (principal.state !== "full" || principal.pendingSteps.length > 0) throw ORDER_NOT_FOUND();
      const limit = Math.min(Math.max(input.limit ?? 25, 1), MAX_PAGE);
      const before = decodeCursor(input.cursor);
      const now = deps.clock.now();
      const sharedIds = deps.db
        .select({ id: orderGrants.orderId })
        .from(orderGrants)
        .where(
          and(
            eq(orderGrants.granteeUserId, principal.userId),
            eq(orderGrants.status, "active"),
            or(sql`${orderGrants.expiresAt} IS NULL`, sql`${orderGrants.expiresAt} > ${now}`),
          ),
        );
      // The customer list is ALWAYS scoped to the caller, regardless of role (staff use admin.list).
      const rows = await deps.db
        .select()
        .from(orders)
        .where(
          and(
            or(eq(orders.ownerUserId, principal.userId), inArray(orders.id, sharedIds)),
            before !== null ? lt(orders.id, before) : undefined,
            input.status ? eq(orders.statusKey, input.status) : undefined,
          ),
        )
        .orderBy(desc(orders.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const items = await toListItems(page, { ...principal, role: "customer" }, false);
      const roles = await grantRolesFor(principal, page.filter((r) => r.ownerUserId !== principal.userId).map((r) => r.id));
      for (const [index, row] of page.entries()) {
        if (row.ownerUserId !== principal.userId) items[index]!.accessRole = roles.get(row.id) ?? "viewer";
      }
      return { items, nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!.id) : null };
    },

    async adminList(
      principal: SessionPrincipal,
      input: {
        cursor?: string;
        limit?: number;
        status?: string;
        customerPublicId?: string;
        from?: Date;
        to?: Date;
        referencePrefix?: string;
        lockState?: OrderLockState;
        /** Increment 07 (D2): attention filter. */
        attention?: "staff_review" | "customer_response";
      },
    ): Promise<{ items: OrderListItem[]; nextCursor: string | null }> {
      if (principal.role === "customer" || !roleHasCapability(principal.role, "orders.read_all")) throw forbidden("CAPABILITY_NOT_GRANTED");
      const limit = Math.min(Math.max(input.limit ?? 25, 1), MAX_PAGE);
      const before = decodeCursor(input.cursor);
      let ownerId: number | undefined;
      if (input.customerPublicId) {
        const user = await identityPort(deps.services).getUserByPublicId(input.customerPublicId);
        if (!user) return { items: [], nextCursor: null };
        ownerId = user.id;
      }
      const rows = await deps.db
        .select()
        .from(orders)
        .where(
          and(
            before !== null ? lt(orders.id, before) : undefined,
            input.status ? eq(orders.statusKey, input.status) : undefined,
            input.lockState ? eq(orders.lockState, input.lockState) : undefined,
            input.attention ? eq(orders.attention, input.attention) : undefined,
            ownerId !== undefined ? eq(orders.ownerUserId, ownerId) : undefined,
            input.from ? gte(orders.createdAt, input.from) : undefined,
            input.to ? lte(orders.createdAt, input.to) : undefined,
            input.referencePrefix ? like(orders.reference, `${likeLiteral(input.referencePrefix.toUpperCase())}%`) : undefined,
          ),
        )
        .orderBy(desc(orders.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      return {
        items: await toListItems(page, principal, true),
        nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!.id) : null,
      };
    },

    /* ------------------------------------------------------------------- get */
    async get(principal: SessionPrincipal, orderPublicId: string, area: "customer" | "console" = "customer") {
      return snapshot(async (tx) => {
      const view = await policy.assertCanReadOrder(principal, orderPublicId, { tx });
      const staffSide = view.accessRole === "staff" || view.accessRole === "admin";
      const consoleView = staffSide && area === "console";
      const [order] = await tx.select().from(orders).where(eq(orders.id, view.id)).limit(1);
      if (!order) throw ORDER_NOT_FOUND();
      const bound = await workflows.byVersionId(tx, order.workflowVersionId);
      const items = await tx.select().from(orderLineItems).where(eq(orderLineItems.orderId, view.id)).orderBy(asc(orderLineItems.sortOrder)).limit(500);
      const notes = await tx
        .select()
        .from(orderNotes)
        .where(and(eq(orderNotes.orderId, view.id), consoleView ? undefined : eq(orderNotes.visibility, "customer")))
        .orderBy(desc(orderNotes.id))
        .limit(200);
      const history = await tx.select().from(orderStatusHistory).where(eq(orderStatusHistory.orderId, view.id)).orderBy(desc(orderStatusHistory.id)).limit(200);
      const actor = workflowActor(view);
      const canTransition = actor !== null && policy.writeVerdict(principal, view.accessRole, view.lockState, "status") === null;
      const allTransitions = canTransition && actor ? transitionsFrom(bound.definition, order.statusKey, actor) : [];
      // Lead ruling (QA e8fe1ec): while a submit-and-lock phase is open the customer finishes it with Submit and lock
      // in the phase panel, so the header offers only cancel (the server refuses the rest: STAGE_SUBMIT_REQUIRED).
      const lockPending = actor === "customer" && allTransitions.length > 0 && (await submitLockPending(tx, view.id, view.workflowVersionId, bound, order.statusKey));
      const transitions = lockPending ? allTransitions.filter((t) => isCancelTarget(bound, t.to)) : allTransitions;
      const label = (key: string | null) => {
        if (!key) return null;
        const state = findState(bound.definition, key);
        return state ? (consoleView ? state.label : state.customerLabel) : key;
      };
      const state = findState(bound.definition, order.statusKey);
      const visibleNoteIds = new Set(notes.map((n) => n.id));
      return {
        publicId: order.publicId,
        reference: order.reference,
        projectName: order.projectName,
        statusKey: order.statusKey,
        statusLabel: label(order.statusKey)!,
        statusTone: state?.tone ?? "neutral",
        statusKind: state?.kind ?? "active",
        lockState: order.lockState,
        origin: order.origin,
        subtotalMinor: order.subtotalMinor,
        discountMinor: order.discountMinor,
        discountLabel: order.discountLabel,
        promoDiscountMinor: order.promoDiscountMinor,
        promoLabel: order.promoLabel,
        totalMinor: order.totalMinor,
        currency: order.currency,
        version: order.version,
        accessRole: view.accessRole,
        canWrite: view.canWrite,
        canShare: policy.writeVerdict(principal, view.accessRole, view.lockState, "sharing") === null || (staffSide && roleHasCapability(principal.role, "orders.manage")),
        ownerPublicId: view.ownerPublicId,
        submittedAt: order.submittedAt,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        lineItems: items.map((item) => ({
          publicId: item.publicId,
          productPublicId: item.productPublicId,
          productVersion: item.productVersionNumber,
          name: item.name,
          description: item.description,
          features: item.features,
          packetNumber: item.packetNumber,
          tier: item.tier,
          outcome: item.outcome,
          timeline: item.timeline,
          deliverables: item.deliverables ?? [],
          unitPriceMinor: item.unitPriceMinor,
          currency: item.currency,
          quantity: item.quantity,
          lineTotalMinor: item.lineTotalMinor,
        })),
        notes: notes.map((note) => ({
          publicId: note.publicId,
          visibility: note.visibility,
          authorRole: note.authorRole,
          mine: note.authorUserId === principal.userId,
          body: decryptNote(note.bodyEnc, note.publicId),
          createdAt: note.createdAt,
        })),
        history: history.map((entry) => ({
          publicId: entry.publicId,
          fromLabel: label(entry.fromStatus),
          toLabel: label(entry.toStatus)!,
          toStatus: entry.toStatus,
          actorRole: consoleView ? entry.actorRole : entry.actorRole === "customer" ? "customer" : "readypackets",
          reasonCode: entry.reasonCode,
          hasNote: entry.noteId !== null && visibleNoteIds.has(entry.noteId),
          occurredAt: entry.occurredAt,
        })),
        transitions: transitions.map((t) => {
          const target = findState(bound.definition, t.to);
          const targetLabel = label(t.to)!;
          return {
            to: t.to,
            label: targetLabel,
            actionLabel: transitionActionLabel(t, target, targetLabel),
            destructive: target ? isCancelState(target) : false,
            /** Increment 08 (D6 wizard): "cancel" = moves to a cancel state; anything else moves the order forward. */
            kind: (target && isCancelState(target) ? "cancel" : "forward") as "forward" | "cancel",
            requiresNote: t.requiresNote,
          };
        }),
        ...(await groupReadModel(tx, principal, view.accessRole, order, consoleView)),
        /** Part B (B1): console header only — customer name and payment badge (null when unknown or hidden). */
        console: consoleView ? await consoleHeader(tx, order.publicId, order.ownerUserId) : null,
      };
      });
    },

    async getOrderSummary(principal: SessionPrincipal, orderPublicId: string): Promise<OrderSummary> {
      return snapshot(async (tx) => {
      const view = await policy.assertCanReadOrder(principal, orderPublicId, { tx });
      const [order] = await tx.select().from(orders).where(eq(orders.id, view.id)).limit(1);
      if (!order) throw ORDER_NOT_FOUND();
      const status = await statusPresentation(order.workflowVersionId, order.statusKey, tx);
      const staffSide = view.accessRole === "staff" || view.accessRole === "admin";
      return {
        publicId: order.publicId,
        reference: order.reference,
        projectName: order.projectName,
        statusKey: order.statusKey,
        statusLabel: staffSide ? status.label : status.customerLabel,
        statusTone: status.tone,
        lockState: order.lockState,
        totalMinor: order.totalMinor,
        currency: order.currency,
        accessRole: view.accessRole,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
      };
      });
    },

    /* ---------------------------------------------------------------- update */
    async update(principal: SessionPrincipal, input: { orderId: string; expectedVersion: number; projectName: string }) {
      return deps.db.transaction(async (tx) => {
        const view = await policy.assertCanWriteOrder(principal, input.orderId, { kind: "order", tx, forUpdate: true });
        await assertActorCurrent(principal, tx, view.accessRole === "staff" || view.accessRole === "admin" ? "orders.manage" : undefined);
        if (view.version !== input.expectedVersion) throw staleVersion();
        await tx
          .update(orders)
          .set({ projectName: input.projectName, version: view.version + 1, updatedAt: deps.clock.now() })
          .where(and(eq(orders.id, view.id), eq(orders.version, view.version)));
        await deps.audit.record(
          {
            category: "business",
            eventName: "order.updated",
            action: "update",
            outcome: "completed",
            actor: actorOf(principal),
            resource: { type: "order", publicId: view.publicId },
            attributes: { field: "projectName" },
          },
          tx,
        );
        await emitChange(tx, { orderId: view.id, orderPublicId: view.publicId, kind: "updated" });
        return { version: view.version + 1 };
      });
    },

    /**
     * Part B (B2): console rename. Capability orders.rename (router + in-tx re-check), optimistic version,
     * reference untouched, audit `order.renamed` (renamed flag + old/new length; names are not copied into audit), change event for the SharePoint row.
     */
    async rename(principal: SessionPrincipal, input: { orderId: string; expectedVersion: number; name: string }) {
      const name = normalizeOrderName(input.name);
      return deps.db.transaction(async (tx) => {
        const view = await policy.assertCanWriteOrder(principal, input.orderId, { kind: "order", tx, forUpdate: true });
        if (view.accessRole !== "staff" && view.accessRole !== "admin") throw forbidden("STAFF_ONLY");
        await assertActorCurrent(principal, tx, "orders.rename");
        if (view.version !== input.expectedVersion) throw staleVersion();
        const [row] = await tx.select({ projectName: orders.projectName }).from(orders).where(eq(orders.id, view.id)).limit(1);
        const oldName = row?.projectName ?? "";
        if (oldName === name) return { version: view.version, changed: false };
        const result = await tx
          .update(orders)
          .set({ projectName: name, version: view.version + 1, updatedAt: deps.clock.now() })
          .where(and(eq(orders.id, view.id), eq(orders.version, view.version)));
        if (affectedRows(result) !== 1) throw staleVersion();
        await tx.insert(orderNameHistory).values({
          orderId: view.id,
          oldName,
          newName: name,
          actorUserId: principal.userId,
          actorRole: principal.role,
          createdAt: deps.clock.now(),
        });
        await deps.audit.record(
          {
            category: "business",
            eventName: "order.renamed",
            action: "update",
            outcome: "completed",
            actor: actorOf(principal),
            resource: { type: "order", publicId: view.publicId },
            // The audit envelope drops `*name*` keys as personal data, so the event records that the
            // name changed and the lengths only; the current name lives on the order row (data minimising).
            attributes: { order_public_id: view.publicId, renamed: true, old_length: oldName.length, new_length: name.length },
          },
          tx,
        );
        await emitChange(tx, { orderId: view.id, orderPublicId: view.publicId, kind: "updated" });
        return { version: view.version + 1, changed: true };
      });
    },

    /**
     * Part B (S2 port, trusted — caller ran assertCanReadOrder): status transitions newest first, keyset on
     * order_status_history.id. `customerView` hides internal notes (note → null) and uses customer labels.
     */
    async listStatusTransitions(orderId: number, opts: { cursor?: string | null; limit: number; customerView: boolean; tx?: DbOrTx }) {
      const db = opts.tx ?? deps.db;
      const limit = Math.min(Math.max(Math.trunc(opts.limit) || 1, 1), MAX_PAGE);
      const before = decodeCursor(opts.cursor);
      const [order] = await db.select({ workflowVersionId: orders.workflowVersionId }).from(orders).where(eq(orders.id, orderId)).limit(1);
      if (!order) return { items: [], nextCursor: null };
      const rows = await db
        .select()
        .from(orderStatusHistory)
        .where(before === null ? eq(orderStatusHistory.orderId, orderId) : and(eq(orderStatusHistory.orderId, orderId), lt(orderStatusHistory.id, before)))
        .orderBy(desc(orderStatusHistory.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const noteIds = page.map((entry) => entry.noteId).filter((id): id is number => id !== null);
      const notes = noteIds.length ? await db.select().from(orderNotes).where(and(eq(orderNotes.orderId, orderId), inArray(orderNotes.id, noteIds))) : [];
      const noteById = new Map(notes.map((note) => [note.id, note]));
      const bound = await workflows.byVersionId(db, order.workflowVersionId);
      const label = (key: string | null) => {
        if (key === null) return null;
        const state = findState(bound.definition, key);
        return (opts.customerView ? state?.customerLabel : state?.label) ?? key;
      };
      const roleOf = (role: string): "customer" | "staff" | "admin" | "system" => (role === "admin" || role === "staff" || role === "system" ? role : "customer");
      return {
        items: page.map((entry) => {
          const note = entry.noteId === null ? undefined : noteById.get(entry.noteId);
          const visible = note !== undefined && (!opts.customerView || note.visibility === "customer");
          return {
            at: entry.occurredAt,
            from: entry.fromStatus,
            fromLabel: label(entry.fromStatus),
            to: entry.toStatus,
            toLabel: label(entry.toStatus)!,
            note: visible ? decryptNote(note.bodyEnc, note.publicId) : null,
            actorUserId: entry.actorUserId,
            actorRole: roleOf(entry.actorRole),
          };
        }),
        nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!.id) : null,
      };
    },

    /**
     * Part B (B2 port for the Order history tab, trusted — caller ran assertCanReadOrder): renames newest first,
     * ordered by (created_at DESC, id DESC) with a keyset cursor on the same pair (stable across timestamp ties,
     * index order_name_history_order_idx). `customerView` returns a generic entry only: no old/new name (an
     * earlier name may be a former owner's text after reassignment) and no actor id.
     */
    async listNameHistory(orderId: number, opts: { cursor?: string | null; limit: number; customerView: boolean; tx?: DbOrTx }) {
      const db = opts.tx ?? deps.db;
      const limit = Math.min(Math.max(Math.trunc(opts.limit) || 1, 1), MAX_PAGE);
      const before = decodeNameCursor(opts.cursor);
      const scope = eq(orderNameHistory.orderId, orderId);
      const rows = await db
        .select()
        .from(orderNameHistory)
        .where(
          before === null
            ? scope
            : and(
                scope,
                or(
                  lt(orderNameHistory.createdAt, before.at),
                  and(eq(orderNameHistory.createdAt, before.at), lt(orderNameHistory.id, before.id)),
                ),
              ),
        )
        .orderBy(desc(orderNameHistory.createdAt), desc(orderNameHistory.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const roleOf = (role: string): "customer" | "staff" | "admin" | "system" => (role === "admin" || role === "staff" || role === "system" ? role : "customer");
      const last = page[page.length - 1];
      return {
        items: page.map((entry) => ({
          at: entry.createdAt,
          oldName: opts.customerView ? null : entry.oldName,
          newName: opts.customerView ? null : entry.newName,
          actorUserId: opts.customerView ? null : entry.actorUserId,
          actorRole: roleOf(entry.actorRole),
        })),
        nextCursor: rows.length > limit && last ? encodeNameCursor(last.createdAt, last.id) : null,
      };
    },

    async addNote(principal: SessionPrincipal, input: { orderId: string; body: string; visibility?: NoteVisibility }) {
      const result = await deps.db.transaction(async (tx) => {
        const view = await policy.assertCanWriteOrder(principal, input.orderId, { kind: "order", tx, forUpdate: true });
        await assertActorCurrent(principal, tx, view.accessRole === "staff" || view.accessRole === "admin" ? "orders.manage" : undefined);
        const staffSide = view.accessRole === "staff" || view.accessRole === "admin";
        const visibility: NoteVisibility = staffSide ? (input.visibility ?? "internal") : "customer";
        if (!staffSide && input.visibility === "internal") throw forbidden("STAFF_ONLY");
        const note = await insertNote(tx, { orderId: view.id, principal, visibility, body: input.body });
        await tx.update(orders).set({ updatedAt: deps.clock.now() }).where(eq(orders.id, view.id));
        await deps.audit.record(
          {
            category: "business",
            eventName: "order.note.added",
            action: "create",
            outcome: "completed",
            actor: actorOf(principal),
            resource: { type: "order", publicId: view.publicId },
            attributes: { visibility, note_public_id: note.publicId },
          },
          tx,
        );
        return { note, view, visibility };
      });
      if (result.visibility === "customer") {
        await notifyParticipants(result.view, principal.userId, "order.note_added", `New note on ${result.view.reference}`, "A new note was added to your order.");
      }
      return { publicId: result.note.publicId };
    },

    /* ------------------------------------------------- increment 07: in-tx status writes */

    /**
     * Increment 07 (D1/D5/D9, trusted — caller authorised and locked nothing else first). A status change inside the
     * caller's transaction. `transition`: an allowed transition for `actor` in the pinned version (requirements, phase
     * locks and gates apply exactly as in `transition`). `override`: administrator only, audited with a reason; skips
     * the transition graph and the forward requirement check, never the order lock.
     */
    async applyStatusInTx(
      tx: Tx,
      input: {
        orderId: number;
        toStatus: string;
        principal: SessionPrincipal | null;
        actor: WorkflowActor;
        mode: "transition" | "override";
        reasonCode: string;
        overrideReason?: string;
        expectedVersion?: number;
        correlationId?: string;
      },
    ): Promise<{ fromStatus: string; toStatus: string; version: number; notify: boolean; view: OrderAccessView; bound: BoundWorkflow }> {
      const [row] = await tx.select().from(orders).where(eq(orders.id, input.orderId)).limit(1).for("update");
      if (!row) throw ORDER_NOT_FOUND();
      if (row.lockState !== "none") throw orderLocked(row.lockState);
      if (input.expectedVersion !== undefined && row.version !== input.expectedVersion) throw staleVersion();
      const bound = await workflows.byVersionId(tx, row.workflowVersionId);
      if (!findState(bound.definition, input.toStatus)) throw validation("STATUS_UNKNOWN", "That status is not part of this order's workflow.");
      let notify = false;
      if (input.mode === "transition") {
        const transition = transitionsFrom(bound.definition, row.statusKey, input.actor).find((candidate) => candidate.to === input.toStatus);
        if (!transition) throw new DomainError("FORBIDDEN", "TRANSITION_NOT_ALLOWED", "That status change is not available for this order.");
        notify = transition.notifyCustomer;
        if (!isCancelTarget(bound, transition.to)) {
          if (input.actor === "customer" && input.principal)
            await deps.gates.assertCustomerMayWork({ tx, orderId: row.id, actor: input.principal, action: "phase_submit", statusKey: row.statusKey });
          else if (input.actor === "api" || !input.principal) await deps.gates.assertSystemMayWork({ tx, orderId: row.id, action: "phase_submit", statusKey: row.statusKey });
        }
      } else {
        if (input.principal?.role !== "admin") throw new DomainError("FORBIDDEN", "OVERRIDE_ADMIN_ONLY", "Only an administrator can move an order outside its workflow.");
        if (!input.overrideReason || input.overrideReason.trim().length < 10) throw validation("REASON_REQUIRED", "Please give a reason of at least 10 characters.");
      }
      const owner = await identityPort(deps.services).getUser(row.ownerUserId, { tx });
      const view: OrderAccessView = {
        id: row.id,
        publicId: row.publicId,
        reference: row.reference,
        ownerUserId: row.ownerUserId,
        ownerPublicId: owner?.publicId ?? "",
        statusKey: row.statusKey,
        lockState: row.lockState,
        locked: false,
        readOnlyImported: false,
        accessRole: input.actor === "customer" ? "owner" : input.actor === "admin" ? "admin" : "staff",
        canWrite: true,
        origin: row.origin,
        version: row.version,
        workflowVersionId: row.workflowVersionId,
        discountMinor: row.discountMinor,
        discountLabel: row.discountLabel,
        promoDiscountMinor: row.promoDiscountMinor,
        promoLabel: row.promoLabel,
        bundleDiscountMinor: Math.max(0, row.discountMinor - row.promoDiscountMinor),
      };
      await deps.requirements.onTransition(tx, input.principal, view, bound, input.toStatus, { skipRequirements: input.mode === "override" });
      const now = deps.clock.now();
      const result = await tx
        .update(orders)
        .set({ statusKey: input.toStatus, version: row.version + 1, updatedAt: now })
        .where(and(eq(orders.id, row.id), eq(orders.version, row.version)));
      if (affectedRows(result) !== 1) throw staleVersion();
      if (isCancelTarget(bound, input.toStatus)) await releasePromotionOnCancel(tx, row.id);
      await tx.insert(orderStatusHistory).values({
        publicId: ulid(now.getTime()),
        orderId: row.id,
        fromStatus: row.statusKey,
        toStatus: input.toStatus,
        actorUserId: input.principal?.userId ?? null,
        actorRole: input.principal ? (input.actor === "customer" ? "customer" : input.principal.role) : "system",
        reasonCode: input.reasonCode,
        noteId: null,
        occurredAt: now,
      });
      const actor = input.principal ? actorOf(input.principal) : { role: "system" as const };
      await deps.audit.record(
        {
          category: "business",
          eventName: "order.status.changed",
          action: "transition",
          outcome: "completed",
          actor,
          ...(input.correlationId ? { correlationId: input.correlationId } : {}),
          resource: { type: "order", publicId: row.publicId },
          reasonCode: input.reasonCode,
          attributes: { from_status: row.statusKey, to_status: input.toStatus, workflow_version: bound.versionNumber, mode: input.mode },
        },
        tx,
      );
      if (input.mode === "override") {
        await deps.audit.record(
          {
            category: "admin",
            eventName: "order.stage.status_overridden",
            action: "override",
            outcome: "completed",
            severity: "WARN",
            actor,
            resource: { type: "order", publicId: row.publicId },
            reasonCode: input.reasonCode,
            attributes: { from_status: row.statusKey, to_status: input.toStatus, reason_length: String(input.overrideReason?.trim().length ?? 0) },
          },
          tx,
        );
      }
      await emitChange(tx, { orderId: row.id, orderPublicId: row.publicId, kind: "status_changed" });
      const passedApply = await deps.stageRuntime?.afterStatusChangeInTx(tx, { orderId: row.id, bound, fromStatus: row.statusKey, toStatus: input.toStatus });
      await auditPassedByStatus(tx, passedApply?.passedWithoutSubmission, { actor, orderPublicId: row.publicId, fromStatus: row.statusKey, toStatus: input.toStatus, reasonCode: input.reasonCode });
      return { fromStatus: row.statusKey, toStatus: input.toStatus, version: row.version + 1, notify, view: { ...view, statusKey: input.toStatus, version: row.version + 1 }, bound };
    },

    /** Increment 07: the customer notice for a status write made by `applyStatusInTx` (call after commit). */
    async notifyStatusChanged(input: { view: OrderAccessView; bound: BoundWorkflow; toStatus: string; version: number; actorUserId: number | null }) {
      const state = findState(input.bound.definition, input.toStatus);
      const statusLabel = state?.customerLabel ?? input.toStatus;
      await notifyParticipants(input.view, input.actorUserId, "order.status_changed", `${input.view.reference}: ${statusLabel}`, `Your order status is now “${statusLabel}”.`, {
        template: "orders.status_changed",
        vars: { reference: input.view.reference, statusLabel, link: `/orders/${input.view.publicId}` },
        idempotencyKey: `order-status:${input.view.publicId}:${input.version}`,
      });
    },

    /* ------------------------------------------------------------ transition */
    async transition(principal: SessionPrincipal, input: { orderId: string; expectedVersion: number; toStatus: string; note?: string; noteVisibility?: NoteVisibility }) {
      let outcome: { view: OrderAccessView; bound: BoundWorkflow; notify: boolean; from: string };
      try {
        outcome = await deps.db.transaction(async (tx) => {
          const view = await policy.assertCanWriteOrder(principal, input.orderId, { kind: "status", tx, forUpdate: true });
          await assertActorCurrent(principal, tx, view.accessRole === "staff" || view.accessRole === "admin" ? "orders.transition" : undefined);
          if (view.version !== input.expectedVersion) throw staleVersion();
          const actor = workflowActor(view);
          const bound = await workflows.byVersionId(tx, view.workflowVersionId);
          const transition = actor ? transitionsFrom(bound.definition, view.statusKey, actor).find((t) => t.to === input.toStatus) : undefined;
          if (!transition) throw new DomainError("FORBIDDEN", "TRANSITION_NOT_ALLOWED", "That status change is not available for this order.");
          if (transition.requiresNote && !input.note) throw validation("NOTE_REQUIRED", "Please add a note explaining this change.");
          // Lead ruling (QA e8fe1ec): a customer may not move out of an open submit-and-lock phase by a plain status
          // change (that skipped the questions, acknowledgement and lock). Staff, admin and API actors are unaffected.
          if (actor === "customer" && !isCancelTarget(bound, transition.to) && (await submitLockPending(tx, view.id, view.workflowVersionId, bound, view.statusKey)))
            throw conflict("STAGE_SUBMIT_REQUIRED", "Finish this phase with Submit and lock first.");
          // QA: a customer status action that leaves a format-3 phase (e.g. Approve) needs that phase's required questions.
          if (actor === "customer" && !isCancelTarget(bound, transition.to)) await assertPhaseQuestionsForExit(tx, view.id, view.workflowVersionId, bound, view.statusKey, transition.to);
          // B6: a customer-side phase submit (any move out of a gated status) needs the gate met; cancel is always allowed.
          if (actor === "customer" && !isCancelTarget(bound, transition.to))
            await deps.gates.assertCustomerMayWork({ tx, orderId: view.id, actor: principal, action: "phase_submit", statusKey: view.statusKey });
          await deps.requirements.onTransition(tx, principal, view, bound, transition.to);
          const now = deps.clock.now();
          const staffSide = actor !== "customer";
          const note = input.note
            ? await insertNote(tx, { orderId: view.id, principal, visibility: staffSide ? (input.noteVisibility ?? "customer") : "customer", body: input.note })
            : null;
          const result = await tx
            .update(orders)
            .set({ statusKey: transition.to, version: view.version + 1, updatedAt: now })
            .where(and(eq(orders.id, view.id), eq(orders.version, view.version)));
          if (affectedRows(result) !== 1) throw staleVersion();
          if (isCancelTarget(bound, transition.to)) await releasePromotionOnCancel(tx, view.id);
          await tx.insert(orderStatusHistory).values({
            publicId: ulid(now.getTime()),
            orderId: view.id,
            fromStatus: view.statusKey,
            toStatus: transition.to,
            actorUserId: principal.userId,
            actorRole: actor === "customer" ? "customer" : principal.role,
            reasonCode: "TRANSITION",
            noteId: note?.id ?? null,
            occurredAt: now,
          });
          const passed = await deps.stageRuntime?.afterStatusChangeInTx(tx, { orderId: view.id, bound, fromStatus: view.statusKey, toStatus: transition.to });
          await auditPassedByStatus(tx, passed?.passedWithoutSubmission, { actor: actorOf(principal), orderPublicId: view.publicId, fromStatus: view.statusKey, toStatus: transition.to, reasonCode: "TRANSITION" });
          await deps.audit.record(
            {
              category: "business",
              eventName: "order.status.changed",
              action: "transition",
              outcome: "completed",
              actor: actorOf(principal),
              resource: { type: "order", publicId: view.publicId },
              attributes: { from_status: view.statusKey, to_status: transition.to, workflow_version: bound.versionNumber },
            },
            tx,
          );
          await emitChange(tx, { orderId: view.id, orderPublicId: view.publicId, kind: "status_changed" });
          return { view, bound, notify: transition.notifyCustomer, from: view.statusKey };
        });
      } catch (error) {
        if (error instanceof DomainError && error.reasonCode === "TRANSITION_NOT_ALLOWED") {
          try {
            await deps.audit.record({
              category: "business",
              eventName: "order.transition.denied",
              action: "transition",
              outcome: "denied",
              severity: "WARN",
              reasonCode: "TRANSITION_NOT_ALLOWED",
              actor: actorOf(principal),
              resource: { type: "order", publicId: input.orderId },
            });
          } catch {
            // refusal stands regardless
          }
        }
        throw error;
      }
      const { view, bound, notify } = outcome;
      if (notify) {
        const state = findState(bound.definition, input.toStatus);
        const statusLabel = state?.customerLabel ?? input.toStatus;
        await notifyParticipants(view, principal.userId, "order.status_changed", `${view.reference}: ${statusLabel}`, `Your order status is now “${statusLabel}”.`, {
          template: "orders.status_changed",
          vars: { reference: view.reference, statusLabel, link: `/orders/${view.publicId}` },
          idempotencyKey: `order-status:${view.publicId}:${view.version + 1}`,
        });
      }
      return { version: view.version + 1, statusKey: input.toStatus };
    },

    /**
     * Increment 04 (public API, package H): a transition by an integration (service principal, no user). Allowed
     * only where the pinned workflow lists actor `api`, only on unlocked orders, with the same requirement guard,
     * phase bookkeeping, audit (actor system, correlated to the API request) and notifications.
     */
    async transitionAsSystem(input: { orderPublicId: string; expectedVersion: number; toStatus: string; note?: string; correlationId: string }) {
      const outcome = await deps.db.transaction(async (tx) => {
        const [row] = await tx.select().from(orders).where(eq(orders.publicId, input.orderPublicId)).limit(1).for("update");
        if (!row) throw ORDER_NOT_FOUND();
        if (row.lockState !== "none") throw orderLocked(row.lockState);
        if (row.version !== input.expectedVersion) throw staleVersion();
        const bound = await workflows.byVersionId(tx, row.workflowVersionId);
        const transition = transitionsFrom(bound.definition, row.statusKey, "api").find((candidate) => candidate.to === input.toStatus);
        if (!transition) throw new DomainError("FORBIDDEN", "TRANSITION_NOT_ALLOWED", "That status change is not available for this order.");
        if (transition.requiresNote && !input.note) throw validation("NOTE_REQUIRED", "Please add a note explaining this change.");
        // B6: integrations act for the owner; the owner's acceptance is required (fail closed). Cancel is exempt.
        if (!isCancelTarget(bound, transition.to))
          await deps.gates.assertSystemMayWork({ tx, orderId: row.id, action: "phase_submit", statusKey: row.statusKey });
        const owner = await identityPort(deps.services).getUser(row.ownerUserId, { tx });
        const view: OrderAccessView = {
          id: row.id,
          publicId: row.publicId,
          reference: row.reference,
          ownerUserId: row.ownerUserId,
          ownerPublicId: owner?.publicId ?? "",
          statusKey: row.statusKey,
          lockState: row.lockState,
          locked: false,
          readOnlyImported: false,
          accessRole: "staff",
          canWrite: true,
          origin: row.origin,
          version: row.version,
          workflowVersionId: row.workflowVersionId,
          discountMinor: row.discountMinor,
          discountLabel: row.discountLabel,
          promoDiscountMinor: row.promoDiscountMinor,
          promoLabel: row.promoLabel,
          bundleDiscountMinor: Math.max(0, row.discountMinor - row.promoDiscountMinor),
        };
        await deps.requirements.onTransition(tx, null, view, bound, transition.to);
        const now = deps.clock.now();
        const note = input.note ? await insertNote(tx, { orderId: row.id, principal: null, visibility: "customer", body: input.note }) : null;
        const result = await tx
          .update(orders)
          .set({ statusKey: transition.to, version: row.version + 1, updatedAt: now })
          .where(and(eq(orders.id, row.id), eq(orders.version, row.version)));
        if (affectedRows(result) !== 1) throw staleVersion();
        if (isCancelTarget(bound, transition.to)) await releasePromotionOnCancel(tx, row.id);
        await tx.insert(orderStatusHistory).values({
          publicId: ulid(now.getTime()),
          orderId: row.id,
          fromStatus: row.statusKey,
          toStatus: transition.to,
          actorUserId: null,
          actorRole: "system",
          reasonCode: "API_TRANSITION",
          noteId: note?.id ?? null,
          occurredAt: now,
        });
        const passedApi = await deps.stageRuntime?.afterStatusChangeInTx(tx, { orderId: row.id, bound, fromStatus: row.statusKey, toStatus: transition.to });
        await auditPassedByStatus(tx, passedApi?.passedWithoutSubmission, { actor: { role: "system" }, orderPublicId: row.publicId, fromStatus: row.statusKey, toStatus: transition.to, reasonCode: "API_TRANSITION" });
        await deps.audit.record(
          {
            category: "business",
            eventName: "order.status.changed",
            action: "transition",
            outcome: "completed",
            actor: { role: "system" },
            correlationId: input.correlationId,
            resource: { type: "order", publicId: row.publicId },
            attributes: { from_status: row.statusKey, to_status: transition.to, workflow_version: bound.versionNumber, channel: "api" },
          },
          tx,
        );
        await emitChange(tx, { orderId: row.id, orderPublicId: row.publicId, kind: "status_changed" });
        return { view, bound, notify: transition.notifyCustomer };
      });
      if (outcome.notify) {
        const state = findState(outcome.bound.definition, input.toStatus);
        const statusLabel = state?.customerLabel ?? input.toStatus;
        await notifyParticipants(outcome.view, null, "order.status_changed", `${outcome.view.reference}: ${statusLabel}`, `Your order status is now “${statusLabel}”.`, {
          template: "orders.status_changed",
          vars: { reference: outcome.view.reference, statusLabel, link: `/orders/${outcome.view.publicId}` },
          idempotencyKey: `order-status:${outcome.view.publicId}:${outcome.view.version + 1}`,
        });
      }
      return { version: outcome.view.version + 1, statusKey: input.toStatus };
    },

    /** Increment 04 (public API): create for a customer by an integration (system actor, same pricing rules). */
    async createAsSystem(input: { ownerPublicId: string; projectName: string; items: { productPublicId: string; quantity: number }[]; note?: string; idempotencyKey: string; correlationId: string }) {
      const owner = await ownerUser(input.ownerPublicId);
      if (!owner) throw validation("CUSTOMER_NOT_ELIGIBLE", "Choose an active customer account.");
      const [existing] = await deps.db
        .select({ publicId: orders.publicId })
        .from(orders)
        .where(and(eq(orders.ownerUserId, owner.id), eq(orders.createKey, input.idempotencyKey)))
        .limit(1);
      if (existing) return { publicId: existing.publicId, created: false };
      const prefix = await readSetting(deps.settings, ORDER_REFERENCE_PREFIX);
      try {
        return await deps.db.transaction(async (tx) => {
          const fresh = await ownerUser(input.ownerPublicId, tx);
          if (!fresh) throw validation("CUSTOMER_NOT_ELIGIBLE", "Choose an active customer account.");
          const result = await createInTx(tx, null, input, fresh.id, prefix, { correlationId: input.correlationId, channel: "api" });
          return { publicId: result.publicId, created: true };
        });
      } catch (error) {
        if (isDuplicateKey(error)) {
          const [again] = await deps.db.select({ publicId: orders.publicId }).from(orders).where(and(eq(orders.ownerUserId, owner.id), eq(orders.createKey, input.idempotencyKey))).limit(1);
          if (again) return { publicId: again.publicId, created: false };
        }
        throw error;
      }
    },

    /* ----------------------------------------------------------------- locks */
    async setLock(principal: SessionPrincipal, input: { orderId: string; expectedVersion: number; lockState: OrderLockState; reasonCode: string }) {
      return deps.db.transaction(async (tx) => {
        const view = await policy.assertCanReadOrder(principal, input.orderId, { tx, forUpdate: true });
        const staffSide = view.accessRole === "staff" || view.accessRole === "admin";
        if (!staffSide || !roleHasCapability(principal.role, "orders.manage")) {
          if (!staffSide) throw ORDER_NOT_FOUND();
          throw forbidden("CAPABILITY_NOT_GRANTED");
        }
        await assertActorCurrent(principal, tx, "orders.manage"); // after the order row lock (canonical order)
        const adminOnly = (state: OrderLockState) => state === "legal_hold" || state === "imported_read_only";
        if ((adminOnly(view.lockState) || adminOnly(input.lockState)) && principal.role !== "admin")
          throw new DomainError("FORBIDDEN", "ADMIN_ONLY", "Only an administrator can change this lock.");
        if (view.version !== input.expectedVersion) throw staleVersion();
        if (view.lockState === input.lockState) return { version: view.version, lockState: view.lockState };
        const now = deps.clock.now();
        await tx
          .update(orders)
          .set({
            lockState: input.lockState,
            lockReasonCode: input.lockState === "none" ? null : input.reasonCode,
            lockedAt: input.lockState === "none" ? null : now,
            version: view.version + 1,
            updatedAt: now,
          })
          .where(and(eq(orders.id, view.id), eq(orders.version, view.version)));
        await tx.insert(orderLockHistory).values({
          orderId: view.id,
          fromState: view.lockState,
          toState: input.lockState,
          reasonCode: input.reasonCode,
          actorUserId: principal.userId,
          occurredAt: now,
        });
        await deps.audit.record(
          {
            category: "business",
            eventName: "order.lock.changed",
            action: "lock",
            outcome: "completed",
            severity: input.lockState === "legal_hold" || view.lockState === "legal_hold" ? "WARN" : "INFO",
            reasonCode: input.reasonCode,
            actor: actorOf(principal),
            resource: { type: "order", publicId: view.publicId },
            attributes: { from_state: view.lockState, to_state: input.lockState },
          },
          tx,
        );
        await emitChange(tx, { orderId: view.id, orderPublicId: view.publicId, kind: "updated" });
        return { version: view.version + 1, lockState: input.lockState };
      });
    },

    /* ------------------------------------------------------------- reference */
    async changeReference(principal: SessionPrincipal, input: { orderId: string; expectedVersion: number; newReference: string; reasonCode: string }) {
      if (!roleHasCapability(principal.role, "orders.identifiers.change") || principal.role === "customer") throw forbidden("CAPABILITY_NOT_GRANTED");
      assertFreshStepUp(principal);
      const reference = normalizeReference(input.newReference);
      return deps.db.transaction(async (tx) => {
        const view = await policy.assertCanReadOrder(principal, input.orderId, { tx, forUpdate: true });
        await assertActorCurrent(principal, tx, "orders.identifiers.change"); // after the order row lock
        if (view.version !== input.expectedVersion) throw staleVersion();
        if (view.lockState === "legal_hold") throw orderLocked(view.lockState);
        if (reference === view.reference) throw conflict("REFERENCE_UNCHANGED", "That is already the order's reference.");
        const now = deps.clock.now();
        await reserveReference(tx, { reference, orderId: view.id, reasonCode: input.reasonCode, actorUserId: principal.userId, now });
        await tx
          .update(orderReferences)
          .set({ status: "retired", retiredAt: now })
          .where(and(eq(orderReferences.orderId, view.id), eq(orderReferences.reference, view.reference)));
        await tx
          .update(orders)
          .set({ reference, version: view.version + 1, updatedAt: now })
          .where(and(eq(orders.id, view.id), eq(orders.version, view.version)));
        await deps.audit.record(
          {
            category: "admin",
            eventName: "order.reference.changed",
            action: "update",
            outcome: "completed",
            severity: "WARN",
            reasonCode: input.reasonCode,
            actor: actorOf(principal),
            resource: { type: "order", publicId: view.publicId },
            attributes: { previous_reference: view.reference, new_reference: reference },
          },
          tx,
        );
        await emitChange(tx, { orderId: view.id, orderPublicId: view.publicId, kind: "updated" });
        return { reference, version: view.version + 1 };
      });
    },

    async referenceHistory(principal: SessionPrincipal, orderPublicId: string) {
      const view = await policy.assertCanReadOrder(principal, orderPublicId);
      if (view.accessRole !== "staff" && view.accessRole !== "admin") throw ORDER_NOT_FOUND();
      const rows = await deps.db.select().from(orderReferences).where(eq(orderReferences.orderId, view.id)).orderBy(asc(orderReferences.id)).limit(100);
      return rows.map((r) => ({ reference: r.reference, status: r.status, reasonCode: r.reasonCode, assignedAt: r.assignedAt, retiredAt: r.retiredAt }));
    },

    /* ------------------------------------------------------------ reassign */
    /**
     * Transactional authority change: ownership moves, every live grant is revoked, files are rebound (which
     * invalidates outstanding download tickets), history + audit are written — all or nothing. Idempotent on
     * `operationId`.
     */
    async reassign(
      principal: SessionPrincipal,
      input: { orderId: string; targetCustomerPublicId: string; expectedVersion: number; operationId: string; reasonCode: string },
    ) {
      if (principal.role !== "admin" || !roleHasCapability(principal.role, "orders.reassign")) throw forbidden("CAPABILITY_NOT_GRANTED");
      assertFreshStepUp(principal);
      const [prior] = await deps.db
        .select({ r: orderReassignments, orderPublicId: orders.publicId, version: orders.version })
        .from(orderReassignments)
        .innerJoin(orders, eq(orders.id, orderReassignments.orderId))
        .where(eq(orderReassignments.operationId, input.operationId))
        .limit(1);
      if (prior) {
        const target = await identityPort(deps.services).getUser(prior.r.toUserId);
        if (prior.orderPublicId === input.orderId && target?.publicId === input.targetCustomerPublicId) {
          return { replayed: true, revokedGrants: prior.r.revokedGrants, version: prior.version };
        }
        throw conflict("OPERATION_ID_REUSED", "This operation identifier was already used for a different change.");
      }

      const refuse = async (reasonCode: string) => {
        try {
          await deps.audit.record({
            category: "admin",
            eventName: "order.reassign.refused",
            action: "reassign",
            outcome: "refused",
            severity: "WARN",
            reasonCode,
            actor: actorOf(principal),
            resource: { type: "order", publicId: ULID_LIKE.test(input.orderId) ? input.orderId : null },
          });
        } catch {
          // refusal stands regardless
        }
      };

      let committed: { view: OrderAccessView; toUserId: number; revokedGrants: number };
      try {
        committed = await deps.db.transaction(async (tx) => {
          const view = await policy.assertCanReadOrder(principal, input.orderId, { tx, forUpdate: true });
          // Canonical order: order row → users rows in ascending id (actor and target) → actor session → grants → files.
          const identity = identityPort(deps.services);
          const located = await identity.getUserByPublicId(input.targetCustomerPublicId, { tx });
          if (!located) throw validation("TARGET_NOT_ELIGIBLE", "Choose an active customer account.");
          const userIds = [...new Set([principal.userId, located.id])].sort((a, b) => a - b);
          let target: typeof located | null = null;
          for (const id of userIds) {
            const locked = await identity.getUser(id, { tx, forUpdate: true });
            if (id === located.id) target = locked;
          }
          await assertActorCurrent(principal, tx, "orders.reassign");
          if (view.version !== input.expectedVersion) throw staleVersion();
          if (view.lockState === "legal_hold") throw orderLocked(view.lockState);
          if (!target || target.publicId !== input.targetCustomerPublicId || target.role !== "customer")
            throw validation("TARGET_NOT_ELIGIBLE", "Choose an active customer account.");
          if (target.status !== "active") throw validation("TARGET_INACTIVE", "The selected customer account is not active.");
          if (target.id === view.ownerUserId) throw conflict("TARGET_IS_OWNER", "That customer already owns this order.");
          const now = deps.clock.now();
          const live = await tx
            .select({ id: orderGrants.id })
            .from(orderGrants)
            .where(and(eq(orderGrants.orderId, view.id), inArray(orderGrants.status, ["pending", "active"])))
            .for("update");
          if (live.length > 0) {
            await tx
              .update(orderGrants)
              .set({ status: "revoked", liveKey: null, endedAt: now, endedByUserId: principal.userId, endReasonCode: "REASSIGNED" })
              .where(inArray(orderGrants.id, live.map((g) => g.id)));
          }
          await filesPort(deps.services).reassignOrderFiles(view.id, target.id, tx);
          const result = await tx
            .update(orders)
            .set({ ownerUserId: target.id, version: view.version + 1, updatedAt: now })
            .where(and(eq(orders.id, view.id), eq(orders.version, view.version)));
          if (affectedRows(result) !== 1) throw staleVersion();
          await tx.insert(orderReassignments).values({
            publicId: ulid(now.getTime()),
            operationId: input.operationId,
            orderId: view.id,
            fromUserId: view.ownerUserId,
            toUserId: target.id,
            actorUserId: principal.userId,
            reasonCode: input.reasonCode,
            revokedGrants: live.length,
            occurredAt: now,
          });
          await deps.audit.record(
            {
              category: "admin",
              eventName: "order.reassigned",
              action: "reassign",
              outcome: "completed",
              severity: "WARN",
              reasonCode: input.reasonCode,
              actor: actorOf(principal),
              resource: { type: "order", publicId: view.publicId },
              attributes: { from_owner: view.ownerPublicId, to_owner: target.publicId, operation_id: input.operationId },
              safeCounts: { revoked_grants: live.length },
            },
            tx,
          );
          await emitChange(tx, { orderId: view.id, orderPublicId: view.publicId, kind: "assigned" });
          return { view, toUserId: target.id, revokedGrants: live.length };
        });
      } catch (error) {
        if (error instanceof DomainError && error.code !== "AUDIT_UNAVAILABLE" && error.code !== "NOT_FOUND") await refuse(error.reasonCode);
        if (isDuplicateKey(error)) throw conflict("OPERATION_ID_REUSED", "This operation identifier was already used.");
        throw error;
      }
      await notifyParticipants({ ...committed.view, ownerUserId: committed.toUserId }, principal.userId, "order.reassigned", `${committed.view.reference} is now in your account`, "An order was moved to your account.");
      return { replayed: false, revokedGrants: committed.revokedGrants, version: committed.view.version + 1 };
    },

    /* --------------------------------------------------------------- search */
    async searchOrders(principal: SessionPrincipal, query: string, limit = 10) {
      const q = query.normalize("NFC").trim();
      if (q.length < 2 || q.length > 64) return [];
      const max = Math.min(Math.max(limit, 1), 20);
      if (principal.state !== "full" || principal.pendingSteps.length > 0) return [];
      const staffSide = principal.role !== "customer";
      if (staffSide && !roleHasCapability(principal.role, "orders.read_all")) return [];
      const now = deps.clock.now();
      // Authorization is part of the SAME statement as the match (O-02): no id list is read first.
      const sharedIds = deps.db
        .select({ id: orderGrants.orderId })
        .from(orderGrants)
        .where(
          and(
            eq(orderGrants.granteeUserId, principal.userId),
            eq(orderGrants.status, "active"),
            or(sql`${orderGrants.expiresAt} IS NULL`, sql`${orderGrants.expiresAt} > ${now}`),
          ),
        );
      const pattern = `%${likeLiteral(q)}%`;
      const rows = await deps.db
        .select()
        .from(orders)
        .where(
          and(
            staffSide ? undefined : or(eq(orders.ownerUserId, principal.userId), inArray(orders.id, sharedIds)),
            or(like(orders.reference, `${likeLiteral(q.toUpperCase())}%`), like(orders.projectName, pattern)),
          ),
        )
        .orderBy(desc(orders.id))
        .limit(max);
      const items = await toListItems(rows, principal, false);
      return items.map((item) => ({ publicId: item.publicId, reference: item.reference, projectName: item.projectName, statusLabel: item.statusLabel, updatedAt: item.updatedAt }));
    },

    /** Server price of a selection (same validation and figures as create); writes nothing. */
    async quote(principal: SessionPrincipal, input: { items: { productPublicId: string; quantity: number }[]; promoCode?: string; forCustomerPublicId?: string }): Promise<OrderQuote> {
      if (principal.state !== "full") throw ORDER_NOT_FOUND();
      // Eligibility is judged for the order owner: the caller, or (staff with orders.manage) the chosen customer.
      let ownerUserId = principal.userId;
      if (input.forCustomerPublicId !== undefined) {
        if (principal.role === "customer" || !roleHasCapability(principal.role, "orders.manage")) throw forbidden("CAPABILITY_NOT_GRANTED");
        const owner = await ownerUser(input.forCustomerPublicId);
        if (!owner) throw validation("CUSTOMER_NOT_ELIGIBLE", "Choose an active customer account.");
        ownerUserId = owner.id;
      }
      return withPromoAttemptGuard(deps.services, input.promoCode, principal.userId, () => snapshot(async (tx) => {
        const lineItems = await deps.catalog.resolveForOrder(tx, input.items);
        const base = priceOrder(lineItems, await deps.catalog.getBundleRule(tx));
        const currency = lineItems[0]!.currency;
        let pricing: OrderPricing & { promo?: { publicId: string; label: string; promoDiscountMinor: number } } = base;
        if (input.promoCode !== undefined) {
          const port = await requirePromotions(deps.services, tx);
          pricing = applyOutcome(base, await port.preview(promotionContext(input.promoCode, ownerUserId, principal.userId, currency, lineItems, base), { tx }));
        }
        return {
          currency,
          subtotalMinor: pricing.subtotalMinor,
          discountMinor: pricing.discountMinor,
          discountLabel: pricing.discountLabel,
          totalMinor: pricing.totalMinor,
          bundle: pricing.bundle,
          promo: pricing.promo ? { label: pricing.promo.label, promoDiscountMinor: pricing.promo.promoDiscountMinor } : null,
        };
      }));
    },

    /** Trusted (caller already authorised): packet scope for production webhooks. Uses the caller's tx; no locks. */
    async getProductionScope(orderId: number, opts: { tx?: DbOrTx } = {}): Promise<OrderProductionScope | null> {
      const db = opts.tx ?? deps.db;
      const [order] = await db
        .select({
          id: orders.id,
          publicId: orders.publicId,
          reference: orders.reference,
          ownerUserId: orders.ownerUserId,
          statusKey: orders.statusKey,
          lockState: orders.lockState,
          origin: orders.origin,
        })
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1);
      if (!order) return null;
      const items = await db
        .select({ packetNumber: orderLineItems.packetNumber, tier: orderLineItems.tier })
        .from(orderLineItems)
        .where(eq(orderLineItems.orderId, orderId))
        .limit(500);
      const packets = items
        .filter((item): item is { packetNumber: number; tier: PacketTier } => item.packetNumber !== null && item.tier !== null)
        .sort((a, b) => a.packetNumber - b.packetNumber);
      return {
        orderId: order.id,
        orderPublicId: order.publicId,
        reference: order.reference,
        ownerUserId: order.ownerUserId,
        statusKey: order.statusKey,
        lockState: order.lockState,
        origin: order.origin,
        packets,
        otherItemCount: items.length - packets.length,
      };
    },

    /** Registers an in-transaction change listener (registration at module wiring time only). */
    registerChangeListener(listener: OrderChangeListener) {
      changeListeners.push(listener);
    },

    /**
     * Trusted (system sync worker, no principal): every order's publicId in ascending ULID order, keyset paged.
     * Ids only (no PII). There are no placeholder orders: imported orders are real orders and are included.
     */
    async listOrderPublicIdsForSync(input: { afterPublicId?: string | null; limit: number }, tx?: DbOrTx): Promise<{ publicIds: string[]; nextAfter: string | null }> {
      const limit = Math.max(1, Math.min(500, Math.trunc(input.limit) || 1));
      const after = input.afterPublicId ?? null;
      if (after !== null && !ULID_LIKE.test(after)) throw validation("INVALID_CURSOR", "The cursor is not valid.");
      const db = tx ?? deps.db;
      const rows = await db
        .select({ publicId: orders.publicId })
        .from(orders)
        .where(after === null ? undefined : sql`${orders.publicId} > ${after}`)
        .orderBy(asc(orders.publicId))
        .limit(limit + 1);
      const page = rows.slice(0, limit).map((row) => row.publicId);
      return { publicIds: page, nextAfter: rows.length > limit ? (page.at(-1) ?? null) : null };
    },

    /**
     * Trusted (caller already authorised — system sync worker): data for one external list item per order.
     * No locks; uses the caller's tx when given. Customer name / reference belong to identity (ownerUserId).
     */
    async getOrderSyncView(orderPublicId: string, tx?: DbOrTx): Promise<OrderSyncView | null> {
      if (!ULID_LIKE.test(orderPublicId)) return null;
      const db = tx ?? deps.db;
      const [order] = await db.select().from(orders).where(eq(orders.publicId, orderPublicId)).limit(1);
      if (!order) return null;
      const items = await db
        .select({ packetNumber: orderLineItems.packetNumber, tier: orderLineItems.tier, name: orderLineItems.name })
        .from(orderLineItems)
        .where(eq(orderLineItems.orderId, order.id))
        .orderBy(asc(orderLineItems.id))
        .limit(500);
      const bound = await workflows.byVersionId(db, order.workflowVersionId);
      const state = findState(bound.definition, order.statusKey);
      let closedAt: Date | null = null;
      if (state?.kind === "terminal") {
        const [entered] = await db
          .select({ at: orderStatusHistory.occurredAt })
          .from(orderStatusHistory)
          .where(and(eq(orderStatusHistory.orderId, order.id), eq(orderStatusHistory.toStatus, order.statusKey)))
          .orderBy(desc(orderStatusHistory.id))
          .limit(1);
        closedAt = entered?.at ?? null;
      }
      return {
        publicId: order.publicId,
        reference: order.reference,
        status: { key: order.statusKey, label: state?.label ?? order.statusKey, kind: state?.kind ?? null },
        ownerUserId: order.ownerUserId,
        items,
        currency: order.currency,
        subtotalMinor: order.subtotalMinor,
        discountMinor: order.discountMinor,
        totalMinor: order.totalMinor,
        createdAt: order.createdAt,
        submittedAt: order.submittedAt,
        closedAt,
        updatedAt: order.updatedAt,
      };
    },

    /** Trusted (caller already authorised): like getOrderRefById, by public id; null for unknown or malformed ids. */
    async getOrderRefByPublicId(orderPublicId: string, tx?: DbOrTx, options: { forUpdate?: boolean } = {}) {
      if (options.forUpdate && !tx) throw new DomainError("VALIDATION", "TX_REQUIRED", "A row lock requires a transaction.");
      if (!ULID_LIKE.test(orderPublicId)) return null;
      const query = (tx ?? deps.db)
        .select({ id: orders.id, publicId: orders.publicId, reference: orders.reference, name: orders.projectName, ownerUserId: orders.ownerUserId, lockState: orders.lockState, statusKey: orders.statusKey, workflowVersionId: orders.workflowVersionId })
        .from(orders)
        .where(eq(orders.publicId, orderPublicId))
        .limit(1);
      const [row] = options.forUpdate ? await query.for("update") : await query;
      return row ?? null;
    },

    async getOrderRefById(orderId: number, tx?: DbOrTx, options: { forUpdate?: boolean } = {}) {
      if (options.forUpdate && !tx) throw new DomainError("VALIDATION", "TX_REQUIRED", "A row lock requires a transaction.");
      const query = (tx ?? deps.db)
        .select({ id: orders.id, publicId: orders.publicId, reference: orders.reference, name: orders.projectName, ownerUserId: orders.ownerUserId, lockState: orders.lockState, statusKey: orders.statusKey, workflowVersionId: orders.workflowVersionId })
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1);
      const [row] = options.forUpdate ? await query.for("update") : await query;
      return row ?? null;
    },
  };
  return service;
}

const ULID_LIKE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function isCancelTarget(bound: BoundWorkflow, to: string): boolean {
  const target = findState(bound.definition, to);
  return target ? isCancelState(target) : false;
}

/** B2: 1–120 characters after NFC + trim, no control characters. */
export function normalizeOrderName(value: string): string {
  const name = value.normalize("NFC").trim();
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (name.length < 1 || name.length > 120 || /[\u0000-\u001f\u007f-\u009f]/.test(name))
    throw validation("ORDER_NAME_INVALID", "Enter an order name of 1 to 120 characters without control characters.");
  return name;
}

export function affectedRows(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  return (header as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
}

export function isDuplicateKey(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if ((current as { code?: string }).code === "ER_DUP_ENTRY") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export interface OrderSyncView {
  publicId: string;
  reference: string;
  status: { key: string; label: string; kind: "initial" | "active" | "terminal" | null };
  ownerUserId: number;
  items: { packetNumber: number | null; tier: PacketTier | null; name: string }[];
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  createdAt: Date;
  submittedAt: Date | null;
  closedAt: Date | null;
  updatedAt: Date;
}

export type OrderService = ReturnType<typeof createOrderService>;
export { notFound };

/** True while the format-3 submit-and-lock phase owning `statusKey` has not been submitted or accepted. */
async function submitLockPending(db: DbOrTx, orderId: number, workflowVersionId: number, bound: BoundWorkflow, statusKey: string): Promise<boolean> {
  const stage = submitLockStageOf(stageModelOf(bound.definition), statusKey);
  if (!stage) return false;
  const [row] = await db
    .select({ state: orderStageProgress.state })
    .from(orderStageProgress)
    .where(and(eq(orderStageProgress.orderId, orderId), eq(orderStageProgress.workflowVersionId, workflowVersionId), eq(orderStageProgress.stageKey, stage.key)))
    .limit(1);
  return !(row && (row.state === "submitted" || row.state === "in_review" || row.state === "accepted"));
}

/** Format 3: leaving the current phase by a customer status action requires its required questions answered. */
async function assertPhaseQuestionsForExit(tx: Tx, orderId: number, workflowVersionId: number, bound: BoundWorkflow, fromStatus: string, toStatus: string): Promise<void> {
  const model = stageModelOf(bound.definition);
  if (model.derived) return;
  const from = stageIndexOfStatus(model, fromStatus);
  if (from < 0 || stageIndexOfStatus(model, toStatus) === from) return;
  const stage = model.stages[from]!;
  if (stage.actions.answerQuestions) await assertStageQuestionsAnswered(orderId, workflowVersionId, stage.key, tx);
}
