import type { ModuleDeps } from "../../container.js";
import type { ModuleLifecycle } from "../../core/types.js";
import { createExportService } from "./exportService.js";
import { createImportService } from "./importService.js";

export interface PortableModule extends ModuleLifecycle, ReturnType<typeof createExportService>, ReturnType<typeof createImportService> {}

export function createPortableModule(deps: ModuleDeps): PortableModule {
  return { ...createExportService(deps), ...createImportService(deps) };
}
