/**
 * Increment 04 item 13 — console order actions: customer picker, new order for a customer, and access grants
 * for one order or all of a customer's orders. Owner: orders_engineer. The server enforces every rule
 * (capabilities, step-up for grants, feature flag); the UI only hides what the role cannot do.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { roleHasCapability } from "@shared/capabilities";
import { useSession } from "@/lib/session";
import { useFeatureEnabled } from "@/lib/features";
import { errorMessage, useTRPC, useTRPCClient } from "@/lib/trpc";
// Increment 05 (C3): shared discount code field (audit_engineer), imported by /root's direction.
import { PromoCodeField } from "@/features/promotions/PromoCodeField";
import {
  Badge, Button, Callout, DataTable, DateTime, Dialog, Field, Input, Money, RadioGroup, Select, StepUpCancelledError, Textarea, useStepUp, useToast,
} from "@/ui";
import { ACCESS_ROLE_LABELS, money, newIdempotencyKey } from "./shared";

export type PickedCustomer = { publicId: string; name: string; customerRef: string | null; emailMasked: string };

function useDebounced<T>(value: T, ms = 300): T {
  const [current, setCurrent] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setCurrent(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return current;
}

/** Search customers by name, email or customer reference. Emails are masked by the server. */
export function CustomerPicker({ value, onChange, label = "Customer" }: { value: PickedCustomer | null; onChange: (customer: PickedCustomer | null) => void; label?: string }) {
  const trpc = useTRPC();
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query.trim());
  const lookup = useQuery(trpc.orders.admin.customerLookup.queryOptions({ query: debounced }, { enabled: debounced.length >= 2 }));
  if (value)
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-control)] border border-line p-3">
        <span className="flex min-w-0 flex-col">
          <span className="font-semibold break-words text-ink">{value.name}</span>
          <span className="text-sm break-all text-muted">
            {value.emailMasked}
            {value.customerRef ? ` · ${value.customerRef}` : ""}
          </span>
        </span>
        <Button variant="secondary" size="sm" onClick={() => onChange(null)} aria-label={`Change ${label.toLowerCase()}`}>
          Change
        </Button>
      </div>
    );
  const results = lookup.data ?? [];
  return (
    <div className="flex flex-col gap-3">
      <Field label={`Find ${label.toLowerCase()}`} hint="Name, email or customer reference (at least 2 characters).">
        <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} maxLength={120} autoComplete="off" spellCheck={false} />
      </Field>
      {debounced.length >= 2 ? (
        lookup.isPending ? (
          <p className="text-sm text-muted" role="status">
            Searching…
          </p>
        ) : lookup.error ? (
          <Callout tone="danger">{errorMessage(lookup.error)}</Callout>
        ) : results.length === 0 ? (
          <p className="text-sm text-muted" role="status">
            No customers match.
          </p>
        ) : (
          <RadioGroup
            legend={`Matching customers (${results.length})`}
            value=""
            onValueChange={(publicId) => onChange(results.find((row) => row.publicId === publicId) ?? null)}
            options={results.map((row) => ({
              value: row.publicId,
              label: row.name,
              description: `${row.emailMasked}${row.customerRef ? ` · ${row.customerRef}` : ""}`,
            }))}
          />
        )
      ) : null}
    </div>
  );
}

/** New order on behalf of a customer (staff + orders.manage). `customer` fixes the customer (customer tab). */
export function NewOrderForCustomerDialog({ open, ...rest }: { open: boolean; onClose: () => void; customer?: PickedCustomer | null }) {
  // Mounted only while open, so every opening starts with a fresh form and a fresh idempotency key.
  return open ? <NewOrderDialogBody {...rest} /> : null;
}

function NewOrderDialogBody({ onClose, customer: fixed }: { onClose: () => void; customer?: PickedCustomer | null }) {
  const open = true;
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [, navigate] = useLocation();
  const catalog = useQuery(trpc.orders.catalog.list.queryOptions(undefined, { enabled: open }));
  const create = useMutation(trpc.orders.admin.createForCustomer.mutationOptions());
  const [customer, setCustomer] = useState<PickedCustomer | null>(fixed ?? null);
  const [projectName, setProjectName] = useState("");
  const [note, setNote] = useState("");
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey] = useState(newIdempotencyKey);
  const products = (catalog.data ?? []).flatMap((group) => group.products.map((product) => ({ ...product, groupName: group.name })));
  const items = Object.entries(quantities)
    .map(([productPublicId, quantity]) => ({ productPublicId, quantity: Number.parseInt(quantity, 10) }))
    .filter((item) => Number.isInteger(item.quantity) && item.quantity > 0);
  // Increment 05 (C3): a code is judged for the CUSTOMER (forCustomerPublicId) and re-validated at create. Any change
  // of customer or items after applying it un-applies it, so the dialog never sends a code it has not priced.
  const trpcClient = useTRPCClient();
  const promotionsEnabled = useFeatureEnabled("promotions");
  const promoScope = JSON.stringify([customer?.publicId ?? null, items]);
  const [promo, setPromo] = useState<{ code: string; scope: string; label: string; discountMinor: number; currency: string } | null>(null);
  const activePromo = promo && promo.scope === promoScope ? promo : null;
  const applyPromo = async (code: string) => {
    if (!customer || items.length === 0) throw new Error("Choose a customer and at least one item first.");
    const quote = await trpcClient.orders.quoteWithPromo.mutate({ items, promoCode: code, forCustomerPublicId: customer.publicId });
    if (!quote.promo) throw new Error("This code cannot be applied.");
    setPromo({ code, scope: promoScope, label: quote.promo.label, discountMinor: quote.promo.promoDiscountMinor, currency: quote.currency });
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!customer) return setError("Choose a customer.");
    if (!projectName.trim()) return setError("Enter a project name.");
    if (items.length === 0) return setError("Add at least one item.");
    try {
      const order = await create.mutateAsync({ customerPublicId: customer.publicId, projectName: projectName.trim(), items, note: note.trim() || undefined, idempotencyKey, ...(activePromo ? { promoCode: activePromo.code } : {}) });
      await queryClient.invalidateQueries({ queryKey: trpc.orders.pathKey() });
      toast.show({ tone: "success", title: "Order created" });
      onClose();
      navigate(`/admin/orders/${order.publicId}`);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const formId = useId();
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => (!value ? onClose() : undefined)}
      title="New order for a customer"
      description="The customer owns the order and is notified. Prices come from the current catalog."
      size="lg"
      dismissible={!create.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={create.isPending}>
            Create order
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
        {error ? (
          <Callout tone="danger" live="assertive">
            {error}
          </Callout>
        ) : null}
        {fixed ? null : <CustomerPicker value={customer} onChange={setCustomer} />}
        <Field label="Project name" required>
          <Input value={projectName} onChange={(event) => setProjectName(event.target.value)} maxLength={160} />
        </Field>
        {catalog.isPending ? (
          <p role="status" className="text-sm text-muted">
            Loading catalog…
          </p>
        ) : products.length === 0 ? (
          <Callout tone="warning">No active products in the catalog.</Callout>
        ) : (
          <fieldset className="flex min-w-0 flex-col gap-2">
            <legend className="mb-1 text-sm font-semibold text-ink">Items (enter a quantity)</legend>
            <ul className="flex flex-col divide-y divide-line">
              {products.map((product) => (
                <li key={product.publicId} className="flex flex-wrap items-center justify-between gap-3 py-2">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-medium break-words text-ink">{product.name}</span>
                    <span className="text-sm text-muted">
                      {product.groupName} · <Money value={money(product.priceMinor, product.currency)} />
                    </span>
                  </span>
                  <Input
                    className="w-24"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={1000}
                    value={quantities[product.publicId] ?? ""}
                    onChange={(event) => setQuantities((current) => ({ ...current, [product.publicId]: event.target.value }))}
                    aria-label={`Quantity of ${product.name}`}
                  />
                </li>
              ))}
            </ul>
          </fieldset>
        )}
        {promotionsEnabled ? (
          <PromoCodeField
            applied={activePromo ? { label: activePromo.label, discountMinor: activePromo.discountMinor, currency: activePromo.currency } : null}
            onApply={applyPromo}
            onRemove={async () => setPromo(null)}
            disabled={!customer || items.length === 0 || create.isPending}
          />
        ) : null}
        <Field label="Note for the customer" hint="Optional.">
          <Textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={5000} rows={3} />
        </Field>
      </form>
    </Dialog>
  );
}

type Scope = { orderId: string } | { customerPublicId: string };

/** Access for other platform users: one order or all of a customer's orders (present and future). */
export function AccessDialog({ open, onClose, scope, subject }: { open: boolean; onClose: () => void; scope: Scope; subject: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toast = useToast();
  const stepUp = useStepUp();
  const { me } = useSession();
  const role = me?.user.role;
  const canGrant = role === "admin" && roleHasCapability(role, "orders.access.grant");
  const list = useQuery(trpc.orders.admin.access.list.queryOptions(scope, { enabled: open }));
  const grant = useMutation(trpc.orders.admin.access.grant.mutationOptions());
  const revoke = useMutation(trpc.orders.admin.access.revoke.mutationOptions());
  const [email, setEmail] = useState("");
  const [grantRole, setGrantRole] = useState<"viewer" | "contributor">("viewer");
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.orders.admin.access.list.queryKey(scope) });
  const guarded = async (action: () => Promise<unknown>, title: string) => {
    setError(null);
    try {
      await stepUp.run(action, { reason: "Changing who can see orders needs verification." });
      await refresh();
      toast.show({ tone: "success", title });
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      setError(errorMessage(err));
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!email.trim()) return setError("Enter the person's email address.");
    void guarded(async () => {
      await grant.mutateAsync({ scope, email: email.trim(), role: grantRole });
      setEmail("");
    }, "Access granted");
  };
  const customerWide = "customerPublicId" in scope;
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => (!value ? onClose() : undefined)}
      title={customerWide ? `Access to all orders of ${subject}` : `Access to order ${subject}`}
      description={
        customerWide
          ? "People granted here can see every current and future order of this customer. Both parties are notified."
          : "People granted here can see this order. Both parties are notified."
      }
      size="lg"
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        {error ? (
          <Callout tone="danger" live="assertive">
            {error}
          </Callout>
        ) : null}
        <DataTable
          caption="People with access"
          showCaption
          rows={list.data?.items ?? []}
          rowKey={(row) => row.grantId}
          columns={[
            {
              key: "who",
              header: "Person",
              primary: true,
              cell: (row) => (
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium break-words text-ink">{row.granteeName}</span>
                  <span className="text-sm break-all text-muted">{row.granteeEmailMasked}</span>
                </span>
              ),
            },
            { key: "role", header: "Role", cell: (row) => ACCESS_ROLE_LABELS[row.role] ?? row.role },
            { key: "scope", header: "Scope", hideOnMobile: true, cell: (row) => (row.scope === "customer" ? "All orders" : "This order") },
            { key: "status", header: "Status", cell: (row) => <Badge tone={row.status === "active" ? "success" : "neutral"}>{row.status === "active" ? "Active" : "Revoked"}</Badge> },
            { key: "when", header: "Granted", hideOnMobile: true, cell: (row) => <DateTime value={row.grantedAt} format="date" /> },
            {
              key: "actions",
              header: "Actions",
              align: "end",
              cell: (row) =>
                canGrant && row.status === "active" ? (
                  <Button variant="danger" size="sm" loading={revoke.isPending && revoke.variables?.grantId === row.grantId} onClick={() => void guarded(() => revoke.mutateAsync({ grantId: row.grantId }), "Access revoked")} aria-label={`Revoke access for ${row.granteeName}`}>
                    Revoke
                  </Button>
                ) : null,
            },
          ]}
          empty={<p className="text-body">{list.isPending ? "Loading…" : "Nobody else has access."}</p>}
        />
        {canGrant ? (
          <form onSubmit={submit} className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-line p-4" noValidate>
            <h3 className="text-base font-semibold text-ink">Grant access</h3>
            <Field label="Email of an existing platform user" required>
              <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} autoComplete="off" spellCheck={false} />
            </Field>
            <Field label="Role">
              <Select
                value={grantRole}
                onChange={(event) => setGrantRole(event.target.value as "viewer" | "contributor")}
                options={[
                  { value: "viewer", label: "Viewer (can view and download)" },
                  { value: "contributor", label: "Contributor (can also upload and accept)" },
                ]}
              />
            </Field>
            <div>
              <Button type="submit" loading={grant.isPending}>
                Grant access
              </Button>
            </div>
          </form>
        ) : (
          <p className="text-sm text-muted">Only administrators can grant or revoke access.</p>
        )}
      </div>
    </Dialog>
  );
}

/** "New order" button for the console Orders list. */
export function NewOrderForCustomerButton() {
  const { me } = useSession();
  const role = me?.user.role;
  const [open, setOpen] = useState(false);
  if (!role || role === "customer" || !roleHasCapability(role, "orders.manage")) return null;
  return (
    <>
      <Button onClick={() => setOpen(true)}>New order for a customer</Button>
      <NewOrderForCustomerDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** Console customer detail tab: the customer's orders plus the two customer-level actions. */
export default function CustomerOrdersTab({ customerId }: { customerId: string }) {
  const trpc = useTRPC();
  const { me } = useSession();
  const role = me?.user.role;
  const canManage = !!role && role !== "customer" && roleHasCapability(role, "orders.manage");
  const [dialog, setDialog] = useState<"new" | "access" | null>(null);
  const orders = useQuery(trpc.orders.admin.list.queryOptions({ customerPublicId: customerId, limit: 25 }));
  // The host customer page already shows who this is; the dialogs only need the public id.
  const customer: PickedCustomer = { publicId: customerId, name: "this customer", customerRef: null, emailMasked: "Customer shown on this page" };
  const name = "this customer";
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {canManage ? (
          <Button onClick={() => setDialog("new")}>
            New order for this customer
          </Button>
        ) : null}
        <Button variant="secondary" onClick={() => setDialog("access")}>
          Access to all orders
        </Button>
      </div>
      <DataTable
        caption="Orders"
        showCaption
        rows={orders.data?.items ?? []}
        rowKey={(row) => row.publicId}
        columns={[
          {
            key: "ref",
            header: "Order",
            primary: true,
            cell: (row) => (
              <Link className="font-semibold break-all text-action underline-offset-2 hover:underline" href={`/admin/orders/${row.publicId}`}>
                {row.reference}
              </Link>
            ),
          },
          { key: "project", header: "Project", cell: (row) => <span className="break-words">{row.projectName}</span> },
          { key: "status", header: "Status", cell: (row) => row.statusLabel },
          { key: "updated", header: "Updated", hideOnMobile: true, cell: (row) => <DateTime value={row.updatedAt} format="relative" /> },
        ]}
        empty={<p className="text-body">{orders.isPending ? "Loading…" : "No orders yet."}</p>}
      />
      {canManage ? <NewOrderForCustomerDialog open={dialog === "new"} onClose={() => setDialog(null)} customer={customer} /> : null}
      <AccessDialog open={dialog === "access"} onClose={() => setDialog(null)} scope={{ customerPublicId: customerId }} subject={name} />
    </div>
  );
}
