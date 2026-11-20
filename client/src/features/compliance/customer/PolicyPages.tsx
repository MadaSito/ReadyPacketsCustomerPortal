import { useQuery } from "@tanstack/react-query";
import type { PolicyAcceptanceEvidenceView, PublishedPolicyView } from "@server/modules/compliance/policiesService";
import { useTRPC } from "@/lib/trpc";
import { Card, DateTime, EmptyState, ErrorState, KeyValueList, PageHeader, Section, Skeleton } from "@/ui";
import { SafePolicyText } from "../shared";
import { RequiredPolicyForms, usePolicyStatus } from "./PolicyAcceptance";

function PublishedDocuments({ documents }: { documents: readonly PublishedPolicyView[] }) {
  if (!documents.length) return <EmptyState title="No published policies" description="There are no current policies to display." />;
  return <div className="grid gap-4">
    {documents.map((policy) => (
      <Card key={policy.versionPublicId} as="article" title={policy.title}
        description={<>Version {policy.versionNumber} · {policy.versionLabel} · Effective <DateTime value={policy.effectiveAt} format="date" /></>}>
        {policy.changeSummary ? <p className="mb-4 break-words text-sm text-muted">{policy.changeSummary}</p> : null}
        <SafePolicyText bodyText={policy.bodyText} format={policy.contentFormat} />
      </Card>
    ))}
  </div>;
}

const methodLabels: Record<PolicyAcceptanceEvidenceView["method"], string> = {
  portal_checkbox: "Portal checkbox",
  registration: "Account registration",
  typed_signature: "Typed signature",
  imported_historical: "Imported history",
};

export function LegalPage() {
  const trpc = useTRPC();
  const documents = useQuery(trpc.compliance.policies.listPublished.queryOptions());
  return (
    <>
      <PageHeader title="Legal" description="Read ReadyPackets’ current published policies." />
      {documents.isPending ? <Skeleton lines={4} /> : documents.isError
        ? <ErrorState title="We couldn't load published policies" onRetry={() => void documents.refetch()} />
        : <PublishedDocuments documents={documents.data} />}
    </>
  );
}

export function MyPoliciesPage() {
  const status = usePolicyStatus();
  return (
    <>
      <PageHeader title="My policies" description="Review current policies and see which versions you have accepted." />
      {status.isPending ? <Skeleton lines={4} /> : status.isError
        ? <ErrorState title="We couldn't load your policy status" onRetry={() => void status.refetch()} />
        : <div className="space-y-8">
          {status.data.pendingRequired.length ? <div className="space-y-4">
            <p className="font-semibold text-ink">Accept the required versions below before starting a new order.</p>
            <RequiredPolicyForms policies={status.data.pendingRequired} />
          </div> : <p role="status" className="text-body">You’re up to date on required policies.</p>}
          <div className="space-y-3">
            <p className="font-semibold text-ink">Published policies</p>
            <PublishedDocuments documents={status.data.published} />
          </div>
          <Section title="My acceptance history" description="Your most recent acceptance records, as confirmed by the portal.">
            {status.data.acceptances.length ? <ul className="grid gap-3">
              {status.data.acceptances.map((record) => (
                <li key={record.acceptancePublicId}>
                  <Card title={record.title} headingLevel={3}>
                    <KeyValueList items={[
                      { label: "Version", value: `${record.versionNumber} · ${record.versionLabel}` },
                      { label: "Accepted on", value: <DateTime value={record.acceptedAt} /> },
                      { label: "Method", value: methodLabels[record.method] },
                      { label: "Evidence reference", value: record.acceptancePublicId },
                    ]} />
                    {record.origin === "import" ? <p className="mt-3 text-sm text-muted">Historical evidence from another installation.</p> : null}
                  </Card>
                </li>
              ))}
            </ul> : <p className="text-body">No acceptances have been recorded for your account.</p>}
          </Section>
        </div>}
    </>
  );
}
