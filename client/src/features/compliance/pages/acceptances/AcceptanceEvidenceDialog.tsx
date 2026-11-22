import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { Link } from "wouter";
import { Badge, Button, CopyButton, Dialog, ErrorState, KeyValueList, Skeleton } from "@/ui";
import { SafePolicyText } from "../../shared";
import {
  FreshnessBadge,
  TimestampWithUtc,
  formatAcceptanceMethod,
  formatAcceptanceSource,
} from "./shared";
import { useAcceptanceLogProcedures } from "./types";

export interface AcceptanceEvidenceDialogProps {
  publicId: string | null;
  onClose: () => void;
}

export function AcceptanceEvidenceDialog({ publicId, onClose }: AcceptanceEvidenceDialogProps) {
  const acceptanceLog = useAcceptanceLogProcedures();
  const detail = useQuery(
    acceptanceLog.detail.queryOptions(
      { publicId: publicId ?? "" },
      { enabled: Boolean(publicId) },
    ),
  );
  const data = detail.data;

  return (
    <Dialog
      open={Boolean(publicId)}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="xl"
      title="Acceptance evidence record"
      description={
        data
          ? `${data.policyTitle} · Version ${data.versionLabel}`
          : "Immutable append-only policy acceptance evidence"
      }
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      {detail.isPending ? (
        <div role="status" className="flex flex-col gap-3">
          <span className="sr-only">Loading acceptance evidence record</span>
          <Skeleton lines={6} />
        </div>
      ) : detail.isError ? (
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      ) : data ? (
        <div className="flex min-w-0 flex-col gap-5">
          <KeyValueList
            columns={2}
            items={[
              {
                label: "Evidence ID",
                value: (
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <code className="font-mono text-xs break-all">{data.publicId}</code>
                    <CopyButton value={data.publicId} label="Copy evidence ID" iconOnly />
                  </span>
                ),
              },
              {
                label: "Accepted",
                value: <TimestampWithUtc value={data.acceptedAt} />,
              },
              {
                label: "Customer",
                value: data.customer ? (
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <Link
                      href={`/admin/customers/${data.customer.userPublicId}`}
                      className="font-medium text-action underline underline-offset-2"
                    >
                      {data.customer.name}
                    </Link>
                    <span className="text-xs text-muted">
                      ID: {data.customer.customerRef ?? "No reference"} ·{" "}
                      <span className="break-all">{data.customer.email}</span>
                    </span>
                  </span>
                ) : (
                  <span className="text-muted">Historical / unlinked account</span>
                ),
              },
              {
                label: "Policy",
                value: (
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium break-words text-ink">{data.policyTitle}</span>
                    <span className="font-mono text-xs break-all text-muted">{data.policySlug}</span>
                  </span>
                ),
              },
              {
                label: "Version",
                value: (
                  <span className="flex flex-wrap items-center gap-2">
                    <span>
                      Version {data.versionLabel} (#{data.versionNumber})
                    </span>
                    <FreshnessBadge
                      freshness={data.freshness}
                      supersededByVersionLabel={data.supersededByVersionLabel}
                    />
                  </span>
                ),
              },
              {
                label: "Effective / published",
                value: (
                  <span className="flex flex-col gap-1">
                    <span>
                      <span className="text-xs text-muted">Effective: </span>
                      <TimestampWithUtc value={data.effectiveAt} inline />
                    </span>
                    {data.publishedAt ? (
                      <span>
                        <span className="text-xs text-muted">Published: </span>
                        <TimestampWithUtc value={data.publishedAt} inline />
                      </span>
                    ) : null}
                  </span>
                ),
              },
              {
                label: "Source",
                value: `${formatAcceptanceSource(data.source)} (${data.origin === "import" ? "Imported" : "Portal"})`,
              },
              {
                label: "Method",
                value: formatAcceptanceMethod(data.method),
              },
              {
                label: "Typed signer name",
                value: !data.hasTypedSignature ? (
                  <span className="text-muted">Not applicable (tick box)</span>
                ) : data.typedSignerName !== null ? (
                  <span className="font-medium break-words text-ink">{data.typedSignerName}</span>
                ) : data.signerNameRedacted ? (
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    <Badge tone="neutral">Encrypted</Badge>
                    <span className="text-xs break-words text-muted">
                      Requires policy management permission
                    </span>
                  </span>
                ) : (
                  <span className="text-muted">—</span>
                ),
              },
              {
                label: "Order",
                value:
                  data.orderPublicId && data.orderReference ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/admin/orders/${data.orderPublicId}`}
                        className="font-mono font-medium text-action underline underline-offset-2"
                      >
                        {data.orderReference}
                      </Link>
                      {data.gateKey ? (
                        <span className="inline-flex flex-wrap items-center gap-1 text-xs text-muted">
                          <Badge tone="neutral">Gate</Badge>
                          <code className="font-mono break-all text-ink">{data.gateKey}</code>
                        </span>
                      ) : null}
                      {data.evidenceKind === "order_gate" ? (
                        <Link
                          href={`/admin/acceptance-receipts/${data.publicId}`}
                          className="text-xs text-action underline underline-offset-2"
                        >
                          Printable receipt
                        </Link>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  ),
              },
              {
                label: "Address pseudonym",
                value: data.addressPseudonym ? (
                  <code className="font-mono text-xs break-all">{data.addressPseudonym}</code>
                ) : (
                  <span className="text-muted">—</span>
                ),
              },
              {
                label: "Correlation ID",
                value: data.correlationId ? (
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <code className="font-mono text-xs break-all">{data.correlationId}</code>
                    <CopyButton value={data.correlationId} label="Copy correlation ID" iconOnly />
                  </span>
                ) : (
                  <span className="text-muted">—</span>
                ),
              },
              {
                label: "SHA-256 content hash",
                value: (
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <code className="font-mono text-xs break-all">{data.contentHash}</code>
                    <CopyButton value={data.contentHash} label="Copy SHA-256 content hash" iconOnly />
                  </span>
                ),
              },
            ]}
          />

          <section aria-label="Accepted policy version text" className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-ink">
                Exact accepted text (Version {data.versionLabel})
              </h3>
              <Link
                href={`/admin/policy-acceptances/versions/${data.versionPublicId}`}
                className="inline-flex items-center gap-1 text-xs font-medium text-action underline underline-offset-2"
              >
                Open standalone version page
                <ExternalLink className="size-3.5" aria-hidden="true" />
              </Link>
            </div>
            <div
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- scrollable evidence text region must be keyboard reachable
              tabIndex={0}
              role="region"
              aria-label={`${data.policyTitle} version ${data.versionLabel}, exact text`}
              className="max-h-72 overflow-y-auto rounded-[var(--radius-control)] border border-line bg-surface-sunken p-4 outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-inset"
            >
              <SafePolicyText bodyText={data.bodyText} format={data.contentFormat} />
            </div>
          </section>
        </div>
      ) : null}
    </Dialog>
  );
}
