/**
 * Increment 04 (Package H): Public API v1 `tickets` provider (`engagement`).
 * Caller is an API-key service principal (`ApiCaller`).
 * - `list`: keyset-paginated newest-first, bounded to 100, filters `customerId`, `status`, `updatedSince`.
 * - `get`: returns `TicketDto | null`.
 * - `create`: creates an `open` customer support ticket, supports `caller.idempotencyKey`, and audits
 *   inside the transaction with `actor: { role: "system" }` and `correlationId: caller.requestId`.
 */
import { and, desc, eq, gte, lt } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import { conflict, notFound, validation } from "../../core/errors.js";
import { ULID_PATTERN, ulid } from "../../core/ids.js";
import type { Tx } from "../../core/types.js";
import { users } from "../identity/schema.js";
import type {
  ApiCaller,
  ApiListQuery,
  ApiPage,
  PublicApiProviders,
  TicketDto,
} from "../publicApi/ports.js";
import { getOrdersPeer } from "./peers.js";
import {
  engagementSearchTokens,
  engagementSupportTicketHistory,
  engagementSupportTicketMessages,
  engagementSupportTickets,
} from "./schema.js";
import {
  computeSearchTokenHashes,
  decodeIdCursor,
  encodeIdCursor,
  normalizePlainText,
} from "./textAndSearch.js";
import { generateTicketNumber } from "./ticketsService.js";
import { TICKET_STATUSES, type TicketStatus } from "./types.js";

function isDuplicateKeyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const anyErr = err as { code?: string; errno?: number; cause?: { code?: string; errno?: number } };
  return (
    anyErr.code === "ER_DUP_ENTRY" ||
    anyErr.errno === 1062 ||
    anyErr.cause?.code === "ER_DUP_ENTRY" ||
    anyErr.cause?.errno === 1062
  );
}

export function createTicketsApiProvider(deps: ModuleDeps): PublicApiProviders["tickets"] {
  const { db, clock, crypto, audit } = deps;

  function toTicketDto(row: typeof engagementSupportTickets.$inferSelect): TicketDto {
    let subject = "(unable to decrypt subject)";
    try {
      subject = crypto.decrypt(row.subjectEnc, `engagement_support_tickets.subject:${row.publicId}`);
    } catch {
      // Fallback
    }
    return {
      id: row.publicId,
      number: row.ticketNumber,
      customerId: row.requesterUserPublicId,
      orderId: row.relatedOrderPublicId ?? null,
      subject: subject.slice(0, 200),
      status: row.status,
      priority: row.priority,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function allocateUniqueTicketNumber(tx: Tx, now: Date): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = generateTicketNumber(now);
      const [dup] = await tx
        .select({ id: engagementSupportTickets.id })
        .from(engagementSupportTickets)
        .where(eq(engagementSupportTickets.ticketNumber, candidate))
        .limit(1);
      if (!dup) return candidate;
    }
    throw conflict("TICKET_NUMBER_COLLISION", "Could not allocate a unique ticket number. Please retry.");
  }

  return {
    async list(query: ApiListQuery, _caller: ApiCaller): Promise<ApiPage<TicketDto>> {
      const limit = Math.min(Math.max(query.limit, 1), 100);
      const beforeId = query.cursor ? decodeIdCursor(query.cursor) : undefined;
      if (query.cursor && beforeId === undefined) {
        throw validation("INVALID_CURSOR", "The pagination cursor is invalid.");
      }

      const customerId = query.filter.customerId?.trim();
      if (customerId && !ULID_PATTERN.test(customerId)) {
        throw validation("INVALID_CUSTOMER_ID", "Customer ID filter must be a valid ULID.");
      }

      const statusRaw = query.filter.status?.trim();
      let statusFilter: TicketStatus | undefined;
      if (statusRaw) {
        if (!(TICKET_STATUSES as readonly string[]).includes(statusRaw)) {
          throw validation("INVALID_TICKET_STATUS", "Unsupported ticket status filter.");
        }
        statusFilter = statusRaw as TicketStatus;
      }

      const rows = await db
        .select()
        .from(engagementSupportTickets)
        .where(
          and(
            customerId ? eq(engagementSupportTickets.requesterUserPublicId, customerId) : undefined,
            statusFilter ? eq(engagementSupportTickets.status, statusFilter) : undefined,
            query.updatedSince ? gte(engagementSupportTickets.updatedAt, query.updatedSince) : undefined,
            beforeId !== undefined ? lt(engagementSupportTickets.id, beforeId) : undefined,
          ),
        )
        .orderBy(desc(engagementSupportTickets.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const slice = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? encodeIdCursor(slice[slice.length - 1]!.id) : null;

      return {
        items: slice.map(toTicketDto),
        nextCursor,
      };
    },

    async get(publicId: string, _caller: ApiCaller): Promise<TicketDto | null> {
      if (!ULID_PATTERN.test(publicId)) return null;
      const [row] = await db
        .select()
        .from(engagementSupportTickets)
        .where(eq(engagementSupportTickets.publicId, publicId))
        .limit(1);
      if (!row) return null;
      return toTicketDto(row);
    },

    async create(
      input: { customerId: string; orderId?: string; subject: string; body: string },
      caller: ApiCaller,
    ): Promise<TicketDto> {
      const subject = normalizePlainText(input.subject, {
        min: 1,
        max: 200,
        field: "subject",
        label: "ticket subject",
        singleLine: true,
      });
      const body = normalizePlainText(input.body, {
        min: 1,
        max: 10_000,
        field: "body",
        label: "ticket body",
      });

      const scopedIdemKey = caller.idempotencyKey
        ? `api:${caller.keyPublicId}:${caller.idempotencyKey}`.slice(0, 128)
        : `api-req:${caller.requestId}`.slice(0, 128);

      const tokenHashes = computeSearchTokenHashes(crypto, [subject, body]);

      return db.transaction(async (tx) => {
        const [customer] = await tx
          .select({
            id: users.id,
            publicId: users.publicId,
            role: users.role,
            status: users.status,
          })
          .from(users)
          .where(eq(users.publicId, input.customerId))
          .limit(1)
          .for("share");

        if (!customer || customer.role !== "customer") {
          throw notFound("CUSTOMER_NOT_FOUND");
        }
        if (customer.status !== "active") {
          throw validation("CUSTOMER_INACTIVE", "Target customer account is not active.");
        }

        const [existing] = await tx
          .select()
          .from(engagementSupportTickets)
          .where(
            and(
              eq(engagementSupportTickets.requesterUserId, customer.id),
              eq(engagementSupportTickets.idempotencyKey, scopedIdemKey),
            ),
          )
          .limit(1);
        if (existing) {
          return toTicketDto(existing);
        }

        let relatedOrder: { id: number; publicId: string; reference: string } | null = null;
        if (input.orderId) {
          const orders = getOrdersPeer(deps);
          const ref = await orders.getOrderRefByPublicId(input.orderId, tx);
          if (!ref || ref.ownerUserId !== customer.id) {
            throw notFound("ORDER_NOT_FOUND");
          }
          relatedOrder = {
            id: ref.id,
            publicId: ref.publicId,
            reference: ref.reference,
          };
        }

        const now = clock.now();
        const ticketPublicId = ulid(now.getTime());
        const ticketNumber = await allocateUniqueTicketNumber(tx, now);
        const subjectEnc = crypto.encrypt(
          subject,
          `engagement_support_tickets.subject:${ticketPublicId}`,
        );

        let ticketId: number;
        try {
          const [ins] = await tx.insert(engagementSupportTickets).values({
            publicId: ticketPublicId,
            ticketNumber,
            requesterUserId: customer.id,
            requesterUserPublicId: customer.publicId,
            relatedOrderId: relatedOrder?.id ?? null,
            relatedOrderPublicId: relatedOrder?.publicId ?? null,
            relatedOrderReference: relatedOrder ? relatedOrder.reference.trim().toUpperCase() : null,
            assigneeUserId: null,
            assigneeUserPublicId: null,
            category: relatedOrder ? "order" : "general",
            status: "open",
            priority: "normal",
            subjectEnc,
            idempotencyKey: scopedIdemKey,
            origin: "portal",
            lastMessageAt: now,
            resolvedAt: null,
            closedAt: null,
            createdAt: now,
            updatedAt: now,
          });
          ticketId = Number(ins.insertId);
        } catch (err) {
          if (isDuplicateKeyError(err)) {
            const [concurrent] = await tx
              .select()
              .from(engagementSupportTickets)
              .where(
                and(
                  eq(engagementSupportTickets.requesterUserId, customer.id),
                  eq(engagementSupportTickets.idempotencyKey, scopedIdemKey),
                ),
              )
              .limit(1);
            if (concurrent) return toTicketDto(concurrent);
          }
          throw err;
        }

        const msgPublicId = ulid(now.getTime() + 1);
        await tx.insert(engagementSupportTicketMessages).values({
          publicId: msgPublicId,
          ticketId,
          authorUserId: customer.id,
          authorUserPublicId: customer.publicId,
          authorRole: "customer",
          internalOnly: false,
          bodyEnc: crypto.encrypt(
            body,
            `engagement_support_ticket_messages.body:${msgPublicId}`,
          ),
          idempotencyKey: scopedIdemKey,
          createdAt: now,
        });

        await tx.insert(engagementSupportTicketHistory).values({
          publicId: ulid(now.getTime() + 2),
          ticketId,
          actorUserId: customer.id,
          actorRole: "system",
          fromStatus: null,
          toStatus: "open",
          reasonCode: "TICKET_CREATED_BY_PUBLIC_API",
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
            correlationId: caller.requestId,
            resource: { type: "ticket", publicId: ticketPublicId },
            attributes: {
              ticket_number: ticketNumber,
              source: "public_api_v1",
              api_key_public_id: caller.keyPublicId,
              has_related_order: relatedOrder !== null,
            },
          },
          tx,
        );

        const [createdRow] = await tx
          .select()
          .from(engagementSupportTickets)
          .where(eq(engagementSupportTickets.id, ticketId))
          .limit(1);

        return toTicketDto(createdRow!);
      });
    },
  };
}
