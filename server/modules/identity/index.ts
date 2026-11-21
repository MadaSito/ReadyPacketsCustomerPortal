/**
 * Identity module — public service surface and factory. Owner: identity module engineer.
 * Other modules import TYPES from here and reach the instance through `deps.services.identity` at call time.
 * See API.md for the contract.
 */
import type { ModuleDeps } from "../../container.js";
import type { DbOrTx, ModuleHealth, ModuleLifecycle, SessionPrincipal, SessionResolver, Tx } from "../../core/types.js";
import type { AuthMethod, TransitionStep, UserRole } from "../../../shared/domain.js";
import { createAdminService, type AdminService, type CustomerListItem, type Page } from "./admin.js";
import { createBreakGlassService } from "./breakGlass.js";
import { createSsoService, type SsoService } from "./sso/service.js";
import { createAuthService, PASSWORD_RESET_JOB, type PasswordResetJob, type AuthService } from "./auth.js";
import { createCredentialService } from "./credentials.js";
import { IDENTITY_MAIL_TEMPLATES } from "./mail.js";
import { argon2ParamsFor, createPasswordHasher } from "./password/hasher.js";
import type { UserStatus } from "./schema.js";
import { createGates } from "./gates.js";
import { createSessionCentre, type SessionCentre } from "./sessionCentre.js";
import { createSessionPolicy, createSignInLog } from "./sessionPolicy.js";
import { createSessionService, type IssuedSession, type SessionListItem, type SessionState } from "./sessions.js";
import { createTokenService } from "./tokens.js";
import { createTransitionService } from "./transitions.js";
import { createUserRepo, toView, type LoadOptions, type UserView } from "./users.js";

export type { CustomerListItem, IssuedSession, Page, SessionListItem, SessionState, UserStatus, UserView };

export interface IdentityModule extends ModuleLifecycle {
  /** Authoritative session validation; consumed by the HTTP pipeline through `services.sessionResolver`. */
  sessionResolver: SessionResolver;
  getUser(userId: number, opts?: LoadOptions): Promise<UserView | null>;
  getUserByPublicId(publicId: string, opts?: LoadOptions): Promise<UserView | null>;
  verifyPassword(userId: number, password: string, opts?: { tx?: Tx }): Promise<boolean>;
  setPassword(
    userId: number,
    password: string,
    opts: { mustChange: boolean; tx?: Tx; revokeSessions?: { exceptSessionId?: string; reason: string } },
  ): Promise<void>;
  generateTemporaryPassword(): string;
  issueAdminSetPasswordLink(userId: number, opts: { tx: Tx }): Promise<{ previewLink?: string }>;
  hasActiveAdministrator(): Promise<boolean>;
  /** Service-internal (ops scripts only; never on tRPC/HTTP). See API.md. */
  provisionLocalAccount(
    input: { email: string; name: string; role: UserRole; password: string; mustChangePassword: boolean; customerRef?: string | null },
    opts: { tx: Tx; reason: "bootstrap_admin" | "demo_seed" },
  ): Promise<{ userId: number; publicId: string; customerRef: string | null }>;
  isCustomerRefAvailable(reference: string, tx?: DbOrTx): Promise<boolean>;
  /** Break-glass (assurance): active local admins with verified e-mail + password, FOR UPDATE, ascending id. */
  listLocalAdministratorCandidates(tx: Tx, options?: { lock?: boolean }): Promise<number[]>;
  /** Host recovery only (ops; never tRPC/HTTP). See API.md "Break-glass". */
  recoverLocalAdministratorPassword(userId: number, password: string, opts: { tx: Tx }): Promise<{ sessionsRevoked: number }>;
  sessions: {
    markMfaVerified(sessionId: string, opts?: { tx?: Tx }): Promise<IssuedSession>;
    markStepUp(sessionId: string, opts?: { tx?: Tx }): Promise<IssuedSession>;
    rotate(sessionId: string, opts?: { tx?: Tx }): Promise<IssuedSession>;
    revoke(sessionId: string, reason: string, opts?: { tx?: Tx }): Promise<void>;
    revokeAllForUser(userId: number, opts: { exceptSessionId?: string; reason: string; tx?: Tx }): Promise<number>;
    assertCurrent(
      principal: SessionPrincipal,
      tx: Tx,
    ): Promise<{ pendingSteps: TransitionStep[]; role: UserRole; stepUpAt: Date | null; mfaVerifiedAt: Date | null }>;
    getState(sessionId: string, opts?: { tx?: DbOrTx }): Promise<SessionState | null>;
    /** Idle policy + effective absolute expiry for identity.me. */
    timing(sessionId: string, opts?: { tx?: DbOrTx }): Promise<{ idleTimeoutSeconds: number; absoluteExpiresAt: Date } | null>;
    /** Service-internal (ops scripts only; never on tRPC/HTTP). See API.md "Ops sessions". */
    openOpsSession(userId: number, opts: { reason: "demo_seed"; tx?: Tx }): Promise<SessionPrincipal>;
    /** Increment 04 port (packages E, C). Opens its own transaction; see API.md. */
    endAllCustomers(actor: SessionPrincipal, input: { reasonCode: string }): Promise<{ ended: number }>;
  };
  transitions: {
    derive(userId: number, session?: { mfaVerifiedAt: Date | null; authMethod?: AuthMethod; tx?: DbOrTx }): Promise<TransitionStep[]>;
  };
  createPendingCustomer(
    input: { email: string; name: string; customerRef?: string | null; publicId?: string; createdAt?: Date },
    opts: { tx: Tx },
  ): Promise<{ userId: number; publicId: string; customerRef: string }>;
  findUserIdByEmail(email: string, opts?: { tx?: DbOrTx }): Promise<{ userId: number; publicId: string; role: UserRole; status: UserStatus } | null>;
  portableCustomers(
    tx: DbOrTx,
    after: string | null,
    limit: number,
    publicIds?: readonly string[],
  ): Promise<{ publicId: string; email: string; name: string; customerRef: string | null; createdAt: Date }[]>;
  searchCustomers(
    principal: SessionPrincipal,
    input: { query?: string; status?: UserStatus; cursor?: string; limit?: number },
  ): Promise<Page<CustomerListItem>>;

  /** Router-facing internals (not for other modules). */
  auth: AuthService;
  admin: AdminService;
  sso: SsoService;
  centre: SessionCentre;
  listSessions(principal: SessionPrincipal): Promise<SessionListItem[]>;
}

export function createIdentityModule(deps: ModuleDeps): IdentityModule {
  const hasher = createPasswordHasher(argon2ParamsFor(deps.config.deploymentProfile));
  const repo = createUserRepo(deps);
  const tokens = createTokenService(deps);
  const transitions = createTransitionService(deps);
  const sessionPolicy = createSessionPolicy(deps);
  const signInLog = createSignInLog(deps, sessionPolicy);
  const sessions = createSessionService(deps, transitions, { policy: sessionPolicy, log: signInLog });
  const gates = createGates(deps);
  const internals = { deps, hasher, repo, tokens, sessions, transitions, gates, signInLog };
  const auth = createAuthService(internals);
  const credentials = createCredentialService(internals);
  const admin = createAdminService(internals, auth);
  const breakGlass = createBreakGlassService(internals);
  const sso = createSsoService({ deps, repo, sessions, transitions, auth, gates, signInLog, authorizeInTx: admin.authorizeInTx });
  const centre = createSessionCentre({ deps, sessions, policy: sessionPolicy, authorizeInTx: admin.authorizeInTx });
  deps.jobs.register("identity.signin_log.prune", async () => {
    const removed = await centre.pruneSignInLog();
    return { outcome: "completed", safeCounts: { removed } };
  }, { retrySafe: true });
  deps.jobs.registerSchedule({ name: "identity.signin_log.prune", type: "identity.signin_log.prune", everyMs: 6 * 60 * 60_000 });
  deps.jobs.register("identity.sso.prune", async () => {
    const removed = await sso.prune();
    return { outcome: "completed", safeCounts: { removed } };
  }, { retrySafe: true });
  deps.jobs.registerSchedule({ name: "identity.sso.prune", type: "identity.sso.prune", everyMs: 60 * 60_000 });

  for (const template of IDENTITY_MAIL_TEMPLATES) deps.mailer.registerTemplate(template);
  // Public forgot-password work runs here, off the request path (review ID-04). One transaction of pure
  // database work (mail goes to the transactional outbox) ⇒ retry-safe.
  deps.jobs.register<PasswordResetJob>(
    PASSWORD_RESET_JOB,
    async (job) => {
      const outcome = await auth.dispatchPasswordReset(job.payload);
      return { outcome: "completed", safeCounts: { [outcome]: 1 } };
    },
    { retrySafe: true },
  );

  const view = (row: Awaited<ReturnType<typeof repo.byId>>) => (row ? toView(deps.crypto, row) : null);

  return {
    sessionResolver: sessions.resolver,
    getUser: async (userId, opts) => view(await repo.byId(userId, opts)),
    getUserByPublicId: async (publicId, opts) => view(await repo.byPublicId(publicId, opts)),
    verifyPassword: credentials.verifyPassword,
    setPassword: credentials.setPassword,
    generateTemporaryPassword: credentials.generateTemporaryPassword,
    issueAdminSetPasswordLink: credentials.issueAdminSetPasswordLink,
    hasActiveAdministrator: () => repo.hasActiveAdministrator(),
    provisionLocalAccount: auth.provisionLocalAccount,
    isCustomerRefAvailable: (reference, tx) => repo.isCustomerRefAvailable(reference, tx),
    listLocalAdministratorCandidates: breakGlass.listLocalAdministratorCandidates,
    recoverLocalAdministratorPassword: breakGlass.recoverLocalAdministratorPassword,
    sessions: {
      markMfaVerified: sessions.markMfaVerified,
      markStepUp: sessions.markStepUp,
      rotate: sessions.rotate,
      revoke: sessions.revoke,
      revokeAllForUser: sessions.revokeAllForUser,
      assertCurrent: sessions.assertCurrent,
      getState: sessions.getState,
      timing: sessions.timing,
      openOpsSession: sessions.openOpsSession,
      endAllCustomers: centre.endAllCustomers,
    },
    transitions: {
      async derive(userId, session) {
        const row = await repo.byId(userId, session?.tx ? { tx: session.tx } : {});
        if (!row) return [];
        return transitions.derive(row, session ? { mfaVerifiedAt: session.mfaVerifiedAt, authMethod: session.authMethod } : undefined, session?.tx);
      },
    },
    createPendingCustomer: admin.createPendingCustomer,
    findUserIdByEmail: admin.findUserIdByEmail,
    portableCustomers: admin.portableCustomers,
    searchCustomers: admin.searchCustomers,
    auth,
    admin,
    sso,
    centre,
    listSessions: (principal) => sessions.listForUser(principal.userId, principal.sessionId, principal.role),
    async health(): Promise<ModuleHealth[]> {
      const checkedAt = deps.clock.now();
      try {
        const live = await sessions.countLive();
        return [{ component: "identity.sessions", state: "ok", summary: "Session store reachable.", metrics: { live_sessions: live }, checkedAt }];
      } catch {
        return [{ component: "identity.sessions", state: "failing", summary: "Session store unreachable.", checkedAt }];
      }
    },
  };
}
