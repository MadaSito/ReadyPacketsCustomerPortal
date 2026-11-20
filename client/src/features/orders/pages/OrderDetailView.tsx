/**
 * Order detail host for both areas: overview, activity, notes, sharing, and every ORDER_TABS contribution.
 * Owner: orders_engineer. The server decides visibility (customer view never contains internal notes).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Suspense, useState, type FormEvent } from "react";
import { useLocation, useParams } from "wouter";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@server/trpc/root";
import { ORDER_TABS } from "@/app/registry";
import { errorMessage, useTRPC } from "@/lib/trpc";
import {
  Breadcrumbs, Button, Callout, Card, DataTable, DateTime, Dialog, ErrorState, Field, KeyValueList, Money, PageHeader, Select,
  Skeleton, Spinner, Tabs, Textarea, useToast,
} from "@/ui";
import { ConsoleActions } from "../ConsoleActions";
import { SharingPanel } from "../SharingPanel";
import { ACCESS_ROLE_LABELS, LOCK_DESCRIPTIONS, LockBadge, OrderStatusBadge, money, type LockState } from "../shared";

type Area = "customer" | "console";

export function OrderDetailView({ area }: { area: Area }) {
  const { orderId = "", tab } = useParams<{ orderId: string; tab?: string }>();
  const [, navigate] = useLocation();
  const trpc = useTRPC();
  const consoleArea = area === "console";
  const base = consoleArea ? "/admin/orders" : "/orders";
  const customerQuery = useQuery(trpc.orders.get.queryOptions({ orderId }, { enabled: !consoleArea }));
  const consoleQuery = useQuery(trpc.orders.admin.get.queryOptions({ orderId }, { enabled: consoleArea }));
  const query = consoleArea ? consoleQuery : customerQuery;
  const crumbs = [{ label: "Orders", href: base }];

  if (query.isPending)
    return (
      <>
        <PageHeader breadcrumbs={<Breadcrumbs items={[...crumbs, { label: "Loading" }]} />} title="Loading order…" />
        <Skeleton lines={6} />
      </>
    );
  if (query.error || !query.data)
    return (
      <>
        <PageHeader breadcrumbs={<Breadcrumbs items={[...crumbs, { label: "Unavailable" }]} />} title="Order unavailable" />
        <ErrorState error={query.error} title="We couldn't open this order" message="It may not exist, or you may not have access to it." onRetry={() => void query.refetch()} />
      </>
    );

  const order = query.data;
  const lockState = order.lockState as LockState;
  const builtIn = [
    { value: "overview", label: "Overview", content: <Overview order={order} area={area} /> },
    { value: "activity", label: "Activity", content: <Activity order={order} area={area} /> },
    { value: "sharing", label: "Sharing", content: <SharingPanel orderId={order.publicId} canShare={order.canShare} locked={lockState !== "none"} /> },
  ];
  const contributed = ORDER_TABS.filter((t) => t.access === "customer" || consoleArea).map((t) => {
    const Component = t.component;
    const Badge = t.badge;
    return {
      value: t.key,
      label: t.label,
      badge: Badge ? <Badge orderId={order.publicId} area={area} /> : undefined,
      content: (
        <Suspense fallback={<Spinner label={`Loading ${t.label}`} />}>
          <Component orderId={order.publicId} area={area} />
        </Suspense>
      ),
    };
  });
  const items = [...builtIn, ...contributed];
  const active = items.some((item) => item.value === tab) ? tab! : "overview";

  return (
    <>
      <PageHeader
        breadcrumbs={<Breadcrumbs items={[...crumbs, { label: order.reference }]} />}
        title={order.projectName}
        description={`Order ${order.reference}`}
        meta={
          <span className="flex flex-wrap gap-2">
            <OrderStatusBadge label={order.statusLabel} tone={order.statusTone} />
            <LockBadge state={lockState} />
          </span>
        }
        actions={<TransitionControl order={order} />}
      />
      {lockState !== "none" ? (
        <div className="mb-4">
          <Callout tone={lockState === "legal_hold" ? "warning" : "info"} title={undefined}>
            {LOCK_DESCRIPTIONS[lockState]}
          </Callout>
        </div>
      ) : null}
      {consoleArea ? (
        <div className="mb-6">
          <ConsoleActions orderId={order.publicId} version={order.version} lockState={lockState} reference={order.reference} />
        </div>
      ) : null}
      <Tabs
        label="Order sections"
        value={active}
        onValueChange={(value) => navigate(value === "overview" ? `${base}/${order.publicId}` : `${base}/${order.publicId}/${value}`, { replace: true })}
        items={items}
      />
    </>
  );
}

type OrderDetail = inferRouterOutputs<AppRouter>["orders"]["get"];

function Overview({ order, area }: { order: OrderDetail; area: Area }) {
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card title="Summary" className="lg:col-span-1">
        <KeyValueList
          columns={1}
          items={[
            { label: "Reference", value: <span className="break-all">{order.reference}</span> },
            { label: "Status", value: <OrderStatusBadge label={order.statusLabel} tone={order.statusTone} /> },
            { label: "Placed", value: <DateTime value={order.submittedAt ?? order.createdAt} format="datetime" /> },
            { label: "Last updated", value: <DateTime value={order.updatedAt} format="relative" /> },
            { label: "Your access", value: ACCESS_ROLE_LABELS[order.accessRole] ?? order.accessRole },
            ...(area === "console" && order.origin === "import" ? [{ label: "Origin", value: "Imported" }] : []),
            { label: "Total", value: <Money value={money(order.totalMinor, order.currency)} /> },
          ]}
        />
      </Card>
      <div className="min-w-0 lg:col-span-2">
        <DataTable
          caption="Items"
          showCaption
          rows={order.lineItems}
          rowKey={(item) => item.publicId}
          columns={[
            {
              key: "name",
              header: "Item",
              primary: true,
              cell: (item) => (
                <span className="flex min-w-0 flex-col">
                  <span className="font-semibold break-words text-ink">{item.name}</span>
                  {item.description ? <span className="text-sm break-words text-muted">{item.description}</span> : null}
                </span>
              ),
            },
            { key: "quantity", header: "Quantity", align: "end", cell: (item) => item.quantity },
            { key: "unit", header: "Unit price", align: "end", hideOnMobile: true, cell: (item) => <Money value={money(item.unitPriceMinor, item.currency)} /> },
            { key: "total", header: "Line total", align: "end", cell: (item) => <Money value={money(item.lineTotalMinor, item.currency)} /> },
          ]}
          empty={<p className="text-body">This order has no items.</p>}
        />
      </div>
    </div>
  );
}

function Activity({ order, area }: { order: OrderDetail; area: Area }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toast = useToast();
  const addNote = useMutation(trpc.orders.addNote.mutationOptions());
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState<"customer" | "internal">(area === "console" ? "internal" : "customer");
  const [error, setError] = useState<string | undefined>();
  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!body.trim()) return setError("Write a note first.");
    setError(undefined);
    try {
      await addNote.mutateAsync({ orderId: order.publicId, body: body.trim(), visibility: area === "console" ? visibility : undefined });
      setBody("");
      toast.show({ tone: "success", title: "Note added" });
      await queryClient.invalidateQueries({ queryKey: trpc.orders.pathKey() });
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Notes">
        {order.canWrite ? (
          <form onSubmit={onSubmit} noValidate className="mb-4 flex flex-col gap-3">
            <Field label="Add a note" error={error} hint={area === "console" ? undefined : "ReadyPackets and everyone with access to this order can read it."}>
              <Textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={5000} rows={4} />
            </Field>
            {area === "console" ? (
              <Field label="Visible to">
                <Select
                  value={visibility}
                  onChange={(event) => setVisibility(event.target.value === "customer" ? "customer" : "internal")}
                  options={[
                    { value: "internal", label: "Staff only (internal)" },
                    { value: "customer", label: "Customer and staff" },
                  ]}
                />
              </Field>
            ) : null}
            <div>
              <Button type="submit" loading={addNote.isPending}>
                Add note
              </Button>
            </div>
          </form>
        ) : null}
        {order.notes.length === 0 ? (
          <p className="text-body">No notes yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {order.notes.map((note) => (
              <li key={note.publicId} className="py-3">
                <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
                  <span>{note.mine ? "You" : note.authorRole === "customer" ? "Customer" : "ReadyPackets"}</span>
                  <DateTime value={note.createdAt} format="datetime" />
                  {note.visibility === "internal" ? <span className="font-semibold text-warning">Internal</span> : null}
                </p>
                <p className="mt-1 break-words whitespace-pre-wrap text-body">{note.body}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Status history">
        <ol className="flex flex-col gap-3">
          {order.history.map((entry) => (
            <li key={entry.publicId} className="flex flex-col">
              <span className="text-ink">
                {entry.fromLabel ? `${entry.fromLabel} → ${entry.toLabel}` : entry.toLabel}
              </span>
              <span className="text-sm text-muted">
                <DateTime value={entry.occurredAt} format="datetime" /> · {entry.actorRole === "customer" ? "Customer" : entry.actorRole === "readypackets" ? "ReadyPackets" : (ACCESS_ROLE_LABELS[entry.actorRole] ?? entry.actorRole)}
              </span>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}

function TransitionControl({ order }: { order: OrderDetail }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toast = useToast();
  const transition = useMutation(trpc.orders.transition.mutationOptions());
  const [target, setTarget] = useState<{ to: string; label: string; requiresNote: boolean } | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (order.transitions.length === 0) return null;
  const submit = async () => {
    if (!target) return;
    if (target.requiresNote && !note.trim()) return setError("A note is required for this change.");
    setError(null);
    try {
      await transition.mutateAsync({ orderId: order.publicId, expectedVersion: order.version, toStatus: target.to, note: note.trim() || undefined });
      toast.show({ tone: "success", title: `Status changed to ${target.label}` });
      setTarget(null);
      setNote("");
      await queryClient.invalidateQueries({ queryKey: trpc.orders.pathKey() });
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {order.transitions.map((option) => (
          <Button key={option.to} variant="secondary" onClick={() => (setTarget(option), setNote(""), setError(null))}>
            {option.label}
          </Button>
        ))}
      </div>
      <Dialog
        open={target !== null}
        onOpenChange={(open) => (open ? undefined : setTarget(null))}
        title={target ? `Change status to “${target.label}”?` : "Change status"}
        description="Everyone with access to the order will be notified."
        footer={
          <Button loading={transition.isPending} onClick={() => void submit()}>
            Confirm
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? (
            <Callout tone="danger" live="assertive">
              {error}
            </Callout>
          ) : null}
          <Field label={target?.requiresNote ? "Note" : "Note (optional)"} required={target?.requiresNote}>
            <Textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={5000} rows={4} />
          </Field>
        </div>
      </Dialog>
    </>
  );
}
