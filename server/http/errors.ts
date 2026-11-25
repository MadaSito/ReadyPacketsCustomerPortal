import { getTRPCErrorFromUnknown } from "@trpc/server";
import { TRPC_ERROR_CODES_BY_KEY } from "@trpc/server/rpc";
import type { Request, Response } from "express";
import { DomainError, type DomainErrorCode } from "../core/errors.js";
import { getRequestContext } from "../core/requestContext.js";
import type { SafeErrorData } from "../trpc/trpc.js";

const STATUS: Record<DomainErrorCode, number> = {
  UNAUTHENTICATED: 401, FORBIDDEN: 403, STEP_UP_REQUIRED: 403, REMEDIATION_REQUIRED: 403,
  NOT_FOUND: 404, CONFLICT: 409, VALIDATION: 400, RATE_LIMITED: 429, LOCKED: 409,
  UNAVAILABLE: 503, AUDIT_UNAVAILABLE: 503, UNKNOWN_OUTCOME: 409, NOT_CONFIGURED: 412, MAINTENANCE: 503,
};

const PARSER_FAILURES = {
  "entity.too.large": [413, "BODY_TOO_LARGE", "The request body exceeds the permitted size."],
  "parameters.too.many": [413, "TOO_MANY_FORM_FIELDS", "The request has too many form fields."],
  "media.unsupported": [415, "UNSUPPORTED_CONTENT_TYPE", "The request content type is not supported."],
  "entity.parse.failed": [400, "INVALID_JSON", "The request body is not valid JSON."],
  "encoding.unsupported": [415, "UNSUPPORTED_ENCODING", "The request content encoding is not supported."],
  "charset.unsupported": [415, "UNSUPPORTED_CHARSET", "The request character encoding is not supported."],
  "request.size.invalid": [400, "INVALID_BODY_SIZE", "The request body size does not match its declaration."],
  "request.aborted": [400, "BODY_ABORTED", "The request body was incomplete."],
} as const;

export function formatHttpError(error: unknown, requestId: string): { status: number; safe: SafeErrorData } {
  if (error instanceof DomainError) {
    return { status: STATUS[error.code], safe: {
      domainCode: error.code, reasonCode: error.reasonCode, safeMessage: error.safeMessage,
      details: error.details, requestId,
    } };
  }
  if (error && typeof error === "object" && "type" in error &&
      typeof error.type === "string" && Object.hasOwn(PARSER_FAILURES, error.type)) {
    const [status, reasonCode, safeMessage] = PARSER_FAILURES[error.type as keyof typeof PARSER_FAILURES];
    return { status, safe: { domainCode: "BAD_INPUT", reasonCode, safeMessage, requestId } };
  }
  return { status: 500, safe: {
    domainCode: "INTERNAL", reasonCode: "INTERNAL_ERROR",
    safeMessage: "Something went wrong on our side. Please try again.", requestId,
  } };
}

export function retryAfter(error: unknown): number | undefined {
  if (!(error instanceof DomainError) || error.code !== "RATE_LIMITED") return undefined;
  const delay = error.details?.retryAfterSeconds;
  return typeof delay === "number" && Number.isFinite(delay) ? Math.max(1, Math.ceil(delay)) : 60;
}

const TRPC_WIRE = {
  400: "BAD_REQUEST", 401: "UNAUTHORIZED", 403: "FORBIDDEN", 404: "NOT_FOUND",
  409: "CONFLICT", 412: "PRECONDITION_FAILED", 413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE", 429: "TOO_MANY_REQUESTS", 500: "INTERNAL_SERVER_ERROR",
  503: "SERVICE_UNAVAILABLE",
} as const;

/** Pre-adapter tRPC failures keep SuperJSON wire shape (and bounded batch cardinality). */
export function sendSafeError(
  error: unknown,
  req: Request,
  res: Response,
  requestId: string,
  batchSize?: number,
): void {
  const { status, safe } = formatHttpError(error, requestId);
  res.setHeader("Cache-Control", "no-store");
  const retry = retryAfter(error);
  if (retry !== undefined) res.setHeader("Retry-After", String(retry));
  if (/^\/api\/v1(?:\/|$)/i.test(req.originalUrl.split("?", 1)[0] ?? "")) {
    res.setHeader("X-Correlation-Id", getRequestContext()?.correlationId ?? requestId);
    res.status(status).type("application/problem+json").json({
      type: `urn:readypackets:problem:${safe.reasonCode.toLowerCase()}`,
      title: safe.safeMessage, status, code: safe.reasonCode, request_id: requestId,
    });
    return;
  }
  if (!/^\/api\/trpc(?:\/|$)/.test(req.originalUrl.split("?")[0] ?? "")) {
    res.status(status).json({ safe });
    return;
  }
  const code = TRPC_WIRE[status as keyof typeof TRPC_WIRE] ?? TRPC_WIRE[500];
  const item = { error: { json: { message: safe.safeMessage, code: TRPC_ERROR_CODES_BY_KEY[code], data: { code, httpStatus: status, safe } } } };
  res.status(status).json(batchSize === undefined ? item : Array.from({ length: batchSize }, () => item));
}

export function trpcRetryAfter(errors: readonly unknown[]): number | undefined {
  const delays = errors.map((error) => retryAfter(getTRPCErrorFromUnknown(error).cause)).filter((v) => v !== undefined);
  return delays.length ? Math.max(...delays) : undefined;
}
