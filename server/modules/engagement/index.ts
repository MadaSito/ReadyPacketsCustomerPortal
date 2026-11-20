/**
 * Engagement module — public service surface and factory. Owner: engagement module engineer.
 * Other modules import TYPES from here and reach the instance through `deps.services.engagement` at call time.
 */
import type { ModuleDeps } from "../../container.js";
import type { ModuleLifecycle } from "../../core/types.js";

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface EngagementModule extends ModuleLifecycle {}

export function createEngagementModule(_deps: ModuleDeps): EngagementModule {
  return {};
}
