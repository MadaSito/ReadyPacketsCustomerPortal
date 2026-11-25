import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { useTRPC } from "@/lib/trpc";
import { Button, Card, KeyValueList, Skeleton } from "@/ui";

export default function OpsAlertsWidget() {
  const trpc = useTRPC();
  const result = useQuery(trpc.opsAlerts.summary.queryOptions());
  const data = result.data;
  return <Card className="h-full space-y-4 p-4">
    <h2 className="text-base font-semibold">Operational alerts</h2>
    <p className="text-sm text-muted">Open alerts needing staff attention.</p>
    {result.isPending ? <div role="status" aria-label="Loading alert counts"><Skeleton className="h-20 w-full" /></div>
      : result.isError || !data ? <p role="alert" className="text-sm">Alert counts are unavailable.</p>
      : <KeyValueList columns={1} items={([
        ["critical", "Critical"], ["error", "Error"], ["warning", "Warning"],
      ] as const).map(([severity, label]) => ({
        label, value: <Link className="font-medium underline underline-offset-4" href={`/admin/alerts?state=open&severity=${severity}`}
          aria-label={`${data[severity]} open ${label.toLowerCase()} alerts`}>{data[severity].toLocaleString()}</Link>,
      }))} />}
    <Button asChild variant="secondary"><Link href="/admin/alerts">View operational alerts</Link></Button>
  </Card>;
}
