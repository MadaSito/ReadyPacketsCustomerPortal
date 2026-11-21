/**
 * Automations module — public service surface and factory. Owner: Package J server (`server/modules/automations/**`).
 * Other modules import contracts/helpers from `./contracts.js` (or here) and reach the live instance
 * through `deps.services.automations` at call time.
 */
import type { ModuleDeps } from "../../container.js";
import "./settings.js";
import "./builtinActions.js";
import type { AutomationsModule } from "./contracts.js";
import { createAutomationsService } from "./service.js";

export * from "./contracts.js";
export {
  signAutomationWebhook,
  extractAndValidateTemplateVars,
  renderPlainTemplate,
} from "./templates.js";
export {
  conditionTreeSchema,
  evaluateConditionTree,
  validateConditionTreeForFields,
  OPERATORS_BY_FIELD_TYPE,
} from "./conditions.js";
export { AUTOMATIONS_CONFIG, DEFAULT_AUTOMATIONS_SETTINGS } from "./settings.js";
export { STAFF_ONLY_ALLOWED_ACTION_KEYS, STARTER_RECIPES } from "./builtinActions.js";
export {
  JOB_EVALUATE_EVENT,
  JOB_EXECUTE_RUN,
  JOB_PURGE_RUNS,
  JOB_SCHEDULE_TICK,
} from "./service.js";

export function createAutomationsModule(deps: ModuleDeps): AutomationsModule {
  return createAutomationsService(deps);
}
