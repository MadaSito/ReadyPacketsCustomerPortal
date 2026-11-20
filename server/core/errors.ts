/**
 * Domain error taxonomy. Routers translate these to safe tRPC/HTTP errors; messages shown to users are
 * fixed safe strings — never raw exception text, SQL, paths or secrets.
 */
export type DomainErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "STEP_UP_REQUIRED"
  | "REMEDIATION_REQUIRED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION"
  | "RATE_LIMITED"
  | "LOCKED"
  | "UNAVAILABLE"
  | "AUDIT_UNAVAILABLE"
  | "UNKNOWN_OUTCOME"
  | "NOT_CONFIGURED"
  | "MAINTENANCE";

export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    /** Fixed UPPER_SNAKE reason category for audit and UI mapping. */
    public readonly reasonCode: string,
    /** Safe, user-presentable sentence. */
    public readonly safeMessage: string,
    public readonly details?: Record<string, string | number | boolean | readonly string[]>,
  ) {
    super(`${code}:${reasonCode}`);
    this.name = "DomainError";
  }
}

export class AuditUnavailableError extends DomainError {
  constructor() {
    super(
      "AUDIT_UNAVAILABLE",
      "AUDIT_WRITE_FAILED",
      "This action could not be recorded and was not performed. Please try again shortly.",
    );
    this.name = "AuditUnavailableError";
  }
}

export class CryptoError extends Error {
  constructor(public readonly reasonCode: "TAMPERED" | "UNKNOWN_KEY" | "MALFORMED" | "KEY_UNAVAILABLE") {
    super(`crypto:${reasonCode}`);
    this.name = "CryptoError";
  }
}

export const notFound = (reason = "NOT_FOUND") =>
  new DomainError("NOT_FOUND", reason, "The requested item was not found.");
export const forbidden = (reason = "FORBIDDEN") =>
  new DomainError("FORBIDDEN", reason, "You do not have permission to perform this action.");
export const conflict = (reason: string, safeMessage: string) => new DomainError("CONFLICT", reason, safeMessage);
export const validation = (reason: string, safeMessage: string, details?: DomainError["details"]) =>
  new DomainError("VALIDATION", reason, safeMessage, details);
