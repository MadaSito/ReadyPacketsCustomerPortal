/** Console overview card: SIEM forwarding summary (siem.admin.health + siem.admin.destinations.list — read-only, no step-up). */
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { useTRPC } from "@/lib/trpc";
import { Badge, Button, Callout, Card, ErrorState, KeyValueList, Skeleton } from "@/ui";
import {
  BASE,
  formatAgeSeconds,
  SIEM_HEALTH_META,
  type Destination,
  type SiemHealthComponent,
  type SiemHealthState,
} from "../model";

export function SiemForwardingWidgetBody({
  destinations,
  deliveryHealth,
}: {
  destinations: readonly Destination[];
  deliveryHealth?: SiemHealthComponent;
}) {
  const metrics = deliveryHealth?.metrics;
  const configuredCount = metrics?.configuredDestinations ?? destinations.length;

  if (configuredCount === 0 && destinations.length === 0) {
    return (
      <Callout
        tone="warning"
        title="Not configured"
        actions={
          <Button asChild size="sm">
            <Link href={`${BASE}/new`}>Add destination</Link>
          </Button>
        }
      >
        No SIEM or syslog forwarding destinations are configured.
      </Callout>
    );
  }

  const enabledCount = metrics?.enabledDestinations ?? destinations.filter((d) => d.enabled).length;
  const queueDepth =
    metrics?.queueDepth ?? destinations.reduce((sum, d) => sum + d.delivery.queuedCount, 0);
  const oldestPendingAgeSeconds =
    metrics?.oldestPendingAgeSeconds ??
    destinations.reduce((max, d) => Math.max(max, d.delivery.oldestQueuedAgeSeconds ?? 0), 0);
  const deadLetters =
    metrics?.deadLetters ?? destinations.reduce((sum, d) => sum + d.delivery.deadLetterCount, 0);

  const fallbackState: SiemHealthState =
    deadLetters > 0 ? "failing" : enabledCount === 0 ? "disabled" : "ok";
  const overallState: SiemHealthState = deliveryHealth?.state ?? fallbackState;
  const meta = SIEM_HEALTH_META[overallState];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={meta.tone}>{meta.label}</Badge>
        {deadLetters > 0 ? (
          <Badge tone="danger">{`${deadLetters.toLocaleString()} dead-lettered`}</Badge>
        ) : null}
      </div>
      <KeyValueList
        columns={1}
        items={[
          {
            label: "Enabled destinations",
            value: (
              <span className="tabular-nums">
                {`${enabledCount.toLocaleString()} of ${configuredCount.toLocaleString()}`}
              </span>
            ),
          },
          {
            label: "Queue depth",
            value: <span className="tabular-nums">{queueDepth.toLocaleString()}</span>,
          },
          {
            label: "Oldest pending (age)",
            value: (
              <span className="tabular-nums">
                {queueDepth > 0 ? formatAgeSeconds(oldestPendingAgeSeconds) : "0 s"}
              </span>
            ),
          },
          {
            label: "Dead letters",
            value: <span className="tabular-nums">{deadLetters.toLocaleString()}</span>,
          },
        ]}
      />
    </div>
  );
}

export default function SiemForwardingWidget() {
  const trpc = useTRPC();
  const health = useQuery(trpc.siem.admin.health.queryOptions());
  const destinations = useQuery(trpc.siem.admin.destinations.list.queryOptions());

  const isError = health.isError || destinations.isError;
  const error = health.error ?? destinations.error;
  const ready = health.isSuccess && destinations.isSuccess;
  const deliveryHealth =
    health.data?.components.find((c) => c.component === "siem.delivery") ??
    health.data?.components[0];

  return (
    <Card
      title="SIEM forwarding"
      actions={
        <Button asChild size="sm" variant="secondary">
          <Link href={BASE}>Open SIEM</Link>
        </Button>
      }
    >
      {isError ? (
        <ErrorState
          error={error}
          onRetry={() => {
            void health.refetch();
            void destinations.refetch();
          }}
        />
      ) : !ready ? (
        <div aria-busy="true">
          <Skeleton lines={4} />
        </div>
      ) : (
        <SiemForwardingWidgetBody
          destinations={destinations.data}
          deliveryHealth={deliveryHealth}
        />
      )}
    </Card>
  );
}
