/**
 * Community forum module — factory and public service surface. Owner: audit_engineer (package M).
 * Mounted by /root: `services.community = createCommunityModule(deps)`; router `communityRouter`.
 */
import type { ModuleDeps } from "../../container.js";
import type { ModuleHealth, ModuleLifecycle, Tx } from "../../core/types.js";
import { registerCommunityAutomationTriggers } from "./automationTriggers.js";
import { createCommunityService, type CommunityService } from "./service.js";
import { createCommunityTrashParticipant } from "./trash.js";

export { COMMUNITY_CONFIG, COMMUNITY_FLAG, DEFAULT_COMMUNITY_CONFIG, type CommunityConfig } from "./settings.js";
export type * from "./service.js";

export interface CommunityModule extends CommunityService, ModuleLifecycle {
  /** Cheap flag read for other modules and the shell. */
  enabled(tx?: Tx): Promise<boolean>;
  /** Identity's account deletion: keeps posts, detaches the display name ("Former member"). */
  anonymiseMember(userId: number, tx: Tx): Promise<void>;
}

export function createCommunityModule(deps: ModuleDeps): CommunityModule {
  registerCommunityAutomationTriggers();
  const service = createCommunityService(deps);
  const trashParticipant = createCommunityTrashParticipant(deps);
  let trashRegistered = false;
  return {
    ...service,
    init() {
      if (!trashRegistered && deps.services.trash?.register) {
        deps.services.trash.register(trashParticipant);
        trashRegistered = true;
      }
    },
    async health(): Promise<ModuleHealth[]> {
      const on = await service.enabled();
      return [{ component: "community.forum", state: on ? "ok" : "disabled", summary: on ? "Community forum is switched on." : "Community forum is switched off.", checkedAt: deps.clock.now() }];
    },
  };
}
