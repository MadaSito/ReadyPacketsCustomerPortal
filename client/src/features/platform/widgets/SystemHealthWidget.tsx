/**
 * Console overview card: overall system health and (administrators only) setup-checklist completion.
 * Reads only platform.admin.health (staff + platform.health.read) and platform.admin.setupChecklist (admin);
 * neither requires step-up. Errors render ErrorState, never zero counts.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { useSession } from "@/lib/session";
import { useTRPC } from "@/lib/trpc";
import { Badge, Button, Card, ErrorState, Skeleton } from "@/ui";
import { HEALTH_META, type HealthReport, type SetupChecklistItem } from "../model";

export function healthCounts(report: HealthReport) {
  let healthy = 0;
  let degraded = 0;
  let notConfigured = 0;
  for (const c of report.components) {
    if (c.state === "ok") healthy += 1;
    else if (c.state === "degraded" || c.state === "failing") degraded += 1;
    else if (c.state === "not_configured") notConfigured += 1;
  }
  return { healthy, degraded, notConfigured };
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-line bg-surface-soft p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold text-ink">{value}</p>
    </div>
  );
}

function SetupSummary({ items }: { items: SetupChecklistItem[] }) {
  const requiredOpen = items.filter((i) => i.required && i.state !== "complete").length;
  const recommendedOpen = items.filter((i) => !i.required && i.state !== "complete").length;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
      <p className="text-sm text-body">
        {requiredOpen === 0 ? (
          <Badge tone="success">Required setup complete</Badge>
        ) : (
          <Badge tone="warning">{`${requiredOpen} required ${requiredOpen === 1 ? "item" : "items"} open`}</Badge>
        )}{" "}
        <span className="text-muted">
          {recommendedOpen === 0 ? "No recommended items open" : `${recommendedOpen} recommended ${recommendedOpen === 1 ? "item" : "items"} open`}
        </span>
      </p>
      <Button asChild size="sm" variant="ghost">
        <Link href="/admin/setup">Setup checklist</Link>
      </Button>
    </div>
  );
}

export default function SystemHealthWidget() {
  const trpc = useTRPC();
  const { me } = useSession();
  const isAdmin = me?.user.role === "admin";
  const health = useQuery(trpc.platform.admin.health.queryOptions());
  const setup = useQuery({ ...trpc.platform.admin.setupChecklist.queryOptions(), enabled: isAdmin });

  const error = health.error ?? (isAdmin ? setup.error : null);
  const ready = health.isSuccess && (!isAdmin || setup.isSuccess);
  const report = health.data as HealthReport | undefined;

  return (
    <Card
      title="System health"
      actions={
        <Button asChild size="sm" variant="secondary">
          <Link href="/admin/health">View health</Link>
        </Button>
      }
    >
      {error ? (
        <ErrorState
          error={error}
          onRetry={() => {
            void health.refetch();
            if (isAdmin) void setup.refetch();
          }}
        />
      ) : !ready || !report ? (
        <div aria-busy="true">
          <Skeleton lines={3} />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted">Overall</span>
            <Badge tone={HEALTH_META[report.state].tone}>{HEALTH_META[report.state].label}</Badge>
          </div>
          {report.components.length === 0 ? (
            <p className="text-sm text-muted">No components have reported health yet.</p>
          ) : (
            (() => {
              const counts = healthCounts(report);
              return (
                <div className="grid grid-cols-3 gap-3">
                  <Stat label="Healthy" value={counts.healthy} />
                  <Stat label="Degraded" value={counts.degraded} />
                  <Stat label="Not configured" value={counts.notConfigured} />
                </div>
              );
            })()
          )}
          {isAdmin && setup.data ? <SetupSummary items={setup.data} /> : null}
        </div>
      )}
    </Card>
  );
}
