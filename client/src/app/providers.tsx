/** Root providers: QueryClient + tRPC, AuthApi facade, theme, toasts, step-up. */
import { QueryClientProvider, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { AuthApiProvider, ME_QUERY_KEY } from "@/lib/authApi";
import { identityKey, isMeQuery, purgePrivateCache } from "@/lib/cacheIsolation";
import { isUnauthenticated, useSession } from "@/lib/session";
import { onSessionChanged } from "@/lib/sessionTransport";
import { TRPCProvider, createApiClient, createQueryClient } from "@/lib/trpc";
import { StepUpProvider, ThemeProvider, ToastProvider } from "@/ui";

function SessionChangeBridge({ queryClient }: { queryClient: QueryClient }) {
  useEffect(
    () =>
      onSessionChanged(() => {
        // Session replaced or cleared by the server: drop everything cached under the old identity.
        purgePrivateCache(queryClient);
        void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
      }),
    [queryClient],
  );
  return null;
}

/**
 * Scopes the private query cache to the confirmed identity. On an identity/authority change the subtree is
 * withheld for one commit while the cache is purged, so no screen renders a previous identity's data.
 * Any non-identity query failing with UNAUTHENTICATED re-checks identity.me (covers expiry and cross-tab swaps).
 */
export function IdentityScope({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { view, me } = useSession();
  const next = identityKey(me, view.status);
  const [scope, setScope] = useState<string | undefined>(next);
  const pending = next !== undefined && scope !== undefined && next !== scope;

  useLayoutEffect(() => {
    if (next === undefined || next === scope) return;
    if (scope !== undefined) purgePrivateCache(queryClient);
    // Deliberate: the purge is an external side effect that must complete before the subtree re-renders.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setScope(next);
  }, [next, scope, queryClient]);

  useEffect(
    () =>
      queryClient.getQueryCache().subscribe((event) => {
        if (event.type !== "updated" || event.action.type !== "error") return;
        if (isMeQuery(event.query.queryKey) || !isUnauthenticated(event.action.error)) return;
        void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
      }),
    [queryClient],
  );

  return pending ? null : <>{children}</>;
}

export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient);
  const [trpcClient] = useState(createApiClient);
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
          <AuthApiProvider>
            <ToastProvider>
              <StepUpProvider>
                <SessionChangeBridge queryClient={queryClient} />
                <IdentityScope>{children}</IdentityScope>
              </StepUpProvider>
            </ToastProvider>
          </AuthApiProvider>
        </TRPCProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
