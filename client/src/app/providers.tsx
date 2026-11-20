/** Root providers: QueryClient + tRPC, AuthApi facade, theme, toasts, step-up. */
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { AuthApiProvider, ME_QUERY_KEY } from "@/lib/authApi";
import { onSessionChanged } from "@/lib/sessionTransport";
import { TRPCProvider, createApiClient, createQueryClient } from "@/lib/trpc";
import { StepUpProvider, ThemeProvider, ToastProvider } from "@/ui";

function SessionChangeBridge({ queryClient }: { queryClient: QueryClient }) {
  useEffect(
    () =>
      onSessionChanged(() => {
        // Session replaced or cleared by the server: drop everything cached under the old identity.
        queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== ME_QUERY_KEY[0] });
        void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
      }),
    [queryClient],
  );
  return null;
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
                {children}
              </StepUpProvider>
            </ToastProvider>
          </AuthApiProvider>
        </TRPCProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
