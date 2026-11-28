import { randomInt } from "node:crypto";
import { and, asc, count, desc, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import { roleHasCapability } from "../../../shared/capabilities.js";
import type { UserRole } from "../../../shared/domain.js";
import type { ModuleDeps } from "../../container.js";
import { conflict, DomainError, forbidden, notFound, validation } from "../../core/errors.js";
import { ULID_PATTERN, ulid } from "../../core/ids.js";
import type { DbOrTx, SessionPrincipal } from "../../core/types.js";
import { isLiveUserRow, liveUserPredicate } from "../identity/live.js";
import { users } from "../identity/schema.js";
import { readSetting } from "../platform/index.js";
import { buildCanonicalPortalUrl, MAIL_TICKET_UPDATED } from "./mail.js";
import type { NotificationsService } from "./notificationsService.js";
import { assertCurrentActorInTx, getIdentityPeer, getOrdersPeer } from "./peers.js";
import {
  engagementSearchTokens,
  engagementSupportTicketHistory,
  engagementSupportTicketMessages,
  engagementSupportTickets,
} from "./schema.js";
import { ENGAGEMENT_TICKETS_REOPEN_WINDOW_DAYS } from "./settings.js";
import { computeSearchTokenHashes, decodeIdCursor, encodeIdCursor, normalizePlainText } from "./textAndSearch.js";
import { isLiveTicketRowInTx, liveTicketPredicate } from "./trashGate.js";
import type { TicketCategory, TicketPriority, TicketStatus } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const TICKET_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export interface TicketSummaryView {
  publicId: string;
  ticketNumber: string;
  subject: string;
  category: TicketCategory;
  status: TicketStatus;
  priority: TicketPriority;
  relatedOrderPublicId: string | null;
  relatedOrderReference: string | null;
  requesterUserPublicId: string;
  assigneeUserPublicId: string | null;
  lastMessageAt: Date;
  resolvedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TicketReplyView {
  publicId: string;
  authorUserPublicId: string;
  authorRole: UserRole;
  authorDisplayLabel: string;
  isOwnMessage: boolean;
  internalOnly: boolean;
  body: string;
  createdAt: Date;
}

export interface TicketHistoryView {
  publicId: string;
  fromStatus: TicketStatus | null;
  toStatus: TicketStatus;
  actorRole: string;
  reasonCode: string | null;
  occurredAt: Date;
}

export interface TicketDetailView {
  ticket: TicketSummaryView;
  replies: TicketReplyView[];
  repliesNextCursor: string | null;
  statusHistory: TicketHistoryView[];
  statusHistoryHasMore: boolean;
  canReply: boolean;
  canReopen: boolean;
  canClose: boolean;
}

function assertFullSession(principal: SessionPrincipal): void {
  if (principal.state !== "full" || principal.pendingSteps.length > 0) {
    throw new DomainError(
      "REMEDIATION_REQUIRED",
      "ACCOUNT_STEP_PENDING",
      "Please finish securing your account to continue.",
    );
  }
}

export function generateTicketNumber(now: Date): string {
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  let suffix = "";
  for (let i = 0; i < 6; i += 1) {
    suffix += TICKET_ALPHABET[randomInt(TICKET_ALPHABET.length)];
  }
  return `TK-${yyyy}${mm}${dd}-${suffix}`;
}

export function createTicketsService(deps: ModuleDeps, notifications: NotificationsService) {
  const { db, clock, crypto, audit, mailer, settings, config } = deps;

  function toSummaryView(row: typeof engagementSupportTickets.$inferSelect, hideAssigneeForCustomer: boolean): TicketSummaryView {
    return {
      publicId: row.publicId,
      ticketNumber: row.ticketNumber,
      subject: crypto.decrypt(row.subjectEnc, `engagement_support_tickets.subject:${row.publicId}`),
      category: row.category,
      status: row.status,
      priority: row.priority,
      relatedOrderPublicId: row.relatedOrderPublicId,
      relatedOrderReference: row.relatedOrderReference,
      requesterUserPublicId: row.requesterUserPublicId,
      assigneeUserPublicId: hideAssigneeForCustomer ? null : row.assigneeUserPublicId,
      lastMessageAt: row.lastMessageAt,
      resolvedAt: row.resolvedAt,
      closedAt: row.closedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async function allocateUniqueTicketNumber(handle: DbOrTx, now: Date): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = generateTicketNumber(now);
      const [clash] = await handle
        .select({ id: engagementSupportTickets.id })
        .from(engagementSupportTickets)
        .where(eq(engagementSupportTickets.ticketNumber, candidate))
        .limit(1);
      if (!clash) return candidate;
    }
    throw conflict("TICKET_NUMBER_COLLISION", "Could not allocate a unique ticket reference. Please try again.");
  }

  async function resolveAuthorLabels(
    principal: SessionPrincipal,
    rows: readonly { authorUserId: number; authorRole: UserRole }[],
  ): Promise<Map<number, string>> {
    const identity = getIdentityPeer(deps);
    const labels = new Map<number, string>();
    const isStaffViewer = principal.role === "staff" || principal.role === "admin";
    for (const userId of new Set(rows.map((r) => r.authorUserId))) {
      if (userId === principal.userId) {
        labels.set(userId, "You");
        continue;
      }
      const user = identity.getUser ? await identity.getUser(userId) : null;
      if (user) {
        labels.set(
          userId,
          user.role === "customer" ? user.name : isStaffViewer ? `${user.name} (Support)` : "ReadyPackets Support",
        );
      } else {
        const sample = rows.find((r) => r.authorUserId === userId);
        labels.set(userId, sample?.authorRole === "customer" ? "Deleted account" : "ReadyPackets Support");
      }
    }
    return labels;
  }

  const MAX_HISTORY_ITEMS = 100;

  async function buildDetailView(
    principal: SessionPrincipal,
    ticketRow: typeof engagementSupportTickets.$inferSelect,
    staffView: boolean,
    options: { replyCursor?: string; replyLimit?: number } = {},
  ): Promise<TicketDetailView> {
    const replyLimit = Math.min(Math.max(options.replyLimit ?? 50, 1), 100);
    const afterReplyId = decodeIdCursor(options.replyCursor);

    const [replyRows, historyRows] = await Promise.all([
      db
        .select()
        .from(engagementSupportTicketMessages)
        .where(
          and(
            eq(engagementSupportTicketMessages.ticketId, ticketRow.id),
            staffView ? undefined : eq(engagementSupportTicketMessages.internalOnly, false),
            afterReplyId !== undefined ? gt(engagementSupportTicketMessages.id, afterReplyId) : undefined,
          ),
        )
        .orderBy(asc(engagementSupportTicketMessages.id))
        .limit(replyLimit + 1),
      db
        .select()
        .from(engagementSupportTicketHistory)
        .where(eq(engagementSupportTicketHistory.ticketId, ticketRow.id))
        .orderBy(desc(engagementSupportTicketHistory.id))
        .limit(MAX_HISTORY_ITEMS + 1),
    ]);

    const replySlice = replyRows.slice(0, replyLimit);
    const repliesNextCursor =
      replyRows.length > replyLimit ? encodeIdCursor(replySlice[replySlice.length - 1]!.id) : null;

    const statusHistoryHasMore = historyRows.length > MAX_HISTORY_ITEMS;
    const historySlice = historyRows.slice(0, MAX_HISTORY_ITEMS).reverse();

    const authorLabels = await resolveAuthorLabels(principal, replySlice);
    const reopenWindowDays = await readSetting(settings, ENGAGEMENT_TICKETS_REOPEN_WINDOW_DAYS);
    const now = clock.now();
    const withinReopenWindow =
      ticketRow.status === "resolved" &&
      ticketRow.resolvedAt !== null &&
      now.getTime() - ticketRow.resolvedAt.getTime() <= reopenWindowDays * DAY_MS;

    return {
      ticket: toSummaryView(ticketRow, !staffView),
      replies: replySlice.map((r) => ({
        publicId: r.publicId,
        authorUserPublicId: r.authorUserPublicId,
        authorRole: r.authorRole,
        authorDisplayLabel: authorLabels.get(r.authorUserId) ?? "Participant",
        isOwnMessage: r.authorUserId === principal.userId,
        internalOnly: r.internalOnly,
        body: crypto.decrypt(r.bodyEnc, `engagement_support_ticket_messages.body:${r.publicId}`),
        createdAt: r.createdAt,
      })),
      repliesNextCursor,
      statusHistory: historySlice.map((h) => ({
        publicId: h.publicId,
        fromStatus: h.fromStatus,
        toStatus: h.toStatus,
        actorRole: h.actorRole,
        reasonCode: h.reasonCode,
        occurredAt: h.occurredAt,
      })),
      statusHistoryHasMore,
      canReply: staffView
        ? roleHasCapability(principal.role, "tickets.manage")
        : ticketRow.status !== "closed" && (ticketRow.status !== "resolved" || withinReopenWindow),
      canReopen: !staffView && withinReopenWindow,
      canClose: !staffView ? ticketRow.status !== "closed" : roleHasCapability(principal.role, "tickets.manage"),
    };
  }

  async function list(
    principal: SessionPrincipal,
    input: { status?: TicketStatus; cursor?: string; limit?: number } = {},
  ): Promise<{ items: TicketSummaryView[]; nextCursor: string | null }> {
    assertFullSession(principal);
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
    const beforeId = decodeIdCursor(input.cursor);

    const rows = await db
      .select()
      .from(engagementSupportTickets)
      .where(
        and(
          eq(engagementSupportTickets.requesterUserId, principal.userId),
          liveTicketPredicate(),
          input.status !== undefined ? eq(engagementSupportTickets.status, input.status) : undefined,
          beforeId !== undefined ? lt(engagementSupportTickets.id, beforeId) : undefined,
        ),
      )
      .orderBy(desc(engagementSupportTickets.id))
      .limit(limit + 1);

    const slice = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? encodeIdCursor(slice[slice.length - 1]!.id) : null;
    return {
      items: slice.map((row) => toSummaryView(row, true)),
      nextCursor,
    };
  }

  async function openSummary(
    principal: SessionPrincipal,
  ): Promise<{ openCount: number; awaitingCustomerCount: number }> {
    assertFullSession(principal);
    const liveGate = liveTicketPredicate();
    const [openRow, awaitingRow] = await Promise.all([
      db
        .select({ total: count(engagementSupportTickets.id) })
        .from(engagementSupportTickets)
        .where(
          and(
            eq(engagementSupportTickets.requesterUserId, principal.userId),
            liveGate,
            inArray(engagementSupportTickets.status, ["open", "pending_customer", "pending_staff"]),
          ),
        ),
      db
        .select({ total: count(engagementSupportTickets.id) })
        .from(engagementSupportTickets)
        .where(
          and(
            eq(engagementSupportTickets.requesterUserId, principal.userId),
            liveGate,
            eq(engagementSupportTickets.status, "pending_customer"),
          ),
        ),
    ]);
    return {
      openCount: Number(openRow[0]?.total ?? 0),
      awaitingCustomerCount: Number(awaitingRow[0]?.total ?? 0),
    };
  }

  async function findCustomerOwnedTicketOrThrow(
    principal: SessionPrincipal,
    ticketPublicId: string,
  ): Promise<typeof engagementSupportTickets.$inferSelect> {
    if (!ULID_PATTERN.test(ticketPublicId)) {
      throw notFound("TICKET_NOT_FOUND");
    }
    const [row] = await db
      .select()
      .from(engagementSupportTickets)
      .where(eq(engagementSupportTickets.publicId, ticketPublicId))
      .limit(1);

    if (!row) {
      throw notFound("TICKET_NOT_FOUND");
    }
    if (row.requesterUserId !== principal.userId) {
      await audit.record({
        category: "security",
        eventName: "authz.engagement.denied",
        action: "authorize",
        outcome: "denied",
        severity: "WARN",
        reasonCode: "CROSS_TENANT_TICKET",
        actor: { userId: principal.userId, role: principal.role },
        resource: { type: "ticket", publicId: ticketPublicId },
      });
      throw notFound("TICKET_NOT_FOUND");
    }
    if (!(await isLiveTicketRowInTx(db, row))) {
      throw notFound("TICKET_NOT_FOUND");
    }
    return row;
  }

  async function get(
    principal: SessionPrincipal,
    ticketPublicId: string,
    options?: { replyCursor?: string; replyLimit?: number },
  ): Promise<TicketDetailView> {
    assertFullSession(principal);
    const row = await findCustomerOwnedTicketOrThrow(principal, ticketPublicId);
    return buildDetailView(principal, row, false, options);
  }

  async function create(
    principal: SessionPrincipal,
    input: {
      subject: string;
      category: TicketCategory;
      body: string;
      relatedOrderId?: string | null;
      idempotencyKey: string;
    },
  ): Promise<TicketDetailView> {
    assertFullSession(principal);
    const subject = normalizePlainText(input.subject, {
      min: 5,
      max: 190,
      field: "subject",
      label: "ticket subject",
      singleLine: true,
    });
    const body = normalizePlainText(input.body, {
      min: 10,
      max: 8000,
      field: "body",
      label: "ticket description",
    });
    const idempotencyKey = normalizePlainText(input.idempotencyKey, {
      min: 1,
      max: 128,
      field: "idempotencyKey",
      label: "idempotency key",
      singleLine: true,
    });

    let precheckedOrder: { id: number; publicId: string; reference: string } | null = null;
    if (input.relatedOrderId !== undefined && input.relatedOrderId !== null && input.relatedOrderId !== "") {
      const orders = getOrdersPeer(deps);
      const orderAccess = await orders.assertCanReadOrder(principal, input.relatedOrderId);
      precheckedOrder = {
        id: orderAccess.id,
        publicId: orderAccess.publicId,
        reference: orderAccess.reference,
      };
    }

    const tokenHashes = computeSearchTokenHashes(crypto, [subject, body]);

    const committedTicket = await db.transaction(async (tx) => {
      await assertCurrentActorInTx(deps, principal, tx);

      if (precheckedOrder) {
        const orders = getOrdersPeer(deps);
        const verifiedOrder = await orders.assertCanReadOrder(principal, precheckedOrder.publicId, { tx });
        precheckedOrder = {
          id: verifiedOrder.id,
          publicId: verifiedOrder.publicId,
          reference: verifiedOrder.reference,
        };
      }

      const [existing] = await tx
        .select()
        .from(engagementSupportTickets)
        .where(
          and(
            eq(engagementSupportTickets.requesterUserId, principal.userId),
            eq(engagementSupportTickets.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      if (existing) {
        return existing;
      }

      const now = clock.now();
      const ticketPublicId = ulid(now.getTime());
      const ticketNumber = await allocateUniqueTicketNumber(tx, now);
      const subjectEnc = crypto.encrypt(subject, `engagement_support_tickets.subject:${ticketPublicId}`);

      const [ticketHeader] = await tx.insert(engagementSupportTickets).values({
        publicId: ticketPublicId,
        ticketNumber,
        requesterUserId: principal.userId,
        requesterUserPublicId: principal.userPublicId,
        relatedOrderId: precheckedOrder?.id ?? null,
        relatedOrderPublicId: precheckedOrder?.publicId ?? null,
        relatedOrderReference: precheckedOrder ? precheckedOrder.reference.trim().toUpperCase() : null,
        assigneeUserId: null,
        assigneeUserPublicId: null,
        category: input.category,
        status: "open",
        priority: "normal",
        subjectEnc,
        idempotencyKey,
        origin: "portal",
        lastMessageAt: now,
        resolvedAt: null,
        closedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      const ticketId = Number(ticketHeader.insertId);

      const messagePublicId = ulid(now.getTime());
      await tx.insert(engagementSupportTicketMessages).values({
        publicId: messagePublicId,
        ticketId,
        authorUserId: principal.userId,
        authorUserPublicId: principal.userPublicId,
        authorRole: principal.role,
        internalOnly: false,
        bodyEnc: crypto.encrypt(body, `engagement_support_ticket_messages.body:${messagePublicId}`),
        idempotencyKey,
        createdAt: now,
      });

      await tx.insert(engagementSupportTicketHistory).values({
        publicId: ulid(now.getTime()),
        ticketId,
        actorUserId: principal.userId,
        actorRole: principal.role,
        fromStatus: null,
        toStatus: "open",
        reasonCode: "TICKET_CREATED",
        occurredAt: now,
      });

      if (tokenHashes.length > 0) {
        await tx.insert(engagementSearchTokens).values(
          tokenHashes.map((tokenHash) => ({
            domain: "ticket" as const,
            recordId: ticketId,
            customerVisible: true,
            tokenHash,
          })),
        );
      }

      await audit.record(
        {
          category: "business",
          eventName: "engagement.ticket.created",
          action: "create",
          outcome: "completed",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "ticket", publicId: ticketPublicId },
          attributes: {
            ticket_number: ticketNumber,
            category: input.category,
            has_related_order: precheckedOrder !== null,
          },
        },
        tx,
      );

      const [created] = await tx
        .select()
        .from(engagementSupportTickets)
        .where(eq(engagementSupportTickets.id, ticketId))
        .limit(1);
      return created!;
    });

    return buildDetailView(principal, committedTicket, false);
  }

  async function reply(
    principal: SessionPrincipal,
    input: { ticketId: string; body: string; idempotencyKey: string },
  ): Promise<TicketDetailView> {
    assertFullSession(principal);
    const body = normalizePlainText(input.body, {
      min: 1,
      max: 8000,
      field: "body",
      label: "reply",
    });
    const idempotencyKey = normalizePlainText(input.idempotencyKey, {
      min: 1,
      max: 128,
      field: "idempotencyKey",
      label: "idempotency key",
      singleLine: true,
    });

    const initialTicket = await findCustomerOwnedTicketOrThrow(principal, input.ticketId);
    const tokenHashes = computeSearchTokenHashes(crypto, [body]);

    const updatedTicket = await db.transaction(async (tx) => {
      const extraIds = initialTicket.assigneeUserId ? [initialTicket.assigneeUserId] : [];
      await assertCurrentActorInTx(deps, principal, tx, { extraLockUserIds: extraIds });

      const [lockedTicket] = await tx
        .select()
        .from(engagementSupportTickets)
        .where(eq(engagementSupportTickets.id, initialTicket.id))
        .limit(1)
        .for("update");

      if (
        !lockedTicket ||
        lockedTicket.requesterUserId !== principal.userId ||
        !(await isLiveTicketRowInTx(tx, lockedTicket))
      ) {
        throw notFound("TICKET_NOT_FOUND");
      }

      const [existingMsg] = await tx
        .select({ id: engagementSupportTicketMessages.id })
        .from(engagementSupportTicketMessages)
        .where(
          and(
            eq(engagementSupportTicketMessages.ticketId, lockedTicket.id),
            eq(engagementSupportTicketMessages.authorUserId, principal.userId),
            eq(engagementSupportTicketMessages.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      if (existingMsg) {
        return lockedTicket;
      }

      if (lockedTicket.status === "closed") {
        throw conflict(
          "TICKET_CLOSED",
          "This support ticket is closed. Please open a new ticket to continue.",
        );
      }

      const now = clock.now();
      if (lockedTicket.status === "resolved") {
        const reopenWindowDays = await readSetting(settings, ENGAGEMENT_TICKETS_REOPEN_WINDOW_DAYS, tx);
        if (
          lockedTicket.resolvedAt === null ||
          now.getTime() - lockedTicket.resolvedAt.getTime() > reopenWindowDays * DAY_MS
        ) {
          throw conflict(
            "TICKET_REOPEN_EXPIRED",
            "The reopen window for this resolved ticket has passed. Please open a new ticket.",
          );
        }
      }

      const msgPublicId = ulid(now.getTime());
      await tx.insert(engagementSupportTicketMessages).values({
        publicId: msgPublicId,
        ticketId: lockedTicket.id,
        authorUserId: principal.userId,
        authorUserPublicId: principal.userPublicId,
        authorRole: principal.role,
        internalOnly: false,
        bodyEnc: crypto.encrypt(body, `engagement_support_ticket_messages.body:${msgPublicId}`),
        idempotencyKey,
        createdAt: now,
      });

      if (tokenHashes.length > 0) {
        await tx.insert(engagementSearchTokens).values(
          tokenHashes.map((tokenHash) => ({
            domain: "ticket" as const,
            recordId: lockedTicket.id,
            customerVisible: true,
            tokenHash,
          })),
        );
      }

      const nextStatus: TicketStatus = "pending_staff";
      const statusChanged = lockedTicket.status !== nextStatus;

      await tx
        .update(engagementSupportTickets)
        .set({
          status: nextStatus,
          resolvedAt: statusChanged && lockedTicket.status === "resolved" ? null : lockedTicket.resolvedAt,
          lastMessageAt: now,
          version: lockedTicket.version + 1,
          updatedAt: now,
        })
        .where(eq(engagementSupportTickets.id, lockedTicket.id));

      if (statusChanged) {
        await tx.insert(engagementSupportTicketHistory).values({
          publicId: ulid(now.getTime()),
          ticketId: lockedTicket.id,
          actorUserId: principal.userId,
          actorRole: principal.role,
          fromStatus: lockedTicket.status,
          toStatus: nextStatus,
          reasonCode: "CUSTOMER_REPLY",
          occurredAt: now,
        });
        await audit.record(
          {
            category: "business",
            eventName: "engagement.ticket.status.changed",
            action: "transition",
            outcome: "completed",
            actor: { userId: principal.userId, role: principal.role },
            resource: { type: "ticket", publicId: lockedTicket.publicId },
            attributes: {
              ticket_number: lockedTicket.ticketNumber,
              from_status: lockedTicket.status,
              to_status: nextStatus,
            },
          },
          tx,
        );
      }

      await audit.record(
        {
          category: "business",
          eventName: "engagement.ticket.replied",
          action: "create",
          outcome: "completed",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "ticket", publicId: lockedTicket.publicId },
          attributes: {
            ticket_number: lockedTicket.ticketNumber,
            internal_only: false,
            actor_role: principal.role,
          },
        },
        tx,
      );

      if (lockedTicket.assigneeUserId !== null && lockedTicket.assigneeUserId !== principal.userId) {
        await notifications.notify(
          {
            userId: lockedTicket.assigneeUserId,
            ticketId: lockedTicket.id,
            orderId: lockedTicket.relatedOrderId,
            kind: "ticket.customer_replied",
            title: `Customer replied on ${lockedTicket.ticketNumber}`,
            body: `Ticket ${lockedTicket.ticketNumber} has a new customer reply.`,
            link: `/admin/tickets/${lockedTicket.publicId}`,
            idempotencyKey: `ticket-cust-reply:${msgPublicId}:${lockedTicket.assigneeUserId}`,
            skipEmail: true,
          },
          tx,
        );
      }

      const [refreshed] = await tx
        .select()
        .from(engagementSupportTickets)
        .where(eq(engagementSupportTickets.id, lockedTicket.id))
        .limit(1);
      return refreshed!;
    });

    return buildDetailView(principal, updatedTicket, false);
  }

  async function close(principal: SessionPrincipal, input: { ticketId: string }): Promise<TicketDetailView> {
    assertFullSession(principal);
    const initialTicket = await findCustomerOwnedTicketOrThrow(principal, input.ticketId);

    const updatedTicket = await db.transaction(async (tx) => {
      await assertCurrentActorInTx(deps, principal, tx);

      const [locked] = await tx
        .select()
        .from(engagementSupportTickets)
        .where(eq(engagementSupportTickets.id, initialTicket.id))
        .limit(1)
        .for("update");
      if (
        !locked ||
        locked.requesterUserId !== principal.userId ||
        !(await isLiveTicketRowInTx(tx, locked))
      ) {
        throw notFound("TICKET_NOT_FOUND");
      }
      if (locked.status === "closed") {
        return locked;
      }

      const now = clock.now();
      await tx
        .update(engagementSupportTickets)
        .set({
          status: "closed",
          closedAt: now,
          resolvedAt: locked.resolvedAt ?? now,
          version: locked.version + 1,
          updatedAt: now,
        })
        .where(eq(engagementSupportTickets.id, locked.id));

      await tx.insert(engagementSupportTicketHistory).values({
        publicId: ulid(now.getTime()),
        ticketId: locked.id,
        actorUserId: principal.userId,
        actorRole: principal.role,
        fromStatus: locked.status,
        toStatus: "closed",
        reasonCode: "CUSTOMER_CLOSED",
        occurredAt: now,
      });

      await audit.record(
        {
          category: "business",
          eventName: "engagement.ticket.status.changed",
          action: "transition",
          outcome: "completed",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "ticket", publicId: locked.publicId },
          attributes: {
            ticket_number: locked.ticketNumber,
            from_status: locked.status,
            to_status: "closed",
          },
        },
        tx,
      );

      const [refreshed] = await tx
        .select()
        .from(engagementSupportTickets)
        .where(eq(engagementSupportTickets.id, locked.id))
        .limit(1);
      return refreshed!;
    });

    return buildDetailView(principal, updatedTicket, false);
  }

  async function reopen(
    principal: SessionPrincipal,
    input: { ticketId: string; reason: string },
  ): Promise<TicketDetailView> {
    assertFullSession(principal);
    const reason = normalizePlainText(input.reason, {
      min: 3,
      max: 500,
      field: "reason",
      label: "reopen reason",
    });
    const initialTicket = await findCustomerOwnedTicketOrThrow(principal, input.ticketId);
    const tokenHashes = computeSearchTokenHashes(crypto, [reason]);

    const updatedTicket = await db.transaction(async (tx) => {
      const extraIds = initialTicket.assigneeUserId ? [initialTicket.assigneeUserId] : [];
      await assertCurrentActorInTx(deps, principal, tx, { extraLockUserIds: extraIds });

      const [locked] = await tx
        .select()
        .from(engagementSupportTickets)
        .where(eq(engagementSupportTickets.id, initialTicket.id))
        .limit(1)
        .for("update");
      if (
        !locked ||
        locked.requesterUserId !== principal.userId ||
        !(await isLiveTicketRowInTx(tx, locked))
      ) {
        throw notFound("TICKET_NOT_FOUND");
      }

      if (locked.status === "closed") {
        throw conflict(
          "TICKET_REOPEN_DENIED",
          "Closed support tickets cannot be reopened. Please create a new ticket.",
        );
      }
      if (locked.status !== "resolved") {
        throw conflict("TICKET_ALREADY_OPEN", "This support ticket is already active.");
      }

      const now = clock.now();
      const reopenWindowDays = await readSetting(settings, ENGAGEMENT_TICKETS_REOPEN_WINDOW_DAYS, tx);
      if (locked.resolvedAt === null || now.getTime() - locked.resolvedAt.getTime() > reopenWindowDays * DAY_MS) {
        throw conflict(
          "TICKET_REOPEN_EXPIRED",
          "The reopen window for this resolved ticket has expired. Please create a new ticket.",
        );
      }

      const msgPublicId = ulid(now.getTime());
      await tx.insert(engagementSupportTicketMessages).values({
        publicId: msgPublicId,
        ticketId: locked.id,
        authorUserId: principal.userId,
        authorUserPublicId: principal.userPublicId,
        authorRole: principal.role,
        internalOnly: false,
        bodyEnc: crypto.encrypt(reason, `engagement_support_ticket_messages.body:${msgPublicId}`),
        idempotencyKey: null,
        createdAt: now,
      });

      if (tokenHashes.length > 0) {
        await tx.insert(engagementSearchTokens).values(
          tokenHashes.map((tokenHash) => ({
            domain: "ticket" as const,
            recordId: locked.id,
            customerVisible: true,
            tokenHash,
          })),
        );
      }

      await tx
        .update(engagementSupportTickets)
        .set({
          status: "open",
          resolvedAt: null,
          lastMessageAt: now,
          version: locked.version + 1,
          updatedAt: now,
        })
        .where(eq(engagementSupportTickets.id, locked.id));

      await tx.insert(engagementSupportTicketHistory).values({
        publicId: ulid(now.getTime()),
        ticketId: locked.id,
        actorUserId: principal.userId,
        actorRole: principal.role,
        fromStatus: "resolved",
        toStatus: "open",
        reasonCode: "CUSTOMER_REOPENED",
        occurredAt: now,
      });

      await audit.record(
        {
          category: "business",
          eventName: "engagement.ticket.status.changed",
          action: "transition",
          outcome: "completed",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "ticket", publicId: locked.publicId },
          attributes: {
            ticket_number: locked.ticketNumber,
            from_status: "resolved",
            to_status: "open",
          },
        },
        tx,
      );

      if (locked.assigneeUserId !== null && locked.assigneeUserId !== principal.userId) {
        await notifications.notify(
          {
            userId: locked.assigneeUserId,
            ticketId: locked.id,
            orderId: locked.relatedOrderId,
            kind: "ticket.reopened",
            title: `Ticket ${locked.ticketNumber} reopened`,
            body: `Customer reopened support ticket ${locked.ticketNumber}.`,
            link: `/admin/tickets/${locked.publicId}`,
            idempotencyKey: `ticket-reopen:${msgPublicId}:${locked.assigneeUserId}`,
            skipEmail: true,
          },
          tx,
        );
      }

      const [refreshed] = await tx
        .select()
        .from(engagementSupportTickets)
        .where(eq(engagementSupportTickets.id, locked.id))
        .limit(1);
      return refreshed!;
    });

    return buildDetailView(principal, updatedTicket, false);
  }

  /* ------------------------------------------------ staff / admin procedures */

  async function adminList(
    principal: SessionPrincipal,
    input: {
      status?: TicketStatus;
      priority?: TicketPriority;
      category?: TicketCategory;
      assignedToMe?: boolean;
      unassignedOnly?: boolean;
      customerId?: string;
      cursor?: string;
      limit?: number;
    } = {},
  ): Promise<{ items: TicketSummaryView[]; nextCursor: string | null }> {
    assertFullSession(principal);
    if (!roleHasCapability(principal.role, "tickets.read_all")) {
      throw forbidden("CAPABILITY_NOT_GRANTED");
    }
    if (input.customerId !== undefined && !ULID_PATTERN.test(input.customerId)) {
      throw validation("INVALID_CUSTOMER_ID", "The customer identifier is invalid.");
    }

    const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
    const beforeId = decodeIdCursor(input.cursor);

    const rows = await db
      .select()
      .from(engagementSupportTickets)
      .where(
        and(
          liveTicketPredicate(),
          input.status !== undefined ? eq(engagementSupportTickets.status, input.status) : undefined,
          input.priority !== undefined ? eq(engagementSupportTickets.priority, input.priority) : undefined,
          input.category !== undefined ? eq(engagementSupportTickets.category, input.category) : undefined,
          input.assignedToMe ? eq(engagementSupportTickets.assigneeUserId, principal.userId) : undefined,
          input.unassignedOnly ? isNull(engagementSupportTickets.assigneeUserId) : undefined,
          input.customerId !== undefined ? eq(engagementSupportTickets.requesterUserPublicId, input.customerId) : undefined,
          beforeId !== undefined ? lt(engagementSupportTickets.id, beforeId) : undefined,
        ),
      )
      .orderBy(desc(engagementSupportTickets.id))
      .limit(limit + 1);

    const slice = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? encodeIdCursor(slice[slice.length - 1]!.id) : null;
    return {
      items: slice.map((row) => toSummaryView(row, false)),
      nextCursor,
    };
  }

  async function adminQueueSummary(
    principal: SessionPrincipal,
  ): Promise<{ openCount: number; unassignedCount: number; assignedToMeCount: number }> {
    assertFullSession(principal);
    if (!roleHasCapability(principal.role, "tickets.read_all")) {
      throw forbidden("CAPABILITY_NOT_GRANTED");
    }
    const activeStatuses: TicketStatus[] = ["open", "pending_customer", "pending_staff"];
    const liveGate = liveTicketPredicate();
    const [openRow, unassignedRow, mineRow] = await Promise.all([
      db
        .select({ total: count(engagementSupportTickets.id) })
        .from(engagementSupportTickets)
        .where(and(inArray(engagementSupportTickets.status, activeStatuses), liveGate)),
      db
        .select({ total: count(engagementSupportTickets.id) })
        .from(engagementSupportTickets)
        .where(
          and(
            inArray(engagementSupportTickets.status, activeStatuses),
            isNull(engagementSupportTickets.assigneeUserId),
            liveGate,
          ),
        ),
      db
        .select({ total: count(engagementSupportTickets.id) })
        .from(engagementSupportTickets)
        .where(
          and(
            inArray(engagementSupportTickets.status, activeStatuses),
            eq(engagementSupportTickets.assigneeUserId, principal.userId),
            liveGate,
          ),
        ),
    ]);
    return {
      openCount: Number(openRow[0]?.total ?? 0),
      unassignedCount: Number(unassignedRow[0]?.total ?? 0),
      assignedToMeCount: Number(mineRow[0]?.total ?? 0),
    };
  }

  async function adminGet(
    principal: SessionPrincipal,
    ticketPublicId: string,
    options?: { replyCursor?: string; replyLimit?: number },
  ): Promise<TicketDetailView> {
    assertFullSession(principal);
    if (!roleHasCapability(principal.role, "tickets.read_all")) {
      throw forbidden("CAPABILITY_NOT_GRANTED");
    }
    if (!ULID_PATTERN.test(ticketPublicId)) {
      throw notFound("TICKET_NOT_FOUND");
    }
    const [row] = await db
      .select()
      .from(engagementSupportTickets)
      .where(and(eq(engagementSupportTickets.publicId, ticketPublicId), liveTicketPredicate()))
      .limit(1);
    if (!row) {
      throw notFound("TICKET_NOT_FOUND");
    }
    return buildDetailView(principal, row, true, options);
  }

  async function adminReply(
    principal: SessionPrincipal,
    input: {
      ticketId: string;
      body: string;
      internalOnly?: boolean;
      nextStatus?: TicketStatus;
      idempotencyKey: string;
    },
  ): Promise<TicketDetailView> {
    assertFullSession(principal);
    if (!roleHasCapability(principal.role, "tickets.manage")) {
      throw forbidden("CAPABILITY_NOT_GRANTED");
    }
    if (!ULID_PATTERN.test(input.ticketId)) {
      throw notFound("TICKET_NOT_FOUND");
    }

    const body = normalizePlainText(input.body, {
      min: 1,
      max: 8000,
      field: "body",
      label: "reply",
    });
    const idempotencyKey = normalizePlainText(input.idempotencyKey, {
      min: 1,
      max: 128,
      field: "idempotencyKey",
      label: "idempotency key",
      singleLine: true,
    });
    const internalOnly = input.internalOnly ?? false;
    const tokenHashes = computeSearchTokenHashes(crypto, [body]);

    const [precheck] = await db
      .select({ id: engagementSupportTickets.id, requesterUserId: engagementSupportTickets.requesterUserId })
      .from(engagementSupportTickets)
      .where(eq(engagementSupportTickets.publicId, input.ticketId))
      .limit(1);
    if (!precheck) {
      throw notFound("TICKET_NOT_FOUND");
    }

    const updatedTicket = await db.transaction(async (tx) => {
      await assertCurrentActorInTx(deps, principal, tx, {
        capability: "tickets.manage",
        extraLockUserIds: internalOnly ? [] : [precheck.requesterUserId],
      });

      const [locked] = await tx
        .select()
        .from(engagementSupportTickets)
        .where(eq(engagementSupportTickets.id, precheck.id))
        .limit(1)
        .for("update");
      if (!locked || !(await isLiveTicketRowInTx(tx, locked))) {
        throw notFound("TICKET_NOT_FOUND");
      }

      const [existingMsg] = await tx
        .select({ id: engagementSupportTicketMessages.id })
        .from(engagementSupportTicketMessages)
        .where(
          and(
            eq(engagementSupportTicketMessages.ticketId, locked.id),
            eq(engagementSupportTicketMessages.authorUserId, principal.userId),
            eq(engagementSupportTicketMessages.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      if (existingMsg) {
        return locked;
      }

      const now = clock.now();
      const msgPublicId = ulid(now.getTime());
      await tx.insert(engagementSupportTicketMessages).values({
        publicId: msgPublicId,
        ticketId: locked.id,
        authorUserId: principal.userId,
        authorUserPublicId: principal.userPublicId,
        authorRole: principal.role,
        internalOnly,
        bodyEnc: crypto.encrypt(body, `engagement_support_ticket_messages.body:${msgPublicId}`),
        idempotencyKey,
        createdAt: now,
      });

      if (tokenHashes.length > 0) {
        await tx.insert(engagementSearchTokens).values(
          tokenHashes.map((tokenHash) => ({
            domain: "ticket" as const,
            recordId: locked.id,
            customerVisible: !internalOnly,
            tokenHash,
          })),
        );
      }

      const targetStatus: TicketStatus =
        input.nextStatus !== undefined
          ? input.nextStatus
          : internalOnly
            ? locked.status
            : locked.status === "closed"
              ? "closed"
              : "pending_customer";

      // Security invariant: an internal-only note with no status change must NOT advance customer-visible
      // `lastMessageAt`, `updatedAt`, or `version` (prevents timing/activity side-channel to the customer).
      const statusChanged = targetStatus !== locked.status;
      if (!internalOnly || statusChanged) {
        await tx
          .update(engagementSupportTickets)
          .set({
            status: targetStatus,
            lastMessageAt: internalOnly ? locked.lastMessageAt : now,
            resolvedAt:
              targetStatus === "resolved"
                ? (locked.resolvedAt ?? now)
                : targetStatus === "open" || targetStatus === "pending_customer" || targetStatus === "pending_staff"
                  ? null
                  : locked.resolvedAt,
            closedAt: targetStatus === "closed" ? (locked.closedAt ?? now) : null,
            version: locked.version + 1,
            updatedAt: now,
          })
          .where(eq(engagementSupportTickets.id, locked.id));
      }

      if (statusChanged) {
        await tx.insert(engagementSupportTicketHistory).values({
          publicId: ulid(now.getTime()),
          ticketId: locked.id,
          actorUserId: principal.userId,
          actorRole: principal.role,
          fromStatus: locked.status,
          toStatus: targetStatus,
          reasonCode: "STAFF_REPLY",
          occurredAt: now,
        });
        await audit.record(
          {
            category: "business",
            eventName: "engagement.ticket.status.changed",
            action: "transition",
            outcome: "completed",
            actor: { userId: principal.userId, role: principal.role },
            resource: { type: "ticket", publicId: locked.publicId },
            attributes: {
              ticket_number: locked.ticketNumber,
              from_status: locked.status,
              to_status: targetStatus,
            },
          },
          tx,
        );
      }

      await audit.record(
        {
          category: "business",
          eventName: "engagement.ticket.replied",
          action: "create",
          outcome: "completed",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "ticket", publicId: locked.publicId },
          attributes: {
            ticket_number: locked.ticketNumber,
            internal_only: internalOnly,
            actor_role: principal.role,
          },
        },
        tx,
      );

      // Internal staff notes NEVER notify or e-mail the customer.
      if (!internalOnly && locked.requesterUserId !== principal.userId) {
        const relativePath = `/support/${locked.publicId}`;
        await notifications.notify(
          {
            userId: locked.requesterUserId,
            ticketId: locked.id,
            orderId: locked.relatedOrderId,
            kind: "ticket.updated",
            title: `New reply on ticket ${locked.ticketNumber}`,
            body: `Support posted a reply on ticket ${locked.ticketNumber}.`,
            link: relativePath,
            idempotencyKey: `ticket-staff-reply:${msgPublicId}:${locked.requesterUserId}`,
            skipEmail: true,
          },
          tx,
        );
        if (await notifications.isCategoryEmailEnabled(tx, locked.requesterUserId, "ticket")) {
          await mailer.enqueue(
            {
              template: MAIL_TICKET_UPDATED,
              to: { userId: locked.requesterUserId },
              vars: {
                ticketNumber: locked.ticketNumber,
                eventLabel: "New reply",
                link: buildCanonicalPortalUrl(config.canonicalOrigin, relativePath),
              },
              idempotencyKey: `ticket-staff-mail:${msgPublicId}:${locked.requesterUserId}`,
              ...(locked.relatedOrderId !== null ? { orderId: locked.relatedOrderId } : {}),
            },
            tx,
          );
        }
      }

      const [refreshed] = await tx
        .select()
        .from(engagementSupportTickets)
        .where(eq(engagementSupportTickets.id, locked.id))
        .limit(1);
      return refreshed!;
    });

    return buildDetailView(principal, updatedTicket, true);
  }

  async function adminSetStatus(
    principal: SessionPrincipal,
    input: { ticketId: string; toStatus: TicketStatus; reasonCode?: string },
  ): Promise<TicketDetailView> {
    assertFullSession(principal);
    if (!roleHasCapability(principal.role, "tickets.manage")) {
      throw forbidden("CAPABILITY_NOT_GRANTED");
    }
    if (!ULID_PATTERN.test(input.ticketId)) {
      throw notFound("TICKET_NOT_FOUND");
    }
    const reasonCode = input.reasonCode
      ? normalizePlainText(input.reasonCode, {
          min: 2,
          max: 64,
          field: "reasonCode",
          label: "reason code",
          singleLine: true,
        }).toUpperCase()
      : "STAFF_STATUS_CHANGE";
    if (!/^[A-Z0-9_]{2,64}$/u.test(reasonCode)) {
      throw validation("INVALID_REASON_CODE", "Reason code must use uppercase letters, numbers, and underscores.");
    }

    const [precheck] = await db
      .select({ id: engagementSupportTickets.id, requesterUserId: engagementSupportTickets.requesterUserId })
      .from(engagementSupportTickets)
      .where(eq(engagementSupportTickets.publicId, input.ticketId))
      .limit(1);
    if (!precheck) {
      throw notFound("TICKET_NOT_FOUND");
    }

    const updatedTicket = await db.transaction(async (tx) => {
      await assertCurrentActorInTx(deps, principal, tx, {
        capability: "tickets.manage",
        extraLockUserIds: [precheck.requesterUserId],
      });

      const [locked] = await tx
        .select()
        .from(engagementSupportTickets)
        .where(eq(engagementSupportTickets.id, precheck.id))
        .limit(1)
        .for("update");
      if (!locked || !(await isLiveTicketRowInTx(tx, locked))) throw notFound("TICKET_NOT_FOUND");
      if (locked.status === input.toStatus) return locked;

      const now = clock.now();
      await tx
        .update(engagementSupportTickets)
        .set({
          status: input.toStatus,
          resolvedAt:
            input.toStatus === "resolved"
              ? now
              : input.toStatus === "closed"
                ? (locked.resolvedAt ?? now)
                : null,
          closedAt: input.toStatus === "closed" ? now : null,
          version: locked.version + 1,
          updatedAt: now,
        })
        .where(eq(engagementSupportTickets.id, locked.id));

      await tx.insert(engagementSupportTicketHistory).values({
        publicId: ulid(now.getTime()),
        ticketId: locked.id,
        actorUserId: principal.userId,
        actorRole: principal.role,
        fromStatus: locked.status,
        toStatus: input.toStatus,
        reasonCode,
        occurredAt: now,
      });

      await audit.record(
        {
          category: "business",
          eventName: "engagement.ticket.status.changed",
          action: "transition",
          outcome: "completed",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "ticket", publicId: locked.publicId },
          reasonCode,
          attributes: {
            ticket_number: locked.ticketNumber,
            from_status: locked.status,
            to_status: input.toStatus,
          },
        },
        tx,
      );

      if ((input.toStatus === "resolved" || input.toStatus === "closed") && locked.requesterUserId !== principal.userId) {
        const relativePath = `/support/${locked.publicId}`;
        const label = input.toStatus === "resolved" ? "Resolved" : "Closed";
        await notifications.notify(
          {
            userId: locked.requesterUserId,
            ticketId: locked.id,
            orderId: locked.relatedOrderId,
            kind: "ticket.updated",
            title: `Ticket ${locked.ticketNumber} marked ${label.toLowerCase()}`,
            body: `Support updated ticket ${locked.ticketNumber} status to ${label.toLowerCase()}.`,
            link: relativePath,
            idempotencyKey: `ticket-status:${locked.publicId}:${locked.version + 1}`,
            skipEmail: true,
          },
          tx,
        );
        if (await notifications.isCategoryEmailEnabled(tx, locked.requesterUserId, "ticket")) {
          await mailer.enqueue(
            {
              template: MAIL_TICKET_UPDATED,
              to: { userId: locked.requesterUserId },
              vars: {
                ticketNumber: locked.ticketNumber,
                eventLabel: label,
                link: buildCanonicalPortalUrl(config.canonicalOrigin, relativePath),
              },
              idempotencyKey: `ticket-status-mail:${locked.publicId}:${locked.version + 1}`,
              ...(locked.relatedOrderId !== null ? { orderId: locked.relatedOrderId } : {}),
            },
            tx,
          );
        }
      }

      const [refreshed] = await tx
        .select()
        .from(engagementSupportTickets)
        .where(eq(engagementSupportTickets.id, locked.id))
        .limit(1);
      return refreshed!;
    });

    return buildDetailView(principal, updatedTicket, true);
  }

  async function adminAssign(
    principal: SessionPrincipal,
    input: { ticketId: string; assigneeUserId: string | null },
  ): Promise<TicketDetailView> {
    assertFullSession(principal);
    if (!roleHasCapability(principal.role, "tickets.manage")) {
      throw forbidden("CAPABILITY_NOT_GRANTED");
    }
    if (!ULID_PATTERN.test(input.ticketId)) {
      throw notFound("TICKET_NOT_FOUND");
    }

    let precheckedAssigneeId: number | null = null;
    if (input.assigneeUserId !== null) {
      if (!ULID_PATTERN.test(input.assigneeUserId)) {
        throw validation("INVALID_ASSIGNEE", "The assignee identifier is invalid.");
      }
      const identity = getIdentityPeer(deps);
      const viaPeer = identity.getUserByPublicId ? await identity.getUserByPublicId(input.assigneeUserId) : null;
      if (viaPeer) {
        precheckedAssigneeId = viaPeer.id;
      } else {
        const [userRow] = await db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.publicId, input.assigneeUserId), liveUserPredicate(users)))
          .limit(1);
        if (!userRow) {
          throw validation("INVALID_ASSIGNEE", "Tickets may only be assigned to active staff or administrators.");
        }
        precheckedAssigneeId = userRow.id;
      }
    }

    const [precheckTicket] = await db
      .select({ id: engagementSupportTickets.id })
      .from(engagementSupportTickets)
      .where(and(eq(engagementSupportTickets.publicId, input.ticketId), liveTicketPredicate()))
      .limit(1);
    if (!precheckTicket) {
      throw notFound("TICKET_NOT_FOUND");
    }

    const updatedTicket = await db.transaction(async (tx) => {
      // Lock actor + target assignee in deterministic ascending users.id order before locking the ticket!
      const lockedUsers = await assertCurrentActorInTx(deps, principal, tx, {
        capability: "tickets.manage",
        extraLockUserIds: precheckedAssigneeId !== null ? [precheckedAssigneeId] : [],
      });

      let verifiedAssignee: { id: number; publicId: string } | null = null;
      if (precheckedAssigneeId !== null) {
        const assigneeRow = lockedUsers.get(precheckedAssigneeId);
        if (
          !assigneeRow ||
          assigneeRow.status !== "active" ||
          !isLiveUserRow(assigneeRow) ||
          (assigneeRow.role !== "staff" && assigneeRow.role !== "admin")
        ) {
          throw validation("INVALID_ASSIGNEE", "Tickets may only be assigned to active staff or administrators.");
        }
        verifiedAssignee = { id: assigneeRow.id, publicId: assigneeRow.publicId };
      }

      const [locked] = await tx
        .select()
        .from(engagementSupportTickets)
        .where(eq(engagementSupportTickets.id, precheckTicket.id))
        .limit(1)
        .for("update");
      if (!locked || !(await isLiveTicketRowInTx(tx, locked))) throw notFound("TICKET_NOT_FOUND");

      await tx
        .update(engagementSupportTickets)
        .set({
          assigneeUserId: verifiedAssignee?.id ?? null,
          assigneeUserPublicId: verifiedAssignee?.publicId ?? null,
          version: locked.version + 1,
          // Keep customer-visible `updatedAt` unchanged on internal staff assignment.
          updatedAt: locked.updatedAt,
        })
        .where(eq(engagementSupportTickets.id, locked.id));

      await audit.record(
        {
          category: "admin",
          eventName: "engagement.ticket.assigned",
          action: "update",
          outcome: "completed",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "ticket", publicId: locked.publicId },
          attributes: {
            ticket_number: locked.ticketNumber,
            assignee_public_id: verifiedAssignee?.publicId ?? null,
          },
        },
        tx,
      );

      if (verifiedAssignee !== null && verifiedAssignee.id !== principal.userId) {
        await notifications.notify(
          {
            userId: verifiedAssignee.id,
            ticketId: locked.id,
            orderId: locked.relatedOrderId,
            kind: "ticket.assigned",
            title: `Ticket ${locked.ticketNumber} assigned to you`,
            body: `Support ticket ${locked.ticketNumber} has been assigned to you.`,
            link: `/admin/tickets/${locked.publicId}`,
            idempotencyKey: `ticket-assign:${locked.publicId}:${locked.version + 1}:${verifiedAssignee.id}`,
            skipEmail: true,
          },
          tx,
        );
      }

      const [refreshed] = await tx
        .select()
        .from(engagementSupportTickets)
        .where(eq(engagementSupportTickets.id, locked.id))
        .limit(1);
      return refreshed!;
    });

    return buildDetailView(principal, updatedTicket, true);
  }

  async function adminSetPriority(
    principal: SessionPrincipal,
    input: { ticketId: string; priority: TicketPriority },
  ): Promise<TicketDetailView> {
    assertFullSession(principal);
    if (!roleHasCapability(principal.role, "tickets.manage")) {
      throw forbidden("CAPABILITY_NOT_GRANTED");
    }
    if (!ULID_PATTERN.test(input.ticketId)) {
      throw notFound("TICKET_NOT_FOUND");
    }

    const updatedTicket = await db.transaction(async (tx) => {
      await assertCurrentActorInTx(deps, principal, tx, { capability: "tickets.manage" });

      const [locked] = await tx
        .select()
        .from(engagementSupportTickets)
        .where(eq(engagementSupportTickets.publicId, input.ticketId))
        .limit(1)
        .for("update");
      if (!locked || !(await isLiveTicketRowInTx(tx, locked))) throw notFound("TICKET_NOT_FOUND");
      if (locked.priority === input.priority) return locked;

      const now = clock.now();
      await tx
        .update(engagementSupportTickets)
        .set({
          priority: input.priority,
          version: locked.version + 1,
          updatedAt: now,
        })
        .where(eq(engagementSupportTickets.id, locked.id));

      await audit.record(
        {
          category: "admin",
          eventName: "engagement.ticket.priority.changed",
          action: "update",
          outcome: "completed",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "ticket", publicId: locked.publicId },
          attributes: {
            ticket_number: locked.ticketNumber,
            from_priority: locked.priority,
            to_priority: input.priority,
          },
        },
        tx,
      );

      const [refreshed] = await tx
        .select()
        .from(engagementSupportTickets)
        .where(eq(engagementSupportTickets.id, locked.id))
        .limit(1);
      return refreshed!;
    });

    return buildDetailView(principal, updatedTicket, true);
  }

  /**
   * Server-internal helper for `automations` (`support.create_ticket` action).
   * Idempotent on `(requesterUserId, idempotencyKey)`. Caller runs inside `automation:<runPublicId>` request context
   * so `engagement.ticket.created` carries the automation-origin correlation marker and never loops.
   */
  async function createFromAutomation(input: {
    requesterUserId: number;
    category: TicketCategory;
    priority: TicketPriority;
    subject: string;
    body: string;
    relatedOrderPublicId?: string | null;
    idempotencyKey: string;
  }): Promise<{ publicId: string; ticketNumber: string; created: boolean }> {
    const subject = normalizePlainText(input.subject, {
      min: 3,
      max: 160,
      field: "subject",
      label: "ticket subject",
      singleLine: true,
    });
    const body = normalizePlainText(input.body, {
      min: 1,
      max: 8000,
      field: "body",
      label: "ticket body",
    });
    const idempotencyKey = normalizePlainText(input.idempotencyKey, {
      min: 1,
      max: 128,
      field: "idempotencyKey",
      label: "idempotency key",
      singleLine: true,
    });
    const tokenHashes = computeSearchTokenHashes(crypto, [subject, body]);

    return db.transaction(async (tx) => {
      const [requester] = await tx
        .select({
          id: users.id,
          publicId: users.publicId,
          role: users.role,
          status: users.status,
          trashedAt: users.trashedAt,
          purgedAt: users.purgedAt,
        })
        .from(users)
        .where(eq(users.id, input.requesterUserId))
        .limit(1)
        .for("share");

      if (!requester || requester.status !== "active" || !isLiveUserRow(requester)) {
        throw validation("AUTOMATION_TICKET_REQUESTER_INACTIVE", "Target requester account is not active.");
      }

      const [existing] = await tx
        .select({
          publicId: engagementSupportTickets.publicId,
          ticketNumber: engagementSupportTickets.ticketNumber,
        })
        .from(engagementSupportTickets)
        .where(
          and(
            eq(engagementSupportTickets.requesterUserId, requester.id),
            eq(engagementSupportTickets.idempotencyKey, idempotencyKey),
            liveTicketPredicate(),
          ),
        )
        .limit(1);
      if (existing) {
        return { publicId: existing.publicId, ticketNumber: existing.ticketNumber, created: false };
      }

      let relatedOrder: { id: number; publicId: string; reference: string } | null = null;
      if (input.relatedOrderPublicId) {
        const orders = getOrdersPeer(deps);
        const summary = await orders.getOrderRefByPublicId?.(input.relatedOrderPublicId, tx);
        if (!summary) {
          throw notFound("ORDER_NOT_FOUND");
        }
        relatedOrder = {
          id: summary.id,
          publicId: summary.publicId,
          reference: summary.reference,
        };
      }

      const now = clock.now();
      const ticketPublicId = ulid(now.getTime());
      const ticketNumber = await allocateUniqueTicketNumber(tx, now);
      const subjectEnc = crypto.encrypt(subject, `engagement_support_tickets.subject:${ticketPublicId}`);

      const [ticketHeader] = await tx.insert(engagementSupportTickets).values({
        publicId: ticketPublicId,
        ticketNumber,
        requesterUserId: requester.id,
        requesterUserPublicId: requester.publicId,
        relatedOrderId: relatedOrder?.id ?? null,
        relatedOrderPublicId: relatedOrder?.publicId ?? null,
        relatedOrderReference: relatedOrder ? relatedOrder.reference.trim().toUpperCase() : null,
        assigneeUserId: null,
        assigneeUserPublicId: null,
        category: input.category,
        status: "open",
        priority: input.priority,
        subjectEnc,
        idempotencyKey,
        origin: "portal",
        lastMessageAt: now,
        resolvedAt: null,
        closedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      const ticketId = Number(ticketHeader.insertId);

      const messagePublicId = ulid(now.getTime());
      await tx.insert(engagementSupportTicketMessages).values({
        publicId: messagePublicId,
        ticketId,
        authorUserId: requester.id,
        authorUserPublicId: requester.publicId,
        authorRole: requester.role,
        internalOnly: false,
        bodyEnc: crypto.encrypt(body, `engagement_support_ticket_messages.body:${messagePublicId}`),
        idempotencyKey,
        createdAt: now,
      });

      await tx.insert(engagementSupportTicketHistory).values({
        publicId: ulid(now.getTime()),
        ticketId,
        actorUserId: requester.id,
        actorRole: "system",
        fromStatus: null,
        toStatus: "open",
        reasonCode: "TICKET_CREATED_BY_AUTOMATION",
        occurredAt: now,
      });

      if (tokenHashes.length > 0) {
        await tx.insert(engagementSearchTokens).values(
          tokenHashes.map((tokenHash) => ({
            domain: "ticket" as const,
            recordId: ticketId,
            customerVisible: true,
            tokenHash,
          })),
        );
      }

      await audit.record(
        {
          category: "business",
          eventName: "engagement.ticket.created",
          action: "create",
          outcome: "completed",
          actor: { role: "system" },
          resource: { type: "ticket", publicId: ticketPublicId },
          attributes: {
            ticket_number: ticketNumber,
            category: input.category,
            has_related_order: relatedOrder !== null,
          },
        },
        tx,
      );

      return { publicId: ticketPublicId, ticketNumber, created: true };
    });
  }

  return {
    list,
    openSummary,
    get,
    create,
    createFromAutomation,
    reply,
    close,
    reopen,
    adminList,
    adminQueueSummary,
    adminGet,
    adminReply,
    adminSetStatus,
    adminAssign,
    adminSetPriority,
  };
}

export type TicketsService = ReturnType<typeof createTicketsService>;
