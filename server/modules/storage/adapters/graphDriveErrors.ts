/**
 * Error mapping for the Graph drive adapter onto the shared StorageAdapterError (storage/contracts.ts).
 * `retryable: true` only where a retry cannot duplicate an external effect: uploads use conflictBehavior
 * "fail" and a re-run recognises an identical existing object, so transient failures are retry-safe.
 * Errors never carry provider bodies, URLs, remote ids, names or tokens.
 */
import { StorageAdapterError, type StorageAdapterErrorCode } from "../contracts.js";
import { GraphTransportError } from "./graphDrivePort.js";

export { StorageAdapterError };
export type GraphDriveErrorCode = StorageAdapterErrorCode;

/** Maps a Graph HTTP status to a fixed code. */
export function codeForStatus(status: number): { code: GraphDriveErrorCode; retryable: boolean } {
  if (status === 401) return { code: "AUTH_FAILED", retryable: false };
  if (status === 403) return { code: "DESTINATION_DENIED", retryable: false };
  if (status === 404 || status === 410) return { code: "DESTINATION_NOT_FOUND", retryable: false };
  if (status === 409 || status === 412) return { code: "DESTINATION_CONFLICT", retryable: false };
  if (status === 413) return { code: "TOO_LARGE", retryable: false };
  if (status === 429) return { code: "RATE_LIMITED", retryable: true };
  if (status === 400 || status === 416) return { code: "INVALID_INPUT", retryable: false };
  return { code: "PROVIDER_UNAVAILABLE", retryable: status >= 500 };
}

export function fromStatus(status: number, retryAfter?: string): StorageAdapterError {
  const { code, retryable } = codeForStatus(status);
  const seconds = retryAfter && /^\d{1,6}$/u.test(retryAfter) ? Number(retryAfter) : undefined;
  return new StorageAdapterError(code, retryable, seconds);
}

/** Normalises anything thrown by the transport into a StorageAdapterError (unknown errors → provider unavailable). */
export function toAdapterError(error: unknown): StorageAdapterError {
  if (error instanceof StorageAdapterError) return error;
  if (error instanceof GraphTransportError) {
    if (error.code === "EGRESS_DENIED") return new StorageAdapterError("EGRESS_DENIED", false);
    if (error.code === "AUTH_FAILED") return new StorageAdapterError("AUTH_FAILED", false);
    if (error.code === "RESPONSE_TOO_LARGE") return new StorageAdapterError("PROVIDER_UNAVAILABLE", false);
    return new StorageAdapterError("PROVIDER_UNAVAILABLE", error.retryable);
  }
  return new StorageAdapterError("PROVIDER_UNAVAILABLE", true);
}
