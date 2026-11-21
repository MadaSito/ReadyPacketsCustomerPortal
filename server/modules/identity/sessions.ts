/**
 * Server-side sessions + the authoritative SessionResolver.
 *
 *  - bearer token: 256-bit random, stored only as FieldCrypto.hashToken(token)
 *  - per-session CSRF secret, encrypted at rest; browser token = deriveSessionCsrfToken(sessionId, secret)
 *  - idle + absolute expiry read from settings on EVERY resolve (policy changes affect existing sessions)
 *  - rotation (new token + new CSRF secret, same session id) on login, MFA verified, step-up, password change,
 *    e-mail verification
 *  - every resolve re-checks revocation, expiry, account status and re-derives pendingSteps
 */
import { and, asc, desc, eq, gt, inArray, isNull, ne, notInArray, or, type SQL } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import { DomainError, notFound } from "../../core/errors.js";
import { randomToken, ulid } from "../../core/ids.js";
import { getRequestContext } from "../../core/requestContext.js";
import type { DbOrTx, SessionCredentials, SessionPrincipal, SessionResolver, Tx } from "../../core/types.js";
import { deriveSessionCsrfToken } from "../../security/csrf.js";
import type { AuthMethod, TransitionStep, UserRole } from "../../../shared/domain.js";
import { readSetting } from "../platform/settingsRegistry.js";
import { deviceSummary } from "./normalize.js";
import { userSessions, users, type UserRow, type UserSessionRow, type UserStatus } from "./schema.js";
import { SESSION_ABSOLUTE_HOURS, SESSION_IDLE_MINUTES } from "./settings.js";
import type { TransitionService } from "./transitions.js";
import { admission, type RequestFacts, type Restrictions, type SessionPolicy, type SignInLog } from "./sessionPolicy.js";
import type { SignInEventKind } from "./schema.js";

export interface IssuedSession {
  token: string;
  csrfToken: string;
  absoluteExpiresAt: Date;
}

export interface SessionState {
  sessionId: string;
  userId: number;
  userPublicId: string;
  role: UserRole;
  userStatus: UserStatus;
  live: boolean;
  revokedAt: Date | null;
  mfaVerifiedAt: Date | null;
  stepUpAt: Date | null;
  absoluteExpiresAt: Date;
  authMethod: AuthMethod;
}

export interface SessionListItem {
  sessionId: string;
  current: boolean;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  deviceSummary: string | null;
  authMethod: AuthMethod;
  country: string | null;
  /** The address the session signed in from (own sessions only; decrypted server-side). */
  ipAddress: string | null;
}

/** Revocation reason → sign-in log kind. */
export function signInKindForReason(reason: string): SignInEventKind {
  if (reason === "logout" || reason === "user_revoked" || reason === "user_revoked_others") return "sign_out";
  if (reason === "idle_timeout" || reason === "absolute_timeout") return "expiry";
  return "forced_end";
}

/** Refusal of a new session by the restrictions (raised inside the login transaction; logged after rollback). */
export const sessionRestricted = (reasonCode: "RESTRICTION_IP" | "RESTRICTION_COUNTRY") =>
  new DomainError("FORBIDDEN", "SESSION_RESTRICTED", "Sign-in is not allowed from your current network or location. Contact your administrator.", {
    restriction: reasonCode,
  });

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const LAST_SEEN_WRITE_INTERVAL_MS = 60 * 1000;
const END_BATCH = 1000;
/**
 * device_summary marker of a service-internal ops session (openOpsSession). deviceSummary() only ever yields
 * "<Browser> on <OS>", so no user agent can produce it; the resolver also refuses such rows outright.
 */
export const OPS_SESSION_MARKER = "ops:demo_seed";
const OPS_SESSION_TTL_MS = 10 * 60 * 1000;
/** Steps an ops session for a not-yet-enrolled demo_seed account may skip (the human enrols at first sign-in). */
const OPS_WAIVABLE_STEPS: ReadonlySet<TransitionStep> = new Set(["enroll_mfa", "acknowledge_recovery_codes", "change_password"]);
const csrfAad = (publicId: string) => `user_sessions.csrf:${publicId}`;
const ipAad = (publicId: string) => `user_sessions.ip:${publicId}`;

export const sessionNotCurrent = () =>
  new DomainError("UNAUTHENTICATED", "SESSION_NOT_CURRENT", "Your session has ended. Please sign in again.");

export function createSessionService(deps: ModuleDeps, transitions: TransitionService, centre: { policy: SessionPolicy; log: SignInLog }) {
  const db = (tx?: DbOrTx) => tx ?? deps.db;

  /*
   * Session policy (idle/absolute), read on every use so policy changes affect existing sessions. Inside a
   * transaction the read goes through THAT transaction's connection (readSetting(..., tx)) — never through the
   * settings pool while a connection is held (one-connection pools would deadlock — review ID-06).
   */
  async function policy(tx?: DbOrTx, role?: UserRole, loaded?: Restrictions) {
    const t = tx as Tx | undefined;
    const [idleMinutes, absoluteHours, restrictions] = await Promise.all([
      readSetting(deps.settings, SESSION_IDLE_MINUTES, t),
      readSetting(deps.settings, SESSION_ABSOLUTE_HOURS, t),
      loaded ?? (role ? centre.policy.load(tx) : null),
    ]);
    // Increment 04: per-role lifetimes replace the global settings for that role while restrictions are on.
    const perRole = role && restrictions?.enabled && !centre.policy.breakGlass() ? restrictions : null;
    const idle = (perRole && role ? perRole.idleMinutes[role] : null) ?? idleMinutes;
    const absolute = (perRole && role ? perRole.absoluteHours[role] : null) ?? absoluteHours;
    return { idleMs: idle * 60_000, absoluteMs: absolute * 3_600_000 };
  }

  /** Sign-in log row for every session ended by revoke()/revokeAllForUser()/resolver expiry. */
  function endEvents(rows: { publicId: string; userId: number; role: UserRole; authMethod: AuthMethod; deviceSummary: string | null }[], reason: string) {
    const actor = getRequestContext()?.actor;
    const kind = signInKindForReason(reason);
    // Rows describe OTHER sessions: never stamp them with the caller's address/country.
    const facts: RequestFacts | undefined = kind === "forced_end" || kind === "expiry" ? { ip: null, country: null } : undefined;
    return rows.map((row) => ({
      kind,
      reasonCode: reason.toUpperCase().slice(0, 40),
      userId: row.userId,
      role: row.role,
      authMethod: row.authMethod,
      sessionPublicId: row.publicId,
      deviceSummary: row.deviceSummary === OPS_SESSION_MARKER ? null : row.deviceSummary,
      actorUserId: kind === "forced_end" && actor && actor.userId !== row.userId ? actor.userId : null,
      ...(facts ? { facts } : {}),
    }));
  }

  type EndRow = { id: number; publicId: string; userId: number; role: UserRole; authMethod: AuthMethod; deviceSummary: string | null };

  /**
   * Ends every unrevoked session matching `condition`, in id-ordered batches until none remain (no silent
   * cap). Inside a transaction the batch is locked FOR UPDATE first, so every selected row is really ended by
   * this call and logged exactly once; outside a transaction each row is ended by its own compare-and-set
   * update and logged only when that update changed it (idempotent under concurrency).
   */
  async function endWhere(tx: DbOrTx, condition: SQL | undefined, reason: string, inTx: boolean, onRow?: (row: EndRow) => void): Promise<number> {
    let lastId = 0;
    let ended = 0;
    for (;;) {
      // Only user_sessions rows are locked (a role condition is a non-locking subquery on users), so this never
      // takes users locks out of the canonical ascending order.
      const query = tx
        .select({ id: userSessions.id, publicId: userSessions.publicId, userId: userSessions.userId, authMethod: userSessions.authMethod, deviceSummary: userSessions.deviceSummary })
        .from(userSessions)
        .where(and(condition, isNull(userSessions.revokedAt), gt(userSessions.id, lastId)))
        .orderBy(asc(userSessions.id))
        .limit(END_BATCH);
      const locked = inTx ? await query.for("update") : await query;
      if (locked.length === 0) break;
      const owners = await tx.select({ id: users.id, role: users.role }).from(users).where(inArray(users.id, [...new Set(locked.map((r) => r.userId))]));
      const roleOf = new Map(owners.map((o) => [o.id, o.role]));
      const rows: EndRow[] = locked.map((r) => ({ ...r, role: roleOf.get(r.userId) ?? "customer" }));
      lastId = rows[rows.length - 1]!.id;
      const now = deps.clock.now();
      const done: EndRow[] = [];
      if (inTx) {
        await tx.update(userSessions).set({ revokedAt: now, revokeReason: reason.slice(0, 40) }).where(inArray(userSessions.id, rows.map((r) => r.id)));
        done.push(...rows);
      } else {
        for (const row of rows) {
          const [result] = (await tx
            .update(userSessions)
            .set({ revokedAt: now, revokeReason: reason.slice(0, 40) })
            .where(and(eq(userSessions.id, row.id), isNull(userSessions.revokedAt)))) as unknown as [{ affectedRows?: number }];
          if ((result?.affectedRows ?? 0) === 1) done.push(row);
        }
      }
      ended += done.length;
      done.forEach((row) => onRow?.(row));
      const events = endEvents(done, reason);
      if (inTx) await centre.log.recordMany(events, tx as Tx);
      else for (const event of events) await centre.log.note(event);
      if (rows.length < END_BATCH) break;
    }
    return ended;
  }

  /** Live = not revoked, not idle-expired, not absolute-expired (stored OR current policy), user active. */
  function isLive(session: UserSessionRow, user: Pick<UserRow, "status">, now: Date, p: { idleMs: number; absoluteMs: number }): boolean {
    if (session.revokedAt !== null) return false;
    if (user.status !== "active") return false;
    const t = now.getTime();
    if (t >= session.absoluteExpiresAt.getTime()) return false;
    if (t >= session.authenticatedAt.getTime() + p.absoluteMs) return false;
    if (t - session.lastSeenAt.getTime() > p.idleMs) return false;
    return true;
  }

  function issued(publicId: string, token: string, csrfSecret: string, absoluteExpiresAt: Date): IssuedSession {
    return { token, csrfToken: deriveSessionCsrfToken(publicId, csrfSecret), absoluteExpiresAt };
  }

  async function sessionRow(tx: DbOrTx, sessionId: string, forUpdate = false): Promise<UserSessionRow | null> {
    const query = tx.select().from(userSessions).where(eq(userSessions.publicId, sessionId)).limit(1);
    const rows = forUpdate ? await (query as unknown as { for(mode: "update"): Promise<UserSessionRow[]> }).for("update") : await query;
    return rows[0] ?? null;
  }

  async function rotateWith(
    sessionId: string,
    patch: Partial<Pick<UserSessionRow, "mfaVerifiedAt" | "stepUpAt">>,
    tx?: Tx,
  ): Promise<IssuedSession> {
    const run = async (t: Tx) => {
      const row = await sessionRow(t, sessionId, true);
      const now = deps.clock.now();
      if (!row || row.revokedAt !== null || row.absoluteExpiresAt.getTime() <= now.getTime()) throw sessionNotCurrent();
      const token = randomToken(32);
      const csrfSecret = randomToken(32);
      await t
        .update(userSessions)
        .set({
          ...patch,
          tokenHash: deps.crypto.hashToken(token),
          csrfSecretEnc: deps.crypto.encrypt(csrfSecret, csrfAad(row.publicId)),
          rotatedAt: now,
          lastSeenAt: now,
        })
        .where(eq(userSessions.id, row.id));
      return issued(row.publicId, token, csrfSecret, row.absoluteExpiresAt);
    };
    return tx ? run(tx) : deps.db.transaction(run);
  }

  /** Ops sessions exist only outside production, and only for accounts provisioned by the demo seeder. */
  function opsSessionAllowed(user: Pick<UserRow, "origin" | "status">): boolean {
    return deps.config.deploymentProfile !== "production" && user.origin === "demo_seed" && user.status === "active";
  }

  const service = {
    policy,

    /**
     * Current idle policy plus this session's effective absolute expiry (stored expiry or current policy,
     * whichever is sooner) — what identity.me reports so the client can warn before expiry.
     */
    async timing(sessionId: string, opts: { tx?: DbOrTx } = {}): Promise<{ idleTimeoutSeconds: number; absoluteExpiresAt: Date } | null> {
      const [joined] = await db(opts.tx)
        .select({ row: userSessions, role: users.role })
        .from(userSessions)
        .innerJoin(users, eq(users.id, userSessions.userId))
        .where(eq(userSessions.publicId, sessionId))
        .limit(1);
      if (!joined) return null;
      const row = joined.row;
      const p = await policy(opts.tx, joined.role);
      return {
        idleTimeoutSeconds: Math.floor(p.idleMs / 1000),
        absoluteExpiresAt: new Date(Math.min(row.absoluteExpiresAt.getTime(), row.authenticatedAt.getTime() + p.absoluteMs)),
      };
    },

    /**
     * Service-internal (ops scripts only; never on tRPC/HTTP): a short-lived FULL principal for a
     * demo_seed account so the seeder can call module services that run sessions.assertCurrent.
     * Refused in production and for any account not provisioned with reason demo_seed. The bearer token
     * is never returned (its hash is of a discarded random value) and the resolver refuses ops rows, so
     * the session cannot be presented over HTTP. Audited `identity.session.ops_opened` in the same tx.
     * Callers revoke it with sessions.revoke(sessionId, "demo_seed_complete") when done.
     */
    async openOpsSession(userId: number, opts: { reason: "demo_seed"; tx?: Tx }): Promise<SessionPrincipal> {
      if (opts.reason !== "demo_seed") throw new DomainError("FORBIDDEN", "OPS_SESSION_FORBIDDEN", "Ops sessions are not available.");
      if (deps.config.deploymentProfile === "production") {
        throw new DomainError("FORBIDDEN", "OPS_SESSION_FORBIDDEN", "Ops sessions are not available in production.");
      }
      const run = async (tx: Tx): Promise<SessionPrincipal> => {
        const [user] = await tx.select().from(users).where(eq(users.id, userId)).limit(1).for("update");
        if (!user || !opsSessionAllowed(user)) {
          throw new DomainError("FORBIDDEN", "OPS_SESSION_FORBIDDEN", "Ops sessions are only available for demo accounts.");
        }
        const now = deps.clock.now();
        const csrfSecret = randomToken(32);
        const publicId = ulid(now.getTime());
        await tx.insert(userSessions).values({
          publicId,
          userId: user.id,
          tokenHash: deps.crypto.hashToken(randomToken(32)),
          csrfSecretEnc: deps.crypto.encrypt(csrfSecret, csrfAad(publicId)),
          authMethod: "local",
          authenticatedAt: now,
          lastSeenAt: now,
          absoluteExpiresAt: new Date(now.getTime() + OPS_SESSION_TTL_MS),
          mfaVerifiedAt: now,
          stepUpAt: now,
          deviceSummary: OPS_SESSION_MARKER,
        });
        const pendingSteps = (await transitions.derive(user, { mfaVerifiedAt: now }, tx)).filter((step) => !OPS_WAIVABLE_STEPS.has(step));
        if (pendingSteps.length > 0) {
          throw new DomainError("CONFLICT", "OPS_SESSION_NOT_READY", "The demo account is not ready for an ops session.");
        }
        await deps.audit.record(
          {
            category: "security",
            eventName: "identity.session.ops_opened",
            action: "create",
            outcome: "completed",
            actor: { role: "system" },
            resource: { type: "session", publicId },
            attributes: { reason: opts.reason, user_public_id: user.publicId, ttl_seconds: OPS_SESSION_TTL_MS / 1000 },
          },
          tx,
        );
        return {
          sessionId: publicId,
          userId: user.id,
          userPublicId: user.publicId,
          role: user.role,
          state: "full",
          pendingSteps: [],
          authMethod: "local",
          authenticatedAt: now,
          mfaVerifiedAt: now,
          stepUpAt: now,
          csrfSecret,
        };
      };
      return opts.tx ? run(opts.tx) : deps.db.transaction(run);
    },

    /** Creates a new session row for a freshly authenticated user. Call inside the login transaction. */
    async create(
      tx: Tx,
      user: Pick<UserRow, "id" | "role">,
      options: { authMethod: AuthMethod; userAgent?: string; mfaVerifiedAt?: Date | null },
    ): Promise<{ sessionId: string; issued: IssuedSession }> {
      const now = deps.clock.now();
      const restrictions = await centre.policy.load(tx);
      const facts = centre.policy.requestFacts();
      const refusal = admission(restrictions, user.role, facts.ip, facts.country, centre.policy.breakGlass());
      if (refusal) throw sessionRestricted(refusal);
      const p = await policy(tx, user.role, restrictions);
      const token = randomToken(32);
      const csrfSecret = randomToken(32);
      const absoluteExpiresAt = new Date(now.getTime() + p.absoluteMs);
      const publicId = ulid(now.getTime());
      await tx.insert(userSessions).values({
        publicId,
        userId: user.id,
        tokenHash: deps.crypto.hashToken(token),
        csrfSecretEnc: deps.crypto.encrypt(csrfSecret, csrfAad(publicId)),
        authMethod: options.authMethod,
        authenticatedAt: now,
        lastSeenAt: now,
        absoluteExpiresAt,
        mfaVerifiedAt: options.mfaVerifiedAt ?? null,
        deviceSummary: deviceSummary(options.userAgent),
        ipAddressEnc: facts.ip ? deps.crypto.encrypt(facts.ip, ipAad(publicId)) : null,
        country: facts.country,
      });
      await centre.log.record(
        { kind: "success", userId: user.id, role: user.role, authMethod: options.authMethod, sessionPublicId: publicId, deviceSummary: deviceSummary(options.userAgent), facts },
        tx,
      );
      // Concurrent-session limit: the newest sessions win; the oldest live ones beyond the limit are ended.
      const max = restrictions.enabled && !centre.policy.breakGlass() ? restrictions.maxConcurrentPerUser : null;
      if (max !== null && max > 0) {
        // Effective liveness in SQL (current per-role policy), newest `max` kept (the new session included),
        // every other live session ended through endWhere — batched, no total cap. The users row lock taken
        // by the login transaction serialises concurrent sign-ins of this user.
        const live = and(
          eq(userSessions.userId, user.id),
          isNull(userSessions.revokedAt),
          gt(userSessions.absoluteExpiresAt, now),
          gt(userSessions.lastSeenAt, new Date(now.getTime() - p.idleMs)),
          gt(userSessions.authenticatedAt, new Date(now.getTime() - p.absoluteMs)),
          or(isNull(userSessions.deviceSummary), ne(userSessions.deviceSummary, OPS_SESSION_MARKER)),
        );
        const keep = await tx
          .select({ id: userSessions.id })
          .from(userSessions)
          .where(live)
          .orderBy(desc(userSessions.lastSeenAt), desc(userSessions.id))
          .limit(max);
        const keepIds = keep.map((row) => row.id);
        await endWhere(tx, and(live, keepIds.length > 0 ? notInArray(userSessions.id, keepIds) : undefined), "concurrency_limit", true);
      }
      return { sessionId: publicId, issued: issued(publicId, token, csrfSecret, absoluteExpiresAt) };
    },

    rotate: (sessionId: string, opts: { tx?: Tx } = {}) => rotateWith(sessionId, {}, opts.tx),
    markMfaVerified: (sessionId: string, opts: { tx?: Tx } = {}) => rotateWith(sessionId, { mfaVerifiedAt: deps.clock.now() }, opts.tx),
    markStepUp: (sessionId: string, opts: { tx?: Tx } = {}) => {
      const now = deps.clock.now();
      return rotateWith(sessionId, { mfaVerifiedAt: now, stepUpAt: now }, opts.tx);
    },

    async revoke(sessionId: string, reason: string, opts: { tx?: Tx } = {}): Promise<void> {
      await endWhere(db(opts.tx), eq(userSessions.publicId, sessionId), reason, opts.tx !== undefined);
    },

    async revokeAllForUser(userId: number, opts: { exceptSessionId?: string; reason: string; tx?: Tx }): Promise<number> {
      const conditions = [eq(userSessions.userId, userId), isNull(userSessions.revokedAt)];
      if (opts.exceptSessionId) conditions.push(ne(userSessions.publicId, opts.exceptSessionId));
      return endWhere(db(opts.tx), and(...conditions), opts.reason, opts.tx !== undefined);
    },

    /** Package D: ends every live CUSTOMER session (bounded batches). Caller authorises + audits in `tx`. */
    async revokeAllCustomers(reason: string, tx: Tx): Promise<number> {
      const customers = tx.select({ id: users.id }).from(users).where(eq(users.role, "customer"));
      return endWhere(tx, and(inArray(userSessions.userId, customers), gt(userSessions.absoluteExpiresAt, deps.clock.now())), reason, true);
    },

    /** Package D: ends one session of any user (admin). Returns the row it ended, or null when none was live. */
    async revokeAny(sessionId: string, reason: string, tx: Tx): Promise<{ userId: number } | null> {
      let owner: number | null = null;
      const ended = await endWhere(tx, eq(userSessions.publicId, sessionId), reason, true, (row) => (owner = row.userId));
      return ended === 1 && owner !== null ? { userId: owner } : null;
    },

    isLive,
    ipOf(row: Pick<UserSessionRow, "publicId" | "ipAddressEnc">): string | null {
      if (!row.ipAddressEnc) return null;
      try {
        return deps.crypto.decrypt(row.ipAddressEnc, ipAad(row.publicId));
      } catch {
        return null;
      }
    },

    async getState(sessionId: string, opts: { tx?: DbOrTx } = {}): Promise<SessionState | null> {
      const [joined] = await db(opts.tx)
        .select({ session: userSessions, user: users })
        .from(userSessions)
        .innerJoin(users, eq(users.id, userSessions.userId))
        .where(eq(userSessions.publicId, sessionId))
        .limit(1);
      if (!joined) return null;
      const p = await policy(opts.tx, joined.user.role);
      return {
        sessionId,
        userId: joined.user.id,
        userPublicId: joined.user.publicId,
        role: joined.user.role,
        userStatus: joined.user.status,
        live: isLive(joined.session, joined.user, deps.clock.now(), p),
        revokedAt: joined.session.revokedAt,
        mfaVerifiedAt: joined.session.mfaVerifiedAt,
        stepUpAt: joined.session.stepUpAt,
        absoluteExpiresAt: joined.session.absoluteExpiresAt,
        authMethod: joined.session.authMethod,
      };
    },

    /**
     * Locks users row then session row; rejects stale principals (revoked/expired/inactive, role or CSRF
     * secret changed by an in-flight rotation). Returns the PERSISTED authority re-derived inside tx.
     */
    async assertCurrent(
      principal: SessionPrincipal,
      tx: Tx,
    ): Promise<{ pendingSteps: TransitionStep[]; role: UserRole; stepUpAt: Date | null; mfaVerifiedAt: Date | null }> {
      const [user] = await tx.select().from(users).where(eq(users.id, principal.userId)).limit(1).for("update");
      const row = await sessionRow(tx, principal.sessionId, true);
      if (!user || !row || row.userId !== user.id) throw sessionNotCurrent();
      if (!isLive(row, user, deps.clock.now(), await policy(tx, user.role))) throw sessionNotCurrent();
      if (user.role !== principal.role) throw sessionNotCurrent();
      if (row.authMethod !== principal.authMethod) throw sessionNotCurrent();
      let secret: string;
      try {
        secret = deps.crypto.decrypt(row.csrfSecretEnc, csrfAad(row.publicId));
      } catch {
        throw sessionNotCurrent();
      }
      if (secret !== principal.csrfSecret) throw sessionNotCurrent();
      let pendingSteps = await transitions.derive(user, row, tx);
      if (row.deviceSummary === OPS_SESSION_MARKER) {
        if (!opsSessionAllowed(user)) throw sessionNotCurrent();
        pendingSteps = pendingSteps.filter((step) => !OPS_WAIVABLE_STEPS.has(step));
      }
      return { pendingSteps, role: user.role, stepUpAt: row.stepUpAt, mfaVerifiedAt: row.mfaVerifiedAt };
    },

    async listForUser(userId: number, currentSessionId: string, role?: UserRole): Promise<SessionListItem[]> {
      const now = deps.clock.now();
      const p = await policy(undefined, role);
      const rows = await deps.db
        .select()
        .from(userSessions)
        .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt), gt(userSessions.absoluteExpiresAt, now)))
        .limit(100);
      return rows
        .filter((row) => isLive(row, { status: "active" }, now, p))
        .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
        .map((row) => ({
          sessionId: row.publicId,
          current: row.publicId === currentSessionId,
          createdAt: row.authenticatedAt,
          lastSeenAt: row.lastSeenAt,
          expiresAt: new Date(Math.min(row.absoluteExpiresAt.getTime(), row.lastSeenAt.getTime() + p.idleMs, row.authenticatedAt.getTime() + p.absoluteMs)),
          deviceSummary: row.deviceSummary,
          authMethod: row.authMethod,
          country: row.country,
          ipAddress: service.ipOf(row),
        }));
    },

    /** Revoke one of the caller's own sessions; anything else is NOT_FOUND (no existence oracle). */
    async revokeOwn(userId: number, sessionId: string, tx: Tx): Promise<void> {
      const row = await sessionRow(tx, sessionId, true);
      if (!row || row.userId !== userId || row.revokedAt !== null) throw notFound("SESSION_NOT_FOUND");
      await tx.update(userSessions).set({ revokedAt: deps.clock.now(), revokeReason: "user_revoked" }).where(eq(userSessions.id, row.id));
    },

    async countLive(userId?: number): Promise<number> {
      const now = deps.clock.now();
      const conditions = [isNull(userSessions.revokedAt), gt(userSessions.absoluteExpiresAt, now)];
      if (userId !== undefined) conditions.push(eq(userSessions.userId, userId));
      const rows = await deps.db.select({ id: userSessions.id }).from(userSessions).where(and(...conditions)).limit(10_000);
      return rows.length;
    },
  };

  const resolver: SessionResolver = {
    async resolve(credentials: SessionCredentials): Promise<SessionPrincipal | null> {
      try {
        if (credentials.transport === "preview-header" && !deps.config.previewTransportEnabled) return null;
        const token = credentials.token;
        if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) return null;
        const [joined] = await deps.db
          .select({ session: userSessions, user: users })
          .from(userSessions)
          .innerJoin(users, eq(users.id, userSessions.userId))
          .where(eq(userSessions.tokenHash, deps.crypto.hashToken(token)))
          .limit(1);
        if (!joined) return null;
        const { session, user } = joined;
        if (session.deviceSummary === OPS_SESSION_MARKER) return null; // ops sessions never ride HTTP
        const now = deps.clock.now();
        const restrictions = await centre.policy.load();
        const p = await policy(undefined, user.role, restrictions);
        if (!isLive(session, user, now, p)) {
          if (session.revokedAt === null) {
            const reason = user.status !== "active" ? "account_inactive" : now.getTime() - session.lastSeenAt.getTime() > p.idleMs ? "idle_timeout" : "absolute_timeout";
            await service.revoke(session.publicId, reason);
          }
          return null;
        }
        // Increment 04: restrictions are re-checked on every request (address / country may change mid-session).
        const facts = centre.policy.requestFacts();
        const refusal = admission(restrictions, user.role, facts.ip, facts.country, centre.policy.breakGlass());
        if (refusal) {
          await service.revoke(session.publicId, refusal === "RESTRICTION_IP" ? "restriction_ip" : "restriction_country");
          return null;
        }
        const pendingSteps = await transitions.derive(user, session);
        if (now.getTime() - session.lastSeenAt.getTime() >= LAST_SEEN_WRITE_INTERVAL_MS) {
          await deps.db.update(userSessions).set({ lastSeenAt: now }).where(eq(userSessions.id, session.id));
        }
        return {
          sessionId: session.publicId,
          userId: user.id,
          userPublicId: user.publicId,
          role: user.role,
          state: pendingSteps.length === 0 ? "full" : "remediation",
          pendingSteps,
          authMethod: session.authMethod,
          authenticatedAt: session.authenticatedAt,
          mfaVerifiedAt: session.mfaVerifiedAt,
          stepUpAt: session.stepUpAt,
          csrfSecret: deps.crypto.decrypt(session.csrfSecretEnc, csrfAad(session.publicId)),
        };
      } catch (error) {
        // Fail closed (unknown session) — e.g. assurance or key material unavailable. Never throw.
        deps.logger.warn("identity.session.resolve_failed", { errorName: error instanceof Error ? error.name : "unknown" });
        return null;
      }
    },
  };

  return { ...service, resolver };
}
export type SessionService = ReturnType<typeof createSessionService>;
