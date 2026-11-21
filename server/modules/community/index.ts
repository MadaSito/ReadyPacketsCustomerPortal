/**
 * Community forum module — factory and public service surface. Owner: audit_engineer (package M).
 * Mounted by /root: `services.community = createCommunityModule(deps)`; router `communityRouter`.
 */
import type { ModuleDeps } from "../../container.js";
import type { Tx } from "../../core/types.js";
import { registerCommunityAutomationTriggers } from "./automationTriggers.js";
import { createCommunityService, type CommunityService } from "./service.js";

export { COMMUNITY_CONFIG, COMMUNITY_FLAG, DEFAULT_COMMUNITY_CONFIG, type CommunityConfig } from "./settings.js";
export type * from "./service.js";

export interface CommunityModule extends CommunityService {
  /** Cheap flag read for other modules and the shell. */
  enabled(tx?: Tx): Promise<boolean>;
  /** Identity's account deletion: keeps posts, detaches the display name ("Former member"). */
  anonymiseMember(userId: number, tx: Tx): Promise<void>;
}

export function createCommunityModule(deps: ModuleDeps): CommunityModule {
  registerCommunityAutomationTriggers();
  return createCommunityService(deps);
}
