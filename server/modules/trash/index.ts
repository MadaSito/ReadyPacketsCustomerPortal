/**
 * Trash module public surface and factory (Increment 09, Decision D2). Owner: recovery_ops_engineer.
 * Skeleton published by the integrator so participants can register; the coordinator, settings, router and
 * retention job are added on top of this surface.
 */
import type { ModuleDeps } from "../../container.js";
import type { ModuleLifecycle } from "../../core/types.js";
import "./settings.js";
import { createTrashRegistry, type TrashRegistry } from "./ports.js";

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
export type {
  TrashActor,
  TrashEntityKind,
  TrashEntityRef,
  TrashParticipant,
  TrashPurgeResult,
  TrashPurgeRun,
  TrashRegistry,
} from "./ports.js";

export interface TrashModule extends ModuleLifecycle, TrashRegistry {}

export function createTrashModule(_deps: ModuleDeps): TrashModule {
  const registry = createTrashRegistry();
  return { ...registry };
}
