import type { ModuleDeps } from "../../container.js";
import { DomainError } from "../../core/errors.js";
import { createJobsAdmin } from "./admin.js";
import { mailEngineFor, type SmtpDeliveryResult } from "./mail.js";
import type { MailTemplate, ModuleLifecycle } from "../../core/types.js";
import type { MailTemplateStore, MailTransport } from "./mailPorts.js";
import { engineFor, ensureMaintenanceGate } from "./queue.js";
import { startWorker, type WorkerHandle } from "./worker.js";

export type { WorkerHandle } from "./worker.js";
export type { OutboxJobDisposition } from "./admin.js";
export type {
  MailSenderIdentity, MailTemplateStore, MailTransport, MailTransportKey, MailTransportMessage,
  MailTransportResult, PublishedMailTemplate,
} from "./mailPorts.js";
export type JobsModule = ReturnType<typeof createJobsAdmin> & ModuleLifecycle & {
  startWorker(): Promise<WorkerHandle>;
  registerMailTransport(transport: MailTransport): void;
  registerMailTemplateStore(store: MailTemplateStore): void;
  getBuiltinMailTemplates(): readonly MailTemplate[];
};

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
    registerMailTransport: (transport) => { mailer?.registerMailTransport(transport); },
    registerMailTemplateStore: (store) => { mailer?.registerMailTemplateStore(store); },
    getBuiltinMailTemplates: () => mailer?.getBuiltinMailTemplates() ?? [],
    async startWorker() {
      const engine = engineFor(deps.jobs);
      if (!engine) throw new DomainError("UNAVAILABLE", "JOB_QUEUE_UNAVAILABLE", "The durable job queue is unavailable.");
      await ensureMaintenanceGate(deps);
      return worker ??= startWorker(engine);
    },
  };
}
