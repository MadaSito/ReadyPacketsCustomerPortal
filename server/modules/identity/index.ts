/**
 * Identity module — public service surface and factory. Owner: identity module engineer.
 * Other modules import TYPES from here and reach the instance through `deps.services.identity` at call time.
 */
import type { ModuleDeps } from "../../container.js";
import type { ModuleLifecycle, SessionResolver } from "../../core/types.js";

export interface IdentityModule extends ModuleLifecycle {
  /** Authoritative session validation; consumed by the HTTP pipeline through `services.sessionResolver`. */
  sessionResolver: SessionResolver;
}

export function createIdentityModule(_deps: ModuleDeps): IdentityModule {
  return { sessionResolver: { resolve: async () => null } };
}
