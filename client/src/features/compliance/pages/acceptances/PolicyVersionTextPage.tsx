import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, History, Printer } from "lucide-react";
import { Link, useParams } from "wouter";
import {
  Badge,
  Breadcrumbs,
  Button,
  Card,
  CopyButton,
  ErrorState,
  KeyValueList,
  PageHeader,
  Skeleton,
} from "@/ui";
import { SafePolicyText } from "../../shared";
import { TimestampWithUtc, formatPolicyAudience } from "./shared";
import { useAcceptanceLogProcedures } from "./types";

export default function PolicyVersionTextPage() {
  const { versionId = "" } = useParams<{ versionId: string }>();
  const acceptanceLog = useAcceptanceLogProcedures();
  const versionQuery = useQuery(
    acceptanceLog.versionText.queryOptions(
      { versionPublicId: versionId },
      { enabled: Boolean(versionId) },
    ),
  );
  const data = versionQuery.data;

  const breadcrumbs = (
    <Breadcrumbs
      items={[
        { label: "Policy acceptances", href: "/admin/policy-acceptances" },
        { label: data ? `${data.policyTitle} v${data.versionLabel}` : "Policy version" },
      ]}
    />
  );

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        breadcrumbs={breadcrumbs}
        title={data ? `${data.policyTitle} — Version ${data.versionLabel}` : "Policy version"}
        meta={
          data ? (
            data.isCurrent ? (
              <Badge tone="success" icon={<CheckCircle2 className="size-3.5" aria-hidden="true" />}>
                Current
              </Badge>
            ) : (
              <Badge tone="neutral" icon={<History className="size-3.5" aria-hidden="true" />}>
                Historical
              </Badge>
            )
          ) : undefined
        }
        actions={
          <div className="rp-no-print flex flex-wrap items-center gap-2">
            <Button
              asChild
              variant="ghost"
              leadingIcon={<ArrowLeft className="size-4" aria-hidden="true" />}
            >
              <Link href="/admin/policy-acceptances">Back to acceptances</Link>
            </Button>
            <Button
              variant="secondary"
              disabled={!data}
              leadingIcon={<Printer className="size-4" aria-hidden="true" />}
              onClick={() => window.print()}
            >
              Print
            </Button>
          </div>
        }
      />

      {versionQuery.isPending ? (
        <div role="status" className="flex flex-col gap-3">
          <span className="sr-only">Loading policy version text</span>
          <Skeleton lines={6} />
        </div>
      ) : versionQuery.isError ? (
        <ErrorState error={versionQuery.error} onRetry={() => void versionQuery.refetch()} />
      ) : data ? (
        <>
          <Card as="section" aria-label="Policy version metadata" title="Version metadata">
            <KeyValueList
              columns={2}
              items={[
                {
                  label: "Policy",
                  value: (
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="font-medium break-words text-ink">{data.policyTitle}</span>
                      <code className="font-mono text-xs break-all text-muted">
                        {data.policySlug}
                      </code>
                    </span>
                  ),
                },
                {
                  label: "Version",
                  value: `Version ${data.versionLabel} (#${data.versionNumber})`,
                },
                {
                  label: "Audience",
                  value: formatPolicyAudience(data.audience),
                },
                {
                  label: "Acceptance requirement",
                  value: !data.requiresAcceptance
                    ? "Not required"
                    : data.requiresTypedSignature
                      ? "Required (typed name)"
                      : "Required (tick box)",
                },
                {
                  label: "Effective",
                  value: <TimestampWithUtc value={data.effectiveAt} />,
                },
                {
                  label: "Published",
                  value: <TimestampWithUtc value={data.publishedAt} />,
                },
                {
                  label: "Change summary",
                  value: data.changeSummary ? (
                    <span className="break-words text-ink">{data.changeSummary}</span>
                  ) : (
                    <span className="text-muted">Initial publication — no change summary recorded.</span>
                  ),
                },
                {
                  label: "SHA-256 content hash",
                  value: (
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <code className="font-mono text-xs break-all">{data.contentHash}</code>
                      <CopyButton
                        value={data.contentHash}
                        label="Copy SHA-256 content hash"
                        iconOnly
                      />
                    </span>
                  ),
                },
              ]}
            />
          </Card>

          <Card
            as="section"
            aria-label="Exact policy version text"
            title="Exact version text"
            description="Immutable text bound to the SHA-256 content hash shown above."
            className="rp-print-avoid-break"
          >
            <SafePolicyText bodyText={data.bodyText} format={data.contentFormat} />
          </Card>
        </>
      ) : null}
    </div>
  );
}
