import { and, count, desc, eq, exists, isNull, lt, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { ModuleDeps } from "../../container.js";
import { DomainError, forbidden, notFound, validation } from "../../core/errors.js";
import { ULID_PATTERN, ulid } from "../../core/ids.js";
import type { SessionPrincipal, Tx } from "../../core/types.js";
import { roleHasCapability } from "../../../shared/capabilities.js";
import { scanValue } from "../../observability/redact.js";
import { currentCorrelation, keyHash } from "../jobs/queue.js";
import { orders } from "../orders/schema.js";
import { liveOrderPredicate } from "../orders/trashGate.js";
import { createActorGuard } from "../platform/actorGuard.js";
import { readSetting, writeSetting } from "../platform/index.js";
import { ATTENTION_ALERT_HOURS, ATTENTION_ALERTS_ENABLED, registerAttentionReminder } from "./attention.js";
import { OPS_ALERT_SEVERITIES, OPS_ALERT_SOURCES, OPS_ALERT_STATES, operationalAlerts } from "./schema.js";

export type { OpsAlertSeverity, OpsAlertSource, OpsAlertState } from "./schema.js";
const publicId = z.string().regex(ULID_PATTERN);
const identity = {
  source: z.enum(OPS_ALERT_SOURCES),
  dedupKey: z.string().regex(/^[a-zA-Z0-9_.:-]{1,200}$/u),
  correlationId: z.string().optional(),
};
const copy = (max: number) => z.string().trim().min(1).max(max)
  .refine((value) => !/[\p{Cc}\p{Cf}<>]/u.test(value) && scanValue(value).hits.length === 0);
const alertInput = z.strictObject({
  ...identity, severity: z.enum(OPS_ALERT_SEVERITIES), code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/u),
  title: copy(120), text: copy(500).optional(), orderPublicId: publicId.optional(), runPublicId: publicId.optional(),
});
const identityInput = z.strictObject(identity);
export const operationalAlertListInput = z.strictObject({
  severity: z.enum(OPS_ALERT_SEVERITIES).optional(),
  state: z.enum(OPS_ALERT_STATES).optional(),
  source: z.enum(OPS_ALERT_SOURCES).optional(),
  cursor: publicId.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type EmitOpsAlert = z.input<typeof alertInput>;
export type OpsAlertIdentity = z.input<typeof identityInput>;
type AlertRow = typeof operationalAlerts.$inferSelect;
const ranks = { warning: 0, error: 1, critical: 2 } as const;
const auditSeverity = { warning: "WARN", error: "ERROR", critical: "FATAL" } as const;

function view(row: AlertRow) {
  const { publicId, source, severity, state, title, text, code, orderPublicId, runPublicId, correlationId,
    acknowledgedAt, resolvedAt, createdAt, updatedAt } = row;
  return { publicId, source, severity, state, title, text, code, orderPublicId, runPublicId, correlationId,
    acknowledgedAt, resolvedAt, createdAt, updatedAt };
}

export function createOpsAlertsModule(deps: ModuleDeps) {
  const { db, clock, audit } = deps;
  // Ledger alerts (notably money received after trashing) must stay visible.
  const visibleAlert = or(
    ne(operationalAlerts.source, "attention"), isNull(operationalAlerts.orderPublicId),
    exists(db.select({ one: sql`1` }).from(orders).where(and(
      eq(orders.publicId, operationalAlerts.orderPublicId), liveOrderPredicate(),
    ))),
  );
  const byIdentity = (input: OpsAlertIdentity) => and(
    eq(operationalAlerts.source, input.source), eq(operationalAlerts.dedupHash, keyHash(input.dedupKey)),
  );
  async function record(
    tx: Tx, row: Pick<AlertRow, "publicId" | "source" | "severity" | "code" | "orderPublicId" | "correlationId">,
    event: "opened" | "escalated" | "acknowledged" | "resolved", actor?: { userId: number; role: SessionPrincipal["role"] },
  ) {
    await audit.record({
      category: "job", eventName: `ops.alert.${event}`, action: "transition", outcome: "completed",
      severity: event === "opened" || event === "escalated" ? auditSeverity[row.severity] : "INFO",
      reasonCode: row.code, actor: actor ?? { role: "system" },
      resource: { type: "operational_alert", publicId: row.publicId },
      orderPublicId: row.orderPublicId, correlationId: row.correlationId,
      attributes: { alert_source: row.source, alert_severity: row.severity },
    }, tx);
  }
  async function transition(tx: Tx, row: AlertRow, state: "acknowledged" | "resolved", actor?: { userId: number; role: SessionPrincipal["role"] }, correlationId?: string) {
    if (row.state === "resolved" || row.state === state) return false;
    const now = clock.now();
    await tx.update(operationalAlerts).set({
      state, updatedAt: now,
      ...(state === "resolved" ? { resolvedAt: now, resolvedByUserId: actor?.userId ?? null }
        : { acknowledgedAt: now, acknowledgedByUserId: actor?.userId ?? null }),
    }).where(eq(operationalAlerts.id, row.id));
    await record(tx, { ...row, correlationId: currentCorrelation(row.correlationId, correlationId) }, state, actor);
    return true;
  }
  const service = {
    async emit(input: EmitOpsAlert, tx?: Tx) {
      const parsed = alertInput.safeParse(input);
      if (!parsed.success) throw validation("INVALID_OPERATIONAL_ALERT", "The operational alert is invalid.");
      const data = parsed.data;
      const now = clock.now();
      const id = ulid(now.getTime());
      const correlationId = currentCorrelation(id, data.correlationId);
      const inner = async (handle: Tx) => {
        await handle.insert(operationalAlerts).values({
          publicId: id, source: data.source, severity: data.severity, code: data.code, title: data.title,
          text: data.text, orderPublicId: data.orderPublicId, runPublicId: data.runPublicId,
          dedupHash: keyHash(data.dedupKey), correlationId, createdAt: now, updatedAt: now,
        }).onDuplicateKeyUpdate({ set: { id: sql`${operationalAlerts.id}` } });
        const [row] = await handle.select().from(operationalAlerts).where(byIdentity(data)).limit(1).for("update");
        if (!row) throw new Error("OPS_ALERT_WRITE_INVARIANT");
        if (row.publicId === id) await record(handle, row, "opened");
        else if (row.state !== "resolved" && ranks[data.severity] > ranks[row.severity]) {
          await handle.update(operationalAlerts).set({
            severity: data.severity, state: "open", code: data.code, title: data.title, text: data.text ?? null,
            correlationId, updatedAt: now, acknowledgedAt: null, acknowledgedByUserId: null,
          }).where(eq(operationalAlerts.id, row.id));
          await record(handle, { ...row, severity: data.severity, code: data.code, correlationId }, "escalated");
          return { publicId: row.publicId, state: "open" as const };
        }
        return { publicId: row.publicId, state: row.state };
      };
      return tx ? inner(tx) : db.transaction(inner);
    },
    async resolve(input: OpsAlertIdentity, tx?: Tx) {
      const parsed = identityInput.safeParse(input);
      if (!parsed.success) throw validation("INVALID_OPERATIONAL_ALERT", "The operational alert is invalid.");
      const inner = async (handle: Tx) => {
        const [row] = await handle.select().from(operationalAlerts).where(byIdentity(parsed.data)).limit(1).for("update");
        return row ? transition(handle, row, "resolved", undefined, parsed.data.correlationId) : false;
      };
      return tx ? inner(tx) : db.transaction(inner);
    },
    async summary() {
      const rows = await db.select({ severity: operationalAlerts.severity, total: count() }).from(operationalAlerts)
        .where(and(eq(operationalAlerts.state, "open"), visibleAlert)).groupBy(operationalAlerts.severity);
      const result = { warning: 0, error: 0, critical: 0 };
      for (const row of rows) result[row.severity] = row.total;
      return result;
    },
    async list(input: z.input<typeof operationalAlertListInput>) {
      const parsed = operationalAlertListInput.safeParse(input);
      if (!parsed.success) throw validation("INVALID_OPERATIONAL_ALERT_FILTER", "The alert filter is invalid.");
      const { severity, state, source, cursor, limit = 30 } = parsed.data;
      const rows = await db.select().from(operationalAlerts).where(and(
        visibleAlert, severity && eq(operationalAlerts.severity, severity), state && eq(operationalAlerts.state, state),
        source && eq(operationalAlerts.source, source), cursor ? lt(operationalAlerts.publicId, cursor) : undefined,
      )).orderBy(desc(operationalAlerts.publicId)).limit(limit + 1);
      return { items: rows.slice(0, limit).map(view), nextCursor: rows.length > limit ? rows[limit - 1]!.publicId : null };
    },
    async manage(principal: SessionPrincipal, id: string, state: "acknowledged" | "resolved") {
      return db.transaction(async (tx) => {
        const current = await deps.services.identity.sessions.assertCurrent(principal, tx);
        if (current.pendingSteps.length) throw new DomainError("REMEDIATION_REQUIRED", "ACCOUNT_STEP_PENDING", "Finish securing your account first.");
        if (!roleHasCapability(current.role, "ops.alerts.manage")) throw forbidden("OPS_ALERT_MANAGE_FORBIDDEN");
        const [row] = await tx.select().from(operationalAlerts)
          .where(and(eq(operationalAlerts.publicId, id), visibleAlert)).limit(1).for("update");
        if (!row) throw notFound();
        return { changed: await transition(tx, row, state, { userId: principal.userId, role: current.role }) };
      });
    },
    async reminderConfig() {
      const [enabled, hours] = await Promise.all([
        readSetting(deps.settings, ATTENTION_ALERTS_ENABLED),
        readSetting(deps.settings, ATTENTION_ALERT_HOURS),
      ]);
      return { enabled, hours };
    },
    async updateReminderConfig(principal: SessionPrincipal, config: { enabled: boolean; hours: number }) {
      return db.transaction(async (tx) => {
        await createActorGuard(deps.services, clock, principal)(tx);
        await writeSetting(deps.settings, ATTENTION_ALERTS_ENABLED, config.enabled, tx);
        await writeSetting(deps.settings, ATTENTION_ALERT_HOURS, config.hours, tx);
        await audit.record({
          category: "admin", eventName: "ops.alert.attention_configured", action: "update", outcome: "completed",
          actor: { userId: principal.userId, role: "admin" }, resource: { type: "operational_alert_config" },
          attributes: { enabled: config.enabled }, safeCounts: { threshold_hours: config.hours },
        }, tx);
        return config;
      });
    },
  };
  return { ...service, init: () => registerAttentionReminder(deps, service) };
}

export type OpsAlertsModule = ReturnType<typeof createOpsAlertsModule>;
