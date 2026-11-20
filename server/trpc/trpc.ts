/**
 * tRPC foundation: context, safe error formatting and the ONLY procedure guards modules may use.
 * Owner: integrator (/root).
 *
 * Guard ladder (each implies the previous):
 *   publicProcedure     no session required (rate-limited)
 *   sessionProcedure    any valid session, INCLUDING remediation sessions — transition endpoints only
 *   protectedProcedure  full session (every account prerequisite complete)
 *   staffProcedure      full session + role staff|admin
 *   adminProcedure      full session + role admin
 *   .use(requireCapability("x"))  role capability + fresh step-up when the capability demands it
 *
 * Guards establish WHO and WHAT KIND of action. Resource scope (ownership, grants, locks) is always
 * re-checked inside the module service for every list/detail/search/export/upload/download/mutation.
 */
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";
import { STEP_UP_CAPABILITIES, roleHasCapability, type Capability } from "../../shared/capabilities.js";
import { DomainError, type DomainErrorCode } from "../core/errors.js";
import { getRequestContext } from "../core/requestContext.js";
import type { RateLimitCategory, RequestContext, SessionPrincipal, SessionTransport } from "../core/types.js";
import type { Services } from "../container.js";

export interface TrpcContext {
  services: Services;
  session: SessionPrincipal | null;
  request: RequestContext;
  transport: SessionTransport;
}

export interface ProcedureMeta {
  /** Rate-limit budget for this procedure. Default `api`. Batches are charged per call. */
  rateLimit?: RateLimitCategory;
}

/** Fresh step-up window for high-impact capabilities. */
export const STEP_UP_MAX_AGE_MS = 10 * 60 * 1000;

const TRPC_CODE: Record<DomainErrorCode, TRPCError["code"]> = {
  UNAUTHENTICATED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  STEP_UP_REQUIRED: "FORBIDDEN",
  REMEDIATION_REQUIRED: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  VALIDATION: "BAD_REQUEST",
  RATE_LIMITED: "TOO_MANY_REQUESTS",
  LOCKED: "CONFLICT",
  UNAVAILABLE: "SERVICE_UNAVAILABLE",
  AUDIT_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  UNKNOWN_OUTCOME: "CONFLICT",
  NOT_CONFIGURED: "PRECONDITION_FAILED",
  MAINTENANCE: "SERVICE_UNAVAILABLE",
};

export interface SafeErrorData {
  domainCode: DomainErrorCode | "INTERNAL" | "BAD_INPUT";
  reasonCode: string;
  safeMessage: string;
  details?: DomainError["details"];
  fieldErrors?: Record<string, string[]>;
  requestId: string;
}

/**
 * Maps a Zod issue to a fixed sentence. Custom messages written by module owners in their schemas are fixed
 * strings by convention (never interpolated input) and are passed through when they look like plain prose.
 */
function safeIssueMessage(issue: ZodError["issues"][number]): string {
  switch (issue.code) {
    case "too_small":
      return "This value is too short or too small.";
    case "too_big":
      return "This value is too long or too large.";
    case "invalid_type":
      return "This field is required or has the wrong type.";
    case "invalid_format":
      return "This value is not in the expected format.";
    case "unrecognized_keys":
      return "Unexpected fields were provided.";
    case "invalid_value":
      return "This value is not one of the allowed options.";
    case "custom":
      return /^[\w .,;:'()\-–—/]{1,160}$/.test(issue.message) ? issue.message : "This value is not valid.";
    default:
      return "This value is not valid.";
  }
}

const t = initTRPC
  .context<TrpcContext>()
  .meta<ProcedureMeta>()
  .create({
    transformer: superjson,
    errorFormatter({ shape, error, ctx }) {
      const requestId = ctx?.request.requestId ?? getRequestContext()?.requestId ?? "unknown";
      let safe: SafeErrorData;
      const cause = error.cause;
      if (cause instanceof DomainError) {
        safe = {
          domainCode: cause.code,
          reasonCode: cause.reasonCode,
          safeMessage: cause.safeMessage,
          details: cause.details,
          requestId,
        };
      } else if (cause instanceof ZodError) {
        // Null-prototype accumulator + fixed sentences: never echo user input, schema internals or
        // prototype property names back to the browser.
        const fieldErrors: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
        for (const issue of cause.issues.slice(0, 50)) {
          const key = issue.path.filter((part) => typeof part === "string" || typeof part === "number").join(".").slice(0, 120) || "_";
          const messages = (fieldErrors[key] ??= []);
          const message = safeIssueMessage(issue);
          if (!messages.includes(message) && messages.length < 5) messages.push(message);
        }
        safe = {
          domainCode: "BAD_INPUT",
          reasonCode: "INVALID_INPUT",
          safeMessage: "Some of the information provided is not valid.",
          fieldErrors,
          requestId,
        };
      } else if (error.code === "INTERNAL_SERVER_ERROR") {
        safe = {
          domainCode: "INTERNAL",
          reasonCode: "INTERNAL_ERROR",
          safeMessage: "Something went wrong on our side. Please try again.",
          requestId,
        };
      } else {
        safe = {
          domainCode: "INTERNAL",
          reasonCode: error.code,
          safeMessage: "The request could not be completed.",
          requestId,
        };
      }
      // Never forward raw messages or stacks to the browser.
      return { ...shape, message: safe.safeMessage, data: { code: shape.data.code, httpStatus: shape.data.httpStatus, safe } };
    },
  });

export const router = t.router;
export const middleware = t.middleware;
export const mergeRouters = t.mergeRouters;
export const createCallerFactory = t.createCallerFactory;

/** Translates DomainError → TRPCError (keeping the DomainError as `cause` for the formatter) and logs unknowns. */
const errorBoundary = t.middleware(async ({ ctx, next, path, type }) => {
  const result = await next();
  if (!result.ok) {
    const cause = result.error.cause;
    if (cause instanceof DomainError && result.error.code === "INTERNAL_SERVER_ERROR") {
      throw new TRPCError({ code: TRPC_CODE[cause.code], message: cause.safeMessage, cause });
    }
    if (result.error.code === "INTERNAL_SERVER_ERROR") {
      ctx.services.logger.error("unhandled procedure error", {
        path,
        type,
        errorName: cause instanceof Error ? cause.name : "unknown",
      });
    }
  }
  return result;
});

const rateLimited = t.middleware(async ({ ctx, meta, next }) => {
  const category = meta?.rateLimit ?? "api";
  const subject = ctx.session ? `s:${ctx.session.sessionId}` : `ip:${ctx.request.ipAddress ?? "unknown"}`;
  const verdict = await ctx.services.rateLimiter.consume(category, subject);
  if (!verdict.allowed) {
    throw new DomainError("RATE_LIMITED", "RATE_LIMITED", "Too many requests. Please wait a moment and try again.", {
      retryAfterSeconds: verdict.retryAfterSeconds,
    });
  }
  return next();
});

async function recordDenial(ctx: TrpcContext, path: string, reasonCode: string): Promise<void> {
  try {
    await ctx.services.audit.record({
      category: "security",
      eventName: "authz.access.denied",
      action: "authorize",
      outcome: "denied",
      severity: "WARN",
      reasonCode,
      resource: { type: "procedure" },
      attributes: { procedure: path },
    });
  } catch {
    // The request is refused regardless; a denial performs no write that needs audit atomicity.
  }
}

const requireSession = t.middleware(async ({ ctx, next, path }) => {
  if (!ctx.session) {
    await recordDenial(ctx, path, "NO_SESSION");
    throw new DomainError("UNAUTHENTICATED", "NO_SESSION", "Please sign in to continue.");
  }
  return next({ ctx: { ...ctx, session: ctx.session } });
});

const requireFullSession = t.middleware(async ({ ctx, next, path }) => {
  const session = ctx.session;
  if (!session) {
    await recordDenial(ctx, path, "NO_SESSION");
    throw new DomainError("UNAUTHENTICATED", "NO_SESSION", "Please sign in to continue.");
  }
  if (session.state !== "full" || session.pendingSteps.length > 0) {
    await recordDenial(ctx, path, "REMEDIATION_SESSION");
    throw new DomainError(
      "REMEDIATION_REQUIRED",
      "ACCOUNT_STEP_PENDING",
      "Please finish securing your account to continue.",
      { nextStep: session.pendingSteps[0] ?? "unknown" },
    );
  }
  return next({ ctx: { ...ctx, session } });
});

const requireRole = (roles: readonly SessionPrincipal["role"][]) =>
  t.middleware(async ({ ctx, next, path }) => {
    if (!ctx.session || !roles.includes(ctx.session.role)) {
      await recordDenial(ctx, path, "ROLE_NOT_PERMITTED");
      throw new DomainError("FORBIDDEN", "ROLE_NOT_PERMITTED", "You do not have permission to perform this action.");
    }
    return next();
  });

const base = t.procedure.use(errorBoundary).use(rateLimited);

export const publicProcedure = base;
export const sessionProcedure = base.use(requireSession);
export const protectedProcedure = base.use(requireFullSession);
export const staffProcedure = protectedProcedure.use(requireRole(["staff", "admin"]));
export const adminProcedure = protectedProcedure.use(requireRole(["admin"]));

export function hasFreshStepUp(session: SessionPrincipal, now: Date, maxAgeMs = STEP_UP_MAX_AGE_MS): boolean {
  if (!(session.stepUpAt instanceof Date)) return false;
  const age = now.getTime() - session.stepUpAt.getTime();
  // Reject invalid dates and timestamps from the future (small skew tolerance only).
  return Number.isFinite(age) && age >= -5_000 && age <= maxAgeMs;
}

/**
 * Capability gate. Chain after protectedProcedure (or staff/admin):
 *   protectedProcedure.use(requireCapability("orders.reassign"))
 * Enforces the role grant and, for STEP_UP_CAPABILITIES, a fresh step-up.
 */
export const requireCapability = (capability: Capability) =>
  t.middleware(async ({ ctx, next, path }) => {
    const session = ctx.session;
    if (!session || session.state !== "full") {
      await recordDenial(ctx, path, "NO_FULL_SESSION");
      throw new DomainError("UNAUTHENTICATED", "NO_SESSION", "Please sign in to continue.");
    }
    if (!roleHasCapability(session.role, capability)) {
      await recordDenial(ctx, path, "CAPABILITY_NOT_GRANTED");
      throw new DomainError("FORBIDDEN", "CAPABILITY_NOT_GRANTED", "You do not have permission to perform this action.");
    }
    if (STEP_UP_CAPABILITIES.has(capability) && !hasFreshStepUp(session, ctx.services.clock.now())) {
      throw new DomainError(
        "STEP_UP_REQUIRED",
        "STEP_UP_REQUIRED",
        "Please confirm your password and authentication code to continue.",
        { capability },
      );
    }
    return next();
  });
