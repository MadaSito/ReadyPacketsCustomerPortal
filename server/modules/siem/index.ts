/**
 * Siem module — public service surface and factory. Owner: siem module engineer.
 * Other modules import TYPES from here and reach the instance through `deps.services.siem` at call time.
 */
import type { ModuleDeps } from "../../container.js";
import type { ModuleLifecycle } from "../../core/types.js";

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SiemModule extends ModuleLifecycle {}

export function createSiemModule(_deps: ModuleDeps): SiemModule {
  return {};
}
