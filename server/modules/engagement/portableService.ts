import { and, asc, eq, gt, inArray } from "drizzle-orm";
import type { UserRole } from "../../../shared/domain.js";
import type { ModuleDeps } from "../../container.js";
import { validation } from "../../core/errors.js";
import { ULID_PATTERN, ulid } from "../../core/ids.js";
import type { DbOrTx, Tx } from "../../core/types.js";
import {
  engagementImportProvenance,
  engagementOrderMessageAttachments,
  engagementOrderMessages,
  engagementSearchTokens,
  engagementSupportTicketHistory,
  engagementSupportTicketMessages,
  engagementSupportTickets,
} from "./schema.js";
import { computeSearchTokenHashes, normalizePlainText } from "./textAndSearch.js";
import { generateTicketNumber } from "./ticketsService.js";
import type {
  ImportOrderMessageInput,
  ImportTicketInput,
  PortableOrderMessageItem,
  PortableTicketItem,
} from "./types.js";

function boundedCollectorLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw validation("INVALID_COLLECTOR_LIMIT", "Portable collector limit must be an integer between 1 and 200.");
  }
  return limit;
}

function validateAfterUlid(after: string | null | undefined): string | undefined {
  if (after === undefined || after === null) return undefined;
  if (!ULID_PATTERN.test(after)) {
    throw validation("INVALID_COLLECTOR_CURSOR", "Portable collector cursor must be a valid ULID.");
  }
  return after;
}

export function createPortableEngagementService(deps: ModuleDeps) {
  const { crypto, clock, audit } = deps;

  async function portableOrderMessages(
    tx: DbOrTx,
    input: { orderPublicIds: readonly string[]; afterPublicId?: string | null; limit: number },
  ): Promise<{ items: PortableOrderMessageItem[]; nextAfter: string | null }> {
    const limit = boundedCollectorLimit(input.limit);
    const after = validateAfterUlid(input.afterPublicId);
    if (input.orderPublicIds.length === 0) {
      return { items: [], nextAfter: null };
    }
    if (input.orderPublicIds.length > 500) {
      throw validation("TOO_MANY_ORDERS", "Select at most 500 orders per portable batch.");
    }
    for (const id of input.orderPublicIds) {
      if (!ULID_PATTERN.test(id)) {
        throw validation("INVALID_ORDER_ID", "One or more order identifiers are invalid.");
      }
    }

    // Security invariant: ONLY customer-visible messages (`visibility = "customer"`) are exported.
    const rows = await tx
      .select()
      .from(engagementOrderMessages)
      .where(
        and(
          inArray(engagementOrderMessages.orderPublicId, [...input.orderPublicIds]),
          eq(engagementOrderMessages.visibility, "customer"),
          after !== undefined ? gt(engagementOrderMessages.publicId, after) : undefined,
        ),
      )
      .orderBy(asc(engagementOrderMessages.publicId))
      .limit(limit + 1);

    const slice = rows.slice(0, limit);
    if (slice.length === 0) return { items: [], nextAfter: null };

    const attRows = await tx
      .select()
      .from(engagementOrderMessageAttachments)
      .where(
        inArray(
          engagementOrderMessageAttachments.messageId,
          slice.map((r) => r.id),
        ),
      )
      .orderBy(asc(engagementOrderMessageAttachments.sortOrder));

    const attMap = new Map<number, string[]>();
    for (const att of attRows) {
      const list = attMap.get(att.messageId) ?? [];
      list.push(att.filePublicId);
      attMap.set(att.messageId, list);
    }

    const items: PortableOrderMessageItem[] = slice.map((row) => ({
      publicId: row.publicId,
      orderPublicId: row.orderPublicId,
      authorUserPublicId: row.authorUserPublicId,
      authorRole: row.authorRole,
      body: crypto.decrypt(row.bodyEnc, `engagement_order_messages.body:${row.publicId}`),
      attachmentFilePublicIds: attMap.get(row.id) ?? [],
      createdAt: row.createdAt,
    }));

    return {
      items,
      nextAfter: rows.length > limit ? slice[slice.length - 1]!.publicId : null,
    };
  }

  async function portableTickets(
    tx: DbOrTx,
    input: {
      customerUserIds?: readonly number[];
      orderPublicIds?: readonly string[];
      afterPublicId?: string | null;
      limit: number;
    },
  ): Promise<{ items: PortableTicketItem[]; nextAfter: string | null }> {
    const limit = boundedCollectorLimit(input.limit);
    const after = validateAfterUlid(input.afterPublicId);

    if (
      (input.customerUserIds !== undefined && input.customerUserIds.length === 0) ||
      (input.orderPublicIds !== undefined && input.orderPublicIds.length === 0)
    ) {
      return { items: [], nextAfter: null };
    }
    if (input.customerUserIds && input.customerUserIds.length > 500) {
      throw validation("TOO_MANY_CUSTOMERS", "Select at most 500 customers per portable batch.");
    }
    if (input.orderPublicIds && input.orderPublicIds.length > 500) {
      throw validation("TOO_MANY_ORDERS", "Select at most 500 orders per portable batch.");
    }

    const rows = await tx
      .select()
      .from(engagementSupportTickets)
      .where(
        and(
          input.customerUserIds
            ? inArray(engagementSupportTickets.requesterUserId, [...input.customerUserIds])
            : undefined,
          input.orderPublicIds
            ? inArray(engagementSupportTickets.relatedOrderPublicId, [...input.orderPublicIds])
            : undefined,
          after !== undefined ? gt(engagementSupportTickets.publicId, after) : undefined,
        ),
      )
      .orderBy(asc(engagementSupportTickets.publicId))
      .limit(limit + 1);

    const slice = rows.slice(0, limit);
    if (slice.length === 0) return { items: [], nextAfter: null };

    const ticketIds = slice.map((r) => r.id);
    // Security invariant: internal staff notes (`internalOnly = true`) are NEVER exported.
    const [replyRows, historyRows] = await Promise.all([
      tx
        .select()
        .from(engagementSupportTicketMessages)
        .where(
          and(
            inArray(engagementSupportTicketMessages.ticketId, ticketIds),
            eq(engagementSupportTicketMessages.internalOnly, false),
          ),
        )
        .orderBy(asc(engagementSupportTicketMessages.id)),
      tx
        .select()
        .from(engagementSupportTicketHistory)
        .where(inArray(engagementSupportTicketHistory.ticketId, ticketIds))
        .orderBy(asc(engagementSupportTicketHistory.id)),
    ]);

    const repliesByTicket = new Map<number, typeof replyRows>();
    for (const r of replyRows) {
      const list = repliesByTicket.get(r.ticketId) ?? [];
      list.push(r);
      repliesByTicket.set(r.ticketId, list);
    }

    const historyByTicket = new Map<number, typeof historyRows>();
    for (const h of historyRows) {
      const list = historyByTicket.get(h.ticketId) ?? [];
      list.push(h);
      historyByTicket.set(h.ticketId, list);
    }

    const items: PortableTicketItem[] = slice.map((row) => ({
      publicId: row.publicId,
      ticketNumber: row.ticketNumber,
      requesterUserPublicId: row.requesterUserPublicId,
      relatedOrderPublicId: row.relatedOrderPublicId,
      category: row.category,
      status: row.status,
      priority: row.priority,
      subject: crypto.decrypt(row.subjectEnc, `engagement_support_tickets.subject:${row.publicId}`),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      resolvedAt: row.resolvedAt,
      closedAt: row.closedAt,
      replies: (repliesByTicket.get(row.id) ?? []).map((r) => ({
        publicId: r.publicId,
        authorUserPublicId: r.authorUserPublicId,
        authorRole: r.authorRole,
        body: crypto.decrypt(r.bodyEnc, `engagement_support_ticket_messages.body:${r.publicId}`),
        createdAt: r.createdAt,
      })),
      statusHistory: (historyByTicket.get(row.id) ?? []).map((h) => ({
        publicId: h.publicId,
        fromStatus: h.fromStatus,
        toStatus: h.toStatus,
        actorRole: h.actorRole as UserRole | "system",
        reasonCode: h.reasonCode,
        occurredAt: h.occurredAt,
      })),
    }));

    return {
      items,
      nextAfter: rows.length > limit ? slice[slice.length - 1]!.publicId : null,
    };
  }

  /**
   * Idempotent import of a historical customer-visible order message.
   * Preserves `createdAt` verbatim and NEVER triggers notifications or outbound mail.
   */
  async function importOrderMessage(
    input: ImportOrderMessageInput,
    tx: Tx,
  ): Promise<{ publicId: string; created: boolean }> {
    if (!ULID_PATTERN.test(input.sourcePublicId) || !ULID_PATTERN.test(input.targetOrderPublicId)) {
      throw validation("INVALID_IMPORT_ID", "Imported message and order identifiers must be valid ULIDs.");
    }
    const body = normalizePlainText(input.body, {
      min: 1,
      max: 10000,
      field: "body",
      label: "imported message body",
    });

    const [alreadyImported] = await tx
      .select()
      .from(engagementImportProvenance)
      .where(
        and(
          eq(engagementImportProvenance.entityType, "order_message"),
          eq(engagementImportProvenance.sourceInstallationId, input.sourceInstallationId),
          eq(engagementImportProvenance.sourcePublicId, input.sourcePublicId),
        ),
      )
      .limit(1)
      .for("update");

    if (alreadyImported) {
      return { publicId: alreadyImported.targetPublicId, created: false };
    }

    // Preserve source publicId unless already occupied on target installation.
    const [publicIdClash] = await tx
      .select({ id: engagementOrderMessages.id })
      .from(engagementOrderMessages)
      .where(eq(engagementOrderMessages.publicId, input.sourcePublicId))
      .limit(1);
    const targetPublicId = publicIdClash ? ulid(clock.now().getTime()) : input.sourcePublicId;

    const [header] = await tx.insert(engagementOrderMessages).values({
      publicId: targetPublicId,
      orderId: input.targetOrderId,
      orderPublicId: input.targetOrderPublicId,
      orderReference: input.targetOrderReference.trim().toUpperCase(),
      authorUserId: input.authorUserId,
      authorUserPublicId: input.authorUserPublicId,
      authorRole: input.authorRole,
      visibility: "customer",
      bodyEnc: crypto.encrypt(body, `engagement_order_messages.body:${targetPublicId}`),
      idempotencyKey: null,
      origin: "import",
      createdAt: input.createdAt,
    });
    const messageId = Number(header.insertId);

    const attachments = input.attachmentFilePublicIds ?? [];
    if (attachments.length > 0) {
      await tx.insert(engagementOrderMessageAttachments).values(
        attachments.slice(0, 10).map((filePublicId, idx) => ({
          messageId,
          filePublicId,
          sortOrder: idx,
          createdAt: input.createdAt,
        })),
      );
    }

    const tokenHashes = computeSearchTokenHashes(crypto, [body]);
    if (tokenHashes.length > 0) {
      await tx.insert(engagementSearchTokens).values(
        tokenHashes.map((tokenHash) => ({
          domain: "order_message" as const,
          recordId: messageId,
          customerVisible: true,
          tokenHash,
        })),
      );
    }

    await tx.insert(engagementImportProvenance).values({
      entityType: "order_message",
      sourceInstallationId: input.sourceInstallationId,
      sourcePublicId: input.sourcePublicId,
      sourceReference: input.targetOrderReference,
      targetId: messageId,
      targetPublicId,
      importId: input.importId,
      importedAt: clock.now(),
    });

    await audit.record(
      {
        category: "portable_transfer",
        eventName: "engagement.message.imported",
        action: "import",
        outcome: "completed",
        resource: { type: "order_message", publicId: targetPublicId },
        importId: input.importId,
        attributes: {
          orderPublicId: input.targetOrderPublicId,
          preservedPublicId: targetPublicId === input.sourcePublicId,
        },
      },
      tx,
    );

    return { publicId: targetPublicId, created: true };
  }

  /**
   * Idempotent import of a historical support ticket + customer-visible replies/history.
   * Preserves original timestamps verbatim and NEVER triggers notifications or outbound mail.
   */
  async function importTicket(
    input: ImportTicketInput,
    tx: Tx,
  ): Promise<{ publicId: string; ticketNumber: string; created: boolean }> {
    if (!ULID_PATTERN.test(input.sourcePublicId)) {
      throw validation("INVALID_IMPORT_ID", "Imported ticket identifier must be a valid ULID.");
    }
    const subject = normalizePlainText(input.subject, {
      min: 1,
      max: 190,
      field: "subject",
      label: "imported ticket subject",
      singleLine: true,
    });

    const [alreadyImported] = await tx
      .select()
      .from(engagementImportProvenance)
      .where(
        and(
          eq(engagementImportProvenance.entityType, "ticket"),
          eq(engagementImportProvenance.sourceInstallationId, input.sourceInstallationId),
          eq(engagementImportProvenance.sourcePublicId, input.sourcePublicId),
        ),
      )
      .limit(1)
      .for("update");

    if (alreadyImported) {
      const [existingTicket] = await tx
        .select({ ticketNumber: engagementSupportTickets.ticketNumber })
        .from(engagementSupportTickets)
        .where(eq(engagementSupportTickets.id, alreadyImported.targetId))
        .limit(1);
      return {
        publicId: alreadyImported.targetPublicId,
        ticketNumber: existingTicket?.ticketNumber ?? input.sourceTicketNumber,
        created: false,
      };
    }

    const [publicIdClash] = await tx
      .select({ id: engagementSupportTickets.id })
      .from(engagementSupportTickets)
      .where(eq(engagementSupportTickets.publicId, input.sourcePublicId))
      .limit(1);
    const targetPublicId = publicIdClash ? ulid(clock.now().getTime()) : input.sourcePublicId;

    const normalizedSourceTicketNum = input.sourceTicketNumber.trim().toUpperCase();
    const [numberClash] = await tx
      .select({ id: engagementSupportTickets.id })
      .from(engagementSupportTickets)
      .where(eq(engagementSupportTickets.ticketNumber, normalizedSourceTicketNum))
      .limit(1);
    const targetTicketNumber = numberClash ? generateTicketNumber(clock.now()) : normalizedSourceTicketNum;

    const lastReplyAt =
      input.replies.length > 0
        ? input.replies.reduce((max, r) => (r.createdAt > max ? r.createdAt : max), input.createdAt)
        : input.createdAt;

    const [header] = await tx.insert(engagementSupportTickets).values({
      publicId: targetPublicId,
      ticketNumber: targetTicketNumber,
      requesterUserId: input.requesterUserId,
      requesterUserPublicId: input.requesterUserPublicId,
      relatedOrderId: input.relatedOrderId ?? null,
      relatedOrderPublicId: input.relatedOrderPublicId ?? null,
      relatedOrderReference: null,
      assigneeUserId: null,
      assigneeUserPublicId: null,
      category: input.category,
      status: input.status,
      priority: input.priority,
      subjectEnc: crypto.encrypt(subject, `engagement_support_tickets.subject:${targetPublicId}`),
      idempotencyKey: null,
      origin: "import",
      lastMessageAt: lastReplyAt,
      resolvedAt: input.resolvedAt ?? null,
      closedAt: input.closedAt ?? null,
      createdAt: input.createdAt,
      updatedAt: lastReplyAt,
    });
    const ticketId = Number(header.insertId);

    const searchTexts: string[] = [subject];
    for (const reply of input.replies) {
      const replyBody = normalizePlainText(reply.body, {
        min: 1,
        max: 10000,
        field: "replyBody",
        label: "imported ticket reply",
      });
      searchTexts.push(replyBody);
      const [replyClash] = await tx
        .select({ id: engagementSupportTicketMessages.id })
        .from(engagementSupportTicketMessages)
        .where(eq(engagementSupportTicketMessages.publicId, reply.sourcePublicId))
        .limit(1);
      const replyPublicId = replyClash ? ulid(clock.now().getTime()) : reply.sourcePublicId;
      await tx.insert(engagementSupportTicketMessages).values({
        publicId: replyPublicId,
        ticketId,
        authorUserId: reply.authorUserId,
        authorUserPublicId: reply.authorUserPublicId,
        authorRole: reply.authorRole,
        internalOnly: false,
        bodyEnc: crypto.encrypt(replyBody, `engagement_support_ticket_messages.body:${replyPublicId}`),
        idempotencyKey: null,
        createdAt: reply.createdAt,
      });
    }

    for (const hist of input.statusHistory ?? []) {
      await tx.insert(engagementSupportTicketHistory).values({
        publicId: ulid(clock.now().getTime()),
        ticketId,
        actorUserId: null,
        actorRole: hist.actorRole,
        fromStatus: hist.fromStatus,
        toStatus: hist.toStatus,
        reasonCode: hist.reasonCode ?? "IMPORTED_HISTORY",
        occurredAt: hist.occurredAt,
      });
    }

    const tokenHashes = computeSearchTokenHashes(crypto, searchTexts);
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

    await tx.insert(engagementImportProvenance).values({
      entityType: "ticket",
      sourceInstallationId: input.sourceInstallationId,
      sourcePublicId: input.sourcePublicId,
      sourceReference: input.sourceTicketNumber,
      targetId: ticketId,
      targetPublicId,
      importId: input.importId,
      importedAt: clock.now(),
    });

    await audit.record(
      {
        category: "portable_transfer",
        eventName: "engagement.ticket.imported",
        action: "import",
        outcome: "completed",
        resource: { type: "ticket", publicId: targetPublicId },
        importId: input.importId,
        safeCounts: { replies: input.replies.length },
        attributes: {
          ticketNumber: targetTicketNumber,
          referenceRemapped: targetTicketNumber !== input.sourceTicketNumber,
        },
      },
      tx,
    );

    return { publicId: targetPublicId, ticketNumber: targetTicketNumber, created: true };
  }

  return {
    portableOrderMessages,
    portableEvidence: (tx: DbOrTx, orderIds: readonly string[], after: string | null, limit: number) =>
      portableOrderMessages(tx, { orderPublicIds: orderIds, afterPublicId: after, limit }),
    portableTickets,
    importOrderMessage,
    importTicket,
  };
}

export type PortableEngagementService = ReturnType<typeof createPortableEngagementService>;
