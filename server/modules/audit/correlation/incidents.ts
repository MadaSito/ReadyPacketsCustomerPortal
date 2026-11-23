/**
 * Security incidents (increment 06, D7 / ADR 0050): the correlation runner and the incident service.
 * Owner: audit engineer.
 *
 * Runner (job `security.correlation.run`, every minute):
 *   1. loads the classified sign-in / security audit events of the longest enabled window (bounded);
 *   2. evaluates the rules (rules.ts, pure);
 *   3. per finding, in ONE transaction serialised on `security_correlation_state` (FOR UPDATE): merges new
 *      evidence into the open/acknowledged incident with the same dedupe key, or opens a new incident; links
 *      the events (capped), appends the timeline and records `security.incident.opened|updated` atomically.
 * Incident events are never correlated themselves (their names are not in the loaded set).
 *
 * Service (principal-scoped, capability re-checked here, not only in the router):
 *   - read: `security.incidents.read` (admins);
 *   - acknowledge / close: `security.incidents.read` + the actor re-validated inside the transaction;
 *   - rule changes and "Ban IP": `security.firewall.manage` (fresh step-up); "End sessions": `sessions.revoke_any`
 *     (fresh step-up). The ban goes through Protection's port, which re-checks the actor, step-up and the
 *     lock-out guards (loopback, trusted proxies, allow-list, undeterminable client addresses) itself.
 * No raw addresses leave the server except to Protection's ban port; the page sees pseudonymous counts only.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import type { Capability } from "../../../../shared/capabilities.js";
import { DomainError, conflict, notFound, validation } from "../../../core/errors.js";
import { ULID_PATTERN, ulid } from "../../../core/ids.js";
import type { DbOrTx, SessionPrincipal, Tx } from "../../../core/types.js";
import { defineSetting } from "../../platform/settingsRegistry.js";
import { actorOf, assertActorCurrent, assertAuditCapability, type AuditCtx } from "../access.js";
import type { AuditQuery } from "../query.js";
import { decryptSourceAddress } from "../rows.js";
import { auditEvents, securityCorrelationState, securityIncidentEvents, securityIncidents, securityIncidentTimeline } from "../schema.js";
import {
  DEFAULT_CORRELATION_CONFIG,
  INCIDENT_SEVERITIES,
  RULE_INFO,
  RULE_KEYS,
  correlationConfigSchema,
  evaluateRules,
  lookbackMinutes,
  maxSeverity,
  parseCorrelationConfig,
  storedCorrelationConfigSchema,
  type CorrelationConfig,
  type CorrelationEvent,
  type Finding,
  type IncidentSeverity,
  type RuleKey,
  type SignalKind,
  type SubjectKind,
} from "./rules.js";

export const CORRELATION_JOB = "security.correlation.run";
export const CORRELATION_SETTING_KEY = "security.correlation";
export const INCIDENT_STATUSES = ["open", "acknowledged", "closed"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export const CLOSE_REASONS = ["resolved", "false_positive", "duplicate", "accepted_risk"] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];
/** Ban durations offered by the page; null = permanent. Protection bounds temporary bans to 1..10080 minutes. */
export const BAN_DURATIONS = [15, 60, 1440, 10_080] as const;

/** Most events loaded per run; beyond this the newest are kept and the run is reported as truncated. */
export const MAX_EVENTS_PER_RUN = 20_000;
/** Most events linked per incident (the count keeps growing past it). */
export const MAX_LINKED_EVENTS = 500;
const MIN = 60_000;

export const CORRELATION_SETTING = defineSetting({
  key: CORRELATION_SETTING_KEY,
  owner: "audit",
  group: "security",
  label: "Security event correlation",
  description: "Rules and thresholds that turn sign-in and security audit events into incidents (Audit center → Incidents).",
  schema: storedCorrelationConfigSchema,
  default: DEFAULT_CORRELATION_CONFIG,
  sensitivity: "internal",
  writeCapability: "security.firewall.manage",
  managedBy: { href: "/admin/audit/incidents", label: "Security incidents" },
});

/* -------------------------------------------------------------------------------- classification */

const FAILURE_NAMES = ["auth.login.failed", "identity.sso.callback_refused", "identity.sso.completion_refused", "auth.token.rejected"] as const;
const MFA_FAILURE_NAMES = ["auth.mfa.challenge_denied", "auth.totp.replay_denied", "auth.totp.locked", "auth.step_up.denied"] as const;
const SUCCESS_NAMES = ["auth.login.succeeded"] as const;
const RATE_NAMES = ["http.rate_limited", "auth.rate_limited"] as const;
const BAN_NAMES = ["security.ban.created"] as const;
const PRIVILEGE_NAMES = ["admin.staff.role_changed"] as const;
/** Completed data exports. New export events must be added here to take part in "privilege change followed by export". */
export const EXPORT_NAMES = [
  "audit.export.requested",
  "identity.sign_in_log.exported",
  "platform.config.exported",
  "policy.acceptance_log.exported",
  "portable.export.requested",
  "privacy.consent.exported",
  "promotion.exported",
  "protection.events_exported",
  "referrals.exported",
  "storage.copy_log.exported",
  "workflow.exported",
] as const;

const KIND_BY_NAME = new Map<string, SignalKind>([
  ...FAILURE_NAMES.map((n) => [n, "signin_failure"] as const),
  ...MFA_FAILURE_NAMES.map((n) => [n, "mfa_failure"] as const),
  ...SUCCESS_NAMES.map((n) => [n, "signin_success"] as const),
  ...RATE_NAMES.map((n) => [n, "rate_limited"] as const),
  ...BAN_NAMES.map((n) => [n, "ban_created"] as const),
  ...PRIVILEGE_NAMES.map((n) => [n, "privilege_change"] as const),
  ...EXPORT_NAMES.map((n) => [n, "export"] as const),
]);
export const CORRELATED_EVENT_NAMES: readonly string[] = [...KIND_BY_NAME.keys()];
const HEX32 = /^[0-9a-f]{32}$/;
const ACCOUNT_REF = /^[0-9a-f]{32,64}$/;

export interface CorrelationRow {
  eventId: string;
  eventName: string;
  occurredAt: Date;
  outcome: string;
  actorUserId: number | null;
  resourceType: string | null;
  resourcePublicId: string | null;
  sourceAddressRef: string | null;
  attributes: Record<string, unknown> | string | null;
}

export interface ClassifyLookups {
  /** identity's account blind index for a known user (null when unknown). */
  accountRefForUser(userId: number): Promise<string | null>;
  userPublicId(userId: number): Promise<string | null>;
}

const attrsOf = (row: CorrelationRow): Record<string, unknown> =>
  typeof row.attributes === "string" ? (JSON.parse(row.attributes) as Record<string, unknown>) : (row.attributes ?? {});

/** Audit row → correlation event; null when the row is not a correlation signal (e.g. an activation-link rejection). */
export async function classify(row: CorrelationRow, lookups: ClassifyLookups): Promise<CorrelationEvent | null> {
  const kind = KIND_BY_NAME.get(row.eventName);
  if (!kind) return null;
  const attrs = attrsOf(row);
  if (row.eventName === "auth.token.rejected" && attrs.purpose !== "password_reset") return null;
  if ((kind === "export" || kind === "signin_success" || kind === "privilege_change") && row.outcome !== "completed" && row.outcome !== "succeeded") return null;
  const resourceUser = row.resourceType === "user" && row.resourcePublicId ? row.resourcePublicId : null;
  let accountKey: string | null = null;
  let userPublicId: string | null = null;
  if (kind === "signin_failure" || kind === "mfa_failure" || kind === "signin_success") {
    if (typeof attrs.account_ref === "string" && ACCOUNT_REF.test(attrs.account_ref)) accountKey = attrs.account_ref;
    else if (row.actorUserId !== null) accountKey = await lookups.accountRefForUser(row.actorUserId);
    userPublicId = resourceUser ?? (row.actorUserId !== null ? await lookups.userPublicId(row.actorUserId) : null);
    if (accountKey === null && userPublicId !== null) accountKey = `user:${userPublicId}`;
  } else if (kind === "privilege_change") {
    userPublicId = resourceUser;
  } else if (kind === "export") {
    userPublicId = row.actorUserId !== null ? await lookups.userPublicId(row.actorUserId) : null;
  }
  const banAddressRef = kind === "ban_created" && typeof attrs.address_ref === "string" && HEX32.test(attrs.address_ref) ? attrs.address_ref : null;
  return {
    eventId: row.eventId,
    at: row.occurredAt.getTime(),
    name: row.eventName,
    kind,
    addressRef: row.sourceAddressRef && HEX32.test(row.sourceAddressRef) ? row.sourceAddressRef : null,
    accountKey,
    userPublicId,
    banAddressRef,
  };
}

/* ---------------------------------------------------------------------------------------- config */

export async function loadConfig(ctx: AuditCtx, tx?: Tx): Promise<CorrelationConfig> {
  return ctx.deps.settings.get(CORRELATION_SETTING_KEY, parseCorrelationConfig, DEFAULT_CORRELATION_CONFIG, tx);
}

/* ---------------------------------------------------------------------------------------- runner */

export interface RunSummary {
  events: number;
  findings: number;
  opened: number;
  updated: number;
  truncated: boolean;
}

async function ensureState(ctx: AuditCtx, tx: DbOrTx): Promise<void> {
  await tx.insert(securityCorrelationState).ignore().values({ id: 1 });
}

function lookupsFor(ctx: AuditCtx): ClassifyLookups {
  const refs = new Map<number, Promise<string | null>>();
  const ids = new Map<number, Promise<string | null>>();
  const identity = ctx.deps.services.identity;
  return {
    accountRefForUser(userId) {
      let p = refs.get(userId);
      if (!p) {
        p = identity.signInSignals.accountRefForUser(userId).catch(() => null);
        refs.set(userId, p);
      }
      return p;
    },
    userPublicId(userId) {
      let p = ids.get(userId);
      if (!p) {
        p = identity.getUser(userId).then((u) => u?.publicId ?? null, () => null);
        ids.set(userId, p);
      }
      return p;
    },
  };
}

export async function runCorrelation(ctx: AuditCtx): Promise<RunSummary> {
  const { db, clock } = ctx.deps;
  const config = await loadConfig(ctx);
  const now = clock.now();
  await ensureState(ctx, db);
  if (!config.enabled) {
    await db.update(securityCorrelationState).set({ lastRunAt: now, lastRunEvents: 0, lastRunFindings: 0, lastRunTruncated: false, lastRunReason: "DISABLED" }).where(eq(securityCorrelationState.id, 1));
    return { events: 0, findings: 0, opened: 0, updated: 0, truncated: false };
  }
  const from = new Date(now.getTime() - lookbackMinutes(config) * MIN);
  const rows = await db
    .select({
      eventId: auditEvents.eventId,
      eventName: auditEvents.eventName,
      occurredAt: auditEvents.occurredAt,
      outcome: auditEvents.outcome,
      actorUserId: auditEvents.actorUserId,
      resourceType: auditEvents.resourceType,
      resourcePublicId: auditEvents.resourcePublicId,
      sourceAddressRef: auditEvents.sourceAddressRef,
      attributes: auditEvents.attributes,
    })
    .from(auditEvents)
    .where(and(inArray(auditEvents.eventName, [...CORRELATED_EVENT_NAMES]), gte(auditEvents.occurredAt, from)))
    .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
    .limit(MAX_EVENTS_PER_RUN + 1);
  const truncated = rows.length > MAX_EVENTS_PER_RUN;
  const lookups = lookupsFor(ctx);
  const events: CorrelationEvent[] = [];
  for (const row of rows.slice(0, MAX_EVENTS_PER_RUN)) {
    const e = await classify(row, lookups);
    if (e) events.push(e);
  }
  const closed = await db
    .select({ dedupeKey: securityIncidents.dedupeKey, closedAt: securityIncidents.closedAt })
    .from(securityIncidents)
    .where(and(eq(securityIncidents.status, "closed"), isNotNull(securityIncidents.closedAt), gte(securityIncidents.closedAt, from)))
    .limit(5_000);
  // Typed column reads (not an SQL aggregate) so the driver returns UTC Dates, never a zone-less string.
  const floors = new Map<string, number>();
  for (const c of closed) if (c.closedAt) floors.set(c.dedupeKey, Math.max(floors.get(c.dedupeKey) ?? 0, c.closedAt.getTime()));
  const findings = evaluateRules(events, config, { floors });
  let opened = 0;
  let updated = 0;
  for (const f of findings) {
    const result = await applyFinding(ctx, f, config);
    if (result === "opened") opened += 1;
    else if (result === "updated") updated += 1;
  }
  await db
    .update(securityCorrelationState)
    .set({ lastRunAt: now, lastRunEvents: events.length, lastRunFindings: findings.length, lastRunTruncated: truncated, lastRunReason: truncated ? "EVENT_BUDGET_REACHED" : null })
    .where(eq(securityCorrelationState.id, 1));
  return { events: events.length, findings: findings.length, opened, updated, truncated };
}

function incidentAttributes(row: { publicId: string; ruleKey: string; severity: string; status: string; eventCount: number; accountCount: number; addressCount: number }) {
  return {
    incident_public_id: row.publicId,
    rule_key: row.ruleKey,
    severity: row.severity,
    status: row.status,
    event_count: row.eventCount,
    account_count: row.accountCount,
    address_count: row.addressCount,
  };
}

const AUDIT_SEVERITY: Record<IncidentSeverity, "INFO" | "WARN" | "ERROR"> = { low: "INFO", medium: "WARN", high: "WARN", critical: "ERROR" };

async function linkEvents(tx: Tx, incidentId: number, finding: Finding, eventNames: ReadonlyMap<string, { name: string; at: number }>, now: Date): Promise<number> {
  const existing = new Set<string>();
  for (let i = 0; i < finding.eventIds.length; i += 500) {
    const chunk = finding.eventIds.slice(i, i + 500);
    const got = await tx.select({ eventId: securityIncidentEvents.eventId }).from(securityIncidentEvents).where(and(eq(securityIncidentEvents.incidentId, incidentId), inArray(securityIncidentEvents.eventId, chunk)));
    for (const g of got) existing.add(g.eventId);
  }
  const fresh = finding.eventIds.filter((id) => !existing.has(id));
  if (fresh.length === 0) return 0;
  const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)` }).from(securityIncidentEvents).where(eq(securityIncidentEvents.incidentId, incidentId));
  const room = Math.max(0, MAX_LINKED_EVENTS - Number(n));
  const toLink = room > 0 ? fresh.slice(-room) : [];
  if (toLink.length > 0) {
    await tx
      .insert(securityIncidentEvents)
      .ignore()
      .values(toLink.map((eventId) => ({ incidentId, eventId, eventName: eventNames.get(eventId)?.name ?? "unknown", occurredAt: new Date(eventNames.get(eventId)?.at ?? now.getTime()), addedAt: now })));
  }
  return fresh.length;
}

async function applyFinding(ctx: AuditCtx, f: Finding, config: CorrelationConfig): Promise<"opened" | "updated" | "unchanged"> {
  const { db, clock, audit } = ctx.deps;
  const now = clock.now();
  const names = new Map<string, { name: string; at: number }>();
  const evRows = await db.select({ eventId: auditEvents.eventId, eventName: auditEvents.eventName, occurredAt: auditEvents.occurredAt }).from(auditEvents).where(inArray(auditEvents.eventId, f.eventIds.slice(-MAX_LINKED_EVENTS)));
  for (const r of evRows) names.set(r.eventId, { name: r.eventName, at: r.occurredAt.getTime() });
  return db.transaction(async (tx) => {
    await tx.select({ id: securityCorrelationState.id }).from(securityCorrelationState).where(eq(securityCorrelationState.id, 1)).for("update");
    const mergeFrom = new Date(f.firstAt - config.mergeMinutes * MIN);
    const [current] = await tx
      .select()
      .from(securityIncidents)
      .where(and(eq(securityIncidents.dedupeKey, f.dedupeKey), inArray(securityIncidents.status, ["open", "acknowledged"]), gte(securityIncidents.lastEventAt, mergeFrom)))
      .orderBy(desc(securityIncidents.lastEventAt))
      .limit(1)
      .for("update");
    if (current) {
      const added = await linkEvents(tx, current.id, f, names, now);
      if (added === 0) return "unchanged" as const;
      const severity = maxSeverity(current.severity as IncidentSeverity, f.severity);
      const next = {
        severity,
        eventCount: current.eventCount + added,
        accountCount: Math.max(current.accountCount, f.accountCount),
        addressCount: Math.max(current.addressCount, f.addressCount),
        lastEventAt: new Date(Math.max(current.lastEventAt.getTime(), f.lastAt)),
        userPublicId: f.userPublicId ?? current.userPublicId,
        addressEventId: f.addressEventId ?? current.addressEventId,
        version: current.version + 1,
      };
      await tx.update(securityIncidents).set(next).where(eq(securityIncidents.id, current.id));
      await tx.insert(securityIncidentTimeline).values({ incidentId: current.id, at: now, kind: "events_added", actorUserId: null, detail: { added } });
      if (severity !== current.severity) {
        await tx.insert(securityIncidentTimeline).values({ incidentId: current.id, at: now, kind: "escalated", actorUserId: null, detail: { from: current.severity, to: severity } });
      }
      await audit.record(
        {
          category: "security",
          eventName: "security.incident.updated",
          action: "update",
          outcome: "completed",
          severity: AUDIT_SEVERITY[severity],
          actor: { role: "system" },
          resource: { type: "security_incident", publicId: current.publicId },
          correlationId: current.publicId,
          attributes: { ...incidentAttributes({ ...current, ...next }), escalated: severity !== current.severity },
          safeCounts: { events_added: added },
        },
        tx,
      );
      return "updated" as const;
    }
    const publicId = ulid(now.getTime());
    const row = {
      publicId,
      ruleKey: f.ruleKey,
      severity: f.severity,
      status: "open" as const,
      dedupeKey: f.dedupeKey,
      subjectKind: f.subjectKind,
      subjectRef: f.subjectRef,
      userPublicId: f.userPublicId,
      addressEventId: f.addressEventId,
      firstEventAt: new Date(f.firstAt),
      lastEventAt: new Date(f.lastAt),
      eventCount: f.eventCount,
      accountCount: f.accountCount,
      addressCount: f.addressCount,
    };
    const [inserted] = await tx.insert(securityIncidents).values(row).$returningId();
    const incidentId = inserted!.id;
    await linkEvents(tx, incidentId, f, names, now);
    await tx.insert(securityIncidentTimeline).values({ incidentId, at: now, kind: "opened", actorUserId: null, detail: { rule_key: f.ruleKey, severity: f.severity, event_count: f.eventCount } });
    await audit.record(
      {
        category: "security",
        eventName: "security.incident.opened",
        action: "create",
        outcome: "completed",
        severity: AUDIT_SEVERITY[f.severity],
        actor: { role: "system" },
        resource: { type: "security_incident", publicId },
        correlationId: publicId,
        attributes: incidentAttributes(row),
      },
      tx,
    );
    return "opened" as const;
  });
}

/* --------------------------------------------------------------------------------------- service */

export interface IncidentSummary {
  publicId: string;
  ruleKey: RuleKey;
  ruleLabel: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  subjectKind: SubjectKind;
  firstEventAt: string;
  lastEventAt: string;
  eventCount: number;
  accountCount: number;
  addressCount: number;
  version: number;
  hasUser: boolean;
  hasAddress: boolean;
}

export interface IncidentEventItem {
  eventId: string;
  eventName: string;
  occurredAt: string;
}

export interface IncidentTimelineItem {
  at: string;
  kind: string;
  byMe: boolean;
  byPerson: boolean;
  detail: Record<string, string | number | boolean | null>;
}

export interface IncidentDetail extends IncidentSummary {
  acknowledgedAt: string | null;
  closedAt: string | null;
  closeReason: CloseReason | null;
  events: IncidentEventItem[];
  linkedEventsCapped: boolean;
  timeline: IncidentTimelineItem[];
  /** Ready-made audit search for "Open in audit search" (time window + correlated events / subject). */
  auditQuery: AuditQuery;
  actions: {
    banIp: { available: boolean; reason: "NO_ADDRESS" | "ADDRESS_UNDETERMINABLE" | "INCIDENT_CLOSED" | null };
    endSessions: { available: boolean; reason: "NO_USER" | "INCIDENT_CLOSED" | null };
  };
}

type IncidentRow = typeof securityIncidents.$inferSelect;

function summary(row: IncidentRow): IncidentSummary {
  const ruleKey = (RULE_KEYS as readonly string[]).includes(row.ruleKey) ? (row.ruleKey as RuleKey) : "brute_force_account";
  return {
    publicId: row.publicId,
    ruleKey,
    ruleLabel: RULE_INFO[ruleKey].label,
    severity: (INCIDENT_SEVERITIES as readonly string[]).includes(row.severity) ? (row.severity as IncidentSeverity) : "medium",
    status: (INCIDENT_STATUSES as readonly string[]).includes(row.status) ? (row.status as IncidentStatus) : "open",
    subjectKind: row.subjectKind as SubjectKind,
    firstEventAt: row.firstEventAt.toISOString(),
    lastEventAt: row.lastEventAt.toISOString(),
    eventCount: row.eventCount,
    accountCount: row.accountCount,
    addressCount: row.addressCount,
    version: row.version,
    hasUser: row.userPublicId !== null,
    hasAddress: row.addressEventId !== null,
  };
}

const READ: Capability = "security.incidents.read";

export async function listIncidents(
  ctx: AuditCtx,
  principal: SessionPrincipal,
  input: { status?: IncidentStatus; severity?: IncidentSeverity; ruleKey?: RuleKey; cursor?: string | null; limit?: number },
): Promise<{ items: IncidentSummary[]; nextCursor: string | null; counts: Record<IncidentStatus, number> }> {
  assertAuditCapability(ctx, principal, READ);
  const limit = Math.min(Math.max(1, input.limit ?? 25), 100);
  let cursor: { at: Date; id: number } | null = null;
  if (input.cursor) {
    const m = /^(\d{10,15})_(\d{1,15})$/.exec(input.cursor);
    if (!m) throw validation("CURSOR_INVALID", "This list has changed. Please reload it.");
    cursor = { at: new Date(Number(m[1])), id: Number(m[2]) };
  }
  const t = securityIncidents;
  const rows = await ctx.deps.db
    .select()
    .from(t)
    .where(
      and(
        input.status ? eq(t.status, input.status) : undefined,
        input.severity ? eq(t.severity, input.severity) : undefined,
        input.ruleKey ? eq(t.ruleKey, input.ruleKey) : undefined,
        cursor ? or(lt(t.lastEventAt, cursor.at), and(eq(t.lastEventAt, cursor.at), lt(t.id, cursor.id))) : undefined,
      ),
    )
    .orderBy(desc(t.lastEventAt), desc(t.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const countRows = await ctx.deps.db.select({ status: t.status, n: sql<number>`count(*)` }).from(t).groupBy(t.status);
  const counts: Record<IncidentStatus, number> = { open: 0, acknowledged: 0, closed: 0 };
  for (const c of countRows) if ((INCIDENT_STATUSES as readonly string[]).includes(c.status)) counts[c.status as IncidentStatus] = Number(c.n);
  const last = page[page.length - 1];
  return { items: page.map(summary), nextCursor: rows.length > limit && last ? `${last.lastEventAt.getTime()}_${last.id}` : null, counts };
}

async function loadIncident(tx: DbOrTx, publicId: string, forUpdate = false): Promise<IncidentRow> {
  if (!ULID_PATTERN.test(publicId)) throw notFound("INCIDENT_NOT_FOUND");
  const q = tx.select().from(securityIncidents).where(eq(securityIncidents.publicId, publicId));
  const [row] = forUpdate ? await q.for("update") : await q;
  if (!row) throw notFound("INCIDENT_NOT_FOUND");
  return row;
}

function auditQueryFor(row: IncidentRow, eventNames: readonly string[]): AuditQuery {
  const from = new Date(row.firstEventAt.getTime() - 5 * MIN).toISOString();
  const to = new Date(row.lastEventAt.getTime() + 5 * MIN).toISOString();
  const where = (term: { field: "source_address_ref" | "resource_public_id" | "event_name"; op: "eq" | "in"; value: string | string[] }) => ({ kind: "group" as const, op: "and" as const, terms: [term] });
  if (row.subjectKind === "address" && row.subjectRef && HEX32.test(row.subjectRef)) return { from, to, where: where({ field: "source_address_ref", op: "eq", value: row.subjectRef }) };
  if (row.userPublicId && row.subjectKind !== "global") return { from, to, where: where({ field: "resource_public_id", op: "eq", value: row.userPublicId }) };
  const names = [...new Set(eventNames)].slice(0, 25);
  return { from, to, where: where({ field: "event_name", op: "in", value: names.length > 0 ? names : [...FAILURE_NAMES] }) };
}

export async function getIncident(ctx: AuditCtx, principal: SessionPrincipal, publicId: string): Promise<IncidentDetail> {
  assertAuditCapability(ctx, principal, READ);
  const row = await loadIncident(ctx.deps.db, publicId);
  const events = await ctx.deps.db
    .select({ eventId: securityIncidentEvents.eventId, eventName: securityIncidentEvents.eventName, occurredAt: securityIncidentEvents.occurredAt })
    .from(securityIncidentEvents)
    .where(eq(securityIncidentEvents.incidentId, row.id))
    .orderBy(asc(securityIncidentEvents.occurredAt), asc(securityIncidentEvents.id))
    .limit(MAX_LINKED_EVENTS);
  const timeline = await ctx.deps.db
    .select()
    .from(securityIncidentTimeline)
    .where(eq(securityIncidentTimeline.incidentId, row.id))
    .orderBy(asc(securityIncidentTimeline.at), asc(securityIncidentTimeline.id))
    .limit(500);
  const closed = row.status === "closed";
  const determinable = ctx.deps.services.protection.clientAddressTrust().determinable;
  return {
    ...summary(row),
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    closeReason: (CLOSE_REASONS as readonly string[]).includes(row.closeReason ?? "") ? (row.closeReason as CloseReason) : null,
    events: events.map((e) => ({ eventId: e.eventId, eventName: e.eventName, occurredAt: e.occurredAt.toISOString() })),
    linkedEventsCapped: row.eventCount > events.length,
    timeline: timeline.map((t) => ({
      at: t.at.toISOString(),
      kind: t.kind,
      byMe: t.actorUserId !== null && t.actorUserId === principal.userId,
      byPerson: t.actorUserId !== null,
      detail: (typeof t.detail === "string" ? JSON.parse(t.detail) : t.detail) as Record<string, string | number | boolean | null>,
    })),
    auditQuery: auditQueryFor(row, events.map((e) => e.eventName)),
    actions: {
      banIp: closed
        ? { available: false, reason: "INCIDENT_CLOSED" }
        : row.addressEventId === null
          ? { available: false, reason: "NO_ADDRESS" }
          : !determinable
            ? { available: false, reason: "ADDRESS_UNDETERMINABLE" }
            : { available: true, reason: null },
      endSessions: closed ? { available: false, reason: "INCIDENT_CLOSED" } : row.userPublicId === null ? { available: false, reason: "NO_USER" } : { available: true, reason: null },
    },
  };
}

function staleVersion(): DomainError {
  return conflict("INCIDENT_CHANGED", "This incident changed while you were looking at it. Reload it and try again.");
}

async function recordIncidentEvent(ctx: AuditCtx, principal: SessionPrincipal, row: IncidentRow, eventName: string, action: string, tx: Tx, extra: Record<string, string | number | boolean | null> = {}) {
  await ctx.deps.audit.record(
    {
      category: "security",
      eventName,
      action,
      outcome: "completed",
      severity: "WARN",
      actor: actorOf(principal),
      resource: { type: "security_incident", publicId: row.publicId },
      correlationId: row.publicId,
      attributes: { ...incidentAttributes(row), ...extra },
    },
    tx,
  );
}

export async function acknowledgeIncident(ctx: AuditCtx, principal: SessionPrincipal, input: { publicId: string; expectedVersion: number }): Promise<IncidentSummary> {
  assertAuditCapability(ctx, principal, READ);
  return ctx.deps.db.transaction(async (tx) => {
    await assertActorCurrent(ctx, principal, tx, READ);
    const row = await loadIncident(tx, input.publicId, true);
    if (row.version !== input.expectedVersion) throw staleVersion();
    if (row.status !== "open") throw conflict("INCIDENT_NOT_OPEN", "Only an open incident can be acknowledged.");
    const now = ctx.deps.clock.now();
    const next = { ...row, status: "acknowledged", acknowledgedAt: now, acknowledgedBy: principal.userId, version: row.version + 1 };
    await tx.update(securityIncidents).set({ status: next.status, acknowledgedAt: now, acknowledgedBy: principal.userId, version: next.version }).where(eq(securityIncidents.id, row.id));
    await tx.insert(securityIncidentTimeline).values({ incidentId: row.id, at: now, kind: "acknowledged", actorUserId: principal.userId, detail: {} });
    await recordIncidentEvent(ctx, principal, next, "security.incident.acknowledged", "update", tx);
    return summary(next);
  });
}

export async function closeIncident(ctx: AuditCtx, principal: SessionPrincipal, input: { publicId: string; expectedVersion: number; reason: CloseReason }): Promise<IncidentSummary> {
  assertAuditCapability(ctx, principal, READ);
  if (!(CLOSE_REASONS as readonly string[]).includes(input.reason)) throw validation("CLOSE_REASON_INVALID", "Choose why the incident is closed.", { field: "reason" });
  return ctx.deps.db.transaction(async (tx) => {
    await assertActorCurrent(ctx, principal, tx, READ);
    const row = await loadIncident(tx, input.publicId, true);
    if (row.version !== input.expectedVersion) throw staleVersion();
    if (row.status === "closed") throw conflict("INCIDENT_ALREADY_CLOSED", "This incident is already closed.");
    const now = ctx.deps.clock.now();
    const next = { ...row, status: "closed", closedAt: now, closedBy: principal.userId, closeReason: input.reason, version: row.version + 1 };
    await tx.update(securityIncidents).set({ status: "closed", closedAt: now, closedBy: principal.userId, closeReason: input.reason, version: next.version }).where(eq(securityIncidents.id, row.id));
    await tx.insert(securityIncidentTimeline).values({ incidentId: row.id, at: now, kind: "closed", actorUserId: principal.userId, detail: { reason: input.reason } });
    await recordIncidentEvent(ctx, principal, next, "security.incident.closed", "close", tx, { close_reason: input.reason });
    return summary(next);
  });
}

/** Resolves the authoritative address of an audit event (server-side only). Null when absent or unreadable. */
async function addressOfEvent(ctx: AuditCtx, eventId: string): Promise<string | null> {
  if (!ULID_PATTERN.test(eventId)) return null;
  const [row] = await ctx.deps.db.select({ eventId: auditEvents.eventId, sourceAddressEnc: auditEvents.sourceAddressEnc }).from(auditEvents).where(eq(auditEvents.eventId, eventId)).limit(1);
  return row ? decryptSourceAddress(ctx.deps.crypto, row) : null;
}

const BAN_REASON = /^\P{Cc}{3,240}$/u;

function checkBanInput(input: { durationMinutes: number | null; reason: string }): string {
  const reason = input.reason.trim();
  if (!BAN_REASON.test(reason)) throw validation("BAN_REASON_INVALID", "Enter a reason of 3 to 240 characters.", { field: "reason" });
  if (input.durationMinutes !== null && !(BAN_DURATIONS as readonly number[]).includes(input.durationMinutes)) {
    throw validation("BAN_DURATION_INVALID", "Choose how long the ban lasts.", { field: "durationMinutes" });
  }
  return reason;
}

function noAddress(): DomainError {
  return conflict("BAN_ADDRESS_UNAVAILABLE", "This incident has no reliable client address to ban.");
}

/**
 * "Ban IP" on an incident: the address of the incident's address event (or of a chosen correlated event) is
 * resolved here and handed to Protection outside any transaction (its port re-checks actor, step-up and guards).
 */
export async function banIncidentAddress(
  ctx: AuditCtx,
  principal: SessionPrincipal,
  input: { publicId: string; eventId?: string; durationMinutes: number | null; reason: string },
): Promise<{ banPublicId: string; expiresAt: string | null }> {
  assertAuditCapability(ctx, principal, READ);
  assertAuditCapability(ctx, principal, "security.firewall.manage");
  const reason = checkBanInput(input);
  const row = await loadIncident(ctx.deps.db, input.publicId);
  if (row.status === "closed") throw conflict("INCIDENT_ALREADY_CLOSED", "This incident is already closed.");
  let eventId = row.addressEventId;
  if (input.eventId) {
    const [linked] = await ctx.deps.db.select({ id: securityIncidentEvents.id }).from(securityIncidentEvents).where(and(eq(securityIncidentEvents.incidentId, row.id), eq(securityIncidentEvents.eventId, input.eventId))).limit(1);
    if (!linked) throw notFound("INCIDENT_EVENT_NOT_FOUND");
    eventId = input.eventId;
  }
  if (!eventId) throw noAddress();
  if (!ctx.deps.services.protection.clientAddressTrust().determinable) {
    // The admin's own request: Protection's guard also refuses; say so plainly first.
    throw conflict("CLIENT_ADDRESS_UNDETERMINABLE", "Client addresses cannot be determined behind the current proxy setup, so bans are paused.");
  }
  const address = await addressOfEvent(ctx, eventId);
  if (!address) throw noAddress();
  const ban = await ctx.deps.services.protection.manualSignInBan(principal, { address, durationMinutes: input.durationMinutes, reason });
  await ctx.deps.db.transaction(async (tx) => {
    const current = await loadIncident(tx, row.publicId, true);
    const now = ctx.deps.clock.now();
    await tx.update(securityIncidents).set({ version: current.version + 1 }).where(eq(securityIncidents.id, current.id));
    await tx.insert(securityIncidentTimeline).values({
      incidentId: current.id,
      at: now,
      kind: "action_ban_ip",
      actorUserId: principal.userId,
      detail: { ban_public_id: ban.publicId, duration_minutes: input.durationMinutes, permanent: input.durationMinutes === null },
    });
    await recordIncidentEvent(ctx, principal, current, "security.incident.action", "ban", tx, { action_kind: "ban_ip", ban_public_id: ban.publicId, permanent: input.durationMinutes === null });
  });
  return { banPublicId: ban.publicId, expiresAt: ban.expiresAt ? new Date(ban.expiresAt).toISOString() : null };
}

/** "Ban this IP" from an audit event (Audit center event drawer). Admin + `security.firewall.manage`. */
export async function banEventAddress(ctx: AuditCtx, principal: SessionPrincipal, input: { eventId: string; durationMinutes: number | null; reason: string }): Promise<{ banPublicId: string; expiresAt: string | null }> {
  assertAuditCapability(ctx, principal, "audit.read");
  assertAuditCapability(ctx, principal, "security.firewall.manage");
  if (principal.role !== "admin") throw notFound("AUDIT_EVENT_NOT_FOUND");
  const reason = checkBanInput(input);
  if (!ctx.deps.services.protection.clientAddressTrust().determinable) {
    throw conflict("CLIENT_ADDRESS_UNDETERMINABLE", "Client addresses cannot be determined behind the current proxy setup, so bans are paused.");
  }
  const address = await addressOfEvent(ctx, input.eventId);
  if (!address) throw conflict("BAN_ADDRESS_UNAVAILABLE", "This event has no reliable client address to ban.");
  const ban = await ctx.deps.services.protection.manualSignInBan(principal, { address, durationMinutes: input.durationMinutes, reason });
  return { banPublicId: ban.publicId, expiresAt: ban.expiresAt ? new Date(ban.expiresAt).toISOString() : null };
}

/** "End sessions" for the incident's user through identity's session centre (sessions.revoke_any, step-up). */
export async function endIncidentSessions(ctx: AuditCtx, principal: SessionPrincipal, input: { publicId: string }): Promise<{ ended: number }> {
  assertAuditCapability(ctx, principal, READ);
  assertAuditCapability(ctx, principal, "sessions.revoke_any");
  const row = await loadIncident(ctx.deps.db, input.publicId);
  if (row.status === "closed") throw conflict("INCIDENT_ALREADY_CLOSED", "This incident is already closed.");
  if (!row.userPublicId) throw conflict("INCIDENT_NO_USER", "This incident is not tied to a known account.");
  const result = await ctx.deps.services.identity.centre.endForUser(principal, row.userPublicId, "SECURITY_INCIDENT");
  await ctx.deps.db.transaction(async (tx) => {
    const current = await loadIncident(tx, row.publicId, true);
    const now = ctx.deps.clock.now();
    await tx.update(securityIncidents).set({ version: current.version + 1 }).where(eq(securityIncidents.id, current.id));
    await tx.insert(securityIncidentTimeline).values({ incidentId: current.id, at: now, kind: "action_end_sessions", actorUserId: principal.userId, detail: { sessions_ended: result.ended } });
    await recordIncidentEvent(ctx, principal, current, "security.incident.action", "revoke", tx, { action_kind: "end_sessions" });
  });
  return result;
}

/* ------------------------------------------------------------------------------------------ rules */

export interface RulesView {
  config: CorrelationConfig;
  info: typeof RULE_INFO;
  lastRun: { at: string | null; events: number; findings: number; truncated: boolean; reason: string | null };
  addressesDeterminable: boolean;
  canEdit: boolean;
}

export async function getRules(ctx: AuditCtx, principal: SessionPrincipal): Promise<RulesView> {
  assertAuditCapability(ctx, principal, READ);
  const config = await loadConfig(ctx);
  const [state] = await ctx.deps.db.select().from(securityCorrelationState).where(eq(securityCorrelationState.id, 1)).limit(1);
  let canEdit = true;
  try {
    assertAuditCapability(ctx, principal, "security.firewall.manage");
  } catch (error) {
    canEdit = error instanceof DomainError && error.reasonCode === "STEP_UP_REQUIRED";
  }
  return {
    config,
    info: RULE_INFO,
    lastRun: {
      at: state?.lastRunAt?.toISOString() ?? null,
      events: state?.lastRunEvents ?? 0,
      findings: state?.lastRunFindings ?? 0,
      truncated: state?.lastRunTruncated ?? false,
      reason: state?.lastRunReason ?? null,
    },
    addressesDeterminable: ctx.deps.services.protection.clientAddressTrust().determinable,
    canEdit,
  };
}

export async function updateRules(ctx: AuditCtx, principal: SessionPrincipal, input: CorrelationConfig): Promise<CorrelationConfig> {
  assertAuditCapability(ctx, principal, READ);
  assertAuditCapability(ctx, principal, "security.firewall.manage");
  const parsed = correlationConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw validation("CORRELATION_RULES_INVALID", "Some rule values are out of range.", { fields: parsed.error.issues.slice(0, 10).map((i) => i.path.join(".") || "_") });
  }
  return ctx.deps.db.transaction(async (tx) => {
    await assertActorCurrent(ctx, principal, tx, "security.firewall.manage");
    await ctx.deps.settings.set(CORRELATION_SETTING_KEY, parsed.data, tx);
    return parsed.data;
  });
}
