import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { ModuleDeps } from "../../container.js";
import { conflict, validation } from "../../core/errors.js";
import type { Db, SessionPrincipal, Tx } from "../../core/types.js";
import { registerAutomationTrigger } from "../automations/contracts.js";
import { customerMaintenance } from "./schema.js";

const POLICY_ID = 1;
const FALLBACK = "Customer sign-in and registration are temporarily unavailable for maintenance.";
const utcInstant = z.string().max(24).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);
export const customerMaintenanceInput = z.strictObject({
  enabled: z.boolean(),
  message: z.string().max(500),
  startsAt: utcInstant.nullable(),
  endsAt: utcInstant.nullable(),
  expectedVersion: z.number().int().min(0).max(0xffff_ffff),
});
type CustomerMaintenanceInput = z.infer<typeof customerMaintenanceInput>;
type Policy = typeof customerMaintenance.$inferSelect;

export interface CustomerAccessStatus {
  active: boolean;
  message: string | null;
  expectedEnd: string | null;
}

function parseUtc(value: string | null): Date | null {
  if (value === null) return null;
  const date = new Date(value);
  if (!utcInstant.safeParse(value).success || !Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1000
    || date.toISOString() !== (value.length === 20 ? value.replace(/Z$/, ".000Z") : value)) {
    throw validation("CUSTOMER_MAINTENANCE_TIME_INVALID", "Use a valid date and time in UTC.");
  }
  return date;
}

export function customerMaintenanceNotice(attributes: Readonly<Record<string, unknown>>, canonicalOrigin: string) {
  const asTime = (value: unknown) => typeof value === "string" && utcInstant.safeParse(value).success
    ? `${value.slice(0, 10)} ${value.slice(11, 19)} UTC` : null;
  const start = asTime(attributes.starts_at);
  const end = asTime(attributes.ends_at);
  return {
    windowLabel: `${start ?? "Immediate start"} to ${end ?? "no scheduled end"}`,
    summary: "Customer sign-in, registration and single sign-on may be unavailable during the configured window. Check the portal for current status.",
    link: new URL("/sign-in", canonicalOrigin).href,
  };
}

registerAutomationTrigger({
  key: "customer_maintenance.configured",
  entry: {
    fields: [
      { key: "windowLabel", label: "Customer maintenance window", type: "string", from: "context" },
      { key: "summary", label: "Standard maintenance summary", type: "string", from: "context" },
      { key: "link", label: "Portal sign-in page", type: "string", from: "context" },
    ],
  },
  async resolveContext({ event, services, signal }) {
    signal.throwIfAborted();
    return { fields: customerMaintenanceNotice(event.attributes, services.config.canonicalOrigin) };
  },
});

function project(row: Policy | undefined, now: Date): CustomerAccessStatus {
  return row?.enabled && (!row.startsAt || row.startsAt <= now) && (!row.endsAt || now < row.endsAt)
    ? { active: true, message: row.message || FALLBACK, expectedEnd: row.endsAt?.toISOString() ?? null }
    : { active: false, message: null, expectedEnd: null };
}

function adminView(row: Policy | undefined, now: Date) {
  const active = project(row, now).active;
  const phase = !row?.enabled ? "off" : active ? "active" : row.endsAt && row.endsAt <= now ? "ended" : "scheduled";
  return {
    enabled: row?.enabled ?? false, message: row?.message ?? "", startsAt: row?.startsAt?.toISOString() ?? null,
    endsAt: row?.endsAt?.toISOString() ?? null, version: row?.version ?? 0, active, phase,
  };
}

export function createCustomerMaintenance(deps: ModuleDeps) {
  const { db, clock } = deps;
  const query = (executor: Db | Tx) => executor.select().from(customerMaintenance)
    .where(eq(customerMaintenance.id, POLICY_ID)).limit(1);

  async function lock(tx: Tx, mode: "share" | "update"): Promise<Policy> {
    // The nonlocking existence read avoids a missing-row gap lock and a lock upgrade.
    // The row is never deleted by the service. Concurrent initialization uses an idempotent upsert.
    const [existing] = await query(tx);
    if (!existing) {
      await tx.insert(customerMaintenance).values({ id: POLICY_ID, updatedAt: clock.now() })
        .onDuplicateKeyUpdate({ set: { id: sql`${customerMaintenance.id}` } });
    }
    const [current] = await query(tx).for(mode);
    if (!current) throw new Error("CUSTOMER_MAINTENANCE_POLICY_MISSING");
    return current;
  }

  return {
    async customerAccess(tx?: Tx): Promise<CustomerAccessStatus> {
      const policy = tx ? await lock(tx, "share") : (await query(db))[0];
      return project(policy, clock.now());
    },
    async read() {
      const [policy] = await query(db);
      return adminView(policy, clock.now());
    },
    async write(actor: SessionPrincipal, input: CustomerMaintenanceInput, tx: Tx) {
      if (!customerMaintenanceInput.safeParse(input).success) {
        throw validation("CUSTOMER_MAINTENANCE_INVALID", "Check the maintenance settings and try again.");
      }
      const message = input.message.normalize("NFC").trim();
      if (message.length > 500 || /[\p{Cc}\p{Cs}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069<>]/u.test(message)) {
        throw validation("CUSTOMER_MAINTENANCE_MESSAGE_INVALID", "Use plain text without markup or control characters.");
      }
      const startsAt = parseUtc(input.startsAt);
      const endsAt = parseUtc(input.endsAt);
      const current = await lock(tx, "update");
      if (current.version !== input.expectedVersion) {
        throw conflict("CUSTOMER_MAINTENANCE_CHANGED", "Customer maintenance settings changed. Refresh and try again.");
      }
      const now = clock.now();
      if (startsAt && endsAt && endsAt <= startsAt) {
        throw validation("CUSTOMER_MAINTENANCE_WINDOW_INVALID", "The expected end must be after the start.");
      }
      if (input.enabled && endsAt && endsAt <= now) {
        throw validation("CUSTOMER_MAINTENANCE_WINDOW_INVALID", "Choose a future expected end or leave it blank.");
      }
      const next = { enabled: input.enabled, message, startsAt, endsAt, version: current.version + 1, updatedAt: now };
      if (current.enabled === next.enabled && current.message === next.message
        && current.startsAt?.getTime() === next.startsAt?.getTime() && current.endsAt?.getTime() === next.endsAt?.getTime()) {
        return adminView(current, now);
      }
      await tx.update(customerMaintenance).set(next).where(eq(customerMaintenance.id, POLICY_ID));
      await deps.audit.record({
        category: "job", eventName: "job.customer_maintenance.changed", action: "transition", outcome: "completed",
        reasonCode: input.enabled ? "CUSTOMER_MAINTENANCE_CONFIGURED" : "CUSTOMER_MAINTENANCE_DISABLED",
        actor: { userId: actor.userId, role: actor.role }, resource: { type: "customer_maintenance" },
        attributes: { enabled: input.enabled, starts_at: startsAt?.toISOString() ?? null, ends_at: endsAt?.toISOString() ?? null },
      }, tx);
      return adminView({ ...current, ...next }, now);
    },
  };
}
