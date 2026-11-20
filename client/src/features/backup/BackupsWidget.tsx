/** Console overview card: backup posture (backup.admin.list — read-only, no step-up). Owner: audit engineer. */
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";
import { Badge, Button, Callout, Card, DateTime, ErrorState, KeyValueList, Skeleton } from "@/ui";
import { formatDuration, freshness, type BackupList } from "./model";

const WINDOW = 50;

export function BackupsWidgetBody({ list, now }: { list: BackupList; now: number }) {
  const f = freshness(list.items, now);
  return (
    <div className="flex flex-col gap-3">
      {f.kind === "none" ? (
        <Callout tone="danger" title="No successful backup">
          {list.nextCursor ? `None among the latest ${WINDOW} backups.` : "There is no completed backup on record."}
        </Callout>
      ) : f.kind === "stale" ? <Badge tone="warning">{`Out of date: ${formatDuration(f.ageMs) ?? ""} old`}</Badge> : null}
      <KeyValueList columns={1} items={[
        { label: "Last successful backup", value: f.kind === "none" ? "None" : <DateTime value={f.at} format="relative" /> },
        { label: "Encryption key", value: list.keyConfigured ? <Badge tone="success">Configured</Badge> : <Badge tone="danger">Not configured</Badge> },
        { label: "Off-host copy", value: <Badge tone="warning">Not configured</Badge> },
      ]} />
    </div>
  );
}

export default function BackupsWidget() {
  const trpc = useTRPC();
  const q = useQuery(trpc.backup.admin.list.queryOptions({ limit: WINDOW }));
  return (
    <Card title="Backups" actions={<Button asChild size="sm" variant="secondary"><Link href="/admin/backups">Open backups</Link></Button>}>
      {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data ? <Skeleton lines={3} /> : <BackupsWidgetBody list={q.data} now={q.dataUpdatedAt} />}
    </Card>
  );
}
