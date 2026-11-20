import type { ModuleDeps } from "../../container.js";
import { DomainError } from "../../core/errors.js";
import { createJobsAdmin } from "./admin.js";
import { mailEngineFor, type SmtpDeliveryResult } from "./mail.js";
import { engineFor, ensureMaintenanceGate } from "./queue.js";
import { startWorker, type WorkerHandle } from "./worker.js";

export type { WorkerHandle } from "./worker.js";
export type JobsModule = ReturnType<typeof createJobsAdmin> & { startWorker(): Promise<WorkerHandle> };

export function createJobsModule(deps: ModuleDeps): JobsModule {
  const mailer = mailEngineFor(deps.mailer);
  // Call these ports lazily, after the container has attached peer modules.
  mailer?.registerDelivery({
    findRecipient: (userId) => deps.services.identity.getUser(userId),
    send: (message): Promise<SmtpDeliveryResult> => deps.services.integrations.smtp.send(message),
  });
  let worker: WorkerHandle | undefined;
  return {
    ...createJobsAdmin(deps),
    async startWorker() {
      const engine = engineFor(deps.jobs);
      if (!engine) throw new DomainError("UNAVAILABLE", "JOB_QUEUE_UNAVAILABLE", "The durable job queue is unavailable.");
      await ensureMaintenanceGate(deps);
      return worker ??= startWorker(engine);
    },
  };
}
