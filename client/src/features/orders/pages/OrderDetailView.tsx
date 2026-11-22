/**
 * Order detail host for both areas: overview, activity, notes, sharing, and every ORDER_TABS contribution.
 * Owner: orders_engineer. The server decides visibility (customer view never contains internal notes).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Suspense, useState, type FormEvent, type ReactNode } from "react";
import { useParams } from "wouter";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@server/trpc/root";
import { FEATURES, ORDER_TABS } from "@/app/registry";
import { errorMessage, useTRPC } from "@/lib/trpc";
import {
  Badge, Breadcrumbs, Button, Callout, Card, DataTable, DateTime, Dialog, ErrorState, Field, KeyValueList, Money, PageHeader, Select,
  RouteTabPanel, RouteTabs, Skeleton, Spinner, Textarea, formatDateTime, useToast, type Tone,
} from "@/ui";
import { ConsoleActions, ReferenceHistory } from "../ConsoleActions";
import { SharingPanel } from "../SharingPanel";
import { WorkflowRulesPanel } from "../WorkflowRulesPanel";
import { ACCESS_ROLE_LABELS, LOCK_DESCRIPTIONS, LockBadge, OrderStatusBadge, money, type LockState } from "../shared";

type Area = "customer" | "console";

/** Part B: full-width banners contributed by other features (e.g. the acceptance gate), between header and tabs. */
const ORDER_BANNERS = FEATURES.flatMap((feature) => feature.orderBanners ?? []).sort((a, b) => a.order - b.order);

export function OrderDetailView({ area }: { area: Area }) {
  const { orderId = "", tab } = useParams<{ orderId: string; tab?: string }>();
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
  const tabs = orderTabItems(order, area);
  // The old "Activity" URL keeps working: it now opens Notes.
  const requested = tab === "activity" ? "notes" : tab;
  const active = tabs.some((item) => item.value === requested) ? requested! : "overview";
  const header = consoleArea ? order.console : null;
  const placed = formatDateTime(order.submittedAt ?? order.createdAt, "date");
  const description = consoleArea
    ? [order.reference, header?.customer?.name ?? "Customer unavailable", `placed ${placed}`].join(" · ")
    : `Order ${order.reference}`;

  return (
    <>
      <PageHeader
        breadcrumbs={<Breadcrumbs items={[...crumbs, { label: order.reference }]} />}
        title={order.projectName}
        description={description}
        meta={
          <span className="flex flex-wrap items-center gap-2">
            <OrderStatusBadge label={order.statusLabel} tone={order.statusTone} />
            <LockBadge state={lockState} />
            {header?.payment ? <Badge tone={PAYMENT_TONES[header.payment.state]}>{PAYMENT_LABELS[header.payment.state]}</Badge> : null}
            {consoleArea ? (
              <Badge tone="neutral">
                Total <Money value={money(order.totalMinor, order.currency)} />
              </Badge>
            ) : null}
          </span>
        }
        actions={consoleArea ? undefined : <TransitionControl order={order} />}
      />
      {consoleArea ? (
        <div className="mb-6 flex flex-col gap-2">
          <ConsoleActions orderId={order.publicId} version={order.version} lockState={lockState} reference={order.reference} name={order.projectName} />
          <TransitionControl order={order} />
        </div>
      ) : null}
      {lockState !== "none" ? (
        <div className="mb-4">
          <Callout tone={lockState === "legal_hold" ? "warning" : "info"} title={undefined}>
            {LOCK_DESCRIPTIONS[lockState]}
          </Callout>
        </div>
      ) : null}
      {consoleArea ? null : <WorkflowRulesPanel orderId={order.publicId} area={area} />}
      {ORDER_BANNERS.filter((b) => b.area === "both" || b.area === area).map((b) => {
        const Banner = b.component;
        return (
          <Suspense key={b.key} fallback={null}>
            <Banner orderId={order.publicId} area={area} />
          </Suspense>
        );
      })}
      <RouteTabs
        idBase="order-tabs"
        label="Order sections"
        value={active}
        items={tabs.map((item) => ({
          value: item.value,
          label: item.label,
          href: item.value === "overview" ? `${base}/${order.publicId}` : `${base}/${order.publicId}/${item.value}`,
          labelContent: item.labelContent,
        }))}
      />
      <RouteTabPanel idBase="order-tabs" value={active} className="mt-4">
        {tabs.find((item) => item.value === active)?.content}
      </RouteTabPanel>
    </>
  );
}

type OrderDetail = inferRouterOutputs<AppRouter>["orders"]["get"];
type ConsoleDetail = inferRouterOutputs<AppRouter>["orders"]["admin"]["get"];
type PaymentState = NonNullable<NonNullable<ConsoleDetail["console"]>["payment"]>["state"];

const PAYMENT_LABELS: Record<PaymentState, string> = {
  unpaid: "Unpaid",
  paid: "Paid",
  partially_refunded: "Partially refunded",
  refunded: "Refunded",
  void: "Void",
};
const PAYMENT_TONES: Record<PaymentState, Tone> = {
  unpaid: "warning",
  paid: "success",
  partially_refunded: "info",
  refunded: "neutral",
  void: "neutral",
};

/**
 * B1 tab order. Built-in and contributed tabs share one ordering (numbers published to the tab owners):
 * Overview 0, Phases 10 (console), Intake 20, Files 30, Messages 40, Automation 50, Sync 60, Invoices 70,
 * Refund 80, Order history 90, Acceptances 100, Notes 105, Sharing 110. Each tab keeps its own URL segment.
 */
export const BUILT_IN_TAB_ORDER = { overview: 0, phases: 10, notes: 105, sharing: 110 } as const;

interface TabEntry {
  order: number;
  value: string;
  label: string;
  labelContent?: ReactNode;
  content: ReactNode;
}

function orderTabItems(order: OrderDetail, area: Area): TabEntry[] {
  const consoleArea = area === "console";
  const lockState = order.lockState as LockState;
  const builtIn: TabEntry[] = [
    { order: BUILT_IN_TAB_ORDER.overview, value: "overview", label: "Overview", content: <Overview order={order} area={area} /> },
    ...(consoleArea
      ? [{ order: BUILT_IN_TAB_ORDER.phases, value: "phases", label: "Phases", content: <WorkflowRulesPanel orderId={order.publicId} area={area} /> }]
      : []),
    { order: BUILT_IN_TAB_ORDER.notes, value: "notes", label: "Notes", content: <Activity order={order} area={area} /> },
    {
      order: BUILT_IN_TAB_ORDER.sharing,
      value: "sharing",
      label: "Sharing",
      content: <SharingPanel orderId={order.publicId} canShare={order.canShare} locked={lockState !== "none"} />,
    },
  ];
  const contributed: TabEntry[] = ORDER_TABS.filter((t) => t.access === "customer" || consoleArea).map((t) => {
    const Component = t.component;
    const Badge = t.badge;
    const Label = t.labelComponent;
    // RouteTabs: the strip shows `labelContent` (live label + optional badge); the narrow-screen select keeps `label`.
    const labelContent =
      Label || Badge ? (
        <span className="inline-flex items-center gap-1.5">
          {Label ? (
            <Suspense fallback={t.label}>
              <Label orderId={order.publicId} area={area} />
            </Suspense>
          ) : (
            t.label
          )}
          {Badge ? (
            <Suspense fallback={null}>
              <Badge orderId={order.publicId} area={area} />
            </Suspense>
          ) : null}
        </span>
      ) : undefined;
    return {
      order: t.order,
      value: t.key,
      label: t.label,
      labelContent,
      content: (
        <Suspense fallback={<Spinner label={`Loading ${t.label}`} />}>
          <Component orderId={order.publicId} area={area} />
        </Suspense>
      ),
    };
  });
  return [...builtIn, ...contributed].sort((a, b) => a.order - b.order);
}

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
            ...(order.discountMinor > 0
              ? [
                  { label: "Subtotal", value: <Money value={money(order.subtotalMinor, order.currency)} /> },
                  {
                    label: order.discountLabel ?? "Discount",
                    value: (
                      <>
                        −<Money value={money(order.discountMinor, order.currency)} />
                      </>
                    ),
                  },
                ]
              : []),
            { label: "Total", value: <Money value={money(order.totalMinor, order.currency)} /> },
          ]}
        />
      </Card>
      <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
        {area === "console" ? <ReferenceHistory orderId={order.publicId} /> : null}
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
                  <ItemPacketDetails item={item} />
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

/** Snapshot of the packet terms the customer ordered (tier, outcome, timeline, deliverables). */
function ItemPacketDetails({ item }: { item: OrderDetail["lineItems"][number] }) {
  if (!item.tier && !item.outcome && !item.timeline && item.deliverables.length === 0) return null;
  return (
    <span className="mt-1 flex min-w-0 flex-col gap-1 text-sm text-body">
      {item.tier || item.timeline ? (
        <span className="flex flex-wrap gap-x-4 gap-y-0.5">
          {item.tier ? (
            <span>
              <span className="text-muted">Tier:</span> <span className="font-medium text-ink">{item.tier}</span>
            </span>
          ) : null}
          {item.timeline ? (
            <span>
              <span className="text-muted">Timeline:</span> <span className="text-ink">{item.timeline}</span>
            </span>
          ) : null}
        </span>
      ) : null}
      {item.outcome ? (
        <span className="break-words">
          <span className="text-muted">Outcome:</span> {item.outcome}
        </span>
      ) : null}
      {item.deliverables.length > 0 ? (
        <details className="group">
          <summary className="cursor-pointer rounded font-medium text-action underline-offset-2 hover:underline">
            {item.deliverables.length} {item.deliverables.length === 1 ? "deliverable" : "deliverables"}
            <span className="sr-only"> for {item.name}</span>
          </summary>
          <ul className="mt-1 flex list-disc flex-col gap-1 ps-5">
            {item.deliverables.map((deliverable, index) => (
              <li key={`${index}-${deliverable.title}`} className="break-words">
                <span className="font-medium text-ink">{deliverable.title}</span>
                {deliverable.detail ? <span className="text-muted"> — {deliverable.detail}</span> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </span>
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
      const message = errorMessage(err);
      setError(message.startsWith("Some items are still needed") ? `${message} See “Needed before the next step” on this page.` : message);
      await queryClient.invalidateQueries({ queryKey: trpc.orders.requirements.forOrder.queryKey({ orderId: order.publicId }) });
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

type TransitionOption = OrderDetail["transitions"][number];

/** Button text is always a verb; duplicates (e.g. two cancel states) are disambiguated with the target state. */
function transitionButtons(options: TransitionOption[]) {
  const counts = new Map<string, number>();
  for (const option of options) counts.set(option.actionLabel, (counts.get(option.actionLabel) ?? 0) + 1);
  return options.map((option) => ({ ...option, text: (counts.get(option.actionLabel) ?? 0) > 1 ? `${option.actionLabel} (${option.label})` : option.actionLabel }));
}

function TransitionControl({ order }: { order: OrderDetail }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toast = useToast();
  const transition = useMutation(trpc.orders.transition.mutationOptions());
  const [target, setTarget] = useState<(TransitionOption & { text: string }) | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (order.transitions.length === 0) return null;
  const buttons = transitionButtons(order.transitions);
  const close = () => {
    if (transition.isPending) return;
    setTarget(null);
    setNote("");
    setError(null);
  };
  const submit = async () => {
    if (!target) return;
    if (target.requiresNote && !note.trim()) return setError("A note is required for this change.");
    setError(null);
    try {
      await transition.mutateAsync({ orderId: order.publicId, expectedVersion: order.version, toStatus: target.to, note: note.trim() || undefined });
      toast.show({ tone: "success", title: target.destructive ? "Order canceled" : `Status changed to ${target.label}` });
      setTarget(null);
      setNote("");
      await queryClient.invalidateQueries({ queryKey: trpc.orders.pathKey() });
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const title = target ? (target.destructive ? "Cancel this order?" : `Change status to “${target.label}”?`) : "Change status";
  const description = target?.destructive
    ? "The order will be canceled and can't be resumed. Everyone with access to the order will be notified."
    : "Everyone with access to the order will be notified.";
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {buttons.map((option) => (
          <Button key={option.to} variant={option.destructive ? "danger" : "secondary"} onClick={() => (setTarget(option), setNote(""), setError(null))}>
            {option.text}
          </Button>
        ))}
      </div>
      <Dialog
        open={target !== null}
        onOpenChange={(open) => (open ? undefined : close())}
        title={title}
        description={description}
        footer={
          <>
            <Button variant="secondary" onClick={close} disabled={transition.isPending}>
              {target?.destructive ? "Keep order" : "Cancel"}
            </Button>
            <Button variant={target?.destructive ? "danger" : "primary"} loading={transition.isPending} onClick={() => void submit()}>
              {target?.destructive ? "Yes, cancel order" : "Confirm"}
            </Button>
          </>
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
