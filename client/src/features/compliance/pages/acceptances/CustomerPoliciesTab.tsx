import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  Button,
  Card,
  CopyButton,
  DataTable,
  EmptyState,
  ErrorState,
  LoadMore,
  Skeleton,
  type Column,
} from "@/ui";
import { EndPolicySessionsAction } from "../../policyUpdates/PolicyEnforcementCards";
import { AcceptanceEvidenceDialog } from "./AcceptanceEvidenceDialog";
import {
  FreshnessBadge,
  RequirementStateBadge,
  TimestampWithUtc,
  formatAcceptanceMethod,
  formatAcceptanceSource,
  formatUtcTimestamp,
} from "./shared";
import {
  useAcceptanceLogProcedures,
  type AcceptanceLogItem,
  type CustomerPolicyStatusRow,
} from "./types";

const POLICY_STATUS_COLUMNS: readonly Column<CustomerPolicyStatusRow>[] = [
  {
    key: "policy",
    header: "Policy",
    primary: true,
    cell: (row) => (
      <div className="flex min-w-0 max-w-full flex-col gap-0.5">
        <span className="font-semibold break-words text-ink">{row.title}</span>
        <span className="font-mono text-xs break-all text-muted">{row.slug}</span>
        <Link
          href={`/admin/policy-acceptances/versions/${row.currentVersionPublicId}`}
          aria-label={`Current v${row.currentVersionLabel} text for ${row.title}`}
          className="text-xs font-medium break-words text-action underline underline-offset-2"
        >
          Current v{row.currentVersionLabel} text
        </Link>
      </div>
    ),
  },
  {
    key: "state",
    header: "Status",
    cell: (row) => <RequirementStateBadge state={row.state} />,
  },
  {
    key: "acceptedVersion",
    header: "Accepted version",
    cell: (row) =>
      row.acceptedVersionPublicId && row.acceptedVersionLabel ? (
        <Link
          href={`/admin/policy-acceptances/versions/${row.acceptedVersionPublicId}`}
          aria-label={`Version ${row.acceptedVersionLabel} text for ${row.title}`}
          className="font-medium break-words text-action underline underline-offset-2"
        >
          Version {row.acceptedVersionLabel} text
        </Link>
      ) : (
        <span className="text-muted">—</span>
      ),
  },
  {
    key: "acceptedAt",
    header: "Last accepted",
    cell: (row) => <TimestampWithUtc value={row.acceptedAt} />,
  },
];

export default function CustomerPoliciesTab({ customerId }: { customerId: string }) {
  const acceptanceLog = useAcceptanceLogProcedures();
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(null);

  const profileQuery = useInfiniteQuery(
    acceptanceLog.forCustomer.infiniteQueryOptions(
      { customerPublicId: customerId, limit: 50 },
      {
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        enabled: Boolean(customerId),
      },
    ),
  );

  const historyColumns = useMemo<readonly Column<AcceptanceLogItem>[]>(
    () => [
      {
        key: "policy",
        header: "Policy & version",
        primary: true,
        cell: (row) => (
          <div className="flex min-w-0 max-w-full flex-col items-start gap-1">
            <span className="font-semibold break-words text-ink">
              {row.policyTitle} · v{row.versionLabel}
            </span>
            <FreshnessBadge
              freshness={row.freshness}
              supersededByVersionLabel={row.supersededByVersionLabel}
            />
            <span className="flex min-w-0 max-w-full flex-wrap items-center gap-1">
              <code className="min-w-0 font-mono text-xs break-all text-muted">
                {row.shortContentHash}
              </code>
              <CopyButton
                value={row.contentHash}
                label={`Copy SHA-256 hash for ${row.policyTitle} v${row.versionLabel}`}
                iconOnly
              />
            </span>
          </div>
        ),
      },
      {
        key: "acceptedAt",
        header: "Time",
        cell: (row) => <TimestampWithUtc value={row.acceptedAt} />,
      },
      {
        key: "sourceMethod",
        header: "Source & method",
        cell: (row) => (
          <div className="flex min-w-0 max-w-full flex-col gap-0.5">
            <span className="font-medium break-words text-ink">{formatAcceptanceSource(row.source)}</span>
            <span className="text-xs break-words text-muted">{formatAcceptanceMethod(row.method)}</span>
            {row.orderPublicId && row.orderReference ? (
              <Link
                href={`/admin/orders/${row.orderPublicId}`}
                className="font-mono text-xs break-all text-action underline underline-offset-2"
              >
                Order {row.orderReference}
              </Link>
            ) : null}
          </div>
        ),
      },
      {
        key: "versionText",
        header: "Accepted text",
        cell: (row) => (
          <Link
            href={`/admin/policy-acceptances/versions/${row.versionPublicId}`}
            aria-label={`View version ${row.versionLabel} text for ${row.policyTitle}`}
            className="font-medium break-words text-action underline underline-offset-2"
          >
            View version {row.versionLabel} text
          </Link>
        ),
      },
    ],
    [],
  );

  if (profileQuery.isPending) {
    return (
      <div role="status" className="flex flex-col gap-3">
        <span className="sr-only">Loading customer policy acceptances</span>
        <Skeleton lines={6} />
      </div>
    );
  }

  if (profileQuery.isError) {
    return <ErrorState error={profileQuery.error} onRetry={() => void profileQuery.refetch()} />;
  }

  const firstPage = profileQuery.data?.pages[0];
  const policyRows = firstPage?.policies ?? [];
  const historyRows = profileQuery.data?.pages.flatMap((page) => page.history) ?? [];
  const hasMoreHistory = Boolean(profileQuery.hasNextPage);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Card
        as="section"
        className="min-w-0"
        aria-label="Policy status per document"
        title="Status per policy"
        description="Standing against every published customer-facing policy."
        actions={<EndPolicySessionsAction userPublicId={customerId} />}
        flush
      >
        <div className="min-w-0 p-4 sm:p-5">
          {/* Nested Card + DataTable card leaves 148 px below 320 px; stack <dt>/<dd> below 320 px while keeping 320+ unchanged. */}
          <DataTable<CustomerPolicyStatusRow>
            caption="Customer policy status"
            className="max-[320px]:[&_li]:min-w-0 max-[320px]:[&_dl]:grid-cols-1 max-[320px]:[&_dt]:break-words"
            columns={POLICY_STATUS_COLUMNS}
            rows={policyRows}
            rowKey={(row) => row.documentPublicId}
            empty={
              <EmptyState
                size="sm"
                headingLevel={3}
                title="No published policies"
                description="Published customer policies appear here once configured."
              />
            }
          />
        </div>
      </Card>

      <Card
        as="section"
        className="min-w-0"
        aria-label="Full policy acceptance history"
        title="Acceptance history"
        description="Complete append-only log of account, checkout, and order-gate acceptances for this customer."
        flush
      >
        <div className="flex min-w-0 flex-col gap-3 p-4 sm:p-5">
          <DataTable<AcceptanceLogItem>
            caption="Customer policy acceptance history"
            className="max-[320px]:[&_li]:min-w-0 max-[320px]:[&_dl]:grid-cols-1 max-[320px]:[&_dt]:break-words"
            columns={historyColumns}
            rows={historyRows}
            rowKey={(row) => `${row.evidenceKind}:${row.publicId}`}
            rowActions={(row) => (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setSelectedEvidenceId(row.publicId)}
                aria-label={`View evidence for ${row.policyTitle} v${row.versionLabel}${row.orderReference ? ` (${row.orderReference})` : ""}, accepted ${formatUtcTimestamp(row.acceptedAt)}`}
              >
                View evidence
              </Button>
            )}
            empty={
              hasMoreHistory ? (
                <EmptyState
                  size="sm"
                  headingLevel={3}
                  title="No matches on this page yet"
                  description="Older acceptance batches remain for this customer. Select Load more history below to keep searching."
                />
              ) : (
                <EmptyState
                  size="sm"
                  headingLevel={3}
                  title="No acceptances recorded for this customer"
                  description="When this customer accepts a policy at registration, checkout, re-acceptance, or an order gate, the immutable record appears here."
                />
              )
            }
          />

          <LoadMore
            hasMore={hasMoreHistory}
            loading={profileQuery.isFetchingNextPage}
            onLoadMore={() => void profileQuery.fetchNextPage()}
            summary={
              historyRows.length > 0
                ? `Showing ${historyRows.length} acceptance ${historyRows.length === 1 ? "record" : "records"}`
                : hasMoreHistory
                  ? "No matches on this page yet. Load more to keep searching."
                  : "0 acceptance records for this customer."
            }
            label="Load more history"
          />
        </div>
      </Card>

      <AcceptanceEvidenceDialog
        publicId={selectedEvidenceId}
        onClose={() => setSelectedEvidenceId(null)}
      />
    </div>
  );
}
