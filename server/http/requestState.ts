/**
 * Per-request state shared between the HTTP pipeline and module raw routes. Owner: integrator (/root) —
 * populated by the http_security pipeline (server/http/app.ts), consumed by module `http.ts` files.
 *
 * Raw routes (uploads, downloads, exports) MUST obtain identity through these helpers and then re-check
 * capability + resource scope in their module service, exactly like tRPC procedures.
 */
import type { Request } from "express";
import { STEP_UP_CAPABILITIES, roleHasCapability, type Capability } from "../../shared/capabilities.js";
import { DomainError } from "../core/errors.js";
import type { RequestContext, SessionPrincipal, SessionTransport } from "../core/types.js";

export interface HttpRequestState {
  context: RequestContext;
  session: SessionPrincipal | null;
  transport: SessionTransport;
  /** Per-response CSP nonce. */
  cspNonce: string;
}

const states = new WeakMap<Request, HttpRequestState>();

export function setHttpState(req: Request, state: HttpRequestState): void {
  states.set(req, state);
}

export function getHttpState(req: Request): HttpRequestState {
  const state = states.get(req);
  if (!state) throw new Error("HTTP pipeline did not initialize request state");
  return state;
}

/** Full (non-remediation) session or a DomainError the pipeline renders as a safe JSON error. */
export function requireFullSession(req: Request): SessionPrincipal {
  const { session } = getHttpState(req);
  if (!session) throw new DomainError("UNAUTHENTICATED", "NO_SESSION", "Please sign in to continue.");
  if (session.state !== "full" || session.pendingSteps.length > 0) {
    throw new DomainError("REMEDIATION_REQUIRED", "ACCOUNT_STEP_PENDING", "Please finish securing your account to continue.");
  }
  return session;
}

export function requireHttpCapability(req: Request, capability: Capability, now: Date, stepUpMaxAgeMs = 10 * 60 * 1000): SessionPrincipal {
  const session = requireFullSession(req);
  if (!roleHasCapability(session.role, capability)) {
    throw new DomainError("FORBIDDEN", "CAPABILITY_NOT_GRANTED", "You do not have permission to perform this action.");
  }
  if (STEP_UP_CAPABILITIES.has(capability) && !(session.stepUpAt && now.getTime() - session.stepUpAt.getTime() <= stepUpMaxAgeMs)) {
    throw new DomainError("STEP_UP_REQUIRED", "STEP_UP_REQUIRED", "Please confirm your password and authentication code to continue.", { capability });
  }
  return session;
}
