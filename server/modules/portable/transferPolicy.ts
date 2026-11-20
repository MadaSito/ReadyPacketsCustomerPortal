import type { ModuleDeps } from "../../container.js";
import type { SessionPrincipal } from "../../core/types.js";
import { DomainError, forbidden } from "../../core/errors.js";
import { roleHasCapability } from "../../../shared/capabilities.js";

export const TRANSFER_MAX_BYTES = 192 * 1024 * 1024;
export const TRANSFER_MAX_RECORDS = 10_000;
export const TRANSFER_MAX_OBJECTS = 1500;
export const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;
export const REVIEW_TTL_MS = 60 * 60 * 1000;
export const TRANSFER_STEP_UP_MS = 10 * 60 * 1000;
export const PORTABLE_EXPORT_JOB = "portable.export.publish";
export const PORTABLE_IMPORT_JOB = "portable.import.apply";
export const PORTABLE_RETENTION_JOB = "portable.export.retention";

export const PACKAGE_LIMITS = {
  maxPackageBytes: TRANSFER_MAX_BYTES,
  maxObjectBytes: 128 * 1024 * 1024,
  maxTotalUncompressed: 384 * 1024 * 1024,
  maxEntries: TRANSFER_MAX_OBJECTS + 100,
  maxRecordsPerType: TRANSFER_MAX_RECORDS,
  maxRecordLineBytes: 256 * 1024,
  maxHeldUnknownBytes: 16 * 1024,
  kdfMaxN: 1 << 17,
  kdfMaxR: 8,
  kdfMaxP: 1,
  maxLegacyPackageBytes: 32 * 1024 * 1024,
  maxManifestBytes: 4 * 1024 * 1024,
  maxExtensionBytes: 512 * 1024,
};

export async function authorizeTransfer(
  deps: ModuleDeps,
  principal: SessionPrincipal,
  capability: "portable.export" | "portable.import",
  stepUp = true,
) {
  const now = deps.clock.now().getTime();
  const age = principal.stepUpAt ? now - principal.stepUpAt.getTime() : Infinity;
  const reason = principal.role !== "admin" || !roleHasCapability(principal.role, capability)
    ? "CAPABILITY_NOT_GRANTED"
    : principal.state !== "full" || principal.pendingSteps.length || !principal.mfaVerifiedAt
      ? "NO_FULL_SESSION"
      : stepUp && (age < 0 || age > TRANSFER_STEP_UP_MS) ? "STEP_UP_REQUIRED" : null;
  if (reason) {
    await deps.audit.record({
      category: "security", eventName: "portable.authorization.denied", action: "authorize", outcome: "denied",
      reasonCode: reason, actor: { userId: principal.userId, role: principal.role }, resource: { type: "portable_transfer" },
    });
    if (reason === "STEP_UP_REQUIRED") {
      throw new DomainError("STEP_UP_REQUIRED", reason, "Confirm your password and authentication code to continue.", { capability });
    }
    throw forbidden(reason);
  }
}

export async function assertNotDraining(deps: ModuleDeps) {
  if (await deps.services.jobAdmin.isDraining()) {
    throw new DomainError("MAINTENANCE", "PORTABLE_MAINTENANCE", "New transfers are paused while the system is in maintenance.");
  }
}

export interface PageInput { cursor?: string; limit?: number }
export type ExportSelection =
  | { kind: "all" }
  | { kind: "customers" | "orders"; ids: string[] };

/** Normalize a bounded cursor input even when called from trusted server code without tRPC. */
export const pageLimit = (input: PageInput) => Math.max(1, Math.min(100, input.limit ?? 30));
