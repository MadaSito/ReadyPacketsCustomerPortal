/** /account/sessions — the signed-in user's device list with single and "all others" revocation. */
import { useMutation, useQuery } from "@tanstack/react-query";
import { MonitorSmartphone } from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";
import { useRefreshSession } from "@/lib/session";
import { errorMessage, useTRPC, type useTRPCClient } from "@/lib/trpc";
import { Badge, Breadcrumbs, Button, ConfirmDialog, DataTable, DateTime, EmptyState, PageHeader, useToast } from "@/ui";

type Sessions = Awaited<ReturnType<ReturnType<typeof useTRPCClient>["identity"]["sessions"]["list"]["query"]>>["items"];
type Row = Sessions[number];

export default function SessionsPage() {
  const trpc = useTRPC();
  const toast = useToast();
  const refreshSession = useRefreshSession();
  const [, navigate] = useLocation();
  const list = useQuery(trpc.identity.sessions.list.queryOptions());
  const revoke = useMutation(trpc.identity.sessions.revoke.mutationOptions());
  const revokeOthers = useMutation(trpc.identity.sessions.revokeOthers.mutationOptions());
  const [target, setTarget] = useState<Row | null>(null);
  const [othersOpen, setOthersOpen] = useState(false);
  const rows = list.data?.items;
  const others = rows?.filter((row) => !row.current).length ?? 0;

  const onRevoke = async () => {
    if (!target) return;
    await revoke.mutateAsync({ sessionId: target.sessionId });
    if (target.current) {
      await refreshSession();
      navigate("/sign-in");
      return;
    }
    toast.show({ tone: "success", title: "Session signed out" });
    await list.refetch();
  };
  const onRevokeOthers = async () => {
    try {
      const result = await revokeOthers.mutateAsync();
      toast.show({ tone: "success", title: result.revoked === 1 ? "1 other session signed out" : `${result.revoked} other sessions signed out` });
      await list.refetch();
    } catch (err) {
      toast.show({ tone: "danger", title: "Could not sign out other sessions", description: errorMessage(err) });
      throw err;
    }
  };

  return (
    <>
      <PageHeader
        breadcrumbs={<Breadcrumbs items={[{ label: "Your account", href: "/account" }, { label: "Sessions" }]} />}
        title="Active sessions"
        description="Devices and browsers currently signed in to your account. Sign out any you don't recognise and change your password."
        actions={<Button variant="secondary" disabled={others === 0} onClick={() => setOthersOpen(true)}>Sign out all other sessions</Button>}
      />
      <DataTable<Row>
        caption="Your active sessions"
        rows={rows}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        rowKey={(row) => row.sessionId}
        columns={[
          {
            key: "device",
            header: "Device",
            primary: true,
            cell: (row) => (
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-ink">{row.deviceSummary ?? "Unknown device"}</span>
                {row.current ? <Badge tone="brand">This device</Badge> : null}
              </span>
            ),
          },
          { key: "createdAt", header: "Signed in", cell: (row) => <DateTime value={row.createdAt} format="datetime" /> },
          { key: "lastSeenAt", header: "Last active", cell: (row) => <DateTime value={row.lastSeenAt} format="relative" /> },
          { key: "expiresAt", header: "Expires", hideOnMobile: true, cell: (row) => <DateTime value={row.expiresAt} format="datetime" /> },
        ]}
        rowActions={(row) => (
          <Button size="sm" variant="ghost" onClick={() => setTarget(row)} aria-label={row.current ? "Sign out this device" : `Sign out ${row.deviceSummary ?? "unknown device"}`}>
            Sign out
          </Button>
        )}
        empty={<EmptyState icon={MonitorSmartphone} title="No active sessions" description="Sessions appear here after you sign in." />}
      />
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
    </>
  );
}
