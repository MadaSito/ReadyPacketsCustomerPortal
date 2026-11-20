/**
 * Engagement module — public service surface and factory. Owner: engagement module engineer.
 * Other modules import TYPES from here and reach the instance through `deps.services.engagement` at call time.
 */
import type { ModuleDeps } from "../../container.js";
import type { DbOrTx, ModuleHealth, ModuleLifecycle, Tx } from "../../core/types.js";
import "./settings.js";
import { registerEngagementMailTemplates } from "./mail.js";
import { createMessagesService, type MessagesService } from "./messagesService.js";
import { createNotificationsService, type NotificationsService } from "./notificationsService.js";
import { createPortableEngagementService } from "./portableService.js";
import { createSearchService, type SearchService } from "./searchService.js";
import { createTicketsService, type TicketsService } from "./ticketsService.js";
import type {
  ImportOrderMessageInput,
  ImportTicketInput,
  NotifyInput,
  NotifyResult,
  PortableOrderMessageItem,
  PortableTicketItem,
} from "./types.js";

export * from "./types.js";
export type {
  MessageAttachmentView,
  OrderMessageView,
  OrderThreadSummaryView,
} from "./messagesService.js";
export type {
  NotificationView,
  NotificationPreferenceView,
} from "./notificationsService.js";
export type {
  BoundedSearchResponse,
  CustomerSearchResultItem,
  MessageSearchResultItem,
  OrderSearchResultItem,
  TicketSearchResultItem,
} from "./searchService.js";
export type {
  TicketDetailView,
  TicketHistoryView,
  TicketReplyView,
  TicketSummaryView,
} from "./ticketsService.js";

export const NOTIFICATIONS_RETENTION_JOB_TYPE = "engagement.notifications.retention";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface EngagementModule extends ModuleLifecycle {
  /**
   * Persists an in-app notification (respecting per-category user preferences, except `security.*`
   * which is always delivered in-app) and optionally enqueues the secret-free `engagement.notification`
   * email template inside `tx` when provided.
   */
  notify(input: NotifyInput, tx?: Tx): Promise<NotifyResult>;

  /** Portable export collector for customer-visible order messages (internal staff notes are never exported). */
  portableOrderMessages(
    tx: DbOrTx,
    input: { orderPublicIds: readonly string[]; afterPublicId?: string | null; limit: number },
  ): Promise<{ items: PortableOrderMessageItem[]; nextAfter: string | null }>;

  /** Convenience alias matching portable_ops_engineer's narrow evidence signature. */
  portableEvidence(
    tx: DbOrTx,
    orderIds: readonly string[],
    after: string | null,
    limit: number,
  ): Promise<{ items: PortableOrderMessageItem[]; nextAfter: string | null }>;

  /** Portable export collector for support tickets and customer-visible replies/history (internal notes excluded). */
  portableTickets(
    tx: DbOrTx,
    input: {
      customerUserIds?: readonly number[];
      orderPublicIds?: readonly string[];
      afterPublicId?: string | null;
      limit: number;
    },
  ): Promise<{ items: PortableTicketItem[]; nextAfter: string | null }>;

  /** Idempotent portable import for historical order messages (no mail/notification replay; audited in tx). */
  importOrderMessage(input: ImportOrderMessageInput, tx: Tx): Promise<{ publicId: string; created: boolean }>;

  /** Idempotent portable import for historical support tickets (no mail/notification replay; audited in tx). */
  importTicket(input: ImportTicketInput, tx: Tx): Promise<{ publicId: string; ticketNumber: string; created: boolean }>;

  /** Router-facing domain services (used by `engagementRouter` and integration tests). */
  readonly messages: MessagesService;
  readonly tickets: TicketsService;
  readonly notifications: NotificationsService;
  readonly search: SearchService;
}

export function createEngagementModule(deps: ModuleDeps): EngagementModule {
  registerEngagementMailTemplates(deps.mailer);

  const notifications = createNotificationsService(deps);
  const messages = createMessagesService(deps, notifications);
  const tickets = createTicketsService(deps, notifications);
  const search = createSearchService(deps);
  const portable = createPortableEngagementService(deps);

  deps.jobs.register(
    NOTIFICATIONS_RETENTION_JOB_TYPE,
    async (job) =>
      notifications.runRetentionJob(
        job.signal,
        (tx) => job.assertStillOwned(tx),
        job.correlationId,
        job.jobId,
      ),
    { retrySafe: true },
  );

  deps.jobs.registerSchedule({
    name: "engagement.notifications.retention.daily",
    type: NOTIFICATIONS_RETENTION_JOB_TYPE,
    everyMs: DAY_MS,
  });

  async function health(): Promise<ModuleHealth[]> {
    const checkedAt = deps.clock.now();
    try {
      const unreadTotal = await notifications.totalUnreadMetric();
      return [
        {
          component: "engagement.notifications",
          state: "ok",
          summary: "In-app notifications store is healthy.",
          metrics: { unreadTotal },
          checkedAt,
        },
      ];
    } catch {
      return [
        {
          component: "engagement.notifications",
          state: "failing",
          summary: "In-app notifications store could not be queried.",
          checkedAt,
        },
      ];
    }
  }

  return {
    notify: notifications.notify,
    portableOrderMessages: portable.portableOrderMessages,
    portableEvidence: portable.portableEvidence,
    portableTickets: portable.portableTickets,
    importOrderMessage: portable.importOrderMessage,
    importTicket: portable.importTicket,
    messages,
    tickets,
    notifications,
    search,
    health,
  };
}
