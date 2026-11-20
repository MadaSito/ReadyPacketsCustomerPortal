/**
 * Backup module — public service surface and factory. Owner: backup module engineer.
 * Other modules import TYPES from here and reach the instance through `deps.services.backup` at call time.
 */
import type { ModuleDeps } from "../../container.js";
import type { ModuleLifecycle } from "../../core/types.js";

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface BackupModule extends ModuleLifecycle {}

export function createBackupModule(_deps: ModuleDeps): BackupModule {
  return {};
}
