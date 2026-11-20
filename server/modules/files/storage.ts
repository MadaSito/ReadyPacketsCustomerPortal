/**
 * Private local object storage adapter (opaque keys, no traversal/links, atomic writes). Owner: files engineer.
 * Integrator stub: replace the body; keep the signature.
 */
import type { AppConfig } from "../../config/env.js";
import type { Logger, ObjectStorage } from "../../core/types.js";

export function createObjectStorage(_deps: { config: Pick<AppConfig, "storageDir">; logger: Logger }): ObjectStorage {
  throw new Error("NOT_IMPLEMENTED: createObjectStorage (files engineer)");
}
