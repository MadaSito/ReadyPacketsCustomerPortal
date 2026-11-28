/**
 * Public account flows: registration, sign-in, e-mail verification, password reset, invitation activation,
 * change password, sign-out. Uniform responses + timing; no account enumeration.
 */
import { isLiveUserRow } from "./live.js";
import { and, eq, sql } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import { DomainError, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { AuditEventInput, SessionPrincipal, Tx } from "../../core/types.js";
import type { TransitionStep, UserRole } from "../../../shared/domain.js";
import { readSetting } from "../platform/settingsRegistry.js";
import { deriveNameParts, fullNameOf, greetingNameOf, normalizeEmail, normalizeName, type NameInput, type NameParts } from "./normalize.js";
import type { BillingDetails } from "../../../shared/billingDetails.js";
import type { PasswordHasher } from "./password/hasher.js";
import { checkPassword, PASSWORD_MESSAGES } from "./password/policy.js";
import { users, type UserRow } from "./schema.js";
import type { IssuedSession, SessionService } from "./sessions.js";
import { REGISTRATION_ENABLED, RESEND_MIN_INTERVAL_MS } from "./settings.js";
import type { TokenService } from "./tokens.js";
import type { TransitionService } from "./transitions.js";
import type { Gates } from "./gates.js";
import type { SignInLog } from "./sessionPolicy.js";
import { createSignInSignals, type SignInSignalKind } from "./signals.js";
import { emailColumns, emailIndexOf, generateCustomerRef, isDuplicate, nameColumns, namePartColumns, toView, type UserRepo } from "./users.js";

/** D4 port (billingProfile module, compliance_engineer). Uses the caller's transaction; no mail. */
export interface RegistrationBillingPort {
  saveForUserInTx(tx: Tx, userId: number, details: BillingDetails, actor: { userId: number; role: "customer"; via: "registration" }): Promise<unknown>;
}

export const PASSWORD_RESET_JOB = "identity.password_reset.dispatch";
export interface PasswordResetJob {
  /** Blind index only — never the address, never auth material. */
  emailIndex: string;
  /**
   * D2.8: the immutable id the address belonged to AT INTAKE (null = no account then). Dispatch serves only that
   * account, so a request queued before a purge never reaches an account registered later on the freed address
   * (it inherits nothing). Missing on jobs queued before this field existed → refused (fail closed).
   */
  userId?: number | null;
}

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
  gates: Gates;
  signInLog: SignInLog;
}

export function assertPasswordAcceptable(password: string, context: { email?: string | null; name?: string | null }): void {
  const rejection = checkPassword(password, context);
  if (rejection) throw validation(rejection, PASSWORD_MESSAGES[rejection], { field: "password" });
}

export function createAuthService(i: AuthInternals) {
  const signals = createSignInSignals(i.deps);
  /** D7: run a credential step, then (after commit/rollback, never inside the tx) publish its signal. */
  async function signalled<T>(
    kind: SignInSignalKind,
    account: { email?: string; userId?: number | null },
    isCredentialFailure: (error: unknown) => boolean,
    run: () => Promise<T>,
    successUserId?: (result: T) => number | null | undefined,
  ): Promise<T> {
    let result: T;
    try {
      result = await run();
    } catch (error) {
      if (isCredentialFailure(error)) {
        if (account.email) await signals.forEmail(kind, "failure", account.email);
        else await signals.publish({ kind, outcome: "failure", userId: account.userId ?? null });
      }
      throw error;
    }
    if (account.email) await signals.forEmail(kind, "success", account.email);
    else await signals.publish({ kind, outcome: "success", userId: successUserId?.(result) ?? account.userId ?? null });
    return result;
  }
  const accountRefAttr = (email: string): { account_ref?: string } => {
    const ref = signals.accountRefForEmail(email);
    return ref ? { account_ref: ref } : {};
  };
  const isReason = (...codes: string[]) => (error: unknown) => error instanceof DomainError && codes.includes(error.reasonCode);
  const { deps, hasher, repo, tokens, sessions, transitions, gates, signInLog } = i;
  const preview = (path: string) => (deps.config.deploymentProfile === "preview" ? { previewLink: path } : {});

  // Throttle refusals leave a sampled best-effort note: at most one per (category, subject) per minute, so an
  // attacker cannot flood the audit trail. The subject key (a blind index or public id) is never recorded.
  const throttleNotes = new Map<string, number>();
  async function throttle(category: "user_login" | "auth_high_risk", key: string): Promise<void> {
    const verdict = await deps.rateLimiter.consume(category, key);
    if (verdict.allowed) return;
    const now = deps.clock.now().getTime();
    const slot = `${category}:${key}`;
    const last = throttleNotes.get(slot);
    if (last === undefined || now - last >= 60_000 || now < last) {
      if (throttleNotes.size >= 4096) throttleNotes.clear();
      throttleNotes.set(slot, now);
      deps.audit.note({
        category: "security", eventName: "auth.rate_limited", action: "request", outcome: "denied", severity: "WARN",
        reasonCode: "RATE_LIMITED", attributes: { category, subject: key.slice(0, key.indexOf(":")) },
      });
    }
    throw rateLimited(verdict.retryAfterSeconds);
  }

  /** Sampled (≤ 1 per minute per process) sign-in-log row for login throttling; no subject is stored. */
  let lastLockNote = -Infinity;
  function noteLock(): void {
    const now = deps.clock.now().getTime();
    if (now - lastLockNote < 60_000 && now >= lastLockNote) return;
    lastLockNote = now;
    void signInLog.note({ kind: "lock", reasonCode: "RATE_LIMITED", authMethod: "local" });
  }

  /** Sign-in log + audit for a refusal raised by a gate or restriction (after the transaction rolled back). */
  async function noteRefusal(error: unknown, user: Pick<UserRow, "id" | "role" | "publicId">, authMethod: "local" | "entra"): Promise<void> {
    if (!(error instanceof DomainError)) return;
    const code = error.reasonCode === "SESSION_RESTRICTED" ? String((error.details as { restriction?: string } | undefined)?.restriction ?? "SESSION_RESTRICTED") : error.reasonCode;
    if (error.reasonCode !== "SESSION_RESTRICTED" && error.reasonCode !== "CUSTOMER_MAINTENANCE") return;
    await signInLog.note({ kind: "refused", reasonCode: code, userId: user.id, role: user.role, authMethod });
    const event: AuditEventInput = {
      category: "security", eventName: "auth.login.refused", action: "login", outcome: "denied", severity: "WARN",
      reasonCode: code, actor: { role: "anonymous" }, resource: { type: "user", publicId: user.publicId }, attributes: { auth_method: authMethod },
    };
    try {
      await deps.audit.record(event);
    } catch {
      deps.audit.note(event);
    }
  }

  /**
   * Runs `work` (normally one transaction) and, when it fails with an error `describe` recognises, records the
   * denial durably AFTER the rollback — outside the failed tx, so the event survives it. The original error is
   * always rethrown; if the durable write itself fails the event degrades to a best-effort note.
   */
  async function recordDenial<T>(work: () => Promise<T>, describe: (error: unknown) => AuditEventInput | null): Promise<T> {
    try {
      return await work();
    } catch (error) {
      const event = describe(error);
      if (event) {
        try {
          await deps.audit.record(event);
        } catch {
          deps.audit.note(event);
        }
      }
      throw error;
    }
  }
  const linkRejected = (purpose: "verify_email" | "password_reset" | "activation") => (error: unknown): AuditEventInput | null =>
    error instanceof DomainError && error.reasonCode === "LINK_INVALID"
      ? {
          category: "security", eventName: "auth.token.rejected", action: "verify", outcome: "denied", severity: "WARN",
          reasonCode: "LINK_INVALID", actor: { role: "anonymous" }, attributes: { purpose, ...(purpose === "verify_email" ? {} : { step: "password_reset" }) },
        }
      : null;
  const racedLogins = new WeakSet<Error>();

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
      /** Legacy single display name (portable import, seeds, older callers): parts are derived lazily. */
      name?: string;
      /** Increment 08 (D1): stored encrypted; name_enc becomes "<First> <Last>". Wins over `name`. */
      nameParts?: NameParts;
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
          ...(input.nameParts ? namePartColumns(deps.crypto, publicId, input.nameParts) : nameColumns(deps.crypto, publicId, input.name ?? "")),
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

  /**
   * Service-internal provisioning for ops scripts (create-admin, demo seed). NOT exposed on tRPC/HTTP.
   * Creates an ACTIVE, e-mail-verified local account (policy-checked Argon2id hash); no session; MFA not
   * enrolled, so the first sign-in still forces enrolment. Audited as `system` in the caller's tx.
   *  - bootstrap_admin: refuses with CONFLICT ADMIN_EXISTS if an active administrator exists. Serialized
   *    across processes by a per-database named lock held across check + insert; the active-admin set is
   *    read with FOR UPDATE (a concurrent uncommitted insert blocks that read until it commits).
   *  - demo_seed: refused in the production profile.
   */
  async function provisionLocalAccount(
    input: { email: string; name: string; role: UserRole; password: string; mustChangePassword: boolean; customerRef?: string | null },
    opts: { tx: Tx; reason: "bootstrap_admin" | "demo_seed" },
  ): Promise<{ userId: number; publicId: string; customerRef: string | null }> {
    const { tx, reason } = opts;
    if (reason === "demo_seed" && deps.config.deploymentProfile === "production") {
      throw new DomainError("FORBIDDEN", "DEMO_SEED_FORBIDDEN", "Demo accounts cannot be created in production.");
    }
    if (reason === "bootstrap_admin" && input.role !== "admin") {
      throw validation("BOOTSTRAP_ROLE_INVALID", "The bootstrap account must be an administrator.");
    }
    const email = normalizeEmail(input.email);
    assertPasswordAcceptable(input.password, { email, name: input.name });
    const passwordHash = await hasher.hash(input.password); // before any lock
    let named = false;
    try {
      if (reason === "bootstrap_admin") {
        const [rows] = (await tx.execute(sql`SELECT GET_LOCK(CONCAT('rp.identity.bootstrap.', DATABASE()), 15) AS got`)) as unknown as [{ got: number | null }[]];
        if (Number(rows[0]?.got) !== 1) throw new DomainError("CONFLICT", "BOOTSTRAP_BUSY", "Another administrator bootstrap is in progress. Try again.");
        named = true;
        if ((await repo.countActiveAdmins(tx)) > 0) {
          throw new DomainError("CONFLICT", "ADMIN_EXISTS", "An active administrator already exists. Use the console to add administrators.");
        }
      }
      const created = await insertUser(tx, {
        email,
        name: input.name,
        role: input.role,
        status: "active",
        origin: reason,
        passwordHash,
        customerRef: input.customerRef ?? null,
        emailVerifiedAt: deps.clock.now(),
      });
      if (input.mustChangePassword) await tx.update(users).set({ mustChangePassword: true }).where(eq(users.id, created.id));
      await deps.audit.record(
        {
          category: "security",
          eventName: "identity.account.provisioned",
          action: "create",
          outcome: "completed",
          actor: { role: "system" },
          resource: { type: "user", publicId: created.publicId },
          attributes: { reason, role: input.role, must_change_password: input.mustChangePassword },
        },
        tx,
      );
      return { userId: created.id, publicId: created.publicId, customerRef: created.customerRef };
    } finally {
      if (named) await tx.execute(sql`SELECT RELEASE_LOCK(CONCAT('rp.identity.bootstrap.', DATABASE()))`).catch(() => undefined);
    }
  }

  /** D4: the billingProfile port, read at call time (the module may be absent, e.g. in tests). */
  async function saveRegistrationBilling(tx: Tx, userId: number, details: BillingDetails): Promise<boolean> {
    const port = (deps.services as { billingProfile?: RegistrationBillingPort }).billingProfile;
    if (!port?.saveForUserInTx) return false;
    await port.saveForUserInTx(tx, userId, details, { userId, role: "customer", via: "registration" });
    return true;
  }

  return {
    insertUser,
    claimNewRef,
    provisionLocalAccount,

    async register(
      input: NameInput & { email: string; password: string; referralCode?: string; billing?: BillingDetails | null },
      meta: CallMeta,
    ): Promise<{ accepted: true; previewLink?: string }> {
      if (!(await readSetting(deps.settings, REGISTRATION_ENABLED))) {
        throw new DomainError("FORBIDDEN", "REGISTRATION_DISABLED", "New account registration is currently closed.");
      }
      // Customer maintenance (package E) refuses registration before any account lookup (reveals nothing).
      await gates.assertCustomerAccess();
      const email = normalizeEmail(input.email);
      await throttle("auth_high_risk", `register:${emailIndexOf(deps.crypto, email)}`);
      // Policy is checked before any existence lookup, so its outcome reveals nothing about accounts.
      // Legacy `name` callers (pre-08 clients): the display name is stored as given and parts are derived lazily.
      const name = input.nameParts ? fullNameOf(input.nameParts) : normalizeName(input.name);
      const greetingParts = input.nameParts ?? deriveNameParts(name);
      assertPasswordAcceptable(input.password, { email, name });
      const passwordHash = await hasher.hash(input.password); // always hash: uniform timing
      // Increment 09 (D2.2): a trashed account keeps its address reserved, so the lookup includes it. It is
      // answered exactly like an existing account, but it receives no mail (trashed accounts get none).
      const existing = await repo.byEmail(email, { includeGone: true });
      if (existing) {
        const gone = !isLiveUserRow(existing);
        // Same shape of work as the create branch (one transaction, one mail enqueue, one audit row) so the
        // response and its timing do not distinguish existing addresses (review ID-04). Residual timing
        // differences (row insert vs none) are documented in VERIFICATION.md as not benchmarked.
        await deps.db.transaction(async (tx) => {
          if (!gone) await deps.mailer.enqueue(
            {
              template: "auth.account_exists",
              to: { userId: existing.id },
              vars: { signInLink: `${deps.config.canonicalOrigin}/sign-in`, resetLink: `${deps.config.canonicalOrigin}/forgot-password` },
              idempotencyKey: `auth.account_exists:${existing.publicId}:${Math.floor(deps.clock.now().getTime() / 3_600_000)}`,
            },
            tx,
          );
          await deps.audit.record(
            {
              category: "security",
              eventName: "auth.register.requested",
              action: "register",
              outcome: "refused",
              reasonCode: gone ? "TRASHED_ACCOUNT" : "EXISTING_ACCOUNT",
              actor: { role: "anonymous" },
              resource: { type: "user", publicId: existing.publicId },
            },
            tx,
          );
        });
        return { accepted: true };
      }
      try {
        return await deps.db.transaction(async (tx) => {
          await gates.assertCustomerAccess(tx);
          const created = await insertUser(tx, { email, ...(input.nameParts ? { nameParts: input.nameParts } : { name }), role: "customer", status: "active", origin: "register", passwordHash });
          // D4 (increment 08): optional billing information, stored ONLY for a new account, in this transaction. It was
          // validated in full before any lookup, so neither branch can fail differently on it. Missing module → skipped.
          const billingSaved = input.billing ? await saveRegistrationBilling(tx, created.id, input.billing) : false;
          const referral = await gates.attributeReferral(input.referralCode, created.id, tx);
          const link = await tokens.issue(tx, created.id, "verify_email");
          await deps.mailer.enqueue(
            { template: "auth.verify_email", to: { userId: created.id }, vars: { name: greetingNameOf(greetingParts, name), link: link.url }, idempotencyKey: link.mailKey, expiresAt: link.expiresAt },
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
              attributes: { referral: input.referralCode ? (referral.attributed ? "attributed" : "not_attributed") : "none", billing: input.billing ? (billingSaved ? "saved" : "skipped") : "none" },
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
      // D7: bad password / unknown account / raced credential ⇒ failure signal; throttle and gate refusals are not.
      return signalled("password", { email: input.email }, isReason("BAD_CREDENTIALS"), async () => {
      const email = normalizeEmail(input.email);
      try {
        await throttle("user_login", `acct:${emailIndexOf(deps.crypto, email)}`);
      } catch (error) {
        if (error instanceof DomainError && error.reasonCode === "RATE_LIMITED") noteLock();
        throw error;
      }
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
          attributes: { step: "password", ...accountRefAttr(email) },
        });
        await signInLog.note({ kind: "failure", reasonCode: reason ?? "UNKNOWN_ACCOUNT", userId: user?.id ?? null, role: user?.role ?? null, authMethod: "local" });
        throw badCredentials();
      }
      if (user.role === "customer") {
        try {
          await gates.assertCustomerAccess();
        } catch (error) {
          await noteRefusal(error, user, "local");
          throw error;
        }
      }
      const result = await recordDenial(() => deps.db.transaction(async (tx) => {
        const locked = await repo.byId(user.id, { tx, forUpdate: true });
        if (!locked || locked.status !== "active" || locked.passwordHash !== user.passwordHash) {
          const raced = badCredentials();
          racedLogins.add(raced);
          throw raced;
        }
        if (locked.passwordHash && hasher.needsRehash(locked.passwordHash)) {
          // Compare-and-set on the hash we verified against (review ID-01).
          await tx
            .update(users)
            .set({ passwordHash: await hasher.hash(input.password) })
            .where(and(eq(users.id, user.id), eq(users.passwordHash, locked.passwordHash), eq(users.status, "active")));
        }
        // Authoritative maintenance check after the users row lock (package E lock order).
        if (locked.role === "customer") await gates.assertCustomerAccess(tx);
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
            attributes: { next_step: steps[0] ?? "none", auth_method: "local", step: "password", ...accountRefAttr(email) },
          },
          tx,
        );
        return { ...created, nextStep: steps[0] ?? null };
      }), (error) => error instanceof Error && racedLogins.has(error)
        ? {
            category: "security", eventName: "auth.login.failed", action: "login", outcome: "denied", severity: "WARN",
            reasonCode: "CREDENTIAL_CHANGED_CONCURRENTLY", actor: { role: "anonymous" }, resource: { type: "user", publicId: user.publicId },
            attributes: { step: "password", ...accountRefAttr(email) },
          }
        : null).catch(async (error: unknown) => {
          await noteRefusal(error, user, "local");
          throw error;
        });
      return { issued: result.issued, nextStep: result.nextStep, sessionId: result.sessionId, userId: user.id };
      });
    },

    async verifyEmail(token: string, session: SessionPrincipal | null): Promise<{ verified: true; issued?: IssuedSession }> {
      return recordDenial(() => deps.db.transaction(async (tx) => {
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
      }), linkRejected("verify_email"));
    },

    async resendVerification(principal: SessionPrincipal): Promise<{ accepted: true; previewLink?: string }> {
      await throttle("auth_high_risk", `verify:${principal.userPublicId}`);
      return deps.db.transaction(async (tx) => {
        // Eligibility + cooldown are decided under the users row lock (review ID-03).
        const user = await repo.byId(principal.userId, { tx, forUpdate: true });
        if (!user || user.status !== "active" || user.emailVerifiedAt !== null) return { accepted: true as const };
        const last = await tokens.lastIssuedAt(tx, user.id, "verify_email");
        if (last && deps.clock.now().getTime() - last.getTime() < RESEND_MIN_INTERVAL_MS) return { accepted: true as const };
        const view = toView(deps.crypto, user);
        const link = await tokens.issue(tx, user.id, "verify_email");
        await deps.mailer.enqueue(
          { template: "auth.verify_email", to: { userId: user.id }, vars: { name: view.greetingName ?? view.name, link: link.url }, idempotencyKey: link.mailKey, expiresAt: link.expiresAt },
          tx,
        );
        await deps.audit.record(
          { category: "security", eventName: "auth.email.verification_sent", action: "notify", outcome: "completed", resource: { type: "user", publicId: user.publicId } },
          tx,
        );
        // Authenticated caller, own account: preview may return its own verification link.
        return { accepted: true as const, ...preview(link.path) };
      });
    },

    /**
     * Public "forgot password". Identical work and response for every address (review ID-04): throttle, one
     * durable job keyed only by the e-mail blind index, one `attempted` audit row. Eligibility, cooldown,
     * token issuance and mail happen in the job under the users row lock. Never returns a link (ID-02).
     */
    async requestPasswordReset(input: { email: string }): Promise<{ accepted: true }> {
      const emailIndex = emailIndexOf(deps.crypto, normalizeEmail(input.email));
      await throttle("auth_high_risk", `reset:${emailIndex}`);
      const slot = Math.floor(deps.clock.now().getTime() / RESEND_MIN_INTERVAL_MS);
      // Durable intake and its audit row commit together (audit failure ⇒ no accepted work).
      await deps.db.transaction(async (tx) => {
        // The same single indexed read for every address (gone accounts included: they are refused at dispatch).
        const [owner] = await tx.select({ id: users.id }).from(users).where(eq(users.emailIndex, emailIndex)).limit(1);
        await deps.jobs.enqueue<PasswordResetJob>(PASSWORD_RESET_JOB, { emailIndex, userId: owner?.id ?? null }, { idempotencyKey: `${emailIndex}:${slot}`, maxAttempts: 3 }, tx);
        await deps.audit.record(
          {
            category: "security",
            eventName: "auth.password.reset_requested",
            action: "request",
            outcome: "attempted",
            actor: { role: "anonymous" },
            resource: { type: "user" },
          },
          tx,
        );
      });
      return { accepted: true };
    },

    /** Job handler for PASSWORD_RESET_JOB. Pure database work in one transaction ⇒ retry-safe. */
    async dispatchPasswordReset(payload: PasswordResetJob): Promise<"issued" | "ineligible" | "cooldown"> {
      if (!/^[0-9a-f]{64}$/.test(payload.emailIndex)) return "ineligible";
      // Resolve the id OUTSIDE the transaction, so the transaction's first statement is the locking read of
      // the users row: under REPEATABLE READ the read view (used by the cooldown query) is then created only
      // after the lock is held, and therefore sees any token committed by a concurrent dispatch (review ID-03).
      // D2.8: bound to the account that owned the address at intake (never re-resolved by address).
      const boundId = typeof payload.userId === "number" && Number.isSafeInteger(payload.userId) && payload.userId > 0 ? payload.userId : null;
      return deps.db.transaction(async (tx) => {
        const locked = boundId !== null ? await repo.byId(boundId, { tx, forUpdate: true }) : null;
        const user = locked && locked.emailIndex === payload.emailIndex ? locked : null; // re-validated under lock
        if (!user || user.status !== "active" || user.authSource !== "local") {
          await deps.audit.record(
            {
              category: "security",
              eventName: "auth.password.reset_dispatch",
              action: "request",
              outcome: "refused",
              reasonCode: user ? "ACCOUNT_NOT_ELIGIBLE" : "UNKNOWN_ACCOUNT",
              actor: { role: "system" },
              resource: user ? { type: "user", publicId: user.publicId } : { type: "user" },
            },
            tx,
          );
          return "ineligible" as const;
        }
        const last = await tokens.lastIssuedAt(tx, user.id, "password_reset");
        if (last && deps.clock.now().getTime() - last.getTime() < RESEND_MIN_INTERVAL_MS) return "cooldown" as const;
        const link = await tokens.issue(tx, user.id, "password_reset");
        await deps.mailer.enqueue(
          { template: "auth.password_reset", to: { userId: user.id }, vars: { link: link.url }, idempotencyKey: link.mailKey, expiresAt: link.expiresAt },
          tx,
        );
        await deps.audit.record(
          {
            category: "security",
            eventName: "auth.password.reset_dispatch",
            action: "request",
            outcome: "completed",
            actor: { role: "system" },
            resource: { type: "user", publicId: user.publicId },
          },
          tx,
        );
        return "issued" as const;
      });
    },

    /** Redeems a password_reset or admin_set_password link. Revokes ALL sessions; MFA is still required at sign-in. */
    async resetPassword(input: { token: string; password: string }): Promise<{ reset: true }> {
      let resetUserId: number | null = null;
      return signalled("password_reset", {}, isReason("LINK_INVALID"), async () => {
      const passwordHash = await (async () => {
        // Hash outside the lock only after a cheap shape check; policy is checked inside with user context.
        return hasher.hash(input.password);
      })();
      await recordDenial(() => deps.db.transaction(async (tx) => {
        const consumed = await tokens.consume(tx, input.token, ["password_reset", "admin_set_password"]);
        if (!consumed || consumed.user.status !== "active" || consumed.user.authSource !== "local") throw invalidLink();
        resetUserId = consumed.user.id;
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
            attributes: { mode: consumed.purpose, step: "password_reset", ...accountRefAttr(view.email) },
          },
          tx,
        );
        await deps.mailer.enqueue(
          { template: "auth.password_changed", to: { userId: consumed.user.id }, vars: {}, idempotencyKey: `auth.password_changed:${consumed.user.publicId}:${deps.clock.now().getTime()}` },
          tx,
        );
      }), linkRejected("password_reset"));
      return { reset: true as const };
      }, () => resetUserId);
    },

    async activateAccount(input: { token: string; password: string }): Promise<{ activated: true }> {
      let activatedUserId: number | null = null;
      return signalled("password_reset", {}, isReason("LINK_INVALID"), async () => {
      const passwordHash = await hasher.hash(input.password);
      await recordDenial(() => deps.db.transaction(async (tx) => {
        const consumed = await tokens.consume(tx, input.token, ["invitation"]);
        if (!consumed || consumed.user.status !== "pending_activation") throw invalidLink();
        activatedUserId = consumed.user.id;
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
      }), linkRejected("activation"));
      return { activated: true as const };
      }, () => activatedUserId);
    },

    /** Change password: full session, or a remediation session whose NEXT step is change_password. */
    async changePassword(principal: SessionPrincipal, input: { currentPassword: string; newPassword: string }): Promise<{ issued: IssuedSession; nextStep: TransitionStep | null }> {
      if (principal.state !== "full" && principal.pendingSteps[0] !== "change_password") {
        throw new DomainError("REMEDIATION_REQUIRED", "ACCOUNT_STEP_PENDING", "Please finish securing your account to continue.", {
          nextStep: principal.pendingSteps[0] ?? "unknown",
        });
      }
      await throttle("auth_high_risk", `pwchange:${principal.userPublicId}`);
      const issued = await signalled("password", { userId: principal.userId }, isReason("CURRENT_PASSWORD_INCORRECT"), () => recordDenial(() => deps.db.transaction(async (tx) => {
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
      }), (error) => error instanceof DomainError && error.reasonCode === "CURRENT_PASSWORD_INCORRECT"
        ? {
            category: "security", eventName: "auth.password.change_denied", action: "update", outcome: "denied", severity: "WARN",
            reasonCode: "CURRENT_PASSWORD_INCORRECT", actor: { userId: principal.userId, role: principal.role },
            resource: { type: "user", publicId: principal.userPublicId }, attributes: { step: "password" },
          }
        : null));
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
    noteRefusal,
  };
}
export type AuthService = ReturnType<typeof createAuthService>;
