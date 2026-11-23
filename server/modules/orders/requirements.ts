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
import { orderAcknowledgements, orderNotes, orderPhaseLocks, orders, orderTaskNotes, orderTaskWaivers } from "./schema.js";
import type { OrderAccessView } from "./types.js";
import type { BoundWorkflow, WorkflowService } from "./workflows.js";
import {
  acknowledgementText,
  documentReplySlotKey,
  findState,
  isCancelState,
  TASK_NOTE_MAX,
  uploadTaskKind,
  type CaptureMode,
  type DocumentResponseMode,
  type DocumentTask,
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
  gates: Pick<OrderGatesService, "assertCustomerMayWork" | "gatesOf" | "agreementFor">;
}

export type PhasePosition = "done" | "current" | "upcoming";
export type ReadOnlyReason = "order_locked" | "phase_locked" | null;

export interface RequirementsView {
  phases: { key: string; label: string; position: PhasePosition; locked: boolean; lockedAt: string | null }[];
  status: { key: string; label: string; phaseKey: string | null };
  uploads: (Omit<UploadRequirement, "hint"> & {
    hint: string | null;
    /** Increment 06 (D8): "record" for audio tasks with capture options. */
    taskKind: "upload" | "record";
    count: number;
    met: boolean;
    canUpload: boolean;
    waived: boolean;
  })[];
  acknowledgements: (AcknowledgementRequirement & {
    textSha256: string;
    met: boolean;
    acceptedAt: string | null;
    canAccept: boolean;
    waived: boolean;
    /** Increment 06 (D8): the per-order note of an `order_note` task (null until staff write it). */
    orderNote: string | null;
    /** Staff may write or change the note (until it is acknowledged). */
    canEditNote: boolean;
  })[];
  /** Increment 06 (D8): respond_document tasks. */
  documents: {
    key: string;
    label: string;
    hint: string | null;
    required: boolean;
    responseModes: DocumentResponseMode[];
    allowedTypes: string[];
    replySlotKey: string;
    sourceCount: number;
    replyCount: number;
    acknowledged: boolean;
    textSha256: string;
    met: boolean;
    waived: boolean;
    canStaffUpload: boolean;
    canReply: boolean;
    canEdit: boolean;
    canAcknowledge: boolean;
  }[];
  /** Increment 06 (D8): staff may waive unmet tasks (`orders.phase.unlock`). */
  canWaive: boolean;
  unmet: number;
  readOnly: boolean;
  readOnlyReason: ReadOnlyReason;
  canUnlock: boolean;
  /** Part B: the customer has an unmet acceptance gate, so their uploads and acknowledgements are paused (display hint; writes re-check). */
  acceptancePending: boolean;
  /** Increment 06 (D14): the signed-in customer still has to accept the order agreement (display hint). */
  agreementPending: { policyPublicId: string; signatureMode: "typed_name" | "checkbox" } | null;
}

export type FileTaskKind = "upload" | "record" | "document_source" | "document_reply";

export interface FileUploadSlot {
  key: string;
  label: string;
  kind: "document" | "audio";
  maxCount: number;
  allowedTypes: string[];
  /** Increment 06 (D8). */
  task: { kind: FileTaskKind; taskKey: string };
  capture?: CaptureMode;
  maxMinutes?: number;
  /** A plain file upload into this slot is allowed (false only for edit-only reply slots). */
  acceptsUpload: boolean;
  /** An edited version (D9 saveEditedVersion) of a file in `sourceSlotKey` may be saved into this slot. */
  acceptsEdit: boolean;
  sourceSlotKey?: string;
}

/** Increment 06 (D8): every file slot of a status (uploads, record tasks, document source + reply). */
interface TaskSlot extends FileUploadSlot {
  minCount: number;
  uploadedBy: WorkflowActor[];
}

/** Files per document slot (staff source or customer reply). */
export const DOCUMENT_SLOT_MAX = 5;

export function taskSlotsOf(req: { uploads: UploadRequirement[]; documents?: DocumentTask[] } | undefined): TaskSlot[] {
  if (!req) return [];
  const slots: TaskSlot[] = req.uploads.map((slot) => ({
    key: slot.key,
    label: slot.label,
    kind: slot.kind,
    minCount: slot.minCount,
    maxCount: slot.maxCount,
    allowedTypes: [...slot.allowedTypes],
    uploadedBy: [...slot.uploadedBy],
    task: { kind: uploadTaskKind(slot), taskKey: slot.key },
    ...(slot.kind === "audio" ? { capture: slot.capture ?? "either" } : {}),
    ...(slot.maxMinutes !== undefined ? { maxMinutes: slot.maxMinutes } : {}),
    acceptsUpload: true,
    acceptsEdit: false,
  }));
  for (const doc of req.documents ?? []) {
    slots.push({
      key: doc.key,
      label: doc.label,
      kind: "document",
      minCount: 0,
      maxCount: DOCUMENT_SLOT_MAX,
      allowedTypes: [...doc.allowedTypes],
      uploadedBy: ["staff", "admin"],
      task: { kind: "document_source", taskKey: doc.key },
      acceptsUpload: true,
      acceptsEdit: false,
    });
    const upload = doc.responseModes.includes("upload_reply");
    const edit = doc.responseModes.includes("edit_in_portal");
    if (upload || edit)
      slots.push({
        key: documentReplySlotKey(doc.key),
        label: `${doc.label} (reply)`.slice(0, 80),
        kind: "document",
        minCount: 0,
        maxCount: DOCUMENT_SLOT_MAX,
        allowedTypes: [...doc.allowedTypes],
        uploadedBy: ["customer"],
        task: { kind: "document_reply", taskKey: doc.key },
        acceptsUpload: upload,
        acceptsEdit: edit,
        sourceSlotKey: doc.key,
      });
  }
  return slots;
}

const toFileSlot = ({ minCount: _min, uploadedBy: _by, ...slot }: TaskSlot): FileUploadSlot => slot;

/** Text a customer acknowledges for a respond_document task (label and hint of the pinned version). */
export function documentAckText(doc: Pick<DocumentTask, "label" | "hint">): string {
  return `${doc.label}\n\n${doc.hint ?? ""}`;
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

const requirementsUnmet = (uploads: string[], acknowledgements: string[], documents: string[]) =>
  new DomainError("VALIDATION", "REQUIREMENTS_UNMET", "Some items are still needed before this order can move on.", { uploads, acknowledgements, documents });

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

  async function uploadCounts(tx: Tx, view: OrderAccessView, statusKey: string, uploads: readonly { key: string }[], strict: boolean) {
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

  /** Increment 06 (D8): waived task keys of one status (insert-only rows). */
  async function waivedKeys(tx: Tx, view: OrderAccessView, statusKey: string): Promise<Set<string>> {
    const rows = await tx
      .select({ taskKey: orderTaskWaivers.taskKey })
      .from(orderTaskWaivers)
      .where(and(eq(orderTaskWaivers.orderId, view.id), eq(orderTaskWaivers.workflowVersionId, view.workflowVersionId), eq(orderTaskWaivers.statusKey, statusKey)));
    return new Set(rows.map((row) => row.taskKey));
  }

  /** Increment 06 (D8): per-order notes of `order_note` acknowledgements, keyed by ack key. */
  async function taskNotes(tx: Tx, view: OrderAccessView, statusKey: string, forUpdate = false) {
    const query = tx
      .select()
      .from(orderTaskNotes)
      .where(and(eq(orderTaskNotes.orderId, view.id), eq(orderTaskNotes.workflowVersionId, view.workflowVersionId), eq(orderTaskNotes.statusKey, statusKey)));
    const rows = await (forUpdate ? query.for("update") : query);
    return new Map(rows.map((row) => [row.ackKey, row]));
  }

  const decryptNote = (row: { publicId: string; bodyEnc: string }) => deps.crypto.decrypt(row.bodyEnc, `order_task_notes.body:${row.publicId}`);

  /** SHA-256 the acceptance must pin; null when an `order_note` task has no note yet (cannot be met). */
  function expectedAckSha(ack: AcknowledgementRequirement, notes: Map<string, { textSha256: string }>): string | null {
    if (ack.source !== "order_note") return sha256Hex(acknowledgementText(ack));
    return notes.get(ack.key)?.textSha256 ?? null;
  }

  /** Unmet requirement keys of the order's current status (inside the caller's tx, after the order lock). */
  async function unmetFor(tx: Tx, view: OrderAccessView, bound: BoundWorkflow) {
    const state = findState(bound.definition, view.statusKey);
    const req = state?.requirements;
    if (!req) return { uploads: [] as string[], acknowledgements: [] as string[], documents: [] as string[] };
    const waived = await waivedKeys(tx, view, view.statusKey);
    const docs = (req.documents ?? []).filter((doc) => doc.required && !waived.has(doc.key));
    const counted = [
      ...req.uploads.filter((slot) => slot.minCount > 0 && !waived.has(slot.key)),
      ...taskSlotsOf({ uploads: [], documents: docs }),
    ];
    const counts = await uploadCounts(tx, view, view.statusKey, counted, true);
    const acks = req.acknowledgements.length || docs.length ? await ackRows(tx, view, view.statusKey) : [];
    const notes = req.acknowledgements.some((ack) => ack.source === "order_note") ? await taskNotes(tx, view, view.statusKey) : new Map();
    return {
      uploads: req.uploads.filter((slot) => slot.minCount > 0 && !waived.has(slot.key) && (counts.get(slot.key) ?? 0) < slot.minCount).map((slot) => slot.key),
      acknowledgements: req.acknowledgements
        .filter((ack) => {
          if (waived.has(ack.key)) return false;
          const expected = expectedAckSha(ack, notes);
          return expected === null || !acks.some((row) => row.ackKey === ack.key && row.side === ack.acceptedBy && row.textSha256 === expected);
        })
        .map((ack) => ack.key),
      documents: docs.filter((doc) => !documentMet(doc, counts, acks)).map((doc) => doc.key),
    };
  }

  /** A respond_document task is met once staff provided the document and the customer replied, edited or acknowledged. */
  function documentMet(doc: DocumentTask, counts: Map<string, number>, acks: { ackKey: string; side: string; textSha256: string }[]): boolean {
    if ((counts.get(doc.key) ?? 0) === 0) return false;
    if ((counts.get(documentReplySlotKey(doc.key)) ?? 0) > 0 && (doc.responseModes.includes("upload_reply") || doc.responseModes.includes("edit_in_portal"))) return true;
    const sha = sha256Hex(documentAckText(doc));
    return doc.responseModes.includes("acknowledge") && acks.some((row) => row.ackKey === doc.key && row.side === "customer" && row.textSha256 === sha);
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
        if (unmet.uploads.length || unmet.acknowledgements.length || unmet.documents.length) throw requirementsUnmet(unmet.uploads, unmet.acknowledgements, unmet.documents);
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
          const req = state?.requirements ?? { uploads: [], acknowledgements: [], documents: [] };
          const docs = req.documents ?? [];
          const counts = await uploadCounts(tx, view, view.statusKey, taskSlotsOf(req), false);
          const acks = req.acknowledgements.length || docs.length ? await ackRows(tx, view, view.statusKey) : [];
          const waived = await waivedKeys(tx, view, view.statusKey);
          const notes = req.acknowledgements.some((ack) => ack.source === "order_note") ? await taskNotes(tx, view, view.statusKey) : new Map<string, typeof orderTaskNotes.$inferSelect>();
          // Display only: any refusal (unmet, provider missing or failing) shows as paused; the write paths enforce.
          let acceptancePending = false;
          let agreementPending: RequirementsView["agreementPending"] = null;
          if (side === "customer") {
            const agreement = await deps.gates.agreementFor({ tx, actor: principal, scope: "workOnOrder" });
            if (agreement.required && !agreement.met) agreementPending = { policyPublicId: agreement.policyPublicId ?? "", signatureMode: agreement.signatureMode };
          }
          if (side === "customer" && deps.gates.gatesOf(definition).length > 0) {
            try {
              await deps.gates.assertCustomerMayWork({ tx, orderId: view.id, actor: principal, action: "acknowledge", statusKey: view.statusKey });
            } catch (error) {
              if (!(error instanceof DomainError && error.reasonCode === "AGREEMENT_REQUIRED")) acceptancePending = true;
            }
          }
          const staffManage = isStaffSide(view) && roleHasCapability(principal.role, "orders.manage") && !orderBlocked;
          const uploads = req.uploads.map(({ hint, ...slot }) => {
            const count = counts.get(slot.key) ?? 0;
            const filesSide = actor !== null && slot.uploadedBy.includes(actor) && !orderBlocked;
            const isWaived = waived.has(slot.key);
            return { ...slot, hint: hint ?? null, taskKind: uploadTaskKind(slot), count, met: isWaived || count >= slot.minCount, canUpload: filesSide && count < slot.maxCount, waived: isWaived };
          });
          const acknowledgements = req.acknowledgements.map((ack) => {
            const note = ack.source === "order_note" ? notes.get(ack.key) : undefined;
            const expected = expectedAckSha(ack, notes);
            const row = acks.find((candidate) => candidate.ackKey === ack.key && candidate.side === ack.acceptedBy && candidate.textSha256 === expected);
            const anyRow = acks.some((candidate) => candidate.ackKey === ack.key && candidate.side === ack.acceptedBy);
            const isWaived = waived.has(ack.key);
            let orderNote: string | null = null;
            if (note) {
              try {
                orderNote = decryptNote(note);
              } catch {
                orderNote = null; // unreadable ⇒ shown as missing; acceptance is refused on write (hash check)
              }
            }
            return {
              ...ack,
              textSha256: expected ?? "",
              met: isWaived || row !== undefined,
              acceptedAt: row ? row.acceptedAt.toISOString() : null,
              canAccept: row === undefined && !isWaived && expected !== null && (ack.source !== "order_note" || orderNote !== null) && canWriteAny && side === ack.acceptedBy,
              waived: isWaived,
              orderNote,
              canEditNote: ack.source === "order_note" && staffManage && !anyRow,
            };
          });
          const documents = docs.map((doc) => {
            const replySlotKey = documentReplySlotKey(doc.key);
            const sourceCount = counts.get(doc.key) ?? 0;
            const replyCount = counts.get(replySlotKey) ?? 0;
            const textSha256 = sha256Hex(documentAckText(doc));
            const acknowledged = acks.some((row) => row.ackKey === doc.key && row.side === "customer" && row.textSha256 === textSha256);
            const isWaived = waived.has(doc.key);
            const customerWrites = side === "customer" && !orderBlocked && sourceCount > 0;
            return {
              key: doc.key,
              label: doc.label,
              hint: doc.hint ?? null,
              required: doc.required,
              responseModes: [...doc.responseModes],
              allowedTypes: [...doc.allowedTypes],
              replySlotKey,
              sourceCount,
              replyCount,
              acknowledged,
              textSha256,
              met: isWaived || !doc.required || documentMet(doc, counts, acks),
              waived: isWaived,
              canStaffUpload: isStaffSide(view) && roleHasCapability(principal.role, "files.manage") && !orderBlocked && sourceCount < DOCUMENT_SLOT_MAX,
              canReply: customerWrites && doc.responseModes.includes("upload_reply") && replyCount < DOCUMENT_SLOT_MAX,
              canEdit: customerWrites && doc.responseModes.includes("edit_in_portal") && replyCount < DOCUMENT_SLOT_MAX,
              canAcknowledge: customerWrites && doc.responseModes.includes("acknowledge") && !acknowledged,
            };
          });
          const unmet =
            uploads.filter((slot) => !slot.met).length + acknowledgements.filter((ack) => !ack.met).length + documents.filter((doc) => doc.required && !doc.met).length;
          return {
            phases: phaseView,
            status: { key: view.statusKey, label: isStaffSide(view) ? (state?.label ?? view.statusKey) : (state?.customerLabel ?? view.statusKey), phaseKey: currentPhase },
            uploads,
            acknowledgements,
            documents,
            unmet,
            readOnly: orderBlocked || actor === null,
            readOnlyReason,
            canUnlock: isStaffSide(view) && roleHasCapability(principal.role, "orders.phase.unlock") && phaseView.some((phase) => phase.locked),
            canWaive: isStaffSide(view) && roleHasCapability(principal.role, "orders.phase.unlock") && view.lockState !== "legal_hold" && view.lockState !== "imported_read_only",
            acceptancePending,
            agreementPending,
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
        const req = findState(bound.definition, view.statusKey)?.requirements;
        const ack = req?.acknowledgements.find((candidate) => candidate.key === input.ackKey);
        // D8: a respond_document task answered by acknowledging the staff document (customer side only).
        const doc = ack ? undefined : req?.documents?.find((candidate) => candidate.key === input.ackKey && candidate.responseModes.includes("acknowledge"));
        if (!ack && !doc) throw validation("ACK_NOT_FOUND", "This acknowledgement is not part of the current step.");
        const acceptedBy: AckSide = ack ? ack.acceptedBy : "customer";
        if (acceptedBy !== side) throw forbidden("ACK_WRONG_SIDE");
        let textSha256: string;
        if (ack && ack.source === "order_note") {
          const note = (await taskNotes(tx, view, view.statusKey, true)).get(ack.key);
          if (!note) throw conflict("ACK_NOTE_MISSING", "Our team has not written this note yet. Please check back later.");
          textSha256 = note.textSha256;
        } else if (ack) {
          textSha256 = sha256Hex(acknowledgementText(ack));
        } else {
          const counts = await uploadCounts(tx, view, view.statusKey, [{ key: doc!.key }], true);
          if ((counts.get(doc!.key) ?? 0) === 0) throw conflict("DOCUMENT_NOT_READY", "Our team has not shared this document yet. Please check back later.");
          textSha256 = sha256Hex(documentAckText(doc!));
        }
        if (input.textSha256 !== textSha256) throw conflict("ACK_TEXT_CHANGED", "The text has changed since you opened it. Please read it again.");
        const requireTypedName = ack?.requireTypedName ?? false;
        const typedName = input.typedName?.normalize("NFC").trim() ?? "";
        if (requireTypedName && typedName.length < 2) throw validation("TYPED_NAME_REQUIRED", "Please type your full name to confirm.");
        const ackKey = ack ? ack.key : doc!.key;
        const [existing] = await tx
          .select({ id: orderAcknowledgements.id })
          .from(orderAcknowledgements)
          .where(
            and(
              eq(orderAcknowledgements.orderId, view.id),
              eq(orderAcknowledgements.workflowVersionId, view.workflowVersionId),
              eq(orderAcknowledgements.statusKey, view.statusKey),
              eq(orderAcknowledgements.ackKey, ackKey),
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
          ackKey,
          acceptorSide: side,
          textSha256,
          userId: principal.userId,
          userRole: principal.role,
          sessionId: principal.sessionId.slice(0, 64),
          typedNameEnc: requireTypedName ? deps.crypto.encrypt(typedName.slice(0, 120), `order_acknowledgements.typed_name:${publicId}`) : null,
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
              ack_key: ackKey,
              task_kind: ack ? (ack.source === "order_note" ? "order_note" : "acknowledge") : "respond_document",
              text_sha256: textSha256,
              workflow_version: bound.versionNumber,
              acceptor_side: side,
              typed_name_present: requireTypedName,
            },
          },
          tx,
        );
        return { acknowledgementId: publicId, acceptedAt: now.toISOString() };
      });
      return result;
    },

    /**
     * Increment 06 (D8): staff write (or change) the per-order note of an `order_note` acknowledgement task of any
     * status of the pinned version. Refused once the customer has acknowledged it (the record pins the text).
     */
    async setTaskNote(principal: SessionPrincipal, input: { orderId: string; statusKey: string; ackKey: string; body: string; expectedVersion?: number }) {
      const body = input.body.normalize("NFC").replace(/\r\n?/g, "\n").trim();
      if (body.length < 1 || body.length > TASK_NOTE_MAX) throw validation("TASK_NOTE_LENGTH", `Write a note of 1 to ${TASK_NOTE_MAX} characters.`, { field: "body" });
      if (/<\s*[a-z!/?]/i.test(body)) throw validation("TASK_NOTE_MARKUP", "Use plain text without markup.", { field: "body" });
      return deps.db.transaction(async (tx) => {
        const view = await policy.assertCanReadOrder(principal, input.orderId, { tx, forUpdate: true });
        if (!isStaffSide(view)) throw ORDER_NOT_FOUND();
        if (!roleHasCapability(principal.role, "orders.manage")) throw forbidden("CAPABILITY_NOT_GRANTED");
        await deps.actorCheck(principal, tx, "orders.manage");
        if (orderLockBlocks(view)) throw orderLocked(view.lockState);
        const bound = await workflows.byVersionId(tx, view.workflowVersionId);
        const ack = findState(bound.definition, input.statusKey)?.requirements?.acknowledgements.find((candidate) => candidate.key === input.ackKey);
        if (!ack || ack.source !== "order_note") throw validation("TASK_NOT_FOUND", "This order has no note task with that name in that status.");
        const rows = await phaseRows(tx, view.id);
        if (input.statusKey !== view.statusKey && lockedPhaseOfStatus(bound.definition, input.statusKey, rows)) throw phaseLocked();
        const existingNote = (await taskNotes(tx, view, input.statusKey, true)).get(ack.key);
        const [accepted] = await tx
          .select({ id: orderAcknowledgements.id })
          .from(orderAcknowledgements)
          .where(
            and(
              eq(orderAcknowledgements.orderId, view.id),
              eq(orderAcknowledgements.workflowVersionId, view.workflowVersionId),
              eq(orderAcknowledgements.statusKey, input.statusKey),
              eq(orderAcknowledgements.ackKey, ack.key),
            ),
          )
          .limit(1);
        if (accepted) throw conflict("TASK_NOTE_ACKNOWLEDGED", "The customer has already acknowledged this note, so it can no longer change.");
        if (existingNote && input.expectedVersion !== undefined && existingNote.version !== input.expectedVersion)
          throw conflict("STALE_VERSION", "Someone else changed this note. Reload to see the latest text.");
        const now = deps.clock.now();
        const textSha256 = sha256Hex(acknowledgementText(ack, body));
        let publicId: string;
        let version: number;
        if (existingNote) {
          publicId = existingNote.publicId;
          version = existingNote.version + 1;
          await tx
            .update(orderTaskNotes)
            .set({ bodyEnc: deps.crypto.encrypt(body, `order_task_notes.body:${publicId}`), textSha256, authorUserId: principal.userId, version, updatedAt: now })
            .where(eq(orderTaskNotes.id, existingNote.id));
        } else {
          publicId = ulid(now.getTime());
          version = 1;
          await tx.insert(orderTaskNotes).values({
            publicId,
            orderId: view.id,
            workflowVersionId: view.workflowVersionId,
            statusKey: input.statusKey,
            ackKey: ack.key,
            bodyEnc: deps.crypto.encrypt(body, `order_task_notes.body:${publicId}`),
            textSha256,
            authorUserId: principal.userId,
            createdAt: now,
            updatedAt: now,
          });
        }
        await deps.audit.record(
          {
            category: "business",
            eventName: "order.task_note.saved",
            action: existingNote ? "update" : "create",
            outcome: "completed",
            actor: actorOf(principal),
            resource: { type: "order", publicId: view.publicId },
            attributes: { task_note_public_id: publicId, status_key: input.statusKey, ack_key: ack.key, text_sha256: textSha256, note_version: version },
          },
          tx,
        );
        return { notePublicId: publicId, version, textSha256 };
      });
    },

    /**
     * Increment 06 (D8): staff waive one customer task of a status (insert-only; counts as met). Needs
     * `orders.phase.unlock`; the reason is kept as a staff-only encrypted order note. Audited.
     */
    async waiveTask(principal: SessionPrincipal, input: { orderId: string; statusKey: string; taskKey: string; reason: string }) {
      const reason = input.reason.normalize("NFC").trim();
      if (reason.length < 10 || reason.length > 500) throw validation("WAIVE_REASON_LENGTH", "Give a reason of 10 to 500 characters.", { field: "reason" });
      return deps.db.transaction(async (tx) => {
        const view = await policy.assertCanReadOrder(principal, input.orderId, { tx, forUpdate: true });
        if (!isStaffSide(view)) throw ORDER_NOT_FOUND();
        if (!roleHasCapability(principal.role, "orders.phase.unlock")) throw forbidden("CAPABILITY_NOT_GRANTED");
        await deps.actorCheck(principal, tx, "orders.phase.unlock");
        if (view.lockState === "legal_hold" || view.lockState === "imported_read_only") throw orderLocked(view.lockState);
        const bound = await workflows.byVersionId(tx, view.workflowVersionId);
        const req = findState(bound.definition, input.statusKey)?.requirements;
        const upload = req?.uploads.find((slot) => slot.key === input.taskKey);
        const kind: (typeof orderTaskWaivers.$inferInsert)["taskKind"] | null = upload
          ? uploadTaskKind(upload)
          : req?.acknowledgements.some((ack) => ack.key === input.taskKey)
            ? "acknowledge"
            : req?.documents?.some((doc) => doc.key === input.taskKey)
              ? "respond_document"
              : null;
        if (!kind) throw validation("TASK_NOT_FOUND", "This order has no task with that name in that status.");
        const [already] = await tx
          .select({ id: orderTaskWaivers.id })
          .from(orderTaskWaivers)
          .where(
            and(
              eq(orderTaskWaivers.orderId, view.id),
              eq(orderTaskWaivers.workflowVersionId, view.workflowVersionId),
              eq(orderTaskWaivers.statusKey, input.statusKey),
              eq(orderTaskWaivers.taskKey, input.taskKey),
            ),
          )
          .limit(1);
        if (already) throw conflict("TASK_ALREADY_WAIVED", "This task has already been waived.");
        const now = deps.clock.now();
        const notePublicId = ulid(now.getTime());
        await tx.insert(orderNotes).values({
          publicId: notePublicId,
          orderId: view.id,
          authorUserId: principal.userId,
          authorRole: principal.role,
          visibility: "internal",
          bodyEnc: deps.crypto.encrypt(`Task waived (${input.statusKey} / ${input.taskKey}): ${reason}`, `order_notes.body:${notePublicId}`),
          createdAt: now,
        });
        const publicId = ulid(now.getTime());
        await tx.insert(orderTaskWaivers).values({
          publicId,
          orderId: view.id,
          workflowVersionId: view.workflowVersionId,
          statusKey: input.statusKey,
          taskKey: input.taskKey,
          taskKind: kind,
          reasonNotePublicId: notePublicId,
          waivedByUserId: principal.userId,
          waivedAt: now,
        });
        await deps.audit.record(
          {
            category: "business",
            eventName: "order.task.waived",
            action: "update",
            outcome: "completed",
            actor: actorOf(principal),
            resource: { type: "order", publicId: view.publicId },
            attributes: { waiver_public_id: publicId, status_key: input.statusKey, task_key: input.taskKey, task_kind: kind, note_public_id: notePublicId },
          },
          tx,
        );
        return { waiverId: publicId, waivedAt: now.toISOString() };
      });
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
        const slots = taskSlotsOf(findState(bound.definition, view.statusKey)?.requirements);
        if (actor === null || orderLockBlocks(view) || slots.length === 0) return { statusKey: view.statusKey, slots: [] };
        if (actor !== "customer" && !roleHasCapability(principal.role, "files.manage")) return { statusKey: view.statusKey, slots: [] };
        return { statusKey: view.statusKey, slots: slots.filter((slot) => slot.uploadedBy.includes(actor)).map(toFileSlot) };
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
      const slot = taskSlotsOf(findState(bound.definition, statusKey)?.requirements).find((candidate) => candidate.key === slotKey);
      return slot ? toFileSlot(slot) : null;
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
