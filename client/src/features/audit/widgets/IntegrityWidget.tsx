/** Console overview card: audit chain integrity summary (audit.integrity.status — read-only, no step-up). Owner: audit engineer. */
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";
import { Badge, Button, Card, DateTime, ErrorState, KeyValueList, Skeleton } from "@/ui";
import type { IntegrityStatus } from "../model";

export function ChainChip({ status }: { status: IntegrityStatus }) {
  if (status.lastVerifyOk === false) return <Badge tone="danger">Integrity check failed</Badge>;
  if (status.lastVerifyOk === true) return <Badge tone="success">Chain verified</Badge>;
  return <Badge tone="info">Not verified yet</Badge>;
}

export function IntegrityWidgetBody({ status }: { status: IntegrityStatus }) {
  const behind = status.oldestUnsealedAgeSeconds !== null && status.oldestUnsealedAgeSeconds > status.horizonSeconds;
  const failures = status.emitter?.recordFailures ?? null;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <ChainChip status={status} />
        {behind ? <Badge tone="warning">Sealing is behind</Badge> : null}
        {failures !== null && failures > 0 ? <Badge tone="danger">{`${failures.toLocaleString()} recording failures`}</Badge> : null}
      </div>
      <KeyValueList columns={1} items={[
        { label: "Sealed records", value: status.headSeq.toLocaleString() },
        { label: "Waiting to seal", value: status.unsealed.toLocaleString() },
        { label: "Last sealed", value: status.lastSealedAt ? <DateTime value={status.lastSealedAt} format="relative" /> : "Never" },
        { label: "Last verified", value: status.lastVerifiedAt ? <DateTime value={status.lastVerifiedAt} format="relative" /> : "Never" },
        { label: "Recording failures", value: failures === null ? "Not reported by this process" : failures.toLocaleString() },
      ]} />
    </div>
  );
}

export default function IntegrityWidget() {
  const trpc = useTRPC();
  const q = useQuery(trpc.audit.integrity.status.queryOptions());
  return (
    <Card title="Audit integrity" actions={<Button asChild size="sm" variant="secondary"><Link href="/admin/audit/integrity">Open integrity</Link></Button>}>
      {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data ? <Skeleton lines={4} /> : <IntegrityWidgetBody status={q.data} />}
    </Card>
  );
}
