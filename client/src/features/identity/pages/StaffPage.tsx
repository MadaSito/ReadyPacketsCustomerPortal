/** /admin/staff — staff and administrator accounts: invite, change role, suspend/reactivate (step-up). */
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { ShieldCheck, UserPlus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useSession } from "@/lib/session";
import { errorMessage, safeError, useTRPC, type useTRPCClient } from "@/lib/trpc";
import {
  Badge, Button, Callout, DataTable, DateTime, Dialog, DropdownMenu, EmailLink, EmptyState, Field, FilterBar, IconButton, Input, LoadMore,
  PageHeader, RadioGroup, Select, StepUpCancelledError, useStepUp, useToast,
} from "@/ui";
import { MoreHorizontal } from "lucide-react";
import { EMPTY_NAME, NameFields, validateNameParts, type NameErrors, type NameValues } from "../NameFields";
import { PreviewLinkNotice, ROLE_LABELS, STATUS_FILTER_OPTIONS, UserStatusBadge, SignInMethodBadges, type UserStatus } from "../shared";
import { StatusDialog, type StatusTarget } from "./StatusActions";

type Page = Awaited<ReturnType<ReturnType<typeof useTRPCClient>["identity"]["admin"]["staff"]["list"]["query"]>>;
type Row = Page["items"][number];

export default function StaffPage() {
  const trpc = useTRPC();
  const toast = useToast();
  const stepUp = useStepUp();
  const { me } = useSession();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<UserStatus | "">("");
  const [creating, setCreating] = useState(false);
  const [roleTarget, setRoleTarget] = useState<Row | null>(null);
  const [statusTarget, setStatusTarget] = useState<{ row: Row; status: StatusTarget } | null>(null);
  const [previewLink, setPreviewLink] = useState<string>();
  const input = { ...(query ? { query } : {}), ...(status ? { status } : {}), limit: 25 };
  const list = useInfiniteQuery(trpc.identity.admin.staff.list.infiniteQueryOptions(input, { getNextPageParam: (page) => page.nextCursor ?? undefined }));
  const setStaffStatus = useMutation(trpc.identity.admin.staff.setStatus.mutationOptions());
  const resend = useMutation(trpc.identity.admin.staff.resendInvitation.mutationOptions());
  const rows = list.data?.pages.flatMap((page) => page.items);
  const self = me?.user.publicId;

  const run = async <T,>(action: () => Promise<T>, success: string): Promise<T | undefined> => {
    try {
      const result = await stepUp.run(action);
      toast.show({ tone: "success", title: success });
      await list.refetch();
      return result;
    } catch (err) {
      if (err instanceof StepUpCancelledError) return undefined;
      toast.show({ tone: "danger", title: "Action not completed", description: errorMessage(err) });
      throw err;
    }
  };

  return (
    <>
      <PageHeader
        title="Staff and administrators"
        description="People who operate ReadyPackets. Role and status changes sign the person out everywhere and need your verification."
        actions={<Button leadingIcon={<UserPlus className="size-4" aria-hidden />} onClick={() => setCreating(true)}>Invite staff member</Button>}
      />
      <div className="flex min-w-0 flex-col gap-4">
        <PreviewLinkNotice path={previewLink} what="activation" />
        <FilterBar search={search} onSearchChange={setSearch} onSearchSubmit={(v) => setQuery(v.trim())} searchLabel="Search staff"
          activeCount={(query ? 1 : 0) + (status ? 1 : 0)} onReset={() => { setSearch(""); setQuery(""); setStatus(""); }}>
          <Field label="Status">
            <Select options={STATUS_FILTER_OPTIONS} placeholder="Any status" value={status} onChange={(e) => setStatus(e.target.value as UserStatus | "")} />
          </Field>
        </FilterBar>
        <DataTable<Row>
          caption="Staff accounts"
          rows={rows}
          loading={list.isPending}
          error={list.error}
          onRetry={() => void list.refetch()}
          rowKey={(row) => row.publicId}
          columns={[
            {
              key: "name", header: "Name", primary: true,
              cell: (row) => <span className="flex flex-wrap items-center gap-2"><span className="font-semibold text-ink">{row.name}</span>{row.publicId === self ? <Badge tone="brand">You</Badge> : null}</span>,
            },
            { key: "email", header: "E-mail", cell: (row) => <EmailLink email={row.email} /> },
            { key: "role", header: "Role", cell: (row) => <Badge tone={row.role === "admin" ? "info" : "neutral"}>{ROLE_LABELS[row.role]}</Badge> },
            { key: "status", header: "Status", cell: (row) => <UserStatusBadge status={row.status} /> },
            { key: "signIn", header: "Sign-in method", hideOnMobile: true, cell: (row) => <SignInMethodBadges methods={row.signInMethods} /> },
            { key: "createdAt", header: "Added", hideOnMobile: true, cell: (row) => <DateTime value={row.createdAt} format="date" /> },
          ]}
          rowActions={(row) =>
            row.publicId === self ? null : (
              <DropdownMenu
                align="end"
                trigger={<IconButton label={`Actions for ${row.name}`} icon={<MoreHorizontal className="size-5" aria-hidden />} variant="ghost" />}
                items={[
                  { label: "Change role", onSelect: () => setRoleTarget(row) },
                  ...(row.status === "pending_activation"
                    ? [{ label: "Resend invitation", onSelect: () => void run(() => resend.mutateAsync({ userId: row.publicId }), "Invitation sent").then((r) => setPreviewLink(r?.previewLink)).catch(() => undefined) }]
                    : []),
                  "separator" as const,
                  ...(row.status === "suspended" || row.status === "deactivated"
                    ? [{ label: "Reactivate", onSelect: () => setStatusTarget({ row, status: "active" }) }]
                    : [{ label: "Suspend", destructive: true, onSelect: () => setStatusTarget({ row, status: "suspended" }) }]),
                  ...(row.status !== "deactivated" ? [{ label: "Deactivate", destructive: true, onSelect: () => setStatusTarget({ row, status: "deactivated" }) }] : []),
                ]}
              />
            )
          }
          empty={<EmptyState icon={ShieldCheck} title="No matching staff" description="Invite a colleague to help operate ReadyPackets." />}
        />
        <LoadMore hasMore={!!list.hasNextPage} loading={list.isFetchingNextPage} onLoadMore={() => void list.fetchNextPage()} summary={rows ? `Showing ${rows.length} people` : undefined} />
      </div>
      <InviteStaffDialog open={creating} onOpenChange={setCreating} onCreated={(link) => { setPreviewLink(link); void list.refetch(); }} />
      <RoleDialog row={roleTarget} onOpenChange={(open) => { if (!open) setRoleTarget(null); }} onChanged={() => void list.refetch()} />
      <StatusDialog
        target={statusTarget?.status ?? null}
        onOpenChange={(open) => { if (!open) setStatusTarget(null); }}
        onConfirm={async (next, reasonCode) => {
          if (!statusTarget) return;
          await run(() => setStaffStatus.mutateAsync({ userId: statusTarget.row.publicId, status: next, reasonCode }), next === "active" ? "Account reactivated" : "Account updated");
        }}
      />
    </>
  );
}

function InviteStaffDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (previewLink?: string) => void }) {
  const trpc = useTRPC();
  const toast = useToast();
  const stepUp = useStepUp();
  const create = useMutation(trpc.identity.admin.staff.create.mutationOptions());
  const [email, setEmail] = useState("");
  const [names, setNames] = useState<NameValues>(EMPTY_NAME);
  const [nameErrors, setNameErrors] = useState<NameErrors>({});
  const [role, setRole] = useState<"staff" | "admin">("staff");
  const [errors, setErrors] = useState<{ email?: string; form?: string }>({});
  const close = () => { setEmail(""); setNames(EMPTY_NAME); setNameErrors({}); setRole("staff"); setErrors({}); onOpenChange(false); };
  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const found: typeof errors = {};
    if (!email.includes("@")) found.email = "Enter their e-mail address.";
    const nameCheck = validateNameParts(names, "their");
    setNameErrors(nameCheck.ok ? {} : nameCheck.errors);
    setErrors(found);
    if (Object.keys(found).length || !nameCheck.ok) return;
    try {
      const result = await stepUp.run(() => create.mutateAsync({ email, ...nameCheck.data, role }), { reason: "Adding staff needs verification." });
      toast.show({ tone: "success", title: "Invitation sent" });
      onCreated(result.previewLink);
      close();
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      const safe = safeError(err);
      if (safe?.reasonCode === "EMAIL_IN_USE") setErrors({ email: safe.safeMessage });
      else setErrors({ form: errorMessage(err) });
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())} title="Invite staff member"
      description="They receive an invitation to set a password and enrol multi-factor verification.">
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {errors.form ? <Callout tone="danger" live="assertive">{errors.form}</Callout> : null}
        <Field label="E-mail address" required error={errors.email}>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" inputMode="email" maxLength={254} />
        </Field>
        <NameFields value={names} onChange={setNames} errors={nameErrors} subject="their" />
        <RadioGroup
          legend="Role"
          variant="cards"
          value={role}
          onValueChange={(v) => setRole(v as "staff" | "admin")}
          options={[
            { value: "staff", label: "Staff", description: "Works on customer orders and support." },
            { value: "admin", label: "Administrator", description: "Full access, including security, staff and platform settings." },
          ]}
        />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={close}>Cancel</Button>
          <Button type="submit" loading={create.isPending}>Send invitation</Button>
        </div>
      </form>
    </Dialog>
  );
}

function RoleDialog({ row, onOpenChange, onChanged }: { row: Row | null; onOpenChange: (open: boolean) => void; onChanged: () => void }) {
  const trpc = useTRPC();
  const toast = useToast();
  const stepUp = useStepUp();
  const change = useMutation(trpc.identity.admin.staff.changeRole.mutationOptions());
  const [role, setRole] = useState<"customer" | "staff" | "admin" | "">("");
  const [error, setError] = useState<string>();
  const close = () => { setRole(""); setError(undefined); onOpenChange(false); };
  const selected = role || row?.role || "staff";
  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!row) return;
    try {
      await stepUp.run(() => change.mutateAsync({ userId: row.publicId, role: selected, expectedVersion: row.version }), {
        reason: "Changing a role needs verification.",
      });
      toast.show({ tone: "success", title: "Role changed", description: "They were signed out and must sign in again." });
      onChanged();
      close();
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      setError(errorMessage(err));
    }
  };
  return (
    <Dialog open={row !== null} onOpenChange={(next) => (next ? onOpenChange(true) : close())} title={row ? `Change role for ${row.name}` : "Change role"}
      description="Changing a role signs the person out on every device.">
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
        <Field label="Role">
          <Select
            value={selected}
            onChange={(e) => setRole(e.target.value as "customer" | "staff" | "admin")}
            options={[{ value: "staff", label: "Staff" }, { value: "admin", label: "Administrator" }, { value: "customer", label: "Customer (removes console access)" }]}
          />
        </Field>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={close}>Cancel</Button>
          <Button type="submit" loading={change.isPending}>Change role</Button>
        </div>
      </form>
    </Dialog>
  );
}
