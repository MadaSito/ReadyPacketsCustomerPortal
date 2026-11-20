/**
 * Audit module — public service surface and factory. Owner: audit module engineer.
 * Other modules import TYPES from here and reach the instance through `deps.services.audit` at call time.
 */
import type { ModuleDeps } from "../../container.js";
import type { ModuleLifecycle } from "../../core/types.js";

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AuditModule extends ModuleLifecycle {}

export function createAuditModule(_deps: ModuleDeps): AuditModule {
  return {};
}
