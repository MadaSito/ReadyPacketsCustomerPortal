/**
 * Increment 04 — workflow phases, phase locks and per-status requirements (upload slots + acknowledgements).
 *
 * Rules are data in the order's PINNED workflow version. Fulfilment is computed, never stored: upload counts come
 * from the files module (`countFilesInSlot`, current customer-visible originals) and acknowledgements from the
 * insert-only `order_acknowledgements` table. Lock order: order row (policy, FOR UPDATE) → actor (users,
 * user_sessions) → order_phase_locks rows → order_acknowledgements / order_notes inserts. Fails closed: when a
 * status needs uploads and the files module cannot count them, the transition is refused.
 */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { roleHasCapability } from "../../../shared/capabilities.js";
import { conflict, DomainError, forbidden, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { AuditEmitter, Clock, Db, FieldCrypto, Logger, SessionPrincipal, Tx } from "../../core/types.js";
import type { Services } from "../../container.js";
import type { ActorCheck } from "./actor.js";
import type { OrderGatesService } from "./gates.js";
import { ORDER_NOT_FOUND, orderLocked, type OrderPolicy } from "./policy.js";
import { engagementPort } from "./ports.js";
import { orderAcknowledgements, orderNotes, orderPhaseLocks, orders } from "./schema.js";
import type { OrderAccessView } from "./types.js";
import type { BoundWorkflow, WorkflowService } from "./workflows.js";
import {
  acknowledgementText,
  findState,
  isCancelState,
  type AckSide,
  type AcknowledgementRequirement,
  type UploadRequirement,
  type WorkflowActor,
  type WorkflowDefinition,
} from "./workflowTypes.js";

export interface RequirementsDeps {
  db: Db;
  clock: Clock;
  audit: AuditEmitter;
  crypto: FieldCrypto;
  logger: Logger;
  services: Services;
  policy: OrderPolicy;
  workflows: WorkflowService;
  actorCheck: ActorCheck;
  /** Part B: an unmet acceptance gate pauses customer acknowledgements too (fails closed; staff never gated). */
  gates: Pick<OrderGatesService, "assertCustomerMayWork" | "gatesOf">;
}

export type PhasePosition = "done" | "current" | "upcoming";
export type ReadOnlyReason = "order_locked" | "phase_locked" | null;

export interface RequirementsView {
  phases: { key: string; label: string; position: PhasePosition; locked: boolean; lockedAt: string | null }[];
  status: { key: string; label: string; phaseKey: string | null };
  uploads: (Omit<UploadRequirement, "hint"> & { hint: string | null; count: number; met: boolean; canUpload: boolean })[];
  acknowledgements: (AcknowledgementRequirement & { textSha256: string; met: boolean; acceptedAt: string | null; canAccept: boolean })[];
  unmet: number;
  readOnly: boolean;
  readOnlyReason: ReadOnlyReason;
  canUnlock: boolean;
  /** Part B: the customer has an unmet acceptance gate, so their uploads and acknowledgements are paused (display hint; writes re-check). */
  acceptancePending: boolean;
}

export interface FileUploadSlot {
  key: string;
  label: string;
  kind: "document" | "audio";
  maxCount: number;
  allowedTypes: string[];
}

export interface FileUploadSlots {
  statusKey: string;
  slots: FileUploadSlot[];
}

const actorOf = (principal: SessionPrincipal) => ({ userId: principal.userId, role: principal.role });
export const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const isStaffSide = (view: OrderAccessView) => view.accessRole === "staff" || view.accessRole === "admin";

/** Who the principal is for requirement purposes (uploads/acks). Viewers have no side. */
function requirementActor(view: OrderAccessView): WorkflowActor | null {
  if (view.accessRole === "admin") return "admin";
  if (view.accessRole === "staff") return "staff";
  if (view.accessRole === "owner" || view.accessRole === "contributor") return "customer";
  return null;
}
const sideOf = (actor: WorkflowActor | null): AckSide | null => (actor === null ? null : actor === "customer" ? "customer" : "staff");

/** Mirrors the policy lock matrix for requirement writes (customer side blocked by any order lock). */
function orderLockBlocks(view: OrderAccessView): boolean {
  if (view.lockState === "none") return false;
  if (view.lockState === "legal_hold" || view.lockState === "imported_read_only") return true;
  return !isStaffSide(view);
}

const requirementsUnmet = (uploads: string[], acknowledgements: string[]) =>
  new DomainError("VALIDATION", "REQUIREMENTS_UNMET", "Some items are still needed before this order can move on.", { uploads, acknowledgements });

const phaseLocked = () => new DomainError("FORBIDDEN", "PHASE_LOCKED", "This part of the order is locked. Ask our team to unlock it if something needs to change.");

interface CountSlot {
  (orderId: number, slotKey: string, tx?: Tx, options?: { statusKey?: string }): Promise<number>;
}

export function createRequirementsService(deps: RequirementsDeps) {
  const { policy, workflows } = deps;

  function countPort(): CountSlot | null {
    const files = (deps.services as Partial<Services>).files as unknown as { countFilesInSlot?: CountSlot } | undefined;
    return typeof files?.countFilesInSlot === "function" ? files.countFilesInSlot.bind(files) : null;
  }

  async function phaseRows(tx: Tx, orderId: number, forUpdate = false) {
    const query = tx.select().from(orderPhaseLocks).where(eq(orderPhaseLocks.orderId, orderId));
    return forUpdate ? query.for("update") : query;
  }

  function lockedPhaseOfStatus(definition: WorkflowDefinition, statusKey: string, rows: { phaseKey: string; state: string }[]): boolean {
    const phase = findState(definition, statusKey)?.phase;
    if (!phase) return false;
    return rows.some((row) => row.phaseKey === phase && row.state === "locked");
  }

  async function uploadCounts(tx: Tx, view: OrderAccessView, statusKey: string, uploads: UploadRequirement[], strict: boolean) {
    const counts = new Map<string, number>();
    if (uploads.length === 0) return counts;
    const count = countPort();
    if (!count) {
      if (strict) throw new DomainError("UNAVAILABLE", "FILES_UNAVAILABLE", "This action is temporarily unavailable. Please try again later.");
      for (const slot of uploads) counts.set(slot.key, 0);
      return counts;
    }
    for (const slot of uploads) counts.set(slot.key, await count(view.id, slot.key, tx, { statusKey }));
    return counts;
  }

  async function ackRows(tx: Tx, view: OrderAccessView, statusKey: string) {
    return tx
      .select({ ackKey: orderAcknowledgements.ackKey, side: orderAcknowledgements.acceptorSide, acceptedAt: orderAcknowledgements.acceptedAt, textSha256: orderAcknowledgements.textSha256 })
      .from(orderAcknowledgements)
      .where(and(eq(orderAcknowledgements.orderId, view.id), eq(orderAcknowledgements.workflowVersionId, view.workflowVersionId), eq(orderAcknowledgements.statusKey, statusKey)));
  }

  /** Unmet requirement keys of the order's current status (inside the caller's tx, after the order lock). */
  async function unmetFor(tx: Tx, view: OrderAccessView, bound: BoundWorkflow) {
    const state = findState(bound.definition, view.statusKey);
    const req = state?.requirements;
    if (!req) return { uploads: [] as string[], acknowledgements: [] as string[] };
    const counts = await uploadCounts(tx, view, view.statusKey, req.uploads.filter((slot) => slot.minCount > 0), true);
    const acks = req.acknowledgements.length ? await ackRows(tx, view, view.statusKey) : [];
    return {
      uploads: req.uploads.filter((slot) => slot.minCount > 0 && (counts.get(slot.key) ?? 0) < slot.minCount).map((slot) => slot.key),
      acknowledgements: req.acknowledgements
        .filter((ack) => !acks.some((row) => row.ackKey === ack.key && row.side === ack.acceptedBy && row.textSha256 === sha256Hex(acknowledgementText(ack))))
        .map((ack) => ack.key),
    };
  }

  return {
    /**
     * Transition guard + phase bookkeeping. Call inside the transition tx after the order row lock, the actor
     * re-check and the transition lookup, before the status update. Cancellation targets bypass the
     * requirement check (an order can always be canceled where the workflow allows it) but still lock phases.
     */
    async onTransition(tx: Tx, principal: SessionPrincipal | null, view: OrderAccessView, bound: BoundWorkflow, toStatus: string): Promise<void> {
      const definition = bound.definition;
      const target = findState(definition, toStatus);
      if (!(target && isCancelState(target))) {
        const unmet = await unmetFor(tx, view, bound);
        if (unmet.uploads.length || unmet.acknowledgements.length) throw requirementsUnmet(unmet.uploads, unmet.acknowledgements);
      }
      if (!(definition.phases?.length)) return;
      const fromPhase = findState(definition, view.statusKey)?.phase ?? null;
      const toPhase = target?.phase ?? null;
      const now = deps.clock.now();
      const rows = await phaseRows(tx, view.id, true);
      const events: { eventName: string; phase: string }[] = [];
      // Any staff unlock lasts until the next status change: re-lock unlocked phases the order is not entering.
      for (const row of rows) {
        if (row.state === "unlocked" && row.phaseKey !== toPhase && row.phaseKey !== fromPhase) {
          await tx.update(orderPhaseLocks).set({ state: "locked", lockedAt: now, version: row.version + 1, updatedAt: now }).where(eq(orderPhaseLocks.id, row.id));
          events.push({ eventName: "order.phase.locked", phase: row.phaseKey });
        }
      }
      if (fromPhase && fromPhase !== toPhase) {
        const existing = rows.find((row) => row.phaseKey === fromPhase);
        if (existing) {
          await tx
            .update(orderPhaseLocks)
            .set({ state: "locked", lockedAt: now, lockedFromStatus: view.statusKey, workflowVersionId: view.workflowVersionId, version: existing.version + 1, updatedAt: now })
            .where(eq(orderPhaseLocks.id, existing.id));
        } else {
          await tx.insert(orderPhaseLocks).values({
            orderId: view.id,
            workflowVersionId: view.workflowVersionId,
            phaseKey: fromPhase,
            state: "locked",
            lockedAt: now,
            lockedFromStatus: view.statusKey,
            createdAt: now,
            updatedAt: now,
          });
        }
        events.push({ eventName: "order.phase.locked", phase: fromPhase });
      }
      if (toPhase && toPhase !== fromPhase) {
        const existing = rows.find((row) => row.phaseKey === toPhase && row.state === "locked");
        if (existing) {
          await tx.update(orderPhaseLocks).set({ state: "unlocked", unlockedAt: now, unlockedByUserId: principal?.userId ?? null, version: existing.version + 1, updatedAt: now }).where(eq(orderPhaseLocks.id, existing.id));
          events.push({ eventName: "order.phase.reopened", phase: toPhase });
        }
      }
      for (const event of events) {
        await deps.audit.record(
          {
            category: "business",
            eventName: event.eventName,
            action: event.eventName === "order.phase.reopened" ? "unlock" : "lock",
            outcome: "completed",
            actor: principal ? actorOf(principal) : { role: "system" },
            resource: { type: "order", publicId: view.publicId },
            attributes: { phase_key: event.phase, from_status: view.statusKey, to_status: toStatus, workflow_version: bound.versionNumber },
          },
          tx,
        );
      }
    },

    /** Client view: phase rail + checklist of the current status. Read access suffices. */
    async forOrder(principal: SessionPrincipal, input: { orderId: string }): Promise<RequirementsView> {
      return deps.db.transaction(
        async (tx) => {
          const view = await policy.assertCanReadOrder(principal, input.orderId, { tx });
          const bound = await workflows.byVersionId(tx, view.workflowVersionId);
          const definition = bound.definition;
          const state = findState(definition, view.statusKey);
          const rows = await phaseRows(tx, view.id);
          const currentPhase = state?.phase ?? null;
          const phases = definition.phases ?? [];
          const currentIndex = phases.findIndex((phase) => phase.key === currentPhase);
          const phaseView = phases.map((phase, index) => {
            const row = rows.find((candidate) => candidate.phaseKey === phase.key);
            const locked = row?.state === "locked" && phase.key !== currentPhase;
            const position: PhasePosition = phase.key === currentPhase ? "current" : row || (currentIndex >= 0 && index < currentIndex) ? "done" : "upcoming";
            return { key: phase.key, label: phase.label, position, locked, lockedAt: locked && row ? row.lockedAt.toISOString() : null };
          });
          const actor = requirementActor(view);
          const side = sideOf(actor);
          const orderBlocked = orderLockBlocks(view);
          const readOnlyReason: ReadOnlyReason = view.locked ? "order_locked" : null;
          const canWriteAny = actor !== null && !orderBlocked && (side === "customer" || roleHasCapability(principal.role, "orders.manage"));
          const req = state?.requirements ?? { uploads: [], acknowledgements: [] };
          const counts = await uploadCounts(tx, view, view.statusKey, req.uploads, false);
          const acks = req.acknowledgements.length ? await ackRows(tx, view, view.statusKey) : [];
          // Display only: any refusal (unmet, provider missing or failing) shows as paused; the write paths enforce.
          let acceptancePending = false;
          if (side === "customer" && deps.gates.gatesOf(definition).length > 0) {
            try {
              await deps.gates.assertCustomerMayWork({ tx, orderId: view.id, actor: principal, action: "acknowledge", statusKey: view.statusKey });
            } catch {
              acceptancePending = true;
            }
          }
          const uploads = req.uploads.map(({ hint, ...slot }) => {
            const count = counts.get(slot.key) ?? 0;
            const filesSide = actor !== null && slot.uploadedBy.includes(actor) && !orderBlocked;
            return { ...slot, hint: hint ?? null, count, met: count >= slot.minCount, canUpload: filesSide && count < slot.maxCount };
          });
          const acknowledgements = req.acknowledgements.map((ack) => {
            const textSha256 = sha256Hex(acknowledgementText(ack));
            const row = acks.find((candidate) => candidate.ackKey === ack.key && candidate.side === ack.acceptedBy && candidate.textSha256 === textSha256);
            return {
              ...ack,
              textSha256,
              met: row !== undefined,
              acceptedAt: row ? row.acceptedAt.toISOString() : null,
              canAccept: row === undefined && canWriteAny && side === ack.acceptedBy,
            };
          });
          const unmet = uploads.filter((slot) => !slot.met).length + acknowledgements.filter((ack) => !ack.met).length;
          return {
            phases: phaseView,
            status: { key: view.statusKey, label: isStaffSide(view) ? (state?.label ?? view.statusKey) : (state?.customerLabel ?? view.statusKey), phaseKey: currentPhase },
            uploads,
            acknowledgements,
            unmet,
            readOnly: orderBlocked || actor === null,
            readOnlyReason,
            canUnlock: isStaffSide(view) && roleHasCapability(principal.role, "orders.phase.unlock") && phaseView.some((phase) => phase.locked),
            acceptancePending,
          };
        },
        { isolationLevel: "repeatable read", withConsistentSnapshot: true },
      );
    },

    /** Records an acceptance of the exact text shown. Insert-only; no edit or withdrawal. */
    async acknowledge(principal: SessionPrincipal, input: { orderId: string; statusKey: string; ackKey: string; textSha256: string; typedName?: string }) {
      const now = deps.clock.now();
      const result = await deps.db.transaction(async (tx) => {
        const view = await policy.assertCanReadOrder(principal, input.orderId, { tx, forUpdate: true });
        const actor = requirementActor(view);
        if (actor === null) throw new DomainError("FORBIDDEN", "GRANT_READ_ONLY", "You have view-only access to this order.");
        const side = sideOf(actor)!;
        if (side === "staff" && !roleHasCapability(principal.role, "orders.manage")) throw ORDER_NOT_FOUND();
        await deps.actorCheck(principal, tx, side === "staff" ? "orders.manage" : undefined);
        if (orderLockBlocks(view)) throw orderLocked(view.lockState);
        if (side === "customer") await deps.gates.assertCustomerMayWork({ tx, orderId: view.id, actor: principal, action: "acknowledge", statusKey: view.statusKey });
        const bound = await workflows.byVersionId(tx, view.workflowVersionId);
        if (input.statusKey !== view.statusKey) {
          const rows = await phaseRows(tx, view.id);
          if (lockedPhaseOfStatus(bound.definition, input.statusKey, rows)) throw phaseLocked();
          throw conflict("STATUS_CHANGED", "This order has moved on. Reload to see what is needed now.");
        }
        const ack = findState(bound.definition, view.statusKey)?.requirements?.acknowledgements.find((candidate) => candidate.key === input.ackKey);
        if (!ack) throw validation("ACK_NOT_FOUND", "This acknowledgement is not part of the current step.");
        if (ack.acceptedBy !== side) throw forbidden("ACK_WRONG_SIDE");
        const textSha256 = sha256Hex(acknowledgementText(ack));
        if (input.textSha256 !== textSha256) throw conflict("ACK_TEXT_CHANGED", "The text has changed since you opened it. Please read it again.");
        const typedName = input.typedName?.normalize("NFC").trim() ?? "";
        if (ack.requireTypedName && typedName.length < 2) throw validation("TYPED_NAME_REQUIRED", "Please type your full name to confirm.");
        const [existing] = await tx
          .select({ id: orderAcknowledgements.id })
          .from(orderAcknowledgements)
          .where(
            and(
              eq(orderAcknowledgements.orderId, view.id),
              eq(orderAcknowledgements.workflowVersionId, view.workflowVersionId),
              eq(orderAcknowledgements.statusKey, view.statusKey),
              eq(orderAcknowledgements.ackKey, ack.key),
              eq(orderAcknowledgements.acceptorSide, side),
            ),
          )
          .limit(1);
        if (existing) throw conflict("ACK_ALREADY_RECORDED", "This has already been accepted.");
        const publicId = ulid(now.getTime());
        await tx.insert(orderAcknowledgements).values({
          publicId,
          orderId: view.id,
          workflowVersionId: view.workflowVersionId,
          statusKey: view.statusKey,
          ackKey: ack.key,
          acceptorSide: side,
          textSha256,
          userId: principal.userId,
          userRole: principal.role,
          sessionId: principal.sessionId.slice(0, 64),
          typedNameEnc: ack.requireTypedName ? deps.crypto.encrypt(typedName.slice(0, 120), `order_acknowledgements.typed_name:${publicId}`) : null,
          acceptedAt: now,
        });
        await deps.audit.record(
          {
            category: "business",
            eventName: "order.acknowledgement.recorded",
            action: "accept",
            outcome: "completed",
            actor: actorOf(principal),
            resource: { type: "order", publicId: view.publicId },
            attributes: {
              acknowledgement_public_id: publicId,
              status_key: view.statusKey,
              ack_key: ack.key,
              text_sha256: textSha256,
              workflow_version: bound.versionNumber,
              acceptor_side: side,
              typed_name_present: ack.requireTypedName,
            },
          },
          tx,
        );
        return { acknowledgementId: publicId, acceptedAt: now.toISOString() };
      });
      return result;
    },

    /** Staff unlock of a locked phase (reason kept as a staff-only encrypted note). */
    async unlockPhase(principal: SessionPrincipal, input: { orderId: string; phaseKey: string; reason: string; notifyCustomer: boolean }) {
      const outcome = await deps.db.transaction(async (tx) => {
        const view = await policy.assertCanReadOrder(principal, input.orderId, { tx, forUpdate: true });
        if (!isStaffSide(view)) throw ORDER_NOT_FOUND();
        if (!roleHasCapability(principal.role, "orders.phase.unlock")) throw forbidden("CAPABILITY_NOT_GRANTED");
        await deps.actorCheck(principal, tx, "orders.phase.unlock");
        if (view.lockState === "legal_hold" || view.lockState === "imported_read_only") throw orderLocked(view.lockState);
        const [row] = await tx
          .select()
          .from(orderPhaseLocks)
          .where(and(eq(orderPhaseLocks.orderId, view.id), eq(orderPhaseLocks.phaseKey, input.phaseKey)))
          .limit(1)
          .for("update");
        if (!row || row.state !== "locked") throw conflict("PHASE_NOT_LOCKED", "This phase is not locked.");
        const now = deps.clock.now();
        const notePublicId = ulid(now.getTime());
        await tx.insert(orderNotes).values({
          publicId: notePublicId,
          orderId: view.id,
          authorUserId: principal.userId,
          authorRole: principal.role,
          visibility: "internal",
          bodyEnc: deps.crypto.encrypt(`Phase unlocked (${input.phaseKey}): ${input.reason}`, `order_notes.body:${notePublicId}`),
          createdAt: now,
        });
        await tx
          .update(orderPhaseLocks)
          .set({ state: "unlocked", unlockedAt: now, unlockedByUserId: principal.userId, unlockNotePublicId: notePublicId, version: row.version + 1, updatedAt: now })
          .where(eq(orderPhaseLocks.id, row.id));
        await deps.audit.record(
          {
            category: "business",
            eventName: "order.phase.unlocked",
            action: "unlock",
            outcome: "completed",
            actor: actorOf(principal),
            resource: { type: "order", publicId: view.publicId },
            attributes: { phase_key: input.phaseKey, note_public_id: notePublicId, notify_customer: input.notifyCustomer },
          },
          tx,
        );
        const bound = await workflows.byVersionId(tx, view.workflowVersionId);
        const label = bound.definition.phases?.find((phase) => phase.key === input.phaseKey)?.label ?? input.phaseKey;
        return { view, label };
      });
      if (input.notifyCustomer) {
        try {
          await engagementPort(deps.services)?.notify({
            userId: outcome.view.ownerUserId,
            kind: "order.phase_unlocked",
            title: `${outcome.view.reference}: ${outcome.label} reopened`,
            body: `Our team reopened “${outcome.label}” so it can be updated. It locks again at the next status change.`,
            link: `/orders/${outcome.view.publicId}`,
            idempotencyKey: `order.phase_unlocked:${outcome.view.publicId}:${input.phaseKey}:${deps.clock.now().getTime()}`,
            skipEmail: true,
          });
        } catch (error) {
          deps.logger.warn("phase unlock notification failed", { orderPublicId: outcome.view.publicId, errorName: error instanceof Error ? error.name : "unknown" });
        }
      }
      return { unlocked: true as const };
    },

    /** Files port: writable slots of the current status for this actor (none when read-only). */
    async getFileUploadSlots(principal: SessionPrincipal, orderPublicId: string, tx?: Tx): Promise<FileUploadSlots> {
      const run = async (db: Tx): Promise<FileUploadSlots> => {
        const view = await policy.assertCanReadOrder(principal, orderPublicId, { tx: db });
        const bound = await workflows.byVersionId(db, view.workflowVersionId);
        const actor = requirementActor(view);
        const uploads = findState(bound.definition, view.statusKey)?.requirements?.uploads ?? [];
        if (actor === null || orderLockBlocks(view) || uploads.length === 0) return { statusKey: view.statusKey, slots: [] };
        if (actor !== "customer" && !roleHasCapability(principal.role, "files.manage")) return { statusKey: view.statusKey, slots: [] };
        return {
          statusKey: view.statusKey,
          slots: uploads
            .filter((slot) => slot.uploadedBy.includes(actor))
            .map((slot) => ({ key: slot.key, label: slot.label, kind: slot.kind, maxCount: slot.maxCount, allowedTypes: [...slot.allowedTypes] })),
        };
      };
      return tx ? run(tx) : deps.db.transaction(run);
    },

    /** Files port: refuses writes tied to a status whose phase is locked (order-level locks also win). */
    async assertFileStatusWritable(principal: SessionPrincipal, orderPublicId: string, statusKey: string, tx?: Tx): Promise<void> {
      const run = async (db: Tx) => {
        const view = await policy.assertCanReadOrder(principal, orderPublicId, { tx: db });
        if (orderLockBlocks(view)) throw orderLocked(view.lockState);
        const bound = await workflows.byVersionId(db, view.workflowVersionId);
        if (statusKey === view.statusKey) return;
        const rows = await phaseRows(db, view.id);
        if (lockedPhaseOfStatus(bound.definition, statusKey, rows)) throw phaseLocked();
      };
      return tx ? run(tx) : deps.db.transaction(run);
    },

    /**
     * Files custody port (trusted, no actor filtering): the slot definition from the order's pinned version, or
     * null when the status or slot does not exist. Files checks the staff capability, phase lock and order lock.
     */
    async getFileSlotForCustody(orderPublicId: string, statusKey: string, slotKey: string, tx: Tx): Promise<FileUploadSlot | null> {
      const [row] = await tx.select({ workflowVersionId: orders.workflowVersionId }).from(orders).where(eq(orders.publicId, orderPublicId)).limit(1);
      if (!row) return null;
      const bound = await workflows.byVersionId(tx, row.workflowVersionId);
      const slot = findState(bound.definition, statusKey)?.requirements?.uploads.find((candidate) => candidate.key === slotKey);
      return slot ? { key: slot.key, label: slot.label, kind: slot.kind, maxCount: slot.maxCount, allowedTypes: [...slot.allowedTypes] } : null;
    },

    /** Other modules (intake): is data tied to `statusKey` read-only because its phase is locked? */
    async isStatusPhaseLocked(orderId: number, workflowVersionId: number, statusKey: string, tx: Tx): Promise<boolean> {
      const bound = await workflows.byVersionId(tx, workflowVersionId);
      const rows = await tx.select({ phaseKey: orderPhaseLocks.phaseKey, state: orderPhaseLocks.state }).from(orderPhaseLocks).where(eq(orderPhaseLocks.orderId, orderId));
      return lockedPhaseOfStatus(bound.definition, statusKey, rows);
    },
  };
}

export type RequirementsService = ReturnType<typeof createRequirementsService>;
