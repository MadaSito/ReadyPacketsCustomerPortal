/**
 * Engagement module public types — shared across cross-module callers and internal services.
 */
import type { UserRole } from "../../../shared/domain.js";

export const ORDER_MESSAGE_VISIBILITIES = ["customer", "internal"] as const;
export type OrderMessageVisibility = (typeof ORDER_MESSAGE_VISIBILITIES)[number];

export const TICKET_STATUSES = [
  "open",
  "pending_customer",
  "pending_staff",
  "resolved",
  "closed",
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_CATEGORIES = [
  "general",
  "order",
  "billing",
  "technical",
  "deliverable",
  "account",
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export const NOTIFICATION_PREFERENCE_CATEGORIES = [
  "security",
  "order",
  "message",
  "ticket",
  "file",
  "invoice",
  "compliance",
  "system",
] as const;
export type NotificationPreferenceCategory = (typeof NOTIFICATION_PREFERENCE_CATEGORIES)[number];

export const SEARCH_DOMAINS = ["orders", "tickets", "messages", "customers"] as const;
export type SearchDomain = (typeof SEARCH_DOMAINS)[number];

export interface NotifyInput {
  /** Internal numeric recipient user ID (`users.id`). */
  userId: number;
  /**
   * Dotted lowercase notification kind, e.g. `order.status_changed`, `security.mfa_reset`,
   * `message.received`, `ticket.updated`. Must match `/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/` (max 64 chars).
   */
  kind: string;
  /** Safe plain-text title (NFC normalized, 1..160 chars). Never pass secrets or raw user bodies. */
  title: string;
  /** Safe plain-text summary (NFC normalized, 1..500 chars). Never pass secrets or raw user bodies. */
  body: string;
  /** Optional relative in-app path starting with `/` (never `//` or scheme URLs, max 255 chars). */
  link?: string | null;
  /** Optional idempotency key (max 128 chars); duplicate keys per user return the existing notification. */
  idempotencyKey?: string;
  /**
   * Suppresses generic notification email enqueue even if user enabled email for this kind
   * (use when the caller already enqueues a dedicated domain mail template).
   */
  skipEmail?: boolean;
  /**
   * Marks the notification as staff-internal (`J-A01`). Forces `skipEmail = true`, verifies recipient has
   * live `staff` or `admin` role at write time, and hides the row from customer sessions on list/count/read.
   */
  staffOnly?: boolean;
  /** Optional internal order ID (`orders.id`) for trash/purge gating and outbound mail gating. */
  orderId?: number | null;
  /** Optional internal support ticket ID (`engagement_support_tickets.id`) for trash/purge gating. */
  ticketId?: number | null;
}

export interface NotifyResult {
  publicId: string;
  deliveredInApp: boolean;
  enqueuedEmail: boolean;
}

export interface PortableOrderMessageItem {
  publicId: string;
  orderPublicId: string;
  authorUserPublicId: string;
  authorRole: UserRole;
  body: string;
  attachmentFilePublicIds: readonly string[];
  createdAt: Date;
}

export interface PortableTicketReplyItem {
  publicId: string;
  authorUserPublicId: string;
  authorRole: UserRole;
  body: string;
  createdAt: Date;
}

export interface PortableTicketHistoryItem {
  publicId: string;
  fromStatus: TicketStatus | null;
  toStatus: TicketStatus;
  actorRole: UserRole | "system";
  reasonCode: string | null;
  occurredAt: Date;
}

export interface PortableTicketItem {
  publicId: string;
  ticketNumber: string;
  requesterUserPublicId: string;
  relatedOrderPublicId: string | null;
  category: TicketCategory;
  status: TicketStatus;
  priority: TicketPriority;
  subject: string;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
  closedAt: Date | null;
  replies: readonly PortableTicketReplyItem[];
  statusHistory: readonly PortableTicketHistoryItem[];
}

export interface ImportOrderMessageInput {
  importId: string;
  sourceInstallationId: string;
  sourcePublicId: string;
  targetOrderId: number;
  targetOrderPublicId: string;
  targetOrderReference: string;
  authorUserId: number;
  authorUserPublicId: string;
  authorRole: UserRole;
  body: string;
  attachmentFilePublicIds?: readonly string[];
  createdAt: Date;
}

export interface ImportTicketInput {
  importId: string;
  sourceInstallationId: string;
  sourcePublicId: string;
  sourceTicketNumber: string;
  requesterUserId: number;
  requesterUserPublicId: string;
  relatedOrderId?: number | null;
  relatedOrderPublicId?: string | null;
  category: TicketCategory;
  status: TicketStatus;
  priority: TicketPriority;
  subject: string;
  createdAt: Date;
  resolvedAt?: Date | null;
  closedAt?: Date | null;
  replies: readonly {
    sourcePublicId: string;
    authorUserId: number;
    authorUserPublicId: string;
    authorRole: UserRole;
    body: string;
    createdAt: Date;
  }[];
  statusHistory?: readonly {
    sourcePublicId: string;
    fromStatus: TicketStatus | null;
    toStatus: TicketStatus;
    actorRole: UserRole | "system";
    reasonCode?: string | null;
    occurredAt: Date;
  }[];
}
