import { roleHasCapability } from "../../../shared/capabilities.js";
import type { ModuleDeps } from "../../container.js";
import { conflict, DomainError, forbidden, notFound } from "../../core/errors.js";
import type { SessionPrincipal, Tx } from "../../core/types.js";
import type { AdminCredentialInput } from "./input.js";
import { assertCurrent, requireFresh, throttle } from "./policy.js";
import { clearFactors } from "./store.js";

type IdentityUser = NonNullable<Awaited<ReturnType<ModuleDeps["services"]["identity"]["getUserByPublicId"]>>>;
const capability = "customers.credentials.administer";
const ok = { ok: true } as const;

export function createCredentialAdmin(deps: ModuleDeps) {
  async function deny(actor: SessionPrincipal, reasonCode: string, targetPublicId?: string) {
    await deps.audit.record({
      eventName: "admin.credentials.denied", category: "security", action: "authorize",
      outcome: "denied", severity: "WARN", reasonCode, actor: { userId: actor.userId, role: actor.role },
      resource: { type: "user", publicId: targetPublicId },
    });
  }

  function authorize(actor: SessionPrincipal) {
    if (!roleHasCapability(actor.role, capability)) throw forbidden("CAPABILITY_NOT_GRANTED");
    requireFresh(actor, deps.clock.now());
  }

  async function scope<T>(
    actor: SessionPrincipal, customerId: string, work: (tx: Tx, target: IdentityUser) => Promise<T>,
  ): Promise<T> {
    try {
      authorize(actor);
      if (actor.userPublicId === customerId) throw forbidden("CANNOT_ADMINISTER_SELF");
      await throttle(deps, actor.userId);
      const identity = deps.services.identity;
      // This lookup only establishes lock order. Re-read the target authoritatively under lock.
      const candidate = await identity.getUserByPublicId(customerId);
      if (!candidate || (candidate.role === "admin" && actor.role !== "admin")) throw notFound("USER_NOT_FOUND");
      return await deps.db.transaction(async (tx) => {
        // Two admins acting on one another must not acquire user locks in opposite order.
        if (actor.userId < candidate.id) await assertCurrent(deps, actor, tx);
        const target = await identity.getUserByPublicId(customerId, { tx, forUpdate: true });
        if (!target || target.id !== candidate.id || (target.role === "admin" && actor.role !== "admin"))
          throw notFound("USER_NOT_FOUND");
        if (actor.userId > candidate.id) await assertCurrent(deps, actor, tx);
        authorize(actor);
        if (target.authSource !== "local") throw conflict("LOCAL_ACCOUNT_REQUIRED", "This account uses an external identity provider.");
        if (target.status !== "active")
          throw conflict("TARGET_ACCOUNT_NOT_ACTIVE", "Credential administration is available only for active accounts.");
        return work(tx, target);
      });
    } catch (error) {
      if (error instanceof DomainError
        && ["NOT_FOUND", "FORBIDDEN", "STEP_UP_REQUIRED", "CONFLICT", "NOT_CONFIGURED"].includes(error.code)) {
        await deny(actor, error.reasonCode, customerId);
      }
      throw error;
    }
  }

  return {
    async administerCredential(actor: SessionPrincipal, input: AdminCredentialInput): Promise<{ ok: true; temporaryPassword?: string }> {
      return scope(actor, input.customerId, async (tx, target) => {
        const identity = deps.services.identity;
        if (input.mode === "email_link") {
          if (!target.emailVerified) throw conflict("TARGET_EMAIL_UNVERIFIED", "Set-password email requires a verified address.");
          if (!(await deps.services.integrations.smtp.getReadiness()).ready) {
            throw new DomainError("NOT_CONFIGURED", "SMTP_NOT_READY", "Set-password email is unavailable. Configure email delivery or use a temporary password.");
          }
        }
        await identity.sessions.revokeAllForUser(target.id, { reason: "ADMIN_CREDENTIAL_CHANGE", tx });
        let generatedPassword: string | undefined;
        if (input.mode === "email_link") {
          // Never pass an emailed reset link back to the administrator, even in preview.
          await identity.issueAdminSetPasswordLink(target.id, { tx });
        } else {
          if (input.mode === "generate_temporary") generatedPassword = identity.generateTemporaryPassword();
          const password = input.mode === "enter_temporary" ? input.password : generatedPassword!;
          await identity.setPassword(target.id, password, { mustChange: true, tx });
        }
        await deps.audit.record({
          category: "admin", eventName: input.mode === "email_link" ? "admin.credentials.set_link_queued"
            : input.mode === "generate_temporary" ? "admin.credentials.temporary_generated" : "admin.credentials.temporary_set",
          action: "update", outcome: "completed", actor: { role: actor.role, userId: actor.userId },
          resource: { type: "user", publicId: target.publicId },
        }, tx);
        await deps.services.engagement.notify({
          userId: target.id, kind: "security.credential_changed", title: "Your password was changed by an administrator",
          body: "An administrator started a password change for your ReadyPackets account and signed out your sessions. Contact support if this was unexpected.",
          link: "/account/security", skipEmail: input.mode === "email_link",
        }, tx);
        return generatedPassword ? { ...ok, temporaryPassword: generatedPassword } : ok;
      });
    },
    async resetMfa(actor: SessionPrincipal, customerId: string) {
      return scope(actor, customerId, async (tx, target) => {
        await deps.services.identity.sessions.revokeAllForUser(target.id, { reason: "ADMIN_MFA_RESET", tx });
        await clearFactors(tx, target.id, deps.clock.now());
        await deps.audit.record({
          category: "admin", eventName: "admin.credentials.mfa_reset", action: "update", outcome: "completed",
          actor: { role: actor.role, userId: actor.userId }, resource: { type: "user", publicId: target.publicId },
        }, tx);
        await deps.services.engagement.notify({
          userId: target.id, kind: "security.mfa_reset", title: "Your authentication factors were reset",
          body: "An administrator reset your authenticators and signed out your sessions. Set up a new authenticator app at your next sign-in. Contact support if this was unexpected.",
          link: "/account/security",
        }, tx);
        return ok;
      });
    },
  };
}
