/** Saved queries and incident cases. Owner: audit engineer. All mutations are audited inside their transaction. */
import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import { conflict, notFound, validation } from "../../core/errors.js";
import { ulid, ULID_PATTERN } from "../../core/ids.js";
import type { DbOrTx, SessionPrincipal } from "../../core/types.js";
import { neutraliseControl } from "../../observability/redact.js";
import { actorOf, assertActorCurrent, assertAuditCapability, type AuditCtx } from "./access.js";
import { lockGate, retentionGateReady } from "./retention.js";
import type { AuditEnvelope } from "./envelope.js";
import { auditQuerySchema, compileQuery, type AuditQuery } from "./query.js";
import { rowToEnvelope } from "./rows.js";
import { auditCaseEvents, auditCaseNotes, auditCases, auditChain, auditEvents, auditSavedQueries } from "./schema.js";

export const CASE_STATUSES = ["open", "investigating", "closed"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];
export const CASE_SEVERITIES = ["INFO", "WARN", "ERROR", "FATAL"] as const;
export const MAX_SAVED_QUERIES_PER_USER = 50;

const cleanText = (value: string, max: number) => neutraliseControl(value.normalize("NFC").trim()).slice(0, max);

/* ------------------------------------------------------------ saved queries */

export interface SavedQueryView {
  id: string;
  name: string;
  shared: boolean;
  mine: boolean;
  query: AuditQuery;
  updatedAt: string;
}

export async function listSavedQueries(ctx: AuditCtx, principal: SessionPrincipal): Promise<SavedQueryView[]> {
  assertAuditCapability(ctx, principal, "audit.read");
  const rows = await ctx.deps.db
    .select()
    .from(auditSavedQueries)
    .where(or(eq(auditSavedQueries.ownerUserId, principal.userId), eq(auditSavedQueries.shared, true)))
    .orderBy(desc(auditSavedQueries.updatedAt))
    .limit(200);
  const out: SavedQueryView[] = [];
  for (const row of rows) {
    const parsed = auditQuerySchema.safeParse(row.query);
    if (!parsed.success) continue;
    out.push({ id: row.publicId, name: row.name, shared: row.shared, mine: row.ownerUserId === principal.userId, query: parsed.data, updatedAt: row.updatedAt.toISOString() });
  }
  return out;
}

export async function saveQuery(ctx: AuditCtx, principal: SessionPrincipal, input: { name: string; shared: boolean; query: AuditQuery }): Promise<{ id: string }> {
  assertAuditCapability(ctx, principal, "audit.read");
  const name = cleanText(input.name, 80);
  if (name.length < 1) throw validation("NAME_REQUIRED", "Give the saved search a name.");
  compileQuery(input.query); // validates bounds
  const publicId = ulid(ctx.deps.clock.now().getTime());
  await ctx.deps.db.transaction(async (tx) => {
    const existing = await tx.select({ id: auditSavedQueries.id }).from(auditSavedQueries).where(eq(auditSavedQueries.ownerUserId, principal.userId)).limit(MAX_SAVED_QUERIES_PER_USER + 1);
    if (existing.length >= MAX_SAVED_QUERIES_PER_USER) throw conflict("SAVED_QUERY_LIMIT", `You can keep up to ${MAX_SAVED_QUERIES_PER_USER} saved searches.`);
    await tx.insert(auditSavedQueries).values({ publicId, ownerUserId: principal.userId, name, shared: input.shared, query: input.query });
    await ctx.deps.audit.record(
      {
        category: "admin",
        eventName: "audit.saved_query.created",
        action: "create",
        outcome: "completed",
        actor: actorOf(principal),
        resource: { type: "audit_saved_query", publicId },
        attributes: { shared: input.shared },
      },
      tx,
    );
  });
  return { id: publicId };
}

export async function deleteSavedQuery(ctx: AuditCtx, principal: SessionPrincipal, id: string): Promise<void> {
  assertAuditCapability(ctx, principal, "audit.read");
  if (!ULID_PATTERN.test(id)) throw notFound();
  await ctx.deps.db.transaction(async (tx) => {
    const [row] = await tx.select().from(auditSavedQueries).where(eq(auditSavedQueries.publicId, id)).for("update");
    // Shared queries of other admins are visible but not deletable: report NOT_FOUND (no oracle on ownership).
    if (!row || row.ownerUserId !== principal.userId) throw notFound();
    await tx.delete(auditSavedQueries).where(eq(auditSavedQueries.id, row.id));
    await ctx.deps.audit.record(
      { category: "admin", eventName: "audit.saved_query.deleted", action: "delete", outcome: "completed", actor: actorOf(principal), resource: { type: "audit_saved_query", publicId: id } },
      tx,
    );
  });
}

/* -------------------------------------------------------------------- cases */

export interface CaseSummary {
  id: string;
  title: string;
  status: CaseStatus;
  severity: string;
  eventCount: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface CaseDetail extends CaseSummary {
  events: AuditEnvelope[];
  notes: { id: string; body: string; authorIsMe: boolean; createdAt: string }[];
}

const titleAad = (publicId: string) => `audit_cases.title:${publicId}`;
const noteAad = (publicId: string) => `audit_case_notes.body:${publicId}`;

function decryptOr(ctx: AuditCtx, value: string, aad: string): string {
  try {
    return ctx.deps.crypto.decrypt(value, aad);
  } catch {
    return "[unreadable]";
  }
}

export async function listCases(
  ctx: AuditCtx,
  principal: SessionPrincipal,
  input: { status?: CaseStatus; cursor?: string | null; limit?: number },
): Promise<{ items: CaseSummary[]; nextCursor: string | null }> {
  assertAuditCapability(ctx, principal, "audit.read");
  const limit = Math.min(Math.max(1, input.limit ?? 25), 100);
  const cursorId = input.cursor && /^\d{1,15}$/.test(input.cursor) ? Number(input.cursor) : undefined;
  const rows = await ctx.deps.db
    .select()
    .from(auditCases)
    .where(and(input.status ? eq(auditCases.status, input.status) : undefined, cursorId ? lt(auditCases.id, cursorId) : undefined))
    .orderBy(desc(auditCases.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const counts = new Map<number, number>();
  if (page.length > 0) {
    const links = await ctx.deps.db.select({ caseId: auditCaseEvents.caseId }).from(auditCaseEvents).where(inArray(auditCaseEvents.caseId, page.map((r) => r.id)));
    for (const link of links) counts.set(link.caseId, (counts.get(link.caseId) ?? 0) + 1);
  }
  return {
    items: page.map((row) => ({
      id: row.publicId,
      title: decryptOr(ctx, row.titleEnc, titleAad(row.publicId)),
      status: row.status as CaseStatus,
      severity: row.severity,
      eventCount: counts.get(row.id) ?? 0,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      closedAt: row.closedAt?.toISOString() ?? null,
    })),
    nextCursor: rows.length > limit ? String(page[page.length - 1]!.id) : null,
  };
}

async function loadCase(ctx: AuditCtx, id: string, forUpdate = false, tx: DbOrTx = ctx.deps.db) {
  if (!ULID_PATTERN.test(id)) throw notFound("AUDIT_CASE_NOT_FOUND");
  const q = tx.select().from(auditCases).where(eq(auditCases.publicId, id));
  const [row] = forUpdate ? await q.for("update") : await q;
  if (!row) throw notFound("AUDIT_CASE_NOT_FOUND");
  return row;
}

export async function getCase(ctx: AuditCtx, principal: SessionPrincipal, id: string): Promise<CaseDetail> {
  assertAuditCapability(ctx, principal, "audit.read");
  const row = await loadCase(ctx, id);
  const linked = await ctx.deps.db
    .select({ event: auditEvents, seq: auditChain.seq })
    .from(auditCaseEvents)
    .innerJoin(auditEvents, eq(auditEvents.eventId, auditCaseEvents.eventId))
    .leftJoin(auditChain, eq(auditChain.eventRowId, auditEvents.id))
    .where(eq(auditCaseEvents.caseId, row.id))
    .orderBy(auditEvents.occurredAt)
    .limit(500);
  const notes = await ctx.deps.db.select().from(auditCaseNotes).where(eq(auditCaseNotes.caseId, row.id)).orderBy(auditCaseNotes.createdAt).limit(500);
  await ctx.deps.audit.record({ category: "security", eventName: "audit.case.viewed", action: "view", outcome: "completed", actor: actorOf(principal), resource: { type: "audit_case", publicId: id } });
  return {
    id: row.publicId,
    title: decryptOr(ctx, row.titleEnc, titleAad(row.publicId)),
    status: row.status as CaseStatus,
    severity: row.severity,
    eventCount: linked.length,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
    events: linked.map((l) => rowToEnvelope(l.event, l.seq ?? null)),
    notes: notes.map((n) => ({ id: n.publicId, body: decryptOr(ctx, n.bodyEnc, noteAad(n.publicId)), authorIsMe: n.authorUserId === principal.userId, createdAt: n.createdAt.toISOString() })),
  };
}

export async function createCase(ctx: AuditCtx, principal: SessionPrincipal, input: { title: string; severity: (typeof CASE_SEVERITIES)[number]; eventIds?: string[] }): Promise<{ id: string }> {
  assertAuditCapability(ctx, principal, "audit.cases.manage");
  const title = cleanText(input.title, 120);
  if (!title) throw validation("TITLE_REQUIRED", "Give the case a title.");
  const publicId = ulid(ctx.deps.clock.now().getTime());
  await ctx.deps.db.transaction(async (tx) => {
    await assertActorCurrent(ctx, principal, tx, "audit.cases.manage");
    await tx.insert(auditCases).values({ publicId, titleEnc: ctx.deps.crypto.encrypt(title, titleAad(publicId)), severity: input.severity, createdBy: principal.userId });
    await ctx.deps.audit.record(
      { category: "security", eventName: "audit.case.created", action: "create", outcome: "completed", actor: actorOf(principal), resource: { type: "audit_case", publicId }, attributes: { severity: input.severity } },
      tx,
    );
  });
  if (input.eventIds && input.eventIds.length > 0) await attachEvents(ctx, principal, publicId, input.eventIds);
  return { id: publicId };
}

export async function updateCaseStatus(ctx: AuditCtx, principal: SessionPrincipal, id: string, status: CaseStatus): Promise<void> {
  assertAuditCapability(ctx, principal, "audit.cases.manage");
  await retentionGateReady(ctx);
  await ctx.deps.db.transaction(async (tx) => {
    // Reopening a case newly protects its events from retention: serialise with deletion.
    await lockGate(tx, "share");
    await assertActorCurrent(ctx, principal, tx, "audit.cases.manage");
    const row = await loadCase(ctx, id, true, tx);
    if (row.status === status) return;
    await tx.update(auditCases).set({ status, closedAt: status === "closed" ? ctx.deps.clock.now() : null }).where(eq(auditCases.id, row.id));
    await ctx.deps.audit.record(
      { category: "security", eventName: "audit.case.status_changed", action: "transition", outcome: "completed", actor: actorOf(principal), resource: { type: "audit_case", publicId: id }, attributes: { from_status: row.status, to_status: status } },
      tx,
    );
  });
}

export async function attachEvents(ctx: AuditCtx, principal: SessionPrincipal, id: string, eventIds: string[]): Promise<{ attached: number }> {
  assertAuditCapability(ctx, principal, "audit.cases.manage");
  const unique = [...new Set(eventIds)].filter((e) => ULID_PATTERN.test(e)).slice(0, 50);
  if (unique.length === 0) throw validation("EVENTS_REQUIRED", "Choose at least one event to attach.");
  let attached = 0;
  await retentionGateReady(ctx);
  await ctx.deps.db.transaction(async (tx) => {
    await lockGate(tx, "share");
    await assertActorCurrent(ctx, principal, tx, "audit.cases.manage");
    const row = await loadCase(ctx, id, true, tx);
    if (row.status === "closed") throw conflict("CASE_CLOSED", "Reopen the case before attaching events.");
    const existing = await tx.select({ eventId: auditEvents.eventId }).from(auditEvents).where(inArray(auditEvents.eventId, unique));
    const already = await tx.select({ eventId: auditCaseEvents.eventId }).from(auditCaseEvents).where(and(eq(auditCaseEvents.caseId, row.id), inArray(auditCaseEvents.eventId, unique)));
    const skip = new Set(already.map((a) => a.eventId));
    const toAdd = existing.map((e) => e.eventId).filter((e) => !skip.has(e));
    if (toAdd.length > 0) {
      await tx.insert(auditCaseEvents).values(toAdd.map((eventId) => ({ caseId: row.id, eventId, addedBy: principal.userId, addedAt: ctx.deps.clock.now() })));
      await tx.update(auditCases).set({ updatedAt: ctx.deps.clock.now() }).where(eq(auditCases.id, row.id));
    }
    attached = toAdd.length;
    await ctx.deps.audit.record(
      { category: "security", eventName: "audit.case.events_attached", action: "update", outcome: "completed", actor: actorOf(principal), resource: { type: "audit_case", publicId: id }, safeCounts: { attached, requested: unique.length } },
      tx,
    );
  });
  return { attached };
}

export async function addCaseNote(ctx: AuditCtx, principal: SessionPrincipal, id: string, body: string): Promise<{ id: string }> {
  assertAuditCapability(ctx, principal, "audit.cases.manage");
  const text = body.normalize("NFC").trim().slice(0, 4000);
  if (!text) throw validation("NOTE_REQUIRED", "Write a note before saving.");
  const publicId = ulid(ctx.deps.clock.now().getTime());
  await ctx.deps.db.transaction(async (tx) => {
    await assertActorCurrent(ctx, principal, tx, "audit.cases.manage");
    const row = await loadCase(ctx, id, true, tx);
    await tx.insert(auditCaseNotes).values({ publicId, caseId: row.id, authorUserId: principal.userId, bodyEnc: ctx.deps.crypto.encrypt(text, noteAad(publicId)), createdAt: ctx.deps.clock.now() });
    await tx.update(auditCases).set({ updatedAt: ctx.deps.clock.now() }).where(eq(auditCases.id, row.id));
    await ctx.deps.audit.record(
      { category: "security", eventName: "audit.case.note_added", action: "annotate", outcome: "completed", actor: actorOf(principal), resource: { type: "audit_case", publicId: id }, safeCounts: { characters: text.length } },
      tx,
    );
  });
  return { id: publicId };
}
