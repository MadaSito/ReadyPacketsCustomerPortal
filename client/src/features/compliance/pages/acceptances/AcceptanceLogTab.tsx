import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  Button,
  CopyButton,
  DataTable,
  EmptyState,
  Field,
  FilterBar,
  Input,
  LoadMore,
  Select,
  type Column,
  type SelectOption,
} from "@/ui";
import { AcceptanceEvidenceDialog } from "./AcceptanceEvidenceDialog";
import {
  FRESHNESS_OPTIONS,
  FreshnessBadge,
  METHOD_OPTIONS,
  SOURCE_OPTIONS,
  TimestampWithUtc,
  formatAcceptanceMethod,
  formatAcceptanceSource,
  formatUtcTimestamp,
} from "./shared";
import {
  useAcceptanceLogProcedures,
  type AcceptanceFreshness,
  type AcceptanceLogFilterInput,
  type AcceptanceLogItem,
  type AcceptanceLogMethod,
  type AcceptanceLogSource,
} from "./types";

export interface AcceptanceLogUiFilters {
  customerDraft: string;
  customerQuery: string;
  customerPublicId: string;
  policyDocumentPublicId: string;
  versionPublicId: string;
  fromDate: string;
  toDate: string;
  source: AcceptanceLogSource | "";
  method: AcceptanceLogMethod | "";
  freshness: AcceptanceFreshness | "";
  orderReference: string;
}

export interface AcceptanceLogTabProps {
  filters: AcceptanceLogUiFilters;
  filterInput: AcceptanceLogFilterInput;
  activeFilterCount: number;
  onPatchFilters: (patch: Partial<AcceptanceLogUiFilters>) => void;
  onResetFilters: () => void;
}

export function AcceptanceLogTab({
  filters,
  filterInput,
  activeFilterCount,
  onPatchFilters,
  onResetFilters,
}: AcceptanceLogTabProps) {
  const acceptanceLog = useAcceptanceLogProcedures();
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(null);

  const filterOptionsQuery = useQuery(acceptanceLog.filterOptions.queryOptions());
  const listQuery = useInfiniteQuery(
    acceptanceLog.list.infiniteQueryOptions(
      { ...filterInput, limit: 50 },
      { getNextPageParam: (page) => page.nextCursor ?? undefined },
    ),
  );

  const policyOptions = useMemo<SelectOption[]>(() => {
    const docs = filterOptionsQuery.data?.policies ?? [];
    return docs.map((doc) => ({
      value: doc.documentPublicId,
      label: doc.active ? doc.title : `${doc.title} (archived)`,
    }));
  }, [filterOptionsQuery.data]);

  const versionOptions = useMemo<SelectOption[]>(() => {
    const docs = filterOptionsQuery.data?.policies ?? [];
    const scopedDocs = filters.policyDocumentPublicId
      ? docs.filter((doc) => doc.documentPublicId === filters.policyDocumentPublicId)
      : docs;
    return scopedDocs.flatMap((doc) =>
      doc.versions.map((ver) => ({
        value: ver.versionPublicId,
        label: filters.policyDocumentPublicId
          ? `Version ${ver.versionLabel}${ver.isCurrent ? " (current)" : ""}`
          : `${doc.title} — v${ver.versionLabel}${ver.isCurrent ? " (current)" : ""}`,
      })),
    );
  }, [filterOptionsQuery.data, filters.policyDocumentPublicId]);

  const rows = listQuery.data?.pages.flatMap((page) => page.items);
  const hasMore = Boolean(listQuery.hasNextPage);

  const columns = useMemo<readonly Column<AcceptanceLogItem>[]>(
    () => [
      {
        key: "customer",
        header: "Customer",
        primary: true,
        cell: (row) =>
          row.customer ? (
            <div className="flex min-w-0 flex-col gap-0.5">
              <Link
                href={`/admin/customers/${row.customer.userPublicId}`}
                className="font-semibold text-action underline underline-offset-2"
              >
                {row.customer.name}
              </Link>
              <span className="text-xs text-muted">
                {row.customer.customerRef ?? "No customer ID"}
              </span>
              <span className="text-xs break-all text-muted">{row.customer.email}</span>
            </div>
          ) : (
            <span className="text-muted">Historical / unlinked account</span>
          ),
      },
      {
        key: "acceptedAt",
        header: "Time",
        cell: (row) => <TimestampWithUtc value={row.acceptedAt} />,
      },
      {
        key: "policy",
        header: "Policy & version",
        cell: (row) => (
          <div className="flex min-w-0 flex-col items-start gap-1">
            <div className="flex flex-wrap items-baseline gap-1.5">
              <span className="font-medium text-ink">{row.policyTitle}</span>
              <Link
                href={`/admin/policy-acceptances/versions/${row.versionPublicId}`}
                aria-label={`View v${row.versionLabel} of ${row.policyTitle}`}
                className="font-mono text-xs font-medium text-action underline underline-offset-2"
              >
                v{row.versionLabel}
              </Link>
            </div>
            <FreshnessBadge
              freshness={row.freshness}
              supersededByVersionLabel={row.supersededByVersionLabel}
            />
            <span className="inline-flex items-center gap-1">
              <code className="font-mono text-xs text-muted">{row.shortContentHash}</code>
              <CopyButton
                value={row.contentHash}
                label={`Copy SHA-256 content hash for ${row.policyTitle} version ${row.versionLabel}`}
                iconOnly
              />
            </span>
          </div>
        ),
      },
      {
        key: "sourceMethod",
        header: "Source & method",
        cell: (row) => (
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-ink">{formatAcceptanceSource(row.source)}</span>
            <span className="text-xs text-muted">{formatAcceptanceMethod(row.method)}</span>
          </div>
        ),
      },
      {
        key: "order",
        header: "Order",
        cell: (row) =>
          row.orderPublicId && row.orderReference ? (
            <Link
              href={`/admin/orders/${row.orderPublicId}`}
              className="font-mono font-medium text-action underline underline-offset-2"
            >
              {row.orderReference}
            </Link>
          ) : row.orderReference ? (
            <span className="font-mono text-ink">{row.orderReference}</span>
          ) : (
            <span className="text-muted">—</span>
          ),
      },
      {
        key: "trace",
        header: "Address & correlation",
        cell: (row) => (
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-xs text-muted">
              Address:{" "}
              <code className="font-mono break-all text-ink">{row.addressPseudonym ?? "—"}</code>
            </span>
            {row.correlationId ? (
              <span className="inline-flex flex-wrap items-center gap-1">
                <code className="font-mono text-xs break-all text-muted">{row.correlationId}</code>
                <CopyButton
                  value={row.correlationId}
                  label={`Copy correlation ID ${row.correlationId}`}
                  iconOnly
                />
              </span>
            ) : (
              <span className="text-xs text-muted">Correlation: —</span>
            )}
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <FilterBar
        search={filters.customerDraft}
        onSearchChange={(value) => onPatchFilters({ customerDraft: value })}
        onSearchSubmit={(value) => onPatchFilters({ customerQuery: value.trim() })}
        searchLabel="Search customer"
        searchPlaceholder="Customer name, e-mail, or ID"
        activeCount={activeFilterCount}
        onReset={onResetFilters}
      >
        <Field label="Policy">
          <Select
            placeholder="All policies"
            options={policyOptions}
            value={filters.policyDocumentPublicId}
            onChange={(e) => {
              const nextDoc = e.target.value;
              const docs = filterOptionsQuery.data?.policies ?? [];
              const docObj = docs.find((d) => d.documentPublicId === nextDoc);
              const keepVersion =
                !nextDoc ||
                Boolean(docObj?.versions.some((v) => v.versionPublicId === filters.versionPublicId));
              onPatchFilters({
                policyDocumentPublicId: nextDoc,
                versionPublicId: keepVersion ? filters.versionPublicId : "",
              });
            }}
          />
        </Field>

        <Field label="Version">
          <Select
            placeholder="All versions"
            options={versionOptions}
            value={filters.versionPublicId}
            onChange={(e) => onPatchFilters({ versionPublicId: e.target.value })}
          />
        </Field>

        <Field label="From date">
          <Input
            type="date"
            value={filters.fromDate}
            onChange={(e) => onPatchFilters({ fromDate: e.target.value })}
          />
        </Field>

        <Field label="To date">
          <Input
            type="date"
            value={filters.toDate}
            onChange={(e) => onPatchFilters({ toDate: e.target.value })}
          />
        </Field>

        <Field label="Source">
          <Select
            placeholder="All sources"
            options={SOURCE_OPTIONS}
            value={filters.source}
            onChange={(e) => onPatchFilters({ source: e.target.value as AcceptanceLogSource | "" })}
          />
        </Field>

        <Field label="Method">
          <Select
            placeholder="All methods"
            options={METHOD_OPTIONS}
            value={filters.method}
            onChange={(e) => onPatchFilters({ method: e.target.value as AcceptanceLogMethod | "" })}
          />
        </Field>

        <Field label="Version status">
          <Select
            placeholder="Current or superseded"
            options={FRESHNESS_OPTIONS}
            value={filters.freshness}
            onChange={(e) => onPatchFilters({ freshness: e.target.value as AcceptanceFreshness | "" })}
          />
        </Field>

        <Field label="Order reference">
          <Input
            placeholder="e.g. RP-1042"
            value={filters.orderReference}
            maxLength={64}
            autoComplete="off"
            onChange={(e) => onPatchFilters({ orderReference: e.target.value })}
          />
        </Field>
      </FilterBar>

      <DataTable<AcceptanceLogItem>
        caption="Policy acceptance log"
        columns={columns}
        rows={rows}
        rowKey={(row) => `${row.evidenceKind}:${row.publicId}`}
        loading={listQuery.isPending}
        error={listQuery.error}
        onRetry={() => void listQuery.refetch()}
        rowActions={(row) => (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setSelectedEvidenceId(row.publicId)}
            aria-label={`View evidence for ${row.customer?.name ?? "customer"} on ${row.policyTitle} v${row.versionLabel}${row.orderReference ? ` (${row.orderReference})` : ""}, accepted ${formatUtcTimestamp(row.acceptedAt)}`}
          >
            View evidence
          </Button>
        )}
        empty={
          hasMore ? (
            <EmptyState
              variant="filtered"
              title="No matches on this page yet"
              description="This scan window contained no matching records, and older acceptance history remains. Select Load more records below to keep searching."
            />
          ) : (
            <EmptyState
              variant={activeFilterCount > 0 ? "filtered" : "default"}
              title={
                activeFilterCount > 0
                  ? "No matching acceptance records"
                  : "No policy acceptances recorded yet"
              }
              description={
                activeFilterCount > 0
                  ? "Adjust or clear the filters to inspect broader policy acceptance evidence."
                  : "Account, checkout, and order-gate acceptances appear here automatically as customers accept policies."
              }
              onClearFilters={activeFilterCount > 0 ? onResetFilters : undefined}
            />
          )
        }
      />

      {!listQuery.isPending && !listQuery.isError ? (
        <LoadMore
          hasMore={hasMore}
          loading={listQuery.isFetchingNextPage}
          onLoadMore={() => void listQuery.fetchNextPage()}
          summary={
            rows && rows.length > 0
              ? `Showing ${rows.length} acceptance ${rows.length === 1 ? "record" : "records"}`
              : hasMore
                ? "No matches on this page yet. Load more to keep searching."
                : activeFilterCount > 0
                  ? "0 matching acceptance records."
                  : "0 policy acceptance records."
          }
          label="Load more records"
        />
      ) : null}

      <AcceptanceEvidenceDialog
        publicId={selectedEvidenceId}
        onClose={() => setSelectedEvidenceId(null)}
      />
    </div>
  );
}
