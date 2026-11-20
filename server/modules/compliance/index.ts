/**
 * Compliance module — public service surface and factory. Owner: compliance module engineer.
 * Other modules import TYPES from here and reach the instance through `deps.services.compliance` at call time.
 */
import type { ModuleDeps } from "../../container.js";
import type { ModuleLifecycle } from "../../core/types.js";

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ComplianceModule extends ModuleLifecycle {}

export function createComplianceModule(_deps: ModuleDeps): ComplianceModule {
  return {};
}
