/**
 * Public account flows: registration, sign-in, e-mail verification, password reset, invitation activation,
 * change password, sign-out. Uniform responses + timing; no account enumeration.
 */
import { eq } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import { DomainError, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { SessionPrincipal, Tx } from "../../core/types.js";
import type { TransitionStep } from "../../../shared/domain.js";
import { readSetting } from "../platform/settingsRegistry.js";
import { normalizeEmail } from "./normalize.js";
import type { PasswordHasher } from "./password/hasher.js";
import { checkPassword, PASSWORD_MESSAGES } from "./password/policy.js";
import { users, type UserRow } from "./schema.js";
import type { IssuedSession, SessionService } from "./sessions.js";
import { REGISTRATION_ENABLED, RESEND_MIN_INTERVAL_MS } from "./settings.js";
import type { TokenService } from "./tokens.js";
import type { TransitionService } from "./transitions.js";
import { emailColumns, emailIndexOf, generateCustomerRef, isDuplicate, nameColumns, toView, type UserRepo } from "./users.js";

export interface CallMeta {
  ipAddress?: string;
  userAgent?: string;
}

export const badCredentials = () =>
  new DomainError("UNAUTHENTICATED", "BAD_CREDENTIALS", "The e-mail address or password is incorrect.");
export const invalidLink = () =>
  new DomainError("VALIDATION", "LINK_INVALID", "This link is invalid, has already been used or has expired. Request a new one.");
const rateLimited = (retryAfterSeconds: number) =>
  new DomainError("RATE_LIMITED", "RATE_LIMITED", "Too many attempts. Please wait a moment and try again.", { retryAfterSeconds });

export interface AuthInternals {
  deps: ModuleDeps;
  hasher: PasswordHasher;
  repo: UserRepo;
  tokens: TokenService;
  sessions: SessionService;
  transitions: TransitionService;
}

export function assertPasswordAcceptable(password: string, context: { email?: string | null; name?: string | null }): void {
  const rejection = checkPassword(password, context);
  if (rejection) throw validation(rejection, PASSWORD_MESSAGES[rejection], { field: "password" });
}

export function createAuthService(i: AuthInternals) {
  const { deps, hasher, repo, tokens, sessions, transitions } = i;
  const preview = (path: string) => (deps.config.deploymentProfile === "preview" ? { previewLink: path } : {});

  async function throttle(category: "user_login" | "auth_high_risk", key: string): Promise<void> {
    const verdict = await deps.rateLimiter.consume(category, key);
    if (!verdict.allowed) throw rateLimited(verdict.retryAfterSeconds);
  }

  async function claimNewRef(tx: Tx, userId: number, requested?: string | null): Promise<string> {
    if (requested) {
      await repo.reserveRef(tx, requested, userId);
      return requested;
    }
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const candidate = generateCustomerRef();
      try {
        await repo.reserveRef(tx, candidate, userId);
        return candidate;
      } catch (error) {
        if (!(error instanceof DomainError && error.reasonCode === "REFERENCE_IN_USE")) throw error;
      }
    }
    throw new DomainError("UNAVAILABLE", "REFERENCE_GENERATION_FAILED", "A customer reference could not be generated. Please try again.");
  }

  /** Inserts a user row (+ reference reservation) inside tx. */
  async function insertUser(
    tx: Tx,
    input: {
      email: string;
      name: string;
      role: UserRow["role"];
      status: UserRow["status"];
      origin: string;
      passwordHash?: string | null;
      customerRef?: string | null;
      publicId?: string;
      createdAt?: Date;
      emailVerifiedAt?: Date | null;
    },
  ): Promise<{ id: number; publicId: string; customerRef: string | null }> {
    const publicId = input.publicId ?? ulid(deps.clock.now().getTime());
    const now = deps.clock.now();
    let id: number;
    try {
      const [inserted] = await tx
        .insert(users)
        .values({
          publicId,
          role: input.role,
          status: input.status,
          ...emailColumns(deps.crypto, publicId, input.email),
          ...nameColumns(deps.crypto, publicId, input.name),
          emailVerifiedAt: input.emailVerifiedAt ?? null,
          passwordHash: input.passwordHash ?? null,
          passwordChangedAt: input.passwordHash ? now : null,
          origin: input.origin,
          statusChangedAt: now,
          ...(input.createdAt ? { createdAt: input.createdAt } : {}),
        })
        .$returningId();
      id = inserted!.id;
    } catch (error) {
      if (isDuplicate(error)) {
        const message = String((error as { sqlMessage?: string; cause?: { sqlMessage?: string } }).sqlMessage ?? (error as { cause?: { sqlMessage?: string } }).cause?.sqlMessage ?? "");
        if (message.includes("public_id")) throw new DomainError("CONFLICT", "PUBLIC_ID_IN_USE", "That identifier is already in use.");
        throw new DomainError("CONFLICT", "EMAIL_IN_USE", "An account with that e-mail address already exists.");
      }
      throw error;
    }
    let customerRef: string | null = null;
    if (input.role === "customer") {
      customerRef = await claimNewRef(tx, id, input.customerRef);
      await tx.update(users).set({ customerRef }).where(eq(users.id, id));
    }
    return { id, publicId, customerRef };
  }

  async function nextStepFor(userId: number, sessionId: string): Promise<{ pendingSteps: TransitionStep[]; nextStep: TransitionStep | null }> {
    const state = await sessions.getState(sessionId);
    const user = await repo.byId(userId);
    if (!user || !state) return { pendingSteps: [], nextStep: null };
    const pendingSteps = await transitions.derive(user, state);
    return { pendingSteps, nextStep: pendingSteps[0] ?? null };
  }

  return {
    insertUser,
    claimNewRef,

    async register(input: { email: string; name: string; password: string }, meta: CallMeta): Promise<{ accepted: true; previewLink?: string }> {
      if (!(await readSetting(deps.settings, REGISTRATION_ENABLED))) {
        throw new DomainError("FORBIDDEN", "REGISTRATION_DISABLED", "New account registration is currently closed.");
      }
      const email = normalizeEmail(input.email);
      await throttle("auth_high_risk", `register:${emailIndexOf(deps.crypto, email)}`);
      // Policy is checked before any existence lookup, so its outcome reveals nothing about accounts.
      assertPasswordAcceptable(input.password, { email, name: input.name });
      const passwordHash = await hasher.hash(input.password); // always hash: uniform timing
      const existing = await repo.byEmail(email);
      if (existing) {
        await deps.mailer.enqueue({
          template: "auth.account_exists",
          to: { userId: existing.id },
          vars: { signInLink: `${deps.config.canonicalOrigin}/sign-in`, resetLink: `${deps.config.canonicalOrigin}/forgot-password` },
          idempotencyKey: `auth.account_exists:${existing.publicId}:${Math.floor(deps.clock.now().getTime() / 3_600_000)}`,
        });
        await deps.audit.record({
          category: "security",
          eventName: "auth.register.requested",
          action: "register",
          outcome: "refused",
          reasonCode: "EXISTING_ACCOUNT",
          actor: { role: "anonymous" },
          resource: { type: "user", publicId: existing.publicId },
        });
        return { accepted: true };
      }
      try {
        return await deps.db.transaction(async (tx) => {
          const created = await insertUser(tx, { email, name: input.name, role: "customer", status: "active", origin: "register", passwordHash });
          const link = await tokens.issue(tx, created.id, "verify_email");
          await deps.mailer.enqueue(
            { template: "auth.verify_email", to: { userId: created.id }, vars: { name: input.name, link: link.url }, idempotencyKey: `auth.verify_email:${link.token.slice(0, 16)}`, expiresAt: link.expiresAt },
            tx,
          );
          await deps.audit.record(
            {
              category: "security",
              eventName: "auth.register.requested",
              action: "register",
              outcome: "completed",
              actor: { userId: created.id, role: "customer" },
              resource: { type: "user", publicId: created.publicId },
            },
            tx,
          );
          void meta;
          return { accepted: true as const, ...preview(link.path) };
        });
      } catch (error) {
        // Concurrent registration of the same address: respond exactly like the existing-account branch.
        if (error instanceof DomainError && error.reasonCode === "EMAIL_IN_USE") return { accepted: true };
        throw error;
      }
    },

    async signIn(input: { email: string; password: string }, meta: CallMeta): Promise<{ issued: IssuedSession; nextStep: TransitionStep | null; sessionId: string; userId: number }> {
      const email = normalizeEmail(input.email);
      await throttle("user_login", `acct:${emailIndexOf(deps.crypto, email)}`);
      const user = await repo.byEmail(email);
      const ok = await hasher.verify(user?.passwordHash ?? null, input.password);
      const reason = !user ? "UNKNOWN_ACCOUNT" : !ok ? "BAD_PASSWORD" : user.status !== "active" ? "ACCOUNT_INACTIVE" : user.authSource !== "local" ? "WRONG_AUTH_SOURCE" : null;
      if (reason || !user) {
        await deps.audit.record({
          category: "security",
          eventName: "auth.login.failed",
          action: "login",
          outcome: "denied",
          severity: "WARN",
          reasonCode: reason ?? "UNKNOWN_ACCOUNT",
          actor: { role: "anonymous" },
          resource: user ? { type: "user", publicId: user.publicId } : { type: "user" },
        });
        throw badCredentials();
      }
      const result = await deps.db.transaction(async (tx) => {
        const locked = await repo.byId(user.id, { tx, forUpdate: true });
        if (!locked || locked.status !== "active" || locked.passwordHash !== user.passwordHash) throw badCredentials();
        if (locked.passwordHash && hasher.needsRehash(locked.passwordHash)) {
          await tx.update(users).set({ passwordHash: await hasher.hash(input.password) }).where(eq(users.id, user.id));
        }
        const created = await sessions.create(tx, locked, { authMethod: "local", userAgent: meta.userAgent });
        const steps = await transitions.derive(locked, { mfaVerifiedAt: null }, tx);
        await deps.audit.record(
          {
            category: "security",
            eventName: "auth.login.succeeded",
            action: "login",
            outcome: "completed",
            actor: { userId: locked.id, role: locked.role },
            resource: { type: "session", publicId: created.sessionId },
            attributes: { next_step: steps[0] ?? "none", auth_method: "local" },
          },
          tx,
        );
        return { ...created, nextStep: steps[0] ?? null };
      });
      return { issued: result.issued, nextStep: result.nextStep, sessionId: result.sessionId, userId: user.id };
    },

    async verifyEmail(token: string, session: SessionPrincipal | null): Promise<{ verified: true; issued?: IssuedSession }> {
      return deps.db.transaction(async (tx) => {
        const consumed = await tokens.consume(tx, token, ["verify_email"]);
        if (!consumed || consumed.user.status !== "active") throw invalidLink();
        const now = deps.clock.now();
        if (consumed.user.emailVerifiedAt === null) {
          await tx.update(users).set({ emailVerifiedAt: now, version: consumed.user.version + 1 }).where(eq(users.id, consumed.user.id));
        }
        let issued: IssuedSession | undefined;
        if (session && session.userId === consumed.user.id) issued = await sessions.rotate(session.sessionId, { tx });
        await deps.audit.record(
          {
            category: "security",
            eventName: "auth.email.verified",
            action: "verify",
            outcome: "completed",
            actor: { userId: consumed.user.id, role: consumed.user.role },
            resource: { type: "user", publicId: consumed.user.publicId },
          },
          tx,
        );
        return { verified: true as const, ...(issued ? { issued } : {}) };
      });
    },

    async resendVerification(principal: SessionPrincipal): Promise<{ accepted: true; previewLink?: string }> {
      await throttle("auth_high_risk", `verify:${principal.userPublicId}`);
      const user = await repo.byId(principal.userId);
      if (!user || user.emailVerifiedAt !== null) return { accepted: true };
      const last = await tokens.lastIssuedAt(deps.db, user.id, "verify_email");
      if (last && deps.clock.now().getTime() - last.getTime() < RESEND_MIN_INTERVAL_MS) return { accepted: true };
      return deps.db.transaction(async (tx) => {
        const view = toView(deps.crypto, user);
        const link = await tokens.issue(tx, user.id, "verify_email");
        await deps.mailer.enqueue(
          { template: "auth.verify_email", to: { userId: user.id }, vars: { name: view.name, link: link.url }, idempotencyKey: `auth.verify_email:${link.token.slice(0, 16)}`, expiresAt: link.expiresAt },
          tx,
        );
        await deps.audit.record(
          { category: "security", eventName: "auth.email.verification_sent", action: "notify", outcome: "completed", resource: { type: "user", publicId: user.publicId } },
          tx,
        );
        return { accepted: true as const, ...preview(link.path) };
      });
    },

    async requestPasswordReset(input: { email: string }): Promise<{ accepted: true; previewLink?: string }> {
      const email = normalizeEmail(input.email);
      await throttle("auth_high_risk", `reset:${emailIndexOf(deps.crypto, email)}`);
      const user = await repo.byEmail(email);
      if (!user || user.status !== "active" || user.authSource !== "local") {
        await deps.audit.record({
          category: "security",
          eventName: "auth.password.reset_requested",
          action: "request",
          outcome: "refused",
          reasonCode: user ? "ACCOUNT_NOT_ELIGIBLE" : "UNKNOWN_ACCOUNT",
          actor: { role: "anonymous" },
          resource: user ? { type: "user", publicId: user.publicId } : { type: "user" },
        });
        return { accepted: true };
      }
      const last = await tokens.lastIssuedAt(deps.db, user.id, "password_reset");
      if (last && deps.clock.now().getTime() - last.getTime() < RESEND_MIN_INTERVAL_MS) return { accepted: true };
      return deps.db.transaction(async (tx) => {
        const locked = await repo.byId(user.id, { tx, forUpdate: true });
        if (!locked) return { accepted: true as const };
        const link = await tokens.issue(tx, user.id, "password_reset");
        await deps.mailer.enqueue(
          { template: "auth.password_reset", to: { userId: user.id }, vars: { link: link.url }, idempotencyKey: `auth.password_reset:${link.token.slice(0, 16)}`, expiresAt: link.expiresAt },
          tx,
        );
        await deps.audit.record(
          {
            category: "security",
            eventName: "auth.password.reset_requested",
            action: "request",
            outcome: "completed",
            actor: { role: "anonymous" },
            resource: { type: "user", publicId: user.publicId },
          },
          tx,
        );
        return { accepted: true as const, ...preview(link.path) };
      });
    },

    /** Redeems a password_reset or admin_set_password link. Revokes ALL sessions; MFA is still required at sign-in. */
    async resetPassword(input: { token: string; password: string }): Promise<{ reset: true }> {
      const passwordHash = await (async () => {
        // Hash outside the lock only after a cheap shape check; policy is checked inside with user context.
        return hasher.hash(input.password);
      })();
      await deps.db.transaction(async (tx) => {
        const consumed = await tokens.consume(tx, input.token, ["password_reset", "admin_set_password"]);
        if (!consumed || consumed.user.status !== "active") throw invalidLink();
        const view = toView(deps.crypto, consumed.user);
        assertPasswordAcceptable(input.password, { email: view.email, name: view.name });
        await tx
          .update(users)
          .set({ passwordHash, passwordChangedAt: deps.clock.now(), mustChangePassword: false, version: consumed.user.version + 1 })
          .where(eq(users.id, consumed.user.id));
        const revoked = await sessions.revokeAllForUser(consumed.user.id, { reason: "password_reset", tx });
        await tokens.retireAll(tx, consumed.user.id, ["password_reset", "admin_set_password"], "password_set");
        await deps.audit.record(
          {
            category: "security",
            eventName: "auth.password.reset_completed",
            action: "reset",
            outcome: "completed",
            actor: { userId: consumed.user.id, role: consumed.user.role },
            resource: { type: "user", publicId: consumed.user.publicId },
            safeCounts: { sessions_revoked: revoked },
            attributes: { mode: consumed.purpose },
          },
          tx,
        );
        await deps.mailer.enqueue(
          { template: "auth.password_changed", to: { userId: consumed.user.id }, vars: {}, idempotencyKey: `auth.password_changed:${consumed.user.publicId}:${deps.clock.now().getTime()}` },
          tx,
        );
      });
      return { reset: true };
    },

    async activateAccount(input: { token: string; password: string }): Promise<{ activated: true }> {
      const passwordHash = await hasher.hash(input.password);
      await deps.db.transaction(async (tx) => {
        const consumed = await tokens.consume(tx, input.token, ["invitation"]);
        if (!consumed || consumed.user.status !== "pending_activation") throw invalidLink();
        const view = toView(deps.crypto, consumed.user);
        assertPasswordAcceptable(input.password, { email: view.email, name: view.name });
        const now = deps.clock.now();
        await tx
          .update(users)
          .set({
            passwordHash,
            passwordChangedAt: now,
            mustChangePassword: false,
            status: "active",
            statusChangedAt: now,
            statusReasonCode: "ACTIVATED",
            emailVerifiedAt: consumed.user.emailVerifiedAt ?? now, // the link proves mailbox control
            version: consumed.user.version + 1,
          })
          .where(eq(users.id, consumed.user.id));
        await tokens.retireAll(tx, consumed.user.id, ["invitation", "verify_email"], "password_set");
        await deps.audit.record(
          {
            category: "security",
            eventName: "auth.account.activated",
            action: "activate",
            outcome: "completed",
            actor: { userId: consumed.user.id, role: consumed.user.role },
            resource: { type: "user", publicId: consumed.user.publicId },
          },
          tx,
        );
      });
      return { activated: true };
    },

    /** Change password: full session, or a remediation session whose NEXT step is change_password. */
    async changePassword(principal: SessionPrincipal, input: { currentPassword: string; newPassword: string }): Promise<{ issued: IssuedSession; nextStep: TransitionStep | null }> {
      if (principal.state !== "full" && principal.pendingSteps[0] !== "change_password") {
        throw new DomainError("REMEDIATION_REQUIRED", "ACCOUNT_STEP_PENDING", "Please finish securing your account to continue.", {
          nextStep: principal.pendingSteps[0] ?? "unknown",
        });
      }
      await throttle("auth_high_risk", `pwchange:${principal.userPublicId}`);
      const issued = await deps.db.transaction(async (tx) => {
        await sessions.assertCurrent(principal, tx); // locks users row then session row
        const user = await repo.byId(principal.userId, { tx });
        if (!user) throw badCredentials();
        const currentOk = await hasher.verify(user.passwordHash, input.currentPassword);
        if (!currentOk) {
          throw new DomainError("VALIDATION", "CURRENT_PASSWORD_INCORRECT", "Your current password is incorrect.", { field: "currentPassword" });
        }
        const view = toView(deps.crypto, user);
        assertPasswordAcceptable(input.newPassword, { email: view.email, name: view.name });
        if (input.newPassword.normalize("NFC") === input.currentPassword.normalize("NFC")) {
          throw validation("PASSWORD_REUSED", "Choose a password different from your current one.", { field: "newPassword" });
        }
        await tx
          .update(users)
          .set({ passwordHash: await hasher.hash(input.newPassword), passwordChangedAt: deps.clock.now(), mustChangePassword: false, version: user.version + 1 })
          .where(eq(users.id, user.id));
        const revoked = await sessions.revokeAllForUser(user.id, { exceptSessionId: principal.sessionId, reason: "password_changed", tx });
        await tokens.retireAll(tx, user.id, ["password_reset", "admin_set_password"], "password_set");
        const rotated = await sessions.rotate(principal.sessionId, { tx });
        await deps.audit.record(
          {
            category: "security",
            eventName: "auth.password.changed",
            action: "update",
            outcome: "completed",
            resource: { type: "user", publicId: user.publicId },
            safeCounts: { sessions_revoked: revoked },
            attributes: { forced: user.mustChangePassword },
          },
          tx,
        );
        await deps.mailer.enqueue(
          { template: "auth.password_changed", to: { userId: user.id }, vars: {}, idempotencyKey: `auth.password_changed:${user.publicId}:${deps.clock.now().getTime()}` },
          tx,
        );
        return rotated;
      });
      const { nextStep } = await nextStepFor(principal.userId, principal.sessionId);
      return { issued, nextStep };
    },

    async signOut(principal: SessionPrincipal | null): Promise<void> {
      if (!principal) return;
      await sessions.revoke(principal.sessionId, "logout");
      const event = {
        category: "security" as const,
        eventName: "auth.logout",
        action: "logout",
        outcome: "completed" as const,
        resource: { type: "session", publicId: principal.sessionId },
      };
      try {
        await deps.audit.record(event);
      } catch {
        // Revocation reduces privilege and must not be blocked by audit availability; keep a best-effort note.
        deps.audit.note(event);
      }
    },

    nextStepFor,
  };
}
export type AuthService = ReturnType<typeof createAuthService>;
