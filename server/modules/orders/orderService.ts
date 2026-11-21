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
import { orderGrants, orderLineItems, orderLockHistory, orderNotes, orderReassignments, orderReferences, orders, orderStatusHistory } from "./schema.js";
import { ORDER_NOT_FOUND, orderLocked, type OrderPolicy } from "./policy.js";
import { compliancePort, engagementPort, filesPort, identityPort } from "./ports.js";
import { allocateReference, normalizeReference, reserveReference } from "./references.js";
import { ORDER_NOTIFY_MAIL, ORDER_REFERENCE_PREFIX } from "./settings.js";
import type { OrderAccessRole, OrderAccessView, OrderLockState, OrderProductionScope, OrderQuote, OrderSummary, NoteVisibility } from "./types.js";
import type { PacketTier } from "./schema.js";
import { priceOrder } from "./pricing.js";
import type { BoundWorkflow, WorkflowService } from "./workflows.js";
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
}

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
   * Authorization and projection read from ONE consistent snapshot (O-02): a transfer or grant revoke that
   * commits after the snapshot is invisible to both, so a former owner/grantee can never see post-revocation
   * data. No row locks. (Not `accessMode: "read only"`: Drizzle renders it with the snapshot clause as invalid
   * MySQL — "WITH CONSISTENT SNAPSHOT READ ONLY" lacks the required comma.)
   */
  const snapshot = <T>(fn: (tx: Tx) => Promise<T>) =>
    deps.db.transaction(fn, { isolationLevel: "repeatable read", withConsistentSnapshot: true });

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
    for (const row of rows) {
      const status = await statusPresentation(row.workflowVersionId, row.statusKey);
      const staffSide = principal.role !== "customer";
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
        return await deps.db.transaction(async (tx) => {
          // No existing order row is locked here, so the actor check is the first statement.
          const actor = await assertActorCurrent(principal, tx, "orders.create");
          if (input.onBehalfOfCustomerPublicId && !roleHasCapability(actor.role, "orders.manage")) throw forbidden("ACTOR_NOT_AUTHORIZED");
          const now = deps.clock.now();
          const workflow = await workflows.ensureDefault(tx);
          const lineItems = await deps.catalog.resolveForOrder(tx, input.items);
          const currency = lineItems[0]!.currency;
          const pricing = priceOrder(lineItems, await deps.catalog.getBundleRule(tx));
          const totalMinor = pricing.totalMinor;
          const reference = await allocateReference(tx, prefix, now);
          const publicId = ulid(now.getTime());
          const initial = initialState(workflow.definition);
          await tx.insert(orders).values({
            publicId,
            reference,
            ownerUserId,
            projectName: input.projectName,
            workflowVersionId: workflow.versionId,
            statusKey: initial.key,
            subtotalMinor: pricing.subtotalMinor,
            discountMinor: pricing.discountMinor,
            discountLabel: pricing.discountLabel,
            totalMinor,
            currency,
            origin: "portal",
            createdByUserId: principal.userId,
            createKey: input.idempotencyKey,
            submittedAt: now,
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
          await reserveReference(tx, { reference, orderId, reasonCode: "GENERATED", actorUserId: principal.userId, now });
          const note = input.note ? await insertNote(tx, { orderId, principal, visibility: "customer", body: input.note }) : null;
          await tx.insert(orderStatusHistory).values({
            publicId: ulid(now.getTime()),
            orderId,
            fromStatus: null,
            toStatus: initial.key,
            actorUserId: principal.userId,
            actorRole: principal.role,
            reasonCode: "CREATED",
            noteId: note?.id ?? null,
            occurredAt: now,
          });
          await deps.audit.record(
            {
              category: "business",
              eventName: "order.created",
              action: "create",
              outcome: "completed",
              actor: actorOf(principal),
              resource: { type: "order", publicId },
              attributes: { currency, total_minor: totalMinor, discount_minor: pricing.discountMinor, on_behalf: ownerUserId !== principal.userId, workflow_version: workflow.versionNumber },
              safeCounts: { line_items: lineItems.length, packet_items: lineItems.filter((item) => item.packetNumber !== null).length },
            },
            tx,
          );
          await emitChange(tx, { orderId, orderPublicId: publicId, kind: "created" });
          return { publicId, reference, created: true };
        });
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
      input: { cursor?: string; limit?: number; status?: string; customerPublicId?: string; from?: Date; to?: Date; referencePrefix?: string; lockState?: OrderLockState },
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
      const transitions = canTransition && actor ? transitionsFrom(bound.definition, order.statusKey, actor) : [];
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
            requiresNote: t.requiresNote,
          };
        }),
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
    async quote(principal: SessionPrincipal, input: { items: { productPublicId: string; quantity: number }[] }): Promise<OrderQuote> {
      if (principal.state !== "full") throw ORDER_NOT_FOUND();
      return snapshot(async (tx) => {
        const lineItems = await deps.catalog.resolveForOrder(tx, input.items);
        const pricing = priceOrder(lineItems, await deps.catalog.getBundleRule(tx));
        return {
          currency: lineItems[0]!.currency,
          subtotalMinor: pricing.subtotalMinor,
          discountMinor: pricing.discountMinor,
          discountLabel: pricing.discountLabel,
          totalMinor: pricing.totalMinor,
          bundle: pricing.bundle,
        };
      });
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
        .select({ id: orders.id, publicId: orders.publicId, reference: orders.reference, ownerUserId: orders.ownerUserId, lockState: orders.lockState, statusKey: orders.statusKey })
        .from(orders)
        .where(eq(orders.publicId, orderPublicId))
        .limit(1);
      const [row] = options.forUpdate ? await query.for("update") : await query;
      return row ?? null;
    },

    async getOrderRefById(orderId: number, tx?: DbOrTx, options: { forUpdate?: boolean } = {}) {
      if (options.forUpdate && !tx) throw new DomainError("VALIDATION", "TX_REQUIRED", "A row lock requires a transaction.");
      const query = (tx ?? deps.db)
        .select({ id: orders.id, publicId: orders.publicId, reference: orders.reference, ownerUserId: orders.ownerUserId, lockState: orders.lockState, statusKey: orders.statusKey })
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
