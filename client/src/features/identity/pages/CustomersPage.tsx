/** /admin/customers — searchable customer list and invitation-based creation. */
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { UserPlus, Users } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "wouter";
import { errorMessage, safeError, useTRPC, type useTRPCClient } from "@/lib/trpc";
import {
  Button, Callout, DataTable, DateTime, Dialog, EmailLink, EmptyState, Field, FilterBar, Input, LoadMore, PageHeader, Select,
  StepUpCancelledError, useStepUp, useToast,
} from "@/ui";
import { EMPTY_NAME, NameFields, validateNameParts, type NameErrors, type NameValues } from "../NameFields";
import { PreviewLinkNotice, STATUS_FILTER_OPTIONS, UserStatusBadge, SignInMethodBadges, type UserStatus } from "../shared";

type Page = Awaited<ReturnType<ReturnType<typeof useTRPCClient>["identity"]["admin"]["customers"]["list"]["query"]>>;
type Row = Page["items"][number];

export default function CustomersPage() {
  const trpc = useTRPC();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<UserStatus | "">("");
  const [creating, setCreating] = useState(false);
  const input = { ...(query ? { query } : {}), ...(status ? { status } : {}), limit: 25 };
  const list = useInfiniteQuery(
    trpc.identity.admin.customers.list.infiniteQueryOptions(input, { getNextPageParam: (page) => page.nextCursor ?? undefined }),
  );
  const rows = list.data?.pages.flatMap((page) => page.items);
  const active = (query ? 1 : 0) + (status ? 1 : 0);
  return (
    <>
      <PageHeader
        title="Customers"
        description="Find customer accounts by exact e-mail address, customer reference or the start of a name."
        actions={<Button leadingIcon={<UserPlus className="size-4" aria-hidden />} onClick={() => setCreating(true)}>New customer</Button>}
      />
      <FilterBar
        search={search}
        onSearchChange={setSearch}
        onSearchSubmit={(value) => setQuery(value.trim())}
        searchLabel="Search customers"
        activeCount={active}
        onReset={() => { setSearch(""); setQuery(""); setStatus(""); }}
      >
        <Field label="Status">
          <Select options={STATUS_FILTER_OPTIONS} placeholder="Any status" value={status} onChange={(e) => setStatus(e.target.value as UserStatus | "")} />
        </Field>
      </FilterBar>
      <DataTable<Row>
        caption="Customer accounts"
        rows={rows}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        rowKey={(row) => row.publicId}
        columns={[
          {
            key: "name",
            header: "Customer",
            primary: true,
            cell: (row) => (
              <Link href={`/admin/customers/${row.publicId}`} className="font-semibold text-action underline-offset-2 hover:underline">
                {row.name}
              </Link>
            ),
          },
          { key: "reference", header: "Reference", cell: (row) => row.customerRef ?? "—" },
          { key: "email", header: "E-mail", cell: (row) => <EmailLink email={row.email} /> },
          { key: "status", header: "Status", cell: (row) => <UserStatusBadge status={row.status} /> },
            { key: "signIn", header: "Sign-in method", hideOnMobile: true, cell: (row) => <SignInMethodBadges methods={row.signInMethods} /> },
          { key: "createdAt", header: "Created", hideOnMobile: true, cell: (row) => <DateTime value={row.createdAt} format="date" /> },
        ]}
        empty={
          <EmptyState
            icon={Users}
            title={active ? "No matching customers" : "No customers yet"}
            description={active ? "Try the full e-mail address, a reference prefix or the first letters of a name." : "Create a customer to send them an invitation."}
          />
        }
      />
      <LoadMore
        hasMore={!!list.hasNextPage}
        loading={list.isFetchingNextPage}
        onLoadMore={() => void list.fetchNextPage()}
        summary={rows ? `Showing ${rows.length} customers` : undefined}
      />
      <CreateCustomerDialog open={creating} onOpenChange={setCreating} onCreated={() => void list.refetch()} />
    </>
  );
}

function CreateCustomerDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: () => void }) {
  const trpc = useTRPC();
  const toast = useToast();
  const stepUp = useStepUp();
  const create = useMutation(trpc.identity.admin.customers.create.mutationOptions());
  const [email, setEmail] = useState("");
  const [names, setNames] = useState<NameValues>(EMPTY_NAME);
  const [nameErrors, setNameErrors] = useState<NameErrors>({});
  const [reference, setReference] = useState("");
  const [errors, setErrors] = useState<{ email?: string; customerRef?: string; form?: string }>({});
  const [result, setResult] = useState<{ customerId: string; customerRef: string | null; previewLink?: string } | null>(null);

  const reset = () => { setEmail(""); setNames(EMPTY_NAME); setNameErrors({}); setReference(""); setErrors({}); setResult(null); };
  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const found: typeof errors = {};
    if (!email.includes("@")) found.email = "Enter the customer's e-mail address.";
    const nameCheck = validateNameParts(names, "their");
    setNameErrors(nameCheck.ok ? {} : nameCheck.errors);
    setErrors(found);
    if (Object.keys(found).length || !nameCheck.ok) return;
    try {
      const created = await stepUp.run(() =>
        create.mutateAsync({ email, ...nameCheck.data, ...(reference.trim() ? { customerRef: reference.trim() } : {}) }),
      );
      setResult(created);
      onCreated();
      toast.show({ tone: "success", title: "Customer created", description: "An invitation e-mail is on its way." });
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      const safe = safeError(err);
      const fields = safe?.fieldErrors ?? {};
      if (safe?.reasonCode === "EMAIL_IN_USE") setErrors({ email: safe.safeMessage });
      else if (safe?.reasonCode === "REFERENCE_IN_USE") setErrors({ customerRef: safe.safeMessage });
      else if (Object.keys(fields).length) {
        setErrors({ email: fields.email?.[0], customerRef: fields.customerRef?.[0] });
        setNameErrors({ firstName: fields.firstName?.[0], lastName: fields.lastName?.[0], preferredName: fields.preferredName?.[0] });
      }
      else setErrors({ form: errorMessage(err) });
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) reset(); onOpenChange(next); }}
      title={result ? "Customer created" : "New customer"}
      description={result ? undefined : "The customer receives an invitation to set their password and secure their account."}
      size="md"
    >
      {result ? (
        <div className="flex flex-col gap-4">
          <Callout tone="success" title="Invitation sent">
            {result.customerRef ? `Customer reference ${result.customerRef}.` : null}
          </Callout>
          <PreviewLinkNotice path={result.previewLink} what="activation" />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={() => { reset(); onOpenChange(false); }}>Close</Button>
            <Button asChild><Link href={`/admin/customers/${result.customerId}`}>View customer</Link></Button>
          </div>
        </div>
      ) : (
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          {errors.form ? <Callout tone="danger" live="assertive">{errors.form}</Callout> : null}
          <Field label="E-mail address" required error={errors.email}>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" inputMode="email" maxLength={254} />
          </Field>
          <NameFields value={names} onChange={setNames} errors={nameErrors} subject="their" />
          <Field label="Customer reference" hint="Optional. Leave blank to generate one (format RPCUS- followed by 9 letters or digits). Letters, digits and single hyphens." error={errors.customerRef}>
            <Input value={reference} onChange={(e) => setReference(e.target.value.toUpperCase())} autoComplete="off" maxLength={32} />
          </Field>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={() => { reset(); onOpenChange(false); }}>Cancel</Button>
            <Button type="submit" loading={create.isPending}>Create and invite</Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
