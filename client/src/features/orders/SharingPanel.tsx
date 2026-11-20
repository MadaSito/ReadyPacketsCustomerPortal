/** Order sharing management (owner, or staff with orders.manage). Owner: orders_engineer. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Users } from "lucide-react";
import { useState, type FormEvent } from "react";
import { errorMessage, useTRPC } from "@/lib/trpc";
import { Badge, Button, Callout, ConfirmDialog, DataTable, DateTime, EmptyState, Field, Input, RadioGroup, Section, useToast } from "@/ui";

const STATUS_LABEL: Record<string, string> = { pending: "Invited", active: "Active", declined: "Declined", revoked: "Revoked", expired: "Expired" };
const STATUS_TONE = { pending: "info", active: "success", declined: "neutral", revoked: "neutral", expired: "warning" } as const;

export function SharingPanel({ orderId, canShare, locked }: { orderId: string; canShare: boolean; locked: boolean }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toast = useToast();
  const grants = useQuery(trpc.orders.sharing.list.queryOptions({ orderId }, { enabled: canShare }));
  const invite = useMutation(trpc.orders.sharing.invite.mutationOptions());
  const revoke = useMutation(trpc.orders.sharing.revoke.mutationOptions());
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"viewer" | "contributor">("viewer");
  const [emailError, setEmailError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [toRevoke, setToRevoke] = useState<{ publicId: string; email: string | null } | null>(null);

  if (!canShare)
    return (
      <Section title="Sharing">
        <p className="text-body">Only the order owner can manage who has access to this order.</p>
      </Section>
    );

  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.orders.sharing.list.queryKey({ orderId }) });
  const onInvite = async (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 254) {
      setEmailError("Enter a valid e-mail address.");
      return;
    }
    setEmailError(undefined);
    try {
      await invite.mutateAsync({ orderId, email: value, role });
      setEmail("");
      // The server answers identically whether or not the address has an account (no account oracle).
      toast.show({ tone: "success", title: "Invitation recorded", description: "If that address has a verified ReadyPackets account, its owner can accept the invitation from their orders page." });
      await refresh();
    } catch (error) {
      setFormError(errorMessage(error));
    }
  };

  return (
    <Section title="Sharing" description="Invite people to view or contribute to this order. Invitations must be accepted by a verified account using the same e-mail address.">
      <div className="flex flex-col gap-6">
        {locked ? <Callout tone="info">This order is locked. You can still revoke access, but new invitations may be refused.</Callout> : null}
        <form onSubmit={onInvite} noValidate className="flex max-w-xl flex-col gap-4">
          {formError ? (
            <Callout tone="danger" live="assertive" title="Invitation not sent">
              {formError}
            </Callout>
          ) : null}
          <Field label="E-mail address" required error={emailError}>
            <Input type="email" autoComplete="off" inputMode="email" maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} />
          </Field>
          <RadioGroup
            legend="Access"
            value={role}
            onValueChange={(value) => setRole(value === "contributor" ? "contributor" : "viewer")}
            options={[
              { value: "viewer", label: "Viewer", description: "Can see the order, its messages and files." },
              { value: "contributor", label: "Contributor", description: "Can also add notes, messages and files. Cannot share or change status." },
            ]}
          />
          <div>
            <Button type="submit" loading={invite.isPending}>
              Send invitation
            </Button>
          </div>
        </form>
        <DataTable
          caption="People with access"
          rows={grants.data}
          loading={grants.isPending}
          error={grants.error}
          onRetry={() => void grants.refetch()}
          rowKey={(grant) => grant.publicId}
          columns={[
            { key: "email", header: "E-mail", primary: true, cell: (grant) => <span className="break-all">{grant.email ?? "Unavailable"}</span> },
            { key: "role", header: "Access", cell: (grant) => (grant.role === "contributor" ? "Contributor" : "Viewer") },
            { key: "status", header: "Status", cell: (grant) => <Badge tone={STATUS_TONE[grant.status]}>{STATUS_LABEL[grant.status] ?? grant.status}</Badge> },
            { key: "createdAt", header: "Invited", hideOnMobile: true, cell: (grant) => <DateTime value={grant.createdAt} format="date" /> },
          ]}
          rowActions={(grant) =>
            grant.status === "pending" || grant.status === "active" ? (
              <Button size="sm" variant="ghost" onClick={() => setToRevoke({ publicId: grant.publicId, email: grant.email })}>
                Revoke{" "}<span className="sr-only">access for {grant.email ?? "this person"}</span>
              </Button>
            ) : null
          }
          empty={<EmptyState icon={Users} title="Not shared" description="Only you and ReadyPackets can see this order." headingLevel={3} />}
        />
      </div>
      <ConfirmDialog
        open={toRevoke !== null}
        onOpenChange={(open) => (open ? undefined : setToRevoke(null))}
        destructive
        title="Revoke access?"
        description={`${toRevoke?.email ?? "This person"} will lose access immediately, including any download links already issued.`}
        confirmLabel="Revoke access"
        onConfirm={async () => {
          if (!toRevoke) return;
          try {
            await revoke.mutateAsync({ orderId, grantId: toRevoke.publicId });
          } catch (error) {
            toast.show({ tone: "danger", title: "Could not revoke access", description: errorMessage(error) });
            throw error;
          }
          toast.show({ tone: "success", title: "Access revoked" });
          setToRevoke(null);
          await refresh();
        }}
      />
    </Section>
  );
}
