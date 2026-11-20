/**
 * Pure route-guard decision (unit-tested for every session state). The SERVER is the authority; this only
 * decides which screen to show. A remediation session is always sent to the screen of its nextStep and can
 * never see data screens; a full session never sees transition screens; no decision can loop.
 */
import type { TransitionStep, UserRole } from "@shared/domain";
import type { RouteAccess } from "@/lib/routes";

export type SessionView =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "error" }
  | { status: "remediation"; role: UserRole; nextStep: TransitionStep }
  | { status: "full"; role: UserRole };

/** Canonical screen per transition step (first entry) plus other screens that may legitimately host it. */
export const STEP_PATHS: Record<TransitionStep, readonly string[]> = {
  verify_email: ["/verify-email"],
  mfa_challenge: ["/mfa"],
  enroll_mfa: ["/mfa/enrol"],
  // Enrolment shows the freshly issued codes inline; /mfa/recovery-codes handles reissue after a lost response.
  acknowledge_recovery_codes: ["/mfa/recovery-codes", "/mfa/enrol"],
  change_password: ["/change-password"],
};

export function stepPath(step: TransitionStep): string {
  return STEP_PATHS[step][0]!;
}

/** Public entry screens a signed-in visitor should not see (they are redirected onward). */
export const AUTH_ENTRY_PATHS = new Set(["/sign-in", "/register", "/forgot-password"]);

/** Public pages that also make sense for any session (token links, legal pages). */
export function homeFor(role: UserRole): string {
  return role === "customer" ? "/" : "/admin";
}

export type GuardDecision =
  | { kind: "render" }
  | { kind: "loading" }
  | { kind: "redirect"; to: string }
  | { kind: "not-found" }
  | { kind: "unavailable" };

/** Only same-app absolute paths are accepted as a post-sign-in destination (no open redirect). */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\") || raw.length > 512) return null;
  if ([...raw].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) return null;
  const pathOnly = raw.split(/[?#]/)[0]!;
  if (AUTH_ENTRY_PATHS.has(pathOnly) || Object.values(STEP_PATHS).some((p) => p.includes(pathOnly))) return null;
  return raw;
}

export function decideRoute(access: RouteAccess, path: string, session: SessionView): GuardDecision {
  if (session.status === "loading") return { kind: "loading" };
  if (access === "public") {
    if (!AUTH_ENTRY_PATHS.has(path)) return { kind: "render" };
    if (session.status === "full") return { kind: "redirect", to: homeFor(session.role) };
    if (session.status === "remediation") return { kind: "redirect", to: stepPath(session.nextStep) };
    return { kind: "render" };
  }
  if (session.status === "error") return { kind: "unavailable" };
  if (session.status === "anonymous") {
    const next = safeNextPath(path);
    return { kind: "redirect", to: next && next !== "/" ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in" };
  }
  if (session.status === "remediation") {
    const allowed = STEP_PATHS[session.nextStep];
    if (access === "transition" && allowed.includes(path)) return { kind: "render" };
    return { kind: "redirect", to: allowed[0]! };
  }
  // full session
  if (access === "transition") return { kind: "redirect", to: homeFor(session.role) };
  if (access === "customer") return { kind: "render" };
  if (access === "staff") return session.role === "staff" || session.role === "admin" ? { kind: "render" } : { kind: "not-found" };
  return session.role === "admin" ? { kind: "render" } : { kind: "not-found" };
}
