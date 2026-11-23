/**
 * Reports module (increment 06, package H / D6): whitelisted dataset catalogue, built-in reports, saved custom
 * report definitions compiled to parameterised Drizzle, bounded runs and CSV export. Read-only over other
 * modules' tables; never reads encrypted, blind-index or secret columns.
 */
import type { ModuleDeps } from "../../container.js";
import type { ModuleHealth, ModuleLifecycle } from "../../core/types.js";
import { REPORT_RUN_PURGE_JOB, createReportsService, type ReportsService } from "./service.js";

export { REPORT_RUN_PURGE_JOB, buildCsv, specHash } from "./service.js";
export type { CatalogueView, DefinitionInput, ReportsService } from "./service.js";
export * from "./spec.js";

export interface ReportsModule extends ModuleLifecycle, ReportsService {}

export function createReportsModule(deps: ModuleDeps): ReportsModule {
  const service = createReportsService(deps);

  deps.jobs.register(REPORT_RUN_PURGE_JOB, async () => {
    const deleted = await service.purgeRuns();
    return { outcome: "completed", safeCounts: { deleted } };
  }, { retrySafe: true });
  deps.jobs.registerSchedule({ name: "reports.runs.purge.daily", type: REPORT_RUN_PURGE_JOB, everyMs: 86_400_000 });

  return {
    ...service,
    async health(): Promise<ModuleHealth[]> {
      return [{ component: "reports", state: "ok", summary: "Reports are available.", checkedAt: deps.clock.now() }];
    },
  };
}
