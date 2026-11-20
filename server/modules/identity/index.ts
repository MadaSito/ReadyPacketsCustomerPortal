/**
 * Identity module — public service surface and factory. Owner: identity module engineer.
 * Other modules import TYPES from here and reach the instance through `deps.services.identity` at call time.
 * See API.md for the contract.
 */
import type { ModuleDeps } from "../../container.js";
import type { DbOrTx, ModuleHealth, ModuleLifecycle, SessionPrincipal, SessionResolver, Tx } from "../../core/types.js";
import type { TransitionStep, UserRole } from "../../../shared/domain.js";
import { createAdminService, type AdminService, type CustomerListItem, type Page } from "./admin.js";
import { createAuthService, type AuthService } from "./auth.js";
import { createCredentialService } from "./credentials.js";
import { IDENTITY_MAIL_TEMPLATES } from "./mail.js";
import { argon2ParamsFor, createPasswordHasher } from "./password/hasher.js";
import type { UserStatus } from "./schema.js";
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
  isCustomerRefAvailable(reference: string, tx?: DbOrTx): Promise<boolean>;
  sessions: {
    markMfaVerified(sessionId: string, opts?: { tx?: Tx }): Promise<IssuedSession>;
    markStepUp(sessionId: string, opts?: { tx?: Tx }): Promise<IssuedSession>;
    rotate(sessionId: string, opts?: { tx?: Tx }): Promise<IssuedSession>;
    revoke(sessionId: string, reason: string, opts?: { tx?: Tx }): Promise<void>;
    revokeAllForUser(userId: number, opts: { exceptSessionId?: string; reason: string; tx?: Tx }): Promise<number>;
    assertCurrent(principal: SessionPrincipal, tx: Tx): Promise<{ pendingSteps: TransitionStep[] }>;
    getState(sessionId: string, opts?: { tx?: DbOrTx }): Promise<SessionState | null>;
  };
  transitions: {
    derive(userId: number, session?: { mfaVerifiedAt: Date | null; tx?: DbOrTx }): Promise<TransitionStep[]>;
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
  listSessions(principal: SessionPrincipal): Promise<SessionListItem[]>;
}

export function createIdentityModule(deps: ModuleDeps): IdentityModule {
  const hasher = createPasswordHasher(argon2ParamsFor(deps.config.deploymentProfile));
  const repo = createUserRepo(deps);
  const tokens = createTokenService(deps);
  const transitions = createTransitionService(deps);
  const sessions = createSessionService(deps, transitions);
  const internals = { deps, hasher, repo, tokens, sessions, transitions };
  const auth = createAuthService(internals);
  const credentials = createCredentialService(internals);
  const admin = createAdminService(internals, auth);

  for (const template of IDENTITY_MAIL_TEMPLATES) deps.mailer.registerTemplate(template);

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
    isCustomerRefAvailable: (reference, tx) => repo.isCustomerRefAvailable(reference, tx),
    sessions: {
      markMfaVerified: sessions.markMfaVerified,
      markStepUp: sessions.markStepUp,
      rotate: sessions.rotate,
      revoke: sessions.revoke,
      revokeAllForUser: sessions.revokeAllForUser,
      assertCurrent: sessions.assertCurrent,
      getState: sessions.getState,
    },
    transitions: {
      async derive(userId, session) {
        const row = await repo.byId(userId, session?.tx ? { tx: session.tx } : {});
        if (!row) return [];
        return transitions.derive(row, session ? { mfaVerifiedAt: session.mfaVerifiedAt } : undefined, session?.tx);
      },
    },
    createPendingCustomer: admin.createPendingCustomer,
    findUserIdByEmail: admin.findUserIdByEmail,
    portableCustomers: admin.portableCustomers,
    searchCustomers: admin.searchCustomers,
    auth,
    admin,
    listSessions: (principal) => sessions.listForUser(principal.userId, principal.sessionId),
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
