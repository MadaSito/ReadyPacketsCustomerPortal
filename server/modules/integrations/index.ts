/**
 * Integrations module — public service surface and factory. Owner: integrations module engineer.
 * Other modules import TYPES from here and reach the instance through `deps.services.integrations` at call time.
 */
import type { ModuleDeps } from "../../container.js";
import type { ModuleLifecycle } from "../../core/types.js";

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface IntegrationsModule extends ModuleLifecycle {}

export function createIntegrationsModule(_deps: ModuleDeps): IntegrationsModule {
  return {};
}
