/**
 * Audit center read side: search, detail, pivots, statistics, SIEM read API. Owner: audit engineer.
 * Every read by a person is itself audited (fail closed: if that audit cannot be written, the read is refused).
 */
import { and, asc, eq, gt, lte, sql } from "drizzle-orm";
import { notFound, validation } from "../../core/errors.js";
import { ULID_PATTERN } from "../../core/ids.js";
import type { SessionPrincipal } from "../../core/types.js";
import { actorOf, assertAuditCapability, type AuditCtx } from "./access.js";
import type { AuditEnvelope } from "./envelope.js";
import {
  afterCursor,
  compileQuery,
  encodeCursor,
  MAX_PAGE,
  ORDER_NEWEST_FIRST,
  pivotQuery,
  STAT_BUCKETS,
  STAT_DIMENSIONS,
  type AuditQuery,
  type PivotKind,
  type StatBucket,
  type StatDimension,
} from "./query.js";
import { decryptSourceAddress, rowToEnvelope } from "./rows.js";
import { auditCaseEvents, auditCases, auditChain, auditEvents, auditTombstones } from "./schema.js";

export interface SearchInput {
  query: AuditQuery;
  cursor?: string | null;
  limit?: number;
  /** Quick filter: the actor's user public id (resolved server-side to the actor pseudonym). */
  actorUserPublicId?: string;
}

export interface SearchPage {
  items: AuditEnvelope[];
  nextCursor: string | null;
  /** Freshness: newest sealed seq and unsealed backlog so the UI can say "n events not yet sealed". */
  freshness: { headSeq: number; lastSealedAt: string | null };
}

export interface EventDetail {
  event: AuditEnvelope;
  chain: { seq: number; linkHash: string; prevHash: string; sealedAt: string } | null;
  actorUserPublicId: string | null;
  caseIds: string[];
  availablePivots: PivotKind[];
}

interface IdentityLookup {
  getUser?(userId: number): Promise<{ publicId: string } | null>;
  getUserByPublicId?(publicId: string): Promise<{ id: number } | null>;
}

const identity = (ctx: AuditCtx): IdentityLookup => (ctx.deps.services.identity ?? {}) as unknown as IdentityLookup;

export function actorRefForUser(ctx: AuditCtx, userId: number): string {
  return ctx.deps.crypto.pseudonym(`user:${userId}`, "audit.actor").slice(0, 32);
}

async function runSearch(ctx: AuditCtx, input: SearchInput, extraActorRef?: string): Promise<{ items: AuditEnvelope[]; nextCursor: string | null; termCount: number; windowHours: number }> {
  const compiled = compileQuery(input.query);
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 50)), MAX_PAGE);
  const cursorWhere = afterCursor(input.cursor);
  const where = and(compiled.where, cursorWhere, extraActorRef ? eq(auditEvents.actorRef, extraActorRef) : undefined);
  const rows = await ctx.deps.db
    .select({ event: auditEvents, seq: auditChain.seq })
    .from(auditEvents)
    .leftJoin(auditChain, eq(auditChain.eventRowId, auditEvents.id))
    .where(where)
    .orderBy(...ORDER_NEWEST_FIRST)
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => rowToEnvelope(r.event, r.seq ?? null)),
    nextCursor: rows.length > limit && last ? encodeCursor(last.event.occurredAt, last.event.eventId) : null,
    termCount: compiled.termCount,
    windowHours: Math.ceil((compiled.to.getTime() - compiled.from.getTime()) / 3_600_000),
  };
}

export async function search(ctx: AuditCtx, principal: SessionPrincipal, input: SearchInput): Promise<SearchPage> {
  assertAuditCapability(ctx, principal, "audit.read");
  let actorRef: string | undefined;
  if (input.actorUserPublicId) {
    if (!ULID_PATTERN.test(input.actorUserPublicId)) throw validation("QUERY_VALUE_INVALID", "The user reference is not valid.");
    const user = await identity(ctx).getUserByPublicId?.(input.actorUserPublicId);
    // Unknown user ⇒ an impossible pseudonym (empty result), never an existence oracle.
    actorRef = user ? actorRefForUser(ctx, user.id) : "0".repeat(32);
  }
  const result = await runSearch(ctx, input, actorRef);
  await ctx.deps.audit.record({
    category: "security",
    eventName: "audit.search.executed",
    action: "search",
    outcome: "completed",
    actor: actorOf(principal),
    attributes: {
      page: input.cursor ? "next" : "first",
      term_count: result.termCount,
      window_hours: result.windowHours,
      actor_filter: actorRef !== undefined,
    },
    safeCounts: { results: result.items.length },
  });
  const head = await ctx.chain.head();
  return { items: result.items, nextCursor: result.nextCursor, freshness: { headSeq: head.headSeq, lastSealedAt: head.lastSealedAt?.toISOString() ?? null } };
}

async function loadEvent(ctx: AuditCtx, eventId: string) {
  if (!ULID_PATTERN.test(eventId)) throw notFound("AUDIT_EVENT_NOT_FOUND");
  const [row] = await ctx.deps.db
    .select({ event: auditEvents, chain: auditChain })
    .from(auditEvents)
    .leftJoin(auditChain, eq(auditChain.eventRowId, auditEvents.id))
    .where(eq(auditEvents.eventId, eventId))
    .limit(1);
  if (!row) throw notFound("AUDIT_EVENT_NOT_FOUND");
  return row;
}

export async function getEvent(ctx: AuditCtx, principal: SessionPrincipal, eventId: string): Promise<EventDetail> {
  assertAuditCapability(ctx, principal, "audit.read");
  const row = await loadEvent(ctx, eventId);
  const event = rowToEnvelope(row.event, row.chain?.seq ?? null);
  let actorUserPublicId: string | null = null;
  if (event.actor_user_id !== null) {
    try {
      actorUserPublicId = (await identity(ctx).getUser?.(event.actor_user_id))?.publicId ?? null;
    } catch {
      actorUserPublicId = null;
    }
  }
  const cases = await ctx.deps.db
    .select({ publicId: auditCases.publicId })
    .from(auditCaseEvents)
    .innerJoin(auditCases, eq(auditCases.id, auditCaseEvents.caseId))
    .where(eq(auditCaseEvents.eventId, eventId))
    .limit(20);
  const availablePivots = (["request", "trace", "correlation", "actor", "session", "resource", "job", "package"] as const).filter(
    (kind) => pivotQuery(row.event, kind, 60) !== null,
  );
  await ctx.deps.audit.record({
    category: "security",
    eventName: "audit.event.viewed",
    action: "view",
    outcome: "completed",
    actor: actorOf(principal),
    resource: { type: "audit_event", publicId: eventId },
  });
  return {
    event,
    chain: row.chain ? { seq: row.chain.seq, linkHash: row.chain.linkHash, prevHash: row.chain.prevHash, sealedAt: row.chain.sealedAt.toISOString() } : null,
    actorUserPublicId,
    caseIds: cases.map((c) => c.publicId),
    availablePivots,
  };
}

/** Sensitive-local: reveals the raw client address. Separate, explicitly audited action. */
export async function revealSourceAddress(ctx: AuditCtx, principal: SessionPrincipal, eventId: string): Promise<{ address: string | null }> {
  assertAuditCapability(ctx, principal, "audit.read");
  if (principal.role !== "admin") throw notFound("AUDIT_EVENT_NOT_FOUND");
  const row = await loadEvent(ctx, eventId);
  await ctx.deps.audit.record({
    category: "security",
    eventName: "audit.source_address.revealed",
    action: "reveal",
    outcome: "completed",
    severity: "WARN",
    actor: actorOf(principal),
    resource: { type: "audit_event", publicId: eventId },
  });
  return { address: decryptSourceAddress(ctx.deps.crypto, row.event) };
}

export async function pivot(
  ctx: AuditCtx,
  principal: SessionPrincipal,
  input: { eventId: string; kind: PivotKind; windowMinutes?: number; limit?: number },
): Promise<{ query: AuditQuery; page: SearchPage }> {
  assertAuditCapability(ctx, principal, "audit.read");
  const row = await loadEvent(ctx, input.eventId);
  const query = pivotQuery(row.event, input.kind, input.windowMinutes ?? 60);
  if (!query) throw validation("PIVOT_NOT_AVAILABLE", "This event has no value to pivot on for that choice.");
  const page = await search(ctx, principal, { query, limit: input.limit ?? 50 });
  return { query, page };
}

export interface StatsResult {
  bucket: StatBucket;
  dimension: StatDimension;
  series: { bucket: string; key: string; count: number }[];
  totals: Record<string, number>;
  total: number;
}

export async function stats(
  ctx: AuditCtx,
  principal: SessionPrincipal,
  input: { query: AuditQuery; bucket: StatBucket; dimension: StatDimension },
): Promise<StatsResult> {
  assertAuditCapability(ctx, principal, "audit.read");
  const compiled = compileQuery(input.query);
  const spec = STAT_BUCKETS[input.bucket];
  if (compiled.to.getTime() - compiled.from.getTime() > spec.maxSpanMs) {
    throw validation("STATS_RANGE_TOO_LONG", input.bucket === "hour" ? "Hourly statistics cover at most 14 days." : "Daily statistics cover at most 400 days.");
  }
  const column = STAT_DIMENSIONS[input.dimension];
  // `format` comes from a fixed server-side table, bound as a parameter.
  const bucketExpr = sql<string>`DATE_FORMAT(${auditEvents.occurredAt}, ${spec.format})`;
  const rows = await ctx.deps.db
    .select({ bucket: bucketExpr, key: column, count: sql<number>`count(*)` })
    .from(auditEvents)
    .where(compiled.where)
    .groupBy(bucketExpr, column)
    .orderBy(asc(bucketExpr))
    .limit(5000);
  const series = rows.map((r) => ({ bucket: String(r.bucket), key: String(r.key), count: Number(r.count) }));
  const totals: Record<string, number> = {};
  for (const point of series) totals[point.key] = (totals[point.key] ?? 0) + point.count;
  await ctx.deps.audit.record({
    category: "security",
    eventName: "audit.stats.viewed",
    action: "search",
    outcome: "completed",
    actor: actorOf(principal),
    attributes: { bucket: input.bucket, dimension: input.dimension, term_count: compiled.termCount },
  });
  return { bucket: input.bucket, dimension: input.dimension, series, totals, total: series.reduce((sum, p) => sum + p.count, 0) };
}

/* -------------------------------------------------------------- SIEM read API */

export function encodeSeqCursor(seq: number): string {
  return Buffer.from(`s1:${seq}`, "utf8").toString("base64url");
}

export function decodeSeqCursor(cursor: string | null): number {
  if (cursor === null) return 0;
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  const match = /^s1:(\d{1,15})$/.exec(text);
  if (!match) throw validation("CURSOR_INVALID", "The delivery cursor is not valid.");
  return Number(match[1]);
}

/**
 * Commit-safe ordered read for forwarders: sealed events in chain seq order.
 * - Seqs whose event was removed by retention AND carry a valid-looking tombstone are counted in `pruned`.
 * - Seqs with neither event nor tombstone are counted in `missing` (unexplained loss — consumers should alert;
 *   `verifyChain` authenticates tombstone receipts).
 * - A window consisting only of removed seqs does not return an empty batch while more remains: reading
 *   continues (bounded) until events are found or the sealed head is reached, so `events.length === 0` with
 *   `nextCursor` at head means "caught up".
 */
export async function readEventsAfter(
  ctx: AuditCtx,
  cursor: string | null,
  limit: number,
): Promise<{ events: AuditEnvelope[]; nextCursor: string | null; headSeq: number; pruned: number; missing: number }> {
  let after = decodeSeqCursor(cursor);
  const bounded = Math.min(Math.max(1, Math.floor(limit)), 1000);
  const head = await ctx.chain.head();
  const events: AuditEnvelope[] = [];
  let pruned = 0;
  let missing = 0;
  let advanced = false;
  // At most 20 pages (≤ 20k seqs) of removed-only rows per call keeps the call bounded.
  for (let page = 0; page < 20 && events.length === 0 && after < head.headSeq; page += 1) {
    const rows = await ctx.deps.db
      .select({ seq: auditChain.seq, event: auditEvents, tombSeq: auditTombstones.seq })
      .from(auditChain)
      .leftJoin(auditEvents, eq(auditEvents.id, auditChain.eventRowId))
      .leftJoin(auditTombstones, eq(auditTombstones.seq, auditChain.seq))
      .where(and(gt(auditChain.seq, after), lte(auditChain.seq, head.headSeq)))
      .orderBy(asc(auditChain.seq))
      .limit(bounded);
    if (rows.length === 0) break;
    for (const r of rows) {
      if (r.event) events.push(rowToEnvelope(r.event, r.seq));
      else if (r.tombSeq !== null) pruned += 1;
      else missing += 1;
    }
    after = rows[rows.length - 1]!.seq;
    advanced = true;
  }
  return { events, nextCursor: advanced ? encodeSeqCursor(after) : cursor, headSeq: head.headSeq, pruned, missing };
}

/** Counts used by the integrity page. */
export async function integrityCounts(ctx: AuditCtx): Promise<{ events: number; sealed: number; tombstones: number }> {
  const [events] = await ctx.deps.db.select({ n: sql<number>`count(*)` }).from(auditEvents);
  const [sealed] = await ctx.deps.db.select({ n: sql<number>`count(*)` }).from(auditChain);
  const [tombs] = await ctx.deps.db.select({ n: sql<number>`count(*)` }).from(auditTombstones);
  return { events: Number(events?.n ?? 0), sealed: Number(sealed?.n ?? 0), tombstones: Number(tombs?.n ?? 0) };
}
