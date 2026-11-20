/**
 * Jobs module — public service surface and factory. Owner: jobs module engineer.
 * Other modules import TYPES from here and reach the instance through `deps.services.jobs` at call time.
 */
import type { ModuleDeps } from "../../container.js";
import type { ModuleLifecycle } from "../../core/types.js";

export interface WorkerHandle {
  /** Stops claiming, lets running jobs reach a durable boundary (bounded), then resolves. */
  stop(): Promise<void>;
}

export interface JobsModule extends ModuleLifecycle {
  /** Starts the claim/heartbeat/scheduler loops for this process. */
  startWorker(): Promise<WorkerHandle>;
}

export function createJobsModule(_deps: ModuleDeps): JobsModule {
  return {
    async startWorker() {
      throw new Error("NOT_IMPLEMENTED: startWorker (jobs engineer)");
    },
  };
}
