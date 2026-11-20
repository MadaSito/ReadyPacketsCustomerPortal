/**
 * Assurance module — public service surface and factory. Owner: assurance module engineer.
 * Other modules import TYPES from here and reach the instance through `deps.services.assurance` at call time.
 */
import type { ModuleDeps } from "../../container.js";
import type { DbOrTx, ModuleLifecycle, Tx } from "../../core/types.js";
import { createCredentialAdmin } from "./admin.js";
import { createFactorService } from "./factors.js";
import { clearFactors, getState, pruneChallenges } from "./store.js";

export type { SecondFactorInput } from "./input.js";
export type AssuranceState = Awaited<ReturnType<typeof getState>>;
export interface AssuranceModule extends ModuleLifecycle, ReturnType<typeof createFactorService>, ReturnType<typeof createCredentialAdmin> {
  getAssuranceState(userId: number, tx?: DbOrTx): Promise<AssuranceState>;
  resetSecondFactors(userId: number, tx: Tx): Promise<void>;
}

export function createAssuranceModule(deps: ModuleDeps): AssuranceModule {
  deps.jobs.register("assurance.prune_challenges", async (job) => {
    job.signal.throwIfAborted();
    await job.assertStillOwned();
    return { outcome: "completed", safeCounts: { challenges: await pruneChallenges(deps) } };
  });
  deps.jobs.registerSchedule({ name: "assurance.prune_challenges", type: "assurance.prune_challenges", everyMs: 15 * 60_000 });
  return {
    ...createFactorService(deps),
    ...createCredentialAdmin(deps),
    getAssuranceState: (userId, tx) => getState(tx ?? deps.db, userId),
    resetSecondFactors: (userId, tx) => clearFactors(tx, userId, deps.clock.now()),
  };
}
