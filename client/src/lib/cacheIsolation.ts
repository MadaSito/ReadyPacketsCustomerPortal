/**
 * Private-cache isolation. Every cached query/mutation except identity.me belongs to the identity that
 * fetched it. When the confirmed identity or its authority changes (sign-out, expiry/401, a different user
 * signing in in another tab, role or session-state change), everything else is removed BEFORE routes render
 * under the new identity.
 */
import type { QueryClient } from "@tanstack/react-query";
import { ME_QUERY_KEY, type MeResult } from "./authApi";

export function isMeQuery(queryKey: readonly unknown[]): boolean {
  return queryKey.length === ME_QUERY_KEY.length && ME_QUERY_KEY.every((part, i) => queryKey[i] === part);
}

/** Removes every query except identity.me and every mutation (mutation state can hold secrets/results). */
export function purgePrivateCache(queryClient: QueryClient): void {
  void queryClient.cancelQueries({ predicate: (q) => !isMeQuery(q.queryKey) });
  queryClient.removeQueries({ predicate: (q) => !isMeQuery(q.queryKey) });
  queryClient.getMutationCache().clear();
}

/**
 * Identity + authority key. `undefined` = not yet known (loading or transient error): keep the current scope.
 * "anonymous" = definitively signed out.
 */
export function identityKey(me: MeResult | undefined, status: "loading" | "anonymous" | "remediation" | "full" | "error"): string | undefined {
  if (status === "anonymous") return "anonymous";
  if (!me || status === "loading" || status === "error") return undefined;
  return `${me.user.publicId}|${me.user.role}|${me.state}|${me.nextStep ?? ""}`;
}
