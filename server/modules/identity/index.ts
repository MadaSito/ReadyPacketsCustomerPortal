/**
 * Identity module — public service surface and factory. Owner: identity module engineer.
 * Other modules import TYPES from here and reach the instance through `deps.services.identity` at call time.
 * See API.md for the contract.
 */
import type { ModuleDeps } from "../../container.js";
import { notFound, validation } from "../../core/errors.js";
import type { DbOrTx, ModuleHealth, ModuleLifecycle, SessionPrincipal, SessionResolver, Tx } from "../../core/types.js";
import type { AuthMethod, TransitionStep, UserRole } from "../../../shared/domain.js";
import { createAdminService, type AdminService, type CustomerListItem, type Page } from "./admin.js";
import { createBreakGlassService } from "./breakGlass.js";
import { createSsoService, type SsoService } from "./sso/service.js";
import { registerSamlMetadataCheck } from "../jobs/samlMetadata.js";
import { createAuthService, PASSWORD_RESET_JOB, type PasswordResetJob, type AuthService } from "./auth.js";
import { createCredentialService } from "./credentials.js";
import { IDENTITY_MAIL_TEMPLATES } from "./mail.js";
import { argon2ParamsFor, createPasswordHasher } from "./password/hasher.js";
import type { UserStatus } from "./schema.js";
import { createGates } from "./gates.js";
import { createSessionCentre, type SessionCentre } from "./sessionCentre.js";
import { createSessionPolicy, createSignInLog } from "./sessionPolicy.js";
import { createSessionService, type IssuedSession, type SessionListItem, type SessionState } from "./sessions.js";
import { createSignInSignals, type SignInSignals } from "./signals.js";
import { createTokenService } from "./tokens.js";
import { createTransitionService } from "./transitions.js";
import { createUserRepo, namePartsOf, toView, type LoadOptions, type UserView } from "./users.js";
import type { NameParts } from "./normalize.js";
import { isTrashedUserInTx } from "./live.js";
import { createIdentityTrash, type IdentityTrash } from "./trash.js";
import type { TrashParticipant } from "../trash/ports.js";

/** Other modules may pass a transaction / lock, never `includeGone` (trash paths use `identity.trash`). */
export type PublicLoadOptions = Omit<LoadOptions, "includeGone">;
const publicLoad = (opts?: PublicLoadOptions): LoadOptions | undefined => (opts ? { ...(opts.tx ? { tx: opts.tx } : {}), ...(opts.forUpdate ? { forUpdate: true } : {}) } : undefined);

export type { CustomerListItem, IssuedSession, Page, SessionListItem, SessionState, UserStatus, UserView };

export interface IdentityModule extends ModuleLifecycle {
  /** Authoritative session validation; consumed by the HTTP pipeline through `services.sessionResolver`. */
  sessionResolver: SessionResolver;
  /** Increment 09: a trashed or tombstoned account answers null (exactly like an unknown id). */
  getUser(userId: number, opts?: PublicLoadOptions): Promise<UserView | null>;
  getUserByPublicId(publicId: string, opts?: PublicLoadOptions): Promise<UserView | null>;
  /**
   * Batch lookup by internal id for read views (e.g. the acceptance log): one query, at most 500 distinct ids,
   * missing ids are simply absent. Returns decrypted name/e-mail — callers must hold the capability for the
   * view they render and must not log the values.
   */
  getUsersByIds(userIds: readonly number[], opts?: { tx?: DbOrTx }): Promise<Map<number, UserView>>;
  /**
   * Increment 06 D13 port (policy enforcement): ends every live session of `userId`. No capability check —
   * the caller authorizes (admin "End sessions now" needs sessions.revoke_any + step-up). Audited
   * `auth.session.revoked_all` in the same transaction. `reason` matches /^[a-z][a-z0-9_]{2,39}$/
   * (e.g. policy_deadline, policy_declined, policy_admin_ended).
   */
  endSessionsForUser(userId: number, reason: string, opts?: { tx?: Tx }): Promise<{ ended: number }>;
  /** Increment 06 D7: sign-in step signals to the protection module + the hashed account reference. */
  signInSignals: SignInSignals;
  /** Customer ids matching a search (e-mail exact, reference prefix, name prefix); ≤500; caller authorizes + audits. */
  findCustomerIds(query: string, opts?: { status?: UserStatus; limit?: number; tx?: DbOrTx }): Promise<number[]>;
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
    /** Server-side only (background jobs; never tRPC/HTTP). Full principal of a live session, or throws. See API.md. */
    principalForJob(sessionId: string, expectedUserId: number, opts?: { tx?: Tx }): Promise<SessionPrincipal>;
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
    input: {
      email: string; name: string; nameParts?: NameParts; customerRef?: string | null; publicId?: string; createdAt?: Date;
      trash?: { trashedAt: Date; batchId: string | null; reason: string | null; purgedAt: Date | null } | null;
    },
    opts: { tx: Tx },
  ): Promise<{ userId: number; publicId: string; customerRef: string }>;
  /** Live accounts only unless `includeTrashed` (portable import planning: an account in the trash keeps its address). */
  findUserIdByEmail(
    email: string,
    opts?: { tx?: DbOrTx; includeTrashed?: boolean },
  ): Promise<{ userId: number; publicId: string; role: UserRole; status: UserStatus; trashed: boolean } | null>;
  /** Increment 09: live customers only unless `includeTrashed` (then trashed AND tombstoned rows, with `trash`). */
  portableCustomers(
    tx: DbOrTx,
    after: string | null,
    limit: number,
    publicIds?: readonly string[],
    opts?: { includeTrashed?: boolean },
  ): Promise<
    {
      userId: number;
      publicId: string; email: string; name: string; customerRef: string | null; createdAt: Date;
      /** D1: stored parts only; null while the account has not stored them. */
      firstName: string | null; lastName: string | null; preferredName: string | null;
      trash: { trashedAt: Date; batchId: string | null; reason: string | null; purgeStartedAt: Date | null; purgedAt: Date | null } | null;
    }[]
  >;
  /** Increment 09 (portable only): UNGATED reference read by internal id or public id. Never by e-mail. */
  portableCustomerRefInTx(
    tx: DbOrTx,
    key: { userId: number } | { publicId: string },
  ): Promise<{ userId: number; publicId: string; role: UserRole; trashed: boolean; trashedAt: Date | null; purgeStartedAt: Date | null; purged: boolean; purgedAt: Date | null } | null>;
  /** Increment 09 (D2): trusted customer trash functions for the trash coordinator only. See API.md "Trash". */
  trash: IdentityTrash;
  /** D1 port (orders). Name parts (derived when not stored) + customer reference. No lock, no audit. Unknown user → NOT_FOUND USER_NOT_FOUND. */
  users: {
    namePartsInTx(tx: DbOrTx, userId: number): Promise<{ firstName: string; lastName: string; preferredName: string | null; customerRef: string | null }>;
    /** Increment 09 (D2.5): true when the account is in the trash or a tombstone; false for live or unknown ids. */
    isTrashedInTx(tx: DbOrTx, userId: number): Promise<boolean>;
  };
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
  // Increment 07 (D10): daily SAML certificate expiry / metadata rollover check. No-op unless SAML is selected.
  registerSamlMetadataCheck(deps.jobs, async () => {
    const result = await sso.saml.dailyCheck();
    return { outcome: "completed", safeCounts: { added: result.added, alerts: result.alerts, skipped: result.skipped ? 1 : 0 } };
  });

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

  const signInSignals = createSignInSignals(deps);
  const trash = createIdentityTrash({ deps, sessions, tokens });
  const view = (row: Awaited<ReturnType<typeof repo.byId>>) => (row ? toView(deps.crypto, row) : null);

  return {
    sessionResolver: sessions.resolver,
    getUser: async (userId, opts) => view(await repo.byId(userId, publicLoad(opts))),
    getUserByPublicId: async (publicId, opts) => view(await repo.byPublicId(publicId, publicLoad(opts))),
    async getUsersByIds(userIds, opts) {
      const rows = await repo.byIds(userIds, opts);
      return new Map(rows.map((row) => [row.id, toView(deps.crypto, row)]));
    },
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
      principalForJob: sessions.principalForJob,
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
    users: {
      async namePartsInTx(tx, userId) {
        const row = await repo.byId(userId, { tx });
        if (!row) throw notFound("USER_NOT_FOUND");
        const parts = namePartsOf(deps.crypto, row);
        return { firstName: parts.firstName, lastName: parts.lastName, preferredName: parts.preferredName, customerRef: row.customerRef ?? null };
      },
      isTrashedInTx: (tx, userId) => isTrashedUserInTx(tx, userId),
    },
    portableCustomerRefInTx: admin.portableCustomerRefInTx,
    trash,
    findUserIdByEmail: admin.findUserIdByEmail,
    portableCustomers: admin.portableCustomers,
    searchCustomers: admin.searchCustomers,
    findCustomerIds: admin.findCustomerIds,
    async endSessionsForUser(userId, reason, opts) {
      if (!/^[a-z][a-z0-9_]{2,39}$/.test(reason)) throw validation("REASON_INVALID", "A valid reason is required.");
      const run = async (tx: Tx) => {
        const user = await repo.byId(userId, { tx });
        if (!user) throw notFound("USER_NOT_FOUND");
        const ended = await sessions.revokeAllForUser(userId, { reason, tx });
        await deps.audit.record(
          {
            category: "security", eventName: "auth.session.revoked_all", action: "revoke", outcome: "completed",
            reasonCode: reason.toUpperCase(), resource: { type: "user", publicId: user.publicId }, safeCounts: { sessions_revoked: ended },
            attributes: { source: "policy_enforcement" },
          },
          tx,
        );
        return { ended };
      };
      return opts?.tx ? run(opts.tx) : deps.db.transaction(run);
    },
    signInSignals,
    auth,
    admin,
    sso,
    centre,
    /** Package H: the public API reads customers through this module (customers only, audited as system). */
    init() {
      const publicApi = (deps.services as { publicApi?: { registerProvider?: (key: "customers", provider: typeof admin.apiCustomers) => void } }).publicApi;
      publicApi?.registerProvider?.("customers", admin.apiCustomers);
      // Increment 09 (D2.5): identity's part of a customer purge (tokens, sessions, SSO links).
      const trashRegistry = (deps.services as { trash?: { register?: (participant: TrashParticipant) => void } }).trash;
      trashRegistry?.register?.(trash.participant());
    },
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
