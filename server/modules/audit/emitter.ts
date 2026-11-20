/**
 * Durable audit emitter factory. Owner: audit engineer. Integrator stub: replace the body; keep the signature.
 * Constructed BEFORE the settings store and modules, so it may depend only on these primitives.
 */
import type { AppConfig } from "../../config/env.js";
import type { AuditEmitter, Clock, Db, FieldCrypto, Logger } from "../../core/types.js";

export interface AuditEmitterDeps {
  config: AppConfig;
  db: Db;
  clock: Clock;
  logger: Logger;
  crypto: FieldCrypto;
}

export function createAuditEmitter(_deps: AuditEmitterDeps): AuditEmitter {
  throw new Error("NOT_IMPLEMENTED: createAuditEmitter (audit engineer)");
}
