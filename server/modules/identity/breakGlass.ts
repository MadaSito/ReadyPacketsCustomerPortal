/**
 * Break-glass support for the assurance local-administrator invariant (increment 03, decision 3).
 * Owner: identity engineer. Consumed by assurance (policy) and scripts/ops/recover-admin.ts (via assurance).
 */
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { DomainError, notFound } from "../../core/errors.js";
import type { Tx } from "../../core/types.js";
import type { AuthInternals } from "./auth.js";
import { assertPasswordAcceptable } from "./auth.js";
import { sessionRestrictions, users } from "./schema.js";
import { toView } from "./users.js";

export function createBreakGlassService(i: AuthInternals) {
  const { deps, hasher, repo, sessions, tokens } = i;
  return {
    /**
     * Active administrators that can sign in LOCALLY: authSource local, verified e-mail, a usable password.
     * Locking read in ascending id order. The caller (assurance) must hold lockLocalAdministratorPolicy.
     * An SSO link does not disqualify an account — local sign-in stays available alongside it.
     */
    async listLocalAdministratorCandidates(tx: Tx, options: { lock?: boolean } = {}): Promise<number[]> {
      const query = tx
        .select({ id: users.id })
        .from(users)
        .where(and(
          eq(users.role, "admin"), eq(users.status, "active"), eq(users.authSource, "local"),
          isNotNull(users.emailVerifiedAt), isNotNull(users.passwordHash),
        ))
        .orderBy(asc(users.id));
      // Default: locking read (policy mutations). `{ lock: false }`: plain read for read-only health views.
      const rows = options.lock === false ? await query : await query.for("update");
      return rows.map((row) => row.id);
    },

    /**
     * Host recovery (ops only; never on tRPC/HTTP): re-establishes a local password for an existing ACTIVE
     * administrator, forces a password change, revokes every session and retires outstanding password /
     * invitation links. Any Entra link is left untouched; SSO sign-in is refused while the forced change is
     * pending, so local MFA enrolment cannot be skipped through a trusted Entra assertion.
     */
    async recoverLocalAdministratorPassword(userId: number, password: string, opts: { tx: Tx }): Promise<{ sessionsRevoked: number }> {
      const tx = opts.tx;
      const user = await repo.byId(userId, { tx, forUpdate: true });
      if (!user) throw notFound("USER_NOT_FOUND");
      if (user.role !== "admin" || user.status !== "active") {
        throw new DomainError("CONFLICT", "NOT_ACTIVE_ADMINISTRATOR", "Only an active administrator can be recovered.");
      }
      const view = toView(deps.crypto, user);
      assertPasswordAcceptable(password, { email: view.email, name: view.name });
      const passwordHash = await hasher.hash(password);
      const now = deps.clock.now();
      await tx
        .update(users)
        .set({ passwordHash, passwordChangedAt: now, mustChangePassword: true, authSource: "local", version: user.version + 1 })
        .where(eq(users.id, user.id));
      const revoked = await sessions.revokeAllForUser(user.id, { reason: "host_recovery", tx });
      // Increment 04: host recovery also switches session restrictions off (users → restrictions lock order),
      // so a recovered administrator can always sign in from wherever the host operator is.
      const [restricted] = (await tx.update(sessionRestrictions).set({ enabled: false, updatedAt: now }).where(and(eq(sessionRestrictions.id, 1), eq(sessionRestrictions.enabled, true)))) as unknown as [{ affectedRows?: number }];
      await tokens.retireAll(tx, user.id, ["password_reset", "admin_set_password", "invitation"], "host_recovery");
      await deps.audit.record(
        {
          category: "security", eventName: "identity.admin.local_password_recovered", action: "update", outcome: "completed",
          actor: { role: "system" }, resource: { type: "user", publicId: user.publicId },
          safeCounts: { sessions_revoked: revoked }, attributes: { auth_source_reset: user.authSource !== "local", session_restrictions_disabled: (restricted?.affectedRows ?? 0) > 0 },
        },
        tx,
      );
      return { sessionsRevoked: revoked };
    },
  };
}
