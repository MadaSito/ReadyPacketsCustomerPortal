import type { Services } from "../../../server/container.js";
import { conflict, validation } from "../../../server/core/errors.js";
import { clearFactors } from "../../../server/modules/assurance/store.js";
import { emailSchema } from "../../../server/modules/identity/normalize.js";

type RecoveryServices = Pick<Services, "identity" | "assurance" | "db" | "clock" | "audit">;

/**
 * Host-only path. Intentionally bypasses the online last-admin guard: the authorized operator
 * replaces the credential and removes all old factors so that local TOTP must be enrolled again.
 * Do not expose this function through an application route or a background job.
 */
export async function recoverAdministrator(services: RecoveryServices, email: string, confirmation: string) {
  const parsed = emailSchema.safeParse(email);
  if (!parsed.success || confirmation !== parsed.data) {
    throw validation("HOST_RECOVERY_CONFIRMATION_MISMATCH", "The typed email did not match. Nothing was changed.");
  }
  const deny = () => conflict("HOST_RECOVERY_INELIGIBLE", "The email must identify an existing active administrator.");
  const { db, identity, assurance, clock, audit } = services;
  return db.transaction(async (tx) => {
    await assurance.lockLocalAdministratorPolicy(tx);
    const candidate = await identity.findUserIdByEmail(parsed.data, { tx });
    if (!candidate) throw deny();
    const user = await identity.getUserByPublicId(candidate.publicId, { tx, forUpdate: true });
    if (!user || user.email !== parsed.data || user.role !== "admin" || user.status !== "active") throw deny();

    const password = identity.generateTemporaryPassword();
    const { sessionsRevoked } = await identity.recoverLocalAdministratorPassword(user.id, password, { tx });
    await clearFactors(tx, user.id, clock.now());
    await audit.record({
      category: "security",
      eventName: "auth.admin.host_recovery",
      action: "update",
      outcome: "completed",
      severity: "FATAL",
      reasonCode: "HOST_ADMIN_RECOVERY",
      actor: { role: "system" },
      resource: { type: "user", publicId: user.publicId },
      attributes: { actor_type: "host-operator" },
      safeCounts: { sessions_revoked: sessionsRevoked },
    }, tx);
    return { password };
  });
}
