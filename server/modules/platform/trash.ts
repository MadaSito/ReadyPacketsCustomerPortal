/**
 * Increment 09 (D2.5/D2.6): the platform module's trash participant. Owner: platform module engineer.
 * Permanent deletion of a customer unlinks the account from its cookie-consent records (`consent.forgetUser`);
 * the anonymous record stays until consent retention ends. Orders hold no platform data. Nothing to stop on
 * trash and nothing to veto on restore. Idempotent: a retry finds no linked rows and reports 0.
 */
import type { TrashParticipant, TrashPurgeResult } from "../trash/ports.js";
import type { ConsentService } from "./consent.js";

export const PLATFORM_TRASH_MODULE = "platform";

export function createPlatformTrashParticipant(consent: Pick<ConsentService, "forgetUser">): TrashParticipant {
  return {
    module: PLATFORM_TRASH_MODULE,
    async purge(entity): Promise<TrashPurgeResult> {
      if (entity.kind !== "customer") return { deleted: {} };
      const unlinked = await consent.forgetUser(entity.publicId);
      return { deleted: { consents: unlinked } };
    },
  };
}
