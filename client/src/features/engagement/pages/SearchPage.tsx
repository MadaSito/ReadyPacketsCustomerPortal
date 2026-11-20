import { useState, type FormEvent } from "react";
import { LifeBuoy, MessageSquare, Package, Search, Users } from "lucide-react";
import { Link, useLocation, useSearch } from "wouter";
import type { SearchDomain } from "@server/modules/engagement/types";
import { useSession } from "@/lib/session";
import {
  Badge,
  Button,
  Callout,
  Card,
  DateTime,
  EmptyState,
  ErrorState,
  Field,
  Input,
  PageHeader,
  Select,
  Skeleton,
} from "@/ui";
import { TicketPriorityBadge, TicketStatusBadge } from "../helpers";
import { useBoundedSearch } from "../shell";

export default function SearchPage() {
  const searchString = useSearch();
  const [, navigate] = useLocation();
  const { me } = useSession();
  const isStaffArea = me?.user.role === "staff" || me?.user.role === "admin";

  const urlQ = new URLSearchParams(searchString).get("q") ?? "";
  const [draftState, setDraftState] = useState<{ sourceUrlQ: string; input: string }>({
    sourceUrlQ: urlQ,
    input: urlQ,
  });
  const inputValue = draftState.sourceUrlQ === urlQ ? draftState.input : urlQ;
  const activeQuery = urlQ;
  const [domainFilter, setDomainFilter] = useState<SearchDomain | "all">("all");

  const domains = domainFilter === "all" ? undefined : [domainFilter];
  const searchQuery = useBoundedSearch(activeQuery, {
    domains,
    limitPerDomain: 8,
    debounceMs: 100,
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = inputValue.normalize("NFC").trim();
    if (trimmed.length >= 2) {
      navigate(`/search?q=${encodeURIComponent(trimmed)}`, { replace: true });
    } else {
      navigate("/search", { replace: true });
    }
  };

  const normalized = activeQuery.normalize("NFC").trim();
  const data = searchQuery.data;
  const totalHits =
    (data?.orders.length ?? 0) +
    (data?.tickets.length ?? 0) +
    (data?.messages.length ?? 0) +
    (data?.customers.length ?? 0);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Search"
        description="Search across the orders, support tickets, and messages you have permission to view."
      />

      <Card>
        <form onSubmit={onSubmit} role="search" className="grid gap-4 sm:grid-cols-12 sm:items-end">
          <div className="sm:col-span-7">
            <Field label="Search terms" hint="Enter at least 2 characters (reference number or keywords).">
              <Input
                type="search"
                value={inputValue}
                onChange={(event) =>
                  setDraftState({ sourceUrlQ: urlQ, input: event.target.value })
                }
                maxLength={64}
                placeholder="e.g. RP-2026, TKT-2026, exhibit…"
              />
            </Field>
          </div>
          <div className="sm:col-span-3">
            <Field label="Domain">
              <Select
                value={domainFilter}
                onChange={(event) => setDomainFilter(event.target.value as SearchDomain | "all")}
                options={[
                  { value: "all", label: "All domains" },
                  { value: "orders", label: "Orders" },
                  { value: "tickets", label: "Support tickets" },
                  { value: "messages", label: "Order messages" },
                  ...(isStaffArea ? [{ value: "customers", label: "Customers" }] : []),
                ]}
              />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" block leadingIcon={<Search aria-hidden="true" />}>
              Search
            </Button>
          </div>
        </form>
      </Card>

      {normalized.length < 2 ? (
        <EmptyState
          icon={Search}
          title="Enter a search query"
          description="Type at least 2 characters above to search references and conversations."
        />
      ) : searchQuery.isPending ? (
        <Skeleton lines={5} />
      ) : searchQuery.error ? (
        <ErrorState error={searchQuery.error} onRetry={() => searchQuery.refetch()} />
      ) : !data || totalHits === 0 ? (
        <EmptyState
          icon={Search}
          title="No matching records"
          description="Check the reference number or try fewer keywords."
        />
      ) : (
        <div className="flex flex-col gap-6">
          {data.meta.timedOut ? (
            <Callout tone="warning" title="Partial results shown">
              The search time budget elapsed before every domain finished. Narrow your terms for faster matches.
            </Callout>
          ) : null}

          {data.orders.length > 0 ? (
            <Card
              title="Orders"
              actions={<Badge tone="neutral">{data.orders.length}</Badge>}
            >
              <ul className="flex flex-col divide-y divide-line" aria-label="Matching orders">
                {data.orders.map((order) => (
                  <li key={order.publicId} className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <Link
                        href={isStaffArea ? `/admin/orders/${order.publicId}` : `/orders/${order.publicId}`}
                        className="font-semibold text-action underline-offset-2 hover:underline"
                      >
                        {order.reference} — {order.projectName}
                      </Link>
                      <p className="text-xs text-muted">
                        Updated <DateTime value={order.updatedAt} format="relative" />
                      </p>
                    </div>
                    <Badge tone="info" icon={<Package aria-hidden="true" />}>
                      {order.statusLabel}
                    </Badge>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {data.tickets.length > 0 ? (
            <Card
              title="Support tickets"
              actions={<Badge tone="neutral">{data.tickets.length}</Badge>}
            >
              <ul className="flex flex-col divide-y divide-line" aria-label="Matching support tickets">
                {data.tickets.map((ticket) => (
                  <li key={ticket.publicId} className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <Link
                        href={isStaffArea ? `/admin/tickets/${ticket.publicId}` : `/support/${ticket.publicId}`}
                        className="font-semibold break-words text-action underline-offset-2 hover:underline"
                      >
                        {ticket.ticketNumber} — {ticket.subject}
                      </Link>
                      <p className="text-xs text-muted">
                        Updated <DateTime value={ticket.updatedAt} format="relative" />
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <TicketStatusBadge status={ticket.status} staffView={isStaffArea} />
                      <TicketPriorityBadge priority={ticket.priority} />
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {data.messages.length > 0 ? (
            <Card
              title="Order messages"
              actions={<Badge tone="neutral">{data.messages.length}</Badge>}
            >
              <ul className="flex flex-col divide-y divide-line" aria-label="Matching order messages">
                {data.messages.map((msg) => (
                  <li key={msg.publicId} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Link
                        href={
                          isStaffArea
                            ? `/admin/orders/${msg.orderPublicId}/messages`
                            : `/orders/${msg.orderPublicId}/messages`
                        }
                        className="font-semibold text-action underline-offset-2 hover:underline"
                      >
                        Order {msg.orderReference}
                      </Link>
                      <div className="flex items-center gap-2">
                        {msg.visibility === "internal" ? (
                          <Badge tone="warning">Internal note</Badge>
                        ) : (
                          <Badge tone="neutral" icon={<MessageSquare aria-hidden="true" />}>
                            Message
                          </Badge>
                        )}
                        <span className="text-xs text-muted">
                          <DateTime value={msg.createdAt} format="relative" />
                        </span>
                      </div>
                    </div>
                    {/* Plain text snippet */}
                    <p className="break-words text-sm text-body">{msg.snippet}</p>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {data.customers.length > 0 ? (
            <Card
              title="Customers"
              actions={<Badge tone="neutral">{data.customers.length}</Badge>}
            >
              <ul className="flex flex-col divide-y divide-line" aria-label="Matching customers">
                {data.customers.map((customer) => (
                  <li key={customer.publicId} className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <Link
                        href={`/admin/customers/${customer.publicId}`}
                        className="font-semibold text-action underline-offset-2 hover:underline"
                      >
                        {customer.name}
                      </Link>
                      {customer.customerRef ? (
                        <p className="text-xs text-muted">{customer.customerRef}</p>
                      ) : null}
                    </div>
                    <Badge tone="neutral" icon={<Users aria-hidden="true" />}>
                      {customer.status}
                    </Badge>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {data.tickets.length === 0 && domainFilter === "tickets" ? (
            <EmptyState icon={LifeBuoy} title="No matching tickets" />
          ) : null}
        </div>
      )}
    </div>
  );
}
