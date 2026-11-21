import { eq, sql } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import { conflict } from "../../core/errors.js";
import type { Tx } from "../../core/types.js";
import { assuranceAccounts, assuranceLocalAdminPolicy, assurancePasskeys } from "./schema.js";

export const TOTP_FAILURE_LIMIT = 50;

/** Take before acquiring any users, sessions or assurance-account row locks. */
export async function lockLocalAdministratorPolicy(tx: Tx): Promise<void> {
  await tx.insert(assuranceLocalAdminPolicy).values({ id: 1 })
    .onDuplicateKeyUpdate({ set: { id: sql`${assuranceLocalAdminPolicy.id}` } });
}

async function localMfa(tx: Tx, userId: number, options: { includePasskey?: boolean; lock?: boolean } = {}): Promise<{ usable: boolean; passkey: boolean }> {
  const accountQuery = tx.select({
    secret: assuranceAccounts.totpSecretEnc,
    failures: assuranceAccounts.totpFailures,
  }).from(assuranceAccounts).where(eq(assuranceAccounts.userId, userId)).limit(1);
  const [account] = options.lock === false ? await accountQuery : await accountQuery.for("update");
  if (!account) return { usable: false, passkey: false };
  // A temporary TOTP cooldown does not disqualify an account, but a permanent lock does.
  const totp = account.secret !== null && account.failures < TOTP_FAILURE_LIMIT;
  if (totp && !options.includePasskey) return { usable: true, passkey: false };
  const passkeyQuery = tx.select({ id: assurancePasskeys.id }).from(assurancePasskeys)
    .where(eq(assurancePasskeys.userId, userId)).limit(1);
  const [passkey] = options.lock === false ? await passkeyQuery : await passkeyQuery.for("update");
  return { usable: totp || passkey !== undefined, passkey: passkey !== undefined };
}

function noLocalMfaAdministrator(): never {
  throw conflict("LOCAL_MFA_ADMIN_REQUIRED", "Keep at least one active local administrator with a password and local MFA. Set up another local administrator before making this change.");
}

export function createLocalAdministratorPolicy(deps: ModuleDeps) {
  async function readHealth(tx: Tx): Promise<{ localMfaAdministrators: number; soleLocalMfaAdministratorHasPasskey: boolean | null }> {
    let localMfaAdministrators = 0;
    let soleLocalMfaAdministratorHasPasskey: boolean | null = null;
    for (const id of await deps.services.identity.listLocalAdministratorCandidates(tx, { lock: false })) {
      const { usable, passkey } = await localMfa(tx, id, { includePasskey: true, lock: false });
      if (!usable) continue;
      localMfaAdministrators += 1;
      soleLocalMfaAdministratorHasPasskey = localMfaAdministrators === 1 ? passkey : null;
    }
    return { localMfaAdministrators, soleLocalMfaAdministratorHasPasskey };
  }

  async function wouldLoseLastLocalAdministrator(tx: Tx, userId: number): Promise<boolean> {
    const candidates = await deps.services.identity.listLocalAdministratorCandidates(tx);
    if (!candidates.includes(userId) || !(await localMfa(tx, userId)).usable) return false;
    for (const id of candidates) if (id !== userId && (await localMfa(tx, id)).usable) return false;
    return true;
  }

  return {
    lockLocalAdministratorPolicy,
    wouldLoseLastLocalAdministrator,
    /** Read-only and identifier-free. Callers already holding user locks must pass their transaction. */
    async breakGlassHealth(tx?: Tx) {
      return tx ? readHealth(tx) : deps.db.transaction(readHealth);
    },
    /** Strict readiness check for SSO enablement; lock the policy first. */
    async assertLocalAdministratorRemains(tx: Tx, excludingUserId?: number): Promise<void> {
      for (const id of await deps.services.identity.listLocalAdministratorCandidates(tx)) {
        if (id !== excludingUserId && (await localMfa(tx, id)).usable) return;
      }
      noLocalMfaAdministrator();
    },
    /**
     * Check before removing an account's local sign-in or all its local factors. A reduction affecting a
     * non-candidate does not prevent repairing a legacy installation that has no eligible administrator yet.
     */
    async assertLocalAdministratorMayLoseAccess(tx: Tx, userId: number): Promise<void> {
      if (await wouldLoseLastLocalAdministrator(tx, userId)) noLocalMfaAdministrator();
    },
  };
}
