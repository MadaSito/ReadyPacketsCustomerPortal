/** /admin/customers/:customerId — customer summary, lifecycle actions, reference history and CUSTOMER_TABS. */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useParams } from "wouter";
import { CUSTOMER_TABS } from "@/app/registry";
import { useSession } from "@/lib/session";
import { errorMessage, safeError, useTRPC, type useTRPCClient } from "@/lib/trpc";
import {
  Badge, Breadcrumbs, Button, Callout, Card, ConfirmDialog, DataTable, DateTime, Dialog, DropdownMenu, ErrorState, Field,
  Input, KeyValueList, PageHeader, Select, Skeleton, StepUpCancelledError, Tabs, useStepUp, useToast,
} from "@/ui";
import { PreviewLinkNotice, REFERENCE_REASONS, UserStatusBadge } from "../shared";
import { StatusDialog, type StatusTarget } from "./StatusActions";

type Detail = Awaited<ReturnType<ReturnType<typeof useTRPCClient>["identity"]["admin"]["customers"]["get"]["query"]>>;
type HistoryRow = Detail["referenceHistory"][number];

const TAB_ACCESS = { customer: ["customer", "staff", "admin"], staff: ["staff", "admin"], admin: ["admin"] } as const;

export default function CustomerDetailPage() {
  const { customerId = "" } = useParams<{ customerId: string }>();
  const trpc = useTRPC();
  const toast = useToast();
  const stepUp = useStepUp();
  const { me } = useSession();
  const viewerRole = me?.user.role ?? "staff";
  const isAdmin = viewerRole === "admin";
  const detail = useQuery(trpc.identity.admin.customers.get.queryOptions({ customerId }));
  const setStatus = useMutation(trpc.identity.admin.customers.setStatus.mutationOptions());
  const resend = useMutation(trpc.identity.admin.customers.resendInvitation.mutationOptions());
  const revokeSessions = useMutation(trpc.identity.admin.users.revokeSessions.mutationOptions());
  const [statusTarget, setStatusTarget] = useState<StatusTarget | null>(null);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [previewLink, setPreviewLink] = useState<string>();

  const crumbs = (label: string) => <Breadcrumbs items={[{ label: "Customers", href: "/admin/customers" }, { label }]} />;
  if (detail.isPending) {
    return (
      <>
        <PageHeader breadcrumbs={crumbs("Loading")} title="Customer" />
        <div role="status" className="flex flex-col gap-3"><span className="sr-only">Loading customer</span><Skeleton lines={5} /></div>
      </>
    );
  }
  if (!detail.data) {
    return <><PageHeader breadcrumbs={crumbs("Not available")} title="Customer" /><ErrorState error={detail.error} onRetry={() => void detail.refetch()} /></>;
  }
  const { customer, activeSessions, referenceHistory } = detail.data;

  const run = async <T,>(action: () => Promise<T>, success: string): Promise<T | undefined> => {
    try {
      const result = await stepUp.run(action);
      toast.show({ tone: "success", title: success });
      await detail.refetch();
      return result;
    } catch (err) {
      if (err instanceof StepUpCancelledError) return undefined;
      toast.show({ tone: "danger", title: "Action not completed", description: errorMessage(err) });
      throw err;
    }
  };

  const menu = [
    ...(customer.status === "pending_activation"
      ? [{ label: "Resend invitation", onSelect: () => void run(() => resend.mutateAsync({ customerId }), "Invitation sent").then((r) => setPreviewLink(r?.previewLink)).catch(() => undefined) }]
      : []),
    { label: "Change reference", onSelect: () => setReferenceOpen(true) },
    { label: "Sign out all sessions", onSelect: () => setRevokeOpen(true), disabled: activeSessions === 0 },
    "separator" as const,
    ...(customer.status === "active" || customer.status === "pending_activation"
      ? [{ label: "Suspend account", destructive: true, onSelect: () => setStatusTarget("suspended") }]
      : [{ label: "Reactivate account", onSelect: () => setStatusTarget("active") }]),
    ...(customer.status !== "deactivated" ? [{ label: "Deactivate account", destructive: true, onSelect: () => setStatusTarget("deactivated") }] : []),
  ];

  const tabs = CUSTOMER_TABS.filter((tab) => (TAB_ACCESS[tab.access] as readonly string[]).includes(viewerRole));

  return (
    <>
      <PageHeader
        breadcrumbs={crumbs(customer.name)}
        title={customer.name}
        meta={<span className="flex flex-wrap items-center gap-2"><UserStatusBadge status={customer.status} />{customer.customerRef ? <Badge tone="neutral">{customer.customerRef}</Badge> : null}</span>}
        actions={isAdmin ? <DropdownMenu trigger={<Button variant="secondary">Manage account</Button>} items={menu} align="end" /> : undefined}
      />
      <div className="flex min-w-0 flex-col gap-6">
        <PreviewLinkNotice path={previewLink} what="activation" />
        {customer.mustChangePassword ? <Callout tone="info">The customer must choose a new password at their next sign-in.</Callout> : null}
        <div className="grid min-w-0 gap-6 lg:grid-cols-3">
          <Card title="Summary" className="lg:col-span-2">
            <KeyValueList
              columns={2}
              items={[
                { label: "E-mail address", value: <span className="break-all">{customer.email}</span> },
                { label: "E-mail verified", value: customer.emailVerified ? "Yes" : "Not yet" },
                { label: "Customer reference", value: customer.customerRef ?? "—" },
                { label: "Created", value: <DateTime value={customer.createdAt} format="datetime" /> },
                { label: "Password set", value: customer.hasPassword ? "Yes" : "No" },
                { label: "Active sessions", value: String(activeSessions) },
                ...(customer.statusChangedAt ? [{ label: "Status changed", value: <DateTime value={customer.statusChangedAt} format="datetime" /> }] : []),
                ...(customer.statusReasonCode ? [{ label: "Status reason", value: customer.statusReasonCode.replaceAll("_", " ").toLowerCase() }] : []),
              ]}
            />
          </Card>
          <Card title="Reference history" flush>
            <DataTable<HistoryRow>
              caption="Customer reference history"
              rows={referenceHistory}
              rowKey={(row) => `${row.newReference}-${String(row.changedAt)}`}
              columns={[
                { key: "newReference", header: "Reference", primary: true, cell: (row) => row.newReference },
                { key: "previous", header: "Previous", cell: (row) => row.previousReference ?? "—" },
                { key: "changedAt", header: "Changed", cell: (row) => <DateTime value={row.changedAt} format="date" /> },
              ]}
              empty={<p className="p-4 text-sm text-muted">No reference changes.</p>}
            />
          </Card>
        </div>
        {tabs.length > 0 ? (
          <Tabs
            label="Customer sections"
            items={tabs.map((tab) => ({ value: tab.key, label: tab.label, content: <tab.component customerId={customerId} /> }))}
            defaultValue={tabs[0]!.key}
          />
        ) : null}
      </div>
      <StatusDialog
        target={statusTarget}
        onOpenChange={(open) => { if (!open) setStatusTarget(null); }}
        onConfirm={async (status, reasonCode) => {
          await run(() => setStatus.mutateAsync({ customerId, status, reasonCode }), status === "active" ? "Account reactivated" : status === "suspended" ? "Account suspended" : "Account deactivated");
        }}
      />
      <ConfirmDialog
        open={revokeOpen}
        onOpenChange={setRevokeOpen}
        title="Sign out all of this customer's sessions?"
        description="Every device the customer is signed in on will need to sign in again."
        confirmLabel="Sign out sessions"
        destructive
        onConfirm={async () => { await run(() => revokeSessions.mutateAsync({ userId: customerId }), "Sessions signed out"); }}
      />
      <ReferenceDialog
        open={referenceOpen}
        onOpenChange={setReferenceOpen}
        customerId={customerId}
        current={customer.customerRef}
        version={customer.version}
        onChanged={() => void detail.refetch()}
      />
    </>
  );
}

function ReferenceDialog({ open, onOpenChange, customerId, current, version, onChanged }: {
  open: boolean; onOpenChange: (open: boolean) => void; customerId: string; current: string | null; version: number; onChanged: () => void;
}) {
  const trpc = useTRPC();
  const toast = useToast();
  const stepUp = useStepUp();
  const change = useMutation(trpc.identity.admin.customers.changeReference.mutationOptions());
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState(REFERENCE_REASONS[0]!.value);
  const [error, setError] = useState<string>();
  const close = () => { setReference(""); setError(undefined); onOpenChange(false); };
  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!reference.trim()) return setError("Enter the new reference.");
    try {
      await stepUp.run(() => change.mutateAsync({ customerId, newReference: reference.trim(), expectedVersion: version, reasonCode: reason }), {
        reason: "Changing a customer reference needs verification.",
      });
      toast.show({ tone: "success", title: "Reference changed" });
      onChanged();
      close();
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      setError(safeError(err)?.fieldErrors?.newReference?.[0] ?? errorMessage(err));
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())} title="Change customer reference"
      description={`Current reference: ${current ?? "none"}. The old reference is retired permanently and can never be reused.`}>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <Field label="New reference" required error={error} hint="3–32 letters, digits or single hyphens.">
          <Input value={reference} onChange={(e) => setReference(e.target.value.toUpperCase())} autoComplete="off" maxLength={32} />
        </Field>
        <Field label="Reason">
          <Select options={REFERENCE_REASONS} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={close}>Cancel</Button>
          <Button type="submit" loading={change.isPending}>Change reference</Button>
        </div>
      </form>
    </Dialog>
  );
}
