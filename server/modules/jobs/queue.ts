/**
 * Durable job queue + transactional mail outbox factories. Owner: jobs engineer.
 * Integrator stub: replace the bodies; keep the signatures.
 */
import type { AppConfig } from "../../config/env.js";
import type { AuditEmitter, Clock, Db, FieldCrypto, JobQueue, Logger, Mailer, SettingsStore } from "../../core/types.js";

export interface QueueDeps {
  config: AppConfig;
  db: Db;
  clock: Clock;
  logger: Logger;
  audit: AuditEmitter;
  crypto: FieldCrypto;
  settings: SettingsStore;
}

export function createJobQueue(_deps: QueueDeps): JobQueue {
  throw new Error("NOT_IMPLEMENTED: createJobQueue (jobs engineer)");
}

export function createMailer(_deps: QueueDeps & { jobs: JobQueue }): Mailer {
  throw new Error("NOT_IMPLEMENTED: createMailer (jobs engineer)");
}
