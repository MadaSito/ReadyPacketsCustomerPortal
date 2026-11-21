/** Security page card (order 40): recent sign-in activity on your account (last 20 events). */
import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import { useTRPC } from "@/lib/trpc";
import { Badge, Card, DateTime, EmptyState, ErrorState, Skeleton } from "@/ui";
import { authMethodLabel, placeLabel, signInKindMeta } from "./labels";

export default function SignInActivityCard() {
  const trpc = useTRPC();
  const overview = useQuery(trpc.identity.security.overview.queryOptions());
  const rows = overview.data?.activity;
  return (
    <Card
      as="section"
      aria-label="Recent sign-in activity"
      title="Recent sign-in activity"
      description="Sign-ins, failed attempts and sign-outs on your account. If something looks unfamiliar, change your password and sign out other sessions."
    >
      {overview.isPending ? (
        <div role="status"><span className="sr-only">Loading sign-in activity</span><Skeleton lines={3} /></div>
      ) : overview.isError ? (
        <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
      ) : !rows || rows.length === 0 ? (
        <EmptyState icon={History} title="No activity yet" description="Your sign-ins will be listed here." />
      ) : (
        <ol className="flex flex-col divide-y divide-line" aria-label="Sign-in events, newest first">
          {rows.map((row) => {
            const meta = signInKindMeta(row.kind);
            return (
              <li key={row.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                <p className="flex flex-wrap items-center gap-2">
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                  <DateTime value={row.occurredAt} format="datetime" className="text-sm text-ink" />
                  {row.current ? <Badge tone="brand">This session</Badge> : null}
                </p>
                <p className="text-sm break-words text-muted">
                  {[row.deviceSummary ?? "Unknown device", row.authMethod ? authMethodLabel(row.authMethod) : null, placeLabel(row.country, row.ipAddress)].filter(Boolean).join(" · ")}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
