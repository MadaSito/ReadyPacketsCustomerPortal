import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage, useTRPC } from "@/lib/trpc";
import { Button, Callout, ConfirmDialog, StepUpCancelledError, useStepUp } from "@/ui";

export function EndCustomerSessions() {
  const trpc = useTRPC();
  const stepUp = useStepUp();
  const endAll = useMutation(trpc.jobs.admin.endCustomerSessions.mutationOptions());
  const [open, setOpen] = useState(false);
  const [ended, setEnded] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setError(null);
    try {
      const result = await stepUp.run(() => endAll.mutateAsync(),
        { reason: "Ending customer sessions requires fresh verification." });
      setEnded(result.ended);
    } catch (failure) {
      if (failure instanceof StepUpCancelledError) return;
      setError(errorMessage(failure));
      throw failure;
    }
  }

  return <div className="grid min-w-0 justify-items-start gap-3 border-t border-line pt-4">
    <p className="text-sm text-muted">Existing customer sessions stay signed in unless you end them separately.</p>
    <Button variant="danger" onClick={() => { setEnded(null); setError(null); setOpen(true); }}>End customer sessions now</Button>
    {ended !== null ? <Callout tone="success" live="polite">{ended} customer {ended === 1 ? "session ended" : "sessions ended"}.</Callout> : null}
    {open ? <ConfirmDialog open onOpenChange={setOpen} destructive confirmText="END CUSTOMER SESSIONS"
      title="End all customer sessions?" confirmLabel="End customer sessions"
      description="This immediately signs out all customers. It will not end staff or administrator sessions, or change the maintenance schedule."
      onConfirm={confirm}>
      {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
    </ConfirmDialog> : null}
  </div>;
}
