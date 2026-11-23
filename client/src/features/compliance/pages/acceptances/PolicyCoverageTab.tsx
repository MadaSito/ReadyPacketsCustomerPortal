import { useQuery } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { Link } from "wouter";
import {
  Badge,
  Callout,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  KeyValueList,
  Skeleton,
  StatCard,
  StatGrid,
  type Column,
} from "@/ui";
import { EndPolicySessionsAction } from "../../policyUpdates/PolicyEnforcementCards";
import { TimestampWithUtc, formatPolicyAudience } from "./shared";
import {
  useAcceptanceLogProcedures,
  type PolicyCoverageDocumentView,
  type PolicyCoverageOutstandingCustomer,
} from "./types";

function outstandingColumnsFor(policyTitle: string): readonly Column<PolicyCoverageOutstandingCustomer>[] {
  return [
    {
      key: "customer",
      header: "Customer",
      primary: true,
      cell: (row) => (
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
      ),
    },
    {
      key: "lastAccepted",
      header: "Last accepted version",
      cell: (row) =>
        row.lastAcceptedVersionPublicId && row.lastAcceptedVersionLabel ? (
          <div className="flex flex-col gap-0.5">
            <Link
              href={`/admin/policy-acceptances/versions/${row.lastAcceptedVersionPublicId}`}
              aria-label={`Version ${row.lastAcceptedVersionLabel} of ${policyTitle}`}
              className="font-medium text-action underline underline-offset-2"
            >
              Version {row.lastAcceptedVersionLabel}
            </Link>
            {row.lastAcceptedAt ? <TimestampWithUtc value={row.lastAcceptedAt} /> : null}
          </div>
        ) : (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <Badge tone="warning" icon={<AlertCircle className="size-3.5" aria-hidden="true" />}>
              None
            </Badge>
            <span className="text-xs text-muted">Never accepted</span>
          </span>
        ),
    },
  ];
}

function CoveragePolicyCard({ policy }: { policy: PolicyCoverageDocumentView }) {
  const allAccepted = policy.outstandingCount === 0;
  return (
    <Card
      as="section"
      aria-label={`${policy.title} coverage`}
      title={policy.title}
      description={`Audience: ${formatPolicyAudience(policy.audience)}`}
      actions={
        allAccepted ? (
          <Badge tone="success" icon={<CheckCircle2 className="size-3.5" aria-hidden="true" />}>
            Complete
          </Badge>
        ) : (
          <Badge tone="warning" icon={<AlertCircle className="size-3.5" aria-hidden="true" />}>
            {policy.outstandingCount} outstanding
          </Badge>
        )
      }
    >
      <div className="flex min-w-0 flex-col gap-4">
        <KeyValueList
          columns={2}
          items={[
            {
              label: "Policy slug",
              value: <code className="font-mono text-xs break-all text-ink">{policy.slug}</code>,
            },
            {
              label: "Current version",
              value: (
                <Link
                  href={`/admin/policy-acceptances/versions/${policy.currentVersionPublicId}`}
                  aria-label={`Version ${policy.currentVersionLabel} (#${policy.currentVersionNumber}) of ${policy.title}`}
                  className="font-medium text-action underline underline-offset-2"
                >
                  Version {policy.currentVersionLabel} (#{policy.currentVersionNumber})
                </Link>
              ),
            },
            {
              label: "Published",
              value: <TimestampWithUtc value={policy.publishedAt ?? policy.effectiveAt} />,
            },
            {
              label: "Accepted current version",
              value: `${policy.acceptedCurrentCount} of ${policy.activeCustomerCount} active customers`,
            },
            {
              label: "Outstanding customers",
              value: `${policy.outstandingCount} active ${policy.outstandingCount === 1 ? "customer" : "customers"}`,
            },
          ]}
        />

        {allAccepted ? (
          <p className="text-sm text-muted">
            Every active customer has accepted Version {policy.currentVersionLabel}.
          </p>
        ) : (
          <div className="flex min-w-0 flex-col gap-3">
            <h3 className="text-sm font-semibold text-ink">
              Outstanding customers ({policy.outstandingCount})
            </h3>
            <DataTable<PolicyCoverageOutstandingCustomer>
              caption={`Outstanding customers for ${policy.title}`}
              columns={outstandingColumnsFor(policy.title)}
              rows={policy.outstandingCustomers}
              rowKey={(row) => row.customer.userPublicId}
              rowActions={(row) => <EndPolicySessionsAction userPublicId={row.customer.userPublicId}
                versionPublicId={policy.currentVersionPublicId} customerName={row.customer.name} checkOnDemand />}
            />
            {policy.outstandingTruncated ? (
              <Callout tone="info" title="Preview capped">
                <p>
                  Showing the first {policy.outstandingCustomers.length} of{" "}
                  {policy.outstandingCount} outstanding customers. Filter the Log tab or check
                  individual customer profiles for additional accounts.
                </p>
              </Callout>
            ) : null}
          </div>
        )}
      </div>
    </Card>
  );
}

export function PolicyCoverageTab() {
  const acceptanceLog = useAcceptanceLogProcedures();
  const coverageQuery = useQuery(acceptanceLog.coverage.queryOptions({}));

  if (coverageQuery.isPending) {
    return (
      <div role="status" className="flex flex-col gap-3">
        <span className="sr-only">Loading policy acceptance coverage</span>
        <Skeleton lines={6} />
      </div>
    );
  }

  if (coverageQuery.isError) {
    return <ErrorState error={coverageQuery.error} onRetry={() => void coverageQuery.refetch()} />;
  }

  const data = coverageQuery.data;
  const policies = data?.policies ?? [];
  const policiesWithGaps = policies.filter((p) => p.outstandingCount > 0).length;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <StatGrid>
        <StatCard label="Active customers" value={String(data?.activeCustomerCount ?? 0)} />
        <StatCard label="Required policies" value={String(policies.length)} />
        <StatCard label="Policies with outstanding customers" value={String(policiesWithGaps)} />
      </StatGrid>

      {policies.length === 0 ? (
        <EmptyState
          title="No published policies require acceptance"
          description="Published policies configured to require customer acceptance appear here with live coverage metrics."
        />
      ) : (
        <div className="flex min-w-0 flex-col gap-5">
          {policies.map((policy) => (
            <CoveragePolicyCard key={policy.documentPublicId} policy={policy} />
          ))}
        </div>
      )}
    </div>
  );
}
