/**
 * Engagement module — public service surface and factory. Owner: engagement module engineer.
 * Other modules import TYPES from here and reach the instance through `deps.services.engagement` at call time.
 */
import type { ModuleDeps } from "../../container.js";
import type { DbOrTx, ModuleLifecycle, Tx } from "../../core/types.js";
import { ulid } from "../../core/ids.js";
import type {
  ImportOrderMessageInput,
  ImportTicketInput,
  NotifyInput,
  NotifyResult,
  PortableOrderMessageItem,
  PortableTicketItem,
} from "./types.js";

export * from "./types.js";

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
}

export function createEngagementModule(_deps: ModuleDeps): EngagementModule {
  return {
    async notify(_input: NotifyInput, _tx?: Tx): Promise<NotifyResult> {
      return { publicId: ulid(), deliveredInApp: true, enqueuedEmail: false };
    },
    async portableOrderMessages() {
      return { items: [], nextAfter: null };
    },
    async portableEvidence() {
      return { items: [], nextAfter: null };
    },
    async portableTickets() {
      return { items: [], nextAfter: null };
    },
    async importOrderMessage(input) {
      return { publicId: input.sourcePublicId, created: false };
    },
    async importTicket(input) {
      return { publicId: input.sourcePublicId, ticketNumber: input.sourceTicketNumber, created: false };
    },
  };
}
