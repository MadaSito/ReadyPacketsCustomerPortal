import { errorMessage } from "@/lib/trpc";
import { StepUpCancelledError, useStepUp, useToast } from "@/ui";

/**
 * Runs a privileged mutation through step-up and reports the outcome. Returns true on success.
 * The server re-verifies the actor, role and step-up inside the write transaction — this is UX only.
 */
export function useGuarded() {
  const stepUp = useStepUp();
  const toast = useToast();
  return async function guarded<T>(action: () => Promise<T>, messages: { success: string; failure: string; reason?: string; onError?: (error: unknown) => void }): Promise<T | undefined> {
    try {
      const result = await stepUp.run(action, { reason: messages.reason ?? "Changing platform settings needs verification." });
      toast.show({ tone: "success", title: messages.success });
      return result;
    } catch (error) {
      if (error instanceof StepUpCancelledError) return undefined;
      messages.onError?.(error);
      toast.show({ tone: "danger", title: messages.failure, description: errorMessage(error) });
      return undefined;
    }
  };
}
