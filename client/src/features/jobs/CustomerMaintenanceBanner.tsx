import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";
import { Callout } from "@/ui";

export function customerMaintenanceTime(utc: string) {
  return `${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })
    .format(new Date(utc))} UTC`;
}

export function CustomerMaintenanceBanner() {
  const trpc = useTRPC();
  const status = useQuery(trpc.jobs.maintenance.customerAccess.queryOptions(undefined, { refetchInterval: 30_000 }));
  return <div role="status" aria-atomic="true" className="min-w-0">
    {status.data?.active ? <Callout tone="warning" title="Customer maintenance">
      <p className="break-words">{status.data.message}</p>
      {status.data.expectedEnd ? <p className="mt-1">Expected end: <time dateTime={status.data.expectedEnd}>
        {customerMaintenanceTime(status.data.expectedEnd)}
      </time></p> : null}
    </Callout> : null}
  </div>;
}
