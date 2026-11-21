/** Account page card: link or unlink a Microsoft Entra ID account (step-up + Microsoft re-authentication). */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage, useTRPC } from "@/lib/trpc";
import { Badge, Button, Callout, Card, ConfirmDialog, DateTime, StepUpCancelledError, useStepUp, useToast } from "@/ui";

export function SsoLinkCard() {
  const trpc = useTRPC();
  const toast = useToast();
  const stepUp = useStepUp();
  const link = useQuery(trpc.identity.sso.myLink.queryOptions());
  const prepare = useMutation(trpc.identity.sso.prepare.mutationOptions());
  const unlink = useMutation(trpc.identity.sso.unlinkSelf.mutationOptions());
  const [confirming, setConfirming] = useState(false);
  const data = link.data;
  if (!data || (!data.available && !data.linked && !data.pendingAdministratorBinding)) return null;

  const onLink = async () => {
    try {
      const { startUrl } = await stepUp.run(() => prepare.mutateAsync({ purpose: "link", next: "/account" }), { reason: "Confirm it's you before linking a Microsoft account." });
      window.location.assign(startUrl);
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.show({ tone: "danger", title: "Could not start linking", description: errorMessage(err) });
    }
  };
  const onUnlink = async () => {
    try {
      await stepUp.run(() => unlink.mutateAsync(), { reason: "Confirm it's you before unlinking your Microsoft account." });
      toast.show({ tone: "success", title: "Microsoft account unlinked" });
      await link.refetch();
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.show({ tone: "danger", title: "Could not unlink", description: errorMessage(err) });
      throw err;
    }
  };

  return (
    <Card
      title="Microsoft single sign-on"
      description="Sign in with your organization's Microsoft account instead of your password."
      actions={data.linked ? <Badge tone="success">Linked</Badge> : data.pendingAdministratorBinding ? <Badge tone="warning">Waiting for first sign-in</Badge> : <Badge tone="neutral">Not linked</Badge>}
    >
      <div className="flex flex-col gap-3">
        {data.linked ? (
          <p className="text-sm text-muted">
            Linked {data.linkedAt ? <DateTime value={data.linkedAt} format="date" /> : null}
            {data.lastSignInAt ? <> · last used <DateTime value={data.lastSignInAt} format="relative" /></> : null}
          </p>
        ) : null}
        {data.pendingAdministratorBinding ? (
          <Callout tone="info">An administrator linked a Microsoft account to you. It becomes active the first time you use “Sign in with SSO”.</Callout>
        ) : null}
        {!data.hasPassword && data.linked ? <p className="text-sm text-muted">Your account signs in only with Microsoft, so it cannot be unlinked here.</p> : null}
        <div className="flex flex-col gap-2 sm:flex-row">
          {!data.linked && !data.pendingAdministratorBinding && data.available ? (
            <Button onClick={() => void onLink()} loading={prepare.isPending}>Link Microsoft account</Button>
          ) : null}
          {(data.linked || data.pendingAdministratorBinding) && data.hasPassword ? (
            <Button variant="secondary" onClick={() => setConfirming(true)}>Unlink</Button>
          ) : null}
        </div>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Unlink your Microsoft account?"
        description="You will sign in with your e-mail and password. Other sessions that used Microsoft will be signed out."
        confirmLabel="Unlink"
        destructive
        onConfirm={onUnlink}
      />
    </Card>
  );
}
