/**
 * Order history (increment 04 part B, S2): the order-scoped audit port. Owner: audit engineer.
 *
 * Returns only audit events whose subject is ONE order — `audit_events.order_public_id` (new rows), or the order
 * as resource (rows written before that column existed). Two projections:
 *  - customer: curated, customer-visible event names only; actor is "You", "ReadyPackets staff", "ReadyPackets"
 *    or "Someone with access to this order"; no names, IP, pseudonyms, correlation or event ids;
 *  - staff: every order-scoped event, actor role + display name, outcome, reason code, correlation id and safe
 *    attributes. Never the source address (that stays in the audit center behind `audit.read`).
 * Access is the orders policy (`assertCanReadOrder`): a customer without access gets NOT_FOUND.
 */
import { and, desc, eq, inArray, isNull, like, lt, not, or, sql, type SQL } from "drizzle-orm";
import { validation } from "../../core/errors.js";
import type { SessionPrincipal } from "../../core/types.js";
import type { AuditCtx } from "./access.js";
import { auditEvents } from "./schema.js";

export const ORDER_ACTIVITY_CATEGORIES = ["details", "status", "access", "phases", "acceptance", "files", "storage", "production", "automation", "payments", "other"] as const;
export type OrderActivityCategory = (typeof ORDER_ACTIVITY_CATEGORIES)[number];
export const ORDER_ACTIVITY_MAX_PAGE = 50;

interface CatalogueEntry {
  /** Exact event name, or a prefix ending in `.*`. */
  pattern: string;
  category: Exclude<OrderActivityCategory, "other">;
  label: string;
  customer: boolean;
  /** Customers see the event only when this attribute has exactly this value (fail closed when absent). */
  customerRequires?: { key: string; value: string };
}
const CUSTOMER_FILE = { key: "file_visibility", value: "customer_visible" } as const;

/**
 * Event names other modules emit for an order. Publish additions to their owners; an order-scoped event that is
 * not listed still shows to staff under "other" with its event name, never to customers.
 */
export const ORDER_ACTIVITY_CATALOGUE: readonly CatalogueEntry[] = Object.freeze([
  { pattern: "order.created", category: "details", label: "Order created", customer: true },
  { pattern: "order.updated", category: "details", label: "Order details updated", customer: true },
  { pattern: "order.renamed", category: "details", label: "Order renamed", customer: true },
  { pattern: "order.reference.changed", category: "details", label: "Order reference changed", customer: true },
  { pattern: "order.reassigned", category: "details", label: "Order moved to another customer", customer: false },
  { pattern: "order.reassign.refused", category: "details", label: "Order move refused", customer: false },
  { pattern: "order.imported", category: "details", label: "Order imported", customer: false },
  { pattern: "order.note.added", category: "details", label: "Note added", customer: false },
  { pattern: "order.status.changed", category: "status", label: "Status changed", customer: true },
  { pattern: "order.transition.denied", category: "status", label: "Status change refused", customer: false },
  { pattern: "order.lock.changed", category: "status", label: "Order lock changed", customer: true },
  { pattern: "order.access.granted", category: "access", label: "Access granted", customer: true },
  { pattern: "order.access.revoked", category: "access", label: "Access removed", customer: true },
  { pattern: "order.share.invited", category: "access", label: "Invitation sent", customer: true },
  { pattern: "order.share.revoked", category: "access", label: "Invitation withdrawn", customer: true },
  { pattern: "order.phase.submitted", category: "phases", label: "Phase submitted", customer: true },
  { pattern: "order.phase.reviewed", category: "phases", label: "Phase reviewed", customer: true },
  { pattern: "order.phase.locked", category: "phases", label: "Phase locked", customer: true },
  { pattern: "order.phase.reopened", category: "phases", label: "Phase reopened", customer: true },
  { pattern: "order.phase.unlocked", category: "phases", label: "Phase unlocked", customer: true },
  { pattern: "order.acknowledgement.recorded", category: "acceptance", label: "Acknowledgement recorded", customer: true },
  { pattern: "order.acceptance.recorded", category: "acceptance", label: "Policy accepted", customer: true },
  { pattern: "order.acceptance.*", category: "acceptance", label: "Acceptance gate", customer: false },
  { pattern: "file.uploaded", category: "files", label: "File uploaded", customer: true, customerRequires: CUSTOMER_FILE },
  { pattern: "order.file.uploaded", category: "files", label: "File uploaded", customer: true, customerRequires: CUSTOMER_FILE },
  { pattern: "order.file.recorded", category: "files", label: "Recording saved", customer: true, customerRequires: CUSTOMER_FILE },
  { pattern: "order.file.converted", category: "files", label: "Recording converted", customer: true, customerRequires: CUSTOMER_FILE },
  { pattern: "file.audio.conversion", category: "files", label: "Recording converted", customer: true, customerRequires: CUSTOMER_FILE },
  { pattern: "order.file.copy.*", category: "storage", label: "File copy to storage", customer: false },
  { pattern: "storage.order_file.copy", category: "storage", label: "File copy to storage", customer: false },
  { pattern: "storage.copy_result", category: "storage", label: "Storage copy result", customer: false },
  { pattern: "sharepoint.order.sync", category: "storage", label: "SharePoint order sync", customer: false },
  { pattern: "order.production.*", category: "production", label: "Production pipeline", customer: false },
  { pattern: "integration.production.dispatch.*", category: "production", label: "Production dispatch", customer: false },
  { pattern: "order.stage_actions.run", category: "automation", label: "Workflow stage actions run", customer: false },
  { pattern: "automation.manual.triggered", category: "automation", label: "Automation run", customer: false },
  { pattern: "payment.refund.succeeded", category: "payments", label: "Refund issued", customer: true },
  { pattern: "payment.refund.prepared", category: "payments", label: "Refund prepared", customer: false },
  { pattern: "payment.refund.sent", category: "payments", label: "Refund sent to the payment provider", customer: false },
  { pattern: "payment.refund.failed", category: "payments", label: "Refund failed", customer: false },
  { pattern: "payment.refund.unknown", category: "payments", label: "Refund outcome unknown", customer: false },
  { pattern: "payment.created", category: "payments", label: "Payment created", customer: false },
  { pattern: "payment.updated", category: "payments", label: "Payment updated", customer: false },
  { pattern: "invoice.created", category: "payments", label: "Invoice created", customer: false },
  { pattern: "invoice.draft_updated", category: "payments", label: "Invoice draft updated", customer: false },
  { pattern: "invoice.updated", category: "payments", label: "Invoice updated", customer: false },
  { pattern: "invoice.issued", category: "payments", label: "Invoice issued", customer: true },
  { pattern: "invoice.paid", category: "payments", label: "Invoice paid", customer: true },
  { pattern: "invoice.payment.recorded", category: "payments", label: "Payment recorded", customer: true },
  { pattern: "invoice.payment.refused", category: "payments", label: "Payment refused", customer: false },
  { pattern: "invoice.refund.recorded", category: "payments", label: "Refund recorded", customer: true },
  { pattern: "invoice.refund.refused", category: "payments", label: "Refund refused", customer: false },
  { pattern: "invoice.voided", category: "payments", label: "Invoice voided", customer: true },
  { pattern: "invoice.downloaded", category: "payments", label: "Invoice downloaded", customer: false },
  { pattern: "invoice.provider_event.scaffold_recorded", category: "payments", label: "Payment provider event recorded", customer: false },
  /* Increment 05 (D3): discount codes on an order. Audit carries the promotion public id and label, never the code. */
  { pattern: "promotion.redeemed", category: "payments", label: "Discount code applied", customer: true },
  { pattern: "promotion.released", category: "payments", label: "Discount code released", customer: true },
  /* Increment 05 (D4): order gate acceptance evidence is already "order.acceptance.recorded" above. */
  /* Wildcards label with the humanised event name (see `humanizeEventName`). */
  { pattern: "payment.*", category: "payments", label: "", customer: false },
  { pattern: "invoice.*", category: "payments", label: "", customer: false },
]);

/** "invoice.refund.recorded" → "Invoice refund recorded": unknown or wildcard events never show a dotted identifier. */
export function humanizeEventName(eventName: string): string {
  const words = eventName.replace(/[._]+/gu, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Activity";
}

function matches(entry: CatalogueEntry, eventName: string): boolean {
  return entry.pattern.endsWith(".*") ? eventName.startsWith(entry.pattern.slice(0, -1)) : eventName === entry.pattern;
}
/** First match wins, so exact customer entries are listed before their wildcard. */
export function classifyOrderEvent(eventName: string): CatalogueEntry | null {
  return ORDER_ACTIVITY_CATALOGUE.find((e) => matches(e, eventName)) ?? null;
}

function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`;
}
function nameOf(entry: CatalogueEntry): SQL {
  return entry.pattern.endsWith(".*") ? like(auditEvents.eventName, likePrefix(entry.pattern.slice(0, -1))) : eq(auditEvents.eventName, entry.pattern);
}
/** `withRequirements`: add each entry's customer attribute requirement (customer view). */
function nameCondition(entries: readonly CatalogueEntry[], withRequirements = false): SQL | undefined {
  const plain = entries.filter((e) => !(withRequirements && e.customerRequires));
  const exact = plain.filter((e) => !e.pattern.endsWith(".*")).map((e) => e.pattern);
  const parts: SQL[] = [...(exact.length ? [inArray(auditEvents.eventName, exact)] : []), ...plain.filter((e) => e.pattern.endsWith(".*")).map(nameOf)];
  for (const e of entries) {
    if (!withRequirements || !e.customerRequires) continue;
    const path = `$.${e.customerRequires.key}`;
    parts.push(and(nameOf(e), sql`JSON_UNQUOTE(JSON_EXTRACT(${auditEvents.attributes}, ${path})) = ${e.customerRequires.value}`)!);
  }
  return parts.length ? or(...parts) : undefined;
}

export interface OrderActivityInput {
  orderPublicId: string;
  category?: OrderActivityCategory;
  cursor?: string | null;
  limit?: number;
}
export interface OrderActivityCustomerItem {
  key: string;
  at: string;
  category: OrderActivityCategory;
  label: string;
  actor: string;
  /** Only fixed vocabularies (status keys, phase keys). */
  details: Record<string, string>;
}
export interface OrderActivityStaffItem extends Omit<OrderActivityCustomerItem, "details"> {
  eventId: string;
  eventName: string;
  outcome: string;
  reasonCode: string | null;
  actorRole: string;
  correlationId: string | null;
  details: Record<string, string | number | boolean | null>;
}
export type OrderActivityPage =
  | { view: "customer"; items: OrderActivityCustomerItem[]; nextCursor: string | null }
  | { view: "staff"; items: OrderActivityStaffItem[]; nextCursor: string | null };

const CUSTOMER_DETAIL_KEYS = new Set(["from_status", "to_status", "phase", "phase_key", "lock_state"]);
const HIDDEN_DETAIL_KEY = /(^order_public_id$|_ref$|_hash$|_sha256$|address|_ip$)/u;
const CUSTOMER_OUTCOMES = ["completed", "succeeded"];

/**
 * Opaque cursor: AES-GCM over the sort anchor, bound (AAD) to order, viewer, projection and category, so it
 * reveals no event id and cannot be replayed for another order, person or filter.
 */
function cursorAad(principal: SessionPrincipal, orderPublicId: string, view: string, category: string | undefined): string {
  return `audit.order_activity.cursor:${orderPublicId}:${principal.userId}:${view}:${category ?? "all"}`;
}
function encodeCursor(ctx: AuditCtx, aad: string, at: Date, eventId: string): string {
  return Buffer.from(ctx.deps.crypto.encrypt(`${at.toISOString()}|${eventId}`, aad), "utf8").toString("base64url");
}
function decodeCursor(ctx: AuditCtx, aad: string, cursor: string): { at: Date; eventId: string } {
  let text: string;
  try {
    text = ctx.deps.crypto.decrypt(Buffer.from(cursor, "base64url").toString("utf8"), aad);
  } catch {
    throw validation("CURSOR_INVALID", "The page cursor is not valid.");
  }
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|([0-9A-HJKMNP-TV-Z]{26})$/u.exec(text);
  const at = match ? new Date(match[1]!) : null;
  if (!match || !at || Number.isNaN(at.getTime())) throw validation("CURSOR_INVALID", "The page cursor is not valid.");
  return { at, eventId: match[2]! };
}

type Row = typeof auditEvents.$inferSelect;

export async function listOrderActivity(ctx: AuditCtx, principal: SessionPrincipal, input: OrderActivityInput): Promise<OrderActivityPage> {
  const { deps } = ctx;
  // Orders policy decides visibility (NOT_FOUND for customers without access; staff/admin per their policy).
  const order = await deps.services.orders.assertCanReadOrder(principal, input.orderPublicId);
  const customerView = principal.role === "customer";
  const limit = Math.min(Math.max(input.limit ?? 25, 1), ORDER_ACTIVITY_MAX_PAGE);

  let entries: readonly CatalogueEntry[] | null = null; // null = no name restriction
  if (customerView) entries = ORDER_ACTIVITY_CATALOGUE.filter((e) => e.customer);
  if (input.category && input.category !== "other") entries = (entries ?? ORDER_ACTIVITY_CATALOGUE).filter((e) => e.category === input.category);
  if ((entries !== null && entries.length === 0) || (customerView && input.category === "other")) return { view: customerView ? "customer" : "staff", items: [], nextCursor: null };
  const names = entries ? nameCondition(entries, customerView) : undefined;
  const otherOnly = input.category === "other" ? nameCondition(ORDER_ACTIVITY_CATALOGUE) : undefined;

  const aad = cursorAad(principal, order.publicId, customerView ? "customer" : "staff", input.category);
  const cursor = input.cursor ? decodeCursor(ctx, aad, input.cursor) : null;
  const before = cursor
    ? or(lt(auditEvents.occurredAt, cursor.at), and(eq(auditEvents.occurredAt, cursor.at), lt(auditEvents.eventId, cursor.eventId)))
    : undefined;
  const common = and(
    names,
    otherOnly ? not(otherOnly) : undefined,
    customerView ? inArray(auditEvents.outcome, CUSTOMER_OUTCOMES) : undefined,
    before,
  );
  const orderRef = deps.crypto.pseudonym(`order:${order.publicId}`, "audit.resource").slice(0, 32);
  const newest = [desc(auditEvents.occurredAt), desc(auditEvents.eventId)] as const;
  // Two indexed lookups (ix_audit_order_time; ix_audit_res_time for rows from before the column), merged here.
  const [bySubject, byResource] = await Promise.all([
    deps.db.select().from(auditEvents).where(and(eq(auditEvents.orderPublicId, order.publicId), common)).orderBy(...newest).limit(limit + 1),
    deps.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.resourceType, "order"), eq(auditEvents.resourceRef, orderRef), isNull(auditEvents.orderPublicId), common))
      .orderBy(...newest)
      .limit(limit + 1),
  ]);
  const merged = [...bySubject, ...byResource].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || (a.eventId < b.eventId ? 1 : -1));
  const page = merged.slice(0, limit);
  const nextCursor = merged.length > limit && page.length ? encodeCursor(ctx, aad, page[page.length - 1]!.occurredAt, page[page.length - 1]!.eventId) : null;

  if (customerView) {
    return { view: "customer", items: page.map((row) => customerItem(ctx, principal, row)), nextCursor };
  }
  const people = await actorNames(ctx, page);
  return { view: "staff", items: page.map((row) => staffItem(row, people)), nextCursor };
}

function base(row: Row) {
  const entry = classifyOrderEvent(row.eventName);
  const label = entry && !entry.pattern.endsWith(".*") && entry.label ? entry.label : humanizeEventName(row.eventName);
  return { at: row.occurredAt.toISOString(), category: entry?.category ?? ("other" as const), label };
}

function customerItem(ctx: AuditCtx, principal: SessionPrincipal, row: Row): OrderActivityCustomerItem {
  const details: Record<string, string> = {};
  for (const [k, v] of Object.entries(row.attributes ?? {})) if (CUSTOMER_DETAIL_KEYS.has(k) && typeof v === "string") details[k] = v;
  let actor: string;
  if (row.actorRole === "staff" || row.actorRole === "admin") actor = "ReadyPackets staff";
  else if (row.actorRole === "customer") actor = row.actorUserId === principal.userId ? "You" : "Someone with access to this order";
  else actor = "ReadyPackets";
  return { key: ctx.deps.crypto.pseudonym(row.eventId, "audit.order_activity").slice(0, 16), ...base(row), actor, details };
}

function staffItem(row: Row, names: Map<number, string>): OrderActivityStaffItem {
  const details: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(row.attributes ?? {})) if (!HIDDEN_DETAIL_KEY.test(k)) details[k] = v;
  const role = row.actorRole;
  const actor = row.actorUserId !== null ? (names.get(row.actorUserId) ?? `Former ${role === "customer" ? "customer" : "staff member"}`) : role === "system" ? "System" : "Anonymous";
  return {
    key: row.eventId,
    eventId: row.eventId,
    eventName: row.eventName,
    ...base(row),
    actor,
    actorRole: role,
    outcome: row.outcome,
    reasonCode: row.reasonCode,
    correlationId: row.correlationId,
    details,
  };
}

async function actorNames(ctx: AuditCtx, rows: Row[]): Promise<Map<number, string>> {
  const ids = [...new Set(rows.map((r) => r.actorUserId).filter((id): id is number => id !== null))].slice(0, ORDER_ACTIVITY_MAX_PAGE);
  const out = new Map<number, string>();
  await Promise.all(
    ids.map(async (id) => {
      const user = await ctx.deps.services.identity.getUser(id);
      if (user) out.set(id, user.name);
    }),
  );
  return out;
}


/* ------------------------------------------------------------------ status lane (transitions + renames) */

export interface OrderStatusHistoryItem {
  key: string;
  kind: "transition" | "rename";
  at: string;
  actor: string;
  /** transition */
  from?: string | null;
  fromLabel?: string | null;
  to?: string;
  toLabel?: string;
  note?: string | null;
  /** rename — staff/admin projection only; customers get a generic "Order renamed" entry (lead decision, B2). */
  oldName?: string | null;
  newName?: string | null;
}
export interface OrderStatusHistoryPage {
  view: "customer" | "staff";
  items: OrderStatusHistoryItem[];
  nextCursor: string | null;
}

/** Per-lane keyset position: `c` = the orders-port cursor (null = from the start), `e` = lane exhausted. */
interface LanePos { c: string | null; e: boolean }
interface LaneState { t: LanePos; r: LanePos }
const START: LanePos = { c: null, e: false };

function isLanePos(v: unknown): v is LanePos {
  if (!v || typeof v !== "object") return false;
  const { c, e } = v as { c: unknown; e: unknown };
  return (c === null || (typeof c === "string" && c.length <= 200)) && typeof e === "boolean";
}

/**
 * Left column of the Order history tab: lifecycle transitions and renames, merged by a two-lane keyset merge.
 * Each lane keeps its own orders-port cursor; a page takes `limit` items in total, newest first, with a
 * deterministic tie order (equal timestamps: transition before rename; within a lane, the port's id order).
 * When a lane is only partly consumed, its cursor is re-derived by re-reading exactly the consumed prefix, so
 * no entry is skipped or repeated and there is no fixed window.
 */
export async function listOrderStatusHistory(
  ctx: AuditCtx,
  principal: SessionPrincipal,
  input: { orderPublicId: string; cursor?: string | null; limit?: number },
): Promise<OrderStatusHistoryPage> {
  const { deps } = ctx;
  const order = await deps.services.orders.assertCanReadOrder(principal, input.orderPublicId);
  const customerView = principal.role === "customer";
  const view = customerView ? "customer" : "staff";
  const limit = Math.min(Math.max(input.limit ?? 25, 1), ORDER_ACTIVITY_MAX_PAGE);
  const aad = `audit.order_status_history.cursor:${order.publicId}:${principal.userId}:${view}`;
  let state: LaneState = { t: START, r: START };
  if (input.cursor) {
    try {
      const parsed: unknown = JSON.parse(deps.crypto.decrypt(Buffer.from(input.cursor, "base64url").toString("utf8"), aad));
      if (!parsed || typeof parsed !== "object" || !isLanePos((parsed as LaneState).t) || !isLanePos((parsed as LaneState).r)) throw new Error("shape");
      state = parsed as LaneState;
    } catch {
      throw validation("CURSOR_INVALID", "The page cursor is not valid.");
    }
  }
  const orders = deps.services.orders;
  const readT = (pos: LanePos, n: number) => orders.listStatusTransitions(order.id, { cursor: pos.c, limit: n, customerView });
  const readR = (pos: LanePos, n: number) => orders.listNameHistory(order.id, { cursor: pos.c, limit: n, customerView });
  const empty = { items: [], nextCursor: null };
  const [tPage, rPage] = await Promise.all([state.t.e ? empty : readT(state.t, limit), state.r.e ? empty : readR(state.r, limit)]);
  const ts = tPage.items as Awaited<ReturnType<typeof readT>>["items"];
  const rs = rPage.items as Awaited<ReturnType<typeof readR>>["items"];

  // Two-pointer merge; lane order is preserved so each lane contributes a prefix of its page.
  const picked: ({ lane: "t"; v: (typeof ts)[number] } | { lane: "r"; v: (typeof rs)[number] })[] = [];
  let ti = 0;
  let ri = 0;
  while (picked.length < limit && (ti < ts.length || ri < rs.length)) {
    const t = ts[ti];
    const r = rs[ri];
    if (t && (!r || t.at.getTime() >= r.at.getTime())) picked.push({ lane: "t", v: ts[ti++]! });
    else picked.push({ lane: "r", v: rs[ri++]! });
  }

  const advance = async (pos: LanePos, page: { items: unknown[]; nextCursor: string | null }, used: number, reread: (p: LanePos, n: number) => Promise<{ nextCursor: string | null }>): Promise<LanePos> => {
    if (pos.e || used === 0) return pos;
    if (used === page.items.length) return page.nextCursor ? { c: page.nextCursor, e: false } : { c: null, e: true };
    const prefix = await reread(pos, used);
    return prefix.nextCursor ? { c: prefix.nextCursor, e: false } : { c: null, e: true };
  };
  const exhausted = (pos: LanePos, page: { items: unknown[]; nextCursor: string | null }) => pos.e || (page.items.length === 0 && page.nextCursor === null);
  const nextState: LaneState = {
    t: exhausted(state.t, tPage) ? { c: null, e: true } : await advance(state.t, tPage, ti, readT),
    r: exhausted(state.r, rPage) ? { c: null, e: true } : await advance(state.r, rPage, ri, readR),
  };
  const more = !nextState.t.e || !nextState.r.e;

  const people = customerView ? new Map<number, string>() : await namesFor(ctx, picked.map((p) => p.v.actorUserId));
  const actorOf = (userId: number | null, role: string): string => {
    if (customerView) {
      if (role === "staff" || role === "admin") return "ReadyPackets staff";
      if (role === "system") return "ReadyPackets";
      return userId === principal.userId ? "You" : "Someone with access to this order";
    }
    if (userId === null) return role === "system" ? "System" : "ReadyPackets staff";
    return people.get(userId) ?? (role === "customer" ? "Former customer" : "Former staff member");
  };
  const keyOf = (kind: string, at: Date, i: number) => deps.crypto.pseudonym(`${order.publicId}:${kind}:${at.toISOString()}:${i}:${input.cursor ?? ""}`, "audit.order_status_history").slice(0, 16);

  const items: OrderStatusHistoryItem[] = picked.map((p, i) => {
    if (p.lane === "t") {
      const t = p.v;
      return { key: keyOf("t", t.at, i), kind: "transition", at: t.at.toISOString(), actor: actorOf(t.actorUserId, t.actorRole), from: t.from, fromLabel: t.fromLabel, to: t.to, toLabel: t.toLabel, note: t.note };
    }
    const r = p.v;
    const base: OrderStatusHistoryItem = { key: keyOf("r", r.at, i), kind: "rename", at: r.at.toISOString(), actor: actorOf(r.actorUserId, r.actorRole) };
    return customerView ? base : { ...base, oldName: r.oldName, newName: r.newName };
  });
  const nextCursor = more ? Buffer.from(deps.crypto.encrypt(JSON.stringify(nextState), aad), "utf8").toString("base64url") : null;
  return { view, items, nextCursor };
}

async function namesFor(ctx: AuditCtx, ids: (number | null)[]): Promise<Map<number, string>> {
  const unique = [...new Set(ids.filter((id): id is number => id !== null))].slice(0, ORDER_ACTIVITY_MAX_PAGE * 2);
  const out = new Map<number, string>();
  await Promise.all(unique.map(async (id) => {
    const user = await ctx.deps.services.identity.getUser(id);
    if (user) out.set(id, user.name);
  }));
  return out;
}
