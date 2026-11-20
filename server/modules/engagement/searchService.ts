import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { roleHasCapability } from "../../../shared/capabilities.js";
import type { ModuleDeps } from "../../container.js";
import { DomainError } from "../../core/errors.js";
import type { SessionPrincipal } from "../../core/types.js";
import { readSetting } from "../platform/index.js";
import { getIdentityPeer, type getOrdersPeer } from "./peers.js";
import {
  engagementOrderMessages,
  engagementSearchTokens,
  engagementSupportTicketMessages,
  engagementSupportTickets,
} from "./schema.js";
import { ENGAGEMENT_SEARCH_TIME_BUDGET_MS } from "./settings.js";
import {
  normalizeSearchQuery,
  SEARCH_TOKEN_PURPOSE,
  truncateSnippet,
} from "./textAndSearch.js";
import {
  SEARCH_DOMAINS,
  type SearchDomain,
  type TicketCategory,
  type TicketPriority,
  type TicketStatus,
} from "./types.js";

export interface OrderSearchResultItem {
  publicId: string;
  reference: string;
  projectName: string;
  statusLabel: string;
  updatedAt: Date;
}

export interface TicketSearchResultItem {
  publicId: string;
  ticketNumber: string;
  subject: string;
  category: TicketCategory;
  status: TicketStatus;
  priority: TicketPriority;
  relatedOrderReference: string | null;
  updatedAt: Date;
}

export interface MessageSearchResultItem {
  publicId: string;
  orderPublicId: string;
  orderReference: string;
  visibility: "customer" | "internal";
  snippet: string;
  createdAt: Date;
}

export interface CustomerSearchResultItem {
  publicId: string;
  customerRef: string | null;
  name: string;
  status: string;
}

export interface BoundedSearchResponse {
  orders: OrderSearchResultItem[];
  tickets: TicketSearchResultItem[];
  messages: MessageSearchResultItem[];
  customers: CustomerSearchResultItem[];
  meta: {
    globalScope: boolean;
    /**
     * True when the configured search budget (`engagement.search.time_budget_ms`) expired before all
     * domains finished. SQL queries carry MySQL 8 `MAX_EXECUTION_TIME` hints; peer calls that do not
     * accept an abort/deadline signal are raced against a soft JS deadline.
     */
    timedOut: boolean;
    durationMs: number;
  };
}

const BUDGET_EXPIRED = Symbol("BUDGET_EXPIRED");

function assertFullSession(principal: SessionPrincipal): void {
  if (principal.state !== "full" || principal.pendingSteps.length > 0) {
    throw new DomainError(
      "REMEDIATION_REQUIRED",
      "ACCOUNT_STEP_PENDING",
      "Please finish securing your account to continue.",
    );
  }
}

function isMysqlQueryTimeoutError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const rec = err as { errno?: unknown; code?: unknown; cause?: unknown };
  if (rec.errno === 3024 || rec.code === "ER_QUERY_TIMEOUT") return true;
  if (rec.cause) return isMysqlQueryTimeoutError(rec.cause);
  return false;
}

function mysqlMaxExecHint(ms: number) {
  if (ms <= 100) return sql<number>`/*+ MAX_EXECUTION_TIME(100) */ 1`;
  if (ms <= 250) return sql<number>`/*+ MAX_EXECUTION_TIME(250) */ 1`;
  if (ms <= 500) return sql<number>`/*+ MAX_EXECUTION_TIME(500) */ 1`;
  if (ms <= 1000) return sql<number>`/*+ MAX_EXECUTION_TIME(1000) */ 1`;
  if (ms <= 1500) return sql<number>`/*+ MAX_EXECUTION_TIME(1500) */ 1`;
  if (ms <= 3000) return sql<number>`/*+ MAX_EXECUTION_TIME(3000) */ 1`;
  return sql<number>`/*+ MAX_EXECUTION_TIME(5000) */ 1`;
}

function matchesAllTokensOrPhrase(
  haystacks: readonly string[],
  lowerQuery: string,
  wordTokens: readonly string[],
): boolean {
  const combined = haystacks.map((h) => h.normalize("NFC").toLowerCase()).join("\n");
  if (combined.includes(lowerQuery)) return true;
  if (wordTokens.length === 0) return false;
  return wordTokens.every((token) => combined.includes(token));
}

export function createSearchService(deps: ModuleDeps) {
  const { db, crypto, audit, settings } = deps;

  async function query(
    principal: SessionPrincipal,
    input: {
      query: string;
      domains?: readonly SearchDomain[];
      limitPerDomain?: number;
    },
  ): Promise<BoundedSearchResponse> {
    assertFullSession(principal);
    const parsed = normalizeSearchQuery(input.query);
    const limitPerDomain = Math.min(Math.max(input.limitPerDomain ?? 5, 1), 10);
    const timeBudgetMs = await readSetting(settings, ENGAGEMENT_SEARCH_TIME_BUDGET_MS);

    const startedAtMs = performance.now();
    const deadlineAtMs = startedAtMs + timeBudgetMs;
    let timedOut = false;

    const remainingMs = (): number => Math.floor(deadlineAtMs - performance.now());

    const isBudgetExceeded = (): boolean => {
      if (timedOut || remainingMs() <= 0) {
        timedOut = true;
        return true;
      }
      return false;
    };

    async function runWithinBudget<T>(fn: (budgetMs: number) => Promise<T>): Promise<T | typeof BUDGET_EXPIRED> {
      const rem = remainingMs();
      if (rem <= 0) {
        timedOut = true;
        return BUDGET_EXPIRED;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const raced = await Promise.race<T | typeof BUDGET_EXPIRED>([
          fn(rem).catch((err: unknown) => {
            if (isMysqlQueryTimeoutError(err)) {
              timedOut = true;
              return BUDGET_EXPIRED;
            }
            throw err;
          }),
          new Promise<typeof BUDGET_EXPIRED>((resolve) => {
            timer = setTimeout(() => {
              timedOut = true;
              resolve(BUDGET_EXPIRED);
            }, rem);
          }),
        ]);
        return raced;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }

    const hasGlobalSearch =
      (principal.role === "staff" || principal.role === "admin") &&
      roleHasCapability(principal.role, "search.global");
    const canReadAllTickets = hasGlobalSearch && roleHasCapability(principal.role, "tickets.read_all");
    const canReadAllMessages = hasGlobalSearch && roleHasCapability(principal.role, "messages.read_all");
    const canSearchCustomers = hasGlobalSearch && roleHasCapability(principal.role, "customers.read_all");

    const requested = new Set<SearchDomain>(
      input.domains && input.domains.length > 0 ? input.domains : SEARCH_DOMAINS,
    );
    const queryTokenHashes = parsed.wordTokens.map((t) => crypto.blindIndex(t, SEARCH_TOKEN_PURPOSE));
    const maxCandidates = Math.min(limitPerDomain * 4, 40);

    const resultOrders: OrderSearchResultItem[] = [];
    const resultTickets: TicketSearchResultItem[] = [];
    const resultMessages: MessageSearchResultItem[] = [];
    const resultCustomers: CustomerSearchResultItem[] = [];

    // 1. Orders domain — delegated to narrow orders search provider under remaining budget
    if (requested.has("orders") && !isBudgetExceeded()) {
      const ordersPeer = (deps.services.orders ?? {}) as {
        searchOrders?: (
          p: SessionPrincipal,
          q: string,
          limit?: number,
        ) => Promise<OrderSearchResultItem[]>;
      };
      if (ordersPeer.searchOrders) {
        const hits = await runWithinBudget(() =>
          ordersPeer.searchOrders!(principal, parsed.normalized, limitPerDomain),
        );
        if (hits !== BUDGET_EXPIRED) {
          resultOrders.push(...hits.slice(0, limitPerDomain));
        }
      }
    }

    // 2. Tickets domain — tenant-scoped token JOIN + sargable B-tree prefix + row re-authorization
    if (requested.has("tickets") && !isBudgetExceeded()) {
      let tokenMatchedTicketIds: number[] = [];
      if (queryTokenHashes.length > 0) {
        // Security invariant (review fix): join `engagement_support_tickets` with requester/visibility scope
        // BEFORE `LIMIT`, so other tenants' token rows can never starve the caller's own matches.
        const tokRows = await runWithinBudget((rem) =>
          db
            .select({
              _hint: mysqlMaxExecHint(rem),
              recordId: engagementSearchTokens.recordId,
            })
            .from(engagementSearchTokens)
            .innerJoin(
              engagementSupportTickets,
              eq(engagementSupportTickets.id, engagementSearchTokens.recordId),
            )
            .where(
              and(
                eq(engagementSearchTokens.domain, "ticket"),
                canReadAllTickets ? undefined : eq(engagementSearchTokens.customerVisible, true),
                canReadAllTickets ? undefined : eq(engagementSupportTickets.requesterUserId, principal.userId),
                inArray(engagementSearchTokens.tokenHash, queryTokenHashes),
              ),
            )
            .groupBy(engagementSearchTokens.recordId)
            .orderBy(desc(engagementSearchTokens.recordId))
            .limit(maxCandidates),
        );
        if (tokRows !== BUDGET_EXPIRED) {
          tokenMatchedTicketIds = tokRows.map((r) => r.recordId);
        }
      }

      if (!isBudgetExceeded()) {
        // Sargable B-tree prefix conditions on normalized reference columns (no UPPER / COALESCE wrappers).
        const refCondition = or(
          sql`${engagementSupportTickets.ticketNumber} LIKE ${parsed.escapedLikePrefix} ESCAPE '!'`,
          sql`${engagementSupportTickets.relatedOrderReference} LIKE ${parsed.escapedLikePrefix} ESCAPE '!'`,
        );
        const matchCondition =
          tokenMatchedTicketIds.length > 0
            ? or(refCondition, inArray(engagementSupportTickets.id, tokenMatchedTicketIds))
            : refCondition;

        const candidateRes = await runWithinBudget((rem) =>
          db
            .select({
              _hint: mysqlMaxExecHint(rem),
              ticket: engagementSupportTickets,
            })
            .from(engagementSupportTickets)
            .where(
              and(
                canReadAllTickets ? undefined : eq(engagementSupportTickets.requesterUserId, principal.userId),
                matchCondition,
              ),
            )
            .orderBy(desc(engagementSupportTickets.id))
            .limit(maxCandidates),
        );

        if (candidateRes !== BUDGET_EXPIRED) {
          const tokenMatchedSet = new Set(tokenMatchedTicketIds);
          for (const { ticket: row } of candidateRes) {
            if (resultTickets.length >= limitPerDomain || isBudgetExceeded()) break;
            if (!canReadAllTickets && row.requesterUserId !== principal.userId) continue;

            const subject = crypto.decrypt(
              row.subjectEnc,
              `engagement_support_tickets.subject:${row.publicId}`,
            );
            const haystacks: string[] = [
              row.ticketNumber,
              row.relatedOrderReference ?? "",
              row.category,
              subject,
            ];

            let matched = matchesAllTokensOrPhrase(haystacks, parsed.lower, parsed.wordTokens);
            if (!matched && tokenMatchedSet.has(row.id) && !isBudgetExceeded()) {
              const replyRows = await runWithinBudget((rem) =>
                db
                  .select({
                    _hint: mysqlMaxExecHint(rem),
                    reply: engagementSupportTicketMessages,
                  })
                  .from(engagementSupportTicketMessages)
                  .where(
                    and(
                      eq(engagementSupportTicketMessages.ticketId, row.id),
                      canReadAllTickets ? undefined : eq(engagementSupportTicketMessages.internalOnly, false),
                    ),
                  )
                  .orderBy(desc(engagementSupportTicketMessages.id))
                  .limit(20),
              );
              if (replyRows !== BUDGET_EXPIRED) {
                for (const { reply } of replyRows) {
                  if (!canReadAllTickets && reply.internalOnly) continue;
                  haystacks.push(
                    crypto.decrypt(
                      reply.bodyEnc,
                      `engagement_support_ticket_messages.body:${reply.publicId}`,
                    ),
                  );
                }
                matched = matchesAllTokensOrPhrase(haystacks, parsed.lower, parsed.wordTokens);
              }
            }

            if (matched) {
              resultTickets.push({
                publicId: row.publicId,
                ticketNumber: row.ticketNumber,
                subject,
                category: row.category,
                status: row.status,
                priority: row.priority,
                relatedOrderReference: row.relatedOrderReference,
                updatedAt: row.updatedAt,
              });
            }
          }
        }
      }
    }

    // 3. Order messages domain — order-scoped token JOIN + sargable B-tree prefix + assertCanReadOrderById per row
    if (requested.has("messages") && !isBudgetExceeded()) {
      const ordersPeer = (deps.services.orders ?? {}) as Partial<ReturnType<typeof getOrdersPeer>>;
      if (ordersPeer.listAccessibleOrderIds && ordersPeer.assertCanReadOrderById) {
        const accessibleRes = await runWithinBudget(() =>
          ordersPeer.listAccessibleOrderIds!(principal, { limit: 500 }),
        );
        if (accessibleRes !== BUDGET_EXPIRED) {
          const accessible = accessibleRes;
          const hasAnyOrders = accessible.all || accessible.orderIds.length > 0;

          if (hasAnyOrders && !isBudgetExceeded()) {
            let tokenMatchedMessageIds: number[] = [];
            if (queryTokenHashes.length > 0) {
              // Security invariant (review fix): join `engagement_order_messages` with accessible orderIds and
              // visibility scope BEFORE `LIMIT`, preventing cross-tenant token starvation.
              const tokRows = await runWithinBudget((rem) =>
                db
                  .select({
                    _hint: mysqlMaxExecHint(rem),
                    recordId: engagementSearchTokens.recordId,
                  })
                  .from(engagementSearchTokens)
                  .innerJoin(
                    engagementOrderMessages,
                    eq(engagementOrderMessages.id, engagementSearchTokens.recordId),
                  )
                  .where(
                    and(
                      eq(engagementSearchTokens.domain, "order_message"),
                      canReadAllMessages ? undefined : eq(engagementSearchTokens.customerVisible, true),
                      canReadAllMessages ? undefined : eq(engagementOrderMessages.visibility, "customer"),
                      accessible.all ? undefined : inArray(engagementOrderMessages.orderId, accessible.orderIds),
                      inArray(engagementSearchTokens.tokenHash, queryTokenHashes),
                    ),
                  )
                  .groupBy(engagementSearchTokens.recordId)
                  .orderBy(desc(engagementSearchTokens.recordId))
                  .limit(maxCandidates),
              );
              if (tokRows !== BUDGET_EXPIRED) {
                tokenMatchedMessageIds = tokRows.map((r) => r.recordId);
              }
            }

            if (!isBudgetExceeded()) {
              // Sargable B-tree prefix lookup on normalized `order_reference` (no UPPER wrapper).
              const refCondition = sql`${engagementOrderMessages.orderReference} LIKE ${parsed.escapedLikePrefix} ESCAPE '!'`;
              const matchCondition =
                tokenMatchedMessageIds.length > 0
                  ? or(refCondition, inArray(engagementOrderMessages.id, tokenMatchedMessageIds))
                  : refCondition;

              const candidateRes = await runWithinBudget((rem) =>
                db
                  .select({
                    _hint: mysqlMaxExecHint(rem),
                    msg: engagementOrderMessages,
                  })
                  .from(engagementOrderMessages)
                  .where(
                    and(
                      accessible.all ? undefined : inArray(engagementOrderMessages.orderId, accessible.orderIds),
                      canReadAllMessages ? undefined : eq(engagementOrderMessages.visibility, "customer"),
                      matchCondition,
                    ),
                  )
                  .orderBy(desc(engagementOrderMessages.id))
                  .limit(maxCandidates),
              );

              if (candidateRes !== BUDGET_EXPIRED) {
                const orderAuthCache = new Map<number, { publicId: string; reference: string } | null>();
                for (const { msg: row } of candidateRes) {
                  if (resultMessages.length >= limitPerDomain || isBudgetExceeded()) break;
                  if (!canReadAllMessages && row.visibility !== "customer") continue;

                  if (!orderAuthCache.has(row.orderId)) {
                    const authRes = await runWithinBudget(async () => {
                      try {
                        const view = await ordersPeer.assertCanReadOrderById!(principal, row.orderId);
                        return { publicId: view.publicId, reference: view.reference };
                      } catch {
                        // Never throw NOT_FOUND / FORBIDDEN — search must never act as an existence oracle.
                        return null;
                      }
                    });
                    if (authRes === BUDGET_EXPIRED) break;
                    orderAuthCache.set(row.orderId, authRes);
                  }
                  const verifiedOrder = orderAuthCache.get(row.orderId);
                  if (!verifiedOrder) continue;

                  const plainBody = crypto.decrypt(
                    row.bodyEnc,
                    `engagement_order_messages.body:${row.publicId}`,
                  );
                  if (
                    matchesAllTokensOrPhrase(
                      [verifiedOrder.reference, plainBody],
                      parsed.lower,
                      parsed.wordTokens,
                    )
                  ) {
                    resultMessages.push({
                      publicId: row.publicId,
                      orderPublicId: verifiedOrder.publicId,
                      orderReference: verifiedOrder.reference,
                      visibility: row.visibility,
                      snippet: truncateSnippet(plainBody, 140),
                      createdAt: row.createdAt,
                    });
                  }
                }
              }
            }
          }
        }
      }
    }

    // 4. Customers domain — staff/admin with search.global + customers.read_all ONLY
    if (requested.has("customers") && canSearchCustomers && !isBudgetExceeded()) {
      const identity = getIdentityPeer(deps);
      if (identity.searchCustomers) {
        const customerHits = await runWithinBudget(() =>
          identity.searchCustomers!(principal, {
            query: parsed.normalized,
            limit: limitPerDomain,
          }),
        );
        if (customerHits !== BUDGET_EXPIRED) {
          for (const item of customerHits.items.slice(0, limitPerDomain)) {
            resultCustomers.push({
              publicId: item.publicId,
              customerRef: item.customerRef,
              name: item.name,
              status: item.status,
            });
          }
        }
      }
    }

    const durationMs = Math.max(0, Math.round(performance.now() - startedAtMs));

    // Staff/admin global searches are durably audited without ever logging the search query text.
    if (hasGlobalSearch) {
      await audit.record({
        category: "admin",
        eventName: "engagement.search.executed",
        action: "search",
        outcome: "completed",
        actor: { userId: principal.userId, role: principal.role },
        durationMs,
        safeCounts: {
          orders: resultOrders.length,
          tickets: resultTickets.length,
          messages: resultMessages.length,
          customers: resultCustomers.length,
        },
        attributes: {
          global_scope: true,
          timed_out: timedOut,
        },
      });
    }

    return {
      orders: resultOrders,
      tickets: resultTickets,
      messages: resultMessages,
      customers: resultCustomers,
      meta: {
        globalScope: hasGlobalSearch,
        timedOut,
        durationMs,
      },
    };
  }

  return { query };
}

export type SearchService = ReturnType<typeof createSearchService>;
