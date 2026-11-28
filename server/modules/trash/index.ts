/**
 * Trash module public surface and factory (Increment 09, Decision D2). Owner: recovery_ops_engineer.
 * Skeleton published by the integrator so participants can register; the coordinator, settings, router and
 * retention job are added on top of this surface.
 */
import type { ModuleDeps } from "../../container.js";
import type { ModuleLifecycle } from "../../core/types.js";
import { createTrashRegistry, type TrashRegistry } from "./ports.js";

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
