/** Security page card (order 30): where you are signed in, with single and "all others" sign-out. */
import { useMutation, useQuery } from "@tanstack/react-query";
import { MonitorSmartphone } from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";
import { useRefreshSession } from "@/lib/session";
import { errorMessage, useTRPC, type useTRPCClient } from "@/lib/trpc";
import { Badge, Button, Card, ConfirmDialog, DateTime, EmptyState, ErrorState, Skeleton, useToast } from "@/ui";
import { authMethodLabel, placeLabel } from "./labels";

type Overview = Awaited<ReturnType<ReturnType<typeof useTRPCClient>["identity"]["security"]["overview"]["query"]>>;
type Row = Overview["sessions"][number];

export default function ActiveSessionsCard() {
  const trpc = useTRPC();
  const toast = useToast();
  const refreshSession = useRefreshSession();
  const [, navigate] = useLocation();
  const overview = useQuery(trpc.identity.security.overview.queryOptions());
  const revoke = useMutation(trpc.identity.sessions.revoke.mutationOptions());
  const revokeOthers = useMutation(trpc.identity.sessions.revokeOthers.mutationOptions());
  const [target, setTarget] = useState<Row | null>(null);
  const [othersOpen, setOthersOpen] = useState(false);
  const rows = overview.data?.sessions;
  const others = rows?.filter((row) => !row.current).length ?? 0;

  const onRevoke = async () => {
    if (!target) return;
    try {
      await revoke.mutateAsync({ sessionId: target.sessionId });
    } catch (err) {
      toast.show({ tone: "danger", title: "Could not sign out that session", description: errorMessage(err) });
      throw err;
    }
    if (target.current) {
      await refreshSession();
      navigate("/sign-in");
      return;
    }
    toast.show({ tone: "success", title: "Session signed out" });
    await overview.refetch();
  };
  const onRevokeOthers = async () => {
    try {
      const result = await revokeOthers.mutateAsync();
      toast.show({ tone: "success", title: result.revoked === 1 ? "1 other session signed out" : `${result.revoked} other sessions signed out` });
      await overview.refetch();
    } catch (err) {
      toast.show({ tone: "danger", title: "Could not sign out other sessions", description: errorMessage(err) });
      throw err;
    }
  };

  return (
    <Card
      as="section"
      aria-label="Where you're signed in"
      title="Where you're signed in"
      description="Devices and browsers signed in to your account. Sign out any you don't recognise, then change your password."
      actions={<Button size="sm" variant="secondary" disabled={others === 0} onClick={() => setOthersOpen(true)}>Sign out all others</Button>}
    >
      {overview.isPending ? (
        <div role="status"><span className="sr-only">Loading your sessions</span><Skeleton lines={3} /></div>
      ) : overview.isError ? (
        <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
      ) : !rows || rows.length === 0 ? (
        <EmptyState icon={MonitorSmartphone} title="No active sessions" description="Sessions appear here after you sign in." />
      ) : (
        <ul className="flex flex-col divide-y divide-line" aria-label="Active sessions">
          {rows.map((row) => (
            <li key={row.sessionId} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold break-words text-ink">{row.deviceSummary ?? "Unknown device"}</span>
                  {row.current ? <Badge tone="brand">This device</Badge> : null}
                </p>
                <p className="text-sm break-words text-muted">
                  {authMethodLabel(row.authMethod)} · {placeLabel(row.country, row.ipAddress)}
                </p>
                <p className="text-sm text-muted">
                  Signed in <DateTime value={row.createdAt} format="datetime" /> · last active <DateTime value={row.lastSeenAt} format="relative" />
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="self-start sm:self-center"
                onClick={() => setTarget(row)}
                aria-label={row.current ? "Sign out this device" : `Sign out ${row.deviceSummary ?? "unknown device"}`}
              >
                Sign out
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => { if (!open) setTarget(null); }}
        title={target?.current ? "Sign out of this device?" : "Sign out this session?"}
        description={target?.current ? "You will need to sign in again on this device." : "That device will need to sign in again."}
        confirmLabel="Sign out"
        destructive
        onConfirm={onRevoke}
      />
      <ConfirmDialog
        open={othersOpen}
        onOpenChange={setOthersOpen}
        title="Sign out all other sessions?"
        description="Every other device and browser will need to sign in again. This device stays signed in."
        confirmLabel="Sign out others"
        destructive
        onConfirm={onRevokeOthers}
      />
    </Card>
  );
}
