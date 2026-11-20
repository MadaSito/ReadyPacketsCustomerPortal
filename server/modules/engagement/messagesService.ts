import { and, count, desc, eq, inArray, lt, lte, ne } from "drizzle-orm";
import { roleHasCapability } from "../../../shared/capabilities.js";
import type { UserRole } from "../../../shared/domain.js";
import type { ModuleDeps } from "../../container.js";
import { conflict, DomainError, forbidden, notFound, validation } from "../../core/errors.js";
import { ULID_PATTERN, ulid } from "../../core/ids.js";
import type { SessionPrincipal } from "../../core/types.js";
import { buildCanonicalPortalUrl, MAIL_ORDER_MESSAGE_RECEIVED } from "./mail.js";
import type { NotificationsService } from "./notificationsService.js";
import { assertCurrentActorInTx, getFilesPeer, getIdentityPeer, getOrdersPeer } from "./peers.js";
import {
  engagementOrderMessageAttachments,
  engagementOrderMessageReads,
  engagementOrderMessages,
  engagementSearchTokens,
} from "./schema.js";
import { computeSearchTokenHashes, decodeIdCursor, encodeIdCursor, normalizePlainText, truncateSnippet } from "./textAndSearch.js";
import type { OrderMessageVisibility } from "./types.js";

export interface MessageAttachmentView {
  filePublicId: string;
  displayName: string | null;
  size: number | null;
  contentType: string | null;
  available: boolean;
}

export interface OrderMessageView {
  publicId: string;
  orderPublicId: string;
  orderReference: string;
  authorUserPublicId: string;
  authorRole: UserRole;
  authorDisplayLabel: string;
  isOwnMessage: boolean;
  visibility: OrderMessageVisibility;
  body: string;
  attachments: MessageAttachmentView[];
  unread: boolean;
  readAt: Date | null;
  readReceiptsCount: number;
  createdAt: Date;
}

export interface OrderThreadSummaryView {
  orderPublicId: string;
  orderReference: string;
  projectName: string;
  statusLabel: string;
  locked: boolean;
  lastMessageAt: Date;
  lastMessagePreview: string;
  lastAuthorRole: UserRole;
  unreadCount: number;
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

function canReadInternalNotes(principal: SessionPrincipal): boolean {
  return (principal.role === "staff" || principal.role === "admin") && roleHasCapability(principal.role, "messages.read_all");
}

export function createMessagesService(deps: ModuleDeps, notifications: NotificationsService) {
  const { db, clock, crypto, audit, mailer, config } = deps;

  async function resolveAuthorLabels(
    principal: SessionPrincipal,
    rows: readonly { authorUserId: number; authorRole: UserRole }[],
  ): Promise<Map<number, string>> {
    const identity = getIdentityPeer(deps);
    const labels = new Map<number, string>();
    const uniqueIds = [...new Set(rows.map((r) => r.authorUserId))];
    const isStaffViewer = principal.role === "staff" || principal.role === "admin";

    for (const userId of uniqueIds) {
      if (userId === principal.userId) {
        labels.set(userId, "You");
        continue;
      }
      const user = identity.getUser ? await identity.getUser(userId) : null;
      if (user) {
        if (user.role === "customer") {
          labels.set(userId, user.name);
        } else {
          // Staff viewers see colleague names; customers see uniform team attribution.
          labels.set(userId, isStaffViewer ? `${user.name} (Staff)` : "ReadyPackets Team");
        }
      } else {
        const sample = rows.find((r) => r.authorUserId === userId);
        labels.set(userId, sample?.authorRole === "customer" ? "Customer" : "ReadyPackets Team");
      }
    }
    return labels;
  }

  async function hydrateMessages(
    principal: SessionPrincipal,
    rows: readonly (typeof engagementOrderMessages.$inferSelect)[],
  ): Promise<OrderMessageView[]> {
    if (rows.length === 0) return [];
    const messageIds = rows.map((r) => r.id);

    const [attachmentRows, callerReadRows, receiptCountRows, authorLabels] = await Promise.all([
      db
        .select()
        .from(engagementOrderMessageAttachments)
        .where(inArray(engagementOrderMessageAttachments.messageId, messageIds))
        .orderBy(engagementOrderMessageAttachments.sortOrder),
      db
        .select({
          messageId: engagementOrderMessageReads.messageId,
          readAt: engagementOrderMessageReads.readAt,
        })
        .from(engagementOrderMessageReads)
        .where(
          and(
            eq(engagementOrderMessageReads.userId, principal.userId),
            inArray(engagementOrderMessageReads.messageId, messageIds),
          ),
        ),
      db
        .select({
          messageId: engagementOrderMessageReads.messageId,
          total: count(engagementOrderMessageReads.id),
        })
        .from(engagementOrderMessageReads)
        .where(inArray(engagementOrderMessageReads.messageId, messageIds))
        .groupBy(engagementOrderMessageReads.messageId),
      resolveAuthorLabels(principal, rows),
    ]);

    const readMap = new Map(callerReadRows.map((r) => [r.messageId, r.readAt]));
    const receiptCounts = new Map(receiptCountRows.map((r) => [r.messageId, Number(r.total)]));

    // Resolve unique (orderPublicId, filePublicId) pairs via files.assertCanReadFile so deleted or
    // visibility-restricted attachments never leak display names or stale availability.
    const filesPeer = (deps.services.files ?? {}) as {
      assertCanReadFile?: (
        p: SessionPrincipal,
        filePublicId: string,
        orderPublicId?: string,
      ) => Promise<{ displayName: string; size: number; contentType: string }>;
    };
    const attachmentCache = new Map<string, MessageAttachmentView>();
    for (const att of attachmentRows) {
      const msg = rows.find((m) => m.id === att.messageId);
      if (!msg) continue;
      const cacheKey = `${msg.orderPublicId}:${att.filePublicId}`;
      if (attachmentCache.has(cacheKey)) continue;
      if (filesPeer.assertCanReadFile) {
        try {
          const record = await filesPeer.assertCanReadFile(principal, att.filePublicId, msg.orderPublicId);
          attachmentCache.set(cacheKey, {
            filePublicId: att.filePublicId,
            displayName: record.displayName,
            size: record.size,
            contentType: record.contentType,
            available: true,
          });
        } catch {
          attachmentCache.set(cacheKey, {
            filePublicId: att.filePublicId,
            displayName: null,
            size: null,
            contentType: null,
            available: false,
          });
        }
      } else {
        attachmentCache.set(cacheKey, {
          filePublicId: att.filePublicId,
          displayName: null,
          size: null,
          contentType: null,
          available: false,
        });
      }
    }

    const attachmentsByMessage = new Map<number, MessageAttachmentView[]>();
    for (const att of attachmentRows) {
      const msg = rows.find((m) => m.id === att.messageId);
      if (!msg) continue;
      const resolved = attachmentCache.get(`${msg.orderPublicId}:${att.filePublicId}`)!;
      const list = attachmentsByMessage.get(att.messageId) ?? [];
      list.push(resolved);
      attachmentsByMessage.set(att.messageId, list);
    }

    const allowInternal = canReadInternalNotes(principal);

    return rows
      .filter((row) => allowInternal || row.visibility === "customer")
      .map((row) => {
        const readAt = readMap.get(row.id) ?? null;
        const isOwn = row.authorUserId === principal.userId;
        return {
          publicId: row.publicId,
          orderPublicId: row.orderPublicId,
          orderReference: row.orderReference,
          authorUserPublicId: row.authorUserPublicId,
          authorRole: row.authorRole,
          authorDisplayLabel: authorLabels.get(row.authorUserId) ?? "Participant",
          isOwnMessage: isOwn,
          visibility: row.visibility,
          body: crypto.decrypt(row.bodyEnc, `engagement_order_messages.body:${row.publicId}`),
          attachments: attachmentsByMessage.get(row.id) ?? [],
          unread: !isOwn && readAt === null,
          readAt,
          readReceiptsCount: receiptCounts.get(row.id) ?? 0,
          createdAt: row.createdAt,
        };
      });
  }

  async function listByOrder(
    principal: SessionPrincipal,
    input: { orderId: string; cursor?: string; limit?: number },
  ): Promise<{
    items: OrderMessageView[];
    nextCursor: string | null;
    canPost: boolean;
    canPostInternal: boolean;
    lockState: string;
  }> {
    assertFullSession(principal);
    const orders = getOrdersPeer(deps);
    const order = await orders.assertCanReadOrder(principal, input.orderId);

    const limit = Math.min(Math.max(input.limit ?? 40, 1), 100);
    const beforeId = decodeIdCursor(input.cursor);
    const allowInternal = canReadInternalNotes(principal);

    const rows = await db
      .select()
      .from(engagementOrderMessages)
      .where(
        and(
          eq(engagementOrderMessages.orderId, order.id),
          allowInternal ? undefined : eq(engagementOrderMessages.visibility, "customer"),
          beforeId !== undefined ? lt(engagementOrderMessages.id, beforeId) : undefined,
        ),
      )
      .orderBy(desc(engagementOrderMessages.id))
      .limit(limit + 1);

    const slice = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? encodeIdCursor(slice[slice.length - 1]!.id) : null;
    const items = await hydrateMessages(principal, slice);

    const roleAllowsWrite =
      order.accessRole === "owner" ||
      order.accessRole === "contributor" ||
      ((order.accessRole === "staff" || order.accessRole === "admin") &&
        roleHasCapability(principal.role, "orders.manage"));
    const lockAllowsWrite =
      order.lockState === "none" ||
      (order.lockState === "review" && (principal.role === "staff" || principal.role === "admin"));

    return {
      items,
      nextCursor,
      canPost: roleAllowsWrite && lockAllowsWrite,
      canPostInternal: allowInternal && roleAllowsWrite && lockAllowsWrite,
      lockState: order.lockState,
    };
  }

  async function send(
    principal: SessionPrincipal,
    input: {
      orderId: string;
      body: string;
      visibility?: OrderMessageVisibility;
      attachmentFileIds?: readonly string[];
      idempotencyKey: string;
    },
  ): Promise<OrderMessageView> {
    assertFullSession(principal);
    const visibility: OrderMessageVisibility = input.visibility ?? "customer";
    if (visibility === "internal" && !canReadInternalNotes(principal)) {
      await audit.record({
        category: "security",
        eventName: "authz.engagement.denied",
        action: "create",
        outcome: "denied",
        severity: "WARN",
        reasonCode: "INTERNAL_VISIBILITY_DENIED",
        actor: { userId: principal.userId, role: principal.role },
        resource: ULID_PATTERN.test(input.orderId) ? { type: "order", publicId: input.orderId } : { type: "order" },
      });
      throw forbidden("INTERNAL_VISIBILITY_DENIED");
    }

    const body = normalizePlainText(input.body, {
      min: 1,
      max: 4000,
      field: "body",
      label: "message",
    });
    const idempotencyKey = normalizePlainText(input.idempotencyKey, {
      min: 1,
      max: 128,
      field: "idempotencyKey",
      label: "idempotency key",
      singleLine: true,
    });

    const attachmentIds = [...(input.attachmentFileIds ?? [])];
    if (attachmentIds.length > 10) {
      throw validation("TOO_MANY_ATTACHMENTS", "Attach at most 10 files per message.");
    }
    const uniqueCheck = new Set<string>();
    for (const fileId of attachmentIds) {
      if (!ULID_PATTERN.test(fileId)) {
        throw validation("INVALID_ATTACHMENT_ID", "One or more attachment identifiers are invalid.");
      }
      if (uniqueCheck.has(fileId)) {
        throw validation("DUPLICATE_ATTACHMENT", "Duplicate file attachments are not allowed.");
      }
      uniqueCheck.add(fileId);
    }

    const orders = getOrdersPeer(deps);

    // Pre-verify order write access before calling filesPeer so unauthorized orders always fail via order policy first.
    const precheckOrder = await orders.assertCanWriteOrder(principal, input.orderId, { kind: "message" });

    if (attachmentIds.length > 0) {
      const files = getFilesPeer(deps);
      for (const fileId of attachmentIds) {
        const fileRecord = await files.assertCanReadFile(principal, fileId, precheckOrder.publicId);
        if (visibility === "customer" && fileRecord.visibility === "staff_only") {
          throw validation(
            "STAFF_FILE_ON_CUSTOMER_MESSAGE",
            "A staff-only file cannot be attached to a customer-visible message.",
          );
        }
      }
    }

    const tokenHashes = computeSearchTokenHashes(crypto, [body]);

    const committedRow = await db.transaction(async (tx) => {
      await assertCurrentActorInTx(deps, principal, tx, {
        capability: visibility === "internal" ? "messages.read_all" : undefined,
        extraLockUserIds: [precheckOrder.ownerUserId],
      });
      // Authoritative write check + lock check inside transaction with row lock.
      const order = await orders.assertCanWriteOrder(principal, input.orderId, {
        kind: "message",
        tx,
        forUpdate: true,
      });

      const [existing] = await tx
        .select()
        .from(engagementOrderMessages)
        .where(
          and(
            eq(engagementOrderMessages.authorUserId, principal.userId),
            eq(engagementOrderMessages.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);

      if (existing) {
        if (existing.orderId !== order.id) {
          throw conflict("IDEMPOTENCY_KEY_REUSED", "This idempotency key was already used for another order.");
        }
        return existing;
      }

      const now = clock.now();
      const publicId = ulid(now.getTime());
      const bodyEnc = crypto.encrypt(body, `engagement_order_messages.body:${publicId}`);

      const [insertHeader] = await tx.insert(engagementOrderMessages).values({
        publicId,
        orderId: order.id,
        orderPublicId: order.publicId,
        orderReference: order.reference.trim().toUpperCase(),
        authorUserId: principal.userId,
        authorUserPublicId: principal.userPublicId,
        authorRole: principal.role,
        visibility,
        bodyEnc,
        idempotencyKey,
        origin: "portal",
        createdAt: now,
      });
      const messageId = Number(insertHeader.insertId);

      if (attachmentIds.length > 0) {
        await tx.insert(engagementOrderMessageAttachments).values(
          attachmentIds.map((filePublicId, idx) => ({
            messageId,
            filePublicId,
            sortOrder: idx,
            createdAt: now,
          })),
        );
      }

      if (tokenHashes.length > 0) {
        await tx.insert(engagementSearchTokens).values(
          tokenHashes.map((tokenHash) => ({
            domain: "order_message" as const,
            recordId: messageId,
            customerVisible: visibility === "customer",
            tokenHash,
          })),
        );
      }

      await audit.record(
        {
          category: "business",
          eventName: "engagement.message.sent",
          action: "create",
          outcome: "completed",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "order_message", publicId },
          attributes: {
            order_public_id: order.publicId,
            visibility,
            attachment_count: attachmentIds.length,
          },
        },
        tx,
      );

      // Notify order owner when someone else posts a customer-visible message (never for internal staff notes).
      if (visibility === "customer" && order.ownerUserId !== principal.userId) {
        const relativePath = `/orders/${order.publicId}`;
        await notifications.notify(
          {
            userId: order.ownerUserId,
            kind: "message.received",
            title: `New message on order ${order.reference}`,
            body: `You have a new message on order ${order.reference}.`,
            link: relativePath,
            idempotencyKey: `order-msg-notif:${publicId}:${order.ownerUserId}`,
            skipEmail: true,
          },
          tx,
        );

        if (await notifications.isCategoryEmailEnabled(tx, order.ownerUserId, "message")) {
          await mailer.enqueue(
            {
              template: MAIL_ORDER_MESSAGE_RECEIVED,
              to: { userId: order.ownerUserId },
              vars: {
                orderReference: order.reference,
                link: buildCanonicalPortalUrl(config.canonicalOrigin, relativePath),
              },
              idempotencyKey: `order-msg-mail:${publicId}:${order.ownerUserId}`,
            },
            tx,
          );
        }
      }

      const [created] = await tx
        .select()
        .from(engagementOrderMessages)
        .where(eq(engagementOrderMessages.id, messageId))
        .limit(1);
      return created!;
    });

    const [hydrated] = await hydrateMessages(principal, [committedRow]);
    return hydrated!;
  }

  async function markOrderRead(
    principal: SessionPrincipal,
    input: { orderId: string; upToMessageId?: string },
  ): Promise<{ markedCount: number }> {
    assertFullSession(principal);
    const orders = getOrdersPeer(deps);
    const order = await orders.assertCanReadOrder(principal, input.orderId);
    const allowInternal = canReadInternalNotes(principal);

    let maxMessageId: number | undefined;
    if (input.upToMessageId !== undefined) {
      if (!ULID_PATTERN.test(input.upToMessageId)) {
        throw notFound("MESSAGE_NOT_FOUND");
      }
      const [target] = await db
        .select({ id: engagementOrderMessages.id, visibility: engagementOrderMessages.visibility })
        .from(engagementOrderMessages)
        .where(
          and(
            eq(engagementOrderMessages.orderId, order.id),
            eq(engagementOrderMessages.publicId, input.upToMessageId),
          ),
        )
        .limit(1);
      if (!target || (!allowInternal && target.visibility !== "customer")) {
        throw notFound("MESSAGE_NOT_FOUND");
      }
      maxMessageId = target.id;
    }

    const candidates = await db
      .select({ id: engagementOrderMessages.id })
      .from(engagementOrderMessages)
      .where(
        and(
          eq(engagementOrderMessages.orderId, order.id),
          ne(engagementOrderMessages.authorUserId, principal.userId),
          allowInternal ? undefined : eq(engagementOrderMessages.visibility, "customer"),
          maxMessageId !== undefined ? lte(engagementOrderMessages.id, maxMessageId) : undefined,
        ),
      )
      .limit(500);

    if (candidates.length === 0) return { markedCount: 0 };

    const existingReads = await db
      .select({ messageId: engagementOrderMessageReads.messageId })
      .from(engagementOrderMessageReads)
      .where(
        and(
          eq(engagementOrderMessageReads.userId, principal.userId),
          inArray(
            engagementOrderMessageReads.messageId,
            candidates.map((c) => c.id),
          ),
        ),
      );
    const alreadyRead = new Set(existingReads.map((r) => r.messageId));
    const unreadIds = candidates.map((c) => c.id).filter((id) => !alreadyRead.has(id));
    if (unreadIds.length === 0) return { markedCount: 0 };

    const now = clock.now();
    await db
      .insert(engagementOrderMessageReads)
      .values(
        unreadIds.map((messageId) => ({
          messageId,
          orderId: order.id,
          userId: principal.userId,
          readAt: now,
        })),
      )
      .onDuplicateKeyUpdate({ set: { readAt: now } });

    return { markedCount: unreadIds.length };
  }

  async function unreadSummary(
    principal: SessionPrincipal,
    input: { orderId?: string } = {},
  ): Promise<{ totalUnread: number; byOrder: Record<string, number> }> {
    assertFullSession(principal);
    const orders = getOrdersPeer(deps);
    const allowInternal = canReadInternalNotes(principal);

    if (input.orderId !== undefined) {
      const order = await orders.assertCanReadOrder(principal, input.orderId);
      const msgs = await db
        .select({ id: engagementOrderMessages.id })
        .from(engagementOrderMessages)
        .where(
          and(
            eq(engagementOrderMessages.orderId, order.id),
            ne(engagementOrderMessages.authorUserId, principal.userId),
            allowInternal ? undefined : eq(engagementOrderMessages.visibility, "customer"),
          ),
        )
        .limit(500);
      if (msgs.length === 0) return { totalUnread: 0, byOrder: { [order.publicId]: 0 } };

      const reads = await db
        .select({ messageId: engagementOrderMessageReads.messageId })
        .from(engagementOrderMessageReads)
        .where(
          and(
            eq(engagementOrderMessageReads.userId, principal.userId),
            inArray(
              engagementOrderMessageReads.messageId,
              msgs.map((m) => m.id),
            ),
          ),
        );
      const readSet = new Set(reads.map((r) => r.messageId));
      const unread = msgs.filter((m) => !readSet.has(m.id)).length;
      return { totalUnread: unread, byOrder: { [order.publicId]: unread } };
    }

    const accessible = await orders.listAccessibleOrderIds(principal, { limit: 500 });
    if (!accessible.all && accessible.orderIds.length === 0) {
      return { totalUnread: 0, byOrder: {} };
    }

    const candidateMsgs = await db
      .select({
        id: engagementOrderMessages.id,
        orderId: engagementOrderMessages.orderId,
        orderPublicId: engagementOrderMessages.orderPublicId,
      })
      .from(engagementOrderMessages)
      .where(
        and(
          accessible.all ? undefined : inArray(engagementOrderMessages.orderId, accessible.orderIds),
          ne(engagementOrderMessages.authorUserId, principal.userId),
          allowInternal ? undefined : eq(engagementOrderMessages.visibility, "customer"),
        ),
      )
      .orderBy(desc(engagementOrderMessages.id))
      .limit(1000);

    if (candidateMsgs.length === 0) return { totalUnread: 0, byOrder: {} };

    const reads = await db
      .select({ messageId: engagementOrderMessageReads.messageId })
      .from(engagementOrderMessageReads)
      .where(
        and(
          eq(engagementOrderMessageReads.userId, principal.userId),
          inArray(
            engagementOrderMessageReads.messageId,
            candidateMsgs.map((m) => m.id),
          ),
        ),
      );
    const readSet = new Set(reads.map((r) => r.messageId));
    const unreadCandidates = candidateMsgs.filter((m) => !readSet.has(m.id));

    // Re-authorize every distinct orderId so revoked grants never leak unread counts.
    const verifiedOrders = new Map<number, string | null>();
    for (const msg of unreadCandidates) {
      if (verifiedOrders.has(msg.orderId)) continue;
      try {
        const view = await orders.assertCanReadOrderById(principal, msg.orderId);
        verifiedOrders.set(msg.orderId, view.publicId);
      } catch {
        verifiedOrders.set(msg.orderId, null);
      }
    }

    const byOrder: Record<string, number> = {};
    let totalUnread = 0;
    for (const msg of unreadCandidates) {
      const pubId = verifiedOrders.get(msg.orderId);
      if (!pubId) continue;
      byOrder[pubId] = (byOrder[pubId] ?? 0) + 1;
      totalUnread += 1;
    }

    return { totalUnread, byOrder };
  }

  async function markAllRead(principal: SessionPrincipal): Promise<{ markedCount: number }> {
    assertFullSession(principal);
    const orders = getOrdersPeer(deps);
    const allowInternal = canReadInternalNotes(principal);
    const accessible = await orders.listAccessibleOrderIds(principal, { limit: 500 });
    if (!accessible.all && accessible.orderIds.length === 0) return { markedCount: 0 };

    const candidateMsgs = await db
      .select({ id: engagementOrderMessages.id, orderId: engagementOrderMessages.orderId })
      .from(engagementOrderMessages)
      .where(
        and(
          accessible.all ? undefined : inArray(engagementOrderMessages.orderId, accessible.orderIds),
          ne(engagementOrderMessages.authorUserId, principal.userId),
          allowInternal ? undefined : eq(engagementOrderMessages.visibility, "customer"),
        ),
      )
      .orderBy(desc(engagementOrderMessages.id))
      .limit(1000);

    if (candidateMsgs.length === 0) return { markedCount: 0 };

    const reads = await db
      .select({ messageId: engagementOrderMessageReads.messageId })
      .from(engagementOrderMessageReads)
      .where(
        and(
          eq(engagementOrderMessageReads.userId, principal.userId),
          inArray(
            engagementOrderMessageReads.messageId,
            candidateMsgs.map((m) => m.id),
          ),
        ),
      );
    const readSet = new Set(reads.map((r) => r.messageId));
    const unread = candidateMsgs.filter((m) => !readSet.has(m.id));
    if (unread.length === 0) return { markedCount: 0 };

    // Re-authorize every distinct order before mutating read receipts.
    const verifiedOrderIds = new Set<number>();
    const checked = new Set<number>();
    for (const m of unread) {
      if (checked.has(m.orderId)) continue;
      checked.add(m.orderId);
      try {
        await orders.assertCanReadOrderById(principal, m.orderId);
        verifiedOrderIds.add(m.orderId);
      } catch {
        // Skip orders whose grant was revoked.
      }
    }

    const permittedUnread = unread.filter((m) => verifiedOrderIds.has(m.orderId));
    if (permittedUnread.length === 0) return { markedCount: 0 };

    const now = clock.now();
    await db
      .insert(engagementOrderMessageReads)
      .values(
        permittedUnread.map((m) => ({
          messageId: m.id,
          orderId: m.orderId,
          userId: principal.userId,
          readAt: now,
        })),
      )
      .onDuplicateKeyUpdate({ set: { readAt: now } });

    return { markedCount: permittedUnread.length };
  }

  async function threads(
    principal: SessionPrincipal,
    input: { unreadOnly?: boolean; cursor?: string; limit?: number } = {},
  ): Promise<{ items: OrderThreadSummaryView[]; nextCursor: string | null }> {
    assertFullSession(principal);
    const orders = getOrdersPeer(deps);
    const allowInternal = canReadInternalNotes(principal);
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
    const beforeId = decodeIdCursor(input.cursor);

    const accessible = await orders.listAccessibleOrderIds(principal, { limit: 500 });
    if (!accessible.all && accessible.orderIds.length === 0) {
      return { items: [], nextCursor: null };
    }

    const recentMessages = await db
      .select()
      .from(engagementOrderMessages)
      .where(
        and(
          accessible.all ? undefined : inArray(engagementOrderMessages.orderId, accessible.orderIds),
          allowInternal ? undefined : eq(engagementOrderMessages.visibility, "customer"),
          beforeId !== undefined ? lt(engagementOrderMessages.id, beforeId) : undefined,
        ),
      )
      .orderBy(desc(engagementOrderMessages.id))
      .limit(400);

    if (recentMessages.length === 0) return { items: [], nextCursor: null };

    const reads = await db
      .select({ messageId: engagementOrderMessageReads.messageId })
      .from(engagementOrderMessageReads)
      .where(
        and(
          eq(engagementOrderMessageReads.userId, principal.userId),
          inArray(
            engagementOrderMessageReads.messageId,
            recentMessages.map((m) => m.id),
          ),
        ),
      );
    const readSet = new Set(reads.map((r) => r.messageId));

    const latestByOrder = new Map<
      number,
      {
        latestRow: typeof engagementOrderMessages.$inferSelect;
        unreadCount: number;
      }
    >();
    for (const row of recentMessages) {
      const unread = row.authorUserId !== principal.userId && !readSet.has(row.id) ? 1 : 0;
      const existing = latestByOrder.get(row.orderId);
      if (!existing) {
        latestByOrder.set(row.orderId, { latestRow: row, unreadCount: unread });
      } else {
        existing.unreadCount += unread;
      }
    }

    const items: OrderThreadSummaryView[] = [];
    let lastIncludedMessageId: number | null = null;
    let hasMore = false;

    for (const [, entry] of latestByOrder) {
      if (input.unreadOnly && entry.unreadCount === 0) continue;
      if (items.length >= limit) {
        hasMore = true;
        break;
      }
      const { latestRow } = entry;
      try {
        const orderAccess = await orders.assertCanReadOrderById(principal, latestRow.orderId);
        let projectName = orderAccess.reference;
        let statusLabel = orderAccess.statusKey;
        if (orders.getOrderSummary) {
          try {
            const summary = await orders.getOrderSummary(principal, orderAccess.publicId);
            projectName = summary.projectName;
            statusLabel = summary.statusLabel;
          } catch {
            // Fallback to reference/statusKey if summary unavailable.
          }
        }
        const plainBody = crypto.decrypt(
          latestRow.bodyEnc,
          `engagement_order_messages.body:${latestRow.publicId}`,
        );
        items.push({
          orderPublicId: orderAccess.publicId,
          orderReference: orderAccess.reference,
          projectName,
          statusLabel,
          locked: orderAccess.locked,
          lastMessageAt: latestRow.createdAt,
          lastMessagePreview: truncateSnippet(plainBody, 120),
          lastAuthorRole: latestRow.authorRole,
          unreadCount: entry.unreadCount,
        });
        lastIncludedMessageId = latestRow.id;
      } catch {
        // Order access revoked — omit silently.
      }
    }

    return {
      items,
      nextCursor: hasMore && lastIncludedMessageId !== null ? encodeIdCursor(lastIncludedMessageId) : null,
    };
  }

  async function adminInbox(
    principal: SessionPrincipal,
    input: {
      unreadOnly?: boolean;
      orderId?: string;
      visibility?: OrderMessageVisibility;
      cursor?: string;
      limit?: number;
    } = {},
  ): Promise<{ items: OrderMessageView[]; nextCursor: string | null }> {
    assertFullSession(principal);
    if (!canReadInternalNotes(principal)) {
      throw forbidden("CAPABILITY_NOT_GRANTED");
    }
    const orders = getOrdersPeer(deps);
    let filterOrderId: number | undefined;
    if (input.orderId !== undefined) {
      const order = await orders.assertCanReadOrder(principal, input.orderId);
      filterOrderId = order.id;
    }

    const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
    const beforeId = decodeIdCursor(input.cursor);

    const rows = await db
      .select()
      .from(engagementOrderMessages)
      .where(
        and(
          filterOrderId !== undefined ? eq(engagementOrderMessages.orderId, filterOrderId) : undefined,
          input.visibility !== undefined ? eq(engagementOrderMessages.visibility, input.visibility) : undefined,
          beforeId !== undefined ? lt(engagementOrderMessages.id, beforeId) : undefined,
        ),
      )
      .orderBy(desc(engagementOrderMessages.id))
      .limit(limit * 2 + 1);

    // Re-authorize every distinct order in the candidate slice.
    const verifiedOrderIds = new Map<number, boolean>();
    const authorizedRows: (typeof engagementOrderMessages.$inferSelect)[] = [];
    for (const row of rows) {
      if (!verifiedOrderIds.has(row.orderId)) {
        try {
          await orders.assertCanReadOrderById(principal, row.orderId);
          verifiedOrderIds.set(row.orderId, true);
        } catch {
          verifiedOrderIds.set(row.orderId, false);
        }
      }
      if (verifiedOrderIds.get(row.orderId)) {
        authorizedRows.push(row);
      }
    }

    const hydrated = await hydrateMessages(principal, authorizedRows);
    const filtered = input.unreadOnly ? hydrated.filter((m) => m.unread) : hydrated;
    const slice = filtered.slice(0, limit);
    const lastItem = slice[slice.length - 1];
    const lastRow = lastItem ? authorizedRows.find((r) => r.publicId === lastItem.publicId) : undefined;
    const nextCursor = filtered.length > limit && lastRow ? encodeIdCursor(lastRow.id) : null;

    return { items: slice, nextCursor };
  }

  return {
    listByOrder,
    send,
    markOrderRead,
    markAllRead,
    unreadSummary,
    threads,
    adminInbox,
  };
}

export type MessagesService = ReturnType<typeof createMessagesService>;
