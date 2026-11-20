/**
 * Files module — public service surface and factory. Owner: files module engineer.
 * Other modules import TYPES from here and reach the instance through `deps.services.files` at call time.
 */
import type { ModuleDeps } from "../../container.js";
import type { ModuleLifecycle } from "../../core/types.js";

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface FilesModule extends ModuleLifecycle {}

export function createFilesModule(_deps: ModuleDeps): FilesModule {
  return {};
}
