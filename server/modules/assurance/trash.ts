import { and, eq, isNotNull, or } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import type { TrashParticipant } from "../trash/ports.js";
import { assuranceAccounts, assuranceChallenges, assurancePasskeys, assuranceRecoveryCodes } from "./schema.js";

export function createAssuranceTrashParticipant(deps: ModuleDeps): TrashParticipant {
  return {
    module: "assurance",
    async onTrashedInTx(tx, entity) {
      if (entity.kind !== "customer") return;
      const userId = entity.id;
      // The coordinator already holds the user lock. Keep account → challenge order.
      await tx.update(assuranceAccounts).set({
        pendingTotpSecretEnc: null, pendingTotpSessionId: null, pendingTotpExpiresAt: null,
        updatedAt: deps.clock.now(),
      }).where(and(
        eq(assuranceAccounts.userId, userId),
        or(isNotNull(assuranceAccounts.pendingTotpSecretEnc), isNotNull(assuranceAccounts.pendingTotpSessionId),
          isNotNull(assuranceAccounts.pendingTotpExpiresAt)),
      ));
      await tx.delete(assuranceChallenges).where(eq(assuranceChallenges.userId, userId));
    },
    async purge(entity, run) {
      if (entity.kind !== "customer") return { deleted: {} };
      const userId = entity.id;
      return deps.db.transaction(async (tx) => {
        await run.assertCurrentInTx(tx);
        // The user row becomes a tombstone, so its cascading FKs cannot erase these rows.
        const [account] = await tx.delete(assuranceAccounts).where(eq(assuranceAccounts.userId, userId));
        const [challenges] = await tx.delete(assuranceChallenges).where(eq(assuranceChallenges.userId, userId));
        const [passkeys] = await tx.delete(assurancePasskeys).where(eq(assurancePasskeys.userId, userId));
        const [recoveryCodes] = await tx.delete(assuranceRecoveryCodes).where(eq(assuranceRecoveryCodes.userId, userId));
        return { deleted: {
          assuranceAccounts: account.affectedRows, assuranceChallenges: challenges.affectedRows,
          assurancePasskeys: passkeys.affectedRows, assuranceRecoveryCodes: recoveryCodes.affectedRows,
        } };
      });
    },
  };
}
