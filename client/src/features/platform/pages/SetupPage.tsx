import { useQuery } from "@tanstack/react-query";
import { ListChecks } from "lucide-react";
import { Link } from "wouter";
import { useTRPC } from "@/lib/trpc";
import { Badge, Callout, Card, EmptyState, ErrorState, PageHeader, Skeleton, StatusBadge } from "@/ui";
import { CHECKLIST_LABELS, CHECKLIST_META, type SetupChecklistItem } from "../model";
import { PlatformNav } from "../PlatformNav";

export function SetupView({ items }: { items: SetupChecklistItem[] }) {
  if (items.length === 0) return <EmptyState icon={ListChecks} title="Checklist unavailable" description="The setup checklist could not be built. Check system health." />;
  const required = items.filter((i) => i.required);
  const blocking = required.filter((i) => i.state !== "complete").length;
  return (
    <div className="space-y-6">
      {blocking > 0 ? (
        <Callout tone="warning" title={`${blocking} required ${blocking === 1 ? "item needs" : "items need"} attention`}>
          Complete the required items before inviting customers.
        </Callout>
      ) : (
        <Callout tone="success" title="Required setup is complete" />
      )}
      <Card title="Setup checklist" description="States come from live configuration and module health, never from self-reporting.">
        <ol className="divide-y divide-line">
          {items.map((item) => (
            <li key={item.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="font-medium text-ink">
                  {CHECKLIST_LABELS[item.id]} {item.required ? <Badge tone="brand" className="ml-1">Required</Badge> : <Badge className="ml-1">Recommended</Badge>}
                </p>
                <p className="text-sm text-body break-words">{item.summary}</p>
              </div>
              <StatusBadge state={CHECKLIST_META[item.state].state} label={CHECKLIST_META[item.state].label} />
            </li>
          ))}
        </ol>
      </Card>
      <p className="text-sm text-body">
        Configure integrations under <Link href="/admin/settings" className="font-semibold text-action underline-offset-2 hover:underline">Settings</Link> and review{" "}
        <Link href="/admin/health" className="font-semibold text-action underline-offset-2 hover:underline">system health</Link>.
      </p>
    </div>
  );
}

export default function SetupPage() {
  const trpc = useTRPC();
  const list = useQuery(trpc.platform.admin.setupChecklist.queryOptions());
  return (
    <>
      <PageHeader title="Installation setup" description="What this installation still needs to run safely." />
      <PlatformNav />
      {list.isPending ? (
        <div aria-busy="true"><Skeleton lines={6} /></div>
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <SetupView items={list.data} />
      )}
    </>
  );
}
