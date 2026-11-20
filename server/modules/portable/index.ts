/**
 * Portable module — public service surface and factory. Owner: portable module engineer.
 * Other modules import TYPES from here and reach the instance through `deps.services.portable` at call time.
 */
import type { ModuleDeps } from "../../container.js";
import type { ModuleLifecycle } from "../../core/types.js";

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PortableModule extends ModuleLifecycle {}

export function createPortableModule(_deps: ModuleDeps): PortableModule {
  return {};
}
