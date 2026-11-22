/**
 * Staff/Admin open-carts operations view (/admin/carts, capability `carts.read_all`).
 * Owner: recovery_ops_engineer (Increment 04, Package L).
 *
 * Security & privacy invariant:
 *  - Read-only operational visibility into open customer carts.
 *  - Encrypted customer notes (`note_enc`) and draft billing details (`billing_enc`) are never decrypted or shown.
 */
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@server/trpc/root";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShoppingCart } from "lucide-react";
import { useEffect, useState } from "react";
import { useTRPC } from "@/lib/trpc";
import {
  Badge,
  Button,
  Callout,
  Card,
  DataTable,
  DateTime,
  DialogClose,
  Drawer,
  EmptyState,
  ErrorState,
  FilterBar,
  KeyValueList,
  LoadMore,
  Money,
  PageHeader,
  Section,
  Skeleton,
  type Column,
} from "@/ui";

type AdminListOpenOutput = inferRouterOutputs<AppRouter>["cart"]["admin"]["listOpen"];
export type AdminOpenCartRow = AdminListOpenOutput["items"][number];
export type AdminOpenCartDetailData = inferRouterOutputs<AppRouter>["cart"]["admin"]["getOpen"];

const PAGE_SIZE = 25;

function formatCartMoney(amountMinor: number, currency: string | null) {
  return currency ? <Money value={{ amountMinor, currency }} /> : <span className="text-muted">—</span>;
}

export function AdminOpenCartsPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [searchDraft, setSearchDraft] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [extraRows, setExtraRows] = useState<AdminOpenCartRow[]>([]);
  const [cursorOverride, setCursorOverride] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<unknown>(null);
  const [selectedCartId, setSelectedCartId] = useState<string | null>(null);

  const firstPage = useQuery(
    trpc.cart.admin.listOpen.queryOptions({
      search: submittedSearch || undefined,
      limit: PAGE_SIZE,
    }),
  );

  useEffect(() => {
    setExtraRows([]);
    setCursorOverride(undefined);
    setLoadMoreError(null);
  }, [submittedSearch, firstPage.dataUpdatedAt]);

  const detailQuery = useQuery(
    trpc.cart.admin.getOpen.queryOptions(
      { cartPublicId: selectedCartId ?? "01JQACART00000000000000000" },
      { enabled: Boolean(selectedCartId) },
    ),
  );

  const baseRows = firstPage.data?.items ?? [];
  const rows: AdminOpenCartRow[] = extraRows.length > 0 ? [...baseRows, ...extraRows] : baseRows;
  const nextCursor = cursorOverride === undefined ? (firstPage.data?.nextCursor ?? null) : cursorOverride;
  const abandonedTtlHours = firstPage.data?.abandonedTtlHours ?? 72;

  const handleSearchSubmit = (value: string) => {
    setSubmittedSearch(value.trim());
  };

  const resetSearch = () => {
    setSearchDraft("");
    setSubmittedSearch("");
  };

  const loadNextPage = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const next = await queryClient.fetchQuery(
        trpc.cart.admin.listOpen.queryOptions({
          search: submittedSearch || undefined,
          cursor: nextCursor,
          limit: PAGE_SIZE,
        }),
      );
      setExtraRows((prev) => {
        const seen = new Set([...baseRows, ...prev].map((r) => r.cartPublicId));
        return [...prev, ...next.items.filter((item) => !seen.has(item.cartPublicId))];
      });
      setCursorOverride(next.nextCursor);
    } catch (err) {
      setLoadMoreError(err);
    } finally {
      setLoadingMore(false);
    }
  };

  const columns: readonly Column<AdminOpenCartRow>[] = [
    {
      key: "cart",
      header: "Cart",
      primary: true,
      cell: (row) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium break-words text-ink">{row.projectName || "Untitled cart"}</span>
          <span className="font-mono text-xs text-muted">{row.cartPublicId}</span>
        </div>
      ),
    },
    {
      key: "customer",
      header: "Customer",
      cell: (row) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium break-words text-ink">{row.customerRef || row.customerPublicId}</span>
          {row.customerRef ? <span className="font-mono text-xs text-muted">{row.customerPublicId}</span> : null}
        </div>
      ),
    },
    {
      key: "contents",
      header: "Packets & items",
      cell: (row) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm break-words text-body">{row.packetSummary}</span>
          <Badge tone="neutral">{`${row.itemCount} ${row.itemCount === 1 ? "item" : "items"}`}</Badge>
          {row.bundleApplied ? <Badge tone="success">Bundle discount</Badge> : null}
          {row.hasUnavailableItems ? <Badge tone="warning">Unavailable item</Badge> : null}
        </div>
      ),
    },
    {
      key: "total",
      header: "Estimated total",
      align: "end",
      cell: (row) => formatCartMoney(row.totalMinor, row.currency),
    },
    {
      key: "activity",
      header: "Last activity",
      cell: (row) => <DateTime value={row.lastActivityAt} format="relative" />,
    },
    {
      key: "expires",
      header: "Expires",
      hideOnMobile: true,
      cell: (row) => <DateTime value={row.expiresAt} format="datetime" />,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Open carts"
        description="Read-only view of customer carts currently in progress. Customer notes and draft billing details remain encrypted at rest and are omitted here."
      />

      {firstPage.data && !firstPage.data.featureEnabled ? (
        <Callout tone="info" title="Customer cart feature is turned off">
          Customers cannot view or modify carts while the cart feature switch is disabled. Existing open carts remain
          subject to automatic expiry after {abandonedTtlHours} hours of inactivity.
        </Callout>
      ) : null}

      <FilterBar
        search={searchDraft}
        onSearchChange={setSearchDraft}
        onSearchSubmit={handleSearchSubmit}
        searchLabel="Search open carts"
        searchPlaceholder="Search by cart ID, customer reference, or project"
        activeCount={submittedSearch ? 1 : 0}
        onReset={submittedSearch ? resetSearch : undefined}
      />

      {loadMoreError ? <ErrorState error={loadMoreError} onRetry={loadNextPage} /> : null}

      <DataTable
        caption="Open customer carts"
        columns={columns}
        rows={firstPage.data ? rows : undefined}
        rowKey={(row) => row.cartPublicId}
        loading={firstPage.isLoading}
        error={firstPage.error}
        onRetry={() => void firstPage.refetch()}
        rowActions={(row) => (
          <Button
            variant="secondary"
            size="sm"
            aria-label={`Inspect cart ${row.cartPublicId}`}
            onClick={() => setSelectedCartId(row.cartPublicId)}
          >
            Inspect
          </Button>
        )}
        empty={
          <EmptyState
            icon={ShoppingCart}
            variant={submittedSearch ? "filtered" : "default"}
            onClearFilters={submittedSearch ? resetSearch : undefined}
            title={submittedSearch ? "No matching open carts" : "No open carts right now"}
            description={
              submittedSearch
                ? "No open cart matched your search. Clear filters to view all active customer carts."
                : "Active customer carts appear here until they are checked out or expire automatically."
            }
          />
        }
      />

      {firstPage.data && rows.length > 0 ? (
        <LoadMore
          hasMore={Boolean(nextCursor)}
          loading={loadingMore}
          onLoadMore={loadNextPage}
          summary={`Showing ${rows.length} open ${rows.length === 1 ? "cart" : "carts"} · Abandoned cart expiry: ${abandonedTtlHours} hours`}
        />
      ) : null}

      <Drawer
        open={Boolean(selectedCartId)}
        onOpenChange={(open) => {
          if (!open) setSelectedCartId(null);
        }}
        title={selectedCartId ? `Open cart ${selectedCartId}` : "Open cart details"}
        description="Operational summary of selected items and live catalogue totals. Encrypted customer notes and billing fields are never shown."
        width="lg"
        footer={
          <DialogClose>
            <Button variant="secondary">Close</Button>
          </DialogClose>
        }
      >
        {detailQuery.isLoading ? (
          <div className="space-y-3" aria-busy="true">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : detailQuery.error ? (
          <ErrorState error={detailQuery.error} onRetry={() => void detailQuery.refetch()} />
        ) : detailQuery.data ? (
          <OpenCartDetailBody detail={detailQuery.data} />
        ) : null}
      </Drawer>
    </div>
  );
}

function OpenCartDetailBody({ detail }: { detail: AdminOpenCartDetailData }) {
  const { totals } = detail;
  return (
    <div className="space-y-6">
      <Section title="Cart metadata" headingLevel={3}>
        <Card>
          <KeyValueList
            items={[
              { label: "Cart ID", value: <span className="font-mono text-xs">{detail.cartPublicId}</span> },
              { label: "Customer", value: detail.customerRef || detail.customerPublicId },
              { label: "Customer ID", value: <span className="font-mono text-xs">{detail.customerPublicId}</span> },
              { label: "Project label", value: detail.projectName || "Untitled cart" },
              { label: "Created", value: <DateTime value={detail.createdAt} format="datetime" /> },
              { label: "Last activity", value: <DateTime value={detail.lastActivityAt} format="datetime" /> },
              { label: "Expires", value: <DateTime value={detail.expiresAt} format="datetime" /> },
            ]}
          />
        </Card>
      </Section>

      <Section title={`Line items (${detail.items.length})`} headingLevel={3}>
        {detail.items.length === 0 ? (
          <p className="text-sm text-muted">This cart currently has no line items.</p>
        ) : (
          <ul className="space-y-3" aria-label="Cart line items">
            {detail.items.map((item) => (
              <li
                key={item.itemPublicId}
                className="rounded-[var(--radius-card)] border border-line bg-surface p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 space-y-1">
                    <p className="font-medium break-words text-ink">{item.name}</p>
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                      <span>{item.groupName}</span>
                      {item.packetNumber !== null ? <Badge tone="neutral">{`Packet ${item.packetNumber}`}</Badge> : null}
                      {item.tier ? <Badge tone="info">{item.tier}</Badge> : null}
                      {!item.available ? <Badge tone="warning">No longer available</Badge> : null}
                    </div>
                  </div>
                  <div className="text-right text-sm">
                    <div className="font-semibold text-ink">
                      <Money value={{ amountMinor: item.lineTotalMinor, currency: item.currency }} />
                    </div>
                    <div className="text-xs text-muted">
                      {`${item.quantity} × `}
                      <Money value={{ amountMinor: item.unitPriceMinor, currency: item.currency }} />
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Live server totals" headingLevel={3}>
        <Card>
          <dl className="space-y-2 text-sm">
            <div className="flex items-center justify-between gap-4">
              <dt className="text-body">Subtotal</dt>
              <dd className="font-medium text-ink">{formatCartMoney(totals.subtotalMinor, totals.currency)}</dd>
            </div>
            {totals.discountMinor > 0 ? (
              <div className="flex items-center justify-between gap-4">
                <dt className="text-body">{totals.discountLabel || "Bundle discount"}</dt>
                <dd className="font-medium text-success">
                  −{formatCartMoney(totals.discountMinor, totals.currency)}
                </dd>
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-4">
              <dt className="text-body">
                {totals.taxRateBps > 0 ? `Tax (${(totals.taxRateBps / 100).toFixed(2)}%)` : "Tax"}
              </dt>
              <dd className="font-medium text-ink">{formatCartMoney(totals.taxMinor, totals.currency)}</dd>
            </div>
            <div className="flex items-center justify-between gap-4 border-t border-line pt-2 text-base font-semibold">
              <dt className="text-ink">Estimated total</dt>
              <dd className="text-ink">{formatCartMoney(totals.totalMinor, totals.currency)}</dd>
            </div>
          </dl>
        </Card>
      </Section>
    </div>
  );
}

export default AdminOpenCartsPage;
