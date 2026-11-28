/**
 * Trash module public surface and factory (Increment 09, Decision D2 & D2.8). Owner: recovery_ops_engineer.
 */
import type { ModuleDeps } from "../../container.js";
import type { ModuleHealth, ModuleLifecycle } from "../../core/types.js";
import "./settings.js";
import { createTrashRegistry, type TrashRegistry } from "./ports.js";
import { createTrashCoordinator, EXPECTED_CONTAINER_PARTICIPANTS } from "./service.js";
import type { TrashCoordinatorOptions, TrashService } from "./types.js";

export {
  TRASH_JOB_RETENTION_CLEANUP,
  TRASH_SCHEDULE_RETENTION_EVERY_HOUR,
} from "./jobNames.js";
export {
  TRASH_AUTO_PURGE_ENABLED,
  TRASH_RETENTION_CUSTOMER_DAYS,
  TRASH_RETENTION_DEFAULT_DAYS,
  TRASH_RETENTION_MAX_DAYS,
  TRASH_RETENTION_MIN_DAYS,
  TRASH_RETENTION_ORDER_DAYS,
} from "./settings.js";
export { EXPECTED_CONTAINER_PARTICIPANTS } from "./service.js";
export { trashRouter, type TrashRouter } from "./router.js";
export type {
  TrashActor,
  TrashEntityKind,
  TrashEntityRef,
  TrashParticipant,
  TrashPurgeResult,
  TrashPurgeRun,
  TrashRegistry,
} from "./ports.js";
export type {
  RetentionValues,
  TrashCoordinatorOptions,
  TrashCounts,
  TrashFinishLeavingExternalInput,
  TrashFinishLeavingExternalOutput,
  TrashItemRef,
  TrashItemResult,
  TrashListInput,
  TrashListOutput,
  TrashMoveInput,
  TrashMoveOutput,
  TrashPerson,
  TrashPurgeInput,
  TrashPurgeOutput,
  TrashRestoreInput,
  TrashRestoreOutput,
  TrashRow,
  TrashRunSummary,
  TrashService,
  TrashSettings,
  TrashSettingsPreview,
  TrashSettingsUpdateInput,
  TrashSummary,
} from "./types.js";

export interface TrashModule
  extends ModuleLifecycle,
    TrashRegistry,
    Partial<Omit<TrashService, keyof ModuleLifecycle | keyof TrashRegistry>> {}

export interface TrashCoordinatorModule extends ModuleLifecycle, TrashRegistry, TrashService {}

export function createTrashModule(
  deps: ModuleDeps,
  options?: TrashCoordinatorOptions,
): TrashCoordinatorModule {
  const registry = createTrashRegistry();
  const coordinator = createTrashCoordinator(deps, registry, options);

  return {
    ...registry,
    ...coordinator,
    init() {
      coordinator.init?.();
      // Every participant has registered before `trash.init()` runs last in `createContainer`.
      const registered = new Set(registry.participants().map((p) => p.module));
      const required = options?.expectedParticipants ?? EXPECTED_CONTAINER_PARTICIPANTS;
      const missing = required.filter((m) => !registered.has(m));
      if (missing.length > 0) {
        deps.logger.warn("trash coordinator initialised with missing participants; purge will fail closed until registered", {
          missingCount: missing.length,
          missingModules: missing,
        });
      }
    },
    async health(): Promise<ModuleHealth[]> {
      const checkedAt = deps.clock.now();
      const registered = new Set(registry.participants().map((p) => p.module));
      const required = options?.expectedParticipants ?? EXPECTED_CONTAINER_PARTICIPANTS;
      const missing = required.filter((m) => !registered.has(m));
      return [
        {
          component: "trash",
          state: missing.length === 0 ? "ok" : "degraded",
          summary:
            missing.length === 0
              ? "Trash coordinator and retention clean-up are ready."
              : "Trash coordinator is waiting on participant registration before permanent deletion is allowed.",
          metrics: {
            registeredParticipants: registered.size,
            missingParticipants: missing.length,
          },
          checkedAt,
        },
      ];
    },
  };
}
