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
import { and, eq, gt, isNull, ne } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import { DomainError, notFound } from "../../core/errors.js";
import { randomToken, ulid } from "../../core/ids.js";
import type { DbOrTx, SessionCredentials, SessionPrincipal, SessionResolver, Tx } from "../../core/types.js";
import { deriveSessionCsrfToken } from "../../security/csrf.js";
import type { AuthMethod, TransitionStep, UserRole } from "../../../shared/domain.js";
import { readSetting } from "../platform/settingsRegistry.js";
import { deviceSummary } from "./normalize.js";
import { userSessions, users, type UserRow, type UserSessionRow, type UserStatus } from "./schema.js";
import { SESSION_ABSOLUTE_HOURS, SESSION_IDLE_MINUTES } from "./settings.js";
import type { TransitionService } from "./transitions.js";

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
}

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const LAST_SEEN_WRITE_INTERVAL_MS = 60 * 1000;
/**
 * device_summary marker of a service-internal ops session (openOpsSession). deviceSummary() only ever yields
 * "<Browser> on <OS>", so no user agent can produce it; the resolver also refuses such rows outright.
 */
export const OPS_SESSION_MARKER = "ops:demo_seed";
const OPS_SESSION_TTL_MS = 10 * 60 * 1000;
/** Steps an ops session for a not-yet-enrolled demo_seed account may skip (the human enrols at first sign-in). */
const OPS_WAIVABLE_STEPS: ReadonlySet<TransitionStep> = new Set(["enroll_mfa", "acknowledge_recovery_codes", "change_password"]);
const csrfAad = (publicId: string) => `user_sessions.csrf:${publicId}`;

export const sessionNotCurrent = () =>
  new DomainError("UNAUTHENTICATED", "SESSION_NOT_CURRENT", "Your session has ended. Please sign in again.");

export function createSessionService(deps: ModuleDeps, transitions: TransitionService) {
  const db = (tx?: DbOrTx) => tx ?? deps.db;

  /*
   * Session policy (idle/absolute), read on every use so policy changes affect existing sessions. Inside a
   * transaction the read goes through THAT transaction's connection (readSetting(..., tx)) — never through the
   * settings pool while a connection is held (one-connection pools would deadlock — review ID-06).
   */
  async function policy(tx?: DbOrTx) {
    const t = tx as Tx | undefined;
    const [idleMinutes, absoluteHours] = await Promise.all([
      readSetting(deps.settings, SESSION_IDLE_MINUTES, t),
      readSetting(deps.settings, SESSION_ABSOLUTE_HOURS, t),
    ]);
    return { idleMs: idleMinutes * 60_000, absoluteMs: absoluteHours * 3_600_000 };
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
      const [row] = await db(opts.tx).select().from(userSessions).where(eq(userSessions.publicId, sessionId)).limit(1);
      if (!row) return null;
      const p = await policy(opts.tx);
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
      user: Pick<UserRow, "id">,
      options: { authMethod: AuthMethod; userAgent?: string; mfaVerifiedAt?: Date | null },
    ): Promise<{ sessionId: string; issued: IssuedSession }> {
      const now = deps.clock.now();
      const p = await policy(tx);
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
      });
      return { sessionId: publicId, issued: issued(publicId, token, csrfSecret, absoluteExpiresAt) };
    },

    rotate: (sessionId: string, opts: { tx?: Tx } = {}) => rotateWith(sessionId, {}, opts.tx),
    markMfaVerified: (sessionId: string, opts: { tx?: Tx } = {}) => rotateWith(sessionId, { mfaVerifiedAt: deps.clock.now() }, opts.tx),
    markStepUp: (sessionId: string, opts: { tx?: Tx } = {}) => {
      const now = deps.clock.now();
      return rotateWith(sessionId, { mfaVerifiedAt: now, stepUpAt: now }, opts.tx);
    },

    async revoke(sessionId: string, reason: string, opts: { tx?: Tx } = {}): Promise<void> {
      await db(opts.tx)
        .update(userSessions)
        .set({ revokedAt: deps.clock.now(), revokeReason: reason.slice(0, 40) })
        .where(and(eq(userSessions.publicId, sessionId), isNull(userSessions.revokedAt)));
    },

    async revokeAllForUser(userId: number, opts: { exceptSessionId?: string; reason: string; tx?: Tx }): Promise<number> {
      const conditions = [eq(userSessions.userId, userId), isNull(userSessions.revokedAt)];
      if (opts.exceptSessionId) conditions.push(ne(userSessions.publicId, opts.exceptSessionId));
      const [result] = (await db(opts.tx)
        .update(userSessions)
        .set({ revokedAt: deps.clock.now(), revokeReason: opts.reason.slice(0, 40) })
        .where(and(...conditions))) as unknown as [{ affectedRows?: number }];
      return result?.affectedRows ?? 0;
    },

    async getState(sessionId: string, opts: { tx?: DbOrTx } = {}): Promise<SessionState | null> {
      const [joined] = await db(opts.tx)
        .select({ session: userSessions, user: users })
        .from(userSessions)
        .innerJoin(users, eq(users.id, userSessions.userId))
        .where(eq(userSessions.publicId, sessionId))
        .limit(1);
      if (!joined) return null;
      const p = await policy(opts.tx);
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
      if (!isLive(row, user, deps.clock.now(), await policy(tx))) throw sessionNotCurrent();
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

    async listForUser(userId: number, currentSessionId: string): Promise<SessionListItem[]> {
      const now = deps.clock.now();
      const p = await policy();
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
        const p = await policy();
        if (!isLive(session, user, now, p)) {
          if (session.revokedAt === null) {
            const reason = user.status !== "active" ? "account_inactive" : now.getTime() - session.lastSeenAt.getTime() > p.idleMs ? "idle_timeout" : "absolute_timeout";
            await service.revoke(session.publicId, reason);
          }
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
