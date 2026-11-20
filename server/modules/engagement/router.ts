/**
 * Engagement module — tRPC router (mounted at `trpc.engagement.*`). Owner: engagement module engineer.
 * Uses strict Zod 4 input validation (`z.strictObject`), capability gates, and per-row service authorization.
 */
import { z } from "zod";
import { ULID_PATTERN } from "../../core/ids.js";
import {
  protectedProcedure,
  requireCapability,
  router,
  staffProcedure,
} from "../../trpc/trpc.js";
import {
  NOTIFICATION_PREFERENCE_CATEGORIES,
  ORDER_MESSAGE_VISIBILITIES,
  SEARCH_DOMAINS,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
} from "./types.js";

const ulidSchema = z
  .string()
  .trim()
  .regex(ULID_PATTERN, "Expected a valid resource identifier.");

const cursorSchema = z.string().trim().min(1).max(64);

const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8, "Idempotency key must be at least 8 characters.")
  .max(128, "Idempotency key must be at most 128 characters.")
  .regex(/^[A-Za-z0-9_.:-]+$/, "Idempotency key contains unsupported characters.");

const messagesRouter = router({
  listByOrder: protectedProcedure
    .input(
      z.strictObject({
        orderId: ulidSchema,
        cursor: cursorSchema.optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
    )
    .query(({ ctx, input }) => ctx.services.engagement.messages.listByOrder(ctx.session, input)),

  threads: protectedProcedure
    .input(
      z
        .strictObject({
          unreadOnly: z.boolean().optional(),
          cursor: cursorSchema.optional(),
          limit: z.number().int().min(1).max(50).optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => ctx.services.engagement.messages.threads(ctx.session, input ?? {})),

  unreadSummary: protectedProcedure
    .input(
      z
        .strictObject({
          orderId: ulidSchema.optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => ctx.services.engagement.messages.unreadSummary(ctx.session, input ?? {})),

  send: protectedProcedure
    .meta({ rateLimit: "form_submission" })
    .input(
      z.strictObject({
        orderId: ulidSchema,
        body: z.string().min(1).max(4000),
        visibility: z.enum(ORDER_MESSAGE_VISIBILITIES).optional(),
        attachmentFileIds: z.array(ulidSchema).max(10).optional(),
        idempotencyKey: idempotencyKeySchema,
      }),
    )
    .mutation(({ ctx, input }) => ctx.services.engagement.messages.send(ctx.session, input)),

  markOrderRead: protectedProcedure
    .input(
      z.strictObject({
        orderId: ulidSchema,
        upToMessageId: ulidSchema.optional(),
      }),
    )
    .mutation(({ ctx, input }) => ctx.services.engagement.messages.markOrderRead(ctx.session, input)),

  markAllRead: protectedProcedure
    .input(z.strictObject({}).optional())
    .mutation(({ ctx }) => ctx.services.engagement.messages.markAllRead(ctx.session)),

  adminInbox: staffProcedure
    .use(requireCapability("messages.read_all"))
    .input(
      z
        .strictObject({
          unreadOnly: z.boolean().optional(),
          orderId: ulidSchema.optional(),
          visibility: z.enum(ORDER_MESSAGE_VISIBILITIES).optional(),
          cursor: cursorSchema.optional(),
          limit: z.number().int().min(1).max(100).optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => ctx.services.engagement.messages.adminInbox(ctx.session, input ?? {})),
});

const ticketsAdminRouter = router({
  list: staffProcedure
    .use(requireCapability("tickets.read_all"))
    .input(
      z
        .strictObject({
          status: z.enum(TICKET_STATUSES).optional(),
          priority: z.enum(TICKET_PRIORITIES).optional(),
          category: z.enum(TICKET_CATEGORIES).optional(),
          assignedToMe: z.boolean().optional(),
          unassignedOnly: z.boolean().optional(),
          customerId: ulidSchema.optional(),
          cursor: cursorSchema.optional(),
          limit: z.number().int().min(1).max(100).optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => ctx.services.engagement.tickets.adminList(ctx.session, input ?? {})),

  queueSummary: staffProcedure
    .use(requireCapability("tickets.read_all"))
    .input(z.strictObject({}).optional())
    .query(({ ctx }) => ctx.services.engagement.tickets.adminQueueSummary(ctx.session)),

  get: staffProcedure
    .use(requireCapability("tickets.read_all"))
    .input(
      z.strictObject({
        ticketId: ulidSchema,
        replyCursor: cursorSchema.optional(),
        replyLimit: z.number().int().min(1).max(100).optional(),
      }),
    )
    .query(({ ctx, input }) =>
      ctx.services.engagement.tickets.adminGet(ctx.session, input.ticketId, {
        replyCursor: input.replyCursor,
        replyLimit: input.replyLimit,
      }),
    ),

  reply: staffProcedure
    .use(requireCapability("tickets.manage"))
    .meta({ rateLimit: "form_submission" })
    .input(
      z.strictObject({
        ticketId: ulidSchema,
        body: z.string().min(1).max(8000),
        internalOnly: z.boolean().optional(),
        nextStatus: z.enum(TICKET_STATUSES).optional(),
        idempotencyKey: idempotencyKeySchema,
      }),
    )
    .mutation(({ ctx, input }) => ctx.services.engagement.tickets.adminReply(ctx.session, input)),

  setStatus: staffProcedure
    .use(requireCapability("tickets.manage"))
    .input(
      z.strictObject({
        ticketId: ulidSchema,
        toStatus: z.enum(TICKET_STATUSES),
        reasonCode: z
          .string()
          .trim()
          .min(2)
          .max(64)
          .regex(/^[A-Z0-9_]+$/, "Reason code must be uppercase letters, digits, or underscores.")
          .optional(),
      }),
    )
    .mutation(({ ctx, input }) => ctx.services.engagement.tickets.adminSetStatus(ctx.session, input)),

  assign: staffProcedure
    .use(requireCapability("tickets.manage"))
    .input(
      z.strictObject({
        ticketId: ulidSchema,
        assigneeUserId: ulidSchema.nullable(),
      }),
    )
    .mutation(({ ctx, input }) => ctx.services.engagement.tickets.adminAssign(ctx.session, input)),

  setPriority: staffProcedure
    .use(requireCapability("tickets.manage"))
    .input(
      z.strictObject({
        ticketId: ulidSchema,
        priority: z.enum(TICKET_PRIORITIES),
      }),
    )
    .mutation(({ ctx, input }) => ctx.services.engagement.tickets.adminSetPriority(ctx.session, input)),
});

const ticketsRouter = router({
  list: protectedProcedure
    .input(
      z
        .strictObject({
          status: z.enum(TICKET_STATUSES).optional(),
          cursor: cursorSchema.optional(),
          limit: z.number().int().min(1).max(50).optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => ctx.services.engagement.tickets.list(ctx.session, input ?? {})),

  openSummary: protectedProcedure
    .input(z.strictObject({}).optional())
    .query(({ ctx }) => ctx.services.engagement.tickets.openSummary(ctx.session)),

  get: protectedProcedure
    .input(
      z.strictObject({
        ticketId: ulidSchema,
        replyCursor: cursorSchema.optional(),
        replyLimit: z.number().int().min(1).max(100).optional(),
      }),
    )
    .query(({ ctx, input }) =>
      ctx.services.engagement.tickets.get(ctx.session, input.ticketId, {
        replyCursor: input.replyCursor,
        replyLimit: input.replyLimit,
      }),
    ),

  create: protectedProcedure
    .meta({ rateLimit: "form_submission" })
    .input(
      z.strictObject({
        subject: z.string().min(5).max(190),
        category: z.enum(TICKET_CATEGORIES),
        body: z.string().min(10).max(8000),
        relatedOrderId: ulidSchema.optional(),
        idempotencyKey: idempotencyKeySchema,
      }),
    )
    .mutation(({ ctx, input }) => ctx.services.engagement.tickets.create(ctx.session, input)),

  reply: protectedProcedure
    .meta({ rateLimit: "form_submission" })
    .input(
      z.strictObject({
        ticketId: ulidSchema,
        body: z.string().min(1).max(8000),
        idempotencyKey: idempotencyKeySchema,
      }),
    )
    .mutation(({ ctx, input }) => ctx.services.engagement.tickets.reply(ctx.session, input)),

  close: protectedProcedure
    .input(z.strictObject({ ticketId: ulidSchema }))
    .mutation(({ ctx, input }) => ctx.services.engagement.tickets.close(ctx.session, input)),

  reopen: protectedProcedure
    .input(
      z.strictObject({
        ticketId: ulidSchema,
        reason: z.string().min(3).max(500),
      }),
    )
    .mutation(({ ctx, input }) => ctx.services.engagement.tickets.reopen(ctx.session, input)),

  admin: ticketsAdminRouter,
});

const notificationPreferencesRouter = router({
  get: protectedProcedure
    .input(z.strictObject({}).optional())
    .query(({ ctx }) => ctx.services.engagement.notifications.getPreferences(ctx.session)),

  update: protectedProcedure
    .input(
      z.strictObject({
        category: z.enum(NOTIFICATION_PREFERENCE_CATEGORIES),
        inApp: z.boolean(),
        email: z.boolean(),
      }),
    )
    .mutation(({ ctx, input }) => ctx.services.engagement.notifications.updatePreference(ctx.session, input)),
});

const notificationsRouter = router({
  list: protectedProcedure
    .input(
      z
        .strictObject({
          unreadOnly: z.boolean().optional(),
          cursor: cursorSchema.optional(),
          limit: z.number().int().min(1).max(50).optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => ctx.services.engagement.notifications.list(ctx.session, input ?? {})),

  unreadCount: protectedProcedure
    .input(z.strictObject({}).optional())
    .query(({ ctx }) => ctx.services.engagement.notifications.unreadCount(ctx.session)),

  markRead: protectedProcedure
    .input(z.strictObject({ notificationId: ulidSchema }))
    .mutation(({ ctx, input }) =>
      ctx.services.engagement.notifications.markRead(ctx.session, input.notificationId),
    ),

  markAllRead: protectedProcedure
    .input(z.strictObject({}).optional())
    .mutation(({ ctx }) => ctx.services.engagement.notifications.markAllRead(ctx.session)),

  preferences: notificationPreferencesRouter,
});

const searchRouter = router({
  query: protectedProcedure
    .meta({ rateLimit: "expensive" })
    .input(
      z.strictObject({
        query: z.string().min(2).max(64),
        domains: z.array(z.enum(SEARCH_DOMAINS)).min(1).max(4).optional(),
        limitPerDomain: z.number().int().min(1).max(10).optional(),
      }),
    )
    .query(({ ctx, input }) => ctx.services.engagement.search.query(ctx.session, input)),
});

export const engagementRouter = router({
  messages: messagesRouter,
  tickets: ticketsRouter,
  notifications: notificationsRouter,
  search: searchRouter,
});
