/** /admin/sessions — the session centre: live sessions across all accounts, with forced ends (admin, step-up). */
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { MonitorSmartphone, MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { Link, useSearch } from "wouter";
import { useSession } from "@/lib/session";
import { errorMessage, useTRPC, type useTRPCClient } from "@/lib/trpc";
import {
  Badge, Button, ConfirmDialog, DataTable, DateTime, DropdownMenu, EmailLink, EmptyState, Field, FilterBar, IconButton, Input, LoadMore, PageHeader, Select,
  StepUpCancelledError, useStepUp, useToast,
} from "@/ui";
import { ROLE_LABELS } from "../shared";
import { AUTH_METHOD_OPTIONS, END_REASONS, ROLE_OPTIONS, authMethodLabel, placeLabel } from "../security/labels";

type Page = Awaited<ReturnType<ReturnType<typeof useTRPCClient>["identity"]["admin"]["sessions"]["list"]["query"]>>;
type Row = Page["items"][number];
type Role = "customer" | "staff" | "admin";
type Method = "local" | "saml" | "entra";
type Pending = { kind: "one"; row: Row } | { kind: "user"; row: Row } | { kind: "customers" };

const PUBLIC_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export default function AdminSessionsPage() {
  const trpc = useTRPC();
  const toast = useToast();
  const stepUp = useStepUp();
  const { me } = useSession();
  const isAdmin = me?.user.role === "admin";
  const search = useSearch();
  const requestedUser = new URLSearchParams(search).get("user") ?? "";
  const userId = PUBLIC_ID.test(requestedUser) ? requestedUser : "";
  const [role, setRole] = useState<Role | "">("");
  const [method, setMethod] = useState<Method | "">("");
  const [country, setCountry] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState<string>(END_REASONS[0].value);
  const code = country.trim().toUpperCase();
  const input = {
    ...(role ? { role } : {}), ...(method ? { authMethod: method } : {}), ...(/^[A-Z]{2}$/.test(code) ? { country: code } : {}),
    ...(userId ? { userId } : {}), limit: 50,
  };
  const list = useInfiniteQuery(trpc.identity.admin.sessions.list.infiniteQueryOptions(input, { getNextPageParam: (page) => page.nextCursor ?? undefined }));
  const end = useMutation(trpc.identity.admin.sessions.end.mutationOptions());
  const endForUser = useMutation(trpc.identity.admin.sessions.endForUser.mutationOptions());
  const endAllCustomers = useMutation(trpc.identity.admin.sessions.endAllCustomers.mutationOptions());
  const rows = list.data?.pages.flatMap((page) => page.items);
  const active = (role ? 1 : 0) + (method ? 1 : 0) + (input.country ? 1 : 0);

  const onConfirm = async () => {
    if (!pending) return;
    try {
      if (pending.kind === "one") {
        await stepUp.run(() => end.mutateAsync({ sessionId: pending.row.sessionId, reasonCode: reason }), { reason: "Confirm it's you to end this session." });
        toast.show({ tone: "success", title: "Session ended" });
      } else if (pending.kind === "user") {
        const result = await stepUp.run(() => endForUser.mutateAsync({ userId: pending.row.user.publicId, reasonCode: reason }), { reason: "Confirm it's you to end these sessions." });
        toast.show({ tone: "success", title: result.ended === 1 ? "1 session ended" : `${result.ended} sessions ended` });
      } else {
        const result = await stepUp.run(() => endAllCustomers.mutateAsync({ reasonCode: reason }), { reason: "Confirm it's you to sign out every customer." });
        toast.show({ tone: "success", title: result.ended === 1 ? "1 customer session ended" : `${result.ended} customer sessions ended` });
      }
      setPending(null);
      await list.refetch();
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.show({ tone: "danger", title: "Could not end sessions", description: errorMessage(err) });
      throw err;
    }
  };

  const dialogTitle = pending?.kind === "one" ? "End this session?" : pending?.kind === "user" ? `End every session for ${pending.row.user.name}?` : "Sign out every customer?";
  const dialogDescription = pending?.kind === "customers"
    ? "Every customer is signed out on every device and must sign in again. Staff and administrator sessions are not affected."
    : "The device must sign in again. The user is not notified and their account stays active.";

  return (
    <>
      <PageHeader
        title="Session centre"
        description="Everyone currently signed in. Ending a session signs that device out at its next request."
        actions={isAdmin ? <Button variant="danger" onClick={() => { setReason(END_REASONS[0].value); setPending({ kind: "customers" }); }}>Sign out all customers</Button> : undefined}
      />
      {userId ? (
        <p className="mb-3 text-sm text-muted">
          Showing one account's sessions. <Link href="/admin/sessions" className="font-semibold text-action underline underline-offset-2">Show everyone</Link>
        </p>
      ) : null}
      <FilterBar activeCount={active} onReset={() => { setRole(""); setMethod(""); setCountry(""); }}>
        <Field label="Role">
          <Select options={ROLE_OPTIONS} placeholder="Any role" value={role} onChange={(e) => setRole(e.target.value as Role | "")} />
        </Field>
        <Field label="Sign-in method">
          <Select options={AUTH_METHOD_OPTIONS} placeholder="Any method" value={method} onChange={(e) => setMethod(e.target.value as Method | "")} />
        </Field>
        <Field label="Country" hint="Two-letter code, for example US">
          <Input value={country} onChange={(e) => setCountry(e.target.value)} maxLength={2} autoComplete="off" className="uppercase" />
        </Field>
      </FilterBar>
      <DataTable<Row>
        caption="Live sessions"
        rows={rows}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        rowKey={(row) => row.sessionId}
        columns={[
          {
            key: "user",
            header: "Account",
            primary: true,
            cell: (row) => (
              <span className="flex min-w-0 flex-col">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-ink">{row.user.name}</span>
                  <Badge tone={row.user.role === "customer" ? "neutral" : "info"}>{ROLE_LABELS[row.user.role]}</Badge>
                  {row.current ? <Badge tone="brand">You, this device</Badge> : null}
                </span>
                <EmailLink email={row.user.email} className="text-sm" />
              </span>
            ),
          },
          { key: "device", header: "Device", cell: (row) => row.deviceSummary ?? "Unknown device" },
          { key: "method", header: "Method", hideOnMobile: true, cell: (row) => authMethodLabel(row.authMethod) },
          { key: "place", header: "Location", cell: (row) => <span className="break-all">{placeLabel(row.country, row.ipAddress)}</span> },
          { key: "lastSeenAt", header: "Last active", cell: (row) => <DateTime value={row.lastSeenAt} format="relative" /> },
          { key: "createdAt", header: "Signed in", hideOnMobile: true, cell: (row) => <DateTime value={row.createdAt} format="datetime" /> },
        ]}
        rowActions={isAdmin ? (row) => (
          <DropdownMenu
            trigger={<IconButton variant="ghost" size="sm" label={`Actions for ${row.user.name}'s session`} icon={<MoreHorizontal aria-hidden />} />}
            items={[
              ...(row.current ? [] : [{ label: "End this session", destructive: true, onSelect: () => { setReason(END_REASONS[0].value); setPending({ kind: "one", row }); } }]),
              { label: "End all sessions for this account", onSelect: () => { setReason(END_REASONS[0].value); setPending({ kind: "user", row }); } },
              ...(userId ? [] : [{ label: "Show only this account", asChild: <Link href={`/admin/sessions?user=${row.user.publicId}`}>Show only this account</Link> }]),
            ]}
          />
        ) : undefined}
        empty={<EmptyState icon={MonitorSmartphone} title={active ? "No matching sessions" : "Nobody is signed in"} description={active ? "Try removing a filter." : "Sessions appear here as people sign in."} />}
      />
      <LoadMore hasMore={!!list.hasNextPage} loading={list.isFetchingNextPage} onLoadMore={() => void list.fetchNextPage()} summary={rows ? `Showing ${rows.length} sessions` : undefined} />
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => { if (!open) setPending(null); }}
        title={dialogTitle}
        description={dialogDescription}
        confirmLabel={pending?.kind === "customers" ? "Sign out all customers" : "End sessions"}
        destructive
        confirmText={pending?.kind === "customers" ? "SIGN OUT CUSTOMERS" : undefined}
        onConfirm={onConfirm}
      >
        <Field label="Reason" hint="Recorded in the audit log.">
          <Select options={END_REASONS} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </ConfirmDialog>
    </>
  );
}
