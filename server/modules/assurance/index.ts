/**
 * Assurance module — public service surface and factory. Owner: assurance module engineer.
 * Other modules import TYPES from here and reach the instance through `deps.services.assurance` at call time.
 */
import type { ModuleDeps } from "../../container.js";
import type { ModuleLifecycle } from "../../core/types.js";

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AssuranceModule extends ModuleLifecycle {}

export function createAssuranceModule(_deps: ModuleDeps): AssuranceModule {
  return {};
}
