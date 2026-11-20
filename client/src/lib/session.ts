/**
 * Current-session hook shared by the guard, shells and auth screens. Owner: UI foundation engineer.
 * Backed by identity.me (sessionProcedure: throws UNAUTHENTICATED without a session).
 *   const { view, me, refresh } = useSession();
 *   const refresh = useRefreshSession();   // after any call that changes session state
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { SessionView } from "@/app/guard";
import { ME_QUERY_KEY, useAuthApi, type MeResult } from "./authApi";
import { safeError } from "./trpc";

export function isUnauthenticated(error: unknown): boolean {
  return safeError(error)?.domainCode === "UNAUTHENTICATED";
}

export function toSessionView(me: MeResult | undefined, error: unknown, pending: boolean): SessionView {
  if (me) {
    if (me.state === "remediation" && me.nextStep) return { status: "remediation", role: me.user.role, nextStep: me.nextStep };
    if (me.state === "full") return { status: "full", role: me.user.role };
    // Inconsistent payload: fail closed (treat as signed-out view rather than granting data screens).
    return { status: "anonymous" };
  }
  if (pending) return { status: "loading" };
  if (isUnauthenticated(error)) return { status: "anonymous" };
  return { status: "error" };
}

export function useSession() {
  const api = useAuthApi();
  const query = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: () => api.me(),
    staleTime: 30_000,
    retry: (count, error) => !isUnauthenticated(error) && count < 2,
  });
  const queryClient = useQueryClient();
  const refresh = useCallback(() => queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY }), [queryClient]);
  // A 401 after previously being signed in keeps stale data in TanStack; prefer error state when it's UNAUTHENTICATED.
  const me = query.error && isUnauthenticated(query.error) ? undefined : query.data;
  return { view: toSessionView(me, query.error, query.isPending), me, refresh, query };
}

export function useRefreshSession(): () => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(() => queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY }), [queryClient]);
}
