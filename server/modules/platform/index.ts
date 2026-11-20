/**
 * Platform module — public service surface and factory. Owner: platform module engineer.
 * Other modules import TYPES from here and reach the instance through `deps.services.platform` at call time.
 */
import type { ModuleDeps } from "../../container.js";
import type { ModuleLifecycle } from "../../core/types.js";

export interface PlatformModule extends ModuleLifecycle {
  /** Compares the live database with the release's migration inventory; throws if incompatible (fail closed). */
  assertSchemaContract(): Promise<void>;
}

export function createPlatformModule(_deps: ModuleDeps): PlatformModule {
  return {
    async assertSchemaContract() {
      throw new Error("NOT_IMPLEMENTED: assertSchemaContract (platform engineer)");
    },
  };
}
