import { useLocation, useSearch } from "wouter";
import type { TransitionStep } from "@shared/domain";
import { homeFor, safeNextPath, stepPath } from "@/app/guard";
import { useRefreshSession } from "@/lib/session";
import type { UserRole } from "@shared/domain";

/** After a step completes: refresh identity.me and go to the next step, the safe `next` path, or home. */
export function useContinueAfterAuth() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const refresh = useRefreshSession();
  return async (nextStep: TransitionStep | null, role?: UserRole) => {
    await refresh();
    if (nextStep) {
      navigate(stepPath(nextStep), { replace: true });
      return;
    }
    const next = safeNextPath(new URLSearchParams(search).get("next"));
    navigate(next ?? homeFor(role ?? "customer"), { replace: true });
  };
}
