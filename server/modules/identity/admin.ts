/**
 * Customer + staff administration, customer search, portable-import hooks.
 * Every method re-checks the capability server-side (defence in depth behind the router guards) and every
 * mutation is audited inside its transaction (audit failure ⇒ no write).
 */
import { and, asc, desc, eq, gt, gte, inArray, like, lt, or, type SQL } from "drizzle-orm";
import { conflict, DomainError, forbidden, notFound, validation } from "../../core/errors.js";
import type { DbOrTx, SessionPrincipal, Tx } from "../../core/types.js";
import { roleHasCapability, STEP_UP_CAPABILITIES, type Capability } from "../../../shared/capabilities.js";
import { STEP_UP_MAX_AGE_MS } from "../../trpc/trpc.js";
import type { UserRole } from "../../../shared/domain.js";
import type { AuthInternals, AuthService } from "./auth.js";
import { namePrefixes, normalizeEmail, normalizeName } from "./normalize.js";
import type { ApiCaller, ApiListQuery, ApiPage, CustomerDto } from "../publicApi/ports.js";
import { customerRefHistory, USER_STATUSES, users, type UserRow, type UserStatus } from "./schema.js";
import { RESEND_MIN_INTERVAL_MS } from "./settings.js";
import { emailIndexOf, nameAad, nameColumns, namePrefixIndex, toView } from "./users.js";

export interface CustomerListItem {
  publicId: string;
  customerRef: string | null;
  name: string;
  email: string;
  status: UserStatus;
  role: UserRole;
  emailVerified: boolean;
  createdAt: Date;
  /** Optimistic-concurrency version (pass as expectedVersion to role/reference changes). */
  version: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const MAX_LIMIT = 100;

export function encodeCursor(id: number): string {
  return Buffer.from(`c1:${id}`, "utf8").toString("base64url");
}
export function decodeCursor(cursor: string | undefined | null): number | null {
  if (!cursor) return null;
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(cursor)) throw validation("INVALID_CURSOR", "The list position is not valid. Reload the list.");
  const match = /^c1:(\d{1,15})$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!match) throw validation("INVALID_CURSOR", "The list position is not valid. Reload the list.");
  return Number(match[1]);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function createAdminService(i: AuthInternals, auth: AuthService) {
  const { deps, repo, tokens, sessions } = i;
  const preview = (path: string) => (deps.config.deploymentProfile === "preview" ? { previewLink: path } : {});

  async function require(principal: SessionPrincipal, capability: Capability, path: string): Promise<void> {
    if (principal.state !== "full" || !roleHasCapability(principal.role, capability)) {
      try {
        await deps.audit.record({
          category: "security",
          eventName: "authz.access.denied",
          action: "authorize",
          outcome: "denied",
          severity: "WARN",
          reasonCode: "CAPABILITY_NOT_GRANTED",
          resource: { type: "procedure" },
          attributes: { procedure: path },
        });
      } catch {
        /* refusal stands regardless */
      }
      throw forbidden("CAPABILITY_NOT_GRANTED");
    }
  }

  function listItem(row: UserRow): CustomerListItem {
    const view = toView(deps.crypto, row);
    return {
      publicId: view.publicId,
      customerRef: view.customerRef,
      name: view.name,
      email: view.email,
      status: view.status,
      role: view.role,
      emailVerified: view.emailVerified,
      createdAt: view.createdAt,
      version: row.version,
    };
  }

  /** Search conditions (documented strategy): exact e-mail via blind index; reference prefix; name-token prefix. */
  function searchCondition(query: string): { where: SQL | undefined; nameFilter?: (name: string) => boolean } {
    const q = query.normalize("NFC").trim();
    if (q.includes("@")) return { where: eq(users.emailIndex, emailIndexOf(deps.crypto, normalizeEmail(q))) };
    const conditions: SQL[] = [];
    const upper = q.toUpperCase();
    if (/^[A-Z0-9-]{1,32}$/.test(upper)) conditions.push(like(users.customerRef, `${escapeLike(upper)}%`));
    const lowered = normalizeName(q).toLowerCase();
    const prefix = namePrefixes(lowered).first;
    let nameFilter: ((name: string) => boolean) | undefined;
    if (prefix) {
      const idx = namePrefixIndex(deps.crypto, prefix);
      conditions.push(eq(users.nameFirstPrefixIndex, idx), eq(users.nameLastPrefixIndex, idx));
      const needle = lowered.split(" ")[0] ?? lowered;
      nameFilter = (name) => normalizeName(name).toLowerCase().split(" ").some((token) => token.startsWith(needle));
    }
    if (conditions.length === 0) return { where: eq(users.id, -1) };
    return { where: or(...conditions), ...(nameFilter ? { nameFilter } : {}) };
  }

  async function listUsers(
    roles: readonly UserRole[],
    input: { query?: string; status?: UserStatus; cursor?: string; limit?: number },
  ): Promise<Page<CustomerListItem>> {
    const limit = Math.min(Math.max(input.limit ?? 25, 1), MAX_LIMIT);
    const after = decodeCursor(input.cursor);
    const conditions: (SQL | undefined)[] = [inArray(users.role, [...roles])];
    if (input.status) conditions.push(eq(users.status, input.status));
    if (after !== null) conditions.push(lt(users.id, after));
    let nameFilter: ((name: string) => boolean) | undefined;
    if (input.query && input.query.trim().length > 0) {
      const search = searchCondition(input.query);
      conditions.push(search.where);
      nameFilter = search.nameFilter;
    }
    const rows = await deps.db
      .select()
      .from(users)
      .where(and(...conditions))
      .orderBy(desc(users.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const upper = input.query?.trim().toUpperCase() ?? "";
    const items = page
      .map(listItem)
      .filter((item) => !nameFilter || nameFilter(item.name) || (item.customerRef ?? "").startsWith(upper));
    return { items, nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!.id) : null };
  }

  /**
   * In-transaction authorization for every admin mutation (review ID-05). Locks the actor's and the target's
   * users rows in canonical id order (deterministic ⇒ two admins acting on each other serialize instead of
   * both passing their checks), then re-validates the actor from PERSISTED state under those locks: session
   * live and not rotated, role unchanged and still granting `capability`, no pending account steps, and —
   * for step-up capabilities — a fresh persisted step-up. Only then may the caller apply effects.
   */
  async function authorizeInTx(tx: Tx, principal: SessionPrincipal, capability: Capability, targetPublicId?: string): Promise<UserRow | null> {
    let targetId: number | null = null;
    if (targetPublicId !== undefined) {
      const [peek] = await tx.select({ id: users.id }).from(users).where(eq(users.publicId, targetPublicId)).limit(1);
      if (!peek) throw notFound("USER_NOT_FOUND");
      targetId = peek.id;
    }
    const ids = [...new Set([principal.userId, ...(targetId !== null ? [targetId] : [])])].sort((a, b) => a - b);
    const locked = await tx.select().from(users).where(inArray(users.id, ids)).orderBy(asc(users.id)).for("update");
    const current = await sessions.assertCurrent(principal, tx);
    const now = deps.clock.now().getTime();
    const stepUpAge = current.stepUpAt ? now - current.stepUpAt.getTime() : -1;
    const reason =
      current.pendingSteps.length > 0
        ? "ACCOUNT_STEPS_PENDING"
        : !roleHasCapability(current.role, capability)
          ? "CAPABILITY_NOT_GRANTED"
          : STEP_UP_CAPABILITIES.has(capability) && !(stepUpAge >= 0 && stepUpAge <= STEP_UP_MAX_AGE_MS)
            ? "STEP_UP_REQUIRED"
            : null;
    if (reason) {
      if (reason === "STEP_UP_REQUIRED") throw new DomainError("FORBIDDEN", "STEP_UP_REQUIRED", "Confirm your identity again to continue.");
      throw forbidden(reason);
    }
    if (targetId === null) return null;
    const target = locked.find((row) => row.id === targetId);
    if (!target) throw notFound("USER_NOT_FOUND"); // deleted between peek and lock
    return target;
  }

  async function loadTarget(tx: Tx, principal: SessionPrincipal, capability: Capability, publicId: string, roles: readonly UserRole[]): Promise<UserRow> {
    const row = await authorizeInTx(tx, principal, capability, publicId);
    if (!row || !roles.includes(row.role)) throw notFound("USER_NOT_FOUND");
    return row;
  }

  async function sendInvitation(tx: Tx, row: UserRow): Promise<{ previewLink?: string }> {
    const view = toView(deps.crypto, row);
    const link = await tokens.issue(tx, row.id, "invitation");
    await deps.mailer.enqueue(
      { template: "auth.invitation", to: { userId: row.id }, vars: { name: view.name, link: link.url }, idempotencyKey: link.mailKey, expiresAt: link.expiresAt },
      tx,
    );
    return preview(link.path);
  }

  async function setStatus(
    principal: SessionPrincipal,
    publicId: string,
    status: "active" | "suspended" | "deactivated",
    reasonCode: string,
    roles: readonly UserRole[],
    eventName: string,
    capability: Capability,
  ): Promise<{ status: UserStatus }> {
    return deps.db.transaction(async (tx) => {
      // Break-glass policy lock before any users lock (assurance contract, decision 3).
      if (roles.includes("admin")) await deps.services.assurance.lockLocalAdministratorPolicy(tx);
      const row = await loadTarget(tx, principal, capability, publicId, roles);
      if (row.id === principal.userId) throw conflict("SELF_STATUS_CHANGE", "You cannot change the status of your own account.");
      const next: UserStatus = status === "active" ? (row.passwordHash || row.status === "active" ? "active" : "pending_activation") : status;
      if (row.status === next) return { status: next };
      if (row.role === "admin" && row.status === "active" && next !== "active") {
        if ((await repo.countActiveAdmins(tx, row.id)) < 1) throw conflict("LAST_ADMIN", "At least one active administrator must remain.");
        await deps.services.assurance.assertLocalAdministratorMayLoseAccess(tx, row.id);
      }
      const now = deps.clock.now();
      await tx.update(users).set({ status: next, statusReasonCode: reasonCode, statusChangedAt: now, version: row.version + 1 }).where(eq(users.id, row.id));
      const revoked = next === "active" ? 0 : await sessions.revokeAllForUser(row.id, { reason: `status_${next}`, tx });
      if (next !== "active") await tokens.retireAll(tx, row.id, ["password_reset", "admin_set_password", "verify_email", "invitation"], "account_inactive");
      await deps.audit.record(
        {
          category: "admin",
          eventName,
          action: "transition",
          outcome: "completed",
          reasonCode,
          resource: { type: "user", publicId: row.publicId },
          safeCounts: { sessions_revoked: revoked },
          attributes: { from_status: row.status, to_status: next },
        },
        tx,
      );
      return { status: next };
    });
  }

  /* ---------------------------------------------------------------- public API v1 provider (package H port) */

  function customerDto(row: UserRow): CustomerDto {
    const view = toView(deps.crypto, row);
    return {
      id: view.publicId,
      customerRef: view.customerRef,
      displayName: view.name,
      email: view.email,
      status: view.status,
      createdAt: row.createdAt.toISOString(),
      updatedAt: (row.updatedAt ?? row.createdAt).toISOString(),
    };
  }

  /** API-key PII reads are durably audited as system (fail closed: no audit row ⇒ no data). */
  async function auditApiRead(caller: ApiCaller, eventName: string, results: number) {
    await deps.audit.record({
      category: "admin", eventName, action: "read", outcome: "completed",
      actor: { role: "system" }, correlationId: caller.requestId,
      attributes: { api_key: caller.keyPublicId, replay: caller.replay ? "yes" : "no" },
      safeCounts: { results },
    });
  }

  const apiCustomers = {
    /** Customers only (never staff/admin). Filters: `status`, `search` (exact e-mail, reference or name prefix). */
    async list(query: ApiListQuery, caller: ApiCaller): Promise<ApiPage<CustomerDto>> {
      const limit = Math.min(Math.max(query.limit, 1), MAX_LIMIT);
      const after = decodeCursor(query.cursor);
      const conditions: (SQL | undefined)[] = [eq(users.role, "customer")];
      const status = query.filter.status;
      if (status !== undefined) {
        if (!(USER_STATUSES as readonly string[]).includes(status)) throw validation("FILTER_INVALID", "Unknown status filter.", { field: "status" });
        conditions.push(eq(users.status, status as UserStatus));
      }
      if (query.updatedSince) conditions.push(gte(users.updatedAt, query.updatedSince));
      if (after !== null) conditions.push(lt(users.id, after));
      let nameFilter: ((name: string) => boolean) | undefined;
      const search = query.filter.search?.slice(0, 100);
      if (search && search.trim()) {
        const found = searchCondition(search);
        conditions.push(found.where);
        nameFilter = found.nameFilter;
      }
      const rows = await deps.db.select().from(users).where(and(...conditions)).orderBy(desc(users.id)).limit(limit + 1);
      const page = rows.slice(0, limit);
      const upper = search?.trim().toUpperCase() ?? "";
      const items = page.map(customerDto).filter((item) => !nameFilter || nameFilter(item.displayName) || (item.customerRef ?? "").startsWith(upper));
      await auditApiRead(caller, "api.customer.listed", items.length);
      return { items, nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!.id) : null };
    },
    async get(publicId: string, caller: ApiCaller): Promise<CustomerDto | null> {
      const [row] = await deps.db.select().from(users).where(and(eq(users.publicId, publicId), eq(users.role, "customer"))).limit(1);
      await auditApiRead(caller, "api.customer.read", row ? 1 : 0);
      return row ? customerDto(row) : null;
    },
  };

  return {
    apiCustomers,
    /**
     * Internal (read views such as the acceptance log): ids of customers matching `query` with the same
     * matching as the customer search (exact e-mail, reference prefix, name-token prefix). No capability check
     * or audit here — the calling view authorizes and audits. At most `limit` (≤500) ids, newest first.
     */
    async findCustomerIds(query: string, opts: { status?: UserStatus; limit?: number; tx?: DbOrTx } = {}): Promise<number[]> {
      const limit = Math.min(Math.max(opts.limit ?? 500, 1), 500);
      if (!query.trim()) return [];
      const search = searchCondition(query.slice(0, 100));
      const conditions: (SQL | undefined)[] = [eq(users.role, "customer"), search.where, opts.status ? eq(users.status, opts.status) : undefined];
      const rows = await (opts.tx ?? deps.db)
        .select({ id: users.id, publicId: users.publicId, nameEnc: users.nameEnc, customerRef: users.customerRef })
        .from(users)
        .where(and(...conditions))
        .orderBy(desc(users.id))
        .limit(limit);
      const upper = query.trim().toUpperCase();
      const nameFilter = search.nameFilter;
      return rows
        .filter((r) => !nameFilter || (r.customerRef ?? "").startsWith(upper) || nameFilter(deps.crypto.decrypt(r.nameEnc, nameAad(r.publicId))))
        .map((r) => r.id);
    },
    /** Internal (SSO service): the same in-tx actor guard as every admin mutation. Not on tRPC. */
    authorizeInTx: authorizeInTx as (tx: Tx, principal: SessionPrincipal, capability: Capability, targetPublicId?: string) => Promise<UserRow | null>,
    async searchCustomers(principal: SessionPrincipal, input: { query?: string; status?: UserStatus; cursor?: string; limit?: number }) {
      await require(principal, "customers.read_all", "identity.searchCustomers");
      const page = await listUsers(["customer"], input);
      // Admin PII reads are durable and fail closed: no audit row ⇒ no data returned.
      await deps.audit.record({
        category: "admin",
        eventName: "admin.customer.searched",
        action: "search",
        outcome: "completed",
        safeCounts: { results: page.items.length },
      });
      return page;
    },

    async getCustomer(principal: SessionPrincipal, publicId: string) {
      await require(principal, "customers.read_all", "identity.admin.customers.get");
      const row = await repo.byPublicId(publicId);
      if (!row || row.role !== "customer") throw notFound("USER_NOT_FOUND");
      const history = await deps.db
        .select()
        .from(customerRefHistory)
        .where(eq(customerRefHistory.userId, row.id))
        .orderBy(desc(customerRefHistory.changedAt))
        .limit(50);
      const view = toView(deps.crypto, row);
      const activeSessions = await sessions.countLive(row.id);
      await deps.audit.record({ category: "admin", eventName: "admin.customer.viewed", action: "read", outcome: "completed", resource: { type: "user", publicId } });
      return {
        customer: { ...listItem(row), mustChangePassword: view.mustChangePassword, hasPassword: view.hasPassword, version: row.version, statusReasonCode: row.statusReasonCode, statusChangedAt: row.statusChangedAt },
        activeSessions,
        referenceHistory: history.map((h) => ({ previousReference: h.previousReference, newReference: h.newReference, reasonCode: h.reasonCode, changedAt: h.changedAt })),
      };
    },

    async createCustomer(principal: SessionPrincipal, input: { email: string; name: string; customerRef?: string }) {
      await require(principal, "customers.manage", "identity.admin.customers.create");
      return deps.db.transaction(async (tx) => {
        await authorizeInTx(tx, principal, "customers.manage");
        const created = await auth.insertUser(tx, {
          email: input.email,
          name: input.name,
          role: "customer",
          status: "pending_activation",
          origin: "admin",
          customerRef: input.customerRef ?? null,
        });
        const row = (await repo.byId(created.id, { tx, forUpdate: true }))!;
        await tx.insert(customerRefHistory).values({ userId: created.id, previousReference: null, newReference: created.customerRef!, changedByUserId: principal.userId, reasonCode: "CREATED", changedAt: deps.clock.now() });
        const invitation = await sendInvitation(tx, row);
        await deps.audit.record(
          { category: "admin", eventName: "admin.customer.created", action: "create", outcome: "completed", resource: { type: "user", publicId: created.publicId } },
          tx,
        );
        return { customerId: created.publicId, customerRef: created.customerRef, ...invitation };
      });
    },

    async resendInvitation(principal: SessionPrincipal, publicId: string, roles: readonly UserRole[] = ["customer"]) {
      const capability: Capability = roles.includes("customer") ? "customers.manage" : "staff.manage";
      await require(principal, capability, "identity.admin.resendInvitation");
      return deps.db.transaction(async (tx) => {
        const row = await loadTarget(tx, principal, capability, publicId, roles);
        if (row.status !== "pending_activation") throw conflict("NOT_PENDING_ACTIVATION", "This account is already activated.");
        const last = await tokens.lastIssuedAt(tx, row.id, "invitation");
        if (last && deps.clock.now().getTime() - last.getTime() < RESEND_MIN_INTERVAL_MS) {
          throw new DomainError("RATE_LIMITED", "RESEND_TOO_SOON", "An invitation was sent moments ago. Please wait a minute before resending.", { retryAfterSeconds: 60 });
        }
        const invitation = await sendInvitation(tx, row);
        await deps.audit.record(
          { category: "admin", eventName: "admin.user.invitation_sent", action: "notify", outcome: "completed", resource: { type: "user", publicId } },
          tx,
        );
        return invitation;
      });
    },

    async setCustomerStatus(principal: SessionPrincipal, publicId: string, status: "active" | "suspended" | "deactivated", reasonCode: string) {
      await require(principal, "customers.manage", "identity.admin.customers.setStatus");
      return setStatus(principal, publicId, status, reasonCode, ["customer"], "admin.customer.status_changed", "customers.manage");
    },

    async setStaffStatus(principal: SessionPrincipal, publicId: string, status: "active" | "suspended" | "deactivated", reasonCode: string) {
      await require(principal, "staff.manage", "identity.admin.staff.setStatus");
      return setStatus(principal, publicId, status, reasonCode, ["staff", "admin"], "admin.staff.status_changed", "staff.manage");
    },

    async changeReference(principal: SessionPrincipal, publicId: string, newReference: string, expectedVersion: number, reasonCode: string) {
      await require(principal, "customers.reference.change", "identity.admin.customers.changeReference");
      return deps.db.transaction(async (tx) => {
        const row = await loadTarget(tx, principal, "customers.reference.change", publicId, ["customer"]);
        if (row.version !== expectedVersion) throw conflict("STALE_VERSION", "This customer was changed by someone else. Reload and try again.");
        if (row.customerRef === newReference) throw validation("REFERENCE_UNCHANGED", "The new reference is the same as the current one.");
        await repo.reserveRef(tx, newReference, row.id); // permanent reservation; fails for any current or retired value
        const now = deps.clock.now();
        if (row.customerRef) await repo.retireRef(tx, row.customerRef, now);
        await tx.update(users).set({ customerRef: newReference, version: row.version + 1 }).where(eq(users.id, row.id));
        await tx.insert(customerRefHistory).values({ userId: row.id, previousReference: row.customerRef, newReference, changedByUserId: principal.userId, reasonCode, changedAt: now });
        await deps.audit.record(
          { category: "admin", eventName: "admin.customer.reference_changed", action: "update", outcome: "completed", reasonCode, resource: { type: "user", publicId } },
          tx,
        );
        return { customerRef: newReference, version: row.version + 1 };
      });
    },

    async revokeUserSessions(principal: SessionPrincipal, publicId: string) {
      await require(principal, "sessions.revoke_any", "identity.admin.users.revokeSessions");
      return deps.db.transaction(async (tx) => {
        const row = await loadTarget(tx, principal, "sessions.revoke_any", publicId, ["customer", "staff", "admin"]);
        const revoked = await sessions.revokeAllForUser(row.id, {
          reason: "admin_revoked",
          tx,
          ...(row.id === principal.userId ? { exceptSessionId: principal.sessionId } : {}),
        });
        await deps.audit.record(
          { category: "security", eventName: "auth.session.revoked_all", action: "revoke", outcome: "completed", reasonCode: "ADMIN_REVOKED", resource: { type: "user", publicId }, safeCounts: { sessions_revoked: revoked } },
          tx,
        );
        return { revoked };
      });
    },

    async listStaff(principal: SessionPrincipal, input: { query?: string; status?: UserStatus; cursor?: string; limit?: number }) {
      await require(principal, "staff.manage", "identity.admin.staff.list");
      return listUsers(["staff", "admin"], input);
    },

    async createStaff(principal: SessionPrincipal, input: { email: string; name: string; role: "staff" | "admin" }) {
      await require(principal, "staff.manage", "identity.admin.staff.create");
      return deps.db.transaction(async (tx) => {
        await authorizeInTx(tx, principal, "staff.manage");
        const created = await auth.insertUser(tx, { email: input.email, name: input.name, role: input.role, status: "pending_activation", origin: "admin" });
        const row = (await repo.byId(created.id, { tx, forUpdate: true }))!;
        const invitation = await sendInvitation(tx, row);
        await deps.audit.record(
          { category: "admin", eventName: "admin.staff.created", action: "create", outcome: "completed", resource: { type: "user", publicId: created.publicId }, attributes: { role: input.role } },
          tx,
        );
        return { userId: created.publicId, ...invitation };
      });
    },

    async changeRole(principal: SessionPrincipal, publicId: string, role: UserRole, expectedVersion: number) {
      await require(principal, "staff.manage", "identity.admin.staff.changeRole");
      return deps.db.transaction(async (tx) => {
        await deps.services.assurance.lockLocalAdministratorPolicy(tx);
        const row = await loadTarget(tx, principal, "staff.manage", publicId, ["customer", "staff", "admin"]);
        if (row.id === principal.userId) throw conflict("SELF_ROLE_CHANGE", "You cannot change your own role.");
        if (row.version !== expectedVersion) throw conflict("STALE_VERSION", "This account was changed by someone else. Reload and try again.");
        if (row.role === role) return { role, version: row.version };
        if (row.role === "admin" && row.status === "active" && (await repo.countActiveAdmins(tx, row.id)) < 1) {
          throw conflict("LAST_ADMIN", "At least one active administrator must remain.");
        }
        if (row.role === "admin") await deps.services.assurance.assertLocalAdministratorMayLoseAccess(tx, row.id);
        let customerRef = row.customerRef;
        if (role === "customer" && !customerRef) customerRef = await auth.claimNewRef(tx, row.id);
        await tx.update(users).set({ role, customerRef, version: row.version + 1 }).where(eq(users.id, row.id));
        // A privilege change invalidates every existing session of the target (re-authentication with MFA).
        const revoked = await sessions.revokeAllForUser(row.id, { reason: "role_changed", tx });
        await deps.audit.record(
          {
            category: "admin",
            eventName: "admin.staff.role_changed",
            action: "update",
            outcome: "completed",
            resource: { type: "user", publicId },
            safeCounts: { sessions_revoked: revoked },
            attributes: { from_role: row.role, to_role: role },
          },
          tx,
        );
        return { role, version: row.version + 1 };
      });
    },

    /* ----------------------------------------------------------- self-service (full session) */

    async updateOwnProfile(principal: SessionPrincipal, input: { name: string }): Promise<void> {
      await deps.db.transaction(async (tx) => {
        const row = await repo.byId(principal.userId, { tx, forUpdate: true });
        if (!row) throw notFound("USER_NOT_FOUND");
        await tx.update(users).set({ ...nameColumns(deps.crypto, row.publicId, input.name), version: row.version + 1 }).where(eq(users.id, row.id));
        await deps.audit.record(
          { category: "business", eventName: "identity.profile.updated", action: "update", outcome: "completed", resource: { type: "user", publicId: row.publicId } },
          tx,
        );
      });
    },

    async revokeOwnSession(principal: SessionPrincipal, sessionId: string): Promise<void> {
      await deps.db.transaction(async (tx) => {
        await sessions.revokeOwn(principal.userId, sessionId, tx);
        await deps.audit.record(
          { category: "security", eventName: "auth.session.revoked", action: "revoke", outcome: "completed", reasonCode: "USER_REVOKED", resource: { type: "session", publicId: sessionId } },
          tx,
        );
      });
    },

    async revokeOtherSessions(principal: SessionPrincipal): Promise<number> {
      return deps.db.transaction(async (tx) => {
        const revoked = await sessions.revokeAllForUser(principal.userId, { exceptSessionId: principal.sessionId, reason: "user_revoked_others", tx });
        await deps.audit.record(
          { category: "security", eventName: "auth.session.revoked_all", action: "revoke", outcome: "completed", reasonCode: "USER_REVOKED_OTHERS", resource: { type: "user", publicId: principal.userPublicId }, safeCounts: { sessions_revoked: revoked } },
          tx,
        );
        return revoked;
      });
    },

    /* ----------------------------------------------------------- portable import/export hooks */

    async createPendingCustomer(
      input: { email: string; name: string; customerRef?: string | null; publicId?: string; createdAt?: Date },
      opts: { tx: Tx },
    ): Promise<{ userId: number; publicId: string; customerRef: string }> {
      const tx = opts.tx;
      const created = await auth.insertUser(tx, {
        email: input.email,
        name: input.name,
        role: "customer", // never staff/admin from an archive
        status: "pending_activation", // never an automatically active account
        origin: "import",
        customerRef: input.customerRef ?? null,
        ...(input.publicId ? { publicId: input.publicId } : {}),
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
        passwordHash: null, // no authentication material is ever imported
      });
      await tx.insert(customerRefHistory).values({ userId: created.id, previousReference: null, newReference: created.customerRef!, changedByUserId: null, reasonCode: "IMPORTED", changedAt: deps.clock.now() });
      await deps.audit.record(
        { category: "portable_transfer", eventName: "identity.customer.imported_pending", action: "import", outcome: "completed", resource: { type: "user", publicId: created.publicId } },
        tx,
      );
      return { userId: created.id, publicId: created.publicId, customerRef: created.customerRef! };
    },

    async findUserIdByEmail(email: string, opts: { tx?: DbOrTx } = {}) {
      const row = await repo.byEmail(email, opts.tx ? { tx: opts.tx } : {});
      return row ? { userId: row.id, publicId: row.publicId, role: row.role, status: row.status } : null;
    },

    async portableCustomers(tx: DbOrTx, after: string | null, limit: number, publicIds?: readonly string[]) {
      const bounded = Math.min(Math.max(limit, 1), 500);
      const conditions: SQL[] = [eq(users.role, "customer")];
      if (after) conditions.push(gt(users.publicId, after));
      if (publicIds) {
        if (publicIds.length === 0) return [];
        conditions.push(inArray(users.publicId, [...publicIds].slice(0, 500)));
      }
      const rows = await tx.select().from(users).where(and(...conditions)).orderBy(asc(users.publicId)).limit(bounded);
      return rows.map((row) => {
        const view = toView(deps.crypto, row);
        return { publicId: view.publicId, email: view.email, name: view.name, customerRef: view.customerRef, createdAt: view.createdAt };
      });
    },
  };
}
export type AdminService = ReturnType<typeof createAdminService>;
