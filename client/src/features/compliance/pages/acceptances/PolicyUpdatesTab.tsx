import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, History } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  Badge,
  CopyButton,
  DataTable,
  EmptyState,
  Field,
  FilterBar,
  Select,
  type Column,
  type SelectOption,
} from "@/ui";
import { TimestampWithUtc, formatPolicyAudience } from "./shared";
import { useAcceptanceLogProcedures, type PolicyUpdateHistoryItem } from "./types";

export function PolicyUpdatesTab() {
  const acceptanceLog = useAcceptanceLogProcedures();
  const [documentPublicId, setDocumentPublicId] = useState("");

  const filterOptionsQuery = useQuery(acceptanceLog.filterOptions.queryOptions());
  const updatesQuery = useQuery(
    acceptanceLog.updates.queryOptions(documentPublicId ? { documentPublicId } : {}),
  );

  const policyOptions = useMemo<SelectOption[]>(() => {
    const docs = filterOptionsQuery.data?.policies ?? [];
    return docs.map((doc) => ({
      value: doc.documentPublicId,
      label: doc.active ? doc.title : `${doc.title} (archived)`,
    }));
  }, [filterOptionsQuery.data]);

  const columns = useMemo<readonly Column<PolicyUpdateHistoryItem>[]>(
    () => [
      {
        key: "policy",
        header: "Policy & version",
        primary: true,
        cell: (row) => (
          <div className="flex min-w-0 flex-col items-start gap-1">
            <div className="flex flex-wrap items-baseline gap-1.5">
              <span className="font-semibold break-words text-ink">{row.policyTitle}</span>
              <Link
                href={`/admin/policy-acceptances/versions/${row.versionPublicId}`}
                aria-label={`Version ${row.versionLabel} (#${row.versionNumber}) of ${row.policyTitle}`}
                className="font-mono text-xs font-medium text-action underline underline-offset-2"
              >
                Version {row.versionLabel} (#{row.versionNumber})
              </Link>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {row.isCurrent ? (
                <Badge tone="success" icon={<CheckCircle2 className="size-3.5" aria-hidden="true" />}>
                  Current
                </Badge>
              ) : (
                <Badge tone="neutral" icon={<History className="size-3.5" aria-hidden="true" />}>
                  Historical
                </Badge>
              )}
              <span className="text-xs text-muted">{formatPolicyAudience(row.audience)}</span>
            </div>
            <span className="flex min-w-0 max-w-full flex-wrap items-center gap-1">
              <code className="min-w-0 font-mono text-xs break-all text-muted">
                {row.shortContentHash}
              </code>
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
        key: "publishedAt",
        header: "Published",
        cell: (row) => <TimestampWithUtc value={row.publishedAt ?? row.effectiveAt} />,
      },
      {
        key: "changeSummary",
        header: "Change summary",
        cell: (row) =>
          row.changeSummary ? (
            <span className="break-words text-ink">{row.changeSummary}</span>
          ) : (
            <span className="text-muted">Initial publication — no change summary recorded.</span>
          ),
      },
      {
        key: "publishedBy",
        header: "Published by",
        cell: (row) =>
          row.publishedBy ? (
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium break-words text-ink">{row.publishedBy.name}</span>
              <span className="text-xs break-all text-muted">{row.publishedBy.email}</span>
            </div>
          ) : (
            <span className="text-muted">System / historical</span>
          ),
      },
      {
        key: "acceptedCustomerCount",
        header: "Customers accepted",
        align: "end",
        cell: (row) => (
          <span className="font-medium text-ink">
            {row.acceptedCustomerCount}{" "}
            <span className="font-normal text-muted">
              {row.acceptedCustomerCount === 1 ? "customer" : "customers"}
            </span>
          </span>
        ),
      },
    ],
    [],
  );

  const rows = updatesQuery.data?.items;
  const hasFilter = Boolean(documentPublicId);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <FilterBar
        className="min-w-0"
        activeCount={hasFilter ? 1 : 0}
        onReset={() => setDocumentPublicId("")}
      >
        <Field label="Policy">
          <Select
            placeholder="All policies"
            options={policyOptions}
            value={documentPublicId}
            onChange={(e) => setDocumentPublicId(e.target.value)}
          />
        </Field>
      </FilterBar>

      <DataTable<PolicyUpdateHistoryItem>
        caption="Published policy versions and customer acceptance counts"
        className="max-[320px]:[&_li]:min-w-0 max-[320px]:[&_dl]:grid-cols-1 max-[320px]:[&_dt]:break-words"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.versionPublicId}
        loading={updatesQuery.isPending}
        error={updatesQuery.error}
        onRetry={() => void updatesQuery.refetch()}
        empty={
          <EmptyState
            variant={hasFilter ? "filtered" : "default"}
            title={hasFilter ? "No published versions for this policy" : "No published policy versions"}
            description="Every published policy version appears here with its publication timestamp, publisher, change summary, and customer acceptance count."
            onClearFilters={hasFilter ? () => setDocumentPublicId("") : undefined}
          />
        }
      />

      {!updatesQuery.isPending && !updatesQuery.isError ? (
        <p role="status" className="text-center text-sm text-muted">
          {`Showing ${rows?.length ?? 0} published ${rows?.length === 1 ? "version" : "versions"}`}
        </p>
      ) : null}
    </div>
  );
}
