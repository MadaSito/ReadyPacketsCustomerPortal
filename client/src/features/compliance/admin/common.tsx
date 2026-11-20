/** Compliance console — small shared hooks and components. Owner: orders_engineer (compliance admin UI). */
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { roleHasCapability, type Capability } from "@shared/capabilities";
import { useSession } from "@/lib/session";
import { errorMessage, useTRPC } from "@/lib/trpc";
import { ErrorState, Skeleton, StepUpCancelledError, useStepUp, useToast } from "@/ui";

/** True when the signed-in staff/admin role holds the capability (UI hint only; the server decides). */
export function useCan(capability: Capability): boolean {
  const { me } = useSession();
  const role = me?.user.role;
  return role === "staff" || role === "admin" ? roleHasCapability(role, capability) : false;
}

/**
 * Runs a privileged mutation through step-up, shows a success toast and refreshes compliance queries.
 * Returns an error message (or null on success / when the user cancels step-up).
 */
export function useGuardedAction() {
  const stepUp = useStepUp();
  const toast = useToast();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return async function run<T>(action: () => Promise<T>, options: { reason: string; success: string }): Promise<{ ok: true; value: T } | { ok: false; error: string | null }> {
    try {
      const value = await stepUp.run(action, { reason: options.reason });
      toast.show({ tone: "success", title: options.success });
      await queryClient.invalidateQueries({ queryKey: trpc.compliance.pathKey() });
      return { ok: true, value };
    } catch (err) {
      if (err instanceof StepUpCancelledError) return { ok: false, error: null };
      return { ok: false, error: errorMessage(err) };
    }
  };
}

/** Loading / error wrapper that keeps the page header (single h1) visible. */
export function QueryState({ header, query, children }: { header: ReactNode; query: { isPending: boolean; error: unknown; refetch: () => unknown }; children: () => ReactNode }) {
  if (query.isPending)
    return (
      <>
        {header}
        <Skeleton lines={6} />
      </>
    );
  if (query.error)
    return (
      <>
        {header}
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </>
    );
  return (
    <>
      {header}
      {children()}
    </>
  );
}
