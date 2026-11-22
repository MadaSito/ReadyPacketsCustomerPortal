/**
 * Increment 04 (package D): administrator session centre, sign-in log, restrictions settings, customer-wide
 * forced end, and the caller's own security overview. Every read is capability-checked by the router AND
 * here (defence in depth); every mutation re-validates the actor inside its transaction (authorizeInTx) and
 * records its audit event in that transaction.
 *
 * Lock order (mutations): actor (+ target) `users` rows ascending (authorizeInTx) → `identity_session_restrictions`
 * → `user_sessions` → `identity_sign_in_events` (insert only).
 */
import { and, desc, eq, gt, gte, inArray, isNull, lt, lte, type SQL } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import { DomainError, forbidden, notFound, validation } from "../../core/errors.js";
import type { SessionPrincipal, Tx } from "../../core/types.js";
import { roleHasCapability, type Capability } from "../../../shared/capabilities.js";
import type { AuthMethod, UserRole } from "../../../shared/domain.js";
import { STEP_UP_MAX_AGE_MS } from "../../trpc/trpc.js";
import { sessionRestrictions, signInEvents, userSessions, users, type SignInEventKind, type SignInEventRow, type UserRow } from "./schema.js";
import { admission, parseCidr, SIGN_IN_IP_PURPOSE, parseIp, type Restrictions, type SessionPolicy } from "./sessionPolicy.js";
import type { SessionService } from "./sessions.js";
import { toView } from "./users.js";

const MAX_LIMIT = 100;
const EXPORT_MAX = 5_000;
export const SIGN_IN_LOG_RETENTION_DAYS = 180;

export interface AdminSessionItem {
  sessionId: string;
  user: { publicId: string; name: string; email: string; role: UserRole; customerRef: string | null };
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  authMethod: AuthMethod;
  deviceSummary: string | null;
  ipAddress: string | null;
  country: string | null;
  current: boolean;
}

export interface SignInLogItem {
  id: string;
  occurredAt: Date;
  kind: SignInEventKind;
  reasonCode: string | null;
  user: { publicId: string; name: string; role: UserRole } | null;
  authMethod: AuthMethod | null;
  sessionId: string | null;
  ipAddress: string | null;
  country: string | null;
  deviceSummary: string | null;
  actor: { publicId: string; name: string } | null;
}

export interface SignInLogFilter {
  kind?: SignInEventKind;
  userId?: string;
  role?: UserRole;
  authMethod?: AuthMethod;
  country?: string;
  ip?: string;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit?: number;
}

export interface RestrictionsInput {
  expectedVersion: number;
  enabled: boolean;
  maxConcurrentPerUser: number | null;
  idleMinutes: Record<UserRole, number | null>;
  absoluteHours: Record<UserRole, number | null>;
  consoleIpAllowList: string[];
  countryMode: "off" | "allow" | "deny";
  countryScope: "all" | "customers" | "console";
  countries: string[];
  allowUnknownCountry: boolean;
}

type AuthorizeInTx = (tx: Tx, principal: SessionPrincipal, capability: Capability, targetPublicId?: string) => Promise<UserRow | null>;

const encodeCursor = (id: number) => Buffer.from(String(id)).toString("base64url");
function decodeCursor(cursor: string | undefined): number | null {
  if (!cursor) return null;
  const n = Number(Buffer.from(cursor, "base64url").toString());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const csvCell = (value: unknown) => {
  const text = value === null || value === undefined ? "" : value instanceof Date ? value.toISOString() : String(value);
  // Formula-injection guard for spreadsheet consumers + RFC 4180 quoting.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function createSessionCentre(i: {
  deps: ModuleDeps;
  sessions: SessionService;
  policy: SessionPolicy;
  authorizeInTx: AuthorizeInTx;
}) {
  const { deps, sessions, policy, authorizeInTx } = i;

  /** Pre-transaction capability check (cheap refusal + no work); authoritative re-check happens in tx. */
  function require(principal: SessionPrincipal, capability: Capability, roles: readonly UserRole[] = ["admin"]): void {
    if (principal.state !== "full" || !roles.includes(principal.role) || !roleHasCapability(principal.role, capability)) throw forbidden("CAPABILITY_NOT_GRANTED");
  }

  function requireFreshStepUp(stepUpAt: Date | null): void {
    const age = stepUpAt ? deps.clock.now().getTime() - stepUpAt.getTime() : -1;
    if (!(age >= 0 && age <= STEP_UP_MAX_AGE_MS)) throw new DomainError("FORBIDDEN", "STEP_UP_REQUIRED", "Confirm your identity again to continue.");
  }

  const viewOf = (row: UserRow) => {
    const view = toView(deps.crypto, row);
    return { publicId: view.publicId, name: view.name, email: view.email, role: view.role, customerRef: view.customerRef };
  };

  async function userIdOf(publicId: string | undefined): Promise<number | null | undefined> {
    if (publicId === undefined) return undefined;
    const [row] = await deps.db.select({ id: users.id }).from(users).where(eq(users.publicId, publicId)).limit(1);
    return row?.id ?? null;
  }

  function signInConditions(filter: SignInLogFilter, userId: number | null | undefined): (SQL | undefined)[] {
    const conditions: (SQL | undefined)[] = [];
    if (filter.kind) conditions.push(eq(signInEvents.kind, filter.kind));
    if (userId !== undefined) conditions.push(eq(signInEvents.userId, userId ?? -1));
    if (filter.role) conditions.push(eq(signInEvents.role, filter.role));
    if (filter.authMethod) conditions.push(eq(signInEvents.authMethod, filter.authMethod));
    if (filter.country) conditions.push(eq(signInEvents.country, filter.country));
    if (filter.ip) {
      const ip = parseIp(filter.ip);
      if (!ip) throw validation("IP_INVALID", "Enter a full IPv4 or IPv6 address.", { field: "ip" });
      conditions.push(eq(signInEvents.ipIndex, deps.crypto.blindIndex(ip.normalized, SIGN_IN_IP_PURPOSE)));
    }
    if (filter.from) conditions.push(gte(signInEvents.occurredAt, filter.from));
    if (filter.to) conditions.push(lte(signInEvents.occurredAt, filter.to));
    return conditions;
  }

  async function signInItems(rows: SignInEventRow[]): Promise<SignInLogItem[]> {
    const ids = [...new Set(rows.flatMap((r) => [r.userId, r.actorUserId]).filter((v): v is number => v !== null))];
    const people = ids.length ? await deps.db.select().from(users).where(inArray(users.id, ids)) : [];
    const byId = new Map(people.map((row) => [row.id, viewOf(row)]));
    return rows.map((row) => {
      const user = row.userId !== null ? byId.get(row.userId) : undefined;
      const actor = row.actorUserId !== null ? byId.get(row.actorUserId) : undefined;
      let ipAddress: string | null = null;
      if (row.ipAddressEnc) {
        try {
          ipAddress = deps.crypto.decrypt(row.ipAddressEnc, `identity_sign_in_events.ip:${row.publicId}`);
        } catch {
          ipAddress = null;
        }
      }
      return {
        id: row.publicId,
        occurredAt: row.occurredAt,
        kind: row.kind,
        reasonCode: row.reasonCode,
        user: user ? { publicId: user.publicId, name: user.name, role: user.role } : null,
        authMethod: row.authMethod,
        sessionId: row.sessionPublicId,
        ipAddress,
        country: row.country,
        deviceSummary: row.deviceSummary,
        actor: actor ? { publicId: actor.publicId, name: actor.name } : null,
      };
    });
  }

  function restrictionsView(r: Restrictions, principal: SessionPrincipal) {
    const facts = policy.requestFacts();
    return {
      ...r,
      breakGlassActive: policy.breakGlass(),
      yourAddress: facts.ip,
      yourCountry: facts.country,
      yourAdmission: admission({ ...r, enabled: true }, principal.role, facts.ip, facts.country),
    };
  }

  function validateRestrictions(input: RestrictionsInput): { cidrs: string[]; countries: string[] } {
    const bad = (field: string, message: string) => validation("RESTRICTIONS_INVALID", message, { field });
    if (input.maxConcurrentPerUser !== null && (input.maxConcurrentPerUser < 1 || input.maxConcurrentPerUser > 50)) throw bad("maxConcurrentPerUser", "Use 1 to 50, or leave empty for no limit.");
    for (const role of ["customer", "staff", "admin"] as const) {
      const idle = input.idleMinutes[role];
      const absolute = input.absoluteHours[role];
      if (idle !== null && (idle < 5 || idle > 240)) throw bad(`idleMinutes.${role}`, "Idle timeout must be 5 to 240 minutes.");
      if (absolute !== null && (absolute < 1 || absolute > 72)) throw bad(`absoluteHours.${role}`, "Session lifetime must be 1 to 72 hours.");
    }
    const cidrs: string[] = [];
    for (const raw of input.consoleIpAllowList) {
      const parsed = parseCidr(raw);
      if (!parsed) throw bad("consoleIpAllowList", `"${raw.slice(0, 60)}" is not a valid address or network (IPv4 /8–/32, IPv6 /16–/128, host bits zero).`);
      if (!cidrs.includes(parsed.normalized)) cidrs.push(parsed.normalized);
    }
    if (cidrs.length > 100) throw bad("consoleIpAllowList", "Use at most 100 networks.");
    const countries = [...new Set(input.countries.map((c) => c.trim().toUpperCase()))];
    if (countries.some((c) => !/^[A-Z]{2}$/.test(c))) throw bad("countries", "Use two-letter ISO country codes.");
    if (countries.length > 250) throw bad("countries", "Use at most 250 countries.");
    if (input.countryMode !== "off" && countries.length === 0) throw bad("countries", "Choose at least one country, or turn the country rule off.");
    return { cidrs, countries };
  }

  return {
    /* ------------------------------------------------------------ self */

    async securityOverview(principal: SessionPrincipal) {
      const items = await sessions.listForUser(principal.userId, principal.sessionId, principal.role);
      const rows = await deps.db
        .select()
        .from(signInEvents)
        .where(eq(signInEvents.userId, principal.userId))
        .orderBy(desc(signInEvents.id))
        .limit(20);
      const activity = (await signInItems(rows)).map(({ id, occurredAt, kind, authMethod, country, deviceSummary, ipAddress, sessionId }) => ({
        id, occurredAt, kind, authMethod, country, deviceSummary, ipAddress, current: sessionId === principal.sessionId,
      }));
      return { sessions: items, activity };
    },

    /* ------------------------------------------------------------ live sessions */

    async listSessions(principal: SessionPrincipal, input: { role?: UserRole; authMethod?: AuthMethod; country?: string; userId?: string; cursor?: string; limit?: number }) {
      require(principal, "sessions.read_all", ["staff", "admin"]);
      const limit = Math.min(Math.max(input.limit ?? 25, 1), MAX_LIMIT);
      const now = deps.clock.now();
      const after = decodeCursor(input.cursor);
      const conditions: (SQL | undefined)[] = [isNull(userSessions.revokedAt), gt(userSessions.absoluteExpiresAt, now), eq(users.status, "active")];
      if (input.role) conditions.push(eq(users.role, input.role));
      if (input.authMethod) conditions.push(eq(userSessions.authMethod, input.authMethod));
      if (input.country) conditions.push(eq(userSessions.country, input.country));
      if (input.userId) conditions.push(eq(users.publicId, input.userId));
      if (after !== null) conditions.push(lt(userSessions.id, after));
      const rows = await deps.db
        .select({ session: userSessions, user: users })
        .from(userSessions)
        .innerJoin(users, eq(users.id, userSessions.userId))
        .where(and(...conditions))
        .orderBy(desc(userSessions.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const restrictions = await policy.load();
      const policies = new Map<UserRole, { idleMs: number; absoluteMs: number }>();
      for (const role of ["customer", "staff", "admin"] as const) policies.set(role, await sessions.policy(undefined, role, restrictions));
      const items: AdminSessionItem[] = page
        .filter(({ session, user }) => session.deviceSummary !== "ops:demo_seed" && sessions.isLive(session, user, now, policies.get(user.role)!))
        .map(({ session, user }) => {
          const p = policies.get(user.role)!;
          return {
            sessionId: session.publicId,
            user: viewOf(user),
            createdAt: session.authenticatedAt,
            lastSeenAt: session.lastSeenAt,
            expiresAt: new Date(Math.min(session.absoluteExpiresAt.getTime(), session.lastSeenAt.getTime() + p.idleMs, session.authenticatedAt.getTime() + p.absoluteMs)),
            authMethod: session.authMethod,
            deviceSummary: session.deviceSummary,
            ipAddress: sessions.ipOf(session),
            country: session.country,
            current: session.publicId === principal.sessionId,
          };
        });
      return { items, nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!.session.id) : null };
    },

    async endSession(principal: SessionPrincipal, sessionId: string, reasonCode: string): Promise<{ ok: true }> {
      require(principal, "sessions.revoke_any");
      if (sessionId === principal.sessionId) {
        throw new DomainError("CONFLICT", "OWN_SESSION", "This is your current session. Use Sign out instead.");
      }
      return deps.db.transaction(async (tx) => {
        await authorizeInTx(tx, principal, "sessions.revoke_any");
        const ended = await sessions.revokeAny(sessionId, "admin_ended", tx, principal.userId);
        if (!ended) throw notFound("SESSION_NOT_FOUND");
        const [owner] = await tx.select({ publicId: users.publicId }).from(users).where(eq(users.id, ended.userId)).limit(1);
        await deps.audit.record(
          {
            category: "security", eventName: "auth.session.ended_by_admin", action: "revoke", outcome: "completed", reasonCode,
            resource: { type: "session", publicId: sessionId }, attributes: { user_public_id: owner?.publicId ?? "unknown" },
          },
          tx,
        );
        return { ok: true as const };
      });
    },

    async endForUser(principal: SessionPrincipal, userPublicId: string, reasonCode: string): Promise<{ ended: number }> {
      require(principal, "sessions.revoke_any");
      return deps.db.transaction(async (tx) => {
        const target = await authorizeInTx(tx, principal, "sessions.revoke_any", userPublicId);
        if (!target) throw notFound("USER_NOT_FOUND");
        const ended = await sessions.revokeAllForUser(target.id, {
          reason: "admin_ended",
          tx,
          actorUserId: principal.userId,
          ...(target.id === principal.userId ? { exceptSessionId: principal.sessionId } : {}),
        });
        await deps.audit.record(
          { category: "security", eventName: "auth.session.revoked_all", action: "revoke", outcome: "completed", reasonCode, resource: { type: "user", publicId: userPublicId }, safeCounts: { sessions_revoked: ended } },
          tx,
        );
        return { ended };
      });
    },

    /** Port (packages E, C). Customers only; the actor's own session is never a customer session of theirs. */
    async endAllCustomers(principal: SessionPrincipal, input: { reasonCode: string }): Promise<{ ended: number }> {
      if (!/^[A-Z][A-Z0-9_]{2,39}$/.test(input.reasonCode)) throw validation("REASON_INVALID", "Choose a reason.", { field: "reasonCode" });
      require(principal, "sessions.revoke_any");
      return deps.db.transaction(async (tx) => {
        await authorizeInTx(tx, principal, "sessions.revoke_any");
        const ended = await sessions.revokeAllCustomers("admin_ended_all_customers", tx, principal.userId);
        await deps.audit.record(
          { category: "security", eventName: "auth.session.ended_all_customers", action: "revoke", outcome: "completed", severity: "WARN", reasonCode: input.reasonCode, resource: { type: "session" }, safeCounts: { sessions_revoked: ended } },
          tx,
        );
        return { ended };
      });
    },

    /* ------------------------------------------------------------ sign-in log */

    async listSignInLog(principal: SessionPrincipal, filter: SignInLogFilter) {
      require(principal, "sessions.read_all", ["staff", "admin"]);
      const limit = Math.min(Math.max(filter.limit ?? 50, 1), MAX_LIMIT);
      const after = decodeCursor(filter.cursor);
      const userId = await userIdOf(filter.userId);
      const conditions = signInConditions(filter, userId);
      if (after !== null) conditions.push(lt(signInEvents.id, after));
      const rows = await deps.db.select().from(signInEvents).where(and(...conditions)).orderBy(desc(signInEvents.id)).limit(limit + 1);
      const page = rows.slice(0, limit);
      return { items: await signInItems(page), nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!.id) : null };
    },

    async exportSignInLog(principal: SessionPrincipal, filter: SignInLogFilter): Promise<{ csv: string; rows: number; truncated: boolean }> {
      require(principal, "sessions.read_all");
      // Bulk export of personal data (addresses): fresh step-up, as for other privileged admin actions.
      requireFreshStepUp(principal.stepUpAt ?? null);
      const userId = await userIdOf(filter.userId);
      const rows = await deps.db.select().from(signInEvents).where(and(...signInConditions(filter, userId))).orderBy(desc(signInEvents.id)).limit(EXPORT_MAX + 1);
      const items = await signInItems(rows.slice(0, EXPORT_MAX));
      const header = ["occurred_at", "kind", "reason", "user_id", "user_name", "role", "method", "session_id", "ip", "country", "device", "ended_by"];
      const lines = items.map((r) =>
        [r.occurredAt, r.kind, r.reasonCode, r.user?.publicId, r.user?.name, r.user?.role, r.authMethod, r.sessionId, r.ipAddress, r.country, r.deviceSummary, r.actor?.publicId].map(csvCell).join(","),
      );
      // Export of personal data is durably audited (filters only; never the rows).
      await deps.audit.record({
        category: "security", eventName: "identity.sign_in_log.exported", action: "export", outcome: "completed",
        resource: { type: "sign_in_log" }, safeCounts: { rows: items.length },
        attributes: { kind: filter.kind ?? "any", has_user_filter: filter.userId ? "yes" : "no", has_ip_filter: filter.ip ? "yes" : "no" },
      });
      return { csv: [header.join(","), ...lines].join("\r\n"), rows: items.length, truncated: rows.length > EXPORT_MAX };
    },

    async pruneSignInLog(): Promise<number> {
      const cutoff = new Date(deps.clock.now().getTime() - SIGN_IN_LOG_RETENTION_DAYS * 86_400_000);
      let removed = 0;
      for (let round = 0; round < 50; round += 1) {
        const [result] = (await deps.db.delete(signInEvents).where(lt(signInEvents.occurredAt, cutoff)).limit(1000)) as unknown as [{ affectedRows?: number }];
        const n = result?.affectedRows ?? 0;
        removed += n;
        if (n < 1000) break;
      }
      return removed;
    },

    /* ------------------------------------------------------------ restrictions */

    async getRestrictions(principal: SessionPrincipal) {
      require(principal, "sessions.policy.manage");
      return restrictionsView(await policy.load(deps.db), principal);
    },

    async updateRestrictions(principal: SessionPrincipal, input: RestrictionsInput) {
      require(principal, "sessions.policy.manage");
      const { cidrs, countries } = validateRestrictions(input);
      const facts = policy.requestFacts();
      const result = await deps.db.transaction(async (tx) => {
        await authorizeInTx(tx, principal, "sessions.policy.manage");
        const current = await sessions.assertCurrent(principal, tx);
        requireFreshStepUp(current.stepUpAt);
        const existing = await policy.load(tx, { forUpdate: true });
        if (existing.version !== input.expectedVersion) {
          throw new DomainError("CONFLICT", "STALE_VERSION", "The restrictions were changed by someone else. Reload and try again.");
        }
        const candidate: Restrictions = {
          ...existing,
          enabled: input.enabled,
          maxConcurrentPerUser: input.maxConcurrentPerUser,
          idleMinutes: input.idleMinutes,
          absoluteHours: input.absoluteHours,
          consoleIpAllowList: cidrs,
          countryMode: input.countryMode,
          countryScope: input.countryScope,
          countries,
          allowUnknownCountry: input.allowUnknownCountry,
        };
        // Never let an administrator lock themselves out: the acting session must still be admitted.
        const selfRefusal = admission(candidate, principal.role, facts.ip, facts.country);
        if (selfRefusal) {
          throw new DomainError("CONFLICT", "WOULD_LOCK_OUT", selfRefusal === "RESTRICTION_IP"
            ? "These settings would block your current address. Add your network to the console allow-list first."
            : "These settings would block your current country. Adjust the country rule first.", { restriction: selfRefusal });
        }
        const values = {
          enabled: candidate.enabled,
          maxConcurrentPerUser: candidate.maxConcurrentPerUser,
          idleMinutesCustomer: candidate.idleMinutes.customer,
          idleMinutesStaff: candidate.idleMinutes.staff,
          idleMinutesAdmin: candidate.idleMinutes.admin,
          absoluteHoursCustomer: candidate.absoluteHours.customer,
          absoluteHoursStaff: candidate.absoluteHours.staff,
          absoluteHoursAdmin: candidate.absoluteHours.admin,
          consoleIpAllowList: JSON.stringify(cidrs),
          countryMode: candidate.countryMode,
          countryScope: candidate.countryScope,
          countries: countries.join(","),
          allowUnknownCountry: candidate.allowUnknownCountry,
          version: existing.version + 1,
          updatedBy: principal.userId,
          updatedAt: deps.clock.now(),
        };
        const [present] = await tx.select({ id: sessionRestrictions.id }).from(sessionRestrictions).where(eq(sessionRestrictions.id, 1)).limit(1);
        if (present) await tx.update(sessionRestrictions).set(values).where(and(eq(sessionRestrictions.id, 1), eq(sessionRestrictions.version, existing.version)));
        else await tx.insert(sessionRestrictions).values({ id: 1, ...values });
        await deps.audit.record(
          {
            category: "security",
            eventName: existing.enabled !== candidate.enabled ? (candidate.enabled ? "identity.session_restrictions.enabled" : "identity.session_restrictions.disabled") : "identity.session_restrictions.updated",
            action: "update", outcome: "completed", severity: candidate.enabled ? "WARN" : "INFO",
            resource: { type: "session_restrictions" },
            attributes: {
              enabled: candidate.enabled ? "yes" : "no",
              max_concurrent: candidate.maxConcurrentPerUser ?? "none",
              console_networks: cidrs.length,
              country_mode: candidate.countryMode,
              country_scope: candidate.countryScope,
              countries: countries.length,
              allow_unknown_country: candidate.allowUnknownCountry ? "yes" : "no",
              version: existing.version + 1,
            },
          },
          tx,
        );
        return { ...candidate, version: existing.version + 1, updatedAt: values.updatedAt };
      });
      policy.invalidate();
      return restrictionsView(result, principal);
    },

  };
}
export type SessionCentre = ReturnType<typeof createSessionCentre>;
